// The receiver operator's word to whoever has just opened the page.
//
// Up to three short messages, set in Admin → UI, shown when the page opens and
// gone a few seconds later: "antenna maintenance this afternoon, reception may
// be poor", and a donate button. A list rather than one message because those
// two are not the same kind of thing — one is temporary, amber and worth
// repeating every load; the other is permanent, quiet and worth showing once —
// and a single card holding both reads as "donate towards the outage".
//
// They are not part of the notification system. A listener who has turned toasts
// off still needs to be told the antenna is down, and the operator is not a
// source anybody subscribed to.
//
// What each is made of is a heading, a message and at most one link, all of them
// rendered as text nodes and an href. There is no markup path: see
// ui_config_notice.go for why, which is not that the operator is untrusted —
// they can already put script on this page through admin.description — but that
// ui.yaml is exported and imported as a file, and a notice made of markup would
// make importing somebody's colour scheme a way to import their script.
//
// Drawn once the front door is open, not over it. The start overlay is what is
// on screen when the page loads, and a notice on top of it would be read — if it
// were read at all — before the listener had decided to come in, competing with
// the receiver's own description for the one screen that exists to introduce it.
// So the clock starts when the overlay goes: `running` from the radio, which is
// exactly what the overlay itself hides on (see StartOverlay's early return) and
// is set the moment Start is pressed. In the mobile and desktop clients, which
// start themselves, that is a moment after load and the notice follows straight
// on — which is the same behaviour, not a special case.
//
// In the mobile clients only the link-free ones are drawn: the app stores do not
// allow a payment link inside an app, and a donate button is exactly that. The
// words on their own break no rule and are what somebody in an app wants to
// know, so "antenna work this afternoon" shows there like anywhere else. See
// noticeLinksAllowedByHost.
//
// ── Why one component and not one per card ──────────────────────────────────
//
// Each card has its own clock, and the obvious shape is a child component per
// notice holding its own. They live here instead, in two maps keyed by notice
// id, so that the whole layer is one hook frame: what a listener has already
// been shown is decided once for the list rather than three times from three
// mounts racing the same localStorage key.

import React, { ReactDOM, useEffect, useMemo, useRef, useState } from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { noticeLinksAllowedByHost } from '../lib/hostPanels.js';
import { Icon } from './ui.jsx';

// Where "shown once" is remembered: the ids of the notices this browser has
// seen. Pruned on every load to the ones the receiver is still offering, which
// is what keeps it from growing for the life of the browser — see decide().
const SEEN_KEY = 'ubersdr.v2.notices-seen';

function readSeen() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SEEN_KEY));
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch (e) {
        // Storage denied, or something else's value under the key. Either way
        // the notices are shown, which is the safer half of the choice:
        // showing one twice beats swallowing it.
        return [];
    }
}

function writeSeen(ids) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch (e) { /* nothing to do */ }
}

const ICON = {
    info: <Icon.Info size={15} />,
    warning: <Icon.Info size={15} />,
    good: <Icon.Tick size={15} />,
};

