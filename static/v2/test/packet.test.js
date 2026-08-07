// The packet addon panel's arithmetic.
//
// The panel polls a ring buffer that returns the same frames over and over, so most of
// what is worth testing is about identity: which two rows are the same frame, which
// repeated beacon is a new one, and what the figures come to once that is settled.

const assert = require('assert');
const pk = require('./.build/packet.cjs');
const { buildMarkers } = require('./.build/packetmarkers.cjs');

// clockOf and sinceLabel moved to lib/format.js when the third addon panel wanted them;
// the cases stay here, where what they are for is written down.
const { clockOf, sinceLabel } = require('./.build/format.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 6, 14, 30, 0);
const iso = (ms) => new Date(ms).toISOString();
// A frame as the addon sends it.
const raw = (agoMs, over = {}) => ({
    received_at: iso(NOW - agoMs),
    sm_ch: 0,
    snr: 14.5,
    from: 'g0rdh-9',
    to: 'APRS',
    via: ['wide1-1'],
    frame_type: 'aprs',
    info: 'Position: 51.5N 0.1W',
    info_raw: '!5130.00N/00006.00W>',
    hex_raw: 'ae92...',
    ...over,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(pk.packetAvailable({ addons: ['Packet'] }), true);
    assert.strictEqual(pk.packetAvailable({ addons: ['sstv', 'packet'] }), true);
});

t('no addon, no panel — and nothing throws on a receiver that says nothing', () => {
    assert.strictEqual(pk.packetAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(pk.packetAvailable({}), false);
    assert.strictEqual(pk.packetAvailable(null), false);
    assert.strictEqual(pk.packetAvailable({ addons: 'packet' }), false, 'a string is not a list');
});

t('it asks for every channel at once, and for the decoded frames', () => {
    // Not /api/events: that carries the raw KISS bytes, which would mean a second AX.25
    // decoder in this repo to arrive at what /api/frames already returns as JSON.
    assert.ok(pk.framesUrl().startsWith('/addon/packet/api/frames'));
    assert.ok(pk.framesUrl().includes('channel=*'));
    assert.ok(pk.framesUrl().includes(`limit=${pk.FRAME_LIMIT}`));
    assert.strictEqual(pk.addonUrl(), '/addon/packet/');
});

// --- one frame ---------------------------------------------------------------

t('a frame keeps its addresses, its path and its level', () => {
    const f = pk.normaliseFrame(raw(1000));
    assert.strictEqual(f.at, NOW - 1000);
    assert.strictEqual(f.from, 'G0RDH-9', 'callsigns are upper case, whatever arrived');
    assert.strictEqual(f.to, 'APRS');
    assert.deepStrictEqual(f.via, ['WIDE1-1']);
    assert.strictEqual(f.snr, 14.5);
    assert.strictEqual(f.info, 'Position: 51.5N 0.1W');
});

t('a frame the addon could not describe falls back to its raw payload', () => {
    const f = pk.normaliseFrame(raw(0, { info: '', info_raw: ':BLN1     :NET 1900Z' }));
    assert.strictEqual(f.info, ':BLN1     :NET 1900Z');
});

t('no SNR is null rather than zero — a missing reading is not a weak one', () => {
    assert.strictEqual(pk.normaliseFrame(raw(0, { snr: null })).snr, null);
    assert.strictEqual(pk.normaliseFrame(raw(0, { snr: undefined })).snr, null);
    assert.strictEqual(pk.normaliseFrame(raw(0, { snr: 0 })).snr, 0, 'but zero dB is a reading');
});

t('a frame without a usable timestamp is dropped, not placed at 1970', () => {
    assert.strictEqual(pk.normaliseFrame({ received_at: 'soon' }), null);
    assert.strictEqual(pk.normaliseFrame({}), null);
    assert.strictEqual(pk.normaliseFrame(null), null);
});

// --- the same frame, over and over -------------------------------------------

t('two polls of the same frame are one frame', () => {
    // The ring buffer returns everything it still holds on every request, so the
    // overlap between polls is total rather than occasional.
    const rows = [raw(2000), raw(9000)].map(pk.normaliseFrame);
    const once = pk.mergeFrames([], rows, NOW);
    const twice = pk.mergeFrames(once, rows, NOW);
    assert.strictEqual(once.length, 2);
    assert.strictEqual(twice.length, 2);
    assert.strictEqual(twice, once, 'and nothing changed, so the list is the same object');
});

t('the same station beaconing again is a new frame', () => {
    // Identical in every field except when it arrived, which is exactly what a beacon
    // is. Counting it once would make a station that transmits every minute look silent.
    const a = pk.normaliseFrame(raw(0));
    const b = pk.normaliseFrame(raw(60000));
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(pk.mergeFrames([a], [b], NOW).length, 2);
});

t('the same instant on two sub-channels is two decodes, not one', () => {
    // Four modems listen to each channel; two of them decoding the same transmission is
    // a real thing the addon reports, and a panel that hid it would understate the count.
    const a = pk.normaliseFrame(raw(0, { sm_ch: 0 }));
    const b = pk.normaliseFrame(raw(0, { sm_ch: 2 }));
    assert.strictEqual(pk.mergeFrames([], [a, b], NOW).length, 2);
});

t('the list stays newest-first however the frames arrive', () => {
    const rows = [raw(500), raw(30000), raw(9000)].map(pk.normaliseFrame);
    const list = pk.mergeFrames([], rows, NOW);
    assert.deepStrictEqual(list.map((f) => NOW - f.at), [500, 9000, 30000]);
});

t('anything older than the hour is dropped, and the list has a ceiling', () => {
    const old = pk.normaliseFrame(raw(61 * 60 * 1000));
    assert.strictEqual(pk.mergeFrames([old], [pk.normaliseFrame(raw(0))], NOW).length, 1);
    const many = Array.from({ length: pk.KEEP_MAX + 40 }, (_, i) => pk.normaliseFrame(raw(i)));
    assert.strictEqual(pk.trimFrames(many, NOW).length, pk.KEEP_MAX);
});

// --- the figures --------------------------------------------------------------

t('the figures count the hour, and the rate only the last ten minutes', () => {
    // Ten rather than one: packet is bursty enough that a one-minute window reads zero
    // most of the time on a quiet channel, which says nothing useful.
    const list = pk.mergeFrames([], [
        raw(1000), raw(120000), raw(9 * 60 * 1000), raw(30 * 60 * 1000),
    ].map(pk.normaliseFrame), NOW);
    const s = pk.packetStats(list, NOW);
    assert.strictEqual(s.frames, 4);
    assert.strictEqual(s.rate, 3 / 10, 'three of them are inside ten minutes');
    assert.strictEqual(s.last, NOW - 1000);
});

t('stations counts who transmitted, not every callsign in the path', () => {
    // A digipeater path is full of callsigns that were not necessarily on the air just
    // then, and "heard" should mean heard.
    const list = pk.mergeFrames([], [
        raw(1000, { from: 'G0RDH', via: ['GB3XX', 'WIDE2-1'] }),
        raw(2000, { from: 'G0RDH', via: ['GB3XX'] }),
        raw(3000, { from: 'M0ABC', via: [] }),
    ].map(pk.normaliseFrame), NOW);
    assert.strictEqual(pk.packetStats(list, NOW).stations, 2);
});

t('an empty panel has no last frame rather than a last frame of zero', () => {
    assert.deepStrictEqual(pk.packetStats([], NOW), { frames: 0, stations: 0, rate: 0, last: null });
});

t('the busiest stations come back in order, with their counts', () => {
    const list = pk.mergeFrames([], [
        raw(1000, { from: 'A' }), raw(2000, { from: 'A' }), raw(3000, { from: 'A' }),
        raw(4000, { from: 'B' }), raw(5000, { from: 'B' }),
        raw(6000, { from: 'C' }),
    ].map(pk.normaliseFrame), NOW);
    assert.deepStrictEqual(pk.topStations(list, 2, NOW), [{ call: 'A', n: 3 }, { call: 'B', n: 2 }]);
});

t('stations with the same count come back in a stable order, not an arbitrary one', () => {
    // Two stations on one frame each is the normal case on a quiet channel, and a list
    // that reshuffled itself every poll would be unreadable.
    const list = pk.mergeFrames([], [
        raw(1000, { from: 'ZZ9ZZZ' }), raw(2000, { from: 'AA1AAA' }),
    ].map(pk.normaliseFrame), NOW);
    assert.deepStrictEqual(pk.topStations(list, 5, NOW).map((s) => s.call), ['AA1AAA', 'ZZ9ZZZ']);
});

// --- the badge ----------------------------------------------------------------

t('APRS is called out, and everything else keeps its own name', () => {
    // An APRS frame is a UI frame, but it is the one people are looking for, and "UI"
    // on every row says nothing.
    assert.strictEqual(pk.frameKind({ type: 'aprs' }), 'aprs');
    assert.strictEqual(pk.frameKind({ type: 'ui' }), 'ui');
    assert.strictEqual(pk.frameKind({ type: 'i' }), 'i');
    assert.strictEqual(pk.frameKind({ type: '' }), '');
    assert.strictEqual(pk.frameKind(null), '');
});

// --- what is being listened to --------------------------------------------------

t('a channel is named by its frequency, and says whether it is up', () => {
    const [a, b] = pk.channelSummary([
        { label: 'vhf', instance: { freq_hz: 144800000, status: 'connected' } },
        { label: 'uhf', instance: { freq_hz: 432500000, status: 'connecting' } },
    ]);
    assert.strictEqual(a.mhz, '144.800');
    assert.strictEqual(a.up, true);
    assert.strictEqual(b.up, false);
});

t('a channel that has not started still counts as configured', () => {
    // It is being monitored as far as the operator is concerned; leaving it out would
    // make a channel that is failing to connect look like one that does not exist.
    const [c] = pk.channelSummary([{ label: 'vhf', instance: {} }]);
    assert.strictEqual(c.label, 'vhf');
    assert.strictEqual(c.mhz, '');
    assert.strictEqual(c.up, false);
});

t('nothing sensible from the addon is an empty list, not a crash', () => {
    assert.deepStrictEqual(pk.channelSummary(null), []);
    assert.deepStrictEqual(pk.channelSummary([{}]), []);
});

// --- the marker: a shared frequency, and who is on it ----------------------------
//
// This is the part that makes a packet marker different from every other marker in the
// bar. One frequency, several stations, and the useful question is who is working whom.

t('frames become pairs, most recently heard first', () => {
    const frames = [
        raw(1000, { from: 'G0RDH', to: 'GB7XX' }),
        raw(5000, { from: 'M0ABC', to: 'APRS' }),
    ].map(pk.normaliseFrame);
    const pairs = pk.stationPairs(frames, NOW);
    assert.deepStrictEqual(pairs.map((p) => `${p.from}>${p.to}`), ['G0RDH>GB7XX', 'M0ABC>APRS']);
});

t('a station beaconing is one line and a count, not thirty lines', () => {
    const frames = Array.from({ length: 12 }, (_, i) => (
        pk.normaliseFrame(raw(i * 60000, { from: 'G0RDH', to: 'APRS' }))
    ));
    const pairs = pk.stationPairs(frames, NOW);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].n, 12);
    assert.strictEqual(pairs[0].at, NOW, 'and it is timed by the most recent one');
});

