// UberSDR Go Client Frontend JavaScript

class UberSDRClient {
    constructor() {
        this.apiBase = window.location.origin;
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        
        this.initializeElements();
        this.attachEventListeners();
        this.loadSavedConfig();
        this.loadAudioDevices();
        this.updateStatus();
        this.connectWebSocket();
    }

    initializeElements() {
        // Connection elements
        this.hostInput = document.getElementById('host');
        this.portInput = document.getElementById('port');
        this.sslCheckbox = document.getElementById('ssl');
        this.passwordInput = document.getElementById('password');
        this.connectBtn = document.getElementById('connect-btn');
        this.disconnectBtn = document.getElementById('disconnect-btn');
        
        // Frequency elements
        this.frequencyInput = document.getElementById('frequency-input');
        this.frequencyButtons = document.querySelectorAll('.frequency-buttons .btn');
        this.bandButtons = document.querySelectorAll('.btn-band');
        
        // Mode and bandwidth elements
        this.modeSelect = document.getElementById('mode');
        this.bandwidthLowInput = document.getElementById('bandwidth-low');
        this.bandwidthHighInput = document.getElementById('bandwidth-high');
        this.applySettingsBtn = document.getElementById('apply-settings-btn');
        
        // Audio elements
        this.audioDeviceSelect = document.getElementById('audio-device');
        this.outputModeSelect = document.getElementById('output-mode');
        
        // NR2 elements
        this.nr2EnabledCheckbox = document.getElementById('nr2-enabled');
        this.nr2StrengthInput = document.getElementById('nr2-strength');
        this.nr2FloorInput = document.getElementById('nr2-floor');
        this.nr2AdaptInput = document.getElementById('nr2-adapt');
        
        // Status elements
        this.connectionStatus = document.getElementById('connection-status');
        this.uptimeSpan = document.getElementById('uptime');
        this.statusFrequency = document.getElementById('status-frequency');
        this.statusMode = document.getElementById('status-mode');
        this.statusSampleRate = document.getElementById('status-samplerate');
        this.statusChannels = document.getElementById('status-channels');
        this.statusSession = document.getElementById('status-session');
        this.statusAudioDevice = document.getElementById('status-audio-device');
    }

