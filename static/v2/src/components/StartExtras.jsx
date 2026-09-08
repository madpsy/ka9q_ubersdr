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
import { connectionCheck, getBypassPassword, setBypassPassword } from '../radio/session.js';
import {
    ANDROID_APK, ANDROID_BADGE, APP_DOWNLOADS, appDownloads, detectDesktopOS,
    IOS_APP_STORE, IOS_APP_STORE_BADGE, ubersdrAppUri, vibesdrUri,
} from '../lib/appLinks.js';

// v1's QR renderer, loaded on demand. 20 KB that only a phone-facing dialog
// needs, so it stays out of the bundle and off the critical path — the same
// treatment the Hamlib module gets.
const QR_SRC = '/qrcode.min.js';

// 160px, which both dialogs take. The link inside is a fixed 59 characters —
// scheme, `connect`, and a canonical UUID — so it is always a version-4 code at
// error level M: 33 modules, and near enough 4.8 physical pixels each at this
// size. A phone camera wants two or three, so there is room to spare, and the
// card is short enough that neither dialog has to be scrolled to reach the
// buttons under it.
function QrCode({ text, size = 160 }) {
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
 * The address of this page, for a QR somebody is going to scan with a phone.
 *
 * Origin and path only, and never `location.href`: this page can be opened with
 * `?password=` (see radio/session.js), and a QR on a desktop screen is
 * photographed by whoever is in the room. Nothing else in the query string is
 * worth carrying either — a shared *tuning* is what buildShareUrl is for, and
 * this is a different question, which receiver rather than which signal.
 *
 * Empty when there is no location to read, which callers use to leave the code
 * out rather than draw one for the string "undefined".
 */
function pageUrl() {
    try {
        const { origin, pathname } = window.location;
        return origin ? `${origin}${pathname || '/'}` : '';
    } catch (e) {
        return '';
    }
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
 * Hand this receiver to the UberSDR app, from a desktop.
 *
 * Three ways out, in the order somebody wants them:
 *
 *   * the link, for the client already on this machine;
 *   * the downloads, for the client they have not got yet;
 *   * the QR, for the phone in their pocket — this page's own address, so that
 *     scanning it opens the receiver whatever the phone has installed. It is
 *     deliberately not the `ubersdr://` link printed beneath it: that one is
 *     scanned successfully only by a phone that already has the app, and errors
 *     on every other, which is a dead end with a camera in the way and nothing
 *     on screen to explain it. The page works on its own and carries its own
 *     way into the app.
 *
 * That is also why this is not VibeSDR's QR with a different scheme in it. That
 * dialog has no page to fall back to — VibeSDR is somebody else's app and its
 * link is the only thing it can be handed.
 *
 * The QR sits at the bottom, above the link text, because the two are the same
 * hand-off aimed at different devices — the code at a phone, the text at this
 * machine — and the pair belongs under the buttons rather than between them.
 *
 * All three are shown at once because none can be told from the others. A
 * browser cannot ask the operating system whether a scheme is claimed, and
 * following an unclaimed one is silent — so an installed client and a missing
 * one look identical from here, right up until nothing happens. What is on
 * screen beside the link is what makes that recoverable without anyone having
 * to guess what went wrong.
 *
 * The downloads are on their own row rather than beside the link. They are a
 * different question — get the app, not open the receiver — and on Linux there
 * are four of them, which read as a row of alternatives to "Open in App" when
 * they sit next to it.
 */
export function UberSdrAppModal({ publicUuid, onClose }) {
    const uri = ubersdrAppUri(publicUuid);
    // Read once, when the dialog opens: it is a property of the machine, and
    // nothing about it can change while this is on screen.
    // Plural: Linux has four builds — an AppImage and a .deb, each for x86_64
    // and for ARM64 — and they are a genuine choice rather than the same file
    // several times. See APP_DOWNLOADS, which also says why the architecture is
    // offered rather than detected. Empty for a platform this cannot name.
    const [downloads] = useState(() => appDownloads(detectDesktopOS()));
    const offered = downloads.length ? downloads : APP_DOWNLOADS;
    // The QR is this page's address rather than the `ubersdr://` link beside it,
    // which is the one thing in this dialog a phone camera would refuse: the
    // scanners people actually use — the iOS Camera, Google Lens — are built
    // around http(s), and a custom scheme is at best inconsistently offered and
    // at worst silently dropped. An https link is scanned by all of them.
    //
    // It also fails better. A scheme QR that does open hands the receiver to an
    // app that may not be installed, and that is the same silence this dialog
    // exists to avoid — with a camera in the way, so there is nothing on screen
    // to explain it. The page opens either way, can be listened to in the phone's
    // browser as it stands, and carries its own "Open in App" button for the app
    // proper. The direct link is still here for anyone who wants it: it is the
    // text under the code, and the thing Copy link copies.
    const [here] = useState(pageUrl);

    return (
        <Modal onClose={onClose} label="Open in the UberSDR app">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in the UberSDR app</h2>
                <p className="vibe__text">
                    Opens this receiver in the UberSDR desktop client. If it is not
                    installed yet, download it below.
                </p>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in App</a>
                </div>
                <p className="vibe__text">Or download the desktop client:</p>
                <div className="vibe__row">
                    {downloads.length === 1 ? (
                        <DownloadButton download={offered[0]} label={`Download for ${offered[0].label}`} />
                    ) : (
                        // Either a platform with more than one build, or none
                        // this recognises — in which case it says what it has
                        // rather than choosing wrongly on somebody's behalf.
                        // Both want the short label: two "Download for …"
                        // buttons on one row is a row of sentences.
                        offered.map((d) => (
                            <DownloadButton key={d.id} download={d} label={d.label} />
                        ))
                    )}
                </div>
                {downloads.map((d) => (
                    <p key={d.id} className="vibe__note">{d.note}</p>
                ))}
                {here && <QrCode text={here} />}
                {here && <p className="vibe__note">Scan with phone to open this receiver there</p>}
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <CopyLink uri={uri} />
                </div>
                <p className="vibe__note">Desktop, Android and iOS · instances.ubersdr.org</p>
            </div>
        </Modal>
    );
}

/**
 * The same hand-off, on an iPhone or an iPad.
 *
 * Everywhere else a device that has the app is simply handed the link and the
 * dialog never opens (see StartOverlay). iOS is the exception, for two reasons
 * that only apply there:
 *
 *   * Following an unclaimed scheme is silent on every platform, and on iOS
 *     there is no way back from that silence — no "no app can open this", no
 *     store prompt, nothing. A tap that does nothing looks like a broken page.
 *   * The app cannot be side-loaded, so there is no file to offer. The App
 *     Store page *is* the download, which is why the badge is here rather than
 *     a `DownloadButton`.
 *
 * So both are on screen at once: open it if you have it, get it if you do not.
 * Neither can be told from the other from inside a browser.
 */
export function IosAppModal({ publicUuid, onClose }) {
    const uri = ubersdrAppUri(publicUuid);

    return (
        <Modal onClose={onClose} label="Open in the UberSDR app">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in the UberSDR app</h2>
                <p className="vibe__text">
                    Opens this receiver in the UberSDR app. If it is not installed
                    yet, get it from the App Store first.
                </p>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in App</a>
                </div>
                {/* Apple's badge already says "Download on the App Store", so
                    the link has no text of its own — `alt` carries it for a
                    screen reader, and is what shows if the image does not. */}
                <a
                    className="vibe__badge"
                    href={IOS_APP_STORE}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <img src={IOS_APP_STORE_BADGE} alt="Download UberSDR on the App Store" />
                </a>
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <CopyLink uri={uri} />
                </div>
                <p className="vibe__note">iPhone and iPad · instances.ubersdr.org</p>
            </div>
        </Modal>
    );
}

/**
 * The same hand-off, on Android.
 *
 * IosAppModal's twin and for the same reason — a scheme nobody claims is silent,
 * and on a phone that is indistinguishable from a broken page — with the one
 * difference that Android can be handed a file. So the app beside the link is
 * an APK rather than a store page.
 *
 * Which is why the note above the badge is not decoration. A download from a
 * browser is a sideload: Android asks for an install permission the first time,
 * and the prompt is alarming if it arrives unannounced. Saying so before the
 * tap is the difference between an expected step and a warning.
 */
export function AndroidAppModal({ publicUuid, onClose }) {
    const uri = ubersdrAppUri(publicUuid);

    return (
        <Modal onClose={onClose} label="Open in the UberSDR app">
            <div className="stack vibe">
                <h2 className="vibe__title">Open in the UberSDR app</h2>
                <p className="vibe__text">
                    Opens this receiver in the UberSDR app. If it is not installed
                    yet, download it below first.
                </p>
                <div className="vibe__row">
                    <a className="btn btn--primary btn--sm" href={uri}>Open in App</a>
                </div>
                <p className="vibe__note">
                    Not on Google Play yet — this downloads the APK and installs it
                    directly. Android will ask you to allow installing from your
                    browser.
                </p>
                {/* The badge carries its own wording, so the link has no label —
                    `alt` is what a screen reader announces and what shows if the
                    image does not. */}
                <a
                    className="vibe__badge"
                    href={ANDROID_APK}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <img src={ANDROID_BADGE} alt="Download the UberSDR app for Android" />
                </a>
                <code className="vibe__uri">{uri}</code>
                <div className="vibe__row">
                    <CopyLink uri={uri} />
                </div>
                <p className="vibe__note">Android · instances.ubersdr.org</p>
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
        // Stored first: the check sends whatever is stored, and a
        // rejected one is cleared again rather than left to fail every later
        // request in the session.
        setBypassPassword(pw);
        const r = await connectionCheck();
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
