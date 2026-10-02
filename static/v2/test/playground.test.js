// The playground engine: blocks, graphs and the runtime, with no interface.
//
// The first half is the claim the whole design rests on. A playground graph
// built from the lib/dsp blocks, wired the way DemodChain is wired, must *be*
// DemodChain — not sound like it, produce it, sample for sample, with the
// meter, the squelch, the tracker and the spectrum agreeing too. If that holds
// for every mode, back end, stream rate and packet cut, then the blocks wrap
// their primitives faithfully and the runtime moves samples between them
// without losing, reordering or rounding any. Everything after that is the
// graph rules and the runtime's own mechanics.

const assert = require('assert');
const {
    DemodChain, planFor,
    BLOCKS, BLOCK_BY_TYPE, COMPLEX, makeBuffer, sanitizeParams,
    GRAPH_VERSION, compile, parseGraph, serializeGraph,
    Runtime, graphForPlan,
} = require('./.build/playground.cjs');
const { rng, scene } = require('./dspscene.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// ── a graph is DemodChain ───────────────────────────────────────────────────

const SPLITS = {
    packet: (rate) => { const p = Math.round(rate * 0.02); return () => p; },
    random: () => { const r = rng(7); return () => 1 + Math.floor(r() * 2000); },
    // Including packets shorter than a decimation factor, which come out empty.
    odd: () => { const s = [1, 7, 13, 240, 4096, 333]; let i = 0; return () => s[i++ % s.length]; },
};

const seen = { states: new Set(), shut: 0, open: 0, decimated: 0, empty: 0 };

// `adaptive` runs the graph a person is given — its decimator on Auto, built
// at `builtAt` — rather than the chain's own shape. Off plain IQ that is the
// chain's own shape, so it is held bit for bit; on plain IQ its decimator mixes
// where the chain's shift or tracker would, a different oscillator, so it is
// held to `close` rather than exactly.
function versus({ settings, back, rate, seconds, split, adaptive = false, builtAt = rate, close = 0 }) {
    const plan = planFor(settings);
    const chain = new DemodChain();
    const rt = new Runtime(graphForPlan(plan, builtAt, { ...back, adaptive }), rate);
    assert.ok(rt.ok, `the graph does not compile: ${rt.errors.map((e) => e.message).join('; ')}`);
    const { I, Q, n } = scene(rate, seconds);
    const next = SPLITS[split](rate);
    const opts = { agc: back.agc, gain: back.gain, squelchDb: back.squelchDb, lockMute: !!back.lockMute };
    for (let at = 0, p = 0; at < n; p++) {
        const len = Math.min(next(), n - at);
        const pI = I.subarray(at, at + len);
        const pQ = Q.subarray(at, at + len);
        chain.configure(plan, rate);
        const out = chain.process(pI, pQ, len, opts);
        rt.process({ i: pI, q: pQ, frames: len, rate });
        const where = `${settings.mode} @${rate} packet ${p}`;

        const heard = rt.read('audio');
        const want = out ? chain.outFrames : 0;
        assert.strictEqual(heard.frames, want, `${where}: ${heard.frames} frames from the graph, ${want} from the chain`);
        for (let k = 0; k < want; k++) {
            if (close ? !(Math.abs(heard.samples[k] - out[k]) <= close) : !Object.is(heard.samples[k], out[k])) {
                assert.fail(`${where}: sample ${k}: ${heard.samples[k]} (graph) vs ${out[k]} (chain)`);
            }
        }
        if (close) {
            at += len;
            continue;
        }
        if (!want) seen.empty++;
        assert.ok(Object.is(rt.read('meter').level, chain.level), `${where}: meter ${rt.read('meter').level} vs ${chain.level}`);
        assert.ok(Object.is(rt.read('level').level, chain.detector.level), `${where}: passband level`);
        assert.strictEqual(rt.read('squelch').open, chain.gateOpen, `${where}: squelch state`);
        if (chain.ecssStatus) {
            const tr = rt.read('tracker');
            assert.strictEqual(tr.state, chain.ecssStatus.state, `${where}: tracker state`);
            assert.strictEqual(tr.locked, chain.ecssStatus.locked, `${where}: tracker lock`);
            seen.states.add(tr.state);
        }
        if (p % 13 === 0) {
            const a = rt.read('spectrum');
            const b = chain.audioSpectrum();
            assert.strictEqual(a.binHz, b.binHz, `${where}: spectrum bin width`);
            for (let k = 0; k < b.db.length; k++) {
                if (!Object.is(a.db[k], b.db[k])) assert.fail(`${where}: spectrum bin ${k}`);
            }
        }
        if (back.squelchDb > -60) seen[chain.gateOpen ? 'open' : 'shut']++;
        if (chain.D > 1) seen.decimated++;
        at += len;
    }
}

const BASE = { pitchHz: 700, sideband: 'both', trackHz: 300, lowCutHz: 50 };
const MODES = [
    { mode: 'usb', offsetHz: -4500, widthHz: 2700 },
    { mode: 'usb', offsetHz: -4500, widthHz: 2400, lowCutHz: 300 },
    { mode: 'lsb', offsetHz: -2200, widthHz: 1800 },
    { mode: 'cwu', offsetHz: 0, widthHz: 500 },
    { mode: 'cwl', offsetHz: 0, widthHz: 250, pitchHz: 600 },
    { mode: 'am', offsetHz: 2000, widthHz: 9000 },
    { mode: 'sam', offsetHz: 1950, widthHz: 9000 },
    { mode: 'ecss', offsetHz: 2040, widthHz: 4500 },
    { mode: 'ecss', offsetHz: 2000, widthHz: 3000, sideband: 'auto' },
    { mode: 'ecss', offsetHz: 2000, widthHz: 4000, sideband: 'lsb' },
    { mode: 'nfm', offsetHz: -1500, widthHz: 6000 },
];
const BACKS = [
    { agc: true, gain: 1, squelchDb: -60 },
    { agc: true, gain: 1, squelchDb: -28 },
    { agc: false, gain: 2.5, squelchDb: -60 },
];
const RATES = [
    { rate: 12000, seconds: 3.2 },
    { rate: 48000, seconds: 2.4 },
    { rate: 192000, seconds: 2.2 },
];
const label = (m) => `${m.mode} ${m.widthHz}${m.sideband ? ` ${m.sideband}` : ''}${m.lowCutHz ? ` lc${m.lowCutHz}` : ''}`;

for (const { rate, seconds } of RATES) {
    for (const m of MODES) {
        for (const back of BACKS) {
            t(`graph = DemodChain: ${label(m)} @${rate / 1000}k, agc ${back.agc} gain ${back.gain} sq ${back.squelchDb}`, () => {
                versus({ settings: { ...BASE, ...m }, back, rate, seconds, split: 'packet' });
            });
        }
    }
}
for (const rate of [12000, 192000]) {
    for (const m of [MODES[0], MODES[7], MODES[10]]) {
        t(`graph = DemodChain: ${label(m)} @${rate / 1000}k, random packet cuts`, () => {
            versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate, seconds: 2.2, split: 'random' });
        });
    }
}

