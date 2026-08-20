// The 24-hour chart's arithmetic, and the ten-minute rule behind it.
//
// Everything the chart draws is decided here — where a trace breaks, how tall
// the scale is, where the hour labels land — and none of it is visible in a
// screenshot: a line drawn straight across a six-hour outage looks exactly like
// a band whose noise floor drifted, and a scale fitted to a quiet night turns
// one decibel of measurement wobble into the full height of the picture.

const assert = require('assert');
const {
    BUCKET_MS, DEFAULT_METRIC, MAX_GAP_MS, METRICS, POLL_MS, TRENDS_URL, WINDOW_MS,
    clockAt, conditionRuns, conditionSeries, getNoiseTrend, hasTrend, hourTicks,
    levelTicks, metricByKey, nearest, niceRange, niceStep, resetNoiseTrend, saveMetric, savedMetric,
    seriesFor, setFeedsAllowed, resetFeeds, spans, subscribeNoiseTrend, trendFault,
} = require('./.build/noisetrend.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const settle = () => new Promise((r) => setImmediate(r));
const queued = [];
const ta = (name, fn) => queued.push([name, fn]);

const MIN = 60 * 1000;
const at = (minsAgo, over = {}) => ({
    timestamp: new Date(Date.now() - minsAgo * MIN).toISOString(),
    p5_db: -120, p95_db: -80, dynamic_range: 40, occupancy_pct: 10, ft8_snr: 15,
    ...over,
});

const floor = metricByKey('floor');
const snr = metricByKey('snr');

// --- the metrics ------------------------------------------------------------

t('the default metric is one of the metrics', () => {
    assert.ok(METRICS.some((m) => m.key === DEFAULT_METRIC));
    assert.strictEqual(metricByKey(DEFAULT_METRIC).key, DEFAULT_METRIC);
    // An unknown key is the first metric, not undefined — a stored preference
    // naming a metric that has since gone must not blank the chart.
    assert.strictEqual(metricByKey('nonsense').key, METRICS[0].key);
});

t('a remembered metric survives, and a stale one does not blank the chart', () => {
    const store = {};
    global.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
    };
    try {
        // Nothing stored yet.
        assert.strictEqual(savedMetric(), DEFAULT_METRIC);

        saveMetric('snr');
        assert.strictEqual(savedMetric(), 'snr');

        // A key from a version that had a metric this one does not.
        saveMetric('gone');
        assert.strictEqual(savedMetric(), METRICS[0].key);

        // And private mode, where every access throws.
        global.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        assert.strictEqual(savedMetric(), DEFAULT_METRIC);
        saveMetric('snr');
    } finally {
        delete global.localStorage;
    }
});

t('every metric names a field the API actually returns', () => {
    const fields = new Set(Object.keys(at(0)));
    for (const m of METRICS) assert.ok(fields.has(m.field), `${m.key} reads ${m.field}`);
});

// --- reading a reply --------------------------------------------------------

t('a band comes back oldest first, whatever order it arrived in', () => {
    const s = seriesFor({ '20m': [at(10), at(120), at(60)] }, '20m', floor);
    assert.strictEqual(s.length, 3);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].t > s[i - 1].t, 'out of order');
});

t('a point with no usable timestamp is dropped, not placed at zero', () => {
    const s = seriesFor({ '20m': [at(10), { timestamp: 'nonsense', p5_db: -100 }, null] }, '20m', floor);
    assert.strictEqual(s.length, 1);
});

t('a missing reading is a gap, not a zero', () => {
    const s = seriesFor({ '20m': [at(10), at(20, { p5_db: null }), at(30)] }, '20m', floor);
    assert.strictEqual(s.length, 2);
});

t('a zero FT8 SNR is a gap; a zero noise floor is a reading', () => {
    // The float32 is zero both when nothing was heard and when the pass has not
    // run, so plotting the zeroes would drag the trace to the axis every quiet
    // bucket. A noise floor of exactly 0 dB is absurd but it is a measurement,
    // and the metric that says so is the only one that drops it.
    const rows = { '20m': [at(10, { ft8_snr: 0, p5_db: 0 }), at(20, { ft8_snr: 12 })] };
    assert.strictEqual(seriesFor(rows, '20m', snr).length, 1);
    assert.strictEqual(seriesFor(rows, '20m', floor).length, 2);
});

