// The Clock block, its time source, and the time interval counter.

const assert = require('assert');
const {
    ClockBlock, chooseTime, clockText, timeParts, parseNmea, IntervalCounterBlock, TimeSource,
    PulseClassifierBlock, parseClasses, classify, PULSE_PRESETS,
    createWorkerCore, BLOCK_BY_TYPE, makeBuffer, sanitizeParams, GRAPH_VERSION, compile, parseGraph,
} = require('./.build/playgroundclock.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// 2023-11-14 22:13:20 UTC — a whole second, so offsets from it are easy to read.
const T = 1700000000000;

// A packet's `time`, as timeSource.packetTime builds it.
const timeOf = (over = {}) => ({
    ntp: null, receiver: null, device: { t0: T, err: null }, capture: null, hostToUtc: null,
    hostSynced: false, ntpOffered: false, ntpFailed: false, ...over,
});

const clockParams = (over = {}) => sanitizeParams(ClockBlock, over);

// ── choosing a clock ────────────────────────────────────────────────────────

t('the best clock there is: the NTP add-on, then the receiver\'s, then this device\'s', () => {
    const p = clockParams({ align: 'page' });
    const all = timeOf({ ntp: { t0: T + 1, err: 2 }, receiver: { t0: T + 5, err: 9 }, ntpOffered: true });
    assert.deepStrictEqual([chooseTime(all, p).src, chooseTime(all, p).t0, chooseTime(all, p).err], ['ntp', T + 1, 2]);
    assert.strictEqual(chooseTime(timeOf({ receiver: { t0: T, err: 9 } }), p).src, 'receiver');
    const dev = chooseTime(timeOf(), p);
    assert.strictEqual(dev.src, 'device');
    assert.strictEqual(dev.err, null);
    // Best-there-is never apologises for what it found.
    assert.strictEqual(dev.note, '');
});

t('asked for the NTP add-on on a receiver without one, it falls back, and says so', () => {
    const p = clockParams({ source: 'ntp', align: 'page' });
    const c = chooseTime(timeOf({ receiver: { t0: T, err: 9 } }), p);
    assert.strictEqual(c.src, 'receiver');
    assert.match(c.note, /No NTP add-on on this receiver — using the receiver’s clock/);
    const later = chooseTime(timeOf({ ntpOffered: true }), p);
    assert.strictEqual(later.src, 'device');
    assert.match(later.note, /not answering yet — using this device’s clock/);
});

t('aligned to the signal, the capture stamps — corrected to the add-on\'s time where both are measured', () => {
    const p = clockParams();
    const corrected = chooseTime(timeOf({ capture: T, hostToUtc: { off: -3, err: 4 }, ntpOffered: true }), p);
    assert.deepStrictEqual([corrected.t0, corrected.err, corrected.src, corrected.signal], [T - 3, 4, 'ntp', true]);
    const raw = chooseTime(timeOf({ capture: T, hostSynced: true }), p);
    assert.deepStrictEqual([raw.t0, raw.src, raw.signal], [T, 'receiver', true]);
    assert.match(raw.label, /synchronised, at the signal/);
    assert.match(chooseTime(timeOf({ capture: T }), clockParams({ source: 'ntp' })).note, /No NTP add-on/);
    // No stamps — a graph without the receiver — and it follows the page, saying so.
    assert.match(chooseTime(timeOf(), clockParams({ source: 'receiver' })).note, /follows the page/);
    // This device’s clock has nothing to do with the stamps.
    assert.strictEqual(chooseTime(timeOf({ capture: T }), clockParams({ source: 'device' })).signal, false);
});

t('the time in words, each way it can be written', () => {
    assert.deepStrictEqual(timeParts(T, 'utc'), { y: 2023, mo: 11, d: 14, h: 22, m: 13, s: 20, offMin: 0 });
    assert.strictEqual(clockText(T, 'hms', 'utc'), '22:13:20 UTC');
    assert.strictEqual(clockText(T, 'iso', 'utc'), '2023-11-14T22:13:20Z');
    assert.strictEqual(clockText(T, 'hhmmz', 'utc'), '2213Z');
    assert.strictEqual(clockText(T - 20000, 'spoken', 'utc'), 'It is 22:13 UTC');
    assert.strictEqual(clockText(T + 1000, 'spoken', 'utc'), 'It is 22:13 and 21 seconds UTC');
});

// ── the block ───────────────────────────────────────────────────────────────

/** A Clock at `rate`, fed `time` before each packet of `n`. */
function clock(params = {}, rate = 1000) {
    const inst = ClockBlock.create();
    inst.configure(clockParams(params), rate);
    const step = (time, n) => {
        if (time) inst.feed({ time });
        const outs = ClockBlock.outputs.map((p) => makeBuffer(p.kind, n));
        inst.process([], outs, n);
        return outs;
    };
    return { inst, step };
}

t('a pulse on every second, as long as it is set, where the second falls in the signal', () => {
    // The packet starts 300 ms before the second.
    const c = clock({ ppsWidthMs: 100 });
    const outs = c.step(timeOf({ capture: T - 300 }), 1000);
    const pps = outs[0].re;
    assert.strictEqual(pps[299], 0);
    assert.strictEqual(pps[300], 1, 'no pulse on the second');
    assert.strictEqual(pps[399], 1);
    assert.strictEqual(pps[400], 0, 'the pulse was not 100 ms');
    assert.strictEqual(outs[6].value, T / 1000, 'unix seconds');
    assert.strictEqual(outs[7].value, 20);
    assert.strictEqual(outs[8].value, 13);
    assert.strictEqual(outs[9].value, 22);
});

t('pulses can be every so many seconds, offset; the pips are longer on the minute', () => {
    const c = clock({ ppsEvery: 10, ppsOffsetMs: 50, ppsWidthMs: 10 });
    // 20:00 is on a ten-second boundary; begin 100 ms before it.
    const pps = c.step(timeOf({ capture: T - 100 }), 400)[0].re;
    assert.strictEqual(pps[149], 0);
    assert.strictEqual(pps[150], 1, 'not offset by 50 ms');
    assert.strictEqual(pps[160], 0);
    const m = clock({ pipMs: 100, minutePipMs: 500 });
    const top = T - 20000; // 22:13:00
    const pips = m.step(timeOf({ capture: top }), 1000)[1].re;
    assert.ok(pips.slice(100, 500).some((v) => v !== 0), 'the minute pip was short');
    assert.ok(pips.slice(510, 1000).every((v) => v === 0));
});

t('the tone\'s phase is set by the time itself: the same at a time however it was reached', () => {
    const a = clock({ toneHz: 1000.25 }, 8000);
    const b = clock({ toneHz: 1000.25 }, 8000);
    // A from 10 ms earlier, over two packets; B straight in at the second.
    a.step(timeOf({ capture: T - 10 }), 80);
    const fromA = a.step(timeOf({ capture: T }), 80)[2].re;
    const fromB = b.step(timeOf({ capture: T }), 80)[2].re;
    for (let k = 0; k < 80; k++) assert.ok(Math.abs(fromA[k] - fromB[k]) < 1e-6, `differs at ${k}`);
    const car = b.step(timeOf({ capture: T + 10 }), 4)[3];
    assert.ok(Math.abs(Math.hypot(car.re[0], car.im[0]) - 1) < 1e-9);
});

t('the window is open for its length every period, and its control says when it changes', () => {
    const c = clock({ windowEvery: 2, windowFrom: 0, windowLength: 0.5 });
    // 22:13:20 is an even second: open for its first 500 ms.
    const outs = c.step(timeOf({ capture: T }), 1000);
    assert.strictEqual(outs[4].re[499], 1);
    assert.strictEqual(outs[4].re[500], 0);
    assert.strictEqual(outs[10].value, 0);
});

t('the time is said each minute by default, each second if asked', () => {
    const minute = clock();
    assert.deepStrictEqual(minute.step(timeOf({ capture: T - 20500 }), 1000)[5].list.map((m) => m.text), ['22:13:00 UTC\n']);
    assert.deepStrictEqual(minute.step(timeOf({ capture: T - 19500 }), 1000)[5].list, []);
    const each = clock({ announce: 'second', format: 'hhmmz' });
    assert.deepStrictEqual(each.step(timeOf({ capture: T - 500 }), 1000)[5].list.map((m) => m.text), ['2213Z\n']);
});

t('the time is said once straight away, whatever the schedule, so a console shows it now', () => {
    const c = clock({ announce: 'hour' });
    // 22:13:20.5 — nowhere near the hour.
    assert.deepStrictEqual(c.step(timeOf({ capture: T + 500 }), 100)[5].list.map((m) => m.text), ['22:13:20 UTC\n']);
    assert.deepStrictEqual(c.step(timeOf({ capture: T + 600 }), 100)[5].list, [], 'said again off schedule');
    const off = clock({ announce: 'off' });
    assert.deepStrictEqual(off.step(timeOf({ capture: T + 500 }), 100)[5].list, []);
});

t('following the page, a reading that wobbles is followed gently; a step is taken at once', () => {
    const c = clock({ align: 'page' });
    c.step(timeOf({ device: { t0: T, err: null } }), 20);
    // The next packet should start at T + 20; the page says 10 ms later.
    c.step(timeOf({ device: { t0: T + 30, err: null } }), 20);
    const r = c.inst.read();
    assert.ok(r.t > T + 40 && r.t < T + 43, `followed too hard or not at all: ${r.t - T}`);
    c.step(timeOf({ device: { t0: T + 5000, err: null } }), 20);
    assert.strictEqual(c.inst.read().t, T + 5020, 'a step was slewed');
});

t('a graph with a clock compiles and runs without the receiver', () => {
    const g = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'clk', type: 'clock' }, { id: 'sc', type: 'scope' }], wires: [['clk', 'pps', 'sc', 'a']] }).graph;
    assert.deepStrictEqual(compile(g, 48000).errors, []);
    assert.ok(BLOCK_BY_TYPE.clock && BLOCK_BY_TYPE['interval-counter']);
});

