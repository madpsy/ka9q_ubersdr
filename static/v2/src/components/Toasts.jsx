// The toasts themselves: whatever has just been raised, wherever the operator put them.
//
// Mounted once in App rather than by the Notifications panel, for the same reason
// AnnounceWatch is: a panel is unmounted whenever its dock is collapsed, and a
// notification layer that only worked while its own panel happened to be open would be
// the opposite of a notification layer.
//
// A portal into <body>, because a panel that fills its dock clips its body and a toast
// has no business being cropped to whichever dock the code that raised it lives in.

import React, { ReactDOM, useEffect, useRef, useState } from '../react.js';
import { Icon } from './ui.jsx';
import { sinceLabel } from '../lib/format.js';
import {
    dismissAll, dismissNotification, notificationState, onNotifications, toastMs,
} from '../lib/notifications.js';

const ICON = {
    info: <Icon.Info size={14} />,
    good: <Icon.Tick size={14} />,
    warn: <Icon.Info size={14} />,
    bad: <Icon.Close size={14} />,
};

export default function Toasts() {
    const [{ toasts, settings }, setState] = useState(notificationState);
    // One timer per toast, by id. A map rather than a timer per element, so a toast
    // replaced by another with the same key does not leave its old timer running to
    // dismiss the new one.
    const timers = useRef(new Map());

    useEffect(() => onNotifications(setState), []);

    useEffect(() => {
        const live = timers.current;
        const ids = new Set(toasts.map((t) => t.id));
        // Timers for toasts that have gone — dismissed by hand, or pushed off the end.
        for (const [id, handle] of live) {
            if (!ids.has(id)) { clearTimeout(handle); live.delete(id); }
        }
        for (const t of toasts) {
            if (live.has(t.id)) continue;
            const ms = toastMs(t, settings);
            // Zero is "until dismissed": no timer at all rather than a very long one,
            // so nothing can quietly take it away while it is being read.
            if (!ms) continue;
            live.set(t.id, setTimeout(() => dismissNotification(t.id), ms));
        }
    }, [toasts, settings]);

    useEffect(() => () => {
        for (const handle of timers.current.values()) clearTimeout(handle);
        timers.current.clear();
    }, []);

    if (!toasts.length) return null;

    return ReactDOM.createPortal(
        <div className={`toasts toasts--${settings.place}`} role="status" aria-live="polite">
            {/* Newest nearest the edge it came from: at the top of the screen that means
                first in the list, at the bottom it means last, so a new one never pushes
                the one being read out from under the pointer. */}
            {(settings.place.startsWith('bottom') ? [...toasts].reverse() : toasts).map((t) => (
                <div key={t.id} className={`toast is-${t.severity}`}>
                    <span className="toast__icon">{ICON[t.severity] || ICON.info}</span>
                    <div className="toast__text">
                        <div className="toast__head">
                            {t.title && <span className="toast__title">{t.title}</span>}
                            {/* How many times this one has arrived, when it has arrived
                                more than once — the alternative being three identical
                                toasts, which is what the key exists to prevent. */}
                            {t.count > 1 && <span className="toast__count">×{t.count}</span>}
                            {t.source && <span className="toast__source">{t.source}</span>}
                        </div>
                        {t.body && <div className="toast__body">{t.body}</div>}
                        {/* Only on the ones that stay: a toast that is about to vanish
                            does not need to tell you it arrived a moment ago. */}
                        {!toastMs(t, settings) && (
                            <div className="toast__age">{sinceLabel(t.at)} ago</div>
                        )}
                    </div>
                    <button
                        type="button"
                        className="toast__close"
                        title="Dismiss"
                        aria-label="Dismiss"
                        onClick={() => dismissNotification(t.id)}
                    >
                        <Icon.Close size={12} />
                    </button>
                </div>
            ))}
            {/* One press for all of them, and only when there is more than one to clear.
                A stack of sticky notifications is otherwise several presses to get rid
                of, at a moment when somebody is trying to see the spectrum. */}
            {toasts.length > 1 && (
                <button type="button" className="toasts__clear" onClick={dismissAll}>
                    Dismiss all
                </button>
            )}
        </div>,
        document.body,
    );
}
