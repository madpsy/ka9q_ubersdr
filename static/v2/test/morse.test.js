// The CW decoder's frames, and the console they fill.
//
// Two things here fail quietly. The frames are packed bytes with a float32 at
// an offset — read one byte out and the pitch is 4e-38 rather than 600, which
// shows as a plausible-looking number in a readout rather than an error. And the
// console's line rule is Morse's only line ending: get it wrong and the copy is
// either one line that grows for ever, timestamped when the session started, or
// a new line for every character.

const assert = require('assert');

const {
    FRAME_DECODE, FRAME_STATS, FRAME_ERROR, QUALITIES, MIN_QUALITIES,
    LINE_GAP_MS, LINE_CHARS, MAX_LINES,
    decodeFrame, appendDecode, passesQuality, positive, toText, visibleChunks,
} = require('./.build/morse.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Frames exactly as audio_extensions/morse/extension.go writes them.
function decodeMsg(text, { conf = 0, cost = 0.1, pitch = 600, speed = 20 } = {}) {
    const body = Buffer.from(text, 'utf8');
    const b = Buffer.alloc(18 + body.length);
    b[0] = FRAME_DECODE;
    b[1] = conf;
    b.writeFloatBE(cost, 2);
    b.writeFloatBE(pitch, 6);
    b.writeFloatBE(speed, 10);
    b.writeUInt32BE(body.length, 14);
    body.copy(b, 18);
    return b;
}

function statsMsg(pitch, speed) {
    const b = Buffer.alloc(9);
    b[0] = FRAME_STATS;
    b.writeFloatBE(pitch, 1);
    b.writeFloatBE(speed, 5);
    return b;
}

function errorMsg(text) {
    const body = Buffer.from(text, 'utf8');
    const b = Buffer.alloc(5 + body.length);
    b[0] = FRAME_ERROR;
    b.writeUInt32BE(body.length, 1);
    body.copy(b, 5);
    return b;
}

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// --- frames ------------------------------------------------------------------

t('a decode frame yields its text, confidence and the decoder’s estimates', () => {
    const f = decodeFrame(asArrayBuffer(decodeMsg('CQ DE W1AW', { conf: 0, cost: 0.25, pitch: 620, speed: 22.5 })));
    assert.strictEqual(f.kind, 'decode');
    assert.strictEqual(f.text, 'CQ DE W1AW');
    assert.strictEqual(f.conf, 'high');
    assert.ok(Math.abs(f.pitch - 620) < 0.01, `pitch ${f.pitch}`);
    assert.ok(Math.abs(f.speed - 22.5) < 0.01, `speed ${f.speed}`);
    assert.ok(Math.abs(f.cost - 0.25) < 0.01, `cost ${f.cost}`);
});

t('the confidence byte maps in the server’s order', () => {
    // 0 is the best, not the worst. Reversing this would colour good copy red
    // and hide the good stuff behind a quality filter.
    assert.deepStrictEqual(QUALITIES, ['high', 'medium', 'low', 'poor']);
    for (let i = 0; i < 4; i++) {
        assert.strictEqual(decodeFrame(asArrayBuffer(decodeMsg('E', { conf: i }))).conf, QUALITIES[i]);
    }
    // Anything the server has not defined is treated as the worst case rather
    // than trusted.
    assert.strictEqual(decodeFrame(asArrayBuffer(decodeMsg('E', { conf: 9 }))).conf, 'poor');
});

t('a stats frame is pitch and speed with no text and no confidence', () => {
    // The absent confidence is load-bearing: the panel merges a stats frame
    // into the readouts, and a `conf: undefined` in there would wipe the
    // quality of the last real decode every time the pitch wobbled. v1 spells
    // out the same rule.
    const f = decodeFrame(asArrayBuffer(statsMsg(437.5, 18)));
    assert.strictEqual(f.kind, 'stats');
    assert.ok(Math.abs(f.pitch - 437.5) < 0.01);
    assert.ok(Math.abs(f.speed - 18) < 0.01);
    assert.strictEqual(f.text, undefined);
    assert.ok(!('conf' in f), 'a stats frame must not carry a confidence');
});

t('an error frame carries the subprocess’s own message', () => {
    // The one failure the operator can act on: the decoder is a separate binary
    // that may simply not be installed.
    const f = decodeFrame(asArrayBuffer(errorMsg('cw-decoder binary not found at /usr/local/bin/cw-decoder')));
    assert.strictEqual(f.kind, 'error');
    assert.match(f.message, /cw-decoder binary not found/);
});

t('a truncated or unknown frame is dropped, not guessed at', () => {
    assert.strictEqual(decodeFrame(asArrayBuffer(decodeMsg('CQ').subarray(0, 12))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(statsMsg(600, 20).subarray(0, 5))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([0x99]))), null);
    assert.strictEqual(decodeFrame(null), null);
    // A length running past the end of the frame is truncation, not licence to
    // read whatever follows it in the buffer.
    const bad = decodeMsg('CQ');
    bad.writeUInt32BE(9999, 14);
    assert.strictEqual(decodeFrame(asArrayBuffer(bad)), null);
});

