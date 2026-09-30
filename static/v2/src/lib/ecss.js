// Exalted-carrier single sideband: listening to AM as though it were SSB.
//
// An AM broadcast is a carrier and two identical sidebands. An envelope
// detector needs all three to arrive intact, and on shortwave they rarely do:
// selective fading takes the carrier down on its own and the envelope turns to
// distortion, and a station on the adjacent channel, or a heterodyne a
// kilohertz off, lands on one sideband and is heard over the whole signal.
//
// ECSS answers both at once. The carrier is not detected, it is *tracked*: a
// phase-locked loop follows it and regenerates it locally, clean and at full
// strength, so a fade of the carrier stops mattering. And against that
// regenerated carrier only one sideband is demodulated — whichever one does not
// have the interference on it — so the other can be thrown away without losing
// anything, because it carried the same programme.
//
// Everything a person would otherwise have to do by hand is done here, because
// that is the only way the mode is worth having:
//
//   * Finding the carrier. A click on the picture is rarely within a loop's
//     pull-in range of a carrier, so the loop is not asked to find it. A
//     transform of the tracking window finds it, and the loop is preset onto
//     it — see SEARCH below.
//   * Keeping it. The loop runs wide while it acquires and narrows once it
//     holds, and it coasts through a carrier fade on the frequency it had
//     rather than chasing the noise — see the fade detector.
//   * Picking the sideband. Auto compares the two sidebands against each
//     other; what one has that the other does not is interference. See
//     SIDEBAND below.
//
// With no carrier to be found — an SSB station, an empty channel — the tracker
// keeps searching and the audio is plain SSB against the offset, so the worst
// case is the mode USB or LSB would have given anyway.
//
// ── The signal path ──────────────────────────────────────────────────────────
//
//   x ─► × e^(-jφ) ─► d ─┬─► carrier low-pass ─► phase detector ─► loop ─► φ
//                         │
//                         ├─► USB filter ─┐
//                         └─► LSB filter ─┴─► crossfade ─► Re{} ─► audio
//
// φ is one oscillator doing two jobs: it carries the offset (the nominal
// carrier position the operator set) and the loop's correction (where the
// carrier actually is). Once locked, d has the carrier at exactly DC, and a
// sideband filter hung off DC is a sideband filter hung off the carrier.

import { fftInPlace, hannWindow } from './iqSpectrum.js';

// The two sideband filters' inner edge, in hertz above (or below) the carrier.
//
// Not zero, for two reasons. The carrier is at DC and has to be kept out of the
// audio — at the full strength a regenerated carrier has, it is far louder than
// anything else in the passband. And the rejected sideband's skirt has to be
// somewhere: with the edge here and the transition below, the filter is down
// to its stopband by a few tens of hertz on the *far* side of the carrier, so a
// heterodyne a hundred hertz into the other sideband is gone rather than
// merely quieter. A broadcast has nothing below a hundred hertz worth hearing.
export const ECSS_LOW_EDGE = 100;

// The sideband filters' transition width. Fixed and tight rather than the
// proportional figure the other modes use: the rejected sideband is the whole
// point, and a 400 Hz skirt would let the first 200 Hz of it through.
export const ECSS_TRANSITION = 150;

// The tracking window: how far from the offset the carrier may be found, and
// followed. The default suits a click on the picture at the usual zoom; the
// ceiling is below half the tightest broadcast spacing (9 kHz) by a wide margin,
// so the loop cannot be walked onto the station next door.
export const TRACK_MIN = 50;
export const TRACK_MAX = 1000;
export const TRACK_DEFAULT = 300;

export const SIDEBANDS = ['auto', 'usb', 'lsb'];

// Where the tracker is. Published for the panel's readout.
export const ECSS_SEARCH = 'search';
export const ECSS_ACQUIRE = 'acquire';
export const ECSS_LOCKED = 'locked';
export const ECSS_HOLD = 'hold';

// ── the loop ─────────────────────────────────────────────────────────────────

// The carrier's own low-pass, ahead of the phase detector: two one-pole
// sections, which is a few degrees of lag at the loop's crossover rather than
// the hundred-plus samples of delay a FIR would put inside the loop.
const CARRIER_LP_HZ = 200;

