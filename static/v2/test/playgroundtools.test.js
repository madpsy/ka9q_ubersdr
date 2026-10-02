// The stream tools, the shaping filters and the newer viewers.

const assert = require('assert');
const {
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, rootRaisedCosine, gaussianTaps, hilbertTaps, parseTaps, matchedTaps, STRIP_COLUMNS,
    ConvEncoder, Viterbi, CODES, hardScores, Runtime, GRAPH_VERSION, parseGraph, encodeVaricode, beaconAt, NCDXF_BEACONS,
} = require('./.build/playgroundtools.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);

/** A block of `type` at `rate`, run once over `ins` (arrays: real Float64Array, complex {re, im}). */
function run(type, params, ins, { rate = 1000, n = null, inRates = null } = {}) {
    const def = BLOCK_BY_TYPE[type];
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), rate, inRates);
    const step = (data) => {
        const bufs = data.map((d) => {
            if (d == null) return null;
            if (d.re) { const b = makeBuffer('complex', d.re.length); b.re.set(d.re); b.im.set(d.im); b.n = d.re.length; return b; }
            const b = makeBuffer('real', d.length); b.re.set(d); b.n = d.length; return b;
        });
        const len = n != null ? n : (bufs.find(Boolean) || { n: 0 }).n;
        const cap = def.maxOut ? def.maxOut(len, sanitizeParams(def, params), rate) : len;
        const outs = def.outputs.map((p) => makeBuffer(p.kind, Math.max(cap, 1)));
        const m = inst.process(bufs, outs, len);
        return { outs, m };
    };
    const first = step(ins);
    return { inst, step, ...first };
}

const tone = (hz, n, rate, amp = 1) => {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k < n; k++) { re[k] = amp * Math.cos((2 * Math.PI * hz * k) / rate); im[k] = amp * Math.sin((2 * Math.PI * hz * k) / rate); }
    return { re, im };
};

// ── stream tools ────────────────────────────────────────────────────────────

t('Phase: a tone off zero is a ramp unwrapped, a sawtooth wrapped; in degrees or cycles', () => {
    const x = tone(10, 1000, 1000);
    const un = run('phase', { unwrap: true }, [x]).outs[0].re;
    near(un[999] - un[0], 2 * Math.PI * 10 * 999 / 1000, 1e-9, 'unwrapped span');
    const wr = run('phase', { unwrap: false }, [x]).outs[0].re;
    assert.ok(wr.every((v) => v > -Math.PI - 1e-12 && v <= Math.PI + 1e-12));
    const cyc = run('phase', { unwrap: true, units: 'cyc' }, [x]).outs[0].re;
    near(cyc[999] - cyc[0], 9.99, 1e-9, 'cycles');
});

t('Moving average: a step rises over its length; the sum is the mean times the length', () => {
    const step = new Float64Array(20).fill(1, 5);
    const y = run('moving-average', { length: 4 }, [step]).outs[0].re;
    assert.deepStrictEqual(Array.from(y.slice(4, 10)), [0, 0.25, 0.5, 0.75, 1, 1]);
    const s = run('moving-average', { length: 4, sum: true }, [step]).outs[0].re;
    assert.strictEqual(s[12], 4);
});

t('Integrate & dump: N to one, the rate down by N', () => {
    const x = Float64Array.from({ length: 12 }, (_, k) => k);
    const r = run('integrate-dump', { length: 4 }, [x]);
    assert.strictEqual(r.m, 3);
    assert.deepStrictEqual(Array.from(r.outs[0].re.slice(0, 3)), [6, 22, 38]);
    assert.deepStrictEqual(Array.from(run('integrate-dump', { length: 4, mean: true }, [x]).outs[0].re.slice(0, 2)), [1.5, 5.5]);
    assert.strictEqual(BLOCK_BY_TYPE['integrate-dump'].rate(1000, { length: 4 }), 250);
});

t('Differentiator: a ramp\'s slope, per sample or per second', () => {
    const x = Float64Array.from({ length: 5 }, (_, k) => 3 * k);
    assert.deepStrictEqual(Array.from(run('differentiate', {}, [x]).outs[0].re), [0, 3, 3, 3, 3]);
    assert.strictEqual(run('differentiate', { scaleToSeconds: true }, [x], { rate: 100 }).outs[0].re[2], 300);
});

