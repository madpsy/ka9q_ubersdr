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
    '_callsignLookupWindow',
];

// postMessage types the bridge answers, sent by callsign_lookup.html.
export const LEGACY_MESSAGES = [
    'rotator_set_bearing',
    'ant_switch_select',
    'request_ant_switch_status',
];

// Deliberately not provided, with the reason. `activeChannels` is the active
// user list from /stats, read only by channels-map.html — which v2 has no way
// to open (it is not in /api/pages-menu and has no button), so backing it would
// mean a polling loop for a page nobody can reach. The page degrades to
// "No activeChannels data in opener window" rather than breaking. Give it an
// entry point and this needs implementing at the same time.
export const LEGACY_UNSUPPORTED = ['activeChannels'];

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
