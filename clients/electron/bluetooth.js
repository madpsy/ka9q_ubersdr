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

/**
 * Handles `select-bluetooth-device` for one webContents.
 *
 * `deps`:
 *   choose(parentWindow, rows, origin, kind)  the picker; resolves with an id or ''
 *   changed(kind, 'add', row)                 a device turned up while it is open
 *   windowOf(webContents)                     its BrowserWindow, or null
 *   originOf(webContents)                     the host to name in the picker
 *
 * Returns the listener, so a test can drive it without Electron.
 */
function bluetoothSelectHandler(wc, deps) {
    // One request at a time per page: { seen, callback }.
    let pending = null;
    return (event, deviceList, callback) => {
        event.preventDefault();
        const rows = (deviceList || []).map(describeBluetoothDevice).filter((r) => r.portId);
        if (pending) {
            // Discovery found more: newest callback is the live one.
            pending.callback = callback;
            for (const row of rows) {
                if (pending.seen.has(row.portId)) continue;
                pending.seen.add(row.portId);
                deps.changed('bluetooth', 'add', row);
            }
            return;
        }
        const req = { seen: new Set(rows.map((r) => r.portId)), callback };
        pending = req;
        const settle = (id) => {
            if (pending === req) pending = null;
            try { req.callback(id || ''); } catch (e) { /* page went away */ }
        };
        Promise.resolve(deps.choose(deps.windowOf(wc), rows, deps.originOf(wc), 'bluetooth'))
            .then(settle, () => settle(''));
    };
}

/** Wires the handler into every webContents the app creates. */
function installBluetoothHandlers(app, deps) {
    app.on('web-contents-created', (_event, wc) => {
        wc.on('select-bluetooth-device', bluetoothSelectHandler(wc, deps));
    });
}

module.exports = { describeBluetoothDevice, bluetoothSelectHandler, installBluetoothHandlers };
