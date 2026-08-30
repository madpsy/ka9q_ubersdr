// The browser-side demodulator: does it actually demodulate, and does the panel
// that drives it render?
//
// The first half is the part no render test could reach and no reviewer could
// eyeball. A demodulator that is subtly wrong — the sideband on the wrong side,
// the CW pitch landing somewhere other than the pitch, the LSB spectrum not
// inverted — builds cleanly, runs at full speed, and produces confident noise.
// So the signals here are synthesised with known content and the output is
// measured at the frequency it is supposed to have arrived at, which is the only
// question that matters about a demodulator.
//
// The second half is the ordinary panel render check (see hookStub.js) plus the
// two facts about where the panel lives that the user asked for and that nothing
// else in the tree asserts: the left dock, open by default, and in the Decode
// group.

const assert = require('assert');

// Before the bundle: the panel registry reaches every panel in the build, and
// several of them read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.TextDecoder = globalThis.TextDecoder || require('util').TextDecoder;

const {
    deep, render, reset, walk, words,
    DRAG_SLOP_PX, IQ_FFT_SIZE, IQSpectrum, MARKER_GRAB_PX, aimCancel, aimDown, aimMove, aimUp,
    binsToPixels, fftInPlace, fractionOffset, hannWindow, markerAt, newAim, offsetFraction,
    IQPanel, vfoSummary, PANEL_BY_ID, GROUPS,
    DEMOD_MODES, IQ_HALF_SPAN, MAX_VFOS, PANS, VFO_LABELS, DemodChain,
    addVfo, clampOffset, clampWidth, demodSettings, designLowpass, getIQDemod, offsetLimits,
    passbandFor, planFor, planForVfo, removeVfo, resetDemodSettings, saveDemodSettings, selectVfo,
    tapsFor, updateVfo, vfoPassband, vfoWidth,
} = require('./.build/iqdemod.cjs');

// Storage that actually remembers, so the settings tests exercise the real path
// rather than a stub that forgets between calls.
const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
};

/**
 * Start from the defaults: one demodulator, in USB, on the dial.
 *
 * Always ends in a publish, even with nothing to patch. resetDemodSettings only
 * drops the cached copy — it does not notify — and the engine holds a copy of
 * its own that it keeps in step by subscribing. Without the publish, a test that
 * reset the settings and then rendered the panel would be looking at the
 * previous test's demodulators.
 */
function fresh(patch) {
    delete store['ubersdr.v2.iqdemod'];
    resetDemodSettings();
    return patch ? updateVfo(0, patch) : saveDemodSettings({});
}

const vfo0 = () => demodSettings().vfos[0];

// The panel's controls live inside components it does not export, so a plain
// walk() stops above them. deep() expands those; this is the text of the whole
// rendered tree.
const deepWords = (tree) => deep(tree).map((n) => words(n)).join(' ');

/** An element's class name, or '' — several assertions below key off it. */
const cls = (n) => (n && n.props && typeof n.props.className === 'string' ? n.props.className : '');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;

// ── measuring what came out ─────────────────────────────────────────────────

/**
 * The peak amplitude of one frequency component, by correlation.
 *
 * A whole FFT would answer more than is asked. Every question below is "is the
 * signal at *this* frequency, and not at that one", which is two correlations
 * and no bin-width argument about which one the energy landed in.
 */
function amplitudeAt(signal, freq, rate = RATE) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < signal.length; i++) {
        const th = (2 * Math.PI * freq * i) / rate;
        re += signal[i] * Math.cos(th);
        im -= signal[i] * Math.sin(th);
    }
    return (2 * Math.sqrt(re * re + im * im)) / signal.length;
}

/**
 * Run a generated quadrature stream through one demodulator.
 *
 * The head of the output is discarded: the FIR is up to 511 taps and the DC
 * blocker has its own settling time, so the first few hundred samples are the
 * filter filling up rather than anything the demodulator is claiming.
 */
function demodulate(plan, gen, { frames = 12000, skip = 3000 } = {}) {
    const chain = new DemodChain();
    chain.configure(plan, RATE);
    const I = new Float32Array(frames);
    const Q = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        const s = gen(i / RATE);
        I[i] = s.i;
        Q[i] = s.q;
    }
    // AGC off throughout: it is a listening aid, and leaving it on would make
    // every amplitude below a statement about the AGC instead of the demodulator.
    const out = chain.process(I, Q, frames, { agc: false, gain: 1 });
    assert.ok(out, 'the chain produced nothing');
    return Array.from(out.subarray(skip, frames));
}

/** A unit complex exponential at an offset within the stream. */
const tone = (offsetHz, amp = 1) => (tSec) => ({
    i: amp * Math.cos(2 * Math.PI * offsetHz * tSec),
    q: amp * Math.sin(2 * Math.PI * offsetHz * tSec),
});

/** Two of them at once, which is how a sideband gets something to reject. */
const both = (a, b) => (tSec) => {
    const x = a(tSec);
    const y = b(tSec);
    return { i: x.i + y.i, q: x.q + y.q };
};

// ── the filter ───────────────────────────────────────────────────────────────

t('the low-pass is symmetric, odd and unity-gain', () => {
    for (const cutoff of [250, 1350, 3000, 6000]) {
        const h = designLowpass(cutoff, RATE);
        assert.strictEqual(h.length % 2, 1, `${cutoff} Hz gave an even tap count`);
        let sum = 0;
        for (let i = 0; i < h.length; i++) sum += h[i];
        // Unity at DC, or changing the bandwidth would change the volume.
        assert.ok(Math.abs(sum - 1) < 1e-5, `${cutoff} Hz sums to ${sum}`);
        for (let i = 0; i < h.length; i++) {
            assert.ok(Math.abs(h[i] - h[h.length - 1 - i]) < 1e-9,
                `${cutoff} Hz is not symmetric at tap ${i}`);
        }
    }
});

