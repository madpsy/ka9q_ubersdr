'use strict';

// UberSDR desktop client.
//
// One chooser window (a local page: saved receivers, LAN discovery, the
// public directory, manual addresses) and one receiver window per connected
// instance. Each receiver window loads http://127.0.0.1:<port>/v2/ from that
// instance's own reverse proxy (proxy.js), so the stock v2 bundle — built by
// static/v2/build.sh, staged untouched into ui/ — runs against any instance
// while believing it is same-origin with it.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { InstanceProxy } = require('./proxy');
const { InstanceStore } = require('./store');
const discovery = require('./discovery');

// The v2 start overlay already gates audio behind a click; this just keeps
// Chromium's autoplay heuristics from ever muting a reconnect.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const UI_DIR = path.join(__dirname, 'ui', 'v2');
const builtinAvailable = fs.existsSync(path.join(UI_DIR, 'dist', 'v2.js'));
let buildInfo = '';
try { buildInfo = fs.readFileSync(path.join(__dirname, 'ui', 'BUILD_INFO'), 'utf8').trim(); } catch { /* unstaged */ }

/** @type {InstanceStore} */
let store;
let chooserWin = null;
const running = new Map();      // instance id -> { proxy, win }
const localOrigins = new Set(); // origins our proxies currently serve

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showChooser());
}

function showChooser() {
    if (chooserWin && !chooserWin.isDestroyed()) {
        chooserWin.show();
        chooserWin.focus();
        return;
    }
    chooserWin = new BrowserWindow({
        width: 980,
        height: 780,
        backgroundColor: '#0b0e14',
        title: 'UberSDR — receivers',
        webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    chooserWin.loadFile(path.join(__dirname, 'chooser', 'index.html'));
    chooserWin.on('closed', () => { chooserWin = null; });
}

function notifyChooser() {
    if (chooserWin && !chooserWin.isDestroyed()) {
        chooserWin.webContents.send('instances:changed');
    }
}

async function connectInstance(desc) {
    const entry = desc.id ? store.get(desc.id) : store.ensure(desc);
    if (!entry) throw new Error('unknown instance');

    const existing = running.get(entry.id);
    if (existing) {
        existing.win.focus();
        return entry.id;
    }

    // Fail here, with a message the chooser can show, rather than opening a
    // window onto a 502.
    await discovery.probe(entry);

    const proxy = new InstanceProxy({
        host: entry.host,
        port: entry.port,
        tls: entry.tls,
        insecureTLS: entry.insecureTLS,
        uiDir: builtinAvailable ? UI_DIR : null,
        builtin: entry.ui !== 'remote' && builtinAvailable,
        localPort: entry.localPort,
    });
    try {
        await proxy.start();
    } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        // The stored port is the instance's origin (and so its localStorage);
        // losing it is better than not connecting. Take any free port and
        // remember it.
        proxy.localPort = 0;
        await proxy.start();
        entry.localPort = proxy.localPort;
        store.persist();
    }
    localOrigins.add(proxy.localOrigin);

    const win = new BrowserWindow({
        width: 1500,
        height: 950,
        backgroundColor: '#0b0e14',
        title: entry.label,
    });
    win.loadURL(proxy.localOrigin + '/v2/');
    win.on('closed', () => {
        localOrigins.delete(proxy.localOrigin);
        proxy.stop();
        running.delete(entry.id);
        notifyChooser();
    });

    running.set(entry.id, { proxy, win });
    entry.lastUsed = new Date().toISOString();
    store.persist();
    notifyChooser();
    return entry.id;
}

function isLocalUrl(url) {
    for (const origin of localOrigins) {
        if (url === origin || url.startsWith(origin + '/')) return true;
    }
    return false;
}

// Popups from the v2 UI (legacy callsign lookup, map, CW graph) are
// same-origin pages and become child windows; anything external goes to the
// system browser. Applies to every webContents, children included.
app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        if (isLocalUrl(url)) return { action: 'allow' };
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (isLocalUrl(url) || url.startsWith('file:')) return;
        event.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
    });
});

function setupSession() {
    const ses = session.defaultSession;

    // Web Serial (the FlexControl knob): Electron ships no picker UI, so
    // requestPort() would hang without these.
    ses.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        if (portList.length === 0) return callback('');
        if (portList.length === 1) return callback(portList[0].portId);
        const win = BrowserWindow.fromWebContents(webContents);
        const names = portList.map((p) => p.displayName || p.portName || p.portId);
        dialog.showMessageBox(win, {
            type: 'question',
            title: 'Select serial port',
            message: 'Which serial port should the page use?',
            buttons: [...names, 'Cancel'],
            cancelId: names.length,
        }).then(({ response }) => {
            callback(response < portList.length ? portList[response].portId : '');
        });
    });
    ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');

    const allowed = new Set([
        'serial', 'notifications', 'fullscreen', 'media',
        'clipboard-sanitized-write', 'pointerLock',
    ]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(allowed.has(permission));
    });
}

function setupMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        {
            label: 'Receivers',
            submenu: [
                { label: 'Show Chooser', accelerator: 'CmdOrCtrl+I', click: () => showChooser() },
                { type: 'separator' },
                process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupIpc() {
    ipcMain.handle('app:info', () => ({
        builtinAvailable,
        buildInfo,
        version: app.getVersion(),
        electron: process.versions.electron,
    }));

    ipcMain.handle('instances:saved', () => store.list().map((entry) => ({
        ...entry,
        running: running.has(entry.id),
    })));

    ipcMain.handle('instances:directory', () => discovery.fetchDirectory());
    ipcMain.handle('instances:lan', () => discovery.discoverLan());
    ipcMain.handle('instances:resolve', async (_e, input, opts) => {
        try {
            return { ok: true, row: await discovery.resolveTarget(input, opts) };
        } catch (err) {
            return { ok: false, error: err.message, certError: err.certError || null };
        }
    });

    ipcMain.handle('instances:connect', async (_e, desc) => {
        try {
            return { ok: true, id: await connectInstance(desc) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('instances:update', (_e, id, patch) => {
        const entry = store.update(id, patch);
        // A UI-mode change applies live: flip the proxy and reload the window.
        if (entry && patch && 'ui' in patch) {
            const active = running.get(id);
            if (active) {
                active.proxy.setBuiltin(entry.ui !== 'remote');
                active.win.webContents.reload();
            }
        }
        return entry;
    });

    ipcMain.handle('instances:disconnect', (_e, id) => {
        const active = running.get(id);
        if (active) active.win.close();
    });

    ipcMain.handle('instances:remove', (_e, id) => {
        const active = running.get(id);
        if (active) active.win.close();
        store.remove(id);
    });
}

app.whenReady().then(() => {
    store = new InstanceStore(app.getPath('userData'));
    setupSession();
    setupMenu();
    setupIpc();
    showChooser();
});

app.on('activate', () => showChooser());
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
