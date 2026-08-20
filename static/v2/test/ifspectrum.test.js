// The IF spectrum's window, resampling and ruler.
//
// All three are places where a mistake produces a plausible picture rather than
// an error: a window that quietly stops covering the filter, a trace drawn half
// a bin off the scale under it, or a ruler whose zero is not the dial. None of
// those look wrong on screen — they look like the receiver is mistuned.

const assert = require('assert');
const {
    COARSE_BINS, FIT_MARGIN, MIN_HALF_SPAN_HZ, OFFSET_LABEL_PX, ZOOM_MAX, ZOOM_MIN,
    binWidthOf, binsInWindow, clampRate, clampZoom, coverageOf, createLevels,
    formatBinWidth, formatOffset, halfSpanFor, isZoomed, levelsOf, manualLevels,
    maxZoomFor, normaliseView, offsetStep, offsetTicks, sliceToPixels, updateLevels,
    viewHas, windowFor,
} = require('./.build/ifspectrum.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The mode table's own passbands — the shapes the window rule has to cope with.
const MODES = {
    usb: [50, 2700],
    lsb: [-2700, -50],
    am: [-5000, 5000],
    cwu: [-200, 200],
    fm: [-8000, 8000],
};

t('the window covers the filter and a quarter, both sides of the dial, in every mode', () => {
    for (const [mode, [low, high]] of Object.entries(MODES)) {
        const win = windowFor({ frequency: 14_200_000, bandwidthLow: low, bandwidthHigh: high });
        // Both edges of the filter are inside.
        assert.ok(win.lo <= 14_200_000 + low, `${mode}: low edge outside the window`);
        assert.ok(win.hi >= 14_200_000 + high, `${mode}: high edge outside the window`);
        // ...and both sides of the dial are on screen, which is the whole point:
        // a USB window that merely covered 50..2700 would show nothing below the
        // carrier.
        assert.ok(win.lo < 14_200_000, `${mode}: nothing below the dial`);
        assert.ok(win.hi > 14_200_000, `${mode}: nothing above the dial`);
        // And it is at least the filter plus a quarter.
        assert.ok(win.span >= (high - low) * FIT_MARGIN, `${mode}: window narrower than the brief`);
    }
});

t('a narrow filter still gets a window big enough to point at', () => {
    const win = windowFor({ frequency: 7_030_000, bandwidthLow: -50, bandwidthHigh: 50 });
    assert.strictEqual(win.half, MIN_HALF_SPAN_HZ);
});

t('the window is exactly symmetric about the dial', () => {
    for (const factor of [1, 1.7, 8, 32]) {
        const win = windowFor({ frequency: 3_650_000, bandwidthLow: -2700, bandwidthHigh: -50 }, factor);
        assert.strictEqual(win.dial - win.lo, win.hi - win.dial);
        assert.strictEqual(win.span, win.half * 2);
    }
});

t('zoom opens the window and never closes it past the fit', () => {
    const fit = halfSpanFor(50, 2700, 1);
    assert.strictEqual(halfSpanFor(50, 2700, 4), fit * 4);
    assert.strictEqual(clampZoom(0.25), ZOOM_MIN);
    assert.strictEqual(clampZoom(0), ZOOM_MIN);
    assert.strictEqual(clampZoom(1e9), ZOOM_MAX);
    assert.strictEqual(clampZoom('nonsense'), ZOOM_MIN);
    assert.ok(!isZoomed(1));
    assert.ok(isZoomed(2));
});

// ── Resampling ───────────────────────────────────────────────────────────────

// A view whose bins are 100 Hz wide, centred on 10 MHz: bin i covers
// [9_950_000 + 100i, +100).
const CFG = { centerFreq: 10_000_000, span: 100_000, binCount: 1000 };
const flat = (v) => new Float32Array(1000).fill(v);

t('a carrier lands under the frequency it was measured at', () => {
    // Bin 500 covers 10_000_000..10_000_100, centre 10_000_050.
    const bins = flat(-120);
    bins[500] = -40;
    const win = { lo: 9_999_000, hi: 10_001_000, span: 2000, half: 1000, dial: 10_000_000 };
    const out = sliceToPixels(bins, CFG, win, new Float32Array(400));

    let peak = 0;
    for (let x = 1; x < 400; x++) if (out[x] > out[peak]) peak = x;
    const hz = win.lo + ((peak + 0.5) / 400) * win.span;
    // Within a pixel of the bin's own centre. Half a bin out — the mistake this
    // is here for — would be 50 Hz, which is ten pixels at this zoom.
    assert.ok(Math.abs(hz - 10_000_050) <= win.span / 400,
        `peak at ${hz.toFixed(0)}, expected 10000050`);
});

t('upsampling interpolates rather than drawing a staircase', () => {
    const bins = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) bins[i] = -120 + i * 0.01;
    const win = { lo: 9_999_000, hi: 10_001_000, span: 2000, half: 1000, dial: 10_000_000 };
    const out = sliceToPixels(bins, CFG, win, new Float32Array(400));
    // Twenty bins over four hundred pixels: nearest-bin would repeat each value
    // twenty times, so a monotonic input would have far more equal neighbours
    // than distinct ones.
    let equal = 0;
    for (let x = 1; x < 400; x++) if (out[x] === out[x - 1]) equal++;
    assert.ok(equal < 40, `${equal} repeated pixels — that is a staircase`);
    // ...and it stays monotonic, which a wrongly-signed interpolation would not.
    for (let x = 1; x < 400; x++) assert.ok(out[x] >= out[x - 1] - 1e-6, `dip at ${x}`);
});

