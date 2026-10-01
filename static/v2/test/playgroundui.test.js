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
    RfLine, airSpan, rfLabel, rfOf, shiftLabel, hasRfLine,
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
    for (const c of ['pg', 'pg-bar', 'pg__side--left', 'pg-canvas', 'pg__side--right']) assert.ok(has(c), `no ${c}`);
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
    const offer = deep(tree).find((n) => cls(n).split(' ').includes('pg-offer'));
    assert.ok(offer, 'no offer');
    assert.match(words(offer), /graph of 1 block\./);
    cleanups.forEach((f) => f());
    offerSharedGraph(null);
    closePlayground();
});

t('a loaded shared graph can be swapped back for the one that was open, even after editing it', () => {
    reset();
    const ctx = radio();
    const pg = getPlayground(ctx.player);
    pg.setGraph(g([{ id: 'mine', type: 'signal', x: 40, y: 80 }]));
    const before = JSON.stringify(pg.graph);
    offerSharedGraph({ graph: g([{ id: 's', type: 'signal' }]), errors: [] });
    let r = render(PlaygroundWindow, {}, ctx);
    const btn = (label) => deep(r.tree).find((n) => n.props && n.props.onClick && words(n) === label);
    btn('Load it').props.onClick();
    assert.deepStrictEqual(pg.graph.nodes.map((n) => n.id), ['s']);
    r.cleanups.forEach((f) => f());
    // Rendered again on the same hook state: the notice is the window's own.
    r = render(PlaygroundWindow, {}, ctx);
    assert.match(words(deep(r.tree).find((n) => cls(n) === 'pg-notice')), /Loaded the shared graph/);
    pg.setGraph(g([{ id: 's', type: 'signal' }, { id: 't', type: 'signal' }]));
    btn('Put mine back').props.onClick();
    assert.strictEqual(JSON.stringify(pg.graph), before, 'the graph that was open did not come back');
    r.cleanups.forEach((f) => f());
    closePlayground();
});

t('New and Import ask before replacing a graph, and offer Export first; an empty canvas is not asked about', () => {
    reset();
    const ctx = radio();
    const pg = getPlayground(ctx.player);
    pg.setGraph(g([{ id: 'mine', type: 'signal', x: 40, y: 80 }]));
    const before = JSON.stringify(pg.graph);
    let saved = null;
    window.ubersdrSaveFile = async (blob) => { saved = blob; };
    let r = render(PlaygroundWindow, {}, ctx);
    const btn = (label) => deep(r.tree).find((n) => n.props && n.props.onClick && words(n) === label);
    const dialog = () => deep(r.tree).find((n) => cls(n).split(' ').includes('pg-confirm'));
    const again = () => { r.cleanups.forEach((f) => f()); r = render(PlaygroundWindow, {}, ctx); };

    btn('New').props.onClick();
    again();
    assert.ok(dialog(), 'New did not ask');
    assert.match(words(dialog()), /Start a new graph\?.*1 block,/);
    assert.strictEqual(JSON.stringify(pg.graph), before, 'New cleared before the answer');
    btn('Export').props.onClick();
    assert.ok(saved, 'Export in the question saved nothing');
    btn('Cancel').props.onClick();
    again();
    assert.ok(!dialog(), 'Cancel left the question up');
    assert.strictEqual(JSON.stringify(pg.graph), before, 'Cancel changed the graph');

    btn('New').props.onClick();
    again();
    btn('Clear it').props.onClick();
    again();
    assert.strictEqual(pg.graph.nodes.length, 0, 'Clear it did not clear');
    btn('Put mine back').props.onClick();
    assert.strictEqual(JSON.stringify(pg.graph), before, 'a cleared graph could not be put back');

    // Import asks too, and only its answer opens the file picker.
    let picked = 0;
    const input = deep(r.tree).find((n) => n.type === 'input' && n.props && n.props.type === 'file');
    input.props.ref.current = { click: () => { picked++; } };
    again();
    btn('Import').props.onClick();
    again();
    assert.match(words(dialog()), /Import a graph\?/);
    assert.strictEqual(picked, 0, 'the file picker opened before the answer');
    btn('Choose file…').props.onClick();
    assert.strictEqual(picked, 1);

    // Nothing to lose: no question.
    again();
    pg.setGraph(g([]));
    again();
    btn('New').props.onClick();
    btn('Import').props.onClick();
    again();
    assert.ok(!dialog(), 'an empty canvas was asked about');
    assert.strictEqual(picked, 2);
    r.cleanups.forEach((f) => f());
    closePlayground();
});

