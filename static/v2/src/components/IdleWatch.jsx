// The idle watch — v1's idle-detector.js, minus its hand-built DOM.
//
// Three jobs, all keyed off the same activity signal (see radio/idle.js for the
// rules and the reasoning):
//
//   keepalive   ping the audio and spectrum sockets when the operator does
//               something. There is no timer doing this: a periodic ping would
//               touch the session server-side and make it immortal.
//   warning     30 s before the server would reclaim the session, ask whether
//               anyone is still there, and stop the receiver if nobody answers.
//   throttle    halve the spectrum rate after a few minutes of nothing, and
//               restore it on the first sign of life.
//   pause       close the spectrum socket after a longer spell of nothing, and
//               leave it closed until the operator asks for it back. Off by
//               default on a desktop; see PAUSE_CHOICES and SpectrumView's
//               overlay, which is the asking.
//
// Renders the dialog and nothing else. It runs only while the receiver is
// running: there is no session to lose otherwise, and no sockets to ping.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Modal } from './ui.jsx';
import {
    CONFIRM_MS, FULL_DIVISOR, THROTTLE_DIVISOR,
    idlePhrase, onExternalActivity, pauseAfterMs, shouldPing, throttleAfterMs, warnAfterMs,
} from '../radio/idle.js';
import {
    onSpectrumPaused, setSpectrumPaused, spectrumPaused, suspendSpectrum,
} from '../lib/spectrumPause.js';

// What counts as being there. v1's list, and capture-phase like v1's, so a
// click on something that stops propagation still counts as activity.
const ACTIVITY = ['mousedown', 'mousemove', 'keydown', 'keypress', 'scroll', 'touchstart', 'click', 'wheel'];

// Events closer together than this are one gesture: only the first re-arms the
// timers. Nothing here is measured in less than seconds.
const BURST_MS = 500;

