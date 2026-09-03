// The reduced-depth IQ profile, checked against packets the server's own
// encoder produced.
//
// The mode is lossy against its input and lossless against what it chose to
// send: the encoder requantises, the predictor runs on the quantised values on
// both sides, and the shift travels in the packet so the decoder can put them
// back. What has to agree across the language boundary is therefore the
// RECONSTRUCTION, and the fixture records what the Go decoder returned rather
// than what went in.
//
// Nothing here builds a packet by hand. Two implementations agreeing with a
// fixture written from the same understanding as one of them would prove only
// that the understanding is self-consistent.
//
// See pcm_lossy.go for why the request is a margin rather than a bit depth.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PCMv4StreamDecoder, isV4Frame } = require('./.build/pcmv4scaled.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

function load() {
    const buf = fs.readFileSync(path.join(__dirname, 'pcmv4scaled.sample.bin'));
    const out = [];
    let off = 0;
    while (off + 8 <= buf.length) {
        const pktLen = buf.readUInt32LE(off);
        const nSamples = buf.readUInt32LE(off + 4);
        off += 8;
        const ab = new ArrayBuffer(pktLen);
        new Uint8Array(ab).set(buf.subarray(off, off + pktLen));
        off += pktLen;
        const want = new Int16Array(nSamples);
        for (let i = 0; i < nSamples; i++) want[i] = buf.readInt16LE(off + 2 * i);
        off += nSamples * 2;
        out.push({ packet: ab, want });
    }
    return out;
}

const all = load();

t('the sample holds scaled packets from the server encoder', () => {
    assert.ok(all.length > 1000, `only ${all.length} packets`);
    for (const p of all) assert.ok(isV4Frame(p.packet), 'a packet is not a v4 frame');
});

t('every packet decodes to exactly what the server reconstructed', () => {
    const dec = new PCMv4StreamDecoder();
    let compared = 0;
    all.forEach((p, n) => {
        const frame = dec.decode(p.packet);
        assert.ok(frame, `packet ${n} was rejected`);
        const ch = frame.channels;
        const frames = frame.planes[0].length;
        assert.strictEqual(frames * ch, p.want.length,
            `packet ${n}: ${frames} frames x ${ch} channels, expected ${p.want.length}`);
        for (let i = 0; i < p.want.length; i++) {
            const c = ch > 1 ? i % ch : 0;
            const j = ch > 1 ? Math.floor(i / ch) : i;
            const got = Math.round(frame.planes[c][j] * 32768);
            assert.strictEqual(got, p.want[i],
                `packet ${n} sample ${i}: got ${got}, want ${p.want[i]}`);
            compared++;
        }
    });
    assert.ok(compared > 500000, `only compared ${compared} samples`);
});

// The profile is what gates the mode: a client that never asked must never be
// handed one it does not implement, and if it somehow is, it must fail rather
// than play noise.
t('the stream declares the scaled profile', () => {
    const dec = new PCMv4StreamDecoder();
    dec.decode(all[0].packet);
    assert.strictEqual(dec.profileId, 2, `profile ${dec.profileId}, want 2`);
    assert.strictEqual(dec.scaled, true, 'scaled flag not set');
});

t('an unknown profile is refused rather than guessed at', () => {
    const src = new Uint8Array(all[0].packet);
    const bad = new Uint8Array(src);
    bad[4] = (bad[4] & ~0x07) | 0x05;   // a profile id nothing implements
    assert.strictEqual(new PCMv4StreamDecoder().decode(bad.buffer), null,
        'a packet declaring profile 5 was decoded anyway');
});

console.log(`\n${pass} passing`);
