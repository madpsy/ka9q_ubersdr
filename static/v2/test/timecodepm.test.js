// The DCF77 and ALS162 time-code decoders (playground/timecode/dcf77.js and
// allouis.js), against synthetic broadcasts built here from the stations'
// published formats — not from the decoders' own tables, except ALS162's
// position codes, which are the table itself.

const assert = require('assert');
const { Dcf77Decoder, buildChips, AllouisDecoder, ALS162_CODES } = require('./.build/timecodepm.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const FS = 12000;

// ── a seeded RNG and Gaussian noise ─────────────────────────────────────────

function rng(seed) {
    let a = seed >>> 0;
    const u = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    const gauss = () => {
        if (spare !== null) { const s = spare; spare = null; return s; }
        let r = 0;
        let v = 0;
        while (r === 0) { r = u(); }
        v = u();
        const m = Math.sqrt(-2 * Math.log(r));
        spare = m * Math.sin(2 * Math.PI * v);
        return m * Math.cos(2 * Math.PI * v);
    };
    return { u, gauss };
}

// ── European legal time, from Date (independent of the decoders' civil.js) ──

function lastSundayUtc(y, m /* 0-based */) {
    const d = new Date(Date.UTC(y, m + 1, 0)); // the month's last day
    return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay(), 1, 0, 0);
}
function summerAt(ms) {
    const y = new Date(ms).getUTCFullYear();
    return ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9);
}

/**
 * The 60 time-code bits DCF77 sends in the minute whose s0 is UTC `m0` (ms):
 * the legal time of the NEXT minute, BCD LSB first, even parities, CET/CEST.
 * Bits 1–16 and 19 are 0 (no weather, call, change or leap announcements).
 */
function legalBits(m0) {
    const next = m0 + 60000;
    const cest = summerAt(next);
    const d = new Date(next + (cest ? 2 : 1) * 3600000);
    const b = new Array(60).fill(0);
    const put = (s, n, v) => { for (let i = 0; i < n; i++) b[s + i] = (v >> i) & 1; };
    const bcd = (v) => ((Math.floor(v / 10)) << 4) | (v % 10);
    const par = (a, z) => { let p = 0; for (let s = a; s <= z; s++) p ^= b[s]; return p; };
    b[17] = cest ? 1 : 0;
    b[18] = cest ? 0 : 1;
    b[20] = 1;
    put(21, 7, bcd(d.getUTCMinutes()));
    b[28] = par(21, 27);
    put(29, 6, bcd(d.getUTCHours()));
    b[35] = par(29, 34);
    put(36, 6, bcd(d.getUTCDate()));
    put(42, 3, d.getUTCDay() || 7);   // 1 = Monday … 7 = Sunday
    put(45, 5, bcd(d.getUTCMonth() + 1));
    put(50, 8, bcd(d.getUTCFullYear() % 100));
    b[58] = par(36, 57);
    return b;
}

/** ALS162's: DCF77's layout from 17, bit 0 = 0, and bits 3–6 the count of 1s in 21–58 (weights 2, 4, 8, 16). */
function alsBits(m0) {
    const b = legalBits(m0);
    let ones = 0;
    for (let s = 21; s <= 58; s++) ones += b[s];
    assert.strictEqual(ones % 2, 0);
    for (let i = 0; i < 4; i++) b[3 + i] = ((ones >> 1) >> i) & 1;
    return b;
}

// PTB's 9-bit Galois LFSR, written out again here: +1 for a 0 chip, −1 for a 1.
function lfsrChips() {
    const out = [];
    let r = 0;
    for (let i = 0; i < 512; i++) {
        const chip = r & 1;
        out.push(chip ? -1 : 1);
        r >>>= 1;
        if (chip ^ (r === 0 ? 1 : 0)) r ^= 0x110;
    }
    return out;
}
const CHIPS = lfsrChips();
const CHIP_SEC = 120 / 77500;
const PM_RAD = (15.6 * Math.PI) / 180;

