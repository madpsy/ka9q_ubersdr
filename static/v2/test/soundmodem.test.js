// Sound Modem: the wire protocol, the modem settings, and the AX.25 decoder.
//
// The AX.25 half is v1's decoder ported verbatim, so these checks are less
// about finding new bugs in it than about pinning what "verbatim" means: if the
// port dropped a line or the module conversion changed a closure, a frame still
// decodes and just comes out wrong — the wrong callsign, a missing digipeater,
// an SSID off by one. Every one of those looks like a plausible packet.

const assert = require('assert');

const {
    FRAME_PACKET, FRAME_ERROR, FRAME_KISS, FRAME_DCD, FRAME_MONITOR, FRAME_LOG,
    MODEM_TYPES, FX25_MODES, IL2P_MODES, MAX_CHANNELS, LIMITS,
    SOUNDMODEM_CONFIG, SOUNDMODEM_FREQUENCIES, FRAME_FILTERS,
    decodeFrame, attachParams, defaultChannel, anyChannelEnabled,
    matchesFilter, matchesSearch,
} = require('./.build/soundmodem.cjs');
const { parseAX25: parse, pidName } = require('./.build/ax25.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const decode = (b) => decodeFrame(asArrayBuffer(b));

// An AX.25 address field: six shifted characters, then the SSID byte carrying
// the H bit and the end-of-address bit.
function addr(call, ssid = 0, hBit = false, last = false) {
    const out = [];
    const padded = `${call}      `.slice(0, 6);
    for (const ch of padded) out.push(ch.charCodeAt(0) << 1);
    out.push((hBit ? 0x80 : 0) | (ssid << 1) | 0x60 | (last ? 1 : 0));
    return out;
}

function packetFrame(bytes, port = 0) {
    const b = Buffer.alloc(6 + bytes.length);
    b[0] = FRAME_PACKET;
    b[1] = port;
    b.writeUInt32BE(bytes.length, 2);
    Buffer.from(bytes).copy(b, 6);
    return b;
}

// --- the wire protocol ------------------------------------------------------

t('a packet frame carries its channel and its AX.25 bytes', () => {
    const f = decode(packetFrame([1, 2, 3, 4], 2));
    assert.strictEqual(f.kind, 'packet');
    assert.strictEqual(f.port, 2);
    assert.deepStrictEqual(Array.from(f.bytes), [1, 2, 3, 4]);
});

t('packet bytes are copied, not a view onto the socket buffer', () => {
    // A frame stays on screen for as long as the list holds it; a view would be
    // overwritten by the next packet, which on a busy channel is milliseconds.
    const b = packetFrame([9, 9, 9]);
    const f = decode(b);
    b[6] = 0;
    assert.deepStrictEqual(Array.from(f.bytes), [9, 9, 9]);
});

t('DCD, monitor, log and error read where the server put them', () => {
    assert.deepStrictEqual(decode(Buffer.from([FRAME_DCD, 1, 1])), { kind: 'dcd', channel: 1, on: true });
    assert.deepStrictEqual(decode(Buffer.from([FRAME_DCD, 3, 0])), { kind: 'dcd', channel: 3, on: false });

    const mon = Buffer.alloc(7 + 2);
    mon[0] = FRAME_MONITOR;
    mon[1] = 2;
    mon[2] = 1;
    mon.writeUInt32BE(2, 3);
    Buffer.from('hi').copy(mon, 7);
    assert.deepStrictEqual(decode(mon), { kind: 'monitor', channel: 2, isTx: true, text: 'hi' });

    const err = Buffer.alloc(5 + 4);
    err[0] = FRAME_ERROR;
    err.writeUInt32BE(4, 1);
    Buffer.from('boom').copy(err, 5);
    assert.deepStrictEqual(decode(err), { kind: 'error', text: 'boom' });

    const log = Buffer.alloc(5 + 3);
    log[0] = FRAME_LOG;
    log.writeUInt32BE(3, 1);
    Buffer.from('abc').copy(log, 5);
    assert.deepStrictEqual(decode(log), { kind: 'log', text: 'abc' });
});

t('a raw KISS frame is a type of its own', () => {
    // The panel does not ask for these, but a server told to send them by an
    // earlier attach must not have them mistaken for AX.25.
    const b = Buffer.alloc(5 + 3);
    b[0] = FRAME_KISS;
    b.writeUInt32BE(3, 1);
    Buffer.from([0xC0, 0x00, 0xC0]).copy(b, 5);
    assert.strictEqual(decode(b).kind, 'kiss');
});

t('a truncated or unknown frame is dropped, not thrown on', () => {
    assert.strictEqual(decode(Buffer.from([FRAME_PACKET, 0, 0])), null);
    assert.strictEqual(decode(Buffer.from([FRAME_DCD, 1])), null);
    assert.strictEqual(decode(Buffer.from([0x7f, 1])), null);
    assert.strictEqual(decode(Buffer.alloc(0)), null);
    assert.strictEqual(decodeFrame(null), null);
    // A declared length past the end of the frame.
    const liar = packetFrame([1, 2, 3]);
    liar.writeUInt32BE(900, 2);
    assert.strictEqual(decode(liar), null);
});

// --- AX.25 ------------------------------------------------------------------

t('a UI frame decodes to its path, its type and its text', () => {
    // G0ABC-1 > APRS via WIDE1-1, PID F0. This is the shape of nearly all APRS.
    const bytes = Uint8Array.from([].concat(
        addr('APRS', 0, true, false),
        addr('G0ABC', 1, false, false),
        addr('WIDE1', 1, false, true),
        [0x03, 0xF0],
        Array.from('!5132.07N/00007.72W-').map((c) => c.charCodeAt(0)),
    ));
    const f = parse(bytes);
    assert.strictEqual(f.from, 'G0ABC-1');
    assert.strictEqual(f.to, 'APRS');
    assert.deepStrictEqual(f.digipeaters, ['WIDE1-1']);
    assert.strictEqual(f.frameType, 'aprs');
    assert.strictEqual(f.isAPRS, true);
    assert.strictEqual(f.frameClass, 'U');
    assert.strictEqual(f.pid, 0xF0);
    assert.strictEqual(f.infoRaw, '!5132.07N/00007.72W-');
});

t('an SSID of zero is not written out, and one above it is', () => {
    // "GB7RDG" and "GB7RDG-2" are different stations, and the SSID is packed
    // four bits up inside the address byte — the easiest thing to shift wrong.
    const mk = (ssid) => parse(Uint8Array.from([].concat(
        addr('APRS'), addr('GB7RDG', ssid, false, true), [0x03, 0xF0, 65],
    )));
    assert.strictEqual(mk(0).from, 'GB7RDG');
    assert.strictEqual(mk(2).from, 'GB7RDG-2');
    assert.strictEqual(mk(15).from, 'GB7RDG-15');
});

t('a digipeater that repeated the frame is starred', () => {
    // The H bit says a digi actioned it. Without the star you cannot tell a
    // path that was used from one that was merely requested.
    const bytes = Uint8Array.from([].concat(
        addr('APRS'), addr('M0XYZ', 0),
        addr('GB7RDG', 2, true, false),
        addr('WIDE2', 1, false, true),
        [0x03, 0xF0, 65],
    ));
    const f = parse(bytes);
    assert.deepStrictEqual(f.digipeaters, ['GB7RDG-2*', 'WIDE2-1']);
});

t('a frame with no digipeaters has none, not an empty one', () => {
    const bytes = Uint8Array.from([].concat(
        addr('APRS'), addr('M0XYZ', 0, false, true), [0x03, 0xF0, 65],
    ));
    assert.deepStrictEqual(parse(bytes).digipeaters, []);
});

t('I- and S-frames keep their sequence numbers', () => {
    // N(S) and N(R) sit in different halves of the control byte. Swapping them
    // yields a frame that still decodes and reports the wrong window.
    const iFrame = Uint8Array.from([].concat(
        addr('GB7RDG', 2, true, false), addr('M0XYZ', 0, false, true),
        [(3 << 5) | (2 << 1), 0xF0], Array.from('hi').map((c) => c.charCodeAt(0)),
    ));
    const i = parse(iFrame);
    assert.strictEqual(i.frameClass, 'I');
    assert.strictEqual(i.ns, 2);
    assert.strictEqual(i.nr, 3);

    const rr = parse(Uint8Array.from([].concat(
        addr('GB7RDG', 2, true, false), addr('M0XYZ', 0, false, true), [(5 << 5) | 0x01],
    )));
    assert.strictEqual(rr.frameClass, 'S');
    assert.strictEqual(rr.frameType, 'rr');
    assert.strictEqual(rr.nr, 5);
});

t('the link-control frames are named', () => {
    const u = (ctrl) => parse(Uint8Array.from([].concat(
        addr('GB7RDG', 2, true, false), addr('M0XYZ', 0, false, true), [ctrl],
    ))).frameType;
    assert.strictEqual(u(0x2F), 'sabm');
    assert.strictEqual(u(0x43), 'disc');
    assert.strictEqual(u(0x63), 'ua');
    assert.strictEqual(u(0x0F), 'dm');
    assert.strictEqual(u(0x6F), 'sabme');
});

t('command and response are told apart by the two H bits', () => {
    // AX.25 v2.2 encodes the direction across both address fields; v1 set
    // neither, and the decoder has to say "unknown" rather than guess.
    const mk = (dh, sh) => parse(Uint8Array.from([].concat(
        addr('APRS', 0, dh, false), addr('M0XYZ', 0, sh, true), [0x03, 0xF0, 65],
    ))).isCommand;
    assert.strictEqual(mk(true, false), true);
    assert.strictEqual(mk(false, true), false);
    assert.strictEqual(mk(false, false), null);
});

t('a frame too short or too damaged to read yields null', () => {
    // A packet channel delivers plenty of these and none is worth an exception.
    assert.strictEqual(parse(new Uint8Array(4)), null);
    assert.strictEqual(parse(new Uint8Array(0)), null);
});

t('the PID names survived the port', () => {
    assert.strictEqual(pidName(0xF0), 'No layer 3');
    assert.strictEqual(typeof pidName(0xCF), 'string');
    assert.strictEqual(typeof pidName(0xCC), 'string');
});

// --- filtering --------------------------------------------------------------

const row = (over) => ({
    from: 'G0ABC-1', to: 'APRS', digipeaters: ['GB7RDG-2*'],
    frameType: 'aprs', isAPRS: true, info: '<UI C> !test', infoRaw: '!test', ...over,
});

t('the filters split traffic from link housekeeping', () => {
    const aprs = row();
    const rr = row({ frameType: 'rr', isAPRS: false, info: '<RR R R5>', infoRaw: '' });
    assert.strictEqual(matchesFilter(aprs, 'aprs'), true);
    assert.strictEqual(matchesFilter(rr, 'aprs'), false);
    assert.strictEqual(matchesFilter(aprs, 'data'), true);
    assert.strictEqual(matchesFilter(rr, 'data'), false);
    assert.strictEqual(matchesFilter(rr, 'link'), true);
    assert.strictEqual(matchesFilter(aprs, 'link'), false);
    assert.strictEqual(matchesFilter(rr, 'all'), true);
    // Every filter the menu offers is one the matcher knows.
    for (const f of FRAME_FILTERS) assert.strictEqual(typeof matchesFilter(aprs, f.id), 'boolean');
});

t('search reaches the digipeater path, not only the endpoints', () => {
    // "GB7" should find frames that went *through* a node as well as frames
    // from it, which is usually the question being asked of a channel.
    assert.strictEqual(matchesSearch(row(), 'gb7'), true);
    assert.strictEqual(matchesSearch(row(), 'g0abc'), true);
    assert.strictEqual(matchesSearch(row(), 'aprs'), true);
    assert.strictEqual(matchesSearch(row(), '!test'), true);
    assert.strictEqual(matchesSearch(row(), 'nothing'), false);
    assert.strictEqual(matchesSearch(row(), '   '), true, 'an empty search hides nothing');
});

// --- settings ---------------------------------------------------------------

t('the attach carries the field names the server reads', () => {
    const p = attachParams(SOUNDMODEM_CONFIG);
    assert.deepStrictEqual(Object.keys(p).sort(), ['channels', 'dcd_threshold', 'output_mode']);
    // "kiss" is for piping into direwolf over a TCP port, not for a web page
    // that decodes AX.25 itself.
    assert.strictEqual(p.output_mode, 'ax25');
    assert.deepStrictEqual(Object.keys(p.channels[0]).sort(), [
        'enabled', 'freq', 'fx25', 'il2p', 'modem', 'rcvr_pairs',
    ]);
});

t('a setting the server would refuse is clamped or falls back', () => {
    const p = attachParams({
        dcd_threshold: 5000,
        channels: [{ enabled: true, modem: 99, freq: 1, rcvr_pairs: 40, fx25: 9, il2p: 9 }],
    });
    assert.strictEqual(p.dcd_threshold, LIMITS.dcd_threshold.max);
    assert.strictEqual(p.channels[0].freq, LIMITS.freq.min);
    assert.strictEqual(p.channels[0].rcvr_pairs, 8);
    // The enums are indexes into QtSoundModem's own tables — an unknown one
    // falls back rather than clamping to whatever is at the end of the list.
    assert.strictEqual(p.channels[0].modem, 1);
    assert.strictEqual(p.channels[0].fx25, 1);
    assert.strictEqual(p.channels[0].il2p, 0);
});

t('no more channels are sent than the server accepts', () => {
    const many = { channels: Array.from({ length: 9 }, () => defaultChannel(true)) };
    assert.strictEqual(attachParams(many).channels.length, MAX_CHANNELS);
});

t('the modem starts with a channel on, and knows when it has none', () => {
    // A modem with nothing enabled decodes nothing, and a panel that starts in
    // that state looks broken.
    assert.strictEqual(anyChannelEnabled(SOUNDMODEM_CONFIG), true);
    assert.strictEqual(SOUNDMODEM_CONFIG.channels[0].enabled, true);
    assert.strictEqual(anyChannelEnabled({ channels: [defaultChannel(), defaultChannel()] }), false);
    assert.strictEqual(anyChannelEnabled({}), false);
    // 1700 Hz is the Bell 202 centre — the tones sit at 1200 and 2200.
    assert.strictEqual(defaultChannel().freq, 1700);
    assert.strictEqual(defaultChannel().modem, 1);
});

t('the menus offer only values the wire format has', () => {
    // The modem index *is* the protocol, so the list order is not a display
    // choice and a gap in it would send the wrong modem.
    assert.deepStrictEqual(MODEM_TYPES.map((m) => m.value), Array.from({ length: 16 }, (_, i) => i));
    assert.deepStrictEqual(FX25_MODES.map((m) => m.value), [0, 1, 2]);
    assert.deepStrictEqual(IL2P_MODES.map((m) => m.value), [0, 1, 2, 3]);
    for (const m of MODEM_TYPES) assert.ok(m.label, `${m.value} has no label`);
});

t('the frequency menu says whether the receiver is on one', () => {
    assert.ok(tunedOption(SOUNDMODEM_FREQUENCIES, 7049450).label.includes('UK'));
    assert.strictEqual(tunedOption(SOUNDMODEM_FREQUENCIES, 14230000), null);
    const all = SOUNDMODEM_FREQUENCIES.flatMap((g) => g.options);
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
    for (const o of all) assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
});

console.log(`\n${pass} Sound Modem checks passed`);
