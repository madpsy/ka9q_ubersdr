// The playground's instruments, and the probes that attach them.
//
// An instrument that draws a plausible picture of the wrong thing is worse
// than none, so each is fed something whose picture is known and checked for
// it: a tone in the right bin at the right level, a scope that triggers on the
// edge it was told to and measures the amplitude and frequency it was given, a
// single sweep that catches the first event after arming and then holds still,
// a constellation that is a circle of the tone's radius.

const assert = require('assert');
const {
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, GRAPH_VERSION, parseGraph, compile, Runtime, createWorkerCore,
    PROBES, acrossPair, addAcross, addProbe, frequencyOrigins, inputOrigin, nodeHeight, nodeWidth,
} = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;

function block(type, params = {}, rate = RATE) {
    const def = BLOCK_BY_TYPE[type];
    const inst = def.create();
    const p = sanitizeParams(def, params);
    inst.configure(p, rate);
    return { def, inst, p };
}

/** Feed real samples into input 0 (and 1), in packets. */
function feedReal(b, a, bb = null, packet = 240) {
    for (let at = 0; at < a.length; at += packet) {
        const n = Math.min(packet, a.length - at);
        const ia = makeBuffer('real', n);
        ia.re.set(a.subarray(at, at + n));
        ia.n = n;
        let ib = null;
        if (bb) {
            ib = makeBuffer('real', n);
            ib.re.set(bb.subarray(at, at + n));
            ib.n = n;
        }
        b.inst.process([ia, ib], [], n);
    }
}

function feedComplex(b, I, Q, packet = 240) {
    for (let at = 0; at < I.length; at += packet) {
        const n = Math.min(packet, I.length - at);
        const x = makeBuffer('complex', n);
        x.re.set(I.subarray(at, at + n));
        x.im.set(Q.subarray(at, at + n));
        x.n = n;
        b.inst.process([x], [], n);
    }
}

const sine = (n, hz, amp = 1, dc = 0, phase = 0) => Float64Array.from({ length: n }, (_, k) => dc + amp * Math.sin((2 * Math.PI * hz * k) / RATE + phase));

// ── IQ spectrum ─────────────────────────────────────────────────────────────

t('the IQ spectrum puts a tone in its bin, on its side of zero, at its level', () => {
    for (const hz of [1500, -2250]) {
        const b = block('iq-spectrum', { size: 1024 });
        const n = 4096;
        const I = Float64Array.from({ length: n }, (_, k) => 0.5 * Math.cos((2 * Math.PI * hz * k) / RATE));
        const Q = Float64Array.from({ length: n }, (_, k) => 0.5 * Math.sin((2 * Math.PI * hz * k) / RATE));
        feedComplex(b, I, Q);
        const r = b.inst.read();
        assert.strictEqual(r.sided, 2);
        let best = 0;
        for (let k = 1; k < r.db.length; k++) if (r.db[k] > r.db[best]) best = k;
        const want = Math.round((hz / RATE + 0.5) * 1024);
        assert.ok(Math.abs(best - want) <= 1, `${hz} Hz: peak in bin ${best}, wanted ${want}`);
        assert.ok(Math.abs(r.db[best] + 6.02) < 1.5, `${hz} Hz at half scale read ${r.db[best].toFixed(1)} dBFS`);
    }
});

t('the IQ spectrum says nothing until it has a full transform’s worth', () => {
    const b = block('iq-spectrum', { size: 2048 });
    feedComplex(b, new Float64Array(1000), new Float64Array(1000));
    assert.strictEqual(b.inst.read(), null);
});

t('the audio spectrum is one-sided, and offers a waterfall', () => {
    const b = block('audio-spectrum');
    feedReal(b, sine(2048, 1000, 0.5));
    const r = b.inst.read();
    assert.strictEqual(r.sided, 1);
    assert.strictEqual(r.rate, RATE);
    assert.deepStrictEqual(BLOCK_BY_TYPE['audio-spectrum'].params.display.options.map((o) => o.value), ['spectrum', 'waterfall', 'both']);
});

