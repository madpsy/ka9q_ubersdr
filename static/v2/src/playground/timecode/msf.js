// MSF's time code (NPL, Anthorn, 60 kHz): ubersdr-ntp's MsfDecoder
// (src/clock/MsfDecoder.cpp), ported line for line.
//
// Format facts per NPL's "MSF 60 kHz time and date code" (and ITU-R TF.2487):
// on-off keying, carrier off = 1. Every second starts with the carrier off for
// at least 100 ms, then bit A in 100–200 ms and bit B in 200–300 ms, then
// carrier to the end of the second; second 00 is instead 500 ms off, the
// minute marker. The falling edge is on time to better than a millisecond.
// Bit A, BCD MSB-first: year 17–24, month 25–29, day 30–35, weekday 36–38
// (0 = Sunday), hour 39–44, minute 45–51, and 52–59 always 01111110 — the
// minute identifier, found nowhere else in A. Bit B: DUT1 in 01–16, summer
// time imminent 53, odd parity 54–57 over A 17–24, 25–35, 36–38, 39–51, summer
// time in effect 58. The code is UK civil time (UTC+1 with B58) of the minute
// that BEGINS at the next marker. A leap minute runs 61 (or 59) s and moves
// everything from 17A and 52B on, so the code stays aligned with the minute's
// END; MSF sends no warning. So a minute is read backwards from its end, found
// by the next marker or the identifier, and decoded only once it has ended.
//
// Chain, per input sample of complex baseband: (once) complex DFT bins across
// ±20 Hz of the expected offset, the peak within ±3 Hz refined by a parabola,
// is where the mixer goes; z = x·e^{−jω₀n} is kept at full rate in a ring;
// z → 150 Hz biquad on I/Q → |·| → 10 ms boxcar → 100 Hz envelope, on which
// second edges are found as the carrier going off after ≥ 450 ms of carrier.
// Each edge is then timed at full rate on the coherent amplitude (stepAt to
// find it, steepestAt to time it), smoothed by a noise-adaptive alpha-beta
// tracker, and each second's five tenths 0–500 ms are read coherently against
// the 440 ms of carrier before its edge. Decoded minutes go to the shared
// voter as synthetic frames in WWVB's layout, in UTC.
//
// Edges are reported net of the decoder's bias against NPL's second, which
// Source.cpp takes off as kMsfDecoderEdgeBiasSec: the steepest point of the
// fall comes 0.19 ms after NPL's on-time instant on the air (MSF_EDGE_BIAS_SEC).

import { Biquad, Rotator } from './dsp.js';
import { civilFromDays, daysFromCivil, fieldsFromUtc } from './civil.js';
import { TimeFrameVoter, WWVB_MAP, syntheticFrame } from './voter.js';
import {
    DftBins, ENV_CAP, Envelope, composeUtc, envelopeDecimation, symbolName, upperMedian, voterReference,
} from './lfcommon.js';

/**
 * Where the decoder puts MSF's second against where NPL does: 0.19 ms late.
 * It times the steepest point of the carrier's fall; on the air that comes a
 * fraction of a millisecond after the carrier starts going off (Anthorn's
 * antenna). Measured on M9PSY-1 against a GPS-disciplined stratum 1, as
 * Source.cpp's kMsfDecoderEdgeBiasSec; taken off every edge reported here.
 */
export const MSF_EDGE_BIAS_SEC = 0.000190;

// ── envelope ────────────────────────────────────────────────────────────────
const EDGE_TOL = 12;          // ± envelope samples searched for an edge
const EDGE_LOOK = 12;         // lookahead an edge candidate needs
const WARM_ENV = 200;
// Envelope samples of carrier an edge must follow: NPL's "at least 500 ms",
// less a margin (_isFallingEdge).
const CARRIER_BEFORE = 45;
// The full-rate edge: the derivative-of-Gaussian's sigma, how far either side
// of the step correlator's edge the steepest point is looked for, and the
// step correlator's half-width.
const SLOPE_SIGMA_SEC = 0.0005;
const SLOPE_FINE_SEARCH_SEC = 0.002;
const STEP_SEC = 0.040;
// Wide: on a weak signal the envelope's edge is often 10 ms out, and nothing
// else falls within 20 ms of a second's edge (A's and B's are 100 ms away,
// and a rise scores negative).
const SLOPE_SEARCH_SEC = 0.020;
// Once settled, the fine kernel alone this far either side of the prediction;
// a measurement further out than TRK_OUTLIER_SEC is an outlier.
const SLOPE_TRACK_SEC = 0.0015;
const TRK_OUTLIER_SEC = 0.002;
// A settled tracker the wide search puts, by the median of its last
// RESEED_WINDOW offsets, more than RESEED_SEC from the edge is re-seeded —
// counting only wide searches standing RESEED_SIG above the noise.
const RESEED_SEC = 0.001;
const RESEED_WINDOW = 15;
const RESEED_SIG = 4.0;
// Envelope samples of a second read before it is processed: 0–500 ms.
const CLASSIFY_ENV = 50;
// p90 over p05. The carrier goes fully off, so on a clean signal this is
// large; under 2 there is no keying to be found.
const MIN_CONTRAST = 2.0;
const LPF_CUT_HZ = 150;

// ── carrier search ──────────────────────────────────────────────────────────
// MSF's carrier is held to 2e-12, so only the receiver's own clock moves it
// in the baseband: 20 ppm is 1.2 Hz.
const ACQ_SECONDS = 2.0;
const SEARCH_HZ = 20.0;
const PULL_HZ = 3.0;
const SEARCH_STEP = 0.25;
const TONE_GATE = 12.0;        // peak over median bin power
const LIVE_TONE_SECONDS = 2.0;
const LIVE_TONE_SIDE = 16;
const LIVE_TONE_FIRST_HZ = 5.5;

