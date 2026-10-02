// The playground's filter blocks, and what every block reports about itself.
//
// A filter is right if it passes what it should and stops what it should, at
// the frequencies it says — so each one here is driven with tones and its
// output measured, not its taps inspected. The one-sided complex band-pass gets
// a tone on each side of zero, because a filter applied backwards passes the
// mirror image and looks fine on everything else.
//
// Then the two figures each block reports: its latency, checked against the
// delay an impulse actually comes out with, and its CPU share, checked for
// the arithmetic with a clock the test controls.

const assert = require('assert');
const {
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, GRAPH_VERSION, parseGraph,
    Runtime, createWorkerCore, STATS_EVERY_MS, biquadCoefficients, biquadGainAt,
    PanelNR, PanelNR2, PanelNB, CopyNR, CopyNR2, CopyNB,
} = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;

/** A block instance configured at `rate`, with `params` over its defaults. */
function block(type, params = {}, rate = RATE) {
    const def = BLOCK_BY_TYPE[type];
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), rate);
    return { def, inst };
}

/** Run `n` samples through a one-in, one-out block. */
function run({ def, inst }, re, im) {
    const n = re.length;
    const kind = def.inputs[0].kind;
    const input = makeBuffer(kind, n);
    input.re.set(re);
    if (input.im) input.im.set(im || new Float64Array(n));
    input.n = n;
    const out = makeBuffer(def.outputs[0].kind, n);
    inst.process([input], [out], n);
    return out;
}

/**
 * The gain a block gives a tone at `hz`: real for an audio block, complex
 * e^(j2πft) for a complex one, so the sign of `hz` is which side of zero.
 * Measured by correlation over the second half, after the filter has filled.
 */
function gainAt(type, params, hz, rate = RATE) {
    const b = block(type, params, rate);
    const n = 8192;
    const w = (2 * Math.PI * hz) / rate;
    const re = Float64Array.from({ length: n }, (_, k) => Math.cos(w * k));
    const im = Float64Array.from({ length: n }, (_, k) => Math.sin(w * k));
    const complex = b.def.inputs[0].kind === 'complex';
    const out = run(b, re, complex ? im : null);
    let c = 0;
    let s = 0;
    const from = n / 2;
    for (let k = from; k < n; k++) {
        const yr = out.re[k];
        const yi = complex ? out.im[k] : 0;
        // Correlate against e^(-jwk): the component at +hz.
        c += yr * Math.cos(w * k) + yi * Math.sin(w * k);
        s += yi * Math.cos(w * k) - yr * Math.sin(w * k);
    }
    return (complex ? 1 : 2) * Math.hypot(c, s) / (n - from);
}

const db = (g) => 20 * Math.log10(Math.max(g, 1e-12));
const passes = (g, what) => assert.ok(Math.abs(g - 1) < 0.01, `${what}: gain ${g.toFixed(4)}, wanted 1`);
const stops = (g, what, floorDb = -60) => assert.ok(db(g) < floorDb, `${what}: ${db(g).toFixed(1)} dB, wanted under ${floorDb}`);

// ── audio FIRs ──────────────────────────────────────────────────────────────

t('audio low-pass passes below its cutoff and stops above it', () => {
    passes(gainAt('audio-lowpass', { cutoffHz: 1000 }, 300), '300 Hz');
    passes(gainAt('audio-lowpass', { cutoffHz: 1000 }, 800), '800 Hz');
    stops(gainAt('audio-lowpass', { cutoffHz: 1000 }, 1500), '1500 Hz');
    stops(gainAt('audio-lowpass', { cutoffHz: 1000 }, 4000), '4000 Hz');
});

t('audio high-pass passes above its cutoff and stops below it', () => {
    passes(gainAt('audio-highpass', { cutoffHz: 1000 }, 1500), '1500 Hz');
    passes(gainAt('audio-highpass', { cutoffHz: 1000 }, 4000), '4000 Hz');
    stops(gainAt('audio-highpass', { cutoffHz: 1000 }, 500), '500 Hz');
    stops(gainAt('audio-highpass', { cutoffHz: 1000 }, 60), '60 Hz hum');
});