t('a packet\'s time reaches each Clock through the worker', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    core.onMessage({ t: 'graph', graph: { v: GRAPH_VERSION, nodes: [{ id: 'clk', type: 'clock' }], wires: [] }, rate: 48000 });
    core.onMessage({ t: 'watch', ids: ['clk'], levels: false });
    core.onMessage({ t: 'packet', seq: 1, i: null, q: null, frames: 960, rate: 48000, time: timeOf({ ntp: { t0: T, err: 1.5 }, ntpOffered: true }) });
    const out = posted.filter((m) => m.t === 'out').pop();
    const r = out.readings && out.readings.clk;
    assert.ok(r, 'no reading');
    assert.strictEqual(r.src, 'ntp');
    assert.strictEqual(r.err, 1.5);
    assert.ok(Math.abs(r.t - (T + 20)) < 1e-6);
});

// ── what is wired into a Clock ──────────────────────────────────────────────

/** A Clock fed messages on `time` and a level on `pps`. */
function wiredClock(params = {}, rate = 1000) {
    const inst = ClockBlock.create();
    inst.configure(clockParams(params), rate);
    const step = ({ time = null, msgs = [], pps = null, n = 1000 } = {}) => {
        if (time) inst.feed({ time });
        const tIn = makeBuffer('message', 0);
        tIn.list = msgs;
        let pIn = null;
        if (pps) { pIn = makeBuffer('real', pps.length); pIn.re.set(pps); pIn.n = pps.length; }
        const outs = ClockBlock.outputs.map((p) => makeBuffer(p.kind, n));
        inst.process([tIn, pIn], outs, pps ? pps.length : n);
        return outs;
    };
    return { inst, step };
}

