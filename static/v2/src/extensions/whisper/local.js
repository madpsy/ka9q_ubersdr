// Speech-to-text on the device: the decisions, kept apart from the engines.
//
// The extension can transcribe in two places. "Server" is what it always did —
// the receiver streams the session's audio to WhisperLive. "On this device"
// runs a recogniser in the browser (Web Speech, on-device only) or in the host
// app (Android's and Apple's own speech APIs), fed from the receiver's audio
// rather than the microphone. See ./engines/.
//
// Local is the default wherever it works. It costs the receiver nothing — a
// WhisperLive slot is a GPU's worth of work per listener, and an operator who
// has one has a handful — and it keeps working on a receiver that has no
// transcriber configured at all. Server stays one click away, because it is
// still the better transcriber: Whisper copes with a weak, noisy signal far
// better than a phone's dictation model, which was trained on a near-field
// microphone.
//
// Everything in this file is a decision with no side effects, so each can be
// tested without a browser: which source to use, what a recogniser's error
// means and whether to retry it, when to give up restarting, when to warn that
// a running recogniser has gone quiet, which spoken language to start with,
// and whether translation is needed at all.

import { LANGUAGES } from './languages.js';

export const SOURCE_LOCAL = 'local';
export const SOURCE_SERVER = 'server';

const SOURCE_KEY = 'ubersdr.v2.stt.source';

/** The source the user last chose by hand, or null. */
export function loadSource() {
    try {
        const v = localStorage.getItem(SOURCE_KEY);
        return v === SOURCE_LOCAL || v === SOURCE_SERVER ? v : null;
    } catch (e) {
        return null;
    }
}

/** Remember an explicit choice. Only ever called from the selector itself. */
export function saveSource(source) {
    try {
        if (source === SOURCE_LOCAL || source === SOURCE_SERVER) localStorage.setItem(SOURCE_KEY, source);
    } catch (e) { /* private mode */ }
}

export const LOCAL_UNSUPPORTED = 'Not supported in this browser';
// The recogniser exists, but asked about every language it answered
// "unavailable" — so it is there and can do nothing.
export const LOCAL_NO_LANGUAGES = 'No languages can be recognised on this device';

/**
 * Which source to run, and what the selector offers.
 *
 * Returns `{source, options}`. `source` is 'local', 'server', or null when
 * neither is possible (the extension is not offered at all then, as before).
 * `options` is the selector's list, `{value, label, disabled, reason}` each:
 *
 *   * both possible: both offered; a saved choice is honoured, otherwise local.
 *   * server only: server is used, and local is still *shown* — disabled, with
 *     the reason — so a user who has read that this can run on the device
 *     finds out why it does not here instead of finding nothing.
 *   * local only: local alone — one option, which the selector can take as
 *     "nothing to choose" and not draw.
 *
 * A saved choice that is no longer possible — server picked on a receiver
 * whose operator has since switched the transcriber off — falls back without
 * being forgotten, so it applies again where it can.
 *
 * `localDefault: false` keeps local on offer but not the default where the
 * server is there: the browser's own Whisper before a model has been
 * downloaded, which would otherwise greet everybody on a receiver with a
 * transcriber with a failure until they found the Download button. Choosing
 * local by hand still sticks.
 */
export function pickSource({ localAvailable, serverEnabled, saved, localReason, localDefault = true } = {}) {
    const local = !!localAvailable;
    const server = !!serverEnabled;
    if (!local && !server) return { source: null, options: [] };

    const options = [{
        value: SOURCE_LOCAL,
        label: 'On this device',
        disabled: !local,
        reason: local ? '' : (localReason || LOCAL_UNSUPPORTED),
    }];
    if (!server) return { source: SOURCE_LOCAL, options };
    options.push({ value: SOURCE_SERVER, label: 'Server', disabled: false, reason: '' });

    let source = local && localDefault ? SOURCE_LOCAL : SOURCE_SERVER;
    if (saved === SOURCE_SERVER) source = SOURCE_SERVER;
    else if (saved === SOURCE_LOCAL && local) source = SOURCE_LOCAL;
    return { source, options };
}

