// RM Noise: the wire format, the resampling, and whose password it is.
//
// The protocol half is held to v1's own file, the same way the recorder and NR2
// are: the service is somebody else's and undocumented, so "the two frontends
// agree" is the only correctness anyone can check from here. v1's file is a
// browser script that reaches for window and document at load, so it is given
// enough of both to parse.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    OversizeBuffer, RM_MODES, lanczosResample, packFrame, rmCredentials,
    rmFamilyFor, rmFamilyOfModel, rmModeSupported, rmModelFor, saveRmCredentials, unpackFrame,
    designLPF, applyLPF,
} = require('./.build/rmnoise.cjs');

let pass = 0;
// Some of these are async — a returned promise is awaited before the next
// test, so failures land against the right name.
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

async function run() {
    for (const [name, fn] of queue) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + e.message);
            process.exitCode = 1;
        }
    }
}

// ---- v1, loaded as a browser would ------------------------------------------

function loadV1() {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'rmnoise.js'), 'utf8');
    const sandbox = {
        window: {},
        document: { addEventListener() {}, getElementById: () => null },
        localStorage: { getItem: () => null, setItem() {} },
        performance: { now: () => 0 },
        WebSocket: function () {},
        console,
    };
    sandbox.window.addEventListener = () => {};
    // The file ends by hanging its API on `window`; everything else it declares
    // stays local, so the ones wanted here are returned explicitly.
    const fn = new Function(
        'window', 'document', 'localStorage', 'performance', 'WebSocket', 'console',
        `${src}\n;return { rmNoise_packFrame, rmNoise_unpackFrame, lanczosResample, OversizeBuffer, rmNoise_designLPF, rmNoise_applyLPF, rmNoise_createOversizeBuffers };`,
    );
    return fn(sandbox.window, sandbox.document, sandbox.localStorage,
        sandbox.performance, sandbox.WebSocket, sandbox.console);
}

const v1 = loadV1();

t('a frame on the wire is byte-for-byte v1’s', () => {
    const pcm = new Int16Array(384);
    for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 7919) % 65536) - 32768;
    const ours = new Uint8Array(packFrame(42n, 1700000000123n, pcm, 1234));
    const theirs = new Uint8Array(v1.rmNoise_packFrame(42n, 1700000000123n, pcm, 1234));
    assert.deepStrictEqual(Array.from(ours), Array.from(theirs));
    // ...and the header is the documented shape, not merely a shared mistake.
    const view = new DataView(ours.buffer);
    assert.strictEqual(view.getBigUint64(0, true), 42n, 'frame number');
    assert.strictEqual(view.getBigUint64(8, true), 1700000000123n, 'timestamp');
    assert.strictEqual(view.getUint32(16, true), 1234, 'audio scale');
    assert.strictEqual(ours.length, 20 + 384 * 2, 'header + int16 payload');
});

t('unpacking is v1’s too, and round-trips', () => {
    const pcm = new Int16Array(384);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 200) - 100;
    const packed = packFrame(7n, 99n, pcm, 55);
    const ours = unpackFrame(packed);
    const theirs = v1.rmNoise_unpackFrame(packed);
    assert.strictEqual(ours.frameNum, theirs.frameNum);
    assert.strictEqual(ours.scale, theirs.scale);
    assert.deepStrictEqual(Array.from(ours.pcm), Array.from(theirs.pcm));
    assert.deepStrictEqual(Array.from(ours.pcm), Array.from(pcm));
});

t('the resampler is v1’s, sample for sample', () => {
    const input = new Float32Array(576);
    for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin((2 * Math.PI * 700 * i) / 12000) * 0.4
            + Math.sin((2 * Math.PI * 1900 * i) / 12000) * 0.2;
    }
    for (const [from, to] of [[12000, 8000], [8000, 12000], [48000, 8000], [8000, 48000]]) {
        const ours = lanczosResample(input, from, to);
        const theirs = v1.lanczosResample(input, from, to);
        assert.strictEqual(ours.length, theirs.length, `${from}->${to} length`);
        for (let i = 0; i < ours.length; i++) {
            assert.strictEqual(ours[i], theirs[i], `${from}->${to} sample ${i}`);
        }
    }
});