t('a narrower filter costs more taps, within the cap', () => {
    assert.ok(tapsFor(250, RATE) > tapsFor(3000, RATE),
        'a 250 Hz cutoff should need a longer filter than a 3 kHz one');
    assert.ok(tapsFor(10, RATE) <= 511, 'the tap count has to stay under the cost cap');
    assert.ok(tapsFor(6000, RATE) >= 31, 'even a wide filter needs some skirt');
});

// ── the demodulators ────────────────────────────────────────────────────────

t('USB puts a signal above the offset at its distance from it', () => {
    // 1 kHz above the offset should be heard at 1 kHz, wherever in the stream
    // the offset happens to be — which is the whole claim of the panel.
    for (const off of [0, 2000, -3500]) {
        const plan = planFor({ mode: 'usb', offsetHz: off, widthHz: 2700 });
        const out = demodulate(plan, tone(off + 1000));
        assert.ok(amplitudeAt(out, 1000) > 0.8,
            `offset ${off}: expected a 1 kHz tone, got ${amplitudeAt(out, 1000).toFixed(3)}`);
        assert.ok(amplitudeAt(out, 2000) < 0.02,
            `offset ${off}: something arrived at 2 kHz that should not have`);
    }
});

t('USB rejects the sideband below the offset', () => {
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700 });
    // On its own first: a signal in the discarded sideband must produce nothing
    // anywhere in the audio range, not merely nothing at one frequency.
    const alone = demodulate(plan, tone(-1000));
    let peak = 0;
    for (let f = 50; f <= 3000; f += 50) peak = Math.max(peak, amplitudeAt(alone, f));
    assert.ok(peak < 0.01,
        `a signal in the rejected sideband came through at ${peak.toFixed(4)} (want < 0.01)`);

    // And with both present, which is the case that matters: the rejection has
    // to hold while the wanted signal is being received, not only in isolation.
    // This is the check that would fail if the filter were running on the real
    // part alone — there the two would fold together and be inseparable.
    const together = demodulate(plan, both(tone(1000), tone(-1000)));
    assert.ok(amplitudeAt(together, 1000) > 0.8,
        `the wanted sideband came through at ${amplitudeAt(together, 1000).toFixed(3)}`);
    let spur = 0;
    for (let f = 50; f <= 3000; f += 50) {
        if (Math.abs(f - 1000) < 150) continue;
        spur = Math.max(spur, amplitudeAt(together, f));
    }
    assert.ok(spur < 0.01, `the rejected tone left ${spur.toFixed(4)} somewhere in the audio`);
});

t('LSB puts a signal below the offset at its distance, spectrum inverted', () => {
    const plan = planFor({ mode: 'lsb', offsetHz: 0, widthHz: 2700 });
    // 1800 Hz below the offset is 1800 Hz of audio; 500 Hz below is 500 Hz. If
    // the inversion were missing these two would swap.
    for (const d of [500, 1800]) {
        const out = demodulate(plan, tone(-d));
        assert.ok(amplitudeAt(out, d) > 0.8,
            `${d} Hz below the offset came out at ${amplitudeAt(out, d).toFixed(3)}`);
    }
    // And the upper sideband is the one thrown away this time.
    const alone = demodulate(plan, tone(1000));
    let peak = 0;
    for (let f = 100; f <= 3000; f += 100) peak = Math.max(peak, amplitudeAt(alone, f));
    assert.ok(peak < 0.01, `LSB passed an upper-sideband signal at ${peak.toFixed(4)}`);
});

t('CW puts the carrier at the pitch, and moves with it', () => {
    for (const pitch of [400, 700, 1000]) {
        const plan = planFor({ mode: 'cw', offsetHz: 1500, widthHz: 500, pitchHz: pitch });
        const out = demodulate(plan, tone(1500));
        assert.ok(amplitudeAt(out, pitch) > 0.8,
            `pitch ${pitch}: got ${amplitudeAt(out, pitch).toFixed(3)}`);
        assert.ok(amplitudeAt(out, pitch + 400) < 0.05,
            `pitch ${pitch}: energy 400 Hz away from the pitch`);
    }
});

t('CW at 500 Hz rejects a signal a kilohertz off', () => {
    const plan = planFor({ mode: 'cw', offsetHz: 0, widthHz: 500, pitchHz: 700 });
    const out = demodulate(plan, tone(1000));
    let peak = 0;
    for (let f = 100; f <= 2000; f += 50) peak = Math.max(peak, amplitudeAt(out, f));
    assert.ok(peak < 0.02, `a 500 Hz filter passed a signal 1 kHz away at ${peak.toFixed(4)}`);
});

t('AM recovers the modulation and drops the carrier', () => {
    const plan = planFor({ mode: 'am', offsetHz: 2000, widthHz: 6000 });
    const depth = 0.5;
    const out = demodulate(plan, (tSec) => {
        const a = 1 + depth * Math.cos(2 * Math.PI * 1000 * tSec);
        const ph = 2 * Math.PI * 2000 * tSec;
        return { i: a * Math.cos(ph), q: a * Math.sin(ph) };
    });
    const got = amplitudeAt(out, 1000);
    assert.ok(got > 0.35 && got < 0.65, `expected about ${depth}, got ${got.toFixed(3)}`);
    // The carrier is a constant after the envelope detector, so what proves it
    // has gone is that the output has no standing offset.
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    assert.ok(Math.abs(mean) < 0.02, `the carrier survived as a DC offset of ${mean.toFixed(4)}`);
});

