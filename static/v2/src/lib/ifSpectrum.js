// The window either side of the dial, and the arithmetic for drawing it.
//
// The IF Spectrum panel is a magnifier held over the tuned frequency: the same
// bins the main waterfall is already receiving, cut to a few kHz around the
// dial and stretched across the panel. No second stream, no second radiod
// channel — the receiver sends one spectrum per session and this is a different
// way of reading it.
//
// Two things make it worth its own panel rather than being "zoom in on the main
// view":
//
//   * **It is shaped like the mode.** The window is what you are listening
//     *through*: the passband and the dial, with a quarter again around them.
//     AM's filter straddles the carrier so its window does too; USB's lies
//     entirely above it, so the window is almost all above it, and LSB's is the
//     mirror. It was symmetric about the dial at first, which reads well for AM
//     and CW and wastes half the panel on SSB — three kilohertz of nothing below
//     a carrier nobody is demodulating. The dial is always inside the window
//     with a little room, because it is the reference everything else is read
//     against, but it is not the middle. Zooming out is what adds equal context
//     to both sides — see windowFor.
//
//   * **It is dial-relative.** Tune, and the window travels with you: a signal
//     you are listening to sits at 0 and stays there. That is why the waterfall
//     history survives tuning — every row is a picture of "offset from where I
//     am listening", which stays true as the dial moves — and why the frequency
//     scale is drawn in offsets rather than megahertz.
//
// The drawing itself is in panels/IFSpectrumPanel.jsx. What is here is the part
// worth testing: the window rule, the resampling, the level tracking and the
// ruler.

import { approachFor } from './timeConstant.js';

// How much wider than the filter the window is, each side. The brief this was
// written to: "at least the bandwidth + 25%, both sides of the dial, whatever
// the mode".
export const FIT_MARGIN = 1.25;

// ...and the narrowest window worth drawing. A 200 Hz CW filter fits in 500 Hz,
// which is a legitimate thing to ask for and a hard thing to point at: under a
// finger, 500 Hz across a dock column is about 8 Hz a pixel and every tap lands
// on a different signal. This is a floor on the window, not on the filter — the
// shading still shows the filter at whatever width it is.
export const MIN_SPAN_HZ = 800;

// The least room the dial itself gets, whatever the margin works out to.
//
// The dial is the thing every reading on this pane is relative to, and on the
// sidebands the margin is all that keeps it on screen: a USB filter starts above
// the carrier, so a narrowed one — 300 Hz to 800 Hz, which is a normal thing to
// do to dig a signal out — would otherwise put its own window entirely above the
// dial and lose the zero the ruler is built around.
export const MIN_DIAL_PAD_HZ = 60;

// How far out the window may be opened, as a multiple of the fit — and how far
// in, which is not at all. Zooming past the fit would start cutting the filter
// out of the picture, and "the filter and a quarter, both sides of the dial" is
// the one promise this pane makes about what is on screen. So the wheel has a
// hard stop at 1 rather than a soft one, and the pane cannot be zoomed into a
// state where it is lying about what it covers.
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 32;
// A wheel notch. Coarser than the band chart's 1.4 because the whole travel is
// five octaves rather than a hundred: about eleven notches end to end.
export const ZOOM_STEP = 1.35;

export function clampZoom(v, max = ZOOM_MAX) {
    const n = Number(v);
    const hi = Math.max(ZOOM_MIN, Number.isFinite(max) ? max : ZOOM_MAX);
    if (!Number.isFinite(n) || n <= 0) return ZOOM_MIN;
    return Math.min(hi, Math.max(ZOOM_MIN, n));
}

