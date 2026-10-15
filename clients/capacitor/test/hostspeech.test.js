// The page half of on-device speech-to-text and translation (src/hostspeech.js).
//
// Native code cannot run here, so the host is a stub that records what the
// page sends and answers the way OnDeviceSpeech.swift does. What is pinned is
// what would go wrong silently on a phone nobody is watching:
//
//   * **Declared only when the host says so.** Android sets no flag, and must
//     see no `stt` — an object there would offer a source that cannot start.
//   * **The wire format.** Audio as base64 of little-endian Int16, every
//     request tagged with its session or id.
//   * **Stale answers dropped.** A result from a session that has been stopped
//     or replaced never reaches the page.
//   * **Nothing hangs.** A host that never answers is a rejected start, an
//     'unavailable' pair, a rejected translation.
//   * **The page's own engine runs on it.** v2's createHostEngine, driven
//     through this shim, starts, transcribes, shows a refused permission in
//     its app wording, and stops.

const assert = require('assert');
const { installHostSpeech, pcmToBase64, TIMEOUTS } = require('./.build/hostspeech.cjs');
const E = require('./.build/whisperengines.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(async () => {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
    });
};

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 5) { for (let i = 0; i < n; i++) await tick(); }

// A clock the test drives.
function clock() {
    let now = 0;
    let q = [];
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = { fn, at: now + (ms || 0) }; q.push(id); return id; },
        clearTimer: (id) => { q = q.filter((x) => x !== id); },
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                q.sort((a, b) => a.at - b.at);
                const next = q[0];
                if (!next || next.at > end) break;
                q.shift();
                now = next.at;
                next.fn();
                await settle();
            }
            now = end;
        },
    };
}

// A window, its flags, and a host that records what it is told.
function rig(flags = { sttHost: true, translateHost: true }) {
    const listeners = {};
    const win = {
        ubersdrDesktop: { ...flags },
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        // What the browser does on the way out of, or back into, the page.
        fire: (type, event = {}) => { for (const fn of listeners[type] || []) fn(event); },
    };
    const sent = [];
    const c = clock();
    const shim = installHostSpeech({
        win,
        tellHost: (m) => sent.push(JSON.parse(JSON.stringify(m))),
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
    });
    const say = (prefix, payload) => shim.onHostMessage(`${prefix}:${JSON.stringify(payload)}`);
    const last = (type) => [...sent].reverse().find((m) => m.type === type);
    return { win, sent, c, shim, say, last };
}

function sink() {
    const s = { results: [], errors: [], ends: 0 };
    s.cb = {
        onResult: (r) => s.results.push(r),
        onError: (e) => s.errors.push(e),
        onEnd: () => { s.ends++; },
    };
    return s;
}

function fakePlayer() {
    return {
        taps: new Set(),
        onAudio(fn) { this.taps.add(fn); return () => this.taps.delete(fn); },
        play(planes, frames, rate) { for (const fn of this.taps) fn(planes, frames, rate); },
    };
}

// ---- declaration ------------------------------------------------------------

t('nothing is declared without the flags — an older native half', () => {
    const win = { ubersdrDesktop: { speech: true, mediaSession: true } };
    const shim = installHostSpeech({ win, tellHost: () => assert.fail('told the host something') });
    assert.strictEqual(win.ubersdrDesktop.stt, undefined);
    assert.strictEqual(win.ubersdrDesktop.translate, undefined);
    assert.strictEqual(E.hostStt(win), null);
    assert.strictEqual(shim.onHostMessage('stt-result:{"session":1,"text":"x","final":true}'), false);
    assert.strictEqual(shim.onHostMessage('voices:[]'), false);
});

t('no ubersdrDesktop at all is not an error', () => {
    const win = {};
    installHostSpeech({ win, tellHost: () => {} });
    assert.strictEqual(win.ubersdrDesktop, undefined);
});

