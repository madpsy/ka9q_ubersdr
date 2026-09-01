// The version 2 spectrum decoder, checked against frames the server's own
// encoder produced.
//
// Version 1 had three measured problems this format exists to fix, and each has
// a test here:
//
//   - its delta listed changed bins as [index u16, value u8], so about two
//     thirds of delta frames came out LARGER than the full frame they avoided;
//   - its 8-bit code spanned 256 dB at 1 dB a step for bins occupying about 90,
//     truncated rather than rounded, and wrapped a 0 dBFS bin round to -256 dB;
//   - it had no sequence number and no keyframe, so a frame dropped for a slow
//     client desynchronised those bins with nothing to detect or correct it.
//
// Nothing here builds a frame by hand: the two implementations have to agree
// across a language boundary, and a fixture written from the same understanding
// as the decoder would only prove that understanding is self-consistent.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SpectrumConnection } = require('./.build/spectrumv2.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

function load() {
    const buf = fs.readFileSync(path.join(__dirname, 'spectrumv2.sample.bin'));
    const out = [];
    let off = 0;
    while (off + 8 <= buf.length) {
        const pktLen = buf.readUInt32LE(off);
        const bins = buf.readUInt32LE(off + 4);
        off += 8;
        const packet = new Uint8Array(buf.subarray(off, off + pktLen)).buffer;
        off += pktLen;
        const want = new Float32Array(bins);
        for (let i = 0; i < bins; i++) want[i] = buf.readFloatLE(off + 4 * i);
        off += bins * 4;
        out.push({ packet, want });
    }
    return out;
}

// The connection object owns the decoder; drive it directly rather than opening
// a socket. _unwrap rotates the halves for display, so undo that to compare
// against the raw-order bins the server encoded.
function decoder() {
    const c = Object.create(SpectrumConnection.prototype);
    c._float = null; c._u8 = null; c._out = null;
    c._v2Scale = null; c._v2Seq = null;
    c.framesIn = 0; c.attempts = 0; c.framesDropped = 0;
    c._handlers = {};
    // Record the event NAME as well as the payload. An earlier version of this
    // stub kept only the payload, so the decoder emitting 'spectrum' instead of
    // 'frame' passed every test here and displayed nothing in the application:
    // every consumer listens for 'frame'.
    c._events = [];
    c.emit = (ev, payload) => { c._last = payload; c._lastEvent = ev; c._events.push(ev); };
    return c;
}

function rewrap(bins) {
    // _unwrap rotates left by n>>1; undo it.
    const n = bins.length;
    const h = n >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[(i + h) % n] = bins[i];
    return out;
}

const all = load();

t('frames are emitted under the name consumers listen for', () => {
    // SpectrumView, MeasureWatch, IFSpectrumPanel, BridgeHost and RadioContext
    // all subscribe to 'frame'. Emitting any other name decodes perfectly and
    // shows nothing, with nothing logged to say why.
    const c = decoder();
    for (const f of all.slice(0, 60)) c._onSpectrumV2(new Uint8Array(f.packet));
    assert.ok(c._events.length > 0, 'no frames were emitted at all');
    for (const ev of c._events) {
        assert.strictEqual(ev, 'frame', `emitted '${ev}', but every consumer listens for 'frame'`);
    }
    assert.ok(c._last && c._last.bins && c._last.bins.length > 0, 'payload has no bins');
    assert.ok(typeof c._last.frequency === 'number', 'payload has no frequency');
    assert.ok(typeof c._last.timestamp === 'number', 'payload has no timestamp');
});

t('the sample holds version 2 frames from the server encoder', () => {
    assert.ok(all.length > 400, `only ${all.length} frames`);
    let full = 0, delta = 0;
    for (const f of all) {
        const u8 = new Uint8Array(f.packet);
        assert.strictEqual(String.fromCharCode(...u8.slice(0, 4)), 'SPEC', 'bad magic');
        assert.strictEqual(u8[4], 2, 'not version 2');
        if (u8[5] === 0x05) full++; else if (u8[5] === 0x06) delta++;
        else throw new Error(`unknown flags 0x${u8[5].toString(16)}`);
    }
    assert.ok(full > 0 && delta > 0, `need both frame types, got ${full} full ${delta} delta`);
    console.log(`      ${full} full frames, ${delta} delta frames`);
});

