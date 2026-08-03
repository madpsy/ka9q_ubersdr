// Exercises the wire-format decoders against frames built exactly the way
// user_spectrum_websocket.go and websocket.go build them.

const assert = require('assert');
const { SpectrumConnection } = require('./.build/spectrum.cjs');
const { AudioConnection } = require('./.build/audio.cjs');
const {
    SQUELCH_MIN, SQUELCH_MAX, SQUELCH_SENTINEL, SQUELCH_STEP,
    autoSquelchValue, bandwidthLimits, maxFilterWidth, snapStep, squelchEnabled, squelchThreshold,
} = require('./.build/constants.cjs');
const dspLib = require('./.build/dsp.cjs');
const mk = require('./.build/markers.cjs');
const { UI_CONFIG_DEFAULTS, parseUiConfig } = require('./.build/uiconfig.cjs');
const { dbfsToSUnits, sUnitFraction, sUnitLabel, S_UNITS_MIN, S_UNITS_MAX } = require('./.build/format.cjs');

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

// --- zoom stepping ---------------------------------------------------------
//
// The server quantises binBandwidth onto a fixed ladder before applying it
// (user_spectrum_websocket.go). A zoom step gentler than the ladder's spacing
// rounds back to the rung it started on, so the view never changes. These tests
// exist to stop the step size drifting back to something "smoother".

// Mirrors the server's safe-bin_bw rounding.
function serverLadder(binBW) {
    if (binBW < 0.75) return 0.5;
    if (binBW < 1.5) return 1;
    if (binBW < 3) return 2;
    if (binBW < 7) return 5;
    if (binBW < 15) return 10;
    if (binBW < 35) return 20;
    if (binBW < 75) return 50;
    if (binBW < 150) return 100;
    if (binBW < 250) return 200;
    if (binBW < 400) return 300;
    if (binBW < 750) return 500;
    if (binBW < 1500) return 1000;
    if (binBW < 3500) return 2000;
    if (binBW < 7500) return 5000;
    return binBW;   // pass-through for full-bandwidth views
}

// The only bin bandwidths a session can actually be sitting at — the ladder is
// not a power-of-two series, so stepping has to be checked from these, not from
// arbitrary values.
const RUNGS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000];

t('halving moves to a lower rung from every reachable rung', () => {
    for (const bw of RUNGS.slice(1)) {
        const landed = serverLadder(bw / 2);
        assert.ok(landed < bw, `halving ${bw} landed on ${landed}`);
    }
});

t('doubling moves to a higher rung from every reachable rung', () => {
    for (const bw of RUNGS) {
        const landed = serverLadder(bw * 2);
        assert.ok(landed > bw, `doubling ${bw} landed on ${landed}`);
    }
});

t('a gentle 1.25x step stalls — this is why the step is 2x', () => {
    // Reproduces the original bug: from the 5000 Hz/bin rung neither direction
    // moves, so the spectrum appears frozen at three or four zoom levels.
    assert.strictEqual(serverLadder(5000 * 1.25), 5000);
    assert.strictEqual(serverLadder(5000 * 0.8), 5000);
});

t('UI zoom floor is a span, independent of bin count', () => {
    const c = new SpectrumConnection();
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 1024, binBandwidth: 29296.875, defaultBinCount: 1024, defaultBinBandwidth: 29296.875 });
    assert.strictEqual(c.minBinBandwidthForUI() * 1024, 10240);
    const d = new SpectrumConnection();
    d._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375, defaultBinCount: 2048, defaultBinBandwidth: 14648.4375 });
    assert.strictEqual(d.minBinBandwidthForUI() * 2048, 10240);
});

t('full-span bin bandwidth survives a missing server default', () => {
    const c = new SpectrumConnection();
    // Server that omits defaultBinBandwidth: must still yield the full-view
    // value, or zoom-out clamps to wherever the user happens to be.
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375 });
    assert.strictEqual(c.fullSpanBinBandwidth(), 14648.4375);
    assert.ok(c.fullSpanBinBandwidth() * 2048 > 29e6);
});

