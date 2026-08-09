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
    assert.deepStrictEqual(doc.written, [['--app-height', '812px']]);
});

t('a later settle corrects a height that was wrong at first paint', () => {
    // The iOS standalone case: the first read is the wrong number and no event
    // says so, which is why the deferred re-reads exist.
    const win = fakeWin({ innerHeight: 900 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(doc.written, [['--app-height', '900px']]);

    win.innerHeight = 748;
    win._runTimers();
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '748px']);
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
    assert.strictEqual(doc.written.length, 1, 'the same height was written more than once');
});

t('rotating updates it', () => {
    const win = fakeWin({ innerHeight: 800 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 400;
    win._fire('orientationchange');
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '400px']);
});

t('coming back to a backgrounded app updates it', () => {
    const win = fakeWin({ innerHeight: 800 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 780;
    win._fire('pageshow');
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '780px']);
});

t('the visual viewport is listened to, since innerHeight settles silently', () => {
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.innerHeight = 734;
    win._fireVV('resize');
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '734px']);
});

t('the keyboard shrinks the shell, but only over something being typed into', () => {
    // iOS overlays the keyboard: innerHeight holds still, the visual viewport
    // shrinks, and Safari scrolls the page up to reveal the input — which on a
    // shell exactly one window tall exposes a keyboard-sized band of nothing.
    // While an editable element has focus, the visual viewport is the truth.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);

    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 1;
    win.visualViewport.height = 466;   // keyboard up; innerHeight unchanged
    win._fireVV('resize');
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '466px']);

    // Blur closes the keyboard. `editing()` answers before the viewport does,
    // so the full height comes back without waiting for a resize event.
    doc.activeElement = { tagName: 'BODY' };
    win._fireVV('resize');
    assert.deepStrictEqual(doc.written[doc.written.length - 1], ['--app-height', '800px']);
});

t('a shrunken viewport with nothing focused is not a keyboard', () => {
    // The old rule, kept for everything that is not typing: the visual viewport
    // twitches for all sorts of reasons, and resizing the spectrum canvas for
    // them is not what anybody wants.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    win.visualViewport.scale = 1;
    win.visualViewport.height = 400;
    win._fireVV('resize');
    assert.strictEqual(doc.written.length, 1, 'the shell followed a viewport nobody was typing in');
});

t('pinch zoom is not a keyboard either', () => {
    // Pinched in, the visual viewport is a window onto the page, and an input
    // can perfectly well be focused while it is. Shrinking the shell to it
    // would shrink the page being read.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 2;
    win.visualViewport.height = 400;
    win._fireVV('resize');
    assert.strictEqual(doc.written.length, 1, 'the shell followed a pinch');
});

t('the reveal scroll Safari already did is undone', () => {
    // By the time the resize arrives Safari has scrolled the page up to show
    // the input. With the shell now sized to fit, that scroll is doubled-up
    // correction and leaves the layout hanging above the keyboard.
    const win = fakeWin({ innerHeight: 800, visualViewport: true });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    doc.activeElement = { tagName: 'INPUT' };
    win.visualViewport.scale = 1;
    win.visualViewport.height = 466;
    win.scrollY = 334;
    win._fireVV('resize');
    assert.deepStrictEqual(win._scrolled, [[0, 0]]);
});

t('a height of zero is never written', () => {
    const win = fakeWin({ innerHeight: 0 });
    const doc = fakeDoc();
    startAppHeight(win, doc);
    assert.deepStrictEqual(doc.written, [], 'a zero height would collapse the shell');
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
