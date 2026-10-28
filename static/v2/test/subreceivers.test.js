// The engine that plays VFOs alongside the main receiver — radio/subReceivers.js.
//
// Everything outside it is faked: the sockets (so what each was asked to do can
// be read back), the clock and timers (so the stagger is measured rather than
// waited out), and the main player's AudioContext (so the voices can be seen
// joining its sub bus). The VFO store is the real one, because the engine's
// whole job is to make the streams match it.

const assert = require('assert');

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const {
    SubReceivers, STAGGER_MS, getVfos, listenOf, selectVfo, setListen, setVfoListen, setVfos,
    tuneListening,
} = require('./.build/subreceivers.cjs');

// --- fakes -------------------------------------------------------------------

class FakeConn {
    constructor(vfo) {
        this.vfo = vfo;
        this.state = 'idle';
        this.ws = null;
        this.opening = false;
        this.params = null;
        this.lastGate = undefined;
        this.format = null;
        this.connects = [];
        this.sent = [];
        this.disconnects = 0;
        this.handlers = {};
    }

    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return () => {}; }

    emit(ev, p) { for (const fn of this.handlers[ev] || []) fn(p); }

    setFormat(f) { this.format = f; }

    _state(s) { this.state = s; this.emit('state', s); }

    connect(params) {
        this.params = { ...params };
        this.connects.push({
            params: { ...params },
            gate: this.lastGate ? this.lastGate.minSnr : null,
            format: this.format,
        });
        this.ws = {};
        this._state('connecting');
        return Promise.resolve(true);
    }

    open() { this._state('open'); this.emit('open'); }

    send(msg) {
        if (this.state !== 'open') return false;
        this.sent.push(msg);
        return true;
    }

    tune(p) {
        if (this.params) Object.assign(this.params, p);
        return this.send({ type: 'tune', ...p });
    }

    setMuted(muted) { return this.send({ type: 'set_mute', muted }); }

    setAudioGate({ minSnr }) {
        this.lastGate = { minSnr };
        return this.send({ type: 'set_audio_gate', min_snr: minSnr });
    }

    disconnect() {
        this.disconnects++;
        this.ws = null;
        this._state('idle');
    }
}

function fakeTimers() {
    let now = 1000;
    let seq = 1;
    const pending = new Map();
    return {
        now: () => now,
        timers: {
            set(fn, ms) { const id = seq++; pending.set(id, { fn, at: now + ms }); return id; },
            clear(id) { pending.delete(id); },
        },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, t] of pending) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
                if (!next) break;
                pending.delete(next[0]);
                now = next[1].at;
                next[1].fn();
            }
            now = end;
        },
    };
}

function fakePlayer() {
    const node = (kind) => ({
        kind,
        out: new Set(),
        gain: { value: 1, setTargetAtTime(v) { this.value = v; } },
        pan: { value: 0, setTargetAtTime(v) { this.value = v; } },
        connect(to) { this.out.add(to); return to; },
        disconnect() { this.out.clear(); },
    });
    const started = [];
    const ctx = {
        currentTime: 5,
        state: 'running',
        createGain: () => node('gain'),
        createStereoPanner: () => node('panner'),
        createBuffer: (ch, n, rate) => ({ ch, n, rate, copyToChannel() {} }),
        createBufferSource() {
            const src = node('source');
            src.start = (when) => started.push({ src, when });
            return src;
        },
    };
    const handlers = {};
    return {
        ctx,
        started,
        subOutput: node('subbus'),
        pans: [],
        bufferSec: 0.2,
        leadInSec: () => 0.12,
        setPan(p) { this.pans.push(p); },
        on(ev, fn) { (handlers[ev] ||= []).push(fn); return () => {}; },
        emit(ev, p) { for (const fn of handlers[ev] || []) fn(p); },
    };
}

class FakeDecoder {
    constructor(opts) { this.opts = opts; this.ready = Promise.resolve(); FakeDecoder.made++; }

    decodeFrame() {
        return Promise.resolve({ channelData: [new Float32Array(960)], samplesDecoded: 960, sampleRate: 48000 });
    }

    free() {}
}

FakeDecoder.made = 0;

const slot = (frequency, mode = 'usb', lo = 50, hi = 2700) => ({
    frequency, mode, bandwidthLow: lo, bandwidthHigh: hi, binBandwidth: null,
});
const LSB = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };

