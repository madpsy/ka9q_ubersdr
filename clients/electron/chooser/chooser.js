'use strict';

// Chooser page logic. Everything talks to the main process through the
// window.ubersdr surface exposed by preload.js; the DOM is built with
// createElement throughout so instance-supplied strings are never markup.
//
// Three tabs, because the three lists answer different questions and only one
// of them is ever the question at hand: saved receivers ("back to the one I
// use"), the local network ("the box in the shack"), and the public directory
// ("somewhere else in the world"). Stacked in one column they made the page a
// scroll, and the directory — the longest list, and the only one with a map —
// sat below two hundred pixels of the other two.

const api = window.ubersdr;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const byId = (id) => document.getElementById(id);

let builtinAvailable = false;
let sortBy = 'used';

// How the saved list is ordered.
//
// By use, because the question this page answers is "where do I listen", and
// the answer is a receiver somebody keeps coming back to rather than whichever
// one they happened to open last — one evening spent trying receivers from the
// directory would otherwise bury a daily driver under a dozen one-offs.
//
// Recency is the tie-break, not the rule: it is what separates entries that are
// level (including every entry saved before counting existed, which start at
// zero together), and it keeps the order stable rather than arbitrary. Somebody
// who does want the old behaviour has the picker beside the heading.
const SORTS = {
    used: (a, b) => (b.useCount || 0) - (a.useCount || 0)
        || (b.lastUsed || '').localeCompare(a.lastUsed || ''),
    recent: (a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''),
};

// ---- row rendering ---------------------------------------------------------

// Primary/secondary line format follows the TUI picker: "CALLSIGN · Name",
// then "Location · host · n/m free · SNR · vX".
function describe(row) {
    let primary = row.label || row.name || `${row.host}:${row.port}`;
    if (row.callsign && !primary.toUpperCase().includes(row.callsign.toUpperCase())) {
        primary = `${row.callsign} · ${primary}`;
    }
    const parts = [];
    if (row.location) parts.push(row.location);
    parts.push(`${row.tls ? 'https' : 'http'}://${row.host}:${row.port}`);
    if (row.availableClients >= 0 && row.maxClients > 0) {
        parts.push(`${row.availableClients}/${row.maxClients} free`);
    }
    if (row.snr > 0) parts.push(`SNR ${row.snr} dB`);
    if (row.version) parts.push(`v${row.version}`);
    // Saved receivers only; LAN and directory rows have no count to show.
    // Silent at zero rather than reading "0 visits", which would be a claim
    // about a receiver saved before counting existed — those have been visited
    // an unknown number of times, not none.
    if (row.useCount > 0) parts.push(`${row.useCount} ${row.useCount === 1 ? 'visit' : 'visits'}`);
    return { primary, secondary: parts.join(' · ') };
}

function makeRow(row, actions) {
    const div = el('div', 'row');
    const info = el('div', 'info');
    const { primary, secondary } = describe(row);
    const primaryEl = el('div', 'primary', primary);
    if (row.running) primaryEl.appendChild(el('span', 'live', '● connected'));
    info.appendChild(primaryEl);
    info.appendChild(el('div', 'secondary', secondary));
    div.appendChild(info);
    const actionBox = el('div', 'actions');
    for (const action of actions) actionBox.appendChild(action);
    div.appendChild(actionBox);
    return div;
}

function connectButton(desc, statusEl) {
    const btn = el('button', null, desc.running ? 'Show' : 'Connect');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await api.connect(desc);
        btn.disabled = false;
        if (!res.ok) showStatus(statusEl, res.error, true);
        else refreshSaved();
    });
    return btn;
}

// ---- the password key ------------------------------------------------------
//
// Optional, and rarely wanted: most receivers ask for nothing, so this is an
// icon rather than a field on every row — a box marked "password" beside two
// hundred directory entries would suggest they all need one. The icon lights up
// where a password is set, which is the one thing worth seeing at a glance.
//
// What it holds is v2's bypass password (see static/v2/src/radio/session.js).
// In a browser it is typed into the start overlay and forgotten when the tab
// closes; the desktop client's saved list exists so that things are not typed
// twice, so here it is kept — in the OS keychain where the platform has one.

const SVG_NS = 'http://www.w3.org/2000/svg';

function keyIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const bow = document.createElementNS(SVG_NS, 'circle');
    bow.setAttribute('cx', '8');
    bow.setAttribute('cy', '15.5');
    bow.setAttribute('r', '4');
    const blade = document.createElementNS(SVG_NS, 'path');
    blade.setAttribute('d', 'M10.9 12.6 20.5 3M18 5.5l2.5 2.5M15 8.5l2 2');
    svg.appendChild(bow);
    svg.appendChild(blade);
    return svg;
}

// One modal at a time, and Escape closes it — a dialog that can be stacked or
// stranded is a dialog somebody has to close by quitting the app.
let openModal = null;

function closeModal() {
    if (!openModal) return;
    openModal.remove();
    openModal = null;
}

/**
 * The shell every dialog on this page shares: a backdrop that closes on Escape
 * or a click outside, and one modal box inside it.
 *
 * @param {Node[]} content  the body of the dialog, top to bottom
 * @returns {Node} the modal, so a caller can go on appending to it
 */
function showModal(content) {
    closeModal();
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    for (const node of content) modal.appendChild(node);

    backdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    });
    // A click on the page behind it, not one that started inside and ended out.
    backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) closeModal();
    });

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    openModal = backdrop;
    return modal;
}

/**
 * @param {object} row     the receiver — a saved entry, or a LAN/directory row
 * @param {function} done  called with the new hasPassword once it is settled
 */
