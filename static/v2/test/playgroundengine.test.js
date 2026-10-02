// The playground on the page: the worker's protocol, where its audio goes, what
// it records, how it is shared, and that it never runs alongside the IQ Demod
// panel's demodulators.
//
// No browser here, so the audio graph is a stand-in that records what was
// connected to what — the same stand-in the IQ Demod engine's routing test
// uses — and the worker runs inline, through the very core the real worker
// runs.

const assert = require('assert');

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const {
    IQDemod, planFor, resetIQOwner, CHANNEL_PAN, BLOCK_BY_TYPE,
    GRAPH_VERSION, parseGraph, serializeGraph, Runtime, graphForPlan,
    READ_EVERY_MS, createWorkerCore, createHost,
    MAX_RECORDING_BYTES, WavRecording, encodeWav16,
    MAX_JSON_BYTES, decodeShare, encodeShare,
    MAX_IN_FLIGHT, PlaygroundEngine, STORAGE_KEY, defaultGraph,
} = require('./.build/playgroundengine.cjs');
const { scene } = require('./dspscene.js');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

// ── stand-ins for the browser ───────────────────────────────────────────────

const settled = (v) => ({ then(f) { const r = f(v); return { catch() { return r; } }; } });
const refused = (e) => ({ then() { return { catch(f) { f(e); } }; } });

function fakeAudio() {
    const node = (kind, extra = {}) => ({
        kind, out: new Set(), connect(to) { this.out.add(to); return to; }, disconnect() { this.out.clear(); }, ...extra,
    });
    const param = () => ({ value: 1, setTargetAtTime(v) { this.value = v; } });
    const sources = [];
    const ctx = {
        state: 'running', currentTime: 0, destination: node('destination'),
        createGain: () => node('gain', { gain: param() }),
        createStereoPanner: () => node('panner', { pan: { ...param(), value: 0 } }),
        createMediaStreamDestination: () => node('stream', { stream: { id: 's' } }),
        createBuffer: (ch, n, rate) => ({ duration: n / rate, length: n, sampleRate: rate, copyToChannel() {} }),
        createBufferSource: () => {
            const s = node('source', { start(at) { this.at = at; } });
            sources.push(s);
            return s;
        },
    };
    const bus = node('bus', { context: ctx });
    const elements = [];
    const env = { refuse: null };
    globalThis.document = {
        body: { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } },
        createElement: (tag) => {
            const el = {
                tag, style: {}, parentNode: null, srcObject: null, sinkId: null, playing: false,
                setAttribute() {},
                setSinkId(id) { return env.refuse ? refused(new Error(env.refuse)) : settled((el.sinkId = id)); },
                play() { el.playing = true; return settled(); },
                pause() { el.playing = false; },
            };
            elements.push(el);
            return el;
        },
    };
    let taps = new Set();
    const player = {
        ctx, outputBus: bus, ducked: false, setDucked(v) { this.ducked = v; },
        onAudio(fn) { taps.add(fn); return () => taps.delete(fn); },
    };
    const packet = (I, Q, frames = I.length, rate = 12000) => {
        for (const fn of Array.from(taps)) fn([I, Q], frames, rate);
    };
    return { ctx, bus, player, elements, env, sources, packet, taps: () => taps.size };
}

/** An inline host, as the engine would make on a browser with no worker. */
const inline = (onMessage) => createHost(onMessage, { worker: false });

/** A graph: the stream's I and Q, each through a real part, into an Audio out and a recorder. */
function stereoGraph(extra = {}) {
    return parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'iq', type: 'iq-in' },
            { id: 're', type: 'real-part' },
            { id: 'im', type: 'imag-part' },
            { id: 'out', type: 'audio-out', params: extra.out || {} },
            { id: 'rec', type: 'wav-recorder', params: extra.rec || {} },
        ],
        wires: [
            ['iq', 'out', 're', 'in'], ['iq', 'out', 'im', 'in'],
            ['re', 'out', 'out', 'in'],
            ['re', 'out', 'rec', 'left'], ['im', 'out', 'rec', 'right'],
        ],
    }).graph;
}

function fresh() {
    for (const k of Object.keys(store)) delete store[k];
    resetIQOwner();
}

// ── the worker's protocol ───────────────────────────────────────────────────

t('the worker core answers a graph with its status, and a packet with its audio', () => {
    const sent = [];
    let clock = 0;
    const core = createWorkerCore((m, transfer) => sent.push({ m, transfer }), () => clock);
    const g = stereoGraph();
    core.onMessage({ t: 'graph', graph: g });
    assert.deepStrictEqual(sent.shift().m, { t: 'status', ok: true, errors: [] });

    const { I, Q } = require('./dspscene.js').scene(12000, 0.02);
    core.onMessage({ t: 'packet', seq: 7, i: I, q: Q, frames: I.length, rate: 12000 });
    const { m, transfer } = sent.shift();
    assert.strictEqual(m.t, 'out');
    assert.strictEqual(m.seq, 7);
    assert.strictEqual(m.audio.length, 1);
    assert.strictEqual(m.audio[0].id, 'out');
    // What a runtime given the same graph puts out, exactly.
    const rt = new Runtime(g, 12000);
    rt.process({ i: I, q: Q, frames: I.length, rate: 12000 });
    assert.deepStrictEqual(Array.from(m.audio[0].samples), Array.from(rt.read('out').samples));
    assert.strictEqual(m.record.length, 1);
    assert.ok(m.record[0].right, 'the recorder’s second input did not come back');
    // Everything sizeable is transferred, not cloned.
    assert.strictEqual(transfer.length, 3);
    assert.strictEqual(m.readings, null, 'readings sent with nothing watched');
});

