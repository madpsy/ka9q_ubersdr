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
// The panel reads the display's frame cap, which asks whether this is a
// touchscreen — the same question the Signal panel's traces ask.
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

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

/** Every readout in a tree, as `{label, num, unit}`. */
function readouts(tree) {
    return deep(tree)
        .filter((n) => n && n.props && n.props.className === 'readout')
        .map((n) => {
            const parts = deep(n).filter((x) => x && x.props);
            const of = (cls) => {
                const hit = parts.find((x) => String(x.props.className || '') === cls);
                return hit ? say(hit).trim() : '';
            };
            return { label: of('readout__label'), num: of('readout__num'), unit: of('readout__unit') };
        });
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

// The same region with two tones in it, so the reading has a tone spacing. That
// row is the one that used to come and go on a real signal — the peak finder
// calls two tones two on one frame and one on the next — and everything under
// it moved when it did.
const TWO_TONE = (() => {
    const a = new Float32Array(N).fill(-110);
    for (const at of [45, 55]) {
        for (let i = -2; i <= 2; i++) a[at + i] = -110 + 45 - Math.abs(i) * 8;
    }
    return a;
})();

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

// The cards are two to a row in a dock column that can be 220px wide, so about
// eighty pixels of usable width each. Two things used to run out past the right
// edge of a card and over its neighbour, and both are checked here rather than
// left to be noticed on somebody's screen.

t('a full-precision frequency gets the whole row, because it cannot share one', () => {
    state({ active: true, selection: REGION, result: fixture() });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const wide = deep(tree).filter((n) => n.props && n.props.className === 'measure-wide');
    assert.ok(wide.length >= 1, 'no full-width cards at all');

    // formatFreqExact always writes six decimal places, so this matches a
    // frequency at full precision and nothing else the panel prints — an offset
    // of "+10 Hz" or a width of "2.40 kHz" is not one of these.
    const EXACT = /\d\.\d{6} MHz/g;
    const all = (say(tree).match(EXACT) || []).length;
    const inWide = (wide.map(say).join(' ').match(EXACT) || []).length;
    assert.ok(all > 0, 'the fixture should print at least one exact frequency');
    assert.strictEqual(inWide, all, 'a frequency reading is in a half-width card');
});

t('no unit is long enough to push a reading out of its card', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const units = deep(tree)
        .filter((n) => n && n.props && n.props.className === 'readout__unit')
        .map((n) => say(n).trim())
        .filter(Boolean);
    assert.ok(units.length >= 6, `expected units on most cards, got ${JSON.stringify(units)}`);
    // Ten characters at the unit's 10px is about sixty pixels, which still
    // leaves room for a number beside it. Anything longer belongs in the label:
    // "Occupancy over 6 dB" reads correctly and "% over 6 dB" does not, since
    // the unit of that reading is per cent.
    const long = units.filter((u) => u.length > 10);
    assert.deepStrictEqual(long, [], 'units this long belong in the label');
});

t('a decibel reading is the same width whatever its magnitude', () => {
    // The bug: a noise floor crossing −100 dB gains a digit, which pushes its
    // unit onto a second line, which makes the card a line taller, which moves
    // every card below it — several times a second, on a panel somebody is
    // trying to read a number off.
    const floorOf = (db) => {
        const a = new Float32Array(N).fill(db);
        for (let i = 0; i < N; i++) a[i] = Math.max(a[i], db + 40 - Math.abs(i - 50) * 4);
        return a;
    };
    const numFor = (db) => {
        state({
            active: true,
            selection: REGION,
            result: measure.readingOf(floorOf(db), VIEW, REGION, tool.measureSettings(), null, 0),
        });
        reset();
        const row = readouts(render(MeasurePanel, {}, context()).tree)
            .find((r) => /NOISE FLOOR|Noise floor/i.test(r.label));
        assert.ok(row, 'no Noise floor readout');
        return row.num;
    };

    const two = numFor(-99.5);
    const three = numFor(-100.5);
    assert.notStrictEqual(two, three, 'the fixture should actually change the reading');
    assert.strictEqual(two.length, three.length,
        `"${two}" and "${three}" must occupy the same columns`);
});

