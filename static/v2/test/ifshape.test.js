// The IF Spectrum's Shape view: the statistics behind the picture.
//
// This is the part of that panel where a mistake is invisible. A wrong average
// still draws a smooth, confident, professional-looking curve — it is just a
// curve of the wrong number, and nothing on screen says so. So the three claims
// the view makes about itself are asserted here against cases with a known
// answer: that the average is of power and not of decibels, that the window is a
// length of time and not a number of frames, and that nothing outside the filter
// gets into it.

const assert = require('assert');
const {
    SHAPE_BINS, SHAPE_MAX_ROWS, SHAPE_MIN_ROWS, SHAPE_SEC_DEFAULT, SHAPE_SEC_MAX, SHAPE_SEC_MIN,
    SHAPE_ZOOM_MARGIN,
    PEAK_HOLD_DB, SIGNAL_DB,
    bandBins, clampShapeSec, createShape, formatShape, measurePeak, measureShape, noiseFloorOf,
    occupancyOf, pushShapeRow, resetShape, shapeStats, shapeWantsZoom, shapeZoomSpan,
} = require('./.build/ifshape.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const BINS = 8;
const row = (...v) => Float32Array.from(v);
const feed = (rows, opts = {}) => {
    const st = createShape(opts.bins || BINS);
    const step = opts.step || 100;
    let at = opts.start || 1000;
    for (const r of rows) {
        pushShapeRow(st, r, at, opts.windowMs != null ? opts.windowMs : 1e9);
        at += step;
    }
    return { st, last: at - step };
};

// ── The average is of power ──────────────────────────────────────────────────

t('the average is of power, not of decibels', () => {
    // Two samples 20 dB apart. The mean power is (1 + 0.01)/2 of the larger, so
    // the answer is 2.967 dB below the top — and it is nowhere near the halfway
    // point in dB, which is what averaging the decibels would give.
    const { st, last } = feed([row(-40), row(-60)], { bins: 1 });
    const s = shapeStats(st, 1000, last);
    assert.ok(Math.abs(s.mean[0] - -42.96709) < 0.001, `mean was ${s.mean[0]}`);
    assert.notStrictEqual(Math.round(s.mean[0]), -50, 'that is the decibel average');
});

t('...which is the same as the plain average when nothing varies', () => {
    // The one case where the two agree, and a useful check that the round trip
    // through linear power and back is exact.
    const { st, last } = feed([row(-73), row(-73), row(-73)], { bins: 1 });
    assert.ok(Math.abs(shapeStats(st, 1000, last).mean[0] - -73) < 1e-6);
});

t('...and reads a noisy bin higher than averaging its decibels would', () => {
    // The error this exists to avoid, in the shape it actually takes: log
    // averaging is systematically low on anything that varies, and by an amount
    // that depends on how much it varies — so a signal and the noise beside it
    // are pulled down by different amounts and the shape itself is distorted.
    const quiet = [];
    const noisy = [];
    for (let i = 0; i < 16; i++) {
        quiet.push(row(-100));
        noisy.push(row(-100 + (i % 2 ? 6 : -6)));
    }
    const a = shapeStats(feed(quiet, { bins: 1 }).st, 1e6, 1e6).mean[0];
    const b = shapeStats(feed(noisy, { bins: 1 }).st, 1e6, 1e6).mean[0];
    // Same decibel average, different power average — and the noisy one is
    // higher, because power is what adds.
    assert.ok(Math.abs(a - -100) < 1e-6);
    assert.ok(b > a + 1, `noisy bin averaged ${b}, quiet ${a}`);
});

t('the extremes are the extremes, taken in decibels because that is free', () => {
    const { st, last } = feed([row(-90), row(-40), row(-70), row(-120)], { bins: 1 });
    const s = shapeStats(st, 1000, last);
    assert.strictEqual(s.min[0], -120);
    assert.strictEqual(s.max[0], -40);
    // ...and the average sits inside them, which a broken conversion would not.
    assert.ok(s.mean[0] > s.min[0] && s.mean[0] < s.max[0]);
});

// ── The window is a length of time ───────────────────────────────────────────

t('the window is seconds, so a slower feed does not lengthen it', () => {
    // The same two seconds of signal at two frame rates. A window of "the last
    // N frames" would cover two seconds at one rate and ten at the other.
    const fast = feed(Array.from({ length: 40 }, () => row(-100)), { step: 50 });
    const slow = feed(Array.from({ length: 8 }, () => row(-100)), { step: 250 });
    const a = shapeStats(fast.st, 2000, fast.last);
    const b = shapeStats(slow.st, 2000, slow.last);
    assert.ok(a.spanMs <= 2000 && b.spanMs <= 2000);
    assert.ok(a.rows > b.rows * 3, `${a.rows} vs ${b.rows} frames — same window, different rates`);
    // Both cover the interval asked for; only the number of readings differs,
    // and that is reported rather than hidden.
    assert.ok(a.spanMs >= 1900 && b.spanMs >= 1700, `${a.spanMs} / ${b.spanMs}`);
});

t('a frame older than the window is not in it, whatever it says', () => {
    // -40 five seconds ago, -100 since. A one-second window must not see it: an
    // exponential average would still be carrying a third of it.
    const rows = [row(-40)];
    for (let i = 0; i < 20; i++) rows.push(row(-100));
    const { st, last } = feed(rows, { bins: 1, step: 250 });
    const s = shapeStats(st, 1000, last);
    assert.ok(Math.abs(s.mean[0] - -100) < 1e-6, `mean was ${s.mean[0]}`);
    assert.strictEqual(s.max[0], -100, 'a peak from outside the window survived');
});

t('the rows that aged out are recycled, not accumulated', () => {
    const st = createShape(BINS);
    for (let i = 0; i < 500; i++) pushShapeRow(st, row(1, 2, 3, 4, 5, 6, 7, 8), 1000 + i * 100, 1000);
    // A one-second window at ten a second is about eleven rows, and nothing may
    // grow without bound however long a session runs.
    assert.ok(st.rows.length <= 12, `${st.rows.length} rows held for a 1 s window`);
    assert.ok(st.rows.length + st.free.length <= SHAPE_MAX_ROWS + 1);
});

t('a window nothing has arrived in is empty rather than stale', () => {
    const { st, last } = feed([row(-50)], { bins: 1 });
    const s = shapeStats(st, 500, last + 10_000);
    assert.strictEqual(s.rows, 0);
    assert.ok(Number.isNaN(s.mean[0]), 'a row from ten seconds ago is still being averaged');
});

// ── Only the passband ────────────────────────────────────────────────────────

t('nothing outside the filter gets into the shape', () => {
    // A window of −337.5…+3037.5 (USB fitted) with a 50…2700 filter in it.
    const win = { offLo: -337.5, offHi: 3037.5, span: 3375, dial: 14e6 };
    const tuning = { bandwidthLow: 50, bandwidthHigh: 2700 };
    const band = bandBins(SHAPE_BINS, win, tuning);
    assert.ok(band.first > 0 && band.last < SHAPE_BINS - 1, JSON.stringify(band));

    const wide = new Float32Array(SHAPE_BINS).fill(-40);   // loud everywhere
    const st = createShape(SHAPE_BINS);
    for (let i = 0; i < 8; i++) pushShapeRow(st, wide, 1000 + i * 100, 2000);
    const s = shapeStats(st, 2000, 1700, {}, band);

    for (let i = 0; i < SHAPE_BINS; i++) {
        const inside = i >= band.first && i <= band.last;
        assert.strictEqual(Number.isFinite(s.mean[i]), inside, `bin ${i} inside=${inside}`);
        assert.strictEqual(Number.isFinite(s.max[i]), inside);
    }
});

t('the filter edges round outward, so the passband is never shaved', () => {
    // Rounding inward takes a bin off each side of every passband, which is a
    // systematic narrowing of the one thing being measured.
    const win = { offLo: -1000, offHi: 1000, span: 2000, dial: 7e6 };
    const per = 2000 / 16;
    const band = bandBins(16, win, { bandwidthLow: -per * 2.5, bandwidthHigh: per * 2.5 });
    // Centre is bin 8's left edge; ±2.5 bins therefore covers bins 5..10.
    assert.strictEqual(band.first, 5);
    assert.strictEqual(band.last, 10);
});

t('a filter and a window that do not meet describe nothing', () => {
    const win = { offLo: -400, offHi: 400, span: 800, dial: 7e6 };
    // Momentarily true while a mode change is in flight: the tuning arrives
    // before the window computed from it.
    const away = bandBins(64, win, { bandwidthLow: 5000, bandwidthHigh: 8000 });
    assert.ok(away.last < away.first, JSON.stringify(away));
    // ...and asking for the shape of it produces nothing, not a crash.
    const st = createShape(64);
    pushShapeRow(st, new Float32Array(64).fill(-90), 1000, 1000);
    const s = shapeStats(st, 1000, 1000, {}, away);
    assert.strictEqual(s.rows, 1);
    assert.ok([...s.mean].every(Number.isNaN));

    // A filter with no width at all is the same answer.
    assert.ok(bandBins(64, win, { bandwidthLow: 0, bandwidthHigh: 0 }).last < 0);
    assert.ok(bandBins(64, null, { bandwidthLow: -100, bandwidthHigh: 100 }).last < 0);
});

t('the mask is applied to the answer, not to what is stored', () => {
    // A filter can be shifted without the window changing, and the history has
    // to survive that — masking on the way in would leave the stored rows
    // describing an old filter with no way to tell.
    const win = { offLo: -1000, offHi: 1000, span: 2000, dial: 7e6 };
    const st = createShape(64);
    const r = new Float32Array(64);
    for (let i = 0; i < 64; i++) r[i] = -120 + i;
    for (let i = 0; i < 4; i++) pushShapeRow(st, r, 1000 + i * 100, 2000);

    const left = shapeStats(st, 2000, 1300, {}, bandBins(64, win, { bandwidthLow: -800, bandwidthHigh: -200 }));
    const right = shapeStats(st, 2000, 1300, {}, bandBins(64, win, { bandwidthLow: 200, bandwidthHigh: 800 }));
    // Both answered from the same rows, and each only where its filter was.
    assert.ok(Number.isFinite(left.mean[8]) && Number.isNaN(left.mean[56]));
    assert.ok(Number.isNaN(right.mean[8]) && Number.isFinite(right.mean[56]));
});

// ── Housekeeping ─────────────────────────────────────────────────────────────

t('a bin no frame measured is NaN, not a floor', () => {
    // The window can overhang the served spectrum — sliceToPixels marks those
    // NaN — and the average must carry that through rather than counting it.
    const { st, last } = feed([row(NaN, -90), row(NaN, -90)], { bins: 2 });
    const s = shapeStats(st, 1000, last);
    assert.ok(Number.isNaN(s.mean[0]));
    assert.ok(Math.abs(s.mean[1] - -90) < 1e-6);
});

t('...and a bin measured only sometimes averages what it has', () => {
    const { st, last } = feed([row(-90), row(NaN), row(-90)], { bins: 1 });
    const s = shapeStats(st, 1000, last);
    assert.strictEqual(s.rows, 3, 'the frame still counts, the bin does not');
    assert.ok(Math.abs(s.mean[0] - -90) < 1e-6);
});

t('a change of grid throws the history away rather than mixing two axes', () => {
    const st = createShape(BINS);
    pushShapeRow(st, row(1, 2, 3, 4, 5, 6, 7, 8), 1000, 1000);
    pushShapeRow(st, Float32Array.from([1, 2, 3, 4]), 1100, 1000);
    assert.strictEqual(st.bins, 4);
    assert.strictEqual(st.rows.length, 1, 'rows from the old grid survived');
    // Explicitly, which is what a span change does.
    resetShape(st, SHAPE_BINS);
    assert.strictEqual(st.rows.length, 0);
    assert.strictEqual(st.bins, SHAPE_BINS);
});

t('the window a listener asks for is clamped rather than trusted', () => {
    assert.strictEqual(clampShapeSec(0), SHAPE_SEC_MIN);
    assert.strictEqual(clampShapeSec(1e6), SHAPE_SEC_MAX);
    assert.strictEqual(clampShapeSec(undefined), SHAPE_SEC_DEFAULT);
    assert.strictEqual(clampShapeSec('2'), 2);
});

t('the readout reports the time measured, not the time asked for', () => {
    // A feed at two frames a second cannot fill a half-second window, and saying
    // "0.5 s" there would be the one number on that line that was not measured.
    const { st, last } = feed(Array.from({ length: 6 }, () => row(-100)), { bins: 1, step: 500 });
    const s = shapeStats(st, 400, last);
    assert.strictEqual(s.rows, 1, 'half a second of window cannot hold two frames 500 ms apart');
    assert.strictEqual(s.spanMs, 0);
    assert.match(formatShape(s, 0.5), /0\.0 s · 1 frame$/);
    assert.match(formatShape(shapeStats(st, 3000, last), 3), /· 6 frames$/);
    // Nothing at all says so rather than showing a zero.
    assert.match(formatShape({ rows: 0, spanMs: 0 }, 2), /filling/);
    assert.match(formatShape(null, 2), /filling/);
    assert.ok(SHAPE_MIN_ROWS > 2, 'two readings are a pair, not a shape');
});

// ── Driving the main display ─────────────────────────────────────────────────

// A representative zoom floor. Deliberately not v2's own, which is lower: what
// is under test is the clamp, and it has to hold for whatever floor the
// interface reports — v1 and v2 no longer stop in the same place.
const FLOOR = 10240;

t('the zoom it asks for is one the interface can actually give', () => {
    // Every mode narrower than about five kilohertz wants less than the floor
    // and lands on it — which is as far in as the zoom goes, and where the
    // passband gets the most bins it ever will.
    assert.strictEqual(shapeZoomSpan({ span: 3375 }, FLOOR), FLOOR);     // USB
    assert.strictEqual(shapeZoomSpan({ span: 800 }, FLOOR), FLOOR);      // CW
    // Wider modes ask for twice their window, which is above the floor.
    assert.strictEqual(shapeZoomSpan({ span: 12500 }, FLOOR), 12500 * SHAPE_ZOOM_MARGIN);
    assert.strictEqual(shapeZoomSpan({ span: 20000 }, FLOOR), 20000 * SHAPE_ZOOM_MARGIN);
    // Nothing to draw, nothing to ask for.
    assert.strictEqual(shapeZoomSpan(null, FLOOR), 0);
    assert.strictEqual(shapeZoomSpan({ span: 0 }, FLOOR), 0);
});

t('it does not ask for a zoom it is already at', () => {
    const usb = { span: 3375 };
    // The whole band: worth moving.
    assert.strictEqual(shapeWantsZoom({ span: 30e6 }, usb, 1, FLOOR), true);
    // Already on the floor: asking again would be a channel reload on the
    // receiver that changed nothing, once per time the panel is opened. This is
    // the case a test against the *unclamped* wanted span gets wrong.
    assert.strictEqual(shapeWantsZoom({ span: FLOOR }, usb, 1, FLOOR), false);
    // Near enough is left alone — the slack is what stops it chasing a view
    // that is already close.
    assert.strictEqual(shapeWantsZoom({ span: FLOOR * 1.4 }, usb, 1, FLOOR), false);
    assert.strictEqual(shapeWantsZoom({ span: FLOOR * 2 }, usb, 1, FLOOR), true);
    // A wider mode judged against its own window rather than the floor.
    assert.strictEqual(shapeWantsZoom({ span: 25000 }, { span: 12500 }, 1, FLOOR), false);
});

t('...but it does ask when the view is not on the window at all', () => {
    // The same request sets the centre as well as the span, so it fixes this
    // too — and a deep zoom pointed somewhere else has no bins here whatever
    // its resolution.
    assert.strictEqual(shapeWantsZoom({ span: FLOOR }, { span: 3375 }, 0.6, FLOOR), true);
    assert.strictEqual(shapeWantsZoom({ span: FLOOR }, { span: 3375 }, 0, FLOOR), true);
});

t('nothing known yet is not a reason to move anything', () => {
    assert.strictEqual(shapeWantsZoom(null, { span: 3375 }, 1, FLOOR), false);
    assert.strictEqual(shapeWantsZoom({ span: 0 }, { span: 3375 }, 1, FLOOR), false);
    assert.strictEqual(shapeWantsZoom({ span: 30e6 }, null, 1, FLOOR), false);
    // No floor given falls back to the plain margin rather than to zero, which
    // would make every view look close enough.
    assert.strictEqual(shapeWantsZoom({ span: 30e6 }, { span: 3375 }, 1), true);
});

// ── Reading numbers off the shape ────────────────────────────────────────────

// A window with a filter inside it, and a scene to put in it: noise everywhere,
// a wide hump over part of the passband, a carrier on one bin.
const WIN = { offLo: -337.5, offHi: 3037.5, span: 3375, dial: 14_074_000 };
const TUNING = { bandwidthLow: 50, bandwidthHigh: 2700 };
const BAND = bandBins(SHAPE_BINS, WIN, TUNING);
const PER_BIN = WIN.span / SHAPE_BINS;

function scene({ humpFrom = 120, humpTo = 250, humpDb = 14, carrier = 300, carrierDb = 45, frames = 30 } = {}) {
    const st = createShape(SHAPE_BINS);
    const r = new Float32Array(SHAPE_BINS);
    for (let f = 0; f < frames; f++) {
        for (let i = 0; i < SHAPE_BINS; i++) {
            let db = -120 + Math.sin(f * 3.7 + i * 0.9) * 2.5;
            if (i >= humpFrom && i < humpTo) db += humpDb;
            if (i === carrier) db += carrierDb;
            r[i] = db;
        }
        pushShapeRow(st, r, 1000 + f * 100, 4000);
    }
    return shapeStats(st, 4000, 1000 + (frames - 1) * 100, {}, BAND);
}

t('the noise floor is measured before the filter mask, over the whole window', () => {
    // Measured from the passband alone, a filter full of signal would have no
    // quiet quarter left and the floor would land inside the signal. The margin
    // either side is the quietest part of the picture and it is free.
    const stats = scene({ humpFrom: BAND.first, humpTo: BAND.last, humpDb: 30, carrier: -1 });
    assert.ok(stats.floorDb < -110, `floor was ${stats.floorDb} with the passband full`);
    // ...and the mask is still applied to what comes out.
    assert.ok(Number.isNaN(stats.mean[0]) && Number.isFinite(stats.mean[BAND.first]));
});

t('the peak is the strongest point, refined between bins', () => {
    const stats = scene();
    const m = measureShape(stats, WIN, BAND, {});
    // Bin 300's own centre, to a fraction of a bin: a reading that stepped a
    // whole bin at a time would be visibly quantised on a steady carrier.
    const exact = WIN.offLo + (300 + 0.5) * PER_BIN;
    assert.ok(Math.abs(m.peak.offsetHz - exact) < PER_BIN / 2, `peak at ${m.peak.offsetHz}, bin at ${exact}`);
    assert.ok(m.peak.db > -80 && m.peak.db < -70, `peak level ${m.peak.db}`);
    // The frequency the panel shows is the dial plus the offset — an absolute
    // frequency, not a distance from where you are listening.
    assert.ok(Math.abs((WIN.dial + m.peak.offsetHz) - 14_075_643) < 2);
});

t('...and there is no peak at all in a passband of pure noise', () => {
    // The strongest *bin* of a channel with nothing in it is a random one, and
    // reporting it would be a frequency readout wandering over the whole filter.
    const stats = scene({ humpDb: 0, carrier: -1 });
    assert.strictEqual(measureShape(stats, WIN, BAND, {}).peak, null);
    // A carrier only just clear of the noise is not one either.
    const faint = scene({ humpDb: 0, carrierDb: SIGNAL_DB - 3 });
    assert.strictEqual(measureShape(faint, WIN, BAND, {}).peak, null);
});

t('the peak holds rather than swapping between two signals of a size', () => {
    // Two carriers a fraction of a decibel apart. Without hysteresis the reading
    // alternates between two frequencies as the average tips one way and the
    // other, which is worse than a reading that is a little slow.
    const twin = (lead) => {
        const st = createShape(SHAPE_BINS);
        const r = new Float32Array(SHAPE_BINS);
        for (let f = 0; f < 20; f++) {
            r.fill(-120);
            r[200] = -60;
            r[400] = -60 + lead;
            pushShapeRow(st, r, 1000 + f * 100, 4000);
        }
        return shapeStats(st, 4000, 2900, {}, BAND);
    };
    const state = {};
    assert.strictEqual(measureShape(twin(0), WIN, BAND, state).peak.bin, 200);
    // The other one edges ahead, but not by enough to take the reading.
    assert.strictEqual(measureShape(twin(PEAK_HOLD_DB / 2), WIN, BAND, state).peak.bin, 200);
    // Clearly ahead, and it does.
    assert.strictEqual(measureShape(twin(PEAK_HOLD_DB + 4), WIN, BAND, state).peak.bin, 400);
});

t('occupancy counts bins that hold a signal, not how loud they are', () => {
    const stats = scene();
    const m = measureShape(stats, WIN, BAND, {});
    // 130 hump bins plus the carrier, out of the passband's 403.
    const expected = (250 - 120 + 1) / (BAND.last - BAND.first + 1);
    assert.ok(Math.abs(m.occupancy - expected) < 0.02, `${m.occupancy} vs ${expected}`);

    // Ten times the hump's strength is the same occupancy: what is counted is
    // whether a bin is above the noise, not by how much.
    const louder = measureShape(scene({ humpDb: 40 }), WIN, BAND, {});
    assert.ok(Math.abs(louder.occupancy - m.occupancy) < 0.02, `${louder.occupancy} vs ${m.occupancy}`);

    // The two ends of the scale.
    assert.ok(measureShape(scene({ humpDb: 0, carrier: -1 }), WIN, BAND, {}).occupancy < 0.02);
    const full = measureShape(
        scene({ humpFrom: BAND.first, humpTo: BAND.last + 1, humpDb: 30, carrier: -1 }),
        WIN, BAND, {},
    );
    assert.ok(full.occupancy > 0.98, `a full passband read ${full.occupancy}`);
});

t('a window lifted from end to end has no reference and says so quietly', () => {
    // The one case a single channel cannot answer: with the margin raised as
    // well, nothing in the picture is quiet, so nothing stands out from anything
    // and occupancy reads low. Better that than inventing a floor.
    const everything = scene({ humpFrom: 0, humpTo: SHAPE_BINS, humpDb: 30, carrier: -1 });
    const m = measureShape(everything, WIN, BAND, {});
    assert.ok(everything.floorDb > -95, `floor was ${everything.floorDb}`);
    assert.ok(m.occupancy < 0.02, `${m.occupancy}`);
});

t('the pieces answer null rather than guessing when there is nothing to measure', () => {
    const empty = { first: 0, last: -1 };
    assert.strictEqual(occupancyOf(new Float32Array(8), empty, -100), null);
    assert.strictEqual(occupancyOf(new Float32Array(8), { first: 0, last: 7 }, NaN), null);
    assert.strictEqual(measurePeak(new Float32Array(8).fill(NaN), WIN, { first: 0, last: 7 }, -120, null), null);
    assert.strictEqual(measurePeak(new Float32Array(8), WIN, empty, -120, null), null);
    assert.ok(Number.isNaN(noiseFloorOf(new Float32Array(8).fill(NaN))));

    const state = { peak: { bin: 3 } };
    const none = measureShape({ rows: 0 }, WIN, BAND, state);
    assert.strictEqual(none.peak, null);
    assert.strictEqual(none.occupancy, null);
    assert.strictEqual(state.peak, null, 'a stale peak survived an empty window');
});

console.log(`\n${pass} passed`);
