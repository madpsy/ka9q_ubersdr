// Audio recording — v1's recorder.js, rebuilt as a plain object the panel drives.
//
// Two formats, the same pair v1 offers:
//
//   webm   MediaRecorder over a MediaStreamDestination. Opus, small, and a
//          re-encode of audio the browser has already Opus-decoded once.
//   wav    16-bit PCM collected by an AudioWorklet on the audio rendering
//          thread, so main-thread jank cannot punch holes in it. Needs a
//          secure context, because AudioWorklet does.
//
// The worklet processor itself is shared with v1 (/pcm-recorder-worklet.js) —
// it is already correct, and a second copy would only drift.
//
// A download is a ZIP rather than a bare audio file, because a recording is
// worth little without the frequency, mode and time it was made at. v1 settled
// the layout and this keeps it: the audio, a metadata text file, and a CSV of
// the signal readings taken once a second while recording.
//
// Why this is not a hook: a collapsed section is unmounted (see Section.jsx),
// so a recording held in component state would end the moment the operator
// folded the panel away. State, timers and audio nodes therefore hang off one
// module-level instance that outlives any view of it.

import { Emitter } from '../radio/emitter.js';
import { loadScript } from './loadScript.js';
import { saveFile } from './saveFile.js';

// v1's cap, for the same reason: everything is held in memory until download,
// and an unbounded recording is a tab that eventually dies.
export const MAX_RECORDING_MS = 10 * 60 * 1000;

const WORKLET_URL = '/pcm-recorder-worklet.js';
const JSZIP_URL = '/jszip.min.js';

// One timer drives the auto-stop, the dropped-context check and the signal log.
// 250 ms is well inside the second the log wants and fast enough that the cap
// lands where it says it does.
const TICK_MS = 250;
const SIGNAL_MS = 1000;

// WAV is only offered where AudioWorklet exists, which means a secure context.
export function wavSupported() {
    return !!(window.isSecureContext && window.AudioWorkletNode);
}

export class Recorder extends Emitter {
    constructor(player) {
        super();
        this.player = player;

        this.state = 'idle';        // 'idle' | 'recording' | 'ready'
        this.format = 'webm';       // format the held recording was made in
        // The operator's choice for the *next* recording. It lives here rather
        // than in the panel so it survives the section being collapsed, which
        // unmounts the view.
        this.preferredFormat = 'webm';
        // Whether Download hands over the whole archive or only the audio.
        // Kept here for the same reason and with the same lifetime as the
        // format above: a collapsed panel must not forget it, and it is a
        // choice about the next download rather than about this recording.
        // The archive is the default because it is the one that can be
        // reconstructed from — the audio alone cannot say what frequency it
        // was, and nobody remembers a fortnight later.
        this.preferArchive = true;
        this.startedAt = 0;
        this.endedAt = 0;
        this.notice = '';           // why a recording ended on its own
        this.meta = null;           // tuning/receiver snapshot taken at start
        this.signal = [];           // one entry per second

        this._chunks = [];          // webm: Blob parts
        this._pcm = [];             // wav: Float32Array frames
        this._rate = 0;
        this._channels = 1;
        this._media = null;         // MediaRecorder
        this._dest = null;          // MediaStreamAudioDestinationNode
        this._worklet = null;
        this._epoch = -1;
        this._timer = null;
        this._lastSignalAt = 0;
        this._sample = null;        // () => meters snapshot
        // Resolves when the encoder has handed over its last chunk. MediaRecorder
        // finishes asynchronously, so a download taken straight after Stop would
        // otherwise be short by up to a second.
        this._flush = Promise.resolve();
        // The finished recording as one playable Blob, and an object URL onto
        // it. Both are built on demand and held until the recording is thrown
        // away: downloading and playing want the same bytes, and for WAV those
        // bytes cost ~58 MB to encode at the ten-minute cap — not something to
        // redo every time Play is pressed.
        this._blob = null;
        this._url = '';
    }

    get elapsedMs() {
        if (!this.startedAt) return 0;
        return (this.state === 'recording' ? Date.now() : this.endedAt) - this.startedAt;
    }

