// The tuning step, remembered per mode.
//
// One live figure, shared by everything that tunes — the ± buttons, the drum,
// click-to-tune, the wheel, the keyboard, a control surface — and a record of
// what it was last set to in each mode, so 500 Hz on USB and 9 kHz on AM both
// survive switching between them.
//
// Three things have to hold together for that, and each of them is a place it
// has broken before it was written: a choice has to say which mode it was made
// in (the panels), the record has to be keyed and validated (withTuneStep), and
// something mounted whether or not a panel is has to put it back (TuneStepWatch).
// See hookStub.js for what "renders" means here.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
globalThis.performance = globalThis.performance || { now: () => 0 };
// render() runs the mount effects, and the pad's reach a meter poll. Left on
// Node's real timer they fire after the last assertion, against a player the
// stub never built.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// The module graph behind a panel reaches the display settings and the radio,
// and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    deep, render, reset,
    TuneStepWatch, ReceiverPanel, MultipadPanel, DEFAULTS, withTuneStep, TUNING_STEPS,
    DEFAULT_STEP_BY_MODE, MODES, defaultStepFor,
} = require('./.build/tunestep.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers useRadio, useDisplay and useLayout alike — the stub's
// useContext cannot tell contexts apart, and none of them minds. `chose` and
// `patched` collect the two ways the step can move.
function context(over) {
    const chose = [];
    const patched = [];
    return {
        tuning: {
            mode: 'usb', frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700,
        },
        running: true,
        chose,
        patched,
        squelch: { enabled: false, value: -20 },
        agc: null,
        meters: { current: { snr: 12, snrHistory: [12, 12, 12] } },
        dsp: { enabled: false, filter: '', schemas: [] },
        noise: { nr: { enabled: false, type: 'lsa' }, nb: { enabled: false } },
        spectrumConn: { on: () => () => {}, binCount: 1024, minBinBandwidthForUI: () => 10 },
        view: { centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024 },
        catalog: { bookmarks: [], local: [], dx: [], cw: [], voice: [], confirmed: [] },
        actions: {
            setSquelch() {}, autoSquelch() {}, setBandwidth() {}, setFrequency() {},
            setMode() {}, setDsp() {}, setNoise() {}, setSpectrumView() {}, stepBy() {},
        },
        ...DEFAULTS,
        set: (patch) => patched.push(patch),
        setTuneStep: (hz, mode) => chose.push([hz, mode]),
        serverInfo: {},
        list: [],
        ...over,
    };
}

// --- the record --------------------------------------------------------------

t('a step is remembered against the mode it was chosen in', () => {
    const s = withTuneStep({ ...DEFAULTS }, 100, 'usb');
    assert.strictEqual(s.tuneStep, 100, 'the live step moved');
    assert.deepStrictEqual(s.tuneStepByMode, { usb: 100 }, 'and was recorded');
});

t('each mode keeps its own, and a second choice replaces only that one', () => {
    let s = withTuneStep({ ...DEFAULTS }, 100, 'usb');
    s = withTuneStep(s, 9000, 'am');
    assert.deepStrictEqual(s.tuneStepByMode, { usb: 100, am: 9000 });
    s = withTuneStep(s, 10000, 'am');
    assert.deepStrictEqual(s.tuneStepByMode, { usb: 100, am: 10000 }, 'USB untouched');
    assert.strictEqual(s.tuneStep, 10000);
});

t('the record is copied, not mutated', () => {
    // The state is React's, and a map edited in place would not re-render the
    // watch that reads it — the step would come back only after some other
    // setting happened to move.
    const before = { ...DEFAULTS, tuneStepByMode: { usb: 100 } };
    const s = withTuneStep(before, 9000, 'am');
    assert.deepStrictEqual(before.tuneStepByMode, { usb: 100 });
    assert.notStrictEqual(s.tuneStepByMode, before.tuneStepByMode);
});

t('a step with no mode moves the live figure and records nothing', () => {
    const s = withTuneStep({ ...DEFAULTS }, 1000, '');
    assert.strictEqual(s.tuneStep, 1000);
    assert.deepStrictEqual(s.tuneStepByMode, {});
});

t('a figure that cannot be tuned by changes nothing at all', () => {
    // A stored 0 or NaN leaves every step button in the interface moving the
    // dial nowhere, and this is reached from a select, a surface and the bridge.
    const before = { ...DEFAULTS, tuneStep: 500 };
    for (const bad of [0, -100, NaN, null, undefined, 'wide', {}]) {
        const s = withTuneStep(before, bad, 'usb');
        assert.strictEqual(s, before, String(bad));
    }
});

t('a numeric string is taken, because a <select> gives one', () => {
    const s = withTuneStep({ ...DEFAULTS }, '9000', 'am');
    assert.strictEqual(s.tuneStep, 9000);
    assert.deepStrictEqual(s.tuneStepByMode, { am: 9000 });
});

// --- putting it back ---------------------------------------------------------

/** What the watch does on the way into `mode`, with `steps` on record. */
function watch(mode, steps) {
    reset();
    const ctx = context({ tuning: { mode }, tuneStepByMode: steps });
    render(TuneStepWatch, {}, ctx);
    return ctx.patched;
}

t('the mode’s own step is put back on the way into it', () => {
    assert.deepStrictEqual(watch('am', { usb: 100, am: 9000 }), [{ tuneStep: 9000 }]);
});

t('a mode nobody has chosen a step for gets its own default', () => {
    // The bug this replaced: an unrecorded mode kept whatever step was in force,
    // so one choice made anywhere followed the operator into every mode they had
    // not visited yet and the only cure was to set all of them by hand.
    assert.deepStrictEqual(watch('cwu', { usb: 100 }), [{ tuneStep: 100 }]);
    assert.deepStrictEqual(watch('am', { usb: 100 }), [{ tuneStep: 5000 }]);
    assert.deepStrictEqual(watch('usb', {}), [{ tuneStep: 500 }]);
    assert.deepStrictEqual(watch('nfm', undefined), [{ tuneStep: 5000 }]);
});

t('a chosen step still beats the default', () => {
    // The record is consulted first, or the defaults would make the <select>
    // useless in every mode that has one.
    assert.deepStrictEqual(watch('am', { am: 9000 }), [{ tuneStep: 9000 }]);
    assert.deepStrictEqual(watch('cwu', { cwu: 1 }), [{ tuneStep: 1 }]);
});

t('a corrupt record falls through to the default, not to nothing', () => {
    for (const bad of [0, -1, 'wide', null]) {
        assert.deepStrictEqual(watch('am', { am: bad }), [{ tuneStep: 5000 }], String(bad));
    }
});

t('a mode with no default of its own keeps the step in force', () => {
    // A mode id this build has never heard of — a server-side addition, say.
    // Guessing 500 Hz for it would be worse than leaving the dial's grid alone.
    assert.deepStrictEqual(watch('drm', {}), []);
});

t('with no mode yet it does nothing', () => {
    // Before the first status, tuning.mode can be absent; '' must not be looked
    // up as a key.
    assert.deepStrictEqual(watch('', { '': 9000 }), []);
});

t('the watch draws nothing', () => {
    reset();
    const { tree } = render(TuneStepWatch, {}, context());
    assert.strictEqual(tree, null);
});

// --- the panels that offer the choice ----------------------------------------

/** The step <select> a panel draws, and the context it was drawn with. */
function stepSelect(Panel, over, className) {
    reset();
    const ctx = context(over);
    const { tree } = render(Panel, { minimal: true }, ctx);
    const node = deep(tree).find((n) => n.props?.className === className
        && Array.isArray(n.props?.children)
        && n.props.children.length === TUNING_STEPS.length);
    assert.ok(node, 'the step select is drawn');
    return { node, ctx };
}

t('the Receiver panel’s step select says which mode the choice was made in', () => {
    const { node, ctx } = stepSelect(ReceiverPanel, { tuning: { mode: 'am' } }, 'select');
    node.props.onChange({ target: { value: '9000' } });
    assert.deepStrictEqual(ctx.chose, [[9000, 'am']]);
    assert.deepStrictEqual(ctx.patched, [], 'and not as a bare tuneStep patch');
});

t('the Multipad’s does too, so the two cannot disagree', () => {
    // Two selects for one setting: the bug this guards is one of them going on
    // writing the step without a mode, which would leave the record describing
    // a choice somebody made somewhere else.
    const { node, ctx } = stepSelect(MultipadPanel, { tuning: { mode: 'lsb' } }, 'pad-wheel__step');
    node.props.onChange({ target: { value: '100' } });
    assert.deepStrictEqual(ctx.chose, [[100, 'lsb']]);
    assert.deepStrictEqual(ctx.patched, []);
});

t('both show the live step, whatever mode it came from', () => {
    for (const [Panel, cls] of [[ReceiverPanel, 'select'], [MultipadPanel, 'pad-wheel__step']]) {
        const { node } = stepSelect(Panel, { tuneStep: 9000, tuning: { mode: 'am' } }, cls);
        assert.strictEqual(Number(node.props.value), 9000, cls);
    }
});

// --- the round trip ----------------------------------------------------------

t('USB at 100 Hz and AM at 9 kHz survive switching between them', () => {
    // The whole feature in one: choose in a panel, store, switch mode, and the
    // watch puts back what the panel would draw next.
    let state = { ...DEFAULTS };
    const choose = (hz, mode) => { state = withTuneStep(state, hz, mode); };
    const enter = (mode) => {
        const patch = watch(mode, state.tuneStepByMode);
        if (patch.length) state = { ...state, ...patch[0] };
        return state.tuneStep;
    };

    choose(100, 'usb');
    assert.strictEqual(enter('am'), 5000, 'AM has no step of its own yet, so its default');
    choose(9000, 'am');
    assert.strictEqual(enter('usb'), 100, 'back to USB and its 100 Hz');
    assert.strictEqual(enter('am'), 9000, 'and to AM and its 9 kHz');
    assert.strictEqual(enter('cwu'), 100, 'CW never chose one, so its own default');
    assert.strictEqual(enter('am'), 9000, 'and AM’s choice is still AM’s');
});


// --- the defaults themselves -------------------------------------------------

t('every mode has a default step', () => {
    // A mode added to MODES without one here is a mode that silently goes back
    // to inheriting, which is the bug this table exists to fix.
    for (const m of MODES) {
        assert.ok(defaultStepFor(m.id), m.id + ' has no default step');
    }
});

t('every default is a step the panels can draw', () => {
    // The <select> is built from TUNING_STEPS, so a default outside that list
    // would show as an empty box until the operator picked something.
    for (const [mode, hz] of Object.entries(DEFAULT_STEP_BY_MODE)) {
        assert.ok(TUNING_STEPS.includes(hz), mode + ' is not a listed step: ' + hz);
    }
});

t('SSB keeps the step this interface has always used', () => {
    // Changing this one would move the dial's grid under everybody, which is not
    // what the per-mode defaults are for.
    assert.strictEqual(defaultStepFor('usb'), DEFAULTS.tuneStep);
    assert.strictEqual(defaultStepFor('lsb'), DEFAULTS.tuneStep);
});

t('an unknown or absent mode has no default', () => {
    for (const bad of ['', null, undefined, 'nonesuch', 42]) {
        assert.strictEqual(defaultStepFor(bad), null, String(bad));
    }
});


console.log(`\n${pass} passed`);