    attachEventListeners() {
        // Connection buttons
        this.connectBtn.addEventListener('click', () => this.connect());
        this.disconnectBtn.addEventListener('click', () => this.disconnect());
        
        // Frequency controls
        this.frequencyInput.addEventListener('change', () => this.updateFrequency());
        this.frequencyButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const step = parseInt(e.target.dataset.step);
                this.adjustFrequency(step);
            });
        });
        this.bandButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const freq = parseInt(e.target.dataset.freq);
                this.setFrequency(freq);
            });
        });
        
        // Mode change
        this.modeSelect.addEventListener('change', () => this.updateModeDefaults());
        
        // Apply settings button
        this.applySettingsBtn.addEventListener('click', () => this.applySettings());
        
        // NR2 settings
        this.nr2EnabledCheckbox.addEventListener('change', () => this.updateNR2Config());
        this.nr2StrengthInput.addEventListener('change', () => this.updateNR2Config());
        this.nr2FloorInput.addEventListener('change', () => this.updateNR2Config());
        this.nr2AdaptInput.addEventListener('change', () => this.updateNR2Config());
    }

    connectWebSocket() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleWebSocketMessage(data);
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e);
            }
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.ws = null;
            
            // Attempt to reconnect
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                setTimeout(() => this.connectWebSocket(), 2000 * this.reconnectAttempts);
            }
        };
    }

    handleWebSocketMessage(data) {
        if (data.type === 'status') {
            this.updateStatusDisplay(data);
        } else if (data.type === 'connection') {
            this.handleConnectionUpdate(data);
        } else if (data.type === 'error') {
            this.showError(data.error, data.message);
        } else if (data.connected !== undefined) {
            // Initial status message
            this.updateStatusDisplay(data);
        }
    }

    handleConnectionUpdate(data) {
        this.connected = data.connected;
        this.updateConnectionUI();
        
        if (data.connected) {
            this.showSuccess('Connected to SDR server');
        } else {
            this.showInfo(`Disconnected: ${data.reason || 'Unknown reason'}`);
        }
    }

    async connect() {
        const config = {
            host: this.hostInput.value,
            port: parseInt(this.portInput.value),
            ssl: this.sslCheckbox.checked,
            frequency: parseInt(this.frequencyInput.value),
            mode: this.modeSelect.value,
            bandwidthLow: parseInt(this.bandwidthLowInput.value),
            bandwidthHigh: parseInt(this.bandwidthHighInput.value),
            password: this.passwordInput.value,
            outputMode: this.outputModeSelect.value,
            audioDevice: parseInt(this.audioDeviceSelect.value),
            nr2Enabled: this.nr2EnabledCheckbox.checked,
            nr2Strength: parseFloat(this.nr2StrengthInput.value),
            nr2Floor: parseFloat(this.nr2FloorInput.value),
            nr2AdaptRate: parseFloat(this.nr2AdaptInput.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();
            
            if (response.ok) {
                this.connected = true;
                this.updateConnectionUI();
                this.showSuccess(data.message || 'Connected successfully');
                this.updateStatus();
            } else {
                this.showError('Connection failed', data.message || data.error);
            }
        } catch (error) {
            this.showError('Connection error', error.message);
        }
    }

    async disconnect() {
        try {
            const response = await fetch(`${this.apiBase}/api/disconnect`, {
                method: 'POST'
            });

            const data = await response.json();
            
            if (response.ok) {
                this.connected = false;
                this.updateConnectionUI();
                this.showSuccess(data.message || 'Disconnected successfully');
            } else {
                this.showError('Disconnect failed', data.message || data.error);
            }
        } catch (error) {
            this.showError('Disconnect error', error.message);
        }
    }

    async updateStatus() {
        try {
            const response = await fetch(`${this.apiBase}/api/status`);
            const status = await response.json();
            
            this.connected = status.connected;
            this.updateConnectionUI();
            this.updateStatusDisplay(status);
        } catch (error) {
            console.error('Failed to fetch status:', error);
        }
        
        // Poll status every 2 seconds
        setTimeout(() => this.updateStatus(), 2000);
    }

    updateStatusDisplay(status) {
        if (status.frequency) {
            this.statusFrequency.textContent = this.formatFrequency(status.frequency);
        }
        if (status.mode) {
            this.statusMode.textContent = status.mode.toUpperCase();
        }
        if (status.sampleRate) {
            this.statusSampleRate.textContent = `${status.sampleRate} Hz`;
        }
        if (status.channels) {
            this.statusChannels.textContent = status.channels;
        }
        // Check both sessionId (from server) and userSessionId (client-generated)
        if (status.sessionId) {
            this.statusSession.textContent = status.sessionId.substring(0, 8);
        } else if (status.userSessionId) {
            this.statusSession.textContent = status.userSessionId.substring(0, 8);
        }
        if (status.audioDevice) {
            this.statusAudioDevice.textContent = status.audioDevice;
        }
        if (status.uptime) {
            this.uptimeSpan.textContent = `Uptime: ${status.uptime}`;
        }
    }

    async applySettings() {
        if (!this.connected) {
            this.showError('Not connected', 'Connect to SDR server first');
            return;
        }

        const tuneRequest = {
            frequency: parseInt(this.frequencyInput.value),
            mode: this.modeSelect.value,
            bandwidthLow: parseInt(this.bandwidthLowInput.value),
            bandwidthHigh: parseInt(this.bandwidthHighInput.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/tune`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tuneRequest)
            });

            const data = await response.json();
            
            if (response.ok) {
                this.showSuccess('Settings applied');
            } else {
                this.showError('Failed to apply settings', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error applying settings', error.message);
        }
    }

    async updateFrequency() {
        if (!this.connected) return;
        
        const frequency = parseInt(this.frequencyInput.value);
        
        try {
            const response = await fetch(`${this.apiBase}/api/frequency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frequency })
            });

            if (!response.ok) {
                const data = await response.json();
                this.showError('Failed to set frequency', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error setting frequency', error.message);
        }
    }

    adjustFrequency(step) {
        const currentFreq = parseInt(this.frequencyInput.value);
        const newFreq = currentFreq + step;
        this.setFrequency(newFreq);
    }

    setFrequency(frequency) {
        this.frequencyInput.value = frequency;
        if (this.connected) {
            this.updateFrequency();
        }
    }

    updateModeDefaults() {
        const mode = this.modeSelect.value;
        const defaults = {
            'usb': [50, 2700],
            'lsb': [-2700, -50],
            'am': [-5000, 5000],
            'sam': [-5000, 5000],
            'cwu': [-200, 200],
            'cwl': [-200, 200],
            'fm': [-8000, 8000],
            'nfm': [-5000, 5000],
            'iq': [-5000, 5000],
            'iq48': [-5000, 5000],
            'iq96': [-5000, 5000],
            'iq192': [-5000, 5000],
            'iq384': [-5000, 5000]
        };
        
        if (defaults[mode]) {
            this.bandwidthLowInput.value = defaults[mode][0];
            this.bandwidthHighInput.value = defaults[mode][1];
        }
    }

    async updateNR2Config() {
        const config = {
            nr2Enabled: this.nr2EnabledCheckbox.checked,
            nr2Strength: parseFloat(this.nr2StrengthInput.value),
            nr2Floor: parseFloat(this.nr2FloorInput.value),
            nr2AdaptRate: parseFloat(this.nr2AdaptInput.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                this.showError('Failed to update NR2 config', data.message || data.error);
            }
        } catch (error) {
            console.error('Error updating NR2 config:', error);
        }
    }

    async loadSavedConfig() {
        try {
            const response = await fetch(`${this.apiBase}/api/config`);
            if (response.ok) {
                const config = await response.json();
                
                // Populate form fields with saved config
                if (config.host) this.hostInput.value = config.host;
                if (config.port) this.portInput.value = config.port;
                if (config.ssl !== undefined) this.sslCheckbox.checked = config.ssl;
                if (config.frequency) this.frequencyInput.value = config.frequency;
                if (config.mode) this.modeSelect.value = config.mode;
                if (config.bandwidthLow !== null && config.bandwidthLow !== undefined) {
                    this.bandwidthLowInput.value = config.bandwidthLow;
                }
                if (config.bandwidthHigh !== null && config.bandwidthHigh !== undefined) {
                    this.bandwidthHighInput.value = config.bandwidthHigh;
                }
                if (config.outputMode) this.outputModeSelect.value = config.outputMode;
                if (config.audioDevice !== undefined) this.audioDeviceSelect.value = config.audioDevice;
                if (config.nr2Enabled !== undefined) this.nr2EnabledCheckbox.checked = config.nr2Enabled;
                if (config.nr2Strength) this.nr2StrengthInput.value = config.nr2Strength;
                if (config.nr2Floor) this.nr2FloorInput.value = config.nr2Floor;
                if (config.nr2AdaptRate) this.nr2AdaptInput.value = config.nr2AdaptRate;
                
                console.log('Loaded saved configuration');
            }
        } catch (error) {
            console.error('Failed to load saved config:', error);
        }
    }

    async loadAudioDevices() {
        try {
            const response = await fetch(`${this.apiBase}/api/devices`);
            const data = await response.json();
            
            if (data.devices) {
                this.audioDeviceSelect.innerHTML = '<option value="-1">Default Device</option>';
                data.devices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.index;
                    option.textContent = `[${device.index}] ${device.name}${device.isDefault ? ' (default)' : ''}`;
                    this.audioDeviceSelect.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Failed to load audio devices:', error);
        }
    }

    updateConnectionUI() {
        if (this.connected) {
            this.connectionStatus.textContent = 'Connected';
            this.connectionStatus.className = 'status-badge connected';
            this.connectBtn.disabled = true;
            this.disconnectBtn.disabled = false;
            this.applySettingsBtn.disabled = false;
        } else {
            this.connectionStatus.textContent = 'Disconnected';
            this.connectionStatus.className = 'status-badge disconnected';
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
            this.applySettingsBtn.disabled = true;
            this.uptimeSpan.textContent = '';
        }
    }

    formatFrequency(hz) {
        if (hz >= 1000000) {
            return `${(hz / 1000000).toFixed(3)} MHz`;
        } else if (hz >= 1000) {
            return `${(hz / 1000).toFixed(1)} kHz`;
        }
        return `${hz} Hz`;
    }

    showSuccess(message) {
        console.log('✓', message);
        // Could add toast notifications here
    }

    showError(error, message) {
        console.error('✗', error, message);
        alert(`Error: ${error}\n${message || ''}`);
    }

    showInfo(message) {
        console.log('ℹ', message);
    }
}

// Initialize the client when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.uberSDR = new UberSDRClient();
});