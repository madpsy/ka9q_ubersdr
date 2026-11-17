// Naming the signal: FT8, CW, RTTY... from the classifier's embedding.
//
// The network that says VOICE / MUSIC / NOISE also computes, for every 5 s
// window, a 640-number embedding of what it heard. audioclass/signals.bin holds
// the same embedding for some 1,600 reference recordings of about 500 signals,
// plus synthetic CW, FT8, FT4 and RTTY, made by the ubersdr-classifier
// repository (train/export_signals.py).
// What is heard is named after the recording it is closest to, averaged over
// the windows since the last retune: one window is too little to tell FT8 from
// its neighbours, a minute of them is plenty.
//
// The rule is the one measured on the reference recordings and on a receiver's live
// audio (ubersdr-classifier, train/live_test.py): a name only when the closest
// signal has at least 70% of the probability, else a family (FSK, PSK...) when
// that has 70%, else nothing. Voice is AudioSet's speech tag: windows heard as
// speech outweigh a name when they are a quarter of the windows, and fill in
// when nothing is named.
//
// Pure functions and one small object, run in the classifier's worker.

const MAGIC = 0x47534255; // "UBSG", little-endian

function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
}

let HALF = null;
function halfTable() {
    if (!HALF) {
        HALF = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) HALF[i] = halfToFloat(i);
    }
    return HALF;
}

/** signals.bin, parsed. Throws on anything malformed. */
export function parseSignals(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a signals file');
    if (dv.getUint32(4, true) !== 1) throw new Error('signals file version not supported');
    const hlen = dv.getUint32(8, true);
    let off = 12;
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, hlen)));
    off += hlen;
    const D = header.dims, S = header.signals.length, N = header.references.total;
    const need = off + 4 * D + 2 * N * D + 2 * N + ((2 * N) % 4) + 2 * S * D;
    if (buffer.byteLength < need) throw new Error('signals file truncated');
    const mean = new Float32Array(buffer.slice(off, off + 4 * D));
    off += 4 * D;
    const H = halfTable();
    const half = (n) => {
        const raw = new Uint16Array(buffer.slice(off, off + 2 * n));
        off += 2 * n;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = H[raw[i]];
        return out;
    };
    const refs = half(N * D);
    const refSig = new Uint16Array(buffer.slice(off, off + 2 * N));
    off += 2 * N + ((2 * N) % 4);
    const cent = half(S * D);
    const famIndex = new Map(header.families.map((f, i) => [f.id, i]));
    const sigFam = new Uint16Array(S);
    for (let i = 0; i < S; i++) sigFam[i] = famIndex.get(header.signals[i].family) || 0;
    return { header, D, S, N, mean, refs, refSig, cent, sigFam };
}

function dot(a, ao, b, bo, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[ao + i] * b[bo + i];
    return s;
}

function unitInPlace(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    const k = 1 / (Math.sqrt(n) + 1e-9);
    for (let i = 0; i < v.length; i++) v[i] *= k;
    return v;
}

// Windows held: the last minute (a window every 2.5 s) ...
export const MAX_WINDOWS = 24;
// ... and before this many nothing is named: one window is a guess.
export const MIN_WINDOWS = 4;

/**
 * Scores a set of window vectors (each centred and unit, as add() stores them)
 * against the references: the probability of each signal and family, and the
 * badge rule's call. Exported for the tests.
 */
export function scoreWindows(ref, vectors, verdicts) {
    const { D, S, N, refs, refSig, cent, sigFam, header } = ref;
    const n = vectors.length;
    const v = new Float32Array(D);
    for (const w of vectors) for (let i = 0; i < D; i++) v[i] += w[i];
    unitInPlace(v);

    const best = new Float64Array(S).fill(-Infinity);
    for (let r = 0; r < N; r++) {
        const s = dot(refs, r * D, v, 0, D);
        const k = refSig[r];
        if (s > best[k]) best[k] = s;
    }
    const tau = header.tau;
    let mx = -Infinity;
    for (let k = 0; k < S; k++) if (best[k] > mx) mx = best[k];
    const p = new Float64Array(S);
    let tot = 0;
    for (let k = 0; k < S; k++) {
        if (best[k] === -Infinity) continue;
        p[k] = Math.exp((best[k] - mx) / tau);
        tot += p[k];
    }
    const fams = header.families;
    const fp = new Float64Array(fams.length);
    let top = 0;
    for (let k = 0; k < S; k++) {
        p[k] /= tot;
        fp[sigFam[k]] += p[k];
        if (p[k] > p[top]) top = k;
    }
    let ftop = 0;
    for (let f = 0; f < fams.length; f++) if (fp[f] > fp[ftop]) ftop = f;
    const closeness = dot(cent, top * D, v, 0, D);

    const { t_name: tName, s_min: sMin, t_family: tFamily } = header.rule;
    let say = 'nothing';
    if (n >= MIN_WINDOWS) {
        if (p[top] >= tName && closeness >= sMin) say = 'name';
        else if (fp[ftop] >= tFamily) say = 'family';
    }
    // Voice: AudioSet's speech tag, counted over the same windows.
    const vr = header.voice;
    const speech = verdicts.filter((r) => r.label === 'voice' && r.confidence >= vr.conf).length;
    if (speech >= vr.windows && (say !== 'name' || speech >= vr.strong * n)) say = 'voice';

    const order = Array.from(p.keys()).sort((a, b) => p[b] - p[a]).slice(0, 3);
    const sig = header.signals[top];
    return {
        say,
        name: sig.name,
        short: sig.short,
        p: p[top],
        family: fams[ftop].id,
        familyText: fams[ftop].text,
        familyP: fp[ftop],
        top: order.map((k) => ({ name: header.signals[k].name, p: p[k] })),
        windows: n,
        speech,
    };
}

/**
 * The windows heard since the last retune. add() each classified window's
 * embedding (copied: the module reuses its buffer) and verdict; score() says
 * what they add up to; clear() on a retune.
 */
export function createSignalTracker(ref) {
    let vectors = [];
    let verdicts = [];
    return {
        clear() { vectors = []; verdicts = []; },
        add(embedding, verdict) {
            const w = new Float32Array(ref.D);
            for (let i = 0; i < ref.D; i++) w[i] = embedding[i] - ref.mean[i];
            vectors.push(unitInPlace(w));
            verdicts.push({ label: verdict.label, confidence: verdict.confidence });
            if (vectors.length > MAX_WINDOWS) { vectors.shift(); verdicts.shift(); }
        },
        count: () => vectors.length,
        score() { return vectors.length ? scoreWindows(ref, vectors, verdicts) : null; },
    };
}
