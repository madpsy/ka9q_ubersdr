// ELAD TM-2: the HID reports, the LCD frame, what the display shows, the knob
// pages, tap and hold, and the surface plumbing.
//
// The reference is github.com/microenh/Tmate2_C, which drives a real unit.
// tm2.tmate2c.json is that project's own code run (tm2ref/tm2gen.c says how):
// frames its display functions built and input reports its read_bitfield laid
// out. The tests below hold tm2frame.js and the driver to those bytes, so a
// field off by one bit fails here rather than lighting the wrong segment on
// somebody's desk.
//
// What can go wrong silently is what is pinned: a knob that turns the receiver
// the wrong way, a button bit read as another, a frame resent forever, a page
// that will not change, a popup that never leaves.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tm = require('./.build/tm2.cjs');
const snapshots = require('./.build/bridgesnapshots.cjs');

const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'tm2.tmate2c.json'), 'utf8'));
const {
    frame: F, display: D, parseInput, encoderDelta, takeSteps, TM2Control, TM2_KEYS, TM2_DEFAULT_MAPPINGS,
    TM2_VENDOR_ID, TM2_PRODUCT_ID, HOLD_MS, FLUSH_MS, POPUP_MS, ANSWER_MS, REFRESH_MS, tm2KeyLabel,
} = tm;

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

const hex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
const fromHex = (s) => s.split(' ').map((h) => parseInt(h, 16));
const ref = (name) => {
    const v = REF.outputs.find((o) => o.name === name);
    if (!v) throw new Error(`no reference frame "${name}"`);
    return v.hex;
};
// Tmate2_C writes 44 bytes: the frame without its unsent trans_time.
const wire = (f) => hex(f.subarray(0, 44));
const built = (fn) => { const f = F.newFrame(); fn(f); return f; };

// --- the frame, against Tmate2_C ----------------------------------------------

t('every reference frame is one this module can name', () => {
    assert.ok(REF.outputs.length >= 20, 'the fixture has been generated');
});

t('a blank frame is all zeros, as Tmate2_C starts', () => {
    assert.strictEqual(wire(F.newFrame()), ref('blank'));
});

t('init_tmate2()’s first frame, byte for byte', () => {
    const f = built((x) => {
        F.setRgb(x, 0xff, 0xff, 0xff);
        F.displayMainNumber(x, 0);
        // 1000 is what it asks for; a byte holds 232, which is what it sends.
        F.encoderSetup(x, 1, 100, 1000, 32, 64, 10);
        F.setField(x, 'hz', 1);
    });
    assert.strictEqual(wire(f), ref('init'));
});

for (const n of [7074000, 14074000, 29999999, 198000, 500, -1234]) {
    t(`display_main_number(${n})`, () => {
        assert.strictEqual(wire(built((x) => F.displayMainNumber(x, n))), ref(`main ${n}`));
    });
}

t('past nine digits the main display blanks, as Tmate2_C does', () => {
    assert.strictEqual(wire(built((x) => F.displayMainNumber(x, 1000000000))), ref('main blank'));
});

t('exactly 1 MHz keeps its MHz dot (Tmate2_C’s “over” would drop it)', () => {
    const f = built((x) => F.displayMainNumber(x, 1000000));
    assert.strictEqual(F.getField(f, 'dot1'), 1);
    assert.strictEqual(F.getField(f, 'dot2'), 1);
});

for (const n of [-107, 42, 5]) {
    t(`display_smeter_number(${n})`, () => {
        assert.strictEqual(wire(built((x) => F.displaySmeterNumber(x, n))), ref(`smeter ${n}`));
    });
}

t('1000 blanks the S-meter digits, as Tmate2_C uses it', () => {
    assert.strictEqual(wire(built((x) => F.displaySmeterNumber(x, 1000))), ref('smeter blank'));
});

for (const s of ['VOL   100', 'STEP 1K', 'HI  -2700', 'ABCDEFGHI', 'JKLMNOPQR', 'STUVWXYZ0']) {
    t(`text “${s}” through Tmate2_C’s font table`, () => {
        assert.strictEqual(wire(built((x) => F.displayMainText(x, s))), ref(`text ${s}`));
    });
}

t('set_smeter_graph and set_smeter_s, both ways', () => {
    assert.strictEqual(wire(built((x) => F.setSmeterGraph(x, true))), ref('smeter graph'));
    assert.strictEqual(wire(built((x) => F.setSmeterS(x, true))), ref('smeter s on'));
    assert.strictEqual(wire(built((x) => F.setSmeterS(x, false))), ref('smeter s off'));
});

t('backlight, contrast, encoder speeds, click and both LEDs sit where Tmate2_C puts them', () => {
    assert.strictEqual(wire(built((x) => { F.setRgb(x, 0x12, 0x34, 0x56); F.setField(x, 'contrast', 77); })),
        ref('rgb 123456 contrast 77'));
    assert.strictEqual(wire(built((x) => F.encoderSetup(x, 1, 2, 5, 32, 64, 10))), ref('encoder 1 2 5 32 64'));
    assert.strictEqual(wire(built((x) => F.setField(x, 'click', 1))), ref('click'));
    assert.strictEqual(wire(built((x) => F.setField(x, 'usb_led', 1))), ref('usb led'));
    assert.strictEqual(wire(built((x) => F.setField(x, 'lock_led', 1))), ref('lock led'));
});

t('the report sent is the frame after its report-ID byte, 43 bytes', () => {
    const f = built((x) => F.displayMainNumber(x, 7074000));
    const p = F.tm2Payload(f);
    assert.strictEqual(p.length, 43);
    assert.strictEqual(hex(p), ref('main 7074000').split(' ').slice(1).join(' '));
    assert.strictEqual(F.tm2Payload(f, 64).length, 64, 'padded to a longer declared report');
    assert.deepStrictEqual(Array.from(F.tm2Payload(f, 64).subarray(43)), new Array(21).fill(0));
});