t('a band with no history is empty rather than an error', () => {
    assert.deepStrictEqual(seriesFor(null, '20m', floor), []);
    assert.deepStrictEqual(seriesFor({}, '20m', floor), []);
    assert.strictEqual(hasTrend(null, '20m'), false);
    assert.strictEqual(hasTrend({ '20m': [] }, '20m'), false);
    assert.strictEqual(hasTrend({ '20m': [at(1)] }, '20m'), true);
    assert.strictEqual(hasTrend({ '20m': [at(1)] }, null), false);
});

// --- where a trace breaks ---------------------------------------------------

t('a run of buckets is one stretch', () => {
    const s = [0, 10, 20, 30].map((m) => ({ t: m * MIN, v: -120 }));
    assert.strictEqual(spans(s).length, 1);
});

t('an outage breaks the trace rather than being drawn through', () => {
    // A straight line across six hours off air says the noise floor slid
    // smoothly from one value to the other, which is the one thing it did not do.
    const s = [
        { t: 0, v: -120 }, { t: 10 * MIN, v: -120 },
        { t: 6 * 60 * MIN, v: -100 }, { t: 6 * 60 * MIN + 10 * MIN, v: -100 },
    ];
    const runs = spans(s);
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].length, 2);
    assert.strictEqual(runs[1].length, 2);
});

t('a single missed measurement is joined across, not broken at', () => {
    // Twenty minutes is one lost bucket in a recording, not an outage.
    const s = [{ t: 0, v: -120 }, { t: 20 * MIN, v: -119 }];
    assert.strictEqual(spans(s).length, 1);
    assert.ok(MAX_GAP_MS > 2 * BUCKET_MS && MAX_GAP_MS < 3 * BUCKET_MS);
});

t('nothing at all is no stretches, not one empty one', () => {
    assert.deepStrictEqual(spans([]), []);
});

// --- the condition strip ----------------------------------------------------

t('the strip keeps the quiet buckets, because that is half its point', () => {
    const s = conditionSeries({ '20m': [at(20, { ft8_snr: 0 }), at(10, { ft8_snr: 25 })] }, '20m');
    assert.deepStrictEqual(s.map((p) => p.tone), ['none', 'good']);
});

t('the strip uses the band keys\' buckets', () => {
    const tone = (v) => conditionSeries({ b: [at(1, { ft8_snr: v })] }, 'b')[0].tone;
    assert.strictEqual(tone(3), 'poor');
    assert.strictEqual(tone(10), 'fair');
    assert.strictEqual(tone(25), 'good');
    assert.strictEqual(tone(35), 'excellent');
});

t('neighbouring buckets of one condition are one run', () => {
    const s = [0, 10, 20].map((m) => ({ t: m * MIN, tone: 'good' }));
    const runs = conditionRuns(s);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].from, 0);
    // The last bucket is a bucket wide, not zero wide — a run that ended at its
    // final sample would be ten minutes short of what was measured.
    assert.strictEqual(runs[0].to, 20 * MIN + BUCKET_MS);
});

t('a change of condition starts a new run', () => {
    const s = [
        { t: 0, tone: 'good' }, { t: 10 * MIN, tone: 'good' },
        { t: 20 * MIN, tone: 'poor' },
    ];
    assert.deepStrictEqual(conditionRuns(s).map((r) => r.tone), ['good', 'poor']);
});

t('a run does not stretch across an outage', () => {
    // Same condition either side of six hours off air is two runs, not one
    // six-hour block claiming the band was good throughout.
    const s = [{ t: 0, tone: 'good' }, { t: 6 * 60 * MIN, tone: 'good' }];
    const runs = conditionRuns(s);
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].to, BUCKET_MS);
});

// --- the scales -------------------------------------------------------------

t('the step is one a person would have chosen', () => {
    assert.strictEqual(niceStep(0.9), 1);
    assert.strictEqual(niceStep(1.5), 2);
    assert.strictEqual(niceStep(4), 5);
    assert.strictEqual(niceStep(7), 10);
    assert.strictEqual(niceStep(23), 50);
    assert.strictEqual(niceStep(0), 1);
});