t('a frame arrives as an ArrayBuffer or a view of one', () => {
    const b = decodeMsg('CQ');
    assert.strictEqual(decodeFrame(asArrayBuffer(b)).text, 'CQ');
    assert.strictEqual(decodeFrame(new Uint8Array(asArrayBuffer(b))).text, 'CQ');
    // A view at a non-zero offset must be read from the view, not the buffer.
    const padded = Buffer.concat([Buffer.alloc(3), b]);
    const view = new Uint8Array(asArrayBuffer(padded), 3);
    assert.strictEqual(decodeFrame(view).text, 'CQ');
});

// --- the console ---------------------------------------------------------------

const at0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const add = (lines, text, conf, at) => appendDecode(lines, { text, conf, at });
const lineText = (l) => l.chunks.map((c) => c.text).join('');

t('characters arriving in dribs and drabs build one line', () => {
    // ggmorse sends a character or two per event, so a line is assembled over
    // dozens of frames.
    let lines = [];
    for (const c of 'CQ DE W1AW') lines = add(lines, c, 'high', at0);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lineText(lines[0]), 'CQ DE W1AW');
});

t('a run of the same confidence is one chunk, a change starts another', () => {
    // One span per character would be thousands of DOM nodes for a page of copy.
    let lines = add([], 'CQ', 'high', at0);
    lines = add(lines, ' DE', 'high', at0);
    lines = add(lines, ' ?', 'poor', at0);
    assert.deepStrictEqual(lines[0].chunks.map((c) => [c.conf, c.text]), [
        ['high', 'CQ DE'],
        ['poor', ' ?'],
    ]);
});

t('a gap in the sending ends the line', () => {
    // Morse has no line ending, so this is the only one there is — and without
    // it the timestamp would say when the session started.
    let lines = add([], 'CQ', 'high', at0);
    lines = add(lines, 'K', 'high', at0 + LINE_GAP_MS + 1);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1].at, at0 + LINE_GAP_MS + 1);
    // A pause shorter than that is a word gap, not a new transmission.
    let same = add([], 'CQ', 'high', at0);
    same = add(same, 'K', 'high', at0 + LINE_GAP_MS - 1);
    assert.strictEqual(same.length, 1);
});

t('a station that never pauses still produces more than one line', () => {
    // Otherwise the line cap never trims and the console grows all session.
    let lines = [];
    for (let i = 0; i < LINE_CHARS * 3; i++) lines = add(lines, 'E', 'high', at0);
    assert.ok(lines.length >= 3, `expected several lines, got ${lines.length}`);
    for (const l of lines) assert.ok(l.chars <= LINE_CHARS + 1, `line of ${l.chars} characters`);
});

