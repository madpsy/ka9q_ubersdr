// The curated commands, and the shape of every topic.
//
// Both halves of what a client can rely on: what it may ask for, and what it
// gets back. The commands go through the same control-surface facade the knobs
// and keys use, so these tests also pin that a bridge command cannot take a
// different path from the button that does the same thing.

const assert = require('assert');
const { COMMANDS, COMMAND_NAMES, runCommand } = require('./.build/bridgecommands.cjs');
const { ERR } = require('./.build/bridgeprotocol.cjs');
const {
    SNAPSHOTS, audioSnapshot, describePage, sessionSnapshot, signalSnapshot,
    snapshotFor, spectrumSnapshot, tuningSnapshot,
} = require('./.build/bridgesnapshots.cjs');
const { LIVE_TOPICS, STATIC_TOPICS } = require('./.build/bridgeprotocol.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// vfos.js keeps its slots in localStorage; the VFO commands write to it.
globalThis.localStorage = (() => {
    const map = new Map();
    return {
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
})();

// A control context of the shape controls/panel.jsx builds, recording what was
// asked of the receiver instead of doing it.
function ctxFor(over = {}) {
    const calls = [];
    const state = {
        tuning: { frequency: 7100000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        audio: { volume: 0.7, muted: false, channel: 'both', bufferSec: 0.2 },
        squelch: { value: 24, enabled: false, threshold: null },
        view: { centerFreq: 15000000, span: 30000000, binBandwidth: 14648, binCount: 2048 },
        dsp: { schemas: null },
        ...over,
    };
    const record = (name) => (...args) => { calls.push([name, ...args]); };
    return {
        calls,
        state,
        ctx: {
            stepHz: 1000,
            state: () => state,
            actions: {
                tuneTo: record('tuneTo'),
                stepBy: record('stepBy'),
                setMode: record('setMode'),
                setBandwidth: record('setBandwidth'),
                setVolume: record('setVolume'),
                toggleMute: record('toggleMute'),
                setSquelch: record('setSquelch'),
                autoSquelch: record('autoSquelch'),
                ensureVisible: record('ensureVisible'),
                setSpectrumCenter: record('setSpectrumCenter'),
                setSpectrumView: record('setSpectrumView'),
                setSpan: record('setSpan'),
                zoomSteps: record('zoomSteps'),
                resetSpectrum: record('resetSpectrum'),
                centerOnTuned: record('centerOnTuned'),
                powerOff: record('powerOff'),
            },
        },
    };
}

const refuses = (code, fn) => {
    try {
        fn();
    } catch (e) {
        assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
        return e;
    }
    throw new Error(`expected ${code}, but it succeeded`);
};

// --- the set itself ----------------------------------------------------------

t('the command set is the published one', () => {
    assert.deepStrictEqual(COMMAND_NAMES,
        ['tune', 'mode', 'passband', 'volume', 'mute', 'squelch', 'vfo', 'spectrum', 'power']);
});

t('an unknown command names the ones that exist', () => {
    const h = ctxFor();
    const e = refuses(ERR.UNSUPPORTED, () => runCommand('teleport', {}, h.ctx));
    assert.match(e.message, /tune/);
});

// --- tune --------------------------------------------------------------------

t('tune sets an exact frequency', () => {
    const h = ctxFor();
    const out = runCommand('tune', { frequency: 14074000 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['tuneTo', { frequency: 14074000 }]);
    assert.strictEqual(out.mode, 'usb');
});

t('tune takes a relative delta', () => {
    const h = ctxFor();
    runCommand('tune', { delta: -1000 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['tuneTo', { frequency: 7099000 }]);
});

t('a relative move stops at the band edge rather than being refused', () => {
    // What the dial does — and what the receiver does anyway, since applyTuning
    // clamps whatever it is handed. Refusing would make a step into the edge do
    // nothing at all.
    const h = ctxFor();
    runCommand('tune', { delta: 30000000 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['tuneTo', { frequency: 30000000 }]);
    runCommand('tune', { delta: -30000000 }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['tuneTo', { frequency: 10000 }]);
    // An absolute frequency is still refused: that one is the caller asking for
    // somewhere that does not exist.
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 40000000 }, h.ctx));
});

t('tune steps on the grid, using the panel step when none is given', () => {
    const h = ctxFor();
    runCommand('tune', { dir: -1 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['stepBy', 1000, -1]);
    runCommand('tune', { step: 500, dir: 1 }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['stepBy', 500, 1]);
});

t('tune carries mode and passband in one call, not three', () => {
    // Sending them separately walks the receiver through intermediate
    // mode/passband pairs, which is audible.
    const h = ctxFor();
    runCommand('tune', {
        frequency: 14074000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50,
    }, h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.calls[0], ['tuneTo', {
        frequency: 14074000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50,
    }]);
});

t('tune checks the passband against the mode being tuned to, not the one in force', () => {
    const h = ctxFor();
    // -2700..-50 is legal for LSB and illegal for the current USB.
    runCommand('tune', { mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 }, h.ctx);
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { bandwidthLow: -2700, bandwidthHigh: -50 }, h.ctx));
});

t('tune refuses what it cannot do rather than clamping quietly', () => {
    const h = ctxFor();
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 40000000 }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 1000 }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 'seven' }, h.ctx));

    refuses(ERR.BAD_ARGS, () => runCommand('tune', {}, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 1e7, delta: 5 }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { frequency: 1e7, step: 100 }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { mode: 'ssb' }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('tune', { bandwidthLow: 100 }, h.ctx));
    assert.deepStrictEqual(h.calls, []);
});