t('NFM recovers the modulating tone', () => {
    const plan = planFor({ mode: 'nfm', offsetHz: 0, widthHz: 8000 });
    const dev = 1500;
    const fm = 1000;
    const out = demodulate(plan, (tSec) => {
        const ph = (dev / fm) * Math.sin(2 * Math.PI * fm * tSec);
        return { i: Math.cos(ph), q: Math.sin(ph) };
    });
    const got = amplitudeAt(out, fm);
    // De-emphasis takes most of a kilohertz tone down, so the figure to hold is
    // that the modulating frequency dominates rather than what it measures.
    assert.ok(got > 0.01, `no modulation recovered (${got.toFixed(4)})`);
    assert.ok(got > 4 * amplitudeAt(out, 2 * fm),
        'the second harmonic is comparable to the tone — the discriminator is distorting');
    assert.ok(got > 4 * amplitudeAt(out, fm / 2), 'energy where there is no modulation');
});

t('a packet boundary is not audible', () => {
    // The same signal, once in one block and once in sixty, must give the same
    // audio: the phase of both oscillators and the filter history all have to
    // survive the call boundary or every 20 ms packet starts with a click.
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700 });
    const frames = 6000;
    const I = new Float32Array(frames);
    const Q = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        const th = (2 * Math.PI * 1000 * i) / RATE;
        I[i] = Math.cos(th);
        Q[i] = Math.sin(th);
    }

    const whole = new DemodChain();
    whole.configure(plan, RATE);
    const a = Array.from(whole.process(I, Q, frames, { agc: false, gain: 1 }).subarray(0, frames));

    const split = new DemodChain();
    split.configure(plan, RATE);
    const b = [];
    const step = 100;
    for (let at = 0; at < frames; at += step) {
        const out = split.process(I.subarray(at, at + step), Q.subarray(at, at + step), step,
            { agc: false, gain: 1 });
        for (let i = 0; i < step; i++) b.push(out[i]);
    }

    let worst = 0;
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    assert.ok(worst < 1e-4, `blocking changed the output by ${worst}`);
});

// ── the passband arithmetic the controls are built on ───────────────────────

t('the passband hangs off the offset the way each mode says', () => {
    assert.deepStrictEqual(passbandFor('usb', 1000, 2700), { lo: 1000, hi: 3700 });
    assert.deepStrictEqual(passbandFor('lsb', 1000, 2700), { lo: -1700, hi: 1000 });
    assert.deepStrictEqual(passbandFor('am', 1000, 6000), { lo: -2000, hi: 4000 });
    assert.deepStrictEqual(passbandFor('cw', -500, 500), { lo: -750, hi: -250 });
});

t('the offset cannot push the passband off the end of the stream', () => {
    // The claim the panel makes is that the filter is always inside the 12 kHz,
    // so this is checked by construction over every mode and every preset width
    // rather than at a few chosen points.
    for (const m of DEMOD_MODES) {
        for (const w of m.widths) {
            const { min, max } = offsetLimits(m.id, w);
            for (const off of [min, max, (min + max) / 2]) {
                const band = passbandFor(m.id, off, w);
                assert.ok(band.lo >= -IQ_HALF_SPAN - 1e-6 && band.hi <= IQ_HALF_SPAN + 1e-6,
                    `${m.id} at ${w} Hz, offset ${off}: passband ${band.lo}..${band.hi}`);
            }
            // And a request from outside is brought back rather than honoured.
            assert.strictEqual(clampOffset(m.id, 99999, w), Math.round(max));
            assert.strictEqual(clampOffset(m.id, -99999, w), Math.round(min));
        }
    }
});

t('a width too wide for the span leaves the offset with nowhere to go', () => {
    // 12 kHz of NFM fills the stream exactly: there is one place it can sit.
    const { min, max } = offsetLimits('nfm', 12000);
    assert.strictEqual(min, 0);
    assert.strictEqual(max, 0);
});

t('each mode keeps its own width', () => {
    fresh();
    updateVfo(0, { mode: 'usb', widths: { usb: 2400 } });
    updateVfo(0, { mode: 'cw', widths: { cw: 250 } });
    // Going back to USB must not find CW's 250 Hz filter — a single shared
    // figure would be wrong on one side of every mode change.
    updateVfo(0, { mode: 'usb' });
    assert.strictEqual(vfoWidth(vfo0()), 2400);
    assert.strictEqual(vfo0().widths.cw, 250);
    updateVfo(0, { mode: 'cw' });
    assert.strictEqual(vfoWidth(vfo0()), 250);
});

t('a stored width the mode will not take is brought into range', () => {
    // CW tops out well below a voice filter, so a settings file written by hand
    // or by an older build cannot ask for one.
    assert.strictEqual(clampWidth('cw', 6000), 2000);
    assert.strictEqual(clampWidth('usb', 10), 300);
    assert.strictEqual(clampWidth('usb', 'nonsense'), 2700);
});

// ── the mini spectrum ───────────────────────────────────────────────────────

t('the transform puts a tone in the bin it belongs to', () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    // A complex exponential at exactly bin 7 — the one input whose transform is
    // a single non-zero output, so anything wrong with the butterflies shows.
    for (let i = 0; i < n; i++) {
        const th = (2 * Math.PI * 7 * i) / n;
        re[i] = Math.cos(th);
        im[i] = Math.sin(th);
    }
    fftInPlace(re, im);
    for (let k = 0; k < n; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (k === 7) assert.ok(Math.abs(mag - n) < 1e-3, `bin 7 read ${mag}, want ${n}`);
        else assert.ok(mag < 1e-3, `bin ${k} should be empty, read ${mag}`);
    }
    // And a negative frequency lands in the top half, which is the fact the
    // display order below exists to undo.
    const re2 = new Float32Array(n);
    const im2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const th = (-2 * Math.PI * 7 * i) / n;
        re2[i] = Math.cos(th);
        im2[i] = Math.sin(th);
    }
    fftInPlace(re2, im2);
    const mag = (k) => Math.sqrt(re2[k] * re2[k] + im2[k] * im2[k]);
    assert.ok(Math.abs(mag(n - 7) - n) < 1e-3, `-7 should land in bin ${n - 7}`);
    assert.ok(mag(7) < 1e-3, 'a negative frequency must not appear in the positive half');
});

