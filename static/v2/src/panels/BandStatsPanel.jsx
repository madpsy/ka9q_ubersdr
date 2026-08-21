// How each band is actually measuring, from the noise floor monitor.
//
// static/noisefloor.html's dashboard, compressed into a dock column. That page
// is a survey — every band's card, four 24-hour charts, a 0–30 MHz spectrum —
// and it is the right shape for a browser window somebody has gone to look at.
// Beside the dial there is room for one question: how is the band I am on, and
// which band should I be on instead. So this is one band's numbers in full, with
// every measured band under it as a table you can read down and tune from.
//
// The picker is the band spectrum panel's, and means the same thing: Auto
// follows the dial, and pinning a band is for watching one you are not listening
// to. Same wording, same fallback when a pin names a band the monitor no longer
// watches — see lib/bandNoise.js `followsDial`.
//
// Under the figures is the day behind them: noisefloor.html's four 24-hour
// charts, which are four views of one array and are drawn here as one chart with
// the metric on a selector. See lib/noiseTrend.js.
//
// Two feeds, both tied to the panel being open, because Section unmounts a
// closed section's body: the readings above refresh every two minutes
// (lib/bandNoise.js) and the day behind them every ten (lib/noiseTrend.js).
// Both enforce that as a floor rather than a bare timer, so opening and closing
// the panel cannot turn into a request per open.
//
// `minimal` is the band, its condition and the two figures that decide whether
// to stay on it: the noise floor and the dynamic range. The picker, the chart,
// the rest of the readouts and the all-bands table are what you expand for —
// and because the chart owns its own subscription, the minimal view does not
// ask the server for a day of history at all.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { Empty, Icon, Segmented } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { bandForFrequency, bandRange, tuneToBand } from '../lib/bands.js';
import {
    chooseBand, floorStats, floorTone, followsDial, formatFigure, getBandNoise, hasFT8,
    measuredMs, rowsFrom, saveBand, savedBand, snrLabel, snrTone, subscribeBandNoise,
} from '../lib/bandNoise.js';
import {
    METRICS, WINDOW_MS, clockAt, conditionRuns, conditionSeries, getNoiseTrend,
    hasTrend, hourTicks, levelTicks, metricByKey, nearest, niceRange, saveMetric,
    savedMetric, seriesFor, spans, subscribeNoiseTrend,
} from '../lib/noiseTrend.js';
import { sinceLabel } from '../lib/format.js';

// The full page, for the questions a dock column cannot answer — 24 hours of
// anything, or the whole 0–30 MHz at once.
const MONITOR_URL = '/noisefloor.html';

// The age readout is redrawn on this, not on the poll: a measurement a minute
// old should say so before the next one lands, or a stalled monitor reads as a
// fresh one. Ten seconds is finer than the data and far cheaper than the second
// ticks elsewhere in the app — this panel is otherwise static between polls.
const TICK_MS = 10000;

// ── The 24-hour chart ───────────────────────────────────────────────────────
//
// Hand-drawn, like every other picture in v2. There is no chart library here on
// purpose: the spectrum, the waterfall, the scope and the spectrogram are all
// canvas, and pulling one in for this would put a second set of fonts, colours
// and interaction rules on the screen beside them.
//
// The proportions of a chart this small are mostly gutters, so they are named.
const CHART_H = 116;             // CSS px, the whole block including its axes
const PAD_L = 34;                // room for a "-128" label and a gap
const PAD_R = 4;
const PAD_T = 6;
const STRIP_H = 5;               // the condition strip under the plot
const STRIP_GAP = 3;
const AXIS_H = 13;               // the row of times

// The condition colours, matching .band-keys in styles.css. Canvas cannot use a
// class, so this is the one place the four buckets are written twice; keep it in
// step with the stylesheet.
const TONE_COLOUR = {
    excellent: '#22c55e',
    good: '#fbbf24',
    fair: '#ff9800',
    poor: '#ef4444',
    none: 'transparent',
};

