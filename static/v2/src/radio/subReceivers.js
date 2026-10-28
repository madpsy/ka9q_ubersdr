// The VFOs listened to alongside the main receiver.
//
// The server lets one session hold several audio streams under its one id: the
// main one (vfo 0, RadioContext's AudioConnection, unchanged) and up to N-1
// *secondaries* — POST /connection says N, see session.js getVfoLimit. This is
// the engine that plays the secondaries. It is deliberately not a second
// AudioPlayer. A secondary is a lesser thing on the server (no IQ, no server
// DSP) and a lesser thing here: none of the timeshift, recorder, scope, client
// NR/EQ, extensions or speech-to-text that hang off the main player. Each is
// just
//
//     AudioConnection(vfo=i, primary:false) ─► Opus decoder, or PCM as is ─► voice
//     voice: gain (its volume / mute) ─► StereoPanner ─► player.subOutput
//
// in the *main* player's AudioContext, so every stream shares one clock and
// one output device. `subOutput` is routed wherever the main audio goes and is
// silenced for TX with it, but is not gated by the Media Session HTTP stream
// and is not ducked by FreeDV or DRM — see AudioPlayer.subOutput.
//
// What it follows, pushed in by SubReceiversWatch (components/):
//
//   running        a receiver switched off drops every secondary.
//   main open      secondaries are only accepted while the session has a live
//                  primary, so they connect once the main socket opens, and
//                  one at a time STAGGER_MS apart: the server's connection
//                  rate limit allows a burst of four a second per IP, and the
//                  main socket and the spectrum have already spent two.
//   main tuning    MODE LOCK. Every secondary plays in the main receiver's mode
//                  at its own frequency. The streams then all arrive at the
//                  context's own rate and nothing resamples. A listening VFO's
//                  saved mode stays in its slot (lib/vfos.js) for when it stops
//                  listening. The filter is main's too until the VFO is given
//                  one of its own (setFilter; lib/vfos.js listenEdges).
//   main format    every secondary is in the main socket's format, Opus or
//                  lossless (the Audio panel's choice, or the recorder's hold
//                  on lossless). The server fixes the format at connect, so a
//                  change closes them all and they come back on the stagger
//                  behind the main socket's own reconnect.
//   IQ             ends listening. The server refuses IQ on a secondary, and a
//                  secondary's radiod channel is worth handing back for as
//                  long as the operator stays in IQ, so every stream is closed
//                  and every listening flag cleared (lib/vfos.js clearListening).
//                  The VFOs are ordinary memories again, and leaving IQ brings
//                  none of them back by itself. While in IQ listening is
//                  refused, with listenBlocked saying why.
//   squelch        main's threshold, for every stream that has not been given
//                  its own (setSquelch; lib/vfos.js listenThreshold). Sent as
//                  min_snr on connect and as set_audio_gate when it moves.
//
// Which VFOs are listening, and how each is heard, is the VFO store's
// (lib/vfos.js). This subscribes to it and makes the streams match.
//
// Errors are kept here, per VFO, and never reach RadioContext's failure
// handling: a secondary that is refused must not end the session the operator
// is actually listening to.

import { AudioConnection } from './audio-connection.js';
import { getOpusDecoderClass } from './audio-player.js';
import { SQUELCH_AUTO_SAMPLES, SQUELCH_SENTINEL, autoSquelchValue, isIQ } from './constants.js';
import { Emitter } from './emitter.js';
import { squelchState } from './squelchState.js';
import { getVfoLimit, onVfoLimit } from './session.js';
import {
    clearListening, getVfos, listenBlockedReason, listenEdges, listenOf, listenThreshold, listenVfo,
    listeningVfos, onVfosChanged, setVfoFilter, setVfoListen, setVfoSquelch, setVfos, tuneListening,
} from '../lib/vfos.js';
import { vfoPans } from '../lib/vfoPan.js';
import { throttle } from '../lib/throttle.js';

/** Gap between one secondary's connect and the next. */
export const STAGGER_MS = 300;

// The same pacing the main receiver gives its own commands — a drag on a
// listening VFO's frequency, or the squelch slider, is a stream of changes and
// each secondary has its own command rate limit on the server.
const TUNE_THROTTLE_MS = 70;
const GATE_THROTTLE_MS = 90;

