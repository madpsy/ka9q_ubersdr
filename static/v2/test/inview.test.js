// Stopping a panel's stream when nobody can see it — scrolled out of the dock
// column, or a tab sent to the background.
//
// The band spectrum's EventSource was tied to the panel being mounted, which a
// dock column taller than the window makes into the wrong question: a panel
// three screens down is open, invisible and streaming. What that gate has to get
// right is the flapping — scrolling the length of a column takes every panel
// past the edge for a moment, and closing a stream on each of them costs more
// than the one it saves — so the tests here are mostly about what does *not*
// happen. See hookStub.js for what "renders" means here.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;

// A clock that only moves when a test says so: the countdown is seconds long and
// none of this is worth waiting for.
let now = 0;
let nextId = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const elapse = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
    }
};

// A page that can be hidden, and one listener — the only two things the
// visibility half of this touches.
const listeners = [];
globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); },
    removeEventListener: (type, fn) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
    },
};
/** Background or foreground the tab, as the browser would. */
const setHidden = (v) => { document.hidden = v; for (const fn of [...listeners]) fn(); };

// The browser's observer, reduced to the two things this uses: it is handed a
// callback, and it is disconnected.
let observers = [];
class FakeIO {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.targets = []; this.dead = false; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.dead = true; }
}
globalThis.IntersectionObserver = FakeIO;

