// Which marker kinds the on-screen prev/next controls step between.
//
// Small, but it decides what the prev/next buttons can reach — including whether
// there are any, since deselecting everything is how stepping is turned off and
// the Multipad's barrel edges take themselves off the drum when it is. So the
// interesting cases are at the empty end: an empty selection has to survive a
// reload, and has to stay distinguishable from a browser that has never been
// told and from a selection this build cannot read.
//
// One selection serves two controls — the Markers panel's step buttons and the
// Multipad's barrel edges — and both draw a picker for it, so the other thing
// worth pinning is the notification: without it the pad and the panel would sit
// side by side showing different chips lit.

const assert = require('assert');
const {
    DEFAULT_NAV_TYPES, NAV_LABELS, onNavTypes, saveNavTypes, savedNavTypes,
} = require('./.build/markernavsettings.cjs');
const { NAV_TYPES } = require('./.build/markernav.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const KEY = 'ubersdr.v2.markernav';
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

t('every kind the finder knows about has a label', () => {
    // A type added to markerNav.js without a label here would be steppable but
    // unlistable, so the picker would silently not offer it.
    assert.deepStrictEqual(Object.keys(NAV_LABELS).sort(), [...NAV_TYPES].sort());
    for (const [type, label] of Object.entries(NAV_LABELS)) {
        assert.ok(label && typeof label === 'string', type);
    }
});

t('nothing saved means every kind', () => {
    install();
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('a saved selection comes back', () => {
    install({ [KEY]: JSON.stringify(['dx', 'cw']) });
    assert.deepStrictEqual(savedNavTypes(), ['dx', 'cw']);
});

t('a type this build no longer has is dropped, not carried', () => {
    install({ [KEY]: JSON.stringify(['dx', 'sstv-spots', 'cw']) });
    assert.deepStrictEqual(savedNavTypes(), ['dx', 'cw']);
});

t('a selection this build cannot read falls back to everything', () => {
    // It was a real choice made against a vocabulary that has since changed.
    // Reading it as "off" would take kinds nobody switched off and turn them into
    // controls that have disappeared.
    install({ [KEY]: JSON.stringify(['gone', 'also-gone']) });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('nothing selected survives a reload, and is not read as never told', () => {
    // The whole point of allowing it: an operator who turned stepping off does
    // not want it back tomorrow. Only a missing key means "every kind".
    install({ [KEY]: JSON.stringify([]) });
    assert.deepStrictEqual(savedNavTypes(), []);
    install();
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('a corrupt setting reads as the default rather than throwing', () => {
    install({ [KEY]: 'not json' });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
    install({ [KEY]: '{"dx":true}' });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('turning the last kind off is stored, and announced', () => {
    const s = install({ [KEY]: JSON.stringify(['dx']) });
    const seen = [];
    const off = onNavTypes((list) => seen.push(list));
    saveNavTypes([]);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), []);
    // The pad's barrel edges unmount on this, so it has to reach them.
    assert.deepStrictEqual(seen, [[]]);
    off();
});

t('a request made only of kinds that do not exist is refused', () => {
    // Not the same as an empty one: nobody asked for "off" here, and storing it
    // as such would turn a caller's typo into a setting.
    const s = install({ [KEY]: JSON.stringify(['dx']) });
    saveNavTypes(['nonsense']);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx'], 'the old selection should stand');
    saveNavTypes('dx');
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx'], 'not an array at all');
});

t('a save keeps only the kinds that exist', () => {
    const s = install();
    saveNavTypes(['dx', 'nope', 'bookmark-local']);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx', 'bookmark-local']);
});

t('the two controls read one selection, whichever of them wrote it', () => {
    // Shared on purpose: stepping between markers is one act, and the pad
    // disagreeing with the panel above it would be a bug — see the module.
    const s = install();
    saveNavTypes(['cw']);
    assert.deepStrictEqual(savedNavTypes(), ['cw']);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['cw'], 'one key, not one each');
});

t('a change reaches everybody watching, with the cleaned list', () => {
    // Both pickers are on screen at once often enough — the pad floats over the
    // dock on a touchscreen desktop — so this is what keeps them agreeing.
    install();
    const seen = [];
    const off = onNavTypes((list) => seen.push(list));
    saveNavTypes(['dx', 'nope']);
    assert.deepStrictEqual(seen, [['dx']]);
    // One array for every listener, so a memo keyed on it does not re-run per
    // subscriber.
    const both = [];
    const off2 = onNavTypes((list) => both.push(list));
    saveNavTypes(['cw']);
    assert.strictEqual(both[both.length - 1], seen[seen.length - 1]);
    off();
    off2();
    saveNavTypes(['voice']);
    assert.deepStrictEqual(seen[seen.length - 1], ['cw'], 'nothing after unsubscribing');
});

t('a refused change is not announced either', () => {
    // A picker that redrew from a selection it was not given would light no chips
    // at all until something else changed it.
    install({ [KEY]: JSON.stringify(['dx']) });
    const seen = [];
    const off = onNavTypes((list) => seen.push(list));
    saveNavTypes(['nonsense']);
    saveNavTypes(null);
    assert.deepStrictEqual(seen, []);
    off();
});

t('one listener throwing does not cost the others the change', () => {
    install();
    const seen = [];
    const off1 = onNavTypes(() => { throw new Error('a panel mid-unmount'); });
    const off2 = onNavTypes((list) => seen.push(list));
    assert.doesNotThrow(() => saveNavTypes(['cw']));
    assert.deepStrictEqual(seen, [['cw']]);
    off1();
    off2();
});

t('a storage that refuses the write still moves the setting for this session', () => {
    // Private mode: it cannot be persisted, but the pickers must still follow —
    // a press that visibly does nothing reads as a broken control.
    const s = install();
    s.refuse = true;
    const seen = [];
    const off = onNavTypes((list) => seen.push(list));
    assert.doesNotThrow(() => saveNavTypes(['dx']));
    assert.deepStrictEqual(seen, [['dx']]);
    off();
});

console.log(`\n${pass} ok`);
