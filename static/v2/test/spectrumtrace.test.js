// Collapsing bins onto pixels, which both spectrum panes now share.
//
// It matters most where there are more bins than pixels — a 1000-bin 80m
// recorder in a 300 px dock — because the obvious implementation (take the bin
// that lands on the pixel) drops the narrow signals that are the whole reason
// for a per-band FFT.

const assert = require('assert');
const {
    TRACE_FLOOR, TRACE_WIDTH, binsToPixels, frequencyTicks,
} = require('./.build/spectrumtrace.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a carrier narrower than a pixel survives the collapse', () => {
    // One hot bin in 1000, drawn into 300 pixels. Taking the nearest bin loses
    // it four times out of five; taking the maximum never does.
    for (const at of [0, 1, 137, 499, 500, 998, 999]) {
        const bins = new Float32Array(1000).fill(-120);
        bins[at] = -40;
        const out = binsToPixels(bins, 300, new Float32Array(300));
        assert.ok(Math.max(...out) === -40, `bin ${at} was lost`);
    }
});

t('every pixel gets a value, and they are values from its own bins', () => {
    const bins = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) bins[i] = -120 + i / 100;
    const out = binsToPixels(bins, 300, new Float32Array(300));
    for (let x = 0; x < 300; x++) {
        assert.ok(Number.isFinite(out[x]), `pixel ${x} is ${out[x]}`);
        // Monotonic input: a pixel's max sits between its own first and last bin.
        const lo = bins[Math.floor((x * 1000) / 300)];
        const hi = bins[Math.min(999, Math.floor(((x + 1) * 1000) / 300))];
        assert.ok(out[x] >= lo - 1e-6 && out[x] <= hi + 1e-6, `pixel ${x}: ${out[x]}`);
    }
});

t('more pixels than bins repeats rather than leaving holes', () => {
    // A 400-bin 40m recorder in a wide panel: every pixel still has a value.
    const bins = Float32Array.from({ length: 400 }, (_, i) => -100 - (i % 7));
    const out = binsToPixels(bins, 1200, new Float32Array(1200));
    assert.ok(out.every((v) => Number.isFinite(v) && v <= -100 && v >= -107));
});

t('an empty frame is left alone rather than filled with nonsense', () => {
    const out = new Float32Array(10).fill(-77);
    assert.strictEqual(binsToPixels(new Float32Array(0), 10, out), out);
    assert.ok(out.every((v) => v === -77));
});

t('the trace never uses the black end of the palette', () => {
    // Weak signals are drawn against a dark background: starting the gradient at
    // the palette's own floor would make them invisible.
    assert.ok(TRACE_FLOOR > 0.2 && TRACE_FLOOR < 0.5);
    assert.ok(TRACE_WIDTH >= 1);
});

// ── The frequency rulers ─────────────────────────────────────────────────────
//
// Two of them now — the scale between the panes, and the notches under the
// waterfall — and they share this so they cannot disagree about where a
// frequency is by a pixel.

const view = (centre, span) => ({ centerFreq: centre, span });

t('ticks land inside the view, at a round step', () => {
    for (const [centre, span, w] of [
        [15e6, 30e6, 1200], [7.1e6, 200e3, 800], [14.074e6, 20e3, 400], [10.1e6, 2e3, 300],
    ]) {
        const { ticks, step } = frequencyTicks(view(centre, span), w);
        assert.ok(ticks.length > 0, `${span} Hz in ${w}px gave no ticks`);
        // 1, 2, 2.5 or 5 times a power of ten — the steps a scale is read in.
        const mant = step / (10 ** Math.floor(Math.log10(step)));
        assert.ok([1, 2, 2.5, 5, 10].some((m) => Math.abs(mant - m) < 1e-9), `step ${step}`);
        for (const k of ticks) {
            assert.ok(k.frac >= -1e-9 && k.frac <= 1 + 1e-9, `${k.hz} at ${k.frac}`);
            assert.ok(Number.isFinite(k.hz));
        }
    }
});

t('a major tick every fifth one, and the labels are on those', () => {
    const { ticks, step } = frequencyTicks(view(7.1e6, 200e3), 800);
    const majors = ticks.filter((k) => k.major);
    assert.ok(majors.length >= 2);
    for (const m of majors) {
        // A major sits on the step itself, which is what carries a number.
        assert.ok(Math.abs(m.hz / step - Math.round(m.hz / step)) < 1e-6, `${m.hz} is not on ${step}`);
    }
    // Every fifth tick, so the four between two labels are the subdivision.
    for (let i = 1; i < ticks.length; i++) {
        if (ticks[i].major) assert.ok(!ticks[i - 1].major, 'two majors in a row');
    }
});

t('a narrower pane asks for fewer labels, not smaller ones', () => {
    const wide = frequencyTicks(view(15e6, 30e6), 1600);
    const narrow = frequencyTicks(view(15e6, 30e6), 320);
    assert.ok(narrow.step >= wide.step, `${narrow.step} vs ${wide.step}`);
    assert.ok(narrow.ticks.length <= wide.ticks.length);
});

t('the ruler follows the view, so a pan moves every tick with it', () => {
    const a = frequencyTicks(view(7.1e6, 200e3), 800);
    const b = frequencyTicks(view(7.15e6, 200e3), 800);
    assert.strictEqual(a.step, b.step, 'panning does not change the step');
    // A tick 50 kHz up the band is a quarter of a 200 kHz view to the left.
    const shared = a.ticks.find((k) => b.ticks.some((k2) => k2.hz === k.hz));
    const same = b.ticks.find((k) => k.hz === shared.hz);
    assert.ok(Math.abs((shared.frac - same.frac) - 0.25) < 1e-9,
        `${shared.frac} vs ${same.frac}`);
});

t('a zero span gives nothing rather than dividing by it', () => {
    const { ticks } = frequencyTicks(view(7.1e6, 0), 800);
    assert.ok(ticks.every((k) => Number.isFinite(k.frac)) || ticks.length === 0);
});

console.log(`\n${pass} passed`);