export default function OperatorNotice() {
    const { server } = useDisplay();
    // Whether the receiver has been started, which is the same question as
    // whether the start overlay is still up: it draws nothing once this is true.
    const { running } = useRadio();
    const all = (server && server.notices) || [];

    // Whether a link may be offered here. Asked once and not per render: the
    // host object is set before the page's first script and never changes.
    const linksOk = useRef(null);
    if (linksOk.current === null) linksOk.current = noticeLinksAllowedByHost();

    // Filtered before anything else looks at the list, so a notice this client
    // may not draw is not marked as seen either — an app must not use up the
    // one showing of a "once" notice it never showed.
    const notices = useMemo(
        () => (linksOk.current ? all : all.filter((n) => !n.link)),
        [all],
    );
    // id -> true while that card is up. A map rather than a list of ids so a
    // card dismissed by hand and one whose clock ran out take the same path.
    const [open, setOpen] = useState({});
    // The one card the pointer is on, if any: its clock is held while it is
    // being read.
    const [held, setHeld] = useState(null);
    // The list this component has already decided about, as its ids. A
    // re-render is not a new decision; a notice the operator edited is.
    const decided = useRef('');
    const timers = useRef(new Map());

    useEffect(() => {
        // Nothing is decided while the overlay is up — not even "already seen".
        // A notice counted as shown behind the front door is one the listener
        // never saw, and for a "once" notice that would be the only showing it
        // was ever going to get.
        if (!running) return;
        const key = notices.map((n) => n.id).join('|');
        if (!notices.length) {
            decided.current = key;
            setOpen({});
            return;
        }
        if (decided.current === key) return;
        decided.current = key;

        const seen = readSeen();
        const next = {};
        // Pruned to what this receiver still offers, so an id belonging to a
        // notice the operator deleted a year ago does not sit in the browser
        // forever — and so the list cannot grow past the few that exist.
        const keep = [];
        for (const n of notices) {
            if (n.once && seen.includes(n.id)) { keep.push(n.id); continue; }
            next[n.id] = true;
            // Recorded on sight rather than on dismiss: "once" means once, and
            // a tab closed while it was still up has had its once.
            if (n.once) keep.push(n.id);
        }
        writeSeen(keep);
        setOpen(next);
    }, [notices, running]);

    // The clocks, one per card that is up and has one. Held while the pointer is
    // on that card — a few seconds is not long to read a sentence and decide
    // whether to press the link in it, and a notice that vanished from under the
    // cursor would be the one thing worse than not showing it at all.
    useEffect(() => {
        const live = timers.current;
        const close = (id) => setOpen((o) => (o[id] ? { ...o, [id]: false } : o));

        for (const [id, handle] of live) {
            if (!open[id] || id === held) { clearTimeout(handle); live.delete(id); }
        }
        for (const n of notices) {
            if (!open[n.id] || !n.seconds || n.id === held || live.has(n.id)) continue;
            live.set(n.id, setTimeout(() => close(n.id), n.seconds * 1000));
        }
    }, [notices, open, held]);

    useEffect(() => () => {
        for (const handle of timers.current.values()) clearTimeout(handle);
        timers.current.clear();
    }, []);

    const showing = notices.filter((n) => open[n.id]);
    if (!showing.length) return null;

    return ReactDOM.createPortal(
        <div className="opnotice-layer" role="status" aria-live="polite">
            {showing.map((notice) => (
                <div
                    key={notice.id}
                    className={`opnotice is-${notice.severity}`}
                    onMouseEnter={() => setHeld(notice.id)}
                    onMouseLeave={() => setHeld((h) => (h === notice.id ? null : h))}
                    onFocusCapture={() => setHeld(notice.id)}
                    onBlurCapture={() => setHeld((h) => (h === notice.id ? null : h))}
                >
                    <span className="opnotice__icon">{ICON[notice.severity] || ICON.info}</span>
                    <div className="opnotice__text">
                        {notice.title && <div className="opnotice__title">{notice.title}</div>}
                        {notice.text && <div className="opnotice__body">{notice.text}</div>}
                        {notice.link && (
                            // noreferrer as well as noopener: where this goes is
                            // the operator's business and which receiver
                            // somebody came from is not the destination's.
                            <a
                                className="opnotice__link"
                                href={notice.link.href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {notice.link.label}
                            </a>
                        )}
                    </div>
                    {notice.dismissible && (
                        <button
                            type="button"
                            className="opnotice__close"
                            title="Dismiss"
                            aria-label="Dismiss"
                            onClick={() => setOpen((o) => ({ ...o, [notice.id]: false }))}
                        >
                            <Icon.Close size={12} />
                        </button>
                    )}
                </div>
            ))}
        </div>,
        document.body,
    );
}
