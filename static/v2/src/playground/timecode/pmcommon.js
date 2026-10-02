// What the DCF77 and ALS162 decoders share, as ubersdr-ntp's Dcf77Decoder.cpp
// and AllouisDecoder.cpp each carry their own copy of it: the carrier search
// and the carrier's running SNR, DCF77's BCD time code (ALS162 sends the same
// layout from second 20), the conversion of the minute it names from European
// legal time to UTC, and the composition of a voted time the way Source.cpp
// does it. Both stations are phase-timed LF carriers on European time, so the
// pieces are the same and kept in one place here.

import { daysFromCivil, civilFromDays, daysInMonth, fieldsFromUtc, utcFromFields } from './civil.js';

/** C's llround: half away from zero. */
export const lround = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const floorMod = (a, n) => ((a % n) + n) % n;

/** The decoder's three states, as status() names them. */
export const LOCK = { NOSIGNAL: 'nosignal', ACQUIRING: 'acquiring', LOCKED: 'locked' };

/** sampleRate must be a multiple of 200: both decoders count in 10 ms and 5 ms steps. */
export function checkRate(sampleRate, name) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate % 200 !== 0) {
        throw new Error(`${name}: sampleRate must be a positive multiple of 200 Hz (12000 expected), got ${sampleRate}`);
    }
}

/**
 * A bank of complex DFT bins, each a running sum of x·e^{-j2πfn/fs}: the
 * carrier search (bins across ±20 Hz of where the carrier should be) and the
 * live SNR (the carrier at 0 Hz and its half-integer neighbours) are both
 * this. Rotators renormalised every 1024 samples, as the C++ does.
 */
export class BinBank {
    constructor(freqs, fs) {
        this.f = Float64Array.from(freqs);
        const n = this.f.length;
        this.n = n;
        this.stepRe = new Float64Array(n);
        this.stepIm = new Float64Array(n);
        this.rotRe = new Float64Array(n);
        this.rotIm = new Float64Array(n);
        this.accRe = new Float64Array(n);
        this.accIm = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            this.stepRe[i] = Math.cos((-2 * Math.PI * this.f[i]) / fs);
            this.stepIm[i] = Math.sin((-2 * Math.PI * this.f[i]) / fs);
        }
        this.count = 0;
        this.clear();
    }

    clear() {
        this.rotRe.fill(1);
        this.rotIm.fill(0);
        this.accRe.fill(0);
        this.accIm.fill(0);
        this.count = 0;
    }

    /** One sample in; returns the number summed so far. */
    feed(xr, xi) {
        const { rotRe, rotIm, accRe, accIm, stepRe, stepIm } = this;
        for (let i = 0; i < this.n; i++) {
            const rr = rotRe[i];
            const ri = rotIm[i];
            accRe[i] += xr * rr - xi * ri;
            accIm[i] += xr * ri + xi * rr;
            rotRe[i] = rr * stepRe[i] - ri * stepIm[i];
            rotIm[i] = rr * stepIm[i] + ri * stepRe[i];
        }
        if ((this.count & 1023) === 1023) {
            for (let i = 0; i < this.n; i++) {
                const m = Math.hypot(rotRe[i], rotIm[i]);
                if (m > 1e-9) { rotRe[i] /= m; rotIm[i] /= m; }
            }
        }
        return ++this.count;
    }

    power(i) { return this.accRe[i] * this.accRe[i] + this.accIm[i] * this.accIm[i]; }
}

/** The q-quantile by index floor(q·n), as nth_element at that index gives it. */
function nth(values, k) {
    const a = Array.from(values).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, k))];
}

/**
 * The carrier search both decoders open with: 2 s of bins every 0.25 Hz across
 * ±20 Hz of the expected offset; the peak within ±3 Hz of it (a receiver clock
 * can move an atomic carrier no further) taken when it stands 12 times over the
 * median bin, refined by a parabola on the magnitudes. `feed` returns null
 * until a search completes, then `{ found, f, snrDb }`; a failed search starts
 * again from nothing.
 */
