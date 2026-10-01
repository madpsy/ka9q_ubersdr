// Digital modes, end to end: real signals made from text, through the blocks,
// and the same text back.
//
// The signals are made the way transmitters make them — continuous-phase FSK
// at the right shift and rate, raised-cosine PSK31, shaped CW keying — then
// given noise and a frequency error, because a decoder that only works on a
// perfect signal at exactly zero has not been tested.

const assert = require('assert');
const {
    GRAPH_VERSION, parseGraph, compile, Runtime, encodeIta2, encodeVaricode, encodeMorse, encodeSitorB, VARICODE, MORSE,
    expandDecoder, TEMPLATES, BLOCK_BY_TYPE, SNR_BANDWIDTH_HZ, TEST_MESSAGES, Transmitter, alignText, normaliseText,
} = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

function noise(seed = 5) {
    let s = seed;
    // Box–Muller, for Gaussian noise.
    return () => {
        s = (s * 16807) % 2147483647;
        const u = s / 2147483647;
        s = (s * 16807) % 2147483647;
        const v = s / 2147483647;
        return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
    };
}

/** Complex baseband from a function of time giving instantaneous frequency (Hz) and amplitude. */
function synth(seconds, rate, at, { noiseAmp = 0, seed = 5 } = {}) {
    const n = Math.round(seconds * rate);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    const g = noise(seed);
    let ph = 0;
    for (let k = 0; k < n; k++) {
        const { hz, amp } = at(k / rate);
        ph += (2 * Math.PI * hz) / rate;
        I[k] = amp * Math.cos(ph) + noiseAmp * g();
        Q[k] = amp * Math.sin(ph) + noiseAmp * g();
    }
    return { I, Q, n };
}

/** Run a graph over a signal and return the console's text. */
function decode(g, sig, rate, consoleId = 'con') {
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const p = Math.round(rate * 0.02);
    for (let at = 0; at < sig.n; at += p) {
        const len = Math.min(p, sig.n - at);
        rt.process({ i: sig.I.subarray(at, at + len), q: sig.Q.subarray(at, at + len), frames: len, rate });
    }
    return { text: rt.read(consoleId).text, rt };
}

// ── RTTY ────────────────────────────────────────────────────────────────────

/** Start-stop frames for codes: idle mark, then start, 5 data bits LSB first, stop. */
function rttyBits(codes, stop = 1.5, lead = 1) {
    const out = [];
    const add = (bit, len) => out.push([bit, len]);
    add(1, lead / (1 / 45.45) || 10);
    for (const c of codes) {
        add(0, 1);
        for (let b = 0; b < 5; b++) add((c >> b) & 1, 1);
        add(1, stop);
    }
    add(1, 10);
    return out;
}

/** RTTY as continuous-phase FSK, centred at `centre` Hz, mark the higher tone. */
function rtty(text, { rate = 12000, baud = 45.45, shift = 170, centre = 0, noiseAmp = 0, invert = false } = {}) {
    const frames = rttyBits(encodeIta2(text));
    const edges = [];
    let t0 = 0;
    for (const [bit, len] of frames) {
        edges.push([t0, bit]);
        t0 += len / baud;
    }
    let i = 0;
    return synth(t0, rate, (t) => {
        while (i + 1 < edges.length && edges[i + 1][0] <= t) i++;
        const mark = edges[i][1] ? 1 : -1;
        return { hz: centre + (invert ? -mark : mark) * (shift / 2), amp: 0.3 };
    }, { noiseAmp });
}

function rttyGraph(extra = {}) {
    return graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'fsk', type: 'fsk-detector', params: { shiftHz: 170, baud: 45.45, ...extra } },
            { id: 'uart', type: 'uart', params: { baud: 45.45, dataBits: 5, stopBits: 1.5 } },
            { id: 'ita2', type: 'ita2-decoder' },
            { id: 'con', type: 'console' },
        ],
        [['iq', 'out', 'fsk', 'in'], ['fsk', 'out', 'uart', 'in'], ['uart', 'codes', 'ita2', 'codes'], ['ita2', 'text', 'con', 'in']],
    );
}

const MSG = 'RYRYRY CQ CQ DE UBERSDR 599 73 THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 1234567890';

t('RTTY decodes exactly, clean, at 12 kHz', () => {
    const { text } = decode(rttyGraph(), rtty(MSG), 12000);
    assert.strictEqual(text.trim(), MSG);
});

// −3 dB in 3 kHz, the bandwidth amateur SNR figures are quoted in: measured,
// copy is exact here and has collapsed by −6.5 dB, which is where good RTTY
// software gives out too.
t('RTTY decodes exactly at −3 dB SNR (in 3 kHz) with a 15 Hz tuning error', () => {
    const sig = rtty(MSG, { noiseAmp: 0.6, centre: 15 });
    const { text } = decode(rttyGraph(), sig, 12000);
    assert.strictEqual(text.trim(), MSG);
});

t('RTTY decodes on a wide stream, through the detector’s own narrowing', () => {
    const { text, rt } = decode(rttyGraph(), rtty(MSG, { rate: 96000 }), 96000);
    assert.strictEqual(text.trim(), MSG);
    assert.ok(rt.plan.outRate.fsk <= 2000, `the detector runs at ${rt.plan.outRate.fsk} Hz`);
});

