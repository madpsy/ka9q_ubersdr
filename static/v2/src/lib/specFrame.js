// The "SPEC" spectrum frame format, in one place.
//
// Three consumers read this format and, until this module existed, each had its
// own copy of the parsing: the waterfall over its WebSocket
// (radio/spectrum-connection.js), the band panel over SSE (lib/bandSpectrum.js),
// and the standalone band_activity.html page. Three copies meant three places to
// add a length check and three places to get the mask walk right — and during
// the version 2 work each of those was in fact written three times, with a bug
// landing in only the copy that happened to use a particular call shape.
//
// band_activity.html still carries its own, because it is a plain page with no
// build step and cannot import from here. Its copy is marked as a copy; this is
// the definition it is a copy OF.
//
// WIRE FORMAT
//
// Version 1 (22-byte header):
//   [magic "SPEC"][ver 1][flags][timestamp u64][centreFreq u64]
//     0x03 full  : [bin u8 × n]
//     0x04 delta : [count u16][index u16, value u8] × count
//   Values map to dB as `code - 256`: one decibel a step across a fixed 256 dB
//   window, of which the bins occupy about 90.
//
// Version 2 (24-byte header, two more for a sequence number):
//   [magic "SPEC"][ver 2][flags][seq u16][timestamp u64][centreFreq u64]
//     0x05 full  : [refCentiDB i16][stepCentiDB u8][code u8 × n]
//     0x06 delta : [mask ⌈n/8⌉ bytes][value u8 per set bit]
//   Values map to dB as `(ref + code × step) / 100`. The scale travels with each
//   full frame, so resolution follows the data instead of being fixed, and it
//   cannot clip on a receiver whose gain settings put the values elsewhere. A
//   delta never restates it: the scale may only change on a full frame.
//
// Why version 2 exists at all, measured against a live receiver: version 1's
// delta cost three bytes to move one bin, so roughly two thirds of delta frames
// came out LARGER than the full frame they were avoiding; its quantiser
// truncated rather than rounding; and a full-scale bin wrapped round to the
// floor. See user_spectrum_v2.go for the numbers.

export const SPEC_MAGIC = 0x43455053;   // "SPEC" read as a little-endian uint32

export const SPEC_V1 = 1;
export const SPEC_V2 = 2;

export const V1_HEADER = 22;
export const V2_HEADER = 24;

export const FRAME_FULL = 0x03;
export const FRAME_DELTA = 0x04;
export const FRAME_V2_FULL = 0x05;
export const FRAME_V2_DELTA = 0x06;

// The version a client asks for. Frames are self-describing, so this only
// decides what a server that understands the request will send — one that does
// not keeps sending version 1, and parseFrame handles both.
export const SPEC_PROTOCOL_VERSION = 2;

// dBFS from a wire code.
//
// The scale is validated rather than merely tested for truthiness, because this
// is the shape that gets passed to Array.prototype.map — which supplies
// (value, index, array), so a point-free `.map(dbFromCode)` would hand the INDEX
// in as the scale. Index 0 is falsy and looks correct; every element after it
// would come back NaN, silently.
export function dbFromCode(code, scale) {
    if (!scale || typeof scale.step !== 'number' || !scale.step) return code - 256;
    return (scale.ref + code * scale.step) / 100;
}

// Where version 1 puts its floor: the code a missing bin lands on, and the one a
// full-scale bin wrapped round to. Not a measurement either way.
export const V1_FLOOR_DB = -256;

// The floor of whichever scale is in force, for filtering values that are not
// measurements out of an auto-range calculation.
//
// Named scaleFloorDb rather than floorDb: `floorDb` is already a property and
// parameter name across audioStats, ifShape, ifSpectrum and others, and a
// module-level export of that name makes every one of those look like an
// unimported use to the static check in test/unresolved.js.
export function scaleFloorDb(scale) {
    return scale ? dbFromCode(0, scale) : V1_FLOOR_DB;
}

// Reads the header off a frame, returning null for anything that is not one.
//
// Takes a Uint8Array so both transports can reach it: the WebSocket has an
// ArrayBuffer, and the SSE path has base64 it has already expanded.
//
// Length is checked before any field is read. Version 1 read its header first,
// so a truncated frame threw where the caller could not see it and left the
// accumulator half-applied.
export function parseFrame(u8) {
    if (!u8 || u8.length < V1_HEADER) return null;
    if (u8[0] !== 0x53 || u8[1] !== 0x50 || u8[2] !== 0x45 || u8[3] !== 0x43) return null;

    const version = u8[1 + 3];
    const flags = u8[5];

    if (version === SPEC_V2) {
        if (u8.length < V2_HEADER) return null;
        return {
            version,
            flags,
            seq: u8[6] | (u8[7] << 8),
            body: u8.subarray(V2_HEADER),
        };
    }
    if (version !== SPEC_V1) return null;
    return { version, flags, seq: null, body: u8.subarray(V1_HEADER) };
}

