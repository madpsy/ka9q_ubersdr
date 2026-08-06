// What a gesture on a sheet's title bar meant.
//
// Pulled out of MobileShell so the thresholds can be tested rather than guessed
// at on a phone, and because the interesting part is a decision rather than any
// of the pointer plumbing around it — the same split as lib/barrel.js and
// Barrel.jsx.
//
// A sheet has two states, cut down and whole, and three ways to ask for one:
//
//   the button   unambiguous, and the only one a screen reader or a keyboard
//                can reach. It stays, and the two below are additions to it.
//   a tap        anywhere on the bar. A title bar is the biggest target a sheet
//                has and it did nothing at all, while the control it should
//                have been was a 30 px icon in the corner.
//   a drag       up for the whole panel, down for the cut-down one. This is what
//                the grip pill has been drawing a picture of since the sheet
//                existed; the direction is the one every bottom sheet on either
//                platform uses, and it says *which* state you want rather than
//                "the other one", so a drag can be repeated without flipping
//                back and forth.

// How far a finger may travel and still have been a tap. The same 8 px the
// spectrum uses to tell a tap-to-tune from a filter-edge drag: a fingertip that
// means to stay still moves a few pixels, and both places have to let it.
export const SHEET_SLOP_PX = 8;

/**
 * @param dx, dy  total travel from where the finger landed, CSS px. y grows down.
 * @returns 'tap' | 'expand' | 'minimise' | null
 *
 * null is a gesture that was not aimed at this: a mostly sideways drag. Nothing
 * on a sheet header scrolls horizontally, but a finger sliding across it on the
 * way somewhere else should not change what the panel is showing, and "it was
 * further across than up" is the cheapest way to say so.
 */
export function sheetIntent(dx, dy, slop = SHEET_SLOP_PX) {
    if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) return 'tap';
    if (Math.abs(dx) > Math.abs(dy)) return null;
    return dy < 0 ? 'expand' : 'minimise';
}

/**
 * The state a gesture asks for, or null for "leave it alone".
 *
 * Returned as the value wanted rather than as an instruction to flip, so the
 * caller can compare it with what is already showing — dragging down twice on a
 * sheet that is already cut down has to be a no-op, not a toggle back.
 *
 * `minimal` is what the sheet is showing now, which is what makes a tap
 * expressible here at all.
 */
export function sheetWants(intent, minimal) {
    if (intent === 'tap') return !minimal;
    if (intent === 'expand') return false;
    if (intent === 'minimise') return true;
    return null;
}
