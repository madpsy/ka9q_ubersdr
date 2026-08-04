// The CW skimmer graph — v1's extensions/cw-spots/graph.html, driven from v2.
//
// The page is a spot-density chart with its own filters, a map and a morse
// decoder. It has no data source of its own: everything arrives by postMessage
// from whoever opened it, and every action it offers is posted back. So the
// contract below *is* the feature, and it is v1's exactly (cw-spots/main.js
// openGraphWindow / setupGraphWindowMessageListener, graph.js handleMessage):
//
//   out   cw_spots_initial   the whole list, plus the band filter, the dial,
//                            whether lookups are available and the session id
//         cw_spot            one new spot
//         band_filter_sync   our band filter changed
//         frequency_changed  the dial moved
//         cw_spots_clear     the list was emptied on our side
//
//   in    request_initial_spots   sent once when the page loads
//         tune_to_spot            hovering, or auto-tune
//         tune_to_spot_click      clicking: tune *and* look the callsign up
//         clear_spots_from_graph  empty the list on our side too
//         lookup_window_opened    the page opened the lookup popup itself
//
// The page is given the *raw* server spots, not our normalised ones: it reads
// `dx_call`, `distance_km` and the rest by their server names, and hands the
// same objects back when you click one.
//
// The spot feed is held here rather than in the panel, so the graph keeps
// filling while the Spots panel is collapsed — a collapsed panel is unmounted,
// and a chart that silently stops updating is worse than one that never opened.

import { normaliseCW, modeForSpot, spotKey } from '../lib/spots.js';

// v1's geometry (cw-spots/main.js openGraphWindow).
const W = 1000;
const H = 750;
const NAME = 'CWSpots Graph';
const URL = '/extensions/cw-spots/graph.html';

let win = null;
let release = null;      // the spot subscription, held while the window is open
let latest = [];         // what the store holds, from that subscription
let sent = null;         // keys already forwarded; null until the page asks
let ctx = null;          // supplied by the panel; see setCwGraphContext

export function cwGraphWindow() {
    return win && !win.closed ? win : null;
}

function post(type, extra) {
    const w = cwGraphWindow();
    if (!w) return false;
    try {
        w.postMessage({ type, ...extra }, window.location.origin);
        return true;
    } catch (e) {
        return false;   // closed between the check and the send
    }
}

/** Tells the graph our band filter changed. No-op when it is not open. */
export function cwGraphBand(band) {
    post('band_filter_sync', { data: band });
}

/** Tells the graph the dial moved. Its auto-lookup follows this. */
export function cwGraphFrequency(hz) {
    post('frequency_changed', { frequency: hz });
}

/** Tells the graph our list was emptied. */
export function cwGraphCleared() {
    post('cw_spots_clear', {});
}

/**
 * The live view of our side, refreshed by the panel on every render.
 *
 * Held in the module rather than captured in a closure so the graph keeps
 * working when the panel is unmounted: `actions` outlives the component, and a
 * stale band filter or dial reading only affects what the chart highlights.
 */
export function setCwGraphContext(next) {
    ctx = next;
}

// The list comes from this module's own subscription, not from the panel: the
// panel only holds the tab you are looking at, so opening the graph and then
// switching to DX would leave a reload with nothing to draw.
function sendInitial() {
    if (!ctx) return;
    sent = new Set(latest.map(spotKey));
    post('cw_spots_initial', {
        data: latest.map((s) => s.raw),
        bandFilter: ctx.band(),
        currentFrequency: ctx.frequency(),
        lookupServiceAvailable: ctx.lookups(),
        uuid: ctx.uuid(),
    });
}

// Every spot the store now holds that we have not already sent, oldest first —
// the page appends, so order matters. The store hands over the whole list on
// each change, and re-subscribing replays the server's buffer, so "what is
// new" has to be worked out rather than assumed.
function sendNew(spots) {
    const fresh = [];
    for (const s of spots) {
        const key = spotKey(s);
        if (sent.has(key)) continue;
        sent.add(key);
        fresh.push(s);
    }
    for (let i = fresh.length - 1; i >= 0; i--) post('cw_spot', { data: fresh[i].raw });
}

function stop() {
    if (release) release();
    release = null;
    win = null;
    latest = [];
    sent = null;
    window.removeEventListener('message', onMessage);
}

function onMessage(event) {
    // Same origin only, and only while we have a window to be talking to.
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || !ctx) return;
    if (!cwGraphWindow()) { stop(); return; }

    switch (msg.type) {
        case 'request_initial_spots':
            sendInitial();
            break;
        case 'tune_to_spot':
            if (msg.spot) tune(msg.spot, false);
            break;
        case 'tune_to_spot_click':
            if (msg.spot) tune(msg.spot, true);
            break;
        case 'clear_spots_from_graph':
            ctx.clear();
            break;
        default:
            // lookup_window_opened and anything else the page grows later:
            // nothing here has to act on them.
            break;
    }
}

// The page hands back the raw spot it was given, so it is normalised again to
// work out the mode — CWL below 10 MHz and CWU above, as everywhere else.
function tune(raw, withLookup) {
    const spot = normaliseCW(raw);
    if (!spot.frequency) return;
    ctx.tune({ frequency: Math.round(spot.frequency), mode: modeForSpot(spot) });
    if (withLookup && spot.callsign) ctx.lookup(spot.callsign);
}

/**
 * Opens the graph, or focuses the one already open.
 *
 * `subscribe` is lib/spotStore.js's subscription, passed in so this file does
 * not reach into the store directly — and so the feed is visibly tied to the
 * window's lifetime: taken when it opens, released when it has gone.
 */
export function openCwGraph(subscribe) {
    const open = cwGraphWindow();
    if (open) {
        try { open.focus(); } catch (e) { /* closed between check and focus */ }
        return open;
    }

    const left = Math.round((screen.width - W) / 2);
    const top = Math.round((screen.height - H) / 2);
    win = window.open(URL, NAME, `width=${W},height=${H},left=${left},top=${top},resizable=yes,scrollbars=no`);
    if (!win) return null;   // blocked

    sent = null;
    window.addEventListener('message', onMessage);
    if (release) release();
    release = subscribe((spots) => {
        latest = spots || [];
        if (!cwGraphWindow()) { stop(); return; }
        // Nothing to append to until the page has asked for its initial load —
        // `request_initial_spots` sends everything held in one go.
        if (sent) sendNew(latest);
    });

    return win;
}
