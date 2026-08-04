// Reading the transcript aloud: the parts that are just text handling.
//
// Speaking a live transcript is not "call speak() on each line". Two properties
// of what arrives make a naive version unlistenable, and both are dealt with
// here rather than in the hook, because both are pure string work:
//
//   * **Segments overlap.** WhisperLive re-decodes the tail of its buffer, so a
//     settled segment often begins with the last word or two of the one before
//     it. Spoken as-is you hear "…has been / has been detained".
//   * **Segments are not sentences.** They break wherever the decoder's window
//     ended, so speaking each one separately puts a full stop's worth of pause
//     in the middle of a clause. Text is buffered until it reaches a terminator
//     and only whole sentences are handed to the synthesiser.
//
// The terminator set is deliberately not `[.!?]`: the transcript can be
// delivered in any of the forty-eight languages in ./languages.js, and a
// Chinese, Hindi or Amharic sentence ends in a character that a Western-only
// test never sees — so buffering would never flush and nothing would be spoken
// at all. This is v1's set.

const TERMINATORS = '.!?。！？؟۔;।॥ฯຯໆ։՞՜။၊។៕።፧፨';

export const RATE = { min: 0.5, max: 2, step: 0.1, default: 1 };

/** Whether this browser can speak at all. */
export function speechSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Split off every complete sentence, keeping the unfinished tail.
 *
 * The terminator stays with the sentence it ends — a synthesiser reads "Hello."
 * and "Hello" with different intonation, and the full stop is the only thing
 * telling it which this was.
 */
export function extractSentences(text) {
    const src = String(text == null ? '' : text);
    // Built per call: a `g` regex carries `lastIndex` between calls, and a
    // shared one would start each split wherever the previous one stopped.
    const re = new RegExp(`[^${TERMINATORS}]+[${TERMINATORS}]+`, 'g');
    const sentences = [];
    let match;
    let end = 0;
    while ((match = re.exec(src)) !== null) {
        const s = match[0].trim();
        if (s) sentences.push(s);
        end = re.lastIndex;
    }
    return { sentences, remainder: src.slice(end).trim() };
}

/**
 * `next` with any words it repeats from the end of `existing` taken off.
 *
 * Up to three words, longest overlap first, compared without case — v1's rule.
 * Three is enough for the repetition the decoder's overlapping windows produce
 * and short enough that a genuine repeat ("very, very quiet") survives.
 */
export function removeOverlap(existing, next) {
    const tail = String(existing == null ? '' : existing).trim();
    const head = String(next == null ? '' : next).trim();
    if (!tail || !head) return head;

    const before = tail.split(/\s+/);
    const after = head.split(/\s+/);
    const most = Math.min(3, before.length, after.length);
    for (let n = most; n >= 1; n--) {
        const endOf = before.slice(-n).join(' ').toLowerCase();
        const startOf = after.slice(0, n).join(' ').toLowerCase();
        if (endOf === startOf) return after.slice(n).join(' ');
    }
    return head;
}

// How much unterminated text to hold before speaking it anyway — roughly
// twenty seconds of speech. Waiting for a terminator is the right rule and the
// wrong one to apply without limit: a transcript of a weak signal, or of a
// speaker the decoder never hears a full stop from, would buffer for the whole
// session and never be read out at all. Better a sentence broken in an odd
// place than silence that looks like a broken feature.
export const FLUSH_AT = 400;

/**
 * Add text to the buffer and take out whatever whole sentences that produced.
 *
 * Returns `{ buffer, sentences }`: the tail still waiting for a terminator, and
 * what is ready to be spoken.
 */
export function bufferSpeech(buffer, text) {
    const clean = removeOverlap(buffer, text);
    if (!clean) return { buffer, sentences: [] };
    const joined = buffer ? `${buffer} ${clean}` : clean;
    const { sentences, remainder } = extractSentences(joined);
    if (sentences.length) return { buffer: remainder, sentences };
    if (joined.length >= FLUSH_AT) return { buffer: '', sentences: [joined] };
    return { buffer: joined, sentences: [] };
}

const has = (voice, word) => voice.name.toLowerCase().includes(word);

/**
 * The best voice to start with, out of whatever the browser has installed.
 *
 * v1's order, and it is worth keeping: the difference between a browser's
 * default English voice and its best one is the difference between a 1990s
 * screen reader and something you can listen to for an hour. Chrome ships
 * "Google UK English Female"; Edge's "online" voices are its neural ones and
 * are far better than the local fallbacks it also lists.
 */
export function preferredVoice(voices) {
    const list = Array.isArray(voices) ? voices : [];
    const english = (v) => String(v.lang || '').startsWith('en');
    return list.find((v) => v.name === 'Google UK English Female' && v.lang === 'en-GB')
        || list.find((v) => v.lang === 'en-GB' && has(v, 'microsoft') && has(v, 'online'))
        || list.find((v) => v.lang === 'en-US' && has(v, 'microsoft') && has(v, 'online'))
        || list.find((v) => english(v) && has(v, 'microsoft') && has(v, 'online'))
        || list.find((v) => english(v) && has(v, 'microsoft') && !has(v, 'default'))
        || null;
}

// Whisper and LibreTranslate speak in two-letter codes; the speech API mostly
// names full locales. Only the languages where the obvious guess would be wrong
// or ambiguous need to be here — a code with no entry is matched by prefix.
const LOCALES = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
    pt: 'pt-PT', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN',
    ar: 'ar-SA', hi: 'hi-IN', nl: 'nl-NL', pl: 'pl-PL', tr: 'tr-TR',
    sv: 'sv-SE', da: 'da-DK', no: 'no-NO', nb: 'nb-NO', fi: 'fi-FI',
    cs: 'cs-CZ', el: 'el-GR', he: 'he-IL', hu: 'hu-HU', ro: 'ro-RO',
    sk: 'sk-SK', uk: 'uk-UA', id: 'id-ID', th: 'th-TH', vi: 'vi-VN',
};

/**
 * The voice to read a given language in, or null if the browser has none.
 *
 * Google's and Microsoft's voices first for the same reason as above. Null
 * matters: choosing a wrong-language voice reads the text with the wrong
 * phoneme set, which is worse than the browser's own fallback.
 */
export function voiceForLanguage(voices, code) {
    const list = Array.isArray(voices) ? voices : [];
    const lang = String(code || '').toLowerCase();
    if (!lang) return null;
    const locale = LOCALES[lang] || lang;
    const matching = list.filter((v) => {
        const l = String(v.lang || '').toLowerCase().replace('_', '-');
        return l === locale.toLowerCase() || l.startsWith(`${lang}-`) || l === lang;
    });
    if (!matching.length) return null;
    return matching.find((v) => has(v, 'google'))
        || matching.find((v) => has(v, 'microsoft'))
        || matching[0];
}

/**
 * The voice menu: English first, then everything else, each group by name.
 *
 * Two groups rather than one list per language — a browser may offer a hundred
 * voices, and the receiver's transcript is in English unless the operator or the
 * listener has said otherwise.
 */
export function voiceGroups(voices) {
    const list = Array.isArray(voices) ? voices : [];
    const english = list.filter((v) => String(v.lang || '').startsWith('en'));
    const rest = list.filter((v) => !String(v.lang || '').startsWith('en'));
    const group = (label, items) => ({
        label,
        options: items.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` })),
    });
    const out = [];
    if (english.length) out.push(group('English', english));
    if (rest.length) out.push(group('Other languages', rest));
    return out;
}
