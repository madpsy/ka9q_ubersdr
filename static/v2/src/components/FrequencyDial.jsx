// The frequency readout, and the primary way to tune.
//
// Each digit is its own hit target: scrolling or dragging over one steps the
// frequency by that digit's place value, which is far quicker than picking a
// step size first. Typing is still available — click the readout to edit, which
// swaps in the shared kHz box (FreqEntry); the readout itself stays in Hz.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { formatHz, clamp } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import FreqEntry from './FreqEntry.jsx';

const DIGITS = 8;   // 30 MHz upper limit needs eight decimal digits

export default function FrequencyDial({ frequency, onChange, disabled }) {
    const [editing, setEditing] = useState(false);
    const dragRef = useRef(null);
    const rootRef = useRef(null);

    // Pointer moves can outrun React's re-render, so the step is applied to a
    // ref rather than to the `frequency` prop captured at render time.
    const freqRef = useRef(frequency);
    freqRef.current = frequency;
    const bump = useCallback((place, steps) => {
        const next = clamp(Math.round(freqRef.current + place * steps), MIN_FREQ, MAX_FREQ);
        freqRef.current = next;
        onChange(next);
    }, [onChange]);

    // Wheel-to-tune has to be a native non-passive listener. React registers
    // its wheel handlers passively, so preventDefault() there is ignored and
    // the dock scrolled along with the digit being tuned.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            if (disabled) return;
            const cell = e.target.closest && e.target.closest('[data-place]');
            if (!cell) return;
            e.preventDefault();
            bump(Number(cell.dataset.place), e.deltaY < 0 ? 1 : -1);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [disabled, bump, editing]);

    if (editing) {
        return (
            <div className="dial dial--editing">
                <FreqEntry
                    frequency={frequency}
                    className="dial__input"
                    onDone={(hz) => { setEditing(false); if (hz != null) onChange(hz); }}
                />
                <span className="dial__unit">kHz</span>
            </div>
        );
    }

    const text = String(Math.round(frequency)).padStart(DIGITS, '0');
    const cells = [];
    for (let i = 0; i < DIGITS; i++) {
        const place = Math.pow(10, DIGITS - 1 - i);
        const leading = i < DIGITS - 1 && Number(text.slice(0, i + 1)) === 0;

        cells.push(
            <span
                key={i}
                className={`dial__digit${leading ? ' is-dim' : ''}`}
                title={`${place >= 1000 ? place / 1000 + ' kHz' : place + ' Hz'} step — scroll or drag`}
                data-place={place}
                onPointerDown={(e) => {
                    if (disabled) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragRef.current = { y: e.clientY, place, acc: 0 };
                }}
                onPointerMove={(e) => {
                    const d = dragRef.current;
                    if (!d) return;
                    const dy = d.y - e.clientY;
                    // One step per 10 px of travel.
                    const steps = Math.trunc(dy / 10);
                    if (steps !== 0) {
                        d.y -= steps * 10;
                        d.acc += steps;
                        bump(d.place, steps);
                    }
                }}
                onPointerUp={(e) => {
                    const d = dragRef.current;
                    dragRef.current = null;
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    // A press that moved nothing is a click: open the editor.
                    if (d && d.acc === 0) setEditing(true);
                }}
            >
                {text[i]}
            </span>
        );
        // Group as MHz.kHz.Hz
        if (i === 1 || i === 4) cells.push(<span key={`s${i}`} className="dial__sep">.</span>);
    }

    return (
        <div className={`dial${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
            <div className="dial__digits">{cells}</div>
            <span className="dial__unit">Hz</span>
        </div>
    );
}

export { formatHz };
