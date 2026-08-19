// The stats readout over the waterfall.
//
// A diagnostic that is itself wrong is worse than no diagnostic, and the ways
// this one could be wrong are all arithmetic: a rate invented from a counter's
// absolute value on the first tick, a total that does not match its parts, a
// figure shown as 0 when it is really unknown. None of that is visible by looking
// at the overlay — every one of them produces a plausible number.

const assert = require('assert');
const {
    STATS_DEFAULT_DESKTOP, STATS_DEFAULT_MOBILE, STATS_PLACES,
    formatThroughput, perSecond, statLines, statsPlace,
} = require('./.build/spectrumstats.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const find = (lines, key) => lines.find((l) => l.key === key);
const value = (lines, key) => (find(lines, key) || {}).value;

// --- where it sits ------------------------------------------------------------

t('unset takes the device default: a corner on a desktop, nothing on a phone', () => {
    assert.strictEqual(STATS_DEFAULT_DESKTOP, 'left');
    assert.strictEqual(STATS_DEFAULT_MOBILE, 'off');
    assert.strictEqual(statsPlace(null, false), 'left');
    assert.strictEqual(statsPlace(null, true), 'off');
    assert.strictEqual(statsPlace(undefined, false), 'left');
    // Both defaults have to be offerable, or the control could not show what is
    // running.
    assert.ok(STATS_PLACES.includes(STATS_DEFAULT_DESKTOP));
    assert.ok(STATS_PLACES.includes(STATS_DEFAULT_MOBILE));
});

t('a stored value from another build is not a corner nobody chose', () => {
    assert.strictEqual(statsPlace('middle', false), 'left');
    assert.strictEqual(statsPlace('middle', true), 'off');
    assert.strictEqual(statsPlace(true, false), 'left');
    assert.strictEqual(statsPlace(0, true), 'off');
});

t('a chosen corner is the same on either device, and off is a choice', () => {
    for (const p of STATS_PLACES) {
        assert.strictEqual(statsPlace(p, true), p);
        assert.strictEqual(statsPlace(p, false), p);
    }
    // The trap the idle delays have too: 'off' chosen on a desktop must not read
    // as unset and come back as 'left' on the next load.
    assert.strictEqual(statsPlace('off', false), 'off');
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
    assert.strictEqual(formatThroughput(42 * 1024, 6.2 * 1024), '42 + 6 = 48 kB/s');
});

t('the parts always add up to the total shown', () => {
    // The one thing a reader will check, and the thing rounding each part
    // independently would break.
    for (const streams of [
        [1000, 24], [40000, 6000], [3e6, 12000], [0, 5000], [40000, 6000, 3000],
    ]) {
        const out = formatThroughput(...streams);
        const nums = out.match(/[\d.]+/g).map(Number);
        const total = nums.pop();
        assert.strictEqual(nums.length, streams.length, out);
        // To the precision printed, which is whole units: each part can be half
        // a unit out, so the drift allowed grows with the number of parts.
        const slack = streams.length / 2 + 0.5;
        assert.ok(Math.abs(nums.reduce((a, b) => a + b, 0) - total) <= slack, out);
    }
});

t('a small stream beside a large one still reads as a number', () => {
    // Audio is a few kB/s against a spectrum in the hundreds, and it has to stay
    // legible as a rate rather than rounding away to "0" — which would read as a
    // stream that had stopped, exactly the fault somebody turns this overlay on
    // to find. Whole units are enough for that at the kB/s scale a session runs
    // at; it is only in MB/s that a part can vanish, and a spectrum moving at
    // megabytes a second has a different problem.
    const out = formatThroughput(200 * 1024, 6 * 1024);
    const audio = out.match(/[\d.]+/g)[1];
    assert.strictEqual(audio, '6', out);
    assert.notStrictEqual(Number(audio), 0);
});

t('a third stream joins the line when the band panel is open', () => {
    // It comes and goes: that stream exists only while the panel is, and the
    // panel is unmounted whenever its section is collapsed.
    assert.strictEqual(
        formatThroughput(41 * 1024, 6.2 * 1024, 3.1 * 1024),
        '41 + 6 + 3 = 50 kB/s',
    );
    // Absent, it is left out rather than added as a zero — "+ 0" reads as a
    // stream that has stalled, which is a different and more alarming thing.
    assert.strictEqual(formatThroughput(41 * 1024, 6.2 * 1024, null), '41 + 6 = 47 kB/s');
    assert.strictEqual(formatThroughput(41 * 1024, 6.2 * 1024), '41 + 6 = 47 kB/s');
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
    assert.strictEqual(find(lines, 'rows'), undefined, 'no rows line exists any more');
    assert.strictEqual(value(lines, 'fft'), '1024 bins  7.3 Hz');
    assert.strictEqual(value(lines, 'net'), '42 + 6 = 48 kB/s');
    // Queue plus hardware: 180 + 20. Reporting only the half this client controls
    // would be a latency figure that is always wrong in the same direction.
    assert.strictEqual(value(lines, 'audio'), '200 ms');
    // Every line carries a key and a label the overlay can lay out in a column.
    for (const l of lines) {
        assert.ok(l.key && l.label && l.value, JSON.stringify(l));
    }
});

t('there is no committed-rows line, whatever it is told', () => {
    // Tried, and taken out. Rows are committed as frames arrive, so it read as the
    // feed rate twice; shown only when it fell below the feed, it blinked in and
    // out on every zoom — a view change brings a catch-up burst that outruns the
    // waterfall rate for exactly one sample.
    for (const rows of [0, 5, 14, 40]) {
        assert.strictEqual(find(statLines({ framesIn: 14, fps: 60, rows }), 'rows'), undefined);
    }
});

t('the listener count is shown when there is one, and only then', () => {
    // Yours is always in the list, so nought is a poll that has not landed rather
    // than an empty receiver — and "USERS 0" on a display you are looking at is a
    // statement that cannot be true.
    assert.strictEqual(value(statLines({ listeners: 7 }), 'users'), '7');
    assert.strictEqual(value(statLines({ listeners: 1 }), 'users'), '1');
    // How many of them are in chat, in brackets.
    assert.strictEqual(value(statLines({ listeners: 7, chatUsers: 3 }), 'users'), '7 (3)');
    // No bracket for nought, because two different things produce it — an empty
    // room, and no chat socket at all, which is what a hidden Chat panel means.
    // A bracket that appeared when that panel was opened would be reporting the
    // panel rather than the receiver.
    assert.strictEqual(value(statLines({ listeners: 7, chatUsers: 0 }), 'users'), '7');
    assert.strictEqual(value(statLines({ listeners: 7 }), 'users'), '7');
    // And chat without a listener count is not a line of its own: the bracket
    // qualifies a number that has to be there first.
    assert.strictEqual(find(statLines({ chatUsers: 3 }), 'users'), undefined);
    assert.strictEqual(find(statLines({ listeners: 0 }), 'users'), undefined);
    assert.strictEqual(find(statLines({ listeners: null }), 'users'), undefined);
    assert.strictEqual(find(statLines({ fps: 60 }), 'users'), undefined);
});

t('the address is shown when it is known, and nothing stands in for it', () => {
    assert.strictEqual(value(statLines({ ip: '90.155.46.44' }), 'ip'), '90.155.46.44');
    assert.strictEqual(value(statLines({ ip: '2a00:23c6::1f' }), 'ip'), '2a00:23c6::1f');
    // The lookup is optional and can fail. An empty line, a dash or the word
    // "unknown" in a corner of the waterfall says less than no line at all.
    assert.strictEqual(find(statLines({ ip: '' }), 'ip'), undefined);
    assert.strictEqual(find(statLines({ ip: null }), 'ip'), undefined);
    assert.strictEqual(find(statLines({ ip: {} }), 'ip'), undefined);
    assert.strictEqual(find(statLines({ fps: 60 }), 'ip'), undefined);
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

t('the stream line carries rate and channels on one line', () => {
    // The three the receiver actually produces. Round rates lose the decimal;
    // IQ's two channels are named for what they are, since "stereo" would read
    // as two versions of the same audio.
    assert.strictEqual(value(statLines({ streamRate: 12000, streamChannels: 1 }), 'stream'), '12 kHz  mono');
    assert.strictEqual(value(statLines({ streamRate: 24000, streamChannels: 1 }), 'stream'), '24 kHz  mono');
    assert.strictEqual(value(statLines({ streamRate: 10000, streamChannels: 2 }), 'stream'), '10 kHz  I/Q');
    // An odd rate keeps a decimal rather than rounding to a rate it is not.
    assert.strictEqual(value(statLines({ streamRate: 11025, streamChannels: 1 }), 'stream'), '11.0 kHz  mono');
});

t('the stream line waits for the first packet rather than showing zeros', () => {
    // Both figures come from a scheduled buffer, so before one arrives there is
    // nothing to say — and "0 kHz" would read as a stalled stream.
    assert.strictEqual(find(statLines({ fps: 20 }), 'stream'), undefined);
    assert.strictEqual(find(statLines({ streamRate: 0, streamChannels: 0 }), 'stream'), undefined);
    // Half-known is still worth a line: the rate arrives with the same buffer.
    assert.strictEqual(value(statLines({ streamRate: 12000 }), 'stream'), '12 kHz');
});

t('the app load line is absent unless a host reported one', () => {
    // A browser tab cannot measure this, and a zero would read as "costing
    // nothing" rather than "nobody asked".
    assert.strictEqual(find(statLines({ fps: 20 }), 'app'), undefined);
    assert.strictEqual(find(statLines({ fps: 20, app: null }), 'app'), undefined);
    assert.strictEqual(find(statLines({ app: {} }), 'app'), undefined);
});

t('app load reads as whole percent and whole megabytes', () => {
    assert.strictEqual(value(statLines({ app: { cpu: 12.4, mem: 193_000_000 } }), 'app'), '12%  193 MB');
    // Either half alone, for a host that can measure one and not the other.
    assert.strictEqual(value(statLines({ app: { cpu: 3 } }), 'app'), '3%');
    assert.strictEqual(value(statLines({ app: { mem: 52_400_000 } }), 'app'), '52 MB');
});

t('a gigabyte is not four digits of megabytes', () => {
    assert.strictEqual(value(statLines({ app: { mem: 1_240_000_000 } }), 'app'), '1.2 GB');
    assert.strictEqual(value(statLines({ app: { mem: 999_000_000 } }), 'app'), '999 MB');
});

t('more than one core is a real reading, not a bug to clamp', () => {
    // Every system monitor reports a share of one core, so a busy decoder on a
    // multi-core machine legitimately passes 100.
    assert.strictEqual(value(statLines({ app: { cpu: 148 } }), 'app'), '148%');
});

console.log(`\n${pass} ok`);