t('double-clicking a block selects it and opens the folded right-hand panel', () => {
    reset();
    const ctx = radio();
    const pg = getPlayground(ctx.player);
    pg.setGraph(g([{ id: 'a', type: 'signal', x: 0, y: 0 }, { id: 'b', type: 'gain', x: 400, y: 0 }]));
    localStorage.setItem('ubersdr.v2.playground.sides', JSON.stringify({ left: false, right: true }));
    let r = render(PlaygroundWindow, {}, ctx);
    const body = () => deep(r.tree).find((n) => cls(n).split(' ').includes('pg__body'));
    assert.ok(cls(body()).includes('is-right-shut'), 'the right panel did not start folded');
    const canvas = deep(r.tree).find((n) => n.props && n.props.onDoubleClick && cls(n).split(' ').includes('pg-canvas'));
    assert.ok(canvas, 'the canvas takes no double-click');
    // On the gain block, with the target the canvas itself, as under pointer capture.
    // The view starts at (32, 32) until fitted; fitting needs a real box.
    const view = deep(r.tree).find((n) => cls(n) === 'pg-world').props.style.transform;
    const [, vx, vy, z] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(view).map(Number);
    canvas.props.onDoubleClick({ clientX: vx + (420 * z), clientY: vy + (20 * z), target: { closest: () => null } });
    r.cleanups.forEach((f) => f());
    r = render(PlaygroundWindow, {}, ctx);
    assert.ok(!cls(body()).includes('is-right-shut'), 'the right panel stayed folded');
    assert.match(words(deep(r.tree).find((n) => cls(n).includes('pg__side--right'))), /Gain/);

    // On empty canvas: nothing.
    localStorage.setItem('ubersdr.v2.playground.sides', JSON.stringify({ left: false, right: true }));
    reset();
    r = render(PlaygroundWindow, {}, ctx);
    deep(r.tree).find((n) => n.props && n.props.onDoubleClick).props.onDoubleClick({ clientX: -5000, clientY: -5000, target: { closest: () => null } });
    r.cleanups.forEach((f) => f());
    r = render(PlaygroundWindow, {}, ctx);
    assert.ok(cls(body()).includes('is-right-shut'), 'a double-click on nothing opened the panel');
    r.cleanups.forEach((f) => f());
    localStorage.removeItem('ubersdr.v2.playground.sides');
    closePlayground();
});

t('the IQ stream block tunes the receiver and sets the graph’s IQ width with the Receiver panel’s controls', () => {
    const pg = getPlayground(radio().player);
    const graph = g([{ id: 'a', type: 'iq-in' }, { id: 'b', type: 'iq-in' }, { id: 'c', type: 'gain' }]);
    const view = (ctx, gr = graph) => {
        reset();
        window.__testContext = ctx;
        const el = React.createElement(Inspector, {
            pg, graph: gr, selection: { nodes: new Set(['a']), wire: null }, errorsByNode: {}, rates: { a: 12000 },
            latencies: {}, stats: null, onParams: ctx.onParams, onRemove() {}, onDuplicate() {}, summary: null,
        });
        return deep(el);
    };
    const edits = [];
    const ctx = radio({ allowedIQModes: ['iq48', 'iq96'], onParams: (id, patch, why) => edits.push([id, patch, why]) });
    ctx.onParams = (id, patch, why) => edits.push([id, patch, why]);
    let all = view(ctx);
    const dial = all.find((n) => cls(n).split(' ').includes('dial'));
    assert.ok(dial, 'no frequency dial');
    assert.match(words(dial).replace(/\s/g, ''), /7\.100\.000/, 'the dial is not on the receiver’s frequency');
    const widths = all.filter((n) => n.props && n.props.onClick && /^\d+ kHz$/.test(words(n)));
    assert.deepStrictEqual(widths.map(words), ['12 kHz', '48 kHz', '96 kHz'], 'offered widths this visit may not have');
    widths[2].props.onClick();
    assert.deepStrictEqual(edits, [['a', { width: 'iq96' }, 'iq-width'], ['b', { width: 'iq96' }, 'iq-width']], 'not every IQ stream block was set');

    // A graph built for a width this visit may not have says so.
    const wide = g([{ id: 'a', type: 'iq-in', params: { width: 'iq384' } }]);
    assert.match(words({ type: 'div', props: {}, children: view(radio({ allowedIQModes: ['iq48'] }), wide).filter((n) => cls(n) === 'pg-insp__note') }), /384 kHz IQ, which this receiver does not offer you/);
    // And one that will switch when it starts, from a mode that is not IQ.
    const usb = radio({ allowedIQModes: ['iq96'] });
    usb.tuning = { ...usb.tuning, mode: 'usb' };
    assert.match(words({ type: 'div', props: {}, children: view(usb, g([{ id: 'a', type: 'iq-in', params: { width: 'iq96' } }])).filter((n) => cls(n) === 'pg-insp__note') }), /goes to 96 kHz IQ when the graph starts/);
});

