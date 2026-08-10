// Radio-control transports registered from outside the page.
//
// Everything here arrives over the page API from an extension or a desktop
// shell, so the interesting cases are all the malformed ones: this decides what
// a receiver panel will render, and a field descriptor that is half-understood
// produces a form nobody can fill in correctly. Refusing is always better than
// repairing, because the client is right there to be told.

const assert = require('assert');
const {
    FIELD_TYPES, getProvider, listProviders, normaliseProvider, onProviders, providerStatus,
    registerProvider, resetProviders, setProviderStatus, unregisterProvider,
} = require('./.build/radioproviders.cjs');

let pass = 0;
const t = (name, fn) => {
    resetProviders();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const flrig = () => ({
    id: 'flrig',
    label: 'FLRig',
    fields: [
        { key: 'host', label: 'Host', type: 'text', default: '127.0.0.1' },
        { key: 'port', label: 'Port', type: 'number', default: 12345 },
    ],
    capabilities: ['frequency', 'mode', 'ptt'],
});

// --- registering -------------------------------------------------------------

t('a provider registers and comes back with its fields', () => {
    registerProvider(flrig());
    const [p] = listProviders();
    assert.strictEqual(p.id, 'flrig');
    assert.strictEqual(p.label, 'FLRig');
    assert.deepStrictEqual(p.fields.map((f) => f.key), ['host', 'port']);
    assert.strictEqual(p.fields[1].type, 'number');
    assert.strictEqual(p.fields[1].default, 12345);
    // Never connected yet, so the panel can say so rather than assume.
    assert.deepStrictEqual(p.status, { connected: false });
});

t('registering the same id again replaces it', () => {
    registerProvider(flrig());
    registerProvider({ ...flrig(), label: 'flrig (2)' });
    assert.strictEqual(listProviders().length, 1);
    assert.strictEqual(listProviders()[0].label, 'flrig (2)');
});

t('unregistering removes it and its status', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { connected: true, frequency: 14074000 });
    assert.strictEqual(unregisterProvider('flrig'), true);
    assert.deepStrictEqual(listProviders(), []);
    assert.strictEqual(getProvider('flrig'), null);
    // A stale status must not survive to be shown against a re-registration.
    registerProvider(flrig());
    assert.deepStrictEqual(providerStatus('flrig'), { connected: false });
});

t('unregistering something that was never there is not an error', () => {
    assert.strictEqual(unregisterProvider('nope'), false);
});

// --- what is refused ---------------------------------------------------------

t('an id has to be a usable key', () => {
    for (const id of ['', '  ', 'has space', 'x'.repeat(33), 'né', null]) {
        assert.throws(() => normaliseProvider({ ...flrig(), id }), /provider id/, `accepted ${id}`);
    }
    // and these are fine
    for (const id of ['flrig', 'rigctld-2', 'a', 'A_b-9']) {
        assert.strictEqual(normaliseProvider({ ...flrig(), id }).id, id);
    }
});

t('a bad field key is refused rather than dropped', () => {
    // Dropping it would render a form missing the field the provider needs,
    // which then fails to connect for a reason nothing on screen explains.
    assert.throws(() => normaliseProvider({ ...flrig(), fields: [{ key: 'a b' }] }), /bad field key/);
    assert.throws(() => normaliseProvider({ ...flrig(), fields: [{ key: '' }] }), /bad field key/);
    assert.throws(() => normaliseProvider({ ...flrig(), fields: [{ key: '1st' }] }), /bad field key/);
});

t('anything that is not a provider at all is refused', () => {
    for (const bad of [null, undefined, 'flrig', 42, []]) {
        assert.throws(() => normaliseProvider(bad));
    }
});

t('an unknown field type falls back to text rather than rendering nothing', () => {
    const p = normaliseProvider({ ...flrig(), fields: [{ key: 'host', type: 'wormhole' }] });
    assert.strictEqual(p.fields[0].type, 'text');
    assert.ok(FIELD_TYPES.includes('text'));
});

t('labels and field counts are bounded', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}` }));
    const p = normaliseProvider({ ...flrig(), label: 'x'.repeat(200), fields: many });
    assert.strictEqual(p.label.length, 40);
    assert.strictEqual(p.fields.length, 8);
});

t('capabilities default to everything and are otherwise filtered', () => {
    assert.deepStrictEqual(normaliseProvider({ id: 'x' }).capabilities, ['frequency', 'mode', 'ptt']);
    assert.deepStrictEqual(
        normaliseProvider({ id: 'x', capabilities: ['frequency'] }).capabilities, ['frequency'],
    );
    // A provider that cannot report PTT must not be offered a mute-on-TX switch.
    assert.ok(!normaliseProvider({ id: 'x', capabilities: ['frequency', 'mode'] })
        .capabilities.includes('ptt'));
});

// --- status ------------------------------------------------------------------

t('status merges, so a poll reporting only a frequency keeps the rest', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { connected: true, mode: 'USB', tx: false });
    setProviderStatus('flrig', { frequency: 14074000 });
    assert.deepStrictEqual(providerStatus('flrig'), {
        connected: true, busy: false, frequency: 14074000, mode: 'USB', tx: false, error: null,
    });
});

t('an error can be set and then cleared', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { error: 'ECONNREFUSED' });
    assert.strictEqual(providerStatus('flrig').error, 'ECONNREFUSED');
    setProviderStatus('flrig', { error: null });
    assert.strictEqual(providerStatus('flrig').error, null);
});

t('status for a provider nobody registered is refused', () => {
    assert.throws(() => setProviderStatus('ghost', { connected: true }), /no provider/);
});

// --- notification ------------------------------------------------------------

t('listeners hear about every change, and can stop listening', () => {
    const seen = [];
    const off = onProviders((l) => seen.push(l.length));
    registerProvider(flrig());
    setProviderStatus('flrig', { connected: true });
    unregisterProvider('flrig');
    off();
    registerProvider(flrig());
    assert.deepStrictEqual(seen, [1, 1, 0], 'register, status, unregister — and nothing after off()');
});

t('a listener that throws does not stop the others', () => {
    const seen = [];
    onProviders(() => { throw new Error('boom'); });
    onProviders(() => seen.push('ok'));
    registerProvider(flrig());
    assert.deepStrictEqual(seen, ['ok']);
});

console.log(`\n${pass} passed`);
