// Sound Modem: the wire frames, and the modem configuration behind them.
//
// Unlike every other decoder here, this one is not DSP the server wrote. The
// server runs a QtSoundModem subprocess per session and relays what comes out
// of its KISS and AGW ports — so the settings are that program's settings, and
// the results are AX.25 frames rather than anything already interpreted. The
// frames are decoded in the browser (see ./ax25.js).
//
// Six message types, defined in audio_extensions/soundmodem/extension.go:
//
//     0x20  packet   [type:1][kiss_port:1][len:4][ax25 bytes]
//     0x21  error    [type:1][len:4][utf-8]
//     0x22  kiss     [type:1][len:4][raw KISS frame, 0xC0 delimited]
//     0x23  dcd      [type:1][channel:1][on:1]
//     0x24  monitor  [type:1][channel:1][is_tx:1][len:4][utf-8]
//     0x25  log      [type:1][len:4][utf-8]        QtSoundModem's own stderr
//
// The error type is worth calling out: it is how the server reports that
// QtSoundModem is not installed, or that its subprocess died. That is not a
// decode failure the panel can shrug off — it means nothing will ever arrive —
// so it is shown as an error rather than logged and dropped.

export const FRAME_PACKET = 0x20;
export const FRAME_ERROR = 0x21;
export const FRAME_KISS = 0x22;
export const FRAME_DCD = 0x23;
export const FRAME_MONITOR = 0x24;
export const FRAME_LOG = 0x25;

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame, or null.
 *
 * Packet bytes are *copied* rather than returned as a view, unlike the other
 * decoders here: an AX.25 frame is kept in the list for as long as it is on
 * screen, and a view onto a socket buffer would be overwritten by the next
 * packet — which on a busy channel is milliseconds away.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 1) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const text = (from, len) => (utf8 ? utf8.decode(b.subarray(from, from + len)) : '');

    switch (b[0]) {
        case FRAME_PACKET: {
            if (b.length < 6) return null;
            const len = view.getUint32(2);
            if (len === 0 || len > b.length - 6) return null;
            return { kind: 'packet', port: b[1], bytes: b.slice(6, 6 + len) };
        }

        case FRAME_KISS: {
            if (b.length < 5) return null;
            const len = view.getUint32(1);
            if (len === 0 || len > b.length - 5) return null;
            return { kind: 'kiss', bytes: b.slice(5, 5 + len) };
        }

        case FRAME_ERROR: {
            if (b.length < 5) return null;
            const len = view.getUint32(1);
            if (len > b.length - 5) return null;
            return { kind: 'error', text: text(5, len) };
        }

        case FRAME_DCD:
            if (b.length < 3) return null;
            return { kind: 'dcd', channel: b[1], on: b[2] !== 0 };

        case FRAME_MONITOR: {
            if (b.length < 7) return null;
            const len = view.getUint32(3);
            if (len > b.length - 7) return null;
            return { kind: 'monitor', channel: b[1], isTx: b[2] !== 0, text: text(7, len) };
        }

        case FRAME_LOG: {
            if (b.length < 5) return null;
            const len = view.getUint32(1);
            if (len > b.length - 5) return null;
            return { kind: 'log', text: text(5, len) };
        }

        default:
            return null;
    }
}

// ── the modem's settings ────────────────────────────────────────────────────

// QtSoundModem's modem types, as the server enumerates them in register.go.
// The index is what goes on the wire, so this list's order is the protocol and
// not a display choice.
export const MODEM_TYPES = [
    { value: 0, label: 'AFSK AX.25 300bd' },
    { value: 1, label: 'AFSK AX.25 1200bd (Bell 202)' },
    { value: 2, label: 'AFSK AX.25 600bd' },
    { value: 3, label: 'AFSK AX.25 2400bd' },
    { value: 4, label: 'BPSK AX.25 1200bd' },
    { value: 5, label: 'BPSK AX.25 600bd' },
    { value: 6, label: 'BPSK AX.25 300bd' },
    { value: 7, label: 'BPSK AX.25 2400bd' },
    { value: 8, label: 'QPSK AX.25 4800bd' },
    { value: 9, label: 'QPSK AX.25 3600bd' },
    { value: 10, label: 'QPSK AX.25 2400bd' },
    { value: 11, label: 'BPSK FEC 4×100bd' },
    { value: 12, label: 'DW QPSK V26A 2400bd' },
    { value: 13, label: 'DW 8PSK V27 4800bd' },
    { value: 14, label: 'DW QPSK V26B 2400bd' },
    { value: 15, label: 'ARDOP Packet' },
];

export const FX25_MODES = [
    { value: 0, label: 'Off' },
    { value: 1, label: 'RX' },
    { value: 2, label: 'RX+TX' },
];