t('readings come back for watched nodes only, and no more often than READ_EVERY_MS', () => {
    const sent = [];
    let clock = 1000;
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700, lowCutHz: 50 });
    core.onMessage({ t: 'graph', graph: parseGraph(graphForPlan(plan, 12000)).graph });
    core.onMessage({ t: 'watch', ids: ['meter', 'spectrum'] });
    const p = (seq) => core.onMessage({ t: 'packet', seq, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
    sent.length = 0;
    p(1);
    const first = sent.pop().readings;
    assert.deepStrictEqual(Object.keys(first).sort(), ['meter', 'spectrum']);
    // A copy: the spectrum's own array is reused by the next transform.
    assert.ok(first.spectrum.db instanceof Float32Array);
    clock += READ_EVERY_MS - 1;
    p(2);
    assert.strictEqual(sent.pop().readings, null, 'readings sent again too soon');
    clock += 1;
    p(3);
    assert.ok(sent.pop().readings, 'readings not sent once due');
});

t('taking the wire out of an Audio out silences it — no block played again — and the rest keeps running', () => {
    const sent = [];
    // Readings go back no more often than READ_EVERY_MS: a clock that moves.
    let clock = 0;
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700, lowCutHz: 50 });
    const g = parseGraph(graphForPlan(plan, 12000)).graph;
    const into = g.wires.find((w) => BLOCK_BY_TYPE[g.nodes.find((n) => n.id === w[2]).type] === BLOCK_BY_TYPE['audio-out']);
    assert.ok(into, 'no wire into an Audio out');
    const { scene } = require('./dspscene.js');
    const { I, Q } = scene(12000, 0.5);
    let seq = 0;
    const packet = () => {
        clock += 20;
        const at = (seq % 25) * 240;
        core.onMessage({ t: 'packet', seq: ++seq, i: I.slice(at, at + 240), q: Q.slice(at, at + 240), frames: 240, rate: 12000 });
        return sent.filter((m) => m.t === 'out').pop();
    };
    core.onMessage({ t: 'graph', graph: g });
    core.onMessage({ t: 'watch', ids: ['spectrum'] });
    for (let k = 0; k < 5; k++) assert.strictEqual(packet().audio.length, 1, 'no audio from the whole graph');

    // The wire out, as pressing Delete on it does.
    const cut = { ...g, wires: g.wires.filter((w) => w !== into) };
    sent.length = 0;
    core.onMessage({ t: 'graph', graph: cut });
    const st = sent.find((m) => m.t === 'status');
    assert.strictEqual(st.ok, false);
    assert.match(st.errors.map((e) => e.message).join(' '), /needs a wire/);
    let spectrumSeen = 0;
    for (let k = 0; k < 10; k++) {
        const out = packet();
        assert.deepStrictEqual(out.audio, [], `packet ${k}: audio sent with nothing wired into it`);
        if (out.readings && out.readings.spectrum) spectrumSeen++;
    }
    assert.ok(spectrumSeen > 0, 'the spectrum stopped with the audio');

    // And back.
    core.onMessage({ t: 'graph', graph: g });
    assert.strictEqual(packet().audio.length, 1, 'the audio did not come back with the wire');
});

t('a block dropped on the canvas with nothing wired leaves the running graph playing as it was', () => {
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700, lowCutHz: 50 });
    const g = parseGraph(graphForPlan(plan, 12000)).graph;
    const withNr = { ...g, nodes: [...g.nodes, { id: 'lsa1', type: 'lsa', params: {}, x: 0, y: 0 }] };
    const { scene } = require('./dspscene.js');
    const { I, Q } = scene(12000, 0.2);
    const run = (graph) => {
        const sent = [];
        const core = createWorkerCore((m) => sent.push(m), () => 0);
        core.onMessage({ t: 'graph', graph: g });
        const outs = [];
        for (let k = 0; k < 10; k++) {
            // Dropped in halfway, as it is into a running graph.
            if (k === 5) core.onMessage({ t: 'graph', graph });
            core.onMessage({ t: 'packet', seq: k + 1, i: I.slice(k * 240, k * 240 + 240), q: Q.slice(k * 240, k * 240 + 240), frames: 240, rate: 12000 });
            outs.push(sent.filter((m) => m.t === 'out').pop());
        }
        return { outs, status: sent.filter((m) => m.t === 'status').pop() };
    };
    const plain = run(g);
    const dropped = run(withNr);
    assert.strictEqual(dropped.status.ok, false, 'an unwired block went unremarked');
    for (let k = 0; k < 10; k++) {
        assert.strictEqual(dropped.outs[k].audio.length, 1, `packet ${k}: no audio`);
        assert.deepStrictEqual(Array.from(dropped.outs[k].audio[0].samples), Array.from(plain.outs[k].audio[0].samples), `packet ${k}: not the audio it was`);
    }
});

