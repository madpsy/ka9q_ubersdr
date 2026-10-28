// Listening to VFOs alongside the main receiver: the store's half.
//
// The rules that matter are the ones that write to a VFO without the operator
// switching to it — a listening VFO is live, and a careless write there loses
// its saved mode for good. And the swap: picking a VFO that is already being
// heard trades it with the main receiver rather than recalling it, so what was
// being heard on it does not change mode on the way to the front.

const assert = require('assert');

// A localStorage the load can be pointed at. Installed before the bundle is
// required, since the store reads it lazily but saveVfos writes it on set.
const disk = new Map();
global.localStorage = {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
};

const {
    LISTEN_IQ_REASON, VFO_IDS, cleanListen, clearListening, filterFamily, getVfos, isListening,
    listenBlockedReason, listenEdges, listenOf, listenThreshold, listenVfo, listeningVfos, loadVfos,
    seedListen, setVfoFilter, setVfoSquelch, withListenFilter, withListenSquelch,
    nextScanVfo, patchListen, retuneListening, scannableVfos, selectVfo, setListen, setVfoListen,
    setVfos, switchTo, tuneListening, vfoSnapshot,
} = require('./.build/vfos.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const slot = (frequency, mode = 'usb', lo = 50, hi = 2700) => ({
    frequency, mode, bandwidthLow: lo, bandwidthHigh: hi, binBandwidth: null,
});
const tuning = (frequency, mode = 'usb', lo = 50, hi = 2700) => ({
    frequency, mode, bandwidthLow: lo, bandwidthHigh: hi,
});

function fakeRadio(t0) {
    const calls = [];
    return {
        calls,
        tuning: t0,
        view: { binBandwidth: 0, binCount: 0 },
        actions: {
            tuneTo: (x) => calls.push(['tuneTo', x]),
            setSpectrumView: (...a) => calls.push(['setSpectrumView', ...a]),
            resetSpectrum: () => calls.push(['resetSpectrum']),
        },
    };
}

const base = () => ({
    active: 'A',
    slots: { A: slot(7100000, 'lsb', -2700, -50), B: slot(14074000, 'usb'), C: slot(10136000, 'cw', -250, 250), D: null },
});

// --- the limit ---------------------------------------------------------------

t('a limit of one means nothing can listen', () => {
    const s = base();
    assert.strictEqual(setListen(s, 'B', true, { limit: 1 }), s);
});

t('at most limit - 1 VFOs listen beside the main one', () => {
    let s = setListen(base(), 'B', true, { limit: 2 });
    assert.ok(isListening(s, 'B', 4));
    const refused = setListen(s, 'C', true, { limit: 2 });
    assert.strictEqual(refused, s, 'the second one is refused, not swapped in');
    s = setListen(s, 'C', true, { limit: 3 });
    assert.deepStrictEqual(listeningVfos(s, 4).map((v) => v.id), ['B', 'C']);
});

t('the active VFO never listens — it is the main receiver', () => {
    const s = base();
    assert.strictEqual(setListen(s, 'A', true, { limit: 4 }), s);
});

t('listening to an unused VFO seeds it from live', () => {
    const live = vfoSnapshot(tuning(7155000, 'lsb', -2700, -50), null);
    const s = setListen(base(), 'D', true, { limit: 4, live });
    assert.ok(isListening(s, 'D', 4));
    assert.strictEqual(s.slots.D.frequency, 7155000);
    assert.strictEqual(s.slots.D.mode, 'lsb');
    // ...and an unused one with nothing to seed it from is refused.
    const none = base();
    assert.strictEqual(setListen(none, 'D', true, { limit: 4 }), none);
});

t('stopping listening keeps the slot as it was', () => {
    let s = setListen(base(), 'C', true, { limit: 4 });
    s = setListen(s, 'C', false, { limit: 4 });
    assert.ok(!isListening(s, 'C', 4));
    assert.strictEqual(s.slots.C.mode, 'cw');
});