// ALS162's excursion and position-code phase, from the format.
const exc = (t) => {
    if (t < 0 || t >= 0.1) return 0;
    const u = t / 0.025;
    return u < 1 ? u : u < 3 ? 2 - u : u - 4;
};
const codePh = (s, t) => {
    if (t < 0.2 || t >= 1.0) return 0;
    const u = (t - 0.2) / 0.025;
    const k = Math.floor(u);
    let ph = 0;
    for (let i = 0; i < k; i++) ph += ALS162_CODES[s][i];
    return ph + ALS162_CODES[s][k] * (u - k);
};
const ALS_LEAD = 0.05048;   // the excursion starts this long before the second

/**
 * A broadcast as complex baseband at FS, starting at UTC `startMs` (any ms,
 * fractions allowed), carrier at `carrierHz`, unit amplitude, complex
 * Gaussian noise of `sigma` per component. `corrupt(m0, bits)` may change a
 * minute's bits after they are built; `erase` is a set of seconds of the
 * minute (ALS162) that are sent without their data excursion. `next(n)` fills
 * the next n samples.
 */
function synth({ station, startMs, carrierHz = 0, sigma = 0.05, seed = 1, corrupt = null, erase = null, noiseOnly = false }) {
    const R = rng(seed);
    const startS = Math.floor(startMs / 1000);
    const startFrac = startMs / 1000 - startS;
    const phase0 = R.u() * 2 * Math.PI;
    const bitsCache = new Map();
    const bitsOf = (m0) => {
        if (!bitsCache.has(m0)) {
            const b = station === 'dcf77' ? legalBits(m0) : alsBits(m0);
            if (corrupt) corrupt(m0, b);
            bitsCache.set(m0, b);
        }
        return bitsCache.get(m0);
    };
    let n = 0;
    const sampleAt = (k) => {
        const tr = startFrac + k / FS;                // seconds since startS
        let amp = 1;
        let ph = 0;
        if (station === 'dcf77') {
            const si = Math.floor(tr);
            const frac = tr - si;
            const S = startS + si;
            const sec = ((S % 60) + 60) % 60;
            const bits = bitsOf((S - sec) * 1000);
            if (sec !== 59 && frac < (bits[sec] ? 0.2 : 0.1)) amp = 0.15;
            const pmBit = sec === 59 ? 0 : sec <= 9 ? 1 : sec <= 14 ? 0 : bits[sec];
            const ci = Math.floor((frac - 0.2) / CHIP_SEC);
            if (ci >= 0 && ci < 512) ph = PM_RAD * CHIPS[ci] * (pmBit ? -1 : 1);
        } else {
            const si = Math.floor(tr + ALS_LEAD);
            const u = tr - (si - ALS_LEAD);
            const S = startS + si;
            const sec = ((S % 60) + 60) % 60;
            const bits = bitsOf((S - sec) * 1000);
            if (sec !== 59) {
                if (!(erase && erase.has(sec))) ph += exc(u) + (bits[sec] ? exc(u - 0.1) : 0);
                ph += codePh(sec, u);
            }
        }
        const th = phase0 + 2 * Math.PI * carrierHz * (k / FS) + ph;
        const s = noiseOnly ? 0 : amp;
        return [s * Math.cos(th) + sigma * R.gauss(), s * Math.sin(th) + sigma * R.gauss()];
    };
    return {
        startS, startFrac,
        /** Sample index of UTC second S's on-time instant. */
        edgeOf: (S) => (S - startS - startFrac) * FS,
        /** The UTC second whose on-time instant is nearest sample `x`. */
        secondAt: (x) => startS + Math.round(x / FS + startFrac),
        bitsOf,
        next(len) {
            const re = new Float64Array(len);
            const im = new Float64Array(len);
            for (let i = 0; i < len; i++) { const [a, b] = sampleAt(n++); re[i] = a; im[i] = b; }
            return { re, im };
        },
    };
}

/** Run `seconds` of a synth through a decoder in uneven packets; every event, with status snapshots at each lock change. */
function run(dec, sy, seconds, seed = 7) {
    const R = rng(seed);
    const events = [];
    let left = seconds * FS;
    let lockedAt = null;
    while (left > 0) {
        const len = Math.min(left, 200 + Math.floor(R.u() * 2400));
        const { re, im } = sy.next(len);
        dec.process(re, im, len);
        left -= len;
        for (const e of dec.drain()) events.push(e);
        if (lockedAt === null && dec.status().state === 'locked') lockedAt = (seconds * FS - left) / FS;
    }
    return { events, lockedAt, status: dec.status() };
}