t('levels go back with the readings while an editor asks for them, and not otherwise', () => {
    const sent = [];
    let clock = 0;
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700, lowCutHz: 50 });
    core.onMessage({ t: 'graph', graph: parseGraph(graphForPlan(plan, 12000)).graph });
    const packet = () => {
        clock += 100;
        core.onMessage({ t: 'packet', seq: 1, i: new Float32Array(240).fill(0.1), q: new Float32Array(240), frames: 240, rate: 12000 });
        return sent.filter((m) => m.t === 'out').pop();
    };
    core.onMessage({ t: 'watch', ids: ['meter'] });
    packet();
    assert.ok(!('__levels' in packet().readings), 'levels sent unasked');
    core.onMessage({ t: 'watch', ids: [], levels: true });
    packet();
    const lv = packet().readings.__levels;
    assert.ok(lv && lv.audio && lv.audio.in != null, `no level for the Audio out: ${JSON.stringify(lv && lv.audio)}`);
    core.onMessage({ t: 'watch', ids: [] });
    assert.strictEqual(packet().readings, null, 'readings sent with nothing asked for');
});

t('a graph that cannot run says why; one that throws is stopped and says so', () => {
    const sent = [];
    const core = createWorkerCore((m) => sent.push(m), () => 0);
    core.onMessage({ t: 'graph', graph: { v: GRAPH_VERSION, nodes: [{ id: 'g', type: 'gain' }], wires: [] } });
    const st = sent.pop();
    assert.strictEqual(st.ok, false);
    assert.match(st.errors[0].message, /needs a wire/);

    const original = BLOCK_BY_TYPE['real-part'].create;
    BLOCK_BY_TYPE['real-part'].create = () => ({ configure() {}, reset() {}, process() { throw new Error('boom'); } });
    try {
        core.onMessage({ t: 'graph', graph: stereoGraph() });
        sent.length = 0;
        core.onMessage({ t: 'packet', seq: 1, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
        assert.deepStrictEqual(sent.map((m) => m.t), ['fault', 'out'], 'the packet was not answered after a fault');
        assert.match(sent[0].message, /boom/);
    } finally {
        BLOCK_BY_TYPE['real-part'].create = original;
    }
    // A new graph runs again.
    sent.length = 0;
    core.onMessage({ t: 'graph', graph: stereoGraph() });
    assert.strictEqual(sent.pop().ok, true);
});

// ── the engine, and where its audio goes ────────────────────────────────────

t('the engine runs a graph and plays it to the receiver’s output while the stream is IQ', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    pg.setGraph(stereoGraph());
    pg.start();
    assert.ok(!a.player.ducked, 'ducked before the stream was known to be IQ');
    a.packet(new Float32Array(240), new Float32Array(240));
    assert.strictEqual(pg.routes.voices.size, 0, 'demodulated a stream that is not IQ');
    pg.setQuadrature(true);
    assert.ok(a.player.ducked, 'the receiver’s own output was not ducked');
    for (let k = 0; k < 5; k++) a.packet(new Float32Array(240).fill(0.1), new Float32Array(240));
    const v = pg.routes.voices.get('out');
    assert.ok(v, 'no voice for the Audio out');
    const master = [...v.panner.out][0];
    assert.ok(master.out.has(a.bus), 'not on the receiver’s output bus');
    assert.ok(a.sources.length > 0, 'nothing was scheduled');
    assert.strictEqual(pg.inFlight, 0);

    pg.stop();
    assert.ok(!a.player.ducked, 'the duck was left down');
    assert.strictEqual(a.taps(), 0, 'the tap was left on the player');
    assert.strictEqual(pg.hostKind, null);
    pg.destroy();
});

t('Audio out reaches the left, the right or both', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    pg.setGraph(stereoGraph());
    pg.setQuadrature(true);
    pg.start();
    const pan = () => pg.routes.voices.get('out').panner.pan.value;
    const run = () => a.packet(new Float32Array(240), new Float32Array(240));
    run();
    assert.strictEqual(pan(), CHANNEL_PAN.both);
    pg.setParams('out', { channel: 'left' });
    run();
    assert.strictEqual(pan(), -1);
    pg.setParams('out', { channel: 'right' });
    run();
    assert.strictEqual(pan(), 1);
    pg.setParams('out', { channel: 'nonsense' });
    assert.strictEqual(pg.paramsOf('out').channel, 'both', 'an unknown channel was accepted');
    pg.destroy();
});