// ── oscilloscope ────────────────────────────────────────────────────────────

/** The value a sweep shows at column k (min and max agree when a column is one sample). */
const col = (ch, k) => (ch.min[k] + ch.max[k]) / 2;

t('the scope triggers on the slope it is told, at the position it is told', () => {
    for (const slope of ['rising', 'falling']) {
        const b = block('scope', { timebaseMs: 5, position: 10, slope, level: 0 });
        feedReal(b, sine(4800, 1000, 0.8, 0, 0.3));
        const r = b.inst.read();
        assert.ok(r.triggered, `${slope}: did not trigger`);
        const pre = Math.round(0.1 * 60);
        const before = col(r.a, pre - 1);
        const at = col(r.a, pre);
        if (slope === 'rising') assert.ok(before < 0 && at >= 0, `rising: ${before} then ${at}`);
        else assert.ok(before > 0 && at <= 0, `falling: ${before} then ${at}`);
    }
});

t('the scope measures peak-to-peak, RMS and frequency off the sweep', () => {
    const b = block('scope', { timebaseMs: 20 });
    feedReal(b, sine(4800, 750, 0.6));
    const r = b.inst.read();
    assert.ok(Math.abs(r.a.vpp - 1.2) < 0.02, `p-p ${r.a.vpp}`);
    assert.ok(Math.abs(r.a.rms - 0.6 / Math.SQRT2) < 0.02, `RMS ${r.a.rms}`);
    assert.ok(Math.abs(r.a.hz - 750) < 5, `frequency ${r.a.hz}`);
});

t('AC coupling takes the DC off the trace and the RMS', () => {
    const b = block('scope', { timebaseMs: 20, coupling: 'ac', level: 0.5 });
    feedReal(b, sine(4800, 1000, 0.2, 0.5));
    const r = b.inst.read();
    let sum = 0;
    for (let k = 0; k < r.a.max.length; k++) sum += col(r.a, k);
    assert.ok(Math.abs(sum / r.a.max.length) < 0.02, 'the trace still sits on its DC');
    assert.ok(Math.abs(r.a.rms - 0.2 / Math.SQRT2) < 0.02, `RMS with DC removed ${r.a.rms}`);
    assert.ok(Math.abs(r.a.mean - 0.5) < 0.01, 'the mean is still reported');
});

t('auto free-runs on silence; normal waits, then holds the last trigger', () => {
    const auto = block('scope', { timebaseMs: 5, mode: 'auto', level: 0.5 });
    feedReal(auto, new Float64Array(4800));
    const ra = auto.inst.read();
    assert.ok(ra.a && !ra.triggered, 'auto did not free-run on silence');

    const normal = block('scope', { timebaseMs: 5, mode: 'normal', level: 0.5 });
    feedReal(normal, new Float64Array(4800));
    assert.ok(!normal.inst.read().a, 'normal drew without a trigger');
    feedReal(normal, sine(2400, 500, 0.9));
    const hit = normal.inst.read();
    assert.ok(hit.triggered);
    // The next look may still find a trigger in the tone's last moments — one
    // that had no whole sweep after it until the silence arrived. After that,
    // nothing new: normal holds the last sweep rather than going blank.
    feedReal(normal, new Float64Array(4800));
    const last = normal.inst.read();
    feedReal(normal, new Float64Array(4800));
    const after = normal.inst.read();
    assert.ok(after.stale && after.a, 'normal did not hold its last sweep');
    assert.strictEqual(after.a.vpp, last.a.vpp, 'the held sweep is not the last one that triggered');
});