// Noise bandwidths of the loop. Wide while acquiring, so the residual error the
// search leaves is pulled out in a few tens of milliseconds; narrow once locked,
// which is what makes the regenerated carrier cleaner than the received one.
// Ten hertz still follows ionospheric Doppler (a hertz or two) and a drifting
// transmitter with room to spare.
const LOOP_BN_ACQUIRE = 60;
const LOOP_BN_LOCKED = 10;
const LOOP_DAMPING = 0.707;

// The lock detector: the cosine of the phase error, smoothed. 1 when the
// carrier sits on the in-phase axis, 0 for a carrier the loop is not following
// and for noise.
const LOCK_SMOOTH_SEC = 0.06;
const LOCK_ON = 0.8;
const LOCK_OFF = 0.4;
// How long each verdict has to hold before the state changes.
const LOCK_CONFIRM_SEC = 0.1;
const ACQUIRE_TIMEOUT_SEC = 1.0;
const LOSS_CONFIRM_SEC = 0.5;

// The fade detector. The carrier's short-term power against its long-term
// power: ten decibels down is a fade, and while it lasts the loop coasts on the
// frequency it had instead of steering by a phase that is mostly noise.
const FADE_FAST_SEC = 0.01;
const FADE_SLOW_SEC = 1.5;
const FADE_RATIO = 0.1;
// A fade longer than this is not a fade, it is the carrier gone.
const FADE_GIVE_UP_SEC = 3;

// ── the search ───────────────────────────────────────────────────────────────

// Resolution of the carrier search, in hertz per bin. Six hertz is 170 ms of
// signal at 12 kHz: fine enough to preset the loop well inside its pull-in
// range, short enough that finding a carrier takes a third of a second.
const SEARCH_RES_HZ = 6;
// How far above the median of the neighbourhood the peak must stand. Noise
// alone reaches about 8 dB over the median across a hundred bins; a broadcast
// carrier in a 6 Hz bin stands 30 dB and more above its own sidebands.
const SEARCH_THRESHOLD_DB = 15;
// And the neighbourhood the median is taken over — wider than the window, so a
// narrow window still has enough bins for a median to mean something.
const SEARCH_NOISE_HZ = 1500;
// Two looks in a row, within this many bins of each other. A carrier holds
// still; a speech harmonic does not.
const SEARCH_CONFIRM_BINS = 2;
// A candidate the loop could not lock to — a steady tone in the programme, a
// sideband with no carrier — is left alone for this long, and so is anything
// within this many search bins of it. Without it the search finds the same
// tone every third of a second and tries it again.
const REJECT_SEC = 10;
const REJECT_BINS = 3;

// ── the sideband choice ──────────────────────────────────────────────────────
//
// Once the carrier is at DC, a clean AM signal is real: its spectrum is
// conjugate-symmetric, Z(-f) = conj(Z(f)), and so Z(f)·Z(-f) = |Z(f)|². That
// product, averaged over time, keeps whatever the two sidebands have in common
// and averages away whatever they do not — so for each sideband the power in
// excess of it is interference that sideband has and the other lacks.
//
// Selective fading also breaks the symmetry, and it is the thing that must not
// cause a switch: it is momentary and it moves, so it lands on each sideband in
// turn. Interference sits still. So the figures are averaged over seconds, and
// a switch needs one sideband's excess to be twice the other's, to be a real
// share of the programme's power, and the last switch to be a while ago.
const SIDE_FFT_SIZE = 512;
const SIDE_AVERAGE_SEC = 4;
const SIDE_WARMUP_SEC = 1.5;
const SIDE_MIN_DWELL_SEC = 3;
const SIDE_RATIO = 2;
const SIDE_MIN_SHARE = 0.05;
// The changeover between the two sidebands' audio.
const SIDE_FADE_SEC = 0.03;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const coeff = (rate, sec) => 1 - Math.exp(-1 / (rate * sec));
const TWO_PI = 2 * Math.PI;