t('Sample & hold: follows while the gate is high, or takes one at each rising edge', () => {
    const x = Float64Array.from([1, 2, 3, 4, 5, 6]);
    const g = Float64Array.from([1, 1, 0, 0, 1, 1]);
    assert.deepStrictEqual(Array.from(run('sample-hold', {}, [x, g]).outs[0].re), [1, 2, 2, 2, 5, 6]);
    assert.deepStrictEqual(Array.from(run('sample-hold', { mode: 'edge' }, [x, g]).outs[0].re), [1, 1, 1, 1, 5, 5]);
});

t('Keep 1 in N keeps every Nth from its offset; Switch passes A or B as told', () => {
    const x = Float64Array.from({ length: 10 }, (_, k) => k);
    const r = run('keep-one-in-n', { n: 3, offset: 1 }, [x]);
    assert.deepStrictEqual(Array.from(r.outs[0].re.slice(0, r.m)), [1, 4, 7]);
    const a = Float64Array.from([1, 1]);
    const b = Float64Array.from([2, 2]);
    assert.deepStrictEqual(Array.from(run('selector', {}, [a, b]).outs[0].re), [1, 1]);
    assert.deepStrictEqual(Array.from(run('selector', { useB: true }, [a, b]).outs[0].re), [2, 2]);
});

t('Noise: the RMS it is set to, the same for the same seed; added to a signal at the SNR asked', () => {
    const n = 200000;
    const r = run('noise', { amplitude: 0.2 }, [null, null], { n });
    const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    near(rms(r.outs[0].re), 0.2, 0.003, 'real RMS');
    near(Math.sqrt((r.outs[1].re.reduce((s, v) => s + v * v, 0) + r.outs[1].im.reduce((s, v) => s + v * v, 0)) / n), 0.2, 0.003, 'complex RMS');
    near(rms(run('noise', { amplitude: 0.2, distribution: 'uniform' }, [null, null], { n }).outs[0].re), 0.2, 0.003, 'uniform RMS');
    assert.strictEqual(run('noise', { seed: 5 }, [null, null], { n: 10 }).outs[0].re[3], run('noise', { seed: 5 }, [null, null], { n: 10 }).outs[0].re[3]);
    // A unit carrier at 10 dB SNR: what is added has a tenth of its power.
    const sig = tone(100, n, 12000, 1);
    const withNoise = run('noise', { level: 'snr', snrDb: 10 }, [sig, null], { rate: 12000 }).outs[1];
    let pn = 0;
    for (let k = 0; k < n; k++) pn += (withNoise.re[k] - sig.re[k]) ** 2 + (withNoise.im[k] - sig.im[k]) ** 2;
    near(10 * Math.log10(1 / (pn / n)), 10, 0.2, 'SNR dB');
    // And on a real signal, through `audio` to `out`.
    const audio = Float64Array.from(sig.re);
    const outA = run('noise', { level: 'snr', snrDb: 20 }, [null, audio], { rate: 12000 }).outs[0].re;
    let pa = 0;
    for (let k = 0; k < n; k++) pa += (outA[k] - audio[k]) ** 2;
    near(10 * Math.log10(0.5 / (pa / n)), 20, 0.3, 'audio SNR dB');
});

// ── shaping ─────────────────────────────────────────────────────────────────

t('root-raised-cosine: symmetric, unity gain, and a pair of them has no intersymbol interference', () => {
    const spb = 8;
    const taps = rootRaisedCosine(1, spb, 1, 0.35, 8 * spb * 2 + 1);
    const n = taps.length;
    near(taps.reduce((a, b) => a + b, 0), 1, 1e-9, 'sum');
    for (let i = 0; i < n; i++) near(taps[i], taps[n - 1 - i], 1e-12, 'symmetry');
    // Raised cosine = RRC * RRC: zero at every other symbol instant.
    const rc = new Float64Array(2 * n - 1);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) rc[i + j] += taps[i] * taps[j];
    const mid = n - 1;
    for (let s = 1; s <= 5; s++) assert.ok(Math.abs(rc[mid + s * spb] / rc[mid]) < 0.02, `ISI ${rc[mid + s * spb] / rc[mid]} at ${s}`);
});

t('Gaussian: symmetric about its peak, unity gain; narrower in time for a larger BT', () => {
    const g = gaussianTaps(1, 8, 0.5, 33);
    near(g.reduce((a, b) => a + b, 0), 1, 1e-9);
    const wide = gaussianTaps(1, 8, 0.3, 33);
    assert.ok(g[16] > wide[16], 'a larger BT is not more peaked');
    for (let i = 0; i < 33; i++) near(g[i], g[32 - i], 1e-15, 'symmetry');
    assert.strictEqual(g.indexOf(Math.max(...g)), 16, 'not peaked on its middle tap');
});