t('single catches the first trigger after arming, then holds it until run', () => {
    const b = block('scope', { timebaseMs: 5, mode: 'single', level: 0.1 });
    feedReal(b, sine(2400, 500, 0.9));
    b.inst.command('arm');
    assert.strictEqual(b.inst.read().state, 'armed');
    // Two events before the next look: a small one, then a large one. The
    // capture is the first.
    const quiet = new Float64Array(600);
    const small = sine(600, 500, 0.3);
    const large = sine(600, 500, 0.95);
    const seq = new Float64Array(3000);
    seq.set(quiet, 0);
    seq.set(small, 600);
    seq.set(quiet, 1200);
    seq.set(large, 1800);
    feedReal(b, seq);
    const r = b.inst.read();
    assert.strictEqual(r.state, 'held');
    assert.ok(r.triggered);
    assert.ok(r.a.vpp < 0.7, `caught ${r.a.vpp.toFixed(2)} p-p — the later, larger event`);
    feedReal(b, sine(4800, 2000, 0.5));
    assert.strictEqual(b.inst.read().a.vpp, r.a.vpp, 'the held capture changed');
    b.inst.command('run');
    assert.strictEqual(b.inst.read().state, 'running');
});

t('stop freezes the screen, and run lets it go', () => {
    const b = block('scope', { timebaseMs: 5 });
    feedReal(b, sine(2400, 500, 0.5));
    const before = b.inst.read();
    b.inst.command('stop');
    feedReal(b, sine(2400, 500, 0.9));
    const frozen = b.inst.read();
    assert.strictEqual(frozen.state, 'stopped');
    assert.strictEqual(frozen.a.vpp, before.a.vpp);
    b.inst.command('run');
    feedReal(b, sine(2400, 500, 0.9));
    assert.ok(Math.abs(b.inst.read().a.vpp - 1.8) < 0.05);
});

t('a long sweep is sent as columns of min and max, so a spike is not lost', () => {
    const b = block('scope', { timebaseMs: 500, mode: 'auto', level: 2 });
    const x = new Float64Array(12000);
    x[9000] = 0.9;
    feedReal(b, x);
    const r = b.inst.read();
    assert.ok(r.a.max.length <= 1024);
    assert.ok(Math.max(...r.a.max) > 0.89, 'the one-sample spike vanished');
});

t('the scope draws a second trace from its b input, and can trigger on it', () => {
    const b = block('scope', { timebaseMs: 5, source: 'b', level: 0 });
    feedReal(b, new Float64Array(4800), sine(4800, 1000, 0.5));
    const r = b.inst.read();
    assert.ok(r.b, 'no second trace');
    assert.ok(r.triggered, 'did not trigger on B');
});

t('the scope takes four channels, each where it is wired, and triggers on any', () => {
    const b = block('scope', { timebaseMs: 5, source: 'd', level: 0 });
    const n = 240;
    for (let at = 0; at < 4800; at += n) {
        const buf = (fn) => { const x = makeBuffer('real', n); for (let k = 0; k < n; k++) x.re[k] = fn(at + k); x.n = n; return x; };
        b.inst.process([buf(() => 0.1), null, buf(() => -0.2), buf((k) => 0.5 * Math.sin((2 * Math.PI * 1000 * k) / RATE))], [], n);
    }
    const r = b.inst.read();
    assert.ok(r.a && !r.b && r.c && r.d, `channels: ${['a', 'b', 'c', 'd'].filter((c) => r[c]).join(',')}`);
    assert.ok(Math.abs(r.c.mean + 0.2) < 1e-6);
    assert.ok(r.triggered, 'did not trigger on D');
});

