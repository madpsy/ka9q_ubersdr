'use strict';

// Minimal mDNS-SD browser for _ubersdr._tcp.local, with no dependencies.
//
// The query is a "legacy unicast" one (RFC 6762 §6.7): the socket is bound to
// an ephemeral port rather than 5353, so responders address their replies
// directly back to it. That sidesteps having to join the multicast group and
// share port 5353 with whatever mDNS stack (Avahi, Bonjour) already owns it.
//
// IPv4 only, deliberately — same call the TUI client makes: a LAN receiver
// reachable only by link-local IPv6 needs a zone id the client would have to
// guess, so an instance advertising nothing but AAAA is skipped rather than
// listed unreachable.

const dgram = require('dgram');
const os = require('os');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_ubersdr._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

function encodeName(name) {
    const parts = name.replace(/\.$/, '').split('.');
    const out = [];
    for (const part of parts) {
        const bytes = Buffer.from(part, 'utf8');
        out.push(Buffer.from([bytes.length]), bytes);
    }
    out.push(Buffer.from([0]));
    return Buffer.concat(out);
}

function buildQuery(questions) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(questions.length, 4); // QDCOUNT; id 0 and flags 0 per mDNS
    const encoded = questions.map(([name, type]) => {
        const tail = Buffer.alloc(4);
        tail.writeUInt16BE(type, 0);
        tail.writeUInt16BE(1, 2); // class IN
        return Buffer.concat([encodeName(name), tail]);
    });
    return Buffer.concat([header, ...encoded]);
}

// Reads a possibly-compressed DNS name. Returns the dotted name and the
// offset just past it in the original (unjumped) byte stream.
function readName(buf, off) {
    const labels = [];
    let next = -1;
    let jumps = 0;
    for (;;) {
        if (off >= buf.length) throw new Error('truncated name');
        const len = buf[off];
        if (len === 0) {
            if (next < 0) next = off + 1;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            if (off + 1 >= buf.length) throw new Error('truncated pointer');
            if (next < 0) next = off + 2;
            if (++jumps > 32) throw new Error('compression loop');
            off = ((len & 0x3f) << 8) | buf[off + 1];
            continue;
        }
        if (off + 1 + len > buf.length) throw new Error('truncated label');
        labels.push(buf.toString('utf8', off + 1, off + 1 + len));
        off += 1 + len;
    }
    return { name: labels.join('.'), next };
}

// Flattens answers + authority + additionals into one record list; a parse
// error keeps whatever was read before it rather than dropping the packet.
function parseRecords(buf) {
    if (buf.length < 12) return [];
    const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)];
    const records = [];
    let off = 12;
    try {
        for (let i = 0; i < counts[0]; i++) off = readName(buf, off).next + 4; // skip questions
        for (let i = 0; i < counts[1]; i++) {
            const { name, next } = readName(buf, off);
            off = next;
            const type = buf.readUInt16BE(off);
            const rdlen = buf.readUInt16BE(off + 8);
            const rdoff = off + 10;
            off = rdoff + rdlen;
            if (off > buf.length) break;
            const rec = { name: name.toLowerCase(), type };
            if (type === TYPE_PTR) {
                rec.ptr = readName(buf, rdoff);
            } else if (type === TYPE_SRV && rdlen >= 7) {
                rec.port = buf.readUInt16BE(rdoff + 4);
                rec.target = readName(buf, rdoff + 6).name.toLowerCase();
            } else if (type === TYPE_A && rdlen === 4) {
                rec.address = `${buf[rdoff]}.${buf[rdoff + 1]}.${buf[rdoff + 2]}.${buf[rdoff + 3]}`;
            } else if (type === TYPE_TXT) {
                rec.txt = {};
                let p = rdoff;
                while (p < rdoff + rdlen) {
                    const slen = buf[p];
                    const s = buf.toString('utf8', p + 1, p + 1 + slen);
                    const eq = s.indexOf('=');
                    if (eq > 0) rec.txt[s.slice(0, eq)] = s.slice(eq + 1);
                    p += 1 + slen;
                }
            }
            records.push(rec);
        }
    } catch { /* keep partial */ }
    return records;
}

