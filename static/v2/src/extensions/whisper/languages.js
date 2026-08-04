// The languages the transcription can be delivered in.
//
// This is *not* the recognition language. Whisper is run in translate mode and
// answers in English; the `language` attach parameter picks what the server then
// runs that English through LibreTranslate into, and leaving it at English means
// no translation happens at all. The recognition language is `asr_language`,
// which the operator pins in config.yaml and which the frontend may only set
// when whisper.allow_client_params is on — so it is not offered here.
//
// The list mirrors static/languages.js, which v1 fetched and `eval`'d at
// runtime. It is a bare `const` with no export, so there is nothing to import;
// copying it is the alternative to evaluating a script for a fixed list of
// forty-eight strings. If LibreTranslate gains a language, both files change.

export const LANGUAGES = [
    { code: 'sq', name: 'Albanian' },
    { code: 'ar', name: 'Arabic' },
    { code: 'az', name: 'Azerbaijani' },
    { code: 'eu', name: 'Basque' },
    { code: 'bn', name: 'Bengali' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'ca', name: 'Catalan' },
    { code: 'zh', name: 'Chinese' },
    { code: 'zt', name: 'Chinese (traditional)' },
    { code: 'cs', name: 'Czech' },
    { code: 'da', name: 'Danish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'en', name: 'English' },
    { code: 'eo', name: 'Esperanto' },
    { code: 'et', name: 'Estonian' },
    { code: 'fi', name: 'Finnish' },
    { code: 'fr', name: 'French' },
    { code: 'gl', name: 'Galician' },
    { code: 'de', name: 'German' },
    { code: 'el', name: 'Greek' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hi', name: 'Hindi' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'id', name: 'Indonesian' },
    { code: 'ga', name: 'Irish' },
    { code: 'it', name: 'Italian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'ky', name: 'Kyrgyz' },
    { code: 'lv', name: 'Latvian' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'ms', name: 'Malay' },
    { code: 'nb', name: 'Norwegian' },
    { code: 'fa', name: 'Persian' },
    { code: 'pl', name: 'Polish' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'pb', name: 'Portuguese (Brazil)' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ru', name: 'Russian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'sl', name: 'Slovenian' },
    { code: 'es', name: 'Spanish' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tl', name: 'Tagalog' },
    { code: 'th', name: 'Thai' },
    { code: 'tr', name: 'Turkish' },
    { code: 'uk', name: 'Ukranian' },
    { code: 'ur', name: 'Urdu' },
    { code: 'vi', name: 'Vietnamese' },
];

// Alphabetical, as v1 sorted the menu. The list above is kept in the source
// file's order so the two can be compared line for line.
export const LANGUAGE_MENU = LANGUAGES.slice().sort((a, b) => a.name.localeCompare(b.name));

const BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.name]));

/**
 * A language code as a name, for the detected-language readout.
 *
 * The code comes from Whisper rather than from the list above, so it may well be
 * one LibreTranslate does not offer — a code we cannot name is shown as itself
 * rather than hidden, since "detected: yue" is still an answer.
 */
export function languageName(code) {
    const c = String(code || '').toLowerCase();
    return BY_CODE[c] || c.toUpperCase();
}