// --- squelch ---------------------------------------------------------------
//
// Squelch is the server-side audio gate. The slider's floor doubles as "off",
// which is what v1 does — a separate enable flag can disagree with the value.

t('slider floor means off, and sends the sentinel', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN), false);
    // Anything at or below the floor is off, so a stale stored value cannot
    // resurrect as a live threshold.
    assert.strictEqual(squelchThreshold(SQUELCH_MIN - 10), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(0), false);
});

t('above the floor the slider value is the threshold in dB SNR', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN + 0.5), SQUELCH_MIN + 0.5);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN + 0.5), true);
    assert.strictEqual(squelchThreshold(SQUELCH_MAX), SQUELCH_MAX);
});

t('auto-set sits ABOVE the recent noise, not below it', () => {
    // The gate opens at snr >= threshold, so a threshold under the measured
    // noise leaves it permanently open — the bug this guards against.
    const noise = [30, 30, 30, 30, 30];
    const v = autoSquelchValue(noise);
    assert.ok(v > 30, `auto gave ${v}, which would never close the gate`);
    assert.strictEqual(v, 33);   // avg + 3 dB headroom
});

t('auto-set averages the last five readings only', () => {
    // Older, unrepresentative readings must not drag the result.
    const history = [0, 0, 0, 0, 0, 40, 40, 40, 40, 40];
    assert.strictEqual(autoSquelchValue(history), 43);
});

t('auto-set rounds to the slider step and stays in range', () => {
    assert.strictEqual(autoSquelchValue([30.1, 30.2]) % SQUELCH_STEP, 0);
    // Below the floor it must not land on "off".
    const low = autoSquelchValue([-50]);
    assert.ok(low > SQUELCH_MIN, `${low} would read as off`);
    assert.strictEqual(squelchEnabled(low), true);
    // Above the ceiling it clamps.
    assert.strictEqual(autoSquelchValue([500]), SQUELCH_MAX);
});

t('auto-set with no history does nothing', () => {
    assert.strictEqual(autoSquelchValue([]), null);
    assert.strictEqual(autoSquelchValue(null), null);
});

t('setAudioGate emits the server field names and records for reconnect', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };

    a.setAudioGate({ minSnr: 30 });
    assert.deepStrictEqual(sent[0], { type: 'set_audio_gate', min_snr: 30 });
    assert.deepStrictEqual(a.lastGate, { minSnr: 30, minPower: undefined });

    a.setAudioGate({ minSnr: SQUELCH_SENTINEL });
    assert.deepStrictEqual(sent[1], { type: 'set_audio_gate', min_snr: -999 });
});

t('setAudioGate with no thresholds is not sent', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    // The server rejects a gate message carrying neither field.
    assert.strictEqual(a.setAudioGate({}), false);
    assert.strictEqual(sent.length, 0);
});

// --- marker bar ------------------------------------------------------------
//
// Sample payloads are verbatim from a live server: 2450 bookmarks and 202 band
// allocations. At full span every one is "visible", which is exactly the case
// the density cap and the binary-search window exist for.

const MARKS = JSON.parse(require('fs').readFileSync(__dirname + '/bookmarks.sample.json', 'utf8'))
    .sort((a, b) => a.frequency - b.frequency);
const BANDS = JSON.parse(require('fs').readFileSync(__dirname + '/bands.sample.json', 'utf8'));
const measure = (b) => Math.min(140, b.name.length * 6 + 10);

t('the visible window is sliced, not scanned', () => {
    // A 10 kHz window out of 0-30 MHz must yield a handful, not thousands.
    const win = mk.visibleBookmarks(MARKS, 7100000, 7110000);
    assert.ok(win.length < 50, `${win.length} in a 10 kHz window`);
    assert.ok(win.every((b) => b.frequency >= 7100000 && b.frequency <= 7110000));
    // And the boundaries are inclusive on both ends.
    const exact = MARKS[100].frequency;
    assert.ok(mk.visibleBookmarks(MARKS, exact, exact).some((b) => b.frequency === exact));
});

