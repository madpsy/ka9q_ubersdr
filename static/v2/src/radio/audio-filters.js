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
// Chain order follows v1 (app.js: bandpass, then notches, then EQ):
//
//   in -> [bandpass x stages] -> [notch x 6 per notch] -> [EQ x 12] -> makeup -> out

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
export const NOTCH_STAGES = 6;      // cascaded biquads per notch, as in v1

export const FILTER_DEFAULTS = {
    eq: { enabled: false, gains: EQ_FREQUENCIES.map(() => 0), makeup: 0 },
    notch: { enabled: false, items: [] },              // { center, width }
    bandpass: {
        enabled: false, center: 800, width: 200, stages: 4, autoQ: true, qMultiplier: 1,
    },
};

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

    if (!nodes.length) return null;
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return { input: nodes[0], output: nodes[nodes.length - 1], nodes };
}
