'use strict';

// UberSDR desktop client.
//
// One chooser window (a local page: saved receivers, LAN discovery, the
// public directory, manual addresses) and one receiver window per connected
// instance. Each receiver window loads http://127.0.0.1:<port>/v2/ from that
// instance's own reverse proxy (proxy.js), so the stock v2 bundle — built by
// static/v2/build.sh, staged untouched into ui/ — runs against any instance
// while believing it is same-origin with it.

const {
    app, BrowserWindow, Menu, ipcMain, nativeImage, safeStorage, shell, session,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { InstanceProxy } = require('./proxy');
const { InstanceStore } = require('./store');
const { SharedPrefs } = require('./prefs');
const { FlrigLink } = require('./flrig');
const { RigctlLink } = require('./rigctl');
const { TciServer } = require('./tciserver');
const discovery = require('./discovery');
const { browserUserAgent } = require('./useragent');

// The v2 start overlay already gates audio behind a click; this just keeps
// Chromium's autoplay heuristics from ever muting a reconnect.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Speech, for the announcements and the callsign readout.
//
// On Linux, Chromium reaches text-to-speech through speech-dispatcher, and it
// only opens that connection when asked: without this switch `speechSynthesis`
// is present but enumerates no voices at all and every `speak()` fails with
// `synthesis-failed`, which the UI can only report as "no voices". Chrome
// carries its own bundled Google voices and so does not need it; Electron
// ships none, making the system's the only ones there are.
//
// Nothing to install here, but the host must have speech-dispatcher and a
// module for it (`speech-dispatcher`, `speech-dispatcher-espeak-ng` on Debian
// and Ubuntu). Where it is missing this changes nothing rather than failing.
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-speech-dispatcher');
}

// The window icon.
//
// Only Linux needs this: Windows takes the icon from the resource compiled into
// the exe and macOS from the bundle, but an X11/Wayland window carries its own
// (_NET_WM_ICON), and without one every window and taskbar entry falls back to
// Chromium's default. The .desktop entry alone is not enough — it only applies
// once the app has been installed *and* the window's app_id matches its
// StartupWMClass, which leaves an AppImage run straight from the download
// folder with no icon at all. Passing it here covers both cases and is ignored
// where it is not needed.
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

// The receiver preload, bundled by build.sh so that the page API's client
// library travels with it — a sandboxed preload cannot require a file at run
// time. The unbundled source is the fallback for a working tree whose UI has
// never been built: shared settings still work there, the Layout menu does not.
const RECEIVER_PRELOAD = ['ui/receiver-preload.js', 'receiver-preload.js']
    .map((rel) => path.join(__dirname, rel))
    .find((file) => fs.existsSync(file));

const UI_DIR = path.join(__dirname, 'ui', 'v2');
const builtinAvailable = fs.existsSync(path.join(UI_DIR, 'dist', 'v2.js'));
let buildInfo = '';
try { buildInfo = fs.readFileSync(path.join(__dirname, 'ui', 'BUILD_INFO'), 'utf8').trim(); } catch { /* unstaged */ }

/** @type {InstanceStore} */
let store;
/** @type {SharedPrefs} */
let prefs;
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
        icon: APP_ICON,
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
        icon: APP_ICON,
        // Shared settings and the Layout menu's end of the page API. All it
        // exposes to the page is the receiver's own address, for the share
        // button — one read-only string, and no way to call back in.
        webPreferences: { preload: RECEIVER_PRELOAD },
    });
    win.on('closed', () => {
        localOrigins.delete(proxy.localOrigin);
        proxy.stop();
        const gone = running.get(entry.id);
        if (gone && gone.radio) gone.radio.stop();
        // A listening socket outlives the window that asked for it unless it is
        // closed here, and the next window on the same port then cannot start.
        if (gone && gone.surface) gone.surface.stop();
        running.delete(entry.id);
        notifyChooser();
    });

    const rec = {
        id: entry.id, proxy, win, links: null, layout: null, menu: null, radio: null,
        surface: null, audioPort: null,
    };
    running.set(entry.id, rec);
    // Loaded only once the record is in place: the preload asks the main process
    // which receiver this window is on (window:context), and it asks before the
    // page's first script runs.
    win.loadURL(proxy.localOrigin + '/v2/');
    watchMenuFocus(rec);
    store.recordUse(entry.id);
    notifyChooser();
    // Not awaited: the receiver is usable the moment its window is up, and the
    // menu is two HTTP round trips behind it.
    attachLinksMenu(running.get(entry.id), entry);
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