// --- a listening VFO is live, but only its frequency -----------------------

t('retuning a listening VFO writes its frequency and nothing else', () => {
    let s = setListen(base(), 'C', true, { limit: 4 });
    s = retuneListening(s, 'C', 10140000);
    assert.strictEqual(s.slots.C.frequency, 10140000);
    assert.strictEqual(s.slots.C.mode, 'cw', 'its own saved mode survives listening');
    assert.strictEqual(s.slots.C.bandwidthLow, -250);
});

t('tuneListening goes through the store and leaves the saved mode', () => {
    setVfos(setListen(base(), 'B', true, { limit: 4 }));
    let heard = null;
    assert.ok(tuneListening('B', 14075500, 4));
    heard = getVfos();
    assert.strictEqual(heard.slots.B.frequency, 14075500);
    assert.strictEqual(heard.slots.B.mode, 'usb');
    assert.ok(!tuneListening('C', 10000000, 4), 'a parked VFO is not tuned this way');
    assert.ok(!tuneListening('B', 14076000, 1), 'nor a stale flag at a limit of one');
});

t('how a VFO is heard is kept apart from whether it is', () => {
    let s = patchListen(base(), 'B', { out: 'left', vol: 0.4, muted: true });
    assert.deepStrictEqual(listenOf(s, 'B'), { on: false, out: 'left', vol: 0.4, muted: true });
    s = patchListen(s, 'B', { out: 'sideways', vol: 7 });
    assert.strictEqual(listenOf(s, 'B').out, 'auto', 'an unknown output falls back to auto');
    assert.strictEqual(listenOf(s, 'B').vol, 1, 'volume is clamped');
    assert.strictEqual(patchListen(s, 'B', { on: true }).listen.B.on, false, 'patch cannot start listening');
});

// --- switching ---------------------------------------------------------------

t('selecting a listening VFO swaps the roles and keeps the mode', () => {
    let s = setListen(base(), 'C', true, { limit: 4 });
    s = patchListen(s, 'C', { out: 'right', vol: 0.5 });
    setVfos(s);
    // Main is on A in LSB, tuned away from what A stored.
    const radio = fakeRadio(tuning(7123000, 'lsb', -2700, -50));
    assert.ok(selectVfo(radio, 'C', { limit: 4 }));
    const after = getVfos();
    assert.strictEqual(after.active, 'C');
    assert.ok(isListening(after, 'A', 4), 'the old main receiver is now heard alongside');
    assert.strictEqual(after.slots.A.frequency, 7123000, 'where it was left, not where it was stored');
    assert.strictEqual(listenOf(after, 'A').out, 'right', 'the listen settings travel with the role');
    assert.strictEqual(listenOf(after, 'A').vol, 0.5);
    assert.strictEqual(listenOf(after, 'C').on, false);
    // The tune carries the frequency only: tuneTo keeps the mode in force.
    assert.deepStrictEqual(radio.calls, [['tuneTo', { frequency: 10136000 }]]);
});

t('selecting a parked VFO recalls its own mode as before', () => {
    let s = setListen(base(), 'C', true, { limit: 4 });
    setVfos(s);
    const radio = fakeRadio(tuning(7100000, 'lsb', -2700, -50));
    assert.ok(selectVfo(radio, 'B'));
    const tune = radio.calls.find((c) => c[0] === 'tuneTo')[1];
    assert.strictEqual(tune.mode, 'usb');
    const after = getVfos();
    assert.ok(isListening(after, 'C', 4), 'a switch elsewhere leaves the listeners listening');
    assert.ok(!isListening(after, 'A', 4), 'and the VFO left behind is parked, not heard');
});

