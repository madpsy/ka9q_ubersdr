// Control ports: settings driven by other blocks, and the loops that makes
// possible.
//
// The proof that matters is a frequency lock. A carrier drifting at a hertz a
// second goes into a shift; a counter after the shift measures what is left;
// an integrator turns that into the shift's frequency. If control values,
// their sequence numbers, loops through controls and the order things run in
// are all right, the counter reads zero and the shift follows the carrier.
// If any of them is wrong, it wanders off or never moves.

const assert = require('assert');
const {
    BLOCK_BY_TYPE, makeBuffer, GRAPH_VERSION, parseGraph, serializeGraph, compile, Runtime, createWorkerCore,
    canConnect, exposeControl, controlPort, inputsOf, parseChoices, nodeHeight,
} = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;
const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

/** Correlation amplitude of a tone at `hz` in a real signal. */
function toneAt(x, hz, rate = RATE) {
    let c = 0;
    let s = 0;
    for (let k = 0; k < x.length; k++) {
        c += x[k] * Math.cos((2 * Math.PI * hz * k) / rate);
        s += x[k] * Math.sin((2 * Math.PI * hz * k) / rate);
    }
    return (2 * Math.hypot(c, s)) / x.length;
}

function collect(rt, id, packets, stream = () => ({ i: null, q: null, frames: 240, rate: RATE })) {
    const out = [];
    for (let p = 0; p < packets; p++) {
        rt.process(stream(p));
        const r = rt.read(id);
        if (r && r.frames) out.push(...r.samples);
    }
    return Float64Array.from(out);
}

// ── exposing a setting ──────────────────────────────────────────────────────

t('a setting can be given a control input, which is stored, shared and can be taken away', () => {
    let g = graph([{ id: 'sh', type: 'shift' }, { id: 's', type: 'slider' }], []);
    g = exposeControl(g, 'sh', 'frequencyHz', true);
    const sh = g.nodes.find((n) => n.id === 'sh');
    assert.deepStrictEqual(sh.controls, ['frequencyHz']);
    const port = inputsOf(sh, BLOCK_BY_TYPE.shift).find((p) => p.name === controlPort('frequencyHz'));
    assert.ok(port && port.kind === 'control' && port.optional);
    assert.ok(nodeHeight(sh) > nodeHeight({ type: 'shift', params: sh.params }), 'the card did not grow a row');
    g = { ...g, wires: [['s', 'out', 'sh', controlPort('frequencyHz')]] };
    assert.ok(compile(g, RATE).errors.every((e) => !/No input/.test(e.message)));
    const back = parseGraph(JSON.parse(JSON.stringify(serializeGraph(g)))).graph;
    assert.deepStrictEqual(back.nodes.find((n) => n.id === 'sh').controls, ['frequencyHz']);
    const off = exposeControl(g, 'sh', 'frequencyHz', false);
    assert.strictEqual(off.nodes.find((n) => n.id === 'sh').controls, undefined);
    assert.deepStrictEqual(off.wires, [], 'the driving wire was left dangling');
});

t('a number that moves a rate cannot be driven; a choice can, by a message naming it', () => {
    let g = graph([{ id: 'd', type: 'decimate' }, { id: 'o', type: 'audio-out' }], []);
    assert.strictEqual(exposeControl(g, 'd', 'factor', true), g);
    g = exposeControl(g, 'o', 'muted', true);
    g = exposeControl(g, 'o', 'channel', true);
    assert.deepStrictEqual(g.nodes.find((n) => n.id === 'o').controls, ['muted', 'channel']);
    // A stored graph naming one is cleaned on the way in.
    const r = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'd', type: 'decimate', controls: ['factor', 'frequencyHz', 'nope'] }], wires: [] });
    assert.deepStrictEqual(r.graph.nodes[0].controls, ['frequencyHz']);
});

// ── driving ─────────────────────────────────────────────────────────────────

