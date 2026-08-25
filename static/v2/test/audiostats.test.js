// The numbers under the audio scope.
//
// What is worth pinning here is not that a maximum can be found — it is that
// the readings survive the things that make a single FFT frame unreadable: the
// peak hopping between bins, the floor being one sample of a random variable,
// and a passband change leaving an average that describes a different band.

const assert = require('assert');
const {
    accumulateAudioStats, interpolatePeak, medianPower, newAudioStats, readAudioStats,
} = require('./.build/audiostats.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 48000;
const BINS = 1024;                       // so a bin is 23.4375 Hz
const TUNING = { bandwidthLow: 0, bandwidthHigh: 24000 };   // the whole band, to keep the maths plain

// A frame whose bins are all `floor` dB except a peak at `peakBin`.
function frame(peakBin, peakDb = -20, floor = -100, bins = BINS) {
    const b = new Float32Array(bins).fill(floor);
    if (peakBin != null) b[peakBin] = peakDb;
    return { bins: b, binCount: bins, sampleRate: RATE };
}

// Feed the same frame repeatedly, as the panel does at frame rate.
function settle(state, f, tuning = TUNING, frames = 40, step = 50) {
    let now = 0;
    for (let i = 0; i < frames; i++) {
        accumulateAudioStats(state, f, tuning, now);
        now += step;
    }
    return readAudioStats(state, f.sampleRate, f.binCount, tuning);
}

t('the peak lands on the frequency the bin stands for', () => {
    const s = settle(newAudioStats(), frame(100));
    const binHz = RATE / 2 / BINS;
    assert.ok(Math.abs(s.peakHz - 100 * binHz) < binHz, `peak at ${s.peakHz} Hz, want ~${100 * binHz}`);
});

t('a peak between two bins reads between them, not on one', () => {
    // Equal neighbours put the true peak at the bin centre; a heavier right
    // neighbour pulls it right. Bin quantisation alone could not say that.
    const b = new Float32Array(BINS).fill(-100);
    b[200] = -20; b[201] = -26; b[199] = -32;
    const s = settle(newAudioStats(), { bins: b, binCount: BINS, sampleRate: RATE });

    const binHz = RATE / 2 / BINS;
    const centre = 200 * binHz;
    assert.ok(s.peakHz > centre, `interpolated to ${s.peakHz}, want above the bin centre ${centre}`);
    assert.ok(s.peakHz < centre + binHz, `interpolated to ${s.peakHz}, want less than a bin above`);
});

t('averaging is in the power domain, so a peak is not dragged down', () => {
    // A tone present in half the frames. Averaging decibels would report the
    // geometric mean — about -60 dB, halfway between the two in the log domain
    // — where the arithmetic mean of the power is only 3 dB below the peak.
    const s = newAudioStats();
    let now = 0;
    for (let i = 0; i < 80; i++) {
        accumulateAudioStats(s, frame(i % 2 ? 300 : null), TUNING, now);
        now += 50;
    }
    const read = readAudioStats(s, RATE, BINS, TUNING);
    assert.ok(read.peakDb > -30, `peak read ${read.peakDb.toFixed(1)} dB, want within a few dB of -20`);
});

t('the floor is the median, so a loud signal does not raise it', () => {
    const quiet = settle(newAudioStats(), frame(null, 0, -100));
    const loud = settle(newAudioStats(), frame(100, -10, -100));
    assert.ok(Math.abs(quiet.floorDb - loud.floorDb) < 1,
        `floor moved from ${quiet.floorDb.toFixed(1)} to ${loud.floorDb.toFixed(1)} because of one loud bin`);
});

t('SNR is the peak over that floor', () => {
    const s = settle(newAudioStats(), frame(100, -20, -100));
    assert.ok(Math.abs(s.snrDb - 80) < 2, `SNR ${s.snrDb.toFixed(1)} dB, want ~80`);
});

t('the centroid sits on a tone and away from it when the energy is spread', () => {
    const tone = settle(newAudioStats(), frame(400, -20, -120));
    assert.ok(Math.abs(tone.centroidHz - tone.peakHz) < 200,
        `centroid ${tone.centroidHz.toFixed(0)} far from the peak ${tone.peakHz.toFixed(0)} for a pure tone`);

    // Energy at both ends: the peak is at one of them, the centroid between.
    const b = new Float32Array(BINS).fill(-120);
    b[100] = -20; b[900] = -21;
    const split = settle(newAudioStats(), { bins: b, binCount: BINS, sampleRate: RATE });
    assert.ok(split.centroidHz > split.peakHz + 1000,
        `centroid ${split.centroidHz.toFixed(0)} should sit well away from the peak ${split.peakHz.toFixed(0)}`);
});

t('one stray frame does not move the peak frequency', () => {
    // The jitter the averaging exists to remove. A voice puts its loudest bin
    // somewhere different several times a second, and a readout that followed
    // that would be unreadable — so an equally loud blip elsewhere must not
    // take the reading with it.
    const s = newAudioStats();
    let now = 0;
    for (let i = 0; i < 60; i++) { accumulateAudioStats(s, frame(100, -60, -120), TUNING, now); now += 50; }
    const before = readAudioStats(s, RATE, BINS, TUNING).peakHz;

    accumulateAudioStats(s, frame(700, -60, -120), TUNING, now);
    const after = readAudioStats(s, RATE, BINS, TUNING).peakHz;

    assert.ok(Math.abs(after - before) < 100,
        `one frame moved the peak from ${before.toFixed(0)} to ${after.toFixed(0)} Hz`);
});

t('a sustained change does move it, so the average is not frozen', () => {
    const s = newAudioStats();
    let now = 0;
    for (let i = 0; i < 60; i++) { accumulateAudioStats(s, frame(100, -60, -120), TUNING, now); now += 50; }
    for (let i = 0; i < 60; i++) { accumulateAudioStats(s, frame(700, -60, -120), TUNING, now); now += 50; }

    const read = readAudioStats(s, RATE, BINS, TUNING);
    const binHz = RATE / 2 / BINS;
    assert.ok(Math.abs(read.peakHz - 700 * binHz) < binHz,
        `peak stayed at ${read.peakHz.toFixed(0)} Hz after the signal moved to ${(700 * binHz).toFixed(0)}`);
});

t('a changed passband starts again rather than blending two bands', () => {
    const s = newAudioStats();
    settle(s, frame(100), { bandwidthLow: 0, bandwidthHigh: 24000 });

    // Narrower filter: a different set of bins entirely.
    const narrow = { bandwidthLow: 300, bandwidthHigh: 2700 };
    const first = readAudioStats(s, RATE, BINS, narrow);
    assert.strictEqual(first, null, 'the old average was read against the new window');

    const read = settle(s, frame(40), narrow);
    assert.ok(read, 'no reading after the window changed');
    assert.ok(read.peakHz >= 300 && read.peakHz <= 2700,
        `peak ${read.peakHz.toFixed(0)} Hz is outside the new passband`);
});

t('a long gap restarts rather than easing across it', () => {
    // A backgrounded tab: the frames either side of the gap are unrelated, and
    // easing between them would show a value that was never true.
    const s = newAudioStats();
    let now = 0;
    for (let i = 0; i < 40; i++) { accumulateAudioStats(s, frame(100, -80, -120), TUNING, now); now += 50; }
    accumulateAudioStats(s, frame(100, -10, -120), TUNING, now + 30_000);
    const read = readAudioStats(s, RATE, BINS, TUNING);
    assert.ok(read.peakDb > -20, `after a 30 s gap the peak read ${read.peakDb.toFixed(1)}, want the new frame`);
});

t('nothing yet is null, not zero', () => {
    assert.strictEqual(readAudioStats(newAudioStats(), RATE, BINS, TUNING), null);
    assert.strictEqual(readAudioStats(null, RATE, BINS, TUNING), null);
});

t('silence does not produce a reading of nothing', () => {
    // -Infinity is what an unfed analyser bin reads as.
    const b = new Float32Array(BINS).fill(-Infinity);
    const s = newAudioStats();
    const read = settle(s, { bins: b, binCount: BINS, sampleRate: RATE });
    assert.strictEqual(read, null, 'all-silent bins should not be reported as a peak');
});

t('a malformed frame is ignored rather than throwing', () => {
    const s = newAudioStats();
    accumulateAudioStats(s, null, TUNING, 0);
    accumulateAudioStats(s, { bins: null, binCount: 0, sampleRate: RATE }, TUNING, 0);
    accumulateAudioStats(s, frame(100), null, 0);
    assert.ok(true);
});

t('interpolatePeak refuses a slope', () => {
    // Monotonic: not a peak at all, so the bin index is the honest answer.
    const rising = Float64Array.from([1, 2, 3, 4, 5].map((v) => 10 ** (v / 10)));
    assert.strictEqual(interpolatePeak(rising, 4), 4, 'the last bin has no right neighbour');
    // A peak at the very first bin likewise has nothing to fit through.
    assert.strictEqual(interpolatePeak(rising, 0), 0);
});

t('medianPower is the middle value, not the mean', () => {
    assert.strictEqual(medianPower(Float64Array.from([1, 2, 100])), 2);
    assert.strictEqual(medianPower(Float64Array.from([1, 3, 5, 100])), 4);
    assert.strictEqual(medianPower(Float64Array.from([])), 0);
});

console.log(`\nall ${pass} audio stats tests passed`);
