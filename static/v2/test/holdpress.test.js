// "Right-click, or hold on a touchscreen" as one gesture.
//
// Three details the hook exists to keep in one place — a mouse never holds, a
// contextmenu counts as the gesture, and the click a touch leaves behind is not
// a press of its own. Each is a one-line mistake to make again in the next
// caller, and each is invisible until somebody with the wrong input device tries
// it. See hookStub.js for what "renders" means here.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
let now = 1000;
globalThis.performance = { now: () => now };

const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; };
globalThis.clearTimeout = (id) => { if (timers[id]) timers[id].live = false; };
/** Fire whatever is still pending, as the browser would after the delay. */
const elapse = (ms) => {
    now += ms;
    for (const t of timers) {
        if (t.live && t.ms <= ms) { t.live = false; t.fn(); }
    }
};

// The module graph behind the pad reaches the display settings and the radio,
// and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    deep, render, reset, walk, useHoldPress, HOLD_MS,
    MultipadPanel, DEFAULTS, SQUELCH_MIN,
} = require('./.build/holdpress.cjs');

let pass = 0;
const t = (name, fn) => {
    try { timers.length = 0; fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// The hook under a component, since that is the only way to run one.
function mount() {
    reset();
    const fired = [];
    const Probe = () => {
        const [press, afterHold] = useHoldPress(() => fired.push(now));
        return { type: 'span', props: { ...press, afterHold } };
    };
    const { tree } = render(Probe, {}, null);
    return { press: tree.props, fired, afterHold: tree.props.afterHold };
}

const menu = () => {
    let prevented = false;
    return { event: { preventDefault: () => { prevented = true; } }, was: () => prevented };
};

// --- the hold ---------------------------------------------------------------

t('a touch held past the threshold fires once', () => {
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'touch' });
    elapse(HOLD_MS);
    assert.strictEqual(fired.length, 1);
});

t('a touch lifted before the threshold fires nothing', () => {
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'touch' });
    press.onPointerUp();
    elapse(HOLD_MS);
    assert.strictEqual(fired.length, 0);
});

t('a finger that slides off the button fires nothing', () => {
    // The gesture is on this element; leaving it is abandoning it, not
    // completing it somewhere else.
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'touch' });
    press.onPointerLeave();
    elapse(HOLD_MS);
    assert.strictEqual(fired.length, 0);
});

t('a cancelled pointer fires nothing', () => {
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'touch' });
    press.onPointerCancel();
    elapse(HOLD_MS);
    assert.strictEqual(fired.length, 0);
});

t('a mouse held still on the button fires nothing', () => {
    // It has the right button for this, and a mouse resting on a control is
    // somebody reading the tooltip.
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'mouse' });
    elapse(HOLD_MS * 4);
    assert.strictEqual(fired.length, 0);
});

// --- the right button --------------------------------------------------------

t('a context menu fires it, and the menu does not open', () => {
    const { press, fired } = mount();
    const m = menu();
    press.onContextMenu(m.event);
    assert.strictEqual(fired.length, 1);
    assert.ok(m.was(), 'preventDefault');
});

t('Android sending both a hold and a context menu fires twice, not never', () => {
    // Documented rather than prevented: the action is idempotent in every
    // caller, and swallowing the second would mean guessing which platform sent
    // which. The assertion is that neither path is *lost*.
    const { press, fired } = mount();
    press.onPointerDown({ pointerType: 'touch' });
    elapse(HOLD_MS);
    press.onContextMenu(menu().event);
    assert.strictEqual(fired.length, 2);
});

// --- the click a hold leaves behind ------------------------------------------

t('the compatibility click after a hold is recognised', () => {
    const { press, afterHold } = mount();
    assert.strictEqual(afterHold(), false, 'nothing has been held yet');
    press.onPointerDown({ pointerType: 'touch' });
    elapse(HOLD_MS);
    assert.strictEqual(afterHold(), true, 'the click arriving now is the tail of the hold');
});

t('a real press a moment later is not swallowed', () => {
    // The reason this is a timestamp and not a flag: a right-click fires no
    // click at all, so a flag set by one would still be set when the next
    // genuine press arrived.
    const { press, afterHold } = mount();
    press.onContextMenu(menu().event);
    assert.strictEqual(afterHold(), true);
    now += 1000;
    assert.strictEqual(afterHold(), false);
});

// --- wired to the squelch ----------------------------------------------------
//
// The hook being right is half of it. These drive the real pad, because the
// mistake worth catching is the gesture landing on the disabled button instead
// of the wrapper around it — which passes every test above and does nothing at
// all on the one screen it was asked for.

