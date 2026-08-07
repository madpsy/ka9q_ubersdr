// A world map on a canvas: the projection, the view, and the coastlines.
//
// This was the Countries game's, until the HFDL panel wanted a map of its own — one
// plots a pin on a quiz answer and the other plots aircraft, and both need the same
// equirectangular projection, the same pan-and-zoom clamp and the same TopoJSON decode.
// Two copies of a projection is two maps that disagree about where things are.
//
// It also holds the arc *loading*, which the game did itself: /countries-110m.json is a
// hundred kilobytes, and two panels open at once should fetch it once.

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

// ── The coastlines themselves ────────────────────────────────────────────────

// One fetch for the page, shared by every map. Kept as the promise rather than the
// result, so two panels opening together wait on the same request instead of racing to
// make a second one.
let arcsPromise = null;

export function loadWorldArcs() {
    if (arcsPromise) return arcsPromise;
    arcsPromise = fetch('/countries-110m.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((topo) => decodeArcs(topo))
        .catch(() => null);
    return arcsPromise;
}

/** Test seam. */
export function _resetWorldArcs() {
    arcsPromise = null;
}
