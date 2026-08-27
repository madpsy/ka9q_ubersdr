// Radio Control: event normalisation, dispatch, and the v1 mapping format.
//
// The interesting failures here are all silent ones. A fader read as an encoder
// slews the receiver across the band instead of setting a level; a rate limit
// that never fires floods the tune command; an imported v1 file that parses but
// maps nothing looks like it worked. None of those throw, so they are pinned.

const assert = require('assert');
const { parseToken, flexKeyLabel, FlexControl } = require('./.build/flexcontrol.cjs');
const { midiKey, midiKeyLabel, CC, NOTE_ON, NOTE_OFF } = require('./.build/webmidi.cjs');
const {
    runFunction, catalogue, functionLabel, isEncoderFunction, isUnavailable, RETIRED,
} = require('./.build/functions.cjs');
const {
    antennaStep, nextAntenna, rotatorStep, hardwareMessages,
} = require('./.build/hardware.cjs');
const { Dispatcher, defaultThrottle, normaliseMidiMappings } = require('./.build/mappings.cjs');
const { SDR_TO_HAMLIB } = require('./.build/radiosync.cjs');
const { MODES, SQUELCH_MIN, SQUELCH_MAX, bandwidthLimits } = require('./.build/constants.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A stand-in radio: records what was asked of it, answers with a fixed state.
function fakeRadio(over = {}) {
    const calls = [];
    const state = {
        tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        audio: { volume: 0.7, muted: false },
        squelch: { value: SQUELCH_MIN, enabled: false },
        dsp: { filter: null, enabled: false, params: {}, schemas: [] },
        ...over,
    };
    const record = (name) => (...args) => calls.push([name, ...args]);
    return {
        calls,
        state: () => state,
        stepHz: 1000,
        actions: {
            nudge: record('nudge'),
            setFrequency: record('setFrequency'),
            setMode: record('setMode'),
            setBandwidth: record('setBandwidth'),
            setVolume: record('setVolume'),
            toggleMute: record('toggleMute'),
            setSquelch: record('setSquelch'),
            autoSquelch: record('autoSquelch'),
            setDsp: record('setDsp'),
            zoomIn: record('zoomIn'),
            zoomOut: record('zoomOut'),
            centerOnTuned: record('centerOnTuned'),
            resetSpectrum: record('resetSpectrum'),
            tuneTo: record('tuneTo'),
            setSpan: record('setSpan'),
            toggleTuneLock: record('toggleTuneLock'),
        },
    };
}

const REL = (delta) => ({ kind: 'relative', delta });
const ABS = (value) => ({ kind: 'absolute', value });
const TRIG = { kind: 'trigger' };

// --- FlexControl tokens -----------------------------------------------------

t('a bare dial token is one detent in each direction', () => {
    assert.deepStrictEqual(parseToken('U'), { key: 'dial_up', delta: 1 });
    assert.deepStrictEqual(parseToken('D'), { key: 'dial_down', delta: -1 });
});

t('the dial speed byte survives as a signed magnitude', () => {
    // Turning fast is the hardware's own acceleration — dropping it would make
    // a fast spin no faster than a slow one.
    assert.deepStrictEqual(parseToken('U06'), { key: 'dial_up', delta: 6 });
    assert.deepStrictEqual(parseToken('D04'), { key: 'dial_down', delta: -4 });
});

t('AUX taps, doubles and holds are distinct keys', () => {
    assert.strictEqual(parseToken('X1S').key, 'aux1_tap');
    assert.strictEqual(parseToken('X2C').key, 'aux2_dbl');
    assert.strictEqual(parseToken('X3L').key, 'aux3_hold');
});

t('the reset token and anything unrecognised are ignored, not mapped', () => {
    // F0304 arrives on plug-in. Treating it as an input would fire whatever
    // happened to be in learn mode at the time.
    assert.strictEqual(parseToken('F0304'), null);
    assert.strictEqual(parseToken('ZZ9'), null);
    assert.strictEqual(parseToken(''), null);
});

t('every FlexControl key has a label', () => {
    for (const token of ['U', 'D', 'X1S', 'X1C', 'X1L', 'X2S', 'X3L']) {
        const { key } = parseToken(token);
        assert.notStrictEqual(flexKeyLabel(key), key, `${key} falls back to its raw id`);
    }
});

// --- FlexControl autoconnect -------------------------------------------------
//
// Runs on page load and on hotplug, where every way of having no dial is
// ordinary rather than a fault. The thing being pinned is the silence: a
// receiver left running must not accumulate error banners about a knob box
// nobody plugged in.

const FLEX_INFO = { usbVendorId: 0x2192, usbProductId: 0x0010 };

function fakePort(info, opens = true) {
    return {
        getInfo: () => info,
        open: async () => { if (!opens) throw new Error('Failed to open serial port'); },
        close: async () => {},
        readable: null,   // ends the read loop at once; tokens are tested above
    };
}

// Returns [connected, messages] after an autoConnect against these ports.
async function autoConnectWith(ports) {
    globalThis.navigator = { serial: { getPorts: async () => ports } };
    const flex = new FlexControl();
    const msgs = [];
    flex.on('message', (m) => msgs.push(m));
    const ok = await flex.autoConnect();
    return [ok, msgs];
}

const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

at('nothing granted yet is silent, not an error', async () => {
    const [ok, msgs] = await autoConnectWith([]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(msgs, []);
});

at('a granted port that is not a FlexControl is left alone', async () => {
    // getPorts() returns everything this origin was ever granted. Opening an
    // arbitrary serial device at 9600 baud unasked is not on.
    const [ok] = await autoConnectWith([fakePort({ usbVendorId: 0x0403, usbProductId: 0x6001 })]);
    assert.strictEqual(ok, false);
});

at('a granted FlexControl is opened and says so', async () => {
    const [ok, msgs] = await autoConnectWith([fakePort(FLEX_INFO)]);
    assert.strictEqual(ok, true);
    assert.ok(msgs.some((m) => m.tone === 'good'), 'the connection should be logged');
});

at('a port that will not open fails quietly', async () => {
    // Unplugged between the event and the open, or held by another tab.
    const [ok, msgs] = await autoConnectWith([fakePort(FLEX_INFO, false)]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(msgs, []);
});

at('no Web Serial at all is not a crash', async () => {
    globalThis.navigator = {};
    assert.strictEqual(await new FlexControl().autoConnect(), false);
});

// --- MIDI addressing --------------------------------------------------------

t('note off keeps its own address so press and release can differ', () => {
    // This is what lets one button mute on press and unmute on release.
    assert.notStrictEqual(midiKey(NOTE_ON, 0, 36), midiKey(NOTE_OFF, 0, 36));
});

t('a MIDI key labels its channel from one, as the hardware does', () => {
    assert.match(midiKeyLabel(midiKey(CC, 0, 14)), /ch 1/);
    assert.match(midiKeyLabel(midiKey(CC, 15, 14)), /ch 16/);
});

// --- event normalisation ----------------------------------------------------

t('an encoder moves the dial by its step times the detent count', () => {
    const r = fakeRadio();
    assert.ok(runFunction('freq_enc_1k', REL(3), r));
    assert.deepStrictEqual(r.calls[0], ['nudge', 3000]);
    assert.ok(runFunction('freq_enc_1k', REL(-2), r));
    assert.deepStrictEqual(r.calls[1], ['nudge', -2000]);
});

t('a fader sets volume to its position, an encoder walks it', () => {
    const abs = fakeRadio();
    runFunction('volume_set', ABS(0.5), abs);
    assert.deepStrictEqual(abs.calls[0], ['setVolume', 0.5]);

    // The same function from a dial is relative to where the volume already is
    // (0.7), not an absolute jump — treating one as the other is the mistake
    // this whole normalisation exists to prevent.
    const rel = fakeRadio();
    runFunction('volume_set', REL(5), rel);
    assert.deepStrictEqual(rel.calls[0], ['setVolume', 0.75]);
});

t('volume cannot be driven outside 0..1', () => {
    const r = fakeRadio({ audio: { volume: 0.98, muted: false } });
    runFunction('volume_set', REL(20), r);
    assert.strictEqual(r.calls[0][1], 1);
    const q = fakeRadio({ audio: { volume: 0.01, muted: false } });
    runFunction('volume_set', REL(-20), q);
    assert.strictEqual(q.calls[0][1], 0);
});

t('the passband is clamped to the mode’s own limits, not a slider’s', () => {
    // LSB runs -6000..0: a fader swept to the top must not produce a positive
    // low edge. v1 read these bounds off DOM attributes and got them wrong when
    // the mode had changed since the slider was last rendered.
    const r = fakeRadio({
        tuning: { frequency: 3700000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 },
    });
    runFunction('bw_low', ABS(1), r);
    const l = bandwidthLimits('lsb');
    const [, low] = r.calls[0];
    assert.ok(low <= l.max && low >= l.min, `low edge ${low} outside ${l.min}..${l.max}`);
});

t('a button cannot drive a function that needs a position', () => {
    // Nothing sensible to do with a trigger on an absolute-only control, so it
    // reports failure instead of picking a value.
    const r = fakeRadio();
    assert.strictEqual(runFunction('zoom_dial', TRIG, r), false);
    assert.strictEqual(r.calls.length, 0);
});

t('typing a frequency is a press only, and touches the receiver directly not at all', () => {
    // It opens the top bar's box — see lib/freqEntry.js — so a detent must not
    // reach it: a dial that opened a text box on its first click would then be
    // typing into it. Nothing was listening here, which is not an error either.
    const r = fakeRadio();
    assert.ok(catalogue([]).some((f) => f.id === 'freq_entry'));
    assert.strictEqual(runFunction('freq_entry', REL(1), r), false);
    assert.strictEqual(runFunction('freq_entry', TRIG, r), true);
    assert.strictEqual(r.calls.length, 0);
});

t('an unknown function is refused rather than throwing', () => {
    const r = fakeRadio();
    assert.strictEqual(runFunction('no_such_function', TRIG, r), false);
});

// --- catalogue ---------------------------------------------------------------

t('every mode in the receiver is directly mappable', () => {
    const ids = new Set(catalogue([]).map((f) => f.id));
    for (const m of MODES) assert.ok(ids.has(`mode_${m.id}`), `mode_${m.id} missing`);
});

t('mode cycling wraps in both directions', () => {
    // The cycle is the mode list minus IQ — see MODE_CYCLE. A knob walking off
    // the end of the list must land back at the start, not in a mode with no
    // audio and a confirmation dialog it cannot answer.
    const cycle = MODES.filter((m) => m.id !== 'iq');
    const first = cycle[0].id;
    const last = cycle[cycle.length - 1].id;
    const up = fakeRadio({ tuning: { frequency: 1e7, mode: last, bandwidthLow: 50, bandwidthHigh: 2700 } });
    runFunction('mode_next', TRIG, up);
    assert.deepStrictEqual(up.calls[0], ['setMode', first]);

    const down = fakeRadio({ tuning: { frequency: 1e7, mode: first, bandwidthLow: 50, bandwidthHigh: 2700 } });
    runFunction('mode_prev', TRIG, down);
    assert.deepStrictEqual(down.calls[0], ['setMode', last]);
});

t('noise reduction comes from the server’s schema, never a hardcoded name', () => {
    // No filters advertised: nothing to select, and the toggle must not invent
    // an "nr2" that this receiver may not have.
    const bare = catalogue([]).map((f) => f.id);
    assert.ok(!bare.some((id) => id.startsWith('dsp_select_')));

    const withFilters = catalogue([{ name: 'nr4' }, { name: 'dfnr' }]).map((f) => f.id);
    assert.ok(withFilters.includes('dsp_select_nr4'));
    assert.ok(withFilters.includes('dsp_select_dfnr'));
});

t('the NR toggle with nothing selected picks the first filter offered', () => {
    const r = fakeRadio({ dsp: { filter: null, enabled: false, params: {}, schemas: [{ name: 'nr4' }] } });
    runFunction('dsp_toggle', TRIG, r);
    assert.deepStrictEqual(r.calls[0], ['setDsp', 'nr4', true]);
});

t('the NR toggle does nothing at all on a receiver with no DSP', () => {
    const r = fakeRadio();
    runFunction('dsp_toggle', TRIG, r);
    assert.strictEqual(r.calls.length, 0);
});

t('the tuning lock is mappable, as a press and not a position', () => {
    // The padlock above the waterfall, on a button — worth mapping because a
    // dial living under somebody's hand is one elbow away from retuning a
    // receiver that was parked on purpose.
    //
    // A latching switch wired as a CC arrives as a position; runFunction turns
    // that into a press on the way down and drops the release, so a flick throws
    // the lock once rather than twice.
    const r = fakeRadio();
    assert.ok(catalogue([]).some((f) => f.id === 'tune_lock_toggle'));
    assert.strictEqual(runFunction('tune_lock_toggle', TRIG, r), true);
    assert.deepStrictEqual(r.calls, [['toggleTuneLock']]);
    assert.strictEqual(runFunction('tune_lock_toggle', ABS(1), r), true);
    assert.strictEqual(runFunction('tune_lock_toggle', ABS(0), r), true);
    assert.strictEqual(r.calls.length, 2, 'the release threw the lock a second time');
});

t('squelch off restores a usable threshold rather than the floor', () => {
    const r = fakeRadio();   // starts at the floor, i.e. disabled
    runFunction('squelch_toggle', TRIG, r);
    const [, value] = r.calls[0];
    assert.ok(value > SQUELCH_MIN && value <= SQUELCH_MAX, `${value} is not a working threshold`);
});

// --- dispatch and rate limiting ---------------------------------------------

t('an unmapped control does nothing', () => {
    const d = new Dispatcher();
    const r = fakeRadio();
    assert.strictEqual(d.handle('dial_up', REL(1), r), null);
    assert.strictEqual(r.calls.length, 0);
});

t('a rate-limited mapping drops the events inside its window', () => {
    const d = new Dispatcher();
    d.setMappings({ dial_up: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' } });
    const r = fakeRadio();
    d.handle('dial_up', REL(1), r);
    d.handle('dial_up', REL(1), r);
    d.handle('dial_up', REL(1), r);
    assert.strictEqual(r.calls.length, 1, 'a burst inside the window must collapse to one');
});

t('an unlimited mapping passes every event', () => {
    const d = new Dispatcher();
    d.setMappings({ aux1_tap: { function: 'mode_next', throttleMs: 0, mode: 'none' } });
    const r = fakeRadio();
    d.handle('aux1_tap', TRIG, r);
    d.handle('aux1_tap', TRIG, r);
    assert.strictEqual(r.calls.length, 2);
});

t('rate limits are per control, so one dial cannot gag another', () => {
    const d = new Dispatcher();
    const m = { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' };
    d.setMappings({ dial_up: m, dial_down: m });
    const r = fakeRadio();
    d.handle('dial_up', REL(1), r);
    d.handle('dial_down', REL(-1), r);
    assert.strictEqual(r.calls.length, 2);
});

t('encoders are rate limited by default and buttons are not', () => {
    assert.strictEqual(defaultThrottle('freq_enc_10').mode, 'rate_limit');
    assert.strictEqual(defaultThrottle('zoom_dial').mode, 'rate_limit');
    assert.strictEqual(defaultThrottle('mode_next').throttleMs, 0);
    assert.strictEqual(defaultThrottle('band_20m').throttleMs, 0);
});

t('a function that refuses the event is reported, not silently swallowed', () => {
    const d = new Dispatcher();
    // A fader on a dial function — the panel turns this into the one message
    // that tells the operator to press the encoder switch on the row.
    d.setMappings({ fader: { function: 'freq_enc_1k', throttleMs: 0, mode: 'none' } });
    const seen = [];
    d.onResult = (key, fn, ok) => seen.push([key, fn, ok]);
    d.handle('fader', ABS(0.5), fakeRadio());
    assert.deepStrictEqual(seen, [['fader', 'freq_enc_1k', false]]);
});

// --- v1 compatibility --------------------------------------------------------

t('a v1 mapping record runs unchanged', () => {
    // Exactly what v1's extensions write to localStorage. If this stops working
    // an operator's existing setup silently stops responding.
    const d = new Dispatcher();
    d.setMappings({
        dial_up: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
        aux1_tap: { function: 'mute_toggle', throttleMs: 0, mode: 'none' },
        '176:0:14': { function: 'volume_set', throttleMs: 0, mode: 'none' },
    });
    const r = fakeRadio();
    d.handle('dial_up', REL(2), r);
    d.handle('aux1_tap', TRIG, r);
    d.handle('176:0:14', ABS(1), r);
    assert.deepStrictEqual(r.calls, [['nudge', 2000], ['toggleMute'], ['setVolume', 1]]);
});

// --- VFOs --------------------------------------------------------------------
//
// One sequence rather than four tests: the VFO store is a module singleton, so
// these share it in the order they run — which is also the only way to check
// that switching away stored what was live.

t('a VFO switch stores what is live and recalls what was there', () => {
    const r = fakeRadio();   // 14.074 MHz USB

    // B has never been used, so it starts as a copy of A: nothing to recall,
    // and the receiver is already where the new VFO says it is.
    assert.ok(runFunction('vfo_b', TRIG, r));
    assert.strictEqual(r.calls.length, 0);

    // Move the receiver, then step back to A. A must come back as it was left.
    r.state().tuning.frequency = 7074000;
    r.state().tuning.mode = 'lsb';
    assert.ok(runFunction('vfo_a', TRIG, r));
    assert.strictEqual(r.calls[0][0], 'tuneTo');
    assert.strictEqual(r.calls[0][1].frequency, 14074000);
    assert.strictEqual(r.calls[0][1].mode, 'usb');
});

t('the VFO cycle walks A B C D and wraps in both directions', () => {
    const r = fakeRadio();
    const freq = { A: 1000000, B: 2000000, C: 3000000, D: 4000000 };

    // Leave each VFO on a frequency of its own, so a recall can be told apart
    // from having gone nowhere.
    runFunction('vfo_a', TRIG, r);
    r.state().tuning.frequency = freq.A;
    runFunction('vfo_next', TRIG, r);       // → B
    r.state().tuning.frequency = freq.B;
    runFunction('vfo_next', TRIG, r);       // → C
    r.state().tuning.frequency = freq.C;
    runFunction('vfo_next', TRIG, r);       // → D
    r.state().tuning.frequency = freq.D;

    // Forward from D wraps to A, which stepping away from stored.
    r.calls.length = 0;
    runFunction('vfo_next', TRIG, r);
    assert.deepStrictEqual(r.calls[0][0], 'tuneTo');
    assert.strictEqual(r.calls[0][1].frequency, freq.A);

    // And back from A wraps to D.
    r.calls.length = 0;
    runFunction('vfo_prev', TRIG, r);
    assert.strictEqual(r.calls[0][1].frequency, freq.D);
});

t('v1’s VFO A/B toggle swaps those two and ignores C and D', () => {
    // It is no longer retired: with four slots the old id means what it always
    // meant, which is a swap between the first two.
    const r = fakeRadio();
    runFunction('vfo_c', TRIG, r);          // park somewhere that is not A or B
    r.calls.length = 0;
    assert.ok(runFunction('vfo_ab_toggle', TRIG, r));
    // Whichever of A/B it landed on, a second press must go to the other one
    // rather than back to C.
    r.calls.length = 0;
    assert.ok(runFunction('vfo_ab_toggle', TRIG, r));
    assert.strictEqual(r.calls[0][0], 'tuneTo');
});

// --- station hardware --------------------------------------------------------

t('the rotator and the antenna switch are offered only where they exist', () => {
    const bare = new Set(catalogue([]).map((f) => f.id));
    assert.ok(!bare.has('rot_left_15'), 'no rotator, no rotator functions');
    assert.ok(!bare.has('ant_next'), 'no switch, no antenna functions');

    const both = new Set(catalogue([], {
        rotator: true,
        antenna: { count: 3, labels: ['Beverage', '', 'Vertical'] },
    }).map((f) => f.id));
    assert.ok(both.has('rot_left_15'));
    assert.ok(both.has('rot_dial'));
    assert.ok(both.has('ant_next'));
    assert.ok(both.has('ant_select_3'));
    // Three antennas means three, not the eight a default switch has.
    assert.ok(!both.has('ant_select_4'));
});

t('an antenna keeps its operator’s name, and an unnamed one is still numbered', () => {
    const hw = { rotator: false, antenna: { count: 2, labels: ['Beverage', ''] } };
    assert.strictEqual(functionLabel('ant_select_1', [], hw), '1 — Beverage');
    assert.strictEqual(functionLabel('ant_select_2', [], hw), 'Antenna 2');
});

t('a mapping for hardware this receiver lacks is named, not dropped', () => {
    // Mapping files are carried between receivers. A rotator mapping arriving
    // somewhere without a rotator has to read as itself on a row that says it
    // will not run — an unresolved id would look like a corrupt import.
    assert.strictEqual(functionLabel('rot_left_45', []), 'Rotate left 45°');
    assert.ok(isUnavailable('rot_left_45', []));
    assert.ok(isUnavailable('ant_select_9', [], { antenna: { count: 4, labels: [] } }));
    assert.ok(!isUnavailable('ant_select_3', [], { antenna: { count: 4, labels: [] } }));
    assert.ok(!isUnavailable('volume_set', []));
});

t('the rotator dial is an encoder, so learn records it as one', () => {
    // A CC stored as a fader would send positions, which a dial cannot use.
    assert.ok(isEncoderFunction('rot_dial', []));
    assert.ok(!isEncoderFunction('rot_left_5', []));
});

t('stepping antennas wraps, and the ground counts as before the first', () => {
    assert.strictEqual(nextAntenna(1, 4, +1), 2);
    assert.strictEqual(nextAntenna(4, 4, +1), 1);
    assert.strictEqual(nextAntenna(1, 4, -1), 4);
    assert.strictEqual(nextAntenna(0, 4, +1), 1);   // grounded, forward
    assert.strictEqual(nextAntenna(0, 4, -1), 4);   // grounded, back
    assert.strictEqual(nextAntenna(1, 1, +1), 1);   // a single antenna stays put
});

t('every function id v1 could map is either still live or explicitly retired', () => {
    // The list v1's two extensions share. A name that is neither runnable nor
    // named in RETIRED would import as a row saying nothing.
    const v1 = [
        'freq_enc_10', 'freq_enc_100', 'freq_enc_500', 'freq_enc_1k', 'freq_enc_10k',
        'freq_step_up', 'freq_step_down',
        'mode_usb', 'mode_lsb', 'mode_am', 'mode_fm', 'mode_cw', 'mode_next', 'mode_prev',
        'band_160m', 'band_80m', 'band_60m', 'band_40m', 'band_30m',
        'band_20m', 'band_17m', 'band_15m', 'band_12m', 'band_10m',
        'volume_set', 'bw_low', 'bw_high', 'mute_toggle',
        'nr2_toggle', 'nb_toggle', 'vfo_ab_toggle',
    ];
    const live = new Set(catalogue([]).map((f) => f.id));
    for (const id of v1) {
        const runs = runFunction(id, TRIG, fakeRadio()) || runFunction(id, REL(1), fakeRadio());
        assert.ok(live.has(id) || runs || RETIRED[id], `${id} is neither mappable nor retired`);
    }
});

t('v1’s single “CW” still resolves, to CW-upper as it did there', () => {
    // v2 splits CW into two sidebands, so the old id would otherwise import as
    // an unknown function and silently stop working.
    const r = fakeRadio();
    assert.ok(runFunction('mode_cw', TRIG, r));
    assert.deepStrictEqual(r.calls[0], ['setMode', 'cwu']);
});

// --- encoder / fader ---------------------------------------------------------

t('a CC on an encoder-only function is marked as an encoder', () => {
    // v1 wrote no such flag — its freq_enc_* cases read every value as a detent
    // — so an adopted or imported mapping arrives without one. Read as a fader
    // the wheel sends positions, the function refuses them, and nothing moves.
    const out = normaliseMidiMappings({
        '176:0:14': { function: 'freq_enc_100', throttleMs: 100, mode: 'rate_limit' },
    });
    assert.strictEqual(out['176:0:14'].relative, true);
});

t('a fader mapping and an explicit choice are both left alone', () => {
    const before = {
        '176:0:7': { function: 'volume_set', throttleMs: 0, mode: 'none' },
        '176:0:14': { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit', relative: false },
        '144:0:36': { function: 'freq_enc_10', throttleMs: 100, mode: 'rate_limit' },
    };
    const out = normaliseMidiMappings(before);
    assert.strictEqual(out['176:0:7'].relative, undefined);
    assert.strictEqual(out['176:0:14'].relative, false);
    assert.strictEqual(out['144:0:36'].relative, undefined);
});

t('the dials are the encoder functions, and nothing else is', () => {
    for (const id of ['freq_enc_10', 'freq_enc_100', 'freq_enc_1k', 'zoom_dial']) {
        assert.ok(isEncoderFunction(id), `${id} should be an encoder function`);
    }
    // mode_next takes a detent as a press, but it is a button's function: a CC
    // pad on it must not be recorded as an endless encoder.
    for (const id of ['volume_set', 'bw_low', 'squelch_set', 'mode_next', 'band_20m']) {
        assert.ok(!isEncoderFunction(id), `${id} should not be an encoder function`);
    }
});

t('a pad that sends a CC works the buttons, and its release does not repeat', () => {
    // Plenty of surfaces send 127/0 on a CC rather than a note. v1 ran those
    // through `if (value > 0)`; without the same rule the pad is mapped, looks
    // right and does nothing.
    const r = fakeRadio();
    assert.ok(runFunction('band_20m', ABS(1), r));
    assert.ok(runFunction('band_20m', ABS(0), r));
    assert.deepStrictEqual(r.calls, [['setFrequency', 14074000]]);
});

t('a position on a dial function is refused rather than read as a press', () => {
    // It means an encoder recorded as a fader. Treating it as a press would
    // tune upward whichever way the wheel turned, which is worse than nothing
    // because it hides the mistake.
    const r = fakeRadio();
    assert.strictEqual(runFunction('freq_enc_100', ABS(1), r), false);
    assert.strictEqual(r.calls.length, 0);
});

t('an encoder’s detents reach the radio once it is marked as one', () => {
    // The whole point of the flag: 127 means one detent down, not full scale.
    const rel = normaliseMidiMappings({
        '176:0:14': { function: 'freq_enc_100', throttleMs: 0, mode: 'none' },
    })['176:0:14'].relative;
    const d = new Dispatcher();
    d.setMappings({ '176:0:14': { function: 'freq_enc_100', throttleMs: 0, mode: 'none' } });
    const r = fakeRadio();
    d.handle('176:0:14', rel ? REL(1) : ABS(1 / 127), r);
    d.handle('176:0:14', rel ? REL(-1) : ABS(127 / 127), r);
    assert.deepStrictEqual(r.calls, [['nudge', 100], ['nudge', -100]]);
});

// --- Hamlib mode table -------------------------------------------------------

t('every demodulating mode has a Hamlib name to push at a rig', () => {
    for (const m of MODES) {
        if (m.id === 'iq') continue;
        assert.ok(SDR_TO_HAMLIB[m.id], `${m.id} has no Hamlib equivalent`);
    }
});

t('IQ is reachable by name even though the cycle skips it', () => {
    // Skipping it in MODE_CYCLE is about a blind walk landing somewhere
    // surprising, not about putting IQ out of reach: a button mapped to it
    // deliberately still has to work.
    const r = fakeRadio();
    runFunction('mode_iq', TRIG, r);
    assert.deepStrictEqual(r.calls[0], ['setMode', 'iq']);
});

t('IQ has no Hamlib name, and that is the instruction not to push one', () => {
    // No transceiver has an IQ mode — it is baseband from the receiver, not
    // something a rig can be put into. _pushMode reads the absence as "skip"
    // rather than falling back to mode.toUpperCase(), which would send every
    // rig an 'IQ' it rejects and raise an error toast per mode change.
    assert.strictEqual(SDR_TO_HAMLIB.iq, undefined);
});

t('the CW sidebands do not collapse onto one Hamlib mode', () => {
    // CW and CWR are different rig modes; mapping both to CW would flip the
    // rig's sideband every time the receiver changed.
    assert.notStrictEqual(SDR_TO_HAMLIB.cwu, SDR_TO_HAMLIB.cwl);
});

at('a spun rotator dial sends one bearing, not one per detent', async () => {
    // /api/rotctl/position is rate limited to one request a second per address,
    // and a dial sends far more than that. The detents have to accumulate into
    // a bearing rather than being thrown away by a throttle — the surplus
    // detents are the turn. This is the whole reason the sending lives outside
    // the dispatcher.
    const posts = [];
    globalThis.localStorage = {
        getItem: (k) => (k === 'rotctl_password' ? 'secret' : null),
        setItem: () => {},
        removeItem: () => {},
    };
    globalThis.fetch = async (url, opts) => {
        if (url === '/api/rotctl/status') {
            return { ok: true, json: async () => ({ position: { azimuth: 100 }, read_only: false }) };
        }
        posts.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ success: true }) };
    };
    const msgs = [];
    const off = hardwareMessages.on('message', (m) => msgs.push(m));

    for (let i = 0; i < 10; i += 1) rotatorStep(5);       // a fast spin: +50°
    await new Promise((r) => setTimeout(r, 1400));
    off();

    assert.strictEqual(posts.length, 1, `sent ${posts.length} bearings, expected 1`);
    assert.strictEqual(posts[0].azimuth, 150);
    assert.strictEqual(posts[0].password, 'secret');
    assert.ok(msgs.some((m) => m.text.includes('150')), 'the log says where it was sent');
});

at('a rotator step with no password saved says so and sends nothing', async () => {
    const posts = [];
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.fetch = async (url, opts) => {
        if (url === '/api/rotctl/status') {
            return { ok: true, json: async () => ({ position: { azimuth: 0 }, read_only: false }) };
        }
        posts.push(opts);
        return { ok: true, json: async () => ({ success: true }) };
    };
    const msgs = [];
    const off = hardwareMessages.on('message', (m) => msgs.push(m));

    rotatorStep(15);
    await new Promise((r) => setTimeout(r, 1400));
    off();

    assert.strictEqual(posts.length, 0);
    assert.ok(msgs.some((m) => /password/i.test(m.text)), 'the log explains why nothing moved');
});

at('two quick antenna presses land two along, not one plus a refusal', async () => {
    // /api/ant-switch/command is rate limited to one a second too, and unlike
    // the rotator the steps are discrete: pressing "next" twice has to mean two
    // antennas along, not one selected and one thrown away.
    const posts = [];
    globalThis.localStorage = {
        getItem: (k) => (k === 'ant_switch_password' ? 'secret' : null),
        setItem: () => {},
        removeItem: () => {},
    };
    globalThis.fetch = async (url, opts) => {
        if (url === '/api/ant-switch/status') {
            return {
                ok: true,
                json: async () => ({
                    enabled: true, num_antennas: 4, antenna_labels: ['A', 'B', 'C', 'D'],
                    selected: [1], grounded: false,
                }),
            };
        }
        posts.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ success: true, selected: [3], grounded: false }) };
    };

    antennaStep(+1);
    antennaStep(+1);
    await new Promise((r) => setTimeout(r, 1400));

    assert.strictEqual(posts.length, 1, `sent ${posts.length} commands, expected 1`);
    assert.strictEqual(posts[0].antenna, 3);
});

// The asynchronous ones last, so the synchronous output above stays in order.
(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} radio control tests passed`);
})();
