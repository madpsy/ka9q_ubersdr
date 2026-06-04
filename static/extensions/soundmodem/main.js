// Sound Modem Extension — AX.25 packet radio decoder
// Decodes packet radio frames via KISS TNC and displays them.
//
// Binary wire protocol (backend → frontend):
//
//   0x20  AX.25 packet frame
//         [type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
//
//   0x21  Error event (subprocess crash or binary not found)
//         [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
//
//   0x23  DCD state change
//         [type:1=0x23][channel:1][dcd_on:1]
//
//   0x24  Monitor text (decoded frame as human-readable string from AGW)
//         [type:1=0x24][channel:1][is_tx:1][text_len:4 uint32 BE][text: UTF-8]

class SoundModemExtension extends DecoderExtension {
    constructor() {
        super('soundmodem', {
            displayName: 'Sound Modem',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: 3000
        });

        this.running       = false;
        this.frameCount    = 0;
        this.filter        = 'all';
        this.channelFilter = 'all';
        this.copyBuffer    = [];
        this.maxFrames     = 25;     // mirrors the max-frames select (0 = unlimited)

        this._origHandler = null;
        this._ourHandler  = null;
        this._handlersSet = false;

        // Waterfall — draws FFT data from the page's existing AnalyserNode via radio.getAnalyser()
        this._wfCtx          = null;   // 2D context for scrolling waterfall canvas
        this._wfHdrCtx       = null;   // 2D context for frequency scale header canvas
        this._wfOvlCtx       = null;   // 2D context for channel-line overlay canvas
        this._wfFftBuf       = null;   // Uint8Array for getByteFrequencyData()
        this._wfRunning      = false;
        this._wfSampleRate   = 48000;  // updated from analyser.context.sampleRate on first audio frame
        this._wfMaxFreq      = 3300;   // Hz shown on waterfall (0–3300 Hz audio range)
        this._wfChannelFreqs = [];     // [{freq, enabled, modem}] snapshot from config at start time
        this._wfLineMs       = 50;     // ms between waterfall lines (20 lines/sec = steady scroll speed)
        this._wfLastLineAt   = 0;      // performance.now() timestamp of last rendered line

        // Monitor panel
        this._monitorLines = 0;
        this._monitorMax   = 300;
        this._monitorOpen  = false;

        // Process log panel (QtSoundModem stderr)
        this._logLines = 0;
        this._logMax   = 500;
        this._logOpen  = false;

        // Settings panel — shown by default when stopped
        this._settingsOpen = true;

        // DCD state per channel + auto-clear timers
        this._dcdState  = [false, false, false, false];
        this._dcdTimers = [null,  null,  null,  null];  // setTimeout handles for auto-clear
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onInitialize() {
        this._renderTemplate();
        this._waitForDOM(() => this._setupHandlers());
    }

    onActivate() {
        this._handlersSet = false;
        this._waitForDOM(() => this._setupHandlers());
    }

    onDeactivate() {
        if (this.running) this._stopDecoder();
        this._stopWaterfall();
    }

    onDisable() {
        if (this.running) this._stopDecoder();
        this._stopWaterfall();
        this._restoreBinaryHandler();
    }

    // ── Template ─────────────────────────────────────────────────────────────

    _renderTemplate() {
        const tpl = window.soundmodem_template;
        if (!tpl) { console.error('[SoundModem] template not loaded'); return; }
        const el = document.querySelector('.extension-content[data-extension="soundmodem"]');
        if (el) {
            el.innerHTML = tpl;
            this._handlersSet = false;
        }
        // Inject keyframes into <head> once so the start-button pulse animation
        // works even when set via inline style (inline styles can reference
        // @keyframes from any stylesheet in the document).
        if (!document.getElementById('sm-keyframes')) {
            const style = document.createElement('style');
            style.id = 'sm-keyframes';
            style.textContent = `
                @keyframes sm-start-pulse {
                    0%, 100% { box-shadow: 0 0 0 0 rgba(76,175,80,0.6); }
                    50%       { box-shadow: 0 0 0 8px rgba(76,175,80,0); }
                }
            `;
            document.head.appendChild(style);
        }
    }

    _waitForDOM(cb, attempts = 0) {
        if (document.getElementById('sm-start-btn')) {
            cb();
        } else if (attempts < 20) {
            setTimeout(() => this._waitForDOM(cb, attempts + 1), 100);
        } else {
            console.error('[SoundModem] DOM elements not found after 2 s');
        }
    }

    // ── localStorage persistence ──────────────────────────────────────────────
    // Bump _CONFIG_VERSION whenever the default channel settings change so that
    // stale saved configs are discarded and the new HTML defaults take effect.
    static get _CONFIG_VERSION() { return 2; }

    _saveConfig() {
        try {
            const cfg = { _v: SoundModemExtension._CONFIG_VERSION, channels: [], dcd_threshold: null };
            for (let i = 0; i < 4; i++) {
                cfg.channels.push({
                    enabled:    document.getElementById(`sm-ch${i}-enabled`)?.checked ?? false,
                    modem:      document.getElementById(`sm-ch${i}-modem`)?.value      ?? '1',
                    freq:       document.getElementById(`sm-ch${i}-freq`)?.value       ?? '1700',
                    rcvr_pairs: document.getElementById(`sm-ch${i}-rcvr`)?.value       ?? '0',
                    fx25:       document.getElementById(`sm-ch${i}-fx25`)?.value       ?? '1',
                    il2p:       document.getElementById(`sm-ch${i}-il2p`)?.value       ?? '0',
                });
            }
            cfg.dcd_threshold = document.getElementById('sm-dcd-threshold')?.value ?? '20';
            localStorage.setItem('sm_config', JSON.stringify(cfg));
        } catch (_) { /* storage unavailable */ }
    }

    _loadConfig() {
        try {
            const raw = localStorage.getItem('sm_config');
            if (!raw) return;
            const cfg = JSON.parse(raw);
            if (!cfg || !Array.isArray(cfg.channels)) return;
            // If the config was saved by an older version, discard it so the
            // new HTML defaults (channel A/B enabled with 300bd IL2P+CRC) apply.
            if ((cfg._v ?? 1) < SoundModemExtension._CONFIG_VERSION) {
                localStorage.removeItem('sm_config');
                return;
            }

            cfg.channels.forEach((ch, i) => {
                if (i >= 4) return;
                const cbEl    = document.getElementById(`sm-ch${i}-enabled`);
                const modemEl = document.getElementById(`sm-ch${i}-modem`);
                const freqEl  = document.getElementById(`sm-ch${i}-freq`);
                const rcvrEl  = document.getElementById(`sm-ch${i}-rcvr`);
                const fx25El  = document.getElementById(`sm-ch${i}-fx25`);
                const il2pEl  = document.getElementById(`sm-ch${i}-il2p`);

                if (cbEl    && ch.enabled    !== undefined) cbEl.checked  = !!ch.enabled;
                if (modemEl && ch.modem      !== undefined) modemEl.value = String(ch.modem);
                if (freqEl  && ch.freq       !== undefined) freqEl.value  = String(ch.freq);
                if (rcvrEl  && ch.rcvr_pairs !== undefined) rcvrEl.value  = String(ch.rcvr_pairs);
                if (fx25El  && ch.fx25       !== undefined) fx25El.value  = String(ch.fx25);
                if (il2pEl  && ch.il2p       !== undefined) il2pEl.value  = String(ch.il2p);

                // Sync the enabled/disabled visual state of the params block
                this._updateChannelState(i);
            });

            const dcdEl = document.getElementById('sm-dcd-threshold');
            if (dcdEl && cfg.dcd_threshold !== undefined) dcdEl.value = String(cfg.dcd_threshold);
        } catch (_) { /* corrupt storage — ignore */ }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _setupHandlers() {
        if (this._handlersSet) return;
        this._handlersSet = true;

        // Frequency preset dropdown — tunes the radio like FT8 extension does
        const freqPreset = document.getElementById('sm-freq-preset');
        if (freqPreset) {
            let lastPresetVal = '';
            freqPreset.addEventListener('change', (e) => {
                if (e.target.value) {
                    const [freq, mode] = e.target.value.split(',');
                    this._tuneToFrequency(parseInt(freq, 10), mode);
                    lastPresetVal = e.target.value;
                }
            });
            freqPreset.addEventListener('click', (e) => {
                if (e.target.value && e.target.value === lastPresetVal) {
                    const [freq, mode] = e.target.value.split(',');
                    this._tuneToFrequency(parseInt(freq, 10), mode);
                }
            });
        }

        const startBtn  = document.getElementById('sm-start-btn');
        const clearBtn  = document.getElementById('sm-clear-btn');
        const copyBtn   = document.getElementById('sm-copy-btn');
        const filterSel = document.getElementById('sm-filter-select');

        const settingsToggle = document.getElementById('sm-settings-toggle');
        if (settingsToggle) settingsToggle.addEventListener('click', () => this._toggleSettings());

        if (startBtn)  startBtn.addEventListener('click',  () => this._toggleDecoder());
        if (clearBtn)  clearBtn.addEventListener('click',  () => this._clearOutput());
        if (copyBtn)   copyBtn.addEventListener('click',   () => this._copyOutput());
        if (filterSel) filterSel.addEventListener('change', (e) => {
            this.filter = e.target.value;
            this._applyFilters();
        });

        const chFilterSel = document.getElementById('sm-channel-filter');
        if (chFilterSel) chFilterSel.addEventListener('change', (e) => {
            this.channelFilter = e.target.value;
            this._applyFilters();
        });

        // Max-frames select
        const maxFramesSel = document.getElementById('sm-max-frames');
        if (maxFramesSel) {
            maxFramesSel.addEventListener('change', (e) => {
                this.maxFrames = parseInt(e.target.value, 10) || 0;
                this._trimFrameList();
            });
        }

        const monToggle = document.getElementById('sm-monitor-toggle');
        if (monToggle) monToggle.addEventListener('click', () => this._toggleMonitorPanel());

        const logToggle = document.getElementById('sm-log-toggle');
        if (logToggle) logToggle.addEventListener('click', () => this._toggleLogPanel());

        const logClearBtn = document.getElementById('sm-log-clear-btn');
        if (logClearBtn) logClearBtn.addEventListener('click', () => {
            const list = document.getElementById('sm-log-list');
            if (list) { list.innerHTML = ''; this._logLines = 0; }
        });

        for (let i = 0; i < 4; i++) {
            const cb = document.getElementById(`sm-ch${i}-enabled`);
            if (cb) cb.addEventListener('change', () => {
                this._updateChannelState(i);
                this._saveConfig();
                // Redraw waterfall header so enabled-channel bars update immediately
                if (!this.running) {
                    this._readChannelFreqsFromUI();
                    this._drawWaterfallHeader();
                }
            });

            // Save + redraw header when freq or modem changes
            const freqIn   = document.getElementById(`sm-ch${i}-freq`);
            const modemSel = document.getElementById(`sm-ch${i}-modem`);
            const rcvrSel  = document.getElementById(`sm-ch${i}-rcvr`);
            const fx25Sel  = document.getElementById(`sm-ch${i}-fx25`);
            const il2pSel  = document.getElementById(`sm-ch${i}-il2p`);

            if (freqIn)   freqIn.addEventListener('change',   () => { this._saveConfig(); if (!this.running) { this._readChannelFreqsFromUI(); this._drawWaterfallHeader(); } });
            if (modemSel) modemSel.addEventListener('change', () => { this._saveConfig(); if (!this.running) { this._readChannelFreqsFromUI(); this._drawWaterfallHeader(); } });
            if (rcvrSel)  rcvrSel.addEventListener('change',  () => this._saveConfig());
            if (fx25Sel)  fx25Sel.addEventListener('change',  () => this._saveConfig());
            if (il2pSel)  il2pSel.addEventListener('change',  () => this._saveConfig());
        }

        // DCD threshold — save on change
        const dcdThreshEl = document.getElementById('sm-dcd-threshold');
        if (dcdThreshEl) dcdThreshEl.addEventListener('change', () => this._saveConfig());

        // Clamp numeric inputs to their min/max when the field is committed
        // (on blur or Enter). Using 'change' instead of 'input' so the user
        // can type freely without the value being clamped mid-entry.
        document.querySelectorAll('#sm-config-panel input[type="number"]').forEach(input => {
            input.addEventListener('change', () => {
                const min = parseFloat(input.min);
                const max = parseFloat(input.max);
                const val = parseFloat(input.value);
                if (!isNaN(val) && !isNaN(min) && val < min) input.value = min;
                if (!isNaN(val) && !isNaN(max) && val > max) input.value = max;
            });
        });

        // Restore persisted config into DOM inputs first
        this._loadConfig();

        // Restore runtime state
        if (filterSel) filterSel.value = this.filter;
        const chFilterSel2 = document.getElementById('sm-channel-filter');
        if (chFilterSel2) chFilterSel2.value = this.channelFilter;
        const maxFramesSel2 = document.getElementById('sm-max-frames');
        if (maxFramesSel2) maxFramesSel2.value = String(this.maxFrames);
        if (startBtn) {
            if (this.running) {
                this._setStartBtnRunning(startBtn);
            } else {
                this._setStartBtnReady(startBtn);
            }
        }
        // Restore settings panel visibility
        const settingsBtn2 = document.getElementById('sm-settings-toggle');
        if (settingsBtn2) {
            settingsBtn2.classList.toggle('active', this._settingsOpen);
            settingsBtn2.textContent = this._settingsOpen ? 'Settings ▲' : 'Settings';
        }
        this._setConfigVisible(this._settingsOpen, this.running);
        this._updateCountDisplay();

        // Restore DCD LED states
        for (let i = 0; i < 4; i++) this._updateDCDLed(i, this._dcdState[i]);

        // Restore monitor panel visibility
        const monPanel = document.getElementById('sm-monitor-panel');
        if (monPanel) monPanel.style.display = this._monitorOpen ? 'flex' : 'none';
        const monBtn = document.getElementById('sm-monitor-toggle');
        if (monBtn) monBtn.textContent = this._monitorOpen ? 'Hide Monitor' : 'Monitor';

        // Restore log panel visibility
        const logPanel = document.getElementById('sm-log-panel');
        if (logPanel) logPanel.style.display = this._logOpen ? 'flex' : 'none';
        const logBtn = document.getElementById('sm-log-toggle');
        if (logBtn) logBtn.textContent = this._logOpen ? 'Hide Log' : 'Log';

        // Init waterfall canvases — read current UI state first so header shows
        // channel markers even before the decoder is started
        this._readChannelFreqsFromUI();
        this._initWaterfallCanvases();
        if (this.running) this._startWaterfall();
    }

    _toggleSettings() {
        this._settingsOpen = !this._settingsOpen;
        const btn = document.getElementById('sm-settings-toggle');
        if (btn) {
            btn.classList.toggle('active', this._settingsOpen);
            btn.textContent = this._settingsOpen ? 'Settings ▲' : 'Settings';
        }
        // Show panel whenever _settingsOpen; disable inputs if running (read-only view)
        this._setConfigVisible(this._settingsOpen, this.running);
    }

    _updateChannelState(idx) {
        // No-op while running — config is locked
        if (this.running) return;
        const cb     = document.getElementById(`sm-ch${idx}-enabled`);
        const params = document.getElementById(`sm-ch${idx}-params`);
        if (!cb || !params) return;
        const enabled = cb.checked;
        params.classList.toggle('sm-channel-params-disabled', !enabled);
        params.querySelectorAll('input, select').forEach(el => { el.disabled = !enabled; });
    }

    // visible  — whether to show the panel
    // readOnly — if true, show it but disable all inputs (running state)
    _setConfigVisible(visible, readOnly = false) {
        const panel = document.getElementById('sm-config-panel');
        if (!panel) return;
        panel.style.display = visible ? '' : 'none';
        if (visible) {
            // Disable inputs when running (read-only view), enable when stopped
            panel.querySelectorAll('input, select, button').forEach(el => {
                el.disabled = readOnly;
            });
        }
    }

    // ── Collect params ────────────────────────────────────────────────────────

    // Read just the freq/modem/enabled fields from the DOM into _wfChannelFreqs
    // so the waterfall header can show channel markers before the decoder starts.
    _readChannelFreqsFromUI() {
        this._wfChannelFreqs = [];
        for (let i = 0; i < 4; i++) {
            const enabled = document.getElementById(`sm-ch${i}-enabled`)?.checked ?? false;
            const modem   = parseInt(document.getElementById(`sm-ch${i}-modem`)?.value ?? '1', 10);
            const freq    = parseFloat(document.getElementById(`sm-ch${i}-freq`)?.value ?? '1700');
            this._wfChannelFreqs.push({
                enabled,
                modem: isNaN(modem) ? 1    : modem,
                freq:  isNaN(freq)  ? 1700 : freq,
            });
        }
    }

    _collectParams() {
        const channels = [];
        for (let i = 0; i < 4; i++) {
            const enabled   = document.getElementById(`sm-ch${i}-enabled`)?.checked ?? false;
            const modem     = parseInt(document.getElementById(`sm-ch${i}-modem`)?.value  ?? '1', 10);
            const freq      = parseFloat(document.getElementById(`sm-ch${i}-freq`)?.value  ?? '1700');
            const rcvrPairs = parseInt(document.getElementById(`sm-ch${i}-rcvr`)?.value   ?? '0', 10);
            const fx25      = parseInt(document.getElementById(`sm-ch${i}-fx25`)?.value   ?? '1', 10);
            const il2p      = parseInt(document.getElementById(`sm-ch${i}-il2p`)?.value   ?? '0', 10);
            channels.push({
                enabled,
                modem:      isNaN(modem)     ? 1    : modem,
                freq:       isNaN(freq)      ? 1700 : freq,
                rcvr_pairs: isNaN(rcvrPairs) ? 0    : rcvrPairs,
                fx25:       isNaN(fx25)      ? 1    : fx25,
                il2p:       isNaN(il2p)      ? 0    : il2p,
            });
        }
        const dcdRaw = parseInt(document.getElementById('sm-dcd-threshold')?.value ?? '20', 10);
        const dcdThreshold = isNaN(dcdRaw) ? 20 : Math.max(1, Math.min(100, dcdRaw));
        return { channels, dcd_threshold: dcdThreshold };
    }

    // ── Start button visual state helpers ────────────────────────────────────
    // Use inline styles so they always win regardless of CSS load order or
    // specificity conflicts with the host page's stylesheet.

    _setStartBtnRunning(btn) {
        btn.textContent = 'Stop';
        btn.style.background = '#f44336';
        btn.style.color = '#fff';
        btn.style.animation = 'none';
        btn.style.boxShadow = 'none';
    }

    _setStartBtnReady(btn) {
        btn.textContent = 'Start';
        btn.style.background = '#388E3C';
        btn.style.color = '#fff';
        btn.style.animation = 'sm-start-pulse 1.8s ease-in-out infinite';
        btn.style.boxShadow = '';
    }

    // ── Decoder control ───────────────────────────────────────────────────────

    _toggleDecoder() {
        if (this.running) this._stopDecoder();
        else              this._startDecoder();
    }

    _startDecoder() {
        const ws = this._getWS();
        if (!ws) { this._setStatus('Error: WebSocket not connected', 'error'); return; }

        const params = this._collectParams();
        if (!params.channels.some(ch => ch.enabled)) {
            this._setStatus('Error: enable at least one channel', 'error');
            return;
        }

        // Snapshot channel frequencies + modem type for waterfall markers
        this._wfChannelFreqs = params.channels.map(ch => ({ freq: ch.freq, enabled: ch.enabled, modem: ch.modem }));

        this._installBinaryHandler();

        ws.send(JSON.stringify({
            type: 'audio_extension_attach',
            extension_name: 'soundmodem',
            params: { output_mode: 'ax25', ...params }
        }));

        this.running = true;
        this._setStatus('Connecting…');

        const btn = document.getElementById('sm-start-btn');
        if (btn) this._setStartBtnRunning(btn);

        // Hide config panel (but keep _settingsOpen state so toggle still works)
        this._setConfigVisible(false);
        this._startWaterfall();
    }

    _stopDecoder() {
        const ws = this._getWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio_extension_detach' }));
        }
        this._restoreBinaryHandler();
        this._stopWaterfall();
        this.running = false;
        this._setStatus('Stopped');

        const btn = document.getElementById('sm-start-btn');
        if (btn) this._setStartBtnReady(btn);

        // Re-show config panel (with inputs enabled) if settings was open
        this._setConfigVisible(this._settingsOpen, false);

        // Clear DCD LEDs and cancel any pending auto-clear timers
        for (let i = 0; i < 4; i++) {
            if (this._dcdTimers[i]) { clearTimeout(this._dcdTimers[i]); this._dcdTimers[i] = null; }
            this._dcdState[i] = false;
            this._updateDCDLed(i, false);
        }
    }

    // ── WebSocket binary interception ─────────────────────────────────────────

    _getWS() {
        const c = window.dxClusterClient;
        if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) return null;
        return c.ws;
    }

