// The WEFAX decoder (image/wefax.js), against an independent encoder written
// here from the WMO/ITU radiofax format: START tone, phasing lines, picture,
// STOP tone, as an FM subcarrier (1500 Hz black, 2300 Hz white).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
    WefaxDecoder, WefaxFrontEnd, WefaxRaster, FaxRasterBlock, wefaxFrontEndStages,
    HilbertBlock, ShiftBlock, LowpassBlock, DiscriminatorBlock,
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, Gallery,
    Runtime, GRAPH_VERSION, parseGraph, compile, expandDecoder,
} = require('./.build/playgroundwefax.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const SCRATCH = '/tmp/claude-1000/-home-nathan-repos-ka9q-ubersdr/568b4257-04cf-4145-9223-136ec760cbc5/scratchpad';

// ── the encoder ─────────────────────────────────────────────────────────────

// The test picture: a gradient on the left half, bars on the right, and a
// black band across rows 40–49 so the vertical position can be checked too.
const BAND = [40, 50];
function picture(row, u) {
    if (row >= BAND[0] && row < BAND[1]) return 0;
    if (u < 0.5) return Math.round(255 * (u / 0.5));
    return Math.floor((u - 0.5) * 32) % 2 ? 255 : 0;
}

// A deterministic Gaussian source, so a failure reproduces.
function gaussian(seed) {
    let s = seed >>> 0;
    const uni = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
}

/**
 * Transmission audio (or with `levels`, its FM level) at `rate` samples a
 * second as the decoder will be told,
 * while the encoder's own clock runs at rate·(1 + ppm·1e-6) — a sound card
 * whose crystal is off by `ppm`.
 */
function encodeWefax({ rate, lpm = 120, ioc = 576, lines = 160, ppm = 0, noise = 0, seed = 1, lead = 2, levels = false }) {
    const trueRate = rate * (1 + ppm * 1e-6);
    const linePeriod = 60 / lpm;
    const startHz = ioc === 288 ? 675 : 300;
    // Black lead-in, START 5 s, phasing 30 s, picture, STOP 5 s, black tail.
    const tStart = lead, tPhase = tStart + 5, tPic = tPhase + 30;
    const tStop = tPic + lines * linePeriod, tTail = tStop + 5, tEnd = tTail + 3;
    const n = Math.ceil(tEnd * trueRate);
    const out = new Float64Array(n);
    const g = gaussian(seed);
    let phase = 0;
    for (let k = 0; k < n; k++) {
        const tt = k / trueRate;
        let v;
        if (tt < tStart) v = 0;
        else if (tt < tPhase) v = ((tt - tStart) * startHz) % 1 < 0.5 ? 255 : 0;
        else if (tt < tPic) {
            // Phasing: black, with a white pulse 5% of a line long centred on
            // the line boundary (2.5% at each end of the line).
            const u = ((tt - tPhase) / linePeriod) % 1;
            v = u < 0.025 || u >= 0.975 ? 255 : 0;
        } else if (tt < tStop) {
            const pos = (tt - tPic) / linePeriod;
            v = picture(Math.floor(pos), pos % 1);
        } else if (tt < tTail) v = ((tt - tStop) * 450) % 1 < 0.5 ? 255 : 0;
        else v = 0;
        phase += (2 * Math.PI * (1500 + (800 * v) / 255)) / trueRate;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        // `levels`: what an ideal FM discriminator would give, −1 black, +1 white.
        out[k] = levels ? (2 * v) / 255 - 1 : 0.5 * Math.sin(phase) + (noise ? noise * g() : 0);
    }
    return out;
}

// Feed in packets of uneven size, as a stream would arrive.
function runDecoder(audio, opts) {
    const d = new WefaxDecoder(opts);
    const events = [];
    const states = new Set();
    let k = 0, i = 0;
    while (k < audio.length) {
        const len = Math.min(audio.length - k, 700 + ((i++ * 937) % 3100));
        d.process(audio.subarray(k, k + len), len);
        k += len;
        states.add(d.status().state);
        for (const e of d.drain()) events.push(e);
    }
    return { d, events, states };
}

function collect(events) {
    const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
    const starts = events.filter((e) => e.type === 'image' && e.event === 'start');
    const ends = events.filter((e) => e.type === 'image' && e.event === 'end');
    const rows = [];
    for (const e of events) if (e.type === 'image' && e.event === 'line') rows[e.y] = e.pixels;
    return { texts, starts, ends, rows };
}

// Mean absolute error of decoded rows against the picture, rows `r0..` of the
// decode being picture rows 0.., shifted `dx` pixels. Rows next to the band's
// edges are left out: the decoder's vertical blend smears them by design.
function mae(rows, width, r0, dx, lines, from = 0, to = lines) {
    let sum = 0, cnt = 0;
    for (let r = from; r < to; r++) {
        if (Math.abs(r - BAND[0]) <= 1 || Math.abs(r - BAND[1]) <= 1) continue;
        const row = rows[r0 + r];
        if (!row) continue;
        for (let x = 0; x < width; x++) {
            const xs = x + dx;
            if (xs < 0 || xs >= width) continue;
            sum += Math.abs(row[xs] - picture(r, (x + 0.5) / width));
            cnt++;
        }
    }
    return cnt ? sum / cnt : Infinity;
}

// The vertical and horizontal registration that fits best.
function bestFit(rows, width, lines, { from = 0, to = lines, dxRange = 40 } = {}) {
    let best = { err: Infinity, r0: 0, dx: 0 };
    for (let r0 = 0; r0 < Math.min(80, rows.length); r0++) {
        const e = mae(rows, width, r0, 0, lines, from, to);
        if (e < best.err) best = { err: e, r0, dx: 0 };
    }
    for (let dx = -dxRange; dx <= dxRange; dx++) {
        const e = mae(rows, width, best.r0, dx, lines, from, to);
        if (e < best.err) best = { ...best, err: e, dx };
    }
    return best;
}

function writePng(file, rows, width) {
    const h = rows.length;
    const raw = Buffer.alloc((width + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (width + 1)] = 0;
        if (rows[y]) Buffer.from(rows[y].buffer, rows[y].byteOffset, width).copy(raw, y * (width + 1) + 1);
    }
    const table = new Int32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c;
    });
    const crc = (buf) => {
        let c = -1;
        for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

const report = [];

// A full transmission at one rate, checked end to end.
function checkTransmission(label, enc, dec = {}, { maxErr = 12, png = null } = {}) {
    const lines = enc.lines || 160;
    const audio = encodeWefax({ ...enc, lines });
    const { events, states } = runDecoder(audio, { sampleRate: enc.rate, ...dec });
    const { texts, starts, ends, rows } = collect(events);
    const ioc = enc.ioc || 576;
    const width = Math.floor(Math.PI * ioc);
    assert.deepStrictEqual(texts.filter((x) => x !== 'no phasing\n'), [`START ${ioc}\n`, 'phasing\n', 'STOP\n'], `texts ${JSON.stringify(texts)}`);
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].mode, `WEFAX ${enc.lpm || 120}/${ioc}`);
    assert.strictEqual(starts[0].width, width);
    assert.strictEqual(starts[0].height, null);
    assert.strictEqual(starts[0].colour, 'gray');
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].complete, true);
    assert.strictEqual(ends[0].id, starts[0].id);
    assert.ok(states.has('phasing') && states.has('receiving') && states.has('idle'), [...states].join());
    for (const r of rows) assert.strictEqual(r.length, width);
    const fit = bestFit(rows, width, lines);
    const at0 = mae(rows, width, fit.r0, 0, lines);
    report.push(`${label}: ${rows.length} rows, picture from row ${fit.r0}, best dx ${fit.dx}, MAE ${at0.toFixed(2)} at dx 0 (${fit.err.toFixed(2)} best)`);
    // Phasing puts the line start where the format says: no shift needed.
    assert.ok(Math.abs(fit.dx) <= 3, `dx ${fit.dx}`);
    assert.ok(at0 < maxErr, `MAE ${at0.toFixed(2)}`);
    if (png) writePng(path.join(SCRATCH, png), rows, width);
    return { rows, fit, width };
}