t('fftInPlace refuses a length it cannot transform', () => {
    assert.throws(() => fftInPlace(new Float32Array(6), new Float32Array(6)), /power-of-two/);
});

t('the window is a Hann window', () => {
    const w = hannWindow(9);
    assert.ok(Math.abs(w[0]) < 1e-6, 'it should start at zero');
    assert.ok(Math.abs(w[8]) < 1e-6, 'and end there');
    assert.ok(Math.abs(w[4] - 1) < 1e-6, 'and peak at one in the middle');
});

// The half swap, which is the bug this whole block exists for. In natural FFT
// order the positive half comes first and the negative half second, so a picture
// drawn straight from the bins has its two sides the wrong way round — and looks
// like a perfectly plausible spectrum of something else rather than like a fault.
function spectrumOf(offsetHz, { rate = 12000, amp = 1 } = {}) {
    const spec = new IQSpectrum();
    const n = IQ_FFT_SIZE * 2;
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const th = (2 * Math.PI * offsetHz * i) / rate;
        I[i] = amp * Math.cos(th);
        Q[i] = amp * Math.sin(th);
    }
    spec.push(I, Q, n, rate);
    const bins = spec.frame(0.05);
    assert.ok(bins, 'the ring should have filled');
    let at = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[at]) at = i;
    return { bins, at, peak: bins[at], size: bins.length };
}

t('the picture reads low frequency first, with the dial in the middle', () => {
    // The two sides have to come out on the two sides. A missing half swap puts
    // +2 kHz where -4 kHz belongs, which is the failure that looks like a
    // working display.
    for (const hz of [-4000, -2000, -500, 0, 500, 2000, 4000]) {
        const { at, size } = spectrumOf(hz);
        const want = offsetFraction(hz, 12000) * size;
        assert.ok(Math.abs(at - want) <= 2,
            `${hz} Hz peaked at bin ${at}, expected about ${want.toFixed(1)}`);
    }
});

t('a full-scale tone reads about 0 dBFS', () => {
    // The window normalisation. Without it the level moves with the transform
    // length, so the auto-scale would settle somewhere different every time the
    // size changed and nothing could be said about an absolute reading.
    const { peak } = spectrumOf(1500);
    assert.ok(Math.abs(peak) < 0.5, `a unit tone read ${peak.toFixed(2)} dBFS`);
    const half = spectrumOf(1500, { amp: 0.5 });
    assert.ok(Math.abs(half.peak + 6.02) < 0.5,
        `half amplitude should be about -6 dBFS, read ${half.peak.toFixed(2)}`);
});

t('there is no picture until the ring has filled', () => {
    const spec = new IQSpectrum();
    assert.strictEqual(spec.ready, false);
    assert.strictEqual(spec.frame(0.05), null);
    const n = IQ_FFT_SIZE;
    spec.push(new Float32Array(n), new Float32Array(n), n, 12000);
    assert.strictEqual(spec.ready, true);
    spec.reset();
    assert.strictEqual(spec.ready, false, 'a mode change is not a continuation');
    assert.strictEqual(spec.frame(0.05), null);
});

t('a block longer than the ring keeps its tail', () => {
    // The case a slow tab produces: the player hands over more than 1024 samples
    // at once, and what should survive is the newest of them.
    const spec = new IQSpectrum();
    const n = IQ_FFT_SIZE * 3;
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        // Silence, then a tone in the last third only.
        if (i < IQ_FFT_SIZE * 2) continue;
        const th = (2 * Math.PI * 3000 * i) / 12000;
        I[i] = Math.cos(th);
        Q[i] = Math.sin(th);
    }
    spec.push(I, Q, n, 12000);
    const bins = spec.frame(0.05);
    let at = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[at]) at = i;
    const want = offsetFraction(3000, 12000) * bins.length;
    assert.ok(Math.abs(at - want) <= 2, `kept the wrong part of the block (bin ${at})`);
});

t('the pointer mapping is the inverse of the picture’s', () => {
    // A press is read back through this and the passband is drawn through the
    // other. If they ever disagreed, tapping a signal would tune next to it.
    for (const hz of [-6000, -1234, 0, 1234, 6000]) {
        const back = fractionOffset(offsetFraction(hz, 12000), 12000);
        assert.ok(Math.abs(back - hz) < 1e-6, `${hz} round-tripped to ${back}`);
    }
    assert.strictEqual(offsetFraction(0, 12000), 0.5, 'the dial is the middle of the picture');
    assert.strictEqual(fractionOffset(0, 12000), -6000);
    assert.strictEqual(fractionOffset(1, 12000), 6000);
});

t('resampling to pixels keeps a carrier rather than averaging it away', () => {
    // A carrier is one bin wide. Taking the mean of each pixel’s bins would
    // bury it in the noise either side — at exactly the width where somebody is
    // looking for it.
    const bins = new Float32Array(1024).fill(-100);
    bins[500] = -20;
    const px = binsToPixels(bins, new Float32Array(128));
    assert.strictEqual(px[Math.floor((500 * 128) / 1024)], -20, 'the carrier was lost');
    let others = 0;
    for (let i = 0; i < px.length; i++) if (px[i] > -99) others++;
    assert.strictEqual(others, 1, 'it should not have smeared');
});

// ── more than one demodulator ───────────────────────────────────────────────

t('it starts with one', () => {
    const st = fresh();
    assert.strictEqual(st.vfos.length, 1);
    assert.strictEqual(st.active, 0);
    assert.strictEqual(st.vfos[0].pan, 'center');
    assert.strictEqual(st.vfos[0].muted, false);
});

