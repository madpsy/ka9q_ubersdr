// MIDI Control Extension for UberSDR
// Allows mapping USB MIDI controllers (DJ controllers, knob boxes, etc.)
// to radio functions using the Web MIDI API — no server required.

const MIDI_STORAGE_KEY_MAPPINGS = 'ubersdr_midi_mappings';
const MIDI_STORAGE_KEY_DEVICE   = 'ubersdr_midi_device';
const MIDI_STORAGE_KEY_STEP     = 'ubersdr_midi_step_hz';

// All mappable functions, grouped for the learn-mode dropdown
const MIDI_FUNCTIONS = [
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
    { group: 'Audio',      value: 'volume_set',     label: 'Volume (fader/knob 0–100%)' },
    { group: 'Audio',      value: 'bw_low',         label: 'Bandwidth Low Edge (fader)' },
    { group: 'Audio',      value: 'bw_high',        label: 'Bandwidth High Edge (fader)' },
    { group: 'Audio',      value: 'mute_toggle',    label: 'Mute Toggle' },
    { group: 'Audio',      value: 'nr2_toggle',     label: 'NR2 Noise Reduction Toggle' },
    { group: 'Audio',      value: 'nb_toggle',      label: 'Noise Blanker Toggle' },
];

// Band frequencies (FT8/digital centre frequencies)
const MIDI_BAND_FREQS = {
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

const MIDI_MODE_CYCLE = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];