t('lowerBound finds the first index at or after the target', () => {
    const arr = [10, 20, 30, 40].map((f) => ({ frequency: f }));
    assert.strictEqual(mk.lowerBound(arr, 5), 0);
    assert.strictEqual(mk.lowerBound(arr, 20), 1);
    assert.strictEqual(mk.lowerBound(arr, 25), 2);
    assert.strictEqual(mk.lowerBound(arr, 99), 4);
});

t('full span with 2450 bookmarks yields a readable handful', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 1600, measure,
    });
    assert.ok(placed.length <= mk.MAX_MARKERS, `${placed.length} markers`);
    // Enough to be useful, few enough to read. v1 draws 100 here, most of them
    // stacked on top of each other.
    assert.ok(placed.length >= 15, `only ${placed.length} survived`);
});

t('markers never overlap, at any zoom', () => {
    // The point of dropping: whatever the span or width, no row collides with
    // itself. This is the check that would have caught the overloaded bar.
    for (const [lo, hi, w] of [
        [0, 30e6, 1600], [0, 30e6, 400], [7.0e6, 7.3e6, 1200],
        [7.1e6, 7.11e6, 800], [0, 30e6, 3000],
    ]) {
        const placed = mk.layoutBookmarks({ sorted: MARKS, startFreq: lo, endFreq: hi, width: w, measure });
        for (const row of [0, 1]) {
            const inRow = placed.filter((p) => p.row === row);
            for (let i = 1; i < inRow.length; i++) {
                const gap = (inRow[i].x - inRow[i].width / 2) - (inRow[i - 1].x + inRow[i - 1].width / 2);
                assert.ok(gap >= mk.ROW_GAP_PX,
                    `span ${(hi - lo) / 1e6}MHz w=${w} row ${row}: ${gap.toFixed(1)}px gap`);
            }
        }
    }
});

t('a narrower bar keeps fewer markers', () => {
    const wide = mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 2400, measure });
    const narrow = mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 400, measure });
    assert.ok(wide.length > narrow.length, `${wide.length} vs ${narrow.length}`);
});

t('capped markers stay spread across the width', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 1600, measure,
    });
    // Evenly sampled, so both edges of the canvas must be represented — a naive
    // "first 100" would bunch everything at the left.
    const xs = placed.map((p) => p.x);
    assert.ok(Math.min(...xs) < 200, `leftmost at ${Math.min(...xs)}`);
    assert.ok(Math.max(...xs) > 1400, `rightmost at ${Math.max(...xs)}`);
});

t('both rows are used before anything is dropped', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 7000000, endFreq: 7300000, width: 1200, measure,
    });
    assert.ok(placed.some((p) => p.row === 1), 'nothing was pushed to the second row');
    assert.ok(placed.some((p) => p.row === 0), 'nothing on the first row');
});

t('an empty or absent catalogue lays out nothing', () => {
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: [], startFreq: 0, endFreq: 1e6, width: 100, measure }), []);
    assert.deepStrictEqual(mk.visibleBookmarks(null, 0, 1e6), []);
    assert.deepStrictEqual(mk.layoutBands({ bands: null, startFreq: 0, endFreq: 1e6, width: 100 }), []);
});

t('a zero-width or zero-span view lays out nothing', () => {
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 0, width: 100, measure }), []);
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 1e6, width: 0, measure }), []);
});

t('bands are clipped to the view and ordered widest first', () => {
    const spans = mk.layoutBands({ bands: BANDS, startFreq: 7000000, endFreq: 7300000, width: 1000 });
    assert.ok(spans.length > 0);
    for (const s of spans) {
        assert.ok(s.x0 >= 0 && s.x1 <= 1000, `${s.x0}..${s.x1} outside the canvas`);
    }
    // Widest first, so narrow allocations paint on top of the wide ones.
    for (let i = 1; i < spans.length; i++) {
        const prev = spans[i - 1].band.end - spans[i - 1].band.start;
        const cur = spans[i].band.end - spans[i].band.start;
        assert.ok(prev >= cur, 'bands are not widest-first');
    }
});