// Silent until locked: the mute after the squelch, fading in on the lock.
const MUTED = { agc: true, gain: 1, squelchDb: -28, lockMute: true };
for (const { rate, seconds } of RATES.slice(0, 2)) {
    for (const m of [MODES[6], MODES[7], MODES[8]]) {
        t(`graph = DemodChain: ${label(m)} @${rate / 1000}k, mute until locked`, () => {
            versus({ settings: { ...BASE, ...m }, back: MUTED, rate, seconds, split: 'packet' });
        });
    }
}
t('graph = DemodChain: ecss @12k, mute until locked, random packet cuts', () => {
    versus({ settings: { ...BASE, ...MODES[7] }, back: MUTED, rate: 12000, seconds: 2.2, split: 'random' });
});

for (const m of [MODES[0], MODES[7]]) {
    t(`graph = DemodChain: ${label(m)} @192k, packets shorter than the decimation`, () => {
        versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate: 192000, seconds: 1.5, split: 'odd' });
    });
}

// The graph a person is given — From IQ Demod, a template, an expanded block —
// has its decimator on Auto, so it follows the IQ width. Held to the chain at
// every width, whatever width it was built at.
for (const m of MODES) {
    for (const { rate, seconds } of RATES.slice(1)) {
        t(`adaptive graph = DemodChain: ${label(m)} @${rate / 1000}k, bit for bit`, () => {
            versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate, seconds, split: 'packet', adaptive: true });
        });
    }
    t(`adaptive graph ≈ DemodChain: ${label(m)} @12k, to rounding`, () => {
        versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate: 12000, seconds: 3.2, split: 'packet', adaptive: true, close: 2e-6 });
    });
}
for (const m of [MODES[0], MODES[6], MODES[7], MODES[10]]) {
    t(`adaptive graph built at 192k, run at 12k and 48k: ${label(m)}`, () => {
        versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate: 48000, seconds: 2.4, split: 'packet', adaptive: true, builtAt: 192000 });
        versus({ settings: { ...BASE, ...m }, back: BACKS[1], rate: 12000, seconds: 3.2, split: 'packet', adaptive: true, builtAt: 192000, close: 2e-6 });
    });
}
t('adaptive graph ≈ DemodChain: ecss @12k, mute until locked, random packet cuts', () => {
    versus({ settings: { ...BASE, ...MODES[7] }, back: MUTED, rate: 12000, seconds: 2.2, split: 'random', adaptive: true, close: 2e-6 });
});