t('audio band-pass passes its band and stops either side', () => {
    const p = { lowHz: 800, highHz: 1600 };
    passes(gainAt('audio-bandpass', p, 1200), 'centre');
    passes(gainAt('audio-bandpass', p, 950), 'inside, low');
    stops(gainAt('audio-bandpass', p, 300), 'below');
    stops(gainAt('audio-bandpass', p, 2500), 'above');
});

t('audio band-stop takes its band out and leaves the rest', () => {
    const p = { lowHz: 900, highHz: 1100 };
    stops(gainAt('audio-bandstop', p, 1000), 'centre', -40);
    passes(gainAt('audio-bandstop', p, 300), 'below');
    passes(gainAt('audio-bandstop', p, 2500), 'above');
});

// ── complex FIRs ────────────────────────────────────────────────────────────

t('complex high-pass passes both sides beyond its cutoff, and stops near zero', () => {
    for (const hz of [1500, -1500, 4000, -4000]) passes(gainAt('complex-highpass', { cutoffHz: 1000 }, hz), `${hz} Hz`);
    for (const hz of [300, -300, 0]) stops(gainAt('complex-highpass', { cutoffHz: 1000 }, hz), `${hz} Hz`);
});

t('complex band-pass passes its band on one side of zero, and not the mirror image', () => {
    const p = { lowHz: 1000, highHz: 2000 };
    passes(gainAt('complex-bandpass', p, 1500), '+1500 Hz');
    stops(gainAt('complex-bandpass', p, -1500), '−1500 Hz, the mirror');
    stops(gainAt('complex-bandpass', p, 300), '+300 Hz');
    stops(gainAt('complex-bandpass', p, 3000), '+3000 Hz');
    const neg = { lowHz: -2000, highHz: -1000 };
    passes(gainAt('complex-bandpass', neg, -1500), '−1500 Hz, a band below zero');
    stops(gainAt('complex-bandpass', neg, 1500), '+1500 Hz, its mirror');
});

t('complex band-pass works on a wide stream too', () => {
    const p = { lowHz: 20000, highHz: 23000 };
    passes(gainAt('complex-bandpass', p, 21500, 96000), '+21.5 kHz');
    stops(gainAt('complex-bandpass', p, -21500, 96000), '−21.5 kHz');
});

t('edges given the wrong way round are read the right way round', () => {
    passes(gainAt('complex-bandpass', { lowHz: 2000, highHz: 1000 }, 1500), 'swapped edges');
    passes(gainAt('audio-bandpass', { lowHz: 1600, highHz: 800 }, 1200), 'swapped edges');
});

// ── IIR ─────────────────────────────────────────────────────────────────────

t('every biquad shape does what its coefficients say it does', () => {
    const cases = [
        ['lowpass', 1000, 0.707, 0], ['highpass', 1000, 0.707, 0], ['bandpass', 1000, 2, 0],
        ['notch', 1000, 5, 0], ['peaking', 1000, 1, 6], ['lowshelf', 500, 0.707, -9], ['highshelf', 2000, 0.707, 9],
    ];
    for (const [shape, f, q, g] of cases) {
        const c = biquadCoefficients(shape, f, q, g, RATE);
        for (const hz of [100, 500, 1000, 2000, 4000]) {
            if (shape === 'notch' && hz === 1000) continue;
            const want = biquadGainAt(c, hz, RATE);
            const got = gainAt('biquad', { shape, frequencyHz: f, q, gainDb: g }, hz);
            assert.ok(Math.abs(got - want) < 0.01 * Math.max(1, want), `${shape} at ${hz} Hz: ran ${got.toFixed(4)}, designed ${want.toFixed(4)}`);
        }
    }
});

