// The VFOs panel renders, and its scan does what a scan is for.
//
// The scan is the part worth a test: it moves the dial by itself on a timer, so
// the two ways it can go wrong are both silent. It can step onto an unused slot
// — which does not "do nothing", it seeds that slot with a copy of what is live
// and quietly turns four VFOs into four copies of one frequency. And it can
// fail to stop, either by never noticing the gate open or by noticing the one
// belonging to the VFO it just left, which parks it one place past every signal
// it finds.
//
// The switching itself is vfos.test.js; this is the panel and the timer.

const assert = require('assert');

// Before the bundle: the module graph behind a panel reaches the display
// settings and the radio, and both read the browser at import time.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };

// A clock the test winds by hand: the scan judges the gate against the moment
// it arrived, so the whole question is which side of that line a reading falls.
let clock = 1000;
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

// The scan's timer, held rather than run: setTimeout here hands back the
// callback so a tick is a function call and no real time ever passes. The scan
// reschedules per hop rather than running one interval, because a hop that
// changes mode dwells longer than one that does not — so `timer` is whatever
// the last hop asked for, and timer.ms is the dwell being asserted on.
let timer = null;
globalThis.setTimeout = (fn, ms) => { timer = { fn, ms }; return timer; };
globalThis.clearTimeout = (h) => { if (h === timer) timer = null; };

const { render, reset, walk, VfosPanel, getVfos, setVfos } = require('./.build/vfospanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const slot = (frequency) => ({
    frequency, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700, binBandwidth: null,
});

// A, B and C in use and D unused — so "skips the empty one" is a real step in
// the cycle rather than an assertion about a list.
function threeInUse() {
    setVfos({
        active: 'A',
        slots: { A: null, B: slot(7100000), C: slot(3573000), D: null },
    });
}

function context(over = {}) {
    const tuned = [];
    return {
        tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        view: { binBandwidth: 100, binCount: 2048, defaultBinBandwidth: 400 },
        squelch: { value: -20, enabled: true, threshold: -20 },
        // The mutable meters object, as RadioContext hands it out: the scan
        // reads lastGateOpenAt from it and nothing else.
        meters: { current: { lastGateOpenAt: 0, squelchOpen: false, snr: -40 } },
        tuned,
        actions: {
            tuneTo: (x) => tuned.push(x),
            setSpectrumView: () => {},
            resetSpectrum: () => {},
        },
        ...over,
    };
}

// One dwell elapsing: the held callback runs and schedules the next hop.
const fire = () => { const t = timer; timer = null; t.fn(); };

const byClass = (tree, cls) => walk(tree).filter((n) => (
    typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls)
));
const scanBtn = (tree) => byClass(tree, 'vfos__scan-btn')[0];
const note = (tree) => byClass(tree, 'vfos__scan-note')[0].props.children;

t('the panel renders four rows and a scan button', () => {
    reset();
    threeInUse();
    const { tree } = render(VfosPanel, {}, context());
    assert.strictEqual(byClass(tree, 'vfos__row').length, 4);
    const btn = scanBtn(tree);
    assert.strictEqual(btn.props.children, 'Scan');
    assert.strictEqual(btn.props.disabled, false);
    assert.strictEqual(btn.props['aria-pressed'], false);
});

t('the cut-down view keeps the scan and drops the qualifiers', () => {
    reset();
    threeInUse();
    const { tree } = render(VfosPanel, { minimal: true }, context());
    assert.ok(scanBtn(tree), 'the scan went with the copy row');
    assert.strictEqual(byClass(tree, 'vfos__width').length, 0);
});

t('scanning steps to the next VFO in use, skipping the empty one', () => {
    reset();
    threeInUse();
    const ctx = context();
    // Each render() is a frame over the same hook state, which is how the stub
    // shows a state change: press the button in one, read the result in the next.
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    const running = render(VfosPanel, {}, ctx).tree;
    const btn = scanBtn(running);
    assert.strictEqual(btn.props.children, 'Scanning');
    assert.ok(btn.props.className.includes('is-scanning'), 'the running button is not styled');
    assert.ok(byClass(running, 'vfos')[0].props.className.includes('is-scanning'));
    assert.strictEqual(timer.ms, 250, 'the dwell is not 250 ms');

    // The first move is made on the press, not a dwell later.
    assert.strictEqual(getVfos().active, 'B', 'the scan did not move when it started');
    assert.strictEqual(ctx.tuned.at(-1).frequency, 7100000, 'the receiver did not follow');

    // A quiet channel: the gate has not opened since we landed.
    clock += 250;
    fire();
    assert.strictEqual(getVfos().active, 'C');

    // D holds nothing, so the cycle wraps past it rather than seeding it.
    clock += 250;
    fire();
    assert.strictEqual(getVfos().active, 'A', 'the scan stepped onto the unused VFO');
    assert.strictEqual(getVfos().slots.D, null, 'the unused VFO was filled by the scan');
});

t('a signal where the scan is started does not hold it there', () => {
    // The reported case: pressing Scan while listening to something. The gate
    // is open on the VFO under the dial, and testing it before moving found the
    // signal that was already in the speaker — so the scan stopped where it
    // began and never moved at all. The VFO you start from is the one place a
    // scan has no reason to check: you were already there.
    reset();
    threeInUse();
    const ctx = context();
    ctx.meters.current.lastGateOpenAt = clock;      // open, right now, on A
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    const running = render(VfosPanel, {}, ctx).tree;

    assert.strictEqual(getVfos().active, 'B', 'the scan stopped on the VFO it started from');
    assert.strictEqual(scanBtn(running).props.children, 'Scanning');
});