// A rig: the engine, its fakes, and a store with `listening` VFOs on.
function rig({ limit = 4, listening = ['B', 'C', 'D'] } = {}) {
    let state = {
        active: 'A',
        slots: { A: slot(7100000, 'lsb'), B: slot(14074000), C: slot(10136000, 'cw', -250, 250), D: slot(3573000) },
    };
    for (const id of listening) state = setListen(state, id, true, { limit: 4 });
    setVfos(state);
    const clock = fakeTimers();
    const conns = [];
    const player = fakePlayer();
    let lim = limit;
    const limitHandlers = [];
    const subs = new SubReceivers(player, {
        makeConnection: (vfo) => { const c = new FakeConn(vfo); conns.push(c); return c; },
        decoderClass: () => FakeDecoder,
        limit: { get: () => lim, on: (fn) => { limitHandlers.push(fn); return () => {}; } },
        now: clock.now,
        timers: clock.timers,
    });
    const setLimit = (n) => { lim = n; limitHandlers.forEach((fn) => fn(n)); };
    return { subs, clock, conns, player, setLimit, byVfo: (i) => conns.find((c) => c.vfo === i) };
}

// Running, the main socket open, and every secondary connected and open.
function up(r, extra = {}) {
    r.subs.update({ running: true, open: true, tuning: LSB, threshold: null, ...extra });
    r.clock.advance(STAGGER_MS * 4);
    for (const c of r.conns) if (c.state === 'connecting') c.open();
}

const on = (id) => listenOf(getVfos(), id).on;

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const rigs = [];
const track = (r) => { rigs.push(r); return r; };

// --- the byte counter the stats read -----------------------------------------

t('bytesIn sums every lane and keeps counting after a VFO stops', () => {
    const r = track(rig({ listening: ['B', 'C'] }));
    up(r);
    assert.strictEqual(r.subs.openCount(), 2);
    const [b, c] = [r.byVfo(1), r.byVfo(2)];
    b.bytesIn = 1000;
    c.bytesIn = 500;
    assert.strictEqual(r.subs.bytesIn(), 1500);
    // A VFO stopping closes its socket but keeps its lane — and its counter — so
    // the total never goes backwards, which a reader taking deltas relies on.
    r.subs.setListening('C', false);
    assert.strictEqual(r.subs.openCount(), 1);
    assert.strictEqual(r.subs.bytesIn(), 1500);
    b.bytesIn = 1800;
    assert.strictEqual(r.subs.bytesIn(), 2300);
});

// --- connecting --------------------------------------------------------------

t('nothing connects until the main socket is open', () => {
    const r = track(rig());
    r.subs.update({ running: true, open: false, tuning: LSB });
    r.clock.advance(5000);
    assert.ok(r.conns.every((c) => c.connects.length === 0));
});

t('secondaries connect one at a time, a stagger apart, after the main one', () => {
    const r = track(rig());
    r.subs.update({ running: true, open: true, tuning: LSB });
    const count = () => r.conns.reduce((n, c) => n + c.connects.length, 0);
    assert.strictEqual(count(), 0, 'not in the same moment as the main socket');
    r.clock.advance(STAGGER_MS - 1);
    assert.strictEqual(count(), 0);
    r.clock.advance(1);
    assert.strictEqual(count(), 1);
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(count(), 2);
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(count(), 3);
    assert.deepStrictEqual(r.conns.map((c) => c.vfo), [1, 2, 3]);
    assert.ok(r.conns.every((c) => c.format === 'opus'));
});

t('each plays at its own frequency in the main receiver\'s mode', () => {
    const r = track(rig());
    up(r);
    const p = r.byVfo(2).connects[0].params;   // C, saved as CW
    assert.deepStrictEqual(p, { frequency: 10136000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 });
    assert.strictEqual(getVfos().slots.C.mode, 'cw', 'its saved mode is left in the store');
});

t('the server limit caps how many connect, and the rest are marked', () => {
    const r = track(rig({ limit: 2 }));
    up(r);
    assert.strictEqual(r.conns.length, 1);
    const snap = r.subs.snapshot();
    assert.strictEqual(snap.vfos.B.index, 1);
    assert.strictEqual(snap.vfos.C.overLimit, true);
    assert.match(snap.vfos.C.refused, /allows 2 VFOs/);
});

