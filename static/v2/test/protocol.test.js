// Exercises the wire-format decoders against frames built exactly the way
// user_spectrum_websocket.go and websocket.go build them.

const assert = require('assert');
const { SpectrumConnection } = require('./.build/spectrum.cjs');
const { AudioConnection } = require('./.build/audio.cjs');
const {
    SQUELCH_MIN, SQUELCH_MAX, SQUELCH_SENTINEL, squelchEnabled, squelchThreshold,
} = require('./.build/constants.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- helpers mirroring the Go packet builders ------------------------------
function specHeader(flags, freq) {
    const buf = new ArrayBuffer(22);
    const v = new DataView(buf);
    v.setUint8(0, 0x53); v.setUint8(1, 0x50); v.setUint8(2, 0x45); v.setUint8(3, 0x43);
    v.setUint8(4, 0x01);
    v.setUint8(5, flags);
    v.setBigUint64(6, BigInt(1700000000000), true);
    v.setBigUint64(14, BigInt(freq), true);
    return buf;
}
function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
    return out.buffer;
}

function fullFloat32(values, freq) {
    const body = new ArrayBuffer(values.length * 4);
    const v = new DataView(body);
    values.forEach((x, i) => v.setFloat32(i * 4, x, true));
    return concat(specHeader(0x01, freq), body);
}
function deltaFloat32(changes, freq) {
    const body = new ArrayBuffer(2 + changes.length * 6);
    const v = new DataView(body);
    v.setUint16(0, changes.length, true);
    changes.forEach(([idx, val], i) => {
        v.setUint16(2 + i * 6, idx, true);
        v.setFloat32(2 + i * 6 + 2, val, true);
    });
    return concat(specHeader(0x02, freq), body);
}
function fullUint8(values, freq) {
    return concat(specHeader(0x03, freq), new Uint8Array(values).buffer);
}
function deltaUint8(changes, freq) {
    const body = new ArrayBuffer(2 + changes.length * 3);
    const v = new DataView(body);
    v.setUint16(0, changes.length, true);
    changes.forEach(([idx, val], i) => {
        v.setUint16(2 + i * 3, idx, true);
        v.setUint8(2 + i * 3 + 2, val);
    });
    return concat(specHeader(0x04, freq), body);
}

// --- spectrum --------------------------------------------------------------
function capture(conn) {
    const frames = [];
    conn.on('frame', (f) => frames.push(f));
    return frames;
}

// Emitted frames are in ascending frequency order, so the raw FFT halves
// [DC..+Nyq | -Nyq..DC] arrive swapped. Verified against the live 25 MHz
// reference on m9psy: without the swap the carrier reads half a span low.
const unwrap = (a) => {
    const half = a.length >> 1;
    return [...a.slice(half), ...a.slice(0, half)];
};

t('float32 full frame decodes', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    const raw = [-100, -80.5, -60.25, -40];
    c._onSpectrum(new DataView(fullFloat32(raw, 7100000)));
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual([...frames[0].bins], unwrap(raw));
    assert.strictEqual(frames[0].frequency, 7100000);
});

t('FFT halves are swapped into ascending frequency order', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    // A carrier at raw bin 0 is DC — the centre of the span — so it must come
    // out at the middle bin, not the first one.
    const raw = [0, -120, -120, -120, -120, -120, -120, -120];
    c._onSpectrum(new DataView(fullFloat32(raw, 25000000)));
    const bins = [...frames[0].bins];
    assert.strictEqual(bins.indexOf(0), 4, `peak landed at ${bins.indexOf(0)}, want 4`);
});

t('odd bin counts rotate without dropping a bin', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-1, -2, -3, -4, -5], 7100000)));
    // rotate left by floor(5/2) = 2
    assert.deepStrictEqual([...frames[0].bins], [-3, -4, -5, -1, -2]);
});

t('float32 delta applies in raw bin order, then unwraps', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-100, -100, -100, -100], 7100000)));
    // The server indexes deltas against raw order, so raw bin 1 must be the
    // one that changes — it surfaces at output position 3.
    c._onSpectrum(new DataView(deltaFloat32([[1, -42.5]], 7100000)));
    assert.deepStrictEqual([...frames[1].bins], [-100, -100, -100, -42.5]);
});

t('delta before any full frame is ignored, not crashed', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(deltaFloat32([[0, -10]], 7100000)));
    assert.strictEqual(frames.length, 0);
});

