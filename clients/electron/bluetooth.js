'use strict';

// Web Bluetooth in the desktop client: the UberSDR Dial (static/v2/src/
// controls/dial.js) in its Bluetooth controller mode.
//
// Electron ships no Bluetooth chooser. Instead each webContents fires
// `select-bluetooth-device`, and fires it *again* every time discovery finds
// another device, until something calls the latest callback with an id (or ''
// to cancel). Without a handler the page's requestDevice() never settles.
//
// So the first event of a request opens the same device picker serial and HID
// use (main.js chooseDevice), later events add rows to it as devices turn up,
// and the answer goes to the most recent callback, which is the one Chromium is
// waiting on.
//
// Which devices: Chromium has already filtered discovery by the services the
// page asked for (the Dial's own service UUID), so every row is a device that
// advertises it. Nothing is picked automatically, even when there is one.

/** A discovered device as a picker row — the shape describePort gives a serial port. */
function describeBluetoothDevice(device) {
    return {
        portId: String((device && device.deviceId) || ''),
        portName: '',
        displayName: String((device && device.deviceName) || 'Unnamed Bluetooth device'),
        vendorId: '',
        productId: '',
        serialNumber: '',
    };
}

// ── Reconnecting without a picker ───────────────────────────────────────────
//
// In a browser the Dial's "connect automatically" is getDevices(): the devices
// this origin was allowed before, handed back without asking. Electron never
// implemented the store behind it — its Bluetooth delegate's
// GetPermittedDevices() is a NOTIMPLEMENTED stub that returns nothing — so here
// that call is always empty and the switch could never do anything.
//
// So this end remembers instead: the dial last picked here, by the id discovery
// reports it under (its address), kept in a small file beside the app's other
// state. A page asks to reconnect (main.js, bluetooth:auto-connect), which arms
// that page and has it make one request; the request is answered from
// discovery with the remembered dial the moment it is seen, without a picker,
// and disarmed when it ends. If the dial is not seen within AUTO_WAIT_MS of
// arming (switched off, out of range), the request is cancelled, which is what
// a page sees when its operator closes the picker: "not now", quietly.
//
// Armed for exactly the life of that request — main.js awaits it — rather than
// for a time: discovery reports its first device whenever it finds one, which
// can be well after the request, and a page left armed would have its next
// manual Connect answered behind the operator's back.

const AUTO_WAIT_MS = 10_000;

/**
 * The remembered dial and the per-page arming, keyed by webContents id.
 * `load()` returns `{ id, name }` or null; `save(dial)` keeps it. `now` is a
 * seam for the tests.
 */
function createBluetoothMemory({ load, save, now = Date.now }) {
    const armed = new Map();     // webContents id → when it was armed
    const key = (wc) => (wc && wc.id != null ? wc.id : wc);
    return {
        remembered() {
            try {
                const d = load();
                return d && typeof d.id === 'string' && d.id ? { id: d.id, name: String(d.name || '') } : null;
            } catch (e) {
                return null;
            }
        },
        remember(row) {
            if (!row || !row.portId) return;
            try { save({ id: row.portId, name: row.displayName || '' }); } catch (e) { /* read-only disk */ }
        },
        /** True when there is a dial to look for; the page's request comes next. */
        arm(wc) {
            if (!this.remembered()) return false;
            armed.set(key(wc), now());
            return true;
        },
        /**
         * The dial to auto-pick for this page's request and how long is left to
         * find it, or null for an ordinary request. Once per arming.
         */
        take(wc) {
            const at = armed.get(key(wc));
            armed.delete(key(wc));
            if (at == null) return null;
            const dial = this.remembered();
            return dial ? { ...dial, waitMs: Math.max(0, at + AUTO_WAIT_MS - now()) } : null;
        },
        forget(wc) { armed.delete(key(wc)); },
    };
}

/**
 * Handles `select-bluetooth-device` for one webContents.
 *
 * `deps`:
 *   choose(parentWindow, rows, origin, kind)  the picker; resolves with an id or ''
 *   changed(kind, 'add', row)                 a device turned up while it is open
 *   windowOf(webContents)                     its BrowserWindow, or null
 *   originOf(webContents)                     the host to name in the picker
 *   memory                                    createBluetoothMemory(); optional
 *   setTimer / clearTimer                     seams for the tests; default the globals
 *
 * Returns the listener, so a test can drive it without Electron.
 */
function bluetoothSelectHandler(wc, deps) {
    const setTimer = deps.setTimer || setTimeout;
    const clearTimer = deps.clearTimer || clearTimeout;
    // One request at a time per page.
    let pending = null;
    return (event, deviceList, callback) => {
        event.preventDefault();
        const rows = (deviceList || []).map(describeBluetoothDevice).filter((r) => r.portId);
        if (pending) {
            // Discovery found more: newest callback is the live one.
            pending.callback = callback;
            if (pending.want) {
                if (rows.some((r) => r.portId === pending.want)) pending.settle(pending.want);
                return;
            }
            for (const row of rows) {
                if (pending.seen.has(row.portId)) continue;
                pending.seen.set(row.portId, row);
                deps.changed('bluetooth', 'add', row);
            }
            return;
        }
        const req = { seen: new Map(rows.map((r) => [r.portId, r])), callback, want: null, timer: null };
        pending = req;
        let done = false;
        req.settle = (id) => {
            if (done) return;
            done = true;
            if (req.timer) clearTimer(req.timer);
            if (pending === req) pending = null;
            try { req.callback(id || ''); } catch (e) { /* page went away */ }
        };

        // A reconnect the page asked for: no picker, just the remembered dial.
        const auto = deps.memory ? deps.memory.take(wc) : null;
        if (auto) {
            req.want = auto.id;
            if (rows.some((r) => r.portId === auto.id)) { req.settle(auto.id); return; }
            // Counted from the arming, not from this first report, which can come
            // late; out of time already, it is cancelled now, never a picker.
            req.timer = setTimer(() => req.settle(''), auto.waitMs);
            return;
        }

        Promise.resolve(deps.choose(deps.windowOf(wc), rows, deps.originOf(wc), 'bluetooth'))
            .then((id) => {
                // Picked by hand: this is the dial to look for next time.
                if (id && deps.memory) deps.memory.remember(req.seen.get(id) || { portId: id, displayName: '' });
                req.settle(id);
            }, () => req.settle(''));
    };
}

/** Wires the handler into every webContents the app creates. */
function installBluetoothHandlers(app, deps) {
    app.on('web-contents-created', (_event, wc) => {
        wc.on('select-bluetooth-device', bluetoothSelectHandler(wc, deps));
        if (deps.memory && typeof wc.once === 'function') wc.once('destroyed', () => deps.memory.forget(wc));
    });
}

module.exports = {
    AUTO_WAIT_MS,
    describeBluetoothDevice, createBluetoothMemory, bluetoothSelectHandler, installBluetoothHandlers,
};
