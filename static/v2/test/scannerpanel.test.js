// The Scanner panel renders, and its scan does what a scan is for.
//
// Same reasoning as vfospanel.test.js: a scan moves the dial by itself on a
// timer, so both ways it can go wrong are silent. It can fail to move — picking
// the same target over and over because it read the dial back rather than
// remembering where it had got to — and it can fail to stop, either by never
// noticing the gate open or by noticing the one belonging to the channel it just
// left, which parks it one target past every signal it finds.
//
// The list itself is scanner.test.js; this is the panel and the timer.

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

// A clock the test winds by hand: the scan judges the gate against the moment it
// arrived, so the whole question is which side of that line a reading falls.
let clock = 1000;
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

// The scan's timer, held rather than run. It reschedules per hop rather than
// running one interval, because a hop that changes mode dwells longer — so
// `timer` is whatever the last hop asked for, and timer.ms is the dwell being
// asserted on.
let timer = null;
globalThis.setTimeout = (fn, ms) => { timer = { fn, ms }; return timer; };
globalThis.clearTimeout = (h) => { if (h === timer) timer = null; };

const {
    render, reset, walk, words, ScannerPanel, _resetScanSettings, saveScanSettings,
} = require('./.build/scannerpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Local bookmarks as the markers, deliberately. They come straight off the radio
// context, so the panel's feeds subscribe to nothing and the test needs no
// network: the scan being exercised is the same one whatever put the markers
// there.
const mark = (frequency, name, mode = 'usb') => ({ frequency, name, mode });

function context(over = {}) {
    const tuned = [];
    return {
        tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        view: { binBandwidth: 100, binCount: 2048, defaultBinBandwidth: 400 },
        squelch: { value: -20, enabled: true, threshold: -20 },
        running: true,
        serverInfo: {},
        catalog: {
            bookmarks: [],
            local: [mark(14100000, 'One'), mark(14200000, 'Two'), mark(14300000, 'Three')],
        },
        // The mutable meters object, as RadioContext hands it out: the scan
        // reads lastGateOpenAt from it and nothing else.
        meters: { current: { lastGateOpenAt: 0, squelchOpen: false, snr: -40 } },
        tuned,
        actions: {
            tuneTo: (x) => tuned.push(x),
            ensureVisible: () => {},
        },
        ...over,
    };
}

// One dwell elapsing: the held callback runs and schedules the next hop.
const fire = () => { const h = timer; timer = null; h.fn(); };

const byClass = (tree, cls) => walk(tree).filter((n) => (
    typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls)
));
const scanBtn = (tree) => byClass(tree, 'scan__btn')[0];
const label = (tree) => scanBtn(tree).props.children.filter((c) => typeof c === 'string').join('');
const note = (tree) => byClass(tree, 'scan__note')[0].props.children;

// Bookmarks, because the shipped selection is voice and this test has no voice
// feed. What is being exercised is the scan, not which feed filled the list.
const scanBookmarks = () => {
    _resetScanSettings();
    store.clear();
    saveScanSettings({ types: ['bookmark-local'], bandOnly: true });
};

// Press Scan. Each render() is a frame over the same hook state, which is how
// the stub shows a state change: press the button in one, read the result in
// the next.
function start(ctx) {
    render(ScannerPanel, {}, ctx);
    scanBtn(render(ScannerPanel, {}, ctx).tree).props.onClick();
    return render(ScannerPanel, {}, ctx).tree;
}

t('the panel renders the targets, the button and both pickers', () => {
    reset();
    scanBookmarks();
    const { tree } = render(ScannerPanel, {}, context());
    assert.strictEqual(byClass(tree, 'scan__row').length, 3);
    assert.strictEqual(label(tree), 'Scan');
    assert.strictEqual(scanBtn(tree).props.disabled, false);
    assert.strictEqual(scanBtn(tree).props['aria-pressed'], false);
    // The band is named in the note, because "3 markers" alone does not say
    // that the other bands were left out on purpose.
    assert.ok(/3 markers on 20m/.test(note(tree)), note(tree));
    assert.ok(/Current band only/.test(words(tree)), 'the band switch is missing');
});

