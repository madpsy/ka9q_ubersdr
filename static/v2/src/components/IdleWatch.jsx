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
//
// Renders the dialog and nothing else. It runs only while the receiver is
// running: there is no session to lose otherwise, and no sockets to ping.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Button, Modal } from './ui.jsx';
import {
    CONFIRM_MS, FULL_DIVISOR, THROTTLE_DIVISOR,
    idlePhrase, onExternalActivity, shouldPing, throttleAfterMs, warnAfterMs,
} from '../radio/idle.js';

// What counts as being there. v1's list, and capture-phase like v1's, so a
// click on something that stops propagation still counts as activity.
const ACTIVITY = ['mousedown', 'mousemove', 'keydown', 'keypress', 'scroll', 'touchstart', 'click', 'wheel'];

// Events closer together than this are one gesture: only the first re-arms the
// timers. Nothing here is measured in less than seconds.
const BURST_MS = 500;

export default function IdleWatch() {
    const { running, session, actions, audioConn, spectrumConn } = useRadio();
    const mobile = useMediaQuery(MOBILE_QUERY);

    // 'watching' — nothing to see. 'asking' — the dialog is up. 'out' — the
    // receiver has been stopped and the operator has to say so to come back.
    const [phase, setPhase] = useState('watching');
    const [left, setLeft] = useState(CONFIRM_MS / 1000);
    const [idleFor, setIdleFor] = useState(0);
    // Mirrored so the activity handler can tell whether the dialog is up
    // without re-binding itself every time the phase changes — and without
    // setting state on every mousemove.
    const phaseRef = useRef('watching');
    phaseRef.current = phase;

    // Everything the listeners touch lives in refs: they are installed once and
    // must not be re-bound on every tick.
    const at = useRef({ activity: Date.now(), ping: 0 });
    const timers = useRef({ warn: null, count: null, throttle: null });
    const throttled = useRef(false);
    const api = useRef(null);
    api.current = { actions, audioConn, spectrumConn, mobile };

    const warnMs = warnAfterMs(session.idleSec);

    useEffect(() => {
        // Nothing to keep alive and nothing to lose. The timed-out notice
        // stands: powerOff() is what got us here, so clearing it on the way
        // through would close the dialog the moment it opened.
        if (!running) {
            setPhase((p) => (p === 'out' ? p : 'watching'));
            return undefined;
        }

        const t = timers.current;
        const clearAll = () => {
            clearTimeout(t.warn);
            clearInterval(t.count);
            clearTimeout(t.throttle);
            t.warn = null;
            t.count = null;
            t.throttle = null;
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
            t.throttle = setTimeout(throttle, throttleAfterMs(api.current.mobile));
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
            clearAll();
            // Leaving the spectrum at half rate because the panel unmounted
            // would be invisible and permanent.
            unthrottle();
        };
    }, [running, warnMs]);

    // The one place the phase is answered by a click rather than by movement:
    // the button. Any activity at all already dismisses it.
    const confirm = () => {
        setPhase('watching');
        at.current.activity = Date.now();
    };

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
