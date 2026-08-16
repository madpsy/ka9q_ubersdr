// RM Noise: somebody else's AI denoiser, over WebRTC.
//
// A port of static/rmnoise.js — the protocol, the resampling and the buffering
// are that file's, and the numbers in here are not to be "improved" without a
// reason better than symmetry: they were arrived at against a live service
// whose behaviour is not documented anywhere. What changed is the shape. v1 is
// one file that owns the transport, the DSP, the modal, the log and the button
// colours; this is the transport and the DSP, with an Emitter where the DOM
// writes used to be. The panel is a view over it, and a collapsed panel must
// not drop a connection that took a login to make.
//
// ── What it is ────────────────────────────────────────────────────────────────
//
// rmnoise.com run a voice denoiser as a service. The audio goes there and comes
// back cleaned, which makes this the one noise reducer here that needs an
// account, a network round trip and somebody else's uptime — and the reason it
// sits behind its own engine choice rather than being switched on by default.
//
// ── The login dance ───────────────────────────────────────────────────────────
//
// Three upstream calls, and the browser can make none of them: rmnoise.com
// sends no CORS headers, so a fetch from this page is refused before it starts.
// The receiver proxies them instead, collapsed into one request —
// /api/rmnoise/credentials (rmnoise_proxy.go), which is rate limited per IP and
// keeps no session state:
//
//   1. POST /users2/login                — username and password, cookie jar
//   2. POST /users2/get_webrtc_token     — the token the signalling socket wants
//   3. POST /users2/get_turn_credentials — TURN servers for the media path
//
// Then the signalling, which is ours to do:
//
//   4. WebSocket to wss://s2.rmnoise.com:8766, send {type:'auth', token}
//   5. on auth_ok, choose the AI model: {type:'ai_filter_selection', filterNumber}
//   6. RTCPeerConnection with those ICE servers, one unreliable data channel,
//      offer/answer and ICE candidates over the same socket
//   7. the data channel opens and the audio starts flowing
//
// The audio never touches the WebSocket: signalling there, samples over the
// data channel, which is `ordered: false, maxRetransmits: 0` because a late
// frame is worth less than a prompt gap.
//
// ── The wire ──────────────────────────────────────────────────────────────────
//
// 8 kHz int16 mono, 384 samples (48 ms) per frame, each behind a 20-byte
// header: frame number (uint64 LE), timestamp (uint64 LE), and an audio scale
// (uint32 LE) which is floor(32767 / peak) for that frame — normalisation, and
// the reason quiet audio does not arrive quantised to nothing.
//
// ── The pipeline ──────────────────────────────────────────────────────────────
//
// Send: low-pass at 2.8 kHz → accumulate a frame → Lanczos to 8 kHz → scale to
// int16 → the data channel. Receive: unscale → jitter buffer → an accumulator
// → Lanczos back up → hand back exactly as many samples as were asked for.
//
// Two of those need defending, because both are load-bearing:
//
//   * **the 2.8 kHz filter.** The model is trained on voice bandwidth. Given
//     anything wider it produces frames that do not join up, which is heard as
//     popping. So the send path is filtered whatever the receiver's own filter
//     is set to.
//   * **the OversizeBuffer.** A windowed-sinc resampler is wrong near the edges
//     of a finite chunk, because the kernel reaches for samples that are not
//     there. Every frame is therefore padded with real audio from its
//     neighbours, resampled, and only the middle kept.
//
// And one that is a judgement rather than a technique: on underrun this returns
// *silence*, not the original audio. Dropping back to undenoised audio for a
// few frames is a far more noticeable artefact than a short gap, and the Python
// client made the same call.

import { Emitter } from '../radio/emitter.js';

const RM_RATE = 8000;                          // wire protocol sample rate
const RM_FRAME = 384;                          // 48 ms at 8 kHz
const RM_SERVER = 'wss://s2.rmnoise.com:8766';
const RM_CREDENTIALS_URL = '/api/rmnoise/credentials';

// Where an account comes from, for the panel to link to. The service's own
// site, not the reseller page v1 points at.
export const RM_REGISTER_URL = 'https://rmnoise.com';

