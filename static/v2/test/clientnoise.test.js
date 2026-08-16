// The client noise stage: the LSA engine's contract, NR2's parity with v1,
// and the blanker's behaviour.
//
// Three different kinds of test because the three files make three different
// promises. lib/nr2.js *is* v1's nr2.js, so it is held to sample-for-sample
// identity with v1's own file, learning phase included. lib/nr.js (LSA) and
// lib/noiseBlanker.js are new, so they are held to their contracts instead:
// noise goes down, signal survives, silence and retunes do not confuse them.

const assert = require('assert');
const path = require('path');

// v1's classes, loaded as v1 arranges them: fft.js defines the FFT global that
// nr2.js reaches for.
global.FFT = require(path.join(__dirname, '..', '..', 'fft.js'));
const V1NR2 = require(path.join(__dirname, '..', '..', 'nr2.js'));

const { NRProcessor: LSA, expint } = require('./.build/nr.cjs');
const { NR2Processor: NR } = require('./.build/nr2.cjs');
const {
    NoiseBlanker, NB_DEFAULTS, NB_THRESHOLD_MAX, NB_THRESHOLD_MIN,
} = require('./.build/noiseblanker.cjs');

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

t('NR2 is v1 NR2, sample for sample', () => {
    const input = bandAudio(2);
    const ours = new NR(2048, 4);
    const theirs = new V1NR2(null, 2048, 4);
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

t('NR2 parity holds across a re-learn and a parameter change', () => {
    const input = bandAudio(1, 12000, 21);
    const ours = new NR(2048, 4);
    const theirs = new V1NR2(null, 2048, 4);
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

t('NR2 actually reduces steady noise once learned', () => {
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

// ---- the LSA engine ----------------------------------------------------------

const LSA_FS = 12000;

// Amplitude of one frequency in a slice, via Goertzel — for asking "did the
// voice survive" without an FFT in the test.
function toneAmp(x, from, len, hz, fs = LSA_FS) {
    const w = (2 * Math.PI * hz) / fs;
    const c = 2 * Math.cos(w);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = from; i < from + len; i++) {
        s0 = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - c * s1 * s2;
    return Math.sqrt(Math.max(0, power)) / (len / 2);
}

function runLsa(nr, input, chunk = 1024) {
    const out = new Float32Array(input.length);
    for (let at = 0; at < input.length; at += chunk) {
        const n = Math.min(chunk, input.length - at);
        nr.process(input.subarray(at, at + n), out.subarray(at, at + n));
    }
    return out;
}

t('expint matches the tables', () => {
    // Abramowitz & Stegun: E1(0.5)=0.5598, E1(1)=0.2194, E1(2)=0.0489.
    assert.ok(Math.abs(expint(0.5) - 0.5598) < 1e-3);
    assert.ok(Math.abs(expint(1) - 0.21938) < 1e-3);
    assert.ok(Math.abs(expint(2) - 0.04890) < 1e-3);
});

t('LSA disabled is bypass', () => {
    const nr = new LSA(LSA_FS);
    const input = bandAudio(0.2);
    assert.deepStrictEqual(Array.from(runLsa(nr, input)), Array.from(input));
});

t('LSA cuts steady noise hard once converged', () => {
    const rnd = prng(31);
    const nr = new LSA(LSA_FS);
    nr.enabled = true;
    nr.setParameters(40);
    const input = new Float32Array(3 * LSA_FS);
    for (let i = 0; i < input.length; i++) input[i] = 0.05 * rnd();
    const out = runLsa(nr, input);
    let inP = 0;
    let outP = 0;
    for (let i = 2 * LSA_FS; i < input.length; i++) { inP += input[i] ** 2; outP += out[i] ** 2; }
    assert.ok(outP < inP * 0.12, `residual noise ${(10 * Math.log10(outP / inP)).toFixed(1)} dB`);
});

t('LSA keeps a modulated signal while cutting the noise around it', () => {
    // Tone bursts over noise — speech-shaped, as far as the estimator cares.
    const rnd = prng(37);
    const nr = new LSA(LSA_FS);
    nr.enabled = true;
    nr.setParameters(40);
    const input = new Float32Array(4 * LSA_FS);
    for (let i = 0; i < input.length; i++) {
        const burst = Math.floor(i / (0.3 * LSA_FS)) % 2 === 0;
        input[i] = 0.02 * rnd() + (burst ? 0.25 * Math.sin((2 * Math.PI * 800 * i) / LSA_FS) : 0);
    }
    const out = runLsa(nr, input);
    // A late burst: the 512-sample latency is inside the 3600-sample burst,
    // so measure the middle of it.
    const burstAt = Math.round(3.6 * LSA_FS) + 900;
    const kept = toneAmp(out, burstAt, 1800, 800) / toneAmp(input, burstAt, 1800, 800);
    assert.ok(kept > 0.7, `tone survived at ${(20 * Math.log10(kept)).toFixed(1)} dB`);
    // ...and a late gap is quieter than it came in.
    const gapAt = Math.round(3.3 * LSA_FS) + 900;
    let inP = 0;
    let outP = 0;
    for (let i = gapAt; i < gapAt + 1800; i++) { inP += input[i] ** 2; outP += out[i] ** 2; }
    assert.ok(outP < inP * 0.5, `gap noise only fell to ${(outP / inP).toFixed(2)}×`);
});

t('LSA strength orders the residual', () => {
    const residual = (strength) => {
        const rnd = prng(41);
        const nr = new LSA(LSA_FS);
        nr.enabled = true;
        nr.setParameters(strength);
        const input = new Float32Array(3 * LSA_FS);
        for (let i = 0; i < input.length; i++) input[i] = 0.05 * rnd();
        const out = runLsa(nr, input);
        let p = 0;
        for (let i = 2 * LSA_FS; i < input.length; i++) p += out[i] ** 2;
        return p;
    };
    assert.ok(residual(90) < residual(10) * 0.5, 'more strength must cut deeper');
});

t('LSA survives a reset and keeps working', () => {
    const rnd = prng(43);
    const nr = new LSA(LSA_FS);
    nr.enabled = true;
    nr.setParameters(60);
    const noise = () => {
        const b = new Float32Array(LSA_FS);
        for (let i = 0; i < b.length; i++) b[i] = 0.05 * rnd();
        return b;
    };
    runLsa(nr, noise());
    nr.resetLearning();
    const out = runLsa(nr, noise());
    for (let i = 0; i < out.length; i++) {
        assert.ok(Number.isFinite(out[i]), `non-finite sample after reset at ${i}`);
    }
    let p = 0;
    let q = 0;
    const tail = noise();
    const out2 = runLsa(nr, tail);
    for (let i = 0; i < tail.length; i++) { p += tail[i] ** 2; q += out2[i] ** 2; }
    assert.ok(q < p * 0.2, 'still reducing after the reset');
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

t('decoder residue under a closed squelch never triggers', () => {
    // The gate sends near-silence, not zeros: Opus decodes to dither around
    // -100 dBFS, and every flutter of it is "20 dB over the average". The
    // blanker used to sit there triggering constantly on audio nobody could
    // hear; the silence floor is what stops it.
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const rnd = prng(47);
    const input = new Float32Array(2 * FS);
    for (let i = 0; i < input.length; i++) input[i] = 1e-5 * rnd();
    // With the occasional louder tick, still far below anything audible.
    for (let at = FS / 4; at < input.length; at += FS / 3) input[Math.round(at)] = 3e-4;
    blank(nb, input);
    assert.strictEqual(nb.pulsesBlanked, 0, 'triggered on inaudible residue');
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
    // ...and the squelch opening itself is not read as a pulse: clean band,
    // clean silence, clean return — nothing here is an impulse.
    assert.strictEqual(nb.pulsesBlanked, 0, 'the squelch opening was blanked');
    // The very onset is intact too, not just the audio a tenth later. The
    // first millisecond is the envelope's to charge, so measure just past it.
    const onset = s1 + Math.round(0.002 * FS);
    let inO = 0;
    let outO = 0;
    for (let i = onset; i < onset + Math.round(0.05 * FS); i++) {
        inO += input[i] ** 2;
        outO += out[i + d] ** 2;
    }
    assert.ok(outO > inO * 0.7, `the first syllable after the squelch was eaten: ${outO / inO}`);
});

t('the threshold means what it says', () => {
    // Stated against the band's own average, which is what the number is dB
    // over — a peak fixed in absolute terms would only test whichever scale
    // happened to be in force when it was written.
    const input = bandAudio(1, FS, 23);
    let mean = 0;
    for (const v of input) mean += Math.abs(v);
    mean /= input.length;
    const peak = mean * Math.pow(10, 15 / 20);       // 15 dB over the average
    input[9000] = peak;

    const high = new NoiseBlanker(FS);
    high.enabled = true;
    high.setParameters({ thresholdDb: NB_THRESHOLD_MAX });   // 20 dB
    blank(high, input);
    assert.strictEqual(high.pulsesBlanked, 0, 'a peak under threshold must pass');

    const low = new NoiseBlanker(FS);
    low.enabled = true;
    low.setParameters({ thresholdDb: NB_THRESHOLD_MIN });    // 10 dB
    blank(low, input);
    assert.ok(low.pulsesBlanked >= 1, 'over threshold must trigger');
});

t('a keen threshold catches ordinary QRN, and says how much it cut', () => {
    // The regression this is here for: the threshold scale was once set where
    // clicks a plain 20 dB over the floor never triggered at all — the counter
    // crept up on the rare spike and the audio was untouched. Stated at 13 dB
    // rather than at the default, which sits deliberately at the quiet end of
    // the range and is a matter of taste rather than of arithmetic.
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    nb.setParameters({ thresholdDb: 13 });
    const input = bandAudio(4, FS, 51);
    let mean = 0;
    for (const v of input) mean += Math.abs(v);
    mean /= input.length;
    const amp = mean * Math.pow(10, 22 / 20);
    const at = [];
    for (let t = 0.5 * FS; t < input.length; t += FS / 20) {
        const k = Math.round(t);
        at.push(k);
        // Filtered click: a short ring, not a single sample.
        for (let j = 0; j < 10; j++) input[k + j] += amp * Math.exp(-j / 2.5) * Math.sin((2 * Math.PI * 1400 * j) / FS);
    }
    const out = blank(nb, input);
    const d = nb._delay;
    const caught = at.filter((k) => Math.abs(out[k + d]) < 0.25 * amp).length;
    assert.ok(caught > at.length * 0.6,
        `only ${caught}/${at.length} clicks blanked at the shipped threshold`);
    // ...and the readout says so rather than leaving "is it working" to the ear.
    assert.ok(nb.cutFraction > 0.005, `cut fraction reads ${(100 * nb.cutFraction).toFixed(2)}%`);
});

t('a blank is a one-shot, so speech is never held shut', () => {
    // The regression that matters most here, and the reason this file was
    // rewritten: a release that held the cut until a short envelope fell back
    // near the average removed more of each crash and made speech unlistenable
    // — one trigger on a syllable held the audio shut for the rest of the
    // word. A blank is a fixed length; runs of samples over the threshold
    // extend it, but nothing holds it open.
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    const input = bandAudio(6, FS, 11);
    for (let i = 0; i < input.length; i++) {
        const env = Math.max(0, Math.sin((2 * Math.PI * 3 * i) / FS)) ** 3;
        input[i] += 0.35 * env * Math.sin((2 * Math.PI * 500 * i) / FS)
            * (0.6 + 0.4 * Math.sin((2 * Math.PI * 70 * i) / FS));
    }
    const out = blank(nb, input);
    const d = nb._delay;
    let run = 0;
    let longest = 0;
    for (let i = 0; i < input.length - d; i++) {
        const a = Math.abs(input[i]);
        if (a > 1e-4 && Math.abs(out[i + d]) < 0.3 * a) {
            run++;
            if (run > longest) longest = run;
        } else {
            run = 0;
        }
    }
    const ms = (1000 * longest) / FS;
    // Several blanks in a row over one syllable is fine; a tenth of a second
    // of held silence is the expander coming back.
    assert.ok(ms < 25, `speech was held shut for ${ms.toFixed(0)} ms at a time`);
});

t('a static crash is cut, and harder as the threshold comes down', () => {
    // The crash shape is measured, not invented: 74 s of 10.125 MHz USB off a
    // receiver with crashes every few seconds. Averaged over the twenty
    // biggest, the envelope peaks about 20 dB over the band and decays through
    // +12 dB at 2 ms, +8 dB at 6 ms and +4 dB at 10 ms. On that recording the
    // shipped 15 dB takes 13 dB out of the crash blocks for 0.3 dB of
    // everything else, and 12 dB takes 21 dB for 1.2 dB — which is the trade
    // the threshold slider is.
    const crashes = (thresholdDb) => {
        const nb = new NoiseBlanker(FS);
        nb.enabled = true;
        nb.setParameters({ thresholdDb });
        const input = bandAudio(4, FS, 81);
        let mean = 0;
        for (const v of input) mean += Math.abs(v);
        mean /= input.length;
        const rnd = prng(83);
        const at = [];
        const body = Math.round(0.02 * FS);
        for (let t = 0.6 * FS; t < input.length - body; t += FS / 3) {
            const k = Math.round(t);
            at.push(k);
            for (let j = 0; j < body; j++) {
                const over = 20 - 1.2 * ((1000 * j) / FS);
                if (over <= 0) break;
                input[k + j] += mean * Math.pow(10, over / 20) * (0.5 + rnd());
            }
        }
        const out = blank(nb, input);
        const d = nb._delay;
        let inE = 0;
        let outE = 0;
        for (const k of at) {
            for (let j = 0; j < body; j++) { inE += input[k + j] ** 2; outE += out[k + j + d] ** 2; }
        }
        return -10 * Math.log10(outE / inE);
    };
    const keen = crashes(13);
    assert.ok(keen > 3, `only ${keen.toFixed(1)} dB taken out at 13 dB`);
    assert.ok(crashes(NB_THRESHOLD_MIN + 2) > keen + 2, 'a lower threshold must cut deeper');
    // ...and the shipped default, wherever taste has put it, must still be
    // inside the range its own sliders offer.
    assert.ok(NB_DEFAULTS.thresholdDb >= NB_THRESHOLD_MIN
        && NB_DEFAULTS.thresholdDb <= NB_THRESHOLD_MAX, 'the default threshold is off its slider');
});

t('the cut readout is ~0 when nothing is being caught', () => {
    const nb = new NoiseBlanker(FS);
    nb.enabled = true;
    blank(nb, bandAudio(3, FS, 53));
    assert.ok(nb.cutFraction < 0.001, `clean band reads ${(100 * nb.cutFraction).toFixed(2)}%`);
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
