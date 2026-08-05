// Terrestrial weather.
//
// The fixture is a real /api/weather response, so the parser is tested against
// the document the server actually serves rather than one written to match it.

const assert = require('assert');
const wx = require('./.build/weather.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    );
};

// Verbatim from m9psy.tunnel.ubersdr.org.
const SAMPLE = {
    base: 'stations',
    cached: true,
    clouds: { all: 96 },
    cod: 200,
    coord: { lat: 56.0403, lon: -3.3554 },
    dt: 1785945052,
    id: 2638821,
    last_fetched: '2026-08-05T15:50:52Z',
    main: {
        feels_like: 16.11, grnd_level: 991, humidity: 80, pressure: 1004,
        sea_level: 1004, temp: 16.33, temp_max: 18.07, temp_min: 15.79,
    },
    name: 'Saint Davids',
    sys: { country: 'GB', id: 2007704, sunrise: 1785903869, sunset: 1785960862, type: 2 },
    timezone: 3600,
    visibility: 10000,
    weather: [{ description: 'overcast clouds', icon: '04d', id: 804, main: 'Clouds' }],
    wind: { deg: 246, gust: 13.95, speed: 9.25 },
};

t('a real response is read into what the panel shows', () => {
    const w = wx.readWeather(SAMPLE);
    assert.strictEqual(w.condition, 'Clouds');
    assert.strictEqual(w.description, 'Overcast clouds', 'first letter only');
    assert.strictEqual(w.icon, '/weather/04d_t@2x.png');
    assert.strictEqual(w.tempC, 16.33);
    assert.strictEqual(w.feelsLikeC, 16.11);
    assert.strictEqual(w.humidity, 80);
    assert.strictEqual(w.pressure, 1004);
    assert.strictEqual(w.windMs, 9.25);
    assert.strictEqual(w.windDeg, 246);
    assert.strictEqual(w.gustMs, 13.95);
    assert.strictEqual(w.cloud, 96);
    assert.strictEqual(w.visibilityM, 10000);
    assert.strictEqual(w.place, 'Saint Davids');
    assert.strictEqual(w.country, 'GB');
    assert.strictEqual(w.tzOffsetSec, 3600);
});

t('a station that reports nothing is nulls, not NaN or zero', () => {
    // OWM omits what the station did not send, and a missing wind vane must not
    // print as a dead calm.
    const w = wx.readWeather({ weather: [], main: {}, wind: {} });
    assert.strictEqual(w.tempC, null);
    assert.strictEqual(w.windMs, null);
    assert.strictEqual(w.windDeg, null);
    assert.strictEqual(w.cloud, null);
    assert.strictEqual(w.icon, '');
    assert.strictEqual(w.description, '');
});

t('nothing at all is null rather than a throw', () => {
    assert.strictEqual(wx.readWeather(null), null);
    assert.strictEqual(wx.readWeather('nope'), null);
});

// --- icons -------------------------------------------------------------------

t('every icon code the API can send is one we hold', () => {
    // The eighteen files in static/weather. A code with no file gets no image
    // rather than a broken one.
    for (const c of ['01', '02', '03', '04', '09', '10', '11', '13', '50']) {
        for (const half of ['d', 'n']) {
            assert.strictEqual(wx.weatherIcon(c + half), `/weather/${c}${half}_t@2x.png`);
        }
    }
});

t('an unknown code asks for no image', () => {
    assert.strictEqual(wx.weatherIcon('99z'), '');
    assert.strictEqual(wx.weatherIcon(''), '');
    assert.strictEqual(wx.weatherIcon(undefined), '');
});

// --- wind --------------------------------------------------------------------

t('a bearing becomes a compass point', () => {
    assert.strictEqual(wx.windDirection(0), 'N');
    assert.strictEqual(wx.windDirection(90), 'E');
    assert.strictEqual(wx.windDirection(180), 'S');
    assert.strictEqual(wx.windDirection(270), 'W');
    assert.strictEqual(wx.windDirection(246), 'WSW', 'the sample');
    assert.strictEqual(wx.windDirection(23), 'NNE');
});

t('the compass wraps rather than running off the end', () => {
    assert.strictEqual(wx.windDirection(360), 'N');
    assert.strictEqual(wx.windDirection(359), 'N');
    assert.strictEqual(wx.windDirection(-90), 'W');
    assert.strictEqual(wx.windDirection(720 + 90), 'E');
});

t('no bearing is no direction, not north', () => {
    assert.strictEqual(wx.windDirection(null), '');
    assert.strictEqual(wx.windDirection(undefined), '');
    assert.strictEqual(wx.windDirection(NaN), '');
});

t('m/s becomes km/h', () => {
    assert.strictEqual(wx.windKmh(9.25), 33);
    assert.strictEqual(wx.windKmh(0), 0);
    assert.strictEqual(wx.windKmh(null), null);
});

t('a speed becomes a Beaufort force', () => {
    assert.strictEqual(wx.beaufort(0), 0, 'calm');
    assert.strictEqual(wx.beaufort(0.4), 0);
    assert.strictEqual(wx.beaufort(0.5), 1);
    assert.strictEqual(wx.beaufort(9.25), 5, 'the sample: fresh breeze');
    assert.strictEqual(wx.beaufort(13.95), 7, 'the sample gust: near gale, at the 13.9 boundary');
    assert.strictEqual(wx.beaufort(33), 12, 'hurricane, and the scale stops there');
    assert.strictEqual(wx.beaufort(200), 12);
});

t('a force has a name, and a missing one does not', () => {
    assert.strictEqual(wx.beaufortName(0), 'Calm');
    assert.strictEqual(wx.beaufortName(5), 'Fresh breeze');
    assert.strictEqual(wx.beaufortName(12), 'Hurricane');
    assert.strictEqual(wx.beaufortName(null), '');
});