t('at a limit of one a VFO still marked listening is recalled, not swapped', () => {
    // The flags outlive the limit (it reads 1 until /connection answers), so
    // a slot can be marked listening with nothing playing it.
    setVfos(setListen(base(), 'C', true, { limit: 4 }));
    const radio = fakeRadio(tuning(7123000, 'lsb', -2700, -50));
    assert.ok(selectVfo(radio, 'C', { limit: 1 }));
    const tune = radio.calls.find((c) => c[0] === 'tuneTo')[1];
    assert.strictEqual(tune.mode, 'cw', 'its own saved mode, as for any parked VFO');
    assert.strictEqual(getVfos().active, 'C');
    assert.strictEqual(listenOf(getVfos(), 'A').on, false, 'the old main receiver is parked, not heard');
});

t('switchTo keeps the listen entries', () => {
    const s = setListen(base(), 'C', true, { limit: 4 });
    const { state } = switchTo(s, 'B', vfoSnapshot(tuning(7100000, 'lsb'), null));
    assert.ok(state.listen && state.listen.C.on);
});

t('listenVfo seeds from the radio and honours the limit', () => {
    setVfos(base());
    const radio = fakeRadio(tuning(3700000, 'lsb', -2700, -50));
    assert.ok(listenVfo(radio, 'D', true, 2));
    assert.strictEqual(getVfos().slots.D.frequency, 3700000);
    assert.ok(!listenVfo(radio, 'B', true, 2), 'past the limit');
    assert.ok(setVfoListen('D', { muted: true }));
    assert.strictEqual(listenOf(getVfos(), 'D').muted, true);
});

// --- scanning ----------------------------------------------------------------

t('a scan skips VFOs that are being listened to', () => {
    const s = setListen(base(), 'B', true, { limit: 4 });
    assert.deepStrictEqual(scannableVfos(s, tuning(7100000), 4), ['A', 'C']);
    assert.strictEqual(nextScanVfo(scannableVfos(s, tuning(7100000), 4), 'A'), 'C');
});

// --- a limit of one ------------------------------------------------------------
//
// The flags are kept whatever the limit (it reads 1 until /connection answers),
// so every question about who is listening now has to treat them as inert at 1.

t('at a limit of one a stored flag listens nowhere', () => {
    const s = setListen(base(), 'B', true, { limit: 4 });
    assert.strictEqual(s.listen.B.on, true, 'the flag itself is kept');
    assert.ok(!isListening(s, 'B', 1));
    assert.deepStrictEqual(listeningVfos(s, 1), []);
    // The session's limit is the default, and it is 1 here.
    assert.ok(!isListening(s, 'B'));
    assert.deepStrictEqual(listeningVfos(s), []);
});

t('at a limit of one a scan visits a VFO still marked listening', () => {
    const s = setListen(base(), 'B', true, { limit: 4 });
    assert.deepStrictEqual(scannableVfos(s, tuning(7100000), 1), ['A', 'B', 'C']);
    assert.deepStrictEqual(scannableVfos(s, tuning(7100000)), ['A', 'B', 'C'], 'by default too');
    assert.strictEqual(nextScanVfo(scannableVfos(s, tuning(7100000), 1), 'A'), 'B');
});

// --- IQ ------------------------------------------------------------------------

t('listening cannot start while the main receiver is in IQ', () => {
    const s = base();
    assert.strictEqual(listenBlockedReason('iq'), 'Not available while main is in IQ');
    assert.strictEqual(listenBlockedReason('iq96'), LISTEN_IQ_REASON);
    assert.strictEqual(listenBlockedReason('usb'), null);
    assert.strictEqual(setListen(s, 'B', true, { limit: 4, mainMode: 'iq48' }), s);
    const live = vfoSnapshot(tuning(7100000, 'iq', -6000, 6000), null);
    assert.strictEqual(setListen(s, 'B', true, { limit: 4, live }), s, 'the mode comes from live');
    // Stopping is always allowed.
    const on = setListen(s, 'B', true, { limit: 4 });
    assert.strictEqual(setListen(on, 'B', false, { limit: 4, mainMode: 'iq' }).listen.B.on, false);

    setVfos(base());
    assert.ok(!listenVfo(fakeRadio(tuning(7100000, 'iq', -6000, 6000)), 'B', true, 4));
    assert.strictEqual(listenOf(getVfos(), 'B').on, false);
});