/**
 * How far out this window may actually be opened, given what the server is
 * sending.
 *
 * ZOOM_MAX is the ceiling in the abstract; this is the one that bites. The
 * window can only ever be drawn from the bins in hand, so opening it past the
 * span of the served view buys nothing but empty canvas: at 50 Hz a bin the
 * receiver is sending 51 kHz, and a ×32 window on an SSB filter is 216 kHz —
 * three quarters of the panel with no measurement behind it, which looks like a
 * fault rather than like a choice.
 *
 * So the stop is the widest window that is measured *all the way across*, and
 * that is set by the nearer edge rather than by the span. The two are not the
 * same thing: this window is centred on the dial and the served view is centred
 * wherever the server last put it, and the main display only recentres when the
 * passband would otherwise leave the screen — so the dial sits off centre most
 * of the time. Measured as a span, a window as wide as the view still hangs off
 * one end of it by however far the dial has drifted, which is the flat left-hand
 * edge this replaces.
 *
 * When the main display is zoomed out to the whole band none of it binds and the
 * ceiling is ZOOM_MAX again.
 *
 * The *fit* is deliberately not clamped by any of this. A window narrower than
 * the filter would break the one promise this pane makes, so a view too narrow
 * — or a dial too near its edge — to contain even the fitted window draws gaps
 * instead, which is true and which reads as nothing rather than as signal.
 */
export function maxZoomFor(cfg, tuning) {
    if (!cfg || !(cfg.span > 0) || !tuning) return ZOOM_MAX;
    const fit = fitWindow(tuning.bandwidthLow, tuning.bandwidthHigh);
    if (!(fit.span > 0)) return ZOOM_MAX;
    const dial = Number(tuning.frequency) || 0;
    // Zoom adds `extra` to each side, so the stop is whichever side runs out
    // first — measured from the fitted edges, which are already off centre.
    const extra = Math.min(
        (dial + fit.lo) - (cfg.centerFreq - cfg.span / 2),
        (cfg.centerFreq + cfg.span / 2) - (dial + fit.hi),
    );
    if (!(extra > 0)) return ZOOM_MIN;      // the fitted window already overhangs
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 1 + (extra * 2) / fit.span));
}

/** Whether the window has been opened past the fit — i.e. there is a reset to offer. */
export function isZoomed(factor) {
    return clampZoom(factor) > ZOOM_MIN * 1.001;
}

/**
 * The fitted window as a pair of offsets from the dial — the shape the mode
 * gives it, before any zoom.
 *
 * What is being framed is the passband *and* the dial together, not the passband
 * alone: including 0 in the extent is what keeps the carrier on screen for a
 * one-sided filter, and what makes AM's window straddle the dial without any
 * special case for it. A quarter of that extent is then shared between the two
 * sides, which is the "bandwidth + 25%" the pane is built to.
 *
 * So USB comes out roughly −340 … +3040 against a 50–2700 filter, LSB the mirror
 * of it, and AM a symmetric ±6250 — each of them the shape of what you are
 * actually listening through.
 */
export function fitWindow(low, high) {
    const l = Number(low) || 0;
    const h = Number(high) || 0;
    const lo0 = Math.min(0, l, h);
    const hi0 = Math.max(0, l, h);
    const pad = Math.max((hi0 - lo0) * (FIT_MARGIN - 1) / 2, MIN_DIAL_PAD_HZ);
    let lo = lo0 - pad;
    let hi = hi0 + pad;
    // A filter too narrow to point at is opened out equally, which keeps
    // whatever shape the mode gave it.
    const short = MIN_SPAN_HZ - (hi - lo);
    if (short > 0) {
        lo -= short / 2;
        hi += short / 2;
    }
    return { lo, hi, span: hi - lo };
}

/**
 * The window to draw, in Hz: `{ dial, lo, hi, span, offLo, offHi }`.
 *
 * Zoom adds the same amount to each side rather than scaling the offsets. The
 * two are not the same, and the difference is the whole behaviour: scaled, a
 * USB window opened eight times would reach 24 kHz above the dial and 2.7 kHz
 * below it — the filter's own lopsidedness magnified into the context view,
 * where it means nothing. Added equally, the asymmetry stays the fixed few
 * hundred hertz the mode actually implies and everything beyond it is even. So
 * the pane is shaped like the mode when it is fitted to the filter, and shaped
 * like a spectrum when it is opened out to look around.
 *
 * Not clamped to the band. A dial at 20 kHz gives a window whose left edge is
 * below zero, and that is honest — there are no bins there, and sliceToPixels
 * marks those pixels as having no data rather than folding them onto the ones
 * that do.
 */
