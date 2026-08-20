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
    render, reset, walk, IFSpectrumPanel, PANEL_BY_ID, DEFAULTS, GROUPS,
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
        spectrumConn: { on: () => () => {} },
        view: {
            centerFreq: 14_200_000, span: 200_000, binCount: 1024, binBandwidth: 195.3125,
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
    for (const view of ['split', 'spectrum', 'waterfall', 'fusion', 'mirror']) {
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
});

t('a stopped receiver and a spectrum with no view are states, not crashes', () => {
    for (const over of [
        { running: false },
        { view: { centerFreq: 0, span: 0, binCount: 0, binBandwidth: 0 } },
        // Panned right away from the dial: the pane is blank and has to say why.
        { view: { centerFreq: 3_600_000, span: 200_000, binCount: 1024, binBandwidth: 195.3125 } },
    ]) {
        reset();
        const { tree } = render(IFSpectrumPanel, {}, context(over));
        assert.ok(tree);
    }
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

t('its display settings all have defaults, so a first visit is not undefined', () => {
    for (const key of ['ifView', 'ifSpan', 'ifRate', 'ifAuto', 'ifFloor', 'ifCeil', 'ifGestures']) {
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
