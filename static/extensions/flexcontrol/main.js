// FlexControl Extension for UberSDR
//
// Supports the FlexRadio Systems FlexControl USB dial controller.
// USB Serial device: Vendor ID 0x2192, Product ID 0x0010
// Uses the Web Serial API — Chrome / Edge only, no server required.
//
// Protocol (9600 baud, 8N1, no CR/LF, semicolon-delimited tokens):
//   Dial anticlockwise : D  D02 D03 D04 D05 D06  (velocity 1–6)
//   Dial clockwise     : U  U02 U03 U04 U05 U06  (velocity 1–6)
//   AUX1 single tap    : X1S
//   AUX1 double tap    : X1C
//   AUX1 long press    : X1L  (fires on release)
//   AUX2 single tap    : X2S
//   AUX2 double tap    : X2C
//   AUX2 long press    : X2L
//   AUX3 single tap    : X3S
//   AUX3 double tap    : X3C
//   AUX3 long press    : X3L
//   Reset / startup    : F0304  (ignored)
//
// Example stream: D;D;D;U;U02;U03;U04;U03;U05;U04;U05;U05;U06;

const FC_STORAGE_KEY_MAPPINGS = 'ubersdr_flexcontrol_mappings';
const FC_STORAGE_KEY_STEP     = 'ubersdr_flexcontrol_step_hz';

// USB identifiers for the FlexRadio Systems FlexControl
const FC_USB_VENDOR_ID  = 0x2192;
const FC_USB_PRODUCT_ID = 0x0010;

// Normalised input keys (what gets stored in mappings)
const FC_KEYS = [
    { key: 'dial_down', label: 'Dial — Anticlockwise' },
    { key: 'dial_up',   label: 'Dial — Clockwise' },
    { key: 'aux1_tap',  label: 'AUX 1 — Single Tap' },
    { key: 'aux1_dbl',  label: 'AUX 1 — Double Tap' },
    { key: 'aux1_hold', label: 'AUX 1 — Long Press' },
    { key: 'aux2_tap',  label: 'AUX 2 — Single Tap' },
    { key: 'aux2_dbl',  label: 'AUX 2 — Double Tap' },
    { key: 'aux2_hold', label: 'AUX 2 — Long Press' },
    { key: 'aux3_tap',  label: 'AUX 3 — Single Tap' },
    { key: 'aux3_dbl',  label: 'AUX 3 — Double Tap' },
    { key: 'aux3_hold', label: 'AUX 3 — Long Press' },
];

// All mappable functions — identical set to the MIDI Control extension
const FC_FUNCTIONS = [
    { group: 'Frequency',  value: 'freq_enc_10',    label: 'Encoder (10 Hz steps)' },
    { group: 'Frequency',  value: 'freq_enc_100',   label: 'Encoder (100 Hz steps)' },
    { group: 'Frequency',  value: 'freq_enc_500',   label: 'Encoder (500 Hz steps)' },
    { group: 'Frequency',  value: 'freq_enc_1k',    label: 'Encoder (1 kHz steps)' },
    { group: 'Frequency',  value: 'freq_enc_10k',   label: 'Encoder (10 kHz steps)' },
    { group: 'Frequency',  value: 'freq_step_up',   label: 'Step Up' },
    { group: 'Frequency',  value: 'freq_step_down', label: 'Step Down' },
    { group: 'Mode',       value: 'mode_usb',       label: 'USB' },
    { group: 'Mode',       value: 'mode_lsb',       label: 'LSB' },
    { group: 'Mode',       value: 'mode_am',        label: 'AM' },
    { group: 'Mode',       value: 'mode_fm',        label: 'FM' },
    { group: 'Mode',       value: 'mode_cw',        label: 'CW' },
    { group: 'Mode',       value: 'mode_next',      label: 'Next Mode (cycle)' },
    { group: 'Mode',       value: 'mode_prev',      label: 'Previous Mode (cycle)' },
    { group: 'Band',       value: 'band_160m',      label: '160m (1.9 MHz)' },
    { group: 'Band',       value: 'band_80m',       label: '80m (3.573 MHz)' },
    { group: 'Band',       value: 'band_60m',       label: '60m (5.357 MHz)' },
    { group: 'Band',       value: 'band_40m',       label: '40m (7.074 MHz)' },
    { group: 'Band',       value: 'band_30m',       label: '30m (10.136 MHz)' },
    { group: 'Band',       value: 'band_20m',       label: '20m (14.074 MHz)' },
    { group: 'Band',       value: 'band_17m',       label: '17m (18.1 MHz)' },
    { group: 'Band',       value: 'band_15m',       label: '15m (21.074 MHz)' },
    { group: 'Band',       value: 'band_12m',       label: '12m (24.915 MHz)' },
    { group: 'Band',       value: 'band_10m',       label: '10m (28.074 MHz)' },
    { group: 'Audio',      value: 'volume_set',     label: 'Volume (dial increments)' },
    { group: 'Audio',      value: 'bw_low',         label: 'Bandwidth Low Edge' },
    { group: 'Audio',      value: 'bw_high',        label: 'Bandwidth High Edge' },
    { group: 'Audio',      value: 'mute_toggle',    label: 'Mute Toggle' },
    { group: 'Audio',      value: 'nr2_toggle',     label: 'NR2 Noise Reduction Toggle' },
    { group: 'Audio',      value: 'nb_toggle',      label: 'Noise Blanker Toggle' },
    { group: 'VFO',        value: 'vfo_ab_toggle',  label: 'Toggle VFO A/B' },
];

