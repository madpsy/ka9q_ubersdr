// Preparing artwork for a media card: the maths that decides whether a picture
// reaches the edges of the card or sits in a black frame, and — once it has
// decided something must be done — whether the picture is cropped or matted.
//
// Worth pinning because none of it can fail loudly. Every branch here produces
// a perfectly valid image; the only symptom of getting it wrong is a picture on
// somebody's lock screen with black down both sides, or an operator's portrait
// with the top of their head cut off, which no test that checks for errors will
// ever see.

const assert = require('assert');
const {
    alreadyCard, backdropColor, containPlacement, coverPlacement, fillsSquare,
    matBlur, measureArtwork, squareSide,
} = require('./.build/cardart.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A w×h RGBA buffer, painted by a function of (x, y) returning [r,g,b,a].
function image(w, h, paint) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [r, g, b, a] = paint(x, y);
            const i = (y * w + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
        }
    }
    return data;
}

const TILE = [8, 162, 251];    // the tile's own blue
const MARK = [255, 255, 255];  // the glyph on it

// The real shape of a launcher icon: a transparent margin all round, a rounded
// opaque tile inside it, and a mark in the middle of the tile.
function launcherTile(size, margin) {
    const inner = size - margin;
    return image(size, size, (x, y) => {
        if (x < margin || y < margin || x >= inner || y >= inner) return [0, 0, 0, 0];
        const mid = size / 2;
        const glyph = Math.abs(x - mid) < size / 8 && Math.abs(y - mid) < size / 8;
        return glyph ? [...MARK, 255] : [...TILE, 255];
    });
}

const wholeOf = (w, h) => ({ left: 0, top: 0, right: w - 1, bottom: h - 1 });

// --- what has to be done at all ---------------------------------------------

t('a square opaque photograph is left alone', () => {
    const w = 40, h = 40;
    const data = image(w, h, () => [12, 34, 56, 255]);
    const { opaque, box } = measureArtwork(data, w, h);
    assert.strictEqual(opaque, true);
    assert.deepStrictEqual(box, wholeOf(w, h));
    assert.strictEqual(alreadyCard(opaque, box, w, h), true);
});

t('an opaque portrait is not — that is the black down both sides', () => {
    // The whole reason the photo half of this exists. Nothing is transparent,
    // nothing needs cropping, and it still lands in a square slot with black
    // either side of it.
    const w = 60, h = 90;
    const data = image(w, h, () => [12, 34, 56, 255]);
    const { opaque, box } = measureArtwork(data, w, h);
    assert.strictEqual(opaque, true);
    assert.strictEqual(alreadyCard(opaque, box, w, h), false);
});

t('transparency anywhere means work, even with no margin to crop', () => {
    // A tile that reaches every edge but has rounded — transparent — corners.
    // Nothing to crop, and still four black corners on the card if it is
    // skipped, so this must not be mistaken for a picture that needs nothing.
    const w = 20, h = 20;
    const corner = (x, y) => (x < 2 && y < 2) || (x > 17 && y < 2)
        || (x < 2 && y > 17) || (x > 17 && y > 17);
    const data = image(w, h, (x, y) => (corner(x, y) ? [0, 0, 0, 0] : [...TILE, 255]));
    const { opaque, box } = measureArtwork(data, w, h);
    assert.strictEqual(opaque, false);
    assert.deepStrictEqual(box, wholeOf(w, h));
    assert.strictEqual(alreadyCard(opaque, box, w, h), false);
    // ...and the work is a repaint, not a rescale.
    const p = coverPlacement(box, w, h);
    assert.deepStrictEqual(
        { dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 0, dy: 0, dw: 20, dh: 20 },
    );
});

t('a wholly transparent image has no content box', () => {
    const data = image(8, 8, () => [255, 255, 255, 0]);
    const { box } = measureArtwork(data, 8, 8);
    assert.strictEqual(box, null);
});

t('antialiased edges are margin, not content', () => {
    // A single faint ring outside the mark must not widen the box, or the
    // margin survives the crop and the black frame with it.
    const w = 10, h = 10;
    const data = image(w, h, (x, y) => {
        const inside = x >= 3 && x <= 6 && y >= 3 && y <= 6;
        const ring = x >= 2 && x <= 7 && y >= 2 && y <= 7;
        if (inside) return [...TILE, 255];
        if (ring) return [...TILE, 8];
        return [0, 0, 0, 0];
    });
    const { box } = measureArtwork(data, w, h);
    assert.deepStrictEqual(box, { left: 3, top: 3, right: 6, bottom: 6 });
});

// --- cropped, or matted ------------------------------------------------------

t('a tile is near enough square to crop; a portrait is not', () => {
    assert.strictEqual(fillsSquare({ left: 0, top: 0, right: 477, bottom: 475 }), true,
        'the real 512 logo, whose margin is a pixel deeper on one side');
    assert.strictEqual(fillsSquare(wholeOf(100, 100)), true);
    // The boundary: a tenth off is still a crop, a fifth is a decision.
    assert.strictEqual(fillsSquare(wholeOf(100, 110)), true);
    assert.strictEqual(fillsSquare(wholeOf(100, 120)), false);
    // A head-and-shoulders portrait, nowhere near.
    assert.strictEqual(fillsSquare(wholeOf(600, 900)), false);
    assert.strictEqual(fillsSquare(wholeOf(1600, 900)), false);
});

t('the square is the long side, so nothing is upscaled', () => {
    assert.strictEqual(squareSide(wholeOf(600, 900)), 900);
    assert.strictEqual(squareSide(wholeOf(1000, 700)), 1000);
    // ...but a big photograph does not become a big JPEG for a thumbnail, and
    // past the cap the fit scales down rather than the frame growing.
    assert.strictEqual(squareSide(wholeOf(1600, 900)), 1024);
    assert.strictEqual(squareSide(wholeOf(3000, 4000)), 1024);
    assert.strictEqual(squareSide(wholeOf(3000, 4000), 512), 512);
});

