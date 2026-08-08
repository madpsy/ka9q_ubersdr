// Notifications: one line of code from anywhere, a toast on screen, and a short history.
//
// ── How a panel raises one ───────────────────────────────────────────────────
//
//     import { pushNotification } from '../lib/notifications.js';
//
//     pushNotification({
//         severity: 'warn',                 // 'info' | 'good' | 'warn' | 'bad'
//         title: 'Recorder',                // a few words; the toast's heading
//         body: 'Disk is nearly full',      // a sentence, optional
//         source: 'recorder',               // a NOTICE_SOURCES id: names it, and lets
//                                           // the operator switch this kind off
//         key: 'recorder-disk',             // optional: replaces its own earlier toast
//         timeout: 0,                       // optional: 0 stays until dismissed
//     });
//
// That is the whole interface. No hook, no context, no provider — it is a plain function
// call, so it works from an effect, a callback, a promise handler, a module with no React
// in it at all, and from a panel that is not mounted. That last one matters more than it
// sounds: half the things worth announcing happen in a store or a watcher rather than in
// the panel that shows them.
//
// ── Why it is a store and not a context ──────────────────────────────────────
//
// A context would mean every raiser needed a hook, which means every raiser has to be a
// component, which rules out exactly the code most likely to have something to say — the
// stream that just dropped, the poll that just failed. So: a module with subscribers, in
// the shape the other stores here use.
//
// The operator's settings live here too rather than in the display settings, for the same
// reason: the toast layer and the panel both read them, and neither is a good owner.

// Where toasts appear. Two axes, kept as one value because it is one decision and a
// stored pair could disagree with itself.
export const NOTICE_PLACES = [
    { id: 'top-left', label: 'Top left' },
    { id: 'top-centre', label: 'Top centre' },
    { id: 'top-right', label: 'Top right' },
    { id: 'bottom-left', label: 'Bottom left' },
    { id: 'bottom-centre', label: 'Bottom centre' },
    { id: 'bottom-right', label: 'Bottom right' },
];

// How long one stays, in seconds. Zero means until it is dismissed — offered because a
// notification somebody has to *act* on should not disappear while they are reading it,
// and refused as the default for the obvious reason.
export const NOTICE_TIMES = [3, 5, 8, 15, 0];

// Where notifications come from, and what to call it.
//
// A registry rather than a free string, because the panel offers a switch per source and
// a switch needs something stable to be about — and because a source that can be turned
// off has to be listed somewhere the operator can find it. Adding one is an entry here
// plus the `source` on the push; nothing else changes.
//
// A push with a source that is not listed still works and cannot be muted. That is the
// right way round: the failure of somebody forgetting to register a source should be a
// notification that gets through, not one that vanishes.
// `panel` is the panel id in panels/registry.jsx, and it is there so a notification can
// wear that panel's own icon — the one on its header and its mobile tab. A notification
// that looks like the panel it came from is one you can place without reading it, which is
// most of what a toast has time to be.
//
// Kept as an id rather than the icon itself: this file is a plain store and importing the
// panel registry into it would point a lib at the panels that use it. The components do
// the lookup — see NoticeIcon.
export const NOTICE_SOURCES = [
    {
        id: 'rotator',
        panel: 'rotator',
        label: 'Rotator',
        note: 'When the beam stops moving',
    },
    {
        id: 'antenna',
        panel: 'antenna',
        label: 'Antenna switch',
        note: 'When the antenna or grounding changes',
    },
    // Two sources rather than one, because the two halves of chat are wanted to very
    // different degrees: being spoken to is always worth an interruption, and somebody
    // arriving is worth one on a quiet receiver and not on a busy one. One switch would have
    // meant choosing between missing your name and a toast every few minutes.
    {
        id: 'chat-mention',
        panel: 'chat',
        label: 'Chat mentions',
        note: 'When somebody says your name',
    },
    {
        id: 'chat-join',
        panel: 'chat',
        label: 'Chat arrivals',
        note: 'When somebody joins the channel',
    },
];

const sourceEntry = (id) => NOTICE_SOURCES.find((s) => s.id === id) || null;

export const sourceLabel = (id) => {
    const hit = sourceEntry(id);
    return hit ? hit.label : String(id || '');
};

/** Which panel a source belongs to, or '' — for the icon, and nothing else. */
export const sourcePanel = (id) => {
    const hit = sourceEntry(id);
    return (hit && hit.panel) || '';
};

// The four severities, in the order they escalate. `good` rather than `success` because
// that is what the rest of the interface calls this colour, and one word for one thing
// across a codebase is worth more than either word is on its own.
export const NOTICE_SEVERITIES = ['info', 'good', 'warn', 'bad'];

// How many are kept. The panel shows five; the rest are there so that "what was that?"
// has an answer a few notifications later, and so the history is worth scrolling.
export const HISTORY_MAX = 50;

// How many toasts are on screen at once. Beyond three they are a wall rather than a
// message, and the oldest is the one nobody is reading — so it goes.
export const TOAST_MAX = 3;

const KEY = 'ubersdr.v2.notifications';

