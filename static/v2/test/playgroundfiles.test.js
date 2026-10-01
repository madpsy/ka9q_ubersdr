// IQ files: reading them, playing them, recording them — and running a graph
// with no receiver at all.

const assert = require('assert');

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const {
    IQDemod, resetIQOwner, GRAPH_VERSION, parseGraph, Runtime, compile, createHost,
    WavRecording, encodeWav16, PlaygroundEngine, OFFLINE_RATE, needsReceiver, centreFromName, decodeWav,
    frequencyOrigins,
} = require('./.build/playgroundengine.cjs');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

// ── building WAV files by hand ──────────────────────────────────────────────

function wav({ format = 1, bits = 16, channels = 2, rate = 48000, frames = 100, sample = (k, c) => 0, extensible = false, auxiHz = 0, dataSize }) {
    const width = bits / 8;
    const align = width * channels;
    const fmtSize = extensible ? 40 : 16;
    const auxi = auxiHz ? 8 + 36 : 0;
    const dataBytes = frames * align;
    const buf = new ArrayBuffer(12 + 8 + fmtSize + auxi + 8 + dataBytes);
    const v = new DataView(buf);
    const str = (at, s) => { for (let k = 0; k < 4; k++) v.setUint8(at + k, s.charCodeAt(k)); };
    str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
    let at = 12;
    str(at, 'fmt '); v.setUint32(at + 4, fmtSize, true);
    v.setUint16(at + 8, extensible ? 0xfffe : format, true);
    v.setUint16(at + 10, channels, true);
    v.setUint32(at + 12, rate, true);
    v.setUint32(at + 16, rate * align, true);
    v.setUint16(at + 20, align, true);
    v.setUint16(at + 22, bits, true);
    if (extensible) { v.setUint16(at + 24, 22, true); v.setUint16(at + 32, format, true); }
    at += 8 + fmtSize;
    if (auxiHz) {
        str(at, 'auxi'); v.setUint32(at + 4, 36, true);
        v.setUint32(at + 8 + 32, auxiHz, true);
        at += 8 + 36;
    }
    str(at, 'data'); v.setUint32(at + 4, dataSize === undefined ? dataBytes : dataSize, true);
    at += 8;
    for (let k = 0; k < frames; k++) {
        for (let c = 0; c < channels; c++) {
            const x = sample(k, c);
            const o = at + k * align + c * width;
            if (format === 3) v.setFloat32(o, x, true);
            else if (bits === 8) v.setUint8(o, Math.round(x * 127) + 128);
            else if (bits === 16) v.setInt16(o, Math.round(x * 32767), true);
            else if (bits === 24) {
                const n = Math.round(x * 8388607);
                v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setInt8(o + 2, n >> 16);
            } else v.setInt32(o, Math.round(x * 2147483647), true);
        }
    }
    return buf;
}

const ramp = (k, c) => (c === 0 ? Math.sin(k / 7) * 0.8 : Math.cos(k / 5) * -0.6);

// ── reading ─────────────────────────────────────────────────────────────────

t('every sample format IQ is written in reads back as written', () => {
    const cases = [
        // The writer here scales 8-bit by 127 and the reader by 128, as
        // the format defines: a difference of under 1%.
        [{ bits: 8 }, 0.02], [{ bits: 16 }, 1e-4], [{ bits: 24 }, 1e-6], [{ bits: 32 }, 1e-7],
        [{ format: 3, bits: 32 }, 1e-7], [{ bits: 16, extensible: true }, 1e-4], [{ format: 3, bits: 32, extensible: true }, 1e-7],
    ];
    for (const [opts, tol] of cases) {
        const d = decodeWav(wav({ ...opts, sample: ramp }));
        assert.strictEqual(d.frames, 100, JSON.stringify(opts));
        assert.strictEqual(d.rate, 48000);
        for (const k of [0, 13, 99]) {
            assert.ok(Math.abs(d.i[k] - ramp(k, 0)) < tol, `${JSON.stringify(opts)}: I[${k}] ${d.i[k]} vs ${ramp(k, 0)}`);
            assert.ok(Math.abs(d.q[k] - ramp(k, 1)) < tol, `${JSON.stringify(opts)}: Q[${k}]`);
        }
    }
});

