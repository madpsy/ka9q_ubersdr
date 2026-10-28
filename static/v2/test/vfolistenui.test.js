// The simultaneous-VFO interface: what the operator sees and presses.
//
// The engine and the store are subreceivers.test.js and vfolisten.test.js; this
// is the layer on top. Three kinds of check:
//
//   * the panels render under the hook stub — the VFOs panel at a limit of one
//     (exactly as before), two and four, and the Receiver panel's VFO bar —
//     because a scope error here builds cleanly and blanks the panel;
//   * the pure helpers that decide what the spectrum and the marker bar draw and
//     what a pointer is on, which are otherwise only visible on a canvas;
//   * the control-surface functions, which are reachable from a keyboard and a
//     MIDI box with no panel open at all.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
let clock = 10_000;
globalThis.performance = { now: () => clock };
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
};
globalThis.navigator = { userAgent: 'node' };
globalThis.location = { protocol: 'http:', hostname: 'rx.test', host: 'rx.test', search: '' };
Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', getRandomValues: (b) => b },
    configurable: true,
});
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// Nothing may outlive the assertions: a mounted interval or a throttle's timer
// would keep node running after the last check — see wavlossless.test.js.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// The /connection reply, for setting the VFO count the way the server does.
let reply = {};
globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ allowed: true, reason: '', client_ip: '10.0.0.9', ...reply }),
});

const {
    deep, render, reset,
    VfosPanel, listenNote, outLabel, sqLabel, ReceiverPanel, canToggleListen, StatusPanel, DEFAULTS,
    getVfos, setVfos, getSubReceivers, connectionCheck, getVfoLimit, newSessionId,
    colours, marks, catalogue, muteAllListening, nextListeningVfo, runFunction,
} = require('./.build/vfolistenui.cjs');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

// --- fixtures ---------------------------------------------------------------

class FakeConn {
    constructor(vfo) {
        this.vfo = vfo;
        this.state = 'idle';
        this.ws = null;
        this.opening = false;
        this.params = null;
        this.bytesIn = 0;
    }

    on() { return () => {}; }

    setFormat() {}

    connect(params) { this.params = { ...params }; }

    disconnect() { this.ws = null; }

    send() { return false; }

    tune() { return false; }

    setMuted() { return false; }

    setAudioGate() { return false; }
}

const player = { setPan() {}, on() { return () => {}; }, ctx: null, subOutput: null };

// The page's engine, with fake sockets, and the VFO count set two ways: on the
// engine's own source (what the panel reads through its snapshot) and on the
// session (what the VFO bar and the control functions read), the second the way
// the server sets it — through a /connection answer.
const subs = getSubReceivers(player);
subs.makeConnection = (vfo) => new FakeConn(vfo);

async function setLimit(n) {
    subs.limitSource = { get: () => n, on: () => () => {} };
    reply = { vfos: n };
    newSessionId();
    await connectionCheck();
    assert.strictEqual(getVfoLimit(), n);
}

const slot = (frequency, mode = 'usb') => ({
    frequency,
    mode,
    bandwidthLow: mode === 'lsb' ? -2700 : 50,
    bandwidthHigh: mode === 'lsb' ? -50 : 2700,
    binBandwidth: null,
});

const L = (on = false, extra = {}) => ({ on, out: 'auto', vol: 1, muted: false, ...extra });

// A on the main receiver, B parked in LSB, C parked in USB, D unused. `listen`
// switches some of them on.
function state(listen = {}) {
    setVfos({
        active: 'A',
        slots: { A: null, B: slot(7_100_000, 'lsb'), C: slot(3_573_000), D: null },
        listen: { A: L(), B: L(listen.B), C: L(listen.C), D: L(listen.D) },
    });
}

function context(over = {}) {
    return {
        tuning: { frequency: 14_074_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        view: { centerFreq: 14_074_000, span: 200_000, binCount: 2048, binBandwidth: 100 },
        squelch: { value: 6, enabled: true, threshold: 6 },
        meters: { current: { lastGateOpenAt: 0, squelchOpen: false, snr: 3 } },
        running: true,
        player,
        serverInfo: {},
        allowedIQModes: [],
        actions: {
            tuneTo() {}, setSpectrumView() {}, resetSpectrum() {}, setFrequency() {}, setMode() {},
            setBandwidth() {}, stepBy() {},
        },
        ...DEFAULTS,
        set() {},
        setTuneStep() {},
        ...over,
    };
}

// The engine follows the store once the receiver is running: lanes for the
// listening VFOs, so the snapshot the panel reads carries their rows. The socket
// stays shut (`open: false`) — nothing connects in a test.
function run(ctx) {
    subs.update({ running: true, open: false, tuning: ctx.tuning, threshold: 6 });
}

// Render, read, and unmount: every effect's cleanup is run before the next
// check, or a subscription left behind would carry one test's state into the
// next.
function frame(Component, props, ctx) {
    const out = render(Component, props, ctx);
    for (const off of out.cleanups) off();
    return out.tree;
}

// words() keeps string children only, and a number in JSX — "up to {limit}" —
// is a child of its own. This keeps both.
function text(tree) {
    const kids = (n) => {
        const c = n.children && n.children.length ? n.children : (n.props && n.props.children != null ? [n.props.children] : []);
        return c.flat(Infinity);
    };
    return deep(tree)
        .flatMap((n) => kids(n).filter((c) => typeof c === 'string' || typeof c === 'number'))
        .map((c) => String(c).trim())
        .filter(Boolean)
        .join(' ');
}

const byClass = (tree, cls) => deep(tree).filter((n) => (
    typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls)
));

// --- the palette --------------------------------------------------------------

const hueGap = (a, b) => {
    const d = Math.abs(colours.hueOf(a) - colours.hueOf(b)) % 360;
    return Math.min(d, 360 - d);
};

