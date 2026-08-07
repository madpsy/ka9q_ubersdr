// The packet addon: AX.25 frames decoded off this receiver.
//
// The addon tunes any number of channels, pipes each one's audio into its own
// soundmodem, and keeps every decoded frame in a ring buffer. Its own page has the
// monitor, the per-channel modem settings, the waterfall and the audio preview. This is
// the dock version: who is being heard, on what, and how long ago.
//
// ── Why this polls, when the lightning panel streams ─────────────────────────
//
// The addon has an SSE endpoint, and it is the wrong one for this. /api/events carries
// the *raw* KISS bytes coming out of each soundmodem, base64 in a JSON envelope — the
// addon's own page subscribes to it and decodes AX.25 in the browser. Doing the same
// here would mean a second AX.25 decoder in this repo, kept in step with theirs, to
// arrive at frames the addon has already decoded and is willing to hand over as JSON.
//
// So: /api/frames, every few seconds. Packet is not a mode where that loses anything —
// an APRS beacon is every minute or two, a busy VHF channel is a frame every few
// seconds, and the ring buffer means a poll cannot miss one that arrived between two
// requests. It is also honest about cost: one small request per channel per interval,
// nothing while the panel is closed.

export const BASE = '/addon/packet';

export const ADDON_NAME = 'packet';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the SSTV and lightning panels make. */
export function packetAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How many frames to ask for, and how often.
//
// Forty covers a busy VHF channel between polls several times over, and the request is
// a few kilobytes. Five seconds is faster than packet arrives — an APRS beacon is every
// minute or two — and slow enough that a panel left open all day is not a load.
export const FRAME_LIMIT = 40;
export const POLL_MS = 5000;

// `channel=*` merges every channel, newest first. The aggregate does not say which
// channel each frame came from — the addon's own limitation, not a choice here — which
// is why the panel names the channels it is listening to rather than tagging each row
// with one.
export const framesUrl = (base = BASE, limit = FRAME_LIMIT) =>
    `${base}/api/frames?channel=*&limit=${Math.max(1, Math.round(limit) || FRAME_LIMIT)}`;

export const channelsUrl = (base = BASE) => `${base}/api/channels`;

// Per-channel, for the markers. The aggregate query above cannot say which channel a
// frame came from, and a marker has to sit on a frequency — so the markers ask each
// channel separately. There are typically one or two.
export const channelFramesUrl = (label, base = BASE, limit = MARKER_FRAMES) =>
    `${base}/api/frames?channel=${encodeURIComponent(label)}&limit=${limit}`;

// How many frames each channel's marker is built from, and how long a station stays on
// it. Thirty frames and fifteen minutes: enough that a marker on a quiet channel still
// says who is there, short enough that it is a picture of now rather than a log.
export const MARKER_FRAMES = 30;
export const MARKER_AGE_MS = 15 * 60 * 1000;

// How often the marker store polls, when anything is subscribed to it. Slower than the
// panel: a marker is a "who is on this frequency" caption, not a monitor, and it is
// polling once per channel.
export const MARKER_POLL_MS = 20000;

// How long the panel keeps frames for: the headline figures are quoted over an hour.
export const KEEP_MS = 60 * 60 * 1000;
export const KEEP_MAX = 500;

// How many frames the list shows, and the window the rate is measured over.
export const LIST_MAX = 8;
export const RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * One frame, in the shape the panel uses.
 *
 * The identity is the receive time and the addresses rather than an id, because the
 * addon does not give frames one: two polls overlap by design, so the same frame comes
 * back on every request until it falls out of the window, and something has to say that
 * they are the same frame. A repeated beacon a minute later differs in `at`, so it
 * counts as the new frame it is.
 */
export function normaliseFrame(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Date.parse(raw.received_at);
    if (!Number.isFinite(at)) return null;
    const from = String(raw.from || '').toUpperCase();
    const to = String(raw.to || '').toUpperCase();
    const snr = raw.snr == null ? null : Number(raw.snr);
    return {
        id: `${at}|${from}|${to}|${raw.sm_ch}`,
        at,
        from,
        to,
        via: Array.isArray(raw.via) ? raw.via.map((v) => String(v).toUpperCase()) : [],
        type: String(raw.frame_type || '').toLowerCase(),
        // The addon decodes APRS into a description and keeps the payload separately.
        // The description is the useful one for a narrow column; the raw text is the
        // fallback for the frame types it does not interpret.
        info: String(raw.info || raw.info_raw || '').trim(),
        snr: Number.isFinite(snr) ? snr : null,
        smCh: Number(raw.sm_ch) || 0,
    };
}

/**
 * Merge a poll into the list, newest first, without counting anything twice.
 *
 * Frames come back newest-first and overlapping, so this is a set union rather than an
 * append: what the panel holds is every distinct frame of the last hour, in time order.
 */
export function mergeFrames(list, incoming, now = Date.now()) {
    const seen = new Set(list.map((f) => f.id));
    const add = [];
    for (const f of incoming) {
        if (!f || seen.has(f.id)) continue;
        seen.add(f.id);
        add.push(f);
    }
    if (!add.length) return list;
    const out = [...add, ...list].sort((a, b) => b.at - a.at);
    return trimFrames(out, now);
}

