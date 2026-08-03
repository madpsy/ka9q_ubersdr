// Extensions: the audio-extension wire protocol, and FT8's handling of what
// comes back over it.
//
// These are the parts where a mistake is silent. An attach with the wrong field
// name is answered with a generic error the panel shows as "extension error"; a
// result frame parsed loosely yields a row of NaN and dashes that looks like a
// weak decode; a sort that compares numbers as text puts -12 dB above -3 dB and
// still looks sorted. None of them throw.

const assert = require('assert');
const {
    ATTACH, DETACH, CONTROL, STATUS,
    attachMessage, detachMessage, controlMessage, statusMessage,
    decodeResult, extensionEvent,
} = require('./.build/extprotocol.cjs');
const {
    MAX_MESSAGES, AUTO_CLEAR_KEEP, CYCLE_SEC, FT8_BANDWIDTH, FT8_FREQUENCIES, COLUMNS,
    normaliseMessage, statsFrom, addMessage, filterMessages, sortMessages, toCSV, cycleProgress,
} = require('./.build/ft8messages.cjs');
const { labelsFor, layoutLabels } = require('./.build/ft8spectrum.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A decode exactly as audio_extensions/ft8/decoder.go emits it.
const raw = {
    timestamp: 1785000000,
    utc: '12:00:15',
    snr: -12.5,
    delta_t: 0.2,
    frequency: 1240.5,
    callsign: 'JA1ABC',
    tx_callsign: 'JA1ABC',
    locator: 'PM95',
    distance_km: 9500.4,
    bearing_deg: 35.2,
    country: 'Japan',
    country_code: 'JP',
    continent: 'AS',
    message: 'CQ JA1ABC PM95',
    protocol: 'FT8',
    slot_number: 42,
    score: 21,
    candidate_count: 130,
    ldpc_failures: 88,
    crc_failures: 4,
};

// --- protocol --------------------------------------------------------------

t('an attach names the extension in the field the server reads', () => {
    // audio_extension_manager.go reads msg["extension_name"] and msg["params"];
    // anything else is "extension_name is required".
    const m = attachMessage('ft8', { max_candidates: 100 });
    assert.strictEqual(m.type, ATTACH);
    assert.strictEqual(m.extension_name, 'ft8');
    assert.deepStrictEqual(m.params, { max_candidates: 100 });
});

t('an attach with no settings carries no params object', () => {
    assert.deepStrictEqual(attachMessage('morse', {}), { type: ATTACH, extension_name: 'morse' });
    assert.deepStrictEqual(attachMessage('morse'), { type: ATTACH, extension_name: 'morse' });
});

t('detach, control and status are the types the server switches on', () => {
    assert.deepStrictEqual(detachMessage(), { type: DETACH });
    assert.deepStrictEqual(statusMessage(), { type: STATUS });
    const c = controlMessage('summary_request', { since: 5 });
    assert.strictEqual(c.type, CONTROL);
    assert.strictEqual(c.control_type, 'summary_request');
    assert.strictEqual(c.since, 5);
});

t('a result frame is UTF-8 JSON, from an ArrayBuffer or a view', () => {
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.strictEqual(decodeResult(ab).message, 'CQ JA1ABC PM95');
    assert.strictEqual(decodeResult(new Uint8Array(ab)).message, 'CQ JA1ABC PM95');
});

t('a frame that is not a decode is dropped, not thrown on', () => {
    // One malformed frame must not take the panel down: null is the only
    // failure signal, so every caller has exactly one case to handle.
    assert.strictEqual(decodeResult(Buffer.from('{"a":', 'utf8')), null);
    assert.strictEqual(decodeResult(Buffer.from('[1,2]', 'utf8')), null);
    assert.strictEqual(decodeResult(null), null);
    assert.strictEqual(decodeResult(42), null);
});

t('both ways the server reports a failure flatten to one kind', () => {
    assert.strictEqual(extensionEvent({ type: 'audio_extension_attached', extension_name: 'ft8' }).kind, 'attached');
    assert.strictEqual(extensionEvent({ type: 'audio_extension_detached' }).kind, 'detached');
    const err = extensionEvent({ type: 'audio_extension_error', error: 'no active audio session found' });
    assert.strictEqual(err.kind, 'error');
    assert.strictEqual(err.error, 'no active audio session found');
    assert.strictEqual(extensionEvent({ type: 'audio_extension_status', active: false }).active, false);
    assert.strictEqual(extensionEvent({ type: 'chat_message' }), null);
});

// --- FT8 decodes -----------------------------------------------------------

t('a decode keeps its numbers and loses the server’s placeholders', () => {
    const m = normaliseMessage(raw, 0);
    assert.strictEqual(m.snr, -12.5);
    assert.strictEqual(m.frequency, 1240.5);
    assert.strictEqual(m.distanceKm, 9500.4);
    assert.strictEqual(m.slot, 42);
    assert.strictEqual(m.isCQ, true);
    // '-' is how the decoder spells "no callsign"; it must not become a row you
    // can click through to a lookup.
    assert.strictEqual(normaliseMessage({ ...raw, tx_callsign: '-' }, 1).txCallsign, '');
});

t('a decode with nothing the CTY database knows still renders', () => {
    const m = normaliseMessage({ message: 'CQ TEST', slot_number: 3 }, 0);
    assert.strictEqual(m.distanceKm, null);   // not 0 — 0 km is the receiver
    assert.strictEqual(m.bearingDeg, null);
    assert.strictEqual(m.country, '');
    assert.strictEqual(m.snr, 0);
    assert.strictEqual(m.protocol, 'FT8');
});

t('per-slot counters ride along on the decode', () => {
    assert.deepStrictEqual(statsFrom(raw), { candidates: 130, ldpcFailures: 88, crcFailures: 4 });
    assert.deepStrictEqual(statsFrom({}), { candidates: null, ldpcFailures: null, crcFailures: null });
});

t('decodes stack newest first and stop at the cap', () => {
    let list = [];
    for (let i = 0; i < MAX_MESSAGES + 25; i++) {
        list = addMessage(list, normaliseMessage({ ...raw, message: `M${i}` }, i));
    }
    assert.strictEqual(list.length, MAX_MESSAGES);
    assert.strictEqual(list[0].message, `M${MAX_MESSAGES + 24}`);
    // The oldest 25 are the ones gone.
    assert.strictEqual(list[list.length - 1].message, 'M25');
});

t('auto-clear keeps a working window, not the whole history', () => {
    let list = [];
    for (let i = 0; i < 300; i++) list = addMessage(list, normaliseMessage({ ...raw }, i));
    assert.strictEqual(list.slice(0, AUTO_CLEAR_KEEP).length, AUTO_CLEAR_KEEP);
});

const slotted = [
    normaliseMessage({ ...raw, slot_number: 8, message: 'CQ DL1ABC JO31', country: 'Germany', tx_callsign: 'DL1ABC', frequency: 700 }, 0),
    normaliseMessage({ ...raw, slot_number: 7, message: 'JA1ABC W1AW -09', country: 'Japan', tx_callsign: 'JA1ABC', frequency: 900 }, 1),
    normaliseMessage({ ...raw, slot_number: 6, message: 'CQ VK9DX QF22', country: 'Australia', tx_callsign: 'VK9DX', frequency: 1500 }, 2),
];

t('“latest cycle only” shows the slot being decoded now', () => {
    const got = filterMessages(slotted, { latestOnly: true, currentSlot: 8 });
    assert.deepStrictEqual(got.map((m) => m.slot), [8]);
    // Before the first decode there is no current slot, and hiding everything
    // would make a working decoder look dead.
    assert.strictEqual(filterMessages(slotted, { latestOnly: true, currentSlot: 0 }).length, 3);
});

t('CQ only and the text filter match what the row shows', () => {
    assert.deepStrictEqual(
        filterMessages(slotted, { cqOnly: true }).map((m) => m.txCallsign),
        ['DL1ABC', 'VK9DX'],
    );
    // The filter reads the message *and* the country, as v1's does — typing
    // "japan" is how you find a country you cannot spell a prefix for.
    assert.strictEqual(filterMessages(slotted, { text: 'japan' }).length, 1);
    assert.strictEqual(filterMessages(slotted, { text: 'w1aw' }).length, 1);
    assert.strictEqual(filterMessages(slotted, { text: 'nothing here' }).length, 0);
});

t('numeric columns sort as numbers', () => {
    const rows = [
        normaliseMessage({ ...raw, snr: -3, distance_km: 400 }, 0),
        normaliseMessage({ ...raw, snr: -12, distance_km: 90 }, 1),
        normaliseMessage({ ...raw, snr: 4, distance_km: 12000 }, 2),
    ];
    assert.deepStrictEqual(sortMessages(rows, 'snr', 'asc').map((m) => m.snr), [-12, -3, 4]);
    assert.deepStrictEqual(sortMessages(rows, 'snr', 'desc').map((m) => m.snr), [4, -3, -12]);
    assert.deepStrictEqual(sortMessages(rows, 'distanceKm', 'asc').map((m) => m.distanceKm), [90, 400, 12000]);
});

t('a missing value sorts last whichever way the column points', () => {
    const rows = [
        normaliseMessage({ ...raw, distance_km: 400 }, 0),
        normaliseMessage({ ...raw, distance_km: undefined }, 1),
        normaliseMessage({ ...raw, distance_km: 90 }, 2),
    ];
    assert.deepStrictEqual(sortMessages(rows, 'distanceKm', 'asc').map((m) => m.distanceKm), [90, 400, null]);
    assert.deepStrictEqual(sortMessages(rows, 'distanceKm', 'desc').map((m) => m.distanceKm), [400, 90, null]);
});

t('no sort column means arrival order, untouched', () => {
    const rows = [normaliseMessage(raw, 0), normaliseMessage(raw, 1)];
    assert.strictEqual(sortMessages(rows, null), rows);
    assert.strictEqual(sortMessages(rows, 'nope'), rows);
});

t('every column can be sorted by', () => {
    const rows = [normaliseMessage(raw, 0), normaliseMessage({ ...raw, slot_number: 9 }, 1)];
    for (const c of COLUMNS) {
        assert.strictEqual(sortMessages(rows, c.id, 'asc').length, 2, c.id);
    }
});

t('the CSV quotes every field, so a comma in a country name cannot shift it', () => {
    const csv = toCSV([normaliseMessage({ ...raw, country: 'Korea, Republic of' }, 0)]);
    const [header, row] = csv.trim().split('\n');
    assert.strictEqual(header.split(',').length, 15);
    assert.ok(row.includes('"Korea, Republic of"'));
    // Oldest first in the file, newest first on screen.
    const two = toCSV([normaliseMessage({ ...raw, message: 'NEW' }, 1), normaliseMessage({ ...raw, message: 'OLD' }, 0)]);
    const lines = two.trim().split('\n');
    assert.ok(lines[1].includes('OLD'));
    assert.ok(lines[2].includes('NEW'));
});

t('a quote inside a message is escaped, not left to end the field', () => {
    const csv = toCSV([normaliseMessage({ ...raw, message: 'CQ "DX"' }, 0)]);
    assert.ok(csv.includes('"CQ ""DX"""'));
});

t('the cycle bar tracks the 15-second slot on the wall clock', () => {
    // Slots start on the minute and every 15 s after it.
    assert.strictEqual(cycleProgress(Date.parse('2026-08-03T12:00:00Z')).seconds, 0);
    assert.strictEqual(cycleProgress(Date.parse('2026-08-03T12:00:15Z')).seconds, 0);
    assert.strictEqual(cycleProgress(Date.parse('2026-08-03T12:00:22Z')).seconds, 7);
    assert.strictEqual(cycleProgress(Date.parse('2026-08-03T12:00:52Z')).fraction, 7 / CYCLE_SEC);
});

t('the FT8 passband and frequency list are the decoder’s, not the mode’s', () => {
    assert.deepStrictEqual(FT8_BANDWIDTH, { low: 0, high: 3200 });
    const all = FT8_FREQUENCIES.flatMap((g) => g.options.map((o) => o.hz));
    assert.ok(all.includes(14074000));
    assert.strictEqual(all.length, 9);
});

// --- spectrum labels -------------------------------------------------------

t('labels come from the last slot of the same parity, not the last slot', () => {
    // A station transmits every other slot, so the audio on the air during an
    // even slot belongs to the previous even one. Labelling slot 7 over slot
    // 8's spectrum would put every callsign at the wrong tone.
    const messages = [
        normaliseMessage({ ...raw, slot_number: 8, tx_callsign: 'NOW', frequency: 500 }, 0),
        normaliseMessage({ ...raw, slot_number: 7, tx_callsign: 'ODD', frequency: 800 }, 1),
        normaliseMessage({ ...raw, slot_number: 6, tx_callsign: 'EVEN2', frequency: 1200 }, 2),
        normaliseMessage({ ...raw, slot_number: 6, tx_callsign: 'EVEN1', frequency: 900 }, 3),
        normaliseMessage({ ...raw, slot_number: 4, tx_callsign: 'OLD', frequency: 1000 }, 4),
    ];
    const got = labelsFor(messages, 8);
    // Slot 6 only, and in frequency order so the layout can pack them.
    assert.deepStrictEqual(got.map((l) => l.callsign), ['EVEN1', 'EVEN2']);
});

t('there is nothing to label until two same-parity slots have been seen', () => {
    assert.deepStrictEqual(labelsFor([], 8), []);
    assert.deepStrictEqual(labelsFor([normaliseMessage({ ...raw, slot_number: 8 }, 0)], 8), []);
    assert.deepStrictEqual(labelsFor([normaliseMessage({ ...raw, slot_number: 8 }, 0)], 0), []);
});

t('crowded labels stack instead of overlapping', () => {
    const labels = [
        { callsign: 'AAA', frequency: 1000 },
        { callsign: 'BBB', frequency: 1010 },   // ~3 px away at this width
        { callsign: 'CCC', frequency: 2500 },
    ];
    const placed = layoutLabels(labels, { width: 900, height: 120, measure: () => 30 });
    assert.strictEqual(placed.length, 3);
    assert.notStrictEqual(placed[0].y, placed[1].y);       // stacked
    assert.strictEqual(placed[2].y, placed[0].y);          // far enough away
    // x is the tone's position in the 0-3 kHz display.
    assert.ok(Math.abs(placed[0].x - (1000 / 3000) * 900) < 0.001);
});

console.log(`\n${pass} extension checks passed`);
