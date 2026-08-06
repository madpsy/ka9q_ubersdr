// Marker labels at the width a step button has for them.
//
// The finder itself is covered in mediasession.test.js, which is where it was
// first needed. This is the labelling: what goes on the ends of the Multipad's
// frequency drum, where there is room for about six characters and the choice of
// which six is the whole question. A callsign that came back cut, or a bookmark
// reduced to "S…", is not an error anywhere — it is just a label nobody can use.

const assert = require('assert');
const { shortMarkerName } = require('./.build/markernav.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a callsign is what these mostly are, and it comes back whole', () => {
    assert.strictEqual(shortMarkerName({ name: 'G4ABC' }), 'G4ABC');
    assert.strictEqual(shortMarkerName({ name: 'VK2XYZ/P' }), 'VK2XYZ/P');
});

t('a long name gives up its later words, not its letters', () => {
    // "Shannon V…" says less about which marker this is than "Shannon" does.
    assert.strictEqual(shortMarkerName({ name: 'Shannon Volmet' }), 'Shannon');
    assert.strictEqual(shortMarkerName({ name: 'Voice 20m' }), 'Voice');
});

t('as many whole words as fit, not just the first', () => {
    // Otherwise a name made of several short words loses all but one of them.
    assert.strictEqual(shortMarkerName({ name: 'DX net Europe' }, 6), 'DX net');
    assert.strictEqual(shortMarkerName({ name: 'a b c d e f g h' }, 5), 'a b c');
});

t('a single long word is cut, and says that it was', () => {
    assert.strictEqual(shortMarkerName({ name: 'Shannonvolmet' }), 'Shannon…', 'the cut is 8 wide with the ellipsis in it');
    // One letter rather than an ellipsis on its own, even though that is two
    // characters in a budget of one.
    assert.strictEqual(shortMarkerName({ name: 'abcdefgh' }, 1), 'a…');
});

t('the width is the caller\'s, and the fit is inclusive', () => {
    assert.strictEqual(shortMarkerName({ name: 'abcdefgh' }), 'abcdefgh', '8 fits in 8');
    assert.strictEqual(shortMarkerName({ name: 'abcdefghi' }, 12), 'abcdefghi');
});

t('whitespace is not spent on', () => {
    // A name padded or wrapped in the source data would otherwise be measured
    // with its padding and cut inside its first word.
    assert.strictEqual(shortMarkerName({ name: '  G4ABC  ' }), 'G4ABC');
    assert.strictEqual(shortMarkerName({ name: 'Shannon\n  Volmet' }), 'Shannon');
});

t('nothing to show is an empty string, not a crash or an "undefined"', () => {
    // The caller falls back to the frequency, and can only do that if this is
    // falsy rather than a label reading "undefined".
    assert.strictEqual(shortMarkerName(null), '');
    assert.strictEqual(shortMarkerName(undefined), '');
    assert.strictEqual(shortMarkerName({}), '');
    assert.strictEqual(shortMarkerName({ name: '   ' }), '');
});

console.log(`\n${pass} ok`);
