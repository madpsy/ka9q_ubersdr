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
        this.loadSavedInstances();
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
        this.autoConnectCheckbox = document.getElementById('auto-connect');
        this.connectBtn = document.getElementById('connect-btn');
        this.disconnectBtn = document.getElementById('disconnect-btn');

        // Saved instances elements
        this.savedInstancesSelect = document.getElementById('saved-instances');
        this.saveInstanceBtn = document.getElementById('save-instance-btn');
        this.deleteInstanceBtn = document.getElementById('delete-instance-btn');

        // Frequency elements
        this.frequencyInput = document.getElementById('frequency-input');
        this.frequencyButtons = document.querySelectorAll('.frequency-buttons .btn');
        this.bandButtons = document.querySelectorAll('.btn-band');

        // Mode and bandwidth elements
        this.modeSelect = document.getElementById('mode');
        this.bandwidthLowInput = document.getElementById('bandwidth-low');
        this.bandwidthHighInput = document.getElementById('bandwidth-high');
        this.applySettingsBtn = document.getElementById('apply-settings-btn');

        // Audio preview elements
        this.audioPreviewEnabled = document.getElementById('audio-preview-enabled');
        this.audioPreviewControls = document.getElementById('audio-preview-controls');
        this.audioPreviewStatus = document.getElementById('audio-preview-status');
        this.audioMuteBtn = document.getElementById('audio-mute-btn');
        this.spectrumCanvas = document.getElementById('audio-spectrum-canvas');
        this.waterfallCanvas = document.getElementById('audio-waterfall-canvas');

        // RF Spectrum elements
        this.spectrumEnabled = document.getElementById('spectrum-enabled');
        this.spectrumDisplayContainer = document.getElementById('spectrum-display-container');
        this.spectrumStatus = document.getElementById('spectrum-status');
        this.rfSpectrumCanvas = document.getElementById('rf-spectrum-canvas');
        this.rfWaterfallCanvas = document.getElementById('rf-waterfall-canvas');
        this.spectrumZoomScrollCheckbox = document.getElementById('spectrum-zoom-scroll');
        this.spectrumPanScrollCheckbox = document.getElementById('spectrum-pan-scroll');
        this.spectrumClickTuneCheckbox = document.getElementById('spectrum-click-tune');
        this.spectrumCenterTuneCheckbox = document.getElementById('spectrum-center-tune');

        // NR2 elements
        this.nr2EnabledCheckbox = document.getElementById('nr2-enabled');
        this.nr2StrengthInput = document.getElementById('nr2-strength');
        this.nr2FloorInput = document.getElementById('nr2-floor');
        this.nr2AdaptInput = document.getElementById('nr2-adapt');

        // Resampling elements
        this.resampleEnabledCheckbox = document.getElementById('resample-enabled');
        this.resampleRateSelect = document.getElementById('resample-rate');
        this.outputChannelsSelect = document.getElementById('output-channels');

        // Dynamic output control elements
        this.portaudioOutputEnabled = document.getElementById('portaudio-output-enabled');
        this.portaudioDeviceSelect = document.getElementById('portaudio-device-select');
        this.fifoOutputEnabled = document.getElementById('fifo-output-enabled');
        this.fifoOutputPath = document.getElementById('fifo-output-path');
        this.udpOutputEnabled = document.getElementById('udp-output-enabled');
        this.udpOutputHost = document.getElementById('udp-output-host');
        this.udpOutputPort = document.getElementById('udp-output-port');

        // Status elements
        this.connectionStatus = document.getElementById('connection-status');
        this.uptimeSpan = document.getElementById('uptime');
        this.statusFrequency = document.getElementById('status-frequency');
        this.statusMode = document.getElementById('status-mode');
        this.statusSampleRate = document.getElementById('status-samplerate');
        this.statusChannels = document.getElementById('status-channels');
        this.statusSession = document.getElementById('status-session');
        this.statusAudioDevice = document.getElementById('status-audio-device');

        // Radio control elements
        this.radioControlType = document.getElementById('radio-control-type');
        this.flrigControls = document.getElementById('flrig-controls');
        this.flrigHost = document.getElementById('flrig-host');
        this.flrigPort = document.getElementById('flrig-port');
        this.flrigVFO = document.getElementById('flrig-vfo');
        this.flrigSyncToRig = document.getElementById('flrig-sync-to-rig');
        this.flrigSyncFromRig = document.getElementById('flrig-sync-from-rig');
        this.flrigConnectBtn = document.getElementById('flrig-connect-btn');
        this.flrigDisconnectBtn = document.getElementById('flrig-disconnect-btn');
        this.flrigStatusDisplay = document.getElementById('flrig-status-display');
        this.flrigConnectionStatus = document.getElementById('flrig-connection-status');
        this.flrigFrequency = document.getElementById('flrig-frequency');
        this.flrigMode = document.getElementById('flrig-mode');
        this.flrigVFOStatus = document.getElementById('flrig-vfo-status');
        this.flrigPTT = document.getElementById('flrig-ptt');

        // Audio streaming state
        this.audioStreamActive = false;
        this.audioQueue = [];
        this.audioMuted = true; // Muted by default

        // Audio visualizer
        this.audioVisualizer = null;

        // RF Spectrum display
        this.spectrumDisplay = null;

        // Saved instances
        this.savedInstances = [];
    }

    attachEventListeners() {
        // Connection buttons
        this.connectBtn.addEventListener('click', () => this.connect());
        this.disconnectBtn.addEventListener('click', () => this.disconnect());

        // Saved instances buttons
        if (this.saveInstanceBtn) {
            this.saveInstanceBtn.addEventListener('click', () => this.saveCurrentInstance());
        }
        if (this.deleteInstanceBtn) {
            this.deleteInstanceBtn.addEventListener('click', () => this.deleteSelectedInstance());
        }
        if (this.savedInstancesSelect) {
            this.savedInstancesSelect.addEventListener('change', () => this.onInstanceSelected());
        }

        // Instance discovery buttons
        const localInstancesBtn = document.getElementById('local-instances-btn');
        const publicInstancesBtn = document.getElementById('public-instances-btn');
        if (localInstancesBtn) {
            localInstancesBtn.addEventListener('click', () => this.showLocalInstances());
        }
        if (publicInstancesBtn) {
            publicInstancesBtn.addEventListener('click', () => this.showPublicInstances());
        }

        // Modal close buttons
        document.querySelectorAll('.close, .modal-footer .btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modalId = e.target.dataset.modal || e.target.closest('.modal-content')?.parentElement.id;
                if (modalId) {
                    this.closeModal(modalId);
                }
            });
        });

        // Close modal when clicking outside
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeModal(e.target.id);
            }
        });

        // Public instances filter
        const publicFilter = document.getElementById('public-filter');
        if (publicFilter) {
            publicFilter.addEventListener('input', (e) => this.filterPublicInstances(e.target.value));
        }

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

        // Audio preview settings
        this.audioPreviewEnabled.addEventListener('change', () => {
            this.toggleAudioPreview();
            this.saveAudioPreviewConfig();
        });
        this.audioMuteBtn.addEventListener('click', () => {
            this.toggleMute();
            this.saveAudioPreviewConfig();
        });

        // Auto-connect setting
        this.autoConnectCheckbox.addEventListener('change', () => {
            console.log('Auto-connect changed to:', this.autoConnectCheckbox.checked);
            this.saveAutoConnectConfig();
        });

        // RF Spectrum settings
        this.spectrumEnabled.addEventListener('change', () => {
            this.toggleSpectrumDisplay();
            this.saveSpectrumConfig();
        });

        // Spectrum control checkboxes
        this.spectrumZoomScrollCheckbox.addEventListener('change', () => {
            if (this.spectrumZoomScrollCheckbox.checked) {
                this.spectrumPanScrollCheckbox.checked = false;
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.setScrollMode('zoom');
                }
            }
            this.saveSpectrumConfig();
        });

        this.spectrumPanScrollCheckbox.addEventListener('change', () => {
            if (this.spectrumPanScrollCheckbox.checked) {
                this.spectrumZoomScrollCheckbox.checked = false;
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.setScrollMode('pan');
                }
            }
            this.saveSpectrumConfig();
        });

        this.spectrumClickTuneCheckbox.addEventListener('change', () => {
            if (this.spectrumDisplay) {
                this.spectrumDisplay.setClickTuneEnabled(this.spectrumClickTuneCheckbox.checked);
            }
            this.saveSpectrumConfig();
        });

        this.spectrumCenterTuneCheckbox.addEventListener('change', () => {
            if (this.spectrumDisplay) {
                this.spectrumDisplay.setCenterTuneEnabled(this.spectrumCenterTuneCheckbox.checked);
            }
            this.saveSpectrumConfig();
        });

        // Dynamic output control event listeners
        this.portaudioOutputEnabled.addEventListener('change', () => this.togglePortAudioOutput());
        this.fifoOutputEnabled.addEventListener('change', () => this.toggleFIFOOutput());
        this.udpOutputEnabled.addEventListener('change', () => this.toggleUDPOutput());

        // Radio control event listeners
        this.radioControlType.addEventListener('change', () => this.onRadioControlTypeChanged());
        this.flrigConnectBtn.addEventListener('click', () => this.connectFlrig());
        this.flrigDisconnectBtn.addEventListener('click', () => this.disconnectFlrig());
        this.flrigSyncToRig.addEventListener('change', () => this.updateFlrigSync());
        this.flrigSyncFromRig.addEventListener('change', () => this.updateFlrigSync());
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
        } else if (data.type === 'audio') {
            this.handleAudioData(data);
        } else if (data.type === 'config' || data.type === 'spectrum') {
            // Forward to spectrum display
            if (this.spectrumDisplay) {
                this.spectrumDisplay.handleMessage(data);
            }
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
            outputMode: "portaudio", // Default to portaudio
            audioDevice: -1, // Default device
            nr2Enabled: this.nr2EnabledCheckbox.checked,
            nr2Strength: parseFloat(this.nr2StrengthInput.value),
            nr2Floor: parseFloat(this.nr2FloorInput.value),
            nr2AdaptRate: parseFloat(this.nr2AdaptInput.value),
            resampleEnabled: this.resampleEnabledCheckbox.checked,
            resampleOutputRate: parseInt(this.resampleRateSelect.value),
            outputChannels: parseInt(this.outputChannelsSelect.value),
            fifoPath: "", // Will be set dynamically
            udpEnabled: false, // Will be set dynamically
            udpHost: "127.0.0.1",
            udpPort: 8888
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

                // Update output status after a delay to allow backend restoration
                setTimeout(() => this.updateOutputStatus(), 1000);

                // Enable spectrum display if checkbox is checked
                if (this.spectrumEnabled.checked) {
                    setTimeout(() => this.enableSpectrumDisplay(), 500);
                }
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

                // Disable spectrum display
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.disable();
                }
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

        // Also update output status
        this.updateOutputStatus();
    }

    updateStatusDisplay(status) {
        if (status.frequency) {
            this.statusFrequency.textContent = this.formatFrequency(status.frequency);
            // Also update the frequency input field for real-time sync
            if (this.frequencyInput.value != status.frequency) {
                this.frequencyInput.value = status.frequency;

                // Update spectrum display if active
                if (this.spectrumDisplay && this.spectrumDisplay.totalBandwidth > 0) {
                    this.spectrumDisplay.tunedFreq = status.frequency;

                    // Check if new frequency is outside the currently displayed bandwidth
                    const halfBw = this.spectrumDisplay.totalBandwidth / 2;
                    const startFreq = this.spectrumDisplay.centerFreq - halfBw;
                    const endFreq = this.spectrumDisplay.centerFreq + halfBw;
                    const isOutsideView = status.frequency < startFreq || status.frequency > endFreq;

                    // If center-tune is enabled or frequency is outside view, re-center
                    if (this.spectrumDisplay.centerTuneEnabled || isOutsideView) {
                        this.spectrumDisplay.sendZoomCommand(status.frequency, this.spectrumDisplay.totalBandwidth);
                    }
                }
            }
        }
        if (status.mode) {
            this.statusMode.textContent = status.mode.toUpperCase();
            // Also update the mode select for real-time sync
            if (this.modeSelect.value != status.mode) {
                this.modeSelect.value = status.mode;
            }
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

                // Update spectrum display with new bandwidth
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.updateBandwidth(tuneRequest.bandwidthLow, tuneRequest.bandwidthHigh);
                }
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
            } else {
                // Update spectrum display with new tuned frequency
                if (this.spectrumDisplay && this.spectrumDisplay.totalBandwidth > 0) {
                    this.spectrumDisplay.tunedFreq = frequency;

                    // Check if new frequency is outside the currently displayed bandwidth
                    const halfBw = this.spectrumDisplay.totalBandwidth / 2;
                    const startFreq = this.spectrumDisplay.centerFreq - halfBw;
                    const endFreq = this.spectrumDisplay.centerFreq + halfBw;
                    const isOutsideView = frequency < startFreq || frequency > endFreq;

                    // If center-tune is enabled, always re-center on the new frequency
                    // If center-tune is disabled but frequency is outside view, pan to show it
                    if (this.spectrumDisplay.centerTuneEnabled || isOutsideView) {
                        this.spectrumDisplay.sendZoomCommand(frequency, this.spectrumDisplay.totalBandwidth);
                    }
                }
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
                if (config.nr2Enabled !== undefined) this.nr2EnabledCheckbox.checked = config.nr2Enabled;
                if (config.nr2Strength) this.nr2StrengthInput.value = config.nr2Strength;
                if (config.nr2Floor) this.nr2FloorInput.value = config.nr2Floor;
                if (config.nr2AdaptRate) this.nr2AdaptInput.value = config.nr2AdaptRate;
                if (config.resampleEnabled !== undefined) this.resampleEnabledCheckbox.checked = config.resampleEnabled;
                if (config.resampleOutputRate) this.resampleRateSelect.value = config.resampleOutputRate;
                if (config.outputChannels !== undefined) this.outputChannelsSelect.value = config.outputChannels;
                
                // Load audio preview settings
                if (config.audioPreviewEnabled !== undefined) {
                    this.audioPreviewEnabled.checked = config.audioPreviewEnabled;
                    if (config.audioPreviewEnabled) {
                        this.toggleAudioPreview();
                    }
                }
                if (config.audioPreviewMuted !== undefined) {
                    this.audioMuted = config.audioPreviewMuted;
                    this.updateMuteButton();
                }

                // Load auto-connect setting
                if (config.autoConnect !== undefined) {
                    this.autoConnectCheckbox.checked = config.autoConnect;

                    // Auto-connect if enabled and not already connected
                    // Check connection status first to avoid duplicate connection attempts
                    if (config.autoConnect) {
                        console.log('Auto-connect is enabled, checking connection status...');
                        // Wait a bit for status to be updated, then check if we need to connect
                        setTimeout(() => {
                            if (!this.connected) {
                                console.log('Not connected, attempting auto-connect...');
                                this.connect();
                            } else {
                                console.log('Already connected (backend auto-connect succeeded)');
                            }
                        }, 1500); // Increased delay to allow status update
                    }
                }

                // Load spectrum control settings with defaults
                // Note: spectrumEnabled is always unchecked on page load to avoid timing issues
                this.spectrumEnabled.checked = false;
                this.spectrumDisplayContainer.style.display = 'none';

                // Set spectrum control checkboxes - use saved values or defaults
                this.spectrumZoomScrollCheckbox.checked = (config.spectrumZoomScroll !== undefined) ? config.spectrumZoomScroll : true;
                this.spectrumPanScrollCheckbox.checked = (config.spectrumPanScroll !== undefined) ? config.spectrumPanScroll : false;
                this.spectrumClickTuneCheckbox.checked = (config.spectrumClickTune !== undefined) ? config.spectrumClickTune : true;
                this.spectrumCenterTuneCheckbox.checked = (config.spectrumCenterTune !== undefined) ? config.spectrumCenterTune : true;

                console.log('Loaded spectrum config (enabled always starts unchecked):', {
                    zoomScroll: config.spectrumZoomScroll,
                    panScroll: config.spectrumPanScroll,
                    clickTune: config.spectrumClickTune,
                    centerTune: config.spectrumCenterTune
                });

                console.log('Loaded saved configuration');
            }
        } catch (error) {
            console.error('Failed to load saved config:', error);
        }
    }

    async saveAutoConnectConfig() {
        const autoConnectValue = this.autoConnectCheckbox.checked;
        const config = {
            autoConnect: autoConnectValue
        };

        console.log('Saving auto-connect config:', config);

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save auto-connect config:', data.message || data.error);
            } else {
                const result = await response.json();
                console.log('Auto-connect setting saved successfully:', autoConnectValue, result);
            }
        } catch (error) {
            console.error('Error saving auto-connect config:', error);
        }
    }

    async saveAudioPreviewConfig() {
        const config = {
            audioPreviewEnabled: this.audioPreviewEnabled.checked,
            audioPreviewMuted: this.audioMuted
        };

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save audio preview config:', data.message || data.error);
            }
        } catch (error) {
            console.error('Error saving audio preview config:', error);
        }
    }

    async saveSpectrumConfig() {
        const config = {
            spectrumEnabled: this.spectrumEnabled.checked,
            spectrumZoomScroll: this.spectrumZoomScrollCheckbox.checked,
            spectrumPanScroll: this.spectrumPanScrollCheckbox.checked,
            spectrumClickTune: this.spectrumClickTuneCheckbox.checked,
            spectrumCenterTune: this.spectrumCenterTuneCheckbox.checked
        };

        console.log('Saving spectrum config:', config);

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save spectrum config:', data.message || data.error);
            } else {
                const result = await response.json();
                console.log('Spectrum config saved successfully:', result);
            }
        } catch (error) {
            console.error('Error saving spectrum config:', error);
        }
    }

    async loadAudioDevices() {
        try {
            const response = await fetch(`${this.apiBase}/api/devices`);
            const data = await response.json();

            if (data.devices) {
                // Update portaudio device select (audioDeviceSelect is not used in this client)
                if (this.portaudioDeviceSelect) {
                    this.portaudioDeviceSelect.innerHTML = '<option value="-1">Default Device</option>';

                    data.devices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.index;
                        option.textContent = `[${device.index}] ${device.name}${device.isDefault ? ' (default)' : ''}`;
                        this.portaudioDeviceSelect.appendChild(option);
                    });
                }
            }
        } catch (error) {
            console.error('Failed to load audio devices:', error);
        }
    }

    // Dynamic Output Control Methods

    async togglePortAudioOutput() {
        const enabled = this.portaudioOutputEnabled.checked;
        const deviceIndex = parseInt(this.portaudioDeviceSelect.value);

        try {
            const response = await fetch(`${this.apiBase}/api/outputs/portaudio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, deviceIndex })
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || (enabled ? 'PortAudio enabled' : 'PortAudio disabled'));
                // Lock/unlock device select
                this.portaudioDeviceSelect.disabled = enabled;
            } else {
                this.showError('Failed to toggle PortAudio', data.message || data.error);
                // Revert checkbox
                this.portaudioOutputEnabled.checked = !enabled;
            }
        } catch (error) {
            this.showError('Error toggling PortAudio', error.message);
            // Revert checkbox
            this.portaudioOutputEnabled.checked = !enabled;
        }
    }

    async toggleFIFOOutput() {
        const enabled = this.fifoOutputEnabled.checked;
        const path = this.fifoOutputPath.value;

        if (enabled && !path) {
            this.showError('FIFO path required', 'Please enter a FIFO path');
            this.fifoOutputEnabled.checked = false;
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/api/outputs/fifo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, path })
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || (enabled ? 'FIFO enabled' : 'FIFO disabled'));
                // Lock/unlock path input
                this.fifoOutputPath.disabled = enabled;
            } else {
                this.showError('Failed to toggle FIFO', data.message || data.error);
                // Revert checkbox
                this.fifoOutputEnabled.checked = !enabled;
            }
        } catch (error) {
            this.showError('Error toggling FIFO', error.message);
            // Revert checkbox
            this.fifoOutputEnabled.checked = !enabled;
        }
    }

    async toggleUDPOutput() {
        const enabled = this.udpOutputEnabled.checked;
        const host = this.udpOutputHost.value;
        const port = parseInt(this.udpOutputPort.value);

        try {
            const response = await fetch(`${this.apiBase}/api/outputs/udp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, host, port })
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || (enabled ? 'UDP enabled' : 'UDP disabled'));
                // Lock/unlock host/port inputs
                this.udpOutputHost.disabled = enabled;
                this.udpOutputPort.disabled = enabled;
            } else {
                this.showError('Failed to toggle UDP', data.message || data.error);
                // Revert checkbox
                this.udpOutputEnabled.checked = !enabled;
            }
        } catch (error) {
            this.showError('Error toggling UDP', error.message);
            // Revert checkbox
            this.udpOutputEnabled.checked = !enabled;
        }
    }

    async updateOutputStatus() {
        if (!this.connected) {
            // Disable all output controls when not connected
            this.portaudioOutputEnabled.disabled = true;
            this.fifoOutputEnabled.disabled = true;
            this.udpOutputEnabled.disabled = true;
            return;
        }

        // Enable controls when connected
        this.portaudioOutputEnabled.disabled = false;
        this.fifoOutputEnabled.disabled = false;
        this.udpOutputEnabled.disabled = false;

        try {
            const response = await fetch(`${this.apiBase}/api/outputs/status`);
            if (response.ok) {
                const status = await response.json();

                // Update PortAudio status
                if (status.portaudio) {
                    this.portaudioOutputEnabled.checked = status.portaudio.enabled;
                    this.portaudioDeviceSelect.disabled = status.portaudio.enabled;
                    if (status.portaudio.deviceIndex !== undefined) {
                        this.portaudioDeviceSelect.value = status.portaudio.deviceIndex;
                    }
                }

                // Update FIFO status
                if (status.fifo) {
                    this.fifoOutputEnabled.checked = status.fifo.enabled;
                    this.fifoOutputPath.disabled = status.fifo.enabled;
                    if (status.fifo.path) {
                        this.fifoOutputPath.value = status.fifo.path;
                    }
                }

                // Update UDP status
                if (status.udp) {
                    this.udpOutputEnabled.checked = status.udp.enabled;
                    this.udpOutputHost.disabled = status.udp.enabled;
                    this.udpOutputPort.disabled = status.udp.enabled;
                    if (status.udp.host) {
                        this.udpOutputHost.value = status.udp.host;
                    }
                    if (status.udp.port) {
                        this.udpOutputPort.value = status.udp.port;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to fetch output status:', error);
        }
    }

    updateConnectionUI() {
        if (this.connected) {
            this.connectionStatus.textContent = 'Connected';
            this.connectionStatus.className = 'status-badge connected';
            this.connectBtn.disabled = true;
            this.disconnectBtn.disabled = false;
            this.applySettingsBtn.disabled = false;

            // Enable output controls
            this.updateOutputStatus();
        } else {
            this.connectionStatus.textContent = 'Disconnected';
            this.connectionStatus.className = 'status-badge disconnected';
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
            this.applySettingsBtn.disabled = true;
            this.uptimeSpan.textContent = '';

            // Disable output controls
            this.portaudioOutputEnabled.disabled = true;
            this.portaudioOutputEnabled.checked = false;
            this.fifoOutputEnabled.disabled = true;
            this.fifoOutputEnabled.checked = false;
            this.udpOutputEnabled.disabled = true;
            this.udpOutputEnabled.checked = false;
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

    // Instance Discovery Methods

    async showLocalInstances() {
        const modal = document.getElementById('local-instances-modal');
        const statusEl = document.getElementById('local-instances-status');
        const listEl = document.getElementById('local-instances-list');

        this.openModal('local-instances-modal');
        statusEl.textContent = 'Searching for local instances...';
        listEl.innerHTML = '';

        try {
            const response = await fetch(`${this.apiBase}/api/instances/local`);
            const data = await response.json();

            if (data.instances && data.instances.length > 0) {
                statusEl.textContent = `Found ${data.instances.length} local instance(s)`;
                this.renderLocalInstances(data.instances, listEl);
            } else {
                statusEl.textContent = 'No local instances found';
            }
        } catch (error) {
            statusEl.textContent = 'Error fetching local instances';
            console.error('Failed to fetch local instances:', error);
        }
    }

    renderLocalInstances(instances, container) {
        instances.forEach(instance => {
            const card = this.createInstanceCard(instance, true);
            card.addEventListener('click', () => this.connectToInstance(instance, true));
            container.appendChild(card);
        });
    }

    async showPublicInstances() {
        const modal = document.getElementById('public-instances-modal');
        const statusEl = document.getElementById('public-instances-status');
        const listEl = document.getElementById('public-instances-list');

        this.openModal('public-instances-modal');
        statusEl.textContent = 'Loading public instances...';
        listEl.innerHTML = '';

        try {
            const response = await fetch(`${this.apiBase}/api/instances/public`);
            const data = await response.json();

            if (data.instances && data.instances.length > 0) {
                this.publicInstances = data.instances;
                this.localUUIDs = new Set(data.localUUIDs || []);
                statusEl.textContent = `Showing ${data.instances.length} public instance(s)`;
                this.renderPublicInstances(data.instances, listEl);
            } else {
                statusEl.textContent = 'No public instances found';
            }
        } catch (error) {
            statusEl.textContent = 'Error fetching public instances';
            console.error('Failed to fetch public instances:', error);
        }
    }

    renderPublicInstances(instances, container) {
        container.innerHTML = '';
        instances.forEach(instance => {
            const isLocal = this.localUUIDs && this.localUUIDs.has(instance.id);
            const card = this.createInstanceCard(instance, false, isLocal);
            card.addEventListener('click', () => this.connectToInstance(instance, false));
            container.appendChild(card);
        });
    }

    filterPublicInstances(filterText) {
        if (!this.publicInstances) return;

        const filtered = this.publicInstances.filter(instance => {
            const searchText = filterText.toLowerCase();
            return instance.name.toLowerCase().includes(searchText) ||
                   (instance.callsign && instance.callsign.toLowerCase().includes(searchText)) ||
                   (instance.location && instance.location.toLowerCase().includes(searchText));
        });

        const listEl = document.getElementById('public-instances-list');
        const statusEl = document.getElementById('public-instances-status');

        if (filtered.length > 0) {
            statusEl.textContent = `Showing ${filtered.length} of ${this.publicInstances.length} instance(s)`;
            this.renderPublicInstances(filtered, listEl);
        } else {
            statusEl.textContent = `No instances match filter (0/${this.publicInstances.length})`;
            listEl.innerHTML = '';
        }
    }

    createInstanceCard(instance, isLocal, highlightAsLocal = false) {
        const card = document.createElement('div');
        card.className = 'instance-card';
        if (isLocal || highlightAsLocal) {
            card.classList.add('local-instance');
        }

        const desc = instance.description || instance;

        // Header
        const header = document.createElement('div');
        header.className = 'instance-header';

        const name = document.createElement('div');
        name.className = 'instance-name';
        name.textContent = instance.name || 'Unknown';
        header.appendChild(name);

        const badges = document.createElement('div');
        badges.className = 'instance-badges';

        if (isLocal || highlightAsLocal) {
            const localBadge = document.createElement('span');
            localBadge.className = 'badge badge-success';
            localBadge.textContent = 'LOCAL';
            badges.appendChild(localBadge);
        }

        if (desc.cw_skimmer || desc.CWSkimmer) {
            const cwBadge = document.createElement('span');
            cwBadge.className = 'badge badge-info';
            cwBadge.textContent = 'CW';
            badges.appendChild(cwBadge);
        }

        if (desc.digital_decodes || desc.DigitalDecodes) {
            const digiBadge = document.createElement('span');
            digiBadge.className = 'badge badge-info';
            digiBadge.textContent = 'Digital';
            badges.appendChild(digiBadge);
        }

        header.appendChild(badges);
        card.appendChild(header);

        // Details
        const details = document.createElement('div');
        details.className = 'instance-details';

        const addDetail = (label, value) => {
            if (value) {
                const detail = document.createElement('div');
                detail.className = 'instance-detail';
                detail.innerHTML = `<strong>${label}:</strong> ${value}`;
                details.appendChild(detail);
            }
        };

        if (isLocal) {
            addDetail('Host', `${instance.host}:${instance.port}`);
            if (desc.receiver) {
                addDetail('Callsign', desc.receiver.callsign);
                addDetail('Location', desc.receiver.location);
            }
        } else {
            addDetail('Callsign', instance.callsign);
            addDetail('Location', instance.location);
            addDetail('Users', `${instance.available_clients}/${instance.max_clients}`);
            if (instance.max_session_time > 0) {
                addDetail('Session', `${Math.floor(instance.max_session_time / 60)}m`);
            }
        }

        addDetail('Version', instance.version || desc.version);

        if (desc.public_iq_modes && desc.public_iq_modes.length > 0) {
            const iqModes = desc.public_iq_modes.map(m => m.replace('iq', '')).join(', ');
            addDetail('IQ (kHz)', iqModes);
        } else if (instance.public_iq_modes && instance.public_iq_modes.length > 0) {
            const iqModes = instance.public_iq_modes.map(m => m.replace('iq', '')).join(', ');
            addDetail('IQ (kHz)', iqModes);
        }

        card.appendChild(details);

        return card;
    }

    async connectToInstance(instance, isLocal) {
        // Close the modal
        this.closeModal(isLocal ? 'local-instances-modal' : 'public-instances-modal');

        // Populate connection form
        this.hostInput.value = instance.host;
        this.portInput.value = instance.port;
        this.sslCheckbox.checked = instance.tls || instance.TLS || false;

        // Show connecting message
        this.showSuccess(`Connecting to ${instance.name}...`);

        // Auto-connect
        await this.connect();
    }

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('show');
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('show');
        }
    }

    // Audio Preview Methods

    toggleAudioPreview() {
        const enabled = this.audioPreviewEnabled.checked;

        if (enabled) {
            this.audioPreviewControls.style.display = 'block';
            this.audioMuteBtn.style.display = 'inline-block';
            this.audioMuteBtn.disabled = false;
            this.startAudioStream();

            // Initialize audio visualizer
            if (!this.audioVisualizer && this.spectrumCanvas && this.waterfallCanvas) {
                this.audioVisualizer = new AudioVisualizer(this.spectrumCanvas, this.waterfallCanvas);
            }
        } else {
            this.audioPreviewControls.style.display = 'none';
            this.audioMuteBtn.style.display = 'none';
            this.audioMuteBtn.disabled = true;
            this.stopAudioStream();

            // Clear visualizer
            if (this.audioVisualizer) {
                this.audioVisualizer.clear();
            }
        }
    }

    toggleMute() {
        this.audioMuted = !this.audioMuted;
        this.updateMuteButton();
        console.log('Audio muted:', this.audioMuted);
    }

    updateMuteButton() {
        if (this.audioMuted) {
            this.audioMuteBtn.textContent = '🔇 Unmute';
            this.audioMuteBtn.classList.add('muted');
        } else {
            this.audioMuteBtn.textContent = '🔊 Mute';
            this.audioMuteBtn.classList.remove('muted');
        }
    }

    async startAudioStream() {
        if (this.audioStreamActive) {
            return;
        }

        try {
            // Use Web Audio API directly for PCM audio streaming
            this.initWebAudioAPI();
        } catch (error) {
            console.error('Failed to start audio stream:', error);
            this.updateAudioStatus('Failed to start');
            this.showError('Audio Stream Error', error.message);
        }
    }

    stopAudioStream() {
        if (!this.audioStreamActive) {
            return;
        }

        // Send message to backend to stop audio streaming
        this.sendAudioStreamRequest(false);

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.audioStreamActive = false;
        this.audioQueue = [];
        this.nextPlayTime = 0;
        this.updateAudioStatus('Not streaming');
    }

    initWebAudioAPI() {
        // Initialize Web Audio API for PCM audio streaming
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContext();
        this.nextPlayTime = 0; // Track when to schedule next audio chunk
        this.audioStreamActive = true;
        this.updateAudioStatus('Streaming');
        this.sendAudioStreamRequest(true);
        console.log('Web Audio API initialized, sample rate:', this.audioContext.sampleRate);
    }

    sendAudioStreamRequest(enable) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not connected, cannot send audio stream request');
            return;
        }

        const message = {
            type: 'audio_stream',
            enabled: enable,
            room: 'audio_preview'
        };

        this.ws.send(JSON.stringify(message));
        console.log('Sent audio stream request:', message);
    }

    handleAudioData(data) {
        if (!this.audioStreamActive) {
            return;
        }

        // Handle incoming audio data
        if (data.format === 'pcm' && data.data) {
            // Convert base64 to ArrayBuffer
            const binaryString = atob(data.data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const sampleRate = data.sampleRate || 48000;
            const channels = data.channels || 2;

            if (this.audioContext) {
                // Use Web Audio API for playback
                this.playPCMData(bytes.buffer, sampleRate, channels);

                // Send to visualizer for FFT
                if (this.audioVisualizer) {
                    this.audioVisualizer.addAudioData(bytes.buffer, sampleRate, channels);
                }
            }
        }
    }

    playPCMData(arrayBuffer, sampleRate, channels) {
        if (!this.audioContext) {
            return;
        }

        try {
            // Decode PCM data (16-bit little-endian signed integers)
            const dataView = new DataView(arrayBuffer);
            const numSamples = arrayBuffer.byteLength / 2;
            const samplesPerChannel = numSamples / channels;

            // Create audio buffer
            const audioBuffer = this.audioContext.createBuffer(channels, samplesPerChannel, sampleRate);

            // Fill channels
            for (let channel = 0; channel < channels; channel++) {
                const channelData = audioBuffer.getChannelData(channel);
                for (let i = 0; i < samplesPerChannel; i++) {
                    // Read 16-bit PCM sample and convert to float [-1, 1]
                    const sampleIndex = (i * channels + channel) * 2;
                    const sample = dataView.getInt16(sampleIndex, true); // little-endian
                    channelData[i] = sample / 32768.0;
                }
            }

            // Only play audio if not muted
            if (!this.audioMuted) {
                // Schedule playback
                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.audioContext.destination);

                // Calculate when to play this chunk
                const now = this.audioContext.currentTime;
                if (this.nextPlayTime < now) {
                    this.nextPlayTime = now;
                }

                source.start(this.nextPlayTime);

                // Update next play time
                this.nextPlayTime += audioBuffer.duration;
            } else {
                // Still update next play time even when muted to keep sync
                const now = this.audioContext.currentTime;
                if (this.nextPlayTime < now) {
                    this.nextPlayTime = now;
                }
                this.nextPlayTime += audioBuffer.duration;
            }

        } catch (error) {
            console.error('Error playing PCM data:', error);
        }
    }


    updateAudioStatus(status) {
        this.audioPreviewStatus.textContent = status;
        if (status.includes('Streaming')) {
            this.audioPreviewStatus.className = 'status-badge connected';
        } else if (status.includes('Error') || status.includes('Failed')) {
            this.audioPreviewStatus.className = 'status-badge error';
        } else {
            this.audioPreviewStatus.className = 'status-badge disconnected';
        }
    }

    // RF Spectrum Display Methods

    toggleSpectrumDisplay() {
        const enabled = this.spectrumEnabled.checked;

        if (enabled) {
            this.spectrumDisplayContainer.style.display = 'block';
            if (this.connected) {
                this.enableSpectrumDisplay();
            }
        } else {
            this.spectrumDisplayContainer.style.display = 'none';
            if (this.spectrumDisplay) {
                this.spectrumDisplay.disable();
                this.updateSpectrumStatus('Not streaming');
            }
        }
    }

    enableSpectrumDisplay() {
        if (!this.connected) {
            console.warn('Cannot enable spectrum display: not connected');
            return;
        }

        // Initialize spectrum display if not already created
        if (!this.spectrumDisplay && this.rfSpectrumCanvas && this.rfWaterfallCanvas) {
            this.spectrumDisplay = new SpectrumDisplay(this.rfSpectrumCanvas, this.rfWaterfallCanvas);

            // Set frequency callback for click-to-tune
            this.spectrumDisplay.setFrequencyCallback((frequency) => {
                console.log(`Spectrum clicked: tuning to ${frequency} Hz`);
                this.setFrequency(frequency);
            });

            // Set initial control states
            const scrollMode = this.spectrumZoomScrollCheckbox.checked ? 'zoom' : 'pan';
            this.spectrumDisplay.setScrollMode(scrollMode);
            this.spectrumDisplay.setClickTuneEnabled(this.spectrumClickTuneCheckbox.checked);
            this.spectrumDisplay.setCenterTuneEnabled(this.spectrumCenterTuneCheckbox.checked);
        }

        if (this.spectrumDisplay && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Get current tuned frequency and bandwidth from inputs
            const tunedFreq = parseInt(this.frequencyInput.value) || 14074000;
            const bandwidthLow = parseInt(this.bandwidthLowInput.value) || 50;
            const bandwidthHigh = parseInt(this.bandwidthHighInput.value) || 2700;

            this.spectrumDisplay.tunedFreq = tunedFreq;
            this.spectrumDisplay.updateBandwidth(bandwidthLow, bandwidthHigh);
            console.log(`Enabling spectrum display at ${tunedFreq} Hz with BW ${bandwidthLow} to ${bandwidthHigh} Hz`);

            this.spectrumDisplay.enable(this.ws);
            this.updateSpectrumStatus('Streaming');
        }
    }

    updateSpectrumStatus(status) {
        this.spectrumStatus.textContent = status;
        if (status.includes('Streaming')) {
            this.spectrumStatus.className = 'status-badge connected';
        } else if (status.includes('Error') || status.includes('Failed')) {
            this.spectrumStatus.className = 'status-badge error';
        } else {
            this.spectrumStatus.className = 'status-badge disconnected';
        }
    }

    // Saved Instances Methods

    async loadSavedInstances() {
        try {
            const response = await fetch(`${this.apiBase}/api/instances/saved`);
            if (response.ok) {
                const data = await response.json();
                this.savedInstances = data.instances || [];
                this.populateInstancesDropdown();
                console.log('Loaded saved instances:', this.savedInstances);
            }
        } catch (error) {
            console.error('Failed to load saved instances:', error);
        }
    }

    populateInstancesDropdown() {
        if (!this.savedInstancesSelect) return;

        // Clear existing options except the first one
        this.savedInstancesSelect.innerHTML = '<option value="">-- Select Saved Instance --</option>';

        // Add saved instances
        this.savedInstances.forEach(instance => {
            const option = document.createElement('option');
            option.value = instance.name;
            option.textContent = `${instance.name} (${instance.host}:${instance.port})`;
            this.savedInstancesSelect.appendChild(option);
        });

        this.updateInstanceButtons();
    }

    updateInstanceButtons() {
        const hasSelection = this.savedInstancesSelect && this.savedInstancesSelect.value !== '';

        if (this.deleteInstanceBtn) {
            this.deleteInstanceBtn.disabled = !hasSelection;
        }
    }

    async onInstanceSelected() {
        const selectedName = this.savedInstancesSelect.value;

        // Update button states
        this.updateInstanceButtons();

        // If empty selection, just return
        if (!selectedName) return;

        // Load and connect to the selected instance
        await this.loadAndConnectInstance(selectedName);
    }

    async loadAndConnectInstance(selectedName) {
        try {
            // Disconnect if currently connected
            if (this.connected) {
                await this.disconnect();
                // Wait a bit for disconnect to complete
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            const response = await fetch(`${this.apiBase}/api/instances/saved/${encodeURIComponent(selectedName)}/load`, {
                method: 'POST'
            });

            if (response.ok) {
                const data = await response.json();

                // Populate connection form with loaded instance
                // Backend returns config object with host, port, ssl, password
                if (data.config) {
                    this.hostInput.value = data.config.host;
                    this.portInput.value = data.config.port;
                    this.sslCheckbox.checked = data.config.ssl;
                    // Load password if present
                    if (data.config.password) {
                        this.passwordInput.value = data.config.password;
                    } else {
                        this.passwordInput.value = '';
                    }
                }

                this.showSuccess(`Connecting to ${selectedName}...`);

                // Auto-connect after loading
                await this.connect();
            } else {
                const data = await response.json();
                this.showError('Failed to load instance', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error loading instance', error.message);
        }
    }

    async saveCurrentInstance() {
        // Prompt for instance name
        const name = prompt('Enter a name for this instance:');
        if (!name || name.trim() === '') {
            return;
        }

        const instance = {
            name: name.trim(),
            host: this.hostInput.value,
            port: parseInt(this.portInput.value),
            ssl: this.sslCheckbox.checked,
            password: this.passwordInput.value // Include password
        };

        try {
            const response = await fetch(`${this.apiBase}/api/instances/saved`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(instance)
            });

            if (response.ok) {
                this.showSuccess(`Saved instance: ${name}`);
                await this.loadSavedInstances(); // Reload the list
            } else {
                const data = await response.json();
                this.showError('Failed to save instance', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error saving instance', error.message);
        }
    }

    async deleteSelectedInstance() {
        const selectedName = this.savedInstancesSelect.value;
        if (!selectedName) return;

        if (!confirm(`Delete saved instance "${selectedName}"?`)) {
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/api/instances/saved/${encodeURIComponent(selectedName)}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.showSuccess(`Deleted instance: ${selectedName}`);
                await this.loadSavedInstances(); // Reload the list
            } else {
                const data = await response.json();
                this.showError('Failed to delete instance', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error deleting instance', error.message);
        }
    }

    // Radio Control Methods (flrig)

    onRadioControlTypeChanged() {
        const type = this.radioControlType.value;
        
        if (type === 'flrig') {
            this.flrigControls.style.display = 'block';
        } else {
            this.flrigControls.style.display = 'none';
        }
    }

    async connectFlrig() {
        const config = {
            host: this.flrigHost.value,
            port: parseInt(this.flrigPort.value),
            vfo: this.flrigVFO.value,
            syncToRig: this.flrigSyncToRig.checked,
            syncFromRig: this.flrigSyncFromRig.checked
        };

        try {
            const response = await fetch(`${this.apiBase}/api/radio/flrig/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Connected to flrig');
                this.flrigConnectBtn.disabled = true;
                this.flrigDisconnectBtn.disabled = false;
                this.flrigStatusDisplay.style.display = 'block';
                this.updateFlrigStatus();
                
                // Start polling flrig status
                this.startFlrigStatusPolling();
            } else {
                this.showError('Failed to connect to flrig', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error connecting to flrig', error.message);
        }
    }

    async disconnectFlrig() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/flrig/disconnect`, {
                method: 'POST'
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Disconnected from flrig');
                this.flrigConnectBtn.disabled = false;
                this.flrigDisconnectBtn.disabled = true;
                this.flrigStatusDisplay.style.display = 'none';
                
                // Stop polling flrig status
                this.stopFlrigStatusPolling();
            } else {
                this.showError('Failed to disconnect from flrig', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error disconnecting from flrig', error.message);
        }
    }

    async updateFlrigStatus() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/flrig/status`);
            if (response.ok) {
                const status = await response.json();
                
                // Update connection status
                if (status.connected) {
                    this.flrigConnectionStatus.textContent = 'Connected';
                    this.flrigConnectionStatus.className = 'status-badge connected';
                } else {
                    this.flrigConnectionStatus.textContent = 'Disconnected';
                    this.flrigConnectionStatus.className = 'status-badge disconnected';
                }
                
                // Update frequency
                if (status.frequency) {
                    this.flrigFrequency.textContent = this.formatFrequency(status.frequency);
                } else {
                    this.flrigFrequency.textContent = '-';
                }
                
                // Update mode
                if (status.mode) {
                    this.flrigMode.textContent = status.mode.toUpperCase();
                } else {
                    this.flrigMode.textContent = '-';
                }
                
                // Update VFO
                if (status.vfo) {
                    this.flrigVFOStatus.textContent = status.vfo;
                } else {
                    this.flrigVFOStatus.textContent = '-';
                }
                
                // Update PTT
                if (status.ptt !== undefined) {
                    this.flrigPTT.textContent = status.ptt ? 'ON' : 'OFF';
                } else {
                    this.flrigPTT.textContent = '-';
                }
            }
        } catch (error) {
            console.error('Failed to fetch flrig status:', error);
        }
    }

    startFlrigStatusPolling() {
        // Poll flrig status every 2 seconds
        this.flrigStatusInterval = setInterval(() => {
            this.updateFlrigStatus();
        }, 2000);
    }

    stopFlrigStatusPolling() {
        if (this.flrigStatusInterval) {
            clearInterval(this.flrigStatusInterval);
            this.flrigStatusInterval = null;
        }
    }

    async updateFlrigSync() {
        // Only update if flrig is connected
        const response = await fetch(`${this.apiBase}/api/radio/flrig/status`);
        if (!response.ok) return;

        const status = await response.json();
        if (!status.connected) {
            console.log('flrig not connected, skipping sync update');
            return;
        }

        const config = {
            syncToRig: this.flrigSyncToRig.checked,
            syncFromRig: this.flrigSyncFromRig.checked
        };

        try {
            const response = await fetch(`${this.apiBase}/api/radio/flrig/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();

            if (response.ok) {
                console.log('Updated flrig sync settings:', config);
                this.showSuccess(data.message || 'Sync settings updated');
            } else {
                this.showError('Failed to update sync settings', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error updating sync settings', error.message);
        }
    }
}

// Initialize the client when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.uberSDR = new UberSDRClient();
});