// The theme, read straight rather than through lib/spectrumTrace.js's cache:
// that cache is keyed on the theme alone and shared by every caller, so asking
// it for a different set of variables than the spectrum panes ask for would
// hand whichever ran second the other one's answer. This chart redraws on data,
// size and hover — not per frame — so a getComputedStyle costs nothing here.
function chartColours() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    return {
        bg: v('--surface-3'),
        grid: v('--border'),
        label: v('--text-faint'),
        trace: v('--accent'),
        rule: v('--text-dim'),
    };
}

function drawTrend(canvas, { width, series, runs, range, from, to, at }) {
    const c = canvas.getContext('2d');
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(CHART_H * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    const col = chartColours();
    const plotW = Math.max(1, width - PAD_L - PAD_R);
    const plotH = Math.max(1, CHART_H - PAD_T - AXIS_H - STRIP_H - STRIP_GAP);
    const stripY = PAD_T + plotH + STRIP_GAP;

    c.clearRect(0, 0, width, CHART_H);
    c.fillStyle = col.bg;
    c.fillRect(PAD_L, PAD_T, plotW, plotH);

    const x = (t) => PAD_L + ((t - from) / (to - from)) * plotW;
    const y = (v) => PAD_T + (1 - (v - range.min) / (range.max - range.min)) * plotH;

    // The grid, and the labels that make it mean something. Half-pixel offsets
    // so a 1px line is a line rather than a two-pixel smear.
    // A literal stack, not var(--mono): the canvas font property does not
    // resolve custom properties, and an unparseable value is silently ignored.
    c.font = '9px ui-monospace, SFMono-Regular, monospace';
    c.textBaseline = 'middle';
    c.strokeStyle = col.grid;
    c.lineWidth = 1;
    c.fillStyle = col.label;
    c.textAlign = 'right';
    for (const level of levelTicks(range)) {
        const ly = Math.round(y(level)) + 0.5;
        if (ly < PAD_T || ly > PAD_T + plotH) continue;
        c.beginPath();
        c.moveTo(PAD_L, ly);
        c.lineTo(PAD_L + plotW, ly);
        c.stroke();
        c.fillText(String(Math.round(level)), PAD_L - 4, ly);
    }

    c.textAlign = 'center';
    for (const tick of hourTicks(from, to, Math.max(2, Math.floor(plotW / 56)))) {
        const tx = Math.round(x(tick.t)) + 0.5;
        c.beginPath();
        c.moveTo(tx, PAD_T);
        c.lineTo(tx, PAD_T + plotH);
        c.stroke();
        c.fillText(tick.label, tx, CHART_H - AXIS_H / 2);
    }

    // The condition strip: what the band was doing, hour by hour, under the
    // metric being read. Runs, not buckets — see conditionRuns.
    for (const run of runs) {
        if (run.tone === 'none') continue;
        const x0 = Math.max(PAD_L, x(run.from));
        const x1 = Math.min(PAD_L + plotW, x(run.to));
        if (!(x1 > x0)) continue;
        c.fillStyle = TONE_COLOUR[run.tone] || 'transparent';
        c.fillRect(x0, stripY, x1 - x0, STRIP_H);
    }

    // The trace, one path per unbroken stretch.
    c.strokeStyle = col.trace;
    c.lineWidth = 1.25;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    for (const run of series) {
        c.beginPath();
        run.forEach((p, i) => (i ? c.lineTo(x(p.t), y(p.v)) : c.moveTo(x(p.t), y(p.v))));
        // A stretch of one reading has no line in it, so it is drawn as the
        // point it is rather than silently not drawn at all.
        if (run.length === 1) c.lineTo(x(run[0].t) + 0.01, y(run[0].v));
        c.stroke();
    }

    if (!at) return;
    const hx = Math.round(x(at.t)) + 0.5;
    c.strokeStyle = col.rule;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(hx, PAD_T);
    c.lineTo(hx, PAD_T + plotH);
    c.stroke();
    c.fillStyle = col.trace;
    c.beginPath();
    c.arc(x(at.t), y(at.v), 2.5, 0, Math.PI * 2);
    c.fill();
}

/**
 * One band's last 24 hours of one metric.
 *
 * Everything it draws comes from the array it is given — see lib/noiseTrend.js,
 * which is also where the arithmetic that can be wrong lives.
 */
function TrendChart({ points, cond, metric }) {
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const [width, setWidth] = useState(0);
    const [at, setAt] = useState(null);

    // The right-hand edge is "now", fixed at the moment the data arrived rather
    // than at every render: recomputing it per render would slide the picture
    // under the pointer, and between two polls it is ten minutes out at worst on
    // a window of twenty-four hours.
    const to = useMemo(() => Date.now(), [points]);
    const from = to - WINDOW_MS;

    const range = useMemo(() => niceRange(points), [points]);
    const runs = useMemo(() => conditionRuns(cond), [cond]);
    const paths = useMemo(() => spans(points), [points]);

    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return undefined;
        const size = () => setWidth(Math.max(0, Math.round(wrap.clientWidth)));
        size();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(size);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !width || !range) return;
        drawTrend(canvas, { width, series: paths, runs, range, from, to, at });
    }, [width, paths, runs, range, from, to, at]);

    const read = (e) => {
        const canvas = canvasRef.current;
        if (!canvas || !width) return;
        const box = canvas.getBoundingClientRect();
        const plotW = Math.max(1, width - PAD_L - PAD_R);
        const frac = (e.clientX - box.left - PAD_L) / plotW;
        setAt(nearest(points, from + Math.min(1, Math.max(0, frac)) * (to - from)));
    };

    if (!range) return null;

    return (
        <div className="bst-chart" ref={wrapRef}>
            <canvas
                ref={canvasRef}
                className="bst-chart__canvas"
                style={{ height: `${CHART_H}px` }}
                onPointerMove={read}
                onPointerDown={read}
                onPointerLeave={() => setAt(null)}
            />
            {/* The readout sits over the chart rather than under it: a caption
                that appears and disappears would move everything below it every
                time the pointer crossed the picture. */}
            <div className={`bst-chart__at${at ? ' is-on' : ''}`}>
                {at ? `${clockAt(at.t)}  ${formatFigure(at.v)} ${metric.unit}` : ''}
            </div>
        </div>
    );
}

