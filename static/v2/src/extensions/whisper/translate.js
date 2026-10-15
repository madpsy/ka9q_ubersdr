// Speech-to-text on the device: translating what was heard.
//
// In server mode the output-language menu sends the transcript through the
// operator's LibreTranslate. Local mode has no server in the loop, so it
// translates on the device too, with whichever translator is there:
//
//   'host'     the app's own, declared as window.ubersdrDesktop.translate (the
//              contract is in ./engines/host.js) — ML Kit on Android, Apple's
//              Translation framework on iOS.
//   'browser'  Chrome's built-in Translator API: `Translator.availability()`,
//              `Translator.create()`, `translator.translate()`. Desktop Chrome
//              only, and it runs on the device.
//
// Only *settled* lines are translated. The live line is rewritten several
// times a second, and translating each revision would queue a translation per
// revision behind a translator that works one request at a time — the live line
// would lag further and further behind the speaker. It is shown as spoken; the
// line is translated once, when it settles.
//
// And a translation failing never stops the transcript. A line that cannot be
// translated is shown as spoken, with a note saying so: the user still has the
// words, which is better than a transcript that stops because a language model
// would not download. That includes a translator that is merely slow, or has
// stopped answering: every line waits on the one before it, so one that never
// comes back would hold up every line after it for good — see LIMITS.

import { describeError } from './local.js';

const theWindow = () => (typeof window !== 'undefined' ? window : {});

const STATUSES = ['available', 'downloadable', 'downloading', 'unavailable'];

// How long a settled line waits before it is shown as spoken instead.
//
//   openMs  for the translator to open, the first time. Opening an installed
//           model is quick; downloading one is minutes, and the transcript
//           cannot stop for that. Only the first line waits: once one has
//           timed out, the rest go straight through as spoken until the
//           translator is open, so lines do not queue up behind the download
//           four seconds apiece.
//   lineMs  for one translation. A translator that has hung is abandoned for
//           that line, and the next is asked afresh.
export const LIMITS = { openMs: 4000, lineMs: 6000 };

const TIMED_OUT = {};

// `p`, or TIMED_OUT if it takes longer than `ms`.
function within(p, ms) {
    let id;
    const late = new Promise((resolve) => { id = setTimeout(() => resolve(TIMED_OUT), ms); });
    return Promise.race([p, late]).finally(() => clearTimeout(id));
}

/** 'host', 'browser' or null: the translator there is, best first. */
export function translatorKind(win = theWindow()) {
    try {
        const d = win && win.ubersdrDesktop;
        const t = d && d.translate;
        if (t && typeof t.translate === 'function') return 'host';
        const T = win && win.Translator;
        if (T && typeof T.create === 'function' && typeof T.availability === 'function') return 'browser';
    } catch (e) { /* treat as none */ }
    return null;
}

/**
 * Whether `pair` ({source, target}, as from ../local.js translationPair) can
 * be translated: 'available' | 'downloadable' | 'downloading' | 'unavailable'.
 * Never rejects.
 */
export async function translationStatus(pair, win = theWindow()) {
    if (!pair) return 'unavailable';
    try {
        const kind = translatorKind(win);
        let v = 'unavailable';
        if (kind === 'host') {
            const t = win.ubersdrDesktop.translate;
            v = typeof t.availability === 'function' ? await t.availability(pair.source, pair.target) : 'available';
        } else if (kind === 'browser') {
            v = await win.Translator.availability({ sourceLanguage: pair.source, targetLanguage: pair.target });
        }
        return STATUSES.includes(v) ? v : 'unavailable';
    } catch (e) {
        return 'unavailable';
    }
}

/**
 * A translator for `pair`, as `{translate(text): Promise<string>, destroy()}`.
 * Rejects if one cannot be made.
 *
 * Chrome's `Translator.create()` may have to download a model first, and the
 * spec allows it to insist on a user gesture for that — so where it matters,
 * call this from the click that started transcribing (createLineTranslator's
 * `prepare`) rather than from the first settled line. `onProgress(0..1)` hears
 * the download, if there is one.
 */
