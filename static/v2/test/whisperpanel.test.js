// The Speech-to-Text extension renders, and picks the right place to
// transcribe.
//
// The pure halves — which source to use, how a recogniser's results become
// segments, the engines themselves — have tests of their own
// (whisperlocal.test.js, whisperengines.test.js). What only a render can show
// is that the component wires them together: that local is what starts by
// default, that an on-device result actually reaches the transcript, that the
// server path still attaches exactly as before, and that a local failure puts
// a note on screen with the way out beside it. See hookStub.js for what
// "renders" means here.
//
// Every render's cleanups are run before the next render: the stub runs every
// effect on every render, so a render left mounted keeps an engine running
// underneath the next one — and a leaked render either hangs this file or
// breaks a test somewhere else.

const assert = require('assert');

// Before the bundle: the module graph behind an extension reaches the display
// settings and the radio, and both read the browser at import time.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node', language: 'en-GB' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { deep, render, reset, words, WhisperExtension, dxcluster } = require('./.build/whisperpanel.cjs');

// The control socket, faked: connected, and recording what is sent, so the
// server path can be seen attaching without a server.
const sent = [];
Object.defineProperty(dxcluster, 'connected', { get: () => true, configurable: true });
dxcluster.hold = () => () => {};
dxcluster.refresh = () => false;
dxcluster.send = (msg) => { sent.push(msg); return true; };
const attaches = () => sent.filter((m) => m && m.extension_name === 'whisper');

// The receiver's AudioPlayer, as far as this extension touches it.
const player = {
    analyser: null,
    onAudio: () => () => {},
    on: () => () => {},
    setDucked() {},
    acquireAnalyser() {},
    releaseAnalyser() {},
    recognitionTrack: () => null,
    releaseRecognitionTrack() {},
};

// A host app's recogniser (window.ubersdrDesktop.stt), recording each start
// and keeping the callbacks of the latest so a test can speak through them.
function hostStt({ rejectWith } = {}) {
    const h = {
        starts: [],
        stops: 0,
        resets: 0,
        cb: null,
        languages: () => Promise.resolve(['en-GB', 'de-DE']),
        start(o) {
            h.starts.push(o);
            h.cb = o;
            return rejectWith ? Promise.reject(new Error(rejectWith)) : Promise.resolve();
        },
        push() {},
        reset() { h.resets += 1; },
        stop() { h.stops += 1; },
    };
    return h;
}

// One object answers useRadio and useExtensions both — the stub's useContext
// cannot tell two contexts apart. `list` is ExtensionsContext's annotated
// registry, of which only this entry matters.
function context({ serverEnabled = true } = {}) {
    return {
        running: true,
        audioState: 'open',
        tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        serverInfo: {},
        player,
        actions: {},
        list: [{ id: 'whisper', serverEnabled, enabled: true }],
    };
}

const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// A render that is unmounted before the next: see the top of the file.
let mounted = null;
function show(ctx, props) {
    if (mounted) for (const off of mounted.cleanups) off();
    mounted = render(WhisperExtension, props || {}, ctx);
    return mounted.tree;
}
function unmount() {
    if (mounted) for (const off of mounted.cleanups) off();
    mounted = null;
}
function fresh() {
    unmount();
    reset();
    store.clear();
    sent.length = 0;
    delete globalThis.ubersdrDesktop;
    delete globalThis.SpeechRecognition;
}

const buttons = (tree) => deep(tree).filter((n) => n.type === 'button');
const button = (tree, text) => buttons(tree).find((b) => words(b).trim() === text);
const sources = (tree) => buttons(tree).filter((b) => /segmented__item/.test(b.props.className || '')
    && /^(On this device|Server)$/.test(words(b).trim()));
