// Images prepared for an OS media card: opaque, square, and filling the frame.
//
// A media card is a black backing of its own shape, and it shows whatever it is
// handed centred on that black. Two of the pictures this client puts there
// arrive the wrong shape for it, from opposite directions:
//
//   the receiver's logo   a launcher tile — transparent margin, rounded corners
//                         — so it lands with black down both sides and black in
//                         every corner. The margin is packaging, not picture.
//
//   an operator's photo   opaque, and very often a portrait, so it lands in a
//                         square slot with black down both sides again.
//
// Both are fixed here, and the difference between them is the whole design.
// Cropping a couple of per cent off a tile loses nothing — the margin was never
// part of the mark — so a nearly-square picture is scaled to *cover* and the
// overflow is thrown away. Cropping a third off a portrait is not a crop, it is
// a different photograph, so anything meaningfully off-square is fitted whole
// and matted: the frame behind it is a blurred, zoomed copy of the picture
// itself, which is the standard answer for album art and reads as intentional
// where black reads as a fault.
//
// The maths is exported apart from the canvas because it is the part that can
// be wrong in ways nothing throws about, and the part a test can hold still.
// clients/capacitor carries the transparency half of this in Java
// (PlaybackService.opaque) for artwork reaching its notification without
// passing through here; if one changes the other should follow.

// Below this, a pixel is margin rather than mark. Antialiased edges are not
// content.
const ALPHA_FLOOR = 24;

// How far off square a picture may be and still be cropped to fill rather than
// matted. A tenth is a twentieth off each side — the tile's margin and nothing
// anybody would miss. A portrait is half again as tall as it is wide and lands
// well outside it.
const COVER_RATIO = 1.1;

// The output is square at the content's long side, so nothing is upscaled,
// capped so a large photo does not become a large JPEG for a thumbnail.
const MAX_SIDE = 1024;

// The mat is drawn larger than the frame so the blur has picture to reach for
// at the edges instead of pulling in the frame's own emptiness.
const MAT_OVERSCAN = 1.15;
const MAT_BLUR_DIVISOR = 12;

// JPEG is the point of the re-encode: a format with no alpha channel to carry,
// so nothing downstream — a canvas, an OS decoder, the Android client's own
// bitmap pass — can find transparency to composite onto black a second time.
const OUT_TYPE = 'image/jpeg';
const OUT_QUALITY = 0.92;

// --- the maths ---------------------------------------------------------------

/**
 * What an RGBA pixel array needs, in one pass.
 *
 * `opaque` is half of whether anything has to be done at all — an image with no
 * transparency has no black from that direction, margin or not. `box` is where
 * the picture actually is, and is null when nothing in it is opaque enough to
 * be content.
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

const boxWidth = (box) => box.right - box.left + 1;
const boxHeight = (box) => box.bottom - box.top + 1;

/** The side of the square frame this content belongs in. */
export function squareSide(box, max = MAX_SIDE) {
    return Math.min(Math.max(boxWidth(box), boxHeight(box)), max);
}

/** Near enough square to crop to fill rather than mat. */
export function fillsSquare(box) {
    const w = boxWidth(box);
    const h = boxHeight(box);
    return Math.max(w, h) / Math.min(w, h) <= COVER_RATIO;
}

/**
 * Nothing to do: already opaque, already square, already edge to edge. Every
 * artwork that is a plain square photograph takes this path and is passed
 * through untouched.
 */
export function alreadyCard(opaque, box, w, h) {
    return opaque && w === h && !!box
        && box.left === 0 && box.top === 0 && box.right === w - 1 && box.bottom === h - 1;
}

/**
 * The colour the frame is painted before anything is drawn on it.
 *
 * Taken from just inside the top edge of the content, at its horizontal centre:
 * for a tile with a mark on it that is the tile, which is what the corners
 * should be. It is also what a matted picture falls back to where the blur is
 * unavailable. Returned as '#rrggbb' — alpha is deliberately dropped, since a
 * frame with none is the whole point.
 */
