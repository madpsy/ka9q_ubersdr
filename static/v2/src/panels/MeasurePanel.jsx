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
import { Button, Empty, Field, Icon, Readout, Segmented, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { strokeCurve, xAt } from '../lib/rollingChart.js';
import {
    HISTORY_MS, OBW_PERCENTS, X_DB_LEVELS, drift, occupancyOf, reportLines, spreadOf,
} from '../lib/measure.js';
import {
    AVERAGE_MS, clearMeasure, measureSettings, onMeasureSettings, saveMeasureSettings,
    setMeasureFrozen, startMeasure, stopMeasure,
} from '../lib/measureTool.js';
import { useMeasureResult, useMeasureState } from '../lib/useMeasure.js';

// The level-against-time strip, in CSS px. Short: it is there to show the shape
// of a fade, not to be read off — the numbers beside it are the reading.
const CHART_H = 48;

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

/**
 * SNR against time, over the run's window.
 *
 * SNR and not the channel power, though the run keeps both. Power is on the
 * uncalibrated scale, so a chart of it has no y-axis anybody can read; SNR is a
 * difference and is therefore the one of the two that means the same thing on
 * every receiver. It is also the reading the picture is *for* — the depth and
 * period of a fade — and a fade in the signal and a rise in the noise look
 * identical in the power trace and opposite in this one.
 */
function Chart({ run, at }) {
    const ref = useRef(null);

    useEffect(() => {
        const c = ref.current;
        if (!c) return;
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(CHART_H * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);

        const pts = (run && run.history) || [];
        // Read off this canvas rather than through lib/spectrumTrace's
        // themeColors(). That cache is keyed on the theme alone and filled by
        // whichever caller asks first, so a caller with a short list of
        // variables leaves every later caller's missing — and the spectrum's own
        // draw loop is one of them. A getComputedStyle five times a second on
        // one small element is not worth that risk.
        const cs = window.getComputedStyle(c);
        const accent = cs.getPropertyValue('--accent').trim() || '#08a2fb';
        const rule = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.12)';

        // The scale is the data's, with a floor under it: a signal that has not
        // moved for a minute would otherwise be drawn as a mountain range,
        // because auto-scaling a flat line magnifies its noise until it fills
        // the box. Ten decibels is the least the axis may span.
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of pts) {
            if (p.snrDb < lo) lo = p.snrDb;
            if (p.snrDb > hi) hi = p.snrDb;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 10; }
        if (hi - lo < 10) { const mid = (lo + hi) / 2; lo = mid - 5; hi = mid + 5; }
        const pad = (hi - lo) * 0.12;
        lo -= pad;
        hi += pad;

        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeStyle = rule;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        ctx.stroke();

        if (pts.length >= 2) {
            const xy = pts.map((p) => ({
                x: xAt(p.t, at, HISTORY_MS, w),
                y: h - ((p.snrDb - lo) / (hi - lo)) * h,
            }));
            ctx.lineWidth = Math.max(1.2, 1.2 * dpr);
            ctx.lineJoin = 'round';
            strokeCurve(ctx, xy, () => accent);
        }
        return undefined;
    }, [run, at]);

    const s = spreadOf(run && run.snr);
    return (
        <div className="measure-chart">
            <canvas ref={ref} style={{ height: CHART_H }} />
            <div className="measure-chart__axis">
                <span>{s ? `${dbText(s.min)} – ${dbText(s.max)} dB` : ''}</span>
                <span>SNR, last {Math.round(HISTORY_MS / 1000)} s</span>
            </div>
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
                        <Readout label="Width" value={formatSpan(stats.widthHz)} />
                        <Readout label="SNR" value={dbText(stats.snrDb)} unit="dB" />
                        <Readout label="Peak" value={formatFreqExact(stats.peakHz)} />
                        <Readout label="Peak vs dial" value={offsetText(stats.peakHz - tuning.frequency)} />
                        <Readout label="Peak level" value={dbText(stats.peakDb)} unit="dB rel" />
                        {/* The view's floor, not the region's — see
                            selectionStats for the argument. The region's own
                            median is below, under Density, where it reads as
                            what it is: how full the box is. */}
                        <Readout label="Noise floor" value={dbText(stats.floorDb)} unit="dB rel" />
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

                    <div className="measure-rows">
                        {(result.widths || []).map((w) => (
                            <div className="measure-row" key={w.downDb}>
                                <span className="measure-row__label">−{w.downDb} dB width</span>
                                <span className={`measure-row__value${w.clipped ? ' is-bound' : ''}`}>
                                    {w.clipped ? '> ' : ''}{formatSpan(w.widthHz)}
                                </span>
                            </div>
                        ))}
                        {result.obw && (
                            <div className="measure-row">
                                <span className="measure-row__label">Occupied ({result.obw.percent}%)</span>
                                <span className="measure-row__value">{formatSpan(result.obw.widthHz)}</span>
                            </div>
                        )}
                        {result.shape && (
                            <div className="measure-row" title="The −60 dB width over the −6 dB one: how brick-wall the thing being measured is. 1 is a perfect filter; under about 2 is a good one.">
                                <span className="measure-row__label">Shape factor</span>
                                <span className={`measure-row__value${result.shape.clipped ? ' is-bound' : ''}`}>
                                    {result.shape.clipped ? '< ' : ''}{result.shape.ratio.toFixed(2)}:1
                                </span>
                            </div>
                        )}
                        {result.fsk && (
                            <div className="measure-row" title="The spacing of the two strongest tones in the region — an FSK signal's shift, read off the spectrum.">
                                <span className="measure-row__label">Tone spacing</span>
                                <span className="measure-row__value">
                                    {Math.round(result.fsk.hz)} Hz
                                    {result.fsk.standard && (
                                        <span className="chip">{result.fsk.standard.hz} {result.fsk.standard.name}</span>
                                    )}
                                </span>
                            </div>
                        )}
                    </div>

                    <div className="readout-grid">
                        <Readout label="Channel power" value={dbText(stats.powerDb)} unit="dB rel" />
                        <Readout label="Density" value={dbText(stats.densityDb)} unit="dB rel/Hz" />
                        {/* How far the peak stands above the average power in
                            the region: high on a carrier, low on noise, and the
                            quickest way to tell one from the other. */}
                        <Readout label="Crest" value={dbText(stats.crestDb)} unit="dB" />
                        {/* Zero is a flat trace, about −2.5 dB is Gaussian
                            noise, and far below that is something with a
                            structure in it. */}
                        <Readout label="Flatness" value={dbText(stats.flatnessDb)} unit="dB" />
                        <Readout
                            label="Centroid"
                            value={stats.centroidHz == null ? '—' : formatFreqExact(stats.centroidHz)}
                        />
                        <Readout
                            label="Resolution"
                            value={formatSpan(result.rbw)}
                            unit={`/bin · ${result.bins}`}
                        />
                        {/* The middle of the region itself. Next to the floor
                            it says how much of the box is signal: close to the
                            floor is a box with a signal in it, well above is a
                            box that is mostly signal. */}
                        <Readout label="Region median" value={dbText(stats.medianDb)} unit="dB rel" />
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
                        <Readout
                            label="Occupancy"
                            value={busy == null ? '—' : Math.round(busy * 100)}
                            unit={busy == null ? '' : `% over ${settings.occupancyDb} dB`}
                        />
                        <Readout
                            label="SNR range"
                            value={snrRun ? `${dbText(snrRun.min)} – ${dbText(snrRun.max)}` : '—'}
                            unit={snrRun ? 'dB' : ''}
                        />
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
                    {settings.chart && <Chart run={run} at={result.at || Date.now()} />}
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
                    <Switch
                        checked={settings.chart}
                        onChange={(v) => saveMeasureSettings({ chart: v })}
                        label="SNR against time"
                    />
                </>
            )}
        </div>
    );
}
