// The playground's lifetime, kept away from its window.
//
// The playground engine (playground/engine.js) lives as long as the page, for
// the reason IQDemodWatch gives about the IQ Demod panel: closing its window
// must not leave the receiver in IQ with its output ducked and nothing on screen
// to undo either. So, as there, the things it cannot see are pushed in from
// here, and it draws nothing:
//
//   the mode      IQ or not. Nothing is read as quadrature until it is, and the
//                 duck follows the same flag.
//   the volume    what the playground plays follows the receiver's volume and
//                 mute, though not its filter chain.
//   the way out   a receiver switched off, or a mode changed by hand, stops it —
//                 but not while the IQ confirmation is up, or Start from a
//                 listening mode would stop itself before the answer came.
//   a link        a page opened from a playground share link offers its graph,
//                 once, and the link's parameter is taken off the address so a
//                 reload does not offer it again.
//
// It also hosts the playground's window, which has to outlive the IQ Demod
// panel whose button opens it — that panel is unmounted whenever its dock
// section is folded.

import React, { useEffect, useReducer, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { isIQ } from '../radio/constants.js';
import { getPlayground, graphIqWidth } from '../playground/engine.js';
import { decodeShare } from '../playground/share.js';
import PlaygroundModal, { SHARE_PARAM } from '../playground/ui/PlaygroundModal.jsx';
import { offerSharedGraph } from '../playground/ui/store.js';

/**
 * The share code in a page's query string, taken off the address bar, or null.
 * Exported for the test.
 */
export function takeShareCode(loc = typeof location === 'undefined' ? null : location, hist = typeof history === 'undefined' ? null : history) {
    if (!loc) return null;
    const q = new URLSearchParams(loc.search || '');
    const code = q.get(SHARE_PARAM);
    if (!code) return null;
    q.delete(SHARE_PARAM);
    if (hist && hist.replaceState) {
        const rest = q.toString();
        try {
            hist.replaceState(hist.state, '', `${loc.pathname}${rest ? `?${rest}` : ''}${loc.hash || ''}`);
        } catch (err) { /* a sandboxed frame: the offer still stands */ }
    }
    return code;
}

export default function PlaygroundWatch() {
    const { running, tuning, actions, audio, player, iqPrompt, allowedIQModes } = useRadio();
    const pg = getPlayground(player);
    const iq = isIQ(tuning.mode);

    // Read at once, so the address bar is tidied, but offered only once the
    // receiver is running: until then the Start overlay is up, and the
    // playground opening over it would hide the one button that has to be
    // pressed first.
    const [shared, setShared] = useState(null);
    useEffect(() => {
        const code = takeShareCode();
        if (!code) return;
        decodeShare(code).then(setShared);
    }, []);
    useEffect(() => {
        if (!shared || !running) return;
        offerSharedGraph(shared);
        setShared(null);
    }, [shared, running]);

    // The IQ width the graph is built for, and the receiver's, kept together.
    // Each side is acted on only when it is the one that changed, so the two
    // cannot chase each other: the graph's width changing (chosen on the IQ
    // stream block, a graph loaded, an undo) moves the receiver if it is in IQ
    // already — out of IQ, Start does it; the receiver's width changing while
    // the graph runs (the Receiver panel) is written into the graph, so what
    // is saved and shared is what was heard.
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('change', bump), [pg]);
    const want = graphIqWidth(pg.graph);
    const lastWant = useRef(want);
    const lastMode = useRef(tuning.mode);
    useEffect(() => {
        if (want === lastWant.current) return;
        lastWant.current = want;
        if (!want || !iq || want === tuning.mode) return;
        if (want !== 'iq' && !(allowedIQModes || []).includes(want)) return;
        actions.setMode(want);
    });
    useEffect(() => {
        if (tuning.mode === lastMode.current) return;
        lastMode.current = tuning.mode;
        if (!pg.running || pg.offline || !iq || !want || want === tuning.mode) return;
        lastWant.current = tuning.mode;
        for (const n of pg.graph.nodes) {
            if (n.type === 'iq-in') pg.setParams(n.id, { width: tuning.mode });
        }
    });

    useEffect(() => {
        pg.setQuadrature(iq && running);
    }, [pg, iq, running]);

    useEffect(() => {
        pg.setOutput(audio.volume, audio.muted);
    }, [pg, audio.volume, audio.muted]);

    useEffect(() => {
        if (!pg.running) return;
        // A graph playing a file runs whatever the receiver does.
        if (pg.offline) return;
        if (iqPrompt) return;
        if (!running || !iq) {
            pg.restoreMode = null;
            pg.stop();
        }
    }, [pg, running, iq, iqPrompt]);

    return <PlaygroundModal />;
}
