// Connect 4, with an opponent that looks four moves ahead. Ported from the
// widget's `c4`.
//
// Unlike noughts and crosses this cannot be solved in a browser tab, so the AI is
// a depth-limited alpha–beta search over a positional heuristic — three in a row
// with room to finish is worth something, an opponent's three is worth stopping,
// and the centre column is worth holding because more lines run through it.
//
// The blunder rate is the same adaptive one the other board game uses, and for
// the same reason: an opponent that always plays its best is a game you stop
// playing. See lib/games/ttt.js, which owns that rule.

export const ROWS = 6;
export const COLS = 7;
export const CELLS = ROWS * COLS;
export const EMPTY = 0;
export const HUMAN = 1;
export const AI = 2;

// Centre first: it is both the best column and the one alpha–beta prunes most
// from, so searching it first makes the same answer arrive sooner.
const ORDER = [3, 2, 4, 1, 5, 0, 6];
const SEARCH_DEPTH = 4;

export const idx = (r, c) => r * COLS + c;
export const emptyBoard = () => Array(CELLS).fill(EMPTY);

/** The row a disc dropped down `col` would land in, or -1 when it is full. */
export function dropRow(b, col) {
    for (let r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === EMPTY) return r;
    return -1;
}

// Every four-in-a-row on the board, once each. Built once and reused by the win
// test, the highlight and the heuristic — the widget wrote the same four nested
// loops out four times over, which is four chances to get a bound wrong.
function buildLines() {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c <= COLS - 4; c++) out.push([0, 1, 2, 3].map((d) => idx(r, c + d)));
    }
    for (let r = 0; r <= ROWS - 4; r++) {
        for (let c = 0; c < COLS; c++) out.push([0, 1, 2, 3].map((d) => idx(r + d, c)));
    }
    for (let r = 0; r <= ROWS - 4; r++) {
        for (let c = 0; c <= COLS - 4; c++) out.push([0, 1, 2, 3].map((d) => idx(r + d, c + d)));
    }
    for (let r = 0; r <= ROWS - 4; r++) {
        for (let c = 3; c < COLS; c++) out.push([0, 1, 2, 3].map((d) => idx(r + d, c - d)));
    }
    return out;
}

export const LINES = buildLines();

export const hasWon = (b, player) => LINES.some((line) => line.every((i) => b[i] === player));

export function winLine(b, player) {
    return LINES.find((line) => line.every((i) => b[i] === player)) || null;
}

export const isFull = (b) => b.every((v) => v !== EMPTY);

// What a single four-square window is worth to `player`. Nothing subtle: a
// finished line, a line one short, a line two short, and an opponent's line one
// short — which is scored below zero so blocking is preferred to building.
function scoreWindow(window, player) {
    const opp = player === AI ? HUMAN : AI;
    const mine = window.filter((v) => v === player).length;
    const free = window.filter((v) => v === EMPTY).length;
    const theirs = window.filter((v) => v === opp).length;
    if (mine === 4) return 100;
    if (mine === 3 && free === 1) return 5;
    if (mine === 2 && free === 2) return 2;
    if (theirs === 3 && free === 1) return -4;
    return 0;
}

export function heuristic(b) {
    // The centre column, because every diagonal and every horizontal through the
    // middle passes it: a disc there belongs to more possible lines than one at
    // the edge, and the search is too shallow to work that out for itself.
    let score = 0;
    for (let r = 0; r < ROWS; r++) if (b[idx(r, 3)] === AI) score += 3;
    for (const line of LINES) score += scoreWindow(line.map((i) => b[i]), AI);
    return score;
}

export function minimax(b, depth, alpha, beta, isMax) {
    // Depth in the score again, so a win sooner beats a win later.
    if (hasWon(b, AI)) return 1000 + depth;
    if (hasWon(b, HUMAN)) return -1000 - depth;
    if (isFull(b) || depth === 0) return heuristic(b);

    const cols = ORDER.filter((c) => dropRow(b, c) !== -1);
    if (!cols.length) return 0;

    let best = isMax ? -Infinity : Infinity;
    let a = alpha;
    let bt = beta;
    for (const c of cols) {
        const r = dropRow(b, c);
        b[idx(r, c)] = isMax ? AI : HUMAN;
        const val = minimax(b, depth - 1, a, bt, !isMax);
        b[idx(r, c)] = EMPTY;
        if (isMax) {
            best = Math.max(best, val);
            a = Math.max(a, best);
        } else {
            best = Math.min(best, val);
            bt = Math.min(bt, best);
        }
        if (a >= bt) break;
    }
    return best;
}

/** The column the AI plays, or -1 when the board is full. */
export function bestCol(board, blunderRate = 0, rand = Math.random) {
    const available = ORDER.filter((c) => dropRow(board, c) !== -1);
    if (!available.length) return -1;
    if (rand() < blunderRate) return available[Math.floor(rand() * available.length)];

    const b = board.slice();
    let best = -Infinity;
    let col = available[0];
    for (const c of available) {
        const r = dropRow(b, c);
        b[idx(r, c)] = AI;
        const val = minimax(b, SEARCH_DEPTH, -Infinity, Infinity, false);
        b[idx(r, c)] = EMPTY;
        if (val > best) { best = val; col = c; }
    }
    return col;
}

/** The board after dropping `player` down `col`, or null when it will not fit. */
export function dropDisc(board, col, player) {
    const r = dropRow(board, col);
    if (r === -1) return null;
    const out = board.slice();
    out[idx(r, col)] = player;
    return out;
}
