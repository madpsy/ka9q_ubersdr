// OmniRig: what the helper's lines mean, and how the link looks after it.
//
// The helper here is test/fake-omnirig-helper.js, run under this node — the
// same protocol as omnirig-helper.exe with the rig in memory, so this runs on
// any platform. The real helper is covered by omnirig/test/core_test.cpp
// (natively) and omnirig/test/wine_test.sh (the exe against a fake OmniRig).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    OmniRigLink, PM, OMNIRIG_TO_SDR, SDR_TO_OMNIRIG, stateFrom, helperErrorText, normaliseVfo, versionText,
} = require('../omnirig.js');

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const FAKE = path.join(__dirname, 'fake-omnirig-helper.js');
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'omnirig-test-'));
process.on('exit', () => fs.rmSync(LOGS, { recursive: true, force: true }));
let logs = 0;

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until `pred` holds, or fails after `ms`. */
async function until(pred, ms = 5000, what = 'condition') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await sleep(10);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A link on the fake helper, recording what it reports and what it sent. */
function link(scenario, opts = {}) {
    const file = path.join(LOGS, `${++logs}.log`);
    const states = [];
    const l = new OmniRigLink({
        rig: 1,
        onState: (s) => states.push(s),
        helper: { command: process.execPath, args: [FAKE, scenario, file] },
        restartMs: 50,
        ...opts,
    });
    return { l, states, last: () => states[states.length - 1], log: () => readLog(file) };
}

// --- what a state line means -------------------------------------------------

const online = {
    type: 'state', status: 4, statusText: 'On-line', rigType: 'IC-7300', freq: 14074000, mode: PM.SSB_U,
    tx: PM.RX, vfo: PM.VFOAA, split: PM.SPLITOFF, readable: PM.FREQ | PM.RX | PM.TX | PM.SSB_U,
    writeable: PM.FREQ,
};
// What the link knows beside the line: Rig 1, following the current VFO,
// OmniRig 1.20 (0x10014, as SoftwareVersion packs it).
const CTX = { rig: 1, vfo: '-', softwareVersion: 0x10014 };

t('an on-line rig is connected, with its frequency and mode', () => {
    const s = stateFrom(online, CTX);
    delete s.details;
    assert.deepStrictEqual(s, {
        connected: true, error: null, frequency: 14074000, mode: 'USB', sdrMode: 'usb',
        tx: false, pttAvailable: true, rig: 'IC-7300',
    });
});

// --- the rig's name, and the details under the readout ---------------------------

t('the model is RigType, and an empty or NONE slot has none', () => {
    assert.strictEqual(stateFrom({ ...online, rigType: ' FT-991 ' }, CTX).rig, 'FT-991');
    assert.strictEqual(stateFrom({ ...online, rigType: '' }, CTX).rig, null);
    assert.strictEqual(stateFrom({ ...online, rigType: 'NONE' }, CTX).rig, null);
    assert.strictEqual(stateFrom({ ...online, rigType: undefined }, CTX).rig, null);
});

t('an off-line radio is still named, in the readout and in the message', () => {
    const s = stateFrom({ ...online, status: 3 }, CTX);
    assert.strictEqual(s.rig, 'IC-7300');
    assert.match(s.error, /^The IC-7300 is not answering OmniRig/);
});

t('details on line: slot, VFO, what is followed, split, abilities, version', () => {
    assert.deepStrictEqual(stateFrom(online, CTX).details, [
        { label: 'OmniRig slot', value: 'Rig 1' },
        { label: 'VFO', value: 'A' },
        { label: 'Following', value: 'the VFO it receives on' },
        { label: 'Split', value: 'Off' },
        { label: 'Can read', value: 'frequency, mode, TX' },
        { label: 'Can set', value: 'frequency' },
        { label: 'OmniRig version', value: '1.20' },
    ]);
});

t('details follow the rig: split, the other VFO, a named VFO setting', () => {
    const d = stateFrom({ ...online, vfo: PM.VFOBA, split: PM.SPLITON }, { ...CTX, vfo: 'B' }).details;
    const get = (label) => (d.find((x) => x.label === label) || {}).value;
    assert.strictEqual(get('VFO'), 'B, transmitting on A');
    assert.strictEqual(get('Split'), 'On');
    assert.strictEqual(get('Following'), 'VFO B');
});

t('details leave out what the rig does not report', () => {
    const d = stateFrom({ ...online, vfo: 0, split: 0, readable: 0, writeable: 0 }, { ...CTX, softwareVersion: 0 })
        .details.map((x) => x.label);
    assert.deepStrictEqual(d, ['OmniRig slot', 'Following', 'Can read', 'Can set']);
    assert.strictEqual(stateFrom({ ...online, readable: 0 }, CTX).details
        .find((x) => x.label === 'Can read').value, 'nothing');
});