t('Audio out reaches any device, falls back when one refuses, and follows volume and mute', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    pg.setGraph(stereoGraph({ out: { device: 'headset-1', channel: 'right' } }));
    pg.setQuadrature(true);
    pg.start();
    a.packet(new Float32Array(240), new Float32Array(240));
    const v = pg.routes.voices.get('out');
    const own = [...v.panner.out][0];
    const stream = [...own.out][0];
    assert.strictEqual(stream.kind, 'stream');
    assert.strictEqual(a.elements.length, 1);
    assert.strictEqual(a.elements[0].sinkId, 'headset-1');
    assert.ok(a.elements[0].playing);
    assert.strictEqual(v.panner.pan.value, 1, 'the channel does not apply on a device of its own');
    assert.strictEqual(pg.sinkErrorOf('out'), null);

    pg.setOutput(0.4, false);
    assert.strictEqual(own.gain.value, 0.4);
    pg.setOutput(0.4, true);
    assert.strictEqual(own.gain.value, 0, 'mute missed the device');

    // Back to the receiver's output: the element is given back.
    pg.setParams('out', { device: '' });
    a.packet(new Float32Array(240), new Float32Array(240));
    pg.routes.prune(['out']);
    assert.strictEqual(a.elements[0].parentNode, null, 'the element was left in the page');

    // A device that refuses.
    a.env.refuse = 'NotFoundError';
    pg.setParams('out', { device: 'gone-2' });
    a.packet(new Float32Array(240), new Float32Array(240));
    const fallen = [...v.panner.out][0];
    assert.ok([...fallen.out].some((n) => n.out.has(a.bus)), 'a refused device left the audio silent');
    assert.match(pg.sinkErrorOf('out'), /NotFoundError/);
    pg.destroy();
});

t('only one of the playground and the IQ Demod panel runs, and the way back is handed over', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    const demod = new IQDemod(a.player);
    try {
        demod.setQuadrature(true);
        pg.setQuadrature(true);
        demod.restoreMode = 'usb';
        demod.start();
        assert.ok(demod.running);

        pg.start();
        assert.ok(!demod.running, 'the IQ Demod panel kept running');
        assert.ok(pg.running);
        assert.strictEqual(pg.restoreMode, 'usb', 'the mode to go back to was lost');
        assert.strictEqual(demod.restoreMode, null);
        assert.ok(a.player.ducked, 'the receiver was left un-ducked between them');

        demod.start();
        assert.ok(!pg.running, 'the playground kept running');
        assert.strictEqual(demod.restoreMode, 'usb');
        assert.ok(a.player.ducked);

        demod.stop();
        assert.ok(!a.player.ducked);
    } finally {
        demod.destroy();
        pg.destroy();
    }
});

t('a worker that falls behind is not allowed to build a queue', () => {
    fresh();
    const a = fakeAudio();
    let clock = 0;
    let sent = 0;
    // A host that never answers a packet.
    const deaf = (onMessage) => ({
        kind: 'worker',
        send(m) { if (m.t === 'graph') onMessage({ t: 'status', ok: true, errors: [] }); if (m.t === 'packet') sent++; },
        close() {},
    });
    const pg = new PlaygroundEngine(a.player, { hostFactory: deaf, now: () => clock });
    pg.setQuadrature(true);
    pg.start();
    for (let k = 0; k < MAX_IN_FLIGHT + 10; k++) a.packet(new Float32Array(240), new Float32Array(240));
    assert.strictEqual(sent, MAX_IN_FLIGHT);
    assert.ok(pg.overloaded);
    clock += 5000;
    assert.ok(!pg.overloaded, 'still overloaded long after the last drop');
    pg.destroy();
});

t('the stream’s counts since Start: packets and samples in, packets let go while behind, the player’s dropouts', () => {
    fresh();
    const a = fakeAudio();
    let clock = 0;
    const deaf = (onMessage) => ({
        kind: 'worker',
        send(m) { if (m.t === 'graph') onMessage({ t: 'status', ok: true, errors: [] }); },
        close() {},
    });
    a.player.underruns = 7;
    const pg = new PlaygroundEngine(a.player, { hostFactory: deaf, now: () => clock });
    pg.setQuadrature(true);
    pg.start();
    for (let k = 0; k < MAX_IN_FLIGHT + 10; k++) a.packet(new Float32Array(240), new Float32Array(240));
    // Two dropouts since Start; the seven before it are not this run's.
    a.player.underruns = 9;
    const c = pg.streamCounts();
    assert.strictEqual(c.packets, MAX_IN_FLIGHT + 10);
    assert.strictEqual(c.frames, 240 * (MAX_IN_FLIGHT + 10));
    assert.strictEqual(c.behind, 10, 'packets let go while the graph was behind');
    assert.strictEqual(c.underruns, 2);
    assert.strictEqual(c.rate, 12000);
    // A new Start counts afresh.
    pg.stop();
    pg.start();
    assert.deepStrictEqual([pg.streamCounts().packets, pg.streamCounts().behind, pg.streamCounts().underruns], [0, 0, 0]);
    pg.destroy();
});

// ── text to speech ──────────────────────────────────────────────────────────

const { IDLE_MS, Speaker, chunkSpeech } = require('./.build/playgroundengine.cjs');

/** A browser voice that says what it is given and ends when told to. */
function fakeVoice() {
    const said = [];
    const timers = [];
    class Utterance { constructor(text) { this.text = text; } }
    const synth = {
        speaking: null,
        speak(u) { said.push(u.text); this.speaking = u; },
        cancel() { said.push('<cancel>'); this.speaking = null; },
        end() { const u = this.speaking; this.speaking = null; if (u && u.onend) u.onend(); },
    };
    const sp = new Speaker({
        synth, Utterance, voice: () => ({ name: 'Test', lang: 'en-GB' }),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: (k) => { if (timers[k - 1]) timers[k - 1].fn = null; },
    });
    const runIdle = () => { for (const t of timers.splice(0)) if (t.fn && t.ms === IDLE_MS) t.fn(); };
    return { sp, said, synth, runIdle };
}

