// The Bands panel actually renders, in both views, and is reachable on a phone.
//
// A panel is the one part of this interface nothing else here covers: the
// protocol tests never touch the React tree, and unresolved.js is static. So a
// helper called with its arguments the other way round, a component used before
// it is imported, or an effect that throws on mount all build cleanly, pass
// every other test, and blank the interface the moment somebody opens the
// panel. See hookStub.js for what "renders" means here.
//
// The arithmetic behind the readings is bandnoise.test.js; this is the panel.

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

const {
    deep, render, reset, walk, words,
    BandStatsPanel, PANEL_BY_ID, GROUPS,
    resetBandNoise, setFeedsAllowed, resetFeeds,
} = require('./.build/bandstats.cjs');

let pass = 0;
const queued = [];
const t = (name, fn) => queued.push([name, fn]);

const settle = () => new Promise((r) => setImmediate(r));

// Four bands, so the noise floor ranking has quartiles to work with, and one of
// them with no FT8 heard — the case that is a zero in the reply rather than an
// absent field.
const LATEST = {
    '20m': {
        timestamp: new Date().toISOString(),
        min_db: -134, max_db: -62, mean_db: -112, median_db: -115,
        p5_db: -128, p10_db: -126, p95_db: -84, dynamic_range: 44,
        occupancy_pct: 18.25, ft8_snr: 24.4,
    },
    '40m': {
        timestamp: new Date().toISOString(),
        min_db: -130, max_db: -55, mean_db: -104, median_db: -108,
        p5_db: -118, p10_db: -116, p95_db: -78, dynamic_range: 40,
        occupancy_pct: 31.5, ft8_snr: 8.2,
    },
    '80m': {
        timestamp: new Date().toISOString(),
        min_db: -120, max_db: -50, mean_db: -96, median_db: -100,
        p5_db: -108, p10_db: -106, p95_db: -70, dynamic_range: 38,
        occupancy_pct: 44, ft8_snr: 3.1,
    },
    '10m': {
        timestamp: new Date().toISOString(),
        min_db: -140, max_db: -120, mean_db: -134, median_db: -135,
        p5_db: -138, p10_db: -137, p95_db: -126, dynamic_range: 12,
        occupancy_pct: 0.2, ft8_snr: 0,
    },
};

function context(over) {
    const tuned = [];
    return {
        tuning: { frequency: 14_200_000, mode: 'usb' },
        running: true,
        tuned,
        actions: {
            setFrequency: (hz) => tuned.push(['frequency', hz]),
            setMode: (m) => tuned.push(['mode', m]),
            setSpectrumCenter: (hz) => tuned.push(['centre', hz]),
            setSpan: (hz) => tuned.push(['span', hz]),
        },
        ...over,
    };
}

const mounted = [];

/**
 * Mount the panel with the store already holding `latest`.
 *
 * Twice on purpose. The first render subscribes; the reply lands after it, and
 * the stub has no reconciler to redraw on — so the second call is the render
 * that sees the data, with the hook state carried over from the first, which is
 * exactly what React would have done.
 */
async function mount(props, latest, over) {
    reset();
    resetBandNoise();
    resetFeeds();
    globalThis.fetch = () => Promise.resolve(
        latest === undefined
            ? { ok: false, status: 503 }
            : { ok: true, status: 200, json: () => Promise.resolve(latest) },
    );
    setFeedsAllowed(true);
    const ctx = context(over);
    const first = render(BandStatsPanel, props || {}, ctx);
    await settle();
    const again = render(BandStatsPanel, props || {}, ctx);
    // Collected as well as returned: a failed assertion never reaches its own
    // unmount, and a leaked interval keeps node alive after the last test.
    const unmount = () => { for (const off of first.cleanups.concat(again.cleanups)) off(); };
    mounted.push(unmount);
    return { tree: again.tree, ctx, unmount };
}

const classes = (tree) => deep(tree).map((n) => String(n.props.className || ''));

// --- rendering --------------------------------------------------------------

t('it renders, docked and minimal, and unmounts cleanly', async () => {
    for (const minimal of [false, true]) {
        const { tree, unmount } = await mount({ minimal }, LATEST);
        assert.ok(tree, `minimal=${minimal}: rendered nothing`);
        const text = words(tree);
        assert.match(text, /20m/, `minimal=${minimal}: no band on screen`);
        // An effect that throws on the way out leaks a subscriber per
        // open-and-close, and nothing on screen says so.
        unmount();
    }
});

t('the panel opens on the band the dial is in', async () => {
    const { tree, unmount } = await mount({}, LATEST);
    const hero = deep(tree).find((n) => String(n.props.className || '').includes('bst-hero--'));
    assert.ok(hero, 'no headline');
    // 14.2 MHz is 20m, and 20m has a 24.4 dB reading, which is Good.
    assert.match(words(hero), /20m/);
    assert.match(words(hero), /Good/);
    assert.strictEqual(hero.props.className, 'bst-hero bst-hero--good');
    unmount();
});

t('a dial outside every measured band still shows a band', async () => {
    // 9.7 MHz is broadcast, not an amateur band: the panel falls back to the
    // first band the monitor measures rather than emptying.
    const { tree, unmount } = await mount({}, LATEST, { tuning: { frequency: 9_700_000, mode: 'am' } });
    assert.match(words(tree), /80m/);
    unmount();
});

