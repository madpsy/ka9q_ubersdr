// The page half of the Dial over Bluetooth (src/hostbluetooth.js).
//
// Native code cannot run here, so the host is a stub that answers the way
// DialBluetooth.java does. What is pinned is what would go wrong silently on a
// phone nobody is watching:
//
//   * **Declared only when the host says so**, and never over a real
//     navigator.bluetooth.
//   * **The Dial only.** A request for any other device never reaches the host.
//   * **The wire format.** Writes as base64 of exactly the bytes given — a view
//     into a larger buffer included — and notifications as a buffer holding
//     exactly the value, because dial.js reads `.value.buffer` whole.
//   * **Nothing hangs.** A host that never answers is a rejection, and
//     getDevices() an empty list.
//   * **A dropped link is seen.** gattserverdisconnected fires once, and
//     anything waiting on that dial is rejected rather than left pending.
//   * **The page's own driver runs on it.** v2's DialControl, driven through
//     this shim, connects, turns knob records into events, writes state, and
//     notices the dial going.

const assert = require('assert');
const { installHostBluetooth, DIAL_SERVICE } = require('./.build/hostbluetooth.cjs');
const D = require('./.build/dial.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(async () => {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
    });
};

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => [...Buffer.from(s, 'base64')];

const INPUT = '89540002-8c77-4d5f-9411-e7534b50c873';
const STATE = '89540003-8c77-4d5f-9411-e7534b50c873';
const NAME = '89540004-8c77-4d5f-9411-e7534b50c873';
const SPEC = '89540005-8c77-4d5f-9411-e7534b50c873';
const CHARS = [INPUT, STATE, NAME, SPEC];

