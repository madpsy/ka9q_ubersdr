// Speech-to-text on the device: the engines, the translator, and the feed.
//
// Everything here talks to something a test cannot run — Web Speech's
// recogniser, a native app's, Chrome's translator, an AudioContext — so each is
// a stub shaped like the spec says the real one is, and the tests are about
// what this code does with it. The properties that matter most are the ones a
// user would never see go wrong:
//
//   * **Never the microphone, never the cloud.** The recogniser is started
//     with the receiver's track and with processLocally on, or not at all — a
//     missing language is a note, not a fallback.
//   * **Never a loop.** A recogniser that dies on every start gives up and
//     says so; one that ends after a quiet minute is restarted for ever.
//   * **Never silent failure.** Every way of not starting reaches onError, and
//     onEnd follows exactly once.
//   * **The feed outlives the mute.** The recognition track hangs off the graph
//     before volume, mute and the duck, and survives a filter change and a
//     context rebuild.

const assert = require('assert');

global.window = global.window || {};
const E = require('./.build/whisperengines.cjs');
const T = require('./.build/whispertranslate.cjs');
const { AudioPlayer } = require('./.build/audioplayer.cjs');

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

// A clock the test drives. Timers fire only when it is advanced.
function clock() {
    let now = 0;
    let q = [];
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = { fn, at: now + (ms || 0) }; q.push(id); return id; },
        clearTimer: (id) => { q = q.filter((x) => x !== id); },
        pending: () => q.length,
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

// A player as far as the engines see one.
function fakePlayer() {
    const handlers = {};
    let n = 0;
    return {
        held: false,
        releases: 0,
        taps: new Set(),
        track: null,
        noTrack: false,
        recognitionTrack() {
            if (this.noTrack) return null;
            this.held = true;
            if (!this.track) this.track = { kind: 'audio', readyState: 'live', id: ++n };
            return this.track;
        },
        releaseRecognitionTrack() { this.held = false; this.releases++; this.track = null; },
        on(ev, fn) { (handlers[ev] ||= new Set()).add(fn); return () => handlers[ev].delete(fn); },
        emit(ev, v) { for (const fn of handlers[ev] || []) fn(v); },
        listeners: (ev) => (handlers[ev] ? handlers[ev].size : 0),
        onAudio(fn) { this.taps.add(fn); return () => this.taps.delete(fn); },
        play(planes, frames, rate) { for (const fn of this.taps) fn(planes, frames, rate); },
    };
}

// Web Speech's recogniser, per the spec's IDL: processLocally is a real
// attribute (on the prototype), available() and install() are static.
function fakeRecognition({ status = 'available', startThrows = null } = {}) {
    class Rec {
        constructor() {
            Rec.instances.push(this);
            this.starts = [];
            this.aborts = 0;
        }

        start(...args) {
            if (Rec.startThrows) throw Rec.startThrows;
            this.starts.push(args);
        }

        abort() {
            this.aborts++;
            // As Chrome does: an 'aborted' error, then 'end', asynchronously.
            setImmediate(() => {
                if (this.onerror) this.onerror({ error: 'aborted' });
                if (this.onend) this.onend();
            });
        }

        stop() {}

        result(list, resultIndex = 0) {
            this.onresult({ resultIndex, results: list.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal })) });
        }
    }
    Rec.prototype.processLocally = false;
    Rec.instances = [];
    Rec.status = status;
    Rec.startThrows = startThrows;
    Rec.asked = [];
    Rec.available = async (opts) => { Rec.asked.push(opts); return Rec.status; };
    Rec.installs = [];
    Rec.install = async (opts) => { Rec.installs.push(opts); return true; };
    return Rec;
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

function browserEngine(opts) {
    const Rec = fakeRecognition(opts);
    const player = fakePlayer();
    const c = clock();
    const engine = E.createLocalEngine('browser', {
        player, Recognition: Rec, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now,
    });
    return { Rec, player, c, engine };
}

// --- detection -----------------------------------------------------------------

t('a host recogniser needs start and push', () => {
    assert.strictEqual(E.hostStt({}), null);
    assert.strictEqual(E.hostStt({ ubersdrDesktop: { stt: { start() {} } } }), null);
    const stt = { start() {}, push() {} };
    assert.strictEqual(E.hostStt({ ubersdrDesktop: { stt } }), stt);
    assert.strictEqual(E.hostStt({ get ubersdrDesktop() { throw new Error('no'); } }), null);
});

t('Web Speech counts only with available() and a real processLocally', () => {
    const Rec = fakeRecognition();
    assert.strictEqual(E.browserRecognition({ SpeechRecognition: Rec }), Rec);
    assert.strictEqual(E.browserRecognition({ webkitSpeechRecognition: Rec }), Rec);
    // Safari, and Chrome before 139: a recogniser, but a cloud one.
    function Old() {}
    assert.strictEqual(E.browserRecognition({ webkitSpeechRecognition: Old }), null);
    function NoLocal() {}
    NoLocal.available = async () => 'available';
    assert.strictEqual(E.browserRecognition({ SpeechRecognition: NoLocal }), null,
        'without processLocally on the prototype, setting it would start a cloud session');
    assert.strictEqual(E.browserRecognition({}), null);
});

t('never in Electron, whose renderer dies on touching on-device recognition', () => {
    const Rec = fakeRecognition();
    const win = {
        SpeechRecognition: Rec,
        navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 UberSDR-Desktop/0.1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36' },
    };
    assert.strictEqual(E.browserRecognition(win), null);
    assert.strictEqual(E.localEngineKind(win), null);
    assert.strictEqual(E.localUnavailableReason(win), 'Not supported in this app yet');
    // ...unless the app brings its own.
    win.ubersdrDesktop = { stt: { start() {}, push() {} } };
    assert.strictEqual(E.localEngineKind(win), 'host');
});