// ---- which model suits which mode -------------------------------------------
//
// The service trains a model per kind of signal and names them accordingly:
// the list that comes back over the signalling socket has Phone models, CW
// models and FM models in it. So the mode does not merely decide whether this
// is worth running — it decides *which model to run*, and picking the CW model
// for SSB is as wrong as running the whole thing on AM.
//
// v1 offers this on SSB and CW only, and leaves the model to the operator. FM
// is included here because the service has a model for it; AM and SAM are not,
// because it does not — a double-sideband carrier is nothing like anything in
// the list, and the honest answer there is to switch off rather than send
// audio to be mangled.
export const RM_FAMILIES = {
    usb: 'ssb',
    lsb: 'ssb',
    cwu: 'cw',
    cwl: 'cw',
    fm: 'fm',
    nfm: 'fm',
};

export const RM_MODES = new Set(Object.keys(RM_FAMILIES));

export function rmModeSupported(mode) {
    return RM_MODES.has(String(mode || '').toLowerCase());
}

/** 'ssb' | 'cw' | 'fm' | '' — what kind of model this mode wants. */
export function rmFamilyFor(mode) {
    return RM_FAMILIES[String(mode || '').toLowerCase()] || '';
}

/**
 * Which family a model in the service's list belongs to, read from its own
 * name. The service says SSB, CW and FM, so those are the words looked for.
 *
 * The *order* of the tests is the whole of it, and it is not alphabetical: a
 * name can carry more than one of these words — "Phone FM" is the one that
 * caught this out — and the most specific has to win. Asking "does this say
 * phone?" first classified the FM model as an SSB one, so coming back to LSB
 * from FM left the FM model running, because it already looked suitable.
 *
 * Matched on the description rather than on a filter number: the numbers are
 * theirs to renumber between one connection and the next, and the names are
 * what an operator reads in the dropdown.
 */
// What each family is *called* in the service's own names, and how strongly.
// The names are all of the form "Phone something": "Phone SSB …", "Phone CW …",
// "Phone FM …", and — the one that matters here — "Phone web client version",
// which says nothing about the kind of signal at all.
//
// So "Phone" cannot be the evidence, only the absence of better evidence. A
// model naming its family outright wins over one that merely looks like voice,
// which is what "first Phone model in the list" got wrong: coming back to LSB
// picked "Phone web client version" over "Phone SSB …" purely because it was
// listed first.
const NAMES = {
    fm: /\bn?fm\b/i,
    cw: /\bcw\b|morse/i,
    ssb: /\bssb\b/i,
};
// Weaker still, and only for voice: a name that reads as speech without saying
// which kind. Never enough to outrank a name that says SSB.
const VOICEISH = /phone|voice/i;

/**
 * Which family a model belongs to, from its own name — FM and CW first,
 * because a name can carry more than one of these words and the most specific
 * has to win. "Phone FM" is an FM model, not a voice one.
 */
export function rmFamilyOfModel(desc) {
    const name = String(desc || '');
    if (NAMES.fm.test(name)) return 'fm';
    if (NAMES.cw.test(name)) return 'cw';
    if (NAMES.ssb.test(name)) return 'ssb';
    if (VOICEISH.test(name)) return 'ssb';
    return '';
}

/**
 * The model to run for this mode: the first one that *names* the family, and
 * only failing that the first that merely belongs to it.
 *
 * Two passes rather than one, because the service lists several models whose
 * names begin "Phone" and only some of them say what they are for. Within a
 * pass the service's own order decides, which is the right tie-break — it
 * knows which of its SSB models to offer first and this file does not.
 */
export function rmModelFor(mode, filters) {
    const family = rmFamilyFor(mode);
    if (!family || !Array.isArray(filters)) return null;
    const named = NAMES[family];
    return filters.find((f) => named.test(String(f.filterDesc || '')))
        || filters.find((f) => rmFamilyOfModel(f.filterDesc) === family)
        || null;
}

