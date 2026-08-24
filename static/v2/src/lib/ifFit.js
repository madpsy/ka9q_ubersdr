// Does the filter fit the signal? The measurement, the per-mode judgement, and
// the patience to only say so when it stays true.
//
// The IF pane already draws the passband over the signal, and an operator who
// knows what a clipped SSB signal looks like can read the mismatch off the
// picture. This is that reading made explicit: the *occupied* width of what is
// being listened to, compared against the filter, with a verdict — too narrow,
// too wide, off-centre, or sharing the passband with a neighbour.
//
// Everything is computed from the Shape machinery's time-averaged mean
// (lib/ifShape.js), never from a live frame: a single frame's occupied width is
// the noise's opinion, and this whole feature is worthless if it flickers. On
// top of that average sit two more layers of patience, because the average
// alone is not enough:
//
//   * A verdict must hold for a couple of seconds before it is shown. The
//     averaged spectrum still breathes at the edges — speech is loud and quiet
//     by turns — and an indicator that toggled at the rate consonants arrive
//     would train the eye to ignore it.
//
//   * Silence keeps the last verdict rather than clearing it. A station does
//     not change its bandwidth between words, or between overs: the pause is
//     evidence of nothing, and re-deciding during it would flap every verdict
//     to "no signal" and back once per sentence. Only a silence long enough to
//     mean "they have gone" lets go.
//
// ── Why the verdict is per mode ──────────────────────────────────────────────
//
// The advice has to match the knob that fixes it, and the knob is different per
// mode family — bandwidthLimits() in radio/constants.js is the taxonomy:
//
//   * Symmetric modes (AM, SAM, NFM, FM) have one width control moving both
//     edges together, so there is one verdict, taken from the wider side of the
//     signal. The wider side, because AM under selective fading has one
//     sideband weak for minutes at a time and sizing to the weak side would
//     clip the healthy one — and because "slack on the left" is not something
//     a symmetric filter can act on anyway.
//
//   * SSB is one-sided, and only the far edge — the one the width slider moves
//     — is judged at all. Slack at the near edge is what speech looks like (an
//     empty first 250 Hz is normal), and *spill* past the near edge is not a
//     bandwidth problem either — energy on the wrong side of the dial means
//     the station is mistuned, which is the tuning knob's business and not
//     this card's. It is silently ignored: only the far edge can make the
//     filter guilty.
//
//   * CW is symmetric too, but a keyed carrier is a few tens of hertz wide and
//     every CW filter is "too wide" by the voice test, permanently — so that
//     verdict is suppressed outright, and so is "narrow": a carrier pressing
//     an edge of a symmetric filter is mistuned, not under-filtered, and
//     mistuning is not this card's business. The one thing CW is told about
//     is a *second* signal inside the passband, which is the real reason CW
//     filters get narrowed.
//
//   * IQ is not demodulated and gets no opinion at all.
//
// ── The occupied width ───────────────────────────────────────────────────────
//
// From the averaged mean and its noise floor: every run of bins standing
// SIGNAL_DB above the floor is an island, and runs separated by less than a
// small gap are one island — SSB speech has notches inside it, and a single
// quiet bin must not split a voice into two signals. The island holding the
// strongest in-band peak is *the* signal; its extent is the occupied width.
// Any other island inside the passband is a neighbour.
//
// The islands are found on the window's full width, not just the passband —
// that is the only way "the signal continues past the edge" is even visible —
// which is why the caller hands this the *unmasked* mean (shapeStats keeps one
// as `open`, one step before the passband mask). The window is drawn at the
// filter plus a quarter each side, so there is always margin to see spill in.
//
// The contiguity rule is what tells clipping from an adjacent station: our own
// signal being cut crosses the edge in one unbroken run, while a neighbour
// outside the filter has a cold gap at the edge. A neighbour *inside* the
// filter is its own verdict, and the far more useful one.

import { SIGNAL_DB } from './ifShape.js';
import { MODE_BY_ID, bandwidthLimits, isIQ } from '../radio/constants.js';

// A hole this wide inside a signal is still that signal. Wide enough to bridge
// the quiet stretches inside speech on a settled average — the gap between a
// voiced cluster and its sibilance is hundreds of hertz, and splitting one
// station into two here is what turns a voice into a phantom "neighbour".
export const FIT_GAP_HZ = 250;

// ...except on CW, where 150 Hz would weld two stations in a contest pileup
// into one island and hide exactly the neighbour the verdict exists to point
// at. A keyed carrier's own sidebands sit well inside 50 Hz on an average.
export const FIT_GAP_HZ_CW = 50;

// An island narrower than this is a noise spike that survived the average, not
// a signal. Two bins of the shape grid at typical resolution.
export const FIT_MIN_ISLAND_HZ = 30;

