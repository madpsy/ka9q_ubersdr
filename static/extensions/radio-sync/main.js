// Radio Sync Extension - Synchronize with external radios via Hamlib (WebAssembly)
// Displays frequency, mode, and TX/RX state with LED-style indicators
//
// Backed by Hamlib compiled to WebAssembly (see Hamlib/wasm/ in the Hamlib repo),
// served from /hamlib/ on this instance. Talks to real hardware over the Web
// Serial API via Hamlib's own rig backends instead of a hand-written per-radio
// protocol parser, so every serial-capable rig Hamlib supports works here.

const HAMLIB_BASE_URL = '/hamlib';

// ubersdr's SDR-facing mode names (see static/extensions/README.md's Radio API)
// vs. Hamlib's canonical rig_strrmode()/rig_parse_mode() names (RIG_MODE_* in
// include/hamlib/rig.h). One table, shared by both sync directions - replaces
// the separate modeMap/reverseModeMap that used to live in each protocol file.
const SDR_TO_HAMLIB_MODE = {
    usb: 'USB', lsb: 'LSB', cwu: 'CW', cwl: 'CWR',
    am: 'AM', sam: 'SAM', fm: 'FM', nfm: 'FMN',
};
const HAMLIB_TO_SDR_MODE = Object.fromEntries(
    Object.entries(SDR_TO_HAMLIB_MODE).map(([sdr, hamlib]) => [hamlib, sdr])
);

class RadioSyncExtension extends DecoderExtension {
    constructor() {
        super('radio-sync', {
            displayName: 'Radio Sync',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        // Hamlib wasm module state
        this.hamlibModule = null;
        this.hamlibLoadPromise = null;
        this.rigHandle = 0;
        this.isConnected = false;

        this.selectedRadio = null;
        this.selectedBaudRate = null; // Will be set when radio is selected
        this.syncMode = 'both'; // 'sdr-to-radio', 'radio-to-sdr', 'both'
        // Display style cycling (starting with modern digital)
        this.displayStyles = ['style-digital', 'style-led', 'style-amber', 'style-cyan', 'style-red', 'style-vfd'];
        this.currentStyleIndex = 0;

        // State tracking - these track the RADIO state, not SDR
        this.currentFrequency = 0;  // Radio frequency
        this.currentMode = 'USB';   // Radio mode
        this.txState = false;       // false = RX, true = TX
        this.muteOnTX = true; // Mute SDR when radio is transmitting
        this.wasMutedBeforeTX = false; // Track if SDR was already muted before TX

        // Track last values sent to radio to prevent feedback loops
        this.lastSentFrequency = 0;
        this.lastSentMode = '';

        // Flag to temporarily disable event handlers when we're updating SDR from radio
        this.updatingFromRadio = false;

        // Update intervals
        this.updateInterval = null;
        this.radioPollingInterval = null;
    }

    onInitialize() {
        console.log('Radio Sync Extension onInitialize called');
        this.radio.log('Radio Sync Extension initialized');

        // Load and render template
        this.renderUI();

        console.log('Radio Sync Extension initialization complete');
    }

    /**
     * Loads hamlib.wasm + the Web Serial bridge exactly once, cwraps the API,
     * and populates the radio dropdown from hamlib_list_rigs(). Safe to call
     * repeatedly (e.g. every onEnable()) - subsequent calls return the same
     * cached promise instead of reloading the 14MB module.
     */
    ensureHamlibLoaded() {
        if (this.hamlibLoadPromise) {
            return this.hamlibLoadPromise;
        }

        this.hamlibLoadPromise = (async () => {
            try {
                if (typeof window.HamlibSerialBridge === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = `${HAMLIB_BASE_URL}/hamlib-serial-bridge.js`;
                        script.onload = resolve;
                        script.onerror = () => reject(new Error('Failed to load hamlib-serial-bridge.js'));
                        document.head.appendChild(script);
                    });
                }

                const { default: createHamlibModule } = await import(`${HAMLIB_BASE_URL}/hamlib.js`);
                const bridge = new window.HamlibSerialBridge();
                const Module = await createHamlibModule({ hamlibSerial: bridge });

                this.hamlibModule = Module;
                this.hamlibOpen = Module.cwrap('hamlib_open', 'number',
                    ['number', 'number', 'number', 'number', 'number', 'number'], { async: true });
                this.hamlibClose = Module.cwrap('hamlib_close', 'number', ['number'], { async: true });
                this.hamlibGetFreq = Module.cwrap('hamlib_get_freq', 'number', ['number'], { async: true });
                this.hamlibSetFreq = Module.cwrap('hamlib_set_freq', 'number', ['number', 'number'], { async: true });
                this.hamlibGetMode = Module.cwrap('hamlib_get_mode', 'string', ['number'], { async: true });
                this.hamlibSetMode = Module.cwrap('hamlib_set_mode', 'number', ['number', 'string'], { async: true });
                this.hamlibGetPtt = Module.cwrap('hamlib_get_ptt', 'number', ['number'], { async: true });

                const listRigs = Module.cwrap('hamlib_list_rigs', 'string', []); // no I/O - plain sync call
                const rigs = JSON.parse(listRigs());
                this.populateRadioDropdown(rigs);

                this.addMessage(`Hamlib loaded: ${rigs.length} radios available`, 'success');
            } catch (error) {
                console.error('Failed to load Hamlib wasm module:', error);
                this.showHamlibLoadError(error);
                throw error;
            }
        })();

        return this.hamlibLoadPromise;
    }