t('Hilbert transform: a real tone in comes out an analytic tone — steady magnitude, phase going forward', () => {
    const rate = 12000;
    const n = 4000;
    const x = tone(1000, n, rate).re;
    const out = run('hilbert', { taps: 101 }, [x], { rate }).outs[0];
    let lo = Infinity; let hi = -Infinity;
    for (let k = 200; k < n; k++) {
        const m = Math.hypot(out.re[k], out.im[k]);
        if (m < lo) lo = m;
        if (m > hi) hi = m;
    }
    assert.ok(hi - lo < 0.03 && Math.abs(hi - 1) < 0.03, `magnitude ${lo}..${hi}`);
    const d = Math.atan2(out.im[1000] * out.re[999] - out.re[1000] * out.im[999], out.re[1000] * out.re[999] + out.im[1000] * out.im[999]);
    near(d, (2 * Math.PI * 1000) / rate, 1e-3, 'phase step');
    assert.strictEqual(hilbertTaps(65).length, 65);
});

t('matched filter: taps of your own are the impulse response, in order; the shapes give odd lengths', () => {
    assert.deepStrictEqual(Array.from(parseTaps('1, 2 3\n4')), [1, 2, 3, 4]);
    assert.strictEqual(parseTaps('1, x'), null);
    const imp = new Float64Array(6); imp[1] = 1;
    const y = run('matched-filter-audio', { shape: 'custom', taps: '1 2 3' }, [imp]).outs[0].re;
    assert.deepStrictEqual(Array.from(y.slice(0, 5)), [0, 1, 2, 3, 0]);
    const rrc = matchedTaps({ shape: 'rrc', symbolRate: 100, rolloff: 0.35, span: 8, bt: 0.5 }, 1000);
    assert.strictEqual(rrc.length % 2, 1);
    const c = run('matched-filter', { shape: 'rect', symbolRate: 250 }, [{ re: new Float64Array(8).fill(1), im: new Float64Array(8) }]).outs[0];
    near(c.re[7], 1, 1e-6, 'rect gain');
});

// ── viewers ─────────────────────────────────────────────────────────────────

t('strip chart: each column the lowest to the highest in its share; a slower B in step with A', () => {
    // A 1 s span at 480 columns: A at 4800 Hz is 10 samples a column, B at 480 Hz one.
    const a = Float64Array.from({ length: 4800 }, (_, k) => k % 10);
    const b = Float64Array.from({ length: 480 }, (_, k) => k);
    const r = run('strip-chart', { spanSec: 1 }, [a, b], { rate: 4800, inRates: [4800, 480] });
    const read = r.inst.read();
    assert.strictEqual(read.a.lo.length, STRIP_COLUMNS);
    assert.strictEqual(read.a.lo[STRIP_COLUMNS - 1], 0);
    assert.strictEqual(read.a.hi[STRIP_COLUMNS - 1], 9);
    assert.strictEqual(read.b.hi[STRIP_COLUMNS - 1], 479, 'B is not up to date with A');
    assert.strictEqual(read.b.hi[0], 0);
});

t('histogram: the range found from the first second, two levels counted as two, and the mean', () => {
    const x = Float64Array.from({ length: 2000 }, (_, k) => (k % 2 ? 1 : 0));
    const r = run('histogram', { bins: 10 }, [x], { rate: 1000 });
    const read = r.inst.read();
    assert.ok(read.found);
    const filled = Array.from(read.counts).filter((v) => v > 0).length;
    assert.strictEqual(filled, 2, `counts ${Array.from(read.counts)}`);
    near(read.mean, 0.5, 1e-9);
    near(read.sd, 0.5, 1e-9);
});

t('readout: each window\'s measure, written and sent as a control', () => {
    const x = Float64Array.from({ length: 1000 }, (_, k) => (k % 2 ? 2 : -2));
    const r = run('readout', { measure: 'rms', windowMs: 100 }, [x], { rate: 1000 });
    near(r.inst.read().value, 2, 1e-12);
    near(r.outs[0].value, 2, 1e-12);
    assert.strictEqual(run('readout', { measure: 'pp', windowMs: 100 }, [x], { rate: 1000 }).inst.read().value, 4);
});

// ── convolutional codes and QPSK31 ──────────────────────────────────────────

const lcg = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
const gauss = (seed) => { const u = lcg(seed); return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); };

