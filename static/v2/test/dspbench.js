// How much a DemodChain costs, against the frozen original.
//
// Not part of run.sh: timings are a measurement, not a pass/fail, and they are
// noisy enough on a shared machine that a threshold would flake. Run it by hand
// after a change to lib/dsp/ or DemodChain:
//
//   esbuild dspequiv.entry.js --bundle --format=cjs --platform=node \
//       --outfile=.build/dspequiv.cjs && node dspbench.js
//
// Each figure is milliseconds of CPU per second of stream, i.e. per-mille of one
// core for one demodulator. Reference and new runs are interleaved and the
// median of several is reported, so a background burst lands on both.

const { DemodChain, planFor, RefChain } = require('./.build/dspequiv.cjs');
const { scene } = require('./dspscene.js');

const BASE = { pitchHz: 700, sideband: 'both', trackHz: 300, lowCutHz: 50 };
const CASES = [
    { rate: 12000, s: { mode: 'usb', offsetHz: -4500, widthHz: 2700 } },
    { rate: 12000, s: { mode: 'cwu', offsetHz: 0, widthHz: 250 } },
    { rate: 12000, s: { mode: 'am', offsetHz: 2000, widthHz: 9000 } },
    { rate: 12000, s: { mode: 'nfm', offsetHz: -1500, widthHz: 8000 } },
    { rate: 12000, s: { mode: 'ecss', offsetHz: 2000, widthHz: 4500 } },
    { rate: 192000, s: { mode: 'usb', offsetHz: -4500, widthHz: 2700 } },
    { rate: 192000, s: { mode: 'am', offsetHz: 2000, widthHz: 9000 } },
    { rate: 192000, s: { mode: 'ecss', offsetHz: 2000, widthHz: 4500 } },
];
const SECONDS = 3;
const ROUNDS = 7;

function time(Chain, plan, rate, I, Q, n) {
    const chain = new Chain();
    const p = Math.round(rate * 0.02);
    const opts = { agc: true, gain: 1, squelchDb: -30 };
    const t0 = process.hrtime.bigint();
    for (let at = 0; at < n; at += p) {
        const len = Math.min(p, n - at);
        chain.configure(plan, rate);
        chain.process(I.subarray(at, at + len), Q.subarray(at, at + len), len, opts);
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

console.log('case                       ref ms/s   new ms/s   change');
for (const { rate, s } of CASES) {
    const { I, Q, n } = scene(rate, SECONDS);
    const plan = planFor({ ...BASE, ...s });
    // Warm both up so the JIT has settled before anything is counted.
    time(RefChain, plan, rate, I, Q, n);
    time(DemodChain, plan, rate, I, Q, n);
    const a = [];
    const b = [];
    for (let r = 0; r < ROUNDS; r++) {
        a.push(time(RefChain, plan, rate, I, Q, n) / SECONDS);
        b.push(time(DemodChain, plan, rate, I, Q, n) / SECONDS);
    }
    const ra = median(a);
    const rb = median(b);
    const name = `${s.mode} ${s.widthHz} @${rate / 1000}k`.padEnd(26);
    const pct = ((rb / ra - 1) * 100).toFixed(1);
    console.log(`${name} ${ra.toFixed(2).padStart(8)}   ${rb.toFixed(2).padStart(8)}   ${pct >= 0 ? '+' : ''}${pct}%`);
}
