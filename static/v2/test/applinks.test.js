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
const { ubersdrAppUri, vibesdrUri } = require('./.build/applinks.cjs');

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

console.log(`\n${pass} passed`);
