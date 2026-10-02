// DSC, against a signal built from ITU-R M.493's layout rather than from the
// decoder; and the bits-and-bytes blocks, against the standard check values.

const assert = require('assert');
const {
    DscDemod, decodeMessage, messageText, bitsToSymbol, symbolToBits, sdrangelLowpass,
    packBits, unpackBits, parseSyncWord, crcBits, CRCS, bytesText, BLOCK_BY_TYPE, makeBuffer, sanitizeParams,
} = require('./.build/playgrounddsc.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;
const pairs = (s) => s.match(/../g).map(Number);

/**
 * A DSC call's symbols as sent: the format specifier twice, the body, the
 * end-of-sequence, and the check character (the XOR of everything from the
 * second format specifier through the EOS).
 */
function message(fs, body, eos) {
    const msg = [fs, fs, ...body, eos];
    let ecc = 0;
    for (let i = 1; i < msg.length; i++) ecc ^= msg[i];
    return [...msg, ecc];
}

/** The symbols in transmission order: DX and RX interleaved, phasing first, RX two pairs behind DX. */
function transmission(msg) {
    const eos = msg[msg.length - 2];
    const dx = [125, 125, 125, 125, 125, 125, ...msg, eos, eos];
    const rx = [111, 110, 109, 108, 107, 106, 105, 104, ...msg];
    const out = [];
    for (let i = 0; i < dx.length; i++) out.push(dx[i], rx[i]);
    return out;
}

/** 100-baud FSK at ±85 Hz, phase continuous: a 1 (Y) is the lower tone. Noise added at `noise` RMS. */
function fsk(symbols, { dots = 200, lead = 0.5, noise = 0, seed = 3 } = {}) {
    const bits = [];
    for (let i = 0; i < dots; i++) bits.push(i % 2);
    for (const s of symbols) {
        // A negative symbol is -(s + 1) sent with one bit wrong, so its check fails.
        const w = s < 0 ? symbolToBits(-s - 1) ^ 0b0000100000 : symbolToBits(s);
        for (let b = 9; b >= 0; b--) bits.push((w >> b) & 1);
    }
    const spb = RATE / 100;
    const n = Math.round(lead * RATE) + bits.length * spb + RATE / 2;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let s32 = seed;
    const u = () => { s32 ^= s32 << 13; s32 ^= s32 >>> 17; s32 ^= s32 << 5; return ((s32 >>> 0) + 0.5) / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    let ph = 0;
    const start = Math.round(lead * RATE);
    for (let k = 0; k < n; k++) {
        const bi = Math.floor((k - start) / spb);
        if (bi >= 0 && bi < bits.length) {
            ph += (2 * Math.PI * (bits[bi] ? -85 : 85)) / RATE;
            re[k] = Math.cos(ph);
            im[k] = Math.sin(ph);
        }
        re[k] += noise * g();
        im[k] += noise * g();
    }
    return { re, im };
}

// A selective call from a ship to a coast station: routine, F3E telephony, no frequencies.
const SELECTIVE = message(120, [...pairs('0023200140'), 100, ...pairs('2351234500'), 100, 126, 126, 126, 126, 126, 126, 126], 117);

function decode(sig, centreHz = 0) {
    const got = [];
    const d = new DscDemod(RATE, (m, errors, rssi) => got.push({ m, errors, rssi }), centreHz);
    for (let at = 0; at < sig.re.length; at += 240) d.process(sig.re.subarray(at, at + 240), sig.im.subarray(at, at + 240), Math.min(240, sig.re.length - at));
    return got;
}

t('a symbol is 7 information bits sent least significant first and a count of their zeros', () => {
    for (let s = 0; s < 128; s++) assert.strictEqual(bitsToSymbol(symbolToBits(s)), s);
    assert.strictEqual(bitsToSymbol(symbolToBits(120) ^ 0b0000010000), -1, 'a flipped bit was not caught');
    // 125 (phasing DX) as the decoder's table has it: 1011111001.
    assert.strictEqual(symbolToBits(125), 0b1011111001);
    const lp = sdrangelLowpass(301, RATE, 110);
    assert.strictEqual(lp.length, 301);
    assert.ok(Math.abs(lp.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

t('a clean selective call is decoded, every field, with its check character right', () => {
    const got = decode(fsk(transmission(SELECTIVE)));
    assert.strictEqual(got.length, 1, `${got.length} calls`);
    const { m, errors } = got[0];
    assert.ok(m.valid, JSON.stringify(m));
    assert.strictEqual(errors <= 3, true, `errors ${errors}`);
    assert.strictEqual(m.address, '002320014');
    assert.strictEqual(m.selfId, '235123450');
    assert.strictEqual(m.category, 100);
    assert.strictEqual(m.telecommand1, 100);
    assert.strictEqual(m.eos, 117);
    assert.match(messageText(m), /Selective call · Address: 002320014 · Category: Routine · Self Id: 235123450/);
});

t('a distress alert gives its nature, position and time', () => {
    // Fire, 51°30'N 001°15'W (quadrant 1), at 12:34, J3E telephony to follow.
    const msg = message(112, [...pairs('2351234500'), 100, ...pairs('1513000115'), ...pairs('1234'), 109], 127);
    const [{ m }] = decode(fsk(transmission(msg)));
    assert.ok(m.valid);
    assert.strictEqual(m.distressNature, 100);
    assert.strictEqual(m.position, "51°30'N 001°15'W");
    assert.strictEqual(m.time, '12:34');
    assert.match(messageText(m), /Distress alert.*Distress nature: Fire, explosion.*Time: 12:34.*Subsequent comms: J3E/);
});

t('in noise, with the dial off-centre, it still decodes; one bad copy of a symbol is mended by the other', () => {
    const [{ m }] = decode(fsk(transmission(SELECTIVE), { noise: 0.35 }));
    assert.ok(m.valid, 'not decoded in noise');
    // Tuned 40 Hz high: the tones are at -125 and +45, and the decoder is told.
    const sig = fsk(transmission(SELECTIVE));
    const rot = { re: new Float64Array(sig.re.length), im: new Float64Array(sig.re.length) };
    for (let k = 0; k < sig.re.length; k++) {
        const a = (-2 * Math.PI * 40 * k) / RATE;
        rot.re[k] = sig.re[k] * Math.cos(a) - sig.im[k] * Math.sin(a);
        rot.im[k] = sig.re[k] * Math.sin(a) + sig.im[k] * Math.cos(a);
    }
    assert.ok(decode(rot, -40)[0].m.valid, 'off-centre not decoded');
    // The address's first DX copy corrupted (a symbol that fails its check): the RX copy carries it.
    const tx = transmission(SELECTIVE);
    const firstAddrDx = tx.indexOf(0, 12);
    tx[firstAddrDx] = -1;
    const bad = fsk(tx);
    const r = decode(bad);
    assert.ok(r[0].m.valid && r[0].m.address === '002320014', 'not mended from its other copy');
});

t('noise alone decodes nothing; a corrupted check character fails the call', () => {
    const noise = { re: new Float64Array(RATE * 10), im: new Float64Array(RATE * 10) };
    let s = 7;
    for (let k = 0; k < noise.re.length; k++) { s = (s * 1103515245 + 12345) >>> 0; noise.re[k] = (s / 2 ** 32) - 0.5; s = (s * 1103515245 + 12345) >>> 0; noise.im[k] = (s / 2 ** 32) - 0.5; }
    assert.strictEqual(decode(noise).filter((x) => x.m.valid).length, 0);
    const wrong = SELECTIVE.slice();
    wrong[wrong.length - 1] ^= 1;
    const [{ m }] = decode(fsk(transmission(wrong)));
    assert.strictEqual(m.eccOk, false);
    assert.strictEqual(m.valid, false);
});

t('the DSC block at 48 kHz decodes through its decimator and says so in words', () => {
    const def = BLOCK_BY_TYPE['dsc-decoder'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), 48000);
    const sig = fsk(transmission(SELECTIVE));
    // Up to 48 kHz by holding each sample four times: the tones stay put.
    const n = sig.re.length * 4;
    const text = [];
    for (let at = 0; at < n; at += 960) {
        const x = makeBuffer('complex', 960);
        for (let k = 0; k < 960; k++) { const j = Math.floor((at + k) / 4); x.re[k] = sig.re[j] || 0; x.im[k] = sig.im[j] || 0; }
        x.n = 960;
        const outs = def.outputs.map((p) => makeBuffer(p.kind, 0));
        inst.process([x], outs, 960);
        for (const msg of outs[0].list) text.push(msg.text);
    }
    assert.strictEqual(text.length, 1, JSON.stringify(text));
    assert.match(text[0], /Self Id: 235123450/);
    assert.strictEqual(inst.read().good, 1);
});

// ── bits and bytes ──────────────────────────────────────────────────────────

const ascii = (s) => unpackBits(Array.from(s, (c) => c.charCodeAt(0)));

t('the CRCs give their standard check values for "123456789"', () => {
    const want = { 'crc8': 0xf4, 'crc16-ccitt': 0x29b1, 'crc16-xmodem': 0x31c3, 'crc16-x25': 0x906e, 'crc16-arc': 0xbb3d, 'crc32': 0xcbf43926 };
    for (const [k, v] of Object.entries(want)) assert.strictEqual(crcBits(ascii('123456789'), CRCS[k]), v, `${k} ${crcBits(ascii('123456789'), CRCS[k]).toString(16)}`);
});

t('pack and unpack are inverses, either order; a sync word reads as binary or hex', () => {
    const bits = [1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1];
    assert.deepStrictEqual(packBits(bits, 4), [0b1011, 0b0010, 0b0111]);
    assert.deepStrictEqual(unpackBits(packBits(bits, 4, false), 4, false), bits);
    assert.deepStrictEqual(parseSyncWord('0xA5'), [1, 0, 1, 0, 0, 1, 0, 1]);
    assert.deepStrictEqual(parseSyncWord('1100 1'), [1, 1, 0, 0, 1]);
    assert.strictEqual(parseSyncWord('xyz'), null);
    assert.strictEqual(bytesText([0x48, 0x69, 0x00], 'hex'), '48 69 00');
    assert.strictEqual(bytesText([0x48, 0x69, 0x00], 'ascii'), 'Hi.');
});

t('a frame is found by its sync word with a wrong bit, and its CRC checked', () => {
    const word = parseSyncWord('0x1ACFFC1D');
    const payload = ascii('HELLO');
    const crc = crcBits(payload, CRCS['crc16-ccitt']);
    const frame = [...payload, ...unpackBits([crc >> 8, crc & 0xff])];
    const noisyWord = word.slice();
    noisyWord[5] ^= 1;
    const stream = [0, 1, 1, 0, ...noisyWord, ...frame, 1, 0, 1];
    const f = BLOCK_BY_TYPE['sync-framer'];
    const fi = f.create();
    fi.configure(sanitizeParams(f, { word: '0x1ACFFC1D', frameBits: frame.length, maxErrors: 1 }), 1);
    const bits = makeBuffer('bits', stream.length);
    bits.re.set(stream); bits.n = stream.length;
    const fo = f.outputs.map((p) => makeBuffer(p.kind, 0));
    fi.process([bits], fo, stream.length);
    assert.strictEqual(fo[0].list.length, 1);
    assert.strictEqual(fo[0].list[0].errors, 1);
    const c = BLOCK_BY_TYPE['crc-check'];
    const ci = c.create();
    ci.configure(sanitizeParams(c, { crc: 'crc16-ccitt' }), 1);
    const co = c.outputs.map((p) => makeBuffer(p.kind, 0));
    const corrupt = { ...fo[0].list[0], bits: fo[0].list[0].bits.map((b, i) => (i === 3 ? 1 - b : b)) };
    ci.process([{ list: [fo[0].list[0], corrupt] }], co, 0);
    assert.strictEqual(co[0].list.length, 1, 'the good frame did not pass');
    assert.strictEqual(String.fromCharCode(...co[0].list[0].bytes), 'HELLO');
    assert.strictEqual(co[1].list.length, 1, 'the bad frame passed');
    assert.strictEqual(co[2].value, 0.5);
});

console.log(`\n${pass} passed`);
