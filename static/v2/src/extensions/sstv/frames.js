// SSTV: the decoder's wire frames, its settings, and where to hear it.
//
// The richest protocol of any extension here — nine message types, defined in
// audio_extensions/sstv/decoder.go — because an SSTV transmission has a shape
// that a stream of scanlines alone cannot express:
//
//     0x07  image start  [type:1][width:4][height:4]
//     0x02  mode         [type:1][index:1][extended:1][name_len:1][name]
//     0x01  line         [type:1][line:4][width:4][rgb pixels:width*3]
//     0x03  status       [type:1][code:1][len:2][text]
//     0x04  sync         [type:1][quality:1]
//     0x08  redraw       [type:1]
//     0x05  complete     [type:1][total_lines:4]
//     0x06  callsign     [type:1][len:1][text]        FSK ident after the image
//     0x09  tone         [type:1][hz × 10:4]          live VIS-detector readout
//
// Two of them carry the ordering rules that a client gets wrong if it treats
// this as a picture arriving top to bottom:
//
//   * The mode arrives *before* the image it describes. It comes from the VIS
//     code, which precedes the picture — so a mode message is a statement about
//     what is coming next, not about what is on screen.
//   * A redraw is the same picture again, and it ends in a second `complete`.
//     When the decoder has measured the sync pulses it re-sends every line with
//     the slant corrected, into the image already drawn — so a transmission
//     with correction on completes twice, and a client that files the picture
//     on the first one keeps the leaning version as well as the straight one.
//     See keepOnComplete below.

export const FRAME_LINE = 0x01;
export const FRAME_MODE = 0x02;
export const FRAME_STATUS = 0x03;
export const FRAME_SYNC = 0x04;
export const FRAME_COMPLETE = 0x05;
export const FRAME_CALLSIGN = 0x06;
export const FRAME_START = 0x07;
export const FRAME_REDRAW = 0x08;
export const FRAME_TONE = 0x09;

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame, or null.
 *
 * Pixel data is returned as a view onto the frame rather than a copy: the
 * caller paints it within the same tick and never keeps the reference, and a
 * copy per line would be a megabyte per picture for nothing.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 1) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const text = (from, len) => (utf8 ? utf8.decode(b.subarray(from, from + len)) : '');

    switch (b[0]) {
        case FRAME_START:
            if (b.length < 9) return null;
            return { kind: 'start', width: view.getUint32(1), height: view.getUint32(5) };

        case FRAME_MODE: {
            if (b.length < 4) return null;
            const len = b[3];
            if (len > b.length - 4) return null;
            return {
                kind: 'mode',
                index: b[1],
                extended: b[2] === 1,
                name: text(4, len),
            };
        }

        case FRAME_LINE: {
            if (b.length < 9) return null;
            const line = view.getUint32(1);
            const width = view.getUint32(5);
            // Three bytes a pixel. A width that disagrees with the frame is a
            // truncated frame, not a reason to paint whatever follows.
            if (width === 0 || width * 3 !== b.length - 9) return null;
            return { kind: 'line', line, width, rgb: b.subarray(9) };
        }

        case FRAME_STATUS: {
            if (b.length < 4) return null;
            const len = view.getUint16(2);
            if (len > b.length - 4) return null;
            return { kind: 'status', code: b[1], text: text(4, len) };
        }

        case FRAME_SYNC:
            if (b.length < 2) return null;
            return { kind: 'sync', quality: b[1] };

        case FRAME_COMPLETE:
            if (b.length < 5) return null;
            return { kind: 'complete', lines: view.getUint32(1) };

        case FRAME_CALLSIGN: {
            if (b.length < 2) return null;
            const len = b[1];
            if (len > b.length - 2) return null;
            return { kind: 'callsign', callsign: text(2, len).trim() };
        }

        case FRAME_REDRAW:
            return { kind: 'redraw' };

        case FRAME_TONE:
            if (b.length < 5) return null;
            // Sent as tenths of a hertz, so the VIS readout can show the
            // fraction that says whether the receiver is on frequency.
            return { kind: 'tone', hz: view.getUint32(1) / 10 };

        default:
            return null;
    }
}

/**
 * Grey-free RGB triples as the RGBA a canvas wants.
 *
 * `out` is reused between lines — one line of a 640-wide mode is 2.5 kB of
 * RGBA, and SSTV sends a few hundred of them per picture.
 */
export function toRGBA(rgb, width, out) {
    const need = width * 4;
    const rgba = out && out.length >= need ? out : new Uint8ClampedArray(need);
    for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = x * 4;
        rgba[d] = rgb[s];
        rgba[d + 1] = rgb[s + 1];
        rgba[d + 2] = rgb[s + 2];
        rgba[d + 3] = 255;
    }
    return rgba;
}

// ── the decoder's settings ──────────────────────────────────────────────────

// What the server takes at attach — see audio_extensions/sstv/extension.go.
// `auto_save` is deliberately absent: it is what the *client* does with a
// finished picture, and the server has no business knowing.
export const SSTV_CONFIG = {
    auto_sync: true,
    decode_fsk_id: true,
    mmsstv_only: false,
};

export function attachParams(config) {
    return {
        auto_sync: !!config.auto_sync,
        decode_fsk_id: !!config.decode_fsk_id,
        mmsstv_only: !!config.mmsstv_only,
    };
}

// Pictures kept in the panel. Each is a PNG blob of at most 640×496, so this is
// a few megabytes — and the URLs are revoked as they fall off the end, which is
// the part that leaks if you forget it.
export const KEEP_IMAGES = 24;

// Below this a "transmission" is a burst of noise that tripped the VIS
// detector, not a picture worth keeping.
export const MIN_KEEPABLE_LINES = 8;

/**
 * Whether a completion message is the one to keep the picture on.
 *
 * With slant correction on — the default — the server sends `complete` twice:
 * once when the raw pass finishes, and again after it has re-sent every line
 * corrected (sendComplete at both ends of the AutoSync block in decoder.go).
 * Keeping the picture on the first one files the leaning version *and* the
 * straight one, so every transmission ends up in the gallery twice.
 *
 * The exception the rule has to allow for: if nothing was received the server
 * skips the correction and the second completion never comes. That picture is
 * empty, so it fails the minimum-lines test anyway, and the next image-start
 * sweeps up whatever was left unsaved regardless.
 */
export function keepOnComplete({ autoSync, redrawn }) {
    return !autoSync || !!redrawn;
}

/**
 * How far through the picture the decoder is, as a fraction.
 *
 * Zero height means no picture has started; reporting 100% then would show a
 * finished progress bar over an empty frame.
 */
export function progressOf(lines, height) {
    if (!height || height <= 0) return 0;
    return Math.max(0, Math.min(1, lines / height));
}

// v1's frequency list, de-duplicated. v1 offered 14.230 twice — once under
// "most active" and once under 20 m — which cannot both be the selected entry
// when the menu shows where the receiver is.
export const SSTV_FREQUENCIES = [
    {
        group: 'Most active',
        options: [
            { hz: 14230000, label: '14.230 MHz (20m — primary)' },
            { hz: 14233000, label: '14.233 MHz (20m — alternative)' },
        ],
    },
    {
        group: 'Other frequencies',
        options: [
            { hz: 3845000, label: '3.845 MHz (80m — evening)' },
            { hz: 7171000, label: '7.171 MHz (40m)' },
            { hz: 14227000, label: '14.227 MHz (20m)' },
            { hz: 14236000, label: '14.236 MHz (20m)' },
            { hz: 21340000, label: '21.340 MHz (15m)' },
            { hz: 28680000, label: '28.680 MHz (10m)' },
        ],
    },
];
