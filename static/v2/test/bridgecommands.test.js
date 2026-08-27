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
    SNAPSHOTS, applyTuningRange, audioSnapshot, describePage, layoutSnapshot,
    sessionSnapshot, signalSnapshot, snapshotFor, spectrumSnapshot, tuningSnapshot,
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
        locked: false,
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
                setMuted: record('setMuted'),
                setDucked: record('setDucked'),
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
                setTuneLock: record('setTuneLock'),
                toggleTuneLock: record('toggleTuneLock'),
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
        ['tune', 'mode', 'passband', 'volume', 'mute', 'duck', 'squelch', 'vfo', 'spectrum', 'power',
            'panel',      // 1.1
            'radio',      // 1.2
            'surface',       // 1.4 — a control surface something else provides
            'audio',         // 1.4 — the receiver's sound, handed over as a port
            'spectrumdata',  // 1.6 — its frames, the same way; the `spectrum`
                             //       command is the view, this is the data
            'notice',        // 1.6 — say something where the operator will see it
            'lock']);        // 1.7 — the padlock above the waterfall
});

// Commands are only ever added, and only at the end. A client tests for one by
// looking in `capabilities`, so a name that vanished or changed meaning would
// break it silently — the version number is not what it checks.
t('every command 1.0 published is still there', () => {
    for (const name of ['tune', 'mode', 'passband', 'volume', 'mute', 'duck', 'squelch', 'vfo', 'spectrum', 'power']) {
        assert.ok(COMMAND_NAMES.includes(name), `${name} went missing`);
    }
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

t('mute is absolute, and says so rather than emulating it with a toggle', () => {
    // The rig says "transmitting: true/false". Reading the current value and
    // toggling if it differs is a read-modify-write: two controllers doing it
    // at once both read the same value, both toggle, and cancel out.
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('mute', { muted: true }, h.ctx), { muted: true });
    assert.deepStrictEqual(h.calls[0], ['setMuted', true]);
    // Repeating it is a no-op at the receiver, not a flip back.
    assert.deepStrictEqual(runCommand('mute', { muted: true }, h.ctx), { muted: true });
    assert.deepStrictEqual(h.calls[1], ['setMuted', true]);
    runCommand('mute', { muted: false }, h.ctx);
    assert.deepStrictEqual(h.calls[2], ['setMuted', false]);
});

t('mute can still be told to flip, when that is what is meant', () => {
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('mute', { toggle: true }, h.ctx), { muted: true });
    assert.deepStrictEqual(h.calls[0], ['toggleMute']);
    refuses(ERR.BAD_ARGS, () => runCommand('mute', {}, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('mute', { muted: 'yes' }, h.ctx));
});

t('lock is absolute, like mute and for the same reason', () => {
    // A controller with a lock switch reports a position. Emulating that with a
    // toggle desynchronises permanently the first time a message is missed.
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('lock', { locked: true }, h.ctx), { locked: true });
    assert.deepStrictEqual(h.calls, [['setTuneLock', true]]);
    runCommand('lock', { locked: false }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['setTuneLock', false]);
    assert.ok(!h.calls.some((c) => c[0] === 'toggleTuneLock'), 'absolute went through the toggle');
});

t('lock can still be told to flip, and reports where that left it', () => {
    const h = ctxFor({ locked: false });
    assert.deepStrictEqual(runCommand('lock', { toggle: true }, h.ctx), { locked: true });
    assert.deepStrictEqual(h.calls, [['toggleTuneLock']]);
    refuses(ERR.BAD_ARGS, () => runCommand('lock', {}, h.ctx));
    refuses(ERR.BAD_ARGS, () => runCommand('lock', { locked: 'yes' }, h.ctx));
});

t('duck silences without touching the mute the operator chose', () => {
    // A transmission must not end with the receiver permanently muted, and a
    // client showing a mute button must not be made to lie about it.
    const h = ctxFor();
    assert.deepStrictEqual(runCommand('duck', { ducked: true }, h.ctx), { ducked: true });
    assert.deepStrictEqual(h.calls[0], ['setDucked', true]);
    runCommand('duck', { ducked: false }, h.ctx);
    assert.deepStrictEqual(h.calls[1], ['setDucked', false]);
    refuses(ERR.BAD_ARGS, () => runCommand('duck', {}, h.ctx));
    assert.ok(!h.calls.some((c) => c[0] === 'setMuted'), 'ducking touched the mute');
});

