// A compressor and a look-ahead limiter, on one audio signal, in place.
//
// The receiver's own compressor (radio/audio-filters.js) is the browser's
// DynamicsCompressorNode, which only exists inside an AudioContext. A
// playground graph runs in a worker, with no audio graph at all, so this is
// the same thing in arithmetic.
//
// ── The compressor ──────────────────────────────────────────────────────────
//
// Feed-forward, in decibels: each sample's level against a soft-kneed static
// curve (Giannoulis, Massberg & Reiss, "Digital Dynamic Range Compressor
// Design", JAES 2012), the gain that curve asks for smoothed with separate
// attack and release, then the makeup gain on top. Below the knee nothing
// changes; above it, every `ratio` dB in gives one out.
//
// ── The limiter ─────────────────────────────────────────────────────────────
//
// After the compressor and its makeup, so it catches what the makeup pushed
// over. Its promise is that nothing leaves above the ceiling, and it keeps it
// by looking ahead rather than by clipping: the output is delayed L − 1
// samples, so the gain can come down before a peak reaches it.
//
// For each sample the gain that would put it exactly at the ceiling is its
// target (1 for anything already under). Then:
//
//   m[n]  the least target over the next L samples      (a sliding minimum)
//   r[n]  m, falling at once and rising with the release (never above m)
//   s[n]  the mean of r over the last L samples          (a smooth ramp)
//
// The sample that goes out with s is the one L − 1 back, n − L + 1, and
// every r[j] that s averages comes from a window that holds it — the oldest
// window ends on it, the newest starts on it — so each is at most its own
// target, and so is their mean: the gain on a sample never puts it over the
// ceiling. The mean makes the gain ramp down over the look-ahead instead of
// stepping, which is what keeps a limiter from clicking. A final clamp only
// tidies rounding; `clamped` counts the times it had anything to do, which
// the tests hold at zero.

/** The defaults, the receiver's compressor's where it has one. */
export const COMPRESSOR_DEFAULTS = {
    thresholdDb: -28,
    ratio: 3,
    kneeDb: 12,
    attackMs: 10,
    releaseMs: 250,
    makeupDb: 0,
    limit: true,
    ceilingDb: -1,
};

// The limiter's look-ahead, and how fast its gain recovers.
export const LIMIT_LOOKAHEAD_MS = 1.5;
const LIMIT_RELEASE_MS = 60;

// A floor for the level, so silence has a level: -200 dBFS.
const FLOOR = 1e-10;

/**
 * The static curve: how many dB of gain a level of `x` dB asks for — zero
 * below the knee, negative above it.
 */
export function compressorCurve(x, thresholdDb, ratio, kneeDb) {
    const over = x - thresholdDb;
    const slope = 1 / Math.max(1, ratio) - 1;
    if (kneeDb > 0 && 2 * Math.abs(over) <= kneeDb) {
        const k = over + kneeDb / 2;
        return (slope * k * k) / (2 * kneeDb);
    }
    return over > 0 ? slope * over : 0;
}

export class Compressor {
    constructor(params = {}) {
        this.rate = 0;
        this.p = { ...COMPRESSOR_DEFAULTS };
        this.gainDb = 0;            // the compressor's smoothed gain, ≤ 0
        this.reductionDb = 0;       // the most it took over the last block
        this.limitDb = 0;           // the most the limiter took over the last block
        this.clamped = 0;           // samples the final clamp had to touch
        this.configure(params, 12000);
    }

    /** Settings and rate; the look-ahead line is rebuilt only if its length moves. */
    configure(params, rate) {
        this.p = { ...this.p, ...params };
        const r = rate > 0 ? rate : 12000;
        const coef = (ms) => Math.exp(-1 / (r * Math.max(0.01, ms) / 1000));
        this.atk = coef(this.p.attackMs);
        this.rel = coef(this.p.releaseMs);
        this.limRel = 1 - coef(LIMIT_RELEASE_MS);
        this.makeup = Math.pow(10, (Number(this.p.makeupDb) || 0) / 20);
        this.ceiling = Math.pow(10, Math.min(0, Number(this.p.ceilingDb) || 0) / 20);
        const L = Math.max(1, Math.round((LIMIT_LOOKAHEAD_MS / 1000) * r));
        if (L !== this.L || r !== this.rate) {
            this.L = L;
            this._resetLimiter();
        }
        this.rate = r;
    }

    _resetLimiter() {
        const L = this.L;
        this.delay = new Float64Array(L);       // the last L samples of the signal
        this.targets = new Float64Array(L);     // the last L samples' targets
        this.box = new Float64Array(L).fill(1); // the last L values of r
        this.boxSum = L;
        this.r = 1;
        this.pos = 0;
        this.delay.fill(0);
        this.targets.fill(1);
    }

    reset() {
        this.gainDb = 0;
        this.reductionDb = 0;
        this.limitDb = 0;
        this._resetLimiter();
    }

    /** How late the output is, in samples: the look-ahead, while limiting. */
    latency() {
        return this.p.limit ? this.L - 1 : 0;
    }

    /** Compress, and limit if asked, `frames` of `buf` in place. */
    process(buf, frames) {
        const { thresholdDb, ratio, kneeDb, limit } = this.p;
        const { atk, rel, makeup } = this;
        let g = this.gainDb;
        let most = 0;
        let limMost = 1;
        for (let k = 0; k < frames; k++) {
            const x = buf[k];
            const a = x < 0 ? -x : x;
            const want = compressorCurve(20 * Math.log10(a > FLOOR ? a : FLOOR), thresholdDb, ratio, kneeDb);
            // Toward a deeper cut at the attack rate, back at the release.
            g = want < g ? atk * g + (1 - atk) * want : rel * g + (1 - rel) * want;
            if (g < most) most = g;
            let y = x * Math.pow(10, g / 20) * makeup;
            if (limit) {
                y = this._limit(y);
                if (this._last < limMost) limMost = this._last;
            }
            buf[k] = y;
        }
        this.gainDb = g;
        this.reductionDb = most;
        this.limitDb = limit && limMost < 1 ? 20 * Math.log10(limMost) : 0;
    }

    /** One sample into the limiter; the sample L − 1 back out, at or under the ceiling. */
    _limit(x) {
        const L = this.L;
        const c = this.ceiling;
        const a = x < 0 ? -x : x;
        const i = this.pos;
        // This sample's target, into the window; the window's least is m.
        this.targets[i] = a > c ? c / a : 1;
        let m = 1;
        for (let j = 0; j < L; j++) if (this.targets[j] < m) m = this.targets[j];
        // Down at once, up at the release; never above m.
        this.r = m < this.r ? m : this.r + (m - this.r) * this.limRel;
        if (this.r > m) this.r = m;
        // The mean of the last L of r: the ramp.
        this.boxSum += this.r - this.box[i];
        this.box[i] = this.r;
        const gain = this.boxSum / L;
        // Out goes the sample from L − 1 back — the one every window in the
        // mean contains. The ring holds the last L, this one included; the
        // oldest is next along.
        this.delay[i] = x;
        const out = this.delay[(i + 1) % L] * gain;
        this.pos = (i + 1) % L;
        this._last = gain;
        if (out > c * (1 + 1e-12) || out < -c * (1 + 1e-12)) this.clamped++;
        return out > c ? c : out < -c ? -c : out;
    }
}