/** "on this device" / "on the server", for the status label and its tooltip. */
export function sourcePhrase(source) {
    return source === SOURCE_LOCAL ? 'on this device' : 'on the server';
}

// ---- errors --------------------------------------------------------------
//
// One table for both engines. The Web Speech codes are the spec's
// (SpeechRecognitionErrorCode); the rest are this extension's own, raised by
// the engines for failures that happen before a recogniser exists, and a host
// app may raise any of them too. Every entry says three things: what to tell
// the user, whether to retry quietly first, and whether it is the end.
//
// `action` is what the note can offer besides "Use server instead": 'install'
// where the language pack can be downloaded, 'permission' where the fix is in
// the browser's site settings or the device's own.
//
// Some failures are fixed in a different place inside an app than in a
// browser, so an entry may carry `app`, the wording for the host engine: an
// app has no address bar and no site settings, and telling someone to look
// for them is worse than saying nothing. And a language failure is about one
// language in particular, so `named` puts its name into the sentence where
// the engine knows it.

const PERMISSION_HOW = 'Allow speech recognition for this site in the browser\'s site settings (the icon at the left of the address bar), then press Start again.';
const PERMISSION_HOW_APP = 'Allow speech recognition (and the microphone, which some systems ask for with it) for UberSDR in this device\'s settings — on Android under Apps › UberSDR › Permissions, on iPhone, iPad and Mac under Privacy & Security — then press Start again.';

const ERRORS = {
    // Web Speech. Quiet retries first: a broadcast has gaps, and Chrome ends a
    // session that has heard nothing for a few seconds with `no-speech`.
    'no-speech': { message: 'No speech heard.', retryable: true },
    aborted: { message: 'Recognition was interrupted.', retryable: true },
    'audio-capture': { message: 'The recogniser lost the receiver\'s audio.', retryable: true },
    // On-device recognition needs no network, but the browser can still route
    // a control message through a service that blips.
    network: { message: 'The speech service dropped its connection.', retryable: true },
    'not-allowed': {
        message: `The browser refused speech recognition for this page. ${PERMISSION_HOW}`,
        app: `This app isn't allowed to recognise speech. ${PERMISSION_HOW_APP}`,
        fatal: true,
        action: 'permission',
    },
    // The spec raises this one when processLocally is set and the device
    // cannot recognise the language locally, as well as for policy refusals —
    // so the note has to cover both.
    'service-not-allowed': {
        message: `On-device recognition was refused — either the language is not installed on this device, or the browser has turned on-device recognition off. ${PERMISSION_HOW}`,
        app: `On-device recognition was refused — either the language is not installed on this device, or this app is not allowed to use it. ${PERMISSION_HOW_APP}`,
        fatal: true,
        action: 'permission',
    },
    // What Chrome actually raises for a missing language pack, whatever the
    // spec says.
    'language-not-supported': {
        message: 'This language is not available for on-device recognition.',
        named: (name) => `${name} is not available for on-device recognition.`,
        fatal: true,
        action: 'install',
    },
    'phrases-not-supported': { message: 'The recogniser rejected its settings.', fatal: true },
    'bad-grammar': { message: 'The recogniser rejected its settings.', fatal: true },

    // This extension's own.
    unsupported: {
        message: 'This browser can\'t transcribe on the device.',
        app: 'This app can\'t transcribe on the device.',
        fatal: true,
    },
    'language-unavailable': {
        message: 'This language is not available for on-device recognition here.',
        named: (name) => `${name} is not available for on-device recognition here. Choose another spoken language.`,
        fatal: true,
    },
    'language-downloadable': {
        message: 'This language needs a one-off download before it can be recognised on this device.',
        named: (name) => `${name} needs a one-off download before it can be recognised on this device.`,
        fatal: true,
        action: 'install',
    },
    'language-downloading': {
        message: 'This language is still downloading. Press Start again when it has finished.',
        named: (name) => `${name} is still downloading. Press Start again when it has finished.`,
        fatal: true,
    },
    // No spoken language at all: the device answered, and every answer was
    // "unavailable". Said before Start, rather than letting Start fail.
    'no-languages': {
        message: 'This browser has no languages it can recognise on the device.',
        app: 'This app has no languages it can recognise on the device.',
        fatal: true,
    },
    'track-unsupported': {
        message: 'This browser can\'t transcribe receiver audio on-device — it can only listen to a microphone, which is not what is being transcribed.',
        fatal: true,
    },
    'no-audio': { message: 'There is no receiver audio to transcribe yet. Start the receiver first.', fatal: true },
    'start-failed': { message: 'On-device recognition couldn\'t start.', fatal: true },
    'keeps-stopping': {
        message: 'On-device recognition keeps stopping, so it has been switched off. Press Start to try again.',
        fatal: true,
    },
    ended: { message: 'On-device recognition stopped.', retryable: true },
    'translate-failed': { message: 'Translation failed, so lines are shown as spoken.' },
    silent: {
        message: 'On-device recognition is running but hasn\'t produced any text, although there is audio. The language may be wrong, or this device\'s recogniser may not cope with the signal.',
    },
};

