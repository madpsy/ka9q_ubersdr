// Time stamps down the waterfall: when a mark is made, and where it sits.
//
// Quiet to get wrong: a mark counted from the wrong row still draws a plausible
// clock reading, just against the wrong part of the history.

const assert = require('assert');
const {
    MIN_GAP_CSS, STEPS_S, agoLabel, createTimeMarks, clearTimeMarks, timeMarkLabel, markY, noteRows, stepFor,
} = require('./.build/waterfalltimes.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Feed `secs` of rows at `rate` rows/s, `rowH` device rows each, from wall time t0.
function feed(tm, { rate, rowH = 2, dpr = 1, secs, t0 = Date.UTC(2026, 9, 31, 12, 0, 3), at0 = 1000 }) {
    const dt = 1000 / rate;
    const n = Math.round(secs * rate);
    for (let i = 0; i < n; i++) noteRows(tm, rowH, t0 + i * dt, at0 + i * dt, dpr);
    return tm;
}

t('step leaves at least MIN_GAP_CSS between labels', () => {
    for (const rows of [2, 10, 40, 80]) {
        for (const dpr of [1, 2]) {
            const s = stepFor(rows, dpr);
            assert.ok(s * rows / dpr >= MIN_GAP_CSS || s === STEPS_S[STEPS_S.length - 1], `${rows}/${dpr}`);
        }
    }
    assert.strictEqual(stepFor(40, 1), 5);    // 20 rows/s at 2 px: 200 css px per 5 s
    assert.strictEqual(stepFor(4, 1), 20);    // 2 rows/s at 2 px: 80 css px per 20 s
});

t('marks land on interval boundaries, spaced by the step', () => {
    const tm = feed(createTimeMarks(), { rate: 20, secs: 60 });
    assert.ok(tm.marks.length >= 10, `${tm.marks.length} marks`);
    for (const m of tm.marks) assert.strictEqual(m.t % m.step, 0);
    for (let i = 1; i < tm.marks.length; i++) {
        const gap = (tm.marks[i].row - tm.marks[i - 1].row);
        assert.ok(gap >= MIN_GAP_CSS, `gap ${gap}`);
    }
});

t('a mark sits as many rows down as have been written since', () => {
    const tm = feed(createTimeMarks(), { rate: 20, secs: 30 });
    const last = tm.marks[tm.marks.length - 1];
    const before = markY(tm, last);
    noteRows(tm, 2, tm.lastT + 50, tm.lastAt + 50, 1);
    assert.strictEqual(markY(tm, last), before + 2);
});

t('UTC labels carry Z, and seconds only when the step needs them', () => {
    assert.strictEqual(timeMarkLabel({ t: Date.UTC(2026, 0, 1, 9, 5, 30), step: 30000 }, 'utc'), '09:05:30Z');
    assert.strictEqual(timeMarkLabel({ t: Date.UTC(2026, 0, 1, 9, 5, 0), step: 60000 }, 'utc'), '09:05Z');
});

t('the receiver zone is read from its IANA name, DST included', () => {
    const rx = { timezone: 'America/New_York', timezone_offset: -300 };
    // July: EDT, UTC-4 — the name wins over the stale offset.
    assert.strictEqual(timeMarkLabel({ t: Date.UTC(2026, 6, 1, 12, 0, 0), step: 60000 }, 'rx', rx), '08:00');
    assert.strictEqual(timeMarkLabel({ t: Date.UTC(2026, 0, 1, 12, 0, 0), step: 60000 }, 'rx', rx), '07:00');
});

t('a receiver with only an offset uses it; one with neither reads as UTC', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.strictEqual(timeMarkLabel({ t: t0, step: 60000 }, 'rx', { timezone_offset: 330 }), '17:30');
    assert.strictEqual(timeMarkLabel({ t: t0, step: 60000 }, 'rx', {}), '12:00Z');
    assert.strictEqual(timeMarkLabel({ t: t0, step: 60000 }, 'rx', null), '12:00Z');
});

t('"me" follows this machine\'s zone, with no suffix', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const d = new Date(t0);
    const want = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.strictEqual(timeMarkLabel({ t: t0, step: 60000 }, 'me'), want);
});