// ── symbols and sync ────────────────────────────────────────────────────────
// Confidence is a z-score mapped (z − 1)/5: 0.5 is 3.5 sigma.
const STRUCT_CONF = 0.50;      // enough to call a structural fault
const SYNC_CONF = 0.60;        // a minute marker to anchor on
// The identifier's eight A bits are judged together: each must be read, and
// their mean at ID_MEAN_CONF.
const ID_BIT_MIN_CONF = 0.10;
const ID_MEAN_CONF = 0.40;
// Below this a bit is not read at all: the minute fails as incomplete rather
// than passing or failing the parity checks by chance.
const BIT_MIN_CONF = 0.05;

// The edge tracker.
const TRK_ALPHA = 1 / 8;
const TRK_WARM = 8;
const TRK_ALPHA_MIN = 1 / 32;
const TRK_NOISE_REF_SEC = 0.0001;
// The fraction of each second's measured carrier phase error taken into the
// residual frequency (_trackCarrier).
const FREQ_GAIN = 0.5;

const MAX_BLIND_SECONDS = 90;
const MAX_UNCONFIRMED_MINUTES = 2;

// The longest minute there is, 61 s, plus one second to see its end.
const FRAME_CAP = 62;

// A 52..59: the minute identifier.
const IDENTIFIER = [0, 1, 1, 1, 1, 1, 1, 0];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// IEEE remainder (std::remainder): x − n·y with n the nearest integer to x/y.
const remainder = (x, y) => x - y * Math.round(x / y);
const confOf = (z) => clamp((z - 1) / 5, 0, 1);

/**
 * An alpha-beta tracker on second edges whose gain follows its own
 * measurement noise. On a strong signal an edge is good to ~12 µs and 1/8
 * follows the air closely; at 30 dB-Hz one is good to half a millisecond and
 * 1/8 passes too much of it on. So alpha falls from 1/8 as the residuals' rms
 * rises past TRK_NOISE_REF_SEC, to 1/32, and beta is alpha²/2.
 */
class EdgeTracker {
    constructor() { this.noiseRef = 1; this.reset(); }

    reset() {
        this.valid = false;
        this.edge = 0;
        this.period = 0;
        this.count = 0;
        this.outliers = 0;
        this.resVar = 0;
    }

    alpha() {
        const rms = Math.sqrt(this.resVar);
        if (!(rms > this.noiseRef)) return TRK_ALPHA;
        return Math.max(TRK_ALPHA_MIN, (TRK_ALPHA * this.noiseRef) / rms);
    }

    update(measured, raw, nominal, tol) {
        if (!this.valid) {
            if (!measured) return;
            this.edge = raw; this.period = nominal; this.valid = true; this.count = 1; this.outliers = 0;
            return;
        }
        const pred = this.edge + this.period;
        if (!measured) { this.edge = pred; return; }
        const r = raw - pred;
        if (Math.abs(r) > tol) {
            if (++this.outliers >= 3) {
                this.edge = raw; this.period = nominal; this.count = 1; this.outliers = 0; this.resVar = 0;
            } else {
                this.edge = pred;
            }
            return;
        }
        this.outliers = 0;
        this.count++;
        this.resVar += (this.count <= 16 ? 1 / this.count : 1 / 16) * (r * r - this.resVar);
        const a = this.alpha();
        this.edge = pred + Math.max(1 / this.count, a) * r;
        if (this.count > TRK_WARM) {
            this.period = clamp(this.period + 0.5 * a * a * r, nominal * (1 - 2e-4), nominal * (1 + 2e-4));
        }
    }
}

/** One classified second. */
const secRec = (edge = 0) => ({
    edge,                 // the tracker's edge, fractional input sample (before the bias)
    read: false,          // classified at all
    marker: false,        // 500 ms off: second 00
    markConf: 0,          // confidence of marker-or-not
    a: 0, b: 0,           // bits A and B (1 = carrier off)
    aConf: 0, bConf: 0,
    cut: true,            // the carrier went off at the start at all
});

const confMarker = (r, c) => r.read && r.marker && r.markConf >= c;

export class MsfDecoder {
    constructor({ sampleRate = 12000, carrierOffsetHz = 0, referenceNow = null } = {}) {
        this.fs = sampleRate;
        this.decim = envelopeDecimation(sampleRate, 'MsfDecoder');
        this.fNominal = carrierOffsetHz;
        const freqs = [];
        for (let f = carrierOffsetHz - SEARCH_HZ; f <= carrierOffsetHz + SEARCH_HZ + 1e-9; f += SEARCH_STEP) freqs.push(f);
        this.bins = new DftBins(freqs, sampleRate);
        const live = [0];
        for (let i = 0; i < LIVE_TONE_SIDE; i++) live.push(LIVE_TONE_FIRST_HZ + i, -(LIVE_TONE_FIRST_HZ + i));
        this.liveBins = new DftBins(live, sampleRate);
        this.acqTarget = Math.round(ACQ_SECONDS * sampleRate);
        this.liveTarget = Math.round(LIVE_TONE_SECONDS * sampleRate);
        // The mixed baseband at full rate, a ring by sample index, ≥ 3 s.
        let cap = 1;
        while (cap < 3 * sampleRate) cap <<= 1;
        this.zRe = new Float32Array(cap);
        this.zIm = new Float32Array(cap);
        this.zMask = cap - 1;
        this.env = new Envelope(0.05, 0.90);   // p05 lands in the carrier-off: 10–50 % of every second is off
        this.trk = new EdgeTracker();
        this.voter = new TimeFrameVoter({ fields: WWVB_MAP, minBitConfidence: 0.05, minLockQuality: 0.05 });
        this.voter.setPlausibility(voterReference(referenceNow), voterReference(referenceNow) ? 24 * 60 : 0);
        this.reset();
    }

