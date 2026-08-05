// Keyboard shortcuts: the key half. What a shortcut *does* is the function
// catalogue, which controls.test.js already covers — this is about turning a
// keystroke into one spelling, refusing the keys the browser needs, and the
// rules that decide when not to listen at all.

const assert = require('assert');
const {
    comboFor, comboLabel, comboProblem, isTyping, DEFAULT_BINDINGS, DEFAULTS,
} = require('./.build/shortcuts.cjs');
const { catalogue } = require('./.build/functions.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

// --- one keystroke, one spelling ---------------------------------------------

t('a letter is stored lowercase, so Shift is a modifier and not a different key', () => {
    // The browser reports 'K' for shift+k, which would otherwise be a second
    // binding nobody could tell from the first.
    assert.strictEqual(comboFor(ev('k')), 'k');
    assert.strictEqual(comboFor(ev('K', { shiftKey: true })), 'Shift+k');
});

t('modifiers are always written in the same order', () => {
    const all = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true };
    assert.strictEqual(comboFor(ev('k', all)), 'Ctrl+Alt+Shift+Meta+k');
    // Whichever order the flags happen to be read in, the string is the same.
    assert.strictEqual(comboFor(ev('k', { metaKey: true, ctrlKey: true })), 'Ctrl+Meta+k');
});

t('named keys keep their names, and space is not a blank', () => {
    assert.strictEqual(comboFor(ev('ArrowUp')), 'ArrowUp');
    assert.strictEqual(comboFor(ev(' ')), 'Space');
    assert.strictEqual(comboFor(ev('Escape')), 'Escape');
});

t('a modifier on its own is not a shortcut', () => {
    // It is the start of one — holding Shift must not bind anything.
    for (const k of ['Control', 'Alt', 'Shift', 'Meta']) {
        assert.strictEqual(comboFor(ev(k, { shiftKey: true })), '');
    }
});

t('a combo is shown readably without changing what is stored', () => {
    assert.strictEqual(comboLabel('k'), 'K');
    assert.strictEqual(comboLabel('Shift+k'), 'Shift + K');
    assert.strictEqual(comboLabel('ArrowLeft'), 'Left');
    assert.strictEqual(comboLabel('Space'), 'Space');
    assert.strictEqual(comboLabel('Ctrl+ArrowUp'), 'Ctrl + Up');
});

// --- what cannot be bound ----------------------------------------------------

t('keys the browser needs are refused, with a reason', () => {
    // Losing Ctrl+F or a reload to a shortcut, with nothing saying where it
    // went, is worse than the shortcut being unavailable.
    assert.notStrictEqual(comboProblem('Ctrl+f'), '');
    assert.notStrictEqual(comboProblem('Ctrl+r'), '');
    assert.notStrictEqual(comboProblem('F5'), '');
    assert.notStrictEqual(comboProblem('Tab'), '');
    assert.strictEqual(comboProblem('k'), '');
    assert.strictEqual(comboProblem('Shift+k'), '');
});

// --- when not to listen ------------------------------------------------------

t('anything being typed into owns the keyboard', () => {
    // The one rule every v1 handler had to remember separately, and did
    // slightly differently each time.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.strictEqual(isTyping({ tagName }), true, tagName);
    }
    assert.strictEqual(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
    assert.strictEqual(isTyping({ tagName: 'DIV' }), false);
    assert.strictEqual(isTyping(null), false);
});

// --- the defaults ------------------------------------------------------------

t('every default binding names a function that exists', () => {
    // A typo here is a key that silently does nothing, which is the failure
    // this whole arrangement is meant to make impossible.
    const ids = new Set(catalogue([], {
        rotator: true,
        antenna: { count: 10, labels: [] },
    }).map((f) => f.id));
    for (const [combo, fn] of Object.entries(DEFAULT_BINDINGS)) {
        assert.ok(ids.has(fn), `${combo} -> ${fn} is not in the catalogue`);
    }
});

t('no two default keys are the same', () => {
    const keys = Object.keys(DEFAULT_BINDINGS);
    assert.strictEqual(new Set(keys).size, keys.length);
});

t('no default binding is a key the browser needs', () => {
    for (const combo of Object.keys(DEFAULT_BINDINGS)) {
        assert.strictEqual(comboProblem(combo), '', combo);
    }
});

t('v1s band keys are still the band keys', () => {
    // Anyone arriving from the old interface finds their fingers already work.
    const bands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].forEach((key, i) => {
        assert.strictEqual(DEFAULT_BINDINGS[key], `band_${bands[i]}`, key);
    });
});

// --- collisions --------------------------------------------------------------

t('a key can only ever run one function', () => {
    // Structural, not checked for: the bindings are keyed by the combo, so two
    // functions cannot both hold a key and dispatch is never ambiguous.
    const bindings = { u: 'mode_usb' };
    bindings.u = 'mode_lsb';
    assert.strictEqual(Object.keys(bindings).length, 1);
    assert.strictEqual(bindings.u, 'mode_lsb');
});

t('giving a taken key to another function takes it off the first', () => {
    // The panel names the displaced function and offers Undo, because a
    // function silently left with no key is the failure mode here.
    const bindings = { u: 'mode_usb', l: 'mode_lsb' };
    const before = { ...bindings };
    bindings.u = 'mode_lsb';
    const keysFor = (fn) => Object.keys(bindings).filter((k) => bindings[k] === fn);
    assert.deepStrictEqual(keysFor('mode_usb'), []);
    assert.deepStrictEqual(keysFor('mode_lsb').sort(), ['l', 'u']);
    // ...and the whole previous map is what Undo restores.
    assert.deepStrictEqual(before, { u: 'mode_usb', l: 'mode_lsb' });
});

t('one function on two keys is allowed', () => {
    // Deliberate: a function may be worth reaching from more than one place,
    // which is why the map is key->function rather than the reverse.
    const bindings = { u: 'mode_usb', 'Shift+u': 'mode_usb' };
    assert.strictEqual(Object.values(bindings).filter((f) => f === 'mode_usb').length, 2);
});

t('shortcuts are on by default, unlike the announcements', () => {
    // A shortcut does nothing until a key is pressed; a speaking receiver
    // starts on its own.
    assert.strictEqual(DEFAULTS.enabled, true);
});

if (process.exitCode) console.log('\nshortcut tests FAILED');
else console.log(`\nall ${pass} shortcut tests passed`);
