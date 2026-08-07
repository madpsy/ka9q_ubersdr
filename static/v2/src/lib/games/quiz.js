// The two guessing games: which country a callsign is from, and where a country
// is on the map. Ported from the widget's `callsignQuiz` and `countriesGame`.
//
// What they share is the shape of a round — pick something, offer five answers
// one of which is right, keep a streak — and the awkward parts are the same in
// both: not asking the same thing twice in a row, and not letting the right
// answer be guessable from the shape of the options.

// Callsigns the quiz has seen, across sessions. The pool is accumulated rather
// than read live because spots expire: a listener on a quiet band would otherwise
// watch the game run out of questions.
export const SEEN_KEY = 'ubersdr.v2.games.callsigns';
export const SEEN_MAX = 2000;
export const MIN_CALLSIGNS = 10;

// How many recent questions to keep off the list. Enough that a session does not
// feel repetitive, small enough that a modest pool still has something to offer.
export const RECENT_MAX = 30;
export const OPTIONS = 5;

export function shuffled(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * The answers to offer: the right one and four wrong, in a random order.
 *
 * Shuffled *after* the correct one is added, obviously — but the reason it is a
 * function rather than three lines inline is the filter: a distractor equal to
 * the answer makes a question with two right answers, and on a list where the
 * same country appears under two spellings that happens more often than it
 * sounds.
 */
export function buildOptions(correct, pool, rand = Math.random) {
    const others = shuffled(pool.filter((c) => c && c !== correct), rand).slice(0, OPTIONS - 1);
    return shuffled([correct, ...others], rand);
}

/**
 * Which callsign to ask about next.
 *
 * Recently asked ones are held back until the pool runs dry, and callsigns a
 * previous lookup could not place are pushed to the back rather than dropped —
 * they may be a country the receiver has since learned about, and with a small
 * pool they are all there is.
 */
export function orderCandidates(seen, recent, misses, rand = Math.random) {
    const held = new Set(recent);
    let pool = [...seen].filter((cs) => !held.has(cs));
    if (!pool.length) pool = [...seen];
    const live = pool.filter((cs) => !misses.has(cs));
    const dead = pool.filter((cs) => misses.has(cs));
    return [...shuffled(live, rand), ...shuffled(dead, rand)];
}

/** Add to the pool, oldest dropped first once it is full. */
export function addSeen(seen, callsigns) {
    const out = new Set(seen);
    for (const cs of callsigns) if (cs) out.add(cs);
    while (out.size > SEEN_MAX) out.delete(out.values().next().value);
    return out;
}

export function loadSeen() {
    try {
        const a = JSON.parse(localStorage.getItem(SEEN_KEY));
        return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    } catch (e) {
        return new Set();
    }
}

export function saveSeen(seen) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch (e) { /* private mode */ }
}

// US callsigns carry their region in the digit, which is worth saying when the
// answer is revealed — "United States" alone is the least interesting correct
// answer in the game.
const US_DISTRICT = {
    0: 'Central US', 1: 'New England', 2: 'NY/NJ', 3: 'Mid-Atlantic', 4: 'Southeast',
    5: 'South-Central', 6: 'California', 7: 'Pacific Northwest', 8: 'Great Lakes',
    9: 'Upper Midwest',
};

export function usRegion(callsign) {
    const m = /[A-Z]+(\d)/.exec(String(callsign || '').toUpperCase());
    return m ? (US_DISTRICT[m[1]] || '') : '';
}

/** The line under a correct answer: where in the country, and which CQ zone. */
export function ctyDetail(cty, callsign) {
    if (!cty) return { where: '', zone: '' };
    const us = cty.code === 'US' || cty.country === 'United States';
    return {
        where: (us && usRegion(callsign)) || cty.continent || '',
        zone: cty.cq_zone ? `CQ zone ${cty.cq_zone}` : '',
    };
}

// ── The map ─────────────────────────────────────────────────────────────────

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 24;
export const ZOOM_STEP = 1.25;

export const pxPerDeg = (width, zoom) => (width / 360) * zoom;

export function project(lon, lat, view, w, h) {
    const s = pxPerDeg(w, view.z);
    return [w / 2 + (lon - view.lon) * s, h / 2 - (lat - view.lat) * s];
}

