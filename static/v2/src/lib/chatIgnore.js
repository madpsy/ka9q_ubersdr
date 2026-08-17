// Who you have decided not to hear from in chat.
//
// v1 has this and v2 did not, which is the whole reason for the file. There, clicking a
// name in the user list muted them and their messages stopped arriving (static/chat.js,
// `mutedUsers`). It is worth having for the obvious reason: a public receiver's chat is
// open to whoever turns up, and one person can make a channel not worth reading.
//
// ── Client-side, and honest about it ─────────────────────────────────────────
//
// Nothing is sent to the server. Ignoring somebody hides them from *this* browser; it does
// not silence them for anybody else and it is not moderation. v1's is the same, and the
// alternative — asking the server to filter — would be a different feature needing an
// operator, a policy and an appeal.
//
// ── Why it is v1's storage key and not a v2 one ──────────────────────────────
//
// `ubersdr_muted_users`, the key static/chat.js already writes, holding the same JSON array
// of usernames. The two frontends are served from one origin and one localStorage, and a
// person you have decided not to read is not a per-interface preference — being ignored in
// v2 and back in v1 would be a bug rather than a feature. The same reasoning the local
// bookmarks and the radio-control mappings are shared on; see lib/backup.js, where the
// v1-named keys sit beside the v2 ones for exactly this reason.
//
// The format is therefore v1's and stays readable by it: an array of names, written whole.
//
// ── Matching ─────────────────────────────────────────────────────────────────
//
// Compared without case, stored as it was typed. v1 compares exactly, which is a hole an
// ignored user can walk back through by rejoining as `Bob` instead of `bob`; being stricter
// here costs v1 nothing, because what is written is still the plain list of names it reads.

const KEY = 'ubersdr_muted_users';

const norm = (name) => String(name || '').trim().toLowerCase();

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (!Array.isArray(raw)) return [];
        // Deduplicated on the way in: v1 writes a Set and so does this, but a hand-edited
        // or half-written list should not produce a name that takes two presses to clear.
        const seen = new Set();
        return raw.map(String).filter((n) => {
            const k = norm(n);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    } catch (e) {
        return [];
    }
}

let names = load();
const subs = new Set();

function save() {
    try { localStorage.setItem(KEY, JSON.stringify(names)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(subs)) {
        try { fn(names); } catch (err) { console.error('chat ignore subscriber threw', err); }
    }
}

/** The list, newest last, as it was typed. */
export const ignoredUsers = () => names;

/** Whether this name is one of them. */
export const isIgnored = (username) => {
    const k = norm(username);
    return !!k && names.some((n) => norm(n) === k);
};

/** Ignore somebody, or stop. Returns the list. */
export function setIgnored(username, on) {
    const k = norm(username);
    if (!k) return names;
    const already = isIgnored(username);
    if (already === !!on) return names;
    names = on
        ? names.concat(String(username).trim())
        : names.filter((n) => norm(n) !== k);
    save();
    return names;
}

/** Ignore if not, stop if so. Returns whether they are now ignored. */
export function toggleIgnored(username) {
    const next = !isIgnored(username);
    setIgnored(username, next);
    return next;
}

/**
 * The ignored names with nobody in the room to match them.
 *
 * What the panel needs to offer a way back: everybody present has their own button on
 * their own row, and these are the ones who have since left — whose decision would
 * otherwise be irreversible short of editing the browser's storage.
 */
export function absentIgnored(list, users) {
    const here = new Set((users || []).map((u) => norm(u && u.username)));
    return (list || names).filter((n) => !here.has(norm(n)));
}

/** Hear from everybody again. */
export function clearIgnored() {
    if (!names.length) return;
    names = [];
    save();
}

/**
 * Subscribe to changes. The list is a setting rather than a feed — it changes when
 * somebody presses something — but the panel and the message filter both read it, and
 * neither is a good owner.
 */
export function onChatIgnore(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

/** Test seam. */
export function _resetChatIgnore() {
    names = [];
    subs.clear();
    try { localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
}