// A "no primary" refusal while the main socket *is* open is a race — the
// secondary got to the server before the primary's session existed. Retried a
// few times on the stagger, then left for the next time the main socket opens.
const PRIMARY_RETRIES = 3;

// The server's words for the two refusals that are handled specially. Matched
// loosely, like lib/connectFailure.js: a reworded message should still land in
// the right place rather than in a retry loop.
const LIMIT_RE = /allows \d+ vfo/i;
const PRIMARY_RE = /primary/i;

export class SubReceivers extends Emitter {
    /**
     * Everything it touches is injectable, for the tests; the defaults are the
     * page's own.
     */
    constructor(player, {
        makeConnection = (vfo) => new AudioConnection({ vfo, primary: false }),
        decoderClass = getOpusDecoderClass,
        store = { get: getVfos, on: onVfosChanged, set: setVfos },
        limit = { get: getVfoLimit, on: onVfoLimit },
        now = () => Date.now(),
        timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
    } = {}) {
        super();
        this.player = player;
        this.makeConnection = makeConnection;
        this.decoderClass = decoderClass;
        this.store = store;
        this.limitSource = limit;
        this.now = now;
        this.timers = timers;
        // What the main receiver is doing, as last pushed by update().
        this.main = { running: false, open: false, tuning: null, threshold: null, held: false, format: 'opus' };
        // Anything carrying `tuning`, `view` and `actions`, for seeding an
        // unused VFO when it starts listening. See setRadio.
        this.radio = null;
        // index -> lane. Lanes are made once per index and kept: an
        // AudioConnection registers itself with the wake watcher for the life
        // of the page (socket-health.js reviveOnWake never lets go), so making
        // one per listen would leak one per press.
        this.lanes = new Map();
        // Lanes waiting for their turn to connect, oldest first.
        this.queue = [];
        this.queueTimer = null;
        this.lastConnectAt = -Infinity;
        this.panState = null;
        this.mainPan = null;
        this.overLimit = [];
        this._offs = [
            store.on(() => this._sync()),
            limit.on(() => this._sync()),
        ];
        if (player && typeof player.on === 'function') {
            // A rebuilt context has closed every voice built in the old one.
            this._offs.push(player.on('context', () => this._rebuildVoices()));
        }
    }

    // ---- what the main receiver is doing -------------------------------

    /** The radio facade for seeding a VFO from live: `{tuning, view, actions}`. */
    setRadio(radio) {
        this.radio = radio;
    }

    /**
     * Push the main receiver's state in. Any subset of:
     *   running    the receiver is on.
     *   open       the main audio socket is open.
     *   tuning     {frequency, mode, bandwidthLow, bandwidthHigh}.
     *   threshold  the squelch's min SNR in dB, or null when it is off.
     *   held       a recording is being played back; secondaries hold their peace.
     *   format     the main socket's audio format, 'opus' | 'pcm-zstd'.
     */
    update(next) {
        const prev = this.main;
        const main = { ...prev, ...next };
        main.format = main.format === 'pcm-zstd' ? 'pcm-zstd' : 'opus';
        this.main = main;

        // Whether or not the receiver is on: a stale flag restored into IQ
        // would otherwise come back to life on the way out of it.
        if (this._iq(main)) this._endListening();

        const formatChanged = main.format !== prev.format;
        if (formatChanged) {
            for (const lane of this.lanes.values()) lane.conn.setFormat(main.format);
        }

        if (!main.running) {
            if (prev.running || this._anyConnected()) this._stopAll();
            this._sync();
            return;
        }

        if (formatChanged) {
            // The format is in the connect URL, so each live stream is closed
            // and connected again. Normally the main socket has just closed for
            // the same reason, and the open below queues them behind it; if it
            // is somehow still open, they are queued from here.
            for (const lane of this._assigned()) {
                if (!this._live(lane)) continue;
                lane.sendTune.cancel();
                lane.conn.disconnect();
                lane.error = null;
                if (prev.open && main.open && !lane.refused) this._enqueue(lane);
            }
        }

        if (!(prev.open && prev.running) && main.open) {
            // The main socket has just opened, which is also a connect: the
            // first secondary waits a full stagger after it. Anything that gave
            // up, or was told there was no primary, gets another go now.
            this.lastConnectAt = this.now();
            for (const lane of this._assigned()) {
                lane.primaryRetries = 0;
                if (!lane.refused && !this._live(lane)) this._enqueue(lane);
            }
        }

        // Unforced: a VFO with a filter of its own is only retuned when the mode
        // moves it, not every time main's filter does.
        if (!this._iq(main) && modeChanged(prev.tuning, main.tuning)) {
            for (const lane of this._assigned()) this._tune(lane, false);
        }

        if (prev.threshold !== main.threshold) {
            for (const lane of this._assigned()) this._gate(lane);
        }

        this._sync();
    }