// The chart and its selector, as one section.
//
// Its own component so that the subscription belongs to it: the section is
// rendered only in the full view, so the minimal view holds no history feed and
// makes no request for one. Same rule as the panel itself being unmounted while
// its section is collapsed, one level down.
function TrendSection({ band }) {
    const [feed, setFeed] = useState(getNoiseTrend);
    const [key, setKey] = useState(savedMetric);

    useEffect(() => subscribeNoiseTrend(setFeed), []);

    const pick = (k) => { saveMetric(k); setKey(k); };
    const metric = metricByKey(key);
    const points = useMemo(
        () => (band ? seriesFor(feed.trends, band, metric) : []),
        [feed.trends, band, metric],
    );
    const cond = useMemo(
        () => (band ? conditionSeries(feed.trends, band) : []),
        [feed.trends, band],
    );

    const known = hasTrend(feed.trends, band);

    return (
        <div className="stack stack--tight">
            <div className="bst-chart__head">
                <Segmented
                    size="sm"
                    value={key}
                    onChange={pick}
                    options={METRICS.map((m) => ({ value: m.key, label: m.label, title: m.title }))}
                />
                <span className="bst-chart__span">24 h</span>
            </div>

            {feed.trends === null && <div className="note note--tight">Loading history…</div>}
            {feed.trends !== null && !known && (
                <div className="note note--tight">
                    {feed.error || `No history for ${band} yet.`}
                </div>
            )}
            {/* Points but no range means every reading in the window was
                unusable for this metric — an FT8 series on a band nobody has
                called on, most often. Said rather than drawn as an empty box. */}
            {known && points.length === 0 && (
                <div className="note note--tight">
                    Nothing recorded for {metric.label.toLowerCase()} on {band} in the last 24 hours.
                </div>
            )}
            {known && points.length > 0 && (
                <TrendChart points={points} cond={cond} metric={metric} />
            )}
        </div>
    );
}