function median(values) {
    const a = Float64Array.from(values).sort();
    const n = a.length;
    if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Proportional and integral gains of a second-order loop, per sample. */
function loopGains(bnHz, rate) {
    const z = LOOP_DAMPING;
    const wn = (2 * bnHz) / (z + 1 / (4 * z));
    const wT = wn / rate;
    return { kp: 2 * z * wT, ki: wT * wT };
}

/**
 * One sideband filter: a real low-pass run on a signal rotated so the
 * sideband's centre sits at DC, then rotated back.
 *
 * The rotation back is by the phase the sample had when it went *in*, not when
 * it comes out — the filter is linear-phase with a delay of (n-1)/2 samples, and
 * undoing a rotation with the wrong phase is a fixed phase shift of the whole
 * sideband, which is not a thing an ear hears but is a thing that stops the
 * output being the signal.
 */
class SidebandFilter {
    constructor() {
        this.n = 0;
        this.bufI = null;
        this.bufQ = null;
        this.pos = 0;
    }

    size(n) {
        if (n === this.n) return;
        this.n = n;
        this.bufI = new Float32Array(n * 2);
        this.bufQ = new Float32Array(n * 2);
        this.pos = 0;
    }

    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
    }
}

/**
 * The carrier tracker and sideband detector.
 *
 * Fed the raw quadrature and the plan; produces audio and the passband power
 * per sample, which the chain in lib/iqDemod.js then squelches, levels and
 * plays exactly as it does for every other mode.
 */
export class EcssTracker {
    constructor() {
        this.rate = 0;
        this.centreHz = null;
        this.plan = null;
        this.taps = null;
        this.usb = new SidebandFilter();
        this.lsb = new SidebandFilter();
        this.searchN = 0;
        this.searchI = null;
        this.searchQ = null;
        this.searchWin = null;
        this.sideI = new Float32Array(SIDE_FFT_SIZE);
        this.sideQ = new Float32Array(SIDE_FFT_SIZE);
        this.sideWin = hannWindow(SIDE_FFT_SIZE);
        this.sidePu = new Float64Array(SIDE_FFT_SIZE / 2);
        this.sidePl = new Float64Array(SIDE_FFT_SIZE / 2);
        this.sideCr = new Float64Array(SIDE_FFT_SIZE / 2);
        this.sideCi = new Float64Array(SIDE_FFT_SIZE / 2);
        this.reset();
    }

    /** Forget the carrier. Starting is not resuming. */
    reset() {
        this.phase = 0;
        this.freq = 0; // the loop's correction, radians per sample
        this.c1i = 0; this.c1q = 0;
        this.c2i = 0; this.c2q = 0;
        this.lockRe = 0;
        this.lockMag = 0;
        this.fast = 0;
        this.slow = 0;
        this.state = ECSS_SEARCH;
        this.timer = 0; // samples the current verdict has held
        this.fading = 0; // samples the current fade has lasted
        this.acqAge = 0; // samples spent acquiring
        // What the audio is demodulated against when the loop is not locked:
        // the last carrier it was locked to, as a correction from the offset.
        // Kept apart from the loop's own oscillator so an acquisition that
        // turns out to be wrong is never heard as the pitch sliding about.
        this.audioPhase = 0;
        this.commit = 0;
        // Whether `commit` is a carrier or just the offset. Only a carrier is
        // held in place when the offset moves; before there has been one, the
        // audio follows the offset exactly as USB or LSB would.
        this.committed = false;
        this.clock = 0;
        this.rejects = [];
        this.candidate = 0;
        this.searchFill = 0;
        this.lastPeak = null;
        this.bandPhase = 0;
        this.usb.reset();
        this.lsb.reset();
        this.side = 'usb';
        this.sideMix = 0; // 0 all USB, 1 all LSB
        this._resetSideStats();
    }

    _resetSideStats() {
        this.sideFill = 0;
        this.sideAge = 0;
        this.sideDwell = 0;
        this.sidePu.fill(0);
        this.sidePl.fill(0);
        this.sideCr.fill(0);
        this.sideCi.fill(0);
        this.excessU = 0;
        this.excessL = 0;
    }

    /** Where the carrier is, in hertz from the offset. */
    get carrierHz() {
        return (this.freq * this.rate) / TWO_PI;
    }

    get locked() {
        return this.state === ECSS_LOCKED || this.state === ECSS_HOLD;
    }

