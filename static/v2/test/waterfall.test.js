// The waterfall's ring buffer: reading it back in order.
//
// The ring is written backwards — the newest row goes at a decrementing index —
// so every read of it walks from the head and wraps once. Two places do that:
// painting the visible canvas, and carrying the history into a new ring when
// the pane is resized. Both go through ringSlices, which is what is tested here.
//
// It is worth testing because every way of getting it wrong is quiet. A wrap
// computed one row out does not throw and does not look broken: it splices a
// band of older history into the middle of the waterfall, which reads as a
// signal that was there and then was not. The resize case is worse, because it
// only happens when somebody drags a splitter — so it would ship.
//
// The ring itself is modelled here with rows as values and drawImage as an
// array copy. `commit` and `paint` mirror drawWaterfall in SpectrumView.jsx and
// have to be kept in step with it; the code under test is what they call.

const assert = require('assert');

const {
    RING_BG, RING_PAD, SCROLL_MAX_MS, SCROLL_MIN_MS,
    panTransform, ringHeightFor, ringKeepsHistory, ringSlices, smoothInterval,
    RING_MAX_CSS, RING_RESERVE_CSS,
} = require('./.build/waterfallring.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const BG = RING_BG;

const makeRing = (h, width = 640) => ({ px: new Array(h).fill(BG), height: h, head: 0, width, ring: true });

// drawWaterfall's commit: the head decrements and the newest row lands on it.
function commit(r, row) {
    r.head = (r.head - 1 + r.height) % r.height;
    r.px[r.head] = row;
}

// drawWaterfall's paint: the whole ring, newest at the top.
function paint(r) {
    const out = [];
    for (const s of ringSlices(r.head, r.height, r.height)) {
        for (let i = 0; i < s.sh; i++) out[s.dy + i] = r.px[s.sy + i];
    }
    return out;
}

// The resize path in SpectrumView's sizing effect.
function resize(r, h, width = r.width) {
    const next = makeRing(h, width);
    if (ringKeepsHistory(r, width)) {
        for (const s of ringSlices(r.head, r.height, Math.min(r.height, h))) {
            for (let i = 0; i < s.sh; i++) next.px[s.dy + i] = r.px[s.sy + i];
        }
    }
    return next;
}

// A row here is one value rather than a bitmap, so a width change moves it
// across unchanged — which is what the real rescale does to a row's *identity*.
// What the rescale actually costs is horizontal resolution, and that is a
// property of drawImage rather than of this arithmetic; these tests are about
// which rows survive and in what order.

// A ring of `h` rows with `n` rows received, newest last.
function filled(h, n, width) {
    const r = makeRing(h, width);
    for (let i = 0; i < n; i++) commit(r, i);
    return r;
}

// --- the read itself -------------------------------------------------------

t('the newest row is at the top', () => {
    assert.deepStrictEqual(paint(filled(5, 3)), [2, 1, 0, BG, BG]);
});

t('a ring that has wrapped still reads newest first', () => {
    assert.deepStrictEqual(paint(filled(4, 10)), [9, 8, 7, 6]);
});

t('an unwrapped read is one run, a wrapped one is two', () => {
    // head 0 needs no second run; anything else does, and the split has to fall
    // exactly at the end of the buffer.
    assert.deepStrictEqual(ringSlices(0, 8, 8), [{ sy: 0, sh: 8, dy: 0 }]);
    assert.deepStrictEqual(ringSlices(3, 8, 8), [
        { sy: 3, sh: 5, dy: 0 },
        { sy: 0, sh: 3, dy: 5 },
    ]);
});

t('the runs are contiguous, in order, and cover exactly what was asked for', () => {
    for (let h = 1; h <= 12; h++) {
        for (let head = 0; head < h; head++) {
            for (let rows = 0; rows <= h; rows++) {
                const runs = ringSlices(head, h, rows);
                let dy = 0;
                let total = 0;
                for (const s of runs) {
                    assert.strictEqual(s.dy, dy, `h=${h} head=${head} rows=${rows}`);
                    assert.ok(s.sh > 0 && s.sy >= 0 && s.sy + s.sh <= h,
                        `h=${h} head=${head} rows=${rows} run ${JSON.stringify(s)}`);
                    dy += s.sh;
                    total += s.sh;
                }
                assert.strictEqual(total, rows, `h=${h} head=${head} rows=${rows}`);
            }
        }
    }
});

t('no row is read twice, at any head and any depth', () => {
    for (let h = 1; h <= 10; h++) {
        for (let head = 0; head < h; head++) {
            for (let rows = 0; rows <= h; rows++) {
                const seen = new Set();
                for (const s of ringSlices(head, h, rows)) {
                    for (let i = 0; i < s.sh; i++) {
                        const y = s.sy + i;
                        assert.ok(!seen.has(y), `h=${h} head=${head} rows=${rows} repeats ${y}`);
                        seen.add(y);
                    }
                }
            }
        }
    }
});

t('asking for nothing, or from an empty ring, reads nothing', () => {
    assert.deepStrictEqual(ringSlices(0, 8, 0), []);
    assert.deepStrictEqual(ringSlices(0, 0, 4), []);
    assert.deepStrictEqual(ringSlices(3, 8, -2), []);
});

t('more rows than the ring holds is capped, not wrapped round twice', () => {
    // Otherwise the oldest history would be drawn again below itself.
    assert.deepStrictEqual(ringSlices(2, 4, 99), [
        { sy: 2, sh: 2, dy: 0 },
        { sy: 0, sh: 2, dy: 2 },
    ]);
});

// --- resizing --------------------------------------------------------------

t('the same height changes nothing', () => {
    for (const n of [0, 1, 3, 4, 9]) {
        const r = filled(4, n);
        assert.deepStrictEqual(paint(resize(r, 4)), paint(r), `n=${n}`);
    }
});

t('a taller pane keeps every row and shows background below it', () => {
    // The extra rows are history that does not exist yet, not history lost.
    assert.deepStrictEqual(paint(resize(filled(4, 4), 7)), [3, 2, 1, 0, BG, BG, BG]);
});

t('a shorter pane keeps the newest rows and drops the oldest', () => {
    assert.deepStrictEqual(paint(resize(filled(6, 6), 3)), [5, 4, 3]);
});

t('a wrapped ring survives a resize in either direction', () => {
    // The head in the middle is the case that gets spliced wrong if the second
    // run is miscomputed.
    const r = filled(5, 8);
    assert.strictEqual(r.head, 2, 'the fixture must actually have wrapped');
    assert.deepStrictEqual(paint(resize(r, 3)), [7, 6, 5]);
    assert.deepStrictEqual(paint(resize(r, 9)), [7, 6, 5, 4, 3, BG, BG, BG, BG]);
});

t('a partly filled ring does not resurrect its background as history', () => {
    assert.deepStrictEqual(paint(resize(filled(6, 2), 8)), [1, 0, BG, BG, BG, BG, BG, BG]);
});

t('the next row after a resize lands on top and pushes the rest down', () => {
    // The head is reset to 0 by the resize, so this is where an off-by-one
    // would show: the new row appearing at the bottom, or overwriting a kept one.
    for (const [h, n, next] of [[4, 4, 6], [4, 4, 2], [5, 8, 5], [6, 2, 9], [1, 5, 3]]) {
        const before = paint(filled(h, n));
        const r = resize(filled(h, n), next);
        commit(r, 'NEW');
        const after = paint(r);
        const where = `h=${h} n=${n} -> ${next}`;
        assert.strictEqual(after[0], 'NEW', where);
        const kept = Math.min(before.length, next - 1);
        assert.deepStrictEqual(after.slice(1, 1 + kept), before.slice(0, kept), where);
    }
});

t('repeated resizes neither smear nor reorder', () => {
    let r = filled(8, 8);
    for (const h of [3, 9, 5, 5, 2, 12]) r = resize(r, h);
    // Only what survived the narrowest step can remain, and in order.
    assert.deepStrictEqual(paint(r).slice(0, 2), [7, 6]);
    assert.ok(paint(r).slice(2).every((x) => x === BG), 'nothing may reappear behind it');
});

t('a one-row pane is not a special case', () => {
    assert.deepStrictEqual(paint(filled(1, 5)), [4]);
    assert.deepStrictEqual(paint(resize(filled(1, 5), 3)), [4, BG, BG]);
    assert.deepStrictEqual(paint(resize(filled(6, 6), 1)), [5]);
});

// --- when the history has to go --------------------------------------------

t('a width change keeps the history, rescaled onto the new axis', () => {
    // Every column is a frequency, so at a new width the stored columns sit
    // under different frequencies — which is a rescale of the bitmap, the same
    // one a zoom performs, and not a reason to throw the rows away. The caller
    // does the scaling; this only says there is something worth carrying.
    const r = filled(4, 4, 640);
    assert.strictEqual(ringKeepsHistory(r, 800), true);
    assert.deepStrictEqual(paint(resize(r, 4, 800)), [3, 2, 1, 0]);
    // Narrower is the same answer: the axis is shorter, not different.
    assert.deepStrictEqual(paint(resize(r, 4, 320)), [3, 2, 1, 0]);
    // …as is a height change at the same width, which was always kept.
    assert.strictEqual(ringKeepsHistory(r, 640), true);
    assert.deepStrictEqual(paint(resize(r, 2, 640)), [3, 2]);
});

t('there is nothing to keep before the first ring exists', () => {
    assert.strictEqual(ringKeepsHistory(null, 640), false);
    assert.strictEqual(ringKeepsHistory({ ring: null, width: 640, height: 300 }, 640), false);
    assert.strictEqual(ringKeepsHistory({ ring: true, width: 640, height: 0 }, 640), false);
    // A width of nothing at either end is not a rescale, it is a division by
    // zero waiting to happen: a pane that has not been laid out yet.
    assert.strictEqual(ringKeepsHistory({ ring: true, width: 0, height: 300 }, 640), false);
    assert.strictEqual(ringKeepsHistory({ ring: true, width: 640, height: 300 }, 0), false);
});

// --- the smooth scroll -----------------------------------------------------

// Feed a run of gaps through the estimator, keeping the previous raw gap the
// way the draw loop does.
function estimate(gaps, from = 0) {
    let e = from;
    let last = 0;
    for (const dt of gaps) {
        e = smoothInterval(e, dt, last);
        last = dt;
    }
    return e;
}

const repeat = (dt, n) => new Array(n).fill(dt);

t('a steady feed settles on its own interval', () => {
    // The duration of the slide is this estimate, so on a steady feed it has to
    // converge on the truth or every row is cut short or finishes early.
    for (const dt of [50, 100, 200]) {
        const e = estimate(repeat(dt, 40));
        assert.ok(Math.abs(e - dt) < 0.5, `${dt} ms feed settled at ${e}`);
    }
});

t('the first interval is taken whole, with nothing to compare against', () => {
    assert.strictEqual(smoothInterval(0, 200, 0), 200);
    assert.strictEqual(smoothInterval(undefined, 200, undefined), 200);
});

t('no measurement leaves the estimate alone', () => {
    // The first row has no previous one to time against, and must not reset an
    // estimate that had already settled.
    assert.strictEqual(smoothInterval(120, 0, 100), 120);
    assert.strictEqual(smoothInterval(120, -5, 100), 120);
    assert.strictEqual(smoothInterval(0, 0, 0), 0);
});

t('jitter against the animation clock is damped', () => {
    // A steady 20 Hz feed commits on animation frames, so it arrives as an
    // alternating 50 and 67 ms. Following that would swing the slide duration by
    // a third from row to row, which reads as the scroll surging.
    const gaps = [];
    for (let i = 0; i < 30; i++) gaps.push(i % 2 ? 50 : 67);
    const e = estimate(gaps);
    assert.ok(e > 50 && e < 67, `settled at ${e}`);
    const next = smoothInterval(e, 67, 50);
    assert.ok(Math.abs(next - e) < 6, `one jittery sample moved it ${Math.abs(next - e)} ms`);
});

t('a change of rate is adopted within a couple of rows', () => {
    // Zooming out halves the frame rate. A plain average took about eight rows
    // to catch up and slid for the wrong duration through every one of them,
    // which reads as the waterfall going sluggish for a second and then
    // settling — on every zoom.
    const halved = estimate([...repeat(100, 20), 200, 200]);
    assert.ok(Math.abs(halved - 200) < 1, `after halving the rate: ${halved}`);

    // …and the same the other way, zooming back in.
    const doubled = estimate([...repeat(200, 20), 100, 100]);
    assert.ok(Math.abs(doubled - 100) < 1, `after doubling the rate: ${doubled}`);
});

t('one late frame is not mistaken for a change of rate', () => {
    // A dropped frame doubles a single gap. Believing it would make the next row
    // slide at half speed and then jump when it was cut off — which is why two
    // arrivals have to agree before the estimate is replaced.
    const after = estimate([...repeat(100, 20), 200]);
    assert.ok(after > 100 && after < 135, `${after} ms after one dropped frame`);
    // The gap it followed is the outlier, so the next sample cannot pair with it
    // either: recovery is by damping, not by snapping to the wrong value.
    const back = estimate([100, 100, 100, 100, 100, 100, 100, 100], after);
    assert.ok(Math.abs(back - 100) < 5, `${back} ms after recovering`);
});

t('a stall cannot leave the next row crawling for seconds', () => {
    assert.strictEqual(smoothInterval(0, 30000, 0), SCROLL_MAX_MS);
    assert.ok(smoothInterval(100, 30000, 100) <= SCROLL_MAX_MS);
    // Two stalls in a row do agree with each other, so this is read as a change
    // of rate and adopted — correctly, since a feed that has genuinely slowed to
    // a crawl should scroll like one. The clamp is what bounds where it lands:
    // the estimate goes to the ceiling rather than to thirty seconds.
    assert.strictEqual(estimate([...repeat(100, 20), 30000, 30000]), SCROLL_MAX_MS);
});

t('the estimate always stays within the animatable range', () => {
    // A deliberately horrible feed: alternating fast, slow and stalled.
    let e = 0;
    let last = 0;
    for (const dt of [5, 1000, 40, 9000, 16, 250, 1, 600, 33]) {
        e = smoothInterval(e, dt, last);
        last = dt;
        assert.ok(e >= SCROLL_MIN_MS && e <= SCROLL_MAX_MS, `${dt} -> ${e}`);
    }
});

t('the overhang covers the tallest row the display panel can ask for', () => {
    // The scroll lifts the canvas by one row; if a row could be taller than the
    // overhang, the lift would expose background along the bottom edge.
    const maxRowHeight = 4;   // Display panel's slider maximum, CSS px
    const maxDpr = 2;         // SpectrumView clamps devicePixelRatio to this
    assert.ok(RING_PAD >= maxRowHeight * maxDpr,
        `RING_PAD ${RING_PAD} must cover ${maxRowHeight * maxDpr} device px`);
});


// ── Panning the history with the view ────────────────────────────────────────
//
// The second of the two answers to "what should the history do when the view
// moves": shift it, so a carrier keeps its column, and let black come in from
// the edge where there is no history. The arithmetic is one blit's worth of
// numbers and every one of them has a sign that is easy to get backwards.

const W = 1000;
const view = (centre, span) => ({ centre, span });

t('no move, no transform', () => {
    assert.strictEqual(panTransform(view(7.1e6, 200e3), view(7.1e6, 200e3), W), null);
});

t('panning up the band moves the history down the screen', () => {
    // Tuning 20 kHz higher across a 200 kHz view: everything already drawn
    // belongs 100 px to the left of where it is.
    const t1 = panTransform(view(7.10e6, 200e3), view(7.12e6, 200e3), W);
    assert.strictEqual(t1.offset, -100);
    assert.strictEqual(t1.scale, 1);
    assert.strictEqual(t1.pureShift, true);
    assert.strictEqual(t1.drop, false);

    // ...and the other way is the mirror of it.
    assert.strictEqual(panTransform(view(7.10e6, 200e3), view(7.08e6, 200e3), W).offset, 100);
});

t('a pan is a whole number of pixels, so dragging cannot smear the history', () => {
    // 37 Hz of a 200 kHz view is a fifth of a pixel: the bitmap is left alone
    // and the remainder is carried in the recorded centre, so the next frame of
    // the same drag can still move it.
    const t1 = panTransform(view(7.1e6, 200e3), view(7.1e6 + 37, 200e3), W);
    assert.strictEqual(t1.still, true);
    assert.strictEqual(t1.offset, 0);
    assert.strictEqual(t1.centre, 7.1e6, 'the debt is left standing, not zeroed');

    // Enough of those add up to a pixel, and the pixel gets moved: the bug this
    // pins is recording the live centre on a sub-pixel step, which zeroes the
    // debt every frame so a slow drag never moves the history at all.
    let ring = view(7.1e6, 200e3);
    let moved = 0;
    for (let i = 1; i <= 10; i++) {
        const r = panTransform(ring, view(7.1e6 + i * 37, 200e3), W);
        if (!r) continue;
        moved += r.offset;
        ring = { centre: r.centre, span: r.span };
    }
    const wanted = -((370) / 200e3) * W;
    assert.ok(moved !== 0, 'a slow drag never moved the history');
    assert.ok(Math.abs(moved - wanted) <= 0.5, `${moved} px for 370 Hz, wanted ${wanted}`);
});

t('the rounding error cannot accumulate over a long drag', () => {
    // Every step records where the pixels actually are, so after a thousand
    // sub-pixel steps the history is still within half a pixel of the axis.
    let ring = view(7.1e6, 200e3);
    let px = 0;
    const step = 61;                       // Hz per frame: 0.305 px
    for (let i = 1; i <= 1000; i++) {
        const r = panTransform(ring, view(7.1e6 + i * step, 200e3), W);
        if (!r) continue;                  // landed exactly where it already was
        px += r.offset;
        ring = { centre: r.centre, span: r.span };
    }
    const wanted = -((1000 * step) / 200e3) * W;
    assert.ok(Math.abs(px - wanted) <= 0.5, `drifted ${Math.abs(px - wanted).toFixed(2)} px`);
});

t('a zoom rescales once, and says so', () => {
    const t1 = panTransform(view(7.1e6, 200e3), view(7.1e6, 100e3), W);
    assert.strictEqual(t1.pureShift, false);
    assert.strictEqual(t1.scale, 2, 'the old span is twice the new one');
    assert.strictEqual(t1.offset, -500, 'and its left edge is off screen');
    assert.strictEqual(t1.centre, 7.1e6);
    assert.strictEqual(t1.span, 100e3, 'after a resample the pixels are in the new view');
});

t('a jump to another band drops the history rather than dragging it', () => {
    for (const to of [view(14.1e6, 200e3), view(3.6e6, 200e3)]) {
        assert.strictEqual(panTransform(view(7.1e6, 200e3), to, W).drop, true);
    }
    // The edge case either side: one pixel of overlap is worth keeping.
    assert.strictEqual(panTransform(view(7.1e6, 200e3), view(7.1e6 + 199.8e3, 200e3), W).drop, false);
    assert.strictEqual(panTransform(view(7.1e6, 200e3), view(7.1e6 + 200e3, 200e3), W).drop, true);
});

t('nonsense in, nothing out', () => {
    assert.strictEqual(panTransform(null, view(7e6, 1e3), W), null);
    assert.strictEqual(panTransform(view(7e6, 1e3), null, W), null);
    assert.strictEqual(panTransform(view(7e6, 0), view(7e6, 1e3), W), null);
    assert.strictEqual(panTransform(view(7e6, 1e3), view(7e6, 0), W), null);
    assert.strictEqual(panTransform(view(7e6, 1e3), view(7.1e6, 1e3), 0), null);
});

// --- how much is remembered, against how much is shown ----------------------

t('the ring is taller than the pane, so growing it has something to show', () => {
    // The black band this exists to prevent: close the bottom dock and the
    // waterfall gets taller, and every row of that new space was never recorded.
    const need = 600;
    const h = ringHeightFor(need, 0, 1);
    assert.ok(h >= need + RING_RESERVE_CSS, `${h} leaves no reserve above ${need}`);
});

t('the reserve is in CSS pixels, so a retina pane gets the same dock back', () => {
    // A bottom dock is 240 CSS px whatever the device pixel ratio, and the
    // reserve is sized against it — in device pixels it has to double when the
    // pixels do.
    const one = ringHeightFor(600, 0, 1);
    const two = ringHeightFor(1200, 0, 2);
    assert.strictEqual(two - 1200, (one - 600) * 2);
});

t('a shrinking pane keeps every row it had', () => {
    // The point of the whole thing: give the height back and the history is
    // still there. A ring that resized down with the pane would have dropped
    // the oldest rows, and they do not come back.
    const tall = ringHeightFor(1000, 0, 1);
    assert.strictEqual(ringHeightFor(300, tall, 1), tall);
});

t('it grows for a pane taller than the ring', () => {
    const small = ringHeightFor(300, 0, 1);
    const grown = ringHeightFor(1200, small, 1);
    assert.ok(grown >= 1200, 'the pane must fit in its own ring');
});

t('the ceiling stops a tall window from allocating without bound', () => {
    // Past it the band comes back, which is what this did at every size before.
    // Memory is the reason: the ring is a canvas as wide as the pane.
    const huge = ringHeightFor(4000, 0, 1);
    assert.strictEqual(huge, 4000, 'a pane taller than the cap still gets a ring that fits it');
    const capped = ringHeightFor(RING_MAX_CSS - 100, 0, 1);
    assert.ok(capped <= RING_MAX_CSS, `${capped} is past the ceiling`);
});


console.log(`\n${pass} passed`);
