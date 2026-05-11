/**
 * rmnoise.js — RMNoise AI denoising for UberSDR web client
 *
 * Protocol (reverse-engineered from audio-mixer-processor2.js):
 *   - Audio sent/received at 8 kHz int16 PCM
 *   - Each frame: 20-byte header + int16 PCM samples
 *   - Header: frameNumber (uint64 LE) + timestamp (uint64 LE) + audioScale (uint32 LE)
 *   - audioScale = floor(32767 / max_abs_value)  [normalisation factor]
 *   - Frame size: 384 samples @ 8 kHz = 64 ms
 *
 * Mirrors clients/python/rmnoise_denoise.py + rmnoise_window.py
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const RM_RATE   = 8000;   // RMNoise wire protocol sample rate
const RM_FRAME  = 384;    // 64 ms at 8 kHz
const RM_SERVER = 'wss://s2.rmnoise.com:8766';
// RM_BASE (https://rmnoise.com) is no longer used for fetch() calls — the Go
// server-side CORS proxy handles those.  RM_SERVER is still used for WebSocket.

// ── OversizeBuffer ─────────────────────────────────────────────────────────────
//
// Adapted from the known-good audio_mixer_processor.js reference implementation.
//
// A windowed-sinc (Lanczos) resampler produces subtly wrong output samples
// near the edges of a finite chunk because the kernel reaches for samples
// that don't exist beyond the chunk boundary.  The OversizeBuffer pattern
// solves this by:
//   1. Padding each frame with context samples from adjacent frames
//   2. Resampling the oversized frame (which has valid data at the edges)
//   3. Extracting only the central "good" portion, discarding edge artifacts
//
// The context buffer carries the tail of the previous frame into the next
// call, providing the resampler with real audio data at the boundaries.
//
class OversizeBuffer {
    /**
     * @param {number} frameLengthSamples   expected frame size (input side)
     * @param {number} trailingBufferSamples  context samples to prepend (from previous frames)
     * @param {number} leadingBufferSamples   context samples appended (lookahead)
     * @param {number} trailingSlice  samples to trim from start of resampled output
     * @param {number} leadingSlice   samples to trim from end of resampled output
     */
    constructor(frameLengthSamples, trailingBufferSamples, leadingBufferSamples, trailingSlice, leadingSlice) {
        this.frameLengthSamples    = frameLengthSamples;
        this.trailingBufferSamples = trailingBufferSamples;
        this.leadingBufferSamples  = leadingBufferSamples;
        this.trailingSlice         = trailingSlice;
        this.leadingSlice          = leadingSlice;
        this.totalBufferSize       = trailingBufferSamples + leadingBufferSamples;
        this.contextBuffer         = new Float32Array(this.totalBufferSize);
        this.contextBuffer.fill(0);
    }

    /**
     * Prepend context from previous frames, append the current frame,
     * and update the internal context buffer for the next iteration.
     *
     * @param {Float32Array} inputFrame
     * @returns {Float32Array} oversized frame (context + inputFrame)
     */
    addFrame(inputFrame) {
        const oversizedFrame = new Float32Array(this.totalBufferSize + inputFrame.length);
        oversizedFrame.set(this.contextBuffer, 0);
        oversizedFrame.set(inputFrame, this.totalBufferSize);

        // Update context: last totalBufferSize samples of the oversized frame
        this.contextBuffer.set(
            oversizedFrame.subarray(oversizedFrame.length - this.totalBufferSize)
        );
        return oversizedFrame;
    }

    /**
     * Extract the central "good" portion of a resampled oversized frame,
     * trimming edge-contaminated samples from both ends.
     *
     * @param {Float32Array} inputSamples  resampled oversized frame
     * @returns {Float32Array}
     */
    goodFrame(inputSamples) {
        return inputSamples.subarray(
            this.trailingSlice,
            inputSamples.length - this.leadingSlice
        );
    }

    /** Reset context buffer (e.g. on sample-rate change or disconnect). */
    reset() {
        this.contextBuffer.fill(0);
    }
}

// ── Lanczos resampler ──────────────────────────────────────────────────────────
//
// Stateless Lanczos (a=3) windowed-sinc resampler, copied from the known-good
// audio_mixer_processor.js reference.  Edge artifacts are handled by the
// OversizeBuffer pattern above — the resampler itself doesn't need state.
//
/**
 * Resample `input` from rate `from` to rate `to` using Lanczos interpolation.
 * @param {Float32Array} input
 * @param {number} from  source sample rate
 * @param {number} to    target sample rate
 * @returns {Float32Array}
 */
function lanczosResample(input, from, to) {
    if (from === to) return input;

    const ratio     = from / to;
    const newLength = Math.round(input.length / ratio);
    const output    = new Float32Array(newLength);
    const a         = 3;   // Lanczos kernel lobes
    const PI        = Math.PI;

    const sinc = (x) => {
        if (x === 0) return 1;
        return Math.sin(PI * x) / (PI * x);
    };
    const lanczos = (x) => {
        if (x === 0) return 1;
        if (x > -a && x < a) return sinc(x) * sinc(x / a);
        return 0;
    };

    for (let i = 0; i < newLength; i++) {
        const inputIndex = i * ratio;
        let sum       = 0;
        let weightSum = 0;
        const start = Math.floor(inputIndex - a + 1);
        const end   = Math.ceil(inputIndex + a);

        for (let j = start; j < end; j++) {
            if (j >= 0 && j < input.length) {
                const x      = inputIndex - j;
                const weight = lanczos(x);
                sum       += input[j] * weight;
                weightSum += weight;
            }
        }
        output[i] = weightSum === 0 ? 0 : sum / weightSum;
    }
    return output;
}

