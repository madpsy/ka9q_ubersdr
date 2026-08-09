// Operator photos: the setting, the cache, and the rule about who gets a blob.
//
// The rule is the reason this module exists in one piece. A blob: URL is
// revoked when the cache is trimmed, so anything holding one in an <img> turns
// into a broken icon at a moment decided by an unrelated consumer — which is
// why what renders gets a path and only the lock screen gets a blob.

const assert = require('assert');
const {
    _resetPhotos, onPhotoShown, photoBlobUrl, photoShown, photoUrl, setPhotoShown, trimPhotos,
} = require('./.build/operatorphoto.cjs');

let pass = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);

const KEY = 'ubersdr.v2.callsignPhoto';

function install(initial = {}) {
    const map = new Map(Object.entries(initial));
    globalThis.localStorage = {
        refuse: false,
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem(k, v) { if (this.refuse) throw new Error('quota'); map.set(k, String(v)); },
        removeItem: (k) => map.delete(k),
    };
    return globalThis.localStorage;
}

// A URL factory that counts revocations, so the trim can be checked.
function installUrlApi() {
    let n = 0;
    const revoked = [];
    globalThis.URL.createObjectURL = () => `blob:fake/${++n}`;
    globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
    return { revoked };
}

function installFetch(impl) {
    let calls = 0;
    globalThis.fetch = (url) => { calls++; return impl(url); };
    return () => calls;
}

const okBody = () => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) });

// --- the setting -------------------------------------------------------------

t('photos are off until turned on', () => {
    // The largest thing a lookup fetches for the least it says, so it is asked
    // for rather than given. Only an explicit 'on' counts — an absent key is
    // somebody who has never touched the switch.
    install();
    assert.strictEqual(photoShown(), false);
    install({ [KEY]: 'on' });
    assert.strictEqual(photoShown(), true);
    install({ [KEY]: 'off' });
    assert.strictEqual(photoShown(), false);
});

t('a storage that will not answer falls back to the default', () => {
    // Private mode gets what a first visit gets, which is off — the setting
    // cannot be read *or* written there, so a feature that turned itself on
    // could never be turned off again.
    globalThis.localStorage = { getItem() { throw new Error('denied'); } };
    assert.strictEqual(photoShown(), false);
});

t('turning it off tells everyone watching', () => {
    // The panel and the lock-screen card are separate components; one of them
    // changing the setting has to reach the other.
    install();
    const seen = [];
    const off = onPhotoShown((v) => seen.push(v));
    setPhotoShown(false);
    setPhotoShown(true);
    off();
    setPhotoShown(false);
    assert.deepStrictEqual(seen, [false, true], 'kept notifying after unsubscribing');
});

t('a refused write does not throw', () => {
    const s = install();
    s.refuse = true;
    assert.doesNotThrow(() => setPhotoShown(false));
});

// --- what renders ------------------------------------------------------------

t('what renders gets a path, and nothing when photos are off', () => {
    install({ [KEY]: 'on' });
    assert.strictEqual(photoUrl('/api/lookup/image/abc'), '/api/lookup/image/abc');
    install({ [KEY]: 'off' });
    assert.strictEqual(photoUrl('/api/lookup/image/abc'), '');
    install({ [KEY]: 'on' });
    assert.strictEqual(photoUrl(''), '');
    assert.strictEqual(photoUrl(null), '');
});

// --- the blob cache ----------------------------------------------------------

t('two callers asking at once share one fetch', async () => {
    install({ [KEY]: 'on' });
    _resetPhotos();
    installUrlApi();
    const count = installFetch(() => new Promise((r) => setTimeout(() => r({
        ok: true, status: 200, blob: () => Promise.resolve({}),
    }), 5)));
    const [a, b] = await Promise.all([photoBlobUrl('/p/1'), photoBlobUrl('/p/1')]);
    assert.strictEqual(a, b);
    assert.strictEqual(count(), 1, 'fetched twice');
});

t('a photo already fetched is not fetched again', async () => {
    install({ [KEY]: 'on' });
    _resetPhotos();
    installUrlApi();
    const count = installFetch(okBody);
    const first = await photoBlobUrl('/p/1');
    const again = await photoBlobUrl('/p/1');
    assert.strictEqual(again, first);
    assert.strictEqual(count(), 1);
});

t('a fetch that fails falls back to the path, and is not retried', async () => {
    // Retrying on every tuning change would be a request per marker passed.
    install({ [KEY]: 'on' });
    _resetPhotos();
    installUrlApi();
    const count = installFetch(() => Promise.resolve({ ok: false, status: 404 }));
    assert.strictEqual(await photoBlobUrl('/p/gone'), '/p/gone');
    assert.strictEqual(await photoBlobUrl('/p/gone'), '/p/gone');
    assert.strictEqual(count(), 1);
});

t('photos switched off means no fetch at all', async () => {
    // The setting is checked here, so a caller cannot fetch one by forgetting.
    install({ [KEY]: 'off' });
    _resetPhotos();
    installUrlApi();
    const count = installFetch(okBody);
    assert.strictEqual(await photoBlobUrl('/p/1'), '');
    assert.strictEqual(count(), 0);
});

t('nothing to fetch is not a fetch', async () => {
    install({ [KEY]: 'on' });
    _resetPhotos();
    installFetch(okBody);
    assert.strictEqual(await photoBlobUrl(''), '');
    assert.strictEqual(await photoBlobUrl(null), '');
});

// --- trimming ----------------------------------------------------------------

t('the cache is bounded, and the one in use survives', async () => {
    install({ [KEY]: 'on' });
    _resetPhotos();
    const { revoked } = installUrlApi();
    installFetch(okBody);
    for (let i = 0; i < 20; i++) await photoBlobUrl(`/p/${i}`);
    trimPhotos('/p/19');
    assert.ok(revoked.length > 0, 'nothing was released');
    // The one being displayed is still a blob, not a re-fetch.
    const count = installFetch(() => { throw new Error('should not re-fetch'); });
    assert.ok((await photoBlobUrl('/p/19')).startsWith('blob:'));
    assert.strictEqual(count(), 0);
});

t('a failure marker is not revoked as though it were a blob', async () => {
    // It is a path, not an allocation — revoking it would be meaningless and
    // revokeObjectURL on a non-blob is a silent no-op that hides the mistake.
    install({ [KEY]: 'on' });
    _resetPhotos();
    const { revoked } = installUrlApi();
    installFetch(() => Promise.resolve({ ok: false, status: 500 }));
    for (let i = 0; i < 20; i++) await photoBlobUrl(`/p/${i}`);
    trimPhotos('/p/19');
    assert.deepStrictEqual(revoked, [], 'revoked a path');
});

(async () => {
    for (const [name, fn] of results) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} ok`);
})();