t('the same station working two others is two pairs', () => {
    // The whole point of the tooltip: not "these stations are here" but who is talking
    // to whom.
    const frames = [
        raw(1000, { from: 'G0RDH', to: 'M0ABC' }),
        raw(2000, { from: 'G0RDH', to: 'GB7XX' }),
    ].map(pk.normaliseFrame);
    assert.strictEqual(pk.stationPairs(frames, NOW).length, 2);
});

t('a channel nobody has used lately has no pairs', () => {
    const frames = [raw(20 * 60 * 1000)].map(pk.normaliseFrame);
    assert.deepStrictEqual(pk.stationPairs(frames, NOW), []);
});

t('the stations behind the pairs are distinct and in the same order', () => {
    const frames = [
        raw(1000, { from: 'G0RDH', to: 'M0ABC' }),
        raw(2000, { from: 'G0RDH', to: 'GB7XX' }),
        raw(3000, { from: 'M0ABC', to: 'G0RDH' }),
    ].map(pk.normaliseFrame);
    assert.deepStrictEqual(pk.stationsHeard(pk.stationPairs(frames, NOW)), ['G0RDH', 'M0ABC']);
});

t('the pill names one station and counts the rest', () => {
    // Forty pixels of canvas: one callsign and "+4" is as much as fits and as much as
    // is worth reading at a glance. The rest is in the tooltip.
    const one = pk.stationPairs([pk.normaliseFrame(raw(0, { from: 'G0RDH' }))], NOW);
    assert.strictEqual(pk.markerLabel(one, '144.800'), 'G0RDH');
    const three = pk.stationPairs([
        raw(0, { from: 'G0RDH' }), raw(1000, { from: 'M0ABC' }), raw(2000, { from: 'GB7XX' }),
    ].map(pk.normaliseFrame), NOW);
    assert.strictEqual(pk.markerLabel(three, '144.800'), 'G0RDH +2');
});

