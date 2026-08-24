// The bar scope's background: where the audio's energy actually is.
//
// The bars say how loud each frequency is *now*, and the eye reads them as a
// shape — but the thing they cannot show is proportion. A voice with all its
// energy under 500 Hz and a voice spread evenly to 3 kHz draw much the same
// picture once the auto-level has magnified each to fill the panel, because
// that level is relative and every frame is normalised to its own loudest bin.
//
// So the background carries the other half: how each part of the band is doing
// *relative to the rest of the band*, right now. Warm where a region is taking
// more than its share of the energy, cool where it is taking less, and one flat
// colour across the whole panel when the audio is evenly spread — which is the
// property that makes it readable at a glance rather than a second thing to
// interpret. Bass-heavy audio glows warm at the left, a hissy channel warm at
// the right, a well-balanced signal not at all.
//
// ── Why it is a share, not a level ───────────────────────────────────────────
//
// Everything here is normalised to the band's own total power, so the tint says
// nothing about volume: turning the audio down leaves it unchanged, which is
// what makes it a second instrument rather than a paler copy of the bars.
// "Zero" is the share a region would have if the energy were spread perfectly
// evenly — so the reference is a *fixed* idea of balance, not the frame's own
// spread. That is deliberate and is the whole of the requirement that evenly
// spread audio comes out one colour: normalise against the frame's own extremes
// instead and a dead-flat band would be stretched into a full rainbow of
// nothing.
//
// ── Why it is smoothed twice ─────────────────────────────────────────────────
//
// Across frequency, because the question is "is this region hot", not "is this
// bin hot" — the bars already answer the second one, and a background that
// tracked individual bins would be a blurry second copy of them. A few dozen
// zones, three-tap smoothed, then handed to a canvas gradient which interpolates
// the rest: what is drawn is smooth by construction.
//
// And across time, because a spectrum frame is a noisy estimate and speech is
// not stationary: without it the background strobes on every syllable. A ~400 ms
// time constant is slow enough to read as a wash and fast enough to follow a
// change of speaker.
//
// ── Silence ──────────────────────────────────────────────────────────────────
//
// With the gate shut there is no energy to take shares of, and the ratios become
// a picture of dither. So the tint fades to flat as the band approaches silence
// rather than colouring noise — the one case where "all one colour" means
// nothing rather than everything.

// How many zones the band is divided into for the background. Enough that a
// formant-sized region is a zone or two; far too few to resolve a bar, which is
// the point.
export const TINT_ZONES = 24;

// How far from even the colour scale reaches — and it is not a fixed number,
// because a fixed one is wrong at both ends of the range it has to cover.
//
// Set it low and every real signal saturates: a voice puts thirty decibels
// between its formants and the top of the band, so an eight-decibel scale
// paints two colours, one at each end, and the shape in between — which is the
// interesting part — is lost. Set it high and quiet, subtle imbalances never
// leave the neutral colour at all.
//
// So the scale is the band's own spread: whatever range of shares is actually
// present is what the colours are spent on. That is what makes the display
// read as "where is this audio's energy" rather than "is this audio louder
// than some number somebody chose".
//
// The floor is what keeps the promise about even audio. Without one, a band
// that is flat to within a decibel would have that decibel stretched across
// the whole scale and paint a full rainbow of nothing; with it, a spread
// smaller than the floor stays bunched near the neutral colour, which is the
// flat background an evenly spread signal is supposed to have. The ceiling
// only stops one freak zone — a dead notch reading -60 dB below even — from
// flattening everything else.
export const TINT_SPAN_MIN_DB = 10;
export const TINT_SPAN_MAX_DB = 40;

// Bends the scale toward its ends, so a moderate imbalance is already visibly
// coloured rather than sitting halfway to neutral.
export const TINT_GAMMA = 0.8;

// How much spread there has to be before the colours are used at full strength.
//
// The rank scale below spends the whole ramp on whatever range is present, so
// on its own it would paint a rainbow across a band that is flat to within a
// decibel — the ranks are still an order even when the differences are noise.
// This is the answer to that: the colours come up in proportion to how much
// real spread there is, reaching full strength at TINT_SPAN_MIN_DB. Under a
// decibel or two of variation the whole panel stays near neutral, which is the
// flat background evenly spread audio is supposed to have.

// Where the spread is measured, as a percentile of the zones' deviations from
// even. Not the extreme, which one notch or one carrier would own; high enough
// that the bulk of the picture uses most of the scale.
export const TINT_SPREAD_PCT = 0.9;