    /**
     * Point the tracker at a plan, with the sideband filters the chain designed.
     *
     * The carrier is held in absolute terms across an offset change: moving the
     * offset by Δ moves the loop's correction by -Δ, so a drag across a station
     * keeps it locked until the station has left the tracking window — which is
     * what tuning near a carrier should feel like.
     */
    configure(plan, rate, taps) {
        const rateChanged = this.rate !== rate;
        if (!rateChanged && this.centreHz != null && plan.centreHz !== this.centreHz) {
            const moved = (TWO_PI * (plan.centreHz - this.centreHz)) / rate;
            if (this.committed) {
                this.freq -= moved;
                this.commit -= moved;
            } else if (this.state !== ECSS_SEARCH) {
                this.freq -= moved;
            }
            this.candidate -= plan.centreHz - this.centreHz;
            for (const r of this.rejects) r.hz -= plan.centreHz - this.centreHz;
        }
        this.rate = rate;
        this.centreHz = plan.centreHz;
        this.plan = plan;
        this.taps = taps;
        this.usb.size(taps.length);
        this.lsb.size(taps.length);
        const n = 2 ** Math.max(8, Math.round(Math.log2(rate / SEARCH_RES_HZ)));
        if (n !== this.searchN) {
            this.searchN = n;
            this.searchI = new Float32Array(n);
            this.searchQ = new Float32Array(n);
            this.searchWin = hannWindow(n);
            this.searchFill = 0;
        }
        if (rateChanged) this.reset();
        if (plan.sideband === 'usb' || plan.sideband === 'lsb') this.side = plan.sideband;
        const limit = (TWO_PI * this._range()) / rate;
        if (Math.abs(this.commit) > limit) {
            this.commit = 0;
            this.committed = false;
        }
        if (Math.abs(this.freq) > limit) {
            this._search();
            this.freq = this.commit;
        }
    }

    _range() {
        return clamp(Number(this.plan && this.plan.trackHz) || TRACK_DEFAULT, TRACK_MIN, TRACK_MAX);
    }

    /** Back to looking. Where the loop is left is the caller's business. */
    _search() {
        this.state = ECSS_SEARCH;
        this.timer = 0;
        this.fading = 0;
        this.searchFill = 0;
        this.lastPeak = null;
        this._resetSideStats();
    }

