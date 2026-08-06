// Grabbing a passband edge, with a mouse and with a finger.
//
// The failure this guards against is the silent one: a grab zone big enough to
// hit with a fingertip is also big enough to swallow a tap meant to tune. Two
// things keep that from happening — the zones can only exist when the passband
// is wide enough on screen to leave a gap between them (checked here), and on
// touch nothing is decided until the finger moves (SpectrumView's `pending`).

const assert = require('assert');
const { edgeHit } = require('./.build/edgehit.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The constants SpectrumView uses. Both thresholds are three times the smallest
// zone still worth aiming at — 3 px for a pointer, 7 px for a fingertip — which
// is all this gate decides: the zones-never-meet invariant is the third-cap's
// job, not this number's, and pinning that separation is what the last test here
// is for.
const MOUSE = { grab: 6, minPx: 9 };
// Touch is offered the gesture at the same width as a pointer and only differs in
// how big a handle it gets where there is room.
const TOUCH = { grab: 22, minPx: 9 };
// SpectrumView's EDGE_FLOOR_PX: the narrowest a drag may leave the passband.
// Deliberately wider than either threshold — see the round-trip test below.
const FLOOR_PX = 13;

const W = 800;               // row width, CSS px
const CENTRE = 14100000;     // Hz at the middle of the row
const USB = { frequency: 14074000, bandwidthLow: 50, bandwidthHigh: 2750 };

// A view whose span makes the passband exactly `px` wide on screen.
const spanFor = (tuning, px) => (Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow) * W) / px;

// Where an offset from the dial lands, in CSS px from the row's left.
const xOf = (span, tuning, hz) => (
    ((tuning.frequency + hz - (CENTRE - span / 2)) / span) * W
);

const hit = (x, span, z, tuning = USB) => edgeHit(x, W, span, CENTRE, tuning, z.grab, z.minPx);

t('an edge is grabbed when the pointer is on it', () => {
    const span = spanFor(USB, 200);
    assert.strictEqual(hit(xOf(span, USB, USB.bandwidthLow), span, MOUSE), 'low');
    assert.strictEqual(hit(xOf(span, USB, USB.bandwidthHigh), span, MOUSE), 'high');
});

t('the nearer edge wins', () => {
    const span = spanFor(USB, 200);
    const lowX = xOf(span, USB, USB.bandwidthLow);
    const highX = xOf(span, USB, USB.bandwidthHigh);
    assert.strictEqual(hit(lowX + 3, span, MOUSE), 'low');
    assert.strictEqual(hit(highX - 3, span, MOUSE), 'high');
});

t('the middle of a wide passband is nobody\'s edge', () => {
    const span = spanFor(USB, 200);
    const mid = (xOf(span, USB, USB.bandwidthLow) + xOf(span, USB, USB.bandwidthHigh)) / 2;
    assert.strictEqual(hit(mid, span, MOUSE), null);
    assert.strictEqual(hit(mid, span, TOUCH), null, 'a finger must still be able to tap the middle');
});

t('zoomed out, there is nothing to grab and every click tunes', () => {
    // A 2.7 kHz filter across a 2 MHz view is about a pixel wide. Both edges are
    // on the dial line, and a grab zone there would take every tap on it.
    const span = 2e6;
    for (const x of [xOf(span, USB, 0), xOf(span, USB, USB.bandwidthLow), xOf(span, USB, USB.bandwidthHigh)]) {
        assert.strictEqual(hit(x, span, MOUSE), null, `mouse at ${x}`);
        assert.strictEqual(hit(x, span, TOUCH), null, `touch at ${x}`);
    }
});

t('a finger gets a zone it can actually hit', () => {
    const span = spanFor(USB, 200);
    const lowX = xOf(span, USB, USB.bandwidthLow);
    // 14 px off the line: a miss for a mouse, well within a fingertip.
    assert.strictEqual(hit(lowX + 14, span, MOUSE), null);
    assert.strictEqual(hit(lowX + 14, span, TOUCH), 'low');
});

t('touch is offered the gesture wherever the mouse is', () => {
    // It used to wait for a passband three times as wide. On touch a miss is free
    // — nothing is decided until the finger moves — so being the stricter of the
    // two was withholding the resize without protecting anything.
    assert.strictEqual(TOUCH.minPx, MOUSE.minPx);
    const span = spanFor(USB, MOUSE.minPx);
    const lowX = xOf(span, USB, USB.bandwidthLow);
    assert.strictEqual(hit(lowX, span, MOUSE), 'low');
    assert.strictEqual(hit(lowX, span, TOUCH), 'low');
});

t('a filter narrowed as far as a drag allows can still be widened again', () => {
    // The one-way door, and the reason the floor is its own number. A drag used to
    // stop exactly on the grab threshold, where the passband is grabbable only
    // while nothing rounds it down — and the width snap, the receiver's own grain
    // and a float division by the span all do. The edge then stopped answering and
    // the filter could only be recovered from the panel.
    //
    // So the floor has to clear the threshold by enough to survive all three. A
    // pixel of slop stands in for them here.
    for (const z of [MOUSE, TOUCH]) {
        assert.ok(FLOOR_PX > z.minPx, `the floor must not sit on the threshold (grab ${z.grab})`);
        for (const px of [FLOOR_PX, FLOOR_PX - 1]) {
            const span = spanFor(USB, px);
            const lowX = xOf(span, USB, USB.bandwidthLow);
            const highX = xOf(span, USB, USB.bandwidthHigh);
            assert.strictEqual(hit(lowX, span, z), 'low', `${px}px, grab ${z.grab}`);
            assert.strictEqual(hit(highX, span, z), 'high', `${px}px, grab ${z.grab}`);
        }
    }
});