t('inverted RTTY decodes with Invert set, and is gibberish without', () => {
    const sig = rtty(MSG, { invert: true });
    assert.strictEqual(decode(rttyGraph({ invert: true }), sig, 12000).text.trim(), MSG);
    assert.notStrictEqual(decode(rttyGraph(), sig, 12000).text.trim(), MSG);
});

// ── the code tables ─────────────────────────────────────────────────────────

t('Varicode is prefix-free, has no "00" inside a code, and starts and ends with 1', () => {
    assert.strictEqual(VARICODE.length, 128);
    assert.strictEqual(new Set(VARICODE).size, 128);
    for (const c of VARICODE) {
        assert.ok(!c.includes('00') && c[0] === '1' && c[c.length - 1] === '1', c);
    }
});

// ── PSK31 ───────────────────────────────────────────────────────────────────

/**
 * PSK31 as a transmitter makes it: differential BPSK at 31.25 baud, a 0 a
 * reversal and a 1 none, each symbol a raised-cosine pulse two symbols long —
 * so a run of 1s is a steady carrier and a reversal passes smoothly through
 * zero. A preamble of reversals (PSK31's idle) lets the timing settle.
 */
function psk31(text, { rate = 12000, offset = 0, drift = 0, noiseAmp = 0, idle = 40, seed = 3 } = {}) {
    const bits = [...new Array(idle).fill(0), ...encodeVaricode(text), ...new Array(20).fill(0), ...new Array(10).fill(1)];
    const amps = [];
    let a = 1;
    for (const b of bits) {
        if (!b) a = -a;
        amps.push(a);
    }
    const T = 1 / 31.25;
    const n = Math.round((bits.length + 2) * T * rate);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    const g = noise(seed);
    for (let k = 0; k < n; k++) {
        const t = k / rate;
        const s0 = Math.floor(t / T);
        let v = 0;
        for (const j of [s0 - 1, s0, s0 + 1]) {
            if (j < 0 || j >= amps.length) continue;
            const d = t - (j + 1) * T;
            if (Math.abs(d) < T) v += amps[j] * 0.5 * (1 + Math.cos((Math.PI * d) / T));
        }
        const ph = 2 * Math.PI * (offset * t + 0.5 * drift * t * t);
        I[k] = 0.3 * v * Math.cos(ph) + noiseAmp * g();
        Q[k] = 0.3 * v * Math.sin(ph) + noiseAmp * g();
    }
    return { I, Q, n };
}

function pskGraph({ costas = false } = {}) {
    const nodes = [
        { id: 'iq', type: 'iq-in' },
        { id: 'lp', type: 'lowpass', params: { cutoffHz: 60, transitionHz: 40 } },
        { id: 'sync', type: 'symbol-sync', params: { baud: 31.25 } },
        { id: 'slice', type: 'psk-slicer', params: { mode: 'dbpsk' } },
        { id: 'vari', type: 'varicode-decoder' },
        { id: 'con', type: 'console' },
        { id: 'sym', type: 'constellation', params: { points: 128 } },
    ];
    const wires = [
        ['sync', 'out', 'slice', 'in'], ['slice', 'bits', 'vari', 'bits'], ['vari', 'text', 'con', 'in'], ['sync', 'out', 'sym', 'in'],
    ];
    if (costas) {
        nodes.push({ id: 'costas', type: 'costas-loop', params: { order: 2, bandwidthHz: 5 } });
        wires.push(['iq', 'out', 'lp', 'in'], ['lp', 'out', 'costas', 'in'], ['costas', 'out', 'sync', 'in']);
    } else {
        wires.push(['iq', 'out', 'lp', 'in'], ['lp', 'out', 'sync', 'in']);
    }
    return graph(nodes, wires);
}

const PSK_MSG = 'CQ CQ de M9PSY M9PSY pse k\nThe quick brown fox jumps over the lazy dog 0123456789.';

t('PSK31 decodes exactly, with a 3 Hz carrier error, without a carrier lock', () => {
    const { text } = decode(pskGraph(), psk31(PSK_MSG, { offset: 3 }), 12000);
    assert.ok(text.includes(PSK_MSG), JSON.stringify(text));
});

t('PSK31 decodes through noise', () => {
    // About 0 dB in 3 kHz — PSK31's 60 Hz is where its advantage is.
    const { text } = decode(pskGraph(), psk31(PSK_MSG, { offset: 2, noiseAmp: 0.15 }), 12000);
    assert.ok(text.includes(PSK_MSG), JSON.stringify(text));
});

