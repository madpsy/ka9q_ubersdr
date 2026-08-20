// The Bands panel's data: which band it shows, how a reading is graded, and
// the once-a-minute rule.
//
// The rule is the part worth pinning. Section unmounts a closed panel's body,
// so opening and closing the panel releases and re-acquires the store, and a
// bare setInterval would fetch on every re-acquire. The floor is what stops
// that, and nothing in the panel would show it had gone.

const assert = require('assert');
const {
    POLL_MS, RANK_MIN_BANDS, chooseBand, floorStats, floorTone, followsDial,
    formatFigure, getBandNoise, hasFT8, measuredMs, resetBandNoise, rowsFrom,
    setFeedsAllowed, resetFeeds, snrLabel, snrTone, subscribeBandNoise,
} = require('./.build/bandnoise.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The store's guard is asynchronous — a fetch is in flight until its promise
// settles — so anything testing "was a second request made" has to let the
// first one land, or it is only testing the in-flight check.
// They also share one global fetch and one module-level store, so they are
// queued and run one after another rather than started as they are declared.
const settle = () => new Promise((r) => setImmediate(r));
const queued = [];
const ta = (name, fn) => queued.push([name, fn]);

// --- reading a reply --------------------------------------------------------

const m = (band, over = {}) => ({
    timestamp: '2026-08-20T12:00:00Z',
    band,
    p5_db: -120,
    p95_db: -80,
    max_db: -60,
    median_db: -110,
    dynamic_range: 40,
    occupancy_pct: 12.5,
    ft8_snr: 20,
    ...over,
});

t('rows come back up the spectrum, whatever order the reply was in', () => {
    const rows = rowsFrom({ '20m': m('20m'), '160m': m('160m'), '40m': m('40m') });
    assert.deepStrictEqual(rows.map((r) => r.band), ['160m', '40m', '20m']);
});

t('a band the band plan does not know sorts last rather than vanishing', () => {
    const rows = rowsFrom({ Marine: m('Marine'), '20m': m('20m'), Airband: m('Airband') });
    assert.deepStrictEqual(rows.map((r) => r.band), ['20m', 'Airband', 'Marine']);
});

t('the band name is carried onto the row, not left to the key', () => {
    // The panel looks bands up by row.band; a reply whose measurement omits the
    // field would otherwise give every row an undefined name.
    const rows = rowsFrom({ '20m': { p5_db: -119 } });
    assert.strictEqual(rows[0].band, '20m');
    assert.strictEqual(rows[0].p5_db, -119);
});

t('an empty or broken reply is no rows, not a crash', () => {
    assert.deepStrictEqual(rowsFrom(null), []);
    assert.deepStrictEqual(rowsFrom({}), []);
    assert.deepStrictEqual(rowsFrom('nonsense'), []);
    assert.deepStrictEqual(rowsFrom({ '20m': null }), []);
});

// --- which band is shown ----------------------------------------------------

const ROWS = rowsFrom({ '40m': m('40m'), '20m': m('20m') });

t('auto follows the dial', () => {
    assert.strictEqual(chooseBand('auto', ROWS, '20m'), '20m');
    assert.strictEqual(chooseBand(null, ROWS, '40m'), '40m');
    assert.strictEqual(followsDial('auto', ROWS), true);
});

t('a pin wins over the dial, and says it is not followsDial', () => {
    assert.strictEqual(chooseBand('40m', ROWS, '20m'), '40m');
    assert.strictEqual(followsDial('40m', ROWS), false);
});

t('a pin to a band the monitor no longer measures falls back to followsDial', () => {
    // The monitor's band list is configuration and can change under a stored
    // preference. Reading "15m — no data" forever is worse than going back to
    // the dial.
    assert.strictEqual(followsDial('15m', ROWS), true);
    assert.strictEqual(chooseBand('15m', ROWS, '20m'), '20m');
});

t('a dial outside every measured band still shows a band', () => {
    // Most of HF is not an amateur band; a listener on a broadcast station gets
    // the first measured band rather than an empty panel.
    assert.strictEqual(chooseBand('auto', ROWS, null), '40m');
    assert.strictEqual(chooseBand('auto', ROWS, '10m'), '40m');
});

t('nothing measured is null, not the first of nothing', () => {
    assert.strictEqual(chooseBand('auto', [], '20m'), null);
});

// --- grading a reading ------------------------------------------------------

t('a zero or missing FT8 SNR is no reading, not 0 dB', () => {
    // float32 zero is both "heard nothing" and "has not run the FT8 pass yet".
    assert.strictEqual(hasFT8(m('20m', { ft8_snr: 0 })), false);
    assert.strictEqual(hasFT8(m('20m', { ft8_snr: undefined })), false);
    assert.strictEqual(hasFT8(m('20m', { ft8_snr: 12 })), true);
    assert.strictEqual(snrTone(m('20m', { ft8_snr: 0 })), 'none');
    assert.strictEqual(snrLabel(m('20m', { ft8_snr: 0 })), 'No FT8');
});

t('the buckets are the band keys\', so the panel and the buttons agree', () => {
    assert.strictEqual(snrTone(m('20m', { ft8_snr: 5.9 })), 'poor');
    assert.strictEqual(snrTone(m('20m', { ft8_snr: 6 })), 'fair');
    assert.strictEqual(snrTone(m('20m', { ft8_snr: 20 })), 'good');
    assert.strictEqual(snrTone(m('20m', { ft8_snr: 30 })), 'excellent');
    assert.strictEqual(snrLabel(m('20m', { ft8_snr: 30 })), 'Excellent');
    assert.strictEqual(snrLabel(m('20m', { ft8_snr: 6 })), 'Fair');
});

// --- ranking the noise floor ------------------------------------------------

t('the quartiles are noisefloor.html\'s, index arithmetic included', () => {
    const rows = [-130, -120, -110, -100].map((v, i) => ({ band: `b${i}`, p5_db: v }));
    // sorted = [-130, -120, -110, -100]; q1 = index 1, q3 = index 3.
    assert.deepStrictEqual(floorStats(rows), { q1: -120, q3: -100 });
});

t('too few bands to rank is no ranking at all', () => {
    const rows = [-130, -100].map((v, i) => ({ band: `b${i}`, p5_db: v }));
    assert.strictEqual(floorStats(rows), null);
    assert.strictEqual(RANK_MIN_BANDS, 3);
    // …and an unranked floor is painted plain rather than green by default.
    assert.strictEqual(floorTone(-130, null), 'none');
});

t('lower is better: the quietest quarter is good, the noisiest is bad', () => {
    const stats = { q1: -120, q3: -100 };
    assert.strictEqual(floorTone(-130, stats), 'good');
    assert.strictEqual(floorTone(-120, stats), 'good');   // inclusive, as v1 is
    assert.strictEqual(floorTone(-110, stats), 'warn');
    assert.strictEqual(floorTone(-100, stats), 'warn');   // inclusive
    assert.strictEqual(floorTone(-90, stats), 'bad');
});

t('a band with no floor reading is not ranked', () => {
    assert.strictEqual(floorTone(undefined, { q1: -120, q3: -100 }), 'none');
    // …and it does not drag the quartiles either: three readings, not four.
    const rows = [{ p5_db: -130 }, { p5_db: null }, { p5_db: -120 }, { p5_db: -110 }];
    assert.deepStrictEqual(floorStats(rows), { q1: -130, q3: -110 });
});

// --- formatting -------------------------------------------------------------

t('a missing figure is a dash, not NaN', () => {
    assert.strictEqual(formatFigure(-118.34), '-118.3');
    assert.strictEqual(formatFigure(undefined), '—');
    assert.strictEqual(formatFigure(null), '—');
});

t('an unparseable timestamp is no time rather than a wrong one', () => {
    assert.strictEqual(measuredMs(m('20m')), Date.parse('2026-08-20T12:00:00Z'));
    assert.strictEqual(measuredMs(m('20m', { timestamp: 'not a date' })), null);
    assert.strictEqual(measuredMs(null), null);
});

// --- the once-a-minute rule -------------------------------------------------

async function withFetch(reply, fn) {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = (url) => {
        calls.push(url);
        return Promise.resolve(reply());
    };
    try { await fn(calls); } finally {
        global.fetch = realFetch;
        resetBandNoise();
        resetFeeds();
    }
}

const ok = () => ({ ok: true, status: 200, json: () => Promise.resolve({ '20m': m('20m') }) });

t('the poll is a minute', () => {
    assert.strictEqual(POLL_MS, 60000);
});

ta('nothing is fetched while the feeds gate is shut', () => withFetch(ok, async (calls) => {
    // A stopped receiver stops everything, this included.
    subscribeBandNoise(() => {});
    await settle();
    assert.strictEqual(calls.length, 0);
}));

ta('the first subscriber after the gate opens fetches once', () => withFetch(ok, async (calls) => {
    setFeedsAllowed(true);
    subscribeBandNoise(() => {});
    await settle();
    assert.deepStrictEqual(calls, ['/api/noisefloor/latest']);
}));

ta('opening and closing the panel does not re-fetch inside the minute', () => withFetch(ok, async (calls) => {
    // This is the rule. Each subscribe/unsubscribe pair is Section mounting and
    // unmounting the panel body; without the floor every one of them is a
    // request, and the panel looks identical either way.
    setFeedsAllowed(true);
    for (let i = 0; i < 20; i++) {
        subscribeBandNoise(() => {})();
        await settle();
    }
    assert.strictEqual(calls.length, 1);
}));

ta('a second panel on the same store does not double the poll', () => withFetch(ok, async (calls) => {
    setFeedsAllowed(true);
    const a = subscribeBandNoise(() => {});
    const b = subscribeBandNoise(() => {});
    await settle();
    assert.strictEqual(calls.length, 1);
    a(); b();
}));

ta('the answer outlives the panel, so a reopened one paints at once', () => withFetch(ok, async () => {
    setFeedsAllowed(true);
    subscribeBandNoise(() => {})();
    await settle();
    let seen = null;
    subscribeBandNoise((s) => { seen = s; })();
    assert.ok(seen.latest && seen.latest['20m'], 'the last reply should still be there');
}));

ta('204 is "not measured yet", not an error', () => withFetch(
    () => ({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) }),
    async () => {
        setFeedsAllowed(true);
        subscribeBandNoise(() => {});
        await settle();
        assert.deepStrictEqual(getBandNoise().latest, {});
        assert.strictEqual(getBandNoise().error, null);
    },
));

ta('a failed refresh keeps the last measurement and says so', () => withFetch(ok, async () => {
    setFeedsAllowed(true);
    subscribeBandNoise(() => {});
    await settle();
    // The floor makes a second request inside the minute impossible by design,
    // so the seam opens it while keeping what the first one returned — see
    // resetBandNoise. A minute-old set of noise floors is still worth reading;
    // what must not happen is the panel emptying because one poll missed.
    resetBandNoise({ keepState: true });
    global.fetch = () => Promise.resolve({ ok: false, status: 500 });
    subscribeBandNoise(() => {});
    await settle();
    assert.match(getBandNoise().error, /500/);
    assert.ok(getBandNoise().latest['20m'], 'the previous measurement should survive');
}));

ta('a 503 says the monitor is off rather than showing an HTTP code', () => withFetch(
    () => ({ ok: false, status: 503 }),
    async () => {
        setFeedsAllowed(true);
        subscribeBandNoise(() => {});
        await settle();
        assert.match(getBandNoise().error, /not enabled/);
        assert.strictEqual(getBandNoise().latest, null);
    },
));

(async () => {
    for (const [name, fn] of queued) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} passed`);
})();
