// Whether a newer client has been published, and where this machine gets it.
//
// Both halves fail silently when they are wrong, which is why they are pinned
// here. A version compare that gets 0.10.0 backwards leaves everybody on an old
// build with no alert; an asset table that answers for an architecture it was
// not built for hands somebody a binary that will not start, which looks like
// the download being broken rather than the wrong file.

const assert = require('assert');
const { downloadUrl, isNewer, RELEASES_URL } = require('../updates.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a later version is newer', () => {
    assert.strictEqual(isNewer('0.2.0', '0.1.0'), true);
});

// The one a string comparison gets wrong, and the next version this project
// reaches: '0.10.0' < '0.9.0' as text.
t('the compare is numeric, not lexical', () => {
    assert.strictEqual(isNewer('0.10.0', '0.9.0'), true);
    assert.strictEqual(isNewer('0.9.0', '0.10.0'), false);
});

t('the same version is not an update', () => {
    assert.strictEqual(isNewer('0.1.0', '0.1.0'), false);
});

// A client running ahead of the published build — a local build, or a release
// that was pulled. It should sit quiet rather than offer a downgrade.
t('an older published version is not an update', () => {
    assert.strictEqual(isNewer('0.1.0', '0.2.0'), false);
});

t('a v prefix is tolerated on either side', () => {
    assert.strictEqual(isNewer('v0.2.0', '0.1.0'), true);
    assert.strictEqual(isNewer('0.2.0', 'v0.1.0'), true);
});

t('missing parts count as zero', () => {
    assert.strictEqual(isNewer('0.2', '0.1.9'), true);
    assert.strictEqual(isNewer('0.1.0', '0.1'), false);
});

// A file that has been hand-edited into nonsense, or an HTML error page parsed
// as JSON. Silence is the right answer: an alert nobody can act on would show
// on every launch for ever.
t('anything unparseable is not an update', () => {
    for (const bad of ['banana', '', null, undefined, {}, 'v', '..']) {
        assert.strictEqual(isNewer(bad, '0.1.0'), false, `remote ${JSON.stringify(bad)}`);
        assert.strictEqual(isNewer('0.2.0', bad), false, `local ${JSON.stringify(bad)}`);
    }
});

t('each platform gets the asset built for it', () => {
    assert.ok(downloadUrl('win32', 'x64').endsWith('/UberSDR.Setup.exe'));
    assert.ok(downloadUrl('linux', 'x64').endsWith('/UberSDR.AppImage'));
    assert.ok(downloadUrl('darwin', 'arm64').endsWith('/UberSDR-arm64.dmg'));
});

// Linux has two builds, and which one a machine should be offered is a fact
// about the running app, not about the distribution — see updates.js. Getting
// this backwards hands somebody a file they cannot install, or replaces a
// packaged install with a loose AppImage that no longer updates with it.
t('a .deb install is offered the .deb', () => {
    const proc = { env: {}, execPath: '/opt/UberSDR/ubersdr-desktop' };
    assert.ok(downloadUrl('linux', 'x64', proc).endsWith('/UberSDR.deb'));
});

t('an AppImage is offered the AppImage, wherever it was run from', () => {
    // $APPIMAGE wins outright: the runtime sets it, nothing else does, and an
    // AppImage copied into /opt by hand is still an AppImage.
    for (const execPath of ['/home/op/Downloads/UberSDR.AppImage', '/opt/UberSDR/ubersdr-desktop']) {
        const proc = { env: { APPIMAGE: '/home/op/Downloads/UberSDR.AppImage' }, execPath };
        assert.ok(downloadUrl('linux', 'x64', proc).endsWith('/UberSDR.AppImage'), execPath);
    }
});

t('anything else on Linux is offered the AppImage', () => {
    // A working tree, an unpacked dir, a tarball somebody arranged themselves,
    // or a distribution with no dpkg at all. The AppImage is the build that
    // needs no package manager to agree to it.
    for (const execPath of ['', '/usr/lib/node_modules/electron/dist/electron', '/home/op/src/ka9q_ubersdr/clients/electron/node_modules/electron/dist/electron']) {
        const proc = { env: {}, execPath };
        assert.ok(downloadUrl('linux', 'x64', proc).endsWith('/UberSDR.AppImage'), execPath);
    }
    // A proc object with nothing on it at all must not throw.
    assert.ok(downloadUrl('linux', 'x64', {}).endsWith('/UberSDR.AppImage'));
});

t('the two other platforms ignore all of that', () => {
    // Only Linux ships twice. A Windows exe under /opt is not a thing, but the
    // check must not be reachable from another platform's branch either way.
    const proc = { env: { APPIMAGE: '/x' }, execPath: '/opt/UberSDR/ubersdr-desktop' };
    assert.ok(downloadUrl('win32', 'x64', proc).endsWith('/UberSDR.Setup.exe'));
    assert.ok(downloadUrl('darwin', 'arm64', proc).endsWith('/UberSDR-arm64.dmg'));
});

// build.sh packages the AppImage and the installer --x64, and the dmg is built
// on an Apple Silicon Mac. Nothing is published for the other architectures, so
// they are sent to the page rather than handed a file that cannot run.
t('an architecture with no build goes to the releases page', () => {
    assert.strictEqual(downloadUrl('linux', 'arm64'), RELEASES_URL);
    assert.strictEqual(downloadUrl('darwin', 'x64'), RELEASES_URL);
    assert.strictEqual(downloadUrl('win32', 'arm64'), RELEASES_URL);
});

t('an unknown platform goes to the releases page', () => {
    assert.strictEqual(downloadUrl('freebsd', 'x64'), RELEASES_URL);
});

// Every asset hangs off the rolling `latest` tag, which is what lets the URLs
// be constants: publishing moves the tag and the same link fetches the new
// build.
t('the assets come from the rolling latest tag', () => {
    assert.ok(downloadUrl('linux', 'x64').includes('/releases/download/latest/'));
});

console.log(`\n${pass} passed`);
