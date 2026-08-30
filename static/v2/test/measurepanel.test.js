// The Measure panel and its overlay actually render, in every state they have.
//
// The class this catches is the one nothing else here can: a component used
// before it is defined, a helper called with its arguments the other way round,
// a reading destructured before the check that there is one. All of those build
// cleanly, pass the arithmetic tests next door, and blank the panel — or worse,
// blank the spectrum, since the overlay is drawn inside it.
//
// The states matter more here than in most panels because the tool has several
// that are not "has data" or "has none": stopped with a reading still on screen,
// running with no region yet, a region panned off the view, a region zoomed
// down below the resolution anything can be measured at. Each draws different
// words and each is reachable by pressing one button.

const assert = require('assert');

// Before the bundle: the module graph behind the panel reaches the display
// settings, the radio and the tool's own stored preferences, and all of them
// read the browser at import time.
const stored = {};
globalThis.localStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = String(v); },
    removeItem: (k) => { delete stored[k]; },
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    deep, render, reset, walk, words, MeasurePanel, MeasureOverlay, measure, tool,
} = require('./.build/measurepanel.cjs');

// words() joins only the *string* children of a tree, so a `{count}` rendered
// as a number vanishes from it — and most of this panel's readings are numbers.
// This is the same walk with numbers kept.
function say(node) {
    return deep(node).flatMap((n) => {
        const c = (n.children && n.children.length)
            ? n.children
            : ((n.props && n.props.children != null) ? [n.props.children] : []);
        return c.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
    }).join(' ');
}

/** The <button> whose label reads as `label` — not the <span> inside it. */
function buttonSaying(tree, label) {
    return deep(tree).filter((n) => n.type === 'button' && say(n).includes(label));
}

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// The same view the arithmetic tests use: 100 bins of 10 Hz on 14.200 MHz.
const VIEW = { centerFreq: 14_200_000, binCount: 100, binBandwidth: 10, span: 1000 };
const N = 100;
const SIGNAL = (() => {
    const a = new Float32Array(N).fill(-100);
    for (let i = 0; i < N; i++) a[i] = Math.max(a[i], -100 + 40 - Math.abs(i - 50) * 4);
    return a;
})();
const REGION = { loHz: measure.binToHz(VIEW, N, 40), hiHz: measure.binToHz(VIEW, N, 60) };

/** A run with some frames in it, so the "over the run" block has something. */
function withRun(result, frames = 12) {
    const run = measure.newRun(1000);
    for (let i = 0; i < frames; i++) {
        measure.accumulate(run, result.stats, 1000 + i * 200, { width: result.headline });
    }
    return { ...result, run };
}

/** A full reading of the fixture signal, through the same path the engine uses. */
const fixture = () => measure.readingOf(
    SIGNAL, VIEW, REGION, tool.measureSettings(), null, 5000,
);

// One object answers both useRadio and useDisplay — the stub's useContext has
// no way to tell two contexts apart, and neither component cares.
function context(over) {
    return {
        tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        view: VIEW,
        running: true,
        actions: {
            setFrequency() {}, setBandwidth() {}, setSpectrumView() {},
        },
        ...over,
    };
}

/** Put the store in a known state before a render. */
function state({ active = false, selection = null, result = null, drawing = false, frozen = false }) {
    tool.resetMeasure();
    tool.setMeasureState({ active, drawing, frozen, selection });
    tool.setMeasureResult(result);
}

// --- the panel ---------------------------------------------------------------

t('it renders before anything has been measured, and says what to do', () => {
    state({});
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const text = words(tree);
    assert.ok(/Start/.test(text), `no Start button: ${text}`);
    assert.ok(/drag across the spectrum/i.test(text), `no instruction: ${text}`);
});

t('it renders running with no region yet', () => {
    state({ active: true });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const text = words(tree);
    assert.ok(/Stop/.test(text), 'the button should offer Stop while it is running');
    assert.ok(/draw a region/i.test(text), `no instruction: ${text}`);
});

