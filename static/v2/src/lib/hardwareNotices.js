// The rotator and the antenna switch, watched for the two things worth being told about.
//
// v1 raised both of these (static/rotator-ui.js): a toast when the rotator finished
// moving, and one when the antenna selection or the grounding changed. They are the right
// first two for the notification system, and for the same reason v1 chose them — both are
// slow, physical things that happen *after* you have looked away. You press a bearing and
// go back to listening; the rotator takes half a minute to get there. Somebody else on the
// receiver grounds the array because of a storm; nothing on your screen says so.
//
// ── Why the polling is here and not in the panels ────────────────────────────
//
// Both panels used to poll their own status, which would have made these notifications
// worthless: a panel is unmounted when its dock is collapsed, and the antenna panel in
// particular is closed most of the time. A notification you only get while looking at the
// thing it is about is not a notification.
//
// So the poll lives here, one per subsystem, shared by the panel and by the watcher that
// keeps it running with every panel shut. Subscribing starts it and the last unsubscribe
// stops it, which is the same shape the voice-activity and packet-marker stores use.

import { pushNotification } from './notifications.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';

// v1's cadences, kept: a rotator is worth a second's resolution because you are waiting
// for it, and an antenna switch changes when somebody presses something.
export const ROTATOR_POLL_MS = 1000;
export const ANTENNA_POLL_MS = 5000;

// ── The rotator ─────────────────────────────────────────────────────────────

const rot = { subs: new Set(), timer: null, latest: null, moving: false, seen: false };

function rotNotify() {
    for (const fn of Array.from(rot.subs)) {
        try { fn(rot.latest); } catch (e) { console.error('rotator subscriber threw', e); }
    }
}

/**
 * The transition worth telling somebody about: moving to stopped.
 *
 * Only after a cycle that was actually moving — v1's guard, and it is the right one. The
 * first status of a page load is a rotator that is not moving, and announcing "stopped"
 * because you opened the panel would be a notification about nothing.
 */
function rotSaw(status) {
    const moving = !!(status && status.moving);
    if (rot.seen && rot.moving && !moving && status && status.connected) {
        const az = status.position && status.position.azimuth != null
            ? `${Math.round(status.position.azimuth)}°` : '';
        pushNotification({
            severity: 'good',
            source: 'rotator',
            title: az ? `Rotator stopped at ${az}` : 'Rotator stopped',
            body: az ? 'The beam is where it was asked to go.' : '',
            // Keyed, so a rotator nudged three times in a minute is one line with a
            // count rather than three toasts saying the same thing.
            key: 'rotator-stopped',
        });
    }
    rot.moving = moving;
    rot.seen = true;
}

function rotLoad() {
    fetch('/api/rotctl/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            if (!d) return;
            rot.latest = d;
            rotSaw(d);
            rotNotify();
        })
        .catch(() => {
            // A failed poll is not a disconnected rotator as far as the notification is
            // concerned — it says nothing about whether the mast is turning — but the
            // panel still wants to know, so the state is passed on and the transition
            // check is skipped.
            rot.latest = { ...(rot.latest || {}), connected: false };
            rotNotify();
        });
}

export const rotatorStatus = () => rot.latest;

export function subscribeRotator(fn) {
    rot.subs.add(fn);
    if (rot.latest) {
        try { fn(rot.latest); } catch (e) { console.error('rotator subscriber threw', e); }
    }
    if (rot.timer === null) {
        rot.timer = feedInterval(rotLoad, ROTATOR_POLL_MS);
    }
    return () => {
        rot.subs.delete(fn);
        if (!rot.subs.size && rot.timer !== null) {
            rot.timer();
            rot.timer = null;
        }
    };
}

// ── The antenna switch ──────────────────────────────────────────────────────

const ant = { subs: new Set(), timer: null, latest: null, sel: null, grounded: false };

function antNotify() {
    for (const fn of Array.from(ant.subs)) {
        try { fn(ant.latest); } catch (e) { console.error('antenna subscriber threw', e); }
    }
}

/** The selection as a comparable string, so two arrays in a different order match. */
export const selectionKey = (sel) => (Array.isArray(sel) ? [...sel].sort((a, b) => a - b).join(',') : '');

/** What an antenna is called: the operator's label where there is one. */
export function antennaName(status, n) {
    const labels = (status && status.antenna_labels) || [];
    return labels[n - 1] || `Antenna ${n}`;
}

/**
 * A change of antenna, or the array being grounded.
 *
 * The first status is a baseline and never a notification — v1's rule, and without it
 * every page load would announce whichever antenna was already selected.
 *
 * Grounding is called out separately because it is the one that matters: it usually means
 * a thunderstorm, it is the state the buttons cannot show, and it is the difference
 * between a quiet band and a disconnected aerial.
 */
function antSaw(status) {
    const sel = selectionKey(status && status.selected);
    const grounded = !!(status && status.grounded);
    if (ant.sel !== null && (sel !== ant.sel || grounded !== ant.grounded)) {
        if (grounded) {
            pushNotification({
                severity: 'warn',
                source: 'antenna',
                title: 'Antenna grounded',
                body: 'The array is disconnected — nothing will be heard until it is selected again.',
                key: 'antenna-change',
            });
        } else {
            const names = (status.selected || []).map((sn) => antennaName(status, sn));
            pushNotification({
                severity: 'info',
                source: 'antenna',
                title: names.length ? `Antenna: ${names.join(', ')}` : 'No antenna selected',
                body: ant.grounded ? 'No longer grounded.' : '',
                key: 'antenna-change',
            });
        }
    }
    ant.sel = sel;
    ant.grounded = grounded;
}

function antLoad() {
    fetch('/api/ant-switch/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            if (!d) return;
            ant.latest = d;
            antSaw(d);
            antNotify();
        })
        .catch(() => { /* keep the last known state: a failed poll changes nothing */ });
}

export const antennaStatus = () => ant.latest;

export function subscribeAntenna(fn) {
    ant.subs.add(fn);
    if (ant.latest) {
        try { fn(ant.latest); } catch (e) { console.error('antenna subscriber threw', e); }
    }
    if (ant.timer === null) {
        ant.timer = feedInterval(antLoad, ANTENNA_POLL_MS);
    }
    return () => {
        ant.subs.delete(fn);
        if (!ant.subs.size && ant.timer !== null) {
            ant.timer();
            ant.timer = null;
        }
    };
}

/**
 * Push a status in from outside, without waiting for the next poll.
 *
 * The panels get a reply from their own POSTs — selecting an antenna answers with the new
 * selection — and folding that in makes the button feel immediate instead of taking up to
 * five seconds to light. It goes through the same transition check, so an antenna changed
 * from this browser is announced exactly as one changed from another is.
 */
export function feedAntennaStatus(patch) {
    if (!patch) return;
    ant.latest = { ...(ant.latest || {}), ...patch };
    antSaw(ant.latest);
    antNotify();
}

/** Test seam. */
export function _resetHardwareNotices() {
    // A store under test polls: the feed gate is the receiver's business, it
    // has its own tests, and every case here is about this module's refcounting
    // rather than about being switched off. See lib/serverFeeds.js.
    setFeedsAllowed(true);
    for (const s of [rot, ant]) {
        s.subs.clear();
        if (s.timer !== null) s.timer();
        s.timer = null;
        s.latest = null;
    }
    rot.moving = false;
    rot.seen = false;
    ant.sel = null;
    ant.grounded = false;
}
