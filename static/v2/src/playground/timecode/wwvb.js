// WWVB's legacy AM/PWM time code: ubersdr-ntp's WwvbDecoder
// (src/clock/WwvbDecoder.cpp), ported for complex IQ.
//
// Format facts per NIST SP 250-67: one bit a second, the carrier reduced 17 dB
// at the start of each second for 0.2 s (binary 0), 0.5 s (binary 1) or 0.8 s
// (marker); markers at seconds 0, 9, 19, 29, 39, 49 and 59, so two in a row
// (s59 → s0) mark the minute. BCD fields are MSB-first. Amplitude only, by
// design: the 2012 BPSK layer flips the phase 100 ms into a second, which
// leaves the envelope alone in steady state (|−z| = |z|), and the flip's
// one-sample transient notch is averaged flat by the 10 ms boxcar and refused
// by the sustained-low gate. No edge here is phase-derived.
//
// Chain, per input sample: (once) a carrier search across ±200 Hz of the
// expected offset → complex mix to baseband → 150 Hz biquad on I and Q →
// magnitude → 10 ms boxcar to a 100 Hz envelope. Then: second edges are the
// carrier's drop, placed inside their block by its area and smoothed by an
// alpha-beta tracker; each second is classified against three zero-mean
// templates; double markers anchor the minute (three in a row are a leap
// second); a minute's frame goes to the shared TimeFrameVoter.
//
// The C++ takes the USB audio of a 59 kHz dial, the carrier a ~1000 Hz tone,
// and searches 800–1200 Hz for it. On IQ, Source.cpp makes that audio by
// low-passing the IQ to ±900 Hz (a 4th-order Butterworth), shifting it up by
// 1 kHz and taking the real part — and then takes that low-pass's group delay
// off every edge. Here the IQ is mixed straight down at the carrier instead:
// the same search (±200 Hz about `carrierOffsetHz`, as 800–1200 Hz is about
// 1000), the same mix-and-low-pass after it, and no 900 Hz filter at all, so
// there is no delay of that kind to remove. The only filter an edge passes is
// the 150 Hz I/Q low-pass, whose DC group delay the edge arithmetic takes off
// as the C++ does. The complex mix also loses the real-audio path's image at
// twice the tone, which the 150 Hz low-pass only partly removed.

import { Biquad, Rotator } from './dsp.js';
import { fieldsValid, leapSecondPossible as leapPossibleCivil, utcFromFields } from './civil.js';
import { SYM, TimeFrameVoter, WWVB_MAP, WWVB_MARKERS } from './voter.js';
import {
    DftBins, ENV_CAP, ENV_RATE_HZ, Envelope, composeUtc, envelopeDecimation, symbolName, upperMedian, voterReference,
} from './lfcommon.js';

const EDGE_TOL = 12;       // ± envelope samples searched for each second's drop
// Envelope history an edge candidate needs on either side: the sustained-low
// check and the low level look up to 10 samples past it, the high level 8
// before. Classification waits for this much lookahead, so a candidate near
// the end of the search band is judged on real samples.
const EDGE_LOOK = 12;
const WARM_ENV = 200;      // envelope samples before seeding the phase
const MIN_CONTRAST = 1.4;  // p90 ≥ 1.4·p10: a real AM drop exists
const LPF_CUT_HZ = 150;    // the I/Q low-pass corner

// The carrier search: 2 s of complex DFT bins every 2 Hz across ±200 Hz, and
// the peak must stand 12× above the median bin.
const ACQ_SECONDS = 2;
const TONE_SPAN_HZ = 200;
const TONE_STEP_HZ = 2;
const TONE_GATE = 12;

// Low durations, in envelope samples, of zero / one / marker: 0.2 / 0.5 / 0.8 s.
const SYMBOL_LOW_LEN = [20, 50, 80];

// The matched-filter margin a single second needs to count as evidence that
// the frame alignment is wrong: low enough that a clean marker clears it, high
// enough that a coin-flip read under noise does not throw a good lock away.
const STRUCT_CONF = 0.10;

// The edge tracker: phase weight 1/8 (τ ≈ 8 s) once warm, period weight near
// critical damping for it, and a plain running mean for the first 8 seconds.
const TRK_ALPHA = 1 / 8;
const TRK_BETA = 1 / 128;
const TRK_WARM = 8;