t('the host is preferred, and the reasons say why there is none', () => {
    const Rec = fakeRecognition();
    const stt = { start() {}, push() {} };
    assert.strictEqual(E.localEngineKind({ SpeechRecognition: Rec, ubersdrDesktop: { stt } }), 'host');
    assert.strictEqual(E.localEngineKind({ SpeechRecognition: Rec }), 'browser');
    assert.strictEqual(E.localSttAvailable({}), false);
    assert.strictEqual(E.localUnavailableReason({ SpeechRecognition: Rec }), '');
    assert.strictEqual(E.localUnavailableReason({}), 'Not supported in this browser');
    function Old() {}
    assert.match(E.localUnavailableReason({ webkitSpeechRecognition: Old }), /its own servers/);
});

// --- the start(track) probe ------------------------------------------------------
//
// Chrome 145 on Linux passes every feature test and fails every start(track)
// with 'network' (see probeBrowserTrack). These pin the verdicts: that
// signature fails it, anything that got past the track passes it, and it
// never leaves a recogniser, a track or a context behind.

function probeWin(Rec, { ac = true } = {}) {
    const made = { contexts: [], tracks: [] };
    function AC() {
        this.closed = false;
        made.contexts.push(this);
    }
    AC.prototype.createMediaStreamDestination = function () {
        const track = { stopped: false, stop() { this.stopped = true; } };
        made.tracks.push(track);
        return { stream: { getAudioTracks: () => [track] } };
    };
    AC.prototype.close = function () { this.closed = true; };
    return { win: ac ? { SpeechRecognition: Rec, AudioContext: AC } : { SpeechRecognition: Rec }, made };
}

async function probeWith(Rec, act, opts) {
    const { win, made } = probeWin(Rec, opts);
    const c = clock();
    const p = E.probeBrowserTrack(win, { setTimer: c.setTimer, clearTimer: c.clearTimer, timeoutMs: 1500 });
    await settle();
    const rec = Rec.instances[0];
    if (act && rec) await act(rec, c);
    const result = await p;
    return { result, rec, made, win, c };
}

const released = ({ rec, made }) => {
    assert.ok(made.tracks.every((x) => x.stopped), 'the silent track is stopped');
    assert.ok(made.contexts.every((x) => x.closed), 'the context is closed');
    if (rec) assert.strictEqual(rec.aborts, 1, 'the recogniser is aborted');
};

t('probe: a "network" error before anything else is the broken start(track)', async () => {
    const Rec = fakeRecognition();
    const r = await probeWith(Rec, (rec) => rec.onerror({ error: 'network' }));
    assert.strictEqual(r.result, false);
    const [args] = r.rec.starts;
    assert.strictEqual(args[0], r.made.tracks[0], 'started on the silent track, never the microphone');
    assert.strictEqual(r.rec.processLocally, true);
    released(r);
    assert.strictEqual(E.browserTrackProbed(r.win), false);
    assert.strictEqual(E.usableLocalKind(r.win).kind, null);
    assert.strictEqual(E.localUnavailableReason(r.win), E.TRACK_UNSUPPORTED_REASON);
});

t('probe: audio arriving, another error, or quiet all pass', async () => {
    const audio = await probeWith(fakeRecognition(), (rec) => rec.onaudiostart());
    assert.strictEqual(audio.result, true);
    released(audio);
    const other = await probeWith(fakeRecognition(), (rec) => rec.onerror({ error: 'no-speech' }));
    assert.strictEqual(other.result, true);
    const quiet = await probeWith(fakeRecognition(), (rec, c) => c.advance(1500));
    assert.strictEqual(quiet.result, true);
    released(quiet);
    assert.strictEqual(E.usableLocalKind(quiet.win).kind, 'browser');
});

t('probe: a start that throws fails it', async () => {
    const r = await probeWith(fakeRecognition({ startThrows: new TypeError('no overload') }));
    assert.strictEqual(r.result, false);
    released({ made: r.made });
});

t('probe: once per recogniser, and pending until it answers', async () => {
    const Rec = fakeRecognition();
    const { win } = probeWin(Rec);
    const c = clock();
    const deps = { setTimer: c.setTimer, clearTimer: c.clearTimer };
    const a = E.probeBrowserTrack(win, deps);
    const b = E.probeBrowserTrack(win, deps);
    assert.strictEqual(a, b, 'a second caller shares the first probe');
    await settle();
    assert.deepStrictEqual(E.usableLocalKind(win), { kind: null, pending: true });
    Rec.instances[0].onerror({ error: 'network' });
    assert.strictEqual(await a, false);
    assert.strictEqual(Rec.instances.length, 1);
    assert.deepStrictEqual(E.usableLocalKind(win), { kind: null, pending: false });
});

t('probe: with no language installed it passes, and asks again next time', async () => {
    const Rec = fakeRecognition({ status: 'downloadable' });
    const { win } = probeWin(Rec);
    assert.strictEqual(await E.probeBrowserTrack(win), true);
    assert.strictEqual(Rec.instances.length, 0, 'nothing started: a missing pack says nothing about the track');
    assert.strictEqual(E.browserTrackProbed(win), null, 'inconclusive is not remembered');
    Rec.status = 'available';
    const c = clock();
    const again = E.probeBrowserTrack(win, { setTimer: c.setTimer, clearTimer: c.clearTimer });
    await settle();
    Rec.instances[0].onerror({ error: 'network' });
    assert.strictEqual(await again, false);
});

t('probe: no AudioContext is inconclusive, and the host never needs one', async () => {
    const Rec = fakeRecognition();
    const r = await probeWith(Rec, null, { ac: false });
    assert.strictEqual(r.result, true);
    assert.strictEqual(E.browserTrackProbed(r.win), null);
    const stt = { start() {}, push() {} };
    assert.deepStrictEqual(E.usableLocalKind({ SpeechRecognition: Rec, ubersdrDesktop: { stt } }), { kind: 'host', pending: false });
});