export const IL2P_MODES = [
    { value: 0, label: 'Off' },
    { value: 1, label: 'IL2P' },
    { value: 2, label: 'IL2P+CRC' },
    { value: 3, label: 'Both' },
];

export const MAX_CHANNELS = 4;

export const LIMITS = {
    freq: { min: 100, max: 4000, step: 10 },
    dcd_threshold: { min: 1, max: 100, step: 1 },
};

// One channel, at the defaults the server documents. 1700 Hz is the Bell 202
// centre — the tone pair sits at 1200 and 2200 — and is what a VHF packet
// channel expects.
export function defaultChannel(enabled = false) {
    return { enabled, modem: 1, freq: 1700, rcvr_pairs: 0, fx25: 1, il2p: 0 };
}

export const SOUNDMODEM_CONFIG = {
    dcd_threshold: 20,
    // The first channel on, the rest off: a modem with nothing enabled decodes
    // nothing, and a panel that starts in that state looks broken.
    channels: [defaultChannel(true), defaultChannel(), defaultChannel(), defaultChannel()],
};

const clampInt = (v, lo, hi, fallback) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : fallback;
};

const oneOf = (v, list, fallback) => (list.some((x) => x.value === Number(v)) ? Number(v) : fallback);

/**
 * Settings in the shape the attach carries.
 *
 * `output_mode` is fixed at "ax25": the alternative sends raw KISS frames for
 * piping into direwolf, which is a thing to do with a TCP port and not with a
 * web page. The panel decodes AX.25, so that is what it asks for.
 */
export function attachParams(config) {
    return {
        output_mode: 'ax25',
        dcd_threshold: clampInt(config.dcd_threshold, LIMITS.dcd_threshold.min, LIMITS.dcd_threshold.max, 20),
        channels: (config.channels || []).slice(0, MAX_CHANNELS).map((c) => ({
            enabled: !!c.enabled,
            modem: oneOf(c.modem, MODEM_TYPES, 1),
            freq: clampInt(c.freq, LIMITS.freq.min, LIMITS.freq.max, 1700),
            rcvr_pairs: clampInt(c.rcvr_pairs, 0, 8, 0),
            fx25: oneOf(c.fx25, FX25_MODES, 1),
            il2p: oneOf(c.il2p, IL2P_MODES, 0),
        })),
    };
}

/** Whether anything at all is switched on. Nothing is decoded otherwise. */
export function anyChannelEnabled(config) {
    return (config.channels || []).some((c) => c.enabled);
}

// Frames kept. A busy VHF channel is a few a minute; an HF one, a few an hour.
export const MAX_FRAMES = 500;

// Monitor and log lines kept. Both are diagnostics rather than results, so they
// are held shallowly — the log in particular is QtSoundModem's stderr.
export const MAX_LINES = 200;

/**
 * The frame types the filter offers, grouped the way an operator thinks of them.
 *
 * 'all' and the two groups rather than sixteen individual types: what you
 * actually want is "just the APRS" or "hide the link-layer chatter", and a
 * menu of every U-frame variant is a menu nobody reads.
 */
export const FRAME_FILTERS = [
    { id: 'all', label: 'All frames' },
    { id: 'aprs', label: 'APRS only' },
    { id: 'data', label: 'Data (UI and I)' },
    { id: 'link', label: 'Link control' },
];

const DATA_TYPES = new Set(['ui', 'i', 'aprs', 'netrom', 'nodes', 'ip', 'arp']);

export function matchesFilter(frame, filter) {
    switch (filter) {
        case 'aprs': return !!frame.isAPRS;
        case 'data': return DATA_TYPES.has(frame.frameType);
        case 'link': return !DATA_TYPES.has(frame.frameType);
        default: return true;
    }
}

/**
 * Whether a frame matches a free-text search.
 *
 * Callsigns, the digipeater path and the decoded info all count: "GB7" should
 * find frames that went *through* a node as well as frames from it, which is
 * the question you are usually asking of a packet channel.
 */
export function matchesSearch(frame, text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return true;
    return (
        frame.from.toLowerCase().includes(needle)
        || frame.to.toLowerCase().includes(needle)
        || frame.digipeaters.join(',').toLowerCase().includes(needle)
        || (frame.info || '').toLowerCase().includes(needle)
        || (frame.infoRaw || '').toLowerCase().includes(needle)
    );
}

// v1's frequency menu. One entry, which is what v1 shipped — packet lives on
// local VHF repeaters far more than on any agreed HF channel, so a longer list
// would be inventing frequencies rather than recalling them.
export const SOUNDMODEM_FREQUENCIES = [
    {
        group: 'HF packet',
        options: [
            { hz: 7049450, label: '7.04945 MHz (UK packet)' },
        ],
    },
];