t('Encoder: fldigi’s table — the register’s parities under each polynomial, poly 1 in the low bit', () => {
    const enc = new ConvEncoder(CODES.qpsk31);
    // A lone 1 walks through the register: its pairs spell out the polynomials' bits.
    const pairs = [1, 0, 0, 0, 0].map((b) => enc.encode(b));
    const p1 = pairs.map((x) => x & 1).reduce((a, b, i) => a | (b << i), 0);
    const p2 = pairs.map((x) => (x >> 1) & 1).reduce((a, b, i) => a | (b << i), 0);
    assert.strictEqual(p1, 0x17);
    assert.strictEqual(p2, 0x19);
});

for (const code of ['qpsk31', 'nasa']) {
    t(`Viterbi (${code}): clean bits back exactly, and a bit in error every 12 coded bits mended`, () => {
        const c = CODES[code];
        const r = lcg(7);
        const data = Array.from({ length: 600 }, () => (r() < 0.5 ? 1 : 0));
        for (const errorsEvery of [0, 12]) {
            const enc = new ConvEncoder(c);
            const dec = new Viterbi(c);
            const out = [];
            let coded = 0;
            for (const b of [...data, ...new Array(dec.depth).fill(0)]) {
                const pair = enc.encode(b);
                let b0 = pair & 1;
                let b1 = (pair >> 1) & 1;
                if (errorsEvery && ++coded % errorsEvery === 0) b0 ^= 1;
                if (errorsEvery && ++coded % errorsEvery === 0) b1 ^= 1;
                const d = dec.step(hardScores(b0, b1));
                if (d >= 0) out.push(d);
            }
            assert.deepStrictEqual(out.slice(0, data.length), data, `${code}, an error every ${errorsEvery || '∞'}`);
        }
    });
}

t('Viterbi and encoder blocks: a round trip through BITS, either pairing', () => {
    const r = lcg(11);
    const data = Float64Array.from({ length: 400 }, () => (r() < 0.5 ? 1 : 0));
    const coded = run('conv-encoder', { code: 'nasa' }, [data]);
    assert.strictEqual(coded.m, 800);
    const back = run('viterbi', { code: 'nasa' }, [coded.outs[0].re.slice(0, 800)]);
    assert.deepStrictEqual(Array.from(back.outs[0].re.slice(0, back.m)), Array.from(data.slice(0, back.m)));
    assert.ok(back.m > 300);
    // Off by one bit, the other pairing finds it again.
    const shifted = Float64Array.from([1, ...coded.outs[0].re.slice(0, 800)]);
    const b2 = run('viterbi', { code: 'nasa', pairing: 1 }, [shifted]);
    assert.deepStrictEqual(Array.from(b2.outs[0].re.slice(0, b2.m)), Array.from(data.slice(0, b2.m)));
});

/** QPSK31 as fldigi sends it: each Varicode bit coded, its pair a phase step of 180° + 90° × ((4 − pair) & 3), cosine shaped. */
function qpsk31(text, { rate = 12000, offset = 0, noiseAmp = 0, idle = 64, seed = 3 } = {}) {
    const enc = new ConvEncoder(CODES.qpsk31);
    const bits = [...new Array(idle).fill(0), ...encodeVaricode(text), ...new Array(100).fill(0)]; // the tail outlasts the decoder’s traceback
    const syms = [];
    let ph = 0;
    for (const b of bits) {
        const pair = enc.encode(b);
        ph += Math.PI + ((4 - pair) & 3) * (Math.PI / 2);
        syms.push([Math.cos(ph), Math.sin(ph)]);
    }
    const T = 1 / 31.25;
    const n = Math.round((syms.length + 2) * T * rate);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    const g = gauss(seed);
    for (let k = 0; k < n; k++) {
        const t2 = k / rate;
        const s0 = Math.floor(t2 / T);
        let vr = 0;
        let vi = 0;
        for (const j of [s0 - 1, s0, s0 + 1]) {
            if (j < 0 || j >= syms.length) continue;
            const d = t2 - (j + 1) * T;
            if (Math.abs(d) < T) { const w = 0.5 * (1 + Math.cos((Math.PI * d) / T)); vr += syms[j][0] * w; vi += syms[j][1] * w; }
        }
        const c = Math.cos(2 * Math.PI * offset * t2);
        const s = Math.sin(2 * Math.PI * offset * t2);
        I[k] = 0.3 * (vr * c - vi * s) + noiseAmp * g();
        Q[k] = 0.3 * (vr * s + vi * c) + noiseAmp * g();
    }
    return { I, Q, n };
}

