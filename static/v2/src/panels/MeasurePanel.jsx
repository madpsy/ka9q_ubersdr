// Measure: what is actually in a piece of spectrum you have drawn a box round.
//
// The receiver already shows where the signals are. What it has never been able
// to say is how wide one is, how far above the noise, how much it wanders, and
// how often it is there at all — the questions somebody asks when they are
// identifying an interferer, checking a transmitter, or deciding whether a
// frequency is worth using. Every one of those is a reading off the same bins
// the waterfall is drawn from, and none of them was reachable.
//
// ── The tool, not the panel, owns the measurement ────────────────────────────
//
// Pressing Start hands the spectrum's presses to this tool: a drag draws a
// region instead of panning, and a click does not tune. That is a large thing to
// do to a display, so it is deliberately explicit — a button, a badge over the
// spectrum saying so, and Escape to get out. See SpectrumView's MEASURE_GRAB_PX
// for what the gestures become and which two are left alone.
//
// The arithmetic is lib/measure.js and the engine that runs it is
// MeasureWatch — mounted for the life of the session, not by this panel,
// because on a phone this panel is a sheet covering the very spectrum being
// measured. Closing it to see the band must not stop the measurement. So this
// file is a readout and a row of buttons, and nothing here computes anything.
//
// ── What the numbers can honestly be ─────────────────────────────────────────
//
// The receiver's dB scale is uncalibrated (see lib/measure.js), so every
// absolute level is marked "rel" and every difference is not. That is not
// hedging: SNR, the x-dB widths, shape factor, occupied bandwidth and the whole
// of the run block are true statements about the signal, and the peak level on
// its own is a number that means something only next to another one.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Field, Icon, Readout, Segmented } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { strokeCurve, xAt } from '../lib/rollingChart.js';
import {
    HISTORY_MS, OBW_PERCENTS, X_DB_LEVELS, axisFor, busyRuns, drift, histogram, occupancyOf,
    reportLines, seriesOf, spreadOf,
} from '../lib/measure.js';
import {
    AVERAGE_MS, clearMeasure, measureSettings, onMeasureSettings, saveMeasureSettings,
    setMeasureFrozen, startMeasure, stopMeasure,
} from '../lib/measureTool.js';
import { useMeasureResult, useMeasureState } from '../lib/useMeasure.js';

const dbText = (v, places = 1) => (Number.isFinite(v) ? v.toFixed(places) : '—');

/** A signed frequency offset, spoken the way an operator would say it. */
function offsetText(hz) {
    if (!Number.isFinite(hz)) return '—';
    const r = Math.round(hz);
    if (r === 0) return 'on the dial';
    return `${r > 0 ? '+' : '−'}${formatSpan(Math.abs(r))}`;
}

/**
 * How long a run has been going, said in the unit it is currently worth saying.
 *
 * Seconds up to two minutes, then minutes: a run left going over lunch reading
 * "4212 s" is a number nobody converts.
 */
function elapsedText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 120) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 120) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ── charts ──────────────────────────────────────────────────────────────────
//
// A card is a number; the run behind it is a shape. Which of those you want
// depends on the question — "how strong is it" is a number, "is it fading, and
// how fast" is not a number at all — and the panel cannot know which you are
// asking. So every reading with a shape worth seeing is a card you can press,
// and pressing it opens the chart underneath, across the panel's full width.
//
// One at a time. Ten charts is a wall, and the point of a card is that a dozen
// readings fit in a glance; the expanded one is the question you are on.
//
// Deliberately not the same chart for every reading. What a series has to say
// differs in kind, not just in data:
//
//   trace       the reading against time. The workhorse: a fade, a drifting
//               noise floor, a filter opening and closing.
//   deviation   the same, but drawn about a reference line with a symmetric
//               axis. For a frequency, where the absolute number is not the
//               reading — the excursion either side of it is.
//   raster      a strip of busy and clear over the window. For occupancy, where
//               a percentage cannot tell one long transmission from a carrier
//               keying every two seconds.
//   histogram   the distribution rather than the order. For SNR over a run,
//               where one hump and two humps have the same min, max and σ and
//               are not the same signal at all.
//
// The specs live in CHARTS below, keyed by card. A card with no entry there is
// a plain readout and does not invite a press: Bins and Resolution do not have
// a shape, and offering a chart of a constant is worse than offering none.