/**
 * Create a pair of OversizeBuffer instances sized for the given rates.
 * Context sizes are chosen to exceed the Lanczos a=3 kernel radius on
 * both sides of the rate conversion, matching the reference implementation's
 * approach of ~10 context samples on the low-rate side and the scaled
 * equivalent on the high-rate side.
 *
 * @param {number} inputRate  e.g. 12000
 * @returns {{ downsampleOSB: OversizeBuffer, upsampleOSB: OversizeBuffer }}
 */
function rmNoise_createOversizeBuffers(inputRate) {
    const ratio = inputRate / RM_RATE;   // e.g. 1.5 for 12 kHz, 6.0 for 48 kHz
    const accumTarget = Math.round(RM_FRAME * ratio);  // frame size at inputRate

    // Context samples on the low-rate (8 kHz) side — 10 is generous for a=3
    const ctx8k = 10;
    // Scaled equivalent on the high-rate side
    const ctxHi = Math.ceil(ctx8k * ratio);

    // Downsample: inputRate → 8 kHz
    // Context at inputRate, trim at 8 kHz
    const downsampleOSB = new OversizeBuffer(
        accumTarget,    // frame length at inputRate
        ctxHi, ctxHi,   // trailing + leading context at inputRate
        ctx8k, ctx8k     // trim from resampled 8 kHz output
    );

    // Upsample: 8 kHz → inputRate
    // Context at 8 kHz, trim at inputRate
    const upsampleOSB = new OversizeBuffer(
        RM_FRAME,        // frame length at 8 kHz (384)
        ctx8k, ctx8k,    // trailing + leading context at 8 kHz
        ctxHi, ctxHi     // trim from resampled inputRate output
    );

    return { downsampleOSB, upsampleOSB };
}

// ── State ──────────────────────────────────────────────────────────────────────
const rmNoise = {
    enabled:          false,
    bypass:           false,   // legacy — kept for compatibility but superseded by mixRatio
    ready:            false,
    connecting:       false,
    mixRatio:         1.0,     // 0.0 = 100% original, 1.0 = 100% denoised

    // WebRTC / WebSocket
    pc:               null,    // RTCPeerConnection
    dc:               null,    // RTCDataChannel
    ws:               null,    // WebSocket (signalling)

    // Protocol
    frameNum:         BigInt(0),
    inputRate:        12000,   // current server sample rate (updated per packet)
    filterNumber:     1,
    availableFilters: [],

    // Jitter buffer (stores Float32Array frames at 8 kHz).
    // Each frame is 384 samples = 48 ms.  Keep at most ~1 s (20 frames) here;
    // accumOut is separately capped at ~500 ms so the total pipeline latency
    // stays bounded.  The old value of 256 (≈12 s) allowed the buffer to grow
    // enormous during network bursts, causing loud pops when frames were
    // eventually dropped.
    jitterBuf:        [],
    jitterMax:        20,

    // Accumulators
    accumIn:          new Float32Array(0),   // input samples at inputRate
    accumOut:         new Float32Array(0),   // denoised 8 kHz samples

    // Pre-buffering: don't output denoised audio until we have a reserve built up.
    // At 8 kHz, RM_FRAME=384 samples = 48 ms per frame.
    // We wait for 5 frames (≈240 ms) before starting playback so the pipeline
    // stays ahead of the network round-trip.
    primed:           false,
    primeFrames:      2,       // number of 8 kHz frames to accumulate before starting
                               // (jitter buffer stays near 0 in practice; 5 was too
                               // aggressive and caused long silence on initial connect)

    // Latency tracking
    sendTimes:        new Map(),             // BigInt frameNum → performance.now()
    lastLatencyMs:    0,
    lastStatsUpdate:  0,

    // Stats poll interval
    statsInterval:    null,

    // OversizeBuffer instances — pad each frame with context from adjacent
    // frames before resampling, then extract the central "good" portion.
    // This eliminates edge artifacts from the Lanczos windowed-sinc kernel.
    // Initialised lazily via rmNoise_createOversizeBuffers() on first use
    // or rate change.
    downsampleOSB:    null,   // send path  (inputRate → 8 kHz)
    upsampleOSB:      null,   // receive path (8 kHz → inputRate)

    // 2.8 kHz send-path LPF — keeps the AI model in its trained voice-bandwidth
    // domain.  Coefficients and state are initialised lazily in rmNoise_process()
    // and reset on sample-rate change.
    lpfCoeffs:        null,   // Float32Array of FIR taps
    lpfState:         null,   // Float32Array delay line (length = taps - 1)
    lpfRate:          0,      // sample rate for which lpfCoeffs were designed
};

// Expose globally so app.js can call rmNoise_process()
window.rmNoiseBridge = rmNoise;

// ── Wire-protocol helpers ──────────────────────────────────────────────────────

/**
 * Pack a 20-byte header + int16 PCM frame.
 * Mirrors pack_frame() in rmnoise_denoise.py
 */
function rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale) {
    const headerBytes = 20;
    const pcmBytes    = pcm8k_i16.length * 2;
    const buf         = new ArrayBuffer(headerBytes + pcmBytes);
    const view        = new DataView(buf);

    view.setBigUint64(0,  BigInt(frameNum), true);   // uint64 LE
    view.setBigUint64(8,  BigInt(tsMs),     true);   // uint64 LE
    view.setUint32(16,    scale,            true);   // uint32 LE

    const pcmView = new Int16Array(buf, headerBytes);
    pcmView.set(pcm8k_i16);
    return buf;
}