function pad(squelch, snr) {
    reset();
    const sent = [];
    const ctx = {
        tuning: { mode: 'usb', frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        squelch,
        sent,
        // useMeters reads through a ref and samples it on a timer, so the
        // snapshot the row sees is whatever `current` holds at first render.
        meters: { current: { snr, snrHistory: snr == null ? [] : [snr, snr, snr] } },
        dsp: { enabled: false, filter: null },
        // The noise controls on the pad's zoom row, off. Present because deep()
        // expands them on the way down; none of them is what these tests are
        // about.
        noise: { nr: { enabled: false, type: 'lsa' }, nb: { enabled: false } },
        spectrumConn: { on: () => () => {}, binCount: 1024, minBinBandwidthForUI: () => 10 },
        view: { centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024 },
        actions: {
            setSquelch: (v) => sent.push(v),
            autoSquelch: () => sent.push('auto'),
            setBandwidth() {}, setFrequency() {}, setMode() {}, setDsp() {}, setNb() {},
            setSpectrumView() {}, stepBy() {},
        },
        // The marker catalogue the frequency wheel's ends step to. Empty, but
        // present: deep() expands every child on the way to the squelch row, and
        // the wheel is one of them.
        catalog: { bookmarks: [], local: [], dx: [], cw: [], voice: [], confirmed: [] },
        ...DEFAULTS,
        set() {},
        serverInfo: {},
        list: [],
    };
    const { tree } = render(MultipadPanel, { minimal: true }, ctx);
    // Both nodes taken now, not by the caller later: deep() calls the components
    // it meets rather than reading a rendered tree, so it answers against
    // whichever context render() left in place. Expanding one pad's tree after
    // building a second reads the second one's squelch.
    const nodes = deep(tree);
    return {
        sent,
        hold: nodes.find((n) => n.props?.className === 'pad-row__hold'),
        auto: nodes.find((n) => n.props?.className === 'chip chip--button pad-row__act'),
    };
}

const ON = { enabled: true, value: 6 };
const OFF = { enabled: false, value: SQUELCH_MIN };

t('right-clicking Auto on the pad turns the squelch off', () => {
    const { hold, sent } = pad(ON, 12);
    assert.ok(hold, 'the gesture wrapper is drawn');
    hold.props.onContextMenu(menu().event);
    assert.deepStrictEqual(sent, [SQUELCH_MIN]);
});

t('holding it does the same', () => {
    const { hold, sent } = pad(ON, 12);
    hold.props.onPointerDown({ pointerType: 'touch' });
    elapse(HOLD_MS);
    assert.deepStrictEqual(sent, [SQUELCH_MIN]);
});

t('it still works with no SNR, when Auto itself cannot', () => {
    // The whole reason the gesture is on the wrapper. A squelch left closed over
    // a band that has gone quiet is exactly when somebody wants it off, and that
    // is the same moment Auto greys out.
    const { hold, sent, auto } = pad(ON, null);
    assert.strictEqual(auto.props.disabled, true, 'Auto is disabled');
    hold.props.onContextMenu(menu().event);
    assert.deepStrictEqual(sent, [SQUELCH_MIN], 'and the squelch still went off');
});

t('an already-off squelch is left alone', () => {
    const { hold, sent } = pad(OFF, 12);
    hold.props.onContextMenu(menu().event);
    assert.deepStrictEqual(sent, [], 'nothing sent, so nothing to undo');
});

t('a plain tap on Auto is still Auto', () => {
    const { auto, sent } = pad(ON, 12);
    auto.props.onClick();
    assert.deepStrictEqual(sent, ['auto']);
});

t('the tap a hold leaves behind is not also Auto', () => {
    // Without this the gesture would turn the squelch off and then immediately
    // set a threshold from the noise, which reads as the hold having done
    // nothing.
    const { hold, auto, sent } = pad(ON, 12);
    hold.props.onPointerDown({ pointerType: 'touch' });
    elapse(HOLD_MS);
    auto.props.onClick();
    assert.deepStrictEqual(sent, [SQUELCH_MIN], 'no "auto" behind it');
});

t('the tooltip says how, but only while there is something to turn off', () => {
    const on = pad(ON, 12).auto.props.title;
    const off = pad(OFF, 12).auto.props.title;
    assert.ok(/right-click or hold/.test(on), on);
    assert.ok(!/right-click or hold/.test(off), off);
});

console.log(`\n${pass} passed`);