// ── tests ───────────────────────────────────────────────────────────────────

for (const rate of [8000, 11025, 12000, 48000]) {
    t(`a transmission at ${rate} Hz: START, phasing, picture aligned, STOP`, () => {
        checkTransmission(`${rate} Hz`, { rate }, {}, { png: rate === 12000 ? 'wefax_synth.png' : null });
    });
}

t('44100 Hz and 22050 Hz work too (decimated by 4 and 2)', () => {
    checkTransmission('44100 Hz', { rate: 44100, lines: 80 });
    checkTransmission('22050 Hz', { rate: 22050, lines: 80 });
});

// The picture's rows below the band, taken down the page by their median:
// noise averages out (the median, unlike the mean, unbiased by noise clipped
// at black and white), misalignment does not.
function profileMae(rows, width, r0, lines) {
    const col = [];
    let sum = 0;
    for (let x = 0; x < width; x++) {
        col.length = 0;
        for (let r = BAND[1] + 2; r < lines; r++) if (rows[r0 + r]) col.push(rows[r0 + r][x]);
        col.sort((a, b) => a - b);
        sum += Math.abs(col[col.length >> 1] - picture(lines - 1, (x + 0.5) / width));
    }
    return sum / width;
}

t('with noise (12 dB SNR in 3 kHz) the picture still comes through, aligned', () => {
    for (const rate of [12000, 48000]) {
        const lines = 120;
        // Noise power 0.0079 (12 dB down) in 3 kHz against the carrier's 0.125.
        const noise = Math.sqrt(0.0079 * (rate / 2) / 3000);
        const { rows, fit, width } = checkTransmission(`${rate} Hz, 12 dB SNR`, { rate, lines, noise, seed: 7 }, {}, { maxErr: 40 });
        const p = profileMae(rows, width, fit.r0, lines);
        report.push(`${rate} Hz, 12 dB SNR: column-median MAE ${p.toFixed(2)}`);
        assert.ok(p < 12, `profile MAE ${p.toFixed(2)}`);
    }
});

