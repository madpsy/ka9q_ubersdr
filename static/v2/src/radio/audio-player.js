// Opus decode + Web Audio playback.
//
// Packets arrive at roughly one per 20 ms but with network jitter, so they are
// scheduled ahead of the clock by a configurable cushion rather than played on
// arrival. When the schedule falls behind the cushion is re-primed, which is
// audible as a single gap instead of continuous stuttering.

const DEFAULT_BUFFER_SEC = 0.2;
const MIN_LEAD_SEC = 0.02;

function getOpusDecoderClass() {
    if (typeof window.OpusDecoder !== 'undefined') return window.OpusDecoder;
    const lib = window['opus-decoder'];
    if (lib && lib.OpusDecoder) return lib.OpusDecoder;
    return null;
}

// Resting FFT size. Nothing reads the analyser unless the scope panel is open,
// and a rebuilt context should not come back at whatever size that panel last
// asked for.
const ANALYSER_IDLE_FFT = 1024;

export class AudioPlayer {
    constructor() {
        this.ctx = null;
        this.gain = null;
        this.analyser = null;
        this.analyserFft = ANALYSER_IDLE_FFT;
        this.decoder = null;
        this.decoderRate = 0;
        this.decoderChannels = 0;
        this.sampleRate = 0;        // rate the context actually runs at
        this.requestedRate = 0;     // rate we asked for, which may differ
        this.nextPlayTime = 0;
        this.bufferSec = DEFAULT_BUFFER_SEC;
        this.volume = 0.7;
        this.muted = false;
        this.started = false;
        this.underruns = 0;
        this.level = 0;                 // smoothed RMS, 0..1, for the VU meter
        this._decodeChain = Promise.resolve();
    }

    get running() {
        return !!this.ctx && this.ctx.state === 'running';
    }

    // Must be called from a user gesture — browsers refuse to start audio otherwise.
    async start() {
        this.started = true;
        if (this.ctx) {
            await this.ctx.resume().catch(() => {});
            return this.running;
        }
        // Without a known stream rate yet, let the browser pick; the context is
        // rebuilt on the first packet if the rates disagree.
        this._createContext(this.sampleRate || 48000);
        await this.ctx.resume().catch(() => {});
        return this.running;
    }

    async suspend() {
        this.started = false;
        if (this.ctx) await this.ctx.suspend().catch(() => {});
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        this._applyGain();
    }

    setMuted(muted) {
        this.muted = !!muted;
        this._applyGain();
    }

    setBufferSec(sec) {
        this.bufferSec = Math.max(0.05, Math.min(2, sec));
    }

    // Feeds one Opus packet. Decoding is serialised so packets keep their order.
    pushOpus(data, sampleRate, channels) {
        if (!this.started) return;
        // Copy: `data` is a view onto the WebSocket frame, which the decoder
        // may see after the next frame has overwritten it.
        const bytes = new Uint8Array(data);
        this._decodeChain = this._decodeChain
            .then(() => this._decodeAndPlay(bytes, sampleRate, channels))
            .catch((err) => console.error('audio decode failed', err));
    }

    // JSON-PCM fallback path: already-decoded planar float samples.
    pushPCM(planes, sampleRate) {
        if (!this.started || !planes.length) return;
        this._ensureContext(sampleRate);
        this._schedule(planes, planes[0].length, sampleRate);
    }

    async _decodeAndPlay(bytes, sampleRate, channels) {
        if (!this.decoder || this.decoderRate !== sampleRate || this.decoderChannels !== channels) {
            const Decoder = getOpusDecoderClass();
            if (!Decoder) throw new Error('opus-decoder library not loaded');
            if (this.decoder) {
                try { this.decoder.free(); } catch (e) { /* ignore */ }
            }
            this.decoder = new Decoder({ sampleRate, channels });
            await this.decoder.ready;
            this.decoderRate = sampleRate;
            this.decoderChannels = channels;
        }

        const decoded = await this.decoder.decodeFrame(bytes);
        if (!decoded || !decoded.samplesDecoded) return;

        this._ensureContext(sampleRate);
        this._schedule(decoded.channelData, decoded.samplesDecoded, sampleRate);
    }

