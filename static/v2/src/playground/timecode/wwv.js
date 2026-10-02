// WWV/WWVH: ubersdr-ntp's WwvDecoder (src/clock/WwvDecoder.cpp), ported
// sample for sample, with the composition of UTC that Source.cpp does around
// it (onClockTime). Format facts per NIST SP 432.
//
// Per input sample of complex baseband at 12 kHz:
//
//   carrier search   DFT bins across ±50 Hz of the expected offset on a 600 Hz
//                    decimation, every 2 s until the carrier stands out; then
//                    the mixer goes there and follows it.
//   reference        a 15 Hz low-pass of the mixed baseband, and the baseband
//                    delayed by that low-pass's group delay, so the reference
//                    is the carrier's phase AT the sample it is compared with.
//   coherent AM      m = Re(z·conj(c)) / <|c|²>; the quadrature rail carries no
//                    AM and is how the noise under m is measured.
//
// Then, from m: the seconds tick (5 ms of 1000 Hz for WWV, 1200 Hz for WWVH)
// correlated against its own waveform and averaged coherently second to second
// (TickTimer) — the edge served; tick-band envelopes folded mod 1 s, which cut
// the seconds and tag the station; and the 100 Hz BCD subcarrier, demodulated
// coherently to a 200 Hz series, read each second by matched filter, framed by
// the markers and the s0 hole, and voted across minutes.
//
// Instants are input sample indices. The tick's correlation peak is the start
// of the tick, which is where NIST puts the second, so no bias is taken off
// (Source.cpp's kWwvResidualSec is 0).

import { Biquad, Cascade, median } from './dsp.js';
import { utcFromFields, fieldsFromUtc, fieldsValid, leapSecondPossible as leapAfter, civilFromDays, daysInMonth } from './civil.js';
import { TimeFrameVoter, WWV_MAP } from './voter.js';

const SERIES_RATE = 200;            // the decimated series, Hz
const SEC_LEN = SERIES_RATE;        // series samples a second
const FRAME_SECS = 60;

// Each second's window is cut 50 ms before the tick, so the pulse's
// matched-filter shift sits mid-range with room both ways for clock drift.
const WINDOW_LEAD = 10;
// The shift a clean, drift-free stream settles at: the lead plus the 25 Hz
// low-pass and decimation (about 20 ms).
const NOMINAL_DELAY = WINDOW_LEAD + 4;
// What the BCD edge takes off the smoothed shift to land a synthetic pulse on
// its second. Only the BCD check uses it; nothing served depends on it.
const BCD_EDGE_DELAY = 3.52;
// Matched-filter shift ceiling (200 ms): wide so slow drift is absorbed by the
// tracked delay; beyond the rails is a soft resynchronisation.
const MAX_SHIFT = 40;

// The tick fold forgets (τ ≈ 100 s) so a re-seed finds the current phase.
const FOLD_DECAY = 0.99;
const FOLD_Z = 10;
const FOLD_Z_MIN_SECS = 10;

// Station tag: one band's folded tick excess this many times the other's to
// decide; a lower ratio still supports an established tag, so a signal near
// the line does not flap.
const STATION_EXCESS_RATIO = 1.5;
const STATION_HOLD_RATIO = 1.2;
const STATION_WARM_SECS = 20;
const STATION_CONFIRM_SECS = 10;
const STATION_SWITCH_SECS = 30;
const STATION_RELEASE_SECS = 120;

// The smoothed sub-sample matched shift behind the BCD edge: a running mean for
// the first seconds, then an EMA; a shift far from it is a misfit.
const EDGE_DELAY_ALPHA = 1 / 16;
const EDGE_DELAY_WARM = 8;
const EDGE_DELAY_GATE = 3;

// A second times only if it carried a pulse (the minute hole averages ~0).
const PULSE_ENERGY_FRAC = 0.05;
// The margin one second needs to count as evidence of a slipped alignment.
const STRUCT_CONF = 0.10;

const isMarkerSec = (s) => s % 10 === 9;

// Carrier: WWV's is atomic, so only the receiver's clock moves it (2 ppm at
// 25 MHz is 50 Hz); further out the subcarrier's sidebands start to show.
const PULL_HZ = 50;
const SEARCH_STEP = 0.25;
const SEARCH_RATE = 600;
const SEARCH_SEC = 2;
const TONE_GATE = 12;               // carrier bin over the median bin, power
const RESEARCH_SEC = 60;            // a carrier with no tick this long was not one
const REF_HZ = 15;
const FREQ_GAIN = 0.2;
const LEVEL_SEC = 10;
const NOISE_SEC = 10;
const DC_SEC = 1;
const BCD_PHASE_SEC = 20;

// Tick timer.
const TICK_SEC = 0.005;
const TICK_TRACK_SEC = 0.015;
const TICK_ACQ_SEC = 0.030;
const TICK_ALPHA = 1 / 16;
const TICK_LOCK_SNR = 25;
const TICK_HOLD_SNR = 10;
const TICK_MISS_LIMIT = 10;
const TICK_MIN_SECS = 8;
const TICK_RATE_SECS = 120;
const TICK_RATE_MIN = 10;
const TICK_MAX_STEP = 3;
const TICK_STEP_ALPHA = 0.5;
const TICK_MAX_PPM = 200;
// Correlation still this strong 10–20 ms after the edge (NIST's protected
// zone) is the 800 ms minute tone, not a tick.
const TONE_RATIO = 0.3;
// A real tick's average stands alone: its apex this far above anything 1.5
// tick lengths away.
const TICK_ISOLATION = 4;
const BCD_CHECK_ALPHA = 1 / 32;

const SYMBOL_NAMES = ['zero', 'one', 'marker'];

const fround = Math.fround;

/** Whether Unix ms `ms` falls on the last day of its month. */
function isLastDayOfMonth(ms) {
    const { y, m, d } = civilFromDays(Math.floor(ms / 86400000));
    return d === daysInMonth(y, m);
}

/** The UTC midnight after `ms` when `ms` is on a month's last day (where a leap second can go), else -1. */
function leapBoundaryAfter(ms) {
    if (!isLastDayOfMonth(ms)) return -1;
    return (Math.floor(ms / 86400000) + 1) * 86400000;
}

/**
 * One station's seconds tick, timed. The 5 ms burst correlated against
 * e^{-jωt} gives a 10 ms triangle whose apex is the start of the burst; each
 * second's profile is taken relative to the prediction x to a fraction of a
 * sample, averaged coherently, and its apex found by intersecting a line fitted
 * to each side. The same lags against the other station's tick tell a leaked
 * bump of it from this one. Complex arrays are interleaved re, im.
 */
class TickTimer {
    constructor(hz, other, fs) {
        this.hz = hz;
        this.w = (2 * Math.PI * hz) / fs;
        this.wo = (2 * Math.PI * other) / fs;
        this.L = Math.round(TICK_SEC * fs);
        this.W = Math.round(TICK_TRACK_SEC * fs);
        this.Wacq = Math.round(TICK_ACQ_SEC * fs);
        const L = this.L;
        this.tplR = new Float64Array(L + 1); this.tplI = new Float64Array(L + 1);
        this.tplOR = new Float64Array(L + 1); this.tplOI = new Float64Array(L + 1);
        for (let t = 0; t <= L; t++) {
            this.tplR[t] = Math.cos(-this.w * t); this.tplI[t] = Math.sin(-this.w * t);
            this.tplOR[t] = Math.cos(-this.wo * t); this.tplOI[t] = Math.sin(-this.wo * t);
        }
        const len = 2 * (2 * this.Wacq + 1);
        this.avg = new Float64Array(len);
        this.cur = new Float64Array(len);
        this.avgO = new Float64Array(len);
        this.curO = new Float64Array(len);
        this.nominal = fs;
        this.period = fs;
        this.x = 0;
        this.tickCount = 0;
        this.edge = 0;
        this.reset();
    }

