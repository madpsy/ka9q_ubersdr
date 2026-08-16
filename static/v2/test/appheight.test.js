// The measured window height.
//
// What this has to get right is narrow but load-bearing on a phone: the value
// has to be written before the first paint, corrected again once the standalone
// viewport settles, and *not* rewritten on every visual-viewport scroll event —
// setting a custom property invalidates layout, and those fire constantly.

const assert = require('assert');
const { startAppHeight } = require('./.build/appheight.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A window with hand-cranked timers and events.
function fakeWin({ innerHeight = 800, visualViewport = false } = {}) {
    const listeners = new Map();
    const timers = new Map();
    let nextTimer = 1;

    const target = (map) => ({
        addEventListener: (type, fn) => {
            if (!map.has(type)) map.set(type, new Set());
            map.get(type).add(fn);
        },
        removeEventListener: (type, fn) => { map.get(type)?.delete(fn); },
    });

    const vvListeners = new Map();
    const scrolled = [];
    const win = {
        innerHeight,
        scrollY: 0,
        scrollTo: (x, y) => { scrolled.push([x, y]); win.scrollY = y; },
        _scrolled: scrolled,
        ...target(listeners),
        setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        visualViewport: visualViewport ? target(vvListeners) : undefined,
        // test helpers
        _fire: (type) => { for (const fn of listeners.get(type) || []) fn(); },
        _fireVV: (type) => { for (const fn of vvListeners.get(type) || []) fn(); },
        _runTimers: () => { const due = [...timers.values()]; timers.clear(); for (const t2 of due) t2.fn(); },
        _timerCount: () => timers.size,
        _listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
            + [...vvListeners.values()].reduce((n, s) => n + s.size, 0),
    };
    return win;
}

// Only the shell height. The module also publishes the visible box for fixed
// overlays (--vv-top, --vv-height); tests about the height say so rather than
// counting every property write and breaking when a second one is added.
const heights = (doc) => doc.written.filter(([name]) => name === '--app-height');

function fakeDoc() {
    const written = [];
    return {
        written,
        // Nothing focused unless a test says so — tagName BODY, like a real
        // document at rest.
        activeElement: { tagName: 'BODY' },
        documentElement: {
            style: {
                setProperty: (name, value) => written.push([name, value]),
            },
        },
    };
}

t('the height is written immediately, before anything renders', () => {
    const win = fakeWin({ innerHeight: 812 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(heights(doc), [['--app-height', '812px']]);
});

t('a later settle corrects a height that was wrong at first paint', () => {
    // The iOS standalone case: the first read is the wrong number and no event
    // says so, which is why the deferred re-reads exist.
    const win = fakeWin({ innerHeight: 900 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(heights(doc), [['--app-height', '900px']]);

    win.innerHeight = 748;
    win._runTimers();
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '748px']);
});

t('an unchanged height is not written again', () => {
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win._runTimers();
    win._fire('resize');
    // Visual-viewport scroll fires on every scrap of movement; each write here
    // would be a layout invalidation for nothing.
    for (let i = 0; i < 50; i++) win._fireVV('scroll');
    assert.strictEqual(heights(doc).length, 1, 'the same height was written more than once');
});

t('rotating updates it', () => {
    const win = fakeWin({ innerHeight: 800 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 400;
    win._fire('orientationchange');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '400px']);
});

t('coming back to a backgrounded app updates it', () => {
    const win = fakeWin({ innerHeight: 800 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 780;
    win._fire('pageshow');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '780px']);
});

t('the visual viewport is listened to, since innerHeight settles silently', () => {
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 734;
    win._fireVV('resize');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '734px']);
});

t('a keyboard reveal that fits on the page changes nothing', () => {
    // iOS overlays the keyboard and pans the visual viewport to show the input.
    // When the pan stays inside the document — a floating window mid-screen —
    // there is no band to cover, and the shell must not move: resizing the
    // spectrum canvas for a keyboard that fits is the regression the first
    // version of this shipped.
    const win = fakeWin({ innerHeight: 760, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 1;
    win.visualViewport.height = 360;   // keyboard up; innerHeight unchanged
    win.visualViewport.offsetTop = 160;
    win._fireVV('resize');
    assert.strictEqual(heights(doc).length, 1, 'the shell moved for a reveal that fit');
});

t('a reveal panned past the end of the page grows the shell to meet it', () => {
    // The black band: Safari pans the input above the keys with breathing room,
    // which for an input at the very bottom means panning beyond the document —
    // and everything beyond the document is bare background. The shell grows by
    // the overshoot, so there is page where the band was and the compose box
    // sits flush on the keys.
    const win = fakeWin({ innerHeight: 760, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 1;
    win.visualViewport.height = 360;
    win.visualViewport.offsetTop = 460;   // 60 past the 760px document
    win._fireVV('resize');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '820px']);

    // However the reveal was split between a layout scroll and a pan: the sum
    // is the bottom of what is on screen, and that is what the shell reaches.
    win.scrollY = 60;
    win.visualViewport.offsetTop = 420;
    win._fireVV('scroll');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '840px']);

    // Blur closes the keyboard. `editing()` answers before the viewport does,
    // so the height is back before iOS gets round to saying anything.
    doc.activeElement = { tagName: 'BODY' };
    win.scrollY = 0;
    win._fireVV('resize');
    assert.deepStrictEqual(heights(doc).pop(), ['--app-height', '760px']);
});

t('a shrunken viewport with nothing focused is not a keyboard', () => {
    // The visual viewport twitches for all sorts of reasons, and resizing the
    // spectrum canvas for them is not what anybody wants.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.visualViewport.scale = 1;
    win.visualViewport.height = 400;
    win.visualViewport.offsetTop = 500;
    win._fireVV('resize');
    assert.strictEqual(heights(doc).length, 1, 'the shell followed a viewport nobody was typing in');
});

t('pinch zoom is not a keyboard either', () => {
    // Pinched in, the visual viewport is a window onto the page, and an input
    // can perfectly well be focused while it is.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 2;
    win.visualViewport.height = 400;
    win.visualViewport.offsetTop = 700;
    win._fireVV('resize');
    assert.strictEqual(heights(doc).length, 1, 'the shell followed a pinch');
});

t('a leftover reveal scroll is put back once typing ends', () => {
    // The page never scrolls on purpose, so once nothing is being edited any
    // scroll is Safari's leftovers from the reveal.
    const win = fakeWin({ innerHeight: 760, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.scrollY = 60;
    win._fire('resize');
    assert.deepStrictEqual(win._scrolled, [[0, 0]]);
});

t('a height of zero is never written', () => {
    const win = fakeWin({ innerHeight: 0 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(heights(doc), [], 'a zero height would collapse the shell');
});

// --- the visible box, for fixed overlays -------------------------------------

const boxOf = (doc, name) => doc.written.filter(([n]) => n === name).pop();

t('the visible box is published alongside the height', () => {
    const win = fakeWin({ innerHeight: 812, visualViewport: true });
    win.visualViewport.height = 812;
    win.visualViewport.offsetTop = 0;
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(boxOf(doc, '--vv-top'), ['--vv-top', '0px']);
    assert.deepStrictEqual(boxOf(doc, '--vv-height'), ['--vv-height', '812px']);
});

t('a keyboard shrinks the box and records the pan', () => {
    // What a dialog needs and the shell deliberately ignores: where the visible
    // region is now, so a fixed box can sit in it rather than behind the keys.
    const win = fakeWin({ innerHeight: 812, visualViewport: true });
    win.visualViewport.height = 812;
    win.visualViewport.offsetTop = 0;
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 1;
    win.visualViewport.height = 420;
    win.visualViewport.offsetTop = 96;
    win._fireVV('resize');
    assert.deepStrictEqual(boxOf(doc, '--vv-top'), ['--vv-top', '96px']);
    assert.deepStrictEqual(boxOf(doc, '--vv-height'), ['--vv-height', '420px']);
});

t('the box comes back when the keyboard goes', () => {
    const win = fakeWin({ innerHeight: 812, visualViewport: true });
    win.visualViewport.height = 420;
    win.visualViewport.offsetTop = 96;
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.visualViewport.height = 812;
    win.visualViewport.offsetTop = 0;
    win._fireVV('resize');
    assert.deepStrictEqual(boxOf(doc, '--vv-top'), ['--vv-top', '0px']);
    assert.deepStrictEqual(boxOf(doc, '--vv-height'), ['--vv-height', '812px']);
});

t('an unchanged box is not written again', () => {
    const win = fakeWin({ innerHeight: 812, visualViewport: true });
    win.visualViewport.height = 812;
    win.visualViewport.offsetTop = 0;
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win._fireVV('scroll');
    win._fireVV('scroll');
    assert.strictEqual(doc.written.filter(([n]) => n === '--vv-height').length, 1);
});

t('with no visual viewport the box is simply the window', () => {
    const win = fakeWin({ innerHeight: 700 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(boxOf(doc, '--vv-height'), ['--vv-height', '700px']);
    assert.deepStrictEqual(boxOf(doc, '--vv-top'), ['--vv-top', '0px']);
});

t('stopping removes every listener and pending timer', () => {
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const stop = startAppHeight(win, fakeDoc());
    assert.ok(win._listenerCount() > 0);
    assert.ok(win._timerCount() > 0);
    stop();
    assert.strictEqual(win._listenerCount(), 0);
    assert.strictEqual(win._timerCount(), 0);
});

t('no window at all is not a crash', () => {
    assert.strictEqual(typeof startAppHeight(null, null), 'function');
    assert.strictEqual(typeof startAppHeight(fakeWin(), {}), 'function');
});

console.log(`\n${pass} ok`);
