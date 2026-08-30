// The Listeners panel's band view: where each dot lands, and what it does.
//
// The list view can be read wrong and still be read — a misplaced age is a
// wrong number beside the right callsign. A dot is only its position, so an
// error in the arithmetic here is a listener shown on the wrong band with
// nothing on screen to contradict it. Hence the geometry is a pure module with
// its own tests, and the drawing is checked separately through hookStub.js.

const assert = require('assert');

// Before the bundle: the component's module graph reaches lib/listeners.js and
// through it the session and the feed gate, both of which expect a browser.
const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    deep, render, reset,
    ListenerBands,
    BANDS_VIEW, CLUSTER_PCT, LIST_VIEW, MIN_DOT_GAP_PX, OTHER_ROW,
    bandRows, gapPct, pctOf, saveView, savedView,
} = require('./.build/listenerbands.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// The panel's own shape — lib/listeners.js normaliseChannels, not the server's.
let seq = 0;
const ch = (frequency, over = {}) => ({
    index: seq++,
    you: false,
    frequency,
    mode: 'usb',
    bandwidthLow: 50,
    bandwidthHigh: 2800,
    lastActive: Date.parse('2026-08-04T12:00:00Z'),
    country: '',
    countryCode: '',
    chatUsername: '',
    ...over,
});

const rowNamed = (rows, name) => rows.find((r) => r.name === name);

t('a band nobody is on gets no row, and the rest keep band order', () => {
    const rows = bandRows([ch(14074000), ch(7100000), ch(14200000)]);
    assert.deepStrictEqual(rows.map((r) => r.name), ['40m', '20m']);
    assert.strictEqual(rowNamed(rows, '20m').spots.length, 2);
});

t('a dot sits where its listener is across the band', () => {
    const [row] = bandRows([ch(7150000)]);           // 40m is 7.000-7.300
    assert.strictEqual(row.name, '40m');
    assert.strictEqual(Math.round(row.spots[0].pct), 50);
});

t('the band edges are 0 and 100, not off the end', () => {
    const rows = bandRows([ch(7000000), ch(7300000)]);
    const pcts = rows[0].spots.map((s) => Math.round(s.pct));
    assert.deepStrictEqual(pcts, [0, 100]);
    assert.strictEqual(pctOf(7150000, 7000000, 7300000), 50);
    // Outside is nothing rather than a clamp: the dial line has to be absent
    // from the rows the dial is not in, not pinned to their edges.
    assert.strictEqual(pctOf(3600000, 7000000, 7300000), null);
    assert.strictEqual(pctOf(NaN, 7000000, 7300000), null);
});

t('listeners closer than a dot is wide become one dot with a count', () => {
    // 40m is 300 kHz, so the 5% threshold is 15 kHz.
    const rows = bandRows([ch(7100000), ch(7104000), ch(7200000)]);
    const [close, far] = rows[0].spots;
    assert.strictEqual(close.channels.length, 2);
    assert.strictEqual(far.channels.length, 1);
    // Between its two, not on the first of them.
    assert.ok(Math.abs(close.pct - 34) < 0.5, `pct was ${close.pct}`);
});

t('a cluster does not walk across the band one listener at a time', () => {
    // Each is 12 kHz (4%) past the last, so every pair is inside the threshold
    // but the chain is not: measuring against the group's running mean instead
    // of its leftmost member would swallow the whole run into one dot.
    const rows = bandRows([ch(7100000), ch(7112000), ch(7124000), ch(7136000)]);
    assert.ok(rows[0].spots.length > 1, 'the whole band collapsed into one dot');
    assert.ok(CLUSTER_PCT > 0);
});

t('everyone outside the amateur bands gets one row across the receiver', () => {
    const rows = bandRows([ch(6070000), ch(14074000)], 10000, 30000000);
    assert.deepStrictEqual(rows.map((r) => r.name), ['20m', OTHER_ROW]);
    const other = rowNamed(rows, OTHER_ROW);
    assert.strictEqual(other.min, 10000);
    assert.strictEqual(other.max, 30000000);
    assert.strictEqual(other.hue, null);
    assert.strictEqual(other.spots.length, 1);
});

t('a listener outside the receiver widens that row rather than being pinned to its edge', () => {
    const rows = bandRows([ch(60000000)], 10000, 30000000);
    const other = rowNamed(rows, OTHER_ROW);
    assert.strictEqual(other.max, 60000000);
    assert.strictEqual(Math.round(other.spots[0].pct), 100);
});

t('a dot knows what clicking it would tune to, and when there is nothing', () => {
    const rows = bandRows([ch(14074000, { you: true }), ch(10000000, { mode: 'iq' }), ch(7100000)]);
    assert.strictEqual(rowNamed(rows, '20m').spots[0].tune, null);       // yourself
    assert.strictEqual(rowNamed(rows, OTHER_ROW).spots[0].tune, null);   // IQ has no audio
    assert.strictEqual(rowNamed(rows, '40m').spots[0].tune.frequency, 7100000);
});

t('a dot holding you and somebody else is marked yours and still tunes', () => {
    const rows = bandRows([ch(14074000, { you: true }), ch(14074500)]);
    const [spot] = rows[0].spots;
    assert.strictEqual(spot.channels.length, 2);
    assert.strictEqual(spot.you, true);
    assert.strictEqual(spot.tune.frequency, 14074500);
});

t('nobody listening is no rows at all, and a bad frequency is not a dot', () => {
    assert.deepStrictEqual(bandRows([]), []);
    assert.deepStrictEqual(bandRows(null), []);
    assert.deepStrictEqual(bandRows([ch(0)]), []);
});

t('the bands are what it opens on, and only a choice of the list is kept', () => {
    // Nothing stored, and anything that is not the list — including a value
    // from a version that stored something else — is the default view.
    assert.strictEqual(savedView(), BANDS_VIEW);
    saveView(LIST_VIEW);
    assert.strictEqual(savedView(), LIST_VIEW);
    saveView(BANDS_VIEW);
    assert.strictEqual(savedView(), BANDS_VIEW);
    store['ubersdr.v2.listeners.view'] = 'waterfall';
    assert.strictEqual(savedView(), BANDS_VIEW);
});

// ── A busy receiver ─────────────────────────────────────────────────────────

t('the threshold follows the bar, so a dot means the same at every dock width', () => {
    // The dock runs 220-560 px (LayoutContext), which is a bar of roughly
    // 145-485. A fixed percentage would be 7 px at one end and 24 at the other.
    const narrow = gapPct(145);
    const wide = gapPct(485);
    assert.ok(narrow > wide, `${narrow} should be coarser than ${wide}`);
    assert.ok(Math.abs((narrow / 100) * 145 - MIN_DOT_GAP_PX) < 0.001);
    assert.ok(Math.abs((wide / 100) * 485 - MIN_DOT_GAP_PX) < 0.001);
    // Nothing measured yet, and nothing absurd from a bar of one pixel.
    assert.strictEqual(gapPct(0), CLUSTER_PCT);
    assert.strictEqual(gapPct(undefined), CLUSTER_PCT);
    assert.strictEqual(gapPct(2), 25);
});

t('fifty listeners on one band stay a row of dots that do not touch', () => {
    // A contest evening: fifty stations spread across 40m, in the narrowest
    // dock there is.
    const bar = 145;
    const crowd = [];
    for (let i = 0; i < 50; i++) crowd.push(ch(7000000 + i * 6000));
    const rows = bandRows(crowd, 10000, 30000000, gapPct(bar));
    assert.strictEqual(rows.length, 1);

    const { spots } = rows[0];
    // Every listener is still on the row, either as a dot or inside one.
    assert.strictEqual(spots.reduce((n, s) => n + s.channels.length, 0), 50);
    // And no two dots overlap: the gap between neighbours is never less than a
    // dot is wide, whatever the receiver is doing.
    for (let i = 1; i < spots.length; i++) {
        const gap = ((spots[i].pct - spots[i - 1].pct) / 100) * bar;
        assert.ok(gap >= MIN_DOT_GAP_PX - 0.001, `dots ${i - 1} and ${i} are ${gap.toFixed(1)} px apart`);
    }
    // Which is what bounds the drawing: the row holds what fits across it, not
    // one element per listener.
    assert.ok(spots.length <= Math.ceil(100 / gapPct(bar)) + 1, `${spots.length} dots`);
});

t('fifty listeners across every band is one row per band, not one per listener', () => {
    const crowd = [];
    const spread = [1900000, 3700000, 5300000, 7100000, 10120000, 14074000,
        18100000, 21074000, 24915000, 28074000, 6070000];
    for (let i = 0; i < 50; i++) crowd.push(ch(spread[i % spread.length] + (i * 700)));
    const rows = bandRows(crowd, 10000, 30000000, gapPct(240));
    // Ten amateur bands plus the broadcast row, and that is the ceiling however
    // many listeners arrive — the panel's height is the bands, not the crowd.
    assert.strictEqual(rows.length, 11);
    assert.strictEqual(rows[rows.length - 1].name, OTHER_ROW);
});

// ── What it draws ───────────────────────────────────────────────────────────

const classOf = (n) => (n.props && n.props.className) || '';
const withClass = (tree, cls) => deep(tree).filter((n) => classOf(n).split(' ').includes(cls));

t('a row per band and a dot per listener, tuning on click', () => {
    reset();
    const tuned = [];
    const { tree } = render(ListenerBands, {
        channels: [ch(7100000), ch(7250000), ch(14074000, { you: true })],
        dialHz: 7100000,
        minHz: 10000,
        maxHz: 30000000,
        now: Date.now(),
        onTune: (c) => tuned.push(c.frequency),
    });

    assert.strictEqual(withClass(tree, 'lsn-band').length, 2);
    const dots = withClass(tree, 'lsn-dot');
    assert.strictEqual(dots.length, 3);

    // Your own dot is read, not pressed — no button, no handler.
    const mine = dots.filter((d) => classOf(d).includes('is-you'));
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].type, 'span');
    assert.strictEqual(mine[0].props.onClick, undefined);

    const theirs = dots.filter((d) => !classOf(d).includes('is-you'));
    assert.strictEqual(theirs[0].type, 'button');
    theirs[0].props.onClick();
    assert.deepStrictEqual(tuned, [7100000]);
});