    reset() {
        this.avg.fill(0);
        this.avgO.fill(0);
        this.varAvg = 0; this.n = 0; this.active = false; this.locked = false; this.miss = 0; this.snr = 0; this.stepRef = 0;
        this.hist = [];
        this.period = this.nominal;
    }

    /** Index of lag l's real part in a profile. */
    ix(l) { return (l + this.Wacq) * 2; }

    norm(v, l) { const i = this.ix(l); return v[i] * v[i] + v[i + 1] * v[i + 1]; }

    /** Move the average by e samples: avg(l) ← avg(l + e), taken off its carrier ramp so interpolation is exact along each side. */
    shift(e) {
        if (e === 0) return;
        this.avg = this.shiftOne(this.avg, this.w, e);
        this.avgO = this.shiftOne(this.avgO, this.wo, e);
    }

    shiftOne(v, wr, e) {
        const Wa = this.Wacq;
        const out = new Float64Array(v.length);
        for (let l = -Wa; l <= Wa; l++) {
            const s = l + e;
            const i0 = Math.floor(s);
            const f = s - i0;
            if (i0 < -Wa || i0 + 1 > Wa) continue;
            const a = this.ix(i0);
            const b = this.ix(i0 + 1);
            const c0 = Math.cos(-wr * i0); const s0 = Math.sin(-wr * i0);
            const c1 = Math.cos(-wr * (i0 + 1)); const s1 = Math.sin(-wr * (i0 + 1));
            const b0r = v[a] * c0 - v[a + 1] * s0; const b0i = v[a] * s0 + v[a + 1] * c0;
            const b1r = v[b] * c1 - v[b + 1] * s1; const b1i = v[b] * s1 + v[b + 1] * c1;
            const ir = (1 - f) * b0r + f * b1r; const ii = (1 - f) * b0i + f * b1i;
            const cs = Math.cos(wr * s); const sn = Math.sin(wr * s);
            const o = this.ix(l);
            out[o] = ir * cs - ii * sn;
            out[o + 1] = ir * sn + ii * cs;
        }
        return out;
    }
}

export class WwvDecoder {
    /**
     * @param {object} o
     * @param {number} [o.sampleRate=12000] must be a multiple of 200 (the BCD series rate)
     * @param {number} [o.carrierOffsetHz=0] where the carrier sits in the baseband
     * @param {function|null} [o.referenceNow] Unix ms now, for the voter's ±1 day plausibility gate
     * @param {'auto'|'wwv'|'wwvh'} [o.station='auto'] pin the tag instead of judging it
     * @param {number} [o.dialHz] the dial; on 20 or 25 MHz (carriers only WWV uses) the tag is pinned to WWV
     */
    constructor({ sampleRate = 12000, carrierOffsetHz = 0, referenceNow = null, station = 'auto', dialHz = null } = {}) {
        if (!(sampleRate > 0) || sampleRate % SERIES_RATE !== 0) {
            throw new Error(`WwvDecoder: sample rate ${sampleRate} Hz is not a multiple of ${SERIES_RATE} Hz (the BCD series rate)`);
        }
        this.fs = sampleRate;
        this.decim = Math.max(1, sampleRate / SERIES_RATE);
        this.fNominal = carrierOffsetHz;
        this.voter = new TimeFrameVoter({
            fields: WWV_MAP, window: 8, minFramesForLock: 2, agingFactor: fround(0.9),
            minBitConfidence: fround(0.05), minLockQuality: fround(0.05),
        });
        // Source.cpp arms the plausibility gate from the host clock at a day.
        if (typeof referenceNow === 'function') this.voter.setPlausibility(() => fieldsFromUtc(referenceNow()), 24 * 60);

        // The tag: pinned by option, or by a carrier only WWV transmits on.
        this.stationPinned = false;
        this.pinnedStation = null;
        const carrierHz = dialHz != null ? dialHz + carrierOffsetHz : null;
        if (station === 'wwv' || station === 'wwvh') {
            this.stationPinned = true;
            this.pinnedStation = station === 'wwv' ? 'WWV' : 'WWVH';
        } else if (carrierHz != null && (Math.abs(carrierHz - 20e6) <= PULL_HZ || Math.abs(carrierHz - 25e6) <= PULL_HZ)) {
            this.stationPinned = true;
            this.pinnedStation = 'WWV';
        }

        this.designFilters();
        this.buildTemplates();
        this.reset();
    }

    designFilters() {
        const fs = this.fs;
        const lp25 = () => Biquad.lowpass(25, fs, 0.70710678);
        this.lpI = Cascade.repeat(lp25, 2);
        this.lpQ = Cascade.repeat(lp25, 2);
        // Tick bands 167 Hz wide, so 1000 and 1200 Hz separate.
        this.bpTickV = Cascade.repeat(() => Biquad.bandpass(1000, fs, 6.0), 2);
        this.bpTickH = Cascade.repeat(() => Biquad.bandpass(1200, fs, 7.2), 2);
        const dth = (2 * Math.PI * 100) / fs;
        this.rotC = Math.cos(dth);
        this.rotS = Math.sin(dth);

        // The carrier reference, and the delay that brings z level with it.
        this.refI = Cascade.butter4(REF_HZ, fs);
        this.refQ = Cascade.butter4(REF_HZ, fs);
        this.refDelay = Math.round(this.refI.dcDelay());
        let zn = 1;
        while (zn < this.refDelay + 2) zn <<= 1;
        this.zR = new Float64Array(zn); this.zI = new Float64Array(zn);
        this.zMask = zn - 1;

        // m kept 2.5 s back: a second is timed once its whole window is in.
        let mn = 1;
        while (mn < 2.5 * fs) mn <<= 1;
        this.mRing = new Float64Array(mn);
        this.mMask = mn - 1;

        this.aLevel = 1 / (LEVEL_SEC * fs);
        this.aNoise = 1 / (NOISE_SEC * fs);
        this.aDc = 1 / (DC_SEC * fs);
        this.aBcdPhase = 1 / (BCD_PHASE_SEC * SERIES_RATE);

        this.searchDecim = Math.max(1, Math.floor(fs / SEARCH_RATE));
        const sdth = (-2 * Math.PI * this.fNominal) / fs;
        this.sStepR = Math.cos(sdth); this.sStepI = Math.sin(sdth);
        this.searchLen = SEARCH_SEC * SEARCH_RATE;
        this.searchR = new Float64Array(this.searchLen);
        this.searchI = new Float64Array(this.searchLen);

        this.timerV = new TickTimer(1000, 1200, fs);
        this.timerH = new TickTimer(1200, 1000, fs);
    }

    buildTemplates() {
        // Zero-mean templates: pulse from +30 ms, 170 / 470 / 770 ms (NIST SP 432).
        const s0 = Math.round(0.030 * SERIES_RATE);
        this.tpl = [170, 470, 770].map((ms) => {
            const t = new Float64Array(SEC_LEN);
            const len = Math.round((ms / 1000) * SERIES_RATE);
            for (let i = s0; i < s0 + len && i < SEC_LEN; i++) t[i] = 1;
            let mean = 0;
            for (const v of t) mean += v;
            mean /= SEC_LEN;
            for (let i = 0; i < SEC_LEN; i++) t[i] = fround(t[i] - mean);
            return t;
        });
        this.tplNorm = this.tpl.map((t) => fround(Math.sqrt(t.reduce((a, v) => a + v * v, 0))));
    }

