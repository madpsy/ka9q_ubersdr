// Which marker kinds the Markers panel steps between.
//
// Small, but it decides what the prev/next buttons can reach — and an empty
// selection would leave them permanently dead with nothing on screen to
// explain why.

const assert = require('assert');
const {
    DEFAULT_NAV_TYPES, NAV_LABELS, saveNavTypes, savedNavTypes,
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

t('a selection that survives nothing falls back to everything', () => {
    // Otherwise prev/next would be dead with nothing on screen to say why.
    install({ [KEY]: JSON.stringify(['gone', 'also-gone']) });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
    install({ [KEY]: JSON.stringify([]) });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('a corrupt setting reads as the default rather than throwing', () => {
    install({ [KEY]: 'not json' });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
    install({ [KEY]: '{"dx":true}' });
    assert.deepStrictEqual(savedNavTypes(), DEFAULT_NAV_TYPES);
});

t('an empty selection is refused rather than stored', () => {
    const s = install({ [KEY]: JSON.stringify(['dx']) });
    saveNavTypes([]);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx'], 'the old selection should stand');
    saveNavTypes(['nonsense']);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx']);
});

t('a save keeps only the kinds that exist', () => {
    const s = install();
    saveNavTypes(['dx', 'nope', 'bookmark-local']);
    assert.deepStrictEqual(JSON.parse(s.getItem(KEY)), ['dx', 'bookmark-local']);
});

t('a storage that refuses the write does not take the panel down', () => {
    const s = install();
    s.refuse = true;
    assert.doesNotThrow(() => saveNavTypes(['dx']));
});

console.log(`\n${pass} ok`);
