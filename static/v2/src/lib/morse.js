// Morse: the code, and the timing that makes it readable.
//
// Shared, not the trainer's. It began in lib/games/ because the Morse trainer was
// the only thing that needed it, and moved out the moment a second caller appeared —
// the callsign announcer, which sends a call sign the same way the trainer sends a
// character, off the same table and the same clock. There is nothing game-shaped in
// here, and two copies of a Morse table is exactly the kind of thing that ends with
// one of them being wrong.
//
// Two things here have to be exactly right, because a trainer that teaches the
// wrong thing is worse than no trainer:
//
//   The table. The 26 letters are the ITU set; the digits and punctuation are
//   ITU-R M.1677-1. Nothing here is "as I remember it" — and the tests do more
//   than repeat the table back, since a test written from the same slip as the
//   code agrees with it. They check the properties a transcription error breaks:
//   every code unique, letters one to four elements, digits exactly five, the
//   two commonest English letters the two shortest codes, and SOS spelling out.
//
//   The timing. Morse speed is defined by the word PARIS, which is exactly 50
//   units including the space after it — so at 20 words per minute a unit is
//   1200/20 = 60 ms, and that is the whole of it. A dit is one unit, a dah is
//   three, the gap inside a character is one, between characters three, between
//   words seven. Get any of them wrong and the rhythm is wrong, which for someone
//   learning by sound is the only thing that matters.

// ── The code ────────────────────────────────────────────────────────────────

// Keys quoted throughout, punctuation and letters alike: a bare `N:` in a data
// table is indistinguishable from a use of some other module's exported N, which
// test/unresolved.js quite reasonably objects to.
export const LETTERS = {
    'A': '.-',
    'B': '-...',
    'C': '-.-.',
    'D': '-..',
    'E': '.',
    'F': '..-.',
    'G': '--.',
    'H': '....',
    'I': '..',
    'J': '.---',
    'K': '-.-',
    'L': '.-..',
    'M': '--',
    'N': '-.',
    'O': '---',
    'P': '.--.',
    'Q': '--.-',
    'R': '.-.',
    'S': '...',
    'T': '-',
    'U': '..-',
    'V': '...-',
    'W': '.--',
    'X': '-..-',
    'Y': '-.--',
    'Z': '--..',
};

// Every digit is five elements, counting up in dahs from the left: 1 is one dit
// then four dahs, 5 is all dits, 0 is all dahs. That regularity is itself a check
// — a mistyped digit almost always breaks it.
export const DIGITS = {
    '0': '-----',
    '1': '.----',
    '2': '..---',
    '3': '...--',
    '4': '....-',
    '5': '.....',
    '6': '-....',
    '7': '--...',
    '8': '---..',
    '9': '----.',
};

// The punctuation an operator actually sends. Deliberately not the whole of
// M.1677-1: the trainer is for on-air characters, and a game that asks you to
// recognise the dollar sign is a game about a table rather than about listening.
export const PUNCTUATION = {
    '.': '.-.-.-',
    ',': '--..--',
    '?': '..--..',
    '/': '-..-.',
    '=': '-...-',        // BT — the break between parts of a message
    '+': '.-.-.',        // AR — end of transmission
    '-': '-....-',
    ':': '---...',
    "'": '.----.',
    '"': '.-..-.',
    '(': '-.--.',
    ')': '-.--.-',
    '@': '.--.-.',
};

export const MORSE = { ...LETTERS, ...DIGITS, ...PUNCTUATION };

// The other way round, built rather than written out — two hand-maintained tables
// are two chances to disagree.
export const FROM_CODE = Object.fromEntries(
    Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

export const codeFor = (ch) => MORSE[String(ch || '').toUpperCase()] || '';
export const charFor = (code) => FROM_CODE[code] || '';

/** Text to code: characters separated by a space, words by a slash. */
export function toMorse(text) {
    return String(text || '')
        .toUpperCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => [...word].map(codeFor).filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' / ');
}

export function fromMorse(code) {
    return String(code || '')
        .trim()
        .split(/\s*\/\s*/)
        .map((word) => word.split(/\s+/).map(charFor).join(''))
        .join(' ');
}

// ── The timing ──────────────────────────────────────────────────────────────

