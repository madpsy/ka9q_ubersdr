// Playing several streams of audio that are not the receiver's own — each to
// any output device the browser knows about, on the left, the right or both.
//
// The receiver's audio has one route, through its filter chain to its output.
// Audio demodulated on the page is not that audio and must not go through that
// chain, but it is what is being listened to, so it follows the receiver's
// volume and mute. Each stream is a voice:
//
//     buffer source ─► voice gain (mute) ─► panner (L/C/R) ─► out
//
// and `out` is either the master — into the receiver's own output bus, so it
// goes wherever the receiver's audio goes — or an output of its own on a chosen
// device: a gain carrying the volume and mute, into a MediaStream, played by a
// hidden <audio> element pointed at the device with setSinkId. That is the only
// way one audio context reaches several devices at once. The stream is stereo,
// so the panner ahead of it still picks the ear: two voices can share one pair
// of headphones, one in each ear, while a third plays on the speakers.
//
// A device that refuses — unplugged since it was chosen, or not one this
// browser will hand to a page — falls back to the receiver's output rather than
// going silent, and says why (errorFor).
//
// The same arrangement as the IQ Demod panel's engine (lib/iqDemod.js), keyed
// by name rather than by position, for the playground's Audio out blocks.

import { MIN_BLOCK_SEC } from '../radio/constants.js';

// How far ahead the first buffer is scheduled, and how far behind the clock the
// queue may fall before a block is dropped rather than played late — the same
// figures, for the same reasons, as lib/iqDemod.js.
const LEAD_IN_SEC = 0.02;
const MAX_QUEUE_SEC = 0.5;

/** Where each channel choice sits, as a StereoPanner position. */
export const CHANNEL_PAN = { left: -1, both: 0, right: 1 };

export class AudioRoutes {
    /**
     * `player` is the receiver's AudioPlayer: its context and output bus are
     * where everything is built. `onChange` hears about a device that refused.
     */
    constructor(player, onChange = () => {}) {
        this.player = player;
        this.onChange = onChange;
        this.voices = new Map();
        this._sinks = new Map();
        this._master = null;
        this._ctx = null;
        this._volume = 1;
        this._muted = false;
    }

    /** The receiver's volume and mute, applied to every output. */
    setOutput(volume, muted) {
        this._volume = Number.isFinite(volume) ? volume : 1;
        this._muted = !!muted;
        if (!this._ctx) return;
        const level = this._muted ? 0 : this._volume;
        const outs = [this._master, ...Array.from(this._sinks.values(), (o) => o.gain)];
        for (const g of outs) {
            if (g) g.gain.setTargetAtTime(level, this._ctx.currentTime, 0.015);
        }
    }

    /** Why the device `id` is not being used, or null. */
    errorFor(id) {
        const out = id ? this._sinks.get(id) : null;
        return out ? out.error : null;
    }

    /**
     * Schedule one block of `key`'s audio: `samples` is `frames` long at
     * `rate`. The array is copied before this returns.
     */
    play(key, samples, frames, rate, { device = '', channel = 'both', muted = false } = {}) {
        const ctx = this._ensure();
        if (!ctx || !frames) return;
        const voice = this._voice(key);
        this._route(voice, device);
        const now = ctx.currentTime;
        if (voice.channel !== channel) {
            voice.channel = channel;
            if (voice.panner) voice.panner.pan.setTargetAtTime(CHANNEL_PAN[channel] || 0, now, 0.015);
        }
        if (voice.muted !== muted) {
            voice.muted = muted;
            voice.gain.gain.setTargetAtTime(muted ? 0 : 1, now, 0.015);
        }

        // Joined up to MIN_BLOCK_SEC before a source node is made: a node per
        // short packet per voice is what wore the browser down on IQ 192. See
        // MIN_BLOCK_SEC in audio-player.js.
        const want = Math.round(rate * MIN_BLOCK_SEC);
        if (voice.pendRate !== rate) {
            voice.pendRate = rate;
            voice.pendN = 0;
        }
        if (!voice.pend || voice.pend.length < want + frames) {
            const grown = new Float32Array((want + frames) * 2);
            if (voice.pend && voice.pendN) grown.set(voice.pend.subarray(0, voice.pendN));
            voice.pend = grown;
        }
        voice.pend.set(samples.subarray(0, frames), voice.pendN);
        voice.pendN += frames;
        if (voice.pendN < want) return;
        const n = voice.pendN;
        voice.pendN = 0;
        const buffer = ctx.createBuffer(1, n, rate);
        buffer.copyToChannel(voice.pend.subarray(0, n), 0);

        if (voice.nextPlayTime < now) voice.nextPlayTime = now + LEAD_IN_SEC;
        else if (voice.nextPlayTime - now > MAX_QUEUE_SEC) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(voice.gain);
        src.start(voice.nextPlayTime);
        voice.nextPlayTime += buffer.duration;
    }