class MIDIControlExtension extends DecoderExtension {
    constructor() {
        super('midi-control', {
            displayName: 'MIDI Control',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        // MIDI state
        this.midiAccess    = null;
        this.selectedInput = null;
        this.isConnected   = false;
        this.deviceId      = null;
        this.deviceName    = null;

        // Mappings: { "type:channel:data1": { function, throttleMs, mode } }
        this.mappings = {};

        // Learn mode state machine
        // States: 'idle' | 'waiting_function' | 'waiting_midi' | 'waiting_release'
        this.learnState    = 'idle';
        this.learnFunction = null;
        this.learnMapBoth  = false;
        this.learnPressKey = null;

        // Throttle tracking: { key: lastExecutionTimestamp }
        this.lastExecution = {};

        // Step size for step-up/step-down buttons (Hz)
        this.stepHz = 1000;

        // Expose instance for inline event handlers in template
        window._midiControlExt = this;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    onInitialize() {
        this.radio.log('MIDI Control Extension initialized');
        this.renderUI();
    }

    onEnable() {
        this.radio.log('MIDI Control Extension enabled');

        // Load persisted state
        this.loadMappings();
        this.stepHz = parseInt(localStorage.getItem(MIDI_STORAGE_KEY_STEP) || '1000', 10);

        // Set up UI event listeners now that template is in DOM
        this._setupEventListeners();
        this._updateMappingsTable();
        this._updateStepSizeUI();

        // Check Web MIDI API availability.
        // NOTE: Firefox defines navigator.requestMIDIAccess but always rejects it,
        // so we cannot use a simple existence check — we must attempt the call.
        if (typeof navigator.requestMIDIAccess !== 'function') {
            this._showAPIError();
            return;
        }

        // Request MIDI access and populate device list
        navigator.requestMIDIAccess({ sysex: false }).then(access => {
            this.midiAccess = access;
            this._populateDeviceList();

            // Handle hot-plug events
            access.onstatechange = () => this._populateDeviceList();

            // Auto-reconnect to last used device
            const lastDevice = localStorage.getItem(MIDI_STORAGE_KEY_DEVICE);
            if (lastDevice) {
                for (const [id, input] of access.inputs) {
                    if (input.name === lastDevice) {
                        this._connectDevice(id, input.name);
                        break;
                    }
                }
            }
        }).catch(err => {
            // Firefox rejects with SecurityError/NotSupportedError — show the API error box
            this._showAPIError();
            this._addMessage(`MIDI access denied: ${err.message}`, 'error');
        });
    }

    onDisable() {
        this.radio.log('MIDI Control Extension disabled');
        if (this.selectedInput) {
            this.selectedInput.onmidimessage = null;
        }
        this.isConnected  = false;
        this.selectedInput = null;
        this.learnState   = 'idle';
    }

    onProcessAudio() {
        // Not used
    }

    // ── UI Rendering ───────────────────────────────────────────────────────────

    renderUI() {
        const template = window.midi_control_template;
        if (!template) {
            console.error('MIDI Control: template not loaded');
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
        const el = document.getElementById('midi-api-error');
        if (el) el.style.display = 'block';
        this._addMessage('Web MIDI API not available — Chrome or Edge required', 'error');
    }

    // ── Event Listeners ────────────────────────────────────────────────────────

    _setupEventListeners() {
        // Device refresh button
        const refreshBtn = document.getElementById('midi-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this._populateDeviceList());
        }

        // Device connect button
        const connectBtn = document.getElementById('midi-connect-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', () => {
                const select = document.getElementById('midi-device-select');
                if (select && select.value) {
                    const [id, name] = select.value.split('|||');
                    this._connectDevice(id, name);
                }
            });
        }

        // Device disconnect button
        const disconnectBtn = document.getElementById('midi-disconnect-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => this._disconnectDevice());
        }

        // Learn mode — start button
        const learnBtn = document.getElementById('midi-learn-btn');
        if (learnBtn) {
            learnBtn.addEventListener('click', () => this.startLearn());
        }

        // Learn mode — cancel button
        const cancelBtn = document.getElementById('midi-learn-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.cancelLearn());
        }

        // Learn mode — function dropdown
        const fnSelect = document.getElementById('midi-learn-function');
        if (fnSelect) {
            fnSelect.addEventListener('change', () => {
                if (fnSelect.value) {
                    this.onFunctionSelected(fnSelect.value);
                }
            });
        }

        // Learn mode — map-both checkbox (no action needed, read on use)

        // Clear all mappings button
        const clearBtn = document.getElementById('midi-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('Clear all MIDI mappings?')) {
                    this.clearMappings();
                }
            });
        }

        // Step size selector
        const stepSelect = document.getElementById('midi-step-size');
        if (stepSelect) {
            stepSelect.addEventListener('change', () => {
                this.stepHz = parseInt(stepSelect.value, 10);
                localStorage.setItem(MIDI_STORAGE_KEY_STEP, this.stepHz.toString());
                this._addMessage(`Step size set to ${this._formatHz(this.stepHz)}`, 'info');
            });
        }
    }

    // ── Device Management ──────────────────────────────────────────────────────

    _populateDeviceList() {
        const select = document.getElementById('midi-device-select');
        if (!select || !this.midiAccess) return;

        const currentVal = select.value;
        select.innerHTML = '<option value="">— Select MIDI Device —</option>';

        let count = 0;
        for (const [id, input] of this.midiAccess.inputs) {
            const option = document.createElement('option');
            option.value = `${id}|||${input.name}`;
            option.textContent = input.name;
            select.appendChild(option);
            count++;
        }

        if (count === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(no MIDI devices found)';
            opt.disabled = true;
            select.appendChild(opt);
        }

        // Restore selection if still available
        if (currentVal) {
            select.value = currentVal;
        }

        // If connected, show current device as selected
        if (this.isConnected && this.deviceId) {
            select.value = `${this.deviceId}|||${this.deviceName}`;
        }

        const connectBtn = document.getElementById('midi-connect-btn');
        if (connectBtn) connectBtn.disabled = count === 0;
    }

