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
// ── SAM ──────────────────────────────────────────────────────────────────────
//
// Synchronous AM is the same tracker with a simpler ending: one filter
// straddling the recovered carrier, and the in-phase part of what comes out,
// which is the whole double-sideband programme with the carrier as DC for the
// chain's DC block to take off. That is ECSS's Both with the two sidebands
// always weighted equally — the same 3 dB on a clean channel, none of the
// per-frequency defence against fading or interference — for a tenth of the
// latency, a third of the cost, and the bass the sideband filters' low edge
// cuts. Unlocked, it is envelope AM, as a SAM receiver's fallback always is,
// crossfaded so a lock gained or lost is not a click.
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

// How far inside the stream's edge a sideband filter's nominal edge must stop,
// so its skirt does too. Half the transition: the skirt runs that far past the
// nominal edge.
const EDGE_GUARD = ECSS_TRANSITION / 2;
// Effective widths are rounded down to this, so a carrier drifting by a hertz
// does not redesign a filter every packet.
const WIDTH_QUANTUM = 25;
// And never trimmed below this, however near the edge the carrier sits.
const WIDTH_FLOOR = 300;

// The tracking window: how far from the offset the carrier may be found, and
// followed. The default suits a click on the picture at the usual zoom; the
// ceiling is below half the tightest broadcast spacing (9 kHz) by a wide margin,
// so the loop cannot be walked onto the station next door.
export const TRACK_MIN = 50;
export const TRACK_MAX = 1000;
export const TRACK_DEFAULT = 300;

export const SIDEBANDS = ['both', 'auto', 'usb', 'lsb'];

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

// ── holding through a fade ───────────────────────────────────────────────────
//
// Coasting on the last frequency keeps the pitch right, which is all a single
// sideband needs. SAM needs the phase as well — its output is the programme
// times the cosine of the phase error — and a transmitter drifting a tenth of
// a hertz a second has turned a 2.5 s coast into 117 degrees of it: the
// programme inverted and 7 dB down.
//
// Two things keep the phase through a fade.
//
//   The sidebands. A double-sideband signal carries its carrier's phase in the
//   programme as well as in the carrier: if z = m·e^(jφ) with m real, then
//   z² = m²·e^(2jφ) whatever m is doing, so half the angle of z², averaged,
//   is φ — the Costas loop's detector. Its half-cycle ambiguity does not arise
//   here: the loop comes into a hold already locked, and turning by half a
//   cycle would take far more error than a hold accumulates.
//
//   The drift. Silence in the programme during a fade leaves the sidebands
//   nothing to say, so the loop also carries on at the rate its frequency was
//   changing before the fade, not merely at the frequency.
const COSTAS_LP_HZ = 3000;
const COSTAS_SMOOTH_SEC = 0.03;
// How consistent z² must be — |E[z²]| / E[|z|²], 1 for pure double sideband
// and 0 for noise — before it is allowed to steer.
const COSTAS_MIN_CONFIDENCE = 0.3;
const LOOP_BN_HOLD = 4;
// The drift, averaged over this long while locked, and never believed beyond
// the ceiling: no broadcast transmitter drifts faster.
const DRIFT_SMOOTH_SEC = 2;
const DRIFT_MAX_HZ_PER_SEC = 5;

// The carrier frequency as read out, averaged over this long. The loop's own
// estimate wanders by a fraction of a hertz from one packet to the next —
// that is the loop doing its job — and a readout to the hertz that reflected
// it would flicker whenever the carrier sat near a half. Double-exponential, so
// a drifting carrier is read where it is rather than a time constant behind.
const READOUT_SMOOTH_SEC = 1;

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