    setMixer(f) {
        this.f0 = Math.min(this.fNominal + PULL_HZ, Math.max(this.fNominal - PULL_HZ, f));
        this.stepR = Math.cos((-2 * Math.PI * this.f0) / this.fs);
        this.stepI = Math.sin((-2 * Math.PI * this.f0) / this.fs);
    }

    reset() {
        this.lpI.reset(); this.lpQ.reset(); this.bpTickV.reset(); this.bpTickH.reset();
        this.refI.reset(); this.refQ.reset();
        this.oscC = 1; this.oscS = 0; this.oscRenorm = 0;
        this.accI = 0; this.accQ = 0; this.accTickV = 0; this.accTickH = 0; this.decCount = 0; this.n200 = 0;
        this.carrierFound = false; this.carrierFoundAt = 0; this.carrierSnrDb = NaN;
        this.sAccR = 0; this.sAccI = 0; this.sAccN = 0; this.sOscR = 1; this.sOscI = 0; this.sRenorm = 0; this.searchN = 0;
        this.oscR = 1; this.oscI = 0; this.oscRenormZ = 0; this.setMixer(this.fNominal);
        this.zR.fill(0); this.zI.fill(0); this.mRing.fill(0);
        this.mHead = -1; this.level = 0; this.qVar = 0; this.mDc = 0; this.freqCount = 0; this.freqPrevR = 0; this.freqPrevI = 0;
        this.bcdPhaseR = 0; this.bcdPhaseI = 0;
        this.timerV.reset(); this.timerH.reset(); this.timerV.tickCount = 0; this.timerH.tickCount = 0;
        this.tickTiming = false;
        this.bcdMinusTick = NaN; this.bcdCheckN = 0;
        this.foldV = new Float64Array(SEC_LEN); this.foldH = new Float64Array(SEC_LEN);
        this.tickLocked = false; this.tickPhase = 0; this.tickLockJ = 0;
        this.pendingStation = null; this.pendingCount = 0; this.stationContrary = 0; this.stationUnsupported = 0; this.tickExcessRatio = 0;
        this.delayEst = NOMINAL_DELAY; this.delayLocked = false; this.delayCount = 0;
        this.edgeDelayEst = NOMINAL_DELAY; this.edgeDelayCount = 0; this.edgeDelayRejects = 0;
        this.badFrameStreak = 0;
        this.suspectSec = -1; this.lastRealignK = -1; this.haveLastFields = false; this.lastFields = null; this.lastLeapWarn = false;
        this.curR = new Float64Array(SEC_LEN); this.curI = new Float64Array(SEC_LEN);
        this.curFill = 0; this.secStarted = false; this.secStartJ = 0; this.aScale = 1e-6;
        this.recs = []; this.recBase = 0; this.secIndex = 0;
        this.anchored = false; this.anchorSec0 = 0; this.nextFrameStartK = 0;
        this.lastEdgeSample = 0; this.lastEdgeSampleExact = NaN; this.lastEdgeSecondOfFrame = -1;
        this.station = this.stationPinned ? this.pinnedStation : null;
        this.samplesConsumed = 0;
        this.voter.reset();
        this.state = 'nosignal';
        // Source.cpp's side: the frame a `time` is composed against.
        this.frameStartSample = 0; this.haveFrame = false;
        this.events = [];
    }

    process(re, im, n = re.length) {
        for (let i = 0; i < n; i++) this.processSample(re[i], im[i]);
    }

    drain() {
        const out = this.events;
        this.events = [];
        return out;
    }

    status() {
        const tt = this.timingTimer();
        const tickSnrDb = tt.n > 0 && tt.snr > 0 ? 10 * Math.log10(tt.snr) : null;
        const foldRatio = (fold) => {
            let peak = 0; let sum = 0;
            for (let p = 0; p < SEC_LEN; p++) { sum += fold[p]; if (fold[p] > peak) peak = fold[p]; }
            const mean = sum / SEC_LEN;
            return mean > 0 ? peak / mean : 0;
        };
        const ratio = Math.max(foldRatio(this.foldV), foldRatio(this.foldH));
        const carrierOffsetHz = this.carrierFound ? this.f0 - this.fNominal : null;
        const v = this.voter.verdict();
        const refusal = v.locked ? null : v.reason;
        const carrierSnrDb = Number.isFinite(this.carrierSnrDb) ? this.carrierSnrDb : null;
        return {
            state: this.state,
            station: this.station,
            snrDb: tickSnrDb != null ? tickSnrDb : carrierSnrDb,
            carrierOffsetHz,
            refusal,
            frames: this.voter.frameCount(),
            detail: {
                toneSnrDb: ratio > 0 ? 10 * Math.log10(ratio) : 0,
                tickSnrDb,
                tickTiming: this.tickTiming,
                tickLocked: this.tickLocked,
                tickBandRatioDb: this.tickLocked && this.tickExcessRatio > 0 && Number.isFinite(this.tickExcessRatio)
                    ? 10 * Math.log10(this.tickExcessRatio) : null,
                delayEstMs: this.delayLocked ? (this.delayEst * 1000) / SERIES_RATE : null,
                bcdMinusTickMs: Number.isFinite(this.bcdMinusTick) ? (this.bcdMinusTick * 1000) / this.fs : null,
                carrierOffsetHz,
                carrierSnrDb,
                anchored: this.anchored,
                badFrameStreak: this.badFrameStreak,
                framesInWindow: this.voter.frameCount(),
                windowSize: this.voter.cfg.window,
                voteQuality: this.voter.lockConfidence(),
                refusal,
            },
        };
    }

    setState(s) { this.state = s; }

    timingTimer() { return this.station === 'WWVH' ? this.timerH : this.timerV; }

    // The search: the baseband mixed by the nominal offset, block-averaged to
    // 600 Hz, 2 s of that, then DFT bins across ±50 Hz.
    searchStep(xr, xi) {
        const zr = xr * this.sOscR - xi * this.sOscI;
        const zi = xr * this.sOscI + xi * this.sOscR;
        const nr = this.sOscR * this.sStepR - this.sOscI * this.sStepI;
        this.sOscI = this.sOscR * this.sStepI + this.sOscI * this.sStepR;
        this.sOscR = nr;
        if (++this.sRenorm >= 1024) {
            this.sRenorm = 0;
            const m = Math.hypot(this.sOscR, this.sOscI);
            if (m > 0) { this.sOscR /= m; this.sOscI /= m; }
        }
        this.sAccR += zr; this.sAccI += zi;
        if (++this.sAccN < this.searchDecim) return;
        this.searchR[this.searchN] = this.sAccR / this.sAccN;
        this.searchI[this.searchN] = this.sAccI / this.sAccN;
        this.searchN++;
        this.sAccR = 0; this.sAccI = 0; this.sAccN = 0;
        if (this.searchN >= this.searchLen) this.finishSearch();
    }