    _connectDevice(id, name) {
        if (!this.midiAccess) return;

        // Disconnect existing
        if (this.selectedInput) {
            this.selectedInput.onmidimessage = null;
        }

        const input = this.midiAccess.inputs.get(id);
        if (!input) {
            this._addMessage(`Device not found: ${name}`, 'error');
            return;
        }

        this.selectedInput = input;
        this.selectedInput.onmidimessage = (msg) => this._onMIDIMessage(msg);
        this.isConnected = true;
        this.deviceId    = id;
        this.deviceName  = name;

        // Persist device name for auto-reconnect
        localStorage.setItem(MIDI_STORAGE_KEY_DEVICE, name);

        this._updateConnectionUI(true);
        this._addMessage(`Connected: ${name}`, 'success');
    }

    _disconnectDevice() {
        if (this.selectedInput) {
            this.selectedInput.onmidimessage = null;
            this.selectedInput = null;
        }
        this.isConnected = false;
        this.deviceId    = null;
        this.deviceName  = null;
        this.learnState  = 'idle';
        this._updateLearnUI();
        this._updateConnectionUI(false);
        this._addMessage('Disconnected', 'info');
    }

    _updateConnectionUI(connected) {
        const statusBadge  = document.getElementById('midi-status-badge');
        const deviceLabel  = document.getElementById('midi-device-label');
        const connectBtn   = document.getElementById('midi-connect-btn');
        const disconnectBtn = document.getElementById('midi-disconnect-btn');
        const learnSection = document.getElementById('midi-learn-section');
        const select       = document.getElementById('midi-device-select');

        if (statusBadge) {
            statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
            statusBadge.className   = connected
                ? 'midi-status-badge midi-status-connected'
                : 'midi-status-badge midi-status-disconnected';
        }
        if (deviceLabel) {
            deviceLabel.textContent = connected ? (this.deviceName || '—') : '—';
        }
        if (connectBtn)    connectBtn.style.display    = connected ? 'none'         : 'inline-block';
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'inline-block' : 'none';
        if (learnSection)  learnSection.style.display  = connected ? 'block'        : 'none';
        if (select)        select.disabled             = connected;
    }

    // ── MIDI Message Handling ──────────────────────────────────────────────────

    _onMIDIMessage(msg) {
        if (!msg.data || msg.data.length < 2) return;

        const [status, data1, data2 = 0] = msg.data;
        const type    = status & 0xF0;
        const channel = status & 0x0F;

        const isNoteOn  = (type === 0x90 && data2 > 0);
        const isNoteOff = (type === 0x80) || (type === 0x90 && data2 === 0);
        const isCC      = (type === 0xB0);

        const key = `${type}:${channel}:${data1}`;

        // ── Learn mode ───────────────────────────────────────────────────────
        if (this.learnState === 'waiting_midi') {
            if (isNoteOff) return; // ignore releases while waiting for press

            if (this.learnMapBoth && isNoteOn) {
                // Capture press, wait for release
                this.learnPressKey = key;
                this.learnState    = 'waiting_release';
                this._updateLearnUI('Press captured! Now release the button...');
                return;
            }

            // Single mapping (CC, or Note On without mapBoth)
            this._completeLearn(key);
            return;
        }

        if (this.learnState === 'waiting_release') {
            if (isNoteOff) {
                // Use Note Off type (0x80) for the release key
                const releaseKey = `${0x80}:${channel}:${data1}`;
                this._completeLearnBoth(this.learnPressKey, releaseKey);
            }
            return;
        }

        // ── Normal operation ─────────────────────────────────────────────────
        // Note Off: only execute if there's an explicit Note Off mapping
        if (isNoteOff) {
            const offKey = `${0x80}:${channel}:${data1}`;
            if (this.mappings[offKey]) {
                this._maybeExecute(offKey, data2);
            }
            return;
        }

        if (this.mappings[key]) {
            this._maybeExecute(key, data2);
        }
    }

    // ── Learn Mode ─────────────────────────────────────────────────────────────

