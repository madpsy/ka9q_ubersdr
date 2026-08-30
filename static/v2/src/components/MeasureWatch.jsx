// The one thing that actually measures. Mounted for the life of the session and
// drawing nothing.
//
// Three components read a measurement — the panel, the overlay on the spectrum,
// and (through the store) anything else that asks — and if each computed its
// own they would disagree by a frame and cost three times as much. More to the
// point, the panel is the one that would naturally own this and it is exactly
// the wrong owner: on a phone the panel lives in a sheet that covers the
// spectrum you are drawing on, so a measurement that only ran while the panel
// was mounted would stop the moment you shut the sheet to see the band. That is
// the case the whole gesture takeover exists to serve.
//
// So it sits beside IdleWatch and the rest in App.jsx, reads frames from the
// spectrum socket directly, and publishes into lib/measureTool.js.
//
// ── Two rates ────────────────────────────────────────────────────────────────
//
// The run — min, max, σ, occupancy — is folded in on *every* frame, because
// those are statements about what the receiver actually sent and sampling them
// would make "busy 40 % of the time" a claim about the sampler. The reading is
// published five times a second, because that is as fast as a row of numbers
// can be read and each publish is a React render in two places.
//
// ── Why the trace is averaged ────────────────────────────────────────────────
//
// Only the peak is stable frame to frame. The floor, the −20 dB points and the
// occupied bandwidth are all measured on noise as much as on signal, and on a
// single frame they move by decibels — enough that the third digit of a width
// is meaningless and the operator can watch it change while nothing else does.
// A second of video averaging turns them into figures worth writing down. It is
// done on a copy: the trace on screen is the receiver's.

import { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { averageTrace } from '../lib/spectrumPeaks.js';
import { isTyping } from '../lib/shortcuts.js';
import { accumulate, frameStats, newRun, readingOf } from '../lib/measure.js';
import {
    measureSettings, measureState, onMeasureSettings, onMeasureState, setMeasureResult,
    stopMeasure,
} from '../lib/measureTool.js';

// How often the reading reaches the screen. Five times a second: fast enough
// that a signal appearing feels immediate, slow enough that the digits can be
// read rather than watched.
const PUBLISH_MS = 200;

/** A key for "the bins mean different frequencies now", which resets the average. */
function geometryKey(view, n) {
    return `${n}:${view.binBandwidth}:${view.centerFreq}`;
}

export default function MeasureWatch() {
    const { running, spectrumConn, view } = useRadio();

    // Everything the loop touches lives in one ref: it is driven by a socket and
    // a timer, not by rendering, and this component deliberately never re-renders.
    const g = useRef({
        // The averaged copy everything is measured on. Deliberately the only
        // copy kept: the array the socket hands over is reused frame to frame,
        // so holding a reference to it would be holding a reference to whatever
        // arrives next.
        avg: null,
        geomKey: '',        // ...and the view it was averaged in
        lastFrame: 0,
        run: null,
        runKey: '',
        lastPublish: 0,
        state: measureState(),
        settings: measureSettings(),
        view,
    });
    g.current.view = view;

    // The loop reads the state through the ref, which costs no render; the one
    // thing this component itself has to re-render for is arming the Escape key.
    const [measureActive, setMeasureActive] = useState(() => measureState().active);
    useEffect(() => onMeasureState((s) => {
        g.current.state = s;
        setMeasureActive(s.active);
    }), []);
    useEffect(() => onMeasureSettings((s) => { g.current.settings = s; }), []);

    // A receiver that has stopped leaves a display whose clicks do not tune and
    // nothing on screen to say why — the tool's badge goes with the spectrum.
    // So the tool goes down with the session rather than waiting to be found.
    useEffect(() => {
        if (!running && measureState().active) stopMeasure();
    }, [running]);

    // Escape stops it, wherever the focus is.
    //
    // Not a rebindable shortcut, and not in lib/shortcuts.js with the rest. This
    // is the way out of a mode — the same thing Escape does to a menu and to a
    // modal — and a way out of a mode that could be unbound, or that an operator
    // had to look up, is not a way out. It is only listened for while the tool
    // is running, so it takes the key from nothing the rest of the time.
    useEffect(() => {
        if (!measureActive) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape' || isTyping(e.target)) return;
            stopMeasure();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [measureActive]);

    useEffect(() => {
        if (!spectrumConn) return undefined;
        const off = spectrumConn.on('frame', ({ bins }) => {
            const s = g.current;
            const now = Date.now();

            // The average runs whether or not anything is being measured, so
            // that starting the tool does not begin with a second of the
            // estimate sweeping up from nothing. It is one pass over a few
            // thousand floats; the peak markers already pay it.
            const key = geometryKey(s.view, bins.length);
            const fresh = key !== s.geomKey || !s.avg || s.avg.length !== bins.length;
            if (fresh) {
                s.avg = Float32Array.from(bins);
                s.geomKey = key;
            } else {
                const tau = s.settings.averageMs;
                if (tau > 0) averageTrace(s.avg, bins, now - s.lastFrame, tau);
                else s.avg.set(bins);
            }
            s.lastFrame = now;

            // Frozen: the reading on screen is being read, and a run that kept
            // counting through it would report an occupancy for a period nobody
            // was watching. The average is left running, so unfreezing resumes
            // rather than sweeping up from stale data.
            const { active, selection, drawing, frozen } = s.state;
            // Stopped, or the region cleared: forget which run was open, so that
            // starting again — or redrawing exactly the same region — begins a
            // fresh one. Without this, Start after Stop quietly carried on
            // accumulating into a run that spans the gap, and the occupancy it
            // reports is then over a period that includes a stretch when nobody
            // was measuring. Freezing is deliberately not in here: a held run
            // resumes as itself.
            if (!active || !selection) s.runKey = '';
            if (!active || !selection || frozen) return;

            // The run belongs to one region. Moving the region starts a new one:
            // a maximum taken partly over one signal and partly over another is
            // not a maximum of anything.
            const runKey = `${selection.loHz}:${selection.hiHz}`;
            if (runKey !== s.runKey) {
                s.runKey = runKey;
                s.run = newRun(now);
            }

            const frame = frameStats(s.avg, s.view, selection, s.settings);

            // Not while the drag is still moving. The numbers are shown live —
            // that is what makes drawing a region feel like aiming rather than
            // guessing — but nothing is accumulated until the region is final.
            if (frame.stats && !drawing) {
                accumulate(s.run, frame.stats, now, {
                    occupancyDb: s.settings.occupancyDb,
                    width: frame.headline,
                });
            }

            if (now - s.lastPublish < PUBLISH_MS) return;
            s.lastPublish = now;
            // The frame's half is handed on so the publishing frame does not
            // measure the same trace twice. The run goes out by reference and
            // has this frame in it already, which is what the accumulate above
            // was for.
            setMeasureResult(readingOf(s.avg, s.view, selection, s.settings, s.run, now, frame));
        });
        return off;
    }, [spectrumConn]);

    return null;
}
