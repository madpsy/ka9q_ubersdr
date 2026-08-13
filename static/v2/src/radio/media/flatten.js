// Artwork with no transparency in it, filling its own frame.
//
// An OS media card draws whatever it is handed onto a black backing. An
// operator's photo is an opaque JPEG and looks right; the receiver's logo is a
// PNG of a rounded launcher tile — transparent corners, and a margin of a few
// per cent all round — so it lands on the lock screen as a picture with black
// down both sides and black in every corner. Nothing is wrong with the image:
// it is drawn to sit on whatever is behind it, and a media card is not behind
// it.
//
// So a transparent one is flattened before it ever reaches MediaMetadata: its
// opaque content is measured, scaled to *cover* the frame, and drawn over a
// colour sampled from the artwork itself — the tile's own colour, whatever a
// given instance's logo happens to be, rather than a constant that would be
// wrong for everybody else's.
//
// The maths lives here, apart from the canvas, because it is the part that can
// be wrong in ways nothing throws about — and the part a test can hold still.
// clients/capacitor carries the same algorithm in Java (PlaybackService.opaque)
// for artwork that reaches its notification without passing through here; if
// one changes the other should follow.

// Below this, a pixel is the margin rather than the mark. Antialiased edges are
// not content.
const ALPHA_FLOOR = 24;

/**
 * What an RGBA pixel array needs, in one pass.
 *
 * `opaque` decides whether anything has to be done at all — an image with no
 * transparency has no black anywhere, margin or not. `box` is where the picture
 * actually is, and is null when nothing in it is opaque enough to be content.
 *
 * @param {Uint8ClampedArray|number[]} data RGBA, row-major, w*h*4 long
 * @returns {{opaque:boolean, box:{left:number,top:number,right:number,bottom:number}|null}}
 */
export function measureArtwork(data, w, h) {
    let left = w, top = h, right = -1, bottom = -1;
    let opaque = true;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const a = data[(y * w + x) * 4 + 3];
            if (a < 255) opaque = false;
            if (a < ALPHA_FLOOR) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    const box = (right < left || bottom < top) ? null : { left, top, right, bottom };
    return { opaque, box };
}

/**
 * The colour the frame should be painted before the mark is drawn on it.
 *
 * Taken from just inside the top edge of the content, at its horizontal centre:
 * for a tile with a mark on it that is the tile, which is what the corners
 * should be. Returned as '#rrggbb' — alpha is deliberately dropped, since the
 * whole point is a frame with none.
 */
export function backdropColor(data, w, box) {
    const inset = Math.max(1, Math.floor((box.bottom - box.top) / 40));
    const y = Math.min(box.top + inset, box.bottom);
    const x = (box.left + box.right) >> 1;
    const i = (y * w + x) * 4;
    const hex = (v) => v.toString(16).padStart(2, '0');
    return `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}`;
}

/**
 * Where to draw the content box so it covers the whole w×h frame.
 *
 * Cover, not fit: the margin is cropped away rather than painted over, so the
 * mark reaches the edges the way a photo does. Whatever overflows is clipped by
 * the frame, which is why the destination is allowed to be larger than it.
 *
 * @returns {{sx,sy,sw,sh,dx,dy,dw,dh}} drawImage's nine-argument form.
 */
export function coverPlacement(box, w, h) {
    const sw = box.right - box.left + 1;
    const sh = box.bottom - box.top + 1;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    return {
        sx: box.left, sy: box.top, sw, sh,
        dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh,
    };
}