// ---- the serial port picker ------------------------------------------------
//
// Electron has no port chooser of its own and no list-selection dialog, so this
// was a message box with one button per port. A message box puts its buttons in
// the dialog's action area, which is a single horizontal row: every port made
// the dialog wider, nothing could scroll, and Linux port names are long enough
// that three of them ran off the screen. An action area is for "Save / Don't
// Save / Cancel", not for a list of unknown length.
//
// So the list gets a window, built from the same plain HTML/CSS as the chooser.
// It also shows what a button label could not — the device path and the
// vendor/product IDs beneath each name — and stays live while it is open.

/** The open picker, or null. @type {{win: BrowserWindow, ports: object[], finish: (id: string) => void} | null} */
let serialPicker = null;

// Only the fields the page needs, and only strings: the port objects come from
// Chromium's device layer, and nothing but this is worth handing to a renderer.
function describePort(port) {
    return {
        portId: String(port.portId || ''),
        portName: String(port.portName || ''),
        displayName: String(port.displayName || ''),
        vendorId: String(port.vendorId || ''),
        productId: String(port.productId || ''),
        serialNumber: String(port.serialNumber || ''),
    };
}

function serialPortsChanged(kind, port) {
    if (!serialPicker) return;
    const row = describePort(port);
    const rest = serialPicker.ports.filter((p) => p.portId !== row.portId);
    serialPicker.ports = kind === 'add' ? [...rest, row] : rest;
    if (!serialPicker.win.isDestroyed()) {
        serialPicker.win.webContents.send('serial:ports', serialPicker.ports);
    }
}

/**
 * Asks which port, and resolves with its id — or with '' for "none of them",
 * which is what `select-serial-port`'s callback wants for a refusal.
 *
 * Every port is offered, including when there is only one. Picking the single
 * attached device automatically saved a click at the cost of the page being
 * handed a serial device without anybody naming it, and the page is content
 * served by whichever instance was connected to.
 */
function chooseSerialPort(parent, portList) {
    // One at a time: a second request while a picker is open is refused rather
    // than stacking modal windows on top of each other.
    if (serialPicker) return Promise.resolve('');

    return new Promise((resolve) => {
        const win = new BrowserWindow({
            width: 460,
            height: 440,
            parent: parent || undefined,
            modal: !!parent,
            resizable: false,
            minimizable: false,
            maximizable: false,
            backgroundColor: '#0b0e14',
            title: 'Select serial port',
            icon: APP_ICON,
            webPreferences: { preload: path.join(__dirname, 'serial-preload.js') },
        });
        win.setMenuBarVisibility(false);

        let settled = false;
        const finish = (portId) => {
            if (settled) return;
            settled = true;
            serialPicker = null;
            // Answer first, close second: the callback is what releases the
            // page's pending requestPort(), and it must run even if closing
            // the window throws.
            resolve(typeof portId === 'string' ? portId : '');
            if (!win.isDestroyed()) win.close();
        };

        serialPicker = { win, ports: portList.map(describePort), finish };
        // Closed by the window controls, or by the parent going away: either
        // way the page is told nothing was chosen rather than left hanging.
        win.on('closed', () => finish(''));
        win.loadFile(path.join(__dirname, 'serial', 'index.html'));
    });
}

