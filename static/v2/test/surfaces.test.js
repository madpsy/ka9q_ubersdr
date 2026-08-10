// Control surfaces something outside the page provides.
//
// The mirror of the radio transports, and the same reasoning: this decides what
// a receiver panel renders from a descriptor that arrived from elsewhere, so
// the cases worth pinning are the malformed ones and the ones that would render
// a control nobody can use.

const assert = require('assert');
const {
    EVENT_AUDIO_PORT, getProvidedSurface, listSurfaces, normaliseSurface, onSurfaces,
    registerSurface, resetSurfaces, setSurfaceStatus, surfaceStatus, unregisterSurface,
} = require('./.build/surfaces.cjs');
// The built-in surfaces live with the settings they belong to, so the line
// between "this page opens it" and "something else provides it" is drawn once.
const { SURFACES, isMappedSurface } = require('./.build/mappings.cjs');

let pass = 0;
const t = (name, fn) => {
    resetSurfaces();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const tci = () => ({
    id: 'tci',
    label: 'TCI',
    description: 'Be a TCI radio for JTDX and friends.',
    audio: true,
    fields: [{ key: 'port', label: 'Port', type: 'number', default: 40001 }],
});

t('a surface registers and comes back with what the panel needs', () => {
    registerSurface(tci());
    const [s] = listSurfaces();
    assert.strictEqual(s.id, 'tci');
    assert.strictEqual(s.label, 'TCI');
    assert.strictEqual(s.audio, true, 'it asked for the receiver audio');
    assert.deepStrictEqual(s.fields.map((f) => f.key), ['port']);
    assert.deepStrictEqual(s.status, { running: false }, 'nothing claimed until it says so');
});

t('audio is opt-in, so nothing is streamed to a surface that never asked', () => {
    assert.strictEqual(normaliseSurface({ id: 'x' }).audio, false);
    assert.strictEqual(normaliseSurface({ id: 'x', audio: 'yes' }).audio, false);
    assert.strictEqual(normaliseSurface({ id: 'x', audio: true }).audio, true);
});

t('an id has to be a usable key, and a field key likewise', () => {
    for (const id of ['', 'has space', 'x'.repeat(33), null]) {
        assert.throws(() => normaliseSurface({ ...tci(), id }), /surface id/);
    }
    assert.throws(() => normaliseSurface({ ...tci(), fields: [{ key: '1st' }] }), /bad field key/);
});

t('anything that is not a surface at all is refused', () => {
    for (const bad of [null, undefined, 'tci', 42, []]) assert.throws(() => normaliseSurface(bad));
});

t('registering the same id again replaces it', () => {
    registerSurface(tci());
    registerSurface({ ...tci(), label: 'TCI (2)' });
    assert.strictEqual(listSurfaces().length, 1);
    assert.strictEqual(listSurfaces()[0].label, 'TCI (2)');
});

t('unregistering takes its status with it', () => {
    registerSurface(tci());
    setSurfaceStatus('tci', { running: true, clients: 2 });
    assert.strictEqual(unregisterSurface('tci'), true);
    assert.strictEqual(getProvidedSurface('tci'), null);
    registerSurface(tci());
    assert.deepStrictEqual(surfaceStatus('tci'), { running: false }, 'no stale client count');
});

t('status merges, so a report of one field keeps the rest', () => {
    registerSurface(tci());
    setSurfaceStatus('tci', { running: true, clients: 1 });
    setSurfaceStatus('tci', { clients: 3 });
    assert.deepStrictEqual(surfaceStatus('tci'), {
        running: true, clients: 3, detail: null, error: null,
    });
});

t('a client count is never negative or nonsense', () => {
    registerSurface(tci());
    setSurfaceStatus('tci', { clients: -5 });
    assert.strictEqual(surfaceStatus('tci').clients, 0);
    setSurfaceStatus('tci', { clients: 'lots' });
    assert.strictEqual(surfaceStatus('tci').clients, 0);
});

t('status for a surface nobody registered is refused', () => {
    assert.throws(() => setSurfaceStatus('ghost', { running: true }), /no surface/);
});

t('listeners hear every change and can stop listening', () => {
    const seen = [];
    const off = onSurfaces((l) => seen.push(l.length));
    registerSurface(tci());
    setSurfaceStatus('tci', { running: true });
    unregisterSurface('tci');
    off();
    registerSurface(tci());
    assert.deepStrictEqual(seen, [1, 1, 0]);
});

t('the audio port is tagged with one agreed name', () => {
    // The page posts it and the client listens for it; a literal on either side
    // is a mismatch waiting to happen.
    assert.strictEqual(EVENT_AUDIO_PORT, 'ubersdr.audio-port');
});

// --- built-in against provided ----------------------------------------------
//
// The line the SDR Control panel draws between the two. It matters because the
// mapping editor reads `state[id].mappings` and drives `getSurface(id)`, and a
// provided surface has neither: rendering it for one is a crash on mount, not a
// degraded panel. Picking TCI did exactly that once.

t('only the surfaces this page opens itself are mapped', () => {
    assert.strictEqual(isMappedSurface('flexcontrol'), true);
    assert.strictEqual(isMappedSurface('midi'), true);
});

t('off is not a mapped surface', () => {
    assert.strictEqual(isMappedSurface('off'), false);
});

t('a provided surface is never treated as a mapped one', () => {
    registerSurface({ id: 'tci', label: 'TCI', audio: true, fields: [] });
    for (const s of listSurfaces()) {
        assert.strictEqual(isMappedSurface(s.id), false, `${s.id} must not be mapped`);
    }
    // And nothing outside the built-in list at all, whatever it calls itself.
    for (const id of ['tci', 'rigctld', '', null, undefined, 'Flexcontrol']) {
        assert.strictEqual(isMappedSurface(id), false, `${id} must not be mapped`);
    }
});

t('every mapped surface is in the picker list', () => {
    // The two lists are separate on purpose — one is what the picker offers,
    // the other is what has settings behind it — so they are checked against
    // each other rather than assumed to agree.
    for (const id of SURFACES) {
        if (id === 'off') continue;
        assert.strictEqual(isMappedSurface(id), true, `${id} is offered but has no settings`);
    }
});

console.log(`\n${pass} passed`);
