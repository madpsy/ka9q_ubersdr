// Which bookmark groups are in play.
//
// A hidden group is still a bookmark — it stays in the panel that lists it, and
// stays searchable there — but it stops propagating: no pill on the marker bar,
// nothing for ⏮/⏭ to skip to, nothing named on the lock screen, nothing under
// the dial in the Markers panel. The use case is a group of a few hundred
// entries that is useful to keep and useless to see.
//
// Kept by name and shared between the receiver's bookmarks and this browser's:
// if both have a "Nets", hiding it hides both. Somebody hiding a group is
// thinking about the group, not about which store it came from.

const KEY = 'ubersdr.v2.bookmarkGroups';

// A bookmark with no group. '' cannot collide with a real group name — every
// list of groups in this interface is built with `.filter(Boolean)` — and it
// keeps the ungrouped ones addressable, which matters most on the receiver
// where they are the leftovers nobody has sorted.
export const UNGROUPED = '';
export const UNGROUPED_LABEL = 'No group';

const listeners = new Set();

function read() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(raw) ? raw.filter((g) => typeof g === 'string') : [];
    } catch (e) {
        return [];
    }
}

/** The hidden group names, as a Set. */
export function hiddenGroups() {
    return new Set(read());
}

export function isGroupHidden(name) {
    return read().includes(name || UNGROUPED);
}

export function setGroupHidden(name, hidden) {
    const key = name || UNGROUPED;
    const next = read().filter((g) => g !== key);
    if (hidden) next.push(key);
    write(next);
}

export function showAllGroups() {
    write([]);
}

function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(new Set(list));
}

export function onGroupsChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * The groups in a list, with how many are in each.
 *
 * Ungrouped bookmarks come last and only when there are any — on a receiver
 * whose bookmarks are all filed, an empty "No group" entry is one more thing to
 * scroll past in a dropdown that may already hold hundreds.
 */
export function groupsOf(list) {
    const counts = new Map();
    let ungrouped = 0;
    for (const b of list || []) {
        if (b && b.group) counts.set(b.group, (counts.get(b.group) || 0) + 1);
        else if (b) ungrouped++;
    }
    const out = [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (ungrouped) out.push({ name: UNGROUPED, count: ungrouped });
    return out;
}

/** The bookmarks that still propagate — everything not in a hidden group. */
export function visibleBookmarks(list, hidden) {
    if (!Array.isArray(list)) return list;
    const set = hidden instanceof Set ? hidden : new Set(hidden || []);
    if (!set.size) return list;
    return list.filter((b) => !set.has((b && b.group) || UNGROUPED));
}

/**
 * Hidden names that no list actually has.
 *
 * A group renamed on the receiver, or one this browser hid before its
 * bookmarks were reorganised, would otherwise sit in the count for good with
 * nothing on screen to clear it.
 */
export function staleHidden(hidden, ...lists) {
    const known = new Set();
    for (const list of lists) {
        for (const b of list || []) known.add((b && b.group) || UNGROUPED);
    }
    return [...(hidden instanceof Set ? hidden : new Set(hidden || []))].filter((g) => !known.has(g));
}
