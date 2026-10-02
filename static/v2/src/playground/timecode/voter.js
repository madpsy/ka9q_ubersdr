// Voting across consecutive minutes: ubersdr-ntp's TimeFrameVoter
// (src/clock/TimeFrameVoter.cpp), ported line for line.
//
// Each decoded minute is a frame of 60 symbols with a confidence each. Every
// frame is first carried forward to the newest minute (so a stale hour cannot
// outvote a fresh one), then each field is composed bit by bit — but only where
// every bit's confidence-winner agrees with its plain count majority; where
// they disagree the field falls back to the value some frame actually held, so
// voting can never assemble a phantom time. Quality is worked out in the same
// pass, so value and quality cannot disagree. A lock needs consecutive +1
// minutes, confident static fields, a fresh valid frame, a quality floor, and
// — where a reference clock is given — a time within a day of it.
//
// Field maps are lists of [second, weight]. The stations' own layouts are
// carried into the voter as WWVB's for MSF, DCF77 and ALS162 (they build
// synthetic frames), and as WWV's own for WWV.

import { advanceMinutes } from './civil.js';

export const SYM = { ZERO: 0, ONE: 1, MARKER: 2, UNKNOWN: -1 };
export const FIELDS = ['minute', 'hour', 'doy', 'year2'];

/** WWVB's layout, which the LF decoders' synthetic frames use too. */
export const WWVB_MAP = {
    minute: [[1, 40], [2, 20], [3, 10], [5, 8], [6, 4], [7, 2], [8, 1]],
    hour: [[12, 20], [13, 10], [15, 8], [16, 4], [17, 2], [18, 1]],
    doy: [[22, 200], [23, 100], [25, 80], [26, 40], [27, 20], [28, 10], [30, 8], [31, 4], [32, 2], [33, 1]],
    year2: [[45, 80], [46, 40], [47, 20], [48, 10], [50, 8], [51, 4], [52, 2], [53, 1]],
};
export const WWVB_MARKERS = [0, 9, 19, 29, 39, 49, 59];

/** WWV's (NIST SP 432). */
export const WWV_MAP = {
    minute: [[10, 1], [11, 2], [12, 4], [13, 8], [15, 10], [16, 20], [17, 40]],
    hour: [[20, 1], [21, 2], [22, 4], [23, 8], [25, 10], [26, 20]],
    doy: [[30, 1], [31, 2], [32, 4], [33, 8], [35, 10], [36, 20], [37, 40], [38, 80], [40, 100], [41, 200]],
    year2: [[4, 1], [5, 2], [6, 4], [7, 8], [51, 10], [52, 20], [53, 40], [54, 80]],
};

const isLeap2 = (y2) => { const y = 2000 + y2; return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); };

function minutesSince2000(t) {
    let days = 0;
    for (let y = 0; y < t.year2; y++) days += isLeap2(y) ? 366 : 365;
    days += t.doy - 1;
    return (days * 24 + t.hour) * 60 + t.minute;
}

const inRange = (t) => t.minute >= 0 && t.minute <= 59 && t.hour >= 0 && t.hour <= 23
    && t.doy >= 1 && t.doy <= 366 && t.year2 >= 0 && t.year2 <= 99;

const agedWeight = (conf, aging, age) => Math.max(conf, 0.01) * aging ** age;

/**
 * Greedy largest-weight-first encode of `value` over a field map: the bits
 * (ONE/ZERO, parallel to the map).
 */
export function encodeField(map, value) {
    const bits = map.map(() => SYM.ZERO);
    const order = map.map((_, k) => k).sort((a, b) => map[b][1] - map[a][1]);
    let rem = value;
    for (const k of order) {
        if (map[k][1] > 0 && map[k][1] <= rem) { bits[k] = SYM.ONE; rem -= map[k][1]; }
    }
    return bits;
}

/**
 * A synthetic 60-second frame in `map`'s layout carrying `fields`, every field
 * bit at `confOf(field)`: how the LF decoders hand their decoded minutes to the
 * voter. `fields` null gives an all-Unknown frame (it keeps the chain's slot).
 */
export function syntheticFrame(fields, confOf, map = WWVB_MAP, markers = WWVB_MARKERS) {
    const symbols = new Array(60).fill(SYM.UNKNOWN);
    const conf = new Array(60).fill(0);
    for (const s of markers) symbols[s] = SYM.MARKER;
    if (!fields) return { symbols, conf };
    for (const f of FIELDS) {
        const bits = encodeField(map[f], fields[f]);
        const c = typeof confOf === 'function' ? confOf(f) : confOf;
        map[f].forEach(([sec], k) => { symbols[sec] = bits[k]; conf[sec] = c; });
    }
    return { symbols, conf };
}

