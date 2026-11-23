// The SDR Control panel renders with the ELAD TM-2 chosen: without WebHID,
// and with it — the connection line, the display settings and the default
// mapping table — and a display setting changed from the panel is saved.
//
// Rendered all the way down, as gamepadpanel.test.js does and for its reason:
// a name used in the wrong child component builds cleanly and blanks the panel.

const assert = require('assert');

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
globalThis.isSecureContext = true;

const {
    deep, render, reset, walk, words, SDRControlPanel, controlState, updateControlState,
} = require('./.build/tm2panel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const context = {
    tuning: { frequency: 7_074_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    audio: { volume: 0.5, muted: false },
    squelch: { value: -999 },
    dsp: { schemas: [] },
    serverInfo: {},
    actions: {},
};

function mountSurface() {
    reset();
    const outer = render(SDRControlPanel, {}, context);
    const el = walk(outer.tree).find((n) => typeof n.type === 'function' && n.type.name === 'SurfaceControl');
    assert.ok(el, 'SurfaceControl is in the tree');
    reset();
    const inner = render(el.type, el.props, context);
    return { outer, inner, text: words(inner.tree), nodes: deep(inner.tree) };
}

function unmount(m) {
    for (const off of m.inner.cleanups) off();
    for (const off of m.outer.cleanups) off();
}

updateControlState({ surface: 'tm2' });

t('the picker offers the TM-2', () => {
    reset();
    const { tree, cleanups } = render(SDRControlPanel, {}, context);
    const seg = walk(tree).find((n) => n.props && Array.isArray(n.props.options) && n.props.options.some((o) => o.value === 'midi'));
    assert.ok(seg.props.options.some((o) => o.value === 'tm2' && o.label === 'TM-2'));
    cleanups.forEach((off) => off());
});

t('without WebHID: says which browsers have it', () => {
    const m = mountSurface();
    assert.match(m.text, /no WebHID API/);
    unmount(m);
});

t('with WebHID: Connect, the display settings, and the ELAD layout already mapped', () => {
    globalThis.navigator = { userAgent: 'node', hid: { addEventListener() {}, removeEventListener() {}, getDevices: async () => [] } };
    const m = mountSurface();
    assert.match(m.text, /Not connected/);
    assert.ok(m.nodes.some((n) => n.type === 'button' && words(n).includes('Connect')));
    assert.match(m.text, /Push E1 to switch it between\s+VOL, SQL, NR\s*, and E2 between\s+HIGH, LOW, SHIFT/);
    assert.match(m.text, /Beside the S-meter/);
    assert.match(m.text, /Main knob acceleration/);
    // The table pages; the first page is enough to show it arrived mapped.
    assert.match(m.text, /Volume up E1 \(VOL\) — clockwise/);
    assert.match(m.text, /Passband shift E2 \(SHIFT\) — anticlockwise/);
    unmount(m);
});

t('a display setting changed in the panel is saved', () => {
    const m = mountSurface();
    const sw = m.nodes.find((n) => n.type === 'button' && n.props.role === 'switch'
        && words(n).includes('Backlight follows the S-meter colour'));
    assert.ok(sw, 'the switch is there');
    assert.strictEqual(sw.props['aria-checked'], false);
    sw.props.onClick();
    assert.strictEqual(controlState().tm2.display.meterColour, true);
    assert.strictEqual(controlState().tm2.display.readout, 'dbm', 'the rest kept');
    unmount(m);
});

console.log(`\nall ${pass} TM-2 panel tests passed`);