// A key level at 250 Hz beside a signal at 1 kHz: the slower channel is held
// between its samples, so each of its values spans four of the faster's —
// lined up in time, not squashed into the first quarter of the sweep.
t('the scope lines up channels at different rates in time', () => {
    const def = BLOCK_BY_TYPE.scope;
    const inst = def.create();
    inst.configure(sanitizeParams(def, { timebaseMs: 400, position: 0, mode: 'auto' }), 1000, [1000, 250]);
    // Packets of 100 ms: 100 samples of A, 25 of B — B counting up.
    let next = 0;
    for (let p = 0; p < 20; p++) {
        const a = makeBuffer('real', 100);
        a.n = 100;
        const bb = makeBuffer('real', 25);
        for (let k = 0; k < 25; k++) bb.re[k] = next++;
        bb.n = 25;
        inst.process([a, bb], [], 100);
    }
    const r = inst.read();
    assert.ok(r.b, 'no B');
    // Free-running: the latest 400 samples of A, so the latest 100 of B.
    const cols = r.b.max.length;
    assert.strictEqual(cols, 400);
    const changes = [];
    for (let k = 0; k < cols; k++) {
        assert.strictEqual(r.b.max[k], r.b.min[k]);
        if (k > 0 && r.b.max[k] !== r.b.max[k - 1]) changes.push(k);
    }
    // Every step of B the same four samples of A long.
    for (let i = 1; i < changes.length; i++) assert.strictEqual(changes[i] - changes[i - 1], 4, `B held ${changes[i] - changes[i - 1]} samples at ${changes[i]}`);
    const steps = new Set(Array.from(r.b.max));
    assert.ok(steps.size >= 99 && steps.size <= 101, `B took ${steps.size} values over 400 ms, not 100`);
    assert.strictEqual(r.b.max[cols - 1], next - 1, 'B is behind A');
});

t('a scope compiles with inputs at different rates; any other block still refuses them', () => {
    const graph = (sink) => parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'sig', type: 'signal' },
            { id: 're', type: 'real-part' },
            { id: 'ook', type: 'ook-detector' },
            sink,
        ],
        wires: [['sig', 'out', 'ook', 'in'], ['sig', 'out', 're', 'in'], ['ook', 'key', sink.id, 'a'], ['re', 'out', sink.id, 'b']],
    }).graph;
    const ok = compile(graph({ id: 'sc', type: 'scope' }), RATE);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.inRate.sc, ok.outRate.re, 'the scope did not run at its fastest input');
    assert.ok(ok.inRates.sc[0] < ok.inRates.sc[1], `rates ${ok.inRates.sc}`);
    const no = compile(graph({ id: 'ph', type: 'phase-meter' }), RATE);
    assert.ok(no.errors.some((e) => /different rates/.test(e.message)), 'a phase meter took two rates');
});

t('each scope channel has a colour of its own to pick', () => {
    const def = BLOCK_BY_TYPE.scope;
    const p = sanitizeParams(def, {});
    assert.deepStrictEqual([p.colourA, p.colourB, p.colourC, p.colourD], ['blue', 'violet', 'green', 'pink']);
    assert.strictEqual(sanitizeParams(def, { colourC: 'orange' }).colourC, 'orange');
    assert.strictEqual(sanitizeParams(def, { colourC: 'nonsense' }).colourC, 'green');
});

t('the scope reports what it measures every interval: a message of everything, and the picked measure on each channel\'s control', () => {
    const def = BLOCK_BY_TYPE.scope;
    const inst = def.create();
    inst.configure(sanitizeParams(def, { reportMs: 100, measure: 'vpp' }), RATE, [RATE, null, RATE]);
    const outs = def.outputs.map((p) => makeBuffer(p.kind, 0));
    const got = [];
    const n = 240;
    for (let at = 0; at < RATE; at += n) {
        outs[0].list = [];
        const a = makeBuffer('real', n);
        const c = makeBuffer('real', n);
        for (let k = 0; k < n; k++) {
            a.re[k] = 0.5 * Math.sin((2 * Math.PI * 1000 * (at + k)) / RATE);
            c.re[k] = 0.25;
        }
        a.n = n;
        c.n = n;
        inst.process([a, null, c, null], outs, n);
        got.push(...outs[0].list);
    }
    // A second at one report every 100 ms.
    assert.ok(got.length >= 9 && got.length <= 11, `${got.length} reports`);
    const last = got[got.length - 1];
    assert.strictEqual(last.type, 'measure');
    assert.ok(last.a && !last.b && last.c && !last.d);
    assert.ok(Math.abs(last.a.vpp - 1) < 0.01, `A p-p ${last.a.vpp}`);
    assert.ok(Math.abs(last.a.hz - 1000) < 5, `A ${last.a.hz} Hz`);
    assert.ok(Math.abs(last.c.mean - 0.25) < 1e-6);
    assert.ok(Math.abs(outs[1].value - 1) < 0.01, `a-out ${outs[1].value}`);
    assert.strictEqual(outs[3].value, 0, 'c-out should carry C\'s p-p, which is nothing');
    assert.strictEqual(outs[2].seq, 0, 'an unwired channel reported');
});