t('biquad shapes land where their names say', () => {
    const at = (shape, f, q, g, hz) => biquadGainAt(biquadCoefficients(shape, f, q, g, RATE), hz, RATE);
    assert.ok(Math.abs(at('lowpass', 1000, Math.SQRT1_2, 0, 1000) - Math.SQRT1_2) < 0.005, 'low-pass is not −3 dB at its corner');
    assert.ok(Math.abs(db(at('peaking', 1000, 1, 6, 1000)) - 6) < 0.05, 'peaking is not +6 dB at its centre');
    assert.ok(Math.abs(db(at('lowshelf', 300, 0.707, -9, 30)) + 9) < 0.2, 'low shelf is not −9 dB well below its corner');
    assert.ok(Math.abs(at('bandpass', 1000, 2, 0, 1000) - 1) < 0.001, 'band-pass is not 0 dB at its centre');
    assert.ok(at('notch', 1000, 5, 0, 1000) < 1e-9, 'notch has no null');
});

t('the notch takes out its frequency, is as wide as it says, and leaves the rest', () => {
    stops(gainAt('notch', { frequencyHz: 1000, widthHz: 50 }, 1000), '1000 Hz', -40);
    passes(gainAt('notch', { frequencyHz: 1000, widthHz: 50 }, 300), '300 Hz');
    // Width is between the −3 dB points.
    const c = biquadCoefficients('notch', 1000, 1000 / 50, 0, RATE);
    const edge = biquadGainAt(c, 1025, RATE);
    assert.ok(Math.abs(edge - Math.SQRT1_2) < 0.02, `25 Hz off a 50 Hz-wide notch: ${edge.toFixed(3)}`);
});

t('no setting makes a biquad unstable', () => {
    for (const shape of ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf']) {
        for (const [f, q, g] of [[0, 0, 40], [1e9, 50, -40], [5999, 0.05, 40], [1, 50, 40]]) {
            const c = biquadCoefficients(shape, f, q, g, RATE);
            // Poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
            assert.ok(Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2, `${shape} f=${f} q=${q} g=${g}: a1 ${c.a1} a2 ${c.a2}`);
        }
    }
});

// ── latency ─────────────────────────────────────────────────────────────────

/** Where an impulse comes out of a block, in samples. */
function impulseDelay(type, params, rate = RATE) {
    const b = block(type, params, rate);
    const n = 4096;
    const re = new Float64Array(n);
    re[0] = 1;
    const out = run(b, re, b.def.inputs[0].kind === 'complex' ? new Float64Array(n) : null);
    let best = 0;
    let at = 0;
    for (let k = 0; k < n; k++) {
        const m = Math.hypot(out.re[k], out.im ? out.im[k] : 0);
        if (m > best) { best = m; at = k; }
    }
    return { at, said: b.inst.latency() };
}

t('a linear-phase filter’s latency is where its impulse comes out', () => {
    const cases = [
        ['lowpass', { cutoffHz: 1350 }], ['complex-highpass', { cutoffHz: 300 }],
        ['complex-bandpass', { lowHz: 500, highHz: 2500 }], ['audio-lowpass', { cutoffHz: 3000 }],
        ['audio-highpass', { cutoffHz: 300 }], ['audio-bandpass', { lowHz: 300, highHz: 2700 }],
        ['audio-bandstop', { lowHz: 900, highHz: 1100 }],
    ];
    for (const [type, p] of cases) {
        const { at, said } = impulseDelay(type, p);
        assert.ok(said > 10, `${type} reports ${said} samples`);
        assert.strictEqual(at, said, `${type}: impulse at ${at}, latency says ${said}`);
    }
});

t('blocks without a delay say none, and the IIRs say why theirs is not one number', () => {
    for (const type of ['shift', 'to-audio', 'gain', 'agc', 'squelch', 'biquad', 'notch']) {
        const { inst } = block(type);
        assert.strictEqual(inst.latency ? inst.latency() : 0, 0, type);
    }
    assert.match(BLOCK_BY_TYPE.biquad.latencyNote, /IIR/);
    assert.match(BLOCK_BY_TYPE.notch.latencyNote, /IIR/);
});

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

