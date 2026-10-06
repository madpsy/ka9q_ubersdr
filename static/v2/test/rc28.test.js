// Icom RC-28: the HID report format, tap and hold, the LEDs, and the surface
// plumbing that makes it a third choice beside the FlexControl and MIDI.
//
// There is no RC-28 on the bench, so the reports here are built byte for byte
// from FlexRC-28's protocol notes (its README, "RC-28 HID Protocol", and
// src/rc28.js) and the device is a stand-in for WebHID's HIDDevice. What can go
// wrong silently is what is pinned: a byte read from the wrong offset turns the
// dial one way whichever way it goes, an LED byte with a bit the wrong sense
// lights everything, and a hold measured off a late timer turns into a tap.

const assert = require('assert');
const rc = require('./.build/rc28.cjs');
const snapshots = require('./.build/bridgesnapshots.cjs');

const {
    parseReport, dialDelta, ledByte, rc28KeyLabel, RC28_KEYS, RC28Control,
    RC28_VENDOR_ID, RC28_PRODUCT_ID, RC28_DEFAULT_MAPPINGS, HOLD_MS,
} = rc;

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

// --- stand-ins ---------------------------------------------------------------

const IDLE = 0x07;
const PTT = 0x06;       // bit 0 low
const F1 = 0x05;        // bit 1 low
const F2 = 0x03;        // bit 2 low
const CW = 0x01;
const CCW = 0x02;

// An input report as the RC-28 sends it: 32 bytes, 0x01 first.
function report({ speed = 0, dir = 0, buttons = IDLE } = {}) {
    const b = new Array(32).fill(0);
    b[0] = 0x01;
    b[1] = speed;
    b[3] = dir;
    b[5] = buttons;
    return b;
}

// WebHID's HIDDevice, as much of it as the driver touches. `sent` is every
// output report, as [reportId, bytes].
function fakeDevice({
    vendorId = RC28_VENDOR_ID, productId = RC28_PRODUCT_ID, opens = true, collections = [],
} = {}) {
    const listeners = new Set();
    const dev = {
        vendorId,
        productId,
        productName: 'RC-28 REMOTE ENCODER',
        collections,
        opened: false,
        closed: 0,
        sent: [],
        async open() {
            if (!opens) throw new Error('Failed to open the device.');
            dev.opened = true;
        },
        async close() { dev.opened = false; dev.closed += 1; },
        async sendReport(id, data) { dev.sent.push([id, Array.from(data)]); },
        addEventListener(type, fn) { if (type === 'inputreport') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'inputreport') listeners.delete(fn); },
        listening: () => listeners.size,
        // The device sending a report.
        fire(bytes, reportId = 0) {
            const data = new DataView(Uint8Array.from(bytes).buffer);
            for (const fn of Array.from(listeners)) fn({ reportId, data, device: dev });
        },
    };
    return dev;
}

// navigator.hid. `chosen` is what the chooser hands back; `requests` records
// what it was asked for.
function fakeHid({ granted = [], chosen = [], refuse = null } = {}) {
    const listeners = { connect: new Set(), disconnect: new Set() };
    const hid = {
        requests: [],
        async getDevices() { return granted; },
        async requestDevice(opts) {
            hid.requests.push(opts);
            if (refuse) throw refuse;
            return chosen;
        },
        addEventListener(type, fn) { listeners[type].add(fn); },
        removeEventListener(type, fn) { listeners[type].delete(fn); },
        fire(type, device) { for (const fn of Array.from(listeners[type])) fn({ device }); },
    };
    globalThis.navigator = { hid };
    return hid;
}

// A clock the test moves by hand, so a hold is 600 ms because the test said so.
function fakeClock() {
    let now = 1000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms }); return seq; },
        clearTimeout: (id) => { timers.delete(id); },
        // Time passing, timers firing as they come due.
        advance(ms) {
            now += ms;
            for (const [id, tm] of Array.from(timers)) {
                if (tm.at <= now) { timers.delete(id); tm.fn(); }
            }
        },
        // Time passing with the timers starved — a busy main thread.
        skip(ms) { now += ms; },
        pending: () => timers.size,
    };
}

// A connected RC-28 with its output collected.
async function connected(opts = {}) {
    const dev = fakeDevice(opts.device);
    const hid = fakeHid({ chosen: [dev] });
    const clock = fakeClock();
    const rc28 = new RC28Control(clock);
    const inputs = [];
    const msgs = [];
    const states = [];
    rc28.on('input', (e) => inputs.push(e));
    rc28.on('message', (m) => msgs.push(m));
    rc28.on('state', (s) => states.push(s.connected));
    const ok = await rc28.connect();
    // The LED write on connect is not awaited by the driver.
    await Promise.resolve();
    return { dev, hid, clock, rc28, inputs, msgs, states, ok };
}

