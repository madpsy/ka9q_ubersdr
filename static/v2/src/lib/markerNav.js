// Which marker the dial is sitting on, and which ones sit either side of it.
//
// v1 keeps this inside the dial-wheel overlay and lets Media Session borrow it
// through a window global (app.js findMarkers). Here it is its own module,
// because more than one thing wants it: the lock-screen album line names the
// marker you are tuned to, and the ⏮/⏭ buttons step to the neighbours.
//
// Pure by construction — callers pass the lists in. Nothing here fetches,
// subscribes or reads the DOM, which is what makes it testable.

import { isValidCallsign, normaliseCallsign } from './callsign.js';
import { modeForSpot } from './spots.js';
import { activityLabel, dialFreq } from './voiceActivity.js';

// How close the dial has to sit before a marker counts as the one you are on.
// v1's MARKER_FREQ_TOLERANCE_HZ.
export const MARKER_TOLERANCE_HZ = 100;

const SIDEBAND_CROSSOVER_HZ = 10000000;

// Modes that are the same thing as far as "am I tuned to this marker" goes.
// A CW spot should match whether you are in CWL or CWU, and a bookmark saved
// in AM should match SAM.
export function modeFamily(mode) {
    const m = String(mode || '').toLowerCase();
    if (m === 'cw' || m === 'cwu' || m === 'cwl') return 'cw';
    if (m === 'am' || m === 'sam') return 'am';
    if (m === 'fm' || m === 'nfm') return 'fm';
    return m;
}

function voiceMode(hz) {
    return hz >= SIDEBAND_CROSSOVER_HZ ? 'usb' : 'lsb';
}

// The country a marker's station is in, as an ISO alpha-2 code, or ''.
//
// Carried on the marker rather than fetched: the spots and the voice detector
// already resolve it server-side, so the neighbours either side of the dial can
// show a flag without a lookup request each — which for a dial being turned
// would be a request per marker passed.
export function countryOf(marker) {
    return (marker && marker.countryCode) || '';
}

// The marker types, as an allow-list vocabulary for prev/next filtering.
export const NAV_TYPES = ['cw', 'dx', 'voice', 'bookmark-server', 'bookmark-local'];

// The marker's name at the width a step button has for it.
//
// The Markers panel gives prev and next half a row each and can print a
// bookmark's full name. The ends of the Multipad's frequency drum have about six
// characters between the chevron and the scale, and that is where this is for.
//
// Callsigns — which is what most of these markers are — already fit and come
// back untouched. What needs deciding is the long ones, and there whole words
// beat a cut: "Shannon V…" says less about which marker this is than "Shannon"
// does, and "Voice 20m" is "Voice" rather than "Voice 2…". As many words as fit,
// so a name that is several short ones does not lose all but the first.
//
// A single word longer than the budget has nothing to fall back on and is cut
// with an ellipsis, which at least says it was cut. One character survives even
// when the budget cannot pay for the ellipsis: a label that is nothing but an
// ellipsis is worse than one letter of the name.
export function shortMarkerName(marker, max = 8) {
    const name = String((marker && marker.name) || '').trim().replace(/\s+/g, ' ');
    if (name.length <= max) return name;
    const words = name.split(' ');
    if (words[0].length > max) return `${words[0].slice(0, Math.max(1, max - 1))}…`;
    let out = words[0];
    for (const w of words.slice(1)) {
        if (out.length + 1 + w.length > max) break;
        out += ` ${w}`;
    }
    return out;
}

// Types whose `name` *may* be a callsign, and so worth a lookup — the album
// line and the Markers panel enrich these, and only these, with the operator's
// name and photo. Whether it actually is one is callsignOf's job.
export const CALLSIGN_TYPES = new Set(['cw', 'dx', 'voice']);