export function windowFor(tuning, factor = 1) {
    const dial = Number(tuning && tuning.frequency) || 0;
    const fit = fitWindow(tuning && tuning.bandwidthLow, tuning && tuning.bandwidthHigh);
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const extra = ((f - 1) * fit.span) / 2;
    const offLo = fit.lo - extra;
    const offHi = fit.hi + extra;
    return {
        dial,
        offLo,
        offHi,
        span: offHi - offLo,
        lo: dial + offLo,
        hi: dial + offHi,
    };
}

/**
 * Hz per bin of the stream feeding the window, or 0 when nothing is arriving.
 *
 * The whole quality of this panel is one number: how much of the receiver's
 * spectrum lands inside a few kHz. At full zoom-out a 1024-bin 0–30 MHz view is
 * 29 kHz a bin and a 7 kHz window is a quarter of one — the panel can only draw
 * a smooth interpolation of a single measurement, which is truthful and not
 * useful. Zoomed in it is a fraction of a hertz and the picture is as good as
 * the main view's. So the panel reports this, and offers the one button that
 * fixes it.
 */
export function binWidthOf(cfg) {
    if (!cfg || !(cfg.span > 0) || !(cfg.binCount > 0)) return 0;
    return cfg.span / cfg.binCount;
}

/** How many of the served bins land in the window. */
export function binsInWindow(cfg, win) {
    const bw = binWidthOf(cfg);
    return bw > 0 ? win.span / bw : 0;
}

// ── Whether the pane can say anything at all ─────────────────────────────────
//
// Two conditions, and neither is a matter of degree:
//
//   * The main display has to be zoomed in. Every bin this pane draws is one of
//     the main display's, so at full span there is a fraction of one inside the
//     window and the picture is an interpolation between two numbers — smooth,
//     plausible, and telling you nothing about the signal. Seven halvings from
//     the full-span view is where a filter's worth of window starts holding a
//     dozen or more bins, which is where shape appears.
//
//   * The served view has to *reach the whole window*. The main display only
//     recentres when the passband would leave the screen, so it is routinely
//     panned so far that the dial is near one edge — and then the window runs
//     off the end of what the server is sending. Half a picture with a hole in
//     the other half is not a narrower picture, it is a misleading one: the
//     shading and the ruler still describe the whole window, so the gap reads as
//     a dead band rather than as an absence of data. Losing the dial itself is
//     the same fault at its limit, and is called out separately only because
//     what to do about it is different.
//
// Failing any of them, the pane draws what it has and says so over the top
// rather than presenting an interpolation, or a hole, as a measurement. See the
// veil in IFSpectrumPanel.

export const MIN_ZOOM_STEPS = 7;

// How much of the window may be missing before it is worth saying so. A hair's
// overhang is a pixel at the edge, and snapping a cover over the whole panel for
// it — every time a tune walks the window towards the edge of the view — would
// be worse than the sliver. A percent of an SSB window is about 34 Hz.
export const MIN_COVERAGE = 0.99;

// The band the full-span view covers, for working out what a step is when the
// server has not yet said what its own default bin width is.
//
// Deliberately a literal rather than a read of the receiver's real span: this module is
// pure arithmetic and is tested on its own, which is the whole reason it does not import
// from radio/constants.js. fullBinWidthOf takes the span as an argument for a caller that
// knows the receiver's real one; 30 MHz is what a receiver was before the span became
// configurable, and is the right answer when nobody says otherwise.
export const FULL_SPAN_HZ = 30e6;

/**
 * Hz per bin of the whole-band view — the zero point the steps are counted from.
 *
 * `spanHz` only matters on the fallback path. The server sends defaultBinBandwidth in
 * every spectrum config, and that is preferred whenever it is present, so this is used
 * for the first frames before one has arrived.
 */
export function fullBinWidthOf(cfg, spanHz = FULL_SPAN_HZ) {
    if (!cfg) return 0;
    if (cfg.defaultBinBandwidth > 0) return cfg.defaultBinBandwidth;
    const bins = cfg.defaultBinCount || cfg.binCount || 0;
    const span = spanHz > 0 ? spanHz : FULL_SPAN_HZ;
    return bins > 0 ? span / bins : 0;
}