t('a mono file plays as a real signal, Q all zero', () => {
    const d = decodeWav(wav({ channels: 1, sample: (k) => 0.5 }));
    assert.strictEqual(d.channels, 1);
    assert.ok(Math.abs(d.i[10] - 0.5) < 1e-4);
    assert.strictEqual(d.q[10], 0);
});

t('the centre frequency comes from an auxi chunk, or else from the name', () => {
    assert.strictEqual(decodeWav(wav({ auxiHz: 14074000 }), 'x.wav').centreHz, 14074000);
    assert.strictEqual(decodeWav(wav({}), 'ubersdr-playground-iq-7100000Hz-20261001-120000.wav').centreHz, 7100000);
    assert.strictEqual(centreFromName('HDSDR_20210101_123456Z_14074kHz_RF.wav'), 14074000);
    assert.strictEqual(centreFromName('SDRuno_7.1MHz.wav'), null, 'too few digits to be a frequency');
    assert.strictEqual(centreFromName('gqrx_20240101_120000_7100000_48000_fc.wav'), null);
    assert.strictEqual(decodeWav(wav({}), 'plain.wav').centreHz, null);
});

t('a file cut short, with no data size written, is read to its end', () => {
    const d = decodeWav(wav({ frames: 50, dataSize: 0, sample: ramp }));
    assert.strictEqual(d.frames, 50);
});

t('what is not an IQ WAV file says so, in words', () => {
    assert.throws(() => decodeWav(new ArrayBuffer(40)), /Not a WAV file/);
    assert.throws(() => decodeWav(wav({ channels: 4 })), /4 channels/);
    assert.throws(() => decodeWav(wav({ format: 2 })), /sample format/);
    const noData = wav({ frames: 0 });
    new DataView(noData).setUint8(36, 'x'.charCodeAt(0));
    assert.throws(() => decodeWav(noData), /no audio/);
});

// ── playing ─────────────────────────────────────────────────────────────────

function player(params = {}) {
    return graph(
        [{ id: 'pl', type: 'iq-player', params: { rateHz: 48000, ...params } }, { id: 're', type: 'real-part' }, { id: 'o', type: 'audio-out' }],
        [['pl', 'out', 're', 'in'], ['re', 'out', 'o', 'in']],
    );
}
const file = (n, rate = 48000) => ({ i: Float32Array.from({ length: n }, (_, k) => k / n), q: new Float32Array(n), frames: n, rate });

t('a player runs at its file’s rate, whatever the clock’s, without drifting', () => {
    const g = player();
    assert.strictEqual(compile(g, 12000).outRate.pl, 48000);
    const rt = new Runtime(g, 12000);
    rt.load('pl', file(100000));
    let total = 0;
    // 7 ms packets at 12 kHz are 84 samples: 336 at the file's 48 kHz.
    for (let p = 0; p < 1000; p++) {
        rt.process({ i: null, q: null, frames: 84, rate: 12000 });
        total += rt.read('o').frames;
    }
    assert.strictEqual(total, 336000);
    assert.strictEqual(rt.read('o').rate, 48000);
    // And with a ratio that does not divide: 12 kHz into 44.1.
    const odd = new Runtime(player({ rateHz: 44100 }), 12000);
    odd.load('pl', file(100000, 44100));
    let sum = 0;
    for (let p = 0; p < 500; p++) {
        odd.process({ i: null, q: null, frames: 240, rate: 12000 });
        sum += odd.read('o').frames;
    }
    assert.ok(Math.abs(sum - (500 * 240 * 44100) / 12000) <= 1, `${sum} samples, not ${(500 * 240 * 44100) / 12000}`);
});