t('each VFO letter has its own colour, far enough from the others to tell apart', () => {
    const ids = ['A', 'B', 'C', 'D'];
    for (const a of ids) {
        for (const b of ids) {
            if (a >= b) continue;
            const gap = hueGap(colours.VFO_COLOURS[a], colours.VFO_COLOURS[b]);
            assert.ok(gap >= 25, `${a} and ${b} are only ${gap.toFixed(0)}° apart`);
        }
    }
});

t('no VFO colour can be taken for the accent, a parked VFO or the main passband', () => {
    for (const [id, c] of Object.entries(colours.VFO_COLOURS)) {
        for (const [what, avoid] of Object.entries(colours.AVOID_COLOURS)) {
            const gap = hueGap(c, avoid);
            assert.ok(gap >= 25, `VFO ${id} is ${gap.toFixed(0)}° from ${what}`);
        }
    }
});

t('every VFO colour reads on the near-black spectrum canvas', () => {
    const bg = colours.luminance('#0b0e14');
    for (const [id, c] of Object.entries(colours.VFO_COLOURS)) {
        const ratio = (colours.luminance(c) + 0.05) / (bg + 0.05);
        assert.ok(ratio >= 4.5, `VFO ${id} has a contrast of ${ratio.toFixed(1)}`);
    }
    assert.strictEqual(colours.vfoRgba('B', 0.5), 'rgba(62, 224, 127, 0.5)');
});

// --- what the spectrum draws --------------------------------------------------

const TUNING = { frequency: 14_074_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 };

t('listening passbands take the main filter shape and skip what is not playing', async () => {
    // isListening reads the session's VFO count, and one plays nothing.
    await setLimit(4);
    state({ B: true, C: true });
    const snap = { vfos: { B: { squelchOpen: true }, C: { overLimit: true } } };
    const list = marks.listeningPassbands(getVfos(), snap, TUNING);
    assert.deepStrictEqual(list.map((v) => v.id), ['B'], 'an over-limit VFO is drawn');
    // B is saved in LSB, but it plays in USB like the main receiver: the
    // passband drawn is the one being demodulated.
    assert.strictEqual(list[0].low, 50);
    assert.strictEqual(list[0].high, 2700);
    assert.strictEqual(list[0].frequency, 7_100_000);
    assert.strictEqual(list[0].open, true);
    assert.strictEqual(list[0].colour, colours.VFO_COLOURS.B);
});

t('a pointer finds the listening passband it is over, nearest dial first', () => {
    const cfg = { centerFreq: 10_000, span: 10_000 };      // 5 kHz .. 15 kHz over 1000 px
    const list = [
        { id: 'B', frequency: 8_000, low: 50, high: 2700 },   // 805..1070 px... in Hz: 8050..10700
        { id: 'C', frequency: 9_500, low: 50, high: 2700 },   // 9550..12200 Hz
    ];
    const x = (hz) => ((hz - 5_000) / 10_000) * 1000;
    assert.strictEqual(marks.passbandAt(x(8_500), list, cfg, 1000), 'B');
    // Inside both: C's dial is the nearer.
    assert.strictEqual(marks.passbandAt(x(9_600), list, cfg, 1000), 'C');
    assert.strictEqual(marks.passbandAt(x(14_000), list, cfg, 1000), null);
    assert.strictEqual(marks.passbandAt(x(8_500), [], cfg, 1000), null);
});

t('a listening passband with its own filter is drawn with it', async () => {
    await setLimit(4);
    state({ B: true, C: true });
    const v = getVfos();
    setVfos({ ...v, listen: { ...v.listen, B: { ...v.listen.B, bw: { ssb: [50, 1850] } } } });
    const list = marks.listeningPassbands(getVfos(), null, TUNING);
    const b = list.find((x) => x.id === 'B');
    const c = list.find((x) => x.id === 'C');
    assert.deepStrictEqual([b.low, b.high, b.own], [50, 1850, true]);
    assert.deepStrictEqual([c.low, c.high, c.own], [50, 2700, false]);
    assert.notStrictEqual(marks.passbandsKey([b]), marks.passbandsKey([{ ...b, high: 2700 }]), 'the cache key moves with it');
});

t('a listening passband brightens by its own squelch: gated only where it has one on', async () => {
    await setLimit(4);
    state({ B: true, C: true });
    const snap = { vfos: { B: { squelchOpen: true, threshold: 12 }, C: { squelchOpen: true, threshold: null } } };
    const list = marks.listeningPassbands(getVfos(), snap, TUNING);
    assert.deepStrictEqual(list.map((v) => [v.id, v.gated]), [['B', true], ['C', false]]);
});

t('a pointer on a listening passband edge finds that VFO and edge', () => {
    const cfg = { centerFreq: 10_000, span: 10_000 };      // 5 kHz .. 15 kHz over 1000 px
    const list = [{ id: 'B', frequency: 8_000, low: 50, high: 2700 }];  // 8050..10700 Hz
    const x = (hz) => ((hz - 5_000) / 10_000) * 1000;
    assert.deepStrictEqual(marks.listenEdgeAt(x(10_700), list, cfg, 1000, 6, 18), { id: 'B', which: 'high' });
    assert.deepStrictEqual(marks.listenEdgeAt(x(8_050) + 2, list, cfg, 1000, 6, 18), { id: 'B', which: 'low' });
    assert.strictEqual(marks.listenEdgeAt(x(9_400), list, cfg, 1000, 6, 18), null, 'the middle retunes instead');
    // Too narrow on screen to grab: no edge, so a drag there retunes.
    assert.strictEqual(marks.listenEdgeAt(x(10_700), list, { centerFreq: 10_000, span: 1_000_000 }, 1000, 6, 18), null);
});

