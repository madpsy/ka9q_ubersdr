// The receiver's frequency limits, how they arrive, and the fallback that has to hold
// until they do.
//
// The limits come from one place: /api/description's `tuning_range`, built by
// ReceiverConfig.TuningRange() in receiver_span.go. They used to *also* be inlined into
// the v2 shell as window.__UBERSDR__, and that second mechanism is what these tests were
// written against. It is gone, because the bundled desktop and mobile clients serve their
// own index.html with the Go template actions stripped — so the inlined copy never
// reached them and every app quietly fell back to 30 MHz on every receiver. The symptom
// was a 60 MHz instance drawing 0-60 MHz of spectrum, which arrives over the websocket,
// while offering no 6 m button and refusing to centre above 30 MHz.
//
// So MIN_FREQ/MAX_FREQ/RECEIVER_SPAN_HZ are live module bindings now, set once by
// applyTuningRange when the description lands. Two properties matter and both are tested
// below: the defaults have to be exactly what the code did before the span became
// configurable, and the update has to reach consumers that imported the binding long
// before it moved.

const assert = require('assert');
const path = require('path');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const MODULE = path.join(__dirname, '.build', 'constants.cjs');

// A pristine copy of the module. These bindings are mutable now, so a test that applied a
// range would otherwise leave it applied for every test after it.
function fresh() {
    delete require.cache[require.resolve(MODULE)];
    const c = require(MODULE);
    delete require.cache[require.resolve(MODULE)];
    return c;
}

// Apply a range to a fresh copy and hand back what the module then reads.
function applied(range) {
    const c = fresh();
    const changed = c.applyTuningRange(range);
    return { c, changed };
}

const TODAY = { min: 10000, max: 30000000, span: 30000000 };

function assertToday(c, why) {
    assert.strictEqual(c.MIN_FREQ, TODAY.min, `${why}: MIN_FREQ`);
    assert.strictEqual(c.MAX_FREQ, TODAY.max, `${why}: MAX_FREQ`);
    assert.strictEqual(c.RECEIVER_SPAN_HZ, TODAY.span, `${why}: RECEIVER_SPAN_HZ`);
}

// --- the fallback contract --------------------------------------------------

t('before anything is applied, the limits are 10 kHz - 30 MHz', () => {
    // The window between the bundle evaluating and /api/description answering. Every
    // consumer reads these during it, so it is a real state and not just an initialiser.
    assertToday(fresh(), 'untouched');
});

t('no argument at all falls back — an older server that omits the object', () => {
    assertToday(applied(undefined).c, 'undefined');
    assertToday(applied(null).c, 'null');
    assertToday(applied({}).c, 'empty');
});

t('zeroes fall back rather than becoming limits', () => {
    // The reason the check is `> 0` and not `??` or `||`: a zero that survived would
    // make every frequency out of range and every span degenerate.
    assertToday(applied({ min_frequency: 0, max_frequency: 0, spectrum_span_hz: 0 }).c, 'zeroes');
});

t('nulls, strings and empty values fall back', () => {
    assertToday(applied({ min_frequency: null, max_frequency: '', spectrum_span_hz: undefined }).c,
        'nullish');
    // A string of digits is still not a number. Taking it would put a string into every
    // clamp in the app, where it compares by luck rather than by value.
    assertToday(applied({ min_frequency: '10000', max_frequency: '60000000' }).c, 'strings');
});

t('a partial object moves only the parts it supplies', () => {
    const { c } = applied({ max_frequency: 60000000 });
    assert.strictEqual(c.MIN_FREQ, 10000, 'missing min still 10 kHz');
    assert.strictEqual(c.MAX_FREQ, 60000000, 'supplied max is honoured');
    assert.strictEqual(c.RECEIVER_SPAN_HZ, 30000000, 'missing span still 30 MHz');
});

t('an inverted range is refused outright', () => {
    // Not a receiver, a misconfiguration — and taking it would leave every clamp in the
    // app inverted, which fails far away from here and looks like anything but this.
    const { c, changed } = applied({ min_frequency: 60000000, max_frequency: 10000 });
    assertToday(c, 'inverted');
    assert.strictEqual(changed, false, 'nothing moved, so nothing changed');
});

