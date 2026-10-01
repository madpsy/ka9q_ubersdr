// Delay and resampling.

const assert = require('assert');
const { GRAPH_VERSION, parseGraph, compile, Runtime, resampleRatio } = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

/** Amplitude and best frequency of the strongest tone near `hz`. */
function measure(x, rate, hz) {
    let best = { amp: 0, hz: 0 };
    for (let f = hz - 5; f <= hz + 5; f += 0.25) {
        let c = 0;
        let s = 0;
        for (let k = 0; k < x.length; k++) {
            c += x[k] * Math.cos((2 * Math.PI * f * k) / rate);
            s += x[k] * Math.sin((2 * Math.PI * f * k) / rate);
        }
        const amp = (2 * Math.hypot(c, s)) / x.length;
        if (amp > best.amp) best = { amp, hz: f };
    }
    return best;
}

/** A real tone through an audio resampler. Returns the output (settled) and its rate. */
function resample(inRate, outRate, hz, seconds = 1, packet = 0.02) {
    const g = graph(
        [
            { id: 'gen', type: 'signal', params: { frequencyHz: hz, amplitude: 0.5 } },
            { id: 're', type: 'real-part' },
            { id: 'rs', type: 'audio-resample', params: { rateHz: outRate } },
            { id: 'o', type: 'audio-out' },
        ],
        [['gen', 'out', 're', 'in'], ['re', 'out', 'rs', 'in'], ['rs', 'out', 'o', 'in']],
    );
    const rt = new Runtime(g, inRate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const out = [];
    const frames = Math.round(inRate * packet);
    const packets = Math.round(seconds / packet);
    for (let p = 0; p < packets; p++) {
        rt.process({ i: null, q: null, frames, rate: inRate });
        out.push(...rt.read('o').samples);
    }
    return { out, rate: rt.read('o').rate, total: out.length, packets, frames };
}

t('a ratio is exact where it can be, and the nearest fraction where it cannot', () => {
    assert.deepStrictEqual(resampleRatio(44100, 48000), { L: 160, M: 147 });
    assert.deepStrictEqual(resampleRatio(192000, 12000), { L: 1, M: 16 });
    assert.deepStrictEqual(resampleRatio(12000, 48000), { L: 4, M: 1 });
    const odd = resampleRatio(12000, 12345.678);
    assert.ok(odd.L <= 1024 && Math.abs((12000 * odd.L) / odd.M - 12345.678) < 1, JSON.stringify(odd));
});

for (const [a, b, hz] of [[12000, 8000, 1000], [12000, 48000, 1000], [44100, 48000, 3000], [192000, 12000, 1500], [48000, 44100, 440]]) {
    t(`a tone keeps its frequency and level from ${a / 1000}k to ${b / 1000}k`, () => {
        const r = resample(a, b, hz, 1);
        assert.strictEqual(r.rate, b);
        const settled = r.out.slice(r.out.length >> 1);
        const m = measure(Float64Array.from(settled), b, hz);
        assert.ok(Math.abs(m.hz - hz) <= 0.5, `came out at ${m.hz} Hz`);
        assert.ok(Math.abs(m.amp - 0.5) < 0.005, `level ${m.amp}`);
    });
}

t('what lies above the new Nyquist is filtered away, not folded down', () => {
    const r = resample(48000, 12000, 10000, 1);
    const settled = Float64Array.from(r.out.slice(r.out.length >> 1));
    // 10 kHz at 12k would alias to 2 kHz.
    const alias = measure(settled, 12000, 2000).amp;
    assert.ok(20 * Math.log10(alias / 0.5) < -60, `alias at ${(20 * Math.log10(alias / 0.5)).toFixed(1)} dB`);
});

t('the output count is exactly the ratio, however the input is cut', () => {
    const r = resample(44100, 48000, 1000, 3, 0.007);
    const inTotal = r.packets * r.frames;
    const want = (inTotal * 160) / 147;
    assert.ok(Math.abs(r.total - want) <= 1, `${r.total} out for ${inTotal} in, wanted ${want}`);
});

t('rates downstream follow the resampler, so two paths can be brought to one rate', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'd', type: 'decimate', params: { factor: 4 } },
            { id: 'rs', type: 'resample', params: { rateHz: 12000 } },
            { id: 'a', type: 'real-part' }, { id: 'b', type: 'real-part' }, { id: 'x', type: 'add' },
        ],
        [['iq', 'out', 'd', 'in'], ['iq', 'out', 'rs', 'in'], ['d', 'out', 'a', 'in'], ['rs', 'out', 'b', 'in'], ['a', 'out', 'x', 'a'], ['b', 'out', 'x', 'b']],
    );
    const c = compile(g, 48000);
    assert.strictEqual(c.outRate.rs, 12000);
    assert.ok(c.ok, JSON.stringify(c.errors));
});

t('a delay holds the signal back by exactly what it says, and reports it as latency', () => {
    const g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'dl', type: 'delay', params: { delayMs: 5 } }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        [['iq', 'out', 'dl', 'in'], ['dl', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    );
    const rt = new Runtime(g, 12000);
    const out = [];
    for (let p = 0; p < 4; p++) {
        const I = new Float32Array(240);
        if (p === 0) I[3] = 1;
        rt.process({ i: I, q: new Float32Array(240), frames: 240, rate: 12000 });
        out.push(...rt.read('o').samples);
    }
    assert.strictEqual(out.indexOf(1), 3 + 60, 'the impulse is not 60 samples (5 ms) late');
    assert.ok(Math.abs(rt.latencyOf('dl').own - 0.005) < 1e-12);
});

t('the resampler’s latency is where its impulse comes out', () => {
    const g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'r', type: 'real-part' }, { id: 'rs', type: 'audio-resample', params: { rateHz: 12000 } }, { id: 'o', type: 'audio-out' }],
        [['iq', 'out', 'r', 'in'], ['r', 'out', 'rs', 'in'], ['rs', 'out', 'o', 'in']],
    );
    const rt = new Runtime(g, 12000);
    const out = [];
    for (let p = 0; p < 10; p++) {
        const I = new Float32Array(240);
        if (p === 0) I[0] = 1;
        rt.process({ i: I, q: new Float32Array(240), frames: 240, rate: 12000 });
        out.push(...rt.read('o').samples);
    }
    let at = 0;
    for (let k = 1; k < out.length; k++) if (out[k] > out[at]) at = k;
    const said = rt.latencyOf('rs').own * 12000;
    assert.ok(Math.abs(at - said) <= 0.5, `impulse at ${at}, latency says ${said}`);
});

console.log(`\n${pass} passed`);
