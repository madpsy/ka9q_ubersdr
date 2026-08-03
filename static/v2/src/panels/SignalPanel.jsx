// Live meters. Reads the mutable meters object via useMeters so the sampling
// rate is decoupled from the audio packet rate.

import React, { useEffect, useRef } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Bar, Readout } from '../components/ui.jsx';
import {
    audioLevelPercent, snrColour, snrFraction, sUnitFraction, sUnitLabel,
    SNR_MAX, SNR_MIN, S_UNITS_MAX, S_UNITS_MIN,
} from '../lib/format.js';

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

export default function SignalPanel() {
    const { running } = useRadio();
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

    return (
        <div className="stack">
            <div className="meter">
                <MeterScale ticks={S_TICKS} />
                {/* Plotted in S-units, not dBFS: the printed scale above is
                    6 dB per step to S9 then 10 dB per step, so a linear dBFS
                    bar would not line up with it or with the S value below. */}
                <MeterTrack ticks={S_TICKS}>
                    <Bar value={sUnitFraction(power)} min={0} max={1} tone="signal" />
                </MeterTrack>
                <div className="meter__value">{sUnitLabel(power)}</div>
            </div>

            {/* SNR on v1's meter scale: 30 dB at the left, 60 at the right
                (s-meter-needle.js snrMin/snrMax), filled in the same red→green
                ramp its needle uses. */}
            <div className="meter">
                <MeterScale ticks={SNR_TICKS} />
                <MeterTrack ticks={SNR_TICKS}>
                    <Bar value={snrFraction(snr)} min={0} max={1} color={snr == null ? undefined : snrColour(snr)} />
                </MeterTrack>
                <div className="meter__value">{snr == null ? '--' : `${snr.toFixed(1)} dB`}</div>
            </div>

            <div className="readout-grid">
                <Readout label="Signal" value={power == null ? '—' : power.toFixed(1)} unit="dBFS" />
                <Readout label="Noise" value={m.noiseDensity == null ? '—' : m.noiseDensity.toFixed(1)} unit="dBFS" />
                {/* Coloured on v1's ramp — red at 30 dB, green at 50 — rather
                    than on thresholds of 3 and 10 dB, which every normal
                    reading cleared, so the card was permanently green. */}
                <Readout
                    label="SNR"
                    value={snr == null ? '—' : snr.toFixed(1)}
                    unit="dB"
                    color={snr == null ? undefined : snrColour(snr)}
                />
                {/* Red the moment the output hits full scale — the number
                    itself keeps reading, since RMS barely moves when peaks
                    clip and would otherwise hide it. */}
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
        </div>
    );
}
