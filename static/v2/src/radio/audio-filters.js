// Client-side audio filters: EQ, notches and a bandpass.
//
// These are v1's filters (static/filters.js), same designs and same numbers, so
// a receiver sounds the same in both frontends. Everything here is a plain
// description — the maths that turns a slider into a biquad's Q, and the
// preset tables — with buildChain() the only part that touches Web Audio. That
// split is deliberate: the parameter maths is where a mistake is inaudible
// until someone notices the notch is in the wrong place, so it is testable
// without an AudioContext.
//
// Chain order is the one that makes musical sense, and matches v1's intent:
//
//   in -> gate -> [bandpass] -> [notch] -> [EQ] -> makeup -> compressor -> stereo -> out
//
// The gate goes first so nothing downstream has to work on noise it will only
// throw away, and the compressor goes after the EQ so it levels what you have
// actually shaped rather than fighting it. The stereo widener is last, because
// it is the only stage that stops being mono and everything before it assumes
// one signal.

// EQ band centres, and the presets, exactly as v1 defines them.
export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];

export const EQ_PRESETS = {
    voice: { 60: -6, 170: -3, 310: 0, 600: 2, 1000: 3, 1500: 4, 2000: 4, 2500: 3, 3000: 2, 4000: 0, 6000: -3, 8000: -6 },
    cw: { 60: -12, 170: -12, 310: -6, 600: 6, 1000: 6, 1500: 0, 2000: -6, 2500: -9, 3000: -12, 4000: -12, 6000: -12, 8000: -12 },
    music: { 60: 4, 170: 3, 310: -2, 600: -3, 1000: -2, 1500: 0, 2000: 2, 2500: 3, 3000: 4, 4000: 3, 6000: 2, 8000: 1 },
};

export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;
export const MAX_NOTCHES = 5;

// Bandpass width limits. v1 stops at 1 kHz, which is fine for CW and digimodes
// but too narrow to use the filter for shaping a whole SSB passband — 3 kHz
// covers that without letting the width exceed what any mode carries.
export const BP_WIDTH_MIN = 20;
export const BP_WIDTH_MAX = 3000;
export const NOTCH_STAGES = 6;      // cascaded biquads per notch, as in v1

// Gate. A soft gate — one that ducks by a set amount rather than slamming to
// silence — is far kinder on SSB, where the noise between words is part of what
// tells you the band is still there. Hysteresis and a hold time stop it
// chattering on speech pauses.
export const GATE_HYSTERESIS_DB = 3;

// Compressor. The Web Audio node does the work; these are its parameters plus a
// makeup gain, which the node does not provide.
export const COMP_LIMITS = {
    threshold: { min: -60, max: 0 },
    ratio: { min: 1, max: 20 },
    attack: { min: 0, max: 100 },      // ms
    release: { min: 20, max: 1000 },   // ms
    knee: { min: 0, max: 40 },
    makeup: { min: 0, max: 24 },       // dB
};

export const FILTER_DEFAULTS = {
    gate: {
        enabled: false,
        threshold: -45,     // dBFS of the audio arriving at the gate
        depth: 25,          // dB it ducks by when closed (not silence)
        attack: 5,          // ms to open
        hold: 150,          // ms held open after the signal drops
        release: 250,       // ms to close
    },
    eq: { enabled: false, gains: EQ_FREQUENCIES.map(() => 0), makeup: 0 },
    notch: { enabled: false, items: [] },              // { center, width }
    bandpass: {
        enabled: false, center: 800, width: 200, stages: 4, autoQ: true, qMultiplier: 1,
    },
    compressor: {
        enabled: false,
        threshold: -28,
        ratio: 3,
        attack: 10,         // ms
        release: 250,       // ms
        knee: 12,
        makeup: 6,          // dB
        autoMakeup: true,
    },
    stereo: {
        enabled: false,
        width: 50,          // % of the delayed copy mixed in, +/- per side
        delay: 16,          // ms
    },
};

// Auto makeup, from the reduction the compressor is *actually* applying.
//
// The obvious version — estimate it from threshold and ratio — assumes the
// audio peaks at 0 dBFS. Real audio here peaks nearer -20, so the compressor
// barely works while the estimate hands back double-digit gain, and enabling
// the compressor distorted instantly. DynamicsCompressorNode reports its live
// reduction, so use that: it cannot over-boost, because it only gives back what
// was taken.
//
// A little under unity (90%) leaves headroom, and the cap is there for the
// pathological case of a fully-limited signal.
export const MAKEUP_FACTOR = 0.9;
export const MAKEUP_MAX_DB = 12;

