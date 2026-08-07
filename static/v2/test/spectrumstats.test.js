// The stats readout over the waterfall.
//
// A diagnostic that is itself wrong is worse than no diagnostic, and the ways
// this one could be wrong are all arithmetic: a rate invented from a counter's
// absolute value on the first tick, a total that does not match its parts, a
// figure shown as 0 when it is really unknown. None of that is visible by looking
// at the overlay — every one of them produces a plausible number.

const assert = require('assert');
const {
    STATS_PLACES, formatThroughput, perSecond, statLines, statsPlace,
} = require('./.build/spectrumstats.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const find = (lines, key) => lines.find((l) => l.key === key);
const value = (lines, key) => (find(lines, key) || {}).value;

// --- where it sits ------------------------------------------------------------

t('an unset or unknown placement is off', () => {
    // A stored value from another build must not resolve to a corner nobody
    // chose — the overlay is off by default and stays off unless asked for.
    assert.strictEqual(statsPlace(undefined), 'off');
    assert.strictEqual(statsPlace(null), 'off');
    assert.strictEqual(statsPlace('middle'), 'off');
    assert.strictEqual(statsPlace(true), 'off');
    for (const p of STATS_PLACES) assert.strictEqual(statsPlace(p), p);
});

// --- rates ---------------------------------------------------------------------

t('a rate needs two readings and an interval', () => {
    assert.strictEqual(perSecond(12, 1000), 12);
    assert.strictEqual(perSecond(6, 500), 12);
    // No interval, no rate. Returning 0 here would draw "0 fps" on the first tick
    // of every session, which reads as a stalled display rather than as one that
    // has not been measured yet.
    assert.strictEqual(perSecond(12, 0), null);
    assert.strictEqual(perSecond(12, -1), null);
});

t('a counter that went backwards is not a rate', () => {
    // Reconnects reset the counters on the connection object. A negative delta is
    // that, not a negative data rate.
    assert.strictEqual(perSecond(-40, 1000), null);
    assert.strictEqual(perSecond(NaN, 1000), null);
});

// --- throughput ----------------------------------------------------------------

t('the two streams and their total share one unit', () => {
    // Comparing the halves by eye is the point of the line, and two numbers in
    // different units on one line cannot be compared by eye.
    assert.strictEqual(formatThroughput(42 * 1024, 6.2 * 1024), '42 + 6.2 = 48 kB/s');
});

t('the parts always add up to the total shown', () => {
    // The one thing a reader will check, and the thing rounding each part
    // independently would break.
    for (const [spec, audio] of [[1000, 24], [40000, 6000], [3e6, 12000], [0, 5000]]) {
        const out = formatThroughput(spec, audio);
        const nums = out.match(/[\d.]+/g).map(Number);
        assert.strictEqual(nums.length, 3, out);
        // To the precision printed: 42 + 6.2 = 48.2 shows as 48.
        assert.ok(Math.abs((nums[0] + nums[1]) - nums[2]) <= 1, out);
    }
});

t('a small stream beside a large one still reads as a number', () => {
    // Audio is a few kB/s against a spectrum in the hundreds. Rounded to whole
    // units in the total's scale it would show as 0 and read as "the audio has
    // stopped", which is exactly the fault somebody turns this overlay on to find.
    const out = formatThroughput(200 * 1024, 6 * 1024);
    const audio = out.match(/[\d.]+/g)[1];
    assert.strictEqual(audio, '6.0', out);
    assert.notStrictEqual(Number(audio), 0);
});

t('the unit follows the total', () => {
    assert.ok(formatThroughput(300, 200).endsWith('B/s'));
    assert.ok(formatThroughput(300 * 1024, 20 * 1024).endsWith('kB/s'));
    assert.ok(formatThroughput(4 * 1024 * 1024, 1024).endsWith('MB/s'));
});

t('one stream unmeasured is not counted as zero', () => {
    // A socket that has never opened is unknown, not idle: summing it as 0 would
    // report a total that is quietly missing half the session.
    assert.strictEqual(formatThroughput(10240, null), '10 kB/s');
    assert.strictEqual(formatThroughput(null, 10240), '10 kB/s');
    assert.strictEqual(formatThroughput(null, null), null);
    assert.strictEqual(formatThroughput(NaN, undefined), null);
});

// --- the lines ------------------------------------------------------------------

t('a figure that is not known yet is left out, not shown as a dash', () => {
    // Everything is optional: this renders while the receiver is starting, between
    // reconnects, and on a browser that reports no output latency.
    assert.deepStrictEqual(statLines({}), []);
    assert.deepStrictEqual(statLines(), []);
});

t('a full sample produces the whole readout', () => {
    const lines = statLines({
        fps: 59.4,
        framesIn: 12.4,
        rows: 12.4,
        bytesIn: 42 * 1024,
        audioBytes: 6 * 1024,
        binCount: 1024,
        binHz: 7.324,
        divisor: 1,
        queuedSec: 0.18,
        outLatSec: 0.02,
        underruns: 0,
    });
    // The browser's frame rate, not the feed's. Counting drawn frames instead
    // would put the same 12 here that FEED already says.
    assert.strictEqual(value(lines, 'fps'), '59');
    // Whole frames per second above ten, as with the FPS above it: the decimal on
    // a feed rate changes every tick and says nothing the integer does not.
    assert.strictEqual(value(lines, 'feed'), '12/s');
    // Rows keeping up with the feed: nothing is holding the picture back, so the
    // line would be the feed rate written out twice.
    assert.strictEqual(find(lines, 'rows'), undefined);
    assert.strictEqual(value(lines, 'fft'), '1024 bins  7.3 Hz');
    assert.strictEqual(value(lines, 'net'), '42 + 6.0 = 48 kB/s');
    // Queue plus hardware: 180 + 20. Reporting only the half this client controls
    // would be a latency figure that is always wrong in the same direction.
    assert.strictEqual(value(lines, 'audio'), '200 ms');
    // Every line carries a key and a label the overlay can lay out in a column.
    for (const l of lines) {
        assert.ok(l.key && l.label && l.value, JSON.stringify(l));
    }
});

t('rows are shown only when something is holding them back', () => {
    // The complaint that produced this rule: FPS, FEED and ROWS all reading the
    // same number, which is three lines saying one thing. Rows are committed as
    // frames arrive unless the Display panel's waterfall rate is set below the
    // feed — a deliberately slow scroll — and that is the only case worth a line.
    assert.strictEqual(find(statLines({ framesIn: 14, rows: 14 }), 'rows'), undefined);
    // Sampling noise between two counters read a moment apart is not a cap.
    assert.strictEqual(find(statLines({ framesIn: 14, rows: 13.5 }), 'rows'), undefined);
    // Held at 5 rows a second against a 14/s feed: two thirds of the frames
    // arriving are never shown, which is worth knowing.
    assert.strictEqual(value(statLines({ framesIn: 14, rows: 5 }), 'rows'), '5.0/s');
    // No feed to compare against — between reconnects — claims nothing either way.
    assert.strictEqual(find(statLines({ rows: 5 }), 'rows'), undefined);
});

t('the poll divisor is shown only when it is not 1', () => {
    // At full rate that line would say "the receiver is behaving normally" in a
    // corner meant for things that are not.
    assert.strictEqual(find(statLines({ divisor: 1, fps: 20 }), 'poll'), undefined);
    assert.strictEqual(find(statLines({ divisor: 0, fps: 20 }), 'poll'), undefined);
    assert.strictEqual(value(statLines({ divisor: 2, fps: 20 }), 'poll'), '1/2');
});

t('dropouts appear beside the latency, and only when there have been some', () => {
    assert.strictEqual(value(statLines({ queuedSec: 0.2, underruns: 0 }), 'audio'), '200 ms');
    assert.strictEqual(value(statLines({ queuedSec: 0.2, underruns: 1 }), 'audio'), '200 ms  1 drop');
    assert.strictEqual(value(statLines({ queuedSec: 0.2, underruns: 4 }), 'audio'), '200 ms  4 drops');
});

t('silence is not a latency of zero', () => {
    // Nothing playing means there is no queue to measure, which is not the same as
    // audio arriving instantly.
    assert.strictEqual(find(statLines({ fps: 20 }), 'audio'), undefined);
    assert.strictEqual(find(statLines({ queuedSec: 0, outLatSec: 0 }), 'audio'), undefined);
});

t('rates read to one decimal only while they are small', () => {
    // "8.3 fps" is a reading; "23.7" is three characters of noise on a number that
    // moves every second.
    assert.strictEqual(value(statLines({ fps: 8.34 }), 'fps'), '8.3');
    assert.strictEqual(value(statLines({ fps: 23.7 }), 'fps'), '24');
});

t('a receiver still negotiating its geometry shows no FFT line', () => {
    assert.strictEqual(find(statLines({ binCount: 0, binHz: 0 }), 'fft'), undefined);
    assert.strictEqual(value(statLines({ binCount: 2048, binHz: 0.5 }), 'fft'), '2048 bins  0.50 Hz');
});

console.log(`\n${pass} ok`);