/**
 * Unpack a server frame.
 * Mirrors unpack_frame() in rmnoise_denoise.py
 * Returns { frameNum (BigInt), tsMs (BigInt), scale (number), pcm (Int16Array) }
 */
function rmNoise_unpackFrame(data) {
    const view    = new DataView(data);
    const frameNum = view.getBigUint64(0,  true);
    const tsMs     = view.getBigUint64(8,  true);
    const scale    = view.getUint32(16,    true);
    const pcm      = new Int16Array(data, 20);
    return { frameNum, tsMs, scale, pcm };
}

// ── Audio processing ───────────────────────────────────────────────────────────

// ── Send-path LPF helpers ──────────────────────────────────────────────────────
//
// Design and apply a windowed-sinc FIR low-pass filter.  Logic mirrors
// NoiseBlanker.designFIRLowpass() and NoiseBlanker.applyAudioFilter() in
// noise-blanker.js, adapted as standalone functions so rmnoise.js has no
// dependency on the NoiseBlanker class.

/**
 * Design a windowed-sinc (Hamming) FIR low-pass filter.
 * @param {number} cutoffHz   -3 dB cutoff frequency in Hz
 * @param {number} sampleRate input sample rate in Hz
 * @returns {Float32Array}    FIR coefficients (odd length, normalised to unity DC gain)
 */
function rmNoise_designLPF(cutoffHz, sampleRate) {
    let numTaps = Math.min(Math.floor(sampleRate / 10), 1001);
    if (numTaps % 2 === 0) numTaps += 1;   // must be odd

    const coeffs = new Float32Array(numTaps);
    const fc     = cutoffHz / sampleRate;  // normalised cutoff
    const M      = (numTaps - 1) / 2;

    for (let n = 0; n < numTaps; n++) {
        const x = n - M;
        // Windowed sinc
        const h = (x === 0) ? 2 * fc
                             : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        // Hamming window
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (numTaps - 1));
        coeffs[n] = h * w;
    }

    // Normalise to unity DC gain
    let sum = 0;
    for (let i = 0; i < numTaps; i++) sum += coeffs[i];
    for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;

    return coeffs;
}

/**
 * Apply a stateful FIR filter in-place, preserving state across calls.
 * @param {Float32Array} input   samples to filter (read-only)
 * @param {Float32Array} coeffs  FIR coefficients
 * @param {Float32Array} state   delay line (length = coeffs.length - 1), mutated in place
 * @returns {Float32Array}       filtered copy of input
 */
function rmNoise_applyLPF(input, coeffs, state) {
    const numTaps    = coeffs.length;
    const numSamples = input.length;
    const output     = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
        // Shift delay line
        for (let j = numTaps - 2; j > 0; j--) {
            state[j] = state[j - 1];
        }
        state[0] = input[i];

        // Convolve
        let y = coeffs[0] * input[i];
        for (let j = 1; j < numTaps; j++) {
            y += coeffs[j] * state[j - 1];
        }
        output[i] = y;
    }
    return output;
}

/**
 * Process a mono Float32Array through the RMNoise bridge.
 * Mirrors RMNoiseBridge.process() in rmnoise_window.py
 *
 * @param {Float32Array} audioFloat  mono samples at inputRate
 * @param {number}       sampleRate  current server sample rate
 * @returns {Float32Array|null}  denoised samples at sampleRate, or null if not ready
 */