    reset() {
        this.n = 0;
        this.events = [];
        this.lockState = 'nosignal';
        this.running = false;
        this.acqCount = 0;
        this.toneSnrDb = 0;
        this.bins.reset();
        this.liveBins.reset();
        this.f0 = this.fNominal;
        this.osc = null;
        this.lpI = null;
        this.lpQ = null;
        this.lpfDelay = 0;
        this.zStart = 0;               // first sample index written since the carrier was found
        this.magAccum = 0;
        this.magCount = 0;
        this.envBase = 0;
        this.env.reset();
        this.lowFrac = 0.05;           // "off" as a fraction of full carrier, learnt
        this.fResidual = 0;            // the carrier's residual frequency (_trackCarrier)
        this.havePrevTheta = false;
        this.prevTheta = 0;
        this.prevThetaAt = 0;
        this.segValid = false;
        this.segEdge = 0;
        this.scanPos = 0;
        this.blindSeconds = 0;
        this.trk.reset();
        this.wideOff = [];             // the wide search's last offsets from the tracker
        this.hist = [];
        this._dropAnchor();
        this.haveLastFrame = false;
        this.lastFrameStart = 0;
        this.lastFrameLen = 60;
        this.lastFrameFrom = 0;
        this.lastFrameEdge = null;     // the last emitted frame's s0 edge, for composing time
        this.voted = null;
        this.votedQuality = 0;
        this.voter.reset();
        this.lastEdgeSnr = null;
    }

    process(re, im, n = re.length) {
        for (let i = 0; i < n; i++) {
            this.n++;
            if (!this.running) this._feedAcquisition(re[i], im[i]);
            else this._feedSteady(re[i], im[i]);
        }
    }

    drain() {
        const e = this.events;
        this.events = [];
        return e;
    }

    status() {
        const verdict = this.voter.verdict();
        const env = this.env;
        return {
            state: this.lockState,
            station: 'MSF',
            snrDb: this.toneSnrDb,
            carrierOffsetHz: this.running ? this.f0 : null,
            refusal: this.lockState === 'locked' ? null : verdict.reason,
            frames: this.voter.frameCount(),
            detail: {
                toneSnrDb: this.toneSnrDb,
                toneDetected: this.running,
                pwmContrast: env.pLo > 1e-12 ? env.pHi / env.pLo : 0,
                phaseLocked: this.segValid,
                anchored: this.anchored,
                framesInWindow: this.voter.frameCount(),
                windowSize: this.voter.cfg.window,
                voteQuality: this.voter.lockConfidence(),
                refusalReason: verdict.reason,
                lastFrameFrom: this.lastFrameFrom,
                residualHz: this.fResidual,
                carrierHz: this.running ? this.f0 + this.fResidual : null,
                lowFrac: this.lowFrac,
                blindSeconds: this.blindSeconds,
                edgeSig: this.lastEdgeSnr,
                trackerSeconds: this.trk.count,
                trackerNoiseUs: this.trk.valid ? (Math.sqrt(this.trk.resVar) / this.fs) * 1e6 : null,
                trackerPeriodPpm: this.trk.valid ? (this.trk.period / this.fs - 1) * 1e6 : null,
            },
        };
    }

    // ── carrier search ────────────────────────────────────────────────────────

    _feedAcquisition(xr, xi) {
        this.bins.push(xr, xi);
        if (++this.acqCount >= this.acqTarget) this._finalizeAcquisition();
    }

    _finalizeAcquisition() {
        const pw = this.bins.powers();
        const f = this.bins.f;
        let peak = -1;
        for (let i = 0; i < pw.length; i++) {
            if (Math.abs(f[i] - this.fNominal) <= PULL_HZ && (peak < 0 || pw[i] > pw[peak])) peak = i;
        }
        const median = upperMedian(pw);
        if (median > 0) this.toneSnrDb = 10 * Math.log10(pw[peak] / median);
        if (median > 0 && pw[peak] > TONE_GATE * median) {
            let fp = f[peak];
            if (peak > 0 && peak + 1 < pw.length) {
                const a = Math.sqrt(pw[peak - 1]);
                const b = Math.sqrt(pw[peak]);
                const c = Math.sqrt(pw[peak + 1]);
                const den = a - 2 * b + c;
                if (den < 0) fp += SEARCH_STEP * clamp((0.5 * (a - c)) / den, -0.5, 0.5);
            }
            this.f0 = clamp(fp, this.fNominal - PULL_HZ, this.fNominal + PULL_HZ);
            this._startSteady();
        } else {
            this.bins.reset();
            this.acqCount = 0;
        }
    }

    _startSteady() {
        this.running = true;
        this.envBase = this.n;
        this.osc = new Rotator(this.f0, this.fs);
        this.lpI = Biquad.lowpass(LPF_CUT_HZ, this.fs);
        this.lpQ = Biquad.lowpass(LPF_CUT_HZ, this.fs);
        this.lpfDelay = this.lpI.dcDelay();
        this.zStart = this.n;
        this.trk.noiseRef = TRK_NOISE_REF_SEC * this.fs;
        this.lockState = 'acquiring';
    }

    // The carrier over the median of 32 bins either side (5.5–20.5 Hz off it),
    // every 2 s: the live carrier-to-noise figure once the search has passed.
    _liveToneStep(zr, zi) {
        const lb = this.liveBins;
        lb.push(zr, zi);
        if (lb.count < this.liveTarget) return;
        const nb = [];
        for (let i = 1; i < lb.length; i++) nb.push(lb.power(i));
        const median = upperMedian(nb);
        const carrier = lb.power(0);
        if (median > 0 && carrier > 0) this.toneSnrDb = 10 * Math.log10(carrier / median);
        lb.reset();
    }

    // ── per sample ────────────────────────────────────────────────────────────

    _feedSteady(xr, xi) {
        const [c, s] = this.osc.step();
        const zr = xr * c - xi * s;
        const zi = xr * s + xi * c;
        this._liveToneStep(zr, zi);
        const at = (this.n - 1) & this.zMask;
        this.zRe[at] = zr;
        this.zIm[at] = zi;
        const I = this.lpI.process(zr);
        const Q = this.lpQ.process(zi);
        this.magAccum += Math.sqrt(I * I + Q * Q);
        if (++this.magCount >= this.decim) {
            this.env.push(this.magAccum / this.magCount);
            this.magAccum = 0;
            this.magCount = 0;
            if (!this.segValid) this._trySeed();
            while (this.segValid && this._canProcessSecond()) this._processSecond();
        }
    }