/**
 * How many halvings in the served view is, as a real number.
 *
 * Not an integer, because the server snaps bin bandwidth to a ladder of its own
 * (5000, 2000, 1000, 500, 300, 200 …) which is not powers of two — so a view is
 * routinely six and a half steps in. Counted rather than rounded, so the
 * "N more steps" the panel offers is never off by one.
 */
export function zoomStepsOf(cfg) {
    const full = fullBinWidthOf(cfg);
    if (!(full > 0) || !cfg || !(cfg.binBandwidth > 0)) return 0;
    return Math.max(0, Math.log2(full / cfg.binBandwidth));
}

/** Whether the served view has any bins at the dial at all. */
export function dialCovered(cfg, dial) {
    if (!cfg || !(cfg.span > 0)) return false;
    return dial >= cfg.centerFreq - cfg.span / 2 && dial <= cfg.centerFreq + cfg.span / 2;
}

/**
 * What the pane can do right now: `{ ok, kind, steps, short, cover, canCentre }`.
 *
 * `kind` is 'ok', or the one thing standing in the way — 'stopped', 'paused',
 * 'waiting', 'offdial', 'partial', 'coarse'. Ordered by what has to be true
 * first, so the panel only ever has one thing to say and it is the one the
 * operator can act on: whether the data exists comes before whether it is fine
 * enough, which is why 'partial' is ahead of 'coarse'. Zooming in on a window
 * that is already half off the view only takes more of it away.
 *
 * A stopped receiver outranks a paused spectrum, because resuming a socket for a
 * receiver that is not running would be a button that appears to do nothing.
 *
 * `canCentre` says which way out of a coverage problem applies: bringing the
 * main view back onto the dial is enough when its span could hold the window at
 * all, and when it could not the only answer is to widen it.
 *
 * `paused` is last in the argument list and optional, so the three questions
 * about the *data* stay together at the front. It is the spectrum socket's own
 * flag — see lib/spectrumPause.js — not anything this module can work out.
 */
export function paneState(cfg, tuning, running, win, paused) {
    const none = { ok: false, steps: 0, short: 0, cover: 0, canCentre: false };
    if (!running) return { ...none, kind: 'stopped' };
    if (paused) return { ...none, kind: 'paused' };
    if (!cfg || !(cfg.span > 0)) return { ...none, kind: 'waiting' };

    const dial = Number(tuning && tuning.frequency) || 0;
    if (!dialCovered(cfg, dial)) return { ...none, kind: 'offdial' };

    const cover = win ? coverageOf(cfg, win) : 1;
    if (cover < MIN_COVERAGE) {
        // Centring on the dial covers the window only if the view is wide enough
        // to hold it from there — and the window is not centred on the dial, so
        // it is the further of the two edges that decides.
        const reach = Math.max(-win.offLo, win.offHi);
        return {
            ...none, kind: 'partial', cover, canCentre: cfg.span / 2 >= reach,
        };
    }

    const steps = zoomStepsOf(cfg);
    if (steps < MIN_ZOOM_STEPS - 1e-9) {
        return {
            ...none, kind: 'coarse', steps, short: Math.ceil(MIN_ZOOM_STEPS - steps), cover,
        };
    }
    return {
        ok: true, kind: 'ok', steps, short: 0, cover, canCentre: true,
    };
}

/**
 * The span to ask the main display for, so that this pane becomes usable.
 *
 * Three times the *fitted* window — enough context around the filter to be worth
 * looking at, and the fit rather than whatever the pane is currently opened to,
 * which at a wide zoom could be hundreds of kilohertz and would not clear the
 * gate at all. Capped at the span the gate itself opens on, so the button can
 * never land somewhere it does not help.
 */
export function zoomTargetSpan(cfg, tuning) {
    const fit = fitWindow(tuning && tuning.bandwidthLow, tuning && tuning.bandwidthHigh);
    const full = fullBinWidthOf(cfg);
    const bins = (cfg && cfg.binCount) || 0;
    const atGate = full > 0 && bins > 0 ? bins * (full / 2 ** MIN_ZOOM_STEPS) : Infinity;
    return Math.min(fit.span * 3, atGate);
}

/**
 * How much of the window the served view actually covers, 0..1.
 *
 * Less than 1 means the main spectrum has been panned so far that part of the
 * window — or all of it — is off the end of what the server is sending. With
 * follow-tuning on that never happens; with it off it is one drag away, and the
 * panel has to say why it has gone blank rather than looking broken.
 */
