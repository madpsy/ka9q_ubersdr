// Renders the simultaneous-VFO watcher, its hook, and the Audio panel's
// channel picker under the hook stub — the scope errors that build cleanly and
// blank the interface are what this is for. The engine itself is
// subreceivers.test.js's.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener() {},
    removeEventListener() {},
};
globalThis.navigator = { userAgent: 'node' };
globalThis.location = { protocol: 'http:', hostname: 'radio.example', host: 'radio.example', search: '' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// Mounted intervals must not outlive the assertions — see wavlossless.test.js.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const {
    deep, render, reset, words, SubReceiversWatch, AudioPanel, getSubReceivers, useSubReceivers,
} = require('./.build/vfowatch.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const pans = [];
const player = {
    setDucked() {}, contextEpoch: 0, ctx: null, setPan(p) { pans.push(p); }, on() { return () => {}; },
};

function ctxFor(mode = 'usb') {
    return {
        tuning: { mode, frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        audioState: 'open',
        squelch: { value: 10, enabled: true, threshold: 10 },
        view: { binBandwidth: 0, binCount: 0 },
        player,
        serverInfo: {},
        meters: { current: {} },
        audio: {
            volume: 0.7, muted: false, ducked: false, bufferSec: 0.2, channel: 'both', minMargin: 0,
            sinkId: '', format: 'opus', formatPref: 'opus', formatHold: false,
        },
        actions: {
            tuneTo() {}, setLosslessHold() {}, setAudioFormat() {}, setAudioMargin() {}, setVolume() {},
            setChannel() {}, toggleMute() {}, setBufferSec() {}, setAudioSink() { return Promise.resolve(); },
        },
    };
}

t('the watcher mounts, pushes the main receiver in, and unmounts cleanly', () => {
    reset();
    const ctx = ctxFor();
    const { cleanups } = render(SubReceiversWatch, {}, ctx);
    const subs = getSubReceivers(player);
    assert.strictEqual(subs.main.running, true);
    assert.strictEqual(subs.main.open, true);
    assert.strictEqual(subs.main.threshold, 10, 'the squelch threshold, shared');
    assert.strictEqual(subs.main.tuning.mode, 'usb');
    assert.strictEqual(subs.radio.tuning, ctx.tuning);
    cleanups.forEach((off) => off());
});

t('the main socket\'s format is pushed in, read off the connection', () => {
    reset();
    const ctx = ctxFor();
    // The connection is the truth: the recorder's hold sets it without the
    // Audio panel's choice changing.
    ctx.audioConn = { format: 'pcm-zstd' };
    let r = render(SubReceiversWatch, {}, ctx);
    assert.strictEqual(getSubReceivers(player).main.format, 'pcm-zstd');
    r.cleanups.forEach((off) => off());
    reset();
    r = render(SubReceiversWatch, {}, ctxFor());
    assert.strictEqual(getSubReceivers(player).main.format, 'opus', 'no connection: the audio state\'s');
    r.cleanups.forEach((off) => off());
});

t('in IQ the hook says listening is not available', () => {
    reset();
    let got = null;
    const Probe = () => { got = useSubReceivers(); return null; };
    const ctx = ctxFor('iq');
    const w = render(SubReceiversWatch, {}, ctx);
    reset();
    const p = render(Probe, {}, ctx);
    assert.strictEqual(got.snap.listenBlocked, 'Not available while main is in IQ');
    p.cleanups.forEach((off) => off());
    w.cleanups.forEach((off) => off());
    reset();
    const back = render(SubReceiversWatch, {}, ctxFor());
    back.cleanups.forEach((off) => off());
});

t('a squelch that is off is no threshold at all', () => {
    reset();
    const ctx = ctxFor();
    ctx.squelch = { value: -50, enabled: false, threshold: -999 };
    const { cleanups } = render(SubReceiversWatch, {}, ctx);
    assert.strictEqual(getSubReceivers(player).main.threshold, null);
    cleanups.forEach((off) => off());
});

t('the hook hands back the engine and its snapshot', () => {
    reset();
    let got = null;
    const Probe = () => { got = useSubReceivers(); return null; };
    const { cleanups } = render(Probe, {}, ctxFor());
    assert.strictEqual(got.subs, getSubReceivers(player));
    assert.deepStrictEqual(Object.keys(got.snap).sort(), ['format', 'limit', 'listenBlocked', 'mainPan', 'vfos']);
    cleanups.forEach((off) => off());
});

t('the channel picker gives way to the VFOs panel while VFOs share the field', () => {
    const subs = getSubReceivers(player);
    reset();
    subs.mainPan = null;
    let r = render(AudioPanel, {}, ctxFor());
    assert.ok(!/Set per VFO/.test(words(deep(r.tree))), 'one VFO: the picker as ever');
    r.cleanups.forEach((off) => off());

    reset();
    subs.mainPan = -1;
    r = render(AudioPanel, {}, ctxFor());
    assert.ok(/Set per VFO in the VFOs panel/.test(words(deep(r.tree))));
    r.cleanups.forEach((off) => off());

    // IQ keeps its I/Q picker: the sides are signals there, not seats.
    reset();
    r = render(AudioPanel, {}, ctxFor('iq'));
    assert.ok(!/Set per VFO/.test(words(deep(r.tree))));
    r.cleanups.forEach((off) => off());
    subs.mainPan = null;
});

if (!process.exitCode) console.log(`\n${pass} passed`);
