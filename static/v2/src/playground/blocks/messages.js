// Finding things, and saying so: blocks whose output is events rather than a
// signal.
//
// The signal detector watches a complex wire for carriers standing out of the
// noise and says when one appears and when one goes — as messages, which a
// log shows and which later blocks (a decoder that starts on a new signal,
// say) can act on. It also puts the strongest one's frequency out as a
// control, so a demodulator's offset can follow whatever is loudest.

import { COMPLEX, CONTROL, MESSAGE, emitControl } from '../block.js';
import { IQSpectrum } from '../../lib/iqSpectrum.js';

// A signal missing from this many looks in a row is gone. One look is not
// enough: a carrier in a fade, or a CW element between dits, drops under the
// threshold for a moment and comes back, and should not flap gone-and-back.
const GONE_AFTER = 3;
// And it has to be there on this many looks before it is said to have
// appeared. In a few thousand bins of pure noise, one now and then stands well
// over the median on its own; it does not do it twice in the same place.
const APPEAR_AFTER = 2;

/**
 * Peaks of a spectrum standing `thresholdDb` over its median, merged where
 * closer than `gapHz`, strongest first, at most `max`. Frequencies are
 * refined between bins by fitting a parabola through the peak and its
 * neighbours, so a carrier's frequency is good to a fraction of a bin.
 * `db` is in display order, −rate/2 to +rate/2. Exported for the tests.
 */
export function findSignals(db, rate, { thresholdDb = 10, gapHz = 100, max = 8 } = {}) {
    const n = db.length;
    if (!n) return { floorDb: null, list: [] };
    const sorted = Float32Array.from(db).sort();
    const floor = sorted[n >> 1];
    const binHz = rate / n;
    const peaks = [];
    for (let k = 1; k < n - 1; k++) {
        const v = db[k];
        if (v < floor + thresholdDb || v < db[k - 1] || v < db[k + 1]) continue;
        // Parabolic interpolation in dB: where the true peak sits between
        // this bin and its neighbours.
        const a = db[k - 1];
        const c = db[k + 1];
        const den = a - 2 * v + c;
        const d = den < 0 ? (0.5 * (a - c)) / den : 0;
        // Width at 6 dB down, by walking out either side.
        let lo = k;
        let hi = k;
        while (lo > 0 && db[lo - 1] > v - 6) lo--;
        while (hi < n - 1 && db[hi + 1] > v - 6) hi++;
        peaks.push({
            hz: (k + d - n / 2) * binHz,
            db: v - 0.25 * (a - c) * d,
            snrDb: v - floor,
            widthHz: (hi - lo + 1) * binHz,
        });
    }
    peaks.sort((x, y) => y.db - x.db);
    const kept = [];
    for (const p of peaks) {
        if (kept.some((q) => Math.abs(q.hz - p.hz) < gapHz)) continue;
        kept.push(p);
        if (kept.length >= max) break;
    }
    return { floorDb: floor, list: kept };
}

export const SignalDetectorBlock = {
    type: 'signal-detector',
    label: 'Signal detector',
    category: 'Viewers',
    summary: 'Finds carriers standing out of the noise; says when one appears or goes.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [
        { name: 'events', kind: MESSAGE },
        { name: 'strongest', kind: CONTROL },
    ],
    params: {
        size: {
            kind: 'choice', label: 'Points', default: 2048,
            options: [512, 1024, 2048, 4096].map((v) => ({ value: v, label: String(v) })),
        },
        intervalMs: { kind: 'number', label: 'Look every', unit: 'ms', default: 500, min: 50, max: 10000, step: 10 },
        thresholdDb: { kind: 'number', label: 'Over the floor by', unit: 'dB', default: 15, min: 3, max: 60, step: 1, live: true },
        gapHz: { kind: 'number', label: 'Closest apart', unit: 'Hz', default: 150, min: 1, max: 20000, step: 10 },
        maxSignals: { kind: 'number', label: 'At most', default: 8, min: 1, max: 32, step: 1 },
    },
    create() {
        let spec = null;
        let rate = 12000;
        let p = {};
        let due = 0;
        let elapsed = 0;
        let current = [];
        let floorDb = null;
        // Signals being tracked: { hz, db, snrDb, widthHz, missed }.
        let tracked = [];
        return {
            configure(params, r) {
                p = params;
                rate = r;
                if (!spec || spec.size !== params.size) spec = new IQSpectrum(params.size);
            },
            reset() { if (spec) spec.reset(); due = 0; elapsed = 0; tracked = []; current = []; floorDb = null; },
            read() { return { signals: tracked.filter((s) => s.announced && !s.missed), floorDb, rate }; },
            process(ins, outs, n) {
                spec.push(ins[0].re, ins[0].im, n, rate);
                due += n;
                elapsed += n / rate;
                const every = Math.max(1, Math.round((p.intervalMs / 1000) * rate));
                if (due < every || !spec.ready) return 0;
                due = 0;
                const db = spec.frame(p.intervalMs / 1000);
                const found = findSignals(db, rate, { thresholdDb: p.thresholdDb, gapHz: p.gapHz, max: Math.round(p.maxSignals) });
                floorDb = found.floorDb;
                current = found.list;
                const events = outs[0].list;
                const seen = new Set();
                for (const s of current) {
                    let t = tracked.find((x) => !seen.has(x) && Math.abs(x.hz - s.hz) < p.gapHz);
                    if (t) Object.assign(t, s, { missed: 0, hits: t.hits + 1 });
                    else {
                        t = { ...s, missed: 0, hits: 1, since: elapsed, announced: false };
                        tracked.push(t);
                    }
                    seen.add(t);
                    if (!t.announced && t.hits >= APPEAR_AFTER) {
                        t.announced = true;
                        events.push({ type: 'appeared', at: elapsed, hz: t.hz, db: t.db, snrDb: t.snrDb, widthHz: t.widthHz });
                    }
                }
                for (const t of tracked) {
                    if (seen.has(t)) continue;
                    t.missed++;
                    // One that was never announced just lapses, unannounced.
                    if (t.missed === GONE_AFTER && t.announced) events.push({ type: 'gone', at: elapsed, hz: t.hz, lastedSec: elapsed - t.since });
                }
                tracked = tracked.filter((t) => t.missed < GONE_AFTER && (t.announced || t.missed === 0));
                const strongest = tracked.filter((t) => t.announced && !t.missed).sort((a, b) => b.db - a.db)[0];
                if (strongest && outs[1]) emitControl(outs[1], strongest.hz);
                return 0;
            },
        };
    },
};

// How many lines a log keeps.
const LOG_LINES = 500;

/** Every message that arrives, newest first, with when it came. */
export const MessageLogBlock = {
    type: 'message-log',
    label: 'Message log',
    category: 'Viewers',
    summary: 'Lists the messages that arrive — a detector’s finds, a decoder’s text.',
    inputs: [{ name: 'in', kind: MESSAGE }],
    outputs: [],
    params: {},
    create() {
        let lines = [];
        let count = 0;
        return {
            configure() {},
            reset() { lines = []; count = 0; },
            command(name) { if (name === 'clear') { lines = []; } },
            // All it keeps — the card shows a few, the inspector them all, and
            // Copy and Save take every one.
            read() { return { lines: lines.slice(), count }; },
            process(ins) {
                const input = ins[0];
                if (!input || !input.list.length) return 0;
                const wall = Date.now();
                for (const m of input.list) {
                    lines.unshift({ ...m, wall });
                    count++;
                }
                if (lines.length > LOG_LINES) lines.length = LOG_LINES;
                return 0;
            },
        };
    },
};