t('downsampling keeps the maximum, so a narrow carrier survives', () => {
    const bins = flat(-120);
    bins[500] = -40;
    // The whole served view across 200 pixels: five bins a pixel.
    const win = { lo: 9_950_000, hi: 10_050_000, span: 100_000, half: 50_000, dial: 10_000_000 };
    const out = sliceToPixels(bins, CFG, win, new Float32Array(200));
    assert.strictEqual(Math.max(...out), -40);
});

t('pixels with no bin behind them are NaN, not a floor', () => {
    const bins = flat(-100);
    // Half the window hangs off the right-hand end of the served view.
    const win = { lo: 10_040_000, hi: 10_060_000, span: 20_000, half: 10_000, dial: 10_050_000 };
    const out = sliceToPixels(bins, CFG, win, new Float32Array(200));
    const measured = [...out].filter(Number.isFinite).length;
    assert.ok(measured > 0 && measured < 200, `${measured} of 200 pixels measured`);
    // The measured ones are the left half, where the view actually reaches.
    assert.ok(Number.isFinite(out[0]));
    assert.ok(!Number.isFinite(out[199]));
});

t('...at the left-hand end too, where a clamp used to draw bin 0 as a flat line', () => {
    // The bug: off the left edge both ends of a pixel's bin range are negative,
    // the start clamps to 0 and the `i0 + 1` floor under the end then makes it
    // read bin 0 — so a part of the spectrum nobody has measured came back as a
    // flat trace at a plausible level. The right-hand end escaped by accident,
    // which is why it showed as an asymmetry.
    const bins = flat(-100);
    // The served view starts at 9.95 MHz and the window at 9.93, so the left
    // half of the picture has nothing behind it and the right half is all data.
    const win = { lo: 9_930_000, hi: 9_970_000, span: 40_000, half: 20_000, dial: 9_950_000 };
    // Both regimes: more bins than pixels, and more pixels than bins. Only the
    // first had the fault, but both have to answer the same way.
    for (const px of [200, 4000]) {
        const out = sliceToPixels(bins, CFG, win, new Float32Array(px));
        const edge = px / 2;             // where the served view begins
        for (let x = 0; x < edge - 1; x++) {
            assert.ok(!Number.isFinite(out[x]),
                `${px}px: pixel ${x} is off the left edge and came back as ${out[x]}`);
        }
        for (let x = edge + 1; x < px; x++) {
            assert.ok(Number.isFinite(out[x]), `${px}px: pixel ${x} has data and did not report it`);
        }
    }
});