t('band labels repeat without overlapping, however long the name', () => {
    const xs = mk.bandLabelPositions({ x0: 0, x1: 1000, labelWidth: 80 });
    assert.ok(xs.length >= 2, `${xs.length} labels across 1000px`);
    for (let i = 1; i < xs.length; i++) {
        assert.ok(xs[i] - xs[i - 1] >= 80, `labels ${(xs[i] - xs[i - 1]).toFixed(0)}px apart, need 80`);
    }
    // A very long name simply repeats less often rather than colliding.
    const wide = mk.bandLabelPositions({ x0: 0, x1: 1000, labelWidth: 400 });
    for (let i = 1; i < wide.length; i++) {
        assert.ok(wide[i] - wide[i - 1] >= 400, 'long labels collide');
    }
});

t('narrow bands get no label, and labels stay inside the band', () => {
    assert.deepStrictEqual(mk.bandLabelPositions({ x0: 0, x1: 20, labelWidth: 40 }), []);
    const xs = mk.bandLabelPositions({ x0: 100, x1: 200, labelWidth: 60 });
    for (const x of xs) {
        assert.ok(x - 30 >= 100 - 0.001 && x + 30 <= 200 + 0.001, `label at ${x} escapes 100..200`);
    }
});

t('band colours follow v1 intensity', () => {
    const mid = mk.bandColors(0.5);
    assert.strictEqual(mid.length, 10);
    assert.ok(mid[0].endsWith('0.2)'), mid[0]);
    const full = mk.bandColors(1);
    assert.ok(full[0].endsWith('0.8)'), full[0]);
    // Out-of-range or missing config falls back to the pastel default.
    assert.deepStrictEqual(mk.bandColors(undefined), mid);
    assert.deepStrictEqual(mk.bandColors(0), mid);
});

// --- tuning steps ----------------------------------------------------------

t('stepping snaps to the step boundary from an odd frequency', () => {
    // 7.100123 MHz, 500 Hz step -> 7.100500 up, 7.100000 down.
    assert.strictEqual(snapStep(7100123, 500, 1), 7100500);
    assert.strictEqual(snapStep(7100123, 500, -1), 7100000);
    assert.strictEqual(snapStep(7100001, 1000, 1), 7101000);
    assert.strictEqual(snapStep(7100999, 1000, -1), 7100000);
});

t('already on a boundary, a press moves one whole step', () => {
    assert.strictEqual(snapStep(7100000, 500, 1), 7100500);
    assert.strictEqual(snapStep(7100000, 500, -1), 7099500);
    assert.strictEqual(snapStep(14200000, 100000, 1), 14300000);
});

t('a press never moves the opposite way', () => {
    // Rounding to nearest would send + downwards when just past a boundary.
    for (const step of [1, 10, 100, 500, 1000, 5000, 9000, 10000]) {
        for (const f of [7100001, 7100499, 7100999, 14200321, 9599999]) {
            assert.ok(snapStep(f, step, 1) > f, `+${step} from ${f}`);
            assert.ok(snapStep(f, step, -1) < f, `-${step} from ${f}`);
        }
    }
});

t('every landing point is a multiple of the step', () => {
    for (const step of [10, 100, 500, 1000, 9000, 10000]) {
        for (const f of [123456, 7100123, 14200321, 29999999]) {
            assert.strictEqual(snapStep(f, step, 1) % step, 0, `+${step} from ${f}`);
            assert.strictEqual(snapStep(f, step, -1) % step, 0, `-${step} from ${f}`);
        }
    }
});

t('a 1 Hz step still moves by exactly 1 Hz', () => {
    assert.strictEqual(snapStep(7100123, 1, 1), 7100124);
    assert.strictEqual(snapStep(7100123, 1, -1), 7100122);
});

// --- S-meter ---------------------------------------------------------------
//
// Mapping matches v1's s-meter-needle.js: S9 = -73 dBFS, 6 dB per S-unit below,
// 10 dB per unit above. The bar and the S label must agree, and both must line
// up with the printed scale.