t('NMEA RMC and ZDA give their UTC; a bad checksum or no fix gives nothing', () => {
    const body = 'GPRMC,221320.00,A,5130.0,N,00007.0,W,0.0,0.0,141123,,,A';
    let sum = 0;
    for (const c of body) sum ^= c.charCodeAt(0);
    const cs = sum.toString(16).toUpperCase().padStart(2, '0');
    assert.strictEqual(parseNmea(`$${body}*${cs}`), T);
    assert.strictEqual(parseNmea(`$${body}*00`), null, 'a bad checksum was believed');
    assert.strictEqual(parseNmea('$GPRMC,221320.00,V,,,,,,,141123,,,N'), null, 'no fix was believed');
    assert.strictEqual(parseNmea('$GNZDA,221320.50,14,11,2023,00,00'), T + 500);
});

t('a time code wired in sets the clock to its edge, plus the path', () => {
    const c = wiredClock({ source: 'wired', propagationMs: 5 });
    // The decoder says: the edge 0.3 s before the end of this packet was T.
    c.step({ msgs: [{ type: 'timecode', utcMs: T, ago: 0.3, quality: 0.9, station: 'WWV' }] });
    const r = c.inst.read();
    assert.strictEqual(r.src, 'wired');
    assert.ok(Math.abs(r.t - (T + 305)) < 1e-6, `at ${r.t - T}`);
    assert.match(r.label, /WWV, quality 90%.*\+5 ms path/);
    // Silent too long: it falls back, and says so.
    for (let k = 0; k < 6; k++) c.step({ time: timeOf({ device: { t0: T + 1305 + k * 1000, err: null } }) });
    assert.notStrictEqual(c.inst.read().src, 'wired');
    assert.match(c.inst.read().note, /Nothing wired in is speaking/);
});