t('with a Costas loop the carrier is locked and the constellation is two tight points', () => {
    const { text, rt } = decode(pskGraph({ costas: true }), psk31(PSK_MSG, { offset: 4 }), 12000);
    assert.ok(text.includes(PSK_MSG), JSON.stringify(text));
    assert.ok(Math.abs(rt.read('costas').hz - 4) < 0.2, `locked at ${rt.read('costas').hz} Hz`);
    const c = rt.read('sym');
    // The full-strength symbols: the last few, as the signal ends, fade to
    // nothing, and a nothing has any phase at all.
    const mags = Array.from(c.i, (v, k) => Math.hypot(v, c.q[k]));
    const big = Math.max(...mags);
    let worst = 0;
    for (let k = 0; k < c.i.length; k++) {
        if (mags[k] > 0.7 * big) worst = Math.max(worst, Math.abs(c.q[k]) / Math.abs(c.i[k]));
    }
    assert.ok(worst < 0.1, `the points are spread: Q/I up to ${worst.toFixed(3)}`);
});

t('the symbol sync settles on the symbol centres from any starting point', () => {
    for (const lag of [0, 0.13, 0.25, 0.37, 0.5, 0.62, 0.81, 0.93]) {
        const sig = psk31(PSK_MSG, { offset: 1 });
        const skip = Math.round(lag * 384);
        const cut = { I: sig.I.subarray(skip), Q: sig.Q.subarray(skip), n: sig.n - skip };
        const { text } = decode(pskGraph(), cut, 12000);
        assert.ok(text.includes(PSK_MSG.slice(4)), `lag ${lag}: ${JSON.stringify(text)}`);
    }
});

/** Random QPSK or 8PSK at `baud`, raised-cosine-ish pulses, with an offset — for the constellation. */
function mpsk(M, { rate = 12000, baud = 250, offset = 10, symbols = 1500, seed = 9 } = {}) {
    const T = 1 / baud;
    const n = Math.round(symbols * T * rate);
    let s = seed;
    const syms = Array.from({ length: symbols + 2 }, () => { s = (s * 16807) % 2147483647; return s % M; });
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        const t = k / rate;
        const s0 = Math.floor(t / T);
        let vr = 0;
        let vi = 0;
        for (const j of [s0 - 1, s0, s0 + 1]) {
            if (j < 0) continue;
            const d = t - (j + 1) * T;
            if (Math.abs(d) >= T) continue;
            const w = 0.5 * (1 + Math.cos((Math.PI * d) / T));
            const a = (2 * Math.PI * syms[j]) / M;
            vr += w * Math.cos(a);
            vi += w * Math.sin(a);
        }
        const ph = 2 * Math.PI * offset * t;
        I[k] = 0.3 * (vr * Math.cos(ph) - vi * Math.sin(ph));
        Q[k] = 0.3 * (vr * Math.sin(ph) + vi * Math.cos(ph));
    }
    return { I, Q, n };
}

for (const M of [4, 8]) {
    t(`a Costas loop and symbol sync make ${M === 4 ? 'QPSK' : '8PSK'} a constellation of ${M} tight points`, () => {
        const g = graph(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'lp', type: 'lowpass', params: { cutoffHz: 400 } },
                { id: 'costas', type: 'costas-loop', params: { order: M, bandwidthHz: 20 } },
                { id: 'sync', type: 'symbol-sync', params: { baud: 250 } },
                { id: 'sym', type: 'constellation', params: { points: 256 } },
                { id: 'slice', type: 'psk-slicer', params: { mode: M === 4 ? 'qpsk' : '8psk' } },
            ],
            [['iq', 'out', 'lp', 'in'], ['lp', 'out', 'costas', 'in'], ['costas', 'out', 'sync', 'in'], ['sync', 'out', 'sym', 'in'], ['sync', 'out', 'slice', 'in']],
        );
        // The meter cannot take bits: a bit stream only goes where bits go.
        const withMeter = { ...g, nodes: [...g.nodes, { id: 'm', type: 'meter', params: {}, x: 0, y: 0 }], wires: [...g.wires, ['slice', 'bits', 'm', 'in']] };
        assert.match(compile(withMeter, 12000).errors.map((e) => e.message).join(), /bits output cannot feed a real input/);
        const rt = new Runtime(g, 12000);
        const sig = mpsk(M);
        for (let at = 0; at < sig.n; at += 240) {
            rt.process({ i: sig.I.subarray(at, at + 240), q: sig.Q.subarray(at, at + 240), frames: 240, rate: 12000 });
        }
        const c = rt.read('sym');
        let worst = 0;
        for (let k = 0; k < c.i.length; k++) {
            const a = Math.atan2(c.q[k], c.i[k]);
            const off = a - Math.round(a / ((2 * Math.PI) / M)) * ((2 * Math.PI) / M);
            worst = Math.max(worst, Math.abs(off));
        }
        assert.ok(worst < Math.PI / M / 3, `points up to ${(worst * 180 / Math.PI).toFixed(1)}° off their place`);
    });
}

// ── CW ──────────────────────────────────────────────────────────────────────

/** CW: a carrier keyed by Morse timing, with 5 ms rise and fall, at `wpm`. */
function cw(text, { rate = 12000, wpm = 20, offset = 0, noiseAmp = 0, seed = 4 } = {}) {
    const dit = 1.2 / wpm;
    const els = [[false, 10], ...encodeMorse(text), [false, 14]];
    const edges = [];
    let t0 = 0;
    for (const [on, units] of els) {
        edges.push([t0, on]);
        t0 += units * dit;
    }
    let i = 0;
    const rise = 0.005;
    return synth(t0, rate, (t) => {
        while (i + 1 < edges.length && edges[i + 1][0] <= t) i++;
        const [start, on] = edges[i];
        const end = i + 1 < edges.length ? edges[i + 1][0] : t0;
        let amp = on ? 1 : 0;
        if (on) amp = Math.min(1, (t - start) / rise, (end - t) / rise);
        return { hz: offset, amp: 0.3 * Math.max(0, amp) };
    }, { noiseAmp, seed });
}