t('the bar is fifteen segments, filled from the left', () => {
    const f = built((x) => F.setBars(x, 4));
    assert.deepStrictEqual(F.BAR_FIELDS.map((b) => F.getField(f, b)), [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.strictEqual(F.BAR_FIELDS.length, 15);
    F.setBars(f, 99);
    assert.ok(F.BAR_FIELDS.every((b) => F.getField(f, b) === 1), 'clamped, not wrapped');
});

t('an unknown field throws rather than writing nowhere', () => {
    assert.throws(() => F.setField(F.newFrame(), 'no_such_segment', 1));
});

// --- the input report, against Tmate2_C ---------------------------------------

const BUTTON_ORDER = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'main', 'e1', 'e2'];
const BUTTON_BIT = { f1: 0, f2: 1, f3: 2, f4: 3, f5: 4, f6: 5, main: 6, e2: 7, e1: 8 };

for (const v of REF.inputs) {
    t(`input “${v.name}” reads as Tmate2_C laid it out`, () => {
        const bytes = fromHex(v.hex);
        for (const [r, label] of [[parseInput(bytes, 0), 'unnumbered'], [parseInput(bytes.slice(1), 1), 'report ID 1']]) {
            assert.ok(r, label);
            assert.deepStrictEqual([r.main, r.e1, r.e2], [v.main, v.e1, v.e2], `${label}: encoder words`);
            const down = BUTTON_ORDER.map((name) => (((r.buttons >> BUTTON_BIT[name]) & 1) === 0 ? 1 : 0));
            assert.deepStrictEqual(down, v.pressed, `${label}: buttons, active low`);
        }
    });
}

t('anything that is not an input report is refused', () => {
    assert.strictEqual(parseInput(null), null);
    assert.strictEqual(parseInput([1, 2, 3]), null, 'short');
    assert.strictEqual(parseInput([2, 0, 0, 0, 0, 0, 0, 0xff, 1]), null, 'not the 0x01 report');
});

t('a 16-bit position wraps the short way round', () => {
    assert.strictEqual(encoderDelta(10, 13), 3);
    assert.strictEqual(encoderDelta(13, 10), -3);
    assert.strictEqual(encoderDelta(65535, 1), 2);
    assert.strictEqual(encoderDelta(1, 65535), -2);
    assert.strictEqual(encoderDelta(0, 0), 0);
});

t('counts become steps toward zero, the remainder carried', () => {
    assert.deepStrictEqual(takeSteps(7, 2), { steps: 3, carry: 1 });
    assert.deepStrictEqual(takeSteps(-7, 2), { steps: -3, carry: -1 });
    assert.deepStrictEqual(takeSteps(1, 2), { steps: 0, carry: 1 });
});

// --- stand-ins ------------------------------------------------------------------

function fakeDevice({ opens = true, fails = false, collections = [] } = {}) {
    const listeners = new Set();
    const dev = {
        vendorId: TM2_VENDOR_ID,
        productId: TM2_PRODUCT_ID,
        productName: 'TMate 2',
        collections,
        opened: false,
        closed: 0,
        sent: [],
        async open() {
            if (!opens) throw new Error('Failed to open the device.');
            dev.opened = true;
        },
        async close() { dev.opened = false; dev.closed += 1; },
        async sendReport(id, data) {
            if (fails) throw new Error('Failed to write the report.');
            dev.sent.push([id, Array.from(data)]);
        },
        addEventListener(type, fn) { if (type === 'inputreport') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'inputreport') listeners.delete(fn); },
        listening: () => listeners.size,
        fire(bytes, reportId = 0) {
            const data = new DataView(Uint8Array.from(bytes).buffer);
            for (const fn of Array.from(listeners)) fn({ reportId, data, device: dev });
        },
    };
    return dev;
}

function fakeHid({ granted = [], chosen = [] } = {}) {
    const listeners = { connect: new Set(), disconnect: new Set() };
    const hid = {
        requests: [],
        async getDevices() { return granted; },
        async requestDevice(opts) { hid.requests.push(opts); return chosen; },
        addEventListener(type, fn) { listeners[type].add(fn); },
        removeEventListener(type, fn) { listeners[type].delete(fn); },
        fire(type, device) { for (const fn of Array.from(listeners[type])) fn({ device }); },
    };
    globalThis.navigator = { hid };
    return hid;
}

function fakeClock() {
    let now = 1000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms }); return seq; },
        clearTimeout: (id) => { timers.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, tm2] of Array.from(timers)) {
                if (tm2.at <= now) { timers.delete(id); tm2.fn(); }
            }
        },
        skip(ms) { now += ms; },
    };
}

const settle = () => new Promise((r) => setImmediate(r));

// An input report the way the TM-2 sends it, through Tmate2_C's layout:
// pressed is a list of button names held down.
function report({ main = 1000, e1 = 2000, e2 = 3000, pressed = [] } = {}) {
    let buttons = 0x1FF;
    for (const name of pressed) buttons &= ~(1 << BUTTON_BIT[name]);
    return [1, main & 255, (main >> 8) & 255, e2 & 255, (e2 >> 8) & 255, e1 & 255, (e1 >> 8) & 255,
        buttons & 255, (buttons >> 8) & 1];
}

async function connected(opts = {}) {
    const dev = fakeDevice(opts.device);
    const hid = fakeHid({ chosen: [dev] });
    const clock = fakeClock();
    const tm2 = new TM2Control(clock);
    const inputs = [];
    const msgs = [];
    tm2.on('input', (e) => inputs.push(e));
    tm2.on('message', (m) => msgs.push(m));
    const ok = await tm2.connect();
    await settle();
    // The first report is where everything is, not a movement.
    if (ok && opts.baseline !== false) dev.fire(report());
    return { dev, hid, clock, tm2, inputs, msgs, ok };
}