    // ── envelope helpers ──────────────────────────────────────────────────────

    _envPos(sample) { return (sample - this.envBase + this.lpfDelay) / this.decim; }

    _haveContrast() { return this.env.pHi >= MIN_CONTRAST * Math.max(this.env.pLo, 1e-9); }

    // A second's edge, as NPL defines it: the carrier going off after at least
    // 500 ms of carrier — what tells it from MSF's other falling edge, at
    // 200 ms when A is 0 and B is 1, after only 100 ms of carrier. Taken as
    // 450 ms, 80 % of it above the midpoint, so noise does not refuse a real
    // one. Seeded on the 200 ms edge without this, the tracker coasted 200 ms
    // off for good.
    _isFallingEdge(i, t) {
        const env = this.env;
        if (!env.fallingCross(i, t)) return false;
        if (i - CARRIER_BEFORE < env.count - ENV_CAP) return false;
        let on = 0;
        for (let d = 5; d < CARRIER_BEFORE; d++) on += env.at(i - d) >= t.mid ? 1 : 0;
        return on >= Math.trunc(((CARRIER_BEFORE - 5) * 8) / 10);
    }

    _edgeSampleAt(i) {
        return this.envBase + this.env.areaPosition(i, 8, 1e-12) * this.decim - this.lpfDelay;
    }

    _trySeed() {
        const env = this.env;
        if (env.count < WARM_ENV || !this._haveContrast()) return;
        const t = env.thresholds();
        const lo = Math.max(this.scanPos, 9, env.count - ENV_CAP + 9);
        for (let i = lo; i + EDGE_LOOK < env.count; i++) {
            this.scanPos = i;
            if (this._isFallingEdge(i, t)) {
                this.segValid = true;
                this.segEdge = this._edgeSampleAt(i);
                this.hist = [];
                return;
            }
        }
    }

    // The nearest falling edge within ±tol of envelope index `pred`, timed at
    // full rate; NaN when there is none.
    _findFallingEdgeNear(pred, tol) {
        if (!this._haveContrast()) return NaN;
        const env = this.env;
        const t = env.thresholds();
        const lo = Math.max(pred - tol, env.count - ENV_CAP + 9);
        const hi = Math.min(pred + tol, env.count - 1 - EDGE_LOOK);
        let bestEdge = pred;
        let bestDist = tol + 1;
        for (let i = lo; i <= hi; i++) {
            if (i < 9) continue;
            if (this._isFallingEdge(i, t)) {
                const d = Math.abs(i - pred);
                if (d < bestDist) { bestDist = d; bestEdge = i; }
            }
        }
        if (bestDist > tol) return NaN;
        return this._refineEdge(this._edgeSampleAt(bestEdge));
    }

    // ── the edge at full rate ─────────────────────────────────────────────────
    //
    // The envelope finds the edge to a millisecond or so; this times it to the
    // noise, on the carrier's own amplitude, coherently: z projected on the
    // carrier's phase from the 35 ms of carrier before. Linear in the signal
    // (no magnitude to fold the noise into a bias) and unfiltered (no delay).
    //
    // The edge is where that amplitude falls fastest: the peak of its
    // correlation with a derivative-of-Gaussian, refined by a parabola. Not the
    // area under the transition, as the envelope's: MSF's fall on the air is a
    // sharp drop to ~15 % over half a millisecond and then a tail ringing down
    // for ~8 ms, and an area puts the edge at the centroid of both. The
    // steepest point is the drop's middle, and the tail barely moves it.
    // Kernel sigma 0.5 ms, from second-to-second scatter on a 69 dB-Hz
    // recording (0.15 ms 131 µs, 0.25 40, 0.40 11, 0.60 12, 1.00 13 and late).

    _ringOldest() { return Math.max(this.zStart, this.n - this.zRe.length + 1); }

    // The carrier's phase as a unit phasor from the sum of z over [from, to].
    _phasor(from, to) {
        let sr0 = 0;
        let si0 = 0;
        for (let n = from; n <= to; n++) { const k = n & this.zMask; sr0 += this.zRe[k]; si0 += this.zIm[k]; }
        const m = Math.hypot(sr0, si0);
        return m > 0 ? { cr: sr0 / m, ci: si0 / m } : null;
    }

    /**
     * The steepest fall within `searchSec` of `center` for a derivative-of-
     * Gaussian of sigma `sgSec`, on the amplitude projected on the carrier's
     * phase just before. NaN when there is no peak inside. `out.sig`, when
     * asked for, is the peak over the rms of the same correlation run on the
     * quadrature component, which holds the noise and nothing else.
     */
    _steepestAt(center, sgSec, searchSec, out = null) {
        const newest = this.n - 1;
        const oldest = this._ringOldest();
        const sg = sgSec * this.fs;
        const half = Math.ceil(4 * sg);
        const search = Math.max(2, Math.round(searchSec * this.fs));
        const c = Math.round(center);
        const pre0 = c - search - Math.round(0.035 * this.fs);
        const pre1 = c - search - half;
        if (pre0 < oldest || c + search + half > newest) return NaN;
        const ph = this._phasor(pre0, pre1);
        if (!ph) return NaN;
        const { cr, ci } = ph;
        const { zRe, zIm, zMask } = this;
        // −d/dt of a Gaussian: positive before the centre, so a fall scores high.
        const g = new Float64Array(2 * half + 1);
        for (let k = -half; k <= half; k++) g[k + half] = -k * Math.exp((-0.5 * k * k) / (sg * sg));
        const y = new Float64Array(2 * search + 1);
        let bi = 0;
        let q2 = 0;
        for (let j = -search; j <= search; j++) {
            let v = 0;
            let q = 0;
            for (let k = -half; k <= half; k++) {
                const idx = (c + j + k) & zMask;
                const gk = g[k + half];
                v += (zRe[idx] * cr + zIm[idx] * ci) * gk;
                if (out) q += (zIm[idx] * cr - zRe[idx] * ci) * gk;
            }
            y[j + search] = v;
            q2 += q * q;
            if (v > y[bi]) bi = j + search;
        }
        if (out) out.sig = q2 > 0 ? y[bi] / Math.sqrt(q2 / y.length) : 0;
        if (!(y[bi] > 0) || bi <= 0 || bi >= 2 * search) return NaN;
        const den = y[bi - 1] - 2 * y[bi] + y[bi + 1];
        const frac = den < 0 ? clamp((0.5 * (y[bi - 1] - y[bi + 1])) / den, -0.5, 0.5) : 0;
        return c + bi - search + frac;
    }

