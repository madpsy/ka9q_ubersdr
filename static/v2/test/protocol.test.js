// Exercises the wire-format decoders against frames built exactly the way
// user_spectrum_websocket.go and websocket.go build them.

const assert = require('assert');
const { SpectrumConnection } = require('./.build/spectrum.cjs');
const { AudioConnection } = require('./.build/audio.cjs');

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