t('IOC 288: the 675 Hz START switches the picture to 904 pixels', () => {
    checkTransmission('IOC 288 @ 12000', { rate: 12000, ioc: 288, lines: 120 });
});

t('60 and 90 LPM', () => {
    checkTransmission('60 LPM @ 11025', { rate: 11025, lpm: 60, lines: 80 }, { lpm: 60 });
    checkTransmission('90 LPM @ 12000', { rate: 12000, lpm: 90, lines: 100 }, { lpm: 90 });
});

t('a +50 ppm sample clock slants the picture; slantPpm: 50 straightens it', () => {
    const lines = 200;
    const audio = encodeWefax({ rate: 12000, ppm: 50, lines });
    const shiftAt = (rows, from, to) => bestFit(rows, 1809, lines, { from, to }).dx;
    const slant = (opts) => {
        const { rows } = collect(runDecoder(audio, { sampleRate: 12000, ...opts }).events);
        const top = shiftAt(rows, 0, 30), bottom = shiftAt(rows, lines - 30, lines);
        return { top, bottom, d: bottom - top, rows };
    };
    const raw = slant({});
    const fixed = slant({ slantPpm: 50 });
    report.push(`+50 ppm: drift over ${lines} lines ${raw.d} px uncorrected, ${fixed.d} px with slantPpm 50`);
    // 50 ppm of 100 s is 5 ms, about 18 pixels of a 0.5 s line.
    assert.ok(Math.abs(raw.d) >= 10, `uncorrected drift ${raw.d}`);
    assert.ok(Math.abs(fixed.d) <= 2, `corrected drift ${fixed.d}`);
});

t('autoStart off: a picture opens at once, and START cuts it short for a new one', () => {
    const audio = encodeWefax({ rate: 12000, lines: 40 });
    const { events } = runDecoder(audio, { sampleRate: 12000, autoStart: false });
    const { starts, ends } = collect(events);
    assert.strictEqual(events[0].type, 'image');
    assert.strictEqual(events[0].event, 'start');
    assert.strictEqual(starts.length, 2);
    assert.deepStrictEqual(ends.map((e) => e.complete), [false, true]);
});

t('autoStart on: nothing is drawn before a START', () => {
    const audio = encodeWefax({ rate: 12000, lines: 0, lead: 20 }).subarray(0, 12000 * 19);
    const { events, d } = runDecoder(audio, { sampleRate: 12000 });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(d.status().state, 'idle');
    assert.deepStrictEqual(d.status().detail, { line: 0, lpm: 120, ioc: 576 });
});

