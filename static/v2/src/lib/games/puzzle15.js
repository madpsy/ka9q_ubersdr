// The 15-puzzle. A port of the widget's `p15`.
//
// One rule matters and it is not obvious: half of all arrangements of fifteen
// tiles cannot be solved at all, however long you slide them. Shuffling by
// permutation and hoping is how a puzzle game ends up unwinnable for a player who
// has no way of telling — so the shuffle checks parity and draws again.

export const SIZE = 4;
export const TOTAL = SIZE * SIZE;
export const BLANK = 0;

/** Solved is 1..15 then the blank. */
export const solvedTiles = () => Array.from({ length: TOTAL }, (_, i) => (i + 1) % TOTAL);

export const isSolved = (tiles) => tiles.every((v, i) => v === (i + 1) % TOTAL);

/**
 * Parity: an arrangement is solvable when the inversion count and the blank's
 * row agree.
 *
 * On an even-width board — which this is — the rule needs both halves: count the
 * pairs that are out of order, then flip the expected parity depending on which
 * row from the bottom the blank sits in. On an odd width it is just the
 * inversions, which is why the general form is here rather than the shortcut.
 */
export function isSolvable(tiles) {
    let inversions = 0;
    for (let i = 0; i < TOTAL - 1; i++) {
        for (let j = i + 1; j < TOTAL; j++) {
            if (tiles[i] && tiles[j] && tiles[i] > tiles[j]) inversions++;
        }
    }
    const blankRow = Math.floor(tiles.indexOf(BLANK) / SIZE);
    const fromBottom = SIZE - blankRow;
    if (SIZE % 2 === 1) return inversions % 2 === 0;
    return fromBottom % 2 === 0 ? inversions % 2 === 1 : inversions % 2 === 0;
}

/**
 * A shuffled, solvable, unsolved arrangement.
 *
 * Redrawn until both hold. A Fisher–Yates shuffle lands on an unsolvable board
 * half the time and on the solved one about once in twenty trillion, and neither
 * is a puzzle: the first cannot be finished and the second is already finished.
 */
export function shuffle(rand = Math.random) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const tiles = Array.from({ length: TOTAL }, (_, i) => i);
        for (let i = TOTAL - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
        }
        if (isSolvable(tiles) && !isSolved(tiles)) return tiles;
    }
    // A `rand` that never varies would loop for ever otherwise. One known-good
    // arrangement is a better answer than a hang.
    const tiles = solvedTiles();
    [tiles[TOTAL - 2], tiles[TOTAL - 3]] = [tiles[TOTAL - 3], tiles[TOTAL - 2]];
    return tiles;
}

/** Orthogonally adjacent to the blank — diagonals are not moves. */
export function canMove(tiles, i) {
    const blank = tiles.indexOf(BLANK);
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const br = Math.floor(blank / SIZE);
    const bc = blank % SIZE;
    return (Math.abs(r - br) === 1 && c === bc) || (Math.abs(c - bc) === 1 && r === br);
}

/** The board after sliding tile `i`, or the same board when it cannot move. */
export function slide(tiles, i) {
    if (!canMove(tiles, i)) return tiles;
    const out = tiles.slice();
    const blank = tiles.indexOf(BLANK);
    [out[i], out[blank]] = [out[blank], out[i]];
    return out;
}