function decodeIq(g, sig, rate = 12000) {
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const p = Math.round(rate * 0.02);
    for (let at = 0; at < sig.n; at += p) {
        const len = Math.min(p, sig.n - at);
        rt.process({ i: sig.I.subarray(at, at + len), q: sig.Q.subarray(at, at + len), frames: len, rate });
    }
    return rt.read('con').text;
}

const QPSK_MSG = 'CQ CQ DE M9PSY M9PSY QPSK31 K';
const pskDecoder = (params) => parseGraph({
    v: GRAPH_VERSION,
    nodes: [{ id: 'iq', type: 'iq-in' }, { id: 'dec', type: 'psk31-decoder', params }, { id: 'con', type: 'console' }],
    wires: [['iq', 'out', 'dec', 'in'], ['dec', 'text', 'con', 'in']],
}).graph;

t('QPSK31: the PSK31 decoder in QPSK reads it — on frequency, in noise, and pulled in from 8 Hz off', () => {
    const clean = decodeIq(pskDecoder({ offsetHz: 1500, psk: 'qpsk', afc: false }), qpsk31(QPSK_MSG, { offset: 1500 }));
    assert.ok(clean.includes(QPSK_MSG), JSON.stringify(clean));
    const noisy = decodeIq(pskDecoder({ offsetHz: 1500, psk: 'qpsk' }), qpsk31(QPSK_MSG, { offset: 1500, noiseAmp: 0.15 }));
    assert.ok(noisy.includes(QPSK_MSG), JSON.stringify(noisy));
    const off = decodeIq(pskDecoder({ offsetHz: 1500, psk: 'qpsk' }), qpsk31(QPSK_MSG, { offset: 1508, idle: 120 }));
    assert.ok(off.includes(QPSK_MSG), JSON.stringify(off));
});

t('QPSK31 is not BPSK: the BPSK decoder makes nothing of it', () => {
    const text = decodeIq(pskDecoder({ offsetHz: 1500, afc: false }), qpsk31(QPSK_MSG, { offset: 1500 }));
    assert.ok(!text.includes('M9PSY'), JSON.stringify(text));
});

// ── synchronisation ─────────────────────────────────────────────────────────

/** Shaped PSK: random symbols (M = 2 or 4), raised-cosine (RRC × RRC) pulses, at `sps`, offset `hz`, starting `delay` samples late. */
function shapedPsk({ M = 2, sps = 8, rate = 1000, symbols = 2000, hz = 0, seed = 5, delay = 0, rrcOnly = false } = {}) {
    const r = lcg(seed);
    const sym = Array.from({ length: symbols }, () => {
        const k = Math.floor(r() * M);
        return M === 2 ? [k ? 1 : -1, 0] : [k & 1 ? 1 : -1, k & 2 ? 1 : -1].map((v) => v * Math.SQRT1_2);
    });
    const h = rootRaisedCosine(1, rate, rate / sps, 0.35, 11 * sps);
    const hh = rrcOnly ? h : (() => {
        const c = new Float64Array(2 * h.length - 1);
        for (let i = 0; i < h.length; i++) for (let j = 0; j < h.length; j++) c[i + j] += h[i] * h[j];
        return c;
    })();
    const peak = Math.max(...hh);
    const n = symbols * sps + hh.length + delay;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    sym.forEach(([a, b], s) => {
        for (let j = 0; j < hh.length; j++) { re[delay + s * sps + j] += (a * hh[j]) / peak; im[delay + s * sps + j] += (b * hh[j]) / peak; }
    });
    for (let k = 0; k < n; k++) {
        const c = Math.cos((2 * Math.PI * hz * k) / rate);
        const sn = Math.sin((2 * Math.PI * hz * k) / rate);
        const tr = re[k] * c - im[k] * sn;
        im[k] = re[k] * sn + im[k] * c;
        re[k] = tr;
    }
    return { re, im };
}

