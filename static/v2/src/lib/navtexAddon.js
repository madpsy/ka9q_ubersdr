// The NAVTEX addon: maritime safety broadcasts, already decoded.
//
// The addon watches both NAVTEX frequencies at once — 518 kHz international and
// 490 kHz national — decodes SITOR-B on each, and keeps the latest complete message it
// has seen. Its own page has the live character-by-character decode, the signal stats
// and the whole history; this is the dock version: the last thing each frequency
// actually said.
//
// Not to be confused with the NAVTEX *extension*, which decodes off this receiver's own
// audio in the browser. The two share the IMO subject table (lib/navtexCodes.js) and
// nothing else: one is what we are hearing right now, the other is what a dedicated
// receiver on a dedicated antenna has been hearing all day.
//
// ── Why a minute is a fast poll here ─────────────────────────────────────────
//
// A NAVTEX broadcast takes several minutes to send and stations transmit on a schedule
// — each station gets a ten-minute slot every four hours. A message that arrived
// between two polls is still the latest message when the next one lands, because there
// will not be another for hours. Polling faster would be asking a question whose answer
// cannot have changed.

export const BASE = '/addon/navtex';

export const ADDON_NAME = 'navtex';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function navtexAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// /api/latest holds the newest complete message per frequency *and* per station and
// subject — a frequency carries several transmitters, each sending several kinds of
// message. The panel wants the newest per frequency, which is a reduction of that: see
// latestPerFreq.
export const latestUrl = (base = BASE) => `${base}/api/latest`;

export const POLL_MS = 60000;

// ── Which frequencies exist ─────────────────────────────────────────────────
//
// The addon has no endpoint for its configuration. The channel labels it was started
// with are baked into the HTML it serves, as a JavaScript array, and nothing publishes
// them as JSON — so the honest answer to "which frequencies is this receiver watching"
// is that the API cannot say.
//
// What it can say is which frequencies have produced messages. Two sources, both
// imperfect and complementary:
//
//   /api/latest is what is in memory, so it lists a frequency only if that frequency
//   has completed a message since the addon started. A receiver restarted an hour ago
//   knows about neither of its channels.
//
//   /api/metrics counts messages per frequency over the last 24 hours and 30 days, from
//   the names of the log directories — so it remembers a frequency that has been quiet
//   all day. It returns nothing at all when file logging is switched off, which is why
//   it cannot be the only source.
//
// Together they cover every frequency that has ever said anything, which is as close to
// "configured" as this addon can be asked. A channel configured today that has never
// decoded a message appears in neither, and there is nothing here that could know about
// it — the panel would need the addon to publish its configuration.
export const metricsUrl = (base = BASE) => `${base}/api/metrics`;

// Read once on mount and rarely after: log directories appear when a frequency first
// decodes something, which is not an every-minute event.
export const METRICS_POLL_MS = 15 * 60 * 1000;

/** The frequency labels /api/metrics knows about, in the addon's own spelling. */
export function metricsFreqs(payload) {
    const list = payload && payload.freqs;
    if (!Array.isArray(list)) return [];
    return list.map((f) => String(f || '').trim()).filter(Boolean);
}

// Where the choice of what to show is kept. Per browser rather than per session: an
// operator who cares about 490 kHz cares about it tomorrow as well.
export const PICK_KEY = 'ubersdr.v2.navtex.pick';

// The choice that means "whichever frequency spoke most recently", which is the right
// default: a receiver watching two frequencies is watching for whatever arrives.
export const PICK_LATEST = 'latest';

export function savedPick() {
    try { return localStorage.getItem(PICK_KEY) || PICK_LATEST; } catch (e) { return PICK_LATEST; }
}

export function savePick(value) {
    try { localStorage.setItem(PICK_KEY, value || PICK_LATEST); } catch (e) { /* private mode */ }
    return value || PICK_LATEST;
}

/**
 * One message, in the shape the panel uses.
 *
 * `at` is epoch ms from the addon's ISO timestamp — when the end-of-message marker was
 * received, not when the broadcast started, which is the honest answer to "how old is
 * this" for something that takes four minutes to send.
 */