// The time constant of the temporal smoothing.
export const TINT_TAU_MS = 400;

// Below this the band is treated as silent and the tint goes flat: the level of
// the *loudest* bin in it, in dBFS.
//
// The loudest and not the average, which is what this was and was wrong. Most
// of an audio spectrum sits near the analyser's floor at any moment — a voice
// is a few busy hundred hertz and a lot of quiet — so the mean across the band
// lands under any sane silence line while the audio is plainly audible. The
// gate closed on real signals and the whole panel painted one flat neutral,
// which is exactly what "impossibly faint, just grey" looks like. The peak is
// the honest test for "is there anything here at all".
export const TINT_SILENCE_DB = -85;
// ...and the range over which it fades out, so the gate closing is a wash
// rather than a switch.
export const TINT_FADE_DB = 10;

/**
 * Each zone's share of the band's power, in dB relative to an even spread.
 *
 * 0 dB is exactly its share; +10 is ten times it; -10 a tenth. `bins` is the
 * analyser's dBFS array, `start`/`count` the part of it being drawn.
 *
 * Returns `{ rel, quiet }` — `rel` is `out` filled in, `quiet` a 0..1 fade
 * where 1 is "loud enough to mean something" and 0 is silence.
 */
export function zoneShares(bins, start, count, out) {
    const zones = out.length;
    const p = new Float64Array(zones);
    let total = 0;
    let peakDb = -Infinity;
    let n = 0;
    for (let z = 0; z < zones; z++) {
        const lo = start + Math.floor((z / zones) * count);
        const hi = Math.max(lo + 1, start + Math.floor(((z + 1) / zones) * count));
        let sum = 0;
        let k = 0;
        for (let i = lo; i < hi; i++) {
            const db = bins[i];
            if (!Number.isFinite(db)) continue;
            // Power, not decibels: the mean of a column of dB is the geometric
            // mean of the powers, which is not a share of anything. Same
            // reasoning as the IF pane's shape average.
            sum += 10 ** (db / 10);
            if (db > peakDb) peakDb = db;
            k++;
            n++;
        }
        p[z] = k ? sum / k : 0;      // mean power, so zones of unequal bin count compare
        total += p[z];
    }

    if (!(total > 0) || !n) {
        out.fill(0);
        return { rel: out, quiet: 0 };
    }
    const even = total / zones;
    for (let z = 0; z < zones; z++) {
        out[z] = p[z] > 0 ? 10 * Math.log10(p[z] / even) : -TINT_SPAN_DB;
    }

    const quiet = Math.max(0, Math.min(1, (peakDb - TINT_SILENCE_DB) / TINT_FADE_DB));
    return { rel: out, quiet };
}

/**
 * Each zone's place on the colour scale, -1..+1, with 0 — green — pinned to
 * the zones carrying exactly the average energy, and rank rather than distance
 * deciding the rest.
 *
 * An audio spectrum is bimodal and a linear scale cannot draw it. The busy part
 * of the band sits thirty or forty decibels above the analyser's floor and the
 * rest of the band sits on the floor; there is almost nothing in between. Map
 * that linearly — however the centre and the span are chosen — and every zone
 * lands far from the middle: one group clamps hot, the other clamps cold, and
 * the display is two colours with nothing between them.
 *
 * Ranking fixes it by construction. The coldest zone is at -1, the hottest at
 * +1, and everything else is spread evenly between them, so the ramp is always
 * fully used and a band always reads as a graduation. This is histogram
 * equalisation, and it is the same trick a waterfall's auto-levelling is doing
 * for the same reason.
 *
 * Ties share a rank — averaged, so a run of equal zones gets one value and
 * therefore one colour, whatever else is in the band. That is the promise this
 * whole file rests on and it is exact here rather than approximate: equal
 * energy in, identical colour out.
 *
 * `scale` (0..1) is how strongly to use the ramp — see TINT_SPAN_MIN_DB.
 */
