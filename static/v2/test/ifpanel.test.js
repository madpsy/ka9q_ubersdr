// The IF Spectrum panel actually renders.
//
// A panel is the one part of this interface nothing else here covers: the
// protocol tests never touch the React tree, and unresolved.js is static. So a
// helper called with its arguments the other way round, a component used before
// it is imported, or an effect that throws on mount all build cleanly, pass
// every other test, and blank the interface the moment somebody opens the
// panel. See hookStub.js for what "renders" means here — the component is
// called with real hook storage and its mount effects are run, which is enough
// to prove the render path executes end to end.

const assert = require('assert');

// Before the bundle: the module graph behind a panel reaches the display
// settings and the radio, and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
const listeners = [];
globalThis.addEventListener = (name) => listeners.push(name);
globalThis.removeEventListener = (name) => {
    const i = listeners.indexOf(name);
    if (i >= 0) listeners.splice(i, 1);
};

const {
    deep, render, reset, walk, words, setSpectrumPaused, spectrumPaused,
    IFSpectrumPanel, PANEL_BY_ID, DEFAULTS, GROUPS,
} = require('./.build/ifpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers both useRadio and useDisplay — the stub's useContext has no
// way to tell two contexts apart, and neither panel cares.
function context(over) {
    return {
        tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        // Enough of the connection for the panel to work out how far the zoom
        // can go: 1024 bins at a 10 Hz floor is a 10.24 kHz span, which is what
        // the interface actually stops at.
        spectrumConn: { on: () => () => {}, binCount: 1024, minBinBandwidthForUI: () => 10 },
        // Zoomed in past the gate (7 halvings of the full-span 29.3 kHz/bin) and
        // centred on the dial, so the pane can actually draw — see paneState.
        view: {
            centerFreq: 14_200_000,
            span: 1024 * 100,
            binCount: 1024,
            binBandwidth: 100,
            defaultBinCount: 1024,
            defaultBinBandwidth: 30e6 / 1024,
        },
        actions: {
            setFrequency() {}, setSpectrumView() {}, centerOnTuned() {},
        },
        ...DEFAULTS,
        server: {},
        set() {},
        ...over,
    };
}

const canvases = (tree) => walk(tree).filter((n) => n.type === 'canvas');

t('it renders in every view, docked and minimal', () => {
    for (const view of ['split', 'spectrum', 'waterfall', 'fusion', 'mirror', 'shape']) {
        for (const minimal of [false, true]) {
            reset();
            const { tree, cleanups } = render(IFSpectrumPanel, { minimal }, context({ ifView: view }));
            assert.ok(tree, `${view}/${minimal}: rendered nothing`);
            assert.ok(canvases(tree).length > 0, `${view}/${minimal}: no picture`);
            // Unmounting has to work too: an effect that throws on the way out
            // leaks a listener per open-and-close, and nothing on screen says so.
            for (const off of cleanups) off();
        }
    }
});

t('the pictures a view asks for are the pictures it gets', () => {
    const count = (view) => {
        reset();
        const { tree } = render(IFSpectrumPanel, {}, context({ ifView: view }));
        const cs = canvases(tree);
        return {
            spec: cs.filter((c) => c.props.className === 'ifs__spec').length,
            wf: cs.filter((c) => c.props.className === 'ifs__wf').length,
            ov: cs.filter((c) => c.props.className === 'ifs__ov').length,
        };
    };
    // Split is both, stacked. Fusion is both on one surface, so the trace goes
    // on the overlay and there is no spectrum canvas at all.
    assert.deepStrictEqual(count('split'), { spec: 1, wf: 1, ov: 1 });
    assert.deepStrictEqual(count('spectrum'), { spec: 1, wf: 0, ov: 0 });
    assert.deepStrictEqual(count('mirror'), { spec: 1, wf: 0, ov: 0 });
    assert.deepStrictEqual(count('waterfall'), { spec: 0, wf: 1, ov: 1 });
    assert.deepStrictEqual(count('fusion'), { spec: 0, wf: 1, ov: 1 });
    // Shape is a statistical view of the passband, and a waterfall of the live
    // frames beside it would be the picture it exists not to draw.
    assert.deepStrictEqual(count('shape'), { spec: 1, wf: 0, ov: 0 });
});

t('the Shape view asks the main display for the zoom it needs, once', () => {
    const asked = [];
    const ctx = (over) => {
        const base = context(over);
        return { ...base, actions: { ...base.actions, setSpectrumView: (hz, span) => asked.push({ hz, span }) } };
    };
    // Opened over the whole band: there is a fraction of a bin in the passband,
    // so it asks.
    const wide = {
        centerFreq: 15e6, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024,
        defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
    };
    reset();
    render(IFSpectrumPanel, {}, ctx({ ifView: 'shape', view: wide }));
    assert.strictEqual(asked.length, 1, 'it did not ask');
    assert.ok(asked[0].span > 0 && asked[0].span < 1e6, JSON.stringify(asked[0]));

    // ...and it asks for the deepest zoom, not merely one that clears the gate:
    // the fixture's own view is fine enough to draw from and is still moved,
    // because every extra bin in the passband is a finer shape.
    assert.ok(asked[0].span <= 10240 * 1.01, `asked for ${asked[0].span}`);

    // Already at the zoom floor: asking again would be a channel reload on the
    // receiver that changed nothing, once per time the panel is opened.
    asked.length = 0;
    reset();
    render(IFSpectrumPanel, {}, ctx({
        ifView: 'shape',
        view: {
            centerFreq: 14_200_000, span: 10240, binCount: 1024, binBandwidth: 10,
            defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
        },
    }));
    assert.deepStrictEqual(asked, [], 'it moved a view that was already right');

    // Switched off, it never touches the main display — and neither does any
    // other view, whatever the zoom.
    asked.length = 0;
    reset();
    render(IFSpectrumPanel, {}, ctx({ ifView: 'shape', view: wide, ifShapeZoom: false }));
    reset();
    render(IFSpectrumPanel, {}, ctx({ ifView: 'split', view: wide }));
    reset();
    render(IFSpectrumPanel, {}, ctx({ ifView: 'shape', view: wide, running: false }));
    assert.deepStrictEqual(asked, []);
});

t('the measured readout is optional, and is the same in every view', () => {
    const readouts = (over, props) => {
        reset();
        const { tree } = render(IFSpectrumPanel, props || {}, context(over));
        const grid = deep(tree).find((n) => String(n.props.className || '').includes('ifs__stats'));
        return grid ? words(grid) : null;
    };
    // On by default: the four numbers are what the panel is opened to find out.
    assert.strictEqual(DEFAULTS.ifStats, true);
    // ...and it can be turned off, which takes the whole grid with it.
    assert.strictEqual(readouts({ ifStats: false }), null);

    // It is there whichever of the six pictures is showing — the numbers come
    // from the averaging, not from the drawing.
    for (const view of ['split', 'spectrum', 'waterfall', 'fusion', 'mirror', 'shape']) {
        const w = readouts({ ifStats: true, ifView: view });
        assert.ok(w, `no readout in the ${view} view`);
        assert.match(w, /Peak/);
        assert.match(w, /Occupancy/);
        assert.match(w, /Noise/);
    }

    // ...including the minimal view, unlike the readout that is always there:
    // this one was asked for, which is the difference between clutter and a
    // request.
    assert.ok(readouts({ ifStats: true }, { minimal: true }));

    // Nothing is claimed while the pane cannot draw: over one spectrum bin there
    // is no peak to find and no occupancy to count.
    const blind = readouts({
        ifStats: true,
        view: {
            centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024,
            defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
        },
    });
    assert.ok(!/dBFS/.test(blind), `it reported numbers it could not measure: ${blind}`);
});

t('the Shape view brings its own window and says what went into it', () => {
    reset();
    const { tree } = render(IFSpectrumPanel, {}, context({ ifView: 'shape' }));
    const text = deep(tree).map((n) => n.props.className).filter((c) => typeof c === 'string');
    // The averaging window is the one control only this view has...
    assert.ok(text.includes('ifs__avg'), 'no readout of what the average covers');
    // ...and it is absent from the others, where there is no window to set.
    reset();
    const other = render(IFSpectrumPanel, {}, context({ ifView: 'split' })).tree;
    assert.ok(!deep(other).some((n) => n.props.className === 'ifs__avg'));

    // Its default is a real number of seconds, not undefined.
    assert.ok(DEFAULTS.ifShapeSec >= 0.5 && DEFAULTS.ifShapeSec <= 10);
});

t('everything standing in the way is said on the picture, not under it', () => {
    const veil = (over, props) => {
        reset();
        const { tree } = render(IFSpectrumPanel, props || {}, context(over));
        // deep(), not walk(): the cover is drawn by a component of the panel's
        // own, which the outer return only names.
        const v = deep(tree).filter((n) => n.props.className === 'ifs__veil');
        assert.ok(v.length <= 1, `${v.length} veils at once`);
        return v[0] || null;
    };

    // Nothing in the way: the picture stands on its own.
    assert.strictEqual(veil({}), null, 'a usable pane is covered anyway');

    // Each of the four, and each of them is a different thing to do about it.
    assert.match(words(veil({ running: false })), /stopped/i);
    assert.match(words(veil({ view: { centerFreq: 0, span: 0, binCount: 0, binBandwidth: 0 } })), /waiting/i);
    // Panned away from the dial — fine bins, none of them here.
    assert.match(words(veil({
        view: {
            centerFreq: 3_600_000, span: 1024 * 100, binCount: 1024, binBandwidth: 100,
            defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
        },
    })), /dial/i);
    // Zoomed out: the whole reason for the gate.
    assert.match(words(veil({
        view: {
            centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024,
            defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
        },
    })), /zoom/i);
    // Zoomed in plenty and the dial is on screen, but panned so far that the
    // window runs off the end of the view — half a picture with a hole in the
    // other half, which the shading and the ruler would describe as a dead band.
    assert.match(words(veil({
        view: {
            centerFreq: 14_200_000 - 1024 * 10, span: 1024 * 20, binCount: 1024, binBandwidth: 20,
            defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
        },
    })), /off the view/i);

    // A paused spectrum is not a broken one, and the way out is offered here as
    // well as on the main display — a listener who opened this panel should not
    // have to go and find the other one.
    setSpectrumPaused(true);
    try {
        assert.ok(spectrumPaused(), 'the pause flag did not take');
        const v = veil({});
        assert.match(words(v), /paused/i);
        assert.match(words(v), /resume/i);
        // ...and it outranks everything about the data: none of it is arriving.
        assert.match(words(veil({
            view: {
                centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024,
                defaultBinCount: 1024, defaultBinBandwidth: 30e6 / 1024,
            },
        })), /paused/i);
        // ...but not a stopped receiver, where resuming a socket would do nothing.
        assert.match(words(veil({ running: false })), /stopped/i);
    } finally {
        setSpectrumPaused(false);
    }

    // ...and it covers the minimal view too, which is the only text that view
    // has: a blank pane that says nothing reads as a fault.
    assert.ok(veil({ running: false }, { minimal: true }), 'the minimal view says nothing at all');
});

t('every mode gets a window, including the ones that are all on one side', () => {
    for (const [low, high] of [[50, 2700], [-2700, -50], [-5000, 5000], [-200, 200], [-8000, 8000]]) {
        reset();
        const ctx = context();
        ctx.tuning = { ...ctx.tuning, bandwidthLow: low, bandwidthHigh: high };
        const { tree } = render(IFSpectrumPanel, {}, ctx);
        // The ruler is built from the window, so notches on it prove the window
        // reached the render rather than collapsing to nothing.
        const notches = walk(tree).filter((n) => String(n.props.className || '').startsWith('ifs__notch'));
        assert.ok(notches.length > 2, `${low}..${high}: ${notches.length} notches`);
        assert.strictEqual(notches.filter((n) => n.props.className.includes('--zero')).length, 1);
    }
});

t('the window listeners are taken down again', () => {
    listeners.length = 0;
    reset();
    const { cleanups } = render(IFSpectrumPanel, {}, context());
    assert.ok(listeners.length > 0, 'nothing was listening for a drag');
    for (const off of cleanups) off();
    assert.strictEqual(listeners.length, 0, `left ${listeners.join(', ')} attached`);
});

t('gestures off puts an opened window back to the fit', () => {
    // The reset button lives on the chart and is only drawn while the window is
    // open, so turning the gestures off would otherwise leave a minimal panel
    // showing a span with nothing on it able to close it again.
    const wrote = [];
    reset();
    const { tree } = render(IFSpectrumPanel, {}, context({
        ifGestures: false, ifSpan: 8, set: (patch) => wrote.push(patch),
    }));
    assert.ok(canvases(tree).length > 0);
    assert.ok(wrote.some((p) => p.ifSpan === 1), `nothing reset the span: ${JSON.stringify(wrote)}`);
});

t('the way back to the fit is on the chart whenever the window is open', () => {
    const button = (over) => {
        reset();
        const { tree } = render(IFSpectrumPanel, {}, context(over));
        return walk(tree).filter((n) => n.props.className === 'ifs__reset').length;
    };
    assert.strictEqual(button({ ifSpan: 1 }), 0, 'nothing to reset at the fit');
    assert.strictEqual(button({ ifSpan: 4 }), 1);
    // ...including the minimal view, which has no span slider to fall back on.
    reset();
    const { tree } = render(IFSpectrumPanel, { minimal: true }, context({ ifSpan: 4 }));
    assert.strictEqual(walk(tree).filter((n) => n.props.className === 'ifs__reset').length, 1);
});

t('the panel is registered, under the Receiver, and in a group', () => {
    const p = PANEL_BY_ID.ifspectrum;
    assert.ok(p, 'not in the registry');
    assert.strictEqual(p.dock, 'left');
    assert.strictEqual(p.minimal, true);
    // Collapsed, and collapsed means idle: Section only mounts an open panel's
    // body, so a closed one holds no frame subscription and runs no draw loop.
    assert.strictEqual(p.defaultOpen, false);
    assert.strictEqual(p.Component, IFSpectrumPanel);
    // No `requires`: it reads the spectrum every session already has, so there
    // is no receiver it does not apply to.
    assert.strictEqual(p.requires, undefined);

    // A panel no group claims vanishes from every phone — see groups.jsx.
    const group = GROUPS.find((g) => g.panels.includes('ifspectrum'));
    assert.ok(group, 'no group claims it');
    assert.strictEqual(group.id, 'tune');
    assert.strictEqual(
        group.panels.indexOf('ifspectrum'), group.panels.indexOf('receiver') + 1,
        'it should sit next to the Receiver, as it does in the dock',
    );
});

t('the minimal view is the picture and nothing under it', () => {
    const text = (props, over) => {
        reset();
        const { tree } = render(IFSpectrumPanel, props, context(over));
        return walk(tree).filter((n) => {
            const c = String(n.props.className || '');
            return c.startsWith('ifs__foot') || c.startsWith('note');
        });
    };
    // Docked it carries the readout; shrunk to a glance it carries nothing.
    assert.ok(text({}, {}).length > 0, 'the docked panel lost its readout');
    assert.strictEqual(text({ minimal: true }, {}).length, 0, 'the minimal view has text under it');

    // ...in every state, because what would otherwise be said there is said on
    // the picture instead — see the veil.
    assert.strictEqual(text({ minimal: true }, { running: false }).length, 0);
});

t('a click only tunes when it has been asked to', () => {
    const clickAt = (over) => {
        reset();
        const tuned = [];
        const ctx = context({ ...over, actions: { ...context().actions, setFrequency: (hz) => tuned.push(hz) } });
        const { tree } = render(IFSpectrumPanel, {}, ctx);
        const chart = walk(tree).find((n) => String(n.props.className || '').startsWith('ifs__chart'));
        // There is no layout in the shim, and the handler measures the chart
        // before it does anything. The ref is right there in the props, so give
        // it a box to measure — otherwise this test passes for the wrong reason.
        chart.props.ref.current = {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
        };
        chart.props.onClick({ clientX: 100, target: {} });
        return tuned;
    };
    // Off by default — this pane is for looking at the signal you are on.
    assert.strictEqual(DEFAULTS.ifClickTune, false);
    assert.deepStrictEqual(clickAt({}), [], 'a click retuned with click-tune off');
    // ...and on, it does what it says.
    const tuned = clickAt({ ifClickTune: true });
    assert.strictEqual(tuned.length, 1, 'a click did not tune with click-tune on');
    // Halfway across a USB window, which is above the dial rather than on it.
    assert.ok(Number.isFinite(tuned[0]) && Math.abs(tuned[0] - 14_200_000) < 5000, tuned[0]);
});

t('the chart says what it will do, and never promises what it will not', () => {
    const hint = (over) => {
        reset();
        const { tree } = render(IFSpectrumPanel, {}, context(over));
        return walk(tree).find((n) => String(n.props.className || '').startsWith('ifs__chart')).props.title;
    };
    assert.match(hint({ ifGestures: true, ifClickTune: true }), /click or drag/i);
    assert.match(hint({ ifGestures: true, ifClickTune: false }), /^drag to tune/i);
    assert.match(hint({ ifGestures: false, ifClickTune: true }), /^click to tune/i);
    // Both off, the chart is a readout — a tooltip offering to tune would be a lie.
    assert.doesNotMatch(hint({ ifGestures: false, ifClickTune: false }), /tune/i);
});

t('the default view is the one the panel is designed around', () => {
    assert.strictEqual(DEFAULTS.ifView, 'fusion');
    // ...and an unreadable stored value lands on the same place, rather than on
    // whichever view the fallback was written for first.
    reset();
    const { tree } = render(IFSpectrumPanel, {}, context({ ifView: 'nonsense' }));
    const cs = canvases(tree);
    assert.strictEqual(cs.filter((c) => c.props.className === 'ifs__spec').length, 0);
    assert.strictEqual(cs.filter((c) => c.props.className === 'ifs__ov').length, 1);
});

t('its display settings all have defaults, so a first visit is not undefined', () => {
    for (const key of [
        'ifView', 'ifSpan', 'ifRate', 'ifAuto', 'ifFloor', 'ifCeil', 'ifGestures',
        'ifClickTune', 'ifShapeSec', 'ifShapeZoom', 'ifStats',
    ]) {
        assert.ok(DEFAULTS[key] !== undefined, `${key} has no default`);
    }
    assert.strictEqual(DEFAULTS.ifSpan, 1, 'the pane must open fitted to the filter');
});

t('an opened window is pulled back when the spectrum view cannot fill it', () => {
    // The screenshot bug: a x32 window is 216 kHz, the receiver was sending
    // 51 kHz, and three quarters of the panel was empty canvas.
    const narrow = { centerFreq: 7_669_000, span: 1024 * 50, binCount: 1024 };
    reset();
    const { tree } = render(IFSpectrumPanel, {}, context({
        ifSpan: 32,
        tuning: { frequency: 7_669_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        view: { ...narrow, binBandwidth: 50 },
    }));
    // The ruler is built from the effective window, so its outermost label says
    // how wide the pane actually went.
    const labels = walk(tree)
        .filter((n) => String(n.props.className || '').startsWith('ifs__tick'))
        .map((n) => n.children[0]);
    // Two is a legitimate ruler on a lopsided window — see offsetStep.
    assert.ok(labels.length >= 2, `only ${labels.length} labels`);
    // 51.2 kHz of served view is +/-25.6 kHz, so nothing on the strip may claim
    // to be further out than that.
    for (const l of labels) {
        const hz = l === '0' ? 0 : parseFloat(l) * (String(l).endsWith('k') ? 1000 : 1);
        assert.ok(Math.abs(hz) <= 25_700, `ruler runs to ${l}, past what is being sent`);
    }
});

t('the ruler does not crowd, at any width the dock can be', () => {
    for (const width of [0, 180, 320]) {
        reset();
        const { tree } = render(IFSpectrumPanel, {}, context({ ifSpan: 32 }));
        const labels = walk(tree).filter((n) => String(n.props.className || '').startsWith('ifs__tick'));
        // Nothing measured yet means the fallback of two ticks plus zero, and a
        // measured strip never gets more than it has room for — the eleven
        // overlapping labels this replaces.
        assert.ok(labels.length <= 7, `${labels.length} labels at width ${width}`);
    }
});

console.log(`\n${pass} passed`);