// ---- where the login is kept ------------------------------------------------
//
// Under `ubersdr.v2.` and in one object, which is not housekeeping: this is the
// only credential in the interface that belongs to the *operator* rather than
// to the receiver. The rotator password, the antenna switch, the bypass — those
// are facts about one instance and must not follow anybody to another one. An
// rmnoise.com account is the person's, has nothing to do with which receiver
// they are listening to, and being asked for it again on every receiver would
// be a chore that buys no safety.
//
// Only prefixed keys travel between receivers in the apps (see the clients'
// shared-settings code), which is why this is not simply v1's three unprefixed
// keys — those could never move. It is listed in USER_SECRETS in lib/backup.js,
// so it travels between receivers and still never reaches a settings file.
//
// v1's keys are read as a seed and written alongside, so an operator who has
// already logged in there is not asked again, and the classic interface keeps
// working from the same login on this origin.
const KEY = 'ubersdr.v2.rmnoise';
const V1_USER = 'rmnoise_username';
const V1_PASS = 'rmnoise_password';
const V1_FILTER = 'rmnoise_filter';

export function rmCredentials() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (raw && typeof raw === 'object') {
            return {
                username: raw.username || '',
                password: raw.password || '',
                filterNumber: Number(raw.filterNumber) || 1,
                // Which model was chosen for each kind of signal — see
                // rememberModel. Kept beside the login because it is the same
                // sort of thing: the operator's, not the receiver's.
                models: (raw.models && typeof raw.models === 'object') ? raw.models : {},
            };
        }
        return {
            username: localStorage.getItem(V1_USER) || '',
            password: localStorage.getItem(V1_PASS) || '',
            filterNumber: Number(localStorage.getItem(V1_FILTER)) || 1,
            models: {},
        };
    } catch (e) {
        return { username: '', password: '', filterNumber: 1, models: {} };
    }
}

export function saveRmCredentials(patch) {
    const now = rmCredentials();
    const next = { ...now, ...patch, models: { ...now.models, ...(patch.models || {}) } };
    try {
        localStorage.setItem(KEY, JSON.stringify(next));
        // v1 reads its own keys and knows nothing about the one above.
        localStorage.setItem(V1_USER, next.username);
        localStorage.setItem(V1_PASS, next.password);
        localStorage.setItem(V1_FILTER, String(next.filterNumber));
    } catch (e) { /* private mode */ }
    return next;
}

// ---- resampling -------------------------------------------------------------

// Pads a frame with context from its neighbours so the resampler's kernel has
// real audio at the edges, then hands back only the middle. v1's class, whose
// own ancestor is the reference audio_mixer_processor.js.
export class OversizeBuffer {
    constructor(frameLengthSamples, trailingBufferSamples, leadingBufferSamples,
        trailingSlice, leadingSlice) {
        this.frameLengthSamples = frameLengthSamples;
        this.trailingBufferSamples = trailingBufferSamples;
        this.leadingBufferSamples = leadingBufferSamples;
        this.trailingSlice = trailingSlice;
        this.leadingSlice = leadingSlice;
        this.totalBufferSize = trailingBufferSamples + leadingBufferSamples;
        this.contextBuffer = new Float32Array(this.totalBufferSize);
    }

    addFrame(inputFrame) {
        const oversized = new Float32Array(this.totalBufferSize + inputFrame.length);
        oversized.set(this.contextBuffer, 0);
        oversized.set(inputFrame, this.totalBufferSize);
        this.contextBuffer.set(oversized.subarray(oversized.length - this.totalBufferSize));
        return oversized;
    }

    /** The middle of a resampled oversized frame — the part without edge error. */
    goodFrame(resampled) {
        return resampled.subarray(this.trailingSlice, resampled.length - this.leadingSlice);
    }

    reset() {
        this.contextBuffer.fill(0);
    }
}

/** Lanczos (a = 3) windowed sinc. Stateless; the edges are OversizeBuffer's job. */
export function lanczosResample(input, from, to) {
    if (from === to) return input;

    const ratio = from / to;
    const newLength = Math.round(input.length / ratio);
    const output = new Float32Array(newLength);
    const a = 3;

    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const lanczos = (x) => {
        if (x === 0) return 1;
        if (x > -a && x < a) return sinc(x) * sinc(x / a);
        return 0;
    };

    for (let i = 0; i < newLength; i++) {
        const at = i * ratio;
        let sum = 0;
        let weightSum = 0;
        const start = Math.floor(at - a + 1);
        const end = Math.ceil(at + a);
        for (let j = start; j < end; j++) {
            if (j >= 0 && j < input.length) {
                const w = lanczos(at - j);
                sum += input[j] * w;
                weightSum += w;
            }
        }
        output[i] = weightSum === 0 ? 0 : sum / weightSum;
    }
    return output;
}