for (const hz of [30, -30, 150]) {
    t(`FLL band-edge: pulls BPSK at 125 baud in from ${hz} Hz off`, () => {
        const x = shapedPsk({ hz, symbols: 4000, rrcOnly: true });
        const r = run('fll-band-edge', { baud: 125, bandwidth: 0.01 }, [x], { rate: 1000 });
        near(r.inst.read().hz, hz, 3, 'the FLL’s estimate');
        // And the output is on zero: its phase stops turning (BPSK, so squared).
        const o = r.outs[0];
        const N = o.re.length;
        let ar = 0; let ai = 0;
        for (let k = N - 4000; k < N - 2000; k++) {
            const a = o.re[k] * o.re[k] - o.im[k] * o.im[k];
            const b = 2 * o.re[k] * o.im[k];
            const c = o.re[k + 1] * o.re[k + 1] - o.im[k + 1] * o.im[k + 1];
            const d = 2 * o.re[k + 1] * o.im[k + 1];
            ar += a * c + b * d; ai += a * d - b * c; // conj(sq[k]) · sq[k+1]
        }
        near((Math.atan2(ai, ar) / 2) * 1000 / (2 * Math.PI), 0, 3, 'residual offset');
    });
}

for (const [detector, M] of [['gardner', 2], ['mm-bpsk', 2], ['mm-qpsk', 4], ['gardner', 4]]) {
    t(`Symbol sync (${detector}): ${M === 2 ? 'BPSK' : 'QPSK'} started half a symbol off, the strobes find the centres`, () => {
        const x = shapedPsk({ M, delay: 4, symbols: 3000 });
        const r = run('symbol-sync', { baud: 125, detector, bandwidth: 0.02 }, [x], { rate: 1000 });
        const o = r.outs[0];
        // Over the last 500 symbols, every strobe is near a constellation point.
        let worst = 0;
        let sq = 0;
        for (let k = r.m - 520; k < r.m - 20; k++) {
            const a = M === 2 ? Math.hypot(Math.abs(o.re[k]) - 1, o.im[k]) : Math.hypot(Math.abs(o.re[k]) - Math.SQRT1_2, Math.abs(o.im[k]) - Math.SQRT1_2);
            worst = Math.max(worst, a);
            sq += a * a;
        }
        const rms = Math.sqrt(sq / 500);
        console.log(`      ${detector}: rms ${rms.toFixed(3)}, worst ${worst.toFixed(3)}`);
        assert.ok(rms < 0.06 && worst < 0.2, `${detector}: rms ${rms.toFixed(3)}, worst ${worst.toFixed(3)}`);
    });
}

t('Preamble correlator: finds a Barker 13 among random symbols, once, with the carrier’s phase', () => {
    const r = lcg(3);
    const bits = [...Array.from({ length: 200 }, () => (r() < 0.5 ? 1 : 0)), ...'1111100110101'.split('').map(Number), ...Array.from({ length: 200 }, () => (r() < 0.5 ? 1 : 0))];
    const ph = (60 * Math.PI) / 180;
    const re = Float64Array.from(bits, (b) => (b ? 1 : -1) * Math.cos(ph));
    const im = Float64Array.from(bits, (b) => (b ? 1 : -1) * Math.sin(ph));
    const c = run('correlator', {}, [{ re, im }], { rate: 125 });
    const found = c.outs[1].list;
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    near(c.inst.read().last.phaseDeg, 60, 1e-6, 'phase');
    near(c.inst.read().last.match, 1, 1e-9, 'match');
    near(c.outs[2].value, 60, 1e-6, 'phase control');
    // Upside down, the phase says so.
    const c2 = run('correlator', {}, [{ re: re.map((v) => -v), im: im.map((v) => -v) }], { rate: 125 });
    near(c2.inst.read().last.phaseDeg, -120, 1e-6, 'inverted');
});

t('Goertzel: a tone’s amplitude in its bin; a tone a bin away reads nothing', () => {
    const rate = 8000;
    const n = 8000;
    const x = Float64Array.from({ length: n }, (_, k) => 0.5 * Math.cos((2 * Math.PI * 1000 * k) / rate));
    const on = run('goertzel', { frequencyHz: 1000, windowMs: 20 }, [x], { rate });
    near(on.inst.read().level, 0.5, 1e-6, 'on frequency');
    near(on.outs[1].value, 20 * Math.log10(0.5), 1e-4, 'dB');
    const off = run('goertzel', { frequencyHz: 1050, windowMs: 20 }, [x], { rate });
    assert.ok(off.inst.read().level < 1e-6, `a bin away: ${off.inst.read().level}`);
});

// ── beacon monitor ──────────────────────────────────────────────────────────

t('NCDXF schedule: 4U1UN on 14.100 at the top of the cycle, a band higher each ten seconds; YV5B last', () => {
    const T = 1700000000 - (1700000000 % 180);
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T, 0)].call, '4U1UN');
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T + 10, 1)].call, '4U1UN');
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T + 40, 4)].call, '4U1UN');
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T + 10, 0)].call, 'VE8AT');
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T + 170, 0)].call, 'YV5B');
    assert.strictEqual(NCDXF_BEACONS[beaconAt(T + 180, 0)].call, '4U1UN');
});

