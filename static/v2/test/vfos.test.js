// The four VFOs.
//
// The switch is the whole feature: leaving a VFO must store what was live on
// it, and arriving at one must hand back exactly what was stored — including
// the spectrum zoom, which is the part with no visible clue that it was lost.

const assert = require('assert');
const { VFO_IDS, cleanSlot, storeInto, switchTo, vfoSnapshot } = require('./.build/vfos.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const tuning = (frequency, mode = 'usb') => ({
    frequency, mode, bandwidthLow: 50, bandwidthHigh: 2800,
});
const view = (binBandwidth) => ({ binBandwidth, binCount: 1024 });
const empty = () => ({ active: 'A', slots: Object.fromEntries(VFO_IDS.map((id) => [id, null])) });

t('a snapshot carries the passband and the zoom, not just the dial', () => {
    const s = vfoSnapshot(tuning(7.1e6, 'lsb'), view(20));
    assert.deepStrictEqual(s, {
        frequency: 7.1e6,
        mode: 'lsb',
        bandwidthLow: 50,
        bandwidthHigh: 2800,
        binBandwidth: 20,
    });
});

t('a snapshot taken before the spectrum connected has no zoom rather than zero', () => {
    assert.strictEqual(vfoSnapshot(tuning(7.1e6), view(0)).binBandwidth, null);
    assert.strictEqual(vfoSnapshot(tuning(7.1e6), null).binBandwidth, null);
});

t('leaving a VFO stores what was live on it', () => {
    const { state } = switchTo(empty(), 'B', vfoSnapshot(tuning(14.2e6), view(10)));
    assert.strictEqual(state.active, 'B');
    assert.strictEqual(state.slots.A.frequency, 14.2e6);
    assert.strictEqual(state.slots.A.binBandwidth, 10);
});

t('an unused VFO starts as a copy, so nothing is recalled', () => {
    const { state, recall } = switchTo(empty(), 'C', vfoSnapshot(tuning(14.2e6), view(10)));
    assert.strictEqual(recall, null, 'the receiver is already where the copy says');
    assert.strictEqual(state.slots.C.frequency, 14.2e6);
});

t('coming back to a VFO hands back everything it held', () => {
    // A: 14.2 USB zoomed to 10 Hz/bin. Move to B, retune, come back.
    let s = switchTo(empty(), 'B', vfoSnapshot(tuning(14.2e6, 'usb'), view(10))).state;
    const back = switchTo(s, 'A', vfoSnapshot(tuning(3.7e6, 'lsb'), view(200)));
    assert.deepStrictEqual(back.recall, {
        frequency: 14.2e6,
        mode: 'usb',
        bandwidthLow: 50,
        bandwidthHigh: 2800,
        binBandwidth: 10,
    });
    // ...and B kept where it was left, rather than being overwritten by A.
    assert.strictEqual(back.state.slots.B.frequency, 3.7e6);
    assert.strictEqual(back.state.slots.B.binBandwidth, 200);
});

t('storing into a VFO fills it without going there', () => {
    const before = empty();
    const after = storeInto(before, 'C', vfoSnapshot(tuning(21.2e6), view(50)));
    assert.strictEqual(after.active, 'A', 'storing must not switch');
    assert.strictEqual(after.slots.C.frequency, 21.2e6);
    assert.strictEqual(after.slots.C.binBandwidth, 50);
    // ...and nothing else is touched.
    assert.strictEqual(after.slots.A, null);
    assert.strictEqual(after.slots.B, null);
});

t('storing over an occupied VFO replaces what was there', () => {
    let s = storeInto(empty(), 'B', vfoSnapshot(tuning(7.1e6), view(20)));
    s = storeInto(s, 'B', vfoSnapshot(tuning(3.7e6), view(100)));
    assert.strictEqual(s.slots.B.frequency, 3.7e6);
});

t('storing into the VFO in use is refused, not written', () => {
    // That slot is the live receiver by definition; writing it would imply the
    // two could differ.
    const before = empty();
    assert.strictEqual(storeInto(before, 'A', vfoSnapshot(tuning(7e6), view(20))), before);
    assert.strictEqual(storeInto(before, 'Z', vfoSnapshot(tuning(7e6), view(20))), before);
});

t('pressing the VFO you are already on changes nothing', () => {
    const before = empty();
    const { state, recall } = switchTo(before, 'A', vfoSnapshot(tuning(14.2e6), view(10)));
    assert.strictEqual(state, before, 'the same object, so no store and no save');
    assert.strictEqual(recall, null);
});

t('an unknown slot is refused rather than creating a fifth VFO', () => {
    const before = empty();
    const { state } = switchTo(before, 'E', vfoSnapshot(tuning(14.2e6), view(10)));
    assert.strictEqual(state, before);
});

t('a stored slot missing its frequency or mode is dropped, not half-applied', () => {
    assert.strictEqual(cleanSlot(null), null);
    assert.strictEqual(cleanSlot({ mode: 'usb', bandwidthLow: 0, bandwidthHigh: 1 }), null);
    assert.strictEqual(cleanSlot({ frequency: 7e6, bandwidthLow: 0, bandwidthHigh: 1 }), null);
    assert.strictEqual(cleanSlot({ frequency: 7e6, mode: 'usb' }), null);
});

t('a zero or missing stored zoom reads as "no zoom", so recall leaves it alone', () => {
    const s = cleanSlot({ frequency: 7e6, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 2800, binBandwidth: 0 });
    assert.strictEqual(s.binBandwidth, null);
    // A passband low of 0 is legitimate (AM straddles zero) and must survive.
    assert.strictEqual(s.bandwidthLow, 0);
});

console.log(`\n${pass} VFO checks passed`);