t('clearListening turns every flag off and keeps the rest', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    s = setListen(s, 'C', true, { limit: 4 });
    s = patchListen(s, 'C', { out: 'left', vol: 0.3 });
    const after = clearListening(s);
    assert.deepStrictEqual(listeningVfos(after, 4), []);
    assert.deepStrictEqual(after.slots, s.slots, 'last frequency and own mode kept');
    assert.deepStrictEqual(listenOf(after, 'C'), { on: false, out: 'left', vol: 0.3, muted: false });
    assert.strictEqual(clearListening(after), after, 'nothing to clear is no change');
});

t('selecting a VFO still marked listening while in IQ recalls it', () => {
    setVfos(setListen(base(), 'C', true, { limit: 4 }));
    const radio = fakeRadio(tuning(7100000, 'iq', -6000, 6000));
    assert.ok(selectVfo(radio, 'C', { limit: 4 }));
    assert.strictEqual(radio.calls.find((c) => c[0] === 'tuneTo')[1].mode, 'cw', 'not swapped');
    assert.strictEqual(listenOf(getVfos(), 'A').on, false);
});

// --- loading -----------------------------------------------------------------

t('a store saved before listening existed loads with nothing listening', () => {
    disk.set('ubersdr.v2.vfos', JSON.stringify({ active: 'B', slots: base().slots }));
    const s = loadVfos();
    assert.strictEqual(s.active, 'B');
    assert.strictEqual(s.slots.C.mode, 'cw');
    for (const id of VFO_IDS) assert.deepStrictEqual(listenOf(s, id), { on: false, out: 'auto', vol: 1, muted: false });
});

t('a saved listening set comes back, but never on the active or an empty slot', () => {
    disk.set('ubersdr.v2.vfos', JSON.stringify({
        active: 'A',
        slots: base().slots,
        listen: {
            A: { on: true, out: 'left' },
            B: { on: true, out: 'right', vol: 0.3 },
            D: { on: true },
        },
    }));
    const s = loadVfos();
    assert.strictEqual(s.listen.A.on, false);
    assert.strictEqual(s.listen.A.out, 'left', 'the main receiver keeps its placement');
    assert.deepStrictEqual(s.listen.B, { on: true, out: 'right', vol: 0.3, muted: false });
    assert.strictEqual(s.listen.D.on, false);
});

t('a lazy write reaches listeners at once and the disk later', () => {
    disk.clear();
    setVfos(setListen(base(), 'B', true, { limit: 4 }));
    const saved = disk.get('ubersdr.v2.vfos');
    let heard = 0;
    tuneListening('B', 14080000, 4);
    heard = getVfos().slots.B.frequency;
    assert.strictEqual(heard, 14080000);
    assert.strictEqual(disk.get('ubersdr.v2.vfos'), saved, 'not written yet');
    // An ordinary write saves everything, the deferred change included.
    setVfoListen('B', { vol: 0.9 });
    assert.strictEqual(JSON.parse(disk.get('ubersdr.v2.vfos')).slots.B.frequency, 14080000);
});

// --- a listening VFO's own filter -------------------------------------------

t('until seeded a listening VFO plays with main\'s filter, as a stand-in', () => {
    const e = listenEdges(cleanListen({ on: true }), tuning(7100000, 'usb', 50, 2700));
    assert.deepStrictEqual(e, { low: 50, high: 2700, own: false });
    assert.ok(!('bw' in cleanListen({ on: true })), 'no filter is no field at all');
});

