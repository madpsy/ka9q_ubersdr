// Lights Out, five by five. Ported from the widget's `lightsOut`.
//
// Pressing a light toggles it and its four neighbours; clear the board. The one
// thing to get right is the scramble: only a fraction of the 33 million possible
// boards can be turned off at all, so a random fill would hand out puzzles with
// no solution. Scrambling *by pressing* from an empty board cannot — every pressAt
// is its own inverse, so the sequence that made the board undoes it.

export const N = 5;
export const CELLS = N * N;

// Enough presses to look scrambled, few enough to be solvable in a minute or two.
const MIN_PRESSES = 5;
const MAX_PRESSES = 10;

export const idx = (r, c) => r * N + c;

/** The board after pressing (r, c): that light and its orthogonal neighbours. */
export function pressAt(grid, r, c) {
    const out = grid.slice();
    const flip = (rr, cc) => {
        if (rr >= 0 && rr < N && cc >= 0 && cc < N) out[idx(rr, cc)] = !out[idx(rr, cc)];
    };
    flip(r, c);
    flip(r - 1, c);
    flip(r + 1, c);
    flip(r, c - 1);
    flip(r, c + 1);
    return out;
}

export const litCount = (grid) => grid.reduce((n, v) => n + (v ? 1 : 0), 0);
export const isWon = (grid) => litCount(grid) === 0;

/** A scrambled board that is always solvable, and never already solved. */
export function scramble(rand = Math.random) {
    let grid = new Array(CELLS).fill(false);
    const presses = MIN_PRESSES + Math.floor(rand() * (MAX_PRESSES - MIN_PRESSES + 1));
    for (let k = 0; k < presses; k++) {
        grid = pressAt(grid, Math.floor(rand() * N), Math.floor(rand() * N));
    }
    // A sequence of presses can cancel itself out and hand back an empty board,
    // which would open as already won.
    if (isWon(grid)) grid = pressAt(grid, Math.floor(rand() * N), Math.floor(rand() * N));
    return grid;
}
