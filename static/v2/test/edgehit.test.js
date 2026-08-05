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

// The constants SpectrumView uses.
const MOUSE = { grab: 6, minPx: 24 };
const TOUCH = { grab: 22, minPx: 66 };

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

t('touch waits for a wider passband than the mouse does', () => {
    // 40 px of passband: aimable with a pointer, two overlapping zones with a
    // finger, so touch declines and the whole thing stays a tap.
    const span = spanFor(USB, 40);
    const lowX = xOf(span, USB, USB.bandwidthLow);
    assert.strictEqual(hit(lowX, span, MOUSE), 'low');
    assert.strictEqual(hit(lowX, span, TOUCH), null);
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
