// Radio-control transports registered from outside the page.
//
// Everything here arrives over the page API from an extension or a desktop
// shell, so the interesting cases are all the malformed ones: this decides what
// a receiver panel will render, and a field descriptor that is half-understood
// produces a form nobody can fill in correctly. Refusing is always better than
// repairing, because the client is right there to be told.

const assert = require('assert');
const {
    FIELD_TYPES, INPUT_FIELD_TYPES, choiceValue, getProvider, listProviders, normaliseConfigure,
    normaliseProvider, onProviders,
    providerStatus, registerProvider, resetProviders, setProviderStatus, unregisterProvider,
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

// --- choice fields ---------------------------------------------------------

const omnirig = () => ({
    id: 'omnirig',
    label: 'OmniRig',
    fields: [
        { key: 'rig', label: 'Rig', type: 'choice', default: 1,
            options: [{ value: 1, label: 'Rig 1' }, { value: 2, label: 'Rig 2' }] },
        { key: 'vfo', label: 'VFO', type: 'choice', default: 'current',
            options: [{ value: 'current', label: 'Current' }, { value: 'A' }, { value: 'B' }] },
    ],
});

t('a choice field keeps its options, with the value as the label by default', () => {
    const p = normaliseProvider(omnirig());
    assert.strictEqual(p.fields[0].type, 'choice');
    assert.deepStrictEqual(p.fields[0].options, [{ value: 1, label: 'Rig 1' }, { value: 2, label: 'Rig 2' }]);
    assert.deepStrictEqual(p.fields[1].options.map((o) => o.label), ['Current', 'A', 'B']);
    assert.strictEqual(p.fields[0].default, 1);
    assert.ok(FIELD_TYPES.includes('choice'));
    // Matched by text, answered as the option's own value: a '2' saved from a
    // text box is Rig 2, typed as the provider declared it, so its button lights.
    assert.strictEqual(choiceValue(p.fields[0], 1), 1);
    assert.strictEqual(choiceValue(p.fields[0], '2'), 2);
    assert.strictEqual(choiceValue(p.fields[0], ' 2 '), 2);
    assert.strictEqual(choiceValue(p.fields[0], 3), undefined);
    assert.strictEqual(choiceValue(p.fields[0], undefined), undefined);
    assert.strictEqual(choiceValue(p.fields[1], ''), undefined);
});

t('a choice default that is not an option becomes the first option', () => {
    const raw = omnirig();
    raw.fields[0].default = 3;
    assert.strictEqual(normaliseProvider(raw).fields[0].default, 1);
    delete raw.fields[0].default;
    assert.strictEqual(normaliseProvider(raw).fields[0].default, 1);
});

t('a choice with too few, too many or malformed options is refused', () => {
    const withOptions = (options) => ({ id: 'x', fields: [{ key: 'k', type: 'choice', options }] });
    assert.throws(() => normaliseProvider(withOptions(undefined)), /needs options/);
    assert.throws(() => normaliseProvider(withOptions([{ value: 1 }])), /2 to 6/);
    // A duplicate does not count twice.
    assert.throws(() => normaliseProvider(withOptions([{ value: 1 }, { value: 1 }])), /2 to 6/);
    assert.throws(() => normaliseProvider(withOptions(
        Array.from({ length: 7 }, (_, i) => ({ value: i })))), /2 to 6/);
    assert.throws(() => normaliseProvider(withOptions([{ value: 1 }, { value: {} }])), /without a value/);
    assert.throws(() => normaliseProvider(withOptions([{ value: 1 }, 'B'])), /without a value/);
});

t('option labels are bounded', () => {
    const p = normaliseProvider({ id: 'x', fields: [{ key: 'k', type: 'choice',
        options: [{ value: 'a', label: 'y'.repeat(50) }, { value: 'b' }] }] });
    assert.strictEqual(p.fields[0].options[0].label.length, 20);
});

t('configure takes a choice only as one of its options', () => {
    registerProvider(omnirig());
    assert.deepStrictEqual(normaliseConfigure('omnirig', { config: { rig: 2, vfo: 'B' } }).config,
        { rig: 2, vfo: 'B' });
    assert.throws(() => normaliseConfigure('omnirig', { config: { rig: 3, vfo: 'C' } }), /nothing to configure/);
    // Stored as the option's own value, whatever form it arrived in.
    assert.deepStrictEqual(normaliseConfigure('omnirig', { config: { rig: '2', vfo: 'A' } }).config,
        { rig: 2, vfo: 'A' });
    assert.deepStrictEqual(normaliseConfigure('omnirig', { config: { rig: 3, vfo: 'B' } }).config,
        { vfo: 'B' });
});

t('surfaces keep to the typed-in types', () => {
    assert.deepStrictEqual(INPUT_FIELD_TYPES, ['text', 'number', 'password']);
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
        rig: null, details: null,
    });
});

t('an error can be set and then cleared', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { error: 'ECONNREFUSED' });
    assert.strictEqual(providerStatus('flrig').error, 'ECONNREFUSED');
    setProviderStatus('flrig', { error: null });
    assert.strictEqual(providerStatus('flrig').error, null);
});

