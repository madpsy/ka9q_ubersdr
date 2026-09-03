// Everything the stats readout says, with the moving parts drawn over time.
//
// The readout in the corner of the waterfall is a column of numbers a second
// old — see lib/spectrumStats.js — and that is the right shape for a corner:
// small, glanceable, over the top of the display it is describing. It is the
// wrong shape for the question anybody actually has, which is not "what is the
// frame rate" but "when did it drop, and did the audio drop with it". A number
// cannot answer that and a chart can.
//
// So the same sample feeds both — lib/useStatsSample.js does the gathering —
// and this end of it splits by what the figure is. Things that move get a
// trace on the same ten-second timebase, so a stall shows at the same place in
// every chart and they can be read against one another. Things that stand still
// (how the FFT is configured, what the audio stream is, who is on the receiver,
// which address you are on) get a card, because a flat line is not information.
//
// Collapsed by default, and deliberately. Everything here costs something to
// measure — a listener poll, the host's own /proc read, a frame loop — and a
// collapsed panel is not mounted at all, so on an ordinary session none of it
// runs. It is what you open when the audio stutters, not what you operate with.

import React, { useEffect, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { MOBILE_QUERY, TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Field, Readout } from '../components/ui.jsx';
import { cssVar } from '../lib/audioWaterfall.js';
import {
    chartPoints, chartSurface, curveThrough, strokeCurve, trimBefore, SPAN_MS,
} from '../lib/rollingChart.js';
import useStatsSample from '../lib/useStatsSample.js';
import { formatHzPerBin, statsPlace } from '../lib/spectrumStats.js';

// A little more than the span is kept, because the chart is drawn slightly
// behind live and the segment crossing the left edge starts at a point that has
// already scrolled off it.
const KEEP_MS = 1000;

// How often the counter-derived rates are sampled.
//
// Twice a second rather than the corner readout's once. The readout is a number
// and wants a steady one; a chart wants points, and ten of them across the
// width is a chart you have to squint at to see a shape in. The cost of the
// finer interval is quantisation — a 10/s feed sampled twice a second is five
// frames a bucket, so the trace has a wobble in it the readout does not — which
// is the right trade for a picture whose job is showing when something changed
// rather than exactly what it was.
//
// The one thing that is not sampled at this rate is the host's process stats:
// asking is what makes it measure, so useStatsSample holds those to once a
// second whatever the caller asks for.
const SAMPLE_MS = 500;

// The stacked NET chart's three streams, bottom to top, with the tokens they
// are drawn in. Ordered by how much they usually are and how much can be done
// about them: the spectrum is the bulk of it and has zoom, poll rate and a
// pause behind it; the audio is a fixed drip you cannot tune away; the band
// panel is the one that comes and goes.
const NET_SERIES = [
    { key: 'spec', label: 'Spectrum', token: '--accent', fallback: '#08a2fb' },
    { key: 'audio', label: 'Audio', token: '--good', fallback: '#45d69a' },
    { key: 'band', label: 'Band', token: '--warn', fallback: '#f2b544' },
];

// Bytes per second, in whatever unit keeps the number short.
function formatBytes(v) {
    if (!(v >= 0)) return '—';
    if (v < 1024) return `${Math.round(v)} B/s`;
    if (v < 1024 * 1024) return `${Math.round(v / 1024)} kB/s`;
    return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
}

// One decimal below ten, none above — the corner readout's rule, and for the
// same reason: "8.3" is a reading and "8" is a rounding, but "23.7" is a digit
// of noise on a number that moves.
//
// Deliberately not called formatRate: lib/format.js exports one of those and it
// means something else entirely — bytes a second turned into bits a second, for
// a link speed. Two functions with one name and different units is how a figure
// ends up eight times too big somewhere nobody was looking.
function perSecondText(v) {
    if (!Number.isFinite(v)) return '—';
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

function formatMem(bytes) {
    if (!(bytes > 0)) return '—';
    const mb = bytes / 1e6;
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// The top of a chart's scale.
//
// Always from zero, never from the data's own minimum. These are all rates and
// counts where nought means "stopped", which is the failure every one of these
// charts exists to show; a trace scaled to its own range would draw a stall as
// a line at the bottom of a box that looks exactly like a busy one. The floor
// stops a quiet chart magnifying its own noise into a mountain, and the 15%
// headroom keeps a steady trace off the top edge, where it would be
// indistinguishable from one that is clipping.
function ceilingFor(values, floor) {
    const hi = values.length ? Math.max(...values) : 0;
    return Math.max(floor, hi * 1.15);
}

// A single trace from zero, in one colour. The buffer chart's shape without the
// reference line, which only that one has: there is no "what you asked for" to
// draw a frame rate or a byte rate against.
function drawTrace(canvas, points, now, { floor, token, fallback }) {
    const s = chartSurface(canvas);
    if (!s) return;
    const { ctx, w, ht, dpr } = s;
    if (points.length < 2) return;

    const hi = ceilingFor(points.map((p) => p.v).filter(Number.isFinite), floor);
    const y = (v) => ht - (Math.max(0, Math.min(hi, v)) / hi) * ht;
    const pts = chartPoints(points, now, w, y);

    const colour = cssVar(token, fallback);
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokeCurve(ctx, pts, () => colour);
}

// The three streams stacked, so the height of the whole is what the connection
// is costing and the height of each band is which part to do something about.
//
// Stacked rather than three separate traces because the total is the figure
// somebody is actually watching — an allowance is spent by the sum — and three
// overlaid lines make you add them up by eye. It is also the only arrangement
// where a stream disappearing (the band panel being closed) is visibly a band
// that closes up rather than a line that drops to zero and sits there.
function drawNet(canvas, points, now) {
    const s = chartSurface(canvas);
    if (!s) return;
    const { ctx, w, ht, dpr } = s;
    if (points.length < 2) return;

    // A kilobyte a second of floor: below that the session is idle and the
    // shape of the noise in it is not worth magnifying.
    const hi = ceilingFor(points.map((p) => p.total), 1024);
    const y = (v) => ht - (Math.max(0, Math.min(hi, v)) / hi) * ht;

    // Cumulative, so each band is drawn between the running total below it and
    // the running total including it. An absent stream contributes zero and its
    // band has no height, which is what "closed up" looks like.
    let below = (p) => 0;
    for (const series of NET_SERIES) {
        const under = below;
        const over = (p) => under(p) + (p[series.key] || 0);
        const top = chartPoints(points, now, w, y, over);
        const bottom = chartPoints(points, now, w, y, under);
        if (top.length >= 2 && bottom.length === top.length) {
            ctx.beginPath();
            ctx.moveTo(top[0].x, top[0].y);
            curveThrough(ctx, top);
            const back = bottom.slice().reverse();
            ctx.lineTo(back[0].x, back[0].y);
            curveThrough(ctx, back);
            ctx.closePath();
            // Translucent, so a band under a thin one is still legible and the
            // grid of the panel behind shows through as it does on every other
            // chart here.
            ctx.globalAlpha = 0.45;
            ctx.fillStyle = cssVar(series.token, series.fallback);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        below = over;
    }

    // The total, stroked over the top of the stack: the bands say the split and
    // this says the sum, which is the line the eye follows.
    const total = chartPoints(points, now, w, y, (p) => p.total);
    ctx.lineWidth = 1.4 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokeCurve(ctx, total, () => cssVar('--text-faint', '#5c6779'));
}

// The audio queue, against the ceiling the operator asked for.
//
// The one chart here with a reference line on it, because it is the one with
// something to be read against: a frame rate has no target and a byte rate has
// no budget, but the queue was set to a value in the Audio panel and the whole
// question is whether it is holding it.
function drawBuffer(canvas, points, now, bufferSec) {
    const s = chartSurface(canvas);
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
    const pts = chartPoints(points, now, w, y);

    // Dropouts first, so the trace is drawn over them rather than lost
    // behind. Full height and red: this is the failure the whole chart is
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

// A chart and its caption. The caption is the current value — the chart says
// when and the label says what, and neither is any use on its own.
function Chart({ label, value, note, canvasRef, title }) {
    return (
        <div className="sparkline" title={title}>
            <canvas ref={canvasRef} />
            <span className="sparkline__label sparkline__label--bottom">
                {`${label} `}
                <span className="sparkline__value">{value}</span>
                {note ? ` · ${note}` : ''}
                {', last 10 s'}
            </span>
        </div>
    );
}

function NetLegend() {
    return (
        <div className="stats-legend">
            {NET_SERIES.map((s) => (
                <span className="stats-legend__item" key={s.key}>
                    <i
                        className="stats-legend__swatch"
                        style={{ background: `var(${s.token}, ${s.fallback})` }}
                    />
                    {s.label}
                </span>
            ))}
        </div>
    );
}

// `minimal` keeps the two charts that are about whether the session is working
// — the audio queue and the connection — and drops everything that is about why.
//
// Those two are the ones with a failure in them. The buffer chart draws the
// stutter and the NET chart draws the stall that caused it, and between them
// they answer "is something wrong" without anything else on screen. The frame
// rate, the feed rate and the process load are the follow-up question, which is
// what you expand the panel for; the cards are facts that were true before you
// looked and will be true after; and the overlay control is a setting, which is
// the one thing a cut-down panel is never for. See the registry's `minimal`.
export default function StatsPanel({ minimal }) {
    const { running, audio } = useRadio();
    const display = useDisplay();
    const touch = useMediaQuery(TOUCH_QUERY);
    const mobile = useMediaQuery(MOBILE_QUERY);
    const maxFps = resolveMaxFps(display.maxFps, touch);
    const m = useMeters(15);

    // The buffer trace is on the meters' clock rather than the stats clock: the
    // queue is what the player is doing several times a second, and sampling it
    // twice a second would draw a dropout as a dip rather than the cliff it is.
    // Each entry carries the queue depth and how many dropouts happened in that
    // sample — `underruns` is a running total, so what matters for a chart is
    // the *increase*, which is a moment rather than a level.
    const bufRef = useRef(null);
    const bufHistory = useRef([]);
    const seenUnderruns = useRef(0);

    // Everything else, on the stats clock. Histories in refs and drawn by the
    // frame loop; only the cards are state, because only they are text.
    const fpsRef = useRef(null);
    const fpsHistory = useRef([]);
    const feedRef = useRef(null);
    const feedHistory = useRef([]);
    const netRef = useRef(null);
    const netHistory = useRef([]);
    const cpuRef = useRef(null);
    const cpuHistory = useRef([]);
    const memRef = useRef(null);
    const memHistory = useRef([]);
    const [facts, setFacts] = useState({});

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
        // Keyed on the whole snapshot rather than on the reading, so a sample is
        // taken on every tick of the meter clock and not only when the number
        // moves. A queue sitting steady at its ceiling is a reading like any
        // other, and the chart reporting that all is well must not empty out.
    }, [m]);

    useStatsSample(SAMPLE_MS, (s) => {
        const t = performance.now();
        const cutoff = t - SPAN_MS - KEEP_MS;
        const push = (ref, point) => {
            ref.current.push(point);
            trimBefore(ref.current, cutoff);
        };
        // Every series is kept, including the ones a minimal view is not
        // drawing. They cost a number every half second, and the alternative is
        // that expanding the panel shows four empty boxes that fill in over the
        // following ten seconds — at exactly the moment somebody has expanded it
        // because they want to see what just happened.
        push(fpsHistory, { t, v: s.fps });
        push(feedHistory, { t, v: s.framesIn });
        // Absent streams are zero *here* and nowhere else. The corner readout
        // leaves a missing stream out of its sum, because "+ 0" in a line of
        // figures reads as a stream that has stalled; a stacked chart has no
        // such ambiguity — a band with no height is a stream that is not there,
        // which is exactly what it looks like.
        const spec = s.bytesIn >= 0 ? s.bytesIn : 0;
        const aud = s.audioBytes >= 0 ? s.audioBytes : 0;
        const band = s.bandBytes >= 0 ? s.bandBytes : 0;
        push(netHistory, {
            t, spec, audio: aud, band, total: spec + aud + band,
        });
        const app = s.app || {};
        if (app.cpu != null) push(cpuHistory, { t, v: app.cpu });
        if (app.mem != null) push(memHistory, { t, v: app.mem });

        setFacts({
            fps: s.fps,
            framesIn: s.framesIn,
            net: spec + aud + band,
            binCount: s.binCount,
            binHz: s.binHz,
            divisor: s.divisor,
            streamRate: s.streamRate,
            streamChannels: s.streamChannels,
            outLatSec: s.outLatSec,
            listeners: s.listeners,
            chatUsers: s.chatUsers,
            ip: s.ip,
            cpu: app.cpu,
            mem: app.mem,
        });
    });

    // One loop for every chart in the panel: they show the same ten seconds on
    // the same clock, and six loops would be six wake-ups a frame for one panel.
    useEffect(() => {
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
            drawNet(netRef.current, netHistory.current, now);
            drawTrace(feedRef.current, feedHistory.current, now, {
                floor: 2, token: '--accent', fallback: '#08a2fb',
            });
            drawTrace(fpsRef.current, fpsHistory.current, now, {
                floor: 10, token: '--accent', fallback: '#08a2fb',
            });
            drawBuffer(bufRef.current, bufHistory.current, now, audio.bufferSec);
            drawTrace(cpuRef.current, cpuHistory.current, now, {
                floor: 20, token: '--warn', fallback: '#f2b544',
            });
            drawTrace(memRef.current, memHistory.current, now, {
                floor: 100e6, token: '--warn', fallback: '#f2b544',
            });
            if (capMs) timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, capMs);
            else raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    }, [maxFps, audio.bufferSec]);

    // Only where a host can answer honestly. A browser tab has no way to
    // measure its own process — see lib/appStats.js — and two empty boxes are a
    // worse answer than no boxes.
    const hasApp = facts.cpu != null || facts.mem != null;

    return (
        <div className="stack">
            <Chart
                label="Net"
                value={formatBytes(facts.net)}
                canvasRef={netRef}
                title="Every stream this session is running — the main spectrum, the audio, and the band spectrum panel when it is open — stacked, so the height of the whole is what the connection is costing and each band is which part to do something about."
            />
            <NetLegend />

            {!minimal && (
                <Chart
                    label="Feed"
                    value={perSecondText(facts.framesIn)}
                    note={facts.divisor > 1 ? `1/${Math.round(facts.divisor)} poll` : ''}
                    canvasRef={feedRef}
                    title="Spectrum frames arriving per second. Halves when the idle throttle takes effect, and drops to nothing when the socket is paused."
                />
            )}

            {!minimal && (
                <Chart
                    label="FPS"
                    value={perSecondText(facts.fps)}
                    canvasRef={fpsRef}
                    title="Animation frames per second — the rate the browser is managing, drawn or idle. Well below the screen refresh means this machine is struggling, whatever the receiver is doing."
                />
            )}

            {/* The two counters that used to be beside this, as one picture.
                Their current values stay in the label: the chart says when and
                the label says what, and neither is any use on its own. */}
            <div className="sparkline">
                <canvas ref={bufRef} />
                {/* The queue is a number that changes several times a second,
                    and the caption is anchored by its right edge — so a reading
                    going from 40 to 100 dragged every word before it sideways.
                    The digits get a field of their own, wide enough for the
                    three they can ever need and figures that are all one width,
                    so the words either side hold still while the number
                    underneath them changes. */}
                <span className="sparkline__label sparkline__label--bottom">
                    {'Buffer '}
                    <span className="sparkline__value">{(m.queuedSec * 1000).toFixed(0)}</span>
                    {' ms'}
                    {m.underruns > 0 && ` · ${m.underruns} drop${m.underruns === 1 ? '' : 's'}`}
                    {', last 10 s'}
                </span>
            </div>

            {hasApp && !minimal && (
                <>
                    <Chart
                        label="CPU"
                        value={facts.cpu == null ? '—' : `${Math.round(facts.cpu)}%`}
                        canvasRef={cpuRef}
                        title="What this app is costing the machine it is running on, as a share of one core — so a multi-core machine can legitimately show more than 100%. Only the Android, iOS and desktop clients can measure this."
                    />
                    <Chart
                        label="Memory"
                        value={formatMem(facts.mem)}
                        canvasRef={memRef}
                        title="Real memory this app is using — what the operating system would blame this process for, not the address space it has reserved."
                    />
                </>
            )}

            {/* The standing facts. A card rather than a chart because a flat
                line says nothing: these change when the mode changes, when the
                zoom changes, or when somebody else joins — moments, not
                movements. */}
            {!minimal && (
            <div className="readout-grid stats-cards">
                <Readout label="Bins" value={facts.binCount > 0 ? String(facts.binCount) : '—'} />
                {/* formatHzPerBin prints its own unit, and the label already
                    says what it is the width of — so no `unit` here, which
                    would render "23.4 Hz /bin". */}
                <Readout label="Bin width" value={facts.binHz > 0 ? formatHzPerBin(facts.binHz) : '—'} />
                <Readout label="Users" value={facts.listeners > 0 ? String(Math.round(facts.listeners)) : '—'} />
                {/* Nought and "no chat socket at all" are two different things
                    and this cannot tell them apart — a hidden Chat panel means
                    the second — so neither is printed as a number. */}
                <Readout label="In chat" value={facts.chatUsers > 0 ? String(Math.round(facts.chatUsers)) : '—'} />
                <Readout
                    label="Sample rate"
                    value={facts.streamRate > 0 ? (facts.streamRate / 1000).toFixed(facts.streamRate % 1000 ? 1 : 0) : '—'}
                    unit="kHz"
                />
                {/* Counted rather than named: the mode is what says whether two
                    of them are I/Q or stereo, and a card is not where that is
                    explained. */}
                <Readout label="Channels" value={facts.streamChannels > 0 ? String(Math.round(facts.streamChannels)) : '—'} />
                {/* The half of the audio latency this client does not control,
                    and the reason the buffer chart above is not the whole
                    answer to "how far behind am I". Constant for a given output
                    device, which is what makes it a card. */}
                <Readout
                    label="Output latency"
                    value={facts.outLatSec > 0 ? Math.round(facts.outLatSec * 1000) : '—'}
                    unit="ms"
                />
                {/* At full rate this says the receiver is behaving normally,
                    which the corner readout leaves out for want of space. Here
                    there is room, and a card that appeared only when something
                    was wrong would move everything under it when it did. */}
                <Readout label="Poll" value={facts.divisor > 0 ? `1/${Math.round(facts.divisor)}` : '—'} />
                {/* Full width: an IPv6 address is longer than half a dock
                    column and would wrap inside its card. */}
                <div className="stats-cards__wide">
                    <Readout label="Your address" value={facts.ip || '—'} />
                </div>
            </div>
            )}

            {/* The same setting the Display panel carries, because this is the
                panel somebody is in when they want it. The corner readout and
                these charts are the same figures — you turn the overlay on to
                watch them over the waterfall and off again when you are done,
                and going to Display to do it is a detour through a panel about
                something else. One stored value, so the two controls are two
                views of one switch and cannot disagree. */}
            {!minimal && (
            <Field
                label="Stats overlay"
                hint={display.spectrumStats == null ? 'default for this device' : undefined}
            >
                <select
                    className="select"
                    value={statsPlace(display.spectrumStats, mobile)}
                    onChange={(e) => display.set({ spectrumStats: e.target.value })}
                >
                    <option value="off">None</option>
                    <option value="left">Bottom left</option>
                    <option value="right">Bottom right</option>
                </select>
            </Field>
            )}

            {!running && <div className="note note--tight">Stats are live once the receiver is started.</div>}
        </div>
    );
}