function askPassword(row, done) {
    const { primary } = describe(row);

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = row.hasPassword ? 'Saved — type to replace' : 'Password';
    input.autocomplete = 'off';

    const note = el('div', 'modal-note');
    note.hidden = true;

    const modal = showModal([
        el('h3', null, 'Password'),
        el('p', 'modal-target', primary),
        el('p', null,
            'Optional. A bypass password given to you by this receiver’s operator — it '
            + 'is sent to this receiver only, and is used automatically every time you connect.'),
        input,
        note,
    ]);

    const actions = el('div', 'modal-actions');
    const clear = el('button', 'danger', 'Clear');
    // Nothing to clear on a receiver that has none: a button that cannot do
    // anything is one somebody clicks to find out.
    clear.disabled = !row.hasPassword;
    const cancel = el('button', 'ghost', 'Cancel');
    const save = el('button', null, 'Save');

    const settle = async (password) => {
        save.disabled = true;
        clear.disabled = true;
        const res = await api.setPassword({
            id: row.id, host: row.host, port: row.port, tls: row.tls,
        }, password);
        if (!res.saved) {
            // Not a saved receiver yet — one from the scan or the directory.
            // It travels with the connect that creates the entry.
            row.password = password;
        }
        row.hasPassword = !!password;
        closeModal();
        if (done) done(row.hasPassword);
    };

    save.addEventListener('click', () => {
        const value = input.value.trim();
        if (!value) {
            note.textContent = 'Enter a password, or use Clear to remove the one saved.';
            note.hidden = false;
            input.focus();
            return;
        }
        settle(value);
    });
    clear.addEventListener('click', () => settle(''));
    cancel.addEventListener('click', closeModal);

    actions.appendChild(clear);
    actions.appendChild(el('span', 'modal-spacer'));
    actions.appendChild(cancel);
    actions.appendChild(save);
    modal.appendChild(actions);

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); save.click(); }
    });
    input.focus();
}

function keyButton(row, done) {
    const btn = el('button', 'ghost key-btn');
    // Explicit, because this one sits inside the address form, and a button in a
    // form with no type is a submit button — clicking the key would connect.
    btn.type = 'button';
    btn.appendChild(keyIcon());
    const label = () => {
        btn.classList.toggle('set', !!row.hasPassword);
        btn.title = row.hasPassword
            ? 'A password is saved for this receiver — click to change or clear it'
            : 'Set a password for this receiver (optional)';
        btn.setAttribute('aria-label', btn.title);
    };
    label();
    btn.addEventListener('click', () => askPassword(row, () => {
        label();
        if (done) done();
    }));
    return btn;
}

function showStatus(node, text, isError) {
    if (!node) return;
    node.textContent = text || '';
    if (node.classList.contains('status')) {
        node.hidden = !text;
        node.classList.toggle('error', !!isError);
    }
}

// ---- geography -------------------------------------------------------------
//
// Ported from static/v2/src/lib/callsign.js rather than imported: the chooser is
// a plain page with no bundler, and these are two short functions with no
// dependencies. Both are the same arithmetic the web UI uses, so a distance read
// here and one read in a receiver window agree.

/** Great-circle distance in km (haversine on a 6371 km sphere). */
function distanceKm(fromLat, fromLon, toLat, toLon) {
    if ([fromLat, fromLon, toLat, toLon].some((v) => !Number.isFinite(v))) return null;
    const rad = (d) => (d * Math.PI) / 180;
    const dp = rad(toLat - fromLat);
    const dl = rad(toLon - fromLon);
    const a = Math.sin(dp / 2) ** 2
        + Math.cos(rad(fromLat)) * Math.cos(rad(toLat)) * Math.sin(dl / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * A great-circle path between two points, as [lat, lon] pairs for a polyline.
 *
 * Drawn as a curve because it is one: a straight line on a Mercator map between
 * two distant points is not the path the signal took, and on HF the difference
 * is most of what makes a receiver on the far side of the world interesting.
 * The same interpolation the web UI's callsign map uses, so the two draw the
 * same arc between the same two stations.
 */
function geodesicPoints(lat1, lon1, lat2, lon2, steps = 64) {
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const p1 = rad(lat1);
    const l1 = rad(lon1);
    const p2 = rad(lat2);
    const l2 = rad(lon2);
    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((p2 - p1) / 2) ** 2
        + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
    ));
    // The same point twice: one vertex, and no division by a sine of nothing.
    if (!d || !Number.isFinite(d)) return [[lat1, lon1]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
        const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
        const z = A * Math.sin(p1) + B * Math.sin(p2);
        pts.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
    }
    return pts;
}

/** A 4- or 6-character Maidenhead locator as the centre of its square. */
function maidenheadToLatLon(locator) {
    if (typeof locator !== 'string') return null;
    const loc = locator.trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(loc)) return null;

    let lon = -180 + (loc.charCodeAt(0) - 65) * 20 + parseInt(loc[2], 10) * 2;
    let lat = -90 + (loc.charCodeAt(1) - 65) * 10 + parseInt(loc[3], 10) * 1;

    if (loc.length >= 6) {
        lon += (loc.charCodeAt(4) - 65) * (2 / 24);
        lat += (loc.charCodeAt(5) - 65) * (1 / 24);
        // Centre of the subsquare rather than its corner.
        lon += 1 / 24;
        lat += 0.5 / 24;
    } else {
        lon += 1;
        lat += 0.5;
    }
    return { lat, lon };
}

/** A two-letter country code as its flag, the way the web UI draws one. */
function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * What the operator typed into the location box: "51.5, -0.12" or "IO91wm".
 * Returns a position with a label of its own, or null.
 */
