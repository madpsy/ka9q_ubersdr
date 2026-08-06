// Suspending the spectrum socket while the tab is hidden.
//
// Everything here happens off screen by definition, so a mistake is silent: a
// socket left closed after the operator came back, or a reconnect fighting the
// backoff behind a tab nobody is looking at. Hence the clock being injectable —
// none of this is worth finding five seconds at a time.

const assert = require('assert');
const { visibilityPause } = require('./.build/visibilitypause.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const DELAY = 5000;

// A tab, a socket and a clock you can wind on by hand.
function rig({ hidden = false, open = true } = {}) {
    const log = [];
    let now = 0;
    let next = 1;
    const pending = new Map();
    const state = { hidden, open };

    const p = visibilityPause({
        delayMs: DELAY,
        isHidden: () => state.hidden,
        isOpen: () => state.open,
        suspend: () => { log.push('suspend'); state.open = false; },
        resume: () => { log.push('resume'); state.open = true; },
        timers: {
            set: (fn, ms) => { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
            clear: (id) => pending.delete(id),
        },
    });

    return {
        log,
        state,
        pause: p,
        hide() { state.hidden = true; p.changed(); },
        show() { state.hidden = false; p.changed(); },
        tick(ms) {
            now += ms;
            for (const [id, e] of [...pending]) {
                if (e.at <= now) { pending.delete(id); e.fn(); }
            }
        },
        armed: () => pending.size,
    };
}

t('hiding does not suspend at once', () => {
    const r = rig();
    r.hide();
    r.tick(DELAY - 1);
    assert.deepStrictEqual(r.log, [], 'still within the grace period');
    r.tick(1);
    assert.deepStrictEqual(r.log, ['suspend']);
});

t('coming back inside the grace period costs nothing', () => {
    // The common case, and the whole reason for the delay: a glance at another
    // tab must not cost a reconnect.
    const r = rig();
    r.hide();
    r.tick(DELAY - 1);
    r.show();
    r.tick(DELAY * 10);
    assert.deepStrictEqual(r.log, [], 'neither suspended nor resumed');
    assert.strictEqual(r.armed(), 0, 'and nothing left ticking');
});

t('a full cycle suspends once and resumes once', () => {
    const r = rig();
    r.hide();
    r.tick(DELAY);
    r.show();
    assert.deepStrictEqual(r.log, ['suspend', 'resume']);
    assert.strictEqual(r.state.open, true);
});

t('a tab that came back just as the timer fired is not suspended', () => {
    // The timer was scheduled while hidden and cannot be un-scheduled from
    // inside itself, so the state is re-asked when it runs.
    const r = rig();
    r.hide();
    r.state.hidden = false;          // came back without the event landing yet
    r.tick(DELAY);
    assert.deepStrictEqual(r.log, []);
});

t('a socket that dropped on its own is left to its own reconnect', () => {
    // Suspending here would set closedByUser on a socket already counting down
    // its backoff, and nothing would ever bring it back.
    const r = rig();
    r.hide();
    r.state.open = false;
    r.tick(DELAY);
    assert.deepStrictEqual(r.log, [], 'not ours to suspend');
    r.show();
    assert.deepStrictEqual(r.log, [], 'and so not ours to resume');
});

t('becoming visible without having suspended resumes nothing', () => {
    const r = rig();
    r.show();
    r.tick(DELAY * 2);
    assert.deepStrictEqual(r.log, []);
});

t('repeated hidden events do not stack countdowns', () => {
    // visibilitychange can fire more than once for one switch, and a second
    // timer would suspend a second time — on a socket already gone.
    const r = rig();
    r.hide();
    r.hide();
    r.hide();
    assert.strictEqual(r.armed(), 1);
    r.tick(DELAY);
    assert.deepStrictEqual(r.log, ['suspend']);
});

t('hidden again while already suspended arms nothing', () => {
    const r = rig();
    r.hide();
    r.tick(DELAY);
    r.hide();
    assert.strictEqual(r.armed(), 0);
    r.tick(DELAY * 5);
    assert.deepStrictEqual(r.log, ['suspend'], 'still just the one');
});

t('mounting into an already-hidden tab starts the countdown', () => {
    // A receiver started and then backgrounded before the watch mounted: no
    // change event is coming, so the first call has to do the work.
    const r = rig({ hidden: true });
    r.pause.changed();
    r.tick(DELAY);
    assert.deepStrictEqual(r.log, ['suspend']);
});

t('stopping mid-countdown suspends nothing afterwards', () => {
    const r = rig();
    r.hide();
    r.pause.stop();
    r.tick(DELAY * 3);
    assert.deepStrictEqual(r.log, []);
});

t('switching away and back repeatedly settles either way, never half way', () => {
    const r = rig();
    for (let i = 0; i < 6; i++) {
        r.hide();
        r.tick(DELAY / 2);
        r.show();
        r.tick(DELAY / 2);
    }
    assert.deepStrictEqual(r.log, [], 'quick switches cost nothing at all');
    // ...and a real one still works afterwards.
    r.hide();
    r.tick(DELAY);
    r.show();
    assert.deepStrictEqual(r.log, ['suspend', 'resume']);
    assert.strictEqual(r.state.open, true, 'never left closed');
});

console.log(`\n${pass} ok`);