t('up to four can be added, and no more', () => {
    fresh();
    for (let want = 2; want <= MAX_VFOS; want++) {
        const st = addVfo();
        assert.strictEqual(st.vfos.length, want);
        // The new one is the one being edited: adding is asking for it.
        assert.strictEqual(st.active, want - 1);
    }
    const full = addVfo();
    assert.strictEqual(full.vfos.length, MAX_VFOS, 'a fifth was added');
    // And there is a label for every one of them, or a row would render blank.
    assert.strictEqual(VFO_LABELS.length, MAX_VFOS);
});

t('a new one lands beside the old one, not on top of it', () => {
    // Started from the defaults, a second demodulator would sit in USB at the
    // dial — exactly where the first one is. That is the same audio twice and
    // one line on the picture, which looks like the button having done nothing.
    fresh({ mode: 'usb', offsetHz: 0, widths: { usb: 2700 } });
    const st = addVfo();
    const [a, b] = st.vfos;
    assert.strictEqual(b.mode, a.mode, 'it should be a copy of the one it came from');
    assert.strictEqual(vfoWidth(b), vfoWidth(a));
    assert.notStrictEqual(b.offsetHz, a.offsetHz, 'it landed on top of the original');
    // Clear of it, so the two passbands do not overlap.
    assert.ok(vfoPassband(b).lo >= vfoPassband(a).hi - 1,
        `${JSON.stringify(vfoPassband(b))} overlaps ${JSON.stringify(vfoPassband(a))}`);
});

t('at the top of the span the new one goes below instead', () => {
    // There is nowhere further up, and stacking it back on the original would
    // look like the button having done nothing.
    fresh({ mode: 'usb', widths: { usb: 2700 } });
    updateVfo(0, { offsetHz: IQ_HALF_SPAN });   // clamps to the top it can reach
    const top = vfo0().offsetHz;
    const st = addVfo();
    assert.ok(st.vfos[1].offsetHz < top, `expected below ${top}, got ${st.vfos[1].offsetHz}`);
});

t('one can be removed, but never the last', () => {
    fresh();
    assert.strictEqual(removeVfo(0).vfos.length, 1, 'the last one was removed');

    addVfo();
    addVfo();                       // three, editing the third
    assert.strictEqual(demodSettings().active, 2);
    // Removing one before the open row keeps the same row open, which means its
    // index moves down with it.
    let st = removeVfo(0);
    assert.strictEqual(st.vfos.length, 2);
    assert.strictEqual(st.active, 1, 'the open row changed under the operator');
    // Removing the open row steps back rather than forward: forward would be off
    // the end of the list.
    st = removeVfo(1);
    assert.strictEqual(st.vfos.length, 1);
    assert.strictEqual(st.active, 0);
});

t('changing one leaves the others alone', () => {
    fresh({ mode: 'usb' });
    addVfo();
    updateVfo(1, { mode: 'cw', pan: 'right', muted: true, gain: 2 });
    const [a, b] = demodSettings().vfos;
    assert.strictEqual(a.mode, 'usb');
    assert.strictEqual(a.pan, 'center');
    assert.strictEqual(a.muted, false);
    assert.strictEqual(b.mode, 'cw');
    assert.strictEqual(b.pan, 'right');
    assert.strictEqual(b.muted, true);
    assert.strictEqual(b.gain, 2);
    // ...including the per-mode widths, which are a nested merge.
    updateVfo(1, { widths: { cw: 250 } });
    assert.strictEqual(demodSettings().vfos[1].widths.usb, a.widths.usb);
    assert.strictEqual(demodSettings().vfos[1].widths.cw, 250);
});

t('selecting picks a row without disturbing anything', () => {
    fresh();
    addVfo();
    const before = JSON.stringify(demodSettings().vfos);
    const st = selectVfo(0);
    assert.strictEqual(st.active, 0);
    assert.strictEqual(JSON.stringify(st.vfos), before);
    // Out of range is refused rather than clamped: it would be a bug in the
    // caller, and moving the operator to a row they did not ask for is worse
    // than doing nothing.
    assert.strictEqual(selectVfo(9).active, 0);
});

t('settings written before there was more than one are read as the first', () => {
    // The shape this panel shipped with. Somebody's filter widths and their
    // place in the stream are exactly the things worth not losing.
    delete store['ubersdr.v2.iqdemod'];
    resetDemodSettings();
    store['ubersdr.v2.iqdemod'] = JSON.stringify({
        mode: 'cw', offsetHz: -1500, widths: { cw: 250, usb: 2400 }, pitchHz: 600,
        agc: false, gain: 1.5,
    });
    const st = demodSettings();
    assert.strictEqual(st.vfos.length, 1);
    assert.strictEqual(st.vfos[0].mode, 'cw');
    assert.strictEqual(st.vfos[0].offsetHz, -1500);
    assert.strictEqual(st.vfos[0].widths.cw, 250);
    assert.strictEqual(st.vfos[0].pitchHz, 600);
    assert.strictEqual(st.vfos[0].agc, false);
    // And the fields that did not exist then get their defaults rather than
    // undefined, which would reach the panner as NaN.
    assert.strictEqual(st.vfos[0].pan, 'center');
    assert.strictEqual(st.vfos[0].muted, false);
});

t('a stored pan this build does not know becomes centre', () => {
    fresh();
    updateVfo(0, { pan: 'behind' });
    assert.strictEqual(vfo0().pan, 'center');
    for (const p of PANS) {
        updateVfo(0, { pan: p.value });
        assert.strictEqual(vfo0().pan, p.value);
    }
});

t('a row says what it is, how wide, and where', () => {
    fresh({ mode: 'usb', offsetHz: 1200, widths: { usb: 2700 } });
    assert.strictEqual(vfoSummary(vfo0()), 'USB 2.7k · +1.2 kHz');
    updateVfo(0, { mode: 'cw', offsetHz: -3400, widths: { cw: 500 } });
    assert.strictEqual(vfoSummary(vfo0()), 'CW 500 · −3.4 kHz');
});

// ── picking one off the picture ─────────────────────────────────────────────

