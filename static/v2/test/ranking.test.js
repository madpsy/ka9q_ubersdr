// Leaderboard standings: PSK Reporter, WSPR Live and the RBN.
//
// The sample is a real /api/stats/rank-summary body, so the field names here are
// the server's rather than a guess at them — the shapes come from
// stats_rank_summary.go and the numbers from a receiver feeding all three.
//
// The two things worth pinning are the ones that are easy to get subtly wrong:
// comparing across boards of wildly different sizes, and comparing a partial day
// against a whole one.

const assert = require('assert');
const {
    RBN_HISTORY_URL, anyAvailable, dayTrend, ordinal, pace, parseRbnHistory, parseSummary,
    pskAllRank, pskBandRanks, pskCoverage, rankLabel, rankTone, rankTrend, ranked,
    rankingAvailable, shortCount, standing,
} = require('./.build/ranking.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const LIVE = {
    generated_at: '2026-08-08T12:56:13.368868643Z',
    receiver_callsign: 'M9PSY',
    cw_skimmer_callsign: 'MM9PSY',
    psk: {
        available: true,
        fetched_at: '2026-08-08T12:49:34.665366997Z',
        reports: { rank: 4, value: 98512, total: 50 },
        countries: { rank: 3, value: 183, total: 50 },
    },
    wspr: {
        available: true,
        generated_at: '2026-08-08T12:49:34.821425588Z',
        rolling_24h: { rank: 39, value: 1517, total: 200 },
        yesterday: { rank: 36, value: 1514, total: 200 },
        today: { rank: 45, value: 1119, total: 200 },
    },
    rbn: {
        available: true,
        updated_at: '2026-08-08T01:00:00.317495749Z',
        spots: { rank: 14, value: 4232, total: 225 },
    },
};

// --- reading the summary ----------------------------------------------------

t('a live summary comes through with both callsigns and all three sections', () => {
    const s = parseSummary(LIVE);
    assert.strictEqual(s.callsign, 'M9PSY');
    // Often the same station under a different suffix, which is why the panel
    // names it rather than assuming the one above.
    assert.strictEqual(s.cwCallsign, 'MM9PSY');
    assert.ok(s.psk.available && s.wspr.available && s.rbn.available);
    assert.strictEqual(s.psk.reports.rank, 4);
    assert.strictEqual(s.rbn.spots.value, 4232);
    assert.ok(s.wspr.at > 0, 'timestamps become milliseconds');
});

t('a receiver reporting to nothing is a state, not a failure', () => {
    const s = parseSummary({ generated_at: '2026-08-08T12:00:00Z' });
    assert.strictEqual(anyAvailable(s), false);
    // And the sections are still shaped, so nothing downstream has to null-check.
    assert.strictEqual(s.psk.reports.rank, 0);
    assert.strictEqual(ranked(s.psk.reports), false);
});

t('one network enabled is enough to draw the panel', () => {
    const s = parseSummary({ ...LIVE, psk: { available: false }, wspr: { available: false } });
    assert.strictEqual(anyAvailable(s), true);
    assert.strictEqual(s.rbn.available, true);
});

t('nonsense in the body does not become NaN on the screen', () => {
    const s = parseSummary({ psk: { available: true, reports: { rank: 'x', value: null, total: -3 } } });
    assert.deepStrictEqual(s.psk.reports, { rank: 0, value: 0, total: 0 });
    assert.strictEqual(rankLabel(s.psk.reports), 'unranked');
});

// --- comparing across boards of different sizes -----------------------------

t('standing compares boards a bare rank cannot', () => {
    const s = parseSummary(LIVE);
    // 4th of 50 against 14th of 225: the lower rank number is the *worse*
    // placing here, which is the whole reason the bar is not drawn from rank.
    assert.ok(standing(s.rbn.spots) > standing(s.psk.reports),
        '14th of 225 is nearer the top than 4th of 50');
});

t('first place is full and last place is not empty', () => {
    assert.strictEqual(standing({ rank: 1, total: 50 }), 1);
    // Being on the board at all beats not being on it, and a bar of no width
    // would say the opposite.
    assert.ok(standing({ rank: 50, total: 50 }) > 0);
    assert.strictEqual(standing({ rank: 0, total: 50 }), 0);
});

t('the tone is about being near the top, and never blames a small aerial', () => {
    assert.strictEqual(rankTone({ rank: 1, total: 50 }), 'good');
    assert.strictEqual(rankTone({ rank: 20, total: 50 }), 'warn');
    // 180th of 225 is a smaller aerial, not a fault, so there is no 'bad' tone.
    assert.strictEqual(rankTone({ rank: 180, total: 225 }), '');
    assert.strictEqual(rankTone({ rank: 0, total: 0 }), '');
});