const FC_BAND_FREQS = {
    band_160m: 1900000,
    band_80m:  3573000,
    band_60m:  5357000,
    band_40m:  7074000,
    band_30m:  10136000,
    band_20m:  14074000,
    band_17m:  18100000,
    band_15m:  21074000,
    band_12m:  24915000,
    band_10m:  28074000,
};

const FC_MODE_CYCLE = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];

// Parse a raw token string into { key, velocity } where velocity is signed:
//   positive = clockwise / button press
//   negative = anticlockwise
// Returns null for tokens that should be ignored (e.g. F0304 reset).
function parseFlexToken(token) {
    if (!token) return null;

    // Dial anticlockwise: D  or  D02..D09
    if (token === 'D') return { key: 'dial_down', velocity: -1 };
    if (/^D0[2-9]$/.test(token)) return { key: 'dial_down', velocity: -parseInt(token.slice(1), 10) };

    // Dial clockwise: U  or  U02..U09
    if (token === 'U') return { key: 'dial_up', velocity: 1 };
    if (/^U0[2-9]$/.test(token)) return { key: 'dial_up', velocity: parseInt(token.slice(1), 10) };

    // AUX buttons
    const auxMap = {
        X1S: 'aux1_tap',  X1C: 'aux1_dbl',  X1L: 'aux1_hold',
        X2S: 'aux2_tap',  X2C: 'aux2_dbl',  X2L: 'aux2_hold',
        X3S: 'aux3_tap',  X3C: 'aux3_dbl',  X3L: 'aux3_hold',
    };
    if (auxMap[token]) return { key: auxMap[token], velocity: 1 };

    // Reset / startup tokens (e.g. F0304) — ignore silently
    if (/^F[0-9A-Fa-f]+$/.test(token)) return null;

    return null; // unknown token
}

