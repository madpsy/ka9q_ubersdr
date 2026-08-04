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
import { Button, Icon } from './ui.jsx';
import { checkConnection, getBypassPassword, setBypassPassword } from '../radio/session.js';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { PasswordModal, VibeSdrModal, vibesdrUri } from './StartExtras.jsx';
import { openChannelsMap } from '../compat/legacyBridge.js';
import { subscribeListeners } from '../lib/listeners.js';
import StartMap from './StartMap.jsx';

// The pages v1 links from this overlay. Both open in a new tab, as v1's do.
//
// Two different maps, and they are not the same thing: `/session_stats.html` is
// the D3 world map with the session history and country totals — the one v1's
// overlay button opens — while the Leaflet map is the live one, a pin per
// listener right now. It works from here because /stats needs no session: you
// simply are not on it yet.
const LISTENER_STATS = '/session_stats.html';
const DIRECTORY = 'https://instances.ubersdr.org/';

export default function StartOverlay() {
    const { running, serverInfo, actions } = useRadio();
    const [check, setCheck] = useState(null);      // null until /connection answers
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [started, setStarted] = useState(false);
    const [dialog, setDialog] = useState(null);   // 'vibesdr' | 'password' | null
    const buttonRef = useRef(null);
    const mobile = useMediaQuery(MOBILE_QUERY);

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

    if (running || started) return null;

    const rx = (serverInfo && serverInfo.receiver) || {};
    const allowed = !check || check.allowed;
    const bypassed = !!getBypassPassword();
    // Only instances registered with the directory have one, and without it
    // there is nothing for the app to connect to — so no button, as in v1.
    const publicUuid = (serverInfo && serverInfo.public_uuid) || '';

    // On a phone the deep link goes straight to the app: the QR dialog exists
    // to get the URI onto a *different* device, and this is that device.
    const vibesdr = () => {
        if (mobile) { window.location.href = vibesdrUri(publicUuid); return; }
        setDialog('vibesdr');
    };

    const start = () => {
        setStarted(true);
        actions.powerOn();
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
                <StartMap receiver={rx} mobile={mobile} />

                {allowed ? (
                    <button
                        ref={buttonRef}
                        type="button"
                        className="start__go"
                        title="Press Return to start"
                        onClick={start}
                    >
                        <Icon.Power size={34} />
                        <span>Click to start</span>
                    </button>
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
                    <button
                        type="button"
                        className="start__link start__link--btn"
                        title="Who is listening now, on a map"
                        onClick={() => openChannelsMap(subscribeListeners)}
                    >
                        Listener map
                    </button>
                    <a className="start__link" href={LISTENER_STATS} target="_blank" rel="noopener noreferrer">
                        Statistics
                    </a>
                    <a className="start__link" href={DIRECTORY} target="_blank" rel="noopener noreferrer">
                        Instance directory
                    </a>
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
