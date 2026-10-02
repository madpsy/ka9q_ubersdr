// The SSTV decoder (a port of slowrx): an independent encoder in this file
// turns a test picture into audio — VIS header and all — from the published
// mode timings, and the decoder must find the mode and give the picture back.
// Then a real recording, if it is on this machine.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
    SstvDecoder, SSTV_MODES, sstvModeByName, SstvDemodBlock, SstvRasterBlock,
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, Gallery,
    Runtime, GRAPH_VERSION, parseGraph, compile, expandDecoder,
} = require('./.build/playgroundsstv.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const SCRATCH = '/tmp/claude-1000/-home-nathan-repos-ka9q-ubersdr/568b4257-04cf-4145-9223-136ec760cbc5/scratchpad';
const REAL_WAV = path.join(process.env.HOME || '', 'repos/ubersdr_qsstv/image-sstv.wav');

// ── the test picture ────────────────────────────────────────────────────────

// Top third: eight colour bars. Middle: a grey ramp across. Bottom: red rising
// across, green falling, blue rising down — smooth, so what is measured is the
// decoder's level accuracy more than its edge sharpness.
function testPicture(w, h) {
    const rgb = new Uint8Array(w * h * 3);
    const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let p;
            if (y < h / 3) p = bars[Math.floor((x * 8) / w)];
            else if (y < (2 * h) / 3) { const v = Math.round((x * 255) / (w - 1)); p = [v, v, v]; }
            else {
                const fy = (y - (2 * h) / 3) / (h / 3);
                p = [Math.round((x * 255) / (w - 1)), Math.round(255 - (x * 255) / (w - 1)), Math.round(fy * 255)];
            }
            rgb.set(p, 3 * (y * w + x));
        }
    }
    return { w, h, rgb };
}

// ── an SSTV encoder, from the mode specifications ───────────────────────────

// Video: 1500 Hz black to 2300 Hz white. Sync 1200 Hz.
const fOf = (v) => 1500 + (v * 800) / 255;

// Full-range Y, R−Y, B−Y as slowrx and QSSTV use them (Y = .30R+.59G+.11B;
// R−Y and B−Y scaled by 1/1.40 and 1/1.78 about 127.5).
function yuv(r, g, b) {
    const y = 0.30 * r + 0.59 * g + 0.11 * b;
    const c = (v) => Math.max(0, Math.min(255, v));
    return [c(y), c((r - y) / 1.40 + 127.5), c((b - y) / 1.78 + 127.5)];
}

// The VIS header: 300 ms leader, 10 ms break, 300 ms leader, start bit, seven
// data bits LSB first (1100 Hz one, 1300 Hz zero), even parity, stop bit.
function visSegments(code, { flipParity = false } = {}) {
    const s = [[1900, 0.3], [1200, 0.01], [1900, 0.3], [1200, 0.03]];
    let par = 0;
    for (let k = 0; k < 7; k++) { const b = (code >> k) & 1; par ^= b; s.push([b ? 1100 : 1300, 0.03]); }
    if (flipParity) par ^= 1;
    s.push([par ? 1100 : 1300, 0.03], [1200, 0.03]);
    return s;
}

// The line timings, from the published specifications (JL Barber N7CXI 2000,
// KB4YZ's line timing notes): seconds.
const ENCODERS = {
    'Martin 1': {
        vis: 44,
        lines(pic, out) {
            const px = 0.4576e-3;
            for (let y = 0; y < 256; y++) {
                const row = (c) => { for (let x = 0; x < 320; x++) out.push([fOf(pic.rgb[3 * (y * 320 + x) + c]), px]); };
                out.push([1200, 4.862e-3], [1500, 0.572e-3]);
                row(1); out.push([1500, 0.572e-3]);
                row(2); out.push([1500, 0.572e-3]);
                row(0); out.push([1500, 0.572e-3]);
            }
        },
    },
    'Scottie 1': {
        vis: 60,
        lines(pic, out) {
            const px = 0.432e-3;
            out.push([1200, 9e-3]);           // the one leading sync pulse
            for (let y = 0; y < 256; y++) {
                const row = (c) => { for (let x = 0; x < 320; x++) out.push([fOf(pic.rgb[3 * (y * 320 + x) + c]), px]); };
                out.push([1500, 1.5e-3]); row(1);
                out.push([1500, 1.5e-3]); row(2);
                out.push([1200, 9e-3], [1500, 1.5e-3]); row(0);
            }
        },
    },
    'Robot 36': {
        vis: 8,
        lines(pic, out) {
            for (let y = 0; y < 240; y++) {
                const p = (x) => yuv(...pic.rgb.subarray(3 * (y * 320 + x), 3 * (y * 320 + x) + 3));
                out.push([1200, 9e-3], [1500, 3e-3]);
                for (let x = 0; x < 320; x++) out.push([fOf(p(x)[0]), 88e-3 / 320]);
                // Even lines carry R−Y (1500 Hz separator), odd lines B−Y (2300).
                out.push([y & 1 ? 2300 : 1500, 4.5e-3], [1900, 1.5e-3]);
                for (let x = 0; x < 320; x++) out.push([fOf(p(x)[y & 1 ? 2 : 1]), 44e-3 / 320]);
            }
        },
    },
    'PD 120': {
        vis: 95,
        lines(pic, out) {
            const px = 0.19e-3;
            for (let y = 0; y < 496; y += 2) {
                const a = (x) => yuv(...pic.rgb.subarray(3 * (y * 640 + x), 3 * (y * 640 + x) + 3));
                const b = (x) => yuv(...pic.rgb.subarray(3 * ((y + 1) * 640 + x), 3 * ((y + 1) * 640 + x) + 3));
                out.push([1200, 20e-3], [1500, 2.08e-3]);
                for (let x = 0; x < 640; x++) out.push([fOf(a(x)[0]), px]);
                for (let x = 0; x < 640; x++) out.push([fOf((a(x)[1] + b(x)[1]) / 2), px]);
                for (let x = 0; x < 640; x++) out.push([fOf((a(x)[2] + b(x)[2]) / 2), px]);
                for (let x = 0; x < 640; x++) out.push([fOf(b(x)[0]), px]);
            }
        },
    },
};
const SIZES = { 'Martin 1': [320, 256], 'Scottie 1': [320, 256], 'Robot 36': [320, 240], 'PD 120': [640, 496] };