t('the scan stops where the squelch opens', () => {
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    render(VfosPanel, {}, ctx);

    assert.strictEqual(getVfos().active, 'B', 'the press did not move the scan on');

    // A signal on B: the gate opens while we are sitting on it.
    clock += 200;
    ctx.meters.current.lastGateOpenAt = clock;
    clock += 50;
    fire();

    assert.strictEqual(getVfos().active, 'B', 'the scan stepped off a signal');
    const stopped = render(VfosPanel, {}, ctx).tree;
    assert.strictEqual(scanBtn(stopped).props.children, 'Scan');
    assert.strictEqual(scanBtn(stopped).props['aria-pressed'], false);
});

t('a gate left open by the VFO before this one does not stop the scan', () => {
    // The trap: audio already in flight when the switch went out was produced
    // on the old channel, and the gate it opens is that channel's. Judged from
    // the moment of arrival, so a reading from before it counts for nothing.
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    render(VfosPanel, {}, ctx);

    // The press put us on B. The last gate reading belongs to A, from a moment
    // before we arrived — packets already in flight when the switch went out.
    assert.strictEqual(getVfos().active, 'B');
    ctx.meters.current.lastGateOpenAt = clock;

    // Nothing further arrives, so that stale reading is all there is: it must
    // not be taken as a signal on B.
    clock += 250;
    fire();
    assert.strictEqual(getVfos().active, 'C', 'the scan stopped on the VFO after the signal');
});

t('a hop that changes mode dwells long enough to hear it', () => {
    // The server holds the audio gate shut across a mode change: radiod reloads
    // a preset, rebuilds the filter and restarts the demodulator, and until it
    // confirms the new channel there is deliberately nothing to hear. A hop
    // judged inside that window finds silence on a busy VFO and steps over it,
    // which is the same missed signal as stopping on noise, in the other
    // direction.
    reset();
    setVfos({
        active: 'A',
        slots: {
            A: null,
            B: { ...slot(7100000), mode: 'am' },   // usb -> am
            C: slot(3573000),                      // am -> usb
            D: null,
        },
    });
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    render(VfosPanel, {}, ctx);

    assert.strictEqual(getVfos().active, 'B');
    assert.strictEqual(timer.ms, 600, 'a hop onto another mode took the plain dwell');

    // A signal arriving inside the settling window is the server's silence
    // ending, not this VFO answering, so it must not stop the scan.
    clock += 200;
    ctx.meters.current.lastGateOpenAt = clock;
    clock += 400;
    fire();
    assert.strictEqual(getVfos().active, 'C', 'the scan stopped inside the settling window');
});

t('a hop that keeps the mode keeps the short dwell', () => {
    // Only mode changes cost anything, so the common case must not be slowed
    // down: four same-mode VFOs still come round in a second.
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    render(VfosPanel, {}, ctx);

    assert.strictEqual(timer.ms, 250, 'a same-mode hop took the mode-change dwell');
    clock += 250;
    fire();
    assert.strictEqual(timer.ms, 250);
});

t('picking a VFO by hand ends the scan', () => {
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    const running = render(VfosPanel, {}, ctx).tree;

    assert.strictEqual(getVfos().active, 'B', 'the press did not move the scan on');
    byClass(running, 'vfos__row')[2].props.onClick();    // C

    assert.strictEqual(getVfos().active, 'C');
    const after = render(VfosPanel, {}, ctx).tree;
    assert.strictEqual(scanBtn(after).props.children, 'Scan');
});

t('there is nothing to scan with one VFO in use', () => {
    reset();
    setVfos({ active: 'A', slots: { A: null, B: null, C: null, D: null } });
    const { tree } = render(VfosPanel, {}, context());
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.strictEqual(note(tree), 'Needs two VFOs in use');
});

t('a scan with the squelch off would never stop, so it is refused', () => {
    reset();
    threeInUse();
    const ctx = context({ squelch: { value: -100, enabled: false, threshold: null } });
    const { tree } = render(VfosPanel, {}, ctx);
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.ok(/Squelch off/.test(note(tree)), note(tree));
});

t('IQ has no gate, so it has no scan either', () => {
    reset();
    threeInUse();
    const ctx = context();
    ctx.tuning = { ...ctx.tuning, mode: 'iq' };
    const { tree } = render(VfosPanel, {}, ctx);
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.strictEqual(note(tree), 'No squelch in IQ mode');
});

t('the squelch going off under a running scan stops it', () => {
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    render(VfosPanel, {}, ctx);

    ctx.squelch = { value: -100, enabled: false, threshold: null };
    render(VfosPanel, {}, ctx);     // the panel re-renders with the new context

    // Where the scan has reached is not the point of this one — the stub
    // re-mounts every effect on every frame, so each render moves it on. What
    // matters is that the next dwell does not.
    const parked = getVfos().active;
    clock += 250;
    fire();
    assert.strictEqual(getVfos().active, parked, 'the scan kept stepping with nothing to stop it');
    assert.strictEqual(scanBtn(render(VfosPanel, {}, ctx).tree).props.children, 'Scan');
});

t('closing the panel takes the timer with it', () => {
    // A panel is unmounted whenever its section is collapsed, and a timer that
    // outlived one would go on tuning the receiver with nothing on screen
    // saying so — once per collapse-and-open.
    reset();
    threeInUse();
    const ctx = context();
    render(VfosPanel, {}, ctx);
    scanBtn(render(VfosPanel, {}, ctx).tree).props.onClick();
    const { cleanups } = render(VfosPanel, {}, ctx);

    assert.ok(timer, 'the scan never started');
    for (const off of cleanups) off();
    assert.strictEqual(timer, null, 'the scan timer outlived the panel');
});

console.log(`\n${pass} VFOs panel checks passed`);