t('Decimate on Auto keeps as many samples as the width allows, down to every one', () => {
    const dec = BLOCK_BY_TYPE.decimate;
    const p = sanitizeParams(dec, {});
    assert.strictEqual(p.auto, true, 'a new decimator is not on Auto');
    const factors = [12000, 48000, 96000, 192000, 384000].map((r) => r / dec.rate(r, p));
    assert.deepStrictEqual(factors, [1, 2, 4, 8, 16]);
    // Manual still means the number given.
    assert.strictEqual(48000 / dec.rate(48000, { ...p, auto: false, factor: 3 }), 3);
});

t('a decimator saved with a factor and nothing about Auto keeps that factor', () => {
    const dec = BLOCK_BY_TYPE.decimate;
    assert.strictEqual(sanitizeParams(dec, { factor: 4 }).auto, false);
    assert.strictEqual(sanitizeParams(dec, { factor: 4, auto: true }).auto, true);
    const g = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'd', type: 'decimate', params: { factor: 4, passHz: 3000 } }], wires: [] }).graph;
    assert.strictEqual(g.nodes[0].params.auto, false);
});

t('at a factor of 1 Decimate only mixes, and its middle output says where the edges went', () => {
    const run = (rate) => {
        const g = parseGraph({
            v: GRAPH_VERSION,
            nodes: [{ id: 'iq', type: 'iq-in' }, { id: 'd', type: 'decimate', params: { auto: true, frequencyHz: 1500 } }, { id: 'p', type: 'control-plot' }],
            wires: [['iq', 'out', 'd', 'in'], ['d', 'middle', 'p', 'in']],
        }).graph;
        const rt = new Runtime(g, rate);
        assert.ok(rt.ok, rt.errors.map((e) => e.message).join('; '));
        const n = rate / 50;
        const I = new Float32Array(n);
        const Q = new Float32Array(n);
        // A tone at the centre, which should arrive at zero: DC.
        for (let k = 0; k < n; k++) { I[k] = Math.cos((2 * Math.PI * 1500 * k) / rate); Q[k] = Math.sin((2 * Math.PI * 1500 * k) / rate); }
        for (let p = 0; p < 5; p++) rt.process({ i: I, q: Q, frames: n, rate });
        return { rt, node: rt.nodes.get('d') };
    };
    const narrow = run(12000);
    assert.strictEqual(narrow.node.inst.latency(), 0, 'a factor of 1 still filters');
    const out = narrow.node.outs[0];
    assert.strictEqual(out.n, 240, 'a factor of 1 dropped samples');
    for (let k = 0; k < out.n; k++) assert.ok(Math.abs(out.re[k] - 1) < 1e-4 && Math.abs(out.im[k]) < 1e-4, `sample ${k} not at zero`);
    assert.strictEqual(narrow.rt.read('p').value, -1500);
    const wide = run(192000);
    assert.strictEqual(wide.node.outs[0].n, 3840 / 8);
    assert.strictEqual(wide.rt.read('p').value, 0, 'a filtered band is centred');
});

t('moving an adaptive graph’s decimator moves its tracker’s centre and edges with it', () => {
    const plan = planFor({ ...BASE, ...MODES[7] });
    const g = parseGraph(graphForPlan(plan, 12000, { ...BACKS[1], adaptive: true })).graph;
    const rt = new Runtime(g, 12000);
    const packet = { i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 };
    rt.process(packet);
    assert.strictEqual(rt.nodes.get('tracker').params.baseHz, plan.centreHz);
    assert.strictEqual(rt.nodes.get('tracker').params.middleHz, -plan.centreHz);
    rt.setParams('decimate', { frequencyHz: plan.centreHz + 500 });
    rt.process(packet);
    assert.deepStrictEqual(rt.driven().tracker, { baseHz: plan.centreHz + 500, middleHz: -(plan.centreHz + 500) });
    // Wide, the band is filtered and centred: only the centre carries over.
    rt.setStreamRate(192000);
    rt.process({ i: new Float32Array(3840), q: new Float32Array(3840), frames: 3840, rate: 192000 });
    assert.strictEqual(rt.nodes.get('tracker').params.middleHz, 0);
    assert.strictEqual(rt.nodes.get('tracker').params.baseHz, plan.centreHz + 500);
});

