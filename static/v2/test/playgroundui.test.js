// The playground editor: the edits and geometry it is built on, and that every
// piece of it renders.
//
// The render half is the hook stub's (see hookStub.js): no DOM and no browser,
// but real hooks and a createElement that refuses an undefined component — the
// failure that has blanked the interface before with a green build. Every
// block type is put through the inspector and the card, because each one
// takes a different path through them.

const assert = require('assert');

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
};
const docListeners = [];
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
    addEventListener: (name, fn) => docListeners.push([name, fn]),
    removeEventListener: (name, fn) => {
        const i = docListeners.findIndex(([n, f]) => n === name && f === fn);
        if (i >= 0) docListeners.splice(i, 1);
    },
    body: { appendChild() {}, removeChild() {} },
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.TextDecoder = globalThis.TextDecoder || require('util').TextDecoder;

const P = require('./.build/playgroundui.cjs');
const {
    deep, render, reset, walk, words,
    IQPanel, takeShareCode, PlaygroundModal, PlaygroundWindow, WATCHED_TYPES, graphFromIQDemod, TemplatesMenu, TEMPLATES,
    Inspector, CardVisual, Palette, closePlayground, offerSharedGraph, openPlayground, playgroundUiState,
    EditHistory, addNode, canConnect, connectPorts, disconnectInput, duplicateNodes, freshId, moveNodes, removeNodes, removeWire,
    NODE_W, nodeWidth, autoLayout, graphBounds, fitView, nodeAt, nodeHeight, portAt, portPosition, screenToWorld, wirePath, zoomAbout,
    Instrument, SpectrumView, ScopeView, ConstellationView, spectrumAxis, scopeRange, freqLabel, timeLabel, INSTRUMENTS,
    spectrumMarks, counterText, groupDigits, PROBES,
    BLOCKS, BLOCK_BY_TYPE, GRAPH_VERSION, compile, parseGraph, getPlayground, resetDemodSettings, saveDemodSettings,
    formatCpu, formatLatency, formatRate,
} = P;

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const g = (nodes, wires = []) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;
const cls = (n) => (n && n.props && typeof n.props.className === 'string' ? n.props.className : '');

// ── editing ─────────────────────────────────────────────────────────────────

t('a new block gets an id nobody has, and its defaults', () => {
    let graph = g([{ id: 'gain1', type: 'gain' }]);
    assert.strictEqual(freshId(graph, 'gain'), 'gain2');
    const r = addNode(graph, 'audio-lowpass', 10.6, 20.2);
    assert.strictEqual(r.id, 'audiolowpass1');
    const n = r.graph.nodes.find((x) => x.id === r.id);
    assert.deepStrictEqual([n.x, n.y], [11, 20]);
    assert.strictEqual(n.params.cutoffHz, BLOCK_BY_TYPE['audio-lowpass'].params.cutoffHz.default);
    assert.strictEqual(graph.nodes.length, 1, 'the old graph was changed');
    graph = r.graph;
    assert.strictEqual(addNode(graph, 'nope').graph, graph, 'an unknown type was added');
});

t('wiring replaces what was on the input, and refuses the wrong kind, a loop, or itself', () => {
    let graph = g([{ id: 's', type: 'signal' }, { id: 't', type: 'signal' }, { id: 'sh', type: 'shift' }, { id: 'e', type: 'envelope' }, { id: 'gn', type: 'gain' }]);
    graph = connectPorts(graph, 's', 'out', 'sh', 'in');
    graph = connectPorts(graph, 't', 'out', 'sh', 'in');
    assert.deepStrictEqual(graph.wires, [['t', 'out', 'sh', 'in']]);
    assert.strictEqual(canConnect(graph, 's', 'out', 'gn', 'in').ok, false);
    assert.match(canConnect(graph, 's', 'out', 'gn', 'in').why, /complex output cannot feed a real input/);
    assert.match(canConnect(graph, 'gn', 'out', 'gn', 'in').why, /itself/);
    graph = connectPorts(graph, 'sh', 'out', 'e', 'in');
    graph = connectPorts(graph, 'e', 'out', 'gn', 'in');
    // gn → anything upstream of it would be a loop — but there is no real
    // input upstream, so build one that could loop.
    const loopy = g(
        [{ id: 'a', type: 'gain' }, { id: 'b', type: 'gain' }, { id: 'c', type: 'gain' }],
        [['a', 'out', 'b', 'in'], ['b', 'out', 'c', 'in']],
    );
    assert.match(canConnect(loopy, 'c', 'out', 'a', 'in').why, /loop/);
    assert.strictEqual(connectPorts(loopy, 'c', 'out', 'a', 'in'), loopy);
});

