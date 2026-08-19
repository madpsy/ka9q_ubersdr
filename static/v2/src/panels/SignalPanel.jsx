// Live meters. Reads the mutable meters object via useMeters so the sampling
// rate is decoupled from the audio packet rate.

import React, { useEffect, useRef } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { SQUELCH_MAX, SQUELCH_MIN, SQUELCH_STEP, isIQ } from '../radio/constants.js';
import { Bar, Field, Readout, Slider } from '../components/ui.jsx';
import {
    audioLevelPercent, padReading, sMeterColour, sMeterColourAt, snrColour, snrColourAt,
    snrFraction, sUnitFraction, sUnitLabel, sUnitLabelAt,
    SNR_MAX, SNR_MIN, S_UNITS_MAX, S_UNITS_MIN,
} from '../lib/format.js';
// The theme's own tokens rather than v1's hardcoded slate palette, so a meter
// belongs to whichever theme is on. Cached per theme — this is a draw loop.
import { cssVar } from '../lib/audioWaterfall.js';
import {
    angleAt, arcAngle, geometry, pointAt, stepPeak,
    LABEL_INSET, NEEDLE_GAP, TICK_IN, TICK_OUT,
} from '../lib/needle.js';
import {
    drawLag, medianGap, strokeCurve, trimBefore, xAt, SPAN_MS,
} from '../lib/rollingChart.js';

// A little more than the span is kept, because the chart is drawn slightly
// behind live and the segment crossing the left edge starts at a point that has
// already scrolled off it.
const KEEP_MS = 1000;

// Printed scales, as [label, position 0..1]. The position is computed from the
// same mapping the bar fill uses, because neither scale is linear in its own
// units: the S scale is 6 dB per unit to S9 and 10 dB above it, and both are
// drawn across a fixed-width track. Spacing the labels evenly with
// `space-between` — which is what this did — put them wherever their differing
// text widths landed, so S9+20 read a notch away from where the bar stopped.
const S_TICKS = [['1', 1], ['3', 3], ['5', 5], ['7', 7], ['9', 9], ['+20', 11], ['+40', 13], ['+60', 15]]
    .map(([label, s]) => [label, (s - S_UNITS_MIN) / (S_UNITS_MAX - S_UNITS_MIN)]);

const SNR_TICKS = [SNR_MIN, 0, 10, 20, SNR_MAX].map((v) => [String(v), snrFraction(v)]);

// Labels sit centred on their tick, except the outermost pair, which align to
// the ends of the track so they cannot hang off the panel.
function MeterScale({ ticks }) {
    return (
        <div className="meter__scale">
            {ticks.map(([label, f]) => (
                <span
                    key={label}
                    className="meter__tick"
                    style={{
                        left: `${f * 100}%`,
                        transform: f <= 0 ? 'none' : f >= 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                    }}
                >
                    {label}
                </span>
            ))}
        </div>
    );
}

// The same positions drawn on the track, so it is obvious which notch a reading
// has reached.
function MeterTrack({ ticks, children }) {
    return (
        <div className="meter__track">
            {children}
            <div className="meter__notches">
                {ticks.map(([label, f]) => <i key={label} style={{ left: `${f * 100}%` }} />)}
            </div>
        </div>
    );
}

// Height of a needle meter, CSS px. Together with the panel width this is what
// sets the radius — a meter too wide for it draws a narrower arc rather than
// one with its scale hanging out of the box. See lib/needle.js.
const NEEDLE_H = 74;