// Where the output is allowed to peak. Everything downstream — volume, the
// stereo widener's sum, the browser's own conversion — happens below 0 dBFS,
// and leaving a decibel of room is the difference between "loud" and "buzzing".
export const CEILING_DB = -1;

export function makeupFromReduction(reductionDb) {
    // `reduction` is negative dB (or 0 when nothing is being compressed).
    if (!Number.isFinite(reductionDb)) return 0;
    const give = Math.max(0, -reductionDb) * MAKEUP_FACTOR;
    return Math.min(MAKEUP_MAX_DB, give);
}

/**
 * The next makeup value, given what the compressor took and what the output is
 * actually peaking at.
 *
 * Reduction alone is not enough. It says how much the compressor pulled the
 * peaks down, not how much room is left above them: a signal already near full
 * scale has none, and handing back "what was taken" then clips. So the
 * reduction sets the ambition and the measured peak sets the limit, and the
 * limit wins.
 *
 * Asymmetric on purpose: back off fast, come back slowly. Distortion is
 * immediate and obvious; a slow recovery is inaudible.
 */
export function nextMakeupDb({ current, reductionDb, peakDb, ceilingDb = CEILING_DB }) {
    const want = makeupFromReduction(reductionDb);

    // How much this could change and still land on the ceiling. With no peak
    // reading yet, trust the reduction alone.
    const allowed = Number.isFinite(peakDb) ? current + (ceilingDb - peakDb) : want;
    const target = Math.max(0, Math.min(MAKEUP_MAX_DB, Math.min(want, allowed)));

    const rate = target < current ? 0.5 : 0.08;
    return current + (target - current) * rate;
}

// Whether the gate should be open, given the level now and whether it was open
// a moment ago. The hysteresis is what stops it chattering around the
// threshold; `hold` is applied by the caller, which knows the clock.
export function gateOpen(levelDb, threshold, wasOpen) {
    if (!Number.isFinite(levelDb)) return wasOpen;
    return wasOpen ? levelDb > threshold - GATE_HYSTERESIS_DB : levelDb > threshold;
}

// RMS of a byte time-domain frame, in dBFS. -Infinity for digital silence.
export function frameLevelDb(wave) {
    let sum = 0;
    for (let i = 0; i < wave.length; i++) {
        const v = (wave[i] - 128) / 128;
        sum += v * v;
    }
    const rms = Math.sqrt(sum / wave.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// v1's Q for a bandpass stage: centre over width, scaled by half the stage
// count so adding stages sharpens gradually rather than in jumps.
export function bandpassQ({ center, width, stages, autoQ, qMultiplier }) {
    const base = Math.max(0.7, (Math.abs(center) / Math.max(1, width)) * (stages / 2));
    return autoQ ? base : base * qMultiplier;
}

// v1's Q for a notch: the divisor of 3 spreads the width control across six
// cascaded stages, so a wider setting really is a wider notch.
export function notchQ(center, width) {
    return Math.max(0.7, Math.abs(center) / Math.max(1, width * 3));
}

// Applying a preset also pulls the makeup gain down, since a preset that boosts
// several bands would otherwise clip. v1 compensates by 70% of the average
// positive band gain.
export function presetMakeup(preset) {
    const boosts = EQ_FREQUENCIES.map((f) => preset[f]).filter((g) => g > 0);
    if (!boosts.length) return 0;
    const avg = boosts.reduce((a, b) => a + b, 0) / boosts.length;
    const compensation = Math.min(0, -avg * 0.7);
    return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Math.round(compensation * 2) / 2));
}

export function presetGains(name) {
    const preset = EQ_PRESETS[name];
    if (!preset) return null;
    return { gains: EQ_FREQUENCIES.map((f) => preset[f]), makeup: presetMakeup(preset) };
}

// Which preset the current sliders match, or null — so the panel can show what
// is loaded rather than just "custom".
export function detectPreset(gains) {
    for (const [name, preset] of Object.entries(EQ_PRESETS)) {
        if (EQ_FREQUENCIES.every((f, i) => gains[i] === preset[f])) return name;
    }
    return null;
}

// The bandpass centre can only sit inside the audio the mode actually carries,
// which is what v1's updateBandpassSliderRanges works out.
export function bandpassRange(window) {
    return {
        min: Math.max(50, Math.round(window.startFreq)),
        max: Math.max(Math.max(50, Math.round(window.startFreq)) + 10, Math.round(window.endFreq)),
    };
}