// One measurement, labelled. The unit lives on the cell rather than in the
// value so a column of them lines up on the decimal point, which is the whole
// reason these are monospace.
function Cell({ label, value, unit, tone, title }) {
    return (
        <div className={`readout bst-cell${tone && tone !== 'none' ? ` bst-cell--${tone}` : ''}`} title={title}>
            <div className="readout__label">{label}</div>
            <div className="readout__value">
                {value}
                {unit && <span className="readout__unit">{unit}</span>}
            </div>
        </div>
    );
}

export default function BandStatsPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const [feed, setFeed] = useState(getBandNoise);
    const [pref, setPrefState] = useState(savedBand);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => subscribeBandNoise(setFeed), []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const rows = useMemo(() => rowsFrom(feed.latest), [feed.latest]);
    const stats = useMemo(() => floorStats(rows), [rows]);

    const dialBand = bandForFrequency(tuning.frequency);
    const band = chooseBand(pref, rows, dialBand);
    const m = band ? rows.find((r) => r.band === band) : null;
    const auto = followsDial(pref, rows);

    const pin = (name) => {
        saveBand(name);
        setPrefState(name);
    };

    // Tuning to a band the monitor measures is the point of the table, so a row
    // does what the band keys do — the middle of the band, the band's sideband,
    // the spectrum zoomed to it. A pinned panel re-pins as it goes, so it does
    // not end up showing 20m while the receiver sits on 40m without being asked.
    const go = (name) => {
        const range = bandRange(name);
        if (!range) return;
        if (!auto) pin(name);
        tuneToBand(actions, range.min, range.max);
    };

    if (feed.latest === null) {
        return <Empty>{feed.error ? `Noise floor unavailable: ${feed.error}` : 'Loading band measurements…'}</Empty>;
    }
    if (!m) {
        return (
            <div className="stack">
                <Empty>No band measurements yet — the monitor reports once a minute.</Empty>
                {feed.error && <div className="note note--warn">Last refresh failed ({feed.error}).</div>}
            </div>
        );
    }

    const at = measuredMs(m);
    const tone = snrTone(m);
    const fTone = floorTone(m.p5_db, stats);

    return (
        <div className="stack bst">
            {!minimal && (
                <div className="bst__pick">
                    <select
                        className="select"
                        value={auto ? 'auto' : pref}
                        onChange={(e) => pin(e.target.value)}
                        title="Which band this panel reports. Auto follows the dial"
                        aria-label="Band"
                    >
                        {/* Auto says what it resolved to, so the row is not read
                            twice to find out which band the numbers belong to. */}
                        <option value="auto">{auto ? `Auto — ${band}` : 'Auto'}</option>
                        {rows.map((r) => (
                            <option key={r.band} value={r.band}>{r.band}</option>
                        ))}
                    </select>
                    <span className="bst__age" title={at ? new Date(at).toLocaleString() : 'No measurement time reported'}>
                        {at ? `${sinceLabel(at, now)} ago` : '—'}
                    </span>
                </div>
            )}

            {/* The headline: which band, and what the FT8 traffic on it says
                about whether it is open. Everything under it is the working. */}
            <div className={`bst-hero bst-hero--${tone}`}>
                <div className="bst-hero__label">{minimal && auto ? 'Band — auto' : 'Band'}</div>
                <div className="bst-hero__value">
                    <span className="bst-hero__band">{band}</span>
                    <span className="bst-hero__grade">{snrLabel(m)}</span>
                </div>
                <div className="bst-hero__foot">
                    {hasFT8(m)
                        ? `FT8 SNR ${formatFigure(m.ft8_snr)} dB`
                        : 'No FT8 heard in the last measurement'}
                    {minimal && at ? ` · ${sinceLabel(at, now)} ago` : ''}
                </div>
            </div>

            {feed.error && (
                <div className="note note--warn">
                    Last refresh failed ({feed.error}) — showing the previous measurement.
                </div>
            )}

            {/* The two figures a band is judged on, then — expanded — the rest of
                what the monitor measured. The labels are in words where the full
                page uses percentiles: "Noise floor" rather than "P5". The
                percentile is in the tooltip instead, so somebody reading this
                beside noisefloor.html or the API can see they are the same
                number without the panel itself being written in shorthand. */}
            <div className="readout-grid">
                <Cell
                    label="Noise floor"
                    value={formatFigure(m.p5_db)}
                    unit="dB"
                    tone={fTone}
                    title={`P5 — the 5th percentile of this band's bins.${
                        fTone === 'good' ? '\nAmong the quietest bands on this receiver.'
                            : fTone === 'bad' ? '\nAmong the noisiest bands on this receiver.' : ''}`}
                />
                <Cell
                    label="Dynamic range"
                    value={formatFigure(m.dynamic_range)}
                    unit="dB"
                    title="P95 − P5: how far the strongest signals stand above the floor. The room the band has for a weak signal"
                />
                {!minimal && (
                    <>
                        <Cell
                            label="Signal peak"
                            value={formatFigure(m.p95_db)}
                            unit="dB"
                            title="P95 — the 95th percentile, i.e. the level the strongest few percent of the band reach"
                        />
                        <Cell
                            label="Occupancy"
                            value={formatFigure(m.occupancy_pct)}
                            unit="%"
                            title="Share of the band's bins more than 10 dB above the noise floor — how busy it is"
                        />
                        <Cell
                            label="Median"
                            value={formatFigure(m.median_db)}
                            unit="dB"
                            title="The middle bin of the band. Well above the floor means the whole band is lifted, not just the signals in it"
                        />
                        <Cell
                            label="Max"
                            value={formatFigure(m.max_db)}
                            unit="dB"
                            title="The single strongest bin in the band"
                        />
                    </>
                )}
            </div>

            {/* Where the reading above came from. The figures are one moment;
                this is the day behind them, which is what turns "the floor is
                -118" into "the floor has been climbing since dusk".

                Full view only, and that is what gates the request: the section
                owns the subscription, so a panel shrunk to a glance holds no
                history feed. See TrendSection. */}
            {!minimal && (
                <>
                    <div className="divider" />
                    <TrendSection band={band} />
                </>
            )}

            {!minimal && rows.length > 1 && (
                <>
                    <div className="divider" />

                    {/* Every measured band at once — the part of noisefloor.html
                        worth carrying over, because "which band should I be on"
                        is not answerable from one band's card. Floor and SNR
                        only: the two columns you scan, with the rest a click
                        away by selecting the band. */}
                    <div className="bst-table">
                        <div className="bst-table__head">
                            <span>Band</span>
                            <span>Floor</span>
                            <span>FT8 SNR</span>
                        </div>
                        {rows.map((r) => {
                            const range = bandRange(r.band);
                            const rt = snrTone(r);
                            return (
                                <button
                                    key={r.band}
                                    type="button"
                                    className={`bst-table__row${r.band === band ? ' is-current' : ''}`}
                                    disabled={!range}
                                    title={[
                                        `${r.band} — ${snrLabel(r)}`,
                                        `Noise floor ${formatFigure(r.p5_db)} dB · range ${formatFigure(r.dynamic_range)} dB · ${formatFigure(r.occupancy_pct)}% occupied`,
                                        range ? 'Click to tune' : 'Not one of the amateur bands — nothing to tune to',
                                    ].join('\n')}
                                    onClick={() => go(r.band)}
                                >
                                    <span className="bst-table__band">{r.band}</span>
                                    <span className={`bst-table__num bst-cell--${floorTone(r.p5_db, stats)}`}>
                                        {formatFigure(r.p5_db)}
                                    </span>
                                    <span className={`bst-table__grade bst-grade bst-grade--${rt}`}>
                                        {hasFT8(r) ? formatFigure(r.ft8_snr) : '—'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Where the questions this panel raises but cannot answer
                        get answered: 24 hours of any of these figures, the full
                        HF spectrum, and the same numbers for a day last week.
                        Not in the minimal view, like every other link out of a
                        panel. */}
                    <div className="bst__foot">
                        <a
                            className="btn btn--ghost btn--sm"
                            href={MONITOR_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Noise Floor Monitor
                            <Icon.External size={13} />
                        </a>
                    </div>
                </>
            )}
        </div>
    );
}