export class TimeFrameVoter {
    constructor({
        fields = WWVB_MAP, window = 8, minFramesForLock = 2, agingFactor = 0.9,
        minBitConfidence = 0.05, minLockQuality = 0.05, maxNewestValidAge = 3,
        referenceNow = null, plausibilityBoundMinutes = 0,
    } = {}) {
        this.cfg = { fields, window, minFramesForLock, agingFactor, minBitConfidence, minLockQuality, maxNewestValidAge, referenceNow, plausibilityBoundMinutes };
        this.frames = [];
    }

    /** A reference clock (a function giving its fields) and how far a lock may be from it, in minutes. */
    setPlausibility(referenceNow, boundMinutes) {
        this.cfg.referenceNow = referenceNow;
        this.cfg.plausibilityBoundMinutes = boundMinutes;
    }

    addFrame(symbols, confidence) {
        this.frames.push({ symbols: symbols.slice(), confidence: confidence.slice() });
        while (this.frames.length > this.cfg.window) this.frames.shift();
    }

    reset() { this.frames = []; }

    frameCount() { return this.frames.length; }

    decodeField(f, field) {
        let v = 0;
        for (const [sec, w] of this.cfg.fields[field]) if (sec >= 0 && sec < 60 && f.symbols[sec] === SYM.ONE) v += w;
        return v;
    }

    lastFrameMinute() {
        return this.frames.length ? this.decodeField(this.frames[this.frames.length - 1], 'minute') : -1;
    }

    _normalized() {
        const n = this.frames.length;
        const out = [];
        const fieldMinConf = (f, fld) => {
            let lo = -1;
            for (const [sec] of this.cfg.fields[fld]) if (sec >= 0 && sec < 60) lo = lo < 0 ? f.confidence[sec] : Math.min(lo, f.confidence[sec]);
            return Math.max(lo < 0 ? 0 : lo, 0.01);
        };
        for (let i = 0; i < n; i++) {
            const age = n - 1 - i;
            const f = this.frames[i];
            const raw = {};
            for (const fld of FIELDS) raw[fld] = this.decodeField(f, fld);
            const valid = inRange(raw) && !(raw.doy === 366 && !isLeap2(raw.year2));
            const nf = { age, valid, bits: {}, meanConfidence: 0, ext: null };
            if (!valid) {
                for (const fld of FIELDS) {
                    nf.bits[fld] = this.cfg.fields[fld].map(([sec]) => ({ symbol: SYM.UNKNOWN, confidence: sec >= 0 && sec < 60 ? f.confidence[sec] : 0 }));
                }
                out.push(nf);
                continue;
            }
            nf.ext = advanceMinutes(raw, age);
            let sum = 0;
            let count = 0;
            for (const fld of FIELDS) for (const [sec] of this.cfg.fields[fld]) if (sec >= 0 && sec < 60) { sum += f.confidence[sec]; count++; }
            nf.meanConfidence = count ? sum / count : 0;
            for (const fld of FIELDS) {
                const map = this.cfg.fields[fld];
                if (nf.ext[fld] === raw[fld]) {
                    nf.bits[fld] = map.map(([sec]) => ({
                        symbol: sec >= 0 && sec < 60 ? f.symbols[sec] : SYM.UNKNOWN,
                        confidence: sec >= 0 && sec < 60 ? f.confidence[sec] : 0,
                    }));
                } else {
                    const bits = encodeField(map, nf.ext[fld]);
                    const w = fieldMinConf(f, fld);
                    nf.bits[fld] = bits.map((symbol) => ({ symbol, confidence: w }));
                }
            }
            out.push(nf);
        }
        return out;
    }

