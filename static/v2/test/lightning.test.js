// The lightning addon panel's arithmetic.
//
// Two sources feed one list — an hour of history with nanosecond timestamps, and a live
// stream whose compact messages carry no epoch at all — so the interesting cases are
// where those two meet: the overlap between them, the strike that arrives twice, the
// hour boundary, and a rate quoted over a window that is mostly in the past.

const assert = require('assert');
const lx = require('./.build/lightning.cjs');

// clockOf and sinceLabel moved to lib/format.js when the third addon panel wanted them;
// the cases stay here, where what they are for is written down.
const { sinceLabel } = require('./.build/format.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 6, 14, 30, 0);
const ago = (ms) => NOW - ms;
// A strike as the panel holds it.
const at = (ms, snr = 15, id) => ({
    id: id || `s${ms}-${snr}`, at: ago(ms), time: '14:29:59.000', snr, ms: 2, peak: 0.4, saturated: false,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(lx.lightningAvailable({ addons: ['sstv', 'Lightning'] }), true);
    assert.strictEqual(lx.lightningAvailable({ addons: ['lightning'] }), true);
});

t('no addons, no panel — and nothing throws on a receiver that says nothing', () => {
    assert.strictEqual(lx.lightningAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(lx.lightningAvailable({ addons: [] }), false);
    assert.strictEqual(lx.lightningAvailable({}), false);
    assert.strictEqual(lx.lightningAvailable(null), false);
    assert.strictEqual(lx.lightningAvailable({ addons: 'lightning' }), false, 'a string is not a list');
});

t('the URLs are the addon routes, and the stream is the compact one', () => {
    // Nothing here draws a waveform or a spectrum, and the full stream sends about
    // 7.5 KB of waveform per strike. Asking for it would be paying to throw it away.
    assert.ok(lx.streamUrl().startsWith('/addon/lightning/api/events'));
    assert.ok(lx.streamUrl().includes('minimal=1'));
    assert.ok(lx.strikesUrl().startsWith('/addon/lightning/api/strikes'));
    assert.ok(lx.strikesUrl().includes('since=1h'));
    assert.strictEqual(lx.addonUrl(), '/addon/lightning/');
});

// --- one shape from two sources ----------------------------------------------

t('a history strike is placed by its own GPS timestamp', () => {
    const ns = NOW * 1e6;
    const s = lx.normaliseStrike({ id: 'abc', timestamp_ns: ns, time: '14:30:00.123', snr_db: 22.4 });
    assert.strictEqual(s.at, NOW);
    assert.strictEqual(s.id, 'abc');
    assert.strictEqual(s.snr, 22.4);
    assert.strictEqual(s.time, '14:30:00.123', "the addon's own clock string is kept");
});

t('a live strike has no epoch, so it is placed when it arrived', () => {
    // The compact stream sends "HH:MM:SS.mmm" and nothing else. Over a local network
    // the difference is milliseconds, which does not show in one-second buckets.
    const s = lx.normaliseStrike({ time: '14:29:59.900', snr_db: 9 }, NOW);
    assert.strictEqual(s.at, NOW);
    assert.strictEqual(s.time, '14:29:59.900');
});

t('a strike with neither a timestamp nor a clock gets both', () => {
    const s = lx.normaliseStrike({ snr_db: 5 }, NOW);
    assert.strictEqual(s.at, NOW);
    assert.strictEqual(s.time, '14:30:00', 'UTC, from the arrival time');
});

t('missing numbers are zero rather than NaN', () => {
    // A NaN in the SNR would make every bar and every colour NaN with it.
    const s = lx.normaliseStrike({ time: 'x' }, NOW);
    assert.strictEqual(s.snr, 0);
    assert.strictEqual(s.ms, 0);
    assert.strictEqual(s.peak, 0);
    assert.strictEqual(s.saturated, false);
});

t('nothing useful in, nothing out', () => {
    assert.strictEqual(lx.normaliseStrike(null), null);
    assert.strictEqual(lx.normaliseStrike('boom'), null);
});

// --- the list ----------------------------------------------------------------

t('a strike goes on the front, newest first', () => {
    const list = lx.addStrike([at(5000)], lx.normaliseStrike({ time: 'now', snr_db: 30 }, NOW), NOW);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].snr, 30);
});