// Phase-continuous FM of the segments, sampled by a receiver whose clock runs
// `ppm` fast (so a line takes that many more samples than the decoder assumes),
// with white noise at `snrDb` in a 3 kHz band if given.
function synth(segments, rate, { ppm = 0, snrDb = null, lead = 0.4, tail = 0.4, seed = 1 } = {}) {
    const fsAct = rate * (1 + ppm * 1e-6);
    const total = segments.reduce((a, s) => a + s[1], 0) + lead + tail;
    const n = Math.floor(total * fsAct);
    const out = new Float64Array(n);
    const amp = 0.5;
    let seg = -1;
    let segEnd = lead;
    let f = 0;
    let ph = 0;
    for (let k = 0; k < n; k++) {
        const tt = k / fsAct;
        while (tt >= segEnd && seg < segments.length) {
            seg++;
            if (seg < segments.length) { f = segments[seg][0]; segEnd += segments[seg][1]; } else { f = 0; segEnd = Infinity; }
        }
        if (seg >= 0 && seg < segments.length) {
            ph += (2 * Math.PI * f) / fsAct;
            if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
            out[k] = amp * Math.sin(ph);
        }
    }
    if (snrDb != null) {
        // Noise power over the whole band such that 3 kHz of it is snrDb under the tone.
        const sigma = Math.sqrt(((amp * amp) / 2 / 10 ** (snrDb / 10)) * ((rate / 2) / 3000));
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
        for (let k = 0; k < n; k += 2) {
            const r = Math.sqrt(-2 * Math.log(rnd()));
            const a = 2 * Math.PI * rnd();
            out[k] += sigma * r * Math.cos(a);
            if (k + 1 < n) out[k + 1] += sigma * r * Math.sin(a);
        }
    }
    return out;
}

/**
 * An FSK ID as QSSTV's sendFSKID sends it (MMSSTV's WriteFSK the same): 300 ms
 * of 1500 Hz, 100 ms of 2100 Hz, a 1900 Hz bit, then 0x2A, the callsign's
 * symbols, 0x01 and their XOR — each symbol six 22 ms bits, low bit first,
 * 1900 Hz a 1 and 2100 Hz a 0 — and 100 ms of 1900 Hz to finish.
 */
function fskIdSegments(call, { badChecksum = false } = {}) {
    const s = [[1500, 0.3], [2100, 0.1], [1900, 0.022]];
    const sym = (v) => { for (let b = 0; b < 6; b++) s.push([(v >> b) & 1 ? 1900 : 2100, 0.022]); };
    sym(0x2a);
    let x = 0;
    for (const ch of call.toUpperCase()) { const v = ch.charCodeAt(0) - 0x20; x ^= v; sym(v); }
    sym(0x01);
    sym((x ^ (badChecksum ? 1 : 0)) & 0x3f);
    s.push([1900, 0.1]);
    return s;
}

function encode(mode, rate, opts = {}) {
    const enc = ENCODERS[mode];
    const [w, h] = SIZES[mode];
    const pic = testPicture(w, h);
    const segs = opts.noVis ? [] : visSegments(enc.vis, opts);
    enc.lines(pic, segs);
    if (opts.fskId) segs.push(...fskIdSegments(opts.fskId, opts));
    return { pic, segs, audio: synth(segs, rate, opts) };
}

// ── running the decoder ─────────────────────────────────────────────────────

function decode(audio, rate, options = {}, packet = 4096) {
    const d = new SstvDecoder({ sampleRate: rate, ...options });
    const images = [];
    const texts = [];
    const statuses = new Set();
    let cur = null;
    const take = () => {
        for (const e of d.drain()) {
            if (e.type === 'text') texts.push(e.text);
            if (e.type !== 'image') continue;
            if (e.event === 'start') {
                cur = { ...e, rows: new Array(e.height), first: new Array(e.height), sends: 0 };
                images.push(cur);
            } else if (e.event === 'line') {
                assert.strictEqual(e.id, cur.id);
                cur.sends++;
                if (!cur.first[e.y]) cur.first[e.y] = e.pixels;
                cur.rows[e.y] = e.pixels;
            } else if (e.event === 'end') {
                cur.end = e;
            } else if (e.event === 'info') {
                assert.strictEqual(e.id, cur.id, 'the ID names the picture it came after');
                cur.info = e;
            }
        }
    };
    for (let o = 0; o < audio.length; o += packet) {
        d.process(audio.subarray(o, Math.min(audio.length, o + packet)), Math.min(packet, audio.length - o));
        statuses.add(d.status().state);
        take();
    }
    take();
    return { images, texts, statuses, decoder: d };
}