t('tune moves the view only when asked', () => {
    const h = ctxFor();
    runCommand('tune', { frequency: 14074000 }, h.ctx);
    assert.strictEqual(h.calls.length, 1);
    runCommand('tune', { frequency: 14074000, ensureVisible: true }, h.ctx);
    assert.deepStrictEqual(h.calls[2], ['ensureVisible', 14074000]);
});

// --- mode and passband -------------------------------------------------------

t('mode takes the mode default passband, as the button does', () => {
    const h = ctxFor();
    runCommand('mode', { mode: 'cwu' }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['setMode', 'cwu']);
    refuses(ERR.BAD_ARGS, () => runCommand('mode', { mode: 'fax' }, h.ctx));
});

t('passband is checked against the mode in force', () => {
    const h = ctxFor();
    runCommand('passband', { low: 300, high: 2400 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['setBandwidth', 300, 2400]);
    refuses(ERR.BAD_ARGS, () => runCommand('passband', { low: 2400, high: 300 }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('passband', { low: 50, high: 9000 }, h.ctx));
});

// --- audio -------------------------------------------------------------------

t('volume is absolute or relative, and refuses to leave 0..1', () => {
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('volume', { volume: 0.5 }, h.ctx), { volume: 0.5, muted: false });
    assert.deepStrictEqual(h.calls[0], ['setVolume', 0.5]);
    runCommand('volume', { delta: 0.1 }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['setVolume', 0.8]);
    // Absolute: refused. Relative: rides up to the stop, as a volume knob does.
    refuses(ERR.BAD_ARGS, () => runCommand('volume', { volume: 2 }, h.ctx));
    assert.deepStrictEqual(runCommand('volume', { delta: 0.9 }, h.ctx), { volume: 1, muted: false });
    assert.deepStrictEqual(h.calls[2], ['setVolume', 1]);
});

t('mute is absolute — a toggle would desync PTT permanently', () => {
    // The rig says "transmitting: true/false". One missed message and a toggle
    // un-mutes on every transmit thereafter.
    const h = ctxFor();
    runCommand('mute', { muted: false }, h.ctx);
    assert.deepStrictEqual(h.calls, [], 'already unmuted: nothing to do');
    assert.deepStrictEqual(runCommand('mute', { muted: true }, h.ctx), { muted: true });
    assert.deepStrictEqual(h.calls[0], ['toggleMute']);
});

t('mute can still be told to flip, when that is what is meant', () => {
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('mute', { toggle: true }, h.ctx), { muted: true });
    assert.deepStrictEqual(h.calls[0], ['toggleMute']);
    refuses(ERR.BAD_ARGS, () => runCommand('mute', {}, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('mute', { muted: 'yes' }, h.ctx));
});

t('squelch sets a value, switches off, or finds its own level', () => {
    const h = ctxFor();
    const out = runCommand('squelch', { value: 40 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['setSquelch', 40]);
    assert.strictEqual(out.enabled, true);
    assert.deepStrictEqual(runCommand('squelch', { enabled: false }, h.ctx).enabled, false);
    runCommand('squelch', { auto: true }, h.ctx);
    assert.deepStrictEqual(h.calls[2], ['autoSquelch']);
    refuses(ERR.BAD_ARGS, () => runCommand('squelch', { value: 500 }, h.ctx));
});

// --- spectrum and power ------------------------------------------------------

t('spectrum sets centre and span together in one call', () => {
    // Separately, the span closes around wherever the view had got to.
    const h = ctxFor();
    runCommand('spectrum', { center: 14100000, span: 200000 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['setSpectrumView', 14100000, 200000]);
});

t('spectrum takes each of its other forms', () => {
    const h = ctxFor();
    runCommand('spectrum', { center: 14100000 }, h.ctx);
    assert.deepStrictEqual(h.calls[0], ['setSpectrumCenter', 14100000]);
    runCommand('spectrum', { span: 500000 }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['setSpan', 500000]);
    runCommand('spectrum', { zoom: -2 }, h.ctx);
    assert.deepStrictEqual(h.calls[2], ['zoomSteps', -2, undefined]);
    runCommand('spectrum', { reset: true }, h.ctx);
    assert.deepStrictEqual(h.calls[3], ['resetSpectrum']);
    runCommand('spectrum', { centerOnTuned: true }, h.ctx);
    assert.deepStrictEqual(h.calls[4], ['centerOnTuned']);
    refuses(ERR.BAD_ARGS, () => runCommand('spectrum', {}, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('spectrum', { zoom: 0.5 }, h.ctx));
});

t('power can stop the audio but says plainly why it cannot start it', () => {
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('power', { on: false }, h.ctx), { running: false });
    assert.deepStrictEqual(h.calls[0], ['powerOff']);
    const e = refuses(ERR.UNSUPPORTED, () => runCommand('power', { on: true }, h.ctx));
    assert.match(e.message, /gesture/);
});

// --- VFOs --------------------------------------------------------------------

t('vfo selects a slot and reports where that left the receiver', () => {
    const h = ctxFor();
    const out = runCommand('vfo', { id: 'B' }, h.ctx);
    assert.strictEqual(out.vfo, 'B');
    refuses(ERR.BAD_ARGS, () => runCommand('vfo', { id: 'E' }, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('vfo', { step: 3 }, h.ctx));
});

t('vfo steps along the slots', () => {
    const h = ctxFor();
    runCommand('vfo', { id: 'A' }, h.ctx);
    runCommand('vfo', { step: 1 }, h.ctx);
    assert.strictEqual(runCommand('vfo', { step: -1 }, h.ctx).vfo, 'A');
});

// --- snapshots ---------------------------------------------------------------

const SOURCE = {
    tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    audio: { volume: 0.7, muted: false, channel: 'both', bufferSec: 0.2 },
    squelch: { value: 40, enabled: true, threshold: 12 },
    squelchOpen: true,
    view: { centerFreq: 14100000, span: 204800, binBandwidth: 100, binCount: 2048 },
    meters: { basebandPower: -73.04, noiseDensity: -110.2, snr: 37.16, level: 0.4321, clipping: false },
    follow: true,
    running: true,
    session: { maxSec: 0, idleSec: 300, startedAt: 1000 },
    sessionId: 'sess-1',
    receiverId: 'uuid-1',
    serverInfo: {
        public_uuid: 'uuid-1', version: '1.2.3',
        receiver: { name: 'Test RX', callsign: 'M9PSY', location: 'IO91', public_url: 'https://rx/' },
    },
    vfo: 'B',
    band: '20m',
    url: 'https://rx/v2/',
    title: 'M9PSY UberSDR - 14.074 MHz USB',
};

t('every topic has a snapshot, and every snapshot belongs to a topic', () => {
    assert.deepStrictEqual(Object.keys(SNAPSHOTS).sort(), [...LIVE_TOPICS, ...STATIC_TOPICS].sort());
});

t('tuning carries what a client tunes with', () => {
    assert.deepStrictEqual(tuningSnapshot(SOURCE), {
        frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700,
        vfo: 'B', band: '20m',
    });
});

t('audio carries the squelch setting and whether it is open now', () => {
    assert.deepStrictEqual(audioSnapshot(SOURCE).squelch,
        { value: 40, enabled: true, threshold: 12, open: true });
});

t('signal is rounded at the source, so diffing means something', () => {
    // Unrounded floats would put a "change" on the wire on every sample and
    // spend the rate limit on noise.
    const s = signalSnapshot(SOURCE);
    assert.deepStrictEqual(s, { dbfs: -73, noise: -110.2, snr: 37.2, s: 9, level: 0.432, clipping: false });
});

t('a non-reading is null rather than a very quiet signal', () => {
    // The server sends values below -900 to mean "nothing measured". Plotted
    // as a level they draw a cliff.
    const s = signalSnapshot({ meters: { basebandPower: -999, noiseDensity: -999, snr: -999 } });
    assert.deepStrictEqual(s, { dbfs: null, noise: null, snr: null, s: null, level: null, clipping: false });
});

t('a missing source gives a full shape of nulls, never missing keys', () => {
    // Fixed shape is what lets a client merge patches and rely on a field.
    for (const topic of LIVE_TOPICS) {
        const snap = snapshotFor(topic, {});
        assert.ok(snap && typeof snap === 'object', topic);
    }
    assert.deepStrictEqual(spectrumSnapshot({}), {
        centerFreq: null, span: null, binBandwidth: null, binCount: null, follow: false,
    });
});

t('session distinguishes the receiver from the sitting', () => {
    const s = sessionSnapshot(SOURCE);
    assert.strictEqual(s.id, 'sess-1');
    assert.strictEqual(s.receiverId, 'uuid-1');
    assert.strictEqual(s.running, true);
});

t('modes carry their defaults and their limits', () => {
    const modes = snapshotFor('modes', {});
    const usb = modes.find((m) => m.id === 'usb');
    assert.deepStrictEqual(usb.default, { low: 50, high: 2700 });
    assert.deepStrictEqual(usb.limits, { min: 0, max: 6000, sideband: 'upper' });
    // CW is symmetric about the carrier in both sidebands — a client that
    // assumed one-sided from the name would draw the wrong filter.
    assert.strictEqual(modes.find((m) => m.id === 'cwu').limits.sideband, 'both');
});

t('bands are the tuneable ones with their edges', () => {
    const bands = snapshotFor('bands', {});
    assert.deepStrictEqual(bands.find((b) => b.name === '20m'), { name: '20m', min: 14000000, max: 14350000 });
});

t('functions are the mappable catalogue, with what each one needs', () => {
    const fns = snapshotFor('functions', {});
    assert.ok(fns.length > 20, `only ${fns.length} functions`);
    const step = fns.find((f) => f.id === 'freq_step_up');
    assert.ok(step && step.label && step.group);
    assert.strictEqual(step.repeat, true);
    // A receiver with no rotator does not offer the rotator functions.
    assert.ok(!fns.some((f) => f.needs === 'rotator'));
    assert.ok(snapshotFor('functions', { hardware: { rotator: true } })
        .some((f) => f.needs === 'rotator'));
});

t('the descriptor identifies the receiver and the session separately', () => {
    const d = describePage({ ...SOURCE, api: { major: 1, minor: 0 }, capabilities: ['tune'], topics: ['tuning'], commands: ['tune'] });
    assert.strictEqual(d.app, 'ubersdr');
    assert.strictEqual(d.ui, 'v2');
    assert.deepStrictEqual(d.receiver, {
        id: 'uuid-1', name: 'Test RX', callsign: 'M9PSY', location: 'IO91',
        url: 'https://rx/', serverVersion: '1.2.3',
    });
    assert.strictEqual(d.session.id, 'sess-1');
    assert.deepStrictEqual(d.page, { url: 'https://rx/v2/', title: 'M9PSY UberSDR - 14.074 MHz USB' });
});

t('a descriptor from a page that has not heard from the server yet is still valid', () => {
    const d = describePage({ api: { major: 1, minor: 0 } });
    assert.strictEqual(d.receiver.id, null);
    assert.strictEqual(d.app, 'ubersdr');
});

console.log(`\n${pass} ok`);