t('the brighten eases in over about 150 ms and settles exactly', () => {
    assert.strictEqual(marks.easeLevel(0, 1, 0), 0, 'no time, no change');
    const one = marks.easeLevel(0, 1, 150);
    assert.ok(one > 0.6 && one < 0.66, `one time constant reached ${one}`);
    assert.strictEqual(marks.easeLevel(0.995, 1, 16), 1, 'never quite arriving keeps the cache busy');
    assert.strictEqual(marks.easeLevel(undefined, 0, 50), 0);
});

t('an open passband is about 1.7 times as strong, however its theme colour is written', () => {
    assert.strictEqual(marks.washAlpha(0.2, 0), 0.2);
    assert.ok(Math.abs(marks.washAlpha(0.2, 1) - 0.34) < 1e-9);
    // The main wash is drawn twice; the second pass has to land on the same.
    const a = marks.alphaOf('rgba(139, 124, 248, 0.22)');
    assert.strictEqual(a, 0.22);
    const k = marks.overlayAlpha(a, 1);
    assert.ok(Math.abs(a + k * a * (1 - a) - 0.22 * 1.7) < 1e-9, 'the overlay misses');
    assert.strictEqual(marks.overlayAlpha(a, 0), 0);
    assert.strictEqual(marks.alphaOf('#8b7cf8'), 1);
    assert.ok(Math.abs(marks.alphaOf('#8b7cf880') - 128 / 255) < 1e-9);
    assert.ok(marks.markBoost(1) > 1 && marks.markBoost(1) < 1.5, 'the lines are only slightly stronger');
});

t('shift-click tunes the VFO last touched, while it is still listening', async () => {
    // isListening reads the session's VFO count, and one plays nothing.
    await setLimit(4);
    marks.resetTouched();
    state({ B: true, C: true });
    assert.strictEqual(marks.shiftTarget(getVfos()), 'B', 'nothing touched: the first one');
    marks.touchVfo('C');
    assert.strictEqual(marks.shiftTarget(getVfos()), 'C');
    state({ B: true });
    assert.strictEqual(marks.shiftTarget(getVfos()), 'B', 'C stopped listening');
    state({});
    assert.strictEqual(marks.shiftTarget(getVfos()), null, 'nothing listening: a plain click');
});

t('the marker bar shows listening VFOs even with VFO markers off, and the main one beside them', () => {
    state({ B: true });
    const off = marks.vfoMarkerItems(getVfos(), TUNING, { showParked: false, limit: 2 });
    assert.deepStrictEqual(off.map((v) => `${v.id}:${v.kind}`), ['B:listening', 'A:main']);
    const on = marks.vfoMarkerItems(getVfos(), TUNING, { showParked: true, limit: 2 });
    assert.deepStrictEqual(on.map((v) => `${v.id}:${v.kind}`), ['B:listening', 'C:parked', 'A:main']);
    // One VFO on this receiver: nothing is listening, whatever the store says,
    // and there is no main circle either.
    const one = marks.vfoMarkerItems(getVfos(), TUNING, { showParked: true, limit: 1 });
    assert.deepStrictEqual(one.map((v) => `${v.id}:${v.kind}`), ['B:parked', 'C:parked']);
    state({});
    assert.ok(!marks.vfoMarkerItems(getVfos(), TUNING, { limit: 4 }).some((v) => v.kind === 'main'));
});

t('a cache key that moves with every listening VFO', () => {
    const a = marks.passbandsKey([{ id: 'B', frequency: 1, low: 2, high: 3 }]);
    const b = marks.passbandsKey([{ id: 'B', frequency: 2, low: 2, high: 3 }]);
    assert.notStrictEqual(a, b);
    assert.strictEqual(marks.passbandsKey(undefined), '');
});

// --- the VFOs panel's words ---------------------------------------------------

t('the lit output button says where an Auto VFO landed', () => {
    assert.strictEqual(outLabel('auto', -1), 'Auto·L');
    assert.strictEqual(outLabel('auto', 1), 'Auto·R');
    assert.strictEqual(outLabel('auto', 0), 'Auto·C');
    assert.strictEqual(outLabel('auto', null), 'Auto');
    assert.strictEqual(outLabel('left', 1), 'L');
    assert.strictEqual(outLabel('right', -1), 'R');
    assert.strictEqual(outLabel('both', 0), 'Both');
});

t('a listening row says why it is not simply playing, most pressing first', () => {
    const row = { listening: true, mode: 'USB', savedMode: 'LSB' };
    assert.strictEqual(listenNote(row, null), 'LSB saved · listening in USB');
    assert.strictEqual(listenNote({ ...row, savedMode: 'USB' }, null), null);
    assert.strictEqual(listenNote(row, { refused: 'This receiver allows 2 VFOs' }),
        'This receiver allows 2 VFOs');
    assert.strictEqual(listenNote(row, { waitingPrimary: true }), 'Waiting for the main stream');
    assert.strictEqual(listenNote({ ...row, listening: false }, null), null);
});

// --- the VFOs panel, rendered -------------------------------------------------

// The four row blocks, A to D, and one row block's parts.
const items = (tree) => byClass(tree, 'vfos__item');
const speakers = (tree) => byClass(tree, 'vfos__spk');
const segLabels = (node) => byClass(node, 'vfos__seg-btn').map((b) => b.props.children);
const litSeg = (node) => byClass(node, 'vfos__seg-btn').find((b) => b.props['aria-pressed']);
const ev = () => ({ stopped: false, stopPropagation() { this.stopped = true; } });

// The panel exactly as it was before simultaneous VFOs, whichever view.
function assertPlain(tree) {
    for (const cls of ['vfos__spk', 'vfos__hint', 'vfos__item', 'vfos__line', 'vfos__seg', 'vfos__ctl', 'vfos__meter']) {
        assert.strictEqual(byClass(tree, cls).length, 0, `${cls} on a one-VFO receiver`);
    }
    const rows = byClass(tree, 'vfos__row');
    assert.strictEqual(rows.length, 4);
    assert.ok(rows.every((r) => r.type === 'button'));
    assert.ok(!/MAIN/.test(text(tree)));
    assert.ok(!byClass(tree, 'vfos')[0].props.className.includes('is-compact'));
    // B shows its own mode: it is not playing here.
    assert.strictEqual(byClass(rows[1], 'vfos__mode')[0].props.children, 'LSB');
}

