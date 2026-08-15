// Which markers to draw *inside* the frequency drum, and where.
//
// The drum's two ends already carry the previous and next marker as step
// buttons (MarkerEdges). Those answer "what is nearby"; they cannot answer
// "where is it", which is the question a scale is for — a name at one end says
// nothing about whether the signal is one turn away or twenty.
//
// So the middle gets marks too, at their real place on the scale. That is the
// whole value and also the whole risk: a busy band puts forty spots across one
// span, and forty names over a 48 px drum is a smear that hides the numbers
// underneath. Everything here is about refusing to draw them.
//
// Pure, and given plain numbers, because every rule below is a judgement about
// spacing that is far easier to check as arithmetic than by squinting at a
// waterfall: what fits, what is dropped, and what happens when the room runs
// out entirely.

/**
 * How much of each end belongs to the step buttons.
 *
 * The button itself is 28 px, and its name hangs inwards from it — up to 108 px
 * (.barrel__edge-text). A mark under that name is two names in one place, so
 * the ends are simply not available while the buttons are shown.
 */
export const EDGE_RESERVE_PX = 140;

/** ...and when they are not, only the fade at each end is spoken for. */
export const PLAIN_RESERVE_PX = 12;

/**
 * The narrowest middle worth marking at all.
 *
 * Below this the drum is doing well to show its own numbers, and a mark or two
 * squeezed in beside them is clutter rather than information — the case the
 * request called "clearly not enough space". A phone's pad is about 300 px
 * wide, so with the step buttons up it stays plain and the ends carry the
 * marker names on their own, which is what that width can afford.
 */
export const MIN_ROOM_PX = 220;

/**
 * ...and the narrowest worth marking *the dial itself* on.
 *
 * The rule above is about marks in general: names scattered along a scale need
 * room between them or they read as one smear. The marker under the dial is a
 * different case and deserves a different threshold. There is only ever one of
 * it, it sits in the middle — the furthest point from the step buttons, which
 * is where the room is — and it is the one thing on the drum that cannot be
 * worked out from the numbers.
 *
 * A phone in portrait is exactly that case: about 110 px of middle once the
 * ends are spoken for, which is nothing like enough for a scattering of names
 * and plenty for one short one in the centre.
 */
export const MIN_ROOM_CURRENT_PX = 88;

/**
 * How close two marks may sit.
 *
 * A shortened name is about eight characters — some 56 px at the drum's type
 * size — so 96 px leaves a clear gap between neighbours rather than two names
 * that appear to be one. Anything closer is dropped, not shrunk: half a
 * callsign is worse than no callsign.
 */
export const MIN_GAP_PX = 96;

/** At most this many, however wide the drum is. Four names is a scale with
 *  marks on it; ten is a list drawn on top of a ruler. */
export const MAX_MARKS = 4;

/**
 * What makes two readings of the same marker the same mark.
 *
 * Rounded, and that matters: a voice-activity marker's frequency wobbles by a
 * few hertz between detections, so an identity built on the exact number
 * changed on every poll — React saw a different element, unmounted the old one
 * and mounted a new one, and the mark blinked where nothing had actually moved.
 * The name is left out for the same reason: a spot can be re-reported with its
 * comment tidied up, and that is not a different signal.
 */
export function markId(marker) {
    const hz = Math.round((marker.freq || 0) / 100) * 100;
    return `${marker.type || 'mark'}:${hz}`;
}

/**
 * Place marks along the drum.
 *
 * `markers` are the collected markers (see collectMarkers) — anything with a
 * `freq`. `centreHz` is the dial, which is the middle of the drum, and one
 * detent is `stepHz` wide and `detentPx` across, so a marker's offset from the
 * centre falls straight out of those.
 *
 * `currentHz` is the marker the dial is sitting on, if any. It is placed first
 * and takes the middle whatever else wanted it: where you *are* outranks what
 * is nearby, and it is the one mark that cannot be inferred from the numbers.
 *
 * `keep` are the ids drawn last time, which win over equally-placed newcomers —
 * see below. Together with the scale ordering it is what stops the set
 * changing under a turning drum.
 *
 * Returns `[{ id, freq, x, marker }]`, x in CSS px from the centre, left to
 * right. Empty when the drum is too narrow to be worth marking.
 */
export function placeBarrelMarks({
    markers,
    centreHz,
    stepHz,
    detentPx,
    widthPx,
    edges = true,
    max = MAX_MARKS,
    minGapPx = MIN_GAP_PX,
    currentHz = null,
    keep = [],
} = {}) {
    if (!Array.isArray(markers) || !markers.length) return [];
    if (!(centreHz > 0) || !(stepHz > 0) || !(detentPx > 0) || !(widthPx > 0)) return [];

    const reserve = edges ? EDGE_RESERVE_PX : PLAIN_RESERVE_PX;
    const room = widthPx - reserve * 2;
    const half = room / 2;
    const at = (hz) => ((hz - centreHz) / stepHz) * detentPx;

    // Too narrow for marks in general — but not necessarily for the one under
    // the dial. See MIN_ROOM_CURRENT_PX.
    if (room < MIN_ROOM_PX) {
        if (currentHz == null || room < MIN_ROOM_CURRENT_PX) return [];
        const here = markers.find((m) => m && m.freq === currentHz);
        if (!here) return [];
        // Capped to the room it actually has: a long name at full width would
        // reach under the step buttons' own captions, which is the crowding
        // this file exists to prevent rather than a special case that escapes
        // it. The name gives ground with an ellipsis; the chip stays put.
        return [{ id: markId(here), freq: here.freq, x: 0, marker: here, maxWidthPx: Math.round(room) }];
    }

    // Everything on screen, in scale order.
    //
    // Scale order and not "nearest the dial first", which is what this did at
    // first and is why the marks flickered while the drum was turning. Sorting
    // by distance from the centre means the order *permutes* as the centre
    // moves: two markers a few hundred hertz apart swap places every time the
    // dial passes between them, the greedy pass below then makes a different
    // choice, and a mark that was on screen vanishes while its neighbour
    // appears. Left to right is fixed by the band rather than by the dial, so
    // the same markers keep winning as the drum turns and one only comes or
    // goes when it genuinely enters or leaves the view.
    const candidates = [];
    for (const m of markers) {
        if (!m || !(m.freq > 0)) continue;
        const x = at(m.freq);
        if (!Number.isFinite(x) || Math.abs(x) > half) continue;
        candidates.push({ id: markId(m), freq: m.freq, x, marker: m });
    }
    if (!candidates.length) return [];
    candidates.sort((a, b) => a.freq - b.freq);

    const placed = [];
    const fits = (c) => placed.length < max && !placed.some((p) => Math.abs(p.x - c.x) < minGapPx);
    const take = (c) => { if (c && !placed.includes(c) && fits(c)) placed.push(c); };

    // The dial's own marker first, so a crowd either side cannot take its place.
    if (currentHz != null) take(candidates.find((c) => c.freq === currentHz));

    // Then whatever was already on screen, which is the other half of holding
    // still: where two markers are too close for both, the one being looked at
    // keeps the place rather than trading it with its neighbour every few
    // hertz. A kept mark still goes when it leaves the view or when the dial's
    // own marker wants its space.
    const keeping = new Set(keep || []);
    if (keeping.size) for (const c of candidates) if (keeping.has(c.id)) take(c);

    for (const c of candidates) take(c);
    return placed.sort((a, b) => a.x - b.x);
}