t('each flag declares its own object, and v2 detects stt synchronously', () => {
    const a = rig({ sttHost: true });
    assert.ok(a.win.ubersdrDesktop.stt);
    assert.strictEqual(a.win.ubersdrDesktop.translate, undefined);
    assert.strictEqual(E.hostStt(a.win), a.win.ubersdrDesktop.stt);
    assert.strictEqual(E.localEngineKind(a.win), 'host');

    const b = rig({ translateHost: true });
    assert.strictEqual(b.win.ubersdrDesktop.stt, undefined);
    assert.strictEqual(typeof b.win.ubersdrDesktop.translate.translate, 'function');
    assert.strictEqual(typeof b.win.ubersdrDesktop.translate.availability, 'function');
    // iOS: no page of its own for adding languages.
    assert.strictEqual(b.win.ubersdrDesktop.translate.openSettings, undefined);
});

t('translateSettings adds openSettings, which tells the host and expects nothing back', () => {
    const r = rig({ translateHost: true, translateSettings: true });
    const tr = r.win.ubersdrDesktop.translate;
    assert.strictEqual(typeof tr.openSettings, 'function');
    tr.openSettings();
    assert.deepStrictEqual(r.sent, [{ type: 'translate-settings' }]);
    // Without translateHost there is no translate to hang it on.
    const s = rig({ translateSettings: true });
    assert.strictEqual(s.win.ubersdrDesktop.translate, undefined);
});

// ---- the wire ---------------------------------------------------------------

t('audio is base64 of little-endian Int16', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 0x1234]);
    const b64 = pcmToBase64(pcm, (s) => Buffer.from(s, 'binary').toString('base64'));
    const bytes = Buffer.from(b64, 'base64');
    assert.strictEqual(bytes.length, 12);
    for (let i = 0; i < pcm.length; i++) assert.strictEqual(bytes.readInt16LE(i * 2), pcm[i]);
    // A view into a larger buffer encodes only its own samples.
    const big = new Int16Array([9, 9, 7, 8, 9]);
    const view = big.subarray(2, 4);
    assert.deepStrictEqual([...Buffer.from(pcmToBase64(view, (s) => Buffer.from(s, 'binary').toString('base64')), 'base64')], [7, 0, 8, 0]);
});

t('a full 100 ms push is one message of about 4.3 KB', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-GB', sampleRate: 16000 });
    const start = r.last('stt-start');
    assert.deepStrictEqual(start, { type: 'stt-start', session: start.session, lang: 'en-GB', sampleRate: 16000 });
    r.say('stt-started', { session: start.session });
    await started;
    r.win.ubersdrDesktop.stt.push(new Int16Array(1600).fill(-2));
    const audio = r.last('stt-audio');
    assert.strictEqual(audio.session, start.session);
    assert.ok(audio.pcm.length > 4200 && audio.pcm.length < 4400, `${audio.pcm.length} chars`);
    assert.strictEqual(Buffer.from(audio.pcm, 'base64').readInt16LE(3198), -2);
});

t('no audio, reset or result before the host has started', async () => {
    const r = rig();
    const s = sink();
    r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    const { session } = r.last('stt-start');
    r.win.ubersdrDesktop.stt.push(new Int16Array(1600));
    r.win.ubersdrDesktop.stt.reset();
    r.say('stt-result', { session, text: 'early', final: false });
    assert.strictEqual(r.last('stt-audio'), undefined);
    assert.strictEqual(r.last('stt-reset'), undefined);
    assert.strictEqual(s.results.length, 0);
});

// ---- sessions ---------------------------------------------------------------

t('results, errors and the end reach the session they belong to', async () => {
    const r = rig();
    const s = sink();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    const { session } = r.last('stt-start');
    r.say('stt-started', { session });
    await started;
    r.say('stt-result', { session, text: 'cq cq', final: false });
    r.say('stt-result', { session, text: 'CQ CQ de G4ABC.', final: true });
    r.say('stt-error', { session, code: 'no-speech', message: 'quiet', fatal: false, retryable: true });
    r.say('stt-end', { session });
    assert.deepStrictEqual(s.results, [{ text: 'cq cq', final: false }, { text: 'CQ CQ de G4ABC.', final: true }]);
    assert.deepStrictEqual(s.errors, [{ code: 'no-speech', message: 'quiet', fatal: false, retryable: true }]);
    assert.strictEqual(s.ends, 1);
    // Ended: nothing more.
    r.say('stt-result', { session, text: 'late', final: true });
    assert.strictEqual(s.results.length, 2);
});

