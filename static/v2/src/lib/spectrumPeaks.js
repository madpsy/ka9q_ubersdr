// Peak markers: the strongest signals in the view, found and labelled.
//
// The trace already shows where the signals are — what this adds is *which* ones and at
// what frequency, without hovering over each in turn. It answers "what is on this band
// right now" in one glance, which is the question the panel is most often open for.
//
// All of it is here rather than in the canvas code because none of it is drawing, and
// because every part of it is the kind of thing that is easy to get subtly wrong and
// impossible to check by looking at a screenshot.
//
// ── The maths, and why each piece of it is the standard one ──────────────────
//
// A marker that wanders is worse than no marker: it looks like information. Four
// well-understood estimators between them make it hold still, and none of them is a
// fudge factor.
//
//   Video averaging. A first-order IIR low-pass per bin, alpha derived from the frame
//   interval and a time constant — so the smoothing is in seconds and does not change
//   with the frame rate the server happens to be sending. This is exactly the "video
//   averaging" or "trace average" control on a bench analyser, and it is done on a
//   copy: the trace you see is untouched.
//
//   Median and MAD for the noise floor. The median because a mean is dragged upwards by
//   precisely the signals being looked for; the median absolute deviation because a
//   standard deviation is dragged up the same way. MAD × 1.4826 is the standard robust
//   estimator of sigma for Gaussian noise, so "stands 4 sigma above the floor" is a
//   real statement about this band rather than a threshold somebody liked the look of.
//
//   Topographic prominence, not a pixel gap. A peak counts as its own signal when the
//   trace descends by a set number of dB on both sides before rising higher. That is
//   the definition that distinguishes two carriers from one lumpy signal at any zoom,
//   whereas a fixed separation in pixels means something different on every span.
//
//   Parabolic interpolation for where it actually is. Three points around a maximum in
//   dB fit a parabola, whose vertex is the peak: delta = (yl - yr) / (2(yl - 2y + yr)).
//   For a windowed FFT in log magnitude this is the classical sub-bin estimator, and it
//   is what stops the marker snapping half a bin left and right as the noise moves the
//   winning sample. At wide spans, where one pixel covers many bins, it is interpolating
//   the drawn envelope rather than the transform — still the right thing to do, since
//   the envelope is then what "the peak" means on screen.
//
// Hysteresis on top of all that decides *membership*: a marker already on screen keeps
// its place while it is within a decibel or so of the newcomer that would displace it,
// so two signals trading a fraction of a dB do not swap markers several times a second.

// How many markers the picker offers, and what "not chosen" resolves to.
//
// Three on a desktop: enough to name what is worth naming on a busy band without the
// spectrum becoming a page of text, and the marker on the strongest signal is the one
// most often wanted anyway. One on a phone, where the trace is a couple of hundred
// pixels wide — two labels there would collide about as often as not, and the panel is
// being read at arm's length.
//
// `null` means the operator has not chosen and is not the same as 0: it resolves per
// device, so the same saved settings behave sensibly on a desktop and a handset, and the
// picker shows what is actually in force. Same shape as the stats overlay.
export const PEAK_COUNTS = [0, 1, 3, 5, 8, 12];
export const PEAK_DEFAULT_DESKTOP = 3;
export const PEAK_DEFAULT_MOBILE = 1;

/** How many markers to draw: the setting, or this device's default if none was chosen. */
export function peakCount(n, isMobile = false) {
    if (n == null) return isMobile ? PEAK_DEFAULT_MOBILE : PEAK_DEFAULT_DESKTOP;
    return PEAK_COUNTS.includes(Number(n)) ? Number(n) : 0;
}

// Where the markers live.
//
//   'top' pins them in one row along the top of the pane, each with a hairline dropped
//   to its signal. The labels then read as a list — left to right, in frequency order,
//   all at the same height — which is much easier to scan than a scatter, and never
//   covers a peak. That is why it is the default. The hairline is what earns it: a mark
//   that has left its signal has to say which one it came from.
//
//   'signal' rides the trace instead: each caret sits on its own peak, so the mark is
//   part of the shape it belongs to and nothing is needed to connect them. It is what a
//   bench analyser does, and it is better on a quiet band with two or three signals —
//   the cost is that the labels sit at whatever height their signals are.
export const PEAK_PLACES = ['top', 'signal'];
export const peakPlace = (v) => (PEAK_PLACES.includes(v) ? v : PEAK_PLACES[0]);