// How tall an expanded chart is, in CSS px. Taller than the strip this replaced
// (48px), because it now has the panel's full width and a shape is easier to
// read the closer its aspect is to square.
const CHART_H = 64;

/**
 * What each card expands into.
 *
 *   key    the field in the run's history — see accumulate()
 *   kind   which of the four pictures
 *   least  the narrowest the axis may be, in the reading's own units. This is
 *          the anti-weather number: without it a reading that has not moved
 *          auto-scales to its own last digit and draws a mountain range.
 *   hz     format the axis in frequency rather than decibels
 */
// The keys are quoted because they are data rather than identifiers: they are
// the vocabulary the open card is persisted in (see measureTool's `expanded`),
// so they have to survive a rename of anything in this file.
const CHARTS = {
    'snr': { key: 'snrDb', kind: 'trace', least: 10, caption: 'SNR' },
    // Beside SNR these answer the question SNR alone cannot: whether the signal
    // faded or the noise came up. They are the two halves of it.
    'peak-level': { key: 'peakDb', kind: 'trace', least: 10, caption: 'Peak level' },
    'floor': { key: 'floorDb', kind: 'trace', least: 10, caption: 'Noise floor' },
    'power': { key: 'powerDb', kind: 'trace', least: 10, caption: 'Channel power' },
    'median': { key: 'medianDb', kind: 'trace', least: 10, caption: 'Region median' },
    'crest': { key: 'crestDb', kind: 'trace', least: 6, caption: 'Crest' },
    'flatness': { key: 'flatnessDb', kind: 'trace', least: 6, caption: 'Flatness' },
    'width': { key: 'widthHz', kind: 'trace', least: 100, hz: true, caption: 'Width' },
    // The drift picture. About the run's own mean rather than about zero: a
    // carrier on 14.1 MHz that wanders 30 Hz is a 30 Hz story, and an axis
    // starting at zero would draw it as a flat line at the top of the box.
    'peak': { key: 'peakHz', kind: 'deviation', least: 20, hz: true, caption: 'Peak, about its mean' },
    'occupancy': { key: 'snrDb', kind: 'raster', caption: 'Busy' },
    'snr-spread': { key: 'snrDb', kind: 'histogram', least: 10, caption: 'SNR, how often' },
};

/** The y-axis label for a value, in whichever units the series is in. */
const axisText = (v, hz) => (hz ? formatSpan(Math.abs(v)) : `${v.toFixed(1)} dB`);

/**
 * One expanded chart.
 *
 * All four kinds share this canvas, its sizing and its colours, because they
 * share a box and must look like one family. What differs is thirty lines in
 * the middle.
 */
