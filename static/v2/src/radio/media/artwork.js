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

import { _resetPhotos, photoBlobUrl } from '../../lib/operatorPhoto.js';

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

async function toBlobUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return URL.createObjectURL(await resp.blob());
}

// The receiver's own artwork. Resolves to a MediaImage[] — falling back to the
// plain paths for any image that would not load, so there is always something.
export function logoArtwork() {
    if (logoResolved) return Promise.resolve(logoResolved);
    if (logoPromise) return logoPromise;

    logoPromise = Promise.all(LOGO.map(async ({ path, sizes, type }) => {
        try {
            return { src: await toBlobUrl(path), sizes, type };
        } catch (err) {
            console.warn(`[media] artwork ${path}:`, err.message);
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