t('a max equal to the min is refused too', () => {
    assertToday(applied({ min_frequency: 30000000, max_frequency: 30000000 }).c, 'degenerate');
});

t('nothing ever comes back NaN or Infinity', () => {
    for (const bad of [undefined, {}, { max_frequency: 'banana' }, { max_frequency: NaN },
        { max_frequency: -1 }, { spectrum_span_hz: -30000000 }, { max_frequency: Infinity },
        { min_frequency: NaN, max_frequency: NaN, spectrum_span_hz: NaN }]) {
        const { c } = applied(bad);
        for (const k of ['MIN_FREQ', 'MAX_FREQ', 'RECEIVER_SPAN_HZ']) {
            assert.ok(Number.isFinite(c[k]), `${k} not finite for ${JSON.stringify(bad)}`);
            assert.ok(c[k] > 0, `${k} not positive for ${JSON.stringify(bad)}`);
        }
    }
});

t('applying the defaults reports no change', () => {
    // What most receivers are. The caller uses this to tell a real widening from the
    // overwhelmingly common case of a 30 MHz box confirming what was already assumed.
    const { changed } = applied({
        min_frequency: 10000, max_frequency: 30000000, spectrum_span_hz: 30000000,
    });
    assert.strictEqual(changed, false);
});

// --- a wider receiver -------------------------------------------------------

t('a 60 MHz receiver is carried through, and reports a change', () => {
    const { c, changed } = applied({
        min_frequency: 10000,
        max_frequency: 60000000,
        spectrum_span_hz: 60000000,
        spectrum_center_hz: 30000000,
    });
    assert.strictEqual(c.MIN_FREQ, 10000);
    assert.strictEqual(c.MAX_FREQ, 60000000);
    assert.strictEqual(c.RECEIVER_SPAN_HZ, 60000000);
    assert.strictEqual(changed, true);
});

t('full-span Hz/bin is unchanged when the bin count scales with the span', () => {
    // Why the server doubles bin_count with the span: the zoom ladder is built from
    // this number, so holding it still keeps every saved zoom on a real rung.
    const narrow = applied({ spectrum_span_hz: 30000000 }).c;
    const wide = applied({ spectrum_span_hz: 60000000 }).c;
    assert.strictEqual(narrow.RECEIVER_SPAN_HZ / 1024, 29296.875);
    assert.strictEqual(wide.RECEIVER_SPAN_HZ / 2048, 29296.875);
});

// --- the update reaches consumers -------------------------------------------
//
// The part that makes the whole approach viable. ~40 call sites import MIN_FREQ/MAX_FREQ
// and not one of them was touched when these stopped being constants, on the grounds that
// ES module bindings are live and esbuild keeps them that way through the bundle. If that
// is ever untrue the app fails exactly as it did before — silently, at 30 MHz — so it is
// asserted through real consumers rather than assumed.
//
// One bundle for all of it, which is the point of tuningrange.entry.js: separate bundles
// would each carry their own copy of the variable and agree with each other by accident.

t('a consumer that imported the binding sees a later change', () => {
    const m = require('./.build/tuningrange.cjs');
    const sixM = 50313000;
    // freqInRange reads MIN_FREQ/MAX_FREQ when it is called. Before the description
    // lands, 6 m is out of range on every receiver.
    assert.strictEqual(m.freqInRange(sixM), false, '6 m rejected at the 30 MHz default');
    assert.strictEqual(m.freqInRange(14074000), true, '20 m accepted either way');

    assert.strictEqual(m.applyTuningRange({
        min_frequency: 10000, max_frequency: 60000000, spectrum_span_hz: 60000000,
    }), true);

    // Same imported binding, same function, different answer.
    assert.strictEqual(m.freqInRange(sixM), true, '6 m accepted once the receiver says 60 MHz');
    assert.strictEqual(m.MAX_FREQ, 60000000, 're-exported binding is live too');
});