function cwGraph(wpm = 0) {
    return graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'ook', type: 'ook-detector', params: { bandwidthHz: 100 } },
            { id: 'morse', type: 'morse-decoder', params: { wpm } },
            { id: 'con', type: 'console' },
        ],
        [['iq', 'out', 'ook', 'in'], ['ook', 'key', 'morse', 'key'], ['morse', 'text', 'con', 'in']],
    );
}

const CW_MSG = 'VVV CQ CQ DE M9PSY M9PSY K 599 TU 73';

t('CW decodes exactly at 20 wpm, clean', () => {
    const { text } = decode(cwGraph(), cw(CW_MSG), 12000);
    assert.strictEqual(text.trim(), CW_MSG);
});

t('CW decodes through noise, and follows a sender faster than it expected', () => {
    // 15 dB SNR in 100 Hz. The opening letters may go while the levels and
    // the speed settle — which is what a sender's VVV is for — and after
    // that, exact.
    for (const wpm of [20, 30]) {
        const { text, rt } = decode(cwGraph(), cw(CW_MSG, { wpm, noiseAmp: 0.4, offset: 20 }), 12000);
        assert.ok(text.includes('DE M9PSY M9PSY K 599 TU 73'), `${wpm} wpm: ${JSON.stringify(text)}`);
        assert.ok(Math.abs(rt.read('morse').wpm - wpm) < 1.5, `thinks ${rt.read('morse').wpm.toFixed(1)} wpm`);
    }
});

t('CW copies at 9 dB SNR in 100 Hz up to 25 wpm, and at 12 dB at 40', () => {
    // Measured. Fast CW needs more: at 40 wpm a dit is 30 ms, about what the
    // 100 Hz filter and the debounce take to respond. Below these it falls
    // away, a word at a time.
    const want = 'DE M9PSY M9PSY K 599 TU 73';
    for (const [wpm, noiseAmp] of [[12, 0.8], [18, 0.8], [25, 0.8], [40, 0.6]]) {
        const { text } = decode(cwGraph(), cw(CW_MSG, { wpm, noiseAmp, offset: 20 }), 12000);
        const tail = text.trim().slice(-want.length - 2);
        let same = 0;
        for (const w of want.split(' ')) if (tail.includes(w)) same++;
        assert.ok(same >= want.split(' ').length - 1, `${wpm} wpm: ${JSON.stringify(text)}`);
    }
});

t('CW follows a sender who speeds up mid-message', () => {
    const a = cw('VVV CQ CQ DE M9PSY', { wpm: 20 });
    const b = cw('M9PSY K 599 TU 73 SK', { wpm: 30 });
    const I = new Float32Array(a.n + b.n);
    const Q = new Float32Array(a.n + b.n);
    I.set(a.I); I.set(b.I, a.n);
    Q.set(a.Q); Q.set(b.Q, a.n);
    const { text, rt } = decode(cwGraph(), { I, Q, n: a.n + b.n }, 12000);
    assert.strictEqual(text.trim(), 'VVV CQ CQ DE M9PSY M9PSY K 599 TU 73 SK');
    assert.ok(Math.abs(rt.read('morse').wpm - 30) < 1, `ends thinking ${rt.read('morse').wpm}`);
});

t('CW decodes from 12 to 40 wpm, clean, finding the speed itself', () => {
    for (const wpm of [12, 18, 32, 40]) {
        const { text, rt } = decode(cwGraph(), cw(CW_MSG, { wpm }), 12000);
        assert.strictEqual(text.trim(), CW_MSG, `${wpm} wpm`);
        // To within 2.5%: at 40 wpm a dit is 15 samples at the detector's
        // 500 Hz, so that is a sample's resolution.
        assert.ok(Math.abs(rt.read('morse').wpm - wpm) < 0.025 * wpm, `${wpm} wpm read as ${rt.read('morse').wpm}`);
    }
});

t('CW at a set speed does not drift from it', () => {
    const { text, rt } = decode(cwGraph(25), cw(CW_MSG, { wpm: 25 }), 12000);
    assert.strictEqual(text.trim(), CW_MSG);
    assert.ok(Math.abs(rt.read('morse').wpm - 25) < 1e-9);
});

// ── NAVTEX ──────────────────────────────────────────────────────────────────

/** SITOR-B codes as 100-baud FSK, bits LSB first, mark (1) the higher tone. */
function navtex(codes, { rate = 12000, noiseAmp = 0, flip = [] } = {}) {
    const bits = [];
    for (let i = 0; i < 37; i++) bits.push(i % 2);    // a little noise-like lead-in
    codes.forEach((c, ci) => {
        let v = c;
        // Ruin a code on purpose: `flip` lists [codeIndex, mask].
        for (const [at, mask] of flip) if (at === ci) v ^= mask;
        for (let b = 0; b < 7; b++) bits.push((v >> b) & 1);
    });
    const T = 1 / 100;
    let i = 0;
    return synth(bits.length * T + 0.1, rate, (t) => {
        i = Math.min(bits.length - 1, Math.floor(t / T));
        return { hz: (bits[i] ? 1 : -1) * 85, amp: 0.3 };
    }, { noiseAmp });
}