t('a message log keeps every message for Copy and Save, not only the ones on screen', () => {
    const def = BLOCK_BY_TYPE['message-log'];
    const inst = def.create();
    inst.configure({}, RATE);
    const input = makeBuffer('message', 0);
    input.list = Array.from({ length: 300 }, (_, k) => ({ type: 'text', text: String(k) }));
    inst.process([input], [], 0);
    const r = inst.read();
    assert.strictEqual(r.lines.length, 300);
    assert.strictEqual(r.lines[0].text, '299', 'newest first');
});

// ── constellation ───────────────────────────────────────────────────────────

t('a constellation of a tone is a circle of its amplitude, oldest first', () => {
    const b = block('constellation', { points: 256, normalise: false });
    const n = 2000;
    const hz = 300;
    const I = Float64Array.from({ length: n }, (_, k) => 0.4 * Math.cos((2 * Math.PI * hz * k) / RATE));
    const Q = Float64Array.from({ length: n }, (_, k) => 0.4 * Math.sin((2 * Math.PI * hz * k) / RATE));
    feedComplex(b, I, Q);
    const r = b.inst.read();
    assert.strictEqual(r.i.length, 256);
    for (let k = 0; k < 256; k++) assert.ok(Math.abs(Math.hypot(r.i[k], r.q[k]) - 0.4) < 1e-5);
    // The last point is the last sample.
    assert.ok(Math.abs(r.i[255] - I[n - 1]) < 1e-6 && Math.abs(r.q[255] - Q[n - 1]) < 1e-6);
    assert.strictEqual(r.scale, 1);
    const norm = block('constellation', { points: 256 });
    feedComplex(norm, I, Q);
    assert.ok(Math.abs(norm.inst.read().scale - 2.5) < 1e-4, 'scale to fit did not fit');
});

t('“take every” spreads the constellation’s points over more time', () => {
    const b = block('constellation', { points: 128, every: 4 });
    const n = 4000;
    const w = (2 * Math.PI * 100) / RATE;
    feedComplex(b, Float64Array.from({ length: n }, (_, k) => Math.cos(w * k)), Float64Array.from({ length: n }, (_, k) => Math.sin(w * k)));
    const r = b.inst.read();
    const step = Math.atan2(r.q[11], r.i[11]) - Math.atan2(r.q[10], r.i[10]);
    assert.ok(Math.abs(step - 4 * w) < 1e-4, `points ${step} rad apart, wanted ${4 * w}`);
});

// ── probes ──────────────────────────────────────────────────────────────────

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

t('a probe hangs the right instrument off an output, and the path is unchanged', () => {
    let g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass', x: 300 }, { id: 'a', type: 'to-audio', x: 600 }, { id: 'o', type: 'audio-out', x: 900 }],
        [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in'], ['a', 'out', 'o', 'in']],
    );
    const before = g.wires.map((w) => w.join('.'));
    const spec = addProbe(g, 'lp', 'out', 'iq-spectrum');
    assert.ok(spec.id);
    assert.ok(spec.graph.wires.some((w) => w.join('.') === `lp.out.${spec.id}.in`));
    for (const w of before) assert.ok(spec.graph.wires.some((x) => x.join('.') === w), `${w} was disturbed`);
    g = spec.graph;
    const scope = addProbe(g, 'a', 'out', 'scope');
    assert.ok(scope.graph.wires.some((w) => w.join('.') === `a.out.${scope.id}.a`));
    assert.ok(compile(scope.graph, RATE).ok);
    // The wrong kind of instrument is refused.
    assert.strictEqual(addProbe(g, 'lp', 'out', 'scope').id, null);
    // A second probe on one output goes below the first.
    const two = addProbe(g, 'lp', 'out', 'constellation');
    const first = two.graph.nodes.find((n) => n.id === spec.id);
    const second = two.graph.nodes.find((n) => n.id === two.id);
    assert.ok(second.y >= first.y + nodeHeight(first.type, first.params), 'the second probe sits on the first');
    for (const [kind, list] of Object.entries(PROBES)) {
        for (const p of list) assert.ok(BLOCK_BY_TYPE[p.type].inputs.some((i) => i.kind === kind), `${p.type} cannot take ${kind}`);
    }
});

