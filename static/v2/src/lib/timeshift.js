// Timeshift — the last thirty seconds of audio and spectrum, and replay from
// any point in them. "Play from start" for the receiver.
//
// Outside React for the reason the recorder is: a collapsed panel is
// unmounted, and folding the panel away must neither lose the history nor
// strand a replay with no button left to end it.
//
// One timeline for both streams, in performance.now() milliseconds, and the
// relationship it keeps is the one the live display already has:
//
//   a spectrum frame is stamped when it arrives, which is when it was drawn;
//   an audio block is stamped when the live schedule *plays* it, which is its
//       start on the context clock carried over to performance.now().
//
// Replaying at a delay D draws each frame at stamp + D and plays each block at
// stamp + D, so the waterfall and the audio come back exactly as far apart as
// they were live — the audio's jitter cushion included.
//
// What is stored is what the live path already has in hand: decoded planar
// float audio, before the graph, and the frequency-ordered bins every frame
// consumer is handed. Replay goes back in at the same two points — blocks into
// the head of the audio graph, frames out of the spectrum connection's 'frame'
// event — so the filters, NR, volume and output routing apply to the replay,
// and SpectrumView, the IF panel, Measure and the bridge all follow it without
// knowing it exists.
//
// The signal readings rewind with the audio. Each block carries the baseband
// power, noise power and squelch state that arrived with it, so a meter reading
// through useMeters shows the moment being heard, and a recording made during
// a replay logs it. The meters object itself stays live — the squelch auto-set,
// the SAM fallback and the bridge are about the receiver now — and so do the
// decoders, which are fed by the live stream throughout.
//
// Nor does the tuning. The frequency, mode and passband are live server state,
// and the stream being recorded underneath a replay depends on them, so a
// replay never retunes anything. What it does is remember them: every change
// is stamped on the same timeline, and `replayTuning` says what the receiver
// was tuned to at the moment now playing, for the pill to name and the
// spectrum to draw as a ghost passband.

import { Emitter } from '../radio/emitter.js';
import { serverClock } from '../radio/serverClock.js';

export const TIMESHIFT_SEC = 30;

// Kept a second longer than can be reached, so a replay sitting at the far end
// still has the block it is halfway through.
const KEEP_MS = (TIMESHIFT_SEC + 1) * 1000;

// Asking for less than this behind live is asking for live. The live queue is
// itself a few hundred ms long, and a replay that close is the same audio with
// the meters disagreeing with it.
export const LIVE_EDGE_MS = 500;

// How far ahead of the context clock replayed audio is queued, and how often
// the queue is topped up. Comfortably more than the tick, so a late timer is a
// late top-up rather than a gap.
const LOOKAHEAD_SEC = 0.35;
const TICK_MS = 20;
// Where a replay starts on the context clock after a seek or a resume: far
// enough ahead to schedule into, near enough to feel immediate.
const START_LEAD_SEC = 0.05;
// Consecutive blocks closer than this to touching are joined end to end.
// The stamps are contiguous by construction, but carrying them between two
// clocks leaves a millisecond or two of disagreement, and an overlap or a gap
// that size is a click.
const JOIN_SEC = 0.02;

// Ceilings, in bytes, on what each history holds. Thirty seconds of 12 kHz
// mono is 1.4 MB, and 30 s of a 2048-bin spectrum at 25 fps is 6 MB — these
// only bite on the wide IQ presets and on very large bin counts, where the
// history is shortened rather than the tab being allowed to balloon.
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

