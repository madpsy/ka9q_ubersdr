// WEFAX: the scanline protocol, and the rules for turning it into pages.
//
// The failure modes here are pictures rather than exceptions. A misread offset
// paints noise that looks like a bad signal; a missed page boundary draws the
// next chart over the last one and reads as interference; a growth rule that
// clears the canvas loses the top of the page and looks like the transmission
// started late. None of them throw.

const assert = require('assert');

const {
    FRAME_LINE, FRAME_START, FRAME_STOP,
    LPM_OPTIONS, BANDWIDTHS, LIMITS, WEFAX_CONFIG, WEFAX_STATIONS,
    INITIAL_LINES, MAX_IMAGE_LINES,
    decodeFrame, attachParams, growTo, startsNewImage, toRGBA, lineSeconds, stationAt,
} = require('./.build/wefax.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// One frame exactly as audio_extensions/wefax/decoder.go writes it:
// [type:1][line:4 BE][width:4 BE][grey pixels:width].
function lineFrame(line, pixels) {
    const b = Buffer.alloc(9 + pixels.length);
    b[0] = FRAME_LINE;
    b.writeUInt32BE(line, 1);
    b.writeUInt32BE(pixels.length, 5);
    Buffer.from(pixels).copy(b, 9);
    return b;
}

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// --- frames ----------------------------------------------------------------

t('a scanline carries its number, its width and its pixels', () => {
    const f = decodeFrame(asArrayBuffer(lineFrame(417, [0, 128, 255])));
    assert.strictEqual(f.kind, 'line');
    assert.strictEqual(f.line, 417);
    assert.strictEqual(f.width, 3);
    assert.deepStrictEqual(Array.from(f.pixels), [0, 128, 255]);
});

t('a full-width line reads to its last pixel', () => {
    // 1809 is the default width and the one place an off-by-one would show up
    // as a black or white column down the edge of every chart.
    const pixels = Array.from({ length: 1809 }, (_, i) => i % 256);
    const f = decodeFrame(asArrayBuffer(lineFrame(0, pixels)));
    assert.strictEqual(f.pixels.length, 1809);
    assert.strictEqual(f.pixels[0], 0);
    assert.strictEqual(f.pixels[1808], 1808 % 256);
});

t('a line read from a view starts at the view, not the buffer', () => {
    const b = lineFrame(5, [10, 20]);
    const padded = Buffer.concat([Buffer.alloc(3), b]);
    const f = decodeFrame(padded.subarray(3));
    assert.strictEqual(f.line, 5);
    assert.deepStrictEqual(Array.from(f.pixels), [10, 20]);
});

t('the start and stop tones are frames of their own', () => {
    assert.deepStrictEqual(decodeFrame(asArrayBuffer(Buffer.from([FRAME_START]))), { kind: 'start' });
    assert.deepStrictEqual(decodeFrame(asArrayBuffer(Buffer.from([FRAME_STOP]))), { kind: 'stop' });
});

t('a frame whose width disagrees with its length is dropped', () => {
    // Painting it anyway would draw whatever bytes happen to follow, which on a
    // canvas is indistinguishable from a noisy line.
    const b = lineFrame(1, [1, 2, 3]);
    b.writeUInt32BE(900, 5);
    assert.strictEqual(decodeFrame(asArrayBuffer(b)), null);
    const empty = lineFrame(1, []);
    assert.strictEqual(decodeFrame(asArrayBuffer(empty)), null);
});

t('a frame that is not one of the three is dropped, not thrown on', () => {
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([0x09]))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.alloc(0))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([FRAME_LINE, 0, 0]))), null);
    assert.strictEqual(decodeFrame(null), null);
    assert.strictEqual(decodeFrame('not binary'), null);
});

// --- the page --------------------------------------------------------------

t('a line number that has gone backwards is a new page', () => {
    // The server resets its counter on a start tone, so this is how a new chart
    // announces itself when the start frame itself was lost in the noise.
    assert.strictEqual(startsNewImage(0, 940), true);
    assert.strictEqual(startsNewImage(941, 940), false);
    // The first line of a session continues nothing.
    assert.strictEqual(startsNewImage(0, null), false);
});

t('filling the page is also the end of it', () => {
    // Without this an unattended session with no stop tone would ask the
    // browser for an ever-taller bitmap until it failed to allocate.
    assert.strictEqual(startsNewImage(MAX_IMAGE_LINES, MAX_IMAGE_LINES - 1), true);
    assert.strictEqual(startsNewImage(MAX_IMAGE_LINES - 1, MAX_IMAGE_LINES - 2), false);
});

t('the canvas grows by doubling, and stops at the cap', () => {
    // Growing means copying the bitmap, so growing a line at a time would copy
    // the whole page twice a second.
    assert.strictEqual(growTo(INITIAL_LINES, INITIAL_LINES), INITIAL_LINES);
    assert.strictEqual(growTo(INITIAL_LINES, INITIAL_LINES + 1), INITIAL_LINES * 2);
    assert.strictEqual(growTo(512, 2000), 2048);
    assert.strictEqual(growTo(512, 9999), MAX_IMAGE_LINES);
});

t('grey pixels become opaque grey RGBA', () => {
    const rgba = toRGBA(Uint8Array.from([0, 128, 255]));
    assert.deepStrictEqual(Array.from(rgba), [
        0, 0, 0, 255,
        128, 128, 128, 255,
        255, 255, 255, 255,
    ]);
});