/**
 * One-shot browse: query, collect for timeoutMs, resolve with what answered.
 * @returns {Promise<Array<{name: string, host: string, port: number, txt: object}>>}
 */
function browse({ timeoutMs = 3000 } = {}) {
    return new Promise((resolve) => {
        // instance name (lowercased) -> state
        const ptrs = new Map();  // lowercased instance -> display name
        const srvs = new Map();  // lowercased instance -> {port, target}
        const txts = new Map();  // lowercased instance -> txt map
        const addrs = new Map(); // lowercased hostname -> IPv4
        const asked = new Set();

        const sockets = [];
        const send = (questions) => {
            if (!questions.length) return;
            const pkt = buildQuery(questions);
            for (const sock of sockets) {
                try { sock.send(pkt, MDNS_PORT, MDNS_ADDR); } catch { /* iface gone */ }
            }
        };

        const onMessage = (msg) => {
            for (const rec of parseRecords(msg)) {
                if (rec.type === TYPE_PTR && rec.name === SERVICE && rec.ptr) {
                    const key = rec.ptr.name.toLowerCase();
                    if (!ptrs.has(key)) {
                        // display name = the instance label, e.g. "UberSDR on host"
                        ptrs.set(key, rec.ptr.name.split('.')[0]);
                    }
                } else if (rec.type === TYPE_SRV && rec.target) {
                    srvs.set(rec.name, { port: rec.port, target: rec.target });
                } else if (rec.type === TYPE_TXT && rec.txt) {
                    txts.set(rec.name, rec.txt);
                } else if (rec.type === TYPE_A && rec.address) {
                    addrs.set(rec.name, rec.address);
                }
            }
            // Avahi normally packs SRV/TXT/A into the additionals of the PTR
            // response; when a responder doesn't, chase the gaps explicitly.
            const followUps = [];
            for (const key of ptrs.keys()) {
                if (!srvs.has(key) && !asked.has(key)) {
                    asked.add(key);
                    followUps.push([key, TYPE_SRV], [key, TYPE_TXT]);
                }
                const srv = srvs.get(key);
                if (srv && !addrs.has(srv.target) && !asked.has(srv.target)) {
                    asked.add(srv.target);
                    followUps.push([srv.target, TYPE_A]);
                }
            }
            send(followUps);
        };

        // One socket per external IPv4 interface so the query reaches every LAN.
        const ifaceAddrs = [];
        for (const list of Object.values(os.networkInterfaces())) {
            for (const addr of list || []) {
                if (addr.family === 'IPv4' && !addr.internal) ifaceAddrs.push(addr.address);
            }
        }
        if (!ifaceAddrs.length) ifaceAddrs.push(null); // fall back to the default route

        let pending = ifaceAddrs.length;
        const ready = () => {
            if (--pending > 0) return;
            if (!sockets.length) return finish();
            send([[SERVICE, TYPE_PTR]]);
            setTimeout(() => send([[SERVICE, TYPE_PTR]]), 1000); // one repeat, per RFC
            setTimeout(finish, timeoutMs);
        };

        for (const addr of ifaceAddrs) {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            // bind failure surfaces as 'error' without the callback ever
            // firing; count each socket exactly once either way.
            let counted = false;
            const countOnce = () => { if (!counted) { counted = true; ready(); } };
            sock.on('message', onMessage);
            sock.on('error', countOnce);
            sock.bind(0, addr || undefined, () => {
                try { if (addr) sock.setMulticastInterface(addr); } catch { /* best effort */ }
                sockets.push(sock);
                countOnce();
            });
        }

        let done = false;
        function finish() {
            if (done) return;
            done = true;
            for (const sock of sockets) {
                try { sock.close(); } catch { /* already closed */ }
            }
            const out = [];
            for (const [key, display] of ptrs) {
                const srv = srvs.get(key);
                if (!srv || !srv.port) continue;
                // Prefer the A record; fall back to the advertised hostname and
                // let the OS resolver (which may itself speak mDNS) try it.
                const host = addrs.get(srv.target) || srv.target.replace(/\.$/, '');
                out.push({ name: display, host, port: srv.port, txt: txts.get(key) || {} });
            }
            resolve(out);
        }
    });
}

module.exports = { browse };