t('the comparisons reached every path that matters', () => {
    assert.ok(seen.open && seen.shut, 'the squelch did not both open and shut');
    assert.ok(seen.decimated, 'no comparison went through the decimator');
    assert.ok(seen.empty, 'no packet was too short to produce a decimated sample');
    for (const st of ['search', 'acquire', 'locked']) assert.ok(seen.states.has(st), `the tracker was never in ${st}`);
});

t('a graph survives being stored and shared, and loses nothing', () => {
    const plan = planFor({ ...BASE, ...MODES[7] });
    const g = parseGraph(graphForPlan(plan, 192000, BACKS[1])).graph;
    const text = JSON.stringify(serializeGraph(g));
    const back = parseGraph(JSON.parse(text));
    assert.deepStrictEqual(back.errors, []);
    assert.deepStrictEqual(back.graph, g);
    // Defaults are left out of the stored form, which is what keeps a link short.
    const stored = serializeGraph(g);
    const dc = stored.nodes.find((n) => n.id === 'dc');
    assert.strictEqual(dc.params, undefined, 'a block at its defaults still stored its parameters');
});

// ── every block, on its own ─────────────────────────────────────────────────

const fill = (kind, n, seed) => {
    const r = rng(seed);
    const b = makeBuffer(kind, n);
    if (kind === 'control') { b.value = 0.3; b.seq = seed; return b; }
    if (kind === 'message') return b;
    for (let k = 0; k < n; k++) {
        b.re[k] = r() - 0.5;
        if (b.im) b.im[k] = r() - 0.5;
    }
    b.n = n;
    return b;
};

for (const type of BLOCKS) {
    t(`block ${type.type}: well formed, and runs at 12k and 192k`, () => {
        assert.ok(type.label && type.category && type.summary, 'missing palette text');
        for (const p of [...type.inputs, ...type.outputs]) assert.ok(['complex', 'real', 'control', 'message', 'bits'].includes(p.kind), `port ${p.name}`);
        for (const [name, spec] of Object.entries(type.params)) {
            const ok = sanitizeParams(type, {})[name];
            assert.ok(ok === spec.default, `${name}: default ${spec.default} does not survive sanitising (${ok})`);
        }
        for (const rate of [12000, 192000]) {
            const params = sanitizeParams(type, {});
            const inst = type.create();
            const inRate = rate;
            inst.configure(params, inRate);
            for (let round = 0; round < 3; round++) {
                const n = [240, 1, 997][round];
                const ins = type.inputs.map((p, i) => fill(p.kind, n, i + 1));
                const cap = type.maxOut ? type.maxOut(n, params, inRate) : n;
                const outs = type.outputs.map((p) => makeBuffer(p.kind, cap));
                const m = inst.process(ins, outs, n, { i: ins[0] ? null : new Float32Array(n), q: new Float32Array(n), frames: n, rate });
                assert.ok(Number.isInteger(m) && m >= 0 && m <= cap, `returned ${m} frames for ${n} in, capacity ${cap}`);
                for (const o of outs) {
                    if (!o.re) continue;
                    for (let k = 0; k < m; k++) {
                        assert.ok(Number.isFinite(o.re[k]) && (!o.im || Number.isFinite(o.im[k])), `non-finite output at ${k}`);
                    }
                }
            }
            if (inst.read && type.type !== 'audio-spectrum') inst.read();
            inst.reset();
        }
    });
}

t('block types are unique', () => {
    assert.strictEqual(new Set(BLOCKS.map((b) => b.type)).size, BLOCKS.length);
});

// ── the graph rules ─────────────────────────────────────────────────────────

const node = (id, type, params = {}) => ({ id, type, params: sanitizeParams(BLOCK_BY_TYPE[type], params), x: 0, y: 0 });
const graph = (nodes, wires) => ({ v: GRAPH_VERSION, nodes, wires });
const messages = (g, rate = 12000) => compile(g, rate).errors.map((e) => e.message).join(' | ');