t('a slider drives a generator’s frequency, and the runtime says what it set', () => {
    const g = graph(
        [
            { id: 'sl', type: 'slider', params: { value: 1000, min: 0, max: 5000 } },
            { id: 'gen', type: 'signal', params: { frequencyHz: 300, amplitude: 0.5 }, controls: ['frequencyHz'] },
            { id: 're', type: 'real-part' }, { id: 'o', type: 'audio-out' },
        ],
        [['sl', 'out', 'gen', controlPort('frequencyHz')], ['gen', 'out', 're', 'in'], ['re', 'out', 'o', 'in']],
    );
    const rt = new Runtime(g, RATE);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    let x = collect(rt, 'o', 20);
    assert.ok(toneAt(x, 1000) > 0.45, 'not at the slider’s 1000 Hz');
    assert.ok(toneAt(x, 300) < 0.01, 'still at its own 300 Hz');
    assert.deepStrictEqual(rt.driven(), { gen: { frequencyHz: 1000 } });
    rt.setParams('sl', { value: 2500 });
    x = collect(rt, 'o', 20);
    assert.ok(toneAt(x, 2500) > 0.45, 'did not follow the slider');
    assert.strictEqual(rt.driven().gen.frequencyHz, 2500);
});

t('a toggle drives an on/off setting, and a dropdown picks from its list', () => {
    assert.deepStrictEqual(parseChoices('500, 1000;2700  junk 1000 4000'), [500, 1000, 2700, 4000]);
    const g = graph(
        [
            { id: 'tg', type: 'toggle', params: { on: true } },
            { id: 'dd', type: 'dropdown', params: { choices: '200, 1500, 3000', index: 1 } },
            { id: 'gen', type: 'signal', params: { amplitude: 0.5 }, controls: ['frequencyHz'] },
            { id: 're', type: 'real-part' }, { id: 'o', type: 'audio-out', controls: ['muted'] },
        ],
        [
            ['dd', 'out', 'gen', controlPort('frequencyHz')], ['tg', 'out', 'o', controlPort('muted')],
            ['gen', 'out', 're', 'in'], ['re', 'out', 'o', 'in'],
        ],
    );
    const rt = new Runtime(g, RATE);
    collect(rt, 'o', 3);
    assert.deepStrictEqual(rt.driven(), { gen: { frequencyHz: 1500 }, o: { muted: true } });
    rt.setParams('tg', { on: false });
    rt.setParams('dd', { index: 2 });
    collect(rt, 'o', 3);
    assert.deepStrictEqual(rt.driven(), { gen: { frequencyHz: 3000 }, o: { muted: false } });
});

t('scale converts, and the integrator adds each new value once, within its limits', () => {
    const sc = BLOCK_BY_TYPE['control-scale'].create();
    sc.configure({ scale: -2, offset: 10 });
    const inp = makeBuffer('control', 0);
    const out = makeBuffer('control', 0);
    inp.value = 3; inp.seq = 1;
    sc.process([inp], [out], 0);
    assert.deepStrictEqual([out.value, out.seq], [4, 1]);
    sc.process([inp], [out], 0);
    assert.strictEqual(out.seq, 1, 'put out again with nothing new in');

    const it = BLOCK_BY_TYPE.integrator.create();
    it.configure({ gain: 0.5, initial: 100, min: 0, max: 105 });
    const o2 = makeBuffer('control', 0);
    const i2 = makeBuffer('control', 0);
    it.process([i2], [o2], 0);
    assert.strictEqual(o2.value, 100, 'did not start at its start value');
    i2.value = 4; i2.seq = 1;
    it.process([i2], [o2], 0);
    it.process([i2], [o2], 0);
    assert.strictEqual(o2.value, 102, 'one value was added twice');
    // The same value again is a new reading, and is added.
    i2.seq = 2;
    it.process([i2], [o2], 0);
    assert.strictEqual(o2.value, 104);
    i2.value = 100; i2.seq = 3;
    it.process([i2], [o2], 0);
    assert.strictEqual(o2.value, 105, 'ran past its max');
    it.command('reset');
    i2.seq = 4; i2.value = 0;
    it.process([i2], [o2], 0);
    assert.strictEqual(o2.value, 100, 'reset did not go back to the start value');
});

// ── loops ───────────────────────────────────────────────────────────────────