const keys = (inputs) => inputs.map((e) => e.key);
// The frame last written, back in Tmate2_C's 44-byte shape.
const lastFrame = (dev) => {
    const [, bytes] = dev.sent[dev.sent.length - 1];
    return Uint8Array.from([0, ...bytes.slice(0, 43), 0]);
};
const shown = (dev, name) => F.getField(lastFrame(dev), name);

const RX = {
    frequency: 7074000, mode: 'usb', stepHz: 1000, dbfs: -73, snr: 20, audioUp: true,
    squelchOn: false, squelchOpen: false, squelchDb: null, muted: false, volume: 0.45, locked: false,
    bwLow: 50, bwHigh: 2700, vfo: 'A', dspEnabled: false,
};

// --- connecting -------------------------------------------------------------------

at('the chooser is filtered to the TM-2', async () => {
    const { hid, ok } = await connected();
    assert.ok(ok);
    assert.deepStrictEqual(hid.requests, [{ filters: [{ vendorId: 0x1721, productId: 0x0614 }] }]);
});

at('connecting writes a frame at once, unnumbered and 43 bytes, as Tmate2_C does', async () => {
    const { dev } = await connected();
    assert.ok(dev.sent.length >= 1);
    const [id, bytes] = dev.sent[0];
    assert.strictEqual(id, 0);
    assert.strictEqual(bytes.length, 43);
});

at('a descriptor declaring a numbered, longer output report is followed', async () => {
    const collections = [{ outputReports: [{ reportId: 3, items: [{ reportSize: 8, reportCount: 64 }] }] }];
    const { dev } = await connected({ device: { collections } });
    assert.strictEqual(dev.sent[0][0], 3);
    assert.strictEqual(dev.sent[0][1].length, 64);
});

at('a TM-2 that sends nothing is reported, one that does is not', async () => {
    const quiet = await connected({ baseline: false });
    quiet.clock.advance(ANSWER_MS);
    assert.ok(quiet.msgs.some((m) => m.tone === 'warn' && /sends nothing/.test(m.text)));
    const live = await connected();
    live.clock.advance(ANSWER_MS);
    assert.ok(!live.msgs.some((m) => /sends nothing/.test(m.text)));
});

at('auto-connect takes only a TM-2 already granted, and quietly', async () => {
    const other = { ...fakeDevice(), vendorId: 0x0C26, productId: 0x001E };
    fakeHid({ granted: [other] });
    const tm2 = new TM2Control(fakeClock());
    assert.strictEqual(await tm2.autoConnect(), false);
    const dev = fakeDevice();
    fakeHid({ granted: [other, dev] });
    assert.strictEqual(await tm2.autoConnect(), true);
    assert.strictEqual(tm2.device, dev);
});

at('disconnecting blanks the display and LEDs, sent twice, then closes', async () => {
    const { dev, tm2 } = await connected();
    tm2.setReceiver({ ...RX, locked: true });
    await settle();
    await tm2.disconnect();
    const last2 = dev.sent.slice(-2).map(([, b]) => b);
    assert.deepStrictEqual(last2[0], new Array(43).fill(0));
    assert.deepStrictEqual(last2[1], new Array(43).fill(0), 'twice, as close_tmate2() needs');
    assert.strictEqual(dev.closed, 1);
    assert.strictEqual(tm2.connected, false);
});

at('an unplugged TM-2 says so and stops listening', async () => {
    const { dev, hid, tm2, msgs } = await connected();
    hid.fire('disconnect', dev);
    assert.strictEqual(tm2.connected, false);
    assert.strictEqual(dev.listening(), 0);
    assert.ok(msgs.some((m) => m.text === 'TM-2 disconnected'));
});

// --- the knobs ----------------------------------------------------------------------

at('the first report moves nothing, however far the knobs are from zero', async () => {
    const { clock, inputs } = await connected();
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs, []);
});

at('the main knob counting down is clockwise — tuning up', async () => {
    // Tmate2_C's readme: the main encoder counts up anticlockwise.
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ main: 997 }));
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs, [{ key: 'main_up', event: { kind: 'relative', delta: 3 } }]);
    dev.fire(report({ main: 999 }));
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs[1], { key: 'main_down', event: { kind: 'relative', delta: -2 } });
});

at('a burst of reports is summed into one step event, none lost', async () => {
    const { dev, clock, inputs } = await connected();
    for (let p = 999; p >= 990; p -= 1) dev.fire(report({ main: p }));
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(keys(inputs), ['main_up']);
    assert.strictEqual(inputs[0].event.delta, 10);
});

at('the main knob across the 16-bit wrap keeps its direction', async () => {
    const { dev, clock, inputs } = await connected({ baseline: false });
    dev.fire(report({ main: 1 }));
    dev.fire(report({ main: 65534 }));     // three counts down through zero
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs, [{ key: 'main_up', event: { kind: 'relative', delta: 3 } }]);
});

at('E1 and E2 count up clockwise, each under the page it is on', async () => {
    const { dev, clock, inputs, tm2 } = await connected();
    assert.deepStrictEqual(tm2.pages, { e1: 'vol', e2: 'high' });
    dev.fire(report({ e1: 2002 }));
    dev.fire(report({ e1: 2002, e2: 2999 }));
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs.map((e) => [e.key, e.event.delta]),
        [['e1_vol_up', 1], ['e1_vol_up', 1], ['e2_high_down', -1]]);
});

at('a quick small-knob turn is a detent an event, so “Volume up” moves once a click', async () => {
    // Summed into one event of three, a fixed-step function would move once.
    const { dev, clock, inputs } = await connected();
    dev.fire(report({ e1: 2003, main: 990 }));
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs.map((e) => [e.key, e.event.delta]),
        [['main_up', 10], ['e1_vol_up', 1], ['e1_vol_up', 1], ['e1_vol_up', 1]],
        'the main knob stays summed — its tuning functions use the count');
});

