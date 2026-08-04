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
    MODEM_TYPES, FX25_MODES, IL2P_MODES, MAX_CHANNELS, LIMITS, RCVR_PAIRS, CHANNEL_NAMES,
    SOUNDMODEM_CONFIG, SOUNDMODEM_FREQUENCIES, FRAME_FILTERS, FRAME_LIMITS,
    DEFAULT_FRAME_LIMIT, MAX_FRAMES,
    decodeFrame, attachParams, defaultChannel, anyChannelEnabled,
    matchesFilter, matchesSearch, looksLikeRealFrame, trimFrames,
} = require('./.build/soundmodem.cjs');
const { parseAX25: parse, pidName } = require('./.build/ax25.cjs');
const {
    MAX_AUDIO_HZ, LINE_MS, CHANNEL_COLOURS, rampR, rampG, rampB, buildBinMap, xOf, modemBandwidth,
} = require('./.build/smwaterfall.cjs');
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

t('the filters are v1\u2019s seven categories, with v1\u2019s type sets', () => {
    const aprs = row();
    const ui = row({ frameType: 'ui', isAPRS: false });
    const rr = row({ frameType: 'rr', isAPRS: false, info: '<RR R R5>', infoRaw: '' });
    const sabm = row({ frameType: 'sabm', isAPRS: false });
    const nodes = row({ frameType: 'nodes', isAPRS: false });
    const ip = row({ frameType: 'ip', isAPRS: false });

    assert.deepStrictEqual(FRAME_FILTERS.map((f) => f.id),
        ['all', 'aprs', 'ui', 'connected', 'netrom', 'control', 'ip']);

    assert.strictEqual(matchesFilter(aprs, 'aprs'), true);
    assert.strictEqual(matchesFilter(rr, 'aprs'), false);
    // APRS is a UI frame too, so filtering UI must not hide it.
    assert.strictEqual(matchesFilter(aprs, 'ui'), true);
    assert.strictEqual(matchesFilter(ui, 'ui'), true);
    assert.strictEqual(matchesFilter(rr, 'ui'), false);
    // "Connected" is the whole link-mode set, S-frames included; "S-frames" is
    // only the supervisory four.
    assert.strictEqual(matchesFilter(sabm, 'connected'), true);
    assert.strictEqual(matchesFilter(rr, 'connected'), true);
    assert.strictEqual(matchesFilter(rr, 'control'), true);
    assert.strictEqual(matchesFilter(sabm, 'control'), false);
    assert.strictEqual(matchesFilter(nodes, 'netrom'), true);
    assert.strictEqual(matchesFilter(ip, 'ip'), true);
    assert.strictEqual(matchesFilter(aprs, 'ip'), false);
    for (const f of FRAME_FILTERS) assert.strictEqual(typeof matchesFilter(aprs, f.id), 'boolean');
});

t('a noise burst that decoded into AX.25-shaped rubbish is dropped', () => {
    // A packet channel produces a steady trickle of these. v1 drops them rather
    // than filling the list with rows of punctuation.
    assert.strictEqual(looksLikeRealFrame(row()), true);
    assert.strictEqual(looksLikeRealFrame(row({ from: 'GB7RDG-2' })), true);
    assert.strictEqual(looksLikeRealFrame(row({ from: '\u00b6\u00a4?' })), false);
    assert.strictEqual(looksLikeRealFrame(row({ to: 'TOOLONGCALL' })), false);
    assert.strictEqual(looksLikeRealFrame(row({ from: '' })), false);
    assert.strictEqual(looksLikeRealFrame(null), false);
});

t('the retention limit is honoured, and unlimited is still bounded', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ key: i }));
    assert.strictEqual(trimFrames(many, 25).length, 25);
    assert.strictEqual(trimFrames(many, 0).length, MAX_FRAMES, 'a tab left open overnight');
    assert.strictEqual(trimFrames([{ key: 1 }], 25).length, 1);
    assert.ok(FRAME_LIMITS.includes(DEFAULT_FRAME_LIMIT));
    assert.deepStrictEqual(FRAME_LIMITS, [10, 25, 50, 100, 250, 500, 0]);
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
    // rcvr_pairs is a menu, not a range: 40 is not "clamp to 8", it is a value
    // that was never offered, so it falls back.
    assert.strictEqual(p.channels[0].rcvr_pairs, 0);
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

t('the starting configuration is v1\u2019s, which is an HF pair', () => {
    // A and B both on and both 300 baud — 850 Hz AFSK and 2150 Hz BPSK — which
    // is what the 7.049 MHz entry in the frequency menu wants. Running both is
    // the point: you do not know which the station is using.
    assert.deepStrictEqual(SOUNDMODEM_CONFIG.channels[0],
        { enabled: true, modem: 0, freq: 850, rcvr_pairs: 0, fx25: 1, il2p: 2 });
    assert.deepStrictEqual(SOUNDMODEM_CONFIG.channels[1],
        { enabled: true, modem: 6, freq: 2150, rcvr_pairs: 0, fx25: 1, il2p: 2 });
    // C and D are spare Bell 202 channels, off. 1700 Hz is the Bell 202 centre
    // — the tones sit at 1200 and 2200.
    assert.deepStrictEqual(SOUNDMODEM_CONFIG.channels[2], defaultChannel());
    assert.deepStrictEqual(SOUNDMODEM_CONFIG.channels[3], defaultChannel());
    assert.strictEqual(defaultChannel().freq, 1700);
    assert.strictEqual(defaultChannel().modem, 1);
    assert.strictEqual(SOUNDMODEM_CONFIG.dcd_threshold, 20);

    assert.strictEqual(anyChannelEnabled(SOUNDMODEM_CONFIG), true);
    assert.strictEqual(anyChannelEnabled({ channels: [defaultChannel(), defaultChannel()] }), false);
    assert.strictEqual(anyChannelEnabled({}), false);
});