    _ensureContext(sampleRate) {
        // Compared against the *requested* rate, not the granted one: a browser
        // that refuses an unusual rate would otherwise make this rebuild the
        // context on every single packet.
        if (this.ctx && this.requestedRate === sampleRate) return;
        // A mode change can change the stream rate (e.g. 12 kHz SSB -> 24 kHz AM).
        // Resampling in an AudioBuffer costs quality, so rebuild the context to match.
        if (this.ctx) {
            const old = this.ctx;
            this.ctx = null;
            old.close().catch(() => {});
        }
        this._createContext(sampleRate);
        if (this.started) this.ctx.resume().catch(() => {});
    }

    // Called by the audio scope while it is mounted. Returns the analyser to
    // read from, or null before audio has started. Releasing drops the FFT back
    // to its resting size so a collapsed panel costs nothing.
    acquireAnalyser(fftSize) {
        this.analyserFft = fftSize;
        if (this.analyser) {
            try { this.analyser.fftSize = fftSize; } catch (e) { /* invalid size */ }
        }
        return this.analyser;
    }

    releaseAnalyser() {
        this.analyserFft = ANALYSER_IDLE_FFT;
        if (this.analyser) {
            try { this.analyser.fftSize = ANALYSER_IDLE_FFT; } catch (e) { /* ignore */ }
        }
    }

    _createContext(sampleRate) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.requestedRate = sampleRate;
        try {
            this.ctx = new Ctx({ sampleRate, latencyHint: 'playback' });
        } catch (err) {
            // Some browsers reject uncommon rates outright; the buffer source
            // will resample instead, which costs quality but keeps audio.
            this.ctx = new Ctx({ latencyHint: 'playback' });
        }
        this.sampleRate = this.ctx.sampleRate;
        this.gain = this.ctx.createGain();
        this.analyser = this.ctx.createAnalyser();
        // Sized for whoever is looking: the node is always in the graph, but it
        // only does FFT work when something reads it, and the audio scope
        // raises this while it is on screen (see acquireAnalyser).
        this.analyser.fftSize = this.analyserFft || ANALYSER_IDLE_FFT;
        this.analyser.smoothingTimeConstant = 0.5;
        this.gain.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
        this._applyGain();
        this.nextPlayTime = this.ctx.currentTime + this.bufferSec;
    }

    _applyGain() {
        if (!this.gain || !this.ctx) return;
        const target = this.muted ? 0 : this.volume;
        // Ramp rather than step, so volume changes do not click.
        this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
    }

    _schedule(planes, frames, sampleRate) {
        const ctx = this.ctx;
        if (!ctx || ctx.state === 'closed') return;

        const channels = planes.length;
        const buffer = ctx.createBuffer(channels, frames, sampleRate);
        for (let c = 0; c < channels; c++) {
            buffer.copyToChannel(planes[c].subarray(0, frames), c);
        }

        // Level meter, from the first channel — cheaper than an AnalyserNode
        // read on every animation frame and stays in sync with what is queued.
        let sum = 0;
        const p = planes[0];
        for (let i = 0; i < frames; i++) sum += p[i] * p[i];
        const rms = Math.sqrt(sum / frames);
        this.level = this.level * 0.7 + rms * 0.3;

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.gain);

        if (this.nextPlayTime < ctx.currentTime + MIN_LEAD_SEC) {
            // Fell behind: re-prime the full cushion instead of chasing the
            // clock, which would leave every later packet marginally late.
            this.nextPlayTime = ctx.currentTime + this.bufferSec;
            this.underruns++;
        }
        src.start(this.nextPlayTime);
        this.nextPlayTime += buffer.duration;
    }

    // Seconds of audio currently queued ahead of the playback clock.
    get queuedSec() {
        if (!this.ctx) return 0;
        return Math.max(0, this.nextPlayTime - this.ctx.currentTime);
    }

    destroy() {
        if (this.decoder) {
            try { this.decoder.free(); } catch (e) { /* ignore */ }
            this.decoder = null;
        }
        if (this.ctx) {
            this.ctx.close().catch(() => {});
            this.ctx = null;
        }
    }
}