for (const minimal of [false, true]) {
    const view = minimal ? 'compact' : 'expanded';

    t(`${view}, limit 1: exactly the old panel — no hint, no speakers, no outputs`, async () => {
        await setLimit(1);
        reset();
        state({ B: true });          // remembered from a receiver that allowed more
        const ctx = context();
        run(ctx);
        assertPlain(frame(VfosPanel, { minimal }, ctx));
    });

    t(`${view}, limit 2: the hint, a speaker per other VFO, and the rest disabled at the limit`, async () => {
        await setLimit(2);
        reset();
        state({ B: true });
        const ctx = context();
        run(ctx);
        const tree = frame(VfosPanel, { minimal }, ctx);
        const hint = text(byClass(tree, 'vfos__hint')[0]);
        assert.ok(/Click a VFO to switch · to listen at the same time/.test(hint), hint);
        assert.ok(/1 of 1 extra/.test(hint), hint);
        assert.ok(/MAIN/.test(text(tree)), 'the main row is not marked');

        const [b, c, d] = speakers(tree);
        assert.strictEqual(speakers(tree).length, 3, 'one speaker per VFO that is not the main one');
        assert.strictEqual(b.props['aria-pressed'], true);
        assert.strictEqual(b.props['aria-disabled'], false, 'a listening VFO must be able to stop');
        assert.strictEqual(b.props['aria-label'], 'Listen to VFO B at the same time');
        for (const s of [c, d]) {
            assert.strictEqual(s.props['aria-disabled'], true, 'past the limit');
            assert.ok(s.props.className.includes('is-disabled'));
            assert.strictEqual(s.props.title, '1 of 1 in use on this receiver');
        }
        // Disabled means it does nothing, not that it is hidden.
        c.props.onClick(ev());
        assert.strictEqual(getVfos().listen.C.on, false);

        // B wears its colour on its letter and its stripe; A, the main, the accent.
        const [ia, ib, ic] = items(tree);
        assert.strictEqual(ib.props.style['--vfo-colour'], colours.VFO_COLOURS.B);
        assert.ok(ib.props.className.includes('is-heard'));
        assert.strictEqual(byClass(ib, 'vfos__badge').length, 1);
        assert.strictEqual(ia.props.style['--vfo-colour'], 'var(--accent)');
        assert.strictEqual(ic.props.style, undefined, 'a parked VFO in colour');
        assert.strictEqual(byClass(ic, 'vfos__badge').length, 0);
        // B plays in USB like the main one, and shows it.
        assert.strictEqual(byClass(ib, 'vfos__mode')[0].props.children, 'USB');

        // Outputs on the main and the listening row, nowhere else.
        assert.strictEqual(byClass(tree, 'vfos__seg').length, 2);
        assert.strictEqual(byClass(ic, 'vfos__seg').length, 0);
        // Auto is lit, and says where it landed if the engine has placed it.
        const labels = segLabels(ib);
        assert.deepStrictEqual([labels[0], labels[2], labels[3]], ['L', 'Both', 'R']);
        assert.ok(new RegExp(`^${minimal ? 'Au' : 'Auto'}(·[LCR])?$`).test(labels[1]), labels[1]);
        assert.strictEqual(litSeg(ib).props.key, 'auto');
        // Compact: a meter on the listening row. Full: the squelch slider is
        // the meter, on both heard rows, with a squelch and a width each.
        assert.strictEqual(byClass(ib, 'vfos__meter').length, minimal ? 1 : 0);
        assert.strictEqual(byClass(ia, 'vfos__meter').length, 0);
        assert.strictEqual(byClass(tree, 'vfos__ctl').length, minimal ? 0 : 2);
        assert.strictEqual(byClass(tree, 'vfos__squelch').length, minimal ? 0 : 2);
        assert.strictEqual(byClass(tree, 'vfos__bw').length, minimal ? 0 : 2);
        assert.strictEqual(byClass(tree, 'vfos__note').length, minimal ? 0 : 1);
        if (!minimal) {
            assert.ok(/LSB saved · listening in USB/.test(text(ib)), text(ib));
            // Two rows: how it is heard, then what it lets through.
            const rows = byClass(byClass(ib, 'vfos__ctl')[0], 'vfos__ctl-row');
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(byClass(rows[0], 'vfos__vol').length, 1);
            assert.strictEqual(byClass(rows[1], 'vfos__knob').length, 2);
        }
    });

    t(`${view}, limit 4: every speaker free, and nothing heard means no MAIN and no outputs`, async () => {
        await setLimit(4);
        reset();
        state({});
        const ctx = context();
        run(ctx);
        const tree = frame(VfosPanel, { minimal }, ctx);
        assert.ok(/0 of 3 extra/.test(text(tree)), text(tree));
        assert.strictEqual(speakers(tree).length, 3);
        assert.ok(speakers(tree).every((s) => !s.props['aria-disabled'] && !s.props['aria-pressed']));
        assert.ok(!/MAIN/.test(text(tree)));
        assert.strictEqual(byClass(tree, 'vfos__seg').length, 0);
        assert.strictEqual(byClass(tree, 'vfos__ctl').length, 0);
        assert.ok(items(tree).every((i) => !i.props.className.includes('is-heard')));
        assert.strictEqual(byClass(tree, 'vfos')[0].props.className.includes('is-compact'), minimal);
    });

    t(`${view}, limit 4 with two heard: both lit, one still free`, async () => {
        await setLimit(4);
        reset();
        state({ B: true, C: true });
        const ctx = context();
        run(ctx);
        const tree = frame(VfosPanel, { minimal }, ctx);
        assert.ok(/2 of 3 extra/.test(text(tree)), text(tree));
        const [b, c, d] = speakers(tree);
        assert.ok(b.props['aria-pressed'] && c.props['aria-pressed'] && !d.props['aria-pressed']);
        assert.strictEqual(d.props['aria-disabled'], false);
        assert.strictEqual(byClass(tree, 'vfos__seg').length, 3, 'main, B and C');
        assert.strictEqual(items(tree)[2].props.style['--vfo-colour'], colours.VFO_COLOURS.C);
    });

    t(`${view}: main in IQ disables every speaker, says why, and pauses nothing on show`, async () => {
        await setLimit(4);
        reset();
        // A listening flag the engine has not cleared yet: the panel must not
        // show it as playing either way.
        state({ B: true });
        const ctx = context({ tuning: { frequency: 14_074_000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 } });
        run(ctx);
        const tree = frame(VfosPanel, { minimal }, ctx);
        const said = text(tree);
        assert.strictEqual(speakers(tree).length, 3, 'hidden rather than disabled');
        for (const s of speakers(tree)) {
            assert.strictEqual(s.props['aria-disabled'], true);
            assert.strictEqual(s.props.title, 'Not available while main is in IQ');
            assert.strictEqual(s.props['aria-pressed'], false);
        }
        assert.ok(!/Paused/.test(said), said);
        assert.strictEqual(byClass(tree, 'vfos__hint').length, 0);
        assert.strictEqual(byClass(tree, 'vfos__seg').length, 0);
        assert.ok(!/MAIN/.test(said));
        // B shows its own mode, not an IQ it is not heard in.
        assert.strictEqual(byClass(items(tree)[1], 'vfos__mode')[0].props.children, 'LSB');
        speakers(tree)[1].props.onClick(ev());
        assert.strictEqual(getVfos().listen.C.on, false, 'started in IQ');
    });
}

