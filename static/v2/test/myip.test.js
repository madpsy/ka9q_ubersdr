// The two ends of the start overlay's map.
//
// Both come from data we do not control: an operator who never set a position,
// and a GeoIP lookup that may know the country, the city, both or neither. The
// map is the first thing anyone sees, so neither may render as "undefined".

const assert = require('assert');
const { greeting, hasPosition, myipPosition } = require('./.build/myip.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('0,0 is the config default, not a position', () => {
    // Drawing it would put every unconfigured receiver in the Gulf of Guinea.
    assert.strictEqual(hasPosition({ lat: 0, lon: 0 }), false);
    assert.strictEqual(hasPosition(null), false);
    assert.strictEqual(hasPosition({}), false);
    assert.strictEqual(hasPosition({ lat: 51.5 }), false);
    // A real position on one axis only is still a real position.
    assert.strictEqual(hasPosition({ lat: 51.5, lon: 0 }), true);
    assert.strictEqual(hasPosition({ lat: 0, lon: -0.1 }), true);
});

t('the greeting names the city, the country and the distance', () => {
    const g = greeting({ city: 'Berlin', country: 'Germany', country_code: 'DE', distance_km: 823.6 }, false);
    assert.ok(g.startsWith('Hello Berlin, '), g);
    assert.ok(g.includes('Germany'), g);
    assert.ok(g.includes('(824 km)'), g);
    assert.ok(g.endsWith('🖥️'), g);
    assert.ok(g.includes('🇩🇪'), 'the flag comes from the country code');
});

t('a phone is greeted as a phone', () => {
    assert.ok(greeting({ country: 'Germany' }, true).endsWith('📱'));
});

t('missing parts are left out rather than printed as gaps', () => {
    // No city: the country still says where you are.
    assert.strictEqual(greeting({ country: 'Germany', country_code: 'DE' }, false), 'Hello 🇩🇪 Germany 🖥️');
    // No distance: no empty brackets.
    assert.ok(!greeting({ city: 'Oslo', country: 'Norway' }, false).includes('('));
    // No country at all: nothing to say, so nothing is said.
    assert.strictEqual(greeting({ city: 'Oslo' }, false), '');
    assert.strictEqual(greeting(null, false), '');
});

t('a lookup without coordinates puts no pin on the map', () => {
    assert.strictEqual(myipPosition(null), null);
    assert.strictEqual(myipPosition({ country: 'Germany' }), null);
    assert.strictEqual(myipPosition({ latitude: 52.5, longitude: null }), null);
    assert.deepStrictEqual(myipPosition({ latitude: 52.5, longitude: 13.4 }), [52.5, 13.4]);
});

console.log(`\n${pass} myip checks passed`);
