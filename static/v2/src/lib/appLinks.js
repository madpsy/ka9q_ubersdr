// This receiver, handed to an app.
//
// Two schemes, one shape:
//
//   vibesdr://connect?uuid=<public uuid>
//   ubersdr://connect?uuid=<public uuid>
//
// The UUID is the instance's public one — the `id` the directory lists it under
// (`public_uuid` in /api/description, see instance_reporter.go) — and not the
// session's. It names the receiver, so the app can look up where that receiver
// is *now* rather than being told an address that was true when the link was
// made. A tunnel hostname changes; the UUID does not.
//
// Which is also why the link carries nothing else. The apps resolve the UUID
// against the directory themselves (clients/electron/deeplink.js and
// clients/capacitor/src/deeplink.js are the two ends of ubersdr://), and an
// address here would be the one part of it guaranteed to go stale.
//
// Plain JS rather than part of StartExtras.jsx so that these can be tested —
// the v2 test harness bundles .js modules under node, and a link that is wrong
// fails silently: the OS simply does nothing with a scheme nobody claims.

const connectUri = (scheme, publicUuid) => {
    const uuid = String(publicUuid || '').trim();
    // No UUID, no link: an instance that is not registered with the directory
    // has nothing for an app to connect *to*, and callers use the null to leave
    // the button out rather than offer one that cannot work.
    if (!uuid) return null;
    // A UUID needs no escaping and v1 does none (app.js _buildVibeSDRUri), so
    // this produces the identical string for every real instance. It is here
    // for the one that is not real — the value arrives from the server, and a
    // link is a URL whether or not what went into it was one.
    return `${scheme}://connect?uuid=${encodeURIComponent(uuid)}`;
};

/** The VibeSDR app's link for this receiver, or null. */
export function vibesdrUri(publicUuid) {
    return connectUri('vibesdr', publicUuid);
}

/**
 * The UberSDR app's link for this receiver, or null.
 *
 * Followed by the desktop client (Windows, macOS, Linux) and the Android
 * client, which register the scheme with the platform. Nothing happens if
 * neither is installed — an unclaimed scheme is not an error anywhere, which is
 * why the dialog that offers this also shows the link itself.
 */
export function ubersdrAppUri(publicUuid) {
    return connectUri('ubersdr', publicUuid);
}

// Where the desktop client comes from, per platform.
//
// The same artefacts the project's own site offers, from the same rolling
// `latest` release — the file names are fixed on purpose (see the artifactName
// note in clients/electron/package.json) so a link written here does not 404 on
// the next version bump.
//
// `note` is what the operator is actually getting, and is not decoration: the
// Linux build is x86_64 only and the macOS build is Apple Silicon only, so a
// button that said no more than "Download" would be offering an ARM Chromebook
// an AppImage it cannot run.
//
// Linux appears twice, which is why `os` is not the identity here and `id` is.
// The two are not the same download with a different extension:
//
//   AppImage   runs anywhere, on any distribution, without root and without a
//              package manager agreeing to it. It is also not *installed* — a
//              file in a downloads folder has no .desktop entry, so there is no
//              application-menu item and ubersdr:// links do not open it, since
//              a URL scheme is claimed by an installed entry and nothing else.
//   .deb       the Debian family, installed properly: menu item, icon, and the
//              scheme association that makes the "Open in App" link above this
//              button work at all.
//
// So the choice is a real one and both are offered rather than one being picked
// on somebody's behalf — the notes say which is which, because "Linux" alone
// cannot.
const RELEASE = 'https://github.com/madpsy/ka9q_ubersdr/releases/download/latest';

// The icons are the project site's own, at 64 px tall so a button can draw them
// at any size a phone or a scaled UI asks for. Served by the instance from
// static/images/os/ — a path this page can rely on, since it is the same server
// the page itself came from.
const ICONS = '/images/os';

// Only Windows is a single row. macOS is published as two dmgs (build-mac.sh
// builds `--mac --arm64 --x64` from either kind of Mac), and Linux appears four
// times: the AppImage-and-.deb pair, for x86_64 and for aarch64 — a Raspberry Pi
// 5, an Asahi Mac, an ARM Chromebook's container, an ARM server.
//
// `arch` is on every row so the tests can hold each label and URL to the
// architecture it claims; nothing filters on it, for the reason below the list.
//
// The x86_64 Linux files are the ones with no architecture in the name. That
// asymmetry is deliberate and permanent — see the RELEASE_ASSETS note in
// clients/electron/build.sh. The dmgs name theirs either way.
export const APP_DOWNLOADS = [
    { id: 'windows', os: 'windows', arch: 'x64', label: 'Windows', note: 'Installer (.exe), x86_64', url: `${RELEASE}/UberSDR.Setup.exe`, icon: `${ICONS}/windows.png` },
    { id: 'macos', os: 'macos', arch: 'arm64', label: 'macOS (Apple Silicon)', note: 'Apple Silicon (.dmg) — M1 and later', url: `${RELEASE}/UberSDR-arm64.dmg`, icon: `${ICONS}/mac.png` },
    { id: 'macos-intel', os: 'macos', arch: 'x64', label: 'macOS (Intel)', note: 'Intel (.dmg) — the pre-Apple-Silicon Macs', url: `${RELEASE}/UberSDR-x64.dmg`, icon: `${ICONS}/mac.png` },
    { id: 'linux-appimage', os: 'linux', arch: 'x64', label: 'Linux (AppImage, x86_64)', note: 'AppImage — any distribution, no install needed. x86_64', url: `${RELEASE}/UberSDR.AppImage`, icon: `${ICONS}/linux.png` },
    { id: 'linux-deb', os: 'linux', arch: 'x64', label: 'Linux (.deb, x86_64)', note: '.deb — Debian and Ubuntu: adds a menu entry and opens ubersdr:// links. x86_64', url: `${RELEASE}/UberSDR.deb`, icon: `${ICONS}/linux.png` },
    { id: 'linux-appimage-arm64', os: 'linux', arch: 'arm64', label: 'Linux (AppImage, ARM64)', note: 'AppImage — any distribution, no install needed. ARM64 (aarch64): Raspberry Pi 5, Asahi, ARM servers', url: `${RELEASE}/UberSDR-arm64.AppImage`, icon: `${ICONS}/linux.png` },
    { id: 'linux-deb-arm64', os: 'linux', arch: 'arm64', label: 'Linux (.deb, ARM64)', note: '.deb — Debian and Ubuntu: adds a menu entry and opens ubersdr:// links. ARM64 (aarch64): Raspberry Pi 5, Asahi, ARM servers', url: `${RELEASE}/UberSDR-arm64.deb`, icon: `${ICONS}/linux.png` },
];

