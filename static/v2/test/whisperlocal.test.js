// Speech-to-text on the device: the pure parts.
//
// Local mode is a second source of transcript feeding the same machinery as the
// server's, and the ways it goes wrong are quiet ones:
//
//   * The segment conversion. Interim and final results have to come out as
//     exactly what applySegments expects from WhisperLive — one rewritten live
//     line, then a settled one — or the console shows each hypothesis as a new
//     line, or a live line that never clears.
//   * The decisions. Which source runs, which errors are retried and which
//     stop it, when restarting gives up, when the watchdog speaks up. Each is a
//     rule the user only meets when something is already going wrong.
//   * The audio. Downmix, resample and PCM16 conversion for the host's
//     recogniser; an off-by-one in the batching or a wrapped full-scale sample
//     is a recogniser that hears clicks.

const assert = require('assert');

// local.js keeps the user's source choice here.
const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const { EMPTY, applySegments } = require('./.build/whisper.cjs');
const {
    LOCAL_EMPTY, finishSentence, foldResult, flushLocal, liveSegment,
} = require('./.build/whisperlocalsegments.cjs');
const L = require('./.build/whisperlocal.cjs');
const { Pcm16Batcher, downmix, floatToInt16, planesLevelDb, STT_RATE } = require('./.build/whisperpcm.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Feed results through foldResult and applySegments, as the panel will.
function run(results, lang = 'en-US') {
    let local = LOCAL_EMPTY;
    let transcript = EMPTY;
    const settled = [];
    for (const [r, at] of results) {
        const f = foldResult(local, r, at, { lang });
        local = f.state;
        const a = applySegments(transcript, f.segments, 1000000, 0);
        transcript = a.state;
        settled.push(...a.settled.map((s) => s.text));
    }
    return { local, transcript, settled };
}

// --- localSegments -----------------------------------------------------------

t('interim results rewrite one live line; the final settles it', () => {
    const { transcript, settled } = run([
        [{ text: 'hello', final: false }, 1],
        [{ text: 'hello wor', final: false }, 1.5],
        [{ text: 'hello world', final: false }, 2],
    ]);
    assert.strictEqual(transcript.done.length, 0, 'an interim was settled');
    assert.strictEqual(transcript.live.text, 'hello world');
    assert.strictEqual(settled.length, 0);

    const after = run([
        [{ text: 'hello', final: false }, 1],
        [{ text: 'hello world', final: false }, 2],
        [{ text: 'hello world', final: true }, 2.5],
    ]);
    assert.deepStrictEqual(after.transcript.done.map((s) => s.text), ['hello world.']);
    assert.strictEqual(after.transcript.live, null, 'the live line stayed up after it settled');
    assert.deepStrictEqual(after.settled, ['hello world.']);
});

t('an utterance is timed from its first interim to its final', () => {
    let s = LOCAL_EMPTY;
    let f = foldResult(s, { text: 'one', final: false }, 3);
    s = f.state;
    assert.deepStrictEqual(f.segments, [{ text: 'one', start: 3, end: 3, completed: false }]);
    f = foldResult(s, { text: 'one two', final: false }, 4.5);
    s = f.state;
    assert.strictEqual(f.segments[0].start, 3, 'the start moved with each revision');
    f = foldResult(s, { text: 'one two three', final: true }, 6);
    assert.deepStrictEqual(f.segments, [{ text: 'one two three.', start: 3, end: 6, completed: true }]);
    assert.deepStrictEqual(f.state, LOCAL_EMPTY, 'the next utterance would inherit this one\'s start');
    // A final with no interims before it starts and ends where it arrived.
    const lone = foldResult(LOCAL_EMPTY, { text: 'yes', final: true }, 9);
    assert.deepStrictEqual(lone.segments[0], { text: 'yes.', start: 9, end: 9, completed: true });
});

t('an empty interim leaves the live line alone', () => {
    const { transcript } = run([
        [{ text: 'still talking', final: false }, 1],
        [{ text: '   ', final: false }, 1.2],
    ]);
    assert.strictEqual(transcript.live.text, 'still talking');
});

t('an empty final settles the pending interim rather than losing it', () => {
    // Chrome finishes some utterances with an empty final, having said it all
    // in the interims.
    const { transcript, settled } = run([
        [{ text: 'this is the news', final: false }, 1],
        [{ text: '', final: true }, 2],
    ]);
    assert.deepStrictEqual(settled, ['this is the news.']);
    assert.strictEqual(transcript.live, null);
    // And with nothing pending it is nothing at all.
    assert.deepStrictEqual(foldResult(LOCAL_EMPTY, { text: '', final: true }, 1).segments, []);
});

t('flushLocal settles what a stopped recogniser never finished', () => {
    const f = foldResult(LOCAL_EMPTY, { text: 'cut off mid', final: false }, 1);
    const flushed = flushLocal(f.state, 4, { lang: 'en' });
    assert.deepStrictEqual(flushed.segments, [{ text: 'cut off mid.', start: 1, end: 4, completed: true }]);
    assert.deepStrictEqual(flushed.state, LOCAL_EMPTY);
    assert.deepStrictEqual(flushLocal(LOCAL_EMPTY, 4).segments, []);
});

t('liveSegment keeps the line being spoken when a late, translated line settles', () => {
    // A translated final applied on its own clears the live line — which by
    // then is the next utterance. Appending liveSegment keeps it.
    let transcript = EMPTY;
    let local = LOCAL_EMPTY;
    let f = foldResult(local, { text: 'bonjour', final: true }, 1);
    local = f.state;
    const late = { ...f.segments[0], text: 'Hello.' };
    f = foldResult(local, { text: 'comment', final: false }, 2);
    local = f.state;
    transcript = applySegments(transcript, f.segments, 0, 0).state;
    const batch = [late, liveSegment(local, 2.5)].filter(Boolean);
    transcript = applySegments(transcript, batch, 0, 0).state;
    assert.deepStrictEqual(transcript.done.map((s) => s.text), ['Hello.']);
    assert.strictEqual(transcript.live && transcript.live.text, 'comment', 'the live line was wiped');
    assert.strictEqual(liveSegment(LOCAL_EMPTY, 1), null);
});

t('whitespace inside a result is collapsed', () => {
    const f = foldResult(LOCAL_EMPTY, { text: '  two   spaces\n here ', final: false }, 0);
    assert.strictEqual(f.segments[0].text, 'two spaces here');
});

t('a final gets a sentence end, in its own script, so read-aloud is not held up', () => {
    assert.strictEqual(finishSentence('good evening', 'en-GB'), 'good evening.');
    assert.strictEqual(finishSentence('good evening.', 'en-GB'), 'good evening.');
    assert.strictEqual(finishSentence('are you there?', 'en'), 'are you there?');
    assert.strictEqual(finishSentence('你好', 'zh-CN'), '你好。');
    assert.strictEqual(finishSentence('नमस्ते', 'hi-IN'), 'नमस्ते।');
    // Thai has no full stop, and a Latin one would be wrong.
    assert.strictEqual(finishSentence('สวัสดี', 'th-TH'), 'สวัสดี');
    assert.strictEqual(finishSentence('', 'en'), '');
    assert.strictEqual(finishSentence('he said "stop."', 'en'), 'he said "stop."');
});

// --- source selection ------------------------------------------------------

t('local is the default wherever it works', () => {
    const r = L.pickSource({ localAvailable: true, serverEnabled: true, saved: null });
    assert.strictEqual(r.source, 'local');
    assert.deepStrictEqual(r.options.map((o) => [o.value, o.disabled]), [['local', false], ['server', false]]);
});

t('an explicit choice is honoured while it is possible', () => {
    assert.strictEqual(L.pickSource({ localAvailable: true, serverEnabled: true, saved: 'server' }).source, 'server');
    assert.strictEqual(L.pickSource({ localAvailable: true, serverEnabled: true, saved: 'local' }).source, 'local');
    // Server chosen, server gone: local, and the choice is not the selector's
    // to forget.
    assert.strictEqual(L.pickSource({ localAvailable: true, serverEnabled: false, saved: 'server' }).source, 'local');
    // Local chosen on a browser that cannot: server.
    assert.strictEqual(L.pickSource({ localAvailable: false, serverEnabled: true, saved: 'local' }).source, 'server');
});

t('server only: local is shown disabled, with the reason', () => {
    const r = L.pickSource({ localAvailable: false, serverEnabled: true });
    assert.strictEqual(r.source, 'server');
    const local = r.options.find((o) => o.value === 'local');
    assert.ok(local && local.disabled, 'local was not shown, or not disabled');
    assert.strictEqual(local.reason, L.LOCAL_UNSUPPORTED);
    const custom = L.pickSource({ localAvailable: false, serverEnabled: true, localReason: 'Not supported in this app yet' });
    assert.strictEqual(custom.options[0].reason, 'Not supported in this app yet');
});

t('local only: one option; neither: not available', () => {
    const r = L.pickSource({ localAvailable: true, serverEnabled: false });
    assert.strictEqual(r.source, 'local');
    assert.deepStrictEqual(r.options.map((o) => o.value), ['local']);
    assert.deepStrictEqual(L.pickSource({ localAvailable: false, serverEnabled: false }), { source: null, options: [] });
});

t('the choice round-trips through storage, and junk reads as no choice', () => {
    store.clear();
    assert.strictEqual(L.loadSource(), null);
    L.saveSource('server');
    assert.strictEqual(L.loadSource(), 'server');
    L.saveSource('nonsense');
    assert.strictEqual(L.loadSource(), 'server', 'an invalid value overwrote the choice');
    store.set('ubersdr.v2.stt.source', 'garbage');
    assert.strictEqual(L.loadSource(), null);
});

t('the spoken language round-trips too, and only as a language tag', () => {
    store.clear();
    assert.strictEqual(L.loadSpoken(), null);
    L.saveSpoken('de-DE');
    assert.strictEqual(L.loadSpoken(), 'de-DE');
    store.set('ubersdr.v2.stt.spoken', '<script>');
    assert.strictEqual(L.loadSpoken(), null);
    store.clear();
});

t('storage that throws is no choice, not a crash', () => {
    const saved = global.localStorage;
    global.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    try {
        assert.strictEqual(L.loadSource(), null);
        L.saveSource('local');
        assert.strictEqual(L.loadSpoken(), null);
        L.saveSpoken('de-DE');
    } finally {
        global.localStorage = saved;
    }
});

t('the status phrase names where it runs', () => {
    assert.strictEqual(L.sourcePhrase('local'), 'on this device');
    assert.strictEqual(L.sourcePhrase('server'), 'on the server');
});

// --- errors ------------------------------------------------------------------

t('silence and interruptions are retried quietly; permission refusals are fatal', () => {
    for (const code of ['no-speech', 'aborted', 'audio-capture', 'network']) {
        const d = L.describeError(code);
        assert.ok(d.retryable && !d.fatal, `${code} should be a quiet retry`);
    }
    for (const code of ['not-allowed', 'service-not-allowed']) {
        const d = L.describeError(code);
        assert.ok(d.fatal && !d.retryable, `${code} should stop`);
        assert.strictEqual(d.action, 'permission');
        assert.match(d.message, /site settings/, 'the note does not say how to change it');
    }
});

t('inside an app, a refused permission points at the device\'s settings, not a browser\'s', () => {
    for (const code of ['not-allowed', 'service-not-allowed']) {
        const d = L.describeError(code, 'denied', { kind: 'host' });
        assert.ok(d.fatal);
        assert.strictEqual(d.action, 'permission');
        assert.match(d.message, /UberSDR in this device's settings/, code);
        assert.doesNotMatch(d.message, /address bar|site settings/, code);
    }
    assert.match(L.describeError('unsupported', '', { kind: 'host' }).message, /This app/);
    assert.match(L.describeError('unsupported', '', { kind: 'browser' }).message, /This browser/);
    assert.match(L.describeError('no-languages', '', { kind: 'host' }).message, /This app has no languages/);
});

t('a language note names the language it is about', () => {
    assert.match(L.describeError('language-downloadable', '', { lang: 'fr-FR' }).message, /^French.* needs a one-off download/);
    assert.match(L.describeError('language-unavailable', '', { lang: 'de-DE' }).message, /^German.* not available/);
    assert.match(L.describeError('language-downloading', '', { lang: 'de-DE' }).message, /^German.* still downloading/);
    // A host's own message for a language code is not mistaken for its name.
    assert.match(L.describeError('language-not-supported', 'pack missing', { kind: 'host' }).message, /^This language/);
    // Without one, the generic sentence.
    assert.match(L.describeError('language-downloadable').message, /^This language needs/);
});

t('a missing language pack offers to install it', () => {
    assert.strictEqual(L.describeError('language-not-supported').action, 'install');
    assert.strictEqual(L.languageError('downloadable'), 'language-downloadable');
    assert.strictEqual(L.describeError(L.languageError('downloadable')).action, 'install');
    assert.strictEqual(L.languageError('downloading'), 'language-downloading');
    assert.strictEqual(L.languageError('unavailable'), 'language-unavailable');
    assert.strictEqual(L.describeError('language-unavailable').action, '');
    assert.ok(L.describeError('language-unavailable').fatal);
});

t('a failed start quotes the reason', () => {
    const d = L.describeError('start-failed', 'model busy');
    assert.strictEqual(d.message, 'On-device recognition couldn\'t start: model busy');
    assert.ok(d.fatal);
    assert.strictEqual(L.describeError('start-failed').message, 'On-device recognition couldn\'t start.');
});

t('an unknown code is fatal and shown as the host phrased it', () => {
    const d = L.describeError('weird-thing', 'The microphone service crashed');
    assert.ok(d.fatal && !d.retryable, 'an unknown failure must not be retried for ever');
    assert.strictEqual(d.message, 'The microphone service crashed');
    assert.strictEqual(L.describeError(undefined).code, 'error');
});

t('translation failure and the watchdog are notes, never stops', () => {
    assert.ok(!L.describeError('translate-failed').fatal);
    assert.match(L.describeError('translate-failed', 'no model').message, /no model.*shown as spoken/);
    const silent = L.describeError('silent');
    assert.ok(!silent.fatal && !silent.retryable);
    assert.match(silent.message, /running but hasn't produced any text/);
    assert.match(L.describeError('keeps-stopping').message, /keeps stopping/);
});

// --- restarting --------------------------------------------------------------

t('a session that ran for a while is restarted at once, and forgiven', () => {
    const p = L.restartPlan(3, 60000);
    assert.deepStrictEqual(p, { strikes: 0, delayMs: L.RESTART.baseMs, giveUp: false });
});

t('quick deaths back off and then give up', () => {
    let strikes = 0;
    const delays = [];
    let plan;
    for (let i = 0; i < 10; i++) {
        plan = L.restartPlan(strikes, 100);
        strikes = plan.strikes;
        if (plan.giveUp) break;
        delays.push(plan.delayMs);
    }
    assert.ok(plan.giveUp, 'a recogniser dying on every start was restarted for ever');
    assert.strictEqual(delays.length, L.RESTART.maxStrikes);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], 'backoff shrank');
    assert.ok(delays.every((d) => d <= L.RESTART.maxMs));
});

t('an error at the end of every session gives up, however long each ran', () => {
    for (const error of ['network', 'audio-capture', 'aborted']) {
        let strikes = 0;
        let plan;
        let n = 0;
        do {
            plan = L.restartPlan(strikes, 4000, { error });
            strikes = plan.strikes;
            n += 1;
        } while (!plan.giveUp && n < 100);
        assert.ok(plan.giveUp, `${error}: restarted for ever`);
        assert.strictEqual(n, L.RESTART.maxStrikes + 1);
    }
});

t('a settled line forgives anything; an interim alone does not', () => {
    assert.deepStrictEqual(L.restartPlan(4, 100, { error: 'network', settled: true }),
        { strikes: 0, delayMs: L.RESTART.baseMs, giveUp: false });
    assert.strictEqual(L.restartPlan(4, 100, { settled: false }).strikes, 5);
    // no-speech after a long session is a quiet frequency, not a failure.
    assert.strictEqual(L.restartPlan(4, 8000, { error: 'no-speech' }).strikes, 0);
    // ...but no-speech inside a second, every time, is.
    assert.strictEqual(L.restartPlan(4, 500, { error: 'no-speech' }).strikes, 5);
});

t('a quiet night — ends every few seconds — never gives up', () => {
    // no-speech, end, restart: each session runs past minRunMs.
    let strikes = 0;
    for (let i = 0; i < 1000; i++) {
        const plan = L.restartPlan(strikes, 8000);
        assert.ok(!plan.giveUp, `gave up on a quiet frequency after ${i} sessions`);
        strikes = plan.strikes;
    }
});

// --- watchdog ----------------------------------------------------------------

// Readings every 100 ms for `ms`; `level(i)` gives each.
function watch(ms, level, { heardAt = -1, armed = true, step = 100, state } = {}) {
    let s = state || L.WATCHDOG_EMPTY;
    let firstWarn = null;
    for (let i = 0, now = 0; now <= ms; i++, now += step) {
        s = L.watchdogStep(s, { levelDb: level(i), now, heard: i === heardAt, armed });
        if (s.warn && firstWarn == null) firstWarn = now;
    }
    return { state: s, firstWarn };
}

// Speech: syllables, 15 dB apart, a few a second.
const speech = (i) => (i % 3 === 0 ? -40 : -25);
// AGC'd hiss: loud and flat.
const hiss = (i) => -30 + (i % 2) * 1;

t('about 25 s of speech with no text raises the warning', () => {
    const { firstWarn } = watch(40000, speech);
    assert.ok(firstWarn != null, 'never warned');
    assert.ok(Math.abs(firstWarn - L.WATCHDOG.afterMs) <= 500, `warned at ${firstWarn} ms`);
});

t('steady hiss is not speech, however loud', () => {
    assert.strictEqual(watch(120000, hiss).firstWarn, null, 'an empty band with the AGC up looked like speech');
});

t('quiet audio is not speech', () => {
    const faint = (i) => (i % 3 === 0 ? -90 : -70);
    assert.strictEqual(watch(120000, faint).firstWarn, null);
});

t('any result resets the count, and takes the warning down', () => {
    // A result at 20 s: the next warning is 25 s after that, not 5.
    const { firstWarn } = watch(60000, speech, { heardAt: 200 });
    assert.ok(firstWarn >= 20000 + L.WATCHDOG.afterMs - 500, `warned at ${firstWarn} ms`);
    const warned = watch(30000, speech).state;
    assert.ok(warned.warn);
    const after = L.watchdogStep(warned, { levelDb: -25, now: 30100, heard: true, armed: true });
    assert.strictEqual(after.warn, false);
});

t('disarmed, it counts nothing', () => {
    assert.strictEqual(watch(60000, speech, { armed: false }).firstWarn, null);
});

t('a long gap between readings counts as one step, not a minute of audio', () => {
    // A background tab: timers throttled to one a minute.
    const { firstWarn } = watch(20 * 60000, speech, { step: 60000 });
    // 25 readings at the 1 s cap each, before it can warn.
    assert.ok(firstWarn == null || firstWarn >= 25 * 60000, `warned at ${firstWarn} ms`);
});

// --- languages ---------------------------------------------------------------

t('the closest spoken language: exact, then the user\'s region, then any variety, then English', () => {
    const list = ['de-DE', 'en-US', 'en-GB', 'fr-FR'];
    assert.strictEqual(L.closestLanguage(list, 'fr-FR'), 'fr-FR');
    assert.strictEqual(L.closestLanguage(list, 'en', 'en-GB'), 'en-GB');
    assert.strictEqual(L.closestLanguage(list, 'en', 'de-DE'), 'en-US');
    assert.strictEqual(L.closestLanguage(list, 'de'), 'de-DE');
    assert.strictEqual(L.closestLanguage(list, 'ja-JP', 'en-GB'), 'en-GB');
    assert.strictEqual(L.closestLanguage(['ja-JP', 'ko-KR'], 'en'), 'ja-JP');
    assert.strictEqual(L.closestLanguage([], 'en'), null);
    assert.strictEqual(L.closestLanguage(['en_GB'], 'en-gb'), 'en_GB');
});

t('the starting region never depends on the order a host lists them in', () => {
    // An iPad's supportedLocales() is a Set: it put English (Indonesia) first.
    const ipad = ['en-ID', 'en-IN', 'en-GB', 'en-US', 'en-AU', 'de-DE'];
    const shuffled = ['en-AU', 'de-DE', 'en-US', 'en-IN', 'en-GB', 'en-ID'];
    for (const list of [ipad, shuffled]) {
        assert.strictEqual(L.closestLanguage(list, 'en', 'en'), 'en-US', 'no region: American English');
        assert.strictEqual(L.closestLanguage(list, 'en', 'en-GB'), 'en-GB', 'the user\'s own region first');
        assert.strictEqual(L.closestLanguage(list, 'en', 'en-NZ'), 'en-US', 'a region not offered: American English');
        assert.strictEqual(L.closestLanguage(list, 'en', ''), 'en-US');
    }
    // No American English: the language's own country, then alphabetical.
    assert.strictEqual(L.closestLanguage(['en-IN', 'en-AU', 'en-ID'], 'en', ''), 'en-AU');
    assert.strictEqual(L.closestLanguage(['de-AT', 'de-CH', 'de-DE'], 'de', ''), 'de-DE');
    assert.strictEqual(L.closestLanguage(['fr-CA', 'fr-CH'], 'fr', ''), 'fr-CA');
});

t('spoken languages are named, with or without Intl', () => {
    assert.match(L.spokenName('en-GB'), /English/);
    assert.match(L.spokenName('de-DE'), /German/);
    assert.ok(L.SPOKEN_CANDIDATES.includes('en-US'));
    assert.strictEqual(new Set(L.SPOKEN_CANDIDATES).size, L.SPOKEN_CANDIDATES.length, 'a candidate is listed twice');
});

t('no translation when the spoken language is the output language', () => {
    assert.strictEqual(L.translationPair('en-GB', 'en'), null);
    assert.strictEqual(L.translationPair('pt-BR', 'pb'), null);
    assert.strictEqual(L.translationPair('zh-TW', 'zt'), null);
    assert.strictEqual(L.translationPair('nb-NO', 'nb'), null);
    assert.deepStrictEqual(L.translationPair('de-DE', 'en'), { source: 'de', target: 'en' });
    assert.deepStrictEqual(L.translationPair('en-US', 'zt'), { source: 'en', target: 'zh-Hant' });
    assert.deepStrictEqual(L.translationPair('zh-CN', 'zt'), { source: 'zh', target: 'zh-Hant' });
    assert.strictEqual(L.translationPair('', 'en'), null);
});

// --- audio -------------------------------------------------------------------

t('downmix averages the planes, and passes one through', () => {
    const a = Float32Array.from([1, 0.5, -1]);
    const b = Float32Array.from([0, 0.5, 1]);
    assert.deepStrictEqual(Array.from(downmix([a, b], 3)), [0.5, 0.5, 0]);
    assert.deepStrictEqual(Array.from(downmix([a], 2)), [1, 0.5]);
    assert.deepStrictEqual(Array.from(downmix([], 2)), [0, 0]);
    const reuse = new Float32Array(8);
    assert.strictEqual(downmix([a, b], 3, reuse), reuse, 'the scratch buffer was not reused');
});

t('PCM16 is asymmetric, clamped, and NaN-proof', () => {
    const out = floatToInt16(Float32Array.from([1, -1, 0, 2, -2, NaN, 0.5]));
    assert.deepStrictEqual(Array.from(out), [32767, -32768, 0, 32767, -32768, 0, 16384]);
});

t('the level reads dBFS and silence as -Infinity', () => {
    const full = new Float32Array(480).fill(1);
    assert.ok(Math.abs(planesLevelDb([full, full], 480)) < 1e-9);
    const half = new Float32Array(480).fill(0.1);
    assert.ok(Math.abs(planesLevelDb([half], 480) + 20) < 1e-6);
    assert.strictEqual(planesLevelDb([new Float32Array(10)], 10), -Infinity);
    assert.strictEqual(planesLevelDb([], 10), -Infinity);
});

function sine(rate, hz, n, amp = 0.5, phase0 = 0) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * ((i + phase0) / rate));
    return out;
}

