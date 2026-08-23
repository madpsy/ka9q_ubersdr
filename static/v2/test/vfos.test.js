// The four VFOs.
//
// The switch is the whole feature: leaving a VFO must store what was live on
// it, and arriving at one must hand back exactly what was stored — including
// the spectrum zoom, which is the part with no visible clue that it was lost.

const assert = require('assert');
const {
    VFO_IDS, cleanSlot, copyVfo, getVfos, markableVfos, selectVfo, setVfos, storeInto, switchTo,
    vfoSnapshot,
} = require('./.build/vfos.cjs');

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

// --- recalling the view ------------------------------------------------------

// A radio the recall can be driven against, recording what it was asked to do.
function fakeRadio(view, tuning) {
    const calls = [];
    return {
        calls,
        tuning,
        view,
        actions: {
            tuneTo: (t2) => calls.push(['tuneTo', t2]),
            setSpectrumView: (c, span) => calls.push(['setSpectrumView', c, span]),
            setSpan: (span) => calls.push(['setSpan', span]),
            resetSpectrum: () => calls.push(['resetSpectrum']),
        },
    };
}

const slot = (frequency, binBandwidth) => ({
    frequency, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700, binBandwidth,
});

t('recalling a VFO sets where the view is and how wide, together', () => {
    // The reported case: full span, and a VFO stored at 14.182 MHz zoomed to
    // 100 Hz/bin. Setting the span on its own closed a 205 kHz window around
    // the old 15 MHz centre and left the dial 800 kHz outside it — frequency
    // right, marker gone.
    setVfos({ active: 'B', slots: { A: null, B: null, C: slot(14182000, 100), D: null } });
    const radio = fakeRadio(
        { centerFreq: 15000000, span: 30000000, binCount: 2048, binBandwidth: 14648.4375, defaultBinBandwidth: 14648.4375 },
        { frequency: 10169000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 },
    );

    selectVfo(radio, 'C');

    const names = radio.calls.map((c) => c[0]);
    assert.ok(names.includes('tuneTo'), 'the dial moves');
    assert.ok(!names.includes('setSpan'), 'the span is never set without a centre');

    const view = radio.calls.find((c) => c[0] === 'setSpectrumView');
    assert.ok(view, 'the view is restored');
    const [, centre, span] = view;
    assert.strictEqual(centre, 14182000);
    assert.strictEqual(span, 100 * 2048);
    // ...and the dial ends up inside it, which is the whole point.
    assert.ok(Math.abs(14182000 - centre) <= span / 2, 'dial is inside the recalled view');
});