// The averaging time constant, ms. Modest on purpose: long enough to sit still while
// you read it, short enough that a station coming up on the band is marked within about
// a second rather than fading in over five.
export const PEAK_TAU_MS = 700;

// How far above the noise floor a signal must stand to be worth a marker — the
// operator's own choice, because "significant" depends on the band and on what they are
// looking for. Ten decibels by default: a signal 10 dB out of the noise is one you can
// hear, and one that a marker is telling you something real about.
//
// The count is therefore a ceiling and not a quota. Asking for five markers on a dead
// band shows none, which is the useful answer — five markers scattered over noise would
// say "here are five signals" about a band with nothing on it.
export const PEAK_SNR_CHOICES = [3, 6, 10, 15, 20, 30];
export const PEAK_SNR_DEFAULT = 10;

/** An SNR threshold from the settings, made safe. */
export const peakSnr = (db) => (PEAK_SNR_CHOICES.includes(Number(db))
    ? Number(db) : PEAK_SNR_DEFAULT);

// ...and a guard underneath it, in units of the noise's own spread. A threshold in plain
// decibels means different things on a quiet receiver and a ragged one, and at the low
// end of the choices above it can sit inside the noise itself — where the "peaks" found
// are the floor breathing. Three sigma is about one sample in a thousand of Gaussian
// noise, so this rarely overrides a deliberate choice; where it does, the choice was
// asking for markers on noise.
export const PEAK_SIGMA_K = 3;

// How far the trace must fall either side of a maximum before it is a separate signal.
export const PEAK_PROMINENCE_DB = 4;

// A floor on separation all the same, in pixels. Prominence decides what is a signal;
// this decides what is worth a second marker on screen — two carriers 3 px apart are
// two carriers, but they are one mark and one label at this size, and the second marker
// would only obscure the first.
export const PEAK_GAP_PX = 14;

// How much stronger a newcomer has to be before it takes a marker off something already
// on screen.
export const PEAK_HYST_DB = 1.5;

// How often peaks are re-found, ms. The averaging does the smoothing; this only keeps
// the work off most frames.
export const PEAK_REFRESH_MS = 250;

/**
 * One step of the running average, in place, framerate-independent.
 *
 * alpha = 1 − exp(−dt/tau) is the exact discrete equivalent of a first-order RC
 * low-pass sampled at dt. Approximating it as dt/tau (the usual shortcut) drifts badly
 * when a frame is late, which on a spectrum feed happens whenever the network hiccups —
 * and a smoother that speeds up under load is a smoother nobody can reason about.
 *
 * `avg` is modified and returned. A first call, or one after the view has moved, should
 * pass `reset` so the average starts *at* the trace rather than sweeping up to it from
 * whatever the last band looked like.
 */
export function averageTrace(avg, trace, dtMs, tauMs = PEAK_TAU_MS, reset = false) {
    const n = Math.min(avg.length, trace.length);
    if (reset || !(dtMs > 0)) {
        for (let i = 0; i < n; i++) avg[i] = trace[i];
        return avg;
    }
    const alpha = 1 - Math.exp(-dtMs / Math.max(1, tauMs));
    for (let i = 0; i < n; i++) {
        const v = trace[i];
        // A bin with no reading holds its average rather than dragging it to zero.
        if (Number.isFinite(v)) avg[i] += (v - avg[i]) * alpha;
    }
    return avg;
}

/**
 * The noise floor and its spread, robustly: the median, and MAD × 1.4826.
 *
 * Sampled every `step`th value at wide spans — sorting 4000 numbers four times a second
 * is real work for two figures that do not need that precision.
 */
