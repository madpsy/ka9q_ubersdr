// Handing this receiver to an app.
//
// The link is the whole feature: an app that receives `ubersdr://connect?uuid=…`
// looks that UUID up in the directory and connects, so a link that is subtly
// wrong does not fail — the operating system finds nobody who claims it and the
// click does nothing at all. Nothing on either side reports that, which is why
// the string is pinned here.
//
// The other half is the absent case. An instance that is not registered with
// the directory has no public UUID, and a button offering to open it in an app
// would be a button that cannot work: null is what keeps it off the overlay.

const assert = require('assert');
const {
    APP_DOWNLOADS, appDownloads, detectDesktopOS, ubersdrAppUri, vibesdrUri,
} = require('./.build/applinks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const UUID = '4907ba0a-32e6-40bb-a4ca-47f823331728';

t('the UberSDR app link is what the clients parse', () => {
    assert.strictEqual(ubersdrAppUri(UUID), `ubersdr://connect?uuid=${UUID}`);
});

// v1 builds this one (app.js _buildVibeSDRUri) and both frontends have to
// produce the same string for the same instance.
t('the VibeSDR link is v1\'s, character for character', () => {
    assert.strictEqual(vibesdrUri(UUID), `vibesdr://connect?uuid=${UUID}`);
});

t('an unregistered instance has no link rather than a broken one', () => {
    for (const empty of ['', null, undefined, '   ']) {
        assert.strictEqual(ubersdrAppUri(empty), null, JSON.stringify(empty));
        assert.strictEqual(vibesdrUri(empty), null, JSON.stringify(empty));
    }
});

t('a UUID with space around it still names the receiver', () => {
    assert.strictEqual(ubersdrAppUri(` ${UUID}\n`), `ubersdr://connect?uuid=${UUID}`);
});

// The value comes from the server, and the result is a URL whichever way the
// server is configured. The apps refuse anything that is not a canonical UUID
// (clients/electron/deeplink.js), so this only has to not build a second query
// parameter or a path out of it.
t('a UUID that is not one cannot smuggle in a second parameter', () => {
    const uri = ubersdrAppUri('x&foo=bar');
    assert.strictEqual(uri, 'ubersdr://connect?uuid=x%26foo%3Dbar');
    assert.strictEqual(new URL(uri).searchParams.get('uuid'), 'x&foo=bar');
    assert.strictEqual(new URL(uri).searchParams.get('foo'), null);
});

t('the links are parseable as URLs, which is how the apps read them', () => {
    const parsed = new URL(ubersdrAppUri(UUID));
    assert.strictEqual(parsed.protocol, 'ubersdr:');
    assert.strictEqual(parsed.hostname, 'connect');
    assert.strictEqual(parsed.searchParams.get('uuid'), UUID);
});

// --- which download to offer -------------------------------------------------
//
// The dialog picks one installer from three, and picking wrongly hands somebody
// a file that will not run on their machine. So these are the strings real
// browsers send rather than shapes invented to match the code.

const nav = (userAgent, extra = {}) => ({ userAgent, platform: '', ...extra });

t('the three desktops are recognised from their user agents', () => {
    const cases = [
        ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
        ['macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'],
        ['linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
        ['linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'],
        ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'],
    ];
    for (const [want, ua] of cases) assert.strictEqual(detectDesktopOS(nav(ua)), want, ua);
});

// Client hints, where the browser states the platform instead of being read.
t('client hints are believed over the user agent', () => {
    const reduced = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    assert.strictEqual(detectDesktopOS(nav(reduced, { userAgentData: { platform: 'macOS', mobile: false } })), 'macos');
    assert.strictEqual(detectDesktopOS(nav('', { userAgentData: { platform: 'Windows', mobile: false } })), 'windows');
});

// The one that would actually happen: every Android UA says "Linux", and an
// AppImage is no use to a phone.
t('Android is not Linux', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    assert.strictEqual(detectDesktopOS(nav(ua)), null);
    assert.strictEqual(detectDesktopOS(nav('Mozilla/5.0 (Linux; Android 14)', { userAgentData: { platform: 'Android', mobile: true } })), null);
});

// iPadOS has claimed to be a Mac since iOS 13; a Mac has no touchscreen.
t('an iPad calling itself a Mac is not offered a dmg', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    assert.strictEqual(detectDesktopOS(nav(ua, { maxTouchPoints: 5 })), null);
    assert.strictEqual(detectDesktopOS(nav(ua, { maxTouchPoints: 0 })), 'macos');
    assert.strictEqual(detectDesktopOS(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)')), null);
});

t('anything else is null rather than a guess', () => {
    assert.strictEqual(detectDesktopOS(nav('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')), null);
    assert.strictEqual(detectDesktopOS(nav('')), null);
    assert.strictEqual(detectDesktopOS({}), null);
    assert.strictEqual(detectDesktopOS(null), null);
});

t('every recognised platform has a download, and null has none', () => {
    for (const os of ['windows', 'macos', 'linux']) {
        const found = appDownloads(os);
        assert.ok(found.length, os);
        for (const d of found) {
            assert.ok(d.url, d.id);
            assert.ok(d.label && d.note, d.id);
        }
    }
    assert.deepStrictEqual(appDownloads(null), []);
    assert.deepStrictEqual(appDownloads('haiku'), []);
});

// Linux ships two builds that are not interchangeable — the AppImage runs
// anywhere and installs nothing, the .deb is what makes ubersdr:// links and
// the menu entry exist. Offering only the first match would quietly hide the
// one somebody following an "Open in App" button actually needs.
t('Linux offers both builds, and says which is which', () => {
    const linux = appDownloads('linux');
    assert.strictEqual(linux.length, 2);
    assert.deepStrictEqual(linux.map((d) => d.id), ['linux-appimage', 'linux-deb']);
    assert.ok(linux[0].label.includes('AppImage'), linux[0].label);
    assert.ok(linux[1].label.includes('.deb'), linux[1].label);
    // The other two are still single, or the dialog's one-button case is dead.
    assert.strictEqual(appDownloads('windows').length, 1);
    assert.strictEqual(appDownloads('macos').length, 1);
});

// `os` stopped being unique the moment Linux gained a second row, and it was
// the React key in the dialog's list. A duplicate key there silently renders
// one button.
t('every download has an id of its own', () => {
    const ids = APP_DOWNLOADS.map((d) => d.id);
    assert.strictEqual(new Set(ids).size, ids.length, ids.join(', '));
    for (const d of APP_DOWNLOADS) assert.ok(d.id, JSON.stringify(d));
});

// The file names are fixed on purpose so the links survive a version bump —
// see the artifactName note in clients/electron/package.json.
// The icons are served by the instance rather than bundled, so a file renamed
// or never committed is a broken image in the dialog and nothing anywhere else.
t('every platform icon is a file this server actually has', () => {
    const fs = require('fs');
    const path = require('path');
    for (const d of APP_DOWNLOADS) {
        assert.ok(d.icon && d.icon.startsWith('/images/'), `${d.id}: ${d.icon}`);
        const file = path.join(__dirname, '..', '..', d.icon.replace(/^\//, ''));
        assert.ok(fs.existsSync(file), `${d.id}: ${file} is missing`);
    }
});

t('the downloads are the release assets the site links to', () => {
    const RELEASE = 'https://github.com/madpsy/ka9q_ubersdr/releases/download/latest';
    assert.deepStrictEqual(APP_DOWNLOADS.map((d) => d.url), [
        `${RELEASE}/UberSDR.Setup.exe`,
        `${RELEASE}/UberSDR-arm64.dmg`,
        `${RELEASE}/UberSDR.AppImage`,
        `${RELEASE}/UberSDR.deb`,
    ]);
    for (const d of APP_DOWNLOADS) assert.ok(!/\$\{|\bundefined\b/.test(d.url), d.url);
});

console.log(`\n${pass} passed`);