// Reads the quantisation scale off a version 2 full frame's body.
export function scaleOf(body) {
    if (!body || body.length < 3) return null;
    const step = body[2];
    if (step === 0) return null;
    return { ref: ((body[0] | (body[1] << 8)) << 16) >> 16, step };
}

// Popcount of a byte. The delta validation has to count every set bit in the
// mask before touching a single bin, and doing that a bit at a time cost more
// than the apply itself. One table lookup per mask byte instead.
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

// Folds a frame's body into a Uint8Array of codes.
//
// Returns the array to hold — a new one when the width changed — or null when
// the frame cannot be used: a delta with nothing to apply it to, a full frame of
// the wrong width, or a frame whose length disagrees with its own contents.
// A delta is applied IN PLACE and the same array returned, which is what the
// callers want: they redraw from one buffer.
export function applyBody(codes, frame, binCount) {
    if (!frame) return codes;
    const r = applyBodyChanges(codes, frame, binCount, null);
    return r ? r.codes : null;
}

// applyBody, reporting WHICH bins a version 2 delta wrote.
//
// The waterfall keeps a dB buffer derived from the codes, and a delta that
// moved a dozen bins used to cost a full reconversion of all of them because
// nothing said which dozen. `changed` is the caller's Uint32Array (at least
// binCount long, reused frame to frame); the applied raw-order indices land in
// its first `changed` entries of the result.
//
// The result's `changed` count is -1 when every bin must be treated as
// changed: any full frame, and also a version 1 delta — its triples can repeat
// an index and point past the end, so a faithful count is not worth the
// bookkeeping for a format the v2 socket never sends.
//
// Returns { codes, changed } or null, with exactly applyBody's nulls: the two
// are one function, and applyBody is the shape for callers that do not track.
export function applyBodyChanges(codes, frame, binCount, changed) {
    const { flags, body } = frame;

    if (flags === FRAME_V2_FULL) {
        if (body.length < 3 || body.length - 3 !== binCount) return null;
        if (!scaleOf(body)) return null;
        const next = (codes && codes.length === binCount) ? codes : new Uint8Array(binCount);
        next.set(body.subarray(3));
        return { codes: next, changed: -1 };
    }

    if (flags === FRAME_V2_DELTA) {
        if (!codes) return null;
        const n = codes.length;
        const maskLen = (n + 7) >> 3;
        if (body.length < maskLen) return null;
        // One value byte per set bit, so the count is implied. A length that
        // disagrees with the mask is malformed, and applying it part way would
        // leave the codes half-updated and wrong until the next keyframe.
        //
        // Stray bits in the trailing byte — past binCount — are counted here,
        // exactly as the value bytes a server that set them would have sent,
        // and then never applied. That is what the old bin-at-a-time walk did
        // by construction, and a well-formed frame has none.
        let expected = 0;
        for (let b = 0; b < maskLen; b++) expected += POPCOUNT[body[b]];
        if (body.length !== maskLen + expected) return null;

        // Byte-wise, because the mask of a quiet delta is mostly zero bytes
        // and each one skipped is eight bins never looked at. Within a byte,
        // peel set bits low to high: `m & -m` isolates the lowest, clz32 names
        // it, `m &= m - 1` clears it — the same low-to-high order the value
        // bytes were packed in.
        let vi = maskLen;
        let ci = 0;
        const whole = n >> 3;
        for (let b = 0; b < whole; b++) {
            let m = body[b];
            if (m === 0) continue;
            const base = b << 3;
            do {
                const i = base + (31 - Math.clz32(m & -m));
                codes[i] = body[vi++];
                if (changed) changed[ci] = i;
                ci++;
                m &= m - 1;
            } while (m);
        }
        if (whole < maskLen) {
            let m = body[whole] & ((1 << (n & 7)) - 1);
            const base = whole << 3;
            while (m) {
                const i = base + (31 - Math.clz32(m & -m));
                codes[i] = body[vi++];
                if (changed) changed[ci] = i;
                ci++;
                m &= m - 1;
            }
        }
        return { codes, changed: ci };
    }

    if (flags === FRAME_FULL) {
        if (body.length !== binCount) return null;
        const next = (codes && codes.length === binCount) ? codes : new Uint8Array(binCount);
        next.set(body);
        return { codes: next, changed: -1 };
    }

    if (flags === FRAME_DELTA) {
        if (!codes) return null;
        if (body.length < 2) return null;
        const count = body[0] | (body[1] << 8);
        if (2 + count * 3 > body.length) return null;
        for (let i = 0; i < count; i++) {
            const off = 2 + i * 3;
            const idx = body[off] | (body[off + 1] << 8);
            if (idx < codes.length) codes[idx] = body[off + 2];
        }
        return { codes, changed: -1 };
    }

    return null;
}

// Whether a frame carries a complete picture, and so a new scale.
export function isFullFrame(flags) {
    return flags === FRAME_FULL || flags === FRAME_V2_FULL;
}
