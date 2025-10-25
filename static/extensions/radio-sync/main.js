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
        this.syncMode = 'both'; // 'sdr-to-radio', 'radio-to-sdr', 'both'
        
        // State tracking
        this.currentFrequency = 0;
        this.currentMode = 'USB';
        this.txState = false; // false = RX, true = TX
        
        // Update interval
        this.updateInterval = null;
    }

    onInitialize() {
        console.log('Radio Sync Extension onInitialize called');
        this.radio.log('Radio Sync Extension initialized');
        
        // Load and render template first (so error div exists)
        this.renderUI();
        
        // Set up event listeners (must be after renderUI)
        this.setupEventListeners();
        
        // Check for Web Serial API support
        if (!('serial' in navigator)) {
            this.showSerialAPIError();
        }
        
        // Initialize display with current SDR state
        this.updateFromSDR();
        
        console.log('Radio Sync Extension initialization complete');
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
        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                this.selectedRadio = e.target.value;
                this.addMessage(`Selected: ${this.radioProtocols[this.selectedRadio]?.name || 'Unknown'}`, 'info');
            });
        } else {
            console.error('Radio Sync: model select not found');
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
        const connectBtn = document.getElementById('radio-sync-connect');
        const disconnectBtn = document.getElementById('radio-sync-disconnect');

        if (connectBtn) {
            console.log('Radio Sync: Connect button found, adding listener');
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
                } else {
                    buttons[key].classList.remove('radio-sync-btn-active');
                }
            }
        });

        this.addMessage(`Sync mode: ${mode.replace(/-/g, ' ').toUpperCase()}`, 'info');
    }


    updateFromSDR() {
        // Get current SDR state
        this.currentFrequency = this.radio.getFrequency();
        this.currentMode = this.radio.getMode();
        
        // Update displays
        this.updateFrequencyDisplay(this.currentFrequency);
        this.updateModeDisplay(this.currentMode);
    }

    updateFrequencyDisplay(freq) {
        const formatted = this.formatFrequencyLED(freq);
        this.updateElementById('radio-sync-freq-display', (el) => {
            el.textContent = formatted;
        });
    }

    formatFrequencyLED(hz) {
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
            el.textContent = mode.toUpperCase();
        });
    }

    updateTXRXState(isTX) {
        this.txState = isTX;
        
        const rxLed = document.getElementById('radio-sync-rx-led');
        const txLed = document.getElementById('radio-sync-tx-led');
        
        if (rxLed && txLed) {
            if (isTX) {
                rxLed.classList.remove('active');
                txLed.classList.add('active');
            } else {
                rxLed.classList.add('active');
                txLed.classList.remove('active');
            }
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
            
            // Update status badge
            this.updateStatusBadge('Connected', 'decoder-active');

            // Start reading from radio (for radio-to-sdr sync)
            if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                this.startReading();
            }

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
            this.updateStatusBadge('Disconnected', 'decoder-inactive');

        } catch (error) {
            this.addMessage(`Disconnect error: ${error.message}`, 'error');
        }
    }

    updateConnectionUI(connected) {
        const connectBtn = document.getElementById('radio-sync-connect');
        const disconnectBtn = document.getElementById('radio-sync-disconnect');

        if (connectBtn && disconnectBtn) {
            if (connected) {
                connectBtn.style.display = 'none';
                disconnectBtn.style.display = 'block';
            } else {
                connectBtn.style.display = 'block';
                disconnectBtn.style.display = 'none';
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
                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    // Update SDR frequency
                    this.radio.setFrequency(response.frequency);
                }
                break;
                
            case 'mode':
                this.addMessage(`Radio mode: ${response.mode}`, 'info');
                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    // Update SDR mode
                    const sdrMode = response.mode.toLowerCase();
                    this.radio.setMode(sdrMode);
                }
                break;
                
            case 'status':
                // Full status from IF command
                this.addMessage(`Radio status: ${this.radio.formatFrequency(response.frequency)} ${response.mode} ${response.transmitting ? 'TX' : 'RX'}`, 'info');
                this.updateTXRXState(response.transmitting);
                
                if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
                    this.radio.setFrequency(response.frequency);
                    const sdrMode = response.mode.toLowerCase();
                    this.radio.setMode(sdrMode);
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

        // Keep only last 50 messages
        while (messagesDiv.children.length > 50) {
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
        this.addMessage('Radio Sync extension enabled', 'success');
        
        // Check for Web Serial API support and show error if not available
        if (!('serial' in navigator)) {
            this.showSerialAPIError();
        }
        
        // Start periodic updates to poll SDR state (like Stats extension)
        this.updateInterval = setInterval(() => {
            this.pollSDRState();
        }, 500); // Update every 500ms
        
        // Initial update
        this.updateFromSDR();
        
        console.log('Radio Sync Extension enabled, current freq:', this.currentFrequency);
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
        // Poll current SDR state and update if changed
        const newFreq = this.radio.getFrequency();
        const newMode = this.radio.getMode();
        
        // Check if frequency changed
        if (newFreq !== this.currentFrequency) {
            console.log('Radio Sync: Frequency changed from', this.currentFrequency, 'to', newFreq);
            this.currentFrequency = newFreq;
            this.updateFrequencyDisplay(newFreq);
            
            // Sync to radio if enabled
            if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
                this.sendFrequencyToRadio(newFreq);
            }
        }
        
        // Check if mode changed
        if (newMode !== this.currentMode) {
            console.log('Radio Sync: Mode changed from', this.currentMode, 'to', newMode);
            this.currentMode = newMode;
            this.updateModeDisplay(newMode);
            
            // Sync to radio if enabled
            if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
                this.sendModeToRadio(newMode);
            }
        }
    }

    onProcessAudio(dataArray) {
        // Not used for this extension
    }

    onFrequencyChanged(frequency) {
        // Polling handles this, but keep for compatibility
    }

    onModeChanged(mode) {
        // Polling handles this, but keep for compatibility
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new RadioSyncExtension());
    console.log('✅ Radio Sync Extension registered');
}