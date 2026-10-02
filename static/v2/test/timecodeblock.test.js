// The Time code decoder block: a station's signal at a wider rate than the
// decoders run at, decoded, its instants mapped back to the block's input — and
// a Clock wired to it keeping the time it decoded.

const assert = require('assert');
const {
    TimecodeBlock, Decimator, STATIONS, syntheticFrame, SYM, fieldsFromUtc,
    createWorkerCore, makeBuffer, sanitizeParams, GRAPH_VERSION,
} = require('./.build/timecodeblock.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 48000;
// 2026-10-02 12:34:50 UTC: ten seconds before a minute.
const T0 = Date.UTC(2026, 9, 2, 12, 34, 50);

// A seeded normal, so a failure is the same failure every run.
function rng(seed) {
    let s = seed >>> 0;
    const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * WWVB's amplitude code at RATE, from the published layout: the carrier down
 * 17 dB for 0.2 s (0), 0.5 s (1) or 0.8 s (marker) from each second. Returns
 * `{ i, q }` for `secs` seconds from T0, carrier at 0 Hz with a phase and noise.
 */
function wwvb(secs, noise = 0.01) {
    const n = secs * RATE;
    const i = new Float32Array(n);
    const q = new Float32Array(n);
    const g = rng(7);
    const low = 10 ** (-17 / 20);
    const frames = new Map();
    const symbolAt = (ms) => {
        const minute = Math.floor(ms / 60000) * 60000;
        if (!frames.has(minute)) frames.set(minute, syntheticFrame(fieldsFromUtc(minute), 1).symbols);
        const s = frames.get(minute)[Math.floor((ms - minute) / 1000)];
        return s === SYM.MARKER ? 800 : s === SYM.ONE ? 500 : 200;
    };
    const ph = 0.7;
    for (let k = 0; k < n; k++) {
        const ms = T0 + (k / RATE) * 1000;
        const into = ms - Math.floor(ms / 1000) * 1000;
        const a = into < symbolAt(ms) ? low : 1;
        i[k] = a * Math.cos(ph) + noise * g();
        q[k] = a * Math.sin(ph) + noise * g();
    }
    return { i, q };
}

const SECS = 150;
const SIG = wwvb(SECS);
const PACKET = 960;

t('the decimator keeps one sample in its factor and says how late they are', () => {
    const d = new Decimator(RATE, 12000);
    assert.strictEqual(d.factor, 4);
    // An impulse at input sample 400 comes out where the delay says.
    const n = 2000;
    const xi = new Float64Array(n);
    xi[400] = 1;
    const oi = new Float64Array(n);
    const oq = new Float64Array(n);
    const k = d.process(xi, new Float64Array(n), n, oi, oq);
    assert.strictEqual(k, 500);
    let peak = 0;
    for (let j = 1; j < k; j++) if (Math.abs(oi[j]) > Math.abs(oi[peak])) peak = j;
    assert.ok(Math.abs(peak * d.factor - d.delay - 400) <= d.factor / 2, `impulse at ${peak * d.factor - d.delay}`);
    assert.ok(STATIONS.length === 7);
});

t('at 48 kHz the block decodes WWVB, and each time it sends points at the right instant of its input', () => {
    const inst = TimecodeBlock.create();
    inst.configure(sanitizeParams(TimecodeBlock, { station: 'wwvb' }), RATE);
    const sent = [];
    const text = [];
    let consumed = 0;
    for (let at = 0; at + PACKET <= SIG.i.length; at += PACKET) {
        const x = makeBuffer('complex', PACKET);
        x.re.set(SIG.i.subarray(at, at + PACKET));
        x.im.set(SIG.q.subarray(at, at + PACKET));
        x.n = PACKET;
        const outs = TimecodeBlock.outputs.map((p) => makeBuffer(p.kind, 0));
        inst.process([x], outs, PACKET);
        consumed += PACKET;
        for (const m of outs[0].list) sent.push({ ...m, end: consumed });
        for (const m of outs[1].list) text.push(m.text);
    }
    const r = inst.read();
    assert.strictEqual(r.state, 'locked', `not locked: ${JSON.stringify(r.refusal)}`);
    assert.ok(sent.length >= 10, `only ${sent.length} times sent`);
    for (const m of sent) {
        assert.strictEqual(m.station, 'WWVB');
        assert.strictEqual(m.utcMs % 1000, 0, 'not a whole second');
        // Where in the input that edge was, and what the signal's own time there is.
        const edge = m.end - m.ago * RATE;
        const truth = T0 + (edge / RATE) * 1000;
        assert.ok(Math.abs(truth - m.utcMs) < 1, `the time ${new Date(m.utcMs).toISOString()} is ${(truth - m.utcMs).toFixed(3)} ms off its edge`);
    }
    assert.ok(text.some((s) => /^2026-10-02T12:3\d:00Z WWVB \d+%/.test(s)), `no minute said: ${JSON.stringify(text.slice(0, 3))}`);
    assert.ok(text.includes('WWVB: locked\n'));
});

t('wired to a Clock in the worker, the Clock keeps the time the decoder read', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => posted.length);
    core.onMessage({
        t: 'graph',
        rate: RATE,
        graph: {
            v: GRAPH_VERSION,
            nodes: [
                { id: 'iq', type: 'iq-in' },
                { id: 'tc', type: 'timecode', params: { station: 'wwvb' } },
                { id: 'clk', type: 'clock', params: { source: 'wired' } },
            ],
            wires: [['iq', 'out', 'tc', 'in'], ['tc', 'time', 'clk', 'time']],
        },
    });
    const status = posted.find((m) => m.t === 'status');
    assert.ok(status && status.ok, `graph refused: ${JSON.stringify(status && status.errors)}`);
    core.onMessage({ t: 'watch', ids: ['clk', 'tc'], levels: false });
    let seq = 0;
    for (let at = 0; at + PACKET <= SIG.i.length; at += PACKET) {
        core.onMessage({ t: 'packet', seq: ++seq, i: SIG.i.slice(at, at + PACKET), q: SIG.q.slice(at, at + PACKET), frames: PACKET, rate: RATE });
    }
    const last = posted.filter((m) => m.t === 'out' && m.readings && m.readings.clk).pop();
    const clk = last.readings.clk;
    assert.strictEqual(clk.src, 'wired', `the clock is on ${clk.src}: ${clk.note}`);
    assert.match(clk.label, /WWVB/);
    // The clock's time at the end of the packet its reading came with, against
    // the signal's own there. (Readings are sent only every so often.)
    const end = T0 + ((last.seq * PACKET) / RATE) * 1000;
    assert.ok(Math.abs(clk.t - end) < 2, `the clock is ${(clk.t - end).toFixed(3)} ms off`);
});

console.log(`\n${pass} passed`);