// A clock the test drives, for the deadlines.
function clock() {
    let now = 0;
    let q = [];
    return {
        setTimer: (fn, ms) => { const id = { fn, at: now + (ms || 0) }; q.push(id); return id; },
        clearTimer: (id) => { q = q.filter((x) => x !== id); },
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

/**
 * A window, and a host that behaves like DialBluetooth.java: it remembers the
 * last dial picked, connects to it, and acknowledges notifications and writes.
 * `answer` decides each reply; returning undefined leaves a request unanswered.
 */
function rig({ flags = { bluetoothHost: true }, nav = {}, answer } = {}) {
    const sent = [];
    const win = { ubersdrDesktop: flags, navigator: nav };
    const c = clock();
    const host = {
        remembered: null,
        chosen: { id: 'dial-0123', name: 'UberSDR Dial 1A2B' },
        connectedTo: null,
    };
    let api = null;
    const send = (text) => api.onHostMessage(text);
    const reply = (id, body) => send('ble-reply:' + JSON.stringify({ id, ...body }));
    const defaultAnswer = (m) => {
        switch (m.type) {
            case 'ble-request': return host.chosen ? { device: host.chosen } : { error: { name: 'NotFoundError', message: 'no dial chosen' } };
            case 'ble-devices': return { devices: host.remembered ? [host.remembered] : [] };
            case 'ble-connect':
                host.connectedTo = m.device;
                return { services: [{ uuid: DIAL_SERVICE, chars: CHARS }] };
            case 'ble-notify': return {};
            case 'ble-write': return {};
            default: return undefined;
        }
    };
    const tellHost = (m) => {
        sent.push(m);
        if (m.type === 'ble-disconnect') { host.connectedTo = null; return; }
        const body = (answer || defaultAnswer)(m, defaultAnswer);
        if (body !== undefined) setImmediate(() => reply(m.id, body));
    };
    api = installHostBluetooth({
        win,
        tellHost,
        btoaFn: (s) => Buffer.from(s, 'binary').toString('base64'),
        atobFn: (s) => Buffer.from(s, 'base64').toString('binary'),
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
    });
    return {
        win, sent, host, api, clock: c, send, reply,
        bt: win.navigator.bluetooth,
        of: (type) => sent.filter((m) => m.type === type),
    };
}

async function rejects(promise, name) {
    try {
        await promise;
    } catch (e) {
        if (name) assert.strictEqual(e.name, name, `expected ${name}, got ${e.name}: ${e.message}`);
        return e;
    }
    throw new Error('expected a rejection');
}

const DIAL_FILTER = { filters: [{ services: [DIAL_SERVICE] }] };

// ---- declaring it -------------------------------------------------------------

t('the shim names the same service as v2', () => {
    assert.strictEqual(DIAL_SERVICE, D.DIAL_SERVICE);
    assert.deepStrictEqual(CHARS, [D.DIAL_INPUT, D.DIAL_STATE, D.DIAL_NAME, D.DIAL_SPEC]);
});

t('nothing is declared without the flag', () => {
    for (const flags of [null, {}, { bluetoothHost: false }, { bluetoothHost: 0 }]) {
        const r = rig({ flags });
        assert.strictEqual(r.win.navigator.bluetooth, undefined);
        assert.strictEqual(r.api.onHostMessage('ble-reply:{"id":1}'), false);
    }
});

t('a real navigator.bluetooth is never replaced', () => {
    const real = { requestDevice() {} };
    const r = rig({ nav: { bluetooth: real } });
    assert.strictEqual(r.win.navigator.bluetooth, real);
    assert.strictEqual(r.api.onHostMessage('ble-reply:{"id":1}'), false);
});

t('declared, it gives the page a reason to retry after load', async () => {
    const r = rig();
    assert.ok(r.bt);
    assert.strictEqual(typeof r.win.ubersdrDesktop.bluetoothAutoConnect, 'function');
    // ...which has nothing of its own to add: getDevices() is the reconnect.
    assert.strictEqual(await r.win.ubersdrDesktop.bluetoothAutoConnect(), false);
    assert.deepStrictEqual(r.sent, []);
});

t('messages that are not this file\'s are left for the next handler', () => {
    const r = rig();
    for (const m of ['voices:[]', 'stt-result:{}', 'action:play', 'stats:{}']) {
        assert.strictEqual(r.api.onHostMessage(m), false, m);
    }
});

// ---- choosing a dial ------------------------------------------------------------

t('anything but the dial is refused without asking the host', async () => {
    const r = rig();
    for (const opts of [undefined, {}, { acceptAllDevices: true },
        { filters: [{ services: ['0000180d-0000-1000-8000-00805f9b34fb'] }] }, { filters: [{ name: 'x' }] }]) {
        await rejects(r.bt.requestDevice(opts), 'NotFoundError');
    }
    assert.deepStrictEqual(r.sent, []);
});

t('the chooser picks a dial; the same dial is the same object', async () => {
    const r = rig();
    const a = await r.bt.requestDevice(DIAL_FILTER);
    assert.strictEqual(a.id, 'dial-0123');
    assert.strictEqual(a.name, 'UberSDR Dial 1A2B');
    assert.strictEqual(a.gatt.connected, false);
    // UUIDs are compared without regard to case, as in Web Bluetooth.
    const b = await r.bt.requestDevice({ filters: [{ services: [DIAL_SERVICE.toUpperCase()] }] });
    assert.strictEqual(a, b);
    r.host.remembered = r.host.chosen;
    assert.deepStrictEqual(await r.bt.getDevices(), [a]);
});

t('a cancelled chooser is NotFoundError, which the page keeps quiet about', async () => {
    const r = rig();
    r.host.chosen = null;
    await rejects(r.bt.requestDevice(DIAL_FILTER), 'NotFoundError');
});

t('one chooser at a time', async () => {
    const r = rig({ answer: () => undefined });
    const first = r.bt.requestDevice(DIAL_FILTER);
    await rejects(r.bt.requestDevice(DIAL_FILTER), 'InvalidStateError');
    assert.strictEqual(r.of('ble-request').length, 1);
    r.reply(r.of('ble-request')[0].id, { device: { id: 'dial-9', name: 'D' } });
    assert.strictEqual((await first).id, 'dial-9');
    // And free again afterwards.
    const again = r.bt.requestDevice(DIAL_FILTER);
    assert.strictEqual(r.of('ble-request').length, 2);
    r.reply(r.of('ble-request')[1].id, { error: { name: 'NotAllowedError', message: 'no permission' } });
    const e = await rejects(again, 'NotAllowedError');
    assert.strictEqual(e.message, 'no permission');
});

t('getDevices from a host that never answers is an empty list', async () => {
    const r = rig({ answer: () => undefined });
    const p = r.bt.getDevices();
    await r.clock.advance(5000);
    assert.deepStrictEqual(await p, []);
});

// ---- the connection ---------------------------------------------------------------

async function connected(r) {
    const device = await r.bt.requestDevice(DIAL_FILTER);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(DIAL_SERVICE);
    return { device, server, service };
}

t('connect, then the dial service and its characteristics', async () => {
    const r = rig();
    const { device, server, service } = await connected(r);
    assert.strictEqual(server, device.gatt);
    assert.strictEqual(server.connected, true);
    assert.deepStrictEqual(r.of('ble-connect').map((m) => m.device), ['dial-0123']);
    for (const uuid of CHARS) assert.strictEqual((await service.getCharacteristic(uuid)).uuid, uuid);
    assert.strictEqual(await service.getCharacteristic(STATE), await service.getCharacteristic(STATE.toUpperCase()));
    await rejects(service.getCharacteristic('89540009-8c77-4d5f-9411-e7534b50c873'), 'NotFoundError');
    await rejects(server.getPrimaryService('0000180d-0000-1000-8000-00805f9b34fb'), 'NotFoundError');
    // Connecting again while connected asks nothing.
    await device.gatt.connect();
    assert.strictEqual(r.of('ble-connect').length, 1);
});

t('nothing is asked of a dial that is not connected', async () => {
    const r = rig();
    const device = await r.bt.requestDevice(DIAL_FILTER);
    await rejects(device.gatt.getPrimaryService(DIAL_SERVICE), 'NetworkError');
});

t('a connect the host refuses rejects with its reason', async () => {
    const r = rig({
        answer: (m, def) => (m.type === 'ble-connect'
            ? { error: { name: 'NetworkError', message: 'the dial did not answer' } } : def(m)),
    });
    const device = await r.bt.requestDevice(DIAL_FILTER);
    const e = await rejects(device.gatt.connect(), 'NetworkError');
    assert.strictEqual(e.message, 'the dial did not answer');
    assert.strictEqual(device.gatt.connected, false);
});

t('a host that never answers a connect is a rejection, and its late answer is dropped', async () => {
    const r = rig({ answer: (m, def) => (m.type === 'ble-connect' ? undefined : def(m)) });
    const device = await r.bt.requestDevice(DIAL_FILTER);
    const p = rejects(device.gatt.connect(), 'NetworkError');
    await r.clock.advance(20000);
    await p;
    r.reply(r.of('ble-connect')[0].id, { services: [{ uuid: DIAL_SERVICE, chars: CHARS }] });
    await settle();
    assert.strictEqual(device.gatt.connected, false);
});

t('writes carry exactly the bytes given, acknowledged or not', async () => {
    const r = rig();
    const { service } = await connected(r);
    const state = await service.getCharacteristic(STATE);
    // A view into the middle of a larger buffer: only its own bytes go.
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    await state.writeValueWithResponse(big.subarray(2, 5));
    await state.writeValueWithoutResponse(new Uint8Array([4]).buffer);
    await state.writeValue(new DataView(new Uint8Array([0, 5]).buffer, 1));
    const w = r.of('ble-write');
    assert.deepStrictEqual(w.map((m) => unb64(m.value)), [[1, 2, 3], [4], [5]]);
    assert.deepStrictEqual(w.map((m) => m.response), [true, false, true]);
    assert.ok(w.every((m) => m.device === 'dial-0123' && m.char === STATE));
});

t('an over-long write is refused here, a refused write rejects', async () => {
    const r = rig({
        answer: (m, def) => (m.type === 'ble-write'
            ? { error: { name: 'NetworkError', message: 'the dial refused the write (status 13)' } } : def(m)),
    });
    const { service } = await connected(r);
    const spec = await service.getCharacteristic(SPEC);
    await rejects(spec.writeValueWithResponse(new Uint8Array(513)), 'InvalidModificationError');
    assert.strictEqual(r.of('ble-write').length, 0);
    const e = await rejects(spec.writeValueWithResponse(new Uint8Array(172)), 'NetworkError');
    assert.match(e.message, /status 13/);
});

t('a notification arrives as a buffer of exactly the value', async () => {
    const r = rig();
    const { service } = await connected(r);
    const input = await service.getCharacteristic(INPUT);
    const seen = [];
    input.addEventListener('characteristicvaluechanged', (e) => seen.push([...new Uint8Array(e.target.value.buffer)]));
    assert.strictEqual(await input.startNotifications(), input);
    assert.deepStrictEqual(r.of('ble-notify').map((m) => m.char), [INPUT]);
    assert.strictEqual(r.send('ble-value:' + JSON.stringify({ device: 'dial-0123', char: INPUT, value: b64([1, 3, 2, 0xfe]) })), true);
    assert.deepStrictEqual(seen, [[1, 3, 2, 0xfe]]);
    assert.deepStrictEqual([...new Uint8Array(input.value.buffer)], [1, 3, 2, 0xfe]);
    // Upper-case from a host is the same characteristic.
    r.send('ble-value:' + JSON.stringify({ device: 'dial-0123', char: INPUT.toUpperCase(), value: b64([16, 1]) }));
    assert.strictEqual(seen.length, 2);
    // Another device, another characteristic, rubbish: nothing, and still claimed.
    assert.strictEqual(r.send('ble-value:' + JSON.stringify({ device: 'dial-other', char: INPUT, value: b64([1]) })), true);
    r.send('ble-value:' + JSON.stringify({ device: 'dial-0123', char: STATE, value: b64([1]) }));
    assert.strictEqual(r.send('ble-value:not json'), true);
    assert.strictEqual(seen.length, 2);
});

t('the link dropping fires gattserverdisconnected once and fails what was waiting', async () => {
    const r = rig({ answer: (m, def) => (m.type === 'ble-write' ? undefined : def(m)) });
    const { device, service } = await connected(r);
    const input = await service.getCharacteristic(INPUT);
    const state = await service.getCharacteristic(STATE);
    let drops = 0;
    device.addEventListener('gattserverdisconnected', () => { drops += 1; });
    const seen = [];
    input.addEventListener('characteristicvaluechanged', () => seen.push(1));
    const pendingWrite = state.writeValueWithResponse(new Uint8Array([1]));
    r.send('ble-disconnected:' + JSON.stringify({ device: 'dial-0123' }));
    r.send('ble-disconnected:' + JSON.stringify({ device: 'dial-0123' }));
    assert.strictEqual(drops, 1);
    assert.strictEqual(device.gatt.connected, false);
    await rejects(pendingWrite, 'NetworkError');
    // A value still in flight from the old link is dropped.
    r.send('ble-value:' + JSON.stringify({ device: 'dial-0123', char: INPUT, value: b64([1, 1]) }));
    assert.deepStrictEqual(seen, []);
    await rejects(state.writeValueWithResponse(new Uint8Array([1])), 'NetworkError');
});

t('disconnect() tells the host, and the page hears the event as in a browser', async () => {
    const r = rig();
    const { device } = await connected(r);
    let drops = 0;
    device.addEventListener('gattserverdisconnected', () => { drops += 1; });
    device.gatt.disconnect();
    assert.deepStrictEqual(r.of('ble-disconnect').map((m) => m.device), ['dial-0123']);
    assert.strictEqual(drops, 1);
    // Twice is once.
    device.gatt.disconnect();
    assert.strictEqual(r.of('ble-disconnect').length, 1);
    // And it connects again.
    await device.gatt.connect();
    assert.strictEqual(device.gatt.connected, true);
});

t('request ids do not start at 1, so a reply meant for a previous page is not mistaken', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
        const r = rig({ answer: () => undefined });
        r.bt.getDevices();
        ids.push(r.of('ble-devices')[0].id);
    }
    assert.ok(new Set(ids).size > 1, 'random base per page load');
});

