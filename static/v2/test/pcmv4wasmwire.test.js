// The WebAssembly decoder as audio-connection.js uses it: IQ to the module,
// demodulated audio to pcm-v4.js, and the stream handed between the two only
// where the server's own state starts afresh.
//
// The module's exactness on its own is static/v2/native/pcmv4/test.js. What
// this checks is the wiring: that every packet still comes out of the
// connection exactly as the JavaScript decoder alone would have produced it,
// across a usb -> iq -> am session on one socket -- the case where the stream
// changes hands twice -- and that each packet went to the decoder it should.
//
// The streams are the server encoder's, from static/v2/native/pcmv4/testdata
// (pcm_v4_wasm_fixture_test.go). mixed-modes.v4 is one encoder carried
// through all three modes, as a live connection is.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AudioConnection, PCMv4StreamDecoder, loadPCMv4Wasm } = require('./.build/pcmv4wasmwire.cjs');

const TESTDATA = path.join(__dirname, '..', 'native', 'pcmv4', 'testdata');

// "UV4F", a format byte, a uint32 packet count, then [uint32 length][packet].
function load(name) {
    const b = fs.readFileSync(path.join(TESTDATA, name));
    assert.strictEqual(b.toString('latin1', 0, 4), 'UV4F', `${name} is not a UV4F fixture`);
    const n = b.readUInt32LE(5);
    const out = [];
    let off = 9;
    for (let i = 0; i < n; i++) {
        const len = b.readUInt32LE(off);
        off += 4;
        const ab = new ArrayBuffer(len);
        new Uint8Array(ab).set(b.subarray(off, off + len));
        out.push(ab);
        off += len;
    }
    return out;
}

const profileOf = (p) => new Uint8Array(p)[4] & 0x07;
const isIQ = (p) => profileOf(p) === 0 || profileOf(p) === 2;

// Every packet through a fresh connection, against a lone JavaScript decoder:
// the planes, rate, channels and capture time of each, and which decoder the
// connection says took it.
function run(packets) {
    const conn = new AudioConnection();
    let got = null;
    conn.on('pcm', (f) => { got = f; });
    const ref = new PCMv4StreamDecoder();
    const used = [];
    packets.forEach((p, n) => {
        got = null;
        const want = ref.decode(p);
        conn._onPCMv4Binary(p);
        if (!want) {
            assert.strictEqual(got, null, `packet ${n}: refused by JavaScript, emitted by the connection`);
            used.push(null);
            return;
        }
        assert.ok(got, `packet ${n}: decoded by JavaScript, nothing emitted by the connection`);
        assert.strictEqual(got.sampleRate, want.sampleRate, `packet ${n}: sample rate`);
        assert.strictEqual(got.channels, want.channels, `packet ${n}: channels`);
        assert.strictEqual(got.captureMs, want.captureMs, `packet ${n}: capture time`);
        assert.strictEqual(got.planes.length, want.planes.length, `packet ${n}: plane count`);
        for (let c = 0; c < want.planes.length; c++) {
            const a = got.planes[c], b = want.planes[c];
            assert.strictEqual(a.length, b.length, `packet ${n} plane ${c}: length`);
            for (let i = 0; i < b.length; i++) {
                if (!Object.is(a[i], b[i])) {
                    assert.fail(`packet ${n} plane ${c} sample ${i}: ${a[i]}, JavaScript ${b[i]}`);
                }
            }
        }
        used.push(conn.v4Decoder);
    });
    return { conn, used };
}

let pass = 0;
const t = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

(async () => {
    // audio-connection.js started this load when it was required, and its
    // handler was attached first, so by the time this resolves the connection
    // has the runtime too.
    const rt = await loadPCMv4Wasm();
    console.log(`      module: ${rt.backend}`);

    await t('IQ streams decode through the module, identically', () => {
        for (const name of ['iq12k-ft8.v4', 'iq384-ft8.v4', 'iq384-mw-carriers.v4', 'iq384-quiet-band.v4']) {
            const packets = load(name);
            const { used } = run(packets);
            const decoded = used.filter(Boolean);
            assert.ok(decoded.length > packets.length * 0.9, `${name}: only ${decoded.length} of ${packets.length} decoded`);
            assert.ok(decoded.every((u) => u === rt.backend), `${name}: not every packet went to ${rt.backend}: ${[...new Set(decoded)]}`);
        }
    });

    await t('reduced-depth IQ, its profile moving 2 -> 0 -> 2, stays on the module', () => {
        const packets = load('iq384-scaled.v4');
        assert.ok(new Set(packets.map(profileOf)).size > 1, 'the fixture no longer changes profile');
        const { used } = run(packets);
        assert.ok(used.filter(Boolean).every((u) => u === rt.backend));
    });

    await t('demodulated audio stays on the JavaScript decoder', () => {
        for (const name of ['usb-ft8.v4', 'lsb-voice.v4', 'am.v4', 'cw.v4', 'nfm.v4']) {
            const { used } = run(load(name));
            assert.ok(used.filter(Boolean).every((u) => u === 'js'), `${name}: ${[...new Set(used)]}`);
        }
    });

    await t('usb -> iq -> am on one socket: handed over twice, every sample identical', () => {
        const packets = load('mixed-modes.v4');
        const { conn, used } = run(packets);
        // Each packet went where its profile says.
        packets.forEach((p, n) => {
            if (used[n] === null) return;
            assert.strictEqual(used[n], isIQ(p) ? rt.backend : 'js', `packet ${n} (profile ${profileOf(p)})`);
        });
        // And the hand-overs are the two mode changes, nothing else.
        const runs = [];
        for (const u of used) if (u && u !== runs[runs.length - 1]) runs.push(u);
        assert.deepStrictEqual(runs, ['js', rt.backend, 'js']);
        // The Stats panel's counters are as they were with one decoder.
        const st = conn.v4Stats;
        assert.strictEqual(st.rice + st.silent + st.escape, used.filter(Boolean).length);
    });

    await t('a reconnect starts the stream over on the decoder its first packet needs', () => {
        // connect() calls _resetDecoders() before every new socket.
        const iq = load('iq12k-ft8.v4');
        const usb = load('usb-ft8.v4');
        const conn = new AudioConnection();
        let got = 0;
        conn.on('pcm', () => { got++; });
        for (const p of iq.slice(0, 50)) conn._onPCMv4Binary(p);
        assert.strictEqual(conn.v4Decoder, rt.backend);
        conn._resetDecoders();
        got = 0;
        for (const p of usb) conn._onPCMv4Binary(p);
        assert.strictEqual(conn.v4Decoder, 'js');
        assert.strictEqual(got, usb.length, 'a fresh audio stream after IQ lost packets');
        got = 0;
        conn._resetDecoders();
        for (const p of iq) conn._onPCMv4Binary(p);
        assert.strictEqual(conn.v4Decoder, rt.backend);
        assert.strictEqual(got, iq.length, 'a fresh IQ stream after audio lost packets');
    });

    console.log(`\n${pass} passed`);
})();
