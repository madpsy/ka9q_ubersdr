// ubersdr:// links.
//
// Two things here are worth pinning and neither is obvious from the code. The
// first is what a link is *not* allowed to say: everything after `?uuid=` goes
// into a URL that this app then fetches, so "only a canonical UUID" is a rule
// rather than a formality. The second is the ladder — saved entry first, then
// the directory — because the case it exists for is a receiver whose address
// has changed, and getting the order wrong turns that from "it heals" into "the
// link is dead", which nothing else would notice.
//
// The resolution is tested with the store, the lookup and the connect passed in
// (that is why open() takes them), so none of this needs an Electron app, a
// network, or the directory being up.

const assert = require('assert');
const { parse, fromArgv, open } = require('../deeplink.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const UUID = '4907ba0a-32e6-40bb-a4ca-47f823331728';

// ---- what a link says -------------------------------------------------------

t('the ordinary form', () => {
    assert.deepStrictEqual(parse(`ubersdr://connect?uuid=${UUID}`), { action: 'connect', uuid: UUID });
});

// `ubersdr:connect?…` is as valid as `ubersdr://connect?…` and puts the action
// in the path instead of the authority. Whoever wrote the link cannot see the
// difference, so neither should this.
t('the form without slashes', () => {
    assert.strictEqual(parse(`ubersdr:connect?uuid=${UUID}`).uuid, UUID);
});

t('case and a trailing slash do not matter', () => {
    assert.strictEqual(parse(`ubersdr://Connect/?uuid=${UUID}`).action, 'connect');
    assert.strictEqual(parse(`ubersdr://connect?uuid=${UUID.toUpperCase()}`).uuid, UUID.toUpperCase());
});

t('parameters nobody asked about are ignored', () => {
    assert.strictEqual(parse(`ubersdr://connect?uuid=${UUID}&freq=14200000`).uuid, UUID);
});

// The reason the regex is there. Every one of these would otherwise be
// interpolated into the directory URL this app fetches.
t('anything that is not a UUID is refused', () => {
    const bad = [
        `ubersdr://connect?uuid=${UUID}/../../admin`,
        'ubersdr://connect?uuid=../../etc/passwd',
        'ubersdr://connect?uuid=4907ba0a',
        'ubersdr://connect?uuid=%20',
        'ubersdr://connect?uuid=',
        'ubersdr://connect',
    ];
    for (const url of bad) assert.throws(() => parse(url), undefined, url);
});

t('another app\'s links are refused', () => {
    for (const url of [`vibesdr://connect?uuid=${UUID}`, `https://example.org/connect?uuid=${UUID}`,
        `connect?uuid=${UUID}`, 'ubersdr://', '', null]) {
        assert.throws(() => parse(url), undefined, String(url));
    }
});

t('an action this version does not have says so', () => {
    assert.throws(() => parse(`ubersdr://tune?uuid=${UUID}`), /unknown link action "tune"/);
});

// ---- how a link arrives on Windows and Linux --------------------------------

t('the URL is found among the arguments, not assumed to be last', () => {
    const argv = ['/opt/UberSDR/ubersdr', `ubersdr://connect?uuid=${UUID}`, '--allow-file-access-from-files'];
    assert.strictEqual(fromArgv(argv), `ubersdr://connect?uuid=${UUID}`);
});

t('a working tree run has the app path in there too', () => {
    const argv = ['/usr/bin/electron', '.', `ubersdr://connect?uuid=${UUID}`];
    assert.strictEqual(fromArgv(argv), `ubersdr://connect?uuid=${UUID}`);
});

t('the last URL wins, and no URL is null', () => {
    assert.strictEqual(fromArgv(['x', 'ubersdr://connect?uuid=a', 'ubersdr://connect?uuid=b']), 'ubersdr://connect?uuid=b');
    assert.strictEqual(fromArgv(['/opt/UberSDR/ubersdr', '--no-sandbox']), null);
    assert.strictEqual(fromArgv([]), null);
    assert.strictEqual(fromArgv(undefined), null);
});

// ---- the ladder -------------------------------------------------------------

const saved = { id: 'saved-id', uuid: UUID, label: 'M9PSY', host: 'old.example.org', port: 443, tls: true };
const fresh = { uuid: UUID, name: 'M9PSY', host: 'new.example.org', port: 443, tls: true };

// The store is a Map with the two methods open() uses; connect and lookupUuid
// record what they were asked and answer as told.
const deps = ({ entries = [], row = null, connectFails = new Set() } = {}) => {
    const calls = { connect: [], lookups: 0 };
    return {
        calls,
        store: { findByUuid: (uuid) => entries.find((e) => e.uuid === uuid) || null },
        lookupUuid: async () => { calls.lookups++; return row; },
        connect: async (desc) => {
            calls.connect.push(desc);
            if (connectFails.has(desc.id)) throw new Error('probe failed');
            return desc.id || 'new-id';
        },
    };
};

ta('a receiver already saved opens without asking the directory', async () => {
    const d = deps({ entries: [saved] });
    assert.strictEqual(await open(UUID, d), 'saved-id');
    assert.deepStrictEqual(d.calls.connect, [{ id: 'saved-id' }]);
    assert.strictEqual(d.calls.lookups, 0, 'the directory should not have been asked');
});

ta('one that is not saved is looked up and opened', async () => {
    const d = deps({ row: fresh });
    assert.strictEqual(await open(UUID, d), 'new-id');
    assert.strictEqual(d.calls.lookups, 1);
    assert.strictEqual(d.calls.connect[0].host, 'new.example.org');
});

// The case the whole scheme exists for: the link is still right, the saved
// address is not.
ta('a saved receiver that has moved heals through the directory', async () => {
    const d = deps({ entries: [saved], row: fresh, connectFails: new Set(['saved-id']) });
    assert.strictEqual(await open(UUID, d), 'new-id');
    assert.deepStrictEqual(d.calls.connect.map((c) => c.id || c.host), ['saved-id', 'new.example.org']);
});

ta('a UUID nobody has is reported as that', async () => {
    const d = deps({ row: null });
    await assert.rejects(() => open(UUID, d), /the directory has no receiver with that UUID/);
});

// Both halves failed, so the useful sentence is the one about the receiver the
// operator has actually used, not a second "not in the directory".
ta('a saved receiver that is simply down says so by name', async () => {
    const d = deps({ entries: [saved], row: null, connectFails: new Set(['saved-id']) });
    await assert.rejects(() => open(UUID, d), /M9PSY did not answer, and the directory does not list it/);
});

// A directory that cannot be reached is not "no such receiver".
ta('a lookup that throws is not turned into "no such receiver"', async () => {
    const d = deps({ entries: [saved], connectFails: new Set(['saved-id']) });
    d.lookupUuid = async () => { throw new Error('getaddrinfo ENOTFOUND instances.ubersdr.org'); };
    await assert.rejects(() => open(UUID, d), /ENOTFOUND/);
});

// Printed on the way out, so the async cases above are counted whichever order
// they settle in — the same shape as chooser.test.js.
process.on('exit', () => console.log(`\n${pass} passed`));