t('the speaker toggles listening and never selects the row', async () => {
    await setLimit(2);
    reset();
    state({});
    const ctx = context();
    const tuned = [];
    ctx.actions = { ...ctx.actions, tuneTo: (x) => tuned.push(x) };
    run(ctx);
    let tree = frame(VfosPanel, {}, ctx);
    const e = ev();
    speakers(tree)[1].props.onClick(e);        // C
    assert.ok(e.stopped, 'the click went on to the row');
    assert.strictEqual(getVfos().listen.C.on, true);
    assert.strictEqual(getVfos().active, 'A', 'the speaker switched VFO');
    assert.strictEqual(tuned.length, 0, 'the speaker tuned the receiver');
    // It is beside the row, not inside it: no row button contains a speaker.
    assert.ok(byClass(tree, 'vfos__row').every((r) => byClass(r, 'vfos__spk').length === 0));
    // A fresh mount: frame() unmounts, so the panel's mirror of the store has
    // stopped listening by now and would show the old state.
    reset();
    tree = frame(VfosPanel, {}, ctx);
    assert.strictEqual(speakers(tree)[0].props['aria-disabled'], true, 'B past the limit');
    speakers(tree)[1].props.onClick(ev());
    assert.strictEqual(getVfos().listen.C.on, false);
    assert.strictEqual(getVfos().active, 'A');
});

t('the output buttons set where a VFO is heard, and a lit Auto says which side', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const ctx = context();
    run(ctx);
    for (const minimal of [false, true]) {
        reset();
        const tree = frame(VfosPanel, { minimal }, ctx);
        const ib = items(tree)[1];
        const right = byClass(ib, 'vfos__seg-btn')[3];
        assert.strictEqual(right.props['aria-label'], 'VFO B: right ear only');
        const e = ev();
        right.props.onClick(e);
        assert.ok(e.stopped);
        assert.strictEqual(getVfos().listen.B.out, 'right');
        // The main receiver's side is stored with the VFOs too.
        byClass(items(tree)[0], 'vfos__seg-btn')[0].props.onClick(ev());
        assert.strictEqual(getVfos().listen.A.out, 'left');
        state({ B: true });
    }
    // Where Auto landed comes from the engine: the snapshot's pan for a
    // listening VFO, its mainPan for the main one.
    const realSnap = subs.snapshot;
    subs.snapshot = () => {
        const s = realSnap.call(subs);
        return { ...s, mainPan: -1, vfos: { ...s.vfos, B: { ...s.vfos.B, pan: 1 } } };
    };
    try {
        reset();
        let tree = frame(VfosPanel, {}, ctx);
        assert.strictEqual(litSeg(items(tree)[1]).props.children, 'Auto·R');
        assert.strictEqual(litSeg(items(tree)[0]).props.children, 'Auto·L');
        reset();
        tree = frame(VfosPanel, { minimal: true }, ctx);
        assert.strictEqual(litSeg(items(tree)[1]).props.children, 'Au·R');
        // A pin is lit as itself.
        setVfos({ ...getVfos(), listen: { ...getVfos().listen, B: L(true, { out: 'both' }) } });
        reset();
        tree = frame(VfosPanel, {}, ctx);
        assert.strictEqual(litSeg(items(tree)[1]).props.children, 'Both');
        assert.deepStrictEqual(segLabels(items(tree)[1]), ['L', 'Auto', 'Both', 'R']);
    } finally {
        subs.snapshot = realSnap;
    }
});