t('the same strike twice is one strike', () => {
    // The backfill and the stream overlap by however long the first request took, and
    // a strike counted twice is a rate that is wrong for the next hour.
    const one = at(1000, 18, 'dup');
    const list = lx.addStrike(lx.addStrike([], one, NOW), { ...one }, NOW);
    assert.strictEqual(list.length, 1);
});

t('anything older than the hour is dropped as it goes in', () => {
    const old = at(61 * 60 * 1000);
    const list = lx.addStrike([old], at(1000), NOW);
    assert.strictEqual(list.length, 1);
    assert.ok(list.every((s) => s.at > ago(60 * 60 * 1000)));
});

t('a storm cannot grow the list without limit', () => {
    const many = Array.from({ length: lx.KEEP_MAX + 50 }, (_, i) => at(i, 15, `x${i}`));
    assert.strictEqual(lx.trimStrikes(many, NOW).length, lx.KEEP_MAX);
});

// --- the figures --------------------------------------------------------------

t('the rate is per minute over the last minute, not since the panel opened', () => {
    const list = [at(1000), at(20000), at(59000), at(61000), at(120000)];
    // Three of the five fall inside the window, and the window is a minute.
    assert.strictEqual(lx.strikeRate(list, NOW), 3);
});

t('a strike that has just aged out of the window stops counting', () => {
    assert.strictEqual(lx.strikeRate([at(59999)], NOW), 1);
    assert.strictEqual(lx.strikeRate([at(60001)], NOW), 0);
});

t('an hour with nothing in it has no peak rather than a peak of zero', () => {
    // "—" and "0 dB" say different things: one is silence, the other a strike at the
    // noise floor.
    assert.deepStrictEqual(lx.hourStats([], NOW), { count: 0, best: null });
});

t('the hour counts what is in the hour, and reports the hardest of it', () => {
    const list = [at(1000, 12), at(30 * 60 * 1000, 31.5), at(59 * 60 * 1000, 8), at(61 * 60 * 1000, 40)];
    const { count, best } = lx.hourStats(list, NOW);
    assert.strictEqual(count, 3, 'the 61-minute-old one is not in the hour');
    assert.strictEqual(best, 31.5, 'and neither is its 40 dB');
});

// --- the bands ---------------------------------------------------------------

t('the SNR bands are the addon\'s own, so a strong strike is strong on both pages', () => {
    assert.strictEqual(lx.snrBand(20), 'hi');
    assert.strictEqual(lx.snrBand(19.9), 'med');
    assert.strictEqual(lx.snrBand(12), 'med');
    assert.strictEqual(lx.snrBand(11.9), 'lo');
    assert.strictEqual(lx.snrBand(undefined), 'lo', 'and nothing is not a strong strike');
});

// --- the activity strip --------------------------------------------------------

t('the strip is one bucket per second of the window, quiet or not', () => {
    // Empty seconds are buckets of zero rather than gaps: the strip has to scroll
    // smoothly, and a quiet minute must look like a quiet minute rather than no data.
    const buckets = lx.activityBuckets([], NOW);
    assert.strictEqual(buckets.length, lx.WINDOW_S);
    assert.ok(buckets.every((b) => b.n === 0 && b.snr === 0));
});

t('the newest second is the last bucket, and the oldest the first', () => {
    // 59.5 s rather than 59.0: a whole number of seconds lands exactly on a bucket
    // boundary, and which side of it that falls is an arbitrary detail to pin down.
    const buckets = lx.activityBuckets([at(500, 25), at(59500, 14)], NOW);
    assert.strictEqual(buckets[buckets.length - 1].n, 1, 'half a second ago is now');
    assert.strictEqual(buckets[0].n, 1, 'nearly a minute ago is the far end');
    assert.strictEqual(buckets[buckets.length - 1].snr, 25);
});

t('a bucket carries how many and the hardest of them', () => {
    // The two say different things: the height is how many, the colour is how close.
    const buckets = lx.activityBuckets([at(1200, 9), at(1400, 27), at(1600, 15)], NOW);
    const hit = buckets.filter((b) => b.n);
    assert.strictEqual(hit.length, 1, 'all three are in the same second');
    assert.strictEqual(hit[0].n, 3);
    assert.strictEqual(hit[0].snr, 27);
});

t('strikes outside the window are not in the strip at all', () => {
    const buckets = lx.activityBuckets([at(65000, 30), at(-5000, 30)], NOW);
    assert.ok(buckets.every((b) => b.n === 0), 'too old, and one from the future');
});