function MeasureChart({ spec, run, at, occupancyDb }) {
    const ref = useRef(null);

    useEffect(() => {
        const c = ref.current;
        if (!c) return undefined;
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(CHART_H * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext('2d');
        if (!ctx) return undefined;
        ctx.clearRect(0, 0, w, h);

        // Read off this canvas rather than through lib/spectrumTrace's
        // themeColors(). That cache is keyed on the theme alone and filled by
        // whichever caller asks first, so a caller with a short list of
        // variables leaves every later caller's missing — and the spectrum's own
        // draw loop is one of them.
        const cs = window.getComputedStyle(c);
        const accent = cs.getPropertyValue('--accent').trim() || '#08a2fb';
        const rule = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.14)';
        const faint = cs.getPropertyValue('--surface-3').trim() || 'rgba(255,255,255,0.06)';

        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeStyle = rule;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        ctx.stroke();

        if (spec.kind === 'raster') {
            // Blocks rather than a line: this is a state over an interval, and
            // a line between two samples of a boolean invents a ramp between
            // them that never happened.
            for (const seg of busyRuns(run, occupancyDb, at)) {
                const x0 = xAt(seg.from, at, HISTORY_MS, w);
                const x1 = xAt(seg.to, at, HISTORY_MS, w);
                ctx.fillStyle = seg.busy ? accent : faint;
                ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h - 1);
            }
            return undefined;
        }

        if (spec.kind === 'histogram') {
            const hist = histogram(seriesOf(run, spec.key).map((p) => p.v));
            if (!hist || !hist.max) return undefined;
            const bw = w / hist.counts.length;
            ctx.fillStyle = accent;
            for (let i = 0; i < hist.counts.length; i++) {
                const bh = (hist.counts[i] / hist.max) * (h - 2);
                if (bh <= 0) continue;
                // A pixel of gap, so adjacent buckets read as bars rather than
                // as one filled area.
                ctx.fillRect(i * bw, h - 1 - bh, Math.max(1, bw - dpr), bh);
            }
            return undefined;
        }

        const pts = seriesOf(run, spec.key);
        if (pts.length < 2) return undefined;
        const mean = spec.kind === 'deviation'
            ? pts.reduce((a, p) => a + p.v, 0) / pts.length
            : null;
        const ax = axisFor(pts.map((p) => p.v), spec.least, mean);
        const yOf = (v) => h - ((v - ax.lo) / (ax.hi - ax.lo)) * h;

        // The reference line a deviation is measured from. Drawn under the
        // trace, so a line sitting exactly on it still reads as the trace.
        if (ax.mid != null) {
            ctx.strokeStyle = rule;
            ctx.setLineDash([2 * dpr, 3 * dpr]);
            ctx.beginPath();
            ctx.moveTo(0, yOf(ax.mid));
            ctx.lineTo(w, yOf(ax.mid));
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.lineWidth = Math.max(1.2, 1.2 * dpr);
        ctx.lineJoin = 'round';
        strokeCurve(ctx, pts.map((p) => ({ x: xAt(p.t, at, HISTORY_MS, w), y: yOf(p.v) })), () => accent);
        return undefined;
    }, [spec, run, at, occupancyDb]);

    return (
        <div className="measure-chart">
            <canvas ref={ref} style={{ height: CHART_H }} />
            <div className="measure-chart__axis">
                <span>{chartRange(spec, run, occupancyDb)}</span>
                <span>{spec.caption}, last {Math.round(HISTORY_MS / 1000)} s</span>
            </div>
        </div>
    );
}

