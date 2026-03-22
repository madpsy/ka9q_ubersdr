// FreeDV Decoder Extension for ka9q UberSDR
// vim: set ts=4 sw=4:
// Decodes FreeDV/RADE digital voice signals via the freedv-ka9q backend process.
// Receives Opus-encoded decoded audio over the DX WebSocket binary channel and
// plays it through the Web Audio API, muting the main SDR audio while active.
//
// Also shows a live FreeDV Reporter activity table (view-only, band-filtered)
// sourced from the server's FreeDV Reporter monitor via the DX cluster WebSocket.

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

        // Binary WebSocket handler references
        this.originalDXHandler = null;
        this.binaryMessageHandler = null;

        // DOM handler setup guard
        this.handlersSetup = false;

        // ── Activity view ────────────────────────────────────────────────────
        // 'activity' (default) or 'waterfall'
        this.currentView = 'activity';

        // Map of sid → user object (from FreeDV Reporter)
        this.activityUsers = new Map();

        // Whether we are currently subscribed to the freedv_activity stream
        this.activitySubscribed = false;

        // Render throttle: schedule at most one render per animation frame
        this._renderPending = false;

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

            // Only update the waterfall while the decoder is actively running.
            // When stopped the canvas freezes in place rather than scrolling black.
            if (!this.isRunning) return;

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

    // ── View toggle ───────────────────────────────────────────────────────────

    /**
     * Switch between 'activity' and 'waterfall' views.
     * @param {string} view - 'activity' or 'waterfall'
     */
    setView(view) {
        this.currentView = view;

        const waterfallPanel = document.getElementById('freedv-waterfall-panel');
        const activityPanel  = document.getElementById('freedv-activity-panel');
        const toggleBtn      = document.getElementById('freedv-view-toggle');

        if (view === 'waterfall') {
            if (waterfallPanel) waterfallPanel.style.display = '';
            if (activityPanel)  activityPanel.style.display  = 'none';
            if (toggleBtn)      toggleBtn.textContent = '📋 Activity';

            // Subscribe to activity is not needed in waterfall view — unsubscribe
            // to save bandwidth if we were subscribed.
            this._unsubscribeActivity();

            // Initialise waterfall if not already running
            if (!this.waterfallCanvas) {
                this.initWaterfall();
            }
        } else {
            // activity view
            if (waterfallPanel) waterfallPanel.style.display = 'none';
            if (activityPanel)  activityPanel.style.display  = '';
            if (toggleBtn)      toggleBtn.textContent = '〰 Waterfall';

            // Subscribe to the activity stream
            this._subscribeActivity();

            // Update the band label and schedule a render
            this._updateActivityBandLabel();
            this._scheduleRender();
        }
    }

    // ── FreeDV Reporter activity subscription ─────────────────────────────────

    _subscribeActivity() {
        if (this.activitySubscribed) return;

        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            this._setActivityStatus('Not connected to server');
            return;
        }

        dxClient.ws.send(JSON.stringify({ type: 'subscribe_freedv_activity' }));
        this.activitySubscribed = true;
        this._setActivityStatus('Connecting…');
        console.log('FreeDV: Subscribed to FreeDV activity stream');
    }

    _unsubscribeActivity() {
        if (!this.activitySubscribed) return;

        const dxClient = window.dxClusterClient;
        if (dxClient && dxClient.ws && dxClient.ws.readyState === WebSocket.OPEN) {
            dxClient.ws.send(JSON.stringify({ type: 'unsubscribe_freedv_activity' }));
        }
        this.activitySubscribed = false;
        console.log('FreeDV: Unsubscribed from FreeDV activity stream');
    }

    // ── Activity message handlers ─────────────────────────────────────────────

    _handleActivitySnapshot(users) {
        this.activityUsers.clear();
        for (const u of users) {
            if (u.sid) this.activityUsers.set(u.sid, u);
        }
        this._setActivityStatus('');
        this._scheduleRender();
    }

    _handleActivityUpdate(event, user, sid) {
        switch (event) {
            case 'new_connection':
                if (user && user.sid) this.activityUsers.set(user.sid, user);
                break;
            case 'remove_connection':
                this.activityUsers.delete(sid || (user && user.sid));
                break;
            case 'freq_change':
            case 'tx_report':
            case 'rx_report':
            case 'message_update':
                if (user && user.sid) {
                    // Merge update into existing record (server sends full user object)
                    this.activityUsers.set(user.sid, user);
                }
                break;
            case 'disconnected':
                // Server lost connection to FreeDV Reporter — clear stale data
                this.activityUsers.clear();
                this._setActivityStatus('FreeDV Reporter disconnected — reconnecting…');
                break;
        }
        this._scheduleRender();
    }

    /**
     * Schedule a render on the next animation frame.
     * Multiple calls within the same frame are coalesced into one render.
     */
    _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            this._renderActivityTable();
        });
    }

    // ── Band filtering ────────────────────────────────────────────────────────

    /**
     * Returns the {min, max} Hz range for the band the radio is currently tuned to,
     * or null if the current frequency doesn't fall in any known band.
     */
    _currentBandRange() {
        const bandRanges = window.bandRanges;
        if (!bandRanges) return null;

        const freqHz = this.radio ? this.radio.getFrequency() : 0;
        if (!freqHz) return null;

        for (const [, range] of Object.entries(bandRanges)) {
            if (freqHz >= range.min && freqHz <= range.max) {
                return range;
            }
        }
        return null;
    }

    /**
     * Returns the name of the band the radio is currently tuned to, or null.
     */
    _currentBandName() {
        const bandRanges = window.bandRanges;
        if (!bandRanges) return null;

        const freqHz = this.radio ? this.radio.getFrequency() : 0;
        if (!freqHz) return null;

        for (const [name, range] of Object.entries(bandRanges)) {
            if (freqHz >= range.min && freqHz <= range.max) {
                return name;
            }
        }
        return null;
    }

    /**
     * Filter the activity map to users on the current band.
     * If the current frequency is not in any known band, returns all users.
     */
    _filteredUsers() {
        const range = this._currentBandRange();
        if (!range) {
            // Not in a known band — show all
            return Array.from(this.activityUsers.values());
        }
        return Array.from(this.activityUsers.values()).filter(u => {
            const f = u.freq_hz || 0;
            return f >= range.min && f <= range.max;
        });
    }

    // ── Activity table rendering ──────────────────────────────────────────────

    _updateActivityBandLabel() {
        const el = document.getElementById('freedv-activity-band');
        if (!el) return;
        const band = this._currentBandName();
        el.textContent = band ? band : 'all bands';
    }

    _setActivityStatus(msg) {
        const el = document.getElementById('freedv-activity-status');
        if (!el) return;
        el.textContent = msg;
        el.style.display = msg ? '' : 'none';
    }

    _renderActivityTable() {
        if (this.currentView !== 'activity') return;

        const tbody   = document.getElementById('freedv-activity-tbody');
        const emptyEl = document.getElementById('freedv-activity-empty');
        const countEl = document.getElementById('freedv-activity-count');
        if (!tbody) return;

        const users = this._filteredUsers();

        // Sort: transmitting first, then by callsign
        users.sort((a, b) => {
            if (a.transmitting && !b.transmitting) return -1;
            if (!a.transmitting && b.transmitting) return 1;
            return (a.callsign || '').localeCompare(b.callsign || '');
        });

        // Update count
        if (countEl) {
            countEl.textContent = `${users.length} station${users.length !== 1 ? 's' : ''}`;
        }

        if (users.length === 0) {
            // Remove all data rows, show empty placeholder
            Array.from(tbody.querySelectorAll('tr[data-sid]')).forEach(r => r.remove());
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        // ── Diff-based update — update rows in-place to avoid flicker ────────
        // Rows are keyed by data-sid attribute so we can find and update them
        // without destroying and recreating DOM nodes (which resets :hover state
        // and restarts CSS animations like the TX badge pulse).

        const existingSids = new Set(
            Array.from(tbody.querySelectorAll('tr[data-sid]')).map(r => r.dataset.sid)
        );
        const wantedSids = new Set(users.map(u => u.sid));

        // Remove rows that are no longer in the filtered list
        for (const sid of existingSids) {
            if (!wantedSids.has(sid)) {
                const row = tbody.querySelector(`tr[data-sid="${CSS.escape(sid)}"]`);
                if (row) row.remove();
            }
        }

        // Insert or update rows in sorted order
        // We walk the desired order and use insertBefore to reorder without
        // removing nodes (preserves hover/animation state for unchanged rows).
        let refNode = emptyEl ? emptyEl.nextSibling : null;

        for (const u of users) {
            let tr = tbody.querySelector(`tr[data-sid="${CSS.escape(u.sid)}"]`);

            if (!tr) {
                // ── Create new row ────────────────────────────────────────────
                tr = document.createElement('tr');
                tr.dataset.sid = u.sid;

                // Callsign cell
                const tdCall = document.createElement('td');
                tdCall.className = 'freedv-activity-callsign';
                tr.appendChild(tdCall);

                // Grid cell
                tr.appendChild(document.createElement('td'));

                // Frequency cell
                const tdFreq = document.createElement('td');
                tdFreq.className = 'freedv-activity-freq';
                tr.appendChild(tdFreq);

                // Mode cell
                tr.appendChild(document.createElement('td'));

                // TX cell
                const tdTx = document.createElement('td');
                tdTx.className = 'freedv-activity-tx-cell';
                tr.appendChild(tdTx);

                // Last RX cell
                const tdRx = document.createElement('td');
                tdRx.className = 'freedv-activity-rx-cell';
                tr.appendChild(tdRx);

                // Click-to-tune handler (bound once at creation)
                tr.addEventListener('click', () => {
                    const freq = parseFloat(tr.dataset.freq);
                    if (!freq || freq <= 0 || freq > 30e6) {
                        console.warn(`FreeDV: Ignoring out-of-range frequency ${freq} Hz`);
                        return;
                    }
                    if (this.radio && this.radio.setFrequency) {
                        if (window.spectrumDisplay) {
                            window.spectrumDisplay.skipEdgeDetectionTemporary = true;
                        }
                        this.radio.setFrequency(freq);
                        setTimeout(() => {
                            if (window.spectrumDisplay) {
                                window.spectrumDisplay.skipEdgeDetectionTemporary = false;
                            }
                        }, 500);
                        console.log(`FreeDV: Tuned to ${tr.dataset.callsign} @ ${this._formatFreq(freq)}`);
                    }
                });
            }

            // ── Update row data attributes (used by click handler) ────────────
            tr.dataset.freq     = u.freq_hz || 0;
            tr.dataset.callsign = u.callsign || '';

            // ── Update row classes ────────────────────────────────────────────
            tr.classList.toggle('freedv-activity-tx',      !!u.transmitting);
            tr.classList.toggle('freedv-activity-tunable', !!(u.freq_hz && u.freq_hz > 0 && u.freq_hz <= 30e6));
            tr.title = (u.freq_hz && u.freq_hz > 0 && u.freq_hz <= 30e6)
                ? `Click to tune to ${this._formatFreq(u.freq_hz)}`
                : '';

            // ── Update cell contents ──────────────────────────────────────────
            const cells = tr.children;

            // [0] Callsign
            const tdCall = cells[0];
            tdCall.textContent = u.callsign || '—';
            if (u.rx_only) {
                let badge = tdCall.querySelector('.freedv-activity-rxonly');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'freedv-activity-rxonly';
                    badge.textContent = 'RX';
                    tdCall.appendChild(badge);
                }
            } else {
                const badge = tdCall.querySelector('.freedv-activity-rxonly');
                if (badge) badge.remove();
            }

            // [1] Grid
            cells[1].textContent = u.grid_square || '—';

            // [2] Frequency
            cells[2].textContent = u.freq_hz ? this._formatFreq(u.freq_hz) : '—';

            // [3] Message (truncated to 28 chars + ellipsis = 29 total; full text in tooltip)
            const msg = u.message || '';
            cells[3].textContent = msg.length > 28 ? msg.slice(0, 28) + '…' : (msg || '—');
            cells[3].title = msg.length > 28 ? msg : '';

            // [4] TX badge — only recreate the badge span if TX state changed
            const tdTx = cells[4];
            const hasBadge = !!tdTx.querySelector('.freedv-activity-tx-badge');
            if (u.transmitting && !hasBadge) {
                tdTx.innerHTML = '<span class="freedv-activity-tx-badge">TX</span>';
            } else if (!u.transmitting && hasBadge) {
                tdTx.textContent = '—';
            } else if (!u.transmitting && !hasBadge && tdTx.textContent !== '—') {
                tdTx.textContent = '—';
            }

            // [5] Last RX
            const tdRx = cells[5];
            if (u.last_rx_callsign) {
                const snr = typeof u.last_rx_snr === 'number' ? ` ${u.last_rx_snr.toFixed(0)} dB` : '';
                const text = u.last_rx_callsign + snr;
                if (tdRx.textContent !== text) tdRx.textContent = text;
            } else if (tdRx.textContent !== '—') {
                tdRx.textContent = '—';
            }

            // ── Reorder: insert at correct sorted position ────────────────────
            // Only move the node if it's not already in the right place.
            // Unnecessary insertBefore calls cause browsers to remove+reinsert
            // the node, which resets :hover state and CSS animations.
            if (tr.nextSibling !== refNode) {
                tbody.insertBefore(tr, refNode);
            }
            refNode = tr.nextSibling;
        }
    }

    /** Format Hz as MHz with 3 decimal places, e.g. 14236000 → "14.236 MHz" */
    _formatFreq(hz) {
        return (hz / 1e6).toFixed(3) + ' MHz';
    }

    // ── Event handlers setup ──────────────────────────────────────────────────

    setupEventHandlers() {
        if (this.handlersSetup) return;
        this.handlersSetup = true;

        const startBtn  = document.getElementById('freedv-start-button');
        const stopBtn   = document.getElementById('freedv-stop-button');
        const toggleBtn = document.getElementById('freedv-view-toggle');

        if (startBtn) {
            startBtn.addEventListener('click', () => this.startDecoder());
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopDecoder());
        }
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.setView(this.currentView === 'activity' ? 'waterfall' : 'activity');
            });
        }
    }

    onEnable() {
        console.log('FreeDV: Extension enabled');
        this.setupBinaryMessageHandler();

        // Default to activity view — subscribe immediately
        this.setView('activity');
    }

    onDisable() {
        console.log('FreeDV: Extension disabled');
        if (this.isRunning) {
            this.stopDecoder();
        }
        this.removeBinaryMessageHandler();
        this.stopWaterfall();
        this._unsubscribeActivity();
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
        // ── FreeDV Reporter activity messages ────────────────────────────────
        if (message.type === 'freedv_activity_snapshot') {
            this._handleActivitySnapshot(message.users || []);
            return;
        }

        if (message.type === 'freedv_activity_update') {
            this._handleActivityUpdate(message.event, message.user || null, message.sid || null);
            return;
        }

        if (message.type === 'subscription_status' && message.stream === 'freedv_activity') {
            if (!message.enabled) {
                // Server rejected or disabled the subscription
                this._setActivityStatus(message.error || 'FreeDV Reporter not available on this server');
            } else {
                this._setActivityStatus('');
            }
            return;
        }

        // ── Audio extension messages ─────────────────────────────────────────
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

        // Decode and play the Opus frame
        this.decodeAndPlayOpus(opusData, sampleRate, channels);
    }

    // ── Opus decode & playback ────────────────────────────────────────────────

    async decodeAndPlayOpus(opusData, sampleRate, channels) {
        const audioCtx = window.audioContext ||
            (this.radio && this.radio.getAudioContext && this.radio.getAudioContext());
        if (!audioCtx) {
            console.warn('FreeDV: No AudioContext available');
            return;
        }

        // The backend sends raw Opus packets (not wrapped in an Ogg container).
        // Use the shared WASM-based OpusDecoder from app.js which handles raw
        // Opus packets directly. Do NOT use decodeAudioData() — it requires a
        // complete Ogg/Opus file and will throw "unknown content type" on bare packets.
        // app.js is a module so decodeOpusPacket is exposed via window.decodeOpusPacket.
        if (typeof window.decodeOpusPacket !== 'function') {
            console.warn('FreeDV: window.decodeOpusPacket not available (app.js not yet loaded?)');
            return;
        }

        const decoded = await window.decodeOpusPacket(opusData, sampleRate, channels || 1);
        if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
            if (this.hasSignal) {
                console.debug('FreeDV: Opus decode returned null/empty');
            }
            return;
        }

        const numChannels = decoded.channelData.length;
        const numSamples  = decoded.channelData[0].length;
        const outRate     = decoded.sampleRate || sampleRate;

        const audioBuffer = audioCtx.createBuffer(numChannels, numSamples, outRate);
        for (let ch = 0; ch < numChannels; ch++) {
            audioBuffer.copyToChannel(decoded.channelData[ch], ch);
        }

        // Feed the waterfall analyser (non-audible copy)
        if (this.currentView === 'waterfall') {
            this._feedWaterfall(audioBuffer, audioCtx);
        }

        // Play the decoded audio
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.start();
    }

    // ── SDR mute helpers ──────────────────────────────────────────────────────

    muteSdr() {
        if (!this.radio) return;
        try {
            // Check current mute state so we can restore it on stop
            this.sdrWasMuted = this.radio.isMuted ? this.radio.isMuted() : false;
            if (!this.sdrWasMuted) {
                if (this.radio.setMuted) {
                    this.radio.setMuted(true);
                } else if (this.radio.mute) {
                    this.radio.mute();
                }
            }
        } catch (e) {
            console.warn('FreeDV: Could not mute SDR audio:', e);
        }
    }

    unmuteSdr() {
        if (!this.radio) return;
        try {
            if (!this.sdrWasMuted) {
                if (this.radio.setMuted) {
                    this.radio.setMuted(false);
                } else if (this.radio.unmute) {
                    this.radio.unmute();
                }
            }
        } catch (e) {
            console.warn('FreeDV: Could not unmute SDR audio:', e);
        }
    }

    // ── Signal-loss watchdog ──────────────────────────────────────────────────

    startSignalTimeout() {
        this.clearSignalTimeout();
        this.signalTimeoutId = setTimeout(() => {
            this.hasSignal = false;
            this.updateSignalBadge(false);
            this.updateAudioStatus('Waiting…');
        }, this.signalTimeoutMs);
    }

    clearSignalTimeout() {
        if (this.signalTimeoutId !== null) {
            clearTimeout(this.signalTimeoutId);
            this.signalTimeoutId = null;
        }
    }

    // ── Frequency-change debounce ─────────────────────────────────────────────

    clearFreqRestartTimeout() {
        if (this.freqRestartTimeoutId !== null) {
            clearTimeout(this.freqRestartTimeoutId);
            this.freqRestartTimeoutId = null;
        }
    }

    // ── Error handling ────────────────────────────────────────────────────────

    handleError(message) {
        this.isRunning = false;
        this.hasSignal = false;
        this.clearSignalTimeout();
        this.clearFreqRestartTimeout();

        this.unmuteSdr();
        this.updateButtonStates();
        this.updateStatus('Error', 'error');
        this.updateSignalBadge(false);
        this.showError(message);
    }

    // ── UI update helpers ─────────────────────────────────────────────────────

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
            span.className = 'freedv-status-text' + (cssClass ? ' ' + cssClass : '');
            span.textContent = text;
        }
    }

    updateSignalBadge(hasSignal) {
        const badge = document.getElementById('freedv-signal-badge');
        if (!badge) return;
        if (hasSignal) {
            badge.textContent = '● Signal';
            badge.className = 'freedv-signal-badge signal';
        } else {
            badge.textContent = 'No Signal';
            badge.className = 'freedv-signal-badge';
        }
    }

    updateFrameCount(count) {
        const el = document.getElementById('freedv-frame-count');
        if (el) el.textContent = count;
    }

    updateAudioStatus(text) {
        const el = document.getElementById('freedv-audio-status');
        if (el) el.textContent = text;
    }

    updateModeDisplay() {
        const el = document.getElementById('freedv-mode-display');
        if (!el) return;
        const mode = this.radio ? this.radio.getMode() : null;
        el.textContent = mode ? mode.toUpperCase() : '—';
    }

    showError(message) {
        const container = document.getElementById('freedv-error');
        const text      = document.getElementById('freedv-error-text');
        if (container) container.style.display = '';
        if (text)      text.textContent = message;
    }

    hideError() {
        const container = document.getElementById('freedv-error');
        if (container) container.style.display = 'none';
    }

    // ── Radio event overrides ─────────────────────────────────────────────────

    onFrequencyChanged(freqHz) {
        // Re-filter and re-render the activity table when the band changes
        if (this.currentView === 'activity') {
            this._updateActivityBandLabel();
            this._scheduleRender();
        }

        // Debounce decoder restart so rapid VFO changes don't spam the backend
        if (!this.isRunning) return;
        this.clearFreqRestartTimeout();
        this.freqRestartTimeoutId = setTimeout(() => {
            console.log('FreeDV: Frequency changed — restarting decoder');
            this.detachAudioExtension();
            this.attachAudioExtension();
        }, this.freqRestartDebounceMs);
    }

    onModeChanged(mode) {
        this.updateModeDisplay();
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

let freedvExtensionInstance = null;

if (window.decoderManager) {
    freedvExtensionInstance = new FreeDVExtension();
    window.decoderManager.register(freedvExtensionInstance);
    console.log('FreeDV extension registered:', freedvExtensionInstance);
} else {
    console.error('decoderManager not available for FreeDV extension');
}