export function trimFrames(list, now = Date.now()) {
    const cutoff = now - KEEP_MS;
    const kept = list.filter((f) => f.at >= cutoff);
    return kept.length > KEEP_MAX ? kept.slice(0, KEEP_MAX) : kept;
}

/**
 * The headline figures: frames in the hour, how many a minute lately, and how many
 * distinct stations have been heard.
 *
 * Stations counts *sources*, not addresses: a digipeater path is full of callsigns that
 * were not necessarily on the air just then, and "heard" should mean heard. The rate is
 * over ten minutes rather than one — packet is bursty enough that a one-minute window
 * reads zero most of the time on a quiet channel, which says nothing useful.
 */
export function packetStats(list, now = Date.now()) {
    const hourFrom = now - KEEP_MS;
    const rateFrom = now - RATE_WINDOW_MS;
    const heard = new Set();
    let frames = 0;
    let recent = 0;
    for (const f of list) {
        if (f.at < hourFrom) continue;
        frames++;
        if (f.from) heard.add(f.from);
        if (f.at >= rateFrom) recent++;
    }
    return {
        frames,
        stations: heard.size,
        rate: recent / (RATE_WINDOW_MS / 60000),
        last: list.length ? list[0].at : null,
    };
}

/** The stations heard most often, for the panel's "who is out there" line. */
export function topStations(list, limit = 3, now = Date.now()) {
    const cutoff = now - KEEP_MS;
    const tally = new Map();
    for (const f of list) {
        if (f.at < cutoff || !f.from) continue;
        tally.set(f.from, (tally.get(f.from) || 0) + 1);
    }
    return [...tally.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([call, n]) => ({ call, n }));
}

// What a frame is, in one word, for the badge on its row. The addon's own frame_type
// with APRS pulled out of it: an APRS frame is a UI frame, but it is the one people are
// looking for, and "UI" on every row says nothing.
export function frameKind(frame) {
    if (!frame) return '';
    const t = frame.type;
    if (t === 'aprs') return 'aprs';
    if (t === 'ui') return 'ui';
    if (!t) return '';
    return t.slice(0, 4);
}

/**
 * The channels the addon is listening on, from /api/channels.
 *
 * Only what the panel names them by: the label and the frequency, which between them
 * are the whole of "what is being monitored". A channel whose instance has not started
 * still counts — it is configured, and saying so is more use than leaving it out.
 */
export function channelSummary(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((c) => {
        const inst = (c && c.instance) || {};
        const hz = Number(inst.freq_hz) || 0;
        return {
            label: String((c && (c.label || c.name)) || '').trim(),
            hz,
            mhz: hz ? (hz / 1e6).toFixed(3) : '',
            up: String(inst.status || '').toLowerCase() === 'connected',
        };
    }).filter((c) => c.label || c.hz);
}

/**
 * The station pairs heard on one channel: who was talking to whom, and how recently.
 *
 * This is the marker's whole reason for existing. Every other marker in the bar is one
 * thing at one frequency — a bookmark, a spot, a detection — but a packet channel is a
 * *shared* frequency, and what is worth knowing about it is not "packet is here", which
 * the marker's own position says, but who is on it. A single 144.800 marker with six
 * pairs behind it is the honest shape of that.
 *
 * Grouped by from→to rather than listed as frames: a station beaconing every minute is
 * one line with a count, not thirty lines. Ordered by how recently each pair was heard,
 * because the question is who is there *now*.
 */
export function stationPairs(frames, now = Date.now(), maxAge = MARKER_AGE_MS) {
    const cutoff = now - maxAge;
    const byPair = new Map();
    for (const f of frames) {
        if (!f || f.at < cutoff || !f.from) continue;
        const key = `${f.from}>${f.to}`;
        const hit = byPair.get(key);
        if (hit) {
            hit.n++;
            if (f.at > hit.at) hit.at = f.at;
        } else {
            byPair.set(key, { from: f.from, to: f.to, n: 1, at: f.at });
        }
    }
    return [...byPair.values()].sort((a, b) => b.at - a.at);
}

/** The distinct stations behind those pairs, most recently heard first. */
export function stationsHeard(pairs) {
    const seen = [];
    for (const p of pairs) if (!seen.includes(p.from)) seen.push(p.from);
    return seen;
}

/**
 * What the marker says on its face: the busiest few callsigns, and how many more.
 *
 * A pill is forty pixels of a canvas. One callsign and "+4" is as much as fits and as
 * much as is worth reading at a glance — the rest is in the tooltip, which is where
 * somebody who is actually interested will look.
 */
export function markerLabel(pairs, mhz) {
    const calls = stationsHeard(pairs);
    if (!calls.length) return mhz ? `${mhz} pkt` : 'packet';
    if (calls.length === 1) return calls[0];
    return `${calls[0]} +${calls.length - 1}`;
}

/** HH:MM:SS in UTC — the addon's page uses UTC and so does everything else here. */
export function clockOf(ms) {
    try {
        return new Date(ms).toISOString().slice(11, 19);
    } catch (e) {
        return '';
    }
}

/** How long ago, in the unit that fits: seconds, then minutes, then hours. */
export function sinceLabel(at, now = Date.now()) {
    if (!at) return '—';
    const secs = Math.max(0, Math.round((now - at) / 1000));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    return `${Math.floor(secs / 3600)}h`;
}
