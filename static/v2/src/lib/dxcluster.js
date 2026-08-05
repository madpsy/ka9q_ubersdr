// The DX cluster addon's feed.
//
// This is a different thing from the DX spots in the Spots panel, and the two
// are easy to confuse. That feed is the receiver's own cluster connection,
// advertised as `dx_cluster` in /api/description and delivered over the
// receiver's spot socket. This one is the **dxcluster addon** — a container the
// operator runs, which is itself a cluster: it accepts telnet logins, takes
// spots from local decoders, and publishes everything it sees. It appears in
// `serverInfo.addons` and is proxied at /addon/dxcluster/.
//
// Four streams arrive on one feed, distinguished by `stream`:
//
//   dxcluster   spots from the wider cluster network (and `localspot`, the
//               same thing submitted by a logged-in telnet user)
//   decoder     FT8/FT4/WSPR/JS8 decodes from this receiver
//   cwskimmer   CW skimmer decodes
//   voice       voice activity
//
// Transport, all under /addon/dxcluster:
//
//   GET /api/status          streams, telnet address, who is logged in
//   GET /api/spots?stream=X  history, newest first
//   GET /api/countries       the country list the filter offers
//   GET /api/events          SSE; one spot per `message`, plus `heartbeat`
//   WS  /api/terminal        the telnet cluster itself, as a terminal
//
// Nothing here opens anything on its own. The panel connects when it is
// mounted and disconnects when it is not, which in this UI means when the
// operator opens and closes it — an addon feed nobody is looking at should not
// be costing the receiver a connection.

export const BASE = '/addon/dxcluster';

export const ADDON_NAME = 'dxcluster';

/** Is the addon on this receiver? */
export function dxClusterAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons) && addons.includes(ADDON_NAME);
}

// How each stream presents. `localspot` is a dxcluster spot that came from a
// telnet user rather than the network; it reads as DX because that is what it
// is, and keeping it separate here would split one column in two for no reason
// anybody looking at the list would care about.
export const STREAMS = [
    { id: 'dxcluster', label: 'DX', tone: 'dx' },
    { id: 'decoder', label: 'Digital', tone: 'digital' },
    { id: 'cwskimmer', label: 'CW', tone: 'cw' },
    { id: 'voice', label: 'Voice', tone: 'voice' },
];

const STREAM_ALIAS = { localspot: 'dxcluster' };

export const streamOf = (spot) => STREAM_ALIAS[spot.stream] || spot.stream || '';

export const streamMeta = (id) => STREAMS.find((s) => s.id === id)
    || { id, label: id || '—', tone: '' };

// Modes each stream can report. A stream with none — the cluster itself — is
// never excluded by the mode filter, because a spot with no mode is not a spot
// whose mode failed to match.
// Quoted, because these are wire values rather than identifiers — and because
// `dxcluster` unquoted is also the name of the receiver's own cluster socket
// singleton, which is a different thing entirely (see the note at the top).
export const STREAM_MODES = {
    'decoder': ['FT8', 'FT4', 'FT2', 'WSPR', 'JS8'],
    'cwskimmer': ['CW'],
    'voice': ['USB', 'LSB'],
    'dxcluster': [],
};

export const ALL_MODES = [...new Set(Object.values(STREAM_MODES).flat())];

/**
 * The mode to filter and display a spot by.
 *
 * Not simply `spot.mode`: the skimmer does not label its decodes, and voice
 * activity carries the sideband in `voice_mode`.
 */
export function modeOf(spot) {
    const stream = streamOf(spot);
    if (stream === 'cwskimmer') return 'CW';
    if (stream === 'voice') return (spot.voice_mode || spot.mode || '').toUpperCase();
    return (spot.mode || '').toUpperCase();
}

/**
 * Where to tune for a spot.
 *
 * A digital decode's `freq_hz` is where the *signal* is, which for FT8 is an
 * audio tone somewhere inside the passband; `est_dial_freq` is where the radio
 * has to be for that to land in it. Tuning to the first one puts the dial a
 * kilohertz or two off and the decode outside the filter.
 */
export function dialFreq(spot) {
    const est = Number(spot.est_dial_freq);
    if (Number.isFinite(est) && est > 0) return Math.round(est);
    const f = Number(spot.freq_hz);
    return Number.isFinite(f) && f > 0 ? Math.round(f) : null;
}

/** Stable identity for a spot, so history and live cannot double up. */
export function spotKey(spot) {
    return [
        streamOf(spot), spot.callsign || '', spot.freq_hz || 0,
        spot.timestamp || '', spot.spotter || '',
    ].join('|');
}

export const DEFAULT_FILTERS = {
    streams: STREAMS.map((s) => s.id),   // which feeds are shown
    modes: ALL_MODES,                    // which modes, where the stream has any
    bands: [],                           // empty means every band
    continents: [],
    countries: [],                       // ISO alpha-2, as the spots carry
    call: '',                            // callsign prefix, or a list of them
    snrMin: null,
    snrMax: null,
};

const upper = (s) => String(s || '').toUpperCase();

/** The callsign box takes a prefix, or several separated by spaces or commas. */
export function callPrefixes(text) {
    return upper(text).split(/[\s,]+/).filter(Boolean);
}

/**
 * Does this spot survive the filters?
 *
 * A field the spot does not carry never excludes it. A cluster spot has no SNR
 * and no mode, and filtering those out would empty the DX column the moment
 * anybody touched a slider that has nothing to do with it.
 */
export function spotMatches(spot, f) {
    const stream = streamOf(spot);
    if (f.streams && !f.streams.includes(stream)) return false;

    const modes = STREAM_MODES[stream];
    if (modes && modes.length && f.modes) {
        const mode = modeOf(spot);
        if (mode && !f.modes.includes(mode)) return false;
    }

    if (f.bands && f.bands.length) {
        const band = upper(spot.band);
        if (band && !f.bands.map(upper).includes(band)) return false;
    }
    if (f.continents && f.continents.length) {
        const cont = upper(spot.continent);
        if (cont && !f.continents.map(upper).includes(cont)) return false;
    }
    if (f.countries && f.countries.length) {
        const cc = upper(spot.country_code);
        if (cc && !f.countries.map(upper).includes(cc)) return false;
    }
    if (f.call) {
        const prefixes = callPrefixes(f.call);
        const call = upper(spot.callsign);
        if (prefixes.length && call && !prefixes.some((p) => call.startsWith(p))) return false;
    }

    const snr = Number(spot.snr);
    if (Number.isFinite(snr)) {
        if (f.snrMin != null && snr < f.snrMin) return false;
        if (f.snrMax != null && snr > f.snrMax) return false;
    }
    return true;
}

/** Bands present in a set of spots, ordered by frequency rather than by name. */
export function bandsIn(spots) {
    // Keyed case-insensitively but offered as the spots spell it: these become
    // the labels on the filter chips, and the band plan is written "20m".
    const seen = new Map();
    for (const s of spots) {
        const key = upper(s.band);
        if (key && !seen.has(key)) seen.set(key, { label: s.band, hz: Number(s.freq_hz) || 0 });
    }
    return [...seen.values()].sort((a, b) => a.hz - b.hz).map((b) => b.label);
}

export function continentsIn(spots) {
    return [...new Set(spots.map((s) => upper(s.continent)).filter(Boolean))].sort();
}

/** Countries present, as `{ code, name }`, by name. */
export function countriesIn(spots) {
    const seen = new Map();
    for (const s of spots) {
        const code = upper(s.country_code);
        if (code && !seen.has(code)) seen.set(code, s.country || code);
    }
    return [...seen.entries()]
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