t('the cut-down view keeps the scan and drops the pickers', () => {
    reset();
    scanBookmarks();
    const { tree } = render(ScannerPanel, { minimal: true }, context());
    assert.ok(scanBtn(tree), 'the scan went with the pickers');
    assert.strictEqual(byClass(tree, 'scan__row').length, 3);
    assert.ok(!/Current band only/.test(words(tree)), 'the band switch survived the cut');
});

t('the shipped settings scan voice, on the current band', () => {
    reset();
    _resetScanSettings();
    store.clear();
    const ctx = context();
    const { tree } = render(ScannerPanel, {}, ctx);
    // No voice feed on this receiver, so there is nothing to scan — but the
    // panel must say which kinds it was looking for rather than going blank.
    assert.ok(/Voice/.test(words(tree)), 'the Voice chip is missing');
    assert.ok(/Nothing to scan on 20m/.test(words(tree)), words(tree));
});

t('the scan starts at the first target above the dial', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    const running = start(ctx);

    assert.strictEqual(label(running), 'Scanning');
    assert.ok(scanBtn(running).props.className.includes('is-scanning'), 'the running button is not styled');
    assert.strictEqual(timer.ms, 250, 'the dwell is not 250 ms');
    // The first move is made on the press, not a dwell later: the channel you
    // are on is the one place a scan has no reason to check.
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14100000, 'the scan did not move when it started');
});

t('each dwell moves it on, and the top of the list wraps', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    start(ctx);

    clock += 250;
    fire();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14200000);
    clock += 250;
    fire();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14300000);
    clock += 250;
    fire();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14100000, 'the scan did not come round');
});

t('the scan keeps its own place rather than reading the dial back', () => {
    // The trap this panel has that the VFOs panel does not. The context's dial
    // never moves here — which is the same thing as a tune the server clamped,
    // or one the panel has not re-rendered for yet. A scan that took the dial
    // as its place would pick the first target again on every hop and sit
    // there, moving the dial and going nowhere.
    reset();
    scanBookmarks();
    const ctx = context();
    start(ctx);

    clock += 250;
    fire();
    clock += 250;
    fire();
    assert.deepStrictEqual(
        ctx.tuned.map((x) => x.frequency),
        [14100000, 14200000, 14300000],
        'the scan tuned the same target twice',
    );
});

t('the scan stops where the squelch opens', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    start(ctx);

    // A signal on the target we landed on: the gate opens while we sit there.
    clock += 200;
    ctx.meters.current.lastGateOpenAt = clock;
    clock += 50;
    fire();

    assert.strictEqual(ctx.tuned.length, 1, 'the scan stepped off a signal');
    const stopped = render(ScannerPanel, {}, ctx).tree;
    assert.strictEqual(label(stopped), 'Scan');
    assert.strictEqual(scanBtn(stopped).props['aria-pressed'], false);
});

t('a gate left open by the target before this one does not stop the scan', () => {
    // Audio already in flight when the tune went out was produced on the old
    // channel, and the gate it opens is that channel's. Judged from a moment
    // after arrival, so a reading from before it counts for nothing.
    reset();
    scanBookmarks();
    const ctx = context();
    start(ctx);

    ctx.meters.current.lastGateOpenAt = clock;      // from before we landed
    clock += 250;
    fire();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14200000,
        'the scan stopped on the target after the signal');
});

t('a hop that changes mode dwells long enough to hear it', () => {
    // The server holds the audio gate shut across a mode change while radiod
    // reloads its preset. A hop judged inside that window finds silence on a
    // busy channel and steps over it.
    reset();
    scanBookmarks();
    const ctx = context({
        catalog: {
            bookmarks: [],
            local: [mark(14100000, 'One', 'am'), mark(14200000, 'Two', 'usb')],
        },
    });
    start(ctx);

    assert.strictEqual(timer.ms, 600, 'a hop onto another mode took the plain dwell');
    // A signal arriving inside the settling window is the server's silence
    // ending, not this channel answering, so it must not stop the scan.
    clock += 200;
    ctx.meters.current.lastGateOpenAt = clock;
    clock += 400;
    fire();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14200000,
        'the scan stopped inside the settling window');
    assert.strictEqual(timer.ms, 250, 'a same-mode hop took the mode-change dwell');
});