t('a stopped or replaced session hears nothing more', async () => {
    const r = rig();
    const a = sink();
    const first = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...a.cb });
    const one = r.last('stt-start').session;
    r.say('stt-started', { session: one });
    await first;

    const b = sink();
    const second = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...b.cb });
    const stop = r.last('stt-stop');
    assert.strictEqual(stop.session, one, 'the old session was not stopped at the host');
    const two = r.last('stt-start').session;
    assert.notStrictEqual(two, one);
    r.say('stt-started', { session: two });
    await second;

    r.say('stt-result', { session: one, text: 'stale', final: true });
    r.say('stt-end', { session: one });
    assert.strictEqual(a.results.length + a.ends, 0);
    assert.strictEqual(b.results.length + b.ends, 0);

    r.win.ubersdrDesktop.stt.stop();
    assert.strictEqual(r.last('stt-stop').session, two);
    r.say('stt-result', { session: two, text: 'after stop', final: true });
    r.say('stt-error', { session: two, code: 'x', message: 'y', fatal: true });
    r.say('stt-end', { session: two });
    assert.strictEqual(b.results.length + b.errors.length + b.ends, 0);
    // A push after stop goes nowhere.
    const before = r.sent.length;
    r.win.ubersdrDesktop.stt.push(new Int16Array(10));
    assert.strictEqual(r.sent.length, before);
});

t('reset is sent for the session in progress', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    const { session } = r.last('stt-start');
    r.say('stt-started', { session });
    await started;
    r.win.ubersdrDesktop.stt.reset();
    assert.deepStrictEqual(r.last('stt-reset'), { type: 'stt-reset', session });
});

// ---- failing to start -------------------------------------------------------

t('a plain start failure rejects with the host\'s reason', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    const { session } = r.last('stt-start');
    r.say('stt-start-failed', { session, code: 'start-failed', message: 'the recogniser would not start' });
    await assert.rejects(started, /the recogniser would not start/);
});

t('a refused permission resolves, then fails with its code, then ends', async () => {
    const r = rig();
    const s = sink();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    const { session } = r.last('stt-start');
    r.say('stt-start-failed', { session, code: 'not-allowed', message: 'denied' });
    await started;
    assert.strictEqual(s.errors.length, 0, 'the error arrived before the start resolved');
    await r.c.advance(0);
    assert.deepStrictEqual(s.errors, [{ code: 'not-allowed', message: 'denied', fatal: true, retryable: false }]);
    assert.strictEqual(s.ends, 1);
});

t('stop between that resolve and its error silences both', async () => {
    const r = rig();
    const s = sink();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    const { session } = r.last('stt-start');
    r.say('stt-start-failed', { session, code: 'language-not-supported', message: 'no' });
    await started;
    r.win.ubersdrDesktop.stt.stop();
    await r.c.advance(0);
    assert.strictEqual(s.errors.length + s.ends, 0);
});

t('a host that never answers a start is rejected, and told to stop', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    const { session } = r.last('stt-start');
    let rejected = null;
    started.catch((e) => { rejected = e; });
    await r.c.advance(TIMEOUTS.startMs - 1);
    assert.strictEqual(rejected, null, 'gave up before the permission prompt could be answered');
    await r.c.advance(1);
    assert.match(String(rejected && rejected.message), /did not answer/);
    assert.deepStrictEqual(r.last('stt-stop'), { type: 'stt-stop', session });
    // A late "started" is not acted on.
    r.say('stt-started', { session });
    r.win.ubersdrDesktop.stt.push(new Int16Array(4));
    assert.strictEqual(r.last('stt-audio'), undefined);
});