t('at a limit of one stored flags are inert: nothing connects and nothing is refused', () => {
    const r = track(rig({ limit: 1 }));
    up(r);
    assert.strictEqual(r.conns.length, 0);
    assert.deepStrictEqual(r.subs.snapshot().vfos, {}, 'not shown as over the limit either');
    assert.strictEqual(on('B'), true, 'the flags are kept for when the limit arrives');
    r.setLimit(4);
    r.clock.advance(STAGGER_MS * 4);
    assert.strictEqual(r.conns.length, 3);
});

// --- the mode lock -----------------------------------------------------------

t('a mode or filter change on the main receiver retunes every secondary', () => {
    const r = track(rig());
    up(r);
    r.conns.forEach((c) => { c.sent = []; });
    r.subs.update({ tuning: { frequency: 7100000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2800 } });
    for (const c of r.conns) {
        const tune = c.sent.find((m) => m.type === 'tune');
        assert.ok(tune, `vfo ${c.vfo} retuned`);
        assert.strictEqual(tune.mode, 'usb');
        assert.strictEqual(tune.bandwidthHigh, 2800);
        assert.strictEqual(tune.frequency, c.params.frequency);
    }
    assert.strictEqual(r.byVfo(1).sent.find((m) => m.type === 'tune').frequency, 14074000);
});

t('the main receiver moving frequency does not retune anybody', () => {
    const r = track(rig());
    up(r);
    r.conns.forEach((c) => { c.sent = []; });
    r.subs.update({ tuning: { ...LSB, frequency: 7150000 } });
    assert.ok(r.conns.every((c) => !c.sent.some((m) => m.type === 'tune')));
});

t('retuning a listening VFO tunes its stream, with the locked mode', () => {
    const r = track(rig());
    up(r);
    r.conns.forEach((c) => { c.sent = []; });
    r.subs.tuneVfo('B', 14075000);
    const tune = r.byVfo(1).sent.find((m) => m.type === 'tune');
    assert.deepStrictEqual(tune, { type: 'tune', frequency: 14075000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 });
    assert.strictEqual(getVfos().slots.B.mode, 'usb');
});

// The tune throttle runs on the real clock, so each step waits out its window.
const pastThrottle = () => new Promise((res) => setTimeout(res, 90));

t('a VFO given its own filter is retuned with it, and the others keep main\'s', async () => {
    const r = track(rig());
    up(r);
    r.conns.forEach((c) => { c.sent = []; });
    // Main is in LSB; B is given 1.8 kHz on that sideband.
    assert.ok(r.subs.setFilter('B', [-1850, -50]));
    const tune = r.byVfo(1).sent.find((m) => m.type === 'tune');
    assert.deepStrictEqual(tune, { type: 'tune', frequency: 14074000, mode: 'lsb', bandwidthLow: -1850, bandwidthHigh: -50 });
    for (const i of [2, 3]) assert.ok(!r.byVfo(i).sent.some((m) => m.type === 'tune'), `vfo ${i} untouched`);
    // Main's filter moving leaves B's own alone and carries the others.
    r.conns.forEach((c) => { c.sent = []; });
    await pastThrottle();
    r.subs.update({ tuning: { ...LSB, bandwidthLow: -3000 } });
    assert.ok(!r.byVfo(1).sent.some((m) => m.type === 'tune'), 'B keeps its own');
    assert.strictEqual(r.byVfo(2).sent.find((m) => m.type === 'tune').bandwidthLow, -3000);
    // Upper sideband: the same width, mirrored.
    r.conns.forEach((c) => { c.sent = []; });
    await pastThrottle();
    r.subs.update({ tuning: { ...LSB, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 } });
    const usb = r.byVfo(1).sent.find((m) => m.type === 'tune');
    assert.deepStrictEqual([usb.bandwidthLow, usb.bandwidthHigh], [50, 1850]);
    // And back on main's.
    r.conns.forEach((c) => { c.sent = []; });
    await pastThrottle();
    assert.ok(r.subs.setFilter('B', null));
    await pastThrottle();
    const back = r.byVfo(1).sent.filter((m) => m.type === 'tune').pop();
    assert.deepStrictEqual([back.bandwidthLow, back.bandwidthHigh], [50, 2700]);
});

