// Opus decode + Web Audio playback.
//
// Packets arrive at roughly one per 20 ms but with network jitter, so they are
// scheduled ahead of the clock by a configurable cushion rather than played on
// arrival. When the schedule falls behind the cushion is re-primed, which is
// audible as a single gap instead of continuous stuttering.

import { applyParams, buildChain, frameLevelDb, gateOpen, nextMakeupDb, shapeKey } from './audio-filters.js';
import { NRProcessor } from '../lib/nr.js';
import { NR2Processor } from '../lib/nr2.js';
import { getRmNoise } from '../lib/rmnoise.js';
import { NoiseBlanker } from '../lib/noiseBlanker.js';
import { Emitter } from './emitter.js';

// How often the gate looks at the level. 20 ms is well inside its own attack
// time, and a timer is the right tool: this must keep working with no panel
// open, which rules out hanging it off a view's animation frame.
const GATE_TICK_MS = 20;

// Clip watch. The only place audio really clips is the destination, after the
// volume control, so that is where this measures — the stages before it are
// float and can run hot without harm. The hold is what makes a badge useful:
// clipping happens on transients, and a light that is on for one frame is a
// light nobody sees.
const CLIP_TICK_MS = 50;
const CLIP_PEAK = 0.997;
const CLIP_HOLD_MS = 1200;

// The buffer setting is a *ceiling*, not a target — v1's `maxBufferMs`.
//
// v1 primes a fixed cushion and then discards anything that would push the
// queue past the ceiling (app.js playAudioBuffer: the MAX_BUFFER_SEC branch).
// That is what makes the control act at once: lowering it drops packets until
// the queue is back inside the limit, where treating it as a prime target only
// changes anything the next time playback is primed — which, while audio is
// flowing, is never.
const DEFAULT_BUFFER_SEC = 0.2;
// v1's PRIME_BUFFER_MS / MIN_BUFFER_MS, and its rule: prime at 120 ms, never
// below 40, and never more than three quarters of the ceiling.
const PRIME_SEC = 0.12;
const MIN_PRIME_SEC = 0.04;
const MIN_LEAD_SEC = 0.02;

// Exported because FreeDV decodes its own stream: the server sends it Opus
// frames of *decoded voice* on a different socket, which must not go through
// this player's scheduling or it would fight the SDR audio for the cursor.
export function getOpusDecoderClass() {
    if (typeof window.OpusDecoder !== 'undefined') return window.OpusDecoder;
    const lib = window['opus-decoder'];
    if (lib && lib.OpusDecoder) return lib.OpusDecoder;
    return null;
}

// Resting FFT size. Nothing reads the analyser unless the scope panel is open,
// and a rebuilt context should not come back at whatever size that panel last
// asked for.
const ANALYSER_IDLE_FFT = 1024;