t('a window as wide as the view still hangs off it when the dial is off centre', () => {
    // The second half of the same picture. The main display only recentres when
    // the passband would leave the screen, so the dial sits off centre most of
    // the time; a stop measured as a *span* let the window overhang by exactly
    // that drift. The stop is the nearer edge instead.
    const usb = { frequency: 14_074_000, bandwidthLow: 50, bandwidthHigh: 2700 };
    const drifted = { centerFreq: 14_076_250, span: 2048 * 20, binCount: 2048 };
    const win = windowFor(usb, clampZoom(99, maxZoomFor(drifted, usb)));
    assert.strictEqual(coverageOf(drifted, win), 1, 'the widest window still overhangs');
    // ...and it is genuinely narrower than the served span, by the drift.
    assert.ok(win.span < drifted.span, `${win.span} is not inside ${drifted.span}`);

    // Centred, the two agree again — nothing is given away for free.
    const centred = { ...drifted, centerFreq: usb.frequency };
    assert.ok(Math.abs(windowFor(usb, maxZoomFor(centred, usb)).span - centred.span) < 1);

    // A dial outside the view has no window it can fill: back to the fit, and
    // the gaps say the rest.
    assert.strictEqual(maxZoomFor({ centerFreq: 21e6, span: 40_000, binCount: 2048 }, usb), ZOOM_MIN);
});

t('no view, no bins, or a zero span produces a row of NaN rather than a wrong picture', () => {
    const win = { lo: 1, hi: 2, span: 1, half: 0.5, dial: 1.5 };
    for (const [bins, cfg] of [
        [null, CFG],
        [flat(-100), null],
        [flat(-100), { centerFreq: 10e6, span: 0, binCount: 1000 }],
    ]) {
        const out = sliceToPixels(bins, cfg, win, new Float32Array(16));
        assert.ok([...out].every((v) => Number.isNaN(v)));
    }
});

// ── Resolution reporting ─────────────────────────────────────────────────────

t('the bin width and the count in the window are the served view, not a guess', () => {
    assert.strictEqual(binWidthOf(CFG), 100);
    assert.strictEqual(binWidthOf(null), 0);
    const win = windowFor({ frequency: 10e6, bandwidthLow: 50, bandwidthHigh: 2700 });
    assert.strictEqual(binsInWindow(CFG, win), win.span / 100);

    // The case the panel warns about: 1024 bins over 0-30 MHz is 29 kHz a bin,
    // and an SSB window is a quarter of one.
    const wide = { centerFreq: 15e6, span: 30e6, binCount: 1024 };
    assert.ok(binsInWindow(wide, win) < 1);
    assert.ok(binsInWindow(wide, win) < COARSE_BINS);
});

t('coverage says how much of the window the server is actually sending', () => {
    const middle = windowFor({ frequency: 10e6, bandwidthLow: 50, bandwidthHigh: 2700 });
    assert.strictEqual(coverageOf(CFG, middle), 1);
    // Panned right off the dial.
    const away = windowFor({ frequency: 20e6, bandwidthLow: 50, bandwidthHigh: 2700 });
    assert.strictEqual(coverageOf(CFG, away), 0);
    // Straddling the edge of the served view: some of it, not all.
    const edge = windowFor({ frequency: 10_049_000, bandwidthLow: -5000, bandwidthHigh: 5000 });
    const c = coverageOf(CFG, edge);
    assert.ok(c > 0 && c < 1, `coverage ${c}`);
});

// ── Levels ───────────────────────────────────────────────────────────────────