t('the RGBA scratch buffer is reused, not reallocated per line', () => {
    // A line is 7 kB of RGBA at the default width; allocating that twice a
    // second for an hour is 50 MB of garbage for nothing.
    const buf = new Uint8ClampedArray(4 * 8);
    const out = toRGBA(Uint8Array.from([1, 2]), buf);
    assert.strictEqual(out, buf, 'a big enough buffer is used as given');
    // Too small, and a new one is made rather than half a line being painted.
    const small = new Uint8ClampedArray(4);
    assert.notStrictEqual(toRGBA(Uint8Array.from([1, 2]), small), small);
});

t('a page is timed by its line rate', () => {
    assert.strictEqual(lineSeconds(120), 0.5);
    assert.strictEqual(lineSeconds(60), 1);
    // A nonsense rate must not make the readout NaN or divide by zero.
    assert.strictEqual(lineSeconds(0), 0.5);
    assert.strictEqual(lineSeconds(undefined), 0.5);
});

// --- settings --------------------------------------------------------------

t('the defaults are the ones a fax machine would use', () => {
    assert.strictEqual(WEFAX_CONFIG.lpm, 120);
    assert.strictEqual(WEFAX_CONFIG.carrier, 1900);
    assert.strictEqual(WEFAX_CONFIG.deviation, 400);
    assert.strictEqual(WEFAX_CONFIG.image_width, 1809);
    // The three that make it draw one page per transmission rather than one
    // continuous roll. The backend ships the automatic pair off; v1's template
    // turned them on, and so does this.
    assert.strictEqual(WEFAX_CONFIG.use_phasing, true);
    assert.strictEqual(WEFAX_CONFIG.auto_start, true);
    assert.strictEqual(WEFAX_CONFIG.auto_stop, true);
});

t('the attach carries the field names the server reads', () => {
    // audio_extensions/wefax/extension.go reads these and ignores anything
    // else, silently keeping its own default.
    assert.deepStrictEqual(Object.keys(attachParams(WEFAX_CONFIG)).sort(), [
        'auto_start', 'auto_stop', 'bandwidth', 'carrier', 'deviation',
        'image_width', 'lpm', 'use_phasing',
    ]);
});

t('a setting the server would refuse is clamped, not sent', () => {
    const p = attachParams({
        lpm: 137, image_width: 99999, carrier: -5, deviation: 5000, bandwidth: 9,
    });
    // LPM is a menu, not a range: an unlisted rate falls back rather than
    // clamping to 300, which no service transmits.
    assert.strictEqual(p.lpm, WEFAX_CONFIG.lpm);
    assert.strictEqual(p.image_width, LIMITS.image_width.max);
    assert.strictEqual(p.carrier, LIMITS.carrier.min);
    assert.strictEqual(p.deviation, LIMITS.deviation.max);
    assert.strictEqual(p.bandwidth, WEFAX_CONFIG.bandwidth);
    // The booleans are booleans: Go's type assertion drops anything else and
    // falls back to its own default, which is the opposite of two of these.
    assert.strictEqual(p.use_phasing, false);
    assert.strictEqual(p.auto_start, false);
});

t('the width is a whole number of pixels', () => {
    // A fractional width would be rejected by the server's int conversion in a
    // way that is hard to see: it truncates rather than erroring.
    assert.strictEqual(attachParams({ ...WEFAX_CONFIG, image_width: 1809.6 }).image_width, 1810);
    assert.strictEqual(Number.isInteger(attachParams(WEFAX_CONFIG).image_width), true);
});

t('every bandwidth the menu offers is one the server accepts', () => {
    assert.deepStrictEqual(BANDWIDTHS.map((b) => b.value), [0, 1, 2]);
    for (const b of BANDWIDTHS) {
        assert.strictEqual(attachParams({ ...WEFAX_CONFIG, bandwidth: b.value }).bandwidth, b.value);
    }
    assert.deepStrictEqual(LPM_OPTIONS, [60, 90, 120, 240]);
});

// --- stations --------------------------------------------------------------

t('the station menu says which one the receiver is on', () => {
    // The entries are assigned frequencies and the dial sits a carrier below
    // one — v1's tuneToStation arithmetic, run backwards.
    const dial = 7880000 - WEFAX_CONFIG.carrier;
    assert.ok(tunedOption(WEFAX_STATIONS, dial + WEFAX_CONFIG.carrier).label.includes('DDH47'));
    assert.strictEqual(tunedOption(WEFAX_STATIONS, dial + 5000), null);
});

t('every station entry is reachable, distinct and carries a rate', () => {
    const all = WEFAX_STATIONS.flatMap((g) => g.options);
    assert.strictEqual(all.length, 21);
    for (const o of all) {
        assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
        assert.ok(o.label, `${o.hz} has no label`);
        // Choosing a station sets its rate too, as v1's menu did, so an entry
        // without one would silently leave the last station's rate in place.
        assert.ok(LPM_OPTIONS.includes(o.lpm), `${o.label} has no usable lpm`);
    }
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
});

t('a station can be looked up by its assigned frequency', () => {
    assert.strictEqual(stationAt(3855000).lpm, 120);
    assert.strictEqual(stationAt(1), null);
});

console.log(`\n${pass} WEFAX checks passed`);