export function unproject(x, y, view, w, h) {
    const s = pxPerDeg(w, view.z);
    return [view.lon + (x - w / 2) / s, view.lat - (y - h / 2) / s];
}

/**
 * Keep the view on the planet.
 *
 * Once the visible span is wider than the world in an axis, that axis locks to
 * the centre: panning past the edge into empty space is not a view of anywhere,
 * and on a 2:1 canvas it happens as soon as you zoom out.
 */
export function clampView(view, w, h) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.z));
    const s = pxPerDeg(w, z);
    const halfLon = (w / 2) / s;
    const halfLat = (h / 2) / s;
    return {
        z,
        lon: halfLon >= 180 ? 0 : Math.min(180 - halfLon, Math.max(-180 + halfLon, view.lon)),
        lat: halfLat >= 90 ? 0 : Math.min(90 - halfLat, Math.max(-90 + halfLat, view.lat)),
    };
}

/**
 * A view framing one country.
 *
 * Natural Earth's bounding boxes are unusable for anything that straddles the
 * antimeridian or owns distant islands — Russia, the USA, Fiji, Norway with
 * Bouvet all "span" most of the globe — so an implausibly wide box is ignored in
 * favour of a fixed regional zoom on the label point. Better a country slightly
 * off-centre than a question showing the whole world.
 */
export function viewFor(c, w, h) {
    const spanLon = Number.isFinite(c.max_lon) && Number.isFinite(c.min_lon)
        ? c.max_lon - c.min_lon : NaN;
    const spanLat = Number.isFinite(c.max_lat) && Number.isFinite(c.min_lat)
        ? c.max_lat - c.min_lat : NaN;
    let z = 3;
    if (Number.isFinite(spanLon) && Number.isFinite(spanLat)
        && spanLon > 0 && spanLon < 120 && spanLat < 90) {
        // About 2.2× the larger dimension, so the country's surroundings frame it
        // rather than filling the canvas edge to edge.
        const span = Math.max(spanLon, spanLat * 2, 1) * 2.2;
        z = Math.min(8, Math.max(2, 360 / span));
    }
    return clampView({ lon: c.lon, lat: c.lat, z }, w, h);
}

/**
 * Coastlines out of quantised TopoJSON.
 *
 * Arc points are delta-encoded integers needing a running sum and the topology's
 * own transform. Only outlines are wanted, so every arc is kept as an open
 * polyline and no polygons are reassembled from arc indices — the map is redrawn
 * on every wheel tick, and that is the expensive half of the format.
 *
 * Flat coordinate arrays with a cached bounding box, for the same reason: no
 * allocation per point, and an arc off screen is rejected by four comparisons.
 */
export function decodeArcs(topo) {
    if (!topo || !Array.isArray(topo.arcs)) return null;
    const t = topo.transform;
    const sx = t ? t.scale[0] : 1;
    const sy = t ? t.scale[1] : 1;
    const tx = t ? t.translate[0] : 0;
    const ty = t ? t.translate[1] : 0;

    return topo.arcs.map((arc) => {
        let x = 0;
        let y = 0;
        const pts = [];
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const p of arc) {
            let lon;
            let lat;
            if (t) {
                x += p[0];
                y += p[1];
                lon = x * sx + tx;
                lat = y * sy + ty;
            } else {
                [lon, lat] = p;
            }
            pts.push(lon, lat);
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        return { pts, b: [minLon, minLat, maxLon, maxLat] };
    });
}

/** Is any of this arc inside the view? Four comparisons against the bbox. */
export function arcVisible(arc, view, w, h) {
    const s = pxPerDeg(w, view.z);
    const halfLon = (w / 2) / s;
    const halfLat = (h / 2) / s;
    const [minLon, minLat, maxLon, maxLat] = arc.b;
    return !(maxLon < view.lon - halfLon || minLon > view.lon + halfLon
        || maxLat < view.lat - halfLat || minLat > view.lat + halfLat);
}

/** A country worth asking about, avoiding the recently asked. */
export function pickCountry(list, recent, rand = Math.random) {
    const held = new Set(recent);
    let pool = list.filter((c) => !held.has(c.country));
    if (!pool.length) pool = list;
    return pool[Math.floor(rand() * pool.length)];
}