export function backdropColor(data, w, box) {
    const inset = Math.max(1, Math.floor(boxHeight(box) / 40));
    const y = Math.min(box.top + inset, box.bottom);
    const x = (box.left + box.right) >> 1;
    const i = (y * w + x) * 4;
    const hex = (v) => v.toString(16).padStart(2, '0');
    return `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}`;
}

/**
 * Where to draw the content so it covers the whole w×h frame.
 *
 * Cover, not fit: the margin is cropped away rather than painted over, so the
 * mark reaches the edges the way a photograph does. Whatever overflows is
 * clipped by the frame, which is why the destination may be larger than it —
 * and `overscan` deliberately makes it larger still, for the mat.
 *
 * @returns {{sx,sy,sw,sh,dx,dy,dw,dh}} drawImage's nine-argument form.
 */
export function coverPlacement(box, w, h, overscan = 1) {
    const sw = boxWidth(box);
    const sh = boxHeight(box);
    const scale = Math.max(w / sw, h / sh) * overscan;
    return place(box, sw, sh, scale, w, h);
}

/**
 * Where to draw the content so all of it fits inside a square frame, centred.
 * The rest of the frame is the mat's, which is why this is the half that keeps
 * a portrait's head on.
 */
export function containPlacement(box, side) {
    const sw = boxWidth(box);
    const sh = boxHeight(box);
    return place(box, sw, sh, Math.min(side / sw, side / sh), side, side);
}

function place(box, sw, sh, scale, w, h) {
    const dw = sw * scale;
    const dh = sh * scale;
    return {
        sx: box.left, sy: box.top, sw, sh,
        dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh,
    };
}

/** The blur the mat is drawn through, as a CSS filter, for a frame this big. */
export function matBlur(side) {
    return `blur(${Math.max(2, Math.round(side / MAT_BLUR_DIVISOR))}px)`;
}

// --- the canvas --------------------------------------------------------------

/**
 * One image, redrawn as a media card: an opaque square Blob that fills its own
 * frame.
 *
 * Null when there is nothing to do (an opaque square picture, which is most
 * photographs) or nothing that can be done (no canvas, a decode that failed, a
 * read the browser will not allow) — in both cases the caller keeps the
 * original, which is what it would have used anyway.
 */
export async function cardImage(blob) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch (err) {
        return null;
    }
    try {
        const w = bitmap.width;
        const h = bitmap.height;
        if (!w || !h) return null;

        // Read at the source's own size: the content box is measured in source
        // pixels, and a scaled probe would move its edges.
        const probe = canvasOf(w, h);
        if (!probe) return null;
        probe.ctx.drawImage(bitmap, 0, 0);
        const { data } = probe.ctx.getImageData(0, 0, w, h);
        const { opaque, box } = measureArtwork(data, w, h);
        if (!box || alreadyCard(opaque, box, w, h)) return null;

        const side = squareSide(box);
        const out = canvasOf(side, side);
        if (!out) return null;
        const { ctx } = out;
        ctx.fillStyle = backdropColor(data, w, box);
        ctx.fillRect(0, 0, side, side);

        if (fillsSquare(box)) {
            draw(ctx, bitmap, coverPlacement(box, side, side));
        } else {
            // The mat first, then the picture whole on top of it. Where the
            // browser has no canvas filter the flat colour stands in — still a
            // frame the picture sits in rather than a black one.
            if (blurred(ctx, side)) {
                draw(ctx, bitmap, coverPlacement(box, side, side, MAT_OVERSCAN));
                ctx.filter = 'none';
            }
            draw(ctx, bitmap, containPlacement(box, side));
        }
        return await new Promise((resolve) => out.canvas.toBlob(resolve, OUT_TYPE, OUT_QUALITY));
    } catch (err) {
        return null;
    } finally {
        if (bitmap.close) bitmap.close();
    }
}

function canvasOf(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return ctx ? { canvas, ctx } : null;
}

function draw(ctx, bitmap, p) {
    ctx.drawImage(bitmap, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
}

function blurred(ctx, side) {
    if (!('filter' in ctx)) return false;
    try {
        ctx.filter = matBlur(side);
    } catch (err) {
        return false;
    }
    return ctx.filter !== 'none';
}
