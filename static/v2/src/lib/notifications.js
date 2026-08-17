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

import { nativePermission, nativeSupported, pageVisible } from './nativeNotices.js';
import { playNoticeDing } from './noticeSound.js';
import { normaliseNoticeAction } from './noticeActions.js';

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
    // The one source that ships *off*, and the only one where that is the right default.
    //
    // Everything else here is an event: the rotator finished, somebody said your name.
    // This is a feed. A skimmer working three bands confirms a few callsigns a minute,
    // and a receiver left on overnight would greet you with a wall of them — so the
    // operator asks for it rather than switching it off, which is the opposite of the
    // rule the rest of this panel follows and for the opposite reason. See defaultOff.
    {
        id: 'voice-callsign',
        panel: 'voiceskimmer',
        label: 'New callsigns',
        note: 'When the Voice Skimmer confirms one it has not heard before',
        defaultOff: true,
    },
    // Off for the same reason and a sharper one: a storm overhead is several strikes a
    // second. What this raises is that lightning has started and how hard it is going —
    // never one line per strike. See lib/lightningStream.js.
    {
        id: 'lightning',
        panel: 'lightning',
        label: 'Lightning',
        note: 'When strikes start, and how hard while they continue',
        defaultOff: true,
    },
];

const sourceEntry = (id) => NOTICE_SOURCES.find((s) => s.id === id) || null;

/**
 * The sources worth offering a switch for on this receiver.
 *
 * A switch for the rotator on a receiver with no rotator is a setting for something that
 * can never happen, and a panel full of them reads as a receiver that has everything and
 * says nothing. So the list is filtered by the same question the docks and the mobile tab
 * bar already ask about the panel behind each source — see usePanelApplies — rather than
 * by a second answer here that could drift from the first.
 *
 * The predicate is passed in rather than imported: this file is a plain store, and
 * reaching into the panel registry from it would point a lib at the panels that use it.
 * The caller does the lookup, exactly as NoticeIcon does for the icons.
 *
 * A source that names no panel, or names one the caller does not recognise, stays. That is
 * the same way round as an unregistered source being unmutable: the cost of showing a
 * switch nobody needs is a line in a panel, and the cost of hiding one is a notification
 * that cannot be switched off.
 */
export function switchableSources(panelApplies) {
    if (typeof panelApplies !== 'function') return NOTICE_SOURCES;
    return NOTICE_SOURCES.filter((s) => !s.panel || panelApplies(s.panel));
}

export const sourceLabel = (id) => {
    const hit = sourceEntry(id);
    return hit ? hit.label : String(id || '');
};

/** Which panel a source belongs to, or '' — for the icon, and nothing else. */
export const sourcePanel = (id) => {
    const hit = sourceEntry(id);
    if (hit && hit.panel) return hit.panel;
    // A source that is not one of the switchable kinds above may still name a
    // panel outright — the Notifications panel's own test does, and anything
    // raised from a panel that has no per-source switch can. Lowercased because
    // the source doubles as the label shown on the toast, so it is written the
    // way it should read; panel ids are lowercase. Unknown names still resolve
    // to nothing, and NoticeIcon draws nothing for them.
    return String(id || '').toLowerCase();
};

// The four severities, in the order they escalate. `good` rather than `success` because
// that is what the rest of the interface calls this colour, and one word for one thing
// across a codebase is worth more than either word is on its own.
export const NOTICE_SEVERITIES = ['info', 'good', 'warn', 'bad'];

// How many are kept. The panel shows five; the rest are there so that "what was that?"
// has an answer a few notifications later, and so the history is worth scrolling.
export const HISTORY_MAX = 50;

// ── Where a notification appears ─────────────────────────────────────────────
//
// A toast is drawn by this page, so it only exists while somebody is looking at the page —
// which is precisely when it is least needed. The interesting notifications (your name in
// chat, the rotator finishing) arrive while the tab is behind something else, and a toast
// behind a hidden tab is a notification nobody received.
//
// So: three choices, and the third is the one worth having.
//
//   'toast'  — always this page's own. No permission, works everywhere, including a receiver
//              served over plain HTTP where the browser API does not exist at all.
//   'native' — always the browser's, so it survives the tab being hidden and lands in the OS
//              notification centre.
//   'auto'   — native when the page is hidden, a toast when it is in front. A system popup
//              over a tab you are already reading is worse than the toast it duplicates, and
//              a toast you cannot see is worse than nothing. Auto is each in its own case.
export const NOTICE_STYLES = [
    { id: 'toast', label: 'In page', note: 'Toasts drawn by the receiver' },
    { id: 'native', label: 'Desktop', note: 'Your browser and system notifications' },
    { id: 'auto', label: 'Auto', note: 'Desktop while this tab is hidden, toasts while it is not' },
];

