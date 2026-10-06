// WebHID in the desktop client: which devices a page may have, the picker's
// session handlers, and the packaging that makes the RC-28 openable on Linux.
//
// There is no RC-28 here and no Electron, so the session is a stand-in that
// records what was registered on it, and the devices are the shapes Electron's
// typings give (HIDDevice: deviceId, name, vendorId, productId, serialNumber).
// The failures worth pinning are the quiet ones: a permission handler that
// waves every HID device through to remote page content, a picker that never
// answers Electron so requestDevice() hangs, and a .deb without the udev rule,
// where the dial is plugged in, visible to lsusb, and simply never appears.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    ALLOWED_HID, isAllowedHidDevice, devicePermission, describeHidDevice, hidPickerRows,
    patchRows, pickerTitle, installHidHandlers,
} = require('../hid.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

const ROOT = path.join(__dirname, '..');

const RC28 = { deviceId: '7', name: 'RC-28 REMOTE ENCODER', vendorId: 0x0C26, productId: 0x001E, serialNumber: '' };
const KEYBOARD = { deviceId: '3', name: 'USB Keyboard', vendorId: 0x046D, productId: 0xC31C };
const YUBIKEY = { deviceId: '4', name: 'YubiKey', vendorId: 0x1050, productId: 0x0407 };

// --- the allowlist ----------------------------------------------------------

t('the RC-28 is allowed, by the IDs FlexRC-28 documents', () => {
    assert.ok(isAllowedHidDevice(RC28));
    assert.ok(ALLOWED_HID.some((d) => d.vendorId === 0x0C26 && d.productId === 0x001E));
});

t('nothing else on the bus is', () => {
    assert.strictEqual(isAllowedHidDevice(KEYBOARD), false);
    assert.strictEqual(isAllowedHidDevice(YUBIKEY), false);
    assert.strictEqual(isAllowedHidDevice({ vendorId: 0x0C26, productId: 0x001F }), false, 'same vendor, other product');
    assert.strictEqual(isAllowedHidDevice(null), false);
    assert.strictEqual(isAllowedHidDevice({}), false);
});

t('the IDs the page asks for and the IDs allowed here agree', () => {
    // Two lists of the same device in two languages: if they drift, the page
    // asks for a dial the client will never offer.
    const src = fs.readFileSync(path.join(ROOT, '..', '..', 'static', 'v2', 'src', 'controls', 'rc28.js'), 'utf8');
    const vid = Number(/RC28_VENDOR_ID = (0x[0-9A-Fa-f]+)/.exec(src)[1]);
    const pid = Number(/RC28_PRODUCT_ID = (0x[0-9A-Fa-f]+)/.exec(src)[1]);
    assert.ok(isAllowedHidDevice({ vendorId: vid, productId: pid }));
});

// --- the device permission handler ------------------------------------------

t('serial ports are still allowed, as they were before HID', () => {
    // The FlexControl and Radio Sync depend on it; this handler replaced one
    // that said `deviceType === 'serial'` and nothing else.
    assert.strictEqual(devicePermission({ deviceType: 'serial', device: {} }), true);
});

t('HID is allowed for the RC-28 and refused for anything else', () => {
    assert.strictEqual(devicePermission({ deviceType: 'hid', device: RC28 }), true);
    assert.strictEqual(devicePermission({ deviceType: 'hid', device: KEYBOARD }), false);
    assert.strictEqual(devicePermission({ deviceType: 'hid', device: YUBIKEY }), false);
    assert.strictEqual(devicePermission({ deviceType: 'hid' }), false, 'no device named');
});

t('device types nobody asked for are refused', () => {
    assert.strictEqual(devicePermission({ deviceType: 'usb', device: RC28 }), false);
    assert.strictEqual(devicePermission({ deviceType: 'bluetooth' }), false);
    assert.strictEqual(devicePermission(null), false);
});

// --- picker rows ------------------------------------------------------------

t('an RC-28 becomes a picker row in the serial picker’s shape', () => {
    assert.deepStrictEqual(describeHidDevice(RC28), {
        portId: '7',
        portName: '',
        displayName: 'RC-28 REMOTE ENCODER',
        vendorId: '0c26',
        productId: '001e',
        serialNumber: '',
    });
});

t('a device with no name of its own is named from the allowlist', () => {
    const row = describeHidDevice({ ...RC28, name: '' });
    assert.strictEqual(row.displayName, 'Icom RC-28');
});

t('every field of a row is a string', () => {
    // The row crosses into a renderer; nothing but strings goes there.
    const row = describeHidDevice({ deviceId: 9, vendorId: 0x0C26, productId: 0x001E });
    for (const [k, v] of Object.entries(row)) assert.strictEqual(typeof v, 'string', k);
});

t('the picker is only ever shown allowed devices', () => {
    const rows = hidPickerRows([KEYBOARD, RC28, YUBIKEY]);
    assert.deepStrictEqual(rows.map((r) => r.portId), ['7']);
    assert.deepStrictEqual(hidPickerRows(undefined), []);
});

t('a device that comes and goes is patched in and out by id', () => {
    const a = describeHidDevice(RC28);
    const b = describeHidDevice({ ...RC28, deviceId: '8' });
    let rows = patchRows([], 'add', a);
    rows = patchRows(rows, 'add', b);
    rows = patchRows(rows, 'add', a);
    assert.deepStrictEqual(rows.map((r) => r.portId), ['8', '7'], 'a re-announced device is not listed twice');
    rows = patchRows(rows, 'remove', b);
    assert.deepStrictEqual(rows.map((r) => r.portId), ['7']);
});

t('the window is titled for what it is picking', () => {
    assert.strictEqual(pickerTitle('hid'), 'Select USB device');
    assert.strictEqual(pickerTitle('serial'), 'Select serial port');
});

// --- the session handlers ---------------------------------------------------

// A session that records its handlers, and the picker's dependencies as
// recorders too. `answer` is what the operator picks.
function fakeSession(answer = '') {
    const handlers = {};
    const ses = {
        on: (name, fn) => { handlers[name] = fn; },
        setDevicePermissionHandler: (fn) => { ses.permission = fn; },
    };
    const calls = { choose: [], changed: [] };
    const win = { id: 'win' };
    const wc = { id: 'wc' };
    const deps = {
        choose: (...args) => { calls.choose.push(args); return Promise.resolve(answer); },
        changed: (...args) => calls.changed.push(args),
        fromFrame: (frame) => (frame === 'frame' ? wc : null),
        windowOf: (w) => (w === wc ? win : null),
        originOf: (w) => (w === wc ? 'receiver.example:8073' : ''),
    };
    installHidHandlers(ses, deps);
    return { ses, handlers, calls, win };
}

// Runs select-hid-device and resolves with what Electron was told.
function select(handlers, details) {
    return new Promise((resolve) => {
        const event = { prevented: false, preventDefault() { event.prevented = true; } };
        handlers['select-hid-device'](event, details, (id) => resolve({ id, event }));
    });
}

t('all three HID events and the permission handler are registered', () => {
    const { ses, handlers } = fakeSession();
    for (const name of ['select-hid-device', 'hid-device-added', 'hid-device-removed']) {
        assert.strictEqual(typeof handlers[name], 'function', name);
    }
    assert.strictEqual(ses.permission, devicePermission);
});

at('picking the RC-28 hands its id to Electron', async () => {
    const { handlers, calls, win } = fakeSession('7');
    const { id, event } = await select(handlers, { deviceList: [RC28, KEYBOARD], frame: 'frame' });
    assert.strictEqual(event.prevented, true, 'without preventDefault Electron cancels the request itself');
    assert.strictEqual(id, '7');
    const [parent, rows, origin, kind] = calls.choose[0];
    assert.strictEqual(parent, win, 'modal over the window that asked');
    assert.deepStrictEqual(rows.map((r) => r.portId), ['7'], 'the keyboard is not offered');
    assert.strictEqual(origin, 'receiver.example:8073');
    assert.strictEqual(kind, 'hid');
});

at('picking nothing is no id, not an empty string', async () => {
    // Electron's HID callback takes `deviceId?: string | null`; '' would be
    // an id that matches no device.
    const { handlers } = fakeSession('');
    const { id } = await select(handlers, { deviceList: [RC28], frame: 'frame' });
    assert.strictEqual(id, null);
});

at('the picker is shown even for a single allowed device', async () => {
    // The page is remote content; it does not get hardware nobody named.
    const { handlers, calls } = fakeSession('7');
    await select(handlers, { deviceList: [RC28], frame: 'frame' });
    assert.strictEqual(calls.choose.length, 1);
});

at('the picker opens with nothing to offer, rather than hanging the page', async () => {
    // A page that asked for a keyboard gets an empty picker it can cancel.
    const { handlers, calls } = fakeSession('');
    const { id } = await select(handlers, { deviceList: [KEYBOARD], frame: 'frame' });
    assert.deepStrictEqual(calls.choose[0][1], []);
    assert.strictEqual(id, null);
});

at('a request from a frame that has gone still opens a picker', async () => {
    const { handlers, calls } = fakeSession('7');
    const { id } = await select(handlers, { deviceList: [RC28], frame: null });
    assert.strictEqual(id, '7');
    assert.strictEqual(calls.choose[0][0], null, 'unparented');
    assert.strictEqual(calls.choose[0][2], '', 'unattributed');
});

at('a picker that fails still answers Electron', async () => {
    const handlers = {};
    installHidHandlers(
        { on: (n, fn) => { handlers[n] = fn; }, setDevicePermissionHandler: () => {} },
        {
            choose: () => Promise.reject(new Error('window failed')),
            changed: () => {},
            fromFrame: () => null,
            windowOf: () => null,
            originOf: () => '',
        },
    );
    const { id } = await select(handlers, { deviceList: [RC28], frame: null });
    assert.strictEqual(id, null);
});

t('an RC-28 plugged in while the picker is open joins the list', () => {
    const { handlers, calls } = fakeSession();
    handlers['hid-device-added']({}, { device: RC28, frame: null });
    assert.deepStrictEqual(calls.changed, [['hid', 'add', describeHidDevice(RC28)]]);
});

t('other HID devices coming and going are not passed on', () => {
    const { handlers, calls } = fakeSession();
    handlers['hid-device-added']({}, { device: KEYBOARD });
    handlers['hid-device-removed']({}, { device: YUBIKEY });
    handlers['hid-device-added']({}, null);
    assert.deepStrictEqual(calls.changed, []);
});

t('an RC-28 unplugged while the picker is open leaves the list', () => {
    const { handlers, calls } = fakeSession();
    handlers['hid-device-removed']({}, { device: RC28 });
    assert.deepStrictEqual(calls.changed, [['hid', 'remove', describeHidDevice(RC28)]]);
});

// --- packaging --------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RULE_FILE = 'linux/70-ubersdr-rc28.rules';

t('hid.js is packaged', () => {
    // build.files is an allowlist; a module left off it works under
    // `npm start` and throws 'Cannot find module' only once packaged.
    assert.ok(pkg.build.files.includes('hid.js'));
});

t('the udev rule is mapped into the .deb where packages put them', () => {
    const fpm = pkg.build.deb.fpm || [];
    const mapping = fpm.find((a) => a.startsWith(`${RULE_FILE}=`));
    assert.ok(mapping, `no fpm mapping for ${RULE_FILE}`);
    assert.strictEqual(mapping.split('=')[1], '/usr/lib/udev/rules.d/70-ubersdr-rc28.rules');
    assert.ok(fs.existsSync(path.join(ROOT, RULE_FILE)), 'the mapped file exists');
});

t('the .deb keeps electron-builder’s own install scripts', () => {
    // Setting afterInstall replaces its script — the /usr/bin link, the
    // chrome-sandbox mode, AppArmor — rather than adding to it.
    assert.strictEqual(pkg.build.deb.afterInstall, undefined);
    assert.strictEqual((pkg.build.linux || {}).afterInstall, undefined);
});

t('the udev rule matches the RC-28 on hidraw and tags it for the seat', () => {
    const rules = fs.readFileSync(path.join(ROOT, RULE_FILE), 'utf8')
        .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.strictEqual(rules.length, 1);
    const rule = rules[0];
    // Chromium opens hidraw nodes; a rule on the usb subsystem would set the
    // wrong node's permissions and change nothing.
    assert.match(rule, /SUBSYSTEM=="hidraw"/);
    const vid = /ATTRS\{idVendor\}=="([0-9a-f]{4})"/.exec(rule);
    const pid = /ATTRS\{idProduct\}=="([0-9a-f]{4})"/.exec(rule);
    assert.ok(vid && pid, 'lowercase four-digit hex, as sysfs writes them');
    assert.ok(isAllowedHidDevice({ vendorId: parseInt(vid[1], 16), productId: parseInt(pid[1], 16) }),
        'the rule is for the device the client allows');
    assert.match(rule, /TAG\+="uaccess"/);
});

t('the rule is numbered before 73-seat-late, which acts on uaccess', () => {
    const n = Number(path.basename(RULE_FILE).split('-')[0]);
    assert.ok(n < 73, `${n} sorts after 73-seat-late.rules and its tag would never be seen`);
});

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} HID tests passed`);
})();
