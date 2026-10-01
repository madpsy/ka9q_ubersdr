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

console.log(`\n${pass} passed`);
