'use strict';

// How this client names itself to the outside world. The desktop client's
// clients/electron/useragent.js says why this matters and where it is read —
// the same applies here, with one difference that decides the shape below.
//
// Electron's default user agent already carries a product token built from the
// npm package name, so that file *replaces* it. A system WebView carries no
// such token, so ours is appended.
//
// What must survive either way is the rest of the string. The UI reads it:
// static/v2/src/lib/announce.js gates the spoken-frequency voices on
// `Chrome\/|Chromium\/|Edg\/`, and static/v2/src/radio/media/support.js picks
// the media-control anchor from the same test. Android's WebView UA says
// `Chrome/<version>` and iOS's says `Safari/<version>`; both must keep saying
// so, which is why the token is appended and never substituted.
//
// ── Which platform, and why it is asked rather than built in ─────────────────
//
// This file is one of the ones that is literally the same on both platforms —
// see the README — and it used to say Android on both, so an iPad reported
// itself to every receiver and to the directory as `UberSDR-Android/0.3.0`.
//
// A build-time define would have been the other way to fix it, and would have
// been wrong here: `build-mac.sh` stages the interface by calling the *same*
// `build.sh --stage-ui` the Android build uses, so there is one bundle and one
// `www/` for both apps. Anything decided at build time would have to be decided
// before it is known which app the result is for. Capacitor already knows at
// runtime, so it is asked.

import { Capacitor } from '@capacitor/core';
import pkg from '../package.json';

// What each platform is called in a user agent. Capitalised as the platforms
// write themselves — `iOS`, not `Ios` — because this string is read by people
// in server logs as often as it is counted by machines.
const PLATFORM_NAMES = { android: 'Android', ios: 'iOS' };

/**
 * `Android`, `iOS`, or nothing at all.
 *
 * Nothing rather than a guess: this bundle only ever runs inside one of the two
 * apps, so an unrecognised platform means something is wrong, and a client that
 * quietly claimed to be Android on the strength of being unsure is exactly the
 * bug this file just had. `UberSDR/0.3.0` is a token a human can act on.
 */
function platformName() {
    try {
        return PLATFORM_NAMES[Capacitor.getPlatform()] || '';
    } catch (e) {
        // Capacitor absent entirely — a bundle opened outside the app.
        return '';
    }
}

const NAME = platformName();

/** The token this client is identified by, e.g. `UberSDR-iOS/0.3.0`. */
export const PRODUCT = `UberSDR${NAME ? `-${NAME}` : ''}/${pkg.version}`;

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
export const API_USER_AGENT = NAME ? `${PRODUCT} (${NAME})` : PRODUCT;