function setupSession() {
    const ses = session.defaultSession;

    // How receiver operators see this client in their listener lists. Set on
    // the fallback rather than per window so every page carries it — the
    // chooser, the receiver windows and the instance's own v1 popups — and set
    // before the first window is created, which app.whenReady's ordering below
    // is what guarantees.
    //
    // Set here rather than anywhere later because the server records the User-
    // Agent against the session UUID at POST /connection, and every socket
    // endpoint refuses a UUID with no recorded one (websocket.go:562,
    // user_spectrum_websocket.go:197). They test that it exists rather than
    // that it matches — the stored value is never compared — so a late change
    // would not lock anyone out. It is set before the first window anyway, so
    // that the logs a receiver operator reads carry one string throughout
    // rather than Chromium's default for the first request and ours after.
    app.userAgentFallback = browserUserAgent(app.userAgentFallback);

    // Web Serial (the FlexControl knob): Electron ships no picker UI, so
    // requestPort() would hang without these.
    ses.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        chooseSerialPort(BrowserWindow.fromWebContents(webContents), portList)
            .then(callback);
    });
    // The list can change while the picker is open — this is a knob somebody
    // plugs in, and often the reason it was not in the list is that they had
    // not plugged it in yet. Both events carry the port that changed; the
    // authoritative list is the one we keep, so it is patched rather than
    // re-enumerated.
    ses.on('serial-port-added', (_event, port) => serialPortsChanged('add', port));
    ses.on('serial-port-removed', (_event, port) => serialPortsChanged('remove', port));
    ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');

    // Anything not listed is refused. A browser prompts; there is nobody to
    // prompt here, so the list is the answer.
    //
    // `midiSysex` is what Web MIDI asks for — including from
    // requestMIDIAccess({ sysex: false }), which is how controls/webmidi.js
    // calls it. Chromium requests the sysex permission either way, so listing
    // only `midi` leaves MIDI control quietly broken: the promise rejects with
    // NotAllowedError and a MIDI controller simply never appears. Both are
    // here because the pair is one feature, and which one is consulted is
    // Chromium's business rather than ours.
    const allowed = new Set([
        'serial', 'midi', 'midiSysex', 'notifications', 'fullscreen', 'media',
        'clipboard-sanitized-write', 'pointerLock',
    ]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(allowed.has(permission));
    });
}

// The pages menu, pruned by the same code the UI's logo menu uses. Staged by
// build.sh; absent when the UI has never been built, in which case receivers
// simply get no Links menu rather than the app failing to start.
let pagesMenu = null;
try {
    // eslint-disable-next-line global-require
    pagesMenu = require('./ui/pagesMenu.cjs');
} catch { /* no staged UI */ }

/**
 * The receiver's published pages as a native submenu, or null where it has
 * none — an empty "Links" menu says less than no menu at all.
 *
 * The groups nest arbitrarily deep, exactly as they do in the logo menu, and
 * a native submenu nests as readily.
 */
function linksSubmenu(groups, win) {
    const items = (node) => [
        ...node.links.map((item) => ({
            label: item.label,
            toolTip: item.tooltip || undefined,
            click: () => openReceiverLink(win, item),
        })),
        ...node.subgroups.map((sg) => ({ label: sg.name, submenu: items(sg) })),
    ];
    const menu = groups.map((g) => ({ label: g.name, submenu: items(g) }));
    return menu.length ? menu : null;
}

/**
 * Opens one of those links the way clicking it in the UI would.
 *
 * Through the receiver's own window rather than straight from here, because
 * these are v1 pages and several of them talk to whoever opened them — the
 * callsign lookup exchanges postMessages with its opener, the map reads the
 * channel list off it (see the v2 compat bridge). A window opened from the
 * main process would have no opener and those pages would load and then
 * quietly do nothing. Handing the same `window.open` call to the page gives
 * them one, and routes the result through the window-open handler that
 * already decides local-popup versus system browser.
 */
