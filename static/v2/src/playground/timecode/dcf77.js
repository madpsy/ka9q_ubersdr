// DCF77 77.5 kHz: the amplitude AND the phase modulation, together — a port
// of ubersdr-ntp's Dcf77Decoder (src/clock/Dcf77Decoder.cpp), constant for
// constant.
//
// The broadcast, per PTB and Hetzel (EFTF 1988):
//
//   AM   carrier cut to 15% for 0.1 s (binary 0) or 0.2 s (binary 1) at the
//        start of every second; second 59 is not cut, which marks the minute.
//        A leap second sends a 0 in second 59 and leaves second 60 uncut.
//   PM   from 200 ms to 992.77 ms of every second, 512 chips of 120 carrier
//        cycles (1.548 ms) each, from a 9-bit LFSR, ±15.6° per chip. The chips
//        are XORed with the second's time-code bit, which is the AM bit except
//        in seconds 59 (0), 0–9 (1) and 10–14 (0) — a fixed sixteen-bit word
//        that finds the minute without the AM.
//   Code BCD, LSB first, even parity per field, CET/CEST, naming the minute
//        that BEGINS at the next minute mark.
//
// They fail differently, so both run every second. PM is a 793 ms spread-
// spectrum correlation that measures the second to tens of microseconds and
// holds through noise that buries the AM; AM needs no correlator to find and
// is how the minute has always been marked. Timing is PM's edge whenever the
// correlator is tracking, AM's otherwise. Each minute is decoded twice, once
// from each demodulator's bits under its own parity; both valid and agreeing,
// or only one valid, is that minute, and two valid decodes that disagree are a
// contradiction from which nothing is certified. PM's sync word and AM's
// minute mark each check the other's idea of where the minute is.
//
// Chain, per input sample of complex baseband at 12 kHz:
//
//   carrier search (once)  DFT bins across ±20 Hz of the expected offset; the
//                          peak, refined, is where the mixer goes.
//   mixer                  z = x·e^{-jω0n}, ω0 followed slowly after.
//   AM                     z → 150 Hz biquad on I/Q → |.| → 10 ms boxcar →
//                          100 Hz envelope; second edges from the carrier cut.
//   PM                     y = Im(z·conj(r)) / |r|, r a 1 Hz one-pole of z: the
//                          carrier's own phase as the reference. Prefix sums of
//                          y (and of y high-passed) go in a ring, which makes
//                          the 512-chip correlation one read per chip
//                          TRANSITION rather than one multiply per sample.
//
// Then once per second, when both the second's envelope window and its PM
// burst are complete: measure AM, measure PM, pick the edge, classify both,
// sync, and at second 59 decode the minute. Decoded minutes are converted to
// UTC and handed to the voter as synthetic frames in WWVB's layout.
//
// Instants are input sample indices, as the README sets out: the C++'s edges
// already are, with the low-pass delay taken off AM's and PM's measured from
// the burst at exactly 200 ms. Source.cpp adds no bias for DCF77.

import { Biquad, median } from './dsp.js';
import { TimeFrameVoter, WWVB_MAP, syntheticFrame } from './voter.js';
import { civilFromDays } from './civil.js';
import {
    lround, clamp, floorMod, LOCK, checkRate, CarrierSearch, LiveTone, cestAt,
    decodeLegalMinute, leapSecondPossibleUtc, composeUtc, armPlausibility,
} from './pmcommon.js';

// ---- the broadcast -------------------------------------------------------
const kCarrierHz = 77500.0;
const kChips = 512;
const kChipSec = 120.0 / kCarrierHz;        // 1.548 ms
const kPmStartSec = 15500.0 / kCarrierHz;   // 0.200 s exactly

// ---- AM envelope ---------------------------------------------------------
const kEnvRateHz = 100;
const kEnvCap = 1024;      // > 10 s
const kPctWin = 300;       // 3 s of percentiles
const kEdgeTol = 12;       // ± env samples searched for a cut
const kEdgeLook = 12;      // lookahead an edge candidate needs
const kWarmEnv = 200;
// p90 over p05. The cut is to 15%, a contrast of about 6.7 on a clean signal;
// under 2 there is no cut to be found.
const kMinContrast = 2.0;
const kLpfCutHz = 150.0;

// ---- carrier reference ---------------------------------------------------
const kRefHz = 1.0;        // PM phase reference corner
const kDcHz = 0.1;         // what is taken off y before it is summed
// Half-width of the centred mean taken off y for the high-passed correlation:
// 10 ms wide, so a first null at 100 Hz and a 10 Hz tone down 36 dB.
const kHpHalfSec = 0.005;
const kFreqGain = 0.2;     // per-second fraction of the residual taken
const kPullHz = 3.0;

// ---- PM correlator -------------------------------------------------------
// SNR is |C| / σ_C. Acquisition sums correlation power over six seconds and
// wants the best lag at an rms of 3.5σ a second: on noise alone, 12000 lags of
// a chi-square with six degrees of freedom pass that about once in 10⁹
// searches; on a real signal it is reached near 21 dB-Hz.
const kPmAcqSeconds = 6;
const kPmAcqScore = 3.5;
const kPmMinSnr = 4.0;
const kPmMissLimit = 10;
const kPmFullConfSnr = 12.0;   // where a PM bit's confidence saturates
// The tracked burst's noise, followed across seconds (NoiseEst).
const kPmNoiseAlpha = 1.0 / 8.0;
const kPmNoiseJump = 4.0;
// A PM lock more than this far from where AM had the second re-segments.
const kResegTolSec = 0.030;

// ---- PM through weak stretches (pmHoldEvidence) ----------------------------
const kPmHoldWindow = 30;
const kPmHoldCoherent = 2.5;
const kPmHoldPowerK = 3.5;
const kPmEvClip = 4.0;
// While tracking, a second is measured only within half a chip of where it is
// expected, unless its peak is this strong.
const kPmStrongSnr = 8.0;

// ---- PM acquisition aided by AM (aidedAcquire) -----------------------------
// While AM frames the minute, every second's PM bit is known, so thirty
// seconds of correlation are summed COHERENTLY, sign-corrected by the
// predicted bit, at lags 25 ms either side of where AM puts the burst: a lock
// at 1.1σ a second, 10 dB under the plain search.
const kAidHalfSec = 0.025;
const kAidSeconds = 30;
const kAidMinSeconds = 10;
const kAidScore = 6.0;
const kAidClip = 4.0;
const kAidDriftSec = 0.005;
const kAidSpanSeconds = 90;
const kAidMaxSlope = 0.5;
const kAidKnownSlope = 0.05;
const kPeriodLearnSeconds = 32;

// ---- symbols & sync ------------------------------------------------------
// AM confidence is a z-score mapped (z − 1)/5 (classifyAm): 0.5 is 3.5σ.
const kStructConf = 0.50;
const kPmStructConf = 0.50;
const kSyncConf = 0.60;
// PM confidence is SNR / 12: 3σ (0.25) agrees with the fixed word; 6σ is
// needed to call one a contradiction.
const kPmSyncConf = 0.25;
// Below these a bit is not read at all.
const kPmBitMinConf = 0.10;
const kAmBitMinConf = 0.05;

// Edge trackers: as WwvbDecoder's.
const kTrkAlpha = 1.0 / 8.0;
const kTrkBeta = 1.0 / 128.0;
const kTrkWarm = 8;

// A second with neither an AM cut nor a PM peak for this long, running.
const kMaxBlindSeconds = 90;
const kMaxUnconfirmedMinutes = 2;
const kMaxStructFaults = 2;

const SYMBOL = { ZERO: 'zero', ONE: 'one', MARKER: 'marker', UNKNOWN: 'unknown' };

/** The PM bit every minute carries in these seconds, whatever the time: the sync word. −1 elsewhere. */
function pmFixedBit(sof) {
    if (sof === 59) return 0;
    if (sof >= 0 && sof <= 9) return 1;
    if (sof >= 10 && sof <= 14) return 0;
    return -1;
}

/**
 * The PM bits of the minute whose second 0 is utcS0Ms, as far as they can be
 * known in advance: the fixed word, the zone, the start-of-time bit, and the
 * time and date with their parities. −1 for the call bit, the changeover and
 * leap announcements (15, 16, 19) and s60.
 */
