// Mastermind: four pegs, six colours, eight guesses. Ported from the widget's
// `mastermind`.
//
// The whole game is one function — scoring a guess — and it is the one place a
// Mastermind implementation is usually wrong. A colour that appears twice in the
// guess and once in the code must count once, and a peg already counted as an
// exact match must not be counted again as a misplaced one. Do it naively and the
// feedback is subtly generous, which makes the game unsolvable by reasoning
// rather than obviously broken.

export const SLOTS = 4;
export const COLORS = 6;
export const MAX_ROWS = 8;

/** Duplicates allowed, as in the classic game — it is what makes it hard. */
export function makeSecret(rand = Math.random) {
    return Array.from({ length: SLOTS }, () => Math.floor(rand() * COLORS));
}

/**
 * `{ black, white }` — right colour in the right place, and right colour in the
 * wrong place.
 *
 * Two passes, and the second only over what the first did not use: every exact
 * match is taken out of both the code and the guess before the leftovers are
 * compared, so no peg is ever counted twice.
 */
export function scoreGuess(guess, secret) {
    let black = 0;
    const codeLeft = new Array(COLORS).fill(0);
    const guessLeft = new Array(COLORS).fill(0);
    for (let i = 0; i < SLOTS; i++) {
        if (guess[i] === secret[i]) black++;
        else {
            codeLeft[secret[i]]++;
            guessLeft[guess[i]]++;
        }
    }
    let white = 0;
    for (let c = 0; c < COLORS; c++) white += Math.min(codeLeft[c], guessLeft[c]);
    return { black, white };
}

export const isCracked = (result) => result.black === SLOTS;