// The analogue meter. Takes the same 0..1 position and the same tick list as the
// bar it replaces, so the two are the same instrument drawn two ways.
//
// Drawn on every render, which is the meter sample rate (useMeters), not a frame
// loop: the needle eases toward the reading and the peak decays in wall-clock
// time, so the movement is the same however often the panel is sampled.
function NeedleMeter({ ticks, fraction, peak, colourAt, title }) {
    const ref = useRef(null);
    const anim = useRef({ at: null });

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth;
        const h = NEEDLE_H;
        const pxW = Math.round(w * dpr);
        const pxH = Math.round(h * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
            canvas.width = pxW;
            canvas.height = pxH;
        }

        // v1 eases the needle toward the reading rather than snapping to it —
        // an analogue movement has mass, and without it the needle jitters.
        const a = anim.current;
        const target = Number.isFinite(fraction) ? fraction : 0;
        a.at = a.at == null ? target : a.at + (target - a.at) * 0.35;

        const g = geometry(w, h);
        const c = canvas.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, w, h);

        const faint = cssVar('--text-faint', '#5c6779');
        const strong = cssVar('--border-strong', '#2f3b4e');
        // Both needles take their colour from where they are pointing, as v1's
        // do: the peak needle is the colour that reading *was*, not the colour
        // of the one that has since replaced it.
        const colour = colourAt(a.at);

        // Track, then the travelled part of it in the meter's own colour: the
        // same "how far along" the bar gives, on an arc.
        c.lineWidth = 2;
        c.strokeStyle = strong;
        c.beginPath();
        c.arc(g.cx, g.cy, g.radius, arcAngle(0), arcAngle(1));
        c.stroke();

        c.strokeStyle = colour;
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(g.cx, g.cy, g.radius, arcAngle(0), arcAngle(a.at));
        c.stroke();

        // Ticks inside the arc, each labelled where the bar prints it.
        c.font = `600 ${9.5}px ui-sans-serif, system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        for (const [label, f] of ticks) {
            const p1 = pointAt(g, f, g.radius - TICK_OUT);
            const p2 = pointAt(g, f, g.radius - TICK_IN);
            c.strokeStyle = faint;
            c.lineWidth = 1.5;
            c.beginPath();
            c.moveTo(p1.x, p1.y);
            c.lineTo(p2.x, p2.y);
            c.stroke();

            const lp = pointAt(g, f, g.radius - LABEL_INSET);
            c.fillStyle = faint;
            c.fillText(label, lp.x, lp.y);
        }

        // A tapered triangle from the pivot to the scale, as v1 draws it.
        const needle = (at, halfW) => {
            const tip = pointAt(g, at, g.radius - NEEDLE_GAP);
            const ang = angleAt(at);
            const bx = g.cx + Math.cos(ang - Math.PI / 2) * halfW;
            const by = g.cy - Math.sin(ang - Math.PI / 2) * halfW;
            const cx2 = g.cx + Math.cos(ang + Math.PI / 2) * halfW;
            const cy2 = g.cy - Math.sin(ang + Math.PI / 2) * halfW;
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            c.lineTo(bx, by);
            c.lineTo(cx2, cy2);
            c.closePath();
        };

        // The peak-hold needle, under the live one and thinner: v1's second
        // needle at v1's opacity, narrowed so that when the two meet the live
        // reading still reads as the live reading.
        if (peak != null) {
            c.save();
            c.globalAlpha = 0.6;
            needle(peak, 1.5);
            c.fillStyle = colourAt(peak);
            c.fill();
            c.restore();
        }

        c.save();
        c.shadowColor = 'rgba(0,0,0,0.45)';
        c.shadowBlur = 3;
        c.shadowOffsetY = 1;
        needle(a.at, 2.6);
        c.fillStyle = colour;
        c.fill();
        c.restore();

        // Pivot cap. Mostly off the bottom of the box, which is what sells the
        // idea that the movement continues below the panel.
        c.beginPath();
        c.arc(g.cx, g.cy, 6, 0, Math.PI * 2);
        c.fillStyle = strong;
        c.fill();
        c.strokeStyle = faint;
        c.lineWidth = 1;
        c.stroke();
    });

    return <canvas ref={ref} className="needle" style={{ height: NEEDLE_H }} title={title} />;
}

// The squelch, which lives here rather than in Audio because it is a threshold
// on the SNR this panel meters. The slider carries a live SNR marker and the
// badge says whether the gate is passing audio — both of them the same reading
// the SNR meter above is drawing, so setting the threshold against the noise is
// one glance instead of two panels.
//
// Split out so the 12 Hz meter sampling that drives the marker and the
// open/closed badge re-renders only this control, not the whole panel.
function SquelchControl({ minimal }) {
    const { squelch, actions, tuning } = useRadio();
    const m = useMeters(12);
    const snr = m.snr;
    const open = m.squelchOpen;

    // The server does not gate IQ at all — audioGateAllows is skipped outright
    // for it, because a threshold on the SNR of raw RF samples gates nothing
    // meaningful. Leaving the control live would be the worse failure of the
    // two available: a slider that moves, a badge that says OPEN or CLOSED, and
    // no effect on the audio whatsoever. There is also no SNR to set it
    // against — IQ packets carry a minimal header, so the reading behind this
    // is frozen at whatever arrived first.
    if (isIQ(tuning.mode)) {
        return (
            <Field label="Squelch" hint="Unavailable">
                <div className="note note--tight">
                    Not available in IQ mode: the receiver does not gate a
                    quadrature stream, and there is no live SNR to gate on.
                </div>
            </Field>
        );
    }

    return (
        <>
            <Field
                label="Squelch"
                hint={squelch.enabled ? `≥ ${squelch.value.toFixed(1)} dB SNR` : 'Off'}
            >
                {/* Auto sits with the slider rather than below it: it sets the
                    same number the slider does, and it is the one action worth
                    having in the minimal view, where the state line below is
                    dropped. */}
                <div className="squelch-row">
                    <Slider
                        value={squelch.value}
                        min={SQUELCH_MIN}
                        max={SQUELCH_MAX}
                        step={SQUELCH_STEP}
                        onChange={actions.setSquelch}
                        marker={snr == null ? null : snr}
                        markerTone={squelch.enabled && !open ? 'closed' : 'open'}
                        markerTitle={snr == null ? undefined : `Current SNR: ${snr.toFixed(1)} dB`}
                    />
                    <button
                        type="button"
                        className="chip chip--button"
                        title="Set the threshold just above the recent noise level"
                        disabled={snr == null}
                        onClick={actions.autoSquelch}
                    >
                        Auto
                    </button>
                </div>
            </Field>
            {/* The state and the off switch, full view only. Minimal carries
                the state twice over already — the SNR meter is directly above,
                and the marker on the slider is drawn in the gate's own colour —
                and dragging the slider to the floor is the same thing Off does. */}
            {!minimal && (
                <div className="squelch-status">
                    {/* badge--sq holds the width across all three words — see
                        the spectrum toolbar's tag, which has the same problem. */}
                    <span className={`badge badge--sq badge--${!squelch.enabled ? 'idle' : open ? 'open' : 'closed'}`}>
                        {!squelch.enabled ? 'DISABLED' : open ? 'OPEN' : 'CLOSED'}
                    </span>
                    <span className="squelch-status__snr">
                        SNR {snr == null ? '--' : padReading(snr, 2)}
                    </span>
                    {/* Disabled rather than absent when the squelch is already
                        off, so the row keeps its shape and the control stays
                        where you last saw it. */}
                    <button
                        type="button"
                        className="chip chip--button"
                        title="Switch the squelch off"
                        disabled={!squelch.enabled}
                        onClick={() => actions.setSquelch(SQUELCH_MIN)}
                    >
                        Off
                    </button>
                </div>
            )}
        </>
    );
}

// Ready a canvas for this frame: size it to its box and hand back a context
// with the box's pixel dimensions. Returns null when there is nothing to draw
// on — a collapsed dock leaves the canvas at zero, and a chart drawn into
// nothing is a frame's work thrown away.
function surface(c) {
    if (!c) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const ht = Math.round(c.clientHeight * dpr);
    if (!w || !ht) return null;
    if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, ht);
    return { ctx, w, ht, dpr };
}

// Where each reading sits on this frame's canvas.
//
// `now` is held one sample-interval back — see drawLag — so the right-hand edge
// is a moment for which the trace is already known, and the newest reading
// slides in from beyond the edge rather than appearing at it. Points either
// side of the visible span are kept and simply drawn off it: the segments
// crossing both edges have to come from somewhere, and the canvas clips.
function place(points, now, w, y, value = (p) => p.v) {
    const at = now - drawLag(medianGap(points));
    const out = [];
    for (const p of points) {
        const v = value(p);
        if (v == null) continue;
        out.push({ x: xAt(p.t, at, SPAN_MS, w), y: y(v), p });
    }
    return out;
}

function drawSnr(canvas, points, now) {
    const s = surface(canvas);
    if (!s) return;
    const { ctx, w, ht, dpr } = s;
    const vals = points.filter((p) => p.v != null).map((p) => p.v);
    if (vals.length < 2) return;

    // v1's rule (app.js drawSnrHistoryChart): pad by 10% of the span with a
    // 2 dB floor, and always show at least 10 dB — so a quiet channel does not
    // get magnified into a noise mountain.
    //
    // v1 also clamps the floor at 0 dB, which this deliberately does not. That
    // clamp was safe while the figure was power over noise *density*, sitting
    // around 30–60 dB·Hz and never negative. A real SNR is negative on an empty
    // channel, and holding the axis at 0 would flatten the trace against the
    // bottom of the chart exactly when someone is looking to see whether there
    // is anything there at all.
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max(2, (hi - lo) * 0.1);
    lo -= pad;
    hi += pad;
    if (hi - lo < 10) {
        const mid = (hi + lo) / 2;
        lo = mid - 5;
        hi = mid + 5;
    }

    const y = (v) => ht - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ht;
    // A break in the readings is a break in the line: a null is the meter
    // saying it had nothing, and joining across it would draw a signal that was
    // never measured. Each unbroken run is its own curve.
    const runs = [];
    let run = [];
    for (const p of points) {
        if (p.v == null) { if (run.length) runs.push(run); run = []; continue; }
        run.push(p);
    }
    if (run.length) runs.push(run);

    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const r of runs) {
        const pts = place(r, now, w, y);
        // Coloured per segment on v1's ramp, so the trace says how good the
        // signal is and not just how it moved.
        strokeCurve(ctx, pts, (i) => snrColour(pts[i].p.v));
    }
}

function drawBuffer(canvas, points, now, bufferSec) {
    const s = surface(canvas);
    if (!s) return;
    const { ctx, w, ht, dpr } = s;
    if (points.length < 2) return;

    // The scale is the operator's own ceiling, not the data: this chart is
    // read against "what did I ask for", and a trace that renormalised as
    // the queue drained would hide exactly the drain worth seeing. A little
    // headroom above it, because the queue is allowed to sit at the limit.
    const ceiling = Math.max(50, (bufferSec || 0.2) * 1000);
    const hi = Math.max(ceiling * 1.15, ...points.map((p) => p.v));
    const y = (v) => ht - (Math.max(0, Math.min(hi, v)) / hi) * ht;
    const pts = place(points, now, w, y);

    // Dropouts first, so the trace is drawn over them rather than lost
    // behind. Full height and red: this is the failure the whole panel is
    // watching for, and it is a moment, not a level. Each keeps its place in
    // time and scrolls with the trace, which is the point of marking it here
    // rather than counting it in a corner.
    ctx.fillStyle = cssVar('--bad', '#f2646a');
    for (const q of pts) {
        if (!q.p.drops) continue;
        ctx.fillRect(Math.round(q.x) - dpr / 2, 0, Math.max(1, 1.5 * dpr), ht);
    }

    // What was asked for, as a line to read the trace against.
    ctx.strokeStyle = cssVar('--border-strong', 'rgba(255,255,255,0.18)');
    ctx.lineWidth = dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, y(ceiling));
    ctx.lineTo(w, y(ceiling));
    ctx.stroke();
    ctx.setLineDash([]);

    const accent = cssVar('--accent', '#4aa8ff');
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokeCurve(ctx, pts, () => accent);
}

// `minimal` keeps the two meters and the squelch — what you watch and what you
// ride — and drops the numeric readouts, the SNR trace and the buffer counters.
// See the registry's `minimal`.
export default function SignalPanel({ minimal }) {
    const { running, audio } = useRadio();
    const display = useDisplay();
    const touch = useMediaQuery(TOUCH_QUERY);
    const maxFps = resolveMaxFps(display.maxFps, touch);
    const m = useMeters(15);
    const canvasRef = useRef(null);
    const history = useRef([]);
    // The buffer's own trace, sampled on the same clock and drawn the same way.
    // Each entry carries the queue depth and how many dropouts happened in that
    // sample — `underruns` is a running total, so what matters for a chart is
    // the *increase*, which is a moment rather than a level.
    const bufRef = useRef(null);
    const bufHistory = useRef([]);
    const seenUnderruns = useRef(0);

    // Sampling only. Both traces are drawn by the frame loop below, on the
    // display's clock rather than the meters' — see lib/rollingChart.js.
    useEffect(() => {
        const h = history.current;
        h.push({ t: performance.now(), v: m.snr == null ? null : m.snr });
        trimBefore(h, performance.now() - SPAN_MS - KEEP_MS);
        // Keyed on the whole snapshot rather than on the reading, so a sample
        // is taken on every tick of the meter clock and not only when the
        // number moves. A steady signal is a reading like any other: keyed on
        // the value, a channel that sat still for ten seconds would have its
        // last point scroll off the left with nothing behind it, and the chart
        // would empty out exactly when it was reporting that all was well.
    }, [m]);

    useEffect(() => {
        const h = bufHistory.current;
        const total = Number.isFinite(m.underruns) ? m.underruns : 0;
        // Counters only ever climb, except across a reconnect where the player
        // starts again from zero — treated as no dropouts rather than as a
        // negative burst.
        const drops = total > seenUnderruns.current ? total - seenUnderruns.current : 0;
        seenUnderruns.current = total;
        h.push({ t: performance.now(), v: Math.max(0, (m.queuedSec || 0) * 1000), drops });
        trimBefore(h, performance.now() - SPAN_MS - KEEP_MS);
        // On the meter clock, as above.
    }, [m]);

    // One loop for both charts: they show the same ten seconds on the same
    // clock, and two loops would be two wake-ups a frame for one panel.
    useEffect(() => {
        if (minimal) return undefined;
        let raf = 0;
        let timer = 0;
        // The display's own frame cap, honoured here as everywhere: this panel
        // is not worth a paint the spectrum has been told not to take. Capped,
        // the wait is a timer and the paint is still an animation frame, so
        // nothing is scheduled between ticks and a hidden tab stops dead — the
        // same shape as the spectrum's loop, and the reason for it is written
        // out there.
        const capMs = maxFps > 0 ? 1000 / maxFps : 0;

        const frame = () => {
            const now = performance.now();
            drawSnr(canvasRef.current, history.current, now);
            drawBuffer(bufRef.current, bufHistory.current, now, audio.bufferSec);
            if (capMs) timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, capMs);
            else raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    }, [minimal, maxFps, audio.bufferSec]);


    const power = m.basebandPower;
    const snr = m.snr;
    const sFraction = sUnitFraction(power);

    // Peak hold lives here rather than inside the meter, so one number drives
    // the hold needle, the bar's peak marker and the S value printed beside the
    // live one — three readings that must never disagree. Carried as a position
    // on the scale, like everything else the meters take.
    const peak = useRef(null);
    const peakAt = useRef(0);
    useEffect(() => {
        const now = performance.now();
        const dt = peakAt.current ? Math.min(0.5, (now - peakAt.current) / 1000) : 0;
        peakAt.current = now;
        peak.current = stepPeak(peak.current, sFraction, dt);
    });
    // Nothing heard yet, or a peak still on the stop: no hold worth showing.
    // The bottom of the scale is S1, so a hold of 0 cannot say whether it means
    // S1 or the silence below it — and silence is what it almost always is.
    const held = power != null && power > -998 && peak.current && peak.current.value > 0
        ? peak.current.value
        : null;

    // One style for both meters, and it is a display setting like any other, so
    // it survives a reload. Clicking either one switches both: they are a pair,
    // and a needle above a bar reads as a fault rather than a choice.
    const needle = display.meterStyle === 'needle';
    const swap = () => display.set({ meterStyle: needle ? 'bar' : 'needle' });
    const hint = needle ? 'Click for the bar meters' : 'Click for the needle meters';

    return (
        <div className="stack">
            {/* Plotted in S-units, not dBFS: the printed scale is 6 dB per step
                to S9 then 10 dB per step, so a linear dBFS bar — or needle —
                would not line up with it or with the S value below. */}
            <button type="button" className="meter meter--swap" onClick={swap} title={hint}>
                {needle ? (
                    <NeedleMeter
                        ticks={S_TICKS}
                        fraction={sFraction}
                        peak={held}
                        colourAt={sMeterColourAt}
                        title={hint}
                    />
                ) : (
                    <>
                        <MeterScale ticks={S_TICKS} />
                        <MeterTrack ticks={S_TICKS}>
                            <Bar
                                value={sFraction}
                                min={0}
                                max={1}
                                peak={held}
                                color={sMeterColour(power)}
                            />
                        </MeterTrack>
                    </>
                )}
                {/* Live reading, then the peak hold — "S4   S6" — in the one
                    size: they are the same measurement a moment apart, and
                    shrinking the second one makes it read as a footnote. */}
                <div className="meter__value">
                    <span className="meter__num">{sUnitLabel(power)}</span>
                    {/* Kept in the layout even with no hold to show, so the
                        live value does not shift sideways the moment one
                        appears — see .meter__num in the stylesheet. */}
                    <span className={`meter__num${held == null ? ' is-blank' : ''}`}>
                        {held == null ? '' : sUnitLabelAt(held)}
                    </span>
                </div>
            </button>

            {/* SNR from SNR_MIN at the left to SNR_MAX at the right, in a
                red→green ramp. No longer v1's 30–60 scale: that was calibrated
                against the old S/N0 figure in dB·Hz, and this is an SNR in dB.
                No peak hold here, as in v1. */}
            <button type="button" className="meter meter--swap" onClick={swap} title={hint}>
                {needle ? (
                    <NeedleMeter
                        ticks={SNR_TICKS}
                        fraction={snrFraction(snr)}
                        colourAt={snrColourAt}
                        title={hint}
                    />
                ) : (
                    <>
                        <MeterScale ticks={SNR_TICKS} />
                        <MeterTrack ticks={SNR_TICKS}>
                            <Bar value={snrFraction(snr)} min={0} max={1} color={snr == null ? undefined : snrColour(snr)} />
                        </MeterTrack>
                    </>
                )}
                <div className="meter__value">
                    {/* The S meter above needs no unit — "S7" says what it is —
                        but a bare "42.3 dB" does not: this panel has a squelch
                        threshold in dB under it and a filter width in dB nowhere
                        near it, and a number with a unit and no name is the one
                        that gets misread. Small, unbolded and dimmed, so it reads
                        as the label on the reading rather than part of it. Kept
                        when there is nothing to show, so the line does not change
                        shape the moment a signal arrives. */}
                    {/* padReading, not toFixed: the slot is centred, so a
                        reading that gains a minus sign gets a character wider
                        and re-centres, shoving the whole line sideways. Now
                        that the SNR crosses zero on ordinary quiet air that
                        happens several times a second. Two integer digits
                        covers the meter's -5..30 and then some. */}
                    <span className="meter__num meter__num--snr">
                        {snr == null ? '--' : `${padReading(snr, 2)} dB`}
                        <span className="meter__unit">SNR</span>
                    </span>
                </div>
            </button>

            {/* In the minimal view too: the meters say what is there and this is
                the one control you reach for while listening to it. */}
            <SquelchControl minimal={minimal} />

            {!minimal && (
                <>
                    <div className="readout-grid">
                        {/* Both sit around -90 dBFS and wander past -100, which
                            is a character more: the unit jumped sideways with
                            every reading, and the digits shuffled under the
                            sign. padReading holds the decimal point still and
                            the reservation holds the box when there is nothing
                            to show at all. Six is "-100.5". The other two cards
                            do neither — see Readout. */}
                        <Readout label="Signal" value={padReading(power)} unit="dBFS" reserve={6} />
                        {/* The noise in the same passband the signal is measured
                            over, so the two cards are directly comparable and
                            their difference is the SNR card. This used to show
                            radiod's density N0, which is dBFS/Hz — a number
                            about 34 dB lower that could not be compared with
                            the signal beside it. */}
                        <Readout label="Noise" value={padReading(m.noisePower)} unit="dBFS" reserve={6} />
                        {/* Red at 0 dB, green from 15 — see SNR_COLOUR_MIN/MAX.
                            Thresholds of 3 and 10 dB were tried once and left
                            the card permanently green, but that was against the
                            old dB·Hz figure, which cleared them on empty air.
                            Against a real SNR those numbers mean what they
                            look like, and the ramp is close to them. */}
                        {/* padReading and a reservation, as the two cards above
                            have: without them a reading crossing zero changes
                            width and the number walks about inside its card. */}
                        <Readout
                            label="SNR"
                            value={snr == null ? '—' : padReading(snr, 2)}
                            unit="dB"
                            reserve={5}
                            color={snr == null ? undefined : snrColour(snr)}
                        />
                        {/* Red the moment the output hits full scale — the
                            number itself keeps reading, since RMS barely moves
                            when peaks clip and would otherwise hide it. */}
                        <Readout
                            label={m.clipping ? 'Audio · clip' : 'Audio'}
                            value={audioLevelPercent(m.level).toFixed(0)}
                            unit="%"
                            color={m.clipping ? 'var(--bad)' : undefined}
                        />
                    </div>

                    <div className="sparkline">
                        <canvas ref={canvasRef} />
                        <span className="sparkline__label">SNR, last 10 s</span>
                    </div>

                    {/* The two counters that used to be here, as one picture.
                        Their current values stay in the label: the chart says
                        when and the label says what, and neither is any use on
                        its own. */}
                    <div className="sparkline">
                        <canvas ref={bufRef} />
                        {/* The queue is a number that changes several times a
                            second, and the caption is anchored by its right
                            edge — so a reading going from 40 to 100 dragged
                            every word before it sideways. The digits get a
                            field of their own, wide enough for the three they
                            can ever need and figures that are all one width, so
                            the words either side hold still while the number
                            underneath them changes. */}
                        <span className="sparkline__label sparkline__label--bottom">
                            {'Buffer '}
                            <span className="sparkline__value">{(m.queuedSec * 1000).toFixed(0)}</span>
                            {' ms'}
                            {m.underruns > 0 && ` · ${m.underruns} drop${m.underruns === 1 ? '' : 's'}`}
                            {', last 10 s'}
                        </span>
                    </div>

                    {!running && <div className="note note--tight">Meters are live once the receiver is started.</div>}
                </>
            )}
        </div>
    );
}