// Mean absolute error, 0..255, over every channel of every pixel; rows from
// `which` ('rows' the last sent, 'first' as first drawn).
function mae(img, pic, which = 'rows') {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < pic.h; y++) {
        const row = img[which][y];
        for (let i = 0; i < pic.w * 3; i++) {
            sum += Math.abs((row ? row[i] : 0) - pic.rgb[3 * y * pic.w + i]);
            n++;
        }
    }
    return sum / n;
}

// ── a minimal WAV reader and PNG writer ─────────────────────────────────────

function readWav(file) {
    const b = fs.readFileSync(file);
    assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(b.toString('ascii', 8, 12), 'WAVE');
    let o = 12;
    let fmt = null;
    while (o + 8 <= b.length) {
        const id = b.toString('ascii', o, o + 4);
        const len = b.readUInt32LE(o + 4);
        if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
        if (id === 'data') {
            assert.ok(fmt && fmt.bits === 16, 'only 16-bit PCM');
            const frames = Math.floor(len / 2 / fmt.channels);
            const x = new Float64Array(frames);
            for (let i = 0; i < frames; i++) x[i] = b.readInt16LE(o + 8 + i * 2 * fmt.channels) / 32768;
            return { rate: fmt.rate, x };
        }
        o += 8 + len + (len & 1);
    }
    throw new Error('no data chunk');
}