t('S-unit mapping matches v1 (S1 = -121, S9 = -73 dBFS)', () => {
    assert.strictEqual(dbfsToSUnits(-121), 1);
    assert.strictEqual(dbfsToSUnits(-97), 5);
    assert.strictEqual(dbfsToSUnits(-73), 9);
    assert.strictEqual(dbfsToSUnits(-53), 11);   // S9+20, 10 dB per unit above S9
    assert.strictEqual(dbfsToSUnits(-13), 15);   // S9+60
    assert.strictEqual(dbfsToSUnits(-130), 0);
});

t('labels read the same as v1', () => {
    assert.strictEqual(sUnitLabel(-121), 'S1');
    assert.strictEqual(sUnitLabel(-97), 'S5');
    assert.strictEqual(sUnitLabel(-73), 'S9');
    assert.strictEqual(sUnitLabel(-53), 'S9+20');
    assert.strictEqual(sUnitLabel(-13), 'S9+60');
    assert.strictEqual(sUnitLabel(-130), 'S0');
    assert.strictEqual(sUnitLabel(null), '--');
    assert.strictEqual(sUnitLabel(-999), '--');
});

t('the bar lines up with the printed scale', () => {
    // The scale prints eight evenly spaced ticks, so each must land on an even
    // fraction of the bar. A linear dBFS bar put S1 at 16% and clipped +60.
    const ticks = [
        ['S1', -121], ['S3', -109], ['S5', -97], ['S7', -85],
        ['S9', -73], ['+20', -53], ['+40', -33], ['+60', -13],
    ];
    ticks.forEach(([name, dbfs], i) => {
        const want = i / (ticks.length - 1);
        const got = sUnitFraction(dbfs);
        assert.ok(Math.abs(got - want) < 1e-9,
            `${name} at ${(got * 100).toFixed(1)}%, printed scale puts it at ${(want * 100).toFixed(1)}%`);
    });
});

t('the bar and the S label never disagree', () => {
    // Walk the whole range: wherever the label says S9, the bar must be at the
    // S9 tick, and so on.
    for (let dbfs = -130; dbfs <= -10; dbfs += 0.5) {
        const frac = sUnitFraction(dbfs);
        const units = S_UNITS_MIN + frac * (S_UNITS_MAX - S_UNITS_MIN);
        const fromLabel = dbfsToSUnits(dbfs);
        if (fromLabel >= S_UNITS_MIN && fromLabel <= S_UNITS_MAX) {
            assert.ok(Math.abs(units - fromLabel) < 1e-9,
                `at ${dbfs} dBFS bar=${units.toFixed(2)} label=${fromLabel.toFixed(2)} S-units`);
        }
    }
});

t('the bar clamps instead of overflowing', () => {
    assert.strictEqual(sUnitFraction(-200), 0);
    assert.strictEqual(sUnitFraction(0), 1);
    assert.strictEqual(sUnitFraction(null), 0);
    assert.strictEqual(sUnitFraction(-999), 0);
});

// --- operator UI config ----------------------------------------------------
//
// ui-config.sample.json is a verbatim /api/ui-config reply from a live server.

const UI_SAMPLE = JSON.parse(require('fs').readFileSync(__dirname + '/ui-config.sample.json', 'utf8'));

t('the whole ui-config is kept, not just the keys in use', () => {
    const parsed = parseUiConfig(UI_SAMPLE);
    assert.strictEqual(parsed.loaded, true);
    // Every operator setting must stay reachable for future features.
    for (const k of Object.keys(UI_SAMPLE)) {
        assert.ok(k in parsed.config, `dropped ${k}`);
    }
    assert.deepStrictEqual(parsed.config, UI_SAMPLE);
    // Nested objects survive intact too.
    assert.strictEqual(typeof parsed.config.theme, 'object');
});

t('backdrop settings are parsed and validated onto the top level', () => {
    const parsed = parseUiConfig(UI_SAMPLE);
    assert.strictEqual(parsed.bgImage, UI_SAMPLE.spectrum_bg_image);
    assert.strictEqual(parsed.bgOpacity, UI_SAMPLE.spectrum_bg_opacity);
});

