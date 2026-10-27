// Radio Sync's connect/disconnect state machine.
//
// Not the Hamlib module — that is 14 MB of WebAssembly and none of it is the
// part that goes wrong. What goes wrong is the bookkeeping around it, because
// every call into the module is Asyncify and a call that never wakes up never
// settles: the module's own comments describe that failure, and the queue means
// one stuck call holds up every call behind it.
//
// The bug these pin down: `busy` was held until after the initial frequency and
// mode push, which happens *after* connected is set and after "Connected to X"
// goes in the log. A rig that accepted the port and then stopped answering left
// the log saying it was connected while the panel showed a disabled
// "Connecting…" — and the port could not be closed, because Disconnect is
// disabled while busy.

const assert = require('assert');
const { RadioSync } = require('./.build/radiosync.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    );
};

const RIG = {
    model: '1035', mfg: 'Icom', name: 'IC-7300',
    baudMax: 115200, dataBits: 8, stopBits: 1, parity: 0, handshake: 0,
};

// Web Serial has to look present, and the module has to look loaded.
function makeSync({ open, setFreq, setMode, closeRig } = {}) {
    global.navigator = { serial: {} };
    const sync = new RadioSync();
    sync.rigs = [RIG];
    sync.ensureLoaded = () => Promise.resolve(sync.rigs);
    sync.open = open || (() => Promise.resolve(7));
    sync.closeRig = closeRig || (() => Promise.resolve(0));
    sync.setFreq = setFreq || (() => Promise.resolve(0));
    sync.setMode = setMode || (() => Promise.resolve(0));
    sync.getFreq = () => Promise.resolve(14074000);
    sync.getMode = () => Promise.resolve('USB');
    sync.getPtt = () => Promise.resolve(0);
    // The radio facade. Only the tuning is read on connect.
    sync.setContext({
        actions: {},
        state: () => ({ tuning: { frequency: 14074000, mode: 'usb' }, audio: {}, squelch: {}, dsp: {}, view: {} }),
    });
    return sync;
}

const never = () => new Promise(() => {});
const settled = () => new Promise((r) => setTimeout(r, 0));

// Against the broken version these tests do not fail, they *hang*: `connect`
// awaited a call that never settles, so its own promise never settled either.
// A suite that stops dead is worse than one that goes red, so anything that
// could wait for ever is given a deadline here.
function within(promise, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => { setTimeout(() => reject(new Error(`${label} never finished`)), 2000); }),
    ]);
}

t('an open that succeeds ends the connect', async () => {
    const sync = makeSync();
    const ok = await sync.connect('1035', 0);
    assert.strictEqual(ok, true);
    assert.strictEqual(sync.connected, true);
    assert.strictEqual(sync.busy, false, 'the connect never finished');
    assert.strictEqual(sync.handle, 7);
    sync._stopPolling();
});

t('a rig that goes quiet after the port opens can still be disconnected', async () => {
    // The reported fault. set_freq is the first thing said to the rig after the
    // port is open; if it never answers, the connect must still be over.
    const sync = makeSync({ setFreq: never });
    await within(sync.connect('1035', 0), 'connect');

    assert.strictEqual(sync.connected, true);
    assert.strictEqual(
        sync.busy, false,
        'busy was held across the initial push, which disables Disconnect',
    );
    sync._stopPolling();
});

t('the state that says "connected" goes out before anything else is tried', async () => {
    // The panel is driven by 'state', and the log by 'message'. If the state
    // saying connected comes after a call that can hang, the log says one thing
    // and the buttons another — which is exactly what was reported.
    const seen = [];
    const sync = makeSync({ setFreq: never });
    sync.on('state', (s) => seen.push({ connected: s.connected, busy: s.busy }));
    sync.on('message', (m) => seen.push({ msg: m.text }));

    await within(sync.connect('1035', 0), 'connect');
    sync._stopPolling();

    const connectedMsg = seen.findIndex((e) => e.msg && e.msg.startsWith('Connected to'));
    const usableState = seen.findIndex((e) => e.connected === true && e.busy === false);
    assert.ok(connectedMsg >= 0, 'never said it was connected');
    assert.ok(usableState >= 0, 'never published a state the panel can act on');
    assert.ok(
        usableState > connectedMsg,
        'the usable state must not be published before the message it belongs to',
    );
});

t('a push that fails does not undo a connection that worked', async () => {
    // The old catch zeroed the handle for this, losing the only reference to a
    // serial port that was open.
    const sync = makeSync({ setFreq: () => Promise.reject(new Error('rig said no')) });
    await sync.connect('1035', 0);
    await settled();

    assert.strictEqual(sync.connected, true);
    assert.strictEqual(sync.handle, 7, 'the handle to an open port was thrown away');
    sync._stopPolling();
});