const activeSource = (tree) => {
    const b = sources(tree).find((x) => /is-active/.test(x.props.className));
    return b ? words(b).trim() : null;
};
const lines = (tree) => deep(tree).filter((n) => /\bstt__line\b/.test(n.props.className || ''));
const notes = (tree) => deep(tree).filter((n) => /\bnote--warn\b/.test(n.props.className || ''));

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('local is the default, and an on-device result reaches the transcript', async () => {
    fresh();
    const host = hostStt();
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();

    let tree = show(ctx);
    assert.strictEqual(activeSource(tree), 'On this device');
    // Local hides what only the server can do.
    assert.ok(!button(tree, 'Summarise'), 'Summarise is offered on the device');
    // The spoken-language picker is there, once the device has listed them.
    await settle();
    tree = show(ctx);
    const spoken = deep(tree).find((n) => n.type === 'select' && n.props.value && /-/.test(n.props.value));
    assert.ok(spoken, 'no spoken-language picker');
    assert.strictEqual(spoken.props.value, 'en-GB');

    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    assert.strictEqual(host.starts.length, 1, 'the host recogniser was not started');
    assert.strictEqual(host.starts[0].lang, 'en-GB');
    assert.strictEqual(host.starts[0].sampleRate, 16000);
    assert.deepStrictEqual(attaches(), [], 'it attached on the server as well');

    // An interim result is the live line...
    host.cb.onResult({ text: 'hello there', final: false });
    tree = show(ctx);
    let ls = lines(tree);
    assert.strictEqual(ls.length, 1, `lines: ${ls.length}`);
    assert.match(ls[0].props.className, /stt__line--live/);
    assert.match(words(ls[0]), /hello there/);
    const status = deep(tree).find((n) => /tp__status/.test(n.props.className || ''));
    assert.match(String(status.props.title), /on this device/);

    // ...and the final settles it, with the full stop a device leaves off.
    await settle();
    host.cb.onResult({ text: 'hello there world', final: true });
    tree = show(ctx);
    ls = lines(tree);
    assert.strictEqual(ls.length, 1, `lines: ${ls.length}`);
    assert.ok(!/stt__line--live/.test(ls[0].props.className), 'the final is still live');
    assert.match(words(ls[0]), /hello there world\./);
    assert.deepStrictEqual(notes(tree), [], 'a note appeared on a working run');
    unmount();
});

t('with Server chosen, it attaches on the server as before', async () => {
    fresh();
    const host = hostStt();
    globalThis.ubersdrDesktop = { stt: host };
    store.set('ubersdr.v2.stt.source', 'server');
    const ctx = context();

    let tree = show(ctx);
    assert.strictEqual(activeSource(tree), 'Server');
    assert.ok(button(tree, 'Summarise'), 'Summarise is missing on the server');
    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    const a = attaches();
    assert.strictEqual(a.length, 1, JSON.stringify(sent));
    assert.deepStrictEqual(a[0].params, { language: 'en' });
    assert.strictEqual(host.starts.length, 0, 'the device recogniser ran as well');
    const status = deep(tree).find((n) => /tp__status/.test(n.props.className || ''));
    assert.match(String(status.props.title), /on the server/);
    unmount();
});