// Context generous enough for the a = 3 kernel on both sides of the conversion.
export function createOversizeBuffers(inputRate) {
    const ratio = inputRate / RM_RATE;
    const accumTarget = Math.round(RM_FRAME * ratio);
    const ctx8k = 10;
    const ctxHi = Math.ceil(ctx8k * ratio);
    return {
        downsampleOSB: new OversizeBuffer(accumTarget, ctxHi, ctxHi, ctx8k, ctx8k),
        upsampleOSB: new OversizeBuffer(RM_FRAME, ctx8k, ctx8k, ctxHi, ctxHi),
    };
}

// ---- the 2.8 kHz send filter -----------------------------------------------

export function designLPF(cutoffHz, sampleRate) {
    let numTaps = Math.min(Math.floor(sampleRate / 10), 1001);
    if (numTaps % 2 === 0) numTaps += 1;

    const coeffs = new Float32Array(numTaps);
    const fc = cutoffHz / sampleRate;
    const M = (numTaps - 1) / 2;
    for (let n = 0; n < numTaps; n++) {
        const x = n - M;
        const h = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numTaps - 1));
        coeffs[n] = h * w;
    }
    let sum = 0;
    for (let i = 0; i < numTaps; i++) sum += coeffs[i];
    for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;
    return coeffs;
}

export function applyLPF(input, coeffs, state) {
    const numTaps = coeffs.length;
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        for (let j = numTaps - 2; j > 0; j--) state[j] = state[j - 1];
        state[0] = input[i];
        let y = coeffs[0] * input[i];
        for (let j = 1; j < numTaps; j++) y += coeffs[j] * state[j - 1];
        output[i] = y;
    }
    return output;
}

// ---- the wire ---------------------------------------------------------------

export function packFrame(frameNum, tsMs, pcm, scale) {
    const buf = new ArrayBuffer(20 + pcm.length * 2);
    const view = new DataView(buf);
    view.setBigUint64(0, BigInt(frameNum), true);
    view.setBigUint64(8, BigInt(tsMs), true);
    view.setUint32(16, scale, true);
    new Int16Array(buf, 20).set(pcm);
    return buf;
}

export function unpackFrame(data) {
    const view = new DataView(data);
    return {
        frameNum: view.getBigUint64(0, true),
        tsMs: view.getBigUint64(8, true),
        scale: view.getUint32(16, true),
        pcm: new Int16Array(data, 20),
    };
}

// ---- the bridge -------------------------------------------------------------

// Frames held before the network's own jitter is somebody else's problem, and
// how far the output may run ahead. Both are v1's, and both were arrived at the
// hard way: a jitter buffer of 256 frames (twelve seconds) let a burst pile up
// and then dropped whole frames, which played as a bang.
const JITTER_MAX = 20;
const ACCUM_OUT_MAX = 4000;        // ~500 ms at 8 kHz
const PRIME_FRAMES = 2;            // buffered before the first sample is played
// Frames in flight when the sample rate changes were encoded at the old one.
const RATE_CHANGE_DISCARD_MS = 300;

/**
 * Events: 'change' whenever the state worth showing moves, 'log' for the line
 * the panel prints. Nothing here touches the DOM.
 */
export class RmNoiseBridge extends Emitter {
    constructor() {
        super();
        this.enabled = false;      // the operator wants it
        this.ready = false;        // the data channel is open
        this.connecting = false;
        this.error = '';
        // Why it is not connected, which decides whether anything should try
        // again on its own: 'stopped' is the operator having pressed
        // Disconnect, 'auth' is rmnoise.com refusing the login. Neither is
        // retried — one because they asked for it to stop, the other because
        // the same password will be refused again and the endpoint is rate
        // limited by IP.
        this.stopped = false;
        this.authFailed = false;
        this.filterNumber = 1;
        this.availableFilters = [];
        this.latencyMs = 0;
        this.lines = [];           // recent log, newest last

        this.ws = null;
        this.pc = null;
        this.dc = null;

        this._reset();
    }