t('an open that fails is a failed connect, and nothing is left busy', async () => {
    const sync = makeSync({ open: () => Promise.resolve(-1) });
    const ok = await sync.connect('1035', 0);
    assert.strictEqual(ok, false);
    assert.strictEqual(sync.connected, false);
    assert.strictEqual(sync.busy, false);
    assert.strictEqual(sync.handle, 0);
});

t('disconnect releases the panel even when the rig never answers', async () => {
    // Every call is queued behind the one in flight, and a rig that has stopped
    // answering is exactly when Disconnect gets pressed.
    const sync = makeSync({ closeRig: never });
    await within(sync.connect('1035', 0), 'connect');
    sync._stopPolling();

    const done = sync.disconnect();
    assert.strictEqual(sync.busy, true, 'the close should be in flight');

    // Rather than waiting out the real timeout.
    await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
    assert.strictEqual(sync.busy, true, 'it must not give up early either');
});

t('a close that answers tears everything down', async () => {
    const sync = makeSync();
    await sync.connect('1035', 0);
    sync._stopPolling();
    await sync.disconnect();

    assert.strictEqual(sync.connected, false);
    assert.strictEqual(sync.busy, false);
    assert.strictEqual(sync.handle, 0);
    assert.strictEqual(sync.rig.mode, '---');
});

t('disconnect greys the button while it works', async () => {
    const states = [];
    const sync = makeSync();
    await sync.connect('1035', 0);
    sync._stopPolling();
    sync.on('state', (s) => states.push({ connected: s.connected, busy: s.busy }));
    await sync.disconnect();

    assert.deepStrictEqual(states[0], { connected: true, busy: true }, 'no "working on it" state');
    assert.deepStrictEqual(states[states.length - 1], { connected: false, busy: false });
});

t('disconnecting twice is not two closes', async () => {
    let closes = 0;
    const sync = makeSync({ closeRig: () => { closes++; return Promise.resolve(0); } });
    await sync.connect('1035', 0);
    sync._stopPolling();
    await Promise.all([sync.disconnect(), sync.disconnect()]);
    assert.strictEqual(closes, 1);
});

t('connecting while already connected does nothing', async () => {
    let opens = 0;
    const sync = makeSync({ open: () => { opens++; return Promise.resolve(7); } });
    await sync.connect('1035', 0);
    sync._stopPolling();
    assert.strictEqual(await sync.connect('1035', 0), false);
    assert.strictEqual(opens, 1);
});

t('a press while a close is in flight says so rather than nothing', async () => {
    // "Clicking did nothing" is a bug report either way: the press has to leave
    // some trace, or a busy link is indistinguishable from a dead button.
    const msgs = [];
    const sync = makeSync({ closeRig: never });
    await within(sync.connect('1035', 0), 'connect');
    sync._stopPolling();
    sync.on('message', (m) => msgs.push(m.text));

    sync.disconnect();
    await within(sync.disconnect(), 'the second disconnect');
    assert.ok(msgs.some((m) => /Still working/.test(m)), 'the second press was silent');
});

t('a connected panel with no handle is put back in step', async () => {
    // Reachable if a close tore down the handle without the panel hearing the
    // state that went with it. The button then cannot work, so pressing it
    // corrects the panel instead of doing nothing.
    const sync = makeSync();
    await sync.connect('1035', 0);
    sync._stopPolling();
    sync.handle = 0;

    const states = [];
    sync.on('state', (s) => states.push(s.connected));
    await sync.disconnect();
    assert.strictEqual(sync.connected, false);
    assert.deepStrictEqual(states, [false]);
});

t('an unknown rig model is refused before anything is opened', async () => {
    let opens = 0;
    const sync = makeSync({ open: () => { opens++; return Promise.resolve(7); } });
    assert.strictEqual(await sync.connect('9999', 0), false);
    assert.strictEqual(opens, 0);
    assert.strictEqual(sync.busy, false);
});

// Mute on TX. The plain path presses the user's mute, which is upstream of the
// recorder tap; recordDuringTx has to leave that alone and use the speakers-only
// gate instead, or a recording across the over is a file of silence.
function txRig() {
    const calls = [];
    const audio = { muted: false };
    const sync = new RadioSync();
    sync.setContext({
        actions: {
            toggleMute: () => { audio.muted = !audio.muted; calls.push(['mute', audio.muted]); },
            setTxSilenced: (on) => calls.push(['gate', on]),
        },
        state: () => ({ tuning: { frequency: 0, mode: 'usb' }, audio }),
    });
    return { sync, calls, audio };
}

