// Flattening lock-screen artwork: the maths that decides whether a logo
// reaches the edges of the media card or sits in a black frame.
//
// Worth pinning because none of it can fail loudly. Every branch here produces
// a perfectly valid image; the only symptom of getting it wrong is a picture on
// somebody's lock screen with black down both sides, which no test that checks
// for errors will ever see.

const assert = require('assert');
const { backdropColor, coverPlacement, measureArtwork } = require('./.build/mediaflatten.cjs');

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

// --- what has to be done at all ---------------------------------------------

t('an opaque image is left alone — that is every operator photo', () => {
    const w = 40, h = 40;
    const data = image(w, h, () => [12, 34, 56, 255]);
    const { opaque, box } = measureArtwork(data, w, h);
    assert.strictEqual(opaque, true);
    // The box is still the whole frame; `opaque` is what the caller acts on.
    assert.deepStrictEqual(box, { left: 0, top: 0, right: 39, bottom: 39 });
});

t('transparency anywhere means work, even with no margin to crop', () => {
    // A tile that reaches every edge but has rounded — transparent — corners.
    // Nothing to crop, and still four black corners on the card if it is
    // skipped, so this must not be mistaken for an image that needs nothing.
    const w = 20, h = 20;
    const corner = (x, y) => (x < 2 && y < 2) || (x > 17 && y < 2)
        || (x < 2 && y > 17) || (x > 17 && y > 17);
    const data = image(w, h, (x, y) => (corner(x, y) ? [0, 0, 0, 0] : [...TILE, 255]));
    const { opaque, box } = measureArtwork(data, w, h);
    assert.strictEqual(opaque, false);
    assert.deepStrictEqual(box, { left: 0, top: 0, right: 19, bottom: 19 });
    // ...and flattening it is a repaint, not a rescale.
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

// --- where the content goes --------------------------------------------------

t('the margin is cropped away, not painted over', () => {
    const size = 100, margin = 10;
    const { box } = measureArtwork(launcherTile(size, margin), size, size);
    assert.deepStrictEqual(box, { left: 10, top: 10, right: 89, bottom: 89 });

    const p = coverPlacement(box, size, size);
    assert.deepStrictEqual({ sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh },
        { sx: 10, sy: 10, sw: 80, sh: 80 });
    // Scaled up to fill the frame exactly, and still centred.
    assert.deepStrictEqual({ dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh },
        { dx: 0, dy: 0, dw: 100, dh: 100 });
});

t('cover, not fit: a non-square mark overflows rather than letterboxing', () => {
    // The failure this whole module exists for. Fitting a wide mark into a
    // square frame is what leaves black down both sides; covering crops it.
    const w = 100, h = 100;
    const data = image(w, h, (x, y) => (
        (y >= 40 && y < 60) ? [...TILE, 255] : [0, 0, 0, 0]
    ));
    const { box } = measureArtwork(data, w, h);
    assert.deepStrictEqual(box, { left: 0, top: 40, right: 99, bottom: 59 });

    const p = coverPlacement(box, w, h);
    assert.ok(p.dw >= w && p.dh >= h, `covers the frame: ${p.dw}x${p.dh}`);
    // Overflow is symmetric, so the mark stays centred as it is clipped.
    assert.strictEqual(p.dx, (w - p.dw) / 2);
    assert.strictEqual(p.dy, (h - p.dh) / 2);
});

t('a one-pixel content box does not divide by zero', () => {
    const w = 6, h = 6;
    const data = image(w, h, (x, y) => (
        (x === 2 && y === 3) ? [...MARK, 255] : [0, 0, 0, 0]
    ));
    const { box } = measureArtwork(data, w, h);
    assert.deepStrictEqual(box, { left: 2, top: 3, right: 2, bottom: 3 });
    const p = coverPlacement(box, w, h);
    assert.ok(Number.isFinite(p.dw) && p.dw >= w);
    // backdrop samples inside the box; with one pixel that is the pixel itself.
    assert.strictEqual(backdropColor(data, w, box), '#ffffff');
});

// --- what the corners become -------------------------------------------------

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

console.log(`\n${pass} media artwork flattening checks passed`);
