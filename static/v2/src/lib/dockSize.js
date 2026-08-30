// How tall the bottom dock is allowed to be.
//
// It shares .shell__column with the spectrum, so its ceiling is a share of that
// column and not a number of pixels settled on in advance: 560px — what the
// layout clamp used to allow — is two thirds of a 768px laptop's column and a
// quarter of a 1440p one. Too much on the machine that could least afford it,
// and a cap that never engaged on the one that could.
//
// Kept out of CSS on purpose. `max-height: 75%` would resolve against the
// containing block, and for a peeked dock — an overlay rendered inside the
// collapsed rail — that block is a 30px strip rather than the column the
// overlay is drawn over. The column has to be found by climbing to it, which
// only JavaScript can do, and the same figure then clamps the resizer drag so
// dragging past the floor cannot bank dead travel the operator has to come back
// through.
//
// The arithmetic lives here, apart from the measuring, because it is the part
// with edges worth pinning — see test/docksize.test.js.

// The share of the column the dock may take.
export const CEILING_SHARE = 0.75;

// ...and the strip of spectrum it may never take whatever that share works out
// to. Three quarters of a short column still leaves the waterfall a sliver, and
// the waterfall is what the receiver is for.
export const SPECTRUM_KEEP = 200;

// The ceiling for a column of `columnHeight` pixels.
//
// Three terms, in the order they bind: the share, then the strip the spectrum
// keeps, then the dock's own floor — which wins on a window too short for
// either, since a dock shorter than one panel header is no use to anybody and
// the spectrum has to give way instead.
//
// An unmeasured column (nothing rendered yet, or no column found) returns
// Infinity rather than a guess: no cap is the behaviour that was there before
// any of this, and the layout's own maxSize still bounds what can be stored.
export function dockCeiling(columnHeight, minSize) {
    if (!Number.isFinite(columnHeight) || columnHeight <= 0) return Infinity;
    return Math.max(minSize, Math.min(columnHeight * CEILING_SHARE, columnHeight - SPECTRUM_KEEP));
}

// What to actually draw the dock at: what the operator asked for, capped.
//
// The asked-for size is never rewritten — a window that gets its space back
// brings the chosen size back with it, rather than leaving the operator at
// whatever fitted when the window was small.
export function fitDock(size, ceiling) {
    return Math.min(size, ceiling);
}

// The element the ceiling is measured against, found from anywhere inside the
// dock.
//
// Climbed to, never taken as the parent. A peeked dock is an overlay rendered
// inside the collapsed rail, so its parent is a 30px strip: measuring that gave
// a ceiling of the dock's own floor, and a peek that could not be resized at
// all. The column is the one box that means the same thing in both cases — the
// space the dock shares with the spectrum, whether it is sitting in it or drawn
// over it.
export function columnOf(el) {
    return el && typeof el.closest === 'function' ? el.closest('.shell__column') : null;
}
