// Waterfall time stamps against a real timeshift: every mark has to name the
// moment of the frame drawn on the row it sits on, through rewinds, pauses,
// skips while paused, skips forward and the return to live.
//
// The per-function tests in waterfalltimes.test.js check each rule. This one
// checks the invariant the operator actually reads — the label against the
// picture — by driving lib/timeshift.js exactly as the waterfall does: frames
// arrive, the timeshift decides what is emitted, every emitted frame becomes a
// row stamped through rowWallTime, and the marks are compared with the stamp of
// the frame each one was put on. Clocks are faked, so a mistake is a number,
// not a flake.

const assert = require('assert');

// The replay timer is driven by hand below.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const { Timeshift } = require('./.build/timeshift.cjs');
const {
    agoLabel, createTimeMarks, drawTimeMarks, noteRows, rowWallTime,
} = require('./.build/waterfalltimes.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// performance.now() and Date.now(), one fixed distance apart. 12:00:03.250 UTC
// at perf 0, so boundaries do not line up with frame times.
const WALL0 = Date.UTC(2026, 9, 31, 12, 0, 3, 250);
const FRAME_MS = 50;       // 20 frames a second
const ROW_H = 2;           // device rows per frame, dpr 1 — 40 rows/s, 5 s step
// A mark is right if it is on the first row at or after its boundary: one
// frame's time, and a tick of slack for the replay pump.
const TOL_MS = FRAME_MS + 20;

function rig() {
    let pnow = 1000;
    // Date.now too, so nothing on the way reads a clock the test is not driving.
    Date.now = () => WALL0 + pnow;
    const emitted = [];
    const spectrum = {
        timeshift: null, centerFreq: 1e6, binBandwidth: 100, binCount: 4,
        emit(ev, f) { if (ev === 'frame') emitted.push(f.timestamp); },
    };
    const ts = new Timeshift({ now: () => pnow });
    ts.attach(null, spectrum);
    ts.setEnabled(true);

    const tm = createTimeMarks();
    // tm.rows after each committed row -> the perf stamp of the frame drawn.
    const truth = new Map();
    const checked = new Set();
    const errors = [];
    let lastFrameAt = -Infinity;
    const counts = {};
    let phase = 'start';

    // The waterfall's half of a draw: whatever frames were emitted since the
    // last one become one row (the newest wins, as rowsPending does).
    function draw() {
        if (!emitted.length) return;
        const stamp = emitted[emitted.length - 1];
        emitted.length = 0;
        const wall = WALL0 + pnow;
        const before = tm.marks.length;
        noteRows(tm, ROW_H, rowWallTime(ts, wall), pnow, 1, wall);
        truth.set(tm.rows, stamp);
        if (tm.marks.length > before) counts[phase] = (counts[phase] || 0) + 1;
        for (const mk of tm.marks) {
            if (checked.has(mk)) continue;
            checked.add(mk);
            const frameWall = WALL0 + truth.get(mk.row);
            const err = frameWall - mk.t;
            if (err < 0 || err > TOL_MS) {
                errors.push(`${phase}: mark ${new Date(mk.t).toISOString()} on a row showing `
                    + `${new Date(frameWall).toISOString()} (${err} ms)`);
            }
        }
    }

    // Advance by `ms`, a live frame every FRAME_MS and a pump and draw every
    // 10 ms, as the page would.
    function run(ms) {
        const end = pnow + ms;
        while (pnow < end) {
            pnow += 10;
            if (pnow - lastFrameAt >= FRAME_MS) {
                lastFrameAt = pnow;
                ts.recordFrame({ bins: new Float32Array(4), frequency: 1e6 }, 100);
                // spectrum-connection _deliver: kept always, shown only live.
                if (!ts.replaying) emitted.push(pnow);
            }
            ts._pump();
            draw();
        }
    }
    // A transport action, then the draw that follows it.
    const act = (name, fn) => { phase = name; fn(); draw(); };

    return { ts, tm, run, act, errors, counts, truth, now: () => pnow, setPhase: (p) => { phase = p; } };
}

t('every mark names the frame on its row, across a whole timeshift session', () => {
    const r = rig();
    r.setPhase('live'); r.run(40000);
    r.act('rewind 20 s', () => r.ts.seekBehind(20000)); r.run(12000);
    r.act('pause', () => r.ts.pause()); r.run(5000);
    // Skips while paused: each one shows one frame and nothing else moves.
    for (let i = 0; i < 4; i++) { r.act(`paused skip back ${i}`, () => r.ts.skip(-3000)); r.run(700); }
    r.act('play', () => r.ts.play()); r.run(8000);
    r.act('skip forward 10 s', () => r.ts.skip(10000)); r.run(6000);
    r.act('back to start', () => r.ts.toStart()); r.run(7000);
    r.act('go live', () => r.ts.goLive()); r.run(15000);

    assert.deepStrictEqual(r.errors, []);
    // Not vacuous: the replay and the return to live both made marks.
    assert.ok(r.counts.live >= 7, `live marks ${r.counts.live}`);
    assert.ok(r.counts['rewind 20 s'] >= 2, `replay marks ${r.counts['rewind 20 s']}`);
    assert.ok(r.counts.play >= 1, `marks after resume ${r.counts.play}`);
    assert.ok(r.counts['go live'] >= 2, `marks after live ${r.counts['go live']}`);
});

t('a skip while paused stamps the row with the moment shown', () => {
    // Paused straight from live (delayMs 0), then skipped back: the row shows
    // a frame from seconds ago and must say so.
    const r = rig();
    r.run(35000);
    r.act('pause', () => r.ts.pause());
    r.act('skip', () => r.ts.skip(-8000));
    near(r.tm.lastT, WALL0 + r.truth.get(r.tm.rows), FRAME_MS, 'row time vs frame');
    assert.ok(r.now() + WALL0 - r.tm.lastT >= 8000 - FRAME_MS, 'row reads as 8 s behind');
});

t('"ago" reads each mark\'s real age, replayed or live', () => {
    const r = rig();
    r.run(40000);
    r.act('rewind', () => r.ts.seekBehind(20000));
    r.run(10000);
    const c = { save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fillText() {}, measureText: (s) => ({ width: s.length * 6 }) };
    drawTimeMarks(c, r.tm, 1e6, 1, { zone: 'ago', limit: 1e6 });
    const wall = WALL0 + r.now();
    let replayed = 0;
    for (const mk of r.tm.marks) {
        const frameWall = WALL0 + r.truth.get(mk.row);
        // The label, against how long ago the row's frame really was.
        const shown = Math.round((wall - mk.t) / 1000);
        const real = (wall - frameWall) / 1000;
        assert.ok(Math.abs(shown - real) <= 1, `${mk.label} for a row ${real.toFixed(2)} s old`);
        assert.strictEqual(mk.label, agoLabel(wall - mk.t));
        if (mk.row > r.tm.rows - 10000 / FRAME_MS * ROW_H) replayed++;
    }
    assert.ok(replayed >= 1, 'a replayed mark was checked');
    // The live marks below the replay are newer than it — none may clamp to 0.
    assert.ok(r.tm.marks.every((mk) => mk.label !== '0s ago'), r.tm.marks.map((m) => m.label).join(', '));
});

function near(a, b, eps, msg) {
    assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
}

console.log(`\n${pass} passed`);
