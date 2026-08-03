// Live meters. Reads the mutable meters object via useMeters so the sampling
// rate is decoupled from the audio packet rate.

import React, { useEffect, useRef } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Bar, Readout } from '../components/ui.jsx';
import { sUnitFraction, sUnitLabel } from '../lib/format.js';

const HISTORY = 120;   // ~10 s at 12 Hz

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
        const lo = Math.min(0, Math.min(...vals) - 3);
        const hi = Math.max(20, Math.max(...vals) + 3);
        const css = getComputedStyle(document.documentElement);
        const accent = css.getPropertyValue('--accent').trim() || '#5fd8e8';

        ctx.beginPath();
        h.forEach((v, i) => {
            if (v == null) return;
            const x = (i / (HISTORY - 1)) * w;
            const y = ht - ((v - lo) / (hi - lo)) * ht;
            if (i === 0 || h[i - 1] == null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.4 * dpr;
        ctx.stroke();
    }, [m.snr]);

    const power = m.basebandPower;
    const snr = m.snr;

    return (
        <div className="stack">
            <div className="meter">
                <div className="meter__scale">
                    {['1', '3', '5', '7', '9', '+20', '+40', '+60'].map((s) => <span key={s}>{s}</span>)}
                </div>
                {/* Plotted in S-units, not dBFS: the printed scale above is
                    6 dB per step to S9 then 10 dB per step, so a linear dBFS
                    bar would not line up with it or with the S value below. */}
                <Bar value={sUnitFraction(power)} min={0} max={1} tone="signal" />
                <div className="meter__value">{sUnitLabel(power)}</div>
            </div>

            <div className="readout-grid">
                <Readout label="Signal" value={power == null ? '—' : power.toFixed(1)} unit="dBFS" />
                <Readout label="Noise" value={m.noiseDensity == null ? '—' : m.noiseDensity.toFixed(1)} unit="dBFS" />
                <Readout label="SNR" value={snr == null ? '—' : snr.toFixed(1)} unit="dB" tone={snr > 10 ? 'good' : snr > 3 ? 'ok' : 'weak'} />
                <Readout label="Audio" value={(m.level * 100).toFixed(0)} unit="%" />
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
