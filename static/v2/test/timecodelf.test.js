// The 60 kHz time-code decoders, WWVB and MSF (src/playground/timecode/),
// against synthesised IQ: each keyed exactly as its station keys the carrier,
// from a chosen start UTC, with seeded Gaussian noise, so every edge instant
// and every second's UTC is known to the sample.

const assert = require('assert');
const {
    WwvbDecoder, MsfDecoder, MSF_EDGE_BIAS_SEC, fieldsFromUtc, civilFromDays, daysFromCivil, encodeField, WWVB_MAP,
} = require('./.build/timecodelf.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const FS = 12000;
// 2026-10-02 12:34:50 UTC: ten seconds before a minute, in British Summer Time
// (so MSF's code is UTC+1 and its summer-time bit is set).
const START = Date.UTC(2026, 9, 2, 12, 34, 50);
// The first second's on-time instant, at a fractional sample so nothing lines
// up with the 10 ms envelope blocks by accident.
const EDGE0 = 1234.37;

// ── a seeded RNG and Gaussian noise ─────────────────────────────────────────

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rand) {
    let spare = null;
    return () => {
        if (spare !== null) { const s = spare; spare = null; return s; }
        let u = 0;
        while (u === 0) u = rand();
        const v = rand();
        const r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
    };
}

// ── the stations' frames ────────────────────────────────────────────────────

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** WWVB's 60 symbols for the minute starting at UTC `m` (NIST SP 250-67): 'Z' | 'O' | 'M'. */
function wwvbFrame(m) {
    const f = fieldsFromUtc(m);
    const bits = new Array(60).fill(0);
    for (const fld of ['minute', 'hour', 'doy', 'year2']) {
        encodeField(WWVB_MAP[fld], f[fld]).forEach((b, k) => { bits[WWVB_MAP[fld][k][0]] = b; });
    }
    // DUT1 +0.3 s: sign bits 36 and 38, magnitude 0.2 + 0.1 on 42, 43.
    bits[36] = 1; bits[38] = 1; bits[42] = 1; bits[43] = 1;
    bits[55] = isLeap(2000 + f.year2) ? 1 : 0;
    const out = bits.map((b) => (b ? 'O' : 'Z'));
    for (const s of [0, 9, 19, 29, 39, 49, 59]) out[s] = 'M';
    return out;
}

const bcd = (v, tensBits, unitBits = 4) => {
    const tens = Math.floor(v / 10);
    const units = v % 10;
    const out = [];
    for (let i = tensBits - 1; i >= 0; i--) out.push((tens >> i) & 1);
    for (let i = unitBits - 1; i >= 0; i--) out.push((units >> i) & 1);
    return out;
};

// European summer time at Unix ms (01:00 UTC last Sunday of March to October).
function summerAt(ms) {
    const { y } = civilFromDays(Math.floor(ms / 86400000));
    const lastSunday = (mo) => {
        const last = daysFromCivil(y, mo, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] + (mo === 2 && isLeap(y) ? 1 : 0));
        return last - ((((last + 4) % 7) + 7) % 7);
    };
    return ms >= lastSunday(3) * 86400000 + 3600000 && ms < lastSunday(10) * 86400000 + 3600000;
}

/**
 * MSF's A and B bits for the minute whose second 00 is UTC `m` (NPL's
 * "MSF 60 kHz time and date code"): the code names the UK clock time of the
 * minute starting at the NEXT marker. `flipA` lists A bits to invert after
 * the parity is computed — a misread the parity must catch.
 */
