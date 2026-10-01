// One WAV recorder block's recording: started and stopped from the page, held
// in memory, then saved or played back.
//
// Held as 16-bit samples from the moment they arrive rather than as floats to
// be converted at the end. A recording lives in memory until it is saved, and
// half the bytes is twice the minutes before the tab is in trouble.
//
// Two limits, and whichever comes first stops it, with the reason kept for the
// interface to show:
//
//   time     the block's own `maxSeconds`, ten minutes unless changed — the
//            recorder panel's cap, for the same reason
//   memory   MAX_RECORDING_BYTES. On an audio-rate stream this is hours and the
//            time limit always wins; on a wide one — a stereo pair at 384 kHz is
//            1.5 MB a second — it is a few minutes, and it is what stops the
//            tab running out.

export const MAX_RECORDING_BYTES = 256 * 1024 * 1024;

const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/** 16-bit PCM WAV bytes from interleaved Int16 chunks. */
export function encodeWav16(chunks, sampleRate, channels) {
    let dataSize = 0;
    for (const c of chunks) dataSize += c.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const str = (offset, s) => {
        for (let k = 0; k < s.length; k++) view.setUint8(offset + k, s.charCodeAt(k));
    };
    const rate = Math.round(sampleRate);
    str(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);                   // PCM header length
    view.setUint16(20, 1, true);                    // format: PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true);  // byte rate
    view.setUint16(32, channels * 2, true);         // block align
    view.setUint16(34, 16, true);                   // bits per sample
    str(36, 'data');
    view.setUint32(40, dataSize, true);
    const bytes = new Uint8Array(buffer, 44);
    let at = 0;
    for (const c of chunks) {
        bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at);
        at += c.byteLength;
    }
    return buffer;
}

export class WavRecording {
    constructor() {
        this.state = 'idle';        // idle | recording | held
        this.reason = null;         // why it stopped, if it stopped itself
        this.chunks = [];
        this.frames = 0;
        this.rate = 0;
        this.channels = 0;
        this.maxSeconds = 600;
        this.startedAt = 0;
        this._blob = null;
        this._url = null;
    }

    /** Begin a fresh recording, discarding any held one. */
    start(maxSeconds = 600, now = Date.now(), label = '') {
        this.clear();
        this.state = 'recording';
        this.maxSeconds = maxSeconds;
        this.startedAt = now;
        this.label = String(label || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
    }

    /** The most frames this recording may hold, once its rate is known. */
    get limitFrames() {
        if (!this.rate || !this.channels) return Infinity;
        const byTime = Math.floor(this.maxSeconds * this.rate);
        const byMemory = Math.floor(MAX_RECORDING_BYTES / (2 * this.channels));
        return Math.min(byTime, byMemory);
    }

    /** How long the limit allows, in seconds — the shorter of the two. */
    get limitSeconds() {
        const f = this.limitFrames;
        return Number.isFinite(f) ? f / this.rate : this.maxSeconds;
    }

    get seconds() {
        return this.rate ? this.frames / this.rate : 0;
    }

    get bytes() {
        return this.frames * this.channels * 2;
    }

    /**
     * Add one block. Returns true when this block ended the recording, so the
     * caller knows to say so.
     */
    push(left, right, frames, rate) {
        if (this.state !== 'recording' || !frames) return false;
        const channels = right ? 2 : 1;
        if (!this.rate) {
            this.rate = rate;
            this.channels = channels;
        } else if (rate !== this.rate || channels !== this.channels) {
            // A WAV file has one rate and one channel count. Rather than write
            // one that lies about either, keep what was recorded.
            this.stop(rate !== this.rate
                ? 'Stopped: the rate arriving at the recorder changed.'
                : 'Stopped: the recorder’s second input was connected or disconnected.');
            return true;
        }
        const room = this.limitFrames - this.frames;
        const n = Math.min(frames, room);
        const chunk = new Int16Array(n * channels);
        for (let k = 0, j = 0; k < n; k++) {
            const l = clamp1(left[k]);
            chunk[j++] = l < 0 ? l * 32768 : l * 32767;
            if (right) {
                const r = clamp1(right[k]);
                chunk[j++] = r < 0 ? r * 32768 : r * 32767;
            }
        }
        if (n) {
            this.chunks.push(chunk);
            this.frames += n;
        }
        if (this.frames >= this.limitFrames) {
            const byTime = Math.floor(this.maxSeconds * this.rate) <= this.limitFrames;
            this.stop(byTime
                ? `Stopped at the ${formatLimit(this.maxSeconds)} limit.`
                : `Stopped at the memory limit (${Math.round(MAX_RECORDING_BYTES / 1048576)} MB).`);
            return true;
        }
        return false;
    }

    stop(reason = null) {
        if (this.state !== 'recording') return;
        this.state = this.frames ? 'held' : 'idle';
        this.reason = reason;
    }

    /** The recording as a WAV file. Built once and kept. */
    blob() {
        if (!this.frames) return null;
        if (!this._blob) {
            this._blob = new Blob([encodeWav16(this.chunks, this.rate, this.channels)], { type: 'audio/wav' });
        }
        return this._blob;
    }

    /** A URL to play it from, made once and revoked when the recording goes. */
    url() {
        if (this.state !== 'held') return null;
        if (!this._url) {
            const b = this.blob();
            this._url = b ? URL.createObjectURL(b) : null;
        }
        return this._url;
    }

    /** A file name for it, from when it was started. */
    filename() {
        const d = new Date(this.startedAt || Date.now());
        const pad = (v) => String(v).padStart(2, '0');
        return `ubersdr-playground-${this.label ? `${this.label}-` : ''}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
            + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
    }

    /** Throw it away. */
    clear() {
        if (this._url) URL.revokeObjectURL(this._url);
        this._url = null;
        this._blob = null;
        this.chunks = [];
        this.frames = 0;
        this.rate = 0;
        this.channels = 0;
        this.state = 'idle';
        this.reason = null;
    }
}

function formatLimit(sec) {
    if (sec % 60 === 0) return `${sec / 60} minute`;
    return `${sec} second`;
}