/**
 * A recogniser error as `{code, message, retryable, fatal, action}`.
 *
 * `detail` is whatever the engine or host had to add — the exception text for
 * a failed start, the host's own message for a code this table does not know.
 * `kind` is the engine, 'host' or 'browser', and picks the wording where an
 * app and a browser differ; `lang` is the spoken language, named in a
 * language failure. An unknown code is treated as fatal: retrying something
 * nobody understands is how an infinite restart loop starts.
 */
export function describeError(code, detail, { kind = '', lang = '' } = {}) {
    const c = String(code || '');
    const known = ERRORS[c];
    const extra = String(detail == null ? '' : detail).trim();
    if (!known) {
        return {
            code: c || 'error',
            message: extra || 'On-device recognition failed.',
            retryable: false,
            fatal: true,
            action: '',
        };
    }
    let message = kind === 'host' && known.app ? known.app : known.message;
    if (c === 'start-failed' && extra) message = `On-device recognition couldn't start: ${extra}`;
    if (c === 'translate-failed' && extra) message = `Translation isn't working (${extra}), so lines are shown as spoken.`;
    if (known.named && lang) message = known.named(spokenName(lang));
    return {
        code: c,
        message,
        retryable: !!known.retryable,
        fatal: !!known.fatal,
        action: known.action || '',
    };
}

/**
 * The error code for a language whose on-device status is not 'available'.
 */
export function languageError(status) {
    if (status === 'downloadable') return 'language-downloadable';
    if (status === 'downloading') return 'language-downloading';
    return 'language-unavailable';
}

// ---- restarting ------------------------------------------------------------
//
// Recognisers end on their own: Chrome closes a continuous session after a
// stretch of silence, or after a minute or so regardless, and a native one ends
// at every pause. So "ended" is normal and is answered by starting again.
//
// What must not happen is a recogniser that keeps failing being restarted for
// ever, showing nothing. Two things tell a session that was working from one
// that was not:
//
//   * It settled a line. Text is the proof: whatever ended it, it was
//     transcribing, and the count starts again.
//   * It ran a while and ended *cleanly* — no error, or only `no-speech`.
//     That is a quiet frequency at night: no-speech, end, restart, every eight
//     seconds until dawn, and never a reason to give up.
//
// Everything else is a strike: a session that died inside RESTART.minRunMs,
// however it ended, and one that ended on any other error, however long it ran
// — a recogniser whose service drops out four seconds into every session is as
// broken as one that dies at once, it just takes longer to show it. An interim
// alone does not clear the count either: a recogniser that offers a word and
// dies, every time, is not transcribing. Strikes back off, and after
// RESTART.maxStrikes in a row it gives up with "keeps stopping".