function rmNoise_process(audioFloat, sampleRate) {
    if (!rmNoise.ready || !rmNoise.dc || rmNoise.dc.readyState !== 'open') {
        return null;   // not connected — caller uses original audio
    }

    // Update rate if changed — flush all state so stale context doesn't bleed in
    if (rmNoise.inputRate !== sampleRate || !rmNoise.downsampleOSB) {
        rmNoise.inputRate   = sampleRate;
        rmNoise.accumIn     = new Float32Array(0);
        rmNoise.accumOut    = new Float32Array(0);
        rmNoise.primed      = false;
        const bufs = rmNoise_createOversizeBuffers(sampleRate);
        rmNoise.downsampleOSB = bufs.downsampleOSB;
        rmNoise.upsampleOSB   = bufs.upsampleOSB;
    }

    const nIn        = audioFloat.length;
    const accumTarget = Math.round(RM_FRAME * sampleRate / RM_RATE);

    // ── 2.8 kHz LPF — keep AI model in its trained voice-bandwidth domain ─────
    // The RMNoise AI is a voice denoiser trained on ~300–2800 Hz content.
    // Audio wider than ~2700 Hz causes the model to produce discontinuous output
    // frames (pops).  We apply a stateful windowed-sinc FIR LPF at 2800 Hz here,
    // before the send path, regardless of the UI bandwidth setting.
    //
    // The filter coefficients and state are initialised lazily and stored on the
    // rmNoise object so state is preserved across 240-sample chunk boundaries
    // (no edge artifacts).  The design mirrors NoiseBlanker.designFIRLowpass()
    // and NoiseBlanker.applyAudioFilter() in noise-blanker.js.
    if (!rmNoise.lpfCoeffs || rmNoise.lpfRate !== sampleRate) {
        rmNoise.lpfRate   = sampleRate;
        rmNoise.lpfCoeffs = rmNoise_designLPF(2800, sampleRate);
        rmNoise.lpfState  = new Float32Array(rmNoise.lpfCoeffs.length - 1);
    }
    const sendAudio = rmNoise_applyLPF(audioFloat, rmNoise.lpfCoeffs, rmNoise.lpfState);

    // ── Send path: accumulate → downsample → pack → send ──────────────────────
    const newAccumIn = new Float32Array(rmNoise.accumIn.length + nIn);
    newAccumIn.set(rmNoise.accumIn);
    newAccumIn.set(sendAudio, rmNoise.accumIn.length);
    rmNoise.accumIn = newAccumIn;

    while (rmNoise.accumIn.length >= accumTarget) {
        const chunk = rmNoise.accumIn.slice(0, accumTarget);
        rmNoise.accumIn = rmNoise.accumIn.slice(accumTarget);

        try {
            // Downsample to 8 kHz using Lanczos resampler + OversizeBuffer.
            // The OversizeBuffer pads the chunk with context from adjacent
            // frames so the Lanczos kernel has valid data at the edges.
            const oversizedChunk = rmNoise.downsampleOSB.addFrame(chunk);
            const oversizedDown  = lanczosResample(oversizedChunk, sampleRate, RM_RATE);
            const pcm8k_good     = rmNoise.downsampleOSB.goodFrame(oversizedDown);

            // Trim/pad to exactly RM_FRAME samples
            let frame8k;
            if (pcm8k_good.length >= RM_FRAME) {
                frame8k = pcm8k_good.slice(0, RM_FRAME);
            } else {
                frame8k = new Float32Array(RM_FRAME);
                frame8k.set(pcm8k_good);
            }

            // Compute audioScale and convert to int16
            let maxAbs = 0;
            for (let i = 0; i < frame8k.length; i++) {
                const a = Math.abs(frame8k[i]);
                if (a > maxAbs) maxAbs = a;
            }
            const scale = maxAbs > 1e-9 ? Math.min(Math.floor(32767.0 / maxAbs), 4294967295) : 1;

            const pcm8k_i16 = new Int16Array(RM_FRAME);
            for (let i = 0; i < RM_FRAME; i++) {
                pcm8k_i16[i] = Math.max(-32768, Math.min(32767, Math.round(frame8k[i] * scale)));
            }

            const tsMs    = BigInt(Date.now());
            const frameNum = rmNoise.frameNum;
            const packed  = rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale);

            rmNoise.sendTimes.set(frameNum, performance.now());
            if (rmNoise.sendTimes.size > 300) {
                // Evict oldest
                const oldest = rmNoise.sendTimes.keys().next().value;
                rmNoise.sendTimes.delete(oldest);
            }

            if (rmNoise.dc && rmNoise.dc.readyState === 'open') {
                rmNoise.dc.send(packed);
            }

            rmNoise.frameNum = frameNum + BigInt(1);
        } catch (e) {
            console.error('[RMNoise] Send error:', e);
        }
    }

    // ── Receive path: drain jitter buffer → accumOut ──────────────────────────
    while (rmNoise.jitterBuf.length > 0) {
        const frame  = rmNoise.jitterBuf.shift();
        const merged = new Float32Array(rmNoise.accumOut.length + frame.length);
        merged.set(rmNoise.accumOut);
        merged.set(frame, rmNoise.accumOut.length);
        rmNoise.accumOut = merged;
    }

    // Cap accumOut to prevent unbounded growth during network bursts.
    // If the backlog exceeds ~500 ms of 8 kHz audio (4000 samples), drop the
    // oldest samples so the output stays close to real-time.  Without this cap,
    // a burst of server frames fills accumOut far ahead of the playback cursor;
    // when the jitter buffer later hits its own limit and drops whole frames,
    // there is a hard discontinuity in accumOut that plays as a loud pop.
    //
    // When we trim, also reset the upsampleOSB context buffer.  It holds the
    // tail of the audio that is about to be discarded; if we leave it intact
    // the Lanczos kernel will bridge across the discontinuity and produce a
    // transient artifact on the very next upsample call.
    const accumOutMax = 4000;   // ~500 ms at 8 kHz
    if (rmNoise.accumOut.length > accumOutMax) {
        rmNoise.accumOut = rmNoise.accumOut.slice(rmNoise.accumOut.length - accumOutMax);
        if (rmNoise.upsampleOSB) rmNoise.upsampleOSB.reset();
    }

    // Wait until we have primeFrames worth of 8 kHz data buffered before
    // starting playback.  This absorbs the network round-trip so we never
    // starve the output.
    const primeThreshold = RM_FRAME * rmNoise.primeFrames;
    if (!rmNoise.primed) {
        if (rmNoise.accumOut.length >= primeThreshold) {
            rmNoise.primed = true;
            rmNoise_log(`Buffer primed (${rmNoise.accumOut.length} samples @ 8 kHz) — denoising active`);
        } else {
            // Still filling — return silence (like Python client) so the
            // caller doesn't fall back to original audio during priming.
            return new Float32Array(audioFloat.length);
        }
    }

    // How many 8 kHz samples do we need to cover nIn input samples?
    // Use ceil so we always have enough 8 kHz data to produce nIn output samples
    // after upsampling.  The OversizeBuffer trims edge samples, so we need a
    // slight surplus to ensure the "good" portion covers the full output.
    const n8kNeeded = Math.ceil(nIn * RM_RATE / sampleRate);

    if (rmNoise.accumOut.length >= n8kNeeded) {
        const chunk8k    = rmNoise.accumOut.slice(0, n8kNeeded);
        rmNoise.accumOut = rmNoise.accumOut.slice(n8kNeeded);

        // Upsample from 8 kHz → sampleRate using Lanczos + OversizeBuffer.
        // The OversizeBuffer provides context so edge artifacts are trimmed.
        const oversized8k  = rmNoise.upsampleOSB.addFrame(chunk8k);
        const oversizedUp  = lanczosResample(oversized8k, RM_RATE, sampleRate);
        const upsampled    = rmNoise.upsampleOSB.goodFrame(oversizedUp);

        // Trim or zero-pad to exactly nIn samples
        if (upsampled.length >= nIn) {
            return upsampled.slice(0, nIn);
        } else {
            const result = new Float32Array(nIn);
            result.set(upsampled);
            return result;
        }
    }

    // accumOut ran dry (network hiccup) — return silence to avoid a jarring
    // switch back to original audio.  Do NOT reset primed: the Python client
    // never re-primes after the initial prime, it just returns silence on
    // underrun and resumes denoised audio as soon as data is available again.
    return new Float32Array(audioFloat.length);
}

