// Sound Modem Extension — AX.25 packet radio decoder
// Synchronously load ax25decode.js if not already available.
// Using XHR sync ensures the decoder is ready before any KISS frames arrive,
// regardless of the async script-loading order from the manifest.
if (!window.AX25Decode) {
    try {
        const _xhr = new XMLHttpRequest();
        _xhr.open('GET', '/extensions/soundmodem/ax25decode.js', false); // false = synchronous
        _xhr.send(null);
        if (_xhr.status === 200) {
            // eslint-disable-next-line no-eval
            eval(_xhr.responseText); // sets window.AX25Decode
        }
    } catch (_e) {
        console.error('[SoundModem] Failed to load ax25decode.js synchronously:', _e);
    }
}
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
        this.searchText         = '';        // real-time text search filter
        this._seenCallsigns     = new Set(); // all sender callsigns ever seen
        this._callsignFilter    = '';        // selected sender from dropdown ('' = all)
        this._seenDests         = new Set(); // all destination callsigns ever seen
        this._destFilter        = '';        // selected destination from dropdown ('' = all)
        this._callsignChannels  = new Map(); // callsign → Set of kissPort numbers heard on

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
        this._wfMouseX       = null;   // canvas X of current mouse position (null = not hovering)

        // Monitor panel
        this._monitorLines = 0;
        this._monitorMax   = 300;
        this._monitorOpen  = false;

        // Process log panel (QtSoundModem stderr)
        this._logLines = 0;
        this._logMax   = 500;
        this._logOpen  = false;

        // Settings panel — shown by default on initial load
        this._settingsOpen = true;

        // DCD state per channel + auto-clear timers
        this._dcdState  = [false, false, false, false];
        this._dcdTimers = [null,  null,  null,  null];  // setTimeout handles for auto-clear

        // Last-frame time tracking for the "Xm Ys ago" display
        this._lastFrameTime = null;
        this._agoTimer      = null;

        // APRS station map: callsign → { lat, lon, comment, time, marker }
        this._stationMap  = new Map();
        this._leafletMap  = null;   // Leaflet map instance
        this._mapOpen     = false;

        // RF link graph: Set of "CALL_A|CALL_B" (canonical sorted key)
        // Populated from digipeater paths — each actioned digi heard the previous hop.
        this._rfLinks     = new Set();
        this._rfPolylines = new Map(); // "CALL_A|CALL_B" → Leaflet polyline
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
                    0%, 100% {
                        box-shadow: 0 0 0 0 rgba(76,175,80,0.7);
                        background: #388E3C;
                    }
                    50% {
                        box-shadow: 0 0 0 10px rgba(76,175,80,0);
                        background: #4CAF50;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        // Set a taller default panel height if the user hasn't resized it yet.
        // The resize system stores the height in localStorage under 'extension-panel-height'.
        try {
            if (!localStorage.getItem('extension-panel-height')) {
                localStorage.setItem('extension-panel-height', '650');
                // Also apply it immediately to the panel content element if present
                const panelContent = document.getElementById('extension-panel-content');
                if (panelContent) panelContent.style.maxHeight = '650px';
            }
        } catch (_) { /* localStorage not available */ }
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

        // Sender callsign dropdown filter
        const callsignSel = document.getElementById('sm-callsign-filter-select');
        if (callsignSel) {
            this._updateCallsignDropdown();
            callsignSel.value = this._callsignFilter;
            callsignSel.addEventListener('change', (e) => {
                this._callsignFilter = e.target.value;
                this._applyFilters();
            });
        }

        // Destination dropdown filter
        const destSel = document.getElementById('sm-dest-filter-select');
        if (destSel) {
            this._updateDestDropdown();
            destSel.value = this._destFilter;
            destSel.addEventListener('change', (e) => {
                this._destFilter = e.target.value;
                this._applyFilters();
            });
        }

        // Real-time text search
        const searchInput = document.getElementById('sm-search-input');
        if (searchInput) {
            searchInput.value = this.searchText;
            searchInput.addEventListener('input', (e) => {
                this.searchText = e.target.value.trim().toLowerCase();
                this._applyFilters();
            });
        }
        const searchClear = document.getElementById('sm-search-clear');
        if (searchClear) searchClear.addEventListener('click', () => {
            this.searchText = '';
            this._callsignFilter = '';
            this._destFilter = '';
            const inp = document.getElementById('sm-search-input');
            if (inp) inp.value = '';
            const sel = document.getElementById('sm-callsign-filter-select');
            if (sel) sel.value = '';
            const dsel = document.getElementById('sm-dest-filter-select');
            if (dsel) dsel.value = '';
            this._applyFilters();
        });

        const mapToggle = document.getElementById('sm-map-toggle');
        if (mapToggle) mapToggle.addEventListener('click', () => this._toggleMap());

        const mapCloseBtn = document.getElementById('sm-map-close-btn');
        if (mapCloseBtn) mapCloseBtn.addEventListener('click', () => this._toggleMap());

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
                // Keep DCD LED tooltip in sync with enabled state
                this._updateDCDLed(i, this._dcdState[i]);
            });

            // Save + redraw header when freq or modem changes; also refresh DCD tooltip
            const freqIn   = document.getElementById(`sm-ch${i}-freq`);
            const modemSel = document.getElementById(`sm-ch${i}-modem`);
            const rcvrSel  = document.getElementById(`sm-ch${i}-rcvr`);
            const fx25Sel  = document.getElementById(`sm-ch${i}-fx25`);
            const il2pSel  = document.getElementById(`sm-ch${i}-il2p`);

            if (freqIn)   freqIn.addEventListener('change',   () => { this._saveConfig(); this._updateDCDLed(i, this._dcdState[i]); if (!this.running) { this._readChannelFreqsFromUI(); this._drawWaterfallHeader(); } });
            if (modemSel) modemSel.addEventListener('change', () => { this._saveConfig(); this._updateDCDLed(i, this._dcdState[i]); if (!this.running) { this._readChannelFreqsFromUI(); this._drawWaterfallHeader(); } });
            if (rcvrSel)  rcvrSel.addEventListener('change',  () => { this._saveConfig(); this._updateDCDLed(i, this._dcdState[i]); });
            if (fx25Sel)  fx25Sel.addEventListener('change',  () => { this._saveConfig(); this._updateDCDLed(i, this._dcdState[i]); });
            if (il2pSel)  il2pSel.addEventListener('change',  () => { this._saveConfig(); this._updateDCDLed(i, this._dcdState[i]); });
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

        // Restore map button label with current station count
        this._updateMapStationCount();
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
        btn.style.color = '#fff';
        btn.style.animation = 'sm-start-pulse 1.8s ease-in-out infinite';
        btn.style.boxShadow = '';
        btn.style.background = ''; // Let the keyframe control background
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

        // Hide config panel and reset _settingsOpen so the toggle is in sync
        this._settingsOpen = false;
        const settingsBtn = document.getElementById('sm-settings-toggle');
        if (settingsBtn) {
            settingsBtn.classList.remove('active');
            settingsBtn.textContent = 'Settings';
        }
        this._setConfigVisible(false);
        this._startWaterfall();

        // Update placeholder to "waiting" state now that decoder is running
        const emptyEl = document.getElementById('sm-frame-empty');
        if (emptyEl) emptyEl.textContent = 'Waiting for first frame…';
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

        // Stop the "time ago" ticker
        this._stopAgoTimer();

        // Restore "configure" placeholder when stopped
        const emptyEl = document.getElementById('sm-frame-empty');
        if (emptyEl) emptyEl.textContent = 'Configure at least one channel and press Start…';
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

    // Human-readable label for each modem index (mirrors the <option> text in template.html)
    static get MODEM_LABELS() {
        return [
            'AFSK AX.25 300bd',          // 0
            'AFSK AX.25 1200bd (Bell 202)', // 1
            'AFSK AX.25 600bd',          // 2
            'AFSK AX.25 2400bd',         // 3
            'BPSK AX.25 1200bd',         // 4
            'BPSK AX.25 600bd',          // 5
            'BPSK AX.25 300bd',          // 6
            'BPSK AX.25 2400bd',         // 7
            'QPSK AX.25 4800bd',         // 8
            'QPSK AX.25 3600bd',         // 9
            'QPSK AX.25 2400bd',         // 10
            'BPSK FEC 4×100bd',          // 11
            'DW QPSK V26A 2400bd',       // 12
            'DW 8PSK V27 4800bd',        // 13
            'DW QPSK V26B 2400bd',       // 14
            'ARDOP Packet',              // 15
        ];
    }

    // Returns true if the channel's enabled checkbox is checked.
    _isChannelEnabled(channel) {
        return document.getElementById(`sm-ch${channel}-enabled`)?.checked ?? false;
    }

    // Build a tooltip string showing all 5 modem parameters for a channel.
    // Reads current values from the DOM (works both before and after start).
    _channelTooltip(channel) {
        const chName  = ['A', 'B', 'C', 'D'][channel] ?? String(channel);
        const enabled = this._isChannelEnabled(channel);

        const modemIdx  = parseInt(document.getElementById(`sm-ch${channel}-modem`)?.value ?? '1', 10);
        const freq      = document.getElementById(`sm-ch${channel}-freq`)?.value  ?? '?';
        const rcvrPairs = document.getElementById(`sm-ch${channel}-rcvr`)?.value  ?? '?';
        const fx25Val   = document.getElementById(`sm-ch${channel}-fx25`)?.value  ?? '?';
        const il2pVal   = document.getElementById(`sm-ch${channel}-il2p`)?.value  ?? '?';

        const modemLabel = SoundModemExtension.MODEM_LABELS[modemIdx] ?? `Modem ${modemIdx}`;
        const rcvrLabel  = rcvrPairs === '0' ? '0 (off)' : rcvrPairs;

        const fx25Labels = { '0': 'Off', '1': 'On' };
        const fx25Label  = fx25Labels[fx25Val] ?? fx25Val;

        const il2pLabels = { '0': 'Off', '1': 'IL2P', '2': 'IL2P+CRC', '3': 'Both' };
        const il2pLabel  = il2pLabels[il2pVal] ?? il2pVal;

        const statusLine = enabled ? '✔ Enabled' : '✘ Disabled';
        return `Ch ${chName} — ${statusLine}\nModem: ${modemLabel}\nFreq: ${freq} Hz\nRcvr Pairs: ${rcvrLabel}\nFX.25: ${fx25Label}\nIL2P: ${il2pLabel}`;
    }

    _updateDCDLed(channel, on) {
        const led     = document.getElementById(`sm-dcd-led-${channel}`);
        if (!led) return;
        const enabled = this._isChannelEnabled(channel);

        led.classList.toggle('sm-dcd-on',  on);
        led.classList.toggle('sm-dcd-off', !on);
        // Per-channel colour when DCD fires
        led.classList.toggle(`sm-dcd-on-${channel}`, on);
        // Ring: channel colour when enabled, grey when disabled
        led.classList.toggle(`sm-dcd-enabled-${channel}`, enabled);
        led.classList.toggle('sm-dcd-disabled',            !enabled);

        led.title = this._channelTooltip(channel);
    }

    // ── Monitor panel ─────────────────────────────────────────────────────────

    _toggleMonitorPanel() {
        this._monitorOpen = !this._monitorOpen;
        const panel = document.getElementById('sm-monitor-panel');
        const btn   = document.getElementById('sm-monitor-toggle');
        if (panel) panel.style.display = this._monitorOpen ? 'flex' : 'none';
        if (btn)   btn.textContent = this._monitorOpen ? 'Hide Monitor' : 'Monitor';
        // Scroll to bottom when opening so the latest messages are visible
        if (this._monitorOpen && panel) {
            requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
        }
    }

    // ── Process log panel ─────────────────────────────────────────────────────

    _toggleLogPanel() {
        this._logOpen = !this._logOpen;
        const panel = document.getElementById('sm-log-panel');
        const btn   = document.getElementById('sm-log-toggle');
        if (panel) panel.style.display = this._logOpen ? 'flex' : 'none';
        if (btn)   btn.textContent = this._logOpen ? 'Hide Log' : 'Log';
        // Scroll to bottom when opening so the latest log lines are visible
        if (this._logOpen && panel) {
            requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
        }
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

            // Mouse hover — show audio + RF frequency tooltip
            ovlCanvas.addEventListener('mousemove', (e) => {
                const rect = ovlCanvas.getBoundingClientRect();
                // Scale from CSS pixels to canvas pixels
                this._wfMouseX = (e.clientX - rect.left) * (ovlCanvas.width / rect.width);
                this._drawWaterfallOverlay();
            });
            ovlCanvas.addEventListener('mouseleave', () => {
                this._wfMouseX = null;
                this._drawWaterfallOverlay();
            });
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

    /**
     * Parse an APRS position from an info field string.
     * Handles the common uncompressed formats:
     *   !DDMM.mmN/DDDMM.mmW[sym][comment]
     *   =DDMM.mmN/DDDMM.mmW[sym][comment]
     *   @DDHHmmz/DDDMM.mmW... (time-stamped, less common)
     *
     * Returns { lat, lon, latStr, lonStr } in decimal degrees, or null.
     */
    static _parseAPRSPosition(info) {
        if (!info) return null;

        // Match uncompressed APRS position: DDMM.mmN/DDDMM.mmW (or E/S)
        // The position can appear after a leading type char (!, =, @, /, etc.)
        const re = /(\d{2})(\d{2}\.\d+)([NS])[\/\\](\d{3})(\d{2}\.\d+)([EW])/;
        const m = info.match(re);
        if (!m) return null;

        const latDeg  = parseInt(m[1], 10);
        const latMin  = parseFloat(m[2]);
        const latHemi = m[3];
        const lonDeg  = parseInt(m[4], 10);
        const lonMin  = parseFloat(m[5]);
        const lonHemi = m[6];

        let lat = latDeg + latMin / 60;
        let lon = lonDeg + lonMin / 60;
        if (latHemi === 'S') lat = -lat;
        if (lonHemi === 'W') lon = -lon;

        // Reconstruct the exact string as it appears in the info field
        const latStr = `${m[1]}${m[2]}${m[3]}`;
        const lonStr = `${m[4]}${m[5]}${m[6]}`;

        return { lat: lat.toFixed(6), lon: lon.toFixed(6), latStr, lonStr };
    }

    /**
     * Populate a payload <span> with linkified content.
     * Handles two link types (in priority order):
     *   1. APRS coordinates → Google Maps link (sm-aprs-map-link)
     *   2. http:// / https:// URLs → plain <a> link (sm-url-link)
     *
     * The algorithm: build a list of {start, end, node} replacements, sort by
     * position, then interleave text nodes and link elements.
     */
    _linkifyPayload(container, text, aprsPos) {
        // Collect all link spans: { start, end, makeEl }
        const spans = [];

        // 1. APRS coordinate span
        if (aprsPos) {
            const coordStr = `${aprsPos.latStr}/${aprsPos.lonStr}`;
            const idx = text.indexOf(coordStr);
            if (idx >= 0) {
                const mapsUrl = `https://www.google.com/maps?q=${aprsPos.lat},${aprsPos.lon}`;
                spans.push({
                    start: idx,
                    end:   idx + coordStr.length,
                    makeEl() {
                        const a = document.createElement('a');
                        a.href      = mapsUrl;
                        a.target    = '_blank';
                        a.rel       = 'noopener noreferrer';
                        a.className = 'sm-aprs-map-link';
                        a.textContent = coordStr;
                        return a;
                    },
                });
            }
        }

        // 2. URL spans — find all http(s):// occurrences
        const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
        let m;
        while ((m = urlRe.exec(text)) !== null) {
            const url = m[0];
            const start = m.index;
            const end   = start + url.length;
            // Skip if already covered by an APRS span
            if (spans.some(s => start >= s.start && end <= s.end)) continue;
            spans.push({
                start,
                end,
                makeEl() {
                    const a = document.createElement('a');
                    a.href      = url;
                    a.target    = '_blank';
                    a.rel       = 'noopener noreferrer';
                    a.className = 'sm-url-link';
                    a.textContent = url;
                    return a;
                },
            });
        }

        if (spans.length === 0) {
            container.textContent = text;
            return;
        }

        // Sort by start position
        spans.sort((a, b) => a.start - b.start);

        // Build DOM: interleave text nodes and link elements
        let pos = 0;
        spans.forEach(span => {
            if (span.start > pos) {
                container.appendChild(document.createTextNode(text.slice(pos, span.start)));
            }
            container.appendChild(span.makeEl());
            pos = span.end;
        });
        if (pos < text.length) {
            container.appendChild(document.createTextNode(text.slice(pos)));
        }
    }

    // ── APRS Station Map ──────────────────────────────────────────────────────

    _toggleMap() {
        this._mapOpen = !this._mapOpen;
        const modal = document.getElementById('sm-map-modal');
        if (!modal) return;
        if (this._mapOpen) {
            modal.style.display = 'flex';
            this._initLeafletMap();
            this._updateAllMapMarkers();
        } else {
            modal.style.display = 'none';
        }
        // Always update button text with current count
        this._updateMapStationCount();
    }

    _initLeafletMap() {
        if (this._leafletMap) {
            // Already initialised — just invalidate size in case modal was hidden
            this._leafletMap.invalidateSize();
            return;
        }
        if (typeof L === 'undefined') {
            // Leaflet not loaded — inject it
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            link.href = '/leaflet.css';
            document.head.appendChild(link);
            const script = document.createElement('script');
            script.src = '/leaflet.js';
            script.onload = () => {
                this._initLeafletMap();
                this._updateAllMapMarkers();
            };
            document.head.appendChild(script);
            return;
        }
        const container = document.getElementById('sm-map-container');
        if (!container) return;

        this._leafletMap = L.map(container, { zoomControl: true });

        // Dark-styled tile layer (OpenStreetMap)
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18,
        }).addTo(this._leafletMap);

        // Apply dark filter via CSS class
        container.classList.add('sm-map-dark');
    }

    _makeMarkerIcon(callsign) {
        // Custom DivIcon with callsign label
        // Dot is 16px; anchor at its centre so the marker sits on the coordinate
        return L.divIcon({
            className: 'sm-map-marker',
            html: `<div class="sm-map-marker-dot"></div><div class="sm-map-marker-label">${callsign}</div>`,
            iconAnchor: [8, 8],
            popupAnchor: [0, -20],
        });
    }

    _updateMapMarker(callsign, entry) {
        if (!this._leafletMap) return;
        const timeStr = entry.time.toTimeString().slice(0, 8);

        // Build heard/heard-by lists from _rfLinks
        const heardBy   = [];  // stations that have heard this callsign
        const canHear   = [];  // stations this callsign has heard
        this._rfLinks.forEach(key => {
            const [a, b] = key.split('|');
            if (a === callsign) canHear.push(b);
            else if (b === callsign) heardBy.push(a);
        });
        canHear.sort();
        heardBy.sort();

        // Build channel badges for channels this callsign has been heard on
        const CH_COLORS = ['#29B6F6', '#66BB6A', '#CE93D8', '#FFA726'];
        const CH_NAMES  = ['A', 'B', 'C', 'D'];
        const channels  = this._callsignChannels.get(callsign);
        let chBadges = '';
        if (channels && channels.size > 0) {
            const sorted = Array.from(channels).sort();
            chBadges = sorted.map(ch => {
                const color = CH_COLORS[ch] || '#888';
                const name  = CH_NAMES[ch]  || String(ch);
                return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:4px">` +
                       `${name}<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};box-shadow:0 0 4px ${color}"></span>` +
                       `</span>`;
            }).join('');
        }

        let popupHtml = `<b>${callsign}</b>`;
        if (chBadges) popupHtml += ` ${chBadges}`;
        popupHtml += `<br>`;
        if (entry.comment) popupHtml += `<span style="font-size:11px">${entry.comment}</span><br>`;
        popupHtml += `<small>Last seen: ${timeStr}</small>`;
        if (canHear.length > 0) {
            popupHtml += `<br><small><b>Hears:</b> ${canHear.join(', ')}</small>`;
        }
        if (heardBy.length > 0) {
            popupHtml += `<br><small><b>Heard by:</b> ${heardBy.join(', ')}</small>`;
        }

        if (entry.marker) {
            entry.marker.setLatLng([entry.lat, entry.lon]);
            entry.marker.setPopupContent(popupHtml);
        } else {
            entry.marker = L.marker([entry.lat, entry.lon], { icon: this._makeMarkerIcon(callsign) })
                .addTo(this._leafletMap)
                .bindPopup(popupHtml, { maxWidth: 300 });
            this._stationMap.set(callsign, entry);
        }
    }

    _updateAllMapMarkers() {
        if (!this._leafletMap) return;
        const bounds = [];
        this._stationMap.forEach((entry, callsign) => {
            this._updateMapMarker(callsign, entry);
            bounds.push([entry.lat, entry.lon]);
        });
        // Draw all known RF links
        this._drawAllRFLinks();
        if (bounds.length > 0) {
            this._leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
        } else {
            this._leafletMap.setView([51.5, -0.1], 5); // Default: UK
        }
        this._leafletMap.invalidateSize();
    }

    /**
     * Draw (or update) a single RF link polyline between two callsigns.
     * Only draws if both callsigns have known positions in _stationMap.
     */
    _drawRFLink(key, callA, callB) {
        if (!this._leafletMap) return;
        const a = this._stationMap.get(callA);
        const b = this._stationMap.get(callB);
        if (!a || !b) return; // One or both positions unknown — skip

        if (this._rfPolylines.has(key)) {
            // Update existing line (positions may have changed)
            this._rfPolylines.get(key).setLatLngs([[a.lat, a.lon], [b.lat, b.lon]]);
        } else {
            const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
                color:     '#4fc3f7',
                weight:    1.5,
                opacity:   0.6,
                dashArray: '4 4',
            }).addTo(this._leafletMap);
            // Tooltip showing the link
            line.bindTooltip(`${callA} ↔ ${callB}`, { sticky: true, direction: 'center' });
            this._rfPolylines.set(key, line);
        }
    }

    /** Draw all known RF links that have positions for both endpoints. */
    _drawAllRFLinks() {
        this._rfLinks.forEach(key => {
            const [a, b] = key.split('|');
            this._drawRFLink(key, a, b);
        });
    }

    _updateMapStationCount() {
        const n = this._stationMap.size;
        const el = document.getElementById('sm-map-station-count');
        if (el) el.textContent = `${n} station${n !== 1 ? 's' : ''}`;
        // Keep the Map button label in sync
        const btn = document.getElementById('sm-map-toggle');
        if (btn) btn.textContent = this._mapOpen ? `Hide Map (${n})` : `Map (${n})`;
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
        const chColors = ['#29B6F6', '#66BB6A', '#CE93D8', '#FFA726'];
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
        // Use bright, saturated colours that stand out against the dark waterfall
        const chColors = ['#29B6F6', '#66BB6A', '#CE93D8', '#FFA726'];

        ctx.clearRect(0, 0, w, h);

        this._wfChannelFreqs.forEach((ch, i) => {
            if (!ch.enabled || ch.freq <= 0) return;

            const shift  = (rxShifts[ch.modem] ?? 1000) / 2;
            const xCtr   = Math.round((ch.freq           / maxFreq) * w);
            const xLo    = Math.round(((ch.freq - shift)  / maxFreq) * w);
            const xHi    = Math.round(((ch.freq + shift)  / maxFreq) * w);
            const color  = chColors[i];
            const chName = ['A','B','C','D'][i] ?? String(i);

            // Bandwidth band fill
            ctx.fillStyle = color + '40';   // ~25% opacity
            ctx.fillRect(xLo, 0, xHi - xLo, h);

            // Edge lines — bright, solid
            ctx.strokeStyle = color + 'cc'; // ~80% opacity
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(xLo, 0); ctx.lineTo(xLo, h);
            ctx.moveTo(xHi, 0); ctx.lineTo(xHi, h);
            ctx.stroke();

            // Centre line — full brightness, wider
            ctx.save();
            ctx.strokeStyle = color;        // 100% opacity
            ctx.lineWidth   = 2.5;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            ctx.moveTo(xCtr, 0);
            ctx.lineTo(xCtr, h);
            ctx.stroke();
            ctx.restore();

            // Channel label — larger, with stronger background
            ctx.save();
            ctx.font         = 'bold 12px monospace';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            const labelW = ctx.measureText(chName).width + 8;
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.fillRect(xCtr - labelW / 2, 2, labelW, 16);
            ctx.fillStyle = color;
            ctx.fillText(chName, xCtr, 10);
            ctx.restore();
        });

        // ── Mouse crosshair + frequency tooltip ───────────────────────────────
        if (this._wfMouseX !== null) {
            const mx = this._wfMouseX;

            // Audio frequency at cursor
            const audioHz = Math.round((mx / w) * maxFreq);

            // RF frequency = dial frequency + audio offset (USB convention)
            let rfLabel = '';
            try {
                const dialHz = this.radio ? this.radio.getFrequency() : null;
                if (dialHz && dialHz > 0) {
                    const rfHz = dialHz + audioHz;
                    if (rfHz >= 1e6) {
                        rfLabel = ` | ${(rfHz / 1e6).toFixed(4)} MHz`;
                    } else {
                        rfLabel = ` | ${(rfHz / 1e3).toFixed(3)} kHz`;
                    }
                }
            } catch (_) { /* radio API not available */ }

            const label = `${audioHz} Hz${rfLabel}`;

            // Vertical crosshair line
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth   = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(mx, 0);
            ctx.lineTo(mx, h);
            ctx.stroke();
            ctx.restore();

            // Tooltip box
            ctx.font = 'bold 10px monospace';
            const textW = ctx.measureText(label).width;
            const padX = 4, padY = 3;
            const boxW = textW + padX * 2;
            const boxH = 14;
            // Position: above cursor, flip left if near right edge
            let bx = mx + 6;
            if (bx + boxW > w) bx = mx - boxW - 6;
            const by = 4;

            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, 3);
            ctx.fill();

            ctx.fillStyle = '#fff';
            ctx.textBaseline = 'top';
            ctx.fillText(label, bx + padX, by + padY);
        }
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

    // ── AX.25 frame parser — delegates to AX25Decode (ax25decode.js) ──────────

    _parseAX25(bytes) {
        if (!window.AX25Decode) {
            console.warn('[SoundModem] AX25Decode not loaded');
            return null;
        }
        return window.AX25Decode.parse(bytes);
    }

    // ── Display ───────────────────────────────────────────────────────────────

    _displayFrame(parsed) {
        // ── Validity check — drop corrupt/noise frames ────────────────────────
        // Real AX.25 callsigns are 1-6 alphanumeric chars + optional -N (0-15).
        // Frames with garbage callsigns are noise bursts decoded as AX.25.
        const validCall = /^[A-Z0-9]{1,6}(-\d{1,2})?$/i;
        if (!validCall.test(parsed.from) || !validCall.test(parsed.to)) return;

        // ── Filter ────────────────────────────────────────────────────────────
        const ft = parsed.frameType;
        const CONNECTED_TYPES = new Set(['i','rr','rnr','rej','srej','sabm','sabme','ua','disc','dm','frmr','xid','test']);
        const CONTROL_TYPES   = new Set(['rr','rnr','rej','srej']);
        const NETROM_TYPES    = new Set(['netrom','nodes','nodes-poll','l4-connect','l4-connect-ack','l4-disc','l4-disc-ack','l4-info','l4-info-ack','l4-reset','l4-unknown']);

        switch (this.filter) {
            case 'aprs':     if (!parsed.isAPRS) return; break;
            case 'ui':       if (ft !== 'ui' && !parsed.isAPRS) return; break;
            case 'connected':if (!CONNECTED_TYPES.has(ft)) return; break;
            case 'netrom':   if (!NETROM_TYPES.has(ft)) return; break;
            case 'control':  if (!CONTROL_TYPES.has(ft)) return; break;
            case 'ip':       if (ft !== 'ip' && ft !== 'arp') return; break;
            default: break; // 'all'
        }
        if (this.channelFilter !== 'all' && String(parsed.kissPort) !== this.channelFilter) return;

        this.frameCount++;
        this._updateCountDisplay();

        // Track which channel(s) this callsign has been heard on
        if (!this._callsignChannels.has(parsed.from)) {
            this._callsignChannels.set(parsed.from, new Set());
        }
        this._callsignChannels.get(parsed.from).add(parsed.kissPort);

        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = parsed.from;
        this._lastFrameTime = Date.now();
        this._updateAgoDisplay();
        if (!this._agoTimer) this._startAgoTimer();

        // Track sender callsigns (from + actioned digipeaters, excluding generic aliases)
        const stripStar = c => c.replace(/\*$/, '');
        const prevSenderSize = this._seenCallsigns.size;
        this._seenCallsigns.add(stripStar(parsed.from));
        if (parsed.digipeaters) {
            parsed.digipeaters.forEach(d => {
                const bare = stripStar(d);
                if (!/^(WIDE|RELAY|TRACE|GATE|TCPIP|NOGATE|RFONLY)/i.test(bare)) {
                    this._seenCallsigns.add(bare);
                }
            });
        }
        if (this._seenCallsigns.size !== prevSenderSize) {
            this._updateCallsignDropdown();
        }

        // Track destination callsigns
        if (parsed.to) {
            const prevDestSize = this._seenDests.size;
            this._seenDests.add(parsed.to);
            if (this._seenDests.size !== prevDestSize) {
                this._updateDestDropdown();
            }
        }

        const digiStr = parsed.digipeaters && parsed.digipeaters.length > 0
            ? ' via ' + parsed.digipeaters.join(',') : '';
        const pathStr = `${parsed.from}→${parsed.to}${digiStr}`;
        const timeStr = new Date().toTimeString().slice(0, 8);
        this.copyBuffer.push(`[${timeStr}] ${pathStr}: ${parsed.info}`);

        // ── RF link extraction from digipeater path ───────────────────────────
        // Each actioned digi (marked with *) heard the previous hop directly.
        // Build a chain: [source, digi1*, digi2*, ...] and record each adjacent pair.
        if (parsed.digipeaters && parsed.digipeaters.length > 0) {
            // Strip the * suffix to get the bare callsign
            const strip = c => c.replace(/\*$/, '').split('-')[0] + (c.includes('-') ? '-' + c.replace(/\*$/, '').split('-')[1] : '');
            const chain = [parsed.from];
            for (const d of parsed.digipeaters) {
                if (d.endsWith('*')) {
                    chain.push(strip(d));
                } else {
                    break; // Stop at first un-actioned digi
                }
            }
            // Record each adjacent pair as a bidirectional RF link
            for (let i = 0; i + 1 < chain.length; i++) {
                const a = chain[i], b = chain[i + 1];
                const key = [a, b].sort().join('|');
                if (!this._rfLinks.has(key)) {
                    this._rfLinks.add(key);
                    // Draw the line immediately if map is open and both have positions
                    if (this._mapOpen && this._leafletMap) {
                        this._drawRFLink(key, a, b);
                    }
                }
            }
        }

        // ── HEARD frame RF link extraction ────────────────────────────────────
        // BPQ32 sends "FROM→HEARD" UI frames whose payload is a space-separated
        // list of callsigns that FROM has directly heard.
        // e.g. GB7BWR→HEARD: "EI5IYB GB7NOT GB7RDG GB7WEM PD4R GB7BPQ"
        // Each listed callsign has a direct RF link to FROM.
        if (parsed.to === 'HEARD' && parsed.infoRaw) {
            const heardCalls = parsed.infoRaw.trim().split(/\s+/).filter(c => /^[A-Z0-9]+-?[0-9]*$/i.test(c));
            heardCalls.forEach(heardCall => {
                const a = parsed.from;
                const b = heardCall.toUpperCase();
                if (a === b) return;
                const key = [a, b].sort().join('|');
                if (!this._rfLinks.has(key)) {
                    this._rfLinks.add(key);
                    if (this._mapOpen && this._leafletMap) {
                        this._drawRFLink(key, a, b);
                    }
                }
            });
        }

        // Normalised CSS type (collapse l4-* subtypes to 'netrom')
        const cssType = NETROM_TYPES.has(ft) ? 'netrom' : ft;

        // ── Single-line row ───────────────────────────────────────────────────
        // Layout: [ch badge] [time] [from→to] [frame-type tag] [payload]
        const row = document.createElement('div');
        row.className = `sm-frame sm-frame-${cssType} sm-frame-ch-${parsed.kissPort}`;
        // Store sender and destination for precise dropdown filtering
        row.dataset.from = parsed.from;
        row.dataset.to   = parsed.to || '';

        // Channel badge (A/B/C/D) — tooltip shows the modem config for this channel
        const chLabel = ['A','B','C','D'][parsed.kissPort] ?? String(parsed.kissPort);
        const chBadge = document.createElement('span');
        chBadge.className = `sm-channel-badge sm-channel-badge-${parsed.kissPort}`;
        chBadge.textContent = chLabel;
        chBadge.title = this._channelTooltip(parsed.kissPort);
        row.appendChild(chBadge);

        // Timestamp
        const timeEl = document.createElement('span');
        timeEl.className = 'sm-frame-time';
        timeEl.textContent = timeStr;
        row.appendChild(timeEl);

        // FROM→TO [via DIGI]
        const pathEl = document.createElement('span');
        pathEl.className = 'sm-frame-path';
        pathEl.textContent = pathStr;
        row.appendChild(pathEl);

        // Frame-type tag (ctrl type: UI / I / RR / SABM etc.)
        const typeTag = document.createElement('span');
        typeTag.className = `sm-frame-type-tag sm-frame-type-${cssType}`;
        // Show a short human label
        const TYPE_LABELS = {
            aprs:'APRS', ui:'UI', i:'I', rr:'RR', rnr:'RNR', rej:'REJ', srej:'SREJ',
            sabm:'SABM', sabme:'SABME', ua:'UA', disc:'DISC', dm:'DM',
            frmr:'FRMR', xid:'XID', test:'TEST',
            netrom:'NR', nodes:'NODES', ip:'IP', arp:'ARP', s:'S', u:'U',
        };
        typeTag.textContent = TYPE_LABELS[cssType] || cssType.toUpperCase();
        row.appendChild(typeTag);

        // Payload / decoded info
        // For NET/ROM INFO frames append the raw data after the summary
        let payloadText = parsed.info;
        if (parsed.netrom && parsed.netrom.raw) payloadText += ' ' + parsed.netrom.raw;

        // Try to extract APRS position and make it a Google Maps link
        const aprsPos = parsed.isAPRS ? SoundModemExtension._parseAPRSPosition(payloadText) : null;

        // Store position in station map (even when map is closed)
        if (aprsPos) {
            const lat = parseFloat(aprsPos.lat);
            const lon = parseFloat(aprsPos.lon);
            // Guard against NaN/out-of-range coordinates (malformed APRS position strings)
            if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                console.warn('[SoundModem] Invalid APRS position skipped:', aprsPos, 'from', parsed.from);
            } else {
                const callsign = parsed.from;
                const existing = this._stationMap.get(callsign);
                const entry = {
                    lat,
                    lon,
                    comment: payloadText,
                    time:    new Date(),
                    marker:  existing ? existing.marker : null,
                };
                this._stationMap.set(callsign, entry);
                // Always update the button count (map may be closed)
                this._updateMapStationCount();
                // Update marker and RF links only if map is open
                if (this._mapOpen && this._leafletMap) {
                    this._updateMapMarker(callsign, entry);
                    this._drawAllRFLinks();
                }
            }
        }

        const payloadEl = document.createElement('span');
        payloadEl.className = 'sm-frame-payload';
        // Native tooltip shows full text on hover (bypasses CSS ellipsis truncation)
        payloadEl.title = payloadText;

        // Build payload with clickable links: APRS coords → Google Maps, URLs → href
        this._linkifyPayload(payloadEl, payloadText, aprsPos);
        row.appendChild(payloadEl);

        const list = document.getElementById('sm-frame-list');
        if (list) {
            // Remove the "Waiting for first frame…" placeholder on first real frame
            const empty = document.getElementById('sm-frame-empty');
            if (empty) empty.remove();
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
    // Each row has classes: sm-frame  sm-frame-<cssType>  sm-frame-ch-<port>
    // cssType is the normalised type written by _displayFrame (l4-* → 'netrom').
    _applyFilters() {
        const list = document.getElementById('sm-frame-list');
        if (!list) return;

        const CONNECTED_CSS = new Set(['i','rr','rnr','rej','srej','sabm','sabme','ua','disc','dm','frmr','xid','test']);
        const CONTROL_CSS   = new Set(['rr','rnr','rej','srej']);

        Array.from(list.children).forEach(row => {
            // Derive channel from sm-frame-ch-N class
            const chMatch = Array.from(row.classList).find(c => c.startsWith('sm-frame-ch-'));
            const rowCh   = chMatch ? chMatch.replace('sm-frame-ch-', '') : null;

            // Derive CSS frame type (the normalised type stored in the class)
            const typeMatch = Array.from(row.classList).find(
                c => c.startsWith('sm-frame-') && !c.startsWith('sm-frame-ch-') && c !== 'sm-frame'
            );
            const rowType = typeMatch ? typeMatch.replace('sm-frame-', '') : null;

            const chOk = this.channelFilter === 'all' || rowCh === this.channelFilter;

            let typeOk = true;
            switch (this.filter) {
                case 'aprs':
                    typeOk = rowType === 'aprs';
                    break;
                case 'ui':
                    typeOk = rowType === 'ui' || rowType === 'aprs';
                    break;
                case 'connected':
                    typeOk = CONNECTED_CSS.has(rowType);
                    break;
                case 'netrom':
                    typeOk = rowType === 'netrom' || rowType === 'nodes';
                    break;
                case 'control':
                    typeOk = CONTROL_CSS.has(rowType);
                    break;
                case 'ip':
                    typeOk = rowType === 'ip' || rowType === 'arp';
                    break;
                default:
                    typeOk = true; // 'all'
            }

            // Sender dropdown filter — exact match on data-from attribute
            let callsignOk = true;
            if (this._callsignFilter) {
                callsignOk = (row.dataset.from || '').toLowerCase() === this._callsignFilter.toLowerCase();
            }

            // Destination dropdown filter — exact match on data-to attribute
            let destOk = true;
            if (this._destFilter) {
                destOk = (row.dataset.to || '').toLowerCase() === this._destFilter.toLowerCase();
            }

            // Text search — match against the full text content of the row
            let searchOk = true;
            if (this.searchText) {
                const rowText = row.textContent.toLowerCase();
                searchOk = rowText.includes(this.searchText);
            }

            row.style.display = (chOk && typeOk && callsignOk && destOk && searchOk) ? '' : 'none';
        });
    }

    _updateCountDisplay() {
        const el = document.getElementById('sm-frame-count');
        if (el) el.textContent = this.frameCount;
    }

    _updateCallsignDropdown() {
        const sel = document.getElementById('sm-callsign-filter-select');
        if (!sel) return;
        const current = this._callsignFilter;
        // Rebuild options: "Sender" placeholder + sorted list
        sel.innerHTML = '<option value="">Sender</option>';
        const sorted = Array.from(this._seenCallsigns).sort();
        sorted.forEach(call => {
            const opt = document.createElement('option');
            opt.value = call;
            opt.textContent = call;
            if (call === current) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    _updateDestDropdown() {
        const sel = document.getElementById('sm-dest-filter-select');
        if (!sel) return;
        const current = this._destFilter;
        sel.innerHTML = '<option value="">Destination</option>';
        const sorted = Array.from(this._seenDests).sort();
        sorted.forEach(dest => {
            const opt = document.createElement('option');
            opt.value = dest;
            opt.textContent = dest;
            if (dest === current) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // ── Last-frame "time ago" display ─────────────────────────────────────────

    _formatAgo(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)  return `${s}s`;
        const m = Math.floor(s / 60);
        const r = s % 60;
        if (m < 60)  return r > 0 ? `${m}m${r}s` : `${m}m`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return rm > 0 ? `${h}h${rm}m` : `${h}h`;
    }

    _updateAgoDisplay() {
        const el = document.getElementById('sm-last-ago');
        if (!el) return;
        if (!this._lastFrameTime) { el.textContent = ''; return; }
        el.textContent = this._formatAgo(Date.now() - this._lastFrameTime);
    }

    _startAgoTimer() {
        if (this._agoTimer) return;
        this._agoTimer = setInterval(() => this._updateAgoDisplay(), 1000);
    }

    _stopAgoTimer() {
        if (this._agoTimer) { clearInterval(this._agoTimer); this._agoTimer = null; }
        const el = document.getElementById('sm-last-ago');
        if (el) el.textContent = '';
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
        if (list) {
            list.innerHTML = '';
            // Restore placeholder — text depends on whether decoder is running
            const empty = document.createElement('div');
            empty.className = 'sm-frame-empty';
            empty.id = 'sm-frame-empty';
            empty.textContent = this.running
                ? 'Waiting for first frame…'
                : 'Configure at least one channel and press Start…';
            list.appendChild(empty);
        }
        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = '---';
        this._lastFrameTime = null;
        this._stopAgoTimer();
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