function navtexGraph() {
    return graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'fsk', type: 'fsk-detector', params: { shiftHz: 170, baud: 100 } },
            { id: 'sync', type: 'bit-sync', params: { baud: 100 } },
            { id: 'sitor', type: 'sitor-decoder' },
            { id: 'con', type: 'console' },
        ],
        [['iq', 'out', 'fsk', 'in'], ['fsk', 'out', 'sync', 'in'], ['sync', 'bits', 'sitor', 'bits'], ['sitor', 'text', 'con', 'in']],
    );
}

const NAVTEX_MSG = 'ZCZC GA01\nSECURITE\nGALE WARNING 042 SW 8 IN DOVER.\nNNNN';

t('NAVTEX decodes exactly, finding its own character alignment', () => {
    const { text } = decode(navtexGraph(), navtex(encodeSitorB(NAVTEX_MSG)), 12000);
    assert.ok(text.includes(NAVTEX_MSG), JSON.stringify(text));
});

t('NAVTEX’s repetition corrects a ruined copy of each of several characters', () => {
    const codes = encodeSitorB(NAVTEX_MSG);
    // Ruin some DX copies and some RX copies, never both of one character —
    // by an odd number of bits, which four-of-seven always detects. (An even
    // number can turn one valid code into another, which nothing can catch.)
    const flip = [[60, 0b0000001], [75, 0b0100000], [90, 0b0001000], [103, 0b1000101]];
    const { text } = decode(navtexGraph(), navtex(codes, { flip, noiseAmp: 0.1 }), 12000);
    assert.ok(text.includes(NAVTEX_MSG), JSON.stringify(text));
});

// ── PSK31 auto-tune ─────────────────────────────────────────────────────────

function pskDecoderGraph(params) {
    return graph(
        [{ id: 'iq', type: 'iq-in' }, { id: 'dec', type: 'psk31-decoder', params }, { id: 'con', type: 'console' }],
        [['iq', 'out', 'dec', 'in'], ['dec', 'text', 'con', 'in']],
    );
}

t('auto-tune pulls PSK31 in from 20 Hz off, through drift and noise, and settles on it', () => {
    // A PSK31 transmission opens with a couple of seconds of idle: time to lock.
    const sig = psk31(PSK_MSG, { offset: 1520, drift: 0.3, noiseAmp: 0.1, idle: 80 });
    const { text, rt } = decode(pskDecoderGraph({ offsetHz: 1500 }), sig, 12000);
    assert.ok(text.includes(PSK_MSG), JSON.stringify(text));
    const seconds = sig.n / 12000;
    const actual = 1520 + 0.3 * seconds;
    const tuned = rt.read('dec').tunedHz;
    assert.ok(Math.abs(tuned - actual) < 1, `tuned to ${tuned.toFixed(2)}, the signal ended at ${actual.toFixed(2)}`);
});

t('without auto-tune, the same signal 20 Hz off is not copied', () => {
    const sig = psk31(PSK_MSG, { offset: 1520, noiseAmp: 0.1, idle: 80 });
    const { text } = decode(pskDecoderGraph({ offsetHz: 1500, afc: false }), sig, 12000);
    assert.ok(!text.includes(PSK_MSG.slice(0, 20)), 'decoded 20 Hz off without help — the auto-tune test proves nothing');
});

t('auto-tune does not chase beyond its range', () => {
    const sig = psk31(PSK_MSG, { offset: 1560, idle: 80 });
    const { rt } = decode(pskDecoderGraph({ offsetHz: 1500, afcRangeHz: 30 }), sig, 12000);
    const tuned = rt.read('dec').tunedHz;
    assert.ok(tuned >= 1470 - 1e-9 && tuned <= 1530 + 1e-9, `ran to ${tuned}`);
});

t('moving the offset by hand starts the lock again from there', () => {
    // Two stations, 400 Hz apart; start on one, move to near the other.
    const a = psk31('AAAA AAAA AAAA', { offset: 1000, idle: 60 });
    const b = psk31(PSK_MSG, { offset: 1415, idle: 80, seed: 8 });
    const n = Math.max(a.n, b.n);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        I[k] = (a.I[k] || 0) + (b.I[k] || 0);
        Q[k] = (a.Q[k] || 0) + (b.Q[k] || 0);
    }
    const rt = new Runtime(pskDecoderGraph({ offsetHz: 1000 }), 12000);
    const half = 12000 * 2;
    for (let at = 0; at < half; at += 240) rt.process({ i: I.subarray(at, at + 240), q: Q.subarray(at, at + 240), frames: 240, rate: 12000 });
    assert.ok(Math.abs(rt.read('dec').tunedHz - 1000) < 1, `on the first station at ${rt.read('dec').tunedHz}`);
    rt.setParams('dec', { offsetHz: 1400 });
    for (let at = half; at < n; at += 240) rt.process({ i: I.subarray(at, at + 240), q: Q.subarray(at, at + 240), frames: 240, rate: 12000 });
    assert.ok(Math.abs(rt.read('dec').tunedHz - 1415) < 1, `moved to ${rt.read('dec').tunedHz}, the station is at 1415`);
    assert.ok(rt.read('con').text.includes(PSK_MSG.slice(-30)), JSON.stringify(rt.read('con').text));
});