const ms2iso = (ms) => new Date(ms).toISOString();

/** The checks every locked run makes: 'time' names the right UTC second at an accurate edge, 'frame' the right minute. */
function checkTimes(sy, res, tolMs = 0.2) {
    const times = res.events.filter((e) => e.type === 'time');
    assert.ok(times.length > 0, 'no time events');
    let worst = 0;
    let sum = 0;
    for (const e of times) {
        const S = sy.secondAt(e.edge);
        assert.strictEqual(ms2iso(e.utcMs), ms2iso(S * 1000), `time event at sample ${e.edge.toFixed(1)}`);
        const errMs = ((e.edge - sy.edgeOf(S)) / FS) * 1000;
        worst = Math.max(worst, Math.abs(errMs));
        sum += errMs;
    }
    assert.ok(worst < tolMs, `worst edge error ${worst.toFixed(4)} ms`);
    const frames = res.events.filter((e) => e.type === 'frame');
    for (const f of frames) {
        const S = sy.secondAt(f.startEdge);
        assert.strictEqual(ms2iso(f.utcMs), ms2iso(S * 1000), 'frame names its own s0');
        assert.strictEqual(((S % 60) + 60) % 60, 0);
    }
    return { times: times.length, frames: frames.length, worstMs: worst, meanMs: sum / times.length };
}

const report = (name, r, extra = '') => console.log(`      ${name}: locked after ${r.lockedAt === null ? '—' : r.lockedAt.toFixed(1) + ' s'}`
    + (extra ? `, ${extra}` : ''));

// ── the format ──────────────────────────────────────────────────────────────

t('the chip sequence is PTB\'s, and the decoder\'s is the same', () => {
    assert.strictEqual(CHIPS.slice(0, 21).map((c) => (c < 0 ? 1 : 0)).join(''), '000001000110000100111');
    assert.deepStrictEqual(Array.from(buildChips()), CHIPS);
    assert.strictEqual(CHIPS.reduce((a, b) => a + b, 0), 0);
});

t('a sample rate that is not a multiple of 200 Hz is refused', () => {
    assert.throws(() => new Dcf77Decoder({ sampleRate: 12345 }), /multiple of 200/);
    assert.throws(() => new AllouisDecoder({ sampleRate: 11025 }), /multiple of 200/);
    assert.doesNotThrow(() => new Dcf77Decoder({ sampleRate: 12000 }));
    assert.strictEqual(new AllouisDecoder({}).status().station, 'ALS162');
    assert.strictEqual(new Dcf77Decoder({}).status().station, 'DCF77');
});

// ── DCF77 ───────────────────────────────────────────────────────────────────

t('DCF77, summer: locks, names each second\'s UTC, edges on the PM to well under 0.2 ms', () => {
    // 2026-07-14 13:57:20.3712 UTC: 15:58 CEST, crossing into 16:00.
    const startMs = Date.UTC(2026, 6, 14, 13, 57, 20) + 371.2;
    const sy = synth({ station: 'dcf77', startMs, carrierHz: 0.4, sigma: 0.05, seed: 11 });
    const dec = new Dcf77Decoder({ sampleRate: FS, carrierOffsetHz: 0, referenceNow: () => startMs });
    const res = run(dec, sy, 230);
    assert.strictEqual(res.status.state, 'locked', JSON.stringify(res.status));
    assert.strictEqual(res.status.detail.timing, 'PM');
    assert.ok(Math.abs(res.status.carrierOffsetHz - 0.4) < 0.1, `carrier ${res.status.carrierOffsetHz}`);
    const c = checkTimes(sy, res);
    assert.ok(c.frames >= 2);
    assert.ok(res.events.filter((e) => e.type === 'frame').every((f) => f.summer === true));
    // Every servable second, not only those the voter dates, is on time.
    const servable = res.events.filter((e) => e.type === 'second' && e.servable && e.measured);
    let worst = 0;
    for (const e of servable) worst = Math.max(worst, Math.abs(e.edge - sy.edgeOf(sy.secondAt(e.edge))) / FS * 1000);
    assert.ok(worst < 0.2, `servable worst ${worst} ms`);
    // Seconds are numbered as the air numbers them, once anchored.
    for (const e of res.events) if (e.type === 'second' && e.sof >= 0) {
        assert.strictEqual(e.sof, ((sy.secondAt(e.edge) % 60) + 60) % 60);
    }
    report('DCF77 summer', res, `${c.times} time events, edge error mean ${(c.meanMs * 1000).toFixed(1)} µs, worst ${(c.worstMs * 1000).toFixed(1)} µs, `
        + `PM SNR ${res.status.detail.pmSnrDb.toFixed(1)} dB, from ${res.status.detail.lastFrameFrom}`);
});