t('stop while starting rejects the start, so nothing is left waiting', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    r.win.ubersdrDesktop.stt.stop();
    await assert.rejects(started, /stopped/);
});

// ---- the page going away ---------------------------------------------------

t('leaving the page stops its session at the host', async () => {
    const r = rig();
    const s = sink();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    const { session } = r.last('stt-start');
    r.say('stt-started', { session });
    await started;
    r.win.fire('pagehide', { persisted: false });
    assert.deepStrictEqual(r.last('stt-stop'), { type: 'stt-stop', session });
    r.say('stt-result', { session, text: 'after the page left', final: true });
    assert.strictEqual(s.results.length, 0);
    // Nothing to stop the second time round.
    const stops = r.sent.filter((m) => m.type === 'stt-stop').length;
    r.win.fire('pagehide', { persisted: false });
    assert.strictEqual(r.sent.filter((m) => m.type === 'stt-stop').length, stops);
});

t('leaving the page while a start is pending stops that too', async () => {
    const r = rig();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    const { session } = r.last('stt-start');
    r.win.fire('pagehide', { persisted: false });
    assert.deepStrictEqual(r.last('stt-stop'), { type: 'stt-stop', session });
    await assert.rejects(started, /stopped/);
});

t('a page back from the back-forward cache is told its session ended', async () => {
    const r = rig();
    const s = sink();
    const started = r.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000, ...s.cb });
    r.say('stt-started', { session: r.last('stt-start').session });
    await started;
    r.win.fire('pagehide', { persisted: true });
    assert.strictEqual(s.ends, 0, 'ended while the page was being frozen');
    r.win.fire('pageshow', { persisted: true });
    assert.strictEqual(s.ends, 1);
    r.win.fire('pageshow', { persisted: true });
    assert.strictEqual(s.ends, 1);
});

t('a fresh page load does not reuse the last one\'s ids', async () => {
    // The host outlives a reload, so a reply queued for the old page can reach
    // the new one: their first session and first request must not match.
    const a = rig();
    const b = rig();
    a.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 }).catch(() => {});
    b.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 }).catch(() => {});
    const sa = a.last('stt-start').session;
    const sb = b.last('stt-start').session;
    assert.ok(Number.isSafeInteger(sa) && sa > 0 && sa < 2 ** 31, `session ${sa}`);
    assert.notStrictEqual(sa, sb);
    // The old page's end, arriving at the new page, leaves its start alone.
    let rejected = null;
    const pending = b.win.ubersdrDesktop.stt.start({ lang: 'en-US', sampleRate: 16000 });
    pending.catch((e) => { rejected = e; });
    b.say('stt-end', { session: sa });
    await settle();
    assert.strictEqual(rejected, null);
    a.win.ubersdrDesktop.translate.availability('en', 'de');
    b.win.ubersdrDesktop.translate.availability('en', 'de');
    assert.notStrictEqual(a.last('translate-availability').id, b.last('translate-availability').id);
});

// ---- languages --------------------------------------------------------------

t('languages: one question for every caller, and a deadline', async () => {
    const r = rig();
    const a = r.win.ubersdrDesktop.stt.languages();
    const b = r.win.ubersdrDesktop.stt.languages();
    assert.strictEqual(r.sent.filter((m) => m.type === 'stt-languages').length, 1);
    r.shim.onHostMessage('stt-languages:["en-GB","de-DE"]');
    assert.deepStrictEqual(await a, ['en-GB', 'de-DE']);
    assert.deepStrictEqual(await b, ['en-GB', 'de-DE']);
    // ...which v2 reads as on-device, available now.
    const listed = E.localLanguages('host', r.win);
    r.shim.onHostMessage('stt-languages:["en-GB"]');
    assert.deepStrictEqual(await listed, [{ code: 'en-GB', status: 'available' }]);

    const late = r.win.ubersdrDesktop.stt.languages();
    let err = null;
    late.catch((e) => { err = e; });
    await r.c.advance(TIMEOUTS.languagesMs);
    assert.ok(err, 'a silent host left languages() hanging');
});

