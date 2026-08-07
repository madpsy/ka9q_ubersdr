// The two guessing games: which country a callsign is from, and where a country
// is on the map. Ported from the widget's `callsignQuiz` and `countriesGame`.
//
// What they share is the shape of a round — pick something, offer five answers
// one of which is right, keep a streak — and the awkward parts are the same in
// both: not asking the same thing twice in a row, and not letting the right
// answer be guessable from the shape of the options.

// Callsigns the quiz has seen, across sessions. The pool is accumulated rather
// than read live because spots expire: a listener on a quiet band would otherwise
// watch the game run out of questions.
export const SEEN_KEY = 'ubersdr.v2.games.callsigns';
export const SEEN_MAX = 2000;
export const MIN_CALLSIGNS = 10;

// How many recent questions to keep off the list. Enough that a session does not
// feel repetitive, small enough that a modest pool still has something to offer.
export const RECENT_MAX = 30;
export const OPTIONS = 5;

export function shuffled(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * The answers to offer: the right one and four wrong, in a random order.
 *
 * Shuffled *after* the correct one is added, obviously — but the reason it is a
 * function rather than three lines inline is the filter: a distractor equal to
 * the answer makes a question with two right answers, and on a list where the
 * same country appears under two spellings that happens more often than it
 * sounds.
 */
export function buildOptions(correct, pool, rand = Math.random) {
    const others = shuffled(pool.filter((c) => c && c !== correct), rand).slice(0, OPTIONS - 1);
    return shuffled([correct, ...others], rand);
}

/**
 * Which callsign to ask about next.
 *
 * Recently asked ones are held back until the pool runs dry, and callsigns a
 * previous lookup could not place are pushed to the back rather than dropped —
 * they may be a country the receiver has since learned about, and with a small
 * pool they are all there is.
 */
export function orderCandidates(seen, recent, misses, rand = Math.random) {
    const held = new Set(recent);
    let pool = [...seen].filter((cs) => !held.has(cs));
    if (!pool.length) pool = [...seen];
    const live = pool.filter((cs) => !misses.has(cs));
    const dead = pool.filter((cs) => misses.has(cs));
    return [...shuffled(live, rand), ...shuffled(dead, rand)];
}

/** Add to the pool, oldest dropped first once it is full. */
export function addSeen(seen, callsigns) {
    const out = new Set(seen);
    for (const cs of callsigns) if (cs) out.add(cs);
    while (out.size > SEEN_MAX) out.delete(out.values().next().value);
    return out;
}

export function loadSeen() {
    try {
        const a = JSON.parse(localStorage.getItem(SEEN_KEY));
        return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    } catch (e) {
        return new Set();
    }
}

export function saveSeen(seen) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch (e) { /* private mode */ }
}

// US callsigns carry their region in the digit, which is worth saying when the
// answer is revealed — "United States" alone is the least interesting correct
// answer in the game.
const US_DISTRICT = {
    0: 'Central US', 1: 'New England', 2: 'NY/NJ', 3: 'Mid-Atlantic', 4: 'Southeast',
    5: 'South-Central', 6: 'California', 7: 'Pacific Northwest', 8: 'Great Lakes',
    9: 'Upper Midwest',
};

export function usRegion(callsign) {
    const m = /[A-Z]+(\d)/.exec(String(callsign || '').toUpperCase());
    return m ? (US_DISTRICT[m[1]] || '') : '';
}

/** The line under a correct answer: where in the country, and which CQ zone. */
export function ctyDetail(cty, callsign) {
    if (!cty) return { where: '', zone: '' };
    const us = cty.code === 'US' || cty.country === 'United States';
    return {
        where: (us && usRegion(callsign)) || cty.continent || '',
        zone: cty.cq_zone ? `CQ zone ${cty.cq_zone}` : '',
    };
}

// ── The map ─────────────────────────────────────────────────────────────────

/** A country worth asking about, avoiding the recently asked. */
export function pickCountry(list, recent, rand = Math.random) {
    const held = new Set(recent);
    let pool = list.filter((c) => !held.has(c.country));
    if (!pool.length) pool = list;
    return pool[Math.floor(rand() * pool.length)];
}