t('"ago" counts back from the newest row, in whole units', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.strictEqual(timeMarkLabel({ t: t0, step: 5000 }, 'ago', null, t0 + 37400), '37s ago');
    assert.strictEqual(timeMarkLabel({ t: t0, step: 60000 }, 'ago', null, t0 + 125000), '2m05s ago');
    assert.strictEqual(agoLabel(120000), '2m ago');
    assert.strictEqual(agoLabel(3600000 + 7 * 60000), '1h07m ago');
    assert.strictEqual(agoLabel(7200000), '2h ago');
    assert.strictEqual(agoLabel(-500), '0s ago');
});

t('"ago" is the age at the last draw, a replay\'s delay included', () => {
    // A replayed row 20 s behind live is 20 s old, as the Timeshift panel says.
    // Counted from the newest row instead, the live rows further down — newer
    // than the replay above them — would all clamp to "0s ago".
    const lag = 20000;
    const t0 = Date.UTC(2026, 0, 1, 11, 0, 3);
    const tm = createTimeMarks();
    for (let i = 0; i < 600; i++) noteRows(tm, 2, t0 + i * 50 - lag, 1000 + i * 50, 1, t0 + i * 50);
    const last = tm.marks[tm.marks.length - 1];
    const c = { save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fillText() {}, measureText: (s) => ({ width: s.length * 6 }) };
    const { drawTimeMarks } = require('./.build/waterfalltimes.cjs');
    drawTimeMarks(c, tm, 10000, 1, { zone: 'ago' });
    assert.strictEqual(last.label, agoLabel(tm.liveT - last.t));
    assert.ok(tm.liveT - last.t >= lag, last.label);
});

t('a jump forward (going live, skipping ahead) stamps no stale boundary', () => {
    // Replay at 12:00:03.x, then live at 12:00:27: the 12:00:25 boundary was
    // crossed in time that was never drawn, and this row is 2 s past it.
    const tm = feed(createTimeMarks(), { rate: 20, secs: 0.5 });
    const n = tm.marks.length;
    noteRows(tm, 2, Date.UTC(2026, 9, 31, 12, 0, 27), tm.lastAt + 50, 1);
    assert.strictEqual(tm.marks.length, n);
    // ...and rows from there on mark the next boundary normally.
    const t1 = tm.lastT;
    for (let i = 1; i <= 80; i++) noteRows(tm, 2, t1 + i * 50, tm.lastAt + 50, 1);
    const last = tm.marks[tm.marks.length - 1];
    assert.strictEqual(last.t, Date.UTC(2026, 9, 31, 12, 0, 30));
});

t('a mark after a pause lands where the history resumes', () => {
    // Paused at 12:00:09.9, resumed a minute later: the picture carries on from
    // where it stopped, so the 12:00:10 boundary belongs on the next row.
    const tm = feed(createTimeMarks(), { rate: 20, secs: 6.95 });
    noteRows(tm, 2, tm.lastT + 150, tm.lastAt + 60000, 1);
    const last = tm.marks[tm.marks.length - 1];
    assert.strictEqual(last.t, Date.UTC(2026, 9, 31, 12, 0, 10));
    assert.strictEqual(markY(tm, last), 0);
});

t('a row is stamped with the position on screen, paused or playing', () => {
    const { rowWallTime } = require('./.build/waterfalltimes.cjs');
    const now = 1e12;
    assert.strictEqual(rowWallTime(null, now), now);
    assert.strictEqual(rowWallTime({ replaying: false, behindMs: 0, delayMs: 0 }, now), now);
    assert.strictEqual(rowWallTime({ replaying: true, behindMs: 8000, delayMs: 8000 }, now), now - 8000);
    // Paused at live, then skipped back 10 s: delayMs is still 0.
    assert.strictEqual(rowWallTime({ replaying: true, behindMs: 10000, delayMs: 0 }, now), now - 10000);
});

t('a clock that goes backwards (replay) makes no mark', () => {
    const tm = feed(createTimeMarks(), { rate: 20, secs: 20 });
    const n = tm.marks.length;
    noteRows(tm, 2, tm.lastT - 60000, tm.lastAt + 50, 1);
    assert.strictEqual(tm.marks.length, n);
});

t('clearing forgets the marks', () => {
    const tm = feed(createTimeMarks(), { rate: 20, secs: 20 });
    clearTimeMarks(tm);
    assert.strictEqual(tm.marks.length, 0);
});

console.log(`\n${pass} passed`);
