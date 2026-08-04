// SSTV: the nine-message protocol, and the ordering rules that come with it.
//
// The frames are the usual packed-byte hazard — a wrong offset paints noise
// that looks like a bad signal. But the harder failures here are the ordering
// ones, which produce a perfectly good picture with the wrong label on it: the
// mode arrives before the picture it describes, and a redraw is the *same*
// picture again with a mode message in the middle of it that belongs to the
// next transmission.

const assert = require('assert');

const {
    FRAME_LINE, FRAME_MODE, FRAME_STATUS, FRAME_SYNC, FRAME_COMPLETE,
    FRAME_CALLSIGN, FRAME_START, FRAME_REDRAW, FRAME_TONE,
    SSTV_CONFIG, SSTV_FREQUENCIES, KEEP_IMAGES, MIN_KEEPABLE_LINES,
    decodeFrame, toRGBA, attachParams, progressOf, keepOnComplete,
} = require('./.build/sstv.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const decode = (b) => decodeFrame(asArrayBuffer(b));

// Frames exactly as audio_extensions/sstv/decoder.go writes them.
function lineFrame(line, rgb) {
    const b = Buffer.alloc(9 + rgb.length);
    b[0] = FRAME_LINE;
    b.writeUInt32BE(line, 1);
    b.writeUInt32BE(rgb.length / 3, 5);
    Buffer.from(rgb).copy(b, 9);
    return b;
}
function modeFrame(name, { index = 44, extended = 0 } = {}) {
    const n = Buffer.from(name, 'utf8');
    const b = Buffer.alloc(4 + n.length);
    b[0] = FRAME_MODE;
    b[1] = index;
    b[2] = extended;
    b[3] = n.length;
    n.copy(b, 4);
    return b;
}
function statusFrame(text, code = 0) {
    const n = Buffer.from(text, 'utf8');
    const b = Buffer.alloc(4 + n.length);
    b[0] = FRAME_STATUS;
    b[1] = code;
    b.writeUInt16BE(n.length, 2);
    n.copy(b, 4);
    return b;
}
function callsignFrame(call) {
    const n = Buffer.from(call, 'utf8');
    const b = Buffer.alloc(2 + n.length);
    b[0] = FRAME_CALLSIGN;
    b[1] = n.length;
    n.copy(b, 2);
    return b;
}

// --- frames -----------------------------------------------------------------

t('an image start carries the geometry the mode implies', () => {
    const b = Buffer.alloc(9);
    b[0] = FRAME_START;
    b.writeUInt32BE(320, 1);
    b.writeUInt32BE(256, 5);
    assert.deepStrictEqual(decode(b), { kind: 'start', width: 320, height: 256 });
});

t('a mode message carries the name the VIS decoded', () => {
    const f = decode(modeFrame('Martin M1'));
    assert.strictEqual(f.kind, 'mode');
    assert.strictEqual(f.name, 'Martin M1');
    assert.strictEqual(f.index, 44);
    assert.strictEqual(f.extended, false);
    assert.strictEqual(decode(modeFrame('PD-120', { extended: 1 })).extended, true);
});

t('a scanline is three bytes a pixel, starting at byte 9', () => {
    // One byte out and every line is shifted a third of a pixel, which comes
    // out as a colour cast down the whole picture rather than as an error.
    const rgb = [];
    for (let x = 0; x < 320; x++) rgb.push(x % 256, (x * 3) % 256, (x * 7) % 256);
    const f = decode(lineFrame(17, rgb));
    assert.strictEqual(f.kind, 'line');
    assert.strictEqual(f.line, 17);
    assert.strictEqual(f.width, 320);
    assert.strictEqual(f.rgb.length, 960);
    assert.deepStrictEqual(Array.from(f.rgb.subarray(0, 3)), [0, 0, 0]);
    assert.deepStrictEqual(Array.from(f.rgb.subarray(957)), [319 % 256, (319 * 3) % 256, (319 * 7) % 256]);
});

t('a line whose width disagrees with its length is dropped', () => {
    const b = lineFrame(0, [1, 2, 3, 4, 5, 6]);
    b.writeUInt32BE(900, 5);
    assert.strictEqual(decode(b), null);
    // Three bytes a pixel: a length that is not a multiple of three cannot be
    // the width it claims.
    const odd = Buffer.alloc(9 + 5);
    odd[0] = FRAME_LINE;
    odd.writeUInt32BE(0, 1);
    odd.writeUInt32BE(2, 5);
    assert.strictEqual(decode(odd), null);
});

t('status, sync, complete and callsign read where the server put them', () => {
    assert.deepStrictEqual(decode(statusFrame('Decoding')), { kind: 'status', code: 0, text: 'Decoding' });

    assert.deepStrictEqual(decode(Buffer.from([FRAME_SYNC, 200])), { kind: 'sync', quality: 200 });

    const done = Buffer.alloc(5);
    done[0] = FRAME_COMPLETE;
    done.writeUInt32BE(256, 1);
    assert.deepStrictEqual(decode(done), { kind: 'complete', lines: 256 });

    assert.strictEqual(decode(callsignFrame('G0ABC ')).callsign, 'G0ABC', 'trimmed');
    assert.deepStrictEqual(decode(Buffer.from([FRAME_REDRAW])), { kind: 'redraw' });
});

t('the tone readout keeps its tenths', () => {
    // Sent as tenths of a hertz because the fraction is what says whether the
    // receiver is on frequency — 1200.0 is a header, 1198.4 is not quite.
    const b = Buffer.alloc(5);
    b[0] = FRAME_TONE;
    b.writeUInt32BE(11984, 1);
    assert.strictEqual(decode(b).hz, 1198.4);
});

t('a frame that is truncated or unknown is dropped, not thrown on', () => {
    assert.strictEqual(decode(Buffer.from([FRAME_START, 0, 0])), null);
    assert.strictEqual(decode(Buffer.from([FRAME_COMPLETE])), null);
    assert.strictEqual(decode(Buffer.from([FRAME_TONE, 0])), null);
    assert.strictEqual(decode(Buffer.from([0x7f, 1, 2])), null);
    assert.strictEqual(decode(Buffer.alloc(0)), null);
    assert.strictEqual(decodeFrame(null), null);
    assert.strictEqual(decodeFrame('not binary'), null);
    // A declared length running past the frame is a truncated frame, not a
    // reason to decode whatever bytes happen to follow.
    const liar = modeFrame('M1');
    liar[3] = 90;
    assert.strictEqual(decode(liar), null);
    const liar2 = statusFrame('hi');
    liar2.writeUInt16BE(900, 2);
    assert.strictEqual(decode(liar2), null);
});

t('a frame read from a view starts at the view, not the buffer', () => {
    const padded = Buffer.concat([Buffer.alloc(6), callsignFrame('M0XYZ')]);
    assert.strictEqual(decodeFrame(padded.subarray(6)).callsign, 'M0XYZ');
});

// --- pixels -----------------------------------------------------------------

t('RGB triples become opaque RGBA in the same order', () => {
    // Getting this wrong swaps red and blue, which on an SSTV picture of a sky
    // looks like a decoder fault rather than a channel swap.
    const rgba = toRGBA(Uint8Array.from([10, 20, 30, 40, 50, 60]), 2);
    assert.deepStrictEqual(Array.from(rgba), [10, 20, 30, 255, 40, 50, 60, 255]);
});

t('the RGBA scratch buffer is reused, not reallocated per line', () => {
    const buf = new Uint8ClampedArray(4 * 8);
    assert.strictEqual(toRGBA(Uint8Array.from([1, 2, 3]), 1, buf), buf);
    const small = new Uint8ClampedArray(4);
    assert.notStrictEqual(toRGBA(Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, small), small);
});

t('progress is a fraction, and is zero before a picture starts', () => {
    // Reporting 100% for a zero-height picture would draw a full bar over an
    // empty frame.
    assert.strictEqual(progressOf(128, 256), 0.5);
    assert.strictEqual(progressOf(0, 0), 0);
    assert.strictEqual(progressOf(10, 0), 0);
    assert.strictEqual(progressOf(999, 256), 1, 'clamped');
});

// --- the ordering rules -----------------------------------------------------

t('a picture is filed on the completion that follows the redraw, not the first', () => {
    // With slant correction on the server completes twice: once after the raw
    // pass and again after re-sending every line corrected. Filing on the first
    // puts the leaning version in the gallery as well as the straight one, so
    // every transmission appears twice.
    assert.strictEqual(keepOnComplete({ autoSync: true, redrawn: false }), false);
    assert.strictEqual(keepOnComplete({ autoSync: true, redrawn: true }), true);
});

t('with correction off, the only completion is the one to file on', () => {
    // No redraw is coming, so waiting for one would never file anything.
    assert.strictEqual(keepOnComplete({ autoSync: false, redrawn: false }), true);
    assert.strictEqual(keepOnComplete({ autoSync: false, redrawn: true }), true);
});

// --- settings ---------------------------------------------------------------

t('the attach carries the three settings the server reads', () => {
    // audio_extensions/sstv/extension.go reads these and nothing else.
    // auto_save is deliberately absent: it is what the client does with a
    // finished picture, and the server has no business knowing.
    assert.deepStrictEqual(Object.keys(attachParams(SSTV_CONFIG)).sort(), [
        'auto_sync', 'decode_fsk_id', 'mmsstv_only',
    ]);
    // Booleans as booleans: Go's type assertion drops anything else and keeps
    // its own default, which is the opposite of two of these.
    const p = attachParams({ auto_sync: 'yes', decode_fsk_id: 0, mmsstv_only: 1 });
    assert.strictEqual(p.auto_sync, true);
    assert.strictEqual(p.decode_fsk_id, false);
    assert.strictEqual(p.mmsstv_only, true);
});

t('slant correction and the FSK ident are on by default', () => {
    // Without auto-sync every picture leans, which reads as a broken decoder.
    assert.strictEqual(SSTV_CONFIG.auto_sync, true);
    assert.strictEqual(SSTV_CONFIG.decode_fsk_id, true);
    assert.strictEqual(SSTV_CONFIG.mmsstv_only, false);
    assert.ok(KEEP_IMAGES > 0 && MIN_KEEPABLE_LINES > 0);
});

// --- frequencies ------------------------------------------------------------

t('the menu says which calling frequency the receiver is on', () => {
    assert.ok(tunedOption(SSTV_FREQUENCIES, 14230000).label.includes('primary'));
    assert.strictEqual(tunedOption(SSTV_FREQUENCIES, 14200000), null);
});

t('no frequency is offered twice', () => {
    // v1 listed 14.230 under both "most active" and 20 m. Two entries with the
    // same frequency cannot both be the selected one when the menu shows where
    // the receiver is.
    const all = SSTV_FREQUENCIES.flatMap((g) => g.options);
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
    assert.strictEqual(all.length, 8);
    for (const o of all) {
        assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
        assert.ok(o.label, `${o.hz} has no label`);
    }
});

console.log(`\n${pass} SSTV checks passed`);