t('language status asks for on-device recognition, and never throws', async () => {
    const Rec = fakeRecognition({ status: 'downloadable' });
    const win = { SpeechRecognition: Rec };
    assert.strictEqual(await E.languageStatus('browser', 'de-DE', win), 'downloadable');
    assert.deepStrictEqual(Rec.asked[0], { langs: ['de-DE'], processLocally: true });
    Rec.status = 'something-new';
    assert.strictEqual(await E.languageStatus('browser', 'de-DE', win), 'unavailable');
    Rec.available = async () => { throw new Error('policy'); };
    assert.strictEqual(await E.languageStatus('browser', 'de-DE', win), 'unavailable');
    assert.strictEqual(await E.languageStatus('browser', '', win), 'unavailable');

    const host = { ubersdrDesktop: { stt: { start() {}, push() {}, languages: async () => ['en-GB', 'de-DE'] } } };
    assert.strictEqual(await E.languageStatus('host', 'en-gb', host), 'available');
    assert.strictEqual(await E.languageStatus('host', 'fr-FR', host), 'unavailable');
    const noList = { ubersdrDesktop: { stt: { start() {}, push() {} } } };
    assert.strictEqual(await E.languageStatus('host', 'fr-FR', noList), 'available');
});

t('the language list: the host\'s own, or the browser\'s answers to each candidate', async () => {
    const host = { ubersdrDesktop: { stt: { start() {}, push() {}, languages: async () => ['en-GB', 'en-GB', 'de-DE'] } } };
    assert.deepStrictEqual(await E.localLanguages('host', host), [
        { code: 'en-GB', status: 'available' }, { code: 'de-DE', status: 'available' },
    ]);
    const failing = { ubersdrDesktop: { stt: { start() {}, push() {}, languages: async () => { throw new Error('x'); } } } };
    assert.deepStrictEqual(await E.localLanguages('host', failing), []);

    const Rec = fakeRecognition();
    Rec.available = async ({ langs }) => ({ 'en-US': 'available', 'fr-FR': 'downloadable' }[langs[0]] || 'unavailable');
    assert.deepStrictEqual(await E.localLanguages('browser', { SpeechRecognition: Rec }), [
        { code: 'en-US', status: 'available' }, { code: 'fr-FR', status: 'downloadable' },
    ]);
    assert.deepStrictEqual(await E.localLanguages(null, {}), []);
});

t('installing asks for the on-device pack and answers true or false', async () => {
    const Rec = fakeRecognition();
    const win = { SpeechRecognition: Rec };
    assert.strictEqual(E.canInstall('browser', win), true);
    assert.strictEqual(E.canInstall('host', win), false);
    assert.strictEqual(await E.installLanguage('fr-FR', win), true);
    assert.deepStrictEqual(Rec.installs[0], { langs: ['fr-FR'], processLocally: true });
    Rec.install = async () => { throw new Error('SyntaxError'); };
    assert.strictEqual(await E.installLanguage('fr-FR', win), false);
    assert.strictEqual(await E.installLanguage('fr-FR', {}), false);
});

// --- the browser engine ----------------------------------------------------------

t('browser: started on-device, continuous, on the receiver\'s track', async () => {
    const { Rec, player, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-GB', ...s.cb });
    assert.strictEqual(engine.kind, 'browser');
    assert.strictEqual(Rec.instances.length, 1);
    const r = Rec.instances[0];
    assert.strictEqual(r.processLocally, true, 'the cloud recogniser was used');
    assert.strictEqual(r.continuous, true);
    assert.strictEqual(r.interimResults, true);
    assert.strictEqual(r.lang, 'en-GB');
    assert.strictEqual(r.starts.length, 1);
    assert.strictEqual(r.starts[0].length, 1, 'start() was called without the track — that is the microphone');
    assert.strictEqual(r.starts[0][0], player.track);
    assert.deepStrictEqual(Rec.asked[0], { langs: ['en-GB'], processLocally: true });
    assert.strictEqual(s.errors.length, 0);
    engine.stop();
});

t('browser: interims and finals come through in order', async () => {
    const { Rec, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    r.result([['hello', false]]);
    r.result([['hello', false], [' world', false]]);
    r.result([['hello world', true]]);
    r.result([['hello world', true], ['next', false]], 1);
    assert.deepStrictEqual(s.results, [
        { text: 'hello', final: false },
        { text: 'hello world', final: false },
        { text: 'hello world', final: true },
        { text: 'next', final: false },
    ]);
    engine.stop();
});

t('resultsFromEvent: finals one by one, the interim tail as one line', () => {
    const ev = (list, resultIndex) => ({
        resultIndex,
        results: list.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal })),
    });
    assert.deepStrictEqual(E.resultsFromEvent(ev([['a', true], ['b', true], ['c', false], ['d', false]], 1)), [
        { text: 'b', final: true }, { text: 'c d', final: false },
    ]);
    assert.deepStrictEqual(E.resultsFromEvent(ev([['x', false], [' y', false]], 0)), [{ text: 'x y', final: false }]);
    assert.deepStrictEqual(E.resultsFromEvent({}), []);
    assert.deepStrictEqual(E.resultsFromEvent(ev([['', false]], 0)), []);
});

t('browser: a language note names the language', async () => {
    const { engine } = browserEngine({ status: 'downloadable' });
    const s = sink();
    await engine.start({ lang: 'fr-FR', ...s.cb });
    assert.match(s.errors[0].message, /^French.* needs a one-off download/);
});

t('browser: a language that is not on the device is a note, never a fallback', async () => {
    for (const [status, code, action] of [
        ['downloadable', 'language-downloadable', 'install'],
        ['downloading', 'language-downloading', ''],
        ['unavailable', 'language-unavailable', ''],
    ]) {
        const { Rec, player, engine } = browserEngine({ status });
        const s = sink();
        await engine.start({ lang: 'fr-FR', ...s.cb });
        assert.strictEqual(Rec.instances.length, 0, `${status}: a recogniser was made anyway`);
        assert.strictEqual(s.errors.length, 1);
        assert.strictEqual(s.errors[0].code, code);
        assert.strictEqual(s.errors[0].action, action);
        assert.ok(s.errors[0].fatal);
        assert.strictEqual(s.ends, 1);
        assert.strictEqual(player.held, false);
    }
});