// ---- translation ------------------------------------------------------------

t('translate: request ids, answers and errors', async () => {
    const r = rig();
    const tr = r.win.ubersdrDesktop.translate;
    const p1 = tr.translate('Guten Tag', 'de', 'en');
    const p2 = tr.translate('Bonjour', 'fr', 'en');
    const [m1, m2] = r.sent.filter((m) => m.type === 'translate');
    assert.deepStrictEqual(m1, { type: 'translate', id: m1.id, text: 'Guten Tag', source: 'de', target: 'en' });
    assert.notStrictEqual(m1.id, m2.id);
    // Out of order, as a host with two sessions may answer.
    r.say('translate-result', { id: m2.id, error: 'the languages aren\'t downloaded on this device' });
    r.say('translate-result', { id: m1.id, text: 'Good day' });
    assert.strictEqual(await p1, 'Good day');
    await assert.rejects(p2, /aren't downloaded/);
    // A duplicate or unknown answer is ignored.
    assert.strictEqual(r.say('translate-result', { id: m1.id, text: 'again' }), true);
});

t('translate: availability is one of four words, and unavailable when silent', async () => {
    const r = rig();
    const tr = r.win.ubersdrDesktop.translate;
    const a = tr.availability('de', 'en');
    const ask = r.last('translate-availability');
    assert.deepStrictEqual(ask, { type: 'translate-availability', id: ask.id, source: 'de', target: 'en' });
    r.say('translate-availability', { id: ask.id, status: 'downloadable' });
    assert.strictEqual(await a, 'downloadable');

    // Android's: a language being added.
    const a2 = tr.availability('de', 'en');
    r.say('translate-availability', { id: r.last('translate-availability').id, status: 'downloading' });
    assert.strictEqual(await a2, 'downloading');

    const b = tr.availability('de', 'en');
    r.say('translate-availability', { id: r.last('translate-availability').id, status: 'nonsense' });
    assert.strictEqual(await b, 'unavailable');

    const c = tr.availability('ja', 'en');
    await r.c.advance(TIMEOUTS.availabilityMs);
    assert.strictEqual(await c, 'unavailable');

    const d = tr.translate('x', 'de', 'en');
    let err = null;
    d.catch((e) => { err = e; });
    await r.c.advance(TIMEOUTS.translateMs);
    assert.match(String(err && err.message), /did not answer/);
});

// ---- v2's own engine, on top --------------------------------------------------

t('v2 host engine: starts, feeds 16 kHz PCM, shows results, stops', async () => {
    const r = rig();
    const player = fakePlayer();
    const engine = E.createLocalEngine('host', { player, win: r.win });
    const s = sink();
    const running = engine.start({ lang: 'de-DE', ...s.cb });
    const start = r.last('stt-start');
    assert.strictEqual(start.lang, 'de-DE');
    assert.strictEqual(start.sampleRate, 16000);
    r.say('stt-started', { session: start.session });
    await running;
    for (let i = 0; i < 10; i++) player.play([new Float32Array(1600).fill(0.5)], 1600, 16000);
    const audio = r.sent.filter((m) => m.type === 'stt-audio');
    assert.ok(audio.length >= 9, `${audio.length} pushes`);
    assert.strictEqual(Buffer.from(audio[0].pcm, 'base64').length, 3200);
    r.say('stt-result', { session: start.session, text: 'guten', final: false });
    r.say('stt-result', { session: start.session, text: 'Guten Tag.', final: true });
    assert.deepStrictEqual(s.results, [{ text: 'guten', final: false }, { text: 'Guten Tag.', final: true }]);
    engine.reset();
    assert.strictEqual(r.last('stt-reset').session, start.session);
    engine.stop();
    assert.strictEqual(r.last('stt-stop').session, start.session);
    assert.strictEqual(s.ends, 1);
    assert.strictEqual(player.taps.size, 0);
});

t('v2 host engine: a refused permission is the app\'s permission note', async () => {
    const r = rig();
    const engine = E.createLocalEngine('host', { player: fakePlayer(), win: r.win });
    const s = sink();
    const running = engine.start({ lang: 'en-US', ...s.cb });
    r.say('stt-start-failed', { session: r.last('stt-start').session, code: 'not-allowed', message: 'denied' });
    await running;
    await r.c.advance(0);
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].code, 'not-allowed');
    assert.strictEqual(s.errors[0].action, 'permission');
    assert.match(s.errors[0].message, /UberSDR in this device's settings/);
    assert.strictEqual(s.ends, 1);
});

