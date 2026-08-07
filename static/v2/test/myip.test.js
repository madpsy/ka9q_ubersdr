// The two ends of the start overlay's map.
//
// Both come from data we do not control: an operator who never set a position,
// and a GeoIP lookup that may know the country, the city, both or neither. The
// map is the first thing anyone sees, so neither may render as "undefined".

const assert = require('assert');
const {
    _resetMyIp, fetchMyIp, greeting, hasPosition, myipPosition, peekMyIp,
} = require('./.build/myip.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- one lookup a page --------------------------------------------------------
//
// Two things want this answer now — the start map's greeting and the spectrum's
// stats readout — and they mount at different moments. The cache is what stops
// that being two requests, and the failure path is what stops one bad moment
// costing the session its greeting for good.

const asyncT = [];
const at = (name, fn) => asyncT.push([name, fn]);

function stubFetch(reply) {
    let calls = 0;
    globalThis.fetch = () => {
        calls++;
        return typeof reply === 'function' ? reply() : Promise.resolve(reply);
    };
    return () => calls;
}

const okOnce = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

at('the answer is fetched once and shared', async () => {
    _resetMyIp();
    const calls = stubFetch(() => okOnce({ ip: '90.155.46.44', city: 'Camden' }));
    const [a, b] = await Promise.all([fetchMyIp(), fetchMyIp()]);
    assert.strictEqual(a.ip, '90.155.46.44');
    assert.strictEqual(b, a, 'both callers get the same object');
    await fetchMyIp();
    assert.strictEqual(calls(), 1, 'one request for three askings');
    assert.strictEqual(peekMyIp().ip, '90.155.46.44', 'and it can be read without asking');
});

at('nothing is known until it lands', async () => {
    _resetMyIp();
    assert.strictEqual(peekMyIp(), null);
    stubFetch(() => okOnce({ ip: '1.2.3.4' }));
    await fetchMyIp();
    assert.strictEqual(peekMyIp().ip, '1.2.3.4');
});

at('a failed lookup is not cached, so the next asking retries', async () => {
    // It is optional everywhere it is used, and a connection that was briefly
    // down must not cost the whole session its greeting.
    _resetMyIp();
    let fail = true;
    const calls = stubFetch(() => (fail
        ? Promise.reject(new Error('offline'))
        : okOnce({ ip: '5.6.7.8' })));
    assert.strictEqual(await fetchMyIp(), null, 'a failure answers null rather than throwing');
    fail = false;
    const second = await fetchMyIp();
    assert.strictEqual(second.ip, '5.6.7.8');
    assert.strictEqual(calls(), 2);
});

at('a refusal is an answer, not a cache entry', async () => {
    _resetMyIp();
    stubFetch(() => Promise.resolve({ ok: false, status: 503 }));
    assert.strictEqual(await fetchMyIp(), null);
    assert.strictEqual(peekMyIp(), null);
});

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

(async () => {
    for (const [name, fn] of asyncT) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} myip checks passed`);
})();
