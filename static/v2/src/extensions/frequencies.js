// Matching the dial against an extension's frequency menu.
//
// Both decoders offer a "Tune to…" list, and both want the same thing of it:
// when the receiver is already on one of the entries, the menu should say so
// rather than sitting on its placeholder. A select that always reads "Tune to…"
// is a control that has forgotten what it did a moment ago, and on a band plan
// nobody has memorised — 24.920 or 24.915? — that is the one question it is
// well placed to answer.
//
// The lists themselves live with each extension, since they are part of what
// that decoder is for. Only the lookup is shared.

/**
 * The menu entry the receiver is on, or null.
 *
 * `groups` is the [{ group, options: [{ hz, label }] }] shape both menus use,
 * and `hz` is the frequency to look for — the dial for FT8, and for FSK the
 * frequency of the signal, which is the dial plus the audio centre.
 *
 * The tolerance exists because that second sum does not round-trip exactly: FSK
 * tunes to `signal − centre` rounded to the nearest hertz, so recovering the
 * signal frequency can land a hertz either side of where it started. A hertz on
 * an HF dial is not a different frequency, so absorbing it here is closer to
 * the truth than showing "Tune to…" beside a receiver that is on the entry.
 *
 * Only the frequency is compared, not the mode or the passband. "Tuned to
 * 14.080" is a statement about the dial; a receiver sitting there in the wrong
 * mode has a mode problem, which the panel says separately and in its own words.
 */
export function tunedOption(groups, hz, tolerance = 1) {
    if (!Number.isFinite(hz)) return null;
    for (const g of groups || []) {
        for (const o of g.options || []) {
            if (Math.abs(o.hz - hz) <= tolerance) return o;
        }
    }
    return null;
}
