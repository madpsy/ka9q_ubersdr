// Per-panel text size, on top of the global one.
//
// The top bar's zoom sets the size of everything at once, which is the setting
// most people want and the only one v1 had. It is the wrong tool for one panel:
// a spot table wants to be small because it is a list you scan, a frequency
// readout wants to be large because you read it across the room, and setting the
// whole interface to suit either one is a compromise made in the wrong place.
//
// So a panel stores an *offset*, not a size. Global 110% with one panel nudged
// down twice is that panel at 100%, and moving the global control afterwards
// moves the panel with it — still two steps smaller than everything else. The
// alternative, storing the panel's own absolute size, strands it: the global
// zoom silently stops applying to every panel anybody has ever touched, and the
// control in the top bar quietly becomes "the size of the panels I have not
// adjusted", which is not a thing anybody can hold in their head.
//
// The offset is stored, the effective size is what gets clamped. That ordering
// matters at the ends of the range: a panel two steps below a global of 75% is
// drawn at 75% because that is the floor, and it goes back to being two steps
// smaller the moment the global comes off the floor. Clamping the offset instead
// would have thrown the two steps away.

/**
 * What this panel is actually drawn at.
 *
 * @param base   the global scale.
 * @param delta  this panel's offset, in the same units.
 * @param range  { min, max } from the display settings.
 */
export function panelScale(base, delta, range) {
    const b = Number(base) || 1;
    const d = Number(delta) || 0;
    return Math.min(range.max, Math.max(range.min, Math.round((b + d) * 100) / 100));
}

/**
 * The offset after one press of zoom in (`dir` 1) or zoom out (`dir` -1).
 *
 * Worked out through the effective size rather than by adding to the offset, so
 * a press always moves the panel by exactly one step or does nothing at all —
 * at the top of the range, adding to the offset would store presses that had no
 * effect and then have to be pressed back out again.
 */
export function nudgeScale(base, delta, dir, range) {
    const b = Number(base) || 1;
    const now = panelScale(b, delta, range);
    const next = Math.min(range.max, Math.max(range.min, Math.round((now + dir * range.step) * 100) / 100));
    if (next === now) return Number(delta) || 0;
    return Math.round((next - b) * 100) / 100;
}

/** Whether a press in that direction would change anything. */
export function canScale(base, delta, dir, range) {
    return panelScale(base, delta, range) !== panelScale(base, nudgeScale(base, delta, dir, range), range);
}

/**
 * What comes back out of a stored layout. Anything that is not a usable number
 * is no offset at all, and the range is generous — wider than any global scale
 * plus any sane offset — because it is a guard against nonsense in
 * localStorage, not a second opinion about what the buttons allow.
 */
export function cleanScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) return 0;
    return Math.min(1, Math.max(-1, Math.round(n * 100) / 100));
}