t('audio reports ducking separately from muting', () => {
    assert.strictEqual(audioSnapshot({ audio: { muted: false, ducked: true } }).ducked, true);
    assert.strictEqual(audioSnapshot({ audio: { muted: true } }).ducked, false);
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
    meters: { basebandPower: -73.04, noisePower: -110.2, snr: 37.16, level: 0.4321, clipping: false },
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

t('tuning carries what a client tunes with, and how far it can', () => {
    // minFrequency/maxFrequency ride along on this topic rather than a static one
    // because they are not static: they are the live MIN_FREQ/MAX_FREQ bindings, which
    // change when /api/description lands. A client that subscribed before that would
    // otherwise cache the 30 MHz fallback for the life of the page — which is exactly
    // what the browser extensions used to do, refusing 6 m on a 60 MHz receiver.
    assert.deepStrictEqual(tuningSnapshot(SOURCE), {
        frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700,
        vfo: 'B', band: '20m', locked: false,
        minFrequency: 10000, maxFrequency: 30000000,
    });
});

t('the tuning carries the lock, because the lock is what holds it', () => {
    // Without this a client whose tune commands are being ignored has no way to
    // find out: they succeed, and nothing moves.
    assert.strictEqual(tuningSnapshot({ ...SOURCE, locked: true }).locked, true);
});

t('the tuning snapshot follows the receiver, not a fixed 30 MHz', () => {
    applyTuningRange({ min_frequency: 10000, max_frequency: 60000000,
                       spectrum_span_hz: 60000000 });
    try {
        const t2 = tuningSnapshot(SOURCE);
        assert.strictEqual(t2.maxFrequency, 60000000);
        assert.strictEqual(t2.minFrequency, 10000);
    } finally {
        // Live module bindings: leaving 60 MHz set would change every test after this.
        applyTuningRange({ min_frequency: 10000, max_frequency: 30000000,
                           spectrum_span_hz: 30000000 });
    }
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
    const s = signalSnapshot({ meters: { basebandPower: -999, noisePower: -999, snr: -999 } });
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


// --- panel / layout ----------------------------------------------------------
//
// The desktop client's native Layout menu is built from these two. A menu is a
// picture of state somebody else owns, so what matters is that it can name a
// panel it cannot see, and that a refusal is loud rather than a no-op leaving a
// tick that never clears.

// A stand-in for the facade BridgeHost builds over the layout context.
function fakeLayout(over = {}) {
    const calls = [];
    const panels = over.panels || [
        { id: 'receiver', title: 'Receiver', placement: 'left', hidden: false, unhideable: false },
        { id: 'spaceweather', title: 'Space weather', placement: 'right', hidden: true, unhideable: false },
        { id: 'layout', title: 'Layout', placement: 'left', hidden: false, unhideable: true },
    ];
    return {
        calls,
        panels,
        placements: ['left', 'right', 'bottom', 'float'],
        docks: [{ id: 'left', collapsed: false }],
        setHidden: (id, hidden) => calls.push(['setHidden', id, hidden]),
        move: (id, placement) => calls.push(['move', id, placement]),
        snapshot: () => ({ panels, docks: [{ id: 'left', collapsed: false }] }),
    };
}

t('panel hides and shows by id', () => {
    const layout = fakeLayout();
    runCommand('panel', { id: 'spaceweather', hidden: false }, { layout });
    assert.deepStrictEqual(layout.calls, [['setHidden', 'spaceweather', false]]);
});

t('panel moves to any placement the layout offers', () => {
    for (const placement of ['left', 'right', 'bottom', 'float']) {
        const layout = fakeLayout();
        runCommand('panel', { id: 'receiver', placement }, { layout });
        assert.deepStrictEqual(layout.calls, [['move', 'receiver', placement]]);
    }
});

t('moving and hiding together moves first, so the panel ends hidden', () => {
    // movePanel un-hides on the way past, so the other order would silently
    // ignore hidden:true.
    const layout = fakeLayout();
    runCommand('panel', { id: 'receiver', placement: 'bottom', hidden: true }, { layout });
    assert.deepStrictEqual(layout.calls, [['move', 'receiver', 'bottom'], ['setHidden', 'receiver', true]]);
});

t('an unknown panel or placement is refused, and says what there is', () => {
    const layout = fakeLayout();
    assert.throws(() => runCommand('panel', { id: 'nope', hidden: true }, { layout }),
        (e) => e.code === ERR.BAD_ARGS && /receiver/.test(e.message));
    assert.throws(() => runCommand('panel', { id: 'receiver', placement: 'middle' }, { layout }),
        (e) => e.code === ERR.BAD_ARGS && /float/.test(e.message));
    assert.deepStrictEqual(layout.calls, [], 'nothing was moved on the way to refusing');
});

t('naming a panel and asking for nothing is an error, not a no-op', () => {
    const layout = fakeLayout();
    assert.throws(() => runCommand('panel', { id: 'receiver' }, { layout }),
        (e) => e.code === ERR.BAD_ARGS);
});

t('the panel that unhides the others refuses to be hidden', () => {
    const layout = fakeLayout();
    assert.throws(() => runCommand('panel', { id: 'layout', hidden: true }, { layout }),
        (e) => e.code === ERR.UNSUPPORTED);
    // Moving it is fine — it is hiding that would strand somebody.
    runCommand('panel', { id: 'layout', placement: 'right' }, { layout });
    assert.deepStrictEqual(layout.calls, [['move', 'layout', 'right']]);
});

t('a page with no layout says so rather than throwing a type error', () => {
    assert.throws(() => runCommand('panel', { id: 'receiver', hidden: true }, {}),
        (e) => e.code === ERR.UNSUPPORTED);
});

t('the layout snapshot carries hidden panels too, with titles to show', () => {
    const snap = layoutSnapshot({ layout: fakeLayout().snapshot() });
    assert.deepStrictEqual(snap.panels.map((p) => p.id), ['receiver', 'spaceweather', 'layout']);
    const sw = snap.panels.find((p) => p.id === 'spaceweather');
    assert.strictEqual(sw.hidden, true, 'a hidden panel must still be nameable');
    assert.strictEqual(sw.title, 'Space weather');
    assert.strictEqual(sw.placement, 'right');
    assert.strictEqual(snap.panels.find((p) => p.id === 'layout').unhideable, true);
});

t('a page with no layout snapshots as empty rather than null', () => {
    assert.deepStrictEqual(layoutSnapshot({}), { panels: [], docks: [] });
    assert.deepStrictEqual(snapshotFor('layout', {}), { panels: [], docks: [] });
});

// --- the vfos topic ---------------------------------------------------------
//
// Four VFOs, and the one subtlety worth pinning: lib/vfos.js deliberately does
// not keep the *active* slot's stored copy current — the live receiver is that
// VFO, and the store is written only when you switch away. So the snapshot has
// to take the active slot from live tuning, or it reports wherever the dial was
// when that VFO was last selected.

t('vfos reports all four, with the active one taken from live tuning', () => {
    const snap = snapshotFor('vfos', {
        tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        vfos: {
            active: 'B',
            ids: ['A', 'B', 'C', 'D'],
            slots: {
                A: { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 },
                // Stale on purpose: B is active, so this is where the dial was
                // when B was last switched away from.
                B: { frequency: 1810000, mode: 'cwu', bandwidthLow: -250, bandwidthHigh: 250 },
                C: null,
                D: { frequency: 3573000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
            },
        },
    });

    assert.strictEqual(snap.active, 'B');
    assert.strictEqual(snap.slots.length, 4, 'always four, in order, so a client can lay out four rows');

    const byId = Object.fromEntries(snap.slots.map((v) => [v.id, v]));
    assert.strictEqual(byId.B.frequency, 14074000, 'the active slot must come from live tuning, not the stale store');
    assert.strictEqual(byId.B.active, true);
    assert.strictEqual(byId.A.frequency, 7100000, 'an inactive slot comes from the store');
    assert.strictEqual(byId.A.active, false);
    assert.strictEqual(byId.C.frequency, null, 'a never-used slot is null, not missing');
    assert.strictEqual(byId.D.mode, 'usb');
});

t('vfos survives a page that has no VFO state at all', () => {
    const snap = snapshotFor('vfos', { tuning: { frequency: 14074000, mode: 'usb' } });
    assert.strictEqual(snap.slots.length, 4);
    assert.ok(snap.slots.every((v) => typeof v.id === 'string'));
});

console.log(`\n${pass} ok`);
