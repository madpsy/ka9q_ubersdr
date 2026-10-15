// Speech-to-text on the device: recogniser results as the server's segments.
//
// The transcript (./frames.js) is built from WhisperLive's segments —
// `{text, start, end, completed}`, the last one provisional and rewritten in
// place until it settles. An on-device recogniser speaks a different dialect
// of the same idea: Web Speech and the native APIs both report *interim*
// results, the hypothesis for the utterance in progress, revised as more audio
// arrives, and then one *final* result when the speaker pauses. That is the
// provisional line and the settled line under other names, so rather than a
// second transcript model this turns one into the other and hands the result
// to applySegments unchanged — everything downstream of it (the console, the
// caption, the clipboard, the file, reading aloud) then cannot tell which
// source it is looking at.
//
// What has to be supplied here, because the recognisers do not say it:
//
//   * **Times.** A result carries no timestamps. The utterance is taken to
//     start when its first interim arrived and to end at the latest result;
//     both are seconds since the engine started, the same clock a server
//     segment's `start` is on, so applySegments' `base` means the same thing.
//   * **A sentence end.** Recognisers on a device mostly do not punctuate, and
//     reading aloud waits for a terminator before it speaks (see
//     bufferSpeech) — so unpunctuated text would sit in the buffer until four
//     hundred characters had piled up. A final result *is* a pause, which is
//     the best evidence of a sentence end there is, so one that does not end
//     in a terminator is given one, in the script's own form where it has one.
//   * **The lost interim.** A recogniser that is stopped, restarted or
//     aborted mid-utterance never sends the final for it, and the live line
//     would stay on screen for ever. flushLocal settles it as it stood.

import { extractSentences } from './speech.js';

export const LOCAL_EMPTY = { start: null, text: '' };

// The full stop in the scripts that have their own. Anything not here takes
// '.', which every script in ./languages.js tolerates.
const STOPS = { zh: '。', ja: '。', hi: '।', bn: '।', ur: '۔', hy: '։', am: '።', my: '။', th: '' };

const primary = (lang) => String(lang || '').toLowerCase().split(/[-_]/)[0];

/**
 * `text` ending in a terminator, adding the language's own if it has none.
 *
 * Thai is left alone: it has no sentence-final mark at all, and a Latin full
 * stop in the middle of Thai text is wrong rather than merely odd. It is read
 * out through FLUSH_AT instead.
 */
export function finishSentence(text, lang) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return s;
    // A closing quote or bracket after the stop still ends the sentence.
    if (!extractSentences(s.replace(/["'\u201d\u2019\u00bb)\]]+$/, '')).remainder) return s;
    const code = primary(lang);
    const stop = code in STOPS ? STOPS[code] : '.';
    return stop ? s + stop : s;
}

const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

/**
 * Fold one recogniser result into the utterance in progress.
 *
 * `result` is `{text, final}`; `t` is seconds since the engine started. Returns
 * `{state, segments}`, where `segments` is what to pass to applySegments: one
 * provisional segment for an interim result, one completed segment for a
 * final, or nothing at all.
 *
 * Two cases make "nothing" the answer, and both are worth knowing about:
 *
 *   * An **empty interim** — recognisers send them between words. Drawing it
 *     would blank the live line under the reader's eyes; it is the same
 *     utterance, so the line stays as it was.
 *   * An **empty final** with nothing pending. With something pending, an
 *     empty final settles that instead: Chrome finishes some utterances with a
 *     final whose text is empty, having already said everything in the
 *     interims, and dropping it would lose the sentence.
 */
export function foldResult(state, result, t, { lang } = {}) {
    const st = state || LOCAL_EMPTY;
    const text = clean(result && result.text);
    const at = Number.isFinite(t) ? t : 0;
    const start = st.start == null ? at : st.start;

    if (!(result && result.final)) {
        if (!text) return { state: st, segments: [] };
        return {
            state: { start, text },
            segments: [{ text, start, end: at, completed: false }],
        };
    }

    const said = text || st.text;
    if (!said) return { state: LOCAL_EMPTY, segments: [] };
    return {
        state: LOCAL_EMPTY,
        segments: [{ text: finishSentence(said, lang), start, end: at, completed: true }],
    };
}

/**
 * Settle whatever interim is outstanding — the recogniser has stopped, been
 * restarted or been reset, and the final it would have sent is never coming.
 */
export function flushLocal(state, t, opts) {
    const st = state || LOCAL_EMPTY;
    if (!st.text) return { state: LOCAL_EMPTY, segments: [] };
    return foldResult(st, { text: '', final: true }, t, opts);
}

/**
 * The utterance in progress as a provisional segment, or null.
 *
 * For a settled line that arrives late — one that went away to be translated
 * while the next utterance started. applySegments clears the live line when a
 * batch settles something without carrying a provisional segment after it, so
 * a translated line applied on its own would wipe the line now being spoken;
 * appending this keeps it.
 */
export function liveSegment(state, t) {
    const st = state || LOCAL_EMPTY;
    if (!st.text) return null;
    return { text: st.text, start: st.start, end: Number.isFinite(t) ? t : st.start, completed: false };
}