t('the oversize buffer carries context exactly as v1 does', () => {
    const ours = new OversizeBuffer(384, 15, 15, 10, 10);
    const theirs = new v1.OversizeBuffer(384, 15, 15, 10, 10);
    for (let f = 0; f < 4; f++) {
        const frame = new Float32Array(384);
        for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((f * 384 + i) / 20);
        const a = ours.addFrame(frame);
        const b = theirs.addFrame(frame);
        assert.deepStrictEqual(Array.from(a), Array.from(b), `frame ${f}`);
        assert.deepStrictEqual(
            Array.from(ours.goodFrame(a)), Array.from(theirs.goodFrame(b)), `good ${f}`,
        );
    }
});

t('the send filter is v1’s 2.8 kHz design', () => {
    for (const rate of [12000, 48000]) {
        const ours = designLPF(2800, rate);
        const theirs = v1.rmNoise_designLPF(2800, rate);
        assert.strictEqual(ours.length, theirs.length, `${rate} taps`);
        for (let i = 0; i < ours.length; i++) assert.strictEqual(ours[i], theirs[i], `${rate} tap ${i}`);
    }
    // It is a low-pass: a 5 kHz tone comes out far quieter than an 800 Hz one.
    const rate = 12000;
    const coeffs = designLPF(2800, rate);
    const power = (hz) => {
        const state = new Float32Array(coeffs.length - 1);
        const x = new Float32Array(4096);
        for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / rate);
        const y = applyLPF(x, coeffs, state);
        let p = 0;
        for (let i = 2048; i < y.length; i++) p += y[i] ** 2;
        return p;
    };
    assert.ok(power(5000) < power(800) * 0.01, 'the stopband is not stopping');
});

// ---- whose credential is it -------------------------------------------------

t('the login is the operator’s, and travels with them', () => {
    // Not the receiver's: it must be a prefixed key, because only those are
    // carried between receivers by the apps' shared-settings code, and it must
    // be listed as a secret so it never reaches a backup file.
    const { INSTANCE_SECRETS, SECRETS, USER_SECRETS } = require('./.build/backup.cjs');
    assert.ok(USER_SECRETS.includes('ubersdr.v2.rmnoise'), 'the v2 key is not a user secret');
    assert.ok(USER_SECRETS.includes('rmnoise_password'), 'v1’s password is not a user secret');
    assert.ok(!INSTANCE_SECRETS.includes('ubersdr.v2.rmnoise'),
        'the login must not be treated as belonging to one receiver');
    for (const k of [...INSTANCE_SECRETS, ...USER_SECRETS]) {
        assert.ok(SECRETS.includes(k), `${k} is missing from the backup exclusions`);
    }
    // The instance's own passwords stay put.
    for (const k of ['rotctl_password', 'ant_switch_password', 'ubersdr_bypass_password']) {
        assert.ok(INSTANCE_SECRETS.includes(k), `${k} should belong to the instance`);
    }
});

t('v1’s login is read as a seed, and written back alongside', () => {
    const store = new Map();
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };

    // Nothing stored anywhere.
    assert.deepStrictEqual(rmCredentials(),
        { username: '', password: '', filterNumber: 1, models: {} });

    // Only v1 has been used: that login is picked up rather than asked for again.
    store.set('rmnoise_username', 'M0ABC');
    store.set('rmnoise_password', 'hunter2');
    store.set('rmnoise_filter', '3');
    assert.deepStrictEqual(rmCredentials(),
        { username: 'M0ABC', password: 'hunter2', filterNumber: 3, models: {} });

    // Saving writes the travelling key *and* keeps v1 working from it.
    saveRmCredentials({ username: 'M0XYZ' });
    assert.strictEqual(JSON.parse(store.get('ubersdr.v2.rmnoise')).username, 'M0XYZ');
    assert.strictEqual(store.get('rmnoise_username'), 'M0XYZ');
    assert.strictEqual(store.get('rmnoise_password'), 'hunter2', 'the password was dropped');
    assert.strictEqual(rmCredentials().filterNumber, 3, 'the model choice was dropped');
});