t('PPS edges pull the clock onto the second, and their spread is the error bound', () => {
    const c = wiredClock({ source: 'wired' });
    // The clock starts 40 ms fast of where the pulses say the seconds are.
    c.step({ time: timeOf({ device: { t0: T - 460, err: null } }), pps: new Float64Array(1000) });
    for (let s = 0; s < 20; s++) {
        const pps = new Float64Array(1000);
        // The edge 500 samples in is the true second T + s + 1.
        pps.fill(1, 500, 600);
        c.step({ pps });
    }
    const r = c.inst.read();
    assert.strictEqual(r.src, 'wired');
    assert.match(r.label, /PPS/);
    // After 21 packets of 1 s, the clock's end is T + 20.5 s, give or take what is left.
    assert.ok(Math.abs(r.t - (T + 20540 - 40)) < 2, `still ${r.t - (T + 20500)} ms out`);
    assert.ok(r.err != null && r.err < 20);
});

// ── the pulse classifier ────────────────────────────────────────────────────

t('classes are read from their text, and a width is sorted into the first that holds it', () => {
    const cls = parseClasses('0: 100-350, 1: 350-650; M: 650-950\nbad, x: 9-3');
    assert.deepStrictEqual(cls.map((c) => c.name), ['0', '1', 'M']);
    assert.strictEqual(classify(cls, 200), '0');
    assert.strictEqual(classify(cls, 350), '1');
    assert.strictEqual(classify(cls, 990), null);
    assert.ok(PULSE_PRESETS.wwvb && PULSE_PRESETS.dcf77 && PULSE_PRESETS.msf);
});

t('a WWVB-style signal is read as its symbols, to a fraction of a sample, and rejects counted', () => {
    const def = PulseClassifierBlock;
    const inst = def.create();
    inst.configure(sanitizeParams(def, { preset: 'wwvb' }), 1000);
    // Five seconds: carrier down for 0.2, 0.5, 0.8, 0.2, then a 0.05 s glitch.
    const x = new Float64Array(5000).fill(1);
    [200, 500, 800, 200, 50].forEach((len, s) => x.fill(0, s * 1000 + 100, s * 1000 + 100 + len));
    const outs = def.outputs.map((p) => makeBuffer(p.kind, 5000));
    // In two packets, so a pulse straddling them is measured whole.
    const a = makeBuffer('real', 2600); a.re.set(x.subarray(0, 2600)); a.n = 2600;
    const b = makeBuffer('real', 2400); b.re.set(x.subarray(2600)); b.n = 2400;
    inst.process([a], outs, 2600);
    const first = outs[0].list.map((m) => m.symbol);
    const bitsFirst = Array.from(outs[3].re.slice(0, 2));
    outs.forEach((o) => { if (o.list) o.list = []; });
    inst.process([b], outs, 2400);
    const syms = first.concat(outs[0].list.map((m) => m.symbol));
    assert.deepStrictEqual(syms, ['0', '1', 'M', '0']);
    assert.deepStrictEqual(bitsFirst, [0, 1]);
    const r = inst.read();
    assert.strictEqual(r.recent, '01M0');
    assert.strictEqual(r.rejects, 1, 'the glitch was not counted out');
    assert.ok(Math.abs(r.last.widthMs - 200) < 1e-6);
});