// ── one-block decoders ──────────────────────────────────────────────────────

/** A signal moved up by `hz`, as it would sit away from the dial. */
function moved(sig, hz, rate = 12000) {
    const I = new Float32Array(sig.n);
    const Q = new Float32Array(sig.n);
    for (let k = 0; k < sig.n; k++) {
        const c = Math.cos((2 * Math.PI * hz * k) / rate);
        const s = Math.sin((2 * Math.PI * hz * k) / rate);
        I[k] = sig.I[k] * c - sig.Q[k] * s;
        Q[k] = sig.I[k] * s + sig.Q[k] * c;
    }
    return { I, Q, n: sig.n };
}

const ONE_BLOCK = [
    ['rtty-decoder', {}, () => rtty(MSG, { noiseAmp: 0.3 }), MSG],
    ['psk31-decoder', {}, () => psk31(PSK_MSG, { offset: 2, noiseAmp: 0.1 }), PSK_MSG],
    ['cw-decoder', {}, () => cw(CW_MSG, { wpm: 22, noiseAmp: 0.3 }), 'DE M9PSY M9PSY K 599 TU 73'],
    ['navtex-decoder', {}, () => navtex(encodeSitorB(NAVTEX_MSG), { noiseAmp: 0.1 }), NAVTEX_MSG],
];

for (const [type, params, make, want] of ONE_BLOCK) {
    t(`${type}: one block, at an offset, and Expand gives the same text`, () => {
        const sig = moved(make(), 1500);
        const g = graph(
            [{ id: 'iq', type: 'iq-in' }, { id: 'dec', type, params: { offsetHz: 1500, ...params } }, { id: 'con', type: 'console' }],
            [['iq', 'out', 'dec', 'in'], ['dec', 'text', 'con', 'in']],
        );
        const one = decode(g, sig, 12000).text;
        assert.ok(one.includes(want), `${type}: ${JSON.stringify(one)}`);
        const { graph: x, ids } = expandDecoder(g, 'dec');
        assert.ok(ids.length >= 3 && !x.nodes.some((n) => n.id === 'dec'));
        assert.ok(compile(x, 12000).ok, JSON.stringify(compile(x, 12000).errors));
        assert.strictEqual(decode(x, sig, 12000).text, one, 'the expanded graph says something else');
    });
}

t('the digital templates compile, and the decoding ones decode', () => {
    const byId = Object.fromEntries(TEMPLATES.map((x) => [x.id, x]));
    for (const id of ['rtty', 'psk31', 'cw', 'navtex', 'rtty-inside']) {
        assert.ok(byId[id], id);
        assert.ok(compile(byId[id].build(), 12000).ok, `${id}: ${JSON.stringify(compile(byId[id].build(), 12000).errors)}`);
    }
    const { text } = decode(byId.rtty.build(), moved(rtty(MSG), 1000), 12000, 'console');
    assert.strictEqual(text.trim(), MSG);
    const inside = decode(byId['rtty-inside'].build(), moved(rtty(MSG), 1000), 12000, 'console');
    assert.strictEqual(inside.text.trim(), MSG);
    assert.ok(inside.rt.read('eye').a, 'the eye shows nothing');
});

// ── the data transmitter ────────────────────────────────────────────────────

/**
 * A data transmitter straight into a one-block decoder, run for `seconds` with
 * no receiver; the console's text.
 */
function transmit(tx, decoderType, dec = {}, seconds = 25, rate = 12000) {
    const g = graph(
        [
            { id: 'tx', type: 'data-tx', params: { repeat: false, ...tx } },
            { id: 'd', type: decoderType, params: { offsetHz: tx.offsetHz ?? 1000, ...dec } },
            { id: 'con', type: 'console' },
            { id: 'sent', type: 'console' },
        ],
        [['tx', 'out', 'd', 'in'], ['d', 'text', 'con', 'in'], ['tx', 'sent', 'sent', 'in']],
    );
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const p = rate / 50;
    // When each console's text first reached its full length.
    const done = { con: null, sent: null };
    for (let k = 0; k < seconds * 50; k++) {
        rt.process({ i: null, q: null, frames: p, rate });
        for (const id of ['con', 'sent']) if (done[id] === null && rt.read(id).text.trim() === (tx.text || TEST_MESSAGES[tx.mode])) done[id] = k;
    }
    return { text: rt.read('con').text, sent: rt.read('sent').text, done, rt };
}

const DECODER_FOR = { cw: 'cw-decoder', rtty: 'rtty-decoder', psk: 'psk31-decoder', navtex: 'navtex-decoder' };