    /**
     * Keep only the voices named in `keys`, and give back any device no voice
     * is sent to any more.
     */
    prune(keys) {
        const keep = new Set(keys);
        for (const [key, voice] of Array.from(this.voices)) {
            if (!keep.has(key)) {
                this._dropVoice(voice);
                this.voices.delete(key);
            }
        }
        const used = new Set(Array.from(this.voices.values(), (v) => v.sink || ''));
        for (const id of Array.from(this._sinks.keys())) if (!used.has(id)) this._dropSink(id);
    }

    /** Start every voice's schedule again, as after a gap in the stream. */
    resync() {
        for (const v of this.voices.values()) {
            v.nextPlayTime = 0;
            v.pendN = 0;
        }
    }

    /** Take everything down. */
    teardown() {
        for (const v of this.voices.values()) this._dropVoice(v);
        this.voices.clear();
        if (this._master) {
            try { this._master.disconnect(); } catch (err) { /* context already gone */ }
        }
        this._master = null;
        for (const id of Array.from(this._sinks.keys())) this._dropSink(id);
        this._ctx = null;
    }

    /**
     * With `own` set, play through an audio context of this object's own when
     * the receiver has none — for something that plays with no receiver at
     * all, like the playground playing a file. Made on first use, which is a
     * press of Start, so the browser allows it to make sound.
     */
    allowOwnContext(own) {
        this._allowOwn = !!own;
    }

    _context() {
        const ctx = this.player && this.player.ctx;
        if (ctx && ctx.state !== 'closed') return { ctx, bus: this.player.outputBus };
        if (!this._allowOwn) return null;
        if (!this._own || this._own.state === 'closed') {
            const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
            if (!Ctor) return null;
            try { this._own = new Ctor(); } catch (err) { return null; }
        }
        if (this._own.state === 'suspended' && this._own.resume) this._own.resume().catch(() => {});
        return { ctx: this._own, bus: null };
    }

    _ensure() {
        const got = this._context();
        if (!got) return null;
        const { ctx } = got;
        if (this._master && this._ctx === ctx) return ctx;
        // The player rebuilds its context on a format or rate change, and every
        // node hanging off the old one is attached to a stopped clock.
        this.teardown();
        const master = ctx.createGain();
        master.gain.value = this._muted ? 0 : this._volume;
        const bus = got.bus;
        master.connect(bus && bus.context === ctx ? bus : ctx.destination);
        this._master = master;
        this._ctx = ctx;
        return ctx;
    }

    _voice(key) {
        let v = this.voices.get(key);
        if (!v) {
            const ctx = this._ctx;
            const gain = ctx.createGain();
            // A browser without a panner gets the audio in both ears rather
            // than none, which is the right way for a placement to degrade.
            const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (panner) gain.connect(panner);
            v = {
                gain, panner, nextPlayTime: 0, channel: null, muted: null, sink: null,
                pend: null, pendN: 0, pendRate: 0,
            };
            this.voices.set(key, v);
        }
        return v;
    }

    _dropVoice(voice) {
        try { voice.gain.disconnect(); } catch (err) { /* context already gone */ }
        if (voice.panner) {
            try { voice.panner.disconnect(); } catch (err) { /* context already gone */ }
        }
    }

    _route(voice, sinkId) {
        const want = sinkId || '';
        if (voice.sink === want) return;
        const node = voice.panner || voice.gain;
        try { node.disconnect(); } catch (err) { /* not connected */ }
        const to = this._outFor(want);
        if (to) node.connect(to);
        voice.sink = want;
    }

    _outFor(sinkId) {
        if (!sinkId) return this._master;
        const have = this._sinks.get(sinkId);
        if (have) return have.gain;
        const ctx = this._ctx;
        const gain = ctx.createGain();
        gain.gain.value = this._muted ? 0 : this._volume;
        const out = { gain, dest: null, el: null, error: null };
        this._sinks.set(sinkId, out);
        const fallBack = (err) => {
            out.error = (err && (err.message || err.name)) || 'the device refused';
            try { gain.disconnect(); } catch (e) { /* not connected */ }
            if (this._master) gain.connect(this._master);
            this.onChange();
        };
        try {
            const dest = ctx.createMediaStreamDestination();
            const el = document.createElement('audio');
            // iOS plays nothing inline without it — see the player's element.
            el.setAttribute('playsinline', '');
            el.style.display = 'none';
            document.body.appendChild(el);
            el.srcObject = dest.stream;
            out.dest = dest;
            out.el = el;
            gain.connect(dest);
            // The device first and playback after, so a refusal is known before
            // anything has been sent to it.
            el.setSinkId(sinkId)
                .then(() => (this._sinks.get(sinkId) === out ? el.play() : null))
                .catch(fallBack);
        } catch (err) {
            fallBack(err);
        }
        return gain;
    }

    _dropSink(sinkId) {
        const out = this._sinks.get(sinkId);
        if (!out) return;
        this._sinks.delete(sinkId);
        try { out.gain.disconnect(); } catch (err) { /* context already gone */ }
        if (out.el) {
            try { out.el.pause(); } catch (err) { /* ignore */ }
            out.el.srcObject = null;
            if (out.el.parentNode) out.el.parentNode.removeChild(out.el);
        }
    }
}