    finishSearch() {
        const rate = this.fs / this.searchDecim;
        const nb = Math.round((2 * PULL_HZ) / SEARCH_STEP) + 1;
        const pw = new Float64Array(nb);
        let peak = 0;
        for (let b = 0; b < nb; b++) {
            const f = -PULL_HZ + b * SEARCH_STEP;
            const sr = Math.cos((-2 * Math.PI * f) / rate); const si = Math.sin((-2 * Math.PI * f) / rate);
            let rr = 1; let ri = 0; let ar = 0; let ai = 0;
            for (let i = 0; i < this.searchN; i++) {
                const vr = this.searchR[i]; const vi = this.searchI[i];
                ar += vr * rr - vi * ri; ai += vr * ri + vi * rr;
                const t = rr * sr - ri * si; ri = rr * si + ri * sr; rr = t;
            }
            pw[b] = ar * ar + ai * ai;
            if (pw[b] > pw[peak]) peak = b;
        }
        const med = median(pw);
        this.searchN = 0;
        if (med > 0) this.carrierSnrDb = 10 * Math.log10(pw[peak] / med);
        if (!(med > 0) || pw[peak] < TONE_GATE * med) return;
        let f = -PULL_HZ + peak * SEARCH_STEP;
        if (peak > 0 && peak + 1 < nb) {
            const a = Math.sqrt(pw[peak - 1]); const b = Math.sqrt(pw[peak]); const c = Math.sqrt(pw[peak + 1]);
            const den = a - 2 * b + c;
            if (den < 0) f += SEARCH_STEP * Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
        }
        this.setMixer(this.fNominal + f);
        this.carrierFound = true;
        this.carrierFoundAt = this.samplesConsumed;
    }

    processSample(xr, xi) {
        const n = this.samplesConsumed++;
        const fs = this.fs;

        if (!this.carrierFound) this.searchStep(xr, xi);
        else if (!this.timerV.locked && !this.timerH.locked && !this.tickLocked && n - this.carrierFoundAt > RESEARCH_SEC * fs) {
            this.carrierFound = false; // a carrier with no tick after a minute: look again
        }

        // Mixer: the carrier to 0 Hz.
        const zr = xr * this.oscR - xi * this.oscI;
        const zi = xr * this.oscI + xi * this.oscR;
        {
            const nr = this.oscR * this.stepR - this.oscI * this.stepI;
            this.oscI = this.oscR * this.stepI + this.oscI * this.stepR;
            this.oscR = nr;
            if (++this.oscRenormZ >= 1024) {
                this.oscRenormZ = 0;
                const m = Math.hypot(this.oscR, this.oscI);
                if (m > 0) { this.oscR /= m; this.oscI /= m; }
            }
        }

        // The carrier's phase and strength, and z delayed to meet it.
        const cr = this.refI.process(zr);
        const ci = this.refQ.process(zi);
        this.zR[n & this.zMask] = zr;
        this.zI[n & this.zMask] = zi;

        // Follow the carrier: a residual offset shows as the reference turning.
        if (++this.freqCount >= fs) {
            this.freqCount = 0;
            const pr = this.freqPrevR; const pi = this.freqPrevI;
            if (pr * pr + pi * pi > 0 && cr * cr + ci * ci > 0) {
                const dphi = Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi);
                this.setMixer(this.f0 + (FREQ_GAIN * dphi) / (2 * Math.PI));
            }
            this.freqPrevR = cr; this.freqPrevI = ci;
        }

        if (n < this.refDelay) return;
        const di = (n - this.refDelay) & this.zMask;
        const zdr = this.zR[di]; const zdi = this.zI[di];

        // Coherent AM, scaled by the carrier's average power.
        const p = cr * cr + ci * ci;
        const k = n - this.refDelay; // the sample m stands for
        this.level += Math.max(this.aLevel, 1 / (k + 1)) * (p - this.level);
        const inv = this.level > 1e-30 ? 1 / this.level : 0;
        const m = (zdr * cr + zdi * ci) * inv;
        const q = (zdi * cr - zdr * ci) * inv;
        this.qVar += Math.max(this.aNoise, 1 / (k + 1)) * (q * q - this.qVar);
        this.mRing[k & this.mMask] = m;
        this.mHead = k;