t('no wind reading is no force', () => {
    assert.strictEqual(wx.beaufort(null), null);
    assert.strictEqual(wx.beaufort(-1), null);
});

// --- times -------------------------------------------------------------------

t('sunrise is local to the weather, not to the reader', () => {
    // 1785903869 is 04:24 UTC; the station reported itself one hour east.
    assert.strictEqual(wx.localTime(SAMPLE.sys.sunrise, 0), '04:24');
    assert.strictEqual(wx.localTime(SAMPLE.sys.sunrise, 3600), '05:24');
    assert.strictEqual(wx.localTime(SAMPLE.sys.sunset, 3600), '21:14');
});

t('a negative offset goes the other way', () => {
    assert.strictEqual(wx.localTime(SAMPLE.sys.sunrise, -5 * 3600), '23:24');
});

t('no time is no string', () => {
    assert.strictEqual(wx.localTime(null, 0), '');
    assert.strictEqual(wx.localTime(undefined, 0), '');
});

t('the reading says how old it is', () => {
    const at = 1785945052;
    const at1000 = (mins) => (at + mins * 60) * 1000;
    assert.strictEqual(wx.ageLabel(at, at1000(0)), 'just now');
    assert.strictEqual(wx.ageLabel(at, at1000(1)), '1 min ago');
    assert.strictEqual(wx.ageLabel(at, at1000(20)), '20 mins ago');
    assert.strictEqual(wx.ageLabel(at, at1000(60)), '1 hour ago');
    assert.strictEqual(wx.ageLabel(at, at1000(200)), '3 hours ago');
    assert.strictEqual(wx.ageLabel(null), '');
});

// --- fetching ----------------------------------------------------------------

function withFetch(impl, fn) {
    const prev = global.fetch;
    let calls = 0;
    global.fetch = (...args) => { calls++; return impl(...args); };
    return Promise.resolve(fn(() => calls)).finally(() => { global.fetch = prev; });
}

const respond = (status, body) => () => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
});

t('a good response comes back parsed', () => withFetch(
    respond(200, SAMPLE),
    async () => {
        wx._resetWeather();
        const r = await wx.fetchWeather();
        assert.strictEqual(r.data.place, 'Saint Davids');
        assert.strictEqual(r.unavailable, undefined);
        assert.strictEqual(r.error, undefined);
    },
));

t('a 404 is "not here", not a failure', () => withFetch(
    respond(404, { error: 'Weather data not yet available.' }),
    async () => {
        wx._resetWeather();
        const r = await wx.fetchWeather();
        // No weather source configured, or the first fetch has not landed. The
        // panel says so plainly rather than showing it as something broken.
        assert.strictEqual(r.unavailable, 'Weather data not yet available.');
        assert.strictEqual(r.error, undefined);
        assert.strictEqual(r.data, undefined);
    },
));

t('a rate limit is a failure worth showing', () => withFetch(
    respond(429, { error: 'Rate limit exceeded. Please wait before retrying.' }),
    async () => {
        wx._resetWeather();
        const r = await wx.fetchWeather();
        assert.match(r.error, /Rate limit/);
    },
));

t('the answer is cached — the endpoint allows one request a second', () => withFetch(
    respond(200, SAMPLE),
    async (calls) => {
        wx._resetWeather();
        await wx.fetchWeather();
        await wx.fetchWeather();
        await wx.fetchWeather();
        assert.strictEqual(calls(), 1);
    },
));

t('a failure is cached too, so a receiver with no weather is not hammered', () => withFetch(
    respond(404, { error: 'Weather data not yet available.' }),
    async (calls) => {
        wx._resetWeather();
        await wx.fetchWeather();
        await wx.fetchWeather();
        assert.strictEqual(calls(), 1);
    },
));

t('Refresh asks again', () => withFetch(
    respond(200, SAMPLE),
    async (calls) => {
        wx._resetWeather();
        await wx.fetchWeather();
        await wx.fetchWeather({ force: true });
        assert.strictEqual(calls(), 2);
    },
));

t('the cache lets go once it is stale', () => withFetch(
    respond(200, SAMPLE),
    async (calls) => {
        wx._resetWeather();
        await wx.fetchWeather();
        // Under five minutes is still the cached answer — the panel polls at
        // five and the spectrum's station block at fifteen, and between them
        // that should be about one request per interval, not three.
        await wx.fetchWeather({ now: Date.now() + 4 * 60_000 });
        assert.strictEqual(calls(), 1);
        await wx.fetchWeather({ now: Date.now() + 5 * 60_000 + 1000 });
        assert.strictEqual(calls(), 2);
    },
));

t('two callers at once share one request', () => withFetch(
    respond(200, SAMPLE),
    async (calls) => {
        wx._resetWeather();
        const [a, b] = await Promise.all([wx.fetchWeather(), wx.fetchWeather()]);
        assert.strictEqual(calls(), 1);
        assert.strictEqual(a.data.place, b.data.place);
    },
));

t('a dead connection is reported, not thrown', () => withFetch(
    () => Promise.reject(new TypeError('Failed to fetch')),
    async () => {
        wx._resetWeather();
        const r = await wx.fetchWeather();
        assert.match(r.error, /Failed to fetch/);
    },
));

t('a body that is not JSON does not take the panel down', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad')) }),
    async () => {
        wx._resetWeather();
        const r = await wx.fetchWeather();
        assert.ok(r.error, 'expected an error rather than a crash');
    },
));

chain.then(() => {
    if (process.exitCode) console.log('\nweather tests FAILED');
    else console.log(`\nall ${pass} weather tests passed`);
});