// ── Connection ─────────────────────────────────────────────────────────────────

async function rmNoise_connect(username, password, filterNumber) {
    if (rmNoise.connecting || rmNoise.ready) return;
    rmNoise.connecting = true;
    rmNoise.filterNumber = filterNumber || 1;

    rmNoise_setStatus('Connecting…', 'orange');
    rmNoise_log(`Connecting to RMNoise as '${username}' (filter ${rmNoise.filterNumber})…`);
    rmNoise_updateButton();

    try {
        // ── Single proxy call: login + webrtc_token + turn_creds in one request ─
        const credsText = await fetch('/api/rmnoise/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        }).then(r => r.text());

        let credsData;
        try { credsData = JSON.parse(credsText); } catch {
            throw new Error(`Proxy error: unexpected non-JSON response`);
        }
        if (!credsData.ok) throw new Error(credsData.error || 'Authentication failed');

        const webrtcToken = credsData.webrtc_token;
        const turnData    = credsData.turn_creds;

        if (!webrtcToken?.success || !webrtcToken?.token) {
            throw new Error('Failed to get WebRTC token from proxy response');
        }
        if (!turnData?.success) {
            throw new Error('Failed to get TURN credentials from proxy response');
        }

        rmNoise_log('Credentials received');

        const iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls:       turnData.uris || [],
                username:   turnData.username,
                credential: turnData.password,
            },
        ];

        // ── WebSocket signalling ───────────────────────────────────────────────
        await rmNoise_connectWS(webrtcToken.token, iceServers);

    } catch (e) {
        console.error('[RMNoise] Connection error:', e);
        rmNoise_log(`Connection failed: ${e.message}`);
        rmNoise_setStatus('Failed', 'red');
        rmNoise.connecting = false;
        rmNoise.enabled    = false;
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
    }
}

async function rmNoise_connectWS(token, iceServers) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RM_SERVER);
        rmNoise.ws = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
        };

        ws.onmessage = async (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }

            switch (msg.type) {
                case 'auth_ok':
                    rmNoise_log('WebSocket authenticated');
                    ws.send(JSON.stringify({
                        type: 'ai_filter_selection',
                        filterNumber: rmNoise.filterNumber,
                    }));
                    // Set up WebRTC
                    try {
                        await rmNoise_setupWebRTC(ws, iceServers);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                    break;

                case 'answer':
                    if (rmNoise.pc) {
                        const ad = msg.answer || msg;
                        await rmNoise.pc.setRemoteDescription(
                            new RTCSessionDescription({ type: 'answer', sdp: ad.sdp })
                        );
                        rmNoise_log('WebRTC answer received');
                    }
                    break;

                case 'ice-candidate':
                    if (rmNoise.pc && msg.candidate && msg.candidate.candidate) {
                        try {
                            await rmNoise.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch (e) {
                            console.warn('[RMNoise] ICE candidate error:', e);
                        }
                    }
                    break;

                case 'ai_filters_list':
                    rmNoise.availableFilters = msg.filters || [];
                    rmNoise_log(`Available AI filters: ${rmNoise.availableFilters.length}`);
                    rmNoise_populateFilterList();
                    break;

                case 'entered_standby':
                    rmNoise_log(`Server standby: ${msg.reason || ''}`);
                    break;

                case 'left_standby':
                    rmNoise_log('Server left standby');
                    break;

                default:
                    break;
            }
        };

        ws.onerror = (e) => {
            reject(new Error('WebSocket error'));
        };

        ws.onclose = () => {
            if (rmNoise.ready) {
                rmNoise_log('WebSocket closed');
                rmNoise_handleDisconnect();
            }
        };
    });
}

async function rmNoise_setupWebRTC(ws, iceServers) {
    rmNoise_log('Setting up WebRTC…');

    const pc = new RTCPeerConnection({ iceServers });
    rmNoise.pc = pc;

    const dc = pc.createDataChannel('audio', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';   // must be set before onmessage fires
    rmNoise.dc = dc;

    dc.onopen = () => {
        rmNoise_log('Data channel opened – denoising active');
        rmNoise.ready      = true;
        rmNoise.connecting = false;
        rmNoise_setStatus('Connected ✓', 'green');
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_startStatsInterval();
    };

    dc.onclose = () => {
        if (rmNoise.ready) {
            rmNoise_log('Data channel closed');
            rmNoise_handleDisconnect();
        }
    };

    dc.onerror = (e) => {
        console.error('[RMNoise] DataChannel error:', e);
    };

    dc.onmessage = (ev) => {
        // Discard frames that arrived within 300 ms of a sample-rate change.
        // They were sent at the old rate and will corrupt the new pipeline.
        if (rmNoise.rateChangedAt && performance.now() - rmNoise.rateChangedAt < 300) {
            return;
        }
        try {
            const { frameNum, scale, pcm } = rmNoise_unpackFrame(ev.data);

            // Undo audioScale normalisation → float32 in [-1, 1]
            const s = scale > 0 ? scale : 32767;
            const pcm8k_f32 = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) {
                pcm8k_f32[i] = pcm[i] / s;
            }

            // Measure latency
            if (rmNoise.sendTimes.has(frameNum)) {
                const lat = performance.now() - rmNoise.sendTimes.get(frameNum);
                rmNoise.sendTimes.delete(frameNum);
                rmNoise.lastLatencyMs = lat;
            }

            // Push to jitter buffer (drop oldest if full)
            if (rmNoise.jitterBuf.length >= rmNoise.jitterMax) {
                rmNoise.jitterBuf.shift();
            }
            rmNoise.jitterBuf.push(pcm8k_f32);

        } catch (e) {
            console.error('[RMNoise] Server audio error:', e);
        }
    };

    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: {
                    candidate:     ev.candidate.candidate,
                    sdpMid:        ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                },
            }));
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
        type:  'offer',
        offer: { type: 'offer', sdp: pc.localDescription.sdp },
    }));
    rmNoise_log('WebRTC offer sent');
}

