// Web Bluetooth in the desktop client: the per-window chooser for the UberSDR
// Dial (bluetooth.js).
//
// No Electron and no radio here, so the webContents and the picker are
// stand-ins. What is pinned is what fails quietly: an event that is not
// prevented (Chromium then picks for you), a request that is never answered
// (requestDevice() hangs for ever), and an answer sent to a stale callback
// after discovery has replaced it.

const assert = require('assert');
const {
    AUTO_WAIT_MS,
    describeBluetoothDevice, createBluetoothMemory, bluetoothSelectHandler, installBluetoothHandlers,
} = require('../bluetooth.js');

let pass = 0;
const async_t = [];
const at = (name, fn) => async_t.push([name, fn]);

function harness(extra = {}) {
    const calls = { choose: [], changed: [] };
    let resolveChoice;
    const deps = {
        ...extra,
        choose: (win, rows, origin, kind) => {
            calls.choose.push({ win, rows, origin, kind });
            return new Promise((r) => { resolveChoice = r; });
        },
        changed: (kind, change, row) => calls.changed.push({ kind, change, row }),
        windowOf: () => 'WINDOW',
        originOf: () => 'receiver.example',
        ...extra,
    };
    const handler = bluetoothSelectHandler(extra.wc || {}, deps);
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

// --- connect automatically ----------------------------------------------------
//
// Electron's getDevices() is a stub that returns nothing, so the dial last
// picked is remembered here and a page that asks is answered with it, no picker.
// What fails quietly: an armed page whose request never comes leaving the next
// manual Connect answered behind the operator's back, and a missing dial leaving
// requestDevice() hanging for ever.

function memoryWith(saved, clock = { t: 0 }) {
    const store = { dial: saved };
    const memory = createBluetoothMemory({
        load: () => store.dial,
        save: (dial) => { store.dial = dial; },
        now: () => clock.t,
    });
    return { memory, store, clock };
}

function timers() {
    const list = [];
    return {
        setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; list.push(h); return h; },
        clearTimer: (h) => { h.cleared = true; },
        fireAll: () => { for (const h of list) if (!h.cleared) h.fn(); },
        list,
    };
}

at('a dial picked by hand is remembered, a cancel is not', async () => {
    const { memory, store } = memoryWith(undefined);
    const h = harness({ memory });
    h.fire([dial('AA', 'UberSDR Dial 40E8')]);
    h.choose('');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(store.dial, undefined);
    h.fire([dial('AA', 'UberSDR Dial 40E8')]);
    h.fire([dial('AA', 'UberSDR Dial 40E8'), dial('BB', 'UberSDR Dial 1234')]);
    h.choose('BB');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(store.dial, { id: 'BB', name: 'UberSDR Dial 1234' });
});

at('armed: the remembered dial is answered without a picker, when it turns up', async () => {
    const wc = {};
    const { memory } = memoryWith({ id: 'BB', name: 'UberSDR Dial 1234' });
    const tm = timers();
    const h = harness({ memory, wc, ...tm });
    assert.strictEqual(memory.arm(wc), true);
    const first = h.fire([]);                    // discovery has found nothing yet
    const second = h.fire([dial('AA')]);         // someone else's dial
    const third = h.fire([dial('AA'), dial('BB')]);
    assert.strictEqual(h.calls.choose.length, 0, 'no picker');
    assert.deepStrictEqual(h.calls.changed, []);
    assert.deepStrictEqual([first.answers, second.answers, third.answers], [[], [], ['BB']]);
    assert.strictEqual(tm.list[0].ms, AUTO_WAIT_MS);
    assert.strictEqual(tm.list[0].cleared, true, 'the give-up timer is stopped');

    // One shot: the next request is a normal one, with a picker.
    h.fire([dial('BB')]);
    assert.strictEqual(h.calls.choose.length, 1);
});

at('armed but never seen: the request is cancelled, not left hanging', async () => {
    const wc = {};
    const { memory } = memoryWith({ id: 'BB', name: '' });
    const tm = timers();
    const h = harness({ memory, wc, ...tm });
    memory.arm(wc);
    const req = h.fire([dial('AA')]);
    tm.fireAll();
    assert.deepStrictEqual(req.answers, ['']);
    assert.strictEqual(h.calls.choose.length, 0);
    // ...and a late sighting after that changes nothing.
    const late = h.fire([dial('BB')]);
    assert.strictEqual(h.calls.choose.length, 1, 'a new request gets the picker');
    assert.deepStrictEqual(late.answers, []);
});

at('nothing remembered: arming refuses, and the picker is untouched', async () => {
    const wc = {};
    const { memory } = memoryWith(undefined);
    assert.strictEqual(memory.arm(wc), false);
    const h = harness({ memory, wc });
    h.fire([dial('AA')]);
    assert.strictEqual(h.calls.choose.length, 1);
});

at('a first report after the wait is cancelled at once, never a picker', async () => {
    const wc = { id: 7 };
    const { memory, clock } = memoryWith({ id: 'AA', name: '' });
    const tm = timers();
    const h = harness({ memory, wc, ...tm });
    memory.arm(wc);
    clock.t += AUTO_WAIT_MS + 1;
    h.fire([dial('BB')]);
    assert.strictEqual(h.calls.choose.length, 0, 'no picker');
    assert.strictEqual(tm.list[0].ms, 0);
    // A report that comes early gets only what is left of the wait.
    memory.forget(wc);
    clock.t = 0;
    const tm2 = timers();
    const h2 = harness({ memory, wc, ...tm2 });
    memory.arm(wc);
    clock.t = 4000;
    h2.fire([]);
    assert.strictEqual(tm2.list[0].ms, AUTO_WAIT_MS - 4000);
});

at('disarming after the request ends leaves the next Connect with its picker', async () => {
    const wc = { id: 3 };
    const { memory } = memoryWith({ id: 'AA', name: '' });
    const h = harness({ memory, wc });
    memory.arm(wc);
    memory.forget(wc);      // main.js: the page's request ended before any report
    h.fire([dial('AA')]);
    assert.strictEqual(h.calls.choose.length, 1);
});

at('arming is per page, and a corrupt file is "nothing remembered"', async () => {
    // Keyed by webContents id: the IPC sender and the object the app event
    // handed over are the same page whether or not they are the same object.
    const a = { id: 1 };
    const b = { id: 2 };
    const { memory } = memoryWith({ id: 'AA', name: '' });
    memory.arm({ id: 1 });
    assert.strictEqual(memory.take(b), null);
    assert.strictEqual(memory.take(a).id, 'AA');
    for (const bad of [null, {}, { id: '' }, { id: 7 }, 'AA']) {
        const m = createBluetoothMemory({ load: () => bad, save: () => {} });
        assert.strictEqual(m.remembered(), null, JSON.stringify(bad));
    }
    const throwing = createBluetoothMemory({ load: () => { throw new Error('ENOENT'); }, save: () => {} });
    assert.strictEqual(throwing.arm({}), false);
});

(async () => {
    for (const [name, fn] of async_t) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} Bluetooth tests passed`);
})();
