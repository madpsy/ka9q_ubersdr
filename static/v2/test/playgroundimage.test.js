// Pictures: the gallery the page keeps, the viewer's every-packet plumbing,
// Hellschreiber, and the HF channel simulator.

const assert = require('assert');
const { Gallery, HellDecoder, FadingTap, WATTERSON, createWorkerCore, BLOCK_BY_TYPE, makeBuffer, sanitizeParams, GRAPH_VERSION } = require('./.build/playgroundimage.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

t('the gallery draws grey and colour lines into RGBA, grows a picture of no stated height, and keeps the last few', () => {
    const g = new Gallery(2);
    g.apply({ type: 'image', event: 'start', id: 'a', mode: 'Test', width: 2, height: 2, colour: 'rgb' });
    g.apply({ type: 'image', event: 'line', id: 'a', y: 1, pixels: Uint8ClampedArray.from([10, 20, 30, 40, 50, 60]) });
    const a = g.byId('a');
    assert.deepStrictEqual(Array.from(a.data.slice(8, 16)), [10, 20, 30, 255, 40, 50, 60, 255]);
    assert.strictEqual(a.rows, 2);
    g.apply({ type: 'image', event: 'start', id: 'b', mode: 'Fax', width: 3, height: null, colour: 'gray' });
    g.apply({ type: 'image', event: 'line', id: 'b', y: 200, pixels: Uint8ClampedArray.from([1, 2, 3]) });
    const b = g.byId('b');
    assert.ok(b.capacity > 200 && b.rows === 201, `capacity ${b.capacity}`);
    assert.deepStrictEqual(Array.from(b.data.slice(200 * 12, 200 * 12 + 4)), [1, 1, 1, 255]);
    g.apply({ type: 'image', event: 'end', id: 'b', complete: true });
    assert.strictEqual(b.complete, true);
    g.apply({ type: 'image', event: 'start', id: 'c', width: 1, height: 1 });
    assert.deepStrictEqual(g.pictures.map((p) => p.id), ['b', 'c'], 'kept more than asked');
    // A line whose start was missed starts a picture of its own width.
    g.apply({ type: 'image', event: 'line', id: 'z', y: 0, width: 4, pixels: new Uint8ClampedArray(4) });
    assert.strictEqual(g.byId('z').width, 4);
});

// Feld Hell, keyed from a pattern: `cols` columns of 14 half-elements each,
// bottom to top, at 245 a second, a 1 kHz tone for each 1.
function hellAudio(cols, rate) {
    const per = rate / 245;
    const n = Math.round(cols.length * 14 * per) + rate / 10;
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const e = Math.floor(k / per);
        const c = Math.floor(e / 14);
        const on = c < cols.length && cols[c][e % 14];
        if (on) x[k] = Math.sin((2 * Math.PI * 1000 * k) / rate);
    }
    return x;
}

t('Hellschreiber draws a keyed column where it was keyed, in both copies of the strip', () => {
    const rate = 12000;
    // Ten columns: the bottom half lit in even ones, all dark in odd ones.
    const cols = Array.from({ length: 10 }, (_, c) => Array.from({ length: 14 }, (_, k) => (c % 2 === 0 && k < 7 ? 1 : 0)));
    const dec = new HellDecoder({ sampleRate: rate, width: 40 });
    const x = hellAudio(cols, rate);
    dec.process(x, x.length);
    const g = new Gallery();
    for (const e of dec.drain()) g.apply(e);
    const p = g.pictures[0];
    assert.ok(p && p.width === 40 && p.rows === 28, `picture ${p && p.rows}`);
    const px = (x0, y) => p.data[(y * p.width + x0) * 4];
    // Bottom half of column 4 inked (dark), its top white; column 5 white throughout — in each copy.
    for (const base of [0, 14]) {
        assert.ok(px(4, base + 12) < 80, `column 4 bottom ${px(4, base + 12)}`);
        assert.ok(px(4, base + 2) > 170, `column 4 top ${px(4, base + 2)}`);
        assert.ok(px(5, base + 12) > 170, `column 5 ${px(5, base + 12)}`);
    }
});