t('opacity is clamped and survives odd values', () => {
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: 5 }).bgOpacity, 1);
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: -2 }).bgOpacity, 0);
    // A string is what an older server sends; a bad one falls back.
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: '0.42' }).bgOpacity, 0.42);
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: 'nope' }).bgOpacity, UI_CONFIG_DEFAULTS.bgOpacity);
});

t('a missing or malformed reply yields defaults, not a crash', () => {
    for (const bad of [null, undefined, 'oops', [], 42]) {
        const p = parseUiConfig(bad);
        assert.strictEqual(p.loaded, false, String(bad));
        assert.strictEqual(p.bgImage, '');
    }
});

// --- filter width limits ---------------------------------------------------

t('am, sam, fm and nfm top out at a 12 kHz filter', () => {
    for (const mode of ['am', 'sam', 'fm', 'nfm']) {
        assert.strictEqual(maxFilterWidth(mode), 12000, `${mode} allows ${maxFilterWidth(mode)} Hz`);
        const l = bandwidthLimits(mode);
        assert.deepStrictEqual([l.min, l.max], [-6000, 6000], mode);
    }
});

t('sideband modes keep their own widths', () => {
    assert.strictEqual(maxFilterWidth('usb'), 6000);
    assert.strictEqual(maxFilterWidth('lsb'), 6000);
    assert.strictEqual(maxFilterWidth('cwu'), 2000);
    assert.strictEqual(maxFilterWidth('cwl'), 2000);
});

t('an unknown mode falls back to the symmetric limit', () => {
    assert.strictEqual(maxFilterWidth('whatever'), 12000);
});

// --- DSP filter schemas -----------------------------------------------------
//
// Schemas below are the verbatim `get_dsp_filters` reply from a live server, so
// these test the shapes actually sent rather than an idealised version.

const NR2 = {
    name: 'nr2',
    description: 'SpectralNR — MMSE-LSA + OSMS spectral subtraction',
    params: [
        { name: 'gain-method', type: 'int', default: '2', min: '0', max: '3', description: 'Gain method: 0=Linear 1=Log 2=Gamma 3=Trained', runtime_safe: true },
        { name: 'npe-method', type: 'int', default: '0', min: '0', max: '2', description: 'NPE method: 0=OSMS 1=MMSE 2=NSTAT', runtime_safe: true },
        { name: 'gain-max', type: 'float', default: '1.0', min: '0', max: '2.0', description: 'Max gain cap', runtime_safe: true },
        { name: 'gain-smooth', type: 'float', default: '0.85', min: '0', max: '1.0', description: 'Temporal gain smoothing', runtime_safe: true },
        { name: 'qspp', type: 'float', default: '0.2', min: '0', max: '1.0', description: 'Speech presence probability prior', runtime_safe: true },
        { name: 'ae', type: 'bool', default: 'true', description: 'Artifact elimination post-processing', runtime_safe: true },
    ],
};
const RN2 = { name: 'rn2', description: 'RNNoise — Mozilla/Xiph RNN-based suppressor', params: null };
const DFNR = {
    name: 'dfnr',
    description: 'DeepFilterNet3 — neural network denoiser',
    params: [
        { name: 'model', type: 'string', default: '', description: 'Model path', runtime_safe: false },
        { name: 'atten-limit', type: 'float', default: '20', min: '0', max: '100', description: 'Attenuation limit', runtime_safe: true },
        { name: 'pf-beta', type: 'float', default: '0', min: '0', max: '0.3', description: 'Post-filter beta', runtime_safe: true },
    ],
};

t('init-only params are hidden — the server would reject them', () => {
    const names = dspLib.runtimeParams(DFNR).map((p) => p.name);
    assert.deepStrictEqual(names, ['atten-limit', 'pf-beta']);
    assert.ok(!names.includes('model'));
});

t('a filter with no params is handled, not crashed', () => {
    assert.deepStrictEqual(dspLib.runtimeParams(RN2), []);
    assert.deepStrictEqual(dspLib.defaultParams(RN2), {});
});