// ── the interval counter ────────────────────────────────────────────────────

t('the interval counter times start to stop finer than a sample, across two rates', () => {
    const def = IntervalCounterBlock;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), 1000, [1000, 250]);
    const outs = def.outputs.map((p) => makeBuffer(p.kind, 0));
    // Start: a step at 100 ms in each 1 s. Stop: a ramp through 0.5 at 112.3 ms,
    // on a 250 Hz stream (samples every 4 ms).
    for (let sec = 0; sec < 3; sec++) {
        const a = makeBuffer('real', 1000);
        for (let k = 0; k < 1000; k++) a.re[k] = k >= 100 && k < 200 ? 1 : 0;
        a.n = 1000;
        const b = makeBuffer('real', 250);
        for (let k = 0; k < 250; k++) {
            const ms = k * 4;
            b.re[k] = Math.max(0, Math.min(1, 0.5 + (ms - 112.3) / 8));
        }
        b.n = 250;
        inst.process([a, b], outs, 1000);
    }
    const r = inst.read();
    assert.strictEqual(r.count, 3);
    // The start edge is between samples 99 and 100: interpolated to 99.5 ms.
    assert.ok(Math.abs(r.last - 12.8) < 0.05, `measured ${r.last}`);
    assert.ok(r.sd < 1e-6);
    assert.ok(Math.abs(outs[0].value - r.last) < 1e-9);
});

t('a stop with no start recent enough is not counted', () => {
    const def = IntervalCounterBlock;
    const inst = def.create();
    inst.configure(sanitizeParams(def, { maxMs: 5 }), 1000, [1000, 1000]);
    const a = makeBuffer('real', 100);
    a.re.fill(1, 10, 20);
    a.n = 100;
    const b = makeBuffer('real', 100);
    b.re.fill(1, 40, 50);
    b.n = 100;
    inst.process([a, b], [makeBuffer('control', 0)], 100);
    const r = inst.read();
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.missed, 1);
});

// ── the time source ─────────────────────────────────────────────────────────

(async () => {
    await tAsync('the time source measures the add-on only where there is one and a Clock wants it', async () => {
        let asked = 0;
        let perf = 1000;
        const sample = async () => {
            asked++;
            return { sample: { theta: T - perf, delay: 4, at: perf, srvOffset: null, srvRate: 0 } };
        };
        const src = new TimeSource({ sample, now: () => perf, wall: () => T + 99, receiver: () => ({ theta: T - perf + 7, err: 10 }) });
        src.want(true);
        await new Promise((res) => setTimeout(res, 10));
        assert.strictEqual(asked, 0, 'asked a receiver with no add-on');
        let pt = src.packetTime(20, T);
        assert.strictEqual(pt.ntp, null);
        assert.strictEqual(pt.ntpOffered, false);
        assert.strictEqual(pt.receiver.err, 10);
        assert.strictEqual(pt.capture, T);
        src.configure({ ntp: true, hostSynced: true });
        await new Promise((res) => setTimeout(res, 10));
        assert.ok(asked >= 1, 'the add-on was not asked');
        pt = src.packetTime(20, T);
        assert.ok(pt.ntp && Math.abs(pt.ntp.t0 - (T - 20)) < 1e-6, 'the add-on\'s time is off');
        assert.ok(pt.hostToUtc && Math.abs(pt.hostToUtc.off + 7) < 1e-6, 'the receiver\'s clock was not set against it');
        assert.strictEqual(pt.hostSynced, true);
        src.stop();
    });

    console.log(`\n${pass} passed`);
})();