t('a press near a marker picks that demodulator up', () => {
    // With four on one picture a press has two plausible meanings, and this is
    // what tells them apart: near a marker it is "that one", anywhere else it is
    // "the one I am working on, to here".
    const offsets = [-3000, 0, 3000];
    const w = 300;                       // 40 Hz a pixel over the 12 kHz
    const xOf = (hz) => offsetFraction(hz, 12000) * w;

    assert.strictEqual(markerAt(offsets, xOf(0), w, 12000), 1);
    assert.strictEqual(markerAt(offsets, xOf(-3000) + 3, w, 12000), 0);
    assert.strictEqual(markerAt(offsets, xOf(3000) - MARKER_GRAB_PX, w, 12000), 2);
    // Past the threshold it is a place, not a marker.
    assert.strictEqual(markerAt(offsets, xOf(0) + MARKER_GRAB_PX + 1, w, 12000), -1);
    assert.strictEqual(markerAt([], xOf(0), w, 12000), -1);
    // A canvas that has not been laid out yet cannot be hit-tested.
    assert.strictEqual(markerAt(offsets, 10, 0, 12000), -1);
});

t('two markers on the same spot resolve to the one drawn on top', () => {
    // Which is the later one — see the draw order in IQPanel.
    assert.strictEqual(markerAt([1000, 1000], offsetFraction(1000, 12000) * 300, 300, 12000), 1);
});

// ── aiming with a finger ────────────────────────────────────────────────────
//
// The picture sits in a column that scrolls, so the same touch that might be
// aiming might be a swipe past the panel — and the browser only says which after
// a few pixels, by cancelling. None of this is visible without a touch screen in
// hand, and the failure it guards against is the worst kind: scrolling the panel
// silently moves the receiver.

const ev = (over) => ({ pointerId: 1, clientX: 100, pointerType: 'touch', ...over });
const mouse = (over) => ev({ pointerType: 'mouse', ...over });

t('a mouse tunes on the way down', () => {
    const st = newAim();
    assert.deepStrictEqual(aimDown(st, mouse()), { tune: true, capture: true });
    // And not again on the way up, or every click would tune twice.
    assert.deepStrictEqual(aimUp(st, mouse()), { tune: false });
});

t('a finger does not tune on the way down', () => {
    // The whole point: at pointerdown nobody yet knows whether this is a tap or
    // the start of a scroll, and a cancel arrives far too late to undo a tune.
    const st = newAim();
    assert.deepStrictEqual(aimDown(st, ev()), { tune: false, capture: false });
});

t('a tap tunes when it lifts', () => {
    const st = newAim();
    aimDown(st, ev());
    assert.deepStrictEqual(aimUp(st, ev()), { tune: true });
});

t('a thumb that wobbles is still a tap', () => {
    const st = newAim();
    aimDown(st, ev({ clientX: 100 }));
    // Inside the slop, so it has not become a drag.
    assert.strictEqual(aimMove(st, ev({ clientX: 100 + DRAG_SLOP_PX - 1 })).tune, false);
    assert.deepStrictEqual(aimUp(st, ev()), { tune: true });
});

t('a finger that travels becomes a drag, and takes the gesture', () => {
    const st = newAim();
    aimDown(st, ev({ clientX: 100 }));
    // Past the slop: tune, and capture — by now the browser has evidently not
    // claimed it for a scroll, and capture is what keeps the drag alive when it
    // runs off the end of the canvas.
    assert.deepStrictEqual(aimMove(st, ev({ clientX: 130 })), { tune: true, capture: true });
    // Every move after that tunes, but the capture is only asked for once.
    assert.deepStrictEqual(aimMove(st, ev({ clientX: 160 })), { tune: true, capture: false });
    // And the lift does not tune again, which would snap the offset back to
    // wherever the finger happened to leave.
    assert.deepStrictEqual(aimUp(st, ev()), { tune: false });
});

t('a scroll tunes nothing at all', () => {
    // The failure this whole arrangement exists for: a swipe down the panel that
    // happened to start on the picture must leave the receiver alone.
    const st = newAim();
    aimDown(st, ev());
    aimCancel(st);
    assert.deepStrictEqual(aimUp(st, ev()), { tune: false }, 'a cancelled gesture tuned');
    // ...including a stray move arriving after the cancel.
    assert.strictEqual(aimMove(st, ev({ clientX: 400 })).tune, false);
});

t('a second finger is ignored while one is in hand', () => {
    const st = newAim();
    aimDown(st, ev({ pointerId: 1 }));
    assert.strictEqual(aimMove(st, ev({ pointerId: 2, clientX: 400 })).tune, false);
    assert.deepStrictEqual(aimUp(st, ev({ pointerId: 2 })), { tune: false });
});

t('a move with nothing pressed does nothing', () => {
    // Hovering a mouse across the picture is not aiming.
    const st = newAim();
    assert.strictEqual(aimMove(st, mouse({ clientX: 300 })).tune, false);
    assert.deepStrictEqual(aimUp(st, mouse()), { tune: false });
});

// ── the panel ───────────────────────────────────────────────────────────────

function context(over) {
    const calls = [];
    const player = {
        ctx: null,
        ducked: false,
        setDucked(v) { player.ducked = v; calls.push(['duck', v]); },
        onAudio() { return () => {}; },
    };
    const ctx = {
        tuning: { frequency: 7_100_000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 },
        running: true,
        audioState: 'open',
        audio: { volume: 0.8, muted: false },
        iqPrompt: null,
        player,
        actions: { setMode: (m) => calls.push(['setMode', m]) },
        ...over,
    };
    ctx.calls = calls;
    return ctx;
}

const engine = () => getIQDemod(context().player);

t('it renders docked and minimal', () => {
    for (const minimal of [false, true]) {
        reset();
        const { tree, cleanups } = render(IQPanel, { minimal }, context());
        assert.ok(tree, `minimal=${minimal} produced nothing`);
        for (const off of cleanups) off();
    }
});

