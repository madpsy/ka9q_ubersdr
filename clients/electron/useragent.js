'use strict';

// How this client names itself to the outside world.
//
// Chromium already builds a product token into its default user agent, from the
// npm package name and version:
//
//   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
//   ubersdr-desktop/0.1.0 Chrome/132.0.6834.210 Electron/34.5.8 Safari/537.36
//
// Right idea, wrong spelling: `ubersdr-desktop` is an npm package name, and it
// is what a receiver operator sees in their listener list. This swaps that one
// token for a readable one and leaves the rest of the string alone.
//
// The rest is left alone deliberately. The token is *replaced* rather than
// appended so the version is not stated twice, and the Mozilla/AppleWebKit/
// Chrome/Safari parts stay exactly as Chromium wrote them because the UI reads
// them: static/v2/src/lib/announce.js gates the spoken-frequency voices on
// `Chrome\/|Chromium\/|Edg\/`, and static/v2/src/radio/media/support.js picks
// the media-control anchor from the same test plus the platform. Replacing the
// whole string with "UberSDR Desktop/0.1.0" measurably turns the announcements
// off — the engine really is Chromium, so the string has to keep saying so.

const pkg = require('./package.json');

/** The token this client is identified by, e.g. `UberSDR-Desktop/0.1.0`. */
const PRODUCT = `UberSDR-Desktop/${pkg.version}`;

// Chromium's own token, as a pattern. Built from the package name rather than
// hardcoded so a rename cannot leave this silently matching nothing.
const DEFAULT_TOKEN = new RegExp(`\\b${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`, 'i');

/**
 * The browser user agent: Chromium's, with its package-name token replaced.
 *
 * Falls back to appending if Chromium ever stops including one, so a change in
 * its format costs a duplicated-looking string rather than an unidentified
 * client.
 */
function browserUserAgent(base) {
    if (!base) return PRODUCT;
    return DEFAULT_TOKEN.test(base) ? base.replace(DEFAULT_TOKEN, PRODUCT) : `${base} ${PRODUCT}`;
}

/**
 * For plain HTTP calls made by the main process — the instance directory and
 * the LAN probes. No browser engine is involved, so there is nothing to
 * preserve and the token stands on its own.
 */
const API_USER_AGENT = `${PRODUCT} (Electron)`;

module.exports = { PRODUCT, API_USER_AGENT, browserUserAgent };