const leds = (dev) => dev.sent.map(([, bytes]) => bytes[1]);
const keys = (inputs) => inputs.map((e) => e.key);

// --- the input report -------------------------------------------------------

t('an idle report is no movement and no buttons', () => {
    assert.deepStrictEqual(parseReport(report()), { speed: 0, direction: 0, buttons: IDLE });
});

t('direction byte 0x01 is clockwise and 0x02 anticlockwise', () => {
    // FlexRC-28: "0x01 = CW (freq up), 0x02 = CCW (freq down)". The wrong way
    // round tunes backwards and nothing else would notice.
    assert.strictEqual(parseReport(report({ speed: 3, dir: CW })).direction, 1);
    assert.strictEqual(parseReport(report({ speed: 3, dir: CCW })).direction, -1);
    assert.strictEqual(parseReport(report({ speed: 3, dir: 0x00 })).direction, 0);
});

t('speed and buttons come from bytes 1 and 5', () => {
    const r = parseReport(report({ speed: 9, dir: CW, buttons: F2 }));
    assert.strictEqual(r.speed, 9);
    assert.strictEqual(r.buttons, F2);
});

t('anything that is not an RC-28 input report is refused', () => {
    const wrong = report({ speed: 3, dir: CW });
    wrong[0] = 0x02;
    assert.strictEqual(parseReport(wrong), null);
    assert.strictEqual(parseReport([0x01, 3, 0, 1]), null, 'too short to hold the buttons');
    assert.strictEqual(parseReport(null), null);
});

t('a numbered report 1 reads the same fields one place earlier', () => {
    // If the descriptor declares report ID 1, WebHID strips it, and the payload
    // starts at the speed byte.
    const numbered = report({ speed: 5, dir: CCW, buttons: F1 }).slice(1);
    assert.deepStrictEqual(parseReport(numbered, 1), { speed: 5, direction: -1, buttons: F1 });
});

t('bits above F2 in the button byte are not buttons', () => {
    // Otherwise a stray high bit reads as a change on every report.
    assert.strictEqual(parseReport(report({ buttons: 0xF7 })).buttons, IDLE);
    assert.strictEqual(parseReport(report({ buttons: 0xFE })).buttons, PTT);
});

// --- the dial ---------------------------------------------------------------

t('a slow turn is one detent at a time', () => {
    assert.strictEqual(dialDelta(1, 1), 1);
    assert.strictEqual(dialDelta(2, -1), -1);
});

t('a fast spin accelerates, but never past the FlexControl’s six', () => {
    // The catalogue's encoders multiply their step by the delta; the scale was
    // set by the FlexControl's 1–6, and the RC-28 reports up to ~16.
    assert.strictEqual(dialDelta(4, 1), 2);
    assert.strictEqual(dialDelta(7, 1), 3);
    assert.strictEqual(dialDelta(11, -1), -4);
    assert.strictEqual(dialDelta(15, 1), 5);
    assert.strictEqual(dialDelta(16, 1), 6);
    assert.strictEqual(dialDelta(255, -1), -6);
});

t('the curve only ever rises with speed', () => {
    let last = 0;
    for (let speed = 1; speed <= 40; speed++) {
        const d = dialDelta(speed, 1);
        assert.ok(d >= last, `speed ${speed} gave ${d}, below ${last}`);
        assert.strictEqual(dialDelta(speed, -1), -d, `speed ${speed} is not symmetric`);
        last = d;
    }
});

t('no speed or no direction is no movement', () => {
    assert.strictEqual(dialDelta(0, 1), 0);
    assert.strictEqual(dialDelta(5, 0), 0);
});

// --- the LEDs ---------------------------------------------------------------

t('the LED byte matches FlexRC-28’s table, active low', () => {
    assert.strictEqual(ledByte(), 0x0F, 'all off');
    assert.strictEqual(ledByte({ link: true }), 0x07, 'link');
    assert.strictEqual(ledByte({ link: true, ptt: true }), 0x06, 'link + TX');
    assert.strictEqual(ledByte({ link: true, f1: true }), 0x05, 'link + F1');
    assert.strictEqual(ledByte({ link: true, f2: true }), 0x03, 'link + F2');
    assert.strictEqual(ledByte({ link: true, ptt: true, f1: true, f2: true }), 0x00, 'all on');
});

// --- labels and defaults ----------------------------------------------------

