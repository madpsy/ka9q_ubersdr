// Speech-to-text on the device: turning the receiver's audio into what a
// native recogniser is fed.
//
// A host app's recogniser (see ./engines/host.js) takes 16 kHz mono PCM16 —
// what Android's and Apple's speech APIs are happiest with, and the rate every
// on-device speech model is trained at. What the player hands over is nothing
// like that: one Float32Array per channel, at the stream's own rate (12 kHz on
// SSB, 24 on AM, 48 on a wide mode), in packet-sized pieces of a few hundred
// samples. Three steps close the gap, and all three are pure arithmetic, so
// they live here where they can be tested rather than inside the engine:
//
//   * **Downmix.** Voice modes arrive as a duplicated pair; averaging the
//     planes is right for that and harmless for anything else.
//   * **Resample** with the polyphase resampler the DSP playground already
//     uses (../../lib/dsp/resample.js), not a linear interpolator: 24 to 16 kHz
//     is a decimation, and without its low-pass whatever sits between 8 and
//     12 kHz folds back down into the speech band.
//   * **Batch** into ~100 ms chunks. Packets are a few milliseconds each; a
//     bridge call per packet is a few hundred messages a second across the
//     WebView boundary for nothing.

import { Resampler, designResampler, resampleRatio } from '../../lib/dsp/resample.js';

export const STT_RATE = 16000;
export const CHUNK_MS = 100;

/**
 * The planes averaged into one channel. `out` is reused when it is long
 * enough, since this runs on every packet.
 */
export function downmix(planes, frames, out) {
    const n = Math.max(0, frames | 0);
    const dst = out && out.length >= n ? out : new Float32Array(n);
    const list = Array.isArray(planes) ? planes.filter(Boolean) : [];
    if (!list.length) {
        dst.fill(0, 0, n);
        return dst;
    }
    if (list.length === 1) {
        dst.set(list[0].subarray(0, n));
        return dst;
    }
    const k = 1 / list.length;
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < list.length; c++) s += list[c][i] || 0;
        dst[i] = s * k;
    }
    return dst;
}

/**
 * Float samples (-1..1) as PCM16, clamped.
 *
 * Asymmetric scaling, because PCM16 is: -1 is -32768 and +1 is +32767. A
 * symmetric 32767 never reaches the most negative code; a symmetric 32768 wraps
 * a full-scale positive sample round to the most negative one, which is a
 * click a recogniser hears as a consonant.
 */
export function floatToInt16(src, n = src.length, out) {
    const dst = out && out.length >= n ? out : new Int16Array(n);
    for (let i = 0; i < n; i++) {
        let s = src[i];
        if (!(s === s)) s = 0;     // NaN
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        dst[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return dst;
}

/**
 * RMS of the planes in dBFS, -Infinity for digital silence.
 *
 * The same reading as waveLevelDb in ../toneSpectrum.js, taken from the tap
 * rather than the analyser — which matters for one consumer, the "running but
 * silent" watchdog: the analyser sits after the volume control, so with the
 * receiver muted it reads -∞ and the watchdog would never see the audio the
 * recogniser is being fed.
 */
export function planesLevelDb(planes, frames) {
    const list = Array.isArray(planes) ? planes.filter(Boolean) : [];
    const n = Math.max(0, frames | 0);
    if (!list.length || !n) return -Infinity;
    let sum = 0;
    for (const p of list) {
        for (let i = 0; i < n; i++) sum += p[i] * p[i];
    }
    const rms = Math.sqrt(sum / (n * list.length));
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Packets in, 16 kHz PCM16 chunks of `chunkMs` out.
 *
 * Push the player's frames as they come (`push(planes, frames, sampleRate)`,
 * the shape of a player.onAudio listener); `onChunk(Int16Array)` is called
 * once per full chunk with a fresh array the receiver may keep — it is going
 * across a bridge, and a reused buffer would be overwritten before the far
 * side had read it.
 *
 * A change of input rate (a mode change) rebuilds the resampler and drops the
 * part-filled chunk: the two halves would be different streams joined at a
 * click, and the next 100 ms is a better start than that.
 */
export class Pcm16Batcher {
    constructor({ onChunk, outRate = STT_RATE, chunkMs = CHUNK_MS } = {}) {
        this.onChunk = onChunk || (() => {});
        this.outRate = outRate;
        this.size = Math.max(1, Math.round((outRate * chunkMs) / 1000));
        this.chunk = new Float32Array(this.size);
        this.fill = 0;
        this.inRate = 0;
        this.resampler = null;
        this.mono = null;
        this.scratch = null;
    }

    reset() {
        this.fill = 0;
        if (this.resampler) this.resampler.reset();
    }

    _rate(sampleRate) {
        if (sampleRate === this.inRate && (this.resampler || sampleRate === this.outRate)) return;
        this.inRate = sampleRate;
        this.fill = 0;
        if (sampleRate === this.outRate) {
            this.resampler = null;
            return;
        }
        const { L, M } = resampleRatio(sampleRate, this.outRate);
        this.resampler = new Resampler(designResampler(L, M), L, M);
    }

    push(planes, frames, sampleRate) {
        const n = frames | 0;
        if (n <= 0 || !(sampleRate > 0)) return;
        this._rate(sampleRate);
        this.mono = downmix(planes, n, this.mono);
        let src = this.mono;
        let count = n;
        if (this.resampler) {
            // Upper bound on what one block can produce: L/M of it, plus one
            // for the phase carried over from the last block.
            const need = Math.ceil((n * this.resampler.L) / this.resampler.M) + 2;
            if (!this.scratch || this.scratch.length < need) this.scratch = new Float32Array(need);
            count = this.resampler.process(this.mono, this.scratch, n);
            src = this.scratch;
        }
        let i = 0;
        while (i < count) {
            const take = Math.min(this.size - this.fill, count - i);
            this.chunk.set(src.subarray(i, i + take), this.fill);
            this.fill += take;
            i += take;
            if (this.fill === this.size) {
                this.fill = 0;
                this.onChunk(floatToInt16(this.chunk, this.size));
            }
        }
    }
}