/**
 * Where one notification should go: 'toast', 'native', 'both' or 'none'.
 *
 * Kept as a pure function of four facts because every interesting case is a *fallback*, and
 * silently delivering nothing is the one outcome that must be impossible:
 *
 *   Permission has not been granted — never asked, or refused, and browsers do not ask twice.
 *   The API is missing entirely, which is every plain-HTTP receiver.
 *   The setting says native but the page is in front, under 'auto'.
 *
 * All of them end at a toast rather than at silence. 'both' is never returned today; it exists
 * because "toast *and* desktop" is a reasonable thing to want and this is where it would be
 * decided rather than in two places at once.
 */
export function deliveryFor({ style, permission, supported, visible } = {}) {
    const canNative = !!supported && permission === 'granted';
    if (!canNative) return 'toast';
    if (style === 'native') return 'native';
    // Hidden: the page cannot show anything anybody will see, so the desktop is the only real
    // delivery. Visible: the page can, and it is the less intrusive of the two.
    if (style === 'auto') return visible ? 'toast' : 'native';
    return 'toast';
}

// How many toasts are on screen at once. Beyond three they are a wall rather than a
// message, and the oldest is the one nobody is reading — so it goes.
export const TOAST_MAX = 3;

// How long two notifications saying exactly the same thing count as one.
//
// `key` is the deliberate version of this and is the better one: a caller that knows two
// events are the same thing says so, and the coalescing then lasts as long as the history
// does. This is the safety net under it — the same words, from the same source, twice in a
// few seconds, is a repeat whether or not anybody thought to key it, and showing it twice
// is a bug of the interface rather than news.
//
// Ten seconds because it has to be long enough to cover a feed that reconnects and replays,
// and short enough that a station calling CQ every half minute is still reported every half
// minute. Beyond the window they are two events again, which is the honest answer: the same
// thing happening twice an hour apart is two things that happened.
export const DEDUPE_MS = 10000;

const KEY = 'ubersdr.v2.notifications';

const DEFAULTS = {
    // On, because a notification system that has to be switched on is a notification
    // system nobody knows they have. The switch is for turning it *off*.
    enabled: true,
    place: 'top-right',
    seconds: 5,
    // In-page toasts until somebody asks for more. Not 'auto' by default, deliberately: auto
    // is worthless without permission, permission needs a prompt, and a receiver that asks
    // for desktop notifications before being told to is a receiver that gets its request
    // refused for the whole session. Choosing Desktop or Auto in the panel is what asks.
    //
    // That is an argument about browsers, and defaultStyle below is where it stops
    // applying.
    style: 'toast',
    // Whether a toast also makes a sound. Off, and this is the one default in this file
    // that needs no argument: a receiver that started making noises at somebody who had
    // not asked for any would be a fault. It goes with the toast rather than with the
    // notification, because it is the in-page half — a desktop notification is announced
    // by the system, with the system's own sound and the system's own settings, and a
    // second ding underneath it would be this page talking over the operating system.
    sound: false,
    // Which sources are silenced, by id. A list of the *off* ones rather than the on
    // ones, so a source added later arrives switched on without a migration — the
    // alternative is every new notification being invisible to everybody who has ever
    // touched this panel.
    muted: [],
    // And the mirror of it, for the sources that ship off: the ones explicitly asked
    // for. Two lists rather than one with a sign, because each is the exception to its
    // own default, and that is what makes both of them survive a source being added —
    // a stored list that named every source's state would have to guess at ids it has
    // never seen. See sourceEnabled.
    unmuted: [],
};

/**
 * 'toast' in a browser, 'auto' where the host owns the notifications.
 *
 * The reason for the toast default is the permission prompt: in a browser it is
 * one shot, spent the moment a page asks, and a receiver that spends it before
 * being told to has spent it for the session. A host that presents this API
 * itself has no such problem — clients/capacitor answers `Notification` from
 * Android's own notification shade, and the permission behind it is the app's,
 * asked for once when audio starts rather than by a page on load.
 *
 * And the case is the opposite one. A tab is on a screen somebody is looking at;
 * a phone is in a pocket, which is the whole situation 'auto' exists for — it
 * still shows a toast while the receiver is in front, and only reaches the
 * shade when it is not.
 *
 * Declared by the host, never sniffed: `ubersdrDesktop.notifications` is the
 * permission state it has already established (see ReceiverActivity), and its
 * presence is the statement that these notifications go somewhere real.
 */