at('a knob turned while Disconnect is blanking the display reaches nothing', async () => {
    const { dev, clock, tm2, inputs } = await connected();
    const done = tm2.disconnect();
    dev.fire(report({ main: 900, e1: 2005 }));
    dev.fire(report({ main: 900, e1: 2005, pressed: ['f1'] }));
    clock.advance(HOLD_MS + FLUSH_MS);
    await done;
    clock.advance(HOLD_MS + FLUSH_MS);
    assert.deepStrictEqual(inputs, []);
});

at('a write that fails, recovers and fails again is reported both times', async () => {
    const ctx = await connected();
    let failing = true;
    ctx.dev.sendReport = async (id, data) => {
        if (failing) throw new Error('Failed to write the report.');
        ctx.dev.sent.push([id, Array.from(data)]);
    };
    const said = () => ctx.msgs.filter((m) => /Could not write/.test(m.text)).length;
    ctx.tm2.setReceiver({ ...RX, frequency: 1 });
    await settle();
    ctx.tm2.setReceiver({ ...RX, frequency: 2 });
    await settle();
    assert.strictEqual(said(), 1, 'once while it keeps failing');
    failing = false;
    ctx.tm2.setReceiver({ ...RX, frequency: 3 });
    await settle();
    failing = true;
    ctx.tm2.setReceiver({ ...RX, frequency: 4 });
    await settle();
    assert.strictEqual(said(), 2);
});

at('closing the tab blanks the console; after Disconnect it no longer listens', async () => {
    const handlers = {};
    globalThis.window = {
        addEventListener: (type, fn) => { handlers[type] = fn; },
        removeEventListener: (type, fn) => { if (handlers[type] === fn) delete handlers[type]; },
    };
    try {
        const { dev, tm2 } = await connected();
        tm2.setReceiver(RX);
        await settle();
        assert.ok(handlers.pagehide, 'listening for the tab going away');
        handlers.pagehide();
        await settle();
        assert.deepStrictEqual(dev.sent[dev.sent.length - 1][1], new Array(43).fill(0));
        await tm2.disconnect();
        assert.strictEqual(handlers.pagehide, undefined);
    } finally {
        delete globalThis.window;
    }
});

at('a repeated identical report does nothing', async () => {
    const { dev, clock, inputs } = await connected();
    for (let i = 0; i < 50; i += 1) dev.fire(report());
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(inputs, []);
});

// --- buttons ----------------------------------------------------------------------

async function press(ctx, name, ms) {
    ctx.dev.fire(report({ pressed: [name] }));
    ctx.clock.advance(ms);
    ctx.dev.fire(report());
    await settle();
}

at('a short press of a key is its tap, a long one its hold', async () => {
    const ctx = await connected();
    await press(ctx, 'f3', 100);
    await press(ctx, 'f4', HOLD_MS + 50);
    await press(ctx, 'main', 100);
    assert.deepStrictEqual(keys(ctx.inputs), ['f3_tap', 'f4_hold', 'main_tap']);
    assert.ok(ctx.inputs.every((e) => e.event.kind === 'trigger'));
});

at('a hold is measured, so a page too busy to run the timer still counts it', async () => {
    const ctx = await connected();
    ctx.dev.fire(report({ pressed: ['f6'] }));
    ctx.clock.skip(HOLD_MS + 100);
    ctx.dev.fire(report());
    assert.deepStrictEqual(keys(ctx.inputs), ['f6_hold']);
});

at('a button already down when the TM-2 is opened is not a press', async () => {
    const ctx = await connected({ baseline: false });
    ctx.dev.fire(report({ pressed: ['f1'] }));
    ctx.dev.fire(report());
    assert.deepStrictEqual(ctx.inputs, []);
});

at('the TM-2 clicks the moment a press becomes a hold', async () => {
    const ctx = await connected();
    ctx.tm2.setReceiver(RX);
    await settle();
    const before = shown(ctx.dev, 'click');
    ctx.dev.fire(report({ pressed: ['f2'] }));
    ctx.clock.advance(HOLD_MS);
    await settle();
    assert.notStrictEqual(shown(ctx.dev, 'click'), before, 'the click bit changed');
    ctx.tm2.setSettings({ clickOnHold: false });
    await settle();
    const after = shown(ctx.dev, 'click');
    ctx.dev.fire(report());
    ctx.dev.fire(report({ pressed: ['f2'] }));
    ctx.clock.advance(HOLD_MS);
    await settle();
    assert.strictEqual(shown(ctx.dev, 'click'), after, 'and not when that is turned off');
});

at('tapping E1 or E2 steps its page and sends nothing to the mapping', async () => {
    const ctx = await connected();
    await press(ctx, 'e1', 100);
    assert.deepStrictEqual(ctx.tm2.pages, { e1: 'sql', e2: 'high' });
    await press(ctx, 'e2', 100);
    await press(ctx, 'e2', 100);
    assert.deepStrictEqual(ctx.tm2.pages, { e1: 'sql', e2: 'shift' });
    assert.deepStrictEqual(ctx.inputs, []);
    await press(ctx, 'e1', 100);
    await press(ctx, 'e1', 100);
    assert.strictEqual(ctx.tm2.pages.e1, 'vol', 'round and back to the start');
    ctx.dev.fire(report({ e1: 2001 }));
    ctx.clock.advance(FLUSH_MS);
    assert.deepStrictEqual(keys(ctx.inputs), ['e1_vol_up']);
});

at('holding E1 or E2 is a mappable hold, not a page step', async () => {
    const ctx = await connected();
    await press(ctx, 'e1', HOLD_MS + 10);
    await press(ctx, 'e2', HOLD_MS + 10);
    assert.deepStrictEqual(keys(ctx.inputs), ['e1_hold', 'e2_hold']);
    assert.deepStrictEqual(ctx.tm2.pages, { e1: 'vol', e2: 'high' });
});

// --- what the display shows ---------------------------------------------------------

