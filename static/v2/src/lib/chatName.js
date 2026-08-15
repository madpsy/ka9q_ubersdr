// A name to join chat with, when nobody has chosen one.
//
// An empty box asking for a name is a decision in the way of the thing you came
// for, and on a phone it is a decision plus a keyboard. The chat is a room on
// somebody's receiver rather than an account, so a name only has to be
// *distinct* — "user417" is a perfectly good answer to a question most people
// did not want to be asked.
//
// A saved name always wins: this is only ever consulted when there is nothing
// stored, and one keystroke replaces it (see ChatPanel, where typing clears the
// suggestion rather than appending to it).

// Three digits, so the name is short enough to read in a crowded log and to
// type after an @. A hundred through nine hundred and ninety-nine: no leading
// zeros, and nothing that reads as "user 7" and sorts as "user 07".
const LOW = 100;
const HIGH = 999;

// How hard to try before giving up on avoiding a clash. With nine hundred names
// and a handful of listeners the first pick is almost always free, and the
// point of the cap is that a *full* room cannot hang the interface — see below
// for what happens then.
const TRIES = 40;

/**
 * `userNNN`, avoiding the names already in the room.
 *
 * `taken` is anything iterable of names — the chat user list, as it stands.
 * Compared case-insensitively, because two names differing only in case are the
 * same name to everyone reading the log, whatever the server thinks.
 *
 * `rand` is injectable so this can be tested; it should behave like
 * Math.random.
 *
 * Never returns nothing. If every name it tries is taken it falls back to one
 * with more digits rather than an empty box or a throw: a suggestion that
 * collides is refused by the server with a message the operator can act on,
 * where no suggestion at all is the problem this exists to solve.
 */
export function suggestUsername(taken = [], rand = Math.random) {
    const used = new Set();
    for (const name of taken) {
        if (typeof name === 'string' && name) used.add(name.toLowerCase());
    }

    for (let i = 0; i < TRIES; i++) {
        const n = LOW + Math.floor(rand() * (HIGH - LOW + 1));
        const name = `user${n}`;
        if (!used.has(name.toLowerCase())) return name;
    }
    return `user${Date.now() % 100000}`;
}
