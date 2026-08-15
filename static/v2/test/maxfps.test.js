// The frame cap's default, which is per device rather than stored.
//
// Worth pinning because both halves are easy to get subtly wrong: a stored 0
// must survive (it is a deliberate "no limit", not an absence), and a device
// with no stored value must not be given one — the whole point of resolving at
// read time is that the same settings blob, shared between a phone and a
// desktop by the apps, means the right thing on each.

const assert = require('assert');
const { resolveMaxFps } = require('./.build/displaycontext.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('nothing chosen splits by device', () => {
    assert.strictEqual(resolveMaxFps(null, true), 30);
    assert.strictEqual(resolveMaxFps(null, false), 0);
    assert.strictEqual(resolveMaxFps(undefined, true), 30);
});

t('a stored zero is a choice and survives on touch', () => {
    // "No limit" picked deliberately on a tablet must not be overruled by the
    // default it was chosen instead of.
    assert.strictEqual(resolveMaxFps(0, true), 0);
    assert.strictEqual(resolveMaxFps(0, false), 0);
});

t('a stored rate wins on either kind of device', () => {
    assert.strictEqual(resolveMaxFps(15, true), 15);
    assert.strictEqual(resolveMaxFps(60, false), 60);
});

t('rubbish falls back to the device default', () => {
    for (const bad of ['30', NaN, Infinity, {}, [], 'no limit']) {
        assert.strictEqual(resolveMaxFps(bad, true), 30, String(bad));
        assert.strictEqual(resolveMaxFps(bad, false), 0, String(bad));
    }
});

console.log(`\n${pass} ok`);