t('the runtime adds latency along the path, at each block’s own rate', () => {
    const g = graph([
        { id: 'iq', type: 'iq-in' },
        { id: 'dec', type: 'decimate', params: { factor: 4, passHz: 4000 } },
        { id: 'lp', type: 'lowpass', params: { cutoffHz: 1350 } },
        { id: 'aud', type: 'to-audio', params: { frequencyHz: 1350 } },
        { id: 'hp', type: 'audio-highpass', params: { cutoffHz: 200 } },
        { id: 'out', type: 'audio-out' },
    ], [['iq', 'out', 'dec', 'in'], ['dec', 'out', 'lp', 'in'], ['lp', 'out', 'aud', 'in'], ['aud', 'out', 'hp', 'in'], ['hp', 'out', 'out', 'in']]);
    const rt = new Runtime(g, 48000);
    const own = (id) => rt.latencyOf(id).own;
    const dec = rt.nodes.get('dec');
    assert.strictEqual(own('dec'), ((dec.inst.latency()) / 48000), 'the decimator’s delay is not at its input rate');
    assert.strictEqual(own('lp'), rt.nodes.get('lp').inst.latency() / 12000);
    const sum = own('dec') + own('lp') + own('hp');
    assert.ok(Math.abs(rt.latencyOf('out').total - sum) < 1e-12, `${rt.latencyOf('out').total} vs ${sum}`);
    assert.strictEqual(rt.latencyOf('aud').own, 0);
});

t('where two paths meet, the later one is the latency', () => {
    const g = graph([
        { id: 's', type: 'signal' },
        { id: 'a', type: 'real-part' },
        { id: 'slow', type: 'audio-lowpass', params: { cutoffHz: 500 } },
        { id: 'fast', type: 'gain' },
        { id: 'x', type: 'add' },
    ], [['s', 'out', 'a', 'in'], ['a', 'out', 'slow', 'in'], ['a', 'out', 'fast', 'in'], ['slow', 'out', 'x', 'a'], ['fast', 'out', 'x', 'b']]);
    const rt = new Runtime(g, RATE);
    assert.ok(rt.latencyOf('slow').total > 0);
    assert.strictEqual(rt.latencyOf('x').total, rt.latencyOf('slow').total);
});

t('the carrier tracker’s latency follows its sideband filters, and Both adds the combiner', () => {
    const tracker = (sideband) => {
        const rt = new Runtime(graph(
            [{ id: 'iq', type: 'iq-in' }, { id: 'tr', type: 'carrier-tracker', params: { mode: 'ecss', centreHz: 0, widthHz: 4500, sideband } }],
            [['iq', 'out', 'tr', 'in']],
        ), RATE);
        return rt.latencyOf('tr').own;
    };
    const usb = tracker('usb');
    assert.ok(usb > 0.005, `ECSS on one sideband reports ${usb}s`);
    assert.ok(Math.abs(tracker('both') - usb - 512 / RATE) < 1e-12, 'Both does not add the combiner’s transform');
});

// ── CPU ─────────────────────────────────────────────────────────────────────

t('each block’s CPU share is its time over the stream time, per window', () => {
    let clock = 0;
    const g = graph([
        { id: 'iq', type: 'iq-in' }, { id: 're', type: 'real-part' }, { id: 'o', type: 'audio-out' },
    ], [['iq', 'out', 're', 'in'], ['re', 'out', 'o', 'in']]);
    // Every clock read moves a millisecond on: each block's process() then
    // takes exactly 1 ms a packet.
    const rt = new Runtime(g, RATE, { now: () => clock++ });
    for (let p = 0; p < 10; p++) rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: RATE });
    const s = rt.stats();
    assert.ok(Math.abs(s.windowSec - 0.2) < 1e-12);
    for (const id of ['iq', 're', 'o']) assert.ok(Math.abs(s.nodes[id].cpu - 0.05) < 1e-12, `${id}: ${s.nodes[id].cpu}`);
    assert.ok(Math.abs(s.cpu - 0.15) < 1e-12);
    // The window empties.
    const again = rt.stats();
    assert.strictEqual(again.cpu, null);
    assert.strictEqual(again.nodes.re.cpu, null);
});