t('seeding copies main\'s filter and squelch once; after that main moving moves neither', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    const main = tuning(14200000, 'usb', 50, 2700);
    s = seedListen(s, 'B', main, 6);
    assert.deepStrictEqual(listenOf(s, 'B').bw, { ssb: [50, 2700] });
    assert.strictEqual(listenOf(s, 'B').sq, 6);
    assert.strictEqual(seedListen(s, 'B', main, 6), s, 'nothing left to fill in');
    // Main's filter and squelch move: B's stay where they were.
    const moved = tuning(14200000, 'usb', 50, 1800);
    assert.strictEqual(seedListen(s, 'B', moved, 12), s);
    assert.deepStrictEqual(listenEdges(listenOf(s, 'B'), moved), { low: 50, high: 2700, own: true });
    assert.deepStrictEqual(listenThreshold(listenOf(s, 'B'), 12), { threshold: 6, own: true });
    // Main's squelch off is copied as off.
    const off = seedListen(setListen(base(), 'C', true, { limit: 4 }), 'C', main, null);
    assert.strictEqual(listenOf(off, 'C').sq, 'off');
});

t('a mode family met for the first time starts from main\'s filter as it is then', () => {
    let s = seedListen(setListen(base(), 'B', true, { limit: 4 }), 'B', tuning(1, 'usb', 50, 1800), 6);
    s = seedListen(s, 'B', tuning(1, 'am', -4000, 4000), 6);
    assert.deepStrictEqual(listenOf(s, 'B').bw, { ssb: [50, 1800], am: [-4000, 4000] });
    // Back in SSB it is its own again, untouched by AM.
    assert.deepStrictEqual(listenEdges(listenOf(s, 'B'), tuning(1, 'usb', 50, 2700)), { low: 50, high: 1800, own: true });
});

t('its own filter is kept per mode family, SSB mirrored for LSB', () => {
    const usb = tuning(14074000, 'usb', 50, 2700);
    const l = withListenFilter(cleanListen({ on: true }), usb, [100, 1900]);
    assert.deepStrictEqual(l.bw, { ssb: [100, 1900] });
    assert.deepStrictEqual(listenEdges(l, usb), { low: 100, high: 1900, own: true });
    // The same width on the other sideband.
    assert.deepStrictEqual(listenEdges(l, tuning(7100000, 'lsb', -2700, -50)), { low: -1900, high: -100, own: true });
    // A different family follows main.
    assert.deepStrictEqual(listenEdges(l, tuning(9500000, 'am', -5000, 5000)), { low: -5000, high: 5000, own: false });
    assert.strictEqual(filterFamily('sam'), 'am');
    assert.strictEqual(filterFamily('iq'), null);
});

t('setting main\'s edges keeps them its own; null copies main\'s as it stands', () => {
    const usb = tuning(14074000, 'usb', 50, 2700);
    const own = withListenFilter(cleanListen({ on: true }), usb, [100, 1900]);
    const same = withListenFilter(own, usb, [50, 2700]);
    assert.deepStrictEqual(same.bw, { ssb: [50, 2700] });
    assert.strictEqual(listenEdges(same, usb).own, false, 'the same as main\'s, so nothing to match');
    assert.deepStrictEqual(withListenFilter(own, tuning(1, 'usb', 50, 2400), null).bw, { ssb: [50, 2400] });
    // Only its own family is touched.
    const both = withListenFilter(own, tuning(9500000, 'am', -5000, 5000), [-3000, 3000]);
    assert.deepStrictEqual(withListenFilter(both, usb, null).bw, { ssb: [50, 2700], am: [-3000, 3000] });
});

t('a stored filter that is malformed or too narrow is not used', () => {
    assert.ok(!('bw' in cleanListen({ bw: { ssb: [2000, 100], cw: 'x', zz: [1, 2] } })));
    const narrow = cleanListen({ bw: { ssb: [5990, 6100] } });
    // Clamped into USB's 0..6000 it would be 10 Hz wide: main's instead.
    assert.strictEqual(listenEdges(narrow, tuning(1, 'usb', 50, 2700)).own, false);
});