const DEFAULTS = {
    // On, because a notification system that has to be switched on is a notification
    // system nobody knows they have. The switch is for turning it *off*.
    enabled: true,
    place: 'top-right',
    seconds: 5,
    // Which sources are silenced, by id. A list of the *off* ones rather than the on
    // ones, so a source added later arrives switched on without a migration — the
    // alternative is every new notification being invisible to everybody who has ever
    // touched this panel.
    muted: [],
};

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
            enabled: saved.enabled !== false,
            place: NOTICE_PLACES.some((p) => p.id === saved.place) ? saved.place : DEFAULTS.place,
            seconds: NOTICE_TIMES.includes(Number(saved.seconds))
                ? Number(saved.seconds) : DEFAULTS.seconds,
            muted: Array.isArray(saved.muted) ? saved.muted.map(String) : [],
        };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

let settings = load();
// Newest first, both of them: a list somebody reads from the top.
let toasts = [];
let history = [];
let nextId = 1;
const listeners = new Set();

function notifyAll() {
    const state = { toasts, history, settings };
    for (const fn of Array.from(listeners)) {
        try { fn(state); } catch (err) { console.error('notification subscriber threw', err); }
    }
}

export const notificationState = () => ({ toasts, history, settings });
export const notificationSettings = () => settings;

export function onNotifications(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function setNotificationSettings(patch) {
    const place = patch.place === undefined ? settings.place : patch.place;
    const seconds = patch.seconds === undefined ? settings.seconds : Number(patch.seconds);
    settings = {
        enabled: patch.enabled === undefined ? settings.enabled : !!patch.enabled,
        place: NOTICE_PLACES.some((p) => p.id === place) ? place : settings.place,
        seconds: NOTICE_TIMES.includes(seconds) ? seconds : settings.seconds,
        muted: patch.muted === undefined ? settings.muted : [...new Set(patch.muted.map(String))],
    };
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
    // Turning them off clears what is on screen. Leaving three toasts up after the
    // switch went off would read as a switch that does not work.
    if (!settings.enabled) toasts = [];
    notifyAll();
    return settings;
}

/** Whether this source's notifications are wanted. Unknown sources always are. */
export const sourceEnabled = (id) => !settings.muted.includes(String(id || ''));

/** Turn one source on or off. */
export function setSourceEnabled(id, on) {
    const key = String(id || '');
    if (!key) return settings;
    const muted = on ? settings.muted.filter((m) => m !== key) : [...settings.muted, key];
    return setNotificationSettings({ muted });
}

/** A severity, made safe. Anything unrecognised is information. */
export const severityOf = (s) => (NOTICE_SEVERITIES.includes(s) ? s : 'info');

/**
 * Raise one. Returns its id, or 0 when nothing was raised.
 *
 * The history is kept even with notifications switched off. The switch is about toasts
 * — about the interface interrupting you — and a receiver that quietly stopped recording
 * what happened would be answering a different question. The panel is where you go to
 * find out what you missed, and it should have something to say either way.
 *
 * `key` coalesces: a second notification with the same key replaces the first rather
 * than stacking on it, and carries a count. That is what stops a reconnecting stream
 * from filling the screen with the same sentence.
 *
 * A muted source is dropped entirely — no toast and no history. That is the difference
 * between the master switch and a source switch: the master silences the interruption and
 * keeps the record, because it is about this moment; a source switch says "I do not care
 * about this", and a log of things nobody cares about is not worth keeping.
 */
export function pushNotification(spec = {}, now = Date.now()) {
    const title = String(spec.title || '').trim();
    const body = String(spec.body || '').trim();
    // Nothing to say, nothing to show: a toast with no words is a coloured box.
    if (!title && !body) return 0;

    if (spec.source && !sourceEnabled(spec.source)) return 0;

    const id = nextId++;
    const key = spec.key ? String(spec.key) : '';
    const item = {
        id,
        key,
        severity: severityOf(spec.severity),
        title,
        body,
        source: String(spec.source || '').trim(),
        at: now,
        // How many times this key has arrived. Shown as "×3" rather than as three
        // toasts, which is the whole point of a key.
        count: 1,
        // Per-notification override, in seconds: absent means the operator's setting,
        // and 0 means it waits to be dismissed. A caller only sets this when it knows
        // something the setting cannot — that this one has to be acted on.
        seconds: spec.timeout == null ? null : Math.max(0, Number(spec.timeout) || 0),
    };

    if (key) {
        const prevToast = toasts.find((t) => t.key === key);
        const prevAny = prevToast || history.find((h) => h.key === key);
        if (prevAny) item.count = prevAny.count + 1;
        toasts = toasts.filter((t) => t.key !== key);
        history = history.filter((h) => h.key !== key);
    }

    history = [item, ...history].slice(0, HISTORY_MAX);
    if (settings.enabled) toasts = [item, ...toasts].slice(0, TOAST_MAX);
    notifyAll();
    return id;
}

/** How long this one should stay up, in ms. 0 means until dismissed. */
export function toastMs(item, current = settings) {
    const secs = item && item.seconds != null ? item.seconds : (current || settings).seconds;
    return Math.max(0, secs) * 1000;
}

export function dismissNotification(id) {
    const before = toasts.length;
    toasts = toasts.filter((t) => t.id !== id);
    if (toasts.length !== before) notifyAll();
}

/** Clear the toasts, leaving the history — what the toast layer's "clear" means. */
export function dismissAll() {
    if (!toasts.length) return;
    toasts = [];
    notifyAll();
}

/** Clear the history as well, which is the panel's own button. */
export function clearNotifications() {
    toasts = [];
    history = [];
    notifyAll();
}

/** Test seam. */
export function _resetNotifications() {
    settings = { ...DEFAULTS };
    toasts = [];
    history = [];
    nextId = 1;
    listeners.clear();
}