// ---- v2's own driver ---------------------------------------------------------------

// The Dial driver reads the globals; point them at this rig's window.
function asPage(r) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: r.win.navigator });
    globalThis.window = r.win;
}

t('v2 sees Bluetooth where the app offers it', () => {
    const r = rig();
    asPage(r);
    assert.strictEqual(D.dialAvailable('bluetooth'), true);
    asPage(rig({ flags: {} }));
    assert.strictEqual(D.dialAvailable('bluetooth'), false);
});

t('v2\'s DialControl connects, hears the knob, writes state and notices the dial going', async () => {
    const r = rig();
    asPage(r);
    const dial = new D.DialControl();
    const messages = [];
    const events = [];
    dial.on('message', (m) => messages.push(m));
    dial.on('input', (e) => events.push(e));
    assert.strictEqual(await dial.connect(), true);
    assert.strictEqual(dial.connected, true);
    assert.strictEqual(dial.deviceName, 'UberSDR Dial 1A2B');
    assert.deepStrictEqual(r.of('ble-notify').map((m) => m.char), [INPUT]);
    assert.deepStrictEqual(messages.at(-1), { text: 'UberSDR Dial 1A2B connected', tone: 'good' });

    // Tune +2, as the dial sends it.
    r.send('ble-value:' + JSON.stringify({ device: 'dial-0123', char: INPUT, value: b64([1, 2]) }));
    assert.deepStrictEqual(events.map((e) => e.key), ['tune_up', 'tune_up']);

    dial.setState({ frequency: 14074000, mode: 'usb', volume: 0.5 });
    dial.setName('M9PSY');
    await settle();
    const writes = r.of('ble-write');
    const st = writes.find((m) => m.char === STATE);
    assert.ok(st, 'state written');
    assert.strictEqual(st.response, true, 'acknowledged, so a slow link cannot queue up');
    const bytes = Uint8Array.from(unb64(st.value));
    assert.strictEqual(bytes.length, D.STATE_BYTES);
    assert.strictEqual(new DataView(bytes.buffer).getUint32(1, true), 14074000);
    assert.deepStrictEqual(Buffer.from(unb64(writes.find((m) => m.char === NAME).value)).toString(), 'M9PSY');

    let state = null;
    dial.on('state', (s) => { state = s; });
    r.send('ble-disconnected:' + JSON.stringify({ device: 'dial-0123' }));
    await settle();
    assert.strictEqual(dial.connected, false);
    assert.deepStrictEqual(state, { connected: false });
});