// --- today against yesterday ------------------------------------------------

t('the day trend is read from ranks, not from counts', () => {
    const s = parseSummary(LIVE);
    // Today has 1119 spots against yesterday's 1514 — a count comparison would
    // report a collapse, because today is a partial day. By rank, 45th against
    // 36th, it is nine places down, which is the honest reading.
    const d = dayTrend(s.wspr);
    assert.deepStrictEqual(d, { dir: -1, places: 9 });
});

t('climbing is a smaller rank number', () => {
    const up = dayTrend({ today: { rank: 30, total: 200 }, yesterday: { rank: 36, total: 200 } });
    assert.deepStrictEqual(up, { dir: 1, places: 6 });
});

t('no trend without both days, rather than a trend against zero', () => {
    assert.strictEqual(dayTrend({ today: { rank: 30, total: 200 }, yesterday: { rank: 0, total: 200 } }), null);
    assert.strictEqual(dayTrend(null), null);
});

// --- presentation -----------------------------------------------------------

t('ordinals are English, including the teens', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal),
        ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    assert.strictEqual(ordinal(0), '—');
});

t('a count somebody might want exactly stays exact', () => {
    assert.strictEqual(shortCount(4232), '4232');
    assert.strictEqual(shortCount(98512), '98.5k');
    assert.strictEqual(shortCount(1234567), '1.23M');
    assert.strictEqual(shortCount(undefined), '—');
});

t('the rank label carries the scale, because the rank alone does not', () => {
    assert.strictEqual(rankLabel({ rank: 14, total: 225 }), '14th of 225');
});

// --- the per-band detail, which costs no request ----------------------------

t('the best bands come from the description, best rank first', () => {
    const serverInfo = {
        pskreporter_rank: {
            reports: {
                All: { rank: 3, day: 109439 },
                '40m': { rank: 1, day: 19123 },
                '30m': { rank: 1, day: 11937 },
                '20m': { rank: 7, day: 31260 },
                '10m': { rank: 43, day: 2227 },
            },
        },
    };
    const best = pskBandRanks(serverInfo, 'reports', 3);
    // "All" is the headline the summary already carries; repeating it here would
    // put the same number twice on one row, always at the front.
    assert.deepStrictEqual(best.map((b) => b.band), ['40m', '30m', '20m']);
    // Two 1st places, and the busier band goes first.
    assert.strictEqual(best[0].day, 19123);
});

t('no description, no band row — rather than an empty one', () => {
    assert.deepStrictEqual(pskBandRanks(null), []);
    assert.deepStrictEqual(pskBandRanks({}, 'countries'), []);
    assert.deepStrictEqual(pskBandRanks({ pskreporter_rank: { reports: { All: { rank: 3 } } } }), []);
});

// --- trends, one per network ------------------------------------------------
//
// Each of the three is computed from something different, and each has a way of
// being wrong that looks plausible on screen.

// PSK: today's count against the week's daily average. Real figures from the
// description — 98512 today, 593159 over the week.
t('PSK pace compares today against the week\'s daily average', () => {
    const p = pace(98512, 593159);
    // 593159/7 = 84737, so today is running about 16% hot.
    assert.strictEqual(p.dir, 1);
    assert.strictEqual(p.pct, 16);
});

t('a quiet day reads as below the average, not as a fault', () => {
    const p = pace(50000, 593159);
    assert.strictEqual(p.dir, -1);
    assert.ok(p.pct < 0);
});

t('a small wobble is not a direction', () => {
    // 84737 is exactly the average; a leaderboard that called 2% a trend would
    // report a new direction every quarter of an hour.
    const p = pace(85000, 593159);
    assert.strictEqual(p.dir, 0);
});

t('a week too short to hold an average gives no pace at all', () => {
    // A receiver that started reporting today has week ≈ day, and dividing that
    // by seven would claim it is running 600% hot.
    assert.strictEqual(pace(98512, 98512), null);
    assert.strictEqual(pace(0, 593159), null);
    assert.strictEqual(pace(98512, 0), null);
});

t('countries use coverage, because distinct counts do not add up', () => {
    // 183 heard today of the 223 heard all week. Running this through pace would
    // read as a 480% collapse, which is why the countries table has its own
    // question.
    assert.strictEqual(Math.round(pskCoverage(183, 223) * 100), 82);
    assert.strictEqual(pskCoverage(0, 223), null);
    assert.strictEqual(pskCoverage(183, 0), null);
});