export class CarrierSearch {
    constructor(fNominal, fs, { seconds = 2.0, searchHz = 20.0, pullHz = 3.0, step = 0.25, gate = 12.0 } = {}) {
        this.fNominal = fNominal;
        this.pullHz = pullHz;
        this.step = step;
        this.gate = gate;
        const freqs = [];
        for (let f = fNominal - searchHz; f <= fNominal + searchHz + 1e-9; f += step) freqs.push(f);
        this.bank = new BinBank(freqs, fs);
        this.target = lround(seconds * fs);
    }

    clear() { this.bank.clear(); }

    feed(xr, xi) {
        if (this.bank.feed(xr, xi) < this.target) return null;
        const b = this.bank;
        const pw = new Float64Array(b.n);
        let peak = -1;
        for (let i = 0; i < b.n; i++) {
            pw[i] = b.power(i);
            if (Math.abs(b.f[i] - this.fNominal) <= this.pullHz && (peak < 0 || pw[i] > pw[peak])) peak = i;
        }
        const median = nth(pw, Math.floor(b.n / 2));
        const res = { found: false, f: this.fNominal, snrDb: null };
        if (median > 0) res.snrDb = 10 * Math.log10(pw[peak] / median);
        if (median > 0 && pw[peak] > this.gate * median) {
            let f = b.f[peak];
            if (peak > 0 && peak + 1 < b.n) {
                const a = Math.sqrt(pw[peak - 1]);
                const m = Math.sqrt(pw[peak]);
                const c = Math.sqrt(pw[peak + 1]);
                const den = a - 2 * m + c;
                if (den < 0) f += this.step * clamp((0.5 * (a - c)) / den, -0.5, 0.5);
            }
            res.found = true;
            res.f = f;
        }
        this.clear();
        return res;
    }
}

/**
 * The carrier's SNR while running: its bin at 0 Hz on the mixed signal over
 * the median of 32 neighbours at ±5.5…±20.5 Hz, every 2 s. The half-integer
 * neighbours sit on the nulls of every line a 1 Hz keying puts at whole hertz.
 * `feed` returns the new figure in dB when one is made, else null.
 */
export class LiveTone {
    constructor(fs, { seconds = 2.0, side = 16, firstHz = 5.5 } = {}) {
        const freqs = [0];
        for (let i = 0; i < side; i++) { freqs.push(firstHz + i); freqs.push(-(firstHz + i)); }
        this.side = side;
        this.bank = new BinBank(freqs, fs);
        this.target = lround(seconds * fs);
    }

    clear() { this.bank.clear(); }

    feed(zr, zi) {
        if (this.bank.feed(zr, zi) < this.target) return null;
        const b = this.bank;
        const nb = [];
        for (let i = 1; i < b.n; i++) nb.push(b.power(i));
        const median = nth(nb, this.side);
        const carrier = b.power(0);
        this.clear();
        return median > 0 && carrier > 0 ? 10 * Math.log10(carrier / median) : null;
    }
}

/** Whether Unix ms `ms` falls on the last day of its month. */
export function isLastDayOfMonth(ms) {
    const days = Math.floor(Math.floor(ms / 1000) / 86400);
    const { y, m, d } = civilFromDays(days);
    return d === daysInMonth(y, m);
}

/**
 * EU summer time at Unix seconds `s`, as Dcf77Decoder's cestAt has it: from
 * 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of
 * October.
 */
export function cestAt(unixSec) {
    const { y } = civilFromDays(Math.floor(unixSec / 86400));
    const lastSunday = (mon) => {
        const day = daysFromCivil(y, mon, 31);
        return (day - floorMod(floorMod(day + 3, 7) - 6, 7)) * 86400 + 3600;
    };
    return unixSec >= lastSunday(3) && unixSec < lastSunday(10);
}

/**
 * The common part of a DCF77 / ALS162 minute, from its bits `at(s)`: start of
 * time (20) set, exactly one of CEST (17) and CET (18), even parity over the
 * minute (21–28), the hour (29–35) and the date (36–58), every BCD digit a
 * digit, a date that exists and a weekday (1 = Monday) that fits it. Both
 * stations name the minute that BEGINS at the next minute mark, in legal time,
 * so this frame's second 0 is a minute before that and UTC is one hour (CET)
 * or two (CEST) behind it. null when anything fails.
 */