t('every RC-28 key has a label', () => {
    for (const { key } of RC28_KEYS) {
        assert.notStrictEqual(rc28KeyLabel(key), key, `${key} falls back to its raw id`);
    }
    assert.strictEqual(rc.surfaceKeyLabel('rc28')('f1_hold'), 'F1 — hold');
});

t('every key the driver can emit is in the key list', () => {
    const listed = new Set(RC28_KEYS.map((k) => k.key));
    for (const name of ['ptt', 'f1', 'f2']) {
        assert.ok(listed.has(`${name}_tap`), `${name}_tap`);
        assert.ok(listed.has(`${name}_hold`), `${name}_hold`);
    }
    assert.ok(listed.has('dial_up') && listed.has('dial_down'));
});

t('the dial arrives mapped to the frequency, the buttons unmapped', () => {
    assert.deepStrictEqual(Object.keys(RC28_DEFAULT_MAPPINGS).sort(), ['dial_down', 'dial_up']);
    for (const m of Object.values(RC28_DEFAULT_MAPPINGS)) {
        assert.ok(rc.isEncoderFunction(m.function), `${m.function} is not an encoder function`);
        assert.strictEqual(m.mode, 'rate_limit');
    }
    assert.deepStrictEqual(rc.DEFAULT_STATE.rc28.mappings, RC28_DEFAULT_MAPPINGS);
    assert.strictEqual(rc.DEFAULT_STATE.rc28.autoConnect, false, 'hardware binds itself only when asked');
});

t('the RC-28 is a mapped surface of this page’s own', () => {
    assert.ok(rc.SURFACES.includes('rc28'));
    assert.strictEqual(rc.isMappedSurface('rc28'), true);
    assert.ok(rc.getSurface('rc28') instanceof RC28Control);
    assert.strictEqual(rc.getSurface('rc28'), rc.getRc28(), 'one singleton');
});

t('the bridge does not mistake the RC-28 for an externally hosted surface', () => {
    // Otherwise the page asks a TCI-style provider called "rc28" to start.
    const snap = snapshots.sdrControlSnapshot({ controlSettings: { surface: 'rc28' } });
    assert.strictEqual(snap.running, false);
    assert.deepStrictEqual(snap.config, {});
});

// --- saved state ------------------------------------------------------------

function withStorage(saved, fn) {
    const store = saved === undefined ? {} : { 'ubersdr.v2.radioControl': JSON.stringify(saved) };
    globalThis.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
    };
    try { return fn(); } finally { delete globalThis.localStorage; }
}

t('a first run gets the dial mapped', () => {
    const state = withStorage(undefined, () => rc.loadState());
    assert.deepStrictEqual(state.rc28.mappings, RC28_DEFAULT_MAPPINGS);
});

t('a saved state from before the RC-28 existed gets the dial mapped too', () => {
    const state = withStorage({ surface: 'flexcontrol', flexcontrol: { mappings: {}, autoConnect: true } },
        () => rc.loadState());
    assert.deepStrictEqual(state.rc28.mappings, RC28_DEFAULT_MAPPINGS);
    assert.strictEqual(state.flexcontrol.autoConnect, true, 'the rest is untouched');
});

t('mappings somebody cleared stay cleared', () => {
    // The default is a default: pressing Clear must not be undone on reload.
    const state = withStorage({ surface: 'rc28', rc28: { mappings: {}, autoConnect: true } },
        () => rc.loadState());
    assert.deepStrictEqual(state.rc28.mappings, {});
    assert.strictEqual(state.surface, 'rc28');
});

// --- connecting -------------------------------------------------------------

at('the chooser is filtered to the RC-28', async () => {
    const { hid, ok, msgs, states } = await connected();
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(hid.requests, [{ filters: [{ vendorId: 0x0C26, productId: 0x001E }] }]);
    assert.ok(msgs.some((m) => m.tone === 'good'), 'the connection is logged');
    assert.deepStrictEqual(states, [true]);
});

at('connecting lights the Link LED with FlexRC-28’s report', async () => {
    const { dev } = await connected();
    assert.strictEqual(dev.opened, true);
    assert.strictEqual(dev.sent.length, 1);
    const [id, bytes] = dev.sent[0];
    assert.strictEqual(id, 0, 'no report ID, as FlexRC-28 writes it');
    assert.strictEqual(bytes.length, 32);
    assert.strictEqual(bytes[0], 0x01);
    assert.strictEqual(bytes[1], 0x07, 'Link on, the rest off');
    assert.ok(bytes.slice(2).every((b) => b === 0), 'the rest of the report is zero');
});