t('a wire must join two ports of the same kind', () => {
    const g = graph([node('a', 'iq-in'), node('b', 'gain')], [['a', 'out', 'b', 'in']]);
    assert.match(messages(g), /complex output cannot feed a real input/);
});

t('an input takes one wire, and a required one needs one', () => {
    const g = graph(
        [node('a', 'signal'), node('b', 'signal'), node('c', 'shift'), node('d', 'multiply')],
        [['a', 'out', 'c', 'in'], ['b', 'out', 'c', 'in']],
    );
    const m = messages(g);
    assert.match(m, /already has a wire/);
    assert.match(m, /Input “a” needs a wire/);
    assert.match(m, /Input “b” needs a wire/);
});

t('an optional input may be left unconnected', () => {
    const g = graph(
        [node('s', 'signal'), node('e', 'envelope'), node('agc', 'agc'), node('o', 'audio-out')],
        [['s', 'out', 'e', 'in'], ['e', 'out', 'agc', 'in'], ['agc', 'out', 'o', 'in']],
    );
    assert.strictEqual(messages(g), '');
});

t('a loop is refused, and every block in it is named', () => {
    const g = graph(
        [node('s', 'signal'), node('e', 'envelope'), node('x', 'add'), node('y', 'gain')],
        [['s', 'out', 'e', 'in'], ['e', 'out', 'x', 'a'], ['x', 'out', 'y', 'in'], ['y', 'out', 'x', 'b']],
    );
    const errs = compile(g, 12000).errors.filter((e) => /loop/.test(e.message)).map((e) => e.node).sort();
    assert.deepStrictEqual(errs, ['x', 'y']);
});

t('inputs at different rates are refused, and rates follow decimators', () => {
    const g = graph(
        [node('s', 'iq-in'), node('d', 'decimate', { factor: 4 }), node('a', 'real-part'), node('b', 'real-part'), node('x', 'add')],
        [['s', 'out', 'd', 'in'], ['d', 'out', 'a', 'in'], ['s', 'out', 'b', 'in'], ['a', 'out', 'x', 'a'], ['b', 'out', 'x', 'b']],
    );
    const c = compile(g, 48000);
    assert.strictEqual(c.outRate.d, 12000);
    assert.strictEqual(c.inRate.a, 12000);
    assert.strictEqual(c.inRate.b, 48000);
    assert.match(c.errors.map((e) => e.message).join(), /different rates/);
});

t('a stored graph is read defensively', () => {
    assert.match(parseGraph({ v: GRAPH_VERSION + 1, nodes: [] }).errors[0].message, /newer version/);
    assert.match(parseGraph('nonsense').errors[0].message, /Not a graph/);
    const r = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'a', type: 'signal', params: { amplitude: 7, frequencyHz: 'x' } },
            { id: 'b', type: 'no-such-block' },
            { id: 'a', type: 'gain' },
            { type: 'gain' },
        ],
        wires: [['a', 'out', 'b', 'in'], ['a', 'out'], 'junk'],
    });
    assert.strictEqual(r.graph.nodes.length, 1);
    assert.strictEqual(r.graph.nodes[0].params.amplitude, 1, 'an out-of-range parameter was not clamped');
    assert.strictEqual(r.graph.nodes[0].params.frequencyHz, 1000, 'a nonsense parameter did not fall back to its default');
    assert.strictEqual(r.graph.wires.length, 0);
    assert.strictEqual(r.errors.length, 6);
});

// ── the runtime ─────────────────────────────────────────────────────────────

/** Run a graph over a scene in random packets; collect one audio-out's samples. */
function collect(g, sink, rate = 48000, seconds = 1) {
    const rt = new Runtime(parseGraph(g).graph, rate);
    assert.ok(rt.ok, rt.errors.map((e) => e.message).join('; '));
    const { I, Q, n } = scene(rate, seconds, 3);
    const next = SPLITS.random();
    const got = [];
    for (let at = 0; at < n;) {
        const len = Math.min(next(), n - at);
        rt.process({ i: I.subarray(at, at + len), q: Q.subarray(at, at + len), frames: len, rate });
        const a = rt.read(sink);
        for (let k = 0; k < a.frames; k++) got.push(a.samples[k]);
        at += len;
    }
    return Float32Array.from(got);
}