export function predictTimeCode(utcS0Ms) {
    const b = new Array(61).fill(-1);
    for (let s = 0; s < 60; s++) b[s] = pmFixedBit(s);
    const next = Math.floor(utcS0Ms / 1000) + 60;
    const cest = cestAt(next);
    const local = next + (cest ? 7200 : 3600);
    const days = Math.floor(local / 86400);
    const rem = floorMod(local, 86400);
    const { y, m: mo, d } = civilFromDays(days);
    const put = (s, n, v) => { for (let i = 0; i < n; i++) b[s + i] = (v >> i) & 1; };
    const bcd = (v) => (Math.floor(v / 10) << 4) | (v % 10);
    const par = (a, z) => { let p = 0; for (let s = a; s < z; s++) p ^= b[s]; return p; };
    b[17] = cest ? 1 : 0;
    b[18] = cest ? 0 : 1;
    b[20] = 1;
    put(21, 7, bcd(Math.floor(rem / 60) % 60));
    b[28] = par(21, 28);
    put(29, 6, bcd(Math.floor(rem / 3600)));
    b[35] = par(29, 35);
    put(36, 6, bcd(d));
    put(42, 3, floorMod(days + 3, 7) + 1);
    put(45, 5, bcd(mo));
    put(50, 8, bcd(floorMod(y, 100)));
    b[58] = par(36, 58);
    return b;
}

/**
 * The chip sequence as +1 (a 0 chip) / −1 (a 1 chip). The Galois LFSR is
 * PTB's, as published; its first chips are 000001000110000100111…
 */
export function buildChips() {
    const t = new Int8Array(kChips);
    let lfsr = 0;
    for (let i = 0; i < kChips; i++) {
        const chip = lfsr & 1;
        t[i] = chip ? -1 : 1;
        lfsr >>>= 1;
        if (chip ^ (lfsr === 0 ? 1 : 0)) lfsr ^= 0x110;
    }
    return t;
}

/**
 * Alpha-beta tracker on second edges, in fractional input samples, as
 * WwvbDecoder::trackEdge with the outlier threshold a parameter: a whole
 * envelope block for AM, one chip for PM.
 */
class EdgeTracker {
    constructor() { this.reset(); this.edge = 0; this.period = 0; }

    reset() { this.valid = false; this.count = 0; this.outliers = 0; }

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
            if (++this.outliers >= 3) { this.edge = raw; this.period = nominal; this.count = 1; this.outliers = 0; }
            else this.edge = pred;
            return;
        }
        this.outliers = 0;
        ++this.count;
        this.edge = pred + Math.max(1.0 / this.count, kTrkAlpha) * r;
        if (this.count > kTrkWarm) {
            this.period = clamp(this.period + kTrkBeta * r, nominal * (1.0 - 2e-4), nominal * (1.0 + 2e-4));
        }
    }

    // A second too weak to be measured on its own, still read where the burst
    // is expected: the loop is pulled by it at weight w, (SNR / floor)², what
    // a measurement is worth against one at the floor. Not counted as one.
    nudge(raw, w, nominal) {
        const pred = this.edge + this.period;
        const r = raw - pred;
        this.edge = pred + w * kTrkAlpha * r;
        this.period = clamp(this.period + w * kTrkBeta * r, nominal * (1.0 - 2e-4), nominal * (1.0 + 2e-4));
    }
}

// The noise a tracked burst is judged against, followed across seconds: an
// eight-second average, and a second whose own estimate is past four times it
// judged against its own figure — that second only, and clipped to four times
// before it enters the average, so that a fade cannot leave the average so
// high that the returning carrier reads weak for a minute.
class NoiseEst {
    constructor() { this.v = 0; this.now = 0; }
    update(inst) {
        if (inst <= 0) { this.now = this.v; return; }
        if (!(this.v > 0)) { this.v = this.now = inst; return; }
        this.now = inst > kPmNoiseJump * this.v ? inst : this.v;
        this.v += kPmNoiseAlpha * (Math.min(inst, kPmNoiseJump * this.v) - this.v);
    }
}

// One classified second, kept so a PM sync found at second 14 can fill in the
// fourteen seconds before it.
const emptyRec = () => ({ edge: 0, edgeExact: NaN, am: SYMBOL.UNKNOWN, amConf: 0, pmSign: 0, pmConf: 0 });

const SRC_AM = 0;
const SRC_PM = 1;

export class Dcf77Decoder {
    constructor({ sampleRate = 12000, carrierOffsetHz = 0, referenceNow = null } = {}) {
        checkRate(sampleRate, 'Dcf77Decoder');
        this.sr = sampleRate;
        this.decim = Math.max(1, lround(this.sr / 100.0));
        this.fNominal = carrierOffsetHz;
        this.chips = buildChips();

        // C(τ) = Σ_k t_k (P(τ+(k+1)tc) − P(τ+k·tc)) regrouped by the prefix sum
        // each term reads: only a change of chip contributes.
        const ck = [];
        const cw = [];
        const add = (k, w) => { if (w) { ck.push(k); cw.push(w); } };
        add(0, -this.chips[0]);
        for (let k = 1; k < kChips; k++) add(k, this.chips[k - 1] - this.chips[k]);
        add(kChips, this.chips[kChips - 1]);
        this.coK = Int32Array.from(ck);
        this.coW = Int8Array.from(cw);

        let cap = 1;
        while (cap < 3 * this.sr) cap <<= 1;
        this.pre = new Float64Array(cap);
        this.preH = new Float64Array(cap);
        this.hpM = Math.max(1, lround(kHpHalfSec * this.sr));
        this.mask = cap - 1;
        this.hpKeep2 = this._hpSignalKept();

        this.search = new CarrierSearch(this.fNominal, this.sr, { pullHz: kPullHz });
        this.live = new LiveTone(this.sr);

        this.voter = new TimeFrameVoter({ fields: WWVB_MAP, minBitConfidence: 0.05, minLockQuality: 0.05 });
        armPlausibility(this.voter, referenceNow);
        this.reset();
    }

    // ---- the interface ---------------------------------------------------

    process(re, im, n) {
        for (let i = 0; i < n; i++) {
            const k = this.samples++;
            if (this.searching) this._feedAcquisition(re[i], im[i]);
            else this._feedSteady(re[i], im[i], k);
        }
    }

    reset() {
        this.events = [];
        this.samples = 0;
        this.searching = true;
        this.search.clear();
        this.live.clear();
        this.lastToneSnrDb = null;
        this.f0 = this.fNominal;
        this.oscRe = 1; this.oscIm = 0; this.oscRenorm = 0;
        this.stepRe = 1; this.stepIm = 0;
        this.lpI = null; this.lpQ = null; this.lpfDelay = 0;
        this.magAccum = 0; this.magCount = 0;
        this.env = new Float32Array(kEnvCap); this.envCount = 0; this.envBaseSample = 0;
        this.pHi = 0; this.pLo = 0;
        this.aRef = 0; this.aDc = 0;
        this.refRe = 0; this.refIm = 0; this.yDc = 0; this.freqCount = 0; this.freqPrevRe = 0; this.freqPrevIm = 0;
        this.pre.fill(0);
        this.preH.fill(0);
        this.useHp = false;
        this.noiseRaw = new NoiseEst(); this.noiseHp = new NoiseEst();
        this.steadyStart = 0;
        this.segValid = false; this.segEdge = 0; this.scanPos = 0; this.blindSeconds = 0;
        this.amTrk = new EdgeTracker(); this.pmTrk = new EdgeTracker();
        this.pmLocked = false; this.pmMiss = 0; this.lastSearchEnd = 0;
        this.acqPint = 0; this.acqHistN = 0; this.acqHistNext = 0; this.acqBase = 0; this.acqHist = [];
        this.pmEv = []; this.pmHolding = false;
        this.aidPending = null; this.aid = []; this.aidE0 = 0; this.aidP0 = 0; this.pmAidedLocks = 0;
        this.periodKnown = false; this.periodLearnt = 0;
        this.lastPmSnr = NaN;
        this.amMinusPm = 0; this.amMinusPmHave = false;
        this.lowFrac = 0.15;
        this.polarity = 1; this.polarityKnown = false;
        this.hist = [];
        this.timingFromPm = false;
        this.frame = Array.from({ length: 60 }, emptyRec);
        this.voter.reset();
        this.lockState = LOCK.NOSIGNAL;
        this._dropAnchor();
        this.haveLastFrame = false; this.lastFrameStart = 0;
        this.lastFrameFrom = 0; this.prevFrameFrom = 0;
        this.pmRefusedLocks = 0;
        this.timeFrameStart = 0; this.haveTimeFrame = false;
        this.frames = 0;
    }

    drain() {
        const out = this.events;
        this.events = [];
        return out;
    }

