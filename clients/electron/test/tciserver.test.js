// The TCI server: the handshake, the commands, the audio frame.
//
// This is the half a client sees, and a client is JTDX or WSJT-X — software
// that cannot be asked what it disliked. So the things it silently depends on
// are pinned here: the order and content of the greeting, `length` counting
// floats rather than frames, a data mode meaning SSB, and audio arriving at
// 48 kHz whatever rate the receiver runs at.
//
// No socket is needed for any of it. A fake connection records what was
// written, which is exactly what a client would have read.

const assert = require('assert');
const {
    TciServer, Resampler, audioHeader, parseFrame, AUDIO_RATE,
} = require('../tciserver.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** A connection that only remembers: `sent` is text, `frames` is binary. */
function fake() {
    const conn = {
        sent: [],
        frames: [],
        socket: { writableLength: 0 },
        onmessage: null,
        onclose: null,
        close: () => {},
    };
    conn.text = (s) => { conn.sent.push(s); return true; };
    conn.binary = (buf) => { conn.frames.push(buf); return true; };
    return conn;
}

/** A server with a client attached, and whatever it told that client. */
function server(opts = {}) {
    const control = [];
    const s = new TciServer({ onControl: (c) => control.push(c), ...opts });
    const conn = fake();
    // `accept` is what a real connection goes through; `server` is set so the
    // audio path believes it is listening.
    s.server = { fake: true };
    s.accept(conn);
    return { s, conn, control, sent: conn.sent, frames: conn.frames };
}

/** A server greeted after adopting `range`, as main.js does before start(). */
function serverWithRange(range) {
    const s = new TciServer({});
    s.setTuningRange(range);
    const conn = fake();
    s.server = { fake: true };
    s.accept(conn);
    return { s, sent: conn.sent };
}

// --- the handshake -----------------------------------------------------------

t('the greeting ends with ready and start, in that order', () => {
    // A client waits for `ready;` before it will speak. Anything after it is
    // state it already has; anything missing before it may stop it starting.
    const { sent } = server();
    assert.strictEqual(sent[sent.length - 2], 'ready;');
    assert.strictEqual(sent[sent.length - 1], 'start;');
});

t('the greeting describes the device before its state', () => {
    const { sent } = server({ deviceName: 'UberSDR' });
    assert.deepStrictEqual(sent.slice(0, 10), [
        'device:UberSDR;',
        'protocol:ubersdr,1.0;',
        'receive_only:true;',
        'trx_count:2;',
        'channel_count:2;',
        'vfo_limits:10000,30000000;',
        'if_limits:-48000,48000;',
        'modulations_list:am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm;',
        `audio_samplerate:${AUDIO_RATE};`,
        `iq_samplerate:${AUDIO_RATE};`,
    ]);
});

t('a second receiver is declared and disabled', () => {
    // Clients written for a SunSDR expect two; only the first does anything.
    const { sent } = server();
    assert.ok(sent.includes('rx_enable:0,true;'));
    assert.ok(sent.includes('rx_enable:1,false;'));
});

t('the greeting carries the dial as it stands', () => {
    const { s } = server();
    s.update({ frequency: 7074000, mode: 'lsb' });
    const conn = fake();
    s.accept(conn);
    assert.ok(conn.sent.includes('vfo:0,0,7074000;'));
    assert.ok(conn.sent.includes('dds:0,7074000;'));
    assert.ok(conn.sent.includes('modulation:0,lsb;'));
});

// --- commands from a client --------------------------------------------------

t('a client tuning retunes the receiver and is echoed', () => {
    const { s, conn, control, sent } = server();
    sent.length = 0;
    s.onText(conn, 'vfo:0,0,7074000;');
    assert.deepStrictEqual(control, [{ frequency: 7074000 }]);
    // Echoed back, which is how TCI confirms — a client that sets a frequency
    // and hears nothing assumes it did not take.
    assert.deepStrictEqual(sent, ['dds:0,7074000;', 'vfo:0,0,7074000;']);
});

t('dds is a retune too', () => {
    // The panorama centre and the tuned frequency are one and the same here,
    // and a client that only sends dds must still move the receiver.
    const { s, conn, control } = server();
    s.onText(conn, 'dds:0,10000000;');
    assert.deepStrictEqual(control, [{ frequency: 10000000 }]);
});

t('a data mode means SSB', () => {
    // How WSJT-X and JTDX ask for SSB. Refusing it means refusing the software
    // this exists for.
    const { s, conn, control } = server();
    s.onText(conn, 'modulation:0,digu;');
    assert.deepStrictEqual(control, [{ mode: 'usb' }]);
    s.onText(conn, 'modulation:0,digl;');
    assert.deepStrictEqual(control[1], { mode: 'lsb' });
});

t('a mode with no receiver equivalent is remembered, not acted on', () => {
    const { s, conn, control, sent } = server();
    sent.length = 0;
    s.onText(conn, 'modulation:0,drm;');
    assert.deepStrictEqual(control, [], 'nothing should have been retuned');
    assert.deepStrictEqual(sent, ['modulation:0,drm;'], 'but the client should be told it took');
});

t('several commands in one frame all run', () => {
    const { s, conn, control } = server();
    s.onText(conn, 'vfo:0,0,7100000;modulation:0,lsb;');
    assert.deepStrictEqual(control, [{ frequency: 7100000 }, { mode: 'lsb' }]);
});

t('the second receiver is not a receiver', () => {
    const { s, conn, control } = server();
    s.onText(conn, 'vfo:1,0,1000000;modulation:1,am;');
    assert.deepStrictEqual(control, []);
});

t('keying up is answered with a refusal', () => {
    // Receive only. A client that keys and is told nothing waits for a change
    // that never comes.
    const { s, conn, sent } = server();
    sent.length = 0;
    s.onText(conn, 'trx:0,true;');
    assert.deepStrictEqual(sent, ['trx:0,false;']);
});

t('a query is answered without changing anything', () => {
    const { s, conn, control, sent } = server();
    s.update({ frequency: 3573000 });
    sent.length = 0;
    s.onText(conn, 'vfo:0,0;dds:0;modulation:0;device;');
    assert.deepStrictEqual(control, []);
    assert.deepStrictEqual(sent, [
        'vfo:0,0,3573000;', 'dds:0,3573000;', 'modulation:0,usb;', 'device:UberSDR;',
    ]);
});

// --- the receiver moving under us --------------------------------------------

t('only changes are reported', () => {
    const { s, sent } = server();
    s.update({ frequency: 14074000, mode: 'usb' });
    sent.length = 0;
    s.update({ frequency: 14074000, mode: 'usb' });
    assert.deepStrictEqual(sent, [], 'a repeat is not a change');
});

t('receiver modes map to TCI names', () => {
    const { s, sent } = server();
    sent.length = 0;
    s.update({ mode: 'cwl' });
    s.update({ mode: 'nfm' });
    s.update({ mode: 'fm' });
    assert.deepStrictEqual(sent, ['modulation:0,cw;', 'modulation:0,nfm;', 'modulation:0,wfm;']);
});

t('a mode TCI cannot name leaves the client where it was', () => {
    const { s, sent } = server();
    s.update({ mode: 'usb' });
    sent.length = 0;
    s.update({ mode: 'spectrum' });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(s.mode, 'usb');
});

// --- audio -------------------------------------------------------------------

t('the audio header says what JTDX reads', () => {
    const h = audioHeader(0, 48000, 512);
    assert.strictEqual(h.length, 64);
    assert.strictEqual(h.readUInt32LE(0), 0);        // receiver
    assert.strictEqual(h.readUInt32LE(4), 48000);    // sample rate
    assert.strictEqual(h.readUInt32LE(8), 3);        // float32
    assert.strictEqual(h.readUInt32LE(12), 0);       // codec
    assert.strictEqual(h.readUInt32LE(16), 0);       // crc
    // Floats, not frames and not stereo pairs. A client reading this as pairs
    // plays the audio at double speed.
    assert.strictEqual(h.readUInt32LE(20), 512);
    assert.strictEqual(h.readUInt32LE(24), 1);       // RxAudioStream
    assert.ok(h.slice(28).every((b) => b === 0), 'reserved must be zero');
});

t('no audio goes out until a client asks for it', () => {
    const { s, conn, frames } = server();
    const pcm = new Float32Array(880);               // 440 stereo frames
    assert.strictEqual(s.pushAudio(pcm, 440, 12000), false);
    assert.strictEqual(frames.length, 0);
    s.onText(conn, 'audio_start:0;');
    assert.strictEqual(s.pushAudio(pcm, 440, 12000), true);
    assert.strictEqual(frames.length, 1);
    s.onText(conn, 'audio_stop:0;');
    assert.strictEqual(s.pushAudio(pcm, 440, 12000), false);
});

t('audio is resampled to 48 kHz whatever the receiver runs at', () => {
    const { s, conn, frames } = server();
    s.onText(conn, 'audio_start:0;');
    s.pushAudio(new Float32Array(880), 440, 12000);
    const frame = frames[0];
    assert.strictEqual(frame.readUInt32LE(4), 48000, 'the header must say 48 k');
    const floats = frame.readUInt32LE(20);
    assert.strictEqual((frame.length - 64) / 4, floats, 'header length must match the payload');
    // 440 frames at 12 k is 4× that at 48 k, stereo — give or take the frame
    // the resampler holds back to interpolate against next time.
    assert.ok(Math.abs(floats / 2 - 440 * 4) <= 4, `got ${floats / 2} frames`);
});

t('a client that cannot keep up is skipped, not queued behind', () => {
    const { s, conn, frames } = server();
    s.onText(conn, 'audio_start:0;');
    conn.socket.writableLength = 4 * 1024 * 1024;
    assert.strictEqual(s.pushAudio(new Float32Array(880), 440, 12000), false);
    assert.strictEqual(frames.length, 0);
    assert.strictEqual(s.dropped, 1);
});

t('the last client leaving stops the stream', () => {
    // Otherwise a client that connects, streams and vanishes leaves the tap
    // open for the next one, which then receives audio it never asked for.
    const { s, conn } = server();
    s.onText(conn, 'audio_start:0;');
    assert.ok(s.streaming.has(0));
    conn.onclose();
    assert.strictEqual(s.streaming.size, 0);
});

// --- resampling --------------------------------------------------------------

t('matching rates pass through untouched', () => {
    const r = new Resampler(2);
    const input = new Float32Array([1, -1, 2, -2, 3, -3]);
    assert.strictEqual(r.process(input, 3, 48000, 48000), input);
});

t('4x upsampling holds the rate over many blocks', () => {
    // The failure this guards against is a resampler that restarts each block:
    // it drifts, and the client's clock recovery hears it as a stream that is
    // slowly too slow.
    const r = new Resampler(2);
    let out = 0;
    for (let i = 0; i < 100; i++) out += r.process(new Float32Array(880), 440, 12000, 48000).length / 2;
    const expected = 440 * 100 * 4;
    assert.ok(Math.abs(out - expected) <= 4, `${out} frames, expected about ${expected}`);
});

t('interpolation is continuous across block boundaries', () => {
    // A ramp, fed in two pieces. If the resampler forgets the last frame of the
    // first piece, the seam shows up as a step — which is a click at the block
    // rate, once every 37 ms.
    const r = new Resampler(1);
    const ramp = (from, n) => Float32Array.from({ length: n }, (_, i) => from + i);
    const a = Array.from(r.process(ramp(0, 8), 8, 1000, 2000));
    const b = Array.from(r.process(ramp(8, 8), 8, 1000, 2000));
    const joined = a.concat(b);
    for (let i = 1; i < joined.length; i++) {
        assert.ok(Math.abs(joined[i] - joined[i - 1] - 0.5) < 1e-5,
            `step of ${joined[i] - joined[i - 1]} at ${i}`);
    }
});

t('downsampling works too', () => {
    // Not a case the receiver produces today, but the rate comes from the mode
    // and nothing here decides what the modes are.
    const r = new Resampler(2);
    const out = r.process(new Float32Array(2 * 480), 480, 48000, 12000);
    assert.ok(Math.abs(out.length / 2 - 120) <= 2, `${out.length / 2} frames`);
});

// --- the wire format ---------------------------------------------------------

t('parseFrame splits a frame into commands', () => {
    assert.deepStrictEqual(parseFrame('audio_start:0;trx:0,true;ready;'), [
        { name: 'audio_start', args: ['0'] },
        { name: 'trx', args: ['0', 'true'] },
        { name: 'ready', args: [] },
    ]);
});

// --- the tuning range a client is told ---------------------------------------
//
// vfo_limits is the only thing this server tells a third-party app about how far the
// dial may go, and clients bound their own dial by it. It used to be a flat 0-60000000,
// which was wrong in both directions: on a stock 64.8 Msps receiver it invited a client
// to dial 50 MHz and hear silence, and the 0 low edge contradicted the 10 kHz every
// other client honours.

t('the greeting advertises the receiver\'s range, not a fixed one', () => {
    const { sent } = serverWithRange({ min_frequency: 10000, max_frequency: 60000000 });
    assert.ok(sent.includes('vfo_limits:10000,60000000;'), sent.join('|'));
});

t('a receiver that says nothing is advertised as 10 kHz - 30 MHz', () => {
    for (const range of [undefined, null, {}, { max_frequency: 0 },
                         { max_frequency: null }, { max_frequency: '60000000' }]) {
        const { sent } = serverWithRange(range);
        assert.ok(sent.includes('vfo_limits:10000,30000000;'), JSON.stringify(range));
    }
});

t('each edge of the range falls back on its own', () => {
    const { sent } = serverWithRange({ max_frequency: 60000000 });
    assert.ok(sent.includes('vfo_limits:10000,60000000;'), sent.join('|'));
    const b = serverWithRange({ min_frequency: 50000 });
    assert.ok(b.sent.includes('vfo_limits:50000,30000000;'), b.sent.join('|'));
});

t('an inverted range is refused rather than advertised backwards', () => {
    // A client handed vfo_limits:60000000,10000 has no sane way to read it.
    const { sent } = serverWithRange({ min_frequency: 60000000, max_frequency: 10000 });
    assert.ok(sent.includes('vfo_limits:10000,30000000;'), sent.join('|'));
    const d = serverWithRange({ min_frequency: 30000000, max_frequency: 30000000 });
    assert.ok(d.sent.includes('vfo_limits:10000,30000000;'), d.sent.join('|'));
});

t('setTuningRange reports whether anything moved', () => {
    const s = new TciServer({});
    assert.strictEqual(s.setTuningRange({ min_frequency: 10000, max_frequency: 30000000 }), false);
    assert.strictEqual(s.setTuningRange({ min_frequency: 10000, max_frequency: 60000000 }), true);
});

t('6 m is inside what a 60 MHz receiver advertises', () => {
    const { s } = serverWithRange({ min_frequency: 10000, max_frequency: 60000000 });
    const sixMetreFT8 = 50313000;
    assert.ok(sixMetreFT8 >= s.minFrequency && sixMetreFT8 <= s.maxFrequency);
});

process.on('exit', () => console.log(`\n${pass} passed`));
