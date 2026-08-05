// Driving the receiver from hardware.
//
// The bug this module exists to fix: all of this used to live in the SDR Control
// panel, and a collapsed section is unmounted. Collapsing the panel took the
// `input` subscription with it — the surface stayed connected and the badge
// above the spectrum went on saying so, but a knob that had been tuning the
// receiver a moment earlier did nothing.
//
// So what is tested here is mostly independence: that dispatch, autoconnect and
// the Disconnect that outranks it do not depend on anybody rendering.

const assert = require('assert');
// One bundle, deliberately — see dispatch.entry.js.
const dispatch = require('./.build/dispatch.cjs');
const { getSurface } = dispatch;

let pass = 0;
// Subscriptions are torn down whatever the test did, so one failure cannot leak
// a live watcher into the next and make it see every event twice.
const cleanup = [];
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    finally { while (cleanup.length) cleanup.pop()(); }
};
const watch = (id) => { const off = dispatch.watchSurface(id); cleanup.push(off); return off; };

// The real surface singletons, driven by hand: emitting 'input' on one is
// exactly what a knob being turned does.
const midi = getSurface('midi');

function reset() {
    dispatch._resetDispatch();
    midi.connected = false;
    midi.deviceId = null;
}

// A radio facade that records what was asked of it.
function fakeCtx() {
    const calls = [];
    return {
        calls,
        stepHz: 100,
        actions: new Proxy({}, {
            get: (_, name) => (...args) => { calls.push([name, ...args]); return true; },
        }),
        state: () => ({
            tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2750 },
            audio: { volume: 50, muted: false },
            squelch: {},
            dsp: {},
            view: {},
        }),
    };
}

t('a mapped control drives the receiver with nothing rendered', () => {
    reset();
    const ctx = fakeCtx();
    dispatch.setControlContext(ctx);
    dispatch.setSurfaceMappings('midi', { 'cc:1:10': { function: 'volume_up' } });
    const off = watch('midi');

    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    assert.ok(ctx.calls.length > 0, 'the mapping did not reach the receiver');
    off();
});

t('unsubscribing stops the dispatch', () => {
    reset();
    const ctx = fakeCtx();
    dispatch.setControlContext(ctx);
    dispatch.setSurfaceMappings('midi', { 'cc:1:10': { function: 'volume_up' } });
    const off = watch('midi');
    off();

    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    assert.strictEqual(ctx.calls.length, 0);
});

t('an unmapped control does nothing', () => {
    reset();
    const ctx = fakeCtx();
    dispatch.setControlContext(ctx);
    dispatch.setSurfaceMappings('midi', {});
    const off = watch('midi');

    midi.emit('input', { key: 'cc:1:99', event: { kind: 'trigger' } });
    assert.strictEqual(ctx.calls.length, 0);
    off();
});

t('learn takes the input before the dispatcher does', () => {
    reset();
    const ctx = fakeCtx();
    dispatch.setControlContext(ctx);
    dispatch.setSurfaceMappings('midi', { 'cc:1:10': { function: 'volume_up' } });
    const off = watch('midi');

    const seen = [];
    const stopLearn = dispatch.setLearnHandler((e) => { seen.push(e.key); return true; });
    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    assert.deepStrictEqual(seen, ['cc:1:10']);
    assert.strictEqual(ctx.calls.length, 0, 'the control fired while it was being learned');

    // And the receiver is driven again the moment learning stops — the panel
    // closing must not leave the surface deaf.
    stopLearn();
    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    assert.ok(ctx.calls.length > 0);
    off();
});

t('a learn handler that declines an event lets it through', () => {
    reset();
    const ctx = fakeCtx();
    dispatch.setControlContext(ctx);
    dispatch.setSurfaceMappings('midi', { 'cc:1:10': { function: 'volume_up' } });
    const off = watch('midi');

    dispatch.setLearnHandler(() => false);
    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    assert.ok(ctx.calls.length > 0);
    off();
});

t('with no receiver yet, input is dropped rather than thrown on', () => {
    reset();
    dispatch.setSurfaceMappings('midi', { 'cc:1:10': { function: 'volume_up' } });
    const off = watch('midi');
    midi.emit('input', { key: 'cc:1:10', event: { kind: 'trigger' } });
    off();
});

t('watching nothing is safe', () => {
    reset();
    assert.strictEqual(typeof dispatch.watchSurface('off'), 'function');
    assert.strictEqual(typeof dispatch.watchSurface(''), 'function');
    dispatch.watchSurface('off')();
});

// --- connecting unattended ---------------------------------------------------

t('autoconnect does nothing unless it is switched on', () => {
    reset();
    let asked = null;
    midi.devices = () => [{ id: 'in-1', name: 'Knob Box' }];
    midi.connect = (id) => { asked = id; return true; };

    dispatch.tryAutoConnect('midi', { autoConnect: false, device: 'Knob Box' });
    assert.strictEqual(asked, null);

    dispatch.tryAutoConnect('midi', { autoConnect: true, device: 'Knob Box' });
    assert.strictEqual(asked, 'in-1');
});

t('only a device already granted is claimed', () => {
    reset();
    let asked = null;
    midi.devices = () => [{ id: 'in-1', name: 'Knob Box' }];
    midi.connect = (id) => { asked = id; return true; };

    // No remembered name: nothing was ever granted, so nothing is claimed.
    dispatch.tryAutoConnect('midi', { autoConnect: true, device: '' });
    assert.strictEqual(asked, null);

    // Remembered, but not plugged in.
    dispatch.tryAutoConnect('midi', { autoConnect: true, device: 'Other Box' });
    assert.strictEqual(asked, null);
});

t('a Disconnect outranks the switch until asked again', () => {
    reset();
    let asked = null;
    midi.devices = () => [{ id: 'in-1', name: 'Knob Box' }];
    midi.connect = (id) => { asked = id; return true; };
    const conf = { autoConnect: true, device: 'Knob Box' };

    // Held in the module, not the panel: closing the panel must not forget that
    // the operator deliberately disconnected, or the next hotplug undoes it.
    dispatch.setManualOff('midi', true);
    dispatch.tryAutoConnect('midi', conf);
    assert.strictEqual(asked, null, 'a hotplug undid a deliberate Disconnect');

    dispatch.setManualOff('midi', false);
    dispatch.tryAutoConnect('midi', conf);
    assert.strictEqual(asked, 'in-1');
});

t('an already connected surface is not connected again', () => {
    reset();
    let calls = 0;
    midi.devices = () => [{ id: 'in-1', name: 'Knob Box' }];
    midi.connect = () => { calls++; return true; };
    midi.connected = true;

    dispatch.tryAutoConnect('midi', { autoConnect: true, device: 'Knob Box' });
    assert.strictEqual(calls, 0);
});

t('no surface, no attempt', () => {
    reset();
    dispatch.tryAutoConnect('off', { autoConnect: true });
    dispatch.tryAutoConnect('', { autoConnect: true });
    dispatch.tryAutoConnect('midi', null);
});

console.log(`\n${pass} ok`);