const CRC_TABLE = (() => {
    const tab = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tab[n] = c >>> 0; }
    return tab;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function writePng(file, w, h, rows, colour) {
    const bpp = colour === 'gray' ? 1 : 3;
    const raw = Buffer.alloc(h * (1 + w * bpp));
    for (let y = 0; y < h; y++) {
        raw[y * (1 + w * bpp)] = 0;
        if (rows[y]) Buffer.from(rows[y].buffer, rows[y].byteOffset, w * bpp).copy(raw, y * (1 + w * bpp) + 1);
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = colour === 'gray' ? 0 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

// ── the mode table ──────────────────────────────────────────────────────────

t('every slowrx mode is there, and names are found loosely', () => {
    for (const n of ['Martin 1', 'Martin 2', 'Martin 3', 'Martin 4', 'Scottie 1', 'Scottie 2', 'Scottie DX',
        'Robot 72', 'Robot 36', 'Robot 24', 'Robot 24 B/W', 'Robot 12 B/W', 'Robot 8 B/W',
        'PD 50', 'PD 90', 'PD 120', 'PD 160', 'PD 180', 'PD 240', 'PD 290',
        'Pasokon P3', 'Pasokon P5', 'Pasokon P7', 'Wraase SC-2 120', 'Wraase SC-2 180']) {
        assert.ok(SSTV_MODES.includes(n), n);
    }
    assert.strictEqual(sstvModeByName('m1').name, 'Martin 1');
    assert.strictEqual(sstvModeByName('PD-120').name, 'PD 120');
    assert.strictEqual(sstvModeByName('scottie dx').name, 'Scottie DX');
    assert.strictEqual(sstvModeByName('nonsense'), null);
});

t('silence: listening, nothing sent', () => {
    const r = decode(new Float64Array(48000), 48000);
    assert.strictEqual(r.images.length, 0);
    assert.deepStrictEqual([...r.statuses], ['listening']);
    assert.deepStrictEqual(r.decoder.status(), { state: 'listening', mode: null, detail: { line: 0, of: 0, vis: null, callsign: null } });
});

// ── decoding the encoder's pictures ─────────────────────────────────────────

// The bounds. The picture has seven hard colour edges across; the decoder's
// shortest window is 1.09 ms (slowrx's 48 samples at 44.1 kHz), which smears
// each edge over the pixels that window spans — 2.4 Martin pixels, 4 of Robot
// 36's luminance and 8 of its chroma — and the YUV modes then turn a smeared
// chroma edge into a wrong colour at full contrast. Away from edges the level
// is within a few counts. So a clean picture must come back within 12 counts
// on average (measured: 1.6–2.1 GBR, 3.4–5.3 YUV). Noise at 10 dB in 3 kHz
// costs the GBR modes about 8 counts more and the YUV modes about 15, their
// R and B taking the chroma's noise 1.4 and 1.78 times over (measured: 10.5,
// 10.6, 18.6, 19.9) — so 22.
const CLEAN_MAE = 12;
const NOISY_MAE = 22;

const results = [];
function check(mode, rate, opts, bound, label) {
    t(`${mode} at ${rate} Hz${label ? ', ' + label : ''}: VIS found, picture back within ${bound}`, () => {
        const { pic, audio } = encode(mode, rate, opts);
        const r = decode(audio, rate, opts.decoder || {});
        assert.strictEqual(r.images.length, 1, `images: ${r.images.length}; ${r.texts.join(' ')}`);
        const img = r.images[0];
        assert.strictEqual(img.mode, mode);
        assert.deepStrictEqual([img.width, img.height, img.colour], [pic.w, pic.h, 'rgb']);
        assert.ok(img.end && img.end.complete, 'no end');
        assert.ok(r.statuses.has('receiving'));
        if (!opts.noVis) assert.ok(r.texts[0].startsWith(`VIS ${ENCODERS[mode].vis} — ${mode}`), r.texts[0]);
        const final = mae(img, pic);
        const first = mae(img, pic, 'first');
        const last = r.decoder.lastImage;
        results.push({ mode, rate, label: label || 'clean', final, first, ppm: (last.rate / rate - 1) * 1e6, phaseMs: (last.skip / last.rate) * 1000 });
        assert.ok(final < bound, `MAE ${final.toFixed(2)} (first pass ${first.toFixed(2)})`);
        if (opts.ppm) {
            const ppm = (last.rate / rate - 1) * 1e6;
            assert.ok(Math.abs(ppm - opts.ppm) < 40, `slant found ${ppm.toFixed(1)} ppm, sent ${opts.ppm}`);
        }
    });
}

for (const mode of Object.keys(ENCODERS)) {
    for (const rate of [11025, 12000, 48000]) check(mode, rate, {}, CLEAN_MAE);
    check(mode, 11025, { snrDb: 10 }, NOISY_MAE, 'noise 10 dB in 3 kHz');
    check(mode, 12000, { ppm: 100 }, CLEAN_MAE, '+100 ppm');
}

t('Martin 1 at 8000 Hz decodes too', () => {
    const { pic, audio } = encode('Martin 1', 8000);
    const r = decode(audio, 8000);
    assert.strictEqual(r.images[0].mode, 'Martin 1');
    const e = mae(r.images[0], pic);
    results.push({ mode: 'Martin 1', rate: 8000, label: 'clean', final: e, first: mae(r.images[0], pic, 'first'), ppm: 0, phaseMs: 0 });
    assert.ok(e < CLEAN_MAE, `MAE ${e.toFixed(2)}`);
});

t('a bad VIS parity is not a picture', () => {
    const { audio } = encode('Robot 36', 12000, { flipParity: true });
    const r = decode(audio, 12000);
    assert.strictEqual(r.images.length, 0);
});

t('slant off: one pass, at the nominal rate', () => {
    const { pic, audio } = encode('Robot 36', 12000);
    const r = decode(audio, 12000, { slant: false });
    const img = r.images[0];
    assert.strictEqual(img.sends, 240);
    assert.ok(mae(img, pic) < CLEAN_MAE + 4, `MAE ${mae(img, pic).toFixed(2)}`);
});

t('slant on: every line sent again, then the end', () => {
    const { audio } = encode('Robot 36', 12000);
    const r = decode(audio, 12000);
    assert.strictEqual(r.images[0].sends, 480);
    assert.ok(r.texts.some((s) => s.startsWith('END Robot 36')));
});

t('a forced mode with no VIS starts on the first sync', () => {
    const { pic, audio } = encode('Martin 1', 12000, { noVis: true });
    assert.strictEqual(decode(audio, 12000).images.length, 0);
    const r = decode(audio, 12000, { mode: 'Martin 1' });
    assert.strictEqual(r.images.length, 1);
    assert.strictEqual(r.images[0].mode, 'Martin 1');
    const e = mae(r.images[0], pic);
    results.push({ mode: 'Martin 1', rate: 12000, label: 'forced, no VIS', final: e, first: mae(r.images[0], pic, 'first'), ppm: 0, phaseMs: 0 });
    assert.ok(e < CLEAN_MAE, `MAE ${e.toFixed(2)}`);
});

t('reset mid-picture goes back to listening', () => {
    const { audio } = encode('Robot 36', 11025);
    const d = new SstvDecoder({ sampleRate: 11025 });
    d.process(audio.subarray(0, 11025 * 5), 11025 * 5);
    assert.strictEqual(d.status().state, 'receiving');
    assert.strictEqual(d.status().mode, 'Robot 36');
    assert.strictEqual(d.status().detail.vis, 8);
    assert.ok(d.status().detail.line > 0 && d.status().detail.of === 240);
    d.reset();
    assert.strictEqual(d.status().state, 'listening');
    assert.deepStrictEqual(d.drain(), []);
});

// ── a real recording ────────────────────────────────────────────────────────

if (!fs.existsSync(REAL_WAV)) {
    console.log(`skip  the real recording: ${REAL_WAV} is not here`);
} else {
    t('the real recording: a VIS, a whole picture, written to a PNG', () => {
        const { rate, x } = readWav(REAL_WAV);
        // The file stops a fraction of a line before the picture does; a live
        // stream would carry on, so two seconds of silence follow it.
        const audio = new Float64Array(x.length + 2 * rate);
        audio.set(x);
        const r = decode(audio, rate);
        assert.ok(r.texts.some((s) => s.startsWith('VIS ')), 'no VIS: ' + r.texts.join(' '));
        assert.ok(r.images.length >= 1);
        const img = r.images[0];
        const got = img.rows.filter(Boolean).length;
        assert.strictEqual(got, img.height);
        assert.ok(img.end && img.end.complete);
        const file = path.join(SCRATCH, 'sstv_real.png');
        writePng(file, img.width, img.height, img.rows, img.colour);
        console.log(`      ${r.texts.join('      ').trim()}`);
        console.log(`      ${img.mode}, ${img.width}×${img.height} ${img.colour}, ${got} rows → ${file}`);
    });
}

t('the SSTV block: Martin 1 audio in packets, into an Image viewer’s gallery — one complete colour picture, as the decoder draws it', () => {
    const rate = 12000;
    const { pic, audio } = encode('Martin 1', rate);
    const def = BLOCK_BY_TYPE.sstv;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), rate);
    const gallery = new Gallery(4);
    const texts = [];
    const tail = new Float64Array(rate); // a live stream carries on after the picture
    const all = new Float64Array(audio.length + tail.length);
    all.set(audio);
    let busy = false;
    for (let k = 0; k < all.length; k += 240) {
        const len = Math.min(240, all.length - k);
        const x = makeBuffer('real', 240);
        x.re.set(all.subarray(k, k + len));
        x.n = len;
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([x], outs, len);
        for (const e of outs[0].list) gallery.apply(e);
        for (const e of outs[1].list) texts.push(e.text);
        if (inst.read().state === 'receiving') busy = true;
    }
    assert.ok(busy, 'never receiving');
    assert.strictEqual(gallery.pictures.length, 1);
    const g = gallery.pictures[0];
    assert.deepStrictEqual([g.width, g.rows, g.colour, g.complete, g.mode], [pic.w, pic.h, 'rgb', true, 'Martin 1']);
    let sum = 0;
    for (let i = 0; i < pic.w * pic.h; i++) for (let c = 0; c < 3; c++) sum += Math.abs(g.data[4 * i + c] - pic.rgb[3 * i + c]);
    const err = sum / (pic.w * pic.h * 3);
    assert.ok(err < CLEAN_MAE, `MAE ${err.toFixed(2)}`);
    assert.ok(texts[0].startsWith('VIS 44'), JSON.stringify(texts));
    assert.strictEqual(inst.read().state, 'listening');
});

// ── the FSK ID ──────────────────────────────────────────────────────────────

for (const [mode, rate, opts, call] of [
    ['Martin 1', 12000, {}, 'M9PSY'],
    ['Robot 36', 48000, {}, 'G4ABC/P'],
    ['Robot 36', 11025, { snrDb: 10 }, 'VK2XYZ'],
    ['Scottie 1', 12000, { ppm: 100 }, 'JA1QRZ'],
    ['PD 120', 8000, {}, 'W1AW'],
]) {
    const label = [opts.snrDb != null ? `noise ${opts.snrDb} dB` : '', opts.ppm ? `+${opts.ppm} ppm` : ''].filter(Boolean).join(', ') || 'clean';
    t(`FSK ID after ${mode} at ${rate} Hz (${label}): "${call}" read, and attached to the picture`, () => {
        const { audio } = encode(mode, rate, { ...opts, fskId: call });
        const r = decode(audio, rate);
        assert.strictEqual(r.images.length, 1);
        const ids = r.texts.filter((x) => x.startsWith('ID '));
        assert.deepStrictEqual(ids, [`ID ${call}\n`], r.texts.join(''));
        assert.ok(r.images[0].info, 'no info event');
        assert.strictEqual(r.images[0].info.callsign, call);
        assert.strictEqual(r.decoder.status().detail.callsign, call);
        // After the picture's END.
        assert.ok(r.texts.findIndex((x) => x.startsWith('END')) < r.texts.findIndex((x) => x.startsWith('ID ')));
    });
}

t('FSK ID with a wrong checksum is not believed; no ID at all, nothing said', () => {
    const bad = decode(encode('Robot 36', 12000, { fskId: 'M9PSY', badChecksum: true }).audio, 12000);
    assert.strictEqual(bad.images.length, 1);
    assert.ok(!bad.texts.some((x) => x.startsWith('ID ')), bad.texts.join(''));
    assert.ok(!bad.images[0].info);
    const none = decode(encode('Robot 36', 12000).audio, 12000);
    assert.ok(!none.texts.some((x) => x.startsWith('ID ')));
    assert.strictEqual(none.decoder.status().detail.callsign, null);
});

t('FSK ID through the block: the gallery’s picture carries the callsign', () => {
    const rate = 12000;
    const { audio } = encode('Robot 36', rate, { fskId: 'M9PSY' });
    const def = BLOCK_BY_TYPE.sstv;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), rate);
    const gallery = new Gallery(4);
    for (let k = 0; k < audio.length; k += 240) {
        const len = Math.min(240, audio.length - k);
        const x = makeBuffer('real', 240);
        x.re.set(audio.subarray(k, k + len));
        x.n = len;
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([x], outs, len);
        for (const e of outs[0].list) gallery.apply(e);
    }
    assert.strictEqual(gallery.pictures.length, 1);
    assert.strictEqual(gallery.pictures[0].callsign, 'M9PSY');
    assert.strictEqual(inst.read().detail.callsign, 'M9PSY');
});

