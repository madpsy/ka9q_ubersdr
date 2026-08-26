// The lossless audio path: what a pcm-zstd packet says it is.
//
// This is the only decoder IQ ever uses — the server forces the format for it —
// and the sample rate and channel count it reads out of the header are what the
// player, the recorder and the readouts all go on. A wrong channel count here
// is not an error anywhere: the samples de-interleave into the wrong number of
// planes and play as noise, or as one channel at half speed.
//
// Frames are built with the real zstd CLI rather than a stub, because the whole
// packet — header included — is compressed, so a test that skipped that would
// not be exercising the same bytes the server sends. See pcm_binary.go, which
// writes this layout, and pcm-stream.js, which reads it.

const assert = require('assert');
const { execFileSync } = require('child_process');
const { PCMStreamDecoder, isZstdFrame } = require('./.build/pcmstream.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const zstd = (buf) => execFileSync('zstd', ['-q', '-c'], { input: buf, maxBuffer: 1 << 24 });

// A full header, v3: 37 bytes, then big-endian int16 samples.
function fullFrame({ sampleRate, channels, samples = [], power = -55.5, noise = -95.25 }) {
    const head = Buffer.alloc(37);
    head.writeUInt16LE(0x5043, 0);      // "PC"
    head.writeUInt8(3, 2);              // version 3
    head.writeUInt8(2, 3);              // format: zstd
    head.writeBigUInt64LE(0n, 4);       // gps time
    head.writeBigUInt64LE(0n, 12);      // wall clock
    head.writeUInt32LE(sampleRate, 20);
    head.writeUInt8(channels, 24);
    head.writeFloatLE(power, 25);
    head.writeFloatLE(noise, 29);
    return zstd(Buffer.concat([head, pcm(samples)]));
}

// A minimal header: 13 bytes, and "metadata as before".
function minimalFrame(samples = []) {
    const head = Buffer.alloc(13);
    head.writeUInt16LE(0x504D, 0);      // "PM"
    head.writeUInt8(3, 2);
    head.writeBigUInt64LE(0n, 3);
    return zstd(Buffer.concat([head, pcm(samples)]));
}

function pcm(samples) {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => b.writeInt16BE(s, i * 2));
    return b;
}

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// --- what the header declares ------------------------------------------------

t('a mono SSB packet reads as 12 kHz, one plane', () => {
    const d = new PCMStreamDecoder();
    const f = d.decode(ab(fullFrame({ sampleRate: 12000, channels: 1, samples: [16384, -16384] })));
    assert.strictEqual(f.sampleRate, 12000);
    assert.strictEqual(f.channels, 1);
    assert.strictEqual(f.planes.length, 1);
    assert.strictEqual(f.planes[0].length, 2);
});

t('an IQ packet reads as 12 kHz, two planes, I and Q not transposed', () => {
    const d = new PCMStreamDecoder();
    // Interleaved I,Q,I,Q — asymmetric so a transposition cannot pass.
    const f = d.decode(ab(fullFrame({
        sampleRate: 12000, channels: 2, samples: [32767, 0, -32768, 0],
    })));
    assert.strictEqual(f.sampleRate, 12000);
    assert.strictEqual(f.channels, 2);
    assert.strictEqual(f.planes.length, 2);
    assert.ok(Math.abs(f.planes[0][0] - 1) < 0.001, 'I of frame 0');
    assert.strictEqual(f.planes[1][0], 0, 'Q of frame 0');
    assert.strictEqual(f.planes[0][1], -1, 'I of frame 1');
    assert.strictEqual(f.planes[1][1], 0, 'Q of frame 1');
});

t('samples are read big-endian, as radiod sends them', () => {
    // 0x0100 big-endian is 256; read the host's way it would be 1.
    const d = new PCMStreamDecoder();
    const f = d.decode(ab(fullFrame({ sampleRate: 12000, channels: 1, samples: [256] })));
    assert.ok(Math.abs(f.planes[0][0] - 256 / 32768) < 1e-6);
});

// --- state across packets ----------------------------------------------------

t('a minimal header keeps the rate and channels the last full one set', () => {
    const d = new PCMStreamDecoder();
    d.decode(ab(fullFrame({ sampleRate: 10000, channels: 2, samples: [0, 0] })));
    const f = d.decode(ab(minimalFrame([100, 200])));
    assert.strictEqual(f.sampleRate, 10000);
    assert.strictEqual(f.channels, 2);
    assert.strictEqual(f.planes.length, 2);
    // No signal quality on a minimal header — the caller must hold the last
    // reading rather than blank the meters every other packet.
    assert.strictEqual(f.signal, null);
});

t('a mode change is a full header, and it replaces the old figures', () => {
    // The server forces one whenever the rate or channel count changes, which is
    // how a client learns it has gone from IQ back to audio. Reading the new
    // packets with the old channel count is the failure this prevents.
    const d = new PCMStreamDecoder();
    d.decode(ab(fullFrame({ sampleRate: 10000, channels: 2, samples: [0, 0] })));
    const f = d.decode(ab(fullFrame({ sampleRate: 12000, channels: 1, samples: [1, 2, 3] })));
    assert.strictEqual(f.sampleRate, 12000);
    assert.strictEqual(f.channels, 1);
    assert.strictEqual(f.planes.length, 1);
    assert.strictEqual(f.planes[0].length, 3);
});

t('a reconnect forgets the previous session’s metadata', () => {
    const d = new PCMStreamDecoder();
    d.decode(ab(fullFrame({ sampleRate: 10000, channels: 2, samples: [0, 0] })));
    d.reset();
    // Samples before any header cannot be played: there is nothing to say what
    // rate they are, and guessing the last one would play them wrong.
    assert.strictEqual(d.decode(ab(minimalFrame([1, 2]))), null);
});

// --- the signal quality it carries -------------------------------------------

t('a full header carries the powers, and -999 means no reading', () => {
    const d = new PCMStreamDecoder();
    const f = d.decode(ab(fullFrame({ sampleRate: 12000, channels: 1, samples: [0] })));
    assert.ok(Math.abs(f.signal.basebandPower + 55.5) < 0.01);
    assert.ok(Math.abs(f.signal.noisePower + 95.25) < 0.01);

    const none = d.decode(ab(fullFrame({
        sampleRate: 12000, channels: 1, samples: [0], power: -999, noise: -999,
    })));
    assert.strictEqual(none.signal.basebandPower, null);
    assert.strictEqual(none.signal.noisePower, null);
});

// --- framing -----------------------------------------------------------------

t('a zstd frame is told apart from an Opus one', () => {
    // The sniff is what lets a client that asked for Opus still decode the
    // pcm-zstd the server sends in IQ regardless.
    assert.ok(isZstdFrame(ab(fullFrame({ sampleRate: 12000, channels: 1, samples: [0] }))));
    assert.ok(!isZstdFrame(ab(Buffer.from([0, 0, 0, 0, 1, 2, 3]))));
    assert.ok(!isZstdFrame(ab(Buffer.from([1, 2]))));
});

t('a packet that is not ours is refused rather than played', () => {
    const d = new PCMStreamDecoder();
    assert.strictEqual(d.decode(ab(Buffer.from([1, 2, 3, 4]))), null);        // not zstd
    assert.strictEqual(d.decode(ab(zstd(Buffer.alloc(4)))), null);            // too short
});

if (process.exitCode) console.log('\npcm-stream tests FAILED');
else console.log(`\nall ${pass} pcm-stream tests passed`);