at('a descriptor with a numbered output report is written by its number', async () => {
    const { dev } = await connected({
        device: { collections: [{ outputReports: [{ reportId: 1 }] }] },
    });
    const [id, bytes] = dev.sent[0];
    assert.strictEqual(id, 1);
    assert.strictEqual(bytes.length, 31, 'the ID stands in for the first byte');
    assert.strictEqual(bytes[0], 0x07);
});

at('dismissing the chooser is not a fault', async () => {
    fakeHid({ chosen: [] });
    const rc28 = new RC28Control(fakeClock());
    const msgs = [];
    rc28.on('message', (m) => msgs.push(m));
    assert.strictEqual(await rc28.connect(), false);
    assert.deepStrictEqual(msgs, []);
    assert.strictEqual(rc28.connected, false);
});

at('a chooser that fails says why', async () => {
    fakeHid({ refuse: new Error('Must be handling a user gesture') });
    const rc28 = new RC28Control(fakeClock());
    const msgs = [];
    rc28.on('message', (m) => msgs.push(m));
    assert.strictEqual(await rc28.connect(), false);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].tone, 'error');
    assert.match(msgs[0].text, /user gesture/);
});

at('a device that will not open says so when somebody asked', async () => {
    // On Linux: no udev rule, so /dev/hidraw* is root's.
    fakeHid({ chosen: [fakeDevice({ opens: false })] });
    const rc28 = new RC28Control(fakeClock());
    const msgs = [];
    rc28.on('message', (m) => msgs.push(m));
    assert.strictEqual(await rc28.connect(), false);
    assert.strictEqual(msgs[0].tone, 'error');
});

at('no WebHID is a message, not a crash', async () => {
    globalThis.navigator = {};
    const rc28 = new RC28Control(fakeClock());
    const msgs = [];
    rc28.on('message', (m) => msgs.push(m));
    assert.strictEqual(await rc28.connect(), false);
    assert.match(msgs[0].text, /WebHID/);
});

// --- autoconnect ------------------------------------------------------------
//
// Runs on page load and on hotplug, where no dial is the normal state. Silence
// is what is pinned, as for the FlexControl.

async function autoConnectWith(granted) {
    fakeHid({ granted });
    const rc28 = new RC28Control(fakeClock());
    const msgs = [];
    rc28.on('message', (m) => msgs.push(m));
    const ok = await rc28.autoConnect();
    return [ok, msgs, rc28];
}

at('autoconnect with nothing granted is silent', async () => {
    const [ok, msgs] = await autoConnectWith([]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(msgs, []);
});

at('autoconnect leaves a granted HID that is not an RC-28 alone', async () => {
    const other = fakeDevice({ vendorId: 0x046D, productId: 0xC52B });
    const [ok] = await autoConnectWith([other]);
    assert.strictEqual(ok, false);
    assert.strictEqual(other.opened, false);
});

at('autoconnect opens a granted RC-28 and says so', async () => {
    const [ok, msgs, rc28] = await autoConnectWith([fakeDevice()]);
    assert.strictEqual(ok, true);
    assert.strictEqual(rc28.connected, true);
    assert.ok(msgs.some((m) => m.tone === 'good'));
});

at('autoconnect to a device that will not open fails quietly', async () => {
    const [ok, msgs] = await autoConnectWith([fakeDevice({ opens: false })]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(msgs, []);
});

at('autoconnect with no WebHID is just false', async () => {
    globalThis.navigator = {};
    assert.strictEqual(await new RC28Control(fakeClock()).autoConnect(), false);
});

// --- input ------------------------------------------------------------------

at('the dial turns into signed relative events', async () => {
    const { dev, inputs } = await connected();
    dev.fire(report({ speed: 1, dir: CW }));
    dev.fire(report({ speed: 16, dir: CCW }));
    assert.deepStrictEqual(inputs, [
        { key: 'dial_up', event: { kind: 'relative', delta: 1 } },
        { key: 'dial_down', event: { kind: 'relative', delta: -6 } },
    ]);
});

at('a report with the dial stopped moves nothing', async () => {
    const { dev, inputs } = await connected();
    dev.fire(report());
    dev.fire(report({ speed: 0, dir: CW }));
    assert.deepStrictEqual(inputs, []);
});

at('a short press is a tap, fired on release', async () => {
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ buttons: F1 }));
    assert.deepStrictEqual(inputs, [], 'nothing on the way down: it may yet be a hold');
    clock.advance(200);
    dev.fire(report({ buttons: IDLE }));
    assert.deepStrictEqual(inputs, [{ key: 'f1_tap', event: { kind: 'trigger' } }]);
});

