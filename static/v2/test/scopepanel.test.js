// The Audio scope panel actually renders, with and without the Stats row.
//
// A panel is the one part of this interface nothing else here covers: the
// protocol tests never touch the React tree and unresolved.js is static, so a
// component used before it is defined, a helper called with its arguments the
// other way round, or an effect that throws on mount all build cleanly, pass
// every other test, and blank the interface the moment somebody opens the
// panel. See hookStub.js for what "renders" means here.

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
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { deep, render, reset, walk, words, ScopePanel, DEFAULTS } = require('./.build/scopepanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers both useRadio and useDisplay — the stub's useContext has
// no way to tell two contexts apart, and the panel does not care.
function context(over) {
    return {
        tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        // Enough of the player for the mount effect: subscribeAudioSpectrum
        // asks it for an analyser, and a bare object throws there — which is
        // the class of thing this test exists to catch.
        player: {
            acquireAnalyser: () => ({
                fftSize: 4096,
                frequencyBinCount: 2048,
                getFloatFrequencyData: () => {},
                getByteFrequencyData: () => {},
                getByteTimeDomainData: () => {},
            }),
            releaseAnalyser: () => {},
        },
        palette: 'default',
        set: () => {},
        ...over,
    };
}

// The row is drawn by a component of the panel's, so deep() rather than walk():
// walk sees only what ScopePanel returned itself.
function statsText(tree) {
    const row = deep(tree).find((n) => n && n.props
        && String(n.props.className || '') === 'scope-stats');
    return row ? words(row) : null;
}

const toggles = (tree) => walk(tree).filter((n) => n && n.props && n.props.label === 'Stats');

t('it renders with the stats on', () => {
    reset();
    render(ScopePanel, {}, context({ scopeStats: true }));
    assert.ok(true);
});

t('it renders with the stats off', () => {
    reset();
    render(ScopePanel, {}, context({ scopeStats: false }));
    assert.ok(true);
});

t('it renders in the minimal view', () => {
    reset();
    render(ScopePanel, { minimal: true }, context({ scopeStats: true }));
    assert.ok(true);
});

t('it renders in every view, with the stats on', () => {
    for (const scopeView of ['both', 'scope', 'waterfall']) {
        for (const scopeShape of ['bars', 'wave']) {
            reset();
            render(ScopePanel, {}, context({ scopeView, scopeShape, scopeStats: true }));
        }
    }
    assert.ok(true);
});

t('it renders in IQ, where there is no audio spectrum to read', () => {
    reset();
    render(ScopePanel, {}, context({
        tuning: { frequency: 14_200_000, mode: 'iq', bandwidthLow: -5000, bandwidthHigh: 5000 },
        scopeStats: true,
    }));
    assert.ok(true);
});

// The row is a readout, not a control, so it belongs with the pictures rather
// than with the settings that are dropped in a side dock.
t('the stats show in the minimal view', () => {
    reset();
    const { tree } = render(ScopePanel, { minimal: true }, context({ scopeStats: true }));
    const text = statsText(tree);
    assert.ok(text, 'no stats row in the minimal view');
    assert.ok(/Peak/.test(text), `no Peak reading: ${text}`);
    assert.ok(/SNR/.test(text), `no SNR reading: ${text}`);
});

t('the stats are on by default', () => {
    reset();
    // No scopeStats key at all: what a browser that has never set it reports.
    const { tree } = render(ScopePanel, { minimal: true }, context({}));
    assert.ok(statsText(tree), 'the default should show the stats');

    reset();
    const { tree: off } = render(ScopePanel, { minimal: true }, context({ scopeStats: false }));
    assert.strictEqual(statsText(off), null, 'turning them off should remove the row');
});

// The toggle is a control, so it follows the panel's rule for those: present in
// the full view, dropped in the minimal one.
t('the toggle is in the full view and not the minimal one', () => {
    reset();
    const { tree: full } = render(ScopePanel, {}, context({ scopeStats: true }));
    assert.strictEqual(toggles(full).length, 1, 'no Stats toggle in the full view');

    reset();
    const { tree: min } = render(ScopePanel, { minimal: true }, context({ scopeStats: true }));
    assert.strictEqual(toggles(min).length, 0, 'the minimal view should not carry the toggle');
});

// The readings are read off the spectrum whichever picture is showing it, so
// the toggle must not be inside the bar view's own controls.
t('the toggle is reachable when the bars are not showing', () => {
    for (const over of [{ scopeView: 'waterfall' }, { scopeView: 'scope', scopeShape: 'wave' }]) {
        reset();
        const { tree } = render(ScopePanel, {}, context({ ...over, scopeStats: true }));
        assert.strictEqual(toggles(tree).length, 1,
            `the Stats toggle vanished in ${JSON.stringify(over)}`);
    }
});

t('the display defaults do not turn the stats off', () => {
    // DEFAULTS is what a fresh browser starts from; an explicit false there
    // would silently override the panel's own default.
    assert.notStrictEqual(DEFAULTS.scopeStats, false);
});

console.log(`\nall ${pass} scope panel tests passed`);
