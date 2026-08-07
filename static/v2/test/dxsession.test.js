// The DX cluster session, which outlives the panel that shows it.
//
// The point of the module is a lifetime, and a lifetime is awkward to test — so what is
// below is the observable half of it: the state a subscriber sees, the transcript
// surviving a disconnect, and the one-automatic-attempt flag that used to live in the
// component and reset itself every time a dock was collapsed.
//
// There is no WebSocket in node, so `dxConnect` gets as far as openTerminal and comes
// straight back with a closed terminal — which is the same path a browser takes against
// a receiver with no cluster behind it, and it is the failure worth being sure of.

const assert = require('assert');
const dx = require('./.build/dxsession.cjs');

let pass = 0;
const t = (name, fn) => {
    dx._resetDxSession();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- what a fresh page looks like ------------------------------------------------

t('nothing is connected, and nothing has been said', () => {
    assert.deepStrictEqual(dx.dxSession(), { state: 'closed', detail: '', text: '' });
    assert.strictEqual(dx.dxConnected(), false);
});

t('a connection needs a callsign', () => {
    // The cluster login *is* the callsign; without one there is nothing to send.
    assert.strictEqual(dx.dxConnect({ callsign: '   ' }), false);
    assert.strictEqual(dx.dxConnect({}), false);
    assert.strictEqual(dx.dxSession().state, 'closed');
});

// --- subscribers -------------------------------------------------------------------

t('a subscriber hears state changes, and can stop hearing them', () => {
    const seen = [];
    const off = dx.onDxSession((s) => seen.push(s.state));
    dx.dxDisconnect();
    off();
    dx.dxDisconnect();
    assert.deepStrictEqual(seen, ['closed'], 'one notification, and none after');
});

t('a subscriber that throws does not take the others down', () => {
    let heard = 0;
    const offBad = dx.onDxSession(() => { throw new Error('bad subscriber'); });
    const offGood = dx.onDxSession(() => { heard += 1; });
    dx.dxDisconnect();
    offBad();
    offGood();
    assert.strictEqual(heard, 1);
});

// --- the transcript ------------------------------------------------------------------

t('disconnecting keeps what the cluster said', () => {
    // Leaving the cluster is not throwing away what it told you — and the panel is
    // often unmounted at that moment, which is the whole reason this lives out here.
    dx.dxConnect({ callsign: 'G0RDH' });
    const before = dx.dxSession().text;
    dx.dxDisconnect();
    assert.strictEqual(dx.dxSession().text, before);
    assert.strictEqual(dx.dxSession().state, 'closed');
});

t('sending goes nowhere when there is nothing to send it to', () => {
    assert.strictEqual(dx.dxSend('sh/dx'), false);
});

// --- the one automatic attempt ---------------------------------------------------------

t('the remembered callsign gets one attempt per page, not one per remount', () => {
    // This flag used to live in the panel, where a collapsed dock reset it — so the
    // panel reappearing would log back in over a disconnect the operator had just made.
    assert.strictEqual(dx.dxAutoTried(), false);
    dx.markDxAutoTried();
    assert.strictEqual(dx.dxAutoTried(), true);
});

t('only a reset — which is a page load — offers it again', () => {
    dx.markDxAutoTried();
    dx._resetDxSession();
    assert.strictEqual(dx.dxAutoTried(), false);
});

if (process.exitCode) console.log('\nDX session tests FAILED');
else console.log(`\nall ${pass} DX session tests passed`);