    status() {
        const v = this.voter.verdict();
        return {
            state: this.lockState,
            station: 'DCF77',
            snrDb: this.lastToneSnrDb,
            carrierOffsetHz: this.searching ? null : this.f0,
            refusal: this.lockState === LOCK.LOCKED ? '' : v.reason,
            frames: this.voter.frameCount(),
            detail: {
                carrierFound: !this.searching,
                toneSnrDb: this.lastToneSnrDb,
                contrast: this.pLo > 1e-12 ? this.pHi / this.pLo : 0,
                segmented: this.segValid,
                anchored: this.anchored,
                pmLocked: this.pmLocked,
                pmSnrDb: Number.isFinite(this.lastPmSnr) ? this.lastPmSnr : null,
                pmHolding: this.pmHolding,
                pmInterference: this.useHp,
                pmAidedLocks: this.pmAidedLocks,
                pmRefusedLocks: this.pmRefusedLocks,
                polarity: this.polarityKnown ? this.polarity : 0,
                timingFromPm: this.timingFromPm,
                timing: this.timingFromPm ? 'PM' : 'AM',
                amMinusPmMs: this.amMinusPmHave ? this.amMinusPm : null,
                cutDepth: this.lowFrac,
                lastFrameFrom: ['none', 'AM', 'PM', 'AM+PM', 'AM≠PM'][this.lastFrameFrom],
                framesDecoded: this.frames,
                voteQuality: this.voter.lockConfidence(),
                windowSize: this.voter.cfg.window,
            },
        };
    }

    // ---- carrier search --------------------------------------------------

    _feedAcquisition(xr, xi) {
        const r = this.search.feed(xr, xi);
        if (!r) return;
        if (r.snrDb !== null) this.lastToneSnrDb = r.snrDb;
        if (r.found) { this.f0 = r.f; this._startSteady(); }
    }

    _setMixer(f) {
        this.f0 = clamp(f, this.fNominal - kPullHz, this.fNominal + kPullHz);
        this.stepRe = Math.cos((-2 * Math.PI * this.f0) / this.sr);
        this.stepIm = Math.sin((-2 * Math.PI * this.f0) / this.sr);
    }

    _startSteady() {
        this.searching = false;
        this.envBaseSample = this.samples;
        this.steadyStart = this.samples;
        this.pre[this.steadyStart & this.mask] = 0;
        this.lastSearchEnd = this.steadyStart;
        this._setMixer(this.f0);
        this.oscRe = 1; this.oscIm = 0; this.oscRenorm = 0;
        this.lpI = Biquad.lowpass(kLpfCutHz, this.sr);
        this.lpQ = Biquad.lowpass(kLpfCutHz, this.sr);
        // The low-pass's DC group delay, as WwvbDecoder derives it.
        this.lpfDelay = this.lpI.dcDelay();
        this.aRef = 1 - Math.exp((-2 * Math.PI * kRefHz) / this.sr);
        this.aDc = 1 - Math.exp((-2 * Math.PI * kDcHz) / this.sr);
        this._setLockState(LOCK.ACQUIRING);
    }

    // ---- per sample ------------------------------------------------------

    _feedSteady(xr, xi, k) {
        const zr = xr * this.oscRe - xi * this.oscIm;
        const zi = xr * this.oscIm + xi * this.oscRe;
        const nr = this.oscRe * this.stepRe - this.oscIm * this.stepIm;
        this.oscIm = this.oscRe * this.stepIm + this.oscIm * this.stepRe;
        this.oscRe = nr;
        if (++this.oscRenorm >= 1024) {
            const m = Math.hypot(this.oscRe, this.oscIm);
            if (m > 1e-9) { this.oscRe /= m; this.oscIm /= m; }
            this.oscRenorm = 0;
        }

        const tone = this.live.feed(zr, zi);
        if (tone !== null) this.lastToneSnrDb = tone;

        // PM: the phase against the carrier's own recent phase.
        this.refRe += this.aRef * (zr - this.refRe);
        this.refIm += this.aRef * (zi - this.refIm);
        const rp = this.refRe * this.refRe + this.refIm * this.refIm;
        let y = rp > 1e-30 ? (zi * this.refRe - zr * this.refIm) / Math.sqrt(rp) : 0;
        this.yDc += this.aDc * (y - this.yDc);
        y -= this.yDc;
        const mask = this.mask;
        const pre = this.pre;
        const i0 = k & mask;
        const i1 = (k + 1) & mask;
        pre[i1] = pre[i0] + y;

        // The same, high-passed without a phase shift: each sample less the
        // mean of the 2M+1 centred on it, M samples late. A causal filter would
        // move the correlation peak; this cannot. Correlated when it gives the
        // better SNR (hpBetter): a steady tone a few hertz off the carrier lands
        // in y as a large slow sinusoid, but the high-pass costs 1.5 dB of a
        // clean burst (hpSignalKept).
        const hpM = this.hpM;
        const c = k - hpM;
        if (c >= this.steadyStart + hpM) {
            const c0 = c & mask;
            const c1 = (c + 1) & mask;
            if (c === this.steadyStart + hpM) this.preH[c0] = 0;
            const raw = pre[c1] - pre[c0];
            const ma = (pre[i1] - pre[(c - hpM) & mask]) / (2 * hpM + 1);
            this.preH[c1] = this.preH[c0] + (raw - ma);
        }

        // Follow the carrier: a residual offset shows as the reference turning.
        if (++this.freqCount >= this.sr) {
            this.freqCount = 0;
            if (this.freqPrevRe !== 0 || this.freqPrevIm !== 0) {
                const cr = this.refRe * this.freqPrevRe + this.refIm * this.freqPrevIm;
                const ci = this.refIm * this.freqPrevRe - this.refRe * this.freqPrevIm;
                this._setMixer(this.f0 + (kFreqGain * Math.atan2(ci, cr)) / (2 * Math.PI));
            }
            this.freqPrevRe = this.refRe; this.freqPrevIm = this.refIm;
        }

        // AM envelope.
        const I = this.lpI.process(zr);
        const Q = this.lpQ.process(zi);
        this.magAccum += Math.sqrt(I * I + Q * Q);
        if (++this.magCount >= this.decim) {
            this._pushEnvelope(Math.fround(this.magAccum / this.magCount));
            this.magAccum = 0;
            this.magCount = 0;
        }
    }

    _pushEnvelope(v) {
        this.env[this.envCount % kEnvCap] = v;
        ++this.envCount;
        this._updatePercentiles();
        if (!this.segValid) this._trySeedAm();
        this._pmAcquireStep();
        while (this.segValid && this._canProcessSecond()) this._processSecond();
    }

    // ---- prefix sums -----------------------------------------------------

    // First sample index whose prefix sum is still in the ring.
    _prefixLo() { return Math.max(this.steadyStart + this.hpM, this.samples - this.hpM - this.mask + 1); }
    // One past the last sample whose high-passed prefix sum exists.
    _prefixHi() { return this.samples - this.hpM; }

    // Sum of y up to instant x, linearly interpolated. Sample k is the signal
    // AT instant k, so it stands for [k − ½, k + ½), and the running sum up to
    // instant x is the prefix at x + ½. Taken as [k, k + 1) every PM edge came
    // out half a sample late.
    _prefixAt(p, at) {
        const x = at + 0.5;
        const fl = Math.floor(x);
        const a = p[fl & this.mask];
        const b = p[(fl + 1) & this.mask];
        return a + (x - fl) * (b - a);
    }

    _burstInRing(tau, tc) {
        return tau - 2 >= this._prefixLo() && tau + kChips * tc + 2 <= this._prefixHi();
    }

    _corrOn(p, tau, tc) {
        const { coK, coW } = this;
        const mask = this.mask;
        let s = 0;
        for (let j = 0; j < coK.length; j++) {
            const x = tau + coK[j] * tc + 0.5;
            const fl = Math.floor(x);
            const a = p[fl & mask];
            s += coW[j] * (a + (x - fl) * (p[(fl + 1) & mask] - a));
        }
        return s;
    }

    _corrAt(tau, tc) { return this._corrOn(this.useHp ? this.preH : this.pre, tau, tc); }

    // σ_C² on prefix p: the spread of the correlation itself, at lags that do
    // not line up with a burst — not the variance of y times the samples, which
    // treats y as white, and y is not. The median of the squares of up to 32
    // lags, over the 0.455σ² a chi-square with one degree of freedom has.
    _noise2On(p, tc, n, at) {
        const sq = [];
        for (let j = 0; j < n && sq.length < 32; j++) {
            const t = at(j);
            if (!this._burstInRing(t, tc)) continue;
            const c = this._corrOn(p, t, tc);
            sq.push(c * c);
        }
        if (sq.length < 8) return -1;
        return Math.max(1e-30, median(sq) / 0.455);
    }