export class AudioPlayer extends Emitter {
    constructor() {
        super();
        this.ctx = null;
        this.gain = null;
        this.analyser = null;
        this.analyserFft = ANALYSER_IDLE_FFT;
        // 'both' | 'left' | 'right'. Only meaningful on a stereo stream (IQ
        // modes, and stereo Opus); a mono stream ignores it.
        this.channelMode = 'both';
        this.channels = 0;          // channels in the stream last scheduled
        // Rate the *stream* arrives at, which is not always the rate the context
        // runs at: _createContext asks for the stream's rate and falls back to
        // the browser's default if it is refused, and the graph then resamples.
        // Reported separately so a panel can show the difference rather than
        // one number standing in for both.
        this.streamRate = 0;
        this.head = null;           // where scheduled audio enters the graph
        // Whether the stream is a quadrature pair rather than audio. Set from
        // the mode, not from the channel count, so it is known before the first
        // packet arrives — see setIQ.
        this.iq = false;
        this.chain = null;          // active EQ/notch/bandpass nodes
        this.filterSpec = null;
        // The client noise stage — blanker and NR — between `head` and the
        // filter chain, in v1's order: impulses are cut before anything else
        // measures the signal, and NR cleans what the EQ and the squelch then
        // see. `filterHead` is the stable node after the stage; the filter
        // chain hangs off that, so the two never rewire each other.
        this.filterHead = null;
        this.noiseSpec = null;
        this.nb = null;             // [left, right] NoiseBlanker instances
        this.nbNode = null;         // their ScriptProcessor
        // Whether head→…→filterHead has been joined up in the *current*
        // context. See _applyNoise.
        this._noiseWired = false;
        this.nr = null;             // [left, right] NR instances
        this.nrType = '';           // which engine the instances are
        this.nrNode = null;
        this.nrMakeup = null;       // plain gain after NR
        this.gateTimer = null;
        this.makeupTimer = null;
        this.makeupDb = 0;          // live compressor makeup, dB
        this.clipTimer = null;
        this.clipping = false;      // output hit full scale recently
        this.peakDb = -Infinity;    // output peak, dBFS
        this.outLevel = 0;          // smoothed RMS of the output, 0..1
        this._clipUntil = 0;
        this.recordTap = null;      // unity node the recorder hangs off
        this.duck = null;           // output gate, for decoders that play their own audio
        this.ducked = false;

        // Listeners on the decoded audio, ahead of every gain stage — see
        // _schedule. A Set because more than one thing may want it, and each is
        // handed the same frame rather than the graph being split.
        this.taps = new Set();
        this.sinkId = '';           // chosen output device; '' is the system default
        this.anchorWanted = false;  // Media Session needs a media element playing
        this.element = null;        // the hidden <audio> those two share
        this.local = null;          // gate on the context's own output
        this.external = false;      // something outside the graph is playing this
        // Bumped every time the context is rebuilt. A recording holds nodes
        // belonging to one context, so anything capturing audio has to notice
        // when that context has been thrown away (see lib/recorder.js).
        this.contextEpoch = 0;
        this.decoder = null;
        this.decoderRate = 0;
        this.decoderChannels = 0;
        this.sampleRate = 0;        // rate the context actually runs at
        this.requestedRate = 0;     // rate we asked for, which may differ
        this.nextPlayTime = 0;
        this.bufferSec = DEFAULT_BUFFER_SEC;
        this.dropped = 0;
        this.volume = 0.7;
        this.muted = false;
        this.started = false;
        this.underruns = 0;
        this.level = 0;                 // smoothed RMS, 0..1, for the VU meter
        // Whether a buffer has actually been scheduled since this was last
        // armed. Drives the 'flowing' event — see _schedule.
        this._flowed = true;
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

    // Gain only, and deliberately: the schedule is never flushed. Chrome keeps
    // a media session alive only while the context is genuinely producing
    // audio, so a mute that stopped scheduling would take the OS media controls
    // down with it. v1 had to special-case this because its mute *did* flush
    // the queue for instant response (app.js:7603, keepPipelineRunning); here
    // there is nothing to special-case, and nothing to reintroduce.
    setMuted(muted) {
        this.muted = !!muted;
        this._applyGain();
    }

    // Silences the receiver's own audio without touching the user's mute. See
    // the duck node in _createContext.
    /**
     * Listen to the decoded audio, before volume, mute and ducking.
     *
     * `fn(planes, frames, sampleRate)` — `planes` is one Float32Array per
     * channel, valid only for the duration of the call, so a listener that
     * keeps it must copy. Returns a function that stops the listening.
     */
    onAudio(fn) {
        this.taps.add(fn);
        return () => this.taps.delete(fn);
    }

    _tap(planes, frames, sampleRate) {
        for (const fn of Array.from(this.taps)) {
            // One listener throwing must not cost the others their audio, nor
            // interrupt playback — this runs on the decode path.
            try { fn(planes, frames, sampleRate); } catch (e) { /* not ours to fix */ }
        }
    }

    setDucked(ducked) {
        this.ducked = !!ducked;
        if (!this.duck || !this.ctx) return;
        this.duck.gain.setTargetAtTime(this.ducked ? 0 : 1, this.ctx.currentTime, 0.015);
    }

    setBufferSec(sec) {
        this.bufferSec = Math.max(0.05, Math.min(2, sec));
    }

    // The cushion to (re)start from, in seconds. Deliberately not the ceiling:
    // starting at the limit leaves no room for the jitter the ceiling exists to
    // absorb, so the first late packet would overflow it.
    _primeSec() {
        return Math.min(Math.max(PRIME_SEC, MIN_PRIME_SEC), this.bufferSec * 0.75);
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
        // Nothing from the last context survives into this one.
        //
        // The chain is nodes, and nodes belong to the AudioContext that made
        // them. Left set, the setFilters below finds a chain whose *shape*
        // matches the spec it is being given — because it is the same spec —
        // and takes the retune path: it writes the operator's settings into
        // nodes belonging to a context that has been closed, and never builds a
        // chain in this one. The audio then plays unfiltered through the direct
        // head→gain connection while every switch in the Audio filters panel
        // still reads as on.
        //
        // That is not a rare path. `start()` opens a context at 48 kHz because
        // no stream has arrived to say otherwise, and the first packet at the
        // receiver's own rate — 12 kHz on SSB — rebuilds it immediately. So a
        // receiver opened with saved filters came up with none of them working
        // until each was switched off and on again, which changes the shape key
        // and forces the rebuild this should have done.
        this.chain = null;
        // As with the chain: nodes belong to the context that made them, and
        // _applyNoise below must build fresh ones rather than reconnect these.
        this.filterHead = null;
        this.nb = null;
        this.nbNode = null;
        this.nr = null;
        this.nrNode = null;
        this.nrMakeup = null;
        this._noiseWired = false;
        clearInterval(this.gateTimer);
        this.gateTimer = null;
        clearInterval(this.makeupTimer);
        this.makeupTimer = null;
        this.makeupDb = 0;

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
        // Everything scheduled enters here, so the client-side filter chain can
        // be spliced between this and the volume control without touching the
        // packet path.
        this.head = this.ctx.createGain();
        this.gain = this.ctx.createGain();
        // Per-side output routing, as v1 does (app.js initializeStereoChannels):
        // split the stereo pair, gate each side with its own gain, merge back.
        // Because every buffer is scheduled with at least two channels, this
        // works in mono modes too — which is the whole point of the control.
        this.splitter = this.ctx.createChannelSplitter(2);
        this.leftGain = this.ctx.createGain();
        this.rightGain = this.ctx.createGain();
        this.merger = this.ctx.createChannelMerger(2);
        this.analyser = this.ctx.createAnalyser();
        // Sized for whoever is looking: the node is always in the graph, but it
        // only does FFT work when something reads it, and the audio scope
        // raises this while it is on screen (see acquireAnalyser).
        this.analyser.fftSize = this.analyserFft || ANALYSER_IDLE_FFT;
        this.analyser.smoothingTimeConstant = 0.5;
        // head reaches gain through the noise stage and the filter chain:
        // head -> [blanker] -> [NR] -> filterHead -> [EQ/notch/...] -> gain.
        // _applyNoise wires the first half, setFilters the second.
        this.filterHead = this.ctx.createGain();
        this.filterHead.connect(this.gain);
        this._applyNoise();
        this.gain.connect(this.splitter);
        this.splitter.connect(this.leftGain, 0);
        this.splitter.connect(this.rightGain, 1);
        this.leftGain.connect(this.merger, 0, 0);
        this.rightGain.connect(this.merger, 0, 1);
        // The analyser sits after the routing, so the audio scope shows what is
        // actually being played.
        this.merger.connect(this.analyser);
        // The duck sits between the analyser and the speakers, and nowhere
        // else. A decoder that produces its own audio — FreeDV — has to silence
        // the receiver while it plays, and doing that with the user's mute
        // would both lie about the mute button and silence the decoder too.
        // Here it stops only what is being played: the recorder tap, the audio
        // scope and QRSS all still see the receiver.
        this.duck = this.ctx.createGain();
        this.duck.gain.value = this.ducked ? 0 : 1;
        this.analyser.connect(this.duck);
        // The last node before whatever is playing the audio, and the only one
        // the output routing touches — see _applyOutput. It is also the gate
        // that goes to zero when something outside this graph has taken over
        // playback (the Media Session HTTP stream), which must silence the
        // speakers without disturbing the meters, the scope or the recorder.
        this.local = this.ctx.createGain();
        this.local.gain.value = this.external ? 0 : 1;
        this.duck.connect(this.local);
        this.local.connect(this.ctx.destination);
        // Recorder tap, at the point v1 takes it (app.js "Step 10"): after the
        // filter chain and the volume/mute fader, but before the L/R output
        // routing — so a recording holds the processed audio as heard, in both
        // channels, whichever side the operator happens to be listening on.
        this.recordTap = this.ctx.createGain();
        this.gain.connect(this.recordTap);
        this.contextEpoch++;
        this._applyGain();
        this._applyChannelMode();
        if (this.filterSpec) this.setFilters(this.filterSpec);
        // A new context always comes up on the system device, and any element
        // built for the old one belongs to a context that is being thrown away
        // — so the routing has to be re-applied, not just remembered.
        if (this.sinkId || this.anchorWanted) {
            this._applyOutput().catch((err) => console.warn('audio output lost on rebuild', err));
        }
        this._runClipWatch();
        // A new context has produced nothing yet, so anyone waiting to hear
        // that audio is really playing has to be told again.
        this._flowed = false;
        this.nextPlayTime = this.ctx.currentTime + this._primeSec();
    }

    // ---- output routing ----------------------------------------------------
    //
    // Two features want the tail of this graph, and they compose rather than
    // fight because there is one element between them:
    //
    //   the output-device picker — a browser without AudioContext.setSinkId can
    //       still point an <audio> element at a device, so the audio goes out
    //       through one.
    //   Media Session — Safari and Firefox show no OS controls unless a media
    //       element is playing, so they need one to exist whatever device it is
    //       pointed at.
    //
    // v1 builds a separate hidden element for each and therefore has to switch
    // Media Session off the moment a device is chosen (app.js setOutputDevice).
    // Here `_applyOutput` is the single place that decides, and both can be on.

    // Chooses the output device. '' is the system default. Rejects if the
    // browser refuses the device, having left audio on whatever was playing it.
    async setSinkId(id) {
        this.sinkId = id || '';
        await this._applyOutput();
    }

    // Media Session asking for a media element to anchor the OS controls to.
    async setAnchorWanted(wanted) {
        this.anchorWanted = !!wanted;
        await this._applyOutput();
    }

    // The element the anchor ended up being, or null. Media Session only needs
    // to know that one exists and is playing.
    get outputElement() {
        return this.element;
    }

    // Something outside this graph has taken over playback — the Media Session
    // HTTP stream, which the server feeds *instead of* the WebSocket. Silence
    // the speakers, but leave the graph running: the analyser, the recorder tap
    // and the meters all sit upstream of this gate.
    setExternalPlayback(external) {
        this.external = !!external;
        if (!this.local || !this.ctx) return;
        this.local.gain.setTargetAtTime(this.external ? 0 : 1, this.ctx.currentTime, 0.02);
        // Removing the element that was driving playback can leave the context
        // suspended, and a suspended context schedules nothing.
        if (!this.external) this.ctx.resume().catch(() => {});
    }

    async _applyOutput() {
        const ctx = this.ctx;
        // Nothing to route yet — _createContext applies it when audio starts.
        if (!ctx) return;

        const contextSink = typeof ctx.setSinkId === 'function';
        // The element is needed when Media Session asks for one, or when a
        // device has been chosen on a browser that can only do it per element.
        const needElement = this.anchorWanted || (!!this.sinkId && !contextSink);

        if (!needElement) {
            this._releaseOutputElement();
            if (contextSink) await ctx.setSinkId(this.sinkId || '');
            return;
        }

        // Firefox only accepts a device ID it has handed out in this session,
        // so the device list has to have been read at least once first.
        if (this.sinkId && navigator.mediaDevices) {
            await navigator.mediaDevices.enumerateDevices().catch(() => {});
            if (this.ctx !== ctx) return;
        }

        if (!this.element) {
            const el = document.createElement('audio');
            // iOS refuses to play inline without this and takes the audio
            // fullscreen instead, which is not a thing a hidden element can do.
            el.setAttribute('playsinline', '');
            el.style.display = 'none';
            document.body.appendChild(el);
            this.element = el;
        }
        const el = this.element;
        if (!el._dest || el._dest.context !== ctx) {
            el._dest = ctx.createMediaStreamDestination();
            el.srcObject = el._dest.stream;
        }

        // Point the element at the device *before* diverting the audio into it:
        // a rejected device then leaves playback on the speakers rather than
        // dumping it into a stream nobody is listening to.
        if (this.sinkId && typeof el.setSinkId === 'function') {
            await el.setSinkId(this.sinkId);
        }
        // A mode change during that await rebuilds the context, and its nodes
        // cannot be wired to a destination belonging to the old one. The new
        // context re-applies the routing itself, so dropping out loses nothing.
        if (this.ctx !== ctx) return;

        try { this.local.disconnect(); } catch (e) { /* not connected */ }
        this.local.connect(el._dest);
        // Autoplay policy can block this; audio starts from a user gesture, so
        // in practice it does not, and a failure here is silence that retrying
        // would not fix.
        await el.play().catch((err) => console.warn('output element blocked', err));
    }

    // Drops the element and puts the output back on the context's own
    // destination. A no-op when no element was ever built.
    _releaseOutputElement() {
        const el = this.element;
        if (!el) return;
        try { el.pause(); } catch (e) { /* ignore */ }
        el.srcObject = null;
        el._dest = null;
        if (el.parentNode) el.parentNode.removeChild(el);
        this.element = null;
        if (this.ctx && this.local) {
            try { this.local.disconnect(); } catch (e) { /* ignore */ }
            this.local.connect(this.ctx.destination);
        }
    }

    _applyGain() {
        if (!this.gain || !this.ctx) return;
        const target = this.muted ? 0 : this.volume;
        // Ramp rather than step, so volume changes do not click.
        this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
    }

    // Rebuilds the EQ/notch/bandpass chain from a plain spec. Cheap enough to
    // do on every change: biquads are a handful of coefficients, and rebuilding
    // avoids the bookkeeping of reconnecting a chain whose shape can change.
    setFilters(spec) {
        this.filterSpec = spec;
        if (!this.ctx || !this.filterHead) return;

        // Stored above, ignored here while the stream is I/Q — see setIQ. The
        // spec is kept so leaving IQ puts the operator's filters back exactly
        // as they were rather than silently resetting them.
        const active = this.iq ? null : spec;

        // Same graph, different numbers: retune it. Rebuilding on every slider
        // move tore the audio, because tearing the chain down drops whatever
        // was in flight through it.
        if (this.chain && active && this.chain.shape === shapeKey(active)) {
            applyParams(this.chain, active, this.ctx);
            return;
        }

        clearInterval(this.gateTimer);
        this.gateTimer = null;
        clearInterval(this.makeupTimer);
        this.makeupTimer = null;
        this.makeupDb = 0;

        try { this.filterHead.disconnect(); } catch (e) { /* not connected yet */ }
        if (this.chain) {
            for (const n of this.chain.nodes) {
                try { n.disconnect(); } catch (e) { /* ignore */ }
            }
            this.chain = null;
        }

        const chain = active ? buildChain(this.ctx, active) : null;
        if (chain) {
            this.filterHead.connect(chain.input);
            chain.output.connect(this.gain);
            this.chain = chain;
            if (chain.gate) this._runGate(chain.gate);
            if (chain.compressor) this._runMakeup(chain.compressor);
        } else {
            this.filterHead.connect(this.gain);
        }
    }

    // ---- client noise stage ------------------------------------------------
    //
    // ScriptProcessorNode on purpose, not AudioWorklet: the worklet needs a
    // secure context, and this interface is routinely served plain over a LAN.
    // v1 made the same choice for the same reason. The NR buffer is 1024 where
    // v1 used 2048 — both engines hop in 256 or 512 samples, so the larger
    // buffer bought nothing but 85 ms of extra latency.
    // The nodes exist only while their stage is on — a bypassed
    // ScriptProcessor still costs a JS callback per buffer, so off is absent.

    /** `{ nb: { enabled, thresholdDb, widthMs }, nr: { enabled, strength, floor, adaptRate, makeupDb } }` */
    setNoise(spec) {
        this.noiseSpec = spec;
        if (this.ctx && this.filterHead) this._applyNoise();
    }

    /**
     * Whether the stream carries I/Q rather than demodulated audio.
     *
     * When it does, every stage between `head` and `gain` is wired out: the
     * blanker, NR, the gate, the bandpass, the notches, the EQ, the compressor
     * and the stereo widener. Not because they would crash — most of them are
     * already per-channel — but because they are all *signal-dependent gain*,
     * and applying it to I and Q independently is no longer the same complex
     * signal. The widener is the plainest case: it synthesises a stereo pair
     * from one channel, so it would overwrite Q outright.
     *
     * What is left in the graph is safe: volume, mute, ducking and the L/R
     * routing are constant scalars, and scaling I and Q by the same number is
     * only amplitude. (The one exception is choosing a single side, which
     * silences I or Q — that is the operator asking for it.)
     *
     * The specs themselves are untouched, so this is reversible: leaving IQ
     * re-applies whatever was set before, without the panels having to know
     * anything about modes.
     */
    setIQ(on) {
        const next = !!on;
        if (next === this.iq) return;
        this.iq = next;
        if (!this.ctx || !this.filterHead) return;
        this._applyNoise();
        this.setFilters(this.filterSpec);
    }

    /**
     * Impulses the blanker has cut since it was switched on — 0 while it is
     * off, and it restarts from 0 when toggled, because the instances are
     * rebuilt then. The max of the two channels: on the usual mono-duplicated
     * stream they agree, and on IQ either channel's pulse was a real pulse.
     */
    nbPulses() {
        if (!this.nb) return 0;
        return Math.max(this.nb[0].pulsesBlanked, this.nb[1].pulsesBlanked);
    }

    /** Share of the audio the blanker is removing right now, 0..1. */
    nbCut() {
        if (!this.nb) return 0;
        return Math.max(this.nb[0].cutFraction, this.nb[1].cutFraction);
    }

    /**
     * The blanker's recent history for the panel's chart, or null when it is
     * not running. One channel's worth — on the usual mono-duplicated stream
     * the two are the same picture, and two traces drawn over each other would
     * say nothing the one does not.
     *
     * The arrays are the live ones, not copies: this is read on the same
     * thread that writes them, a frame's worth of data either way, and a copy
     * per redraw would be the only allocation in the whole path.
     */
    /** How much quieter the blanker's output is than its input, in dB. */
    nbReductionDb() {
        if (!this.nb) return 0;
        return Math.min(this.nb[0].reductionDb, this.nb[1].reductionDb);
    }

    nbTrace() {
        if (!this.nb) return null;
        const b = this.nb[0];
        return { db: b.traceDb, cut: b.traceCut, head: b.traceHead };
    }

    /** The NR noise profile is per-frequency; the radio calls this on retune. */
    resetNoiseLearning() {
        if (this.nr) for (const n of this.nr) n.resetLearning();
    }

    /** The stream's rate changed under the network denoiser — see its own note. */
    noiseSampleRateChanged(rate) {
        if (this.nrType === 'rmn') getRmNoise().onSampleRateChange(rate);
    }

    _applyNoise() {
        const spec = this.iq ? {} : (this.noiseSpec || {});
        const nbOn = !!(spec.nb && spec.nb.enabled);
        const nrOn = !!(spec.nr && spec.nr.enabled);
        const nrType = spec.nr && ['nr2', 'rmn'].includes(spec.nr.type) ? spec.nr.type : 'lsa';

        // Same stages, same engine, *and already wired into this context*:
        // retune the instances in place. Sliders move often, and rebuilding a
        // ScriptProcessor per move would tear the audio the way rebuilding
        // biquads used to (see setFilters).
        //
        // `_noiseWired` is not a formality. Without it the fast path was taken
        // on a *fresh* context whenever both stages were off — nbNode and
        // nrNode are null then, which matches "no stages wanted" exactly — and
        // it returned before connecting head to filterHead. The graph was left
        // with nothing joining the audio to the output, so the receiver came
        // up silent and stayed silent until something toggled a stage and
        // forced the rebuild that does the wiring.
        if (this._noiseWired && !!this.nbNode === nbOn && !!this.nrNode === nrOn
            && (!nrOn || this.nrType === nrType)) {
            this._tuneNoise(spec);
            return;
        }

        // Leaving the network engine means leaving the service: audio going
        // to somebody else's servers for a stage nobody is listening through
        // is their bandwidth and the operator's account, spent on nothing.
        // Not a manual stop — choosing it again reconnects.
        if (this.nrType === 'rmn' && !(nrOn && nrType === 'rmn')) {
            getRmNoise().disconnect();
        }

        try { this.head.disconnect(); } catch (e) { /* not connected yet */ }
        for (const n of [this.nbNode, this.nrNode, this.nrMakeup]) {
            if (n) try { n.disconnect(); } catch (e) { /* ignore */ }
        }
        this.nb = null;
        this.nbNode = null;
        this.nr = null;
        this.nrNode = null;
        this.nrMakeup = null;

        // Blanker first, then NR — the order is the point, not an accident of
        // how this reads. An impulse is exactly what a spectral noise model
        // must not learn, so the clicks have to be gone before anything
        // estimates a noise floor from the audio; the other way round, every
        // crash would teach NR that the band is louder than it is, and the
        // subtraction would follow it. Same order v1 uses, and the same order
        // a receiver puts its IF blanker ahead of everything else.
        let node = this.head;

        if (nbOn) {
            // One blanker per channel. The stream is usually mono duplicated,
            // where the second costs the same arithmetic on the same numbers —
            // but IQ modes are genuinely stereo, and a single instance fed
            // both channels in turn would corrupt its own envelope and delay
            // line. (v1 shared one; that was a bug, not a saving.)
            const nbs = [new NoiseBlanker(this.ctx.sampleRate), new NoiseBlanker(this.ctx.sampleRate)];
            for (const b of nbs) b.enabled = true;
            const proc = this.ctx.createScriptProcessor(512, 2, 2);
            proc.onaudioprocess = (e) => {
                for (let ch = 0; ch < 2; ch++) {
                    nbs[ch].process(e.inputBuffer.getChannelData(ch), e.outputBuffer.getChannelData(ch));
                }
            };
            node.connect(proc);
            node = proc;
            this.nb = nbs;
            this.nbNode = proc;
        }

        if (nrOn) {
            this.nrType = nrType;
            const proc = this.ctx.createScriptProcessor(1024, 2, 2);

            if (nrType === 'rmn') {
                // Somebody else's denoiser, over the network — one mono stream,
                // not one per channel: the two channels of this stream are the
                // same audio, and sending both would be twice the bandwidth and
                // twice the bill for the same answer. Channel 0 goes, and what
                // comes back is written to both.
                //
                // `process` returns null until the far end is ready, which is
                // "play what you already had" — the whole stage is a passthrough
                // until the login, the signalling and the data channel are all
                // done.
                const rm = getRmNoise();
                this.nr = null;
                proc.onaudioprocess = (e) => {
                    const inL = e.inputBuffer.getChannelData(0);
                    const outL = e.outputBuffer.getChannelData(0);
                    const outR = e.outputBuffer.getChannelData(1);
                    let done = null;
                    try {
                        done = rm.process(inL, e.inputBuffer.sampleRate || this.sampleRate);
                    } catch (err) {
                        done = null;
                    }
                    if (done) { outL.set(done); outR.set(done); } else { outL.set(inL); outR.set(inL); }
                };
                node.connect(proc);
                this.nrMakeup = this.ctx.createGain();
                proc.connect(this.nrMakeup);
                node = this.nrMakeup;
                this.nrNode = proc;
                this._tuneNoise(spec);
                node.connect(this.filterHead);
                this._noiseWired = true;
                return;
            }

            const nrs = nrType === 'nr2'
                ? [new NR2Processor(2048, 4), new NR2Processor(2048, 4)]
                : [new NRProcessor(this.ctx.sampleRate), new NRProcessor(this.ctx.sampleRate)];
            for (const r of nrs) r.enabled = true;
            proc.onaudioprocess = (e) => {
                for (let ch = 0; ch < 2; ch++) {
                    nrs[ch].process(e.inputBuffer.getChannelData(ch), e.outputBuffer.getChannelData(ch));
                }
            };
            node.connect(proc);
            // Makeup after the subtraction, exactly as v1 hangs it.
            this.nrMakeup = this.ctx.createGain();
            proc.connect(this.nrMakeup);
            node = this.nrMakeup;
            this.nr = nrs;
            this.nrNode = proc;
        }

        node.connect(this.filterHead);
        this._noiseWired = true;
        this._tuneNoise(spec);
    }

    _tuneNoise(spec) {
        if (this.nb && spec.nb) {
            for (const b of this.nb) {
                b.setParameters({ thresholdDb: spec.nb.thresholdDb, widthMs: spec.nb.widthMs });
            }
        }
        // No instances for the network engine — its settings are an account and
        // a model number, and they live on the bridge.
        if (this.nr && spec.nr) {
            for (const r of this.nr) {
                if (this.nrType === 'nr2') r.setParameters(spec.nr.strength, spec.nr.floor, spec.nr.adaptRate);
                else r.setParameters(spec.nr.strength);
            }
        }
        if (this.nrMakeup && spec.nr) {
            this.nrMakeup.gain.value = Math.pow(10, (Number(spec.nr.makeupDb) || 0) / 20);
        }
    }

    // Watches the output for full scale, so the UI can say so rather than
    // leaving the operator to wonder whether the crunch is the band or us.
    _runClipWatch() {
        clearInterval(this.clipTimer);
        let buf = new Float32Array(this.analyser.fftSize);

        this.clipTimer = setInterval(() => {
            const a = this.analyser;
            // A suspended or closed context produces nothing, so the meter
            // reads nothing rather than freezing on whatever was playing when
            // it stopped — a bar left half lit with the receiver off is a
            // reading, and a wrong one.
            if (!this.ctx || this.ctx.state !== 'running' || !a) {
                this.outLevel = 0;
                return;
            }
            if (buf.length !== a.fftSize) buf = new Float32Array(a.fftSize);
            a.getFloatTimeDomainData(buf);

            let peak = 0;
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
                const s = buf[i];
                const v = s < 0 ? -s : s;
                if (v > peak) peak = v;
                sum += s * s;
            }
            this.peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

            // The output VU, from the buffer already in hand — the sum costs
            // one multiply per sample on a loop that is walking the array
            // anyway. Distinct from `level`, which is the RMS of the decoded
            // packet before the volume control: this one is what is coming out
            // of the speakers, so it follows the volume slider and falls to
            // nothing on mute, which is what a meter beside that slider has to
            // do. Smoothed at the rate `level` is, so the two meters move alike.
            this.outLevel = this.outLevel * 0.7 + Math.sqrt(sum / buf.length) * 0.3;

            const now = performance.now();
            if (peak >= CLIP_PEAK) this._clipUntil = now + CLIP_HOLD_MS;
            this.clipping = now < this._clipUntil;
        }, CLIP_TICK_MS);
    }

