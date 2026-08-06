// Close the spectrum socket while nobody is looking at the tab.
//
// This is v1's behaviour (spectrum-display.js setupVisibilityDisconnect),
// reproduced: hidden for HIDDEN_SUSPEND_MS and the socket goes, visible again
// and it comes back at the view it left. It is worth having on both machines and
// for the same reason — a backgrounded tab is a receiver slot producing a
// waterfall for a canvas nobody can see, at the server's expense as much as the
// listener's — so unlike most of the mobile work there is no device test here.
//
// Why a close rather than the idle throttle's half rate: the throttle is for an
// operator who is *present* and has stopped doing anything, where the display
// still has to be right when they look back at it. A hidden tab has no such
// requirement. The two coexist — a tab can be throttled and then hidden — and
// they do not have to agree, because the socket that carried the rate is the one
// being closed. (SpectrumConnection re-sends the rate on open, so it is not lost
// either.)
//
// The audio socket is deliberately left alone. Listening with the tab in the
// background is the whole point of the media session controls, and the spectrum
// is the only part of this that nobody can see.
//
// The rules are in lib/visibilityPause.js, where they can be tested without
// waiting five seconds for each one; this is the wiring. What it actually does to
// the socket is lib/spectrumPause.js, shared with the idle pause so the two close
// and reopen it the same way — the pair has two traps in it and neither is
// visible when you get it wrong.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { HIDDEN_SUSPEND_MS } from '../radio/idle.js';
import { visibilityPause } from '../lib/visibilityPause.js';
import { resumeSpectrum, suspendSpectrum } from '../lib/spectrumPause.js';

export default function VisibilityWatch() {
    const { running, spectrumConn } = useRadio();

    useEffect(() => {
        // Nothing to suspend, and nothing to bring back: the sockets belong to a
        // session that is not up.
        if (!running || !spectrumConn) return undefined;

        const pause = visibilityPause({
            delayMs: HIDDEN_SUSPEND_MS,
            isHidden: () => document.hidden,
            isOpen: () => spectrumConn.connected,
            // Both of these are lib/spectrumPause.js: a disconnect rather than a
            // bare close, and a reopen that names the view it left. Why, in both
            // cases, is documented there.
            //
            // Not marked as paused, though — that flag is the idle pause's, and
            // it puts an overlay on the display. A hidden tab is nobody's to look
            // at and brings itself back, so marking it would only leave an
            // overlay over a live spectrum for the operator to find.
            suspend: () => suspendSpectrum(spectrumConn),
            resume: () => resumeSpectrum(spectrumConn),
        });

        document.addEventListener('visibilitychange', pause.changed);
        // Once at the start: a receiver started and then backgrounded before
        // this mounted is already hidden, and no change event is coming.
        pause.changed();

        return () => {
            document.removeEventListener('visibilitychange', pause.changed);
            pause.stop();
            // Deliberately not resuming on the way out. This unmounts when the
            // receiver stops, and the socket is meant to be closed then;
            // reopening it would hold the slot powerOff just gave up.
        };
    }, [running, spectrumConn]);

    return null;
}