    // Behind a tracked burst: 24 lags running back from it, a non-integer
    // number of chips apart, starting four chips out past the triangle.
    _trackNoise2(p, tau, tc) {
        return this._noise2On(p, tc, 24, (j) => tau - (4.0 + 5.37 * j) * tc);
    }

    // Whether the high-passed correlation has the better SNR: it takes out
    // more noise power than the burst power it costs.
    _hpBetter(raw2, hp2) {
        return raw2 > 0 && hp2 > 0 && hp2 < this.hpKeep2 * raw2;
    }

    // What the high-pass leaves of a burst's correlation peak, as a fraction
    // of its power: 0.72 at 12 kHz.
    _hpSignalKept() {
        const spc = kChipSec * this.sr;
        const hpM = this.hpM;
        const n = Math.ceil(kChips * spc);
        const w = new Float64Array(n + 2 * hpM + 1);
        for (let i = 0; i < n; i++) w[i + hpM] = this.chips[Math.min(kChips - 1, Math.trunc(i / spc))];
        const run = new Float64Array(w.length + 1);
        for (let i = 0; i < w.length; i++) run[i + 1] = run[i] + w[i];
        let kept = 0;
        let full = 0;
        for (let i = hpM; i + hpM < w.length; i++) {
            const mean = (run[i + hpM + 1] - run[i - hpM]) / (2 * hpM + 1);
            kept += (w[i] - mean) * w[i];
            full += w[i] * w[i];
        }
        const a = full > 0 ? kept / full : 1;
        return a * a;
    }

    // Early-late on the triangle the chip correlation makes: E and L half a
    // chip either side, (E − L)/(E + L) the error in units of (tc − d). Twice.
    _refine(tau, tc, sign) {
        const d = 0.5 * tc;
        for (let it = 0; it < 2; it++) {
            const E = sign * this._corrAt(tau - d, tc);
            const L = sign * this._corrAt(tau + d, tc);
            if (E + L <= 0) break;
            tau -= clamp(((E - L) / (E + L)) * (tc - d), -d, d);
        }
        return tau;
    }

    _period() {
        if (this.pmLocked && this.pmTrk.valid) return this.pmTrk.period;
        if (this.amTrk.valid) return this.amTrk.period;
        return this.sr;
    }

    // ---- PM acquisition: every lag of the last second --------------------

    _pmAcquireStep() {
        if (this.pmLocked) return;
        const P = this._period();
        const tc = kChipSec * P;
        const total = this.samples;
        if (total - this.lastSearchEnd < Math.trunc(P)) return;
        const hi = Math.floor(this._prefixHi() - kChips * tc - tc - 3.0);
        const lo = hi - Math.trunc(P) + 1;
        if (lo - Math.trunc(tc) - 2 < this._prefixLo()) return;
        this.lastSearchEnd = total;

        // Integer lags share their fractional chip offsets: worked out once.
        const nco = this.coK.length;
        const ofl = new Int32Array(nco);
        const ofr = new Float64Array(nco);
        for (let j = 0; j < nco; j++) {
            const o = this.coK[j] * tc;
            const fl = Math.floor(o);
            ofl[j] = fl;
            ofr[j] = o - fl;
        }
        const pint = hi - lo + 1;
        if (pint !== this.acqPint) {
            this.acqPint = pint;
            this.acqBase = lo;
            this.acqHist = Array.from({ length: kPmAcqSeconds }, () => new Float32Array(pint));
            this.acqHistN = 0;
            this.acqHistNext = 0;
        }
        {
            const span = (hi - lo + 1) / 24.0;
            const at = (j) => lo + (j + 0.5) * span;
            this.useHp = this._hpBetter(this._noise2On(this.pre, tc, 24, at), this._noise2On(this.preH, tc, 24, at));
        }
        const pr = this.useHp ? this.preH : this.pre;
        const mask = this.mask;
        const coW = this.coW;
        const c = new Float64Array(pint);
        for (let tau = lo; tau <= hi; tau++) {
            let sum = 0;
            for (let j = 0; j < nco; j++) {
                const kk = tau + ofl[j];
                const a = pr[kk & mask];
                sum += coW[j] * (a + ofr[j] * (pr[(kk + 1) & mask] - a));
            }
            c[tau - lo] = sum;
        }
        // σ² of one lag's correlation, from the median over all of them:
        // nearly every lag is noise.
        const sq = new Float64Array(pint);
        for (let i = 0; i < pint; i++) sq[i] = c[i] * c[i];
        const sorted = sq.slice().sort();
        const v = Math.max(1e-30, sorted[pint >> 1] / 0.455);

        // Filed by lag modulo the second, so the same phase lines up across
        // searches however far apart they ran.
        const slot = this.acqHist[this.acqHistNext];
        const off0 = floorMod(lo - this.acqBase, pint);
        for (let i = 0; i < pint; i++) slot[(off0 + i) % pint] = sq[i] / v;
        this.acqHistNext = (this.acqHistNext + 1) % kPmAcqSeconds;
        this.acqHistN = Math.min(this.acqHistN + 1, kPmAcqSeconds);

        // Non-coherent: the bit flips the sign of every second's peak but not
        // its power, so power adds across seconds where amplitude cannot.
        let bestIdx = 0;
        let bestS = -1;
        for (let i = 0; i < pint; i++) {
            let sum = 0;
            for (let h = 0; h < this.acqHistN; h++) sum += this.acqHist[h][i];
            if (sum > bestS) { bestS = sum; bestIdx = i; }
        }
        const score = Math.sqrt(Math.max(0, bestS) / Math.max(1, this.acqHistN));
        this.lastPmSnr = 20 * Math.log10(Math.max(score, 1e-3));
        if (this.acqHistN < kPmAcqSeconds || score < kPmAcqScore) return;

        // The phase, in this search's own window, refined on this search's data.
        const tau0 = lo + floorMod(bestIdx - off0, pint);
        const c0 = c[tau0 - lo];
        const tau = this._refine(tau0, tc, c0 >= 0 ? 1 : -1);
        this._pmLockAt(tau, P);
    }

    // AM has been reading valid minutes, lately.
    _amDecoding() {
        return this.anchored && (this.lastFrameFrom === 1 || this.lastFrameFrom === 3
            || this.prevFrameFrom === 1 || this.prevFrameFrom === 3);
    }

    _pmLockAt(tau, P) {
        this.pmLocked = true;
        this.pmMiss = 0;
        this.pmEv = [];
        this.aid = [];
        this.aidPending = null;
        this.noiseRaw = new NoiseEst(); this.noiseHp = new NoiseEst();
        this.acqPint = 0;
        this.pmTrk.reset();
        const pmEdge = tau - kPmStartSec * P;
        if (!this.segValid) {
            this.segValid = true;
            this.segEdge = pmEdge;
            this.amTrk.reset();
            this.hist = [];
            return;
        }
        // Where PM puts the second the segmentation is about to process.
        const cand = pmEdge + P * Math.round((this.segEdge - pmEdge) / P);
        if (Math.abs(cand - this.segEdge) > kResegTolSec * this.sr && this._amDecoding()) {
            // AM is decoding valid minutes, which it cannot do at the wrong
            // phase of the second: this PM "lock" is interference that happened
            // to correlate. Refused, and searched for again from nothing.
            this.pmLocked = false;
            ++this.pmRefusedLocks;
            return;
        }
        if (Math.abs(cand - this.segEdge) > kResegTolSec * this.sr) {
            // AM had the second somewhere else. PM wins, and nothing counted
            // from AM's idea of the second survives it.
            if (this.lockState === LOCK.LOCKED) this._setLockState(LOCK.ACQUIRING);
            this._dropAnchor();
            this.hist = [];
            this.amTrk.reset();
        }
        this.segEdge = cand;
    }

    // Search a chip and a half either side of where the tracker expects the
    // burst. `meas` says whether the peak was clear enough to time by; C and
    // snr are filled either way, at the prediction when not.
    _pmTrack(pred, P) {
        const tc = kChipSec * P;
        const win = Math.ceil(1.5 * tc);
        const base = Math.floor(pred);
        if (!this._burstInRing(base - win - tc, tc) || !this._burstInRing(base + win + tc, tc)) {
            return { meas: false, tau: pred, C: 0, snr: 0 };
        }
        this.noiseRaw.update(this._trackNoise2(this.pre, base, tc));
        this.noiseHp.update(this._trackNoise2(this.preH, base, tc));
        this.useHp = this._hpBetter(this.noiseRaw.v, this.noiseHp.v);
        const noise2 = this.useHp ? this.noiseHp.now : this.noiseRaw.now;
        const snrOf = (C) => (noise2 > 0 ? Math.abs(C) / Math.sqrt(noise2) : 0);
        let best = 0;
        let bestTau = base;
        for (let d = -win; d <= win; d++) {
            const c = this._corrAt(base + d, tc);
            if (Math.abs(c) > Math.abs(best)) { best = c; bestTau = base + d; }
        }
        const tau = this._refine(bestTau, tc, best >= 0 ? 1 : -1);
        const C = this._corrAt(tau, tc);
        const snr = snrOf(C);
        const gate = this.pmTrk.valid && snr < kPmStrongSnr ? 0.5 * tc : win;
        if (snr >= kPmMinSnr && Math.abs(tau - pred) <= gate) return { meas: true, tau, C, snr };
        const Cp = this._corrAt(pred, tc);
        return { meas: false, tau: pred, C: Cp, snr: snrOf(Cp) };
    }