t('picking a target by hand ends the scan', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    const running = start(ctx);

    byClass(running, 'scan__row')[2].props.onClick();
    assert.strictEqual(ctx.tuned.at(-1).frequency, 14300000);
    assert.strictEqual(label(render(ScannerPanel, {}, ctx).tree), 'Scan');
});

t('one marker is nowhere to go, so the scan is refused', () => {
    reset();
    scanBookmarks();
    const ctx = context({ catalog: { bookmarks: [], local: [mark(14100000, 'One')] } });
    const { tree } = render(ScannerPanel, {}, ctx);
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.strictEqual(note(tree), 'Needs two markers to scan between');
});

t('a scan with the squelch off would never stop, so it is refused', () => {
    reset();
    scanBookmarks();
    const ctx = context({ squelch: { value: -100, enabled: false, threshold: null } });
    const { tree } = render(ScannerPanel, {}, ctx);
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.ok(/Squelch off/.test(note(tree)), note(tree));
});

t('IQ has no gate, so it has no scan either', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    ctx.tuning = { ...ctx.tuning, mode: 'iq' };
    const { tree } = render(ScannerPanel, {}, ctx);
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.strictEqual(note(tree), 'No squelch in IQ mode');
});

t('deselecting every kind says so rather than going blank', () => {
    reset();
    _resetScanSettings();
    store.clear();
    saveScanSettings({ types: [] });
    const { tree } = render(ScannerPanel, {}, context());
    assert.strictEqual(scanBtn(tree).props.disabled, true);
    assert.strictEqual(note(tree), 'No marker kinds selected');
});

t('the band switch widens the scan to every band', () => {
    reset();
    _resetScanSettings();
    store.clear();
    saveScanSettings({ types: ['bookmark-local'], bandOnly: false });
    const ctx = context({
        catalog: {
            bookmarks: [],
            local: [mark(7100000, 'Forty'), mark(14100000, 'Twenty')],
        },
    });
    const { tree } = render(ScannerPanel, {}, ctx);
    assert.strictEqual(byClass(tree, 'scan__row').length, 2);
    assert.ok(!/on 20m/.test(note(tree)), note(tree));
});

t('the squelch going off under a running scan stops it', () => {
    reset();
    scanBookmarks();
    const ctx = context();
    start(ctx);

    ctx.squelch = { value: -100, enabled: false, threshold: null };
    render(ScannerPanel, {}, ctx);     // the panel re-renders with the new context

    // Where the scan has reached is not the point — the stub re-mounts every
    // effect on every frame, so each render moves it on. What matters is that
    // the next dwell does not.
    const parked = ctx.tuned.length;
    clock += 250;
    fire();
    assert.strictEqual(ctx.tuned.length, parked, 'the scan kept stepping with nothing to stop it');
    assert.strictEqual(label(render(ScannerPanel, {}, ctx).tree), 'Scan');
});

t('closing the panel takes the timer with it', () => {
    // A panel is unmounted whenever its section is collapsed, and a timer that
    // outlived one would go on tuning the receiver with nothing on screen saying
    // so — once per collapse-and-open.
    reset();
    scanBookmarks();
    const ctx = context();
    render(ScannerPanel, {}, ctx);
    scanBtn(render(ScannerPanel, {}, ctx).tree).props.onClick();
    const { cleanups } = render(ScannerPanel, {}, ctx);

    assert.ok(timer, 'the scan never started');
    for (const off of cleanups) off();
    assert.strictEqual(timer, null, 'the scan timer outlived the panel');
});

console.log(`\n${pass} Scanner panel checks passed`);