t('reset() ends a picture in progress, incomplete', () => {
    const audio = encodeWefax({ rate: 12000, lines: 60 });
    const d = new WefaxDecoder({ sampleRate: 12000 });
    d.process(audio.subarray(0, 12000 * 50), 12000 * 50);
    assert.strictEqual(d.status().state, 'receiving');
    assert.ok(d.status().detail.line > 0);
    d.reset();
    const ev = d.drain();
    const end = ev.filter((e) => e.event === 'end');
    assert.strictEqual(end.length, 1);
    assert.strictEqual(end[0].complete, false);
    assert.strictEqual(d.status().state, 'idle');
});

t('usePhasing off: lines flow straight after START, unaligned', () => {
    const audio = encodeWefax({ rate: 12000, lines: 20 });
    const { events } = runDecoder(audio, { sampleRate: 12000, usePhasing: false });
    const { texts, rows } = collect(events);
    assert.ok(!texts.includes('phasing\n'));
    // START is recognised a few lines in; the rest of the tone, all 60
    // phasing lines and the picture follow.
    assert.ok(rows.length > 75, `${rows.length} rows`);
});

// ── a real recording, if there is one ───────────────────────────────────────

t('ubersdr_wefax testdata holds no fax recording (its one fixture is codec conformance audio)', () => {
    const dir = path.join(process.env.HOME || '', 'repos/ubersdr_wefax/testdata');
    if (!fs.existsSync(dir)) return;
    const audio = fs.readdirSync(dir).filter((f) => /\.(wav|raw|s16|pcm)$/i.test(f));
    report.push(`testdata: ${fs.readdirSync(dir).join(', ')} — no WAV/raw fax recording`);
    assert.deepStrictEqual(audio, []);
});

t('the WEFAX block: audio in packets, its images into an Image viewer’s gallery — one complete picture, text on the side', () => {
    const rate = 12000;
    const audio = encodeWefax({ rate, lines: 60 });
    const def = BLOCK_BY_TYPE.wefax;
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), rate);
    const gallery = new Gallery(4);
    const texts = [];
    const P = 240;
    for (let k = 0; k < audio.length; k += P) {
        const len = Math.min(P, audio.length - k);
        const x = makeBuffer('real', P);
        x.re.set(audio.subarray(k, k + len));
        x.n = len;
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([x], outs, len);
        for (const e of outs[0].list) gallery.apply(e);
        for (const e of outs[1].list) texts.push(e.text);
    }
    assert.strictEqual(gallery.pictures.length, 1);
    const pic = gallery.pictures[0];
    assert.strictEqual(pic.width, 1809);
    assert.strictEqual(pic.complete, true);
    // The picture, then the STOP tone’s lines until it has lasted long enough to count.
    assert.ok(pic.rows >= 60 && pic.rows <= 80, `${pic.rows} rows`);
    assert.ok(texts.join('').includes('START') && texts.join('').includes('STOP'), JSON.stringify(texts));
    assert.strictEqual(inst.read().state, 'idle');
});

// ── the blocks: the raster, and the front end made of ordinary blocks ───────

// Run block instances in a line, packet by packet, as a graph would: each
// stage's output buffer is the next one's input. The last stage is the raster,
// whose messages go into a Gallery as an Image viewer's would.
function runBlocks(audio, rate, stages, P = 300) {
    const insts = stages.map(([def, params]) => {
        const inst = def.create();
        inst.configure(sanitizeParams(def, params), rate);
        return { def, inst, outs: def.outputs.map((o) => makeBuffer(o.kind, P)) };
    });
    const gallery = new Gallery(4);
    const texts = [];
    const input = makeBuffer('real', P);
    let states = new Set();
    for (let k = 0; k < audio.length; k += P) {
        const n = Math.min(P, audio.length - k);
        input.re.set(audio.subarray(k, k + n));
        input.n = n;
        let cur = input;
        for (const s of insts) {
            for (const o of s.outs) if (o.list) o.list.length = 0;
            const m = s.inst.process([cur], s.outs, n);
            if (s.outs[0].re) s.outs[0].n = m;
            cur = s.outs[0];
        }
        const last = insts[insts.length - 1];
        for (const e of last.outs[0].list) gallery.apply(e);
        for (const e of last.outs[1].list) texts.push(e.text);
        states.add(last.inst.read().state);
    }
    return { gallery, texts, states, raster: insts[insts.length - 1].inst };
}