export function decodeLegalMinute(at) {
    const parity = (a, z) => { let p = 0; for (let s = a; s <= z; s++) p ^= at(s); return p; };
    if (at(20) !== 1) return null;
    if (at(17) === at(18)) return null;
    if (parity(21, 28) || parity(29, 35) || parity(36, 58)) return null;
    const minU = at(21) + 2 * at(22) + 4 * at(23) + 8 * at(24);
    const minT = at(25) + 2 * at(26) + 4 * at(27);
    const hrU = at(29) + 2 * at(30) + 4 * at(31) + 8 * at(32);
    const hrT = at(33) + 2 * at(34);
    const dayU = at(36) + 2 * at(37) + 4 * at(38) + 8 * at(39);
    const dayT = at(40) + 2 * at(41);
    const wday = at(42) + 2 * at(43) + 4 * at(44);
    const monU = at(45) + 2 * at(46) + 4 * at(47) + 8 * at(48);
    const monT = at(49);
    const yrU = at(50) + 2 * at(51) + 4 * at(52) + 8 * at(53);
    const yrT = at(54) + 2 * at(55) + 4 * at(56) + 8 * at(57);
    if (minU > 9 || hrU > 9 || dayU > 9 || monU > 9 || yrU > 9 || yrT > 9) return null;
    const d = {
        minute: minT * 10 + minU, hour: hrT * 10 + hrU, day: dayT * 10 + dayU,
        month: monT * 10 + monU, year2: yrT * 10 + yrU,
    };
    if (d.minute > 59 || d.hour > 23 || d.month < 1 || d.month > 12 || d.day < 1 || wday < 1) return null;
    const days = daysFromCivil(2000 + d.year2, d.month, d.day);
    // A day that does not exist, or a weekday that does not match the date,
    // is a misread that happened to pass parity.
    const c = civilFromDays(days);
    if (c.m !== d.month || c.d !== d.day) return null;
    if (floorMod(days + 3, 7) + 1 !== wday) return null;
    d.cest = at(17) === 1;
    const nextLocalMin = days * 1440 + d.hour * 60 + d.minute;
    const s0UtcMin = nextLocalMin - (d.cest ? 120 : 60) - 1;
    d.utcMs = s0UtcMin * 60000;
    d.utc = fieldsFromUtc(d.utcMs);
    return d;
}

/** Whether a leap second could follow the UTC minute `f` (23:59 on a month's last day). */
export function leapSecondPossibleUtc(f) {
    if (f.minute !== 59 || f.hour !== 23) return false;
    return isLastDayOfMonth(utcFromFields(f));
}

/**
 * The voted time at an edge, composed as Source.cpp's onClockTime does it:
 * the voted fields' minute (the newest frame's second 0) plus the whole
 * seconds from that frame's start to the edge, both as whole samples.
 * Refused (null) when the count crosses the midnight a leap second could be
 * inserted before.
 */
export function composeUtc(voted, edgeSample, frameStartSample, fs) {
    if (!voted || voted.year2 < 0 || voted.doy < 1 || voted.hour < 0 || voted.minute < 0) return null;
    const baseMs = utcFromFields(voted);
    const elapsedSec = lround((edgeSample - frameStartSample) / fs);
    const decodedMs = baseMs + elapsedSec * 1000;
    if (isLastDayOfMonth(baseMs)) {
        const boundary = (Math.floor(Math.floor(baseMs / 1000) / 86400) + 1) * 86400000;
        if (decodedMs >= boundary) return null;
    }
    return decodedMs;
}

/** The voter's reference: Source.cpp arms it from the host clock, ±1440 minutes. */
export function armPlausibility(voter, referenceNow) {
    if (typeof referenceNow === 'function') voter.setPlausibility(() => fieldsFromUtc(referenceNow()), 24 * 60);
}
