// The graph as JSON, to edit by hand beside the canvas.
//
// Both ways at once: what is typed reaches the canvas a moment after typing
// stops, and what is done on the canvas shows in the text. Only text that
// reads as a whole graph is used — JSON that parses, and every block, wire
// and parameter in it understood. Anything less is shown as the reason and
// left out, so that a block half-renamed does not vanish from a running graph
// and come back, taking its wires with it.
//
// The text is the operator's while it is theirs: a change on the canvas
// replaces it only when it says what the graph says, or is not being typed in.

import React, { useEffect, useRef, useState } from '../../react.js';
import { parseGraph, serializeGraph } from '../graph.js';

// How long typing has to pause before what is typed is used.
export const JSON_SETTLE_MS = 250;

/** A graph as the pane shows it: its stored form, indented. */
export function graphText(graph) {
    return JSON.stringify(serializeGraph(graph), null, 2);
}

/**
 * What a piece of typed text comes to. `{ graph }` where it is a graph that
 * can be used as it stands; `{ error }` saying why where it is not.
 */
export function readGraphText(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return { error: `Not JSON yet: ${e.message}` };
    }
    const { graph, errors } = parseGraph(raw);
    if (errors.length) return { error: errors.map((e) => e.message).join(' ') };
    return { graph };
}

export default function JsonPane({ graph, onApply, settleMs = JSON_SETTLE_MS }) {
    const current = graphText(graph);
    const [text, setText] = useState(current);
    const [error, setError] = useState(null);
    // The graph's text as last put in the box, or as last taken from it: a
    // graph matching it is one the box already says.
    const synced = useRef(current);
    const focused = useRef(false);
    const timer = useRef(null);

    // A change made elsewhere — the canvas, undo, a template.
    useEffect(() => {
        if (current === synced.current) return;
        // Typing still to be read, or text that does not read yet, in a box
        // being typed in: the operator's, and kept. It replaces the graph
        // once it reads.
        if (focused.current && (timer.current || error)) return;
        synced.current = current;
        setText(current);
        setError(null);
    });

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const use = (value) => {
        timer.current = null;
        const r = readGraphText(value);
        if (r.error) {
            setError(r.error);
            return;
        }
        setError(null);
        // The graph as the canvas will hold it: what makes it come back as
        // the box's own rather than a change to put over what was typed.
        synced.current = graphText(r.graph);
        onApply(r.graph);
    };

    const change = (value) => {
        setText(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => use(value), settleMs);
    };

    // Tab indents rather than leaving the box.
    const key = (e) => {
        if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        const el = e.target;
        if (!el || typeof el.setRangeText !== 'function') return;
        e.preventDefault();
        el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
        change(el.value);
    };

    return (
        <div className="pg-json">
            <textarea
                className="pg-json__text"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-label="The graph as JSON"
                value={text}
                onChange={(e) => change(e.target.value)}
                onKeyDown={key}
                onFocus={() => { focused.current = true; }}
                onBlur={() => { focused.current = false; }}
            />
            <div className={`pg-json__state${error ? ' is-error' : ''}`} role="status">
                {error || 'Edits apply as you type.'}
                {error && text !== current && (
                    <button type="button" className="pg-json__revert" onClick={() => {
                        if (timer.current) clearTimeout(timer.current);
                        timer.current = null;
                        synced.current = current;
                        setText(current);
                        setError(null);
                    }}>Show the graph</button>
                )}
            </div>
        </div>
    );
}
