// The pad's noise controls in IQ mode.
//
// Nothing on the pad's zoom row does anything to an I/Q stream: the client
// engines are wired out of the graph on the way in (AudioPlayer.setIQ) and the
// receiver's inserts are refused outright ("DSP insert cannot be used with IQ
// modes"). The Noise panel already says so — it replaces itself with a sentence
// — and the pad, which is the other way to reach the same two settings, said
// nothing at all: the dropdown named an engine that was not running and the NB
// chip sat lit over a blanker that was out of circuit.
//
// So the assertions are in pairs — what the panel does, and the pad agreeing —
// because the bug was the two disagreeing, and either one changing alone is the
// same bug again. See hookStub.js for what "renders" means here.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
globalThis.performance = globalThis.performance || { now: () => 0 };
// render() runs the mount effects, and the Noise panel's include a meter poll
// on an interval. Nothing here is asking about it, and left on Node's real
// timer it fires after the last assertion — against a player the stub never
// built — and takes the process down with a passing scoreboard behind it.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// The module graph behind the pad reaches the display settings and the radio,
// and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    deep, render, reset, words, MultipadPanel, NoisePanel, DEFAULTS,
} = require('./.build/padiq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// Both stages on, and a server insert running too, because that is the state
// worth asking about: switched on in an audio mode, then the operator picks IQ.
// Nothing clears the settings — they are kept, and come back on the way out —
// so every control here has something to say and has to decline to say it.
function ctxFor(mode) {
    return {
        tuning: { mode, frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        squelch: { enabled: false, value: -20 },
        meters: { current: { snr: 12, snrHistory: [12, 12, 12] } },
        dsp: { enabled: true, filter: 'rnnoise', schemas: [{ name: 'rnnoise', description: 'RNNoise' }] },
        noise: { nr: { enabled: true, type: 'lsa' }, nb: { enabled: true } },
        spectrumConn: { on: () => () => {}, binCount: 1024, minBinBandwidthForUI: () => 10 },
        view: { centerFreq: 14_200_000, span: 30e6, binCount: 1024, binBandwidth: 30e6 / 1024 },
        catalog: { bookmarks: [], local: [], dx: [], cw: [], voice: [], confirmed: [] },
        actions: {
            setSquelch() {}, autoSquelch() {}, setBandwidth() {}, setFrequency() {},
            setMode() {}, setDsp() {}, setNoise() {}, setSpectrumView() {}, stepBy() {},
        },
        ...DEFAULTS,
        set() {},
        serverInfo: {},
        list: [],
    };
}

/** The pad's two noise controls, as drawn in `mode`. */
function pad(mode) {
    reset();
    const { tree } = render(MultipadPanel, { minimal: true }, ctxFor(mode));
    const nodes = deep(tree);
    return {
        nr: nodes.find((n) => n.props?.className === 'select pad__nr'),
        nb: nodes.find((n) => typeof n.props?.className === 'string'
            && n.props.className.includes('pad__nb')),
    };
}

t('the Noise panel stands down in IQ, and the pad with it', () => {
    // The panel first, since it is the behaviour the pad is being held to.
    reset();
    const { tree } = render(NoisePanel, {}, ctxFor('iq'));
    assert.ok(/IQ mode/.test(words(tree)), 'the panel says why it is empty');

    const { nr, nb } = pad('iq');
    assert.ok(nr && nb, 'both controls are still drawn');
    assert.strictEqual(nr.props.disabled, true, 'the NR dropdown is inert');
    assert.strictEqual(nb.props.disabled, true, 'the NB chip is inert');
});

t('neither claims to be running in IQ', () => {
    // The point of the pair: a disabled control still showing LSA and a lit NB
    // chip is the same lie as an enabled one, and it is the half that would
    // survive somebody only adding `disabled`.
    const { nr, nb } = pad('iq');
    assert.strictEqual(nr.props.value, 'off', 'the dropdown reads off');
    assert.strictEqual(nb.props['aria-pressed'], false, 'the chip is unlit');
    assert.ok(!nb.props.className.includes('is-active'), 'and not styled as active');
    assert.ok(/IQ/.test(nr.props.title) && /IQ/.test(nb.props.title), 'both say why');
});

t('in an audio mode they are live, and say what is running', () => {
    // The other side of the same guard: it must be the mode doing this, not the
    // controls having been switched off for everybody.
    const { nr, nb } = pad('usb');
    assert.ok(!nr.props.disabled, 'the dropdown works');
    assert.ok(!nb.props.disabled, 'the chip works');
    assert.strictEqual(nr.props.value, 'client:lsa', 'and names the engine in circuit');
    assert.strictEqual(nb.props['aria-pressed'], true, 'the blanker reads on');
});

console.log(`\n${pass} passed`);