    /**
     * Run a block. Writes audio into `out` and the passband power into `pow`,
     * both `frames` long.
     */
    process(planeI, planeQ, frames, out, pow) {
        const rate = this.rate;
        const taps = this.taps;
        const n = taps.length;
        const w0 = (TWO_PI * this.centreHz) / rate;
        const range = this._range();
        const maxFreq = (TWO_PI * range * 1.2) / rate;

        const lpA = coeff(rate, 1 / (TWO_PI * CARRIER_LP_HZ));
        const lockA = coeff(rate, LOCK_SMOOTH_SEC);
        const fastA = coeff(rate, FADE_FAST_SEC);
        const slowA = coeff(rate, FADE_SLOW_SEC);
        const sideA = coeff(rate, SIDE_FADE_SEC);
        const acq = loopGains(LOOP_BN_ACQUIRE, rate);
        const trk = loopGains(LOOP_BN_LOCKED, rate);
        const lockConfirm = Math.round(rate * LOCK_CONFIRM_SEC);
        const acqTimeout = Math.round(rate * ACQUIRE_TIMEOUT_SEC);
        const lossConfirm = Math.round(rate * LOSS_CONFIRM_SEC);
        const fadeGiveUp = Math.round(rate * FADE_GIVE_UP_SEC);

        // The sideband filters' centre and the constant that undoes their delay.
        const edge = ECSS_LOW_EDGE;
        const bandHz = (edge + this.plan.widthHz) / 2;
        const bandStep = (TWO_PI * bandHz) / rate;
        const delay = (n - 1) / 2;
        const dc = Math.cos(bandStep * delay);
        const ds = Math.sin(bandStep * delay);

        const auto = this.plan.sideband !== 'usb' && this.plan.sideband !== 'lsb';
        const U = this.usb;
        const L = this.lsb;
        const uI = U.bufI; const uQ = U.bufQ;
        const lI = L.bufI; const lQ = L.bufQ;

        let { phase, freq, c1i, c1q, c2i, c2q, lockRe, lockMag, fast, slow } = this;
        let { timer, fading, acqAge, bandPhase, sideMix, audioPhase, commit } = this;
        let pos = U.pos;
        // Back to searching, with the loop put back on the last good carrier
        // (or the offset, if there has not been one) — `keep` leaves it where
        // it is, for a carrier that is probably still there.
        const lose = (keep) => {
            this._search();
            timer = 0;
            fading = 0;
            acqAge = 0;
            if (!keep) freq = commit;
        };
        const commitMax = (TWO_PI * range) / rate;

        for (let k = 0; k < frames; k++) {
            // 1 — derotate by the one oscillator.
            const pc = Math.cos(phase);
            const ps = Math.sin(phase);
            const xi = planeI[k];
            const xq = planeQ[k];
            // x · e^(-jφ).
            const di = xi * pc + xq * ps;
            const dq = xq * pc - xi * ps;

            // 2 — the carrier, and the loop.
            c1i += lpA * (di - c1i);
            c1q += lpA * (dq - c1q);
            c2i += lpA * (c1i - c2i);
            c2q += lpA * (c1q - c2q);
            const cp = c2i * c2i + c2q * c2q;
            fast += fastA * (cp - fast);
            slow += slowA * (cp - slow);
            const fade = this.state !== ECSS_SEARCH && fast < FADE_RATIO * slow;

            let err = 0;
            if (this.state !== ECSS_SEARCH && !fade && cp > 0) {
                err = Math.atan2(c2q, c2i);
                const g = this.state === ECSS_ACQUIRE ? acq : trk;
                freq += g.ki * err;
                if (freq > maxFreq) freq = maxFreq;
                else if (freq < -maxFreq) freq = -maxFreq;
                err *= g.kp;
                const mag = Math.sqrt(cp);
                lockRe += lockA * (c2i - lockRe);
                lockMag += lockA * (mag - lockMag);
            }
            // Offset plus correction, and the proportional kick: a carrier
            // ahead of the oscillator (err > 0) pulls it forward.
            phase += w0 + freq + err;

            // 3 — the state machine, sample by sample so its timings are exact.
            if (this.state === ECSS_SEARCH) {
                this.searchI[this.searchFill] = di;
                this.searchQ[this.searchFill] = dq;
                if (++this.searchFill === this.searchN) {
                    this.searchFill = 0;
                    this.freq = freq;
                    const hit = this._look(range, this.clock + k);
                    if (hit != null) {
                        this.candidate = hit;
                        freq = (TWO_PI * hit) / rate;
                        this.state = ECSS_ACQUIRE;
                        timer = 0;
                        fading = 0;
                        acqAge = 0;
                        lockRe = 0;
                        lockMag = 0;
                        // The carrier estimate starts from the carrier, not from
                        // whatever the low-pass had drifted to while searching.
                        c1i = 0; c1q = 0; c2i = 0; c2q = 0;
                        fast = 0; slow = 0;
                    }
                }
            } else if (this.state === ECSS_ACQUIRE && ++acqAge > acqTimeout) {
                // Not the carrier the search thought it was. Set aside, so the
                // next look does not find it again.
                this.rejects.push({ hz: this.candidate, until: this.clock + k + rate * REJECT_SEC });
                lose(false);
            } else if (Math.abs(freq) >= maxFreq) {
                // Pinned against the edge of the window: whatever it is
                // following is not in it.
                if (this.state === ECSS_ACQUIRE) {
                    this.rejects.push({ hz: this.candidate, until: this.clock + k + rate * REJECT_SEC });
                }
                if (Math.abs(commit) > commitMax) {
                    commit = 0;
                    this.committed = false;
                }
                lose(false);
            } else if (fade) {
                if (this.state === ECSS_LOCKED) this.state = ECSS_HOLD;
                if (++fading > fadeGiveUp) lose(false);
            } else {
                fading = 0;
                if (this.state === ECSS_HOLD) this.state = ECSS_LOCKED;
                const q = lockMag > 0 ? lockRe / lockMag : 0;
                if (this.state === ECSS_ACQUIRE) {
                    timer = q > LOCK_ON ? timer + 1 : 0;
                    if (timer >= lockConfirm) {
                        this.state = ECSS_LOCKED;
                        timer = 0;
                        this._resetSideStats();
                    }
                } else {
                    timer = q < LOCK_OFF ? timer + 1 : 0;
                    // Kept on the frequency it had: a carrier briefly swamped is
                    // most likely still there, and the search starts from it.
                    if (timer >= lossConfirm) lose(true);
                }
            }

            // The audio's own reference. Locked, it is the loop; otherwise it
            // coasts on the last carrier the loop held.
            let ai = di;
            let aq = dq;
            if (this.state === ECSS_LOCKED || this.state === ECSS_HOLD) {
                commit = freq;
                audioPhase = phase;
                this.committed = true;
            } else {
                const ac = Math.cos(audioPhase);
                const as = Math.sin(audioPhase);
                ai = xi * ac + xq * as;
                aq = xq * ac - xi * as;
                audioPhase += w0 + commit;
            }

            // 4 — the two sidebands. Each is rotated to DC, low-passed and
            // rotated back.
            const bc = Math.cos(bandPhase);
            const bs = Math.sin(bandPhase);
            bandPhase += bandStep;
            // Rotated back by the phase the sample went in with: e^(±jθ(k-D)).
            const oc = bc * dc + bs * ds;
            const os = bs * dc - bc * ds;

            // Both delay lines are always fed, so either can be switched to
            // without a filter refilling; only the audible one is convolved.
            const wantU = sideMix < 1;
            const wantL = sideMix > 0;

            // USB: a · e^(-jθ) in, · e^(+jθ) out.
            const ui = ai * bc + aq * bs;
            const uq = aq * bc - ai * bs;
            uI[pos] = ui; uI[pos + n] = ui;
            uQ[pos] = uq; uQ[pos + n] = uq;
            // LSB: a · e^(+jθ) in, · e^(-jθ) out.
            const li = ai * bc - aq * bs;
            const lq = aq * bc + ai * bs;
            lI[pos] = li; lI[pos + n] = li;
            lQ[pos] = lq; lQ[pos + n] = lq;
            pos = pos + 1 === n ? 0 : pos + 1;

            let yU = 0; let pU = 0;
            let yL = 0; let pL = 0;
            if (wantU) {
                let fi = 0; let fq = 0;
                for (let t = 0; t < n; t++) {
                    const h = taps[t];
                    fi += h * uI[pos + t];
                    fq += h * uQ[pos + t];
                }
                yU = fi * oc - fq * os;
                pU = fi * fi + fq * fq;
            }
            if (wantL) {
                let fi = 0; let fq = 0;
                for (let t = 0; t < n; t++) {
                    const h = taps[t];
                    fi += h * lI[pos + t];
                    fq += h * lQ[pos + t];
                }
                yL = fi * oc + fq * os;
                pL = fi * fi + fq * fq;
            }

            const target = this.side === 'lsb' ? 1 : 0;
            sideMix += sideA * (target - sideMix);
            if (Math.abs(target - sideMix) < 1e-4) sideMix = target;
            out[k] = yU * (1 - sideMix) + yL * sideMix;
            // The carrier counts as signal. It is outside the sideband filter
            // by design, but it is the steadiest measure of whether a station
            // is there: a squelch or meter reading only the programme would
            // close in every pause between words.
            pow[k] = pU * (1 - sideMix) + pL * sideMix + cp;

            // 5 — the sideband statistics, only while there is a carrier for
            // "the same on both sides" to be measured against.
            if (auto && this.state === ECSS_LOCKED) {
                this.sideI[this.sideFill] = di;
                this.sideQ[this.sideFill] = dq;
                if (++this.sideFill === SIDE_FFT_SIZE) {
                    this.sideFill = 0;
                    this._sideLook();
                }
            }
        }

        U.pos = pos;
        L.pos = pos;
        this.phase = phase % TWO_PI;
        this.audioPhase = audioPhase % TWO_PI;
        this.commit = commit;
        this.clock += frames;
        if (this.rejects.length) this.rejects = this.rejects.filter((r) => r.until > this.clock);
        this.bandPhase = bandPhase % TWO_PI;
        this.freq = freq;
        this.c1i = c1i; this.c1q = c1q;
        this.c2i = c2i; this.c2q = c2q;
        this.lockRe = lockRe;
        this.lockMag = lockMag;
        this.fast = fast;
        this.slow = slow;
        this.timer = timer;
        this.fading = fading;
        this.acqAge = acqAge;
        this.sideMix = sideMix;
    }

