// Spoken announcements of what the receiver is doing — v1's tts-announcements.js.
//
// For operating without watching the screen: the frequency and the mode read
// out as they change, so the dial can be turned by ear.
//
// What is kept from v1, because it was arrived at by use rather than design:
//
//   * The voice preference chain. Left to itself the browser picks whatever is
//     first, which on Windows is a robotic SAPI voice. The order below prefers
//     the neural online voices, then anything from Google or Microsoft.
//   * A queue rather than overlapping utterances, and the Chromium workaround
//     that goes with it — see speak().
//   * The phrasing. "7.1 megahertz, upper sideband": MHz with the trailing
//     zeros gone, and mode letters spelled out so "usb" is not read as a word.
//
// What is not: v1 announced from six separate call sites — the band buttons,
// the bookmark manager, the extensions, two places in the spectrum, and the
// server echo — each of which had to remember to do it, and which between them
// produced the double-speaking that `announceFrequencyAndMode` exists to work
// around. v2 has one watcher on the tuning state (see AnnounceWatch), so
// nothing has to be told and there is nothing to keep in step.

const STORAGE_KEY = 'ubersdr.v2.announce';

export const DEFAULTS = {
    // Off until asked for. A receiver that starts talking on its own is a
    // receiver someone has to work out how to silence.
    enabled: false,
    frequency: true,
    mode: true,
    rate: 1,
    // Empty means "whichever pickVoice chooses" — see currentVoice. A name is
    // stored rather than an index, because the list is the browser's and its
    // order is not promised to be the same twice.
    voice: '',
};

// How long to wait for a reading to settle before speaking it.
//
// A frequency waits a second because it arrives continuously — a dial being
// turned or a spectrum being dragged is one change per pointer move, and
// announcing them would be a stream of half-spoken numbers. A mode is a
// discrete choice, so it waits only long enough to be joined by a frequency
// that changed with it: tuning to a bookmark sets both, and they belong in one
// sentence rather than two.
export const FREQ_SETTLE_MS = 1000;
export const MODE_SETTLE_MS = 250;

// v1's expansions, plus the modes v2 added. Letters are spaced so they are
// spelled rather than pronounced — "usb" is otherwise read as a word.
const MODE_WORDS = {
    usb: 'upper sideband',
    lsb: 'lower sideband',
    am: 'A M',
    sam: 'synchronous A M',
    fm: 'F M',
    nfm: 'narrow F M',
    cw: 'C W',
    cwu: 'C W upper',
    cwl: 'C W lower',
};

/** "7.1", "14.074", "10.1362" — MHz without the trailing zeros. */
export function speakFrequency(hz) {
    if (!Number.isFinite(hz)) return '';
    // Six decimals is 1 Hz at these frequencies; parseFloat then drops the
    // zeros, so 7100000 is "7.1" rather than "7.100000".
    const mhz = parseFloat((hz / 1e6).toFixed(6)).toString();
    return `${mhz} megahertz`;
}

/** "upper sideband", "C W lower" — or the mode itself if it is not one we know. */
export function speakMode(mode) {
    if (!mode) return '';
    return MODE_WORDS[String(mode).toLowerCase()] || String(mode);
}

/** What to say for a change, or '' when there is nothing to say. */
export function announcement({ frequency, mode }) {
    return [
        frequency != null ? speakFrequency(frequency) : '',
        mode ? speakMode(mode) : '',
    ].filter(Boolean).join(', ');
}

// --- voices -----------------------------------------------------------------

// Only Google's and Microsoft's English voices. v1 refuses everything else and
// says why, having found the rest unintelligible for reading numbers aloud.
export function usableVoices(voices) {
    return (voices || []).filter((v) => {
        if (!v.lang || !v.lang.toLowerCase().startsWith('en')) return false;
        const n = v.name.toLowerCase();
        return n.includes('google') || n.includes('microsoft');
    });
}

/**
 * The best of them, in v1's order of preference.
 *
 * Google UK English Female first because that is what Chrome ships and what
 * this was tuned against; then Microsoft's *online* voices, which are the
 * neural ones and far better than the local SAPI voices carrying the same
 * brand; then anything left.
 */
