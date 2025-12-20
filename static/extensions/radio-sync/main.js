// Radio Sync Extension - Synchronize with external radios via serial port
// Displays frequency, mode, and TX/RX state with LED-style indicators

class RadioSyncExtension extends DecoderExtension {
    constructor() {
        super('radio-sync', {
            displayName: 'Radio Sync',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        // Serial port state
        this.serialPort = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        
        // Radio protocol configuration
        this.radioProtocols = {
            'icom-ic7300': { name: 'Icom IC-7300', baudRate: 19200, protocol: 'icom-civ', civAddress: 0x94 },
            'icom-ic7610': { name: 'Icom IC-7610', baudRate: 19200, protocol: 'icom-civ', civAddress: 0x98 },
            'icom-ic9700': { name: 'Icom IC-9700', baudRate: 19200, protocol: 'icom-civ', civAddress: 0xA2 },
            'icom-ic705': { name: 'Icom IC-705', baudRate: 19200, protocol: 'icom-civ', civAddress: 0xA4 },
            'yaesu-ft991a': { name: 'Yaesu FT-991A', baudRate: 38400, protocol: 'yaesu-cat' },
            'yaesu-ft710': { name: 'Yaesu FT-710', baudRate: 38400, protocol: 'yaesu-cat' },
            'yaesu-ftdx10': { name: 'Yaesu FTDX10', baudRate: 38400, protocol: 'yaesu-cat' },
            'yaesu-ftdx101d': { name: 'Yaesu FTDX101D', baudRate: 38400, protocol: 'yaesu-cat' },
            'yaesu-ft818': { name: 'Yaesu FT-818', baudRate: 38400, protocol: 'yaesu-cat' },
            'kenwood-ts590sg': { name: 'Kenwood TS-590SG', baudRate: 115200, protocol: 'kenwood-cat' },
            'kenwood-ts890s': { name: 'Kenwood TS-890S', baudRate: 115200, protocol: 'kenwood-cat' },
            'kenwood-ts480': { name: 'Kenwood TS-480', baudRate: 57600, protocol: 'kenwood-cat' },
            'elecraft-k3': { name: 'Elecraft K3', baudRate: 38400, protocol: 'elecraft' },
            'elecraft-k4': { name: 'Elecraft K4', baudRate: 38400, protocol: 'elecraft' },
            'elecraft-kx3': { name: 'Elecraft KX3', baudRate: 38400, protocol: 'elecraft' },
            'elecraft-kx2': { name: 'Elecraft KX2', baudRate: 38400, protocol: 'elecraft' },
            'xiegu-g90': { name: 'Xiegu G90', baudRate: 19200, protocol: 'icom-civ', civAddress: 0x88 },
            'xiegu-x6100': { name: 'Xiegu X6100', baudRate: 19200, protocol: 'icom-civ', civAddress: 0x88 }
        };
        
        // Protocol handler instance
        this.protocolHandler = null;
        
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
     * Check which protocol implementations are available and hide radios without them
     */
    async filterAvailableRadios() {
        const availableProtocols = new Set();

        // Check which protocol files are available
        const protocolsToCheck = [
            { name: 'yaesu-cat', class: 'YaesuCATProtocol' },
            { name: 'icom-civ', class: 'IcomCIVProtocol' },
            { name: 'kenwood-cat', class: 'KenwoodCATProtocol' },
            { name: 'elecraft', class: 'ElecraftProtocol' }
        ];

        for (const protocol of protocolsToCheck) {
            if (typeof window[protocol.class] !== 'undefined') {
                availableProtocols.add(protocol.name);
                console.log(`✅ Protocol available: ${protocol.name}`);
            } else {
                console.log(`❌ Protocol not available: ${protocol.name}`);
            }
        }

        // Filter radio options based on available protocols
        const modelSelect = document.getElementById('radio-sync-model');
        if (!modelSelect) return;

        let hiddenCount = 0;

        // Iterate through all options and hide those without available protocols
        for (const [radioId, radioConfig] of Object.entries(this.radioProtocols)) {
            if (!availableProtocols.has(radioConfig.protocol)) {
                // Find and hide the option
                const option = modelSelect.querySelector(`option[value="${radioId}"]`);
                if (option) {
                    option.style.display = 'none';
                    option.disabled = true;
                    hiddenCount++;
                }
            }
        }

        // Hide empty optgroups
        const optgroups = modelSelect.querySelectorAll('optgroup');
        optgroups.forEach(optgroup => {
            const visibleOptions = Array.from(optgroup.querySelectorAll('option'))
                .filter(opt => opt.style.display !== 'none');
            if (visibleOptions.length === 0) {
                optgroup.style.display = 'none';
            }
        });

        if (hiddenCount > 0) {
            this.addMessage(`${hiddenCount} radio(s) hidden (protocol not implemented)`, 'info');
        }
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
                if (baudRateSelect && this.selectedRadio) {
                    const radioConfig = this.radioProtocols[this.selectedRadio];
                    if (radioConfig) {
                        baudRateSelect.value = radioConfig.baudRate.toString();
                        this.selectedBaudRate = radioConfig.baudRate;
                    }
                }

                // Update connect button based on selection
                if (connectBtn) {
                    if (this.selectedRadio) {
                        connectBtn.disabled = false;
                        connectBtn.textContent = 'Connect to Radio';
                        this.addMessage(`Selected: ${this.radioProtocols[this.selectedRadio]?.name || 'Unknown'}`, 'info');
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

        console.log('setSyncMode called with mode:', mode);
        Object.keys(buttons).forEach(key => {
            if (buttons[key]) {
                if (key === mode) {
                    console.log('Adding active class to:', key, buttons[key]);
                    buttons[key].classList.add('radio-sync-btn-active');
                    // Force inline styles to override any CSS
                    buttons[key].style.background = '#3498db';
                    buttons[key].style.borderColor = '#5dade2';
                    buttons[key].style.boxShadow = '0 0 15px rgba(52, 152, 219, 0.6)';
                    buttons[key].style.color = '#ffffff';
                    buttons[key].style.fontWeight = '700';
                    console.log('Button classes after add:', buttons[key].className);
                } else {
                    console.log('Removing active class from:', key);
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
                console.log('TX started - calling muteSDR()');
                this.muteSDR();
            } else if (!isTX && wasTransmitting) {
                // Just stopped transmitting - unmute SDR
                console.log('TX stopped - calling unmuteSDR()');
                this.unmuteSDR();
            }
        }
    }

    muteSDR() {
        try {
            // Store whether SDR was already muted before we mute it
            this.wasMutedBeforeTX = this.radio.getMuted();
            console.log('muteSDR: Current mute state =', this.wasMutedBeforeTX);
            console.log('muteSDR: wasMutedBeforeTX will be set to', this.wasMutedBeforeTX);

            // Only mute if not already muted
            if (!this.wasMutedBeforeTX) {
                console.log('muteSDR: Calling setMuted(true)...');
                const result = this.radio.setMuted(true);
                console.log('muteSDR: setMuted(true) returned', result);

                // Verify it actually got muted
                const newState = this.radio.getMuted();
                console.log('muteSDR: After setMuted(true), getMuted() returns', newState);

                if (result) {
                    this.addMessage('🔇 SDR muted (radio TX)', 'info');
                } else {
                    this.addMessage('Failed to mute SDR', 'warning');
                }
            } else {
                console.log('muteSDR: SDR was already muted, not muting again');
            }
        } catch (error) {
            console.error('Error in muteSDR:', error);
            this.addMessage(`Mute error: ${error.message}`, 'error');
        }
    }

    unmuteSDR() {
        try {
            console.log('unmuteSDR: wasMutedBeforeTX =', this.wasMutedBeforeTX);
            console.log('unmuteSDR: Current mute state before unmute =', this.radio.getMuted());

            // Only unmute if we muted it (don't unmute if it was already muted)
            if (!this.wasMutedBeforeTX) {
                console.log('unmuteSDR: Calling setMuted(false)...');
                const result = this.radio.setMuted(false);
                console.log('unmuteSDR: setMuted(false) returned', result);

                // Verify it actually got unmuted
                const newState = this.radio.getMuted();
                console.log('unmuteSDR: After setMuted(false), getMuted() returns', newState);

                if (result) {
                    this.addMessage('🔊 SDR unmuted (radio RX)', 'info');
                } else {
                    this.addMessage('Failed to unmute SDR', 'warning');
                }
            } else {
                console.log('unmuteSDR: SDR was muted before TX, not unmuting');
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
            const radioConfig = this.radioProtocols[this.selectedRadio];
            this.addMessage(`Connecting to ${radioConfig.name}...`, 'info');

            // Initialize protocol handler
            if (radioConfig.protocol === 'yaesu-cat') {
                if (typeof YaesuCATProtocol === 'undefined') {
                    throw new Error('Yaesu CAT protocol handler not loaded');
                }
                this.protocolHandler = new YaesuCATProtocol();
                this.addMessage('Initialized Yaesu CAT protocol', 'info');
            } else if (radioConfig.protocol === 'kenwood-cat') {
                if (typeof KenwoodCATProtocol === 'undefined') {
                    throw new Error('Kenwood CAT protocol handler not loaded');
                }
                this.protocolHandler = new KenwoodCATProtocol();
                this.addMessage('Initialized Kenwood CAT protocol', 'info');
            } else {
                throw new Error(`Protocol ${radioConfig.protocol} not yet implemented`);
            }

            // Request serial port
            this.serialPort = await navigator.serial.requestPort();

            // Open with radio-specific settings
            await this.serialPort.open({
                baudRate: radioConfig.baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.isConnected = true;
            this.addMessage(`Connected to ${radioConfig.name} at ${radioConfig.baudRate} baud`, 'success');
            
            // Update UI
            this.updateConnectionUI(true);

            // Start reading from radio
            this.startReading();

            // Start polling radio state (for radio-to-sdr sync)
            // Note: We always poll for TX status, but only poll freq/mode in radio-to-sdr or both modes
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
            this.protocolHandler = null;
        }
    }

    async disconnectFromRadio() {
        if (!this.serialPort) return;

        try {
            // Stop radio polling
            this.stopRadioPolling();

            // Stop reading
            if (this.reader) {
                await this.reader.cancel();
                this.reader = null;
            }

            // Close port
            await this.serialPort.close();
            this.serialPort = null;
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

        // Poll radio every 100ms for freq/mode (always, for display) and TX state (always, for mute)
        this.radioPollingInterval = setInterval(async () => {
            if (this.isConnected && this.protocolHandler) {
                try {
                    // Always query frequency and mode to update display
                    const freqCmd = this.protocolHandler.buildGetFrequencyCommand();
                    await this.sendCommand(freqCmd);

                    const modeCmd = this.protocolHandler.buildGetModeCommand();
                    await this.sendCommand(modeCmd);

                    // Always query TX/RX state for mute-on-TX feature
                    const txCmd = this.protocolHandler.buildGetTXStatusCommand();
                    await this.sendCommand(txCmd);
                } catch (error) {
                    console.error('Radio polling error:', error);
                }
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

    async startReading() {
        if (!this.serialPort || !this.serialPort.readable) return;

        try {
            this.reader = this.serialPort.readable.getReader();

            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;

                // Parse radio response based on protocol
                this.parseRadioResponse(value);
            }
        } catch (error) {
            if (error.name !== 'NetworkError') {
                this.addMessage(`Read error: ${error.message}`, 'error');
            }
        } finally {
            if (this.reader) {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    parseRadioResponse(data) {
        if (!this.protocolHandler) {
            this.addMessage('No protocol handler available', 'error');
            return;
        }
        
        const responses = this.protocolHandler.parseResponse(data);
        
        if (!responses) {
            return; // Incomplete response, waiting for more data
        }
        
        // Process each complete response
        for (const response of responses) {
            this.handleParsedResponse(response);
        }
    }
    
    handleParsedResponse(response) {
        if (!response) return;
        
        switch (response.type) {
            case 'frequency':
                this.addMessage(`Radio VFO-${response.vfo}: ${this.radio.formatFrequency(response.frequency)}`, 'info');

                // Update our display with radio frequency
                this.currentFrequency = response.frequency;
                this.updateFrequencyDisplay(response.frequency);

                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    // Only update SDR if frequency actually differs
                    const currentSDRFreq = this.radio.getFrequency();
                    if (response.frequency !== currentSDRFreq) {
                        // Set flag to prevent our event handlers from reacting
                        this.updatingFromRadio = true;
                        // Track this as the last sent frequency to prevent feedback
                        this.lastSentFrequency = response.frequency;
                        // Update SDR frequency
                        this.radio.setFrequency(response.frequency);
                        // Clear flag immediately after event loop processes the event
                        setTimeout(() => { this.updatingFromRadio = false; }, 0);
                    }
                }
                break;

            case 'mode':
                this.addMessage(`Radio mode: ${response.mode}`, 'info');

                // Update our display with radio mode
                this.currentMode = response.mode;
                this.updateModeDisplay(response.mode);

                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    // Only update SDR if mode actually differs
                    const sdrMode = response.mode.toLowerCase();
                    const currentSDRMode = this.radio.getMode();
                    if (sdrMode !== currentSDRMode) {
                        // Set flag to prevent our event handlers from reacting
                        this.updatingFromRadio = true;
                        // Track this as the last sent mode to prevent feedback
                        this.lastSentMode = sdrMode;
                        // Update SDR mode
                        this.radio.setMode(sdrMode);
                        // Clear flag immediately after event loop processes the event
                        setTimeout(() => { this.updatingFromRadio = false; }, 0);
                    }
                }
                break;

            case 'status':
                // Full status from IF command
                this.addMessage(`Radio status: ${this.radio.formatFrequency(response.frequency)} ${response.mode} ${response.transmitting ? 'TX' : 'RX'}`, 'info');

                // Update our display with radio state
                this.currentFrequency = response.frequency;
                this.currentMode = response.mode;
                this.updateFrequencyDisplay(response.frequency);
                this.updateModeDisplay(response.mode);
                this.updateTXRXState(response.transmitting);

                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    // Only update SDR if values actually differ
                    const currentSDRFreq = this.radio.getFrequency();
                    const sdrMode = response.mode.toLowerCase();
                    const currentSDRMode = this.radio.getMode();

                    const freqChanged = response.frequency !== currentSDRFreq;
                    const modeChanged = sdrMode !== currentSDRMode;

                    if (freqChanged || modeChanged) {
                        // Set flag to prevent our event handlers from reacting
                        this.updatingFromRadio = true;
                        // Track these as the last sent values to prevent feedback
                        this.lastSentFrequency = response.frequency;
                        this.lastSentMode = sdrMode;
                        // Update SDR only if changed
                        if (freqChanged) {
                            this.radio.setFrequency(response.frequency);
                        }
                        if (modeChanged) {
                            this.radio.setMode(sdrMode);
                        }
                        // Clear flag immediately after event loop processes the events
                        setTimeout(() => { this.updatingFromRadio = false; }, 0);
                    }
                }
                break;
                
            case 'tx_status':
                this.updateTXRXState(response.transmitting);
                break;
                
            case 'power':
                this.addMessage(`Radio power: ${response.on ? 'ON' : 'OFF'}`, 'info');
                break;
                
            case 'error':
                this.addMessage(`Parse error: ${response.message}`, 'error');
                break;
                
            default:
                this.addMessage(`Unknown response type: ${response.type}`, 'warning');
        }
    }

    async sendFrequencyToRadio(freq) {
        if (!this.isConnected || !this.serialPort || !this.protocolHandler) return;

        try {
            const command = this.protocolHandler.buildSetFrequencyCommand(freq);
            await this.sendCommand(command);
            this.addMessage(`Set radio frequency: ${this.radio.formatFrequency(freq)}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set frequency: ${error.message}`, 'error');
        }
    }

    async sendModeToRadio(mode) {
        if (!this.isConnected || !this.serialPort || !this.protocolHandler) return;

        try {
            const command = this.protocolHandler.buildSetModeCommand(mode);
            await this.sendCommand(command);
            this.addMessage(`Set radio mode: ${mode.toUpperCase()}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set mode: ${error.message}`, 'error');
        }
    }
    
    async sendCommand(command) {
        if (!this.serialPort || !this.serialPort.writable) {
            throw new Error('Serial port not writable');
        }
        
        const writer = this.serialPort.writable.getWriter();
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(command);
            await writer.write(data);
            this.addMessage(`TX: ${command.trim()}`, 'info');
        } finally {
            writer.releaseLock();
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

        // Filter radio options based on available protocols (do this first, before event listeners)
        this.filterAvailableRadios();

        // Set up event listeners now that template is definitely in DOM
        this.setupEventListeners();

        // Subscribe to radio events for SDR changes
        console.log('About to subscribe to radio events...');
        console.log('RadioAPI instance:', this.radio);
        console.log('RadioAPI callbacks before:', this.radio.callbacks);
        this.subscribeToRadioEvents();
        console.log('RadioAPI callbacks after:', this.radio.callbacks);

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

        console.log('Radio Sync Extension enabled, current freq:', this.currentFrequency);
        console.log('Event listeners subscribed:', this.eventListeners.length);
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
        console.log('onFrequencyChanged called:', {
            frequency,
            updatingFromRadio: this.updatingFromRadio,
            lastSentFrequency: this.lastSentFrequency,
            isConnected: this.isConnected,
            syncMode: this.syncMode
        });

        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) {
            console.log('Blocked: updatingFromRadio is true');
            return;
        }

        // Only send if frequency actually changed from what we last sent
        if (frequency === this.lastSentFrequency) {
            console.log('Blocked: frequency matches lastSentFrequency');
            return;
        }

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            console.log('Sending frequency to radio:', frequency);
            this.lastSentFrequency = frequency;
            this.sendFrequencyToRadio(frequency);
        } else {
            console.log('Not sending: isConnected=' + this.isConnected + ', syncMode=' + this.syncMode);
        }
    }

    onModeChanged(mode) {
        console.log('onModeChanged called:', {
            mode,
            updatingFromRadio: this.updatingFromRadio,
            lastSentMode: this.lastSentMode,
            isConnected: this.isConnected,
            syncMode: this.syncMode
        });

        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) {
            console.log('Blocked: updatingFromRadio is true');
            return;
        }

        // Only send if mode actually changed from what we last sent
        if (mode === this.lastSentMode) {
            console.log('Blocked: mode matches lastSentMode');
            return;
        }

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            console.log('Sending mode to radio:', mode);
            this.lastSentMode = mode;
            this.sendModeToRadio(mode);
        } else {
            console.log('Not sending: isConnected=' + this.isConnected + ', syncMode=' + this.syncMode);
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new RadioSyncExtension());
    console.log('✅ Radio Sync Extension registered');
}