export function normaliseMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const freq = String(raw.freq || '').trim();
    const text = String(raw.text || '').trim();
    if (!freq || !text) return null;
    const at = Date.parse(raw.timestamp);
    const snr = raw.snr_db == null ? null : Number(raw.snr_db);
    const station = String(raw.station || '').toUpperCase().slice(0, 1);
    const subject = String(raw.subject || '').toUpperCase().slice(0, 1);
    return {
        freq,
        // The label the picker shows: "518 kHz" is two words wider than a chip has, and
        // the unit is the same on every one of them.
        short: freq.replace(/\s*kHz\s*$/i, ''),
        station,
        subject,
        serial: raw.serial == null ? null : Number(raw.serial),
        // B1B2B3B4 as an operator writes it — the four characters that identify a
        // NAVTEX message, and the thing you would quote when asking whether somebody
        // else copied it.
        id: `${station || '?'}${subject || '?'}${raw.serial == null ? '' : String(raw.serial).padStart(2, '0')}`,
        at: Number.isFinite(at) ? at : 0,
        snr: Number.isFinite(snr) ? snr : null,
        text,
    };
}

/**
 * The newest message on each frequency, newest frequency first.
 *
 * The addon keys its store by frequency *and* station *and* subject, so a busy 518 kHz
 * comes back as half a dozen entries — one per transmitter and message type it has
 * heard. A panel showing "the latest on 518" means the newest of those, and a panel
 * that showed all of them would be the addon's own page in a column three inches wide.
 */
export function latestPerFreq(rows) {
    const best = new Map();
    for (const raw of rows || []) {
        const m = normaliseMessage(raw);
        if (!m) continue;
        const had = best.get(m.freq);
        if (!had || m.at > had.at) best.set(m.freq, m);
    }
    return [...best.values()].sort((a, b) => b.at - a.at);
}

/**
 * What the picker offers: "Latest", then one chip per frequency.
 *
 * Both sources go in — what is in memory now, and what the logs remember — so a
 * frequency that has been silent since the addon started is still something you can ask
 * for. See the note above metricsUrl for why that takes two endpoints and still is not
 * quite "configured".
 *
 * Ordered by frequency, not by recency: the newest-first ordering is right for choosing
 * what to *show* and wrong for a control somebody is aiming at, because chips that
 * reshuffle when a message lands are chips you press by mistake.
 */
export function pickOptions(list, known = []) {
    const seen = new Map();
    for (const m of list) seen.set(m.freq, shortFreq(m.freq));
    for (const f of known) if (!seen.has(f)) seen.set(f, shortFreq(f));
    const freqs = [...seen.entries()]
        .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0));
    return [
        { value: PICK_LATEST, label: 'Latest' },
        ...freqs.map(([value, label]) => ({ value, label })),
    ];
}

/** "518 kHz" as a chip wears it. The unit is the same on every one of them. */
export const shortFreq = (freq) => String(freq || '').replace(/\s*kHz\s*$/i, '').trim();

/**
 * The message to show, given the choice.
 *
 * Three cases, and the middle one is the reason this takes the frequency list as well:
 *
 *   The chosen frequency has a message — show it, however old, even if the other
 *   frequency spoke a minute ago. That is what choosing it meant.
 *
 *   The chosen frequency is one the panel knows about but has nothing yet — show
 *   nothing, and let the panel say so by name. Falling back here would put another
 *   frequency's message under a chip reading 490, which is worse than an empty panel:
 *   a NAVTEX message is only meaningful with its frequency attached.
 *
 *   The chosen frequency is not in the list at all — the addon reconfigured, or a saved
 *   choice from another receiver — fall back to the newest anything. The picker will
 *   have dropped that chip already, so the fallback is also what the control says.
 */
export function chosenMessage(list, pick, known = null) {
    if (pick && pick !== PICK_LATEST) {
        const hit = list.find((m) => m.freq === pick);
        if (hit) return hit;
        if (known && known.includes(pick)) return null;
    }
    // The list is newest first.
    return list[0] || null;
}

/**
 * The message body, without the framing an operator does not need to read.
 *
 * A NAVTEX message arrives as ZCZC, the four-character identifier, the text, then NNNN.
 * The first two are already in the panel's header and the last is punctuation, so the
 * body is what is left — but only when the markers are actually there: a message the
 * decoder caught mid-transmission has no ZCZC, and cutting the first line off that
 * would be throwing away the part that survived.
 */
export function messageBody(text) {
    let out = String(text || '').trim();
    out = out.replace(/^ZCZC\s*[A-Z0-9]{0,4}\s*/i, '');
    out = out.replace(/\s*NNNN\s*$/i, '');
    return out.trim();
}
