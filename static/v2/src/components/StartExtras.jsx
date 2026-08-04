// The two dialogs the start overlay opens — v1's VibeSDR and bypass-password
// modals, which live on its audio-start overlay too.
//
// Both are here rather than in StartOverlay.jsx because neither is about
// starting: one hands the instance to a phone, the other changes what the
// server will allow. The overlay only decides when to offer them.

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Modal } from './ui.jsx';
import { loadScript } from '../lib/loadScript.js';
import { checkConnection, getBypassPassword, setBypassPassword } from '../radio/session.js';

// v1's scheme (app.js _buildVibeSDRUri). The public UUID is the instance's, not
// the session's — it identifies the receiver to the directory.
export function vibesdrUri(publicUuid) {
    return publicUuid ? `vibesdr://connect?uuid=${publicUuid}` : null;
}

// v1's QR renderer, loaded on demand. 20 KB that only a phone-facing dialog
// needs, so it stays out of the bundle and off the critical path — the same
// treatment the Hamlib module gets.
const QR_SRC = '/qrcode.min.js';

function QrCode({ text, size = 200 }) {
    const box = useRef(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadScript(QR_SRC).then(() => {
            const el = box.current;
            if (cancelled || !el || typeof window.QRCode === 'undefined') {
                if (!cancelled) setFailed(typeof window.QRCode === 'undefined');
                return;
            }
            el.innerHTML = '';
            // eslint-disable-next-line new-cap
            new window.QRCode(el, {
                text,
                width: size,
                height: size,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: window.QRCode.CorrectLevel.M,
            });
        }, () => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [text, size]);

    // White plate whatever the theme: a QR code is read by a camera, and an
    // inverted one does not scan.
    return failed
        ? <div className="note note--warn">The QR code could not be drawn — use the link below.</div>
        : <div className="vibe__qr" ref={box} style={{ minHeight: size }} />;
}

/**
 * Hand this receiver to the VibeSDR app.
 *
 * On a phone the deep link is followed straight away — v1 skips its own dialog
 * there, since the QR would only be scanned by the device already holding it.
 * The caller does that; this is the desktop half.
 */
export function VibeSdrModal({ publicUuid, onClose }) {
    const uri = vibesdrUri(publicUuid);
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(uri);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (e) {
            setCopied(false);
        }
    };

    return (
        <Modal onClose={onClose} label="Open in VibeSDR">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in VibeSDR</h2>
                <p className="vibe__text">Scan this with a phone to open this receiver in VibeSDR.</p>
                <QrCode text={uri} />
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in VibeSDR</a>
                    <Button size="sm" variant="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
                </div>
                <p className="vibe__note">VibeSDR beta · instances.ubersdr.org</p>
            </div>
        </Modal>
    );
}

/**
 * The bypass password, offered rather than demanded.
 *
 * v1 keeps this behind a key button so it can be entered before being refused —
 * an operator who has given somebody a password should not have to wait for the
 * receiver to fill up before they can use it. `onChanged` lets the overlay
 * re-check whether it is now welcome.
 */
export function PasswordModal({ onClose, onChanged }) {
    const [password, setPassword] = useState(() => getBypassPassword());
    const [status, setStatus] = useState(null);   // { ok, text }
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        const el = inputRef.current;
        if (el) { el.focus(); el.select(); }
    }, []);

    const apply = async (e) => {
        e.preventDefault();
        const pw = password.trim();
        if (!pw) { setStatus({ ok: false, text: 'Enter a password.' }); return; }
        setBusy(true);
        setStatus(null);
        // Stored first: checkConnection sends whatever is stored, and a
        // rejected one is cleared again rather than left to fail every later
        // request in the session.
        setBypassPassword(pw);
        const r = await checkConnection();
        setBusy(false);
        if (r.allowed) {
            setStatus({ ok: true, text: 'Accepted. Connection limits are bypassed.' });
            if (onChanged) onChanged(r);
            return;
        }
        setBypassPassword('');
        setStatus({ ok: false, text: r.reason || 'That password was not accepted.' });
        if (onChanged) onChanged(r);
    };

    const clear = () => {
        setBypassPassword('');
        setPassword('');
        setStatus({ ok: true, text: 'Saved password cleared.' });
        if (onChanged) onChanged(null);
    };

    return (
        <Modal onClose={onClose} label="Bypass password">
            <form className="stack vibe" onSubmit={apply}>
                <h2 className="vibe__title">Bypass password</h2>
                <p className="vibe__text">
                    Overrides this receiver&rsquo;s connection limits. Kept for this
                    browser tab only, not saved for the next person to use it.
                </p>
                <div className="start__pw">
                    <input
                        ref={inputRef}
                        className="input"
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setStatus(null); }}
                    />
                    <Button size="sm" variant="primary" type="submit" disabled={busy}>
                        {busy ? 'Checking…' : 'Apply'}
                    </Button>
                </div>
                {status && (
                    <div className={`start__status${status.ok ? ' is-ok' : ''}`}>{status.text}</div>
                )}
                <div className="row-end">
                    <Button size="sm" variant="ghost" onClick={clear}>Clear saved password</Button>
                    <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
                </div>
            </form>
        </Modal>
    );
}