function parsePlace(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;

    const grid = maidenheadToLatLon(trimmed);
    if (grid) return { ...grid, label: trimmed.toUpperCase() };

    // Comma, whitespace or both — a pair copied out of a map, a GPS or a config
    // file arrives in all three shapes.
    const pair = trimmed.split(/[,\s]+/).filter(Boolean);
    if (pair.length !== 2) return null;
    const lat = Number(pair[0]);
    const lon = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, label: `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
}

// ---- saved receivers -------------------------------------------------------

async function refreshSaved() {
    const list = byId('saved-list');
    const empty = byId('saved-empty');
    const entries = await api.saved();
    entries.sort(SORTS[sortBy] || SORTS.used);
    list.replaceChildren();
    empty.hidden = entries.length > 0;
    setCount('saved', entries.length);

    for (const entry of entries) {
        const uiSelect = el('select');
        for (const [value, label] of [['builtin', 'built-in UI'], ['remote', "instance's UI"]]) {
            const opt = el('option', null, label);
            opt.value = value;
            uiSelect.appendChild(opt);
        }
        uiSelect.value = entry.ui === 'remote' || !builtinAvailable ? 'remote' : 'builtin';
        uiSelect.disabled = !builtinAvailable;
        uiSelect.title = builtinAvailable
            ? 'Which frontend to run: the bundle shipped with this app, or the one the instance serves'
            : 'No bundled UI staged — run build.sh to enable the built-in option';
        uiSelect.addEventListener('change', () => api.update(entry.id, { ui: uiSelect.value }));

        const remove = el('button', 'danger', 'Remove');
        remove.addEventListener('click', async () => {
            await api.remove(entry.id);
            refreshSaved();
        });

        const status = byId('add-status');
        list.appendChild(
            makeRow(entry, [
                keyButton(entry),
                uiSelect,
                connectButton({ id: entry.id, running: entry.running }, status),
                remove,
            ]),
        );
    }
    return entries.length;
}

// ---- LAN discovery ---------------------------------------------------------

let lanScanned = false;

async function scanLan() {
    lanScanned = true;
    const btn = byId('lan-scan');
    const status = byId('lan-status');
    const list = byId('lan-list');
    btn.disabled = true;
    status.textContent = 'scanning…';
    try {
        const rows = await api.lan();
        list.replaceChildren();
        for (const row of rows) {
            list.appendChild(makeRow(row, [
                keyButton(row),
                connectButton(row, byId('add-status')),
            ]));
        }
        setCount('lan', rows.length);
        status.textContent = rows.length
            ? `${rows.length} found`
            : 'none found (instances advertise via mDNS — see install-ubersdr-mdns.sh)';
    } catch (err) {
        status.textContent = `scan failed: ${err.message}`;
    }
    btn.disabled = false;
}

// ---- the map ---------------------------------------------------------------
//
// Leaflet and OpenStreetMap tiles, the same pairing the web UI's start and
// callsign maps use — so a receiver seen here and the same receiver seen from
// inside a session look alike.
//
// The library is loaded on demand from files staged beside this page rather than
// bundled into it: it is 150 KB that only this one tab wants, and a run that
// never opens the directory never reads it off disk. Its absence is survivable
// and says so — a checkout that has not been through build.sh still lists every
// receiver, it just cannot draw them.

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const LEAFLET_JS = 'vendor/leaflet.js';
const LEAFLET_CSS = 'vendor/leaflet.css';
const TERMINATOR_JS = 'vendor/L.Terminator.js';

// What a click on a list row zooms to, if the map is not already closer in.
const PICK_ZOOM = 7;
// As close as fitting will go on its own. Without it a filter narrowed to one
// receiver fits a single point and lands on its rooftop, which says less about
// where it is than a view of the country it is in.
const FIT_MAX_ZOOM = 8;

function loadAsset(tag, attrs) {
    return new Promise((resolve, reject) => {
        const node = document.createElement(tag);
        node.onload = () => resolve();
        node.onerror = () => reject(new Error(`failed to load ${attrs.src || attrs.href}`));
        for (const [key, value] of Object.entries(attrs)) node[key] = value;
        document.head.appendChild(node);
    });
}

let map = null;
let mapReady = null;          // the in-flight or settled build, so it happens once
let mapFailed = false;
let terminator = null;
// key -> { marker, row, pos: [lat, lon] }. The row and the position are kept
// beside the marker rather than read back off it: the icon has to be rebuilt
// when the selection moves, and the position it was actually drawn at may be a
// nudge off the row's own (see spread).
const markers = new Map();
let homeMarker = null;
let homePath = null;          // the great circle to whichever row is selected
// What the current view was fitted to. The map refits when the set of pins
// changes — first load, a filter typed, a receiver appearing or going away — and
// not otherwise, so a view somebody has panned to survives the minute's refresh.
let fittedTo = '';
// A fit asked for but not yet possible: { ends, signature }. See fitView.
let pendingFit = null;
// The rows the map is showing, so opening the tab can draw them without the
// list being rebuilt underneath the scroll position.
let shownRows = [];

/** A stable identity for a directory row, for markers and selection. */
const keyOf = (row) => row.uuid || `${row.host}:${row.port}`;

async function buildMap() {
    await Promise.all([
        loadAsset('link', { rel: 'stylesheet', href: LEAFLET_CSS }),
        loadAsset('script', { src: LEAFLET_JS, async: false }),
    ]);
    const L = window.L;
    if (!L) throw new Error('leaflet loaded but defined nothing');

    map = L.map('dir-map', {
        // On, unlike the maps inside the web UI. Those sit in scrolling columns,
        // where a wheel that zoomed would trap the pointer on its way past; this
        // one is a whole column of a page that does not scroll at all — the list
        // beside it does its own — so there is nothing for the wheel to do
        // instead, and a map that ignores it reads as a picture. It also gives
        // trackpad pinch back, which Chromium delivers as ctrl+wheel.
        scrollWheelZoom: true,
        attributionControl: false,
        worldCopyJump: true,
    }).setView([25, 0], 2);

    L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);

    // Grey where it is night, which on HF is half the reason to look at a map
    // of receivers at all. Best-effort: the map is worth having without it.
    try {
        await loadAsset('script', { src: TERMINATOR_JS, async: false });
        if (L.terminator) {
            terminator = L.terminator({ fillOpacity: 0.28, color: '#000', weight: 1 }).addTo(map);
            setInterval(() => { if (terminator) terminator.setTime(); }, 60000);
        }
    } catch { /* no terminator, and nothing else lost */ }

    return map;
}

/**
 * The map, built on first use and resized on every return to the tab.
 *
 * The resize is not optional: the panel is `hidden` until its tab is chosen, so
 * a map built while it was hidden measured its container as nothing and drew a
 * single tile in the corner.
 */
async function ensureMap() {
    if (mapFailed) return null;
    if (!mapReady) {
        mapReady = buildMap().catch((err) => {
            mapFailed = true;
            byId('dir-map').hidden = true;
            byId('map-fallback').hidden = false;
            byId('map-fallback').textContent = `No map: ${err.message}`;
            return null;
        });
    }
    const m = await mapReady;
    if (m) {
        m.invalidateSize();
        // The container may only now have acquired a size — see fitView.
        fitView(m);
    }
    return m;
}

/**
 * Fit the view to the pins, once the map is in a position to measure them.
 *
 * A Leaflet map in a hidden panel measures its container as nothing, and fitting
 * to nothing is not a no-op: getBoundsZoom subtracts the padding from a zero
 * size, divides by a negative, and takes the log of it, so the zoom comes back
 * NaN and the map lands somewhere arbitrary. It then stays there, because as far
 * as the code was concerned the fit had happened.
 *
 * So the fit is held until the container has a size, and retried on the way into
 * the tab. Nothing else about drawing needs the map to be visible; this is the
 * one measurement that does.
 */
function fitView(m) {
    if (!pendingFit) return;
    const size = m.getSize();
    if (!size.x || !size.y) return;
    m.fitBounds(window.L.latLngBounds(pendingFit.ends), {
        padding: [30, 30],
        maxZoom: FIT_MAX_ZOOM,
    });
    fittedTo = pendingFit.signature;
    pendingFit = null;
}

function pinIcon(L, row) {
    const wrap = el('div', 'pin-wrap');
    const classes = ['pin'];
    if (!row.online) classes.push('pin--offline');
    if (keyOf(row) === selected) classes.push('pin--selected');
    wrap.appendChild(el('div', classes.join(' ')));
    if (row.callsign) wrap.appendChild(el('div', 'pin-label', row.callsign));
    // A dot, so the anchor is its centre rather than a point at the bottom.
    return L.divIcon({
        html: wrap.outerHTML,
        className: 'pin-icon',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -10],
    });
}

/**
 * What a pin says about its receiver.
 *
 * Two audiences, one card. On hover it is a tooltip — the answer to "what is
 * this one", which is the question a map of forty-five identical dots mostly
 * raises — and there it stops at the facts: a tooltip vanishes as the pointer
 * leaves the pin, so a button on one is a button that cannot be reached. On a
 * click it is a popup, which stays, and there the same card carries Connect and
 * the password key.
 *
 * @param {boolean} actions  whether to append the buttons.
 */
function cardFor(row, actions) {
    const box = el('div', 'popup');
    const title = el('div', 'popup-title');
    const flag = countryFlag(row.countryCode);
    if (flag) title.appendChild(el('span', 'flag', flag));
    title.appendChild(el('span', null, row.callsign || row.name));
    box.appendChild(title);
    if (row.name && row.name !== row.callsign) box.appendChild(el('div', 'popup-name', row.name));

    const facts = [];
    if (row.location) facts.push(row.location);
    if (Number.isFinite(row.distance)) facts.push(`${Math.round(row.distance)} km away`);
    if (row.availableClients >= 0 && row.maxClients > 0) {
        facts.push(`${row.availableClients} of ${row.maxClients} slots free`);
    }
    if (row.grid) facts.push(row.grid);
    if (!row.online) facts.push('Offline');
    for (const fact of facts) box.appendChild(el('div', 'popup-fact', fact));

    if (actions) {
        const buttons = el('div', 'popup-actions');
        buttons.appendChild(keyButton(row));
        buttons.appendChild(connectButton(row, byId('add-status')));
        box.appendChild(buttons);
    }
    return box;
}

/** Two receivers at one address: spiral them apart so both can be clicked. */
function spread(rows) {
    const used = new Map();
    return rows.map((row) => {
        const at = `${row.lat.toFixed(4)},${row.lon.toFixed(4)}`;
        const n = used.get(at) || 0;
        used.set(at, n + 1);
        if (!n) return [row.lat, row.lon];
        const angle = n * 60 * (Math.PI / 180);
        const r = 0.0006 * (Math.floor(n / 6) + 1);
        return [row.lat + r * Math.cos(angle), row.lon + r * Math.sin(angle)];
    });
}

async function drawMarkers(rows) {
    shownRows = rows;
    // The directory list loads whichever tab the page opened on, so that the map
    // tab is instant when it is reached. Drawing it is a different matter: with
    // the panel hidden there is nothing to draw on, and building a map to find
    // that out fetches 150 KB for a tab nobody has opened. showTab draws when it
    // opens one.
    if (!mapReady && activeTab !== 'dir') return;
    const m = await ensureMap();
    if (!m) return;
    const L = window.L;

    for (const pin of markers.values()) m.removeLayer(pin.marker);
    markers.clear();

    const placed = rows.filter((row) => row.lat != null && row.lon != null);
    const points = spread(placed);
    placed.forEach((row, i) => {
        const marker = L.marker(points[i], { icon: pinIcon(L, row) })
            .addTo(m)
            .bindPopup(cardFor(row, true), { closeButton: true, minWidth: 190 })
            .bindTooltip(cardFor(row, false), {
                direction: 'top',
                offset: [0, -12],
                className: 'pin-tip',
                opacity: 1,
            });
        marker.on('click', () => select(keyOf(row), { fromMap: true }));

        // The hover card and the click card are the same card, so showing both
        // at once would be the receiver's details drawn twice, one over the
        // other. The popup is the one that was asked for, so it wins.
        let popupOpen = false;
        marker.on('popupopen', () => { popupOpen = true; marker.closeTooltip(); });
        marker.on('popupclose', () => { popupOpen = false; });
        marker.on('tooltipopen', () => { if (popupOpen) marker.closeTooltip(); });

        markers.set(keyOf(row), { marker, row, pos: points[i] });
    });

    if (homeMarker) { m.removeLayer(homeMarker); homeMarker = null; }
    if (home) {
        homeMarker = L.marker([home.lat, home.lon], {
            icon: L.divIcon({
                html: el('div', 'home-pin').outerHTML,
                className: 'pin-icon',
                iconSize: [20, 20],
                iconAnchor: [10, 10],
            }),
            // Under the receivers: it is the reference point, not a destination.
            zIndexOffset: -1000,
            interactive: false,
        }).addTo(m);
    }

    drawPath();

    // Everything on screen at once, the operator included. Refitted whenever the
    // set of pins changes — the first load, a filter typed, a receiver appearing
    // or dropping out — and left alone otherwise, so a view somebody has panned
    // or zoomed to survives the next refresh.
    // At least one receiver, not merely something to fit: the map is drawn once
    // as the tab opens and again when the directory answers, and the first of
    // those has only the home pin to work with. Fitting to that would zoom to
    // the operator's own town for a moment and then jump out — one view change
    // where there should be none. Until there are receivers the map stays on the
    // world it opened with, which is also the honest picture of a directory that
    // is empty or did not load.
    const ends = home ? [...points, [home.lat, home.lon]] : points;
    const signature = ends.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ');
    if (points.length && signature !== fittedTo) pendingFit = { ends, signature };
    fitView(m);
}

/**
 * The path from the operator to the receiver they have picked out.
 *
 * The web UI's callsign map draws exactly this between a station and the
 * receiver hearing it, and it is the same question here: a directory row says
 * "16994 km" and this is what 16994 km looks like. One at a time rather than one
 * per receiver — forty-five arcs from one point is a sunburst, not a map.
 */
function drawPath() {
    if (!map) return;
    if (homePath) { map.removeLayer(homePath); homePath = null; }
    const pin = selected ? markers.get(selected) : null;
    if (!home || !pin) return;
    // Blue, and dashed the way the start overlay dashes its own you-to-receiver
    // line — which is the same line this is. Red would read as a receiver that
    // is down, since that is what red means on these pins.
    homePath = window.L.polyline(geodesicPoints(home.lat, home.lon, pin.pos[0], pin.pos[1]), {
        color: '#4c8dff',
        weight: 2,
        opacity: 0.7,
        dashArray: '5, 10',
        interactive: false,
    }).addTo(map);
}

/**
 * Show one receiver in both halves of the tab: highlighted in the list, and
 * open on the map.
 *
 * @param {boolean} fromMap  set when the pin was clicked. The list still scrolls
 *                           to the row — that is the half that has to catch up —
 *                           but the map is left where it is: Leaflet is already
 *                           opening the popup, and panning under a pointer that
 *                           has just landed on a pin moves the map out from
 *                           under the next click.
 */
/**
 * Hovering a row, which points at its pin.
 *
 * The list and the map are two views of one set, and the connection between a
 * row and a dot is the thing a map like this has to make obvious — reading
 * "Woking, UK" and then hunting the pins for the one that means it is the work
 * the map was supposed to save. So the row raises the pin's own card, the same
 * one hovering the pin raises.
 *
 * Not a pan, though the pin may be off screen: a pointer crossing a list on its
 * way somewhere else would drag the map through half the world. Clicking is what
 * moves the view.
 */
function hoverRow(key, on) {
    const pin = markers.get(key);
    if (!pin) return;
    if (on) pin.marker.openTooltip();
    else pin.marker.closeTooltip();
}

function select(key, { fromMap } = {}) {
    const was = selected;
    selected = key;
    for (const [rowKey, node] of rowNodes) node.classList.toggle('selected', rowKey === key);
    const node = rowNodes.get(key);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });

    // Only the two pins that changed, rather than a redraw of all of them: the
    // ring moves off one and onto another, and rebuilding forty-five icons to
    // say so would close the popup Leaflet is in the middle of opening.
    for (const pinKey of new Set([was, key])) {
        const pin = pinKey && markers.get(pinKey);
        if (pin) pin.marker.setIcon(pinIcon(window.L, pin.row));
    }
    drawPath();

    const pin = markers.get(key);
    if (pin && !fromMap && map) {
        map.setView(pin.pos, Math.max(map.getZoom(), PICK_ZOOM), { animate: true });
        pin.marker.openPopup();
    }
}

// ---- public directory ------------------------------------------------------

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];

// The directory's own thresholds (collector/static/instances.js), so a band that
// reads "good" on the web directory reads "good" here.
const FAIR = 6;
function conditionClass(snr) {
    if (snr < FAIR) return 'poor';
    if (snr < 20) return 'fair';
    if (snr < 30) return 'good';
    return 'excellent';
}

// Band conditions are a measurement, and a measurement has a shelf life. The
// directory refreshes them every few minutes; half an hour without one means
// the instance stopped reporting, and badges from before that are a picture of
// a propagation that has since moved on.
const STALE_MS = 30 * 60 * 1000;
function conditionsFresh(row) {
    if (!row.bandConditions || !row.conditionsAt) return false;
    const at = Date.parse(row.conditionsAt);
    return Number.isFinite(at) && Date.now() - at < STALE_MS;
}

let directoryRows = [];
let dirSort = 'snr';
let home = null;
let selected = null;
const rowNodes = new Map();

// Offline receivers sink to the bottom of every order. They are still listed —
// an instance that is down for the evening is one somebody may still be looking
// for — but no sort of "where do I listen tonight" puts them first.
function bySort(key) {
    // MAX_VALUE rather than Infinity for the missing ones, because two rows that
    // are both missing must compare equal and `Infinity - Infinity` is NaN — a
    // comparator that returns NaN sorts arbitrarily. Both cases are ordinary:
    // receivers the directory has no position for, and receivers whose band
    // conditions have gone stale.
    const asc = (v) => (v == null ? Number.MAX_VALUE : v);
    const desc = (v) => (v == null ? -Number.MAX_VALUE : v);
    const orders = {
        distance: (a, b) => asc(a.distance) - asc(b.distance),
        listeners: (a, b) => b.availableClients - a.availableClients || b.snr - a.snr,
        snr: (a, b) => desc(b.conditionSnr) - desc(a.conditionSnr) || b.snr - a.snr,
        name: (a, b) => (a.callsign || a.name).localeCompare(b.callsign || b.name),
    };
    const inner = orders[key] || orders.snr;
    return (a, b) => (a.online === b.online ? inner(a, b) : (a.online ? -1 : 1));
}

/** Per-row values that depend on where the operator is, or on the clock. */
function annotate(rows) {
    for (const row of rows) {
        row.distance = home && row.lat != null && row.lon != null
            ? distanceKm(home.lat, home.lon, row.lat, row.lon)
            : null;
        row.conditionSnr = conditionsFresh(row) ? row.avgBandSnr : null;
    }
    return rows;
}

function bandBadges(row) {
    const box = el('div', 'bands');
    if (!conditionsFresh(row)) return box;
    for (const band of BANDS) {
        const snr = row.bandConditions[band];
        if (typeof snr !== 'number' || snr < FAIR) continue;
        const badge = el('span', `band ${conditionClass(snr)}`, band.replace('m', ''));
        badge.title = `${band}: ${snr.toFixed(1)} dB`;
        box.appendChild(badge);
    }
    return box;
}

function directoryRow(row) {
    const div = el('div', 'drow');
    if (keyOf(row) === selected) div.classList.add('selected');

    const top = el('div', 'drow-top');
    const dot = el('span', `dot ${row.online ? 'online' : 'offline'}`);
    dot.title = row.online ? 'Online' : 'Offline';
    top.appendChild(dot);
    const flag = countryFlag(row.countryCode);
    if (flag) {
        const flagEl = el('span', 'flag', flag);
        flagEl.title = row.countryName || row.countryCode.toUpperCase();
        top.appendChild(flagEl);
    }
    top.appendChild(el('span', 'call', row.callsign || row.name));
    top.appendChild(el('span', 'spacer'));

    if (row.conditionSnr != null) {
        const snr = el('span', `badge ${conditionClass(row.conditionSnr)}`, `${row.conditionSnr.toFixed(1)} dB`);
        snr.title = 'Average FT8 SNR across the HF bands — the directory’s measure of '
            + 'how well this receiver is hearing right now.';
        top.appendChild(snr);
    }
    if (row.maxClients > 0) {
        const free = row.availableClients > 0;
        const users = el('span', `badge users ${free ? 'free' : 'full'}`,
            `${row.availableClients}/${row.maxClients}`);
        users.title = free
            ? `${row.availableClients} of ${row.maxClients} listener slots free`
            : 'No free listener slots';
        top.appendChild(users);
    }
    div.appendChild(top);

    if (row.name && row.name !== row.callsign) {
        div.appendChild(el('div', 'drow-name', `${row.name} ${row.daylight ? '☀️' : '🌙'}`));
    }

    const meta = [];
    if (row.location) meta.push(row.location);
    if (Number.isFinite(row.distance)) meta.push(`${Math.round(row.distance)} km`);
    if (row.version) meta.push(`v${row.version}`);
    // A directory entry that filled none of these in gets no line, rather than
    // an empty one that reads as a gap in the card.
    if (meta.length) div.appendChild(el('div', 'drow-meta', meta.join(' · ')));

    const foot = el('div', 'drow-foot');
    foot.appendChild(bandBadges(row));
    foot.appendChild(el('span', 'spacer'));
    foot.appendChild(keyButton(row));
    foot.appendChild(connectButton(row, byId('add-status')));
    div.appendChild(foot);

    // The row is a target as well as a card, but only where it is not a button:
    // a click meant for Connect must not also move the map out from under it.
    div.addEventListener('click', (event) => {
        if (event.target && event.target.closest && event.target.closest('button')) return;
        select(keyOf(row));
    });
    // enter/leave rather than over/out: these do not bubble, so crossing the
    // badges and buttons inside the row is not a stream of leaving and arriving
    // again, which would flicker the pin's card on and off under the pointer.
    div.addEventListener('mouseenter', () => hoverRow(keyOf(row), true));
    div.addEventListener('mouseleave', () => hoverRow(keyOf(row), false));
    return div;
}

function renderDirectory() {
    const filter = byId('dir-filter').value.trim().toLowerCase();
    const list = byId('dir-list');
    const status = byId('dir-status');
    const rows = annotate(directoryRows).filter((row) => {
        if (!filter) return true;
        return [row.name, row.callsign, row.location, row.countryName, row.grid, row.host]
            .some((field) => field && field.toLowerCase().includes(filter));
    });
    rows.sort(bySort(dirSort));

    list.replaceChildren();
    rowNodes.clear();
    for (const row of rows) {
        const node = directoryRow(row);
        rowNodes.set(keyOf(row), node);
        list.appendChild(node);
    }
    status.textContent = `${rows.length}${filter ? ` of ${directoryRows.length}` : ''} receivers`;
    setCount('dir', directoryRows.length);
    // Not awaited: the list is the answer and the map is the illustration, so
    // the pins land whenever Leaflet is ready and the rows never wait for them.
    drawMarkers(rows).catch(() => { /* ensureMap has already said so on the page */ });
}

async function loadDirectory() {
    const status = byId('dir-status');
    status.textContent = 'loading…';
    try {
        directoryRows = await api.directory();
        renderDirectory();
    } catch (err) {
        status.textContent = `directory unavailable: ${err.message}`;
    }
}

const DIR_SORTS = ['distance', 'listeners', 'snr', 'name'];

function setDirSort(key, { persist = true } = {}) {
    // Distance is meaningless without a position to measure from, and a sort
    // that silently does nothing is worse than one that is visibly unavailable.
    if (key === 'distance' && !home) key = 'snr';
    dirSort = DIR_SORTS.includes(key) ? key : 'snr';
    for (const name of DIR_SORTS) {
        const btn = byId(`dir-sort-${name}`);
        btn.classList.toggle('active', name === dirSort);
        if (name === 'distance') {
            btn.disabled = !home;
            btn.title = home ? '' : 'Set your location to sort by distance';
        }
    }
    if (persist) api.setChooser({ dirSort });
}

// ---- where the operator is -------------------------------------------------

function homeLabel() {
    // Says which of the two it is, because they fail differently: a GeoIP answer
    // that is wrong by a county is worth correcting, and no answer at all means
    // the lookup could not place this connection — a private address behind a
    // proxy or a tunnel, which no amount of retrying will fix. Both are the same
    // button away, and neither should read as the map being broken.
    if (!home) return 'Your IP address could not be placed — set your location to see distances';
    if (home.source === 'manual') return `You: ${home.label || `${home.lat.toFixed(2)}, ${home.lon.toFixed(2)}`}`;
    const place = [home.city, home.country].filter(Boolean).join(', ');
    return `You: ${place || `${home.lat.toFixed(2)}, ${home.lon.toFixed(2)}`} (from your IP address)`;
}

function showHome() {
    byId('home-status').textContent = homeLabel();
}

/**
 * Setting it by hand.
 *
 * Offered because the automatic answer is GeoIP and GeoIP is often wrong by a
 * county and occasionally wrong by a country — a VPN, a mobile network, a rural
 * ISP that registers its whole range to a city. Distance sorting is only worth
 * having if the point it measures from is right.
 */
function askHome() {
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'IO91wm  or  51.507, -0.128';
    if (home && home.source === 'manual') input.value = home.label || `${home.lat}, ${home.lon}`;

    const note = el('div', 'modal-note');
    note.hidden = true;

    const modal = showModal([
        el('h3', null, 'Your location'),
        el('p', null,
            'A Maidenhead locator or a latitude and longitude. It is used on this '
            + 'machine only — to draw you on the map and to measure how far away '
            + 'each receiver is — and is never sent anywhere.'),
        input,
        note,
    ]);

    const actions = el('div', 'modal-actions');
    const clear = el('button', 'danger', 'Use my IP address');
    clear.disabled = !(home && home.source === 'manual');
    const cancel = el('button', 'ghost', 'Cancel');
    const save = el('button', null, 'Save');

    const settle = async (place) => {
        save.disabled = true;
        clear.disabled = true;
        await api.setChooser({ home: place });
        home = await api.home();
        closeModal();
        showHome();
        // A new reference point: every distance in the list is now wrong, and so
        // is the fit, which had the old position as one of its corners.
        fittedTo = '';
        // Typing in a location is an act with one purpose, so it lands on the
        // sort it was for. Clearing it leaves the sort alone — beyond distance
        // itself, which setDirSort drops for want of anywhere to measure from.
        setDirSort(place ? 'distance' : dirSort);
        renderDirectory();
    };

    save.addEventListener('click', () => {
        const place = parsePlace(input.value);
        if (!place) {
            note.textContent = 'Not a locator or a coordinate pair — try IO91wm, or 51.507, -0.128.';
            note.hidden = false;
            input.focus();
            return;
        }
        settle(place);
    });
    clear.addEventListener('click', () => settle(null));
    cancel.addEventListener('click', closeModal);

    actions.appendChild(clear);
    actions.appendChild(el('span', 'modal-spacer'));
    actions.appendChild(cancel);
    actions.appendChild(save);
    modal.appendChild(actions);

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); save.click(); }
    });
    input.focus();
}

// ---- tabs ------------------------------------------------------------------

const TABS = ['saved', 'lan', 'dir'];
let activeTab = 'dir';

function setCount(tab, n) {
    byId(`tab-${tab}-count`).textContent = n > 0 ? ` ${n}` : '';
}

function showTab(name, { persist = true } = {}) {
    activeTab = TABS.includes(name) ? name : 'dir';
    for (const tab of TABS) {
        const btn = byId(`tab-${tab}`);
        const on = tab === activeTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        byId(`panel-${tab}`).hidden = !on;
    }
    // Deferred until the tab is first opened rather than run at startup: an
    // mDNS browse takes three seconds and the directory is a network round
    // trip, and neither is worth doing for somebody who came here to click the
    // receiver they always use.
    if (activeTab === 'lan' && !lanScanned) scanLan();
    // Building it, drawing whatever the list is already showing, and fitting the
    // view now that the panel has a size to measure — all of which drawMarkers
    // does, and none of which can happen while the tab is shut.
    if (activeTab === 'dir') {
        drawMarkers(shownRows).catch(() => { /* already said so on the page */ });
    }
    if (persist) api.setChooser({ tab: activeTab });
}

// ---- manual add ------------------------------------------------------------

// A password for a receiver that does not exist yet: typed against the address
// in the box, carried into the connect that saves it. Kept here rather than
// asked for afterwards because a receiver that wants a password wants it on the
// first connection, and being bounced to the start overlay to find that out is
// the long way round.
//
// Its label is read rather than stored: the dialog names the receiver it is for,
// and for this one that is whatever is in the address box at the moment the key
// is used — by mouse or by keyboard, which is why it is not copied on a click.
const manualPending = {};
Object.defineProperty(manualPending, 'label', {
    get: () => byId('add-input').value.trim() || 'New receiver',
});

async function addManual() {
    const input = byId('add-input');
    const btn = byId('add-btn');
    const status = byId('add-status');
    const text = input.value.trim();
    if (!text) return;
    const password = manualPending.password || undefined;

    const done = (connected) => {
        showStatus(status, connected.ok ? '' : connected.error, !connected.ok);
        if (connected.ok) {
            input.value = '';
            delete manualPending.password;
            manualPending.hasPassword = false;
        }
        refreshSaved();
    };

    btn.disabled = true;
    showStatus(status, `probing ${text}…`);
    const res = await api.resolve(text);
    if (res.ok) {
        done(await api.connect({ ...res.row, password }));
    } else if (res.certError) {
        // Self-signed (or otherwise untrusted) certificate: make accepting it
        // an explicit click, scoped to this one receiver.
        showStatus(status, `${res.error} — `, true);
        const trust = el('button', null, 'Trust this receiver anyway');
        trust.addEventListener('click', async () => {
            trust.disabled = true;
            const retry = await api.resolve(text, { insecureTLS: true });
            if (!retry.ok) return showStatus(status, retry.error, true);
            done(await api.connect({ ...retry.row, insecureTLS: true, password }));
        });
        status.appendChild(trust);
    } else {
        showStatus(status, res.error, true);
    }
    btn.disabled = false;
}

// ---- startup ---------------------------------------------------------------

byId('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addManual();
});
byId('add-form').insertBefore(keyButton(manualPending), byId('add-btn'));
byId('lan-scan').addEventListener('click', scanLan);
byId('saved-sort').addEventListener('change', async (event) => {
    sortBy = await api.setSort(event.target.value);
    event.target.value = sortBy;
    refreshSaved();
});
byId('shared-prefs-box').addEventListener('change', async (event) => {
    // The main process answers with what it actually set, so the box can never
    // show a state the store doesn't hold.
    event.target.checked = await api.setSharedPrefs(event.target.checked);
});
byId('dir-refresh').addEventListener('click', loadDirectory);
byId('dir-filter').addEventListener('input', renderDirectory);
byId('home-set').addEventListener('click', askHome);
for (const tab of TABS) byId(`tab-${tab}`).addEventListener('click', () => showTab(tab));
for (const name of DIR_SORTS) {
    byId(`dir-sort-${name}`).addEventListener('click', () => {
        setDirSort(name);
        renderDirectory();
    });
}
api.onChanged(refreshSaved);

(async () => {
    const info = await api.appInfo();
    builtinAvailable = info.builtinAvailable;
    byId('shared-prefs-box').checked = await api.sharedPrefs();
    sortBy = await api.sort();
    byId('saved-sort').value = sortBy;
    byId('footer').textContent = builtinAvailable
        ? `bundled v2 UI: ${info.buildInfo || 'staged'}`
        : 'no bundled UI staged (run build.sh) — receivers open with the UI they serve';

    const state = await api.chooser();
    const savedCount = await refreshSaved();

    // The directory unless there is a saved list to open on, which is the whole
    // point of having one — and the directory is where somebody with nothing
    // saved has to start anyway. A tab chosen last time overrides both.
    showTab(state.tab || (savedCount ? 'saved' : 'dir'), { persist: false });

    // Before the first render, so the first list already carries distances and
    // the map opens where the operator is rather than jumping there a moment
    // later. Never throws — the whole tab works without it.
    home = await api.home().catch(() => null);
    showHome();
    setDirSort(state.dirSort || (home ? 'distance' : 'snr'), { persist: false });
    loadDirectory();
})();