t('it renders a full reading, with the widths and the run', () => {
    const r = withRun(fixture());
    state({ active: true, selection: REGION, result: r });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const text = say(tree);
    for (const label of ['Width', 'SNR', 'Peak', 'Noise floor', 'Occupancy', 'Frames']) {
        assert.ok(text.includes(label), `no ${label} in the readout: ${text}`);
    }
    // Every level the settings asked for is drawn as its own row.
    const labels = deep(tree)
        .filter((n) => n && n.props && n.props.className === 'measure-row__label')
        .map((n) => say(n));
    // Loosely, because say() joins the pieces of a label with spaces: what is
    // being asserted is that the level and the words are both there.
    for (const d of tool.measureSettings().xDb) {
        assert.ok(labels.some((l) => new RegExp(`${d}\\s+dB width`).test(l)),
            `no −${d} dB row: ${JSON.stringify(labels)}`);
    }
    // ...and the occupied bandwidth and the shape factor beside them.
    assert.ok(labels.some((l) => /Occupied/.test(l)), JSON.stringify(labels));
    assert.ok(labels.some((l) => /Shape factor/.test(l)), JSON.stringify(labels));
    // The run block reports how many frames it is speaking for.
    assert.ok(/12\s+frames/.test(text), `no sample size: ${text}`);
});

t('a level is never printed as though the receiver were calibrated', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const units = deep(tree)
        .filter((n) => n && n.props && String(n.props.className || '') === 'readout__unit')
        .map((n) => words(n));
    // Peak level, noise floor, channel power, density and the region median are
    // all on the receiver's own scale and all have to say so.
    const rel = units.filter((u) => /rel/.test(u));
    assert.ok(rel.length >= 4, `expected several "rel" units, got ${JSON.stringify(units)}`);
    // ...while SNR and the other differences must not be marked relative, since
    // they are not.
    assert.ok(units.includes('dB'), `differences should be plain dB: ${JSON.stringify(units)}`);
});

t('each way of having no reading says which one it is, and they differ', () => {
    const said = {};
    for (const reason of ['outside', 'narrow', 'nodata']) {
        const sel = reason === 'outside'
            ? { loHz: 1_000_000, hiHz: 1_001_000 }
            : { loHz: measure.binToHz(VIEW, N, 50), hiHz: measure.binToHz(VIEW, N, 51) };
        const result = reason === 'nodata'
            ? measure.readingOf(null, VIEW, REGION, {}, null, 0)
            : measure.readingOf(SIGNAL, VIEW, sel, {}, null, 0);
        assert.strictEqual(result.reason, reason, 'the fixture should produce the reason under test');
        state({ active: true, selection: REGION, result });
        reset();
        said[reason] = words(render(MeasurePanel, {}, context()).tree);
    }
    assert.ok(/pan back/i.test(said.outside), said.outside);
    assert.ok(/zoom in/i.test(said.narrow), said.narrow);
    assert.ok(/waiting/i.test(said.nodata), said.nodata);
});

t('a peak on the edge of the region is called out, because the widths are then bounds', () => {
    // A region that starts on the peak: the signal carries on past it.
    const clipped = { loHz: measure.binToHz(VIEW, N, 50), hiHz: measure.binToHz(VIEW, N, 70) };
    const r = measure.readingOf(SIGNAL, VIEW, clipped, tool.measureSettings(), null, 0);
    assert.strictEqual(r.stats.peakAtEdge, true, 'the fixture should clip the peak');
    state({ active: true, selection: clipped, result: r });
    reset();
    const text = words(render(MeasurePanel, {}, context()).tree);
    assert.ok(/lower bound/i.test(text), `no warning about the edge: ${text}`);
});

t('it renders stopped with the last reading still on screen', () => {
    // Stopping is how the numbers get read, so they have to survive it.
    state({ active: false, selection: REGION, result: withRun(fixture()) });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const text = words(tree);
    assert.ok(/Start/.test(text), 'stopped, so the button offers Start again');
    assert.ok(/Occupancy/.test(text), `the reading should still be there: ${text}`);
});

t('the minimal view keeps the readings and drops the controls', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    reset();
    const full = say(render(MeasurePanel, {}, context()).tree);
    reset();
    const min = say(render(MeasurePanel, { minimal: true }, context()).tree);
    // The rule the other panels follow: a cut-down panel is a readout.
    assert.ok(/SNR/.test(min), `the readings must survive: ${min}`);
    assert.ok(/Occupancy/.test(min), `so must the run: ${min}`);
    assert.ok(/Tune to peak/.test(full), 'the full view has the actions');
    assert.ok(!/Tune to peak/.test(min), `the minimal view should not: ${min}`);
    assert.ok(/Averaging/.test(full), 'the full view has the settings');
    assert.ok(!/Averaging/.test(min), `the minimal view should not: ${min}`);
});