export const RESTART = { minRunMs: 3000, maxStrikes: 5, baseMs: 250, maxMs: 8000 };

/**
 * What to do when a recogniser has ended without being asked to.
 *
 * `strikes` is how many failed sessions in a row there have been; `ranMs` how
 * long the session that just ended lasted. `session` says how it went:
 * `error` is the retryable error code it raised on the way out, if any, and
 * `settled` whether it produced a final result. Returns
 * `{strikes, delayMs, giveUp}`.
 */
export function restartPlan(strikes, ranMs, session = {}, opts = RESTART) {
    const { minRunMs, maxStrikes, baseMs, maxMs } = { ...RESTART, ...opts };
    const { error = '', settled = false } = session || {};
    const ranLong = Number.isFinite(ranMs) && ranMs >= minRunMs;
    const clean = !error || error === 'no-speech';
    if (settled || (ranLong && clean)) return { strikes: 0, delayMs: baseMs, giveUp: false };
    const next = (Number.isFinite(strikes) && strikes > 0 ? strikes : 0) + 1;
    if (next > maxStrikes) return { strikes: next, delayMs: 0, giveUp: true };
    return { strikes: next, delayMs: Math.min(maxMs, baseMs * (2 ** next)), giveUp: false };
}

// ---- watchdog --------------------------------------------------------------
//
// The failure the user cannot see: a recogniser that started, raised nothing,
// and is producing nothing. Wrong language, a model that cannot make out SSB
// through the noise, a track the browser accepted and then fed silence from.
// It looks exactly like a quiet frequency — so the evidence has to be that the
// frequency is *not* quiet: sustained audio, for a long time, without even an
// interim hypothesis.
//
// "Audio" is not simply "level above a threshold". With the AGC up, an empty
// band is a steady hiss at a perfectly healthy level, and a recogniser that
// says nothing about hiss is working. Speech is syllabic — its level swings by
// ten or twenty dB several times a second — so a level sample only counts when
// the recent readings span more than WATCHDOG.swingDb. Noise sits within two or
// three; a voice does not.
//
// It is a warning and never a stop: a long stretch of music or a data signal in
// a voice mode would trip it too, and the transcript is not wrong for having
// nothing to say about those.

export const WATCHDOG = {
    thresholdDb: -50,   // dBFS, the AudioLevel meter's scale
    swingDb: 6,         // spread across the recent window that marks speech
    window: 20,         // readings in that window (~2 s at the meter's 100 ms)
    afterMs: 25000,     // speech-like audio, with no text, before warning
    maxStepMs: 1000,    // longest gap one reading may account for
};

export const WATCHDOG_EMPTY = { levels: [], activeMs: 0, lastAt: null, warn: false };

/**
 * Advance the watchdog by one level reading.
 *
 * `levelDb` is the audio level now; `now` is ms; `heard` is true if any result
 * — interim or final — has arrived since the last reading. `armed` is false
 * when the watchdog should not run at all (not decoding, not local, not a
 * voice mode); it resets the count rather than freezing it, so turning it back
 * on does not inherit a half-finished one.
 *
 * Returns the next state; `state.warn` is whether to show the note. A gap
 * between readings longer than `maxStepMs` — a tab in the background, where
 * timers are throttled — is counted as `maxStepMs`, so coming back to a tab
 * after a minute away is not "a minute of audio with no text".
 */
