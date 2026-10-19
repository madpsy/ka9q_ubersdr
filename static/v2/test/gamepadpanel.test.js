// The SDR Control panel renders with a game controller chosen: before a pad
// is seen, connected, in setup-by-pressing, and with the rumble settings open.
//
// The panel is a large component with a child per surface, and a name used in
// the wrong one of them builds cleanly and blanks the interface — see
// hookStub.js. So each state is rendered all the way down.

const assert = require('assert');

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
const pads = [];
globalThis.navigator = { userAgent: 'node', getGamepads: () => pads };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.isSecureContext = true;

const {
    deep, render, rerender, reset, walk, words,
    SDRControlPanel, getGamepad, updateControlState, GAMEPAD_DEFAULT_MAPPINGS, watchSurface,
} = require('./.build/gamepadpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const context = {
    tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    audio: { volume: 0.5, muted: false },
    squelch: { value: -999 },
    dsp: { schemas: [] },
    serverInfo: {},
    actions: {},
};

// The panel's own tree, then the surface editor inside it mounted for real —
// its effects are where the subscriptions live — and expanded to the leaves.
function mountSurface(props = {}) {
    reset();
    const outer = render(SDRControlPanel, props, context);
    const el = walk(outer.tree).find((n) => typeof n.type === 'function' && n.type.name === 'SurfaceControl');
    assert.ok(el, 'SurfaceControl is in the tree');
    reset();
    const inner = render(el.type, el.props, context);
    return { outer, el, inner, text: words(inner.tree), nodes: deep(inner.tree) };
}

function unmount(m) {
    for (const off of m.inner.cleanups) off();
    for (const off of m.outer.cleanups) off();
}

const buttons = (nodes, label) => nodes.filter((n) => n.type === 'button' && words(n).includes(label));

updateControlState({ surface: 'gamepad' });

t('the picker offers Gamepad', () => {
    reset();
    const { tree, cleanups } = render(SDRControlPanel, {}, context);
    const seg = walk(tree).find((n) => n.props && Array.isArray(n.props.options) && n.props.options.some((o) => o.value === 'midi'));
    assert.ok(seg.props.options.some((o) => o.value === 'gamepad'));
    cleanups.forEach((off) => off());
});

t('before a pad is seen: the steps, the empty list, Connect disabled', () => {
    const m = mountSurface();
    assert.match(m.text, /Press a button on the controller/);
    assert.match(m.text, /Pair the controller/);
    assert.match(m.text, /Rumble for feedback/);
    const connect = buttons(m.nodes, 'Connect')[0];
    assert.ok(connect.props.disabled);
    // Arrives mapped: the default table is listed, sticks marked as rates.
    assert.match(m.text, /Encoder \(100 Hz steps\) Left stick left rate/);
    unmount(m);
});

const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    mapping: 'standard', connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    vibrationActuator: { type: 'dual-rumble', playEffect: () => Promise.resolve() },
};

t('connected: the short name, the last-control readout, rumble Test enabled', () => {
    pads.push(pad);
    getGamepad().connect('0');
    const m = mountSurface();
    assert.match(m.text, /Xbox Wireless Controller/);
    assert.ok(!/STANDARD GAMEPAD/.test(m.text), 'the vendor brackets are not shown');
    assert.match(m.text, /Press a control to see what it does/);
    assert.ok(!buttons(m.nodes, 'Test')[0].props.disabled);
    assert.ok(buttons(m.nodes, 'Set up by pressing').length === 1);
    assert.ok(buttons(m.nodes, 'Defaults').length === 1);
    unmount(m);
});

t('setup by pressing: waits for a control, then offers the function list for it', () => {
    // ControlWatch's job in the page: input reaches learn through dispatch.
    const unwatch = watchSurface('gamepad');
    const m = mountSurface();
    buttons(m.nodes, 'Set up by pressing')[0].props.onClick();
    let r = rerender(m.el.type, m.el.props, context, m.inner);
    assert.match(words(r.tree), /Press or move any control/);

    // A D-pad press arrives while assigning: taken, not dispatched.
    pad.buttons[15] = { pressed: true, value: 1 };
    getGamepad().poll();
    r = rerender(m.el.type, m.el.props, context, r);
    const text = words(r.tree);
    assert.match(text, /D-pad right/);
    const select = deep(r.tree).find((n) => n.type === 'select' && n.props['aria-label'] === 'What D-pad right does');
    assert.ok(select, 'a function list for the pressed control');
    assert.strictEqual(select.props.value, 'freq_step_up', 'showing what it does now');

    select.props.onChange({ target: { value: 'mode_next' } });
    const { controlState } = require('./.build/gamepadpanel.cjs');
    assert.strictEqual(controlState().gamepad.mappings['b:15'].function, 'mode_next');
    pad.buttons[15] = { pressed: false, value: 0 };
    getGamepad().poll();
    unwatch();
    for (const off of r.cleanups) off();
    for (const off of m.outer.cleanups) off();
});

t('minimal still renders the connection line', () => {
    const m = mountSurface({ minimal: true });
    assert.match(m.text, /Disconnect/);
    unmount(m);
    getGamepad().close();
});

console.log(`\n${pass} passed`);
