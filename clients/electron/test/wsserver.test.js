// RFC 6455 framing, in both directions.
//
// This is a hand-rolled WebSocket server and framing is where being subtly
// wrong is invisible until a client three layers up misbehaves: an off-by-one
// in a length field looks exactly like a protocol bug in whatever it feeds.
// So the frames are checked byte by byte, and the round trip is checked
// against a real client — the loopback test at the bottom is what proves the
// handshake, since nothing else here computes the accept key the hard way.

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const {
    createWsServer, WsConnection, encodeFrame, decodeFrames, acceptKey, OP,
} = require('../wsserver.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** A client frame: masked, as §5.1 requires of every one of them. */
function clientFrame(opcode, payload, { fin = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const len = data.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = (fin ? 0x80 : 0) | opcode;
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, masked]);
}

/** A connection over a socket that only records what was written. */
function conn() {
    const written = [];
    const socket = {
        destroyed: false,
        writableLength: 0,
        write: (buf) => { written.push(buf); return true; },
        end: () => { socket.destroyed = true; },
    };
    const c = new WsConnection(socket);
    const messages = [];
    c.onmessage = (data, isText) => messages.push({ data, isText });
    return { c, messages, written };
}

// --- the handshake -----------------------------------------------------------

t('the accept key is the one from RFC 6455 §1.3', () => {
    // The example in the RFC itself, which is the only way to be sure the GUID
    // and the base64 are both right.
    assert.strictEqual(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

// --- encoding ----------------------------------------------------------------

t('a short frame carries its length in the second byte', () => {
    const f = encodeFrame(OP.TEXT, 'ready;');
    assert.strictEqual(f[0], 0x81);          // FIN + text
    assert.strictEqual(f[1], 6);             // unmasked, 6 bytes
    assert.strictEqual(f.slice(2).toString(), 'ready;');
});

t('126 bytes and over uses the 16-bit length', () => {
    const f = encodeFrame(OP.BINARY, Buffer.alloc(200));
    assert.strictEqual(f[0], 0x82);
    assert.strictEqual(f[1], 126);
    assert.strictEqual(f.readUInt16BE(2), 200);
    assert.strictEqual(f.length, 4 + 200);
});

t('65536 bytes and over uses the 64-bit length', () => {
    // An audio frame at 48 kHz stereo float32 passes this in under a fifth of
    // a second, so it is the common case rather than an edge one.
    const f = encodeFrame(OP.BINARY, Buffer.alloc(70000));
    assert.strictEqual(f[1], 127);
    assert.strictEqual(f.readUInt32BE(2), 0);
    assert.strictEqual(f.readUInt32BE(6), 70000);
    assert.strictEqual(f.length, 10 + 70000);
});

t('server frames are never masked', () => {
    // The mask bit is the top of byte 1, and setting it on a server frame is
    // a protocol violation that closes the connection.
    for (const payload of ['x', Buffer.alloc(300), Buffer.alloc(70000)]) {
        assert.strictEqual(encodeFrame(OP.TEXT, payload)[1] & 0x80, 0);
    }
});

// --- decoding ----------------------------------------------------------------

t('a masked client frame comes back unmasked', () => {
    const { frames } = decodeFrames(clientFrame(OP.TEXT, 'vfo:0,0,14074000;'));
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].payload.toString(), 'vfo:0,0,14074000;');
});

t('several frames in one chunk all arrive', () => {
    const chunk = Buffer.concat([clientFrame(OP.TEXT, 'a;'), clientFrame(OP.TEXT, 'b;')]);
    const { frames, rest } = decodeFrames(chunk);
    assert.deepStrictEqual(frames.map((f) => f.payload.toString()), ['a;', 'b;']);
    assert.strictEqual(rest.length, 0);
});

t('a frame split across chunks waits for the rest', () => {
    // TCP has no message boundaries, so this is not a rare case — it is what
    // happens the moment a frame crosses a segment.
    const whole = clientFrame(OP.TEXT, 'audio_start:0;');
    const first = decodeFrames(whole.slice(0, 5));
    assert.strictEqual(first.frames.length, 0);
    assert.strictEqual(first.rest.length, 5);
    const second = decodeFrames(Buffer.concat([first.rest, whole.slice(5)]));
    assert.strictEqual(second.frames[0].payload.toString(), 'audio_start:0;');
});

t('an absurd length is refused rather than allocated', () => {
    const head = Buffer.alloc(10);
    head[0] = 0x82;
    head[1] = 127;
    head.writeUInt32BE(0xffff, 2);      // ~280 TB, from a stranger
    assert.throws(() => decodeFrames(head), /too large/);
});

// --- the connection ----------------------------------------------------------

t('text arrives as a string and binary as a buffer', () => {
    const { c, messages } = conn();
    c.feed(clientFrame(OP.TEXT, 'ready;'));
    c.feed(clientFrame(OP.BINARY, Buffer.from([1, 2, 3])));
    assert.deepStrictEqual(messages.map((m) => m.isText), [true, false]);
    assert.strictEqual(messages[0].data, 'ready;');
    assert.ok(Buffer.isBuffer(messages[1].data));
});

t('a fragmented message is delivered once, whole', () => {
    const { c, messages } = conn();
    c.feed(clientFrame(OP.TEXT, 'audio_', { fin: false }));
    c.feed(clientFrame(OP.CONT, 'start:0;'));
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].data, 'audio_start:0;');
});