t('a VFO given its own squelch is gated by it, and the others follow main', async () => {
    const r = track(rig());
    up(r, { threshold: 6 });
    r.conns.forEach((c) => { c.sent = []; });
    assert.ok(r.subs.setSquelch('B', 15));
    assert.deepStrictEqual(r.byVfo(1).sent, [{ type: 'set_audio_gate', min_snr: 15 }]);
    for (const i of [2, 3]) assert.deepStrictEqual(r.byVfo(i).sent, [], `vfo ${i} untouched`);
    assert.strictEqual(r.subs.snapshot().vfos.B.threshold, 15);
    assert.strictEqual(r.subs.snapshot().vfos.B.squelchOwn, true);
    // Main's moving carries the others and leaves B's own alone.
    await pastThrottle();
    r.conns.forEach((c) => { c.sent = []; });
    r.subs.update({ threshold: 9 });
    assert.deepStrictEqual(r.byVfo(1).sent, []);
    assert.deepStrictEqual(r.byVfo(2).sent, [{ type: 'set_audio_gate', min_snr: 9 }]);
    // Its own off, with main's on: the sentinel, and held open.
    await pastThrottle();
    r.conns.forEach((c) => { c.sent = []; });
    r.subs.setSquelch('B', 'off');
    assert.deepStrictEqual(r.byVfo(1).sent, [{ type: 'set_audio_gate', min_snr: -999 }]);
    const lane = Array.from(r.subs.lanes.values()).find((l) => l.slotId === 'B');
    r.subs._onQuality(lane, { basebandPower: -50, noisePower: 0 });
    assert.strictEqual(r.subs.snapshot().vfos.B.squelchOpen, true);
});

t('a VFO\'s own squelch rides its connect URL', () => {
    const r = track(rig({ listening: ['B'] }));
    const v = getVfos();
    setVfos({ ...v, listen: { ...v.listen, B: { ...v.listen.B, sq: 20 } } });
    up(r, { threshold: 6 });
    assert.strictEqual(r.byVfo(1).lastGate.minSnr, 20);
});

// --- IQ ----------------------------------------------------------------------
//
// IQ ends listening: the streams close, handing their radiod channels back, and
// the flags are cleared so the VFOs are ordinary memories again.

const IQ = { frequency: 7100000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 };

t('entering IQ closes every secondary and clears the listening flags', () => {
    const r = track(rig());
    up(r);
    r.subs.update({ tuning: IQ });
    for (const c of r.conns) {
        assert.strictEqual(c.state, 'idle', `vfo ${c.vfo}`);
        assert.strictEqual(c.disconnects, 1, `vfo ${c.vfo}`);
    }
    assert.deepStrictEqual(['B', 'C', 'D'].map(on), [false, false, false]);
    // Each is left as an ordinary memory: last frequency, own mode and filter.
    assert.deepStrictEqual(getVfos().slots.C, slot(10136000, 'cw', -250, 250));
    const snap = r.subs.snapshot();
    assert.deepStrictEqual(snap.vfos, {});
    assert.strictEqual(snap.listenBlocked, 'Not available while main is in IQ');
    assert.strictEqual(r.player.pans[r.player.pans.length - 1], null, 'the I/Q picker has the sides back');
});

t('listening is refused while the main receiver is in IQ', () => {
    const r = track(rig({ listening: [] }));
    r.subs.update({ running: true, open: true, tuning: IQ });
    r.subs.setRadio({ tuning: IQ, view: null, actions: {} });
    assert.strictEqual(r.subs.listenBlocked, 'Not available while main is in IQ');
    assert.strictEqual(r.subs.setListening('B', true), false);
    // Even with a radio facade that has not caught up with the mode.
    r.subs.setRadio({ tuning: LSB, view: null, actions: {} });
    assert.strictEqual(r.subs.setListening('B', true), false);
    assert.strictEqual(on('B'), false);
    r.clock.advance(5000);
    assert.strictEqual(r.conns.length, 0);
    r.subs.update({ tuning: LSB });
    assert.strictEqual(r.subs.listenBlocked, null);
    assert.ok(r.subs.setListening('B', true), 'allowed again out of IQ');
});

