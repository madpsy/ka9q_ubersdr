// The lightning addon's strike feed, owned by the page rather than by the panel.
//
// It started in the panel, and for as long as the panel was the only thing that wanted it
// that was right: an EventSource opened on mount and closed on unmount costs nothing while
// the section is collapsed, which is most of the time. What changed is that the strikes are
// now worth a notification, and a notification you only get while looking at the panel it
// came from is not a notification — the same argument that put the rotator's poll in
// lib/hardwareNotices.js rather than in the panel that shows it.
//
// So: one stream for the whole page, started by the first subscriber and stopped when the
// last one goes. The panel subscribes because it draws them; LightningNoticeWatch — see
// components/AddonNoticeWatch.jsx — subscribes because somebody asked to be told. Both at
// once is still one connection.
//
// Everything about *what* a strike is stays in lib/lightning.js, which is a pure module and
// stays that way. This is the connection and the list; that is the vocabulary.

import { retryDelay } from './backoff.js';
import {
    addStrike, normaliseStrike, shortClock, snrBand, strikesUrl, streamUrl, trimStrikes,
} from './lightning.js';
import { feedsAllowed, onFeedsAllowed } from './serverFeeds.js';
import { pushNotification, sourceEnabled } from './notifications.js';

// How often the list is swept for strikes that have aged out of the hour. On arrival is
// not enough on its own — an hour after a storm the list would otherwise sit there full
// until the next strike — and the panel's own clock tick redraws the figures anyway, so
// this only has to be faster than anybody would notice against an hour.
export const TRIM_MS = 10000;

// ── When a strike is worth saying something about ────────────────────────────
//
// Not "every strike": a storm overhead is several a second, and one notification each
// would be a strobe that buries everything else in the panel and on the desktop. Two
// things are worth being told, and they are the two the panel is read for:
//
//   It has started. A strike after a long quiet spell is the news — it is why somebody
//   would switch this on at all, and on a bad day it is the cue to go and unplug an
//   antenna. That one goes out immediately.
//
//   It is still going, and how hard. While strikes keep arriving, one line a minute
//   carrying the count and the hardest of them, replacing its own previous line rather
//   than stacking. A rate and a peak are what the panel's own headline figures are, and
//   they are what a glance at a notification can carry.
export const QUIET_MS = 10 * 60 * 1000;
export const NOTICE_EVERY_MS = 60 * 1000;

const subs = new Set();

let strikes = [];
let live = false;
let state = 'loading';
// The newest strike that arrived on the stream rather than in the backfill. The panel
// flashes on it, and an hour of history arriving in one lump must not flash sixty times.
let lastLive = null;

let es = null;
let retryTimer = null;
let attempts = 0;
let started = false;
let gateOff = null;
let trimTimer = null;
let loadId = 0;

// Notification bookkeeping, kept out of the strike list because none of it is a strike:
// when the last one arrived, when something was last said, and what has happened since.
let lastStrikeAt = 0;
let lastNoticeAt = 0;
let sinceNotice = 0;
let peakSince = 0;

export const lightningState = () => ({ strikes, live, state, lastLive });

function notify() {
    const snap = lightningState();
    for (const fn of Array.from(subs)) {
        try { fn(snap); } catch (err) { console.error('lightning subscriber threw', err); }
    }
}

/**
 * What to say about a strike, or nothing.
 *
 * Pure, and given everything it needs, so the decision can be tested without a stream: the
 * interesting cases are all about time passing, and none of them are about EventSource.
 *
 * `first` is a strike after a quiet spell and is its own line, kept in the history — that
 * a storm began at ten past four is worth still being able to read at five. The running
 * one replaces itself, because "how hard is it now" has exactly one current answer.
 *
 * Severity comes from the addon's own SNR bands, so a strike this calls close is the one
 * its page colours as close: at that strength it is near enough to be the reason somebody
 * switched this on.
 */
export function strikeNotice({ first, strike, since, peak }) {
    const hard = snrBand(first ? strike.snr : peak) === 'hi';
    if (first) {
        return {
            severity: hard ? 'warn' : 'info',
            source: 'lightning',
            title: '⚡ Lightning detected',
            body: `${Math.round(strike.snr)} dB at ${shortClock(strike.time)}`,
            key: 'lightning-began',
        };
    }
    return {
        severity: hard ? 'warn' : 'info',
        source: 'lightning',
        title: `⚡ ${since} strike${since === 1 ? '' : 's'} a minute`,
        body: `Hardest ${Math.round(peak)} dB · last at ${shortClock(strike.time)}`,
        key: 'lightning-rate',
    };
}

/**
 * A live strike, considered for a notification.
 *
 * The clock state moves whether or not anybody is listening, exactly as the confirmed-voice
 * announcer's does: switching the source on is then a statement about what happens next,
 * rather than an immediate claim that a storm just started because this is the first strike
 * *it* has seen.
 */
