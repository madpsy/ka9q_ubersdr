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
    const evs = d.parseInput(new Uint8Array([3, 1, 4, 0xff, 5, 1, 16, 1, 17, 1, 18, 1, 19, 1, 20, 1, 21, 1]));
    assert.deepStrictEqual(evs.map((e) => e.key), [
        'zoom_up', 'sql_down', 'bw_up', 'mode_tap', 'mode_hold', 'freq_tap', 'freq_hold', 'mute_tap', 'mute_hold',
    ]);
    assert.strictEqual(evs[3].event.kind, 'trigger');
});

t('unknown codes, zero turns and a stray odd byte are ignored', () => {
    assert.deepStrictEqual(d.parseInput(new Uint8Array([99, 1, 1, 0, 2])), []);
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
        writeValueWithoutResponse: (bytes) => new Promise((r) => { writes.push(bytes); release = r; }),
    };
    const nameChar = { writeValueWithoutResponse: async (bytes) => { names.push(Buffer.from(bytes).toString()); } };
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
    dial.setState({ frequency: 1 });
    dial.setState({ frequency: 2 });
    dial.setState({ frequency: 3 });
    dial.setState({ frequency: 3 });  // unchanged: nothing new
    assert.strictEqual(bt.writes.length, 1, 'first write in flight');
    bt.releaseWrite();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.strictEqual(bt.writes.length, 2, 'then only the latest');
    assert.strictEqual(new DataView(bt.writes[1].buffer).getUint32(1, true), 3);
    dial.setName('M9PSY');
    await Promise.resolve();
    assert.deepStrictEqual(bt.names, ['M9PSY']);
});

at('a turn of the knob tunes the receiver through the dispatcher, by the panel step', async () => {
    const bt = fakeBluetooth();
    const dial = d.getDial();
    await dial.connect();
    const nudges = [];
    d.setControlContext({
        stepHz: 500,
        state: () => ({ tuning: { frequency: 14074000, mode: 'usb' }, dsp: { schemas: [] } }),
        actions: { nudge: (hz) => nudges.push(hz) },
    });
    d.setSurfaceMappings('dial', d.DEFAULT_STATE.dial.mappings);
    const off = d.watchSurface('dial');
    try {
        bt.press([1, 0xfe]);  // tune, two detents anticlockwise
        assert.deepStrictEqual(nudges, [-500, -500]);
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

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} Dial tests passed`);
})();