t('details off line are the slot and the version, not stale readings', () => {
    assert.deepStrictEqual(stateFrom({ ...online, status: 2 }, CTX).details, [
        { label: 'OmniRig slot', value: 'Rig 1' },
        { label: 'OmniRig version', value: '1.20' },
    ]);
});

t('OmniRig versions', () => {
    assert.strictEqual(versionText(0x10014), '1.20');
    assert.strictEqual(versionText(0x20005), '2.05');
    assert.strictEqual(versionText(0), null);
    assert.strictEqual(versionText(undefined), null);
});

t('transmit is PM_TX, and nothing else', () => {
    assert.strictEqual(stateFrom({ ...online, tx: PM.TX }, CTX).tx, true);
    assert.strictEqual(stateFrom({ ...online, tx: 0 }, CTX).tx, false);
});

t('a rig that cannot report TX has no PTT to offer', () => {
    assert.strictEqual(stateFrom({ ...online, readable: PM.FREQ }, CTX).pttAvailable, false);
});

t('a rig with no readable frequency reports none, not zero', () => {
    assert.strictEqual(stateFrom({ ...online, freq: 0 }, CTX).frequency, null);
});

t('CW is cwu and CW-reverse is cwl', () => {
    assert.strictEqual(stateFrom({ ...online, mode: PM.CW_U }, CTX).sdrMode, 'cwu');
    const r = stateFrom({ ...online, mode: PM.CW_L }, CTX);
    assert.strictEqual(r.sdrMode, 'cwl');
    assert.strictEqual(r.mode, 'CWR');
});

t('data modes are shown but not followed', () => {
    const s = stateFrom({ ...online, mode: PM.DIG_U }, CTX);
    assert.strictEqual(s.mode, 'DIG-U');
    assert.strictEqual(s.sdrMode, null);
});

t('every mode the receiver can send, the rig reads back as the same mode', () => {
    for (const [sdr, pm] of Object.entries(SDR_TO_OMNIRIG)) {
        assert.strictEqual(OMNIRIG_TO_SDR[pm], sdr, sdr);
    }
});

t('nfm and sam have no OmniRig counterpart', () => {
    assert.strictEqual(SDR_TO_OMNIRIG.nfm, undefined);
    assert.strictEqual(SDR_TO_OMNIRIG.sam, undefined);
});

// --- what the operator is told -----------------------------------------------

t('each off-line status says what to do, and names the rig', () => {
    const say = (status, rig = 2) => stateFrom({ ...online, status, rigType: '' }, { ...CTX, rig });
    assert.strictEqual(say(0).connected, false);
    assert.match(say(0).error, /^Rig 2 is not set up in OmniRig/);
    assert.match(say(1).error, /^Rig 2 is disabled in OmniRig/);
    assert.match(say(2).error, /serial port — another program may be using it/);
    assert.match(say(3).error, /not answering OmniRig — check it is on/);
});

t('an unknown status falls back to what OmniRig said', () => {
    assert.strictEqual(stateFrom({ ...online, status: 9, statusText: 'Odd' }, CTX).error, 'OmniRig: Odd');
});

t('none of the messages ends in a full stop — the panel appends to them', () => {
    const messages = [0, 1, 2, 3].map((s) => stateFrom({ ...online, status: s }, CTX).error)
        .concat(['not-installed', 'no-start', 'access-denied', 'no-rig', 'gone']
            .map((code) => helperErrorText({ code }, CTX)));
    for (const m of messages) assert.ok(!/\.$/.test(m), m);
});

t('helper errors are worded by code', () => {
    assert.match(helperErrorText({ code: 'not-installed' }, CTX), /^OmniRig is not installed — get it from/);
    assert.match(helperErrorText({ code: 'access-denied' }, CTX), /administrator/);
    assert.strictEqual(helperErrorText({ code: 'no-rig' }, 2), 'OmniRig has no Rig 2');
    assert.strictEqual(helperErrorText({ code: 'x', message: 'detail' }, CTX), 'OmniRig: detail');
});

t('VFO', () => {
    assert.strictEqual(normaliseVfo('a'), 'A');
    assert.strictEqual(normaliseVfo(' B '), 'B');
    assert.strictEqual(normaliseVfo(''), '-');
    assert.strictEqual(normaliseVfo('current'), '-');
    assert.strictEqual(normaliseVfo(undefined), '-');
    assert.strictEqual(normaliseVfo('C'), '-');
});