    // ---- the operator's controls --------------------------------------

    /** Retune listening VFO `id`. */
    tuneVfo(id, hz) {
        return tuneListening(id, hz, this.limitSource.get());
    }

    /**
     * Start or stop listening to `id`. False when refused: past the limit, the
     * active VFO, or the main receiver in IQ (listenBlocked).
     */
    setListening(id, on) {
        if (on && this.listenBlocked) return false;
        return listenVfo(this.radio, id, on, this.limitSource.get());
    }

    /**
     * Why no VFO may start listening just now, or null when one may. Only IQ
     * stops it; the limit is answered per VFO, by `refused` and the count.
     */
    get listenBlocked() {
        return listenBlockedReason(this.main.tuning && this.main.tuning.mode);
    }

    /**
     * Give listening VFO `id` its own filter, `[low, high]` in the main
     * receiver's mode, or with null put it back on main's.
     */
    setFilter(id, edges) {
        return setVfoFilter(id, this.main.tuning, edges);
    }

    /**
     * Give listening VFO `id` its own squelch — a threshold in dB, or 'off' —
     * or with null put it back on main's.
     */
    setSquelch(id, value) {
        return setVfoSquelch(id, this.main.threshold, value);
    }

    /**
     * Set `id`'s own squelch just above the noise it has been hearing, as the
     * main receiver's Auto does. False with nothing heard yet to measure.
     */
    autoSquelch(id) {
        const lane = this._assigned().find((l) => l.slotId === id);
        const value = lane ? autoSquelchValue(lane.meters.snrHistory) : null;
        if (value == null) return false;
        this.setSquelch(id, value);
        return true;
    }

    /** 'auto' | 'left' | 'right' | 'both'. */
    setOutput(id, out) {
        return setVfoListen(id, { out });
    }

    /** 0..1. */
    setVolume(id, vol) {
        return setVfoListen(id, { vol });
    }

    setMuted(id, muted) {
        return setVfoListen(id, { muted: !!muted });
    }

    /** The server's VFO count, main included. */
    get limit() {
        return this.limitSource.get();
    }

    /**
     * The AudioConnection playing listening VFO `id`, or null. For the Status
     * panel's throughput, which reads its byte counter; nothing should drive
     * the socket through this.
     */
    connection(id) {
        const lane = this._assigned().find((l) => l.slotId === id);
        return lane ? lane.conn : null;
    }

    /**
     * Bytes taken off every listening VFO's socket, ever: the sum of the lanes'
     * counters, for the Stats panel and the corner readout. A lane is made once
     * per index and never dropped, and its counter is never reset, so the sum
     * only grows — which is what lets a reader take deltas of it exactly as it
     * does of the main socket's.
     */
    bytesIn() {
        let n = 0;
        for (const lane of this.lanes.values()) n += lane.conn.bytesIn || 0;
        return n;
    }

    /** How many listening VFOs hold a socket right now. */
    openCount() {
        let n = 0;
        for (const lane of this.lanes.values()) if (lane.conn.ws) n++;
        return n;
    }

    // ---- what the UI reads --------------------------------------------

