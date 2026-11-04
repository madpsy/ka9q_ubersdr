// UberSDR Dial: the Bluetooth wire format both ways, and the surface plumbing
// that makes it a choice beside the RC-28 and the rest.
//
// No dial and no Web Bluetooth here, so navigator.bluetooth is a stand-in that
// hands back a fake GATT device. What can go wrong silently is what is pinned:
// a sign bit read wrong turns the knob one way whichever way it goes, a field
// at the wrong offset puts the dial on the wrong frequency, and a page that
// writes every poll saturates a link that has one write slot.

const assert = require('assert');
const d = require('./.build/dial.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

// --- input: dial -> page ------------------------------------------------------

t('a knob record becomes one relative event per detent, signed', () => {
    // [code 1 = tune][+3]
    const evs = d.parseInput(new Uint8Array([1, 3]));
    assert.strictEqual(evs.length, 3);
    for (const e of evs) assert.deepStrictEqual(e, { key: 'tune_up', event: { kind: 'relative', delta: 1 } });
    // [code 2 = volume][-2] as an unsigned byte
    const down = d.parseInput(new Uint8Array([2, 0xfe]));
    assert.deepStrictEqual(down.map((e) => [e.key, e.event.delta]), [['vol_down', -1], ['vol_down', -1]]);
});

t('every knob page and button has a key, and they share one notification', () => {
    const evs = d.parseInput(new Uint8Array([3, 1, 4, 0xff, 5, 1, 6, 0xff, 16, 1, 17, 1, 18, 1, 19, 1, 20, 1, 21, 1, 22, 1]));
    assert.deepStrictEqual(evs.map((e) => e.key), [
        'zoom_up', 'sql_down', 'bw_up', 'step_down', 'mode_tap', 'mode_hold', 'freq_tap', 'freq_hold', 'mute_tap', 'mute_hold', 'center_tap',
    ]);
    assert.strictEqual(evs[4].event.kind, 'trigger');
});

t('unknown codes, zero turns and a stray odd byte are ignored', () => {
    assert.deepStrictEqual(d.parseInput(new Uint8Array([99, 1, 1, 0, 2])), []);
});

t('an old saved table moves to the Receiver step and gains the STEP page', () => {
    const old = { tune_up: { function: 'freq_step_up' }, tune_down: { function: 'freq_step_down' }, mute_tap: { function: 'mute_toggle' } };
    const up = d.upgradeDialTune(old);
    assert.strictEqual(up.tune_up.function, 'freq_rx_step');
    assert.strictEqual(up.step_up.function, 'rx_step_dial');
    assert.strictEqual(up.mute_tap.function, 'mute_toggle', 'anything else is left alone');
    assert.strictEqual(up.center_tap.function, 'spectrum_center');
    const custom = { tune_up: { function: 'freq_enc_10' }, tune_down: { function: 'freq_enc_10' }, step_up: null };
    assert.strictEqual(d.upgradeDialTune({ ...custom, step_up: { function: 'x' } }).tune_up.function, 'freq_enc_10');
});

t('picker and quick-sheet codes become their direct functions', () => {
    const evs = d.parseInput(new Uint8Array([32 + d.DIAL_MODES.indexOf('am'), 1, 48 + 3, 1, 64 + 3, 1, 82, 1, 85, 1]));
    assert.deepStrictEqual(evs.map((e) => e.key), ['mode_am', 'band_40m', 'step_500', 'sql_auto', 'zoom_reset']);
    const map = d.DEFAULT_STATE.dial.mappings;
    assert.deepStrictEqual(evs.map((e) => map[e.key].function),
        ['mode_am', 'band_40m', 'rx_step_500', 'squelch_auto', 'spectrum_reset']);
});

t('a drag is one relative event in pixels, mapped to the pan', () => {
    const evs = d.parseInput(new Uint8Array([97, 0xe2]));  // -30 px
    assert.deepStrictEqual(evs, [{ key: 'pan_drag', event: { kind: 'relative', delta: -30 } }]);
    assert.strictEqual(d.DEFAULT_STATE.dial.mappings.pan_drag.function, 'spectrum_pan');
});

t('a tap is its position across the view, mapped to tune-at', () => {
    const evs = d.parseInput(new Uint8Array([98, 64, 98, 0]));  // a quarter right of centre, then dead centre
    assert.deepStrictEqual(evs.map((e) => [e.key, e.event.delta]), [['tap_tune', 64], ['tap_tune', 0]]);
    assert.strictEqual(d.DEFAULT_STATE.dial.mappings.tap_tune.function, 'spectrum_tune_at');
});

t('every key has a label and every default maps to a real function', () => {
    for (const k of d.DIAL_KEYS) assert.notStrictEqual(d.dialKeyLabel(k.key), k.key);
    for (const [key, m] of Object.entries(d.DIAL_DEFAULT_MAPPINGS)) {
        assert.ok(d.DIAL_KEYS.some((k) => k.key === key), `${key} is a dial key`);
        assert.ok(d.findFunction(m.function, [], {}), `${m.function} exists`);
    }
});

// --- state: page -> dial ------------------------------------------------------

t('the state record is 20 bytes, little-endian, at the documented offsets', () => {
    const b = d.encodeState({
        frequency: 14074000, mode: 'usb', snr: 12.4, audioUp: true, squelchOn: true, squelchOpen: false,
        muted: true, locked: false, volume: 0.55, squelchDb: 6, bwLow: 50, bwHigh: 2700, stepHz: 500,
    });
    assert.strictEqual(b.length, d.STATE_BYTES);
    const v = new DataView(b.buffer);
    assert.strictEqual(v.getUint8(0), 1, 'version');
    assert.strictEqual(v.getUint32(1, true), 14074000);
    assert.strictEqual(v.getUint8(5), d.DIAL_MODES.indexOf('usb'));
    assert.strictEqual(v.getInt8(6), 12);
    assert.strictEqual(v.getUint8(7), 1 | 2 | 8, 'audio up, squelch on, muted');
    assert.strictEqual(v.getUint8(8), 55);
    assert.strictEqual(v.getInt8(9), 6);
    assert.strictEqual(v.getInt16(10, true), 50);
    assert.strictEqual(v.getInt16(12, true), 2700);
    assert.strictEqual(v.getUint32(14, true), 500);
});

t('missing readings use the sentinels, and LSB edges stay negative', () => {
    const v = new DataView(d.encodeState({ mode: 'lsb', snr: null, squelchDb: null, bwLow: -2700, bwHigh: -50 }).buffer);
    assert.strictEqual(v.getInt8(6), -128, 'no SNR');
    assert.strictEqual(v.getInt8(9), -128, 'squelch off');
    assert.strictEqual(v.getInt16(10, true), -2700);
    assert.strictEqual(v.getUint8(5), d.DIAL_MODES.indexOf('lsb'));
    assert.strictEqual(new DataView(d.encodeState({ mode: 'nonsense' }).buffer).getUint8(5), 255);
});

t('a spectrum line keeps narrow peaks, carries centre and span, and splits on request', () => {
    const bins = new Float32Array(2048).fill(-130);
    bins[1000] = -60;  // one bin wide: must survive the 2048 -> 160 resample
    const [whole] = d.encodeSpectrum(bins, 14074000, 200000, 7);
    assert.strictEqual(whole.length, 12 + d.SPEC_POINTS);
    const v = new DataView(whole.buffer);
    assert.deepStrictEqual([v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)], [1, 7, 0, d.SPEC_POINTS]);
    assert.strictEqual(v.getUint32(4, true), 14074000);
    assert.strictEqual(v.getUint32(8, true), 200000);
    const pts = whole.subarray(12);
    assert.strictEqual(Math.max(...pts), (-60 + 160) * 2, 'the peak, at 0.5 dB');
    assert.strictEqual(pts[0], (-130 + 160) * 2);
    const pieces = d.encodeSpectrum(bins, 14074000, 200000, 8, 8);
    assert.strictEqual(pieces.length, d.SPEC_POINTS / 8);
    assert.ok(pieces.every((p) => p.length === 20), 'fits the smallest MTU');
    assert.strictEqual(new DataView(pieces[3].buffer).getUint8(2), 24, 'offset of the 4th piece');
});