    get hasData() {
        return this.format === 'wav' ? this._pcm.length > 0 : this._chunks.length > 0;
    }

    // True once a recording exists, whether or not it is still running — the
    // format cannot be changed under it in either case.
    get busy() {
        return this.state === 'recording' || this.hasData;
    }

    _changed() {
        this.emit('change');
    }

    // `meta` is a snapshot, not a live reference: the operator is free to retune
    // mid-recording, and the file should say where it started.
    async start({ format, meta, sample }) {
        if (this.state === 'recording') return;

        const player = this.player;
        if (!player || !player.ctx || !player.recordTap) {
            throw new Error('Audio is not running — start the receiver first.');
        }
        if (format === 'wav' && !wavSupported()) {
            throw new Error('WAV recording needs a secure context (HTTPS).');
        }

        this._discard();
        this.format = format === 'wav' ? 'wav' : 'webm';
        this.preferredFormat = this.format;
        this.notice = '';
        this.meta = meta || {};
        this._sample = typeof sample === 'function' ? sample : null;
        this._epoch = player.contextEpoch;
        this._rate = player.ctx.sampleRate;

        try {
            if (this.format === 'wav') await this._startWav();
            else this._startWebm();
        } catch (err) {
            this._teardown();
            this._changed();
            throw err;
        }

        this.state = 'recording';
        this.startedAt = Date.now();
        this.endedAt = 0;
        // v1 starts a 1 Hz interval here, so the first row lands one second
        // in rather than immediately.
        this._lastSignalAt = this.startedAt;
        this._runTimer();
        this._changed();
    }

    _startWebm() {
        const ctx = this.player.ctx;
        this._dest = ctx.createMediaStreamDestination();
        this.player.recordTap.connect(this._dest);

        let mimeType = 'audio/webm;codecs=opus';
        if (!window.MediaRecorder) throw new Error('MediaRecorder is not available in this browser.');
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
        // Safari has MediaRecorder but no WebM. Say so, and point at the format
        // that does work there, rather than letting the constructor throw
        // something the operator cannot act on.
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            throw new Error('This browser cannot record WebM/Opus — use the WAV format instead.');
        }