at('a long press is a hold, and the button’s LED says when it became one', async () => {
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ buttons: F2 }));
    clock.advance(HOLD_MS - 1);
    assert.deepStrictEqual(leds(dev), [0x07], 'not yet');
    clock.advance(1);
    await Promise.resolve();
    assert.deepStrictEqual(leds(dev), [0x07, 0x03], 'F2 lit beside Link at the threshold');
    dev.fire(report({ buttons: IDLE }));
    await Promise.resolve();
    assert.deepStrictEqual(keys(inputs), ['f2_hold']);
    assert.deepStrictEqual(leds(dev), [0x07, 0x03, 0x07], 'and dark again on release');
});

at('a hold is measured, not taken from a timer that ran late', async () => {
    // A busy page may not run the threshold timer on time; 700 ms down is a
    // hold whether or not the LED got to light.
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ buttons: PTT }));
    clock.skip(700);
    dev.fire(report({ buttons: IDLE }));
    assert.deepStrictEqual(keys(inputs), ['ptt_hold']);
    assert.strictEqual(clock.pending(), 0, 'the threshold timer is cleared on release');
});

at('a tap does not touch the LEDs', async () => {
    const { dev, clock } = await connected();
    dev.fire(report({ buttons: PTT }));
    clock.advance(100);
    dev.fire(report({ buttons: IDLE }));
    clock.advance(HOLD_MS);
    assert.deepStrictEqual(leds(dev), [0x07]);
});

at('buttons held together are tracked apart', async () => {
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ buttons: PTT }));             // PTT down
    clock.advance(100);
    dev.fire(report({ buttons: PTT & F2 }));        // and F2
    clock.advance(100);
    dev.fire(report({ buttons: F2 }));              // PTT up after 200 ms
    clock.advance(600);
    dev.fire(report({ buttons: IDLE }));            // F2 up after 700 ms
    assert.deepStrictEqual(keys(inputs), ['ptt_tap', 'f2_hold']);
});

at('the dial and a button in one report both count', async () => {
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ speed: 2, dir: CW, buttons: F1 }));
    clock.advance(50);
    dev.fire(report({ speed: 2, dir: CW, buttons: IDLE }));
    assert.deepStrictEqual(keys(inputs), ['dial_up', 'dial_up', 'f1_tap']);
});

at('a report repeating the same buttons is not another press', async () => {
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ buttons: F1 }));
    dev.fire(report({ speed: 3, dir: CW, buttons: F1 }));
    dev.fire(report({ buttons: F1 }));
    clock.advance(100);
    dev.fire(report({ buttons: IDLE }));
    dev.fire(report({ buttons: IDLE }));
    assert.deepStrictEqual(keys(inputs), ['dial_up', 'f1_tap']);
});

// --- letting go -------------------------------------------------------------

at('disconnect darkens the LEDs, closes the device and stops listening', async () => {
    const { dev, rc28, inputs, states } = await connected();
    await rc28.disconnect();
    assert.strictEqual(leds(dev).at(-1), 0x0F, 'Link off as well');
    assert.strictEqual(dev.closed, 1);
    assert.strictEqual(dev.listening(), 0);
    assert.strictEqual(rc28.connected, false);
    assert.deepStrictEqual(states, [true, false]);
    dev.fire(report({ speed: 3, dir: CW }));
    assert.deepStrictEqual(inputs, []);
});

at('disconnect mid-hold leaves no timer to light an LED afterwards', async () => {
    const { dev, clock, rc28 } = await connected();
    dev.fire(report({ buttons: F1 }));
    await rc28.disconnect();
    const before = dev.sent.length;
    clock.advance(HOLD_MS * 2);
    assert.strictEqual(dev.sent.length, before);
    assert.strictEqual(clock.pending(), 0);
});

at('a reconnect after a mid-press disconnect starts from idle', async () => {
    // The button state from before must not make the first report a release.
    const { dev, clock, rc28, inputs } = await connected();
    dev.fire(report({ buttons: F1 }));
    await rc28.disconnect();
    await rc28.connect();
    clock.advance(100);
    dev.fire(report({ buttons: IDLE }));
    assert.deepStrictEqual(inputs, []);
});

at('unplugging it is noticed', async () => {
    const { dev, hid, rc28, msgs, states } = await connected();
    hid.fire('disconnect', dev);
    assert.strictEqual(rc28.connected, false);
    assert.deepStrictEqual(states, [true, false]);
    assert.strictEqual(msgs.at(-1).tone, 'warn');
    assert.strictEqual(dev.listening(), 0);
});