t('a player plays its file in order, loops, or stops at the end', () => {
    const rt = new Runtime(player(), 48000);
    rt.load('pl', file(1000));
    const out = [];
    for (let p = 0; p < 3; p++) {
        rt.process({ i: null, q: null, frames: 480, rate: 48000 });
        out.push(...rt.read('o').samples);
    }
    assert.ok(Math.abs(out[999] - 999 / 1000) < 1e-6);
    assert.ok(Math.abs(out[1000] - 0) < 1e-6, 'did not loop to the start');
    const once = new Runtime(player({ loop: false }), 48000);
    once.load('pl', file(1000));
    const o2 = [];
    for (let p = 0; p < 3; p++) {
        once.process({ i: null, q: null, frames: 480, rate: 48000 });
        o2.push(...once.read('o').samples);
    }
    assert.strictEqual(o2[1200], 0, 'played past the end');
    assert.ok(once.read('pl').ended);
    once.command('pl', 'restart');
    once.process({ i: null, q: null, frames: 480, rate: 48000 });
    assert.ok(Math.abs(once.read('o').samples[10] - 10 / 1000) < 1e-6, 'restart did not go back to the start');
});

t('a player with no file is silent, and says so', () => {
    const rt = new Runtime(player(), 48000);
    rt.process({ i: null, q: null, frames: 480, rate: 48000 });
    assert.ok(rt.read('o').samples.every((v) => v === 0));
    assert.strictEqual(rt.read('pl').loaded, false);
});

t('a player’s spectrum is labelled at its file’s centre frequency', () => {
    const g = graph(
        [{ id: 'pl', type: 'iq-player', params: { centreHz: 14074000 } }, { id: 'sh', type: 'shift', params: { frequencyHz: -1000 } }],
        [['pl', 'out', 'sh', 'in']],
    );
    const o = frequencyOrigins(g, 7100000);
    assert.strictEqual(o.get('pl.out'), 14074000);
    assert.strictEqual(o.get('sh.out'), 14075000);
    assert.strictEqual(frequencyOrigins(graph([{ id: 'pl', type: 'iq-player' }], []), 7100000).get('pl.out'), null);
});

// ── running with no receiver ────────────────────────────────────────────────

function fakePlayer() {
    const node = (kind, extra = {}) => ({ kind, out: new Set(), connect(to) { this.out.add(to); return to; }, disconnect() { this.out.clear(); }, ...extra });
    const param = () => ({ value: 1, setTargetAtTime(v) { this.value = v; } });
    const sources = [];
    const ctx = {
        state: 'running', currentTime: 0, destination: node('destination'),
        createGain: () => node('gain', { gain: param() }),
        createStereoPanner: () => node('panner', { pan: { ...param(), value: 0 } }),
        createBuffer: (ch, n, rate) => ({ duration: n / rate, copyToChannel() {} }),
        createBufferSource: () => { const s = node('source', { start() {} }); sources.push(s); return s; },
    };
    let taps = 0;
    return {
        ctx: null, ducked: false, outputBus: null, sources, own: ctx,
        setDucked(v) { this.ducked = v; },
        onAudio() { taps++; return () => { taps--; }; },
        taps: () => taps,
    };
}

t('a graph with no IQ stream runs by itself: no mode, no duck, no claim, its own audio', () => {
    resetIQOwner();
    const pl = fakePlayer();
    globalThis.window = { AudioContext: function AudioContext() { return pl.own; } };
    let clock = 0;
    const pg = new PlaygroundEngine(pl, { hostFactory: (m) => createHost(m, { worker: false }), now: () => clock });
    const demod = new IQDemod(pl);
    try {
        demod.setQuadrature(true);
        demod.start();
        pg.setGraph(player());
        assert.strictEqual(needsReceiver(pg.graph), false);
        pg.start();
        assert.ok(pg.offline);
        assert.ok(demod.running, 'a file playing stopped the IQ Demod panel');
        assert.strictEqual(pl.taps(), 1, 'tapped the receiver for a graph that does not listen to it');
        // A packet for every 20 ms of clock.
        assert.ok(pg.loadFile('pl', { ...file(48000), centreHz: 0 }, 'test.wav'));
        assert.strictEqual(pg.paramsOf('pl').fileName, 'test.wav');
        clock += 100;
        pg._tick();
        assert.ok(pl.sources.length >= 1, 'nothing was played');
        assert.strictEqual(pg.streamRate, OFFLINE_RATE);
        assert.ok(pg.routes.voices.get('o'), 'no voice');
        // The IQ Demod panel is still ducking its own noise; the playground
        // has not joined it.
        assert.ok(!pg._ducking, 'ducked the receiver for a file');
        // A long sleep is not paid back in full.
        const before = pl.sources.length;
        clock += 60000;
        pg._tick();
        assert.ok(pl.sources.length - before < 20, 'woke to a minute of packets');
        pg.stop();
        assert.ok(demod.running);
    } finally {
        demod.destroy();
        pg.destroy();
        delete globalThis.window;
    }
});