function rmNoise_handleDisconnect() {
    rmNoise.ready      = false;
    rmNoise.connecting = false;
    if (rmNoise.enabled) {
        rmNoise_setStatus('Disconnected', 'grey');
    }
    rmNoise_clearStatusLabel();
    rmNoise_updateButton();
    rmNoise_syncCheckbox();
    rmNoise_stopStatsInterval();
}

async function rmNoise_disconnect() {
    rmNoise_log('Stopping RMNoise bridge…');
    rmNoise_stopStatsInterval();

    if (rmNoise.dc) {
        try { rmNoise.dc.close(); } catch {}
        rmNoise.dc = null;
    }
    if (rmNoise.pc) {
        try { rmNoise.pc.close(); } catch {}
        rmNoise.pc = null;
    }
    if (rmNoise.ws) {
        try { rmNoise.ws.close(); } catch {}
        rmNoise.ws = null;
    }

    rmNoise.ready      = false;
    rmNoise.connecting = false;
    rmNoise.primed     = false;
    rmNoise.accumIn    = new Float32Array(0);
    rmNoise.accumOut   = new Float32Array(0);
    rmNoise.jitterBuf  = [];
    rmNoise.sendTimes.clear();
    rmNoise.frameNum   = BigInt(0);
    rmNoise.downsampleOSB = null;
    rmNoise.upsampleOSB   = null;
}

// ── Toggle functions ───────────────────────────────────────────────────────────

async function toggleRMNoise() {
    if (rmNoise.enabled) {
        // Disable
        rmNoise.enabled = false;
        rmNoise.bypass  = false;
        await rmNoise_disconnect();
        rmNoise_setStatus('Disconnected', 'grey');
        rmNoise_clearStatusLabel();
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_log('RMNoise denoising disabled');
    } else {
        // Enable
        const username = localStorage.getItem('rmnoise_username') || '';
        const password = localStorage.getItem('rmnoise_password') || '';
        if (!username || !password) {
            openRMNoiseModal();
            return;
        }
        rmNoise.enabled = true;
        rmNoise_syncCheckbox();
        await rmNoise_connect(username, password, rmNoise.filterNumber);
    }
}

function toggleRMNoiseQuick() {
    const hasCreds = localStorage.getItem('rmnoise_username') &&
                     localStorage.getItem('rmnoise_password');
    if (!hasCreds) {
        openRMNoiseModal();
        return;
    }
    toggleRMNoise();
}

function toggleRMNoiseBypass() {
    rmNoise.bypass = !rmNoise.bypass;
    const btn = document.getElementById('rmnoise-original-btn');
    if (btn) {
        btn.textContent  = rmNoise.bypass ? '● Original' : 'Original';
        btn.style.color  = rmNoise.bypass ? '#ff6b6b' : '';
    }
}

function rmNoise_clearStatusLabel() {
    const jEl = document.getElementById('rmnoise-jitter');
    const lEl = document.getElementById('rmnoise-latency');
    if (jEl) jEl.textContent = '-- frames';
    if (lEl) lEl.textContent = '-- ms';
    const fillEl = document.getElementById('rmnoise-jitter-fill');
    if (fillEl) fillEl.style.width = '0%';
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function rmNoise_startStatsInterval() {
    rmNoise_stopStatsInterval();
    rmNoise.statsInterval = setInterval(rmNoise_updateStats, 500);
}

function rmNoise_stopStatsInterval() {
    if (rmNoise.statsInterval) {
        clearInterval(rmNoise.statsInterval);
        rmNoise.statsInterval = null;
    }
}

function rmNoise_updateStats() {
    if (!rmNoise.ready) return;

    const jitter  = rmNoise.jitterBuf.length;
    const latency = rmNoise.lastLatencyMs;

    // Update modal stats
    const jEl = document.getElementById('rmnoise-jitter');
    const lEl = document.getElementById('rmnoise-latency');
    if (jEl) jEl.textContent = `${jitter} frames`;
    if (lEl) lEl.textContent = `${latency.toFixed(0)} ms`;

    // Jitter bar (max 20 frames = full)
    const ratio    = Math.min(jitter / 20, 1.0);
    const fillEl   = document.getElementById('rmnoise-jitter-fill');
    if (fillEl) {
        fillEl.style.width = `${Math.round(ratio * 100)}%`;
        fillEl.style.backgroundColor =
            jitter <= 6  ? '#28a745' :
            jitter <= 12 ? '#ffc107' : '#dc3545';
    }

}

// ── Filter list ────────────────────────────────────────────────────────────────

function rmNoise_populateFilterList() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel || rmNoise.availableFilters.length === 0) return;

    sel.innerHTML = '';
    const savedFilter = rmNoise.filterNumber;

    for (const f of rmNoise.availableFilters) {
        const opt = document.createElement('option');
        opt.value       = f.filterNumber;
        opt.textContent = f.filterDesc || `Filter ${f.filterNumber}`;
        if (f.filterNumber === savedFilter) opt.selected = true;
        sel.appendChild(opt);
    }
}

