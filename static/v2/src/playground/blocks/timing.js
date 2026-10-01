// Time and rate: holding a signal back, and changing its sample rate.
//
// A delay lines two paths up — the dry signal against the same signal through
// a filter, say, to subtract them or compare them on a scope. A resampler
// lets paths at different rates meet: inputs to one block must arrive at one
// rate, and a decimator rarely leaves two paths there by itself.

import { COMPLEX, REAL } from '../block.js';
import { Resampler, designResampler, resampleRatio } from '../../lib/dsp/resample.js';

const MAX_DELAY_SEC = 2;

function delay(kind) {
    return () => {
        let rate = 12000;
        let D = 0;
        const rings = kind === COMPLEX ? 2 : 1;
        let ring = [];
        let size = 0;
        let pos = 0;
        return {
            configure(p, r) {
                rate = r;
                const want = Math.max(0, Math.round((p.delayMs / 1000) * rate));
                const need = Math.round(MAX_DELAY_SEC * rate) + 1;
                if (size !== need) {
                    size = need;
                    ring = Array.from({ length: rings }, () => new Float64Array(size));
                    pos = 0;
                }
                D = Math.min(want, size - 1);
            },
            reset() { for (const r of ring) r.fill(0); pos = 0; },
            latency: () => D,
            process(ins, outs, n) {
                const src = [ins[0].re, ins[0].im];
                const dst = [outs[0].re, outs[0].im];
                for (let k = 0; k < n; k++) {
                    const back = (pos - D + size) % size;
                    for (let c = 0; c < rings; c++) {
                        ring[c][pos] = src[c][k];
                        dst[c][k] = ring[c][back];
                    }
                    pos = pos + 1 === size ? 0 : pos + 1;
                }
                return n;
            },
        };
    };
}

const DELAY_MS = { kind: 'number', label: 'Delay', unit: 'ms', default: 10, min: 0, max: MAX_DELAY_SEC * 1000, step: 0.1, live: true };

export const DelayBlock = {
    type: 'delay',
    label: 'Delay (complex)',
    category: 'Mixing',
    summary: 'Holds a complex signal back — to line two paths up.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: { delayMs: DELAY_MS },
    create: delay(COMPLEX),
};

export const AudioDelayBlock = {
    type: 'audio-delay',
    label: 'Delay (audio)',
    category: 'Audio',
    summary: 'Holds a real signal back — to line two paths up.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: { delayMs: DELAY_MS },
    create: delay(REAL),
};

const OUT_RATE = { kind: 'number', label: 'New rate', unit: 'Hz', default: 48000, min: 1000, max: 400000, step: 1, control: false };

function resampler(kind) {
    return () => {
        let key = '';
        let chans = [];
        let L = 1;
        let M = 1;
        let design = null;
        return {
            configure(p, r) {
                const k = `${r}/${p.rateHz}`;
                if (k === key) return;
                key = k;
                ({ L, M } = resampleRatio(r, p.rateHz));
                design = designResampler(L, M);
                chans = Array.from({ length: kind === COMPLEX ? 2 : 1 }, () => new Resampler(design, L, M));
            },
            reset() { for (const c of chans) c.reset(); },
            latency: () => (design ? design.delay : 0),
            read() { return { L, M, taps: design ? design.taps : 0 }; },
            process(ins, outs, n) {
                const m = chans[0].process(ins[0].re, outs[0].re, n);
                if (chans[1]) chans[1].process(ins[0].im, outs[0].im, n);
                return m;
            },
        };
    };
}

const rateOf = (inRate, p) => {
    const { L, M } = resampleRatio(inRate, p.rateHz);
    return (inRate * L) / M;
};
// Room for n in, at the ratio the input rate makes — plus a couple, since a
// block can straddle one more output than its exact share.
const maxOf = (n, p, inRate) => {
    const { L, M } = resampleRatio(inRate > 0 ? inRate : 12000, p.rateHz);
    return Math.ceil((n * L) / M) + 2;
};

export const ResampleBlock = {
    type: 'resample',
    label: 'Resample (complex)',
    category: 'Mixing',
    summary: 'Changes a complex signal’s sample rate — 44.1 to 48 kHz, 192 down to 12, anything between.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: { rateHz: OUT_RATE },
    rate: rateOf,
    maxOut: maxOf,
    create: resampler(COMPLEX),
};

export const AudioResampleBlock = {
    type: 'audio-resample',
    label: 'Resample (audio)',
    category: 'Audio',
    summary: 'Changes a real signal’s sample rate.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: { rateHz: OUT_RATE },
    rate: rateOf,
    maxOut: maxOf,
    create: resampler(REAL),
};