t('browser: a check that throws is an unavailable language', async () => {
    const { Rec, engine } = browserEngine();
    Rec.available = async () => { throw new Error('blocked by policy'); };
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    assert.strictEqual(s.errors[0].code, 'language-unavailable');
    assert.strictEqual(Rec.instances.length, 0);
});

t('browser: a refused track is "can\'t transcribe receiver audio", other throws are quoted', async () => {
    for (const name of ['TypeError', 'InvalidStateError']) {
        const err = Object.assign(new Error('nope'), { name });
        const { engine, player } = browserEngine({ startThrows: err });
        const s = sink();
        await engine.start({ lang: 'en-US', ...s.cb });
        assert.strictEqual(s.errors[0].code, 'track-unsupported', name);
        assert.match(s.errors[0].message, /can't transcribe receiver audio on-device/);
        assert.strictEqual(s.ends, 1);
        assert.strictEqual(player.held, false, 'the track was left held');
    }
    const { engine } = browserEngine({ startThrows: Object.assign(new Error('the model is busy'), { name: 'NotAllowedError' }) });
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    assert.strictEqual(s.errors[0].code, 'start-failed');
    assert.strictEqual(s.errors[0].message, 'On-device recognition couldn\'t start: the model is busy');
});

t('browser: no audio graph yet is said plainly', async () => {
    const { player, engine } = browserEngine();
    player.noTrack = true;
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    assert.strictEqual(s.errors[0].code, 'no-audio');
});

t('browser: no recogniser at all is "unsupported"', async () => {
    const engine = E.createLocalEngine('browser', { player: fakePlayer(), win: {} });
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    assert.strictEqual(s.errors[0].code, 'unsupported');
    assert.strictEqual(s.ends, 1);
});

t('browser: a session that ends after a while is restarted, quietly', async () => {
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    await c.advance(60000);
    r.onerror({ error: 'no-speech' });
    r.onend();
    await c.advance(1000);
    assert.strictEqual(r.starts.length, 2, 'not restarted');
    assert.strictEqual(s.errors.length, 0, 'a quiet retry reached the user');
    assert.strictEqual(s.ends, 0);
    engine.stop();
});

t('browser: a recogniser dying on every start gives up — no loop', async () => {
    const { Rec, c, player, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    // Each restart dies 10 ms after it starts.
    for (let i = 0; i < 50 && s.ends === 0; i++) {
        await c.advance(10);
        r.onend();
        const before = r.starts.length;
        while (s.ends === 0 && r.starts.length === before) await c.advance(5);
    }
    assert.strictEqual(s.ends, 1, 'never gave up');
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].code, 'keeps-stopping');
    assert.match(s.errors[0].message, /keeps stopping/);
    assert.ok(r.starts.length <= 7, `${r.starts.length} starts`);
    assert.strictEqual(c.pending(), 0, 'a restart was left scheduled');
    assert.strictEqual(player.held, false);
});

t('browser: a settled line in between resets the count', async () => {
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    for (let i = 0; i < 30; i++) {
        r.result([['words', true]]);
        r.onend();
        await c.advance(10000);
    }
    assert.strictEqual(s.ends, 0, 'gave up on a recogniser that was producing text');
    engine.stop();
});

t('browser: a word and a quick death, every time, still gives up', async () => {
    // An interim is not proof of anything: one that offers a word and dies
    // inside a second, on every start, is not transcribing.
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    for (let i = 0; i < 50 && s.ends === 0; i++) {
        r.result([['uh', false]]);
        await c.advance(10);
        r.onend();
        const before = r.starts.length;
        while (s.ends === 0 && r.starts.length === before) await c.advance(5);
    }
    assert.strictEqual(s.ends, 1, 'restarted for ever');
    assert.strictEqual(s.errors.slice(-1)[0].code, 'keeps-stopping');
});

t('browser: an error a few seconds into every session gives up too', async () => {
    // Each session runs past minRunMs and then fails — long enough to look
    // like a working one if only the run time were counted.
    for (const code of ['network', 'audio-capture']) {
        const { Rec, c, player, engine } = browserEngine();
        const s = sink();
        await engine.start({ lang: 'en-US', ...s.cb });
        const r = Rec.instances[0];
        for (let i = 0; i < 50 && s.ends === 0; i++) {
            await c.advance(4000);
            r.onerror({ error: code });
            r.onend();
            const before = r.starts.length;
            while (s.ends === 0 && r.starts.length === before) await c.advance(50);
        }
        assert.strictEqual(s.ends, 1, `${code}: restarted for ever`);
        assert.strictEqual(s.errors.length, 1, `${code}: retries reached the user`);
        assert.strictEqual(s.errors[0].code, 'keeps-stopping');
        assert.ok(r.starts.length <= 6, `${code}: ${r.starts.length} starts`);
        assert.strictEqual(player.held, false);
    }
});

t('browser: a retune during a backoff waits for it; a new track does not', async () => {
    const { Rec, c, player, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    // Quick deaths until the next restart is a long way off.
    for (let i = 0; i < 3; i++) {
        await c.advance(10);
        r.onend();
        const before = r.starts.length;
        while (r.starts.length === before) await c.advance(5);
    }
    await c.advance(10);
    r.onend();
    const starts = r.starts.length;
    engine.reset();
    await c.advance(0);
    assert.strictEqual(r.starts.length, starts, 'the retune skipped the backoff');
    // ...and the backoff still runs out on its own.
    await c.advance(10000);
    assert.strictEqual(r.starts.length, starts + 1, 'the scheduled restart was lost');
    // A new track is a different source, and is tried at once.
    await c.advance(10);
    r.onend();
    player.emit('recognitiontrack', player.track);
    await c.advance(0);
    assert.strictEqual(r.starts.length, starts + 2, 'a new track waited out the backoff');
    assert.strictEqual(s.ends, 0);
    engine.stop();
});

t('browser: a refused permission stops it, and says how to fix it', async () => {
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    r.onerror({ error: 'not-allowed' });
    if (r.onend) r.onend();
    await c.advance(10000);
    assert.strictEqual(r.starts.length, 1, 'restarted after a permission refusal');
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].action, 'permission');
    assert.strictEqual(s.ends, 1);
});