    // ---- AM envelope helpers (as WwvbDecoder) ----------------------------

    _envAt(i) { return this.env[floorMod(i, kEnvCap)]; }

    // Envelope position of an input-sample instant, delay of the low-pass included.
    _envPos(sample) { return (sample - this.envBaseSample + this.lpfDelay) / this.decim; }

    _updatePercentiles() {
        const n = Math.min(kPctWin, this.envCount);
        if (n < 8) { this.pHi = this.pLo = 0; return; }
        const a = new Float32Array(n);
        for (let i = 0; i < n; i++) a[i] = this._envAt(this.envCount - n + i);
        a.sort();
        // p05 lands in the cut: 10–20% of every second is cut.
        this.pLo = a[Math.trunc(0.05 * n)];
        this.pHi = a[Math.trunc(0.90 * n)];
    }

    _haveContrast() { return this.pHi >= kMinContrast * Math.max(this.pLo, 1e-9); }

    _edgeThresholds() {
        const { pLo, pHi } = this;
        return [pLo + 0.6 * (pHi - pLo), pLo + 0.5 * (pHi - pLo), pLo + 0.4 * (pHi - pLo)];
    }

    _sustainedLow(i, thrLo) {
        let checked = 0;
        let low = 0;
        for (let d = 1; d <= 7; d++) {
            if (i + d >= this.envCount) break;
            ++checked;
            if (this._envAt(i + d) < thrLo) ++low;
        }
        return checked >= 5 && low >= checked - 1;
    }

    _isFallingEdge(i, thrHi, thrMid, thrLo) {
        if (!(this._envAt(i - 1) >= thrMid && this._envAt(i) < thrMid)) return false;
        let high = false;
        for (let d = 1; d <= 3 && !high; d++) high = this._envAt(i - d) >= thrHi;
        return high && this._sustainedLow(i, thrLo);
    }

    // Sub-block position of the cut crossing at env[i], as an input sample:
    // the area under the normalised envelope across the crossing says where a
    // step with that area would sit.
    _edgeSampleAt(i) {
        let hi = 0;
        let lo = 0;
        for (let d = 4; d <= 8; d++) hi += this._envAt(i - d);
        for (let d = 4; d <= 8; d++) lo += this._envAt(i + d);
        hi /= 5;
        lo /= 5;
        let pos = i;
        const span = hi - lo;
        if (span > 1e-12) {
            let area = 0;
            for (let k = i - 2; k <= i + 3; k++) area += (this._envAt(k) - lo) / span;
            pos = clamp(i - 2 + area, i - 1.5, i + 1.5);
        }
        return this.envBaseSample + pos * this.decim - this.lpfDelay;
    }

    _trySeedAm() {
        if (this.envCount < kWarmEnv || !this._haveContrast()) return;
        const [thrHi, thrMid, thrLo] = this._edgeThresholds();
        const lo = Math.max(this.scanPos, 9, this.envCount - kEnvCap + 9);
        for (let i = lo; i + kEdgeLook < this.envCount; i++) {
            this.scanPos = i;
            if (this._isFallingEdge(i, thrHi, thrMid, thrLo)) {
                this.segValid = true;
                this.segEdge = this._edgeSampleAt(i);
                this.hist = [];
                return;
            }
        }
    }

    _findFallingEdgeNear(pred, tol) {
        if (!this._haveContrast()) return null;
        const [thrHi, thrMid, thrLo] = this._edgeThresholds();
        const lo = Math.max(pred - tol, this.envCount - kEnvCap + 9);
        const hi = Math.min(pred + tol, this.envCount - 1 - kEdgeLook);
        let bestEdge = pred;
        let bestDist = tol + 1;
        for (let i = lo; i <= hi; i++) {
            if (i < 9) continue;
            if (this._isFallingEdge(i, thrHi, thrMid, thrLo)) {
                const d = Math.abs(i - pred);
                if (d < bestDist) { bestDist = d; bestEdge = i; }
            }
        }
        if (bestDist > tol) return null;
        return this._edgeSampleAt(bestEdge);
    }

    // ---- once per second -------------------------------------------------

    _canProcessSecond() {
        const j0 = Math.floor(this._envPos(this.segEdge));
        if (this.envCount < j0 + kEnvRateHz + kEdgeTol + kEdgeLook) return false;
        const P = this._period();
        const tc = kChipSec * P;
        const burstEnd = this.segEdge + kPmStartSec * P + kChips * tc + 3.0 * tc + 4.0;
        return this._prefixHi() >= burstEnd;
    }

    // The AM symbol of the second at `edge`: how far the carrier is cut in the
    // first and second tenths against its level later on. Confidence is a
    // z-score against the envelope's own noise in this second's full-carrier
    // stretch, mapped (z − 1)/5. The depth of the cut is learnt: in noise the
    // envelope of a carrier cut to 15% averages well above 15%, so the cut
    // looks shallower the weaker the signal. Learnt from every second the frame
    // says MUST be cut, and otherwise only from clear cuts.
    _classifyAm(edge, mustCut) {
        const j0 = lround(this._envPos(edge));
        const w = new Float32Array(kEnvRateHz);
        for (let k = 0; k < kEnvRateHz; k++) w[k] = this._envAt(j0 + k);
        const out = { sym: SYMBOL.UNKNOWN, conf: 0, w };
        if (j0 < this.envCount - kEnvCap + 1 || !this._haveContrast()) return out;
        const mean = (a, b) => { let s = 0; for (let k = a; k <= b; k++) s += w[k]; return s / (b - a + 1); };
        const H = mean(30, 94);
        if (!(H > 0)) return out;
        let v = 0;
        for (let k = 30; k <= 94; k++) v += (w[k] - H) * (w[k] - H);
        const sBlock = Math.sqrt(v / 64.0);
        const d1 = mean(2, 8);
        const d2 = mean(12, 18);
        const depth = Math.max(0.1, 1.0 - this.lowFrac);
        const x1 = (1.0 - d1 / H) / depth;
        const x2 = (1.0 - d2 / H) / depth;
        const sx = Math.max(1e-4, sBlock / Math.sqrt(7.0) / (H * depth));

        // Hypotheses in (x1, x2): 0.1 s cut (1,0), 0.2 s cut (1,1), none (0,0).
        const kMu = [[1, 0], [1, 1], [0, 0]];
        const ds = kMu.map(([a, b]) => (x1 - a) * (x1 - a) + (x2 - b) * (x2 - b));
        let best = 0;
        for (let h = 1; h < 3; h++) if (ds[h] < ds[best]) best = h;
        let run = -1;
        for (let h = 0; h < 3; h++) if (h !== best && (run < 0 || ds[h] < ds[run])) run = h;
        const sep = Math.hypot(kMu[best][0] - kMu[run][0], kMu[best][1] - kMu[run][1]);
        const z = (ds[run] - ds[best]) / (2.0 * sep * sx);
        out.conf = Math.fround(clamp((z - 1.0) / 5.0, 0, 1));
        out.sym = best === 0 ? SYMBOL.ZERO : best === 1 ? SYMBOL.ONE : SYMBOL.MARKER;

        if (mustCut || (best !== 2 && out.conf >= 0.5)) {
            this.lowFrac += (mustCut ? 0.02 : 0.05) * (clamp(d1 / H, 0, 0.9) - this.lowFrac);
        }
        return out;
    }