t('a matted portrait keeps all of itself, centred', () => {
    // The head stays on. Fitted whole, so the full 900 of height is inside the
    // 900 frame and the mat takes the sides.
    const box = wholeOf(600, 900);
    const side = squareSide(box);
    const p = containPlacement(box, side);
    assert.deepStrictEqual({ sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh },
        { sx: 0, sy: 0, sw: 600, sh: 900 });
    assert.deepStrictEqual({ dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 150, dy: 0, dw: 600, dh: 900 });
    // Nothing falls outside the frame — that is what "keeps all of itself" is.
    assert.ok(p.dx >= 0 && p.dy >= 0 && p.dx + p.dw <= side && p.dy + p.dh <= side);
});

t('a matted landscape is the same rule the other way up', () => {
    const box = wholeOf(1000, 700);
    const p = containPlacement(box, squareSide(box));
    assert.deepStrictEqual({ dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 0, dy: 150, dw: 1000, dh: 700 });
});

t('a photograph past the cap is fitted smaller, not framed bigger', () => {
    // 1600 wide against a 1024 cap: the frame stops at the cap and the picture
    // is scaled to fit inside it, whole and still centred.
    const box = wholeOf(1600, 900);
    const side = squareSide(box);
    assert.strictEqual(side, 1024);
    const p = containPlacement(box, side);
    assert.deepStrictEqual({ dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 0, dy: 224, dw: 1024, dh: 576 });
    assert.ok(p.dx + p.dw <= side && p.dy + p.dh <= side);
});

t('the mat is drawn past the frame, so the blur has picture to reach for', () => {
    const box = wholeOf(600, 900);
    const side = squareSide(box);
    const flush = coverPlacement(box, side, side);
    const mat = coverPlacement(box, side, side, 1.15);
    assert.ok(mat.dw > flush.dw && mat.dh > flush.dh, 'overscanned');
    // Overhanging on every side, or the blur pulls in the frame's own emptiness
    // at whichever edge it did not reach.
    assert.ok(mat.dx < 0 && mat.dy < 0);
    assert.ok(mat.dx + mat.dw > side && mat.dy + mat.dh > side);
});

t('the blur scales with the frame and never rounds away to nothing', () => {
    assert.strictEqual(matBlur(900), 'blur(75px)');
    assert.strictEqual(matBlur(1), 'blur(2px)');
    assert.match(matBlur(512), /^blur\(\d+px\)$/);
});

// --- where cropped content goes ----------------------------------------------

t('the margin is cropped away, not painted over', () => {
    const size = 100, margin = 10;
    const { box } = measureArtwork(launcherTile(size, margin), size, size);
    assert.deepStrictEqual(box, { left: 10, top: 10, right: 89, bottom: 89 });
    assert.strictEqual(squareSide(box), 80);

    const p = coverPlacement(box, 80, 80);
    assert.deepStrictEqual({ sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh },
        { sx: 10, sy: 10, sw: 80, sh: 80 });
    assert.deepStrictEqual({ dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 0, dy: 0, dw: 80, dh: 80 });
});

t('cover, not fit: a near-square mark overflows rather than letterboxing', () => {
    // 20 wide, 19 tall — inside the crop threshold, so it fills and the extra
    // pixel of height is thrown away rather than framed in black.
    const box = { left: 0, top: 0, right: 19, bottom: 18 };
    const side = squareSide(box);
    assert.strictEqual(fillsSquare(box), true);
    const p = coverPlacement(box, side, side);
    assert.ok(p.dw >= side && p.dh >= side, `covers the frame: ${p.dw}x${p.dh}`);
    // Overflow is symmetric, so the mark stays centred as it is clipped.
    assert.strictEqual(p.dx, (side - p.dw) / 2);
    assert.strictEqual(p.dy, (side - p.dh) / 2);
});

t('a one-pixel content box does not divide by zero', () => {
    const w = 6, h = 6;
    const data = image(w, h, (x, y) => (
        (x === 2 && y === 3) ? [...MARK, 255] : [0, 0, 0, 0]
    ));
    const { box } = measureArtwork(data, w, h);
    assert.deepStrictEqual(box, { left: 2, top: 3, right: 2, bottom: 3 });
    assert.strictEqual(squareSide(box), 1);
    assert.ok(Number.isFinite(coverPlacement(box, 1, 1).dw));
    assert.ok(Number.isFinite(containPlacement(box, 1).dw));
    // backdrop samples inside the box; with one pixel that is the pixel itself.
    assert.strictEqual(backdropColor(data, w, box), '#ffffff');
});

// --- what the frame becomes --------------------------------------------------

t('the backdrop is the tile, not the mark and not black', () => {
    const size = 100;
    const data = launcherTile(size, 10);
    const { box } = measureArtwork(data, size, size);
    // Sampled just inside the top of the content, above the glyph.
    assert.strictEqual(backdropColor(data, size, box), '#08a2fb');
});

t('the backdrop drops alpha — a frame with none is the whole point', () => {
    const w = 8, h = 8;
    const data = image(w, h, () => [17, 34, 51, 40]);
    const { box } = measureArtwork(data, w, h);
    assert.strictEqual(backdropColor(data, w, box), '#112233');
});

t('the backdrop is a CSS colour canvas will accept', () => {
    const size = 64;
    const data = launcherTile(size, 4);
    const { box } = measureArtwork(data, size, size);
    assert.match(backdropColor(data, size, box), /^#[0-9a-f]{6}$/);
});

console.log(`\n${pass} media card artwork checks passed`);
