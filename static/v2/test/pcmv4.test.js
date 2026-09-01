// The version 4 lossless decoder, checked against packets the server's own
// encoder produced.
//
// Every sample here came off a real receiver and was encoded by the Go
// implementation in pcm_predictive.go and pcm_v4_header.go. Nothing in this
// file constructs a packet by hand: the two implementations have to agree bit
// for bit across a language boundary, and a fixture written from the same
// understanding as the decoder would only prove the understanding was
// self-consistent.
//
// The sample covers all three body modes and a predictor profile change
// mid-stream, which is what a mode change looks like on the wire:
//
//   coded     the ordinary case
//   escape    verbatim samples, sent when the predictor cannot help; a
//             saturated front end produces these
//   silent    all-zero audio with no body at all, which is what a closed
//             squelch sends continuously
//
// See pcm-v4.js, and the Go side for why the format is shaped this way.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PCMv4StreamDecoder, isV4Frame } = require('./.build/pcmv4.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

function load() {
    const buf = fs.readFileSync(path.join(__dirname, 'pcmv4.sample.bin'));
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

t('the sample holds packets from the server encoder', () => {
    assert.ok(all.length > 1000, `only ${all.length} packets`);
    for (const p of all) assert.ok(isV4Frame(p.packet), 'a packet is not a v4 frame');
});

t('every packet decodes to exactly the samples the server encoded', () => {
    const dec = new PCMv4StreamDecoder();
    let compared = 0;
    all.forEach((p, n) => {
        const frame = dec.decode(p.packet);
        assert.ok(frame, `packet ${n} was rejected`);
        const ch = frame.channels;
        const frames = frame.planes[0].length;
        assert.strictEqual(frames * ch, p.want.length,
            `packet ${n}: ${frames} frames x ${ch} channels, expected ${p.want.length} samples`);
        for (let i = 0; i < p.want.length; i++) {
            const c = ch > 1 ? i % ch : 0;
            const idx = ch > 1 ? Math.floor(i / ch) : i;
            const got = Math.round(frame.planes[c][idx] * 32768);
            if (got !== p.want[i]) {
                throw new Error(`packet ${n} sample ${i}: got ${got}, want ${p.want[i]} — not lossless`);
            }
            compared++;
        }
    });
    assert.ok(compared > 500000, `only ${compared} samples compared`);
    console.log(`      ${compared} samples identical to the server's input`);
});

t('a decoder joining mid-stream waits for a resynchronisation point', () => {
    // The header carries only what changed, so a decoder that starts part-way
    // through has no sample rate or channel count. It must refuse rather than
    // guess: the server re-sends metadata every five seconds for exactly this.
    const dec = new PCMv4StreamDecoder();
    let firstAccepted = -1;
    for (let i = 40; i < Math.min(all.length, 400); i++) {
        if (dec.decode(all[i].packet)) { firstAccepted = i; break; }
    }
    assert.ok(firstAccepted > 40, 'a fresh decoder accepted a delta packet');
    assert.ok(firstAccepted > 0, 'a fresh decoder never recovered');
    console.log(`      joined at packet 40, recovered at ${firstAccepted}`);
});

t('reset() makes a reconnect a clean start', () => {
    // The predictor is the stream. If reset() left any of it behind, a
    // reconnect would decode against filters trained on the old socket.
    const a = new PCMv4StreamDecoder();
    for (const p of all.slice(0, 200)) a.decode(p.packet);
    a.reset();
    const b = new PCMv4StreamDecoder();
    for (let i = 0; i < 200; i++) {
        const fa = a.decode(all[i].packet);
        const fb = b.decode(all[i].packet);
        assert.strictEqual(!!fa, !!fb, `packet ${i}: reset decoder disagrees on acceptance`);
        if (!fa) continue;
        for (let c = 0; c < fa.channels; c++) {
            for (let j = 0; j < fa.planes[c].length; j++) {
                assert.strictEqual(fa.planes[c][j], fb.planes[c][j],
                    `packet ${i} plane ${c} sample ${j}: reset left state behind`);
            }
        }
    }
});

t('signal quality survives, including the no-reading sentinel', () => {
    const dec = new PCMv4StreamDecoder();
    let readings = 0, sentinels = 0;
    for (const p of all) {
        const f = dec.decode(p.packet);
        if (!f || !f.signal) continue;
        if (f.signal.basebandPower === null) sentinels++;
        else {
            readings++;
            assert.ok(f.signal.basebandPower > -400 && f.signal.basebandPower < 400,
                `implausible power ${f.signal.basebandPower} dBFS`);
        }
    }
    assert.ok(readings > 100, `only ${readings} usable readings`);
    console.log(`      ${readings} readings, ${sentinels} marked "no reading"`);
});

t('a malformed packet is refused rather than half-read', () => {
    const dec = new PCMv4StreamDecoder();
    dec.decode(all[0].packet); // establish metadata
    const good = new Uint8Array(all[1].packet);
    const cases = {
        empty: new ArrayBuffer(0),
        'magic only': good.slice(0, 4).buffer,
        'bad magic': (() => { const c = good.slice(); c[0] ^= 0xff; return c.buffer; })(),
        truncated: good.slice(0, Math.max(5, good.length >> 1)).buffer,
        'unknown profile': (() => { const c = good.slice(); c[4] = (c[4] & 0xf8) | 6; return c.buffer; })(),
    };
    for (const [name, buf] of Object.entries(cases)) {
        const d = new PCMv4StreamDecoder();
        d.decode(all[0].packet);
        const out = d.decode(buf);
        assert.strictEqual(out, null, `${name} was accepted`);
    }
});

t('an Opus frame is never mistaken for a v4 packet', () => {
    // Both arrive on the same socket: the server picks the format per packet
    // and forces PCM in IQ modes whatever was negotiated. An Opus frame starts
    // with a timestamp, so the magic width is a false positive rate.
    let hits = 0;
    const frame = new ArrayBuffer(21);
    const dv = new DataView(frame);
    for (let i = 0; i < 500000; i++) {
        dv.setUint32(0, (i * 2654435761) >>> 0, true);
        dv.setUint32(4, (i * 40503) >>> 0, true);
        if (isV4Frame(frame)) hits++;
    }
    assert.strictEqual(hits, 0, `${hits} of 500000 synthetic Opus frames read as v4`);
});

console.log(`\n${pass} passed`);