t('a band with no FT8 says so rather than claiming 0 dB', async () => {
    const { tree, unmount } = await mount({}, LATEST, { tuning: { frequency: 28_500_000, mode: 'usb' } });
    const text = words(tree);
    assert.match(text, /No FT8/);
    assert.ok(!/FT8 SNR 0\.0/.test(text), `it reported a zero as a reading: ${text}`);
    unmount();
});

t('the minimal view is the headline and two figures, nothing else', async () => {
    const full = await mount({}, LATEST);
    const cut = await mount({ minimal: true }, LATEST);

    // The picker, the all-bands table and the link out are what expanding is
    // for. Every one of them is in the docked panel...
    for (const c of ['bst__pick', 'bst-table', 'bst__foot']) {
        assert.ok(classes(full.tree).some((n) => n.includes(c)), `the docked panel lost ${c}`);
        assert.ok(!classes(cut.tree).some((n) => n.includes(c)), `the minimal view still has ${c}`);
    }

    // ...and what is left is the headline and the two figures a band is judged
    // on — the noise floor and the room above it.
    const cells = deep(cut.tree).filter((n) => String(n.props.className || '').includes('bst-cell'));
    assert.strictEqual(cells.length, 2, `minimal view has ${cells.length} readouts`);
    assert.match(words(cut.tree), /Noise floor/);
    assert.match(words(cut.tree), /Dynamic range/);
    // The age is still there, folded into the headline, because a stale reading
    // that does not say it is stale is the one failure worth carrying anywhere.
    assert.match(words(cut.tree), /ago/);

    full.unmount();
    cut.unmount();
});

t('every measured band is in the table, up the spectrum', async () => {
    const { tree, unmount } = await mount({}, LATEST);
    const rows = deep(tree).filter((n) => String(n.props.className || '').startsWith('bst-table__row'));
    assert.strictEqual(rows.length, 4);
    const bands = rows.map((r) => words(r).split(/\s+/)[0]);
    assert.deepStrictEqual(bands, ['80m', '40m', '20m', '10m']);
    // The band on screen is the marked one.
    const current = rows.filter((r) => r.props.className.includes('is-current'));
    assert.strictEqual(current.length, 1);
    assert.match(words(current[0]), /^20m/);
    unmount();
});

t('clicking a row tunes to that band the way the band keys do', async () => {
    const { tree, ctx, unmount } = await mount({}, LATEST);
    const rows = deep(tree).filter((n) => String(n.props.className || '').startsWith('bst-table__row'));
    const fortyM = rows.find((r) => words(r).startsWith('40m'));
    fortyM.props.onClick();
    // The middle of 40m, in the band's sideband, with the spectrum on it.
    assert.deepStrictEqual(ctx.tuned, [
        ['mode', 'lsb'],
        ['frequency', 7_150_000],
        ['centre', 7_150_000],
        ['span', 300_000],
    ]);
    unmount();
});

t('nothing measured yet is a line saying so, not a blank panel', async () => {
    const { tree, unmount } = await mount({}, {});
    assert.match(words(tree), /No band measurements yet/);
    unmount();
});

t('a monitor that is switched off says why', async () => {
    const { tree, unmount } = await mount({}, undefined);
    assert.match(words(tree), /not enabled/);
    unmount();
});

// --- where it lives ---------------------------------------------------------

t('the panel is registered, under Quick bands, and gated on the monitor', () => {
    const p = PANEL_BY_ID.bandstats;
    assert.ok(p, 'not in the registry');
    assert.strictEqual(p.title, 'Bands');
    assert.strictEqual(p.dock, 'right');
    assert.strictEqual(p.minimal, true);
    // Collapsed, and collapsed means silent: Section only mounts an open
    // panel's body, so a closed one holds no timer and makes no request.
    assert.strictEqual(p.defaultOpen, false);
    assert.strictEqual(p.Component, BandStatsPanel);

    // Every figure here is the noise floor monitor's.
    assert.strictEqual(p.requires({ noise_floor: true }), true);
    assert.strictEqual(p.requires({}), false);
    assert.strictEqual(p.requires(null), false);

    // It is not the band plan panel, which has been 'bands' all along — a
    // collision there would have silently taken over somebody's stored layout.
    assert.strictEqual(PANEL_BY_ID.bands.title, 'Band plan');
});

t('a group claims it, so it exists on a phone', () => {
    // A panel no group names vanishes from every narrow layout — see groups.jsx.
    const group = GROUPS.find((g) => g.panels.includes('bandstats'));
    assert.ok(group, 'no group claims it');
    assert.strictEqual(group.id, 'activity');
    // Beside the other "how is this band doing" panels rather than at the end.
    assert.strictEqual(
        group.panels.indexOf('bandstats') + 1, group.panels.indexOf('spaceweather'),
        'it should sit next to the space weather panel',
    );
});

(async () => {
    for (const [name, fn] of queued) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    for (const off of mounted) { try { off(); } catch (e) { /* already unmounted */ } }
    resetBandNoise();
    resetFeeds();
    console.log(`\n${pass} passed`);
})();