at('the display shows the receiver it is given', async () => {
    const { dev, tm2 } = await connected();
    tm2.setReceiver(RX);
    await settle();
    const want = built((x) => F.displayMainNumber(x, 7074000));
    for (let p = 1; p <= 9; p += 1) {
        for (const side of ['l', 'r']) {
            assert.strictEqual(shown(dev, `main_${p}${side}`), F.getField(want, `main_${p}${side}`), `digit ${p}`);
        }
    }
    assert.strictEqual(shown(dev, 'usb'), 1);
    assert.strictEqual(shown(dev, 'underline_4'), 1, '1 kHz step');
    assert.strictEqual(shown(dev, 'hz'), 1);
    assert.strictEqual(shown(dev, 'e1'), 1);
    assert.strictEqual(shown(dev, 'vol'), 1);
    assert.strictEqual(shown(dev, 'high'), 1);
});

at('only a changed frame is written, and the whole frame again after a quiet second', async () => {
    const { dev, tm2, clock } = await connected();
    tm2.setReceiver(RX);
    await settle();
    const n = dev.sent.length;
    tm2.setReceiver({ ...RX });
    tm2.setReceiver({ ...RX });
    await settle();
    assert.strictEqual(dev.sent.length, n, 'nothing new to say');
    tm2.setReceiver({ ...RX, frequency: 7074100 });
    await settle();
    assert.strictEqual(dev.sent.length, n + 1);
    clock.skip(REFRESH_MS);
    tm2.setReceiver({ ...RX, frequency: 7074100 });
    await settle();
    assert.strictEqual(dev.sent.length, n + 2, 'refreshed');
});

at('turning a small knob shows its value over the frequency, then lets it go', async () => {
    const ctx = await connected();
    ctx.tm2.setReceiver(RX);
    ctx.dev.fire(report({ e1: 2001 }));
    ctx.clock.advance(FLUSH_MS);
    await settle();
    const text = built((x) => F.displayMainText(x, 'VOL    45'));
    assert.strictEqual(shown(ctx.dev, 'main_1l'), F.getField(text, 'main_1l'));
    assert.strictEqual(shown(ctx.dev, 'main_9l'), F.getField(text, 'main_9l'));
    assert.strictEqual(shown(ctx.dev, 'hz'), 0, 'not a frequency while it shows');
    ctx.clock.advance(POPUP_MS);
    await settle();
    assert.strictEqual(shown(ctx.dev, 'hz'), 1, 'the frequency is back');
});

at('changing the step, mute or lock elsewhere pops up on the display too', async () => {
    const ctx = await connected();
    ctx.tm2.setReceiver(RX);
    ctx.tm2.setReceiver({ ...RX, stepHz: 500 });
    await settle();
    assert.strictEqual(shown(ctx.dev, 'hz'), 0);
    const text = built((x) => F.displayMainText(x, D.popupText('step', { stepHz: 500 })));
    assert.strictEqual(shown(ctx.dev, 'main_9l'), F.getField(text, 'main_9l'));
});

// --- the display rules, without a device --------------------------------------------

const render = (rx, settings, ui) => D.renderTm2({ rx: { ...RX, ...rx }, settings, ui });
const on = (f, name) => F.getField(f, name);

t('each mode lights its own annunciators and no others', () => {
    const want = {
        usb: ['usb'], lsb: ['lsb'], am: ['am'], sam: ['sam'], nfm: ['fm'], fm: ['fm', 'w_fm'],
        cwu: ['cw', 'cw_plus'], cwl: ['cw', 'cw_minus'], iq: [],
    };
    const all = ['lsb', 'usb', 'am', 'sam', 'dsb', 'fm', 'w_fm', 'cw', 'cw_minus', 'cw_plus', 'drm', 'dig', 'stereo'];
    for (const [mode, lit] of Object.entries(want)) {
        const f = render({ mode });
        assert.deepStrictEqual(all.filter((a) => on(f, a)), lit, mode);
    }
});

t('the underline sits under the digit the step moves', () => {
    const want = { 1: 1, 10: 2, 100: 3, 500: 3, 1000: 4, 5000: 4, 9000: 4, 10000: 5, 100000: 6 };
    for (const [step, digit] of Object.entries(want)) {
        assert.strictEqual(D.stepDigit(Number(step)), digit, `${step} Hz`);
        const f = render({ stepHz: Number(step) });
        const lit = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => on(f, `underline_${d}`));
        assert.deepStrictEqual(lit, [digit], `${step} Hz underlines one digit`);
    }
    assert.strictEqual(D.stepDigit(0), 0);
});

t('the S-meter bar is v2’s S-units, a segment each', () => {
    const bars = (f) => F.BAR_FIELDS.filter((b) => on(f, b)).length;
    assert.strictEqual(bars(render({ dbfs: -121 })), 1, 'S1');
    assert.strictEqual(bars(render({ dbfs: -73 })), 9, 'S9');
    assert.strictEqual(bars(render({ dbfs: -100 })), 4, 'S4.5 lights S4 — a segment only once it is reached');
    assert.strictEqual(bars(render({ dbfs: -53 })), 11, 'S9+20');
    assert.strictEqual(bars(render({ dbfs: -13 })), 15, 'S9+60');
    assert.strictEqual(bars(render({ dbfs: 0 })), 15, 'past the top stays full');
    assert.strictEqual(bars(render({ dbfs: -140 })), 0, 'below S1');
    assert.strictEqual(bars(render({ dbfs: null })), 0, 'no reading yet');
    assert.strictEqual(bars(render({ dbfs: -73, audioUp: false })), 0, 'receiver down');
    const f = render({});
    for (const label of ['smeter_line', 's', 'smeter_1', 'smeter_9', 'smeter_plus20', 'smeter_plus60']) {
        assert.strictEqual(on(f, label), 1, label);
    }
    assert.strictEqual(on(f, 'w'), 0, 'S-units, not watts');
});

