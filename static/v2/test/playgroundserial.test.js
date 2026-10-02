// The Serial port block: the graph's half, the page's half, and the worker
// between them — against a stand-in port, since there is no serial hardware
// (or Web Serial) under node.

const assert = require('assert');
const {
    SerialPortBlock, serialNumber, firstNumber,
    SerialLink, serialSupport, portOptions, encodeText, makeDecoder, portLabel, SERIAL_MEMORY_KEY,
    createWorkerCore, BLOCK_BY_TYPE, makeBuffer, sanitizeParams, GRAPH_VERSION, compile, parseGraph,
} = require('./.build/playgroundserial.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
};

const settle = () => new Promise((res) => setTimeout(res, 0));

// ── a stand-in port ─────────────────────────────────────────────────────────

function fakePort({ info = { usbVendorId: 0x1a86, usbProductId: 0x7523 }, openError = null } = {}) {
    const port = { opened: null, signals: [], written: [], closed: false, lines: { clearToSend: false, dataSetReady: false, dataCarrierDetect: false, ringIndicator: false } };
    let push = null;
    port.getInfo = () => info;
    port.open = async (options) => {
        if (openError) throw openError;
        port.opened = options;
        port.readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(b); } });
        port.writable = new WritableStream({ write(chunk) { port.written.push(...chunk); } });
    };
    port.close = async () => { port.closed = true; };
    port.setSignals = async (s) => { port.signals.push({ ...s }); };
    port.getSignals = async () => ({ ...port.lines });
    port.send = (bytes) => push(Uint8Array.from(bytes));
    return port;
}

function fakeSerial(ports, { picked = ports[0], pickError = null } = {}) {
    const calls = { request: 0, getPorts: 0 };
    return {
        calls,
        requestPort: async () => { calls.request++; if (pickError) throw pickError; return picked; },
        getPorts: async () => { calls.getPorts++; return ports; },
    };
}

/** A clock and timers the test moves on by hand. */
function fakeClock() {
    let now = 0;
    let id = 0;
    const due = new Map();
    return {
        now: () => now,
        timer: (fn, ms) => { const h = ++id; due.set(h, { fn, at: now + ms }); return h; },
        clear: (h) => due.delete(h),
        advance(ms) {
            now += ms;
            const ready = [...due].filter(([, e]) => e.at <= now).sort((a, b) => a[1].at - b[1].at);
            for (const [h, e] of ready) { due.delete(h); e.fn(); }
        },
    };
}

const params = (over = {}) => sanitizeParams(SerialPortBlock, over);

// ── where there can be a port ───────────────────────────────────────────────

t('serial support says yes where there is Web Serial, and why not everywhere else', () => {
    assert.deepStrictEqual(serialSupport({ serial: {} }, true, false), { ok: true, why: '' });
    const chrome = { userAgentData: { brands: [{ brand: 'Google Chrome' }] } };
    assert.match(serialSupport(chrome, false, false).why, /opened over https/);
    assert.match(serialSupport({}, true, false).why, /This browser has no serial ports/);
    assert.match(serialSupport({}, true, true).why, /phone and tablet apps/);
    // The desktop app has Web Serial, so it is never told it has not.
    assert.strictEqual(serialSupport({ serial: {} }, true, true).ok, true);
});