    _processSecond() {
        const P = this._period();
        const pred = this.segEdge;

        const amEdgeV = this._findFallingEdgeNear(lround(this._envPos(pred)), kEdgeTol);
        const amMeas = amEdgeV !== null;
        const amEdge = amMeas ? amEdgeV : 0;

        const sofHere = this.anchored ? this.sofNext : -1;
        let pmMeas = false;
        let pmTau = 0;
        let pmC = 0;
        let pmSnr = 0;
        const pmWas = this.pmLocked;
        if (this.pmLocked) {
            const m = this._pmTrack(pred + kPmStartSec * P, P);
            pmMeas = m.meas; pmTau = m.tau; pmC = m.C; pmSnr = m.snr;
            this.lastPmSnr = 20 * Math.log10(Math.max(pmSnr, 1e-3));
            this._pushPmEvidence(pmC, pmSnr, sofHere);
            if (pmMeas) this.pmMiss = 0;
            else if (++this.pmMiss >= kPmMissLimit && !this._pmHoldEvidence()) {
                this.pmLocked = false;
                this.pmTrk.reset();
                this.pmEv = [];
                this.lastSearchEnd = this.samples;
            }
        }
        this.pmHolding = this.pmLocked && this.pmMiss >= kPmMissLimit;
        const pmEdge = pmTau - kPmStartSec * P;
        if (this.pmLocked) {
            // A new tracker's second starts nominal: AM's, on a weak cut, can
            // be a couple of samples out.
            const nominal = this.pmTrk.valid ? P : this.sr;
            if (pmMeas || !this.pmTrk.valid || !(pmSnr > 0)) this.pmTrk.update(pmMeas, pmEdge, nominal, kChipSec * P);
            else this._pmNudge(pmTau, pmC, pmSnr, sofHere, P);
            if (this.pmTrk.valid && this.pmTrk.count >= kPeriodLearnSeconds) {
                this.periodKnown = true;
                this.periodLearnt = this.pmTrk.period;
            }
        }
        this.amTrk.update(amMeas, amEdge, this.amTrk.valid ? this.amTrk.period : this.sr, this.decim);
        if (pmMeas && amMeas) {
            const d = ((amEdge - pmEdge) * 1000) / this.sr;
            this.amMinusPm = this.amMinusPmHave ? this.amMinusPm + 0.05 * (d - this.amMinusPm) : d;
            this.amMinusPmHave = true;
        }

        this.timingFromPm = this.pmLocked && this.pmTrk.valid;
        const edge = this.timingFromPm ? this.pmTrk.edge : this.amTrk.valid ? this.amTrk.edge : pred;
        const measured = this.timingFromPm ? pmMeas : amMeas;
        this.blindSeconds = amMeas || pmMeas ? 0 : this.blindSeconds + 1;

        const r = emptyRec();
        r.edge = lround(edge);
        r.edgeExact = edge;
        const am = this._classifyAm(edge, sofHere >= 0 && sofHere < 59);
        r.am = am.sym;
        r.amConf = am.conf;
        if (pmWas && pmSnr > 0) {
            r.pmSign = pmC >= 0 ? 1 : -1;
            r.pmConf = Math.fround(clamp(pmSnr / kPmFullConfSnr, 0, 1));
        }
        this.hist.push(r);
        if (this.hist.length > 64) this.hist.shift();

        this._handleSecond(r, measured);

        this.segEdge = this.timingFromPm ? this.pmTrk.edge + this.pmTrk.period
            : this.amTrk.valid ? this.amTrk.edge + this.amTrk.period
                : edge + this.sr;

        if (this.blindSeconds >= kMaxBlindSeconds) {
            // Nothing heard at the second for a minute and a half: start again
            // from the air rather than coast on a stale cadence.
            if (this.lockState === LOCK.LOCKED) this._setLockState(LOCK.ACQUIRING);
            this.segValid = false;
            this.scanPos = 0;
            this.blindSeconds = 0;
            this.amTrk.reset();
            this._dropAnchor();
            this.hist = [];
        }

        // This second's burst, framed by AM, goes to the aided search a second
        // from now, when every lag of its window is in the ring.
        if (this.aidPending && !this.pmLocked) this._aidedAcquire(this.aidPending);
        this.aidPending = null;
        if (this.pmLocked || !this.segValid) {
            this.aid = [];
        } else if (!this.timingFromPm && this.amTrk.valid && sofHere >= 0) {
            const bit = this._predictedPmBit(sofHere);
            if (bit >= 0) this.aidPending = { burst: edge + kPmStartSec * P, sign: bit === 0 ? 1 : -1 };
        }
    }

    // ---- PM held through weak stretches -----------------------------------

    // An unmeasured second, read by early-late at the tracker's prediction.
    // The sign it should have is the predicted bit's when that is known, the
    // correlation's own otherwise.
    _pmNudge(tau, C, snr, sof, P) {
        const tc = kChipSec * P;
        const d = 0.5 * tc;
        const bit = this.polarityKnown ? this._predictedPmBit(sof) : -1;
        const sign = bit >= 0 ? this.polarity * (bit === 0 ? 1 : -1) : C >= 0 ? 1 : -1;
        const E = sign * this._corrAt(tau - d, tc);
        const L = sign * this._corrAt(tau + d, tc);
        if (!(E + L > 0)) { this.pmTrk.update(false, 0, P, tc); return; }
        const eps = clamp(((E - L) / (E + L)) * (tc - d), -d, d);
        const w = Math.min(1, (snr / kPmMinSnr) * (snr / kPmMinSnr));
        this.pmTrk.nudge(tau - eps - kPmStartSec * P, w, this.sr);
    }

    // One tracked second's evidence: its SNR², and the correlation signed so
    // that the burst being there makes it positive, when the bit is known.
    _pushPmEvidence(C, snr, sof) {
        if (C === 0) return;   // nothing correlated: the burst was not in the ring
        const e = { z2: Math.min(snr * snr, kPmEvClip * kPmEvClip), e: 0, known: false };
        const bit = this.polarityKnown ? this._predictedPmBit(sof) : -1;
        if (bit >= 0) {
            e.known = true;
            const sign = (C >= 0 ? 1 : -1) * this.polarity * (bit === 0 ? 1 : -1);
            e.e = sign * Math.min(snr, kPmEvClip);
        }
        this.pmEv.push(e);
        while (this.pmEv.length > kPmHoldWindow) this.pmEv.shift();
    }

    // Whether the weak stretch alone — the last pmMiss seconds, up to thirty —
    // says the burst is still where the tracker has it: known bits summed
    // coherently to 2.5σ, or powers 3.5σ of their chi-square over its mean.
    _pmHoldEvidence() {
        const w = Math.min(this.pmEv.length, Math.min(this.pmMiss, kPmHoldWindow));
        let n = 0;
        let nk = 0;
        let z2 = 0;
        let se = 0;
        for (let i = this.pmEv.length - w; i < this.pmEv.length; i++) {
            ++n;
            z2 += this.pmEv[i].z2;
            if (this.pmEv[i].known) { ++nk; se += this.pmEv[i].e; }
        }
        if (nk >= kPmMissLimit && se / Math.sqrt(nk) >= kPmHoldCoherent) return true;
        return n >= kPmMissLimit && z2 >= n + kPmHoldPowerK * Math.sqrt(2.0 * n);
    }

    // ---- PM acquisition aided by AM ----------------------------------------

    // The PM bit second `sof` carries, when it can be known: −1 otherwise.
    _predictedPmBit(sof) {
        if (sof < 0 || sof > 59) return -1;
        const fixed = pmFixedBit(sof);
        if (fixed >= 0) return fixed;
        return this.codeKnown ? this.codeBits[sof] : -1;
    }

    // Add one AM-framed second to the coherent sum, and lock PM where the sum
    // clears kAidScore. The seconds are filed on a grid of the second PM last
    // tracked (or the nominal one) from the first one summed; what clock error
    // that leaves is searched as slopes within kAidMaxSlope samples a second,
    // and the winner is the period the tracker starts from.
    _aidedAcquire(p) {
        const sr = this.sr;
        const P0 = this.periodKnown ? this.periodLearnt : sr;
        const maxSlope = this.periodKnown ? kAidKnownSlope : kAidMaxSlope;
        const W = lround(kAidHalfSec * sr);
        if (this.aid.length) {
            const j = (p.burst - this.aidE0) / P0;
            if (Math.abs(p.burst - (this.aidE0 + Math.round(j) * P0)) > kAidDriftSec * sr
                || lround(j) - this.aid[0].j > kAidSpanSeconds) this.aid = [];
        }
        if (!this.aid.length) { this.aidE0 = p.burst; this.aidP0 = P0; }
        if (P0 !== this.aidP0) { this.aid = []; this.aidE0 = p.burst; this.aidP0 = P0; }
        const j = lround((p.burst - this.aidE0) / P0);
        const base = lround(this.aidE0 + j * P0) - W;
        const tc = kChipSec * P0;
        if (!this._burstInRing(base, tc) || !this._burstInRing(base + 2 * W, tc)) return;

        const n = 2 * W + 1;
        const c = new Float64Array(n);
        const sq = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            c[i] = this._corrAt(base + i, tc);
            sq[i] = c[i] * c[i];
        }
        const sigma = Math.sqrt(Math.max(1e-30, sq.slice().sort()[n >> 1] / 0.455));
        const v = new Float32Array(n);
        for (let i = 0; i < n; i++) v[i] = clamp((p.sign * c[i]) / sigma, -kAidClip, kAidClip);
        this.aid.push({ j, v });
        while (this.aid.length > kAidSeconds) this.aid.shift();
        if (this.aid.length < kAidMinSeconds) return;