t('the menus offer only values the wire format has', () => {
    // The modem index *is* the protocol, so the list order is not a display
    // choice and a gap in it would send the wrong modem.
    assert.deepStrictEqual(MODEM_TYPES.map((m) => m.value), Array.from({ length: 16 }, (_, i) => i));
    // Two, not the three the server documents: this is a receive-only site, so
    // FX.25 "RX+TX" is a mode it can never be in.
    assert.deepStrictEqual(FX25_MODES.map((m) => m.value), [0, 1]);
    assert.deepStrictEqual(IL2P_MODES.map((m) => m.value), [0, 1, 2, 3]);
    // Powers of two, as v1 offers them — the cost roughly doubles each step.
    assert.deepStrictEqual(RCVR_PAIRS.map((r) => r.value), [0, 1, 2, 4, 8]);
    for (const m of MODEM_TYPES) assert.ok(m.label, `${m.value} has no label`);
    // QtSoundModem names its channels by letter and so do the server's logs.
    assert.deepStrictEqual(CHANNEL_NAMES, ['A', 'B', 'C', 'D']);
    assert.strictEqual(CHANNEL_NAMES.length, MAX_CHANNELS);
});

t('the frequency menu says whether the receiver is on one', () => {
    assert.ok(tunedOption(SOUNDMODEM_FREQUENCIES, 7049450).label.includes('UK'));
    assert.strictEqual(tunedOption(SOUNDMODEM_FREQUENCIES, 14230000), null);
    const all = SOUNDMODEM_FREQUENCIES.flatMap((g) => g.options);
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
    for (const o of all) assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
});

// --- the waterfall ----------------------------------------------------------

t('the colour ramp runs black to red without a gap', () => {
    // v1's piecewise map, kept as it is. A discontinuity would draw a hard band
    // across the waterfall at whatever level it fell at, which reads as a
    // signal rather than as a bug.
    const at = (v) => [rampR(v), rampG(v), rampB(v)];
    assert.deepStrictEqual(at(0), [0, 0, 0], 'silence is black');
    // v1's ramp lands on (255, 3, 0) at full scale, not a pure red — the green
    // leg runs out three counts short. Kept as it is: this is the map v1 draws
    // and three counts of green is not visible.
    assert.deepStrictEqual(at(255), [255, 3, 0], 'full scale is red');
    for (let v = 0; v <= 255; v++) {
        for (const c of at(v)) {
            assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `level ${v} gave ${c}`);
        }
    }
    // Continuous across every segment boundary.
    for (const edge of [64, 128, 192]) {
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(at(edge)[i] - at(edge - 1)[i]) <= 6, `jump at ${edge}, channel ${i}`);
        }
    }
});

t('the bin map spans the display and never runs off the analyser', () => {
    // The display is 0..3300 Hz and the analyser 0..Nyquist, so a map that
    // over-ran would read past the end of the array and paint undefined.
    const map = buildBinMap(400, 1024, 48000);
    assert.strictEqual(map.length, 400);
    assert.strictEqual(map[0], 0);
    for (const b of map) assert.ok(b >= 0 && b < 1024);
    // Monotonic: the display is a frequency axis, so it cannot double back.
    for (let i = 1; i < map.length; i++) assert.ok(map[i] >= map[i - 1]);
    // The last column is the top of the drawn span, not the top of the FFT.
    const expected = Math.round((MAX_AUDIO_HZ * (399 / 400) / 24000) * 1024);
    assert.strictEqual(map[399], expected);
});

t('a marker off the display is not drawn at the edge', () => {
    // Pinning it to the edge would say a channel is listening somewhere it is
    // not. 4000 Hz is a legal modem frequency and past the drawn span.
    assert.strictEqual(xOf(0), 0);
    assert.strictEqual(xOf(MAX_AUDIO_HZ), 1);
    assert.strictEqual(xOf(4000), null);
    assert.strictEqual(xOf(-1), null);
    assert.strictEqual(xOf(NaN), null);
});

t('every channel has a marker colour, and the tick rate is v1\u2019s', () => {
    assert.strictEqual(CHANNEL_COLOURS.length, MAX_CHANNELS);
    assert.strictEqual(new Set(CHANNEL_COLOURS).size, MAX_CHANNELS);
    // 50 ms a line — twenty a second — so the scroll speed does not depend on
    // the animation frame rate.
    assert.strictEqual(LINE_MS, 50);
});

t('the marker bar is wider for a wider modem', () => {
    // A guide to where to put the signal, from the baud rate in the modem name.
    const afsk1200 = modemBandwidth('AFSK AX.25 1200bd (Bell 202)');
    const afsk300 = modemBandwidth('AFSK AX.25 300bd');
    const bpsk300 = modemBandwidth('BPSK AX.25 300bd');
    assert.ok(afsk1200 > afsk300, 'Bell 202 is far wider than its baud rate alone');
    assert.ok(afsk300 > bpsk300, 'AFSK carries the shift as well as the symbol rate');
    // Never zero or NaN, whatever the label says.
    assert.ok(modemBandwidth('ARDOP Packet') > 0);
    assert.ok(modemBandwidth(undefined) > 0);
});

console.log(`\n${pass} Sound Modem checks passed`);