t('v2 host engine: a missing language is named', async () => {
    const r = rig();
    const engine = E.createLocalEngine('host', { player: fakePlayer(), win: r.win });
    const s = sink();
    const running = engine.start({ lang: 'de-DE', ...s.cb });
    r.say('stt-start-failed', { session: r.last('stt-start').session, code: 'language-not-supported', message: 'no' });
    await running;
    await r.c.advance(0);
    assert.match(s.errors[0].message, /^German.* is not available for on-device recognition/);
});

t('v2 host engine: the host ending by itself is restarted as a new session', async () => {
    const r = rig();
    const c = clock();
    const engine = E.createLocalEngine('host', {
        player: fakePlayer(), win: r.win, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now,
    });
    const s = sink();
    const running = engine.start({ lang: 'en-US', ...s.cb });
    const first = r.last('stt-start').session;
    r.say('stt-started', { session: first });
    await running;
    await c.advance(60000);
    r.say('stt-end', { session: first });
    await c.advance(2000);
    const second = r.last('stt-start').session;
    assert.notStrictEqual(second, first, 'not restarted');
    r.say('stt-started', { session: second });
    await settle();
    r.say('stt-result', { session: first, text: 'stale', final: true });
    r.say('stt-result', { session: second, text: 'fresh', final: true });
    assert.deepStrictEqual(s.results, [{ text: 'fresh', final: true }]);
    engine.stop();
});

// What the Android host (Recognition.java) says that iOS does not: two codes
// of its own, which the page has no table entry for and so shows in the host's
// words.

t('v2 host engine: a recogniser that would only take the microphone is the host\'s sentence, and the end', async () => {
    const r = rig();
    const engine = E.createLocalEngine('host', { player: fakePlayer(), win: r.win });
    const s = sink();
    const running = engine.start({ lang: 'en-US', ...s.cb });
    const message = 'This phone\'s speech recogniser can\'t take the receiver\'s audio — it will only listen to the microphone, which is not what is being transcribed.';
    r.say('stt-start-failed', { session: r.last('stt-start').session, code: 'audio-source-unsupported', message });
    await running;
    await r.c.advance(0);
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].code, 'audio-source-unsupported');
    assert.strictEqual(s.errors[0].message, message);
    // Not the permission advice: granting the microphone is what must not happen.
    assert.notStrictEqual(s.errors[0].action, 'permission');
    assert.strictEqual(s.ends, 1);
});

t('v2 host engine: falling behind is a note, and the session carries on', async () => {
    const r = rig();
    const engine = E.createLocalEngine('host', { player: fakePlayer(), win: r.win });
    const s = sink();
    const running = engine.start({ lang: 'en-US', ...s.cb });
    const id = r.last('stt-start').session;
    r.say('stt-started', { session: id });
    await running;
    r.say('stt-error', {
        session: id,
        code: 'falling-behind',
        message: 'On-device recognition fell behind the receiver\'s audio, so some of it was skipped.',
        fatal: false,
        retryable: false,
    });
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].fatal, false);
    assert.match(s.errors[0].message, /fell behind/);
    r.say('stt-result', { session: id, text: 'still here', final: true });
    assert.deepStrictEqual(s.results, [{ text: 'still here', final: true }]);
    assert.strictEqual(s.ends, 0);
    assert.strictEqual(r.sent.filter((m) => m.type === 'stt-stop').length, 0);
    engine.stop();
});

chain.then(() => {
    console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
});
