// The timeshift buffer: what it keeps, where a replay lands on the context
// clock, which frames come out when, and that going back to live picks up the
// live queue where it was.
//
// All of it is timing, and timing mistakes here do not throw — they are a
// click at every block boundary, a waterfall a second out from its audio, or a
// return to live with a hole in it. So the clocks are faked and the answers
// asserted to the millisecond.

const assert = require('assert');

// The replay timer is driven by hand below.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const { Timeshift, resampleBins, tuningDiffers, TIMESHIFT_SEC, LIVE_EDGE_MS } = require('./.build/timeshift.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// performance.now() and ctx.currentTime, with the context clock 1000 ms behind
// the page's — so offset = 1000.
function rig() {
    const clock = { now: 5000 };
    const ctx = { currentTime: 4, state: 'running' };
    const played = [];
    const live = [];
    const player = {
        ctx, contextEpoch: 1, timeshift: null, halted: 0,
        playReplay(planes, frames, rate, when, offset) {
            const src = { stopped: false, stop() { this.stopped = true; } };
            played.push({ when, offset, frames, rate, first: planes[0][0], src });
            return src;
        },
        playLive(planes, frames, rate, when) { live.push({ when, first: planes[0][0] }); },
        haltLive() { this.halted++; },
    };
    const emitted = [];
    const spectrum = {
        timeshift: null, centerFreq: 1e6, binBandwidth: 100, binCount: 4,
        emit(ev, f) { if (ev === 'frame') emitted.push({ at: clock.now, bins: Array.from(f.bins), replay: f.replay }); },
    };
    const ts = new Timeshift({ now: () => clock.now });
    ts.attach(player, spectrum);
    ts.setEnabled(true);
    const advance = (ms) => { clock.now += ms; ctx.currentTime += ms / 1000; };
    // One 20 ms block at 1 kHz (20 frames) whose samples all read `v`, placed
    // by the live schedule `lead` s ahead of the context clock.
    const block = (v, startAt) => {
        ts.recordAudio([new Float32Array(20).fill(v)], 20, 1000, startAt, ctx, player.contextEpoch);
    };
    const frame = (v) => ts.recordFrame({ bins: new Float32Array(4).fill(v), frequency: 1e6 }, 100);
    return { clock, ctx, player, spectrum, ts, played, live, emitted, advance, block, frame };
}

// Ten seconds of live: a block every 20 ms scheduled 200 ms ahead, a frame
// every 100 ms. Block n's value is n, frame k's is k.
function fill(r, seconds = 10) {
    let next = r.ctx.currentTime + 0.2;
    let n = 0;
    for (let ms = 0; ms < seconds * 1000; ms += 20) {
        r.block(n++, next);
        next += 0.02;
        if (ms % 100 === 0) r.frame(ms / 100);
        r.advance(20);
    }
    return next;
}

t('resample: same view is a copy', () => {
    const out = new Float32Array(4);
    resampleBins(Float32Array.from([1, 2, 3, 4]), 1000, 10, out, 1000, 10);
    assert.deepStrictEqual(Array.from(out), [1, 2, 3, 4]);
});

t('resample: zoomed in 2x shows the middle bins doubled', () => {
    const out = new Float32Array(4);
    resampleBins(Float32Array.from([1, 2, 3, 4]), 1000, 10, out, 1000, 5);
    assert.deepStrictEqual(Array.from(out), [2, 2, 3, 3]);
});

t('resample: panned off the edge is drawn at the frame floor', () => {
    const out = new Float32Array(4);
    resampleBins(Float32Array.from([-90, -50, -60, -70]), 1000, 10, out, 1020, 10);
    assert.deepStrictEqual(Array.from(out), [-60, -70, -90, -90]);
});

t('stamps are when the live schedule plays the block', () => {
    const r = rig();
    r.block(7, 4.2);
    near(r.ts.audio[0].stamp, 5200, 1e-6, 'stamp');
    near(r.ts.audio[0].end, 5220, 1e-6, 'end');
});

t('history is held for thirty seconds and no longer', () => {
    const r = rig();
    fill(r, 40);
    const avail = r.ts.availableMs;
    assert.strictEqual(avail, TIMESHIFT_SEC * 1000);
    const oldest = r.clock.now - r.ts.frames[0].stamp;
    assert.ok(oldest <= (TIMESHIFT_SEC + 1) * 1000 && oldest > TIMESHIFT_SEC * 1000, `oldest ${oldest}`);
});

t('nothing is kept while disabled', () => {
    const r = rig();
    r.ts.setEnabled(false);
    fill(r, 1);
    assert.strictEqual(r.ts.audio.length, 0);
    assert.strictEqual(r.ts.frames.length, 0);
});

t('a seek within the live edge stays live', () => {
    const r = rig();
    fill(r, 5);
    r.ts.seekBehind(LIVE_EDGE_MS - 1);
    assert.strictEqual(r.ts.mode, 'live');
});