// ── the stages as blocks ────────────────────────────────────────────────────

// A block's outputs, fresh for a packet.
const outsOf = (def, size) => def.outputs.map((o) => makeBuffer(o.kind, size));

// Every control value put out, in order.
const controlLog = () => { const log = []; let seq = 0; return { log, take(buf) { if (buf.seq !== seq) { seq = buf.seq; log.push(buf.value); } } }; };

// The demodulator block into the raster block, wired by hand, `packet`
// samples at a time, the raster's pictures into a Gallery.
function runChain(audio, rate, { packet = 300, demodParams = {}, rasterParams = {} } = {}) {
    const dd = SstvDemodBlock;
    const rd = SstvRasterBlock;
    const demod = dd.create();
    demod.configure(sanitizeParams(dd, demodParams), rate);
    const raster = rd.create();
    raster.configure(sanitizeParams(rd, rasterParams), rate);
    const gallery = new Gallery(4);
    const texts = [];
    const calls = [];
    const receiving = controlLog();
    const progress = controlLog();
    const snr = controlLog();
    const x = makeBuffer('real', packet);
    const dOuts = outsOf(dd, packet);
    const rOuts = outsOf(rd, 1);
    const t0 = Date.now();
    for (let k = 0; k < audio.length; k += packet) {
        const len = Math.min(packet, audio.length - k);
        x.re.set(audio.subarray(k, k + len));
        x.n = len;
        const m = demod.process([x], dOuts, len);
        assert.strictEqual(m, len);
        for (const o of dOuts) o.n = m;
        snr.take(dOuts[2]);
        for (const o of rOuts) if (o.list) o.list.length = 0;
        raster.process([dOuts[0], dOuts[1]], rOuts, m);
        for (const e of rOuts[0].list) gallery.apply(e);
        for (const e of rOuts[1].list) texts.push(e.text);
        for (const e of rOuts[2].list) calls.push(e);
        receiving.take(rOuts[3]);
        progress.take(rOuts[4]);
    }
    return { gallery, texts, calls, receiving: receiving.log, progress: progress.log, snr: snr.log, demod, raster, ms: Date.now() - t0 };
}

