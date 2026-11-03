// Web Bluetooth in the desktop client: the per-window chooser for the UberSDR
// Dial (bluetooth.js).
//
// No Electron and no radio here, so the webContents and the picker are
// stand-ins. What is pinned is what fails quietly: an event that is not
// prevented (Chromium then picks for you), a request that is never answered
// (requestDevice() hangs for ever), and an answer sent to a stale callback
// after discovery has replaced it.

const assert = require('assert');
const { describeBluetoothDevice, bluetoothSelectHandler, installBluetoothHandlers } = require('../bluetooth.js');

let pass = 0;
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

function harness() {
    const calls = { choose: [], changed: [] };
    let resolveChoice;
    const deps = {
        choose: (win, rows, origin, kind) => {
            calls.choose.push({ win, rows, origin, kind });
            return new Promise((r) => { resolveChoice = r; });
        },
        changed: (kind, change, row) => calls.changed.push({ kind, change, row }),
        windowOf: () => 'WINDOW',
        originOf: () => 'receiver.example',
    };
    const handler = bluetoothSelectHandler({}, deps);
    const fire = (list) => {
        const answers = [];
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        handler(event, list, (id) => answers.push(id));
        return { event, answers };
    };
    return { calls, fire, choose: (id) => resolveChoice(id) };
}

const dial = (id, name = 'UberSDR Dial 40E8') => ({ deviceId: id, deviceName: name });

at('rows are strings only, and a nameless device still gets a label', async () => {
    assert.deepStrictEqual(describeBluetoothDevice(dial('AA', 'UberSDR Dial 40E8')), {
        portId: 'AA', portName: '', displayName: 'UberSDR Dial 40E8', vendorId: '', productId: '', serialNumber: '',
    });
    assert.strictEqual(describeBluetoothDevice({ deviceId: 'BB' }).displayName, 'Unnamed Bluetooth device');
});

at('the first event opens the picker and prevents Chromium choosing', async () => {
    const h = harness();
    const { event } = h.fire([dial('AA')]);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(h.calls.choose.length, 1);
    assert.strictEqual(h.calls.choose[0].kind, 'bluetooth');
    assert.strictEqual(h.calls.choose[0].win, 'WINDOW');
    assert.deepStrictEqual(h.calls.choose[0].rows.map((r) => r.portId), ['AA']);
});

at('later discoveries add rows instead of opening another picker', async () => {
    const h = harness();
    h.fire([dial('AA')]);
    h.fire([dial('AA'), dial('BB', 'UberSDR Dial 1234')]);
    h.fire([dial('AA'), dial('BB', 'UberSDR Dial 1234')]);
    assert.strictEqual(h.calls.choose.length, 1);
    assert.deepStrictEqual(h.calls.changed.map((c) => [c.kind, c.change, c.row.portId]), [['bluetooth', 'add', 'BB']]);
});

at('the choice goes to the newest callback, and a cancel answers too', async () => {
    const h = harness();
    const first = h.fire([dial('AA')]);
    const second = h.fire([dial('AA'), dial('BB')]);
    h.choose('BB');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(first.answers, []);
    assert.deepStrictEqual(second.answers, ['BB']);

    // A fresh request after that one settled opens a new picker; closing it answers ''.
    const third = h.fire([dial('AA')]);
    assert.strictEqual(h.calls.choose.length, 2);
    h.choose('');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(third.answers, ['']);
});

at('every webContents the app creates gets the handler', async () => {
    const appHandlers = {};
    const wcHandlers = {};
    installBluetoothHandlers({ on: (n, fn) => { appHandlers[n] = fn; } }, {
        choose: async () => '', changed: () => {}, windowOf: () => null, originOf: () => '',
    });
    appHandlers['web-contents-created']({}, { on: (n, fn) => { wcHandlers[n] = fn; } });
    assert.strictEqual(typeof wcHandlers['select-bluetooth-device'], 'function');
});

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} Bluetooth tests passed`);
})();