t('the dial line is drawn in the band the dial is in, and only there', () => {
    reset();
    const { tree } = render(ListenerBands, {
        channels: [ch(7100000), ch(14074000)],
        dialHz: 14100000,
        minHz: 10000,
        maxHz: 30000000,
        now: Date.now(),
        onTune: () => {},
    });
    const dials = withClass(tree, 'lsn-band__dial');
    assert.strictEqual(dials.length, 1);
    // 14.000-14.350: 14.100 is a bit under a third across.
    assert.ok(dials[0].props.style.left.startsWith('28.'), dials[0].props.style.left);
});

t('a dot standing for several says how many, and names them all', () => {
    reset();
    const { tree } = render(ListenerBands, {
        channels: [
            ch(7100000, { chatUsername: 'G0ABC' }),
            ch(7101000, { chatUsername: 'M0XYZ', country: 'England', countryCode: 'GB' }),
        ],
        dialHz: 0,
        now: Date.parse('2026-08-04T12:00:30Z'),
        onTune: () => {},
    });
    const [dot] = withClass(tree, 'lsn-dot');
    assert.ok(classOf(dot).includes('is-many'));
    assert.strictEqual(dot.props.children, '2');
    assert.ok(dot.props.title.includes('G0ABC'), dot.props.title);
    assert.ok(dot.props.title.includes('M0XYZ'), dot.props.title);
    // The age the list would show, on the same line as the listener.
    assert.ok(dot.props.title.includes('30s ago'), dot.props.title);
});

console.log(`\n${pass} passed`);
