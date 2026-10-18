// The Timeshift panel, its header badge and its watch actually render, live,
// replaying and paused — and the watch's two rules hold. See hookStub.js for
// why a render test is the only thing that catches a panel that blanks.

const assert = require('assert');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
// The replay timer and the panel's clock are driven by hand.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const {
    deep, render, reset, words, TimeshiftPanel, TimeshiftBadge, TimeshiftWatch, getTimeshift, tuningNote,
} = require('./.build/timeshiftpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const ts = getTimeshift();
let now = 100000;
ts.now = () => now;
ts.setEnabled(true);
// Ten seconds of spectrum, no player: enough history to seek into.
for (let i = 0; i < 100; i++) {
    ts.recordFrame({ bins: new Float32Array(4), frequency: 1e6 }, 100);
    now += 100;
}

const context = (over = {}) => ({
    running: true,
    tuning: { frequency: 7100000, mode: 'lsb' },
    sections: {},
    ...over,
});
const text = (tree) => words({ children: deep(tree) });
const buttons = (tree) => deep(tree).filter((n) => n.type === 'button');

t('live: renders, says Live, Live button disabled', () => {
    reset();
    const { tree, cleanups } = render(TimeshiftPanel, {}, context());
    assert.ok(/LIVE/.test(text(tree)));
    const live = buttons(tree).find((b) => words(b).includes('Live'));
    assert.ok(live && live.props.disabled, 'Live disabled while live');
    cleanups.forEach((f) => f());
    reset();
    assert.strictEqual(render(TimeshiftBadge, {}, context()).tree, null);
});

t('replaying: shows how far behind, in the panel and the badge', () => {
    ts.seekBehind(5000);
    reset();
    const { tree, cleanups } = render(TimeshiftPanel, {}, context());
    assert.ok(/REPLAY/.test(text(tree)), text(tree));
    assert.ok(text(tree).includes('−5.0 s'), text(tree));
    cleanups.forEach((f) => f());
    reset();
    const badge = render(TimeshiftBadge, {}, context()).tree;
    assert.ok(words(badge).includes('−5.0 s'));
});

t('paused, compact: the status line is the clock, and the big clock goes', () => {
    ts.pause();
    reset();
    const { tree } = render(TimeshiftPanel, { minimal: true }, context());
    assert.ok(/PAUSED/.test(text(tree)));
    assert.ok(/behind live/.test(text(tree)), text(tree));
    assert.ok(!deep(tree).some((n) => n.props && /rec-time/.test(String(n.props.className || ''))));
    reset();
    const full = render(TimeshiftPanel, {}, context()).tree;
    assert.ok(deep(full).some((n) => n.props && /rec-time/.test(String(n.props.className || ''))));
    ts.goLive();
});

t('watch: hidden panel turns the buffer off, shown turns it on', () => {
    reset();
    render(TimeshiftWatch, {}, context({ sections: { timeshift: { hidden: true } } }));
    assert.strictEqual(ts.enabled, false);
    reset();
    render(TimeshiftWatch, {}, context());
    assert.strictEqual(ts.enabled, true);
});

t('watch: a retune goes back to live', () => {
    for (let i = 0; i < 50; i++) { ts.recordFrame({ bins: new Float32Array(4), frequency: 1e6 }, 100); now += 100; }
    reset();
    render(TimeshiftWatch, {}, context());
    ts.seekBehind(3000);
    assert.ok(ts.replaying);
    // Same hook slots, new tuning: what React does on the next render.
    render(TimeshiftWatch, {}, context({ tuning: { frequency: 7101000, mode: 'lsb' } }));
    assert.strictEqual(ts.replaying, false);
});

t('watch: a passband change goes back to live too', () => {
    const tuned = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };
    reset();
    render(TimeshiftWatch, {}, context({ tuning: tuned }));
    ts.seekBehind(3000);
    assert.ok(ts.replaying);
    render(TimeshiftWatch, {}, context({ tuning: { ...tuned, bandwidthLow: -3000 } }));
    assert.strictEqual(ts.replaying, false);
});

t('tuningNote: frequency and mode when either moved, the width when only the passband did', () => {
    const now = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };
    assert.strictEqual(tuningNote({ ...now }, now), '');
    assert.strictEqual(tuningNote({ ...now, frequency: 14074000, mode: 'usb' }, now), '14074 kHz USB');
    assert.strictEqual(tuningNote({ ...now, frequency: 7100500 }, now), '7100.5 kHz LSB');
    assert.strictEqual(tuningNote({ ...now, bandwidthLow: -3000 }, now), '2.95k');
    assert.strictEqual(tuningNote(null, now), '');
});

t('panel: names the tuning of the moment playing when the dial has moved since', () => {
    const before = { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 };
    const after = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };
    reset();
    render(TimeshiftWatch, {}, context({ tuning: before }));
    for (let i = 0; i < 50; i++) { ts.recordFrame({ bins: new Float32Array(4), frequency: 1e6 }, 100); now += 100; }
    render(TimeshiftWatch, {}, context({ tuning: after }));
    for (let i = 0; i < 20; i++) { ts.recordFrame({ bins: new Float32Array(4), frequency: 1e6 }, 100); now += 100; }
    ts.seekBehind(4000);
    for (const minimal of [false, true]) {
        reset();
        const { tree } = render(TimeshiftPanel, { minimal }, context({ tuning: after }));
        assert.ok(text(tree).includes('14074 kHz USB'), text(tree));
    }
    ts.seekBehind(1000);
    reset();
    const { tree } = render(TimeshiftPanel, {}, context({ tuning: after }));
    assert.ok(!/Tuned to/.test(text(tree)), 'not when it matches the dial');
    ts.goLive();
});

console.log(`\n${pass} passed`);