    /**
     * Replaces the static placeholder options in #radio-sync-model with one
     * <optgroup> per manufacturer, generated from hamlib_list_rigs(). Each
     * <option>'s dataset carries the serial settings hamlib_open() needs -
     * this is the per-radio config source now (replaces the old hardcoded
     * this.radioProtocols map).
     */
    populateRadioDropdown(rigs) {
        const modelSelect = document.getElementById('radio-sync-model');
        if (!modelSelect) return;

        const byMfg = new Map();
        for (const rig of rigs) {
            if (!byMfg.has(rig.mfg)) byMfg.set(rig.mfg, []);
            byMfg.get(rig.mfg).push(rig);
        }

        const mfgs = Array.from(byMfg.keys()).sort((a, b) => a.localeCompare(b));

        modelSelect.innerHTML = '<option value="">Select Radio...</option>';
        for (const mfg of mfgs) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = mfg;

            const rigsForMfg = byMfg.get(mfg).sort((a, b) => a.name.localeCompare(b.name));
            for (const rig of rigsForMfg) {
                const option = document.createElement('option');
                option.value = String(rig.model);
                option.textContent = rig.name;
                option.dataset.name = `${rig.mfg} ${rig.name}`;
                option.dataset.baud = rig.baudMax;
                option.dataset.dataBits = rig.dataBits;
                option.dataset.stopBits = rig.stopBits;
                option.dataset.parity = rig.parity;
                option.dataset.handshake = rig.handshake;
                optgroup.appendChild(option);
            }
            modelSelect.appendChild(optgroup);
        }
    }

    showHamlibLoadError(error) {
        const errorDiv = document.getElementById('radio-sync-api-error');
        if (errorDiv) {
            errorDiv.style.display = 'block';
            errorDiv.querySelector('strong').textContent = '⚠️ Hamlib module failed to load';
            errorDiv.querySelector('p').textContent =
                `Could not load ${HAMLIB_BASE_URL}/hamlib.js (${error.message}). Radio control is unavailable.`;
        }
        this.addMessage(`Hamlib load error: ${error.message}`, 'error');
    }

    showSerialAPIError() {
        const errorDiv = document.getElementById('radio-sync-api-error');
        if (errorDiv) {
            errorDiv.style.display = 'block';
        }
        this.addMessage('Web Serial API not available in this browser', 'error');
    }

    renderUI() {
        const template = window.radio_sync_template;

        if (!template) {
            console.error('Radio Sync extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    setupEventListeners() {
        // Radio model selection
        const modelSelect = document.getElementById('radio-sync-model');
        const connectBtn = document.getElementById('radio-sync-connect');

        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                this.selectedRadio = e.target.value;

                // Update baud rate dropdown to default for selected radio
                const baudRateSelect = document.getElementById('radio-sync-baud-rate');
                const option = modelSelect.selectedOptions[0];
                if (baudRateSelect && this.selectedRadio && option) {
                    baudRateSelect.value = option.dataset.baud;
                    this.selectedBaudRate = parseInt(option.dataset.baud, 10);
                }

                // Update connect button based on selection
                if (connectBtn) {
                    if (this.selectedRadio) {
                        connectBtn.disabled = false;
                        connectBtn.textContent = 'Connect to Radio';
                        this.addMessage(`Selected: ${option?.dataset.name || 'Unknown'}`, 'info');
                    } else {
                        connectBtn.disabled = true;
                        connectBtn.textContent = 'Select Radio First';
                    }
                }
            });
        } else {
            console.error('Radio Sync: model select not found');
        }

        // Baud rate selection
        const baudRateSelect = document.getElementById('radio-sync-baud-rate');
        if (baudRateSelect) {
            baudRateSelect.addEventListener('change', (e) => {
                this.selectedBaudRate = parseInt(e.target.value, 10);
                this.addMessage(`Baud rate: ${this.selectedBaudRate}`, 'info');
            });
        }

        // Sync direction buttons
        const sdrToRadioBtn = document.getElementById('radio-sync-sdr-to-radio');
        const radioToSdrBtn = document.getElementById('radio-sync-radio-to-sdr');
        const bothBtn = document.getElementById('radio-sync-both');

        if (sdrToRadioBtn) {
            sdrToRadioBtn.addEventListener('click', () => this.setSyncMode('sdr-to-radio'));
        }
        if (radioToSdrBtn) {
            radioToSdrBtn.addEventListener('click', () => this.setSyncMode('radio-to-sdr'));
        }
        if (bothBtn) {
            bothBtn.addEventListener('click', () => this.setSyncMode('both'));
        }

        // Connect/Disconnect buttons
        const disconnectBtn = document.getElementById('radio-sync-disconnect');

        if (connectBtn) {
            console.log('Radio Sync: Connect button found, adding listener');
            // Set initial state
            connectBtn.disabled = true;
            connectBtn.textContent = 'Select Radio First';

            connectBtn.addEventListener('click', () => {
                console.log('Radio Sync: Connect button clicked');
                this.connectToRadio();
            });
        } else {
            console.error('Radio Sync: Connect button not found');
        }

        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => this.disconnectFromRadio());
        } else {
            console.error('Radio Sync: Disconnect button not found');
        }

        // Mute on TX checkbox
        const muteOnTXCheckbox = document.getElementById('radio-sync-mute-on-tx');
        if (muteOnTXCheckbox) {
            muteOnTXCheckbox.addEventListener('change', (e) => {
                this.muteOnTX = e.target.checked;
                this.addMessage(`Mute on TX: ${this.muteOnTX ? 'enabled' : 'disabled'}`, 'info');
            });
        }

        // Display style cycling
        const displayElement = document.getElementById('radio-sync-display');
        if (displayElement) {
            displayElement.addEventListener('click', () => this.cycleDisplayStyle());
        }
    }

    cycleDisplayStyle() {
        const displayElement = document.getElementById('radio-sync-display');
        if (!displayElement) return;

        // Remove current style
        displayElement.classList.remove(this.displayStyles[this.currentStyleIndex]);

        // Move to next style
        this.currentStyleIndex = (this.currentStyleIndex + 1) % this.displayStyles.length;

        // Add new style
        displayElement.classList.add(this.displayStyles[this.currentStyleIndex]);

        // Get style name for message
        const styleName = this.displayStyles[this.currentStyleIndex]
            .replace('style-', '')
            .replace('-', ' ')
            .toUpperCase();

        this.addMessage(`Display style: ${styleName}`, 'info');
    }

    setSyncMode(mode) {
        this.syncMode = mode;

        // Update button states
        const buttons = {
            'sdr-to-radio': document.getElementById('radio-sync-sdr-to-radio'),
            'radio-to-sdr': document.getElementById('radio-sync-radio-to-sdr'),
            'both': document.getElementById('radio-sync-both')
        };

        Object.keys(buttons).forEach(key => {
            if (buttons[key]) {
                if (key === mode) {
                    buttons[key].classList.add('radio-sync-btn-active');
                    // Force inline styles to override any CSS
                    buttons[key].style.background = '#3498db';
                    buttons[key].style.borderColor = '#5dade2';
                    buttons[key].style.boxShadow = '0 0 15px rgba(52, 152, 219, 0.6)';
                    buttons[key].style.color = '#ffffff';
                    buttons[key].style.fontWeight = '700';
                } else {
                    buttons[key].classList.remove('radio-sync-btn-active');
                    // Remove inline styles
                    buttons[key].style.background = '';
                    buttons[key].style.borderColor = '';
                    buttons[key].style.boxShadow = '';
                    buttons[key].style.color = '';
                    buttons[key].style.fontWeight = '';
                }
            } else {
                console.error('Button not found:', key);
            }
        });

        this.addMessage(`Sync mode: ${mode.replace(/-/g, ' ').toUpperCase()}`, 'info');
    }

    updateFromSDR() {
        // Initialize display with SDR state until we get radio state
        const sdrFreq = this.radio.getFrequency();
        const sdrMode = this.radio.getMode();

        // Update displays (will be overwritten by radio responses)
        this.updateFrequencyDisplay(sdrFreq);
        this.updateModeDisplay(sdrMode);
    }

    updateFrequencyDisplay(freq) {
        const formatted = this.formatFrequencyLED(freq);
        this.updateElementById('radio-sync-freq-display', (el) => {
            el.textContent = formatted;
        });
    }

    formatFrequencyLED(hz) {
        // Show dashes if frequency is 0 (not connected)
        if (hz === 0) {
            return '--.---.---';
        }
        // Format for LED display: 14.074.000
        const mhz = (hz / 1000000).toFixed(6);
        // Add dots every 3 digits from the right (after decimal point)
        const parts = mhz.split('.');
        if (parts.length === 2) {
            const intPart = parts[0];
            const decPart = parts[1];
            // Group decimal part in threes
            const grouped = decPart.match(/.{1,3}/g).join('.');
            return `${intPart}.${grouped}`;
        }
        return mhz;
    }

    updateModeDisplay(mode) {
        this.updateElementById('radio-sync-mode-display', (el) => {
            // Show dashes if mode is empty or '---'
            if (!mode || mode === '---') {
                el.textContent = '---';
            } else {
                el.textContent = mode.toUpperCase();
            }
        });
    }

    updateTXRXState(isTX, isConnected = true) {
        const wasTransmitting = this.txState;
        this.txState = isTX;

        const stateDisplay = document.getElementById('radio-sync-state-display');

        if (stateDisplay) {
            if (!isConnected) {
                // Show dashes when not connected
                stateDisplay.textContent = '--';
                stateDisplay.classList.remove('led-state-tx', 'led-state-rx');
            } else if (isTX) {
                stateDisplay.textContent = 'TX';
                stateDisplay.classList.remove('led-state-rx');
                stateDisplay.classList.add('led-state-tx');
            } else {
                stateDisplay.textContent = 'RX';
                stateDisplay.classList.remove('led-state-tx');
                stateDisplay.classList.add('led-state-rx');
            }
        }

        // Handle mute on TX (only when connected)
        if (isConnected && this.muteOnTX) {
            if (isTX && !wasTransmitting) {
                // Just started transmitting - mute SDR
                this.muteSDR();
            } else if (!isTX && wasTransmitting) {
                // Just stopped transmitting - unmute SDR
                this.unmuteSDR();
            }
        }
    }

    muteSDR() {
        try {
            // Store whether SDR was already muted before we mute it
            this.wasMutedBeforeTX = this.radio.getMuted();

            // Only mute if not already muted
            if (!this.wasMutedBeforeTX) {
                const result = this.radio.setMuted(true);

                if (result) {
                    this.addMessage('🔇 SDR muted (radio TX)', 'info');
                } else {
                    this.addMessage('Failed to mute SDR', 'warning');
                }
            }
        } catch (error) {
            console.error('Error in muteSDR:', error);
            this.addMessage(`Mute error: ${error.message}`, 'error');
        }
    }

    unmuteSDR() {
        try {
            // Only unmute if we muted it (don't unmute if it was already muted)
            if (!this.wasMutedBeforeTX) {
                const result = this.radio.setMuted(false);

                if (result) {
                    this.addMessage('🔊 SDR unmuted (radio RX)', 'info');
                } else {
                    this.addMessage('Failed to unmute SDR', 'warning');
                }
            }
        } catch (error) {
            console.error('Error in unmuteSDR:', error);
            this.addMessage(`Unmute error: ${error.message}`, 'error');
        }
    }

    async connectToRadio() {
        if (!this.selectedRadio) {
            this.addMessage('Please select a radio model first', 'warning');
            return;
        }

        if (!('serial' in navigator)) {
            this.addMessage('Web Serial API not available', 'error');
            return;
        }

        try {
            await this.ensureHamlibLoaded();
        } catch (error) {
            return; // ensureHamlibLoaded() already reported this
        }

        const modelSelect = document.getElementById('radio-sync-model');
        const option = modelSelect?.selectedOptions[0];
        if (!option) {
            this.addMessage('Please select a radio model first', 'warning');
            return;
        }

        const model = Number(this.selectedRadio);
        const baud = this.selectedBaudRate || Number(option.dataset.baud);
        const dataBits = Number(option.dataset.dataBits);
        const stopBits = Number(option.dataset.stopBits);
        const parity = Number(option.dataset.parity);
        const handshake = Number(option.dataset.handshake);

        try {
            this.addMessage(`Connecting to ${option.dataset.name}...`, 'info');

            // This triggers the browser's Web Serial device picker.
            this.rigHandle = await this.hamlibOpen(model, baud, dataBits, stopBits, parity, handshake);

            if (this.rigHandle <= 0) {
                throw new Error('hamlib_open failed - check the message log / browser console for the Hamlib debug trace');
            }

            this.isConnected = true;
            this.addMessage(`Connected to ${option.dataset.name} at ${baud} baud`, 'success');

            // Update UI
            this.updateConnectionUI(true);

            // Start polling radio state (freq/mode/TX for display, and for radio-to-sdr sync)
            this.startRadioPolling();

            // Get current SDR state before syncing to radio
            this.currentFrequency = this.radio.getFrequency();
            this.currentMode = this.radio.getMode();

            // Send initial state to radio (for sdr-to-radio sync)
            if (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both') {
                await this.sendFrequencyToRadio(this.currentFrequency);
                await this.sendModeToRadio(this.currentMode);
            }

        } catch (error) {
            this.addMessage(`Connection failed: ${error.message}`, 'error');
            this.isConnected = false;
            this.rigHandle = 0;
        }
    }

    async disconnectFromRadio() {
        if (!this.rigHandle) return;

        try {
            this.stopRadioPolling();

            await this.hamlibClose(this.rigHandle);
            this.rigHandle = 0;
            this.isConnected = false;

            this.addMessage('Disconnected from radio', 'info');
            this.updateConnectionUI(false);

        } catch (error) {
            this.addMessage(`Disconnect error: ${error.message}`, 'error');
        } finally {
            // Reset display to dashes when disconnected
            this.updateFrequencyDisplay(0);
            this.updateModeDisplay('---');
            this.updateTXRXState(false, false);
        }
    }

    startRadioPolling() {
        // Stop any existing polling
        this.stopRadioPolling();

        // Poll radio every 100ms for freq/mode/TX state (always, for display and mute-on-TX)
        this.radioPollingInterval = setInterval(async () => {
            if (!this.isConnected || !this.rigHandle) return;

            try {
                const freq = await this.hamlibGetFreq(this.rigHandle);
                if (freq >= 0) this.handleRadioFrequency(freq);

                const hamlibMode = await this.hamlibGetMode(this.rigHandle);
                if (hamlibMode) this.handleRadioMode(hamlibMode);

                const ptt = await this.hamlibGetPtt(this.rigHandle);
                if (ptt >= 0) this.updateTXRXState(ptt !== 0);
            } catch (error) {
                console.error('Radio polling error:', error);
            }
        }, 100); // Poll every 100ms (10 Hz) for responsive sync

        this.addMessage('Started polling radio state (freq/mode/TX) at 10 Hz', 'info');
    }

    stopRadioPolling() {
        if (this.radioPollingInterval) {
            clearInterval(this.radioPollingInterval);
            this.radioPollingInterval = null;
            this.addMessage('Stopped polling radio state', 'info');
        }
    }

    handleRadioFrequency(freq) {
        this.currentFrequency = freq;
        this.updateFrequencyDisplay(freq);

        if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
            const currentSDRFreq = this.radio.getFrequency();
            if (freq !== currentSDRFreq) {
                // Set flag to prevent our event handlers from reacting
                this.updatingFromRadio = true;
                // Track this as the last sent frequency to prevent feedback
                this.lastSentFrequency = freq;
                this.radio.setFrequency(freq);
                // Clear flag immediately after event loop processes the event
                setTimeout(() => { this.updatingFromRadio = false; }, 0);
            }
        }
    }

    handleRadioMode(hamlibMode) {
        const sdrMode = HAMLIB_TO_SDR_MODE[hamlibMode] || hamlibMode.toLowerCase();
        this.currentMode = sdrMode;
        this.updateModeDisplay(sdrMode);

        if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
            const currentSDRMode = this.radio.getMode();
            if (sdrMode !== currentSDRMode) {
                // Set flag to prevent our event handlers from reacting
                this.updatingFromRadio = true;
                // Track this as the last sent mode to prevent feedback
                this.lastSentMode = sdrMode;
                this.radio.setMode(sdrMode);
                // Clear flag immediately after event loop processes the event
                setTimeout(() => { this.updatingFromRadio = false; }, 0);
            }
        }
    }

    updateConnectionUI(connected) {
        const connectBtn = document.getElementById('radio-sync-connect');
        const disconnectBtn = document.getElementById('radio-sync-disconnect');
        const baudRateSelect = document.getElementById('radio-sync-baud-rate');

        if (connectBtn && disconnectBtn) {
            if (connected) {
                connectBtn.style.display = 'none';
                disconnectBtn.style.display = 'inline-block';
                // Disable baud rate selection when connected
                if (baudRateSelect) {
                    baudRateSelect.disabled = true;
                }
            } else {
                connectBtn.style.display = 'inline-block';
                disconnectBtn.style.display = 'none';
                // Enable baud rate selection when disconnected
                if (baudRateSelect) {
                    baudRateSelect.disabled = false;
                }
            }
        }
    }

    async sendFrequencyToRadio(freq) {
        if (!this.isConnected || !this.rigHandle) return;

        try {
            await this.hamlibSetFreq(this.rigHandle, freq);
            this.addMessage(`Set radio frequency: ${this.radio.formatFrequency(freq)}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set frequency: ${error.message}`, 'error');
        }
    }

    async sendModeToRadio(mode) {
        if (!this.isConnected || !this.rigHandle) return;

        try {
            const hamlibMode = SDR_TO_HAMLIB_MODE[mode] || mode.toUpperCase();
            await this.hamlibSetMode(this.rigHandle, hamlibMode);
            this.addMessage(`Set radio mode: ${mode.toUpperCase()}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set mode: ${error.message}`, 'error');
        }
    }

    addMessage(message, type = 'info') {
        const messagesDiv = document.getElementById('radio-sync-messages');
        if (!messagesDiv) return;

        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement('div');
        messageDiv.className = `radio-sync-message radio-sync-message-${type}`;
        messageDiv.textContent = `[${timestamp}] ${message}`;

        messagesDiv.appendChild(messageDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        // Keep only last 1000 messages
        while (messagesDiv.children.length > 1000) {
            messagesDiv.removeChild(messagesDiv.firstChild);
        }
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    onEnable() {
        console.log('Radio Sync Extension onEnable called');

        // Set up event listeners now that template is definitely in DOM
        this.setupEventListeners();

        // Load the Hamlib wasm module and populate the radio dropdown from it
        this.ensureHamlibLoaded();

        // Subscribe to radio events for SDR changes
        this.subscribeToRadioEvents();

        // Set initial sync mode button state
        this.setSyncMode(this.syncMode);

        // Check for Web Serial API support and show error if not available
        if (!('serial' in navigator)) {
            this.showSerialAPIError();
        }

        this.addMessage('Radio Sync extension enabled', 'success');

        // Start periodic updates to poll SDR state
        this.updateInterval = setInterval(() => {
            this.pollSDRState();
        }, 100); // Update every 100ms (10 Hz) for responsive sync

        // Initial update
        this.updateFromSDR();
    }

    onDisable() {
        this.addMessage('Radio Sync extension disabled', 'info');

        // Stop periodic updates
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }

        // Disconnect if connected
        if (this.isConnected) {
            this.disconnectFromRadio();
        }
    }

    pollSDRState() {
        // If not connected, ensure display shows dashes
        if (!this.isConnected) {
            this.updateFrequencyDisplay(0);
            this.updateModeDisplay('---');
            return;
        }

        // Poll SDR state and send changes to radio if in sdr-to-radio or both mode
        if (this.syncMode !== 'sdr-to-radio' && this.syncMode !== 'both') {
            return;
        }

        const sdrFreq = this.radio.getFrequency();
        const sdrMode = this.radio.getMode();

        // Check if SDR frequency changed and send to radio
        if (sdrFreq !== this.lastSentFrequency) {
            this.lastSentFrequency = sdrFreq;
            this.sendFrequencyToRadio(sdrFreq);
        }

        // Check if SDR mode changed and send to radio
        if (sdrMode !== this.lastSentMode) {
            this.lastSentMode = sdrMode;
            this.sendModeToRadio(sdrMode);
        }
    }

    onProcessAudio(dataArray) {
        // Not used for this extension
    }

    onFrequencyChanged(frequency) {
        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) return;

        // Only send if frequency actually changed from what we last sent
        if (frequency === this.lastSentFrequency) return;

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            this.lastSentFrequency = frequency;
            this.sendFrequencyToRadio(frequency);
        }
    }

    onModeChanged(mode) {
        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) return;

        // Only send if mode actually changed from what we last sent
        if (mode === this.lastSentMode) return;

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            this.lastSentMode = mode;
            this.sendModeToRadio(mode);
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new RadioSyncExtension());
    console.log('✅ Radio Sync Extension registered');
}