t('a port is opened as the block says: baud, framing and flow control', () => {
    assert.deepStrictEqual(portOptions(params()), { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', bufferSize: 16384 });
    const o = portOptions(params({ baud: 'custom', customBaud: 31250, dataBits: 7, parity: 'even', stopBits: 2, flow: 'hardware' }));
    assert.deepStrictEqual([o.baudRate, o.dataBits, o.parity, o.stopBits, o.flowControl], [31250, 7, 'even', 2, 'hardware']);
    assert.strictEqual(portLabel(fakePort()), 'USB 1a86:7523');
});

// ── text both ways ──────────────────────────────────────────────────────────

t('text is encoded and decoded as asked, a UTF-8 character split across two reads kept whole', () => {
    assert.deepStrictEqual([...encodeText('A€', 'utf-8')], [0x41, 0xe2, 0x82, 0xac]);
    assert.deepStrictEqual([...encodeText('Aé€', 'latin1')], [0x41, 0xe9, 0x3f]);
    assert.deepStrictEqual([...encodeText('Aé', 'ascii')], [0x41, 0x3f]);
    assert.deepStrictEqual([...encodeText('48 65 0a zz 6', 'hex')], [0x48, 0x65, 0x0a]);
    const utf = makeDecoder('utf-8');
    assert.strictEqual(utf(Uint8Array.from([0x41, 0xe2, 0x82])) + utf(Uint8Array.from([0xac])), 'A€');
    assert.strictEqual(makeDecoder('ascii')(Uint8Array.from([0xc1, 0x42])), 'AB');
    assert.strictEqual(makeDecoder('latin1')(Uint8Array.from([0xe9])), 'é');
    assert.strictEqual(makeDecoder('hex')(Uint8Array.from([0x48, 0x0a, 0x01])), '48 0a\n01 ');
});

t('values are written tidily, and the first number in a line is found', () => {
    assert.strictEqual(serialNumber(9.6, 0), '10');
    assert.strictEqual(serialNumber(-0.2, 0), '0');
    assert.strictEqual(serialNumber(0.1 + 0.2, 'auto'), '0.3');
    assert.strictEqual(firstNumber('WPM: 22.5 avg'), 22.5);
    assert.strictEqual(firstNumber('T=-4e2'), -400);
    assert.strictEqual(firstNumber('no digits'), null);
});

// ── the graph's half ────────────────────────────────────────────────────────

/** One packet through the block: what it handed on, and its outputs. */
function run(block, { text = null, key = null, value = null, n = 240 } = {}) {
    const ins = [null, null, null];
    if (text) { ins[0] = makeBuffer('message', 0); ins[0].list = text; }
    if (key) { ins[1] = makeBuffer('real', key.length); ins[1].re.set(key); ins[1].n = key.length; }
    if (value) ins[2] = value;
    const outs = SerialPortBlock.outputs.map((p) => makeBuffer(p.kind, n));
    block.inst.process(ins, outs, key ? key.length : n);
    return { sent: block.inst.read(), outs };
}

function serialBlock(over = {}, rate = 1000) {
    const inst = SerialPortBlock.create();
    inst.configure(params(over), rate);
    return { inst };
}

t('text goes out as it is; anything else as a JSON line, or not at all', () => {
    const b = serialBlock();
    const r = run(b, { text: [{ type: 'text', text: 'CQ ' }, { type: 'text', text: 'DE' }, { type: 'appeared', hz: 7000 }] });
    assert.strictEqual(r.sent.tx, 'CQ DE{"type":"appeared","hz":7000}\n');
    const quiet = serialBlock({ others: 'skip' });
    assert.strictEqual(run(quiet, { text: [{ type: 'measure', a: {} }] }).sent.tx, '');
});

t('a value goes out as a line, once per new value, with its prefix, places and ending', () => {
    const b = serialBlock({ decimals: 1, prefix: 'WPM ', ending: 'crlf' });
    const v = makeBuffer('control', 0);
    v.value = 22.46; v.seq = 1;
    assert.strictEqual(run(b, { value: v }).sent.tx, 'WPM 22.5\r\n');
    assert.strictEqual(run(b, { value: v }).sent.tx, '', 'the same value sent again');
});

t('the key input\'s changes go out with the time into the packet each came', () => {
    const b = serialBlock({}, 1000);
    const key = new Float64Array(20);
    key.fill(1, 5, 12);
    const r = run(b, { key });
    assert.deepStrictEqual(r.sent.edges.map((e) => [Math.round(e.at * 1000), e.on]), [[0, false], [5, true], [12, false]]);
    assert.strictEqual(r.sent.key, 0);
    assert.strictEqual(r.sent.keyLine, 'dtr');
    // Unwired, there is no key at all — so the settings keep the line.
    assert.strictEqual(run(b).sent.key, null);
});

t('received text comes out a line at a time, the unfinished end kept for the next; numbers on the value output', () => {
    const b = serialBlock();
    b.inst.feed({ text: ['temp 21.', '5\nhumid', 'ity 40\r\npart'] });
    const r = run(b);
    assert.deepStrictEqual(r.outs[0].list.map((m) => m.text), ['temp 21.5\n', 'humidity 40\n']);
    assert.strictEqual(r.outs[1].value, 40);
    b.inst.feed({ text: ['ial\n'] });
    assert.deepStrictEqual(run(b).outs[0].list.map((m) => m.text), ['partial\n']);
    const chunks = serialBlock({ receive: 'chunks' });
    chunks.inst.feed({ text: ['ab', 'c'] });
    assert.deepStrictEqual(run(chunks).outs[0].list.map((m) => m.text), ['abc']);
});

t('the key output follows the chosen line, changing where in the packet it changed; each line\'s control only on a change', () => {
    const b = serialBlock({ keyIn: 'dsr' });
    b.inst.feed({ signals: [{ lines: { cts: false, dsr: false, dcd: false, ri: false }, frac: 0 }, { lines: { cts: true, dsr: true, dcd: false, ri: false }, frac: 0.25 }] });
    let r = run(b, { n: 100 });
    const key = r.outs[2].re;
    assert.ok(key[24] === 0 && key[25] === 1 && key[99] === 1, 'not changed at a quarter of the way');
    assert.deepStrictEqual([r.outs[3].value, r.outs[4].value, r.outs[5].value], [1, 1, 0]);
    // Nothing changed since: no control is sent again.
    r = run(b, { n: 100 });
    assert.deepStrictEqual([r.outs[3].seq, r.outs[4].seq, r.outs[5].seq], [0, 0, 0], 'a line resent with no change');
    // Inverted: an adapter whose line idles high reads as key up.
    const inv = serialBlock({ invertKeyIn: true });
    inv.inst.feed({ signals: [{ lines: { cts: true, dsr: false, dcd: false, ri: false }, frac: 0 }] });
    assert.strictEqual(run(inv, { n: 10 }).outs[2].re[5], 0);
});

t('a graph with a serial block and nothing else wired compiles, and needs no receiver', () => {
    const g = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: 'ser', type: 'serial-port' }, { id: 'log', type: 'message-log' }], wires: [['ser', 'text', 'log', 'in']] }).graph;
    assert.deepStrictEqual(compile(g, 48000).errors, []);
    assert.ok(BLOCK_BY_TYPE['serial-port'], 'not registered');
});

