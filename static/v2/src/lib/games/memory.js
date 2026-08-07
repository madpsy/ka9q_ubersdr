// Pairs, with the receiver's own emoji. A port of the widget's `mem`.
//
// Barely any logic, and the little there is has a trap in it: the third click.
// Two cards are turned, they do not match, and they have to stay visible long
// enough to be read — during which a click on a third card must do nothing, or a
// fast player ends up with three cards face up and a state nobody can unpick.
// That is what `locked` is, and it is the whole reason this is not inline.

export const FACES = ['📻', '🛰️', '📡', '🔭', '⚡', '🌊', '🎯', '🔬'];
export const PAIRS = FACES.length;
export const CARDS = PAIRS * 2;

// How long a non-matching pair stays up. The widget's 800 ms: long enough to
// read two symbols, short enough not to feel like a penalty.
export const FLIP_BACK_MS = 800;

export function deal(rand = Math.random) {
    const cards = [...FACES, ...FACES];
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

export const isMatched = (matched, i) => matched.some((pair) => pair.includes(i));

/** Can this card be turned over at all, in this state? */
export function canFlip(state, i) {
    if (state.locked) return false;
    if (state.flipped.includes(i)) return false;
    return !isMatched(state.matched, i);
}

export const isWon = (matched) => matched.length === PAIRS;
