// What the lossless path costs the browser: protocol version 3 against
// version 4, decoding identical audio.
//
// Version 4 saves bandwidth by predicting each sample from the ones before it,
// which is arithmetic version 3 does not do — it inflates a zstd frame and
// copies the samples out. So the saving is not free, and the question this
// answers is whether the price is one a browser can pay on the main thread.
//
// The sample file holds the same captured audio encoded both ways by the
// server's own encoders (SpeedDefault zstd for the audio modes, SpeedFastest
// for IQ, matching SetFastMode), so the two decoders see identical content
// rather than merely similar content.
//
// The budget that matters is not microseconds per packet but the fraction of a
// core at the rate a mode actually delivers: 50 packets a second for audio and
// 12 kHz IQ, and rather more for the wide IQ modes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    PCMStreamDecoder, isZstdFrame, PCMv4StreamDecoder, isV4Frame,
} = require('./.build/pcmcpu.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Packet rate is derived from the stream rather than tabled: a table keyed by
// a label is a silent lie the moment a label changes, and an earlier version of
// this test understated the widest IQ mode twentyfold that way.
//
//   packets/second = sampleRate * channels / samples per packet
//
// which gives 50 for every mode this interface offers, and about 1066 for the
// 384 kHz IQ stream that only external clients can request.
function packetsPerSecond(sampleRate, channels, samplesPerPacket) {
    return (sampleRate * channels) / samplesPerPacket;
}

function load() {
    const buf = fs.readFileSync(path.join(__dirname, 'pcmcpu.sample.bin'));
    const out = [];
    let off = 0;
    while (off + 16 <= buf.length) {
        const v3len = buf.readUInt32LE(off);
        const v4len = buf.readUInt32LE(off + 4);
        const n = buf.readUInt32LE(off + 8);
        const stream = buf.readUInt32LE(off + 12);
        off += 16;
        const v3 = buf.subarray(off, off + v3len); off += v3len;
        const v4 = buf.subarray(off, off + v4len); off += v4len;
        out.push({ v3: toAB(v3), v4: toAB(v4), samples: n, stream });
    }
    return out;
}

function toAB(b) {
    const ab = new ArrayBuffer(b.length);
    new Uint8Array(ab).set(b);
    return ab;
}

// Group by stream. Both decoders are stateful -- version 4's predictor
// especially so -- and each stream must be decoded from its own first packet.
// The stream index is recorded alongside each packet rather than inferred:
// a fresh version 4 decoder deliberately refuses a delta packet, so probing
// for a boundary by trying to decode one would report every packet as a new
// stream.
function groupStreams(packets) {
    const groups = [];
    let cur = null;
    for (const p of packets) {
        if (!cur || cur.key !== p.stream) {
            cur = { key: p.stream, packets: [] };
            groups.push(cur);
        }
        cur.packets.push(p);
    }
    return groups;
}

function timeDecode(packets, version, reps) {
    const start = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) {
        const dec = version === 4 ? new PCMv4StreamDecoder() : new PCMStreamDecoder();
        for (const p of packets) {
            const frame = dec.decode(version === 4 ? p.v4 : p.v3);
            if (!frame) throw new Error(`version ${version} decoder rejected a packet`);
        }
    }
    const ns = Number(process.hrtime.bigint() - start);
    return ns / (reps * packets.length) / 1000; // microseconds per packet
}

const all = load();

t('both encodings are present and well formed', () => {
    assert.ok(all.length > 100, `only ${all.length} packets in the sample`);
    for (const p of all.slice(0, 200)) {
        assert.ok(isZstdFrame(p.v3), 'a version 3 packet is not a zstd frame');
        assert.ok(isV4Frame(p.v4), 'a version 4 packet is not a v4 frame');
        assert.ok(!isV4Frame(p.v3), 'a version 3 packet was taken for version 4');
        assert.ok(!isZstdFrame(p.v4), 'a version 4 packet was taken for zstd');
    }
});

t('both decoders return identical samples', () => {
    // The decode cost is only worth comparing if the two produce the same
    // audio, so this is checked before any timing.
    const groups = groupStreams(all);
    let compared = 0;
    for (const g of groups) {
        const d3 = new PCMStreamDecoder();
        const d4 = new PCMv4StreamDecoder();
        for (const p of g.packets) {
            const f3 = d3.decode(p.v3);
            const f4 = d4.decode(p.v4);
            assert.ok(f3 && f4, 'a decoder rejected a packet');
            assert.strictEqual(f4.sampleRate, f3.sampleRate, 'sample rate differs');
            assert.strictEqual(f4.channels, f3.channels, 'channel count differs');
            for (let c = 0; c < f3.channels; c++) {
                const a = f3.planes[c], b = f4.planes[c];
                assert.strictEqual(b.length, a.length, 'frame length differs');
                for (let i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) {
                        throw new Error(`plane ${c} sample ${i}: v3 ${a[i]}, v4 ${b[i]}`);
                    }
                    compared++;
                }
            }
        }
    }
    assert.ok(compared > 500000, `only ${compared} samples compared`);
    console.log(`      ${compared} samples identical between the two decoders`);
});

t('version 4 decode fits comfortably inside a browser frame budget', () => {
    const groups = groupStreams(all);
    console.log('      stream        v3 us/pkt   v4 us/pkt   ratio    pkt/s   v4 %core   v3 %core');
    const cores = [];
    for (const g of groups) {
        if (g.packets.length < 50) continue;
        const reps = g.packets.length > 400 ? 3 : 10;
        const us3 = timeDecode(g.packets, 3, reps);
        const us4 = timeDecode(g.packets, 4, reps);
        const first = new PCMv4StreamDecoder().decode(g.packets[0].v4);
        const label = first.channels === 2
            ? `iq${Math.round(first.sampleRate / 1000)}k`
            : `audio${Math.round(first.sampleRate / 1000)}k`;
        const rate = packetsPerSecond(first.sampleRate, first.channels, g.packets[0].samples);
        const core = us4 * rate / 10000;
        cores.push({ label, core, rate });
        console.log(`      ${label.padEnd(12)} ${us3.toFixed(1).padStart(9)} ${us4.toFixed(1).padStart(11)}`
            + `   ${(us4 / us3).toFixed(1).padStart(4)}x ${rate.toFixed(0).padStart(8)}`
            + `  ${core.toFixed(2).padStart(8)}%  ${(us3 * rate / 10000).toFixed(2).padStart(8)}%`);
    }
    // Only the modes this interface can actually select are measured: audio,
    // and `iq` at 12 kHz. The wide IQ variants are deliberately absent from
    // constants.js, being "for feeding external tools, not a browser", so their
    // decode cost is not a browser concern and timing them here would only
    // invite tuning for a case no browser reaches.
    const browserWorst = Math.max(...cores.map((c) => c.core));
    console.log(`      worst case across the modes this interface offers: ${browserWorst.toFixed(2)}% of a core`);
    assert.ok(browserWorst < 5, `${browserWorst.toFixed(1)}% of a core on the main thread is too much`);
});

console.log(`\n${pass} passed`);