t('beside the meter: the level as dBm by default, or dBFS, SNR, or nothing', () => {
    const digits = (f) => [1, 2, 3].map((p) => `${on(f, `smeter_${p}l`)}/${on(f, `smeter_${p}r`)}`).join(' ');
    const shows = (n) => digits(built((x) => F.displaySmeterNumber(x, n)));
    let f = render({ dbfs: -107 });
    assert.strictEqual(digits(f), shows(-107));
    assert.strictEqual(on(f, 'smeter_db_minus'), 1);
    assert.strictEqual(on(f, 'dbm'), 1);
    f = render({ dbfs: -107 }, { readout: 'dbfs' });
    assert.strictEqual(digits(f), shows(-107));
    assert.strictEqual(on(f, 'dbm'), 0, 'no dBm claim');
    f = render({ snr: 23 }, { readout: 'snr' });
    assert.strictEqual(digits(f), shows(23));
    assert.strictEqual(on(f, 'smeter_db_minus'), 0);
    f = render({}, { readout: 'off' });
    assert.strictEqual(digits(f), shows(1000));
    assert.strictEqual(on(f, 'dbm'), 0);
    assert.strictEqual(digits(render({ dbfs: null })), shows(1000), 'blank before a reading');
    // v2's "no reading" sentinel is not a signal of -999 dBm.
    f = render({ dbfs: -999 });
    assert.strictEqual(digits(f), shows(1000));
    assert.strictEqual(on(f, 'dbm'), 0);
    assert.strictEqual(F.BAR_FIELDS.filter((b) => on(f, b)).length, 0);
});

t('RX is lit while audio is getting through', () => {
    assert.strictEqual(on(render({}), 'rx'), 1);
    assert.strictEqual(on(render({ squelchOn: true, squelchOpen: false }), 'rx'), 0, 'squelched');
    assert.strictEqual(on(render({ squelchOn: true, squelchOpen: true }), 'rx'), 1, 'signal through the squelch');
    assert.strictEqual(on(render({ audioUp: false }), 'rx'), 0, 'receiver down');
    assert.strictEqual(on(render({}), 'tx'), 0, 'never TX — a receiver');
});

t('the LEDs: green while working (blinking when the receiver is down), red with the lock', () => {
    assert.strictEqual(on(render({}), 'usb_led'), 1);
    assert.strictEqual(on(render({}), 'lock_led'), 0);
    assert.strictEqual(on(render({ locked: true }), 'lock_led'), 1);
    assert.strictEqual(on(render({ audioUp: false }, {}, { blinkOn: true }), 'usb_led'), 1);
    assert.strictEqual(on(render({ audioUp: false }, {}, { blinkOn: false }), 'usb_led'), 0);
    assert.strictEqual(on(render({ audioUp: false }, { blinkWhenDown: false }, { blinkOn: false }), 'usb_led'), 1);
    assert.strictEqual(on(render({ audioUp: false }), 'err'), 1);
    assert.strictEqual(on(render({}), 'err'), 0);
});

t('VFO A or B, and VFO alone for C and D', () => {
    const vfo = (v) => ['vfo', 'a', 'b'].filter((x) => on(render({ vfo: v }), x));
    assert.deepStrictEqual(vfo('A'), ['vfo', 'a']);
    assert.deepStrictEqual(vfo('B'), ['vfo', 'b']);
    assert.deepStrictEqual(vfo('C'), ['vfo']);
    assert.deepStrictEqual(vfo(undefined), []);
});

t('each small knob’s page lights its label, one at a time', () => {
    const labels = ['vol', 'sql', 'nr', 'high', 'low', 'shift'];
    for (const e1Page of D.E1_PAGES) {
        for (const e2Page of D.E2_PAGES) {
            const f = render({}, {}, { e1Page, e2Page });
            assert.deepStrictEqual(labels.filter((l) => on(f, l)), [e1Page, e2Page]);
        }
    }
});

t('muted, the VOL label blinks', () => {
    assert.strictEqual(on(render({ muted: true }, {}, { e1Page: 'vol', blinkOn: false }), 'vol'), 0);
    assert.strictEqual(on(render({ muted: true }, {}, { e1Page: 'vol', blinkOn: true }), 'vol'), 1);
    assert.strictEqual(on(render({}, {}, { e1Page: 'vol', blinkOn: false }), 'vol'), 1, 'not while unmuted');
});

t('popups say what a knob is set to in nine characters', () => {
    const cases = [
        ['vol', {}, 'VOL    45'],
        ['vol', { muted: true }, 'VOL  MUTE'],
        ['sql', {}, 'SQL   OFF'],
        ['sql', { squelchOn: true, squelchDb: 12 }, 'SQL    12'],
        ['nr', {}, 'NR    OFF'],
        ['nr', { dspEnabled: true }, 'NR     ON'],
        ['nr', { dspEnabled: true, dspFilter: 'rnnoise' }, 'NR RNNOIS'],
        ['nr', { dspEnabled: true, dspFilter: 'nr_2' }, 'NR    NR2'],
        ['high', {}, 'HI   2700'],
        ['low', { bwLow: -2700 }, 'LO  -2700'],
        ['shift', {}, 'SH     50'],
        ['step', { stepHz: 1000 }, 'STEP   1K'],
        ['step', { stepHz: 500 }, 'STEP  500'],
        ['step', { stepHz: 100000 }, 'STEP 100K'],
        ['lock', { locked: true }, 'LOCKED'],
    ];
    for (const [kind, rx, want] of cases) {
        const got = D.popupText(kind, { ...RX, ...rx });
        assert.strictEqual(got, want, kind);
        assert.ok(got.length <= 9, `${kind} fits`);
    }
});

t('a popup replaces the frequency, its dots and its unit', () => {
    const f = render({}, {}, { popup: 'vol' });
    assert.strictEqual(on(f, 'dot1'), 0);
    assert.strictEqual(on(f, 'dot2'), 0);
    assert.strictEqual(on(f, 'hz'), 0);
    assert.ok([1, 2, 3, 4, 5, 6, 7, 8, 9].every((d) => !on(f, `underline_${d}`)));
});