t('seek: the display jumps to that moment at once, and the live queue is halted', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(5000);
    assert.strictEqual(r.ts.mode, 'playing');
    assert.strictEqual(r.player.halted, 1);
    // Frames were every 100 ms from 5000; now is 15000, so 5 s behind is the
    // frame stamped 10000 — frame 50.
    assert.strictEqual(r.emitted[0].bins[0], 50);
    assert.ok(r.emitted[0].replay);
});

t('seek: audio lands contiguously, the first block partway in', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(5010);
    const p = r.played;
    assert.ok(p.length >= 15, `scheduled ${p.length}`);
    // 15000 - 5010 = 9990 ms is the moment chosen, and audio can start no
    // sooner than the 50 ms lead — by when the replay is at 10040. Block n
    // plays live at 5200 + 20n, so that is block 242 (10040..10060), from its
    // start.
    assert.strictEqual(p[0].first, 242);
    near(p[0].when, r.ctx.currentTime + 0.05, 1e-9, 'first starts at the lead');
    near(p[0].offset, 0, 1e-6, 'first offset');
    for (let i = 1; i < p.length; i++) {
        assert.strictEqual(p[i].first, p[i - 1].first + 1, 'in order');
        const prevEnd = p[i - 1].when + 0.02 - p[i - 1].offset;
        near(p[i].when, prevEnd, 1e-9, `block ${i} touches the one before`);
    }
    const last = p[p.length - 1];
    assert.ok(last.when <= r.ctx.currentTime + 0.35 + 1e-9, 'within the lookahead');
});

t('replay: frames come out at stamp + delay, one per due frame', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(5000);
    r.emitted.length = 0;
    for (let i = 0; i < 10; i++) { r.advance(50); r.ts._pump(); }
    // 500 ms of replay is five frames, 51..55.
    assert.deepStrictEqual(r.emitted.map((e) => e.bins[0]), [51, 52, 53, 54, 55]);
});

t('replay: blocks keep being scheduled as live blocks arrive', () => {
    const r = rig();
    let next = fill(r, 10);
    r.ts.seekBehind(5000);
    const before = r.played.length;
    for (let i = 0; i < 25; i++) { r.block(9000 + i, next); next += 0.02; r.advance(20); }
    assert.ok(r.played.length >= before + 24, 'topped up from the live arrivals');
    for (let i = 1; i < r.played.length; i++) {
        assert.strictEqual(r.played[i].first, r.played[i - 1].first + 1);
    }
});

t('pause stops the sources and holds the position', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(5000);
    const pos = r.ts.position;
    r.ts.pause();
    assert.ok(r.played.every((p) => p.src.stopped));
    r.advance(3000);
    near(r.ts.position, pos, 1e-9, 'held');
    near(r.ts.behindMs, 8000, 1e-9, 'falls behind');
    r.ts.play();
    near(r.ts.delayMs, 8000, 1e-9, 'plays on from where it stopped');
});

t('a pause longer than the buffer is held at the oldest moment', () => {
    const r = rig();
    let next = fill(r, 30);
    r.ts.pause();
    for (let ms = 0; ms < 20000; ms += 20) { r.block(0, next); next += 0.02; r.advance(20); }
    assert.ok(r.ts.behindMs <= TIMESHIFT_SEC * 1000 + 1e-6, `behind ${r.ts.behindMs}`);
});

t('back to live puts the live queue back where it was, with no gap', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(5000);
    r.ts.goLive();
    assert.strictEqual(r.ts.mode, 'live');
    assert.ok(r.played.every((p) => p.src.stopped), 'replay silenced');
    // The live schedule is 200 ms ahead: ten blocks are still to play.
    const t0 = r.ctx.currentTime;
    const ahead = r.live.map((l) => l.when).sort((a, b) => a - b);
    assert.ok(ahead.length >= 10 && ahead.length <= 11, `restored ${ahead.length}`);
    near(ahead[ahead.length - 1], t0 + 0.18, 1e-6, 'up to the end of the live queue');
});

t('skip forward past the end is live', () => {
    const r = rig();
    fill(r, 10);
    r.ts.seekBehind(4000);
    r.ts.skip(10000);
    assert.strictEqual(r.ts.mode, 'live');
});

t('skip back from live is a seek; to start is the oldest moment', () => {
    const r = rig();
    fill(r, 10);
    r.ts.skip(-3000);
    near(r.ts.behindMs, 3000, 1e-9, 'three seconds');
    r.ts.toStart();
    near(r.ts.behindMs, r.ts.availableMs, 1e-9, 'oldest');
});

t('levels: one value per bucket, -1 where nothing is held', () => {
    const r = rig();
    fill(r, 5);
    const lv = r.ts.levels(30);
    assert.strictEqual(lv.length, 30);
    assert.ok(lv[0] < 0, 'oldest bucket empty');
    assert.ok(lv[29] > 0, 'newest bucket has audio');
});

const USB = { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 };
const LSB = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };

