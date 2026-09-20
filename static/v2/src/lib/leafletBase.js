// The base layer under every Leaflet map in v2, and what it does when the tiles
// do not come.
//
// All four maps — the start overlay's, the callsign lookup's, the NCDXF beacon
// map and the spots world map — draw OpenStreetMap tiles, which is the one part
// of this interface that has to leave the building. Everything else v2 needs is
// served by the receiver: React, Leaflet itself, SunCalc, the fonts, the audio,
// the spectrum. So a receiver on a network with no route out is an interface
// that works, with four dark rectangles in it.
//
// And they were dark rectangles with no explanation. Leaflet's default on a
// tile that will not load is to leave the tile blank and fire `tileerror`; none
// of the four listened, so the markers, the tooltips and the great-circle line
// were all drawn correctly onto nothing, with no way to tell a map of an empty
// ocean from a map that failed. The spots map was the worst of them: plotting
// where stations are heard, with no coastline to place them against, is the
// panel failing at the only thing it is for.
//
// The fix is already in the repository. lib/worldMap.js decodes
// /countries-110m.json — a 105 KB TopoJSON of national outlines, served by this
// receiver — into arcs, and the HFDL panel and the Countries game have been
// drawing their own maps from it all along. This puts the same arcs under
// Leaflet when the tiles fail, so an offline map keeps its geography and loses
// only its detail.
//
// What it deliberately does not do is prefer the local outline. The tiles are
// better whenever they are available — place names, roads, terrain — and a
// receiver with a working connection should never see the fallback. It is
// reached by failure, not by a setting.

import { loadWorldArcs } from './worldMap.js';

export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// What the corner says once the outline is standing in for the tiles. It sits
// where the OpenStreetMap credit was, which is both the honest place for it —
// that credit is no longer owed, because none of their tiles are on screen —
// and the one spot on a Leaflet map already reserved for saying where the
// picture came from.
//
// Only the start overlay's map has an attribution control; the other three are
// built without one and show the outline with no caption. That is deliberate.
// The outline is not an error state to be apologised for — it is a plainer map,
// and on a map that never carried a credit there is nothing for a caption to
// correct.
export const OFFLINE_ATTRIBUTION = 'Offline — outlines only, no map detail';

// How many tiles have to fail before the outline goes down.
//
// Not one. A tile can fail on its own for reasons that say nothing about the
// connection, and swapping the whole base layer because a single request was
// unlucky would replace a working map with a worse one. Three failures with
// nothing whatsoever having loaded is not bad luck: a map fetches nine or more
// tiles to fill even the smallest of these boxes, so by three the answer is in.
export const FAIL_THRESHOLD = 3;

// A segment longer than this in longitude is a line wrapping the world rather
// than a real one. Natural Earth cuts its geometry at the antimeridian, so this
// should never fire — it is here because the cost of being wrong is a stripe
// straight across every map, and the cost of the check is one subtraction.
const WRAP_DEG = 180;

/**
 * Arc points (flat [lon, lat, lon, lat, …]) as Leaflet latlng runs.
 *
 * Returns an array of runs rather than one: a run is broken wherever the next
 * point is on the far side of the antimeridian, so a shape that does wrap is
 * drawn as two lines that leave the edges instead of one that crosses the map.
 */
export function arcToLatLngs(pts) {
    const runs = [];
    let run = [];
    let prevLon = null;
    // `i + 1 < length`, not `i < length`: a trailing lon with no lat would
    // otherwise become the point [undefined, lon] and Leaflet would draw the
    // line to wherever that lands. decodeArcs always pushes the pair, so this
    // is a guard on the shape rather than on anything it does today.
    for (let i = 0; i + 1 < pts.length; i += 2) {
        const lon = pts[i];
        const lat = pts[i + 1];
        if (prevLon !== null && Math.abs(lon - prevLon) > WRAP_DEG) {
            if (run.length > 1) runs.push(run);
            run = [];
        }
        run.push([lat, lon]);
        prevLon = lon;
    }
    if (run.length > 1) runs.push(run);
    return runs;
}