    /**
     * The edge found before it is timed: a step correlator — the mean of
     * STEP_SEC of amplitude before a candidate less the mean after — over
     * `searchSec` either side of `center`. It uses the whole contrast MSF
     * guarantees about an edge, so it detects where a slope kernel cannot (at
     * 27 dB-Hz one second's slope peak is ~1.5 sigma, this ~4.5). NaN when no
     * peak is inside; `out.sig` as _steepestAt's.
     */
    _stepAt(center, searchSec, out = null) {
        const newest = this.n - 1;
        const oldest = this._ringOldest();
        const W = Math.max(4, Math.round(STEP_SEC * this.fs));
        const search = Math.max(2, Math.round(searchSec * this.fs));
        const c = Math.round(center);
        const lo = c - search - W;            // first sample the sums read
        const hi = c + search + W;            // one past the last
        const pre0 = lo - Math.round(0.035 * this.fs);
        if (pre0 < oldest || hi > newest) return NaN;
        const ph = this._phasor(pre0, lo - 1);
        if (!ph) return NaN;
        const { cr, ci } = ph;
        const { zRe, zIm, zMask } = this;
        const P = new Float64Array(hi - lo + 1);
        const Q = new Float64Array(hi - lo + 1);
        for (let n = lo; n < hi; n++) {
            const k = n & zMask;
            const i = n - lo;
            P[i + 1] = P[i] + zRe[k] * cr + zIm[k] * ci;
            Q[i + 1] = Q[i] + zIm[k] * cr - zRe[k] * ci;
        }
        // y(j): the step between samples j−1 and j, at instant j − ½.
        const stepOf = (S, j) => { const i = j - lo; return (S[i] - S[i - W]) - (S[i + W] - S[i]); };
        const y = new Float64Array(2 * search + 1);
        let bi = 0;
        let q2 = 0;
        for (let j = -search; j <= search; j++) {
            const v = stepOf(P, c + j);
            const q = stepOf(Q, c + j);
            y[j + search] = v;
            q2 += q * q;
            if (v > y[bi]) bi = j + search;
        }
        if (out) out.sig = q2 > 0 ? y[bi] / Math.sqrt(q2 / y.length) : 0;
        if (!(y[bi] > 0) || bi <= 0 || bi >= 2 * search) return NaN;
        const den = y[bi - 1] - 2 * y[bi] + y[bi + 1];
        const frac = den < 0 ? clamp((0.5 * (y[bi - 1] - y[bi + 1])) / den, -0.5, 0.5) : 0;
        return c + bi - search - 0.5 + frac;
    }

    // From the envelope's edge: found with the step correlator, then timed
    // with the slope kernel. NaN when the full-rate signal has no clear fall
    // there: the tracker then coasts rather than take the envelope's edge,
    // which is a millisecond cruder and, through its filter, not unbiased.
    _refineEdge(coarse, out = null) {
        const wide = this._stepAt(coarse, SLOPE_SEARCH_SEC, out);
        if (!Number.isFinite(wide)) return wide;
        const fine = this._steepestAt(wide, SLOPE_SIGMA_SEC, SLOPE_FINE_SEARCH_SEC);
        return Number.isFinite(fine) ? fine : wide;
    }

    // ── once per second ───────────────────────────────────────────────────────

    // A second is processed once its first half is in: everything it carries
    // is in 0–500 ms, read against the 450 ms before it — about 0.74 s after
    // its edge.
    _canProcessSecond() {
        const j0 = Math.floor(this._envPos(this.segEdge));
        return this.env.count >= j0 + CLASSIFY_ENV + EDGE_TOL + EDGE_LOOK;
    }