t('the graph’s IQ width and the receiver’s follow each other, each only when it is the one that changed', () => {
    const ctx = radio({ allowedIQModes: ['iq96'] });
    const pg = getPlayground(ctx.player);
    pg.setGraph(g([{ id: 'iq', type: 'iq-in' }]));
    reset();
    let r = render(P.PlaygroundWatch, {}, ctx);
    assert.deepStrictEqual(ctx.calls, [], 'mounting changed the mode');
    // Chosen on the block, with the receiver in IQ: the receiver follows.
    pg.setParams('iq', { width: 'iq96' });
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.deepStrictEqual(ctx.calls, [['setMode', 'iq96']]);
    ctx.tuning = { ...ctx.tuning, mode: 'iq96' };
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.deepStrictEqual(ctx.calls, [['setMode', 'iq96']], 'the two chased each other');
    // A width this visit may not have is left alone.
    pg.setParams('iq', { width: 'iq384' });
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.strictEqual(ctx.calls.length, 1, 'switched to a width that is not allowed');
    // The Receiver panel changing the width while the graph runs: written into the graph.
    pg.setParams('iq', { width: 'iq96' });
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    ctx.calls.length = 0;
    pg.active = true;
    ctx.tuning = { ...ctx.tuning, mode: 'iq' };
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.strictEqual(pg.graph.nodes[0].params.width, 'iq', 'the graph did not take the receiver’s width');
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.deepStrictEqual(ctx.calls, [], 'writing the receiver’s width moved the receiver');
    pg.active = false;
    // Not running: the Receiver panel's choice stays out of the graph.
    ctx.tuning = { ...ctx.tuning, mode: 'iq96' };
    r.cleanups.forEach((f) => f());
    r = render(P.PlaygroundWatch, {}, ctx);
    assert.strictEqual(pg.graph.nodes[0].params.width, 'iq');
    r.cleanups.forEach((f) => f());
    closePlayground();
});

t('Start puts the receiver on the graph’s IQ width where this visit may have it, and plain IQ where not', () => {
    const pg = getPlayground(radio().player);
    const realStart = pg.start;
    pg.start = () => {};
    try {
        for (const [allowed, mode, want] of [[['iq96'], 'usb', 'iq96'], [[], 'usb', 'iq'], [['iq96'], 'iq', 'iq96'], [['iq96'], 'iq96', null]]) {
            const ctx = radio({ allowedIQModes: allowed });
            ctx.tuning = { ...ctx.tuning, mode };
            pg.setGraph(g([{ id: 'iq', type: 'iq-in', params: { width: 'iq96' } }]));
            reset();
            const r = render(PlaygroundWindow, {}, ctx);
            deep(r.tree).find((n) => n.props && n.props.onClick && words(n) === 'Start').props.onClick();
            assert.deepStrictEqual(ctx.calls, want ? [['setMode', want]] : [], `from ${mode} with ${JSON.stringify(allowed)}`);
            r.cleanups.forEach((f) => f());
        }
    } finally {
        pg.start = realStart;
        closePlayground();
    }
});

t('a shared graph starts when loaded, where the receiver is up and its IQ width is available here', () => {
    const pg = getPlayground(radio().player);
    const realStart = pg.start;
    let started = 0;
    pg.start = () => { started++; };
    const shared = (width) => g([{ id: 'iq', type: 'iq-in', params: { width } }, { id: 'gn', type: 'gain' }], [['iq', 'out', 'gn', 'in']]);
    const load = (graph, over, before = (ctx) => ctx) => {
        started = 0;
        const ctx = before(radio(over));
        pg.setGraph(g([{ id: 'mine', type: 'signal' }]));
        offerSharedGraph({ graph, errors: [] });
        reset();
        let r = render(PlaygroundWindow, {}, ctx);
        deep(r.tree).find((n) => n.props && n.props.onClick && words(n) === 'Load it').props.onClick();
        r.cleanups.forEach((f) => f());
        r = render(PlaygroundWindow, {}, ctx);
        const note = words(deep(r.tree).find((n) => cls(n) === 'pg-notice'));
        r.cleanups.forEach((f) => f());
        return { ctx, note };
    };
    try {
        let x = load(shared('iq96'), { allowedIQModes: ['iq96'] });
        assert.strictEqual(started, 1, 'not started');
        assert.deepStrictEqual(x.ctx.calls, [['setMode', 'iq96']]);
        assert.match(x.note, /started it/);
        assert.deepStrictEqual(pg.graph.nodes.map((n) => n.id), ['iq', 'gn'], 'started the wrong graph');

        x = load(shared('iq96'), { allowedIQModes: [] });
        assert.strictEqual(started, 0, 'started at a width it was not built for');
        assert.deepStrictEqual(x.ctx.calls, []);
        assert.match(x.note, /not started: it is built for IQ 96, which this receiver does not offer you/);

        x = load(shared('iq'), { audioState: 'connecting' });
        assert.strictEqual(started, 0, 'started with the receiver not up');
        assert.match(x.note, /Press Start once the receiver is running/);

        x = load(g([{ id: 's', type: 'signal' }]), {});
        assert.strictEqual(started, 0, 'a graph that runs by itself was started');

        // Already running: the new graph carries on in the running engine.
        pg.active = true;
        x = load(shared('iq'), {});
        pg.active = false;
        assert.strictEqual(started, 0, 'started twice');
        assert.match(x.note, /^Loaded the shared graph\./);
    } finally {
        pg.start = realStart;
        pg.active = false;
        closePlayground();
    }
});