t('the worker sends each block’s CPU and latency about once a second', () => {
    let clock = 0;
    const sent = [];
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    core.onMessage({ t: 'graph', graph: graph([{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass' }, { id: 'a', type: 'to-audio' }, { id: 'o', type: 'audio-out' }], [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in'], ['a', 'out', 'o', 'in']]) });
    const packet = () => core.onMessage({ t: 'packet', seq: 1, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: RATE });
    sent.length = 0;
    packet();
    clock += STATS_EVERY_MS - 1;
    packet();
    assert.ok(sent.every((m) => !m.stats), 'stats sent before a second had passed');
    clock += 1;
    packet();
    const s = sent.pop().stats;
    assert.ok(s, 'no stats after a second');
    assert.deepStrictEqual(Object.keys(s.nodes).sort(), ['a', 'iq', 'lp', 'o']);
    assert.ok(s.nodes.lp.latencySec > 0);
    assert.strictEqual(s.nodes.o.totalLatencySec, s.nodes.lp.totalLatencySec);
});

// ── the Noise panel's stage, as blocks ──────────────────────────────────────
//
// The blocks run copies of the panel's engines (playground/noise/), changed
// only to take a packet of any length. So: given what the panel gives them —
// whole hops — the copies are the panel's, sample for sample, a hop later;
// cut any other way, they give the same; and the blocks do what the panel's
// do to noise.

/** Band noise with a tone over part of it and a click every quarter second. */
function noisy(n, { tone = 0.2, clicks = true, from = RATE, to = 2 * RATE } = {}) {
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    return Float64Array.from({ length: n }, (_, i) => 0.05 * rnd()
        + (i >= from && i < to ? tone * Math.sin((2 * Math.PI * 700 * i) / RATE) : 0)
        + (clicks && i % 3000 === 7 ? 0.9 : 0));
}

/** An engine run over `x` a `chunk` at a time. */
function feed(engine, x, chunk) {
    const out = new Float32Array(x.length);
    for (let s = 0; s < x.length; s += chunk) {
        const m = Math.min(chunk, x.length - s);
        const o = new Float32Array(m);
        engine.process(Float32Array.from(x.subarray(s, s + m)), o, m);
        out.set(o, s);
    }
    return out;
}

/** A block run over `x`, `chunk` frames to a packet. */
function blockRun(type, params, x, chunk) {
    const b = block(type, params);
    const out = new Float64Array(x.length);
    for (let s = 0; s < x.length; s += chunk) {
        const m = Math.min(chunk, x.length - s);
        out.set(run(b, x.subarray(s, s + m)).re.subarray(0, m), s);
    }
    return { out, b };
}

const rmsOf = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / (e - s)); };

t('the noise blocks run the Noise panel’s arithmetic: the copies match the panel’s engines', () => {
    const x = noisy(4 * RATE);
    for (const [name, Panel, Copy, args, hop] of [['LSA', PanelNR, CopyNR, [RATE], 256], ['NR (nr2)', PanelNR2, CopyNR2, [2048, 4], 512]]) {
        const panel = new Panel(...args);
        panel.enabled = true;
        // The panel's buffers are whole hops; so are these.
        const a = feed(panel, x, 1024);
        const b = feed(new Copy(...args), x, 1024);
        for (let i = 0; i + hop < x.length; i++) assert.strictEqual(b[i + hop], a[i], `${name}: sample ${i}`);
        // Cut any other way, the copy gives the same.
        for (const chunk of [240, 997, 1]) {
            const c = feed(new Copy(...args), x, chunk);
            for (let i = 0; i < x.length; i++) assert.strictEqual(c[i], b[i], `${name}, ${chunk} at a time: sample ${i}`);
        }
    }
    const panel = new PanelNB(RATE);
    panel.enabled = true;
    const a = feed(panel, x, 1024);
    const b = feed(new CopyNB(RATE), x, 240);
    for (let i = 0; i < x.length; i++) assert.strictEqual(b[i], a[i], `blanker: sample ${i}`);
});