function rmNoise_onFilterChanged() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel) return;
    const newFilter = parseInt(sel.value, 10);
    if (isNaN(newFilter)) return;

    rmNoise.filterNumber = newFilter;
    localStorage.setItem('rmnoise_filter', newFilter);

    // Send to server if connected
    if (rmNoise.ws && rmNoise.ws.readyState === WebSocket.OPEN) {
        rmNoise.ws.send(JSON.stringify({
            type:         'ai_filter_selection',
            filterNumber: newFilter,
        }));
        rmNoise_log(`Filter changed to: ${sel.options[sel.selectedIndex]?.textContent}`);
    }
}

// ── Credentials ────────────────────────────────────────────────────────────────

function rmNoise_saveCredentials() {
    const username = (document.getElementById('rmnoise-username')?.value || '').trim();
    const password = (document.getElementById('rmnoise-password')?.value || '').trim();

    if (!username || !password) {
        alert('Username and password are required');
        return;
    }

    localStorage.setItem('rmnoise_username', username);
    localStorage.setItem('rmnoise_password', password);
    localStorage.setItem('rmnoise_filter',   rmNoise.filterNumber);
    localStorage.setItem('rmnoise_mix',      Math.round(rmNoise.mixRatio * 100));
    rmNoise_log('Credentials saved');
}

function rmNoise_loadCredentials() {
    const username = localStorage.getItem('rmnoise_username') || '';
    const password = localStorage.getItem('rmnoise_password') || '';
    const filter   = parseInt(localStorage.getItem('rmnoise_filter') || '1', 10);
    const mix      = parseInt(localStorage.getItem('rmnoise_mix')    || '100', 10);

    const uEl = document.getElementById('rmnoise-username');
    const pEl = document.getElementById('rmnoise-password');
    if (uEl) uEl.value = username;
    if (pEl) pEl.value = password;

    rmNoise.filterNumber = isNaN(filter) ? 1 : filter;
    rmNoise.mixRatio     = isNaN(mix)    ? 1.0 : mix / 100;

    const sel    = document.getElementById('rmnoise-filter-select');
    if (sel) sel.value = rmNoise.filterNumber;

    const mixSlider = document.getElementById('rmnoise-mix-slider');
    const mixLabel  = document.getElementById('rmnoise-mix-value');
    const mixPct    = Math.round(rmNoise.mixRatio * 100);
    if (mixSlider) mixSlider.value = mixPct;
    if (mixLabel)  mixLabel.textContent = mixPct + '% Filtered';
}

// ── Mix slider ─────────────────────────────────────────────────────────────────

