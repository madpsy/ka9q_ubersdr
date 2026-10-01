// The one-block demodulator, and taking it apart.
//
// It claims to be the IQ Demod panel's demodulator, so it is held to that
// sample for sample. And expanding it claims to change nothing but the
// drawing, so the expanded graph is held to the block the same way.

const assert = require('assert');
const {
    DemodChain, planFor, setIQSpan, GRAPH_VERSION, parseGraph, compile, Runtime, demodPlan, expandDemodulator,
} = require('./.build/playground.cjs');
const { scene } = require('./dspscene.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

const MODES = [
    { mode: 'usb', offsetHz: -4500, widthHz: 2700 },
    { mode: 'lsb', offsetHz: -2200, widthHz: 1800, lowCutHz: 200 },
    { mode: 'cwu', offsetHz: 0, widthHz: 500, pitchHz: 600 },
    { mode: 'am', offsetHz: 2000, widthHz: 9000 },
    { mode: 'sam', offsetHz: 1950, widthHz: 9000 },
    { mode: 'ecss', offsetHz: 2040, widthHz: 4500, sideband: 'auto' },
    { mode: 'nfm', offsetHz: -1500, widthHz: 6000 },
];
const BASE = { pitchHz: 700, sideband: 'both', trackHz: 300, lowCutHz: 50, agc: true, gain: 1, squelchDb: -28 };

function demodGraph(params) {
    return graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'd', type: 'demodulator', params }, { id: 'o', type: 'audio-out' }, { id: 'p', type: 'control-plot' }],
        [['iq', 'out', 'd', 'in'], ['d', 'audio', 'o', 'in'], ['d', 'signal', 'p', 'in']],
    );
}

function run(g, rate, seconds, sink = 'o') {
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const { I, Q, n } = scene(rate, seconds);
    const p = Math.round(rate * 0.02);
    const out = [];
    for (let at = 0; at < n; at += p) {
        const len = Math.min(p, n - at);
        rt.process({ i: I.subarray(at, at + len), q: Q.subarray(at, at + len), frames: len, rate });
        const r = rt.read(sink);
        if (r.frames) out.push(...r.samples);
    }
    return { out, rt };
}

for (const rate of [12000, 192000]) {
    for (const m of MODES) {
        t(`the block is the panel’s demodulator: ${m.mode} @${rate / 1000}k`, () => {
            const params = { ...BASE, ...m };
            const { out } = run(demodGraph(params), rate, 2);
            // The panel's way: told the stream's width (IQDemodWatch does this
            // from the IQ preset), planFor with the offset, DemodChain, per
            // packet.
            setIQSpan(rate);
            const chain = new DemodChain();
            const plan = planFor(params);
            setIQSpan(0);
            const { I, Q, n } = scene(rate, 2);
            const p = Math.round(rate * 0.02);
            const want = [];
            for (let at = 0; at < n; at += p) {
                const len = Math.min(p, n - at);
                chain.configure(plan, rate);
                const a = chain.process(I.subarray(at, at + len), Q.subarray(at, at + len), len, { agc: true, gain: 1, squelchDb: -28, lockMute: params.lockMute !== false });
                if (a) for (let k = 0; k < chain.outFrames; k++) want.push(a[k]);
            }
            assert.strictEqual(out.length, want.length);
            for (let k = 0; k < want.length; k++) {
                if (!Object.is(out[k], want[k])) assert.fail(`sample ${k}: ${out[k]} vs ${want[k]}`);
            }
        });
    }
}

for (const [rate, m] of [[12000, MODES[0]], [48000, MODES[3]], [12000, MODES[5]], [192000, MODES[6]]]) {
    t(`expanding changes nothing but the drawing: ${m.mode} @${rate / 1000}k`, () => {
        const g = demodGraph({ ...BASE, ...m });
        const before = run(g, rate, 2);
        const { graph: x, ids } = expandDemodulator(g, 'd', rate);
        assert.ok(ids.length > 5, 'nothing came out');
        assert.ok(!x.nodes.some((n) => n.id === 'd'), 'the block was left in');
        assert.ok(ids.every((id) => id.startsWith('d_')), 'blocks not named after what they came from');
        assert.ok(compile(x, rate).ok, JSON.stringify(compile(x, rate).errors));
        const after = run(x, rate, 2);
        assert.strictEqual(after.out.length, before.out.length);
        for (let k = 0; k < before.out.length; k++) {
            if (!Object.is(after.out[k], before.out[k])) assert.fail(`sample ${k}: ${after.out[k]} vs ${before.out[k]}`);
        }
        // The passband level carries on to whatever read the block's.
        assert.ok(x.wires.some((w) => w[1] === 'db' && w[2] === 'p'), 'the signal output was not carried over');
        assert.ok(Math.abs(after.rt.read('p').value - before.rt.read('p').value) < 1e-9, 'the signal reading changed');
    });
}

t('the offset is held inside the stream, at the rate the block is given', () => {
    const p = { ...BASE, mode: 'usb', widthHz: 2700, offsetHz: 50000 };
    const at12 = demodPlan(p, 12000);
    const at96 = demodPlan(p, 96000);
    assert.ok(at12.centreHz + at12.cutoffHz <= 6000 + 1e-9, `passband past the top at 12k: centre ${at12.centreHz}`);
    assert.ok(at96.centreHz > 40000, 'a wide stream was held to plain IQ’s reach');
});

t('the block’s latency is its stages’ latency', () => {
    const g = demodGraph({ ...BASE, ...MODES[0] });
    const rt = new Runtime(g, 12000);
    const own = rt.latencyOf('d').own;
    const x = expandDemodulator(g, 'd', 12000).graph;
    const rx = new Runtime(x, 12000);
    assert.ok(own > 0.005);
    assert.ok(Math.abs(rx.latencyOf('o').total - own) < 1e-9, `${rx.latencyOf('o').total} expanded vs ${own} as one block`);
});

t('a demodulator with nothing feeding it expands into blocks waiting for an input', () => {
    const g = graph([{ id: 'd', type: 'demodulator' }], []);
    const { graph: x } = expandDemodulator(g, 'd', 12000);
    const errs = compile(x, 12000).errors.map((e) => e.message).join(' ');
    assert.match(errs, /needs a wire/);
});

console.log(`\n${pass} passed`);
