// Six-by-six Sudoku, with two-by-three boxes. Ported from the widget's `sudoku`.
//
// Small on purpose: a nine-by-nine grid in a dock column would be unreadable, and
// a six needs the same thinking for a tenth of the screen. The digits are 1–6 and
// each two-row, three-column box holds them once, as do each row and column.
//
// The generator is the part worth having on its own. Removing cells at random
// from a solved grid produces a puzzle with several answers surprisingly often,
// and a puzzle with several answers is one where a correct-looking grid is
// rejected — so every removal is checked to see whether the answer is still
// unique, and put back when it is not.

export const N = 6;
export const BOX_ROWS = 2;
export const BOX_COLS = 3;
export const CELLS = N * N;
export const DIGITS = [1, 2, 3, 4, 5, 6];

// How many of the 36 to take away. Twenty givens is an easy puzzle, which is what
// a game in the corner of a receiver wants: something to pick up between overs,
// not an evening's work.
export const MAX_REMOVE = 16;

const shuffled = (arr, rand) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/** Can `v` go at `i` — treating whatever is already there as empty. */
export function canPlace(g, i, v) {
    const r = Math.floor(i / N);
    const c = i % N;
    for (let k = 0; k < N; k++) {
        if (k !== c && g[r * N + k] === v) return false;
        if (k !== r && g[k * N + c] === v) return false;
    }
    const br = Math.floor(r / BOX_ROWS) * BOX_ROWS;
    const bc = Math.floor(c / BOX_COLS) * BOX_COLS;
    for (let dr = 0; dr < BOX_ROWS; dr++) {
        for (let dc = 0; dc < BOX_COLS; dc++) {
            const j = (br + dr) * N + (bc + dc);
            if (j !== i && g[j] === v) return false;
        }
    }
    return true;
}

/** Fill an empty grid by randomised backtracking. Mutates, returns success. */
export function fillGrid(g, pos = 0, rand = Math.random) {
    if (pos === CELLS) return true;
    for (const v of shuffled(DIGITS, rand)) {
        if (!canPlace(g, pos, v)) continue;
        g[pos] = v;
        if (fillGrid(g, pos + 1, rand)) return true;
        g[pos] = 0;
    }
    return false;
}

/**
 * How many ways the grid can be finished, stopping at `limit`.
 *
 * Only ever asked "is it more than one", so it gives up as soon as it knows —
 * counting every solution of a sparse grid is far slower and answers a question
 * nobody asked.
 */
export function countSolutions(grid, limit = 2) {
    const g = grid.slice();
    let count = 0;
    const solve = (pos) => {
        if (count >= limit) return;
        if (pos === CELLS) { count++; return; }
        if (g[pos] !== 0) { solve(pos + 1); return; }
        for (const v of DIGITS) {
            if (!canPlace(g, pos, v)) continue;
            g[pos] = v;
            solve(pos + 1);
            g[pos] = 0;
            if (count >= limit) return;
        }
    };
    solve(0);
    return count;
}

/** A puzzle with exactly one answer: { puzzle, given, solution }. */
export function generate(rand = Math.random) {
    const solution = new Array(CELLS).fill(0);
    fillGrid(solution, 0, rand);

    const g = solution.slice();
    let removed = 0;
    for (const i of shuffled([...Array(CELLS).keys()], rand)) {
        if (removed >= MAX_REMOVE) break;
        const backup = g[i];
        g[i] = 0;
        // Put it back if taking it away left more than one answer.
        if (countSolutions(g, 2) === 1) removed++;
        else g[i] = backup;
    }
    return { puzzle: g.slice(), given: g.map((v) => v !== 0), solution };
}

/**
 * Every filled cell that clashes with another, both sides of each clash.
 *
 * Both sides, so the display can mark the pair: telling somebody one of their
 * digits is wrong without showing what it argues with is a puzzle about the
 * puzzle.
 */
export function conflicts(grid) {
    const bad = new Set();
    for (let i = 0; i < CELLS; i++) {
        const v = grid[i];
        if (!v) continue;
        const r = Math.floor(i / N);
        const c = i % N;
        for (let k = 0; k < N; k++) {
            const a = r * N + k;
            const b = k * N + c;
            if (a !== i && grid[a] === v) { bad.add(i); bad.add(a); }
            if (b !== i && grid[b] === v) { bad.add(i); bad.add(b); }
        }
        const br = Math.floor(r / BOX_ROWS) * BOX_ROWS;
        const bc = Math.floor(c / BOX_COLS) * BOX_COLS;
        for (let dr = 0; dr < BOX_ROWS; dr++) {
            for (let dc = 0; dc < BOX_COLS; dc++) {
                const j = (br + dr) * N + (bc + dc);
                if (j !== i && grid[j] === v) { bad.add(i); bad.add(j); }
            }
        }
    }
    return bad;
}

export const isComplete = (grid) => grid.every((v) => v !== 0) && conflicts(grid).size === 0;
