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

// What each platform is published as, keyed by platform and then by
// architecture. Only Windows is single: build.sh packages Linux for both x64 and
// arm64, build-mac.sh builds both dmgs (`--mac --arm64 --x64`, from either kind
// of Mac), and the NSIS installer is x64 alone.
//
// A platform or an architecture not named here has no published asset, so it is
// sent to the releases page instead of being handed a binary that cannot run — a
// Windows-on-ARM box, or 32-bit anything.
//
// The Linux names are asymmetric because the bare pair is x64's for good: those
// two URLs are what every client already installed fetches when it updates, and
// adding an -x64 to them would 404 all of them at once. See build_linux in
// build.sh, which is where arm64's names are set.
const ASSETS = {
    win32: {
        x64: { file: 'UberSDR.Setup.exe' },
    },
    linux: {
        x64: { file: 'UberSDR.AppImage', deb: 'UberSDR.deb' },
        arm64: { file: 'UberSDR-arm64.AppImage', deb: 'UberSDR-arm64.deb' },
    },
    darwin: {
        arm64: { file: 'UberSDR-arm64.dmg' },
        x64: { file: 'UberSDR-x64.dmg' },
    },
};

// Linux is published twice — an AppImage that runs anywhere, and a .deb that
// installs properly on the Debian family — so unlike the other two, which asset
// is *this* machine's is a question about the running app rather than about the
// platform.
//
// Answered from where the app is running rather than from the distribution,
// because the distribution is the wrong question: a Fedora user who fetched the
// AppImage wants the AppImage, and offering a .deb because /etc/os-release said
// something is how somebody is handed a file their package manager will not
// open. Two facts settle it without guessing:
//
//   $APPIMAGE          set by the AppImage runtime, and only by it.
//   /opt/UberSDR/…     where the .deb installs (electron-builder's layout).
//
// Neither present is a working tree, an unpacked dir, or a tarball somebody
// arranged themselves — and there the AppImage is the right offer, being the
// one build that needs no package manager to agree to it.
const DEB_PREFIX = '/opt/UberSDR/';

/** Where this machine should go to get the new build. */
function downloadUrl(platform = process.platform, arch = process.arch, proc = process) {
    const asset = (ASSETS[platform] || {})[arch];
    if (!asset) return RELEASES_URL;
    const env = (proc && proc.env) || {};
    const execPath = (proc && proc.execPath) || '';
    // `asset.deb` rather than a platform test: having a second, packaged build
    // is what the question is about, and only the Linux entries carry one.
    const file = (asset.deb && !env.APPIMAGE && String(execPath).startsWith(DEB_PREFIX))
        ? asset.deb
        : asset.file;
    return `${DOWNLOAD_BASE}/${file}`;
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