export function rankTint(rel, out, scale = 1) {
    const n = rel.length;
    if (!n) return out;

    // Zero is not an arbitrary middle: `rel` is measured against the even
    // share, so a zone at exactly 0 dB is one carrying exactly the average
    // energy. That is the point green is nailed to, and it is why the ranking
    // is done in two halves rather than over the band as a whole — ranked in
    // one pass, the middle of the ramp would land on the *median* zone, which
    // is wherever the middle of the distribution happens to fall and is not the
    // average of anything.
    //
    // So: everything under the average is spread across blue-to-green by its
    // rank among the zones under the average, everything over it across
    // green-to-red the same way, and a zone sitting on the average is green
    // outright. Both halves still use their whole sub-ramp, which is what keeps
    // a lopsided band — most of it quiet, a little of it loud — from painting
    // its quiet majority in one flat blue.
    //
    // Ties share a rank within their half, so equal energy is still exactly
    // equal colour. A perfectly even band is every zone at 0: all green, which
    // is the flat background evenly spread audio is supposed to have.
    let below = 0;
    let above = 0;
    for (let i = 0; i < n; i++) {
        if (rel[i] < 0) below++;
        else if (rel[i] > 0) above++;
    }
    for (let i = 0; i < n; i++) {
        const v = rel[i];
        if (v === 0) { out[i] = 0; continue; }
        const hot = v > 0;
        const m = hot ? above : below;
        // Rank within this half, ties averaged, as a 0..1 position. The half
        // step at each end keeps a lone member off the extreme of the ramp —
        // one zone a shade under the average is not the coldest thing there
        // could ever be.
        let lower = 0;
        let equal = 0;
        for (let j = 0; j < n; j++) {
            const w = rel[j];
            if (w === 0 || (w > 0) !== hot) continue;
            if (hot ? w < v : w > v) lower++;
            else if (w === v) equal++;
        }
        const r = (lower + (equal - 1) / 2 + 0.5) / m;
        out[i] = (hot ? r : -r) * scale;
    }
    return out;
}

/** Three-tap smoothing along the band, in place via `scratch`. */
export function smoothZones(vals, scratch) {
    const n = vals.length;
    if (n < 3 || scratch.length !== n) return vals;
    scratch.set(vals);
    for (let i = 0; i < n; i++) {
        const a = scratch[i > 0 ? i - 1 : 0];
        const b = scratch[i];
        const c = scratch[i < n - 1 ? i + 1 : n - 1];
        vals[i] = (a + 2 * b + c) / 4;
    }
    return vals;
}

/**
 * The middle of this band — the share a typical zone has, in dB relative to an
 * even spread. The point the colour scale is centred on.
 *
 * The median rather than the even share itself, and the difference is the whole
 * look of the display. "Even" is the *mean* power, and a mean is dragged up by
 * whatever is loudest: put a voice's energy in three zones out of twenty-four
 * and the even share sits above nearly all of them, so nearly every zone reads
 * as starved and the panel paints blue almost everywhere with a spot of red
 * where the voice is. That is a true statement about mean power and a useless
 * picture — it says "most of the band is not the loudest part of the band",
 * which was never in doubt.
 *
 * The median says something worth drawing instead: most of the band is
 * *typical*, and the colours are spent on what departs from typical in either
 * direction. A flat band still has every zone at its median, so evenly spread
 * audio is still one flat colour — the promise survives the change of centre.
 */
export function centreOf(rel, scratch) {
    const n = rel.length;
    if (!n) return 0;
    const buf = scratch && scratch.length >= n ? scratch.subarray(0, n) : new Float32Array(n);
    buf.set(rel.subarray ? rel.subarray(0, n) : rel);
    buf.sort();
    const mid = n >> 1;
    return n % 2 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2;
}

/**
 * How far from the centre this band's zones actually are — the scale the
 * colours are spent on. A high percentile of |rel - centre| rather than the
 * maximum, so one dead notch cannot set the scale for everything else, clamped
 * into the range where the answer stays meaningful.
 */
export function spreadOf(rel, scratch, centre = 0, floorDb = TINT_SPAN_MIN_DB) {
    const n = rel.length;
    if (!n) return TINT_SPAN_MIN_DB;
    const buf = scratch && scratch.length >= n ? scratch.subarray(0, n) : new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.abs(rel[i] - centre);
    buf.sort();
    const at = buf[Math.min(n - 1, Math.round(TINT_SPREAD_PCT * (n - 1)))];
    return Math.max(floorDb, Math.min(TINT_SPAN_MAX_DB, at));
}

/** Ease `state.rel` toward `vals` with the TINT_TAU_MS time constant. */
export function easeZones(state, vals, dtMs, tauMs = TINT_TAU_MS) {
    const n = vals.length;
    if (!state.rel || state.rel.length !== n) {
        state.rel = Float32Array.from(vals);
        return state.rel;
    }
    // Frame-rate independent: the same time constant however fast frames come.
    const a = dtMs > 0 ? 1 - Math.exp(-dtMs / Math.max(1, tauMs)) : 1;
    for (let i = 0; i < n; i++) state.rel[i] += (vals[i] - state.rel[i]) * a;
    return state.rel;
}

