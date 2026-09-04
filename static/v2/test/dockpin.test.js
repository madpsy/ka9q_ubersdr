// Pinning the top panel of a side dock.
//
// Three things have to agree or the feature is quietly wrong, and none of them
// can see the others: the rule (only the top panel, only a column dock, matched
// by id), the stored layout that has to survive a panel being moved somewhere
// else, and the header that offers the button. A pin left applying to a panel
// that is no longer at the top would hold the *second* panel still and cover
// the first — which looks like the dock having broken rather than like a
// setting being on. See hookStub.js for what "renders" means here.

const assert = require('assert');

// Before the bundle: the module graph behind a section reaches the display
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
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    render, reset, walk,
    Section, canPin, pinnedPanel, PINNABLE,
    defaultLayout, reconcile, DEFAULTS, Icon,
} = require('./.build/dockpin.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const MOUSE = { phone: false, touch: false };

// --- the rule ---------------------------------------------------------------

t('the pin applies to the panel it names, and only at the top', () => {
    const pins = { left: 'receiver', right: null };
    assert.strictEqual(pinnedPanel(pins, 'left', ['receiver', 'bands']), 'receiver');
    // Moved down a place: the pin stops applying rather than sliding onto
    // whichever panel is now first, which would pin something nobody asked for.
    assert.strictEqual(pinnedPanel(pins, 'left', ['bands', 'receiver']), null);
    // ...and applies again when it comes back, so the arrow that moved it is
    // also the way back.
    assert.strictEqual(pinnedPanel(pins, 'left', ['receiver']), 'receiver');
});

t('a dock with nothing drawn in it pins nothing', () => {
    assert.strictEqual(pinnedPanel({ left: 'receiver' }, 'left', []), null);
    // Hidden, or not applicable to this receiver: the id is still stored, and
    // there is still nothing to hold still.
    assert.strictEqual(pinnedPanel({ left: 'receiver' }, 'left', ['bands']), null);
});

t('the bottom dock is never pinned', () => {
    // It is a row: there is no "under" for the other panels to go, and nothing
    // above them to hold still.
    assert.ok(!PINNABLE.includes('bottom'));
    assert.strictEqual(pinnedPanel({ bottom: 'log' }, 'bottom', ['log']), null);
    assert.strictEqual(canPin('bottom', 0), false);
});

t('only the first panel is offered a pin', () => {
    assert.strictEqual(canPin('left', 0), true);
    assert.strictEqual(canPin('right', 0), true);
    assert.strictEqual(canPin('left', 1), false);
    assert.strictEqual(canPin('float', 0), false);
});

t('a missing pins map is not an error', () => {
    // A layout stored before this existed has no `pins` at all, and reaches the
    // dock before reconcile has been anywhere near it in a test.
    assert.strictEqual(pinnedPanel(undefined, 'left', ['receiver']), null);
    assert.strictEqual(pinnedPanel({}, 'left', ['receiver']), null);
});

// --- what is stored ---------------------------------------------------------

const stored = (over = {}) => ({ ...defaultLayout(MOUSE), ...over });

t('a first run pins nothing', () => {
    const l = defaultLayout(MOUSE);
    assert.deepStrictEqual(l.pins, { left: null, right: null });
});

t('a pin on a panel still in its dock survives a reload', () => {
    const l = defaultLayout(MOUSE);
    const top = l.docks.left.panels[0];
    const out = reconcile(stored({ pins: { left: top, right: null } }), MOUSE);
    assert.strictEqual(out.pins.left, top);
});

t('a pin on a panel that has moved to the other dock is dropped', () => {
    const l = defaultLayout(MOUSE);
    const elsewhere = l.docks.right.panels[0];
    const out = reconcile(stored({ pins: { left: elsewhere, right: null } }), MOUSE);
    assert.strictEqual(out.pins.left, null, 'a pin naming a panel in another dock is not a pin');
});

t('a pin on a panel that has been floated is dropped', () => {
    const l = defaultLayout(MOUSE);
    const top = l.docks.left.panels[0];
    const out = reconcile(stored({
        pins: { left: top, right: null },
        floats: { [top]: { x: 10, y: 10, w: 320, h: 320 } },
        floatOrder: [top],
    }), MOUSE);
    assert.ok(!out.docks.left.panels.includes(top), 'it is a window now');
    assert.strictEqual(out.pins.left, null);
});

t('a pin on an id no dock holds is dropped', () => {
    const out = reconcile(stored({ pins: { left: 'nosuchpanel', right: 42 } }), MOUSE);
    assert.deepStrictEqual(out.pins, { left: null, right: null });
});

t('a pin on a parked panel is kept', () => {
    // An id the registry does not currently know keeps its place in the dock —
    // a custom panel whose manifest has not arrived yet is the usual reason —
    // so the pin on it is still describing something true. Dropping it would
    // quietly undo the setting on every reload the manifest was late for.
    const l = defaultLayout(MOUSE);
    const docks = { ...l.docks, left: { ...l.docks.left, panels: ['custom.late', ...l.docks.left.panels] } };
    const out = reconcile(stored({ docks, pins: { left: 'custom.late', right: null } }), MOUSE);
    assert.ok(out.docks.left.panels.includes('custom.late'), 'parked, not discarded');
    assert.strictEqual(out.pins.left, 'custom.late');
});

// --- the button -------------------------------------------------------------

// One object answers useLayout, useDisplay and useRadio alike — the stub's
// useContext has no way to tell contexts apart, and none of the three wants
// anything the others would mind seeing.
function context(over) {
    return {
        sections: {},
        weights: {},
        toggleSection() {},
        toggleSectionMinimal() {},
        setSectionHidden() {},
        setSectionScale() {},
        movePanel() {},
        movePanelNear() {},
        swapPanels() {},
        setWeights() {},
        setPanelHeight() {},
        togglePin() {},
        ...DEFAULTS,
        set() {},
        // useWakeProps' half: a panel body wakes a receiver that has idled out.
        actions: { wake() {} },
        ...over,
    };
}

const PANEL = { id: 'receiver', title: 'Receiver', icon: 'r', minimal: true, Component: () => null };

const classOf = (n) => (typeof n?.props?.className === 'string' ? n.props.className : '');

function head(props, ctx) {
    reset();
    const { tree } = render(Section, { panel: PANEL, dock: 'left', index: 0, ...props }, context(ctx));
    const nodes = walk(tree);
    const header = nodes.find((n) => classOf(n) === 'section__head');
    return {
        section: tree,
        header,
        // What the header actually drew, in order. A `{cond && …}` that came out
        // false is a `false` in the children, and it is not a control.
        controls: (header ? header.children : []).flat().filter((n) => n && typeof n === 'object'),
        pin: nodes.find((n) => classOf(n).includes('section__pin')),
    };
}

t('the top panel of a side dock offers a pin', () => {
    const { pin } = head({});
    assert.ok(pin, 'no pin button in the header');
    assert.strictEqual(pin.props['aria-pressed'], false);
    assert.match(pin.props.title, /^Pin to the top/);
});

t('a panel below the top does not, and neither does one in the bottom dock', () => {
    assert.ok(!head({ index: 1 }).pin, 'a second panel cannot be pinned');
    assert.ok(!head({ dock: 'bottom', weight: 1 }).pin, 'the bottom dock lays its panels out in a row');
});

t('a pinned panel is lit, says how to undo it, and is sticky', () => {
    const { pin, section } = head({ pinned: true });
    assert.strictEqual(pin.props['aria-pressed'], true);
    assert.match(pin.props.title, /^Unpin/);
    // The class is the whole of the behaviour — the sticking itself is one CSS
    // rule — so a section that does not carry it is a pin that does nothing.
    assert.ok(section.props.className.includes('is-pinned'), section.props.className);
});

t('an unpinned panel is not sticky', () => {
    assert.ok(!head({}).section.props.className.includes('is-pinned'));
});

t('the button pins this panel in this dock', () => {
    const calls = [];
    const { pin } = head({ dock: 'right' }, { togglePin: (side, id) => calls.push([side, id]) });
    pin.props.onClick();
    assert.deepStrictEqual(calls, [['right', 'receiver']]);
});

t('the pin sits second from the right, after the minimal toggle', () => {
    // Where the operator was told to look for it. The move menu is always last
    // — it is the one control every panel has — so second from the right is the
    // pin's place, and a control added to this header later must not take it.
    const { controls, pin } = head({});
    assert.ok(controls.length >= 2, 'the header drew almost nothing');
    assert.strictEqual(controls[controls.length - 2], pin, 'the pin is not second from the right');
    assert.strictEqual(typeof controls[controls.length - 1].type, 'function', 'the move menu is not last');
});

t('the pin icon has a closed body, so the pinned state can be filled', () => {
    // .section__pin[aria-pressed="true"] fills the icon, and a fill needs
    // something closed to fill — an open path fills as a sliver of nothing, so
    // the lit state would differ from the unlit one by colour alone.
    const paths = walk(Icon.Pin({})).filter((n) => n.type === 'path');
    assert.ok(paths.some((n) => /z$/i.test(n.props.d || '')), 'no closed subpath in Icon.Pin');
});

console.log(`\n${pass} passed`);