function openReceiverLink(win, item) {
    if (win.isDestroyed()) return;
    const url = JSON.stringify(item.url);
    const js = item.external
        ? `window.open(${url}, '_blank', 'noopener,noreferrer')`
        // v1's geometry, centred on the display the page is on.
        : `(() => {
               const w = 1200, h = 800;
               const left = Math.round((screen.width - w) / 2);
               const top = Math.round((screen.height - h) / 2);
               window.open(${url}, '_blank',
                   'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top
                   + ',resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no');
           })()`;
    win.webContents.executeJavaScript(js).catch(() => { /* window went away */ });
}

// --- the Layout menu --------------------------------------------------------
//
// The panels a receiver window is showing, and where. The state belongs to the
// page, which publishes it over the v2 page API (`layout` topic) and takes
// `panel` commands back — see receiver-preload.js. Nothing is mirrored here:
// every tick is drawn from the last snapshot the page sent, so a panel dragged
// about in the UI moves the menu with it rather than the two disagreeing.

const PLACEMENT_LABELS = { left: 'Left', right: 'Right', bottom: 'Bottom', float: 'Floating' };

// The icon a menu row is given, at the size a menu row should be.
//
// The bitmap is 32 px, and handing that over directly makes every row 32 px
// tall — the menu sizes itself to its images, so fifty panels became a very
// long list of very deep rows. Adding it as a 2× representation instead says
// the same picture is a 16 px icon drawn at twice the detail: the rows come out
// half the height, and stay sharp on a HiDPI screen rather than being a 16 px
// bitmap stretched.
function menuIcon(dataUrl) {
    const image = nativeImage.createEmpty();
    image.addRepresentation({ scaleFactor: 2, dataURL: dataUrl });
    // A representation that was refused leaves an empty image, which draws as a
    // gap where the icon should be — worse than no icon at all.
    return image.isEmpty() ? nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 }) : image;
}

/**
 * One submenu per panel: shown or not, and where.
 *
 * Flat, alphabetical, and every registered panel — including the hidden ones,
 * which is the point. A menu that listed only what was on screen could not
 * bring anything back, and that is what somebody opens it for.
 */
function layoutSubmenu(snapshot, win) {
    const panels = snapshot.panels || [];
    if (!panels.length) return null;
    const byId = new Map(panels.map((p) => [p.id, p]));

    // Grouped the way the app groups them on a phone — by the question being
    // asked — rather than as one list of fifty. The page sends the grouping and
    // its order (see panels/groups.jsx); alphabetical within a group, because
    // the registry's order means something on screen and nothing in a menu.
    //
    // A page too old to send groups, or one whose groups somehow name nothing,
    // still gets a flat list: this is a menu, and it working is worth more than
    // it being tidy.
    const groups = (snapshot.groups || [])
        .map((g) => ({
            title: g.title,
            iconPng: g.iconPng,
            items: (g.panels || []).map((id) => byId.get(id)).filter(Boolean),
        }))
        .filter((g) => g.items.length);

    const entry = (p) => ({
        label: p.title,
        // Drawn by the page and rasterised in its preload — nativeImage cannot
        // read SVG, and this side has no renderer to do it in. Absent where
        // that failed, which costs a picture and nothing else.
        ...(p.iconPng ? { icon: menuIcon(p.iconPng) } : {}),
        submenu: [
            {
                label: 'Shown',
                type: 'checkbox',
                checked: !p.hidden,
                // The Layout panel is what brings the others back, so the page
                // refuses to hide it. Greyed rather than absent: a missing
                // entry on one row of an otherwise uniform menu reads as a bug.
                enabled: !p.unhideable,
                click: () => sendPanelCommand(win, { id: p.id, hidden: !p.hidden }),
            },
            { type: 'separator' },
            ...Object.entries(PLACEMENT_LABELS).map(([placement, label]) => ({
                label,
                type: 'radio',
                checked: p.placement === placement,
                click: () => {
                    // Radio items fire on the way in as well as on a real
                    // choice, so re-selecting where it already is would send a
                    // command per rebuild.
                    if (p.placement === placement) return;
                    sendPanelCommand(win, { id: p.id, placement });
                },
            })),
        ],
    });

    const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
    if (!groups.length) return [...panels].sort(byTitle).map(entry);

    // A group of one is its panel, without a submenu to open first: the
    // Multipad is its own group precisely because it is the one nothing should
    // be put in front of.
    return groups.map((g) => (g.items.length === 1
        ? entry(g.items[0])
        : {
            label: g.title,
            // The group's own icon, the one a phone shows on its tab bar.
            ...(g.iconPng ? { icon: menuIcon(g.iconPng) } : {}),
            submenu: [...g.items].sort(byTitle).map(entry),
        }));
}