export function watchdogStep(state, { levelDb, now, heard, armed }, opts = WATCHDOG) {
    const o = { ...WATCHDOG, ...opts };
    if (!armed || heard) return { ...WATCHDOG_EMPTY, lastAt: armed ? now : null };
    const st = state || WATCHDOG_EMPTY;

    const level = Number.isFinite(levelDb) ? levelDb : -Infinity;
    const levels = st.levels.concat(level);
    if (levels.length > o.window) levels.splice(0, levels.length - o.window);

    const finite = levels.filter(Number.isFinite);
    const swing = finite.length >= 2 ? Math.max(...finite) - Math.min(...finite) : 0;
    const speechy = level >= o.thresholdDb && swing >= o.swingDb;

    const step = st.lastAt == null ? 0 : Math.max(0, Math.min(o.maxStepMs, now - st.lastAt));
    const activeMs = st.activeMs + (speechy ? step : 0);
    return { levels, activeMs, lastAt: now, warn: st.warn || activeMs >= o.afterMs };
}

// ---- languages -------------------------------------------------------------
//
// Local mode needs the *spoken* language, which server mode never asks for
// (Whisper detects it). On-device models are one per language, so it has to be
// said up front and has to be one the device has.
//
// A browser cannot be asked "which languages can you do?" — only "can you do
// this one?" — so these are the candidates put to it. Full locales, because
// that is what speech recognisers are keyed on: en-US and en-GB are separate
// models, and asking for bare "en" gets whichever one the browser likes.

export const SPOKEN_CANDIDATES = [
    'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN',
    'de-DE', 'fr-FR', 'fr-CA', 'es-ES', 'es-US', 'es-MX', 'it-IT', 'pt-BR', 'pt-PT',
    'nl-NL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'cs-CZ', 'sk-SK',
    'hu-HU', 'ro-RO', 'bg-BG', 'el-GR', 'uk-UA', 'ru-RU', 'tr-TR',
    'he-IL', 'ar-SA', 'fa-IR', 'hi-IN', 'bn-IN', 'ur-PK',
    'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'th-TH', 'vi-VN', 'id-ID', 'ms-MY',
];

const SPOKEN_KEY = 'ubersdr.v2.stt.spoken';

/**
 * The spoken language last chosen by hand, or null. Remembered because it is a
 * fact about what this user listens to, not about the session: someone who
 * follows German broadcasts wants German again tomorrow, and asking the device
 * which languages it has does not say which of them they want.
 */
export function loadSpoken() {
    try {
        const v = localStorage.getItem(SPOKEN_KEY);
        return v && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(v) ? v : null;
    } catch (e) {
        return null;
    }
}

export function saveSpoken(locale) {
    try {
        if (locale) localStorage.setItem(SPOKEN_KEY, String(locale));
    } catch (e) { /* private mode */ }
}

const NAMES = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.name]));

/**
 * A spoken-language locale as a menu label: "English (United Kingdom)".
 *
 * Intl.DisplayNames where it exists, which names every locale properly; the
 * output-language list otherwise, which knows the languages but not regions.
 */
export function spokenName(locale) {
    const tag = String(locale || '');
    try {
        if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
            const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
            if (name && name !== tag) return name;
        }
    } catch (e) { /* not a tag Intl recognises */ }
    const [lang, region] = tag.split(/[-_]/);
    const base = NAMES[String(lang).toLowerCase()] || tag;
    return region ? `${base} (${region.toUpperCase()})` : base;
}

/**
 * Which of `available` to start with: the one asked for if it is there, then
 * the same language in the user's own region, then any variety of it, then
 * English, then whatever is first.
 *
 * `want` is a locale or a bare language ('en'); `userLocale` is
 * navigator.language, which is how an en-GB user gets en-GB rather than en-US
 * when both are installed.
 */
export function closestLanguage(available, want = 'en', userLocale = '') {
    const list = (Array.isArray(available) ? available : []).map(String).filter(Boolean);
    if (!list.length) return null;
    const lower = (s) => s.toLowerCase().replace('_', '-');
    const w = lower(String(want || 'en'));
    const exact = list.find((l) => lower(l) === w);
    if (exact) return exact;
    const lang = w.split('-')[0];
    const region = lower(String(userLocale || '')).split('-')[1];
    const same = list.filter((l) => lower(l).split('-')[0] === lang);
    if (same.length) return bestRegion(same, lang, region);
    const english = list.filter((l) => lower(l).startsWith('en'));
    if (english.length) return bestRegion(english, 'en', region);
    return list[0];
}