// --- the strip's colours ---------------------------------------------------------

t('the bars are painted in colours, not in a var() the canvas cannot read', () => {
    // The bug this pins: a canvas context has no element to resolve a custom property
    // against, so `fillStyle = 'var(--bad)'` is ignored and every bar was drawn in the
    // default black — on a black background. The strip read as "nothing is striking"
    // through a storm.
    const theme = { '--bad': ' #f2646a ', '--warn': '#f2b544', '--accent': '#08a2fb' };
    const tone = lx.stripTone((name) => theme[name]);
    assert.deepStrictEqual(tone, { hi: '#f2646a', med: '#f2b544', lo: '#08a2fb' });
    for (const band of Object.keys(lx.TONE_VARS)) {
        assert.ok(!tone[band].includes('var('), `${band} must be a colour`);
    }
});

t('a variable the stylesheet has not set falls back to a colour', () => {
    // A canvas drawn before the stylesheet applies, or a theme mid-swap: the strip is
    // drawn in the dark theme's values rather than in whatever the context was last set
    // to, which is black.
    assert.deepStrictEqual(lx.stripTone(() => ''), lx.TONE_FALLBACK);
    assert.deepStrictEqual(lx.stripTone(() => undefined), lx.TONE_FALLBACK);
    assert.deepStrictEqual(lx.stripTone(null), lx.TONE_FALLBACK);
    assert.deepStrictEqual(lx.stripTone(() => 'var(--bad)'), lx.TONE_FALLBACK,
        'and a var() that came back unresolved is not a colour either');
});

t('every band the strip can ask for has a colour to draw it in', () => {
    // snrBand returns one of these three and the strip indexes the tone by it, so a
    // band without an entry would be an undefined fillStyle — ignored, i.e. black.
    const tone = lx.stripTone(() => '');
    for (const db of [30, 20, 19, 12, 11, 0, undefined]) {
        assert.ok(tone[lx.snrBand(db)], `no colour for ${db} dB`);
    }
});

// --- how long ago ---------------------------------------------------------------

t('the age reads in the unit that fits it', () => {
    assert.strictEqual(sinceLabel(ago(4000), NOW), '4s');
    assert.strictEqual(sinceLabel(ago(59000), NOW), '59s');
    assert.strictEqual(sinceLabel(ago(60000), NOW), '1m');
    assert.strictEqual(sinceLabel(ago(45 * 60 * 1000), NOW), '45m');
    assert.strictEqual(sinceLabel(ago(2.5 * 3600 * 1000), NOW), '2h');
});

t('never is a dash, not zero seconds ago', () => {
    assert.strictEqual(sinceLabel(null, NOW), '—');
    assert.strictEqual(sinceLabel(0, NOW), '—');
});

t('a clock that is somehow ahead of us reads as now, not as negative', () => {
    assert.strictEqual(sinceLabel(NOW + 5000, NOW), '0s');
});

// --- the flash ---------------------------------------------------------------

t('a harder strike flashes brighter, up to a ceiling', () => {
    // A fixed flash would make a distant sferic look like a strike overhead; an
    // unbounded one would strobe on a storm.
    assert.ok(lx.flashStrength(5) < lx.flashStrength(15));
    assert.ok(lx.flashStrength(15) < lx.flashStrength(29));
    assert.strictEqual(lx.flashStrength(lx.FLASH_FULL_DB), lx.FLASH_MAX);
    assert.strictEqual(lx.flashStrength(120), lx.FLASH_MAX, 'a very close strike is not brighter still');
});

t('even the faintest strike is visible, and nonsense does not go dark', () => {
    // Below the floor a real strike would go unnoticed, which is the one thing the
    // flash exists to prevent.
    assert.strictEqual(lx.flashStrength(0.1), lx.FLASH_MIN + (lx.FLASH_MAX - lx.FLASH_MIN) * (0.1 / lx.FLASH_FULL_DB));
    assert.strictEqual(lx.flashStrength(0), lx.FLASH_MIN);
    assert.strictEqual(lx.flashStrength(-4), lx.FLASH_MIN);
    assert.strictEqual(lx.flashStrength(undefined), lx.FLASH_MIN);
    assert.ok(lx.FLASH_MIN > 0);
});

if (process.exitCode) console.log('\nlightning tests FAILED');
else console.log(`\nall ${pass} lightning tests passed`);