let panelSeq = 0;
function sendPanelCommand(win, args) {
    if (win.isDestroyed()) return;
    win.webContents.send('layout:panel', { id: ++panelSeq, args });
}

function menuTemplate({ links = null, layout = null } = {}) {
    return [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        {
            label: 'Receivers',
            submenu: [
                { label: 'Show Chooser', accelerator: 'CmdOrCtrl+I', click: () => showChooser() },
                { type: 'separator' },
                process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
            ],
        },
        ...(layout ? [{ label: 'Layout', submenu: layout }] : []),
        ...(links ? [{ label: 'Links', submenu: links }] : []),
        // Edit, on macOS only.
        //
        // Nothing in this app is a document, so the menu is Cut/Copy/Paste over
        // whatever text field happens to be focused — a frequency box, a
        // callsign, an address in the chooser. Windows and Linux hand those
        // keystrokes to the focused field themselves, so the menu is three
        // items nobody opens.
        //
        // macOS does not: the standard editing shortcuts are dispatched through
        // the menu bar, and an app without an Edit menu is an app where Cmd+C
        // and Cmd+V quietly do nothing. So it stays there, where it is also the
        // convention.
        ...(process.platform === 'darwin' ? [{ role: 'editMenu' }] : []),
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ];
}

function setupMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

/**
 * Rebuilds a receiver window's menu bar from whatever it currently has.
 *
 * Both menus are rebuilt together because a menu bar is replaced whole: Links
 * arrives once, the layout arrives again every time somebody moves a panel, and
 * keeping the two on one record means the later one cannot drop the earlier.
 *
 * Windows and Linux hang a menu bar off each window, which is what per-receiver
 * menus want — two connected instances have different panels open and publish
 * different pages. macOS has one bar for the application, so there it follows
 * the focused window instead.
 */
function refreshWindowMenu(rec) {
    const { win } = rec;
    if (win.isDestroyed()) return;
    if (!rec.links && !rec.layout) return;

    const menu = Menu.buildFromTemplate(menuTemplate({
        links: rec.links,
        layout: rec.layout ? layoutSubmenu(rec.layout, win) : null,
    }));
    if (process.platform !== 'darwin') {
        win.setMenu(menu);
        return;
    }
    rec.menu = menu;
    if (win.isFocused()) Menu.setApplicationMenu(menu);
}

/**
 * Gives a receiver window its own menu bar, with that receiver's pages in it.
 *
 * Per window because the pages are per receiver: two instances connected at
 * once publish different ones, and a single global Links menu would be
 * whichever happened to load last. Windows and Linux hang a menu bar off each
 * window, which is exactly that. macOS has one menu bar for the application,
 * so there the menu follows the focused window instead.
 */
