// Reading an IQ recording: a WAV file, I on the left and Q on the right.
//
// Every recorder that writes IQ writes it this way — this receiver's own
// recorder and the playground's, SDR++, HDSDR, SDRuno, GQRX's WAV option — and
// they differ only in sample format: 8, 16, 24 or 32-bit integers, or 32-bit
// float, plain or in WAVE_FORMAT_EXTENSIBLE dress. All of those are read.
//
// Where the recording was made — the centre frequency — is not part of WAV.
// Two places it is commonly kept are read: the `auxi` chunk HDSDR and SDRuno
// add (a DWORD after two SYSTEMTIMEs), and a frequency in the file's name,
// which is how the playground's own IQ recorder and most others keep it.

// A recording this size is a few minutes of a wide stream, and its samples
// are held as floats — four bytes each, twice — for as long as it is loaded.
export const MAX_WAV_BYTES = 512 * 1024 * 1024;

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** The centre frequency a file's name gives, in Hz, or null. */
export function centreFromName(name) {
    const m = /(\d{4,11}(?:\.\d+)?)\s*(hz|khz|mhz)(?![a-z])/i.exec(String(name || ''));
    if (!m) return null;
    const v = Number(m[1]);
    const unit = m[2].toLowerCase();
    const freq = unit === 'mhz' ? v * 1e6 : unit === 'khz' ? v * 1e3 : v;
    return freq > 0 && freq < 1e11 ? Math.round(freq) : null;
}

/**
 * Decode a WAV file's bytes. Returns `{ rate, channels, frames, i, q,
 * centreHz }` — `q` all zeros for a mono file, which is a real signal and
 * plays as one — or throws an Error saying, in words, why it cannot.
 */
export function decodeWav(buffer, name = '') {
    if (!(buffer instanceof ArrayBuffer) && !(buffer && buffer.buffer instanceof ArrayBuffer)) {
        throw new Error('Not a file.');
    }
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (bytes.byteLength > MAX_WAV_BYTES) {
        throw new Error(`That file is over ${MAX_WAV_BYTES / 1048576} MB, more than a page can hold.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');

    let fmt = null;
    let data = null;
    let centreHz = null;
    for (let at = 12; at + 8 <= bytes.byteLength;) {
        const id = tag(at);
        const size = view.getUint32(at + 4, true);
        const body = at + 8;
        if (id === 'fmt ' && size >= 16) {
            let format = view.getUint16(body, true);
            const bits = view.getUint16(body + 14, true);
            if (format === EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
            fmt = {
                format,
                channels: view.getUint16(body + 2, true),
                rate: view.getUint32(body + 4, true),
                bits,
                align: view.getUint16(body + 12, true),
            };
        } else if (id === 'data') {
            // A writer that never went back to fill the size in (a recording
            // cut short) leaves zero or too much: take what is there.
            const end = size === 0 || body + size > bytes.byteLength ? bytes.byteLength : body + size;
            data = { at: body, size: end - body };
        } else if (id === 'auxi' && size >= 36) {
            const hz = view.getUint32(body + 32, true);
            if (hz > 0) centreHz = hz;
        }
        at = body + size + (size & 1);
    }
    if (!fmt) throw new Error('This WAV file has no format chunk.');
    if (!data) throw new Error('This WAV file has no audio in it.');
    if (fmt.channels < 1 || fmt.channels > 2) throw new Error(`This file has ${fmt.channels} channels; IQ is two.`);
    if (!(fmt.rate > 0)) throw new Error('This file does not say its sample rate.');
    const width = fmt.bits / 8;
    const float = fmt.format === FLOAT;
    if (!(fmt.format === PCM || float) || ![1, 2, 3, 4].includes(width) || (float && width !== 4)) {
        throw new Error(`This file is in a sample format the playground does not read (format ${fmt.format}, ${fmt.bits}-bit).`);
    }
    const stride = fmt.align || width * fmt.channels;
    const frames = Math.floor(data.size / stride);
    const i = new Float32Array(frames);
    const q = new Float32Array(frames);
    const read = (at) => {
        switch (width) {
            case 1: return (view.getUint8(at) - 128) / 128;
            case 2: return view.getInt16(at, true) / 32768;
            case 3: {
                const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
                return v / 8388608;
            }
            default: return float ? view.getFloat32(at, true) : view.getInt32(at, true) / 2147483648;
        }
    };
    for (let k = 0, at = data.at; k < frames; k++, at += stride) {
        i[k] = read(at);
        if (fmt.channels === 2) q[k] = read(at + width);
    }
    return {
        rate: fmt.rate,
        channels: fmt.channels,
        frames,
        i,
        q,
        centreHz: centreHz || centreFromName(name),
    };
}