/** What the picture is drawn against, said in words under it. */
function chartRange(spec, run, occupancyDb) {
    const vals = seriesOf(run, spec.key).map((p) => p.v);
    if (!vals.length) return '';
    if (spec.kind === 'raster') {
        const busy = vals.filter((v) => v >= occupancyDb).length;
        return `busy ${Math.round((busy / vals.length) * 100)}% of it`;
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (spec.kind === 'deviation') {
        const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
        return `±${axisText(Math.max(hi - mean, mean - lo), spec.hz)} about the mean`;
    }
    return `${axisText(lo, spec.hz)} – ${axisText(hi, spec.hz)}`;
}

/**
 * A reading, and the chart it opens into.
 *
 * The head is a button and the chart is not, so pressing the picture does not
 * put it away again — which is what happens if the whole card is one button,
 * and it is maddening the first time you try to look closely at something.
 *
 * A card with no chart is a plain readout with no press and no cursor: an
 * affordance that does nothing is worse than none, because it has to be tried
 * before it can be ruled out.
 */
function Card({ id, label, value, unit, wide, open, onOpen, run, at, occupancyDb }) {
    const spec = CHARTS[id];
    const readout = <Readout label={label} value={value} unit={unit} />;
    // Nothing measured yet is nothing to chart. The card stays, and stays
    // inert, rather than offering a press that would open an empty box.
    if (!spec || !run || !run.frames) {
        return wide ? <span className="measure-wide">{readout}</span> : readout;
    }
    return (
        <div className={`measure-card${open ? ' is-open' : ''}${open || wide ? ' measure-wide' : ''}`}>
            <button
                type="button"
                className="measure-card__head"
                aria-expanded={open}
                onClick={() => onOpen(open ? '' : id)}
                title={open ? 'Close the chart' : `Chart ${spec.caption.toLowerCase()} over the run`}
            >
                {readout}
                <Icon.Bars size={11} className="measure-card__cue" />
            </button>
            {open && (
                <MeasureChart spec={spec} run={run} at={at} occupancyDb={occupancyDb} />
            )}
        </div>
    );
}

export default function MeasurePanel({ minimal }) {
    const { tuning, actions, view } = useRadio();
    const { active, selection, drawing, frozen } = useMeasureState();
    const result = useMeasureResult();
    const [settings, setSettings] = useState(measureSettings);
    useEffect(() => onMeasureSettings(setSettings), []);
    const [copied, setCopied] = useState(false);

    const stats = result && result.stats;
    const run = result && result.run;

    // Which card is open as a chart. Persisted, because it is the question you
    // came to this panel to watch — coming back to a collapsed panel and having
    // to remember which reading you were following is the sort of small tax
    // that stops somebody using a tool.
    const open = settings.expanded;
    const setOpen = useCallback((id) => saveMeasureSettings({ expanded: id }), []);
    const card = (id, label, value, unit, wide) => (
        <Card
            key={id}
            id={id}
            label={label}
            value={value}
            unit={unit}
            wide={wide}
            open={open === id}
            onOpen={setOpen}
            run={run}
            at={(result && result.at) || Date.now()}
            occupancyDb={settings.occupancyDb}
        />
    );

    const copy = useCallback(() => {
        if (!result || !navigator.clipboard) return;
        const text = reportLines(result, { tuning }).join('\n');
        navigator.clipboard.writeText(`${text}\n`).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }, () => { /* a refused clipboard is not worth an error state */ });
    }, [result, tuning]);

    // Whether the dial is inside the region, which is the only case where
    // "filter to region" means anything: the passband is set in offsets from
    // the dial, so a region three kilohertz away would ask for a filter with
    // the signal outside it. Disabled rather than hidden — the button is the
    // explanation for why it is disabled.
    const dialInside = !!(selection
        && tuning.frequency > selection.loHz && tuning.frequency < selection.hiHz);

    const toggleXdb = useCallback((level) => {
        const cur = measureSettings().xDb;
        const next = cur.includes(level) ? cur.filter((d) => d !== level) : [...cur, level];
        saveMeasureSettings({ xDb: next });
    }, []);

    const busy = occupancyOf(run);
    const wander = drift(run);
    const snrRun = spreadOf(run && run.snr);
    const widthRun = spreadOf(run && run.width);

    // What the panel says when there is no reading. Four different situations,
    // and the operator's next move is different in each — see whyNot's twin in
    // MeasureOverlay, which says the short form over the spectrum.
    const note = useMemo(() => {
        if (!active && !selection) return 'Press Start, then drag across the spectrum to measure a piece of it.';
        if (!selection) return 'Drag across the spectrum to draw a region.';
        // Only until there are numbers to show. A drag has live readings under
        // it from the first frame — that is what makes drawing a region feel
        // like aiming — and an empty-state block appearing and disappearing
        // above them would jump the panel about on every gesture. The badge over
        // the spectrum is where "being drawn" is said.
        if (stats) return null;
        if (drawing) return 'Drawing…';
        if (result && result.reason === 'outside') return 'The region is not in this view — pan back to it.';
        if (result && result.reason === 'narrow') return `Only ${result.bins} bins across at this zoom, which is too few to measure — zoom in.`;
        if (!active) return 'Stopped. Press Start to measure this region.';
        return 'Waiting for the spectrum…';
    }, [active, selection, drawing, stats, result]);

    return (
        <div className="stack">
            <div className="measure-panel__head">
                <Button
                    variant={active ? 'danger' : 'primary'}
                    icon={active ? <Icon.Stop /> : <Icon.Play />}
                    onClick={active ? stopMeasure : startMeasure}
                    title={active
                        ? 'Stop measuring — clicks on the spectrum go back to tuning'
                        : 'Take the spectrum\'s presses: drag to draw a region, and nothing tunes or pans until you stop'}
                >
                    {active ? 'Stop' : 'Start'}
                </Button>
                <Button
                    icon={frozen ? <Icon.Play /> : <Icon.Pause />}
                    active={frozen}
                    disabled={!active}
                    onClick={() => setMeasureFrozen(!frozen)}
                    title="Hold the reading still so it can be read. The run stops counting while it is held, so the occupancy is not a claim about a period nobody was watching."
                >
                    {frozen ? 'Held' : 'Hold'}
                </Button>
                <Button
                    icon={<Icon.Trash />}
                    disabled={!selection}
                    onClick={clearMeasure}
                    title="Forget the region and everything measured over it"
                >
                    Clear
                </Button>
            </div>

            {note && <Empty>{note}</Empty>}

            {stats && (
                <>
                    <div className="readout-grid">
                        {card('width', 'Width', formatSpan(stats.widthHz))}
                        {card('snr', 'SNR', dbText(stats.snrDb), 'dB')}
                        {/* A frequency is ten characters and will not share a
                            dock column with anything — the IF panel's stats row
                            reaches the same conclusion about the same reading,
                            and half a column is exactly where it escaped the
                            card. Its chart is the drift: the absolute number is
                            not what moves, and what moves is the reading. */}
                        {card('peak', 'Peak', formatFreqExact(stats.peakHz), undefined, true)}
                        <Readout label="Peak vs dial" value={offsetText(stats.peakHz - tuning.frequency)} />
                        {card('peak-level', 'Peak level', dbText(stats.peakDb), 'dB rel')}
                        {/* The view's floor, not the region's — see
                            selectionStats for the argument. The region's own
                            median is below, under Density, where it reads as
                            what it is: how full the box is. */}
                        {card('floor', 'Noise floor', dbText(stats.floorDb), 'dB rel')}
                    </div>

                    {/* The peak sitting on the edge of the region means the
                        signal very likely carries on past it, and every width
                        below is then a lower bound rather than a measurement.
                        Worth a line of its own: it is the one mistake this tool
                        makes easy, and it looks like a perfectly good reading. */}
                    {stats.peakAtEdge && (
                        <div className="measure-warn">
                            <Icon.Info size={12} />
                            The peak is on the edge of the region — widen it, or every width here is a lower bound.
                        </div>
                    )}

                    {/* Every row holds its place, measurable or not.
                        These are the readings that come and go on their own: a
                        −60 dB skirt disappears behind a neighbour, an occupied
                        bandwidth needs something above the floor, and the tone
                        spacing needs two peaks the finder is willing to call
                        two. On a real signal each of those flickers frame to
                        frame, and a row that vanishes takes its height with it —
                        so the rows below jumped up and down several times a
                        second, which made the whole block unreadable while you
                        were trying to read one number in it.
                        A dash also says something the missing row did not: this
                        is a measurement that cannot be made here, as against one
                        the panel does not offer. */}
                    <div className="measure-rows">
                        {(result.widths || []).map((w) => (
                            <div className="measure-row" key={w.downDb}>
                                <span className="measure-row__label">−{w.downDb} dB width</span>
                                <span className={`measure-row__value${w.clipped ? ' is-bound' : ''}`}>
                                    {w.widthHz == null ? '—' : `${w.clipped ? '> ' : ''}${formatSpan(w.widthHz)}`}
                                </span>
                            </div>
                        ))}
                        <div className="measure-row">
                            <span className="measure-row__label">Occupied ({settings.obw}%)</span>
                            <span className="measure-row__value">
                                {result.obw ? formatSpan(result.obw.widthHz) : '—'}
                            </span>
                        </div>
                        <div className="measure-row" title="The −60 dB width over the −6 dB one: how brick-wall the thing being measured is. 1 is a perfect filter; under about 2 is a good one.">
                            <span className="measure-row__label">Shape factor</span>
                            <span className={`measure-row__value${result.shape && result.shape.clipped ? ' is-bound' : ''}`}>
                                {result.shape
                                    ? `${result.shape.clipped ? '< ' : ''}${result.shape.ratio.toFixed(2)}:1`
                                    : '—'}
                            </span>
                        </div>
                        <div className="measure-row" title="The spacing of the two strongest tones in the region — an FSK signal's shift, read off the spectrum. A dash means there is only one tone in here that the peak finder will call a tone.">
                            <span className="measure-row__label">Tone spacing</span>
                            <span className="measure-row__value">
                                {result.fsk ? `${Math.round(result.fsk.hz)} Hz` : '—'}
                                {result.fsk && result.fsk.standard && (
                                    <span className="chip">{result.fsk.standard.hz} {result.fsk.standard.name}</span>
                                )}
                            </span>
                        </div>
                    </div>

                    <div className="readout-grid">
                        {card('power', 'Channel power', dbText(stats.powerDb), 'dB rel')}
                        {/* No chart of its own: density is the channel power
                            less a constant, so its line is the same line. */}
                        <Readout label="Density" value={dbText(stats.densityDb)} unit="dB rel/Hz" />
                        {/* How far the peak stands above the average power in
                            the region: high on a carrier, low on noise, and the
                            quickest way to tell one from the other. */}
                        {card('crest', 'Crest', dbText(stats.crestDb), 'dB')}
                        {/* Zero is a flat trace, about −2.5 dB is Gaussian
                            noise, and far below that is something with a
                            structure in it. */}
                        {card('flatness', 'Flatness', dbText(stats.flatnessDb), 'dB')}
                        <span className="measure-wide">
                            <Readout
                                label="Centroid"
                                value={stats.centroidHz == null ? '—' : formatFreqExact(stats.centroidHz)}
                            />
                        </span>
                        {/* Two cards and not one with "10 Hz/bin · 21" in it:
                            that read as a single quantity, and they are two —
                            how fine the measurement can be, and how many samples
                            it is over. */}
                        <Readout label="Resolution" value={formatSpan(result.rbw)} unit="/bin" />
                        <Readout label="Bins" value={result.bins} />
                        {/* The middle of the region itself. Next to the floor
                            it says how much of the box is signal: close to the
                            floor is a box with a signal in it, well above is a
                            box that is mostly signal. */}
                        {card('median', 'Region median', dbText(stats.medianDb), 'dB rel')}
                    </div>
                </>
            )}

            {run && run.frames > 0 && (
                <>
                    <div className="section-label">
                        Over the run
                        <span className="section-label__note">
                            {elapsedText((result.at || Date.now()) - run.startedAt)} · {run.frames} frames
                        </span>
                    </div>
                    <div className="readout-grid">
                        {/* The threshold belongs in the label, not the unit.
                            The unit of this reading is per cent; "over 6 dB" is
                            what it counted, and putting it after the number
                            read as though the receiver measured percent-over-
                            decibels. */}
                        {card(
                            'occupancy',
                            `Occupancy over ${settings.occupancyDb} dB`,
                            busy == null ? '—' : Math.round(busy * 100),
                            busy == null ? '' : '%',
                        )}
                        {/* The distribution, not the trace: one hump and two
                            humps have the same min, max and σ, and are a steady
                            signal and an intermittent one. */}
                        {card(
                            'snr-spread',
                            'SNR range',
                            snrRun ? `${dbText(snrRun.min)} – ${dbText(snrRun.max)}` : '—',
                            snrRun ? 'dB' : '',
                        )}
                        <Readout
                            label="SNR σ"
                            value={snrRun ? dbText(snrRun.sigma) : '—'}
                            unit={snrRun ? 'dB' : ''}
                        />
                        {/* How far the peak wandered. A drifting carrier is the
                            thing this measures, and a range says it where a σ
                            would not: drift is a walk, not a scatter. */}
                        <Readout
                            label="Peak drift"
                            value={wander ? formatSpan(wander.range) : '—'}
                        />
                        <Readout
                            label="Width range"
                            value={widthRun ? `${formatSpan(widthRun.min)} – ${formatSpan(widthRun.max)}` : '—'}
                        />
                        <Readout label="Frames" value={run.frames} />
                    </div>
                </>
            )}

            {!minimal && stats && (
                <>
                    <div className="section-label">Use it</div>
                    <div className="measure-acts">
                        <Button
                            onClick={() => actions.setFrequency(Math.round(stats.peakHz))}
                            title="Move the dial to the strongest thing in the region"
                        >
                            Tune to peak
                        </Button>
                        <Button
                            onClick={() => actions.setFrequency(Math.round(stats.centreHz))}
                            title="Move the dial to the middle of the region as drawn"
                        >
                            Tune to centre
                        </Button>
                        <Button
                            disabled={!dialInside}
                            onClick={() => actions.setBandwidth(
                                Math.round(stats.loHz - tuning.frequency),
                                Math.round(stats.hiHz - tuning.frequency),
                            )}
                            title={dialInside
                                ? 'Set the passband edges to the region, measured from where the dial is now'
                                : 'The dial is outside the region — tune into it first, or the filter would be set around a signal it does not cover'}
                        >
                            Filter to region
                        </Button>
                        <Button
                            onClick={() => actions.setSpectrumView(stats.centreHz, Math.max(stats.widthHz * 3, view.binBandwidth * 16))}
                            title="Zoom the spectrum to the region, with room either side"
                        >
                            Zoom to it
                        </Button>
                        <Button
                            icon={copied ? <Icon.Tick /> : <Icon.Copy />}
                            onClick={copy}
                            title="Copy the whole reading as text, units and caveats included"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    </div>
                </>
            )}

            {!minimal && (
                <>
                    <div className="section-label">Settings</div>
                    <Field
                        label="Widths drawn"
                        hint="the levels below the peak the skirts are measured at"
                    >
                        <div className="chip-row chip-row--wrap">
                            {X_DB_LEVELS.map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    className={`chip chip--button${settings.xDb.includes(d) ? ' is-active' : ''}`}
                                    onClick={() => toggleXdb(d)}
                                    title={`Measure and draw the width ${d} dB below the peak`}
                                >
                                    −{d}
                                </button>
                            ))}
                        </div>
                    </Field>
                    <Field
                        label="Occupied bandwidth"
                        hint="share of the power above the noise floor"
                    >
                        <Segmented
                            size="sm"
                            value={settings.obw}
                            onChange={(v) => saveMeasureSettings({ obw: v })}
                            options={OBW_PERCENTS.map((p) => ({ value: p, label: `${p}%` }))}
                        />
                    </Field>
                    <Field
                        label="Averaging"
                        hint="steadies every level below the peak"
                    >
                        <Segmented
                            size="sm"
                            value={settings.averageMs}
                            onChange={(v) => saveMeasureSettings({ averageMs: v })}
                            options={AVERAGE_MS.map((ms) => ({
                                value: ms,
                                label: ms ? `${ms / 1000} s` : 'Off',
                                title: ms
                                    ? `Average the trace over ${ms / 1000} s before measuring it`
                                    : 'Measure each frame as it arrives — the widths and the floor will move about',
                            }))}
                        />
                    </Field>
                    <Field
                        label="Occupancy threshold"
                        hint={`counted busy above ${settings.occupancyDb} dB SNR`}
                    >
                        <Segmented
                            size="sm"
                            value={settings.occupancyDb}
                            onChange={(v) => saveMeasureSettings({ occupancyDb: v })}
                            options={[3, 6, 10, 20].map((d) => ({ value: d, label: `${d} dB` }))}
                        />
                    </Field>
                </>
            )}
        </div>
    );
}