async function attachLinksMenu(rec, entry) {
    if (!pagesMenu) return;
    let links = null;
    try {
        const [data, info] = await Promise.all([
            discovery.getJson(entry, '/api/pages-menu'),
            discovery.getJson(entry, '/api/description'),
        ]);
        links = linksSubmenu(pagesMenu.buildGroups(data, info), rec.win);
    } catch {
        // A receiver that publishes no menu, or is too old to have the
        // endpoint. Not worth a dialog: the pages are ordinary URLs and the
        // UI's own logo menu reports it in place.
        return;
    }
    if (!links || rec.win.isDestroyed()) return;
    rec.links = links;
    refreshWindowMenu(rec);
}

// macOS shares one menu bar between every window, so it has to follow the
// focus. Registered once per window rather than per menu rebuild, or the
// listeners would pile up every time a panel moved.
function watchMenuFocus(rec) {
    if (process.platform !== 'darwin') return;
    rec.win.on('focus', () => {
        if (rec.menu) Menu.setApplicationMenu(rec.menu);
    });
    // Back to the plain menu when this window is not the one being looked at,
    // or a closed receiver would leave its panels on the bar.
    rec.win.on('blur', () => Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate())));
}

/** The record for a window, by its webContents — how an IPC message finds it. */
function recordFor(contents) {
    for (const rec of running.values()) {
        if (!rec.win.isDestroyed() && rec.win.webContents.id === contents.id) return rec;
    }
    return null;
}