export async function openTranslator(pair, { win = theWindow(), onProgress } = {}) {
    const kind = translatorKind(win);
    if (!pair || !kind) throw new Error('no translator on this device');
    if (kind === 'host') {
        const t = win.ubersdrDesktop.translate;
        // Asked before the first line, not left to the first translation to
        // fail. An app's translator can only use languages already on the
        // device — iOS's cannot fetch them without showing a sheet — and a
        // pair that is not there was reaching the transcript as English with
        // nothing said, which reads as translation being broken rather than
        // as a download nobody has done.
        if (typeof t.availability === 'function') {
            const status = await translationStatus(pair, win);
            if (status === 'unavailable') {
                throw Object.assign(new Error('this language pair is not supported'), { name: 'NotSupportedError' });
            }
            if (status === 'downloadable' || status === 'downloading') {
                // `languages` marks it for the note, which offers the host's
                // page for adding them where there is one (openSettings).
                throw Object.assign(
                    new Error('the translation languages aren\'t on this device yet — add them in the device\'s settings, then press Start again'),
                    { languages: true },
                );
            }
        }
        return {
            translate: (text) => Promise.resolve(t.translate(text, pair.source, pair.target)).then(String),
            destroy() {},
        };
    }
    const translator = await win.Translator.create({
        sourceLanguage: pair.source,
        targetLanguage: pair.target,
        monitor(m) {
            if (!onProgress || !m || typeof m.addEventListener !== 'function') return;
            m.addEventListener('downloadprogress', (e) => onProgress(Number(e && e.loaded) || 0));
        },
    });
    return {
        translate: (text) => translator.translate(text).then(String),
        destroy() {
            try { if (typeof translator.destroy === 'function') translator.destroy(); } catch (e) { /* ignore */ }
        },
    };
}

// Why a translator would not open or translate, in words — the exception
// names the spec uses, rather than their messages, which are written for
// developers.
function reasonOf(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError') return 'the browser wants a click before it downloads a translation model — press Start again';
    if (name === 'NotSupportedError') return 'this language pair is not supported';
    if (name === 'QuotaExceededError') return 'the line was too long';
    if (name === 'OperationError' || name === 'NetworkError') return 'the translation model could not be loaded';
    return (e && e.message) || String(e || 'unknown error');
}

/**
 * Settled lines in, translated lines out, in order, never failing.
 *
 * `translate(text)` resolves to `{text, translated}` — the translation, or the
 * original with `translated: false` if there is none to be had. Requests run
 * one at a time, in the order they were made, so lines settle in the order
 * they were spoken however long each one takes.
 *
 * The translator is opened on first use, or by `prepare()` — call that from
 * the Start click, for the gesture reason in openTranslator. A translator that
 * would not open stays failed until `destroy()`: asking again for every line
 * would retry a download on each one. Neither opening nor translating can hold
 * a line for longer than `limits` (LIMITS) allows.
 *
 * `onNote(error)` hears each failure once — a describeError('translate-failed')
 * object, fatal: false — and again only if the reason changes, so "still
 * loading" can become "could not be loaded"; `onNote(null)` when translation
 * is working again, so the note can be taken down.
 */
export function createLineTranslator({
    pair, win = theWindow(), onNote, onProgress, open = openTranslator, limits = LIMITS,
} = {}) {
    const { openMs, lineMs } = { ...LIMITS, ...limits };
    let opening = null;
    let translator = null;
    let broken = false;
    let waited = false;     // a line has already given up waiting for the open
    let noted = '';         // the reason last reported, '' while working
    let queue = Promise.resolve();
    let destroyed = false;

    const note = (e) => {
        const reason = reasonOf(e);
        if (noted === reason || destroyed) return;
        noted = reason;
        if (onNote) onNote({ ...describeError('translate-failed', reason), fatal: false, languages: !!(e && e.languages) });
    };
    const recovered = () => {
        if (!noted || destroyed) return;
        noted = '';
        if (onNote) onNote(null);
    };

    function prepare() {
        if (!pair) return Promise.resolve(null);
        if (!opening) {
            opening = open(pair, { win, onProgress }).then((t) => {
                if (destroyed) { t.destroy(); return null; }
                translator = t;
                return t;
            }, (e) => {
                broken = true;
                note(e);
                return null;
            });
        }
        return opening;
    }

    function translate(text) {
        const original = String(text == null ? '' : text);
        if (!pair || !original.trim()) return Promise.resolve({ text: original, translated: false });
        const job = queue.then(async () => {
            const asSpoken = { text: original, translated: false };
            if (destroyed) return asSpoken;
            let t = translator;
            if (!t) {
                // Still opening, and a line has already waited for it: this
                // one does not, or every line would.
                if (waited && !broken) return asSpoken;
                t = await within(prepare(), openMs);
                if (t === TIMED_OUT) {
                    waited = true;
                    note({ message: 'the translation model is still loading' });
                    return asSpoken;
                }
            }
            if (!t || broken || destroyed) return asSpoken;
            try {
                const out = await within(Promise.resolve(t.translate(original)), lineMs);
                if (out === TIMED_OUT) {
                    note({ message: 'the translator is not answering' });
                    return asSpoken;
                }
                const text = String(out).trim();
                if (!text) return asSpoken;
                recovered();
                return { text, translated: true };
            } catch (e) {
                note(e);
                return asSpoken;
            }
        });
        queue = job;
        return job;
    }

    function destroy() {
        destroyed = true;
        if (translator) translator.destroy();
        translator = null;
    }

    return { prepare, translate, destroy };
}