t('an Image viewer in the worker hands its pictures on with every packet', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    core.onMessage({
        t: 'graph', rate: 12000,
        graph: {
            v: GRAPH_VERSION,
            nodes: [
                { id: 'sig', type: 'signal', params: { frequencyHz: 1000, amplitude: 0.5 } },
                { id: 're', type: 'real-part' },
                { id: 'hell', type: 'hell', params: { width: 40 } },
                { id: 'img', type: 'image-viewer' },
            ],
            wires: [['sig', 'out', 're', 'in'], ['re', 'out', 'hell', 'audio'], ['hell', 'images', 'img', 'in']],
        },
    });
    assert.ok(posted.find((m) => m.t === 'status').ok);
    for (let k = 0; k < 100; k++) core.onMessage({ t: 'packet', seq: k, i: null, q: null, frames: 240, rate: 12000 });
    const events = posted.filter((m) => m.t === 'out').flatMap((m) => (m.images || []).flatMap((im) => im.events));
    assert.ok(events.some((e) => e.event === 'start'), 'no start');
    assert.ok(events.filter((e) => e.event === 'line').length > 20, 'too few lines');
    // Nobody watching: the readings never asked, and the pictures came all the same.
    assert.ok(posted.every((m) => !m.readings || !m.readings.img));
});

// ── the HF channel ──────────────────────────────────────────────────────────

/** A unit carrier through an HF channel block, `secs` long. */
function through(params, secs, rate = 1000) {
    const def = BLOCK_BY_TYPE['hf-channel'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), rate);
    const n = secs * rate;
    const out = { re: new Float64Array(n), im: new Float64Array(n) };
    for (let at = 0; at < n; at += 500) {
        const x = makeBuffer('complex', 500);
        x.re.fill(1); x.n = 500;
        const o = makeBuffer('complex', 500);
        inst.process([x], [o], 500);
        out.re.set(o.re, at); out.im.set(o.im, at);
    }
    return out;
}

t('the HF channel keeps the average power and fades: deep, and faster for a wider Doppler spread', () => {
    const slow = through({ preset: 'good', seed: 3 }, 600);
    const pw = (o, a, b) => { let s = 0; for (let k = a; k < b; k++) s += o.re[k] ** 2 + o.im[k] ** 2; return s / (b - a); };
    const mean = pw(slow, 0, slow.re.length);
    assert.ok(mean > 0.6 && mean < 1.5, `mean power ${mean}`);
    // Fast fading: the power one second against the next differs far more often.
    const fast = through({ preset: 'flutter', seed: 3 }, 60);
    const change = (o) => { let c = 0; for (let s = 0; s + 2 <= 60; s++) { const a = pw(o, s * 1000, s * 1000 + 100); const b = pw(o, s * 1000 + 500, s * 1000 + 600); if (Math.abs(10 * Math.log10(a / b)) > 3) c++; } return c; };
    assert.ok(change(fast) > change(slow), `flutter ${change(fast)} vs good ${change(slow)}`);
    // A Rayleigh channel has deep fades: somewhere well under the mean.
    let lo = Infinity;
    for (let s = 0; s < 600; s++) lo = Math.min(lo, pw(slow, s * 1000, s * 1000 + 100));
    assert.ok(lo < mean / 10, `shallowest fade ${10 * Math.log10(lo / mean)} dB`);
    assert.strictEqual(WATTERSON.poor.delayMs, 2);
});

t('the HF channel’s second path arrives the delay spread later, and the offset moves the carrier', () => {
    const def = BLOCK_BY_TYPE['hf-channel'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, { preset: 'custom', delayMs: 5, dopplerHz: 0.01 }), 1000);
    const x = makeBuffer('complex', 20);
    x.re[2] = 1; x.n = 20;
    const o = makeBuffer('complex', 20);
    inst.process([x], [o], 20);
    const mag = Array.from({ length: 20 }, (_, k) => Math.hypot(o.re[k], o.im[k]));
    const lit = mag.map((m, k) => (m > 0.01 ? k : -1)).filter((k) => k >= 0);
    assert.deepStrictEqual(lit, [2, 7], `paths at ${lit}`);
    const shifted = through({ preset: 'custom', delayMs: 0, dopplerHz: 0.01, offsetHz: 10 }, 2);
    const d = Math.atan2(shifted.im[1001] * shifted.re[1000] - shifted.re[1001] * shifted.im[1000], shifted.re[1001] * shifted.re[1000] + shifted.im[1001] * shifted.im[1000]);
    assert.ok(Math.abs(d - (2 * Math.PI * 10) / 1000) < 1e-3, `step ${d}`);
    assert.ok(new FadingTap(100, 1, Math.random).h.length > 10);
});

console.log(`\n${pass} passed`);