/**
 * The downloads for an os key from `detectDesktopOS` — an array, because Linux
 * has four and macOS two, and none of them is the obvious default. Empty for a
 * platform this does not recognise, which callers show the whole list for rather
 * than guessing.
 */
export function appDownloads(os) {
    return os ? APP_DOWNLOADS.filter((d) => d.os === os) : [];
}

/**
 * Which desktop this is, for choosing a download — or null when the honest
 * answer is "not a desktop, or not one of the three".
 *
 * Null is a real answer and callers offer all three rather than guessing: a
 * wrong guess here hands somebody an installer that does not run on their
 * machine, which is worse than a short list.
 *
 * The awkward cases are all things that claim to be something else:
 *
 *   * Android says `Linux` — every Android UA does, and it must not be offered
 *     an AppImage. Phones and tablets are ruled out first for that reason.
 *   * iPadOS says `Macintosh`, deliberately, and has done since iOS 13. A Mac
 *     with a touchscreen does not exist, so `maxTouchPoints` is what separates
 *     them.
 *   * ChromeOS says `CrOS` and is left as null: it can run an AppImage only
 *     inside the Linux container, which is not what a Download button means.
 *
 * `nav` is a parameter so this can be tested against the strings real browsers
 * send, which is the only way to know it is right.
 */
/**
 * Whether this device has a mobile UberSDR app to hand the link to.
 *
 * The question the "Open in App" button actually needs answered, and not the
 * same question as "is the screen small". StartOverlay asked the second one — a
 * width media query — which is right for a phone and wrong for every tablet:
 * an iPad or a 10-inch Android tablet has the app and a wide screen, so it was
 * shown the *desktop* dialog, offering an AppImage and a .deb to a device that
 * cannot run either. On an iPad it was worse still, because `detectDesktopOS`
 * correctly returns null there and the dialog then lists every platform it
 * knows rather than guessing.
 *
 * A platform test, therefore, and the same awkward cases as below: Android
 * says `Linux`, and iPadOS says `Macintosh` and has since iOS 13, which is what
 * `maxTouchPoints` is for — a Mac with a touchscreen does not exist.
 *
 * `nav` is a parameter for the same reason it is one below: so this can be
 * tested against the strings real devices send.
 */
export function hasMobileApp(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (!n) return false;

    const hints = n.userAgentData || null;
    const ua = String(n.userAgent || '');
    const text = `${(hints && hints.platform) || n.platform || ''} ${ua}`;

    if (/Android|iPhone|iPod|iPad/i.test(text)) return true;
    // iPadOS pretending to be a Mac.
    if (/Mac/i.test(text) && Number(n.maxTouchPoints) > 1) return true;
    return false;
}

export function detectDesktopOS(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (!n) return null;

    // Client hints where they exist (Chromium): a stated platform rather than a
    // string to be read as tea leaves. Everything else falls back to the UA.
    const hints = n.userAgentData || null;
    const ua = String(n.userAgent || '');
    const text = `${(hints && hints.platform) || n.platform || ''} ${ua}`;

    if (hints && hints.mobile) return null;
    if (/Android|iPhone|iPod|iPad/i.test(text)) return null;
    // iPadOS pretending to be a Mac.
    if (/Mac/i.test(text) && Number(n.maxTouchPoints) > 1) return null;
    if (/CrOS/i.test(text)) return null;

    if (/Win/i.test(text)) return 'windows';
    if (/Mac|Darwin/i.test(text)) return 'macos';
    if (/Linux|X11|BSD/i.test(text)) return 'linux';
    return null;
}

// Why there is no detectDesktopArch to go with detectDesktopOS, and why the
// architecture is in every Linux label instead:
//
// A browser will not tell you. Both Chromium and Firefox freeze the platform
// token in the user-agent string they send from Linux, so `X11; Linux x86_64`
// arrives from an aarch64 machine as readily as from an x86 one — and
// `navigator.platform` is frozen with it. Read as an architecture it is not
// merely unreliable, it is wrong in exactly the direction that matters: it would
// hand a Raspberry Pi the x86_64 AppImage and hide the one that runs.
//
// Client hints do state it, correctly, and cannot be used from here: the
// architecture is high-entropy, which makes `getHighEntropyValues` async, and
// these links are chosen during a render.
//
// macOS is worse still: every browser on Apple Silicon reports `Intel Mac OS X`,
// deliberately and for ever, so the one string that looks like an answer is the
// wrong one.
//
// So every build is offered and each says which it is, in the label rather than
// only in the note, because the label is what a button shows.