t('inputs that arrive out of step are lined up, and nothing is lost', () => {
    // Two routes to 12 kHz from 48: one decimator of 4, and two of 2. Same
    // rate, but they hand over different numbers of samples per packet.
    const paths = {
        nodes: [
            { id: 'iq', type: 'iq-in' },
            { id: 'd4', type: 'decimate', params: { factor: 4, passHz: 3000 } },
            { id: 'd2a', type: 'decimate', params: { factor: 2, passHz: 3000 } },
            { id: 'd2b', type: 'decimate', params: { factor: 2, passHz: 3000 } },
            { id: 'ra', type: 'real-part' },
            { id: 'rb', type: 'real-part' },
        ],
        wires: [['iq', 'out', 'd4', 'in'], ['iq', 'out', 'd2a', 'in'], ['d2a', 'out', 'd2b', 'in'], ['d4', 'out', 'ra', 'in'], ['d2b', 'out', 'rb', 'in']],
    };
    const only = (from, id) => ({
        v: GRAPH_VERSION,
        nodes: [...paths.nodes, { id, type: 'audio-out' }],
        wires: [...paths.wires, [from, 'out', id, 'in']],
    });
    const a = collect(only('ra', 'oa'), 'oa');
    const b = collect(only('rb', 'ob'), 'ob');
    const sum = collect({
        v: GRAPH_VERSION,
        nodes: [...paths.nodes, { id: 'x', type: 'add' }, { id: 'o', type: 'audio-out' }],
        wires: [...paths.wires, ['ra', 'out', 'x', 'a'], ['rb', 'out', 'x', 'b'], ['x', 'out', 'o', 'in']],
    }, 'o');
    assert.strictEqual(sum.length, Math.min(a.length, b.length));
    for (let k = 0; k < sum.length; k++) {
        if (!Object.is(sum[k], Math.fround(a[k] + b[k]))) assert.fail(`sample ${k}: ${sum[k]} vs ${a[k]} + ${b[k]}`);
    }
});

t('a parameter changed while running takes effect without a rebuild', () => {
    const g = parseGraph({
        v: GRAPH_VERSION,
        nodes: [{ id: 's', type: 'signal', params: { frequencyHz: 1000, amplitude: 0.5 } }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        wires: [['s', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    }).graph;
    const rt = new Runtime(g, 12000);
    const tone = (hz) => {
        const out = [];
        for (let p = 0; p < 50; p++) {
            rt.process({ i: null, q: null, frames: 240, rate: 12000 });
            out.push(...rt.read('o').samples);
        }
        // Correlate against the expected tone.
        let c = 0;
        let s = 0;
        for (let k = 0; k < out.length; k++) {
            c += out[k] * Math.cos((2 * Math.PI * hz * k) / 12000);
            s += out[k] * Math.sin((2 * Math.PI * hz * k) / 12000);
        }
        return Math.hypot(c, s) / out.length;
    };
    const plan = rt.plan;
    assert.ok(tone(1000) > 0.2, 'the generator was not heard at 1 kHz');
    rt.setParams('s', { frequencyHz: 2500 });
    assert.strictEqual(rt.plan, plan, 'a live parameter rebuilt the graph');
    assert.ok(tone(2500) > 0.2, 'the new frequency was not heard');
    assert.ok(tone(1000) < 0.01, 'the old frequency was still there');
});

// The generator's output, `frames` of it at 48 kHz.
const generate = (params, frames = 4800) => {
    const g = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 's', type: 'signal', params }], wires: [] }).graph;
    const inst = BLOCK_BY_TYPE.signal.create();
    inst.configure(g.nodes[0].params, 48000);
    const out = { re: new Float64Array(frames), im: new Float64Array(frames) };
    inst.process([], [out], frames);
    return out;
};
// How strongly a stream holds e^{j2πft}, as an amplitude.
const line = (out, hz) => {
    let r = 0;
    let i = 0;
    for (let k = 0; k < out.re.length; k++) {
        const ph = (-2 * Math.PI * hz * k) / 48000;
        r += out.re[k] * Math.cos(ph) - out.im[k] * Math.sin(ph);
        i += out.re[k] * Math.sin(ph) + out.im[k] * Math.cos(ph);
    }
    return Math.hypot(r, i) / out.re.length;
};

