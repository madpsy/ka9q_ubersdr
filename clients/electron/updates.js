// Whether a newer desktop client has been published.
//
// The three assets live under a rolling `latest` release tag, so their URLs
// never change and cannot themselves say whether the build behind them is newer
// than the one running. A small file on `main` says that instead: it names the
// version that is on the releases page now, and the app compares it with its
// own.
//
// The same shape as the server's own check (version_checker.go): a raw file
// from GitHub rather than the API, so there is no rate limit, no auth, and
// nothing to keep a token for.
//
// Published rather than derived. `main`'s package.json is the version being
// worked on, and that can run ahead of what has actually been uploaded —
// alerting on it would send somebody after a build that is not there yet.
// latest.json is updated when a release is published, so forgetting to bump it
// means no alert rather than a wrong one, which is the right way round.

const LATEST_URL = 'https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/clients/electron/latest.json';
const RELEASES_URL = 'https://github.com/madpsy/ka9q_ubersdr/releases';
const DOWNLOAD_BASE = 'https://github.com/madpsy/ka9q_ubersdr/releases/download/latest';

const FETCH_TIMEOUT_MS = 10000;

// What each platform is published as, and the architecture it is built for —
// build.sh packages the AppImage and the installer `--x64`, and the dmg is
// whatever the Mac it was built on was.
//
// An architecture not named here has no published asset, so it is sent to the
// releases page instead of being handed a binary that cannot run: an ARM Linux
// box and an Intel Mac would both otherwise download something useless.
const ASSETS = {
    win32: { arch: 'x64', file: 'UberSDR.Setup.exe' },
    linux: { arch: 'x64', file: 'UberSDR.AppImage' },
    darwin: { arch: 'arm64', file: 'UberSDR-arm64.dmg' },
};

/** Where this machine should go to get the new build. */
function downloadUrl(platform = process.platform, arch = process.arch) {
    const asset = ASSETS[platform];
    if (!asset || asset.arch !== arch) return RELEASES_URL;
    return `${DOWNLOAD_BASE}/${asset.file}`;
}

/**
 * Part by part and numerically, so 0.10.0 is newer than 0.9.0 — which a string
 * comparison gets backwards, and which is exactly the version this project
 * arrives at next.
 *
 * Anything unparseable is "not newer": a malformed file should leave the app
 * silent rather than alerting for ever on a version it cannot read.
 */
function isNewer(remote, local) {
    const parts = (v) => String(v == null ? '' : v).trim().replace(/^v/, '').split('.')
        .map((n) => parseInt(n, 10));
    const a = parts(remote);
    const b = parts(local);
    if (!a.length || a.some((n) => Number.isNaN(n))) return false;
    if (!b.length || b.some((n) => Number.isNaN(n))) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** The published version, or '' if the file says nothing usable. */
async function fetchLatestVersion() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        // no-store because a rolling file behind a CDN is exactly the thing a
        // cache will happily serve stale for the rest of the session.
        const res = await fetch(LATEST_URL, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return String((data && data.version) || '').trim();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `{ version, url }` when there is something newer, null when there is not.
 *
 * Throws when the check could not be made at all — offline, GitHub having a
 * day, a file that is not JSON. That is the caller's to swallow: a failed
 * update check is not news, and a dialog about one would be worse than the
 * silence.
 */
async function checkForUpdate(current) {
    const version = await fetchLatestVersion();
    if (!version || !isNewer(version, current)) return null;
    return { version, url: downloadUrl() };
}

module.exports = { checkForUpdate, downloadUrl, isNewer, LATEST_URL, RELEASES_URL };