// ── both sidebands ───────────────────────────────────────────────────────────
//
// Throwing a sideband away costs 3 dB: both carry the programme, and added in
// phase the programme doubles in amplitude while their independent noise only
// doubles in power. Selective fading costs more, and in a way no single choice
// of sideband can answer: a notch sweeping through takes out one frequency on
// one side while the same frequency on the other side is fine.
//
// So Both combines them frequency by frequency. A short-time transform splits
// each sideband into bins, and in each bin each side is weighted by
// maximal-ratio combining — its own signal amplitude over its own noise power:
//
//   noise        what the side has beyond what the two share, averaged over
//                seconds: the band's noise, plus interference that side alone
//                carries. The same measure Auto switches on, per bin.
//   signal       what the side has right now beyond that noise, over a tenth
//                of a second: which is what a sweeping fade takes away.
//
// Clean on both sides, the weights are equal and the full 3 dB is had. A
// heterodyne or splatter on one side makes that side's noise large there and
// its weight small; a fade does the same through the signal term — per bin,
// and only for as long as it lasts.
const COMBINE_FFT_SIZE = 512;
const COMBINE_SHORT_SEC = 0.25;
const COMBINE_LONG_SEC = 4;
// Until the long average has something in it, the two sides are averaged.
const COMBINE_WARMUP_SEC = 1.5;
// Shrinkage, for the bins where the estimates are mostly noise. Both sides'
// signal estimates get the same small allowance, this fraction (as power) of
// the two noises' geometric mean, so a bin too weak to judge falls back to
// weighting each side by the inverse of its noise: equal on a clean channel,
// and on a bin with interference on one side and nothing on either, that side
// all but shut — which weighting by amplitude alone would only half do.
const COMBINE_NOISE_SHARE = 0.01;
// Interference, per bin. The weights above are only as good as each side's
// noise estimate, and a strong interferer corrupts the *clean* side's: its
// beat against the programme leaves a residue in the shared term that the long
// average does not fully remove, so the clean side looks noisier than it is
// and the dirty side keeps weight it should not have. So, as Auto does for the
// whole band, a side with clearly more unshared power than the other is taken
// to have interference in that bin and is faded out — from this ratio (in dB)
// up to full at the second. Measured: at 2..6 dB splatter and heterodynes are
// removed as completely as Auto removes them, for 0.4 dB of the diversity gain
// on the slowest fading tried; at 6..12 dB splatter leaked through at -36 dB.
const COMBINE_INTERFERENCE_DB = [2, 6];
// And the short-term estimates are shared with this many bins either side.
// The two sidebands' difference moves smoothly across frequency — a millisecond
// of echo turns it once a kilohertz, a few degrees across the neighbourhood —
// so the neighbours are measuring nearly the same thing, and five of them
// average the noise out of it five times faster than time alone could.
const COMBINE_SPREAD_BINS = 2;

// SAM's filter, like AM's, has a skirt proportional to its width, up to 400 Hz;
// this keeps the whole skirt inside the stream wherever the carrier is found.
const SAM_EDGE_GUARD = 200;
// The changeover between envelope and synchronous detection.
const SAM_FADE_SEC = 0.03;

// ── the level ────────────────────────────────────────────────────────────────
//
// The carrier is the one thing in an AM signal whose level does not depend on
// the programme, so it is what the gain is set from: steady volume through
// loud passages and quiet ones, no pumping, and no noise wound up in the
// pauses. Averaged slowly enough that the bass the carrier low-pass lets
// through does not modulate it, fast enough to follow a flat fade. Frozen
// while the carrier alone has faded, which is exactly when it stops being a
// measure of the signal.
const CARRIER_LEVEL_SEC = 0.15;
// And how far back the level is wound when a fade is declared. The fade
// detector takes a couple of tens of milliseconds to be sure, and by then the
// level has begun to follow the carrier down; this is the value it had before.
const CARRIER_LEVEL_REWIND_SEC = 0.04;

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
        this.taps = null;
        this.widthHz = 0;
        this.rate = 0;
        this.step = 0;
        this.phase = 0;
        this.dc = 1;
        this.ds = 0;
    }

    /**
     * Shape the filter for a sideband `widthHz` wide. Redesigned only when the
     * width or rate actually change. The delay line survives, since the tap
     * count depends on the fixed transition alone.
     */
    fit(widthHz, rate, design, centred = false) {
        if (widthHz === this.widthHz && rate === this.rate && this.taps) return;
        this.widthHz = widthHz;
        this.rate = rate;
        // Centred is SAM's: straddling the carrier, with AM's proportional
        // skirt, and no rotation either side of it.
        this.taps = centred
            ? design(widthHz / 2)
            : design((widthHz - ECSS_LOW_EDGE) / 2, ECSS_TRANSITION);
        const n = this.taps.length;
        if (n !== this.n) {
            this.n = n;
            this.bufI = new Float32Array(n * 2);
            this.bufQ = new Float32Array(n * 2);
            this.pos = 0;
        }
        // The centre, and the constant that undoes the filter's delay.
        this.step = centred ? 0 : (TWO_PI * ((ECSS_LOW_EDGE + widthHz) / 2)) / rate;
        const delay = (n - 1) / 2;
        this.dc = Math.cos(this.step * delay);
        this.ds = Math.sin(this.step * delay);
    }

    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
        this.phase = 0;
    }
}