    startLearn() {
        if (!this.isConnected) {
            this._addMessage('Connect a MIDI device first', 'warning');
            return;
        }
        this.learnState    = 'waiting_function';
        this.learnFunction = null;
        this.learnPressKey = null;

        // Reset function dropdown
        const fnSelect = document.getElementById('midi-learn-function');
        if (fnSelect) fnSelect.value = '';

        const mapBothCheck = document.getElementById('midi-learn-map-both');
        if (mapBothCheck) mapBothCheck.checked = false;

        this._updateLearnUI('Select a function above, then move or press a control on your MIDI device...');
    }

    onFunctionSelected(fn) {
        if (this.learnState !== 'waiting_function') return;
        this.learnFunction = fn;
        this.learnState    = 'waiting_midi';

        const mapBothCheck = document.getElementById('midi-learn-map-both');
        this.learnMapBoth  = mapBothCheck ? mapBothCheck.checked : false;

        this._updateLearnUI('Move or press a control on your MIDI device...');
    }

    cancelLearn() {
        this.learnState    = 'idle';
        this.learnFunction = null;
        this.learnPressKey = null;
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

        const label = this._formatKey(key);
        this._updateLearnUI(`✅ Mapped: ${label} → ${this._fnLabel(fn)}`);
        this._addMessage(`Mapped ${label} → ${this._fnLabel(fn)}`, 'success');

        setTimeout(() => this.cancelLearn(), 1500);
    }

    _completeLearnBoth(pressKey, releaseKey) {
        const fn     = this.learnFunction;
        const params = { throttleMs: 0, mode: 'none' };

        this.mappings[pressKey]   = { function: fn, ...params };
        this.mappings[releaseKey] = { function: fn, ...params };
        this.saveMappings();
        this._updateMappingsTable();

        const pressLabel   = this._formatKey(pressKey);
        const releaseLabel = this._formatKey(releaseKey);
        this._updateLearnUI(`✅ Mapped press + release → ${this._fnLabel(fn)}`);
        this._addMessage(`Mapped ${pressLabel} + ${releaseLabel} → ${this._fnLabel(fn)}`, 'success');

        setTimeout(() => this.cancelLearn(), 1500);
    }

    _updateLearnUI(message = '') {
        const panel      = document.getElementById('midi-learn-panel');
        const msg        = document.getElementById('midi-learn-message');
        const learnBtn   = document.getElementById('midi-learn-btn');
        const cancelBtn  = document.getElementById('midi-learn-cancel-btn');
        const fnSelect   = document.getElementById('midi-learn-function');
        const mapBothRow = document.getElementById('midi-learn-map-both-row');

        const active = this.learnState !== 'idle';

        if (panel)      panel.style.display      = active ? 'block'        : 'none';
        if (learnBtn)   learnBtn.style.display   = active ? 'none'         : 'inline-block';
        if (cancelBtn)  cancelBtn.style.display  = active ? 'inline-block' : 'none';
        if (msg)        msg.textContent          = message;

        // Show function select and map-both only when waiting for function selection
        const showFnSelect = (this.learnState === 'waiting_function' || this.learnState === 'waiting_midi');
        if (fnSelect)   fnSelect.style.display   = showFnSelect ? 'block' : 'none';
        if (mapBothRow) mapBothRow.style.display = showFnSelect ? 'flex'  : 'none';

        // Colour the message based on state
        if (msg) {
            if (this.learnState === 'waiting_release') {
                msg.style.color = '#f39c12'; // orange — waiting for release
            } else if (message.startsWith('✅')) {
                msg.style.color = '#27ae60'; // green — success
            } else {
                msg.style.color = '#3498db'; // blue — instruction
            }
        }
    }

    // ── Throttled Execution ────────────────────────────────────────────────────

    _maybeExecute(key, value) {
        const mapping = this.mappings[key];
        if (!mapping) return;

        const { throttleMs, mode } = mapping;

        if (throttleMs > 0 && mode === 'rate_limit') {
            const now  = Date.now();
            const last = this.lastExecution[key] || 0;
            if (now - last < throttleMs) return; // too soon — drop
            this.lastExecution[key] = now;
        }

        this.executeFunction(mapping.function, value);
    }

