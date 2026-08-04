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

const LOGO = [
    { path: '/images/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    { path: '/images/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
    { path: '/images/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
];

// The photo is declared at this size because the OS picks the largest artwork
// that fits, and a photo declared smaller than the logo would never win.
const PHOTO_SIZE = '800x800';

async function toBlobUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return URL.createObjectURL(await resp.blob());
}

let logoPromise = null;
let logoResolved = null;

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

// Cache of proxy path -> blob URL for operator photos, and the in-flight
// fetches, so the panel and the metadata builder share one request per callsign.
const photos = new Map();
const photoPending = new Map();

// One operator photo, as a MediaImage[] ready to drop into MediaMetadata.
//
// Deliberately not merged with the logo array: the OS picks the largest
// declared size, so including the 512×512 logo alongside the photo means the
// logo always wins and the photo is never seen.
export function photoArtwork(proxyPath) {
    if (!proxyPath) return Promise.resolve(null);
    if (photos.has(proxyPath)) {
        return Promise.resolve([{ src: photos.get(proxyPath), sizes: PHOTO_SIZE, type: 'image/jpeg' }]);
    }
    if (photoPending.has(proxyPath)) return photoPending.get(proxyPath);

    const p = toBlobUrl(proxyPath)
        .then((blobUrl) => {
            photos.set(proxyPath, blobUrl);
            photoPending.delete(proxyPath);
            return [{ src: blobUrl, sizes: PHOTO_SIZE, type: 'image/jpeg' }];
        })
        .catch((err) => {
            console.warn('[media] operator photo:', err.message);
            // Remember the failure as the raw path rather than retrying on
            // every frequency change; the proxy URL may still work directly.
            photos.set(proxyPath, proxyPath);
            photoPending.delete(proxyPath);
            return [{ src: proxyPath, sizes: PHOTO_SIZE, type: 'image/jpeg' }];
        });

    photoPending.set(proxyPath, p);
    return p;
}

// Something to show immediately while the blob is still being fetched, so the
// lock screen is not blank for the first second after tuning to a spot.
export function photoPlaceholder(proxyPath) {
    return proxyPath ? [{ src: proxyPath, sizes: PHOTO_SIZE, type: 'image/jpeg' }] : null;
}

// Photos accumulate one blob per operator over a long session. Called when the
// metadata moves off a photo, keeping at most this many alive.
const MAX_PHOTOS = 12;

export function trimPhotoCache(keep) {
    if (photos.size <= MAX_PHOTOS) return;
    for (const [path, url] of photos) {
        if (photos.size <= MAX_PHOTOS) break;
        if (path === keep) continue;
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        photos.delete(path);
    }
}

export function _resetArtwork() {
    logoPromise = null;
    logoResolved = null;
    photos.clear();
    photoPending.clear();
}