export function defaultStyle() {
    try {
        const host = typeof window !== 'undefined' ? window.ubersdrDesktop : null;
        return host && typeof host.notifications === 'string' ? 'auto' : DEFAULTS.style;
    } catch (e) {
        return DEFAULTS.style;
    }
}

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
            enabled: saved.enabled !== false,
            place: NOTICE_PLACES.some((p) => p.id === saved.place) ? saved.place : DEFAULTS.place,
            seconds: NOTICE_TIMES.includes(Number(saved.seconds))
                ? Number(saved.seconds) : DEFAULTS.seconds,
            sound: saved.sound === true,
            muted: Array.isArray(saved.muted) ? saved.muted.map(String) : [],
            unmuted: Array.isArray(saved.unmuted) ? saved.unmuted.map(String) : [],
            style: NOTICE_STYLES.some((x) => x.id === saved.style) ? saved.style : defaultStyle(),
        };
    } catch (e) {
        return { ...DEFAULTS, style: defaultStyle() };
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
    const style = patch.style === undefined ? settings.style : patch.style;
    settings = {
        enabled: patch.enabled === undefined ? settings.enabled : !!patch.enabled,
        sound: patch.sound === undefined ? settings.sound : !!patch.sound,
        place: NOTICE_PLACES.some((p) => p.id === place) ? place : settings.place,
        seconds: NOTICE_TIMES.includes(seconds) ? seconds : settings.seconds,
        muted: patch.muted === undefined ? settings.muted : [...new Set(patch.muted.map(String))],
        unmuted: patch.unmuted === undefined
            ? settings.unmuted : [...new Set(patch.unmuted.map(String))],
        style: NOTICE_STYLES.some((x) => x.id === style) ? style : settings.style,
    };
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
    // Turning them off clears what is on screen. Leaving three toasts up after the
    // switch went off would read as a switch that does not work.
    if (!settings.enabled) toasts = [];
    notifyAll();
    return settings;
}

/**
 * Whether this source's notifications are wanted.
 *
 * Unknown sources always are — an unregistered source is somebody forgetting to list it,
 * and the failure of that should be a notification that gets through rather than one that
 * vanishes. A `defaultOff` source is the other way round and reads the other list: it is
 * wanted only where it has been asked for by name.
 */
export const sourceEnabled = (id) => {
    const key = String(id || '');
    const entry = sourceEntry(key);
    if (entry && entry.defaultOff) return settings.unmuted.includes(key);
    return !settings.muted.includes(key);
};

/** Turn one source on or off, in whichever list is the exception for it. */
export function setSourceEnabled(id, on) {
    const key = String(id || '');
    if (!key) return settings;
    const entry = sourceEntry(key);
    if (entry && entry.defaultOff) {
        const unmuted = on
            ? [...settings.unmuted, key] : settings.unmuted.filter((m) => m !== key);
        return setNotificationSettings({ unmuted });
    }
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
        // What pressing it does, or null. Validated on the way in rather than on the way
        // out: the history keeps a notification for fifty more, and a malformed action
        // discovered at click time is a crash in a click handler. See lib/noticeActions.js.
        action: normaliseNoticeAction(spec.action),
    };

    // Where this one goes, decided once, here.
    //
    // Not in the two places that draw notifications: a toast layer that decided for itself and
    // a desktop watcher that decided for itself would eventually disagree, and the failure is
    // silent — a notification that neither of them showed. One answer per notification, carried
    // on the notification, and each renderer only has to obey it.
    const how = deliveryFor({
        style: settings.style,
        permission: nativePermission(),
        supported: nativeSupported(),
        visible: pageVisible(),
    });
    item.native = how === 'native' || how === 'both';

    // What this one is a repeat of, if anything.
    //
    // Two ways of being the same notification, and they answer different questions. A key
    // is the caller saying so, and it holds for as long as the history does — a
    // reconnecting stream is the same story an hour later. Identical words from the same
    // source inside DEDUPE_MS is this store noticing, for everything nobody keyed.
    //
    // Either way the answer is the same: replace the earlier one and carry a count, rather
    // than say it twice.
    const same = key
        ? (h) => h.key === key
        : (h) => !h.key && h.source === item.source && h.title === title && h.body === body
            && (now - h.at) < DEDUPE_MS;

    const prevAny = toasts.find(same) || history.find(same);
    if (prevAny) {
        item.count = prevAny.count + 1;
        toasts = toasts.filter((t) => t.id !== prevAny.id);
        history = history.filter((h) => h.id !== prevAny.id);
        // A keyed notification can have several of its own in flight only if something
        // has gone wrong upstream; clearing them all keeps that from accumulating.
        if (key) {
            toasts = toasts.filter((t) => t.key !== key);
            history = history.filter((h) => h.key !== key);
        }
    }

    history = [item, ...history].slice(0, HISTORY_MAX);
    // The history keeps everything either way: "what did that say?" is the panel's job whether
    // the answer appeared on the page, on the desktop, or was silenced by the master switch.
    if (settings.enabled && (how === 'toast' || how === 'both')) {
        toasts = [item, ...toasts].slice(0, TOAST_MAX);
        // With the toast and only with the toast. A notification going to the desktop is
        // announced by the system, which has its own sound and its own idea of whether
        // this is a moment for one; and a notification silenced by the master switch or
        // by its source is one the operator has said they do not want, which a noise
        // would deliver anyway. See lib/noticeSound.js.
        if (settings.sound) playNoticeDing(now);
    }
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
