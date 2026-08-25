// The receiver's frequency limits, and the fallback that has to hold when nobody
// supplies them.
//
// The span is no longer the literal 30 MHz: the server derives it from the front end
// sample rate and inlines it into the v2 shell as window.__UBERSDR__ (see
// v2TuningRangeJSON in v2_meta.go and RECEIVER_SPAN.md).
//
// The fallback is the load-bearing part. A bundle cached in a visitor's browser outlives
// the server it was built against, in both directions, so "no inlined value" has to mean
// exactly what the code did before the span became configurable — 10 kHz to 30 MHz — and
// never NaN, 0 or Infinity. These tests re-require the module under different globals to
// prove that, which means clearing it out of the require cache each time.

const assert = require('assert');
const path = require('path');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const MODULE = path.join(__dirname, '.build', 'constants.cjs');

// Load constants.js as if the page had (or had not) been served the inlined limits.
function loadWith(inlined) {
    delete require.cache[require.resolve(MODULE)];
    const hadWindow = 'window' in global;
    const prev = global.window;
    if (inlined === undefined) {
        // No window at all — a bundle running outside a browser, which is also what a
        // test harness looks like.
        delete global.window;
    } else {
        global.window = { __UBERSDR__: inlined };
    }
    try {
        return require(MODULE);
    } finally {
        if (hadWindow) global.window = prev;
        else delete global.window;
        delete require.cache[require.resolve(MODULE)];
    }
}

const TODAY = { min: 10000, max: 30000000, span: 30000000 };

function assertToday(c, why) {
    assert.strictEqual(c.MIN_FREQ, TODAY.min, `${why}: MIN_FREQ`);
    assert.strictEqual(c.MAX_FREQ, TODAY.max, `${why}: MAX_FREQ`);
    assert.strictEqual(c.RECEIVER_SPAN_HZ, TODAY.span, `${why}: RECEIVER_SPAN_HZ`);
}

// --- the fallback contract --------------------------------------------------

t('no window at all falls back to 10 kHz – 30 MHz', () => {
    assertToday(loadWith(undefined), 'no window');
});

t('a window with no __UBERSDR__ falls back', () => {
    delete require.cache[require.resolve(MODULE)];
    const prev = global.window;
    global.window = {};
    try {
        assertToday(require(MODULE), 'bare window');
    } finally {
        global.window = prev;
        delete require.cache[require.resolve(MODULE)];
    }
});

t('an empty object falls back — an older server that omits the field', () => {
    assertToday(loadWith({}), 'empty');
});

t('zeroes fall back rather than becoming limits', () => {
    // The reason the check is `> 0` and not `??` or `||`: a zero that survived would
    // make every frequency out of range and every span degenerate.
    assertToday(loadWith({ min_frequency: 0, max_frequency: 0, spectrum_span_hz: 0 }), 'zeroes');
});

t('nulls and empty strings fall back', () => {
    assertToday(loadWith({ min_frequency: null, max_frequency: '', spectrum_span_hz: undefined }), 'nullish');
});

t('a partial object falls back only for the parts that are missing', () => {
    const c = loadWith({ max_frequency: 60000000 });
    assert.strictEqual(c.MIN_FREQ, 10000, 'missing min still 10 kHz');
    assert.strictEqual(c.MAX_FREQ, 60000000, 'supplied max is honoured');
    assert.strictEqual(c.RECEIVER_SPAN_HZ, 30000000, 'missing span still 30 MHz');
});

t('nothing ever comes back NaN or Infinity', () => {
    for (const bad of [undefined, {}, { max_frequency: 'banana' }, { max_frequency: NaN },
        { max_frequency: -1 }, { spectrum_span_hz: -30000000 }]) {
        const c = loadWith(bad);
        for (const k of ['MIN_FREQ', 'MAX_FREQ', 'RECEIVER_SPAN_HZ']) {
            assert.ok(Number.isFinite(c[k]), `${k} not finite for ${JSON.stringify(bad)}`);
            assert.ok(c[k] > 0, `${k} not positive for ${JSON.stringify(bad)}`);
        }
    }
});

// --- a wider receiver -------------------------------------------------------

t('a 60 MHz receiver is carried through', () => {
    const c = loadWith({
        min_frequency: 10000,
        max_frequency: 60000000,
        spectrum_span_hz: 60000000,
        spectrum_center_hz: 30000000,
    });
    assert.strictEqual(c.MIN_FREQ, 10000);
    assert.strictEqual(c.MAX_FREQ, 60000000);
    assert.strictEqual(c.RECEIVER_SPAN_HZ, 60000000);
});

t('full-span Hz/bin is unchanged when the bin count scales with the span', () => {
    // Why the server doubles bin_count with the span: the zoom ladder is built from
    // this number, so holding it still keeps every saved zoom on a real rung.
    const narrow = loadWith({ spectrum_span_hz: 30000000 });
    const wide = loadWith({ spectrum_span_hz: 60000000 });
    assert.strictEqual(narrow.RECEIVER_SPAN_HZ / 1024, 29296.875);
    assert.strictEqual(wide.RECEIVER_SPAN_HZ / 2048, 29296.875);
});

// --- the pure modules keep their own defaults --------------------------------

t('chatFollow still clamps to 30 MHz when told nothing', () => {
    const { followView } = require('./.build/chatfollow.cjs');
    const user = { frequency: 200000, zoom_bw: 29296.875 };
    const v = followView(user, 1024);
    // A 30 MHz window cannot be centred on 200 kHz, so it comes back centred on the band.
    assert.strictEqual(v.frequency, 15000000, 'default top is 30 MHz');
});

t('chatFollow uses the receiver top when given one', () => {
    const { followView } = require('./.build/chatfollow.cjs');
    const user = { frequency: 200000, zoom_bw: 29296.875 };
    const v = followView(user, 1024, 60000000);
    // The same 30 MHz window fits inside a 60 MHz receiver, so the centre is pulled back
    // only as far as half a span rather than to the middle of the band.
    assert.strictEqual(v.frequency, 15000000, 'half a 30 MHz span up from 0');
    assert.ok(v.frequency - v.span / 2 >= 0, 'left edge stays inside the band');
});

t('ifSpectrum keeps 30 MHz as its own default, and takes an override', () => {
    const { fullBinWidthOf, FULL_SPAN_HZ } = require('./.build/ifspectrum.cjs');
    assert.strictEqual(FULL_SPAN_HZ, 30e6, 'pure-module default is unchanged');
    // The server's own figure always wins when it is present.
    assert.strictEqual(fullBinWidthOf({ defaultBinBandwidth: 1234, defaultBinCount: 1024 }), 1234);
    // Fallback path: before the first config, with and without a known span.
    assert.strictEqual(fullBinWidthOf({ defaultBinCount: 1024 }), 29296.875);
    assert.strictEqual(fullBinWidthOf({ defaultBinCount: 2048 }, 60e6), 29296.875);
});

console.log(`\n${pass} passed`);