for (const mode of Object.keys(DECODER_FOR)) {
    t(`the data transmitter's ${mode} test message decodes, word for word, and its sent text says the same first`, () => {
        const { text, sent, done } = transmit({ mode }, DECODER_FOR[mode]);
        assert.strictEqual(text.trim(), TEST_MESSAGES[mode]);
        assert.strictEqual(sent.trim(), TEST_MESSAGES[mode]);
        // As it goes out, so never behind the decoder — and not all at once.
        assert.ok(done.sent !== null && done.sent <= done.con, `sent done at packet ${done.sent}, decoded at ${done.con}`);
        assert.ok(done.sent > 50, 'the sent text came out all at once');
    });
}

// Speeds, shifts and noise a decoder should still read: the message comes
// through, whatever the noise prints either side of it — from its second word,
// as in noise a decoder is still settling when the first arrives.
for (const [name, tx, dec, seconds] of [
    ['CW at 35 wpm, SNR 6 dB', { mode: 'cw', wpm: 35, noise: true, snrDb: 6 }, {}, 20],
    ['RTTY at 75 baud, 850 Hz shift, SNR 5 dB', { mode: 'rtty', baud: 75, shiftHz: 850, noise: true, snrDb: 5 }, { baud: 75, shiftHz: 850 }, 18],
    ['RTTY inverted, one stop bit', { mode: 'rtty', invert: true, stopBits: 1 }, { invert: true, stopBits: 1 }, 25],
    ['PSK125 at SNR 0 dB', { mode: 'psk', pskBaud: 125, noise: true, snrDb: 0 }, { baud: 125 }, 12],
    ['NAVTEX at SNR 0 dB', { mode: 'navtex', noise: true, snrDb: 0 }, {}, 25],
    ['RTTY 1.5 kHz down, at 48 kHz', { mode: 'rtty', offsetHz: -1500 }, {}, 25],
]) {
    t(`the data transmitter: ${name}`, () => {
        const rate = name.includes('48 kHz') ? 48000 : 12000;
        const { text } = transmit(tx, DECODER_FOR[tx.mode], dec, seconds, rate);
        const want = TEST_MESSAGES[tx.mode];
        assert.ok(text.includes(want.slice(want.indexOf(' ') + 1)), JSON.stringify(text));
    });
}

t('the data transmitter sends the message given, in place of the test one', () => {
    assert.strictEqual(transmit({ mode: 'rtty', text: 'HELLO PLAYGROUND 42' }, 'rtty-decoder', {}, 12).text.trim(), 'HELLO PLAYGROUND 42');
    // What a mode cannot send is left out rather than sent wrong: CW has no
    // lower case, so it sends it as capitals; and nothing for a '#'. The sent
    // text says so too.
    const cw = transmit({ mode: 'cw', text: 'test # 73' }, 'cw-decoder', {}, 15);
    assert.strictEqual(cw.text.trim(), 'TEST 73');
    assert.strictEqual(cw.sent.trim(), 'TEST 73');
});

t('the data transmitter repeats, with its gap, or sends once and stops', () => {
    const once = transmit({ mode: 'rtty', text: 'ONE' }, 'rtty-decoder', {}, 20);
    assert.strictEqual(once.text.trim(), 'ONE');
    assert.deepStrictEqual({ sending: once.rt.read('tx').sending, loops: once.rt.read('tx').loops }, { sending: false, loops: 1 });
    const again = transmit({ mode: 'rtty', text: 'ONE', repeat: true, gapSec: 1 }, 'rtty-decoder', {}, 20);
    assert.ok((again.text.match(/ONE/g) || []).length >= 3, JSON.stringify(again.text));
    // What was sent shows each copy on a line of its own.
    assert.ok(again.sent.startsWith('ONE\nONE\nONE'), JSON.stringify(again.sent));
    assert.strictEqual(once.sent, 'ONE');
});

t('the data transmitter sets its level, and its SNR in 2.5 kHz whatever the stream', () => {
    for (const rate of [12000, 48000]) {
        const tx = new Transmitter();
        const p = { ...defaults('data-tx'), mode: 'navtex', levelDb: -20, noise: true, snrDb: 10, repeat: true, gapSec: 0 };
        tx.configure(p, rate);
        const n = rate * 4;
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        tx.process(re, im, n);
        let total = 0;
        for (let k = 0; k < n; k++) total += re[k] * re[k] + im[k] * im[k];
        // FSK is constant envelope, so signal power is the level's; the rest
        // is noise, spread over the stream.
        const signal = 10 ** (-20 / 10);
        const noisePower = total / n - signal;
        const inBand = noisePower * (SNR_BANDWIDTH_HZ / rate);
        const snr = 10 * Math.log10(signal / inBand);
        assert.ok(Math.abs(snr - 10) < 0.2, `${rate}: SNR ${snr.toFixed(2)} dB`);
    }
});

