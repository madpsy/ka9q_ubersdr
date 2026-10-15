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

const { deep, render, rerender, reset, words, WhisperExtension, dxcluster } = require('./.build/whisperpanel.cjs');

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
// A render that follows the last as React would: an effect whose deps did not
// change is left running (hookStub.js rerender). For what show() cannot see,
// since it runs every effect afresh: whether something restarts.
function keep(ctx, props) {
    mounted = mounted ? rerender(WhisperExtension, props || {}, ctx, mounted) : render(WhisperExtension, props || {}, ctx);
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

t('translation languages that are missing: the note, and the host\'s page for adding them where it has one', async () => {
    for (const withSettings of [true, false]) {
        fresh();
        store.set('ubersdr.v2.stt.spoken', 'de-DE');
        const host = hostStt();
        const tr = hostTranslate();
        tr.availability = () => Promise.resolve('downloadable');
        let opened = 0;
        // Android's host has openSettings; iOS's does not.
        if (withSettings) tr.openSettings = () => { opened += 1; };
        globalThis.ubersdrDesktop = { stt: host, translate: tr };
        const ctx = context();
        let tree = show(ctx);
        await settle();
        tree = show(ctx);
        button(tree, 'Start').props.onClick();
        tree = show(ctx);
        await settle();
        // As React would re-render: show() would run the translator's effect
        // afresh, and its cleanup takes the note down.
        tree = keep(ctx);
        assert.match(notes(tree).map(words).join(' '), /aren't on this device yet/);
        const add = button(tree, 'Add languages');
        if (withSettings) {
            assert.ok(add, 'no Add languages button');
            add.props.onClick();
            assert.strictEqual(opened, 1);
        } else {
            assert.ok(!add, 'a button for a host with no settings page');
        }
        assert.ok(button(tree, 'Use server instead'), 'no way out beside it');
        unmount();
    }
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

// A host recogniser with a choice of models, as the desktop client's is: base
// built in, small a download away. Downloads finish when the test says.
function hostWithModels() {
    const h = hostStt();
    h.list = [
        { id: 'base', label: 'Base', sizeBytes: 59707625, installed: true, active: true, builtIn: true },
        { id: 'small', label: 'Small', sizeBytes: 190085487, installed: false, active: false, builtIn: false },
    ];
    h.calls = [];
    h.models = () => Promise.resolve(h.list.map((m) => ({ ...m })));
    h.installModel = (id, onProgress) => {
        h.calls.push(['install', id]);
        h.progress = onProgress;
        return new Promise((resolve, reject) => {
            h.finish = () => {
                h.list = h.list.map((m) => (m.id === id ? { ...m, installed: true } : m));
                resolve();
            };
            h.fail = (msg, code) => {
                const e = new Error(msg);
                if (code) e.code = code;
                reject(e);
            };
        });
    };
    h.cancelInstall = (id) => { h.calls.push(['cancel', id]); h.fail('Download cancelled.'); };
    h.setModel = (id) => {
        h.calls.push(['set', id]);
        h.list = h.list.map((m) => ({ ...m, active: m.id === id }));
        return Promise.resolve();
    };
    h.removeModel = (id) => {
        h.calls.push(['remove', id]);
        const was = h.list.find((m) => m.id === id);
        h.list = h.list.map((m) => {
            if (m.id === id) return { ...m, installed: false, active: false };
            return was && was.active && m.builtIn ? { ...m, active: true } : m;
        });
        return Promise.resolve();
    };
    return h;
}

const modelMenu = (tree) => deep(tree).find((n) => n.type === 'select' && /\bstt__model\b/.test(n.props.className || ''));
const optionTexts = (sel) => deep(sel).filter((n) => n.type === 'option').map((o) => words(o).trim());
const progressText = (tree) => {
    const p = deep(tree).find((n) => /\bstt__model-progress\b/.test(n.props.className || ''));
    return p ? words(p).trim() : null;
};

t('a host with models: the Model setting, a download with progress, then switched to', async () => {
    fresh();
    const host = hostWithModels();
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    let menu = modelMenu(tree);
    assert.ok(menu, 'no Model setting');
    assert.strictEqual(menu.props.value, 'base');
    assert.deepStrictEqual(optionTexts(menu), ['Base — built in', 'Small — 190 MB, not downloaded']);
    // Nothing to download or remove while the built-in one is selected.
    assert.ok(!button(tree, 'Download') && !button(tree, 'Remove'));

    // Choosing one that is not there only selects it: the download is a
    // button press, not a side effect of the menu.
    menu.props.onChange({ target: { value: 'small' } });
    tree = show(ctx);
    await settle();
    assert.deepStrictEqual(host.calls, []);
    assert.strictEqual(modelMenu(tree).props.value, 'small');
    const dl = button(tree, 'Download');
    assert.ok(dl, 'no Download for a model that is not there');

    button(tree, 'Download').props.onClick();
    tree = show(ctx);
    await settle();
    assert.deepStrictEqual(host.calls, [['install', 'small']]);
    assert.strictEqual(progressText(tree), 'Downloading 0%');
    assert.strictEqual(modelMenu(tree).props.disabled, true, 'the menu can change mid-download');
    host.progress({ received: 95042744, total: 190085487 });
    tree = show(ctx);
    assert.strictEqual(progressText(tree), 'Downloading 50%');
    assert.ok(button(tree, 'Cancel'), 'no Cancel');

    host.finish();
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    // Downloaded, and switched to, since choosing it is what started this.
    assert.deepStrictEqual(host.calls, [['install', 'small'], ['set', 'small']]);
    assert.strictEqual(progressText(tree), null);
    menu = modelMenu(tree);
    assert.strictEqual(menu.props.value, 'small');
    assert.deepStrictEqual(optionTexts(menu), ['Base — built in', 'Small — 190 MB']);
    assert.ok(button(tree, 'Remove'), 'no Remove for a downloaded model');
    assert.deepStrictEqual(notes(tree), []);

    // Back to base: switched at once, it being there.
    modelMenu(tree).props.onChange({ target: { value: 'base' } });
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(host.calls.slice(-1), [['set', 'base']]);
    assert.strictEqual(modelMenu(tree).props.value, 'base');
    unmount();
});

t('cancelling a model download says nothing; a failed one says why', async () => {
    fresh();
    const host = hostWithModels();
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    modelMenu(tree).props.onChange({ target: { value: 'small' } });
    tree = show(ctx);
    button(tree, 'Download').props.onClick();
    tree = show(ctx);
    await settle();
    button(tree, 'Cancel').props.onClick();
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(host.calls, [['install', 'small'], ['cancel', 'small']]);
    assert.deepStrictEqual(notes(tree), [], 'a cancel was reported as a failure');
    assert.strictEqual(progressText(tree), null);
    assert.ok(button(tree, 'Download'), 'no way to try again');

    button(tree, 'Download').props.onClick();
    tree = show(ctx);
    await settle();
    host.fail("Couldn't download the Small model: the server answered 503");
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.match(notes(tree).map(words).join(' '), /Couldn't download the Small model: the server answered 503/);
    assert.ok(!host.calls.some((c) => c[0] === 'set'), 'switched to a model that never arrived');
    unmount();
});

t('removing the model in use goes back to the built-in one', async () => {
    fresh();
    const host = hostWithModels();
    host.list = host.list.map((m) => ({ ...m, installed: true, active: m.id === 'small' }));
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.strictEqual(modelMenu(tree).props.value, 'small');
    button(tree, 'Remove').props.onClick();
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(host.calls, [['remove', 'small']]);
    const menu = modelMenu(tree);
    assert.strictEqual(menu.props.value, 'base');
    assert.deepStrictEqual(optionTexts(menu), ['Base — built in', 'Small — 190 MB, not downloaded']);
    unmount();
});

t('a model change while running restarts the recogniser on it; a refused one does not', async () => {
    fresh();
    const host = hostWithModels();
    host.list = host.list.map((m) => ({ ...m, installed: true }));
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();
    let tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    button(tree, 'Start').props.onClick();
    tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    assert.strictEqual(host.starts.length, 1, `starts: ${host.starts.length}`);
    // Renders that change nothing leave it running.
    tree = keep(ctx);
    assert.strictEqual(host.starts.length, 1, 'restarted by a render');
    const stops = host.stops;

    modelMenu(tree).props.onChange({ target: { value: 'small' } });
    await settle();
    tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    assert.deepStrictEqual(host.calls, [['set', 'small']]);
    assert.strictEqual(host.starts.length, 2, 'not restarted on the new model');
    assert.ok(host.stops > stops, 'the old session was left running');

    // The host refusing the change: nothing changed, so nothing restarts.
    host.setModel = (id) => {
        host.calls.push(['set', id]);
        return Promise.reject(new Error('The Base model could not be chosen.'));
    };
    modelMenu(tree).props.onChange({ target: { value: 'base' } });
    await settle();
    tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    assert.strictEqual(host.starts.length, 2, 'restarted for a model that was not chosen');
    assert.match(notes(tree).map(words).join(' '), /could not be chosen/);

    // Removing the one in use: the built-in one from now on, at once.
    button(tree, 'Remove').props.onClick();
    await settle();
    tree = keep(ctx);
    await settle();
    tree = keep(ctx);
    assert.deepStrictEqual(host.calls.slice(-1), [['remove', 'small']]);
    assert.strictEqual(host.starts.length, 3, 'not restarted after removing the model in use');
    unmount();
});

t('a download already running is followed; a cancel from elsewhere says nothing', async () => {
    fresh();
    const host = hostWithModels();
    host.list = host.list.map((m) => (m.id === 'small' ? { ...m, downloading: true } : m));
    globalThis.ubersdrDesktop = { stt: host };
    const ctx = context();
    let tree = show(ctx);
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    // Joined, not offered again.
    assert.deepStrictEqual(host.calls, [['install', 'small']]);
    assert.strictEqual(progressText(tree), 'Downloading 0%');
    assert.ok(button(tree, 'Cancel'), 'no Cancel for a download in progress');
    assert.ok(!button(tree, 'Download'), 'Download offered for a download in progress');
    host.progress({ received: 95042744, total: 190085487 });
    tree = show(ctx);
    assert.strictEqual(progressText(tree), 'Downloading 50%');

    // Somebody else's cancel ended it.
    host.list = host.list.map((m) => ({ ...m, downloading: false }));
    host.fail('Download cancelled.', 'cancelled');
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(notes(tree), [], 'a cancel from elsewhere was reported as a failure');
    assert.strictEqual(progressText(tree), null);
    assert.deepStrictEqual(host.calls, [['install', 'small']]);
    unmount();

    // This panel letting go of one another window is still downloading: not
    // followed again just because the list still says so.
    fresh();
    const shared = hostWithModels();
    shared.list = shared.list.map((m) => (m.id === 'small' ? { ...m, downloading: true } : m));
    globalThis.ubersdrDesktop = { stt: shared };
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    button(tree, 'Cancel').props.onClick();
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    await settle();
    tree = show(ctx);
    assert.deepStrictEqual(shared.calls, [['install', 'small'], ['cancel', 'small']]);
    assert.strictEqual(progressText(tree), null);
    assert.deepStrictEqual(notes(tree), []);
    unmount();
});

t('the menu is asked again on focus and on the host\'s fallback note', async () => {
    fresh();
    let focus = [];
    globalThis.addEventListener = (type, fn) => { if (type === 'focus') focus.push(fn); };
    globalThis.removeEventListener = (type, fn) => { focus = focus.filter((f) => f !== fn); };
    try {
        const host = hostWithModels();
        globalThis.ubersdrDesktop = { stt: host };
        const ctx = context();
        let tree = show(ctx);
        await settle();
        tree = show(ctx);
        modelMenu(tree).props.onChange({ target: { value: 'small' } });
        tree = show(ctx);
        assert.ok(button(tree, 'Download'));

        // Another window downloads it meanwhile; this one comes to the front.
        host.list = host.list.map((m) => ({ ...m, installed: true }));
        assert.ok(focus.length > 0, 'nothing listens for focus');
        focus.forEach((fn) => fn());
        await settle();
        tree = show(ctx);
        await settle();
        tree = show(ctx);
        // The pick was an offer to download, and there is nothing to download:
        // the menu shows the one in use, and choosing Small switches to it.
        assert.strictEqual(modelMenu(tree).props.value, 'base');
        assert.ok(!button(tree, 'Download') && !button(tree, 'Remove'));
        modelMenu(tree).props.onChange({ target: { value: 'small' } });
        await settle();
        tree = show(ctx);
        await settle();
        tree = show(ctx);
        assert.deepStrictEqual(host.calls, [['set', 'small']]);
        assert.strictEqual(modelMenu(tree).props.value, 'small');

        // Started on Small, which turns out damaged: the host falls back,
        // removes it and says so — and the menu follows. Rendered as React
        // would from here (keep), since show() restarts the engine every
        // time, and a restart clears the note.
        button(tree, 'Start').props.onClick();
        tree = keep(ctx);
        await settle();
        tree = keep(ctx);
        host.list = host.list.map((m) => (m.id === 'small'
            ? { ...m, installed: false, active: false }
            : { ...m, active: true }));
        host.cb.onError({
            code: 'model-fallback',
            message: 'The Small model was damaged, so it has been removed and the Base model is being used instead.',
            fatal: false,
        });
        await settle();
        tree = keep(ctx);
        await settle();
        tree = keep(ctx);
        const menu = modelMenu(tree);
        assert.strictEqual(menu.props.value, 'base');
        assert.deepStrictEqual(optionTexts(menu), ['Base — built in', 'Small — 190 MB, not downloaded']);
        assert.ok(!button(tree, 'Remove'), 'Remove offered for a model that has gone');
        assert.match(notes(tree).map(words).join(' '), /The Small model was damaged/);
        unmount();
    } finally {
        globalThis.addEventListener = () => {};
        globalThis.removeEventListener = () => {};
    }
});

t('no Model setting without the calls, on the server, or in the minimal view', async () => {
    fresh();
    globalThis.ubersdrDesktop = { stt: hostStt() };
    let tree = show(context());
    await settle();
    tree = show(context());
    assert.ok(!modelMenu(tree), 'a Model setting for a host with no models');
    unmount();

    fresh();
    globalThis.ubersdrDesktop = { stt: hostWithModels() };
    store.set('ubersdr.v2.stt.source', 'server');
    tree = show(context());
    await settle();
    tree = show(context());
    assert.ok(!modelMenu(tree), 'a Model setting on the server');
    unmount();

    fresh();
    globalThis.ubersdrDesktop = { stt: hostWithModels() };
    tree = show(context(), { minimal: true });
    await settle();
    tree = show(context(), { minimal: true });
    assert.ok(!modelMenu(tree), 'a Model setting in the minimal view');
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