at('another HID device unplugged is none of its business', async () => {
    const { hid, rc28 } = await connected();
    hid.fire('disconnect', fakeDevice({ vendorId: 0x046D, productId: 0xC52B }));
    assert.strictEqual(rc28.connected, true);
});

at('disconnecting what was never connected is a no-op', async () => {
    fakeHid();
    const rc28 = new RC28Control(fakeClock());
    const states = [];
    rc28.on('state', (s) => states.push(s));
    await rc28.disconnect();
    assert.deepStrictEqual(states, []);
});

// --- end to end -------------------------------------------------------------
//
// The real singleton, the real dispatcher and the default mapping: turning the
// dial of a freshly chosen RC-28 tunes the receiver.

at('a fresh RC-28’s dial tunes the receiver through the dispatcher', async () => {
    const dev = fakeDevice();
    fakeHid({ chosen: [dev] });
    const rc28 = rc.getRc28();
    await rc28.connect();

    const nudges = [];
    rc.setControlContext({
        stepHz: 1000,
        state: () => ({ tuning: { frequency: 14074000, mode: 'usb' }, dsp: { schemas: [] } }),
        actions: { nudge: (hz) => nudges.push(hz) },
    });
    rc.setSurfaceMappings('rc28', rc.DEFAULT_STATE.rc28.mappings);
    const off = rc.watchSurface('rc28');
    try {
        dev.fire(report({ speed: 5, dir: CCW }));
        assert.deepStrictEqual(nudges, [-3000], '3 detents of 1 kHz, downwards');
    } finally {
        off();
        rc._resetDispatch();
    }
});

at('choosing another surface lets go of the RC-28', async () => {
    const rc28 = rc.getRc28();
    if (!rc28.connected) {
        fakeHid({ chosen: [fakeDevice()] });
        await rc28.connect();
    }
    const dev = rc28.device;
    rc.releaseSurfaceExcept('flexcontrol');
    // disconnect() is async; give it its turns.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.strictEqual(rc28.connected, false);
    assert.strictEqual(dev.closed, 1);
});

// --- what a mapped function says about itself -------------------------------
//
// `lit` is what lets F1 and F2 show the state of what they control. Wrong here
// is a lamp that lies: lit for a mute that is off.

function radioState(over = {}) {
    const state = {
        tuning: { frequency: 14074000, mode: 'usb' },
        audio: { volume: 0.7, muted: false },
        squelch: { value: -10 },
        dsp: { filter: 'nr2', enabled: false, params: {}, schemas: [{ name: 'nr2', label: 'NR2', params: [] }] },
        locked: false,
        ...over,
    };
    return { stepHz: 1000, state: () => state, actions: {} };
}

t('a toggle says whether it is on', () => {
    assert.strictEqual(rc.functionLit('tune_lock_toggle', radioState({ locked: true })), true);
    assert.strictEqual(rc.functionLit('tune_lock_toggle', radioState()), false);
    assert.strictEqual(rc.functionLit('mute_toggle', radioState({ audio: { muted: true } })), true);
    assert.strictEqual(rc.functionLit('mute_toggle', radioState()), false);
});

t('the squelch toggle is on above the floor, which is its off', () => {
    assert.strictEqual(rc.functionLit('squelch_toggle', radioState({ squelch: { value: -10 } })), false);
    assert.strictEqual(rc.functionLit('squelch_toggle', radioState({ squelch: { value: 6 } })), true);
});

t('noise reduction reports its own switch', () => {
    const on = radioState();
    on.state().dsp.enabled = true;
    assert.strictEqual(rc.functionLit('dsp_toggle', on), true);
    assert.strictEqual(rc.functionLit('dsp_toggle', radioState()), false);
});

t('a mode button is on in that mode', () => {
    assert.strictEqual(rc.functionLit('mode_usb', radioState()), true);
    assert.strictEqual(rc.functionLit('mode_lsb', radioState()), false);
});

t('something with no on and off has nothing to say', () => {
    assert.strictEqual(rc.functionLit('mode_next', radioState()), null);
    assert.strictEqual(rc.functionLit('freq_enc_1k', radioState()), null);
    assert.strictEqual(rc.functionLit('no_such_function', radioState()), null);
});

t('a receiver with no state yet is no answer, not a crash', () => {
    assert.strictEqual(rc.functionLit('mute_toggle', { state: () => { throw new Error('not yet'); } }), null);
    assert.strictEqual(rc.functionLit('mute_toggle', { state: () => ({ dsp: {} }) }), null);
});

// --- which LEDs, from the settings ------------------------------------------