t('volume and mute go to the VFO\'s store entry, and the main one\'s to the Audio panel\'s', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const calls = [];
    const ctx = context({ audio: { volume: 0.7, muted: false } });
    ctx.actions = {
        ...ctx.actions,
        setVolume: (v) => calls.push(['vol', v]),
        setMuted: (m) => calls.push(['mute', m]),
    };
    run(ctx);
    const tree = frame(VfosPanel, {}, ctx);
    const [ia, ib] = items(tree);
    byClass(ib, 'slider')[0].props.onChange({ target: { value: '40' } });
    assert.strictEqual(getVfos().listen.B.vol, 0.4);
    const mute = byClass(ib, 'vfos__mute')[0];
    assert.strictEqual(mute.props['aria-pressed'], false);
    assert.strictEqual(mute.props['aria-label'], 'Mute VFO B');
    mute.props.onClick();
    assert.strictEqual(getVfos().listen.B.muted, true);
    assert.strictEqual(byClass(ia, 'slider')[0].props.value, 70);
    byClass(ia, 'slider')[0].props.onChange({ target: { value: '25' } });
    byClass(ia, 'vfos__mute')[0].props.onClick();
    assert.deepStrictEqual(calls, [['vol', 0.25], ['mute', true]]);
    assert.strictEqual(getVfos().listen.A.vol, 1, 'the main volume went into the VFO store');
    reset();
    const again = frame(VfosPanel, {}, ctx);
    const ib2 = items(again)[1];
    assert.strictEqual(byClass(ib2, 'vfos__mute')[0].props['aria-pressed'], true);
    assert.strictEqual(byClass(ib2, 'slider')[0].props.disabled, true, 'a muted VFO\'s slider');
});

t('a heard VFO\'s width is its own: main\'s moving leaves it, and its number matches main\'s', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const calls = [];
    const ctx = context();
    ctx.actions = { ...ctx.actions, setBandwidth: (lo, hi) => calls.push([lo, hi]) };
    run(ctx);
    // Started with a copy of main's.
    assert.deepStrictEqual(getVfos().listen.B.bw, { ssb: [50, 2700] });
    let tree = frame(VfosPanel, {}, ctx);
    let [ia, ib] = items(tree);
    const bw = (item) => byClass(item, 'vfos__bw')[0];
    const val = (item) => byClass(bw(item), 'vfos__knob-val')[0];
    // The same as main's: said quietly, with main's marked on the track.
    assert.ok(bw(ib), 'the listening row has one');
    assert.strictEqual(val(ib).props.className, 'vfos__knob-val is-same');
    assert.strictEqual(text(val(ib)), '2.65k');
    assert.strictEqual(byClass(val(ib), 'vfos__knob-num').length, 1, 'the number in its own span, for hiding');
    assert.strictEqual(byClass(bw(ib), 'slider-marker').length, 1);
    assert.ok(/the same as A's/.test(bw(ib).props.title), bw(ib).props.title);
    // The main row's is main's own filter, through the receiver's action.
    assert.strictEqual(byClass(bw(ia), 'slider-marker').length, 0);
    byClass(bw(ia), 'slider')[0].props.onChange({ target: { value: '2000' } });
    assert.deepStrictEqual(calls, [[50, 2050]]);

    // Main's filter moves: B's does not.
    const moved = context({ tuning: { ...ctx.tuning, bandwidthHigh: 2050 } });
    run(moved);
    reset();
    [ia, ib] = items(frame(VfosPanel, {}, moved));
    assert.strictEqual(text(val(ib)), '2.65k');
    assert.ok(val(ib).props.className.includes('is-own'), 'now it differs from main\'s');
    run(ctx);

    // B's slider: in the store only.
    reset();
    [ia, ib] = items(frame(VfosPanel, {}, ctx));
    byClass(bw(ib), 'slider')[0].props.onChange({ target: { value: '1800' } });
    assert.deepStrictEqual(getVfos().listen.B.bw, { ssb: [50, 1850] });
    assert.strictEqual(calls.length, 1, 'main\'s filter left alone');
    reset();
    tree = frame(VfosPanel, {}, ctx);
    [ia, ib] = items(tree);
    assert.strictEqual(byClass(ib, 'vfos__width')[0].props.children, '1.80k', 'the row shows the width it plays');
    assert.strictEqual(val(ib).type, 'button');
    assert.ok(val(ib).props.className.includes('is-own'));
    assert.strictEqual(val(ib).props['aria-label'], 'VFO B: match A\'s filter');
    const e = ev();
    val(ib).props.onClick(e);
    assert.ok(e.stopped);
    assert.deepStrictEqual(getVfos().listen.B.bw, { ssb: [50, 2700] }, 'a copy of main\'s');
});

t('the compact view has no squelch or width sliders', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const ctx = context();
    run(ctx);
    assert.strictEqual(byClass(frame(VfosPanel, { minimal: true }, ctx), 'vfos__knob').length, 0);
});

t('a squelch value reads as whole dB, a half, or off', () => {
    assert.strictEqual(sqLabel(null), 'off');
    assert.strictEqual(sqLabel(6), '6 dB');
    assert.strictEqual(sqLabel(6.5), '6.5 dB');
    // Beside the slider, without the unit.
    assert.strictEqual(sqLabel(12.5, false), '12.5');
    assert.strictEqual(sqLabel(null, false), 'off');
});

