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
//   * **It is centred on the dial, always, whatever the mode.** A USB passband
//     lies entirely above the carrier and an LSB one entirely below it, so a
//     view that merely covered the filter would show one side of the dial and
//     not the other — and what you want an IF display for is usually the thing
//     *just outside* the filter: the station about to walk into your passband,
//     the carrier you are 300 Hz off. So the window is symmetric about the dial
//     by construction (see halfSpanFor), and both sides are always on screen.
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

// ...and the narrowest half-window worth drawing. A 200 Hz CW filter fits in
// 250 Hz, which is a legitimate thing to ask for and a hard thing to point at:
// under a finger, 500 Hz across a dock column is about 8 Hz a pixel and every
// tap lands on a different signal. This is a floor on the window, not on the
// filter — the shading still shows the filter at whatever width it is.
export const MIN_HALF_SPAN_HZ = 400;

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
 * So the stop is wherever the window fills the served view. When the main
 * display is zoomed out to the whole band this never binds and the ceiling is
 * ZOOM_MAX again; when it is zoomed in, the two move together.
 *
 * The *fit* is deliberately not clamped by this. A window narrower than the
 * filter would break the one promise this pane makes, so a main view too narrow
 * to fill even the fitted window draws gaps at the edges instead — which is
 * true, and which the trace shows as gaps rather than as invented noise.
 */
export function maxZoomFor(cfg, tuning) {
    if (!cfg || !(cfg.span > 0) || !tuning) return ZOOM_MAX;
    const fit = halfSpanFor(tuning.bandwidthLow, tuning.bandwidthHigh, 1) * 2;
    if (!(fit > 0)) return ZOOM_MAX;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cfg.span / fit));
}

/** Whether the window has been opened past the fit — i.e. there is a reset to offer. */
export function isZoomed(factor) {
    return clampZoom(factor) > ZOOM_MIN * 1.001;
}

/**
 * Half the window, in Hz, for a passband — the distance from the dial to either
 * edge of the picture.
 *
 * Taken from whichever filter edge is *furthest* from the dial, so the whole
 * passband is inside the window with the margin to spare on the wider side. For
 * SSB that means the empty side of the dial gets as much room as the occupied
 * one, which is exactly the asymmetry an IF display exists to show.
 */
export function halfSpanFor(low, high, factor = 1) {
    const reach = Math.max(Math.abs(Number(low) || 0), Math.abs(Number(high) || 0));
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    return Math.max(MIN_HALF_SPAN_HZ, reach * FIT_MARGIN) * f;
}

/**
 * The window to draw, in Hz: `{ lo, hi, half, span }` about the dial.
 *
 * Not clamped to the band. A dial at 20 kHz gives a window whose left edge is
 * below zero, and that is honest — there are no bins there, and sliceToPixels
 * marks those pixels as having no data rather than folding them onto the ones
 * that do.
 */
export function windowFor(tuning, factor = 1) {
    const dial = Number(tuning && tuning.frequency) || 0;
    const half = halfSpanFor(tuning && tuning.bandwidthLow, tuning && tuning.bandwidthHigh, factor);
    return { dial, half, span: half * 2, lo: dial - half, hi: dial + half };
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

// How many bins have to fall inside the window before the picture is showing
// structure rather than an interpolation. Below this the panel says so.
export const COARSE_BINS = 12;

/** How many of the served bins land in the window. */
export function binsInWindow(cfg, win) {
    const bw = binWidthOf(cfg);
    return bw > 0 ? win.span / bw : 0;
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
            const i0 = Math.max(0, Math.floor(a));
            const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(b)));
            let m = -Infinity;
            for (let i = i0; i < i1; i++) if (bins[i] > m) m = bins[i];
            out[x] = m === -Infinity ? NaN : m;
            continue;
        }

        // Where this pixel's centre falls between two bin centres. Bin i covers
        // viewLo + i*bw .. viewLo + (i+1)*bw, so its centre is half a bin in —
        // hence the -0.5, without which the whole trace sits half a bin off the
        // frequency scale drawn under it.
        const hz = win.lo + ((x + 0.5) * win.span) / w;
        const f = (hz - viewLo) / bw - 0.5;
        const i = Math.floor(f);
        if (i < -1 || i > n - 1) {
            out[x] = NaN;
        } else if (i < 0) {
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
 */
export function updateLevels(st, px, dt) {
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

export function offsetStep(half, widthPx) {
    const want = Math.max(2, Math.floor((widthPx || 0) / OFFSET_LABEL_PX));
    const rough = (half * 2) / want;
    if (!(rough > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    let i = RUNGS.findIndex((m) => pow * m >= rough);
    if (i < 0) i = RUNGS.length - 1;

    // Rounding up to a rung can overshoot the half-window, which leaves 0 as the
    // only label on the strip: the ±1 step marks are off both ends. One rung
    // down puts them back, and cannot crowd the labels — it is below the spacing
    // the width asked for, which was itself at most the half-window.
    if (pow * RUNGS[i] > half && i > 0) i -= 1;
    else if (pow * RUNGS[i] > half) return (pow / 10) * RUNGS[RUNGS.length - 2];
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
 * Both halves are stepped outward from zero rather than from the left edge, so
 * the ruler is symmetric about the dial however the window is zoomed. Stepped
 * from the edge, a window whose half-span is not a whole number of steps would
 * put its notches slightly off-centre and 0 would land between two of them.
 */
export function offsetTicks(half, widthPx) {
    if (!(half > 0)) return [];
    const step = offsetStep(half, widthPx);
    const minor = step / OFFSET_MINORS;
    const out = [];
    const count = Math.floor(half / minor);
    for (let i = -count; i <= count; i++) {
        const hz = i * minor;
        const major = i % OFFSET_MINORS === 0;
        const frac = (hz + half) / (half * 2);
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


/** An offset for a label: `0`, `+1.5k`, `-600`. */
export function formatOffset(hz) {
    if (!hz) return '0';
    const sign = hz < 0 ? '-' : '+';
    const v = Math.abs(hz);
    if (v >= 1000) {
        const k = v / 1000;
        return `${sign}${k % 1 ? k.toFixed(1) : k.toFixed(0)}k`;
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
export const IF_VIEWS = [
    { value: 'split', label: 'Split' },
    { value: 'spectrum', label: 'Spectrum' },
    { value: 'waterfall', label: 'Waterfall' },
    { value: 'fusion', label: 'Fusion' },
    { value: 'mirror', label: 'Mirror' },
];

export function normaliseView(v) {
    return IF_VIEWS.some((o) => o.value === v) ? v : 'split';
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
