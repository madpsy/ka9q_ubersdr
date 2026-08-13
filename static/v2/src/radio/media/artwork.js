// Lock-screen artwork, as blob: URLs.
//
// Why not just hand MediaMetadata the paths: Chrome re-fetches every artwork
// URL each time the associated element goes waiting→playing, which during the
// buffering phase of a live stream is hundreds of times. Fetching each image
// once and passing a blob: URL turns all of those into memory reads.
//
// It also fixes a subtler problem for the operator photo. The photo comes from
// the same-origin proxy (/api/lookup/image/<uuid>, lookup_image_proxy.go), and
// a blob is resolvable by the browser no matter what the certificate or the
// network topology looks like — an absolute https:// URL to a receiver on a
// local IP with a self-signed cert silently fails to load on a phone, and the
// car stereo shows no art with no error anywhere.
//
// Owning the bytes buys one more thing: the logo is redrawn on the way past.
// It is a launcher tile — transparent margin, rounded corners — and a media
// card is a black backing, so handed over as it ships it appears with black
// down both sides. lib/cardArt.js is why it does not, and the same call does
// the same job for a portrait photo, which lands in a square slot with black
// down both sides for the opposite reason. The fallback paths below are the
// files as they ship, because something to show beats nothing.

import { _resetPhotos, photoBlobUrl } from '../../lib/operatorPhoto.js';
import { cardImage } from '../../lib/cardArt.js';

const LOGO = [
    { path: '/images/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    { path: '/images/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
    { path: '/images/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
];

// The photo is declared at this size because the OS picks the largest artwork
// that fits, and a photo declared smaller than the logo would never win.
const PHOTO_SIZE = '800x800';

let logoPromise = null;
let logoResolved = null;

// The plain paths, usable synchronously. The blobs are an optimisation, not a
// requirement, and metadata should never go out with an empty artwork array
// just because the fetches have not finished — v1 waits for the blobs before it
// sets anything, and matching what a working implementation hands the browser
// is worth more than saving one assignment.
export function logoFallback() {
    return LOGO.map(({ path, sizes, type }) => ({
        src: new URL(path, location.origin).href, sizes, type,
    }));
}

// What is cached right now, or the plain paths.
export function logoNow() {
    return logoResolved || logoFallback();
}

// One logo image, fetched once and handed back as a MediaImage. The declared
// type follows the bytes rather than the source file — a redrawn one is no
// longer the PNG the path names.
async function toArtwork({ path, sizes, type }) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const card = await cardImage(blob);
    return {
        src: URL.createObjectURL(card || blob),
        sizes,
        type: card ? (card.type || 'image/jpeg') : type,
    };
}

// The receiver's own artwork. Resolves to a MediaImage[] — falling back to the
// plain paths for any image that would not load, so there is always something.
export function logoArtwork() {
    if (logoResolved) return Promise.resolve(logoResolved);
    if (logoPromise) return logoPromise;

    logoPromise = Promise.all(LOGO.map(async (image) => {
        try {
            return await toArtwork(image);
        } catch (err) {
            console.warn(`[media] artwork ${image.path}:`, err.message);
            const { path, sizes, type } = image;
            return { src: new URL(path, location.origin).href, sizes, type };
        }
    })).then((art) => {
        logoResolved = art;
        logoPromise = null;
        return art;
    });

    return logoPromise;
}

// One operator photo, as a MediaImage[] ready to drop into MediaMetadata.
//
// The fetching and the cache belong to lib/operatorPhoto.js, which the Callsign
// panel also uses — this only shapes the result for the OS. Deliberately not
// merged with the logo array: the OS picks the largest declared size, so
// including the 512x512 logo alongside the photo means the logo always wins and
// the photo is never seen.
export function photoArtwork(proxyPath) {
    return photoBlobUrl(proxyPath).then((src) => (
        src ? [{ src, sizes: PHOTO_SIZE, type: 'image/jpeg' }] : null
    ));
}

export function _resetArtwork() {
    logoPromise = null;
    logoResolved = null;
    _resetPhotos();
}
