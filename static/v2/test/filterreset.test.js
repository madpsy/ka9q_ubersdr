// The reset beside a filter slider: what it does, and when it refuses to.
//
// It is the one control in the interface whose whole job is to put a value back,
// so the value it puts back is the only thing it has to get right — and it has
// to get it right for eight modes and two sliders. See hookStub.js for what
// "renders" means here.

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
    FilterReset, ReceiverPanel, DEFAULTS, MODES, MODE_BY_ID,
} = require('./.build/filterreset.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers useRadio, useDisplay and useLayout alike — the stub's
// useContext cannot tell contexts apart, and none of them minds.
function context(tuning, over) {
    const sent = [];
    const ctx = {
        tuning: { mode: 'usb', frequency: 14_200_000, ...tuning },
        running: true,
        sent,
        squelch: { enabled: false, value: -10 },
        agc: null,
        actions: {
            setBandwidth: (low, high) => sent.push([low, high]),
            setFrequency() {}, setMode() {}, stepBy() {}, autoSquelch() {}, setSquelch() {},
        },
        ...DEFAULTS,
        set() {},
        serverInfo: {},
        list: [],
        ...over,
    };
    return ctx;
}

// A mode sitting at its own default passband.
const at = (mode, over) => ({
    mode, bandwidthLow: MODE_BY_ID[mode].low, bandwidthHigh: MODE_BY_ID[mode].high, ...over,
});

// The one button the component draws.
function button(tuning, props) {
    reset();
    const ctx = context(tuning);
    const { tree } = render(FilterReset, props || {}, ctx);
    return { node: tree, ctx };
}

// --- when it is dead ---------------------------------------------------------

t('at the mode default there is nothing to reset', () => {
    for (const m of MODES) {
        for (const what of ['filter', 'width', 'shift']) {
            const { node } = button(at(m.id), { what });
            assert.strictEqual(node.props.disabled, true, `${m.id} ${what}`);
        }
    }
});

t('IQ is disabled even when it is off its default', () => {
    // It cannot be off it — setBandwidth refuses — but the button must not
    // depend on that being true to stay disabled.
    const { node } = button({ mode: 'iq', bandwidthLow: -2000, bandwidthHigh: 2000 });
    assert.strictEqual(node.props.disabled, true);
    assert.ok(/IQ/.test(node.props.title), 'and says why');
});

t('a moved filter enables it, and the title names the figure', () => {
    const { node } = button(at('usb', { bandwidthHigh: 1500 }), { what: 'width' });
    assert.strictEqual(node.props.disabled, false);
    assert.ok(/USB/.test(node.props.title), node.props.title);
    assert.ok(/2\.65 kHz/.test(node.props.title), node.props.title);
});

t('the shift button names its own default, not the width', () => {
    const { node } = button(at('usb', { bandwidthLow: 400, bandwidthHigh: 3050 }), { what: 'shift' });
    assert.strictEqual(node.props.disabled, false);
    assert.ok(/50 Hz/.test(node.props.title), node.props.title);
    assert.strictEqual(node.props['aria-label'], 'Reset filter shift');
});

// --- what it sends -----------------------------------------------------------

t('clicking the width reset sends the mode default width', () => {
    for (const m of MODES.filter((x) => x.id !== 'iq')) {
        const want = Math.abs(m.high - m.low);
        // Narrowed to 800 Hz, whichever side of the carrier this mode uses.
        const narrow = m.low < 0 && m.high > 0
            ? { bandwidthLow: -400, bandwidthHigh: 400 }
            : m.high <= 0 ? { bandwidthLow: -850, bandwidthHigh: -50 }
                : { bandwidthLow: 50, bandwidthHigh: 850 };
        const { node, ctx } = button(at(m.id, narrow), { what: 'width' });
        node.props.onClick();
        assert.strictEqual(ctx.sent.length, 1, m.id);
        const [low, high] = ctx.sent[0];
        assert.strictEqual(Math.round(Math.abs(high - low)), want, m.id);
    }
});

t('clicking the shift reset sends the mode default shift', () => {
    // USB shifted up to 400 Hz and back: the width it was carrying survives.
    const { node, ctx } = button(at('usb', { bandwidthLow: 400, bandwidthHigh: 3050 }), { what: 'shift' });
    node.props.onClick();
    assert.deepStrictEqual(ctx.sent, [[50, 2700]]);
});

t('a disabled button sends nothing when clicked anyway', () => {
    // Belt and braces: the DOM would not fire it, but the handler is the only
    // thing standing between a control surface replaying this and IQ moving.
    const { node, ctx } = button({ mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 });
    assert.strictEqual(node.props.disabled, true);
    assert.strictEqual(ctx.sent.length, 0);
});

// --- the whole passband, where there is no shift slider ----------------------

t('the default kind restores both edges', () => {
    // What the Multipad and the top bar draw. Neither has a shift control, so
    // the low edge is only reachable from here.
    const { node, ctx } = button(at('usb', { bandwidthLow: 400, bandwidthHigh: 1500 }));
    assert.strictEqual(node.props['aria-label'], 'Reset filter');
    node.props.onClick();
    assert.deepStrictEqual(ctx.sent, [[50, 2700]]);
});

t('a default *width* sitting off centre still enables it', () => {
    // The case that made this the default: 400..3050 is the USB default width to
    // the Hz, so a width-only reset reads as spent and there is no shift slider
    // in either of these two views to finish the job with.
    const shifted = at('usb', { bandwidthLow: 400, bandwidthHigh: 3050 });
    assert.strictEqual(button(shifted, { what: 'width' }).node.props.disabled, true,
        'the width really is at its default');
    const { node, ctx } = button(shifted);
    assert.strictEqual(node.props.disabled, false, 'but the filter is not');
    node.props.onClick();
    assert.deepStrictEqual(ctx.sent, [[50, 2700]]);
});

t('its title names both edges, not a width', () => {
    // A width reading would not have mentioned the number it is really fixing.
    const { node } = button(at('lsb', { bandwidthLow: -1000 }));
    assert.ok(/-2700 to -50 Hz/.test(node.props.title), node.props.title);
});

t('it restores the default passband for every mode', () => {
    for (const m of MODES.filter((x) => x.id !== 'iq')) {
        const { node, ctx } = button(at(m.id, { bandwidthLow: m.low / 2, bandwidthHigh: m.high / 2 }));
        assert.strictEqual(node.props.disabled, false, m.id);
        node.props.onClick();
        assert.deepStrictEqual(ctx.sent, [[m.low, m.high]], m.id);
    }
});

// --- in the panel ------------------------------------------------------------

t('the Receiver panel draws a reset for each of its two sliders', () => {
    reset();
    const { tree } = render(ReceiverPanel, {}, context(at('usb', { bandwidthHigh: 1500 })));
    const labels = deep(tree)
        .map((n) => n.props && n.props['aria-label'])
        .filter((l) => l && /^Reset filter/.test(l));
    assert.deepStrictEqual(labels.sort(), ['Reset filter shift', 'Reset filter width']);
    // Each beside its own field rather than inside it — a Field is a <label>.
    assert.strictEqual(walk(tree).filter((n) => n.props?.className === 'filter-row').length, 2);
});

t('the Receiver panel’s width reset leaves the shift alone', () => {
    // The decision this file exists to protect: the panel with a slider for each
    // number asks for them separately, so neither button moves the other's
    // control. 400..1500 is shifted *and* narrow; the width reset must fix only
    // the width and leave the low edge where the operator put it.
    reset();
    const ctx = context(at('usb', { bandwidthLow: 400, bandwidthHigh: 1500 }));
    const { tree } = render(ReceiverPanel, {}, ctx);
    const w = deep(tree).find((n) => n.props?.['aria-label'] === 'Reset filter width');
    w.props.onClick();
    assert.deepStrictEqual(ctx.sent, [[400, 3050]], 'the low edge survived');
});

t('the minimal Receiver panel has neither, because it has no sliders', () => {
    reset();
    const { tree } = render(ReceiverPanel, { minimal: true }, context(at('usb')));
    assert.ok(!deep(tree).some((n) => /^Reset filter/.test(n.props?.['aria-label'] || '')));
});

console.log(`\n${pass} passed`);