/**
 * Both sidebands, combined per frequency. See "both sidebands" above.
 *
 * Streaming weighted overlap-add: square-root Hann in and out at half overlap,
 * which reconstructs exactly when nothing is changed. Fed the two sidebands as
 * analytic signals with their programme at positive frequencies — the lower
 * one conjugated to get it there — and returns the combined audio, a
 * transform's length late.
 */
class SidebandCombiner {
    constructor(size = COMBINE_FFT_SIZE) {
        const N = size;
        this.N = N;
        this.hop = N / 2;
        this.win = new Float64Array(N);
        for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((TWO_PI * i) / N));
        this.uR = new Float64Array(N); this.uI = new Float64Array(N);
        this.vR = new Float64Array(N); this.vI = new Float64Array(N);
        this.acc = new Float64Array(N);
        this.fifo = new Float64Array(N * 2);
        this.fr = { ur: new Float64Array(N), ui: new Float64Array(N), vr: new Float64Array(N), vi: new Float64Array(N) };
        this.su = new Float64Array(N); this.sv = new Float64Array(N);
        this.scr = new Float64Array(N); this.sci = new Float64Array(N);
        this.pu = new Float64Array(N); this.pv = new Float64Array(N);
        this.cr = new Float64Array(N); this.ci = new Float64Array(N);
        this.reset();
    }

    reset() {
        this.uR.fill(0); this.uI.fill(0); this.vR.fill(0); this.vI.fill(0);
        this.acc.fill(0);
        this.fifo.fill(0);
        // Primed so every push has an output: the transform's length, less one.
        this.rd = 0;
        this.wr = this.N - 1;
        this.fill = 0;
        this.resetStats();
    }

    resetStats() {
        this.su.fill(0); this.sv.fill(0); this.scr.fill(0); this.sci.fill(0);
        this.pu.fill(0); this.pv.fill(0); this.cr.fill(0); this.ci.fill(0);
        this.age = 0;
    }

    /**
     * One sample of each sideband in, one of audio out. `locked` says whether
     * the two are referred to a real carrier; without one they are not the same
     * programme, and only `side` is used.
     */
    push(ur, ui, vr, vi, rate, locked, side) {
        const f = this.fill;
        this.uR[f] = ur; this.uI[f] = ui;
        this.vR[f] = vr; this.vI[f] = vi;
        if (++this.fill === this.N) this._frame(rate, locked, side);
        const len = this.fifo.length;
        const y = this.fifo[this.rd];
        this.rd = (this.rd + 1) % len;
        return y;
    }

    _frame(rate, locked, side) {
        const { N, hop, win, fr } = this;
        for (let i = 0; i < N; i++) {
            fr.ur[i] = this.uR[i] * win[i]; fr.ui[i] = this.uI[i] * win[i];
            fr.vr[i] = this.vR[i] * win[i]; fr.vi[i] = this.vI[i] * win[i];
        }
        fftInPlace(fr.ur, fr.ui);
        fftInPlace(fr.vr, fr.vi);

        const dt = hop / rate;
        const aS = 1 - Math.exp(-dt / COMBINE_SHORT_SEC);
        const aL = 1 - Math.exp(-dt / COMBINE_LONG_SEC);
        const warm = this.age >= COMBINE_WARMUP_SEC;
        if (locked) this.age += dt;
        const lsbOnly = side === 'lsb';

        // First the statistics, for every bin, so the second pass can read its
        // neighbours'.
        if (locked) {
            for (let k = 0; k < N; k++) {
                const Ur = fr.ur[k]; const Ui = fr.ui[k];
                const Vr = fr.vr[k]; const Vi = fr.vi[k];
                const pU = Ur * Ur + Ui * Ui;
                const pV = Vr * Vr + Vi * Vi;
                // U · conj(V): the two sides' agreement, magnitude and phase.
                const xr = Ur * Vr + Ui * Vi;
                const xi = Ui * Vr - Ur * Vi;
                this.su[k] += aS * (pU - this.su[k]);
                this.sv[k] += aS * (pV - this.sv[k]);
                this.scr[k] += aS * (xr - this.scr[k]);
                this.sci[k] += aS * (xi - this.sci[k]);
                this.pu[k] += aL * (pU - this.pu[k]);
                this.pv[k] += aL * (pV - this.pv[k]);
                this.cr[k] += aL * (xr - this.cr[k]);
                this.ci[k] += aL * (xi - this.ci[k]);
            }
        }

        // The combined spectrum is written over the USB frame.
        const spread = COMBINE_SPREAD_BINS;
        const [iLo, iHi] = COMBINE_INTERFERENCE_DB;
        for (let k = 0; k < N; k++) {
            const Ur = fr.ur[k]; const Ui = fr.ui[k];
            const Vr = fr.vr[k]; const Vi = fr.vi[k];
            if (!locked) {
                if (lsbOnly) { fr.ur[k] = Vr; fr.ui[k] = Vi; }
                continue;
            }
            let wU = 1;
            let wV = 1;
            let turn = 0;
            if (warm) {
                // The neighbourhood's short-term figures, and this bin's own
                // long-term ones.
                let su = 0; let sv = 0; let xr = 0; let xi = 0; let cnt = 0;
                for (let j = k - spread; j <= k + spread; j++) {
                    if (j < 0 || j >= N) continue;
                    su += this.su[j]; sv += this.sv[j];
                    xr += this.scr[j]; xi += this.sci[j];
                    cnt++;
                }
                su /= cnt; sv /= cnt;
                const common = Math.hypot(this.cr[k], this.ci[k]);
                // Each side's noise floored against its own power, never the
                // pair's: in a bin with a heterodyne on one side, a shared
                // floor would credit the clean side with noise at the
                // heterodyne's level and cap how far the whistle is turned down.
                const nU = Math.max(this.pu[k] - common, 1e-6 * this.pu[k] + 1e-30);
                const nV = Math.max(this.pv[k] - common, 1e-6 * this.pv[k] + 1e-30);
                const sU = Math.max(su - nU, 0);
                const sV = Math.max(sv - nV, 0);
                const allowance = COMBINE_NOISE_SHARE * Math.sqrt(nU * nV);
                wU = Math.sqrt(sU + allowance) / nU;
                wV = Math.sqrt(sV + allowance) / nV;
                const lean = 10 * Math.log10(nU / nV);
                if (lean > iLo) wU *= Math.max(0, (iHi - lean) / (iHi - iLo));
                else if (-lean > iLo) wV *= Math.max(0, (iHi + lean) / (iHi - iLo));
                // The angle between the two sides, by the neighbourhood's
                // agreement: a fade moves their phases as well as their levels.
                if (xr !== 0 || xi !== 0) turn = Math.atan2(xi, xr);
            }
            // Each side is turned towards the other in proportion to the
            // other's weight, so the two meet in phase and the one carrying the
            // weight keeps its own. Turning V all the way onto U instead would
            // hand the programme U's phase even where U is the side with the
            // interference — a phase set by the whistle, not the station.
            const share = wU / (wU + wV);
            const tU = -turn * (1 - share);
            const tV = turn * share;
            const cU = Math.cos(tU); const sU2 = Math.sin(tU);
            const cV = Math.cos(tV); const sV2 = Math.sin(tV);
            fr.ur[k] = share * (Ur * cU - Ui * sU2) + (1 - share) * (Vr * cV - Vi * sV2);
            fr.ui[k] = share * (Ur * sU2 + Ui * cU) + (1 - share) * (Vr * sV2 + Vi * cV);
        }

        // Back to time: the inverse transform by conjugation, and its real part
        // is the audio, since what was combined is the programme's analytic
        // signal.
        for (let k = 0; k < N; k++) fr.ui[k] = -fr.ui[k];
        fftInPlace(fr.ur, fr.ui);
        const acc = this.acc;
        for (let i = 0; i < N; i++) acc[i] += (fr.ur[i] / N) * win[i];

        const len = this.fifo.length;
        for (let i = 0; i < hop; i++) {
            this.fifo[this.wr] = acc[i];
            this.wr = (this.wr + 1) % len;
        }
        acc.copyWithin(0, hop);
        acc.fill(0, N - hop);
        this.uR.copyWithin(0, hop); this.uI.copyWithin(0, hop);
        this.vR.copyWithin(0, hop); this.vI.copyWithin(0, hop);
        this.fill = N - hop;
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
        this.design = null;
        this.usb = new SidebandFilter();
        this.lsb = new SidebandFilter();
        this.dsb = new SidebandFilter();
        this.combiner = new SidebandCombiner();
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
        this.drift = 0; // its rate of change, radians per sample per sample
        this.k1i = 0; this.k1q = 0; this.k2i = 0; this.k2q = 0;
        this.z2r = 0; this.z2i = 0; this.zp = 0;
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
        this.smoothHz = null;
        this.smooth1 = 0;
        this.smooth2 = 0;
        this.searchFill = 0;
        this.lastPeak = null;
        this.usb.reset();
        this.lsb.reset();
        this.dsb.reset();
        this.syncMix = 0; // SAM: 0 envelope, 1 synchronous
        this.combiner.reset();
        this.level = 0;
        this.levelHistory = null;
        this.levelAt = 0;
        this.side = 'usb';
        this.sideMix = 0; // 0 all USB, 1 all LSB
        this._resetSideStats();
    }

    _resetSideStats() {
        if (this.combiner) this.combiner.resetStats();
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

    /**
     * The same, steadied for reading: averaged over a second while locked, and
     * the loop's own figure otherwise.
     */
    get readoutHz() {
        return this.smoothHz != null ? this.smoothHz : this.carrierHz;
    }

    get locked() {
        return this.state === ECSS_LOCKED || this.state === ECSS_HOLD;
    }

    /**
     * Point the tracker at a plan. `design(cutoffHz, transitionHz)` is the
     * chain's low-pass designer, so both sidebands' filters are built the same
     * way every other mode's is.
     *
     * The carrier is held in absolute terms across an offset change: moving the
     * offset by Δ moves the loop's correction by -Δ, so a drag across a station
     * keeps it locked until the station has left the tracking window — which is
     * what tuning near a carrier should feel like.
     */
    // `baseHz` is how far the stream has already been shifted before it gets
    // here — lib/iqDemod.js's decimating front end, on a wide IQ preset, mixes
    // the plan's centre down to zero before this sees a sample. The centre is
    // still kept in the dial's coordinates, so the bookkeeping below (which
    // moves the loop with the offset) is exactly what it was; only the mixing
    // and the room at the edges are taken relative to the stream it is given.
    configure(plan, rate, design, baseHz = 0) {
        this.baseHz = baseHz;
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
            if (this.smoothHz != null) {
                const d = plan.centreHz - this.centreHz;
                this.smoothHz -= d;
                this.smooth1 -= d;
                this.smooth2 -= d;
            }
            for (const r of this.rejects) r.hz -= plan.centreHz - this.centreHz;
        }
        this.rate = rate;
        this.centreHz = plan.centreHz;
        this.plan = plan;
        this.design = design;
        this._fit();
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

    /**
     * Trim each sideband to the room the stream has for it.
     *
     * The filters hang off the carrier the tracker found, not off the offset,
     * so a wide sideband above a carrier found high in the window can run past
     * the top of the stream. What lies past the edge of a complex stream is not
     * nothing: it is the *other* edge, wrapped round, so the top of the audio
     * would be whatever is sitting at the far side of the twelve kilohertz.
     * Each side is given the width asked for or the room there is, whichever is
     * less.
     */
    _fit() {
        const rate = this.rate;
        const ref = this.locked ? this.freq : this.commit;
        const at = this.centreHz - (this.baseHz || 0) + (ref * rate) / TWO_PI;
        const room = (side) => {
            const free = rate / 2 - EDGE_GUARD - side * at;
            const w = Math.min(this.plan.widthHz, free);
            return Math.max(WIDTH_FLOOR, Math.floor(w / WIDTH_QUANTUM) * WIDTH_QUANTUM);
        };
        this.usb.fit(room(1), rate, this.design);
        this.lsb.fit(room(-1), rate, this.design);
        if (this.plan.kind === 'sam') {
            // Both sides at once, so the room is the nearer edge's.
            const free = 2 * (rate / 2 - SAM_EDGE_GUARD - Math.abs(at));
            const w = Math.min(this.plan.widthHz, free);
            this.dsb.fit(Math.max(WIDTH_FLOOR, Math.floor(w / WIDTH_QUANTUM) * WIDTH_QUANTUM), rate, this.design, true);
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
     * Run a block. Writes audio into `out`, the passband power into `pow`, and
     * into `ref` the carrier's amplitude for the AGC to level against — zero
     * where there is no carrier to trust — all `frames` long.
     */
    process(planeI, planeQ, frames, out, pow, ref) {
        const rate = this.rate;
        this._fit();
        const w0 = (TWO_PI * (this.centreHz - (this.baseHz || 0))) / rate;
        const range = this._range();
        const maxFreq = (TWO_PI * range * 1.2) / rate;

        const lpA = coeff(rate, 1 / (TWO_PI * CARRIER_LP_HZ));
        const lockA = coeff(rate, LOCK_SMOOTH_SEC);
        const fastA = coeff(rate, FADE_FAST_SEC);
        const slowA = coeff(rate, FADE_SLOW_SEC);
        const sideA = coeff(rate, SIDE_FADE_SEC);
        const acq = loopGains(LOOP_BN_ACQUIRE, rate);
        const trk = loopGains(LOOP_BN_LOCKED, rate);
        const hold = loopGains(LOOP_BN_HOLD, rate);
        const kA = coeff(rate, 1 / (TWO_PI * COSTAS_LP_HZ));
        const zA = coeff(rate, COSTAS_SMOOTH_SEC);
        const driftMax = (TWO_PI * DRIFT_MAX_HZ_PER_SEC) / (rate * rate);
        const lockConfirm = Math.round(rate * LOCK_CONFIRM_SEC);
        const acqTimeout = Math.round(rate * ACQUIRE_TIMEOUT_SEC);
        const lossConfirm = Math.round(rate * LOSS_CONFIRM_SEC);
        const fadeGiveUp = Math.round(rate * FADE_GIVE_UP_SEC);

        const sam = this.plan.kind === 'sam';
        const auto = !sam && this.plan.sideband === 'auto';
        const both = !sam && this.plan.sideband === 'both';
        const D = this.dsb;
        const syncA = coeff(rate, SAM_FADE_SEC);
        let syncMix = this.syncMix;
        const levelA = coeff(rate, CARRIER_LEVEL_SEC);
        let level = this.level;
        const rewind = Math.max(1, Math.round(rate * CARRIER_LEVEL_REWIND_SEC));
        if (!this.levelHistory || this.levelHistory.length !== rewind) {
            this.levelHistory = new Float32Array(rewind);
            this.levelAt = 0;
        }
        const history = this.levelHistory;
        let levelAt = this.levelAt;
        const combiner = this.combiner;
        const U = this.usb;
        const L = this.lsb;
        const uI = U.bufI; const uQ = U.bufQ; const uT = U.taps;
        const lI = L.bufI; const lQ = L.bufQ; const lT = L.taps;
        const n = U.n;
        let uPh = U.phase;
        let lPh = L.phase;

        let { phase, freq, c1i, c1q, c2i, c2q, lockRe, lockMag, fast, slow } = this;
        let { drift, k1i, k1q, k2i, k2q, z2r, z2i, zp } = this;
        const freqAtStart = freq;
        const lockedAtStart = this.state === ECSS_LOCKED;
        let { timer, fading, acqAge, sideMix, audioPhase, commit } = this;
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

            // The Costas arm: the programme, lightly low-passed, and the
            // running average of its square.
            k1i += kA * (di - k1i);
            k1q += kA * (dq - k1q);
            k2i += kA * (k1i - k2i);
            k2q += kA * (k1q - k2q);
            z2r += zA * (k2i * k2i - k2q * k2q - z2r);
            z2i += zA * (2 * k2i * k2q - z2i);
            zp += zA * (k2i * k2i + k2q * k2q - zp);

            let err = 0;
            if (fade && (this.state === ECSS_LOCKED || this.state === ECSS_HOLD)) {
                // Holding: carry on along the drift, and steer by the
                // sidebands wherever they are saying something.
                freq += drift;
                const m = Math.hypot(z2r, z2i);
                if (zp > 0 && m / zp > COSTAS_MIN_CONFIDENCE) {
                    err = 0.5 * Math.atan2(z2i, z2r);
                    freq += hold.ki * err;
                    err *= hold.kp;
                }
                if (freq > maxFreq) freq = maxFreq;
                else if (freq < -maxFreq) freq = -maxFreq;
            } else if (this.state !== ECSS_SEARCH && !fade && cp > 0) {
                err = Math.atan2(c2q, c2i);
                // Trusted less once the carrier has collapsed. The fade
                // detector takes a couple of tens of milliseconds to be sure,
                // and a carrier falling into the programme's bass steers the
                // loop wherever that bass points in the meantime: 14 degrees
                // of it, measured, before the hold could take over. Only below
                // a tenth of the carrier's usual power, though — the ordinary
                // swings of multipath are the carrier, and damping the loop
                // through those cost Both a few tenths of a decibel.
                if (this.state === ECSS_LOCKED && cp < 0.1 * slow) err *= cp / (0.1 * slow);
                const g = this.state === ECSS_ACQUIRE ? acq : trk;
                freq += g.ki * err;
                if (freq > maxFreq) freq = maxFreq;
                else if (freq < -maxFreq) freq = -maxFreq;
                err *= g.kp;
                const mag = Math.sqrt(cp);
                lockRe += lockA * (c2i - lockRe);
                lockMag += lockA * (mag - lockMag);
                if (this.state === ECSS_LOCKED) level += levelA * (c2i - level);
            }
            // The oldest entry is the level `rewind` samples ago.
            const past = history[levelAt];
            history[levelAt] = level;
            levelAt = levelAt + 1 === rewind ? 0 : levelAt + 1;
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
                if (this.state === ECSS_LOCKED) {
                    this.state = ECSS_HOLD;
                    if (past > 0) level = past;
                }
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
                        // The level starts where the carrier is, not at zero,
                        // or the first moments of a lock are at full gain.
                        level = lockRe;
                        history.fill(level);
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

            // 4 — the two sidebands. Each is rotated so its centre sits at DC,
            // low-passed, and rotated back by the phase the sample went in with.
            // Both delay lines are always fed, so either can be switched to
            // without a filter refilling; only the audible one is convolved.
            const uc = Math.cos(uPh);
            const us = Math.sin(uPh);
            uPh += U.step;
            const lc = Math.cos(lPh);
            const ls = Math.sin(lPh);
            lPh += L.step;

            // USB: a · e^(-jθ) in, · e^(+jθ) out.
            const ui = ai * uc + aq * us;
            const uq = aq * uc - ai * us;
            uI[pos] = ui; uI[pos + n] = ui;
            uQ[pos] = uq; uQ[pos + n] = uq;
            // LSB: a · e^(+jθ) in, · e^(-jθ) out.
            const li = ai * lc - aq * ls;
            const lq = aq * lc + ai * ls;
            lI[pos] = li; lI[pos + n] = li;
            lQ[pos] = lq; lQ[pos + n] = lq;
            pos = pos + 1 === n ? 0 : pos + 1;

            let yU = 0; let pU = 0;
            let yL = 0; let pL = 0;
            let uaI = 0; let laI = 0;
            if (!sam && (both || sideMix < 1)) {
                let fi = 0; let fq = 0;
                for (let t = 0; t < n; t++) {
                    const h = uT[t];
                    fi += h * uI[pos + t];
                    fq += h * uQ[pos + t];
                }
                // e^(+jθ(k-D)).
                const oc = uc * U.dc + us * U.ds;
                const os = us * U.dc - uc * U.ds;
                yU = fi * oc - fq * os;
                uaI = fi * os + fq * oc;
                pU = fi * fi + fq * fq;
            }
            if (!sam && (both || sideMix > 0)) {
                let fi = 0; let fq = 0;
                for (let t = 0; t < n; t++) {
                    const h = lT[t];
                    fi += h * lI[pos + t];
                    fq += h * lQ[pos + t];
                }
                // e^(-jθ(k-D)).
                const oc = lc * L.dc + ls * L.ds;
                const os = ls * L.dc - lc * L.ds;
                yL = fi * oc + fq * os;
                laI = fq * oc - fi * os;
                pL = fi * fi + fq * fq;
            }

            const locked = this.state === ECSS_LOCKED || this.state === ECSS_HOLD;
            if (sam) {
                // One filter straddling the carrier, at DC once locked.
                const dn = D.n;
                const dI = D.bufI; const dQ = D.bufQ; const dT = D.taps;
                let dp = D.pos;
                dI[dp] = ai; dI[dp + dn] = ai;
                dQ[dp] = aq; dQ[dp + dn] = aq;
                dp = dp + 1 === dn ? 0 : dp + 1;
                D.pos = dp;
                let fi = 0; let fq = 0;
                for (let t = 0; t < dn; t++) {
                    const h = dT[t];
                    fi += h * dI[dp + t];
                    fq += h * dQ[dp + t];
                }
                const envelope = Math.sqrt(fi * fi + fq * fq);
                syncMix += syncA * ((locked ? 1 : 0) - syncMix);
                // Locked, the in-phase part is the carrier plus the programme
                // from both sidebands; the envelope is the same thing, less
                // well, so the two can be crossfaded without a step.
                out[k] = syncMix * fi + (1 - syncMix) * envelope;
                pow[k] = fi * fi + fq * fq;
            } else if (both) {
                // The lower sideband conjugated, so its programme is at
                // positive frequencies like the upper one's.
                out[k] = combiner.push(yU, uaI, yL, -laI, rate, locked, this.side);
                // Both sidebands are the passband, as the whole of both is in AM.
                pow[k] = pU + pL + cp;
            } else {
                const target = this.side === 'lsb' ? 1 : 0;
                sideMix += sideA * (target - sideMix);
                if (Math.abs(target - sideMix) < 1e-4) sideMix = target;
                out[k] = yU * (1 - sideMix) + yL * sideMix;
                // The carrier counts as signal. It is outside the sideband
                // filter by design, but it is the steadiest measure of whether
                // a station is there: a squelch or meter reading only the
                // programme would close in every pause between words.
                pow[k] = pU * (1 - sideMix) + pL * sideMix + cp;
            }
            // SAM hears both sidebands in phase, so twice one sideband's
            // amplitude for the same carrier: referred as twice the carrier,
            // it comes out at the same loudness as ECSS.
            ref[k] = locked && level > 0 ? (sam ? 2 * level : level) : 0;

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
        U.phase = uPh % TWO_PI;
        L.phase = lPh % TWO_PI;
        this.freq = freq;
        // The drift, from how far the locked frequency moved over the block —
        // only across a block that was locked throughout, so neither a hold
        // nor an acquisition is taken for a transmitter drifting.
        if (lockedAtStart && this.state === ECSS_LOCKED) {
            const a = 1 - Math.exp(-frames / (rate * DRIFT_SMOOTH_SEC));
            drift += a * ((freq - freqAtStart) / frames - drift);
            if (drift > driftMax) drift = driftMax;
            else if (drift < -driftMax) drift = -driftMax;
        } else if (this.state === ECSS_SEARCH || this.state === ECSS_ACQUIRE) {
            drift = 0;
        }
        this.drift = drift;
        this.k1i = k1i; this.k1q = k1q; this.k2i = k2i; this.k2q = k2q;
        this.z2r = z2r; this.z2i = z2i; this.zp = zp;
        if (this.locked) {
            const hz = this.carrierHz;
            const a = 1 - Math.exp(-frames / (rate * READOUT_SMOOTH_SEC));
            if (this.smoothHz == null) {
                this.smooth1 = hz;
                this.smooth2 = hz;
            } else {
                this.smooth1 += a * (hz - this.smooth1);
                this.smooth2 += a * (this.smooth1 - this.smooth2);
            }
            this.smoothHz = 2 * this.smooth1 - this.smooth2;
        } else if (this.state === ECSS_SEARCH) {
            // The next lock may be a different carrier.
            this.smoothHz = null;
        }
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
        this.syncMix = syncMix;
        this.level = level;
        this.levelAt = levelAt;
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
        // Half a bin of grace: a carrier on the very edge of the window is
        // interpolated to a hair either side of it.
        return Math.abs(hz) <= range + bin / 2 ? hz : null;
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
        // Over the width both sidebands actually have, so a side trimmed at
        // the stream's edge is not read as having lost its top to a fade.
        const shared = Math.min(this.usb.widthHz, this.lsb.widthHz);
        const k1 = Math.min(N / 2 - 1, Math.floor(shared / bin));
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