t('the rig name is kept, trimmed and cut to fit, and cleared by null', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { rig: '  IC-7300 ' });
    assert.strictEqual(providerStatus('flrig').rig, 'IC-7300');
    // A later poll without it keeps it.
    setProviderStatus('flrig', { frequency: 7074000 });
    assert.strictEqual(providerStatus('flrig').rig, 'IC-7300');
    setProviderStatus('flrig', { rig: 'x'.repeat(100) });
    assert.strictEqual(providerStatus('flrig').rig.length, 60);
    setProviderStatus('flrig', { rig: '' });
    assert.strictEqual(providerStatus('flrig').rig, null);
    setProviderStatus('flrig', { rig: 'IC-705' });
    setProviderStatus('flrig', { rig: null });
    assert.strictEqual(providerStatus('flrig').rig, null);
});

t('details are label/value text, in order, and what is not a pair is dropped', () => {
    registerProvider(flrig());
    setProviderStatus('flrig', { details: [
        { label: 'VFO', value: 'A' },
        { label: 'Split', value: false },
        null,
        'loose text',
        { value: 'no label' },
        { label: '   ', value: 'blank label' },
        { label: 'OmniRig', value: 1.2 },
        { label: 'Empty' },
    ] });
    assert.deepStrictEqual(providerStatus('flrig').details, [
        { label: 'VFO', value: 'A' },
        { label: 'Split', value: 'false' },
        { label: 'OmniRig', value: '1.2' },
        { label: 'Empty', value: '' },
    ]);
});

t('details are capped in number and length, and cleared by null or empty', () => {
    registerProvider(flrig());
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`.padEnd(50, 'x'), value: 'v'.repeat(200) }));
    setProviderStatus('flrig', { details: many });
    const d = providerStatus('flrig').details;
    assert.strictEqual(d.length, 12);
    assert.strictEqual(d[0].label.length, 30);
    assert.strictEqual(d[0].value.length, 80);
    setProviderStatus('flrig', { connected: true });
    assert.strictEqual(providerStatus('flrig').details.length, 12, 'kept across a status without them');
    setProviderStatus('flrig', { details: [] });
    assert.strictEqual(providerStatus('flrig').details, null);
    setProviderStatus('flrig', { details: [{ label: 'a', value: 'b' }] });
    setProviderStatus('flrig', { details: null });
    assert.strictEqual(providerStatus('flrig').details, null);
    setProviderStatus('flrig', { details: 'not a list' });
    assert.strictEqual(providerStatus('flrig').details, null);
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

// --- configure ---------------------------------------------------------------
//
// A transport writing back what its own settings are, so the panel and whatever
// else edits them (the extension's popup) agree whichever was touched.

t('a provider may write back its own fields', () => {
    registerProvider(flrig());
    assert.deepStrictEqual(
        normaliseConfigure('flrig', { config: { host: '10.0.0.9', port: 12399 } }),
        { config: { host: '10.0.0.9', port: 12399 } },
    );
});

t('fields it never declared are dropped', () => {
    // The panel can only render what it was told about, so storing the rest
    // would be storing something nobody can see or change.
    registerProvider(flrig());
    assert.deepStrictEqual(
        normaliseConfigure('flrig', { config: { host: 'x', secret: 'y' } }),
        { config: { host: 'x' } },
    );
});

t('the sync settings it shares are allowed, and nothing else', () => {
    registerProvider(flrig());
    const out = normaliseConfigure('flrig', {
        connect: true, direction: 'radio-to-sdr', muteOnTx: false,
        syncFrequency: true, syncMode: false,
        transport: 'somebody-else', rig: 'FT-991A',
    });
    assert.deepStrictEqual(out, {
        connect: true, direction: 'radio-to-sdr', muteOnTx: false,
        syncFrequency: true, syncMode: false,
    });
});

t('a nonsense direction is ignored rather than stored', () => {
    registerProvider(flrig());
    assert.throws(() => normaliseConfigure('flrig', { direction: 'sideways' }), /nothing to configure/);
});

t('choosing the transport is separate and explicit', () => {
    // Telling the panel an address is answering a question; switching it to
    // this transport is taking the choice off the operator.
    registerProvider(flrig());
    assert.strictEqual(normaliseConfigure('flrig', { connect: true }).select, undefined);
    assert.strictEqual(normaliseConfigure('flrig', { connect: true, select: true }).select, true);
    assert.strictEqual(normaliseConfigure('flrig', { connect: true, select: 'yes' }).select, undefined);
});

t('a provider nobody registered cannot configure anything', () => {
    assert.throws(() => normaliseConfigure('ghost', { connect: true }), /no provider/);
});

t('an empty configure is an error, not a silent no-op', () => {
    registerProvider(flrig());
    assert.throws(() => normaliseConfigure('flrig', {}), /nothing to configure/);
    assert.throws(() => normaliseConfigure('flrig', { config: {} }), /nothing to configure/);
});

console.log(`\n${pass} passed`);
