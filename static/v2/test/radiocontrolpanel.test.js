// The Radio Control panel renders all the way down with the TX hold slider —
// over serial, through a provider, and with nothing to mute on — and the hold
// for a provider transport closes the speakers-only gate on the drop and opens
// it when the wait runs out.
//
// A name used out of scope builds cleanly and blanks the interface — see
// hookStub.js — so each state is rendered to the leaves.

const assert = require('assert');

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener() {},
    removeEventListener() {},
};
globalThis.navigator = { userAgent: 'node', serial: { getPorts: () => Promise.resolve([]), addEventListener() {} } };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.isSecureContext = true;

const {
    deep, render, reset, words,
    RadioControlPanel, ControlWatch, updateControlState, controlState,
    registerProvider, setProviderStatus, resetProviders,
} = require('./.build/radiocontrolpanel.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; },
    );
};

const context = {
    tuning: { frequency: 14_200_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    audio: { volume: 0.5, muted: false },
    squelch: { value: -999 },
    dsp: { schemas: [] },
    serverInfo: {},
    actions: {},
};

function mount() {
    reset();
    const m = render(RadioControlPanel, {}, context);
    const nodes = deep(m.tree);
    return { ...m, nodes, text: words(m.tree) };
}
const unmount = (m) => m.cleanups.forEach((off) => off());
const holdSlider = (nodes) => nodes.find((n) => n.type === 'input' && n.props.type === 'range'
    && n.props.max === 2000);

t('serial: the hold slider is there, off, and enabled', () => {
    updateControlState({ radiosync: { ...controlState().radiosync, transport: 'serial', muteOnTx: true, txHoldMs: 0 } });
    const m = mount();
    assert.match(m.text, /Keep muted after transmit/i);
    assert.match(m.text, /Off/);
    const s = holdSlider(m.nodes);
    assert.ok(s, 'the slider rendered');
    assert.strictEqual(s.props.disabled, false);
    unmount(m);
});

t('the reading is one token with a no-break space', () => {
    updateControlState({ radiosync: { ...controlState().radiosync, txHoldMs: 350 } });
    let m = mount();
    assert.ok(m.text.includes('350 ms'), m.text);
    unmount(m);
    updateControlState({ radiosync: { ...controlState().radiosync, txHoldMs: 1500 } });
    m = mount();
    assert.ok(m.text.includes('1.5 s'));
    unmount(m);
});

t('the slider sets the saved hold', () => {
    const m = mount();
    holdSlider(m.nodes).props.onChange({ target: { value: '750' } });
    assert.strictEqual(controlState().radiosync.txHoldMs, 750);
    unmount(m);
});

t('mute on TX off: the slider is disabled', () => {
    updateControlState({ radiosync: { ...controlState().radiosync, muteOnTx: false } });
    const m = mount();
    assert.strictEqual(holdSlider(m.nodes).props.disabled, true);
    unmount(m);
    updateControlState({ radiosync: { ...controlState().radiosync, muteOnTx: true } });
});

t('a provider with no PTT: the slider is disabled', () => {
    resetProviders();
    registerProvider({ id: 'nopt', label: 'No PTT', capabilities: ['frequency', 'mode'] });
    updateControlState({ radiosync: { ...controlState().radiosync, transport: 'nopt' } });
    const m = mount();
    const s = holdSlider(m.nodes);
    assert.ok(s);
    assert.strictEqual(s.props.disabled, true);
    unmount(m);
});

// The provider mutes by itself, through the bridge's duck, on its own PTT
// edges. The page can only add the hold after it: the gate closes on the drop,
// stays closed through a re-key, and opens once the wait runs out.
t('a provider: the hold closes the gate on the drop and opens it after', async () => {
    resetProviders();
    registerProvider({ id: 'flrig', label: 'flrig' });
    updateControlState({ radiosync: { ...controlState().radiosync, transport: 'flrig', muteOnTx: true, txHoldMs: 40 } });
    const calls = [];
    const ctx = { ...context, audioState: 'open', actions: { setTxSilenced: (on) => calls.push(on) } };
    reset();
    const r = render(ControlWatch, {}, ctx);
    setProviderStatus('flrig', { connected: true, tx: true });
    setProviderStatus('flrig', { tx: false });
    setProviderStatus('flrig', { tx: true });
    setProviderStatus('flrig', { tx: false });
    assert.deepStrictEqual(calls, [true]);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(calls, [true, false]);
    r.cleanups.forEach((off) => off());
    assert.deepStrictEqual(calls, [true, false], 'unmounting after the hold does not touch the gate again');
});

chain.then(() => {
    resetProviders();
    console.log(`\n${pass} passed`);
});