    _installBinaryHandler() {
        const c = window.dxClusterClient;
        if (!c || !c.ws) return;
        if (!this._origHandler) this._origHandler = c.ws.onmessage;

        this._ourHandler = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinary(event.data);
            } else if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buf => this._handleBinary(buf));
            } else {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'audio_extension_attached') {
                        this._setStatus('Running — listening for packets…', 'ok');
                        return;
                    }
                    if (msg.type === 'audio_extension_error') {
                        this._handleServerError(msg.error || 'Unknown server error');
                        return;
                    }
                } catch (_) { /* not JSON */ }
                if (this._origHandler) this._origHandler.call(c.ws, event);
            }
        };
        c.ws.onmessage = this._ourHandler;
    }

    _restoreBinaryHandler() {
        const c = window.dxClusterClient;
        if (c && c.ws && this._origHandler) c.ws.onmessage = this._origHandler;
        this._origHandler = null;
        this._ourHandler  = null;
    }

    // ── Binary message parsing ────────────────────────────────────────────────

    _handleBinary(buf) {
        const view = new DataView(buf);
        if (buf.byteLength < 1) return;
        switch (view.getUint8(0)) {
            case 0x20: this._handlePacket(view, buf); break;
            case 0x21: this._handleBinaryError(view, buf); break;
            case 0x23: this._handleDCD(view, buf); break;
            case 0x24: this._handleMonitor(view, buf); break;
            case 0x25: this._handleLog(view, buf); break;
            default:
                console.warn('[SoundModem] unknown binary type:', view.getUint8(0).toString(16));
        }
    }

    // 0x20 AX.25 packet
    _handlePacket(view, buf) {
        if (buf.byteLength < 6) return;
        const kissPort = view.getUint8(1);
        const frameLen = view.getUint32(2, false);
        if (buf.byteLength < 6 + frameLen) return;
        const ax25 = new Uint8Array(buf, 6, frameLen);
        const parsed = this._parseAX25(ax25);
        if (!parsed) return;
        parsed.kissPort = kissPort;
        this._displayFrame(parsed);
    }

    // 0x21 error
    _handleBinaryError(view, buf) {
        if (buf.byteLength < 5) return;
        const msgLen = view.getUint32(1, false);
        if (buf.byteLength < 5 + msgLen) return;
        const msg = new TextDecoder().decode(new Uint8Array(buf, 5, msgLen));
        this._handleServerError(msg);
    }

    // 0x23 DCD state: [type:1][channel:1][dcd_on:1]
    // DCD-on events are sent by the backend when a monitor frame arrives.
    // We auto-clear the LED after 500 ms so it acts as a brief activity flash.
    _handleDCD(view, buf) {
        if (buf.byteLength < 3) return;
        const channel = view.getUint8(1);
        const dcdOn   = view.getUint8(2) !== 0;
        if (channel >= 4) return;

        if (dcdOn) {
            // Light the LED and (re)start the auto-clear timer.
            this._dcdState[channel] = true;
            this._updateDCDLed(channel, true);
            if (this._dcdTimers[channel]) clearTimeout(this._dcdTimers[channel]);
            this._dcdTimers[channel] = setTimeout(() => {
                this._dcdTimers[channel] = null;
                this._dcdState[channel]  = false;
                this._updateDCDLed(channel, false);
            }, 500);
        } else {
            // Explicit DCD-off: cancel timer and clear immediately.
            if (this._dcdTimers[channel]) {
                clearTimeout(this._dcdTimers[channel]);
                this._dcdTimers[channel] = null;
            }
            this._dcdState[channel] = false;
            this._updateDCDLed(channel, false);
        }
    }

    // 0x24 monitor text: [type:1][channel:1][is_tx:1][text_len:4 BE][text: UTF-8]
    _handleMonitor(view, buf) {
        if (buf.byteLength < 7) return;
        const channel = view.getUint8(1);
        const isTX    = view.getUint8(2) !== 0;
        const textLen = view.getUint32(3, false);
        if (buf.byteLength < 7 + textLen) return;
        const text = new TextDecoder().decode(new Uint8Array(buf, 7, textLen)).trim();
        if (text) this._appendMonitorLine(channel, isTX, text);
    }

    _handleServerError(msg) {
        console.error('[SoundModem] backend error:', msg);
        this._setStatus('Error: ' + msg, 'error');
        this._restoreBinaryHandler();
        this._stopWaterfall();
        this.running = false;
        const btn = document.getElementById('sm-start-btn');
        if (btn) this._setStartBtnReady(btn);
        this._setConfigVisible(this._settingsOpen, false);
    }

    // ── DCD LED helpers ───────────────────────────────────────────────────────

    _updateDCDLed(channel, on) {
        const led = document.getElementById(`sm-dcd-led-${channel}`);
        if (!led) return;
        led.classList.toggle('sm-dcd-on',  on);
        led.classList.toggle('sm-dcd-off', !on);
        led.title = `Ch ${['A','B','C','D'][channel]} DCD: ${on ? 'ACTIVE' : 'idle'}`;
    }

    // ── Monitor panel ─────────────────────────────────────────────────────────

    _toggleMonitorPanel() {
        this._monitorOpen = !this._monitorOpen;
        const panel = document.getElementById('sm-monitor-panel');
        const btn   = document.getElementById('sm-monitor-toggle');
        if (panel) panel.style.display = this._monitorOpen ? 'flex' : 'none';
        if (btn)   btn.textContent = this._monitorOpen ? 'Hide Monitor' : 'Monitor';
    }

    // ── Process log panel ─────────────────────────────────────────────────────

    _toggleLogPanel() {
        this._logOpen = !this._logOpen;
        const panel = document.getElementById('sm-log-panel');
        const btn   = document.getElementById('sm-log-toggle');
        if (panel) panel.style.display = this._logOpen ? 'flex' : 'none';
        if (btn)   btn.textContent = this._logOpen ? 'Hide Log' : 'Log';
    }

    _appendLogLine(text) {
        const list = document.getElementById('sm-log-list');
        if (!list) return;

        const timeStr = new Date().toTimeString().slice(0, 8);

        const line = document.createElement('div');
        line.className = 'sm-log-line';

        const timeEl = document.createElement('span');
        timeEl.className = 'sm-log-time';
        timeEl.textContent = timeStr;

        const textEl = document.createElement('span');
        textEl.className = 'sm-log-text';
        textEl.textContent = text;

        line.appendChild(timeEl);
        line.appendChild(textEl);
        list.appendChild(line);
        this._logLines++;

        while (this._logLines > this._logMax) {
            list.removeChild(list.firstChild);
            this._logLines--;
        }

        // Auto-scroll only if panel is open and already at bottom
        const panel = document.getElementById('sm-log-panel');
        if (panel && this._logOpen) {
            const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
            if (atBottom) panel.scrollTop = panel.scrollHeight;
        }
    }

    // 0x25 process log line: [type:1][line_len:4 BE][line: UTF-8]
    _handleLog(view, buf) {
        if (buf.byteLength < 5) return;
        const lineLen = view.getUint32(1, false);
        if (buf.byteLength < 5 + lineLen) return;
        const lineBytes = new Uint8Array(buf, 5, lineLen);
        const text = new TextDecoder().decode(lineBytes);
        this._appendLogLine(text);
    }

    _appendMonitorLine(channel, isTX, text) {
        const list = document.getElementById('sm-monitor-list');
        if (!list) return;

        const chLabel = ['A','B','C','D'][channel] ?? String(channel);
        const timeStr = new Date().toTimeString().slice(0, 8);

        const line = document.createElement('div');
        line.className = 'sm-monitor-line' + (isTX ? ' sm-monitor-tx' : ' sm-monitor-rx');

        const timeEl = document.createElement('span');
        timeEl.className = 'sm-monitor-time';
        timeEl.textContent = timeStr;

        const badge = document.createElement('span');
        badge.className = `sm-channel-badge sm-channel-badge-${channel}`;
        badge.textContent = chLabel;

        const dirEl = document.createElement('span');
        dirEl.className = 'sm-monitor-dir';
        dirEl.textContent = isTX ? 'TX' : 'RX';

        const textEl = document.createElement('span');
        textEl.className = 'sm-monitor-text';
        textEl.textContent = text;

        line.appendChild(timeEl);
        line.appendChild(badge);
        line.appendChild(dirEl);
        line.appendChild(textEl);
        list.appendChild(line);
        this._monitorLines++;

        while (this._monitorLines > this._monitorMax) {
            list.removeChild(list.firstChild);
            this._monitorLines--;
        }

        const panel = document.getElementById('sm-monitor-panel');
        if (panel) panel.scrollTop = panel.scrollHeight;
    }

    // ── Waterfall ─────────────────────────────────────────────────────────────

    _initWaterfallCanvases() {
        const wfCanvas  = document.getElementById('sm-wf-canvas');
        const hdrCanvas = document.getElementById('sm-wf-header');
        const ovlCanvas = document.getElementById('sm-wf-overlay');
        if (!wfCanvas || !hdrCanvas) return;

        const container = wfCanvas.parentElement;  // .sm-wf-body
        const w = Math.max((container ? container.getBoundingClientRect().width : 0) || 400, 200);
        const h = 120;

        wfCanvas.width   = w;
        wfCanvas.height  = h;
        hdrCanvas.width  = w;
        hdrCanvas.height = 20;

        this._wfCtx    = wfCanvas.getContext('2d');
        this._wfHdrCtx = hdrCanvas.getContext('2d');

        this._wfCtx.fillStyle = '#000';
        this._wfCtx.fillRect(0, 0, w, h);

        if (ovlCanvas) {
            ovlCanvas.width  = w;
            ovlCanvas.height = h;
            this._wfOvlCtx = ovlCanvas.getContext('2d');
        }

        this._drawWaterfallHeader();
        this._drawWaterfallOverlay();
    }

    // rx_shift (BPF bandwidth) per modem index, from sm_main.c
    // Used to draw the channel bandwidth bar in the waterfall header.
    static get RX_SHIFT() {
        return [
            200,   // 0  AFSK 300 bd
            1000,  // 1  AFSK 1200 bd (Bell 202)
            450,   // 2  AFSK 600 bd
            1805,  // 3  AFSK 2400 bd
            1200,  // 4  BPSK 1200 bd
            600,   // 5  BPSK 600 bd
            300,   // 6  BPSK 300 bd
            2400,  // 7  BPSK 2400 bd
            2400,  // 8  QPSK 4800 bd
            1800,  // 9  QPSK 3600 bd
            1200,  // 10 QPSK 2400 bd
            525,   // 11 BPSK FEC (175*3)
            1200,  // 12 DW QPSK V26A
            1600,  // 13 DW 8PSK V27
            1200,  // 14 DW QPSK V26B
            500,   // 15 ARDOP
        ];
    }

    _drawWaterfallHeader() {
        const ctx = this._wfHdrCtx;
        if (!ctx) return;
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        const maxFreq = this._wfMaxFreq;

        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, w, h);

        // Major ticks every 500 Hz
        ctx.strokeStyle = '#ccc';
        ctx.fillStyle   = '#fff';
        ctx.font        = '9px monospace';
        ctx.textAlign   = 'center';
        ctx.lineWidth   = 1;

        for (let f = 0; f <= maxFreq; f += 500) {
            const x = Math.round((f / maxFreq) * w);
            ctx.beginPath();
            ctx.moveTo(x, h - 6);
            ctx.lineTo(x, h);
            ctx.stroke();
            if (f > 0 && f < maxFreq) {
                ctx.fillText(f >= 1000 ? (f / 1000).toFixed(1) + 'k' : String(f), x, h - 8);
            }
        }

        // Minor ticks every 100 Hz
        ctx.strokeStyle = '#666';
        for (let f = 100; f < maxFreq; f += 100) {
            if (f % 500 === 0) continue;
            const x = Math.round((f / maxFreq) * w);
            ctx.beginPath();
            ctx.moveTo(x, h - 3);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        // Channel frequency markers — bandwidth bar + centre line
        const chColors = ['#1565C0', '#2E7D32', '#6A1B9A', '#E65100'];
        const chNames  = ['A', 'B', 'C', 'D'];
        const rxShifts = SoundModemExtension.RX_SHIFT;

        this._wfChannelFreqs.forEach((ch, i) => {
            if (!ch.enabled || ch.freq <= 0) return;

            const shift   = (rxShifts[ch.modem] ?? 1000) / 2;   // half-bandwidth in Hz
            const fLo     = ch.freq - shift;
            const fHi     = ch.freq + shift;
            const xCtr    = Math.round((ch.freq / maxFreq) * w);
            const xLo     = Math.round((fLo    / maxFreq) * w);
            const xHi     = Math.round((fHi    / maxFreq) * w);

            const color   = chColors[i];

            // Filled bandwidth band (semi-transparent)
            ctx.fillStyle = color + '33';   // ~20% opacity
            ctx.fillRect(xLo, 0, xHi - xLo, h);

            // Horizontal bar at mid-height
            const barY = Math.round(h / 2);
            ctx.strokeStyle = color;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(xLo, barY);
            ctx.lineTo(xHi, barY);
            ctx.stroke();

            // Vertical end-caps (left and right edges of bandwidth)
            const capH = Math.round(h * 0.4);
            ctx.beginPath();
            ctx.moveTo(xLo, barY - capH);
            ctx.lineTo(xLo, barY + capH);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xHi, barY - capH);
            ctx.lineTo(xHi, barY + capH);
            ctx.stroke();

            // Centre tick (taller, 2px wide)
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(xCtr, 0);
            ctx.lineTo(xCtr, h);
            ctx.stroke();
            ctx.lineWidth = 1;

            // Channel label
            ctx.fillStyle = color;
            ctx.font      = 'bold 9px monospace';
            ctx.textAlign = xCtr > w - 20 ? 'right' : 'left';
            ctx.fillText(chNames[i], xCtr + (xCtr > w - 20 ? -3 : 3), 9);
        });
        ctx.textAlign = 'center';

        // Keep the waterfall overlay in sync
        this._drawWaterfallOverlay();
    }

    // Draw semi-transparent channel centre lines over the scrolling waterfall canvas.
    // Uses a separate overlay canvas so the FFT scroll doesn't erase them.
    _drawWaterfallOverlay() {
        const ctx = this._wfOvlCtx;
        if (!ctx) return;
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        const maxFreq  = this._wfMaxFreq;
        const rxShifts = SoundModemExtension.RX_SHIFT;
        const chColors = ['#1565C0', '#2E7D32', '#6A1B9A', '#E65100'];

        ctx.clearRect(0, 0, w, h);

        this._wfChannelFreqs.forEach((ch, i) => {
            if (!ch.enabled || ch.freq <= 0) return;

            const shift = (rxShifts[ch.modem] ?? 1000) / 2;
            const xCtr  = Math.round((ch.freq          / maxFreq) * w);
            const xLo   = Math.round(((ch.freq - shift) / maxFreq) * w);
            const xHi   = Math.round(((ch.freq + shift) / maxFreq) * w);
            const color = chColors[i];

            // Semi-transparent bandwidth band
            ctx.fillStyle = color + '18';   // ~10% opacity
            ctx.fillRect(xLo, 0, xHi - xLo, h);

            // Centre line — dashed, semi-transparent
            ctx.save();
            ctx.strokeStyle = color + 'aa'; // ~67% opacity
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(xCtr, 0);
            ctx.lineTo(xCtr, h);
            ctx.stroke();
            ctx.restore();

            // Edge lines — faint solid
            ctx.strokeStyle = color + '55'; // ~33% opacity
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(xLo, 0); ctx.lineTo(xLo, h);
            ctx.moveTo(xHi, 0); ctx.lineTo(xHi, h);
            ctx.stroke();
        });
    }

    _startWaterfall() {
        if (this._wfRunning) return;
        this._wfRunning = true;
        this._drawWaterfallHeader();
    }

    _stopWaterfall() {
        this._wfRunning = false;
        this._wfFftBuf = null;
    }

    // Called by the DecoderExtension framework every audio frame with time-domain PCM.
    // Follows the same pattern as the FSK extension: call radio.getAnalyser() here,
    // get frequency data, and draw the waterfall line directly.
    // The waterfall runs always (not just when the decoder is active) so the user
    // can see the spectrum before pressing Start.
    //
    // Throttled to _wfLineMs ms per line (default 50 ms = 20 lines/sec) so the
    // scroll speed is constant regardless of the animation-loop frame rate.
    onProcessAudio(_dataArray) {
        if (!this._wfCtx) return;

        const analyser = this.radio ? this.radio.getAnalyser() : null;
        if (!analyser) return;

        // Update sample rate on first call (or if it changes)
        if (analyser.context && analyser.context.sampleRate !== this._wfSampleRate) {
            this._wfSampleRate = analyser.context.sampleRate;
            this._drawWaterfallHeader();
        }

        // Allocate or reallocate FFT buffer if needed
        if (!this._wfFftBuf || this._wfFftBuf.length !== analyser.frequencyBinCount) {
            this._wfFftBuf = new Uint8Array(analyser.frequencyBinCount);
        }

        // Always pull fresh frequency data so the buffer stays current
        analyser.getByteFrequencyData(this._wfFftBuf);

        // Throttle: only scroll one line every _wfLineMs milliseconds
        const now = performance.now();
        if (now - this._wfLastLineAt < this._wfLineMs) return;
        this._wfLastLineAt = now;

        this._renderWaterfallLine();
    }

    _renderWaterfallLine() {
        const ctx = this._wfCtx;
        const w   = ctx.canvas.width;
        const h   = ctx.canvas.height;
        const bins = this._wfFftBuf;
        const nyquist  = this._wfSampleRate / 2;
        const maxFreq  = this._wfMaxFreq;
        const totalBins = bins.length;

        // Scroll existing content down by 1 pixel
        ctx.drawImage(ctx.canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);

        // Draw new line at top
        const imageData = ctx.createImageData(w, 1);
        const data = imageData.data;

        for (let px = 0; px < w; px++) {
            const freq   = (px / w) * maxFreq;
            const binIdx = Math.min(Math.round((freq / nyquist) * totalBins), totalBins - 1);
            const val    = bins[binIdx];

            data[px * 4]     = this._wfColorR(val);
            data[px * 4 + 1] = this._wfColorG(val);
            data[px * 4 + 2] = this._wfColorB(val);
            data[px * 4 + 3] = 255;
        }

        ctx.putImageData(imageData, 0, 0);
    }

    // Waterfall colour map: black → blue → cyan → green → yellow → red
    _wfColorR(v) {
        if (v < 64)  return 0;
        if (v < 128) return 0;
        if (v < 192) return Math.round((v - 128) * 4);
        return 255;
    }
    _wfColorG(v) {
        if (v < 64)  return 0;
        if (v < 128) return Math.round((v - 64) * 4);
        if (v < 192) return 255;
        return Math.round(255 - (v - 192) * 4);
    }
    _wfColorB(v) {
        if (v < 64)  return Math.round(v * 4);
        if (v < 128) return 255;
        if (v < 192) return Math.round(255 - (v - 128) * 4);
        return 0;
    }

    // ── AX.25 frame parser ────────────────────────────────────────────────────

    _parseAX25(bytes) {
        if (bytes.length < 15) return null;
        try {
            const dest = this._decodeAddress(bytes, 0);
            const src  = this._decodeAddress(bytes, 7);

            let offset = 14;
            const digi = [];

            if ((bytes[13] & 0x01) === 0) {
                while (offset + 7 <= bytes.length) {
                    const d = this._decodeAddress(bytes, offset);
                    digi.push(d);
                    offset += 7;
                    if (bytes[offset - 1] & 0x01) break;
                }
            }

            if (offset >= bytes.length) return null;

            const ctrl = bytes[offset++];
            let frameType = 'other';
            let pid = null;
            let info = '';

            const isUI     = (ctrl & 0xEF) === 0x03;
            const isSABM   = (ctrl & 0xEF) === 0x2F;
            const isUA     = (ctrl & 0xEF) === 0x63;
            const isDISC   = (ctrl & 0xEF) === 0x43;
            const isDM     = (ctrl & 0xEF) === 0x0F;
            const isIFrame = (ctrl & 0x01) === 0;

            if (isUI) {
                frameType = 'ui';
                if (offset < bytes.length) {
                    pid  = bytes[offset++];
                    info = this._decodeInfo(bytes, offset);
                }
            } else if (isIFrame) {
                frameType = 'connected';
                if (offset < bytes.length) {
                    pid  = bytes[offset++];
                    info = this._decodeInfo(bytes, offset);
                }
            } else if (isSABM) {
                frameType = 'connected'; info = '[SABM]';
            } else if (isUA) {
                frameType = 'connected'; info = '[UA]';
            } else if (isDISC) {
                frameType = 'connected'; info = '[DISC]';
            } else if (isDM) {
                frameType = 'connected'; info = '[DM]';
            } else {
                info = '[ctrl=0x' + ctrl.toString(16).padStart(2, '0') + ']';
            }

            const isAPRS = isUI && pid === 0xF0;
            if (isAPRS) frameType = 'aprs';

            return { from: src, to: dest, digipeaters: digi, ctrl, pid, info, frameType, isAPRS };

        } catch (e) {
            console.warn('[SoundModem] AX.25 parse error:', e);
            return null;
        }
    }

    _decodeAddress(bytes, offset) {
        let call = '';
        for (let i = 0; i < 6; i++) {
            const ch = bytes[offset + i] >> 1;
            if (ch !== 0x20 && ch !== 0x00) call += String.fromCharCode(ch);
        }
        call = call.trim();
        const ssidByte = bytes[offset + 6];
        const ssid = (ssidByte >> 1) & 0x0F;
        const hasBeenRepeated = (ssidByte & 0x80) !== 0;
        return ssid > 0 ? `${call}-${ssid}${hasBeenRepeated ? '*' : ''}` : `${call}${hasBeenRepeated ? '*' : ''}`;
    }

    _decodeInfo(bytes, offset) {
        if (offset >= bytes.length) return '';
        const slice = bytes.slice(offset);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(slice);
        } catch (_) {
            return new TextDecoder('latin1').decode(slice);
        }
    }

    // ── Display ───────────────────────────────────────────────────────────────

    _displayFrame(parsed) {
        if (this.filter === 'aprs' && !parsed.isAPRS) return;
        if (this.filter === 'ui'   && parsed.frameType !== 'ui' && !parsed.isAPRS) return;
        if (this.channelFilter !== 'all' && String(parsed.kissPort) !== this.channelFilter) return;

        this.frameCount++;
        this._updateCountDisplay();

        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = parsed.from;

        const digiStr = parsed.digipeaters.length > 0 ? ' via ' + parsed.digipeaters.join(',') : '';
        const pathStr = `${parsed.from} → ${parsed.to}${digiStr}`;
        const timeStr = new Date().toTimeString().slice(0, 8);
        this.copyBuffer.push(`[${timeStr}] ${pathStr}: ${parsed.info}`);

        const row = document.createElement('div');
        row.className = `sm-frame sm-frame-${parsed.frameType} sm-frame-ch-${parsed.kissPort}`;

        const meta = document.createElement('div');
        meta.className = 'sm-frame-meta';

        const timeEl = document.createElement('div');
        timeEl.className = 'sm-frame-time';
        const chLabel = ['A', 'B', 'C', 'D'][parsed.kissPort] ?? String(parsed.kissPort);
        const badge = document.createElement('span');
        badge.className = `sm-channel-badge sm-channel-badge-${parsed.kissPort}`;
        badge.textContent = chLabel;
        timeEl.appendChild(document.createTextNode(timeStr + ' '));
        timeEl.appendChild(badge);

        const fromEl = document.createElement('div');
        fromEl.className = 'sm-frame-from';
        fromEl.textContent = parsed.from;

        const toEl = document.createElement('div');
        toEl.className = 'sm-frame-to';
        toEl.textContent = parsed.to;

        meta.appendChild(timeEl);
        meta.appendChild(fromEl);
        meta.appendChild(toEl);

        const body = document.createElement('div');
        body.className = 'sm-frame-body';

        const pathEl = document.createElement('div');
        pathEl.className = 'sm-frame-path';
        pathEl.textContent = pathStr + (parsed.pid != null ? ` [PID:0x${parsed.pid.toString(16).padStart(2,'0')}]` : '');

        const payloadEl = document.createElement('div');
        payloadEl.className = 'sm-frame-payload';
        payloadEl.textContent = parsed.info;

        body.appendChild(pathEl);
        body.appendChild(payloadEl);
        row.appendChild(meta);
        row.appendChild(body);

        const list = document.getElementById('sm-frame-list');
        if (list) {
            // Insert newest frame at the top so the list reads newest-first
            list.insertBefore(row, list.firstChild);
            this._trimFrameList(list);
        }
    }

    _trimFrameList(list) {
        if (!list) list = document.getElementById('sm-frame-list');
        if (!list) return;
        const limit = this.maxFrames > 0 ? this.maxFrames : Infinity;
        // Newest frames are at the top (firstChild); remove oldest from the bottom (lastChild)
        while (list.children.length > limit) list.removeChild(list.lastChild);
    }

    // Show/hide existing rows to match the current type + channel filters.
    // Each row has classes: sm-frame  sm-frame-<type>  sm-frame-ch-<port>
    _applyFilters() {
        const list = document.getElementById('sm-frame-list');
        if (!list) return;
        Array.from(list.children).forEach(row => {
            // Derive channel from sm-frame-ch-N class
            const chMatch = Array.from(row.classList).find(c => c.startsWith('sm-frame-ch-'));
            const rowCh   = chMatch ? chMatch.replace('sm-frame-ch-', '') : null;

            // Derive frame type from sm-frame-<type> class (excluding sm-frame-ch-*)
            const typeMatch = Array.from(row.classList).find(
                c => c.startsWith('sm-frame-') && !c.startsWith('sm-frame-ch-') && c !== 'sm-frame'
            );
            const rowType = typeMatch ? typeMatch.replace('sm-frame-', '') : null;

            // Channel filter
            const chOk = this.channelFilter === 'all' || rowCh === this.channelFilter;

            // Type filter — 'aprs' means isAPRS flag; 'ui' means ui or aprs
            let typeOk = true;
            if (this.filter === 'aprs') {
                typeOk = row.classList.contains('sm-frame-aprs');
            } else if (this.filter === 'ui') {
                typeOk = rowType === 'ui' || row.classList.contains('sm-frame-aprs');
            }

            row.style.display = (chOk && typeOk) ? '' : 'none';
        });
    }

    _updateCountDisplay() {
        const el = document.getElementById('sm-frame-count');
        if (el) el.textContent = this.frameCount;
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _setStatus(text, cls) {
        const el = document.getElementById('sm-status-text');
        if (!el) return;
        el.textContent = text;
        el.className = 'sm-status-text' + (cls ? ' ' + cls : '');
    }

    _clearOutput() {
        this.frameCount = 0;
        this.copyBuffer = [];
        this._updateCountDisplay();
        const list = document.getElementById('sm-frame-list');
        if (list) list.innerHTML = '';
        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = '---';
    }

    _tuneToFrequency(freq, mode) {
        // Tune the radio to the given frequency and mode, following the same
        // pattern as the FT8 extension (window.setFrequency / window.setMode).
        if (window.setFrequency) window.setFrequency(freq);
        if (window.setMode)      window.setMode(mode || 'usb');
    }

    _copyOutput() {
        if (!this.copyBuffer.length) return;
        const text = this.copyBuffer.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            this._setStatus('Copied to clipboard', 'ok');
            setTimeout(() => {
                this._setStatus(this.running ? 'Running — listening for packets…' : 'Stopped');
            }, 2000);
        }).catch(err => {
            console.error('[SoundModem] copy failed:', err);
        });
    }
}

// Register
if (window.decoderManager) {
    window.decoderManager.register(new SoundModemExtension());
    console.log('✅ Sound Modem Extension registered');
} else {
    console.error('[SoundModem] decoderManager not available');
}