t('uint8 full frame maps 0->-256 and 255->-1', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullUint8([0, 128, 255, 64], 7100000)));
    assert.deepStrictEqual([...frames[0].bins], unwrap([-256, -128, -1, -192]));
});

t('uint8 delta uses 3-byte entries', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullUint8([100, 100, 100, 100], 7100000)));
    c._onSpectrum(new DataView(deltaUint8([[2, 200]], 7100000)));
    // raw bin 2 -> output position 0
    assert.deepStrictEqual([...frames[1].bins], [-56, -156, -156, -156]);
});

t('accumulators stay in raw order across frames', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-10, -20, -30, -40], 7100000)));
    c._onSpectrum(new DataView(deltaFloat32([[0, -99]], 7100000)));
    c._onSpectrum(new DataView(deltaFloat32([[3, -88]], 7100000)));
    // Unwrapping must not feed back into the accumulator: raw is now
    // [-99,-20,-30,-88], which surfaces as [-30,-88,-99,-20].
    assert.deepStrictEqual([...frames[2].bins], [-30, -88, -99, -20]);
});

t('unknown protocol version is dropped', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    const buf = fullFloat32([-100], 7100000);
    new DataView(buf).setUint8(4, 0x02);
    c._onSpectrum(new DataView(buf));
    assert.strictEqual(frames.length, 0);
});

t('config message updates geometry and clears stale deltas', () => {
    const c = new SpectrumConnection();
    let cfg = null;
    c.on('config', (x) => { cfg = x; });
    c._onSpectrum(new DataView(fullFloat32([-100, -100], 7100000)));
    c._onControl({ type: 'config', centerFreq: 14200000, binCount: 4, binBandwidth: 25, defaultBinCount: 8, defaultBinBandwidth: 50 });
    assert.strictEqual(cfg.span, 100);
    assert.strictEqual(c._float, null, 'bin-count change must drop the delta accumulator');
});

// --- zoom stepping ---------------------------------------------------------
//
// The server quantises binBandwidth onto a fixed ladder before applying it
// (user_spectrum_websocket.go). A zoom step gentler than the ladder's spacing
// rounds back to the rung it started on, so the view never changes. These tests
// exist to stop the step size drifting back to something "smoother".

// Mirrors the server's safe-bin_bw rounding.
function serverLadder(binBW) {
    if (binBW < 0.75) return 0.5;
    if (binBW < 1.5) return 1;
    if (binBW < 3) return 2;
    if (binBW < 7) return 5;
    if (binBW < 15) return 10;
    if (binBW < 35) return 20;
    if (binBW < 75) return 50;
    if (binBW < 150) return 100;
    if (binBW < 250) return 200;
    if (binBW < 400) return 300;
    if (binBW < 750) return 500;
    if (binBW < 1500) return 1000;
    if (binBW < 3500) return 2000;
    if (binBW < 7500) return 5000;
    return binBW;   // pass-through for full-bandwidth views
}

// The only bin bandwidths a session can actually be sitting at — the ladder is
// not a power-of-two series, so stepping has to be checked from these, not from
// arbitrary values.
const RUNGS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000];

t('halving moves to a lower rung from every reachable rung', () => {
    for (const bw of RUNGS.slice(1)) {
        const landed = serverLadder(bw / 2);
        assert.ok(landed < bw, `halving ${bw} landed on ${landed}`);
    }
});

t('doubling moves to a higher rung from every reachable rung', () => {
    for (const bw of RUNGS) {
        const landed = serverLadder(bw * 2);
        assert.ok(landed > bw, `doubling ${bw} landed on ${landed}`);
    }
});

t('a gentle 1.25x step stalls — this is why the step is 2x', () => {
    // Reproduces the original bug: from the 5000 Hz/bin rung neither direction
    // moves, so the spectrum appears frozen at three or four zoom levels.
    assert.strictEqual(serverLadder(5000 * 1.25), 5000);
    assert.strictEqual(serverLadder(5000 * 0.8), 5000);
});

t('UI zoom floor is a span, independent of bin count', () => {
    const c = new SpectrumConnection();
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 1024, binBandwidth: 29296.875, defaultBinCount: 1024, defaultBinBandwidth: 29296.875 });
    assert.strictEqual(c.minBinBandwidthForUI() * 1024, 10240);
    const d = new SpectrumConnection();
    d._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375, defaultBinCount: 2048, defaultBinBandwidth: 14648.4375 });
    assert.strictEqual(d.minBinBandwidthForUI() * 2048, 10240);
});

