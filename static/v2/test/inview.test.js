// Stopping a panel's stream when the panel is scrolled out of view.
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
    render, reset, useInView, IN_VIEW_MARGIN, OFF_SCREEN_MS, React,
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

console.log(`\n${pass} passed`);