t('mute on TX presses the mute and gives it back', () => {
    const { sync, calls, audio } = txRig();
    sync._onPtt(true);
    sync._onPtt(false);
    assert.deepStrictEqual(calls, [['mute', true], ['mute', false]]);
    assert.strictEqual(audio.muted, false);
});

t('recordDuringTx gates the speakers and never touches the mute', () => {
    const { sync, calls, audio } = txRig();
    sync.setRecordDuringTx(true);
    sync._onPtt(true);
    sync._onPtt(false);
    assert.deepStrictEqual(calls, [['gate', true], ['gate', false]]);
    assert.strictEqual(audio.muted, false);
});

t('switching recordDuringTx mid-over moves the silence to the other path', () => {
    const { sync, calls, audio } = txRig();
    sync._onPtt(true);
    sync.setRecordDuringTx(true);
    assert.strictEqual(audio.muted, false, 'still muted after moving to the gate');
    sync.setRecordDuringTx(false);
    sync._onPtt(false);
    assert.deepStrictEqual(calls, [
        ['mute', true], ['mute', false], ['gate', true], ['gate', false], ['mute', true], ['mute', false],
    ]);
    assert.strictEqual(audio.muted, false);
});

t('turning mute on TX off mid-over opens the gate', () => {
    const { sync, calls } = txRig();
    sync.setRecordDuringTx(true);
    sync._onPtt(true);
    sync.setMuteOnTx(false);
    assert.deepStrictEqual(calls, [['gate', true], ['gate', false]]);
});

// The reported fault: ControlWatch hands the saved settings over on every load,
// and with mute on TX off that ran _endTx with nothing transmitting — which
// unmuted a receiver the operator had muted themselves.
t('turning mute on TX off while receiving leaves a manual mute alone', () => {
    const { sync, calls, audio } = txRig();
    audio.muted = true;
    sync.setMuteOnTx(false);
    sync.setMuteOnTx(false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(audio.muted, true);
});

t('a mute pressed during the over is not undone by a repeated settings push', () => {
    const { sync, audio } = txRig();
    sync.setMuteOnTx(false);
    sync._onPtt(true);
    audio.muted = true;         // the operator mutes by hand mid-over
    sync.setMuteOnTx(false);
    sync._onPtt(false);
    assert.strictEqual(audio.muted, true);
});

t('a receiver already muted at the start of the over stays muted after it', () => {
    const { sync, calls, audio } = txRig();
    audio.muted = true;
    sync._onPtt(true);
    sync._onPtt(false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(audio.muted, true);
});

t('a disconnect mid-over opens the gate', async () => {
    const { sync, calls } = txRig();
    sync.setRecordDuringTx(true);
    sync._onPtt(true);
    sync.connected = true;
    sync.handle = 7;
    sync.closeRig = () => Promise.resolve(0);
    await sync.disconnect();
    assert.deepStrictEqual(calls, [['gate', true], ['gate', false]]);
});

// --- serial auto-connect ------------------------------------------------------
//
// The bridge can only get a port from requestPort(), which needs a click. Auto-
// connect finds the remembered adapter with getPorts() and hands it over by
// shadowing requestPort for the one synchronous call that starts open().

const FTDI = { usbVendorId: 0x0403, usbProductId: 0x6001 };
const CP210X = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
const fakePort = (id, open = false) => ({ getInfo: () => ({ ...id }), readable: open ? {} : null });

// makeSync, with getPorts answering `ports` and an open() that records which
// port the bridge was given — the way the real bridge would get it.
function autoSync(ports, { open } = {}) {
    const sync = makeSync();
    const opened = [];
    const realRequest = () => Promise.reject(Object.assign(new Error('no gesture'), { name: 'SecurityError' }));
    global.navigator.serial = { getPorts: () => Promise.resolve(ports), requestPort: realRequest };
    Object.setPrototypeOf(global.navigator.serial, { requestPort: realRequest });
    delete global.navigator.serial.requestPort;
    const bridge = sync._guardBridge({
        ports: new Map(),
        async open() {
            const port = await navigator.serial.requestPort();
            opened.push(port);
            this.ports.set(1000, { port });
            return 1000;
        },
    });
    sync.open = open || (async () => bridge.open());
    const alerts = [];
    const saved = [];
    sync.on('autoproblem', (p) => alerts.push(p));
    sync.on('port', (p) => saved.push(p.port));
    return { sync, opened, alerts, saved };
}

t('auto-connect opens the remembered adapter without a picker', async () => {
    const want = fakePort(FTDI);
    const { sync, opened, alerts, saved } = autoSync([fakePort(CP210X), want]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', baud: 0, port: FTDI }), true);
    assert.strictEqual(opened[0], want);
    assert.strictEqual(sync.connected, true);
    assert.deepStrictEqual(saved, [FTDI]);
    assert.deepStrictEqual(alerts, []);
    assert.strictEqual(sync.autoProblem, null);
    // The shadow is gone: the page's own requestPort is back.
    assert.ok(!Object.prototype.hasOwnProperty.call(navigator.serial, 'requestPort'));
    sync._stopPolling();
});

t('a connect by hand remembers whichever adapter was picked', async () => {
    const picked = fakePort(CP210X);
    const { sync, saved } = autoSync([]);
    navigator.serial.requestPort = () => Promise.resolve(picked);
    assert.strictEqual(await sync.connect('1035', 0), true);
    assert.deepStrictEqual(saved, [CP210X]);
    sync._stopPolling();
});

t('an adapter that is not plugged in waits quietly, and nothing is loaded', async () => {
    const { sync, alerts } = autoSync([fakePort(CP210X)]);
    let loads = 0;
    sync.ensureLoaded = () => { loads++; return Promise.resolve(sync.rigs); };
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false);
    assert.strictEqual(loads, 0, 'Hamlib fetched for an adapter that is not there');
    assert.strictEqual(sync.autoProblem.tone, 'warn');
    assert.match(sync.autoProblem.text, /USB 0403:6001/);
    assert.deepStrictEqual(alerts, [], 'a switched-off radio is not worth a toast');
});

t('two adapters of the same kind are refused, loudly', async () => {
    const { sync, opened, alerts } = autoSync([fakePort(FTDI), fakePort(FTDI)]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false);
    assert.deepStrictEqual(opened, []);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /cannot tell which one/);
});

t('an adapter already open in this page is not opened twice', async () => {
    const { sync, opened, alerts } = autoSync([fakePort(FTDI, true)]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false);
    assert.deepStrictEqual(opened, []);
    assert.match(alerts[0].text, /already open/);
});

t('one free adapter beside one in use is the radio', async () => {
    const free = fakePort(FTDI);
    const { sync, opened } = autoSync([fakePort(FTDI, true), free]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), true);
    assert.strictEqual(opened[0], free);
    sync._stopPolling();
});