t('the service is offered only where it has a model', () => {
    // Phone, CW and FM are what the service trains; a double-sideband carrier
    // is nothing like any of them, so AM and SAM are where this switches off.
    for (const m of ['usb', 'lsb', 'cwu', 'cwl', 'fm', 'nfm', 'USB']) {
        assert.ok(rmModeSupported(m), m);
    }
    for (const m of ['am', 'sam', 'iq', '', null]) assert.ok(!rmModeSupported(m), String(m));
    assert.strictEqual(RM_MODES.size, 6);
});

t('a model’s kind is read from the words the service uses', () => {
    // SSB, CW and FM are the words in the names. The order they are tested in
    // is what this is really about: "Phone FM" carries two of them, and asking
    // about phone first classified the FM model as an SSB one — which is how
    // coming back from FM to LSB left the FM model running.
    assert.strictEqual(rmFamilyOfModel('Phone FM Repeater'), 'fm', 'FM must beat the word phone');
    assert.strictEqual(rmFamilyOfModel('RM Noise SSB'), 'ssb');
    assert.strictEqual(rmFamilyOfModel('RM Noise CW'), 'cw');
    assert.strictEqual(rmFamilyOfModel('NFM wide'), 'fm');
    assert.strictEqual(rmFamilyOfModel('Model 9'), '', 'an unrecognisable name belongs to nothing');
    assert.strictEqual(rmFamilyOfModel(null), '');
    // Not a substring match: "FMT" and "CWA" are not these families.
    assert.strictEqual(rmFamilyOfModel('FMT contest'), '');
});

t('a name that says the family beats one that merely sounds like voice', () => {
    // The service's names are all "Phone something", and one of them —
    // "Phone web client version" — says nothing about the kind of signal.
    // Being first in the list, it was chosen for every voice mode, over the
    // model that actually says SSB.
    const real = [
        { filterNumber: 1, filterDesc: 'Phone web client version' },
        { filterNumber: 2, filterDesc: 'Phone SSB high noise' },
        { filterNumber: 3, filterDesc: 'Phone CW' },
        { filterNumber: 4, filterDesc: 'Phone FM' },
    ];
    assert.strictEqual(rmModelFor('lsb', real).filterNumber, 2, 'the SSB model must win');
    assert.strictEqual(rmModelFor('usb', real).filterNumber, 2);
    assert.strictEqual(rmModelFor('cwu', real).filterNumber, 3);
    assert.strictEqual(rmModelFor('nfm', real).filterNumber, 4);
    assert.strictEqual(rmModelFor('am', real), null);
    // The vaguer one is still a voice model, and still the answer when it is
    // the only voice model there is.
    const vague = [{ filterNumber: 1, filterDesc: 'Phone web client version' }];
    assert.strictEqual(rmModelFor('usb', vague).filterNumber, 1);
    assert.strictEqual(rmFamilyOfModel('Phone web client version'), 'ssb');
});