t('each noise block’s latency is where its signal comes out, and off is a straight copy', () => {
    // A quiet second, then loud noise: what every one of them passes nearly
    // whole, so the delay shows by correlation.
    let seed = 9;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const x = Float64Array.from({ length: 3 * RATE }, (_, i) => (i < RATE ? 0.001 : 0.3) * rnd());
    for (const [type, from] of [['noise-blanker', RATE + 2400], ['lsa', RATE + 2400], ['nr2', 0]]) {
        const { out, b } = blockRun(type, {}, x, 240);
        let best = 0;
        let at = -1;
        for (let lag = 0; lag < 4096; lag++) {
            let c = 0;
            for (let i = from; i < from + 4000 && i + lag < x.length; i++) c += x[i] * out[i + lag];
            if (c > best) { best = c; at = lag; }
        }
        assert.strictEqual(at, b.inst.latency(), `${type}: comes out ${at} late, says ${b.inst.latency()}`);
        const off = blockRun(type, { on: false }, x, 240);
        assert.deepStrictEqual(Array.from(off.out), Array.from(x), `${type}: off is not a copy`);
        assert.strictEqual(off.b.inst.latency(), 0, `${type}: off, and still says it delays`);
    }
    assert.strictEqual(block('lsa').inst.latency(), 512);
    assert.strictEqual(block('nr2').inst.latency(), 2048);
});

t('the blanker cuts the clicks and leaves the rest; LSA and NR take the noise down and leave the tone', () => {
    const x = noisy(4 * RATE);
    const nb = blockRun('noise-blanker', {}, x, 240);
    const r = nb.b.inst.read();
    // Sixteen clicks: less the one in the 0.15 s warmup, and the four that
    // land on the tone — against it a click stands only 16 dB proud, under
    // the 19 dB threshold, which is the threshold being relative as meant.
    assert.strictEqual(r.pulses, 11, `${r.pulses} pulses blanked`);
    const L = nb.b.inst.latency();
    let peak = 0;
    for (let i = 3 * RATE; i < 4 * RATE; i++) peak = Math.max(peak, Math.abs(nb.out[i + L] || 0));
    assert.ok(peak < 0.1, `a click still reaches ${peak.toFixed(3)}`);

    // The clicks taken out first, as the panel does it; then each NR.
    const clean = noisy(6 * RATE, { clicks: false, from: 3 * RATE, to: 5 * RATE });
    for (const [type, cut] of [['lsa', 5], ['nr2', 5]]) {
        const { out, b } = blockRun(type, {}, clean, 240);
        const L2 = b.inst.latency();
        const noiseDb = 20 * Math.log10(rmsOf(out, 2 * RATE + L2, 3 * RATE + L2) / rmsOf(clean, 2 * RATE, 3 * RATE));
        const toneDb = 20 * Math.log10(rmsOf(out, 3.5 * RATE + L2, 4.5 * RATE + L2) / rmsOf(clean, 3.5 * RATE, 4.5 * RATE));
        assert.ok(noiseDb < -cut, `${type}: the noise only ${noiseDb.toFixed(1)} dB down`);
        assert.ok(toneDb > noiseDb + 10, `${type}: the tone ${toneDb.toFixed(1)} dB against the noise’s ${noiseDb.toFixed(1)}`);
    }
});

