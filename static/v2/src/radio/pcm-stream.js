// Lossless PCM audio path, requested as `format=pcm-zstd`.
//
// The server compresses the whole frame — header included — with zstd, so it
// has to be inflated before anything in it can be read. Layout after that, all
// little-endian except the samples, which are big-endian int16 copied straight
// through from radiod:
//
//   full header   [magic u16 0x5043][version u8][formatType u8]
//                 [rtpTimestamp u64][wallClockMs u64][sampleRate u32]
//                 [channels u8]
//                 v2 only: [basebandPower f32][noiseDensity f32]
//                 [reserved u32]                    37 bytes (v2), 29 (v1)
//   minimal       [magic u16 0x504D][version u8][rtpTimestamp u64]
//                 [reserved u16]                    13 bytes
//
// then the samples. A minimal header means "metadata as before", so decoding is
// stateful. v2 only offers modes the server sends a full header for on every
// packet — that is where the per-packet signal quality rides — but the minimal
// form is handled anyway: it costs a branch, and reading one as a full header
// would play the metadata as audio rather than fail.
//
// See pcm_binary.go, which writes all of this.

import { loadScript } from '../lib/loadScript.js';

// fzstd 0.1.1, UMD, decompression only:
//   curl -fsSL -o static/fzstd.min.js https://unpkg.com/fzstd@0.1.1/umd/index.js
//
// Loaded on demand rather than from index.html. It is 8 KB, which is nothing
// next to the bundle, but nobody listening on Opus — everybody, by default —
// needs a zstd decoder at all, and this keeps the default path exactly as it
// was. Same reasoning as v1's jszip and the recorder worklet.
const FZSTD_URL = '/fzstd.min.js';

const MAGIC_FULL = 0x5043;      // "PC"
const MAGIC_MINIMAL = 0x504D;   // "PM"
const FULL_HEADER_V1 = 29;
const FULL_HEADER_V2 = 37;
const MINIMAL_HEADER = 13;

// A zstd frame header, which every packet on this path starts with. Read as a
// little-endian u32 the magic is 0xFD2FB528.
const ZSTD_MAGIC = 0xFD2FB528;

// Whether a binary frame is one of ours rather than an Opus packet.
//
// Worth sniffing even though the requested format is known: a server built
// without libopus answers `format=opus` with pcm-zstd anyway (see websocket.go,
// "Opus encoder not available"), and until now that arrived as noise. Four
// bytes of magic against an Opus frame's leading timestamp is a false positive
// every 2^32 packets, or once in a few years of listening, costing one 20 ms
// frame when it happens.
export function isZstdFrame(buffer) {
    if (buffer.byteLength < 4) return false;
    return new DataView(buffer).getUint32(0, true) === ZSTD_MAGIC;
}

// -999 is the server's "no channel status available" sentinel. Written so a
// NaN also comes out as null.
function quality(value) {
    return value > -998 ? value : null;
}

export class PCMStreamDecoder {
    constructor() {
        this.lib = null;
        this.loading = null;
        // Carried between packets for the minimal-header case. Zero means
        // nothing has announced them yet.
        this.sampleRate = 0;
        this.channels = 1;
    }

    get ready() {
        return !!this.lib;
    }

    // Fetches the inflater. Awaited before the socket opens when this format
    // was asked for; started mid-stream when a server falls back to it on its
    // own, where packets are dropped until it resolves rather than the stream
    // failing outright.
    load() {
        if (this.lib) return Promise.resolve(this.lib);
        if (!this.loading) {
            this.loading = loadScript(FZSTD_URL).then(
                () => {
                    const lib = window.fzstd;
                    if (!lib || typeof lib.decompress !== 'function') {
                        this.loading = null;
                        throw new Error('fzstd loaded but exported no decompressor');
                    }
                    this.lib = lib;
                    return lib;
                },
                (err) => {
                    this.loading = null;
                    throw err;
                },
            );
        }
        return this.loading;
    }

    // A fresh session announces its own metadata, and keeping the old values
    // would let the first minimal-header packet of a reconnect play at the
    // previous rate.
    reset() {
        this.sampleRate = 0;
        this.channels = 1;
    }

    // Returns planar float samples, or null for a frame that cannot be read —
    // a truncated packet, an unknown magic, or samples arriving before any
    // header has said what rate they are.
    decode(buffer) {
        if (!this.lib) return null;
        let raw;
        try {
            raw = this.lib.decompress(new Uint8Array(buffer));
        } catch (err) {
            return null;
        }
        if (raw.length < MINIMAL_HEADER) return null;

        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const magic = view.getUint16(0, true);
        let offset;
        let signal = null;

        if (magic === MAGIC_FULL) {
            const version = view.getUint8(2);
            offset = version >= 2 ? FULL_HEADER_V2 : FULL_HEADER_V1;
            if (raw.length < offset) return null;
            this.sampleRate = view.getUint32(20, true) || this.sampleRate;
            this.channels = view.getUint8(24) || 1;
            if (version >= 2) {
                signal = {
                    basebandPower: quality(view.getFloat32(25, true)),
                    noiseDensity: quality(view.getFloat32(29, true)),
                };
            }
        } else if (magic === MAGIC_MINIMAL) {
            offset = MINIMAL_HEADER;
        } else {
            return null;
        }

        if (!this.sampleRate) return null;

        const { channels } = this;
        const frames = Math.floor((raw.length - offset) / (2 * channels));
        const planes = [];
        for (let c = 0; c < channels; c++) planes.push(new Float32Array(frames));
        // Read a sample at a time rather than through an Int16Array view: the
        // samples are big-endian and a typed array takes the host's byte order,
        // which on every machine this runs on would turn them into white noise.
        let p = offset;
        for (let i = 0; i < frames; i++) {
            for (let c = 0; c < channels; c++) {
                planes[c][i] = view.getInt16(p, false) / 32768;
                p += 2;
            }
        }
        return { planes, sampleRate: this.sampleRate, channels, signal };
    }
}