t('a loop of samples is refused; a loop through a control is allowed', () => {
    const g = graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'sh', type: 'shift', controls: ['frequencyHz'] }, { id: 'c', type: 'frequency-counter' }],
        [['iq', 'out', 'sh', 'in'], ['sh', 'out', 'c', 'in']],
    );
    assert.strictEqual(canConnect(g, 'c', 'hz', 'sh', controlPort('frequencyHz')).ok, true);
    const stream = graph(
        [{ id: 'a', type: 'gain' }, { id: 'b', type: 'gain' }],
        [['a', 'out', 'b', 'in']],
    );
    assert.match(canConnect(stream, 'b', 'out', 'a', 'in').why, /loop/);
    const looped = { ...g, wires: [...g.wires, ['c', 'hz', 'sh', controlPort('frequencyHz')]] };
    const c = compile(looped, RATE);
    assert.ok(c.ok, JSON.stringify(c.errors));
    assert.ok(c.order.indexOf('sh') < c.order.indexOf('c'), 'the samples’ order was not kept');
});

t('a counter, an integrator and a shift lock to a drifting carrier', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'sh', type: 'shift', controls: ['frequencyHz'] },
            { id: 'c', type: 'frequency-counter', params: { gateSec: 0.1 } },
            { id: 'int', type: 'integrator', params: { gain: -0.5, initial: 0, min: -6000, max: 6000 } },
        ],
        [['iq', 'out', 'sh', 'in'], ['sh', 'out', 'c', 'in'], ['c', 'hz', 'int', 'in'], ['int', 'out', 'sh', controlPort('frequencyHz')]],
    );
    const rt = new Runtime(g, RATE);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    let phase = 0;
    let k = 0;
    const stream = () => {
        const I = new Float32Array(240);
        const Q = new Float32Array(240);
        for (let j = 0; j < 240; j++, k++) {
            const hz = 700 + k / RATE;
            phase += (2 * Math.PI * hz) / RATE;
            I[j] = 0.3 * Math.cos(phase);
            Q[j] = 0.3 * Math.sin(phase);
        }
        return { i: I, q: Q, frames: 240, rate: RATE };
    };
    for (let p = 0; p < 50 * 6; p++) rt.process(stream());
    const residual = rt.read('c').hz;
    const carrier = 700 + k / RATE;
    const shift = rt.driven().sh.frequencyHz;
    assert.ok(Math.abs(residual) < 1, `the counter still reads ${residual.toFixed(2)} Hz after the shift`);
    assert.ok(Math.abs(shift + carrier) < 2, `the shift is at ${shift.toFixed(1)} Hz, the carrier at ${carrier.toFixed(1)}`);
});

// ── control outputs ─────────────────────────────────────────────────────────

t('meters, the squelch and the counter put their readings out as controls', () => {
    const g = graph(
        [
            { id: 'gen', type: 'signal', params: { frequencyHz: 400, amplitude: 0.5 } },
            { id: 're', type: 'real-part' }, { id: 'm', type: 'meter' },
            { id: 'p', type: 'power' }, { id: 'lvl', type: 'level-detector' }, { id: 'sq', type: 'squelch', params: { thresholdDb: -20 } },
            { id: 'c', type: 'frequency-counter', params: { gateSec: 0.1 } },
            { id: 'pm', type: 'control-plot' }, { id: 'pl', type: 'control-plot' }, { id: 'ps', type: 'control-plot' }, { id: 'pc', type: 'control-plot' },
        ],
        [
            ['gen', 'out', 're', 'in'], ['re', 'out', 'm', 'in'], ['gen', 'out', 'p', 'in'], ['p', 'out', 'lvl', 'in'], ['lvl', 'out', 'sq', 'in'],
            ['gen', 'out', 'c', 'in'],
            ['m', 'db', 'pm', 'in'], ['lvl', 'db', 'pl', 'in'], ['sq', 'open', 'ps', 'in'], ['c', 'hz', 'pc', 'in'],
        ],
    );
    const rt = new Runtime(g, RATE);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    for (let p = 0; p < 20; p++) rt.process({ i: null, q: null, frames: 240, rate: RATE });
    assert.ok(Math.abs(rt.read('pm').value - 20 * Math.log10(0.5 / Math.SQRT2)) < 0.2, `meter ${rt.read('pm').value}`);
    assert.ok(Math.abs(rt.read('pl').value - 20 * Math.log10(0.5)) < 0.5, `level ${rt.read('pl').value}`);
    assert.strictEqual(rt.read('ps').value, 1);
    assert.ok(Math.abs(rt.read('pc').value - 400) < 0.1, `counter ${rt.read('pc').value}`);
    assert.ok(rt.read('pc').history.length >= 3, 'the plot kept no history');
});