t('a passband with clear space between its edges can be grabbed', () => {
    // What the thresholds were loosened for. 12 px of passband is two lines with
    // daylight between them: a 4 px handle either side and 4 px of middle. It is
    // small, and it is plainly there — the display refusing to let go of either
    // edge at that size was the complaint.
    const span = spanFor(USB, 12);
    const lowX = xOf(span, USB, USB.bandwidthLow);
    const highX = xOf(span, USB, USB.bandwidthHigh);
    assert.strictEqual(hit(lowX, span, MOUSE), 'low');
    assert.strictEqual(hit(highX, span, MOUSE), 'high');
    assert.strictEqual(hit((lowX + highX) / 2, span, MOUSE), null, 'and the middle is still nobody\'s');
});

t('the handle never grows past a third, however lenient the threshold', () => {
    // The one thing the loosening must not have bought: a zone that reaches
    // further than a third of the passband, at the sizes it now allows.
    for (const z of [MOUSE, TOUCH]) {
        for (const px of [z.minPx, z.minPx + 1, z.minPx * 2, 60]) {
            const span = spanFor(USB, px);
            const lowX = xOf(span, USB, USB.bandwidthLow);
            const reach = Math.min(z.grab, px / 3);
            assert.strictEqual(hit(lowX + reach - 0.01, span, z), 'low', `${px}px, grab ${z.grab}`);
            assert.strictEqual(hit(lowX + reach + 0.01, span, z), null, `${px}px, grab ${z.grab}`);
        }
    }
});

t('the zone shrinks with the passband rather than the threshold holding it off', () => {
    // The regression this exists for: a fixed 22 px zone needs a 66 px passband
    // before two of them stop overlapping, which for 2.7 kHz of SSB on a phone
    // is only the very last rung of the zoom ladder. The zone is capped at a
    // third instead, so the gesture is offered much further out — with a
    // proportionally smaller handle, which is the honest trade.
    const span = spanFor(USB, 36);          // 12 px a side, 12 px of middle
    const lowX = xOf(span, USB, USB.bandwidthLow);
    const highX = xOf(span, USB, USB.bandwidthHigh);
    assert.strictEqual(hit(lowX, span, TOUCH), 'low');
    assert.strictEqual(hit(lowX + 11, span, TOUCH), 'low', 'the whole third is grabbable');
    assert.strictEqual(hit((lowX + highX) / 2, span, TOUCH), null, 'the middle is still nobody\'s');
    // Wide enough and the cap is the full zone again, not a third of 200 px.
    const wide = spanFor(USB, 200);
    const wideLow = xOf(wide, USB, USB.bandwidthLow);
    assert.strictEqual(hit(wideLow + 22, wide, TOUCH), 'low');
    assert.strictEqual(hit(wideLow + 23, wide, TOUCH), null);
});

t('the two zones never meet, at any width either allows', () => {
    // The invariant that makes a finger-sized zone safe: wherever the zones are
    // permitted at all, there is still passband between them belonging to
    // neither — somewhere to tap, and somewhere to start a pan.
    for (const z of [MOUSE, TOUCH]) {
        for (let px = z.minPx; px <= 400; px += 1) {
            const span = spanFor(USB, px);
            const lowX = xOf(span, USB, USB.bandwidthLow);
            const highX = xOf(span, USB, USB.bandwidthHigh);
            const mid = (lowX + highX) / 2;
            assert.strictEqual(
                hit(mid, span, z), null,
                `zones meet at ${px}px of passband (grab ${z.grab})`,
            );
        }
    }
});

t('a lower-sideband passband grabs the same way', () => {
    const lsb = { frequency: 7100000, bandwidthLow: -2750, bandwidthHigh: -50 };
    const span = spanFor(lsb, 200);
    const x = (hz) => ((lsb.frequency + hz - (CENTRE - span / 2)) / span) * W;
    assert.strictEqual(edgeHit(x(-2750), W, span, CENTRE, lsb, MOUSE.grab, MOUSE.minPx), 'low');
    assert.strictEqual(edgeHit(x(-50), W, span, CENTRE, lsb, MOUSE.grab, MOUSE.minPx), 'high');
});

t('a symmetrical passband grabs the same way', () => {
    const am = { frequency: 9410000, bandwidthLow: -5000, bandwidthHigh: 5000 };
    const span = spanFor(am, 300);
    const x = (hz) => ((am.frequency + hz - (CENTRE - span / 2)) / span) * W;
    assert.strictEqual(edgeHit(x(-5000), W, span, CENTRE, am, TOUCH.grab, TOUCH.minPx), 'low');
    assert.strictEqual(edgeHit(x(5000), W, span, CENTRE, am, TOUCH.grab, TOUCH.minPx), 'high');
    assert.strictEqual(edgeHit(x(0), W, span, CENTRE, am, TOUCH.grab, TOUCH.minPx), null);
});

t('a row with no width or no span answers nothing rather than NaN', () => {
    assert.strictEqual(edgeHit(10, 0, 5000, CENTRE, USB, 6, 24), null);
    assert.strictEqual(edgeHit(10, W, 0, CENTRE, USB, 6, 24), null);
});

console.log(`\n${pass} ok`);