t('the changes worth a popup, and the ones that are not', () => {
    assert.strictEqual(D.changePopup(null, RX), null, 'not on the first snapshot');
    assert.strictEqual(D.changePopup(RX, { ...RX, stepHz: 100 }), 'step');
    assert.strictEqual(D.changePopup(RX, { ...RX, muted: true }), 'mute');
    assert.strictEqual(D.changePopup(RX, { ...RX, locked: true }), 'lock');
    assert.strictEqual(D.changePopup(RX, { ...RX, dspEnabled: true }), 'nr');
    const nr = { ...RX, dspEnabled: true, dspFilter: 'a' };
    assert.strictEqual(D.changePopup(nr, { ...nr, dspFilter: 'b' }), 'nr', 'another filter');
    assert.strictEqual(D.changePopup({ ...RX, dspFilter: 'a' }, { ...RX, dspFilter: 'b' }), null, 'not while NR is off');
    assert.strictEqual(D.changePopup(RX, { ...RX, frequency: 14074000, mode: 'lsb', dbfs: -50 }), null);
});

t('backlight: the chosen colour, dimmed while the receiver is down, or the meter’s colour', () => {
    const rgb = (f) => [on(f, 'rgb_red'), on(f, 'rgb_green'), on(f, 'rgb_blue')];
    assert.deepStrictEqual(rgb(render({}, { backlight: '#40a0ff' })), [0x40, 0xa0, 0xff]);
    assert.deepStrictEqual(rgb(render({ audioUp: false }, { backlight: '#40a0ff' })), [16, 40, 64]);
    assert.deepStrictEqual(rgb(render({ audioUp: false }, { backlight: '#40a0ff', dimWhenDown: false })), [0x40, 0xa0, 0xff]);
    const s9 = rgb(render({ dbfs: -73 }, { meterColour: true }));
    assert.ok(s9[1] > s9[0] && s9[1] > s9[2], `S9 is green: ${s9}`);
    const s1 = rgb(render({ dbfs: -121 }, { meterColour: true }));
    assert.ok(s1[0] > s1[1] && s1[0] > s1[2], `S1 is red: ${s1}`);
});

t('contrast and acceleration go out as set', () => {
    const f = render({}, { contrast: 90, accel: 'strong' });
    assert.strictEqual(on(f, 'contrast'), 90);
    assert.deepStrictEqual(['encoder_speed1', 'encoder_speed2', 'encoder_speed3', 'encoder_trans12', 'encoder_trans23']
        .map((n) => on(f, n)), [...D.ACCEL.strong, 32, 64]);
    const off = render({}, { accel: 'off' });
    assert.deepStrictEqual(['encoder_speed1', 'encoder_speed2', 'encoder_speed3'].map((n) => on(off, n)), [1, 1, 1]);
});

t('settings are repaired, never trusted', () => {
    assert.deepStrictEqual(D.tm2Settings(null), D.DEFAULT_TM2_DISPLAY);
    const s = D.tm2Settings({ backlight: 'red', contrast: 999, readout: 'volts', accel: 'warp', meterColour: 1 });
    assert.strictEqual(s.backlight, D.DEFAULT_TM2_DISPLAY.backlight);
    assert.strictEqual(s.contrast, 255);
    assert.strictEqual(s.readout, 'dbm');
    assert.strictEqual(s.accel, 'mild');
    assert.strictEqual(s.meterColour, true);
    assert.strictEqual(D.tm2Settings({ contrast: -5 }).contrast, 0);
});

t('no frequency yet: a blank display, not a zero', () => {
    const f = render({ frequency: null });
    assert.ok([1, 2, 3, 4, 5, 6, 7, 8, 9].every((p) => !on(f, `main_${p}l`) && !on(f, `main_${p}r`)));
});

// --- the surface ----------------------------------------------------------------------

t('every TM-2 key has a label, and every mapped key is a key', () => {
    for (const { key } of TM2_KEYS) assert.notStrictEqual(tm2KeyLabel(key), key, key);
    const known = new Set(TM2_KEYS.map((k) => k.key));
    for (const key of Object.keys(TM2_DEFAULT_MAPPINGS)) assert.ok(known.has(key), key);
    assert.strictEqual(tm.surfaceKeyLabel('tm2')('e1_sql_up'), 'E1 (SQL) — clockwise');
});

t('every knob and button arrives mapped', () => {
    for (const { key } of TM2_KEYS) assert.ok(TM2_DEFAULT_MAPPINGS[key], `${key} is unmapped`);
});

t('every default is a function this build has, and takes what that control sends', () => {
    const schemas = [{ name: 'rnnoise' }];
    for (const [key, m] of Object.entries(TM2_DEFAULT_MAPPINGS)) {
        const fn = tm.findFunction(m.function, schemas);
        assert.ok(fn, `${key} → ${m.function} is not in the catalogue`);
        const kind = /_(up|down)$/.test(key) ? 'relative' : 'trigger';
        assert.ok(fn.accepts.includes(kind), `${key} sends ${kind}, which ${m.function} refuses`);
        assert.strictEqual(m.throttleMs, 0, `${key}: the driver paces itself`);
    }
});

t('the defaults follow ELAD’s own layout', () => {
    const fn = (k) => TM2_DEFAULT_MAPPINGS[k].function;
    assert.strictEqual(fn('main_up'), 'freq_rx_step');
    assert.strictEqual(fn('main_tap'), 'tune_lock_toggle', 'the push is the tuning lock, as the red LED says');
    assert.strictEqual(fn('e1_vol_up'), 'volume_up');
    assert.strictEqual(fn('e2_high_up'), 'bw_high');
    assert.strictEqual(fn('f3_tap'), 'mode_prev');
    assert.strictEqual(fn('f4_tap'), 'mode_next');
    assert.strictEqual(fn('f5_tap'), 'rx_step_prev');
    assert.strictEqual(fn('f6_tap'), 'rx_step_next');
});