const MARKER_SET = new Set(WWVB_MARKERS);

// The zero-mean templates: 0 through the reduced-carrier part, 1 after it.
const TEMPLATES = SYMBOL_LOW_LEN.map((low) => {
    const t = new Float64Array(ENV_RATE_HZ);
    for (let k = 0; k < ENV_RATE_HZ; k++) t[k] = k < low ? 0 : 1;
    const mean = t.reduce((a, b) => a + b, 0) / ENV_RATE_HZ;
    let nrm = 0;
    for (let k = 0; k < ENV_RATE_HZ; k++) { t[k] -= mean; nrm += t[k] * t[k]; }
    return { t, norm: Math.sqrt(nrm) + 1e-12 };
});

export class WwvbDecoder {
    constructor({ sampleRate = 12000, carrierOffsetHz = 0, referenceNow = null } = {}) {
        this.fs = sampleRate;
        this.decim = envelopeDecimation(sampleRate, 'WwvbDecoder');
        this.fNominal = carrierOffsetHz;
        const freqs = [];
        for (let f = -TONE_SPAN_HZ; f <= TONE_SPAN_HZ + 1e-9; f += TONE_STEP_HZ) freqs.push(carrierOffsetHz + f);
        this.bins = new DftBins(freqs, sampleRate);
        this.acqTarget = Math.round(ACQ_SECONDS * sampleRate);
        this.env = new Envelope(0.10, 0.90);
        // The NIST layout, with the honesty floors the C++ gives it: noise-grade
        // margins do not vote, and a window whose trust collapsed does not lock.
        this.voter = new TimeFrameVoter({ fields: WWVB_MAP, minBitConfidence: 0.05, minLockQuality: 0.05 });
        this.voter.setPlausibility(voterReference(referenceNow), voterReference(referenceNow) ? 24 * 60 : 0);
        this.reset();
    }