t('browser: a lost interim is settled when the session ends under it', async () => {
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    r.result([['half a sen', false]]);
    await c.advance(5000);
    r.onend();
    assert.deepStrictEqual(s.results.slice(-1), [{ text: '', final: true }]);
    engine.stop();
});

t('browser: reset aborts and restarts at once, dropping the old station\'s words', async () => {
    const { Rec, c, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    r.result([['old station', false]]);
    engine.reset();
    assert.strictEqual(r.aborts, 1);
    await settle();
    await c.advance(0);
    assert.strictEqual(r.starts.length, 2, 'not restarted after the reset');
    assert.strictEqual(s.errors.length, 0, 'our own abort was reported');
    assert.ok(!s.results.some((x) => x.final), 'the old station\'s interim was settled into the new transcript');
    engine.stop();
});

t('browser: a rebuilt context restarts on the new track', async () => {
    const { Rec, c, player, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    r.result([['mid sentence', false]]);
    const old = player.track;
    player.track = { kind: 'audio', readyState: 'live', id: 99 };
    player.emit('recognitiontrack', player.track);
    await settle();
    await c.advance(0);
    assert.strictEqual(r.starts.length, 2);
    assert.notStrictEqual(r.starts[1][0], old);
    assert.strictEqual(r.starts[1][0].id, 99);
    // Here the interim *is* this station's, and is kept.
    assert.deepStrictEqual(s.results.slice(-1), [{ text: '', final: true }]);
    engine.stop();
});

t('browser: stop releases everything, once, and nothing comes after', async () => {
    const { Rec, c, player, engine } = browserEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const r = Rec.instances[0];
    engine.stop();
    engine.stop();
    assert.strictEqual(s.ends, 1);
    assert.strictEqual(player.held, false);
    assert.strictEqual(player.listeners('recognitiontrack'), 0);
    assert.strictEqual(r.onresult, null);
    await settle();
    await c.advance(10000);
    assert.strictEqual(r.starts.length, 1);
    assert.strictEqual(s.errors.length, 0);
});

t('browser: stopped while the language check is out, it never starts', async () => {
    const { Rec, engine } = browserEngine();
    let answer;
    Rec.available = () => new Promise((r) => { answer = r; });
    const s = sink();
    const started = engine.start({ lang: 'en-US', ...s.cb });
    engine.stop();
    answer('available');
    await started;
    assert.strictEqual(Rec.instances.length, 0);
    assert.strictEqual(s.ends, 1);
});

// --- the host engine ---------------------------------------------------------------

function fakeStt({ rejectWith = null } = {}) {
    const stt = {
        starts: [], pushed: [], resets: 0, stops: 0, rejectWith,
        start(o) { this.starts.push(o); return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve(); },
        push(pcm) { this.pushed.push(pcm); },
        reset() { this.resets++; },
        stop() { this.stops++; },
        languages: async () => ['en-US'],
    };
    return stt;
}

function hostEngine(opts) {
    const stt = fakeStt(opts);
    const player = fakePlayer();
    const c = clock();
    const engine = E.createLocalEngine('host', { player, stt, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
    return { stt, player, c, engine };
}

t('host: started at 16 kHz in the chosen language, fed 100 ms PCM16 chunks', async () => {
    const { stt, player, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'de-DE', ...s.cb });
    assert.strictEqual(engine.kind, 'host');
    assert.strictEqual(stt.starts[0].lang, 'de-DE');
    assert.strictEqual(stt.starts[0].sampleRate, 16000);
    // Half a second at 12 kHz, in 20 ms packets.
    for (let i = 0; i < 25; i++) {
        const p = new Float32Array(240).fill(0.25);
        player.play([p, p], 240, 12000);
    }
    assert.ok(stt.pushed.length >= 4 && stt.pushed.length <= 5, `${stt.pushed.length} chunks`);
    for (const c of stt.pushed) {
        assert.ok(c instanceof Int16Array);
        assert.strictEqual(c.length, 1600);
    }
    stt.starts[0].onResult({ text: 'guten tag', final: true });
    assert.deepStrictEqual(s.results, [{ text: 'guten tag', final: true }]);
    engine.stop();
});

t('host: a rejected start is "couldn\'t start", with the host\'s reason', async () => {
    const { engine, player } = hostEngine({ rejectWith: new Error('Speech permission denied') });
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    assert.strictEqual(s.errors[0].code, 'start-failed');
    assert.strictEqual(s.errors[0].message, 'On-device recognition couldn\'t start: Speech permission denied');
    assert.strictEqual(s.ends, 1);
    assert.strictEqual(player.taps.size, 0, 'still tapping audio after failing');
});

t('host: no audio is pushed before the host is ready', async () => {
    const stt = fakeStt();
    let ready;
    stt.start = (o) => { stt.starts.push(o); return new Promise((r) => { ready = r; }); };
    const player = fakePlayer();
    const engine = E.createLocalEngine('host', { player, stt });
    const started = engine.start({ lang: 'en-US', ...sink().cb });
    for (let i = 0; i < 10; i++) player.play([new Float32Array(1600)], 1600, 16000);
    assert.strictEqual(stt.pushed.length, 0);
    ready();
    await started;
    player.play([new Float32Array(1600)], 1600, 16000);
    assert.strictEqual(stt.pushed.length, 1);
    engine.stop();
});

t('host: its errors — fatal stops, retryable is ignored, the rest is a note', async () => {
    const { stt, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    const h = stt.starts[0];
    h.onError({ code: 'no-speech', message: 'quiet', retryable: true });
    assert.strictEqual(s.errors.length, 0);
    h.onError({ code: 'model-warm', message: 'Model is still loading', fatal: false });
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].fatal, false);
    assert.strictEqual(s.errors[0].message, 'Model is still loading');
    assert.strictEqual(s.ends, 0);
    h.onError({ code: 'not-allowed', message: 'denied', fatal: true });
    assert.strictEqual(s.errors.length, 2);
    assert.strictEqual(s.errors[1].action, 'permission');
    // An app has no address bar: the way to change it is the device's own
    // settings.
    assert.match(s.errors[1].message, /UberSDR in this device's settings/);
    assert.doesNotMatch(s.errors[1].message, /address bar|browser/);
    assert.strictEqual(s.ends, 1);
    assert.strictEqual(stt.stops, 1);
    // Nothing after the end.
    h.onResult({ text: 'late', final: true });
    assert.strictEqual(s.results.length, 0);
});

t('host: an unasked end is restarted; ending on every start gives up', async () => {
    const { stt, c, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    await c.advance(60000);
    stt.starts[0].onEnd();
    await c.advance(1000);
    assert.strictEqual(stt.starts.length, 2, 'not restarted');
    // An end from the old session is not this one's.
    stt.starts[0].onEnd();
    await c.advance(1000);
    assert.strictEqual(stt.starts.length, 2, 'a stale session\'s end was acted on');
    for (let i = 0; i < 50 && s.ends === 0; i++) {
        await c.advance(10);
        stt.starts[stt.starts.length - 1].onEnd();
        const before = stt.starts.length;
        while (s.ends === 0 && stt.starts.length === before) await c.advance(5);
    }
    assert.strictEqual(s.ends, 1);
    assert.strictEqual(s.errors[0].code, 'keeps-stopping');
});

t('host: a language it lacks is named, and an app is not called a browser', async () => {
    const { stt, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'de-DE', ...s.cb });
    stt.starts[0].onError({ code: 'language-not-supported', message: 'no pack', fatal: true });
    assert.match(s.errors[0].message, /^German.* is not available for on-device recognition/);

    const bare = E.createLocalEngine('host', { player: fakePlayer(), stt: { start() {} } });
    const s2 = sink();
    await bare.start({ lang: 'en-US', ...s2.cb });
    assert.strictEqual(s2.errors[0].code, 'unsupported');
    assert.match(s2.errors[0].message, /This app/);
});

t('host: a retryable error ending every session counts, however long it ran', async () => {
    const { stt, c, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    for (let i = 0; i < 50 && s.ends === 0; i++) {
        await c.advance(4000);
        const h = stt.starts[stt.starts.length - 1];
        h.onError({ code: 'network', message: 'blip', retryable: true });
        h.onEnd();
        const before = stt.starts.length;
        while (s.ends === 0 && stt.starts.length === before) await c.advance(50);
    }
    assert.strictEqual(s.ends, 1, 'restarted for ever');
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].code, 'keeps-stopping');

    // Whereas a settled line in each session is a recogniser that works.
    const ok = hostEngine();
    const s2 = sink();
    await ok.engine.start({ lang: 'en-US', ...s2.cb });
    for (let i = 0; i < 20; i++) {
        await ok.c.advance(1000);
        const h = ok.stt.starts[ok.stt.starts.length - 1];
        h.onResult({ text: 'over', final: true });
        h.onError({ code: 'network', retryable: true });
        h.onEnd();
        await ok.c.advance(1000);
    }
    assert.strictEqual(s2.ends, 0, 'gave up on a host that was transcribing');
    ok.engine.stop();
});

t('host: reset and stop reach the host', async () => {
    const { stt, player, engine } = hostEngine();
    const s = sink();
    await engine.start({ lang: 'en-US', ...s.cb });
    engine.reset();
    assert.strictEqual(stt.resets, 1);
    engine.stop();
    assert.strictEqual(stt.stops, 1);
    assert.strictEqual(player.taps.size, 0);
    assert.strictEqual(s.ends, 1);
    engine.stop();
    assert.strictEqual(s.ends, 1);
});

// --- translation -------------------------------------------------------------------

t('the translator: the host\'s, then Chrome\'s', () => {
    const host = { translate() {}, availability() {} };
    const Translator = { create() {}, availability() {} };
    assert.strictEqual(T.translatorKind({ ubersdrDesktop: { translate: host }, Translator }), 'host');
    assert.strictEqual(T.translatorKind({ Translator }), 'browser');
    assert.strictEqual(T.translatorKind({}), null);
});

t('translation status uses the Translator API\'s option names', async () => {
    const seen = [];
    const win = { Translator: { create() {}, availability: async (o) => { seen.push(o); return 'downloadable'; } } };
    assert.strictEqual(await T.translationStatus({ source: 'de', target: 'en' }, win), 'downloadable');
    assert.deepStrictEqual(seen[0], { sourceLanguage: 'de', targetLanguage: 'en' });
    assert.strictEqual(await T.translationStatus(null, win), 'unavailable');
    win.Translator.availability = async () => { throw new Error('x'); };
    assert.strictEqual(await T.translationStatus({ source: 'de', target: 'en' }, win), 'unavailable');
    const host = { ubersdrDesktop: { translate: { translate() {}, availability: async (s, d) => (s === 'de' && d === 'en' ? 'available' : 'nope') } } };
    assert.strictEqual(await T.translationStatus({ source: 'de', target: 'en' }, host), 'available');
    assert.strictEqual(await T.translationStatus({ source: 'fr', target: 'en' }, host), 'unavailable');
});

t('Chrome\'s translator is created with the pair and its download is heard', async () => {
    let made;
    const progress = [];
    const win = {
        Translator: {
            availability: async () => 'available',
            create: async (o) => {
                made = o;
                const listeners = [];
                o.monitor({ addEventListener: (type, fn) => listeners.push(fn) });
                listeners.forEach((fn) => fn({ loaded: 0.5 }));
                return { translate: async (s) => `[${s}]`, destroy() { made.destroyed = true; } };
            },
        },
    };
    const tr = await T.openTranslator({ source: 'de', target: 'en' }, { win, onProgress: (p) => progress.push(p) });
    assert.strictEqual(made.sourceLanguage, 'de');
    assert.strictEqual(made.targetLanguage, 'en');
    assert.deepStrictEqual(progress, [0.5]);
    assert.strictEqual(await tr.translate('hallo'), '[hallo]');
    tr.destroy();
    assert.ok(made.destroyed);
});

t('the host\'s translator is called with text, source and target', async () => {
    const calls = [];
    const win = { ubersdrDesktop: { translate: { translate: async (...a) => { calls.push(a); return 'hello'; } } } };
    const tr = await T.openTranslator({ source: 'de', target: 'en' }, { win });
    assert.strictEqual(await tr.translate('hallo'), 'hello');
    assert.deepStrictEqual(calls[0], ['hallo', 'de', 'en']);
});

t('lines come back translated, in the order they were spoken', async () => {
    const delays = { one: 30, two: 1, three: 10 };
    const open = async () => ({
        translate: (s) => new Promise((r) => setTimeout(() => r(s.toUpperCase()), delays[s])),
        destroy() {},
    });
    const lt = T.createLineTranslator({ pair: { source: 'de', target: 'en' }, open });
    const order = [];
    await Promise.all(['one', 'two', 'three'].map((s) => lt.translate(s).then((r) => order.push(r.text))));
    assert.deepStrictEqual(order, ['ONE', 'TWO', 'THREE']);
    lt.destroy();
});

t('a failing translation keeps the line as spoken, and notes it once', async () => {
    const notes = [];
    let fail = true;
    const open = async () => ({
        translate: async (s) => { if (fail) throw Object.assign(new Error('x'), { name: 'OperationError' }); return 'ok'; },
        destroy() {},
    });
    const lt = T.createLineTranslator({ pair: { source: 'de', target: 'en' }, open, onNote: (n) => notes.push(n) });
    assert.deepStrictEqual(await lt.translate('eins'), { text: 'eins', translated: false });
    assert.deepStrictEqual(await lt.translate('zwei'), { text: 'zwei', translated: false });
    assert.strictEqual(notes.length, 1, 'one note per run of failures');
    assert.strictEqual(notes[0].code, 'translate-failed');
    assert.strictEqual(notes[0].fatal, false);
    assert.match(notes[0].message, /could not be loaded/);
    fail = false;
    assert.deepStrictEqual(await lt.translate('drei'), { text: 'ok', translated: true });
    assert.deepStrictEqual(notes.slice(1), [null], 'the note was not taken down once it worked');
});

t('a translator that will not open is tried once, not once per line', async () => {
    let opens = 0;
    const notes = [];
    const open = async () => { opens++; throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' }); };
    const lt = T.createLineTranslator({ pair: { source: 'de', target: 'en' }, open, onNote: (n) => notes.push(n) });
    for (const s of ['a', 'b', 'c']) assert.strictEqual((await lt.translate(s)).text, s);
    assert.strictEqual(opens, 1);
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].message, /click/);
});

t('no pair, or nothing to say: passed through untouched', async () => {
    const lt = T.createLineTranslator({ pair: null, open: async () => { throw new Error('should not open'); } });
    assert.deepStrictEqual(await lt.translate('hello'), { text: 'hello', translated: false });
    const lt2 = T.createLineTranslator({ pair: { source: 'de', target: 'en' }, open: async () => { throw new Error('no'); } });
    assert.deepStrictEqual(await lt2.translate('  '), { text: '  ', translated: false });
});

t('a translator still downloading does not hold lines back', async () => {
    // The model is downloading and create() has not answered: lines are shown
    // as spoken — the first after a short wait, the rest at once — with a
    // note, and translated again once it opens.
    let opened;
    const open = () => new Promise((r) => { opened = r; });
    const notes = [];
    const lt = T.createLineTranslator({
        pair: { source: 'de', target: 'en' }, open, onNote: (n) => notes.push(n), limits: { openMs: 20, lineMs: 50 },
    });
    const t0 = Date.now();
    assert.deepStrictEqual(await lt.translate('eins'), { text: 'eins', translated: false });
    assert.deepStrictEqual(await lt.translate('zwei'), { text: 'zwei', translated: false });
    assert.ok(Date.now() - t0 < 500, 'lines queued behind the download');
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].message, /still loading.*shown as spoken/);
    assert.strictEqual(notes[0].fatal, false);
    opened({ translate: async (s) => s.toUpperCase(), destroy() {} });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(await lt.translate('drei'), { text: 'DREI', translated: true });
    assert.deepStrictEqual(notes.slice(1), [null], 'the note outlived the download');
    lt.destroy();
});