export function coverageOf(cfg, win) {
    if (!cfg || !(cfg.span > 0) || !(win.span > 0)) return 0;
    const lo = Math.max(win.lo, cfg.centerFreq - cfg.span / 2);
    const hi = Math.min(win.hi, cfg.centerFreq + cfg.span / 2);
    return Math.max(0, Math.min(1, (hi - lo) / win.span));
}

/**
 * The window's bins across `out.length` pixels, in dB.
 *
 * Two regimes, because this pane is used at both ends of the zoom range and the
 * right answer differs:
 *
 *   **More bins than pixels** — take each pixel's maximum, the same collapse
 *   lib/spectrumTrace.js does and for the same reason: a carrier narrower than
 *   a pixel must survive being drawn.
 *
 *   **More pixels than bins** — which is the normal case here, since the window
 *   is a few kHz of a view measured in hundreds — interpolate linearly between
 *   bin centres. Nearest-bin would draw a staircase whose steps are an artefact
 *   of the FFT width rather than anything in the signal, and on a panel this
 *   size the steps are tens of pixels wide.
 *
 * Pixels with no bin behind them come out as NaN, not as a floor value. They
 * happen at the edges when the dial is near 0 Hz or near the end of the served
 * view, and a floor there would draw a plausible flat noise line over a part of
 * the spectrum nobody has measured.
 */
export function sliceToPixels(bins, cfg, win, out) {
    const w = out.length;
    const n = bins ? bins.length : 0;
    if (!w) return out;
    const bw = binWidthOf(cfg);
    if (!n || !(bw > 0) || !(win.span > 0)) {
        out.fill(NaN);
        return out;
    }

    const viewLo = cfg.centerFreq - cfg.span / 2;
    const perPx = win.span / w / bw;

    for (let x = 0; x < w; x++) {
        if (perPx >= 1) {
            // The bins this pixel spans, as a half-open range.
            const a = (win.lo + (x * win.span) / w - viewLo) / bw;
            const b = (win.lo + ((x + 1) * win.span) / w - viewLo) / bw;
            // Wholly outside the served view. Tested *before* clamping, because
            // the clamp is what hides it: a pixel off the left-hand end has both
            // ends negative, Math.max(0, …) pulls its start to bin 0, and the
            // `i0 + 1` floor under its end then guarantees it reads that bin. So
            // every pixel past the left edge came back as bin 0's level — a flat
            // line, at a plausible height, across a part of the spectrum nobody
            // has measured. The right-hand end escaped by accident, since there
            // the clamped range comes out empty; that asymmetry is what the
            // picture showed.
            if (b <= 0 || a >= n) {
                out[x] = NaN;
                continue;
            }
            const i0 = Math.max(0, Math.floor(a));
            const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(b)));
            let m = -Infinity;
            for (let i = i0; i < i1; i++) if (bins[i] > m) m = bins[i];
            out[x] = m === -Infinity ? NaN : m;
            continue;
        }

        // Where this pixel's centre falls in the served view, in bins.
        //
        // Whether there is anything there at all is asked in these terms rather
        // than in the interpolator's, which are half a bin along: a pixel just
        // outside the view is within half a bin of the first bin's *centre*, so
        // judged there it looks like the clamp case below and comes back as bin
        // 0. Sub-pixel at most, but it is the same mistake as the one that drew
        // a flat left-hand edge, and the boundary is worth stating once.
        const hz = win.lo + ((x + 0.5) * win.span) / w;
        const rel = (hz - viewLo) / bw;
        if (rel < 0 || rel > n) {
            out[x] = NaN;
            continue;
        }
        // Bin i covers viewLo + i*bw .. viewLo + (i+1)*bw, so its centre is half
        // a bin in — hence the -0.5, without which the whole trace sits half a
        // bin off the frequency scale drawn under it. Outside the outermost
        // centres there is nothing to interpolate against, so the edge bin
        // stands.
        const f = rel - 0.5;
        const i = Math.floor(f);
        if (i < 0) {
            out[x] = bins[0];
        } else if (i >= n - 1) {
            out[x] = bins[n - 1];
        } else {
            const t = f - i;
            out[x] = bins[i] * (1 - t) + bins[i + 1] * t;
        }
    }
    return out;
}