t('defaults come from the schema, as strings', () => {
    assert.deepStrictEqual(dspLib.defaultParams(NR2), {
        'gain-method': '2', 'npe-method': '0', 'gain-max': '1.0',
        'gain-smooth': '0.85', 'qspp': '0.2', 'ae': 'true',
    });
});

t('control kind follows the declared type and range', () => {
    const kind = (f, n) => dspLib.controlKind(f.params.find((p) => p.name === n));
    assert.strictEqual(kind(NR2, 'ae'), 'bool');
    assert.strictEqual(kind(NR2, 'gain-method'), 'enum');   // enumerated in its description
    assert.strictEqual(kind(NR2, 'npe-method'), 'enum');
    assert.strictEqual(kind(NR2, 'gain-max'), 'slider');
    assert.strictEqual(kind(DFNR, 'model'), 'text');        // string, no range
});

t('enum options are parsed from the description', () => {
    const p = NR2.params.find((x) => x.name === 'gain-method');
    assert.deepStrictEqual(dspLib.parseEnum(p), [
        { value: 0, label: 'Linear' }, { value: 1, label: 'Log' },
        { value: 2, label: 'Gamma' }, { value: 3, label: 'Trained' },
    ]);
});

t('a description that does not cover the full range is not an enum', () => {
    // Only two labels for a 0..3 range — rendering it as choices would hide
    // values the filter accepts, so it must stay a slider.
    const p = { name: 'x', type: 'int', min: '0', max: '3', description: 'Mode: 0=A 1=B' };
    assert.strictEqual(dspLib.parseEnum(p), null);
    assert.strictEqual(dspLib.controlKind(p), 'slider');
});

t('integer sliders step by 1', () => {
    // A 0..3 range would otherwise inherit a 0.1 step and send fractions.
    const p = { name: 'x', type: 'int', min: '0', max: '3', description: '' };
    assert.strictEqual(dspLib.computeStep(p), 1);
});

t('float slider steps scale with the range', () => {
    const step = (min, max) => dspLib.computeStep({ type: 'float', min, max });
    assert.strictEqual(step('0', '0.3'), 0.01);
    assert.strictEqual(step('0', '2.0'), 0.1);
    assert.strictEqual(step('0', '40'), 1);
    assert.strictEqual(step('0', '1000'), 100);
});

t('values format according to type and range', () => {
    const f = (v, p) => dspLib.formatParamValue(v, p);
    assert.strictEqual(f('2', { type: 'int', min: '0', max: '3' }), '2');
    assert.strictEqual(f('0.85', { type: 'float', min: '0', max: '1.0' }), '0.850');
    assert.strictEqual(f('1.0', { type: 'float', min: '0', max: '2.0' }), '1.00');
    assert.strictEqual(f('10', { type: 'float', min: '0', max: '40' }), '10.0');
});

t('enum labels are not repeated in the help text', () => {
    const p = NR2.params.find((x) => x.name === 'gain-method');
    assert.strictEqual(dspLib.paramHelp(p), 'Gain method');
    // Non-enum help is passed through untouched.
    assert.strictEqual(dspLib.paramHelp(NR2.params.find((x) => x.name === 'qspp')),
        'Speech presence probability prior');
});

t('names read as labels', () => {
    assert.strictEqual(dspLib.formatParamName('gain-method'), 'Gain method');
    assert.strictEqual(dspLib.formatParamName('atten_limit'), 'Atten limit');
});

t('params go on the wire as strings', () => {
    assert.strictEqual(dspLib.toWire(true), 'true');
    assert.strictEqual(dspLib.toWire(false), 'false');
    assert.strictEqual(dspLib.toWire(0.85), '0.85');
    assert.strictEqual(dspLib.toWire('2'), '2');
});

t('setDSPParams sends the server message shape, and skips empty updates', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    a.setDSPParams({ reduction: '20' });
    assert.deepStrictEqual(sent[0], { type: 'set_dsp_params', params: { reduction: '20' } });
    assert.strictEqual(a.setDSPParams({}), false);
    assert.strictEqual(sent.length, 1);
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