for (const rate of [12000, 16000, 24000, 44100, 48000]) {
    t(`${rate / 1000} kHz in: 100 ms chunks of 16 kHz PCM16, at the right rate and level`, () => {
        const chunks = [];
        const b = new Pcm16Batcher({ onChunk: (c) => chunks.push(c) });
        // Two seconds, in 20 ms packets, stereo duplicated as the player sends.
        const packet = Math.round(rate * 0.02);
        let pos = 0;
        for (let k = 0; k < 100; k++) {
            const s = sine(rate, 1000, packet, 0.5, pos);
            b.push([s, s], packet, rate);
            pos += packet;
        }
        for (const c of chunks) {
            assert.ok(c instanceof Int16Array);
            assert.strictEqual(c.length, STT_RATE / 10);
        }
        // Two seconds at 16 kHz is 20 chunks; the resampler's delay may hold
        // back part of the last.
        assert.ok(chunks.length >= 19 && chunks.length <= 20, `${chunks.length} chunks`);
        // Each chunk is its own array: it crosses a bridge.
        assert.notStrictEqual(chunks[0].buffer, chunks[1].buffer);
        // A 1 kHz tone at half scale is still one, after the filter settles:
        // ~11585 RMS, and 1000 zero crossings up per second.
        const tail = chunks.slice(4).flatMap((c) => Array.from(c));
        const rms = Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length);
        assert.ok(Math.abs(rms - 0.5 * 32767 / Math.SQRT2) < 600, `rms ${rms.toFixed(0)}`);
        let ups = 0;
        for (let i = 1; i < tail.length; i++) if (tail[i - 1] < 0 && tail[i] >= 0) ups++;
        const hz = ups / (tail.length / STT_RATE);
        assert.ok(Math.abs(hz - 1000) < 10, `${hz.toFixed(1)} Hz`);
    });
}