t('a generator’s shaped tones are analytic, with each shape’s harmonics', () => {
    const sq = generate({ waveform: 'square', frequencyHz: 1000, amplitude: 1 });
    assert.ok(Math.abs(line(sq, 1000) - 4 / Math.PI) < 1e-6, 'square fundamental');
    assert.ok(Math.abs(line(sq, 3000) - 4 / (3 * Math.PI)) < 1e-6, 'square third');
    assert.ok(line(sq, 2000) < 1e-9, 'a square has no even harmonics');
    const tri = generate({ waveform: 'triangle', frequencyHz: 1000, amplitude: 1 });
    assert.ok(Math.abs(line(tri, 3000) - 8 / (9 * Math.PI * Math.PI)) < 1e-6, 'triangle third');
    const saw = generate({ waveform: 'sawtooth', frequencyHz: 1000, amplitude: 1 });
    assert.ok(Math.abs(line(saw, 2000) - 1 / Math.PI) < 1e-6, 'a sawtooth has every harmonic');
    for (const out of [sq, tri, saw]) {
        for (const hz of [-1000, -3000]) assert.ok(line(out, hz) < 1e-9, `energy mirrored to ${hz} Hz`);
    }
    // Nothing above Nyquist, where it would fold back.
    const high = generate({ waveform: 'square', frequencyHz: 9000, amplitude: 1 });
    assert.ok(line(high, 27000 - 48000) < 1e-9, 'the third harmonic of 9 kHz aliased');
});

t('a generator’s second tone is there only when switched on', () => {
    const one = generate({ frequencyHz: 1000, amplitude: 0.5, frequency2Hz: -2000, amplitude2: 0.25 });
    assert.ok(line(one, -2000) < 1e-9);
    const two = generate({ frequencyHz: 1000, amplitude: 0.5, tone2: true, frequency2Hz: -2000, amplitude2: 0.25 });
    assert.ok(Math.abs(line(two, 1000) - 0.5) < 1e-6);
    assert.ok(Math.abs(line(two, -2000) - 0.25) < 1e-6);
});

t('a parameter that moves a rate rebuilds, and downstream follows', () => {
    const g = parseGraph({
        v: GRAPH_VERSION,
        nodes: [{ id: 'iq', type: 'iq-in' }, { id: 'd', type: 'decimate', params: { factor: 2 } }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        wires: [['iq', 'out', 'd', 'in'], ['d', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    }).graph;
    const rt = new Runtime(g, 96000);
    rt.process({ i: new Float32Array(960), q: new Float32Array(960), frames: 960, rate: 96000 });
    assert.strictEqual(rt.read('o').rate, 48000);
    rt.setParams('d', { factor: 8 });
    rt.process({ i: new Float32Array(960), q: new Float32Array(960), frames: 960, rate: 96000 });
    assert.strictEqual(rt.read('o').rate, 12000);
    assert.ok(Math.abs(rt.read('o').frames - 120) <= 1, `${rt.read('o').frames} frames from 960 at a factor of 8`);
});

t('a new stream rate reconfigures every block', () => {
    const plan = planFor({ ...BASE, ...MODES[0] });
    const rt = new Runtime(graphForPlan(plan, 12000), 12000);
    rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
    assert.strictEqual(rt.read('audio').rate, 12000);
    rt.process({ i: new Float32Array(480), q: new Float32Array(480), frames: 480, rate: 24000 });
    assert.strictEqual(rt.read('audio').rate, 24000);
});

t('every running block’s level in and out, in dBFS, measured only when asked for', () => {
    const graph = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'sig', type: 'signal', params: { amplitude: 0.5, frequencyHz: 1000 } },
            { id: 're', type: 'real-part' },
            { id: 'half', type: 'gain', params: { gain: 0.5 } },
            { id: 'out', type: 'audio-out' },
            // Not wired: blocked, so nothing to say about it.
            { id: 'lone', type: 'lsa' },
        ],
        wires: [['sig', 'out', 're', 'in'], ['re', 'out', 'half', 'in'], ['half', 'out', 'out', 'in']],
    }).graph;
    const rt = new Runtime(graph, 12000);
    rt.process({ i: null, q: null, frames: 2400, rate: 12000 });
    assert.deepStrictEqual(rt.levels(), {}, 'measured without being asked');
    rt.measureLevels = true;
    rt.process({ i: null, q: null, frames: 2400, rate: 12000 });
    const lv = rt.levels();
    const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.05, `${what}: ${a} against ${b}`);
    // A complex tone of 0.5: |x|² is 0.25 throughout. Its real part is half that.
    near(lv.sig.out, 10 * Math.log10(0.25), 'signal out');
    assert.strictEqual(lv.sig.in, null, 'a source has no level in');
    near(lv.re.in, 10 * Math.log10(0.25), 'real part in');
    near(lv.re.out, 10 * Math.log10(0.125), 'real part out');
    near(lv.half.out - lv.half.in, 20 * Math.log10(0.5), 'the gain block’s change');
    near(lv.out.in, lv.half.out, 'Audio out hears what the gain puts out');
    assert.strictEqual(lv.out.out, null, 'a sink has no level out');
    assert.ok(!('lone' in lv), 'a blocked block has a level');
});