function msfFrame(m, flipA = []) {
    const next = m + 60000;
    const summer = summerAt(next);
    const local = next + (summer ? 3600000 : 0);
    const days = Math.floor(local / 86400000);
    const { y, m: mo, d } = civilFromDays(days);
    const hh = Math.floor((local % 86400000) / 3600000);
    const mm = Math.floor((local % 3600000) / 60000);
    const A = new Array(60).fill(0);
    const B = new Array(60).fill(0);
    const put = (from, bits) => bits.forEach((b, k) => { A[from + k] = b; });
    put(17, bcd(y % 100, 4));
    put(25, bcd(mo, 1));
    put(30, bcd(d, 2));
    put(36, [4, 2, 1].map((w) => ((((days + 4) % 7) & w) ? 1 : 0)));
    put(39, bcd(hh, 2));
    put(45, bcd(mm, 3));
    put(52, [0, 1, 1, 1, 1, 1, 1, 0]);
    // DUT1 +0.3 s: B01–B03.
    B[1] = 1; B[2] = 1; B[3] = 1;
    const odd = (from, to) => { let ones = 0; for (let p = from; p <= to; p++) ones += A[p]; return ones % 2 === 0 ? 1 : 0; };
    B[54] = odd(17, 24); B[55] = odd(25, 35); B[56] = odd(36, 38); B[57] = odd(39, 51);
    B[58] = summer ? 1 : 0;
    for (const p of flipA) A[p] ^= 1;
    return { A, B };
}

// ── the synthesiser ─────────────────────────────────────────────────────────

/**
 * IQ at 12 kHz: a carrier at `carrierHz`, keyed second by second. `keying(k)`
 * gives second k's intervals of reduced carrier, in seconds from its start,
 * and `phaseFlip(k)` whether its carrier is inverted from +100 ms (WWVB's
 * BPSK). A fall or rise at instant E (fractional samples) is a one-sample
 * linear ramp centred on E — the sample at E is half way — which is how a
 * band-limited step samples. `lag` delays all keying by that many seconds.
 */
function synth({ seconds, keying, low, carrierHz = 0, phase0 = 0.7, sigma = 0, seed = 1, lag = 0, phaseFlip = null }) {
    const gauss = gaussian(mulberry32(seed));
    const total = Math.ceil(EDGE0 + seconds * FS);
    const lagS = lag * FS;
    const ramp = (x) => Math.min(1, Math.max(0, x + 0.5));
    const cache = new Map();
    const intervalsOf = (k) => {
        if (!cache.has(k)) {
            cache.set(k, keying(k).map(([a, b]) => [EDGE0 + k * FS + lagS + a * FS, EDGE0 + k * FS + lagS + b * FS]));
            if (cache.size > 4) cache.delete(cache.keys().next().value);
        }
        return cache.get(k);
    };
    const w = (2 * Math.PI * carrierHz) / FS;
    return function* chunks(size = FS) {
        for (let start = 0; start < total; start += size) {
            const n = Math.min(size, total - start);
            const re = new Float64Array(n);
            const im = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                const s = start + i;
                const k = Math.floor((s - EDGE0 - lagS) / FS);
                let lowness = 0;
                for (const kk of [k, k + 1]) {
                    if (kk < 0) continue;
                    for (const [a, b] of intervalsOf(kk)) lowness += ramp(s - a) - ramp(s - b);
                }
                let amp = 1 - (1 - low) * Math.min(1, Math.max(0, lowness));
                if (phaseFlip) {
                    // The phase state from +100 ms of second k to +100 ms of k+1.
                    const kp = Math.floor((s - EDGE0 - 0.1 * FS) / FS);
                    if (kp >= 0 && phaseFlip(kp)) amp = -amp;
                }
                const ph = phase0 + w * s;
                re[i] = amp * Math.cos(ph) + sigma * gauss();
                im[i] = amp * Math.sin(ph) + sigma * gauss();
            }
            yield { re, im, n };
        }
    };
}

const utcOfSecond = (k) => START + k * 1000;
const minuteOf = (ms) => Math.floor(ms / 60000) * 60000;

const WWVB_LOW = 10 ** (-17 / 20);
function wwvbKeying() {
    const frames = new Map();
    return (k) => {
        const ms = utcOfSecond(k);
        const m = minuteOf(ms);
        if (!frames.has(m)) frames.set(m, wwvbFrame(m));
        const sym = frames.get(m)[(ms - m) / 1000];
        return [[0, sym === 'M' ? 0.8 : sym === 'O' ? 0.5 : 0.2]];
    };
}

function msfKeying(flips = new Map()) {
    const frames = new Map();
    return (k) => {
        const ms = utcOfSecond(k);
        const m = minuteOf(ms);
        if (!frames.has(m)) frames.set(m, msfFrame(m, flips.get(m) || []));
        const s = (ms - m) / 1000;
        if (s === 0) return [[0, 0.5]];
        const { A, B } = frames.get(m);
        const iv = [[0, 0.1]];
        if (A[s]) iv.push([0.1, 0.2]);
        if (B[s]) iv.push([0.2, 0.3]);
        return iv;
    };
}