t('text to speech: decoded text is spoken in pieces — words spelled, or phrases — one at a time, and not left unsaid', () => {
    assert.deepStrictEqual(chunkSpeech('', 'CQ', 'letters'), { buffer: 'CQ', pieces: [] }, 'a word still arriving spoken');
    assert.deepStrictEqual(chunkSpeech('CQ', ' CQ DE M9', 'letters'), { buffer: 'M9', pieces: ['C Q', 'C Q', 'D E'] });
    assert.deepStrictEqual(chunkSpeech('M9', 'PSY ', 'letters').pieces, ['M 9 P S Y']);
    assert.deepStrictEqual(chunkSpeech('', 'ZCZC SECURITE. MORE', 'words'), { buffer: ' MORE', pieces: ['ZCZC SECURITE.'] });
    assert.deepStrictEqual(chunkSpeech('', 'one two three four five six seven eight nine', 'words').pieces, ['one two three four five six seven eight']);
    assert.deepStrictEqual(chunkSpeech('', 'K', 'letters', true), { buffer: '', pieces: ['K'] });

    const { sp, said, synth, runIdle } = fakeVoice();
    // A character at a time, as a Morse decoder sends it.
    for (const ch of 'CQ DE M9PSY') sp.feed(ch, { read: 'letters', rate: 1 });
    assert.deepStrictEqual(said, ['C Q'], 'not one piece at a time');
    synth.end();
    assert.deepStrictEqual(said, ['C Q', 'D E']);
    synth.end();
    // The callsign has no space after it yet: said once the text goes quiet.
    assert.deepStrictEqual(said, ['C Q', 'D E']);
    runIdle();
    assert.deepStrictEqual(said, ['C Q', 'D E', 'M 9 P S Y']);
    assert.strictEqual(sp.state().speaking, 'M 9 P S Y');
});

t('text to speech: behind by too much, it drops the oldest and says so; muted, it stops', () => {
    const { MAX_BACKLOG } = require('./.build/playgroundengine.cjs');
    const { sp, said, synth } = fakeVoice();
    // RTTY-fast: far more than can be said.
    sp.feed('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. '.repeat(20), { read: 'words', rate: 1 });
    const waiting = sp.queue.reduce((n, p) => n + p.length, 0);
    assert.ok(waiting <= MAX_BACKLOG, `${waiting} characters waiting`);
    assert.ok(sp.state().skipped > 10, `${sp.state().skipped} skipped`);
    assert.strictEqual(said.length, 1, 'more than one piece at once');
    // Muted: what is being said stops, and nothing waits.
    sp.feed('MORE ', { read: 'words', rate: 1, muted: true });
    assert.strictEqual(said[said.length - 1], '<cancel>');
    assert.strictEqual(sp.queue.length, 0);
    synth.end();
    assert.strictEqual(said[said.length - 1], '<cancel>', 'spoke while muted');
});

t('text to speech: the chosen voice, pitch and volume — the receiver’s voice when none is chosen, or the chosen one is not here', () => {
    // The voice the speaker asks for, by name.
    const asked = [];
    const spoken = [];
    class Utterance { constructor(text) { this.text = text; } }
    const sp = new Speaker({
        synth: { speak: (u) => spoken.push(u), cancel() {} },
        Utterance,
        voice: (name) => { asked.push(name); return { name: name || 'Receiver voice', lang: 'en-GB' }; },
        setTimer: () => 0,
        clearTimer() {},
    });
    sp.feed('CQ ', { read: 'letters', voice: 'Microsoft Ryan Online', pitch: 1.4, volume: 60, rate: 1 });
    assert.deepStrictEqual(asked, ['Microsoft Ryan Online']);
    assert.strictEqual(spoken[0].voice.name, 'Microsoft Ryan Online');
    assert.strictEqual(spoken[0].pitch, 1.4);
    assert.strictEqual(spoken[0].volume, 0.6);

    // The real lookup, against a browser's list: there, used; not there, the receiver's.
    const { voiceNamed } = require('./.build/playgroundengine.cjs');
    const was = globalThis.window ? globalThis.window.speechSynthesis : undefined;
    globalThis.window = globalThis.window || globalThis;
    const voices = [
        { name: 'Google UK English Female', lang: 'en-GB' },
        { name: 'Microsoft Ryan Online (Natural) - English (United Kingdom)', lang: 'en-GB' },
    ];
    window.speechSynthesis = { getVoices: () => voices, speak() {}, cancel() {} };
    try {
        assert.strictEqual(voiceNamed('Microsoft Ryan Online (Natural) - English (United Kingdom)').name, voices[1].name);
        assert.strictEqual(voiceNamed('A voice from another machine').name, 'Google UK English Female', 'not the receiver’s voice');
        assert.strictEqual(voiceNamed('').name, 'Google UK English Female');
    } finally {
        if (was === undefined) delete window.speechSynthesis; else window.speechSynthesis = was;
    }
});