    /**
     * Per-VFO live state, keyed by VFO id (A–D), for every listening VFO —
     * including any the server's limit leaves out, marked `overLimit`.
     *
     *   index           the server's vfo index, 1..N-1
     *   state           the socket's: idle | connecting | open | reconnecting | rejected
     *   basebandPower, noisePower, snr   the last signal reading, dB; null before one
     *   squelchOpen     as the gate would have it — radio/squelchState.js
     *   threshold       the squelch it is gated by, dB, or null when off
     *   squelchOwn      that squelch is its own rather than main's
     *   error           the last thing the server or socket said went wrong, or null
     *   refused         why the server will not have this VFO at all, or null
     *   waitingPrimary  refused for want of a main stream; retried when it opens
     *   pan             where it sits, -1..+1, or null when only one VFO is heard
     */
    snapshot() {
        const vfos = {};
        for (const lane of this._assigned()) {
            const m = lane.meters;
            vfos[lane.slotId] = {
                index: lane.index,
                state: lane.conn.state,
                basebandPower: m.basebandPower,
                noisePower: m.noisePower,
                snr: m.snr,
                squelchOpen: m.squelchOpen,
                threshold: lane.threshold == null ? null : lane.threshold,
                squelchOwn: !!lane.squelchOwn,
                error: lane.error,
                refused: lane.refused,
                waitingPrimary: lane.waitingPrimary,
                pan: lane.pan,
                overLimit: false,
            };
        }
        const limit = this.limitSource.get();
        for (const id of this.overLimit) {
            vfos[id] = {
                index: null,
                state: 'idle',
                basebandPower: null,
                noisePower: null,
                snr: null,
                squelchOpen: false,
                threshold: null,
                squelchOwn: false,
                error: null,
                refused: `This receiver allows ${limit} VFO${limit === 1 ? '' : 's'}`,
                waitingPrimary: false,
                pan: null,
                overLimit: true,
            };
        }
        // `listenBlocked` is the reason listening cannot start (IQ), or null;
        // `format` is what every secondary connects in, the main socket's.
        return { limit, listenBlocked: this.listenBlocked, format: this.main.format, mainPan: this.mainPan, vfos };
    }

    /** Drop everything and stop listening to the store. For tests and teardown. */
    dispose() {
        this._stopAll();
        for (const off of this._offs) { try { off(); } catch (e) { /* ignore */ } }
        this._offs = [];
    }

    // ---- making the streams match the store ---------------------------

    _sync() {
        const state = this.store.get();
        const limit = this.limitSource.get();
        // listeningVfos answers none at a limit of 1, so a stored flag the
        // server has no room for is not shown as refused either: it is inert.
        const want = this.main.running && !this._iq(this.main) ? listeningVfos(state, limit) : [];
        const room = Math.max(0, limit - 1);
        const keep = want.slice(0, room);
        this.overLimit = want.slice(room).map((v) => v.id);
        const wantIds = new Set(keep.map((v) => v.id));

        // A lane past the room is leaving too, whatever it plays: the limit has
        // come down under it, and the server would refuse its index.
        const leaving = this._assigned().filter((l) => !wantIds.has(l.slotId) || l.index > room);
        const have = new Set(this._assigned().filter((l) => !leaving.includes(l)).map((l) => l.slotId));
        const arriving = keep.filter((v) => !have.has(v.id));

        // A VFO leaving and another arriving in the same change is the swap in
        // lib/vfos.js — the main receiver and a listening VFO trading places.
        // The stream is handed over and retuned rather than closed and opened,
        // which would cost a connect against the rate limit and a gap.
        for (const v of arriving) {
            let lane = leaving.shift();
            if (lane && lane.index <= room) {
                this._assign(lane, v.id);
                this._tune(lane, true);
                if (!this._live(lane) && this.main.open) this._enqueue(lane);
                continue;
            }
            if (lane) leaving.unshift(lane);
            lane = this._freeLane(room);
            if (!lane) break;
            this._assign(lane, v.id);
            if (this.main.open) this._enqueue(lane);
        }
        for (const lane of leaving) this._release(lane);

        // Frequencies, filters and squelches that moved since they were last sent.
        for (const lane of this._assigned()) {
            this._tune(lane, false);
            this._gate(lane);
        }

        this._applyVoices();
        this._applyPans();
        this.emit('change');
    }

    _assigned() {
        return Array.from(this.lanes.values()).filter((l) => l.slotId);
    }