t('DCF77, winter across New Year in local time: CET is an hour, and the date is local', () => {
    // 2026-12-31 22:57:40.0815 UTC is 23:57 CET; the code names 2027-01-01 00:00 at s0 of 22:59 UTC.
    const startMs = Date.UTC(2026, 11, 31, 22, 57, 40) + 81.5;
    const sy = synth({ station: 'dcf77', startMs, carrierHz: -1.3, sigma: 0.1, seed: 5 });
    const dec = new Dcf77Decoder({ sampleRate: FS, carrierOffsetHz: -1.0 });
    const res = run(dec, sy, 200);
    assert.strictEqual(res.status.state, 'locked', JSON.stringify(res.status));
    const c = checkTimes(sy, res);
    const frames = res.events.filter((e) => e.type === 'frame');
    assert.ok(frames.some((f) => f.utcMs === Date.UTC(2026, 11, 31, 22, 59)), frames.map((f) => ms2iso(f.utcMs)).join(' '));
    assert.ok(frames.every((f) => f.summer === false));
    report('DCF77 winter', res, `edge error worst ${(c.worstMs * 1000).toFixed(1)} µs`);
});

t('DCF77: a minute whose parity fails is not decoded', () => {
    const startMs = Date.UTC(2026, 6, 14, 13, 57, 20) + 371.2;
    const bad = Date.UTC(2026, 6, 14, 13, 59);
    // Bit 21 (minute units, 1) flipped in AM and PM alike, parity left as it was.
    const sy = synth({ station: 'dcf77', startMs, sigma: 0.05, seed: 11, corrupt: (m0, b) => { if (m0 === bad) b[21] ^= 1; } });
    const dec = new Dcf77Decoder({ sampleRate: FS });
    const res = run(dec, sy, 230);
    const frames = res.events.filter((e) => e.type === 'frame').map((f) => f.utcMs);
    assert.ok(!frames.includes(bad), frames.map(ms2iso).join(' '));
    assert.ok(frames.includes(bad - 60000) && frames.includes(bad + 60000), frames.map(ms2iso).join(' '));
    // Whatever it certifies is still right.
    if (res.events.some((e) => e.type === 'time')) checkTimes(sy, res);
});

t('DCF77: noise alone never locks or decodes', () => {
    const sy = synth({ station: 'dcf77', startMs: Date.UTC(2026, 6, 14, 13, 57, 20), noiseOnly: true, sigma: 0.1, seed: 99 });
    const dec = new Dcf77Decoder({ sampleRate: FS });
    const res = run(dec, sy, 150);
    assert.notStrictEqual(res.status.state, 'locked');
    assert.strictEqual(res.events.filter((e) => e.type === 'frame' || e.type === 'time').length, 0);
});

t('DCF77: reset is as new, the sample count with it', () => {
    const startMs = Date.UTC(2026, 6, 14, 13, 57, 20) + 371.2;
    const sy = synth({ station: 'dcf77', startMs, sigma: 0.05, seed: 3 });
    const dec = new Dcf77Decoder({ sampleRate: FS });
    run(dec, sy, 5);
    dec.reset();
    const s = dec.status();
    assert.strictEqual(s.state, 'nosignal');
    assert.strictEqual(s.carrierOffsetHz, null);
    assert.strictEqual(dec.drain().length, 0);
    assert.strictEqual(dec.samples, 0);
});

// ── ALS162 ──────────────────────────────────────────────────────────────────

