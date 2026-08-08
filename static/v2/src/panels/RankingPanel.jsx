// Where this receiver stands in the leaderboards it reports into.
//
// A receiving station is a thing you improve — a better aerial, a quieter shack,
// a bandplan tuned to what actually gets heard — and the networks it feeds are
// the only outside opinion on whether any of it worked. PSK Reporter, WSPR Live
// and the Reverse Beacon Network each publish a table this receiver is somewhere
// in; this is that answer, in one place, without leaving for three websites.
//
// Every fifteen minutes: one request to /api/stats/rank-summary, and a second to
// /api/stats/rbn only where there is an RBN standing to put a trend on. See
// lib/ranking.js for where each trend comes from, and why the PSK and WSPR history
// endpoints are deliberately not among them.
//
// All three sections carry a direction as well as a placing, because a standing on
// its own says where you are and not whether anything you changed helped.
//
// Three networks, and this receiver may feed any, all or none of them: each
// section is drawn only where the server reports it as available, and a receiver
// that feeds nothing says so once rather than showing three empty tables.
//
// The rows are all the same shape on purpose — a bar, a rank and a count — even
// though the three networks rank on quite different things. `standing` is what
// makes the bar comparable: the boards are different sizes, so a bare rank of 14
// means nothing next to a rank of 4 until you know one board has 225 stations on
// it and the other has 50.
//
// `minimal` drops the per-band detail, the yesterday row and the footnotes, and
// keeps every headline row and every trend — the placings and which way they are
// going are the panel, and the rest is the working behind them.

import React, { useEffect, useState } from '../react.js';
import { Empty } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { sinceLabel } from '../lib/format.js';
import { feedInterval } from '../lib/serverFeeds.js';
import {
    POLL_MS, RBN_HISTORY_URL, SUMMARY_URL, anyAvailable, dayTrend, ordinal, pace,
    parseRbnHistory, parseSummary, pskAllRank, pskBandRanks, pskCoverage, rankLabel,
    rankTone, rankTrend, ranked, shortCount, standing,
} from '../lib/ranking.js';

/**
 * One leaderboard position: what it is ranked on, how near the top, and the
 * number behind it.
 *
 * The bar is `standing`, not the rank — see lib/ranking.js. The rank in words is
 * beside it because the bar answers "how well" and only the number answers
 * "against how many", and on these boards that second question is most of the
 * story.
 */