t('the worker sends what controls have set, even with nothing watched', () => {
    const sent = [];
    let clock = 0;
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    core.onMessage({
        t: 'graph',
        graph: graph(
            [{ id: 'sl', type: 'slider', params: { value: 42 } }, { id: 'gen', type: 'signal', controls: ['amplitude'] }, { id: 're', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
            [['sl', 'out', 'gen', controlPort('amplitude')], ['gen', 'out', 're', 'in'], ['re', 'out', 'o', 'in']],
        ),
    });
    core.onMessage({ t: 'packet', seq: 1, i: null, q: null, frames: 240, rate: RATE });
    const out = sent.filter((m) => m.t === 'out').pop();
    assert.ok(out.readings && out.readings.__driven, 'nothing said about the driven setting');
    // Clamped to the setting's own range on the way in.
    assert.deepStrictEqual(out.readings.__driven, { gen: { amplitude: 1 } });
});

// ── Shape & round ───────────────────────────────────────────────────────────

/** Values through a Shape & round, one at a time: what each sent, null for nothing. */
function shape(params, values) {
    const def = BLOCK_BY_TYPE['control-shape'];
    const inst = def.create();
    const p = {};
    for (const [k, spec] of Object.entries(def.params)) p[k] = spec.default;
    inst.configure({ ...p, ...params });
    const inp = makeBuffer('control', 0);
    const out = makeBuffer('control', 0);
    return values.map((v, k) => {
        const before = out.seq;
        inp.value = v;
        inp.seq = k + 1;
        inst.process([inp], [out], 0);
        return out.seq === before ? null : out.value;
    });
}

t('Shape & round passes a value through untouched until a step is set', () => {
    assert.deepStrictEqual(shape({}, [9.6, 9.7, -3]), [9.6, 9.7, -3]);
});

t('Shape & round rounds to a multiple of its step, each way, tidily', () => {
    assert.deepStrictEqual(shape({ rounding: 'nearest', step: 1, onChange: false }, [9.6, 9.4, -2.5]), [10, 9, -2]);
    assert.deepStrictEqual(shape({ rounding: 'down', step: 1, onChange: false }, [9.6, -9.6]), [9, -10]);
    assert.deepStrictEqual(shape({ rounding: 'up', step: 1, onChange: false }, [9.1, -9.6]), [10, -9]);
    assert.deepStrictEqual(shape({ rounding: 'toward-zero', step: 1, onChange: false }, [9.6, -9.6]), [9, -9]);
    assert.deepStrictEqual(shape({ rounding: 'nearest', step: 0.1, onChange: false }, [9.66]), [9.7], 'not tidied');
    assert.deepStrictEqual(shape({ rounding: 'nearest', step: 5, onChange: false }, [12, 13]), [10, 15]);
});

t('Shape & round sends only when the result changes, and ignores changes under its deadband', () => {
    assert.deepStrictEqual(shape({ rounding: 'nearest', step: 1 }, [9.6, 9.7, 10.2, 10.6]), [10, null, null, 11]);
    // On a boundary, a deadband stops it flicking.
    assert.deepStrictEqual(shape({ deadband: 0.5 }, [9.5, 9.7, 9.3, 10.1]), [9.5, null, null, 10.1]);
});

t('Shape & round averages, puts the value through a function, scales and clamps — in that order', () => {
    assert.deepStrictEqual(shape({ average: 2, onChange: false }, [10, 20, 40]), [10, 15, 30]);
    assert.deepStrictEqual(shape({ fn: 'db-amp', rounding: 'nearest', step: 0.1, onChange: false }, [10, 0.5]), [20, -6]);
    assert.deepStrictEqual(shape({ fn: 'sqrt', onChange: false }, [16, -4]), [4, null], 'a root of a negative sent something');
    assert.deepStrictEqual(shape({ scale: 2, offset: 1, min: 0, max: 10, onChange: false }, [3, 7, -5]), [7, 10, 0]);
    // The function before the scale: abs, then negated by scale −1.
    assert.deepStrictEqual(shape({ fn: 'abs', scale: -1, onChange: false }, [-4]), [-4]);
});

console.log(`\n${pass} passed`);