const {
    render, reset, useInView, usePageVisible,
    IN_VIEW_MARGIN, OFF_SCREEN_MS, HIDDEN_SUSPEND_MS, React,
} = require('./.build/inview.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// The hook under a component, since that is the only way to run one.
//
// The stub's setState does not re-render, so `read()` renders again to pick the
// new value up. That mounts a second observer — the stub has no way not to —
// which is why the callbacks are always delivered to the first one: it is the
// one holding the countdown, and the spares are never spoken to.
function mount(opts) {
    reset();
    observers = [];
    timers.clear();
    const el = { nodeName: 'DIV' };
    const seen = [];
    const Probe = () => {
        const ref = React.useRef(null);
        ref.current = el;
        seen.push(useInView(ref, opts));
        return { type: 'div', props: {} };
    };
    const first = render(Probe, {}, null);
    const read = () => { render(Probe, {}, null); return seen[seen.length - 1]; };
    return {
        el,
        seen,
        read,
        cleanups: first.cleanups,
        io: () => observers[0],
        // What the browser delivers: one entry, or several after a scroll.
        report: (...flags) => observers[0].cb(flags.map((f) => ({ isIntersecting: f })), observers[0]),
    };
}

// --- what it watches --------------------------------------------------------

t('observes the element it was given, with the margin', () => {
    const m = mount();
    assert.strictEqual(m.io().targets[0], m.el);
    assert.strictEqual(m.io().opts.rootMargin, IN_VIEW_MARGIN);
});

// Pinned, because it is the difference between "not in view" and "nearly in
// view": a margin here is symmetric, so anything it lets keep streaming it also
// lets *start* streaming on a page load that never showed the panel.
t('no margin, so nearly on screen is off screen', () => {
    assert.strictEqual(IN_VIEW_MARGIN, '0px');
});

t('starts off screen, so a panel mounted below the fold never opens anything', () => {
    const m = mount();
    assert.strictEqual(m.seen[0], false);
    m.report(false);
    elapse(OFF_SCREEN_MS * 2);
    assert.strictEqual(m.read(), false);
});

t('on screen at the first answer', () => {
    const m = mount();
    m.report(true);
    assert.strictEqual(m.read(), true);
});

t('the last entry is the one that counts', () => {
    const m = mount();
    m.report(false, true);
    assert.strictEqual(m.read(), true);
});

// --- leaving is on a countdown ----------------------------------------------

t('scrolled past for a moment stays on screen', () => {
    const m = mount();
    m.report(true);
    m.report(false);
    elapse(OFF_SCREEN_MS - 1);
    assert.strictEqual(m.read(), true);
    m.report(true);
    elapse(OFF_SCREEN_MS * 10);
    assert.strictEqual(m.read(), true);
});

t('off screen for long enough stops it', () => {
    const m = mount();
    m.report(true);
    m.report(false);
    elapse(OFF_SCREEN_MS);
    assert.strictEqual(m.read(), false);
});

t('a second off-screen report does not push the deadline out', () => {
    const m = mount();
    m.report(true);
    m.report(false);
    elapse(OFF_SCREEN_MS / 2);
    m.report(false);
    elapse(OFF_SCREEN_MS / 2);
    assert.strictEqual(m.read(), false);
});

t('coming back after it stopped starts it again', () => {
    const m = mount();
    m.report(true);
    m.report(false);
    elapse(OFF_SCREEN_MS);
    assert.strictEqual(m.read(), false);
    m.report(true);
    assert.strictEqual(m.read(), true);
});

t('the delay can be set', () => {
    const m = mount({ delayMs: 50, margin: '10px' });
    assert.strictEqual(m.io().opts.rootMargin, '10px');
    m.report(true);
    m.report(false);
    elapse(49);
    assert.strictEqual(m.read(), true);
    elapse(1);
    assert.strictEqual(m.read(), false);
});

// --- teardown ---------------------------------------------------------------

t('unmounting disconnects the observer and drops the countdown', () => {
    const m = mount();
    m.report(true);
    m.report(false);
    assert.strictEqual(timers.size, 1);
    for (const off of m.cleanups) off();
    assert.strictEqual(m.io().dead, true);
    assert.strictEqual(timers.size, 0, 'a pending countdown outlived the component');
});

// --- no observer ------------------------------------------------------------

t('everything is in view without IntersectionObserver', () => {
    const real = globalThis.IntersectionObserver;
    delete globalThis.IntersectionObserver;
    try {
        const m = mount();
        assert.strictEqual(m.seen[0], true);
        assert.strictEqual(observers.length, 0);
        assert.strictEqual(m.read(), true);
    } finally {
        globalThis.IntersectionObserver = real;
    }
});

// --- the hidden tab -----------------------------------------------------------
//
// The other half of the gate, and the one the observer above cannot answer: a
// background tab leaves the panel laid out exactly where it was, and stops
// delivering intersections at all.

function mountVisible(opts) {
    reset();
    listeners.length = 0;
    timers.clear();
    document.hidden = false;
    const seen = [];
    const Probe = () => {
        seen.push(usePageVisible(opts));
        return { type: 'div', props: {} };
    };
    const first = render(Probe, {}, null);
    return {
        seen,
        read: () => { render(Probe, {}, null); return seen[seen.length - 1]; },
        cleanups: first.cleanups,
    };
}

t('a page in front is visible', () => {
    const m = mountVisible();
    assert.strictEqual(m.seen[0], true);
    assert.strictEqual(listeners.length, 1, 'nothing is listening for visibilitychange');
});

t('a tab hidden for a moment keeps it', () => {
    const m = mountVisible();
    setHidden(true);
    elapse(HIDDEN_SUSPEND_MS - 1);
    assert.strictEqual(m.read(), true);
    setHidden(false);
    elapse(HIDDEN_SUSPEND_MS * 10);
    assert.strictEqual(m.read(), true);
});

t('a tab hidden for the whole grace period stops it', () => {
    const m = mountVisible();
    setHidden(true);
    elapse(HIDDEN_SUSPEND_MS);
    assert.strictEqual(m.read(), false);
    setHidden(false);
    assert.strictEqual(m.read(), true);
});

t('mounting in a background tab never starts', () => {
    reset();
    listeners.length = 0;
    timers.clear();
    document.hidden = true;
    const seen = [];
    const Probe = () => { seen.push(usePageVisible()); return { type: 'div', props: {} }; };
    render(Probe, {}, null);
    assert.strictEqual(seen[0], false, 'a stream opened in a tab nobody was looking at');
    // ...and coming to the front still starts it, which is the case the
    // countdown's "never suspended anything" guard would otherwise swallow.
    setHidden(false);
    render(Probe, {}, null);
    assert.strictEqual(seen[seen.length - 1], true);
});

t('unmounting drops the listener and the countdown', () => {
    const m = mountVisible();
    setHidden(true);
    assert.strictEqual(timers.size, 1);
    for (const off of m.cleanups) off();
    assert.strictEqual(listeners.length, 0, 'a visibilitychange listener outlived the component');
    assert.strictEqual(timers.size, 0, 'a pending countdown outlived the component');
});

console.log(`\n${pass} passed`);