t('a heard VFO\'s squelch is its own: main\'s moving leaves it, and its value matches main\'s', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const calls = [];
    const ctx = context();
    ctx.actions = {
        ...ctx.actions,
        setSquelch: (x) => calls.push(['set', x]),
        autoSquelch: () => calls.push(['auto']),
    };
    run(ctx);
    let tree = frame(VfosPanel, {}, ctx);
    let [ia, ib] = items(tree);
    const sq = (item) => byClass(item, 'vfos__squelch')[0];
    const val = (item) => byClass(sq(item), 'vfos__knob-val')[0];
    // A copy of main's 6 dB: dim, and the slider sitting on it.
    assert.strictEqual(getVfos().listen.B.sq, 6);
    assert.strictEqual(val(ib).props.className, 'vfos__knob-val is-same');
    assert.strictEqual(text(val(ib)), '6');
    assert.strictEqual(byClass(sq(ib), 'slider')[0].props.value, 6);
    assert.ok(/squelch: 6 dB, the same as A's/.test(sq(ib).props.title), sq(ib).props.title);
    // The main row's slider and Auto are main's own controls.
    byClass(sq(ia), 'slider')[0].props.onChange({ target: { value: '9' } });
    byClass(sq(ia), 'vfos__auto')[0].props.onClick(ev());
    assert.deepStrictEqual(calls, [['set', 9], ['auto']]);
    assert.strictEqual(text(val(ia)), '6');
    assert.strictEqual(val(ia).props.className, 'vfos__knob-val', 'main\'s value is not dimmed');

    // B's own: in the store only, and the engine's lane gated by it.
    byClass(sq(ib), 'slider')[0].props.onChange({ target: { value: '12' } });
    assert.strictEqual(getVfos().listen.B.sq, 12);
    assert.strictEqual(calls.length, 2, 'main\'s squelch left alone');
    // Main's moving leaves it where it is.
    run(context({ squelch: { value: 20, enabled: true, threshold: 20 } }));
    assert.strictEqual(subs.snapshot().vfos.B.threshold, 12);
    run(ctx);
    assert.strictEqual(subs.snapshot().vfos.B.threshold, 12);
    assert.strictEqual(subs.snapshot().vfos.B.squelchOwn, true);
    reset();
    tree = frame(VfosPanel, {}, ctx);
    [ia, ib] = items(tree);
    assert.strictEqual(val(ib).type, 'button');
    assert.ok(val(ib).props.className.includes('is-own'));
    assert.strictEqual(val(ib).props['aria-label'], 'VFO B: match A\'s squelch');
    // The floor is off — its own off, with main's still on.
    byClass(sq(ib), 'slider')[0].props.onChange({ target: { value: '-10' } });
    assert.strictEqual(getVfos().listen.B.sq, 'off');
    assert.strictEqual(subs.snapshot().vfos.B.threshold, null);
    reset();
    tree = frame(VfosPanel, {}, ctx);
    ib = items(tree)[1];
    assert.strictEqual(text(val(ib)), 'off');
    const e = ev();
    val(ib).props.onClick(e);
    assert.ok(e.stopped);
    assert.strictEqual(getVfos().listen.B.sq, 6, 'a copy of main\'s');
    assert.strictEqual(subs.snapshot().vfos.B.threshold, 6);
});

t('a VFO\'s Auto waits for a reading, then sets its own squelch above its noise', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const ctx = context();
    run(ctx);
    let ib = items(frame(VfosPanel, {}, ctx))[1];
    const auto = (item) => byClass(item, 'vfos__auto')[0];
    assert.strictEqual(auto(ib).props.disabled, true, 'nothing heard yet');
    assert.strictEqual(subs.autoSquelch('B'), false);
    const lane = Array.from(subs.lanes.values()).find((l) => l.slotId === 'B');
    for (const n of [2, 3, 4]) subs._onQuality(lane, { basebandPower: n, noisePower: 0 });
    reset();
    ib = items(frame(VfosPanel, {}, ctx))[1];
    assert.strictEqual(auto(ib).props.disabled, false);
    auto(ib).props.onClick(ev());
    // Averaging 3 dB, plus the 3 dB of headroom main's Auto uses.
    assert.strictEqual(getVfos().listen.B.sq, 6);
    for (const n of [9, 9, 9, 9, 9]) subs._onQuality(lane, { basebandPower: n, noisePower: 0 });
    assert.ok(subs.autoSquelch('B'));
    assert.strictEqual(getVfos().listen.B.sq, 12);
});

t('every listening control has a tooltip and a name', async () => {
    await setLimit(4);
    reset();
    state({ B: true });
    const ctx = context();
    run(ctx);
    for (const minimal of [false, true]) {
        reset();
        const tree = frame(VfosPanel, { minimal }, ctx);
        for (const cls of ['vfos__spk', 'vfos__seg-btn', 'vfos__mute']) {
            for (const b of byClass(tree, cls)) {
                assert.ok(b.props.title, `${cls} without a tooltip`);
                assert.ok(b.props['aria-label'], `${cls} without a name`);
            }
        }
    }
});

t('a VFO past the server limit shows the refusal', async () => {
    await setLimit(2);
    reset();
    // Two listening on a receiver that allows one beside the main: the store
    // is left alone and the extra one is marked, not dropped.
    state({ B: true, C: true });
    const ctx = context();
    run(ctx);
    const tree = frame(VfosPanel, {}, ctx);
    const notes = byClass(tree, 'vfos__note');
    const refused = notes.find((n) => n.props.className.includes('is-refused'));
    assert.ok(refused, 'no refusal shown');
    assert.ok(/allows 2 VFO/.test(text(refused)), text(refused));
    assert.ok(items(tree)[2].props.className.includes('is-refused'));
    // Compact has no note line; the reason is on the meter instead.
    reset();
    const small = frame(VfosPanel, { minimal: true }, ctx);
    assert.ok(/allows 2 VFO/.test(byClass(items(small)[2], 'vfos__meter')[0].props.title));
});

t('clicking a listening row swaps it with the main receiver', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const tuned = [];
    const ctx = context();
    ctx.actions = { ...ctx.actions, tuneTo: (x) => tuned.push(x) };
    run(ctx);
    const tree = frame(VfosPanel, {}, ctx);
    byClass(tree, 'vfos__row')[1].props.onClick();
    assert.strictEqual(getVfos().active, 'B');
    assert.strictEqual(getVfos().listen.A.on, true, 'the old main is not listening');
    assert.strictEqual(tuned.at(-1).frequency, 7_100_000);
});

// --- the Receiver panel's VFO bar -----------------------------------------------

const vfoButtons = (tree) => byClass(tree, 'vfo-btn');