// Spill past an edge has to be at least this deep before it is called
// clipping: the last bin of a signal straddles the edge line on any filter
// that fits well, and reporting that would mean no filter ever fitted. Widened
// to twice the served bin width when that is coarser — at a wide span one bin
// covers hundreds of hertz, and edge quantisation alone would read as spill.
export const FIT_SPILL_HZ = 60;

// A strong signal's edges are measured relative to its own peak, not only
// against the noise: FFT leakage and phase-noise skirts stand well above the
// floor beside anything loud, and taking them as occupied width called every
// strong station clipped. Down-thirty is a shade gentler than the ITU's 26 dB
// occupied-bandwidth convention, so an AM carrier's sidebands — genuinely
// 20-odd dB under their carrier — still count as the signal they are.
export const FIT_DROP_DB = 30;

// A second island only counts as a neighbour when it could actually be one:
// standing well clear of the floor, and within shouting distance of the main
// signal's own level. Fragments of the main signal that broke past the gap
// tolerance — sibilance, a weak formant cluster — fail both.
export const FIT_NEIGHBOUR_MIN_DB = 12;
export const FIT_NEIGHBOUR_REL_DB = 18;

// Slack thresholds, as a fraction of the filter width and an absolute floor —
// whichever is larger. Voice first: a 2.7 kHz SSB filter with 500 Hz of
// nothing at the top is worth a nudge, with 200 Hz it is fine.
export const FIT_SLACK_FRAC = 0.2;
export const FIT_SLACK_MIN_HZ = 300;
// FM's sidebands taper rather than stop — Carson's rule is a convention, not a
// cliff — so its filter is allowed far more apparent slack before comment.
export const FIT_SLACK_FRAC_FM = 0.4;

// The patience. A candidate verdict must hold this long before it is shown...
export const FIT_PERSIST_MS = 2000;
// ...and a shown verdict survives this much silence before clearing, because a
// pause between overs says nothing about the station's bandwidth.
export const FIT_SILENCE_MS = 5000;

/**
 * Runs of bins standing `gateDb` above `floorDb`, gaps of up to `gapBins`
 * bridged: `[{ first, last, peakBin, peakDb }]` in bin order.
 *
 * NaN bins (outside the served view) end a run like cold ones do, but are not
 * bridged: a gap in the *data* is not evidence the signal continues.
 */
export function findIslands(mean, floorDb, gateDb = SIGNAL_DB, gapBins = 0) {
    const out = [];
    if (!mean || !Number.isFinite(floorDb)) return out;
    const gate = floorDb + gateDb;
    let cur = null;
    let gap = 0;
    for (let i = 0; i < mean.length; i++) {
        const v = mean[i];
        const hot = Number.isFinite(v) && v > gate;
        if (hot) {
            if (cur && gap > 0) gap = 0;          // the hole was internal after all
            if (!cur) cur = { first: i, last: i, peakBin: i, peakDb: v };
            cur.last = i;
            if (v > cur.peakDb) { cur.peakDb = v; cur.peakBin = i; }
        } else if (cur) {
            const cold = !Number.isFinite(v) ? Infinity : gap + 1;
            if (cold > gapBins) { out.push(cur); cur = null; gap = 0; } else gap = cold;
        }
    }
    if (cur) out.push(cur);
    return out;
}

// Offsets from the dial, in Hz, for a bin's two edges and its centre.
const perBinOf = (win, bins) => win.span / bins;
const loHzOf = (win, perBin, bin) => win.offLo + bin * perBin;
const hiHzOf = (win, perBin, bin) => win.offLo + (bin + 1) * perBin;
const midHzOf = (win, perBin, bin) => win.offLo + (bin + 0.5) * perBin;

/**
 * The raw judgement for this instant — no memory, no patience; that is
 * updateFit()'s job. Null when there is nothing to judge: no signal in the
 * passband, an IQ mode, or geometry that has not settled.
 *
 * `mean` must be the unmasked shape average (shapeStats' `open`): the mask
 * erases everything outside the filter, which is precisely where clipping
 * shows.
 *
 * Returns `{ kind, ... }`:
 *   narrow     { spillHz, edge: 'low'|'high'|'both' }   the signal is clipped
 *   neighbour  { offsetHz }                    another signal shares the filter
 *   wide       { slackHz, extentHz }           the filter admits mostly noise
 *   ok         {}                              measured, and it fits
 */