// In units. The whole of Morse timing, and the reason it is written out rather
// than inlined: every one of these is a number somebody eventually gets wrong.
export const DIT = 1;
export const DAH = 3;
export const GAP = 1;            // between elements of one character
export const CHAR_GAP = 3;       // between characters
export const WORD_GAP = 7;       // between words

// "PARIS" plus the space after it is 50 units. That is the definition of a word
// per minute, so a unit is 1200 ms / wpm and nothing else needs a constant.
export const PARIS_UNITS = 50;
export const unitMs = (wpm) => 1200 / (wpm > 0 ? wpm : 20);

/** How many units a string takes to send, spacing included, PARIS-style. */
export function unitsFor(text) {
    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    let units = 0;
    words.forEach((word, w) => {
        if (w) units += WORD_GAP;
        [...word].forEach((ch, i) => {
            const code = codeFor(ch);
            if (!code) return;
            if (i) units += CHAR_GAP;
            [...code].forEach((el, k) => {
                if (k) units += GAP;
                units += el === '-' ? DAH : DIT;
            });
        });
    });
    return units;
}

/**
 * A character as a list of `{ on, ms }` slices, ready to play or to draw.
 *
 * Farnsworth: `charWpm` is how fast the character itself is sent and `wpm` how
 * fast the whole transmission goes, the difference being padded into the gaps.
 * It is how Morse is taught — learning at 5 wpm builds a habit of counting dits
 * that has to be unlearned later, so characters are sent at speed from the start
 * and the space between them is stretched instead.
 *
 * Only the gaps *between* characters stretch. The gaps inside one are part of its
 * rhythm and are always at the character speed, which is the point of the method.
 */
export function toneSlices(text, wpm = 20, charWpm = wpm) {
    const fast = unitMs(Math.max(charWpm, wpm));
    const slow = unitMs(wpm);
    const out = [];
    const push = (on, ms) => {
        if (ms > 0) out.push({ on, ms });
    };

    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    words.forEach((word, w) => {
        if (w) push(false, WORD_GAP * slow);
        [...word].forEach((ch, i) => {
            const code = codeFor(ch);
            if (!code) return;
            if (i) push(false, CHAR_GAP * slow);
            [...code].forEach((el, k) => {
                if (k) push(false, GAP * fast);
                push(true, (el === '-' ? DAH : DIT) * fast);
            });
        });
    });
    return out;
}

// ── Learning order ──────────────────────────────────────────────────────────

// Koch's order, which is the one every trainer uses. It is not alphabetical and
// it is not easiest-first: it starts with two characters that sound nothing alike
// (K and M) and adds each new one where it will be confused with something
// already known, because telling apart is the skill being learned.
export const KOCH = [
    'K', 'M', 'R', 'S', 'U', 'A', 'P', 'T', 'L', 'O', 'W', 'I', '.', 'N', 'J',
    'E', 'F', '0', 'Y', ',', 'V', 'G', '5', '/', 'Q', '9', 'Z', 'H', '3', '8',
    'B', '?', '4', '2', '7', 'C', '1', 'D', '6', 'X',
];

// Two to start with: one character is not a choice, and the whole method is
// distinguishing one from another.
export const KOCH_MIN = 2;

// Correct answers in a row before the next character joins in. Five is the usual
// figure and it is about right for a game — often enough to feel like progress,
// long enough that it is not luck.
export const UNLOCK_RUN = 5;

/** The characters in play at a given level. */
export function kochSet(level) {
    const n = Math.min(Math.max(level, KOCH_MIN), KOCH.length);
    return KOCH.slice(0, n);
}

/**
 * What to ask next: a character from the set, avoiding the last few asked.
 *
 * Weighted towards the newest characters, because that is the one being learned
 * — an even draw over forty characters would show the new one twice a minute.
 */
export function pickChar(level, recent = [], rand = Math.random) {
    const set = kochSet(level);
    const held = new Set(recent.slice(-Math.min(3, set.length - 1)));
    let pool = set.filter((c) => !held.has(c));
    if (!pool.length) pool = set;
    // The two most recently unlocked get a second entry in the hat.
    const newest = set.slice(-2).filter((c) => pool.includes(c));
    const hat = [...pool, ...newest];
    return hat[Math.floor(rand() * hat.length)];
}