// A Gallery picture's rows as grey bytes, for the same comparisons as above.
function galleryRows(pic) {
    const rows = [];
    for (let y = 0; y < pic.rows; y++) {
        const row = new Uint8ClampedArray(pic.width);
        for (let x = 0; x < pic.width; x++) row[x] = pic.data[(y * pic.width + x) * 4];
        rows.push(row);
    }
    return rows;
}

const FAX_BLOCK_BY_TYPE = {
    hilbert: HilbertBlock, shift: ShiftBlock, lowpass: LowpassBlock, 'fm-discriminator': DiscriminatorBlock,
};
const frontEndBlocks = (opts) => wefaxFrontEndStages(opts).map((s) => [FAX_BLOCK_BY_TYPE[s.type], s.params]);

function checkPicture(label, { gallery, texts }, lines, { maxErr = 12, profileMax = null } = {}) {
    assert.deepStrictEqual(texts, ['START 576\n', 'phasing\n', 'STOP\n'], JSON.stringify(texts));
    assert.strictEqual(gallery.pictures.length, 1);
    const pic = gallery.pictures[0];
    assert.strictEqual(pic.width, 1809);
    assert.strictEqual(pic.mode, 'WEFAX 120/576');
    assert.strictEqual(pic.complete, true);
    const rows = galleryRows(pic);
    const fit = bestFit(rows, 1809, lines);
    const at0 = mae(rows, 1809, fit.r0, 0, lines);
    let line = `${label}: ${rows.length} rows, best dx ${fit.dx}, MAE ${at0.toFixed(2)} at dx 0`;
    assert.ok(Math.abs(fit.dx) <= 3, `dx ${fit.dx}`);
    assert.ok(at0 < maxErr, `MAE ${at0.toFixed(2)}`);
    if (profileMax) {
        const p = profileMae(rows, 1809, fit.r0, lines);
        line += `, column-median MAE ${p.toFixed(2)}`;
        assert.ok(p < profileMax, `profile MAE ${p.toFixed(2)}`);
    }
    report.push(line);
}

t('the fax-raster block on its own: ideal FM levels in, the picture out, lined up', () => {
    const lines = 100;
    for (const rate of [12000, 48000]) {
        const level = encodeWefax({ rate, lines, levels: true });
        const r = runBlocks(level, rate, [[FaxRasterBlock, {}]]);
        checkPicture(`fax-raster alone @ ${rate}`, r, lines);
        assert.ok(r.states.has('phasing') && r.states.has('receiving'));
        assert.strictEqual(r.raster.read().state, 'idle');
        assert.strictEqual(r.raster.activity(), 0);
    }
});

t('the fax-raster block: its settings reach the raster (IOC 288 fixed, autoIoc off; 60 LPM)', () => {
    const level = encodeWefax({ rate: 12000, lines: 30, levels: true, ioc: 288 });
    // The station's 675 Hz START, with the IOC switch off: still 576 wide.
    const fixed = runBlocks(level, 12000, [[FaxRasterBlock, { autoIoc: false }]]);
    assert.strictEqual(fixed.gallery.pictures[0].width, 1809);
    const auto = runBlocks(level, 12000, [[FaxRasterBlock, {}]]);
    assert.strictEqual(auto.gallery.pictures[0].width, 904);
    const inst = FaxRasterBlock.create();
    inst.configure(sanitizeParams(FaxRasterBlock, { lpm: 60, width: 800 }), 8000);
    assert.deepStrictEqual(inst.read().detail, { line: 0, lpm: 60, ioc: 576 });
});

for (const rate of [8000, 12000, 48000]) {
    t(`the whole chain of blocks at ${rate} Hz — hilbert, shift, lowpass, fm-discriminator, fax-raster — into a gallery`, () => {
        const lines = 120;
        const audio = encodeWefax({ rate, lines });
        const t0 = Date.now();
        const r = runBlocks(audio, rate, [...frontEndBlocks(), [FaxRasterBlock, {}]]);
        const secs = audio.length / rate;
        checkPicture(`block chain @ ${rate} (${((Date.now() - t0) / 1000).toFixed(1)} s for ${secs.toFixed(0)} s of audio)`, r, lines);
        // Affordable: well inside real time, even at 48 kHz.
        assert.ok(Date.now() - t0 < secs * 1000 / 5, `${Date.now() - t0} ms for ${secs} s`);
    });
}