export function noiseStats(trace, step = 1) {
    const n = trace.length;
    if (!n) return { floor: 0, sigma: 0 };
    const s = Math.max(1, Math.floor(step));
    const vals = [];
    for (let i = 0; i < n; i += s) {
        const v = trace[i];
        if (Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return { floor: 0, sigma: 0 };
    const median = (arr) => {
        const mid = arr.length >> 1;
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };
    vals.sort((a, b) => a - b);
    const floor = median(vals);
    const dev = vals.map((v) => Math.abs(v - floor)).sort((a, b) => a - b);
    // 1.4826 = 1/Φ⁻¹(0.75): the factor that turns a median absolute deviation into an
    // estimate of sigma for normally distributed noise.
    return { floor, sigma: median(dev) * 1.4826 };
}

/**
 * Topographic prominence of the maximum at `i`, in dB.
 *
 * Walk out each way until the trace rises above this peak or the view ends, keeping the
 * lowest point reached. The prominence is the height above the *higher* of those two
 * saddles — the shallower side is what decides whether this is a summit or a shoulder
 * of something bigger.
 *
 * A peak with nothing higher either side is prominent by its whole height above the
 * lower end of the view, so the strongest signal on the band always qualifies.
 */
export function prominence(trace, i) {
    const n = trace.length;
    const top = trace[i];
    let left = top;
    for (let k = i - 1; k >= 0; k--) {
        if (trace[k] > top) break;
        if (trace[k] < left) left = trace[k];
    }
    let right = top;
    for (let k = i + 1; k < n; k++) {
        if (trace[k] > top) break;
        if (trace[k] < right) right = trace[k];
    }
    return top - Math.max(left, right);
}

/**
 * Sub-sample peak position and level, by fitting a parabola through three points.
 *
 * delta is in samples, in (−0.5, 0.5] for a genuine local maximum. A flat top gives a
 * zero denominator and a delta of 0, which is the honest answer: nothing about three
 * equal samples says where between them the peak is.
 */
export function interpolatePeak(yl, y, yr) {
    const denom = yl - 2 * y + yr;
    if (!Number.isFinite(denom) || denom === 0) return { delta: 0, db: y };
    let delta = (yl - yr) / (2 * denom);
    if (!Number.isFinite(delta)) return { delta: 0, db: y };
    // Guard against the fit running away where the three points are not a maximum at
    // all; half a sample is as far as a vertex between neighbours can legitimately be.
    delta = Math.max(-0.5, Math.min(0.5, delta));
    // -0 is a perfectly good double and an unhelpful answer: "no offset" has one
    // spelling, and a signed zero leaking out of here shows up as a puzzle later.
    if (delta === 0) delta = 0;
    return { delta, db: y - 0.25 * (yl - yr) * delta };
}

/**
 * The `count` strongest signals in a trace, strongest first.
 *
 * `minAbove` is the operator's SNR threshold and is the whole of why this can return
 * fewer than `count`: a band with two signals on it gets two markers however many were
 * asked for.
 *
 * `prev` is the previous result, used only for the membership hysteresis described at
 * the top of the file. Pass it and markers stop swapping; leave it out and the answer
 * is a pure function of this trace.
 */
export function findPeaks(trace, {
    count = 5,
    gap = PEAK_GAP_PX,
    minAbove = PEAK_SNR_DEFAULT,
    sigmaK = PEAK_SIGMA_K,
    minProminence = PEAK_PROMINENCE_DB,
    hysteresis = PEAK_HYST_DB,
    prev = [],
} = {}) {
    const n = trace.length;
    if (!n || count <= 0) return [];
    const { floor, sigma } = noiseStats(trace, n > 1024 ? 4 : 1);
    const threshold = floor + Math.max(minAbove, sigmaK * sigma);

    // Local maxima above the threshold, taking the *first* sample of a flat top:
    // strictly greater on the left, greater-or-equal on the right. A strict `>` both
    // sides finds nothing at all on the plateau that a strong smoothed carrier makes,
    // and `>=` both sides would report every sample of that plateau as its own peak.
    const cands = [];
    for (let i = 1; i < n - 1; i++) {
        const v = trace[i];
        if (!Number.isFinite(v) || v < threshold) continue;
        if (v > trace[i - 1] && v >= trace[i + 1]) cands.push(i);
    }
    // Strongest first, ties by position so the order cannot depend on the sort's
    // stability — exactly equal samples do happen on a quiet band.
    cands.sort((a, b) => (trace[b] - trace[a]) || (a - b));

    // Prominence is the expensive test, so it is applied after the cheap ones and only
    // until enough have passed. A few times the number wanted is plenty of slack for
    // the ones the gap rule will reject.
    const room = Math.max(count * 4, 24);
    const found = [];
    for (const i of cands) {
        if (found.length >= room) break;
        if (prominence(trace, i) < minProminence) continue;
        const { delta, db } = interpolatePeak(trace[i - 1], trace[i], trace[i + 1]);
        // The SNR comes back with it: it is what the threshold was expressed in, it is
        // what the label shows, and the caller has no way to work it out afterwards
        // without finding the floor a second time.
        found.push({ x: i + delta, bin: i, db, snr: db - floor });
    }

    // The gap rule, strongest first: a peak inside the shadow of a stronger one is that
    // one's shoulder as far as the screen is concerned.
    const spaced = [];
    for (const p of found) {
        if (spaced.some((q) => Math.abs(q.x - p.x) < gap)) continue;
        spaced.push(p);
    }

    // Membership hysteresis, expressed as a bonus rather than as a rule about cutoffs:
    // a signal that already has a marker counts as `hysteresis` dB stronger than it is,
    // so a newcomer must beat it by that much to take the marker away. Two signals
    // trading half a decibel therefore keep their markers, and one that genuinely
    // overtakes still gets one.
    //
    // A bonus and not a negotiation on purpose. Preferring incumbents outright — which
    // is the obvious way to write this, and was the first way — lets five of them hold
    // every marker against a newcomer twice their strength, because the incumbents are
    // also what any cutoff ends up being measured against. A score is transitive, so it
    // is one sort and it means what it says.
    const bonus = (p) => (prev.some((q) => Math.abs(q.x - p.x) < gap) ? hysteresis : 0);
    const kept = spaced
        .map((p) => ({ p, score: p.db + bonus(p) }))
        .sort((a, b) => (b.score - a.score) || (a.p.x - b.p.x))
        .slice(0, count)
        .map((e) => e.p);
    // Reported by true level, whatever the scores were: `rank` is the label priority,
    // and a label kept for the weaker of two signals because it was there first would be
    // a lie about which one is bigger.
    kept.sort((a, b) => (b.db - a.db) || (a.x - b.x));
    return kept.map((p, i) => ({ ...p, rank: i + 1 }));
}

/**
 * Where each label goes, and which of them are dropped.
 *
 * Labels are centred on their peak, clamped inside the view, placed strongest first,
 * and one that would touch a label already placed is dropped — its marker stays. The
 * reasons for each half of that:
 *
 *   Dropping rather than nudging. A label moved far enough to clear its neighbour no
 *   longer points at anything; two frequencies shifted left and right of their own
 *   marks are worse than one frequency and a nameless mark, because both are then wrong
 *   and nothing says so.
 *
 *   Strongest first. Where two signals are too close to label separately, the one worth
 *   naming is the bigger one — and with the hysteresis above, which one that is holds
 *   still between frames.
 *
 * `widths` is measured text in the same pixel space as `viewW`, in the order of
 * `peaks`. Returns one entry per peak, `label` false where the text is dropped.
 */
export function layoutPeakLabels(peaks, widths, viewW, { pad = 6 } = {}) {
    const taken = [];
    return peaks.map((p, i) => {
        const w = widths[i] || 0;
        const left = Math.max(0, Math.min(viewW - w, p.x - w / 2));
        const box = [left - pad, left + w + pad];
        const clash = w > 0 && taken.some(([a, b]) => box[0] < b && box[1] > a);
        if (!clash && w > 0) taken.push(box);
        return { ...p, left, width: w, label: !clash && w > 0 };
    });
}