t('activity: a console counts the characters it is sent, and a Morse decoder lights while the key is down', () => {
    const graph = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'tx', type: 'data-tx', params: { mode: 'cw', offsetHz: 1000, wpm: 20, gapSec: 2 } },
            { id: 'shift', type: 'shift', params: { frequencyHz: -1000 } },
            { id: 'ook', type: 'ook-detector' },
            { id: 'morse', type: 'morse-decoder', params: { wpm: 20 } },
            { id: 'console', type: 'console' },
        ],
        wires: [['tx', 'out', 'shift', 'in'], ['shift', 'out', 'ook', 'in'], ['ook', 'key', 'morse', 'key'], ['morse', 'text', 'console', 'in']],
    }).graph;
    const rt = new Runtime(graph, 12000);
    rt.measureLevels = true;
    let chars = 0;
    let keyedReads = 0;
    let quietReads = 0;
    let printed = 0;
    // Read as the worker does, every 80 ms: four 20 ms packets.
    for (let p = 0; p < 50 * 8; p++) {
        rt.process({ i: null, q: null, frames: 240, rate: 12000 });
        if (p % 4 !== 3) continue;
        const lv = rt.levels();
        chars += lv.console.act;
        if (lv.morse.act) keyedReads++; else quietReads++;
        assert.ok(!('act' in lv.tx) || lv.tx.act === 0, 'a block with no messages in has activity');
    }
    printed = rt.read('console').count;
    assert.ok(printed >= 5, `only ${printed} characters decoded`);
    assert.strictEqual(chars, printed, 'the console’s activity is not its characters');
    // Morse at 20 wpm is about half key-down; with the gaps, some of each.
    assert.ok(keyedReads > 10 && quietReads > 5, `key down in ${keyedReads} reads, up in ${quietReads}`);
    // Counted since the last asking: asked again at once, nothing new.
    assert.strictEqual(rt.levels().console.act, 0);
});

t('audio over full scale is counted where it is, with its peak; IQ and audio under it are not', () => {
    const graph = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'sig', type: 'signal', params: { amplitude: 0.5, frequencyHz: 1000 } },
            { id: 're', type: 'real-part' },
            { id: 'loud', type: 'gain', params: { gain: 4 } },
            { id: 'out', type: 'audio-out' },
        ],
        wires: [['sig', 'out', 're', 'in'], ['re', 'out', 'loud', 'in'], ['loud', 'out', 'out', 'in']],
    }).graph;
    const rt = new Runtime(graph, 12000);
    rt.measureLevels = true;
    rt.process({ i: null, q: null, frames: 2400, rate: 12000 });
    const lv = rt.levels();
    assert.ok(!('clip' in lv.sig), 'IQ with no audio watched for clipping');
    assert.strictEqual(lv.re.clip, 0, 'a 0.5 tone clipped');
    assert.ok(Math.abs(lv.re.peak - 20 * Math.log10(0.5)) < 0.05, `peak ${lv.re.peak}`);
    // Four times 0.5 is twice full scale: over it for a third of every cycle.
    assert.ok(lv.loud.clip > 2400 / 4, `${lv.loud.clip} samples over full scale`);
    assert.ok(Math.abs(lv.loud.peak - 20 * Math.log10(2)) < 0.05, `peak ${lv.loud.peak}`);
    assert.strictEqual(lv.out.clip, lv.loud.clip, 'Audio out does not see what it is sent');
    // Counted since the last asking.
    assert.strictEqual(rt.levels().loud.clip, 0);
});

t('a graph that does not compile does nothing, and says why', () => {
    const rt = new Runtime(parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'g', type: 'gain' }], wires: [] }).graph, 12000);
    assert.strictEqual(rt.ok, false);
    assert.strictEqual(rt.process({ i: null, q: null, frames: 240, rate: 12000 }), false);
    assert.match(rt.errors[0].message, /needs a wire/);
});

console.log(`\n${pass} passed`);