t('text to speech: the worker hands each TTS block its text, and the engine says it with the block’s settings', () => {
    // The worker: a transmitter's text, into a TTS block, comes back with the packet.
    const sent = [];
    const core = createWorkerCore((m) => sent.push(m), () => 0);
    core.onMessage({ t: 'graph', graph: parseGraph({ v: GRAPH_VERSION, nodes: [
        { id: 'tx', type: 'data-tx', params: { mode: 'cw', wpm: 20 } }, { id: 'say', type: 'tts' },
    ], wires: [['tx', 'sent', 'say', 'in']] }).graph });
    let text = '';
    for (let k = 0; k < 50 * 4; k++) {
        core.onMessage({ t: 'packet', seq: k + 1, i: null, q: null, frames: 240, rate: 12000 });
        for (const s of sent.pop().speech || []) { assert.strictEqual(s.id, 'say'); text += s.text; }
    }
    // The message opens with its VVV: four seconds of 20 wpm reaches that much.
    assert.ok(/^VVV/.test(text), `nothing to say: ${JSON.stringify(text)}`);

    // The engine: to the right speaker, with the block's settings as they are here.
    fresh();
    const a = fakeAudio();
    const fed = [];
    const stops = [];
    const pg = new PlaygroundEngine(a.player, {
        hostFactory: inline,
        speakerFactory: () => ({ feed: (t, p) => fed.push([t, p.read, p.muted]), stop: () => stops.push(1), state: () => ({}) }),
    });
    pg.setGraph(parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'say', type: 'tts', params: { read: 'words' } }], wires: [] }).graph);
    pg._deliver({ speech: [{ id: 'say', text: 'HELLO ' }] });
    assert.deepStrictEqual(fed, [['HELLO ', 'words', false]]);
    // Muted: stopped there and then.
    pg.setParams('say', { muted: true });
    assert.strictEqual(stops.length, 1);
    // Taken out of the graph: stopped, and forgotten.
    pg.setGraph(parseGraph({ v: GRAPH_VERSION, nodes: [], wires: [] }).graph);
    assert.strictEqual(stops.length, 2);
    assert.strictEqual(pg.speakers.size, 0);
    pg.destroy();
});

t('a worker that never loads is replaced by running the graph on the page', () => {
    fresh();
    const a = fakeAudio();
    const asked = [];
    const factory = (onMessage, opts) => {
        asked.push(opts ? 'inline' : 'worker');
        if (opts && opts.worker === false) return inline(onMessage);
        return { kind: 'worker', send(m) { if (m.t === 'graph') onMessage({ t: 'fault', message: '404' }); }, close() {} };
    };
    const pg = new PlaygroundEngine(a.player, { hostFactory: factory });
    pg.start();
    assert.deepStrictEqual(asked, ['worker', 'inline']);
    assert.strictEqual(pg.hostKind, 'inline');
    assert.strictEqual(pg.fault, null);
    pg.destroy();
});

t('the graph is kept, and comes back with the next page', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    assert.deepStrictEqual(pg.graph, defaultGraph(), 'an empty store did not give the default graph');
    pg.setGraph(stereoGraph({ out: { channel: 'left' } }));
    pg.flush();
    assert.deepStrictEqual(JSON.parse(store[STORAGE_KEY]), serializeGraph(pg.graph));
    const again = new PlaygroundEngine(a.player, { hostFactory: inline });
    assert.deepStrictEqual(again.graph, pg.graph);
    pg.destroy();
    again.destroy();
});

// ── recording ───────────────────────────────────────────────────────────────

function readWav(buf) {
    const v = new DataView(buf);
    const s = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
    return {
        riff: s(0, 4), wave: s(8, 4), fmt: s(12, 4), data: s(36, 4),
        format: v.getUint16(20, true), channels: v.getUint16(22, true), rate: v.getUint32(24, true),
        byteRate: v.getUint32(28, true), align: v.getUint16(32, true), bits: v.getUint16(34, true),
        size: v.getUint32(40, true), riffSize: v.getUint32(4, true),
        pcm: new Int16Array(buf.slice(44)),
    };
}

t('a recording is a correct WAV file: stereo, interleaved, at the rate it arrived at', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    pg.setGraph(stereoGraph());
    pg.setQuadrature(true);
    pg.start();
    assert.ok(pg.startRecording('rec'));
    const I = Float32Array.from({ length: 240 }, (_, k) => Math.sin(k / 10) * 0.5);
    const Q = Float32Array.from({ length: 240 }, (_, k) => -Math.cos(k / 7) * 0.9);
    for (let p = 0; p < 10; p++) a.packet(I, Q);
    pg.stopRecording('rec');
    const rec = pg.recordingOf('rec');
    assert.strictEqual(rec.state, 'held');
    assert.strictEqual(rec.frames, 2400);
    const w = readWav(encodeWav16(rec.chunks, rec.rate, rec.channels));
    assert.deepStrictEqual(
        [w.riff, w.wave, w.fmt, w.data, w.format, w.channels, w.rate, w.byteRate, w.align, w.bits],
        ['RIFF', 'WAVE', 'fmt ', 'data', 1, 2, 12000, 48000, 4, 16],
    );
    assert.strictEqual(w.size, 2400 * 4);
    assert.strictEqual(w.riffSize, 36 + w.size);
    const q16 = (x) => (x < 0 ? Math.trunc(x * 32768) : Math.trunc(x * 32767));
    for (const k of [0, 1, 117, 239]) {
        assert.strictEqual(w.pcm[2 * k], q16(I[k]), `left sample ${k}`);
        assert.strictEqual(w.pcm[2 * k + 1], q16(Q[k]), `right sample ${k}`);
    }
    pg.destroy();
});

