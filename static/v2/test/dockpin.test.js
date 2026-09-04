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
const fs = require('fs');
const path = require('path');

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
const TOUCH = { phone: false, touch: true };
const PHONE = { phone: true, touch: true };

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

// What a dock will actually draw first — a panel above it in the list that is
// hidden, or parked, or floating is not the top panel.
const topOf = (l, side) => l.docks[side].panels.find((id) => !l.sections[id]?.hidden);

t('a first run opens with the Receiver pinned', () => {
    // The panel the feature is for, on the dock that scrolls. A default nobody
    // meets is a default nobody has — see PIN_DEFAULT.
    for (const env of [MOUSE, TOUCH, PHONE]) {
        const l = defaultLayout(env);
        assert.strictEqual(l.pins.left, 'receiver');
        assert.strictEqual(l.pins.right, null);
    }
    // And on the machines that draw docks it is the panel that will actually be
    // drawn first: the Multipad sits above it in the registry, and is hidden on
    // a mouse-only desktop and floating on a touchscreen one. A default naming a
    // panel below the top would apply to nothing at all. (A phone draws no docks
    // — its panels are sheets — so there is nothing there for a pin to do.)
    assert.strictEqual(topOf(defaultLayout(MOUSE), 'left'), 'receiver');
    assert.strictEqual(topOf(defaultLayout(TOUCH), 'left'), 'receiver');
});

t('the Receiver ships in its minimal view', () => {
    // It is the pinned panel, and a pinned one holds its room whatever else is
    // scrolling — so what starts pinned is the cut-down version: the dial, the
    // modes and the filter width. The rest is one click on the header away, and
    // that click is what gets remembered.
    assert.strictEqual(defaultLayout(MOUSE).sections.receiver.minimal, true);
    assert.strictEqual(defaultLayout(TOUCH).sections.receiver.minimal, true);
});

t('a first run is not offered the default a second time', () => {
    assert.strictEqual(defaultLayout(MOUSE).pinDefaulted, true);
});

// --- the default, reaching a layout that already exists ----------------------
//
// Everybody who has used v2 before has a stored layout, so a first-run default
// alone reaches nobody. The one-shot that does is the part that has to be
// careful: it must add only what this machine has never had an opinion about.

// A layout as it was stored before any of this existed: no pins, and no record
// of having been offered one.
const before = (over = {}) => {
    const l = defaultLayout(MOUSE);
    delete l.pins;
    delete l.pinDefaulted;
    return { ...l, ...over };
};

t('an existing layout gets the Receiver pinned, once', () => {
    const out = reconcile(before(), MOUSE);
    assert.strictEqual(out.pins.left, 'receiver');
    assert.strictEqual(out.pinDefaulted, true, 'and is not asked again');
});

t('unpinning it sticks', () => {
    // The layout written after that unpin carries the flag, so the one-shot has
    // to leave it alone — or the pin would come back on every reload, which is
    // the setting refusing to be turned off.
    const out = reconcile(before({ pins: { left: null, right: null }, pinDefaulted: true }), MOUSE);
    assert.strictEqual(out.pins.left, null);
});

t('a dock somebody has rearranged is left alone', () => {
    const l = defaultLayout(MOUSE);
    const panels = l.docks.left.panels.filter((id) => id !== 'receiver');
    // Past the first panel that is actually drawn, not merely past the first
    // entry: the Multipad heads the list and is hidden on this machine, so a
    // Receiver in second place is still the top of the dock.
    panels.splice(panels.findIndex((id) => !l.sections[id]?.hidden) + 1, 0, 'receiver');
    const out = reconcile(before({ docks: { ...l.docks, left: { ...l.docks.left, panels } } }), MOUSE);
    assert.notStrictEqual(topOf(out, 'left'), 'receiver', 'the fixture did not move it');
    assert.strictEqual(out.pins.left, null, 'a pin on a panel that is not the top one is not the offer');
    assert.strictEqual(out.pinDefaulted, true, 'and the offer is not held open for ever');
});

t('a hidden or floating Receiver is not pinned', () => {
    const hidden = before({ sections: { ...defaultLayout(MOUSE).sections, receiver: { hidden: true } } });
    assert.strictEqual(reconcile(hidden, MOUSE).pins.left, null);

    const floating = before({
        floats: { receiver: { x: 10, y: 10, w: 320, h: 320 } },
        floatOrder: ['receiver'],
    });
    assert.strictEqual(reconcile(floating, MOUSE).pins.left, null);
});

t('a layout already pinning something else keeps it', () => {
    const l = defaultLayout(MOUSE);
    const other = l.docks.left.panels.find((id) => id !== 'receiver' && id !== 'multipad');
    const out = reconcile(before({ pins: { left: other, right: null } }), MOUSE);
    assert.strictEqual(out.pins.left, other);
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

// --- the sticking itself ----------------------------------------------------
//
// One CSS rule does the whole job, so the numbers in it are the implementation
// and nothing else checks them.

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const block = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `no ${selector} rule in styles.css`);
    return css.slice(at, css.indexOf('}', at));
};

t('a pinned panel covers the dock padding it does not own', () => {
    // The 8px above a panel and the 8px between it and its neighbour belong to
    // the dock body, not to the panel: they scroll with the content, so a panel
    // passing behind a pinned one showed through the strip above it. The ring of
    // dock colour in the pinned panel's box-shadow is what covers that, and it
    // only covers it while the three numbers agree.
    const body = block('.dock__body {');
    const pad = /padding:\s*(\d+)px/.exec(body);
    const gap = /gap:\s*(\d+)px/.exec(body);
    assert.ok(pad && gap, 'the dock body no longer states a padding and a gap');

    const pinned = block('.dock--left .section.is-pinned,');
    const ring = /0 0 0 (\d+)px var\(--surface\)/.exec(pinned);
    assert.ok(ring, 'the pinned panel has no ring of dock colour around it');
    assert.strictEqual(ring[1], pad[1], 'the ring no longer covers the dock body padding');
    assert.strictEqual(ring[1], gap[1], 'the ring no longer covers the gap to the next panel');
});

t('a pinned panel is capped, and scrolls its own body', () => {
    // Sticky and taller than the dock is a trap: it would stick with its bottom
    // off the end of the scrollport, never let go, and the panels under it could
    // not be reached at all. The cap and the inner scroller go together — a cap
    // with nothing giving way underneath it just clips the panel.
    const pinned = block('.dock--left .section.is-pinned,');
    assert.match(pinned, /position:\s*sticky/);
    assert.match(pinned, /top:\s*0/);
    // Every section is position: relative, so without a z-index the panels after
    // this one in the DOM paint over the one that is meant to be in front.
    assert.match(pinned, /z-index:\s*[1-9]/);
    assert.match(pinned, /max-height:\s*\d+%/);
    assert.match(block('.dock--left .section.is-pinned .section__body,'), /overflow:\s*auto/);
});

t('the pin icon has a closed body, so the pinned state can be filled', () => {
    // .section__pin[aria-pressed="true"] fills the icon, and a fill needs
    // something closed to fill — an open path fills as a sliver of nothing, so
    // the lit state would differ from the unlit one by colour alone.
    const paths = walk(Icon.Pin({})).filter((n) => n.type === 'path');
    assert.ok(paths.some((n) => /z$/i.test(n.props.d || '')), 'no closed subpath in Icon.Pin');
});

console.log(`\n${pass} passed`);