    _anyConnected() {
        return Array.from(this.lanes.values()).some((l) => l.conn.ws || l.conn.opening);
    }

    // The lowest index not in use, making its lane the first time. Indices are
    // the server's — `vfo` on the socket — and run 1..limit-1.
    _freeLane(room) {
        for (let i = 1; i <= room; i++) {
            const lane = this.lanes.get(i) || this._makeLane(i);
            if (!lane.slotId) return lane;
        }
        return null;
    }

    _makeLane(index) {
        const conn = this.makeConnection(index);
        conn.setFormat(this.main.format);
        const lane = {
            index,
            conn,
            slotId: null,
            freq: null,             // the frequency last sent, Hz
            urlParams: null,        // the tuning the last connect URL carried
            sentMode: null,         // the mode and filter last sent
            threshold: undefined,   // the squelch in force, dB or null; undefined before one
            squelchOwn: false,
            decoder: null,
            decRate: 0,
            decCh: 0,
            chain: Promise.resolve(),
            voice: null,
            pan: null,
            meters: freshMeters(),
            error: null,
            refused: null,
            waitingPrimary: false,
            primaryRetries: 0,
            queued: false,
        };
        lane.sendTune = throttle((p) => conn.tune(p), TUNE_THROTTLE_MS);
        lane.sendGate = throttle((v) => conn.setAudioGate({ minSnr: v }), GATE_THROTTLE_MS);
        conn.on('opus', ({ data, sampleRate, channels }) => this._onOpus(lane, data, sampleRate, channels));
        conn.on('pcm', ({ planes, sampleRate }) => this._onPcm(lane, planes, sampleRate));
        conn.on('quality', (q) => this._onQuality(lane, q));
        conn.on('open', () => this._onOpen(lane));
        conn.on('error', (e) => this._onError(lane, e));
        conn.on('state', (st) => {
            // What the connect URL is about to carry — connect() builds it from
            // `params` just before this — so the open can tell whether anything
            // moved while the socket was coming up. Comparing against `params`
            // itself on open would not do: tune() writes into it even while
            // the socket is down.
            if (st === 'connecting' && conn.params) lane.urlParams = { ...conn.params };
            this.emit('change');
        });
        this.lanes.set(index, lane);
        return lane;
    }

    _assign(lane, slotId) {
        lane.slotId = slotId;
        lane.meters = freshMeters();
        lane.error = null;
        lane.refused = null;
        lane.waitingPrimary = false;
        lane.primaryRetries = 0;
    }

    _release(lane) {
        lane.slotId = null;
        lane.queued = false;
        this.queue = this.queue.filter((l) => l !== lane);
        lane.sendTune.cancel();
        lane.sendGate.cancel();
        lane.conn.disconnect();
        lane.freq = null;
        lane.sentMode = null;
        lane.error = null;
        lane.refused = null;
        lane.waitingPrimary = false;
        this._dropVoice(lane);
        this._dropDecoder(lane);
    }

    _stopAll() {
        if (this.queueTimer != null) this.timers.clear(this.queueTimer);
        this.queueTimer = null;
        this.queue = [];
        for (const lane of this.lanes.values()) {
            if (lane.slotId) this._release(lane);
            else lane.conn.disconnect();
        }
        this.player && this.player.setPan && this.player.setPan(null);
        this.mainPan = null;
        this.panState = null;
    }

    // ---- connecting, one at a time -------------------------------------

    _enqueue(lane) {
        if (lane.queued || !lane.slotId) return;
        lane.queued = true;
        this.queue.push(lane);
        this._pump();
    }

    _pump() {
        if (this.queueTimer != null || !this.queue.length) return;
        const wait = Math.max(0, this.lastConnectAt + STAGGER_MS - this.now());
        this.queueTimer = this.timers.set(() => {
            this.queueTimer = null;
            const lane = this.queue.shift();
            if (lane) {
                lane.queued = false;
                if (this._connect(lane)) this.lastConnectAt = this.now();
            }
            this._pump();
        }, wait);
    }