/** Runs a decoder over a synthesised signal; every event, and the states seen. */
function run(dec, gen) {
    const events = [];
    const states = new Set();
    for (const { re, im, n } of gen()) {
        dec.process(re, im, n);
        events.push(...dec.drain());
        states.add(dec.status().state);
    }
    return { events, states };
}

const trueEdge = (k, lag = 0) => EDGE0 + k * FS + lag * FS;
const secondOf = (edge) => Math.round((edge - EDGE0) / FS);
const us = (samples) => (samples / FS) * 1e6;

function edgeStats(events, fromSample) {
    const errs = events
        .filter((e) => e.type === 'second' && e.measured && e.edge >= fromSample)
        .map((e) => us(e.edge - trueEdge(secondOf(e.edge))));
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const maxAbs = Math.max(...errs.map(Math.abs));
    const rms = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);
    return { n: errs.length, mean, rms, maxAbs };
}

function checkTimes(events) {
    const times = events.filter((e) => e.type === 'time');
    for (const e of times) {
        const k = secondOf(e.edge);
        assert.strictEqual(e.utcMs, utcOfSecond(k), `time at second ${k}: ${new Date(e.utcMs).toISOString()}`);
    }
    return times;
}

// ── WWVB ────────────────────────────────────────────────────────────────────

t('WWVB: locks on a clean signal, its time is the synthesised UTC, and BPSK flips are ignored', () => {
    const flip = mulberry32(99);
    const flips = [];
    const gen = synth({
        seconds: 150, keying: wwvbKeying(), low: WWVB_LOW, carrierHz: 37.3, sigma: 0.05, seed: 7,
        phaseFlip: (k) => { while (flips.length <= k) flips.push(flip() < 0.5); return flips[k]; },
    });
    const dec = new WwvbDecoder({ sampleRate: FS, carrierOffsetHz: 40, referenceNow: () => START });
    const { events, states } = run(dec, gen);
    assert.ok(states.has('locked'), 'never locked: ' + JSON.stringify(dec.status()));
    const st = dec.status();
    assert.strictEqual(st.station, 'WWVB');
    assert.ok(Math.abs(st.carrierOffsetHz - 37.3) <= 1, `carrier at ${st.carrierOffsetHz}`);

    const times = checkTimes(events);
    assert.ok(times.length >= 15, `${times.length} time events`);
    const lockSec = times[0].edge / FS;
    // Frames: every one names its own s0's minute, and its startEdge is that s0.
    const frames = events.filter((e) => e.type === 'frame');
    assert.ok(frames.length >= 2);
    for (const f of frames) {
        const k = secondOf(f.startEdge);
        assert.strictEqual(f.utcMs, utcOfSecond(k));
        assert.strictEqual(f.dut1Tenths, 3);
        assert.strictEqual(f.leapPending, false);
    }
    // Symbols, once anchored, are what was sent.
    const kf = wwvbKeying();
    for (const e of events.filter((x) => x.type === 'second' && x.sof >= 0)) {
        const len = kf(secondOf(e.edge))[0][1];
        assert.strictEqual(e.symbol, len === 0.8 ? 'marker' : len === 0.5 ? 'one' : 'zero');
        assert.strictEqual(e.sof, (utcOfSecond(secondOf(e.edge)) % 60000) / 1000);
    }
    // Edge accuracy once the tracker has settled (its first 8 s are a running
    // mean). Noise-free and without BPSK the edge is exact to +41.7 µs (the
    // next test). The BPSK flip adds a bias: the C++'s low-level mean for the
    // area runs over envelope blocks +40..+110 ms after the crossing, and the
    // flip's magnitude notch at +100 ms lands in the last of them, lowering L
    // in every second whose phase changes — measured +60 µs on average here,
    // ported as it is. Noise at 64 dB-Hz adds tens of µs. So: mean under
    // 200 µs and every settled edge within 300 µs, a tenth of the ±3 ms the
    // C++ documents at 10 dB.
    const s = edgeStats(events, trueEdge(20));
    console.log(`      WWVB: lock at ${lockSec.toFixed(1)} s of signal; edges after settling: n=${s.n} `
        + `mean ${s.mean.toFixed(1)} µs, rms ${s.rms.toFixed(1)} µs, max |err| ${s.maxAbs.toFixed(1)} µs`);
    assert.ok(s.mean > 0 && s.mean < 200, `edge mean ${s.mean} µs`);
    assert.ok(s.maxAbs < 300, `edge max ${s.maxAbs} µs`);
    // Every second's event: sof −1 until anchored, then counting.
    assert.ok(events.filter((e) => e.type === 'second').every((e) => e.servable === true));
});

