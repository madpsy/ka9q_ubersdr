// The client noise stage: NR parity with v1, and the blanker's behaviour.
//
// NR is a copy of v1's nr2.js by construction, so the test is the strong kind:
// it loads *v1's own file* and requires the two to produce identical output,
// sample for sample, learning phase included. If someone "improves" the copy,
// this is what says the two frontends no longer sound the same.
//
// The blanker is new (v1's is not ported — see lib/noiseBlanker.js for why),
// so it is tested on its contract: impulses are removed leading edge included,
// clean audio passes, silence recovery does not blank the first syllable.

const assert = require('assert');
const path = require('path');

// v1's classes, loaded as v1 arranges them: fft.js defines the FFT global that
// nr2.js reaches for.
global.FFT = require(path.join(__dirname, '..', '..', 'fft.js'));
const NR2Processor = require(path.join(__dirname, '..', '..', 'nr2.js'));

const { NRProcessor: NR } = require('./.build/nr.cjs');
const { NoiseBlanker, NB_DEFAULTS } = require('./.build/noiseblanker.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Deterministic noise — Math.random would make a failure unreproducible.
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff - 0.5;
    };
}

// A second of "band": steady noise with a tone buried in it.
function bandAudio(seconds = 1, fs = 12000, seed = 7) {
    const rnd = prng(seed);
    const out = new Float32Array(Math.round(seconds * fs));
    for (let i = 0; i < out.length; i++) {
        out[i] = 0.05 * rnd() + 0.03 * Math.sin((2 * Math.PI * 800 * i) / fs);
    }
    return out;
}

// ---- NR parity with v1 -------------------------------------------------------

t('NR is v1 NR2, sample for sample', () => {
    const input = bandAudio(2);
    const ours = new NR(2048, 4);
    const theirs = new NR2Processor(null, 2048, 4);
    for (const p of [ours, theirs]) {
        p.setParameters(40, 10, 1.0);
        p.enabled = true;
    }

    // In ScriptProcessor-sized chunks, as both are driven in their apps.
    const chunk = 2048;
    for (let at = 0; at + chunk <= input.length; at += chunk) {
        const inBuf = input.subarray(at, at + chunk);
        const a = new Float32Array(chunk);
        const b = new Float32Array(chunk);
        ours.process(inBuf, a);
        theirs.process(inBuf, b);
        for (let i = 0; i < chunk; i++) {
            assert.strictEqual(a[i], b[i], `sample ${at + i} diverged`);
        }
    }
});

t('NR parity holds across a re-learn and a parameter change', () => {
    const input = bandAudio(1, 12000, 21);
    const ours = new NR(2048, 4);
    const theirs = new NR2Processor(null, 2048, 4);
    for (const p of [ours, theirs]) { p.setParameters(70, 3, 2.5); p.enabled = true; }

    const chunk = 2048;
    let at = 0;
    const run = (n) => {
        for (let k = 0; k < n && at + chunk <= input.length; k++, at += chunk) {
            const a = new Float32Array(chunk);
            const b = new Float32Array(chunk);
            ours.process(input.subarray(at, at + chunk), a);
            theirs.process(input.subarray(at, at + chunk), b);
            assert.deepStrictEqual(Array.from(a), Array.from(b));
        }
    };
    run(2);
    ours.resetLearning();
    theirs.resetLearning();
    run(1);
    ours.setParameters(20, 8, 0.5);
    theirs.setParameters(20, 8, 0.5);
    run(2);
});

t('NR actually reduces steady noise once learned', () => {
    // Not parity — sanity: after learning, pure noise comes out smaller.
    const rnd = prng(3);
    const fs = 12000;
    const nr = new NR(2048, 4);
    nr.setParameters(60, 2, 1.0);
    nr.enabled = true;
    const chunk = 2048;
    let inRms = 0;
    let outRms = 0;
    for (let c = 0; c < 20; c++) {
        const inBuf = new Float32Array(chunk);
        for (let i = 0; i < chunk; i++) inBuf[i] = 0.05 * rnd();
        const out = new Float32Array(chunk);
        nr.process(inBuf, out);
        if (c >= 15) {      // well past the 30-frame learning window
            for (let i = 0; i < chunk; i++) { inRms += inBuf[i] ** 2; outRms += out[i] ** 2; }
        }
    }
    assert.ok(outRms < inRms * 0.5,
        `expected >3 dB of reduction, got in=${inRms.toExponential(2)} out=${outRms.toExponential(2)}`);
});

// ---- the blanker -------------------------------------------------------------

const FS = 12000;

