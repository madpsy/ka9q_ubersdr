// A pulse classifier: each pulse measured, and named by how long it was.
//
// The level coming in (a Threshold's clean 0/1, a squelch's gate) is cut into
// pulses where it crosses `level`; each pulse's length is measured to a
// fraction of a sample — the crossing placed between the two samples either
// side of it — and looked up in a list of classes, each a name and a range of
// lengths. A pulse in none of them is counted and passed over rather than
// guessed at.
//
// The time signals are pulse-width codes, and have presets:
//
//   WWV / WWVH   the 100 Hz subcarrier ON for 0.2 s (0), 0.5 s (1), 0.8 s (marker)
//   WWVB         the carrier DOWN for 0.2 / 0.5 / 0.8 s
//   DCF77        the carrier DOWN for 0.1 s (0) or 0.2 s (1); the minute is the
//                second with no pulse at all, which a gap twice as long shows
//   MSF          the carrier OFF for 0.1, 0.2, 0.3 s (A/B = 00, 10, 11) or 0.5 s
//                (the minute). Its A=0 B=1 second is two short pulses, which
//                width alone cannot read — the Time code decoder reads MSF
//                properly, by its tenths.
//
// Or any list of your own: CW's dits and dahs at a speed, PWM telemetry, sync
// pulses.
//
// Out:
//   symbols  one message per pulse: { symbol, widthMs, gapMs, at } — `gapMs`
//            from the start of the last pulse, `at` the start in seconds of
//            stream
//   text     the symbols as characters, for any text viewer
//   width    each pulse's length in ms, as a control
//   bits     0 and 1 as a bit stream, for the Bit viewer and the bit decoders:
//            the classes named "0" and "1" only

import { BITS, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';

/** The presets: what is measured, and the classes it is sorted into. */
export const PULSE_PRESETS = {
    wwv: { label: 'WWV / WWVH (100 Hz subcarrier)', measure: 'high', classes: '0: 100-350, 1: 350-650, M: 650-950' },
    wwvb: { label: 'WWVB (carrier reduction)', measure: 'low', classes: '0: 100-350, 1: 350-650, M: 650-950' },
    dcf77: { label: 'DCF77 (carrier reduction)', measure: 'low', classes: '0: 40-150, 1: 150-280' },
    msf: { label: 'MSF (carrier off)', measure: 'low', classes: '0: 50-150, 1: 150-250, 3: 250-380, M: 400-650' },
};

/**
 * A list of classes from its text: `name: from-to` in ms, separated by commas
 * or new lines. Names are up to four characters. Malformed entries are left
 * out; the rest are kept in order, the first match winning.
 */
export function parseClasses(text) {
    const out = [];
    for (const part of String(text || '').split(/[,\n;]+/)) {
        const m = /^\s*([^:\s]{1,4})\s*:\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
        if (!m) continue;
        const lo = Number(m[2]);
        const hi = Number(m[3]);
        if (hi > lo) out.push({ name: m[1], lo, hi });
    }
    return out;
}

/** The class a pulse of `ms` falls in, or null. */
export function classify(classes, ms) {
    for (const c of classes) if (ms >= c.lo && ms < c.hi) return c.name;
    return null;
}

// How many recent symbols the card shows.
const RECENT = 60;

export const PulseClassifierBlock = {
    type: 'pulse-classifier',
    label: 'Pulse classifier',
    category: 'Digital',
    summary: 'Measures each pulse and names it by its length — a time signal’s 0, 1 and marker, CW’s dit and dah, any pulse-width code.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [
        { name: 'symbols', kind: MESSAGE },
        { name: 'text', kind: MESSAGE },
        { name: 'width', kind: CONTROL },
        { name: 'bits', kind: BITS },
    ],
    activity: 'A pulse was read',
    // Bits come out a pulse at a time, which is about a second apart on a
    // time signal: a nominal rate for whatever reads them.
    rate: () => 1,
    maxOut: (n) => Math.ceil(n / 2) + 2,
    params: {
        preset: {
            kind: 'choice', label: 'Code', default: 'wwv',
            options: [...Object.entries(PULSE_PRESETS).map(([value, p]) => ({ value, label: p.label })), { value: 'custom', label: 'Your own' }],
        },
        measure: {
            kind: 'choice', label: 'Pulses are', default: 'high',
            options: [{ value: 'high', label: 'Above the level' }, { value: 'low', label: 'Below the level' }],
            showIf: (p) => p.preset === 'custom',
        },
        classes: { kind: 'text', label: 'Classes (name: from-to ms)', default: '0: 100-350, 1: 350-650, M: 650-950', max: 400, showIf: (p) => p.preset === 'custom' },
        level: { kind: 'number', label: 'Level', default: 0.5, min: -1000, max: 1000, step: 0.001, live: true },
    },
    create() {
        let p = {};
        let rate = 1000;
        let classes = [];
        let high = true;
        let count = 0;          // samples seen
        let prev = null;
        let startAt = null;     // where the pulse in progress began, in samples
        let lastStart = null;
        let recent = '';
        let last = null;
        let rejects = 0;
        let read = 0;
        let busy = false;
        const counts = {};
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                const preset = PULSE_PRESETS[params.preset];
                classes = parseClasses(preset ? preset.classes : params.classes);
                high = (preset ? preset.measure : params.measure) !== 'low';
            },
            reset() {
                count = 0; prev = null; startAt = null; lastStart = null; recent = ''; last = null; rejects = 0; read = 0;
                for (const k of Object.keys(counts)) delete counts[k];
            },
            command(name) { if (name === 'clear') { recent = ''; last = null; rejects = 0; read = 0; for (const k of Object.keys(counts)) delete counts[k]; } },
            read() { return { recent, last, rejects, read, counts: { ...counts }, classes: classes.map((c) => c.name) }; },
            activity() {
                const was = busy;
                busy = false;
                return was ? 1 : 0;
            },
            process(ins, outs, n) {
                const x = ins[0] && ins[0].re;
                const m = ins[0] && ins[0].n != null ? ins[0].n : n;
                const bits = outs[3] && outs[3].re;
                let b = 0;
                if (!x) return 0;
                const level = p.level;
                for (let k = 0; k < m; k++) {
                    const v = x[k];
                    const a = prev;
                    prev = v;
                    if (a === null) continue;
                    const was = high ? a >= level : a < level;
                    const is = high ? v >= level : v < level;
                    if (was === is) continue;
                    // The crossing, between the two samples.
                    const frac = v === a ? 0 : (level - a) / (v - a);
                    const at = count + k - 1 + frac;
                    if (is) {
                        startAt = at;
                        continue;
                    }
                    if (startAt === null) continue;
                    const widthMs = ((at - startAt) / rate) * 1000;
                    const name = classify(classes, widthMs);
                    const gapMs = lastStart === null ? null : ((startAt - lastStart) / rate) * 1000;
                    lastStart = startAt;
                    const startSec = startAt / rate;
                    startAt = null;
                    if (outs[2]) emitControl(outs[2], widthMs);
                    if (name === null) { rejects++; continue; }
                    read++;
                    busy = true;
                    counts[name] = (counts[name] || 0) + 1;
                    last = { symbol: name, widthMs };
                    recent = (recent + name).slice(-RECENT);
                    if (outs[0] && outs[0].list) outs[0].list.push({ type: 'symbol', symbol: name, widthMs, gapMs, at: startSec });
                    if (outs[1] && outs[1].list) outs[1].list.push({ type: 'text', text: name });
                    if (bits && (name === '0' || name === '1')) bits[b++] = name === '1' ? 1 : 0;
                }
                count += m;
                return b;
            },
        };
    },
};