t('nothing remembered yet says to connect once by hand', async () => {
    const { sync, alerts } = autoSync([fakePort(FTDI)]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: null }), false);
    assert.match(sync.autoProblem.text, /Press Connect once/);
    assert.deepStrictEqual(alerts, []);
});

t('a rig that does not answer is reported with the reason', async () => {
    const { sync, alerts } = autoSync([fakePort(FTDI)], { open: () => Promise.resolve(-5) });
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /^Auto-connect failed: /);
    assert.strictEqual(sync.autoProblem.tone, 'error');
});

t('a port found but never opened is not handed to the next connect', async () => {
    // Hamlib failing to load returns before open(); the next open is somebody
    // at the picker, and must get the picker.
    const { sync } = autoSync([fakePort(FTDI)]);
    sync.ensureLoaded = () => Promise.reject(new Error('offline'));
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false);
    assert.strictEqual(sync._presetPort, null);
    assert.match(sync.autoProblem.text, /Hamlib could not be loaded: offline/);
});

t('Disconnect holds auto-connect off until the next Connect', async () => {
    const { sync } = autoSync([fakePort(FTDI)]);
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), true);
    await sync.disconnect({ byHand: true });
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), false, 'replug reconnected');
    navigator.serial.requestPort = () => Promise.resolve(fakePort(FTDI));
    assert.strictEqual(await sync.connect('1035', 0), true);
    await sync.disconnect();     // lost contact, not the button
    assert.strictEqual(await sync.autoConnect({ model: '1035', port: FTDI }), true);
    sync._stopPolling();
});

t('a connect by hand clears the auto-connect problem', async () => {
    const { sync } = autoSync([]);
    await sync.autoConnect({ model: '1035', port: FTDI });
    assert.ok(sync.autoProblem);
    navigator.serial.requestPort = () => Promise.resolve(fakePort(FTDI));
    await sync.connect('1035', 0);
    assert.strictEqual(sync.autoProblem, null);
    sync._stopPolling();
});

chain.then(() => {
    if (process.exitCode) console.log('\nradio sync tests FAILED');
    else console.log(`\nall ${pass} radio sync tests passed`);
});