    _connect(lane) {
        const main = this.main;
        if (!lane.slotId || lane.refused || !main.running || !main.open) return false;
        if (this._iq(main) || this._live(lane)) return false;
        const params = this._params(lane);
        if (!params) return false;
        lane.conn.setFormat(main.format);
        // Recorded on the connection before it connects, so the gate rides the
        // connect URL as min_snr (see AudioConnection.connect).
        this._gate(lane);
        if (lane.threshold != null) lane.conn.setAudioGate({ minSnr: lane.threshold });
        else lane.conn.lastGate = null;
        lane.freq = params.frequency;
        lane.sentMode = modeKey(params);
        lane.conn.connect(params);
        return true;
    }

    _live(lane) {
        const c = lane.conn;
        return !!(c.ws || c.opening || c.state === 'reconnecting');
    }

    // ---- tuning ----------------------------------------------------------

    _iq(main) {
        return !!(main.tuning && isIQ(main.tuning.mode));
    }

    // IQ ends listening: see the note at the top. Clearing the flags is what
    // closes the streams — the store's change runs _sync, and nothing is
    // wanted.
    _endListening() {
        const before = this.store.get();
        const after = clearListening(before);
        if (after !== before) this.store.set(after);
    }

    // What a secondary on this lane should be tuned to: its own frequency, the
    // main receiver's mode, and its own filter or else main's.
    _params(lane) {
        const state = this.store.get();
        const slot = state.slots[lane.slotId];
        const t = this.main.tuning;
        if (!slot || !t || isIQ(t.mode)) return null;
        const edges = listenEdges(listenOf(state, lane.slotId), t);
        return {
            frequency: slot.frequency,
            mode: t.mode,
            bandwidthLow: edges.low,
            bandwidthHigh: edges.high,
        };
    }

    // The squelch this lane's VFO is gated by — its own, or main's — sent when
    // it has changed. A socket that is not open has nothing sent: the next
    // connect carries it in the URL (_connect) and the open sends it again.
    _gate(lane) {
        const state = this.store.get();
        const gate = listenThreshold(listenOf(state, lane.slotId), this.main.threshold);
        lane.squelchOwn = gate.own;
        if (lane.threshold === gate.threshold) return;
        lane.threshold = gate.threshold;
        if (lane.conn.state === 'open') lane.sendGate(gateValue(gate.threshold));
    }

    // Sends a tune when the lane's frequency, mode or filter has moved since
    // the last one — or always, with `force`. Nothing in IQ, which a secondary
    // may not have; there are no lanes then anyway.
    _tune(lane, force) {
        const p = this._params(lane);
        if (!p) return;
        const key = modeKey(p);
        if (!force && lane.freq === p.frequency && lane.sentMode === key) return;
        lane.freq = p.frequency;
        lane.sentMode = key;
        // A socket that is not open takes it straight into its params, so the
        // next connect comes back where the VFO now is (AudioConnection.tune
        // does that). Not through the throttle: a command that was never sent
        // must not hold back the first one that is.
        if (lane.conn.state !== 'open') lane.conn.tune(p);
        else lane.sendTune(p);
    }

    // ---- socket events -------------------------------------------------

    _onOpen(lane) {
        lane.error = null;
        lane.waitingPrimary = false;
        // Anything that moved while the socket was opening commanded nothing.
        const asked = lane.urlParams;
        const p = this._params(lane);
        if (p && asked && (asked.frequency !== p.frequency || modeKey(asked) !== modeKey(p))) {
            lane.freq = null;
            this._tune(lane, true);
        }
        // Belt and braces with the connect URL's min_snr: a server that read
        // the URL already has it, and one that did not is gated now.
        if (lane.threshold != null) lane.conn.setAudioGate({ minSnr: lane.threshold });
        lane.meters = freshMeters();
        this.emit('change');
    }

    _onError(lane, e) {
        const message = (e && e.message) || 'VFO audio error';
        if (LIMIT_RE.test(message)) {
            // Settled: no amount of retrying makes room. The row says so and
            // the operator gets one notice; listening again tries afresh.
            lane.refused = message;
            lane.conn.disconnect();
            this.emit('refused', { id: lane.slotId, message });
        } else if (PRIMARY_RE.test(message)) {
            lane.waitingPrimary = true;
            lane.conn.disconnect();
            if (this.main.open && lane.primaryRetries < PRIMARY_RETRIES) {
                lane.primaryRetries++;
                this._enqueue(lane);
            }
        } else {
            // Anything else the connection's own backoff deals with.
            lane.error = message;
        }
        this.emit('change');
    }