t('the IQ stream’s age on arriving is its latency, and every block after it counts it', () => {
    const graph = g(
        [{ id: 'iq', type: 'iq-in' }, { id: 'lp', type: 'lowpass' }, { id: 'a', type: 'to-audio' }, { id: 's', type: 'signal' }, { id: 'gn', type: 'gain' }],
        [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in'], ['s', 'out', 'gn', 'in']],
    );
    const rt = new (require('./.build/playground.cjs').Runtime)(graph, 12000, { now: () => 0 });
    const latencies = {};
    for (const n of graph.nodes) latencies[n.id] = rt.latencyOf(n.id);
    const info = { latencies, order: rt.plan.order, inputs: rt.plan.inputs };
    const lp = latencies.lp.own;
    assert.ok(lp > 0);
    let l = P.withArrival(info, graph, 0.25);
    assert.deepStrictEqual([l.iq.own, l.iq.total], [0.25, 0.25]);
    assert.ok(Math.abs(l.lp.total - (0.25 + lp)) < 1e-12, 'the filter does not count the arrival');
    assert.ok(Math.abs(l.a.total - (0.25 + lp)) < 1e-12);
    assert.deepStrictEqual([l.gn.own, l.gn.total], [0, 0], 'a generator’s path took the receiver’s age');
    // Not arriving: the IQ stream's own figure is unknown, not nought.
    l = P.withArrival(info, graph, null);
    assert.deepStrictEqual([l.iq.own, l.iq.total], [null, null]);
    assert.strictEqual(formatLatency(l.iq.own), '—');
    assert.ok(Math.abs(l.lp.total - lp) < 1e-12);
});

t('the zoom buttons zoom about the middle, or bring the selected blocks to it, within the limits', () => {
    const { zoomToward, ZOOM_MAX, ZOOM_MIN } = P;
    const view = { x: 100, y: 50, zoom: 1 };
    // Nothing selected: the point in the middle of the canvas stays there.
    const v = zoomToward(view, 800, 600, 2);
    const mid = (vw) => [(400 - vw.x) / vw.zoom, (300 - vw.y) / vw.zoom];
    assert.deepStrictEqual(mid(v), mid(view));
    assert.strictEqual(v.zoom, ZOOM_MAX);
    // A block selected: its centre comes to the middle.
    const n = { id: 'b', type: 'gain', x: 1000, y: 700 };
    const w = zoomToward(view, 800, 600, 1.4, { nodes: [n] });
    const c = [n.x + nodeWidth(n.type) / 2, n.y + nodeHeight(n) / 2];
    assert.ok(Math.abs(w.x + c[0] * w.zoom - 400) <= 0.5 && Math.abs(w.y + c[1] * w.zoom - 300) <= 0.5, `not centred: ${JSON.stringify(w)}`);
    assert.strictEqual(zoomToward(view, 800, 600, 0.01).zoom, ZOOM_MIN);

    // On the window: top left of the canvas, and pressing them moves the view.
    reset();
    const ctx = radio();
    getPlayground(ctx.player).setGraph(g([{ id: 'a', type: 'gain', x: 0, y: 0 }, { id: 'b', type: 'gain', x: 900, y: 600 }]));
    let r = render(PlaygroundWindow, {}, ctx);
    const transform = () => deep(r.tree).find((x) => cls(x) === 'pg-world').props.style.transform;
    const zoomOf = () => Number(/scale\(([\d.]+)\)/.exec(transform())[1]);
    const btn = (label) => deep(r.tree).find((x) => x.props && x.props['aria-label'] === label);
    assert.ok(deep(r.tree).find((x) => cls(x) === 'pg-zoom'), 'no zoom buttons');
    // Once more, for the view the opening fit chose.
    r.cleanups.forEach((f) => f());
    r = render(PlaygroundWindow, {}, ctx);
    const z0 = zoomOf();
    btn('Zoom in').props.onClick();
    r.cleanups.forEach((f) => f());
    r = render(PlaygroundWindow, {}, ctx);
    assert.ok(zoomOf() > z0, 'Zoom in did not');
    btn('Zoom out').props.onClick();
    btn('Zoom out').props.onClick();
    r.cleanups.forEach((f) => f());
    r = render(PlaygroundWindow, {}, ctx);
    assert.ok(zoomOf() < z0, 'Zoom out did not');
    r.cleanups.forEach((f) => f());
    closePlayground();
});

t('wires are taken and dropped by distance, moved by either end, and only changed on the drop', () => {
    // The canvas as the component rendered, so its own drag state is kept
    // between renders, with the window's part — the graph, the edits, the
    // selection — played here.
    reset();
    let graph = g(
        [{ id: 's1', type: 'signal', x: 0, y: 0 }, { id: 's2', type: 'signal', x: 0, y: 300 },
            { id: 'g1', type: 'shift', x: 500, y: 0 }, { id: 'g2', type: 'shift', x: 500, y: 300 }],
        [['s1', 'out', 'g1', 'in']],
    );
    let edits = 0;
    let picked = null;
    const view = { x: 40, y: 30, zoom: 0.5 };
    const props = () => ({
        pg: getPlayground(radio().player), graph, view, setView() {}, selection: { nodes: new Set(), wire: picked ? picked.wire : null },
        setPicked: (v) => { picked = v; }, onEdit: (next) => { graph = next; edits++; }, onMoved() {},
        errorsByNode: {}, rates: {}, latencies: {}, stats: null, look: null, origins: null, onParams() {},
    });
    let r = render(P.Canvas, props(), radio());
    const again = () => { r.cleanups.forEach((f) => f()); r = render(P.Canvas, props(), radio()); };
    // A port on screen, nudged by (dx, dy) screen pixels.
    const at = (id, side, dx = 0, dy = 0) => {
        const p = portPosition(graph.nodes.find((n) => n.id === id), side, 0);
        return { x: view.x + p.x * view.zoom + dx, y: view.y + p.y * view.zoom + dy };
    };
    const root = () => deep(r.tree).find((x) => x.props && x.props.onPointerMove);
    const ev = (p) => ({ button: 0, pointerId: 1, clientX: p.x, clientY: p.y, shiftKey: false, target: { closest: () => null } });
    const wires = () => graph.wires.map((w) => w.join('.')).sort();
    const drag = (from, to, down = (e) => root().props.onPointerDown(e)) => {
        edits = 0;
        down(ev(from));
        again();
        root().props.onPointerMove(ev({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }));
        again();
        root().props.onPointerMove(ev(to));
        again();
        root().props.onPointerUp(ev(to));
        again();
    };

    // From an output, pressed beside the dot rather than on it, to well short of an input.
    drag(at('s2', 'out', 9, 5), at('g2', 'in', -15, 12));
    assert.deepStrictEqual(wires(), ['s1.out.g1.in', 's2.out.g2.in']);

    // A click on a wired input: the wire stays, and is selected.
    edits = 0;
    root().props.onPointerDown(ev(at('g1', 'in')));
    root().props.onPointerUp(ev(at('g1', 'in')));
    again();
    assert.strictEqual(edits, 0, 'a click changed the graph');
    assert.strictEqual(graph.wires[picked.wire].join('.'), 's1.out.g1.in', 'the click did not select its wire');

    // Its input end, to g2: replaces what was there, as one edit — one undo step.
    drag(at('g1', 'in'), at('g2', 'in', 6, -6));
    assert.deepStrictEqual(wires(), ['s1.out.g2.in']);
    assert.strictEqual(edits, 1);

    // Mid-drag, the wire being moved is not drawn where it was.
    root().props.onPointerDown(ev(at('g2', 'in')));
    root().props.onPointerMove(ev(at('g2', 'in', -60, 40)));
    again();
    assert.strictEqual(deep(r.tree).filter((x) => cls(x) === 'pg-wire__hit').length, 0, 'the lifted wire was still drawn');
    assert.strictEqual(deep(r.tree).filter((x) => /pg-wire--ghost/.test(cls(x))).length, 1, 'no wire follows the pointer');
    root().props.onPointerUp(ev(at('g2', 'in')));
    again();
    assert.deepStrictEqual(wires(), ['s1.out.g2.in'], 'dropped back where it was, it was changed');

    // Taken along its length near the output end: the output end moves, to s2.
    const a = at('s1', 'out');
    const b = at('g2', 'in');
    const near = { x: a.x + (b.x - a.x) * 0.15, y: a.y + (b.y - a.y) * 0.15 };
    drag(near, at('s2', 'out', -8, 4), (e) => {
        const hit = deep(r.tree).find((x) => cls(x) === 'pg-wire__hit');
        hit.props.onPointerDown({ ...e, stopPropagation() {} });
    });
    assert.deepStrictEqual(wires(), ['s2.out.g2.in']);
    assert.strictEqual(edits, 1);

    // Dropped on nothing: removed.
    drag(at('g2', 'in'), { x: at('g2', 'in').x - 150, y: at('g2', 'in').y + 120 });
    assert.deepStrictEqual(wires(), []);

    // Backwards, from an empty input to an output.
    drag(at('g1', 'in', -5, 0), at('s1', 'out', 10, 10));
    assert.deepStrictEqual(wires(), ['s1.out.g1.in']);
    r.cleanups.forEach((f) => f());
});

t('the port a dragged wire would land on is lit, green where it can go and red where not', () => {
    reset();
    const graph = g(
        [{ id: 's', type: 'signal', x: 0, y: 0 }, { id: 'sh', type: 'shift', x: 400, y: 0 }, { id: 'gn', type: 'gain', x: 400, y: 300 }],
    );
    const props = {
        pg: getPlayground(radio().player), graph, view: { x: 0, y: 0, zoom: 1 }, setView() {}, selection: { nodes: new Set(), wire: null },
        setPicked() {}, onEdit() {}, onMoved() {}, errorsByNode: {}, rates: {}, latencies: {}, stats: null, look: null, origins: null, onParams() {},
    };
    let r = render(P.Canvas, props, radio());
    const pt = (id, side, dx, dy) => {
        const p = portPosition(graph.nodes.find((n) => n.id === id), side, 0);
        return { button: 0, pointerId: 1, clientX: p.x + dx, clientY: p.y + dy, target: { closest: () => null } };
    };
    const root = () => deep(r.tree).find((x) => x.props && x.props.onPointerMove);
    const lit = () => deep(r.tree).filter((x) => /is-(target|refused)/.test(cls(x))).map((x) => cls(x).match(/is-(target|refused)/)[0]);
    root().props.onPointerDown(pt('s', 'out', 6, 0));
    root().props.onPointerMove(pt('sh', 'in', -10, 8));
    r = render(P.Canvas, props, radio());
    assert.deepStrictEqual(lit(), ['is-target']);
    // A real input, for a complex wire: not offered at all.
    root().props.onPointerMove(pt('gn', 'in', -4, 4));
    r = render(P.Canvas, props, radio());
    assert.deepStrictEqual(lit(), []);
    root().props.onPointerUp(pt('gn', 'in', -4, 4));
    r.cleanups.forEach((f) => f());
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
        // The IQ stream's one setting is the receiver's width, worked with the
        // Receiver panel's own buttons in a section of its own.
        if (def.type === 'iq-in') assert.ok(/Receiver.*IQ width.*12 kHz/.test(text), `iq-in: no receiver controls: ${text}`);
        else if (Object.keys(def.params).length) assert.ok(text.includes('Settings'), `${def.type}: no settings`);
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

// ── where on the air ────────────────────────────────────────────────────────

t('the RF and offset labels read as a dial does', () => {
    assert.strictEqual(rfLabel(14074000), '14.074 000 MHz');
    assert.strictEqual(rfLabel(14075500.4), '14.075 500 MHz');
    assert.strictEqual(rfLabel(519000), '519.000 kHz');
    assert.strictEqual(shiftLabel(-1000), '−1 000 Hz');
    assert.strictEqual(shiftLabel(1500), '+1 500 Hz');
    assert.strictEqual(shiftLabel(0), '±0 Hz');
    assert.strictEqual(shiftLabel(125000), '+125 kHz');
    const c = airSpan(14074000, 48000);
    assert.strictEqual(c.range, '14.050–14.098 MHz');
    assert.strictEqual(c.width, '48 kHz wide');
    assert.strictEqual(airSpan(518000, 12000).range, '512.0–524.0 kHz');
    assert.strictEqual(airSpan(0, 48000), null);
});

const rfChain = () => g(
    [
        { id: 'iq', type: 'iq-in' },
        { id: 'shift', type: 'shift', params: { frequencyHz: -1000 } },
        { id: 'lp', type: 'lowpass', params: { cutoffHz: 3000 } },
        { id: 'psk', type: 'psk31-decoder', params: { offsetHz: 500 } },
        { id: 'demod', type: 'demodulator', params: { mode: 'usb', offsetHz: -2000 } },
        { id: 'am', type: 'envelope' },
        { id: 'spec', type: 'iq-spectrum' },
    ],
    [
        ['iq', 'out', 'shift', 'in'], ['shift', 'out', 'lp', 'in'], ['lp', 'out', 'psk', 'in'],
        ['iq', 'out', 'demod', 'in'], ['lp', 'out', 'am', 'in'], ['lp', 'out', 'spec', 'in'],
    ],
);

t('every stream block knows its RF and its offset from the centre, all down the chain', () => {
    const graph = rfChain();
    const at = (id, live) => rfOf(graph, graph.nodes.find((n) => n.id === id), 14074000, null, live);
    // Shifting down by 1 kHz brings what was 1 kHz up to zero.
    assert.deepStrictEqual([at('shift').hz, at('shift').shiftHz], [14075000, 1000]);
    // A filter moves nothing.
    assert.deepStrictEqual([at('lp').hz, at('lp').shiftHz], [14075000, 1000]);
    // A decoder listens at its offset into what it is fed.
    assert.deepStrictEqual([at('psk').hz, at('psk').shiftHz, at('psk').listening], [14075500, 1500, true]);
    assert.ok(at('psk').live, 'auto-tune moves it');
    // …and follows auto-tune to where it pulled itself.
    assert.strictEqual(at('psk', { driven: {}, reading: { tunedHz: 512 } }).hz, 14075512);
    assert.deepStrictEqual([at('demod').hz, at('demod').shiftHz], [14072000, -2000]);
    // A detector works at the zero of what feeds it.
    assert.strictEqual(at('am').hz, 14075000);
    assert.strictEqual(at('iq'), null, 'a source says it on its own card');
    assert.ok(hasRfLine('shift') && hasRfLine('psk31-decoder') && hasRfLine('demodulator'));
    assert.ok(!hasRfLine('iq-in') && !hasRfLine('iq-spectrum') && !hasRfLine('audio-out') && !hasRfLine('slider'));
});

t('a shift a control drives is unknown until the engine says where it is', () => {
    const graph = g(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'shift', type: 'shift', params: { frequencyHz: 0 }, controls: ['frequencyHz'] },
            { id: 'k', type: 'number', params: { value: -700 } },
            { id: 'lp', type: 'lowpass' },
        ],
        [['iq', 'out', 'shift', 'in'], ['k', 'out', 'shift', 'set:frequencyHz'], ['shift', 'out', 'lp', 'in']],
    );
    const lp = graph.nodes.find((n) => n.id === 'lp');
    const still = rfOf(graph, lp, 7000000);
    assert.strictEqual(still.hz, null);
    assert.ok(still.live);
    const live = rfOf(graph, lp, 7000000, null, { driven: { shift: { frequencyHz: -700 } } });
    assert.deepStrictEqual([live.hz, live.shiftHz], [7000700, 700]);
});

t('after a generator there is no RF to show, and the line says so', () => {
    const graph = g(
        [{ id: 'gen', type: 'signal' }, { id: 'lp', type: 'lowpass' }],
        [['gen', 'out', 'lp', 'in']],
    );
    const info = rfOf(graph, graph.nodes[1], 14074000);
    assert.strictEqual(info.hz, null);
    assert.strictEqual(info.shiftHz, null);
    const pg = getPlayground(radio().player);
    reset();
    assert.strictEqual(words(React.createElement(RfLine, { pg, graph, node: graph.nodes[1], dialHz: 14074000 })), 'RF —');
});

t('the RF line renders on the card, and the source card shows its range', () => {
    const graph = rfChain();
    const pg = getPlayground(radio().player);
    pg.readings = {};
    reset();
    const line = words(React.createElement(RfLine, { pg, graph, node: graph.nodes.find((n) => n.id === 'psk'), dialHz: 14074000 }));
    assert.ok(line.includes('14.075 500 MHz') && line.includes('+1 500 Hz'), line);
    reset();
    const src = words(React.createElement(CardVisual, { pg, node: graph.nodes[0], look: { dialHz: 14074000 }, rate: 48000 }));
    assert.ok(src.includes('14.050–14.098 MHz') && src.includes('48 kHz wide'), src);
    reset();
    assert.ok(words(React.createElement(CardVisual, { pg, node: graph.nodes[0], look: { dialHz: 0 }, rate: 48000 })).includes('Not tuned'));
});

t('both side panels fold away to a rail and open again, and are remembered', () => {
    localStorage.removeItem('ubersdr.v2.playground.sides');
    openPlayground();
    reset();
    let r = render(PlaygroundModal, {}, radio());
    const find = (c) => deep(r.tree).find((n) => cls(n).split(' ').includes(c));
    const heads = () => deep(r.tree).filter((n) => cls(n) === 'pg__side-head');
    assert.strictEqual(heads().length, 2);
    assert.ok(!cls(find('pg__body')).includes('shut'));
    heads()[0].props.onClick();
    r.cleanups.forEach((f) => f());
    reset();
    r = render(PlaygroundModal, {}, radio());
    assert.ok(cls(find('pg__body')).includes('is-left-shut'), cls(find('pg__body')));
    assert.ok(cls(find('pg__side--left')).includes('is-shut'));
    assert.ok(!deep(r.tree).some((n) => cls(n) === 'pg-pal__item'), 'the palette is still drawn while folded');
    assert.ok(words(find('pg__side--left')).includes('Blocks'));
    assert.strictEqual(JSON.parse(localStorage.getItem('ubersdr.v2.playground.sides')).left, true);
    // The other one too, then both back.
    heads()[0].props.onClick();
    r.cleanups.forEach((f) => f());
    reset();
    r = render(PlaygroundModal, {}, radio());
    assert.ok(cls(find('pg__body')).includes('is-left-shut') && cls(find('pg__body')).includes('is-right-shut'));
    for (const rail of deep(r.tree).filter((n) => cls(n) === 'pg__rail')) rail.props.onClick();
    r.cleanups.forEach((f) => f());
    reset();
    r = render(PlaygroundModal, {}, radio());
    assert.ok(!cls(find('pg__body')).includes('shut'));
    r.cleanups.forEach((f) => f());
    closePlayground();
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
    assert.strictEqual(formatLatency(0), '0 ms');
    assert.strictEqual(formatLatency(0.0004), '400 µs');
    assert.strictEqual(formatLatency(0.0213), '21 ms');
    assert.strictEqual(formatLatency(0.0042), '4.2 ms');
    assert.strictEqual(formatCpu(0.00001), '<0.1%');
    assert.strictEqual(formatCpu(0.034), '3.4%');
    assert.strictEqual(formatCpu(0.27), '27%');
    assert.strictEqual(formatRate(12000), '12k');
    assert.strictEqual(formatRate(27428.57), '27.43k');
});

// ── where blocks are, through export, import and a link ─────────────────────

// Through the editor itself, as a person does it: drag a block with the
// pointer, press Export, import the file, share it and open the link.
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

(async () => {
    await tAsync('a block dragged on the canvas stays where it was put, through export, import and a shared link', async () => {
        const { encodeShare, decodeShare } = P;
        localStorage.removeItem('ubersdr.v2.playground.sides');
        const ctx = radio();
        const pg = getPlayground(ctx.player);
        pg.setGraph(g(
            [{ id: 'iq', type: 'iq-in', x: 0, y: 0 }, { id: 'lp', type: 'lowpass', x: 300, y: 0 }, { id: 'a', type: 'to-audio', x: 600, y: 0 }],
            [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'a', 'in']],
        ));
        openPlayground();
        reset();
        let r = render(PlaygroundWindow, { onClose() {} }, ctx);
        const canvas = deep(r.tree).find((n) => n.props && n.props.onPointerDown && cls(n).split(' ').includes('pg-canvas'));
        assert.ok(canvas, 'no canvas');
        const onCard = (id) => ({ closest: (sel) => (sel === '[data-node]' ? { getAttribute: () => id } : null) });
        const ev = (x, y, target) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, shiftKey: false, target: target || { closest: () => null } });
        canvas.props.onPointerDown(ev(400, 100, onCard('lp')));
        canvas.props.onPointerMove(ev(440, 160));
        canvas.props.onPointerMove(ev(520, 300));
        canvas.props.onPointerUp(ev(520, 300));
        const lp = () => pg.graph.nodes.find((n) => n.id === 'lp');
        const moved = { x: lp().x, y: lp().y };
        assert.ok(moved.x !== 300 && moved.y !== 0, `the drag did not move it: ${JSON.stringify(moved)}`);

        // Export, by the button.
        let saved = null;
        globalThis.window = globalThis.window || {};
        window.ubersdrSaveFile = async (blob) => { saved = await blob.text(); };
        r.cleanups.forEach((f) => f());
        reset();
        r = render(PlaygroundWindow, { onClose() {} }, ctx);
        const btn = (label) => deep(r.tree).find((n) => n.props && n.props.onClick && words(n) === label);
        btn('Export').props.onClick();
        await new Promise((res) => setTimeout(res, 0));
        assert.ok(saved, 'nothing exported');
        const file = JSON.parse(saved);
        for (const n of file.nodes) assert.ok('x' in n && 'y' in n, `${n.id} was written without its position`);
        assert.deepStrictEqual(file.nodes.find((n) => n.id === 'lp'), { id: 'lp', type: 'lowpass', x: moved.x, y: moved.y });

        // Somewhere else, then import the file back.
        pg.setGraph(g([{ id: 'iq', type: 'iq-in' }]));
        const input = deep(r.tree).find((n) => n.type === 'input' && n.props && n.props.type === 'file');
        input.props.onChange({ target: { files: [{ name: 'g.json', text: async () => saved }], value: 'x' } });
        await new Promise((res) => setTimeout(res, 0));
        assert.deepStrictEqual({ x: lp().x, y: lp().y }, moved, 'import moved it');
        assert.deepStrictEqual(pg.graph.nodes.find((n) => n.id === 'iq'), { id: 'iq', type: 'iq-in', params: { width: 'iq' }, x: 0, y: 0 });

        // And a link.
        const shared = await decodeShare(await encodeShare(pg.graph));
        assert.deepStrictEqual(shared.graph.nodes.map((n) => [n.id, n.x, n.y]), pg.graph.nodes.map((n) => [n.id, n.x, n.y]));
        r.cleanups.forEach((f) => f());
        closePlayground();
    });
    await tAsync('a shared link waits for the Start overlay: the playground opens once the receiver is running', async () => {
        const code = await P.encodeShare(g([{ id: 's', type: 'signal', x: 10, y: 20 }]));
        const loc = { origin: 'http://x', pathname: '/v2/', search: `?freq=7100000&playground=${code}`, hash: '' };
        globalThis.location = loc;
        globalThis.history = { state: null, replaceState(st, t, url) { loc.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } };
        offerSharedGraph(null);
        closePlayground();
        reset();
        let r = render(P.PlaygroundWatch, {}, radio({ running: false }));
        await new Promise((res) => setTimeout(res, 20));
        assert.strictEqual(loc.search, '?freq=7100000', 'the code was left in the address');
        r.cleanups.forEach((f) => f());
        r = render(P.PlaygroundWatch, {}, radio({ running: false }));
        assert.strictEqual(playgroundUiState().open, false, 'the playground opened over the Start overlay');
        assert.strictEqual(playgroundUiState().pending, null);
        r.cleanups.forEach((f) => f());
        r = render(P.PlaygroundWatch, {}, radio({ running: true }));
        assert.strictEqual(playgroundUiState().open, true, 'the playground did not open once running');
        assert.deepStrictEqual(playgroundUiState().pending.graph.nodes.map((n) => [n.id, n.x, n.y]), [['s', 10, 20]]);
        r.cleanups.forEach((f) => f());
        offerSharedGraph(null);
        closePlayground();
    });
    console.log(`\n${pass} passed`);
})();
