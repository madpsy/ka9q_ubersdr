// What the two control panels — SDR Control and Radio Control — share.
//
// They were one panel until the sources were split apart, and the split left
// three things neither of them owns alone: the saved settings blob, the radio
// facade a source calls into, and the message log. All three are here so the
// panels differ only in the hardware they drive.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { controlState, onControlState, updateControlState } from './mappings.js';

const MAX_MESSAGES = 60;

// The settings blob, shared between both panels — see the store in mappings.js
// for why it cannot simply be component state.
export function useControlState() {
    const [cfg, setCfg] = useState(controlState);
    useEffect(() => onControlState(setCfg), []);
    return [cfg, updateControlState];
}

// The facade a source calls into when hardware moves.
//
// Sources run outside React and outlive any single render, so they read the
// current radio through a ref rather than closing over the render that happened
// to create them. The object identity never changes, which is what lets it be
// handed to a singleton once.
export function useControlContext(stepHz) {
    const radio = useRadio();
    const ref = useRef(null);
    ref.current = {
        actions: radio.actions,
        stepHz,
        state: () => ({
            tuning: radio.tuning,
            audio: radio.audio,
            squelch: radio.squelch,
            dsp: radio.dsp,
        }),
    };
    return useMemo(() => ({
        get actions() { return ref.current.actions; },
        get stepHz() { return ref.current.stepHz; },
        state: () => ref.current.state(),
    }), []);
}

// Panel-local: each panel logs only what its own hardware said.
export function useMessages() {
    const [messages, setMessages] = useState([]);
    const push = useCallback((text, tone = 'info') => {
        const at = new Date();
        setMessages((prev) => [{ at, text, tone, id: `${at.getTime()}-${Math.random()}` }, ...prev].slice(0, MAX_MESSAGES));
    }, []);
    const clear = useCallback(() => setMessages([]), []);
    return [messages, push, clear];
}

export function MessageLog({ messages, onClear }) {
    if (!messages.length) return null;
    return (
        <>
            <div className="divider" />
            <span className="section-label">
                Messages
                <button type="button" className="section-label__note rc-log__clear" onClick={onClear}>clear</button>
            </span>
            <div className="log">
                {messages.map((m) => (
                    <div key={m.id} className={`log__row${m.tone === 'error' ? ' log__row--error' : m.tone === 'warn' ? ' log__row--warn' : ''}`}>
                        <span className="log__time">{m.at.toLocaleTimeString()}</span>
                        <span className="log__text">{m.text}</span>
                    </div>
                ))}
            </div>
        </>
    );
}