function Row({ label, position, unit, hint }) {
    const tone = rankTone(position);
    const pct = standing(position) * 100;
    return (
        <div className="rank__row">
            <div className="rank__head">
                <span className="rank__label" title={hint}>{label}</span>
                <span className={`rank__place${tone ? ` is-${tone}` : ''}`}>
                    {ranked(position) ? ordinal(position.rank) : '—'}
                </span>
            </div>
            <div className="rank__bar">
                <div
                    className={`rank__fill${tone ? ` is-${tone}` : ''}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="rank__foot">
                <span>{rankLabel(position)}</span>
                <span className="rank__count">
                    {ranked(position) ? `${shortCount(position.value)} ${unit}` : ''}
                </span>
            </div>
        </div>
    );
}

/**
 * Which way this network is going, in a line.
 *
 * One component for all three because the three trends are computed from quite
 * different things — two windows, a pace against an average, a week of daily
 * ranks — and a reader should not have to learn three shapes to read "better
 * than it was". `dir` is always +1 for improving.
 */
function Trend({ dir, children }) {
    if (!dir) return <div className="rank__trend is-flat">■ {children}</div>;
    return (
        <div className={`rank__trend is-${dir > 0 ? 'good' : 'warn'}`}>
            {dir > 0 ? '▲' : '▼'} {children}
        </div>
    );
}

const places = (n) => `${n} ${n === 1 ? 'place' : 'places'}`;

/** A network's heading, with the callsign it is ranked under and how fresh it is. */
function Head({ name, callsign, at, now }) {
    return (
        <div className="rank__net">
            <span className="rank__netname">{name}</span>
            {callsign && <span className="rank__call">{callsign}</span>}
            {at > 0 && <span className="rank__age">{sinceLabel(at, now)}</span>}
        </div>
    );
}

/**
 * The bands this receiver ranks best on for PSK — free, from the description the
 * app already has, so it costs no request. See pskBandRanks.
 *
 * Worth its room because it is the one genuinely actionable line in the panel: a
 * receiver that is 3rd overall and 1st on 30 m and 40 m is telling you where its
 * aerial actually works, which the headline rank averages away.
 */
function Bands({ serverInfo }) {
    const best = pskBandRanks(serverInfo, 'reports', 4);
    if (!best.length) return null;
    return (
        <div className="rank__bands">
            <span className="rank__bandlabel">Best bands</span>
            {best.map((b) => (
                <span key={b.band} className="rank__band" title={`${shortCount(b.day)} reports in 24 h`}>
                    {b.band}
                    <i>{ordinal(b.rank)}</i>
                </span>
            ))}
        </div>
    );
}

export default function RankingPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [state, setState] = useState({ summary: null, loading: true, error: false });
    // A week of daily RBN ranks, fetched only when there is an RBN section to put
    // a trend on. Held apart from the summary because it is a second request and
    // one may succeed while the other fails.
    const [rbn, setRbn] = useState([]);
    // Only so the "20 mins ago" ages keep counting between polls, which are a
    // quarter of an hour apart — without it the freshest line on the panel would
    // be the one that looked most stale.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let alive = true;
        const json = (url) => fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        });

        const load = () => json(SUMMARY_URL)
            .then((body) => {
                if (!alive) return null;
                const summary = parseSummary(body);
                setState({ summary, loading: false, error: false });
                setNow(Date.now());
                return summary;
            })
            .then((summary) => {
                // Only where there is an RBN standing to put a trend on, and only
                // for the callsign the summary says RBN is looked up under — often
                // a different suffix from the receiver's own.
                if (!summary || !summary.rbn.available || !summary.cwCallsign) return;
                json(RBN_HISTORY_URL(summary.cwCallsign))
                    .then((body) => { if (alive) setRbn(parseRbnHistory(body)); })
                    // The week is the trimming rather than the meal: losing it
                    // leaves the standing itself, which is what the section is for.
                    .catch(() => { /* no trend line this cycle */ });
            })
            .catch(() => {
                if (!alive) return;
                // A failed poll leaves the standings up. They were true a quarter
                // of an hour ago and they are a league table, not a meter.
                setState((s) => ({ ...s, loading: false, error: !s.summary }));
            });
        const stop = feedInterval(load, POLL_MS);
        return () => { alive = false; stop(); };
    }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60000);
        return () => clearInterval(id);
    }, []);

    const s = state.summary;
    if (state.loading && !s) return <Empty>Loading…</Empty>;
    if (state.error && !s) return <Empty>Rankings are not available.</Empty>;
    if (!anyAvailable(s)) {
        // Not an error: a receiver that reports into none of the three networks is
        // an ordinary receiver, and saying "unavailable" would suggest otherwise.
        return <Empty>This receiver does not report to PSK Reporter, WSPR or the RBN.</Empty>;
    }

    const wsprTrend = dayTrend(s.wspr);
    const rbnTrend = rankTrend(rbn);
    const pskAll = pskAllRank(serverInfo, 'reports');
    const pskPace = pskAll && pace(pskAll.day, pskAll.week);
    const pskCountries = pskAllRank(serverInfo, 'countries');
    const coverage = pskCountries && pskCoverage(pskCountries.day, pskCountries.week);

    return (
        <div className="stack rank">
            {s.psk.available && (
                <div className="rank__group">
                    <Head name="PSK Reporter" callsign={s.callsign} at={s.psk.at} now={now} />
                    <Row
                        label="Unique spots"
                        position={s.psk.reports}
                        unit="spots"
                        hint="Unique digital spots this receiver reported in the last 24 hours"
                    />
                    <Row
                        label="Countries heard"
                        position={s.psk.countries}
                        unit="DXCC"
                        hint="Distinct countries this receiver heard in the last 24 hours"
                    />
                    {/* Free from the description — see pace and pskCoverage. The
                        two tables need different questions: reports add up over
                        the week and countries do not, so a pace on the countries
                        table would read as a 600% collapse. */}
                    {pskPace && (
                        <Trend dir={pskPace.dir}>
                            {pskPace.dir === 0
                                ? 'reporting at its usual weekly pace'
                                : `${Math.abs(pskPace.pct)}% ${pskPace.pct > 0 ? 'above' : 'below'} the week's daily average`}
                        </Trend>
                    )}
                    {!minimal && coverage != null && (
                        <div className="rank__note rank__note--tight">
                            {Math.round(coverage * 100)}% of the week's countries heard today
                        </div>
                    )}
                    {!minimal && <Bands serverInfo={serverInfo} />}
                </div>
            )}

            {s.wspr.available && (
                <div className="rank__group">
                    <Head name="WSPR Live" callsign={s.callsign} at={s.wspr.at} now={now} />
                    <Row
                        label="Rolling 24 h"
                        position={s.wspr.rolling24h}
                        unit="spots"
                        hint="Unique WSPR spots over the last 24 hours"
                    />
                    {/* Today and yesterday together, because apart they are two
                        numbers and together they are a direction. Compared by rank
                        rather than by count — see dayTrend for why a count would
                        report a collapse every morning. */}
                    <Row label="Today" position={s.wspr.today} unit="spots" hint="Unique WSPR spots since 00:00 UTC" />
                    {!minimal && (
                        <Row
                            label="Yesterday"
                            position={s.wspr.yesterday}
                            unit="spots"
                            hint="Unique WSPR spots over the whole of yesterday, UTC"
                        />
                    )}
                    {wsprTrend && (
                        <Trend dir={wsprTrend.dir}>
                            {wsprTrend.dir === 0
                                ? 'holding yesterday\u2019s place'
                                : `${places(wsprTrend.places)} ${wsprTrend.dir > 0 ? 'up on' : 'down on'} yesterday`}
                        </Trend>
                    )}
                </div>
            )}

            {s.rbn.available && (
                <div className="rank__group">
                    {/* The RBN callsign is often the same station under a different
                        suffix, so it is named rather than assumed to be the one
                        above. */}
                    <Head name="Reverse Beacon Network" callsign={s.cwCallsign} at={s.rbn.at} now={now} />
                    <Row
                        label="Spots posted"
                        position={s.rbn.spots}
                        unit="spots"
                        hint="Cumulative CW spots this skimmer has posted, against every other skimmer"
                    />
                    {/* The one trend that costs a request. RBN's count is
                        cumulative, so the summary alone can never say which way
                        it is going — see RBN_HISTORY_URL. */}
                    {rbnTrend && (
                        <Trend dir={rbnTrend.dir}>
                            {rbnTrend.dir === 0
                                ? `holding ${ordinal(rbnTrend.to)} over the week`
                                : `${places(rbnTrend.places)} ${rbnTrend.dir > 0 ? 'up' : 'down'} `
                                    + `over the week (${ordinal(rbnTrend.from)} → ${ordinal(rbnTrend.to)})`}
                        </Trend>
                    )}
                </div>
            )}

            {!minimal && (
                <div className="rank__note">
                    Updated every 15 minutes. Each network publishes on its own schedule,
                    so the times above differ.
                </div>
            )}
        </div>
    );
}