// Index of the first entry whose `end` is after `t`. Entries are in order.
export function firstEndingAfter(list, t, endOf) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (endOf(list[mid]) <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * A recorded frame, redrawn into the view the display has now.
 *
 * The spectrum can be zoomed and panned during a replay, and that is a
 * request to the server: the live frames change geometry and the recorded
 * ones do not. Drawn as they are, they would land in the wrong place under
 * the ruler. Resampled, a zoom in during a replay shows the recorded band
 * larger and a zoom out shows it with nothing either side — the history there
 * was never captured, and is drawn at the frame's own floor rather than
 * invented.
 *
 * Nearest neighbour, as the waterfall's own rescale is: a one-bin carrier
 * stays one line rather than becoming a smear.
 *
 * `src` is frequency-ordered, centred on `srcCentre` at `srcBw` Hz per bin;
 * `out` is filled for `dstCentre` and `dstBw`.
 */
export function resampleBins(src, srcCentre, srcBw, out, dstCentre, dstBw) {
    const n = src.length;
    const m = out.length;
    if (n === m && srcCentre === dstCentre && srcBw === dstBw) {
        out.set(src);
        return out;
    }
    let floor = Infinity;
    for (let i = 0; i < n; i++) if (src[i] < floor) floor = src[i];
    if (!Number.isFinite(floor)) floor = -120;
    // Bin j's centre frequency in the output, and the source bin it falls in.
    // Both bin rows are centred on their centre frequency in the same way the
    // display draws them: bin k covers centre + (k - count/2) * bw onwards.
    const srcLeft = srcCentre - (n / 2) * srcBw;
    const dstLeft = dstCentre - (m / 2) * dstBw;
    const ratio = dstBw / srcBw;
    const base = (dstLeft - srcLeft) / srcBw + ratio / 2;
    for (let j = 0; j < m; j++) {
        const i = Math.floor(base + j * ratio);
        out[j] = i >= 0 && i < n ? src[i] : floor;
    }
    return out;
}

// Whether two tunings would sound different: frequency, mode or passband.
export function tuningDiffers(a, b) {
    if (!a || !b) return false;
    return a.frequency !== b.frequency || a.mode !== b.mode
        || a.bandwidthLow !== b.bandwidthLow || a.bandwidthHigh !== b.bandwidthHigh;
}

// Arrays of the same length are recycled as old entries fall off the end.
// Every frame and nearly every audio block is the same size as the last, so
// this turns 50 allocations a second into none once the history is full.
class Pool {
    constructor(limit = 96) {
        this.free = new Map();
        this.limit = limit;
    }

    take(length) {
        const list = this.free.get(length);
        return list && list.length ? list.pop() : new Float32Array(length);
    }

    give(arr) {
        let list = this.free.get(arr.length);
        if (!list) {
            list = [];
            this.free.set(arr.length, list);
        }
        if (list.length < this.limit) list.push(arr);
    }

    clear() {
        this.free.clear();
    }
}

export class Timeshift extends Emitter {
    constructor({ now, clock } = {}) {
        super();
        this.now = now || (() => performance.now());
        // The receiver's clock against this page's — radio/serverClock.js,
        // the same estimate the Stats panel ages the audio by.
        this.clock = clock || serverClock;
        this.player = null;
        this.spectrum = null;
        this.enabled = false;

        // 'live' | 'playing' | 'paused'.
        this.mode = 'live';
        // How far behind live a playing replay is, ms.
        this.delayMs = 0;
        // Where a paused replay is stopped, as a stamp.
        this.pausedAt = 0;

        // { stamp, end, rate, frames, planes, rms, signal } — `end` is a stamp
        // too, and `signal` the reading that came with it (see noteSignal).
        this.audio = [];
        this.audioBytes = 0;
        // { stamp, centre, bw, bins }
        this.frames = [];
        this.frameBytes = 0;
        this.pool = new Pool();
        // { stamp, frequency, mode, bandwidthLow, bandwidthHigh }, oldest
        // first. The first entry is the tuning in force at the start of the
        // history, so it may be older than everything else held.
        this.tunings = [];

        // The context clock carried over to performance.now(), per context:
        // perf ms = ctx seconds * 1000 + offset. See _offset.
        this._offEpoch = -1;
        this._off = null;
        // The newest signal reading, for the next block to carry.
        this._signal = null;

        // Replay state. `_cursor` is the next block to schedule, `_lastEnd`
        // where the last one scheduled ends on the context clock, `_epoch` the
        // context they were scheduled in.
        this._cursor = 0;
        this._lastEnd = 0;
        this._epoch = -1;
        this._sources = [];
        this._frameCursor = 0;
        this._out = null;
        this._timer = null;
    }

    attach(player, spectrum) {
        if (this.player && this.player !== player) this.player.timeshift = null;
        if (this.spectrum && this.spectrum !== spectrum) this.spectrum.timeshift = null;
        this.player = player || null;
        this.spectrum = spectrum || null;
        if (this.player) this.player.timeshift = this;
        if (this.spectrum) this.spectrum.timeshift = this;
    }

    // Whether anything is being kept. Off is free: nothing is copied, and the
    // history is dropped rather than left to age out.
    setEnabled(on) {
        const next = !!on;
        if (next === this.enabled) return;
        this.enabled = next;
        if (!next) {
            this.goLive();
            this.clear();
        }
        this._changed();
    }

    get replaying() {
        return this.mode !== 'live';
    }

    get paused() {
        return this.mode === 'paused';
    }

    // The stamp now on screen and in the speakers.
    get position() {
        const now = this.now();
        if (this.mode === 'paused') return this.pausedAt;
        if (this.mode === 'playing') return now - this.delayMs;
        return now;
    }

    // How far behind live that is, ms. 0 when live.
    get behindMs() {
        if (this.mode === 'live') return 0;
        return Math.max(0, this.now() - this.position);
    }

    // How far back a replay can go from here, ms — the older of the two
    // histories, so a mode change that leaves the audio short still lets the
    // spectrum be rewound, and capped at what is promised.
    get availableMs() {
        const now = this.now();
        let oldest = now;
        if (this.audio.length) oldest = Math.min(oldest, this.audio[0].stamp);
        if (this.frames.length) oldest = Math.min(oldest, this.frames[0].stamp);
        return Math.max(0, Math.min(TIMESHIFT_SEC * 1000, now - oldest));
    }

    clear() {
        this._signal = null;
        // The tuning in force now still is, history or not.
        this.tunings = this.tunings.slice(-1);
        this._stopSources();
        this.audio = [];
        this.audioBytes = 0;
        this.frames = [];
        this.frameBytes = 0;
        this.pool.clear();
        this._cursor = 0;
        this._frameCursor = 0;
        if (this.mode !== 'live') this.goLive();
        this._changed();
    }

    // ---- recording --------------------------------------------------------

    // The context's clock in performance.now() terms.
    //
    // Sampling both at once is not good enough on its own: currentTime moves in
    // whole render quanta — and with latencyHint 'playback' those can be tens of
    // milliseconds — so `perf - ctx` jitters by that much from one reading to
    // the next, and a stamp taken that way would put a click at every block
    // boundary of a replay. The smallest reading is the one taken just after
    // the clock stepped, which is the true offset; keeping the minimum gives
    // that. It is allowed to creep upwards by a microsecond a reading so a real
    // drift between the two clocks, a few ppm, is followed rather than frozen.
    _offset(ctx, epoch) {
        const sample = this.now() - ctx.currentTime * 1000;
        if (this._offEpoch !== epoch || this._off == null) {
            this._offEpoch = epoch;
            this._off = sample;
        } else {
            this._off = Math.min(this._off + 0.001, sample);
        }
        return this._off;
    }

    /**
     * A block the live schedule has placed, from AudioPlayer._schedule.
     * `startAt` is on the context clock; `planes` are only valid during the
     * call, so they are copied. `captureMs` is when its first sample was
     * captured, on the receiver's clock, or null — see _placeTunings.
     */
    recordAudio(planes, frames, rate, startAt, ctx, epoch, captureMs = null) {
        if (!this.enabled || !frames || !rate) return;
        const off = this._offset(ctx, epoch);
        const stamp = startAt * 1000 + off;
        const kept = [];
        let sum = 0;
        for (let c = 0; c < planes.length; c++) {
            const a = this.pool.take(frames);
            a.set(planes[c].subarray(0, frames));
            kept.push(a);
        }
        const p = kept[0];
        for (let i = 0; i < frames; i++) sum += p[i] * p[i];
        this.audio.push({
            stamp,
            end: stamp + (frames / rate) * 1000,
            rate,
            frames,
            planes: kept,
            rms: Math.sqrt(sum / frames),
            signal: this._signal,
        });
        this.audioBytes += frames * planes.length * 4;
        if (captureMs != null) this._placeTunings(stamp, captureMs, (frames / rate) * 1000);
        this._prune();
        // Live packets arrive every 20 ms whatever the timers are doing, so
        // they are the steadiest clock a replay has to top itself up from.
        if (this.mode === 'playing') this._pump();
    }

    /**
     * The reading that arrived with the packet now being decoded —
     * { basebandPower, noisePower, squelchOpen } — from RadioContext's
     * 'quality' handler. Every packet's header is read before its audio is
     * scheduled, so the next block recorded is the one it describes; an Opus
     * decode still in flight can leave it a packet late, 20 ms, which no meter
     * can show. A fresh object each time, never mutated, so blocks can share it.
     */
    noteSignal(signal) {
        if (this.enabled) this._signal = signal || null;
    }

    /** The reading carried by the block playing at `stamp`, or null. */
    signalAt(stamp) {
        const i = firstEndingAfter(this.audio, stamp, (c) => c.end);
        const c = this.audio[i];
        return c && c.stamp <= stamp ? c.signal || null : null;
    }

    /**
     * What the meters would have read at the moment now playing — or, paused,
     * the moment held on screen. Null while live, and null in a replay with no
     * audio held there, which is no reading rather than the live one.
     */
    get replaySignal() {
        return this.replaying ? this.signalAt(this.position) : null;
    }

    // A frame the spectrum connection has decoded. `bins` is its reused
    // output buffer, so it is copied too.
    recordFrame(frame, bw) {
        if (!this.enabled || !frame || !frame.bins || !frame.bins.length) return;
        const bins = this.pool.take(frame.bins.length);
        bins.set(frame.bins);
        this.frames.push({ stamp: this.now(), centre: frame.frequency, bw, bins });
        this.frameBytes += bins.length * 4;
        this._prune();
    }

    /**
     * What the receiver is tuned to, from TimeshiftWatch on every change.
     * Kept whether or not the buffer is running, since it is one entry and
     * the history that starts later has to know what it started on.
     */
    //
    // Stamped for when it will be *heard*, not when it was asked for. A retune
    // goes up to the receiver, which starts capturing the new frequency, and
    // that audio then comes down and through the queue — a few hundred ms in
    // all, the "heard" age the Stats panel shows. Stamped at the moment of
    // asking, the label and the ghost passband changed that much before the
    // sound did.
    //
    // So the change is put on the receiver's clock — now, plus the one-way trip
    // up, which is half the best round trip the clock estimate has seen — and
    // the first block captured at or after that is when it is heard: the
    // tuning's stamp moves to that block's play time, to the sample, when it
    // arrives (_placeTunings). That is the same capture time and the same clock
    // offset the Stats panel ages the audio with, used per block rather than
    // as an average.
    //
    // Until that block arrives, or always on a stream without capture times,
    // the stamp is a provisional now plus the audio queue — the part of the
    // delay this client can see for itself.
    noteTuning(t) {
        if (!t) return;
        const last = this.tunings[this.tunings.length - 1];
        if (last && !tuningDiffers(last, t)) return;
        const now = this.now();
        const clk = this.clock ? this.clock(now) : null;
        const queued = this.player && this.player.queuedSec ? this.player.queuedSec * 1000 : 0;
        this.tunings.push({
            // Never before the one it replaces, which a quick spin of the dial
            // would otherwise manage: the earlier change is placed on the
            // receiver's clock, the later one only provisionally.
            stamp: Math.max(now + queued, last ? last.stamp : -Infinity),
            // On the receiver's clock; null when no estimate exists yet.
            heardFrom: clk ? now + clk.theta + clk.err : null,
            frequency: t.frequency,
            mode: t.mode,
            bandwidthLow: t.bandwidthLow,
            bandwidthHigh: t.bandwidthHigh,
        });
        if (!this.enabled) this.tunings = this.tunings.slice(-1);
        else this._prune();
    }

    // A block captured from `captureMs` for `durMs`, playing from `stamp`:
    // every tuning still waiting for its first block that this one reaches is
    // placed at the sample it takes effect from. Newest first, since the
    // waiting ones are at the end, and stopped at the first already placed.
    _placeTunings(stamp, captureMs, durMs) {
        const list = this.tunings;
        for (let i = list.length - 1; i >= 0; i--) {
            const x = list[i];
            if (x.heardFrom == null) break;
            if (captureMs + durMs <= x.heardFrom) continue;
            x.stamp = stamp + Math.max(0, x.heardFrom - captureMs);
            x.heardFrom = null;
            // Anything after it that is still provisional cannot be heard
            // before it.
            for (let k = i + 1; k < list.length; k++) {
                if (list[k].stamp < x.stamp) list[k].stamp = x.stamp;
            }
        }
    }

    /** The tuning in force at `stamp`, or null when none is known. */
    tuningAt(stamp) {
        const i = firstEndingAfter(this.tunings, stamp, (x) => x.stamp) - 1;
        if (i >= 0) return this.tunings[i];
        return this.tunings[0] || null;
    }

    /** What the moment now playing was tuned to; null while live. */
    get replayTuning() {
        return this.replaying ? this.tuningAt(this.position) : null;
    }

    _prune() {
        const cut = this.now() - KEEP_MS;
        // Every tuning that a later one replaced before the history begins.
        let k = 0;
        while (k + 1 < this.tunings.length && this.tunings[k + 1].stamp <= cut) k++;
        if (k) this.tunings.splice(0, k);
        let a = 0;
        while (a < this.audio.length
            && (this.audio[a].end < cut || this.audioBytes > MAX_AUDIO_BYTES)) {
            const c = this.audio[a];
            this.audioBytes -= c.frames * c.planes.length * 4;
            for (const pl of c.planes) this.pool.give(pl);
            a++;
        }
        if (a) {
            this.audio.splice(0, a);
            this._cursor = Math.max(0, this._cursor - a);
        }
        let f = 0;
        while (f < this.frames.length
            && (this.frames[f].stamp < cut || this.frameBytes > MAX_FRAME_BYTES)) {
            this.frameBytes -= this.frames[f].bins.length * 4;
            this.pool.give(this.frames[f].bins);
            f++;
        }
        if (f) {
            this.frames.splice(0, f);
            this._frameCursor = Math.max(0, this._frameCursor - f);
        }
        // A pause long enough for its moment to fall off the end is held at
        // the oldest moment there still is, as a television's is.
        if (this.mode === 'paused') {
            const oldest = this.now() - this.availableMs;
            if (this.pausedAt < oldest) this.pausedAt = oldest;
        } else if (this.mode === 'playing' && this.delayMs > this.availableMs) {
            this.delayMs = this.availableMs;
        }
    }

    // ---- transport --------------------------------------------------------

    /** Go to `ms` behind live and play from there. */
    seekBehind(ms, { paused = this.mode === 'paused' } = {}) {
        if (!this.enabled) return;
        const behind = Math.min(Math.max(0, ms), this.availableMs);
        if (behind < LIVE_EDGE_MS) {
            this.goLive();
            return;
        }
        const wasLive = this.mode === 'live';
        this._stopSources();
        if (paused) {
            this.mode = 'paused';
            this.pausedAt = this.now() - behind;
        } else {
            this.mode = 'playing';
            // Exactly as asked, so the readout and the skips stay round. The
            // audio cannot start before the lead it is scheduled at, so the
            // first 50 ms after the moment chosen are skipped — not something
            // an ear can miss, where a position always 50 ms off is something
            // every readout would carry.
            this.delayMs = behind;
        }
        if (wasLive && this.player) this.player.haltLive();
        this._restart();
        this._changed();
    }

    /** Positive is forwards, towards live. */
    skip(deltaMs) {
        if (!this.enabled) return;
        if (this.mode === 'live') {
            if (deltaMs < 0) this.seekBehind(-deltaMs);
            return;
        }
        this.seekBehind(this.behindMs - deltaMs);
    }

    toStart() {
        this.seekBehind(this.availableMs);
    }

    pause() {
        if (!this.enabled || this.mode === 'paused') return;
        const wasLive = this.mode === 'live';
        const at = this.position;
        this._stopSources();
        this.mode = 'paused';
        this.pausedAt = at;
        if (wasLive && this.player) this.player.haltLive();
        this._restart();
        this._changed();
    }

    play() {
        if (this.mode !== 'paused') return;
        this.seekBehind(this.now() - this.pausedAt, { paused: false });
    }

    toggle() {
        if (this.mode === 'paused') this.play();
        else this.pause();
    }

    goLive() {
        if (this.mode === 'live') return;
        this._stopSources();
        this.mode = 'live';
        this.delayMs = 0;
        this._restart();
        // The live schedule never stopped — it ran on without scheduling
        // anything — so the blocks it has placed ahead of the clock are in the
        // history, and putting those back is live again with no gap and no
        // re-prime.
        const p = this.player;
        if (p && p.ctx && p.ctx.state !== 'closed' && this._off != null
            && this._offEpoch === p.contextEpoch) {
            const t = p.ctx.currentTime;
            for (let i = this.audio.length - 1; i >= 0; i--) {
                const c = this.audio[i];
                const start = (c.stamp - this._off) / 1000;
                const end = (c.end - this._off) / 1000;
                if (end <= t) break;
                p.playLive(c.planes, c.frames, c.rate, start);
            }
        }
        this._changed();
    }

    // ---- replay -----------------------------------------------------------

    _restart() {
        clearInterval(this._timer);
        this._timer = null;
        this._cursor = -1;
        this._frameCursor = -1;
        this._lastEnd = 0;
        if (this.mode === 'live') return;
        // The display jumps at once to the moment chosen, paused or not.
        this._showFrameAt(this.position);
        if (this.mode === 'playing') {
            this._pump();
            this._timer = setInterval(() => this._pump(), TICK_MS);
        }
    }

    _stopSources() {
        for (const s of this._sources) {
            try { s.src.stop(); } catch (e) { /* already ended */ }
        }
        this._sources = [];
    }

    _pump() {
        if (this.mode !== 'playing') return;
        this._pumpFrames();
        this._pumpAudio();
    }

    _pumpAudio() {
        const p = this.player;
        const ctx = p && p.ctx;
        if (!ctx || ctx.state === 'closed' || this._off == null) return;
        // A rate change rebuilds the context and takes everything queued in
        // it along with the old one; start again in the new.
        if (this._epoch !== p.contextEpoch) {
            this._epoch = p.contextEpoch;
            this._sources = [];
            this._cursor = -1;
            this._lastEnd = 0;
        }
        const t = ctx.currentTime;
        const off = this._offEpoch === p.contextEpoch ? this._off : this.now() - t * 1000;
        // Stamp s plays at stamp s + D, which on this context's clock is:
        const at = (stamp) => (stamp + this.delayMs - off) / 1000;

        if (this._cursor < 0) {
            this._cursor = firstEndingAfter(this.audio, this.now() - this.delayMs, (c) => c.end);
        }
        const floor = t + START_LEAD_SEC;
        while (this._cursor < this.audio.length) {
            const c = this.audio[this._cursor];
            let when = at(c.stamp);
            if (when > t + LOOKAHEAD_SEC) break;
            this._cursor++;
            const dur = c.frames / c.rate;
            if (this._lastEnd && Math.abs(when - this._lastEnd) < JOIN_SEC) when = this._lastEnd;
            let offset = 0;
            if (when < floor) {
                // Started before now: begin partway in, which is where a seek
                // into the middle of a block lands.
                offset = floor - when;
                when = floor;
                if (offset >= dur - 0.001) continue;
            }
            const src = p.playReplay(c.planes, c.frames, c.rate, when, offset);
            const end = when + dur - offset;
            if (src) this._sources.push({ src, end });
            this._lastEnd = end;
        }
        if (this._sources.length > 64) this._sources = this._sources.filter((s) => s.end > t);
    }

    _pumpFrames() {
        const pos = this.now() - this.delayMs;
        if (this._frameCursor < 0) {
            this._frameCursor = firstEndingAfter(this.frames, pos, (f) => f.stamp);
        }
        // Every frame that has come due, in order — as many as arrived live in
        // the same time, so the waterfall scrolls at the rate it did then.
        while (this._frameCursor < this.frames.length && this.frames[this._frameCursor].stamp <= pos) {
            this._emitFrame(this.frames[this._frameCursor]);
            this._frameCursor++;
        }
    }

    // The newest frame at or before `pos`, drawn now.
    _showFrameAt(pos) {
        const i = firstEndingAfter(this.frames, pos, (f) => f.stamp) - 1;
        if (i >= 0) this._emitFrame(this.frames[i]);
        this._frameCursor = i + 1;
    }

    _emitFrame(f) {
        const s = this.spectrum;
        if (!s) return;
        const n = s.binCount || f.bins.length;
        const centre = s.centerFreq || f.centre;
        const bw = s.binBandwidth || f.bw;
        if (!this._out || this._out.length !== n) this._out = new Float32Array(n);
        resampleBins(f.bins, f.centre, f.bw || bw, this._out, centre, bw);
        s.emit('frame', { bins: this._out, frequency: centre, timestamp: Math.round(f.stamp), replay: true });
    }

    /**
     * Audio level across the reachable history, for the scrub bar: `buckets`
     * values over the last TIMESHIFT_SEC seconds, oldest first, each the
     * loudest block in it — or -1 where there is no audio.
     */
    levels(buckets) {
        const out = new Float32Array(buckets).fill(-1);
        const now = this.now();
        const span = TIMESHIFT_SEC * 1000;
        for (const c of this.audio) {
            const k = Math.floor(((c.stamp - (now - span)) / span) * buckets);
            if (k < 0 || k >= buckets) continue;
            if (c.rms > out[k]) out[k] = c.rms;
        }
        return out;
    }

    _changed() {
        this.emit('change');
    }
}

let instance = null;

export function getTimeshift() {
    if (!instance) instance = new Timeshift();
    return instance;
}