export default function IdleWatch() {
    const { running, session, lost, actions, audioConn, spectrumConn } = useRadio();
    const mobile = useMediaQuery(MOBILE_QUERY);
    // How long the operator is prepared to be counted as away before the
    // spectrum drops to half rate — see the Display panel. null for never.
    //
    // The keepalive and the warning are not optional: those are about not losing
    // the session, and are the receiver's rules rather than a preference.
    const d = useDisplay();
    const throttleMs = throttleAfterMs(d.idleThrottleMin, mobile);
    // And how long before it stops altogether. A different bargain from the
    // throttle — the display is not live afterwards — so a different delay, and
    // never by default anywhere but a phone.
    const pauseMs = pauseAfterMs(d.idlePauseMin, mobile);

    // 'watching' — nothing to see. 'asking' — the dialog is up. 'out' — the
    // receiver has been stopped and the operator has to say so to come back.
    const [phase, setPhase] = useState('watching');
    const [left, setLeft] = useState(CONFIRM_MS / 1000);
    const [idleFor, setIdleFor] = useState(0);
    // Which `lost` the operator has already waved away, by its timestamp. Not a
    // boolean: the next session can be ended too, and that one is news again.
    const [dismissed, setDismissed] = useState(0);
    // Mirrored so the activity handler can tell whether the dialog is up
    // without re-binding itself every time the phase changes — and without
    // setting state on every mousemove.
    const phaseRef = useRef('watching');
    phaseRef.current = phase;

    // Everything the listeners touch lives in refs: they are installed once and
    // must not be re-bound on every tick.
    const at = useRef({ activity: Date.now(), ping: 0 });
    const timers = useRef({ warn: null, count: null, throttle: null, pause: null });
    const throttled = useRef(false);
    const api = useRef(null);
    api.current = { actions, audioConn, spectrumConn };

    const warnMs = warnAfterMs(session.idleSec);

    useEffect(() => {
        // Nothing to keep alive and nothing to lose. The timed-out notice
        // stands: powerOff() is what got us here, so clearing it on the way
        // through would close the dialog the moment it opened.
        if (!running) {
            setPhase((p) => (p === 'out' ? p : 'watching'));
            // Nothing paused, either: the socket is closed because the receiver
            // is off, and an overlay offering to resume it would be offering to
            // hold a slot that was just given up.
            setSpectrumPaused(false);
            return undefined;
        }

        const t = timers.current;
        const clearAll = () => {
            clearTimeout(t.warn);
            clearInterval(t.count);
            clearTimeout(t.throttle);
            clearTimeout(t.pause);
            t.warn = null;
            t.count = null;
            t.throttle = null;
            t.pause = null;
        };

        // --- spectrum rate ---------------------------------------------------
        const throttle = () => {
            const { spectrumConn: sc } = api.current;
            if (throttled.current || !sc) return;
            throttled.current = true;
            sc.setRate(THROTTLE_DIVISOR);
        };

        const unthrottle = () => {
            const { spectrumConn: sc } = api.current;
            if (!throttled.current) return;
            throttled.current = false;
            if (sc) sc.setRate(FULL_DIVISOR);
        };

        // --- the spectrum socket ---------------------------------------------
        //
        // Only when there is something to close. A tab that has been in the
        // background long enough for VisibilityWatch to have closed it already
        // must not be marked paused: that suspend resumes itself when the tab
        // comes back, and the flag would then be an overlay over a live
        // spectrum, waiting to be found the moment anyone looked.
        const pause = () => {
            const { spectrumConn: sc } = api.current;
            if (!sc || !sc.connected || spectrumPaused()) return;
            suspendSpectrum(sc);
            setSpectrumPaused(true);
        };

        // --- the countdown ---------------------------------------------------
        const timeout = () => {
            clearAll();
            unthrottle();
            setPhase('out');
            // Stop rather than wait to be kicked: the slot is released cleanly
            // and the sockets do not spend the next minute reconnecting into a
            // session the server has already reclaimed.
            api.current.actions.powerOff();
        };

        const ask = () => {
            // Nobody is looking, so there is nobody to ask.
            //
            // The dialog gives the operator thirty seconds to say they are
            // still there, and the receiver is stopped if they do not. In a
            // hidden tab that countdown is a setInterval, which Chrome throttles
            // to roughly once a minute — so the stop that should land at the
            // server's deadline lands well after it, and the server gets there
            // first. Its version is not a stop: it *kicks the session id* and
            // then refuses it for an hour, which leaves every socket on the page
            // reconnecting into a refusal it can never satisfy. That is the tab
            // you come back to with no audio and no waterfall.
            //
            // So when the tab is hidden the receiver stops now, cleanly, at the
            // warning rather than at the deadline. It costs the thirty seconds
            // of grace that a hidden tab could not have used anyway — nothing
            // there can answer, and coming back to the tab is itself activity,
            // which would have re-armed the timer had it happened in time — and
            // it buys a session that ends the way both sides expect. Coming
            // back then finds the receiver stopped rather than broken, and the
            // first thing the operator touches starts it again.
            if (document.hidden) {
                timeout();
                return;
            }
            setPhase('asking');
            setIdleFor(Date.now() - at.current.activity);
            setLeft(CONFIRM_MS / 1000);
            const until = Date.now() + CONFIRM_MS;
            clearInterval(t.count);
            t.count = setInterval(() => {
                const secs = Math.ceil((until - Date.now()) / 1000);
                setLeft(Math.max(0, secs));
                setIdleFor(Date.now() - at.current.activity);
                if (secs <= 0) timeout();
            }, 250);
        };

        const arm = () => {
            clearTimeout(t.warn);
            // No warning where the operator has switched the timeout off, or
            // this client is bypassed. The heartbeats below still go out: the
            // session is only immortal while somebody is actually here.
            if (warnMs != null) t.warn = setTimeout(ask, warnMs);
            clearTimeout(t.throttle);
            // Never: nothing is armed, and the effect's cleanup has already
            // restored the full rate on the way in here.
            if (throttleMs != null) t.throttle = setTimeout(throttle, throttleMs);
            clearTimeout(t.pause);
            // Not while it is already paused: activity does not bring the socket
            // back — only the button does — so re-arming here would be a timer
            // waiting to close something that is already closed. Resuming arms
            // it again through the subscription below.
            if (pauseMs != null && !spectrumPaused()) t.pause = setTimeout(pause, pauseMs);
        };

        // --- activity --------------------------------------------------------
        const onActivity = () => {
            const now = Date.now();
            const { activity, ping } = at.current;

            // A mousemove is a burst of events, not a burst of decisions.
            // Re-arming two timers sixty times a second buys nothing against a
            // timeout measured in minutes.
            if (now - activity < BURST_MS && phaseRef.current !== 'asking') {
                at.current.activity = now;
                return;
            }

            // While the dialog is up, moving the mouse is an answer.
            if (phaseRef.current === 'asking') {
                setPhase('watching');
                clearInterval(t.count);
            }

            if (shouldPing(now, ping, activity)) {
                const { audioConn: ac, spectrumConn: sc } = api.current;
                let sent = 0;
                if (ac && ac.connected) { ac.ping(); sent++; }
                if (sc && sc.connected) { sc.ping(); sent++; }
                // Only counts as a heartbeat if one actually went out, or a
                // reconnect would leave the next one a full interval away.
                if (sent > 0) at.current.ping = now;
            }

            at.current.activity = now;
            unthrottle();
            arm();
        };

        // The overlay's Resume button, which is the only thing that ends a pause.
        //
        // Watched rather than left to the click that did it. That click has
        // already been through onActivity — the activity listener is capture
        // phase and runs before React's handler — so at that moment the flag was
        // still set and arm() deliberately skipped the pause timer. And calling
        // onActivity() from here would not help either: it is inside its own
        // BURST_MS window by now and would return before re-arming anything.
        // Without this, resuming and then walking away would never pause again.
        const offPause = onSpectrumPaused((now) => {
            if (now) return;
            at.current.activity = Date.now();
            arm();
        });

        // Coming back to the tab is activity: v1 treats it as such, and
        // otherwise a tab left in the background for the whole timeout would be
        // asking the question the moment it was looked at again.
        const onVisible = () => { if (!document.hidden) onActivity(); };

        for (const ev of ACTIVITY) document.addEventListener(ev, onActivity, true);
        document.addEventListener('visibilitychange', onVisible);
        // Lock-screen and media-key presses, which reach no DOM element.
        const offExternal = onExternalActivity(onActivity);
        at.current.activity = Date.now();
        arm();

        return () => {
            for (const ev of ACTIVITY) document.removeEventListener(ev, onActivity, true);
            document.removeEventListener('visibilitychange', onVisible);
            offExternal();
            offPause();
            clearAll();
            // Leaving the spectrum at half rate because the panel unmounted
            // would be invisible and permanent.
            unthrottle();
        };
        // `throttleMs` and `pauseMs` are in the list so changing either delay
        // tears this down and rebuilds it. A pause already in force is left
        // alone: unlike the throttle it is on screen and undone by a button, so
        // there is nothing invisible to put right.
        //
        // `throttleMs` is in the list so changing the delay tears this down and
        // rebuilds it: the cleanup restores the full rate on the way out, which
        // is what makes a new choice take effect at once — and take effect
        // *from now*, rather than leaving a timer armed against the old one.
        // Re-binding the listeners is the cost, and it happens only when the
        // setting is touched.
    }, [running, warnMs, throttleMs, pauseMs]);

    // The one place the phase is answered by a click rather than by movement:
    // the button. Any activity at all already dismisses it.
    const confirm = () => {
        setPhase('watching');
        at.current.activity = Date.now();
    };

    // The receiver stopped and the operator did not ask it to — the same thing
    // the 'out' dialog below says, for the other reason it happens. It lives
    // here because this is already the component that explains an unasked-for
    // stop, and having two of those would mean two dialogs racing to cover each
    // other the one time both were true.
    //
    // Ahead of both: a session the server has ended is a fact, where the other
    // two are this client's own reading of the silence, and when more than one
    // is true the fact is the news.
    // Dismissing only closes the dialog; what actually clears `lost` is
    // starting again, which is what the button does.
    if (lost && lost.at !== dismissed) {
        return (
            <Modal onClose={() => setDismissed(lost.at)} label="Session ended">
                <div className="idle">
                    <h2 className="idle__title">Session ended</h2>
                    <p className="idle__text">{lost.message}</p>
                    <Button variant="primary" onClick={() => actions.powerOn()}>Listen again</Button>
                </div>
            </Modal>
        );
    }

    if (phase === 'asking') {
        return (
            <Modal onClose={confirm} label="Are you still there?">
                <div className="idle">
                    <h2 className="idle__title">Are you still there?</h2>
                    <p className="idle__text">
                        Nothing has happened for {idlePhrase(idleFor)}.
                    </p>
                    <p className="idle__count">
                        Disconnecting in {left} second{left === 1 ? '' : 's'}…
                    </p>
                    <Button variant="primary" onClick={confirm}>Yes, I&rsquo;m here</Button>
                </div>
            </Modal>
        );
    }

    if (phase === 'out') {
        return (
            <Modal onClose={() => setPhase('watching')} label="Session timed out">
                <div className="idle">
                    <h2 className="idle__title">Session timed out</h2>
                    <p className="idle__text">
                        The receiver was stopped after a long spell of inactivity, so
                        somebody else can use it. Press Listen to start again.
                    </p>
                    <Button variant="primary" onClick={() => setPhase('watching')}>Close</Button>
                </div>
            </Modal>
        );
    }

    return null;
}
