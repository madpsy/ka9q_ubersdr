'use strict';

// How this client names itself to the outside world. The desktop client's
// clients/electron/useragent.js says why this matters and where it is read —
// the same applies here, with one difference that decides the shape below.
//
// Electron's default user agent already carries a product token built from the
// npm package name, so that file *replaces* it. Android's WebView carries no
// such token, so ours is appended.
//
// What must survive either way is the rest of the string. The UI reads it:
// static/v2/src/lib/announce.js gates the spoken-frequency voices on
// `Chrome\/|Chromium\/|Edg\/`, and static/v2/src/radio/media/support.js picks
// the media-control anchor from the same test. Android's WebView UA says
// `Chrome/<version>` and must keep saying so — replacing the string wholesale
// with "UberSDR Android/0.1.0" would measurably turn the announcements off.

import pkg from '../package.json';

/** The token this client is identified by, e.g. `UberSDR-Android/0.1.0`. */
export const PRODUCT = `UberSDR-Android/${pkg.version}`;

/**
 * The user agent for a receiver WebView: whatever the system WebView says,
 * with our token appended.
 */
export function browserUserAgent(base) {
    if (!base) return PRODUCT;
    return base.includes(PRODUCT) ? base : `${base} ${PRODUCT}`;
}

/**
 * For the plain HTTP calls the native side makes — the instance directory, the
 * GeoIP lookup and the probes. No browser engine is involved, so there is
 * nothing to preserve and the token stands on its own.
 */
export const API_USER_AGENT = `${PRODUCT} (Android)`;
