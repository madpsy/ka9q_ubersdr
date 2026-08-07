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
 * What the picker offers: "Latest", then one entry per frequency.
 *
 * Built from what has actually been received rather than from a list of NAVTEX
 * frequencies, because the operator configures which ones the addon watches and a
 * receiver on one frequency should not be offered a chip for the other. Frequencies are
 * ordered by number so the chips do not reshuffle themselves as messages arrive — the
 * newest-first ordering is right for choosing what to *show* and wrong for a control
 * somebody is aiming at.
 */
export function pickOptions(list) {
    const freqs = [...list].sort((a, b) => (Number(a.short) || 0) - (Number(b.short) || 0));
    return [
        { value: PICK_LATEST, label: 'Latest' },
        ...freqs.map((m) => ({ value: m.freq, label: m.short })),
    ];
}

/**
 * The message to show, given the choice.
 *
 * A frequency that has been chosen and then stops being received — the addon
 * reconfigured, or a receiver restarted with one channel — falls back to the newest
 * anything rather than showing an empty panel about a frequency that is no longer
 * there. The picker will have dropped the chip by then, so the fallback is also what
 * the control on screen says.
 */
export function chosenMessage(list, pick) {
    if (!list.length) return null;
    if (pick && pick !== PICK_LATEST) {
        const hit = list.find((m) => m.freq === pick);
        if (hit) return hit;
    }
    // The list is newest first.
    return list[0];
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