t('a probe changes nothing the rest of the graph puts out', () => {
    let g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass' }, { id: 'a', type: 'to-audio', params: { frequencyHz: 1350 } }, { id: 'o', type: 'audio-out' }],
        [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in'], ['a', 'out', 'o', 'in']],
    );
    const run = (gr) => {
        const rt = new Runtime(gr, RATE);
        const out = [];
        const I = new Float32Array(2400).map((_, k) => Math.sin(k / 3));
        const Q = new Float32Array(2400).map((_, k) => Math.cos(k / 5));
        for (let at = 0; at < 2400; at += 240) {
            rt.process({ i: I.subarray(at, at + 240), q: Q.subarray(at, at + 240), frames: 240, rate: RATE });
            out.push(...rt.read('o').samples);
        }
        return out;
    };
    const plain = run(g);
    for (const [from, type] of [['iq', 'iq-spectrum'], ['lp', 'constellation'], ['a', 'scope'], ['a', 'audio-spectrum']]) {
        g = addProbe(g, from, from === 'a' ? 'out' : 'out', type).graph;
    }
    assert.deepStrictEqual(run(g), plain);
});

t('a complex wire knows its frequencies through shifts and decimators, and not past a conjugate', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'sh', type: 'shift', params: { frequencyHz: -1500 } },
            { id: 'lp', type: 'lowpass' },
            { id: 'dec', type: 'decimate', params: { factor: 2, frequencyHz: 400 } },
            { id: 'cj', type: 'conjugate' },
            { id: 'gen', type: 'signal' },
            { id: 'v1', type: 'iq-spectrum' }, { id: 'v2', type: 'iq-spectrum' }, { id: 'v3', type: 'iq-spectrum' },
        ],
        [
            ['iq', 'out', 'sh', 'in'], ['sh', 'out', 'lp', 'in'], ['lp', 'out', 'dec', 'in'], ['dec', 'out', 'cj', 'in'],
            ['dec', 'out', 'v1', 'in'], ['cj', 'out', 'v2', 'in'], ['gen', 'out', 'v3', 'in'],
        ],
    );
    const dial = 7_100_000;
    const o = frequencyOrigins(g, dial);
    assert.strictEqual(o.get('iq.out'), dial);
    // Shifting down by 1500 Hz puts the dial+1500 at zero.
    assert.strictEqual(o.get('sh.out'), dial + 1500);
    assert.strictEqual(o.get('lp.out'), dial + 1500);
    assert.strictEqual(o.get('dec.out'), dial + 1900);
    assert.strictEqual(inputOrigin(g, o, 'v1'), dial + 1900);
    assert.strictEqual(inputOrigin(g, o, 'v2'), null, 'a conjugated signal claimed real frequencies');
    assert.strictEqual(inputOrigin(g, o, 'v3'), null, 'a generator claimed to be on the air');
});

t('instruments are wider cards, and their height follows what they show', () => {
    assert.ok(nodeWidth('iq-spectrum') > nodeWidth('gain'));
    assert.ok(nodeHeight('iq-spectrum', { display: 'both' }) > nodeHeight('iq-spectrum', { display: 'spectrum' }));
    assert.strictEqual(nodeHeight('iq-spectrum', { display: 'waterfall' }), nodeHeight('iq-spectrum', { display: 'spectrum' }));
});

