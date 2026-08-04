// Live meters. Reads the mutable meters object via useMeters so the sampling
// rate is decoupled from the audio packet rate.

import React, { useEffect, useRef } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Bar, Readout } from '../components/ui.jsx';
import {
    audioLevelPercent, sMeterColour, sMeterColourAt, snrColour, snrColourAt,
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

const HISTORY = 120;   // ~10 s at 12 Hz

// Printed scales, as [label, position 0..1]. The position is computed from the
// same mapping the bar fill uses, because neither scale is linear in its own
// units: the S scale is 6 dB per unit to S9 and 10 dB above it, and both are
// drawn across a fixed-width track. Spacing the labels evenly with
// `space-between` — which is what this did — put them wherever their differing
// text widths landed, so S9+20 read a notch away from where the bar stopped.
const S_TICKS = [['1', 1], ['3', 3], ['5', 5], ['7', 7], ['9', 9], ['+20', 11], ['+40', 13], ['+60', 15]]
    .map(([label, s]) => [label, (s - S_UNITS_MIN) / (S_UNITS_MAX - S_UNITS_MIN)]);

const SNR_TICKS = [SNR_MIN, 40, 50, SNR_MAX].map((v) => [String(v), snrFraction(v)]);

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

// `minimal` keeps the two meters and drops the numeric readouts, the SNR trace
// and the buffer counters. See the registry's `minimal`.
export default function SignalPanel({ minimal }) {
    const { running } = useRadio();
    const display = useDisplay();
    const m = useMeters(15);
    const canvasRef = useRef(null);
    const history = useRef([]);

    useEffect(() => {
        const h = history.current;
        h.push(m.snr == null ? null : m.snr);
        if (h.length > HISTORY) h.shift();

        const c = canvasRef.current;
        if (!c) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = c.clientWidth * dpr;
        const ht = c.clientHeight * dpr;
        if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; }
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, w, ht);

        const vals = h.filter((v) => v != null);
        if (vals.length < 2) return;

        // v1's rule (app.js drawSnrHistoryChart): pad by 10% of the span with a
        // 2 dB floor, never go below 0 dB, and always show at least 10 dB — so a
        // quiet channel does not get magnified into a noise mountain. Forcing 0
        // and 20 into view, as this used to, squashed the trace against the top:
        // SNR here is power over noise *density*, which sits around 30–60 dB.
        let lo = Math.min(...vals);
        let hi = Math.max(...vals);
        const pad = Math.max(2, (hi - lo) * 0.1);
        lo = Math.max(0, lo - pad);
        hi += pad;
        if (hi - lo < 10) {
            const mid = (hi + lo) / 2;
            lo = Math.max(0, mid - 5);
            hi = mid + 5;
        }

        const x = (i) => (i / (HISTORY - 1)) * w;
        const y = (v) => ht - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ht;

        // Coloured per sample on v1's ramp, so the trace says how good the
        // signal is and not just how it moved.
        ctx.lineWidth = 1.6 * dpr;
        for (let i = 1; i < h.length; i++) {
            if (h[i] == null || h[i - 1] == null) continue;
            ctx.strokeStyle = snrColour(h[i]);
            ctx.beginPath();
            ctx.moveTo(x(i - 1), y(h[i - 1]));
            ctx.lineTo(x(i), y(h[i]));
            ctx.stroke();
        }
    }, [m.snr]);

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
                {/* Live reading, then the peak hold — "S4 / S6" — in the one
                    size: they are the same measurement a moment apart, and
                    shrinking the second one makes it read as a footnote. */}
                <div className="meter__value">
                    {sUnitLabel(power)}
                    {held != null && ` / ${sUnitLabelAt(held)}`}
                </div>
            </button>

            {/* SNR on v1's meter scale: 30 dB at the left, 60 at the right
                (s-meter-needle.js snrMin/snrMax), in the same red→green ramp its
                needle uses. No peak hold here, as in v1. */}
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
                <div className="meter__value">{snr == null ? '--' : `${snr.toFixed(1)} dB`}</div>
            </button>

            {!minimal && (
                <>
                    <div className="readout-grid">
                        <Readout label="Signal" value={power == null ? '—' : power.toFixed(1)} unit="dBFS" />
                        <Readout label="Noise" value={m.noiseDensity == null ? '—' : m.noiseDensity.toFixed(1)} unit="dBFS" />
                        {/* Coloured on v1's ramp — red at 30 dB, green at 50 —
                            rather than on thresholds of 3 and 10 dB, which every
                            normal reading cleared, so the card was permanently
                            green. */}
                        <Readout
                            label="SNR"
                            value={snr == null ? '—' : snr.toFixed(1)}
                            unit="dB"
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

                    <div className="readout-grid">
                        <Readout label="Buffer" value={(m.queuedSec * 1000).toFixed(0)} unit="ms" tone={m.queuedSec < 0.05 ? 'weak' : 'ok'} />
                        <Readout label="Underruns" value={m.underruns} />
                    </div>

                    {!running && <div className="note note--tight">Meters are live once the receiver is started.</div>}
                </>
            )}
        </div>
    );
}
