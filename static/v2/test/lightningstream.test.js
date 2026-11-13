// The lightning stream: who holds it open, and what it is willing to interrupt somebody
// about.
//
// The strike vocabulary itself — the SNR bands, the buckets, the trimming — is
// lightning.test.js and is pure. This is the part that has a connection and a clock, and
// both of the things worth pinning here are about restraint: a stream that nobody has
// asked for is not opened, and a storm overhead does not become a notification per strike.

const assert = require('assert');
const lx = require('./.build/lightningstream.cjs');

let pass = 0;
const ta = (name, fn) => {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log('ok    ' + name); pass++; },
            (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });
};

let chain = Promise.resolve();
const q = (name, fn) => { chain = chain.then(() => ta(name, fn)); };

const settle = () => new Promise((r) => setTimeout(r, 0));

// ── The world the store runs in ────────────────────────────────────────────────

let opened = [];

class FakeES {
    constructor(url) {
        this.url = url;
        this.listeners = {};
        this.closed = false;
        opened.push(this);
    }

    addEventListener(name, fn) {
        (this.listeners[name] = this.listeners[name] || []).push(fn);
    }

    close() { this.closed = true; }

    emit(name, ev) { for (const fn of this.listeners[name] || []) fn(ev); }
}

const liveOnes = () => opened.filter((e) => !e.closed);

let clock = Date.UTC(2026, 7, 17, 12, 0, 0);
const realNow = Date.now;

// Distinct per strike, because a strike's id is its arrival time and its clock string:
// two identical ones are one strike as far as addStrike is concerned, which is the point
// of that deduplication and would quietly halve every count here.
let seq = 0;
const strike = (snr = 15) => {
    seq++;
    const s = String(seq % 60).padStart(2, '0');
    return { time: `12:00:${s}.000`, snr_db: snr, duration_ms: 1.2, peak_amplitude: 0.4 };
};

function setup() {
    opened = [];
    seq = 0;
    clock = Date.UTC(2026, 7, 17, 12, 0, 0);
    Date.now = () => clock;
    global.EventSource = FakeES;
    global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    lx._resetLightning();
    lx._resetNotificationStore();
    lx.setFeedsAllowed(true);
}

function teardown() {
    lx._resetLightning();
    lx._resetNotificationStore();
    lx.setFeedsAllowed(false);
    Date.now = realNow;
    delete global.EventSource;
    delete global.fetch;
}

const withStore = (fn) => {
    setup();
    return Promise.resolve(fn()).finally(teardown);
};

const hit = (snr) => liveOnes()[0].emit('message', { data: JSON.stringify(strike(snr)) });
const history = () => lx.notificationState().history;

// ── Who holds the stream open ──────────────────────────────────────────────────

q('nothing is connected until something subscribes', () => withStore(() => {
    // With the notifications off and the panel closed, nobody is subscribed — and this is
    // the whole reason the store may live outside the panel without costing anything.
    assert.strictEqual(opened.length, 0);
}));

q('the last unsubscribe closes it, and two subscribers share one connection', () => withStore(async () => {
    const offA = lx.subscribeLightning(() => {});
    const offB = lx.subscribeLightning(() => {});
    await settle();
    assert.strictEqual(opened.length, 1, 'one connection, not one each');
    offA();
    assert.strictEqual(liveOnes().length, 1, 'still wanted by the other');
    offB();
    assert.strictEqual(liveOnes().length, 0, 'nobody left, so nothing open');
}));

// ── What it says ───────────────────────────────────────────────────────────────

q('one strike is not a storm, and says nothing', () => withStore(async () => {
    // The addon's own rule: an isolated impulse over the threshold is what a noisy site
    // produces now and then, and its storm sensor stays off for it. So does this.
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    for (let i = 0; i < lx.STORM_MIN_STRIKES - 1; i++) { clock += 60000; hit(45); }
    assert.strictEqual(history().length, 0);
    off();
}));

q('the strike that makes it a storm is the news', () => withStore(async () => {
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    for (let i = 0; i < 4; i++) { clock += 30000; hit(i === 1 ? 42 : 31); }
    assert.strictEqual(history().length, 0, 'four is not yet a storm');
    clock += 30000;
    hit(33);
    assert.strictEqual(history().length, 1);
    assert.strictEqual(history()[0].title, '⚡ Lightning detected');
    // 42 dB is the addon's own 'hi' band — close enough to be the reason somebody
    // switched this on — and it was one of the five, so it counts.
    assert.strictEqual(history()[0].severity, 'warn');
    assert.ok(history()[0].body.startsWith('5 strikes since 12:00:01'), history()[0].body);
    assert.ok(history()[0].body.includes('42 dB'), history()[0].body);
    off();
}));