    // Auto makeup, from what the compressor is really doing *and* what the
    // output is really peaking at — see nextMakeupDb. Runs at 40 ms, which is
    // fast enough to catch a peak building before it lands on the limiter.
    _runMakeup(comp) {
        const buf = new Float32Array(comp.meter.fftSize);

        this.makeupTimer = setInterval(() => {
            if (!this.ctx) return;

            // Float, not byte: byte time-domain data is clamped to +/-1, so an
            // overshoot would read as exactly full scale and the loop could not
            // tell "just right" from "far too loud".
            comp.meter.getFloatTimeDomainData(buf);
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = buf[i] < 0 ? -buf[i] : buf[i];
                if (v > peak) peak = v;
            }
            const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

            this.makeupDb = nextMakeupDb({
                current: this.makeupDb,
                reductionDb: comp.node.reduction,
                peakDb,
            });
            comp.makeup.gain.setTargetAtTime(
                Math.pow(10, this.makeupDb / 20), this.ctx.currentTime, 0.05,
            );
        }, 40);
    }

    // The gate is a gain node the player rides: Web Audio has no gate, and
    // doing it per sample would mean a worklet for something a 50 Hz control
    // signal handles perfectly well.
    _runGate(gate) {
        const wave = new Uint8Array(gate.watch.fftSize);
        gate.since = performance.now();

        this.gateTimer = setInterval(() => {
            if (!this.ctx) return;
            gate.watch.getByteTimeDomainData(wave);
            const level = frameLevelDb(wave);
            const now = performance.now();
            const open = gateOpen(level, gate.spec.threshold, gate.open);

            // Hold: once open, stay open for a while after the signal drops, so
            // the gaps between words do not get chopped.
            if (open !== gate.open) {
                if (!open && now - gate.since < gate.spec.hold) return;
                gate.open = open;
                gate.since = now;

                const target = open ? 1 : Math.pow(10, -Math.abs(gate.spec.depth) / 20);
                const ms = open ? gate.spec.attack : gate.spec.release;
                // setTargetAtTime reaches ~95% in three time constants, so the
                // control reads as the time it actually takes.
                gate.duck.gain.setTargetAtTime(
                    target, this.ctx.currentTime, Math.max(0.001, ms / 1000) / 3,
                );
            } else if (open) {
                gate.since = now;
            }
        }, GATE_TICK_MS);
    }

    setChannelMode(mode) {
        this.channelMode = mode === 'left' || mode === 'right' ? mode : 'both';
        this._applyChannelMode();
    }

    _applyChannelMode() {
        if (!this.leftGain || !this.rightGain || !this.ctx) return;
        const m = this.channelMode;
        const t = this.ctx.currentTime;
        this.leftGain.gain.setTargetAtTime(m === 'right' ? 0 : 1, t, 0.01);
        this.rightGain.gain.setTargetAtTime(m === 'left' ? 0 : 1, t, 0.01);
    }

    _schedule(planes, frames, sampleRate) {
        // Anything listening for the raw audio gets it here, before the graph
        // below and therefore before volume, mute and ducking.
        //
        // That is the point rather than an oversight: a client taking this
        // stream is not listening to the speakers — it is a TCI client feeding
        // a decoder, or a recorder — and it must go on receiving audio while
        // the operator has the receiver muted, turned down, or ducked by a
        // transmitting rig. Muting the speakers is about this room; the stream
        // is about somebody else's software.
        if (this.taps.size) this._tap(planes, frames, sampleRate);

        const ctx = this.ctx;
        if (!ctx || ctx.state === 'closed') return;

        // Always at least two channels, with a mono stream duplicated into both
        // — v1 does the same. The output routing above can then select a side
        // in any mode, rather than only on the stereo IQ modes.
        this.channels = planes.length;
        this.streamRate = sampleRate;
        const channels = Math.max(2, planes.length);
        const buffer = ctx.createBuffer(channels, frames, sampleRate);
        for (let c = 0; c < channels; c++) {
            buffer.copyToChannel((planes[c] || planes[0]).subarray(0, frames), c);
        }

        // Level meter, from what is actually being played — cheaper than an
        // AnalyserNode read on every animation frame and in sync with the queue.
        let sum = 0;
        const p = planes[0];
        for (let i = 0; i < frames; i++) sum += p[i] * p[i];
        const rms = Math.sqrt(sum / frames);
        this.level = this.level * 0.7 + rms * 0.3;

        if (this.nextPlayTime < ctx.currentTime + MIN_LEAD_SEC) {
            // Fell behind: re-prime the cushion instead of chasing the clock,
            // which would leave every later packet marginally late.
            this.nextPlayTime = ctx.currentTime + this._primeSec();
            this.underruns++;
        } else if (this.nextPlayTime - ctx.currentTime > this.bufferSec) {
            // Past the ceiling: drop this packet rather than let the delay
            // accumulate. v1 does the same, and it is what turns the slider
            // into a control you can feel — the queue is back inside a new,
            // lower limit within a second of moving it, where a prime-time
            // target would not change anything until the next restart.
            this.dropped++;
            return;
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.head);
        src.start(this.nextPlayTime);
        this.nextPlayTime += buffer.duration;

        // Emitted from here rather than from start() or the socket, because
        // this is the first moment the browser has actually been handed audio
        // to play. Once per arming, so it costs nothing per buffer.
        if (!this._flowed) {
            this._flowed = true;
            this.emit('flowing', this.contextEpoch);
        }
    }

    // Ask to be told, once, when audio is next genuinely playing.
    //
    // This exists for Media Session. Chrome builds its media session from real
    // Web Audio output, not from the metadata assignment — so metadata set at
    // the moment the operator flicks the switch attaches to nothing and the OS
    // shows nothing, forever. v1 hit the same wall and answered it the same
    // way, activating from inside its playback loop on the first buffer after
    // enabling (app.js:5612, "Activated with real audio flowing").
    //
    // Armed rather than latched, because "the context was rebuilt" and "the
    // feature was just switched on" both need the same notice, and only the
    // first of those is something the player can see for itself.
    armFlowing() {
        this._flowed = false;
    }

    // Seconds of audio currently queued ahead of the playback clock.
    get queuedSec() {
        if (!this.ctx) return 0;
        return Math.max(0, this.nextPlayTime - this.ctx.currentTime);
    }

    // What the audio hardware adds after that, in seconds.
    //
    // The queue above is the part this client controls; this is the part it
    // cannot — the buffer between the context and the speakers. Reported by
    // Chrome and Firefox as `outputLatency`, an estimate of the real thing;
    // Safari has only `baseLatency`, which is the context's own contribution and
    // an underestimate rather than nothing. Zero where neither exists, so a
    // total built on this is never worse than the queue alone.
    get outputLatencySec() {
        if (!this.ctx) return 0;
        const out = this.ctx.outputLatency;
        if (Number.isFinite(out) && out > 0) return out;
        const base = this.ctx.baseLatency;
        return Number.isFinite(base) && base > 0 ? base : 0;
    }

    destroy() {
        if (this.decoder) {
            try { this.decoder.free(); } catch (e) { /* ignore */ }
            this.decoder = null;
        }
        this._releaseOutputElement();
        if (this.ctx) {
            this.ctx.close().catch(() => {});
            this.ctx = null;
        }
    }
}
