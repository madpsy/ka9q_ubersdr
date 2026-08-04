// Popup plumbing for the v1 pages, and the pure parts of the compatibility
// bridge.
//
// static/voice-activity.html, static/callsign_lookup.html and
// static/channels-map.html were written against v1 and cannot be changed —
// other deployments and the v1 frontend still run them. They talk to whoever
// opened them by reaching straight into `window.opener`: calling global
// functions on it, reading globals off it, and (for the lookup page) exchanging
// postMessages with it. v2 is a bundled IIFE that publishes nothing, so under
// v2 those pages open, fetch their own data, and then quietly do nothing when
// you click a row.
//
// LegacyBridge.jsx re-creates that surface. This file holds the pieces that do
// not need React: the popup registry and the string handling, both of which
// have rules worth pinning down in one place.

// What the bridge publishes on `window` for the popups to reach. Declared here
// rather than only in LegacyBridge.jsx so test/compat.test.js can check it
// against what the v1 pages actually ask for — those pages are outside our
// control, and a new dependency appearing in one of them should fail a test
// here rather than a click in production.
export const LEGACY_GLOBALS = [
    'setFrequency',
    'setMode',
    'tuneToChannel',
    'instanceDescription',
    'userSessionID',
    'activeChannels',
    '_callsignLookupWindow',
];

// postMessage types the bridge answers, sent by callsign_lookup.html.
export const LEGACY_MESSAGES = [
    'rotator_set_bearing',
    'ant_switch_select',
    'request_ant_switch_status',
];

// Nothing is knowingly unsupported any more. `activeChannels` used to be:
// channels-map.html reads it off the opener, and v2 had no way to open that
// page, so backing it would have meant polling for a page nobody could reach.
// The Listeners panel is that entry point, and openChannelsMap below publishes
// the list for exactly as long as the map is open.
export const LEGACY_UNSUPPORTED = [];

// One normalisation rule for the whole app — see lib/callsign.js.
import { normaliseCallsign } from '../lib/callsign.js';

// v1's geometry (app.js initializeCallsignLookupButton).
const LOOKUP_W = 520;
const LOOKUP_H = 800;
const LOOKUP_NAME = 'callsign_lookup';

// The one open lookup popup, or null. v1 keeps this on
// `window._callsignLookupWindow`, and voice-activity.html reads it off the
// opener to route a lookup — so the global is part of the contract, not just
// bookkeeping. LegacyBridge mirrors this into it.
let lookupWindow = null;

export function callsignLookupWindow() {
    return lookupWindow && !lookupWindow.closed ? lookupWindow : null;
}

// Both parameters are v1's: `uuid` authorises /api/lookup, `callsign` runs a
// lookup as soon as the page loads.
export function lookupUrl(uuid, callsign) {
    const q = new URLSearchParams();
    if (uuid) q.set('uuid', uuid);
    if (callsign) q.set('callsign', callsign);
    const s = q.toString();
    return s ? `/callsign_lookup.html?${s}` : '/callsign_lookup.html';
}

// Opens the lookup popup, or focuses the one already open and pushes the new
// callsign into it. v1 does exactly this, and the difference matters: reloading
// the page would throw away the map and the history the operator is looking at.
export function openCallsignLookup({ uuid, callsign } = {}) {
    const call = normaliseCallsign(callsign);
    const open = callsignLookupWindow();

    if (open) {
        try {
            open.postMessage({ type: 'callsign_lookup', uuid, callsign: call }, window.location.origin);
            open.focus();
        } catch (e) { /* closed between the check and the send */ }
        return open;
    }

    // A callsign given at open time travels in the URL, not a postMessage: the
    // page has no listener until it has loaded, so a message sent now would
    // land nowhere.
    lookupWindow = window.open(
        lookupUrl(uuid, call),
        LOOKUP_NAME,
        `width=${LOOKUP_W},height=${LOOKUP_H},resizable=yes,scrollbars=yes`,
    );
    window._callsignLookupWindow = lookupWindow;
    return lookupWindow;
}