t('a translation that never answers is given up on, and the next line still goes', async () => {
    const notes = [];
    let hang = true;
    const open = async () => ({
        translate: (s) => (hang ? new Promise(() => {}) : Promise.resolve(`[${s}]`)),
        destroy() {},
    });
    const lt = T.createLineTranslator({
        pair: { source: 'de', target: 'en' }, open, onNote: (n) => notes.push(n), limits: { openMs: 50, lineMs: 20 },
    });
    assert.deepStrictEqual(await lt.translate('eins'), { text: 'eins', translated: false });
    assert.match(notes[0].message, /not answering/);
    hang = false;
    assert.deepStrictEqual(await lt.translate('zwei'), { text: '[zwei]', translated: true });
    lt.destroy();
});

t('a model that fails after "still loading" says so', async () => {
    let fail;
    const open = () => new Promise((resolve, reject) => { fail = reject; });
    const notes = [];
    const lt = T.createLineTranslator({
        pair: { source: 'de', target: 'en' }, open, onNote: (n) => notes.push(n), limits: { openMs: 10, lineMs: 50 },
    });
    await lt.translate('eins');
    fail(Object.assign(new Error('x'), { name: 'NetworkError' }));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await lt.translate('zwei')).text, 'zwei');
    assert.strictEqual(notes.length, 2);
    assert.match(notes[1].message, /could not be loaded/);
});

