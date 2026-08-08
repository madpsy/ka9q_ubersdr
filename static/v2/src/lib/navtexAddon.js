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

// ── One name per frequency ───────────────────────────────────────────────────
//
// The two sources spell the same frequency differently. /api/latest says "490 kHz" and
// /api/metrics says "490kHz" — verified on a live receiver — so anything that treats the
// string as the frequency's identity ends up believing in two 490s. That is exactly what the
// picker did: four chips reading "Latest 490 490 518 518", two of them the same frequency
// under a different spelling.
//
// So the identity is the number, and every comparison, map key and stored preference uses it.
// The chips show the same string, because "490" is what a chip should read anyway.
/** "518 kHz" as a chip wears it. The unit is the same on every one of them. */
export const shortFreq = (freq) => String(freq || '').replace(/\s*kHz\s*$/i, '').trim();

export function freqKey(freq) {
    const bare = shortFreq(freq);
    const n = Number(bare);
    // Through Number and back, so "490.0 kHz" and "490 kHz" are also one frequency. A label
    // that is not a number at all — a named channel, if the addon ever grows one — is kept
    // as it stands rather than turned into NaN.
    return Number.isFinite(n) && n > 0 ? String(n) : bare;
}

// Where the choice of what to show is kept. Per browser rather than per session: an
// operator who cares about 490 kHz cares about it tomorrow as well.
export const PICK_KEY = 'ubersdr.v2.navtex.pick';

// The choice that means "whichever frequency spoke most recently", which is the right
// default: a receiver watching two frequencies is watching for whatever arrives.
export const PICK_LATEST = 'latest';

export function savedPick() {
    try {
        const raw = localStorage.getItem(PICK_KEY);
        if (!raw || raw === PICK_LATEST) return PICK_LATEST;
        // Normalised on the way out, so a choice stored before frequencies had one canonical
        // name — "490 kHz", as /api/latest spells it — still selects its chip rather than
        // silently falling back to whatever spoke last.
        return freqKey(raw);
    } catch (e) {
        return PICK_LATEST;
    }
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
    const key = freqKey(freq);
    return {
        // As the addon spelled it, kept for the record; `key` is what anything comparing
        // frequencies uses — see freqKey.
        freq,
        key,
        // And the label the picker shows, which is the same string: "518 kHz" is two words
        // wider than a chip has, and the unit is the same on every one of them.
        short: key,
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
        // Keyed by the frequency's canonical name, not the string it arrived as, so two
        // spellings of 490 are one frequency here as everywhere else.
        const had = best.get(m.key);
        if (!had || m.at > had.at) best.set(m.key, m);
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
    // A Set of canonical names, which is what stops the two sources producing a chip each
    // for the same frequency — see freqKey. The value and the label are that same name.
    const seen = new Set();
    for (const m of list) seen.add(m.key);
    for (const f of known) seen.add(freqKey(f));
    const freqs = [...seen].filter(Boolean).sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
    return [
        { value: PICK_LATEST, label: 'Latest' },
        ...freqs.map((f) => ({ value: f, label: f })),
    ];
}


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
        const want = freqKey(pick);
        const hit = list.find((m) => m.key === want);
        if (hit) return hit;
        // `known` comes from the picker, so it is already canonical — but a caller passing
        // the addon's own spelling should not be told a frequency is unknown either.
        if (known && known.some((f) => freqKey(f) === want)) return null;
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