function setupIpc() {
    ipcMain.handle('app:info', () => ({
        builtinAvailable,
        buildInfo,
        version: app.getVersion(),
        electron: process.versions.electron,
    }));

    ipcMain.handle('instances:saved', () => store.listForUI().map((entry) => ({
        ...entry,
        running: running.has(entry.id),
    })));

    // The picker page. Both are no-ops once the picker has closed, so a late
    // message from a window on its way out cannot answer a request that has
    // already been answered.
    // --- the radio link ------------------------------------------------------
    //
    // One link per receiver window, driven entirely by that window's preload:
    // the panel's settings arrive there over the page API, and the preload says
    // start, stop, or set this. Which protocol is a matter of which transport
    // was chosen, and both have to be here rather than in the page — flrig
    // sends no CORS headers, and rigctld is a raw socket. See flrig.js and
    // rigctl.js.
    //
    // One at a time: the panel offers a single connection, so a second would be
    // a link nothing is reading.
    const LINKS = { flrig: FlrigLink, rigctld: RigctlLink };

    ipcMain.on('radio:start', (event, { kind, host, port }) => {
        const rec = recordFor(event.sender);
        const Link = LINKS[kind];
        if (!rec || !Link) return;
        if (rec.radio) rec.radio.stop();
        rec.radio = new Link({
            host: String(host || '127.0.0.1'),
            port,
            onState: (state) => {
                if (!rec.win.isDestroyed()) rec.win.webContents.send('radio:state', state);
            },
        });
        rec.radio.start();
    });

    ipcMain.on('radio:stop', (event) => {
        const rec = recordFor(event.sender);
        if (rec && rec.radio) {
            rec.radio.stop();
            rec.radio = null;
        }
    });

    // Pushing the receiver's dial onto the rig. Failures are swallowed: the
    // poll is what reports the link's health, and a rig that refused one write
    // says so on the next read rather than through two channels at once.
    ipcMain.on('radio:set', (event, { frequency, mode }) => {
        const rec = recordFor(event.sender);
        if (!rec || !rec.radio) return;
        if (frequency != null) rec.radio.setFrequency(frequency).catch(() => {});
        if (mode) rec.radio.setMode(mode).catch(() => {});
    });

    // --- the control surface -------------------------------------------------
    //
    // The other direction from the radio link above: there, this client drives
    // somebody's rig; here it *is* the rig, and JTDX or a logger connects to it.
    // The page's SDR Control panel chooses it and supplies the settings, which
    // arrive through the same preload — see receiver-preload.js and
    // static/v2/src/controls/surfaces.js.
    //
    // Only TCI so far, and it has to be here rather than in the page for the
    // same reason as rigctld: a page cannot listen on a socket.
    const SURFACES = { tci: TciServer };

    function surfaceStatus(rec, status) {
        if (!rec.win.isDestroyed()) rec.win.webContents.send('surface:status', status);
    }

    ipcMain.on('surface:start', (event, { id, config, name }) => {
        const rec = recordFor(event.sender);
        const Surface = SURFACES[id];
        if (!rec || !Surface) return;
        if (rec.surface) rec.surface.stop();
        rec.surface = new Surface({
            host: String((config && config.host) || '127.0.0.1'),
            port: config && config.port,
            // The receiver's own name, so a client's device list says which
            // one it is talking to rather than which program.
            deviceName: name || 'UberSDR',
            onControl: (patch) => {
                if (!rec.win.isDestroyed()) rec.win.webContents.send('surface:control', patch);
            },
            onStatus: (status) => surfaceStatus(rec, status),
        });
        rec.surface.start();
    });

    ipcMain.on('surface:stop', (event) => {
        const rec = recordFor(event.sender);
        if (!rec || !rec.surface) return;
        rec.surface.stop();
        rec.surface = null;
        if (rec.audioPort) { rec.audioPort.close(); rec.audioPort = null; }
    });

    // The page has re-announced, so its registry of surfaces is a new one and
    // whatever this told the old one is gone. Said again rather than assumed.
    ipcMain.on('surface:report', (event) => {
        const rec = recordFor(event.sender);
        if (rec && rec.surface) surfaceStatus(rec, rec.surface.status());
    });

    // The receiver moved. Forwarded rather than filtered: the server itself
    // decides what is a change worth telling clients about.
    ipcMain.on('surface:update', (event, patch) => {
        const rec = recordFor(event.sender);
        if (rec && rec.surface) rec.surface.update(patch || {});
    });

    // Audio, as a port rather than as messages.
    //
    // The page opens a MessageChannel and hands one end to its preload (see the
    // `audio` command in the page API); the preload passes that same port
    // straight here. So the samples travel page → main with nothing in between
    // copying them, and the preload is not woken 25 times a second to relay
    // buffers it has no interest in.
    ipcMain.on('surface:audio-port', (event) => {
        const rec = recordFor(event.sender);
        const port = event.ports[0];
        if (!port) return;
        if (!rec) { port.close(); return; }
        if (rec.audioPort) rec.audioPort.close();
        rec.audioPort = port;
        port.on('message', (msg) => {
            const data = msg.data || {};
            if (!rec.surface || !data.pcm) return;
            rec.surface.pushAudio(new Float32Array(data.pcm), data.frames, data.sampleRate);
        });
        port.start();
    });

    // The page telling us where its panels are, on connect and on every change.
    // Rebuilding the whole bar per message is fine: arranging panels is a
    // deliberate act, not a stream.
    ipcMain.on('layout:changed', (event, layout) => {
        const rec = recordFor(event.sender);
        if (!rec || !layout || !Array.isArray(layout.panels)) return;
        rec.layout = layout;
        refreshWindowMenu(rec);
    });
    // A refused command — hiding the Layout panel, say. The page publishes the
    // unchanged layout anyway, so the menu corrects itself; this is only worth
    // a line in the log for anyone wondering why a click did nothing.
    ipcMain.on('layout:done', (_e, res) => {
        if (res && !res.ok) console.warn('[ubersdr] layout command refused:', res.error);
    });

    ipcMain.handle('serial:ports', () => (serialPicker ? serialPicker.ports : []));
    ipcMain.on('serial:choose', (_e, portId) => {
        if (serialPicker) serialPicker.finish(portId);
    });

    ipcMain.handle('instances:sort', () => store.sort);
    ipcMain.handle('instances:set-sort', (_e, value) => store.setSort(value));

    // A receiver found on the LAN or in the directory may already be saved, in
    // which case its key icon should show what is set rather than an empty lock
    // on a receiver that has a password.
    const withSaved = (rows) => rows.map((row) => {
        const saved = store.find(row.host, row.port, row.tls);
        return saved ? { ...row, hasPassword: !!saved.password } : row;
    });

    ipcMain.handle('instances:directory', async () => withSaved(await discovery.fetchDirectory()));
    ipcMain.handle('instances:lan', async () => withSaved(await discovery.discoverLan()));
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

    // What a receiver window needs to know about being one.
    //
    // `upstreamOrigin` is for the share button: the window's own origin is the
    // loopback proxy, so a link built from it opens nothing on anybody else's
    // computer. This is the address this client is connected to, which is what a
    // link should carry — a LAN address where the receiver is on the LAN,
    // because that is where it is being shared.
    //
    // `password` is the instance's saved bypass password, if it has one. It goes
    // to the preload, which puts it where the page already looks for one; it is
    // never handed to the page as a value.
    //
    // Synchronous for the same reason as the seed below: both are read at
    // preload, before the page exists to be told about them later.
    ipcMain.on('window:context', (event) => {
        const rec = recordFor(event.sender);
        event.returnValue = rec ? {
            upstreamOrigin: rec.proxy.upstreamOrigin,
            password: store.passwordFor(rec.id),
        } : null;
    });

    // The key icon in the chooser. The target is a saved instance by id, or a
    // receiver from the LAN scan or directory by address — which may already be
    // saved under a different label, and if it is, this is its password.
    // `saved: false` means there is nothing to attach it to yet, and the chooser
    // keeps it until the connect that creates the entry.
    ipcMain.handle('instances:set-password', (_e, target, password) => {
        const found = target && target.id
            ? store.get(target.id)
            : (target ? store.find(target.host, target.port, !!target.tls) : null);
        if (!found) return { ok: true, saved: false, hasPassword: !!password };
        const entry = store.setPassword(found.id, password);
        // A password is read once, at load. A window already open has to be sent
        // round again for a change to mean anything — and going round is also
        // how a wrong one gets a second try.
        const active = running.get(found.id);
        if (active) active.win.webContents.reload();
        notifyChooser();
        return { ok: true, saved: true, hasPassword: !!(entry && entry.password) };
    });

    // Shared settings. The seed is synchronous because the receiver preload
    // has to apply it before the page's own scripts read localStorage.
    ipcMain.on('prefs:seed', (event) => {
        event.returnValue = { enabled: prefs.enabled, prefs: prefs.snapshot() };
    });
    ipcMain.on('prefs:push', (_e, map) => {
        if (prefs.enabled) prefs.update(map);
    });
    ipcMain.handle('prefs:shared', () => prefs.enabled);
    ipcMain.handle('prefs:set-shared', (_e, on) => {
        prefs.setEnabled(on);
        // Switching it on makes the most recently connected receiver the
        // template: with one window open — the common case — that is the
        // window being looked at, and "share settings" means "like this".
        let primaryId = null;
        if (on) {
            let best = '';
            for (const id of running.keys()) {
                const used = (store.get(id) || {}).lastUsed || '';
                if (used >= best) {
                    best = used;
                    primaryId = id;
                }
            }
        }
        for (const [id, active] of running.entries()) {
            active.win.webContents.send('prefs:mode', {
                enabled: prefs.enabled,
                primary: id === primaryId,
            });
        }
        return prefs.enabled;
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
    // safeStorage rather than the file: an instance password is the operator's,
    // and on every platform with a keychain it belongs in it. Read lazily by the
    // store, because on Linux it is only answerable once the app is ready.
    store = new InstanceStore(app.getPath('userData'), safeStorage);
    prefs = new SharedPrefs(app.getPath('userData'));
    setupSession();
    setupMenu();
    setupIpc();
    showChooser();
});

app.on('activate', () => showChooser());
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