export function rawFit(mean, win, band, tuning, floorDb, resHz = 0) {
    if (!mean || !win || !(win.span > 0) || !band || band.last < band.first) return null;
    if (!tuning || isIQ(tuning.mode)) return null;
    const bins = mean.length;
    const perBin = perBinOf(win, bins);
    if (!(perBin > 0)) return null;

    const limits = bandwidthLimits(tuning.mode);
    const group = (MODE_BY_ID[tuning.mode] || {}).group;
    const gapHz = group === 'cw' ? FIT_GAP_HZ_CW : FIT_GAP_HZ;
    // `resHz` is the *served* bin width. The grid this runs on is finer, but
    // nothing on it can be sharper than what the server sent, so every
    // threshold in hertz is floored by the resolution actually behind it.
    const minIsland = Math.max(FIT_MIN_ISLAND_HZ, resHz);
    const islands = findIslands(
        mean, floorDb, SIGNAL_DB,
        Math.max(1, Math.round(gapHz / perBin)),
    ).filter((is) => (is.last - is.first + 1) * perBin >= minIsland);
    if (!islands.length) return null;

    // The signal is the island that is loudest *inside* the passband — judged
    // by its in-band level, not by where its overall peak sits. A clipped
    // signal's absolute peak can be out in the margin (a flat-topped signal
    // spilling an edge peaks in its first bin), and a louder station wholly
    // outside the filter counts for nothing: the margin is the margin's
    // business. Islands that never enter the passband are skipped outright.
    let main = null;
    let mainDb = -Infinity;
    const inBandDb = islands.map((is) => {
        const a = Math.max(is.first, band.first);
        const b = Math.min(is.last, band.last);
        let peak = -Infinity;
        for (let i = a; i <= b; i++) if (Number.isFinite(mean[i]) && mean[i] > peak) peak = mean[i];
        return peak;
    });
    for (let k = 0; k < islands.length; k++) {
        if (inBandDb[k] > mainDb) { mainDb = inBandDb[k]; main = islands[k]; }
    }
    if (!main) return null;

    // The main signal's occupied extent, at the stricter of the two gates —
    // above the noise, and within FIT_DROP_DB of its own peak. The relative
    // gate is what keeps a strong station honest: its leakage skirts clear the
    // floor gate for hundreds of hertz either side, and measured against the
    // floor alone every loud signal read as wider than any filter.
    const gate2 = Math.max(floorDb + SIGNAL_DB, main.peakDb - FIT_DROP_DB);
    let occFirst = -1;
    let occLast = -1;
    for (let i = main.first; i <= main.last; i++) {
        const v = mean[i];
        if (!Number.isFinite(v) || v < gate2) continue;
        if (occFirst < 0) occFirst = i;
        occLast = i;
    }
    if (occFirst < 0) { occFirst = main.peakBin; occLast = main.peakBin; }

    const bandLoHz = loHzOf(win, perBin, band.first);
    const bandHiHz = hiHzOf(win, perBin, band.last);
    const width = bandHiHz - bandLoHz;

    // Clipping: the main island runs through an edge. Measured as how far past
    // the edge it continues, and only when that is deeper than the edge bin
    // itself — see FIT_SPILL_HZ.
    //
    // Which edge can convict the filter depends on the family. On SSB only the
    // far edge can: energy past the *near* edge is on the wrong side of the
    // dial, which is a mistune — the fix is the tuning knob, and widening the
    // filter toward it would only let the mistake in louder, so it is ignored
    // rather than reported. CW never earns "narrow" at all: a carrier pressing
    // the edge of a symmetric filter is the same mistune. Symmetric voice is
    // the only family where both edges are bandwidth's fault.
    const spillMin = Math.max(FIT_SPILL_HZ, 2 * resHz);
    const spillLo = Math.max(0, bandLoHz - loHzOf(win, perBin, occFirst));
    const spillHi = Math.max(0, hiHzOf(win, perBin, occLast) - bandHiHz);
    const clipLo = spillLo >= spillMin;
    const clipHi = spillHi >= spillMin;
    if (limits.sideband === 'upper' || limits.sideband === 'lower') {
        const upper = limits.sideband === 'upper';
        if (upper ? clipHi : clipLo) {
            return { kind: 'narrow', spillHz: upper ? spillHi : spillLo, edge: upper ? 'high' : 'low' };
        }
    } else if (group !== 'cw' && (clipLo || clipHi)) {
        return {
            kind: 'narrow',
            spillHz: Math.max(spillLo, spillHi),
            edge: clipLo && clipHi ? 'both' : (clipLo ? 'low' : 'high'),
        };
    }

    // A second island inside the passband. After clipping — a cut signal is
    // the more urgent problem — and reported at the neighbour's peak, which is
    // where to look for it. Guarded twice (see FIT_NEIGHBOUR_*): the island
    // has to be strong enough to be a station and loud enough beside the main
    // signal, or a stray fragment of speech gets pointed at as an intruder.
    for (let k = 0; k < islands.length; k++) {
        const is = islands[k];
        if (is === main || inBandDb[k] === -Infinity) continue;
        if (is.peakDb < floorDb + FIT_NEIGHBOUR_MIN_DB) continue;
        if (inBandDb[k] < mainDb - FIT_NEIGHBOUR_REL_DB) continue;
        return { kind: 'neighbour', offsetHz: midHzOf(win, perBin, is.peakBin) };
    }

    if (group === 'cw') {
        // No wide verdict for CW — a carrier in any usable filter would earn
        // it every time, and an indicator that is always on is one that is
        // never read. With narrow refused above too, a lone CW signal simply
        // fits; only a neighbour has anything to say.
        return { kind: 'ok' };
    }

    const occLoHz = loHzOf(win, perBin, occFirst);
    const occHiHz = hiHzOf(win, perBin, occLast);
    if (limits.sideband === 'both') {
        // One verdict from the wider side, folded about the filter's middle —
        // the only shape a symmetric width control can produce.
        const centre = (bandLoHz + bandHiHz) / 2;
        const ext = Math.max(centre - occLoHz, occHiHz - centre, 0);
        const slack = width / 2 - ext;
        const frac = tuning.mode === 'fm' ? FIT_SLACK_FRAC_FM : FIT_SLACK_FRAC;
        if (slack > Math.max(FIT_SLACK_MIN_HZ, (width / 2) * frac)) {
            // Both edges: a symmetric width control cannot tighten one side.
            return { kind: 'wide', slackHz: slack, extentHz: ext * 2, edge: 'both' };
        }
        return { kind: 'ok' };
    }

    // SSB: slack judged at the far edge only. For USB that is the high edge,
    // for LSB the low one — the edge the width slider moves.
    const far = limits.sideband === 'upper' ? bandHiHz - occHiHz : occLoHz - bandLoHz;
    if (far > Math.max(FIT_SLACK_MIN_HZ, width * FIT_SLACK_FRAC)) {
        return {
            kind: 'wide',
            slackHz: far,
            extentHz: occHiHz - occLoHz,
            // The far edge — the one the width slider moves for this mode.
            edge: limits.sideband === 'upper' ? 'high' : 'low',
        };
    }
    return { kind: 'ok' };
}