t('a VFO stored at full span resets rather than centring', () => {
    // Full span contains the dial wherever it is, and reset also hands the
    // private radiod channel back.
    setVfos({ active: 'A', slots: { A: null, B: slot(7100000, 14648.4375), C: null, D: null } });
    const radio = fakeRadio(
        { centerFreq: 14100000, span: 204800, binCount: 2048, binBandwidth: 100, defaultBinBandwidth: 14648.4375 },
        { frequency: 14100000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    );
    selectVfo(radio, 'B');
    const names = radio.calls.map((c) => c[0]);
    assert.ok(names.includes('resetSpectrum'), 'full span goes through reset');
    assert.ok(!names.includes('setSpectrumView'), 'and needs no centre');
});

t('a VFO with no stored zoom leaves the view alone', () => {
    // Saved before the spectrum ever connected. The tune still happens, and the
    // auto-recentre is correct there because the span has not changed under it.
    setVfos({ active: 'A', slots: { A: null, B: slot(7100000, null), C: null, D: null } });
    const radio = fakeRadio(
        { centerFreq: 14100000, span: 204800, binCount: 2048, binBandwidth: 100, defaultBinBandwidth: 14648.4375 },
        { frequency: 14100000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    );
    selectVfo(radio, 'B');
    assert.deepStrictEqual(radio.calls.map((c) => c[0]), ['tuneTo']);
});


// ── Which VFOs get a marker ──────────────────────────────────────────────────
//
// The marker bar draws the parked ones. Two exclusions, and both are about not
// drawing a mark that says nothing: the VFO you are on is the dial, and a VFO
// on the frequency you are already on would sit under the dial line.

// `slot` above is the recall tests' two-argument one; markers care about the
// frequency and the mode, so this one names them.
const parkedAt = (frequency, mode = 'usb') => ({
    frequency, mode, bandwidthLow: 50, bandwidthHigh: 2800, binBandwidth: null,
});

t('the parked VFOs are marked', () => {
    const state = { active: 'A', slots: { A: parkedAt(7.1e6), B: parkedAt(7.074e6), C: parkedAt(14.2e6), D: null } };
    const ids = markableVfos(state, 7.1e6).map((v) => v.id);
    assert.deepStrictEqual(ids, ['B', 'C']);
});

t('the VFO you are on never gets one', () => {
    // It is the dial. The spectrum draws that already, and a second mark on it
    // would be a mark you cannot go to.
    const state = { active: 'C', slots: { A: parkedAt(7.1e6), B: parkedAt(7.2e6), C: parkedAt(14.2e6), D: null } };
    assert.ok(!markableVfos(state, 14.2e6).some((v) => v.id === 'C'));
    // ...even when the dial has been moved off the slot's stored frequency,
    // which is the normal state of affairs: the active slot is only written
    // when you switch away from it.
    assert.ok(!markableVfos(state, 14.25e6).some((v) => v.id === 'C'));
});

t('a VFO parked where you already are gets no mark either', () => {
    const state = { active: 'A', slots: { A: parkedAt(7.1e6), B: parkedAt(7.1e6), C: parkedAt(7.2e6), D: null } };
    const ids = markableVfos(state, 7.1e6).map((v) => v.id);
    assert.deepStrictEqual(ids, ['C'], 'B is under the dial line');
    // Move off it and B is somewhere to go again.
    assert.deepStrictEqual(markableVfos(state, 7.15e6).map((v) => v.id), ['B', 'C']);
});

t('an empty or unusable slot is not a place', () => {
    const state = { active: 'A', slots: { A: parkedAt(7.1e6), B: null, C: { frequency: 0 }, D: undefined } };
    assert.deepStrictEqual(markableVfos(state, 7.1e6), []);
    assert.deepStrictEqual(markableVfos(null, 7.1e6), []);
    assert.deepStrictEqual(markableVfos({}, 7.1e6), []);
});

t('a marker carries what it needs to be a tooltip', () => {
    const state = { active: 'A', slots: { A: parkedAt(7.1e6), B: parkedAt(14.074e6, 'usb'), C: null, D: null } };
    const [b] = markableVfos(state, 7.1e6);
    assert.strictEqual(b.id, 'B');
    assert.strictEqual(b.frequency, 14.074e6);
    assert.strictEqual(b.mode, 'usb');
});

t('no dial frequency yet is not a reason to hide them', () => {
    // Before the receiver is running there is nothing to compare against, and
    // the marks are still where the VFOs are.
    const state = { active: 'A', slots: { A: parkedAt(7.1e6), B: parkedAt(7.2e6), C: null, D: null } };
    assert.deepStrictEqual(markableVfos(state, null).map((v) => v.id), ['B']);
    assert.deepStrictEqual(markableVfos(state, undefined).map((v) => v.id), ['B']);
});

// --- copying into a VFO you are not on ---------------------------------------
//
// The direction is the whole risk. "Copy A to B" writes the live receiver into
// B; getting it backwards would overwrite the VFO the operator is sitting on
// with a stale one, and they would not find out until they switched.

t('copying sends the live settings into the target and stays put', () => {
    setVfos({ active: 'A', slots: { A: null, B: null, C: null, D: null } });
    const radio = fakeRadio(
        { centerFreq: 14100000, span: 204800, binCount: 2048, binBandwidth: 100 },
        { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    );

    assert.strictEqual(copyVfo(radio, 'C'), true);

    const after = getVfos();
    assert.strictEqual(after.active, 'A', 'copying must not switch');
    assert.strictEqual(after.slots.C.frequency, 14074000, 'C did not take the live frequency');
    assert.strictEqual(after.slots.C.mode, 'usb');
    // The dial is untouched: this sends settings somewhere, it does not go there.
    assert.deepStrictEqual(radio.calls, []);
});

t('copying onto the VFO in use is refused, not written', () => {
    // That slot *is* the live receiver; writing it would imply otherwise, and a
    // stored copy of the active VFO is the one value guaranteed to go stale.
    setVfos({ active: 'B', slots: { A: null, B: null, C: null, D: null } });
    const radio = fakeRadio(
        { centerFreq: 14100000, span: 204800, binCount: 2048, binBandwidth: 100 },
        { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    );
    assert.strictEqual(copyVfo(radio, 'B'), false);
    assert.strictEqual(getVfos().slots.B, null, 'the active slot was written');
});

t('copying overwrites what was there, without touching the rest', () => {
    setVfos({
        active: 'A',
        slots: { A: null, B: slot(7100000, 200), C: slot(3573000, 200), D: null },
    });
    const radio = fakeRadio(
        { centerFreq: 14100000, span: 204800, binCount: 2048, binBandwidth: 100 },
        { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
    );

    copyVfo(radio, 'B');

    const after = getVfos();
    assert.strictEqual(after.slots.B.frequency, 14074000, 'B was not overwritten');
    assert.strictEqual(after.slots.C.frequency, 3573000, 'C was disturbed');
    assert.strictEqual(after.slots.D, null);
});

console.log(`\n${pass} VFO checks passed`);
