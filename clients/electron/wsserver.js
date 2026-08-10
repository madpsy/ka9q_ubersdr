'use strict';

// A WebSocket server, in about as little as RFC 6455 allows.
//
// Node has no WebSocket server and this client has no runtime dependencies, so
// standing one up means writing it. That is only worth doing because the server
// half is the easy half: the client picks the masking key and we merely undo
// it, and everything we send goes out unmasked.
//
// Scope is deliberate. This serves the TCI server (tciserver.js) and nothing
// else, so it speaks what that needs — text frames, binary frames, ping, pong,
// close, and continuation — and refuses anything larger than it should ever
// see rather than growing a buffer on a stranger's say-so. It is not a general
// WebSocket library and should not become one.

const crypto = require('crypto');
const http = require('http');

// The constant from RFC 6455 §1.3. Concatenated with the client's key and
// hashed, which is the whole of the handshake's proof.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// Nothing a TCI client sends is large — the biggest is a command line. A frame
// claiming more than this is either broken or hostile, and either way the
// connection is not worth keeping.
const MAX_FRAME = 1 << 20;      // 1 MiB

/** The `Sec-WebSocket-Accept` for a client's key. */
function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * One frame, encoded.
 *
 * Server frames are never masked (RFC 6455 §5.1), which is why there is no
 * masking here to get wrong.
 */
function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        // The high 32 bits stay zero: a payload above 4 GiB is not something
        // this sends, and writing a BigInt for it would be pretending otherwise.
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;      // FIN, then the opcode
    return Buffer.concat([header, data]);
}

/**
 * Frames out of a buffer, as many as are complete.
 *
 * Returns `{ frames, rest }` — `rest` is what has not arrived in full yet and
 * must be kept for next time. A frame is `{ fin, opcode, payload }`, already
 * unmasked.
 *
 * Exported for its own test: framing is the part where being subtly wrong looks
 * like a protocol bug three layers up.
 */
function decodeFrames(buffer) {
    const frames = [];
    let at = 0;
    for (;;) {
        if (buffer.length - at < 2) break;
        const first = buffer[at];
        const second = buffer[at + 1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let len = second & 0x7f;
        let offset = at + 2;

        if (len === 126) {
            if (buffer.length < offset + 2) break;
            len = buffer.readUInt16BE(offset);
            offset += 2;
        } else if (len === 127) {
            if (buffer.length < offset + 8) break;
            const high = buffer.readUInt32BE(offset);
            const low = buffer.readUInt32BE(offset + 4);
            // Anything needing the high word is past MAX_FRAME anyway.
            len = high > 0 ? Number.MAX_SAFE_INTEGER : low;
            offset += 8;
        }
        if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes is too large`);

        let mask = null;
        if (masked) {
            if (buffer.length < offset + 4) break;
            mask = buffer.slice(offset, offset + 4);
            offset += 4;
        }
        if (buffer.length < offset + len) break;

        const payload = Buffer.from(buffer.slice(offset, offset + len));
        // Every client frame is masked (§5.1); undoing it is a byte-wise XOR
        // with the four-byte key, repeating.
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

        frames.push({ fin, opcode, payload });
        at = offset + len;
    }
    return { frames, rest: buffer.slice(at) };
}

/**
 * A connected client.
 *
 * Text is delivered as a string and binary as a Buffer; fragmented messages are
 * reassembled before either. Control frames are answered here — a ping gets its
 * pong without the caller hearing about it.
 */
class WsConnection {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOp = null;
        this.closed = false;
        this.onmessage = null;
        this.onclose = null;
    }

    feed(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let decoded;
        try {
            decoded = decodeFrames(this.buffer);
        } catch (err) {
            this.close(1009, 'frame too large');
            return;
        }
        this.buffer = decoded.rest;
        for (const frame of decoded.frames) this.handle(frame);
    }

    handle({ fin, opcode, payload }) {
        if (opcode === OP.CLOSE) { this.close(1000, ''); return; }
        if (opcode === OP.PING) { this.send(OP.PONG, payload); return; }
        if (opcode === OP.PONG) return;

        if (opcode === OP.CONT) {
            if (this.fragmentOp === null) return;    // a continuation of nothing
            this.fragments.push(payload);
        } else {
            this.fragmentOp = opcode;
            this.fragments = [payload];
        }
        if (!fin) return;

        const op = this.fragmentOp;
        const body = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOp = null;
        if (!this.onmessage) return;
        this.onmessage(op === OP.TEXT ? body.toString('utf8') : body, op === OP.TEXT);
    }

    send(opcode, payload) {
        if (this.closed || this.socket.destroyed) return false;
        // `write` returning false means the kernel buffer is full. For audio
        // that is a client which cannot keep up, and the caller decides what to
        // do about it — see tciserver.js.
        return this.socket.write(encodeFrame(opcode, payload));
    }

    text(s) { return this.send(OP.TEXT, s); }

    binary(buf) { return this.send(OP.BINARY, buf); }

    close(code = 1000, reason = '') {
        if (this.closed) return;
        this.closed = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try {
            this.socket.write(encodeFrame(OP.CLOSE, body));
            this.socket.end();
        } catch (e) { /* already gone */ }
        if (this.onclose) this.onclose();
    }
}

/**
 * Listens, and calls `onConnection` with a WsConnection for each client.
 *
 * Anything that is not a WebSocket upgrade gets a flat refusal rather than a
 * page: this exists to be connected to by one kind of program.
 */
function createWsServer({ onConnection }) {
    const server = http.createServer((req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('this port speaks WebSocket only');
    });

    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(key)}`,
            '', '',
        ].join('\r\n'));
        // Audio frames are small and continuous; Nagle would batch them into
        // latency for no gain on a local socket.
        socket.setNoDelay(true);

        const conn = new WsConnection(socket);
        socket.on('data', (chunk) => conn.feed(chunk));
        socket.on('error', () => conn.close(1011, 'socket error'));
        socket.on('close', () => {
            if (conn.closed) return;
            conn.closed = true;
            if (conn.onclose) conn.onclose();
        });
        onConnection(conn);
    });

    return server;
}

module.exports = { createWsServer, WsConnection, encodeFrame, decodeFrames, acceptKey, OP };