t('a recording stops itself at its time limit, and says so', () => {
    const rec = new WavRecording();
    rec.start(1);
    const block = new Float32Array(5000);
    let stopped = false;
    for (let k = 0; k < 4 && !stopped; k++) stopped = rec.push(block, null, 5000, 12000);
    assert.ok(stopped);
    assert.strictEqual(rec.state, 'held');
    assert.strictEqual(rec.frames, 12000, 'recorded past the limit');
    assert.match(rec.reason, /1 second limit/);
});

t('the memory ceiling is what limits a wide stream, and the time limit an audio one', () => {
    const wide = new WavRecording();
    wide.start(600);
    wide.push(new Float32Array(10), new Float32Array(10), 10, 384000);
    assert.strictEqual(wide.limitFrames, Math.floor(MAX_RECORDING_BYTES / 4));
    assert.ok(wide.limitSeconds < 600 && wide.limitSeconds > 100, `${wide.limitSeconds}s`);
    const audio = new WavRecording();
    audio.start(600);
    audio.push(new Float32Array(10), null, 10, 12000);
    assert.strictEqual(audio.limitSeconds, 600);
});

t('a recording does not mix rates or channel counts in one file', () => {
    const rec = new WavRecording();
    rec.start(60);
    rec.push(new Float32Array(100), null, 100, 12000);
    assert.ok(rec.push(new Float32Array(100), null, 100, 24000));
    assert.match(rec.reason, /rate/);
    assert.strictEqual(rec.frames, 100);
    const st = new WavRecording();
    st.start(60);
    st.push(new Float32Array(100), null, 100, 12000);
    assert.ok(st.push(new Float32Array(100), new Float32Array(100), 100, 12000));
    assert.match(st.reason, /second input/);
});

t('stopping the playground, or removing the recorder, stops a recording and keeps it', () => {
    fresh();
    const a = fakeAudio();
    const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
    pg.setGraph(stereoGraph());
    pg.setQuadrature(true);
    pg.start();
    pg.startRecording('rec');
    a.packet(new Float32Array(240), new Float32Array(240));
    pg.stop();
    assert.strictEqual(pg.recordingOf('rec').state, 'held');
    assert.match(pg.recordingOf('rec').reason, /playground was stopped/);
    assert.strictEqual(pg.startRecording('rec'), false, 'started recording with the playground stopped');

    pg.start();
    pg.startRecording('rec');
    a.packet(new Float32Array(240), new Float32Array(240));
    const g = stereoGraph();
    g.nodes = g.nodes.filter((n) => n.id !== 'rec');
    g.wires = g.wires.filter((w) => w[2] !== 'rec');
    pg.setGraph(g);
    assert.strictEqual(pg.recordings.get('rec').state, 'held');
    assert.match(pg.recordings.get('rec').reason, /removed/);
    pg.destroy();
});

t('a recording plays back from one URL, saves under its time, and gives the URL back when cleared', async () => {
    fresh();
    const made = [];
    const revoked = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { made.push(b); return `blob:${made.length}`; };
    URL.revokeObjectURL = (u) => revoked.push(u);
    const saved = [];
    globalThis.window = { ubersdrSaveFile: async (blob, name) => saved.push({ blob, name }) };
    try {
        const rec = new WavRecording();
        rec.start(60, new Date(2026, 9, 1, 14, 5, 9).getTime());
        rec.push(new Float32Array(1200).fill(0.25), null, 1200, 12000);
        assert.strictEqual(rec.url(), null, 'a recording still in progress offered playback');
        rec.stop();
        assert.strictEqual(rec.url(), 'blob:1');
        assert.strictEqual(rec.url(), 'blob:1', 'a second URL was made for the same recording');
        assert.strictEqual(made[0].type, 'audio/wav');
        assert.strictEqual(rec.filename(), 'ubersdr-playground-20261001-140509.wav');

        const a = fakeAudio();
        const pg = new PlaygroundEngine(a.player, { hostFactory: inline });
        pg.recordings.set('rec', rec);
        assert.ok(await pg.saveRecording('rec'));
        assert.strictEqual(saved[0].name, rec.filename());
        assert.strictEqual(saved[0].blob.size, 44 + 2400);
        pg.clearRecording('rec');
        assert.deepStrictEqual(revoked, ['blob:1']);
        pg.destroy();
    } finally {
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
        delete globalThis.window;
    }
});