t('a local start failure is a note, with the server as the way out', async () => {
    fresh();
    const host = hostStt({ rejectWith: 'the recogniser is busy' });
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();

    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    // Not still trying: a failed start turns Start back on.
    assert.ok(button(tree, 'Start'), 'it is still running after a failed start');
    const text = notes(tree).map(words).join(' | ');
    assert.match(text, /On-device recognition couldn't start: the recogniser is busy/);
    const way = button(tree, 'Use server instead');
    assert.ok(way, 'no Use server instead');

    way.props.onClick();
    tree = show(ctx);
    await settle();
    assert.strictEqual(activeSource(tree), 'Server');
    assert.strictEqual(store.get('ubersdr.v2.stt.source'), 'server', 'the choice was not remembered');
    assert.strictEqual(attaches().length, 1, 'switching did not start the server transcriber');
    assert.deepStrictEqual(notes(tree), [], 'the local note outlived the switch');
    unmount();

    // Where the receiver has no transcriber, there is no way out to offer.
    fresh();
    globalThis.ubersdrDesktop = { stt: hostStt({ rejectWith: 'nope' }) };
    const alone = context({ serverEnabled: false });
    tree = show(alone);
    await settle();
    tree = show(alone);
    assert.deepStrictEqual(sources(tree), [], 'a choice of one was drawn');
    button(tree, 'Start').props.onClick();
    tree = show(alone);
    await settle();
    tree = show(alone);
    assert.match(notes(tree).map(words).join(' '), /couldn't start: nope/);
    assert.ok(!button(tree, 'Use server instead'), 'offered a server that is not there');
    unmount();
});

t('without a local recogniser, the server runs and local says why not', async () => {
    fresh();
    const ctx = context();
    const tree = show(ctx);
    assert.strictEqual(activeSource(tree), 'Server');
    const loc = sources(tree).find((b) => words(b).trim() === 'On this device');
    assert.ok(loc, 'local is not shown');
    assert.strictEqual(loc.props.disabled, true);
    assert.match(String(loc.props.title), /Not supported/);
    // In words as well: a phone cannot hover over a disabled button.
    const why = deep(tree).find((n) => /\bstt__source-why\b/.test(n.props.className || ''));
    assert.ok(why, 'the reason is only a tooltip');
    assert.match(words(why), /Not supported/);
    assert.ok(button(tree, 'Summarise'));
    unmount();
});

t('Start before the device has listed its languages waits for the list', async () => {
    fresh();
    // en-GB is what the locale suggests; the device only has en-US. Starting
    // on the guess would fail — or restart once the list arrived.
    const host = hostStt();
    let answer;
    host.languages = () => new Promise((r) => { answer = r; });
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();

    let tree = show(ctx);
    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    assert.strictEqual(host.starts.length, 0, 'started on a guessed language');
    assert.ok(button(tree, 'Stop'), 'Start did not take');
    const status = deep(tree).find((n) => /tp__status/.test(n.props.className || ''));
    assert.strictEqual(words(status).trim(), 'Starting…');

    answer(['en-US']);
    await settle();
    tree = show(ctx);
    await settle();
    assert.strictEqual(host.starts.length, 1, 'never started');
    assert.strictEqual(host.starts[0].lang, 'en-US');
    assert.deepStrictEqual(notes(tree), []);
    unmount();
});

// Web Speech with on-device recognition, answering every language with
// `status(lang)`.
function webSpeech(status) {
    function Rec() {}
    Rec.prototype.processLocally = false;
    Rec.prototype.start = function start() {};
    Rec.prototype.abort = function abort() {};
    Rec.available = ({ langs }) => Promise.resolve(status(langs[0]));
    return Rec;
}

t('a device with no on-device languages: the server where there is one, a note where not', async () => {
    fresh();
    globalThis.SpeechRecognition = webSpeech(() => 'unavailable');
    const ctx = context();
    let tree = show(ctx);
    // Twice: a browser's recogniser is probed (probeBrowserTrack) before
    // local is on offer, and only then are its languages asked for.
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.strictEqual(activeSource(tree), 'Server', 'local stayed the default with nothing it can recognise');
    const loc = sources(tree).find((b) => words(b).trim() === 'On this device');
    assert.strictEqual(loc.props.disabled, true);
    const why = deep(tree).find((n) => /\bstt__source-why\b/.test(n.props.className || ''));
    assert.match(words(why), /No languages/);
    unmount();

    // A host with an empty list, on a receiver with no transcriber.
    fresh();
    const host = hostStt();
    host.languages = () => Promise.resolve([]);
    globalThis.ubersdrDesktop = { stt: host };
    const alone = context({ serverEnabled: false });
    tree = show(alone);
    await settle();
    tree = show(alone);
    assert.match(notes(tree).map(words).join(' '), /This app has no languages it can recognise on the device/);
    assert.strictEqual(button(tree, 'Start').props.disabled, true, 'Start offered with nothing to recognise');
    const spoken = deep(tree).find((n) => n.type === 'select' && n.props.disabled);
    assert.ok(spoken, 'the spoken menu still offers a language');
    assert.match(words(spoken), /None on this device/);
    assert.ok(!/available/.test(words(spoken)));
    unmount();
});

t('a browser whose start(track) fails is not offered local, and says why', async () => {
    // Chrome 145 on Linux: every feature test passes, English is installed,
    // and every start(track) is answered with 'network' at once.
    fresh();
    const Rec = webSpeech(() => 'available');
    Rec.prototype.start = function start() {
        setImmediate(() => { if (this.onerror) this.onerror({ error: 'network' }); });
    };
    globalThis.SpeechRecognition = Rec;
    globalThis.AudioContext = function AudioContext() {};
    globalThis.AudioContext.prototype.createMediaStreamDestination = () => ({
        stream: { getAudioTracks: () => [{ stop() {} }] },
    });
    globalThis.AudioContext.prototype.close = () => {};
    try {
        const ctx = context();
        let tree = show(ctx);
        await settle();
        tree = show(ctx);
        await settle();
        tree = show(ctx);
        assert.strictEqual(activeSource(tree), 'Server', 'local stayed the default with a recogniser that cannot take a track');
        const loc = sources(tree).find((b) => words(b).trim() === 'On this device');
        assert.strictEqual(loc.props.disabled, true);
        const why = deep(tree).find((n) => /\bstt__source-why\b/.test(n.props.className || ''));
        assert.match(words(why), /can't transcribe the receiver's audio on the device/);
        unmount();
    } finally {
        delete globalThis.AudioContext;
    }
});

// A host whose translator answers only when the test says so.
function hostTranslate() {
    const tr = { pending: [] };
    tr.translate = (text) => new Promise((resolve) => tr.pending.push({ text, resolve }));
    return tr;
}

t('a translation that comes back after Stop is dropped', async () => {
    fresh();
    store.set('ubersdr.v2.stt.spoken', 'de-DE');
    const host = hostStt();
    const tr = hostTranslate();
    globalThis.ubersdrDesktop = { stt: host, translate: tr };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    host.cb.onResult({ text: 'guten Tag', final: true });
    await settle();
    assert.strictEqual(tr.pending.length, 1, 'the line was not sent to the translator');

    button(tree, 'Stop').props.onClick();
    tree = show(ctx);
    tr.pending[0].resolve('good day');
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(lines(tree), [], 'a line landed after Stop');
    unmount();
});

t('a translation from a replaced session keeps the new session\'s live line', async () => {
    fresh();
    store.set('ubersdr.v2.stt.spoken', 'de-DE');
    const host = hostStt();
    const tr = hostTranslate();
    globalThis.ubersdrDesktop = { stt: host, translate: tr };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    button(tree, 'Start').props.onClick();
    tree = show(ctx);
    await settle();
    host.cb.onResult({ text: 'guten Tag', final: true });
    await settle();

    // A new session — the stub's every render is one, as a change of spoken
    // language or an audio reconnect would be — that is already mid-sentence.
    tree = show(ctx);
    await settle();
    assert.strictEqual(host.starts.length, 2);
    host.cb.onResult({ text: 'wie geht', final: false });
    tr.pending[0].resolve('good day');
    await settle();
    tree = show(ctx);
    const ls = lines(tree);
    assert.strictEqual(ls.length, 2, ls.map(words).join(' | '));
    assert.match(words(ls[0]), /good day/);
    assert.ok(!/stt__line--live/.test(ls[0].props.className));
    assert.match(ls[1].props.className, /stt__line--live/, 'the new session\'s live line was wiped');
    assert.match(words(ls[1]), /wie geht/);
    for (const p of tr.pending) p.resolve('x');
    unmount();
});

t('a language that needs a download says so before Start, and Install starts it', async () => {
    fresh();
    // Web Speech with on-device recognition, as Chrome has it: English is a
    // download away, and nothing else is on offer.
    let installed = false;
    const started = [];
    function Rec() {}
    Rec.prototype.processLocally = false;
    Rec.prototype.start = function start(track) { started.push({ lang: this.lang, local: this.processLocally, track }); };
    Rec.prototype.abort = function abort() {};
    Rec.available = ({ langs, processLocally }) => {
        assert.strictEqual(processLocally, true, 'asked about cloud recognition');
        if (langs[0] !== 'en-GB') return Promise.resolve('unavailable');
        return Promise.resolve(installed ? 'available' : 'downloadable');
    };
    Rec.install = () => { installed = true; return Promise.resolve(true); };
    globalThis.SpeechRecognition = Rec;
    const track = { kind: 'audio' };
    const ctx = { ...context(), player: { ...player, recognitionTrack: () => track } };

    let tree = show(ctx);
    // Probed first, then asked for its languages: see the test above.
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.strictEqual(activeSource(tree), 'On this device');
    assert.match(notes(tree).map(words).join(' '), /one-off download/);
    const install = button(tree, 'Install');
    assert.ok(install, 'no Install button');
    assert.ok(button(tree, 'Use server instead'), 'no way out beside it');

    install.props.onClick();
    await settle();
    tree = show(ctx);
    await settle();
    assert.ok(installed, 'install() was not called');
    // The device is asked again what it has, and the recogniser waits for
    // the answer rather than starting on the one from before the install.
    assert.strictEqual(started.length, 0, 'started before the device had answered again');
    tree = show(ctx);
    await settle();
    assert.ok(button(tree, 'Stop'), 'it did not start after installing');
    assert.strictEqual(started.length, 1, `starts: ${started.length}`);
    assert.deepStrictEqual(started[0], { lang: 'en-GB', local: true, track });
    unmount();
});

t('the minimal view renders in both sources', async () => {
    for (const saved of [null, 'server']) {
        fresh();
        globalThis.ubersdrDesktop = { stt: hostStt() };
        if (saved) store.set('ubersdr.v2.stt.source', saved);
        const tree = show(context(), { minimal: true });
        assert.ok(button(tree, 'Start'), `${saved}: no Start`);
        assert.deepStrictEqual(sources(tree), [], `${saved}: the selector is in the minimal view`);
    }
    unmount();
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message));
            process.exitCode = 1;
        }
    }
    unmount();
    console.log(`\n${pass} passed`);
})();
