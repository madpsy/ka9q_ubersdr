// The dialogs the start overlay opens — v1's VibeSDR and bypass-password
// modals, which live on its audio-start overlay too, and the same hand-off to
// UberSDR's own apps.
//
// All of them are here rather than in StartOverlay.jsx because none is about
// starting: two hand the instance to an app, the other changes what the server
// will allow. The overlay only decides when to offer them.

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Modal } from './ui.jsx';
import { loadScript } from '../lib/loadScript.js';
import { checkConnection, getBypassPassword, setBypassPassword } from '../radio/session.js';
import { APP_DOWNLOADS, appDownloads, detectDesktopOS, ubersdrAppUri, vibesdrUri } from '../lib/appLinks.js';

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
 * "Copy link", and the second and a half it says it worked.
 *
 * Shared by both dialogs below because the URI is the fallback in each: a custom
 * scheme nobody has claimed does nothing at all when followed — no error, no
 * dialog, nothing — so the link itself has to be on screen and takeable.
 */
function CopyLink({ uri }) {
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

    return <Button size="sm" variant="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>;
}

/**
 * Hand this receiver to the VibeSDR app.
 *
 * On a phone the deep link is followed straight away — v1 skips its own dialog
 * there, since the QR would only be scanned by the device already holding it.
 * The caller does that; this is the desktop half, and the QR is the point of
 * it: VibeSDR is a phone app, so the way out of a desktop browser is a camera.
 */
export function VibeSdrModal({ publicUuid, onClose }) {
    const uri = vibesdrUri(publicUuid);

    return (
        <Modal onClose={onClose} label="Open in VibeSDR">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in VibeSDR</h2>
                <p className="vibe__text">Scan this with a phone to open this receiver in VibeSDR.</p>
                <QrCode text={uri} />
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in VibeSDR</a>
                    <CopyLink uri={uri} />
                </div>
                <p className="vibe__note">VibeSDR beta · instances.ubersdr.org</p>
            </div>
        </Modal>
    );
}

/**
 * One installer, with the platform's own mark on it.
 *
 * The icon is decorative and carries `alt=""` for that reason: the button says
 * "Download for Windows" beside it, and a screen reader announcing "Windows
 * Download for Windows" is worse than one that does not mention it. It is also
 * the reason a missing image costs nothing — the label was always the label.
 */
function DownloadButton({ download, label }) {
    return (
        <a
            className="btn btn--sm"
            href={download.url}
            title={`${download.label} — ${download.note}`}
            target="_blank"
            rel="noopener noreferrer"
        >
            <img className="vibe__os" src={download.icon} alt="" />
            {label}
        </a>
    );
}

/**
 * Hand this receiver to the UberSDR desktop client.
 *
 * Deliberately not VibeSDR's dialog with a different name on it, because the
 * app it is offering is on *this* machine rather than in a pocket. So there is
 * no QR: the two things somebody at a desktop can do are open the receiver in
 * the client they have, or get the client they do not have, and those are the
 * two buttons.
 *
 * Both are needed because neither can be told from the other. A browser cannot
 * ask the operating system whether a scheme is claimed, and following an
 * unclaimed one is silent — so an installed client and a missing one look
 * identical from here, right up until nothing happens. The download beside it is
 * what makes that recoverable without anyone having to guess what went wrong.
 *
 * The Android client answers the same link and does not need a QR here to get
 * it: a phone browsing this receiver follows the link directly, without this
 * dialog ever opening (see StartOverlay). The case a QR would have served —
 * getting the URI from this screen onto a phone — is one the phone reaches for
 * itself by opening the receiver.
 */
export function UberSdrAppModal({ publicUuid, onClose }) {
    const uri = ubersdrAppUri(publicUuid);
    // Read once, when the dialog opens: it is a property of the machine, and
    // nothing about it can change while this is on screen.
    // Plural: Linux has two builds and they are a genuine choice, not the same
    // file twice — see APP_DOWNLOADS. Empty for a platform this cannot name.
    const [downloads] = useState(() => appDownloads(detectDesktopOS()));
    const offered = downloads.length ? downloads : APP_DOWNLOADS;

    return (
        <Modal onClose={onClose} label="Open in the UberSDR app">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in the UberSDR app</h2>
                <p className="vibe__text">
                    Opens this receiver in the UberSDR desktop client. If it is not
                    installed yet, download it first.
                </p>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in App</a>
                    {downloads.length === 1 ? (
                        <DownloadButton download={offered[0]} label={`Download for ${offered[0].label}`} />
                    ) : (
                        // Either a platform with more than one build, or none
                        // this recognises — in which case it says what it has
                        // rather than choosing wrongly on somebody's behalf.
                        // Both want the short label: two "Download for …"
                        // buttons beside "Open in App" is a row of sentences.
                        offered.map((d) => (
                            <DownloadButton key={d.id} download={d} label={d.label} />
                        ))
                    )}
                </div>
                {downloads.map((d) => (
                    <p key={d.id} className="vibe__note">{d.note}</p>
                ))}
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <CopyLink uri={uri} />
                </div>
                <p className="vibe__note">Desktop and Android apps · instances.ubersdr.org</p>
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