t('it renders before the receiver is running', () => {
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context({ running: false, audioState: 'closed' }));
    assert.ok(words(tree).includes('Start the receiver to demodulate its quadrature stream.'),
        'expected the not-running note');
    for (const off of cleanups) off();
});

t('it renders every demodulator', () => {
    for (const m of DEMOD_MODES) {
        fresh({ mode: m.id });
        reset();
        const { tree, cleanups } = render(IQPanel, {}, context());
        assert.ok(tree, `${m.id} produced nothing`);
        for (const off of cleanups) off();
    }
    // CW is the one with a control of its own, so it is the one that can render
    // differently from the rest without anything above noticing.
    fresh({ mode: 'cw' });
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    assert.ok(deepWords(tree).includes('CW pitch'), 'CW should offer a pitch control');
    for (const off of cleanups) off();

    fresh({ mode: 'usb' });
    reset();
    const usb = render(IQPanel, {}, context());
    assert.ok(!deepWords(usb.tree).includes('CW pitch'), 'only CW has a pitch');
    for (const off of usb.cleanups) off();
});

t('pressing the spectrum moves that demodulator, and cannot leave the span', () => {
    // The panel hands the picture every demodulator and takes back an index and
    // a place to listen. The arithmetic on both ends is pinned above; this is
    // the wiring, which is the half that would silently do nothing.
    fresh({ mode: 'usb', offsetHz: 0, widths: { usb: 2700 } });
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const scope = walk(tree).find((n) => n && n.props && typeof n.props.onOffset === 'function');
    assert.ok(scope, 'no spectrum in the panel');
    // What it is told to draw is what is actually running, or aiming at a signal
    // would put the filter somewhere else.
    assert.deepStrictEqual(scope.props.vfos.map(vfoPassband), [passbandFor('usb', 0, 2700)]);

    scope.props.onOffset(0, 2500);
    assert.strictEqual(vfo0().offsetHz, 2500, 'a press did not move the demodulator');

    // A press near the end of the picture cannot push the passband off it: in
    // USB at 2.7 kHz the offset stops 2.7 kHz short of the top.
    scope.props.onOffset(0, 99999);
    assert.strictEqual(vfo0().offsetHz, IQ_HALF_SPAN - 2700);
    scope.props.onOffset(0, -99999);
    assert.strictEqual(vfo0().offsetHz, -IQ_HALF_SPAN);
    for (const off of cleanups) off();
});

const startButton = (tree) => walk(tree).find((n) => n && n.props && n.props.children === 'Start');

t('Start switches a non-IQ receiver to iq', () => {
    engine().stop();
    reset();
    const ctx = context({
        tuning: { frequency: 7_100_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    });
    const { tree, cleanups } = render(IQPanel, {}, ctx);
    const start = startButton(tree);
    assert.ok(start, 'no Start button rendered');
    start.props.onClick();
    assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'setMode'), [['setMode', 'iq']],
        'Start should put the receiver into iq');
    // And it remembers where to put the operator back, or stopping strands them
    // in a mode that plays broadband noise.
    assert.strictEqual(engine().restoreMode, 'usb');
    for (const off of cleanups) off();
    engine().stop();
});

t('Start does not touch the mode when already in IQ', () => {
    engine().stop();
    reset();
    const ctx = context();
    const { tree, cleanups } = render(IQPanel, {}, ctx);
    startButton(tree).props.onClick();
    assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'setMode'), [],
        'already in IQ — nothing to change');
    assert.strictEqual(engine().restoreMode, null, 'nothing to restore');
    for (const off of cleanups) off();
    engine().stop();
});

t('Stop puts the mode back, and only from IQ', () => {
    const eng = engine();
    eng.stop();
    eng.restoreMode = 'usb';
    eng.start();
    reset();
    const ctx = context();
    const { tree, cleanups } = render(IQPanel, {}, ctx);
    const stop = walk(tree).find((n) => n && n.props && n.props.children === 'Stop');
    assert.ok(stop, 'a running demodulator should offer Stop');
    stop.props.onClick();
    assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'setMode'), [['setMode', 'usb']]);
    for (const off of cleanups) off();

    // If the operator has since chosen a mode themselves, that is the one they
    // want — the same rule the DRM panel follows.
    eng.stop();
    eng.restoreMode = 'usb';
    eng.start();
    reset();
    const ctx2 = context({ tuning: { frequency: 7_100_000, mode: 'am', bandwidthLow: -3000, bandwidthHigh: 3000 } });
    const out = render(IQPanel, {}, ctx2);
    walk(out.tree).find((n) => n && n.props && n.props.children === 'Stop').props.onClick();
    assert.deepStrictEqual(ctx2.calls.filter((c) => c[0] === 'setMode'), [],
        'the receiver was no longer where we put it');
    for (const off of out.cleanups) off();
    eng.stop();
});

t('running ducks the receiver, and only once the stream is quadrature', () => {
    const eng = engine();
    eng.stop();
    const player = context().player;
    // The engine holds the first player it was built with, so the duck is read
    // off that one rather than off a fresh stub.
    const own = eng.player;
    own.ducked = false;
    eng.setQuadrature(false);
    eng.start();
    assert.strictEqual(own.ducked, false,
        'ducked before the mode had arrived — that is the operator’s old audio');
    eng.setQuadrature(true);
    assert.strictEqual(own.ducked, true, 'IQ plays broadband noise; it has to be ducked');
    eng.stop();
    assert.strictEqual(own.ducked, false, 'a duck left on is a receiver gone silent for no reason');
    assert.ok(player, 'sanity');
});

