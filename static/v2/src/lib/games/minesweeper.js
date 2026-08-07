// Minesweeper — 8×8, ten mines. A port of the widget's `ms`.
//
// Two rules carry the whole game and both are here rather than in the component:
// the first click is always safe *and* opens onto space (mines are laid after it,
// avoiding the square and its neighbours), and revealing an empty square reveals
// its neighbours too, outwards until the numbers stop it. Getting either wrong
// produces a game that still looks like Minesweeper and is not one.

export const ROWS = 8;
export const COLS = 8;
export const CELLS = ROWS * COLS;
export const MINES = 10;
export const MINE = -1;

export const idx = (r, c) => r * COLS + c;
export const rowOf = (i) => Math.floor(i / COLS);
export const colOf = (i) => i % COLS;

export function neighboursOf(r, c) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) out.push([nr, nc]);
        }
    }
    return out;
}

/**
 * The field, laid after the first click so that click cannot lose.
 *
 * The square itself and all eight around it are kept clear, not just the square:
 * a first click that survives but reveals a single "8" is a game with nothing to
 * go on, and every implementation worth playing does this.
 *
 * `rand` is injected so a test can lay a known field.
 */
export function placeMines(safeR, safeC, rand = Math.random) {
    const board = Array(CELLS).fill(0);
    const safe = new Set([[0, 0], ...neighboursOf(safeR, safeC).map(([r, c]) => [r - safeR, c - safeC])]
        .map(([dr, dc]) => idx(safeR + dr, safeC + dc)));

    let placed = 0;
    while (placed < MINES) {
        const i = Math.floor(rand() * CELLS);
        if (board[i] === MINE || safe.has(i)) continue;
        board[i] = MINE;
        placed++;
    }

    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (board[idx(r, c)] === MINE) continue;
            board[idx(r, c)] = neighboursOf(r, c)
                .filter(([nr, nc]) => board[idx(nr, nc)] === MINE).length;
        }
    }
    return board;
}

/**
 * Everything a click on (r, c) opens, as a new revealed array.
 *
 * Iterative rather than recursive: a first click on an empty 8×8 can open most of
 * the board, and a stack is one less thing to reason about than sixty frames of
 * recursion. Flagged squares stop it, which is what makes flags useful.
 */
export function floodReveal(board, revealed, flagged, r, c) {
    const out = revealed.slice();
    const stack = [[r, c]];
    while (stack.length) {
        const [cr, cc] = stack.pop();
        const i = idx(cr, cc);
        if (out[i] || flagged[i]) continue;
        out[i] = true;
        if (board[i] === 0) {
            for (const [nr, nc] of neighboursOf(cr, cc)) stack.push([nr, nc]);
        }
    }
    return out;
}

/** Cleared when everything that is not a mine has been revealed. */
export function isWon(revealed) {
    return CELLS - revealed.filter(Boolean).length === MINES;
}

export function minesLeft(flagged) {
    return MINES - flagged.filter(Boolean).length;
}