// Routes a callsign to an already-open lookup popup, and does nothing if there
// is none. Never opens a window: this fires from clicking a spot, and a click
// that spawns a window nobody asked for is a popup blocker's whole reason to
// exist. Same rule as v1's lookupDXCallsign.
export function lookupCallsign(callsign) {
    const win = callsignLookupWindow();
    const call = normaliseCallsign(callsign);
    if (!win || !call) return false;
    try {
        win.postMessage({ type: 'callsign_lookup', callsign: call }, window.location.origin);
        win.focus();
        return true;
    } catch (e) {
        return false;
    }
}

// --- message payloads -------------------------------------------------------
//
// Shapes copied from static/rotator-ui.js, which is what the lookup page was
// written against. Every field is present and of the declared type even when
// the hardware is absent, because the page destructures them without guards.

export function rotatorStatusMessage(status, hasPassword) {
    const pos = (status && status.position) || {};
    return {
        type: 'rotator_status',
        enabled: true,
        connected: !!(status && status.connected),
        azimuth: pos.azimuth !== undefined && pos.azimuth !== null ? Math.round(pos.azimuth) : null,
        moving: !!(status && status.moving),
        hasPassword: !!hasPassword,
    };
}

export function antSwitchStatusMessage(status, hasPassword) {
    const s = status || {};
    return {
        type: 'ant_switch_status',
        enabled: !!s.enabled,
        num_antennas: s.num_antennas || 0,
        antenna_labels: s.antenna_labels || [],
        selected: s.selected || [],
        grounded: !!s.grounded,
        thunderstorm: !!s.thunderstorm,
        hasPassword: !!hasPassword,
    };
}

// Test seam: lets a test drive the registry without a real window.
export function _setLookupWindow(win) {
    lookupWindow = win;
    window._callsignLookupWindow = win;
}

// --- the channels map -------------------------------------------------------
//
// v1's geometry (app.js openChannelsMap). The page has no data source of its
// own: it reads `window.opener.activeChannels`, centres on
// `window.opener.instanceDescription`, and tunes through
// `window.opener.tuneToChannel` — all three of which the bridge provides.

const MAP_W = 1000;
const MAP_H = 700;
const MAP_NAME = 'channels_map';

let mapWindow = null;
let mapRelease = null;

export function channelsMapWindow() {
    return mapWindow && !mapWindow.closed ? mapWindow : null;
}

/**
 * Opens the map, or focuses the one already open.
 *
 * `subscribe` is lib/listeners.js's subscription, passed in rather than
 * imported so this file stays free of the polling machinery — and so the
 * feeding of the popup is visibly tied to its lifetime: the subscription is
 * held until the window closes and released the moment it has, which is what
 * stops a closed map leaving a poll running for the rest of the session.
 */
export function openChannelsMap(subscribe) {
    const open = channelsMapWindow();
    if (open) {
        try { open.focus(); } catch (e) { /* closed between check and focus */ }
        return open;
    }

    const left = Math.round((screen.width - MAP_W) / 2);
    const top = Math.round((screen.height - MAP_H) / 2);
    mapWindow = window.open(
        '/channels-map.html',
        MAP_NAME,
        `width=${MAP_W},height=${MAP_H},left=${left},top=${top},resizable=yes,scrollbars=no`,
    );
    if (!mapWindow) return null;   // blocked

    if (mapRelease) mapRelease();
    mapRelease = subscribe((state) => {
        // v1 publishes the raw server entries and the page reads the server's
        // field names off them, so it must be given those and not ours.
        window.activeChannels = (state.channels || []).map((c) => c.raw);
        const win = channelsMapWindow();
        if (!win) {
            // Closed since the last poll: stop feeding it, and stop polling on
            // its behalf.
            if (mapRelease) mapRelease();
            mapRelease = null;
            mapWindow = null;
            return;
        }
        // v1 calls this after every stats refresh; the page redraws its pins
        // from the opener's data when it does.
        try { if (win.updateChannelsMap) win.updateChannelsMap(); } catch (e) { /* cross-origin or closed */ }
    });

    return mapWindow;
}
