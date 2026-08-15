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

// Google's and Microsoft's English voices where there are any, and the
// system's English voices where there are not.
//
// v1 took only the first group, having found the rest unintelligible for
// reading numbers aloud, and where a Google or Microsoft voice exists that is
// still exactly what this returns — a browser that has them is unaffected by
// the fallback below.
//
// But "the rest" is not always worse than nothing, and under Electron it is
// all there is: those voices come from Chrome's own bundled TTS component and
// from Windows, and the desktop client has neither. Its voices are the
// system's, which on Linux means speech-dispatcher's — so the original rule
// left the announcements and the callsign readout permanently silent there
// rather than merely plainer. Silence is indistinguishable from the feature
// being broken, which is the failure this file avoids everywhere else.
//
// The variants are dropped with them: espeak-ng publishes every accent again
// once per modified voice ("English (Great Britain)+Adam"), which is 800-odd
// entries for eight distinct voices and a picker nobody can use.
export function usableVoices(voices) {
    const english = (voices || []).filter(
        (v) => v.lang && v.lang.toLowerCase().startsWith('en'),
    );
    const branded = english.filter((v) => {
        const n = v.name.toLowerCase();
        return n.includes('google') || n.includes('microsoft');
    });
    return branded.length ? branded : english.filter((v) => !v.name.includes('+'));
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
        // Nothing branded, so this is the system's own — keep v1's preference
        // for British English over American, which is what the chain above
        // reaches for first when it has the choice. Only ever reached on the
        // fallback list; a branded list has matched by now.
        || usable.find((v) => (v.lang || '').toLowerCase() === 'en-gb')
        || usable.find((v) => (v.lang || '').toLowerCase().startsWith('en-gb'))
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

// A host that has said its own speech is fit for this.
//
// The rule above is about voices, and it reads them off the user agent because
// in a browser that is the only thing there is to read. Inside one of UberSDR's
// own apps there is something better: the client knows what engine its speech
// actually reaches — Android's TextToSpeech, iOS's AVSpeechSynthesizer — and
// says so. See clients/capacitor/src/receiver.js.
//
// Without this the iOS app fails the user-agent test and is told to use Chrome,
// on a device where Chrome is the same WebKit wearing a different badge, and
// while the callsign readout in the next panel along is speaking perfectly well
// through the very engine being refused.
function hostSpeech() {
    try {
        return !!(typeof window !== 'undefined' && window.ubersdrDesktop && window.ubersdrDesktop.speech);
    } catch (e) {
        return false;
    }
}

/** Can this page speak, and with voices worth hearing numbers from? */
export function speechUsable() {
    return speechAvailable() && (hostSpeech() || chromiumSpeech());
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
 *
 * `voiceName` is for a caller with its own voice preference — the callsign
 * announcer, which picks a voice separately from the receiver's own
 * announcements. A name that is not installed falls back to the automatic
 * choice rather than to silence, for the same reason currentVoice() does: an
 * utterance nobody hears is indistinguishable from the feature being off.
 */
export function speak(text, { rate = 1, voiceName = '' } = {}) {
    if (!text || !speechAvailable()) return false;
    let v = null;
    if (voiceName) {
        v = usableVoices(window.speechSynthesis.getVoices())
            .find((cand) => cand.name === voiceName) || null;
    }
    if (!v) v = currentVoice();
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
