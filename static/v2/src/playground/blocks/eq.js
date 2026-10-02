// Equalisers: the receiver's graphic EQ, and a parametric one.
//
// Both are a cascade of second-order sections (lib/dsp/biquad.js), the shapes
// a WebAudio BiquadFilterNode makes — the graphic EQ is the receiver's own,
// band for band: its twelve frequencies, peaking at Q 1, ±12 dB each, and a
// makeup gain (radio/audio-filters.js). A band at or above 45% of the rate
// is left out rather than bent down to fit: at 12 kHz there is no 6 kHz, and
// a peak squeezed under Nyquist would be somewhere else entirely.

import { REAL } from '../block.js';
import { Biquad, biquadCoefficients, biquadGainAt } from '../../lib/dsp/biquad.js';
import { EQ_FREQUENCIES, EQ_GAIN_MAX, EQ_GAIN_MIN } from '../../radio/audio-filters.js';

const IN = [{ name: 'in', kind: REAL }];
const OUT = [{ name: 'out', kind: REAL }];
const IIR_NOTE = 'An IIR filter: its delay varies with frequency, and is small.';

// The highest a band may sit, as a share of the rate.
const TOP = 0.45;

/**
 * An EQ's sections, `{ type, hz, q, db }` each, given its block type and
 * settings — the one description the audio, the card's curve and the tests
 * all use. Sections at 0 dB are left out: a peak or a shelf of nothing is
 * nothing, and costs a filter.
 */
export function eqSections(type, p) {
    if (type === 'graphic-eq') {
        return EQ_FREQUENCIES
            .map((hz) => ({ type: 'peaking', hz, q: 1, db: Number(p[`g${hz}`]) || 0 }))
            .filter((s) => s.db !== 0);
    }
    const out = [];
    if (p.lowDb) out.push({ type: 'lowshelf', hz: p.lowHz, q: 0.707, db: p.lowDb });
    for (let k = 1; k <= PARAMETRIC_BANDS; k++) {
        const db = Number(p[`b${k}Db`]) || 0;
        if (db) out.push({ type: 'peaking', hz: p[`b${k}Hz`], q: p[`b${k}Q`], db });
    }
    if (p.highDb) out.push({ type: 'highshelf', hz: p.highHz, q: 0.707, db: p.highDb });
    return out;
}

/** The EQ's output gain, in dB: makeup for the graphic, output for the parametric. */
export function eqGainDb(type, p) {
    return Number(type === 'graphic-eq' ? p.makeupDb : p.outDb) || 0;
}

/** Whether a section can be made at `rate`: under the top of the band. */
const fits = (s, rate) => s.hz > 0 && s.hz < TOP * rate;

/**
 * The response in dB at each of `freqs`: every section's gain, and the
 * output gain, as the card draws it.
 */
export function eqResponse(type, p, rate, freqs) {
    const sections = eqSections(type, p).filter((s) => fits(s, rate));
    const coeffs = sections.map((s) => biquadCoefficients(s.type, s.hz, s.q, s.db, rate));
    const gain = eqGainDb(type, p);
    return freqs.map((hz) => {
        let db = gain;
        for (const c of coeffs) db += 20 * Math.log10(Math.max(1e-9, biquadGainAt(c, hz, rate)));
        return db;
    });
}

/** The audio side: the sections in a row, then the gain. */
function eqInstance(type) {
    return () => {
        let filters = [];
        let gain = 1;
        let shape = '';
        return {
            configure(p, rate) {
                const sections = eqSections(type, p).filter((s) => fits(s, rate));
                // The same sections at another setting keep their state, so
                // moving a slider is a filter changing, not one restarting.
                const key = sections.map((s) => s.type).join(',');
                if (key !== shape) {
                    filters = sections.map(() => new Biquad());
                    shape = key;
                }
                sections.forEach((s, i) => filters[i].configure(s.type, s.hz, s.q, s.db, rate));
                gain = Math.pow(10, eqGainDb(type, p) / 20);
            },
            reset() { for (const f of filters) f.reset(); },
            latency: () => 0,
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                if (!filters.length) y.set(x.subarray(0, n));
                filters.forEach((f, i) => f.process(i === 0 ? x : y, y, n));
                if (gain !== 1) for (let k = 0; k < n; k++) y[k] *= gain;
                return n;
            },
        };
    };
}

const BAND_DB = (label, def = 0) => ({ kind: 'number', label, unit: 'dB', default: def, min: EQ_GAIN_MIN, max: EQ_GAIN_MAX, step: 0.5, live: true });
const bandLabel = (hz) => (hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);

export const GraphicEqBlock = {
    type: 'graphic-eq',
    label: 'Graphic EQ',
    category: 'Audio',
    summary: 'The receiver’s twelve-band EQ: ±12 dB at each of 60 Hz to 8 kHz, and a makeup gain. Bands above the audio’s reach are left out.',
    latencyNote: IIR_NOTE,
    inputs: IN,
    outputs: OUT,
    params: {
        ...Object.fromEntries(EQ_FREQUENCIES.map((hz) => [`g${hz}`, BAND_DB(bandLabel(hz))])),
        makeupDb: BAND_DB('Makeup gain'),
    },
    create: eqInstance('graphic-eq'),
};

// The parametric EQ's peaking bands, between its two shelves.
export const PARAMETRIC_BANDS = 4;
const PEAK_HZ = [300, 800, 1500, 2500];

const HZ = (label, def) => ({ kind: 'number', label, unit: 'Hz', default: def, min: 20, max: 20000, step: 10, live: true });
const Q = (label) => ({ kind: 'number', label, default: 1, min: 0.1, max: 20, step: 0.05, live: true });

export const ParametricEqBlock = {
    type: 'parametric-eq',
    label: 'Parametric EQ',
    category: 'Audio',
    summary: 'A low shelf, four peaking bands — each its own frequency, gain and width (Q) — and a high shelf. A band at 0 dB does nothing.',
    latencyNote: IIR_NOTE,
    inputs: IN,
    outputs: OUT,
    params: {
        lowHz: HZ('Low shelf', 150),
        lowDb: BAND_DB('Low shelf gain'),
        ...Object.fromEntries(Array.from({ length: PARAMETRIC_BANDS }, (_, i) => {
            const k = i + 1;
            return [
                [`b${k}Hz`, HZ(`Band ${k}`, PEAK_HZ[i])],
                [`b${k}Db`, BAND_DB(`Band ${k} gain`)],
                [`b${k}Q`, Q(`Band ${k} Q`)],
            ];
        }).flat()),
        highHz: HZ('High shelf', 3000),
        highDb: BAND_DB('High shelf gain'),
        outDb: BAND_DB('Output gain'),
    },
    create: eqInstance('parametric-eq'),
};