    /** The voted time and its quality: `{ value: {minute,hour,doy,year2}, quality }`. */
    resolve() {
        const frames = this._normalized();
        if (!frames.length) return { value: null, quality: 0 };
        const aging = this.cfg.agingFactor;
        const value = {};
        const quality = {};
        for (const fld of FIELDS) {
            const map = this.cfg.fields[fld];
            const held = new Map();
            for (const nf of frames) {
                if (!nf.valid) continue;
                let fmin = -1;
                for (const b of nf.bits[fld]) fmin = fmin < 0 ? b.confidence : Math.min(fmin, b.confidence);
                held.set(nf.ext[fld], (held.get(nf.ext[fld]) || 0) + agedWeight(fmin < 0 ? 0 : fmin, aging, nf.age));
            }
            let allCoherent = true;
            let minTrust = 1;
            let compose = 0;
            for (let k = 0; k < map.length; k++) {
                let w0 = 0; let w1 = 0; let c0 = 0; let c1 = 0; let pAct = 0; let pPot = 0; let best0 = 0; let best1 = 0;
                for (const nf of frames) {
                    const b = nf.bits[fld][k];
                    const aged = aging ** nf.age;
                    const confW = Math.max(b.confidence, 0.01) * aged;
                    pPot += confW;
                    if (b.symbol === SYM.ONE || b.symbol === SYM.ZERO) {
                        if (b.symbol === SYM.ONE) { w1 += confW; c1 += aged; best1 = Math.max(best1, b.confidence); }
                        else { w0 += confW; c0 += aged; best0 = Math.max(best0, b.confidence); }
                        pAct += confW;
                    }
                }
                const participation = pPot > 0 ? pAct / pPot : 0;
                const total = w0 + w1;
                const margin = total > 0 ? (Math.max(w0, w1) - Math.min(w0, w1)) / (total + 1e-6) : 0;
                const winnerBest = w1 > w0 ? best1 : best0;
                const certified = this.cfg.minBitConfidence <= 0 || winnerBest >= this.cfg.minBitConfidence;
                const trust = certified ? margin * participation : 0;
                const coherent = c0 === c1 || (w1 > w0) === (c1 > c0);
                if (coherent) minTrust = Math.min(minTrust, trust); else allCoherent = false;
                if (w1 > w0) compose += map[k][1];
            }
            let topW = 0; let runnerW = 0; let totalHeld = 0; let topValue = 0;
            for (const [v, w] of held) {
                totalHeld += w;
                if (w > topW) { runnerW = topW; topW = w; topValue = v; } else if (w > runnerW) runnerW = w;
            }
            const valueMargin = (topW - runnerW) / (totalHeld + 1e-6);
            if (allCoherent && held.has(compose)) {
                value[fld] = compose;
                quality[fld] = minTrust;
            } else {
                value[fld] = topValue;
                quality[fld] = Math.min(valueMargin, minTrust);
            }
        }
        if (!inRange(value)) {
            let best = null;
            let bestW = -1;
            for (const nf of frames) {
                if (!nf.valid) continue;
                const w = agedWeight(nf.meanConfidence, aging, nf.age);
                if (w > bestW) { bestW = w; best = nf; }
            }
            return { value: best ? { ...best.ext } : null, quality: 0 };
        }
        return { value, quality: Math.min(...FIELDS.map((f) => quality[f])) };
    }

    /** `{ locked, reason }` — reason one of none, staleness, contested, quality, plausibility. */
    verdict() {
        const n = this.frames.length;
        const cfg = this.cfg;
        if (n < cfg.minFramesForLock) return { locked: false, reason: 'none' };
        let increments = 0;
        for (let i = 1; i < n; i++) {
            if ((this.decodeField(this.frames[i - 1], 'minute') + 1) % 60 === this.decodeField(this.frames[i], 'minute')) increments++;
        }
        const frames = this._normalized();
        const fresh = cfg.maxNewestValidAge < 0 || frames.some((nf) => nf.valid && nf.age <= cfg.maxNewestValidAge);
        if (increments < cfg.minFramesForLock - 1) {
            if (!fresh) return { locked: false, reason: 'staleness' };
            let first = null;
            for (const nf of frames) {
                if (!nf.valid) continue;
                if (!first) { first = nf; continue; }
                if (minutesSince2000(nf.ext) !== minutesSince2000(first.ext)) return { locked: false, reason: 'contested' };
            }
            return { locked: false, reason: 'none' };
        }
        if (!frames.length || !fresh) return { locked: false, reason: 'staleness' };
        for (const fld of ['hour', 'doy', 'year2']) {
            const map = cfg.fields[fld];
            let margin = 0;
            for (let k = 0; k < map.length; k++) {
                let w0 = 0; let w1 = 0;
                for (const nf of frames) {
                    const b = nf.bits[fld][k];
                    if (b.symbol === SYM.ONE || b.symbol === SYM.ZERO) {
                        const w = agedWeight(b.confidence, cfg.agingFactor, nf.age);
                        if (b.symbol === SYM.ONE) w1 += w; else w0 += w;
                    }
                }
                margin += Math.max(w0, w1) - Math.min(w0, w1);
            }
            if (!(margin > 0)) return { locked: false, reason: 'contested' };
        }
        if (cfg.minLockQuality > 0 || (cfg.plausibilityBoundMinutes > 0 && cfg.referenceNow)) {
            const res = this.resolve();
            if (cfg.minLockQuality > 0 && res.quality < cfg.minLockQuality) return { locked: false, reason: 'quality' };
            if (cfg.plausibilityBoundMinutes > 0 && cfg.referenceNow && res.value) {
                const ref = cfg.referenceNow();
                if (ref && inRange(ref)) {
                    const diff = minutesSince2000(res.value) - minutesSince2000(ref);
                    if (Math.abs(diff) > cfg.plausibilityBoundMinutes) return { locked: false, reason: 'plausibility' };
                }
            }
        }
        return { locked: true, reason: 'none' };
    }

    locked() { return this.verdict().locked; }

    lockConfidence() {
        const n = this.frames.length;
        if (n < this.cfg.minFramesForLock) return 0;
        const sat = Math.min(1, n / (2 * this.cfg.minFramesForLock));
        return Math.max(0, Math.min(1, this.resolve().quality * sat));
    }
}