// ── Levels ───────────────────────────────────────────────────────────────────
//
// The same shape as the main spectrum's auto-range, cut down to what this pane
// needs: a floor placed under the noise and left alone, and a ceiling that
// attacks instantly and decays slowly.
//
// The attack has to be instant for the reason the main pane's is. A ceiling
// eased towards the peak never arrives — speech and CW are hundreds of
// milliseconds and the easing is measured in seconds — so it settles somewhere
// between the noise and the signal and every burst is drawn clipped flat
// against the top of the scale. Ease it back down and nothing else changes.

export const LEVEL_FLOOR_PCT = 0.25;   // percentile taken as the noise
export const LEVEL_FLOOR_MARGIN = 8;   // dB of scale left below it
export const LEVEL_HEADROOM = 6;       // dB left above the strongest pixel
export const LEVEL_MIN_SPAN = 30;      // dB — never draw a narrower scale
export const LEVEL_K = 0.08;           // per-frame approach at the reference rate

export function createLevels() {
    return { floor: null, ceil: null, scratch: null };
}

/**
 * Walk the levels towards this row and return `{ floor, ceil }`.
 *
 * `px` may contain NaN — see sliceToPixels — and a row that is entirely NaN
 * leaves the levels exactly where they were, which is what keeps the scale
 * still while the dial is outside the served view instead of collapsing to
 * nothing and springing back.
 *
 * `peakFrom` is an optional second row to take the ceiling from. The floor is a
 * percentile and wants the *typical* level; the ceiling is a peak and wants the
 * highest thing that will be drawn. Normally those are the same row. In the
 * shape view they are not: the floor belongs to the average and the ceiling to
 * the top of the envelope above it, and taking both from the envelope would put
 * the noise floor several dB high — the maximum of a noisy bin over a few
 * seconds sits well above its mean.
 */
export function updateLevels(st, px, dt, peakFrom) {
    const n = px.length;
    if (!st.scratch || st.scratch.length !== n) st.scratch = new Float32Array(n);
    let k = 0;
    let peak = -Infinity;
    for (let i = 0; i < n; i++) {
        const v = px[i];
        if (!Number.isFinite(v)) continue;
        st.scratch[k++] = v;
        if (v > peak) peak = v;
    }
    if (peakFrom && peakFrom.length === n) {
        for (let i = 0; i < n; i++) {
            const v = peakFrom[i];
            if (Number.isFinite(v) && v > peak) peak = v;
        }
    }
    if (k < 2) return levelsOf(st);

    const valid = st.scratch.subarray(0, k);
    valid.sort();
    const floorTarget = valid[Math.min(k - 1, Math.round(LEVEL_FLOOR_PCT * (k - 1)))]
        - LEVEL_FLOOR_MARGIN;
    const ceilTarget = peak + LEVEL_HEADROOM;

    if (st.floor === null) {
        st.floor = floorTarget;
        st.ceil = ceilTarget;
        return levelsOf(st);
    }

    const a = approachFor(LEVEL_K, dt);
    st.floor += (floorTarget - st.floor) * a;
    st.ceil += (ceilTarget - st.ceil) * a;
    // Attack: the ceiling is never below the peak in hand.
    if (st.ceil < ceilTarget) st.ceil = ceilTarget;
    return levelsOf(st);
}

/**
 * The tracked pair, with the minimum span applied.
 *
 * The minimum widens *upward* only. Applied by pushing the floor down instead,
 * a quiet band would drag the noise into the bottom of the palette and the
 * whole picture would go dark exactly when there is least to see.
 */
export function levelsOf(st) {
    if (!st || st.floor === null) return { floor: -110, ceil: -110 + LEVEL_MIN_SPAN };
    const floor = st.floor;
    return { floor, ceil: Math.max(st.ceil, floor + LEVEL_MIN_SPAN) };
}

/** The operator's own two numbers, ordered and never degenerate. */
export function manualLevels(floorDb, ceilDb) {
    const lo = Math.min(floorDb, ceilDb);
    const hi = Math.max(floorDb, ceilDb);
    return { floor: lo, ceil: Math.max(hi, lo + 1) };
}

