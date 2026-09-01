// The band spectrum SSE decoder, against frames the server's own encoder made.
//
// This stream carries the same "SPEC" frames as the waterfall WebSocket, base64
// wrapped to fit in a text/event-stream. It therefore had the same version 1
// problems: three bytes to move one bin, a 256 dB range at 1 dB steps for data
// occupying about 90, truncation, and a full-scale bin wrapping round to the
// floor -- the last of which is not hypothetical here, since validValues()
// exists to filter exactly that ("the auto range gone mad walk").
//
// Two things this checks that the WebSocket tests do not:
//
//   - the bin widths are not powers of two. Bands run 500-2500 bins and the
//     wideband view is 4096, so the change mask's last byte is partly used and
//     an off-by-one there would corrupt the final bins silently.
//   - version 1 frames must still decode. ?version= is a request an older
//     server ignores, and the frames say which they are, so a new page against
//     an old receiver has to keep working rather than showing nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    applyFrame, dbFromByte, decodeFrame, streamUrl, validValues,
    FRAME_FULL, FRAME_V2_FULL,
} = require('./.build/bandspectrumv2.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const vectors = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'bandspectrumv2.sample.json'), 'utf8'));

// Replays one stream the way the panel does: decode, apply, keep the scale from
// full frames only.
function replay(records) {
    let bins = null, scale;
    const out = [];
    for (const r of records) {
        const frame = decodeFrame(r.data);
        assert.ok(frame, 'frame rejected');
        const next = applyFrame(bins, frame, r.bin_count);
        assert.ok(next, 'applyFrame returned nothing');
        bins = next;
        if (frame.flags === FRAME_FULL || frame.flags === FRAME_V2_FULL) scale = frame.scale;
        // The snapshot is not decoration. applyFrame updates a delta IN PLACE
        // and returns the same array — which is what the panel wants, since it
        // redraws from one buffer — so collecting the returned reference would
        // leave every step pointing at the final state and compare each frame's
        // expectation against it.
        out.push({ bins: Uint8Array.from(bins), scale, expect: r.expect, version: r.version });
    }
    return out;
}

t('a point-free map does not silently produce NaN', () => {
    // dbFromByte's second parameter is the scale, and Array.prototype.map
    // supplies (value, index, array). A `.map(dbFromByte)` therefore passes the
    // index as a scale: index 0 is falsy and looks correct, every bin after it
    // came back NaN. The function validates the shape rather than trusting it.
    const bytes = [0, 1, 2, 200, 255];
    const viaMap = bytes.map(dbFromByte);
    const direct = bytes.map((v) => dbFromByte(v));
    assert.deepStrictEqual(viaMap, direct, 'a point-free map diverged from a direct call');
    for (const v of viaMap) assert.ok(Number.isFinite(v), `got ${v}`);
});

t('the stream is asked for version 2', () => {
    const u = streamUrl('40m');
    assert.ok(u.includes('version=2'), `no version in ${u}`);
    assert.ok(u.includes('band=40m'), `no band in ${u}`);
});

t('version 2 frames decode to what the server encoded', () => {
    const byWidth = new Map();
    for (const r of vectors.filter((v) => v.version === 2)) {
        if (!byWidth.has(r.bin_count)) byWidth.set(r.bin_count, []);
        byWidth.get(r.bin_count).push(r);
    }
    assert.ok(byWidth.size >= 3, 'expected several bin widths');
    let compared = 0;
    for (const [width, records] of byWidth) {
        for (const step of replay(records)) {
            assert.strictEqual(step.bins.length, width, `width ${width}`);
            for (let i = 0; i < width; i++) {
                const got = dbFromByte(step.bins[i], step.scale);
                if (Math.abs(got - step.expect[i]) > 1e-3) {
                    throw new Error(`${width} bins, bin ${i}: got ${got}, server had ${step.expect[i]}`);
                }
                compared++;
            }
        }
        console.log(`      ${width} bins: ok (mask tail ${width % 8 ? 'partial' : 'aligned'})`);
    }
    console.log(`      ${compared} bins identical to the server's reconstruction`);
});

t('version 1 frames still decode, so an older server keeps working', () => {
    const v1 = vectors.filter((v) => v.version === 1);
    assert.ok(v1.length > 0, 'no version 1 records');
    for (const step of replay(v1)) {
        assert.strictEqual(step.scale, undefined, 'a version 1 frame produced a scale');
        for (let i = 0; i < step.bins.length; i++) {
            // With no scale, dbFromByte must fall back to the version 1 mapping.
            assert.strictEqual(dbFromByte(step.bins[i], step.scale), step.expect[i],
                `version 1 bin ${i}`);
        }
    }
    console.log(`      ${v1.length} version 1 frames decoded with the fixed mapping`);
});

t('a version 2 delta is never larger than its full frame', () => {
    const byWidth = new Map();
    for (const r of vectors.filter((v) => v.version === 2)) {
        const cur = byWidth.get(r.bin_count) || { full: 0, delta: 0 };
        const n = Buffer.from(r.data, 'base64').length;
        if (Buffer.from(r.data, 'base64')[5] === 0x05) cur.full = Math.max(cur.full, n);
        else cur.delta = Math.max(cur.delta, n);
        byWidth.set(r.bin_count, cur);
    }
    for (const [width, s] of byWidth) {
        assert.ok(s.delta <= s.full,
            `${width} bins: delta reached ${s.delta} against a full frame of ${s.full}`);
        console.log(`      ${width} bins: largest delta ${s.delta}, full ${s.full}`);
    }
});

t('the scale is taken from full frames only', () => {
    // A delta does not restate the scale, and must not clear it.
    const records = vectors.filter((v) => v.version === 2 && v.bin_count === 1000);
    let bins = null, scale;
    let sawDelta = false;
    for (const r of records) {
        const frame = decodeFrame(r.data);
        bins = applyFrame(bins, frame, r.bin_count);
        if (frame.flags === FRAME_FULL || frame.flags === FRAME_V2_FULL) scale = frame.scale;
        else { sawDelta = true; assert.ok(scale, 'scale lost across a delta'); }
    }
    assert.ok(sawDelta, 'no delta frames in the sample');
});

t('validValues filters the floor at whatever the scale puts it', () => {
    // Version 1's floor is a fixed -256 dB; version 2's is wherever the
    // transmitted reference put it, so a constant test would filter everything
    // or nothing.
    const r = vectors.find((v) => v.version === 2);
    const frame = decodeFrame(r.data);
    const bins = applyFrame(null, frame, r.bin_count);
    const valid = validValues(bins, frame.scale);
    assert.ok(valid && valid.length > bins.length * 0.9,
        `only ${valid ? valid.length : 0} of ${bins.length} bins survived the floor filter`);
});

t('a malformed frame is refused rather than half-applied', () => {
    const r = vectors.filter((v) => v.version === 2 && v.bin_count === 1000);
    let bins = null, scale;
    for (const rec of r) {
        const frame = decodeFrame(rec.data);
        bins = applyFrame(bins, frame, rec.bin_count);
        if (frame.flags === FRAME_V2_FULL) scale = frame.scale;
    }
    const before = Uint8Array.from(bins);
    const deltaRec = r.find((x) => Buffer.from(x.data, 'base64')[5] === 0x06);
    assert.ok(deltaRec, 'no delta to corrupt');
    const raw = Buffer.from(deltaRec.data, 'base64');

    for (const [name, buf] of Object.entries({
        'truncated header': raw.subarray(0, 10),
        'truncated mask': raw.subarray(0, 30),
        'truncated values': raw.subarray(0, raw.length - 4),
    })) {
        const f = decodeFrame(buf.toString('base64'));
        if (!f) continue;               // rejected at decode, also fine
        const after = applyFrame(bins, f, 1000);
        for (let i = 0; i < before.length; i++) {
            assert.strictEqual(after[i], before[i], `${name} modified bin ${i}`);
        }
    }
    assert.ok(scale, 'lost the scale');
});

console.log(`\n${pass} passed`);
