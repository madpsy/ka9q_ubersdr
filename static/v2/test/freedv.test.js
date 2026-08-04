// FreeDV: the audio frame, and the FreeDV Reporter activity list.
//
// The audio path is the one place in this client where a parsing mistake is
// heard rather than seen — a wrong offset feeds the Opus decoder rubbish and
// produces silence or a burst of noise, with nothing on screen to say why. The
// activity list has the opposite problem: it is fed by a stream of small
// events, and dropping or misapplying one leaves a station on the list that
// went off the air an hour ago.

const assert = require('assert');

const {
    FRAME_OPUS, FREEDV_RATE, SIGNAL_TIMEOUT_MS,
    decodeFrame, normaliseUser, applyUpdate, snapshotToMap, visibleUsers,
    isTunable, isOnFrequency,
} = require('./.build/freedv.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// One frame exactly as audio_extensions/freedv writes it:
// [type:1][gps nanos:8 BE][sample rate:4 BE][channels:1][opus…].
function frame(opus, { rate = FREEDV_RATE, channels = 1, nanos = 0 } = {}) {
    const b = Buffer.alloc(14 + opus.length);
    b[0] = FRAME_OPUS;
    b.writeUInt32BE(Math.floor(nanos / 4294967296), 1);
    b.writeUInt32BE(nanos >>> 0, 5);
    b.writeUInt32BE(rate, 9);
    b[13] = channels;
    Buffer.from(opus).copy(b, 14);
    return b;
}

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// --- the audio frame --------------------------------------------------------

t('an audio frame carries its rate, its channels and its Opus packet', () => {
    const f = decodeFrame(asArrayBuffer(frame([1, 2, 3, 4])));
    assert.strictEqual(f.kind, 'audio');
    assert.strictEqual(f.sampleRate, 12000);
    assert.strictEqual(f.channels, 1);
    assert.deepStrictEqual(Array.from(f.opus), [1, 2, 3, 4]);
});

t('the payload starts at byte 14 and not a byte either side', () => {
    // One byte out and the Opus decoder is fed a packet with a corrupt table of
    // contents: it either throws or produces noise, and nothing on screen says
    // which. This is the check that catches it.
    const opus = Array.from({ length: 40 }, (_, i) => (i * 7) % 251);
    const f = decodeFrame(asArrayBuffer(frame(opus)));
    assert.strictEqual(f.opus.length, 40);
    assert.deepStrictEqual(Array.from(f.opus), opus);
});

t('a frame read from a view starts at the view, not the buffer', () => {
    const b = frame([9, 8, 7]);
    const padded = Buffer.concat([Buffer.alloc(5), b]);
    assert.deepStrictEqual(Array.from(decodeFrame(padded.subarray(5)).opus), [9, 8, 7]);
});

t('an unusual rate or a stereo stream is taken from the frame, not assumed', () => {
    const f = decodeFrame(asArrayBuffer(frame([1], { rate: 8000, channels: 2 })));
    assert.strictEqual(f.sampleRate, 8000);
    assert.strictEqual(f.channels, 2);
    // A zero in either field is a server that did not fill it in; the defaults
    // are what the decoder actually emits.
    const bare = frame([1], { rate: 0, channels: 0 });
    const g = decodeFrame(asArrayBuffer(bare));
    assert.strictEqual(g.sampleRate, FREEDV_RATE);
    assert.strictEqual(g.channels, 1);
});

t('a frame with nothing in it is dropped, not decoded', () => {
    // An empty packet is not silence to the Opus decoder — it is an error.
    assert.strictEqual(decodeFrame(asArrayBuffer(frame([]))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.alloc(13))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([0x01, 1, 2]))), null, 'a type we do not know');
    assert.strictEqual(decodeFrame(null), null);
    assert.strictEqual(decodeFrame('not binary'), null);
});

t('the signal watchdog is longer than a gap between words', () => {
    // Frames arrive every 20 ms while decoding, so this exists to survive a
    // pause in speech, not to detect the end of a transmission quickly.
    assert.ok(SIGNAL_TIMEOUT_MS >= 1000);
});

// --- the activity list ------------------------------------------------------

const raw = (over = {}) => ({
    sid: 'a1',
    callsign: 'VK3ABC',
    grid_square: 'QF22',
    freq_hz: 14236000,
    mode: 'RADEV1',
    transmitting: false,
    message: 'Testing',
    country: 'Australia',
    distance_km: 16800.5,
    bearing_deg: 95.1,
    ...over,
});