t('a command reaches its block through the worker, and the next readings show it at once', () => {
    let clock = 0;
    const sent = [];
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    core.onMessage({ t: 'graph', graph: graph([{ id: 'iq', type: 'iq-in' }, { id: 'r', type: 'real-part' }, { id: 's', type: 'scope', params: { mode: 'single' } }], [['iq', 'out', 'r', 'in'], ['r', 'out', 's', 'a']]) });
    core.onMessage({ t: 'watch', ids: ['s'] });
    const packet = () => core.onMessage({ t: 'packet', seq: 1, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: RATE });
    for (let k = 0; k < 20; k++) packet();
    sent.length = 0;
    core.onMessage({ t: 'command', id: 's', name: 'arm' });
    packet();
    const r = sent.filter((m) => m.t === 'out').pop().readings;
    assert.ok(r && r.s, 'no readings straight after the command');
    assert.strictEqual(r.s.state, 'armed');
});

// ── measuring instruments ───────────────────────────────────────────────────

const tone = (n, hz, amp = 1, phase = 0, chirp = 0) => {
    const I = new Float64Array(n);
    const Q = new Float64Array(n);
    let ph = phase;
    for (let k = 0; k < n; k++) {
        I[k] = amp * Math.cos(ph);
        Q[k] = amp * Math.sin(ph);
        ph += (2 * Math.PI * (hz + (chirp * k) / RATE)) / RATE;
    }
    return { I, Q };
};

t('the counter reads a carrier to a hundredth of a hertz over a one-second gate', () => {
    const b = block('frequency-counter', { gateSec: 1 });
    const { I, Q } = tone(RATE * 2, 1234.567, 0.3);
    feedComplex(b, I, Q);
    const r = b.inst.read();
    assert.ok(Math.abs(r.hz - 1234.567) < 0.01, `read ${r.hz}`);
    assert.ok(Math.abs(r.db - 20 * Math.log10(0.3)) < 0.1, `level ${r.db}`);
    const neg = block('frequency-counter', { gateSec: 0.5 });
    const t2 = tone(RATE, -3210.5, 0.5);
    feedComplex(neg, t2.I, t2.Q);
    assert.ok(Math.abs(neg.inst.read().hz + 3210.5) < 0.05, 'a carrier below zero');
});

t('the counter reads through noise, and reports drift', () => {
    const b = block('frequency-counter', { gateSec: 0.5 });
    const n = RATE * 8;
    const { I, Q } = tone(n, 800, 0.2, 0, 2);
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let k = 0; k < n; k++) { I[k] += 0.05 * rnd(); Q[k] += 0.05 * rnd(); }
    feedComplex(b, I, Q);
    const r = b.inst.read();
    assert.ok(r.gates >= 10);
    assert.ok(Math.abs(r.drift - 2) < 0.2, `drift ${r.drift} Hz/s, wanted 2`);
    assert.ok(Math.abs(r.hz - (800 + 2 * 7.75)) < 1, `frequency ${r.hz}`);
    assert.ok(r.progress >= 0 && r.progress <= 1);
});

t('the audio phase meter reads phase and gain between two tones', () => {
    const b = block('phase-meter', { windowMs: 200 });
    const n = RATE;
    const a = Float64Array.from({ length: n }, (_, k) => Math.sin((2 * Math.PI * 700 * k) / RATE));
    const c = Float64Array.from({ length: n }, (_, k) => 0.5 * Math.sin((2 * Math.PI * 700 * k) / RATE - Math.PI / 4));
    feedReal(b, a, c);
    const r = b.inst.read();
    assert.ok(Math.abs(r.phaseDeg + 45) < 0.5, `phase ${r.phaseDeg}`);
    assert.ok(Math.abs(r.gainDb + 6.02) < 0.1, `gain ${r.gainDb}`);
    assert.ok(Math.abs(r.hz - 700) < 2, `frequency ${r.hz}`);
});

