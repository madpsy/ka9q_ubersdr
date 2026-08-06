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
// waiting five seconds for each one; this is the wiring.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { HIDDEN_SUSPEND_MS } from '../radio/idle.js';
import { visibilityPause } from '../lib/visibilityPause.js';

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
            // disconnect(), not a bare close: it is the one that sets
            // closedByUser, which is what stops _onClose scheduling the
            // exponential-backoff reconnect. Without it the socket would come
            // straight back a second later and this would be a reconnect loop
            // behind a hidden tab.
            suspend: () => spectrumConn.disconnect(),
            // Back at the view it left rather than the default span: the server
            // keeps nothing for a session that has gone, so this is the only
            // thing that says where the operator was. Anything asked for while
            // the tab was hidden is waiting in pendingView and goes out on open.
            resume: () => spectrumConn.connect({
                frequency: spectrumConn.centerFreq,
                binBandwidth: spectrumConn.binBandwidth,
            }),
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