    /**
     * One look for a carrier in the search buffer. Returns its offset from the
     * offset in hertz, or null.
     */
    _look(range, now) {
        const N = this.searchN;
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        const win = this.searchWin;
        for (let i = 0; i < N; i++) {
            re[i] = this.searchI[i] * win[i];
            im[i] = this.searchQ[i] * win[i];
        }
        fftInPlace(re, im);
        const bin = this.rate / N;
        const here = this.carrierHz; // the search buffer was taken at this correction
        const nyq = N / 2;
        const powAt = (k) => {
            const j = ((k % N) + N) % N;
            return re[j] * re[j] + im[j] * im[j];
        };

        // The window, in bins relative to the oscillator.
        const lo = Math.ceil((-range - here) / bin);
        const hi = Math.floor((range - here) / bin);
        const noiseHalf = Math.max(SEARCH_NOISE_HZ, range * 2) / bin;
        const nlo = Math.max(-nyq + 1, Math.round(-noiseHalf - here / bin));
        const nhi = Math.min(nyq - 1, Math.round(noiseHalf - here / bin));
        if (hi < lo) return null;

        const rejected = this.rejects
            .filter((r) => r.until > now)
            .map((r) => (r.hz - here) / bin);
        let best = -1;
        let bestK = 0;
        for (let k = Math.max(lo, -nyq + 2); k <= Math.min(hi, nyq - 2); k++) {
            if (rejected.some((r) => Math.abs(r - k) <= REJECT_BINS)) continue;
            const p = powAt(k);
            // A peak, not the shoulder of one: the edge of the window next to
            // a strong line just outside it is high, and is not a carrier.
            if (p <= powAt(k - 1) || p <= powAt(k + 1)) continue;
            if (p > best) { best = p; bestK = k; }
        }
        const around = [];
        for (let k = nlo; k <= nhi; k++) around.push(powAt(k));
        const floor = median(around);
        const strong = best > 0 && floor >= 0 && best >= floor * 10 ** (SEARCH_THRESHOLD_DB / 10);
        if (!strong) {
            this.lastPeak = null;
            return null;
        }
        const previous = this.lastPeak;
        this.lastPeak = bestK;
        if (previous == null || Math.abs(previous - bestK) > SEARCH_CONFIRM_BINS) return null;

        // Parabolic interpolation on the log magnitude, which for a Hann window
        // puts a tone within a few percent of a bin of where it really is.
        const a = Math.log(powAt(bestK - 1) + 1e-30);
        const b = Math.log(best + 1e-30);
        const c = Math.log(powAt(bestK + 1) + 1e-30);
        const den = a - 2 * b + c;
        const frac = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
        const hz = here + (bestK + frac) * bin;
        return Math.abs(hz) <= range ? hz : null;
    }