t('Beacon monitor: in noise, the loud beacon and the faint one heard at their strengths, the silent ones not; timed by a Clock’s unix', () => {
    const rate = 4000;
    const T = 1700000000 - (1700000000 % 180) + 3; // starts 3 s into the first slot, which is not judged
    const seconds = 360;
    const loud = { W6WX: 0.3, OH2B: 0.03 };
    const g = gauss(9);
    const def = BLOCK_BY_TYPE['beacon-monitor'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, { band: 0, toneHz: 700 }), rate);
    const texts = [];
    const ctl = { seq: 0, value: null };
    const P = 320;
    let phase = 0;
    for (let k0 = 0; k0 < seconds * rate; k0 += P) {
        const x = makeBuffer('real', P);
        for (let k = 0; k < P; k++) {
            const tt = T + (k0 + k) / rate;
            const call = NCDXF_BEACONS[beaconAt(tt, 0)].call;
            const into = tt % 10;
            const amp = loud[call] && into > 0.3 && into < 9.3 ? loud[call] : 0;
            phase += (2 * Math.PI * 700) / rate;
            x.re[k] = amp * Math.sin(phase) + 0.05 * g();
        }
        x.n = P;
        // The Clock's whole seconds this packet reached.
        const a = T + k0 / rate;
        const b = T + (k0 + P) / rate;
        if (Math.floor(b) > Math.floor(a)) { ctl.seq++; ctl.value = Math.floor(b); }
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([x, ctl], outs, P);
        for (const e of outs[0].list) texts.push(e.text);
    }
    const all = texts.join('');
    assert.ok(!/4U1UN|VE8AT|ZL6B/.test(all), all);
    const w6 = texts.filter((x) => x.includes('W6WX'));
    const oh = texts.filter((x) => x.includes('OH2B'));
    assert.strictEqual(w6.length, 2, all);
    assert.strictEqual(oh.length, 2, all);
    // The noise in a 100 Hz bandwidth of white noise σ 0.05 at 4 kHz: 0.05² × 100/2000; the tone's power amp²/2 ... and back to dB.
    const r = inst.read();
    const heard = Object.fromEntries(r.heard.filter((h) => h.heard).map((h) => [h.call, h.snr]));
    assert.deepStrictEqual(Object.keys(heard).sort(), ['OH2B', 'W6WX']);
    // In theory: the tone's power after mixing, A²/4, against white noise
    // σ²/rate a hertz over the detector's π/4 × 100 Hz — 26.6 and 6.6 dB.
    const theory = (A) => 10 * Math.log10((A * A) / 4 / ((0.05 * 0.05) / rate * (Math.PI / 4) * 100));
    near(heard.W6WX, theory(0.3), 1.5, 'W6WX');
    near(heard.OH2B, theory(0.03), 1.5, 'OH2B');
    assert.ok(r.heard.filter((h) => !h.heard).every((h) => h.snr < 0), 'a slot of noise alone reads below 0 dB');
    assert.strictEqual(r.why, '');
    assert.strictEqual(r.band, '20m');
    console.log('      ' + r.heard.map((h) => `${h.call} ${h.snr.toFixed(1)}`).join(', '));
});

t('Equaliser: QPSK through an echo half as strong a symbol late — CMA restores the constant modulus, LMS the constellation', () => {
    const r = lcg(21);
    const n = 6000;
    const sr = new Float64Array(n);
    const si = new Float64Array(n);
    for (let k = 0; k < n; k++) { sr[k] = r() < 0.5 ? Math.SQRT1_2 : -Math.SQRT1_2; si[k] = r() < 0.5 ? Math.SQRT1_2 : -Math.SQRT1_2; }
    // h = [1, 0.5j]: the echo a quarter turn round, and some noise.
    const g = gauss(4);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const pr = k ? sr[k - 1] : 0;
        const pi = k ? si[k - 1] : 0;
        re[k] = sr[k] - 0.5 * pi + 0.02 * g();
        im[k] = si[k] + 0.5 * pr + 0.02 * g();
    }
    const tail = (y, f) => { let s2 = 0; for (let k = n - 1000; k < n; k++) s2 += f(y.re[k], y.im[k]) ** 2; return Math.sqrt(s2 / 1000); };
    const modErr = (a, b) => Math.hypot(a, b) - 1;
    const evm = (a, b) => Math.hypot(Math.abs(a) - Math.SQRT1_2, Math.abs(b) - Math.SQRT1_2);
    const before = run('equaliser', { freeze: true }, [{ re, im }]).outs[0];
    const cma = run('equaliser', { method: 'cma' }, [{ re, im }]).outs[0];
    const lms = run('equaliser', { method: 'lms', constellation: 4 }, [{ re, im }]).outs[0];
    const b = tail(before, modErr);
    const c = tail(cma, modErr);
    const l = tail(lms, evm);
    console.log(`      modulus error ${b.toFixed(3)} → CMA ${c.toFixed(3)}; LMS EVM ${l.toFixed(3)} (unequalised ${tail(before, evm).toFixed(3)})`);
    assert.ok(b > 0.2 && c < 0.06, `CMA: ${b} → ${c}`);
    assert.ok(tail(before, evm) > 0.2 && l < 0.1, `LMS: ${l}`);
});