q('five strikes spread over more than ten minutes are not a storm', () => withStore(async () => {
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    // Three minutes apart: never more than four inside any ten-minute window.
    for (let i = 0; i < 8; i++) { clock += 3 * 60000 + 1000; hit(30); }
    assert.strictEqual(history().length, 0);
    off();
}));

q('a storm is not one notification per strike', () => withStore(async () => {
    // The failure this exists to avoid: several a second, each a toast.
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    for (let i = 0; i < 40; i++) { clock += 500; hit(32); }
    assert.strictEqual(history().length, 1, 'the one that said it had started');
    off();
}));

q('while it continues, one line a minute with the count and the peak', () => withStore(async () => {
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    for (let i = 0; i < 5; i++) { clock += 1000; hit(30); }   // it began
    for (let i = 0; i < 5; i++) { clock += 1000; hit(i === 2 ? 44 : 29); }
    clock += 60000;
    hit(31);                                   // and now a minute has passed
    const [newest] = history();
    // Six: the count is strikes since it last said anything, and the five that made it
    // a storm have already been reported.
    assert.strictEqual(newest.title, '⚡ 6 strikes a minute');
    assert.ok(newest.body.includes('44 dB'), newest.body);
    assert.strictEqual(newest.severity, 'warn');
    // The line saying it began is still there — that a storm started at ten past is
    // worth being able to read at eleven.
    assert.strictEqual(history().length, 2);
    assert.strictEqual(history()[1].title, '⚡ Lightning detected');
    assert.strictEqual(history()[1].severity, 'info', 'nothing in the first five was hard');
    off();
}));

q('a long enough gap ends the storm, and the next one is a beginning again', () => withStore(async () => {
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    for (let i = 0; i < 5; i++) { clock += 1000; hit(30); }
    clock += lx.QUIET_MS + 1000;
    hit(30);
    assert.strictEqual(history().length, 1, 'one strike after the gap is not a new storm');
    assert.strictEqual(history()[0].count, 1);
    for (let i = 0; i < 4; i++) { clock += 1000; hit(30); }
    assert.strictEqual(history().length, 1, 'keyed, so the second replaces the first');
    assert.strictEqual(history()[0].title, '⚡ Lightning detected');
    assert.strictEqual(history()[0].count, 2, 'and carries a count rather than stacking');
    off();
}));

q('switched off it says nothing, and switching it on does not claim a storm just began',
    () => withStore(async () => {
        // The clock state moves whether or not anybody is listening. Otherwise the first
        // strikes after switching it on would be announced as the start of a storm that
        // has in fact been going for an hour.
        const off = lx.subscribeLightning(() => {});
        await settle();
        for (let i = 0; i < 6; i++) { clock += 1000; hit(30); }
        assert.strictEqual(history().length, 0);
        lx.setSourceEnabled('lightning', true);
        clock += 1000;
        hit(30);
        assert.strictEqual(history().length, 0, 'still mid-storm, and not yet a minute on');
        clock += lx.NOTICE_EVERY_MS;
        hit(30);
        assert.strictEqual(history().length, 1);
        // Three: the rate is over the last minute of weather, not over the part of it
        // somebody was listening for. What switching it on suppressed is the *claim that
        // a storm began*, which is the thing that would have been false.
        assert.strictEqual(history()[0].title, '⚡ 3 strikes a minute');
        off();
    }));

q('the addon\'s status reaches subscribers, and an old addon\'s does not', () => withStore(async () => {
    const reply = {
        detector: { state: 'running', mains_active: true },
        activity: { trend: 'overhead', strikes_last_hour: 9 },
    };
    global.fetch = (url) => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url.includes('/api/status') ? reply : []),
    });
    let snap = null;
    const off = lx.subscribeLightning((s) => { snap = s; });
    await settle(); await settle(); await settle();
    assert.ok(snap.status, 'a status arrived');
    assert.strictEqual(snap.status.trend, 'overhead');
    assert.strictEqual(snap.status.mains, true);
    off();
    assert.strictEqual(lx.lightningState().status, null, 'and it goes with the stream');
}));

q('a strike that arrives twice is one strike', () => withStore(async () => {
    // The backfill and the stream overlap by however long the first request took, so a
    // repeat is expected — and one counted twice is a rate that is wrong for an hour.
    lx.setSourceEnabled('lightning', true);
    const off = lx.subscribeLightning(() => {});
    await settle();
    const same = { ...strike(10), id: 'one-uuid' };
    liveOnes()[0].emit('message', { data: JSON.stringify(same) });
    liveOnes()[0].emit('message', { data: JSON.stringify(same) });
    assert.strictEqual(lx.lightningState().strikes.length, 1);
    off();
}));

chain.then(() => {
    if (process.exitCode) console.log('\nlightning stream tests FAILED');
    else console.log(`\nall ${pass} lightning stream tests passed`);
});