t('the cross-band totals come from the description, day and week both', () => {
    const serverInfo = { pskreporter_rank: { reports: { All: { rank: 4, day: 98512, week: 593159 } } } };
    assert.deepStrictEqual(pskAllRank(serverInfo, 'reports'), { rank: 4, day: 98512, week: 593159 });
    assert.strictEqual(pskAllRank(serverInfo, 'countries'), null);
    assert.strictEqual(pskAllRank(null), null);
});

// RBN: a week of daily snapshots, which is the only way to know — the count it
// ranks on is cumulative, so it only ever goes up.
const rbnSnap = (day, rank, spots) => ({
    fetched_at: `2026-08-0${day}T17:59:20Z`,
    callsign_data: {
        statistics: { callsign: 'MM9PSY', spot_count: spots },
        stats_rank: rank,
        stats_total_skimmers: 229,
    },
});

t('RBN history becomes daily rank points, oldest first', () => {
    const pts = parseRbnHistory({ snapshots: [rbnSnap(4, 14, 20000), rbnSnap(2, 13, 18692)] });
    assert.deepStrictEqual(pts.map((p) => p.rank), [13, 14]);
    assert.strictEqual(pts[0].spots, 18692);
    assert.strictEqual(pts[1].total, 229);
});

t('a skimmer missing from a snapshot is skipped, not counted as unranked', () => {
    // The server omits snapshots the callsign is not in; a zero rank sneaking
    // through would draw a cliff on a skimmer that simply came online midweek.
    const pts = parseRbnHistory({
        snapshots: [rbnSnap(2, 13, 18692), { fetched_at: '2026-08-03T00:00:00Z' }, rbnSnap(4, 14, 20000)],
    });
    assert.strictEqual(pts.length, 2);
});

t('the RBN trend is the ends of the week, and climbing is a smaller number', () => {
    const down = rankTrend(parseRbnHistory({ snapshots: [rbnSnap(2, 13, 1), rbnSnap(4, 14, 2)] }));
    assert.deepStrictEqual(down, { dir: -1, places: 1, from: 13, to: 14 });
    const up = rankTrend(parseRbnHistory({ snapshots: [rbnSnap(2, 20, 1), rbnSnap(4, 14, 2)] }));
    assert.deepStrictEqual(up, { dir: 1, places: 6, from: 20, to: 14 });
});

t('one point is a standing, not a trend', () => {
    assert.strictEqual(rankTrend(parseRbnHistory({ snapshots: [rbnSnap(2, 13, 1)] })), null);
    assert.strictEqual(rankTrend([]), null);
    assert.strictEqual(rankTrend(null), null);
});

t('the RBN history is asked for by the skimmer callsign, url-safe', () => {
    assert.strictEqual(RBN_HISTORY_URL('MM9PSY'), '/api/stats/rbn?period=7d&callsign=MM9PSY');
    assert.ok(RBN_HISTORY_URL('A/B').includes('A%2FB'));
});

// --- whether the panel exists at all ----------------------------------------

t('a receiver reporting to nothing loses the panel', () => {
    assert.strictEqual(rankingAvailable({ rank_sources: { psk: false, wspr: false, rbn: false, any: false } }), false);
});

t('any one network is enough to keep it', () => {
    // WSPR in particular: it is the one the description could never have been
    // made to answer by inference, and the reason rank_sources exists.
    assert.strictEqual(rankingAvailable({ rank_sources: { psk: false, wspr: true, rbn: false, any: true } }), true);
    assert.strictEqual(rankingAvailable({ rank_sources: { psk: true, wspr: false, rbn: false, any: true } }), true);
    assert.strictEqual(rankingAvailable({ rank_sources: { psk: false, wspr: false, rbn: true, any: true } }), true);
});

t('an older server, which sends no rank_sources, keeps the panel', () => {
    // Failing open. Hiding the panel on every receiver that has not been updated
    // is a worse failure than showing one that says it has nothing to report.
    assert.strictEqual(rankingAvailable({}), true);
    assert.strictEqual(rankingAvailable(null), true);
    assert.strictEqual(rankingAvailable({ rank_sources: null }), true);
});

t('a server naming a network this client has never heard of keeps the panel', () => {
    // `any` is the server's own summary, read in preference to or-ing the three
    // flags, so a fourth leaderboard added there needs no change here.
    assert.strictEqual(rankingAvailable({ rank_sources: { psk: false, wspr: false, rbn: false, any: true } }), true);
});

console.log(`\n${pass} passed`);