// --- the device, faked --------------------------------------------------------

function fakeBluetooth() {
    const writes = [];
    const names = [];
    const listeners = {};
    let notify = null;
    const input = {
        addEventListener: (ev, fn) => { if (ev === 'characteristicvaluechanged') notify = fn; },
        startNotifications: async () => {},
    };
    let release = null;
    const stateChar = {
        // Held until the test lets it go, so "one write at a time" is visible.
        writeValueWithResponse: (bytes) => new Promise((r) => { writes.push(bytes); release = r; }),
    };
    const nameChar = { writeValueWithResponse: async (bytes) => { names.push(Buffer.from(bytes).toString()); } };
    const device = {
        name: 'UberSDR Dial 40E8',
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
        removeEventListener: () => {},
        gatt: {
            connect: async () => ({
                getPrimaryService: async (uuid) => {
                    assert.strictEqual(uuid, d.DIAL_SERVICE);
                    return {
                        getCharacteristic: async (u) => ({ [d.DIAL_INPUT]: input, [d.DIAL_STATE]: stateChar, [d.DIAL_NAME]: nameChar }[u]),
                    };
                },
            }),
            disconnect: () => {},
        },
    };
    // Node has its own read-only navigator; replace it outright.
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
        bluetooth: {
            requestDevice: async (opts) => {
                assert.deepStrictEqual(opts, { filters: [{ services: [d.DIAL_SERVICE] }] });
                return device;
            },
        },
    } });
    return {
        writes, names, listeners,
        press: (bytes) => notify({ target: { value: { buffer: new Uint8Array(bytes).buffer } } }),
        releaseWrite: () => release && release(),
    };
}

