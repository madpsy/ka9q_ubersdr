// Collapsing bins onto pixels, which both spectrum panes now share.
//
// It matters most where there are more bins than pixels — a 1000-bin 80m
// recorder in a 300 px dock — because the obvious implementation (take the bin
// that lands on the pixel) drops the narrow signals that are the whole reason
// for a per-band FFT.

const assert = require('assert');
const {
    TRACE_FLOOR, TRACE_WIDTH, binsToPixels, drawDbScale, frequencyTicks,
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

// ── The dB scale ─────────────────────────────────────────────────────────────
//
// Drawn over the picture by the audio scope and by every IF view that has an
// axis of levels, which between them run from a 57 px split trace to a 320 px
// fusion and from a 45 dB auto window to the 140 dB the manual sliders reach.
// The two things it must do across all of that: put a label where that level is
// drawn, and stay sparse enough to be read at a glance.

// A context that records the text it was asked for and ignores the rest.
function labelsOf({ hCss, floor, ceil, contrast = 1, dpr = 2 }) {
    const out = [];
    const noop = () => {};
    const c = {
        fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '',
        font: '', textBaseline: '', textAlign: '',
        beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, strokeText: noop,
        fillText: (text, x, y) => out.push({ db: Number(text), y }),
    };
    drawDbScale(c, { h: hCss * dpr, dpr, floor, range: ceil - floor, contrast, ink: '#fff' });
    return out;
}

// The panes these are drawn in: the IF panel's split trace, its shortest whole
// pane and its tallest, and the audio scope's fixed canvas.
const PANE_H = [57, 96, 130, 320];
// Auto windows at both ends of their range, and the manual sliders' extremes.
const WINDOWS = [[-95, -50], [-110, -20], [-100, -40], [-140, 0]];

t('a label sits where its own level is drawn', () => {
    for (const hCss of PANE_H) {
        for (const [floor, ceil] of WINDOWS) {
            for (const { db, y } of labelsOf({ hCss, floor, ceil })) {
                const want = (hCss * 2) - ((db - floor) / (ceil - floor)) * (hCss * 2);
                assert.ok(Math.abs(y - want) < 0.51,
                    `${hCss}px ${floor}..${ceil}: ${db} drawn at ${y.toFixed(1)}, belongs at ${want.toFixed(1)}`);
            }
        }
    }
});

t('the scale is sparse, and never empty where there is room for it', () => {
    for (const hCss of PANE_H) {
        for (const [floor, ceil] of WINDOWS) {
            const labels = labelsOf({ hCss, floor, ceil });
            const where = `${hCss}px ${floor}..${ceil}`;
            // Two on the shortest pane there is, which is what makes it a scale
            // rather than a number.
            assert.ok(labels.length >= 2, `${where}: ${labels.length} labels`);
            // ...and never a wall of them on the tallest.
            assert.ok(labels.length <= 7, `${where}: ${labels.length} labels`);
            for (let i = 1; i < labels.length; i++) {
                assert.ok(labels[i].y - labels[i - 1].y >= 18 * 2,
                    `${where}: ${labels[i - 1].db} and ${labels[i].db} are on top of each other`);
            }
            // Whole, inside the canvas: half a label reads as a different one.
            for (const { y } of labels) assert.ok(y > 0 && y < hCss * 2, `${where}: a label at ${y}`);
            // Every one of them a round number of dB on the same ladder.
            const step = labels.length > 1 ? Math.abs(labels[1].db - labels[0].db) : 10;
            // `===` rather than strictEqual: -60 % 20 is -0, which is a perfectly
            // good zero and not the one Object.is would accept.
            for (const { db } of labels) assert.ok(db % step === 0, `${where}: ${db} is off the ladder`);
        }
    }
});

t('the geometry gamma moves the labels with the picture', () => {
    // The audio scope draws its columns through a contrast gamma, so the scale
    // has to bend the same way — a linear scale over a bent picture is wrong
    // everywhere but the two ends.
    const flat = labelsOf({ hCss: 96, floor: -90, ceil: 0 });
    const bent = labelsOf({ hCss: 96, floor: -90, ceil: 0, contrast: 2.5 });
    const sameDb = bent.filter((b) => flat.some((f) => f.db === b.db));
    assert.ok(sameDb.length, 'no label to compare');
    assert.ok(sameDb.some((b) => Math.abs(b.y - flat.find((f) => f.db === b.db).y) > 1),
        'the gamma moved the picture and left the scale where it was');
});

console.log(`\n${pass} passed`);