t('the ceiling attacks at once and the floor is under the noise', () => {
    const st = createLevels();
    const row = new Float32Array(256).fill(-110);
    updateLevels(st, row, 0);
    let l = levelsOf(st);
    assert.ok(l.floor < -110, 'the floor sits under the noise');
    assert.ok(l.ceil >= l.floor + 30, 'and the scale is never narrower than the minimum');

    // A burst appears for one frame. The ceiling must reach it in that frame —
    // an eased one would settle between the noise and the signal and clip it.
    row[128] = -20;
    updateLevels(st, row, 0.1);
    l = levelsOf(st);
    assert.ok(l.ceil >= -20, `ceiling ${l.ceil.toFixed(1)} did not reach the peak`);
});

t('a row with nothing measured in it leaves the scale where it was', () => {
    const st = createLevels();
    updateLevels(st, new Float32Array(256).fill(-100), 0);
    const before = levelsOf(st);
    updateLevels(st, new Float32Array(256).fill(NaN), 0.1);
    assert.deepStrictEqual(levelsOf(st), before);
});

t('a manual scale is ordered and never degenerate', () => {
    assert.deepStrictEqual(manualLevels(-40, -110), { floor: -110, ceil: -40 });
    const same = manualLevels(-70, -70);
    assert.ok(same.ceil > same.floor);
});

// ── The ruler ────────────────────────────────────────────────────────────────

t('the ruler has a zero, in the middle, and is symmetric about it', () => {
    for (const half of [400, 3375, 27_000]) {
        const ticks = offsetTicks(half, 320);
        const zero = ticks.filter((k) => k.zero);
        assert.strictEqual(zero.length, 1, `half ${half}: ${zero.length} zeroes`);
        assert.ok(Math.abs(zero[0].frac - 0.5) < 1e-9, `half ${half}: zero at ${zero[0].frac}`);
        const offsets = ticks.map((k) => k.hz);
        for (const hz of offsets) {
            assert.ok(offsets.some((o) => Math.abs(o + hz) < 1e-6), `half ${half}: ${hz} has no mirror`);
        }
    }
});

t('every notch is inside the window, and only the majors are labelled', () => {
    const ticks = offsetTicks(3375, 320);
    assert.ok(ticks.length > 4);
    for (const k of ticks) {
        assert.ok(k.frac >= 0 && k.frac <= 1, `frac ${k.frac}`);
        assert.strictEqual(k.label != null, k.major);
    }
    assert.ok(ticks.some((k) => !k.major), 'no minor notches at all');
});

t('a window with no span produces no ruler rather than an endless loop', () => {
    assert.deepStrictEqual(offsetTicks(0, 320), []);
    assert.deepStrictEqual(offsetTicks(-5, 320), []);
});

t('offsets read as offsets', () => {
    assert.strictEqual(formatOffset(0), '0');
    assert.strictEqual(formatOffset(500), '+500');
    assert.strictEqual(formatOffset(-500), '-500');
    assert.strictEqual(formatOffset(1000), '+1k');
    assert.strictEqual(formatOffset(-1500), '-1.5k');
});

t('the resolution readout says something at every zoom', () => {
    assert.strictEqual(formatBinWidth(0), '—');
    assert.strictEqual(formatBinWidth(29296.875), '29.3 kHz/bin');
    assert.strictEqual(formatBinWidth(100), '100 Hz/bin');
    assert.strictEqual(formatBinWidth(2.5), '2.5 Hz/bin');
    assert.strictEqual(formatBinWidth(0.5), '0.50 Hz/bin');
});

// ── Views ────────────────────────────────────────────────────────────────────

t('every view draws at least one picture, and an unknown one falls back', () => {
    for (const v of ['split', 'spectrum', 'waterfall', 'fusion', 'mirror']) {
        const h = viewHas(v);
        assert.ok(h.trace || h.waterfall, `${v} draws nothing`);
        assert.strictEqual(normaliseView(v), v);
    }
    assert.strictEqual(normaliseView('nonsense'), 'split');
    assert.strictEqual(normaliseView(undefined), 'split');
    // Fusion is the only one that puts both on one surface, and mirror the only
    // one that is symmetric — the panel's canvas layout turns on exactly these.
    assert.ok(viewHas('fusion').merged && viewHas('fusion').waterfall && viewHas('fusion').trace);
    assert.ok(!viewHas('split').merged);
    assert.ok(viewHas('mirror').mirror && !viewHas('mirror').waterfall);
    assert.ok(!viewHas('waterfall').trace);
});