t('prepare opens the translator ahead of the first line', async () => {
    let opens = 0;
    const open = async () => { opens++; return { translate: async (s) => s, destroy() {} }; };
    const lt = T.createLineTranslator({ pair: { source: 'de', target: 'en' }, open });
    await lt.prepare();
    assert.strictEqual(opens, 1);
    await lt.translate('x');
    assert.strictEqual(opens, 1);
});

// --- the player's recognition track ------------------------------------------------

function fakeContext({ streams = true } = {}) {
    const node = (kind) => ({
        kind,
        out: new Set(),
        gain: { value: 1, setTargetAtTime() {} },
        connect(to) { this.out.add(to); return to; },
        // As Web Audio has it: with an argument, only that connection goes.
        disconnect(to) { if (to === undefined) this.out.clear(); else this.out.delete(to); },
    });
    const ctx = {
        sampleRate: 48000,
        currentTime: 0,
        state: 'running',
        destination: node('destination'),
        createGain: () => node('gain'),
        createScriptProcessor: () => node('script'),
        createChannelSplitter: () => node('splitter'),
        createChannelMerger: () => node('merger'),
        createAnalyser: () => ({ ...node('analyser'), fftSize: 2048, smoothingTimeConstant: 0.5, getFloatTimeDomainData() {} }),
        createBufferSource: () => node('source'),
        createDelay: () => node('delay'),
        createBiquadFilter: () => ({ ...node('biquad'), frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, type: 'peaking' }),
        createDynamicsCompressor: () => ({ ...node('comp'), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, reduction: 0 }),
        resume: () => Promise.resolve(),
        close: () => Promise.resolve(),
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        dests: [],
    };
    if (streams) {
        ctx.createMediaStreamDestination = () => {
            const d = node('streamdest');
            const track = { kind: 'audio', readyState: 'live', stopped: 0, stop() { this.stopped++; this.readyState = 'ended'; } };
            d.stream = { getAudioTracks: () => [track] };
            d.track = track;
            ctx.dests.push(d);
            return d;
        };
    }
    return ctx;
}

function reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of from.out || []) if (reaches(next, to, seen)) return true;
    return false;
}

function playerOn(ctx) {
    const player = new AudioPlayer();
    window.AudioContext = function () { return ctx; };
    player._createContext(48000);
    return player;
}

t('the recognition feed is taken before volume, mute and the duck', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    const track = p.recognitionTrack();
    assert.ok(track, 'no track');
    const dest = ctx.dests[0];
    assert.strictEqual(track, dest.track);
    assert.ok(reaches(p.head, dest), 'the receiver audio does not reach the recogniser');
    assert.ok(!reaches(p.gain, dest), 'the feed is after the volume control — muting would silence the recogniser');
    assert.ok(!reaches(p.duck, dest), 'the feed is after the duck — reading aloud would silence it');
    assert.strictEqual(dest.channelCount, 1);
    assert.strictEqual(dest.channelCountMode, 'explicit');
    // And the receiver's own audio is untouched by it.
    assert.ok(reaches(p.head, p.gain) && reaches(p.gain, ctx.destination));
});

t('the same track until released; released, it leaves the graph', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    const a = p.recognitionTrack();
    assert.strictEqual(p.recognitionTrack(), a);
    assert.strictEqual(ctx.dests.length, 1, 'a second destination was built');
    p.releaseRecognitionTrack();
    assert.ok(!reaches(p.head, ctx.dests[0]), 'still connected after release');
    assert.strictEqual(a.stopped, 1);
    assert.ok(reaches(p.head, p.gain), 'releasing cut the receiver audio');
    p.releaseRecognitionTrack();
});

t('it is never built unasked', () => {
    const ctx = fakeContext();
    playerOn(ctx);
    assert.strictEqual(ctx.dests.length, 0);
});

t('a filter change keeps the feed connected', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.recognitionTrack();
    const dest = ctx.dests[0];
    const spec = {
        bandpass: { enabled: true, center: 1500, width: 2400, stages: 2 },
        notch: { enabled: false, items: [] },
        eq: { enabled: false, bands: [] },
    };
    p.setFilters(spec);
    assert.ok(p.chain, 'no chain was built');
    assert.ok(reaches(p.head, dest), 'switching a filter disconnected the recogniser');
    assert.ok(reaches(p.chain.output, dest), 'the feed skips the filters');
    p.setFilters(null);
    assert.ok(reaches(p.head, dest), 'switching the filters off disconnected the recogniser');
});

t('a rebuilt context gets a new feed, announced', () => {
    const first = fakeContext();
    const p = playerOn(first);
    const old = p.recognitionTrack();
    const seen = [];
    p.on('recognitiontrack', (track) => seen.push(track));
    const second = fakeContext();
    window.AudioContext = function () { return second; };
    p._ensureContext(12000);
    assert.strictEqual(seen.length, 1, 'the new track was not announced');
    assert.strictEqual(seen[0], second.dests[0].track);
    assert.strictEqual(p.recognitionTrack(), seen[0]);
    assert.strictEqual(old.stopped, 1, 'the old track was left running');
    assert.ok(reaches(p.head, second.dests[0]));
});

t('released, a rebuild builds nothing', () => {
    const first = fakeContext();
    const p = playerOn(first);
    p.recognitionTrack();
    p.releaseRecognitionTrack();
    const second = fakeContext();
    window.AudioContext = function () { return second; };
    let announced = 0;
    p.on('recognitiontrack', () => announced++);
    p._ensureContext(12000);
    assert.strictEqual(second.dests.length, 0);
    assert.strictEqual(announced, 0);
});

t('no graph, or a browser without stream destinations: null', () => {
    assert.strictEqual(new AudioPlayer().recognitionTrack(), null);
    const p = playerOn(fakeContext({ streams: false }));
    assert.strictEqual(p.recognitionTrack(), null);
});

chain.then(() => {
    if (process.exitCode) console.log('\nwhisper engine tests FAILED');
    else console.log(`\nall ${pass} whisper engine tests passed`);
    // As in noisegraph.test.js: every context the player tests build leaves a
    // clip-watch interval behind, and nothing here is a receiver that would
    // ever stop one.
    process.exit(process.exitCode || 0);
});