    _reset() {
        this.frameNum = BigInt(0);
        this.inputRate = 0;
        this.accumIn = new Float32Array(0);
        this.accumOut = new Float32Array(0);
        this.jitterBuf = [];
        this.sendTimes = new Map();
        this.primed = false;
        this.downsampleOSB = null;
        this.upsampleOSB = null;
        this.lpfCoeffs = null;
        this.lpfState = null;
        this.lpfRate = 0;
        this.rateChangedAt = 0;
    }

    /**
     * How much denoised audio is waiting to be played, in milliseconds.
     *
     * Not the jitter buffer's depth, which is what v1 showed and which is
     * almost always zero: every call to process() drains it into the output
     * accumulator, so reading it says nothing except that the last drain
     * happened. What is worth watching is the accumulator — the reserve
     * standing between the network and a gap in the audio.
     */
    get bufferMs() {
        return Math.round((this.accumOut.length / RM_RATE) * 1000);
    }

    log(message) {
        this.lines.push({ at: Date.now(), message });
        if (this.lines.length > 50) this.lines.shift();
        this.emit('log', message);
        this.emit('change');
    }

    /**
     * Log in through the receiver's proxy, then open the signalling socket and
     * the data channel. Resolves once audio can flow; rejects with something
     * worth showing an operator.
     */
    async connect({ username, password, filterNumber, mode } = {}) {
        if (this.connecting || this.ready) return;
        const creds = rmCredentials();
        const user = username || creds.username;
        const pass = password || creds.password;
        if (!user || !pass) throw new Error('An rmnoise.com username and password are needed.');

        this.connecting = true;
        this.error = '';
        this.stopped = false;
        if (mode) this.mode = mode;
        this.authFailed = false;
        this.filterNumber = filterNumber || creds.filterNumber || 1;
        this.log(`Connecting as ${user}…`);
        this.emit('change');

        try {
            const res = await fetch(RM_CREDENTIALS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user, password: pass }),
            });
            const reply = await res.text();

            let data;
            try {
                data = JSON.parse(reply);
            } catch (e) {
                throw new Error('The receiver’s RM Noise proxy answered with something that is not JSON.');
            }
            if (!data.ok) {
                // 401 is the proxy having been told no by rmnoise.com — a
                // wrong username or password, or a session that did not take.
                // Remembered as such: the fields come back on screen and
                // nothing retries until they are changed.
                if (res.status === 401) this.authFailed = true;
                throw new Error(data.error
                    || (res.status === 401 ? 'rmnoise.com refused that username and password.'
                        : 'RM Noise could not be reached.'));
            }

            const token = data.webrtc_token;
            const turn = data.turn_creds;
            if (!token?.success || !token?.token) throw new Error('No WebRTC token came back.');
            if (!turn?.success) throw new Error('No TURN credentials came back.');

            this.log('Credentials accepted');
            await this._openSocket(token.token, [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: turn.uris || [], username: turn.username, credential: turn.password },
            ]);
        } catch (err) {
            this.error = err.message || String(err);
            this.log(`Connection failed: ${this.error}`);
            this.connecting = false;
            this.enabled = false;
            this.emit('change');
            throw err;
        }
    }

    _openSocket(token, iceServers) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(RM_SERVER);
            this.ws = ws;

            ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));

            ws.onmessage = async (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch (e) { return; }
                switch (msg.type) {
                    case 'auth_ok':
                        this.log('Signalling authenticated');
                        ws.send(JSON.stringify({
                            type: 'ai_filter_selection',
                            filterNumber: this.filterNumber,
                        }));
                        try {
                            await this._openPeer(ws, iceServers);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                        break;
                    case 'answer':
                        if (this.pc) {
                            const answer = msg.answer || msg;
                            await this.pc.setRemoteDescription(
                                new RTCSessionDescription({ type: 'answer', sdp: answer.sdp }),
                            );
                        }
                        break;
                    case 'ice-candidate':
                        if (this.pc && msg.candidate && msg.candidate.candidate) {
                            try {
                                await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                            } catch (e) { /* a candidate that will not take is not fatal */ }
                        }
                        break;
                    case 'ai_filters_list':
                        this.availableFilters = msg.filters || [];
                        this.log(`${this.availableFilters.length} AI filters offered`);
                        // The list is the first chance to know what the service
                        // actually has, so it is also the first chance to pick
                        // the one that suits the mode.
                        this.matchModel(this.mode);
                        this.emit('change');
                        break;
                    case 'entered_standby':
                        this.log(`Service in standby${msg.reason ? `: ${msg.reason}` : ''}`);
                        break;
                    case 'left_standby':
                        this.log('Service out of standby');
                        break;
                    default:
                        break;
                }
            };

            ws.onerror = () => reject(new Error('The RM Noise signalling socket would not open.'));
            ws.onclose = () => { if (this.ready) this._dropped('Signalling closed'); };
        });
    }

    async _openPeer(ws, iceServers) {
        const pc = new RTCPeerConnection({ iceServers });
        this.pc = pc;

        // Unreliable and unordered on purpose: a frame that arrives late is
        // worth less than the gap waiting for it would cost.
        const dc = pc.createDataChannel('audio', { ordered: false, maxRetransmits: 0 });
        dc.binaryType = 'arraybuffer';      // before onmessage can fire
        this.dc = dc;

        dc.onopen = () => {
            this.ready = true;
            this.connecting = false;
            this.error = '';
            this.log('Audio channel open — denoising');
            this.emit('change');
        };
        dc.onclose = () => { if (this.ready) this._dropped('Audio channel closed'); };
        dc.onmessage = (ev) => this._receive(ev.data);

        pc.onicecandidate = (ev) => {
            if (!ev.candidate) return;
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: {
                    candidate: ev.candidate.candidate,
                    sdpMid: ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                },
            }));
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', offer: { type: 'offer', sdp: pc.localDescription.sdp } }));
    }

    _receive(data) {
        // Frames encoded before a sample-rate change are of no use after it.
        if (this.rateChangedAt && performance.now() - this.rateChangedAt < RATE_CHANGE_DISCARD_MS) {
            return;
        }
        try {
            const { frameNum, scale, pcm } = unpackFrame(data);
            const s = scale > 0 ? scale : 32767;
            const frame = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) frame[i] = pcm[i] / s;

            // Round trip for this frame, smoothed a little: a single frame's
            // figure jumps by tens of milliseconds with ordinary network
            // jitter, and a number that flickers is read as a fault rather
            // than as a measurement. The frame number is the service's echo of
            // ours, so a miss here means it renumbered — in which case there
            // is nothing to measure against and the last figure stands.
            const sent = this.sendTimes.get(frameNum);
            if (sent !== undefined) {
                const ms = performance.now() - sent;
                this.latencyMs = this.latencyMs ? this.latencyMs * 0.8 + ms * 0.2 : ms;
                this.sendTimes.delete(frameNum);
            }

            if (this.jitterBuf.length >= JITTER_MAX) this.jitterBuf.shift();
            this.jitterBuf.push(frame);
        } catch (e) {
            /* a malformed frame is one frame */
        }
    }

    _dropped(why) {
        this.ready = false;
        this.connecting = false;
        this.log(why);
        this.emit('change');
    }

    /**
     * `manual` is the operator pressing Disconnect, which means stay that way.
     * Without it this is teardown — the engine was switched away from, or the
     * mode stopped suiting it — and choosing the engine again may reconnect.
     */
    async disconnect({ manual = false } = {}) {
        if (manual) {
            this.stopped = true;
            this.log('Disconnected');
        }
        if (this.dc) { try { this.dc.close(); } catch (e) { /* already gone */ } }
        if (this.pc) { try { this.pc.close(); } catch (e) { /* already gone */ } }
        if (this.ws) { try { this.ws.close(); } catch (e) { /* already gone */ } }
        this.dc = null;
        this.pc = null;
        this.ws = null;
        this.ready = false;
        this.connecting = false;
        this._reset();
        this.emit('change');
    }

    /**
     * Remember which model the operator chose for this kind of signal, so
     * returning to it brings their choice back rather than the first of its
     * kind.
     *
     * Kept by name as well as by number: the numbers are the service's to
     * renumber between one connection and the next, and a stale number would
     * otherwise silently select whatever now holds it. The name is matched
     * first and the number is the fallback.
     */
    rememberModel(filterNumber) {
        const family = rmFamilyFor(this.mode);
        if (!family) return;
        const chosen = this.availableFilters.find((f) => f.filterNumber === filterNumber);
        saveRmCredentials({
            models: { [family]: { number: filterNumber, desc: chosen ? chosen.filterDesc : '' } },
        });
    }

    /** The model this operator last chose for this family, if it is still offered. */
    _preferredModel(family) {
        const saved = rmCredentials().models[family];
        if (!saved) return null;
        return this.availableFilters.find((f) => f.filterDesc && f.filterDesc === saved.desc)
            || this.availableFilters.find((f) => f.filterNumber === saved.number)
            || null;
    }

    /**
     * Follow the mode: choose the model whose name suits it, if the service has
     * one and the operator is not already on it.
     *
     * Only when the *family* changes — SSB to CW, CW to FM. Somebody who picked
     * a particular Phone model from several keeps it while they tune around the
     * phone bands, which is what makes this a convenience rather than a control
     * that keeps taking itself back.
     */
    matchModel(mode) {
        this.mode = mode || this.mode;
        const family = rmFamilyFor(this.mode);
        if (!family || !this.availableFilters.length) return;

        // Already on a model of the right kind: leave it alone, whichever of
        // that kind it is. Classified by family rather than by "does the name
        // suit" — the loose question is what let "Phone FM" pass as SSB.
        //
        // Left alone even if it is not the remembered one, because the way to
        // be on a same-family model that is not the remembered one is to have
        // just chosen it: re-selecting over the top of that would be a control
        // taking itself back a moment after it was set.
        const current = this.availableFilters.find((f) => f.filterNumber === this.filterNumber);
        if (current && rmFamilyOfModel(current.filterDesc) === family) return;

        // Their choice for this kind of signal if they have made one — even a
        // deliberately odd one, like running the CW model on SSB, which is
        // theirs to make — and otherwise the first model of the right kind.
        const wanted = this._preferredModel(family) || rmModelFor(this.mode, this.availableFilters);
        if (!wanted || wanted.filterNumber === this.filterNumber) return;
        this.log(`${String(this.mode).toUpperCase()} — ${wanted.filterDesc || `filter ${wanted.filterNumber}`}`);
        // Not remembered: this is following what was already remembered, or a
        // default. Only the operator's own pick is a preference.
        this.setFilter(wanted.filterNumber, { remember: false });
    }

    /**
     * Tell the service to run a different model. Kept for the next connect too,
     * and — when this came from the operator rather than from following the
     * mode — remembered against the kind of signal they chose it for.
     */
    setFilter(filterNumber, { remember = true } = {}) {
        this.filterNumber = Number(filterNumber) || 1;
        saveRmCredentials({ filterNumber: this.filterNumber });
        if (remember) this.rememberModel(this.filterNumber);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'ai_filter_selection',
                filterNumber: this.filterNumber,
            }));
            this.log(`Filter ${this.filterNumber} selected`);
        }
        this.emit('change');
    }

    /** Everything in flight belongs to the old rate. See RATE_CHANGE_DISCARD_MS. */
    onSampleRateChange(rate) {
        this.inputRate = rate;
        this.accumIn = new Float32Array(0);
        this.accumOut = new Float32Array(0);
        this.jitterBuf = [];
        this.primed = false;
        this.frameNum = BigInt(0);
        this.sendTimes.clear();
        this.rateChangedAt = performance.now();
        this.downsampleOSB = null;
        this.upsampleOSB = null;
        this.lpfCoeffs = null;
        this.lpfState = null;
        this.lpfRate = 0;
    }

    /**
     * Mono in, mono out, at `sampleRate`. Returns null when there is nothing to
     * denoise with — the caller plays what it already had — and silence while
     * the pipeline is filling or has run dry, which is the one thing that must
     * not fall back to the original audio: dropping in and out of denoising
     * every few frames is far more noticeable than a short gap.
     */
    process(audio, sampleRate) {
        if (!this.ready || !this.dc || this.dc.readyState !== 'open') return null;

        if (this.inputRate !== sampleRate || !this.downsampleOSB) {
            this.inputRate = sampleRate;
            this.accumIn = new Float32Array(0);
            this.accumOut = new Float32Array(0);
            this.primed = false;
            const bufs = createOversizeBuffers(sampleRate);
            this.downsampleOSB = bufs.downsampleOSB;
            this.upsampleOSB = bufs.upsampleOSB;
        }

        const nIn = audio.length;
        const accumTarget = Math.round((RM_FRAME * sampleRate) / RM_RATE);

        // Voice bandwidth, whatever the receiver's filter is doing — see the
        // note at the top.
        if (!this.lpfCoeffs || this.lpfRate !== sampleRate) {
            this.lpfRate = sampleRate;
            this.lpfCoeffs = designLPF(2800, sampleRate);
            this.lpfState = new Float32Array(this.lpfCoeffs.length - 1);
        }
        const sendAudio = applyLPF(audio, this.lpfCoeffs, this.lpfState);

        // ---- send ----
        const nextIn = new Float32Array(this.accumIn.length + nIn);
        nextIn.set(this.accumIn);
        nextIn.set(sendAudio, this.accumIn.length);
        this.accumIn = nextIn;

        while (this.accumIn.length >= accumTarget) {
            const chunk = this.accumIn.slice(0, accumTarget);
            this.accumIn = this.accumIn.slice(accumTarget);
            try {
                const oversized = this.downsampleOSB.addFrame(chunk);
                const down = lanczosResample(oversized, sampleRate, RM_RATE);
                const good = this.downsampleOSB.goodFrame(down);

                const frame = new Float32Array(RM_FRAME);
                frame.set(good.length >= RM_FRAME ? good.subarray(0, RM_FRAME) : good);

                let maxAbs = 0;
                for (let i = 0; i < frame.length; i++) {
                    const a = Math.abs(frame[i]);
                    if (a > maxAbs) maxAbs = a;
                }
                const scale = maxAbs > 1e-9
                    ? Math.min(Math.floor(32767 / maxAbs), 4294967295)
                    : 1;

                const pcm = new Int16Array(RM_FRAME);
                for (let i = 0; i < RM_FRAME; i++) {
                    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * scale)));
                }

                const num = this.frameNum;
                this.sendTimes.set(num, performance.now());
                if (this.sendTimes.size > 300) {
                    this.sendTimes.delete(this.sendTimes.keys().next().value);
                }
                if (this.dc && this.dc.readyState === 'open') {
                    this.dc.send(packFrame(num, BigInt(Date.now()), pcm, scale));
                }
                this.frameNum = num + BigInt(1);
            } catch (e) {
                /* one frame lost is one frame */
            }
        }

        // ---- receive ----
        while (this.jitterBuf.length > 0) {
            const frame = this.jitterBuf.shift();
            const merged = new Float32Array(this.accumOut.length + frame.length);
            merged.set(this.accumOut);
            merged.set(frame, this.accumOut.length);
            this.accumOut = merged;
        }

        // A backlog is latency nobody asked for, and dropping it later — when
        // the jitter buffer overflows — is a discontinuity that plays as a
        // bang. Trim here instead, and reset the upsampler's context with it:
        // it holds the tail of the audio being thrown away, and would bridge
        // across the join.
        if (this.accumOut.length > ACCUM_OUT_MAX) {
            this.accumOut = this.accumOut.slice(this.accumOut.length - ACCUM_OUT_MAX);
            if (this.upsampleOSB) this.upsampleOSB.reset();
        }

        if (!this.primed) {
            if (this.accumOut.length >= RM_FRAME * PRIME_FRAMES) {
                this.primed = true;
                this.log('Buffer primed');
            } else {
                return new Float32Array(nIn);
            }
        }

        const need = Math.ceil((nIn * RM_RATE) / sampleRate);
        if (this.accumOut.length >= need) {
            const chunk = this.accumOut.slice(0, need);
            this.accumOut = this.accumOut.slice(need);
            const oversized = this.upsampleOSB.addFrame(chunk);
            const up = lanczosResample(oversized, RM_RATE, sampleRate);
            const good = this.upsampleOSB.goodFrame(up);
            if (good.length >= nIn) return good.slice(0, nIn);
            const out = new Float32Array(nIn);
            out.set(good);
            return out;
        }

        // Ran dry. Silence rather than the original audio — see above.
        return new Float32Array(nIn);
    }
}

// One bridge for the page, like the recorder: a connection that took a login to
// make must not end because a panel was collapsed.
let bridge = null;

export function getRmNoise() {
    if (!bridge) bridge = new RmNoiseBridge();
    return bridge;
}