// The two ends of the scale and the colour of balance.
//
// Blue under the average, green on it, red over it — the reading everyone
// already has for cold, normal and hot, and the middle of it is a colour in its
// own right rather than an absence. A near-black middle made the panel look
// like it had a hole in it where the ordinary part of the band was.
//
// The three are kept at much the same brightness on purpose, so the scale reads
// as a change of hue rather than of light, and all three stay dark enough to
// sit behind bars painted in the spectrum palette.
export const TINT_COLD = [16, 46, 112];
export const TINT_EVEN = [22, 64, 36];
export const TINT_HOT = [140, 54, 16];

// ...and the panel's own black, which is where the whole scale goes when there
// is no audio. The bar view paints its background with this too, so the two
// cannot drift apart and leave a silent panel a shade off its own edges.
//
// Silence has to land here rather than on the middle of the ramp. Fading to the
// middle would say "every part of this band has an average share of the
// energy", which is true of an empty band in the arithmetic and absurd on the
// screen: the gate shuts and the panel turns green. Black is what the waterfall
// above it does with the same silence, and it is what nothing should look like.
export const TINT_SILENT = [5, 7, 12];

/**
 * The background colour for a place on the scale, -1 (coldest) to +1 (hottest),
 * as `rgb(...)`.
 *
 * `quiet` fades the whole scale toward the panel's black, so a band with no
 * audio in it goes dark exactly as the waterfall above it does, rather than
 * settling on the middle of the ramp and turning the panel green.
 */
export function tintColour(pos, quiet = 1) {
    const raw = Math.max(-1, Math.min(1, pos || 0));
    const t = Math.sign(raw) * Math.abs(raw) ** TINT_GAMMA;
    const to = t >= 0 ? TINT_HOT : TINT_COLD;
    const k = Math.abs(t);
    // Where this zone sits on the scale...
    const ramp = (i) => TINT_EVEN[i] + (to[i] - TINT_EVEN[i]) * k;
    // ...and how much of the scale is showing at all: none of it in silence,
    // which fades the lot to black rather than to the middle of the ramp.
    const q = Math.max(0, Math.min(1, quiet));
    const mix = (i) => Math.round(TINT_SILENT[i] + (ramp(i) - TINT_SILENT[i]) * q);
    return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

/**
 * Everything the drawing needs, in one call: the eased, smoothed shares and the
 * colour for each zone.
 *
 * `state` is kept by the caller between frames — `{}` the first time.
 */
export function tintZones(state, bins, start, count, nowMs, zones = TINT_ZONES) {
    if (!state.raw || state.raw.length !== zones) {
        state.raw = new Float32Array(zones);
        state.scratch = new Float32Array(zones);
        state.rel = null;
        state.at = 0;
        state.span = null;
    }
    const { quiet } = zoneShares(bins, start, count, state.raw);
    smoothZones(state.raw, state.scratch);
    const dt = state.at ? nowMs - state.at : 0;
    state.at = nowMs;
    const rel = easeZones(state, state.raw, dt);
    // The scale is eased along with everything else. It is derived from the
    // *eased* shares rather than the raw ones so it cannot chase a transient,
    // and easing it again keeps a change of signal from re-scaling the picture
    // faster than the eye can follow.
    // How much of the ramp to use: all of it once the band has a real spread,
    // proportionally less as it flattens toward one level.
    const mid = centreOf(rel, state.scratch);
    const want = spreadOf(rel, state.scratch, mid);
    const ease = dt ? 1 - Math.exp(-dt / TINT_TAU_MS) : 1;
    state.span = state.span == null ? want : state.span + (want - state.span) * ease;
    // The fade is eased too, or the gate opening snaps the whole background on.
    state.quiet = state.quiet == null || !dt ? quiet : state.quiet + (quiet - state.quiet) * ease;

    if (!state.pos || state.pos.length !== zones) state.pos = new Float32Array(zones);
    // spreadOf floors at TINT_SPAN_MIN_DB, so a flat band reports the floor and
    // the raw spread has to be measured again here to know it was flat.
    const raw = spreadOf(rel, state.scratch, mid, 0);
    rankTint(rel, state.pos, Math.max(0, Math.min(1, raw / TINT_SPAN_MIN_DB)));
    return { pos: state.pos, rel, quiet: state.quiet, span: state.span, centre: mid };
}