t('the built worker loads in a real worker thread, with no page around it, and runs a graph', async () => {
    const { Worker } = require('worker_threads');
    const path = require('path');
    // The worker bundle as build.sh makes it, run where there is no document
    // and no window: `self` is the thread's port and nothing else.
    const w = new Worker(`
        const { parentPort } = require('worker_threads');
        globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
        parentPort.on('message', (data) => self.onmessage({ data }));
        require(${JSON.stringify(path.join(__dirname, '.build', 'playground-worker.js'))});
    `, { eval: true });
    const replies = [];
    const waitFor = (pred) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply: ${JSON.stringify(replies.map((r) => r.t))}`)), 5000);
        const check = () => {
            const hit = replies.find(pred);
            if (hit) { clearTimeout(timer); resolve(hit); } else setTimeout(check, 5);
        };
        check();
    });
    w.on('message', (m) => replies.push(m));
    try {
        w.postMessage({ t: 'graph', graph: stereoGraph() });
        const st = await waitFor((m) => m.t === 'status');
        assert.strictEqual(st.ok, true, JSON.stringify(st.errors));
        const I = new Float32Array(240).fill(0.25);
        w.postMessage({ t: 'packet', seq: 1, i: I, q: new Float32Array(240), frames: 240, rate: 12000 });
        const out = await waitFor((m) => m.t === 'out');
        assert.strictEqual(out.audio[0].frames, 240);
        assert.strictEqual(out.audio[0].samples[100], 0.25);
    } finally {
        await w.terminate();
    }
});

// ── sharing ─────────────────────────────────────────────────────────────────

t('a shared graph comes back whole, short, and without anybody’s devices', async () => {
    const plan = planFor({ mode: 'ecss', offsetHz: 2000, widthHz: 4500, sideband: 'auto', trackHz: 300 });
    const g = parseGraph(graphForPlan(plan, 192000, { agc: true, gain: 1.5, squelchDb: -30 })).graph;
    g.nodes.find((n) => n.id === 'audio').params.device = 'my-secret-headset';
    g.nodes.find((n) => n.id === 'audio').params.channel = 'left';
    const code = await encodeShare(g);
    assert.match(code, /^pg1\.z\.[A-Za-z0-9_-]+$/);
    assert.ok(code.length < 1200, `a typical graph made a ${code.length}-character code`);
    assert.ok(!code.includes('secret'));
    const back = await decodeShare(code);
    assert.deepStrictEqual(back.errors, []);
    const want = JSON.parse(JSON.stringify(g));
    want.nodes.find((n) => n.id === 'audio').params.device = '';
    assert.deepStrictEqual(back.graph, want);
});

t('blocks keep the names they are given through a link and a file (storage keeps the file’s form)', async () => {
    const g = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 's', type: 'signal', name: '  Test   tone ', x: 0, y: 0 },
            { id: 'r', type: 'real-part', name: 'Real part', x: 200, y: 0 },
            { id: 'o', type: 'audio-out', name: 'Speakers ✓', x: 400, y: 0 },
            { id: 'n', type: 'gain', name: 42, x: 600, y: 0 },
        ],
        wires: [['s', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']],
    }).graph;
    // Kept as one line, trimmed; a name that only repeats the label, or is
    // not text, is no name.
    assert.deepStrictEqual(g.nodes.map((n) => n.name), ['Test tone', undefined, 'Speakers ✓', undefined]);
    // A file: what Export writes, read back as Import reads it.
    const file = JSON.parse(JSON.stringify(serializeGraph(g)));
    assert.deepStrictEqual(file.nodes.map((n) => n.name), ['Test tone', undefined, 'Speakers ✓', undefined]);
    assert.deepStrictEqual(parseGraph(file).graph, g);
    // A link.
    const back = await decodeShare(await encodeShare(g));
    assert.deepStrictEqual(back.errors, []);
    assert.deepStrictEqual(back.graph.nodes.map((n) => n.name), ['Test tone', undefined, 'Speakers ✓', undefined]);
    // Too long: cut, not refused.
    const long = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'a', type: 'gain', name: 'x'.repeat(500) }], wires: [] }).graph;
    assert.strictEqual(long.nodes[0].name.length, 60);
});

t('a share code that is not one, is damaged, is newer, or expands too far is refused', async () => {
    assert.match((await decodeShare('hello')).errors[0].message, /Not a playground link/);
    assert.match((await decodeShare('pg1.z.AAAA')).errors[0].message, /damaged/);
    assert.match((await decodeShare('pg2.z.AAAA')).errors[0].message, /newer version/);
    assert.match((await decodeShare('x'.repeat(40000))).errors[0].message, /too long/);
    // A small code that inflates past the ceiling.
    const huge = new TextEncoder().encode(' '.repeat(MAX_JSON_BYTES * 4));
    const z = new Uint8Array(await new Response(new Blob([huge]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = '';
    for (const b of z) bin += String.fromCharCode(b);
    const code = `pg1.z.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    assert.ok(code.length < 40000, 'the bomb was too big to test the ceiling with');
    assert.match((await decodeShare(code)).errors[0].message, /too large/);
    // An uncompressed code still reads.
    const plain = `pg1.j.${btoa(JSON.stringify({ v: GRAPH_VERSION, nodes: [{ id: 'a', type: 'signal' }], wires: [] })).replace(/=+$/, '')}`;
    const r = await decodeShare(plain);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.graph.nodes[0].type, 'signal');
});

(async () => {
    for (const [name, fn] of queue) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass} passed`);
})();