t('the file survives the worker being started again', () => {
    resetIQOwner();
    const pl = fakePlayer();
    globalThis.window = { AudioContext: function AudioContext() { return pl.own; } };
    const sent = [];
    const pg = new PlaygroundEngine(pl, {
        hostFactory: (m) => {
            const h = createHost(m, { worker: false });
            const send = h.send.bind(h);
            h.send = (msg, tr) => { sent.push(msg.t); send(msg, tr); };
            return h;
        },
    });
    try {
        pg.setGraph(player());
        pg.loadFile('pl', file(1000), 'a.wav');
        pg.start();
        pg.stop();
        sent.length = 0;
        pg.start();
        assert.ok(sent.includes('load'), 'the file was not sent to the new worker');
        assert.ok(pg.hasFile('pl'));
        // Removing the player lets the file go.
        pg.setGraph(graph([{ id: 'x', type: 'signal' }], []));
        assert.ok(!pg.hasFile('pl'));
    } finally {
        pg.destroy();
        delete globalThis.window;
    }
});

t('changing between a file graph and a receiver graph while running stops, rather than running the wrong way', () => {
    resetIQOwner();
    const pl = fakePlayer();
    globalThis.window = { AudioContext: function AudioContext() { return pl.own; } };
    const pg = new PlaygroundEngine(pl, { hostFactory: (m) => createHost(m, { worker: false }) });
    try {
        pg.setGraph(player());
        pg.start();
        pg.setGraph(graph([{ id: 'iq', type: 'iq-in' }, { id: 'r', type: 'real-part' }, { id: 'o', type: 'audio-out' }], [['iq', 'out', 'r', 'in'], ['r', 'out', 'o', 'in']]));
        assert.ok(!pg.running);
    } finally {
        pg.destroy();
        delete globalThis.window;
    }
});

// ── recording IQ, and playing it back ───────────────────────────────────────

t('an IQ recording is I left and Q right, named for its frequency, and plays back with it', async () => {
    resetIQOwner();
    const pl = fakePlayer();
    globalThis.window = { AudioContext: function AudioContext() { return pl.own; } };
    let clock = 0;
    const pg = new PlaygroundEngine(pl, { hostFactory: (m) => createHost(m, { worker: false }), now: () => clock });
    try {
        pg.setGraph(graph(
            [{ id: 'pl', type: 'iq-player', params: { rateHz: 48000 } }, { id: 'rec', type: 'iq-recorder' }],
            [['pl', 'out', 'rec', 'in']],
        ));
        const n = 4800;
        const src = {
            i: Float32Array.from({ length: n }, (_, k) => Math.sin(k / 9) * 0.5),
            q: Float32Array.from({ length: n }, (_, k) => Math.cos(k / 9) * 0.5),
            frames: n, rate: 48000,
        };
        pg.loadFile('pl', src, 'src.wav');
        pg.start();
        pg.startRecording('rec', 'iq-7100000Hz');
        for (let k = 0; k < 5; k++) { clock += 20; pg._tick(); }
        const rec = pg.recordings.get('rec');
        pg.stopRecording('rec');
        assert.strictEqual(rec.channels, 2);
        assert.match(rec.filename(), /^ubersdr-playground-iq-7100000Hz-\d{8}-\d{6}\.wav$/);
        const back = decodeWav(encodeWav16(rec.chunks, rec.rate, rec.channels), rec.filename());
        assert.strictEqual(back.centreHz, 7100000);
        assert.strictEqual(back.rate, 48000);
        for (const k of [0, 17, 500]) {
            assert.ok(Math.abs(back.i[k] - src.i[k]) < 1e-4 && Math.abs(back.q[k] - src.q[k]) < 1e-4, `sample ${k}`);
        }
    } finally {
        pg.destroy();
        delete globalThis.window;
    }
});

(async () => {
    for (const [name, fn] of queue) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass} passed`);
})();