        this._media = new MediaRecorder(this._dest.stream, { mimeType });
        // The handler holds the array, not `this`: MediaRecorder keeps
        // delivering for a moment after stop(), and clearing a recording in
        // that window must not have those chunks land in the next one.
        const chunks = this._chunks;
        this._flush = new Promise((resolve) => {
            this._media.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            };
            this._media.onstop = resolve;
        });
        this._media.start(1000);   // one chunk a second, as v1 does
    }

    async _startWav() {
        const ctx = this.player.ctx;
        // Mono: the tap carries a duplicated mono stream in every mode the
        // receiver offers, so a second identical channel would double the file
        // for nothing.
        this._channels = 1;

        try {
            await ctx.audioWorklet.addModule(WORKLET_URL);
        } catch (err) {
            // Re-registering a module that is already there is not an error we
            // care about — the processor name is what matters.
            if (!err.message || !err.message.includes('already')) throw err;
        }

        this._worklet = new AudioWorkletNode(ctx, 'pcm-recorder-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        const pcm = this._pcm;   // captured, for the reason given in _startWebm
        this._worklet.port.onmessage = (e) => {
            if (e.data && e.data.samples) pcm.push(e.data.samples);
        };
        this._worklet.port.postMessage({ command: 'start' });

        this.player.recordTap.connect(this._worklet);
        // The worklet writes no output; the connection only guarantees the node
        // is pulled by the graph rather than optimised out of it.
        this._worklet.connect(ctx.destination);
    }

    stop(notice = '') {
        if (this.state !== 'recording') return;
        this.state = 'ready';
        this.endedAt = Date.now();
        this.notice = notice;
        this._teardown();
        this._changed();
    }

    // Throws away the held recording. The caller confirms first if it is live.
    clear() {
        if (this.state === 'recording') this._teardown();
        this._discard();
        this._changed();
    }

    _discard() {
        this.state = 'idle';
        this.startedAt = 0;
        this.endedAt = 0;
        this.notice = '';
        this.meta = null;
        this.signal = [];
        this._chunks = [];
        this._pcm = [];
        this._flush = Promise.resolve();
        // The URL is what keeps the Blob alive once nothing else references it,
        // so it is revoked rather than merely dropped — otherwise a WAV's worth
        // of memory survives every Clear until the tab is closed.
        if (this._url) URL.revokeObjectURL(this._url);
        this._url = '';
        this._blob = null;
    }

    // The held recording as one Blob, or null if there is nothing to make one
    // from. Callers word their own "nothing to play/download" error: this is
    // the encoder, not the messenger.
    //
    // Awaiting the flush is the same reason save() does: MediaRecorder hands
    // over its last chunk after stop(), so a Blob built without it is short by
    // up to a second.
    async audioBlob() {
        await this._flush;
        if (!this.hasData) return null;
        if (this._blob) return this._blob;
        const blob = this.format === 'wav'
            ? new Blob([encodeWav(this._pcm, this._rate, this._channels)], { type: 'audio/wav' })
            : new Blob(this._chunks, { type: 'audio/webm' });
        // Only worth keeping once the recording has stopped growing. Caching a
        // Blob mid-recording would hand out the same short prefix every time.
        if (this.state !== 'recording') this._blob = blob;
        return blob;
    }

    // A URL an <audio> element can play, held for the life of the recording so
    // pressing Play twice does not build a second copy of it. Empty while a
    // recording is still running — there is nothing complete to play yet.
    async previewUrl() {
        if (this.state === 'recording') return '';
        const blob = await this.audioBlob();
        if (!blob) return '';
        if (!this._url) this._url = URL.createObjectURL(blob);
        return this._url;
    }

    _teardown() {
        clearInterval(this._timer);
        this._timer = null;

        if (this._media) {
            try { this._media.stop(); } catch (e) { /* already stopped */ }
            this._media = null;
        }
        if (this._dest) {
            try { this.player.recordTap.disconnect(this._dest); } catch (e) { /* context gone */ }
            this._dest = null;
        }
        if (this._worklet) {
            try { this._worklet.port.postMessage({ command: 'stop' }); } catch (e) { /* ignore */ }
            try { this.player.recordTap.disconnect(this._worklet); } catch (e) { /* ignore */ }
            try { this._worklet.disconnect(); } catch (e) { /* ignore */ }
            this._worklet = null;
        }
        this._sample = null;
    }

    // One CSV row, formatted here rather than at write time so the file cannot
    // drift from v1's. Two details are v1's and are load-bearing for anyone
    // comparing old logs with new ones:
    //
    //   * −999 is v1's "no reading yet" sentinel and anything at or below
    //     −900 dBFS is treated as absent, not as a very quiet signal. v2's
    //     meters use null for the same thing, so both are checked.
    //   * SNR is derived here, floored at 0, rather than taken from the meter —
    //     the meter's value is unclamped and can go negative.
    _pushSignal(now) {
        const m = this._sample() || {};
        const bp = m.basebandPower == null ? -999 : m.basebandPower;
        const nd = m.noiseDensity == null ? -999 : m.noiseDensity;
        const known = bp > -900 && nd > -900;

        this.signal.push({
            timestamp: new Date(now).toISOString(),
            basebandPower: bp > -900 ? bp.toFixed(2) : 'N/A',
            noiseDensity: nd > -900 ? nd.toFixed(2) : 'N/A',
            snr: known ? Math.max(0, bp - nd).toFixed(2) : 'N/A',
        });
    }

    _runTimer() {
        clearInterval(this._timer);
        this._timer = setInterval(() => {
            if (this.state !== 'recording') return;

            // A mode change can change the stream rate, and the player answers
            // that by building a fresh AudioContext — which leaves every node
            // here attached to one that no longer plays anything. Stop with an
            // explanation rather than silently recording nothing.
            if (this.player.contextEpoch !== this._epoch) {
                this.stop('Audio was restarted (sample rate changed), so the recording was stopped there.');
                return;
            }
            // Switching the receiver off suspends the context rather than
            // closing it, which would otherwise record minutes of silence.
            if (!this.player.ctx || this.player.ctx.state !== 'running') {
                this.stop('Audio stopped, so the recording was stopped there.');
                return;
            }

            const now = Date.now();
            if (this._sample && now - this._lastSignalAt >= SIGNAL_MS) {
                this._lastSignalAt = now;
                this._pushSignal(now);
            }

            if (now - this.startedAt >= MAX_RECORDING_MS) {
                this.stop(`Stopped automatically at the ${MAX_RECORDING_MS / 60000} minute limit.`);
            }
        }, TICK_MS);
    }

    // Hands the recording to the browser. Awaits the encoder's last chunk
    // first, so a download taken immediately after Stop is complete.
    // (Named `save`, not `download`, so it does not shadow the unrelated
    // helper of that name in lib/localBookmarks.js.)
    //
    // `archive` is the whole ZIP — audio, metadata and the signal log — which
    // is what this has always produced and what the panel asks for by default.
    // Without it the audio file goes over on its own: a recording somebody
    // wants to send to a friend, put in a decoder or drop into an editor is one
    // file, and unwrapping a ZIP to get at it is a step for nothing. Nothing
    // else differs — same bytes, same name, no second encode either way.
    async save({ archive = true } = {}) {
        if (!this.hasData && this.state !== 'recording') {
            throw new Error('There is no recording to download.');
        }
        // Shared with the Play button rather than encoded again here: for WAV
        // that is the difference between one 58 MB encode and two.
        const audio = await this.audioBlob();
        if (!audio) throw new Error('There is no recording to download.');

        const wav = this.format === 'wav';
        const base = `sdr-recording-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;
        const name = `${base}.${wav ? 'wav' : 'webm'}`;

        // Before JSZip is even fetched: the audio-only route has no business
        // waiting on a library it is not going to use, and on a phone with a
        // poor connection that was the slowest part of a download that did not
        // need it.
        if (!archive) {
            await saveFile(audio, name);
            return;
        }

        await loadScript(JSZIP_URL);
        if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load.');

        const zip = new JSZip();
        zip.file(name, audio);
        zip.file(`${base}.txt`, this._metadataText());
        zip.file(`${base}-signal.csv`, this._signalCsv());

        const blob = await zip.generateAsync({ type: 'blob' });
        await saveFile(blob, `${base}.zip`);
    }

    // Byte-for-byte v1's metadata file (recorder.js downloadRecording). People
    // archive these next to the audio and grep them later, so the layout, the
    // field order, the conditions on each optional line and the number
    // formatting are all reproduced rather than reinterpreted. Anything here
    // that looks arbitrary is arbitrary in v1 too — change both or neither.
    _metadataText() {
        const m = this.meta || {};
        const rx = m.receiver;

        // v1 emits the block whenever the server described a receiver at all,
        // even if every field inside it turns out to be empty.
        let instanceInfo = '';
        if (rx) {
            const gps = rx.gps;
            instanceInfo = 'Receiver Information:\n';
            instanceInfo += '---------------------\n';
            if (rx.callsign) instanceInfo += `Callsign: ${rx.callsign}\n`;
            if (rx.name) instanceInfo += `Name: ${rx.name}\n`;
            if (rx.location) instanceInfo += `Location: ${rx.location}\n`;
            // Both coordinates must be non-zero: 0,0 is the config default.
            if (gps && gps.lat !== 0 && gps.lon !== 0) {
                instanceInfo += `Latitude: ${gps.lat.toFixed(6)}\n`;
                instanceInfo += `Longitude: ${gps.lon.toFixed(6)}\n`;
                if (gps.maidenhead) instanceInfo += `Maidenhead: ${gps.maidenhead}\n`;
            }
            if (rx.asl) instanceInfo += `Altitude: ${rx.asl}m ASL\n`;
            if (rx.antenna) instanceInfo += `Antenna: ${rx.antenna}\n`;
            instanceInfo += '\n';
        }

        const durationSec = Math.floor(this.elapsedMs / 1000);
        // Minutes deliberately unpadded, seconds padded — as v1 writes it.
        const durationStr = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`;

        const formatLine = this.format === 'wav'
            ? `Container: WAV\nCodec: PCM (16-bit signed, little-endian)\nSample Rate: ${this._rate} Hz\nChannels: ${this._channels}`
            : `Container: WebM\nCodec: Opus\nSample Rate: ${this._rate} Hz`;

        return `SDR Recording Metadata
========================

${instanceInfo}Start Time (UTC): ${new Date(this.startedAt).toISOString()}
End Time (UTC): ${this.endedAt ? new Date(this.endedAt).toISOString() : 'N/A'}
Duration: ${durationStr} (${durationSec} seconds)

Radio Settings:
--------------
Frequency: ${m.frequency} Hz (${formatFrequencyV1(m.frequency)})
Mode: ${String(m.mode || 'unknown').toUpperCase()}
Bandwidth Low: ${m.bandwidthLow} Hz
Bandwidth High: ${m.bandwidthHigh} Hz

Recording Format:
----------------
${formatLine}

Generated by UberSDR Web Client
`;
    }

    // The rows are already v1-shaped strings — see _pushSignal.
    _signalCsv() {
        let csv = 'UTC Time,Baseband Power (dBFS),Noise Density (dBFS),SNR (dB)\n';
        for (const s of this.signal) {
            csv += `${s.timestamp},${s.basebandPower},${s.noiseDensity},${s.snr}\n`;
        }
        return csv;
    }
}