at('writes go one at a time and only the newest waiting state is sent', async () => {
    const bt = fakeBluetooth();
    const dial = new d.DialControl();
    assert.strictEqual(await dial.connect(), true);
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    dial.setState({ frequency: 1 });
    await tick();
    assert.strictEqual(bt.writes.length, 1, 'first write in flight');
    dial.setState({ frequency: 2 });
    dial.setState({ frequency: 3 });
    dial.setState({ frequency: 3 });  // unchanged: nothing new
    dial.setName('M9PSY');            // queued behind, never alongside
    await tick();
    assert.strictEqual(bt.writes.length, 1, 'one GATT operation at a time');
    assert.deepStrictEqual(bt.names, []);
    bt.releaseWrite();
    await tick();
    assert.strictEqual(bt.writes.length, 2, 'then only the latest state');
    assert.strictEqual(new DataView(bt.writes[1].buffer).getUint32(1, true), 3);
    bt.releaseWrite();
    await tick();
    assert.deepStrictEqual(bt.names, ['M9PSY'], 'then the name');
});

at('the knob tunes by the Receiver panel step, and the STEP page changes it', async () => {
    const bt = fakeBluetooth();
    const dial = d.getDial();
    await dial.connect();
    const steps = [];
    const stepSet = [];
    d.setControlContext({
        stepHz: 1000,  // the SDR Control panel's step: not what the dial uses
        state: () => ({ tuning: { frequency: 14074000, mode: 'usb' }, tuneStep: 500, dsp: { schemas: [] } }),
        actions: { stepBy: (step, dir, times) => steps.push([step, dir, times]) },
        setTuneStep: (hz, mode) => stepSet.push([hz, mode]),
    });
    d.setSurfaceMappings('dial', d.DEFAULT_STATE.dial.mappings);
    const off = d.watchSurface('dial');
    try {
            bt.press([1, 0xfe]);  // tune, two detents anticlockwise
            assert.deepStrictEqual(steps, [[500, -1, 1], [500, -1, 1]], 'the Receiver panel step, via stepBy');
            bt.press([6, 1]);     // step page, one click clockwise: 500 -> next in the list
            assert.deepStrictEqual(stepSet, [[1000, 'usb']]);
    } finally {
        off();
        d._resetDispatch();
    }
});

at('the dial is a mapped surface, and choosing another lets go of it', async () => {
    assert.ok(d.SURFACES.includes('dial'));
    assert.ok(d.isMappedSurface('dial'));
    assert.strictEqual(d.surfaceKeyLabel('dial')('mute_tap'), 'Mute — tap');
    const dial = d.getDial();
    if (!dial.connected) { fakeBluetooth(); await dial.connect(); }
    d.releaseSurfaceExcept('rc28');
    await Promise.resolve();
    assert.strictEqual(dial.connected, false);
});

// --- USB: the same records, framed over Web Serial ---------------------------

t('a frame survives the trip through COBS, zeros and all, among log text', () => {
    const payload = Uint8Array.of(0, 1, 0, 0, 255, 0);
    const f = d.encodeFrame(d.FRAME.STATE, payload);
    assert.strictEqual(f[0], 0);
    assert.strictEqual(f[f.length - 1], 0);
    assert.ok(!f.subarray(1, -1).includes(0), 'no zero inside a frame');
    const r = new d.FrameReader();
    const log = new TextEncoder().encode('[render] avg 135 us\n');
    const got = r.push(Uint8Array.from([...log, ...f, ...log, ...log]));
    assert.strictEqual(got.length, 1, 'the log text is not a frame');
    assert.strictEqual(got[0].type, d.FRAME.STATE);
    assert.deepStrictEqual([...got[0].payload], [...payload]);
});

t('a frame split across reads is put back together; a damaged one is dropped', () => {
    const f = d.encodeFrame(d.FRAME.INPUT, Uint8Array.of(1, 0xff));
    const r = new d.FrameReader();
    assert.deepStrictEqual(r.push(f.subarray(0, 3)), []);
    const [one] = r.push(f.subarray(3));
    assert.deepStrictEqual([...one.payload], [1, 0xff]);
    const bad = Uint8Array.from(f);
    bad[2] ^= 0x40;
    assert.deepStrictEqual(r.push(bad), []);
});

