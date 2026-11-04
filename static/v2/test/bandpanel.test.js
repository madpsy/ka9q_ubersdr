// The Band Spectrum panel actually renders — its chart included.
//
// The panel itself is a shell: it fetches the band list, and until that lands it
// draws "Loading…". Everything that can go wrong lives in BandChart, the
// component it renders once a band is known, and a render of the outer panel
// alone never reaches it. That is how `serverInfo`, read in BandChart but only
// ever in scope in its parent, built cleanly, passed every test, and blanked the
// whole interface for anyone who opened this panel. So this test lets the fetch
// land, finds the chart in the tree, and renders that too, mount effects and all.

const assert = require('assert');

const BAND = { name: '20m', start: 14_000_000, end: 14_350_000 };

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    hidden: false,
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ bands: [BAND] }) });
const streams = [];
globalThis.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; streams.push(this); }
    addEventListener() {}
    removeEventListener() {}
    close() { this.closed = true; }
};
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

const { render, reset, rerender, walk, BandSpectrumPanel, DEFAULTS } = require('./.build/bandpanel.cjs');

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function context(over) {
    return {
        tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        actions: { setFrequency() {} },
        serverInfo: { receiver: { name: 'test', timezone: 'UTC' } },
        ...DEFAULTS,
        server: {},
        set() {},
        ...over,
    };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// Mount the panel, let the band list arrive, and hand back the chart element.
async function mountedChart(ctx) {
    reset();
    const first = render(BandSpectrumPanel, {}, ctx);
    await settle();
    const second = rerender(BandSpectrumPanel, {}, ctx, first);
    const chart = walk(second.tree).find((n) => typeof n.type === 'function' && n.type.name === 'BandChart');
    return { chart, panel: second };
}

t('once the band list lands, the panel draws a chart for the dial\'s band', async () => {
    const { chart, panel } = await mountedChart(context());
    assert.ok(chart, 'no BandChart in the tree');
    assert.strictEqual(chart.props.band, '20m');
    for (const off of panel.cleanups) off();
});

t('the chart renders and mounts, docked and minimal', async () => {
    for (const minimal of [false, true]) {
        const ctx = context();
        reset();
        const first = render(BandSpectrumPanel, { minimal }, ctx);
        await settle();
        const second = rerender(BandSpectrumPanel, { minimal }, ctx, first);
        const chart = walk(second.tree).find((n) => typeof n.type === 'function' && n.type.name === 'BandChart');
        assert.ok(chart, `${minimal}: no BandChart`);
        reset();
        const { tree, cleanups } = render(chart.type, chart.props, ctx);
        assert.ok(tree, `${minimal}: chart rendered nothing`);
        assert.ok(walk(tree).some((n) => n.type === 'canvas'), `${minimal}: no picture`);
        for (const off of cleanups) off();
        for (const off of second.cleanups) off();
    }
});

t('the chart renders with no server info yet', async () => {
    const ctx = context({ serverInfo: null });
    const { chart, panel } = await mountedChart(ctx);
    reset();
    const { tree, cleanups } = render(chart.type, chart.props, ctx);
    assert.ok(tree);
    for (const off of cleanups) off();
    for (const off of panel.cleanups) off();
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass} passed`);
})();