// A gallery picture against the test picture: mean absolute error, 0..255.
function galleryMae(g, pic) {
    let sum = 0;
    for (let i = 0; i < pic.w * pic.h; i++) for (let c = 0; c < 3; c++) sum += Math.abs(g.data[4 * i + c] - pic.rgb[3 * i + c]);
    return sum / (pic.w * pic.h * 3);
}

const withTail = (audio, rate, secs = 1) => { const a = new Float64Array(audio.length + Math.round(secs * rate)); a.set(audio); return a; };

t('sstv-demod on its own: a tone’s frequency within 15 Hz, shifted ones too; the sync ratio high on 1200 Hz only; output late by its latency', () => {
    const rate = 12000;
    const tones = [1900, 1200, 2100, 2050, 1100];
    const segLen = Math.round(0.3 * rate);
    const audio = synth(tones.map((f) => [f, 0.3]), rate, { lead: 0, tail: 0 });
    const def = SstvDemodBlock;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), rate);
    const D = inst.latency();
    assert.ok(D > 0 && D < 0.02 * rate, `latency ${D}`);
    const hz = new Float64Array(audio.length);
    const sync = new Float64Array(audio.length);
    const outs = outsOf(def, 300);
    const snr = controlLog();
    const x = makeBuffer('real', 300);
    for (let k = 0; k < audio.length; k += 300) {
        const len = Math.min(300, audio.length - k);
        x.re.set(audio.subarray(k, k + len));
        assert.strictEqual(inst.process([x], outs, len), len);
        hz.set(outs[0].re.subarray(0, len), k);
        sync.set(outs[1].re.subarray(0, len), k);
        snr.take(outs[2]);
    }
    tones.forEach((f, i) => {
        // The middle of each tone, where the output (D late) shows it.
        const mid = i * segLen + (segLen >> 1) + D;
        // slowrx's Gaussian interpolation of a Hann window's peak is off by up
        // to about 12 Hz depending on where the tone falls between bins — 4
        // counts of brightness at most.
        assert.ok(Math.abs(hz[mid] - f) < 15, `${f} Hz read ${hz[mid].toFixed(1)}`);
        if (f === 1200) assert.ok(sync[mid] > 2, `sync ratio on 1200 Hz ${sync[mid]}`);
        else if (f !== 1100) assert.ok(sync[mid] < 2, `sync ratio on ${f} Hz ${sync[mid]}`);
    });
    // The 1900→1200 step shows D samples late, within a sync hop.
    let step = -1;
    for (let i = segLen - 50; i < segLen + D + 100; i++) if (hz[i] < 1550) { step = i; break; }
    assert.ok(Math.abs(step - (segLen + D)) <= Math.ceil((6 * rate) / 44100) + 2, `step at ${step}, expected ${segLen + D}`);
    assert.ok(snr.log.length > 0, 'no SNR');
});

// The ideal streams the raster expects: the encoder's own frequency for every
// sample, and a sync ratio of 10 on the 1200 Hz pulses, 0 elsewhere.
function idealStreams(segs, rate, lead = 0.4, tail = 0.4) {
    const total = segs.reduce((a, s) => a + s[1], 0) + lead + tail;
    const n = Math.floor(total * rate);
    const hz = new Float64Array(n);
    const sync = new Float64Array(n);
    let seg = -1;
    let end = lead;
    let f = 0;
    for (let k = 0; k < n; k++) {
        const tt = k / rate;
        while (tt >= end && seg < segs.length) { seg++; if (seg < segs.length) { f = segs[seg][0]; end += segs[seg][1]; } else { f = 0; end = Infinity; } }
        hz[k] = seg >= 0 ? f : 0;
        sync[k] = seg >= 0 && f === 1200 ? 10 : 0;
    }
    return { hz, sync };
}