    // The five tenths 0–500 ms of the second starting at `edge`, each as how
    // far the carrier is off (0 full, 1 as off as it goes) against its level in
    // the 440 ms before the edge — carrier in every second, by NPL's definition
    // of the edge. Read coherently, projected on the carrier's phase there and
    // carried forward at the residual frequency: the envelope's magnitude sits
    // at the noise's own level when the carrier is off, which shrinks the very
    // contrast a bit is read from (on it nothing locked at 27 dB-Hz).
    // Confidences are z-scores against the quadrature component's noise over
    // the same 440 ms, mapped (z − 1)/5; the depth of "off" is learnt from
    // every second's first tenth, which is always off.
    _classify(edge, r) {
        r.read = false;
        const fs = this.fs;
        const c = Math.round(edge);
        const pre0 = c - Math.round(0.450 * fs);
        const pre1 = c - Math.round(0.010 * fs);
        const end = c + Math.round(0.500 * fs);
        if (pre0 < this._ringOldest() || end > this.n - 1) return;
        const { zRe, zIm, zMask } = this;
        let sr0 = 0;
        let si0 = 0;
        for (let n = pre0; n <= pre1; n++) { const k = n & zMask; sr0 += zRe[k]; si0 += zIm[k]; }
        if (!(Math.hypot(sr0, si0) > 0)) return;
        const theta = Math.atan2(si0, sr0);
        const mid = 0.5 * (pre0 + pre1);
        this._trackCarrier(mid, theta);
        const w0 = (2 * Math.PI * this.fResidual) / fs;
        let pr = 0;
        let pi = 0;
        const proj = (n) => {
            const ph = theta + w0 * (n - mid);
            const cr = Math.cos(ph);
            const ci = Math.sin(ph);
            const k = n & zMask;
            pr = zRe[k] * cr + zIm[k] * ci;
            pi = zIm[k] * cr - zRe[k] * ci;
        };
        let H = 0;
        let q2 = 0;
        for (let n = pre0; n <= pre1; n++) { proj(n); H += pr; q2 += pi * pi; }
        const np = pre1 - pre0 + 1;
        H /= np;
        const sigma = Math.sqrt(q2 / np);     // per sample, per component
        if (!(H > 0) || !this._haveContrast()) return;
        // Each tenth read over 20–80 ms of it, clear of the transitions.
        const a0 = Math.round(0.020 * fs);
        const a1 = Math.round(0.080 * fs);
        const per = a1 - a0 + 1;
        const tenth = (t) => {
            const base = c + Math.round(0.1 * t * fs);
            let sum = 0;
            for (let n = base + a0; n <= base + a1; n++) { proj(n); sum += pr; }
            return sum / per;
        };
        const depth = Math.max(0.1, 1 - this.lowFrac);
        const x = [0, 0, 0, 0, 0];
        let first = 0;
        for (let t = 0; t < 5; t++) {
            const v = tenth(t);
            if (t === 0) first = v;
            x[t] = (1 - v / H) / depth;
        }
        const sx = Math.max(1e-4, sigma / Math.sqrt(per) / (H * depth));

        r.read = true;
        r.cut = x[0] >= 0.5;
        // Marker or not: the carrier off through 300–500 ms, or on.
        const m = 0.5 * (x[3] + x[4]);
        r.marker = m >= 0.5;
        r.markConf = confOf(Math.abs(m - 0.5) / (sx / Math.SQRT2));
        r.a = x[1] >= 0.5 ? 1 : 0;
        r.b = x[2] >= 0.5 ? 1 : 0;
        r.aConf = confOf(Math.abs(x[1] - 0.5) / sx);
        r.bConf = confOf(Math.abs(x[2] - 0.5) / sx);
        if (!r.cut) {
            // No carrier-off at the start of a second: nothing here is a symbol.
            r.markConf = 0;
            r.aConf = 0;
            r.bConf = 0;
        }
        if (r.cut) this.lowFrac += 0.02 * (clamp(first / H, 0, 0.9) - this.lowFrac);
    }

    // The carrier's residual frequency in the mixed baseband, from how far its
    // phase turned between one second's pre-edge carrier and the next: used to
    // carry the phase across the half second each second is read over.
    // Unambiguous to ±0.5 Hz, and the search leaves it within a tenth of that.
    _trackCarrier(at, theta) {
        if (this.havePrevTheta && at > this.prevThetaAt) {
            const dt = (at - this.prevThetaAt) / this.fs;
            const d = remainder(theta - this.prevTheta - 2 * Math.PI * this.fResidual * dt, 2 * Math.PI);
            if (dt > 0.5 && dt < 1.5) {
                this.fResidual = clamp(this.fResidual + (FREQ_GAIN * d) / (2 * Math.PI * dt), -0.5, 0.5);
            }
        }
        this.havePrevTheta = true;
        this.prevTheta = theta;
        this.prevThetaAt = at;
    }

    _processSecond() {
        const fs = this.fs;
        const trk = this.trk;
        const pred = this.segEdge;
        let measEdge = 0;
        let meas = false;
        const warm = trk.valid && trk.count > TRK_WARM;
        if (warm) {
            // Settled: the fine kernel straight at the prediction. Finding the
            // edge first is where weak signals go wrong, and a tracker that
            // knows it to a fraction of a millisecond has nothing left to find.
            measEdge = this._steepestAt(pred, SLOPE_SIGMA_SEC, SLOPE_TRACK_SEC);
            meas = Number.isFinite(measEdge) && this._haveContrast();
            // Unless it settled on the wrong thing: a noise peak taken at
            // acquisition holds a tracker a few ms off for good. So the wide
            // search runs too, and when the median of its last RESEED_WINDOW
            // offsets is past RESEED_SEC the tracker is re-seeded there — the
            // median, as one wide search is itself noisier than a millisecond
            // at 35 dB-Hz.
            const out = { sig: 0 };
            const wideEdge = this._refineEdge(pred, out);
            if (Number.isFinite(wideEdge)) this.lastEdgeSnr = out.sig;
            if (Number.isFinite(wideEdge) && out.sig >= RESEED_SIG) {
                this.wideOff.push(wideEdge - pred);
                if (this.wideOff.length > RESEED_WINDOW) this.wideOff.shift();
                if (this.wideOff.length === RESEED_WINDOW) {
                    const med = upperMedian(this.wideOff);
                    if (Math.abs(med) > RESEED_SEC * fs) {
                        trk.reset();
                        measEdge = pred + med;
                        meas = true;
                        this.wideOff = [];
                    }
                }
            }
        }
        if (!meas) {
            measEdge = this._findFallingEdgeNear(Math.round(this._envPos(pred)), EDGE_TOL);
            meas = Number.isFinite(measEdge);
        }
        // Outliers: a whole envelope block while acquiring, 2 ms once settled.
        trk.update(meas, measEdge, trk.valid ? trk.period : fs, warm ? TRK_OUTLIER_SEC * fs : this.decim);
        const edge = trk.valid ? trk.edge : pred;
        this.blindSeconds = meas ? 0 : this.blindSeconds + 1;

        const r = secRec(edge);
        this._classify(edge, r);
        this.hist.push(r);
        if (this.hist.length > 16) this.hist.shift();

        this._handleSecond(r, meas);

        this.segEdge = trk.valid ? trk.edge + trk.period : edge + fs;

        if (this.blindSeconds >= MAX_BLIND_SECONDS) {
            if (this.lockState === 'locked') this.lockState = 'acquiring';
            this.segValid = false;
            this.scanPos = 0;
            this.blindSeconds = 0;
            trk.reset();
            this._dropAnchor();
            this.hist = [];
        }
    }

    // ── sync and frames ───────────────────────────────────────────────────────