// ── the on-off detector against noise ───────────────────────────────────────

/** An on-off detector over `seconds` of complex noise (σ 0.1 a part) plus `carrier` (amplitude, steady), at 12 kHz. */
function ookOn(params, { seconds = 6, carrier = 0, seed = 7 } = {}) {
    const def = BLOCK_BY_TYPE['ook-detector'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), 12000);
    const gn = gauss(seed);
    let down = 0;
    let total = 0;
    let present = null;
    for (let p = 0; p < seconds * 50; p++) {
        const x = makeBuffer('complex', 240);
        for (let k = 0; k < 240; k++) { x.re[k] = carrier + 0.1 * gn(); x.im[k] = 0.1 * gn(); }
        x.n = 240;
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 260));
        const m = inst.process([x], outs, 240);
        if (p > 50) for (let k = 0; k < m; k++) { total++; if (outs[0].re[k] > 0.5) down++; }
        if (outs[2].seq > 0) present = outs[2].value;
    }
    return { share: down / total, inst, present };
}

t('on-off detector: noise alone hardly keys it at the default; the old 6 dB let a third through; raising it shuts noise out', () => {
    const def = ookOn({ bandwidthHz: 100 });
    assert.ok(def.share < 0.05, `noise keyed it ${(def.share * 100).toFixed(1)}% of the time`);
    assert.ok(ookOn({ bandwidthHz: 100, minSnrDb: 6 }).share > 0.2, 'the 6 dB comparison proves nothing');
    assert.ok(ookOn({ bandwidthHz: 100, minSnrDb: 12 }).share < 0.005);
    assert.strictEqual(def.present, 0);
});

t('on-off detector: a narrow filter and heavy smoothing no longer lock it on — its floor learned after the filter fills, not from its silence', () => {
    const r = ookOn({ bandwidthHz: 30, smoothMs: 15 });
    const snr = r.inst.read().snrDb;
    assert.ok(snr < 15, `noise read as ${snr.toFixed(1)} dB`);
    assert.ok(r.share < 0.1, `keyed ${(r.share * 100).toFixed(1)}% of the time`);
});

t('on-off detector: a carrier keyed on and off well above the noise reads present, and the key follows it', () => {
    const det = BLOCK_BY_TYPE['ook-detector'];
    const inst = det.create();
    inst.configure(sanitizeParams(det, { bandwidthHz: 100 }), 12000);
    const gn = gauss(3);
    const presents = [];
    let onKey = 0; let onN = 0; let offKey = 0; let offN = 0;
    for (let p = 0; p < 400; p++) {
        // 200 ms on, 200 ms off.
        const keyed = Math.floor(p / 10) % 2 === 0;
        const x = makeBuffer('complex', 240);
        for (let k = 0; k < 240; k++) { x.re[k] = (keyed ? 0.5 : 0) + 0.05 * gn(); x.im[k] = 0.05 * gn(); }
        x.n = 240;
        const outs = det.outputs.map((o) => makeBuffer(o.kind, 260));
        const m = inst.process([x], outs, 240);
        if (outs[2].seq > 0) presents.push(outs[2].value);
        if (p > 60 && p % 10 > 3 && p % 10 < 8) for (let k = 0; k < m; k++) { if (keyed) { onN++; onKey += outs[0].re[k]; } else { offN++; offKey += outs[0].re[k]; } }
    }
    assert.ok(presents.includes(1), JSON.stringify(presents));
    assert.ok(onKey / onN > 0.8 && offKey / offN < 0.1, `on ${onKey / onN}, off ${offKey / offN}`);
});

console.log(`\n${pass} passed`);