    // ── Function Execution ─────────────────────────────────────────────────────

    executeFunction(fn, value) {
        try {
            switch (fn) {

                // ── Frequency encoders (relative) ──────────────────────────
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
                    // Relative encoders: 1–63 = CW (increase), 65–127 = CCW (decrease)
                    const delta = value >= 64 ? -stepMap[fn] : stepMap[fn];
                    this.radio.adjustFrequency(delta);
                    break;
                }

                // ── Frequency step buttons ─────────────────────────────────
                case 'freq_step_up':
                    if (value > 0) this.radio.adjustFrequency(this.stepHz);
                    break;
                case 'freq_step_down':
                    if (value > 0) this.radio.adjustFrequency(-this.stepHz);
                    break;

                // ── Mode selection ─────────────────────────────────────────
                case 'mode_usb':  if (value > 0) this.radio.setMode('usb');  break;
                case 'mode_lsb':  if (value > 0) this.radio.setMode('lsb');  break;
                case 'mode_am':   if (value > 0) this.radio.setMode('am');   break;
                case 'mode_fm':   if (value > 0) this.radio.setMode('fm');   break;
                case 'mode_cw':   if (value > 0) this.radio.setMode('cwu'); break;
                case 'mode_next': if (value > 0) this._cycleMode(+1);        break;
                case 'mode_prev': if (value > 0) this._cycleMode(-1);        break;

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
                    if (value > 0) this.radio.setFrequency(MIDI_BAND_FREQS[fn]);
                    break;

                // ── Volume (fader/knob: 0–127 → 0–100%) ───────────────────
                case 'volume_set': {
                    const vol    = Math.round((value / 127) * 100);
                    const slider = document.getElementById('volume');
                    if (slider) {
                        slider.value = vol;
                        slider.dispatchEvent(new Event('input'));
                    }
                    break;
                }

                // ── Bandwidth low edge (fader: maps to slider range) ───────
                case 'bw_low': {
                    const bw        = this.radio.getBandwidth();
                    const lowSlider = document.getElementById('bandwidth-low');
                    if (lowSlider) {
                        const min    = parseInt(lowSlider.min, 10);
                        const max    = parseInt(lowSlider.max, 10);
                        const mapped = Math.round(min + (value / 127) * (max - min));
                        this.radio.setBandwidth(mapped, bw.high);
                    }
                    break;
                }

                // ── Bandwidth high edge (fader: maps to slider range) ──────
                case 'bw_high': {
                    const bw         = this.radio.getBandwidth();
                    const highSlider = document.getElementById('bandwidth-high');
                    if (highSlider) {
                        const min    = parseInt(highSlider.min, 10);
                        const max    = parseInt(highSlider.max, 10);
                        const mapped = Math.round(min + (value / 127) * (max - min));
                        this.radio.setBandwidth(bw.low, mapped);
                    }
                    break;
                }

                // ── Toggles (trigger on press only, value > 0) ────────────
                case 'mute_toggle':
                    if (value > 0) this.radio.toggleMute();
                    break;
                case 'nr2_toggle':
                    if (value > 0 && window.toggleNR2Quick) window.toggleNR2Quick();
                    break;
                case 'nb_toggle':
                    if (value > 0 && window.toggleNBQuick) window.toggleNBQuick();
                    break;

                default:
                    console.warn(`MIDI Control: unknown function "${fn}"`);
            }
        } catch (err) {
            console.error(`MIDI Control: error executing "${fn}":`, err);
            this._addMessage(`Error: ${fn} — ${err.message}`, 'error');
        }
    }

    _cycleMode(direction) {
        const current = this.radio.getMode();
        const idx     = MIDI_MODE_CYCLE.indexOf(current);
        const next    = MIDI_MODE_CYCLE[
            (idx + direction + MIDI_MODE_CYCLE.length) % MIDI_MODE_CYCLE.length
        ];
        this.radio.setMode(next);
    }

    // ── Persistence ────────────────────────────────────────────────────────────

    saveMappings() {
        try {
            localStorage.setItem(MIDI_STORAGE_KEY_MAPPINGS, JSON.stringify(this.mappings));
        } catch (e) {
            console.error('MIDI Control: failed to save mappings', e);
        }
    }

    loadMappings() {
        try {
            const raw = localStorage.getItem(MIDI_STORAGE_KEY_MAPPINGS);
            if (raw) this.mappings = JSON.parse(raw);
        } catch (e) {
            console.error('MIDI Control: failed to load mappings', e);
            this.mappings = {};
        }
    }

    clearMappings() {
        this.mappings = {};
        localStorage.removeItem(MIDI_STORAGE_KEY_MAPPINGS);
        this._updateMappingsTable();
        this._addMessage('All mappings cleared', 'info');
    }

    deleteMapping(key) {
        delete this.mappings[key];
        this.saveMappings();
        this._updateMappingsTable();
        this._addMessage(`Deleted mapping: ${this._formatKey(key)}`, 'info');
    }

    // ── Mappings Table ─────────────────────────────────────────────────────────

    _updateMappingsTable() {
        const tbody = document.getElementById('midi-mappings-tbody');
        if (!tbody) return;

        const entries = Object.entries(this.mappings);

        if (entries.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="midi-empty-row">
                        No mappings yet. Connect a device and use <strong>Learn New Mapping</strong>.
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = entries.map(([key, m]) => {
            const throttleStr = m.throttleMs > 0
                ? `${m.throttleMs}ms ${m.mode}`
                : '—';
            return `
                <tr>
                    <td class="midi-key-cell">${this._formatKey(key)}</td>
                    <td>${this._fnLabel(m.function)}</td>
                    <td class="midi-throttle-cell">${throttleStr}</td>
                    <td>
                        <button class="midi-delete-btn"
                                onclick="window._midiControlExt.deleteMapping('${key.replace(/'/g, "\\'")}')">
                            ✕
                        </button>
                    </td>
                </tr>`;
        }).join('');

        // Update mapping count badge
        const countBadge = document.getElementById('midi-mapping-count');
        if (countBadge) countBadge.textContent = entries.length;
    }
    
    // ── Formatting Helpers ─────────────────────────────────────────────────────

    _formatKey(key) {
        const parts = key.split(':');
        if (parts.length !== 3) return key;
        const type    = parseInt(parts[0], 10);
        const channel = parseInt(parts[1], 10);
        const data1   = parseInt(parts[2], 10);
        const ch      = channel + 1;

        if (type === 0x90) return `Note ${data1} (Ch ${ch})`;
        if (type === 0x80) return `Note Off ${data1} (Ch ${ch})`;
        if (type === 0xB0) return `CC ${data1} (Ch ${ch})`;
        return `Type 0x${type.toString(16).toUpperCase()} Data ${data1} (Ch ${ch})`;
    }

    _fnLabel(fn) {
        const entry = MIDI_FUNCTIONS.find(f => f.value === fn);
        return entry ? `${entry.group}: ${entry.label}` : fn;
    }

    _formatHz(hz) {
        if (hz >= 1000) return `${hz / 1000} kHz`;
        return `${hz} Hz`;
    }

    _updateStepSizeUI() {
        const stepSelect = document.getElementById('midi-step-size');
        if (stepSelect) stepSelect.value = this.stepHz.toString();
    }

    // ── Message Log ────────────────────────────────────────────────────────────

    _addMessage(message, type = 'info') {
        const log = document.getElementById('midi-message-log');
        if (!log) return;

        const timestamp = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.className = `midi-log-entry midi-log-${type}`;
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
    window.decoderManager.register(new MIDIControlExtension());
    console.log('✅ MIDI Control Extension registered');
}
