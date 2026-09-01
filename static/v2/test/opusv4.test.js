// The version 4 Opus header, checked against headers the server's own encoder
// produced.
//
// From version 4 the Opus header is variable-length and carries only what
// changed since the last frame, where version 3 sent a fixed 21 bytes. Getting
// the body offset wrong does not fail loudly: it feeds the Opus decoder a few
// bytes of audio as though they were metadata, which sounds like noise rather
// than like an error. So the offset is checked on every packet.
//
// The sample covers a normal run, a mode change that forces a
// resynchronisation, and the "no reading" sentinel with the values that stand
// in for it. Nothing here is constructed by hand: the two implementations have
// to agree across a language boundary, and a fixture written from the same
// understanding as the decoder would only prove that understanding is
// self-consistent.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OpusV4HeaderDecoder, isV4Frame } = require('./.build/opusv4.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

function load() {
    const buf = fs.readFileSync(path.join(__dirname, 'opusv4.sample.bin'));
    const out = [];
    let off = 0;
    while (off + 24 <= buf.length) {
        const pktLen = buf.readUInt32LE(off);
        const bodyLen = buf.readUInt32LE(off + 4);
        const rate = buf.readUInt32LE(off + 8);
        const channels = buf.readUInt32LE(off + 12);
        const power = buf.readInt32LE(off + 16);
        const noise = buf.readInt32LE(off + 20);
        off += 24;
        const ab = new ArrayBuffer(pktLen);
        new Uint8Array(ab).set(buf.subarray(off, off + pktLen));
        off += pktLen;
        out.push({ packet: ab, bodyLen, rate, channels, power, noise });
    }
    return out;
}

const NO_READING = -32768;
const all = load();

t('the sample holds headers from the server encoder', () => {
    assert.ok(all.length > 500, `only ${all.length} packets`);
});

t('the body offset is right on every packet', () => {
    // This is the one that matters: a wrong offset silently corrupts audio.
    const dec = new OpusV4HeaderDecoder();
    let headerBytes = 0;
    all.forEach((p, n) => {
        const h = dec.decode(p.packet);
        assert.ok(h, `packet ${n} was rejected`);
        const bodyLen = p.packet.byteLength - h.bodyOffset;
        assert.strictEqual(bodyLen, p.bodyLen,
            `packet ${n}: body is ${bodyLen} bytes from offset ${h.bodyOffset}, server wrote ${p.bodyLen}`);
        headerBytes += h.bodyOffset;
    });
    const mean = headerBytes / all.length;
    console.log(`      mean header ${mean.toFixed(2)} bytes (version 3 sent 21)`);
    assert.ok(mean < 8, `header averaged ${mean.toFixed(2)} bytes, expected well under 21`);
});

t('metadata and quality survive, including across a mode change', () => {
    const dec = new OpusV4HeaderDecoder();
    let rateChanges = 0;
    let last = null;
    all.forEach((p, n) => {
        const h = dec.decode(p.packet);
        assert.ok(h, `packet ${n} rejected`);
        assert.strictEqual(h.sampleRate, p.rate, `packet ${n}: sample rate`);
        assert.strictEqual(h.channels, p.channels, `packet ${n}: channels`);
        const wantPower = p.power === NO_READING ? null : p.power / 100;
        const wantNoise = p.noise === NO_READING ? null : p.noise / 100;
        assert.strictEqual(h.signal.basebandPower, wantPower, `packet ${n}: power`);
        assert.strictEqual(h.signal.noisePower, wantNoise, `packet ${n}: noise`);
        if (last !== null && last !== h.sampleRate) rateChanges++;
        last = h.sampleRate;
    });
    assert.ok(rateChanges > 0, 'the sample was meant to contain a mode change');
    console.log(`      ${rateChanges} sample-rate change(s) carried correctly`);
});

t('the no-reading sentinel arrives as null, not as a number', () => {
    const dec = new OpusV4HeaderDecoder();
    let sentinels = 0;
    for (const p of all) {
        const h = dec.decode(p.packet);
        if (h && h.signal.basebandPower === null) sentinels++;
    }
    assert.ok(sentinels > 0, 'the sample was meant to contain sentinel readings');
    console.log(`      ${sentinels} packets marked "no reading"`);
});

t('an Opus header is never mistaken for a lossless frame', () => {
    // This is why the Opus header needs no magic of its own. Frames are sorted
    // by elimination, so the hazard is an Opus header reading as PCM. The PCM
    // magic's first byte is 0x50, which sets bit 4; an Opus flags byte uses
    // only bits 0 and 1 and cannot reach it.
    for (const p of all) {
        assert.ok(!isV4Frame(p.packet), 'an Opus packet was identified as lossless');
        assert.ok(new Uint8Array(p.packet)[0] <= 0x03,
            'the flags byte used bits outside 0-1, which is what makes the collision impossible');
    }
});

t('a decoder joining mid-stream waits for a resynchronisation point', () => {
    const dec = new OpusV4HeaderDecoder();
    let firstAccepted = -1;
    for (let i = 40; i < Math.min(all.length, 400); i++) {
        if (dec.decode(all[i].packet)) { firstAccepted = i; break; }
    }
    assert.ok(firstAccepted > 40, 'a fresh decoder accepted a delta packet');
    console.log(`      joined at packet 40, recovered at ${firstAccepted}`);
});

t('reset() makes a reconnect a clean start', () => {
    const a = new OpusV4HeaderDecoder();
    for (const p of all.slice(0, 100)) a.decode(p.packet);
    a.reset();
    const b = new OpusV4HeaderDecoder();
    for (let i = 0; i < 100; i++) {
        const ha = a.decode(all[i].packet);
        const hb = b.decode(all[i].packet);
        assert.strictEqual(!!ha, !!hb, `packet ${i}: reset decoder disagrees on acceptance`);
        if (!ha) continue;
        assert.strictEqual(ha.bodyOffset, hb.bodyOffset, `packet ${i}: body offset`);
        assert.strictEqual(ha.sampleRate, hb.sampleRate, `packet ${i}: sample rate`);
    }
});

t('a malformed header is refused rather than half-read', () => {
    const good = new Uint8Array(all[0].packet);
    const cases = {
        empty: new ArrayBuffer(0),
        'flags only': good.slice(0, 1).buffer,
        truncated: good.slice(0, 4).buffer,
        'reserved bits set': (() => { const c = good.slice(); c[0] = 0xf0; return c.buffer; })(),
    };
    for (const [name, buf] of Object.entries(cases)) {
        const d = new OpusV4HeaderDecoder();
        d.decode(all[0].packet);
        assert.strictEqual(d.decode(buf), null, `${name} was accepted`);
    }
});

console.log(`\n${pass} passed`);
