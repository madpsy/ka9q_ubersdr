// The TCI wire format, and what this client does with it.
//
// Pinned because the protocol is somebody else's and this has to match it
// exactly: a frame may carry several commands, `dds` is not the tuned
// frequency, and a mode TCI has no name for must not be sent as one.
//
// TciLink.onFrame needs no socket, so the semantics are testable without a
// server — which is the half worth testing, the WebSocket underneath being
// Chromium's rather than ours.

const assert = require('assert');
const { TciLink, parseFrame, TCI_TO_SDR, SDR_TO_TCI } = require('../tci.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** A link with no socket: fed frames by hand, recording what it reports. */
function link() {
    const states = [];
    const l = new TciLink({ host: 'x', port: 1, onState: (s) => states.push(s) });
    return { l, states, last: () => states[states.length - 1] };
}

// --- the wire format ---------------------------------------------------------

t('a frame may carry several commands', () => {
    assert.deepStrictEqual(parseFrame('vfo:0,0,14074000;modulation:0,usb;'), [
        { name: 'vfo', args: ['0', '0', '14074000'] },
        { name: 'modulation', args: ['0', 'usb'] },
    ]);
});

t('a command may have no arguments at all', () => {
    assert.deepStrictEqual(parseFrame('ready;'), [{ name: 'ready', args: [] }]);
    assert.deepStrictEqual(parseFrame('start;stop;'), [
        { name: 'start', args: [] }, { name: 'stop', args: [] },
    ]);
});

t('names are matched without regard to case, and whitespace is ignored', () => {
    assert.deepStrictEqual(parseFrame('  VFO : 0 , 0 , 7100000 ; '), [
        { name: 'vfo', args: ['0', '0', '7100000'] },
    ]);
});

t('an empty or trailing-separator frame yields nothing', () => {
    assert.deepStrictEqual(parseFrame(''), []);
    assert.deepStrictEqual(parseFrame(';;'), []);
});

// --- what it takes from the radio -------------------------------------------

const HANDSHAKE = 'device:X;protocol:ExpertSDR3,1.9;trx_count:1;'
    + 'modulations_list:am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm;'
    + 'dds:0,14100000;vfo:0,0,14074000;vfo:0,1,7100000;modulation:0,usb;trx:0,false;ready;';

t('nothing is reported until the radio says it is ready', () => {
    const { l, states } = link();
    l.onFrame('vfo:0,0,14074000;modulation:0,usb;');
    assert.deepStrictEqual(states, [], 'the handshake is not a state');
    l.onFrame('ready;');
    assert.strictEqual(states.length, 1);
});

t('the handshake leaves it connected, on the VFO and mode given', () => {
    const { l, last } = link();
    l.onFrame(HANDSHAKE);
    assert.strictEqual(last().connected, true);
    assert.strictEqual(last().frequency, 14074000);
    assert.strictEqual(last().sdrMode, 'usb');
    assert.strictEqual(last().tx, false);
});

t('dds is the panorama centre and is not the frequency', () => {
    // Dragging the panorama moves dds and not vfo; following it would take the
    // receiver off frequency for a gesture that never retuned anything.
    const { l, last } = link();
    l.onFrame(HANDSHAKE);
    l.onFrame('dds:0,18100000;');
    assert.strictEqual(last().frequency, 14074000, 'still where the VFO is');
});

t('only the first receiver and its first VFO are followed', () => {
    const { l, last } = link();
    l.onFrame(HANDSHAKE);
    l.onFrame('vfo:0,1,21000000;');     // VFO B
    l.onFrame('vfo:1,0,28000000;');     // second receiver
    assert.strictEqual(last().frequency, 14074000);
    l.onFrame('vfo:0,0,10130000;');
    assert.strictEqual(last().frequency, 10130000);
});

t('PTT is read, and a third argument does not confuse it', () => {
    const { l, last } = link();
    l.onFrame(HANDSHAKE);
    l.onFrame('trx:0,true,tune;');
    assert.strictEqual(last().tx, true);
    l.onFrame('trx:0,false;');
    assert.strictEqual(last().tx, false);
});

t('an unchanged value is not reported again', () => {
    // The radio repeats itself; the panel should not re-render for it.
    const { l, states } = link();
    l.onFrame(HANDSHAKE);
    const n = states.length;
    l.onFrame('vfo:0,0,14074000;modulation:0,usb;');
    assert.strictEqual(states.length, n);
});

t('a mode with no equivalent here is shown but not mapped', () => {
    const { l, last } = link();
    l.onFrame(HANDSHAKE);
    l.onFrame('modulation:0,digu;');
    assert.strictEqual(last().mode, 'DIGU', 'shown as the radio names it');
    assert.strictEqual(last().sdrMode, null, 'and never pushed at this receiver');
});

// --- what it sends back ------------------------------------------------------

t('the mode tables agree with each other where both have a name', () => {
    for (const [tci, sdr] of Object.entries(TCI_TO_SDR)) {
        assert.strictEqual(SDR_TO_TCI[sdr], tci, `${tci} → ${sdr} → ${SDR_TO_TCI[sdr]}`);
    }
    // TCI has one CW; both of this receiver's map onto it.
    assert.strictEqual(SDR_TO_TCI.cwu, 'cw');
    assert.strictEqual(SDR_TO_TCI.cwl, 'cw');
});

t('a mode the radio never listed is not sent', async () => {
    // TCI answers nothing at all, so an unsupported modulation is silently
    // ignored by the radio. The list from the handshake is the only warning.
    const { l } = link();
    const sent = [];
    l.send = (c) => { sent.push(c); return true; };
    l.onFrame('modulations_list:lsb,usb,cw;ready;');
    assert.strictEqual(await l.setMode('sam'), false, 'sam is not on this radio');
    assert.strictEqual(await l.setMode('usb'), true);
    assert.deepStrictEqual(sent, ['modulation:0,usb;']);
});

t('frequency and mode are sent for receiver 0, VFO 0', async () => {
    const { l } = link();
    const sent = [];
    l.send = (c) => { sent.push(c); return true; };
    l.onFrame(HANDSHAKE);
    await l.setFrequency(10130000.4);
    await l.setMode('cwl');
    assert.deepStrictEqual(sent, ['vfo:0,0,10130000;', 'modulation:0,cw;']);
});

console.log(`\n${pass} passed`);
