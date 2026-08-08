// Notifications: what has been raised lately, and how the toasts behave.
//
// The panel is not where notifications come from — any code in the app raises one with a
// single call, see lib/notifications.js — it is where they are *kept*. Two jobs:
//
//   The last few, because a toast is gone in five seconds and "what did that say?" needs
//   an answer. This is the only place that has one.
//
//   The settings: whether toasts appear at all, where, and for how long. They are here
//   rather than in the Display panel because they are not about how the receiver looks;
//   they are about how much it is allowed to interrupt.
//
// `minimal` is the list alone. The settings are set once and left, which is exactly what
// a minimal view is for dropping.

import React, { useEffect, useState } from '../react.js';
import { Button, Empty, Field, Segmented, Switch } from '../components/ui.jsx';
import { sinceLabel } from '../lib/format.js';
import NoticeIcon from '../components/NoticeIcon.jsx';
import {
    NOTICE_PLACES, NOTICE_SOURCES, NOTICE_STYLES, NOTICE_TIMES, clearNotifications,
    notificationState, onNotifications, pushNotification, setNotificationSettings,
    setSourceEnabled, sourceEnabled, sourceLabel,
} from '../lib/notifications.js';
import { nativePermission, requestNativePermission } from '../lib/nativeNotices.js';

// How many the panel lists. Five is what fits a dock column without scrolling and about
// as far back as anybody asks; the store keeps fifty, so the number here can grow without
// anything else changing.
const SHOWN = 5;

const TIME_LABEL = (s) => (s === 0 ? 'Until dismissed' : `${s} seconds`);

const STYLE_NOTE = (id) => (NOTICE_STYLES.find((x) => x.id === id) || {}).note || '';

// What to say about the browser's permission, when there is something to say. Only ever a
// statement of fact: the one outcome to avoid is a chosen setting that quietly delivers
// nothing, so a refusal is spelled out and the fallback named.
function permissionNote(permission, style) {
    if (permission === 'unsupported') {
        return 'Desktop notifications need a secure (https) connection — this one is not, so'
            + ' toasts are all this browser can offer here.';
    }
    if (permission === 'denied') {
        return 'Your browser has blocked notifications for this site. Toasts are being shown'
            + ' instead; the block can only be lifted in the browser\u2019s own site settings.';
    }
    if (permission === 'default' && style !== 'toast') {
        return 'Your browser has not been asked yet — choose Desktop or Auto again to ask.';
    }
    return '';
}

