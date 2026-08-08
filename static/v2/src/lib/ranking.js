// Where this receiver stands in the leaderboards it reports into.
//
// Three networks, and a receiver may feed any, all or none of them:
//
//   PSK Reporter   digital spots, ranked two ways — how many reports this
//                  receiver filed, and how many distinct countries it heard.
//   WSPR Live      unique WSPR spots, in three windows (rolling 24 h, yesterday,
//                  today). The three disagree in a way that is the point: today
//                  against yesterday is whether the day is going better or worse
//                  than the last one, at the same hour.
//   RBN            CW spots from the skimmer, ranked by cumulative count. RBN
//                  publishes no rank of its own; the server derives it from the
//                  statistics file it fetches.
//
// One request serves all of it — /api/stats/rank-summary, which the server builds
// from the caches its own fetchers keep, so there is no database query and no
// outbound request behind it. Every section carries its own timestamp and its own
// `available` flag, which is how "some or none enabled" is answered: the panel
// draws the sections that say they are there and does not mention the rest.
//
// ── Trends, and what each network can afford ─────────────────────────────────
//
// A standing on its own says where you are, not whether you are going anywhere,
// and each of the three answers that differently:
//
//   WSPR   free. The summary already carries today and yesterday as separate
//          windows, so the direction is a subtraction — see dayTrend.
//   PSK    free. The description's `pskreporter_rank` carries `day` and `week`
//          for every band including "All", so today's pace against the week's
//          daily average needs no request at all — see pace.
//   RBN    one small request. RBN publishes a cumulative spot count, so nothing
//          in the summary can say which way it is going; but the history
//          endpoint filtered to one callsign is a week in about a kilobyte,
//          because RBN snapshots daily rather than hourly — see RBN_HISTORY_URL.
//
// The other two history endpoints are deliberately not used. Filtered to this
// callsign they are still 39 kB for a day of PSK and 190 kB for a week of WSPR,
// because both return every band's table per snapshot. That is a page of its
// own, not a panel that polls.

export const SUMMARY_URL = '/api/stats/rank-summary';

/** A week of daily RBN snapshots for one skimmer — about a kilobyte. */
export const RBN_HISTORY_URL = (callsign) =>
    `/api/stats/rbn?period=7d&callsign=${encodeURIComponent(String(callsign || ''))}`;

/**
 * Whether this receiver reports into any leaderboard at all.
 *
 * From `rank_sources` in /api/description — see BuildRankSources in
 * stats_rank_summary.go. It exists because nothing else in the description could
 * answer this: PSK can be inferred from `pskreporter_rank` and RBN from the CW
 * skimmer callsign, but there was no way whatever to tell whether WSPR ranking
 * was on, so a gate built from what was already there would have hidden the panel
 * on a WSPR-only receiver.
 *
 * Absent means yes. An older server sends no `rank_sources`, and hiding the panel
 * on every receiver that has not been updated would be a worse failure than
 * showing one that says it has nothing to report — which is what it does when the
 * summary comes back empty.
 */
export function rankingAvailable(serverInfo) {
    const src = serverInfo && serverInfo.rank_sources;
    if (!src || typeof src !== 'object') return true;
    // `any` is the server's own summary of the three. Read in preference to
    // or-ing the flags so that a network added there later needs no change here.
    if (typeof src.any === 'boolean') return src.any;
    return !!(src.psk || src.wspr || src.rbn);
}

// Fifteen minutes. The server's own fetchers run hourly at best, so anything
// faster is asking a cache the same question several times for one answer — and
// this is a standings table, which is not a thing anybody watches tick.
export const POLL_MS = 15 * 60 * 1000;

/** A position that says nothing — not ranked, or the dataset is not in yet. */
const EMPTY = { rank: 0, value: 0, total: 0 };

function position(raw) {
    if (!raw || typeof raw !== 'object') return { ...EMPTY };
    const rank = Number(raw.rank);
    const value = Number(raw.value);
    const total = Number(raw.total);
    return {
        rank: Number.isFinite(rank) && rank > 0 ? rank : 0,
        value: Number.isFinite(value) ? value : 0,
        total: Number.isFinite(total) && total > 0 ? total : 0,
    };
}

/** Whether a position is worth drawing at all. */
export const ranked = (p) => !!p && p.rank > 0;

const time = (s) => {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? t : 0;
};

/**
 * The summary in the shape the panel uses: three sections, each knowing whether
 * it is there and when it was last true.
 *
 * A section is only `available` if the server said so *and* it produced a rank.
 * The server reports PSK as available the moment a fetch succeeds, including one
 * that found this callsign nowhere in the table — which is a real state, but an
 * empty section headed "PSK Reporter" reads as a fault rather than as "not in
 * the top fifty", so the panel says the latter in words instead.
 */