t('the mode chooses the model', () => {
    const filters = [
        { filterNumber: 1, filterDesc: 'SSB General' },
        { filterNumber: 2, filterDesc: 'SSB Aggressive' },
        { filterNumber: 3, filterDesc: 'CW Narrow' },
        { filterNumber: 4, filterDesc: 'Phone FM Repeater' },
    ];
    assert.strictEqual(rmModelFor('usb', filters).filterNumber, 1);
    assert.strictEqual(rmModelFor('lsb', filters).filterNumber, 1);
    assert.strictEqual(rmModelFor('cwu', filters).filterNumber, 3);
    assert.strictEqual(rmModelFor('cwl', filters).filterNumber, 3);
    assert.strictEqual(rmModelFor('nfm', filters).filterNumber, 4, 'FM wants the FM model');
    assert.strictEqual(rmModelFor('am', filters), null, 'AM has nothing suitable');
    // The first of its kind, so the service's own order decides between two
    // SSB models rather than this file guessing which is better.
    assert.strictEqual(rmModelFor('usb', filters.slice().reverse()).filterNumber, 2);
    // A service offering nothing recognisable is not a crash.
    assert.strictEqual(rmModelFor('usb', [{ filterNumber: 9, filterDesc: 'Model 9' }]), null);
    assert.strictEqual(rmModelFor('usb', null), null);
    assert.strictEqual(rmFamilyFor('sam'), '');
});

t('a chosen model is kept while the mode stays in its family', () => {
    // Switching frequency around the phone bands must not keep snatching the
    // model back from somebody who picked the aggressive one.
    const { RmNoiseBridge } = require('./.build/rmnoise.cjs');
    const rm = new RmNoiseBridge();
    rm.availableFilters = [
        { filterNumber: 1, filterDesc: 'SSB General' },
        { filterNumber: 2, filterDesc: 'SSB Aggressive' },
        { filterNumber: 3, filterDesc: 'CW Narrow' },
        { filterNumber: 4, filterDesc: 'Phone FM Repeater' },
    ];
    global.localStorage = { getItem: () => null, setItem() {} };

    rm.filterNumber = 2;                  // the operator's choice
    rm.matchModel('lsb');
    assert.strictEqual(rm.filterNumber, 2, 'a suitable model was replaced');

    rm.matchModel('cwu');                 // family changed: follow it
    assert.strictEqual(rm.filterNumber, 3);

    rm.matchModel('usb');                 // and back
    assert.strictEqual(rm.filterNumber, 1);

    // The one that started this: FM to LSB has to leave the FM model, however
    // its name reads.
    rm.matchModel('nfm');
    assert.strictEqual(rm.filterNumber, 4, 'FM did not take the FM model');
    rm.matchModel('lsb');
    assert.strictEqual(rm.filterNumber, 1, 'coming back to LSB kept the FM model');
});

// ---- what stops it trying again ---------------------------------------------

const { RmNoiseBridge } = require('./.build/rmnoise.cjs');

// A bridge with the network taken away: connect() gets as far as the proxy and
// no further, which is all these tests are about.
function bridgeWith(reply, status = 200) {
    const rm = new RmNoiseBridge();
    global.fetch = async () => ({ status, text: async () => JSON.stringify(reply) });
    global.localStorage = {
        getItem: (k) => (k === 'rmnoise_username' ? 'M0ABC' : k === 'rmnoise_password' ? 'pw' : null),
        setItem() {},
    };
    return rm;
}

t('the model chosen for a mode is remembered for that mode', () => {
    const { RmNoiseBridge } = require('./.build/rmnoise.cjs');
    const store = new Map();
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };
    const rm = new RmNoiseBridge();
    rm.availableFilters = [
        { filterNumber: 1, filterDesc: 'SSB General' },
        { filterNumber: 2, filterDesc: 'SSB Aggressive' },
        { filterNumber: 3, filterDesc: 'CW Narrow' },
        { filterNumber: 4, filterDesc: 'Phone FM Repeater' },
    ];

    rm.matchModel('usb');
    assert.strictEqual(rm.filterNumber, 1, 'the first SSB model is the default');

    // The operator picks the other SSB model.
    rm.setFilter(2);
    rm.matchModel('cwu');
    assert.strictEqual(rm.filterNumber, 3, 'CW still takes the CW model');

    // ...and coming back gives them theirs, not the first of the kind.
    rm.matchModel('usb');
    assert.strictEqual(rm.filterNumber, 2, 'the remembered SSB model was not restored');

    // A deliberately odd pairing is theirs to make and theirs to keep.
    rm.setFilter(3);                    // the CW model, on SSB
    rm.matchModel('nfm');
    assert.strictEqual(rm.filterNumber, 4);
    rm.matchModel('lsb');
    assert.strictEqual(rm.filterNumber, 3, 'an odd but deliberate choice was overruled');

    // Remembered by name as well as number, so the service renumbering does
    // not silently select whatever now holds the old number.
    const fresh = new RmNoiseBridge();
    fresh.availableFilters = [
        { filterNumber: 7, filterDesc: 'CW Narrow' },
        { filterNumber: 8, filterDesc: 'SSB General' },
    ];
    fresh.matchModel('usb');
    assert.strictEqual(fresh.filterNumber, 7, 'the remembered model was not found by name');
});