class FlexControlExtension extends DecoderExtension {
    constructor() {
        super('flexcontrol', {
            displayName: 'FlexControl',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        // Serial port state
        this.port            = null;
        this.reader          = null;
        this.readLoopRunning = false;
        this.isConnected     = false;

        // Mappings: { "dial_down": { function, throttleMs, mode }, ... }
        this.mappings = {};

        // Learn mode state machine
        // States: 'idle' | 'waiting_function' | 'waiting_input'
        this.learnState    = 'idle';
        this.learnFunction = null;

        // Throttle tracking: { key: lastExecutionTimestamp }
        this.lastExecution = {};

        // Step size for step-up/step-down buttons (Hz)
        this.stepHz = 1000;

        // Volume accumulator for dial-driven volume control (0–100)
        this._volumeLevel = 50;

        // Expose instance for inline event handlers in template
        window._flexControlExt = this;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    onInitialize() {
        this.radio.log('FlexControl Extension initialized');
        this.renderUI();
    }

    onEnable() {
        this.radio.log('FlexControl Extension enabled');

        this.loadMappings();
        this.stepHz = parseInt(localStorage.getItem(FC_STORAGE_KEY_STEP) || '1000', 10);

        this._setupEventListeners();
        this._updateMappingsTable();
        this._updateStepSizeUI();

        if (typeof navigator.serial === 'undefined') {
            this._showAPIError();
            return;
        }

        // Listen for port disconnect events
        navigator.serial.addEventListener('disconnect', (e) => {
            if (this.port && e.target === this.port) {
                this._handleDisconnect();
            }
        });
    }

    onDisable() {
        this.radio.log('FlexControl Extension disabled');
        this._stopReadLoop();
        this.learnState = 'idle';
    }

    onProcessAudio() {
        // Not used — FlexControl is a control device, not an audio decoder
    }

    // ── UI Rendering ───────────────────────────────────────────────────────────

    renderUI() {
        const template = window.flexcontrol_template;
        if (!template) {
            console.error('FlexControl: template not loaded');
            return;
        }
        const container = this.getContentElement();
        if (container) {
            container.innerHTML = template;
        }
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        return panel ? panel.querySelector('.decoder-extension-content') : null;
    }

    _showAPIError() {
        const el = document.getElementById('fc-api-error');
        if (el) el.style.display = 'block';
        this._addMessage('Web Serial API not available — Chrome or Edge required', 'error');
    }

    // ── Event Listeners ────────────────────────────────────────────────────────

    _setupEventListeners() {
        const connectBtn = document.getElementById('fc-connect-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', () => this._requestPort());
        }

        const disconnectBtn = document.getElementById('fc-disconnect-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => this._disconnect());
        }

        const learnBtn = document.getElementById('fc-learn-btn');
        if (learnBtn) {
            learnBtn.addEventListener('click', () => this.startLearn());
        }

        const cancelBtn = document.getElementById('fc-learn-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.cancelLearn());
        }

        const fnSelect = document.getElementById('fc-learn-function');
        if (fnSelect) {
            fnSelect.addEventListener('change', () => {
                if (fnSelect.value) {
                    this.onFunctionSelected(fnSelect.value);
                }
            });
        }

        const clearBtn = document.getElementById('fc-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('Clear all FlexControl mappings?')) {
                    this.clearMappings();
                }
            });
        }

        const stepSelect = document.getElementById('fc-step-size');
        if (stepSelect) {
            stepSelect.addEventListener('change', () => {
                this.stepHz = parseInt(stepSelect.value, 10);
                localStorage.setItem(FC_STORAGE_KEY_STEP, this.stepHz.toString());
                // Update the dial mappings to match the new step size
                this._applyDialStepSize(this.stepHz);
                this._addMessage(`Dial step size set to ${this._formatHz(this.stepHz)}`, 'info');
            });
        }

        // Export mappings button
        const exportBtn = document.getElementById('fc-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportMappings());
        }