export function parseSummary(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const psk = d.psk || {};
    const wspr = d.wspr || {};
    const rbn = d.rbn || {};
    return {
        at: time(d.generated_at),
        callsign: String(d.receiver_callsign || '').toUpperCase(),
        cwCallsign: String(d.cw_skimmer_callsign || '').toUpperCase(),
        psk: {
            available: !!psk.available,
            at: time(psk.fetched_at),
            error: String(psk.error || ''),
            reports: position(psk.reports),
            countries: position(psk.countries),
        },
        wspr: {
            available: !!wspr.available,
            at: time(wspr.generated_at),
            rolling24h: position(wspr.rolling_24h),
            yesterday: position(wspr.yesterday),
            today: position(wspr.today),
        },
        rbn: {
            available: !!rbn.available,
            at: time(rbn.updated_at),
            spots: position(rbn.spots),
        },
    };
}

/** Whether there is anything at all to show. */
export function anyAvailable(s) {
    return !!s && (s.psk.available || s.wspr.available || s.rbn.available);
}

/**
 * How near the top, 0..1, where 1 is first place.
 *
 * The leaderboards are wildly different sizes — PSK publishes a top fifty, RBN
 * ranks a couple of hundred skimmers — so a bare rank compares nothing across
 * them. This is what makes one bar mean the same thing in all three rows.
 *
 * First place is 1 and last place is above 0 rather than 0: a station that is
 * on the board at all has done better than one that is not, and a bar of no
 * width says the opposite.
 */
export function standing(p) {
    if (!ranked(p) || !p.total) return 0;
    return (p.total - p.rank + 1) / p.total;
}

/**
 * The tone for a standing, on the same three-step scale the rest of the
 * interface uses for quality. Top decile is good, top half is warn, the rest is
 * plain — deliberately not `bad`, because being 180th of 225 skimmers is not a
 * fault, it is a smaller aerial.
 */
export function rankTone(p) {
    const s = standing(p);
    if (!s) return '';
    if (s >= 0.9) return 'good';
    if (s >= 0.5) return 'warn';
    return '';
}

/** "4th of 50", or "unranked" — the sentence under every bar. */
export function rankLabel(p) {
    if (!ranked(p)) return 'unranked';
    return `${ordinal(p.rank)} of ${p.total}`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n) {
    const v = Math.round(Number(n) || 0);
    if (v <= 0) return '—';
    const two = v % 100;
    if (two >= 11 && two <= 13) return `${v}th`;
    switch (v % 10) {
        case 1: return `${v}st`;
        case 2: return `${v}nd`;
        case 3: return `${v}rd`;
        default: return `${v}th`;
    }
}

/**
 * Big counts, short. 98512 → "98.5k", 4232 → "4232".
 *
 * Four figures stay whole because that is a count somebody may want exactly —
 * "4232 spots" is a fact about the day. Beyond that the exact digit stops
 * meaning anything and the width starts to cost a column.
 */
export function shortCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) < 10000) return String(Math.round(v));
    if (Math.abs(v) < 1e6) return `${(v / 1000).toFixed(1)}k`;
    return `${(v / 1e6).toFixed(2)}M`;
}

/**
 * Today against yesterday, as WSPR Live's own two windows.
 *
 * Only the ranks are compared, never the counts: "today" is a partial day, so
 * its spot count is always behind yesterday's and a count comparison would
 * report a collapse every morning. Rank is already relative to everybody else's
 * partial day, which is exactly the comparison worth making.
 *
 * @returns {{dir: -1|0|1, places: number}|null} null when either day is unranked.
 *          `dir` is +1 for climbing — a *smaller* rank number.
 */
export function dayTrend(wspr) {
    if (!wspr || !ranked(wspr.today) || !ranked(wspr.yesterday)) return null;
    const places = wspr.yesterday.rank - wspr.today.rank;
    return { dir: Math.sign(places), places: Math.abs(places) };
}

/**
 * Today's pace against the week's daily average, for an *additive* count.
 *
 * PSK publishes `day` and `week` for every table, so a receiver filing 98.5k
 * reports today against 593k over the week is running 16% above its own recent
 * average — which is a trend, and it costs nothing to know.
 *
 * Only ever valid for counts that add up. See pskCoverage for why the countries
 * table needs a different question entirely.
 *
 * Under a full week of data the average is understated and everything looks like
 * a record, so a week that is not clearly a multiple of the day is refused.
 *
 * @returns {{dir: -1|0|1, pct: number}|null} pct is the signed percentage away
 *          from the average; `dir` is 0 inside a ±5% dead band, because a
 *          leaderboard that reported a direction every 2% would be noise.
 */
