// QRSS: the zoom-FFT chain, and the arithmetic the axes are labelled from.
//
// This is the one extension whose numbers are entirely the client's — nothing
// on the server can be blamed for them — and a QRSS display is read to the
// hertz and the second, so the axes are load-bearing. A decimation off by one
// misplaces every beacon; a bin map that drops a row loses the one row a
// carrier occupies; an FFT that is subtly wrong still draws a plausible
// waterfall of noise.

const assert = require('assert');

const {
    FFT, COLORMAPS, PALETTES, SPANS, SPEEDS, WINDOWS, RESOLUTIONS, AUTO_LEVELS,
    QRSS_CONFIG, QRSS_BANDS, FULL_VIEW,
    buildColorLUT, hannWindow, designLowpass, derive, buildBinMap, powerColumn,
    colorColumn, median, trackFloor, autoSpanOf, niceStep, fmtDuration, fmtShort,
    zoomView, panView, pointToFreqTime,
} = require('./.build/qrssdsp.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- FFT --------------------------------------------------------------------

t('the FFT puts a complex tone in the bin it belongs in', () => {
    // A complex exponential at bin k must land in bin k and nowhere else. This
    // is the check that catches a wrong twiddle sign, which otherwise mirrors
    // the whole display about its centre frequency and looks fine.
    const N = 64;
    const k = 7;
    const fft = new FFT(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        re[i] = Math.cos(2 * Math.PI * k * i / N);
        im[i] = Math.sin(2 * Math.PI * k * i / N);
    }
    fft.transform(re, im);
    const mag = Array.from({ length: N }, (_, i) => Math.hypot(re[i], im[i]));
    let peak = 0;
    for (let i = 1; i < N; i++) if (mag[i] > mag[peak]) peak = i;
    assert.strictEqual(peak, k);
    close(mag[k], N, 1e-3, 'peak height');
    // Everything else is noise floor, not a second lobe.
    for (let i = 0; i < N; i++) if (i !== k) assert.ok(mag[i] < 1e-3, `bin ${i} leaked ${mag[i]}`);
});

t('a negative frequency lands on the other side of the centre', () => {
    // The complex spectrum is not symmetric, which is the whole reason for
    // down-converting: a beacon 3 Hz below the centre must draw below it.
    const N = 64;
    const fft = new FFT(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        re[i] = Math.cos(-2 * Math.PI * 5 * i / N);
        im[i] = Math.sin(-2 * Math.PI * 5 * i / N);
    }
    fft.transform(re, im);
    const mag = Array.from({ length: N }, (_, i) => Math.hypot(re[i], im[i]));
    let peak = 0;
    for (let i = 1; i < N; i++) if (mag[i] > mag[peak]) peak = i;
    assert.strictEqual(peak, N - 5, 'a negative bin wraps to the top of the array');
});

t('the window and the anti-alias filter are the shapes they claim to be', () => {
    const w = hannWindow(1024);
    close(w[0], 0, 1e-6, 'Hann starts at zero');
    close(w[512], 1, 1e-3, 'Hann peaks in the middle');

    // Unity gain at DC, or every decimation would change the level and the
    // colour scale with it.
    const h = designLowpass(240);
    close(h.reduce((a, b) => a + b, 0), 1, 1e-5, 'filter DC gain');
    assert.strictEqual(h.length % 2, 1, 'an odd tap count, for linear phase');
    // No filter is needed when nothing is thrown away.
    assert.deepStrictEqual(Array.from(designLowpass(1)), [1]);
});

// --- the capture chain ------------------------------------------------------

t('the decimation gives about the span that was asked for', () => {
    const d = derive({ ...QRSS_CONFIG, span: 200 }, 48000, 600);
    assert.strictEqual(d.decim, 240);
    assert.strictEqual(d.decSR, 200);
    // Default centre puts the view at [0, span], so the display starts at DC.
    assert.strictEqual(d.fc, 100);
    assert.strictEqual(d.lo, 0);
    assert.strictEqual(d.hi, 200);
    // 200 Hz over 2048 bins is a tenth of a hertz, which is the point of QRSS.
    close(d.binHz, 200 / 2048, 1e-9, 'bin width');
});

t('every span the menu offers decimates to something usable', () => {
    for (const span of SPANS) {
        const d = derive({ ...QRSS_CONFIG, span }, 48000, 600);
        assert.ok(d.decim >= 1, `${span}: decimation`);
        // Within a few percent of what was asked: the decimation is an integer,
        // so the achieved span is quantised, and the axes are drawn from the
        // achieved one rather than the requested one.
        assert.ok(Math.abs(d.decSR - span) / span < 0.05, `${span}: got ${d.decSR}`);
    }
});

t('the hop is the requested seconds per pixel, in samples', () => {
    const d = derive({ ...QRSS_CONFIG, span: 200, secPerPixel: 5 }, 48000, 600);
    assert.strictEqual(d.hop, 1000);            // 5 s × 200 Hz
    close(d.secPerCol, 5, 1e-9, 'seconds per column');
    // Never zero, or the ingest loop would emit a column per sample.
    assert.ok(derive({ ...QRSS_CONFIG, secPerPixel: 0 }, 48000, 600).hop >= 1);
});

t('locking the window derives the speed from the width', () => {
    // This is what makes a 10-minute grabber still show 10 minutes after the
    // panel is widened — the thing Speed alone cannot do.
    const wide = derive({ ...QRSS_CONFIG, windowSec: 600 }, 48000, 600);
    const narrow = derive({ ...QRSS_CONFIG, windowSec: 600 }, 48000, 300);
    close(wide.secPerCol * 600, 600, 1, 'sweep at 600 px');
    close(narrow.secPerCol * 300, 600, 1, 'sweep at 300 px');
    assert.ok(narrow.secPerPixel > wide.secPerPixel);
    // Auto (0) leaves the chosen speed alone.
    assert.strictEqual(derive({ ...QRSS_CONFIG, windowSec: 0, secPerPixel: 3 }, 48000, 600).secPerPixel, 3);
});

t('the centre frequency stays inside the audio that exists', () => {
    assert.strictEqual(derive({ ...QRSS_CONFIG, centerHz: 99999 }, 48000, 600).fc, 24000);
    assert.strictEqual(derive({ ...QRSS_CONFIG, centerHz: -50 }, 48000, 600).fc, 0);
});

// --- pixels -----------------------------------------------------------------

t('the bin map covers every row with no gap and no overlap', () => {
    // A gap loses the one row a QRSS carrier occupies, which is the entire
    // signal; an overlap draws it twice and makes it look wider than it is.
    const N = 2048;
    const H = 300;
    const map = buildBinMap(N, H);
    assert.strictEqual(map.length, H * 2);
    for (let y = 0; y + 1 < H; y++) {
        const start = map[y * 2];
        const count = map[y * 2 + 1];
        assert.ok(count >= 1, `row ${y} covers no bins`);
        // Rows run top (highest frequency) to bottom, so the row below ends
        // exactly where this one starts: no bin is skipped and none is drawn
        // twice.
        assert.strictEqual(map[(y + 1) * 2] + map[(y + 1) * 2 + 1], start, `row ${y}/${y + 1} do not meet`);
        assert.ok(count >= 1 && start + count <= N / 2, `row ${y} runs off the top`);
    }
    // The top row reaches the top of the spectrum and the bottom the bottom.
    assert.strictEqual(map[0] + map[1], N / 2);
    assert.strictEqual(map[(H - 1) * 2], -N / 2);
});

t('a pixel takes the strongest bin it covers, not their average', () => {
    // Averaging a one-bin carrier with its empty neighbours is exactly how you
    // lose the signal you zoomed in to see.
    const N = 8;
    const re = new Float32Array([0, 0, 0, 4, 0, 0, 0, 0]);
    const im = new Float32Array(N);
    // One row covering the whole spectrum.
    const map = buildBinMap(N, 1);
    const col = powerColumn(re, im, map, N);
    const expected = 10 * Math.log10((4 * (1 / (N * 0.5))) ** 2 + 1e-20);
    close(col[0], expected, 1e-6, 'peak power');
});

t('an empty spectrum is a floor, not negative infinity', () => {
    // log10(0) would paint NaN, which a canvas renders as transparent — a
    // silent hole in the waterfall rather than a black column.
    const col = powerColumn(new Float32Array(8), new Float32Array(8), buildBinMap(8, 2), 8);
    assert.ok(Number.isFinite(col[0]) && col[0] < -100);
});

t('colouring clamps outside the range instead of wrapping', () => {
    const lut = buildColorLUT('grayscale');
    const px = colorColumn(Float32Array.from([-200, -85, 0]), lut, -110, -60);
    assert.deepStrictEqual(Array.from(px.slice(0, 4)), [0, 0, 0, 255], 'below the floor is black');
    assert.deepStrictEqual(Array.from(px.slice(8, 12)), [255, 255, 255, 255], 'above the peak is white');
    // Halfway is mid grey, not wrapped back to black.
    assert.ok(px[4] > 100 && px[4] < 160, `midpoint was ${px[4]}`);
});

t('every palette builds a full ramp', () => {
    for (const p of PALETTES) {
        const lut = buildColorLUT(p.id);
        assert.strictEqual(lut.length, 768, p.id);
        // Dark at the bottom and bright at the top, or the waterfall reads
        // inside out.
        const lo = lut[0] + lut[1] + lut[2];
        const hi = lut[765] + lut[766] + lut[767];
        assert.ok(hi > lo, `${p.id} does not brighten`);
        assert.ok(Object.prototype.hasOwnProperty.call(COLORMAPS, p.id), `${p.id} has no colormap`);
    }
    // An unknown name falls back rather than yielding an empty table.
    assert.strictEqual(buildColorLUT('nonsense').length, 768);
});

// --- contrast ---------------------------------------------------------------

t('the noise floor is the median, so one carrier cannot move it', () => {
    // A QRSS band is almost all noise: a signal is one row out of hundreds, and
    // a mean would let it drag the black point up and hide itself.
    const col = new Float32Array(101).fill(-100);
    col[50] = -20;
    assert.strictEqual(median(col), -100);
});

t('auto contrast puts the black point on the tracked floor', () => {
    const col = new Float32Array(101).fill(-100);
    // Smoothed, so a burst of static does not wash the display out and leave
    // it grey for a minute afterwards.
    const first = trackFloor(-110, col, 15);
    assert.ok(first.floorEMA > -110 && first.floorEMA < -100, 'moves towards, not to');
    let s = -110;
    for (let i = 0; i < 200; i++) s = trackFloor(s, col, 15).floorEMA;
    close(s, -100, 0.01, 'settles on the floor');
    const settled = trackFloor(s, col, 15);
    assert.strictEqual(settled.dbMin, -100);
    assert.strictEqual(settled.dbMax, -85);
});

t('the sensitivity levels are ranges above the floor', () => {
    assert.strictEqual(autoSpanOf('high'), 15);
    assert.strictEqual(autoSpanOf('low'), 40);
    assert.strictEqual(autoSpanOf('nonsense'), 15);
    for (const l of AUTO_LEVELS) assert.strictEqual(autoSpanOf(l.id), l.span);
});

// --- axes -------------------------------------------------------------------

t('tick steps are round numbers and never zero', () => {
    assert.strictEqual(niceStep(100, 5), 20);
    assert.strictEqual(niceStep(1, 5), 0.2);
    // A zero or NaN range would hang the loop that steps through the ticks.
    assert.strictEqual(niceStep(0, 6), 1);
    assert.strictEqual(niceStep(NaN, 6), 1);
    assert.strictEqual(niceStep(-5, 6), 1);
});

t('durations read as the unit they belong in', () => {
    assert.strictEqual(fmtDuration(45), '45 s');
    assert.strictEqual(fmtDuration(600), '10.0 min');
    assert.strictEqual(fmtDuration(7200), '2.0 h');
    assert.strictEqual(fmtShort(45), '45s');
    assert.strictEqual(fmtShort(90), '1m30s');
    assert.strictEqual(fmtShort(120), '2m');
});

// --- the magnifier ----------------------------------------------------------

t('zooming keeps the point under the cursor where it was', () => {
    // The property that makes a magnifier feel like one: the streak you pointed
    // at must not slide away as you zoom into it.
    const zoomed = zoomView(FULL_VIEW, 0.5, 0.25, 0.75);
    const at = (v, px, py) => ({ x: v.x0 + px * (v.x1 - v.x0), y: v.y0 + py * (v.y1 - v.y0) });
    const before = at(FULL_VIEW, 0.25, 0.75);
    const after = at(zoomed, 0.25, 0.75);
    close(after.x, before.x, 1e-9, 'x under cursor');
    close(after.y, before.y, 1e-9, 'y under cursor');
});

t('the view never leaves the waterfall', () => {
    // Panned or zoomed past the edge it would show blank space and label it
    // with times and frequencies that were never captured.
    let v = panView(FULL_VIEW, 5, 5);
    assert.deepStrictEqual(v, FULL_VIEW, 'a full view cannot pan');
    v = zoomView(FULL_VIEW, 0.25, 0.5, 0.5);
    v = panView(v, -9, -9);
    assert.ok(v.x0 >= 0 && v.y0 >= 0 && v.x1 <= 1 && v.y1 <= 1);
    v = panView(v, 9, 9);
    assert.ok(v.x0 >= 0 && v.y0 >= 0 && v.x1 <= 1 && v.y1 <= 1);
    // Zooming out always lands back on the whole thing.
    assert.deepStrictEqual(zoomView(v, 100, 0.5, 0.5), FULL_VIEW);
});

t('a plot position reads back as a frequency and an age', () => {
    const geom = { fc: 100, decSR: 200, secPerCol: 1, innerW: 600 };
    // Top left is the highest frequency and the oldest column.
    const tl = pointToFreqTime(FULL_VIEW, 0, 0, geom);
    close(tl.audio, 200, 1e-9, 'top is fc + decSR/2');
    close(tl.ago, 600, 1e-9, 'left is the full sweep ago');
    // Bottom right is the lowest frequency, now.
    const br = pointToFreqTime(FULL_VIEW, 1, 1, geom);
    close(br.audio, 0, 1e-9, 'bottom is fc - decSR/2');
    close(br.ago, 0, 1e-9, 'right is now');
});

// --- bands ------------------------------------------------------------------

t('the band menu says which one the dial is on', () => {
    // Unlike the other extensions the entries are dial frequencies already, so
    // no audio offset is added back.
    assert.ok(tunedOption(QRSS_BANDS, 10139900).label.includes('30 m'));
    assert.strictEqual(tunedOption(QRSS_BANDS, 14074000), null);
});

t('every band entry is one the receiver can reach', () => {
    // v1 listed 6 m, which is above this receiver's 30 MHz ceiling: choosing it
    // would have tuned to the clamp and then never matched itself.
    const all = QRSS_BANDS.flatMap((g) => g.options);
    assert.strictEqual(all.length, 12);
    for (const o of all) {
        assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
        assert.ok(o.label, `${o.hz} has no label`);
    }
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
});

t('the menus offer only values the rest of the code handles', () => {
    assert.ok(SPANS.includes(QRSS_CONFIG.span));
    assert.ok(RESOLUTIONS.some((r) => r.value === QRSS_CONFIG.fftSize));
    assert.ok(SPEEDS.some((s) => s.value === QRSS_CONFIG.secPerPixel));
    assert.ok(WINDOWS.some((w) => w.value === QRSS_CONFIG.windowSec));
    assert.ok(PALETTES.some((p) => p.id === QRSS_CONFIG.colormap));
    // Every FFT size must be a power of two, or the radix-2 transform silently
    // reads past its tables.
    for (const r of RESOLUTIONS) assert.strictEqual(r.value & (r.value - 1), 0, `${r.value}`);
});

console.log(`\n${pass} QRSS checks passed`);