    _onQuality(lane, { basebandPower, noisePower }) {
        const m = lane.meters;
        m.basebandPower = basebandPower;
        m.noisePower = noisePower;
        m.snr = basebandPower != null && noisePower != null ? basebandPower - noisePower : null;
        const gate = squelchState({
            snr: m.snr,
            threshold: lane.threshold == null ? null : lane.threshold,
            iq: false,
            now: this.now(),
            lastOpenAt: m.lastOpenAt,
        });
        m.squelchOpen = gate.open;
        m.lastOpenAt = gate.lastOpenAt;
        // What its Auto measures from — the same few readings main's uses.
        if (m.snr != null) {
            m.snrHistory.push(m.snr);
            if (m.snrHistory.length > SQUELCH_AUTO_SAMPLES) m.snrHistory.shift();
        }
    }

    // ---- audio -----------------------------------------------------------

    _onOpus(lane, data, sampleRate, channels) {
        if (!lane.slotId) return;
        // Serialised: the decoder is a stateful WASM module and decodeFrame is
        // async, so two frames in flight at once would interleave. The same
        // arrangement as the DRM panel.
        lane.chain = lane.chain
            .then(() => this._decode(lane, data, sampleRate, channels))
            .catch(() => { /* one bad frame */ });
    }

    // Lossless frames arrive already decoded by the AudioConnection. Mono: a
    // secondary is never IQ, so the first plane is the whole of it. Queued
    // behind any Opus still decoding from before a format change, so the two
    // cannot be scheduled out of order.
    _onPcm(lane, planes, sampleRate) {
        if (!lane.slotId || !planes || !planes.length || !planes[0].length) return;
        lane.chain = lane.chain
            .then(() => {
                // Freed here rather than on arrival, where a decode could still
                // be running inside it.
                if (lane.decoder) this._dropDecoder(lane);
                if (lane.slotId) this._schedule(lane, [planes[0]], planes[0].length, sampleRate);
            })
            .catch(() => { /* one bad frame */ });
    }

    async _decode(lane, data, sampleRate, channels) {
        if (!lane.decoder || lane.decRate !== sampleRate || lane.decCh !== channels) {
            const Decoder = this.decoderClass();
            if (!Decoder) return;
            this._dropDecoder(lane);
            const dec = new Decoder({ sampleRate, channels });
            lane.decoder = dec;
            lane.decRate = sampleRate;
            lane.decCh = channels;
            await dec.ready;
        }
        const dec = lane.decoder;
        const decoded = await dec.decodeFrame(data);
        // Released while that was in flight.
        if (!lane.slotId || lane.decoder !== dec) return;
        if (!decoded || !decoded.samplesDecoded) return;
        this._schedule(lane, decoded.channelData, decoded.samplesDecoded,
            decoded.sampleRate || sampleRate);
    }

    _schedule(lane, planes, frames, rate) {
        const voice = this._voice(lane);
        if (!voice) return;
        const ctx = voice.ctx;
        const buffer = ctx.createBuffer(planes.length, frames, rate);
        for (let c = 0; c < planes.length; c++) buffer.copyToChannel(planes[c], c);
        const now = ctx.currentTime;
        const p = this.player;
        // The main player's own cushion and ceiling, so the VFOs ride out the
        // jitter the operator chose a buffer for and fall no further behind.
        const lead = p.leadInSec ? p.leadInSec() : 0.12;
        const ceiling = Math.max(p.bufferSec || 0.2, lead);
        if (voice.nextPlayTime < now) voice.nextPlayTime = now + lead;
        else if (voice.nextPlayTime - now > ceiling) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(voice.gain);
        src.start(voice.nextPlayTime);
        voice.nextPlayTime += frames / rate;
    }