t('WWVB: noise-free, every edge is the true instant plus half a sample — the 150 Hz low-pass delay fully removed', () => {
    // The area estimate counts a sampled step as falling at its first low
    // sample, half a sample after the instant a band-limited step is half way
    // (+41.7 µs at 12 kHz) — the C++'s convention, kept. Anything else here
    // would be a filter delay not taken off (the 150 Hz biquad's is ~1.5 ms).
    const gen = synth({ seconds: 40, keying: wwvbKeying(), low: WWVB_LOW, carrierHz: 0 });
    const dec = new WwvbDecoder({ sampleRate: FS });
    const { events } = run(dec, gen);
    const s = edgeStats(events, trueEdge(15));
    assert.ok(s.n >= 20);
    assert.ok(Math.abs(s.mean - 1e6 / FS / 2) < 1 && s.maxAbs < 1e6 / FS / 2 + 1, JSON.stringify(s));
});

t('WWVB: a weaker signal (17 dB drop at ~47 dB-Hz) still locks with the right time; edge error bounded', () => {
    const gen = synth({ seconds: 150, keying: wwvbKeying(), low: WWVB_LOW, carrierHz: -12, sigma: 0.35, seed: 11 });
    const dec = new WwvbDecoder({ sampleRate: FS, carrierOffsetHz: 0, referenceNow: null });
    const { events, states } = run(dec, gen);
    assert.ok(states.has('locked'), 'never locked: ' + JSON.stringify(dec.status()));
    checkTimes(events);
    const s = edgeStats(events, trueEdge(20));
    console.log(`      WWVB weak: edges n=${s.n} mean ${s.mean.toFixed(1)} µs, rms ${s.rms.toFixed(1)} µs, max ${s.maxAbs.toFixed(1)} µs`);
    assert.ok(s.maxAbs < 1000, `edge max ${s.maxAbs} µs`);
});

// ── MSF ─────────────────────────────────────────────────────────────────────

// On the air MSF's fall reaches its steepest 0.19 ms after NPL's second
// (Anthorn's antenna), and the decoder times the steepest point; the
// synthesiser models exactly that lag, so the decoder's edges, net of its
// bias, should land on the true second.
const MSF_LAG = MSF_EDGE_BIAS_SEC;

t('MSF: locks on a clean signal; its time is the synthesised UTC; edges within 0.2 ms of the true second', () => {
    const gen = synth({ seconds: 150, keying: msfKeying(), low: 0, carrierHz: 1.3, sigma: 0.05, seed: 3, lag: MSF_LAG });
    const dec = new MsfDecoder({ sampleRate: FS, carrierOffsetHz: 0, referenceNow: () => START });
    const { events, states } = run(dec, gen);
    assert.ok(states.has('locked'), 'never locked: ' + JSON.stringify(dec.status()));
    const st = dec.status();
    assert.strictEqual(st.station, 'MSF');
    assert.ok(Math.abs(st.detail.carrierHz - 1.3) < 0.05, `carrier ${st.detail.carrierHz}`);

    const times = checkTimes(events);
    assert.ok(times.length >= 15, `${times.length} time events`);
    const frames = events.filter((e) => e.type === 'frame');
    assert.ok(frames.length >= 2);
    for (const f of frames) {
        assert.strictEqual(f.utcMs, utcOfSecond(secondOf(f.startEdge)));
        assert.strictEqual(f.summer, true);
        assert.strictEqual(f.dut1Tenths, 3);
    }
    for (const e of events.filter((x) => x.type === 'second' && x.sof >= 0)) {
        assert.strictEqual(e.sof, (utcOfSecond(secondOf(e.edge)) % 60000) / 1000);
    }
    const s = edgeStats(events, trueEdge(20));
    const lockSec = times[0].edge / FS;
    console.log(`      MSF: lock at ${lockSec.toFixed(1)} s of signal; edges after settling: n=${s.n} `
        + `mean ${s.mean.toFixed(1)} µs, rms ${s.rms.toFixed(1)} µs, max |err| ${s.maxAbs.toFixed(1)} µs`);
    assert.ok(s.maxAbs < 200, `edge max ${s.maxAbs} µs`);
    for (const e of times) assert.ok(Math.abs(us(e.edge - trueEdge(secondOf(e.edge)))) < 200);
});