// Which of several regions of one language to start on, when the user's own
// is not among them.
//
// Never the list's first: a host's list has no order to speak of — iOS hands
// back SFSpeechRecognizer.supportedLocales(), a Set, and an iPad offered
// English (Indonesia) as the default because it happened to come out first.
// So the user's region, then the one most people speaking the language would
// expect — American for English, the language's own country otherwise
// (de-DE, fr-FR) — and only then alphabetical, so the answer is the same on
// every device that lists the same things.
const HOME_REGION = { en: 'us' };

function bestRegion(candidates, lang, region) {
    const lower = (s) => s.toLowerCase().replace('_', '-');
    const regionOf = (l) => lower(l).split('-')[1];
    for (const want of [region, HOME_REGION[lang], lang]) {
        if (!want) continue;
        const hit = candidates.find((l) => regionOf(l) === want);
        if (hit) return hit;
    }
    return [...candidates].sort((a, b) => lower(a).localeCompare(lower(b)))[0];
}

// ---- translation -----------------------------------------------------------
//
// The output-language menu keeps the meaning it has in server mode: the
// language the transcript is *delivered* in. On the device that means
// translating what the recogniser heard, so its codes (LibreTranslate's, see
// ./languages.js) have to become the BCP-47 tags translators take. Two of them
// are not tags at all.

const LIBRE_TO_BCP47 = { zt: 'zh-Hant', pb: 'pt' };

/** A spoken locale or output-language code as a translator's language tag. */
export function translatorTag(code) {
    const c = String(code || '');
    if (LIBRE_TO_BCP47[c]) return LIBRE_TO_BCP47[c];
    const [lang, region] = c.split(/[-_]/);
    const l = String(lang || '').toLowerCase();
    // Traditional Chinese is its own model; the region is how a spoken locale
    // says which script it is in.
    if (l === 'zh' && region && /^(tw|hk|mo)$/i.test(region)) return 'zh-Hant';
    // Norwegian: recognisers say nb, translators mostly no — and both mean
    // Bokmål.
    if (l === 'no') return 'nb';
    return l;
}

/**
 * `{source, target}` translator tags, or null when the spoken language already
 * is the output language and nothing needs doing.
 */
export function translationPair(spokenLocale, outputCode) {
    const source = translatorTag(spokenLocale);
    const target = translatorTag(outputCode);
    if (!source || !target || source === target) return null;
    return { source, target };
}

// ---- the host's models -----------------------------------------------------
//
// A host may offer more than one model to recognise with — the desktop client
// ships Whisper's base model and can download small — through `stt.models()`
// and its siblings (the contract is in ./engines/host.js). These say how one
// reads in the Model menu, and how far a download has got.

/** "190 MB": a model's size, rounded the way a download page would. */
export function formatModelSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    const mb = n / 1e6;
    if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    return `${mb.toFixed(1)} MB`;
}

/**
 * A model as a menu option: "Base — built in", "Small — 190 MB, not
 * downloaded". The size only for one that is not built in, since it is the
 * download that it describes.
 */
export function modelLabel(m) {
    if (!m) return '';
    const name = String(m.label || m.id || '');
    if (m.builtIn) return `${name} — built in`;
    const size = formatModelSize(m.sizeBytes);
    const parts = [size, m.installed ? '' : 'not downloaded'].filter(Boolean);
    return parts.length ? `${name} — ${parts.join(', ')}` : name;
}

/** A download's progress, `{received, total}`, as a whole percentage. */
export function downloadPercent(p) {
    const received = Number(p && p.received);
    const total = Number(p && p.total);
    if (!(total > 0) || !(received > 0)) return 0;
    return Math.max(0, Math.min(100, Math.floor((received * 100) / total)));
}
