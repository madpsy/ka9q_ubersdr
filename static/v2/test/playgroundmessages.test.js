// Messages, and the signal detector that sends them.

const assert = require('assert');
const {
    GRAPH_VERSION, parseGraph, Runtime, createWorkerCore, findSignals, frequencyOrigins, inputOrigin, controlPort,
} = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;
const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

/** A stream of carriers (each { hz, amp, until? }) over a little noise. */
function band(carriers) {
    let k = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    return () => {
        const I = new Float32Array(240);
        const Q = new Float32Array(240);
        for (let j = 0; j < 240; j++, k++) {
            let i = 0.002 * rnd();
            let q = 0.002 * rnd();
            for (const c of carriers) {
                if (c.until && k / RATE > c.until) continue;
                const ph = (2 * Math.PI * c.hz * k) / RATE;
                i += c.amp * Math.cos(ph);
                q += c.amp * Math.sin(ph);
            }
            I[j] = i;
            Q[j] = q;
        }
        return { i: I, q: Q, frames: 240, rate: RATE };
    };
}

function detectorGraph(extra = {}) {
    return graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'det', type: 'signal-detector', params: { intervalMs: 200, size: 2048, ...extra } },
            { id: 'log', type: 'message-log' },
        ],
        [['iq', 'out', 'det', 'in'], ['det', 'events', 'log', 'in']],
    );
}

t('peaks are found over the median, merged when close, strongest first, and capped', () => {
    const db = new Float32Array(1000).fill(-90);
    db[100] = -30; db[101] = -32; db[102] = -45;
    db[400] = -20;
    db[700] = -85;                       // under the threshold
    db[710] = -50; db[712] = -52;        // a second peak 24 Hz away: merged
    const r = findSignals(db, 12000, { thresholdDb: 10, gapHz: 50, max: 8 });
    assert.strictEqual(r.floorDb, -90);
    // Strongest first. The interpolated levels sit at or above the bins they
    // came from — a peak between bins is higher than either.
    const levels = r.list.map((s) => s.db);
    assert.strictEqual(Math.round(levels[0]), -20);
    assert.ok(levels[1] >= -30 && levels[1] < -20, `second ${levels[1]}`);
    assert.strictEqual(Math.round(levels[2]), -50);
    assert.strictEqual(r.list.length, 3);
    assert.ok(r.list[0].snrDb === 70);
    const capped = findSignals(db, 12000, { thresholdDb: 10, gapHz: 50, max: 2 });
    assert.strictEqual(capped.list.length, 2);
});

t('the detector finds carriers to within a hertz, and names the strongest', () => {
    const rt = new Runtime(detectorGraph(), RATE);
    const next = band([{ hz: -2000, amp: 0.1 }, { hz: 1234.5, amp: 0.03 }, { hz: 3000, amp: 0.01 }]);
    for (let p = 0; p < 60; p++) rt.process(next());
    const sig = rt.read('det').signals;
    assert.strictEqual(sig.length, 3, JSON.stringify(sig));
    const byHz = (hz) => sig.find((s) => Math.abs(s.hz - hz) < 20);
    for (const hz of [-2000, 1234.5, 3000]) assert.ok(byHz(hz) && Math.abs(byHz(hz).hz - hz) < 1, `${hz} Hz: ${byHz(hz) && byHz(hz).hz}`);
    assert.ok(Math.abs(byHz(-2000).db - 20 * Math.log10(0.1)) < 1.5, `level ${byHz(-2000).db}`);
});

t('appearing is said once; going is said once, and only after a few looks without it', () => {
    const rt = new Runtime(detectorGraph(), RATE);
    const next = band([{ hz: 500, amp: 0.1 }, { hz: -1500, amp: 0.05, until: 2 }]);
    const events = [];
    for (let p = 0; p < 50 * 4; p++) {
        rt.process(next());
        // Read straight off the wire each packet: a message is there for the
        // packet it was sent in and gone the next.
        const wire = rt.nodes.get('det').outs[0];
        events.push(...wire.list.map((m) => ({ ...m, packet: p })));
    }
    const appeared = events.filter((e) => e.type === 'appeared');
    const gone = events.filter((e) => e.type === 'gone');
    assert.strictEqual(appeared.length, 2, JSON.stringify(appeared));
    assert.strictEqual(gone.length, 1);
    assert.ok(Math.abs(gone[0].hz + 1500) < 5);
    // The carrier stopped at 2 s; looks are every 200 ms, gone after three.
    assert.ok(gone[0].at >= 2.4 && gone[0].at <= 3.0, `said gone at ${gone[0].at}s`);
    assert.ok(gone[0].lastedSec > 1, `lasted ${gone[0].lastedSec}`);
    // And the log has each event once, newest first.
    const lines = rt.read('log').lines;
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].type, 'gone');
});

t('half a minute of noise alone announces nothing', () => {
    const rt = new Runtime(detectorGraph(), RATE);
    const next = band([]);
    let announced = 0;
    for (let p = 0; p < 50 * 30; p++) {
        rt.process(next());
        announced += rt.nodes.get('det').outs[0].list.length;
    }
    assert.strictEqual(announced, 0, `${announced} signals found in noise`);
});

t('the strongest signal can tune a demodulator', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'det', type: 'signal-detector', params: { intervalMs: 200 } },
            { id: 'd', type: 'demodulator', params: { mode: 'am', widthHz: 6000 }, controls: ['offsetHz'] },
            { id: 'o', type: 'audio-out' },
        ],
        [['iq', 'out', 'det', 'in'], ['iq', 'out', 'd', 'in'], ['det', 'strongest', 'd', controlPort('offsetHz')], ['d', 'audio', 'o', 'in']],
    );
    const rt = new Runtime(g, RATE);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const next = band([{ hz: 1100, amp: 0.1 }, { hz: -2500, amp: 0.02 }]);
    for (let p = 0; p < 40; p++) rt.process(next());
    assert.ok(Math.abs(rt.driven().d.offsetHz - 1100) < 2, `tuned to ${rt.driven().d.offsetHz}`);
});

t('a log names its events in real frequencies, through the detector feeding it', () => {
    const g = detectorGraph();
    const o = frequencyOrigins(g, 7_100_000);
    assert.strictEqual(inputOrigin(g, o, 'log'), 7_100_000);
    assert.strictEqual(inputOrigin(g, o, 'det'), 7_100_000);
});

t('messages and lists survive the trip back from the worker as lists', () => {
    const sent = [];
    let clock = 0;
    const core = createWorkerCore((m) => sent.push(m), () => clock);
    core.onMessage({ t: 'graph', graph: detectorGraph() });
    core.onMessage({ t: 'watch', ids: ['log', 'det'] });
    const next = band([{ hz: 800, amp: 0.1 }]);
    for (let p = 0; p < 30; p++) {
        clock += 20;
        core.onMessage({ t: 'packet', seq: p, ...next() });
    }
    const r = sent.filter((m) => m.t === 'out' && m.readings).pop().readings;
    assert.ok(Array.isArray(r.log.lines), 'the log’s lines arrived as an object');
    assert.ok(Array.isArray(r.det.signals));
    assert.strictEqual(r.log.lines[0].type, 'appeared');
});

console.log(`\n${pass} passed`);