t('every frame decodes to exactly what the server encoded', () => {
    const c = decoder();
    let compared = 0;
    all.forEach((f, n) => {
        c._onSpectrumV2(new Uint8Array(f.packet));
        assert.ok(c._last, `frame ${n} produced nothing`);
        const got = rewrap(c._last.bins);
        assert.strictEqual(got.length, f.want.length,
            `frame ${n}: ${got.length} bins, server had ${f.want.length}`);
        for (let i = 0; i < got.length; i++) {
            // Both sides compute (ref + code*step)/100; allow only float noise.
            if (Math.abs(got[i] - f.want[i]) > 1e-4) {
                throw new Error(`frame ${n} bin ${i}: got ${got[i]}, server had ${f.want[i]}`);
            }
            compared++;
        }
    });
    assert.ok(compared > 400000, `only ${compared} bins compared`);
    console.log(`      ${compared} bins identical to the server's reconstruction`);
});

t('a delta is never larger than the full frame it replaces', () => {
    // The whole reason for the change mask. Version 1 failed this about two
    // thirds of the time.
    let worstDelta = 0, fullSize = 0;
    for (const f of all) {
        const u8 = new Uint8Array(f.packet);
        if (u8[5] === 0x05) fullSize = Math.max(fullSize, f.packet.byteLength);
        else worstDelta = Math.max(worstDelta, f.packet.byteLength);
    }
    console.log(`      largest delta ${worstDelta} bytes, largest full ${fullSize}`);
    assert.ok(worstDelta <= fullSize,
        `a delta reached ${worstDelta} bytes against a full frame of ${fullSize}`);
});

t('the scale follows the data rather than being fixed', () => {
    // Version 1 hardcoded 1 dB steps over -256..0 whatever the receiver's gain
    // settings were. The sample deliberately contains a large gain shift.
    const c = decoder();
    const scales = new Set();
    for (const f of all) {
        c._onSpectrumV2(new Uint8Array(f.packet));
        if (new Uint8Array(f.packet)[5] === 0x05) {
            scales.add(`${c._v2Scale.ref}/${c._v2Scale.step}`);
        }
    }
    console.log(`      ${scales.size} distinct scales across the sample`);
    assert.ok(scales.size > 1, 'the scale never adapted, so it is effectively fixed');
    // And whatever it chose, it must be finer than version 1's 1 dB.
    for (const s of scales) {
        const step = Number(s.split('/')[1]);
        assert.ok(step > 0 && step <= 100, `step ${step} centiDB is not an improvement on 1 dB`);
    }
});

t('a decoder joining mid-stream waits for a keyframe', () => {
    const c = decoder();
    let firstAccepted = -1;
    for (let i = 5; i < 200; i++) {
        c._onSpectrumV2(new Uint8Array(all[i].packet));
        if (c._last) { firstAccepted = i; break; }
    }
    assert.ok(firstAccepted > 0, 'never recovered');
    // It must have been a full frame that unblocked it.
    assert.strictEqual(new Uint8Array(all[firstAccepted].packet)[5], 0x05,
        'a delta was accepted before any full frame');
    console.log(`      joined at frame 5, recovered at ${firstAccepted} (a keyframe)`);
});

t('a malformed frame is refused rather than half-applied', () => {
    // Version 1 had no length validation: a truncated delta threw inside an
    // async handler and left the accumulator partly updated.
    const c = decoder();
    let firstDelta = -1;
    for (let i = 0; i < all.length; i++) {
        c._onSpectrumV2(new Uint8Array(all[i].packet));
        if (new Uint8Array(all[i].packet)[5] === 0x06) { firstDelta = i; break; }
    }
    assert.ok(firstDelta > 0, 'no delta frame in the sample');
    const before = Float32Array.from(c._float);

    for (const [name, buf] of Object.entries({
        'truncated header': all[firstDelta].packet.slice(0, 10),
        'truncated mask': all[firstDelta].packet.slice(0, 26),
        'truncated values': all[firstDelta].packet.slice(0, all[firstDelta].packet.byteLength - 5),
        'unknown flags': (() => {
            const c2 = new Uint8Array(all[firstDelta].packet).slice(); c2[5] = 0x09; return c2.buffer;
        })(),
    })) {
        c._last = null;
        assert.doesNotThrow(() => c._onSpectrumV2(new Uint8Array(buf)), `${name} threw`);
        assert.strictEqual(c._last, null, `${name} was accepted`);
        for (let i = 0; i < before.length; i++) {
            assert.strictEqual(c._float[i], before[i], `${name} modified bin ${i}`);
        }
    }
});

t('a dropped frame is visible as a sequence gap', () => {
    // Version 1 had no way to notice. Here a gap is counted, and the next
    // keyframe repairs the picture.
    const c = decoder();
    let n = 0;
    for (let i = 0; i < all.length; i++) {
        if (i % 17 === 3) continue;   // this frame never arrived
        c._onSpectrumV2(new Uint8Array(all[i].packet));
        n++;
    }
    console.log(`      ${c.framesDropped} gaps detected across ${n} delivered frames`);
    assert.ok(c.framesDropped > 0, 'dropped frames went unnoticed');
});

console.log(`\n${pass} passed`);
