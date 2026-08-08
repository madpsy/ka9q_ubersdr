// Spot normalisation, tuning rules and filtering.
//
// Three feeds arrive on `/ws/dxcluster` with three different payload shapes,
// three different names for the same field, and — in the DX cluster's case — a
// mode that has to be inferred because a cluster spot does not carry one. The
// v1 extensions each solve that separately; this is the one place v2 does.
//
// Behaviour is taken from the v1 extensions, which work: the field names are
// the server's (see broadcastSpot / BroadcastDigitalSpot / BroadcastCWSpot in
// dxcluster_websocket.go), the mode rules below are copied from their
// `tuneToSpot`, and the filters and their defaults are the ones their templates
// ship with.

// Frequencies are Hz throughout. The server converts the cluster's kHz on the
// way in (dxcluster.go: `spot.Frequency = freqKHz * 1000`), so every feed is
// already in Hz by the time it reaches us.

// v1's list caps. The DX cluster is a slow feed and 500 is generous; the
// skimmer and decoder feeds can run to thousands an hour on a good day.
export const MAX_SPOTS = { dx: 500, digital: 5000, cw: 5000 };

// Default age windows, from the v1 templates' `selected` options.
export const DEFAULT_AGE_MIN = { dx: 30, digital: 10, cw: 10 };

export const AGE_OPTIONS = {
    dx: [1, 5, 10, 20, 30, 60, null],
    digital: [5, 10, 15, 30, 60, null],
    cw: [1, 5, 10, 15, 30, 60, null],
};

export const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];

export const SNR_OPTIONS = {
    digital: [null, 20, 15, 10, 5, 0, -5, -10, -15, -20],
    cw: [null, 20, 15, 10, 5, 0, -5, -10],
};

export const WPM_OPTIONS = [null, 10, 15, 20, 25, 30];
export const DISTANCE_OPTIONS = [null, 100, 1000, 2500, 5000, 10000];

// v1's digital mode filter list.
export const DIGITAL_MODES = ['FT8', 'FT4', 'FT2', 'WSPR', 'JS8'];

// Above this a 10m spot is a beacon rather than a QSO, and the skimmer sees a
// great many of them. v1 hides them by default and offers a switch.
export const TEN_M_BEACON_HZ = 28200000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Milliseconds since the epoch from whatever the feed calls its timestamp:
// DX and CW spots carry RFC3339 `time`, digital spots carry `timestamp`.
function spotTime(raw) {
    const v = raw.time != null ? raw.time : raw.timestamp;
    if (v == null) return Date.now();
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
}

// --- the common row --------------------------------------------------------
//
// Everything the list and the tuning path need, under one set of names. The
// original payload is kept on `raw` so a per-feed column can reach a field this
// does not promote.

function base(kind, raw) {
    return {
        kind,
        raw,
        at: spotTime(raw),
        frequency: num(raw.frequency) || 0,
        band: raw.band || '',
        country: raw.country || '',
        countryCode: raw.country_code || '',
        continent: raw.continent || raw.Continent || '',
        distanceKm: num(raw.distance_km),
        bearingDeg: num(raw.bearing_deg),
        snr: num(raw.snr),
    };
}

export function normaliseDX(raw) {
    return {
        ...base('dx', raw),
        callsign: raw.dx_call || '',
        spotter: raw.spotter || '',
        comment: raw.comment || '',
        snr: null,             // cluster spots carry no SNR; the comment may
    };
}

export function normaliseDigital(raw) {
    return {
        ...base('digital', raw),
        callsign: raw.callsign || '',
        spotter: '',
        mode: raw.mode || '',
        submode: raw.submode || '',
        grid: raw.locator || '',
        message: raw.message || '',
    };
}

export function normaliseCW(raw) {
    return {
        ...base('cw', raw),
        callsign: raw.dx_call || '',
        spotter: raw.spotter || '',
        comment: raw.comment || '',
        wpm: num(raw.wpm),
        // Present only when the skimmer runs with QRZ callsign lookup on.
        grid: raw.grid || '',
        name: raw.name_fmt || '',
        state: raw.state || '',
    };
}

export const NORMALISE = { dx: normaliseDX, digital: normaliseDigital, cw: normaliseCW };

// A stable identity for a spot, so re-subscribing (which replays the server's
// buffer) does not duplicate rows already on screen. Frequency, callsign and
// timestamp together are what make a spot distinct in every feed.
export function spotKey(spot) {
    return `${spot.kind}:${spot.callsign}:${Math.round(spot.frequency)}:${spot.at}`;
}

// --- tuning ----------------------------------------------------------------
//
// Copied from the v1 extensions' tuneToSpot, including the 10 MHz sideband
// crossover — below it LSB/CWL, above it USB/CWU.

const SIDEBAND_CROSSOVER_HZ = 10000000;

// DX cluster spots have no mode field, so v1 reads the spotter's comment: FT8
// or FT4 means USB regardless of band, CW means CWL/CWU, anything else is
// treated as voice.
export function modeForDX(spot) {
    const comment = String(spot.comment || '').toUpperCase();
    if (comment.includes('FT8') || comment.includes('FT4')) return 'usb';
    if (comment.includes('CW')) return spot.frequency >= SIDEBAND_CROSSOVER_HZ ? 'cwu' : 'cwl';
    return spot.frequency >= SIDEBAND_CROSSOVER_HZ ? 'usb' : 'lsb';
}

export function modeForSpot(spot) {
    switch (spot.kind) {
        // Every digital mode this decodes is upper sideband, on every band.
        case 'digital': return 'usb';
        case 'cw': return spot.frequency >= SIDEBAND_CROSSOVER_HZ ? 'cwu' : 'cwl';
        default: return modeForDX(spot);
    }
}