    /** One block of sideband statistics, and the decision they feed. */
    _sideLook() {
        const N = SIDE_FFT_SIZE;
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            re[i] = this.sideI[i] * this.sideWin[i];
            im[i] = this.sideQ[i] * this.sideWin[i];
        }
        fftInPlace(re, im);

        const bin = this.rate / N;
        const blockSec = N / this.rate;
        const a = 1 - Math.exp(-blockSec / SIDE_AVERAGE_SEC);
        const k0 = Math.max(1, Math.ceil((ECSS_LOW_EDGE + ECSS_TRANSITION) / bin));
        const k1 = Math.min(N / 2 - 1, Math.floor(this.plan.widthHz / bin));
        let exU = 0;
        let exL = 0;
        let common = 0;
        for (let k = k0; k <= k1; k++) {
            const ur = re[k]; const ui = im[k];
            const lr = re[N - k]; const li = im[N - k];
            this.sidePu[k] += a * (ur * ur + ui * ui - this.sidePu[k]);
            this.sidePl[k] += a * (lr * lr + li * li - this.sidePl[k]);
            // U · L: |Z(f)|² for a clean AM signal whatever the loop's residual
            // phase, and zero on average for anything the two do not share.
            this.sideCr[k] += a * (ur * lr - ui * li - this.sideCr[k]);
            this.sideCi[k] += a * (ur * li + ui * lr - this.sideCi[k]);
            const c = Math.hypot(this.sideCr[k], this.sideCi[k]);
            common += c;
            exU += Math.max(0, this.sidePu[k] - c);
            exL += Math.max(0, this.sidePl[k] - c);
        }
        this.excessU = exU;
        this.excessL = exL;
        this.sideAge += blockSec;
        this.sideDwell += blockSec;
        if (this.sideAge < SIDE_WARMUP_SEC || this.sideDwell < SIDE_MIN_DWELL_SEC) return;

        const mine = this.side === 'usb' ? exU : exL;
        const other = this.side === 'usb' ? exL : exU;
        const total = common + Math.min(exU, exL);
        if (mine > SIDE_RATIO * other && mine - other > SIDE_MIN_SHARE * total) {
            this.side = this.side === 'usb' ? 'lsb' : 'usb';
            this.sideDwell = 0;
        }
    }
}