// ── the worker between them ─────────────────────────────────────────────────

t('a packet carries what the port took in to the block, and the answer carries what it is to send', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    const graph = {
        v: GRAPH_VERSION,
        nodes: [{ id: 'ser', type: 'serial-port' }, { id: 'con', type: 'console' }],
        wires: [['ser', 'text', 'con', 'in'], ['con', 'out', 'ser', 'text']],
    };
    core.onMessage({ t: 'graph', graph, rate: 48000 });
    core.onMessage({ t: 'packet', seq: 1, i: null, q: null, frames: 960, rate: 48000, serial: { ser: { text: ['hello\n'], signals: [] } } });
    const out = posted.filter((m) => m.t === 'out').pop();
    assert.ok(out && Array.isArray(out.serial), 'no serial in the answer');
    const s = out.serial.find((x) => x.id === 'ser');
    assert.ok(s, 'nothing for the serial block');
    assert.strictEqual(typeof s.tx, 'string');
});

// ── the page's half ─────────────────────────────────────────────────────────

(async () => {
    await tAsync('a link opens the port chosen, remembers it, and the next connect reopens it without a picker', async () => {
        const port = fakePort();
        const serial = fakeSerial([port]);
        const c = fakeClock();
        delete store[SERIAL_MEMORY_KEY];
        const link = new SerialLink('ser', { serial, now: c.now, timer: c.timer, clear: c.clear });
        assert.strictEqual(link.state, 'idle');
        assert.strictEqual(await link.connect(params({ baud: 115200 })), true);
        assert.strictEqual(port.opened.baudRate, 115200);
        assert.strictEqual(link.state, 'open');
        assert.strictEqual(link.remembered(), 'USB 1a86:7523');
        await link.disconnect();
        assert.strictEqual(port.closed, true);
        assert.deepStrictEqual(port.signals[port.signals.length - 1], { dataTerminalReady: false, requestToSend: false }, 'lines not dropped on closing');
        const again = new SerialLink('ser', { serial, now: c.now, timer: c.timer, clear: c.clear });
        await again.connect(params());
        assert.strictEqual(serial.calls.request, 1, 'asked to pick again for a port it already had');
        await again.disconnect();
    });

    await tAsync('a dismissed picker is not a fault; a port someone else has open says so', async () => {
        const c = fakeClock();
        const none = Object.assign(new Error('none'), { name: 'NotFoundError' });
        const link = new SerialLink('a', { serial: fakeSerial([], { pickError: none }), now: c.now, timer: c.timer, clear: c.clear });
        assert.strictEqual(await link.connect(params(), { pick: true }), false);
        assert.strictEqual(link.state, 'idle');
        const busy = Object.assign(new Error('busy'), { name: 'InvalidStateError' });
        const taken = new SerialLink('b', { serial: fakeSerial([fakePort({ openError: busy })]), now: c.now, timer: c.timer, clear: c.clear });
        assert.strictEqual(await taken.connect(params(), { pick: true }), false);
        assert.strictEqual(taken.state, 'error');
        assert.match(taken.message, /already open/);
    });

    await tAsync('what arrives is decoded and held for the graph only while it runs; what the graph sends is written', async () => {
        const port = fakePort();
        const c = fakeClock();
        const link = new SerialLink('ser', { serial: fakeSerial([port]), now: c.now, timer: c.timer, clear: c.clear });
        await link.connect(params({ encoding: 'utf-8' }), { pick: true });
        port.send([0x68, 0x69]);
        await settle();
        assert.deepStrictEqual(link.takeInbound(20), null, 'held while the graph was stopped');
        link.setActive(true);
        port.send([0x6f, 0x6b, 0x0a]);
        await settle();
        const got = link.takeInbound(20);
        assert.deepStrictEqual(got.text, ['ok\n']);
        link.deliver({ tx: 'CQ', edges: [], key: null, dtr: false, rts: false, keyLine: 'dtr' }, 20);
        await settle();
        await settle();
        assert.deepStrictEqual(port.written, [0x43, 0x51]);
        assert.ok(link.txBytes === 2 && link.rxBytes === 5);
        await link.disconnect();
    });

    await tAsync('DTR and RTS follow the settings, a key follows its changes in time, and stopping drops both', async () => {
        const port = fakePort();
        const c = fakeClock();
        const link = new SerialLink('ser', { serial: fakeSerial([port]), now: c.now, timer: c.timer, clear: c.clear });
        await link.connect(params(), { pick: true });
        link.setActive(true);
        const last = () => port.signals[port.signals.length - 1];
        link.deliver({ tx: '', edges: [], key: null, dtr: false, rts: true, keyLine: 'none' }, 20);
        await settle();
        assert.deepStrictEqual(last(), { dataTerminalReady: false, requestToSend: true });
        // A key on DTR: down 5 ms into the packet, up at 12 — played out after
        // the delay that absorbs the worker's bursts.
        link.deliver({ tx: '', edges: [{ at: 0.005, on: true }, { at: 0.012, on: false }], key: 0, dtr: false, rts: true, keyLine: 'dtr' }, 20);
        await settle();
        c.advance(44);
        await settle();
        assert.deepStrictEqual(last(), { dataTerminalReady: false, requestToSend: true }, 'the key went down early');
        c.advance(2);
        await settle();
        assert.deepStrictEqual(last(), { dataTerminalReady: true, requestToSend: true }, 'the key did not go down');
        c.advance(8);
        await settle();
        assert.deepStrictEqual(last(), { dataTerminalReady: false, requestToSend: true }, 'the key did not come up');
        link.setActive(false);
        await settle();
        assert.deepStrictEqual(last(), { dataTerminalReady: false, requestToSend: false }, 'stopping left a line up');
        await link.disconnect();
    });

    await tAsync('a change on the input lines is placed in the next packet where it fell', async () => {
        const port = fakePort();
        const c = fakeClock();
        const link = new SerialLink('ser', { serial: fakeSerial([port]), now: c.now, timer: c.timer, clear: c.clear });
        link.setListening(true);
        await link.connect(params(), { pick: true });
        link.setActive(true);
        link.takeInbound(20); // the lines as they stood
        port.lines.clearToSend = true;
        c.advance(5);
        await settle();
        c.advance(15);
        const got = link.takeInbound(20);
        assert.ok(got && got.signals.length === 1, 'the change was not seen');
        assert.strictEqual(got.signals[0].lines.cts, true);
        assert.ok(Math.abs(got.signals[0].frac - 0.25) < 0.01, `placed at ${got.signals[0].frac}`);
        await link.disconnect();
    });

    await tAsync('without Web Serial a link does nothing at all, and says it cannot', async () => {
        const link = new SerialLink('x', { serial: null });
        assert.strictEqual(link.state, 'unsupported');
        assert.strictEqual(await link.connect(params()), false);
        assert.strictEqual(link.takeInbound(20), null);
        link.deliver({ tx: 'x' }, 20);
    });

    console.log(`\n${pass} passed`);
})();