// --- the link, on the fake helper ---------------------------------------------

t('starts the helper with the rig and VFO', async () => {
    const { l, states, log } = link('online', { rig: 2, vfo: 'b' });
    l.start();
    await until(() => states.length, 5000, 'a state');
    l.stop();
    assert.deepStrictEqual(log()[0], { start: 'online', rig: '2', vfo: 'B' });
});

t('the Current VFO is passed as -', async () => {
    const { l, states, log } = link('online', { vfo: 'current' });
    l.start();
    await until(() => states.length, 5000, 'a state');
    l.stop();
    assert.strictEqual(log()[0].vfo, '-');
});

t('reports the rig, and follows what it is told', async () => {
    const { l, states, last, log } = link('online');
    l.start();
    await until(() => states.length, 5000, 'a state');
    assert.strictEqual(last().connected, true);
    assert.strictEqual(last().frequency, 14074000);
    assert.strictEqual(last().sdrMode, 'usb');
    assert.strictEqual(last().rig, 'IC-7300');
    // The version from the ready line reaches the details.
    assert.deepStrictEqual(last().details[last().details.length - 1],
        { label: 'OmniRig version', value: '1.20' });

    await l.setFrequency(7100000.4);
    await until(() => last().frequency === 7100000, 5000, 'the new frequency');
    assert.strictEqual(await l.setMode('cwl'), true);
    await until(() => last().sdrMode === 'cwl', 5000, 'the new mode');
    // A mode OmniRig has no counterpart for is not sent at all.
    assert.strictEqual(await l.setMode('nfm'), false);
    const exited = new Promise((r) => l.child.once('exit', r));
    l.stop();
    await exited;
    const commands = log().filter((e) => e.command).map((e) => e.command);
    assert.deepStrictEqual(commands, [`freq 7100000`, `mode ${PM.CW_L}`, 'quit']);
});

t('a command before the helper is ready is refused, not queued', async () => {
    const { l } = link('online');
    await assert.rejects(l.setFrequency(7100000), /not connected/);
    l.start();
    await assert.rejects(l.setFrequency(7100000), /not connected/);
    l.stop();
});

t('an off-line rig is reported once, in words', async () => {
    const { l, states } = link('offline');
    l.start();
    await until(() => states.length, 5000, 'a state');
    await sleep(100);
    l.stop();
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0].connected, false);
    assert.match(states[0].error, /^The IC-7300 is not answering OmniRig/);
});

t('OmniRig not installed: said once, and retried quietly', async () => {
    const { l, states, log } = link('not-installed');
    l.start();
    await until(() => log().filter((e) => e.start).length >= 3, 5000, 'three attempts');
    l.stop();
    assert.strictEqual(states.length, 1);
    assert.match(states[0].error, /^OmniRig is not installed/);
});

t('OmniRig going away is reported, and the helper restarted', async () => {
    const { l, states } = link('gone');
    l.start();
    await until(() => states.some((s) => !s.connected), 5000, 'the disconnect');
    const down = states.find((s) => !s.connected);
    assert.strictEqual(down.error, 'OmniRig was closed or stopped answering');
    // Back up by itself, and saying so.
    await until(() => states.filter((s) => s.connected).length >= 2, 5000, 'the reconnect');
    l.stop();
});

t('a missing helper is said plainly, and not retried', async () => {
    const states = [];
    const l = new OmniRigLink({
        rig: 1, onState: (s) => states.push(s),
        helper: { command: path.join(__dirname, 'no-such-helper.exe'), args: [] }, restartMs: 20,
    });
    l.start();
    await until(() => states.length, 5000, 'a state');
    await sleep(150);
    l.stop();
    assert.strictEqual(states.length, 1);
    assert.match(states[0].error, /^OmniRig support is missing from this build/);
});

t('a rig other than 1 or 2 is refused without starting anything', async () => {
    const { l, states, log } = link('online', { rig: 3 });
    l.start();
    await sleep(100);
    l.stop();
    assert.strictEqual(states.length, 1);
    assert.match(states[0].error, /^OmniRig has only Rig 1 and Rig 2/);
    assert.deepStrictEqual(log(), []);
});

t('stop ends the helper and silences the link', async () => {
    const { l, states } = link('online');
    l.start();
    await until(() => states.length, 5000, 'a state');
    const child = l.child;
    const exited = new Promise((r) => child.once('exit', r));
    l.stop();
    await exited;
    const n = states.length;
    await sleep(100);
    assert.strictEqual(states.length, n);
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`${pass}/${tests.length} passed`);
})();