t('sstv-raster on its own: ideal frequency and sync streams in, the picture out — nearly exact; receiving and progress said', () => {
    const rate = 12000;
    const { pic, segs } = encode('Robot 36', rate, { fskId: 'G4ABC' });
    const { hz, sync } = idealStreams(segs, rate, 0.4, 1.4);
    const def = SstvRasterBlock;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), rate);
    const gallery = new Gallery(4);
    const texts = [];
    const calls = [];
    const receiving = controlLog();
    const progress = controlLog();
    const outs = outsOf(def, 1);
    for (let k = 0; k < hz.length; k += 300) {
        const len = Math.min(300, hz.length - k);
        const a = makeBuffer('real', len);
        const b = makeBuffer('real', len);
        a.re.set(hz.subarray(k, k + len));
        b.re.set(sync.subarray(k, k + len));
        for (const o of outs) if (o.list) o.list.length = 0;
        assert.strictEqual(inst.process([a, b], outs, len), 0);
        for (const e of outs[0].list) gallery.apply(e);
        for (const e of outs[1].list) texts.push(e.text);
        for (const e of outs[2].list) calls.push(e);
        receiving.take(outs[3]);
        progress.take(outs[4]);
    }
    assert.ok(texts[0].startsWith('VIS 8 — Robot 36'), texts.join(''));
    assert.strictEqual(gallery.pictures.length, 1);
    const g = gallery.pictures[0];
    assert.deepStrictEqual([g.width, g.rows, g.mode, g.complete], [320, 240, 'Robot 36', true]);
    const e = galleryMae(g, pic);
    results.push({ mode: 'Robot 36', rate, label: 'raster alone, ideal', final: e, first: NaN, ppm: 0, phaseMs: 0 });
    // Only the chroma subsampling and 8-bit rounding are left.
    assert.ok(e < 3, `MAE ${e.toFixed(2)}`);
    assert.deepStrictEqual(calls, [{ type: 'text', text: 'G4ABC' }]);
    assert.deepStrictEqual(receiving.log, [0, 1, 0]);
    assert.strictEqual(progress.log[0], 0);
    assert.strictEqual(progress.log[progress.log.length - 1], 1);
    assert.ok(progress.log.length > 50, `${progress.log.length} progress steps`);
    for (let i = 1; i < progress.log.length; i++) assert.ok(progress.log[i] >= progress.log[i - 1]);
    assert.deepStrictEqual(inst.read().detail, { line: 0, of: 0, vis: 8, callsign: 'G4ABC' });
});

for (const [mode, rate, opts, bound, label] of [
    ['Martin 1', 12000, {}, CLEAN_MAE, 'chain, clean'],
    ['PD 120', 11025, {}, CLEAN_MAE, 'chain, clean'],
    ['Robot 36', 11025, { snrDb: 10 }, NOISY_MAE, 'chain, noise 10 dB'],
    ['Scottie 1', 12000, { snrDb: 10, ppm: 100 }, NOISY_MAE, 'chain, noise, +100 ppm'],
]) {
    t(`the chain of blocks, ${mode} at ${rate} Hz (${label}): into a gallery within ${bound}`, () => {
        const { pic, audio } = encode(mode, rate, opts);
        const r = runChain(withTail(audio, rate), rate);
        assert.ok(r.texts[0].startsWith(`VIS ${ENCODERS[mode].vis} — ${mode}`), r.texts.join(''));
        assert.strictEqual(r.gallery.pictures.length, 1);
        const g = r.gallery.pictures[0];
        assert.deepStrictEqual([g.width, g.rows, g.mode, g.complete], [pic.w, pic.h, mode, true]);
        const e = galleryMae(g, pic);
        results.push({ mode, rate, label, final: e, first: NaN, ppm: NaN, phaseMs: NaN });
        assert.ok(e < bound, `MAE ${e.toFixed(2)}`);
        assert.deepStrictEqual(r.receiving, [0, 1, 0]);
        assert.strictEqual(r.progress[r.progress.length - 1], 1);
    });
}

t('the chain of blocks: the FSK ID — the callsign once, on its own output, and on the picture', () => {
    const rate = 12000;
    const { audio } = encode('Martin 1', rate, { fskId: 'M9PSY' });
    const r = runChain(audio, rate, { packet: 256 });
    assert.deepStrictEqual(r.calls, [{ type: 'text', text: 'M9PSY' }]);
    assert.deepStrictEqual(r.texts.filter((s) => s.startsWith('ID ')), ['ID M9PSY\n']);
    assert.strictEqual(r.gallery.pictures[0].callsign, 'M9PSY');
    assert.strictEqual(r.raster.read().detail.callsign, 'M9PSY');
    assert.deepStrictEqual(r.receiving, [0, 1, 0]);
    assert.strictEqual(r.progress[0], 0);
    assert.strictEqual(r.progress[r.progress.length - 1], 1);
});

t('the chain of blocks at 48 kHz: Martin 1 decodes, faster than it is sent', () => {
    const rate = 48000;
    const { pic, audio } = encode('Martin 1', rate);
    const r = runChain(withTail(audio, rate), rate, { packet: 480 });
    const g = r.gallery.pictures[0];
    const e = galleryMae(g, pic);
    const secs = audio.length / rate;
    results.push({ mode: 'Martin 1', rate, label: `chain, ${(secs / (r.ms / 1000)).toFixed(1)}× real time`, final: e, first: NaN, ppm: NaN, phaseMs: NaN });
    assert.ok(e < CLEAN_MAE, `MAE ${e.toFixed(2)}`);
    assert.ok(r.ms < secs * 1000, `${r.ms} ms for ${secs.toFixed(0)} s`);
    console.log(`      ${secs.toFixed(0)} s of 48 kHz audio in ${(r.ms / 1000).toFixed(1)} s (${(secs / (r.ms / 1000)).toFixed(1)}× real time)`);
});