t('a rate change starts afresh rather than splicing two streams', () => {
    const chunks = [];
    const b = new Pcm16Batcher({ onChunk: (c) => chunks.push(c) });
    b.push([sine(48000, 500, 2400)], 2400, 48000); // 800 out: half a chunk
    assert.strictEqual(chunks.length, 0);
    assert.strictEqual(b.fill, 800);
    b.push([sine(12000, 500, 1200)], 1200, 12000); // exactly one chunk's worth
    // Kept, the old half would have made this one chunk and half another.
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(b.fill, 0, 'the half chunk from the old rate was kept');
});

t('nothing in, nothing out', () => {
    const chunks = [];
    const b = new Pcm16Batcher({ onChunk: (c) => chunks.push(c) });
    b.push([new Float32Array(0)], 0, 48000);
    b.push([new Float32Array(10)], 10, 0);
    assert.strictEqual(chunks.length, 0);
});

t('a model reads in the menu as what it is, and what it would cost', () => {
    assert.strictEqual(L.formatModelSize(59707625), '60 MB');
    assert.strictEqual(L.formatModelSize(190085487), '190 MB');
    assert.strictEqual(L.formatModelSize(885098), '0.9 MB');
    assert.strictEqual(L.formatModelSize(1550000000), '1.6 GB');
    assert.strictEqual(L.formatModelSize(0), '');
    assert.strictEqual(L.formatModelSize('x'), '');
    const base = { id: 'base', label: 'Base', sizeBytes: 59707625, installed: true, builtIn: true };
    const small = { id: 'small', label: 'Small', sizeBytes: 190085487, installed: false, builtIn: false };
    assert.strictEqual(L.modelLabel(base), 'Base — built in');
    assert.strictEqual(L.modelLabel(small), 'Small — 190 MB, not downloaded');
    assert.strictEqual(L.modelLabel({ ...small, installed: true }), 'Small — 190 MB');
    assert.strictEqual(L.modelLabel({ id: 'tiny', installed: true }), 'tiny');
    assert.strictEqual(L.modelLabel(null), '');
});

t('a download\'s progress as a whole percentage, never past either end', () => {
    assert.strictEqual(L.downloadPercent({ received: 0, total: 100 }), 0);
    assert.strictEqual(L.downloadPercent({ received: 499, total: 1000 }), 49);
    assert.strictEqual(L.downloadPercent({ received: 1000, total: 1000 }), 100);
    assert.strictEqual(L.downloadPercent({ received: 2000, total: 1000 }), 100);
    assert.strictEqual(L.downloadPercent({ received: 10, total: 0 }), 0);
    assert.strictEqual(L.downloadPercent(null), 0);
});

console.log(`\n${pass} passed`);