    // The identifier 01111110 in bit A over eight seconds: every bit read, none
    // a confident marker, and their mean confidence at ID_MEAN_CONF.
    _identifierAt(at) {
        let sum = 0;
        for (let j = 0; j < 8; j++) {
            const r = at(j);
            if (!r.read || !r.cut || r.aConf < ID_BIT_MIN_CONF) return false;
            if (confMarker(r, STRUCT_CONF)) return false;
            if (r.a !== IDENTIFIER[j]) return false;
            sum += r.aConf;
        }
        return sum >= 8 * ID_MEAN_CONF;
    }

    _identifierInHist() {
        if (this.hist.length < 8) return false;
        const base = this.hist.length - 8;
        return this._identifierAt((j) => this.hist[base + j]);
    }

    // The identifier's last bit at frame index `last`.
    _identifierEndsAt(last) {
        if (last < 7 || last >= this.frFilled) return false;
        return this._identifierAt((j) => this.frame[last - 7 + j]);
    }

    _dropAnchor() {
        this.anchored = false;
        this.sofNext = 0;
        this.haveVoted = false;
        this.frame = Array.from({ length: FRAME_CAP }, () => secRec());
        this.frFilled = 0;
        this.frStart = 0;
        this.unconfirmedRun = 0;
    }

    _demote() {
        this.haveVoted = false;
        if (this.lockState === 'locked') this.lockState = 'acquiring';
    }

    _startFrame(r) {
        this.frame = Array.from({ length: FRAME_CAP }, () => secRec());
        this.frame[0] = r;
        this.frFilled = 1;
        this.frStart = r.edge;
        this.sofNext = 1;
    }

    // After a minute is finalised at `r`: r is second 00 of the next, unless
    // the finalise let the anchor go — then only a clear marker re-anchors.
    _afterFinalize(r) {
        if (!this.anchored && !confMarker(r, STRUCT_CONF)) return -1;
        this.anchored = true;
        this._startFrame(r);
        return 0;
    }

    _handleSecond(r, measured) {
        let sof = -1;
        if (!this.anchored) {
            if (confMarker(r, SYNC_CONF)) {
                this.anchored = true;
                sof = 0;
                this._startFrame(r);
            } else if (this._identifierInHist()) {
                // This second is the last of a minute; the next is second 00.
                this.anchored = true;
                sof = 59;
                this.sofNext = 0;
                this.frFilled = 0;
            }
        } else {
            sof = this.sofNext;
            if (sof === 0) {
                // The identifier just ended a minute (or anchored us): this is
                // second 00 whether or not its marker reads — eight bits of
                // evidence against one. The next identifier confirms the count.
                this._startFrame(r);
            } else if (sof >= 59 && confMarker(r, STRUCT_CONF)) {
                // The minute that was running has ended: it had `sof` seconds.
                this._finalizeFrame(sof, true);
                sof = this._afterFinalize(r);
            } else if (sof < 59 && confMarker(r, STRUCT_CONF)) {
                // A clear marker where none belongs: the count has slipped. This
                // is second 00; the minute running is abandoned.
                this._demote();
                this.haveLastFrame = false;
                this.unconfirmedRun = 0;
                sof = 0;
                this._startFrame(r);
            } else if (sof >= 60 && this._identifierEndsAt(sof - 1)) {
                // The marker faded, but the identifier says the minute ended.
                this._finalizeFrame(sof, false);
                sof = this._afterFinalize(r);
            } else if (sof >= FRAME_CAP - 1) {
                this._dropAnchor();
                this._demote();
                sof = -1;
            } else {
                this.frame[sof] = r;
                this.frFilled = sof + 1;
                this.sofNext = sof + 1;
                // The identifier ends the minute: decode it now, at its last
                // second, not a second later at the marker. It ends at s59, or
                // at s60 / s58 when a leap second made the minute 61 / 59 s —
                // which is how that is known. The marker after is second 00.
                if (sof >= 58 && sof <= 60 && this._identifierEndsAt(sof)) {
                    this._finalizeFrame(sof + 1, false);
                    if (this.anchored) this.sofNext = 0;
                }
            }
        }

        const edge = r.edge - MSF_EDGE_BIAS_SEC * this.fs;
        this.events.push({
            type: 'second', edge, measured, servable: true,
            symbol: !r.read ? 'unknown' : r.marker ? 'marker' : symbolName(r.a ? 1 : 0),
            conf: r.marker ? r.markConf : Math.min(r.markConf, r.aConf),
            sof,
        });

        // A second numbered 60 exists only in a leap minute, or when the count
        // has run past a faded marker; neither is labelled.
        if (this.lockState === 'locked' && this.haveVoted && sof >= 0 && sof < 60 && this.lastFrameEdge !== null) {
            const utcMs = composeUtc(this.voted, this.lastFrameEdge, edge, this.fs);
            if (utcMs !== null) this.events.push({ type: 'time', utcMs, edge, quality: this.votedQuality, sof });
        }
    }

    // ── the time code ─────────────────────────────────────────────────────────

    // Bit A or B of spec second `p` in a minute of `n` seconds, as
    // { bit, conf } or null. Fields from 17A and 52B on are counted back from
    // the end; the rest from second 00.
    _bitAt(n, p, isA) {
        const fromEnd = isA ? p >= 17 : p >= 52;
        const idx = fromEnd ? p + (n - 60) : p;
        if (idx < 1 || idx >= this.frFilled) return null;
        const r = this.frame[idx];
        if (!r.read || !r.cut || confMarker(r, STRUCT_CONF)) return null;
        const conf = isA ? r.aConf : r.bConf;
        return conf >= BIT_MIN_CONF ? { bit: isA ? r.a : r.b, conf } : null;
    }