t('a scale contains its readings', () => {
    const r = niceRange([{ v: -128 }, { v: -104 }, { v: -119 }]);
    assert.ok(r.min <= -128, `min ${r.min}`);
    assert.ok(r.max >= -104, `max ${r.max}`);
});

t('a flat night is not magnified into a mountain range', () => {
    // One decibel of wobble fitted to the full height reads as an event on the
    // band rather than as the measurement it is.
    const r = niceRange([{ v: -120.2 }, { v: -119.8 }]);
    assert.ok(r.max - r.min >= 6, `span ${r.max - r.min}`);
});

t('a scale lands on round numbers, so its labels are readable', () => {
    const r = niceRange([{ v: -128 }, { v: -104 }]);
    // Math.abs, because a negative multiple of the step gives -0 and dB
    // readings are all negative.
    assert.ok(Math.abs(r.min % r.step) < 1e-9, `${r.min} is not a multiple of ${r.step}`);
    assert.ok(Math.abs(r.max % r.step) < 1e-9, `${r.max} is not a multiple of ${r.step}`);
});

t('no readings is no scale, rather than a scale of nothing', () => {
    assert.strictEqual(niceRange([]), null);
    assert.strictEqual(niceRange(null), null);
    assert.deepStrictEqual(levelTicks(null), []);
});

t('the grid lines run from the bottom of the scale to the top', () => {
    const r = { min: -130, max: -100, step: 10 };
    assert.deepStrictEqual(levelTicks(r), [-130, -120, -110, -100]);
});

t('the grid lines reach the top even when the step is fractional', () => {
    // Accumulating a float step drops the last line; counting does not.
    const ticks = levelTicks({ min: 0, max: 3, step: 0.1 });
    assert.strictEqual(ticks.length, 31);
    assert.ok(Math.abs(ticks[ticks.length - 1] - 3) < 1e-9);
});

// --- the time axis ----------------------------------------------------------

t('the labels are on the hour, and there are not too many', () => {
    const to = Date.now();
    const ticks = hourTicks(to - WINDOW_MS, to, 5);
    assert.ok(ticks.length > 0 && ticks.length <= 6, `${ticks.length} labels`);
    for (const tick of ticks) {
        const d = new Date(tick.t);
        assert.strictEqual(d.getMinutes(), 0);
        assert.strictEqual(d.getSeconds(), 0);
        assert.match(tick.label, /^\d\d:00$/);
    }
});

t('the labels are evenly spaced, and on a round multiple of the step', () => {
    const to = Date.now();
    const ticks = hourTicks(to - WINDOW_MS, to, 5);
    const stepH = new Date(ticks[1].t).getHours() - new Date(ticks[0].t).getHours();
    const step = ((stepH % 24) + 24) % 24;
    for (const tick of ticks) assert.strictEqual(new Date(tick.t).getHours() % step, 0);
});

t('a narrow window gets more labels, not the same five spread out', () => {
    const to = Date.now();
    const wide = hourTicks(to - WINDOW_MS, to, 5).length;
    const narrow = hourTicks(to - 6 * 60 * 60 * 1000, to, 5).length;
    assert.ok(narrow >= wide - 1, `${narrow} vs ${wide}`);
});

t('a window that is not one is no labels, not a hang', () => {
    const now = Date.now();
    assert.deepStrictEqual(hourTicks(now, now), []);
    assert.deepStrictEqual(hourTicks(now, now - 1000), []);
});

t('a moment reads as a clock', () => {
    assert.match(clockAt(Date.now()), /^\d\d:\d\d$/);
});

// --- the hover --------------------------------------------------------------

t('the hover finds the nearest reading, on either side', () => {
    const s = [{ t: 0, v: 1 }, { t: 100, v: 2 }, { t: 200, v: 3 }];
    assert.strictEqual(nearest(s, 0).v, 1);
    assert.strictEqual(nearest(s, 60).v, 2);
    assert.strictEqual(nearest(s, 140).v, 2);
    assert.strictEqual(nearest(s, 1e9).v, 3);
    assert.strictEqual(nearest([], 0), null);
});

// --- what a 404 means -------------------------------------------------------