const indicators = (over = {}) => rc.indicatorLeds({
    settings: rc.DEFAULT_LEDS,
    mappings: {},
    ctx: radioState(),
    receiverUp: true,
    squelchOpen: false,
    recording: false,
    ...over,
});

t('with nothing mapped and the receiver up, only Link is lit', () => {
    assert.deepStrictEqual(indicators(), { link: true, ptt: false, f1: false, f2: false });
});

t('Link blinks while the receiver is down, if asked to', () => {
    assert.strictEqual(indicators({ receiverUp: false }).link, 'blink');
    const off = { ...rc.DEFAULT_LEDS, linkBlink: false };
    assert.strictEqual(indicators({ receiverUp: false, settings: off }).link, true, 'steady when the switch is off');
});

t('F1 follows what its tap is mapped to', () => {
    const mappings = { f1_tap: { function: 'mute_toggle' }, f2_tap: { function: 'tune_lock_toggle' } };
    const r = indicators({ mappings, ctx: radioState({ audio: { muted: true } }) });
    assert.strictEqual(r.f1, true);
    assert.strictEqual(r.f2, false, 'the lock is off');
});

t('following is the operator’s choice', () => {
    const mappings = { f1_tap: { function: 'mute_toggle' } };
    const r = indicators({ mappings, ctx: radioState({ audio: { muted: true } }), settings: { ...rc.DEFAULT_LEDS, follow: false } });
    assert.strictEqual(r.f1, false);
});

t('a tap with no on falls back to the hold mapping', () => {
    const mappings = { f2_tap: { function: 'freq_step_up' }, f2_hold: { function: 'tune_lock_toggle' } };
    assert.strictEqual(indicators({ mappings, ctx: radioState({ locked: true }) }).f2, true);
});

t('TX is off unless told what to show', () => {
    const mappings = { ptt_tap: { function: 'mute_toggle' } };
    const r = indicators({ mappings, ctx: radioState({ audio: { muted: true } }), squelchOpen: true, recording: true });
    assert.strictEqual(r.ptt, false);
});

t('TX can show what PTT controls, the squelch, or a recording', () => {
    const mappings = { ptt_tap: { function: 'mute_toggle' } };
    const as = (tx, over) => indicators({ settings: { ...rc.DEFAULT_LEDS, tx }, mappings, ...over }).ptt;
    assert.strictEqual(as('mapping', { ctx: radioState({ audio: { muted: true } }) }), true);
    assert.strictEqual(as('mapping', {}), false);
    assert.strictEqual(as('squelch', { squelchOpen: true }), true);
    assert.strictEqual(as('squelch', { squelchOpen: false }), false);
    assert.strictEqual(as('recording', { recording: true }), true);
    assert.strictEqual(as('recording', { recording: false, squelchOpen: true }), false, 'only what was chosen');
});

t('the TX choice does not leak onto F1 and F2', () => {
    // PTT's mapping is PTT's; following it must not light the other two.
    const mappings = { ptt_tap: { function: 'mute_toggle' } };
    const r = indicators({ settings: { ...rc.DEFAULT_LEDS, tx: 'mapping' }, mappings, ctx: radioState({ audio: { muted: true } }) });
    assert.deepStrictEqual([r.f1, r.f2], [false, false]);
});

t('settings with gaps or nonsense in them are filled in', () => {
    assert.deepStrictEqual(rc.ledSettings(undefined), rc.DEFAULT_LEDS);
    assert.deepStrictEqual(rc.ledSettings({ tx: 'recording' }), { ...rc.DEFAULT_LEDS, tx: 'recording' });
    assert.strictEqual(rc.ledSettings({ tx: 'disco' }).tx, 'off');
    assert.strictEqual(rc.ledSettings({ hold: 0 }).hold, false);
});

t('every TX choice has a label', () => {
    assert.deepStrictEqual(rc.TX_LED_SOURCES.map((o) => o.value), ['off', 'mapping', 'squelch', 'recording']);
    for (const o of rc.TX_LED_SOURCES) assert.ok(o.label && o.label !== o.value);
});

t('LED settings saved before a setting existed get its default', () => {
    const state = withStorage({ surface: 'rc28', rc28: { mappings: {}, leds: { tx: 'recording', follow: false } } },
        () => rc.loadState());
    assert.deepStrictEqual(state.rc28.leds, { ...rc.DEFAULT_LEDS, tx: 'recording', follow: false });
});

t('a saved state from before the LEDs had settings gets the defaults', () => {
    const state = withStorage({ surface: 'rc28', rc28: { mappings: {} } }, () => rc.loadState());
    assert.deepStrictEqual(state.rc28.leds, rc.DEFAULT_LEDS);
});