export function pickVoice(voices) {
    const usable = usableVoices(voices);
    if (!usable.length) return null;
    const is = (v, ...parts) => parts.every((p) => v.name.toLowerCase().includes(p));
    return usable.find((v) => v.name === 'Google UK English Female' && v.lang === 'en-GB')
        || usable.find((v) => v.lang === 'en-GB' && is(v, 'microsoft', 'online'))
        || usable.find((v) => v.lang === 'en-US' && is(v, 'microsoft', 'online'))
        || usable.find((v) => is(v, 'microsoft', 'online'))
        || usable.find((v) => is(v, 'microsoft') && !is(v, 'default'))
        || usable.find((v) => is(v, 'google'))
        || usable[0];
}

export function speechAvailable() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Chrome and Edge only, as v1 has it.
//
// Not gatekeeping for its own sake: the voices this reads numbers with are
// Google's and Microsoft's, and a browser without them falls back to whatever
// the OS ships — on Windows a SAPI voice that renders "7.1 megahertz" as
// something closer to a fax tone. The panel says so rather than offering a
// switch that would produce that.
export function chromiumSpeech(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
    if (/iPhone|iPad|iPod/i.test(ua)) return false;   // WebKit under any badge
    return /Chrome\/|Chromium\/|Edg\//i.test(ua);
}

/** Everything the operator may choose between, best first. */
export function listVoices() {
    if (!speechAvailable()) return [];
    const usable = usableVoices(window.speechSynthesis.getVoices());
    const best = pickVoice(usable);
    // The automatic choice at the top, so the list reads in the order the
    // preference chain would take it rather than the browser's own.
    return best ? [best, ...usable.filter((v) => v !== best)] : usable;
}

// --- settings ---------------------------------------------------------------
//
// Its own store rather than a corner of the display settings: this is not about
// how anything looks, and the panel that edits it is unmounted whenever it is
// collapsed while the watcher that reads it never is.

let current = null;
const listeners = new Set();

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

export function announceSettings() {
    if (!current) current = load();
    return current;
}

export function setAnnounceSettings(patch) {
    current = { ...announceSettings(), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(current);
    return current;
}

export function onAnnounceSettings(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// --- speaking ---------------------------------------------------------------

let voice = null;
let voiceLoaded = false;

/**
 * The voice to speak with: the operator's choice if they made one and it is
 * still there, otherwise the automatic pick.
 *
 * A stored name that has gone — a machine without that voice installed, or an
 * online voice while offline — falls back rather than failing, because silence
 * would be indistinguishable from the feature being off.
 */
export function currentVoice() {
    if (!speechAvailable()) return null;
    if (!voiceLoaded) {
        const list = window.speechSynthesis.getVoices();
        // Chrome populates the list asynchronously and returns [] until it has.
        // Nothing is cached until there is something to cache.
        if (!list.length) return null;
        voice = pickVoice(list);
        voiceLoaded = true;
    }
    const wanted = announceSettings().voice;
    if (wanted) {
        const found = usableVoices(window.speechSynthesis.getVoices())
            .find((v) => v.name === wanted);
        if (found) return found;
    }
    return voice;
}

/** Re-pick after the browser has finished loading its voice list. */
export function refreshVoice() {
    voiceLoaded = false;
    return currentVoice();
}

/**
 * Say something, cancelling whatever was being said.
 *
 * The setTimeout is not a nicety. Chromium drops an utterance passed to speak()
 * in the same synchronous stack as a cancel(), silently — v1 found this the
 * hard way and the comment there is the only reason this one exists.
 */
export function speak(text, { rate = 1 } = {}) {
    if (!text || !speechAvailable()) return false;
    const v = currentVoice();
    if (!v) return false;
    window.speechSynthesis.cancel();
    setTimeout(() => {
        const u = new SpeechSynthesisUtterance(text);
        u.voice = v;
        u.lang = v.lang || 'en-GB';
        u.rate = rate;
        u.volume = 1;
        window.speechSynthesis.speak(u);
    }, 50);
    return true;
}

export function stopSpeaking() {
    if (speechAvailable()) window.speechSynthesis.cancel();
}