// The outline's colour, taken from the theme rather than fixed.
//
// `--text-faint` and not `--border-strong`, which is the token these map boxes
// draw their own frame in: against the surface behind the tiles that is about
// 1.4:1, which on a 1px stroke is a coastline you have to know is there. The
// muted text colour is around 2.5:1 in both themes — quiet enough to stay
// scenery, strong enough to read as a map.
//
// Leaflet's canvas renderer paints with a literal, so a CSS variable cannot be
// handed to it — it is read once, here, at the moment of drawing. That means
// the outline keeps the colour of the theme in force when the map was built and
// does not follow a later theme change, which is the same bargain the tile
// filter in styles.css makes and is invisible in practice: switching theme with
// an offline map open is not a thing anybody does twice.
//
// It is also why the tile filter cannot touch it: that rule is keyed on
// `.leaflet-tile`, and this is a canvas in the overlay pane. The outline is
// already the right colour for the theme and must not be inverted with the
// tiles that are not there.
function outlineColour() {
    try {
        const v = getComputedStyle(document.documentElement)
            .getPropertyValue('--text-faint').trim();
        if (v) return v;
    } catch (e) { /* no document, or a theme that does not define it */ }
    // Mid grey reads on both the light and the dark surface behind these maps.
    return '#6b7280';
}

/**
 * Draw the local outline onto a map, as one layer.
 *
 * One multi-polyline rather than fourteen hundred separate ones, on the canvas
 * renderer: this is scenery, and scenery that costs a DOM node per arc would be
 * felt on the spots map, which already redraws a few hundred markers a minute
 * over the top of it.
 *
 * Resolves to the layer, or null if the outline could not be loaded — in which
 * case the map is no worse off than it was.
 */
export async function addWorldOutline(L, map) {
    const arcs = await loadWorldArcs();
    if (!arcs || !arcs.length || !map) return null;

    const runs = [];
    for (const arc of arcs) {
        for (const run of arcToLatLngs(arc.pts)) runs.push(run);
    }
    if (!runs.length) return null;

    const layer = L.polyline(runs, {
        renderer: L.canvas(),
        color: outlineColour(),
        weight: 1,
        // Full strength: the colour is already the muted one, and fading it
        // again is how a coastline becomes a suggestion.
        opacity: 1,
        // Nothing here is a feature: it is the shape of the land behind the
        // things that are. A click belongs to the marker or the map underneath.
        interactive: false,
        attribution: OFFLINE_ATTRIBUTION,
    });
    try {
        layer.addTo(map);
        // Under everything. Leaflet puts a new layer on top, and an outline
        // drawn over the markers would put coastlines through the callsign
        // labels.
        if (typeof layer.bringToBack === 'function') layer.bringToBack();
    } catch (e) {
        // The map was removed while the outline was being fetched — a panel
        // collapsed, a modal closed. Leaflet throws on a map it has already
        // torn down, and there is nothing to add the layer to.
        return null;
    }
    return layer;
}

/**
 * Add the OSM tile layer to a map, with the local outline behind it.
 *
 * The one call all four maps make. Watches the layer's own load and error
 * events and, if enough tiles fail without a single one arriving, takes the
 * tile layer off the map and draws the outline in its place. Removing the
 * failed layer matters as much as adding the outline: left on, it re-requests
 * the whole grid on every pan and zoom, and a map that cannot reach the tile
 * server should stop asking it.
 *
 * @returns {() => void} a teardown for the watch. Removing the map disposes of
 *          the layers either way — this only stops a fallback landing on a map
 *          that has already gone.
 */
export function addBaseLayer(L, map, options = {}) {
    // No attribution unless the caller asks for it. Three of the four maps are
    // built with `attributionControl: false` and have no box to put a credit
    // in; handing them one here would be a change to what they look like when
    // everything is working, which is not what this is for.
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, ...options });
    tiles.addTo(map);

    let ok = 0;
    let failed = 0;
    let done = false;

    const stop = () => {
        done = true;
        tiles.off('tileload', onLoad);
        tiles.off('tileerror', onError);
    };

    function onLoad() {
        ok += 1;
        // One tile through means the tile server is reachable, and every error
        // after it is about that tile rather than about the connection.
        stop();
    }

    function onError() {
        failed += 1;
        if (done || ok > 0 || failed < FAIL_THRESHOLD) return;
        stop();
        map.removeLayer(tiles);
        // Not awaited: the caller is building a map, not waiting on scenery,
        // and the outline appears when it appears. A map torn down while the
        // outline is in flight is handled inside addWorldOutline.
        addWorldOutline(L, map).catch(() => { /* no outline either; nothing more to try */ });
    }

    tiles.on('tileload', onLoad);
    tiles.on('tileerror', onError);

    return stop;
}
