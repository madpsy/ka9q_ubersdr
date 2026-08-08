// The passband a local bookmark stores.
//
// The field was in the format from the start — it is v1's store, shared with v1 — and v2 both
// writes it (the ⭐ on the spectrum) and obeys it (tuning to a bookmark restores the filter).
// What it did not do was show it, so the form preserved a passband it could not display and
// there was no way to set or correct one. These are the rules that form now applies.

const assert = require('assert');
const { passbandFields } = require('./.build/localbookmarks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a pair of edges is stored as numbers', () => {
    assert.deepStrictEqual(passbandFields('-2700', '-50'), { low: -2700, high: -50 });
    assert.deepStrictEqual(passbandFields('300', '2700'), { low: 300, high: 2700 });
});

t('surrounding space is not a passband of its own', () => {
    assert.deepStrictEqual(passbandFields(' 300 ', ' 2700 '), { low: 300, high: 2700 });
});

t('two blanks are null, which is how a stored passband is cleared', () => {
    // Null rather than absent, deliberately: the store leaves a field alone when it is
    // undefined, and that is exactly what kept an invisible passband through every edit.
    assert.deepStrictEqual(passbandFields('', ''), { low: null, high: null });
    assert.deepStrictEqual(passbandFields(null, undefined), { low: null, high: null });
});

t('one edge on its own is refused', () => {
    // Tuning only restores a passband when both are numbers, so half a pair would be stored
    // for ever and never used.
    assert.ok(passbandFields('300', '').error);
    assert.ok(passbandFields('', '2700').error);
});

t('edges the wrong way round are refused, with the reason', () => {
    // The two fields sit side by side and are easy to fill in the wrong boxes.
    const r = passbandFields('2700', '300');
    assert.ok(/below/.test(r.error), r.error);
    assert.ok(passbandFields('300', '300').error, 'and a zero-width filter is not one either');
});

t('anything that is not a number is refused rather than stored as one', () => {
    assert.ok(passbandFields('wide', 'narrow').error);
    assert.ok(passbandFields('300', 'x').error);
});

t('a negative pair is fine, because LSB is the normal case', () => {
    assert.deepStrictEqual(passbandFields('-2700', '-50'), { low: -2700, high: -50 });
});

if (process.exitCode) console.log('\nlocal bookmark tests FAILED');
else console.log(`\nall ${pass} local bookmark tests passed`);
