// The Olivia panel actually renders — with and without its spectrum.
//
// The panel gained an optional audio spectrum, which means new state, a memo over the
// server's config and a click-to-tune handler. None of that is reachable from the
// protocol tests, so a helper called with its arguments the other way round or a value
// used before it is defined would build cleanly, pass everything else, and blank the
// panel the moment somebody opened it. See hookStub.js for what "renders" means here.

const assert = require('assert');

// Before the bundle: the module graph behind an extension reaches the radio and the
// display settings, and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    render, reset, walk, words, OliviaExtension, DEFAULT_MODE,
} = require('./.build/oliviapanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers useRadio and useDisplay alike — the stub's useContext cannot tell
// two contexts apart, and this panel does not care.
function context(over) {
    return {
        tuning: { frequency: 14_072_900, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        running: true,
        audioState: 'open',   // what `live` tests for
        player: { on: () => () => {}, addEventListener: () => {}, removeEventListener: () => {} },
        actions: { nudge() {}, tuneTo() {}, setFrequency() {} },
        server: {},
        set() {},
        ...over,
    };
}

t('it renders docked and minimal, spectrum off', () => {
    for (const minimal of [false, true]) {
        reset();
        const { tree } = render(OliviaExtension, { minimal }, context());
        assert.ok(tree, `minimal=${minimal} produced nothing`);
    }
});

t('it renders with the spectrum switched on', () => {
    // The switch lives in panel state, so this drives it the way the interface does:
    // render, find the Spectrum switch, call its onChange, render again.
    reset();
    const first = render(OliviaExtension, {}, context());
    const sw = walk(first.tree).find((n) => n && n.props && n.props.label === 'Spectrum');
    assert.ok(sw, 'the Spectrum switch should be in the controls');
    assert.strictEqual(sw.props.checked, false, 'it starts off, like the FSK panel\'s');

    sw.props.onChange(true);
    const second = render(OliviaExtension, {}, context());
    const on = walk(second.tree).find((n) => n && n.props && n.props.label === 'Spectrum');
    assert.strictEqual(on.props.checked, true, 'the switch should have stuck');
});

t('the hint tells you the spectrum is there', () => {
    // Only shown once the audio is actually connected and nothing is decoding yet —
    // which is exactly when somebody is trying to line a signal up.
    reset();
    const { tree } = render(OliviaExtension, {}, context({ audioState: 'open' }));
    const text = words(tree);
    assert.ok(text.includes('Tune to an Olivia signal'), 'the original hint should still be there');
    assert.ok(/Spectrum/.test(text), 'and it should point at the aid it now has');
});

t('nothing is drawn when the receiver is stopped', () => {
    // The strip reads the session audio; with nothing playing it would be an empty box
    // under a panel that already says why.
    reset();
    const { tree } = render(OliviaExtension, {}, context({ running: false }));
    assert.ok(tree, 'the panel still renders');
    assert.ok(/Start the receiver/.test(words(tree)));
});

console.log(`\n${pass} passed`);