t('leaving IQ brings nothing back', () => {
    const r = track(rig());
    up(r);
    r.subs.update({ tuning: IQ });
    r.subs.update({ tuning: LSB });
    r.subs.update({ open: false });
    r.subs.update({ open: true });
    r.clock.advance(5000);
    assert.ok(r.conns.every((c) => c.connects.length === 1), 'no second connect');
    assert.deepStrictEqual(['B', 'C', 'D'].map(on), [false, false, false]);
    assert.deepStrictEqual(r.subs.snapshot().vfos, {});
});

t('flags restored into IQ are cleared before anything connects', () => {
    const r = track(rig());
    r.subs.update({ running: true, open: true, tuning: IQ });
    r.clock.advance(5000);
    assert.strictEqual(r.conns.length, 0);
    assert.deepStrictEqual(['B', 'C', 'D'].map(on), [false, false, false]);
    r.subs.update({ tuning: LSB });
    r.clock.advance(5000);
    assert.strictEqual(r.conns.length, 0);
});

// --- the main format -----------------------------------------------------------

t('secondaries connect in the main socket\'s format', () => {
    const r = track(rig());
    up(r, { format: 'pcm-zstd' });
    assert.strictEqual(r.conns.length, 3);
    assert.ok(r.conns.every((c) => c.connects.length === 1 && c.connects[0].format === 'pcm-zstd'));
    assert.strictEqual(r.subs.snapshot().format, 'pcm-zstd');
});

t('a format change reconnects every listening secondary in it, staggered behind main', () => {
    const r = track(rig());
    up(r);
    assert.ok(r.conns.every((c) => c.connects[0].format === 'opus'));
    // RadioContext's applyFormat: the format and the main socket closing
    // arrive in one render.
    r.subs.update({ format: 'pcm-zstd', open: false });
    assert.ok(r.conns.every((c) => c.disconnects === 1 && c.state === 'idle'));
    r.clock.advance(5000);
    const count = () => r.conns.reduce((n, c) => n + c.connects.length, 0);
    assert.strictEqual(count(), 3, 'nothing while the main socket is down');
    r.subs.update({ open: true });
    r.clock.advance(STAGGER_MS - 1);
    assert.strictEqual(count(), 3, 'not in the same moment as the main socket');
    r.clock.advance(1);
    assert.strictEqual(count(), 4);
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(count(), 5);
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(count(), 6);
    for (const c of r.conns) {
        assert.strictEqual(c.connects[1].format, 'pcm-zstd', `vfo ${c.vfo}`);
        assert.deepStrictEqual(c.connects[1].params, c.connects[0].params, `vfo ${c.vfo} where it was`);
    }
    // And back.
    for (const c of r.conns) c.open();
    r.subs.update({ format: 'opus', open: false });
    r.subs.update({ open: true });
    r.clock.advance(STAGGER_MS * 4);
    assert.ok(r.conns.every((c) => c.connects.length === 3 && c.connects[2].format === 'opus'));
});

t('a format change seen while the main socket is still open requeues them itself', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    const c = r.byVfo(1);
    r.subs.update({ format: 'pcm-zstd' });
    assert.strictEqual(c.disconnects, 1);
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(c.connects.length, 2);
    assert.strictEqual(c.connects[1].format, 'pcm-zstd');
});

t('a format change with the receiver off is kept for the next connect', () => {
    const r = track(rig({ listening: ['B'] }));
    r.subs.update({ format: 'pcm-zstd' });
    up(r);
    assert.strictEqual(r.byVfo(1).connects[0].format, 'pcm-zstd');
});

// --- squelch -----------------------------------------------------------------

t('the shared squelch rides the connect, and follows the slider after', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r, { threshold: 10 });
    const c = r.byVfo(1);
    assert.strictEqual(c.connects[0].gate, 10, 'min_snr on the connect URL');
    c.sent = [];
    r.subs.update({ threshold: 15 });
    assert.deepStrictEqual(c.sent, [{ type: 'set_audio_gate', min_snr: 15 }]);
});

t('turning the squelch off sends the disabled sentinel', async () => {
    const r = track(rig({ listening: ['B'] }));
    up(r, { threshold: 10 });
    await new Promise((res) => setTimeout(res, 120));   // past the gate throttle
    const c = r.byVfo(1);
    c.sent = [];
    r.subs.update({ threshold: null });
    assert.deepStrictEqual(c.sent, [{ type: 'set_audio_gate', min_snr: -999 }]);
});