t('a station keeps its numbers and survives having none of them', () => {
    const u = normaliseUser(raw());
    assert.strictEqual(u.callsign, 'VK3ABC');
    assert.strictEqual(u.freqHz, 14236000);
    assert.strictEqual(u.distanceKm, 16800.5);

    // A station that has just connected has reported nothing yet, and must
    // still render rather than throwing on a missing field.
    const bare = normaliseUser({ sid: 'b2' });
    assert.strictEqual(bare.callsign, '');
    assert.strictEqual(bare.freqHz, 0);
    assert.strictEqual(bare.distanceKm, null, 'not 0 — 0 km is the receiver');
    assert.strictEqual(bare.transmitting, false);
});

t('a snapshot becomes the whole list, keyed by session id', () => {
    const map = snapshotToMap([raw(), raw({ sid: 'b2', callsign: 'G0XYZ' })]);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('b2').callsign, 'G0XYZ');
    // A record with no session id cannot be updated or removed later, so it is
    // not taken at all.
    assert.strictEqual(snapshotToMap([{ callsign: 'NOSID' }]).size, 0);
    assert.strictEqual(snapshotToMap(undefined).size, 0);
});

t('an update replaces the station outright rather than merging', () => {
    // The server sends the full current state on every event, so merging here
    // would let a dropped event leave a stale field behind for ever.
    const map = snapshotToMap([raw()]);
    const next = applyUpdate(map, {
        event: 'tx_report',
        user: raw({ transmitting: true, message: '' }),
    });
    assert.strictEqual(next.get('a1').transmitting, true);
    assert.strictEqual(next.get('a1').message, '', 'the old message is gone, not kept');
});

t('a removal takes the station off the list, by id alone', () => {
    // remove_connection carries no user — only the session id.
    const map = snapshotToMap([raw(), raw({ sid: 'b2' })]);
    const next = applyUpdate(map, { event: 'remove_connection', user: null, sid: 'a1' });
    assert.strictEqual(next.size, 1);
    assert.ok(!next.has('a1'));
});

t('applying an update never writes through the map it was given', () => {
    const map = snapshotToMap([raw()]);
    const next = applyUpdate(map, { event: 'new_connection', user: raw({ sid: 'b2' }) });
    assert.strictEqual(map.size, 1, 'the earlier state is unchanged');
    assert.strictEqual(next.size, 2);
});

t('the list is the current band, because that is the question it answers', () => {
    const map = snapshotToMap([
        raw({ sid: '20a', callsign: 'ON20', freq_hz: 14236000 }),
        raw({ sid: '40a', callsign: 'ON40', freq_hz: 7177000 }),
        raw({ sid: 'vhf', callsign: 'ONVHF', freq_hz: 144174000 }),
    ]);
    const twenty = visibleUsers(map, { min: 14000000, max: 14350000 });
    assert.deepStrictEqual(twenty.map((u) => u.callsign), ['ON20']);
    // Between bands nothing is filtered: an empty list would read as an empty
    // reporter rather than a dial parked in a gap.
    assert.strictEqual(visibleUsers(map, null).length, 3);
});

t('whoever is transmitting sorts to the top', () => {
    const map = snapshotToMap([
        raw({ sid: '1', callsign: 'AAA' }),
        raw({ sid: '2', callsign: 'ZZZ', transmitting: true }),
        raw({ sid: '3', callsign: 'MMM' }),
    ]);
    assert.deepStrictEqual(
        visibleUsers(map, null).map((u) => u.callsign),
        ['ZZZ', 'AAA', 'MMM'],
    );
});

t('a station this receiver cannot reach is not offered as tunable', () => {
    // The reporter carries VHF and above; a row that looks clickable and then
    // tunes to the band edge is worse than one that plainly is not.
    assert.strictEqual(isTunable(normaliseUser(raw())), true);
    assert.strictEqual(isTunable(normaliseUser(raw({ freq_hz: 144174000 }))), false);
    assert.strictEqual(isTunable(normaliseUser(raw({ freq_hz: 0 }))), false);
});

t('a station within half a kilohertz of the dial is the one being heard', () => {
    // Operators quote the suppressed carrier and a FreeDV signal is a couple of
    // kilohertz wide, so this is wider than an exact match.
    const u = normaliseUser(raw());
    assert.strictEqual(isOnFrequency(u, 14236000), true);
    assert.strictEqual(isOnFrequency(u, 14236400), true);
    assert.strictEqual(isOnFrequency(u, 14237000), false);
    assert.strictEqual(isOnFrequency(u, 0), false);
    assert.strictEqual(isOnFrequency(normaliseUser(raw({ freq_hz: 0 })), 14236000), false);
});

console.log(`\n${pass} FreeDV checks passed`);
