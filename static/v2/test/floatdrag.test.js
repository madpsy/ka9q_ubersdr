// Which presses on a floating window's title bar begin a drag.
//
// The whole gesture hangs on one guard, and it fails silently in both
// directions: too loose and every control in the title bar is dead, because the
// drag calls preventDefault() and takes the pointer capture with it; too tight
// and the window cannot be moved at all.
//
// The case that broke in the field is the third one. A dropdown opened from the
// title bar renders through a portal into <body>, and React bubbles its events
// to the React parent — so the press arrives at this header having never
// touched it in the DOM. Every class-name test the guard could make says "not a
// control", the drag starts, and the menu item's click is swallowed: the menu
// opens, and nothing in it can be clicked.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;

const { render, reset, useFloatDrag } = require('./.build/floatdrag.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A header with one control in it, and a menu panel that is NOT in it — which
// is where a portalled dropdown really lives.
function makeDom() {
    const header = {
        contains: (n) => n && n.inHeader === true,
        setPointerCapture() { header.captured = true; },
        releasePointerCapture() {},
        captured: false,
    };
    const node = (inHeader, matches) => ({
        inHeader,
        closest: (sel) => (matches.some((m) => sel.includes(m)) ? {} : null),
    });
    return {
        header,
        bare: node(true, []),                        // the title bar itself
        control: node(true, ['.floatwin__ctl']),     // a button on the bar
        trigger: node(true, ['.menu']),              // the dropdown's trigger
        portalled: node(false, []),                  // a menu item under <body>
    };
}

function press(handlers, header, target) {
    const e = {
        target,
        currentTarget: header,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        prevented: false,
        preventDefault() { e.prevented = true; },
        stopPropagation() {},
    };
    handlers.onMoveDown(e);
    return e;
}

function mount(onChange) {
    reset();
    const bounds = { current: { width: 2000, height: 2000 } };
    const out = render(() => useFloatDrag({
        geom: { x: 10, y: 20, w: 300, h: 200 },
        bounds,
        min: { w: 100, h: 80 },
        onChange,
        onRaise: () => {},
    }));
    return out.tree;
}

t('a press on the bar itself drags the window', () => {
    const moves = [];
    const h = mount((p) => moves.push(p));
    const dom = makeDom();
    const e = press(h, dom.header, dom.bare);
    assert.strictEqual(e.prevented, true, 'a real drag must preventDefault');
    assert.strictEqual(dom.header.captured, true, 'a real drag takes the pointer');
    h.onMove({ clientX: 140, clientY: 100 });
    assert.strictEqual(moves.length, 1, 'the window did not move');
    assert.strictEqual(moves[0].x, 50);
});

t('a press on a title-bar control does not', () => {
    const moves = [];
    const h = mount((p) => moves.push(p));
    const dom = makeDom();
    const e = press(h, dom.header, dom.control);
    assert.strictEqual(e.prevented, false, 'the button lost its click');
    assert.strictEqual(dom.header.captured, false);
    h.onMove({ clientX: 140, clientY: 100 });
    assert.strictEqual(moves.length, 0);
});

t('nor one on a dropdown trigger', () => {
    const moves = [];
    const h = mount((p) => moves.push(p));
    const dom = makeDom();
    const e = press(h, dom.header, dom.trigger);
    assert.strictEqual(e.prevented, false);
    h.onMove({ clientX: 140, clientY: 100 });
    assert.strictEqual(moves.length, 0);
});

t('nor one on a menu item portalled out of the header', () => {
    const moves = [];
    const h = mount((p) => moves.push(p));
    const dom = makeDom();
    const e = press(h, dom.header, dom.portalled);
    // Every one of these is what kills the item's click: the compatibility
    // mouse events go with preventDefault, and the rest of the gesture goes
    // with the capture.
    assert.strictEqual(e.prevented, false, 'the menu item lost its click');
    assert.strictEqual(dom.header.captured, false, 'the header stole the pointer');
    h.onMove({ clientX: 140, clientY: 100 });
    assert.strictEqual(moves.length, 0, 'clicking a menu item dragged the window');
});

t('a resize is judged on its own handle, not on this', () => {
    // The corner grip is not in the title bar and never was: the guard is about
    // presses that begin on a control, and a resize has no controls to miss.
    const moves = [];
    const h = mount((p) => moves.push(p));
    const dom = makeDom();
    const e = {
        target: dom.portalled,
        currentTarget: dom.header,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        prevented: false,
        preventDefault() { e.prevented = true; },
        stopPropagation() {},
    };
    h.onSizeDown(e);
    assert.strictEqual(e.prevented, true);
    h.onMove({ clientX: 160, clientY: 100 });
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].w, 360);
});

console.log(`\n${pass} ok`);