// Builds the node chain for a spec and returns { input, output } to splice in.
// Returns null when nothing is enabled, so the caller can bypass entirely
// rather than paying for a chain of no-ops.
export function buildChain(ctx, spec) {
    const nodes = [];
    let gate = null;

    // Gate first: an analyser to watch the level, and a gain the player drives.
    if (spec.gate && spec.gate.enabled) {
        const watch = ctx.createAnalyser();
        watch.fftSize = 1024;
        const duck = ctx.createGain();
        duck.gain.value = 1;
        nodes.push(watch, duck);
        gate = { watch, duck, spec: spec.gate, open: true, since: 0 };
    }

    if (spec.bandpass.enabled) {
        const q = bandpassQ(spec.bandpass);
        for (let i = 0; i < spec.bandpass.stages; i++) {
            const f = ctx.createBiquadFilter();
            f.type = 'bandpass';
            f.frequency.value = Math.abs(spec.bandpass.center);
            f.Q.value = q;
            nodes.push(f);
        }
    }

    if (spec.notch.enabled) {
        for (const n of spec.notch.items.slice(0, MAX_NOTCHES)) {
            const q = notchQ(n.center, n.width);
            for (let i = 0; i < NOTCH_STAGES; i++) {
                const f = ctx.createBiquadFilter();
                f.type = 'notch';
                f.frequency.value = Math.abs(n.center);
                f.Q.value = q;
                nodes.push(f);
            }
        }
    }

    if (spec.eq.enabled) {
        EQ_FREQUENCIES.forEach((freq, i) => {
            const f = ctx.createBiquadFilter();
            f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = 1.0;
            f.gain.value = spec.eq.gains[i] || 0;
            nodes.push(f);
        });
        const makeup = ctx.createGain();
        makeup.gain.value = Math.pow(10, (spec.eq.makeup || 0) / 20);
        nodes.push(makeup);
    }

    let compressor = null;
    if (spec.compressor && spec.compressor.enabled) {
        const c = spec.compressor;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = c.threshold;
        comp.ratio.value = c.ratio;
        comp.attack.value = Math.max(0, c.attack) / 1000;
        comp.release.value = Math.max(1, c.release) / 1000;
        comp.knee.value = c.knee;
        const makeup = ctx.createGain();
        // Auto starts at unity and follows the measured reduction; manual is
        // whatever the slider says.
        makeup.gain.value = c.autoMakeup ? 1 : Math.pow(10, c.makeup / 20);

        // Watches the makeup's own output, so the loop can see the peak it is
        // creating rather than the one it started from.
        const meter = ctx.createAnalyser();
        meter.fftSize = 1024;

        // Safety limiter, always present with the compressor. Auto makeup aims
        // to stay off it, and manual makeup can be set to anything at all — a
        // brickwall a decibel below full scale is what stops either of those
        // reaching the point where it buzzes.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = CEILING_DB;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.1;

        nodes.push(comp, makeup, meter, limiter);
        if (c.autoMakeup) compressor = { node: comp, makeup, meter, db: 0 };
    }

    // Stereo widener, last. Everything upstream is one signal; this is where it
    // stops being one. A delayed copy is added to one side and subtracted from
    // the other, which is the classic mono-to-stereo trick: at these delays the
    // ear reads it as space rather than as an echo, and the two sides still sum
    // back to the original if something downstream folds to mono.
    let stereoTail = null;
    if (spec.stereo && spec.stereo.enabled) {
        const input = ctx.createGain();
        const delay = ctx.createDelay(0.1);
        delay.delayTime.value = Math.max(0.001, Math.min(0.1, spec.stereo.delay / 1000));
        const w = Math.max(0, Math.min(1, spec.stereo.width / 100));
        const wet = ctx.createGain();
        wet.gain.value = w;
        const wetInv = ctx.createGain();
        wetInv.gain.value = -w;
        const merger = ctx.createChannelMerger(2);

        input.connect(merger, 0, 0);
        input.connect(merger, 0, 1);
        input.connect(delay);
        delay.connect(wetInv);
        delay.connect(wet);
        wetInv.connect(merger, 0, 0);
        wet.connect(merger, 0, 1);

        stereoTail = { input, output: merger, extra: [delay, wet, wetInv] };
    }

    if (!nodes.length && !stereoTail) return null;

    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

    let input = nodes[0];
    let output = nodes.length ? nodes[nodes.length - 1] : null;
    if (stereoTail) {
        if (output) output.connect(stereoTail.input);
        else input = stereoTail.input;
        output = stereoTail.output;
        nodes.push(stereoTail.input, stereoTail.output, ...stereoTail.extra);
    }

    return { input, output, nodes, gate, compressor };
}