t('a receiver with no database is told apart from one with no history yet', () => {
    // The endpoint returns 404 for both. Only the body says which, and an
    // operator waiting for history that will never come is the failure here.
    assert.match(trendFault({ error: 'Failed to get trend data: noise floor historical data is not available (database not configured)' }), /does not store history/);
    assert.match(trendFault({ error: 'Failed to get trend data: no data available' }), /No history recorded yet/);
    assert.match(trendFault(null), /No history recorded yet/);
});

// --- the ten-minute rule ----------------------------------------------------

async function withFetch(reply, fn) {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = (url) => {
        calls.push(url);
        return Promise.resolve(reply());
    };
    try { await fn(calls); } finally {
        global.fetch = realFetch;
        resetNoiseTrend();
        resetFeeds();
    }
}

const ok = () => ({ ok: true, status: 200, json: () => Promise.resolve({ '20m': [at(10)] }) });

t('the poll is the server\'s averaging bucket', () => {
    // Anything faster returns the same array: the server averages into
    // ten-minute buckets.
    assert.strictEqual(POLL_MS, BUCKET_MS);
    assert.strictEqual(BUCKET_MS, 10 * 60 * 1000);
    assert.strictEqual(WINDOW_MS, 24 * 60 * 60 * 1000);
});

ta('nothing is fetched while the feeds gate is shut', () => withFetch(ok, async (calls) => {
    subscribeNoiseTrend(() => {});
    await settle();
    assert.strictEqual(calls.length, 0);
}));

ta('one request covers every band, so changing band costs nothing', () => withFetch(ok, async (calls) => {
    setFeedsAllowed(true);
    subscribeNoiseTrend(() => {});
    await settle();
    // No band and no date in the URL: /trends is the whole receiver over a
    // rolling 24 hours, which is why the panel can switch band without asking
    // for anything.
    assert.deepStrictEqual(calls, [TRENDS_URL]);
    assert.ok(!/[?&]band=/.test(calls[0]));
    assert.ok(!/[?&]date=/.test(calls[0]));
}));

ta('opening and closing the panel does not re-fetch inside the ten minutes', () => withFetch(ok, async (calls) => {
    setFeedsAllowed(true);
    for (let i = 0; i < 20; i++) {
        subscribeNoiseTrend(() => {})();
        await settle();
    }
    assert.strictEqual(calls.length, 1);
}));

ta('204 is an empty chart, not an error', () => withFetch(
    () => ({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) }),
    async () => {
        setFeedsAllowed(true);
        subscribeNoiseTrend(() => {});
        await settle();
        assert.deepStrictEqual(getNoiseTrend().trends, {});
        assert.strictEqual(getNoiseTrend().error, null);
    },
));

ta('a 404 is explained rather than passed on as a status', () => withFetch(
    () => ({ ok: false, status: 404, json: () => Promise.resolve({ error: 'no data available' }) }),
    async () => {
        setFeedsAllowed(true);
        subscribeNoiseTrend(() => {});
        await settle();
        assert.deepStrictEqual(getNoiseTrend().trends, {});
        assert.match(getNoiseTrend().error, /No history recorded yet/);
    },
));

ta('a 404 with no readable body still says something useful', () => withFetch(
    () => ({ ok: false, status: 404, json: () => Promise.reject(new Error('not json')) }),
    async () => {
        setFeedsAllowed(true);
        subscribeNoiseTrend(() => {});
        await settle();
        assert.match(getNoiseTrend().error, /No history recorded yet/);
    },
));

ta('a failed refresh keeps the day already on screen', () => withFetch(ok, async () => {
    setFeedsAllowed(true);
    subscribeNoiseTrend(() => {});
    await settle();
    // The floor makes a second request inside the window impossible by design,
    // so the seam opens it while keeping what the first one returned.
    resetNoiseTrend({ keepState: true });
    global.fetch = () => Promise.resolve({ ok: false, status: 500 });
    subscribeNoiseTrend(() => {});
    await settle();
    assert.match(getNoiseTrend().error, /500/);
    assert.ok(getNoiseTrend().trends['20m'], 'a day of history should survive one bad poll');
}));

(async () => {
    for (const [name, fn] of queued) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} passed`);
})();
