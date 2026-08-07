// The callsign announcer: a lookup, said out loud — in Morse, or in words.
//
// It is a small thing, and it is not decoration. A callsign heard as rhythm is the
// form a CW operator already knows it in — a lookup you can read *and* hear is one you
// recognise the next time it comes back on the band, which is the whole point of
// looking it up. It is also the cheapest possible ear training: real callsigns, at your
// own speed, while you were going to be reading the panel anyway. Spoken, it is a
// different use: the answer without having to look, for somebody logging by hand or
// working across the room from the screen.
//
// One or the other, never both. Two voices reading the same callsign over each other
// is worse than either, and there is no sensible thing to do about which goes first.
// Off is the default, because a receiver that starts making noises at somebody who
// clicked a spot has misjudged what they asked for.
//
// One player and one set of settings for the page, not one per panel. The callsign
// panel can be mounted twice — a floating copy, the mobile sheet — and both answer the
// same lookup request, so a player per mount would send every call twice, out of step
// with itself. See the dedupe in announceCall.
//
// Named callAnnounce* rather than announce*: lib/announce.js is the *receiver's*
// announcer, the one that reads out frequency and mode, and it already owns those
// names. This borrows its voice and its speaking rate — there is one place to choose
// how the receiver talks — but nothing else.

import { announceSettings, speak, speechAvailable, stopSpeaking } from './announce.js';
import { unitMs, unitsFor } from './morse.js';
import { clampPitch, clampWpm, createSidetone } from './morseTone.js';

const KEY = 'ubersdr.v2.callsign.announce';

// The three states of the one control. Strings rather than two booleans, because two
// booleans have four states and one of them is a bug.
export const CALL_OFF = 'off';
export const CALL_CW = 'cw';
export const CALL_TTS = 'tts';
export const CALL_MODES = [CALL_OFF, CALL_CW, CALL_TTS];

const DEFAULTS = { mode: CALL_OFF, pitch: 600, wpm: 15 };

// The NATO alphabet, which is what a callsign is spoken as. "G0RDH" handed to a speech
// engine as a word is noise; handed to it as letters it is a stream of "gee" and "dee"
// that a listener has to disambiguate — the phonetics exist precisely because that
// distinction matters over a bad channel, and a synthetic voice is a bad channel.
export const PHONETIC = {
    'A': 'Alpha', 'B': 'Bravo', 'C': 'Charlie', 'D': 'Delta', 'E': 'Echo',
    'F': 'Foxtrot', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett',
    'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar',
    'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango',
    'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee',
    'Z': 'Zulu',
    '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
    '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine',
    '/': 'stroke',      // as it is said on air: "G0RDH stroke P"
};

/** A callsign as it would be said on air. Anything unspoken is dropped. */
export function phonetic(text) {
    return [...String(text || '').toUpperCase()]
        .map((ch) => PHONETIC[ch])
        .filter(Boolean)
        .join(' ');
}

// Roughly how long a spoken word takes, for the dedupe window only. Speech synthesis
// will not say how long an utterance is until it has finished saying it, and the window
// only has to be about right: too short and two panels double up, too long and a
// deliberate repeat is dropped.
export const TTS_WORD_MS = 550;

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
            mode: CALL_MODES.includes(saved.mode) ? saved.mode : CALL_OFF,
            pitch: clampPitch(saved.pitch),
            wpm: clampWpm(saved.wpm),
        };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

let settings = load();
const listeners = new Set();

// Made on the first announcement rather than here: an AudioContext created outside a
// user gesture starts suspended, and most page loads never announce anything.
let player = null;
// What is being said, and when it will have finished. Both only for the dedupe.
let saying = '';
let until = 0;

export const callAnnounceSettings = () => settings;

export function onCallAnnounce(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Stop, mid-character or mid-word. Both paths, whichever is going. */
export function stopCallAnnounce() {
    if (player) player.stop();
    stopSpeaking();
    saying = '';
    until = 0;
}

export function setCallAnnounce(patch) {
    const wanted = patch.mode === undefined ? settings.mode : patch.mode;
    settings = {
        mode: CALL_MODES.includes(wanted) ? wanted : CALL_OFF,
        pitch: clampPitch(patch.pitch === undefined ? settings.pitch : patch.pitch),
        wpm: clampWpm(patch.wpm === undefined ? settings.wpm : patch.wpm),
    };
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
    // Any change stops what is in the air — switching off obviously, but switching
    // *between* the two as well: the Morse of the last callsign finishing under the
    // spoken version of it is nobody's intention.
    stopCallAnnounce();
    listeners.forEach((fn) => fn(settings));
    return settings;
}

/**
 * Announce a callsign, replacing anything already going out.
 *
 * A new lookup cuts the old one off. That is not merely tidy: two callsigns run
 * together are one long meaningless string, and the one that matters is the one just
 * asked for. Every route into the panel comes through here, so "stop the last one"
 * lives here rather than at each of them.
 *
 * Nothing is decided about *whether* the callsign is real — that is lookup data, and
 * the caller has it. See identified() in lib/callsign.js.
 *
 * Returns roughly how long it will take, in milliseconds: exact for Morse, where the
 * character table decides, and an estimate for speech, which will not say. Zero means
 * nothing was sent.
 */
export function announceCall(call) {
    const text = String(call || '').trim().toUpperCase();
    if (settings.mode === CALL_OFF || !text) return 0;

    // Already going out. Two mounted copies of the panel both answer the same lookup
    // request, and the second restarting the first would stutter the opening dit. A
    // call asked for again *after* it has finished does go again: pressing the same
    // spot twice is a fair way to say "once more".
    if (text === saying && Date.now() < until) return 0;

    let ms = 0;
    if (settings.mode === CALL_TTS) {
        const words = phonetic(text);
        if (!words) return 0;
        // A voice the browser has not got is silence, and silence is indistinguishable
        // from the feature being off — so nothing is recorded as being said.
        if (!speak(words, { rate: announceSettings().rate })) return 0;
        ms = words.split(' ').length * TTS_WORD_MS;
    } else {
        ms = unitsFor(text) * unitMs(settings.wpm);
        if (!player) player = createSidetone();
        player.stop();
        player.send(text, settings);
    }

    saying = text;
    until = Date.now() + ms;
    return ms;
}

/** Whether speech is an option on this browser at all. */
export const callTtsAvailable = () => speechAvailable();

/** What is being announced right now, if anything. */
export function announcingCall() {
    return Date.now() < until ? saying : '';
}

/** Test seam: back to a page that has never announced anything. */
export function _resetAnnounce() {
    settings = { ...DEFAULTS };
    stopCallAnnounce();
    player = null;
    listeners.clear();
}