        // Import mappings button + hidden file input
        const importBtn  = document.getElementById('fc-import-btn');
        const importFile = document.getElementById('fc-import-file');
        if (importBtn && importFile) {
            importBtn.addEventListener('click', () => importFile.click());
            importFile.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) {
                    this.importMappings(e.target.files[0]);
                    e.target.value = ''; // reset so same file can be re-imported
                }
            });
        }
    }

    // ── Serial Port Management ─────────────────────────────────────────────────

    async _requestPort() {
        if (typeof navigator.serial === 'undefined') {
            this._showAPIError();
            return;
        }

        try {
            // The USB filter pre-selects the FlexControl in the OS port picker
            const port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: FC_USB_VENDOR_ID, usbProductId: FC_USB_PRODUCT_ID }]
            });
            await this._openPort(port);
        } catch (err) {
            if (err.name !== 'NotFoundError') {
                // NotFoundError = user cancelled the picker — not an error
                this._addMessage(`Failed to open port: ${err.message}`, 'error');
            }
        }
    }

    async _openPort(port) {
        try {
            await port.open({ baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
        } catch (err) {
            this._addMessage(`Failed to open serial port: ${err.message}`, 'error');
            return;
        }

        this.port        = port;
        this.isConnected = true;

        this._updateConnectionUI(true);
        this._addMessage('FlexControl connected', 'success');

        this._startReadLoop();
    }

    async _disconnect() {
        await this._stopReadLoop();

        if (this.port) {
            try { await this.port.close(); } catch (_) {}
            this.port = null;
        }

        this.isConnected = false;
        this.learnState  = 'idle';
        this._updateLearnUI();
        this._updateConnectionUI(false);
        this._addMessage('Disconnected', 'info');
    }

    _handleDisconnect() {
        this.isConnected     = false;
        this.port            = null;
        this.reader          = null;
        this.readLoopRunning = false;
        this.learnState      = 'idle';
        this._updateLearnUI();
        this._updateConnectionUI(false);
        this._addMessage('FlexControl disconnected', 'warning');
    }

    _updateConnectionUI(connected) {
        const statusBadge   = document.getElementById('fc-status-badge');
        const connectBtn    = document.getElementById('fc-connect-btn');
        const disconnectBtn = document.getElementById('fc-disconnect-btn');
        const learnSection  = document.getElementById('fc-learn-section');

        if (statusBadge) {
            statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
            statusBadge.className   = connected
                ? 'fc-status-badge fc-status-connected'
                : 'fc-status-badge fc-status-disconnected';
        }
        if (connectBtn)    connectBtn.style.display    = connected ? 'none'         : 'inline-block';
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'inline-block' : 'none';
        if (learnSection)  learnSection.style.display  = connected ? 'block'        : 'none';
    }

    // ── Serial Read Loop ───────────────────────────────────────────────────────

    _startReadLoop() {
        this.readLoopRunning = true;
        this._readLoop().catch(err => {
            if (this.readLoopRunning) {
                this._addMessage(`Read error: ${err.message}`, 'error');
                this._handleDisconnect();
            }
        });
    }

    async _stopReadLoop() {
        this.readLoopRunning = false;
        if (this.reader) {
            try { await this.reader.cancel(); } catch (_) {}
            this.reader = null;
        }
    }

    async _readLoop() {
        const decoder = new TextDecoder();
        let buffer = '';

        while (this.port && this.port.readable && this.readLoopRunning) {
            this.reader = this.port.readable.getReader();
            try {
                while (this.readLoopRunning) {
                    const { value, done } = await this.reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    // Process all complete tokens (delimited by semicolons)
                    let idx;
                    while ((idx = buffer.indexOf(';')) !== -1) {
                        const token = buffer.slice(0, idx).trim();
                        buffer = buffer.slice(idx + 1);
                        if (token) {
                            this._onToken(token);
                        }
                    }
                }
            } finally {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    // ── Token Handling ─────────────────────────────────────────────────────────

    _onToken(rawToken) {
        const parsed = parseFlexToken(rawToken);
        if (!parsed) return; // unknown or ignored token (e.g. F0304 reset)

        const { key, velocity } = parsed;

        // ── Learn mode ───────────────────────────────────────────────────────
        if (this.learnState === 'waiting_input') {
            this._completeLearn(key);
            return;
        }

        // ── Normal operation ─────────────────────────────────────────────────
        const mapping = this.mappings[key];
        if (mapping) {
            this._maybeExecute(key, mapping, velocity);
        }
    }

    // ── Learn Mode ─────────────────────────────────────────────────────────────

    startLearn() {
        if (!this.isConnected) {
            this._addMessage('Connect the FlexControl first', 'warning');
            return;
        }
        this.learnState    = 'waiting_function';
        this.learnFunction = null;

        const fnSelect = document.getElementById('fc-learn-function');
        if (fnSelect) fnSelect.value = '';

        this._updateLearnUI('Select a function above, then turn the dial or press a button on the FlexControl...');
    }

    onFunctionSelected(fn) {
        if (this.learnState !== 'waiting_function') return;
        this.learnFunction = fn;
        this.learnState    = 'waiting_input';
        this._updateLearnUI('Turn the dial or press a button on the FlexControl...');
    }

    cancelLearn() {
        this.learnState    = 'idle';
        this.learnFunction = null;
        this._updateLearnUI();
    }

    _completeLearn(key) {
        const fn = this.learnFunction;

        // Encoder functions get automatic 100ms rate-limit throttle
        const params = fn.startsWith('freq_enc')
            ? { throttleMs: 100, mode: 'rate_limit' }
            : { throttleMs: 0,   mode: 'none' };

        this.mappings[key] = { function: fn, ...params };
        this.saveMappings();
        this._updateMappingsTable();

        const keyLabel = this._keyLabel(key);
        this._updateLearnUI(`✅ Mapped: ${keyLabel} → ${this._fnLabel(fn)}`);
        this._addMessage(`Mapped ${keyLabel} → ${this._fnLabel(fn)}`, 'success');

        setTimeout(() => this.cancelLearn(), 1500);
    }

    _updateLearnUI(message = '') {
        const panel     = document.getElementById('fc-learn-panel');
        const msg       = document.getElementById('fc-learn-message');
        const learnBtn  = document.getElementById('fc-learn-btn');
        const cancelBtn = document.getElementById('fc-learn-cancel-btn');
        const fnSelect  = document.getElementById('fc-learn-function');

        const active = this.learnState !== 'idle';

        if (panel)     panel.style.display     = active ? 'block'        : 'none';
        if (learnBtn)  learnBtn.style.display  = active ? 'none'         : 'inline-block';
        if (cancelBtn) cancelBtn.style.display = active ? 'inline-block' : 'none';
        if (msg)       msg.textContent         = message;

        const showFnSelect = (this.learnState === 'waiting_function' || this.learnState === 'waiting_input');
        if (fnSelect) fnSelect.style.display = showFnSelect ? 'block' : 'none';

        if (msg) {
            if (message.startsWith('✅')) {
                msg.style.color = '#27ae60';
            } else if (this.learnState === 'waiting_input') {
                msg.style.color = '#f39c12';
            } else {
                msg.style.color = '#3498db';
            }
        }
    }

    // ── Throttled Execution ────────────────────────────────────────────────────

    _maybeExecute(key, mapping, velocity) {
        const { throttleMs, mode } = mapping;

        if (throttleMs > 0 && mode === 'rate_limit') {
            const now  = Date.now();
            const last = this.lastExecution[key] || 0;
            if (now - last < throttleMs) return;
            this.lastExecution[key] = now;
        }

        this.executeFunction(mapping.function, velocity);
    }

    // ── Function Execution ─────────────────────────────────────────────────────
    // velocity: signed integer.
    //   dial_up   → positive (1–6)
    //   dial_down → negative (-1 to -6)
    //   buttons   → +1
    // For encoder functions the magnitude provides natural acceleration.

    executeFunction(fn, velocity) {
        try {
            switch (fn) {

                // ── Frequency encoders (relative, velocity-scaled) ─────────
                case 'freq_enc_10':
                case 'freq_enc_100':
                case 'freq_enc_500':
                case 'freq_enc_1k':
                case 'freq_enc_10k': {
                    const stepMap = {
                        freq_enc_10:  10,
                        freq_enc_100: 100,
                        freq_enc_500: 500,
                        freq_enc_1k:  1000,
                        freq_enc_10k: 10000,
                    };
                    // velocity is signed: positive = up, negative = down
                    // magnitude 1–6 gives linear acceleration
                    const delta = stepMap[fn] * velocity;
                    this.radio.adjustFrequency(delta);
                    break;
                }

                // ── Frequency step buttons ─────────────────────────────────
                case 'freq_step_up':
                    this.radio.adjustFrequency(this.stepHz);
                    break;
                case 'freq_step_down':
                    this.radio.adjustFrequency(-this.stepHz);
                    break;

                // ── Mode selection ─────────────────────────────────────────
                case 'mode_usb':  this.radio.setMode('usb');  break;
                case 'mode_lsb':  this.radio.setMode('lsb');  break;
                case 'mode_am':   this.radio.setMode('am');   break;
                case 'mode_fm':   this.radio.setMode('fm');   break;
                case 'mode_cw':   this.radio.setMode('cwu');  break;
                case 'mode_next': this._cycleMode(+1);        break;
                case 'mode_prev': this._cycleMode(-1);        break;

                // ── Band jumps ─────────────────────────────────────────────
                case 'band_160m':
                case 'band_80m':
                case 'band_60m':
                case 'band_40m':
                case 'band_30m':
                case 'band_20m':
                case 'band_17m':
                case 'band_15m':
                case 'band_12m':
                case 'band_10m':
                    this.radio.setFrequency(FC_BAND_FREQS[fn]);
                    break;

                // ── Volume (dial increments/decrements 0–100%) ─────────────
                // velocity is signed so turning the dial adjusts volume up or down.
                case 'volume_set': {
                    this._volumeLevel = Math.max(0, Math.min(100, this._volumeLevel + velocity));
                    const slider = document.getElementById('volume');
                    if (slider) {
                        slider.value = this._volumeLevel;
                        slider.dispatchEvent(new Event('input'));
                    }
                    break;
                }

                // ── Bandwidth low edge ─────────────────────────────────────
                case 'bw_low': {
                    const bw        = this.radio.getBandwidth();
                    const lowSlider = document.getElementById('bandwidth-low');
                    if (lowSlider && bw) {
                        const min   = parseInt(lowSlider.min, 10);
                        const max   = parseInt(lowSlider.max, 10);
                        const range = max - min;
                        // 2% of range per velocity unit
                        const step   = Math.round(range * 0.02 * velocity);
                        const mapped = Math.max(min, Math.min(max, (bw.low || min) + step));
                        this.radio.setBandwidth(mapped, bw.high);
                    }
                    break;
                }

                // ── Bandwidth high edge ────────────────────────────────────
                case 'bw_high': {
                    const bw         = this.radio.getBandwidth();
                    const highSlider = document.getElementById('bandwidth-high');
                    if (highSlider && bw) {
                        const min   = parseInt(highSlider.min, 10);
                        const max   = parseInt(highSlider.max, 10);
                        const range = max - min;
                        const step   = Math.round(range * 0.02 * velocity);
                        const mapped = Math.max(min, Math.min(max, (bw.high || max) + step));
                        this.radio.setBandwidth(bw.low, mapped);
                    }
                    break;
                }

                // ── Toggles (fire on any input) ────────────────────────────
                case 'mute_toggle':
                    this.radio.toggleMute();
                    break;
                case 'nr2_toggle':
                    if (window.toggleNR2Quick) window.toggleNR2Quick();
                    break;
                case 'nb_toggle':
                    if (window.toggleNBQuick) window.toggleNBQuick();
                    break;

                // ── VFO A/B toggle ─────────────────────────────────────────
                case 'vfo_ab_toggle':
                    if (window.toggleVFO) window.toggleVFO();
                    break;

                default:
                    console.warn(`FlexControl: unknown function "${fn}"`);
            }
        } catch (err) {
            console.error(`FlexControl: error executing "${fn}":`, err);
            this._addMessage(`Error: ${fn} — ${err.message}`, 'error');
        }
    }

    _cycleMode(direction) {
        const current = this.radio.getMode();
        const idx     = FC_MODE_CYCLE.indexOf(current);
        const next    = FC_MODE_CYCLE[
            (idx + direction + FC_MODE_CYCLE.length) % FC_MODE_CYCLE.length
        ];
        this.radio.setMode(next);
    }

    // ── Persistence ────────────────────────────────────────────────────────────

    saveMappings() {
        try {
            localStorage.setItem(FC_STORAGE_KEY_MAPPINGS, JSON.stringify(this.mappings));
        } catch (e) {
            console.error('FlexControl: failed to save mappings', e);
        }
    }

    loadMappings() {
        try {
            const raw = localStorage.getItem(FC_STORAGE_KEY_MAPPINGS);
            if (raw) {
                this.mappings = JSON.parse(raw);
            } else {
                // First run — seed default dial mappings so the FlexControl
                // works immediately without any learn-mode setup.
                // Dial clockwise  → frequency up (1 kHz steps, 100ms rate-limit)
                // Dial anticlockwise → frequency down (1 kHz steps, 100ms rate-limit)
                this.mappings = {
                    dial_up:   { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
                    dial_down: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
                };
                this.saveMappings();
            }
        } catch (e) {
            console.error('FlexControl: failed to load mappings', e);
            this.mappings = {
                dial_up:   { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
                dial_down: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
            };
        }
    }

    // Map from step size in Hz to the encoder function name
    _stepHzToEncFn(hz) {
        const map = {
            10:    'freq_enc_10',
            100:   'freq_enc_100',
            500:   'freq_enc_500',
            1000:  'freq_enc_1k',
            10000: 'freq_enc_10k',
        };
        return map[hz] || 'freq_enc_1k';
    }

    // Update both dial mappings to use the encoder matching the given step size,
    // then persist and refresh the table.
    _applyDialStepSize(hz) {
        const fn = this._stepHzToEncFn(hz);
        this.mappings['dial_up']   = { function: fn, throttleMs: 100, mode: 'rate_limit' };
        this.mappings['dial_down'] = { function: fn, throttleMs: 100, mode: 'rate_limit' };
        this.saveMappings();
        this._updateMappingsTable();
    }

    // ── Export / Import ────────────────────────────────────────────────────────

    exportMappings() {
        try {
            const payload = {
                version:  1,
                source:   'flexcontrol',
                exported: new Date().toISOString(),
                mappings: this.mappings,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `flexcontrol-mappings-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this._addMessage(`Exported ${Object.keys(this.mappings).length} mapping(s)`, 'success');
        } catch (err) {
            console.error('FlexControl: export failed', err);
            this._addMessage(`Export failed: ${err.message}`, 'error');
        }
    }

    importMappings(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.mappings || typeof data.mappings !== 'object') {
                    throw new Error('Invalid mappings file — missing "mappings" object');
                }
                if (data.source && data.source !== 'flexcontrol') {
                    if (!confirm(`This file was exported from "${data.source}", not FlexControl. Import anyway?`)) {
                        return;
                    }
                }
                const count = Object.keys(data.mappings).length;
                this.mappings = data.mappings;
                this.saveMappings();
                this._updateMappingsTable();
                this._updateStepSizeUI();
                this._addMessage(`Imported ${count} mapping(s) from ${file.name}`, 'success');
            } catch (err) {
                console.error('FlexControl: import failed', err);
                this._addMessage(`Import failed: ${err.message}`, 'error');
            }
        };
        reader.readAsText(file);
    }

    clearMappings() {
        this.mappings = {};
        localStorage.removeItem(FC_STORAGE_KEY_MAPPINGS);
        this._updateMappingsTable();
        this._addMessage('All mappings cleared', 'info');
    }

    deleteMapping(key) {
        delete this.mappings[key];
        this.saveMappings();
        this._updateMappingsTable();
        this._addMessage(`Deleted mapping: ${this._keyLabel(key)}`, 'info');
    }

    // ── Mappings Table ────────────────────────────────────────────────────────

    _updateMappingsTable() {
        const tbody = document.getElementById('fc-mappings-tbody');
        if (!tbody) return;

        const entries = Object.entries(this.mappings);

        if (entries.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="fc-empty-row">
                        No mappings yet. Connect the FlexControl and use <strong>Learn New Mapping</strong>.
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = entries.map(([key, m]) => {
            const throttleStr = m.throttleMs > 0
                ? `${m.throttleMs}ms ${m.mode}`
                : '—';
            const safeKey = key.replace(/'/g, "\\'");
            return `
                <tr>
                    <td class="fc-key-cell">${this._keyLabel(key)}</td>
                    <td>${this._fnLabel(m.function)}</td>
                    <td class="fc-throttle-cell">${throttleStr}</td>
                    <td>
                        <button class="fc-delete-btn"
                                onclick="window._flexControlExt.deleteMapping('${safeKey}')">
                            ✕
                        </button>
                    </td>
                </tr>`;
        }).join('');

        const countBadge = document.getElementById('fc-mapping-count');
        if (countBadge) countBadge.textContent = entries.length;
    }

    // ── Formatting Helpers ─────────────────────────────────────────────────────

    _keyLabel(key) {
        const entry = FC_KEYS.find(k => k.key === key);
        return entry ? entry.label : key;
    }

    _fnLabel(fn) {
        const entry = FC_FUNCTIONS.find(f => f.value === fn);
        return entry ? `${entry.group}: ${entry.label}` : fn;
    }

    _formatHz(hz) {
        if (hz >= 1000) return `${hz / 1000} kHz`;
        return `${hz} Hz`;
    }

    _updateStepSizeUI() {
        const stepSelect = document.getElementById('fc-step-size');
        if (!stepSelect) return;

        // If a dial mapping already exists, infer the step size from it
        // so the dropdown reflects the current state on reload.
        const dialFn = this.mappings['dial_up']?.function || this.mappings['dial_down']?.function;
        if (dialFn) {
            const fnToHz = {
                freq_enc_10:  10,
                freq_enc_100: 100,
                freq_enc_500: 500,
                freq_enc_1k:  1000,
                freq_enc_10k: 10000,
            };
            const inferredHz = fnToHz[dialFn];
            if (inferredHz) {
                this.stepHz = inferredHz;
                localStorage.setItem(FC_STORAGE_KEY_STEP, this.stepHz.toString());
            }
        }

        stepSelect.value = this.stepHz.toString();
    }

    // ── Message Log ────────────────────────────────────────────────────────────

    _addMessage(message, type = 'info') {
        const log = document.getElementById('fc-message-log');
        if (!log) return;

        const timestamp = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.className = `fc-log-entry fc-log-${type}`;
        div.textContent = `[${timestamp}] ${message}`;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;

        // Keep only last 200 messages
        while (log.children.length > 200) {
            log.removeChild(log.firstChild);
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new FlexControlExtension());
    console.log('✅ FlexControl Extension registered');
}