t('v2\'s DialControl reconnects quietly to the remembered dial, and says nothing when it is off', async () => {
    const r = rig({
        answer: (m, def) => (m.type === 'ble-connect' && r.host.off
            ? { error: { name: 'NetworkError', message: 'the dial did not answer' } } : def(m)),
    });
    asPage(r);
    const dial = new D.DialControl();
    const messages = [];
    dial.on('message', (m) => messages.push(m));

    // dial.js says why a quiet attempt came to nothing at debug level.
    const quiet = console.debug;
    console.debug = () => {};
    try {
        // Nothing remembered: nothing tried, nothing said.
        assert.strictEqual(await dial.autoConnect(), false);
        assert.strictEqual(r.of('ble-connect').length, 0);

        r.host.remembered = r.host.chosen;
        r.host.off = true;
        assert.strictEqual(await dial.autoConnect(), false);
    } finally {
        console.debug = quiet;
    }
    assert.deepStrictEqual(messages, [], 'a dial that is off is not an error on screen');
    // Once, not twice: bluetoothAutoConnect adds no second attempt.
    assert.strictEqual(r.of('ble-connect').length, 1);
    assert.strictEqual(r.of('ble-request').length, 0, 'never the chooser');

    r.host.off = false;
    assert.strictEqual(await dial.autoConnect(), true);
    assert.strictEqual(dial.connected, true);
    await dial.disconnect();
    assert.strictEqual(r.of('ble-disconnect').length, 1);
});

chain.then(() => {
    console.log(`\n${pass} ok`);
});
