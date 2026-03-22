// FreeDV Decoder Extension for ka9q UberSDR
// Decodes FreeDV/RADE digital voice signals via the freedv-ka9q backend process.
// Receives Opus-encoded decoded audio over the DX WebSocket binary channel and
// plays it through the Web Audio API, muting the main SDR audio while active.

class FreeDVExtension extends DecoderExtension {
    constructor() {
        console.log('FreeDV: Constructor called');
        super('freedv', {
            displayName: 'FreeDV Decoder',
            autoTune: false,
            requiresMode: null  // Mode validation is done on the backend
        });

        // Runtime state
        this.isRunning = false;
        this.frameCount = 0;
        this.hasSignal = false;

        // Signal-loss watchdog: if no Opus frames arrive for this many ms, clear the
        // signal badge. 1000 ms gives one full second of silence before declaring loss.
        this.signalTimeoutMs = 1000;
        this.signalTimeoutId = null;

        // Frequency-change debounce: restart the decoder 500 ms after the last
        // frequency change so the backend gets the updated tuned_frequency_hz.
        this.freqRestartDebounceMs = 500;
        this.freqRestartTimeoutId = null;

        // Waterfall
        this.waterfallCanvas = null;
        this.waterfallCtx = null;
        this.waterfallAnalyser = null;
        this.waterfallGain = null;       // silent sink so analysis audio isn't heard twice
        this.waterfallRafId = null;      // requestAnimationFrame handle
        this.waterfallImageData = null;  // reused ImageData for pixel-shift scrolling

        // Mute tracking — we mute the main SDR audio while the decoder is active
        this.sdrWasMuted = false;

        // Opus decoder instance (one per session, recreated on start)
        this.opusDecoder = null;
        this.opusDecoderReady = false;
        this.opusDecoderFailed = false;

        // Binary WebSocket handler references
        this.originalDXHandler = null;
        this.binaryMessageHandler = null;

        // DOM handler setup guard
        this.handlersSetup = false;

        console.log('FreeDV: Extension initialized');
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onInitialize() {
        console.log('FreeDV: onInitialize called');
        this.waitForDOMAndSetupHandlers();
    }

    waitForDOMAndSetupHandlers() {
        const maxAttempts = 20;
        const trySetup = (attempts = 0) => {
            const startBtn = document.getElementById('freedv-start-button');
            const stopBtn  = document.getElementById('freedv-stop-button');

            console.log(`FreeDV: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                startBtn: !!startBtn,
                stopBtn:  !!stopBtn
            });

            if (startBtn && stopBtn) {
                this.setupEventHandlers();
                this.updateButtonStates();
                this.updateModeDisplay();
                console.log('FreeDV: DOM ready, handlers set up');
            } else if (attempts < maxAttempts) {
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('FreeDV: DOM elements not found after max attempts');
            }
        };
        trySetup();
    }

    // ── Waterfall ─────────────────────────────────────────────────────────────

    initWaterfall() {
        const canvas = document.getElementById('freedv-waterfall');
        if (!canvas) return;

        const audioCtx = window.audioContext || (this.radio && this.radio.getAudioContext && this.radio.getAudioContext());
        if (!audioCtx) return;

        // Size the canvas backing store to match its CSS display size
        const wrap = canvas.parentElement;
        const w = wrap ? wrap.clientWidth || 400 : 400;
        const h = 300;
        canvas.width  = w;
        canvas.height = h;

        this.waterfallCanvas = canvas;
        this.waterfallCtx    = canvas.getContext('2d');

        // AnalyserNode — 2048-point FFT gives good frequency resolution at 12 kHz
        this.waterfallAnalyser = audioCtx.createAnalyser();
        this.waterfallAnalyser.fftSize = 2048;
        this.waterfallAnalyser.smoothingTimeConstant = 0.0; // no smoothing — waterfall does its own

        // Silent sink: connect analyser → gain(0) → destination so the audio
        // routed through the analyser is analysed but not heard a second time.
        this.waterfallGain = audioCtx.createGain();
        this.waterfallGain.gain.value = 0;
        this.waterfallAnalyser.connect(this.waterfallGain);
        this.waterfallGain.connect(audioCtx.destination);

        // Pre-allocate the ImageData used for pixel-shift scrolling
        this.waterfallImageData = this.waterfallCtx.createImageData(w, h);

        // Fill with black initially
        this.waterfallCtx.fillStyle = '#000';
        this.waterfallCtx.fillRect(0, 0, w, h);

        // Start the render loop
        this._waterfallDraw();
    }

    _waterfallDraw() {
        if (!this.waterfallCanvas || !this.waterfallCtx || !this.waterfallAnalyser) return;

        const canvas   = this.waterfallCanvas;
        const ctx      = this.waterfallCtx;
        const analyser = this.waterfallAnalyser;
        const w = canvas.width;
        const h = canvas.height;
        const binCount = analyser.frequencyBinCount; // fftSize / 2 = 1024

        const freqData = new Uint8Array(binCount);

        const draw = () => {
            this.waterfallRafId = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(freqData);

            // Shift the existing image down by 1 pixel
            const imgData = ctx.getImageData(0, 0, w, h);
            const src = imgData.data;
            // Copy rows [0 .. h-2] → [1 .. h-1] (move everything down one row)
            src.copyWithin(w * 4, 0, (h - 1) * w * 4);

            // Paint the new top row from FFT data
            // Map bin indices to canvas pixels (linear interpolation across width)
            for (let x = 0; x < w; x++) {
                const binIdx = Math.floor(x * binCount / w);
                const magnitude = freqData[binIdx]; // 0–255

                // Colour map: black → dark blue → cyan → yellow → white
                let r, g, b;
                if (magnitude < 64) {
                    // black → dark blue
                    r = 0;
                    g = 0;
                    b = Math.round(magnitude * 2);
                } else if (magnitude < 128) {
                    // dark blue → cyan
                    const t = (magnitude - 64) / 64;
                    r = 0;
                    g = Math.round(t * 255);
                    b = Math.round(128 + t * 127);
                } else if (magnitude < 192) {
                    // cyan → yellow
                    const t = (magnitude - 128) / 64;
                    r = Math.round(t * 255);
                    g = 255;
                    b = Math.round(255 * (1 - t));
                } else {
                    // yellow → white
                    const t = (magnitude - 192) / 63;
                    r = 255;
                    g = 255;
                    b = Math.round(t * 255);
                }

                const offset = x * 4; // top row starts at byte 0
                src[offset]     = r;
                src[offset + 1] = g;
                src[offset + 2] = b;
                src[offset + 3] = 255;
            }

            ctx.putImageData(imgData, 0, 0);
        };

        draw();
    }

    stopWaterfall() {
        if (this.waterfallRafId !== null) {
            cancelAnimationFrame(this.waterfallRafId);
            this.waterfallRafId = null;
        }
        // Disconnect the analyser from the audio graph
        if (this.waterfallAnalyser) {
            try { this.waterfallAnalyser.disconnect(); } catch (e) { /* ignore */ }
            this.waterfallAnalyser = null;
        }
        if (this.waterfallGain) {
            try { this.waterfallGain.disconnect(); } catch (e) { /* ignore */ }
            this.waterfallGain = null;
        }
        this.waterfallCanvas = null;
        this.waterfallCtx    = null;
        this.waterfallImageData = null;
    }

    // Route a decoded AudioBuffer through the waterfall analyser (in addition to
    // the normal playback path). Called from decodeAndPlayOpus() after the buffer
    // is created.
    _feedWaterfall(audioBuffer, audioCtx) {
        if (!this.waterfallAnalyser) return;
        try {
            const src = audioCtx.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(this.waterfallAnalyser);
            src.start();
            // No need to stop — it ends naturally when the buffer finishes
        } catch (e) {
            // Non-fatal — waterfall just won't update for this frame
        }
    }

    setupEventHandlers() {
        if (this.handlersSetup) return;
        this.handlersSetup = true;

        const startBtn = document.getElementById('freedv-start-button');
        const stopBtn  = document.getElementById('freedv-stop-button');

        if (startBtn) {
            startBtn.addEventListener('click', () => this.startDecoder());
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopDecoder());
        }
    }

    onEnable() {
        console.log('FreeDV: Extension enabled');
        this.setupBinaryMessageHandler();
        // Initialise waterfall now that the DOM template is in the panel
        this.initWaterfall();
    }

    onDisable() {
        console.log('FreeDV: Extension disabled');
        if (this.isRunning) {
            this.stopDecoder();
        }
        this.removeBinaryMessageHandler();
        this.stopWaterfall();
    }

    onProcessAudio(dataArray) {
        // FreeDV processes audio on the backend via the audio extension framework.
        // This method is required by DecoderExtension but does nothing here.
    }

    // ── Start / Stop ─────────────────────────────────────────────────────────

    startDecoder() {
        console.log('FreeDV: Starting decoder');

        this.isRunning = true;
        this.frameCount = 0;
        this.hasSignal = false;
        this.opusDecoderFailed = false;

        this.updateButtonStates();
        this.updateStatus('Starting…', 'running');
        this.updateSignalBadge(false);
        this.updateFrameCount(0);
        this.hideError();

        // Mute the main SDR audio
        this.muteSdr();

        // Attach to the backend audio extension
        this.attachAudioExtension();
    }

    stopDecoder() {
        console.log('FreeDV: Stopping decoder');

        this.isRunning = false;
        this.hasSignal = false;
        this.clearSignalTimeout();
        this.clearFreqRestartTimeout();

        this.updateButtonStates();
        this.updateStatus('Stopped', '');
        this.updateSignalBadge(false);
        this.updateAudioStatus('—');

        // Restore SDR mute state
        this.unmuteSdr();

        // Tear down Opus decoder
        this.destroyOpusDecoder();

        // Detach from the backend audio extension
        this.detachAudioExtension();
    }

    // ── Audio extension attach / detach ──────────────────────────────────────

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('FreeDV: DX WebSocket not connected');
            this.handleError('No WebSocket connection');
            return;
        }

        // Install binary message handler before attaching so we don't miss the
        // first frame.
        this.setupBinaryMessageHandler();

        const message = {
            type: 'audio_extension_attach',
            extension_name: 'freedv',
            params: {}
        };

        console.log('FreeDV: Sending attach message');
        dxClient.ws.send(JSON.stringify(message));

        this.updateStatus('Running', 'running');
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            // WebSocket gone — just clean up locally
            this.removeBinaryMessageHandler();
            return;
        }

        // Remove binary handler before detaching
        this.removeBinaryMessageHandler();

        const message = { type: 'audio_extension_detach' };
        console.log('FreeDV: Sending detach message');
        dxClient.ws.send(JSON.stringify(message));
    }

    // ── Binary WebSocket message interception ────────────────────────────────

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('FreeDV: DX WebSocket not available');
            return;
        }

        // Store the original handler only once
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('FreeDV: Stored original DX handler');
        }

        this.binaryMessageHandler = (event) => {
            if (event.data instanceof ArrayBuffer) {
                if (this.isRunning) {
                    this.handleBinaryMessage(event.data);
                }
                // Do NOT forward binary frames to the original handler
            } else if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buf => {
                    if (this.isRunning) {
                        this.handleBinaryMessage(buf);
                    }
                }).catch(err => {
                    console.error('FreeDV: Blob→ArrayBuffer conversion failed:', err);
                });
            } else {
                // Text message — try to parse as JSON for our own messages,
                // otherwise pass through to the original handler.
                try {
                    const msg = JSON.parse(event.data);
                    this.handleTextMessage(msg);
                } catch (e) {
                    if (this.originalDXHandler && this.originalDXHandler !== this.binaryMessageHandler) {
                        this.originalDXHandler.call(dxClient.ws, event);
                    }
                }
            }
        };

        dxClient.ws.onmessage = this.binaryMessageHandler;
        console.log('FreeDV: Binary message handler installed');
    }

    removeBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            return;
        }

        if (this.originalDXHandler) {
            dxClient.ws.onmessage = this.originalDXHandler;
            this.originalDXHandler = null;
            console.log('FreeDV: Original message handler restored');
        }

        this.binaryMessageHandler = null;
    }

    // ── Message handlers ─────────────────────────────────────────────────────

    handleTextMessage(message) {
        if (message.type === 'audio_extension_error') {
            console.error('FreeDV: Server error:', message.error);
            this.handleError(message.error || 'Unknown server error');
        } else if (message.type === 'audio_extension_attached') {
            console.log('FreeDV: Successfully attached to server');
            this.updateStatus('Running', 'running');
        } else {
            // Not for us — pass to original handler if available
            const dxClient = window.dxClusterClient;
            if (this.originalDXHandler && dxClient && dxClient.ws) {
                // Re-wrap as a synthetic MessageEvent so the original handler
                // receives the raw string.
                const syntheticEvent = { data: JSON.stringify(message) };
                try {
                    this.originalDXHandler.call(dxClient.ws, syntheticEvent);
                } catch (e) {
                    // Ignore forwarding errors
                }
            }
        }
    }

    handleBinaryMessage(data) {
        // Binary protocol (backend → frontend):
        //   Byte 0      : message type  (0x02 = Opus frame)
        //   Bytes 1–8   : timestamp nanoseconds (int64 big-endian)
        //   Bytes 9–12  : sample rate Hz (uint32 big-endian)
        //   Byte 13     : channels (uint8)
        //   Bytes 14…   : Opus packet data

        if (data.byteLength < 14) {
            console.warn('FreeDV: Binary message too short:', data.byteLength);
            return;
        }

        const view = new DataView(data);
        const messageType = view.getUint8(0);

        if (messageType !== 0x02) {
            console.warn(`FreeDV: Unknown message type 0x${messageType.toString(16).padStart(2, '0')}`);
            return;
        }

        // Parse header
        // Bytes 1–8: timestamp (BigInt, big-endian) — not used for playback scheduling
        const sampleRate = view.getUint32(9, false);  // big-endian
        const channels   = view.getUint8(13);
        const opusData   = new Uint8Array(data, 14);

        if (opusData.length === 0) {
            return;
        }

        // Signal detected — backend only sends frames when FreeDV has decoded audio.
        // Arm (or re-arm) the signal-loss watchdog on every frame.
        if (!this.hasSignal) {
            this.hasSignal = true;
            this.updateSignalBadge(true);
            this.updateAudioStatus('Decoding');
        }
        this.startSignalTimeout();

        this.frameCount++;
        this.updateFrameCount(this.frameCount);

        // Decode and play the Opus frame asynchronously
        this.decodeAndPlayOpus(opusData, sampleRate, channels);
    }

    // ── Opus decoding ────────────────────────────────────────────────────────

    async initOpusDecoder(sampleRate, channels) {
        if (this.opusDecoderFailed) return false;
        if (this.opusDecoder && this.opusDecoderReady) return true;

        // Locate the OpusDecoder class (same logic as app.js)
        let OpusDecoderClass = null;
        if (typeof OpusDecoder !== 'undefined') {
            OpusDecoderClass = OpusDecoder;
        } else if (window['opus-decoder'] && window['opus-decoder'].OpusDecoder) {
            OpusDecoderClass = window['opus-decoder'].OpusDecoder;
        }

        if (!OpusDecoderClass) {
            console.error('FreeDV: OpusDecoder library not loaded');
            return false;
        }

        try {
            console.log(`FreeDV: Initialising Opus decoder — ${sampleRate} Hz, ${channels} ch`);
            this.opusDecoder = new OpusDecoderClass({
                sampleRate: sampleRate,
                channels:   channels
            });
            await this.opusDecoder.ready;
            this.opusDecoderReady = true;
            console.log('FreeDV: Opus decoder ready');
            return true;
        } catch (e) {
            console.error('FreeDV: Opus decoder init failed:', e);
            this.opusDecoderFailed = true;
            this.updateAudioStatus('Decode error');
            return false;
        }
    }

    async decodeAndPlayOpus(opusData, sampleRate, channels) {
        // Initialise decoder lazily on first frame
        const ready = await this.initOpusDecoder(sampleRate, channels);
        if (!ready) return;

        try {
            const result = await this.opusDecoder.decode(opusData);
            // result.channelData is Float32Array[]  (one per channel)
            // result.sampleRate is the output sample rate

            if (!result || !result.channelData || result.channelData.length === 0) {
                return;
            }

            const audioCtx = window.audioContext || this.radio.getAudioContext();
            if (!audioCtx) {
                console.warn('FreeDV: No AudioContext available');
                return;
            }

            const numChannels = result.channelData.length;
            const numSamples  = result.channelData[0].length;
            const outSampleRate = result.sampleRate || sampleRate;

            if (numSamples === 0) return;

            // Build an AudioBuffer and hand it to the global playAudioBuffer()
            // helper so it is scheduled correctly in the existing jitter buffer.
            const audioBuffer = audioCtx.createBuffer(numChannels, numSamples, outSampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                audioBuffer.copyToChannel(result.channelData[ch], ch);
            }

            // Feed the waterfall analyser (silent duplicate — doesn't affect playback)
            this._feedWaterfall(audioBuffer, audioCtx);

            if (typeof window.playAudioBuffer === 'function') {
                window.playAudioBuffer(audioBuffer);
            } else {
                // Fallback: play immediately without jitter buffer
                const source = audioCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioCtx.destination);
                source.start();
            }
        } catch (e) {
            console.error('FreeDV: Opus decode error:', e);
            this.updateAudioStatus('Decode error');
        }
    }

    destroyOpusDecoder() {
        if (this.opusDecoder) {
            try {
                if (typeof this.opusDecoder.free === 'function') {
                    this.opusDecoder.free();
                }
            } catch (e) {
                // Ignore cleanup errors
            }
            this.opusDecoder = null;
        }
        this.opusDecoderReady = false;
        this.opusDecoderFailed = false;
    }

    // ── SDR mute helpers ─────────────────────────────────────────────────────

    muteSdr() {
        // Use RadioAPI.setMuted() which handles the toggle correctly
        const isMuted = this.radio.getMuted();
        this.sdrWasMuted = isMuted;
        console.log(`FreeDV: SDR mute state before start: ${isMuted ? 'muted' : 'unmuted'}`);

        if (!isMuted) {
            this.radio.setMuted(true);
            console.log('FreeDV: Muted SDR audio');
        }
    }

    unmuteSdr() {
        console.log(`FreeDV: Restoring SDR mute state (was muted before: ${this.sdrWasMuted})`);
        // Only unmute if we were the ones who muted it
        if (!this.sdrWasMuted) {
            const isMuted = this.radio.getMuted();
            if (isMuted) {
                this.radio.setMuted(false);
                console.log('FreeDV: Unmuted SDR audio');
            }
        }
    }

    // ── Error handling ───────────────────────────────────────────────────────

    handleError(message) {
        console.error('FreeDV: Error —', message);

        this.isRunning = false;
        this.hasSignal = false;
        this.clearSignalTimeout();
        this.clearFreqRestartTimeout();
        this.updateButtonStates();
        this.updateStatus('Error', 'error');
        this.updateSignalBadge(false);
        this.showError(message);

        // Restore SDR mute state on error
        this.unmuteSdr();

        // Tear down Opus decoder
        this.destroyOpusDecoder();
    }

    showError(message) {
        const errorEl = document.getElementById('freedv-error');
        const errorText = document.getElementById('freedv-error-text');
        if (errorEl && errorText) {
            errorText.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    hideError() {
        const errorEl = document.getElementById('freedv-error');
        if (errorEl) {
            errorEl.style.display = 'none';
        }
    }

    // ── Signal-loss watchdog ─────────────────────────────────────────────────

    startSignalTimeout() {
        // Cancel any existing timer and start a fresh one.
        // Called on every incoming Opus frame so the timer is always rolling.
        if (this.signalTimeoutId !== null) {
            clearTimeout(this.signalTimeoutId);
        }
        this.signalTimeoutId = setTimeout(() => {
            this.signalTimeoutId = null;
            if (this.hasSignal) {
                console.log('FreeDV: No frames for 1 s — signal lost');
                this.hasSignal = false;
                this.updateSignalBadge(false);
                this.updateAudioStatus('—');
            }
        }, this.signalTimeoutMs);
    }

    clearSignalTimeout() {
        if (this.signalTimeoutId !== null) {
            clearTimeout(this.signalTimeoutId);
            this.signalTimeoutId = null;
        }
    }

    // ── UI update helpers ────────────────────────────────────────────────────

    updateButtonStates() {
        const startBtn = document.getElementById('freedv-start-button');
        const stopBtn  = document.getElementById('freedv-stop-button');

        if (startBtn) startBtn.disabled = this.isRunning;
        if (stopBtn)  stopBtn.disabled  = !this.isRunning;
    }

    updateStatus(text, cssClass) {
        const dot  = document.getElementById('freedv-status-dot');
        const span = document.getElementById('freedv-status-text');

        if (dot) {
            dot.className = 'freedv-status-dot' + (cssClass ? ' ' + cssClass : '');
        }
        if (span) {
            span.textContent = text;
            span.className   = 'freedv-status-text' + (cssClass ? ' ' + cssClass : '');
        }
    }

    updateSignalBadge(hasSignal) {
        const badge = document.getElementById('freedv-signal-badge');
        if (!badge) return;

        if (hasSignal) {
            badge.textContent = '● Signal';
            badge.className   = 'freedv-signal-badge signal';
        } else {
            badge.textContent = 'No Signal';
            badge.className   = 'freedv-signal-badge';
        }
    }

    updateFrameCount(count) {
        const el = document.getElementById('freedv-frame-count');
        if (el) el.textContent = count.toString();
    }

    updateAudioStatus(text) {
        const el = document.getElementById('freedv-audio-status');
        if (el) el.textContent = text;
    }

    updateModeDisplay() {
        const mode = this.radio.getMode();
        const el   = document.getElementById('freedv-mode-display');
        if (el) el.textContent = mode ? mode.toUpperCase() : '—';
    }

    // ── Frequency/mode change debounce helpers ───────────────────────────────

    clearFreqRestartTimeout() {
        if (this.freqRestartTimeoutId !== null) {
            clearTimeout(this.freqRestartTimeoutId);
            this.freqRestartTimeoutId = null;
        }
    }

    // Immediately detach from the backend and schedule a re-attach after the
    // debounce window. Called by both onFrequencyChanged and onModeChanged.
    _scheduleRestart(reason) {
        if (!this.isRunning) return;

        console.log(`FreeDV: ${reason} — stopping immediately, restart in ${this.freqRestartDebounceMs} ms`);

        // Cancel any previously scheduled restart
        this.clearFreqRestartTimeout();

        // Stop the backend immediately so it doesn't keep processing stale audio
        this.detachAudioExtension();
        this.updateStatus('Retuning…', 'running');

        // Schedule re-attach after the debounce window
        this.freqRestartTimeoutId = setTimeout(() => {
            this.freqRestartTimeoutId = null;
            if (!this.isRunning) return; // user may have pressed Stop during the window
            console.log(`FreeDV: Restarting decoder after ${reason}`);
            this.attachAudioExtension();
        }, this.freqRestartDebounceMs);
    }

    // ── Radio event overrides ────────────────────────────────────────────────

    onFrequencyChanged(frequency) {
        this._scheduleRestart(`frequency change to ${frequency} Hz`);
    }

    onModeChanged(mode) {
        this.updateModeDisplay();
        this._scheduleRestart(`mode change to ${mode}`);
    }
}

// ── Register the extension ───────────────────────────────────────────────────

(function () {
    if (!window.decoderManager) {
        console.error('FreeDV: decoderManager not available — extension not registered');
        return;
    }

    const ext = new FreeDVExtension();
    window.decoderManager.register(ext);
    console.log('✅ FreeDV extension registered');
})();
