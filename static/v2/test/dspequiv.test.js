// DemodChain, before and after: are they the same demodulator?
//
// DemodChain.process was one fused per-sample loop. It is being split into the
// primitives in lib/dsp/ so that the same parts can be blocks elsewhere, and the
// one promise that split makes is that the panel's demodulators are unchanged —
// not close, not within a tolerance, unchanged. So this runs the live chain and
// a frozen copy of the original (reference/iqDemod.ref.js) over identical input,
// packet for packet, and requires every output to be bit-for-bit the same:
// every audio sample, the meter level, the passband dBFS, the squelch state,
// the ECSS tracker's report and the audio spectrum.
//
// Bit-for-bit is achievable because the split reorders nothing — each stage
// only feeds the ones after it within a sample, so running them stage by stage
// over a block performs the same operations in the same order — provided the
// buffers between stages are doubles. A Float32Array between two stages would
// round there, and this is the test that would say so.
//
// What it does not require is that one chain's output be independent of how the
// stream was cut into packets. The original is not: it wraps its oscillator
// phases and renormalises its phasor once per block, which moves the last bits.
// So both chains are always given the same cuts, and the cuts are varied.

const assert = require('assert');
const { DemodChain, planFor, RefChain, refPlanFor } = require('./.build/dspequiv.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const { rng, scene } = require('./dspscene.js');

// ── cutting the stream into packets ─────────────────────────────────────────

const SPLITS = {
    // What the server sends: 20 ms.
    packet: (rate) => { const p = Math.round(rate * 0.02); return () => p; },
    // Awkward fixed sizes, including a single sample and one bigger than any
    // real packet.
    odd: () => { const s = [1, 7, 13, 240, 4096, 333]; let i = 0; return () => s[i++ % s.length]; },
    // Anything at all.
    random: () => { const r = rng(99); return () => 1 + Math.floor(r() * 2000); },
};

// ── running the pair ────────────────────────────────────────────────────────

const same = (a, b) => Object.is(a, b);

/** Compare everything a chain exposes after one packet. */
function compare(where, a, b, outA, outB, wantSpectrum) {
    assert.strictEqual(outA === null, outB === null, `${where}: one returned audio and the other did not`);
    assert.strictEqual(a.outFrames, b.outFrames, `${where}: outFrames`);
    if (outA) {
        for (let k = 0; k < a.outFrames; k++) {
            if (!same(outA[k], outB[k])) {
                assert.fail(`${where}: sample ${k} differs: ${outB[k]} (new) vs ${outA[k]} (reference)`);
            }
        }
    }
    for (const key of ['rate', 'inRate', 'D', 'level', 'sigDb', 'gateOpen']) {
        if (!same(a[key], b[key])) assert.fail(`${where}: ${key} ${b[key]} (new) vs ${a[key]} (reference)`);
    }
    assert.deepStrictEqual(b.ecssStatus, a.ecssStatus, `${where}: ecssStatus`);
    if (wantSpectrum) {
        const sa = a.audioSpectrum();
        const sb = b.audioSpectrum();
        assert.strictEqual(sb.binHz, sa.binHz, `${where}: spectrum binHz`);
        for (let k = 0; k < sa.db.length; k++) {
            if (!same(sa.db[k], sb.db[k])) assert.fail(`${where}: spectrum bin ${k} differs`);
        }
    }
}

// What the cases between them have been seen to do, so the tests can say they
// exercised the paths that matter rather than assume it.
const seen = { gateShut: 0, gateOpen: 0, states: new Set(), decimated: 0, outNull: 0 };

/**
 * Run both chains over a scene. `steps` is a list of [fromSec, settings]: the
 * settings in force from that time, re-planned every packet as the engine does.
 */
function run({ rate, seconds, split, steps, seed }) {
    const { I, Q, n } = scene(rate, seconds, seed);
    const ref = new RefChain();
    const now = new DemodChain();
    const next = SPLITS[split](rate);
    let at = 0;
    let packet = 0;
    while (at < n) {
        const len = Math.min(next(), n - at);
        const ts = at / rate;
        let s = steps[0][1];
        for (const [from, v] of steps) if (ts >= from) s = v;
        const plan = planFor(s);
        assert.deepStrictEqual(plan, refPlanFor(s), 'planFor itself changed');
        ref.configure(plan, rate);
        now.configure(plan, rate);
        const opts = { agc: s.agc !== false, gain: s.gain ?? 1, squelchDb: s.squelchDb ?? -60 };
        const pI = I.subarray(at, at + len);
        const pQ = Q.subarray(at, at + len);
        const outA = ref.process(pI, pQ, len, opts);
        const outB = now.process(pI, pQ, len, opts);
        compare(`${s.mode} @${rate} packet ${packet} (t=${ts.toFixed(3)}s)`, ref, now, outA, outB, packet % 17 === 0);
        if (!outA) seen.outNull++;
        if (ref.D > 1) seen.decimated++;
        if (opts.squelchDb > -60) seen[ref.gateOpen ? 'gateOpen' : 'gateShut']++;
        if (ref.ecssStatus) seen.states.add(ref.ecssStatus.state);
        at += len;
        packet++;
    }
}

// ── the cases ───────────────────────────────────────────────────────────────

const BASE = { pitchHz: 700, sideband: 'both', trackHz: 300, lowCutHz: 50 };

// Each mode, aimed at the component in the scene it is for.
const MODES = [
    { mode: 'usb', offsetHz: -4500, widthHz: 2700 },
    { mode: 'usb', offsetHz: -4500, widthHz: 2400, lowCutHz: 300 },
    { mode: 'lsb', offsetHz: -2200, widthHz: 1800 },
    { mode: 'cwu', offsetHz: 0, widthHz: 500 },
    { mode: 'cwl', offsetHz: 0, widthHz: 250, pitchHz: 600 },
    { mode: 'am', offsetHz: 2000, widthHz: 9000 },
    { mode: 'sam', offsetHz: 1950, widthHz: 9000 },
    { mode: 'ecss', offsetHz: 2040, widthHz: 4500 },
    { mode: 'ecss', offsetHz: 2000, widthHz: 3000, sideband: 'auto' },
    { mode: 'ecss', offsetHz: 2000, widthHz: 4000, sideband: 'lsb' },
    { mode: 'nfm', offsetHz: -1500, widthHz: 6000 },
];

// The back end's three shapes: levelled, squelched, and fixed gain.
const BACKS = [
    { agc: true, gain: 1, squelchDb: -60 },
    { agc: true, gain: 1, squelchDb: -28 },
    { agc: false, gain: 2.5, squelchDb: -60 },
];

const RATES = [
    { rate: 12000, seconds: 3.2 },
    { rate: 48000, seconds: 2.4 },
    { rate: 192000, seconds: 2.2 },
];

const label = (m) => `${m.mode} ${m.widthHz}${m.sideband ? ` ${m.sideband}` : ''}${m.lowCutHz ? ` lc${m.lowCutHz}` : ''}`;

for (const { rate, seconds } of RATES) {
    for (const m of MODES) {
        for (const b of BACKS) {
            const s = { ...BASE, ...m, ...b };
            t(`${label(m)} @${rate / 1000}k, agc ${b.agc} gain ${b.gain} sq ${b.squelchDb}: identical`, () => {
                run({ rate, seconds, split: 'packet', steps: [[0, s]] });
            });
        }
    }
}

// The cuts, on a subset: one sideband mode, one tracked, one FM, plain and wide.
for (const split of ['odd', 'random']) {
    for (const rate of [12000, 192000]) {
        for (const m of [MODES[0], MODES[7], MODES[10]]) {
            t(`${label(m)} @${rate / 1000}k cut ${split}: identical`, () => {
                run({ rate, seconds: 2.2, split, steps: [[0, { ...BASE, ...m, ...BACKS[1] }]] });
            });
        }
    }
}

// The settings moving under a running chain: the offset dragged, the width
// changed, the mode changed into and out of the tracker, the squelch and AGC
// switched — every re-plan path configure() has.
const MOVES = [
    [0.0, { ...BASE, mode: 'usb', offsetHz: -4500, widthHz: 2700 }],
    [0.3, { ...BASE, mode: 'usb', offsetHz: -4300, widthHz: 2700 }],
    [0.4, { ...BASE, mode: 'usb', offsetHz: -4100, widthHz: 3200, squelchDb: -30 }],
    [0.6, { ...BASE, mode: 'am', offsetHz: 2000, widthHz: 9000 }],
    [0.9, { ...BASE, mode: 'sam', offsetHz: 2000, widthHz: 9000 }],
    [1.4, { ...BASE, mode: 'ecss', offsetHz: 2000, widthHz: 4500 }],
    [1.9, { ...BASE, mode: 'ecss', offsetHz: 2000, widthHz: 4500, sideband: 'usb', agc: false, gain: 0.8 }],
    [2.1, { ...BASE, mode: 'nfm', offsetHz: -1500, widthHz: 8000 }],
    [2.3, { ...BASE, mode: 'cwu', offsetHz: 0, widthHz: 500, squelchDb: -40 }],
    [2.5, { ...BASE, mode: 'cwl', offsetHz: 0, widthHz: 500, pitchHz: 900 }],
    [2.7, { ...BASE, mode: 'sam', offsetHz: 2000, widthHz: 6000 }],
    [2.9, { ...BASE, mode: 'lsb', offsetHz: -2200, widthHz: 2400, lowCutHz: 200 }],
];
for (const rate of [12000, 48000, 192000]) {
    for (const split of ['packet', 'random']) {
        t(`settings moving under a running chain @${rate / 1000}k, cut ${split}: identical`, () => {
            run({ rate, seconds: 3.2, split, steps: MOVES });
        });
    }
}

// And reset() in the middle of a stream, which the engine does on start, stop
// and a return to quadrature.
t('reset() mid-stream: identical', () => {
    const rate = 12000;
    const { I, Q, n } = scene(rate, 2);
    const ref = new RefChain();
    const now = new DemodChain();
    const s = { ...BASE, ...MODES[7], ...BACKS[1] };
    const plan = planFor(s);
    for (let at = 0, p = 0; at < n; at += 240, p++) {
        if (p === 40) { ref.reset(); now.reset(); }
        ref.configure(plan, rate);
        now.configure(plan, rate);
        const opts = { agc: true, gain: 1, squelchDb: s.squelchDb };
        const a = ref.process(I.subarray(at, at + 240), Q.subarray(at, at + 240), 240, opts);
        const b = now.process(I.subarray(at, at + 240), Q.subarray(at, at + 240), 240, opts);
        compare(`packet ${p}`, ref, now, a, b, true);
    }
});

// ── coverage ────────────────────────────────────────────────────────────────

t('the cases reached every path that matters', () => {
    assert.ok(seen.gateOpen > 0, 'the squelch was never open');
    assert.ok(seen.gateShut > 0, 'the squelch never shut');
    assert.ok(seen.decimated > 0, 'the decimating front end never ran');
    assert.ok(seen.outNull > 0, 'no packet was too short to produce a decimated sample');
    for (const st of ['search', 'acquire', 'locked']) {
        assert.ok(seen.states.has(st), `the tracker was never in ${st} (saw ${[...seen.states].join(', ')})`);
    }
});

console.log(`\n${pass} passed`);