t('the data transmitter shows only the settings its mode uses', () => {
    const spec = BLOCK_BY_TYPE['data-tx'].params;
    const shown = (mode) => Object.keys(spec).filter((k) => !spec[k].showIf || spec[k].showIf({ ...defaults('data-tx'), mode }));
    assert.ok(shown('cw').includes('wpm') && !shown('cw').includes('baud') && !shown('cw').includes('pskBaud'));
    assert.ok(shown('rtty').includes('baud') && shown('rtty').includes('shiftHz') && shown('rtty').includes('invert') && !shown('rtty').includes('wpm'));
    assert.ok(shown('psk').includes('pskBaud') && !shown('psk').includes('invert'));
    assert.ok(shown('navtex').includes('invert') && !shown('navtex').includes('baud'));
    // An empty message shows what will be sent in its place.
    assert.strictEqual(spec.text.placeholder({ mode: 'navtex' }), TEST_MESSAGES.navtex);
});

// ── text difference ─────────────────────────────────────────────────────────

/** A comparison as a string: [got≠sent], {+extra}, {-missing}, <noise>. */
function marked(sent, received) {
    const r = alignText(normaliseText(sent), normaliseText(received));
    const s = r.segments.map((x) => ({
        same: x.text, wrong: `[${x.text}≠${x.sent}]`, extra: `{+${x.text}}`, missing: `{-${x.text}}`, noise: `<${x.text}>`,
    })[x.kind]).join('');
    return { s, ...r };
}

t('text difference marks wrong, extra and missing characters, and counts them', () => {
    const S = 'CQ CQ DE TEST TEST K';
    assert.deepStrictEqual(
        (({ s, errors, compared }) => ({ s, errors, compared }))(marked(S, 'CQ C DE TEXT TESST K')),
        { s: 'CQ C{-Q} DE TE[X≠S]T TE{+S}ST K', errors: 3, compared: 20 },
    );
    assert.strictEqual(marked(S, 'CQ C DE TEXT TESST K').cer, 3 / 20);
    assert.strictEqual(marked(S, S).cer, 0);
});

t('text difference waits for a decoder that is behind, and does not count noise', () => {
    const S = 'CQ CQ DE TEST TEST K';
    const behind = marked(S, 'CQ CQ DE TE');
    assert.deepStrictEqual([behind.errors, behind.compared, behind.pending], [0, 11, 9]);
    assert.strictEqual(marked(S, 'EEN T CQ CQ DE TEST').s, '<EEN T >CQ CQ DE TEST');
    assert.strictEqual(marked(S, `${S} ETEEN TE`).s, `${S}< ETEEN TE>`);
    // Pure noise, even where it hits a letter, is not the message begun.
    assert.strictEqual(marked(S, 'XJQZ').cer, null);
    assert.strictEqual(marked(S, '').cer, null);
    // Spacing and capitals, as asked.
    assert.strictEqual(marked('cq  cq\nde', 'CQ CQ DE').cer, 0);
    assert.strictEqual(alignText(normaliseText('cq', { ignoreCase: false }), normaliseText('CQ', { ignoreCase: false })).errors, 0, 'no match is no message');
});

t('a console passes on what it prints', () => {
    const g = graph(
        [
            { id: 'tx', type: 'data-tx', params: { mode: 'rtty', text: 'PASS IT ON', repeat: false } },
            { id: 'a', type: 'console' },
            { id: 'b', type: 'console' },
        ],
        [['tx', 'sent', 'a', 'in'], ['a', 'out', 'b', 'in']],
    );
    const rt = new Runtime(g, 12000);
    for (let k = 0; k < 50 * 10; k++) rt.process({ i: null, q: null, frames: 240, rate: 12000 });
    assert.strictEqual(rt.read('b').text, 'PASS IT ON');
    assert.strictEqual(rt.read('b').text, rt.read('a').text);
});

t('a decoder test bench’s text difference is clean in the clear and counts errors in noise', () => {
    const run = (params, seconds) => {
        const g = TEMPLATES.find((x) => x.id === 'bench-rtty').build();
        g.nodes.find((n) => n.id === 'tx').params = { ...g.nodes.find((n) => n.id === 'tx').params, ...params };
        g.nodes.push({ id: 'plot', type: 'control-plot', params: {}, x: 0, y: 0 });
        g.wires.push(['diff', 'cer', 'plot', 'in']);
        const rt = new Runtime(g, 12000);
        for (let k = 0; k < 50 * seconds; k++) rt.process({ i: null, q: null, frames: 240, rate: 12000 });
        return { diff: rt.read('diff'), plot: rt.read('plot') };
    };
    const clean = run({}, 30);
    assert.strictEqual(clean.diff.errors, 0, JSON.stringify(clean.diff.segments));
    assert.ok(clean.diff.compared > 80, `compared ${clean.diff.compared}`);
    assert.strictEqual(clean.plot.value, 0, 'the error rate did not go out');
    const noisy = run({ noise: true, snrDb: -9 }, 30);
    assert.ok(noisy.diff.errors > 0 && noisy.diff.cer > 0, JSON.stringify(noisy.diff));
    assert.ok(noisy.diff.cer < 1, 'nothing decoded at all: the test proves nothing');
    assert.strictEqual(noisy.plot.value, noisy.diff.cer);
});

function defaults(type) {
    return Object.fromEntries(Object.entries(BLOCK_BY_TYPE[type].params).map(([k, v]) => [k, v.default]));
}

console.log(`\n${pass} passed`);