t('a quiet channel is still labelled, by its frequency', () => {
    // It is being listened to and has heard nothing, which is a real answer — a marker
    // that vanished would look like a receiver that had stopped listening.
    assert.strictEqual(pk.markerLabel([], '144.800'), '144.800 pkt');
    assert.strictEqual(pk.markerLabel([], ''), 'packet');
});

// --- times -----------------------------------------------------------------------

t('the clock is UTC, to the second', () => {
    assert.strictEqual(clockOf(NOW), '14:30:00');
});

t('the age reads in the unit that fits, and never is a dash', () => {
    assert.strictEqual(sinceLabel(NOW - 4000, NOW), '4s');
    assert.strictEqual(sinceLabel(NOW - 90000, NOW), '1m');
    assert.strictEqual(sinceLabel(NOW - 7200000, NOW), '2h');
    assert.strictEqual(sinceLabel(null, NOW), '—');
});

t('a marker is built per channel, in frequency order', () => {
    const chans = [
        { label: 'uhf', hz: 432500000, mhz: '432.500', up: true },
        { label: 'vhf', hz: 144800000, mhz: '144.800', up: true },
    ];
    const frames = {
        vhf: [raw(1000, { from: 'G0RDH', to: 'APRS' })].map(pk.normaliseFrame),
        uhf: [],
    };
    const marks = buildMarkers(chans, frames, NOW);
    assert.deepStrictEqual(marks.map((m) => m.label), ['vhf', 'uhf']);
    assert.strictEqual(marks[0].text, 'G0RDH');
    assert.strictEqual(marks[1].text, '432.500 pkt', 'the quiet one keeps its place');
});

t('a channel with no frequency has nowhere to be a marker', () => {
    assert.deepStrictEqual(buildMarkers([{ label: 'x', hz: 0 }], {}, NOW), []);
    assert.deepStrictEqual(buildMarkers(null, {}, NOW), []);
});

if (process.exitCode) console.log('\npacket tests FAILED');
else console.log(`\nall ${pass} packet tests passed`);