t('no reading is long enough to reflow the card it is in', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    // A card is about nine characters of the value's monospace in a narrow dock
    // column. A full-precision frequency is longer than that and is why those
    // cards take the whole row instead; everything else has to fit.
    const EXACT = /\d\.\d{6} MHz/;
    const long = readouts(tree)
        .filter((r) => r.num && !EXACT.test(r.num) && r.num.length > 10)
        .map((r) => `${r.label}: ${r.num}`);
    assert.deepStrictEqual(long, [], 'a value this long needs its own row, or to be one number');
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

t('every reading keeps its row whether or not it has a value', () => {
    // The complaint this fixes: Tone spacing appeared and disappeared, and
    // everything below it shifted each time. The rows are the same rows either
    // way, and the ones with nothing to say say so.
    const rows = (result) => {
        state({ active: true, selection: REGION, result });
        reset();
        const { tree } = render(MeasurePanel, {}, context());
        return deep(tree)
            .filter((n) => n && n.props && n.props.className === 'measure-row__label')
            .map((n) => say(n));
    };

    const settings = tool.measureSettings();
    const two = measure.readingOf(TWO_TONE, VIEW, REGION, settings, null, 0);
    const one = measure.readingOf(SIGNAL, VIEW, REGION, settings, null, 0);
    assert.ok(two.fsk, 'the two-tone fixture should have a shift');
    assert.strictEqual(one.fsk, null, 'the single-tone fixture should not');

    assert.deepStrictEqual(rows(one), rows(two), 'the rows moved when a reading came and went');
    assert.ok(rows(one).some((l) => /Tone spacing/.test(l)), 'no Tone spacing row without a shift');
});

t('a row with nothing to say says so, rather than saying nothing', () => {
    const one = measure.readingOf(SIGNAL, VIEW, REGION, tool.measureSettings(), null, 0);
    state({ active: true, selection: REGION, result: one });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    // Pair each label with the value beside it: they are siblings in the row.
    const values = deep(tree)
        .filter((n) => n && n.props && String(n.props.className || '').startsWith('measure-row__value'))
        .map((n) => say(n).trim());
    assert.ok(values.includes('—'), `expected a dash for the missing shift: ${JSON.stringify(values)}`);
    // ...and never a zero standing in for one.
    assert.ok(!values.includes('0 Hz'), `a missing reading must not read as zero: ${JSON.stringify(values)}`);
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

// --- cards that open into charts ---------------------------------------------

/** Every card head in the tree, by the label it carries. */
function heads(tree) {
    return deep(tree).filter((n) => n.type === 'button'
        && String((n.props && n.props.className) || '').startsWith('measure-card__head'));
}

const openCards = (tree) => deep(tree).filter((n) => n && n.props
    && String(n.props.className || '').includes('measure-card') && /is-open/.test(n.props.className));

t('a reading with a shape is a card you can press; one without is not', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const labels = heads(tree).map((n) => say(n));
    assert.ok(labels.some((l) => /SNR/.test(l)), `SNR should open a chart: ${labels}`);
    assert.ok(labels.some((l) => /Occupancy/.test(l)), `Occupancy should: ${labels}`);
    // Bins and Resolution are constants. An affordance that does nothing is
    // worse than none, because it has to be tried before it can be ruled out.
    assert.ok(!labels.some((l) => /\bBins\b/.test(l)), `Bins must not: ${labels}`);
    assert.ok(!labels.some((l) => /Resolution/.test(l)), `Resolution must not: ${labels}`);
});

t('nothing has been measured yet, so no card offers a chart of it', () => {
    // A run with no frames has no series behind any card. The cards stay and
    // stay inert rather than opening an empty box.
    state({ active: true, selection: REGION, result: fixture() });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    assert.strictEqual(heads(tree).length, 0);
    // ...and the readings are still all there.
    assert.ok(/SNR/.test(say(tree)));
});

t('exactly one card is open, and it is the one the settings name', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    tool.saveMeasureSettings({ expanded: 'snr' });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const open = openCards(tree);
    assert.strictEqual(open.length, 1, 'one chart at a time — ten of them is a wall');
    assert.ok(/SNR/.test(say(open[0])), `the wrong card is open: ${say(open[0])}`);
    // An open card takes the whole row: a chart in half a dock column is not a
    // chart of anything.
    assert.ok(/measure-wide/.test(open[0].props.className), open[0].props.className);
});

t('another card opens, and closing leaves none open', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    tool.saveMeasureSettings({ expanded: 'floor' });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    assert.ok(/Noise floor/.test(say(openCards(tree)[0])));

    tool.saveMeasureSettings({ expanded: '' });
    reset();
    assert.strictEqual(openCards(render(MeasurePanel, {}, context()).tree).length, 0);
    tool.saveMeasureSettings({ expanded: 'snr' });
});

t('pressing a card is what changes which one is open', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    tool.saveMeasureSettings({ expanded: 'snr' });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    const floor = heads(tree).find((n) => /Noise floor/.test(say(n)));
    assert.ok(floor, 'no Noise floor card');
    floor.props.onClick();
    assert.strictEqual(tool.measureSettings().expanded, 'floor');
    // Pressing the open one again closes it rather than reopening it.
    reset();
    const again = heads(render(MeasurePanel, {}, context()).tree)
        .find((n) => /Noise floor/.test(say(n)));
    again.props.onClick();
    assert.strictEqual(tool.measureSettings().expanded, '');
    tool.saveMeasureSettings({ expanded: 'snr' });
});

t('a card that names a chart this build dropped simply opens nothing', () => {
    state({ active: true, selection: REGION, result: withRun(fixture()) });
    tool.saveMeasureSettings({ expanded: 'a-card-this-build-dropped' });
    reset();
    const { tree } = render(MeasurePanel, {}, context());
    assert.strictEqual(openCards(tree).length, 0);
    // ...and the panel is otherwise entirely fine.
    assert.ok(/SNR/.test(say(tree)));
    tool.saveMeasureSettings({ expanded: 'snr' });
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
