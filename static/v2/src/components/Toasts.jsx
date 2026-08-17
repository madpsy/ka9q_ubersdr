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
import NoticeIcon from './NoticeIcon.jsx';
import {
    dismissAll, dismissNotification, notificationState, onNotifications, sourceLabel, toastMs,
} from '../lib/notifications.js';
import { noticeActionLabel, runNoticeAction } from '../lib/noticeActions.js';
import { useRadio } from '../radio/RadioContext.jsx';

const ICON = {
    info: <Icon.Info size={14} />,
    good: <Icon.Tick size={14} />,
    warn: <Icon.Info size={14} />,
    bad: <Icon.Close size={14} />,
};

export default function Toasts() {
    const { actions } = useRadio();
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
                <div key={t.id} className={`toast is-${t.severity}${t.action ? ' is-pressable' : ''}`}>
                    {/* The action, as a transparent button over the whole toast rather
                        than as a control inside it.

                        A toast is small, it is read at a glance and it is often on a
                        phone: the target worth offering is the notification itself, not a
                        30 px word in the corner of it. Laid over rather than wrapped
                        around because a <button> may not contain the blocks this is made
                        of, and turning them into spans to satisfy that would be rewriting
                        the layout to hold a click.

                        It sits under the dismiss button, which keeps its own corner — the
                        one press somebody must always be able to make without doing
                        anything else. */}
                    {t.action && (
                        <button
                            type="button"
                            className="toast__act"
                            title={noticeActionLabel(t.action)}
                            aria-label={noticeActionLabel(t.action)}
                            onClick={() => {
                                // Dismissed only if something happened. An action that
                                // could not run leaves the notification where it is,
                                // rather than making the press look like it worked.
                                if (runNoticeAction(t.action, actions)) dismissNotification(t.id);
                            }}
                        />
                    )}
                    <span className="toast__icon">{ICON[t.severity] || ICON.info}</span>
                    <div className="toast__text">
                        <div className="toast__head">
                            {t.title && <span className="toast__title">{t.title}</span>}
                            {/* How many times this one has arrived, when it has arrived
                                more than once — the alternative being three identical
                                toasts, which is what the key exists to prevent. */}
                            {t.count > 1 && <span className="toast__count">×{t.count}</span>}
                            {/* Which panel it came from. The name says where to go; the
                                icon under it is what makes a toast recognisable in the
                                half-second before anybody reads the words, and it is the
                                same glyph as the panel's header and its tab.
                                
                                The icon is a sibling of this row and positioned rather
                                than laid out — see the CSS. At the size worth having it
                                would otherwise set the height of the whole head and push
                                the title and the message down to make room for itself,
                                which is backwards: the words are the notification and the
                                icon is how you spot it. */}
                            {t.source && <span className="toast__source">{sourceLabel(t.source)}</span>}
                        </div>
                        {t.body && <div className="toast__body">{t.body}</div>}
                        {t.source && <NoticeIcon source={t.source} className="toast__panel-icon" />}
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