t('the TM-2 is a mapped surface of this page’s own', () => {
    assert.ok(tm.SURFACES.includes('tm2'));
    assert.strictEqual(tm.isMappedSurface('tm2'), true);
    assert.ok(tm.getSurface('tm2') instanceof TM2Control);
    assert.strictEqual(tm.getSurface('tm2'), tm.getTm2(), 'one singleton');
    assert.deepStrictEqual(tm.DEFAULT_STATE.tm2.mappings, TM2_DEFAULT_MAPPINGS);
    assert.strictEqual(tm.DEFAULT_STATE.tm2.autoConnect, false, 'hardware binds itself only when asked');
});

t('the bridge does not mistake the TM-2 for an externally hosted surface', () => {
    const snap = snapshots.sdrControlSnapshot({ controlSettings: { surface: 'tm2' } });
    assert.strictEqual(snap.running, false);
    assert.deepStrictEqual(snap.config, {});
});

function withStorage(saved, fn) {
    const store = saved === undefined ? {} : { 'ubersdr.v2.radioControl': JSON.stringify(saved) };
    globalThis.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
    };
    try { return fn(); } finally { delete globalThis.localStorage; }
}

t('a saved state from before the TM-2 existed gets it mapped, with display defaults', () => {
    const state = withStorage({ surface: 'rc28', rc28: { mappings: {} } }, () => tm.loadState());
    assert.deepStrictEqual(state.tm2.mappings, TM2_DEFAULT_MAPPINGS);
    assert.deepStrictEqual(state.tm2.display, D.DEFAULT_TM2_DISPLAY);
});

t('saved display settings are kept, and gaps filled', () => {
    const state = withStorage({ surface: 'tm2', tm2: { mappings: {}, display: { backlight: '#00ff00' } } },
        () => tm.loadState());
    assert.strictEqual(state.tm2.display.backlight, '#00ff00');
    assert.strictEqual(state.tm2.display.readout, 'dbm');
    assert.deepStrictEqual(state.tm2.mappings, {}, 'a table somebody cleared stays cleared');
    assert.strictEqual(state.surface, 'tm2');
});

// --- the functions added for it -----------------------------------------------------

function fakeCtx({ frequency = 7074000, mode = 'usb', low = 50, high = 2700, tuneStep = 1000 } = {}) {
    const calls = [];
    const ctx = {
        calls,
        stepHz: 1000,
        actions: {
            setFrequency: (hz) => calls.push(['freq', hz]),
            setBandwidth: (lo, hi) => calls.push(['bw', lo, hi]),
        },
        setTuneStep: (hz, m) => calls.push(['step', hz, m]),
        state: () => ({
            tuning: { frequency, mode, bandwidthLow: low, bandwidthHigh: high },
            tuneStep,
            dsp: { schemas: [] },
        }),
    };
    return ctx;
}
const TRIG = { kind: 'trigger' };

t('step larger and smaller walk the Receiver panel’s list, stopping at the ends', () => {
    let ctx = fakeCtx({ tuneStep: 1000 });
    tm.runFunction('rx_step_next', TRIG, ctx);
    tm.runFunction('rx_step_prev', TRIG, ctx);
    assert.deepStrictEqual(ctx.calls, [['step', 5000, 'usb'], ['step', 500, 'usb']]);
    const top = tm.TUNING_STEPS[tm.TUNING_STEPS.length - 1];
    ctx = fakeCtx({ tuneStep: top });
    tm.runFunction('rx_step_next', TRIG, ctx);
    ctx = fakeCtx({ tuneStep: tm.TUNING_STEPS[0] });
    tm.runFunction('rx_step_prev', TRIG, ctx);
    assert.deepStrictEqual(ctx.calls, [], 'nothing past either end');
});

t('next and previous band, from inside a band and from between two', () => {
    const bands = tm.bandsInRange(10000, 30000000);
    assert.strictEqual(tm.nextBand(bands, 7074000, +1), '30m');
    assert.strictEqual(tm.nextBand(bands, 7074000, -1), '60m');
    assert.strictEqual(tm.nextBand(bands, 8000000, +1), '30m', 'between 40m and 30m, going up');
    assert.strictEqual(tm.nextBand(bands, 8000000, -1), '40m', 'and going down');
    assert.strictEqual(tm.nextBand(bands, 28074000, +1), '160m', 'wraps at the top');
    assert.strictEqual(tm.nextBand(bands, 1900000, -1), '10m', 'and at the bottom');
    assert.strictEqual(tm.nextBand(bands, 500000, +1), '160m', 'below every band');
    assert.strictEqual(tm.nextBand([], 7074000, +1), null);
    const ctx = fakeCtx({ frequency: 14074000 });
    tm.runFunction('band_next', TRIG, ctx);
    assert.deepStrictEqual(ctx.calls, [['freq', 18100000]], 'lands where the band button does');
});

t('passband shift moves the filter and keeps its width', () => {
    const ctx = fakeCtx({ mode: 'usb', low: 50, high: 2750 });
    assert.strictEqual(tm.runFunction('bw_shift', { kind: 'relative', delta: 2 }, ctx), true);
    assert.deepStrictEqual(ctx.calls, [['bw', 150, 2850]]);
    const lsb = fakeCtx({ mode: 'lsb', low: -2750, high: -50 });
    tm.runFunction('bw_shift', { kind: 'relative', delta: 1 }, lsb);
    assert.deepStrictEqual(lsb.calls, [['bw', -2800, -100]], 'LSB shifts away from the carrier too');
    assert.strictEqual(tm.runFunction('bw_shift', TRIG, fakeCtx()), false, 'a knob, not a button');
});

t('filter reset puts the mode’s own passband back', () => {
    const ctx = fakeCtx({ mode: 'usb', low: 300, high: 900 });
    tm.runFunction('filter_reset', TRIG, ctx);
    assert.deepStrictEqual(ctx.calls, [['bw', ...tm.defaultEdges('usb')]]);
});

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} TM-2 tests passed`);
})();