t('MSF: a minute with a misread bit fails its parity and is not decoded; the clean ones are', () => {
    // Minute 12:35 UTC codes 13:36 BST; A51 is the minute's units LSB, so the
    // misread would say 13:37 — one parity group (39–51) now even.
    const bad = Date.UTC(2026, 9, 2, 12, 35);
    const gen = synth({
        seconds: 200, keying: msfKeying(new Map([[bad, [51]]])), low: 0, carrierHz: -0.6, sigma: 0.05, seed: 5, lag: MSF_LAG,
    });
    const dec = new MsfDecoder({ sampleRate: FS, carrierOffsetHz: 0 });
    const { events, states } = run(dec, gen);
    const frames = events.filter((e) => e.type === 'frame');
    const badFrame = frames.find((f) => secondOf(f.startEdge) === (bad - START) / 1000);
    assert.ok(badFrame, 'the corrupted minute was not framed at all');
    assert.strictEqual(badFrame.utcMs, null);
    for (const f of frames) if (f !== badFrame) assert.strictEqual(f.utcMs, utcOfSecond(secondOf(f.startEdge)));
    assert.ok(states.has('locked'), 'the clean minutes after it never locked');
    checkTimes(events);
    assert.strictEqual(dec.status().detail.lastFrameFrom, 1);
});

// ── no signal, bad configuration ────────────────────────────────────────────

t('neither decoder locks on noise alone', () => {
    for (const [Dec, seed] of [[WwvbDecoder, 21], [MsfDecoder, 22]]) {
        // No carrier at all: complex Gaussian noise only.
        const dec = new Dec({ sampleRate: FS, carrierOffsetHz: 0 });
        const noise = gaussian(mulberry32(seed));
        const events = [];
        const states = new Set();
        for (let s = 0; s < 150; s++) {
            const re = new Float64Array(FS);
            const im = new Float64Array(FS);
            for (let i = 0; i < FS; i++) { re[i] = 0.5 * noise(); im[i] = 0.5 * noise(); }
            dec.process(re, im, FS);
            events.push(...dec.drain());
            states.add(dec.status().state);
        }
        assert.ok(!states.has('locked'), `${Dec.name} locked on noise`);
        assert.strictEqual(events.filter((e) => e.type === 'time').length, 0);
        assert.strictEqual(events.filter((e) => e.type === 'frame' && e.utcMs !== null).length, 0);
    }
});

t('a sample rate that does not decimate to 100 Hz by a whole factor throws', () => {
    for (const Dec of [WwvbDecoder, MsfDecoder]) {
        for (const sr of [12345, 11025, 0, -12000, 12000.5]) {
            assert.throws(() => new Dec({ sampleRate: sr }), /does not decimate to the 100 Hz envelope/);
        }
        assert.doesNotThrow(() => new Dec({ sampleRate: 24000 }));
    }
});

t('reset makes a decoder as new', () => {
    const gen = synth({ seconds: 8, keying: msfKeying(), low: 0, sigma: 0.05, seed: 9, lag: MSF_LAG });
    const dec = new MsfDecoder({ sampleRate: FS });
    run(dec, gen);
    assert.strictEqual(dec.status().state, 'acquiring');
    dec.reset();
    const st = dec.status();
    assert.deepStrictEqual([st.state, st.frames, st.carrierOffsetHz, dec.drain().length], ['nosignal', 0, null, 0]);
});

console.log(`${pass} passed`);