t('the console is capped, dropping the oldest', () => {
    let lines = [];
    for (let i = 0; i < MAX_LINES + 20; i++) {
        lines = add(lines, `line ${i}`, 'high', at0 + i * (LINE_GAP_MS + 1));
    }
    assert.strictEqual(lines.length, MAX_LINES);
    assert.strictEqual(lineText(lines[lines.length - 1]), `line ${MAX_LINES + 19}`);
});

t('appending never writes through the previous state', () => {
    // The caller's array is React state; mutating it would leave the console
    // showing text a re-render was never told about.
    const first = add([], 'CQ', 'high', at0);
    const snapshot = JSON.stringify(first);
    const second = add(first, ' DE', 'high', at0);
    assert.strictEqual(JSON.stringify(first), snapshot);
    assert.strictEqual(lineText(second[0]), 'CQ DE');
});

t('control characters are dropped but a newline still breaks the line', () => {
    let lines = add([], 'CQ\x00\x07 DE', 'high', at0);
    assert.strictEqual(lineText(lines[0]), 'CQ DE');
    lines = add(lines, '\nK', 'high', at0);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lineText(lines[1]), 'K');
});

t('empty text changes nothing', () => {
    const lines = add([], '', 'high', at0);
    assert.strictEqual(lines.length, 0);
});

// --- the quality filter ---------------------------------------------------------

t('the filter is a view: nothing is thrown away on the way in', () => {
    // v1 dropped filtered text as it arrived, so raising the threshold hid what
    // was on screen and lowering it showed nothing new.
    let lines = add([], 'CQ', 'high', at0);
    lines = add(lines, '??', 'poor', at0);
    assert.strictEqual(lineText(lines[0]), 'CQ??');
    assert.strictEqual(visibleChunks(lines[0], 'all').length, 2);
    assert.strictEqual(visibleChunks(lines[0], 'medium').map((c) => c.text).join(''), 'CQ');
    // ...and turning it back down shows the poor copy again.
    assert.strictEqual(visibleChunks(lines[0], 'all').map((c) => c.text).join(''), 'CQ??');
});

t('each threshold admits itself and everything better', () => {
    for (const { id } of MIN_QUALITIES) {
        assert.ok(passesQuality('high', id), `high should pass ${id}`);
    }
    assert.ok(passesQuality('poor', 'all'));
    assert.ok(!passesQuality('poor', 'low'));
    assert.ok(passesQuality('low', 'low'));
    assert.ok(!passesQuality('low', 'medium'));
    assert.ok(passesQuality('medium', 'medium'));
    assert.ok(!passesQuality('medium', 'high'));
});

t('what you save is what you were reading', () => {
    let lines = add([], 'CQ', 'high', at0);
    lines = add(lines, '??', 'poor', at0);
    lines = add(lines, 'K', 'high', at0 + LINE_GAP_MS + 1);

    assert.strictEqual(toText(lines, { minQuality: 'all' }), 'CQ??\nK');
    assert.strictEqual(toText(lines, { minQuality: 'medium' }), 'CQ\nK');
    assert.strictEqual(
        toText(lines, { minQuality: 'all', timestamps: true }),
        '[12:00:00] CQ??\n[12:00:10] K',
    );
});

t('a line the filter empties is dropped from the export, not saved blank', () => {
    let lines = add([], '??', 'poor', at0);
    lines = add(lines, 'CQ', 'high', at0 + LINE_GAP_MS + 1);
    assert.strictEqual(toText(lines, { minQuality: 'high' }), 'CQ');
});

// --- readouts ---------------------------------------------------------------------

t('a pitch or speed the decoder has not found yet reads as nothing', () => {
    // ggmorse reports zero until it locks on, and "0 Hz" is a claim about the
    // signal rather than an admission there isn't one yet.
    assert.strictEqual(positive(0), null);
    assert.strictEqual(positive(-1), null);
    assert.strictEqual(positive(NaN), null);
    assert.strictEqual(positive(600), 600);
});

console.log(`\nall ${pass} CW decoder tests passed`);