export function pace(day, week) {
    const d = Number(day);
    const w = Number(week);
    if (!Number.isFinite(d) || !Number.isFinite(w) || d <= 0 || w <= 0) return null;
    const avg = w / 7;
    // A week that is not at least a couple of days of this rate has not got a
    // meaningful average in it yet.
    if (avg <= 0 || w < d * 2) return null;
    const pct = Math.round(((d - avg) / avg) * 100);
    return { dir: Math.abs(pct) < 5 ? 0 : Math.sign(pct), pct };
}

/**
 * How much of the week's DXCC this receiver heard today, 0..1.
 *
 * The countries table cannot use `pace`: countries are distinct, not additive,
 * so the week's 223 is not seven days of the day's 183 and the ratio would read
 * as a 600% collapse. What *is* true and worth saying is the share — 183 of the
 * 223 entities heard all week were heard today, which is a real statement about
 * how good a day it is.
 *
 * @returns {number|null} null when there is nothing to compare.
 */
export function pskCoverage(day, week) {
    const d = Number(day);
    const w = Number(week);
    if (!Number.isFinite(d) || !Number.isFinite(w) || w <= 0 || d <= 0) return null;
    return Math.min(1, d / w);
}

/**
 * The cross-band totals for one PSK table, straight from the description — the
 * `day` and `week` the trend needs, which the summary does not carry.
 *
 * @returns {{rank: number, day: number, week: number}|null}
 */
export function pskAllRank(serverInfo, table = 'reports') {
    const src = serverInfo && serverInfo.pskreporter_rank;
    const all = src && src[table] && src[table].All;
    if (!all) return null;
    return {
        rank: Number(all.rank) || 0,
        day: Number(all.day) || 0,
        week: Number(all.week) || 0,
    };
}

// ─── RBN, over a week ────────────────────────────────────────────────────────

/**
 * The daily rank points out of /api/stats/rbn, oldest first.
 *
 * Snapshots without this callsign in them are skipped by the server, so a
 * skimmer that came online midweek gives fewer than seven points rather than a
 * run of zeroes.
 *
 * @returns {Array<{at: number, rank: number, spots: number, total: number}>}
 */
export function parseRbnHistory(raw) {
    const snaps = (raw && raw.snapshots) || [];
    const out = [];
    for (const snap of snaps) {
        const d = snap && snap.callsign_data;
        const rank = Number(d && d.stats_rank);
        if (!Number.isFinite(rank) || rank <= 0) continue;
        out.push({
            at: time(snap.fetched_at),
            rank,
            spots: Number(d.statistics && d.statistics.spot_count) || 0,
            total: Number(d.stats_total_skimmers) || 0,
        });
    }
    return out.sort((a, b) => a.at - b.at);
}

/**
 * Which way a run of ranks is going: the oldest against the newest.
 *
 * Ends rather than a fitted line, deliberately. Seven points is not enough for a
 * regression to say anything a subtraction does not, and "13th a week ago, 14th
 * now" is the sentence somebody actually wants.
 *
 * @returns {{dir: -1|0|1, places: number, from: number, to: number}|null}
 */
export function rankTrend(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const from = points[0].rank;
    const to = points[points.length - 1].rank;
    const places = from - to;          // smaller rank number is better
    return { dir: Math.sign(places), places: Math.abs(places), from, to };
}

// ─── PSK per band, from serverInfo ───────────────────────────────────────────

/**
 * The bands this receiver ranks best on, from `pskreporter_rank` in the
 * description — already fetched, so this costs nothing.
 *
 * "All" is dropped: it is the headline the summary already carries, and leaving
 * it in would put the same number twice on one row and always at the front.
 *
 * @param {object} serverInfo
 * @param {'reports'|'countries'} table
 * @param {number} max how many to keep, best rank first
 * @returns {Array<{band: string, rank: number, day: number}>}
 */
export function pskBandRanks(serverInfo, table = 'reports', max = 4) {
    const src = serverInfo && serverInfo.pskreporter_rank;
    const bands = src && src[table];
    if (!bands || typeof bands !== 'object') return [];
    const out = [];
    for (const [band, v] of Object.entries(bands)) {
        if (band === 'All' || !v) continue;
        const rank = Number(v.rank);
        if (!Number.isFinite(rank) || rank <= 0) continue;
        out.push({ band, rank, day: Number(v.day) || 0 });
    }
    // Best rank first, and a tie broken by the busier band — of two 3rd places,
    // the one with ten times the reports is the more substantial.
    out.sort((a, b) => (a.rank - b.rank) || (b.day - a.day));
    return out.slice(0, max);
}