// ── The offset ruler ─────────────────────────────────────────────────────────
//
// Marked in Hz from the dial rather than in MHz, because that is the question
// this pane answers: not "what frequency is that" — the main scale says that —
// but "how far off am I, and is that inside the filter". Zero is always a tick,
// and it is the dial.

// The room a label wants, including the gap to its neighbour.
export const OFFSET_LABEL_PX = 62;

// Minor notches per labelled step. Five, as the main spectrum's ruler uses —
// which puts a notch on the halves and the tenths of a 1 kHz step, so a signal
// can be read to a couple of hundred hertz without a label under it.
export const OFFSET_MINORS = 5;

/**
 * The gap between labelled notches, in Hz.
 *
 * Built from a decade rather than looked up in a list, exactly as the main
 * spectrum's ruler is (frequencyTicks in lib/spectrumTrace.js). A fixed ladder
 * is the same code with a maximum, and it fails silently the first time the
 * window opens past the end of it: the step sticks at the largest rung and the
 * strip fills with overlapping labels — eleven of them across a dock column,
 * which is how this was found.
 */
const RUNGS = [1, 2, 2.5, 5, 10];

export function offsetStep(offLo, offHi, widthPx) {
    const span = offHi - offLo;
    const want = Math.max(2, Math.floor((widthPx || 0) / OFFSET_LABEL_PX));
    const rough = span / want;
    if (!(rough > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    let i = RUNGS.findIndex((m) => pow * m >= rough);
    if (i < 0) i = RUNGS.length - 1;

    // Rounding up to a rung can overshoot the window's longer side, which leaves
    // 0 as the only label on the strip: every other multiple of the step is off
    // the end of it. One rung down puts them back, and cannot crowd the labels —
    // it is below the spacing the width asked for.
    const reach = Math.max(-offLo, offHi);
    if (pow * RUNGS[i] > reach && i > 0) i -= 1;
    else if (pow * RUNGS[i] > reach) return (pow / 10) * RUNGS[RUNGS.length - 2];
    return pow * RUNGS[i];
}

// How near an end a label has to be before it is pushed inward instead of
// centred. About half a label's width on a dock-column-sized strip.
export const EDGE_FRAC = 0.07;

/**
 * Notches across the strip as `{ hz, frac, label, major, zero }`, hz being the
 * offset from the dial and frac its position 0..1 across the window.
 *
 * Minors carry no label. They exist because this ruler is read for *distance*
 * rather than for a number — "am I half a step off" — which is a question a
 * bare pair of labels cannot answer and five notches between them can.
 *
 * Stepped outward from zero rather than from the left edge, which is what puts
 * a notch exactly on the dial. Stepped from the edge, a window whose width is
 * not a whole number of steps would land 0 between two notches — and on a pane
 * whose window is deliberately lopsided, that would be every window.
 */
export function offsetTicks(offLo, offHi, widthPx) {
    const span = offHi - offLo;
    if (!(span > 0)) return [];
    const step = offsetStep(offLo, offHi, widthPx);
    const minor = step / OFFSET_MINORS;
    const out = [];
    // Rounded inward at both ends, so no notch is drawn off the strip.
    const first = Math.ceil(offLo / minor - 1e-9);
    const last = Math.floor(offHi / minor + 1e-9);
    for (let i = first; i <= last; i++) {
        const hz = i * minor;
        const major = i % OFFSET_MINORS === 0;
        const frac = (hz - offLo) / span;
        out.push({
            hz,
            frac,
            label: major ? formatOffset(hz) : null,
            major,
            zero: i === 0,
            // A label centred on a notch this close to the end hangs half off
            // the panel. Pushed inward instead, as the band chart's end labels
            // are — the outermost number is the one that says how wide the
            // window is, so losing it is worse than moving it.
            align: frac < EDGE_FRAC ? 'start' : frac > 1 - EDGE_FRAC ? 'end' : 'center',
        });
    }
    return out;
}


/**
 * An offset for a label: `0`, `+1.5k`, `-600`.
 *
 * The kilohertz form is only used where it is *exact*. One decimal place turned
 * a 1250 Hz notch into "+1.3k", which on a strip whose whole purpose is reading
 * a frequency offset to a few hundred hertz is not an abbreviation, it is a
 * wrong number — and the 2.5 rung of the tick ladder produces those every time
 * it is chosen. Anything that will not round-trip is printed in hertz instead,
 * which is longer and true.
 */
export function formatOffset(hz) {
    if (!hz) return '0';
    const sign = hz < 0 ? '-' : '+';
    const v = Math.abs(hz);
    if (v >= 1000) {
        const s = (v / 1000).toFixed(2).replace(/\.?0+$/, '');
        if (Math.abs(parseFloat(s) * 1000 - v) < 0.5) return `${sign}${s}k`;
    }
    return `${sign}${Math.round(v)}`;
}

/** Hz per bin for the footer, at whatever precision says something. */
export function formatBinWidth(hz) {
    if (!(hz > 0)) return '—';
    if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz/bin`;
    if (hz >= 10) return `${hz.toFixed(0)} Hz/bin`;
    return `${hz.toFixed(hz >= 1 ? 1 : 2)} Hz/bin`;
}

// ── Views ────────────────────────────────────────────────────────────────────
//
// Five ways of drawing the same window. The first three are the main display's
// own answers and are here because the right one depends on the panel's height
// as much as on taste — in a short dock column a split is two useless strips.
// The last two exist because this pane is small and symmetric, which is a shape
// the main display never has:
//
//   fusion  the trace laid over its own waterfall, one picture rather than two.
//           A dock column cannot afford to halve a 140 px pane, and the two
//           layers do not compete: the history is dark where the trace is
//           bright, because they are the same measurement.
//   mirror  the trace drawn up *and* down from the centre line, as a spectrum
//           analyser's envelope. Symmetric about the dB axis rather than the
//           frequency axis, so it reads as one solid object whose thickness is
//           signal strength — and on a passband centred in the window that
//           object is centred too, which is the whole "am I on frequency"
//           question answered by shape instead of by reading a scale.
//   shape   not a trace at all: the sustained level of the passband over a few
//           seconds, with the spread around it. The other five draw what
//           arrived; this one draws what is *there*, which on a signal buried in
//           noise is a different picture. See lib/ifShape.js.
export const IF_VIEWS = [
    { value: 'split', label: 'Split' },
    { value: 'spectrum', label: 'Spectrum' },
    { value: 'waterfall', label: 'Waterfall' },
    { value: 'fusion', label: 'Fusion' },
    { value: 'mirror', label: 'Mirror' },
    { value: 'shape', label: 'Shape' },
];

// The one a new visitor gets, and the one an unreadable stored value falls back
// to — the same constant, so the two cannot drift apart. DisplayContext imports
// it rather than repeating the word.
//
// Fusion rather than split: this pane is a dock column's worth of height, and
// halving it gives two strips that are each too short to read. The trace and the
// history are the same measurement anyway — one is where the signal is now, the
// other where it has been — so laying them over each other costs nothing in
// legibility and buys the whole panel for both. The other four are one tap away.
export const IF_VIEW_DEFAULT = 'fusion';

export function normaliseView(v) {
    return IF_VIEWS.some((o) => o.value === v) ? v : IF_VIEW_DEFAULT;
}

/** Whether a view draws each half. Both is the split and the fusion. */
export function viewHas(view) {
    const v = normaliseView(view);
    return {
        trace: v !== 'waterfall',
        waterfall: v === 'split' || v === 'waterfall' || v === 'fusion',
        // One pane carrying both, rather than two stacked.
        merged: v === 'fusion',
        mirror: v === 'mirror',
        // Drawn from a window of frames rather than from the last one, so it
        // needs a history of its own and a scale that fits the passband — see
        // lib/ifShape.js.
        shape: v === 'shape',
    };
}

// Rows a second the waterfall commits, and the bounds of the panel's slider.
// The ceiling is the main waterfall's: past it rows arrive faster than frames
// do and the extra ones are copies.
export const IF_RATE_MIN = 2;
export const IF_RATE_MAX = 40;

export function clampRate(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 20;
    return Math.min(IF_RATE_MAX, Math.max(IF_RATE_MIN, Math.round(n)));
}