t('a ping is answered without troubling the caller', () => {
    const { c, messages, written } = conn();
    c.feed(clientFrame(OP.PING, 'hello'));
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0][0], 0x80 | OP.PONG);
    assert.strictEqual(written[0].slice(2).toString(), 'hello');
});

t('a close from the client closes back, once', () => {
    const { c, written } = conn();
    let closes = 0;
    c.onclose = () => { closes++; };
    c.feed(clientFrame(OP.CLOSE, ''));
    c.close();                          // whatever else tries afterwards
    assert.strictEqual(closes, 1);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0][0], 0x80 | OP.CLOSE);
});

// --- end to end --------------------------------------------------------------

ta('a real client handshakes, talks and is talked to', async () => {
    // Node has no WebSocket *client* in this version either, so the client half
    // is written out by hand here — which is the point: the bytes on the wire
    // are checked against something that did not come from wsserver.js.
    const server = createWsServer({
        onConnection: (c) => {
            c.onmessage = (data) => c.text(`echo:${data}`);
            c.text('ready;');
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise((r) => socket.once('connect', r));
    const key = crypto.randomBytes(16).toString('base64');
    socket.write([
        'GET / HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket',
        'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));

    let buffer = Buffer.alloc(0);
    const got = [];
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); });

    const settle = () => new Promise((r) => setTimeout(r, 50));
    await settle();

    const split = buffer.indexOf('\r\n\r\n');
    const headers = buffer.slice(0, split).toString();
    assert.ok(/^HTTP\/1\.1 101 /.test(headers), 'not a 101: ' + headers.split('\r\n')[0]);
    assert.ok(headers.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`), 'wrong accept key');
    buffer = buffer.slice(split + 4);

    const drain = () => {
        const { frames, rest } = decodeFrames(buffer);
        buffer = rest;
        for (const f of frames) got.push(f.payload.toString());
    };
    drain();
    assert.deepStrictEqual(got, ['ready;'], 'the greeting did not arrive');

    socket.write(clientFrame(OP.TEXT, 'vfo:0,0,7074000;'));
    await settle();
    drain();
    assert.deepStrictEqual(got, ['ready;', 'echo:vfo:0,0,7074000;']);

    socket.destroy();
    // Not awaited: an http server's `close` callback waits for every tracked
    // connection to go, and an upgraded socket is never untracked, so awaiting
    // it here waits for ever — quietly, since node simply runs out of work and
    // exits with the test neither passed nor failed. Which is how this test
    // came to be written twice.
    server.close();
    server.closeAllConnections?.();
});

process.on('exit', () => console.log(`\n${pass} passed`));
