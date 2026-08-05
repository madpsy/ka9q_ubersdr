// Settings export and import.
//
// The panel is a list of switches over this module, so what matters here is
// what ends up in the file and what ends up back in localStorage: a backup that
// silently omits a setting, or an import that silently drops one, both look
// exactly like success.

const assert = require('assert');
const {
    APP, SECRETS, SECTIONS, applyBundle, buildBundle, bundleFilename, inspect,
    keysFor, presentCount, sectionFor,
} = require('./.build/backup.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A localStorage good enough for this module: keys in insertion order, a
// `length`/`key(i)` pair for the sweep, and an optional refusal to write.
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        refuse: false,
        get length() { return map.size; },
        key(i) { return [...map.keys()][i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (this.refuse) throw new Error('quota exceeded');
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        all() { return Object.fromEntries(map); },
    };
}

const install = (initial) => { globalThis.localStorage = fakeStorage(initial); return globalThis.localStorage; };
const allIds = () => SECTIONS.map((s) => s.id);

// --- what belongs where ------------------------------------------------------

t('every key a section claims is claimed by exactly one section', () => {
    const seen = new Set();
    for (const s of SECTIONS) {
        for (const k of s.keys || []) {
            assert.ok(!seen.has(k), `${k} is in two sections`);
            seen.add(k);
        }
    }
});

t('a v2 key no section claims still has a home', () => {
    // The whole point of the sweep: a store added later is backed up before
    // anyone remembers to list it.
    install({ 'ubersdr.v2.somethingNew': '{"a":1}' });
    assert.strictEqual(sectionFor('ubersdr.v2.somethingNew'), 'other');
    assert.deepStrictEqual(keysFor('other'), ['ubersdr.v2.somethingNew']);
});

t('a key with a section of its own is not swept up as well', () => {
    install({ 'ubersdr.v2.shortcuts': '{}', 'ubersdr.v2.loose': 'x' });
    assert.strictEqual(sectionFor('ubersdr.v2.shortcuts'), 'shortcuts');
    assert.deepStrictEqual(keysFor('other'), ['ubersdr.v2.loose']);
});

t('a key belonging to something else is left alone entirely', () => {
    install({ 'some.other.app': 'x' });
    assert.strictEqual(sectionFor('some.other.app'), null);
    assert.deepStrictEqual(keysFor('other'), []);
});

t('passwords are never exported, swept up or restored', () => {
    const store = install(Object.fromEntries(SECRETS.map((k) => [k, 'hunter2'])));
    for (const k of SECRETS) assert.strictEqual(sectionFor(k), null, k);
    assert.deepStrictEqual(keysFor('other'), []);

    const bundle = buildBundle(allIds());
    assert.deepStrictEqual(Object.keys(bundle.items), []);

    // Nor can one be smuggled back in by editing a file by hand.
    const forged = { items: Object.fromEntries(SECRETS.map((k) => [k, 'letmein'])) };
    assert.deepStrictEqual(applyBundle(forged, allIds(), 'merge'), { written: 0, removed: 0 });
    for (const k of SECRETS) assert.strictEqual(store.getItem(k), 'hunter2', k);
});

// --- the file ----------------------------------------------------------------

t('the bundle carries the selected sections and nothing else', () => {
    install({
        'ubersdr.v2.shortcuts': '{"enabled":true}',
        'ubersdr.v2.display': '{"palette":"classic"}',
    });
    const bundle = buildBundle(['shortcuts']);
    assert.strictEqual(bundle.app, APP);
    assert.deepStrictEqual(Object.keys(bundle.items), ['ubersdr.v2.shortcuts']);
    assert.deepStrictEqual(bundle.items['ubersdr.v2.shortcuts'], { enabled: true });
});

t('JSON is unpacked so the file can be read, and comes back exactly as stored', () => {
    const store = install({
        'ubersdr.v2.display': '{"palette":"radar","zoom":4}',
        // Not JSON. It has to survive as the string it is.
        'ubersdr.v2.chatChime': 'off',
        // Digits, which JSON.parse would happily turn into a number.
        'ubersdr_midi_step_hz': '500',
    });
    const bundle = buildBundle(allIds());
    assert.strictEqual(bundle.items['ubersdr.v2.chatChime'], 'off');
    assert.strictEqual(bundle.items['ubersdr_midi_step_hz'], '500');

    install({});
    applyBundle(bundle, allIds(), 'merge');
    assert.deepStrictEqual(globalThis.localStorage.all(), store.all());
});

t('a missing key is absent from the file rather than present as null', () => {
    install({ 'ubersdr.v2.shortcuts': '{}' });
    const bundle = buildBundle(allIds());
    assert.ok(!('ubersdr.v2.vfos' in bundle.items));
});

t('bookmarks ride along only when asked for', () => {
    install({});
    const list = [{ name: 'GB3', frequency: 7000000, mode: 'usb' }];
    assert.deepStrictEqual(buildBundle(['bookmarks'], { bookmarks: list }).bookmarks, list);
    assert.strictEqual(buildBundle(['shortcuts'], { bookmarks: list }).bookmarks, undefined);
});

t('the filename says when it was taken', () => {
    assert.strictEqual(bundleFilename(new Date('2026-08-05T09:00:00Z')), 'ubersdr-settings-2026-08-05.json');
});

t('presentCount counts what is there, not what could be', () => {
    install({ 'ubersdr.v2.radioControl': '{}', 'ubersdr_midi_device': 'nanoKONTROL' });
    assert.strictEqual(presentCount('controls'), 2);
    assert.strictEqual(presentCount('vfos'), 0);
});

// --- reading a file ----------------------------------------------------------

t('a file from another program is refused with a reason', () => {
    assert.strictEqual(inspect(null).ok, false);
    assert.strictEqual(inspect('nope').ok, false);
    assert.strictEqual(inspect({ app: 'something-else', items: {} }).ok, false);
});

t('a bookmarks file is refused by name, because it is the likely mistake', () => {
    const bare = inspect([{ name: 'GB3', frequency: 1, mode: 'usb' }]);
    assert.strictEqual(bare.ok, false);
    assert.match(bare.error, /bookmarks/i);
    assert.match(inspect({ dx: [] }).error, /bookmarks/i);
});

t('a good file is reported section by section', () => {
    install({});
    const r = inspect({
        app: APP,
        version: 1,
        exported: '2026-08-05T09:00:00.000Z',
        items: {
            'ubersdr.v2.shortcuts': {},
            'ubersdr.v2.radioControl': {},
            'ubersdr_midi_device': 'nanoKONTROL',
        },
        bookmarks: [1, 2, 3],
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.warning, '');
    const byId = Object.fromEntries(r.sections.map((s) => [s.id, s.count]));
    assert.deepStrictEqual(byId, { controls: 2, shortcuts: 1, bookmarks: 3 });
    assert.deepStrictEqual(r.unknown, []);
});

t('a newer file is a warning and a list, not a refusal', () => {
    const r = inspect({ app: APP, version: 99, items: { 'x.y': 1, 'ubersdr.v2.shortcuts': {} } });
    assert.strictEqual(r.ok, true);
    assert.match(r.warning, /newer/);
    assert.deepStrictEqual(r.unknown, ['x.y']);
    assert.deepStrictEqual(r.sections.map((s) => s.id), ['shortcuts']);
});

// --- writing it back ---------------------------------------------------------

const FILE = {
    app: APP,
    version: 1,
    items: {
        'ubersdr.v2.shortcuts': { enabled: false },
        'ubersdr.v2.vfos': { active: 'B' },
    },
};

t('only the selected sections are written', () => {
    const store = install({});
    const r = applyBundle(FILE, ['shortcuts'], 'merge');
    assert.deepStrictEqual(r, { written: 1, removed: 0 });
    assert.strictEqual(store.getItem('ubersdr.v2.shortcuts'), '{"enabled":false}');
    assert.strictEqual(store.getItem('ubersdr.v2.vfos'), null);
});

t('merge leaves settings the file does not mention alone', () => {
    const store = install({ 'ubersdr.v2.display': '{"palette":"classic"}' });
    applyBundle(FILE, allIds(), 'merge');
    assert.strictEqual(store.getItem('ubersdr.v2.display'), '{"palette":"classic"}');
});

t('replace clears the selected sections the file is silent about', () => {
    const store = install({
        'ubersdr.v2.display': '{"palette":"classic"}',
        'ubersdr.v2.vfos': '{"active":"D"}',
    });
    const r = applyBundle(FILE, allIds(), 'replace');
    // Display was not in the file, so it goes; VFOs was, so it is overwritten.
    assert.strictEqual(store.getItem('ubersdr.v2.display'), null);
    assert.strictEqual(store.getItem('ubersdr.v2.vfos'), '{"active":"B"}');
    assert.strictEqual(r.removed, 1);
});

t('replace only touches the sections that were selected', () => {
    const store = install({ 'ubersdr.v2.display': '{"palette":"classic"}' });
    applyBundle(FILE, ['shortcuts', 'vfos'], 'replace');
    assert.strictEqual(store.getItem('ubersdr.v2.display'), '{"palette":"classic"}');
});

t('replace sweeps unclaimed v2 keys too, so a restore is a restore', () => {
    const store = install({ 'ubersdr.v2.somethingNew': 'x' });
    applyBundle(FILE, allIds(), 'replace');
    assert.strictEqual(store.getItem('ubersdr.v2.somethingNew'), null);
});

t('a storage that refuses the write says so instead of reporting success', () => {
    // The failure this is here for: a quota error swallowed by a try/catch is
    // how a set of mappings disappears without anything on screen changing.
    const store = install({});
    store.refuse = true;
    assert.throws(() => applyBundle(FILE, allIds(), 'merge'), /ubersdr\.v2\./);
});

console.log(`\n${pass} ok`);