t('full-span bin bandwidth survives a missing server default', () => {
    const c = new SpectrumConnection();
    // Server that omits defaultBinBandwidth: must still yield the full-view
    // value, or zoom-out clamps to wherever the user happens to be.
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375 });
    assert.strictEqual(c.fullSpanBinBandwidth(), 14648.4375);
    assert.ok(c.fullSpanBinBandwidth() * 2048 > 29e6);
});

// --- squelch ---------------------------------------------------------------
//
// Squelch is the server-side audio gate. The slider's floor doubles as "off",
// which is what v1 does — a separate enable flag can disagree with the value.

t('slider floor means off, and sends the sentinel', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN), false);
    // Anything at or below the floor is off, so a stale stored value cannot
    // resurrect as a live threshold.
    assert.strictEqual(squelchThreshold(SQUELCH_MIN - 10), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(0), false);
});

t('above the floor the slider value is the threshold in dB SNR', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN + 0.5), SQUELCH_MIN + 0.5);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN + 0.5), true);
    assert.strictEqual(squelchThreshold(SQUELCH_MAX), SQUELCH_MAX);
});

t('setAudioGate emits the server field names and records for reconnect', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };

    a.setAudioGate({ minSnr: 30 });
    assert.deepStrictEqual(sent[0], { type: 'set_audio_gate', min_snr: 30 });
    assert.deepStrictEqual(a.lastGate, { minSnr: 30, minPower: undefined });

    a.setAudioGate({ minSnr: SQUELCH_SENTINEL });
    assert.deepStrictEqual(sent[1], { type: 'set_audio_gate', min_snr: -999 });
});

t('setAudioGate with no thresholds is not sent', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    // The server rejects a gate message carrying neither field.
    assert.strictEqual(a.setAudioGate({}), false);
    assert.strictEqual(sent.length, 0);
});

// --- audio -----------------------------------------------------------------
function audioPacket({ sampleRate = 12000, channels = 1, power = -55.5, noise = -95.25, payload = [1, 2, 3, 4] }) {
    const buf = new ArrayBuffer(21 + payload.length);
    const v = new DataView(buf);
    v.setBigUint64(0, BigInt(Date.now()) * 1000000n, true);
    v.setUint32(8, sampleRate, true);
    v.setUint8(12, channels);
    v.setFloat32(13, power, true);
    v.setFloat32(17, noise, true);
    new Uint8Array(buf, 21).set(payload);
    return buf;
}

t('v2 audio header parses and strips the 21-byte prefix', () => {
    const a = new AudioConnection();
    let opus = null; let quality = null;
    a.on('opus', (x) => { opus = x; });
    a.on('quality', (x) => { quality = x; });
    a._onBinary(audioPacket({ payload: [9, 8, 7] }));
    assert.strictEqual(opus.sampleRate, 12000);
    assert.strictEqual(opus.channels, 1);
    assert.deepStrictEqual([...opus.data], [9, 8, 7]);
    assert.ok(Math.abs(quality.basebandPower + 55.5) < 0.01);
    assert.ok(Math.abs(quality.noiseDensity + 95.25) < 0.01);
});

t('-999 sentinels become null rather than a fake -999 dB reading', () => {
    const a = new AudioConnection();
    let quality = null;
    a.on('quality', (x) => { quality = x; });
    a._onBinary(audioPacket({ power: -999, noise: -999 }));
    assert.strictEqual(quality.basebandPower, null);
    assert.strictEqual(quality.noiseDensity, null);
});

t('header-only packet is ignored', () => {
    const a = new AudioConnection();
    let called = false;
    a.on('opus', () => { called = true; });
    a._onBinary(new ArrayBuffer(21));
    assert.strictEqual(called, false);
});

t('JSON PCM fallback deinterleaves stereo', () => {
    const a = new AudioConnection();
    let pcm = null;
    a.on('pcm', (x) => { pcm = x; });
    const samples = Int16Array.from([1000, -1000, 2000, -2000]);   // L R L R
    const bytes = new Uint8Array(samples.buffer);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    global.atob = (s) => s;   // the module's atob receives the raw string back
    a._onMessage({ data: JSON.stringify({ type: 'audio', data: bin, sampleRate: 24000, channels: 2 }) });
    assert.strictEqual(pcm.channels, 2);
    assert.ok(Math.abs(pcm.planes[0][0] - 1000 / 32768) < 1e-6);
    assert.ok(Math.abs(pcm.planes[1][0] + 1000 / 32768) < 1e-6);
});

console.log(process.exitCode ? '\nPROTOCOL TESTS FAILED' : `\nall ${pass} protocol tests passed`);