// --- the driver, showing them -----------------------------------------------

at('an indicator lights its LED beside Link', async () => {
    const { dev, rc28 } = await connected();
    rc28.setIndicators({ f1: true });
    assert.deepStrictEqual(leds(dev), [0x07, 0x05]);
    rc28.setIndicators({ ptt: true });
    assert.strictEqual(leds(dev).at(-1), 0x04, 'Link, F1 and TX');
});

at('an LED that would not change is not written again', async () => {
    // ControlWatch sets them four times a second; the dial is not told so.
    const { dev, rc28 } = await connected();
    for (let i = 0; i < 10; i++) rc28.setIndicators({ link: true, ptt: false, f1: true, f2: false });
    assert.deepStrictEqual(leds(dev), [0x07, 0x05]);
});

at('a hold flips a lit LED dark, and release brings it back', async () => {
    const { dev, clock, rc28, inputs } = await connected();
    rc28.setIndicators({ f1: true });
    dev.fire(report({ buttons: F1 }));
    clock.advance(HOLD_MS);
    assert.strictEqual(leds(dev).at(-1), 0x07, 'F1 dark while held past the threshold');
    dev.fire(report({ buttons: IDLE }));
    assert.strictEqual(leds(dev).at(-1), 0x05, 'and lit again');
    assert.deepStrictEqual(keys(inputs), ['f1_hold']);
});

at('hold feedback switched off leaves the LED alone', async () => {
    const { dev, clock, rc28, inputs } = await connected();
    rc28.setHoldFeedback(false);
    dev.fire(report({ buttons: F2 }));
    clock.advance(HOLD_MS * 2);
    dev.fire(report({ buttons: IDLE }));
    assert.deepStrictEqual(leds(dev), [0x07]);
    assert.deepStrictEqual(keys(inputs), ['f2_hold'], 'the hold itself still happens');
});

at('a blinking Link goes on and off every half-second', async () => {
    const { dev, clock, rc28 } = await connected();
    rc28.setIndicators({ link: 'blink' });
    assert.deepStrictEqual(leds(dev), [0x07], 'starts on — the phase it was already in');
    clock.advance(rc.BLINK_MS);
    clock.advance(rc.BLINK_MS);
    clock.advance(rc.BLINK_MS);
    assert.deepStrictEqual(leds(dev), [0x07, 0x0F, 0x07, 0x0F]);
});

at('a blinking Link set steady stops blinking and stays lit', async () => {
    const { dev, clock, rc28 } = await connected();
    rc28.setIndicators({ link: 'blink' });
    clock.advance(rc.BLINK_MS);                 // dark phase
    rc28.setIndicators({ link: true });
    assert.strictEqual(leds(dev).at(-1), 0x07, 'lit at once, not on the next phase');
    assert.strictEqual(clock.pending(), 0, 'no timer left running');
});

at('the other LEDs keep their state while Link blinks', async () => {
    const { dev, clock, rc28 } = await connected();
    rc28.setIndicators({ link: 'blink', f2: true });
    clock.advance(rc.BLINK_MS);
    assert.strictEqual(leds(dev).at(-1), 0x0B, 'F2 lit, Link dark');
});

at('disconnecting stops the blink and darkens everything', async () => {
    const { dev, clock, rc28 } = await connected();
    rc28.setIndicators({ link: 'blink', f1: true });
    await rc28.disconnect();
    assert.strictEqual(leds(dev).at(-1), 0x0F);
    assert.strictEqual(clock.pending(), 0);
    const n = dev.sent.length;
    clock.advance(rc.BLINK_MS * 4);
    assert.strictEqual(dev.sent.length, n, 'nothing written after letting go');
});

at('indicators set before connecting are shown on connect', async () => {
    const dev = fakeDevice();
    fakeHid({ chosen: [dev] });
    const rc28 = new RC28Control(fakeClock());
    rc28.setIndicators({ f2: true });
    assert.deepStrictEqual(dev.sent, [], 'nothing to write to yet');
    await rc28.connect();
    await Promise.resolve();
    assert.deepStrictEqual(leds(dev), [0x03]);
});

at('a reconnect writes the LEDs again even if they have not changed', async () => {
    // The dial lost power with the cable; what it showed before is gone.
    const { dev, hid, rc28 } = await connected();
    hid.fire('disconnect', dev);
    await rc28.connect();
    await Promise.resolve();
    assert.deepStrictEqual(leds(dev), [0x07, 0x07]);
});

// The asynchronous ones last, so the synchronous output above stays in order.
(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} RC-28 tests passed`);
})();