if (fs.existsSync(REAL_WAV)) {
    t('the chain of blocks: the real recording — Martin 1, whole, the same picture the decoder draws', () => {
        const { rate, x } = readWav(REAL_WAV);
        const audio = withTail(x, rate, 2);
        const r = runChain(audio, rate, { packet: 441 });
        assert.ok(r.texts[0].startsWith('VIS 44 — Martin 1'), r.texts.join(''));
        const g = r.gallery.pictures[0];
        assert.deepStrictEqual([g.width, g.rows, g.mode, g.complete], [320, 256, 'Martin 1', true]);
        // The decoder in one piece, for comparison: the same picture, to rounding.
        const d = decode(audio, rate);
        const rows = d.images[0].rows;
        let sum = 0;
        for (let y = 0; y < 256; y++) for (let i = 0; i < 320; i++) for (let c = 0; c < 3; c++) sum += Math.abs(g.data[4 * (y * 320 + i) + c] - rows[y][3 * i + c]);
        const diff = sum / (320 * 256 * 3);
        assert.ok(diff < 1, `chain and decoder differ by ${diff.toFixed(2)}`);
        assert.deepStrictEqual(r.receiving, [0, 1, 0]);
    });
}

t('the SSTV block expands into its stages; the expanded graph draws the same picture, says the same, and its controls pass through', () => {
    const rate = 12000;
    const { audio } = encode('Robot 36', rate, { fskId: 'M9PSY' });
    const g = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'iq', type: 'iq-in' }, { id: 're', type: 'real-part' }, { id: 'sstv', type: 'sstv' },
            { id: 'viewer', type: 'image-viewer' }, { id: 'con', type: 'console' }, { id: 'calls', type: 'console' },
            { id: 'rx', type: 'control-plot' },
        ],
        wires: [
            ['iq', 'out', 're', 'in'], ['re', 'out', 'sstv', 'audio'], ['sstv', 'images', 'viewer', 'in'],
            ['sstv', 'text', 'con', 'in'], ['sstv', 'callsign', 'calls', 'in'], ['sstv', 'receiving', 'rx', 'in'],
        ],
    }).graph;
    const run = (graph) => {
        const rt = new Runtime(graph, rate);
        assert.ok(rt.ok, JSON.stringify(rt.errors));
        const gallery = new Gallery(4);
        const f = Float32Array.from(audio);
        const q = new Float32Array(240);
        const rx = [];
        for (let k = 0; k < f.length; k += 240) {
            const len = Math.min(240, f.length - k);
            rt.process({ i: f.subarray(k, k + len), q: q.subarray(0, len), frames: len, rate });
            for (const e of rt.drainEvents('viewer') || []) gallery.apply(e);
            // The receiving control, from the block (or, expanded, its raster).
            const src = [...rt.nodes.values()].find((n) => n.type.type === 'sstv' || n.type.type === 'sstv-raster');
            const out = src.outs[src.type.outputs.findIndex((o) => o.name === 'receiving')];
            if (out.value != null && rx[rx.length - 1] !== out.value) rx.push(out.value);
        }
        return { gallery, text: rt.read('con').text, calls: rt.read('calls').text, rx };
    };
    const one = run(g);
    const { graph: x, ids } = expandDecoder(g, 'sstv');
    assert.ok(compile(x, rate).ok, JSON.stringify(compile(x, rate).errors));
    assert.deepStrictEqual(x.nodes.filter((n) => ids.includes(n.id)).map((n) => n.type).sort(), ['sstv-demod', 'sstv-raster']);
    const two = run(x);
    for (const r of [one, two]) {
        assert.strictEqual(r.gallery.pictures.length, 1);
        assert.strictEqual(r.gallery.pictures[0].callsign, 'M9PSY');
        assert.ok(r.text.includes('VIS 8') && r.text.includes('ID M9PSY'), r.text);
        assert.strictEqual(r.calls.trim(), 'M9PSY');
        assert.deepStrictEqual(r.rx.slice(-2), [1, 0], JSON.stringify(r.rx));
    }
    const a = one.gallery.pictures[0].view().data;
    const b = two.gallery.pictures[0].view().data;
    assert.ok(a.length === b.length && a.every((v, i) => v === b[i]), 'the pictures differ');
    assert.strictEqual(one.text, two.text);
});

console.log('\n  mode         rate   case                     MAE final  first pass  slant ppm  phase ms');
for (const r of results) {
    console.log(`  ${r.mode.padEnd(11)} ${String(r.rate).padStart(6)}   ${r.label.padEnd(24)} ${r.final.toFixed(2).padStart(9)}  ${(Number.isNaN(r.first) ? '' : r.first.toFixed(2)).padStart(10)}  ${(Number.isNaN(r.ppm) ? '' : r.ppm.toFixed(1)).padStart(9)}  ${(Number.isNaN(r.phaseMs) ? '' : r.phaseMs.toFixed(2)).padStart(8)}`);
}
console.log(`\n${pass} passed`);