    /** The minute in frame[0 .. n−1], or null: { utc, utcMs, summer, summerSoon, dut1Tenths, minConf }. */
    _decode(n) {
        let minConf = 1;
        const A = new Array(60).fill(0);
        const B = new Array(60).fill(0);
        for (let p = 17; p <= 51; p++) {
            const b = this._bitAt(n, p, true);
            if (!b) return null;
            A[p] = b.bit;
            minConf = Math.min(minConf, b.conf);
        }
        for (let p = 53; p <= 58; p++) {
            const b = this._bitAt(n, p, false);
            if (!b) return null;
            B[p] = b.bit;
            minConf = Math.min(minConf, b.conf);
        }
        // Odd parity: the group and its parity bit hold an odd number of ones.
        const oddOk = (from, to, pb) => {
            let ones = B[pb];
            for (let p = from; p <= to; p++) ones += A[p];
            return (ones & 1) === 1;
        };
        if (!oddOk(17, 24, 54) || !oddOk(25, 35, 55) || !oddOk(36, 38, 56) || !oddOk(39, 51, 57)) return null;
        const msb = (from, weights) => weights.reduce((v, w, k) => v + A[from + k] * w, 0);
        // BCD digits, each checked: a nibble past 9 is a misread.
        const digitsOk = (from, tensBits) => {
            let u = 0;
            for (let i = 0; i < 4; i++) u = u * 2 + A[from + tensBits + i];
            return u <= 9;
        };
        if (!digitsOk(17, 4) || !digitsOk(25, 1) || !digitsOk(30, 2) || !digitsOk(39, 2) || !digitsOk(45, 3)) return null;
        const year2 = msb(17, [80, 40, 20, 10, 8, 4, 2, 1]);
        const month = msb(25, [10, 8, 4, 2, 1]);
        const day = msb(30, [20, 10, 8, 4, 2, 1]);
        const wday = msb(36, [4, 2, 1]);
        const hour = msb(39, [20, 10, 8, 4, 2, 1]);
        const minute = msb(45, [40, 20, 10, 8, 4, 2, 1]);
        if (minute > 59 || hour > 23 || month < 1 || month > 12 || day < 1 || wday > 6) return null;
        // A day that does not exist, or a weekday that does not match the date,
        // is a misread that happened to pass parity.
        const days = daysFromCivil(2000 + year2, month, day);
        const back = civilFromDays(days);
        if (back.m !== month || back.d !== day) return null;
        if ((((days + 4) % 7) + 7) % 7 !== wday) return null;   // 0 = Sunday

        const summer = B[58] === 1;
        // DUT1: B01–B08 for +, B09–B16 for −; not counted from the end.
        let pos = 0;
        let neg = 0;
        for (let p = 1; p <= 16; p++) {
            const b = this._bitAt(n, p, false);
            if (b && b.bit) { if (p <= 8) pos++; else neg++; }
        }
        const dut1Tenths = pos > 0 && neg === 0 ? pos : neg > 0 && pos === 0 ? -neg : 0;
        // UK clock time of the minute starting at the NEXT marker: this frame's
        // second 00 is a minute before it, and UTC an hour behind in summer.
        const nextLocalMin = days * 1440 + hour * 60 + minute;
        const utcMs = (nextLocalMin - (summer ? 60 : 0) - 1) * 60000;
        return { utc: fieldsFromUtc(utcMs), utcMs, summer, summerSoon: B[53] === 1, dut1Tenths, minConf };
    }

    // The minute in frame[0 .. n−1] has ended. endMarker: its end was a marker
    // that read clearly (rather than the identifier alone).
    _finalizeFrame(n, endMarker) {
        // MSF marks a minute three ways: the marker at its start, the
        // identifier at its end, and the next marker. Confirmed when the
        // identifier is where it belongs, or both markers are; contradicted by
        // a clear marker inside the minute, or the identifier clearly wrong.
        const startMarker = confMarker(this.frame[0], SYNC_CONF);
        const idOk = this._identifierEndsAt(n - 1);
        let idWrong = 0;
        let strayMarks = 0;
        for (let j = 0; j < 8 && n - 8 + j >= 1; j++) {
            const r = this.frame[n - 8 + j];
            if (r.read && r.cut && r.aConf >= STRUCT_CONF && r.a !== IDENTIFIER[j]) idWrong++;
        }
        for (let s = 1; s < n; s++) if (confMarker(this.frame[s], STRUCT_CONF)) strayMarks++;
        const contradicted = strayMarks > 0 || idWrong >= 2;
        const confirmed = this.frFilled >= n && !contradicted && (idOk || (startMarker && endMarker));
        if (contradicted || (!confirmed && ++this.unconfirmedRun > MAX_UNCONFIRMED_MINUTES)) {
            this._dropAnchor();
            this._demote();
            this.haveLastFrame = false;
            return;
        }
        if (confirmed) this.unconfirmedRun = 0;

        const dec = confirmed ? this._decode(n) : null;
        this.lastFrameFrom = dec ? 1 : 0;

        // Every UTC field can move with any of the minute, hour, date and
        // summer-time bits, so each takes the weakest of them.
        const { symbols, conf } = syntheticFrame(dec ? dec.utc : null, dec ? dec.minConf : 0);
        const startEdge = this.frStart - MSF_EDGE_BIAS_SEC * this.fs;
        this.lastFrameEdge = startEdge;
        this.events.push({
            type: 'frame',
            utcMs: dec ? dec.utcMs : null,
            startEdge,
            confidence: dec ? dec.minConf : 0,
            dut1Tenths: dec ? dec.dut1Tenths : 0,
            summer: dec ? dec.summer : false,
            leapPending: false,     // MSF sends no warning
        });

        const P = this.trk.valid ? this.trk.period : this.fs;
        const consecutive = this.haveLastFrame
            && Math.abs(Math.round(this.frStart) - Math.round(this.lastFrameStart) - this.lastFrameLen * P) <= 0.25 * this.fs;
        if (!consecutive) this.voter.reset();
        this.haveLastFrame = true;
        this.lastFrameStart = this.frStart;
        this.lastFrameLen = n;
        this.voter.addFrame(symbols, conf);

        const certified = this.voter.locked();
        if (certified) {
            this.voted = this.voter.resolve().value;
            this.votedQuality = this.voter.lockConfidence();
        }
        // A minute that was not 60 s long had a leap second in it, which MSF
        // does not announce: counting whole seconds from its start would date
        // the next minute one out, so the next minute locks afresh.
        if (certified && confirmed && n === 60) {
            this.haveVoted = true;
            this.lockState = 'locked';
        } else {
            this._demote();
        }
    }
}