t('tuning: a replay names what the moment playing was tuned to', () => {
    const r = rig();
    r.ts.noteTuning(USB);
    fill(r, 5);
    r.ts.noteTuning(LSB);
    fill(r, 5);
    assert.strictEqual(r.ts.replayTuning, null, 'nothing while live');
    r.ts.seekBehind(8000);
    assert.strictEqual(r.ts.replayTuning.frequency, USB.frequency, 'before the retune');
    r.ts.seekBehind(2000);
    assert.strictEqual(r.ts.replayTuning.frequency, LSB.frequency, 'after it');
});

t('tuning: the same tuning twice is one entry, and a passband change is a new one', () => {
    const r = rig();
    r.ts.noteTuning(USB);
    r.ts.noteTuning({ ...USB });
    assert.strictEqual(r.ts.tunings.length, 1);
    r.ts.noteTuning({ ...USB, bandwidthHigh: 3000 });
    assert.strictEqual(r.ts.tunings.length, 2);
    assert.ok(tuningDiffers(USB, { ...USB, mode: 'lsb' }));
    assert.ok(!tuningDiffers(USB, { ...USB }));
});

t('tuning: the one in force when the history starts survives the prune', () => {
    const r = rig();
    r.ts.noteTuning(USB);
    fill(r, 40);
    assert.strictEqual(r.ts.tunings.length, 1, 'kept although older than the history');
    r.ts.toStart();
    assert.strictEqual(r.ts.replayTuning.frequency, USB.frequency);
    r.ts.goLive();
    r.ts.noteTuning(LSB);
    fill(r, 40);
    assert.deepStrictEqual(r.ts.tunings.map((x) => x.frequency), [LSB.frequency], 'replaced one dropped');
});

t('tuning: kept while disabled, so a buffer started later knows its tuning', () => {
    const r = rig();
    r.ts.setEnabled(false);
    r.ts.noteTuning(USB);
    r.ts.noteTuning(LSB);
    assert.deepStrictEqual(r.ts.tunings.map((x) => x.frequency), [LSB.frequency]);
    r.ts.setEnabled(true);
    fill(r, 5);
    r.ts.seekBehind(3000);
    assert.strictEqual(r.ts.replayTuning.frequency, LSB.frequency);
});

t('tuning: placed when it is heard, by the capture time of the audio', () => {
    // The receiver's clock is this page's plus 5 s, the uplink 30 ms. Audio is
    // captured 100 ms before it arrives and plays 200 ms after that.
    const clock = { now: 5000 };
    const ctx = { currentTime: 4, state: 'running' };
    const ts = new Timeshift({ now: () => clock.now, clock: () => ({ theta: 5000, err: 30 }) });
    ts.attach({ ctx, contextEpoch: 1, queuedSec: 0.2, playLive() {}, haltLive() {} }, null);
    ts.setEnabled(true);
    let next = ctx.currentTime + 0.2;
    const tick = () => {
        ts.recordAudio([new Float32Array(20)], 20, 1000, next, ctx, 1, clock.now + 5000 - 100);
        next += 0.02;
        clock.now += 20; ctx.currentTime += 0.02;
    };
    for (let i = 0; i < 50; i++) tick();
    ts.noteTuning(USB);
    for (let i = 0; i < 50; i++) tick();
    const asked = clock.now;
    ts.noteTuning(LSB);
    const x = ts.tunings[ts.tunings.length - 1];
    near(x.stamp, asked + 200, 1e-6, 'provisional: now plus the queue');
    for (let i = 0; i < 50; i++) tick();
    // Up 30 ms, then 100 ms down and 200 ms in the queue.
    near(x.stamp, asked + 30 + 100 + 200, 1e-6, 'placed at the sample it is heard from');
    assert.strictEqual(x.heardFrom, null);
});

t('tuning: a quick spin of the dial never goes out of order', () => {
    const clock = { now: 5000 };
    const ctx = { currentTime: 4, state: 'running' };
    const ts = new Timeshift({ now: () => clock.now, clock: () => ({ theta: 0, err: 30 }) });
    ts.attach({ ctx, contextEpoch: 1, queuedSec: 0, playLive() {}, haltLive() {} }, null);
    ts.setEnabled(true);
    let next = ctx.currentTime + 0.2;
    const tick = () => {
        ts.recordAudio([new Float32Array(20)], 20, 1000, next, ctx, 1, clock.now - 100);
        next += 0.02;
        clock.now += 20; ctx.currentTime += 0.02;
    };
    for (let i = 0; i < 20; i++) {
        ts.noteTuning({ ...USB, frequency: USB.frequency + i * 10 });
        tick();
    }
    for (let i = 0; i < 50; i++) tick();
    for (let i = 1; i < ts.tunings.length; i++) {
        assert.ok(ts.tunings[i].stamp >= ts.tunings[i - 1].stamp, `entry ${i} before ${i - 1}`);
    }
    assert.ok(ts.tunings.every((x) => x.heardFrom === null), 'all placed');
});

t('tuning: no clock estimate yet is now plus the queue, and stays that', () => {
    const r = rig();
    r.player.queuedSec = 0.15;
    r.ts.clock = () => null;
    r.ts.noteTuning(USB);
    fill(r, 1);
    near(r.ts.tunings[0].stamp, 5150, 1e-6, 'provisional kept');
});

console.log(`\n${pass} passed`);