t('the IQ phase meter reads the complex gain from a to b', () => {
    const b = block('iq-phase-meter', { windowMs: 100 });
    const { I, Q } = tone(RATE, 1500, 0.4);
    const rot = Math.PI / 3;
    const bI = new Float64Array(RATE);
    const bQ = new Float64Array(RATE);
    for (let k = 0; k < RATE; k++) {
        bI[k] = 0.5 * (I[k] * Math.cos(rot) - Q[k] * Math.sin(rot));
        bQ[k] = 0.5 * (I[k] * Math.sin(rot) + Q[k] * Math.cos(rot));
    }
    for (let at = 0; at < RATE; at += 240) {
        const x = makeBuffer('complex', 240);
        const y = makeBuffer('complex', 240);
        x.re.set(I.subarray(at, at + 240)); x.im.set(Q.subarray(at, at + 240));
        y.re.set(bI.subarray(at, at + 240)); y.im.set(bQ.subarray(at, at + 240));
        b.inst.process([x, y], [], 240);
    }
    const r = b.inst.read();
    assert.ok(Math.abs(r.phaseDeg - 60) < 0.01, `phase ${r.phaseDeg}`);
    assert.ok(Math.abs(r.gainDb + 6.0206) < 0.01, `gain ${r.gainDb}`);
    assert.ok(Math.abs(r.hz - 1500) < 0.1, `frequency ${r.hz}`);
});

t('measuring across a filter gives its gain and its delay as phase', () => {
    let g = graph(
        [
            { id: 'gen', type: 'signal', params: { frequencyHz: 600, amplitude: 0.5 } },
            { id: 're', type: 'real-part' },
            { id: 'lp', type: 'audio-lowpass', params: { cutoffHz: 2000 } },
            { id: 'o', type: 'audio-out' },
        ],
        [['gen', 'out', 're', 'in'], ['re', 'out', 'lp', 'in'], ['lp', 'out', 'o', 'in']],
    );
    assert.deepStrictEqual(acrossPair(g, 'lp'), { kind: 'real', from: ['re', 'out'], to: ['lp', 'out'] });
    assert.strictEqual(acrossPair(g, 'gen'), null, 'a source has nothing to measure across');
    const r = addAcross(g, 'lp');
    assert.ok(r.id);
    assert.ok(r.graph.wires.some((w) => w.join('.') === `re.out.${r.id}.a`));
    assert.ok(r.graph.wires.some((w) => w.join('.') === `lp.out.${r.id}.b`));
    g = r.graph;
    const rt = new Runtime(g, RATE);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    for (let p = 0; p < 100; p++) rt.process({ i: null, q: null, frames: 240, rate: RATE });
    const m = rt.read(r.id);
    const delay = rt.nodes.get('lp').inst.latency();
    let want = (-360 * 600 * delay) / RATE;
    while (want <= -180) want += 360;
    assert.ok(Math.abs(m.gainDb) < 0.05, `passband gain ${m.gainDb} dB`);
    assert.ok(Math.abs(m.phaseDeg - want) < 1, `phase ${m.phaseDeg}°, the delay says ${want}°`);
});

t('a complex block is measured with the IQ meter', () => {
    const g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'f', type: 'complex-bandpass' }],
        [['iq', 'out', 'f', 'in']],
    );
    const r = addAcross(g, 'f');
    assert.strictEqual(r.graph.nodes.find((n) => n.id === r.id).type, 'iq-phase-meter');
    assert.strictEqual(acrossPair(graph([{ id: 'a', type: 'to-audio' }], []), 'a'), null, 'complex in, real out has no pair');
});

t('the scope’s X–Y view sends the pairs, and two tones in quadrature are a circle', () => {
    const b = block('scope', { timebaseMs: 10, view: 'xy' });
    const n = 2400;
    feedReal(b, sine(n, 500, 0.5), sine(n, 500, 0.5, 0, Math.PI / 2));
    const r = b.inst.read();
    assert.ok(r.xy, 'no X–Y pairs');
    for (let k = 0; k < r.xy.x.length; k += 7) {
        assert.ok(Math.abs(Math.hypot(r.xy.x[k], r.xy.y[k]) - 0.5) < 1e-3, 'not a circle');
    }
    const one = block('scope', { view: 'xy' });
    feedReal(one, sine(n, 500, 0.5));
    assert.strictEqual(one.inst.read().xy, null, 'X–Y without a second input');
});

console.log(`\n${pass} passed`);