        this.processM(k, m);
    }

    processM(k, m) {
        // Coherent 100 Hz demod: m less its mean (the carrier), mixed down,
        // both rails at 25 Hz.
        this.mDc += Math.max(this.aDc, 1 / (k + 1)) * (m - this.mDc);
        const mb = m - this.mDc;
        const i = this.lpI.process(mb * this.oscC);
        const q = this.lpQ.process(mb * this.oscS);
        const nc = this.oscC * this.rotC - this.oscS * this.rotS;
        const ns = this.oscS * this.rotC + this.oscC * this.rotS;
        this.oscC = nc; this.oscS = ns;
        if (++this.oscRenorm >= 1024) {
            this.oscRenorm = 0;
            const r = Math.sqrt(this.oscC * this.oscC + this.oscS * this.oscS);
            if (r > 0) { this.oscC /= r; this.oscS /= r; }
        }

        // Tick rails: bandpass around each station's tick, rectified.
        const tv = this.bpTickV.process(m);
        const th = this.bpTickH.process(m);

        // Block-average to the 200 Hz series.
        this.accI += i; this.accQ += q; this.accTickV += Math.abs(tv); this.accTickH += Math.abs(th);
        if (++this.decCount >= this.decim) {
            const invd = 1 / this.decim;
            const br = this.accI * invd; const bi = this.accQ * invd;
            this.bcdPhaseR += this.aBcdPhase * (br - this.bcdPhaseR);
            this.bcdPhaseI += this.aBcdPhase * (bi - this.bcdPhaseI);
            this.onSeriesSample(br, bi, this.accTickV * invd, this.accTickH * invd);
            this.accI = 0; this.accQ = 0; this.accTickV = 0; this.accTickH = 0;
            this.decCount = 0;
        }
    }

    timeTick(t, windowStart, secOfFrame) {
        // Predict; a timer that has lost the windows (a soft reacquisition cut
        // them somewhere new) starts over from the window.
        if (!t.active || Math.abs(t.x + t.period - windowStart) > 0.25 * this.fs) {
            t.reset();
            t.active = true;
            t.x = windowStart;
        } else {
            t.x += t.period;
        }
        ++t.tickCount; // the slope's time axis: one a second, timed or not

        const L = t.L; const Wa = t.Wacq;
        const R = Math.round(t.x);
        const g = t.x - R;
        if (R - Wa < this.mHead - this.mMask || R + Wa + L + 1 > this.mHead) return; // not in the ring

        // This second's profile, lag l meaning an edge at x + l: the first tap
        // weighted 1/2 − g and one more at L by 1/2 + g, the phase turned by g,
        // so the profile is taken from x exactly.
        const tr = Math.cos(t.w * g); const ti = Math.sin(t.w * g);
        const tor = Math.cos(t.wo * g); const toi = Math.sin(t.wo * g);
        const edgeW = 0.5 + g;
        const mr = this.mRing; const mask = this.mMask;
        const { tplR, tplI, tplOR, tplOI, cur, curO } = t;
        for (let l = -Wa; l <= Wa; l++) {
            const s = R + l;
            let ar = 0; let ai = 0; let or = 0; let oi = 0;
            for (let u = 0; u < L; u++) {
                const v = mr[(s + u) & mask];
                ar += tplR[u] * v; ai += tplI[u] * v;
                or += tplOR[u] * v; oi += tplOI[u] * v;
            }
            const v0 = mr[s & mask]; const vL = mr[(s + L) & mask];
            ar += edgeW * (tplR[L] * vL - v0); ai += edgeW * (tplI[L] * vL);
            or += edgeW * (tplOR[L] * vL - v0); oi += edgeW * (tplOI[L] * vL);
            const ix = t.ix(l);
            cur[ix] = ar * tr - ai * ti; cur[ix + 1] = ar * ti + ai * tr;
            curO[ix] = or * tor - oi * toi; curO[ix + 1] = or * toi + oi * tor;
        }

        // Not a tick: seconds 29 and 59 have none, second 0 is the 800 ms
        // minute tone — known by frame once anchored, and before that by the
        // tone carrying on into the protected zone.
        const lagNoise = L * this.qVar;
        let exclude = this.anchored && (secOfFrame === 0 || secOfFrame === 29 || secOfFrame === 59);
        if (!exclude) {
            // Own less other: the other station's tick leaks into this
            // template just where the tone is looked for.
            const own = (l) => Math.max(0, t.norm(cur, l) - t.norm(curO, l));
            let l0 = 0;
            if (!t.locked) {
                let best = -1;
                for (let l = -Wa; l <= Wa - 3 * L; l++) {
                    const v = own(l);
                    if (v > best) { best = v; l0 = l; }
                }
            }
            const at0 = own(l0);
            const after = 0.5 * (own(Math.min(Wa, l0 + 2 * L)) + own(Math.min(Wa, l0 + 3 * L)));
            if (at0 > 4 * lagNoise && after > TONE_RATIO * at0) exclude = true;
        }
        if (!exclude) {
            ++t.n;
            const a = Math.max(1 / t.n, TICK_ALPHA);
            for (let i = 0; i < t.avg.length; i++) {
                t.avg[i] += a * (cur[i] - t.avg[i]);
                t.avgO[i] += a * (curO[i] - t.avgO[i]);
            }
            t.varAvg = (1 - a) * (1 - a) * t.varAvg + a * a * lagNoise;
        }
        if (t.n === 0 || !(t.varAvg > 0)) { t.edge = t.x; return; }

        // The apex: the strongest lag within reach where this station's tick
        // explains it better than the other's, the average projected onto its
        // phase there, and a line through each side.
        const reach = (t.locked ? t.W : Wa) - L;
        let lp = 0;
        let best = -Infinity;
        for (let l = -reach; l <= reach; l++) {
            const v = t.norm(t.avg, l) - t.norm(t.avgO, l);
            if (v > best) { best = v; lp = l; }
        }
        const argAt = (l) => { const i = t.ix(l); return Math.atan2(t.avg[i + 1], t.avg[i]); };
        let theta = argAt(lp) - t.w * lp;
        const y = (l) => {
            const i = t.ix(l);
            const ph = -(t.w * l + theta);
            return t.avg[i] * Math.cos(ph) - t.avg[i + 1] * Math.sin(ph);
        };
        const fit = (from, to) => {
            let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let cnt = 0;
            for (let l = from; l <= to; l++) {
                const v = y(l);
                sx += l; sy += v; sxx += l * l; sxy += l * v; ++cnt;
            }
            const den = cnt * sxx - sx * sx;
            if (cnt < 2 || den === 0) return null;
            const b = (cnt * sxy - sx * sy) / den;
            return { a: (sy - b * sx) / cnt, b };
        };
        // The strongest lag is only somewhere on the triangle's top, which is
        // flat against the noise on a weak signal; the lines place it. If they
        // meet elsewhere on the top, fit again around where they met.
        const span = Math.trunc(0.8 * L);
        let apex = lp;
        for (let pass = 0; pass < 2; pass++) {
            const lf = fit(lp - span, lp - 2);
            const rf = lf && fit(lp + 2, lp + span);
            if (!(lf && rf && lf.b > 0 && rf.b < 0)) break;
            const c = (rf.a - lf.a) / (lf.b - rf.b);
            if (Math.abs(c - lp) <= 2) { apex = c; break; }
            if (pass === 1 || Math.abs(c - lp) > span / 3) break;
            lp = Math.round(c);
            if (Math.abs(lp) > reach) break;
            theta = argAt(lp) - t.w * lp;
            apex = lp;
        }
        const peak = y(lp);
        // What the other template holds at the apex counts against it.
        t.snr = Math.max(0, peak * peak - t.norm(t.avgO, lp)) / (0.5 * t.varAvg);
        let rival = 0;
        const iso = Math.trunc((3 * L) / 2);
        for (let l = -Wa; l <= Wa; l++) {
            if (Math.abs(l - lp) > iso) rival = Math.max(rival, t.norm(t.avg, l) - t.norm(t.avgO, l));
        }
        if (t.norm(t.avg, lp) < TICK_ISOLATION * rival) t.snr = 0;

        if (!t.locked) {
            if (t.snr >= TICK_LOCK_SNR && t.n >= TICK_MIN_SECS) {
                t.locked = true; t.miss = 0; t.hist = []; t.stepRef = 0;
            }
        } else if (t.snr < TICK_HOLD_SNR) {
            // Weak: hold where the tick was, and let go only if it stays weak.
            apex = 0;
            if (++t.miss >= TICK_MISS_LIMIT) { t.locked = false; t.period = t.nominal; t.hist = []; }
        } else if (Math.abs(apex - t.stepRef) > TICK_MAX_STEP) {
            // A jump no receiver clock makes in a second: follow it only as far
            // as one could, so a receiver tens of ppm off does not fall behind.
            apex = t.stepRef + Math.max(-TICK_MAX_STEP, Math.min(TICK_MAX_STEP, apex - t.stepRef));
            if (++t.miss >= TICK_MISS_LIMIT) { t.locked = false; t.period = t.nominal; t.hist = []; }
        } else {
            t.miss = 0;
            t.stepRef += TICK_STEP_ALPHA * (apex - t.stepRef);
        }

        // Move the prediction to the apex and the average with it; then the
        // step between seconds from the slope of where the tick has been.
        if (t.locked || (t.snr >= TICK_LOCK_SNR && t.n >= TICK_MIN_SECS)) {
            t.shift(apex);
            t.x += apex;
        }
        if (t.locked && t.miss === 0) {
            t.hist.push([t.tickCount, t.x]);
            while (t.hist.length > TICK_RATE_SECS) t.hist.shift();
            if (t.hist.length >= TICK_RATE_MIN) {
                // Relative to the first point, so the sums stay small.
                const [s0, x0] = t.hist[0];
                let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
                for (const [hs, hx] of t.hist) {
                    const u = hs - s0; const v = hx - x0;
                    sx += u; sy += v; sxx += u * u; sxy += u * v;
                }
                const nn = t.hist.length;
                const den = nn * sxx - sx * sx;
                if (den > 0) {
                    const lim = t.nominal * TICK_MAX_PPM * 1e-6;
                    t.period = Math.max(t.nominal - lim, Math.min(t.nominal + lim, (nn * sxy - sx * sy) / den));
                }
            }
        }
        t.edge = t.x;
    }

    onSeriesSample(br, bi, tickV, tickH) {
        const a = Math.hypot(br, bi);
        const j = this.n200++;

        // Fold each tick band's envelope mod 1 s, leaky.
        const phase = j % SEC_LEN;
        const { foldV, foldH } = this;
        foldV[phase] = foldV[phase] * FOLD_DECAY + tickV;
        foldH[phase] = foldH[phase] * FOLD_DECAY + tickH;

        // Folded impulsiveness of a band: peak-to-mean and the argmax phase.
        const stats = (fold) => {
            let peak = 0; let sum = 0; let arg = 0;
            for (let p = 0; p < SEC_LEN; p++) {
                sum += fold[p];
                if (fold[p] > peak) { peak = fold[p]; arg = p; }
            }
            const mean = sum / SEC_LEN;
            return { ratio: mean > 0 ? peak / mean : 0, arg };
        };
        // Tick EXCESS: the folded peak (and both neighbours, so a tick
        // straddling two bins counts whole) above the band's median bin. The
        // station is decided on excesses, not peak-to-mean, because each tick
        // leaks into the other band at the same phase.
        const tickExcess = (fold, arg) => {
            const med = median(fold);
            let e = 0;
            for (let d = -1; d <= 1; d++) e += fold[(arg + d + SEC_LEN) % SEC_LEN] - med;
            return Math.max(0, e);
        };
        // The peak above the other bins in units of their spread (MAD): on a
        // weak signal the ratio never passes, but the spread shrinks as the
        // fold integrates and the tick's excess does not.
        const foldZ = (fold, arg) => {
            const med = median(fold);
            const mad = 1.4826 * median(Array.from(fold, (v) => Math.abs(v - med)));
            return mad > 0 ? (fold[arg] - med) / mad : 0;
        };
        const tickVerdict = (eV, eH) => {
            if (eV >= STATION_EXCESS_RATIO * eH && eV > 0) return 'WWV';
            if (eH >= STATION_EXCESS_RATIO * eV && eH > 0) return 'WWVH';
            return null;
        };

        if (!this.tickLocked && j >= 5 * SEC_LEN) {
            const sV = stats(foldV);
            const sH = stats(foldH);
            // Lock once either band folds to a genuine impulse; the phase from
            // the band with the larger excess, not the peakier one.
            if (Math.max(sV.ratio, sH.ratio) > 2.5
                || (j >= FOLD_Z_MIN_SECS * SEC_LEN && Math.max(foldZ(foldV, sV.arg), foldZ(foldH, sH.arg)) > FOLD_Z)) {
                const eV = tickExcess(foldV, sV.arg);
                const eH = tickExcess(foldH, sH.arg);
                this.tickLocked = true;
                this.tickLockJ = j;
                this.tickPhase = eV >= eH ? sV.arg : sH.arg;
                this.setState('acquiring');
            }
        }

        // Judge the station once a second for as long as the stream runs, once
        // the fold is warm: confirm a first tag, switch only on a long run of
        // contrary verdicts, release one nothing has supported for two minutes.
        if (this.tickLocked && phase === 0) {
            const sV = stats(foldV);
            const sH = stats(foldH);
            const eV = tickExcess(foldV, sV.arg);
            const eH = tickExcess(foldH, sH.arg);
            this.tickExcessRatio = eH > 0 ? eV / eH : Infinity;
            const v = tickVerdict(eV, eH);
            const supported = (this.station === 'WWV' && eV > 0 && eV >= STATION_HOLD_RATIO * eH)
                || (this.station === 'WWVH' && eH > 0 && eH >= STATION_HOLD_RATIO * eV);
            if (this.stationPinned || j - this.tickLockJ < STATION_WARM_SECS * SEC_LEN) {
                // Fixed by the carrier, or the fold is too young to judge.
            } else if (this.station === null) {
                if (v !== null && v === this.pendingStation) {
                    if (++this.pendingCount >= STATION_CONFIRM_SECS) {
                        this.station = v;
                        this.stationContrary = 0; this.stationUnsupported = 0;
                        this.pendingCount = 0;
                    }
                } else {
                    this.pendingStation = v;
                    this.pendingCount = v !== null ? 1 : 0;
                }
            } else if (supported) {
                this.stationContrary = 0; this.stationUnsupported = 0;
            } else {
                ++this.stationUnsupported;
                this.stationContrary = v !== null ? this.stationContrary + 1 : 0;
                if (this.stationContrary >= STATION_SWITCH_SECS) {
                    this.station = v;
                    this.stationContrary = 0; this.stationUnsupported = 0;
                } else if (this.stationUnsupported >= STATION_RELEASE_SECS) {
                    this.station = null;
                    this.stationContrary = 0; this.stationUnsupported = 0;
                    this.pendingStation = null; this.pendingCount = 0;
                }
            }
        }

        if (a > this.aScale) this.aScale = a;
        this.aScale *= 0.99999;

        if (!this.tickLocked) return;

        // Cut the series into 1 s windows aligned to the tick phase.
        const boundary = ((j - this.tickPhase + WINDOW_LEAD) % SEC_LEN) === 0 && j + WINDOW_LEAD >= this.tickPhase;
        if (boundary) {
            if (this.secStarted && this.curFill === SEC_LEN) this.processSecond(this.secStartJ);
            this.curFill = 0;
            this.secStarted = true;
            this.secStartJ = j;
        }
        if (this.secStarted && this.curFill < SEC_LEN) {
            this.curR[this.curFill] = br;
            this.curI[this.curFill] = bi;
            this.curFill++;
        }
    }

    classifySecond(w) {
        // Correlation against each zero-mean template at a common shift (a
        // longer template never wins on a short pulse); symbol = best,
        // confidence = best minus runner-up. Once the delay has settled the
        // shift is searched only near it, so it cannot flap under fading.
        let mean = 0;
        for (let n = 0; n < SEC_LEN; n++) mean += w[n];
        mean /= SEC_LEN;
        const v = new Float64Array(SEC_LEN);
        let vnorm = 0;
        for (let n = 0; n < SEC_LEN; n++) { v[n] = w[n] - mean; vnorm += v[n] * v[n]; }
        vnorm = Math.sqrt(vnorm);
        const invn = 1 / (vnorm + 1e-12);

        let lo = 0; let hi = MAX_SHIFT;
        if (this.delayLocked) {
            const c = Math.round(this.delayEst);
            lo = Math.max(0, c - 3);
            hi = Math.min(MAX_SHIFT, c + 3);
        }
        const score = (k, d) => {
            const t = this.tpl[k];
            let dot = 0;
            for (let n = d; n < SEC_LEN; n++) dot += v[n] * t[n - d];
            return (dot * invn) / (this.tplNorm[k] + 1e-12);
        };

        let bestScore = -1e30;
        let scStar = [0, 0, 0];
        let winShift = lo;
        for (let d = lo; d <= hi; d++) {
            const sc = [score(0, d), score(1, d), score(2, d)];
            const m = Math.max(sc[0], sc[1], sc[2]);
            if (m > bestScore) { bestScore = m; winShift = d; scStar = sc; }
        }
        let best = 0;
        for (let k = 1; k < 3; k++) if (scStar[k] > scStar[best]) best = k;
        let runner = -1e30;
        for (let k = 0; k < 3; k++) if (k !== best && scStar[k] > runner) runner = scStar[k];
        const conf = fround(Math.max(0, scStar[best] - runner));

        // Sub-sample peak of the winning template's score: a parabola through
        // the best shift and its neighbours (outside the search band if need be).
        let fracShift = 0;
        if (winShift > 0 && winShift < SEC_LEN - 1) {
            const sm = score(best, winShift - 1);
            const sp = score(best, winShift + 1);
            const den = sm - 2 * scStar[best] + sp;
            if (den < 0) fracShift = Math.max(-0.5, Math.min(0.5, (0.5 * (sm - sp)) / den));
        }
        return { sym: best, conf, winShift, fracShift };
    }

    // A leap second can only follow 23:59 on a month's last day; unknown is
    // "no" here, as the C++ has it (not civil.js's "possible").
    leapPossibleNow() {
        if (!this.haveLastFields) return false;
        const f = this.lastFields;
        if (!f || f.doy < 1 || f.doy > 366 || f.year2 < 0 || f.year2 > 99) return false;
        return leapAfter(f);
    }

    processSecond(startJ) {
        // The pulse is the 100 Hz demod projected on the subcarrier's phase —
        // this second's own (the whole second summed is clear of the noise),
        // steadied by the long-run phase, since on skywave it swings from one
        // second to the next.
        let sr = 0; let si = 0;
        for (let n = 0; n < SEC_LEN; n++) { sr += this.curR[n]; si += this.curI[n]; }
        const refR = sr / SEC_LEN + this.bcdPhaseR;
        const refI = si / SEC_LEN + this.bcdPhaseI;
        const ra = Math.hypot(refR, refI);
        const rotR = ra > 0 ? refR / ra : 1;
        const rotI = ra > 0 ? -refI / ra : 0;
        const w = new Float64Array(SEC_LEN);
        for (let n = 0; n < SEC_LEN; n++) w[n] = fround(this.curR[n] * rotR - this.curI[n] * rotI);

        const { sym, conf, winShift, fracShift } = this.classifySecond(w);

        // Adapt the delay toward confident seconds' shifts; it keeps moving
        // once settled, which is what absorbs slow sample-clock drift.
        if (conf > fround(0.12)) {
            this.delayEst = 0.85 * this.delayEst + 0.15 * winShift;
            if (++this.delayCount >= 4) this.delayLocked = true;
        }
        // Drift beyond the rails: the window itself is wrong; resynchronise.
        if (this.delayLocked && (this.delayEst < 1.5 || this.delayEst > MAX_SHIFT - 1.5)) {
            this.softReacquire();
            return;
        }

        let emean = 0;
        for (let n = 0; n < SEC_LEN; n++) emean += w[n];
        emean /= SEC_LEN;

        const k = this.secIndex;
        const secOfFrame = this.anchored ? (((k - this.anchorSec0) % FRAME_SECS) + FRAME_SECS) % FRAME_SECS : -1;

        // Only a pulsed, confidently read second measures the BCD edge.
        const holeSecond = this.anchored && secOfFrame === 0;
        const timed = conf > fround(0.12) && !holeSecond && emean > PULSE_ENERGY_FRAC * this.aScale;
        if (timed) {
            const shift = winShift + fracShift;
            if (this.edgeDelayCount < EDGE_DELAY_WARM || Math.abs(shift - this.edgeDelayEst) <= EDGE_DELAY_GATE) {
                this.edgeDelayRejects = 0;
                ++this.edgeDelayCount;
                const alpha = Math.max(1 / this.edgeDelayCount, EDGE_DELAY_ALPHA);
                this.edgeDelayEst += alpha * (shift - this.edgeDelayEst);
            } else if (++this.edgeDelayRejects >= EDGE_DELAY_WARM) {
                // A real move the search band has already followed: start over.
                this.edgeDelayRejects = 0;
                this.edgeDelayCount = 1;
                this.edgeDelayEst = shift;
            }
        }
        const reportDelay = this.edgeDelayCount > 0 ? this.edgeDelayEst : this.delayEst;
        const bcdEdge = (startJ + reportDelay - BCD_EDGE_DELAY) * this.decim;

        // The tick, both stations', the second served from the tagged one's.
        // Unlocked, the BCD edge still frames the second but is not served.
        const windowStart = (startJ + WINDOW_LEAD) * this.decim;
        this.timeTick(this.timerV, windowStart, secOfFrame);
        this.timeTick(this.timerH, windowStart, secOfFrame);
        const tt = this.timingTimer();
        this.tickTiming = tt.locked;
        const tickSecond = !(this.anchored && (secOfFrame === 0 || secOfFrame === 29 || secOfFrame === 59));
        const edgeExact = this.tickTiming ? tt.edge : bcdEdge;
        const edgeSample = Math.round(edgeExact);
        if (this.tickTiming && timed && tickSecond) {
            const d = bcdEdge - tt.edge;
            if (Math.abs(d) < 0.1 * this.fs) {
                const al = Math.max(1 / ++this.bcdCheckN, BCD_CHECK_ALPHA);
                this.bcdMinusTick = this.bcdCheckN === 1 ? d : this.bcdMinusTick + al * (d - this.bcdMinusTick);
            }
        }

        // Slip detection before this second is emitted: a confident marker a
        // second late or early, or (after a possible leap-second minute) the
        // hole on s1, means the second count is no longer right.
        const recs = this.recs;
        if (this.anchored && secOfFrame > 0 && recs.length && recs[recs.length - 1].secIndex === k - 1) {
            const prev = recs[recs.length - 1];
            const late = conf >= fround(STRUCT_CONF) && sym === 2 && secOfFrame % 10 === 0 && prev.sym !== 2;
            const early = conf >= fround(STRUCT_CONF) && sym !== 2 && isMarkerSec(secOfFrame)
                && prev.sym === 2 && prev.conf >= fround(STRUCT_CONF);
            const leapHole = secOfFrame === 1 && this.leapPossibleNow() && emean < 0.5 * prev.energy;
            if (late || early || leapHole) {
                this.suspectSec = k;
                if (this.state === 'locked') this.setState('acquiring');
            }
        }

        this.lastEdgeSample = edgeSample;
        this.lastEdgeSampleExact = edgeExact;
        this.lastEdgeSecondOfFrame = secOfFrame;

        // Measured by the tick when it is timing (not at 0, 29, 59, which have
        // none), by the pulse otherwise; servable only from the tick.
        this.events.push({
            type: 'second',
            edge: edgeExact,
            measured: this.tickTiming ? tickSecond : timed,
            servable: this.tickTiming,
            symbol: SYMBOL_NAMES[sym],
            conf,
            sof: secOfFrame,
        });

        recs.push({ secIndex: k, edgeSample, edgeExact, sym, conf, energy: fround(emean) });
        if (recs.length > 12 * FRAME_SECS) { recs.shift(); ++this.recBase; }
        ++this.secIndex;

        if (!this.anchored) this.tryAnchor();
        this.feedPendingFrames();
    }

    tryAnchor() {
        // Markers alone anchor only mod 10 s; the s0 hole and minutes that
        // increment pick the offset, and a structural gate keeps noise out.
        const recs = this.recs;
        const M = recs.length;
        if (M < 2 * FRAME_SECS) return;
        let bestScore = -(1 << 30); let bestOff = -1; let bestMarker = 0; let bestInc = 0; let bestHole = 0;
        for (let off = 0; off < FRAME_SECS; off++) {
            const nf = Math.floor((M - off) / FRAME_SECS);
            if (nf < 2) continue;
            let markerScore = 0; let holeScore = 0;
            const minutes = [];
            for (let t = 0; t < nf; t++) {
                const base = off + FRAME_SECS * t;
                for (let s = 0; s < FRAME_SECS; s++) {
                    if (recs[base + s].sym === 2) markerScore += isMarkerSec(s) ? 2 : -1;
                }
                const e0 = recs[base].energy;
                let meanE = 0; let minE = 1e30;
                for (let s = 1; s < FRAME_SECS; s++) {
                    const e = recs[base + s].energy;
                    meanE += e;
                    if (e < minE) minE = e;
                }
                meanE /= FRAME_SECS - 1;
                if (e0 < 0.5 * meanE && e0 <= minE + 1e-9) ++holeScore;
                let mv = 0;
                for (const [sec, wt] of WWV_MAP.minute) if (recs[base + sec].sym === 1) mv += wt;
                minutes.push(mv);
            }
            let inc = 0;
            for (let t = 0; t + 1 < nf; t++) if (minutes[t + 1] - minutes[t] === 1) ++inc;
            const score = markerScore + 4 * inc + 3 * holeScore;
            if (score > bestScore) {
                bestScore = score; bestOff = off;
                bestMarker = markerScore; bestInc = inc; bestHole = holeScore;
            }
        }
        // A 10 s-shifted anchor puts a pulse on s0 and misreads the minutes,
        // so it fails this gate.
        if (bestOff >= 0 && bestMarker > 0 && bestInc >= 1 && bestHole >= 1) {
            this.anchored = true;
            this.anchorSec0 = this.recBase + bestOff;
            this.nextFrameStartK = this.anchorSec0;
        }
    }

    feedPendingFrames() {
        if (!this.anchored) return;
        const maxComplete = this.secIndex - 1;
        while (this.nextFrameStartK + (FRAME_SECS - 1) <= maxComplete) {
            if (this.nextFrameStartK < this.recBase) { this.nextFrameStartK += FRAME_SECS; continue; }

            const base = this.nextFrameStartK - this.recBase;
            const sym = new Array(FRAME_SECS);
            const conf = new Array(FRAME_SECS);
            for (let s = 0; s < FRAME_SECS; s++) {
                const r = this.recs[base + s];
                sym[s] = r.sym;
                conf[s] = r.conf;
            }

            let mkOk = 0; let mkFalse = 0; let mkLate = 0; let mkEarly = 0;
            for (let s = 0; s < FRAME_SECS; s++) {
                if (sym[s] !== 2) continue;
                if (isMarkerSec(s)) mkOk++; else mkFalse++;
                if (s % 10 === 0) ++mkLate;
                if (s % 10 === 8) ++mkEarly;
            }

            // A whole skeleton a second off is a slipped count (a leap second,
            // a lost or doubled second): realign and assemble again without
            // voting the misaligned frame. Slipped again straight after a
            // realignment is not a clean slip: start over.
            if ((mkLate >= 4 || mkEarly >= 4) && mkOk <= 1) {
                if (this.nextFrameStartK === this.lastRealignK) {
                    this.softReacquire();
                    return;
                }
                const shift = mkLate >= mkEarly ? 1 : -1;
                this.anchorSec0 += shift;
                this.nextFrameStartK += shift;
                this.lastRealignK = this.nextFrameStartK;
                this.suspectSec = -1;
                if (this.state === 'locked') this.setState('acquiring');
                continue;
            }

            // A second in this frame contradicted the alignment: neither its
            // decode nor a time composed from its s0 can be trusted.
            const suspect = this.suspectSec >= this.nextFrameStartK && this.suspectSec < this.nextFrameStartK + FRAME_SECS;

            const startRec = this.recs[base];
            const frame = this.decodeWwvFrame(sym, conf);
            if (!suspect) {
                // Source.cpp's onClockFrame: the s0 a `time` is composed against.
                this.frameStartSample = startRec.edgeSample;
                this.haveFrame = true;
                const fields = { minute: frame.minute, hour: frame.hour, doy: frame.doy, year2: frame.year2 };
                this.events.push({
                    type: 'frame',
                    utcMs: fieldsValid(fields) ? utcFromFields(fields) : null,
                    startEdge: startRec.edgeExact,
                    confidence: frame.frameConfidence,
                    dut1Tenths: frame.dut1Tenths,
                    summer: frame.dst1 && frame.dst2,
                    leapPending: frame.leapPending,
                    dst1: frame.dst1,
                    dst2: frame.dst2,
                    fields,
                    station: this.station,
                });
            }

            // A streak of broken skeletons means the window or anchor is wrong;
            // single noisy frames still vote (the voter's gates absorb them).
            const skeletonOk = !(mkOk < 4 || mkFalse > 5);
            if (!skeletonOk) {
                if (++this.badFrameStreak >= 3) {
                    this.softReacquire();
                    return;
                }
            } else {
                this.badFrameStreak = 0;
            }

            // A suspect frame keeps its slot (the voter ages by slot) but votes
            // nothing.
            if (suspect) this.voter.addFrame(new Array(FRAME_SECS).fill(-1), new Array(FRAME_SECS).fill(0));
            else this.voter.addFrame(sym, conf);
            const certified = this.voter.locked();
            const voted = certified ? this.voter.resolve().value : null;

            this.haveLastFields = !suspect;
            if (!suspect) {
                this.lastFields = certified ? { ...voted } : { minute: frame.minute, hour: frame.hour, doy: frame.doy, year2: frame.year2 };
            }
            // 23:59 on a month's last day with the warning up (this frame's or
            // the last): the next second is probably 23:59:60, so stop
            // certifying before it; the slip checks realign the next minute.
            const leapNext = !suspect && (frame.leapPending || this.lastLeapWarn) && this.leapPossibleNow();
            if (!suspect) this.lastLeapWarn = frame.leapPending;

            if (certified && (suspect || leapNext)) {
                if (this.state === 'locked') this.setState('acquiring');
            } else if (certified && !skeletonOk) {
                // Certified, but this frame's alignment is not vouched for:
                // hold, and compose nothing against its s0.
            } else if (certified) {
                this.setState('locked');
                this.emitTime(voted, this.voter.lockConfidence());
            } else if (this.state === 'locked') {
                this.setState('acquiring');
            }

            this.nextFrameStartK += FRAME_SECS;
        }
    }

    // Source.cpp's onClockTime: the voted frame's s0 plus whole seconds to the
    // edge this time is anchored to, refused across a possible leap second.
    emitTime(f, quality) {
        if (!f || f.year2 < 0 || f.doy < 1 || f.hour < 0 || f.minute < 0) return;
        if (!this.haveFrame) return;
        const baseMs = utcFromFields(f);
        const elapsedSec = Math.round((this.lastEdgeSample - this.frameStartSample) / this.fs);
        const utcMs = baseMs + elapsedSec * 1000;
        const boundary = leapBoundaryAfter(baseMs);
        if (boundary > 0 && utcMs >= boundary) return;
        this.events.push({
            type: 'time',
            utcMs,
            edge: Number.isFinite(this.lastEdgeSampleExact) ? this.lastEdgeSampleExact : this.lastEdgeSample,
            quality,
            sof: this.lastEdgeSecondOfFrame,
            station: this.station,
        });
    }

    softReacquire() {
        // Forget every timing estimate; keep the warm filters, the leaky fold
        // (already on the current phase, which makes re-lock fast), the tag
        // and the sample count.
        this.tickLocked = false;
        this.curFill = 0;
        this.secStarted = false;
        this.secStartJ = 0;
        this.delayEst = NOMINAL_DELAY; this.delayLocked = false; this.delayCount = 0;
        this.edgeDelayEst = NOMINAL_DELAY; this.edgeDelayCount = 0; this.edgeDelayRejects = 0;
        this.recs = [];
        this.recBase = this.secIndex;
        this.anchored = false; this.anchorSec0 = 0; this.nextFrameStartK = 0;
        this.badFrameStreak = 0;
        this.suspectSec = -1; this.lastRealignK = -1;
        this.haveLastFields = false; this.lastLeapWarn = false;
        this.voter.reset();
        if (this.state !== 'nosignal') this.setState('acquiring');
    }

    decodeWwvFrame(sym, conf) {
        const bit = (s) => sym[s] === 1;
        const sumField = (map) => map.reduce((v, [sec, wt]) => v + (bit(sec) ? wt : 0), 0);
        const mag = (bit(56) ? 1 : 0) + (bit(57) ? 2 : 0) + (bit(58) ? 4 : 0);
        let sumc = 0; let cnt = 0;
        for (let s = 0; s < FRAME_SECS; s++) if (!isMarkerSec(s)) { sumc += conf[s]; ++cnt; }
        return {
            minute: sumField(WWV_MAP.minute),
            hour: sumField(WWV_MAP.hour),
            doy: sumField(WWV_MAP.doy),
            year2: sumField(WWV_MAP.year2),
            // DUT1: sign at s50 (1 = positive), tenths at s56–58.
            dut1Tenths: bit(50) ? mag : -mag,
            dst1: bit(2),           // DST at 00:00Z today
            dst2: bit(55),          // DST at 24:00Z today
            leapPending: bit(3),
            frameConfidence: cnt ? Math.min(1, sumc / cnt) : 0,
        };
    }
}