export default function NotificationsPanel({ minimal }) {
    const [{ history, settings }, setState] = useState(notificationState);
    useEffect(() => onNotifications(setState), []);
    // Read rather than stored: the browser owns it, and it can change in the browser's own
    // settings while this panel is open. Kept in state only so a decision redraws the panel.
    const [permission, setPermission] = useState(nativePermission);

    // Choosing Desktop or Auto is the request. A permission prompt has to come from a user
    // gesture — Safari requires it, Firefox has since 72 — so there is no separate "allow"
    // button to find: the press that says what you want is the press that asks for it.
    //
    // And the choice only sticks if the answer allows it. Storing 'auto' against a refusal
    // would leave a setting that reads as configured and delivers nothing.
    const chooseStyle = async (style) => {
        if (style === 'toast') {
            setNotificationSettings({ style });
            return;
        }
        const answer = await requestNativePermission();
        setPermission(answer);
        setNotificationSettings({ style: answer === 'granted' ? style : 'toast' });
    };

    // Redrawn on the clock so "2m ago" stays true between notifications, which arrive
    // far too rarely to be relied on for that.
    const [, tick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => tick((n) => n + 1), 15000);
        return () => clearInterval(id);
    }, []);

    const shown = history.slice(0, SHOWN);

    return (
        <div className="stack">
            {shown.length === 0 ? (
                <Empty>Nothing yet.</Empty>
            ) : (
                <ul className="notes">
                    {shown.map((n) => (
                        <li key={n.id} className={`notes__row is-${n.severity}`}>
                            <div className="notes__head">
                                <span className="notes__title">{n.title}</span>
                                {n.count > 1 && <span className="notes__count">×{n.count}</span>}
                                <span className="notes__age">{sinceLabel(n.at)}</span>
                            </div>
                            {n.body && <div className="notes__body">{n.body}</div>}
                            {/* The same pairing as the toast, so a notification looks like
                                itself in both places. */}
                            {n.source && (
                                <div className="notes__source">
                                    <NoticeIcon source={n.source} className="notes__icon" />
                                    {sourceLabel(n.source)}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {!minimal && (
                <>
                    {history.length > 0 && (
                        <div className="row-end">
                            <Button size="sm" variant="ghost" onClick={clearNotifications}>
                                Clear
                            </Button>
                        </div>
                    )}

                    <div className="divider" />

                    {/* The switch is for turning them off. They ship on, because a
                        notification system that has to be found and enabled is one nobody
                        knows they have — and the history is kept either way, so switching
                        them off silences the interruption without losing the record. */}
                    <Field label="Show toasts" hint={settings.enabled ? undefined : 'history only'} inline>
                        <Switch
                            checked={settings.enabled}
                            onChange={(v) => setNotificationSettings({ enabled: v })}
                        />
                    </Field>

                    {settings.enabled && (
                        <>
                            {/* One control, and choosing it is what asks the browser for
                                permission — a prompt has to come from a press, and this is the
                                press. If the answer is no, the choice falls back to toasts and
                                says so rather than leaving a setting that delivers nothing. */}
                            <Field label="Show as" hint={STYLE_NOTE(settings.style)}>
                                <Segmented
                                    size="sm"
                                    value={settings.style}
                                    onChange={chooseStyle}
                                    options={NOTICE_STYLES.map((x) => ({
                                        value: x.id,
                                        label: x.label,
                                        title: x.note,
                                        // Nothing to choose where the API is absent: the label
                                        // stays visible so it is clear what is missing, and the
                                        // note below says why.
                                        disabled: x.id !== 'toast' && permission === 'unsupported',
                                    }))}
                                />
                            </Field>

                            {permissionNote(permission, settings.style) && (
                                <div className="note note--tight">
                                    {permissionNote(permission, settings.style)}
                                </div>
                            )}

                            {/* Both of these only describe a toast, so they go when there will
                                not be one: a desktop notification is placed and timed by the
                                system, and offering settings that cannot be honoured is worse
                                than offering none.

                                Six positions as a two-row grid rather than a dropdown — it is a
                                position, and a picture of the screen's corners reads as one
                                where a list of words does not. */}
                            {settings.style !== 'native' && (
                            <>
                            <Field label="Where">
                                <Segmented
                                    size="sm"
                                    columns={3}
                                    value={settings.place}
                                    onChange={(v) => setNotificationSettings({ place: v })}
                                    options={NOTICE_PLACES.map((p) => ({
                                        value: p.id,
                                        label: p.label.replace('Top ', '↑ ').replace('Bottom ', '↓ '),
                                        title: p.label,
                                    }))}
                                />
                            </Field>

                            <Field
                                label="For"
                                hint={settings.style === 'auto'
                                    ? `${TIME_LABEL(settings.seconds)} — toasts only`
                                    : TIME_LABEL(settings.seconds)}
                            >
                                <Segmented
                                    size="sm"
                                    value={settings.seconds}
                                    onChange={(v) => setNotificationSettings({ seconds: v })}
                                    options={NOTICE_TIMES.map((s) => ({
                                        value: s,
                                        label: s === 0 ? '∞' : `${s}s`,
                                        title: TIME_LABEL(s),
                                    }))}
                                />
                            </Field>
                            </>
                            )}

                            {/* Because "where" and "for how long" are questions you answer
                                by looking, not by reading — and because a notification
                                system with nothing to show is impossible to set up. */}
                            <div className="chip-row">
                                <button
                                    type="button"
                                    className="chip chip--button"
                                    onClick={() => pushNotification({
                                        severity: 'info',
                                        title: 'Test notification',
                                        body: 'This is what a notification looks like here.',
                                        // Names this panel, so the test wears the
                                        // same icon a real notification from here
                                        // would — the point of the test being to
                                        // show what one looks like. See
                                        // sourcePanel, which resolves a source
                                        // that names a panel outright.
                                        source: 'Notifications',
                                        key: 'notifications-test',
                                    })}
                                >
                                    Show a test
                                </button>
                            </div>
                        </>
                    )}

                    <div className="divider" />

                    {/* One switch per thing that raises notifications, so "I do not care
                        about the rotator" is sayable without silencing everything.

                        These are stronger than the master switch above: a muted source is
                        not recorded either. The master switch is about being interrupted
                        right now, so it keeps the history; a source switch says you do not
                        want to know, and a log of things nobody wants to know is not worth
                        keeping. Muting the rotator also stops it being polled — see
                        HardwareNoticeWatch. */}
                    <div className="section-label"><span>From</span></div>
                    {NOTICE_SOURCES.map((src) => (
                        <Field
                            key={src.id}
                            label={(
                                <span className="notes__switch">
                                    <NoticeIcon source={src.id} className="notes__icon" />
                                    {src.label}
                                </span>
                            )}
                            hint={src.note}
                            inline
                        >
                            <Switch
                                checked={sourceEnabled(src.id)}
                                onChange={(v) => setSourceEnabled(src.id, v)}
                            />
                        </Field>
                    ))}
                </>
            )}
        </div>
    );
}