t('a 255-byte run without zeros (COBS block boundary) round-trips', () => {
    const payload = new Uint8Array(300).map((_, i) => (i % 250) + 1);
    const [got] = new d.FrameReader().push(d.encodeFrame(d.FRAME.SPEC, payload));
    assert.deepStrictEqual([...got.payload], [...payload]);
});

t('the CRC is CRC-16/CCITT-FALSE, as the firmware computes it', () => {
    assert.strictEqual(d.crc16(new TextEncoder().encode('123456789')), 0x29b1);
});

function fakeSerial() {
    const written = [];
    let push = null;
    const opened = [];
    const port = {
        getInfo: () => ({ ...d.DIAL_USB_FILTER }),
        open: async (opts) => { opened.push(opts); },
        close: async () => {},
        writable: { getWriter: () => ({ write: async (b) => { written.push(b); }, releaseLock() {} }) },
        readable: {
            getReader: () => ({
                read: () => new Promise((res) => { push = res; }),
                cancel: async () => { if (push) push({ done: true }); },
                releaseLock() {},
            }),
        },
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
        serial: { requestPort: async () => port, getPorts: async () => [port] },
    } });
    const frames = () => written.flatMap((b) => new d.FrameReader().push(b));
    return {
        opened,
        frames,
        send: (type, payload) => { const p = push; push = null; p({ value: d.encodeFrame(type, payload), done: false }); },
    };
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

at('over USB the port opens, says hello, and connects when the dial answers', async () => {
    const sp = fakeSerial();
    const dial = new d.DialControl();
    dial.setLink('usb');
    const states = [];
    dial.on('state', (s) => states.push(s));
    try {
    assert.strictEqual(await dial.connect(), true);
    await tick();
    assert.strictEqual(sp.opened.length, 1);
    assert.strictEqual(dial.connected, false, 'not until the dial answers');
    assert.strictEqual(dial.waiting, true);
    assert.strictEqual(sp.frames()[0].type, d.FRAME.HELLO);
    dial.setState({ frequency: 7074000 });
    assert.strictEqual(sp.frames().length, 1, 'nothing sent to a dial that has not answered');
    sp.send(d.FRAME.HELLO, Uint8Array.from([1, ...new TextEncoder().encode('UberSDR Dial 40E8')]));
    await tick();
    assert.strictEqual(dial.connected, true);
    assert.strictEqual(dial.deviceName, 'UberSDR Dial 40E8');
    dial.setState({ frequency: 7074000 });
    dial.setSpectrum(new Array(1024).fill(-100), 7074000, 200000);
    await tick(30);
    const sent = sp.frames();
    const st = sent.find((f) => f.type === d.FRAME.STATE);
    assert.strictEqual(new DataView(st.payload.buffer).getUint32(1, true), 7074000);
    const spec = sent.find((f) => f.type === d.FRAME.SPEC);
    assert.strictEqual(spec.payload.length, 12 + d.SPEC_POINTS, 'a whole line in one frame');
    // The name and state are sent again with each hello: a frame lost on
    // the way is not resent otherwise, and the name is sent only once.
    dial.setName('M9PSY');
    await tick(30);
    dial._lastHello = -Infinity;
    const before = sp.frames().length;
    dial._usbTick();
    await tick(30);
    const again = sp.frames().slice(before).map((f) => f.type);
    assert.deepStrictEqual(again, [d.FRAME.HELLO, d.FRAME.NAME, d.FRAME.STATE]);
    const inputs = [];
    dial.on('input', (e) => inputs.push(e.key));
    sp.send(d.FRAME.INPUT, Uint8Array.of(1, 1, 20, 1));
    await tick();
    assert.deepStrictEqual(inputs, ['tune_up', 'mute_tap']);
    await dial.disconnect();
    assert.strictEqual(sp.frames().pop().type, d.FRAME.BYE, 'tells the dial it is going');
    assert.strictEqual(dial.connected, false);
    assert.strictEqual(dial.waiting, false);
    assert.ok(states.some((s) => s.waiting), 'said it was waiting');
    } finally {
        await dial.disconnect();  // its hello timer would hold the process open
    }
});

at('switching between Bluetooth and USB lets go of the other', async () => {
    fakeSerial();
    const dial = new d.DialControl();
    dial.setLink('usb');
    await dial.connect();
    await tick();
    assert.ok(dial.port);
    dial.setLink('bluetooth');
    await tick();
    assert.strictEqual(dial.port, null);
    assert.strictEqual(dial.link, 'bluetooth');
});

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} Dial tests passed`);
})();
