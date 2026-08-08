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
import {
    NOTICE_PLACES, NOTICE_SOURCES, NOTICE_TIMES, clearNotifications, notificationState,
    onNotifications, pushNotification, setNotificationSettings, setSourceEnabled,
    sourceEnabled, sourceLabel,
} from '../lib/notifications.js';

// How many the panel lists. Five is what fits a dock column without scrolling and about
// as far back as anybody asks; the store keeps fifty, so the number here can grow without
// anything else changing.
const SHOWN = 5;

const TIME_LABEL = (s) => (s === 0 ? 'Until dismissed' : `${s} seconds`);

export default function NotificationsPanel({ minimal }) {
    const [{ history, settings }, setState] = useState(notificationState);
    useEffect(() => onNotifications(setState), []);

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
                            {n.source && <div className="notes__source">{sourceLabel(n.source)}</div>}
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
                            {/* Six choices as a two-row grid rather than a dropdown: it is
                                a position, and a picture of the screen's corners reads as
                                one where a list of words does not. */}
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

                            <Field label="For" hint={TIME_LABEL(settings.seconds)}>
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
                        <Field key={src.id} label={src.label} hint={src.note} inline>
                            <Switch
                                checked={sourceEnabled(src.id)}
                                onChange={(v) => setSourceEnabled(src.id, v)}
                            />
                        </Field>
                    ))}

                    <div className="note note--tight">
                        Anything in the receiver can raise one, and each kind can be
                        switched off above. Notifications are kept here whether toasts are
                        showing or not.
                    </div>
                </>
            )}
        </div>
    );
}