t('the waterfall rate is clamped rather than trusted', () => {
    assert.strictEqual(clampRate(0), 2);
    assert.strictEqual(clampRate(1000), 40);
    assert.strictEqual(clampRate(undefined), 20);
    assert.strictEqual(clampRate('20'), 20);
});

t('the window cannot be opened past what the receiver is sending', () => {
    // The bug this is here for: at 50 Hz a bin the server sends 51.2 kHz, and a
    // x32 window on an SSB filter is 216 kHz — three quarters of the panel with
    // no measurement behind it, which reads as a broken display.
    const narrow = { centerFreq: 7_669_000, span: 1024 * 50, binCount: 1024 };
    const usb = { frequency: 7_669_000, bandwidthLow: 50, bandwidthHigh: 2700 };
    const max = maxZoomFor(narrow, usb);
    assert.ok(max < ZOOM_MAX, `stop at ${max}, which is no stop at all`);
    const win = windowFor(usb, clampZoom(99, max));
    assert.ok(win.span <= narrow.span + 1, `${win.span} Hz window in a ${narrow.span} Hz view`);
    assert.strictEqual(coverageOf(narrow, win), 1, 'the widest window is still all measured');

    // Zoomed out to the whole band the stop never binds.
    const wide = { centerFreq: 15e6, span: 30e6, binCount: 1024 };
    assert.strictEqual(maxZoomFor(wide, usb), ZOOM_MAX);

    // ...and the fit is never clamped away, even where the served view is
    // narrower than it: a window inside the filter would be a lie.
    const tiny = { centerFreq: 7_669_000, span: 2000, binCount: 1024 };
    assert.strictEqual(maxZoomFor(tiny, usb), ZOOM_MIN);
    assert.strictEqual(windowFor(usb, clampZoom(4, maxZoomFor(tiny, usb))).span,
        windowFor(usb, 1).span);

    // Nothing known yet is not a reason to restrict anything.
    assert.strictEqual(maxZoomFor(null, usb), ZOOM_MAX);
    assert.strictEqual(maxZoomFor({ centerFreq: 1, span: 0, binCount: 0 }, usb), ZOOM_MAX);
});

t('the ruler never runs out of steps, however wide the window', () => {
    // A fixed ladder sticks at its largest rung and fills the strip with
    // overlapping labels — eleven of them across a dock column, which is how
    // this was found. The step is built from a decade instead.
    for (const half of [400, 3375, 27_000, 108_000, 400_000, 3_000_000]) {
        for (const width of [180, 215, 320, 900]) {
            const ticks = offsetTicks(half, width);
            const majors = ticks.filter((k) => k.major);
            // Never more labels than the strip has room for, plus the two ends.
            const room = Math.max(2, Math.floor(width / OFFSET_LABEL_PX));
            assert.ok(majors.length <= room + 2,
                `half ${half} at ${width}px: ${majors.length} labels, room for ~${room}`);
            assert.ok(majors.length >= 2, `half ${half} at ${width}px: ${majors.length} labels`);
            assert.ok(offsetStep(half, width) > 0);
        }
    }
});

t('the outermost labels are pushed inward so they stay on the panel', () => {
    const ticks = offsetTicks(108_000, 215).filter((k) => k.label != null);
    assert.strictEqual(ticks[0].align, 'start');
    assert.strictEqual(ticks[ticks.length - 1].align, 'end');
    assert.ok(ticks.find((k) => k.zero).align === 'center');
});

console.log(`\n${pass} passed`);