t('setVfoFilter writes the listen entry and never the active VFO', () => {
    setVfos(setListen(base(), 'B', true, { limit: 4 }));
    const usb = tuning(14074000, 'usb', 50, 2700);
    assert.ok(setVfoFilter('B', usb, [50, 1800]));
    assert.deepStrictEqual(listenOf(getVfos(), 'B').bw, { ssb: [50, 1800] });
    assert.strictEqual(getVfos().slots.B.bandwidthHigh, 2700, 'the slot\'s own filter is left alone');
    assert.ok(!setVfoFilter('B', usb, [50, 1800]), 'the same again changes nothing');
    assert.ok(!setVfoFilter('A', usb, [50, 1800]), 'not the main receiver');
    assert.ok(!setVfoFilter('B', tuning(1, 'iq', -6000, 6000), [-100, 100]), 'nothing in IQ');
    assert.ok(setVfoFilter('B', usb, null), 'matching main\'s');
    assert.deepStrictEqual(listenOf(getVfos(), 'B').bw, { ssb: [50, 2700] });
});

t('a swap takes each filter with its station', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    const main = tuning(14200000, 'usb', 50, 2700);
    s = { ...s, listen: { ...s.listen, B: withListenFilter(listenOf(s, 'B'), main, [50, 1800]) } };
    setVfos(s);
    const radio = fakeRadio(main);
    assert.ok(selectVfo(radio, 'B', { limit: 4 }));
    // B comes to the front still 1.8 kHz wide...
    assert.deepStrictEqual(radio.calls, [['tuneTo', { frequency: 14074000, bandwidthLow: 50, bandwidthHigh: 1800 }]]);
    // ...and A carries on in the 2.65 kHz it had as main, against B's 1.8.
    const after = getVfos();
    const promoted = tuning(14074000, 'usb', 50, 1800);
    assert.deepStrictEqual(listenEdges(listenOf(after, 'A'), promoted), { low: 50, high: 2700, own: true });
    assert.ok(!('bw' in listenOf(after, 'B')), 'the main one keeps no filter of its own');
});

t('a swap where the filters match tunes the frequency only', () => {
    setVfos(setListen(base(), 'B', true, { limit: 4 }));
    const radio = fakeRadio(tuning(14200000, 'usb', 50, 2700));
    assert.ok(selectVfo(radio, 'B', { limit: 4 }));
    assert.deepStrictEqual(radio.calls, [['tuneTo', { frequency: 14074000 }]]);
    assert.deepStrictEqual(listenOf(getVfos(), 'A').bw, { ssb: [50, 2700] }, 'A keeps a copy of its own');
});

// --- a listening VFO's own squelch ------------------------------------------

t('a listening VFO\'s squelch is its own, and may be off while main\'s is on', () => {
    const l = cleanListen({ on: true });
    assert.ok(!('sq' in l));
    assert.deepStrictEqual(listenThreshold(l, 6), { threshold: 6, own: false }, 'main\'s stands in until seeded');
    const own = withListenSquelch(l, 6, 12);
    assert.deepStrictEqual(listenThreshold(own, 6), { threshold: 12, own: true });
    assert.deepStrictEqual(listenThreshold(own, null), { threshold: 12, own: true }, 'on with main\'s off');
    assert.deepStrictEqual(listenThreshold(withListenSquelch(l, 6, 6), 6), { threshold: 6, own: false });
    // The slider's floor is off.
    const off = withListenSquelch(l, 6, -10);
    assert.strictEqual(off.sq, 'off');
    assert.deepStrictEqual(listenThreshold(off, 6), { threshold: null, own: true });
});