t('the chain of blocks with noise (12 dB SNR in 3 kHz) at 12 and 48 kHz', () => {
    for (const rate of [12000, 48000]) {
        const lines = 120;
        const noise = Math.sqrt(0.0079 * (rate / 2) / 3000);
        const audio = encodeWefax({ rate, lines, noise, seed: 7 });
        const r = runBlocks(audio, rate, [...frontEndBlocks(), [FaxRasterBlock, {}]]);
        checkPicture(`block chain @ ${rate}, 12 dB SNR`, r, lines, { maxErr: 40, profileMax: 12 });
    }
});

t('the decoder is its two halves: front end into raster, the same rows', () => {
    const rate = 12000, lines = 20;
    const audio = encodeWefax({ rate, lines });
    const whole = collect(runDecoder(audio, { sampleRate: rate }).events).rows;
    const front = new WefaxFrontEnd({ sampleRate: rate });
    const raster = new WefaxRaster({ sampleRate: front.rate });
    const lv = new Float64Array(front.maxOut(audio.length));
    raster.process(lv, front.process(audio, audio.length, lv));
    const halves = collect(raster.drain()).rows;
    assert.strictEqual(halves.length, whole.length);
    for (let y = 0; y < whole.length; y++) assert.deepStrictEqual(halves[y], whole[y]);
});

t('the WEFAX block expands into its stages, and the expanded graph draws the same picture', () => {
    const rate = 12000;
    const audio = Float32Array.from(encodeWefax({ rate, lines: 40 }));
    const g = parseGraph({
        v: GRAPH_VERSION,
        nodes: [
            { id: 'iq', type: 'iq-in' }, { id: 're', type: 'real-part' },
            { id: 'fax', type: 'wefax', params: { bandwidth: 'narrow' } },
            { id: 'viewer', type: 'image-viewer' }, { id: 'con', type: 'console' },
        ],
        wires: [['iq', 'out', 're', 'in'], ['re', 'out', 'fax', 'audio'], ['fax', 'images', 'viewer', 'in'], ['fax', 'text', 'con', 'in']],
    }).graph;
    const run = (graph) => {
        const rt = new Runtime(graph, rate);
        assert.ok(rt.ok, JSON.stringify(rt.errors));
        const gallery = new Gallery(4);
        const q = new Float32Array(240);
        for (let k = 0; k < audio.length; k += 240) {
            const len = Math.min(240, audio.length - k);
            rt.process({ i: audio.subarray(k, k + len), q: q.subarray(0, len), frames: len, rate });
            for (const e of rt.drainEvents('viewer') || []) gallery.apply(e);
        }
        return { gallery, text: rt.read('con').text };
    };
    const one = run(g);
    const { graph: x, ids } = expandDecoder(g, 'fax');
    assert.ok(compile(x, rate).ok, JSON.stringify(compile(x, rate).errors));
    assert.ok(!x.nodes.some((n) => n.id === 'fax'));
    assert.deepStrictEqual(x.nodes.filter((n) => ids.includes(n.id)).map((n) => n.type).sort(), ['fax-raster', 'fm-discriminator', 'hilbert', 'lowpass', 'shift']);
    // The narrow filter reached the expanded low-pass.
    assert.strictEqual(x.nodes.find((n) => n.type === 'lowpass').params.cutoffHz, 800);
    const two = run(x);
    assert.strictEqual(one.gallery.pictures.length, 1);
    assert.strictEqual(two.gallery.pictures.length, 1);
    const a = one.gallery.pictures[0];
    const b = two.gallery.pictures[0];
    assert.deepStrictEqual([a.width, a.rows, a.complete], [b.width, b.rows, b.complete]);
    assert.ok(a.view().data.every((v, i) => v === b.view().data[i]), 'the pictures differ');
    assert.strictEqual(one.text, two.text);
    assert.ok(one.text.includes('START') && one.text.includes('STOP'), one.text);
});

for (const line of report) console.log('      ' + line);
console.log(`${pass} passed`);
