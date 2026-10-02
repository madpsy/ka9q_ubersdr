// The WWV/WWVH time-code decoder (timecode/wwv.js), against a synthesised
// broadcast: carrier, 100 Hz BCD subcarrier, seconds ticks, minute tones and
// programme tones, per NIST SP 432, with seeded Gaussian noise.

const assert = require('assert');
const { WwvDecoder, WWV_MAP } = require('./.build/timecodewwv.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const FS = 12000;

// ── the synthesiser ─────────────────────────────────────────────────────────

/** mulberry32, and Box–Muller on it: noise that is the same every run. */
function gaussian(seed) {
    let a = seed >>> 0;
    const u = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return () => {
        if (spare !== null) { const s = spare; spare = null; return s; }
        const r = Math.sqrt(-2 * Math.log(u() + 1e-300));
        const th = 2 * Math.PI * u();
        spare = r * Math.sin(th);
        return r * Math.cos(th);
    };
}

/**
 * The 60 symbols (0 zero, 1 one, 2 marker, -1 the s0 hole) of the minute
 * starting at Unix ms `minuteMs`, laid out as NIST SP 432 has it, with plain
 * BCD — independent of the decoder's own field map, which is checked against it.
 */
function wwvMinute(minuteMs, { dut1Tenths = 0, leap = false, dst = false } = {}) {
    const d = new Date(minuteMs);
    const y2 = d.getUTCFullYear() % 100;
    const doy = Math.floor((minuteMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    const sym = new Array(60).fill(0);
    sym[0] = -1;
    for (const s of [9, 19, 29, 39, 49, 59]) sym[s] = 2;
    const put = (secs, v) => secs.forEach((s, i) => { sym[s] = (v >> i) & 1; });
    put([10, 11, 12, 13], d.getUTCMinutes() % 10);
    put([15, 16, 17], Math.floor(d.getUTCMinutes() / 10));
    put([20, 21, 22, 23], d.getUTCHours() % 10);
    put([25, 26], Math.floor(d.getUTCHours() / 10));
    put([30, 31, 32, 33], doy % 10);
    put([35, 36, 37, 38], Math.floor(doy / 10) % 10);
    put([40, 41], Math.floor(doy / 100));
    put([4, 5, 6, 7], y2 % 10);
    put([51, 52, 53, 54], Math.floor(y2 / 10));
    sym[2] = dst ? 1 : 0;
    sym[55] = dst ? 1 : 0;
    sym[3] = leap ? 1 : 0;
    sym[50] = dut1Tenths >= 0 ? 1 : 0;
    put([56, 57, 58], Math.abs(dut1Tenths));
    return sym;
}

/**
 * A WWV (or WWVH) broadcast as 12 kHz IQ, from `startUtcMs` (Unix ms, any
 * fraction: sample n is at startUtcMs + n/fs seconds). The carrier at
 * `offsetHz`, AM'd by: the BCD pulses on 100 Hz at 18% (from +30 ms; 200 / 500
 * / 800 ms; none at s0), the 5 ms tick at 100% (none at 29 and 59; at s0 the
 * 800 ms minute tone, 1500 Hz on the hour), and a 500/600 Hz programme tone at
 * 50% outside the protected zone. `next(n)` gives the next n samples.
 */
function synth({
    startUtcMs, offsetHz = 0, station = 'wwv', noise = 0.25, seed = 1, phase0 = 0.7,
    bcdDepth = 0.18, tickDepth = 1.0, toneDepth = 0.5, tones = true, fs = FS,
}) {
    const tickHz = station === 'wwvh' ? 1200 : 1000;
    const tickLen = 0.005;
    const rnd = gaussian(seed);
    let n = 0;
    let cacheMinute = null;
    let cacheSym = null;
    const symbolsOf = (minuteMs) => {
        if (minuteMs !== cacheMinute) { cacheMinute = minuteMs; cacheSym = wwvMinute(minuteMs); }
        return cacheSym;
    };
    const w = 2 * Math.PI * offsetHz / fs;
    return {
        /** The input sample index at which UTC second `sMs` (whole-second Unix ms) begins. */
        indexOf: (sMs) => ((sMs - startUtcMs) * fs) / 1000,
        /** The UTC (Unix ms, fractional) at input sample index i. */
        utcAt: (i) => startUtcMs + (i * 1000) / fs,
        next(count) {
            const re = new Float64Array(count);
            const im = new Float64Array(count);
            for (let k = 0; k < count; k++, n++) {
                const tMs = startUtcMs + (n * 1000) / fs;
                const S = Math.floor(tMs / 1000);
                const u = (tMs - S * 1000) / 1000;          // seconds into the second
                const s = ((S % 60) + 60) % 60;
                const minuteMs = (S - s) * 1000;
                const sym = symbolsOf(minuteMs);
                let m = 0;
                if (s !== 0) {
                    const dur = [0.2, 0.5, 0.8][sym[s]];
                    if (u >= 0.030 && u < dur) m += bcdDepth * Math.sin(2 * Math.PI * 100 * u);
                    if (s !== 29 && s !== 59 && u < tickLen) m += tickDepth * Math.sin(2 * Math.PI * tickHz * u);
                    if (tones && s <= 44 && u >= 0.030 && u < 0.990) {
                        const minute = Math.floor(minuteMs / 60000);
                        const toneHz = (minute % 2 === 0) === (station === 'wwv') ? 500 : 600;
                        m += toneDepth * Math.sin(2 * Math.PI * toneHz * u);
                    }
                } else if (u < 0.8) {
                    const hour = new Date(minuteMs).getUTCMinutes() === 0;
                    m += tickDepth * Math.sin(2 * Math.PI * (hour ? 1500 : tickHz) * u);
                }
                const ph = w * n + phase0;
                re[k] = (1 + m) * Math.cos(ph) + noise * rnd();
                im[k] = (1 + m) * Math.sin(ph) + noise * rnd();
            }
            return { re, im };
        },
    };
}

/** Run `seconds` of a synth through a decoder: the events, oldest first. */
function run(dec, sig, seconds, chunk = 1200) {
    const events = [];
    const total = Math.round(seconds * FS);
    for (let done = 0; done < total; done += chunk) {
        const n = Math.min(chunk, total - done);
        const { re, im } = sig.next(n);
        dec.process(re, im, n);
        for (const e of dec.drain()) events.push(e);
    }
    return events;
}

/** How far each served edge after `fromIndex` is from its true second, ms. */
function edgeErrors(events, sig, fromIndex = 0) {
    const errs = [];
    for (const e of events) {
        if (e.type !== 'second' || !e.servable || !e.measured || e.edge < fromIndex) continue;
        const S = Math.round(sig.utcAt(e.edge) / 1000) * 1000;
        errs.push(((e.edge - sig.indexOf(S)) * 1000) / FS);
    }
    return errs;
}

const stats = (a) => {
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const max = a.reduce((x, y) => Math.max(x, Math.abs(y)), 0);
    const rms = Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
    return { n: a.length, mean, max, rms };
};

const fmt = (ms) => new Date(ms).toISOString();

// 2026-10-02 14:37:00 UTC, started 41.2345678 s before it: no edge on a whole sample.
const MINUTE = Date.UTC(2026, 9, 2, 14, 37, 0);
const START = MINUTE - 41234.5678;

// ── tests ───────────────────────────────────────────────────────────────────

t('the synthesiser\'s layout is the decoder\'s field map (NIST SP 432)', () => {
    const sym = wwvMinute(Date.UTC(2026, 9, 2, 14, 37, 0));
    const field = (map) => map.reduce((v, [sec, w]) => v + (sym[sec] === 1 ? w : 0), 0);
    assert.deepStrictEqual(
        [field(WWV_MAP.minute), field(WWV_MAP.hour), field(WWV_MAP.doy), field(WWV_MAP.year2)],
        [37, 14, 275, 26],
    );
});

t('a sample rate that is not a multiple of 200 Hz is refused', () => {
    assert.throws(() => new WwvDecoder({ sampleRate: 11025 }), /multiple of 200/);
    assert.throws(() => new WwvDecoder({ sampleRate: 0 }), /multiple of 200/);
    assert.doesNotThrow(() => new WwvDecoder({ sampleRate: 24000 }));
});

t('the station tag can be pinned, and 20 / 25 MHz pin WWV', () => {
    assert.strictEqual(new WwvDecoder().status().station, null);
    assert.strictEqual(new WwvDecoder({ station: 'wwvh' }).status().station, 'WWVH');
    assert.strictEqual(new WwvDecoder({ dialHz: 25e6 }).status().station, 'WWV');
    assert.strictEqual(new WwvDecoder({ dialHz: 19999990, carrierOffsetHz: 10 }).status().station, 'WWV');
    assert.strictEqual(new WwvDecoder({ dialHz: 10e6 }).status().station, null);
    const d = new WwvDecoder({ dialHz: 20e6 });
    d.reset();
    assert.strictEqual(d.status().station, 'WWV');
    assert.strictEqual(d.status().state, 'nosignal');
});

const report = {};

t('WWV, clean: locks, dates the edge exactly, and serves edges within 0.2 ms', () => {
    const sig = synth({ startUtcMs: START, offsetHz: 3.7, noise: 0.25, seed: 7 });
    const dec = new WwvDecoder({ sampleRate: FS, carrierOffsetHz: 0, referenceNow: () => MINUTE });
    const ev = run(dec, sig, 300);
    const times = ev.filter((e) => e.type === 'time');
    assert.ok(times.length >= 1, 'no time event in 5 minutes; status ' + JSON.stringify(dec.status()));
    const first = times[0];
    const lockSec = first.edge / FS;
    report.lockSec = lockSec;
    assert.ok(lockSec < 240, `locked only after ${lockSec.toFixed(1)} s`);
    for (const tm of times) {
        const truth = sig.utcAt(tm.edge);
        assert.ok(Math.abs(truth - tm.utcMs) < 0.2, `time ${fmt(tm.utcMs)} at an edge that is ${fmt(truth)}`);
        assert.ok(tm.quality > 0 && tm.quality <= 1);
    }
    const st = dec.status();
    assert.strictEqual(st.state, 'locked');
    assert.strictEqual(st.station, 'WWV');
    assert.strictEqual(st.refusal, null);
    assert.ok(st.detail.tickLocked);
    assert.ok(Math.abs(st.carrierOffsetHz - 3.7) < 0.2, 'carrier offset ' + st.carrierOffsetHz);
    assert.ok(st.detail.tickSnrDb > 14, 'tick SNR ' + st.detail.tickSnrDb);

    // Frames: the minutes as sent.
    const frames = ev.filter((e) => e.type === 'frame' && e.utcMs != null);
    assert.ok(frames.length >= 2);
    for (const f of frames) {
        assert.strictEqual(f.utcMs % 60000, 0);
        assert.ok(Math.abs(sig.utcAt(f.startEdge) - f.utcMs) < 0.2, `frame ${fmt(f.utcMs)} starts at ${fmt(sig.utcAt(f.startEdge))}`);
        assert.strictEqual(f.dut1Tenths, 0);
        assert.strictEqual(f.leapPending, false);
    }

    // Seconds: framed, symbols right once anchored.
    let wrong = 0; let framed = 0;
    for (const e of ev) {
        if (e.type !== 'second' || e.sof < 0) continue;
        const S = Math.round(sig.utcAt(e.edge) / 1000) * 1000;
        assert.strictEqual(e.sof, ((S / 1000) % 60 + 60) % 60, 'second of frame');
        const want = wwvMinute(S - e.sof * 1000)[e.sof];
        if (want >= 0 && ['zero', 'one', 'marker'][want] !== e.symbol) wrong++;
        framed++;
    }
    assert.ok(framed > 60 && wrong <= 1, `${wrong} of ${framed} framed seconds misread`);

    const errs = edgeErrors(ev, sig, first.edge - 60 * FS);
    const s = stats(errs);
    report.wwv = s;
    assert.ok(s.n > 100, 'served edges ' + s.n);
    assert.ok(s.max < 0.2, `served edge error up to ${s.max.toFixed(4)} ms`);
});

// Without noise the tick's apex is the start of the burst to a microsecond:
// nothing in the chain delays it, so nothing is calibrated out.
t('WWV, near noiseless: served edges on the true second to 5 µs', () => {
    const sig = synth({ startUtcMs: START - 0.0417, offsetHz: 3.7, noise: 0.001, seed: 2 });
    const dec = new WwvDecoder({ sampleRate: FS });
    const s = stats(edgeErrors(run(dec, sig, 60), sig));
    report.exact = s;
    assert.ok(s.n > 30 && s.max < 0.005, JSON.stringify(s));
});

t('WWV, noisier (≈ 42 dB-Hz carrier): still locks and serves edges within 0.2 ms', () => {
    const start = MINUTE - 12345.678;
    const sig = synth({ startUtcMs: start, offsetHz: -21.3, noise: 0.6, seed: 11, phase0: 2.1 });
    const dec = new WwvDecoder({ sampleRate: FS, carrierOffsetHz: -20 });
    const ev = run(dec, sig, 300);
    const times = ev.filter((e) => e.type === 'time');
    assert.ok(times.length >= 1, 'no time event; status ' + JSON.stringify(dec.status()));
    report.noisyLockSec = times[0].edge / FS;
    for (const tm of times) assert.ok(Math.abs(sig.utcAt(tm.edge) - tm.utcMs) < 0.2);
    assert.ok(Math.abs(dec.status().carrierOffsetHz - -1.3) < 0.2);
    const s = stats(edgeErrors(ev, sig, times[0].edge - 60 * FS));
    report.noisy = s;
    assert.ok(s.n > 60 && s.max < 0.2, JSON.stringify(s));
});

// Weaker still the BCD reads are right but the s0 hole no longer stands below
// every binary 0 (its own noise sets the phase it is projected on, as in the
// C++), so the minute does not anchor — yet the tick, averaged coherently,
// times the second all the same.
t('WWV, weak (≈ 36 dB-Hz): undated, but the tick still serves edges, to 0.15 ms rms', () => {
    const start = MINUTE - 3210.9876;
    const sig = synth({ startUtcMs: start, offsetHz: 8.2, noise: 1.2, seed: 13, phase0: 4.0 });
    const dec = new WwvDecoder({ sampleRate: FS });
    const ev = run(dec, sig, 90);
    assert.ok(dec.status().detail.tickLocked);
    const s = stats(edgeErrors(ev, sig));
    report.weak = s;
    assert.ok(s.n > 40 && s.rms < 0.15 && s.max < 0.5, JSON.stringify(s));
});

t('WWVH: tagged by its 1200 Hz tick, timed by it, and dated', () => {
    const start = MINUTE - 7777.7777;
    const sig = synth({ startUtcMs: start, offsetHz: 0, station: 'wwvh', noise: 0.25, seed: 23 });
    const dec = new WwvDecoder({ sampleRate: FS });
    const ev = run(dec, sig, 270);
    const st = dec.status();
    assert.strictEqual(st.station, 'WWVH');
    const times = ev.filter((e) => e.type === 'time');
    assert.ok(times.length >= 1, 'no time event; status ' + JSON.stringify(st));
    report.wwvhLockSec = times[0].edge / FS;
    for (const tm of times) assert.ok(Math.abs(sig.utcAt(tm.edge) - tm.utcMs) < 0.2);
    assert.ok(times[times.length - 1].station === 'WWVH');
    const tagAt = ev.findIndex((e) => e.type === 'time');
    const s = stats(edgeErrors(ev.slice(tagAt), sig));
    report.wwvh = s;
    assert.ok(s.n > 30 && s.max < 0.2, JSON.stringify(s));
});

t('WWV is not tagged WWVH, and a pinned tag is never judged', () => {
    const sig = synth({ startUtcMs: START, station: 'wwv', noise: 0.25, seed: 5 });
    const pinned = new WwvDecoder({ station: 'wwvh' });
    const auto = new WwvDecoder();
    const total = 80 * FS;
    for (let done = 0; done < total; done += 1200) {
        const { re, im } = sig.next(1200);
        pinned.process(re, im, 1200);
        auto.process(re, im, 1200);
    }
    assert.strictEqual(auto.status().station, 'WWV');
    assert.strictEqual(pinned.status().station, 'WWVH');
});

t('pure noise: no lock, no time, nothing served', () => {
    const rnd = gaussian(99);
    const dec = new WwvDecoder({ sampleRate: FS });
    const ev = [];
    for (let done = 0; done < 150 * FS; done += 1200) {
        const re = new Float64Array(1200);
        const im = new Float64Array(1200);
        for (let k = 0; k < 1200; k++) { re[k] = rnd(); im[k] = rnd(); }
        dec.process(re, im, 1200);
        ev.push(...dec.drain());
    }
    const st = dec.status();
    assert.ok(st.state === 'nosignal' || st.state === 'acquiring', st.state);
    assert.strictEqual(ev.filter((e) => e.type === 'time').length, 0);
    assert.strictEqual(ev.filter((e) => e.type === 'second' && e.servable).length, 0);
    assert.strictEqual(st.station, null);
});

t('reset starts over: the sample count and the events restart', () => {
    const sig = synth({ startUtcMs: START, seed: 3 });
    const dec = new WwvDecoder();
    run(dec, sig, 20);
    assert.notStrictEqual(dec.status().state, 'nosignal');
    dec.reset();
    assert.deepStrictEqual(dec.drain(), []);
    const st = dec.status();
    assert.strictEqual(st.state, 'nosignal');
    assert.strictEqual(st.frames, 0);
    assert.strictEqual(st.carrierOffsetHz, null);
});

const f3 = (x) => (x == null ? '-' : x.toFixed(4));
const line = (name, s) => s && console.log(`      ${name}: ${s.n} served edges, mean ${f3(s.mean)} ms, rms ${f3(s.rms)} ms, max |err| ${f3(s.max)} ms`);
console.log(`      lock (first time event): clean ${report.lockSec?.toFixed(1)} s, noisy ${report.noisyLockSec?.toFixed(1)} s, WWVH ${report.wwvhLockSec?.toFixed(1)} s`);
line('WWV near noiseless', report.exact);
line('WWV clean', report.wwv);
line('WWV noisy', report.noisy);
line('WWV weak', report.weak);
line('WWVH', report.wwvh);
console.log(`${pass} passed`);