t('the VFO bar marks listening VFOs with a dot in their colour', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const tree = frame(ReceiverPanel, {}, context());
    const btns = vfoButtons(tree);
    assert.strictEqual(btns.length, 4);
    const dots = byClass(tree, 'vfo-btn__dot');
    assert.strictEqual(dots.length, 1);
    assert.strictEqual(dots[0].props.style.background, colours.VFO_COLOURS.B);
    assert.ok(btns[1].props.className.includes('is-listening'));
});

t('right-click or hold on a VFO button toggles listening, once per gesture', async () => {
    await setLimit(2);
    reset();
    state({});
    let tree = frame(ReceiverPanel, {}, context());
    const c = vfoButtons(tree)[2];
    assert.ok(c.props.onContextMenu, 'no secondary press');
    c.props.onContextMenu({ preventDefault() {}, currentTarget: {} });
    assert.strictEqual(getVfos().listen.C.on, true);
    // Android sends the hold's timer and a contextmenu for one press; the
    // second must not undo the first.
    c.props.onContextMenu({ preventDefault() {}, currentTarget: {} });
    assert.strictEqual(getVfos().listen.C.on, true, 'one gesture toggled twice');
    clock += 1000;
    tree = frame(ReceiverPanel, {}, context());
    vfoButtons(tree)[2].props.onContextMenu({ preventDefault() {}, currentTarget: {} });
    assert.strictEqual(getVfos().listen.C.on, false);
    // The active one has no second job.
    assert.strictEqual(vfoButtons(tree)[0].props.onContextMenu, undefined);
});

t('at a limit of one the VFO bar keeps the browser\'s right-click and has no dots', async () => {
    await setLimit(1);
    reset();
    state({ B: true });
    const tree = frame(ReceiverPanel, {}, context());
    assert.strictEqual(byClass(tree, 'vfo-btn__dot').length, 0);
    assert.ok(vfoButtons(tree).every((b) => b.props.onContextMenu === undefined));
    assert.strictEqual(canToggleListen(getVfos(), 'B', 1), false);
    assert.strictEqual(canToggleListen(getVfos(), 'B', 2), true);
    assert.strictEqual(canToggleListen(getVfos(), 'A', 2), false);
});

// --- the Status panel ---------------------------------------------------------

t('the Status panel lists a link per listening VFO', async () => {
    await setLimit(2);
    reset();
    state({ B: true });
    const ctx = context({
        audioState: 'open',
        spectrumState: 'open',
        audioConn: { bytesIn: 0 },
        spectrumConn: { bytesIn: 0 },
        session: { maxSec: 0, startedAt: 0 },
    });
    run(ctx);
    const tree = frame(StatusPanel, { minimal: true }, ctx);
    const said = text(tree);
    assert.ok(/VFO B link/.test(said), said);
    assert.ok(/Audio link/.test(said), said);
    await setLimit(1);
    reset();
    assert.ok(!/VFO B link/.test(text(frame(StatusPanel, { minimal: true }, ctx))));
});

// --- the control-surface functions ----------------------------------------------

function fakeCtx() {
    const calls = [];
    return {
        calls,
        actions: { tuneTo: (x) => calls.push(['tuneTo', x]) },
        stepHz: 100,
        state: () => ({
            tuning: TUNING,
            view: { binBandwidth: 100, binCount: 2048 },
            dsp: { schemas: [] },
        }),
    };
}

t('the listening functions are in the catalogue', () => {
    const ids = catalogue([], null).map((f) => f.id);
    for (const id of ['listen_a', 'listen_b', 'listen_c', 'listen_d', 'listen_swap_next', 'listen_mute_all']) {
        assert.ok(ids.includes(id), `${id} is missing`);
    }
    assert.strictEqual(new Set(ids).size, ids.length, 'an id is registered twice');
});

t('listen_c toggles C, within the server limit', async () => {
    await setLimit(2);
    state({});
    const ctx = fakeCtx();
    assert.ok(runFunction('listen_c', { kind: 'trigger' }, ctx));
    assert.strictEqual(getVfos().listen.C.on, true);
    runFunction('listen_b', { kind: 'trigger' }, ctx);
    assert.strictEqual(getVfos().listen.B.on, false, 'past the limit');
    runFunction('listen_c', { kind: 'trigger' }, ctx);
    assert.strictEqual(getVfos().listen.C.on, false);
    await setLimit(1);
    runFunction('listen_c', { kind: 'trigger' }, ctx);
    assert.strictEqual(getVfos().listen.C.on, false, 'listening on a one-VFO receiver');
});

t('swap-to-next walks the listening VFOs round from the main one', async () => {
    await setLimit(4);
    state({ B: true, C: true });
    assert.strictEqual(nextListeningVfo(getVfos()), 'B');
    const ctx = fakeCtx();
    runFunction('listen_swap_next', { kind: 'trigger' }, ctx);
    assert.strictEqual(getVfos().active, 'B');
    // A is now listening in B's place; from B the next is C, then round to A.
    assert.strictEqual(nextListeningVfo(getVfos()), 'C');
    state({});
    assert.strictEqual(nextListeningVfo(getVfos()), null);
});

t('mute-all silences every listening VFO, and the same press brings them back', async () => {
    await setLimit(4);
    state({ B: true, C: true });
    assert.strictEqual(muteAllListening(), true);
    assert.ok(getVfos().listen.B.muted && getVfos().listen.C.muted);
    assert.strictEqual(muteAllListening(), false);
    assert.ok(!getVfos().listen.B.muted && !getVfos().listen.C.muted);
    state({});
    assert.strictEqual(muteAllListening(), false, 'nothing to mute');
});

(async () => {
    for (const [name, fn] of queue) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message));
            process.exitCode = 1;
        }
    }
    subs.dispose();
    console.log(`\n== vfolistenui: ${pass} passed`);
})();