function noticeStrike(s, now) {
    const first = !lastStrikeAt || (now - lastStrikeAt) >= QUIET_MS;
    lastStrikeAt = now;
    if (first) {
        sinceNotice = 0;
        peakSince = 0;
    }
    sinceNotice++;
    if (s.snr > peakSince) peakSince = s.snr;

    if (!sourceEnabled('lightning')) {
        // Not wanted. The counters still had to move — see above — but nothing is said,
        // and the window closes so that switching it on does not immediately report a
        // minute somebody did not ask about.
        if (first || (now - lastNoticeAt) >= NOTICE_EVERY_MS) {
            lastNoticeAt = now;
            sinceNotice = 0;
            peakSince = 0;
        }
        return;
    }

    if (!first && (now - lastNoticeAt) < NOTICE_EVERY_MS) return;

    pushNotification(strikeNotice({ first, strike: s, since: sinceNotice, peak: peakSince }));
    lastNoticeAt = now;
    sinceNotice = 0;
    peakSince = 0;
}

function take(raw, arrivedAt) {
    const s = normaliseStrike(raw, arrivedAt);
    if (!s) return;
    const before = strikes;
    strikes = addStrike(strikes, s);
    // A duplicate — the backfill and the stream overlap by however long the first request
    // took — is not a new strike and must not flash, notify or be counted.
    if (strikes === before) return;
    if (arrivedAt != null) {
        lastLive = s;
        noticeStrike(s, arrivedAt);
    }
    notify();
}

function backfill() {
    const mine = ++loadId;
    fetch(strikesUrl())
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((rows) => {
            // A reply to a stream that has since been stopped and restarted is not this
            // stream's, and dropping it is the only way the two cannot interleave.
            if (mine !== loadId) return;
            const list = Array.isArray(rows) ? rows : [];
            // The addon returns oldest first; everything here works newest first. Merged
            // rather than assigned: the stream may already have delivered strikes while
            // this request was in flight, and addStrike deduplicates by id.
            const older = trimStrikes(list.map((r) => normaliseStrike(r)).filter(Boolean).reverse());
            for (const s of older) strikes = addStrike(strikes, s);
            state = 'ok';
            notify();
        })
        .catch(() => {
            if (mine !== loadId) return;
            // Not fatal: the stream may still connect, and a receiver that has just started
            // has no history to send. The state only decides what an empty panel says.
            state = 'error';
            notify();
        });
}

// The stream, with the band spectrum panel's policy: every failure closes it and reopens on
// the backoff curve, so there is one schedule rather than the browser's running alongside
// ours. See lib/backoff.js.
function open() {
    es = new EventSource(streamUrl());

    es.addEventListener('open', () => { state = 'ok'; notify(); });
    // Unnamed messages are the strikes. In the compact stream they are the only thing sent
    // besides the heartbeat.
    es.addEventListener('message', (e) => {
        attempts = 0;
        live = true;
        try { take(JSON.parse(e.data), Date.now()); } catch (err) { /* not a strike */ }
        notify();
    });
    // Proof the addon is there on a night with no weather, which is most of them: without
    // it, "connected" and "silent" look identical.
    const alive = () => { attempts = 0; live = true; notify(); };
    es.addEventListener('connected', alive);
    es.addEventListener('heartbeat', alive);

    es.addEventListener('error', () => {
        if (es) { es.close(); es = null; }
        live = false;
        notify();
        if (!started || retryTimer) return;
        const wait = retryDelay(attempts);
        attempts++;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (started) open();
        }, wait);
    });
}

function start() {
    if (started) return;
    started = true;
    attempts = 0;
    backfill();
    open();
    trimTimer = setInterval(() => {
        const kept = trimStrikes(strikes);
        if (kept.length === strikes.length) return;
        strikes = kept;
        notify();
    }, TRIM_MS);
}

function stop() {
    if (!started) return;
    started = false;
    // Nothing in flight belongs to the next stream.
    loadId++;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearInterval(trimTimer);
    trimTimer = null;
    if (es) { es.close(); es = null; }
    live = false;
    notify();
}

/**
 * Subscribe. `fn` is called with the state as it stands and again on every change; returns
 * the unsubscribe. The first subscriber opens the stream and the last one closes it, and
 * stopping the receiver closes it either way — see lib/serverFeeds.js.
 */
export function subscribeLightning(fn) {
    subs.add(fn);
    try { fn(lightningState()); } catch (err) { console.error('lightning subscriber threw', err); }
    if (subs.size === 1) {
        if (feedsAllowed()) start();
        gateOff = onFeedsAllowed((on) => (on ? start() : stop()));
    }
    return () => {
        subs.delete(fn);
        if (subs.size > 0) return;
        stop();
        if (gateOff) { gateOff(); gateOff = null; }
    };
}

/** Test seam. */
export function _resetLightning() {
    stop();
    if (gateOff) { gateOff(); gateOff = null; }
    subs.clear();
    strikes = [];
    live = false;
    state = 'loading';
    lastLive = null;
    attempts = 0;
    lastStrikeAt = 0;
    lastNoticeAt = 0;
    sinceNotice = 0;
    peakSince = 0;
}