t('NR (nr2) learns the noise first, says so, and learns it again when asked', () => {
    // Thirty 512-sample frames: 1.28 s at 12 kHz.
    const early = blockRun('nr2', {}, noisy(RATE, { clicks: false }), 240);
    assert.strictEqual(early.b.inst.read().learning, true, 'done learning inside a second');
    const { b } = blockRun('nr2', {}, noisy(2 * RATE, { clicks: false }), 240);
    assert.strictEqual(b.inst.read().learning, false, 'still learning after two seconds');
    b.inst.command('relearn');
    assert.strictEqual(b.inst.read().learning, true, 'Learn again did not');
    // Makeup gain is a plain gain on the output.
    const x = noisy(2 * RATE, { clicks: false });
    const plain = blockRun('lsa', {}, x, 240).out;
    const up = blockRun('lsa', { makeupDb: 6 }, x, 240).out;
    for (let i = 0; i < x.length; i += 97) assert.ok(Math.abs(up[i] - plain[i] * Math.pow(10, 6 / 20)) < 1e-9);
});

// ── compressor / limiter ────────────────────────────────────────────────────

t('the limiter keeps every sample under the ceiling, by looking ahead rather than clipping', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    // Bursts of loud noise and spikes to three times full scale.
    const x = Float64Array.from({ length: 5 * RATE }, (_, i) => (Math.sin(i / 900) > 0 ? 2.4 : 0.1) * rnd() + (i % 2777 === 5 ? 3 : 0));
    for (const p of [{ ratio: 1, kneeDb: 0 }, { makeupDb: 12 }, { makeupDb: 24, ceilingDb: -6 }]) {
        const b = block('compressor', p);
        const out = new Float64Array(x.length);
        for (let s = 0; s < x.length; s += 240) out.set(run(b, x.subarray(s, s + 240)).re.subarray(0, 240), s);
        const ceiling = Math.pow(10, (p.ceilingDb == null ? -1 : p.ceilingDb) / 20);
        let peak = 0;
        for (const v of out) peak = Math.max(peak, Math.abs(v));
        assert.ok(peak <= ceiling * (1 + 1e-9), `${JSON.stringify(p)}: peak ${peak} over ${ceiling}`);
        assert.ok(peak > ceiling * 0.99, `${JSON.stringify(p)}: never reached the ceiling — not limiting`);
        assert.ok(b.inst.read().limitDb <= 0);
    }
    // Under the ceiling and nothing to compress, it is a delay of its look-ahead.
    const { at, said } = impulseDelay('compressor', { ratio: 1, kneeDb: 0 });
    assert.strictEqual(at, said, `impulse at ${at}, latency says ${said}`);
    assert.strictEqual(said, Math.round(0.0015 * RATE) - 1);
});

t('the compressor gives one dB out for every “ratio” dB in above the threshold, and says how much it takes', () => {
    const level = (inDb, p) => {
        const b = block('compressor', { limit: false, kneeDb: 0, ...p });
        const a = Math.pow(10, inDb / 20) * Math.SQRT2;
        const x = Float64Array.from({ length: 2 * RATE }, (_, i) => a * Math.sin((2 * Math.PI * 440 * i) / RATE));
        const out = new Float64Array(x.length);
        for (let s = 0; s < x.length; s += 240) out.set(run(b, x.subarray(s, s + 240)).re.subarray(0, 240), s);
        let ms = 0;
        for (let i = RATE; i < 2 * RATE; i++) ms += out[i] * out[i];
        return { db: 10 * Math.log10(ms / RATE), read: b.inst.read() };
    };
    // Well under the threshold: untouched.
    assert.ok(Math.abs(level(-50, {}).db + 50) < 0.1);
    // Well over it: 12 dB more in is 4 dB more out at 3:1, 2 dB at 6:1.
    const slope = (ratio) => (level(-4, { ratio }).db - level(-16, { ratio }).db) / 12;
    assert.ok(Math.abs(slope(3) - 1 / 3) < 0.05, `3:1 gives ${slope(3)}`);
    assert.ok(Math.abs(slope(6) - 1 / 6) < 0.05, `6:1 gives ${slope(6)}`);
    const r = level(-4, {}).read;
    assert.ok(r.reductionDb < -10, `reduction ${r.reductionDb}`);
    // Makeup is a plain gain on top.
    assert.ok(Math.abs(level(-4, { makeupDb: 6 }).db - level(-4, {}).db - 6) < 0.1);
    // Off: a straight copy, no delay.
    const off = block('compressor', { on: false });
    const x = Float64Array.from({ length: 480 }, (_, i) => Math.sin(i));
    assert.deepStrictEqual(Array.from(run(off, x).re), Array.from(x));
    assert.strictEqual(off.inst.latency(), 0);
});