t('ALS162: locks, names each second\'s UTC, and reports the second 50.48 ms after the excursion starts', () => {
    const startMs = Date.UTC(2026, 6, 14, 13, 57, 20) + 371.2;
    const sy = synth({ station: 'als162', startMs, carrierHz: 0.6, sigma: 0.05, seed: 21 });
    const dec = new AllouisDecoder({ sampleRate: FS, referenceNow: () => startMs });
    const res = run(dec, sy, 200);
    assert.strictEqual(res.status.state, 'locked', JSON.stringify(res.status));
    const c = checkTimes(sy, res);
    assert.ok(c.frames >= 2);
    assert.strictEqual(res.status.detail.erasures, 0);
    let worst = 0;
    for (const e of res.events) {
        if (e.type !== 'second' || e.sof < 0 || !e.measured) continue;
        assert.strictEqual(e.sof, ((sy.secondAt(e.edge) % 60) + 60) % 60);
        worst = Math.max(worst, Math.abs(e.edge - sy.edgeOf(sy.secondAt(e.edge))) / FS * 1000);
    }
    assert.ok(worst < 0.2, `measured seconds worst ${worst} ms`);
    report('ALS162', res, `${c.times} time events, edge error mean ${(c.meanMs * 1000).toFixed(1)} µs, worst ${(c.worstMs * 1000).toFixed(1)} µs, `
        + `timing SNR ${res.status.detail.pmSnrDb.toFixed(1)} dB`);
});

t('ALS162, winter across New Year: CET, local date, and phase read the other way round', () => {
    const startMs = Date.UTC(2026, 11, 31, 22, 57, 40) + 81.5;
    // A conjugated receiver: the phase reads the other way, which acquisition must find.
    const sy = synth({ station: 'als162', startMs, carrierHz: -0.8, sigma: 0.1, seed: 8 });
    const conj = { next: (n) => { const x = sy.next(n); for (let i = 0; i < n; i++) x.im[i] = -x.im[i]; return x; } };
    const dec = new AllouisDecoder({ sampleRate: FS });
    const res = run(dec, conj, 200);
    assert.strictEqual(res.status.state, 'locked', JSON.stringify(res.status));
    assert.strictEqual(res.status.detail.polarity, -1);
    const c = checkTimes(sy, res);
    const frames = res.events.filter((e) => e.type === 'frame');
    assert.ok(frames.some((f) => f.utcMs === Date.UTC(2026, 11, 31, 22, 59)), frames.map((f) => ms2iso(f.utcMs)).join(' '));
    report('ALS162 winter', res, `edge error worst ${(c.worstMs * 1000).toFixed(1)} µs`);
});

t('ALS162: a minute with one bit unread is filled in by its checks; three unread are refused', () => {
    const startMs = Date.UTC(2026, 6, 14, 13, 57, 20) + 371.2;
    const one = synth({ station: 'als162', startMs, sigma: 0.05, seed: 21, erase: new Set([23]) });
    const r1 = run(new AllouisDecoder({ sampleRate: FS }), one, 200);
    assert.strictEqual(r1.status.state, 'locked', JSON.stringify(r1.status));
    assert.strictEqual(r1.status.detail.erasures, 1);
    const c = checkTimes(one, r1);
    assert.ok(c.frames >= 2);
    // The filled minute is worth less than a fully read one: 0.7 of its weakest read bit.
    assert.ok(r1.events.filter((e) => e.type === 'frame').every((f) => f.confidence <= 0.7 + 1e-6));

    const three = synth({ station: 'als162', startMs, sigma: 0.05, seed: 21, erase: new Set([23, 30, 40]) });
    const r3 = run(new AllouisDecoder({ sampleRate: FS }), three, 200);
    assert.strictEqual(r3.events.filter((e) => e.type === 'frame').length, 0);
    assert.notStrictEqual(r3.status.state, 'locked');
});

t('ALS162: noise alone never locks or decodes', () => {
    const sy = synth({ station: 'als162', startMs: Date.UTC(2026, 6, 14, 13, 57, 20), noiseOnly: true, sigma: 0.1, seed: 77 });
    const dec = new AllouisDecoder({ sampleRate: FS });
    const res = run(dec, sy, 150);
    assert.notStrictEqual(res.status.state, 'locked');
    assert.strictEqual(res.events.filter((e) => e.type === 'frame' || e.type === 'time').length, 0);
});

console.log(`${pass} passed`);
