// The synthetic band the DemodChain equivalence tests and benchmark both run
// over. Plain node, no bundle: it only makes arrays.

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A busy band, as the chains would see it: noise, a keyed CW carrier, a
 * two-tone sideband signal that comes and goes, a fading AM broadcast, an FM
 * carrier, and — on a wide stream — a strong station well outside plain IQ's
 * 12 kHz for the decimating front end to reject. Every component goes silent
 * together for a stretch, so the squelch shuts and the AGC winds up, and comes
 * back, so both have to recover.
 */
function scene(rate, seconds, seed = 1) {
    const n = Math.round(rate * seconds);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    const r = rng(seed);
    const add = (k, amp, phase) => {
        I[k] += amp * Math.cos(phase);
        Q[k] += amp * Math.sin(phase);
    };
    let fmPhase = 0;
    for (let k = 0; k < n; k++) {
        const ts = k / rate;
        // Approximately Gaussian noise, about -50 dBFS.
        const g = () => (r() + r() + r() + r() - 2) * 0.004;
        I[k] = g();
        Q[k] = g();
        // Everything off between 1.2 and 1.8 s.
        const on = ts < 1.2 || ts > 1.8 ? 1 : 0;
        if (!on) continue;
        const w = (hz) => 2 * Math.PI * hz * ts;
        // CW at +150 Hz, keyed at 8 Hz.
        if (Math.floor(ts * 16) % 3 !== 0) add(k, 0.05, w(150));
        // Sideband pair at -4500 + 700 / +1500, syllabic.
        const syl = 0.5 + 0.5 * Math.sin(w(3));
        add(k, 0.03 * syl, w(-3800));
        add(k, 0.02 * syl, w(-3000));
        // AM broadcast at +2000: carrier fading at 0.4 Hz, 1 kHz and 400 Hz audio.
        const fade = 0.55 + 0.45 * Math.cos(w(0.4));
        const mod = 1 + 0.6 * Math.sin(w(1000)) + 0.2 * Math.sin(w(400));
        add(k, 0.1 * fade * mod, w(2000));
        // FM at -1500, 2.5 kHz deviation of a 700 Hz tone.
        fmPhase += (2 * Math.PI * (-1500 + 2500 * Math.sin(w(700)))) / rate;
        add(k, 0.04, fmPhase);
        // Far outside the 12 kHz, only on a wide stream.
        if (rate > 24000) add(k, 0.5, w(15000));
    }
    return { I, Q, n };
}

module.exports = { rng, scene };