t('a squelch set to main\'s stays put when main\'s moves; null copies main\'s now', () => {
    const same = withListenSquelch(cleanListen({}), 6, 6);
    assert.strictEqual(same.sq, 6);
    assert.deepStrictEqual(listenThreshold(same, 9), { threshold: 6, own: true });
    assert.strictEqual(withListenSquelch(same, 9, null).sq, 9);
    assert.strictEqual(withListenSquelch(same, null, null).sq, 'off');
});

t('a stored squelch survives a reload only if it is one the slider could set', () => {
    assert.strictEqual(cleanListen({ sq: 60 }).sq, 46, 'clamped to the top');
    assert.strictEqual(cleanListen({ sq: 'off' }).sq, 'off');
    assert.ok(!('sq' in cleanListen({ sq: 'loud' })));
});

t('setVfoSquelch writes the listen entry and never the active VFO', () => {
    setVfos(setListen(base(), 'B', true, { limit: 4 }));
    assert.ok(setVfoSquelch('B', 6, 10));
    assert.strictEqual(listenOf(getVfos(), 'B').sq, 10);
    assert.ok(!setVfoSquelch('B', 6, 10), 'the same again changes nothing');
    assert.ok(!setVfoSquelch('A', 6, 10), 'not the main receiver');
    assert.ok(setVfoSquelch('B', 6, null), 'matching main\'s');
    assert.strictEqual(listenOf(getVfos(), 'B').sq, 6);
});

t('a swap hands the squelch over with the roles', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    s = { ...s, listen: { ...s.listen, B: withListenSquelch(listenOf(s, 'B'), 6, 12) } };
    setVfos(s);
    const radio = fakeRadio(tuning(14200000, 'usb', 50, 2700));
    radio.squelch = { value: 6, enabled: true, threshold: 6 };
    radio.actions.setSquelch = (x) => radio.calls.push(['setSquelch', x]);
    assert.ok(selectVfo(radio, 'B', { limit: 4 }));
    // B comes to the front at its 12 dB; A carries on at the 6 it had.
    assert.deepStrictEqual(radio.calls.find((c) => c[0] === 'setSquelch'), ['setSquelch', 12]);
    const after = getVfos();
    assert.deepStrictEqual(listenThreshold(listenOf(after, 'A'), 12), { threshold: 6, own: true });
    assert.ok(!('sq' in listenOf(after, 'B')));
});

t('a swap from a VFO with its squelch off turns main\'s off', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    s = { ...s, listen: { ...s.listen, B: withListenSquelch(listenOf(s, 'B'), 6, 'off') } };
    setVfos(s);
    const radio = fakeRadio(tuning(14200000, 'usb', 50, 2700));
    radio.squelch = { value: 6, enabled: true, threshold: 6 };
    radio.actions.setSquelch = (x) => radio.calls.push(['setSquelch', x]);
    assert.ok(selectVfo(radio, 'B', { limit: 4 }));
    assert.deepStrictEqual(radio.calls.find((c) => c[0] === 'setSquelch'), ['setSquelch', -10]);
    assert.strictEqual(listenOf(getVfos(), 'A').sq, 6);
});

t('a swap where the squelches match leaves main\'s alone', () => {
    let s = setListen(base(), 'B', true, { limit: 4 });
    s = { ...s, listen: { ...s.listen, B: withListenSquelch(listenOf(s, 'B'), 6, 6) } };
    setVfos(s);
    const radio = fakeRadio(tuning(14200000, 'usb', 50, 2700));
    radio.squelch = { value: 6, enabled: true, threshold: 6 };
    radio.actions.setSquelch = (x) => radio.calls.push(['setSquelch', x]);
    assert.ok(selectVfo(radio, 'B', { limit: 4 }));
    assert.ok(!radio.calls.some((c) => c[0] === 'setSquelch'));
    assert.strictEqual(listenOf(getVfos(), 'A').sq, 6, 'A keeps a copy of its own');
});

if (!process.exitCode) console.log(`\n${pass} passed`);