// ── equalisers ──────────────────────────────────────────────────────────────

const dbAt = (type, params, hz, rate = RATE) => 20 * Math.log10(gainAt(type, params, hz, rate));

t('the graphic EQ: flat is untouched, a band lifts its own frequency, and what the card draws is what it does', () => {
    const { eqResponse } = require('./.build/playground.cjs');
    const flat = block('graphic-eq');
    const x = Float64Array.from({ length: 480 }, (_, i) => Math.sin(i * 0.37));
    assert.deepStrictEqual(Array.from(run(flat, x).re), Array.from(x), 'flat is not a copy');
    const p = { g1000: 6 };
    assert.ok(Math.abs(dbAt('graphic-eq', p, 1000) - 6) < 0.2, `1 kHz: ${dbAt('graphic-eq', p, 1000)}`);
    assert.ok(Math.abs(dbAt('graphic-eq', p, 60)) < 0.3, 'a 1 kHz band lifted 60 Hz');
    // The card's curve, against tones through the audio.
    const mix = { g170: -9, g1000: 6, g3000: 4, makeupDb: -2 };
    for (const hz of [100, 400, 1000, 2500, 4000]) {
        const [drawn] = eqResponse('graphic-eq', mix, RATE, [hz]);
        assert.ok(Math.abs(drawn - dbAt('graphic-eq', mix, hz)) < 0.2, `${hz} Hz: drawn ${drawn}, heard ${dbAt('graphic-eq', mix, hz)}`);
    }
    // 8 kHz is past 12 kHz audio's reach: left out, not bent under Nyquist.
    assert.ok(Math.abs(dbAt('graphic-eq', { g8000: 12 }, 5000)) < 0.3, 'an 8 kHz band squeezed into 12 kHz audio');
    assert.ok(dbAt('graphic-eq', { g8000: 12 }, 8000, 48000) > 11, 'and at 48 kHz it is there');
});

t('the parametric EQ: shelves and peaks where they are set, as wide as their Q, with an output gain', () => {
    assert.ok(Math.abs(dbAt('parametric-eq', { lowDb: -10, lowHz: 150 }, 40) + 10) < 0.5, 'low shelf');
    assert.ok(Math.abs(dbAt('parametric-eq', { lowDb: -10, lowHz: 150 }, 3000)) < 0.3, 'low shelf reached the top');
    assert.ok(Math.abs(dbAt('parametric-eq', { highDb: 8, highHz: 2000 }, 5000) - 8) < 0.6, 'high shelf');
    const peak = (q) => ({ b3Hz: 1500, b3Db: 9, b3Q: q });
    assert.ok(Math.abs(dbAt('parametric-eq', peak(2), 1500) - 9) < 0.2, 'peak');
    // A wider band (lower Q) lifts its neighbours more.
    assert.ok(dbAt('parametric-eq', peak(0.5), 900) > dbAt('parametric-eq', peak(4), 900) + 3, 'Q made no difference');
    assert.ok(Math.abs(dbAt('parametric-eq', { outDb: -6 }, 1000) + 6) < 0.1, 'output gain');
});

console.log(`\n${pass} passed`);
