// Which bookmark groups are in play.
//
// A hidden group stops propagating — no marker pill, nothing for the skip
// buttons to reach, nothing named on the lock screen — but it stays in the
// panel that lists it. That asymmetry is the whole feature: filter the panel
// too and there is no way to switch a group back on.

const assert = require('assert');
const {
    UNGROUPED, groupsOf, hiddenGroups, isGroupHidden, onGroupsChanged, setGroupHidden,
    showAllGroups, staleHidden, visibleBookmarks,
} = require('./.build/bookmarkgroups.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const KEY = 'ubersdr.v2.bookmarkGroups';
function install(initial = {}) {
    const map = new Map(Object.entries(initial));
    globalThis.localStorage = {
        refuse: false,
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem(k, v) { if (this.refuse) throw new Error('quota'); map.set(k, String(v)); },
        removeItem: (k) => map.delete(k),
    };
    return globalThis.localStorage;
}

const bm = (name, group) => ({ name, frequency: 7100000, group });
const LIST = [bm('a', 'Nets'), bm('b', 'Nets'), bm('c', 'Beacons'), bm('d')];

// --- counting ----------------------------------------------------------------

t('groups come back named, counted and sorted', () => {
    install();
    assert.deepStrictEqual(groupsOf(LIST), [
        { name: 'Beacons', count: 1 },
        { name: 'Nets', count: 2 },
        { name: UNGROUPED, count: 1 },
    ]);
});

t('ungrouped comes last, and only when there are any', () => {
    // On a receiver whose bookmarks are all filed, an empty "No group" entry is
    // one more thing to scroll past in a dropdown holding hundreds.
    install();
    const filed = groupsOf([bm('a', 'Nets')]);
    assert.deepStrictEqual(filed, [{ name: 'Nets', count: 1 }]);
    assert.deepStrictEqual(groupsOf([]), []);
    assert.deepStrictEqual(groupsOf(null), []);
});

// --- hiding ------------------------------------------------------------------

t('nothing is hidden to begin with', () => {
    install();
    assert.strictEqual(hiddenGroups().size, 0);
    assert.deepStrictEqual(visibleBookmarks(LIST, hiddenGroups()), LIST);
});

t('a hidden group stops propagating', () => {
    install();
    setGroupHidden('Nets', true);
    const shown = visibleBookmarks(LIST, hiddenGroups());
    assert.deepStrictEqual(shown.map((b) => b.name), ['c', 'd']);
    assert.strictEqual(isGroupHidden('Nets'), true);
    assert.strictEqual(isGroupHidden('Beacons'), false);
});

t('the ungrouped ones can be hidden too', () => {
    // On a receiver they are the leftovers nobody has filed, and there can be
    // a lot of them.
    install();
    setGroupHidden(UNGROUPED, true);
    assert.deepStrictEqual(visibleBookmarks(LIST, hiddenGroups()).map((b) => b.name), ['a', 'b', 'c']);
    assert.strictEqual(isGroupHidden(UNGROUPED), true);
    assert.strictEqual(isGroupHidden(undefined), true, 'a bookmark with no group is the same thing');
});

t('hiding is idempotent, and showing again puts it back', () => {
    install();
    setGroupHidden('Nets', true);
    setGroupHidden('Nets', true);
    assert.strictEqual(hiddenGroups().size, 1);
    setGroupHidden('Nets', false);
    assert.strictEqual(hiddenGroups().size, 0);
    assert.deepStrictEqual(visibleBookmarks(LIST, hiddenGroups()), LIST);
});

t('show all clears the lot', () => {
    install();
    setGroupHidden('Nets', true);
    setGroupHidden('Beacons', true);
    assert.strictEqual(hiddenGroups().size, 2);
    showAllGroups();
    assert.strictEqual(hiddenGroups().size, 0);
});

t('hiding every group leaves nothing propagating but everything listed', () => {
    // The panel reads the unfiltered list, which is what makes this recoverable.
    install();
    for (const g of groupsOf(LIST)) setGroupHidden(g.name, true);
    assert.deepStrictEqual(visibleBookmarks(LIST, hiddenGroups()), []);
    assert.strictEqual(groupsOf(LIST).length, 3, 'the panel can still list them');
});

t('a change tells everyone watching', () => {
    install();
    const seen = [];
    const off = onGroupsChanged((set) => seen.push([...set]));
    setGroupHidden('Nets', true);
    off();
    setGroupHidden('Beacons', true);
    assert.deepStrictEqual(seen, [['Nets']], 'kept notifying after unsubscribing');
});

// --- resilience --------------------------------------------------------------

t('a corrupt setting hides nothing rather than throwing', () => {
    install({ [KEY]: 'not json' });
    assert.strictEqual(hiddenGroups().size, 0);
    install({ [KEY]: '{"Nets":true}' });
    assert.strictEqual(hiddenGroups().size, 0);
    install({ [KEY]: '["Nets", 7, null]' });
    assert.deepStrictEqual([...hiddenGroups()], ['Nets'], 'kept the entries that are names');
});

t('a refused write does not take the panel down', () => {
    const s = install();
    s.refuse = true;
    assert.doesNotThrow(() => setGroupHidden('Nets', true));
});

t('a hidden group that no longer exists can be found and cleared', () => {
    // Renamed on the receiver, or hidden before the bookmarks were
    // reorganised — it would otherwise sit in the count for good.
    install();
    setGroupHidden('Gone', true);
    setGroupHidden('Nets', true);
    assert.deepStrictEqual(staleHidden(hiddenGroups(), LIST), ['Gone']);
    assert.deepStrictEqual(staleHidden(hiddenGroups(), LIST, [bm('x', 'Gone')]), []);
});

t('visibleBookmarks leaves a list it was given nothing to do to', () => {
    install();
    const same = visibleBookmarks(LIST, new Set());
    assert.strictEqual(same, LIST, 'copied a list for no reason');
    assert.strictEqual(visibleBookmarks(null, new Set(['Nets'])), null);
});

console.log(`\n${pass} ok`);