t('it never releases a duck that was not its own', () => {
    // The player's duck is one flag that several things reach for — the
    // recorder's preview, the DRM panel, this. Asserting it false on a
    // transition this engine was not part of would silently bring the receiver's
    // own audio back up underneath whichever of them was using it.
    const eng = engine();
    eng.stop();
    const own = eng.player;
    own.ducked = true;
    eng.setQuadrature(false);
    eng.setQuadrature(true);
    assert.strictEqual(own.ducked, true, 'unducked something it had not ducked');
    eng.setQuadrature(false);
    assert.strictEqual(own.ducked, true, 'and again on the way back out');
    own.ducked = false;
});

t('every demodulator gets a row, and only the open one shows its controls', () => {
    // The layout claim: survey and adjustment at once. Four rows visible so you
    // can see where they all are, one set of controls so there is never a
    // question of which demodulator you are changing.
    fresh();
    addVfo();
    addVfo();
    addVfo();
    selectVfo(1);
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const nodes = deep(tree);

    const rows = nodes.filter((n) => cls(n).startsWith('iq-vfo ') || cls(n) === 'iq-vfo');
    assert.strictEqual(rows.length, MAX_VFOS, `expected ${MAX_VFOS} rows, got ${rows.length}`);
    const bodies = nodes.filter((n) => cls(n) === 'iq-vfo__body');
    assert.strictEqual(bodies.length, 1, 'more than one row was open at once');
    // And it is the one that was selected.
    const open = nodes.filter((n) => cls(n).includes('is-open'));
    assert.ok(open.length >= 1, 'nothing marked as the open row');
    // Each row names itself, so a line on the picture can be tied to a row.
    const names = nodes.filter((n) => cls(n) === 'iq-vfo__name').map((n) => words(n));
    assert.deepStrictEqual(names, VFO_LABELS.slice(0, MAX_VFOS));
    for (const off of cleanups) off();
});

t('pan and mute are on every row, not only the open one', () => {
    // The two you reach for while juggling several — which of these am I
    // listening to, and in which ear. Having to select a demodulator before you
    // could silence it would be the wrong way round.
    fresh();
    addVfo();
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const nodes = deep(tree);
    const mutes = nodes.filter((n) => cls(n).startsWith('iq-vfo__mute'));
    assert.strictEqual(mutes.length, 2, 'a row without a mute');
    const pans = nodes.filter((n) => cls(n).includes('iq-vfo__pan'));
    assert.strictEqual(pans.length, 2, 'a row without a pan control');
    for (const off of cleanups) off();
});

t('muting one row silences that one and selects nothing', () => {
    fresh();
    addVfo();
    selectVfo(1);
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const mutes = deep(tree).filter((n) => cls(n).startsWith('iq-vfo__mute'));
    // The first row, which is not the one being edited.
    mutes[0].props.onClick();
    const st = demodSettings();
    assert.strictEqual(st.vfos[0].muted, true);
    assert.strictEqual(st.vfos[1].muted, false, 'it muted the wrong one');
    assert.strictEqual(st.active, 1, 'muting a row should not move the editor to it');
    for (const off of cleanups) off();
});

t('a row can be picked without changing anything on it', () => {
    fresh();
    addVfo();
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const picks = deep(tree).filter((n) => cls(n) === 'iq-vfo__pick');
    assert.strictEqual(picks.length, 2);
    const before = JSON.stringify(demodSettings().vfos);
    picks[0].props.onClick();
    assert.strictEqual(demodSettings().active, 0);
    assert.strictEqual(JSON.stringify(demodSettings().vfos), before);
    for (const off of cleanups) off();
});

t('the add button stops at four and remove is absent when there is one', () => {
    fresh();
    reset();
    let out = render(IQPanel, {}, context());
    assert.ok(deepWords(out.tree).includes('Add demodulator'), 'no way to add a second');
    assert.ok(!deepWords(out.tree).includes('Remove demodulator'),
        'offered to remove the only demodulator');
    for (const off of out.cleanups) off();

    addVfo();
    addVfo();
    addVfo();
    reset();
    out = render(IQPanel, {}, context());
    assert.ok(!deepWords(out.tree).includes('Add demodulator'), 'offered a fifth');
    assert.ok(deepWords(out.tree).includes('Remove demodulator'));
    for (const off of out.cleanups) off();
});

t('pressing a marker on the picture picks that demodulator up', () => {
    fresh();
    addVfo();
    selectVfo(0);
    reset();
    const { tree, cleanups } = render(IQPanel, {}, context());
    const scope = walk(tree).find((n) => n && n.props && typeof n.props.onPick === 'function');
    assert.ok(scope, 'the picture is not wired to pick');
    // It is handed every demodulator, which is what lets it draw and hit-test
    // all of them rather than only the one being edited.
    assert.strictEqual(scope.props.vfos.length, 2);
    assert.strictEqual(scope.props.active, 0);
    scope.props.onPick(1);
    assert.strictEqual(demodSettings().active, 1);
    for (const off of cleanups) off();
});

// ── where it lives ──────────────────────────────────────────────────────────

t('the panel ships open in the left dock', () => {
    const entry = PANEL_BY_ID.iqdemod;
    assert.ok(entry, 'no iqdemod entry in the panel registry');
    assert.strictEqual(entry.dock, 'left');
    // Enabled by default: neither shipped collapsed nor shipped hidden.
    assert.notStrictEqual(entry.defaultOpen, false);
    assert.notStrictEqual(entry.defaultHidden, true);
});

t('the panel is in the Decode group', () => {
    const group = GROUPS.find((g) => g.id === 'decode');
    assert.ok(group, 'no Decode group');
    assert.ok(group.panels.includes('iqdemod'),
        `Decode holds ${group.panels.join(', ')}`);
    // In exactly one group, or the phone's tab bar lists it twice.
    const homes = GROUPS.filter((g) => g.panels.includes('iqdemod')).map((g) => g.id);
    assert.deepStrictEqual(homes, ['decode']);
});

console.log(`\n${pass} passed`);