        // Indexed at the newest second: slope d puts an older second's burst d
        // samples a second earlier in its own window.
        const last = this.aid[this.aid.length - 1].j;
        const span = last - this.aid[0].j;
        const step = span > 0 ? Math.min(maxSlope, 1.0 / span) : maxSlope;
        const margin = Math.ceil(maxSlope * span) + 1;
        const root = Math.sqrt(this.aid.length);
        const S = new Float64Array(n);
        let best = -1;
        let bestScore = 0;
        let bestSlope = 0;
        let bestS = null;
        for (let d = -maxSlope; d <= maxSlope + 1e-9; d += step) {
            S.fill(0);
            for (const e of this.aid) {
                const sh = lround(d * (e.j - last));
                for (let i = margin; i <= 2 * W - margin; i++) S[i] += e.v[i + sh];
            }
            // A positive sum is a 0 bit reading positive: polarity +1. Once
            // the polarity is known, only a sum the right way round counts.
            for (let i = margin; i <= 2 * W - margin; i++) {
                const val = S[i];
                const sc = (this.polarityKnown ? this.polarity * val : Math.abs(val)) / root;
                if (sc > bestScore) { bestScore = sc; best = i; bestSlope = d; bestS = S.slice(); }
            }
        }
        if (best < 0 || bestScore < kAidScore) return;
        const sign = bestS[best] >= 0 ? 1 : -1;

        // Early-late on the sum, half a chip either side, as refine() does.
        let frac = 0;
        const h = lround(0.5 * tc);
        if (best - h >= margin && best + h <= 2 * W - margin) {
            const E = sign * bestS[best - h];
            const L = sign * bestS[best + h];
            if (E + L > 0) frac = -clamp(((E - L) / (E + L)) * (tc - h), -0.5 * h, 0.5 * h);
        }
        const tau = base + best + frac;
        const P = P0 + bestSlope;