t('a refused login is remembered as refused', () => {
    const rm = bridgeWith({ ok: false, error: 'Invalid username or password' }, 401);
    return rm.connect().then(
        () => assert.fail('a refusal must reject'),
        () => {
            assert.strictEqual(rm.authFailed, true, 'the refusal was not remembered');
            assert.ok(/username or password/i.test(rm.error), rm.error);
            assert.strictEqual(rm.ready, false);
        },
    );
});

t('a service that is merely down is not a refused login', () => {
    // The difference decides whether anything retries: a wrong password will
    // be wrong again, a proxy that could not reach rmnoise.com may not be.
    const rm = bridgeWith({ ok: false, error: 'Login request failed: timeout' }, 502);
    return rm.connect().then(
        () => assert.fail('a failure must reject'),
        () => {
            assert.strictEqual(rm.authFailed, false, 'a bad gateway is not a bad password');
            assert.ok(rm.error);
        },
    );
});

t('disconnecting by hand stays disconnected; teardown does not', () => {
    const rm = new RmNoiseBridge();
    return rm.disconnect({ manual: true }).then(() => {
        assert.strictEqual(rm.stopped, true, 'the operator’s stop was not recorded');
        return rm.disconnect();
    }).then(() => {
        // Teardown after a manual stop must not un-stop it either.
        assert.strictEqual(rm.stopped, true);
        const other = new RmNoiseBridge();
        return other.disconnect().then(() => {
            assert.strictEqual(other.stopped, false, 'teardown must not look like an operator stop');
        });
    });
});

t('a second refusal does not become a second attempt', () => {
    // Every failure used to be the trigger for the next try: the effect that
    // starts a connection watches the state a failure changes. The bridge's
    // own part of stopping that is remembering the refusal — the panel's is a
    // single attempt per selection.
    const rm = bridgeWith({ ok: false, error: 'Invalid username or password' }, 401);
    let calls = 0;
    global.fetch = async () => {
        calls++;
        return { status: 401, text: async () => JSON.stringify({ ok: false, error: 'Invalid username or password' }) };
    };
    return rm.connect().catch(() => {}).then(() => {
        assert.strictEqual(calls, 1);
        assert.strictEqual(rm.authFailed, true);
        // A caller that ignores the flag is a caller bug; what the bridge
        // guarantees is that the flag survives until a connect clears it.
        assert.strictEqual(rm.stopped, false, 'a refusal is not a manual stop');
        return rm.connect().catch(() => {});
    }).then(() => {
        // An explicit retry is allowed — that is the operator pressing
        // Connect — and it clears the refusal before trying.
        assert.strictEqual(calls, 2, 'an explicit connect must still be able to try');
    });
});

t('the buffer readout is the reserve, not the drained jitter queue', () => {
    const rm = new RmNoiseBridge();
    assert.strictEqual(rm.bufferMs, 0);
    rm.accumOut = new Float32Array(8000);      // one second at the wire rate
    assert.strictEqual(rm.bufferMs, 1000);
    rm.accumOut = new Float32Array(1200);
    assert.strictEqual(rm.bufferMs, 150);
});

run().then(() => console.log(`\n${pass} ok`));
