// Spoken announcements: the phrasing and the voice preference chain.
//
// Both are the sort of thing that is only wrong once you hear it — a frequency
// read as "seven point one zero zero zero zero zero", a mode read as a word, or
// the browser's first voice instead of the one v1 spent time choosing. None of
// it throws, so it is pinned here.

const assert = require('assert');
const {
    announcement, chromiumSpeech, pickVoice, speakFrequency, speakMode, usableVoices, DEFAULTS,
} = require('./.build/announce.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const voice = (name, lang) => ({ name, lang });

// --- phrasing ----------------------------------------------------------------

t('a frequency is spoken in MHz with the trailing zeros gone', () => {
    // v1's rule: 6 decimals for full resolution, then parseFloat to drop the
    // zeros, so a round frequency is not read digit by digit.
    assert.strictEqual(speakFrequency(7100000), '7.1 megahertz');
    assert.strictEqual(speakFrequency(14074000), '14.074 megahertz');
    assert.strictEqual(speakFrequency(198000), '0.198 megahertz');
});

t('a frequency keeps the resolution it actually has', () => {
    assert.strictEqual(speakFrequency(7100010), '7.10001 megahertz');
    assert.strictEqual(speakFrequency(10136200), '10.1362 megahertz');
});

t('a mode is spoken as words, not letters run together', () => {
    // "usb" said as a word is the failure this table exists to prevent.
    assert.strictEqual(speakMode('usb'), 'upper sideband');
    assert.strictEqual(speakMode('lsb'), 'lower sideband');
    assert.strictEqual(speakMode('cwl'), 'C W lower');
    assert.strictEqual(speakMode('nfm'), 'narrow F M');
    assert.strictEqual(speakMode('sam'), 'synchronous A M');
});

t('a mode this build does not know is spoken as it stands', () => {
    // Better an odd reading than silence, which is indistinguishable from the
    // announcements being off.
    assert.strictEqual(speakMode('iq'), 'iq');
});

t('frequency and mode together are one sentence', () => {
    assert.strictEqual(
        announcement({ frequency: 14074000, mode: 'usb' }),
        '14.074 megahertz, upper sideband',
    );
});

t('either half alone is said on its own', () => {
    // Which half is spoken follows the two switches in the panel, so both of
    // these are ordinary rather than edge cases.
    assert.strictEqual(announcement({ frequency: 7100000, mode: null }), '7.1 megahertz');
    assert.strictEqual(announcement({ frequency: null, mode: 'lsb' }), 'lower sideband');
    assert.strictEqual(announcement({ frequency: null, mode: null }), '');
});

// --- voices ------------------------------------------------------------------

t('only Google and Microsoft English voices are offered', () => {
    const all = [
        voice('Google UK English Female', 'en-GB'),
        voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
        voice('Daniel', 'en-GB'),                       // Apple: excluded
        voice('Google Deutsch', 'de-DE'),               // not English
        voice('eSpeak English', 'en-US'),               // neither vendor
    ];
    assert.deepStrictEqual(
        usableVoices(all).map((v) => v.name),
        ['Google UK English Female', 'Microsoft Ryan Online (Natural) - English (United Kingdom)'],
    );
});

t('Google UK English Female wins where it exists — v1s first choice', () => {
    const chrome = [
        voice('Microsoft David - English (United States)', 'en-US'),
        voice('Google UK English Female', 'en-GB'),
        voice('Google US English', 'en-US'),
    ];
    assert.strictEqual(pickVoice(chrome).name, 'Google UK English Female');
});

t('on Edge the online voices beat the local ones', () => {
    // The online voices are the neural ones; the local SAPI voices carry the
    // same brand and are the reason the chain exists.
    const edge = [
        voice('Microsoft David - English (United States)', 'en-US'),
        voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
        voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
    ];
    assert.strictEqual(pickVoice(edge).name, 'Microsoft Sonia Online (Natural) - English (United Kingdom)');
});

t('UK online is preferred to US online', () => {
    const edge = [
        voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
        voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
    ];
    assert.strictEqual(pickVoice(edge).name, 'Microsoft Sonia Online (Natural) - English (United Kingdom)');
});

t('a "default" Microsoft voice is the last Microsoft resort', () => {
    const win = [
        voice('Microsoft David Desktop - English (United States) default', 'en-US'),
        voice('Microsoft Zira - English (United States)', 'en-US'),
    ];
    assert.strictEqual(pickVoice(win).name, 'Microsoft Zira - English (United States)');
});

t('nothing usable means no voice rather than a bad one', () => {
    assert.strictEqual(pickVoice([voice('Daniel', 'en-GB'), voice('Alex', 'en-US')]), null);
    assert.strictEqual(pickVoice([]), null);
});

// --- the browser gate --------------------------------------------------------

t('Chrome and Edge are in, other engines are out', () => {
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
    const edge = `${chrome} Edg/126`;
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
    assert.strictEqual(chromiumSpeech(chrome), true);
    assert.strictEqual(chromiumSpeech(edge), true);
    assert.strictEqual(chromiumSpeech(safari), false);
    assert.strictEqual(chromiumSpeech(firefox), false);
});

t('Chrome on iOS is WebKit, and has none of these voices', () => {
    const crios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126 Mobile/15E148 Safari/604.1';
    assert.strictEqual(chromiumSpeech(crios), false);
});

// --- defaults ----------------------------------------------------------------

t('announcements are off until asked for', () => {
    // A receiver that starts talking on its own is one somebody has to work out
    // how to silence.
    assert.strictEqual(DEFAULTS.enabled, false);
    // ...but with both readings selected, so switching it on says something.
    assert.strictEqual(DEFAULTS.frequency, true);
    assert.strictEqual(DEFAULTS.mode, true);
    assert.strictEqual(DEFAULTS.voice, '');
});

if (process.exitCode) console.log('\nannouncement tests FAILED');
else console.log(`\nall ${pass} announcement tests passed`);