/**
 * The patience, as a little state machine. Feed it rawFit()'s answer every
 * frame with the clock; read back what is worth showing — the settled verdict
 * or null.
 *
 * `state` is an empty object the first time and the same one thereafter. The
 * clock is a parameter, not Date.now(), so the tests own time.
 */
export function updateFit(state, candidate, nowMs) {
    if (candidate === null) {
        // Silence. Nothing is measurable, so nothing is *shown* — the Peak
        // and Occupancy cards read a dash at this moment and a Filter verdict
        // beside them would be a confident answer about a signal that is not
        // there. But the verdict is remembered, not forgotten: a pause between
        // overs says nothing about the station's bandwidth, so when the same
        // verdict returns with the signal it shows again instantly rather
        // than re-earning its two seconds. Only a silence long enough to mean
        // "they have gone" clears the memory.
        state.pending = null;
        if (state.shown && state.quietAt == null) state.quietAt = nowMs;
        if (state.quietAt != null && nowMs - state.quietAt >= FIT_SILENCE_MS) {
            state.shown = null;
            state.quietAt = null;
        }
        return null;
    }
    state.quietAt = null;

    if (state.shown && state.shown.kind === candidate.kind) {
        // Same verdict, fresher numbers: update in place, so a shown "wide by
        // 800 Hz" tracks the measurement without re-earning its place.
        state.shown = candidate;
        state.pending = null;
        return state.shown;
    }

    if (!state.pending || state.pending.kind !== candidate.kind) {
        state.pending = candidate;
        state.pendingAt = nowMs;
        return state.shown || null;
    }
    state.pending = candidate;
    if (nowMs - state.pendingAt >= FIT_PERSIST_MS) {
        state.shown = candidate;
        state.pending = null;
    }
    return state.shown || null;
}

/**
 * The readout's wording: `{ value, unit, tone }` for the Filter card.
 *
 * Terse on purpose — the card is a fixed cell in the readout grid and a unit
 * longer than about eight characters walks out of it. The tooltip on the card
 * carries the long version.
 */
export function formatFit(verdict) {
    if (!verdict) return { value: '—', unit: '', tone: undefined };
    const hz = (v) => (Math.abs(v) >= 950 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v / 10) * 10} Hz`);
    const signed = (v) => `${v < 0 ? '−' : '+'}${hz(Math.abs(v))}`;
    switch (verdict.kind) {
        case 'narrow': return {
            value: 'narrow',
            unit: verdict.edge === 'both' ? 'clips both' : `clips ${verdict.edge}`,
            tone: 'weak',
        };
        case 'wide': return { value: 'wide', unit: `~${hz(verdict.slackHz)}`, tone: 'weak' };
        case 'neighbour': return { value: 'shared', unit: signed(verdict.offsetHz), tone: 'weak' };
        default: return { value: 'good', unit: 'fit', tone: 'good' };
    }
}
