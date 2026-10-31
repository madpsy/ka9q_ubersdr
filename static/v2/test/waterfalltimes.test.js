// Time stamps down the waterfall: when a mark is made, and where it sits.
//
// Quiet to get wrong: a mark counted from the wrong row still draws a plausible
// clock reading, just against the wrong part of the history.

const assert = require('assert');
const {
    MIN_GAP_CSS, STEPS_S, createTimeMarks, clearTimeMarks, timeMarkLabel, markY, noteRows, stepFor,
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
