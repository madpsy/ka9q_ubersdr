// Packet channels as markers: who is on which frequency.
//
// The other markers in the bar are each one thing at one place — a bookmark, a spot, a
// detection. A packet channel is not: it is a *shared* frequency that a dozen stations
// take turns on, and "packet is here" is already said by the mark's position. What is
// worth knowing is who is on it and who they are working, which is why this marker
// carries a list rather than a label. See stationPairs in lib/packet.js.
//
// One poll for the whole page, started by the first subscriber and stopped when the
// last one goes — the same shape as the voice activity store, and for the same reason:
// the marker bar and the panel both want this, and neither should be fetching it twice
// or fetching it while nothing is drawn.
//
// It has to poll per channel. The addon's aggregate query merges every channel and
// drops which one each frame came from, and a marker without a frequency is not a
// marker. Channels are usually one or two, so that is one or two small requests every
// twenty seconds while anything is watching.

import {
    MARKER_POLL_MS, channelFramesUrl, channelSummary, channelsUrl, markerLabel,
    normaliseFrame, stationPairs, stationsHeard,
} from './packet.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';

const subscribers = new Set();
// The feedInterval stop function, not a timer id: the poll is refcounted by its
// subscribers as before, and gated on top of that. See lib/serverFeeds.js.
let timer = null;
let latest = null;
let inFlight = false;
// The channel list is asked for once and then reused. Channels are added and removed on
// the addon's own page, deliberately and rarely, so re-fetching the list every twenty
// seconds would be a request per cycle to be told the same thing.
let channels = null;

function notify() {
    for (const fn of Array.from(subscribers)) {
        try { fn(latest); } catch (err) { console.error('packet marker subscriber threw', err); }
    }
}

/**
 * One marker per channel: where it is, what to call it, and who is on it.
 *
 * A channel with no frequency is dropped — there is nowhere to put it — but a channel
 * with a frequency and no traffic is kept, because "nothing has been heard here for a
 * quarter of an hour" is a real answer to "what is on 144.800", and a marker that
 * vanished on a quiet channel would look like a receiver that had stopped listening.
 */
export function buildMarkers(chans, framesByLabel, now = Date.now()) {
    const out = [];
    for (const ch of chans || []) {
        if (!ch.hz) continue;
        const pairs = stationPairs(framesByLabel[ch.label] || [], now);
        out.push({
            label: ch.label,
            frequency: ch.hz,
            mhz: ch.mhz,
            up: ch.up,
            pairs,
            calls: stationsHeard(pairs),
            text: markerLabel(pairs, ch.mhz),
            // When anything was last heard here, for the tooltip's age line.
            at: pairs.length ? pairs[0].at : 0,
        });
    }
    return out.sort((a, b) => a.frequency - b.frequency);
}

async function load() {
    if (inFlight) return;
    inFlight = true;
    try {
        if (!channels) {
            const resp = await fetch(channelsUrl());
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            channels = channelSummary(await resp.json());
        }
        const withFreq = channels.filter((c) => c.hz && c.label);
        const framesByLabel = {};
        // In parallel: two channels answering one after the other is two round trips
        // for no reason, and there are never many.
        await Promise.all(withFreq.map(async (c) => {
            try {
                const r = await fetch(channelFramesUrl(c.label));
                if (!r.ok) return;
                const rows = await r.json();
                framesByLabel[c.label] = (Array.isArray(rows) ? rows : [])
                    .map(normaliseFrame).filter(Boolean);
            } catch (err) {
                // One channel failing leaves the others: a marker missing its traffic
                // is better than every marker disappearing.
            }
        }));
        latest = buildMarkers(withFreq, framesByLabel);
        notify();
    } catch (err) {
        // The addon has gone away, or was never there. Nothing is published: the last
        // markers stay on screen rather than blinking out on one failed poll, and the
        // channel list is dropped so a restarted addon is picked up again.
        channels = null;
    } finally {
        inFlight = false;
    }
}

/** The markers as they stand, for a caller that cannot wait for the next poll. */
export const packetMarkers = () => latest || [];

export function subscribePacketMarkers(fn) {
    subscribers.add(fn);
    // Replayed, so a marker bar that mounts mid-cycle draws what is already known
    // rather than nothing for twenty seconds.
    if (latest) {
        try { fn(latest); } catch (err) { console.error('packet marker subscriber threw', err); }
    }
    if (timer === null) {
        timer = feedInterval(load, MARKER_POLL_MS);
    }
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0 && timer !== null) {
            timer();
            timer = null;
        }
    };
}

/** Test seam. */
export function _resetPacketMarkers() {
    // A store under test polls: the feed gate is the receiver's business, it
    // has its own tests, and every case here is about this module's refcounting
    // rather than about being switched off. See lib/serverFeeds.js.
    setFeedsAllowed(true);
    subscribers.clear();
    if (timer !== null) timer();
    timer = null;
    latest = null;
    channels = null;
    inFlight = false;
}