t('each VFO\'s squelch state follows the shared function, hang included', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r, { threshold: 10 });
    const c = r.byVfo(1);
    c.emit('quality', { basebandPower: -20, noisePower: -40 });
    let s = r.subs.snapshot().vfos.B;
    assert.strictEqual(s.snr, 20);
    assert.strictEqual(s.squelchOpen, true);
    r.clock.advance(100);
    c.emit('quality', { basebandPower: -38, noisePower: -40 });
    assert.strictEqual(r.subs.snapshot().vfos.B.squelchOpen, true, 'inside the hang');
    r.clock.advance(500);
    c.emit('quality', { basebandPower: -38, noisePower: -40 });
    s = r.subs.snapshot().vfos.B;
    assert.strictEqual(s.squelchOpen, false);
});

// --- errors ------------------------------------------------------------------

t('a VFO the server has no room for is dropped, marked and announced once', () => {
    const r = track(rig({ listening: ['B'] }));
    const refused = [];
    r.subs.on('refused', (e) => refused.push(e));
    up(r);
    const c = r.byVfo(1);
    c.emit('error', { kind: 'server', failure: 'retry', message: 'This receiver allows 1 VFOs' });
    assert.strictEqual(c.disconnects, 1);
    assert.deepStrictEqual(refused, [{ id: 'B', message: 'This receiver allows 1 VFOs' }]);
    assert.strictEqual(r.subs.snapshot().vfos.B.refused, 'This receiver allows 1 VFOs');
    // The main socket coming back is no reason to try again.
    r.subs.update({ open: false });
    r.subs.update({ open: true });
    r.clock.advance(STAGGER_MS * 4);
    assert.strictEqual(c.connects.length, 1);
});

t('"no primary" waits for the main socket and then tries again', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    const c = r.byVfo(1);
    r.subs.update({ open: false });
    c.emit('error', { kind: 'server', message: 'No primary audio session for this user; connect the main VFO first' });
    assert.strictEqual(c.disconnects, 1);
    assert.strictEqual(r.subs.snapshot().vfos.B.waitingPrimary, true);
    r.clock.advance(5000);
    assert.strictEqual(c.connects.length, 1, 'nothing while the main socket is down');
    r.subs.update({ open: true });
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(c.connects.length, 2);
});

t('any other error is the row\'s, and the connection\'s own backoff handles it', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    const c = r.byVfo(1);
    c.emit('error', { kind: 'socket', message: 'audio socket error' });
    assert.strictEqual(c.disconnects, 0);
    assert.strictEqual(r.subs.snapshot().vfos.B.error, 'audio socket error');
});

// --- the receiver going away -------------------------------------------------

t('switching the receiver off drops every secondary', () => {
    const r = track(rig());
    up(r);
    r.subs.update({ running: false, open: false });
    assert.ok(r.conns.every((c) => c.state === 'idle' && c.disconnects >= 1));
    assert.deepStrictEqual(r.subs.snapshot().vfos, {});
    assert.strictEqual(r.player.pans[r.player.pans.length - 1], null);
});

t('a VFO that stops listening closes its stream; the lane is reused', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    r.subs.setListening('B', false);
    assert.strictEqual(r.byVfo(1).disconnects, 1);
    r.subs.setRadio({ tuning: LSB, view: null, actions: {} });
    assert.ok(r.subs.setListening('C', true));
    r.clock.advance(STAGGER_MS);
    assert.strictEqual(r.conns.length, 1, 'one connection per index, ever');
    assert.strictEqual(r.byVfo(1).connects[1].params.frequency, 10136000);
});

// --- swapping ----------------------------------------------------------------

t('swapping the main receiver with a listening VFO hands the stream over', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    const c = r.byVfo(1);
    c.sent = [];
    const tuned = [];
    const radio = {
        tuning: { ...LSB, frequency: 7123000 },
        view: null,
        actions: { tuneTo: (x) => tuned.push(x) },
    };
    assert.ok(selectVfo(radio, 'B', { limit: 2 }));
    assert.deepStrictEqual(tuned, [{ frequency: 14074000 }]);
    assert.strictEqual(c.disconnects, 0, 'not closed and reopened');
    assert.strictEqual(r.conns.length, 1);
    const tune = c.sent.find((m) => m.type === 'tune');
    assert.strictEqual(tune.frequency, 7123000, 'the stream now plays the old main frequency');
    assert.ok(r.subs.snapshot().vfos.A, 'and is A\'s');
});