// --- filtering -------------------------------------------------------------

// The band filter's third state, along 'all' and a named band: follow the dial.
//
// Default, and it is the right default for a spot list. What somebody wants from one is
// almost always "who can be heard where I am listening" — a 20m spot while you are on 40m
// is a fact about somebody else's afternoon — and the alternative is a list that has to be
// re-filtered by hand every time the dial moves to another band. The spectrogram panel
// made the same choice for the same reason, and this is the same idea in a filter.
//
// 'all' stays, because "what is open anywhere" is the other real question, and a named band
// stays because pinning one is how you watch a band you are not listening to.
export const AUTO_BAND = 'auto';

export const DEFAULT_FILTERS = {
    age: null,          // minutes, null = no limit (set per kind by the panel)
    band: AUTO_BAND,
    mode: 'all',        // digital only
    country: 'all',
    callsign: '',
    minSnr: null,
    minWpm: null,       // CW only
    minDistance: null,
    tenMeterBeacons: false,   // CW only; v1 hides them by default
};

/**
 * Which band the filter means right now.
 *
 * Named at length because `bandFilter` is a key in the object v1's CW graph is handed
 * (see compat/cwGraph.js), and a bare one in an object literal is indistinguishable from
 * a use of this — which test/unresolved.js quite reasonably objects to.
 *
 * 'auto' resolves to the band the dial is in — and to 'all' when the dial is somewhere no
 * band covers, which is most of the shortwave spectrum. That fallback matters: a listener
 * parked on 6 MHz would otherwise see an empty list and no clue why, and "no band" is not
 * a band anybody has spots for.
 */
export function resolveBandFilter(choice, dialBand) {
    if (choice !== AUTO_BAND) return choice;
    return dialBand || 'all';
}

/**
 * `dialBand` is where the receiver is tuned, for the 'auto' band filter. Omit it and auto
 * behaves as 'all', which is what a caller with no dial to consult should get.
 */
export function filterSpots(spots, filters, now = Date.now(), dialBand = null) {
    const f = { ...DEFAULT_FILTERS, ...filters };
    const band = resolveBandFilter(f.band, dialBand);
    const call = f.callsign.trim().toUpperCase();
    const maxAgeMs = f.age == null ? null : f.age * 60000;

    return spots.filter((s) => {
        if (maxAgeMs != null && now - s.at > maxAgeMs) return false;
        if (band !== 'all' && s.band !== band) return false;
        if (f.mode !== 'all' && (s.mode || '').toUpperCase() !== f.mode) return false;
        if (f.country !== 'all' && s.country !== f.country) return false;
        // Substring, not prefix: v1 matches anywhere in the callsign so a
        // suffix like /P or a partial prefix both find their spots.
        if (call && !String(s.callsign).toUpperCase().includes(call)) return false;
        if (f.minSnr != null && (s.snr == null || s.snr < f.minSnr)) return false;
        if (f.minWpm != null && (s.wpm == null || s.wpm < f.minWpm)) return false;
        if (f.minDistance != null && (s.distanceKm == null || s.distanceKm < f.minDistance)) return false;
        if (s.kind === 'cw' && !f.tenMeterBeacons && s.frequency >= TEN_M_BEACON_HZ) return false;
        return true;
    });
}

// Countries present in a list, for the country picker. Sorted, and built from
// the spots themselves rather than a fixed table — v1 does the same, so the
// list only ever offers a country that has actually been heard.
export function countriesIn(spots) {
    const seen = new Set();
    for (const s of spots) if (s.country) seen.add(s.country);
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

// Inserts a spot at the head of the list, dropping the oldest past the cap and
// ignoring one already held. Newest first is the order all three v1 tables use.
export function addSpot(list, spot, cap) {
    const key = spotKey(spot);
    if (list.some((s) => s.key === key)) return list;
    const next = [{ ...spot, key }, ...list];
    return next.length > cap ? next.slice(0, cap) : next;
}

// How far back the spectrum markers reach. v1 draws markers from the same list
// the table holds, filtered by the extension's age setting — so with the filter
// left alone (which is the common case) these are the windows it uses.
// Deliberately not wired to the panel's live filter: the markers are on when
// the panel may well be closed, and a marker layer whose depth depends on a
// control you cannot see is worse than a fixed one.
export const MARKER_AGE_MIN = { dx: DEFAULT_AGE_MIN.dx, cw: DEFAULT_AGE_MIN.cw };

// The spots a marker layer should draw: recent enough, inside the view, and at
// most one per frequency — the skimmer re-spots the same station every few
// minutes, and stacking those would be a pile of identical pills. The newest
// wins, which is the one whose age is worth reading.
export function markerSpots({ spots, kind, startFreq, endFreq, now = Date.now() }) {
    const maxAgeMs = MARKER_AGE_MIN[kind] * 60000;
    const byFreq = new Map();
    for (const s of spots) {
        if (now - s.at > maxAgeMs) continue;
        if (s.frequency < startFreq || s.frequency > endFreq) continue;
        // 100 Hz buckets: the same station re-spotted drifts by a few tens of
        // Hz between reports, and two genuinely different stations that close
        // together could not be told apart on screen anyway.
        const bucket = Math.round(s.frequency / 100);
        const held = byFreq.get(bucket);
        if (!held || s.at > held.at) byFreq.set(bucket, s);
    }
    return Array.from(byFreq.values()).sort((a, b) => a.frequency - b.frequency);
}

// "3m", "45s", "2h" — v1's age column, which is what makes a stale spot
// obvious at a glance.
export function ageLabel(at, now = Date.now()) {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}
