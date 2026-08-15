// The front door — v1's audio-start overlay, in v2's clothes.
//
// It exists for a reason the browser imposes: an AudioContext started without a
// user gesture is suspended, so *something* has to be pressed before there is
// any audio. v1 makes that unavoidable moment useful, and this keeps the same
// contents: whose receiver this is, the operator's own description of it, and
// the way in — plus the links that only matter before you are listening.
//
// It also asks `/connection` on load rather than at the first press, so a full
// or barred receiver says so up front instead of after a click that fails. That
// is v1's checkConnectionOnLoad, including the bypass password: a rejection
// offers the box, and a password that works is remembered for the session.
//
// Dismissed for the session once you start. It is not a tour and not a notice:
// there is nothing to acknowledge, so it never reappears while the tab is open.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { shellChoosable, writeShell } from '../lib/shellPref.js';
import { Button, Icon } from './ui.jsx';
import { checkConnection, getBypassPassword, setBypassPassword } from '../radio/session.js';
import { MOBILE_QUERY, SHELL_ROOM_QUERY, TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { PasswordModal, UberSdrAppModal, VibeSdrModal } from './StartExtras.jsx';
import { hasMobileApp, ubersdrAppUri, vibesdrUri } from '../lib/appLinks.js';
// The same question the top bar's callsign lookup asks, answered in one place.
// What it is used for here is leaving out the "Open in App" link, which in an
// app would offer to open the receiver that is open — a QR code to scan with
// the device holding it. VibeSDR's link stays, because that is a different app
// and handing this receiver to it is still something to want.
import { insideApp } from '../lib/hostPanels.js';
import StartMap from './StartMap.jsx';

// The pages v1 links from this overlay. Both open in a new tab, as v1's do.
//
// `/session_stats.html` is the D3 world map with the session history and
// country totals — the one v1's overlay button opens. It works from here
// because /stats needs no session: you simply are not on it yet.
const LISTENER_STATS = '/session_stats.html';
const DIRECTORY = 'https://instances.ubersdr.org/';

// Whether the host says audio may start without a press.
//
// Only the desktop client sets it, and only because it can: the overlay exists
// for the browser rule that an AudioContext not created from a user gesture is
// suspended, and that client runs with the rule switched off. A page cannot
// decide this for itself — in an ordinary browser it would start into silence —
// so it is read from the host and never from anything the page can write.
//
// See clients/electron/receiver-preload.js, which exposes it.
const hostAutoStart = () => {
    try { return !!(window.ubersdrDesktop && window.ubersdrDesktop.autoStart); } catch (e) { return false; }
};

export default function StartOverlay() {
    const { running, serverInfo, actions } = useRadio();
    const [check, setCheck] = useState(null);      // null until /connection answers
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [started, setStarted] = useState(false);
    const [dialog, setDialog] = useState(null);   // 'vibesdr' | 'app' | 'password' | null
    const buttonRef = useRef(null);
    const mobile = useMediaQuery(MOBILE_QUERY);
    // What to call the gesture. `any-pointer`, like every other touch decision
    // here, and not `pointer`: an iPad with a keyboard case attached reports a
    // *fine* primary pointer, so asking how the machine is usually driven told
    // a tablet to click. Asking whether a finger is available at all is both
    // simpler and true — the button can be tapped either way.
    const tapNotClick = useMediaQuery(TOUCH_QUERY);
    // Room for the docks in some orientation — see SHELL_ROOM_QUERY.
    const roomy = useMediaQuery(SHELL_ROOM_QUERY);

    // Up here rather than beside the button it belongs to, because the effect
    // below is a second caller and hooks run before this component's early
    // return. One definition either way: the press and the desktop client's
    // automatic start are the same act and must stay so.
    // `shell` is written before powering on rather than left to the operator to
    // find later: this is the one moment the question has an obvious answer, and
    // the layout it chooses is the one the receiver then opens into.
    const start = (shell) => {
        if (shell) writeShell(shell);
        setStarted(true);
        actions.powerOn();
    };

    // Asked once on load, and again only when a password is submitted. The
    // endpoint is rate limited per IP, and the answer does not change on its
    // own — a receiver that was full stays full until somebody leaves, which
    // pressing Start will discover anyway.
    useEffect(() => {
        let cancelled = false;
        checkConnection().then((r) => { if (!cancelled) setCheck(r); });
        return () => { cancelled = true; };
    }, []);

    // Focused, so Return starts — v1's button title promises exactly that, and
    // a focused button gets it from the browser without a key handler that
    // could fire from somewhere else later.
    useEffect(() => {
        const el = buttonRef.current;
        if (el) el.focus();
    }, [check]);

    // The desktop client starts on its own.
    //
    // Waits for /connection rather than starting on mount: a full or barred
    // receiver keeps its reason and its password box instead of being driven
    // into a refusal. By then the client has already seeded any saved bypass
    // password, so a receiver that would have said no has usually said yes —
    // which is what makes "with or without a password" one path rather than two.
    //
    // Once. `started` latches and this component returns null from then on, so
    // powering off deliberately does not bounce you straight back in.
    useEffect(() => {
        if (started || !check || !check.allowed || !hostAutoStart()) return;
        start();
    }, [check, started]);

    if (running || started) return null;

    const rx = (serverInfo && serverInfo.receiver) || {};
    const allowed = !check || check.allowed;
    const bypassed = !!getBypassPassword();
    // Only instances registered with the directory have one, and without it
    // there is nothing for the app to connect to — so no button, as in v1.
    const publicUuid = (serverInfo && serverInfo.public_uuid) || '';
    const inApp = insideApp();

    // On a phone the deep link goes straight to the app: the QR dialog exists
    // to get the URI onto a *different* device, and this is that device.
    //
    // Both links work the same way and for the same reason. Nothing is torn
    // down before leaving, unlike v1's version of this — v1 drops its sockets
    // on the way out because the receiver is already running by the time the
    // button exists, and here it has not started: this overlay *is* the thing
    // standing between the page and its first connection.
    // Whether to follow the link or to offer the dialog is a question about the
    // *device*, not about the width of its screen. `mobile` is a media query —
    // right for a phone, wrong for every tablet, which has the app and a wide
    // screen and was being offered a Linux download because of it.
    const appHere = hasMobileApp();
    // Where the two layouts are both possible: a touchscreen with room for the
    // docks. See the buttons.
    const simpleOffered = shellChoosable({ touch: tapNotClick, roomy });

    const vibesdr = () => {
        if (appHere) { window.location.href = vibesdrUri(publicUuid); return; }
        setDialog('vibesdr');
    };

    const openInApp = () => {
        if (appHere) { window.location.href = ubersdrAppUri(publicUuid); return; }
        setDialog('app');
    };

    const submitPassword = async (e) => {
        e.preventDefault();
        const pw = password.trim();
        if (!pw) { setError('Enter the password.'); return; }
        setBusy(true);
        setError('');
        // Stored before the check, because that is where checkConnection reads
        // it from — and cleared again if it is refused, so a wrong one is not
        // left to fail every later request.
        setBypassPassword(pw);
        const r = await checkConnection();
        setBusy(false);
        if (r.allowed) {
            setCheck(r);
            return;
        }
        setBypassPassword('');
        setError('That password was not accepted.');
    };

    return (
        <div className="start" role="dialog" aria-label="Start listening">
            <div className="start__card">
                <div className="start__who">
                    {rx.callsign && <div className="start__call">{rx.callsign}</div>}
                    {rx.name && <div className="start__name">{rx.name}</div>}
                    {rx.location && <div className="start__where">{rx.location}</div>}
                </div>

                {/* The operator's own blurb, as markup — the same field v1
                    renders here and the Receiver info panel shows. */}
                {serverInfo && serverInfo.description && (
                    <div
                        className="prose start__blurb"
                        dangerouslySetInnerHTML={{ __html: serverInfo.description }}
                    />
                )}

                {/* Where it is, where you are, and how far apart — v1 puts the
                    same map here, and it is the question everybody has before
                    they press anything. */}
                <StartMap receiver={rx} handheld={tapNotClick} />

                {allowed ? (
                    <>
                        <button
                            ref={buttonRef}
                            type="button"
                            className="start__go"
                            title={tapNotClick ? 'Start listening' : 'Press Return to start'}
                            onClick={() => start('full')}
                        >
                            <Icon.Power size={34} />
                            <span>{tapNotClick ? 'Tap to start' : 'Click to start'}</span>
                        </button>
                        {/* The other layout, offered only where it is a choice.
                            A narrow screen has no room for the docks and gets
                            the simple one whatever anybody presses, so a second
                            button there would be two buttons doing the same
                            thing. A machine driven by a pointer is the case
                            this is not for: the docks are what a pointer is
                            good at, and somebody who wants the simple layout on
                            one can still say so in the Display panel.

                            So: touch, and wide enough for both. A tablet, in
                            other words — the one machine where the interface
                            genuinely could go either way and the app has been
                            deciding on its own. */}
                        {simpleOffered && (
                            <button
                                type="button"
                                className="start__go start__go--alt"
                                title="Start with the tabbed layout — one panel at a time over a full-width waterfall, as a phone gets"
                                onClick={() => start('minimal')}
                            >
                                <Icon.Power size={22} />
                                <span>Tap to start — simple layout</span>
                            </button>
                        )}
                    </>
                ) : (
                    <div className="start__refused">
                        <div className="note note--warn">{check.reason || 'This receiver is not accepting connections.'}</div>
                        {/* v1 offers the box on any refusal, not only a full
                            receiver: a bypass password overrides the lot. */}
                        <form className="start__pw" onSubmit={submitPassword}>
                            <input
                                className="input"
                                type="password"
                                placeholder="Bypass password"
                                value={password}
                                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                            />
                            <Button size="sm" variant="primary" type="submit" disabled={busy}>
                                {busy ? 'Checking…' : 'Unlock'}
                            </Button>
                        </form>
                        {error && <div className="start__error">{error}</div>}
                    </div>
                )}

                <div className="start__links">
                    <a className="start__link" href={LISTENER_STATS} target="_blank" rel="noopener noreferrer">
                        Statistics
                    </a>
                    <a className="start__link" href={DIRECTORY} target="_blank" rel="noopener noreferrer">
                        Directory
                    </a>
                    {publicUuid && !inApp && (
                        <button
                            type="button"
                            className="start__link start__link--btn"
                            title="Open this receiver in the UberSDR desktop or Android app"
                            onClick={openInApp}
                        >
                            Open in App
                        </button>
                    )}
                    {publicUuid && (
                        <button type="button" className="start__link start__link--btn" onClick={vibesdr}>
                            VibeSDR
                        </button>
                    )}
                    <button
                        type="button"
                        className="start__link start__link--btn"
                        title="Enter a bypass password"
                        onClick={() => setDialog('password')}
                    >
                        Password
                    </button>
                    {bypassed && <span className="start__badge" title="A bypass password is in use">Bypass</span>}
                </div>

                {serverInfo && serverInfo.version && (
                    <div className="start__version">v{serverInfo.version}</div>
                )}
            </div>

            {dialog === 'vibesdr' && (
                <VibeSdrModal publicUuid={publicUuid} onClose={() => setDialog(null)} />
            )}
            {dialog === 'app' && (
                <UberSdrAppModal publicUuid={publicUuid} onClose={() => setDialog(null)} />
            )}
            {dialog === 'password' && (
                <PasswordModal
                    onClose={() => setDialog(null)}
                    // A password accepted here can change the answer we already
                    // have, so the overlay takes the fresh one rather than
                    // asking again.
                    onChanged={(r) => setCheck(r || null)}
                />
            )}
        </div>
    );
}