        this.aid = [];
        this._pmLockAt(tau, P);
        if (!this.pmLocked) return;   // refused (pmLockAt)
        if (!this.polarityKnown) { this.polarity = sign; this.polarityKnown = true; }
        // The tracker starts from the burst and the second's length the sum
        // measured, at the second just processed (one after this burst), worth
        // as many floor-level measurements as its SNR is floors squared.
        this.pmTrk.update(true, tau + P - kPmStartSec * P, P, kChipSec * P);
        this.pmTrk.count = clamp(Math.trunc((bestScore / kPmMinSnr) * (bestScore / kPmMinSnr)), 1, kTrkWarm);
        ++this.pmAidedLocks;
    }

    // ---- sync & frames ---------------------------------------------------

    _pmBitOf(r) { return r.pmSign * this.polarity > 0 ? 0 : 1; }

    // The last sixteen seconds read, through PM, as s59 s0..s14 — this second
    // being s14. Sixteen bits decided together, so judged together: every one
    // read and the right way round, and their MEAN at the agreement level.
    _pmSyncHere() {
        const hist = this.hist;
        if (hist.length < 16) return false;
        const base = hist.length - 16;   // s59
        const matches = (pol) => {
            let sum = 0;
            for (let j = 0; j < 16; j++) {
                const h = hist[base + j];
                if (h.pmSign === 0 || h.pmConf < kPmBitMinConf) return false;
                const sof = j === 0 ? 59 : j - 1;
                const bit = h.pmSign * pol > 0 ? 0 : 1;
                if (bit !== pmFixedBit(sof)) return false;
                sum += h.pmConf;
            }
            return sum >= 16 * kPmSyncConf;
        };
        const s59 = hist[base];
        if (s59.amConf >= kSyncConf && s59.am !== SYMBOL.MARKER) return false;
        if (this.polarityKnown) return matches(this.polarity);
        for (const pol of [1, -1]) {
            if (matches(pol)) { this.polarity = pol; this.polarityKnown = true; return true; }
        }
        return false;
    }

    // This second had no cut, clearly, and the one before did.
    _amMarkerHere() {
        if (this.hist.length < 2 || !this._haveContrast()) return false;
        const cur = this.hist[this.hist.length - 1];
        const prev = this.hist[this.hist.length - 2];
        return cur.am === SYMBOL.MARKER && cur.amConf >= kSyncConf
            && prev.am !== SYMBOL.MARKER && prev.amConf >= kSyncConf;
    }

    _dropAnchor() {
        this.anchored = false;
        this.sofNext = 0;
        this.leapMinute = false;
        this.leapInserted = false;
        this.lastLeapWarn = false;
        this.haveVoted = false;
        this.haveLastFrame = false;
        this.voter.reset();
        this.frame = Array.from({ length: 60 }, emptyRec);
        this.frFilled = 0;
        this.frStart = 0;
        this.frStartExact = 0;
        this.unconfirmedRun = 0;
        this.structFaults = 0;
        this.codeKnown = false;
        this.codeS0UtcMs = 0;
        this.codeBits = null;
    }

    _demote() {
        this.haveVoted = false;
        if (this.lockState === LOCK.LOCKED) this._setLockState(LOCK.ACQUIRING);
    }

    _handleSecond(r, measured) {
        let sof = -1;
        let record = false;
        if (!this.anchored) {
            if (this._pmSyncHere()) {
                this.anchored = true;
                sof = 14;
                this.sofNext = 15;
                const s0 = this.hist.length - 15;
                this.frStart = this.hist[s0].edge;
                this.frStartExact = this.hist[s0].edgeExact;
                this.frFilled = 0;
                for (let s = 0; s < 14; s++) { this.frame[s] = this.hist[s0 + s]; ++this.frFilled; }
                record = true;
            } else if (this._amMarkerHere()) {
                this.anchored = true;
                sof = 59;          // of a minute not recorded; the next is s0
                this.sofNext = 0;
            }
        } else {
            sof = this.sofNext;
            if (sof === 0) { this.frStart = r.edge; this.frStartExact = r.edgeExact; this.frFilled = 0; }
            if (this.lockState === LOCK.LOCKED) this._checkStructure(r, sof);
            if (sof === 60) {
                this.leapInserted = true;       // the minute just ended ran 61 s
                this.sofNext = 0;
            } else {
                record = true;
                this.sofNext = sof + 1;
            }
        }

        this._emitSecond(r, measured, sof);

        if (record) {
            this.frame[sof] = r;
            ++this.frFilled;
            if (sof === 58) this.leapMinute = this._tentativeLeapMinute();
            if (sof === 59) {
                this._finalizeFrame();
                if (this.anchored) this.sofNext = this.leapMinute ? 60 : 0;
            }
        }

        if (this.lockState === LOCK.LOCKED && this.haveVoted && this.haveTimeFrame) {
            const utcMs = composeUtc(this.voted, r.edge, this.timeFrameStart, this.sr);
            if (utcMs !== null) {
                this.events.push({ type: 'time', utcMs, edge: r.edgeExact, quality: this.votedQuality, sof });
            }
        }
    }

    // Symbols that contradict the minute's skeleton mean the count of seconds
    // has slipped. Stop certifying once two have in one minute; s59 decides.
    _checkStructure(r, sof) {
        if (sof === 0) this.structFaults = 0;
        if (this._haveContrast() && r.amConf >= kStructConf) {
            const expectMark = (sof === 59 && !this.leapMinute) || sof === 60;
            if ((r.am === SYMBOL.MARKER) !== expectMark) ++this.structFaults;
        }
        const fixed = pmFixedBit(sof);
        if (this.polarityKnown && fixed >= 0 && r.pmSign !== 0 && r.pmConf >= kPmStructConf
            && this._pmBitOf(r) !== fixed) ++this.structFaults;
        if (this.structFaults >= kMaxStructFaults) this._demote();
    }

    // ---- the time code ---------------------------------------------------

    /** [bit, conf] of a second through one demodulator, or null when it is not read. */
    _bitOf(r, src) {
        if (src === SRC_PM) {
            if (r.pmSign === 0 || !this.polarityKnown || r.pmConf < kPmBitMinConf) return null;
            return [this._pmBitOf(r), r.pmConf];
        }
        if (r.am !== SYMBOL.ZERO && r.am !== SYMBOL.ONE) return null;
        if (r.amConf < kAmBitMinConf) return null;
        return [r.am === SYMBOL.ONE ? 1 : 0, r.amConf];
    }

    _decode(src) {
        const b = new Array(60).fill(0);
        for (let s = 15; s <= 58; s++) {
            const x = this._bitOf(this.frame[s], src);
            if (!x) return null;
            b[s] = x[0];
        }
        const d = decodeLegalMinute((s) => b[s]);
        if (!d) return null;
        d.leapWarn = b[19] === 1;
        return d;
    }

    // The minute's time code is complete at s58. Whether it is the minute a
    // leap second closes decides what s59 and s60 should look like.
    _tentativeLeapMinute() {
        const d = this._decode(SRC_PM) || this._decode(SRC_AM);
        return !!d && d.leapWarn && leapSecondPossibleUtc(d.utc);
    }

    // Which way round the PM reads, from the sixteen bits every minute carries
    // regardless of the time — needed when AM found the minute first.
    _learnPolarity() {
        if (this.polarityKnown) return;
        for (const pol of [1, -1]) {
            let match = 0;
            let miss = 0;
            for (let s = 0; s < 60; s++) {
                const r = this.frame[s];
                const fixed = pmFixedBit(s);
                if (fixed < 0 || r.pmSign === 0 || r.pmConf < kPmSyncConf) continue;
                if ((r.pmSign * pol > 0 ? 0 : 1) === fixed) match++; else miss++;
            }
            if (match >= 14 && miss === 0) { this.polarity = pol; this.polarityKnown = true; return; }
        }
    }

    _finalizeFrame() {
        this._learnPolarity();

        // ---- is the minute where we think it is? -------------------------
        //
        // Settled by where the minute's two fixed features fall: AM's marker at
        // s59 and PM's sync word in s59 and s0–s14. CONFIRMED when a feature is
        // where it belongs; CONTRADICTED when one is confidently somewhere it
        // does not belong and nothing confirms; otherwise UNCONFIRMED — faded,
        // not wrong. A stray marker elsewhere with s59 confidently the marker is
        // one misread second, not a slip.
        let pmMatch = 0;
        let pmMismatch = 0;
        let amStrayMarks = 0;
        for (let s = 0; s < 59; s++) {
            const r = this.frame[s];
            const fixed = pmFixedBit(s);
            if (this.polarityKnown && fixed >= 0 && r.pmSign !== 0) {
                if (this._pmBitOf(r) === fixed) { if (r.pmConf >= kPmSyncConf) ++pmMatch; }
                else if (r.pmConf >= kPmStructConf) ++pmMismatch;
            }
            if (r.amConf >= kStructConf && r.am === SYMBOL.MARKER) ++amStrayMarks;
        }
        const s59 = this.frame[59];
        if (this.polarityKnown && s59.pmSign !== 0) {
            if (this._pmBitOf(s59) === pmFixedBit(59)) { if (s59.pmConf >= kPmSyncConf) ++pmMatch; }
            else if (s59.pmConf >= kPmStructConf) ++pmMismatch;
        }
        // A leap minute's s59 is an ordinary 0 and its marker comes at s60.
        const s59Expect = this.leapMinute ? SYMBOL.ZERO : SYMBOL.MARKER;
        const s59Read = s59.amConf >= kStructConf && s59.am !== SYMBOL.UNKNOWN;
        const amStrong = s59Read && s59.am === s59Expect;
        const pmStrong = pmMatch >= 12 && pmMismatch === 0;
        const s59Wrong = s59Read && (s59.am === SYMBOL.MARKER) !== (s59Expect === SYMBOL.MARKER);
        const amContra = s59Wrong || (!amStrong && amStrayMarks > 0);
        const pmContra = pmMismatch > 0;
        const contradicted = (amContra && !pmStrong) || (pmContra && !amStrong);
        const confirmed = this.frFilled >= 60 && (amStrong || pmStrong) && !contradicted;
        if (contradicted || this.frFilled < 60
            || (!confirmed && ++this.unconfirmedRun > kMaxUnconfirmedMinutes)) {
            this._dropAnchor();
            this._demote();
            return;
        }
        if (confirmed) this.unconfirmedRun = 0;

        // ---- the time, twice ---------------------------------------------
        //
        // Not read from an unconfirmed minute: it goes to the voter empty,
        // which keeps the voter's run of consecutive minutes intact.
        const pm = confirmed ? this._decode(SRC_PM) : null;
        const am = confirmed ? this._decode(SRC_AM) : null;
        this.prevFrameFrom = this.lastFrameFrom;
        let use = null;
        let both = false;
        if (pm && am) {
            if (pm.utcMs === am.utcMs && pm.leapWarn === am.leapWarn) { use = pm; both = true; this.lastFrameFrom = 3; }
            else this.lastFrameFrom = 4;       // two valid decodes that disagree
        } else if (pm) { use = pm; this.lastFrameFrom = 2; }
        else if (am) { use = am; this.lastFrameFrom = 1; }
        else this.lastFrameFrom = 0;

        // What the next minute will carry, from this one or, when this one
        // was not read, from the last that was.
        if (use || this.codeKnown) {
            this.codeS0UtcMs = use ? use.utcMs + 60000 : this.codeS0UtcMs + 60000;
            this.codeKnown = true;
            this.codeBits = predictTimeCode(this.codeS0UtcMs);
        }

        let fields = null;
        let confOf = 0;
        let cUtcDate = 0;
        if (use) {
            // Confidence of a group of bits: its weakest, from whichever
            // demodulator the minute was taken from — the stronger of the two
            // when both agreed.
            const groupConf = (a, z) => {
                let c = 1;
                for (let s = a; s <= z; s++) {
                    const r = this.frame[s];
                    const hp = this._bitOf(r, SRC_PM);
                    const ha = this._bitOf(r, SRC_AM);
                    const cp = hp ? hp[1] : 0;
                    const ca = ha ? ha[1] : 0;
                    c = Math.min(c, both ? Math.max(cp, ca) : use === pm ? cp : ca);
                }
                return c;
            };
            const cMin = groupConf(21, 28);
            const cHour = groupConf(29, 35);
            const cDate = groupConf(36, 58);
            const cZone = groupConf(17, 18);
            // UTC's minute moves with the minute field alone (zones are whole
            // hours); its hour with the zone and a borrow from the minute; the
            // date with everything.
            const cUtcHour = Math.min(cMin, cHour, cZone);
            cUtcDate = Math.min(cMin, cHour, cZone, cDate);
            const byField = { minute: cMin, hour: cUtcHour, doy: cUtcDate, year2: cUtcDate };
            confOf = (f) => byField[f];
            fields = use.utc;
        }
        const syn = syntheticFrame(fields, confOf);
        this.timeFrameStart = this.frStart;
        this.haveTimeFrame = true;
        if (use) {
            this.frames++;
            this.events.push({
                type: 'frame', utcMs: use.utcMs, startEdge: this.frStartExact, confidence: cUtcDate,
                dut1Tenths: null, summer: use.cest, leapPending: use.leapWarn,
            });
        }

        const P = this._period();
        const gap = (this.leapInserted ? 61.0 : 60.0) * P;
        this.leapInserted = false;
        const consecutive = this.haveLastFrame && Math.abs(this.frStart - this.lastFrameStart - gap) <= 0.25 * this.sr;
        if (!consecutive) this.voter.reset();
        this.haveLastFrame = true;
        this.lastFrameStart = this.frStart;
        this.voter.addFrame(syn.symbols, syn.conf);

        const certified = this.voter.locked();
        if (certified) {
            this.voted = this.voter.resolve().value;
            this.votedQuality = this.voter.lockConfidence();
        }

        // The leap second, if this minute ends with one, is the second after
        // s59, and every second from it would be dated one early by counting
        // whole seconds from this frame. Stop certifying before it goes out.
        const leapNext = this.leapMinute || (!!use && (use.leapWarn || this.lastLeapWarn) && leapSecondPossibleUtc(use.utc));
        this.lastLeapWarn = !!use && use.leapWarn;

        if (certified && confirmed && !leapNext) {
            this.haveVoted = true;
            this._setLockState(LOCK.LOCKED);
        } else {
            this._demote();
        }
    }

    // ---- events & state ----------------------------------------------------

    _emitSecond(r, measured, sof) {
        this.events.push({
            type: 'second', edge: r.edgeExact, measured, servable: this.timingFromPm,
            symbol: r.am, conf: r.amConf, sof,
        });
    }

    _setLockState(s) { this.lockState = s; }
}

export const DCF77_CHIP_SEC = kChipSec;
export const DCF77_PM_START_SEC = kPmStartSec;
export { pmFixedBit };