// --- audio and placement -----------------------------------------------------

t('two VFOs are placed left and right by frequency, main included', () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    assert.strictEqual(r.player.pans[r.player.pans.length - 1], -1, 'main, 7.1 MHz, on the left');
    assert.strictEqual(r.subs.snapshot().vfos.B.pan, 1);
    setVfoListen('A', { out: 'right' });
    assert.strictEqual(r.player.pans[r.player.pans.length - 1], 1, 'a pin moves the main receiver');
    assert.strictEqual(r.subs.snapshot().vfos.B.pan, -1);
});

t('decoded audio is scheduled through a voice into the player\'s sub bus', async () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    r.byVfo(1).emit('opus', { data: new Uint8Array(10), sampleRate: 48000, channels: 1 });
    await settle();
    assert.strictEqual(r.player.started.length, 1);
    const { src, when } = r.player.started[0];
    assert.deepStrictEqual([src.buffer.ch, src.buffer.n, src.buffer.rate], [1, 960, 48000], 'the decoder\'s output');
    assert.ok(Math.abs(when - (5 + 0.12)) < 1e-9, 'led in by the main player\'s own cushion');
    const gain = [...src.out][0];
    const panner = [...gain.out][0];
    assert.strictEqual(panner.kind, 'panner');
    assert.ok(panner.out.has(r.player.subOutput));
    assert.strictEqual(panner.pan.value, 1);
    r.subs.setMuted('B', true);
    assert.strictEqual(gain.gain.value, 0, 'its own mute');
    r.subs.setMuted('B', false);
    r.subs.setVolume('B', 0.25);
    assert.strictEqual(gain.gain.value, 0.25);
    r.subs.update({ held: true });
    assert.strictEqual(gain.gain.value, 0, 'silent while a recording plays back');
});

t('lossless frames are scheduled as they arrive, with no decoder', async () => {
    const r = track(rig({ listening: ['B'] }));
    up(r, { format: 'pcm-zstd' });
    const made = FakeDecoder.made;
    const plane = new Float32Array(480);
    r.byVfo(1).emit('pcm', { planes: [plane], sampleRate: 12000, channels: 1 });
    r.byVfo(1).emit('pcm', { planes: [plane], sampleRate: 12000, channels: 1 });
    await settle();
    assert.strictEqual(FakeDecoder.made, made, 'no Opus decoder made');
    assert.strictEqual(r.player.started.length, 2);
    const [a, b] = r.player.started;
    assert.deepStrictEqual([a.src.buffer.ch, a.src.buffer.n, a.src.buffer.rate], [1, 480, 12000]);
    assert.ok(Math.abs(a.when - (5 + 0.12)) < 1e-9);
    assert.ok(Math.abs(b.when - (a.when + 480 / 12000)) < 1e-9, 'back to back');
    const panner = [...[...a.src.out][0].out][0];
    assert.ok(panner.out.has(r.player.subOutput));
});

t('a rebuilt context gets new voices', async () => {
    const r = track(rig({ listening: ['B'] }));
    up(r);
    r.byVfo(1).emit('opus', { data: new Uint8Array(10), sampleRate: 48000, channels: 1 });
    await settle();
    const before = [...r.player.started[0].src.out][0];
    const old = r.player.ctx;
    r.player.ctx = { ...old, currentTime: 0 };
    r.player.emit('context', 2);
    r.byVfo(1).emit('opus', { data: new Uint8Array(10), sampleRate: 48000, channels: 1 });
    await settle();
    const after = [...r.player.started[1].src.out][0];
    assert.notStrictEqual(after, before);
});

(async () => {
    for (const [name, fn] of queue) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.stack));
            process.exitCode = 1;
        }
        // Each rig subscribes to the one store; the next test must not drive
        // the last one's engine.
        while (rigs.length) rigs.pop().subs.dispose();
    }
    if (!process.exitCode) console.log(`\n${pass} passed`);
    process.exit(process.exitCode || 0);
})();