t('the quick-band keys gain 6 m on a 60 MHz receiver', () => {
    // The bug this whole change exists for: bandsInRange is fed the live bindings by
    // QuickBandsPanel and MultipadPanel, so a stale MAX_FREQ simply leaves the key out
    // with nothing to say it did.
    const m = require('./.build/tuningrange.cjs');
    const names = () => m.bandsInRange(m.MIN_FREQ, m.MAX_FREQ).map(([n]) => n);
    assert.ok(names().includes('20m'), '20 m is there regardless');
    assert.ok(names().includes('6m'), '6 m appears once the range is applied');

    m.applyTuningRange({ min_frequency: 10000, max_frequency: 30000000, spectrum_span_hz: 30000000 });
    assert.ok(!names().includes('6m'), 'and goes away again on a 30 MHz receiver');
    assert.ok(names().includes('20m'), '20 m still there');
});

t('the spectrum centre can reach above 30 MHz once the range is applied', () => {
    // The other half of the same symptom: the wide view drew 0-60 MHz because that comes
    // over the websocket, but centring was clamped by MAX_FREQ and snapped back.
    const m = require('./.build/tuningrange.cjs');
    const span = 200000;
    m.applyTuningRange({ min_frequency: 10000, max_frequency: 30000000, spectrum_span_hz: 30000000 });
    assert.ok(m.clampCenter(50313000, span) < 30000000, 'clamped away at 30 MHz');

    m.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000, spectrum_span_hz: 60000000 });
    assert.strictEqual(m.clampCenter(50313000, span), 50313000, 'reachable at 60 MHz');
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


// ── Bookmark reachability ────────────────────────────────────────────────────
//
// Bookmarks outlive the receiver's range. Save a 6 m bookmark at 129.6 Msps, drop back
// to 64.8, and the record is still there — served by the server, listed by both panels —
// but unreachable. Clicking it must refuse rather than let tuneTo clamp to the band edge,
// because a silent landing on 30 MHz looks like the click worked.
const { bookmarkReachable, markerReachable } = require('./.build/bookmarktune.cjs');

t('a bookmark inside the range is reachable', () => {
    assert.ok(bookmarkReachable({ frequency: 14074000 }, 10000, 30000000));
});

t('a 6 m bookmark is unreachable on a 30 MHz receiver, reachable on a 60 MHz one', () => {
    const sixM = { frequency: 50313000 };
    assert.ok(!bookmarkReachable(sixM, 10000, 30000000), 'must refuse at 30 MHz');
    assert.ok(bookmarkReachable(sixM, 10000, 60000000), 'must allow at 60 MHz');
});

t('the defaults are the old 10 kHz - 30 MHz, for a caller that passes none', () => {
    assert.ok(bookmarkReachable({ frequency: 14074000 }));
    assert.ok(!bookmarkReachable({ frequency: 50313000 }));
});

t('junk is unreachable rather than throwing', () => {
    for (const b of [null, undefined, {}, { frequency: null }, { frequency: NaN },
        { frequency: '14074000' }, { frequency: -1 }, { frequency: Infinity }]) {
        assert.strictEqual(bookmarkReachable(b, 10000, 30000000), false,
            `${JSON.stringify(b)} should be unreachable`);
    }
});

t('markers answer the same question about their own field', () => {
    assert.ok(markerReachable({ freq: 14074000 }, 10000, 30000000));
    assert.ok(!markerReachable({ freq: 50313000 }, 10000, 30000000));
    assert.strictEqual(markerReachable({ frequency: 14074000 }, 10000, 30000000), false,
        'a marker carries freq, not frequency');
});

t('the band edges themselves are reachable', () => {
    assert.ok(bookmarkReachable({ frequency: 10000 }, 10000, 30000000));
    assert.ok(bookmarkReachable({ frequency: 30000000 }, 10000, 30000000));
    assert.ok(!bookmarkReachable({ frequency: 9999 }, 10000, 30000000));
    assert.ok(!bookmarkReachable({ frequency: 30000001 }, 10000, 30000000));
});

console.log(`\n${pass} passed`);
