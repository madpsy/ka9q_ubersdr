'use strict';

// WebHID in the desktop client: which HID devices a page may have, and how
// they are shown in the device picker.
//
// The page is content served by whichever instance was connected to, and WebHID
// reaches raw USB devices, so the answer to "which ones" is a list rather than
// "any": the RC-28 tuning dial (static/v2/src/controls/rc28.js) and nothing
// else. A browser asks the operator about every device; here the picker asks
// about the ones on this list, and the permission handler refuses the rest
// outright — so a page that calls requestDevice() with no filter, or with
// somebody's keyboard's IDs, is offered nothing.
//
// Serial is answered differently on purpose. Every serial port is offered in
// the picker, because the FlexControl and the Radio Sync rigs between them are
// any USB-serial bridge at all, and there is no list to hold them to.

/** The HID devices a page may open. Each is { vendorId, productId, name }. */
const ALLOWED_HID = [
    // Icom RC-28 REMOTE ENCODER — github.com/CerberusSolutions/FlexRC-28
    { vendorId: 0x0C26, productId: 0x001E, name: 'Icom RC-28' },
];

function isAllowedHidDevice(device) {
    if (!device) return false;
    const vid = Number(device.vendorId);
    const pid = Number(device.productId);
    return ALLOWED_HID.some((d) => d.vendorId === vid && d.productId === pid);
}

/**
 * The answer for `session.setDevicePermissionHandler`.
 *
 * Serial as before; HID only for a device on the list; nothing else — USB is
 * not used by the page at all, and a device type nobody asked for is refused
 * rather than waved through.
 */
function devicePermission(details) {
    if (!details) return false;
    if (details.deviceType === 'serial') return true;
    if (details.deviceType === 'hid') return isAllowedHidDevice(details.device);
    return false;
}

const hex4 = (n) => (Number.isInteger(n) ? n.toString(16).padStart(4, '0') : '');

/**
 * A HID device as a picker row — the same shape describePort gives a serial
 * port, so one picker page draws both. Only strings, and only these fields:
 * the device objects come from Chromium's device layer and nothing else in
 * them is the page's business.
 *
 * `portName` is left empty: a HID device has no path Chromium will name, and
 * the picker shows the USB IDs on the second line instead.
 */
function describeHidDevice(device) {
    const known = ALLOWED_HID.find((d) => d.vendorId === device.vendorId && d.productId === device.productId);
    return {
        portId: String(device.deviceId || ''),
        portName: '',
        displayName: String(device.name || (known && known.name) || ''),
        vendorId: hex4(device.vendorId),
        productId: hex4(device.productId),
        serialNumber: String(device.serialNumber || ''),
    };
}

/** What `select-hid-device` hands the picker: the allowed devices, as rows. */
function hidPickerRows(deviceList) {
    return (deviceList || []).filter(isAllowedHidDevice).map(describeHidDevice);
}

/**
 * The list after a device arrives or leaves while the picker is open. Rows are
 * matched by id, so a device that re-announces itself replaces its row rather
 * than appearing twice.
 */
function patchRows(rows, change, row) {
    const rest = rows.filter((p) => p.portId !== row.portId);
    return change === 'add' ? [...rest, row] : rest;
}

/** The picker window's title, by what it is picking. */
function pickerTitle(kind) {
    return kind === 'hid' ? 'Select USB device' : 'Select serial port';
}

/**
 * Wires WebHID into a session: the chooser, its hotplug, and the permission
 * handler (which covers serial too — there is one per session).
 *
 * Here rather than inline in main.js so that it can be driven with a fake
 * session: what is worth pinning is exactly what this decides — which devices
 * reach the picker, and what Electron is told when nothing is picked. `deps`
 * is the part that needs Electron proper:
 *
 *   choose(parentWindow, rows, origin, kind)  the picker; resolves with an id or ''
 *   changed(kind, 'add'|'remove', row)        a device came or went while it is open
 *   fromFrame(frame)                          the requesting webContents, or null
 *   windowOf(webContents)                     its BrowserWindow, or null
 *   originOf(webContents)                     the host to name in the picker
 */
function installHidHandlers(ses, deps) {
    // Electron has no HID chooser, so without this requestDevice() would hang.
    // Only allowed devices are offered — whatever filter the page asked with —
    // and every one has to be picked, even when it is the only one.
    ses.on('select-hid-device', (event, details, callback) => {
        event.preventDefault();
        // The frame is null if the page navigated away mid-request; the picker
        // then opens unparented and unattributed rather than not at all.
        const wc = details && details.frame ? deps.fromFrame(details.frame) : null;
        Promise.resolve(deps.choose(
            wc ? deps.windowOf(wc) : null,
            hidPickerRows(details && details.deviceList),
            wc ? deps.originOf(wc) : '',
            'hid',
        ))
            // The picker says '' for "none of them"; Electron's HID callback
            // wants no id at all for that.
            .then((id) => callback(id || null), () => callback(null));
    });
    ses.on('hid-device-added', (_event, details) => {
        if (details && isAllowedHidDevice(details.device)) {
            deps.changed('hid', 'add', describeHidDevice(details.device));
        }
    });
    ses.on('hid-device-removed', (_event, details) => {
        if (details && isAllowedHidDevice(details.device)) {
            deps.changed('hid', 'remove', describeHidDevice(details.device));
        }
    });
    // Serial as before, HID only for an allowed device. This is also what
    // getDevices() consults, so it is what lets the RC-28 reconnect on its own
    // once it has been picked.
    ses.setDevicePermissionHandler(devicePermission);
}

module.exports = {
    ALLOWED_HID, isAllowedHidDevice, devicePermission, describeHidDevice, hidPickerRows,
    patchRows, pickerTitle, installHidHandlers,
};
