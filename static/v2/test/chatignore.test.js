// Who you have decided not to hear from in chat.
//
// v1 has this and v2 did not. What is worth pinning is the part that is not obvious from
// the code: that it writes v1's key in v1's format, so the two interfaces agree about a
// decision that is about a person rather than about a frontend.

const assert = require('assert');

// A localStorage before the module is loaded, because it reads the key on import.
const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const KEY = 'ubersdr_muted_users';
const path = './.build/chatignore.cjs';
const load = () => {
    delete require.cache[require.resolve(path)];
    return require(path);
};

let ci = load();
let pass = 0;
const t = (name, fn) => {
    store.clear();
    ci._resetChatIgnore();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('nobody is ignored to begin with', () => {
    assert.deepStrictEqual(ci.ignoredUsers(), []);
    assert.strictEqual(ci.isIgnored('G0RQL'), false);
});

t('ignoring somebody sticks, and stopping unsticks it', () => {
    ci.setIgnored('G0RQL', true);
    assert.strictEqual(ci.isIgnored('G0RQL'), true);
    ci.setIgnored('G0RQL', false);
    assert.strictEqual(ci.isIgnored('G0RQL'), false);
    assert.deepStrictEqual(ci.ignoredUsers(), []);
});

t('the toggle reports what it did', () => {
    assert.strictEqual(ci.toggleIgnored('G0RQL'), true);
    assert.strictEqual(ci.toggleIgnored('G0RQL'), false);
});

t('twice is once', () => {
    ci.setIgnored('G0RQL', true);
    ci.setIgnored('G0RQL', true);
    assert.deepStrictEqual(ci.ignoredUsers(), ['G0RQL']);
});

t('a name is a person, whatever case they type it in', () => {
    // v1 compares exactly, which an ignored user walks back through by rejoining as
    // `Bob` instead of `bob`. Being stricter costs v1 nothing — what is written is
    // still the plain list of names it reads.
    ci.setIgnored('G0RQL', true);
    assert.strictEqual(ci.isIgnored('g0rql'), true);
    assert.strictEqual(ci.isIgnored('  G0rql '), true);
    ci.setIgnored('g0rql', false);
    assert.deepStrictEqual(ci.ignoredUsers(), []);
});

t('an empty name is not a person', () => {
    ci.setIgnored('', true);
    ci.setIgnored('   ', true);
    ci.setIgnored(null, true);
    assert.deepStrictEqual(ci.ignoredUsers(), []);
    assert.strictEqual(ci.isIgnored(''), false);
});

// --- v1's key, v1's format -----------------------------------------------------

t('it writes the key the old interface reads, as a plain list of names', () => {
    ci.setIgnored('G0RQL', true);
    ci.setIgnored('MM3NDH', true);
    assert.deepStrictEqual(JSON.parse(store.get(KEY)), ['G0RQL', 'MM3NDH']);
});

t('and reads one the old interface wrote', () => {
    store.set(KEY, JSON.stringify(['G0RQL', 'MM3NDH']));
    ci = load();
    assert.strictEqual(ci.isIgnored('G0RQL'), true);
    assert.strictEqual(ci.isIgnored('MM3NDH'), true);
});

t('a list that is not one does not take the panel down with it', () => {
    for (const junk of ['{}', 'null', 'not json', '[1,2]']) {
        store.set(KEY, junk);
        ci = load();
        assert.ok(Array.isArray(ci.ignoredUsers()), junk);
    }
    // Numbers survive as names rather than as a crash — they are somebody's username
    // as far as this is concerned.
    store.set(KEY, '["bob","bob","BOB",""]');
    ci = load();
    assert.deepStrictEqual(ci.ignoredUsers(), ['bob'], 'deduplicated on the way in');
});

// --- the way back --------------------------------------------------------------

t('the ones who have left are the ones with no row to press', () => {
    // Everybody present has their own button; without this, ignoring somebody who then
    // leaves is a decision reversible only by editing the browser's storage.
    ci.setIgnored('G0RQL', true);
    ci.setIgnored('MM3NDH', true);
    const here = [{ username: 'g0rql' }, { username: 'F5XYZ' }];
    assert.deepStrictEqual(ci.absentIgnored(ci.ignoredUsers(), here), ['MM3NDH']);
    assert.deepStrictEqual(ci.absentIgnored(ci.ignoredUsers(), []), ['G0RQL', 'MM3NDH']);
    assert.deepStrictEqual(ci.absentIgnored([], here), []);
});

t('clearing brings everybody back', () => {
    ci.setIgnored('G0RQL', true);
    ci.clearIgnored();
    assert.deepStrictEqual(ci.ignoredUsers(), []);
    assert.deepStrictEqual(JSON.parse(store.get(KEY)), []);
});

// --- telling the panel ---------------------------------------------------------

t('a change tells whoever is listening', () => {
    const seen = [];
    const off = ci.onChatIgnore((list) => seen.push([...list]));
    ci.setIgnored('G0RQL', true);
    ci.setIgnored('G0RQL', false);
    off();
    ci.setIgnored('MM3NDH', true);
    assert.deepStrictEqual(seen, [['G0RQL'], []], 'and stops when unsubscribed');
});

t('a change that changes nothing says nothing', () => {
    ci.setIgnored('G0RQL', true);
    let calls = 0;
    const off = ci.onChatIgnore(() => { calls++; });
    ci.setIgnored('G0RQL', true);
    ci.setIgnored('NOBODY', false);
    off();
    assert.strictEqual(calls, 0);
});

if (process.exitCode) console.log('\nchat ignore tests FAILED');
else console.log(`\nall ${pass} chat ignore tests passed`);