// v1's formatFrequency (app.js), reproduced so the metadata file reads the
// same: 3 decimals of MHz, 1 of kHz, bare Hz below that.
function formatFrequencyV1(hz) {
    if (hz >= 1000000) return (hz / 1000000).toFixed(3) + ' MHz';
    if (hz >= 1000) return (hz / 1000).toFixed(1) + ' kHz';
    return hz + ' Hz';
}

// ---------------------------------------------------------------------------

// One recorder per page. The player is a singleton inside RadioProvider, so
// binding to the first one seen is safe; a later one would mean a second radio.
let instance = null;

export function getRecorder(player) {
    if (!instance) instance = new Recorder(player);
    else if (player && instance.player !== player) instance.player = player;
    return instance;
}

// Float32 frames -> a 16-bit PCM WAV file.
//
// The source has already been through an Opus decode, so this is not a lossless
// capture of the air — it is a lossless capture of what the browser plays, with
// no second generation of compression on top.
export function encodeWav(frames, sampleRate, channels) {
    let total = 0;
    for (const f of frames) total += f.length;

    const pcm = new Int16Array(total);
    let i = 0;
    for (const f of frames) {
        for (let j = 0; j < f.length; j++) {
            const s = f[j] < -1 ? -1 : f[j] > 1 ? 1 : f[j];
            pcm[i++] = s < 0 ? s * 32768 : s * 32767;
        }
    }

    const dataSize = pcm.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const str = (offset, s) => {
        for (let k = 0; k < s.length; k++) view.setUint8(offset + k, s.charCodeAt(k));
    };

    str(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);                       // PCM header length
    view.setUint16(20, 1, true);                        // format: PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true); // byte rate
    view.setUint16(32, channels * 2, true);              // block align
    view.setUint16(34, 16, true);                        // bits per sample
    str(36, 'data');
    view.setUint32(40, dataSize, true);
    new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));

    return buffer;
}

// mm:ss, the clock the panel shows.
/**
 * How long a held recording runs for, in ms, for a progress bar to divide by.
 *
 * `elDuration` is the <audio> element's own `duration` and is preferred when it
 * is usable: it is the file's length rather than the wall clock's. It often is
 * not usable. MediaRecorder writes WebM with no duration in the header, so an
 * Opus recording reports `Infinity` until the element has been seeked — feed
 * that to a bar and every position divides to zero width. It can also be NaN
 * before metadata has loaded, and 0 for an empty source.
 *
 * `elapsedMs` is the recorder's own wall-clock length and is always a number,
 * which is what makes it the fallback rather than a guess.
 */
export function playbackDuration(elDuration, elapsedMs) {
    const fromElement = Number(elDuration) * 1000;
    if (Number.isFinite(fromElement) && fromElement > 0) return fromElement;
    return Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
}

export function formatElapsed(ms) {
    const total = Math.floor(Math.max(0, ms) / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