    reset() {
        this.n = 0;                    // input samples consumed
        this.events = [];
        this.lockState = 'nosignal';
        this.running = false;
        this.bins.reset();
        this.acqCount = 0;
        this.toneSnrDb = 0;
        this.f0 = this.fNominal;
        this.osc = null;
        this.lpI = null;
        this.lpQ = null;
        this.lpfDelay = 0;             // DC group delay of the I/Q low-pass, input samples
        this.magAccum = 0;
        this.magCount = 0;
        this.envBase = 0;              // input sample where envelope index 0 begins
        this.env.reset();
        // Second segmentation.
        this.phaseKnown = false;
        this.curStart = 0;
        this.scanPos = 0;
        this.curEdge = 0;              // this second's edge, fractional input sample
        this.curEdgeMeasured = false;  // false when coasted (no drop found)
        // The edge tracker.
        this.trkValid = false;
        this.trkEdge = 0;
        this.trkPeriod = 0;
        this.trkCount = 0;
        this.trkOutliers = 0;
        // Frame sync and leap seconds.
        this.anchored = false;
        this.sofNext = 0;
        this.prevSym = SYM.UNKNOWN;
        this.prevPrevSym = SYM.UNKNOWN;
        this.havePrev = false;
        this.leapInserted = false;
        this.lastFields = null;        // the last finalised minute's fields
        this.lastLeapWarn = false;
        // Frame assembly.
        this.frSym = new Array(60).fill(SYM.UNKNOWN);
        this.frConf = new Array(60).fill(0);
        this.frFilled = 0;
        this.frStart = 0;              // s0's edge, fractional input sample
        this.haveLastFrame = false;
        this.lastFrameS0Env = 0;
        this.lastFrameEdge = null;     // the last emitted frame's s0 edge, for composing time
        // The cached vote, re-emitted every second while locked.
        this.haveVoted = false;
        this.voted = null;
        this.votedQuality = 0;
        this.voter.reset();
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
            station: 'WWVB',
            snrDb: this.toneSnrDb,
            carrierOffsetHz: this.running ? this.f0 : null,
            refusal: this.lockState === 'locked' ? null : verdict.reason,
            frames: this.voter.frameCount(),
            detail: {
                toneSnrDb: this.toneSnrDb,
                toneDetected: this.running,
                pwmContrast: env.pLo > 1e-6 ? env.pHi / env.pLo : 0,
                phaseLocked: this.phaseKnown,
                anchored: this.anchored,
                framesInWindow: this.voter.frameCount(),
                windowSize: this.voter.cfg.window,
                voteQuality: this.voter.lockConfidence(),
                refusalReason: verdict.reason,
                trackerSeconds: this.trkCount,
                trackerPeriodPpm: this.trkValid ? (this.trkPeriod / this.fs - 1) * 1e6 : null,
            },
        };
    }

    // ── acquisition: the one-shot carrier search ──────────────────────────────

    _feedAcquisition(xr, xi) {
        this.bins.push(xr, xi);
        if (++this.acqCount >= this.acqTarget) this._finalizeAcquisition();
    }

    _finalizeAcquisition() {
        const pw = this.bins.powers();
        let peak = 0;
        for (let i = 1; i < pw.length; i++) if (pw[i] > pw[peak]) peak = i;
        const median = upperMedian(pw);
        // Kept up to date every 2 s window until the gate passes, so the
        // readout is live even when nothing is there.
        if (median > 0) this.toneSnrDb = 10 * Math.log10(pw[peak] / median);
        if (median > 0 && pw[peak] > TONE_GATE * median) {
            this.f0 = this.bins.f[peak];
            this._startSteady();
        } else {
            this.bins.reset();
            this.acqCount = 0;
        }
    }

    _startSteady() {
        this.running = true;
        this.envBase = this.n;         // envelope index 0 begins at the next sample
        this.osc = new Rotator(this.f0, this.fs);
        this.lpI = Biquad.lowpass(LPF_CUT_HZ, this.fs);
        this.lpQ = Biquad.lowpass(LPF_CUT_HZ, this.fs);
        // The low-pass's DC group delay (~1.5 ms at 150 Hz): the first moment of
        // its impulse response, exactly how late a step comes out of it. Derived
        // from the coefficients, so a changed corner keeps edges honest.
        this.lpfDelay = this.lpI.dcDelay();
        this.magAccum = 0;
        this.magCount = 0;
        this._setState('acquiring');
    }

    // ── steady state: mix → low-pass → magnitude → decimate ──────────────────

    _feedSteady(xr, xi) {
        const [c, s] = this.osc.step();
        const I = this.lpI.process(xr * c - xi * s);
        const Q = this.lpQ.process(xr * s + xi * c);
        this.magAccum += Math.sqrt(I * I + Q * Q);
        if (++this.magCount >= this.decim) {
            this.env.push(this.magAccum / this.magCount);
            this.magAccum = 0;
            this.magCount = 0;
            this._processSeconds();
        }
    }

    _haveContrast() {
        return this.env.pHi >= MIN_CONTRAST * Math.max(this.env.pLo, 1e-6);
    }

    // ── second segmentation and classification ────────────────────────────────

    _processSeconds() {
        if (!this.phaseKnown) {
            this._trySeed();
            if (!this.phaseKnown) return;
        }
        while (this.phaseKnown && this.env.count >= this.curStart + ENV_RATE_HZ + EDGE_TOL + EDGE_LOOK) {
            this._classifyAndAdvance();
        }
    }

    // Is env[i] the first sample below the midpoint of a real carrier drop? It
    // only has to cross the midpoint between env[i−1] and env[i] — demanding
    // 60 % before and 40 % after missed every drop that landed 40–60 % of the
    // way into a block — with a full-carrier sample within three before it and
    // the drop sustained.
    _isFallingEdge(i, t) {
        return this.env.fallingCross(i, t);
    }

    // The drop crossing at env[i] as a fractional input sample: its area
    // (Envelope.areaPosition) less the I/Q low-pass's DC group delay, which a
    // unity-gain filter delays a step's area by exactly. H and L are local
    // means either side, so fading and the percentiles' lag do not bias it.
    _edgeSampleAt(i) {
        return this.envBase + this.env.areaPosition(i, 10, 1e-9) * this.decim - this.lpfDelay;
    }

    // Second edges are exactly one broadcast second apart, so one second's
    // measurement is not the best estimate of its own edge: under noise the
    // area moves ±3 ms at 10 dB. An alpha-beta tracker (phase and period, so a
    // receiver clock a few ppm off is followed without lag) reports the
    // smoothed edge. It starts as a running mean, coasts on its prediction
    // through seconds with no drop, and re-seeds only after three consecutive
    // measurements a whole block out.
    _trackEdge(measured, raw) {
        if (!this.trkValid) {
            this.trkEdge = raw;
            this.trkPeriod = this.fs;
            this.trkValid = measured;
            this.trkCount = measured ? 1 : 0;
            this.trkOutliers = 0;
            return;
        }
        const pred = this.trkEdge + this.trkPeriod;
        if (!measured) { this.trkEdge = pred; return; }
        const r = raw - pred;
        if (Math.abs(r) > this.decim) {
            if (++this.trkOutliers >= 3) {
                this.trkEdge = raw;
                this.trkPeriod = this.fs;
                this.trkCount = 1;
                this.trkOutliers = 0;
            } else {
                this.trkEdge = pred;
            }
            return;
        }
        this.trkOutliers = 0;
        this.trkCount++;
        const alpha = Math.max(1 / this.trkCount, TRK_ALPHA);
        this.trkEdge = pred + alpha * r;
        if (this.trkCount > TRK_WARM) {
            // ±200 ppm is far outside any real receiver; the clamp only stops a
            // pathological run of residuals winding the period away.
            this.trkPeriod = Math.min(this.fs * (1 + 2e-4), Math.max(this.fs * (1 - 2e-4), this.trkPeriod + TRK_BETA * r));
        }
    }

    _trySeed() {
        if (this.env.count < WARM_ENV || !this._haveContrast()) return;
        const t = this.env.thresholds();
        const lo = Math.max(this.scanPos, 9, this.env.count - ENV_CAP + 9);
        for (let i = lo; i + EDGE_LOOK < this.env.count; i++) {
            this.scanPos = i;
            if (this._isFallingEdge(i, t)) {
                this.curStart = i;
                this.curEdge = this._edgeSampleAt(i);
                this.curEdgeMeasured = true;
                this.phaseKnown = true;
                return;
            }
        }
    }

    // The next second's drop near its predicted envelope index: the nearest
    // falling edge within ±tol, as { start, edge }, or null (coast).
    _findFallingEdgeNear(pred, tol) {
        if (!this._haveContrast()) return null;
        const t = this.env.thresholds();
        const lo = Math.max(pred - tol, this.env.count - ENV_CAP + 9);
        const hi = Math.min(pred + tol, this.env.count - 1 - EDGE_LOOK);
        let bestEdge = pred;
        let bestDist = tol + 1;
        for (let i = lo; i <= hi; i++) {
            if (i < 9) continue;
            if (this._isFallingEdge(i, t)) {
                const d = Math.abs(i - pred);
                if (d < bestDist) { bestDist = d; bestEdge = i; }
            }
        }
        if (bestDist > tol) return null;
        return { start: bestEdge, edge: this._edgeSampleAt(bestEdge) };
    }

    _classifyAndAdvance() {
        // One full second from the drop (100 envelope samples), made zero-mean
        // and correlated with each template; confidence is the winner's margin.
        const v = new Float64Array(ENV_RATE_HZ);
        let mean = 0;
        for (let k = 0; k < ENV_RATE_HZ; k++) { v[k] = this.env.at(this.curStart + k); mean += v[k]; }
        mean /= ENV_RATE_HZ;
        let vnorm = 0;
        for (let k = 0; k < ENV_RATE_HZ; k++) { v[k] -= mean; vnorm += v[k] * v[k]; }
        vnorm = Math.sqrt(vnorm) + 1e-12;
        const corr = TEMPLATES.map(({ t, norm }) => {
            let dot = 0;
            for (let k = 0; k < ENV_RATE_HZ; k++) dot += v[k] * t[k];
            return dot / (vnorm * norm);
        });
        let best = 0;
        for (let s = 1; s < 3; s++) if (corr[s] > corr[best]) best = s;
        let runner = -1e18;
        for (let s = 0; s < 3; s++) if (s !== best && corr[s] > runner) runner = corr[s];
        const conf = Math.max(0, corr[best] - runner);
        const sym = best === 0 ? SYM.ZERO : best === 1 ? SYM.ONE : SYM.MARKER;

        // Reported at input-sample resolution from the tracker, fed the
        // sub-block estimate made when this second was found; curStart only
        // chooses which envelope samples the classifier sees.
        this._trackEdge(this.curEdgeMeasured, this.curEdge);
        const edge = this.trkEdge;

        const sof = this._updateSync(sym, conf, edge);
        this.events.push({
            type: 'second', edge, measured: this.curEdgeMeasured, servable: true,
            symbol: symbolName(sym), conf, sof,
        });

        if (this.anchored && sof >= 0) this._recordFrameSecond(sof, sym, conf);

        if (this.lockState === 'locked' && this.haveVoted && this.lastFrameEdge !== null) {
            const utcMs = composeUtc(this.voted, this.lastFrameEdge, edge, this.fs);
            if (utcMs !== null) this.events.push({ type: 'time', utcMs, edge, quality: this.votedQuality, sof });
        }

        const found = this._findFallingEdgeNear(this.curStart + ENV_RATE_HZ, EDGE_TOL);
        this.curEdgeMeasured = !!found;
        // Coasting keeps the last edge's sub-block phase rather than snapping to
        // the envelope grid, so a missed drop adds no quantisation step.
        if (found) { this.curStart = found.start; this.curEdge = found.edge; }
        else { this.curStart += ENV_RATE_HZ; this.curEdge += this.fs; }
    }

    // ── frame sync: the double marker ─────────────────────────────────────────

    // A leap second is only ever 23:59:60 UTC on the last day of a month, so a
    // third marker in a row is one only straight after such a minute. With no
    // minute decoded yet it cannot be ruled out, and taking it as one costs
    // nothing: the frame it starts is checked at s59 like any other.
    _leapSecondPossible() {
        const f = this.lastFields;
        if (!f) return true;
        if (f.minute !== 59 || f.hour !== 23) return false;
        if (f.doy < 1 || f.doy > 366 || f.year2 < 0 || f.year2 > 99) return false;
        return leapPossibleCivil(f);
    }

    _updateSync(sym, conf, edge) {
        const marker = sym === SYM.MARKER;
        let sof;
        if (!this.anchored) {
            // Two markers in a row: s59 → s0, and this second is s0.
            if (this.havePrev && this.prevSym === SYM.MARKER && marker) {
                this.anchored = true;
                sof = 0;
                this.sofNext = 1;
                this._beginFrame(edge);
            } else {
                sof = -1;
            }
        } else if (this.sofNext === 1 && marker && this.prevSym === SYM.MARKER
            && this.prevPrevSym === SYM.MARKER && this._leapSecondPossible()) {
            // Three markers in a row — s59, s60, s0 — is how NIST sends a leap
            // second: the second just labelled s0 was 23:59:60, this is the
            // real s0, and the frame that finished spans 61 s. A lock still up
            // (the warning bit missed) drops now, before this second goes out.
            if (this.lockState === 'locked') {
                this.haveVoted = false;
                this._setState('acquiring');
            }
            this.leapInserted = true;
            sof = 0;
            this.sofNext = 1;
            this._beginFrame(edge);
        } else {
            sof = this.sofNext;
            if (sof === 0) this._beginFrame(edge);
            this.sofNext = (this.sofNext + 1) % 60;
            // A confident symbol that contradicts the marker skeleton means the
            // count has slipped. s59 would catch it, but up to a minute later,
            // so certified time stops now; s59 decides whether the frame was
            // sound (and re-locks) or drops the anchor.
            if (this.lockState === 'locked' && conf >= STRUCT_CONF && marker !== MARKER_SET.has(sof)) {
                this.haveVoted = false;
                this._setState('acquiring');
            }
        }
        this.prevPrevSym = this.havePrev ? this.prevSym : SYM.UNKNOWN;
        this.prevSym = sym;
        this.havePrev = true;
        return sof;
    }

    _beginFrame(edge) {
        this.frStart = edge;
        this.frFilled = 0;
        this.frSym.fill(SYM.UNKNOWN);
        this.frConf.fill(0);
    }

    _recordFrameSecond(sof, sym, conf) {
        this.frSym[sof] = sym;
        this.frConf[sof] = conf;
        this.frFilled++;
        if (sof === 59) this._finalizeFrame();
    }

    // ── frame decode and voting ───────────────────────────────────────────────

    _finalizeFrame() {
        let ok = this.frFilled >= 60;
        for (const m of WWVB_MARKERS) if (this.frSym[m] !== SYM.MARKER) { ok = false; break; }
        if (!ok) {
            // Corrupted markers: drop the anchor and re-search; no frame.
            this.anchored = false;
            this.havePrev = false;
            this.haveLastFrame = false;
            this.lastFields = null;
            this.lastLeapWarn = false;
            this.leapInserted = false;
            this.haveVoted = false;
            this.voter.reset();
            this._setState('acquiring');
            return;
        }

        const fi = this._decodeFrame();
        this.lastFrameEdge = this.frStart;
        this.events.push({
            type: 'frame',
            utcMs: fieldsValid(fi.fields) ? utcFromFields(fi.fields) : null,
            startEdge: this.frStart,
            confidence: fi.confidence,
            dut1Tenths: fi.dut1Tenths,
            summer: fi.dst1,
            leapPending: fi.leapPending,
        });

        // A frame after a leap second starts 61 s after the last; it is still
        // the next minute and must not reset the voter's window.
        const s0env = Math.trunc((Math.round(this.frStart) - this.envBase) / this.decim);
        const gapSecs = this.leapInserted ? 61 : 60;
        this.leapInserted = false;
        const consecutive = this.haveLastFrame
            && Math.abs((s0env - this.lastFrameS0Env) - gapSecs * ENV_RATE_HZ) <= 2 * EDGE_TOL;
        if (!consecutive) this.voter.reset();
        this.haveLastFrame = true;
        this.lastFrameS0Env = s0env;
        this.voter.addFrame(this.frSym, this.frConf);

        const certified = this.voter.locked();
        if (certified) {
            this.voted = this.voter.resolve().value;
            this.votedQuality = this.voter.lockConfidence();
        }
        this.lastFields = certified ? { ...this.voted } : { ...fi.fields };

        // The minute that ended is 23:59 on a month's last day with the leap
        // warning up (this frame's bit, or the last one's if this faded): the
        // next second is probably 23:59:60, which time extended from this frame
        // would call 00:00:00. Stop certifying before it; the triple marker
        // re-aligns the minute and the next frame re-locks.
        const leapNext = (fi.leapPending || this.lastLeapWarn) && this._leapSecondPossible();
        this.lastLeapWarn = fi.leapPending;

        if (certified && !leapNext) {
            this.haveVoted = true;
            this._setState('locked');
        } else {
            // Not certified (or a leap second may follow): stop re-emitting the
            // cached time and demote a stale lock rather than pin it.
            this.haveVoted = false;
            if (this.lockState === 'locked') this._setState('acquiring');
        }
    }

    _decodeFrame() {
        const bit = (s) => (this.frSym[s] === SYM.ONE ? 1 : 0);
        const field = (map) => map.reduce((v, [s, w]) => v + (bit(s) ? w : 0), 0);
        const fields = {
            minute: field(WWVB_MAP.minute), hour: field(WWVB_MAP.hour),
            doy: field(WWVB_MAP.doy), year2: field(WWVB_MAP.year2),
        };
        // DUT1: s37 set means negative (s36 and s38 positive); magnitude in
        // tenths 0.8 / 0.4 / 0.2 / 0.1 on s40–s43.
        const sign = bit(37) ? -1 : 1;
        const mag10 = 8 * bit(40) + 4 * bit(41) + 2 * bit(42) + bit(43);
        let sum = 0;
        let cnt = 0;
        for (let s = 0; s < 60; s++) if (!MARKER_SET.has(s)) { sum += this.frConf[s]; cnt++; }
        return {
            fields,
            dut1Tenths: sign * mag10,
            leapYear: bit(55) === 1,
            leapPending: bit(56) === 1,
            // NIST puts "DST in effect at 00:00Z today" on s58, "at 24:00Z" on s57.
            dst1: bit(58) === 1,
            dst2: bit(57) === 1,
            confidence: cnt ? Math.min(1, Math.max(0, sum / cnt)) : 0,
        };
    }

    _setState(s) { this.lockState = s; }
}
