// Noughts and crosses, and an opponent that adapts.
//
// A port of widgets/games.widget.html's `ttt`. The interesting part, and the
// reason it is worth having as a module of its own, is that a perfect minimax
// player is a terrible game: three-by-three is solved, so an optimal opponent
// never loses and the human never wins. So the AI plays optimally except for a
// blunder rate, and that rate moves with the score — the widget's own idea, kept
// exactly.

export const HUMAN = 'X';
export const AI = 'O';
export const EMPTY = '';

export const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
];

export const emptyBoard = () => Array(9).fill(EMPTY);

/** 'X', 'O', 'draw', or null while there are still moves. */
export function winner(b) {
    for (const [a, c, d] of LINES) {
        if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    }
    return b.includes(EMPTY) ? null : 'draw';
}

/** The three squares that won it, for highlighting. */
export function winLine(b) {
    for (const line of LINES) {
        if (b[line[0]] && b[line[0]] === b[line[1]] && b[line[0]] === b[line[2]]) return line;
    }
    return null;
}

// Depth in the score so a win now beats a win in three moves, and a loss in
// three beats a loss now — which is what makes a losing AI still play for time
// rather than giving up immediately.
export function minimax(b, isMax, depth = 0) {
    const w = winner(b);
    if (w === AI) return 10 - depth;
    if (w === HUMAN) return depth - 10;
    if (w === 'draw') return 0;

    let best = isMax ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
        if (b[i] !== EMPTY) continue;
        b[i] = isMax ? AI : HUMAN;
        const val = minimax(b, !isMax, depth + 1);
        b[i] = EMPTY;
        best = isMax ? Math.max(best, val) : Math.min(best, val);
    }
    return best;
}

export const emptySquares = (b) => b.reduce((out, v, i) => (v === EMPTY ? [...out, i] : out), []);

/**
 * Where the AI plays. `rand` is injected so a test can decide whether this move
 * is the blunder or the perfect one.
 *
 * -1 when the board is full.
 */
export function bestMove(board, blunderRate = 0, rand = Math.random) {
    const empty = emptySquares(board);
    if (!empty.length) return -1;
    if (rand() < blunderRate) return empty[Math.floor(rand() * empty.length)];

    const b = board.slice();
    let best = -Infinity;
    let move = empty[0];
    for (const i of empty) {
        b[i] = AI;
        const val = minimax(b, false, 0);
        b[i] = EMPTY;
        if (val > best) { best = val; move = i; }
    }
    return move;
}

// How wrong the AI is allowed to be, and how fast that moves.
//
// The asymmetry is deliberate and is the widget's: losing makes the AI easier by
// more than winning makes it harder (0.12 against 0.08), so somebody on a losing
// run is helped back faster than a winning one is punished. The clamp keeps it
// short of both "never misses" and "plays at random".
export const BLUNDER_START = 0.5;
export const BLUNDER_MIN = 0.15;
export const BLUNDER_MAX = 0.85;
const EASIER = 0.12;
const HARDER = 0.08;

/** `playerWon` true, false, or null for a draw, which changes nothing. */
export function adaptBlunder(rate, playerWon) {
    if (playerWon === null || playerWon === undefined) return rate;
    return Math.min(BLUNDER_MAX, Math.max(BLUNDER_MIN, playerWon ? rate - HARDER : rate + EASIER));
}