t('Filter to region is refused while the dial is outside it', () => {
    state({ active: true, selection: REGION, result: fixture() });

    reset();
    const inside = buttonSaying(render(MeasurePanel, {}, context()).tree, 'Filter to region');
    assert.strictEqual(inside.length, 1, 'the button should be there');
    assert.ok(!inside[0].props.disabled, 'the dial is inside the region');

    reset();
    const outside = buttonSaying(render(MeasurePanel, {}, context({
        tuning: { frequency: 14_100_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    })).tree, 'Filter to region');
    // The passband is set in offsets from the dial, so a region the dial is not
    // in would ask for a filter with the signal outside it.
    assert.ok(outside[0].props.disabled, 'the dial is a hundred kilohertz away');
});

// --- the overlay -------------------------------------------------------------

t('the overlay draws nothing at all when the tool has never been used', () => {
    state({});
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    assert.strictEqual(tree, null, 'an unused tool must not put anything over the spectrum');
});

t('the overlay draws the badge and the region, with the callipers on it', () => {
    state({ active: true, selection: REGION, result: fixture() });
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    const classes = deep(tree).map((n) => String((n.props && n.props.className) || ''));
    assert.ok(classes.some((c) => c.startsWith('measure__band')), 'no region');
    assert.ok(classes.filter((c) => c === 'measure__edge').length === 2, 'both edges');
    assert.ok(classes.includes('measure__peak'), 'no peak line');
    assert.ok(classes.some((c) => c.includes('measure-cal--width')), 'no width calliper');
    assert.ok(classes.some((c) => c.includes('measure-cal--obw')), 'no occupied-bandwidth calliper');
    assert.ok(classes.includes('measure-hud'), 'no badge');
    // The badge is the way out of the mode, so it always carries a Stop.
    assert.ok(classes.includes('measure-hud__btn measure-hud__btn--stop'), 'no stop button');
});

t('a region off the side of the view loses the edge that is off it', () => {
    // The half-region case: the fill is clipped to the view and the edge that
    // is not in it is not drawn, which is what says the region carries on.
    const half = { loHz: VIEW.centerFreq - 5000, hiHz: measure.binToHz(VIEW, N, 60) };
    state({ active: true, selection: half, result: null });
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    const classes = deep(tree).map((n) => String((n.props && n.props.className) || ''));
    assert.strictEqual(classes.filter((c) => c === 'measure__edge').length, 1, 'one edge only');
});

t('a region entirely off the view draws no region, and still says so', () => {
    const away = { loHz: 1_000_000, hiHz: 1_001_000 };
    state({
        active: true,
        selection: away,
        result: measure.readingOf(SIGNAL, VIEW, away, {}, null, 0),
    });
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    const classes = deep(tree).map((n) => String((n.props && n.props.className) || ''));
    assert.ok(!classes.some((c) => c.startsWith('measure__band')), 'nothing to draw');
    assert.ok(/pan back/i.test(words(tree)), `the badge should say why: ${words(tree)}`);
});

t('the region stays on the spectrum after the tool is stopped, without the badge', () => {
    state({ active: false, selection: REGION, result: fixture() });
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    const classes = deep(tree).map((n) => String((n.props && n.props.className) || ''));
    assert.ok(classes.some((c) => c.includes('measure__band--held')),
        'the region has to survive stopping — that is what stopping is for');
    assert.ok(!classes.includes('measure-hud'),
        'the badge says the display\'s presses are taken, and stopped they are not');
});

t('a drag in progress reads as one', () => {
    state({ active: true, selection: REGION, drawing: true, result: fixture() });
    reset();
    const { tree } = render(MeasureOverlay, { view: VIEW, bottom: 26 }, context());
    const classes = deep(tree).map((n) => String((n.props && n.props.className) || ''));
    assert.ok(classes.some((c) => c.includes('measure__band--drawing')), 'no drawing state');
});

console.log(`\n${pass} passed`);
