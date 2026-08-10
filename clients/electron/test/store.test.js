// Saved instances, and the one thing in them that is a secret.
//
// The entry is what pins a receiver's local proxy port, and the port is the
// origin the v2 UI keeps its settings under — so an entry losing its identity is
// a receiver silently losing its settings. The password is newer and sharper:
// it is written to a file on disk, and the rules about which form it takes there
// are the difference between "encrypted where the platform can" and "encrypted
// unless something quietly failed".

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InstanceStore } = require('../store.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const dirs = [];
function tmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubersdr-store-'));
    dirs.push(dir);
    return dir;
}

// A stand-in for Electron's safeStorage. The real one is the OS keychain; what
// matters here is only that the store asks it and stores what it hands back.
const SEAL = 'sealed:';
const keychain = (available = true) => ({
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(SEAL + text, 'utf8'),
    // A marker, so a value that was never through "encryption" cannot pass for
    // one that was — which is what the read-without-the-key case turns on.
    decryptString: (buf) => {
        const s = buf.toString('utf8');
        if (!s.startsWith(SEAL)) throw new Error('not ours');
        return s.slice(SEAL.length);
    },
});

const RX = { host: 'rx.example', port: 8080, tls: true };

// --- entries -------------------------------------------------------------------

t('an entry is found again by address, not by label', () => {
    // The label is the operator's to change; the address is what makes two
    // sightings of a receiver the same receiver.
    const store = new InstanceStore(tmp());
    const first = store.ensure({ ...RX, name: 'Shack' });
    const again = store.ensure({ ...RX, name: 'Renamed in the directory' });
    assert.strictEqual(again.id, first.id);
    assert.strictEqual(store.list().length, 1);
});

t('a new entry gets its own stable local port', () => {
    const store = new InstanceStore(tmp());
    const a = store.ensure(RX);
    const b = store.ensure({ host: 'other.example', port: 80, tls: false });
    assert.notStrictEqual(a.localPort, b.localPort);
    assert.strictEqual(store.ensure(RX).localPort, a.localPort, 'and keeps it');
});

// --- the password ----------------------------------------------------------------

t('with no keychain a password is stored, plainly and legibly', () => {
    // A headless Linux box with no libsecret is a machine where refusing to
    // store it would mean the feature simply does not work. The file is in the
    // user's own userData directory, which they must already be able to read.
    const store = new InstanceStore(tmp());
    const entry = store.ensure(RX);
    store.setPassword(entry.id, 'hunter2');
    assert.strictEqual(store.get(entry.id).password, 'plain:hunter2');
    assert.strictEqual(store.passwordFor(entry.id), 'hunter2');
});

t('with a keychain it is sealed, and the plaintext is nowhere in the file', () => {
    const dir = tmp();
    const store = new InstanceStore(dir, keychain());
    const entry = store.ensure(RX);
    store.setPassword(entry.id, 'hunter2');
    assert.ok(store.get(entry.id).password.startsWith('enc:'));
    assert.strictEqual(store.passwordFor(entry.id), 'hunter2');
    const onDisk = fs.readFileSync(path.join(dir, 'instances.json'), 'utf8');
    assert.ok(!onDisk.includes('hunter2'), onDisk);
});

t('a keychain that is not answering today falls back rather than losing it', () => {
    const store = new InstanceStore(tmp(), keychain(false));
    const entry = store.ensure(RX);
    store.setPassword(entry.id, 'hunter2');
    assert.strictEqual(store.passwordFor(entry.id), 'hunter2');
});

t('a sealed password read without the key is no password, not garbage', () => {
    // The same file opened on another machine, or after the keyring was reset.
    // It has to read as "none set" so the operator is asked for one again.
    const dir = tmp();
    const sealed = new InstanceStore(dir, keychain());
    const entry = sealed.ensure(RX);
    sealed.setPassword(entry.id, 'hunter2');

    const reopened = new InstanceStore(dir);
    assert.strictEqual(reopened.passwordFor(entry.id), '');
});

t('clearing takes the field out of the file altogether', () => {
    const dir = tmp();
    const store = new InstanceStore(dir);
    const entry = store.ensure(RX);
    store.setPassword(entry.id, 'hunter2');
    store.setPassword(entry.id, '');
    assert.ok(!('password' in store.get(entry.id)));
    assert.strictEqual(store.passwordFor(entry.id), '');
    assert.ok(!fs.readFileSync(path.join(dir, 'instances.json'), 'utf8').includes('hunter2'));
});

t('a password typed before the receiver was saved is saved with it', () => {
    // The LAN scan, the directory, and the address box: none of them have an
    // entry to attach a password to until the connect that creates one.
    const store = new InstanceStore(tmp());
    const entry = store.ensure({ ...RX, password: 'hunter2' });
    assert.strictEqual(store.passwordFor(entry.id), 'hunter2');
    // ...and a later sighting with no password does not wipe it.
    store.ensure(RX);
    assert.strictEqual(store.passwordFor(entry.id), 'hunter2');
});

t('update() cannot write a password by field name', () => {
    // Only setPassword seals. A patch that could set `password` directly would
    // drop an unsealed secret into the file under a keychain that was available.
    const store = new InstanceStore(tmp(), keychain());
    const entry = store.ensure(RX);
    store.update(entry.id, { password: 'hunter2', label: 'Shack' });
    assert.ok(!('password' in store.get(entry.id)));
    assert.strictEqual(store.get(entry.id).label, 'Shack', 'the rest of the patch still applies');
});

t('the chooser is told whether there is a password, never what it is', () => {
    const store = new InstanceStore(tmp());
    const entry = store.ensure(RX);
    store.setPassword(entry.id, 'hunter2');
    const [row] = store.listForUI();
    assert.strictEqual(row.hasPassword, true);
    assert.ok(!('password' in row));
    assert.ok(!JSON.stringify(store.listForUI()).includes('hunter2'));
    assert.strictEqual(row.id, entry.id, 'and is still the same entry');
});

t('a password survives the store being reopened', () => {
    const dir = tmp();
    const first = new InstanceStore(dir, keychain());
    const entry = first.ensure(RX);
    first.setPassword(entry.id, 'hunter2');
    assert.strictEqual(new InstanceStore(dir, keychain()).passwordFor(entry.id), 'hunter2');
});

t('a password for a receiver that is not there is not an error', () => {
    const store = new InstanceStore(tmp());
    assert.strictEqual(store.setPassword('no-such-id', 'hunter2'), null);
    assert.strictEqual(store.passwordFor('no-such-id'), '');
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed`);
