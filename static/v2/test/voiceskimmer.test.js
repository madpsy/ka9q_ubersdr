// The voice skimmer addon panel.
//
// Two columns from two queries, and the queries are most of what is worth testing: the
// server does the filtering and the sorting, so what could go wrong is asking it for
// the wrong thing. After that it is unit conversion — the addon deals in seconds since
// the epoch and everything here is in milliseconds — and what a click should tune to.

const assert = require('assert');
const vs = require('./.build/voiceskimmer.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = 1786123727;   // seconds, as the addon sends them
// A row as the addon sends it, from a live receiver.
const row = (over = {}) => ({
    callsign: 'CR60A',
    band: '20m',
    frequency: 14297000,
    mode: 'USB',
    last_heard: NOW,
    submitted_at: NOW - 700,
    country: 'Portugal',
    country_code: 'PT',
    snr: 28.35714,
    ...over,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(vs.voiceSkimmerAvailable({ addons: ['VoiceSkimmer'] }), true);
    assert.strictEqual(vs.voiceSkimmerAvailable({ addons: ['sstv', 'voiceskimmer'] }), true);
    assert.strictEqual(vs.voiceSkimmerAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(vs.voiceSkimmerAvailable(null), false);
});

// --- the two queries ------------------------------------------------------------

t('confirmed asks for the most recently heard', () => {
    const url = vs.confirmedUrl(5);
    assert.ok(url.startsWith('/addon/voiceskimmer/api/spots?'));
    assert.ok(url.includes('limit=5'));
    assert.ok(url.includes('sort=last_heard'));
    assert.ok(url.includes('order=desc'));
    assert.ok(!url.includes('submitted='), 'confirmed is everything, submitted or not');
});

t('spotted asks the server to filter, rather than filtering here', () => {
    // Spotted is a subset of confirmed, so a client-side split has the column reading
    // empty whenever the submitted ones happen to be older than the window fetched.
    // The server has a real filter, so it does the work.
    const url = vs.spottedUrl(5);
    assert.ok(url.includes('submitted=true'));
    assert.ok(url.includes('sort=submitted_at'), 'and ordered by when it was spotted');
    assert.ok(url.includes('limit=5'));
});

t('both queries ask for only the fields the panel draws', () => {
    // The full record carries the transcript line, the QRZ summary, the confidence
    // scores and a dozen flags — three kilobytes a row against about a hundred and
    // fifty for this.
    for (const url of [vs.confirmedUrl(), vs.spottedUrl()]) {
        assert.ok(url.includes('fields=callsign,band,frequency'), url);
        assert.ok(!url.includes('transcript'), url);
    }
});

t('the second query waits, because the endpoint allows one request a second', () => {
    assert.ok(vs.SECOND_QUERY_MS >= 1000, 'with a margin over the limit');
    assert.ok(vs.POLL_MS > vs.SECOND_QUERY_MS * 2, 'and the pair fits inside a cycle');
});

// --- one row ---------------------------------------------------------------------

t('a row keeps its callsign, where it was heard and how strong it was', () => {
    const s = vs.normaliseSpot(row());
    assert.strictEqual(s.callsign, 'CR60A');
    assert.strictEqual(s.hz, 14297000);
    assert.strictEqual(s.band, '20m');
    assert.strictEqual(s.mode, 'usb');
    assert.strictEqual(s.cc, 'PT');
    assert.ok(Math.abs(s.snr - 28.36) < 0.01);
});

t('seconds become milliseconds, or every row would be dated 1970', () => {
    const s = vs.normaliseSpot(row());
    assert.strictEqual(s.at, NOW * 1000);
    assert.strictEqual(s.spottedAt, (NOW - 700) * 1000);
});

t('a confirmed row that was never spotted has no spotted time', () => {
    assert.strictEqual(vs.normaliseSpot(row({ submitted_at: null })).spottedAt, 0);
});

t('a row without a callsign or a frequency is not a row', () => {
    // Both are needed: one is what it says, the other is what clicking it does.
    assert.strictEqual(vs.normaliseSpot(row({ callsign: '' })), null);
    assert.strictEqual(vs.normaliseSpot(row({ frequency: 0 })), null);
    assert.strictEqual(vs.normaliseSpot(null), null);
});

t('the same station on two bands is two rows', () => {
    // The key is the addon's own: callsign and frequency, because a station worked on
    // 20m and 40m is two sightings and hiding one of them would lose a band.
    const a = vs.normaliseSpot(row());
    const b = vs.normaliseSpot(row({ frequency: 7160000, band: '40m' }));
    assert.notStrictEqual(a.key, b.key);
});

t('a payload of nonsense is an empty list rather than a crash', () => {
    assert.deepStrictEqual(vs.spotList(null), []);
    assert.deepStrictEqual(vs.spotList({ spots: [null, {}, 'x'] }), []);
    assert.strictEqual(vs.matchedCount({ matched: 803 }), 803);
    assert.strictEqual(vs.matchedCount({}), null);
});

// --- what a click does --------------------------------------------------------------

t('clicking tunes to the frequency, in the mode it was heard in', () => {
    // Tuning to an SSB station in the wrong sideband is the same as not tuning to it.
    assert.deepStrictEqual(vs.tuneTarget(vs.normaliseSpot(row())),
        { frequency: 14297000, mode: 'usb' });
    assert.deepStrictEqual(vs.tuneTarget(vs.normaliseSpot(row({ mode: 'LSB', frequency: 7160000 }))),
        { frequency: 7160000, mode: 'lsb' });
});

t('a mode the receiver does not have is left alone rather than guessed', () => {
    // The dial goes to the frequency and the operator keeps whatever they had set,
    // which is better than being switched into something the addon half-reported.
    assert.deepStrictEqual(vs.tuneTarget(vs.normaliseSpot(row({ mode: 'ssb' }))),
        { frequency: 14297000 });
    assert.deepStrictEqual(vs.tuneTarget(vs.normaliseSpot(row({ mode: '' }))),
        { frequency: 14297000 });
});

t('nothing to tune to is nothing, not a dial jump to zero', () => {
    assert.strictEqual(vs.tuneTarget(null), null);
    assert.strictEqual(vs.tuneTarget({ hz: 0 }), null);
});

t('the frequency reads as a spotting list writes it', () => {
    assert.strictEqual(vs.freqLabel(14297000), '14.297');
    assert.strictEqual(vs.freqLabel(7160000), '7.160');
    assert.strictEqual(vs.freqLabel(0), '');
});

if (process.exitCode) console.log('\nvoice skimmer tests FAILED');
else console.log(`\nall ${pass} voice skimmer tests passed`);