function rmNoise_onMixChanged(value) {
    const pct = parseInt(value, 10);
    rmNoise.mixRatio = pct / 100;
    localStorage.setItem('rmnoise_mix', pct);
    const el = document.getElementById('rmnoise-mix-value');
    if (el) el.textContent = pct + '% Filtered';
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function rmNoise_setStatus(text, colour) {
    const el = document.getElementById('rmnoise-status-text');
    if (!el) return;
    el.textContent  = text;
    el.style.color  =
        colour === 'green'  ? '#28a745' :
        colour === 'orange' ? '#fd7e14' :
        colour === 'red'    ? '#dc3545' : '#888';
}

function rmNoise_updateButton() {
    const btn = document.getElementById('rmn-quick-toggle');
    const cog = document.getElementById('rmn-cog-btn');
    if (!btn) return;

    let colour;
    if (rmNoise.connecting) {
        colour = '#fd7e14';  // orange
    } else if (rmNoise.ready && rmNoise.enabled) {
        colour = '#28a745';  // green
    } else if (!rmNoise.enabled) {
        colour = '#6c757d';  // grey (idle/disabled)
    } else {
        colour = '#dc3545';  // red (failed)
    }

    btn.style.backgroundColor = colour;
    if (cog) cog.style.backgroundColor = colour;

    // Original button
    const origBtn = document.getElementById('rmnoise-original-btn');
    if (origBtn) {
        origBtn.disabled = !(rmNoise.ready && rmNoise.enabled);
    }
}

function rmNoise_syncCheckbox() {
    const cb = document.getElementById('rmnoise-enable-checkbox');
    if (cb) cb.checked = rmNoise.enabled;
}

function rmNoise_log(message) {
    const ts  = new Date().toTimeString().slice(0, 8);
    const div = document.getElementById('rmnoise-log');
    if (!div) return;
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${message}`;
    div.appendChild(line);
    div.scrollTop = div.scrollHeight;
}

// ── Modal ──────────────────────────────────────────────────────────────────────

function openRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (!modal) return;
    rmNoise_loadCredentials();
    modal.style.display = 'flex';
}

function closeRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) modal.style.display = 'none';
}

// Close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeRMNoiseModal();
        });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeRMNoiseModal();
    });

    // RMN button: left-click toggles (or opens modal if no creds)
    const rmnBtn = document.getElementById('rmn-quick-toggle');
    if (rmnBtn) {
        rmnBtn.addEventListener('click', (e) => {
            const hasCreds = localStorage.getItem('rmnoise_username') &&
                             localStorage.getItem('rmnoise_password');
            if (!hasCreds) {
                openRMNoiseModal();
            } else {
                toggleRMNoise();
            }
        });

    }

    // Load saved credentials into modal fields
    rmNoise_loadCredentials();

    // Initialise button state
    rmNoise_updateButton();

    // Apply mode gating for the initial mode.
    // Deferred so app.js has time to set window.currentMode from URL params.
    setTimeout(() => {
        const initialMode = window.currentMode || 'usb';
        if (window.rmNoise_updateModeSupport) {
            window.rmNoise_updateModeSupport(initialMode);
        }
    }, 0);
});

// ── Mode support gating ────────────────────────────────────────────────────────
//
// RMNoise only makes sense for SSB/CW modes (USB, LSB, CWU, CWL).
// For AM, FM, NFM, SAM, WFM etc. the denoiser produces garbage because the
// audio bandwidth and spectral character are completely different.
//
// Called by app.js setMode() on every mode change and on initial page load.
//
const RM_SUPPORTED_MODES = new Set(['usb', 'lsb', 'cwu', 'cwl']);

function rmNoise_isModeSupported(mode) {
    return RM_SUPPORTED_MODES.has((mode || '').toLowerCase());
}

/**
 * Update RMNoise UI and connection state for the given mode.
 * - Supported modes  (USB/LSB/CWU/CWL): enable button + checkbox
 * - Unsupported modes (AM/FM/NFM/…):    disable button + checkbox, disconnect if active
 */
async function rmNoise_updateModeSupport(mode) {
    const supported = rmNoise_isModeSupported(mode);

    const btn     = document.getElementById('rmn-quick-toggle');
    const cogBtn  = document.getElementById('rmn-cog-btn');
    const cb      = document.getElementById('rmnoise-enable-checkbox');

    if (supported) {
        // Re-enable controls
        if (btn) {
            btn.disabled = false;
            btn.title    = 'Toggle RM Noise AI Denoising';
            btn.style.opacity = '';
            btn.style.cursor  = '';
        }
        if (cogBtn) {
            cogBtn.disabled = false;
            cogBtn.style.opacity = '';
            cogBtn.style.cursor  = '';
        }
        if (cb) {
            cb.disabled = false;
        }
    } else {
        // Disable controls
        if (btn) {
            btn.disabled = true;
            btn.title    = 'RMNoise is only available in USB / LSB / CWU / CWL modes';
            btn.style.opacity = '0.4';
            btn.style.cursor  = 'not-allowed';
        }
        if (cogBtn) {
            cogBtn.disabled = true;
            cogBtn.style.opacity = '0.4';
            cogBtn.style.cursor  = 'not-allowed';
        }
        if (cb) {
            cb.disabled = true;
        }

        // Disconnect if currently active
        if (rmNoise.enabled || rmNoise.ready || rmNoise.connecting) {
            rmNoise_log(`Mode changed to ${mode.toUpperCase()} — RMNoise disabled (unsupported mode)`);
            rmNoise.enabled = false;
            await rmNoise_disconnect();
            rmNoise_setStatus('Disabled (unsupported mode)', 'grey');
            rmNoise_updateButton();
            rmNoise_syncCheckbox();
        }
    }
}

// ── Sample-rate change flush ───────────────────────────────────────────────────
//
// Called by app.js from both the Opus and PCM AudioContext-recreation blocks
// whenever the server sample rate changes (e.g. switching from LSB/USB to AM/FM).
// Must be called BEFORE rmNoise_process() receives the first frame at the new rate.
//
function rmNoise_onSampleRateChange(newRate) {
    if (!window.rmNoiseBridge || !window.rmNoiseBridge.enabled) return;
    rmNoise_log(`Sample rate changed to ${newRate} Hz — flushing pipeline`);

    rmNoise.inputRate     = newRate;
    rmNoise.accumIn       = new Float32Array(0);
    rmNoise.accumOut      = new Float32Array(0);
    rmNoise.jitterBuf     = [];           // critical: discard stale 8 kHz frames
    rmNoise.primed        = false;
    rmNoise.frameNum      = BigInt(0);
    rmNoise.sendTimes.clear();
    rmNoise.rateChangedAt = performance.now(); // arms the 300 ms in-flight discard window
    rmNoise.downsampleOSB = null;
    rmNoise.upsampleOSB   = null;
    // Force LPF redesign at the new rate (lpfCoeffs check in rmNoise_process
    // uses lpfRate !== sampleRate to detect this).
    rmNoise.lpfCoeffs     = null;
    rmNoise.lpfState      = null;
    rmNoise.lpfRate       = 0;
}

// ── Expose globals for app.js ──────────────────────────────────────────────────
window.toggleRMNoise        = toggleRMNoise;
window.toggleRMNoiseQuick   = toggleRMNoiseQuick;
window.toggleRMNoiseBypass  = toggleRMNoiseBypass;
window.openRMNoiseModal     = openRMNoiseModal;
window.closeRMNoiseModal    = closeRMNoiseModal;
window.rmNoise_saveCredentials      = rmNoise_saveCredentials;
window.rmNoise_onFilterChanged      = rmNoise_onFilterChanged;
window.rmNoise_onMixChanged         = rmNoise_onMixChanged;
window.rmNoise_process              = rmNoise_process;
window.rmNoise_onSampleRateChange   = rmNoise_onSampleRateChange;
window.rmNoise_updateModeSupport    = rmNoise_updateModeSupport;
window.rmNoise_isModeSupported      = rmNoise_isModeSupported;