t('removing a block takes its wires; a wire or an input can go on its own', () => {
    let graph = g(
        [{ id: 'iq', type: 'iq-in' }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        [['iq', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    );
    assert.deepStrictEqual(removeNodes(graph, ['r']).wires, []);
    assert.deepStrictEqual(removeWire(graph, 0).wires, [['r', 'out', 'o', 'in']]);
    assert.deepStrictEqual(disconnectInput(graph, 'o', 'in').wires, [['iq', 'out', 'r', 'in']]);
    assert.strictEqual(disconnectInput(graph, 'o', 'nope'), graph);
    graph = moveNodes(graph, ['r', 'o'], 10, -5);
    assert.deepStrictEqual(graph.nodes.map((n) => [n.x, n.y]), [[0, 0], [10, -5], [10, -5]]);
});

t('duplicating copies the wires between the copies, not the ones in from outside', () => {
    const graph = g(
        [{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass', params: { cutoffHz: 777 } }, { id: 'a', type: 'to-audio' }],
        [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in']],
    );
    const r = duplicateNodes(graph, ['lp', 'a']);
    assert.strictEqual(r.ids.length, 2);
    const [lp2, a2] = r.ids;
    assert.strictEqual(r.graph.nodes.find((n) => n.id === lp2).params.cutoffHz, 777);
    assert.ok(r.graph.wires.some((w) => w[0] === lp2 && w[2] === a2), 'the inner wire was not copied');
    assert.ok(!r.graph.wires.some((w) => w[2] === lp2), 'a wire from outside was copied, taking an input');
});

t('history undoes and redoes, and a dragged slider is one step', () => {
    let clock = 0;
    const a = g([{ id: 'x', type: 'gain' }]);
    const h = new EditHistory(a, () => clock);
    const b = addNode(a, 'clip').graph;
    h.push(b);
    const c1 = { ...b, tag: 1 };
    const c2 = { ...b, tag: 2 };
    h.push(c1, 'param:x:gain');
    clock += 200;
    h.push(c2, 'param:x:gain');
    assert.strictEqual(h.undo(), b, 'two quick edits of one slider took two undos');
    assert.strictEqual(h.undo(), a);
    assert.ok(!h.canUndo);
    assert.strictEqual(h.redo(), b);
    assert.strictEqual(h.redo(), c2);
    h.undo();
    h.push({ ...b, tag: 3 });
    assert.ok(!h.canRedo, 'a new edit did not clear the redo');
    clock += 5000;
    h.push({ ...b, tag: 4 }, 'param:x:gain');
    h.push({ ...b, tag: 5 }, 'param:x:gain');
    assert.strictEqual(h.current.tag, 5);
    assert.strictEqual(h.undo().tag, 3, 'edits under one key a long time apart merged with one before');
});

// ── geometry ────────────────────────────────────────────────────────────────

t('ports sit on the card edges, and portAt finds them only for the right kind', () => {
    const graph = g([{ id: 'a', type: 'agc', x: 100, y: 50 }, { id: 'tr', type: 'carrier-tracker', x: 400, y: 0 }]);
    const ref = portPosition(graph.nodes[0], 'in', 1);
    assert.strictEqual(ref.x, 100);
    assert.ok(ref.y > 50 && ref.y < 50 + nodeHeight('agc'));
    const out = portPosition(graph.nodes[1], 'out', 2);
    assert.strictEqual(out.x, 400 + NODE_W);
    assert.deepStrictEqual(portAt(graph, 'in', ref.x + 3, ref.y - 2, 10), { id: 'a', port: 'ref', kind: 'real', index: 1 });
    assert.strictEqual(portAt(graph, 'in', ref.x, ref.y, 10, 'complex'), null, 'a real port answered for a complex wire');
    assert.strictEqual(portAt(graph, 'in', ref.x + 40, ref.y, 10), null);
    assert.strictEqual(nodeAt(graph, 120, 60), 'a');
    assert.strictEqual(nodeAt(graph, 10, 10), null);
});

t('a wire leaves rightwards and arrives from the left', () => {
    assert.strictEqual(wirePath(0, 0, 200, 50), 'M0,0 C100,0 100,50 200,50');
    assert.ok(wirePath(200, 0, 0, 0).startsWith('M200,0 C300,0'), 'a backwards wire has no loop');
});

t('the view: zoom keeps the point under the pointer, and fit shows everything', () => {
    const v = { x: 30, y: -20, zoom: 1 };
    const before = screenToWorld(v, 300, 200);
    const z = zoomAbout(v, 300, 200, 1.7);
    const after = screenToWorld(z, 300, 200);
    assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
    assert.ok(zoomAbout(v, 0, 0, 100).zoom <= 2 && zoomAbout(v, 0, 0, 0.001).zoom >= 0.3);
    const graph = graphFromIQDemod(12000);
    const f = fitView(graph, 900, 500);
    const b = graphBounds(graph);
    const tl = { x: b.x * f.zoom + f.x, y: b.y * f.zoom + f.y };
    const br = { x: (b.x + b.w) * f.zoom + f.x, y: (b.y + b.h) * f.zoom + f.y };
    assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= 900 && br.y <= 500, `fit left the graph off screen: ${JSON.stringify({ tl, br })}`);
});

t('auto layout puts every block right of what feeds it, and no two cards overlap', () => {
    const graph = graphFromIQDemod(12000);
    for (const w of graph.wires) {
        const a = graph.nodes.find((n) => n.id === w[0]);
        const b = graph.nodes.find((n) => n.id === w[2]);
        assert.ok(b.x > a.x, `${w[2]} is not right of ${w[0]}`);
    }
    for (const a of graph.nodes) {
        for (const b of graph.nodes) {
            if (a === b) continue;
            const overlap = a.x < b.x + nodeWidth(b.type) && b.x < a.x + nodeWidth(a.type)
                && a.y < b.y + nodeHeight(b.type, b.params) && b.y < a.y + nodeHeight(a.type, a.params);
            assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
        }
    }
});

// ── from IQ Demod ───────────────────────────────────────────────────────────

t('From IQ Demod brings the selected demodulator, its output and channel with it', () => {
    resetDemodSettings();
    saveDemodSettings({
        vfos: [
            { mode: 'usb' },
            { mode: 'am', offsetHz: 1500, sinkId: 'headset-9', pan: 'right', muted: true, squelchDb: -30, agc: false, gain: 2 },
        ],
        active: 1,
    });
    const graph = graphFromIQDemod(12000);
    assert.ok(compile(graph, 12000).ok, JSON.stringify(compile(graph, 12000).errors));
    assert.ok(graph.nodes.some((n) => n.type === 'envelope'), 'not the AM demodulator');
    const out = graph.nodes.find((n) => n.id === 'audio').params;
    assert.deepStrictEqual([out.device, out.channel, out.muted], ['headset-9', 'right', true]);
    const sq = graph.nodes.find((n) => n.id === 'squelch').params;
    assert.deepStrictEqual([sq.enabled, sq.thresholdDb], [true, -30]);
    assert.strictEqual(graph.nodes.find((n) => n.id === 'agc').params.apply, false);
    resetDemodSettings();
});

// ── share links on arrival ──────────────────────────────────────────────────

t('a share code is taken off the address, and the rest of the link is left', () => {
    const replaced = [];
    const loc = { search: '?freq=7100000&mode=iq&playground=pg1.z.abc', pathname: '/v2/', hash: '#x' };
    const hist = { state: { s: 1 }, replaceState: (s, _, url) => replaced.push(url) };
    assert.strictEqual(takeShareCode(loc, hist), 'pg1.z.abc');
    assert.deepStrictEqual(replaced, ['/v2/?freq=7100000&mode=iq#x']);
    assert.strictEqual(takeShareCode({ search: '?freq=1', pathname: '/' }, hist), null);
    assert.strictEqual(replaced.length, 1, 'a link without a graph was rewritten');
});

// ── rendering ───────────────────────────────────────────────────────────────

function radio(over) {
    const calls = [];
    const player = {
        ctx: null, ducked: false, outputBus: null,
        setDucked(v) { player.ducked = v; },
        onAudio() { return () => {}; },
    };
    const ctx = {
        tuning: { frequency: 7_100_000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 },
        running: true,
        audioState: 'open',
        audio: { volume: 0.8, muted: false },
        iqPrompt: null,
        allowedIQModes: [],
        player,
        actions: { setMode: (m) => calls.push(['setMode', m]) },
        display: {},
        ...over,
    };
    ctx.calls = calls;
    return ctx;
}

t('the IQ Demod panel has a Playground button at the far end of the Start row, in the full view only', () => {
    reset();
    closePlayground();
    const full = render(IQPanel, {}, radio());
    const row = walk(full.tree).find((n) => cls(n) === 'iq-run');
    assert.ok(row, 'no run row');
    const items = walk(row);
    const btn = items.find((n) => cls(n) === 'iq-run__playground');
    assert.ok(btn, 'no Playground button in the run row');
    // After the Start button and the hint: the far end of the row.
    const kids = (row.children && row.children.length ? row.children : [].concat(row.props.children)).flat().filter(Boolean);
    assert.strictEqual(kids[kids.length - 1], btn, 'the Playground button is not last in the row');
    assert.match(words(btn), /Playground/);
    btn.props.onClick();
    assert.strictEqual(playgroundUiState().open, true, 'pressing it did not open the playground');
    closePlayground();
    full.cleanups.forEach((f) => f());

    reset();
    const min = render(IQPanel, { minimal: true }, radio());
    assert.ok(!walk(min.tree).some((n) => cls(n) === 'iq-run__playground'), 'the button is in the minimal view');
    min.cleanups.forEach((f) => f());
});

t('the window is nothing while closed, and the whole editor while open', () => {
    reset();
    closePlayground();
    assert.strictEqual(render(PlaygroundModal, {}, radio()).tree, null);
    openPlayground();
    reset();
    const { tree, cleanups } = render(PlaygroundModal, {}, radio());
    assert.ok(tree, 'nothing rendered while open');
    const all = deep(tree);
    const has = (c) => all.some((n) => cls(n).split(' ').includes(c));
    for (const c of ['pg', 'pg-bar', 'pg__palette', 'pg-canvas', 'pg__inspector']) assert.ok(has(c), `no ${c}`);
    // Every block the palette offers.
    const items = all.filter((n) => cls(n) === 'pg-pal__item');
    assert.strictEqual(items.length, BLOCKS.length);
    // A card per block in the graph, and a wire per wire.
    const pg = getPlayground(radio().player);
    assert.strictEqual(all.filter((n) => cls(n).split(' ').includes('pg-card')).length, pg.graph.nodes.length);
    assert.strictEqual(all.filter((n) => /\bpg-wire pg-wire--/.test(cls(n))).length, pg.graph.wires.length);
    assert.match(words(tree), /Start/);
    cleanups.forEach((f) => f());
    closePlayground();
});

t('a shared graph is offered rather than loaded, and the offer can be taken or refused', () => {
    reset();
    const before = JSON.stringify(getPlayground(radio().player).graph);
    offerSharedGraph({ graph: g([{ id: 's', type: 'signal' }]), errors: [] });
    assert.strictEqual(playgroundUiState().open, true, 'a link did not open the playground');
    const { tree, cleanups } = render(PlaygroundWindow, {}, radio());
    assert.strictEqual(JSON.stringify(getPlayground(radio().player).graph), before, 'the graph was replaced without asking');
    const offer = deep(tree).find((n) => cls(n) === 'pg-offer');
    assert.ok(offer, 'no offer');
    assert.match(words(offer), /graph of 1 blocks/);
    cleanups.forEach((f) => f());
    offerSharedGraph(null);
    closePlayground();
});

t('the inspector renders every block type’s settings', () => {
    const pg = getPlayground(radio().player);
    for (const def of BLOCKS) {
        reset();
        const graph = g([{ id: 'n', type: def.type }]);
        const el = React.createElement(Inspector, {
            pg, graph, selection: { nodes: new Set(['n']), wire: null }, errorsByNode: {}, rates: { n: 12000 },
            latencies: { n: { own: 0.01, total: 0.02 } }, stats: { nodes: { n: { cpu: 0.012 } } },
            onParams() {}, onRemove() {}, onDuplicate() {}, summary: null,
        });
        const all = deep(el);
        const text = words(el);
        assert.ok(text.includes(def.label), `${def.type}: no title`);
        assert.ok(text.includes('1.2%'), `${def.type}: no CPU figure`);
        if (Object.keys(def.params).length) assert.ok(text.includes('Settings'), `${def.type}: no settings`);
        if (def.type === 'wav-recorder') assert.ok(text.includes('Record'), 'the recorder has no Record');
        assert.ok(all.length > 5);
    }
});

t('every card visual renders, with and without readings', () => {
    const pg = getPlayground(radio().player);
    const readings = {
        meter: { level: 0.1, db: -20 }, 'level-detector': { level: 0.01, db: -20 },
        'audio-spectrum': { db: new Float32Array(512).fill(-50), binHz: 11.7 }, squelch: { open: false },
        'carrier-tracker': { state: 'locked', locked: true, carrierHz: 12.3, side: 'usb' },
    };
    for (const def of BLOCKS) {
        for (const withReading of [false, true]) {
            reset();
            pg.readings = withReading ? { n: readings[def.type] } : {};
            deep(React.createElement(CardVisual, { pg, node: { id: 'n', type: def.type, params: {} } }));
        }
    }
    pg.readings = {};
    reset();
    const shut = words(React.createElement(CardVisual, { pg, node: { id: 'n', type: 'squelch' } }));
    assert.strictEqual(shut, '—');
});

t('the cards the editor asks readings for are the ones that draw them', () => {
    for (const type of WATCHED_TYPES) assert.ok(BLOCK_BY_TYPE[type], type);
    assert.ok(!WATCHED_TYPES.has('audio-out'), 'Audio out’s samples would be copied back for nothing');
});

t('the palette filters by what is typed', () => {
    reset();
    const all = deep(React.createElement(Palette, { onAdd() {} })).filter((n) => cls(n) === 'pg-pal__item');
    assert.strictEqual(all.length, BLOCKS.length);
});

// ── instruments ─────────────────────────────────────────────────────────────

t('every instrument draws, with no signal and with one, small and large', () => {
    const pg = getPlayground(radio().player);
    const readings = {
        'iq-spectrum': { db: new Float32Array(1024).fill(-60), rate: 12000, size: 1024, sided: 2 },
        'audio-spectrum': { db: new Float32Array(512).fill(-60), rate: 12000, size: 1024, sided: 1, binHz: 11.7 },
        scope: {
            a: { min: new Float32Array(100), max: new Float32Array(100).fill(0.5), vpp: 1, rms: 0.3, mean: 0, hz: 1000 },
            b: null, rate: 12000, seconds: 0.01, triggered: true, state: 'running', mode: 'auto',
        },
        constellation: { i: new Float32Array(64), q: new Float32Array(64), scale: 2 },
        'frequency-counter': { hz: 123.45, db: -20, drift: 0.01, spread: 0.002, gates: 5, progress: 0.4, gateSec: 1, rate: 12000 },
        'phase-meter': { hz: 700, phaseDeg: -45, gainDb: -6, rate: 12000 },
        'iq-phase-meter': { hz: 1500, phaseDeg: 60, gainDb: -6, rate: 12000 },
        'signal-detector': { signals: [{ hz: 1234.5, db: -30, snrDb: 40, widthHz: 12 }], floorDb: -90, rate: 12000 },
        'message-log': { lines: [{ type: 'appeared', at: 1, hz: 100, db: -20, snrDb: 30, widthHz: 6, wall: 0 }, { type: 'gone', at: 3, hz: 100, lastedSec: 2, wall: 0 }, { type: 'odd', x: 1, wall: 0 }], count: 3 },
    };
    for (const type of INSTRUMENTS) {
        const def = BLOCK_BY_TYPE[type];
        const node = { id: 'v', type, params: Object.fromEntries(Object.entries(def.params).map(([k, sp]) => [k, sp.default])) };
        for (const r of [null, readings[type]]) {
            for (const large of [false, true]) {
                reset();
                pg.readings = r ? { v: r } : {};
                deep(React.createElement(Instrument, { pg, node, look: { palette: 'classic', dialHz: 7_100_000 }, origin: 0, large }));
            }
        }
    }
    pg.readings = {};
});

t('the scope’s large view has its run, stop and single-shot controls, and its measurements', () => {
    const pg = getPlayground(radio().player);
    const sent = [];
    const real = pg.command;
    pg.command = (id, name) => sent.push([id, name]);
    try {
        const params = { ...Object.fromEntries(Object.entries(BLOCK_BY_TYPE.scope.params).map(([k, sp]) => [k, sp.default])), mode: 'single' };
        pg.readings = { s: { a: { min: new Float32Array(10), max: new Float32Array(10), vpp: 0.4, rms: 0.1, mean: 0, hz: 440 }, b: null, rate: 12000, seconds: 0.01, triggered: true, state: 'armed', mode: 'single' } };
        reset();
        const el = React.createElement(Instrument, { pg, node: { id: 's', type: 'scope', params }, look: {}, large: true });
        const all = deep(el);
        const text = words(el);
        assert.match(text, /Armed — waiting for a trigger/);
        assert.match(text, /Re-arm/);
        assert.match(text, /A p-p/);
        assert.match(text, /440/);
        const buttons = all.filter((n) => n.type === 'button' && n.props && n.props.onClick);
        for (const b of buttons) b.props.onClick();
        assert.deepStrictEqual(sent.map((x) => x[1]).sort(), ['arm', 'stop']);
    } finally {
        pg.command = real;
        pg.readings = {};
    }
});

t('a selected block offers instruments on each output and each wired input', () => {
    const pg = getPlayground(radio().player);
    const graph = g(
        [{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass' }, { id: 'a', type: 'to-audio' }],
        [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in']],
    );
    const probed = [];
    reset();
    const el = React.createElement(Inspector, {
        pg, graph, selection: { nodes: new Set(['lp']), wire: null }, errorsByNode: {}, rates: {}, latencies: {}, stats: null,
        onParams() {}, onRemove() {}, onDuplicate() {}, summary: null, look: {}, origins: new Map(),
        onProbe: (from, port, type) => probed.push(`${from}.${port}:${type}`),
    });
    const btns = deep(el).filter((n) => cls(n) === 'pg-probe__btn');
    // Every complex instrument, on the input (from iq) and on the output.
    const kinds = PROBES.complex.map((p) => p.type);
    assert.strictEqual(btns.length, kinds.length * 2);
    btns.forEach((b) => b.props.onClick());
    assert.deepStrictEqual(probed.sort(), [...kinds.map((k) => `iq.out:${k}`), ...kinds.map((k) => `lp.out:${k}`)].sort());
});

t('a selected wire says what it carries and offers instruments for it', () => {
    const pg = getPlayground(radio().player);
    const graph = g(
        [{ id: 'a', type: 'signal' }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        [['a', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    );
    const probed = [];
    reset();
    const el = React.createElement(Inspector, {
        pg, graph, selection: { nodes: new Set(), wire: 1 }, errorsByNode: {}, rates: { r: 12000, o: 12000 }, latencies: {}, stats: null,
        onParams() {}, onRemove() {}, onDuplicate() {}, summary: null, look: {}, origins: new Map(),
        onProbe: (from, port, type) => probed.push(`${from}.${port}:${type}`),
    });
    assert.match(words(el), /a real signal/);
    deep(el).filter((n) => cls(n) === 'pg-probe__btn').forEach((b) => b.props.onClick());
    assert.deepStrictEqual(probed, ['r.out:scope', 'r.out:audio-spectrum', 'r.out:meter']);
});

t('spectrum labels are real frequencies where the zero is known, offsets where not', () => {
    const r = { rate: 12000, sided: 2 };
    const abs = spectrumAxis(r, 7_101_600);
    assert.ok(abs.absolute);
    // 3 kHz between labels: kHz resolution says it.
    assert.strictEqual(abs.name(0, 3000), '7.102M');
    assert.strictEqual(abs.name(-6000), '7.096M');
    // But the readout under the pointer resolves to the bin, so a carrier at
    // 7.1016 MHz reads as that and not as the nearest kHz.
    assert.strictEqual(abs.name(0, 11.7), '7.10160M');
    const rel = spectrumAxis(r, null);
    assert.ok(!rel.absolute);
    assert.strictEqual(rel.name(3000), '+3k');
    assert.strictEqual(rel.name(-3000), '-3k');
    const audio = spectrumAxis({ rate: 12000, sided: 1 }, 7_100_000);
    assert.deepStrictEqual([audio.lo, audio.hi, audio.absolute], [0, 6000, false]);
});

t('the scope’s auto range is a 1-2-5 step, grows at once and shrinks only when well inside', () => {
    const r = (peak) => ({ a: { min: new Float32Array([-peak]), max: new Float32Array([peak]) } });
    const held = {};
    assert.strictEqual(scopeRange({ range: 'auto' }, r(0.3), held), 0.5);
    assert.strictEqual(scopeRange({ range: 'auto' }, r(0.7), held), 1);
    assert.strictEqual(scopeRange({ range: 'auto' }, r(0.45), held), 1, 'shrank on a small dip');
    assert.strictEqual(scopeRange({ range: 'auto' }, r(0.05), held), 0.1);
    assert.strictEqual(scopeRange({ range: 0.02 }, r(0.9), held), 0.02, 'a fixed range followed the trace');
    assert.strictEqual(timeLabel(0.0005), '500 µs');
    assert.strictEqual(timeLabel(0.02), '20 ms');
    assert.strictEqual(freqLabel(14_074_000), '14.074M');
    assert.strictEqual(freqLabel(14_074_260, 100), '14.0743M');
    assert.strictEqual(freqLabel(14_074_250, 1), '14.074250M');
});

t('the counter reads on the air in MHz where it can, as an offset where not', () => {
    assert.deepStrictEqual(counterText({ hz: 1234.567, gateSec: 1 }, 7_102_000), { big: '7.103\u2009234\u200957', unit: 'MHz' });
    assert.deepStrictEqual(counterText({ hz: -12.3456, gateSec: 10 }, null), { big: '-12.346', unit: 'Hz' });
    assert.deepStrictEqual(counterText({ hz: 31234.5, gateSec: 0.1 }, null), { big: '+31\u2009234.5', unit: 'Hz' });
    assert.deepStrictEqual(counterText(null, 1), { big: '—', unit: '' });
});

t('a spectrum’s marks are its peak, its median floor and the gap', () => {
    const db = new Float32Array(100).fill(-90);
    db[37] = -20;
    db[60] = -50;
    const m = spectrumMarks(db);
    assert.deepStrictEqual([m.peak, m.peakDb, m.floorDb, m.snrDb], [37, -20, -90, 70]);
    assert.strictEqual(spectrumMarks(null), null);
});

t('a selected filter offers to be measured across, and the press says which', () => {
    const pg = getPlayground(radio().player);
    const graph = g(
        [{ id: 's', type: 'signal' }, { id: 'r', type: 'real-part' }, { id: 'lp', type: 'audio-lowpass' }],
        [['s', 'out', 'r', 'in'], ['r', 'out', 'lp', 'in']],
    );
    const asked = [];
    reset();
    const el = React.createElement(Inspector, {
        pg, graph, selection: { nodes: new Set(['lp']), wire: null }, errorsByNode: {}, rates: {}, latencies: {}, stats: null,
        onParams() {}, onRemove() {}, onDuplicate() {}, summary: null, look: {}, origins: new Map(),
        onProbe() {}, onAcross: (id) => asked.push(id),
    });
    const btn = deep(el).find((n) => n.type === 'button' && /Measure gain/.test(words(n)));
    assert.ok(btn, 'no Measure button');
    btn.props.onClick();
    assert.deepStrictEqual(asked, ['lp']);
});

t('control blocks are worked on the card, and each change is one undo step per setting', () => {
    const pg = getPlayground(radio().player);
    const calls = [];
    const onParams = (id, patch, key) => calls.push([id, patch, key]);
    const card = (type, params) => {
        reset();
        return deep(React.createElement(CardVisual, { pg, node: { id: 'k', type, params }, onParams }));
    };
    const range = card('slider', { value: 5, min: 0, max: 10, step: 0.5 }).find((n) => n.type === 'input');
    range.props.onChange({ target: { value: '7.5' } });
    const toggle = card('toggle', { on: false }).find((n) => n.type === 'button');
    toggle.props.onClick();
    const select = card('dropdown', { choices: '100, 200, 300', index: 0 }).find((n) => n.type === 'select');
    select.props.onChange({ target: { value: '2' } });
    assert.deepStrictEqual(calls, [
        ['k', { value: 7.5 }, 'param:k:value'],
        ['k', { on: true }, 'param:k:on'],
        ['k', { index: 2 }, 'param:k:index'],
    ]);
    // A press on a control must not also pick the card up.
    let stopped = 0;
    range.props.onPointerDown({ stopPropagation: () => { stopped++; } });
    assert.strictEqual(stopped, 1);
});

t('a setting offers a control input, and while driven shows what drives it instead of a slider', () => {
    const pg = getPlayground(radio().player);
    const graph = g(
        [{ id: 'sl', type: 'slider' }, { id: 'sh', type: 'shift', controls: ['frequencyHz'] }],
        [['sl', 'out', 'sh', 'set:frequencyHz']],
    );
    const exposed = [];
    pg.driven = { sh: { frequencyHz: -712.5 } };
    reset();
    const el = React.createElement(Inspector, {
        pg, graph, selection: { nodes: new Set(['sh']), wire: null }, errorsByNode: {}, rates: {}, latencies: {}, stats: null,
        onParams() {}, onRemove() {}, onDuplicate() {}, summary: null, look: {}, origins: new Map(),
        onExpose: (id, param, on) => exposed.push([id, param, on]),
    });
    const text = words(el);
    assert.match(text, /driven by\s+sl\.out/);
    assert.match(text, /-712\.5/);
    assert.match(text, /Frequency \(control\)/);
    const toggles = deep(el).filter((n) => cls(n).startsWith('pg-ctl'));
    assert.ok(toggles.length >= 1);
    toggles[0].props.onClick();
    assert.deepStrictEqual(exposed, [['sh', 'frequencyHz', false]]);
    pg.driven = {};
});

t('the templates menu lists every template, and choosing one hands it over', () => {
    reset();
    const picked = [];
    const props = { onPick: (t) => picked.push(t.id) };
    let el = render(TemplatesMenu, props).tree;
    // Shut: just the button.
    assert.strictEqual(deep(el).filter((n) => cls(n) === 'pg-tpl__item').length, 0);
    const btn = deep(el).find((n) => n.type === 'button');
    btn.props.onClick();
    el = render(TemplatesMenu, props).tree;
    const items = deep(el).filter((n) => cls(n) === 'pg-tpl__item');
    assert.strictEqual(items.length, TEMPLATES.length);
    assert.match(words(items[0]), new RegExp(TEMPLATES[0].title));
    items[2].props.onClick();
    assert.deepStrictEqual(picked, [TEMPLATES[2].id]);
});

t('the toolbar offers the templates', () => {
    reset();
    openPlayground();
    const { tree, cleanups } = render(PlaygroundWindow, {}, radio());
    assert.ok(deep(tree).some((n) => cls(n) === 'pg-tpl'), 'no Templates in the toolbar');
    cleanups.forEach((f) => f());
    closePlayground();
});

t('figures read as people say them', () => {
    assert.strictEqual(formatLatency(0), '0');
    assert.strictEqual(formatLatency(0.0004), '400 µs');
    assert.strictEqual(formatLatency(0.0213), '21 ms');
    assert.strictEqual(formatLatency(0.0042), '4.2 ms');
    assert.strictEqual(formatCpu(0.00001), '<0.1%');
    assert.strictEqual(formatCpu(0.034), '3.4%');
    assert.strictEqual(formatCpu(0.27), '27%');
    assert.strictEqual(formatRate(12000), '12k');
    assert.strictEqual(formatRate(27428.57), '27.43k');
});

console.log(`\n${pass} passed`);
