// The real omnirig-helper.exe, under wine, against fake_omnirig.dll standing in
// for OmniRig — driven through OmniRigLink, as the desktop client drives it.
//
// Run by wine_test.sh, which builds both and registers the fake in a throwaway
// prefix; WINEPREFIX arrives set. This is the only test that reaches the
// IDispatch calls in omnirig_helper.cpp.

const assert = require('assert');
const path = require('path');
const { OmniRigLink } = require('../../omnirig.js');

const EXE = path.join(__dirname, '..', 'dist', 'omnirig-helper.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
}

function link(opts) {
    const states = [];
    const l = new OmniRigLink({
        rig: 1, onState: (s) => states.push(s), helper: { command: 'wine', args: [EXE] }, ...opts,
    });
    return { l, states, last: () => states[states.length - 1] };
}

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('reads Rig1 through IDispatch', async () => {
    const { l, states, last } = link({});
    l.start();
    await until(() => states.length, 30000, 'a state');
    assert.deepStrictEqual(last(), {
        connected: true, error: null, frequency: 14074000, mode: 'USB', sdrMode: 'usb', tx: false,
        pttAvailable: true,
    });

    // A property put, with its argument named DISPID_PROPERTYPUT, or the fake refuses it.
    await l.setFrequency(7100000);
    await until(() => last().frequency === 7100000, 10000, 'the frequency to change');
    await l.setMode('lsb');
    await until(() => last().sdrMode === 'lsb', 10000, 'the mode to change');

    // The fake cannot set AM: refused in the helper, and the rig stays in LSB.
    await l.setMode('am');
    await sleep(500);
    assert.strictEqual(last().sdrMode, 'lsb');

    const child = l.child;
    const exited = new Promise((r) => child.once('exit', r));
    l.stop();
    assert.strictEqual(await exited, 0);
});

t('VFO B reads and writes FreqB', async () => {
    const { l, states, last } = link({ vfo: 'B' });
    l.start();
    await until(() => states.length, 30000, 'a state');
    assert.strictEqual(last().frequency, 7074000);
    await l.setFrequency(3573000);
    await until(() => last().frequency === 3573000, 10000, 'FreqB to change');
    l.stop();
});

t('Rig2, not configured, is said in words', async () => {
    const { l, states } = link({ rig: 2 });
    l.start();
    await until(() => states.length, 30000, 'a state');
    l.stop();
    assert.strictEqual(states[0].connected, false);
    assert.match(states[0].error, /^Rig 2 is not set up in OmniRig/);
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`${pass}/${tests.length} passed`);
})();
