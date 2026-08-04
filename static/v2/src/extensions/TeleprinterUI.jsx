// The parts FSK/RTTY and NAVTEX draw the same way.
//
// They are the same decoder with different parameters — see ./teleprinter.js —
// so they show the same things: a console of decoded characters, a meter for
// how far the bit clock has drifted, the audio level, and a spectrum with the
// two tones marked so you can put the signal on them.
//
// Everything here paints under one set of `tp__` class names, which is what
// makes two extensions look like one family rather than two ports of the same
// v1 code with the styling drifted apart.

import React, { memo, useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { subscribeAudioSpectrum } from '../lib/audioSpectrum.js';
import { BAUD_ERROR_MAX, formatTime } from './teleprinter.js';
import { MAX_AUDIO_HZ, drawSpectrum, waveLevelDb } from './toneSpectrum.js';

export const SPECTRUM_H = 120;

/**
 * A number input that commits when you are finished with it.
 *
 * A controlled numeric field fires on every keystroke, and in these panels
 * every commit re-attaches the decoder — so "45.45" would restart it at 4, 45,
 * 45.4 and 45.45 in turn, the first two of which the server refuses outright.
 * Editing happens against a draft string; blur and Enter commit, Escape
 * abandons.
 */
export function NumberField({ label, title, value, limits, disabled, onCommit }) {
    const [draft, setDraft] = useState(String(value));
    const [editing, setEditing] = useState(false);

    // Follow the value while the field is not being edited, so choosing a
    // preset updates it — but never overwrite what is being typed.
    useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

    const commit = () => {
        setEditing(false);
        const n = parseFloat(draft);
        if (Number.isFinite(n)) onCommit(Math.min(limits.max, Math.max(limits.min, n)));
        else setDraft(String(value));
    };

    return (
        <label className="tp__field" title={title}>
            <span className="tp__field-label">{label}</span>
            <input
                className="input tp__num"
                type="number"
                inputMode="decimal"
                min={limits.min}
                max={limits.max}
                step={limits.step}
                disabled={disabled}
                value={draft}
                onChange={(e) => { setEditing(true); setDraft(e.target.value); }}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.currentTarget.blur(); }
                    if (e.key === 'Escape') { setEditing(false); setDraft(String(value)); }
                }}
            />
        </label>
    );
}

/**
 * The baud-error meter: how far the decoder's bit clock is from the rate asked
 * for.
 *
 * It runs either side of centre because the sign says which way to correct — a
 * bar to the right means the signal is faster than the configured baud rate.
 * Near zero and the rate is right; pinned to one end and it is not.
 */
export function BaudMeter({ error }) {
    const e = Number.isFinite(error) ? error : 0;
    const clamped = Math.max(-BAUD_ERROR_MAX, Math.min(BAUD_ERROR_MAX, e));
    const half = (Math.abs(clamped) / BAUD_ERROR_MAX) * 50;
    return (
        <div
            className="tp__baud"
            title="Difference between the configured baud rate and the one the decoder is tracking. Centred means the rate is right"
        >
            <span className="tp__baud-label">Baud err</span>
            <div className="tp__baud-track">
                <span className="tp__baud-zero" />
                <span
                    className={`tp__baud-fill${clamped < 0 ? ' tp__baud-fill--neg' : ''}`}
                    style={clamped < 0
                        ? { right: '50%', width: `${half}%` }
                        : { left: '50%', width: `${half}%` }}
                />
            </div>
            <span className="tp__baud-value">{e.toFixed(1)}</span>
        </div>
    );
}

/**
 * The audio level, in its own component so its 10 Hz tick cannot re-render the
 * console.
 *
 * Same reasoning as FT8's cycle bar: this reads the analyser on every animation
 * frame, and nothing above it needs to know.
 */
export function AudioLevel() {
    const { player } = useRadio();
    const [db, setDb] = useState(-Infinity);
    const last = useRef(0);

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: 2048, bins: false, wave: true }, (f) => {
        const now = performance.now();
        if (now - last.current < 100) return;
        last.current = now;
        setDb(waveLevelDb(f.wave));
    }), [player]);

    const pct = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
    return (
        <div className="tp__level" title="Level of the demodulated audio the decoder is being fed">
            <span className="tp__level-label">Audio</span>
            <div className="tp__level-track"><span className="tp__level-fill" style={{ width: `${pct}%` }} /></div>
            <span className="tp__level-value">{Number.isFinite(db) ? `${db.toFixed(0)} dB` : '−∞ dB'}</span>
        </div>
    );
}

// The 0-3 kHz audio spectrum with the two tones marked. Subscribes to the
// analyser directly and paints the canvas, so no frame of it reaches React.
export function SpectrumStrip({ mark, space, onTune }) {
    const { player } = useRadio();
    const canvas = useRef(null);
    const tones = useRef({ mark, space });
    tones.current = { mark, space };

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: 2048, bins: true }, (f) => {
        drawSpectrum(canvas.current, {
            bins: f.bins,
            binCount: f.binCount,
            sampleRate: f.sampleRate,
            mark: tones.current.mark,
            space: tones.current.space,
            cssHeight: SPECTRUM_H,
        });
    }), [player]);

    return (
        <div
            className="tp__spectrum"
            style={{ height: SPECTRUM_H }}
            title="Audio spectrum, 0–3 kHz. Click a signal to move the dial so it lands on the centre frequency"
            onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width <= 0) return;
                onTune(((e.clientX - rect.left) / rect.width) * MAX_AUDIO_HZ);
            }}
        >
            <canvas ref={canvas} className="tp__spectrum-canvas" />
        </div>
    );
}

/**
 * The decoded characters, as lines.
 *
 * Memoised, and deliberately: the baud error arrives five times a second and
 * the state whenever it changes, both of which re-render the panel. Without
 * this the console's thousand lines would be reconciled every time one of them
 * moved a meter by a pixel.
 */
export const Console = memo(function Console({ lines, timestamps, autoScroll, empty }) {
    const box = useRef(null);

    // Newest is at the bottom here — a console reads downwards — so following
    // it means keeping the bottom in view.
    useEffect(() => {
        if (!autoScroll || !box.current) return;
        box.current.scrollTop = box.current.scrollHeight;
    }, [lines, autoScroll]);

    return (
        <div className="tp__console" ref={box}>
            {lines.length === 0 && <Empty>{empty || 'Nothing decoded yet.'}</Empty>}
            {lines.map((l) => (
                <div key={l.id} className="tp__line">
                    {timestamps && <span className="tp__line-at">{formatTime(l.at)}</span>}
                    <span className="tp__line-text">{l.text}</span>
                </div>
            ))}
        </div>
    );
});