// Flattens every marker source into one list of
// { freq, mode, family, name, type, priority }.
//
// `priority` is what makes a live spot beat a bookmark sitting on the same
// frequency, which is v1's rule and the right one: the bookmark is what the
// frequency always is, the spot is who is on it right now.
export function collectMarkers({
    dx = [], cw = [], voice = [], confirmed = [], bookmarks = [], local = [],
} = {}) {
    const out = [];

    // Spots arrive already normalised (lib/spots.js), so they carry `kind` and
    // `callsign` — modeForSpot reads the first, the album line reads the second.
    for (const s of cw) {
        if (!(s.frequency > 0)) continue;
        out.push({
            freq: s.frequency, mode: modeForSpot(s), family: 'cw',
            name: s.callsign || '', call: s.callsign || '',
            countryCode: s.countryCode || '', type: 'cw', priority: 1,
        });
    }
    for (const s of dx) {
        if (!(s.frequency > 0)) continue;
        const mode = modeForSpot(s);
        out.push({
            freq: s.frequency, mode, family: modeFamily(mode),
            name: s.callsign || '', call: s.callsign || '',
            countryCode: s.countryCode || '', type: 'dx', priority: 1,
        });
    }
    for (const a of voice) {
        const freq = dialFreq(a);
        if (!(freq > 0)) continue;
        const mode = a.mode ? String(a.mode).toLowerCase() : voiceMode(freq);
        // `name` is a label — "Voice 20m" when no station was decoded — and
        // `call` is the station or nothing. Keeping them apart is what stops a
        // label being looked up as though it were a callsign.
        out.push({
            freq, mode, family: modeFamily(mode), name: activityLabel(a),
            call: a.dx_callsign || '', countryCode: a.dx_country_code || '',
            type: 'voice', priority: 1,
        });
    }
    // Confirmed voice sightings, under the same `voice` type rather than one of
    // their own: stepping between "voices" is one activity, and a picker that made
    // you tick two boxes to do it would be describing where the data came from
    // rather than what you are looking for.
    //
    // Priority 2, above the detections. Both can land on the same frequency —
    // often will, since the skimmer confirms what the detector heard — and when
    // they do the named one is what the dial should be labelled with. That is the
    // same judgement the marker bar makes by drawing this layer second.
    for (const sp of confirmed) {
        if (!(sp.hz > 0)) continue;
        const mode = sp.mode ? String(sp.mode).toLowerCase() : voiceMode(sp.hz);
        out.push({
            freq: sp.hz, mode, family: modeFamily(mode),
            // A confirmed sighting *is* a callsign, so unlike a bare detection the
            // label and the lookup are the same string.
            name: sp.callsign || '', call: sp.callsign || '',
            countryCode: sp.cc || '', type: 'voice', priority: 2,
        });
    }
    // A bookmark with no mode is a wildcard: `family: null` matches whatever
    // you happen to be listening in, which is what "7.100 — net" means.
    for (const [list, type] of [[bookmarks, 'bookmark-server'], [local, 'bookmark-local']]) {
        for (const b of list) {
            if (!(b.frequency > 0)) continue;
            out.push({
                freq: b.frequency,
                mode: b.mode || null,
                // The bookmark's own passband, when it has one. Carried because stepping
                // onto a bookmark tunes to it, and a bookmark on a narrow signal is about
                // its filter — see lib/bookmarkTune.js. Only bookmarks have one: a spot
                // says nothing about how to listen to it.
                low: typeof b.bandwidth_low === 'number' ? b.bandwidth_low : null,
                high: typeof b.bandwidth_high === 'number' ? b.bandwidth_high : null,
                family: b.mode ? modeFamily(b.mode) : null,
                name: b.name || '',
                // A bookmark's name is whatever its owner typed, so it is never
                // a callsign to look up even when it looks like one — and it
                // belongs to no country.
                call: '',
                countryCode: '',
                type,
                priority: 0,
            });
        }
    }
    return out;
}

/**
 * The callsign to look up for a marker, or '' if there is nothing to look up.
 *
 * Read from `call`, never from `name`. The two are different on purpose: the
 * name is what is shown, and for voice activity with no station decoded that is
 * a label like "Voice 20m" — or just "Voice", which is five letters and passes
 * any callsign pattern you care to write. Guessing from the label sent those to
 * the lookup service, which spent a request and a rate-limit slot saying no.
 */
export function callsignOf(marker) {
    if (!marker || !CALLSIGN_TYPES.has(marker.type)) return '';
    const call = normaliseCallsign(marker.call);
    return isValidCallsign(call) ? call : '';
}

// Locates the dial among the markers.
//
//   current — the closest marker inside the tolerance window whose mode family
//             matches. Never filtered by `navTypes`: the frequency you are on
//             is labelled with whatever is on it.
//   prev/next — the nearest marker below/above, outside that window, in any
//             mode, carrying its own mode so a caller can tune to it. These
//             *are* filtered, so "step through CW spots only" is possible.
export function findMarkers(markers, dialHz, mode, navTypes) {
    const result = { current: null, prev: null, next: null };
    if (!(dialHz > 0)) return result;

    const fam = modeFamily(mode);
    const allow = Array.isArray(navTypes) ? new Set(navTypes) : null;
    const navOk = (m) => !allow || allow.has(m.type);

    let current = null;
    let currentDist = Infinity;
    let prev = null;
    let next = null;

    for (const m of markers) {
        const d = Math.abs(m.freq - dialHz);
        if (d <= MARKER_TOLERANCE_HZ) {
            if (m.family !== null && m.family !== fam) continue;
            if (!current || m.priority > current.priority ||
                (m.priority === current.priority && d < currentDist)) {
                current = m;
                currentDist = d;
            }
        } else if (m.freq < dialHz) {
            if (navOk(m) && (!prev || m.freq > prev.freq ||
                (m.freq === prev.freq && m.priority > prev.priority))) {
                prev = m;
            }
        } else if (navOk(m) && (!next || m.freq < next.freq ||
            (m.freq === next.freq && m.priority > next.priority))) {
            next = m;
        }
    }

    result.current = current;
    result.prev = prev;
    result.next = next;
    return result;
}