    // The lane's voice in the player's current context, built if there is none
    // or the one there is belongs to a context that has since been replaced.
    _voice(lane) {
        const p = this.player;
        const ctx = p && p.ctx;
        const bus = p && p.subOutput;
        if (!ctx || ctx.state === 'closed' || !bus) return null;
        if (lane.voice && lane.voice.ctx === ctx) return lane.voice;
        this._dropVoice(lane);
        const gain = ctx.createGain();
        gain.gain.value = this._level(lane);
        // A browser without a panner gets the audio in both ears rather than
        // none, which is the right way for a placement to degrade.
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (panner) {
            panner.pan.value = lane.pan != null ? lane.pan : 0;
            gain.connect(panner);
            panner.connect(bus);
        } else {
            gain.connect(bus);
        }
        lane.voice = { ctx, gain, panner, nextPlayTime: 0 };
        return lane.voice;
    }

    _dropVoice(lane) {
        const v = lane.voice;
        lane.voice = null;
        if (!v) return;
        try { v.gain.disconnect(); } catch (e) { /* context already gone */ }
        if (v.panner) { try { v.panner.disconnect(); } catch (e) { /* ditto */ } }
    }

    _dropDecoder(lane) {
        if (lane.decoder) { try { lane.decoder.free(); } catch (e) { /* ignore */ } }
        lane.decoder = null;
        lane.decRate = 0;
        lane.decCh = 0;
    }

    _rebuildVoices() {
        for (const lane of this._assigned()) {
            if (lane.voice) this._voice(lane);
        }
    }

    _level(lane) {
        const l = listenOf(this.store.get(), lane.slotId);
        return l.muted || this.main.held ? 0 : l.vol;
    }

    _applyVoices() {
        for (const lane of this._assigned()) {
            const v = lane.voice;
            if (!v) continue;
            v.gain.gain.setTargetAtTime(this._level(lane), v.ctx.currentTime, 0.015);
        }
    }

    // Every VFO being heard, main included, placed by lib/vfoPan.js. One VFO
    // alone gives the sides back to the Audio panel's channel picker — as IQ
    // always does, there being no listening VFOs there and its left and right
    // being I and Q.
    _applyPans() {
        const lanes = this._assigned().filter((l) => !l.refused);
        const state = this.store.get();
        const t = this.main.tuning;
        const p = this.player;
        if (!this.main.running || !t || this._iq(this.main) || !lanes.length) {
            if (this.mainPan != null && p && p.setPan) p.setPan(null);
            this.mainPan = null;
            this.panState = null;
            for (const lane of lanes) this._setLanePan(lane, null);
            return;
        }
        const list = [{ id: state.active, frequency: t.frequency, out: listenOf(state, state.active).out }];
        for (const lane of lanes) {
            const slot = state.slots[lane.slotId];
            list.push({
                id: lane.slotId,
                frequency: slot ? slot.frequency : 0,
                out: listenOf(state, lane.slotId).out,
            });
        }
        this.panState = vfoPans(list, this.panState);
        const main = this.panState.pans[state.active];
        if (main !== this.mainPan && p && p.setPan) p.setPan(main);
        this.mainPan = main;
        for (const lane of lanes) this._setLanePan(lane, this.panState.pans[lane.slotId]);
    }

    _setLanePan(lane, pan) {
        lane.pan = pan == null ? null : pan;
        const v = lane.voice;
        if (v && v.panner) v.panner.pan.setTargetAtTime(lane.pan || 0, v.ctx.currentTime, 0.015);
    }
}

function freshMeters() {
    return {
        basebandPower: null, noisePower: null, snr: null, squelchOpen: true, lastOpenAt: 0, snrHistory: [],
    };
}

function gateValue(threshold) {
    return threshold == null ? SQUELCH_SENTINEL : threshold;
}

function modeKey(t) {
    return t ? `${t.mode}|${t.bandwidthLow}|${t.bandwidthHigh}` : '';
}

function modeChanged(a, b) {
    return modeKey(a) !== modeKey(b);
}

// One per player, which is one per page. Created by SubReceiversWatch; the
// panels reach it through useSubReceivers (./useSubReceivers.js).
let instance = null;

/** The page's SubReceivers, made for `player` on first call. */
export function getSubReceivers(player) {
    if (!instance && player) instance = new SubReceivers(player);
    return instance;
}