// Push a signal through in real-world chunks and collect the output.
function blank(nb, input, chunk = 512) {
    const out = new Float32Array(input.length);
    for (let at = 0; at < input.length; at += chunk) {
        const n = Math.min(chunk, input.length - at);
        nb.process(input.subarray(at, at + n), out.subarray(at, at + n));
    }
    return out;
}

t('disabled is bypass, no delay', () => {
    const nb = new NoiseBlanker(FS);
    const input = bandAudio(0.1);
    const out = blank(nb, input);
    assert.deepStrictEqual(Array.from(out), Array.from(input));
});

t('a clean signal passes, delayed but otherwise whole', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const input = bandAudio(1, FS, 11);
    const out = blank(nb, input);
    const d = nb._delay;
    // Compare RMS over the back half (envelope settled, delay filled).
    let inR = 0;
    let outR = 0;
    for (let i = input.length / 2; i < input.length - d; i++) {
        inR += input[i] ** 2;
        outR += out[i + d] ** 2;
    }
    assert.ok(Math.abs(outR - inR) / inR < 0.02,
        `clean audio changed by ${(100 * Math.abs(outR - inR)) / inR}%`);
    assert.strictEqual(nb.pulsesBlanked, 0, 'nothing should have triggered');
});

t('an impulse is removed, leading edge included', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const input = bandAudio(1, FS, 13);
    const at = 9000;
    // A 5-sample click, 30+ dB over the band.
    for (let i = 0; i < 5; i++) input[at + i] = 3.0;
    const out = blank(nb, input);
    const d = nb._delay;
    let peak = 0;
    for (let i = at - 2; i < at + 7; i++) peak = Math.max(peak, Math.abs(out[i + d]));
    assert.ok(peak < 0.05, `click survived at ${peak}`);
    assert.ok(nb.pulsesBlanked >= 1, 'the pulse should have been counted');
});

t('a pulse train does not raise its own threshold', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const input = bandAudio(2, FS, 17);
    const spots = [];
    // 25 clicks per second for a second, starting after warmup.
    for (let at = FS / 2; at < FS * 1.5; at += FS / 25) {
        const k = Math.round(at);
        input[k] = 2.0;
        input[k + 1] = 2.0;
        spots.push(k);
    }
    const out = blank(nb, input);
    const d = nb._delay;
    // Every click gone, not just the first few.
    for (const k of spots.slice(-10)) {
        const got = Math.max(Math.abs(out[k + d]), Math.abs(out[k + 1 + d]));
        assert.ok(got < 0.05, `late click at ${k} survived: ${got}`);
    }
});

t('audio returning after silence is not blanked wholesale', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const input = bandAudio(2, FS, 19);
    // Squelch closed for half a second in the middle.
    const s0 = Math.round(0.8 * FS);
    const s1 = Math.round(1.3 * FS);
    for (let i = s0; i < s1; i++) input[i] = 0;
    const out = blank(nb, input);
    const d = nb._delay;
    // 100 ms after audio returns it must be flowing again.
    const from = s1 + Math.round(0.1 * FS);
    let inR = 0;
    let outR = 0;
    for (let i = from; i < from + FS / 4; i++) {
        inR += input[i] ** 2;
        outR += out[i + d] ** 2;
    }
    assert.ok(outR > inR * 0.7, `audio after silence mostly missing: ${outR / inR}`);
});

t('the threshold means what it says', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    nb.setParameters({ thresholdDb: 30 });
    const input = bandAudio(1, FS, 23);
    // ~12 dB over the band average — loud speech peak, not an impulse.
    input[9000] = Math.abs(input[9000]) + 0.25;
    blank(nb, input);
    assert.strictEqual(nb.pulsesBlanked, 0, 'a peak under threshold must pass');
    // Same peak, threshold at the floor: now it is over.
    const nb2 = new NoiseBlanker(FS);
    nb2.enabled = true;
    nb2.setParameters({ thresholdDb: 6 });
    blank(nb2, input);
    assert.ok(nb2.pulsesBlanked >= 1, 'over threshold must trigger');
});

t('width changes rebuild cleanly and defaults are the panel’s', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    nb.setParameters({ widthMs: 8 });
    assert.ok(nb._delay > new NoiseBlanker(FS)._delay, 'wider cut, longer reach-back');
    const input = bandAudio(1, FS, 29);
    input[9000] = 3.0;
    const out = blank(nb, input);
    assert.ok(Math.abs(out[9000 + nb._delay]) < 0.05);
    assert.strictEqual(NB_DEFAULTS.enabled, false, 'ships off');
});

console.log(`\n${pass} ok`);
