// UberSDR Go Client Frontend JavaScript

class UberSDRClient {
    constructor() {
        this.apiBase = window.location.origin;
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;

        // Band condition color constants (matching Python client)
        this.BAND_CONDITION_COLORS = {
            'POOR': '#ef4444',      // red
            'FAIR': '#ff9800',      // orange
            'GOOD': '#fbbf24',      // bright yellow
            'EXCELLENT': '#22c55e', // green
            'UNKNOWN': '#9ca3af'    // gray
        };

        // SNR thresholds (matching Python client)
        this.SNR_THRESHOLDS = {
            'POOR': 6,
            'FAIR': 20,
            'GOOD': 30,
            'EXCELLENT': 30
        };

        this.initializeElements();
        this.attachEventListeners();
        this.loadSavedInstances();
        this.loadAudioDevices().then(() => {
            // Load config after devices are loaded so device selection can be restored
            this.loadSavedConfig();
        });
        this.updateStatus();
        this.connectWebSocket();
        
        // Initialize MIDI Control
        if (typeof MIDIControl !== 'undefined') {
            this.midiControl = new MIDIControl(this);
        }
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
        this.bookmarkSelect = document.getElementById('bookmark-select');
        this.bandSelect = document.getElementById('band-select');

        // Mode and bandwidth elements
        this.modeButtons = document.querySelectorAll('.btn-mode');
        this.currentMode = 'usb'; // Default mode
        this.bandwidthLowInput = document.getElementById('bandwidth-low');
        this.bandwidthHighInput = document.getElementById('bandwidth-high');
        this.bandwidthLowValue = document.getElementById('bandwidth-low-value');
        this.bandwidthHighValue = document.getElementById('bandwidth-high-value');

        // Audio preview elements
        this.audioPreviewEnabled = document.getElementById('audio-preview-enabled');
        this.audioPreviewControls = document.getElementById('audio-preview-controls');
        this.audioPreviewStatus = document.getElementById('audio-preview-status');
        this.audioMuteBtn = document.getElementById('audio-mute-btn');
        this.audioPreviewChannelControls = document.getElementById('audio-preview-channel-controls');
        this.audioPreviewLeftChannel = document.getElementById('audio-preview-left-channel');
        this.audioPreviewRightChannel = document.getElementById('audio-preview-right-channel');
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
        this.volumeSlider = document.getElementById('volume-slider');
        this.volumeValue = document.getElementById('volume-value');
        this.leftChannelEnabled = document.getElementById('left-channel-enabled');
        this.rightChannelEnabled = document.getElementById('right-channel-enabled');
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

        // Session timer elements
        this.sessionTimerDiv = document.getElementById('session-timer');
        this.sessionTimeRemaining = document.getElementById('session-time-remaining');
        this.sessionTimerInterval = null;
        this.sessionStartTime = null;
        this.maxSessionTime = 0; // 0 = unlimited

        // Instance info elements
        this.instanceInfoDiv = document.getElementById('instance-info');
        this.instanceInfoText = document.getElementById('instance-info-text');

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

        // Rigctl control elements
        this.rigctlControls = document.getElementById('rigctl-controls');
        this.rigctlHost = document.getElementById('rigctl-host');
        this.rigctlPort = document.getElementById('rigctl-port');
        this.rigctlVFO = document.getElementById('rigctl-vfo');
        this.rigctlSyncToRig = document.getElementById('rigctl-sync-to-rig');
        this.rigctlSyncFromRig = document.getElementById('rigctl-sync-from-rig');
        this.rigctlConnectBtn = document.getElementById('rigctl-connect-btn');
        this.rigctlDisconnectBtn = document.getElementById('rigctl-disconnect-btn');
        this.rigctlStatusDisplay = document.getElementById('rigctl-status-display');
        this.rigctlConnectionStatus = document.getElementById('rigctl-connection-status');
        this.rigctlFrequency = document.getElementById('rigctl-frequency');
        this.rigctlMode = document.getElementById('rigctl-mode');
        this.rigctlVFOStatus = document.getElementById('rigctl-vfo-status');
        this.rigctlPTT = document.getElementById('rigctl-ptt');

        // Serial control elements
        this.serialControls = document.getElementById('serial-controls');
        this.serialPort = document.getElementById('serial-port');
        this.serialBaudrate = document.getElementById('serial-baudrate');
        this.serialVFO = document.getElementById('serial-vfo');
        this.serialRefreshPortsBtn = document.getElementById('serial-refresh-ports-btn');
        this.serialStartBtn = document.getElementById('serial-start-btn');
        this.serialStopBtn = document.getElementById('serial-stop-btn');
        this.serialStatusDisplay = document.getElementById('serial-status-display');
        this.serialServerStatus = document.getElementById('serial-server-status');
        this.serialPortStatus = document.getElementById('serial-port-status');
        this.serialBaudrateStatus = document.getElementById('serial-baudrate-status');
        this.serialVFOStatus = document.getElementById('serial-vfo-status');
        this.serialFrequency = document.getElementById('serial-frequency');
        this.serialMode = document.getElementById('serial-mode');

        // Audio streaming state
        this.audioStreamActive = false;
        this.audioQueue = [];
        this.audioMuted = true; // Muted by default

        // Audio visualizer
        this.audioVisualizer = null;

        // RF Spectrum display
        this.spectrumDisplay = null;

        // MIDI Control
        this.midiControl = null;

        // Bands (stored for later use when spectrum is enabled)
        this.loadedBands = [];

        // Band conditions data
        this.bandConditions = {};
        this.bandConditionsInterval = null;

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

        // Bookmark selection
        this.bookmarkSelect.addEventListener('change', () => this.onBookmarkSelected());

        // Band selection
        this.bandSelect.addEventListener('change', () => this.onBandSelected());

        // Mode buttons
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.selectMode(mode);
            });
        });

        // Bandwidth sliders - update display and apply immediately
        this.bandwidthLowInput.addEventListener('input', () => {
            this.bandwidthLowValue.textContent = this.bandwidthLowInput.value;
            this.updateVisualizerBandwidth();
            if (this.connected) {
                clearTimeout(this.bandwidthUpdateTimeout);
                this.bandwidthUpdateTimeout = setTimeout(() => this.applyBandwidthOnly(), 500);
            }
        });

        this.bandwidthHighInput.addEventListener('input', () => {
            this.bandwidthHighValue.textContent = this.bandwidthHighInput.value;
            this.updateVisualizerBandwidth();
            if (this.connected) {
                clearTimeout(this.bandwidthUpdateTimeout);
                this.bandwidthUpdateTimeout = setTimeout(() => this.applyBandwidthOnly(), 500);
            }
        });

        // NR2 settings
        this.nr2EnabledCheckbox.addEventListener('change', () => this.updateNR2Config());
        this.nr2StrengthInput.addEventListener('change', () => this.updateNR2Config());
        this.nr2FloorInput.addEventListener('change', () => this.updateNR2Config());
        this.nr2AdaptInput.addEventListener('change', () => this.updateNR2Config());

        // Resampling settings
        this.resampleEnabledCheckbox.addEventListener('change', () => this.saveResamplingConfig());
        this.resampleRateSelect.addEventListener('change', () => this.saveResamplingConfig());
        this.outputChannelsSelect.addEventListener('change', () => this.saveResamplingConfig());

        // Audio preview settings
        this.audioPreviewEnabled.addEventListener('change', () => {
            this.toggleAudioPreview();
            this.saveAudioPreviewConfig();
        });
        this.audioMuteBtn.addEventListener('click', () => {
            this.toggleMute();
            this.saveAudioPreviewConfig();
        });

        // Audio preview channel controls (browser-only, not saved)
        this.audioPreviewLeftChannel.addEventListener('change', () => {
            console.log('Audio preview left channel:', this.audioPreviewLeftChannel.checked);
        });
        this.audioPreviewRightChannel.addEventListener('change', () => {
            console.log('Audio preview right channel:', this.audioPreviewRightChannel.checked);
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
            console.log(`Center-tune ${this.spectrumCenterTuneCheckbox.checked ? 'enabled' : 'disabled'}`);
        });

        // Spectrum zoom control buttons
        const spectrumZoomResetBtn = document.getElementById('spectrum-zoom-reset');
        const spectrumZoomOutBtn = document.getElementById('spectrum-zoom-out');
        const spectrumZoomInBtn = document.getElementById('spectrum-zoom-in');
        const spectrumZoomMaxBtn = document.getElementById('spectrum-zoom-max');

        if (spectrumZoomResetBtn) {
            spectrumZoomResetBtn.addEventListener('click', () => {
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.zoomReset();
                }
            });
        }

        if (spectrumZoomOutBtn) {
            spectrumZoomOutBtn.addEventListener('click', () => {
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.zoomOut();
                }
            });
        }

        if (spectrumZoomInBtn) {
            spectrumZoomInBtn.addEventListener('click', () => {
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.zoomIn();
                }
            });
        }

        if (spectrumZoomMaxBtn) {
            spectrumZoomMaxBtn.addEventListener('click', () => {
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.zoomMax();
                }
            });
        }

        // Dynamic output control event listeners
        this.portaudioOutputEnabled.addEventListener('change', () => this.togglePortAudioOutput());
        this.portaudioDeviceSelect.addEventListener('change', () => this.saveAudioOutputConfig());
        
        // Volume slider event listener
        this.volumeSlider.addEventListener('input', () => {
            this.volumeValue.textContent = this.volumeSlider.value;
        });
        this.volumeSlider.addEventListener('change', () => this.saveAudioOutputConfig());
        
        // Left/Right channel event listeners
        this.leftChannelEnabled.addEventListener('change', () => this.saveAudioOutputConfig());
        this.rightChannelEnabled.addEventListener('change', () => this.saveAudioOutputConfig());
        
        this.fifoOutputEnabled.addEventListener('change', () => this.toggleFIFOOutput());
        this.udpOutputEnabled.addEventListener('change', () => this.toggleUDPOutput());

        // Radio control event listeners
        this.radioControlType.addEventListener('change', () => this.onRadioControlTypeChanged());
        this.flrigConnectBtn.addEventListener('click', () => this.connectFlrig());
        this.flrigDisconnectBtn.addEventListener('click', () => this.disconnectFlrig());
        this.flrigSyncToRig.addEventListener('change', () => this.updateFlrigSync());
        this.flrigSyncFromRig.addEventListener('change', () => this.updateFlrigSync());

        // Rigctl control event listeners
        this.rigctlConnectBtn.addEventListener('click', () => this.connectRigctl());
        this.rigctlDisconnectBtn.addEventListener('click', () => this.disconnectRigctl());
        this.rigctlSyncToRig.addEventListener('change', () => this.updateRigctlSync());
        this.rigctlSyncFromRig.addEventListener('change', () => this.updateRigctlSync());

        // Serial control event listeners
        this.serialRefreshPortsBtn.addEventListener('click', () => this.loadSerialPorts());
        this.serialStartBtn.addEventListener('click', () => this.startSerialServer());
        this.serialStopBtn.addEventListener('click', () => this.stopSerialServer());
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
        } else if (data.type === 'midi_learn_captured' || data.type === 'midi_learn_completed') {
            // Forward MIDI learn mode messages to MIDI control
            if (this.midiControl) {
                this.midiControl.handleLearnModeUpdate(data);
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
            // Load bookmarks after successful connection
            this.loadBookmarks();
            // Load bands after successful connection
            this.loadBands();
        } else {
            this.showInfo(`Disconnected: ${data.reason || 'Unknown reason'}`);
            // Clear bookmarks on disconnect
            this.clearBookmarks();
        }
    }

    async connect() {
        console.log('DEBUG: connect() method called');
        const config = {
            host: this.hostInput.value,
            port: parseInt(this.portInput.value),
            ssl: this.sslCheckbox.checked,
            frequency: parseInt(this.frequencyInput.value),
            mode: this.currentMode,
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
            console.log('DEBUG: Sending connect request to', `${this.apiBase}/api/connect`);
            const response = await fetch(`${this.apiBase}/api/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            console.log('DEBUG: Got response, status:', response.status);
            const data = await response.json();
            console.log('DEBUG: Response data:', data);

            if (response.ok) {
                console.log('DEBUG: Response OK, entering success block');
                this.connected = true;
                this.updateConnectionUI();
                this.showSuccess(data.message || 'Connected successfully');
                this.updateStatus();

                // Load instance description and display info
                setTimeout(() => {
                    this.loadInstanceInfo();
                }, 500);

                // Load bookmarks and bands after successful connection
                setTimeout(() => {
                    this.loadBookmarks();
                    this.loadBands();
                }, 500);

                // Update output status after a delay to allow backend restoration
                setTimeout(() => this.updateOutputStatus(), 1000);

                // Enable spectrum display if checkbox is checked
                if (this.spectrumEnabled.checked) {
                    setTimeout(() => this.enableSpectrumDisplay(), 500);
                }

                // Start band conditions polling
                console.log('DEBUG: About to schedule startBandConditionsPolling in 1 second');
                setTimeout(() => {
                    console.log('DEBUG: setTimeout fired, calling startBandConditionsPolling');
                    this.startBandConditionsPolling();
                }, 1000);
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

                // Stop band conditions polling
                this.stopBandConditionsPolling();

                // Stop session timer
                this.stopSessionTimer();

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

            const wasConnected = this.connected;
            this.connected = status.connected;
            this.updateConnectionUI();
            this.updateStatusDisplay(status);

            // Load bookmarks, bands, and instance info if connected and not already loaded
            if (status.connected && this.bookmarkSelect && this.bookmarkSelect.options.length <= 1) {
                this.loadBookmarks();
                this.loadBands();
            }

            // Load instance info if we just became connected (including auto-connect on page load)
            if (status.connected && !wasConnected) {
                console.log('Connection detected in updateStatus, loading instance info');
                this.loadInstanceInfo();
            }

            // Update output status after we know the connection state
            this.updateOutputStatus();
        } catch (error) {
            console.error('Failed to fetch status:', error);
        }

        // Poll status every 2 seconds
        setTimeout(() => this.updateStatus(), 2000);
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
            // Also update the mode buttons for real-time sync
            if (this.currentMode != status.mode && !this.bookmarkModeChange && !this.userModeChange) {
                this.currentMode = status.mode;
                this.updateModeButtons();
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

        // Update IQ mode button visibility based on allowed modes
        if (status.allowedIQModes !== undefined) {
            this.updateIQModeButtons(status.allowedIQModes, status.bypassed);
        }

        // Update session timer only if both fields are present (not sent in all status updates)
        if (status.maxSessionTime !== undefined && status.maxSessionTime !== null &&
            status.sessionStartTime && status.sessionStartTime !== null) {
            console.log('Calling updateSessionTimer with:', status.maxSessionTime, status.sessionStartTime);
            this.updateSessionTimer(status.maxSessionTime, status.sessionStartTime);
        }
    }

    updateSessionTimer(maxSessionTime, sessionStartTime) {
        console.log('updateSessionTimer called with:', maxSessionTime, sessionStartTime);
        
        // Store max session time
        this.maxSessionTime = maxSessionTime;

        // Always show the timer
        this.sessionTimerDiv.style.display = 'block';

        // If 0, it means unlimited - show "Unlimited"
        if (maxSessionTime === 0) {
            console.log('Session time is 0 (unlimited), showing "Unlimited"');
            this.sessionTimeRemaining.textContent = 'Unlimited';
            this.sessionTimeRemaining.style.color = '#2196F3'; // Blue
            this.stopSessionTimer();
            return;
        }

        console.log('Session time is', maxSessionTime, 'seconds, showing countdown');

        // Convert backend timestamp to JavaScript timestamp
        // Backend sends RFC3339 format, parse it
        if (sessionStartTime) {
            this.sessionStartTime = new Date(sessionStartTime).getTime();
            console.log('Parsed session start time:', this.sessionStartTime, 'from', sessionStartTime);
        }

        // Start the countdown if not already started
        if (!this.sessionTimerInterval) {
            console.log('Starting session timer interval');
            this.startSessionTimer();
        } else {
            console.log('Session timer interval already running');
        }
    }

    startSessionTimer() {
        // Clear any existing timer
        this.stopSessionTimer();

        // Update immediately
        this.updateSessionTimerDisplay();

        // Update every second
        this.sessionTimerInterval = setInterval(() => {
            this.updateSessionTimerDisplay();
        }, 1000);
    }

    stopSessionTimer() {
        if (this.sessionTimerInterval) {
            clearInterval(this.sessionTimerInterval);
            this.sessionTimerInterval = null;
        }
        this.sessionStartTime = null;
    }

    updateSessionTimerDisplay() {
        if (!this.sessionStartTime || this.maxSessionTime === 0) {
            return;
        }

        // Calculate elapsed time in seconds
        const elapsedSeconds = Math.floor((Date.now() - this.sessionStartTime) / 1000);

        // Calculate remaining time
        const remainingSeconds = Math.max(0, this.maxSessionTime - elapsedSeconds);

        // Format as "Xh Ym Zs"
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;

        let timeStr = '';
        if (hours > 0) {
            timeStr += `${hours}h `;
        }
        if (hours > 0 || minutes > 0) {
            timeStr += `${minutes}m `;
        }
        timeStr += `${seconds}s`;

        this.sessionTimeRemaining.textContent = timeStr.trim();

        // Color based on remaining time
        if (remainingSeconds < 300) {
            // Less than 5 minutes - red
            this.sessionTimeRemaining.style.color = '#ef4444';
            if (remainingSeconds === 0) {
                this.showInfo('Session time expired - you may be disconnected soon');
            }
        } else {
            // 5 minutes or more - blue
            this.sessionTimeRemaining.style.color = '#2196F3';
        }
    }

    async applySettings() {
        if (!this.connected) {
            this.showError('Not connected', 'Connect to SDR server first');
            return;
        }

        // Clear user mode change flag since settings are being applied
        this.userModeChange = false;
        clearTimeout(this.userModeChangeTimeout);

        const tuneRequest = {
            frequency: parseInt(this.frequencyInput.value),
            mode: this.currentMode
        };

        // Only include bandwidth for non-IQ modes
        const isIQMode = this.currentMode === 'iq' || this.currentMode === 'iq48' ||
            this.currentMode === 'iq96' || this.currentMode === 'iq192' || this.currentMode === 'iq384';

        if (!isIQMode) {
            tuneRequest.bandwidthLow = parseInt(this.bandwidthLowInput.value);
            tuneRequest.bandwidthHigh = parseInt(this.bandwidthHighInput.value);
        }

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

                // Update audio visualizer with new bandwidth
                if (this.audioVisualizer) {
                    this.audioVisualizer.updateBandwidth(tuneRequest.bandwidthLow, tuneRequest.bandwidthHigh, tuneRequest.mode);
                }
            } else {
                this.showError('Failed to apply settings', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error applying settings', error.message);
        }
    }

    async applyBandwidthOnly() {
        if (!this.connected) return;

        // Don't send bandwidth updates for IQ modes
        const isIQMode = this.currentMode === 'iq' || this.currentMode === 'iq48' ||
            this.currentMode === 'iq96' || this.currentMode === 'iq192' || this.currentMode === 'iq384';

        if (isIQMode) {
            return; // Skip bandwidth updates for IQ modes
        }

        const tuneRequest = {
            frequency: parseInt(this.frequencyInput.value),
            mode: this.currentMode,
            bandwidthLow: parseInt(this.bandwidthLowInput.value),
            bandwidthHigh: parseInt(this.bandwidthHighInput.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/tune`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tuneRequest)
            });

            if (response.ok) {
                // Update spectrum display with new bandwidth
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.updateBandwidth(tuneRequest.bandwidthLow, tuneRequest.bandwidthHigh);
                }

                // Update audio visualizer with new bandwidth
                if (this.audioVisualizer) {
                    this.audioVisualizer.updateBandwidth(tuneRequest.bandwidthLow, tuneRequest.bandwidthHigh, tuneRequest.mode);
                }
            }
        } catch (error) {
            console.error('Error applying bandwidth:', error);
        }
    }

    selectMode(mode) {
        this.currentMode = mode;
        this.updateModeButtons();
        this.updateModeDefaults();
        
        // Apply immediately if connected
        if (this.connected) {
            this.applySettings();
        }
    }

    updateModeButtons() {
        this.modeButtons.forEach(btn => {
            if (btn.dataset.mode === this.currentMode) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    updateIQModeButtons(allowedIQModes, bypassed) {
        // IQ mode buttons to check: iq48, iq96, iq192, iq384
        // Basic "iq" button should always be visible
        const iqModeButtons = ['iq48', 'iq96', 'iq192', 'iq384'];

        this.modeButtons.forEach(btn => {
            const mode = btn.dataset.mode;

            // Skip non-IQ modes and basic "iq" mode
            if (!iqModeButtons.includes(mode)) {
                return;
            }

            // If bypassed or allowedIQModes includes this mode, show it
            // Otherwise hide it
            if (bypassed || (allowedIQModes && allowedIQModes.includes(mode))) {
                btn.style.display = '';
            } else {
                btn.style.display = 'none';
            }
        });
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
                    console.log(`updateFrequency: centerTuneEnabled=${this.spectrumDisplay.centerTuneEnabled}, isOutsideView=${isOutsideView}`);
                    if (this.spectrumDisplay.centerTuneEnabled || isOutsideView) {
                        console.log(`Re-centering spectrum to ${frequency} Hz`);
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
        const mode = this.currentMode;
        
        // Mode defaults and ranges from Python client
        const modeConfig = {
            'usb': { defaults: [50, 2700], range: [-10000, 10000] },
            'lsb': { defaults: [-2700, -50], range: [-10000, 10000] },
            'am': { defaults: [-5000, 5000], range: [-10000, 10000] },
            'sam': { defaults: [-5000, 5000], range: [-10000, 10000] },
            'cwu': { defaults: [-200, 200], range: [-1000, 1000] },
            'cwl': { defaults: [-200, 200], range: [-1000, 1000] },
            'fm': { defaults: [-8000, 8000], range: [-10000, 10000] },
            'nfm': { defaults: [-8000, 8000], range: [-10000, 10000] },
            'iq': { defaults: [0, 0], range: [-10000, 10000] },
            'iq48': { defaults: [0, 0], range: [-24000, 24000] },
            'iq96': { defaults: [0, 0], range: [-48000, 48000] },
            'iq192': { defaults: [0, 0], range: [-96000, 96000] },
            'iq384': { defaults: [0, 0], range: [-192000, 192000] }
        };

        const config = modeConfig[mode] || modeConfig['usb'];
        
        // Update slider ranges
        this.bandwidthLowInput.min = config.range[0];
        this.bandwidthLowInput.max = config.range[1];
        this.bandwidthHighInput.min = config.range[0];
        this.bandwidthHighInput.max = config.range[1];
        
        // Update values
        this.bandwidthLowInput.value = config.defaults[0];
        this.bandwidthHighInput.value = config.defaults[1];
        this.bandwidthLowValue.textContent = config.defaults[0];
        this.bandwidthHighValue.textContent = config.defaults[1];

        // Update audio visualizer with new bandwidth
        this.updateVisualizerBandwidth();
    }

    updateVisualizerBandwidth() {
        // Update audio visualizer with current bandwidth values
        if (this.audioVisualizer) {
            const bandwidthLow = parseInt(this.bandwidthLowInput.value) || 50;
            const bandwidthHigh = parseInt(this.bandwidthHighInput.value) || 2700;
            this.audioVisualizer.updateBandwidth(bandwidthLow, bandwidthHigh, this.currentMode);
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
                if (config.mode) {
                    this.currentMode = config.mode;
                    this.updateModeButtons();
                }
                if (config.bandwidthLow !== null && config.bandwidthLow !== undefined) {
                    this.bandwidthLowInput.value = config.bandwidthLow;
                }
                if (config.bandwidthHigh !== null && config.bandwidthHigh !== undefined) {
                    this.bandwidthHighInput.value = config.bandwidthHigh;
                    this.bandwidthHighValue.textContent = config.bandwidthHigh;
                }
                if (config.nr2Enabled !== undefined) this.nr2EnabledCheckbox.checked = config.nr2Enabled;
                if (config.nr2Strength) this.nr2StrengthInput.value = config.nr2Strength;
                if (config.nr2Floor) this.nr2FloorInput.value = config.nr2Floor;
                if (config.nr2AdaptRate) this.nr2AdaptInput.value = config.nr2AdaptRate;
                if (config.resampleEnabled !== undefined) this.resampleEnabledCheckbox.checked = config.resampleEnabled;
                if (config.resampleOutputRate) this.resampleRateSelect.value = config.resampleOutputRate;
                if (config.outputChannels !== undefined) this.outputChannelsSelect.value = config.outputChannels;

                // Load audio output settings with defaults
                const volume = (config.volume !== undefined) ? config.volume : 0.7; // Default 70%
                this.volumeSlider.value = Math.round(volume * 100);
                this.volumeValue.textContent = Math.round(volume * 100);
                
                const leftEnabled = (config.leftChannelEnabled !== undefined) ? config.leftChannelEnabled : true;
                const rightEnabled = (config.rightChannelEnabled !== undefined) ? config.rightChannelEnabled : true;
                this.leftChannelEnabled.checked = leftEnabled;
                this.rightChannelEnabled.checked = rightEnabled;

                // Load saved audio device selection
                if (config.portAudioDevice !== undefined) {
                    this.portaudioDeviceSelect.value = config.portAudioDevice;
                }

                // Load audio preview settings
                // Note: audioPreviewEnabled is always unchecked on page load to comply with browser autoplay policies
                // User must manually enable it after page load
                this.audioPreviewEnabled.checked = false;
                this.audioPreviewControls.style.display = 'none';
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
                                // Start band conditions polling for auto-connected sessions
                                console.log('DEBUG: Starting band conditions polling for auto-connect');
                                setTimeout(() => this.startBandConditionsPolling(), 1000);
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

                // Load radio control settings
                if (config.radioControlType) {
                    this.radioControlType.value = config.radioControlType;
                    this.onRadioControlTypeChanged(); // Show/hide controls based on type
                }
                if (config.flrigHost) this.flrigHost.value = config.flrigHost;
                if (config.flrigPort) this.flrigPort.value = config.flrigPort;
                if (config.flrigVFO) this.flrigVFO.value = config.flrigVFO;
                if (config.flrigSyncToRig !== undefined) this.flrigSyncToRig.checked = config.flrigSyncToRig;
                if (config.flrigSyncFromRig !== undefined) this.flrigSyncFromRig.checked = config.flrigSyncFromRig;

                // Load rigctl settings
                if (config.rigctlHost) this.rigctlHost.value = config.rigctlHost;
                if (config.rigctlPort) this.rigctlPort.value = config.rigctlPort;
                if (config.rigctlVFO) this.rigctlVFO.value = config.rigctlVFO;
                if (config.rigctlSyncToRig !== undefined) this.rigctlSyncToRig.checked = config.rigctlSyncToRig;
                if (config.rigctlSyncFromRig !== undefined) this.rigctlSyncFromRig.checked = config.rigctlSyncFromRig;

                // Load serial settings
                if (config.serialPort) this.serialPort.value = config.serialPort;
                if (config.serialBaudrate) this.serialBaudrate.value = config.serialBaudrate;
                if (config.serialVFO) this.serialVFO.value = config.serialVFO;

                // Check if flrig is already connected (via auto-connect)
                if (config.flrigEnabled && config.radioControlType === 'flrig') {
                    setTimeout(() => {
                        this.checkFlrigConnection();
                    }, 1000); // Wait a bit for backend auto-connect to complete
                }

                // Check if rigctl is already connected (via auto-connect)
                if (config.rigctlEnabled && config.radioControlType === 'rigctl') {
                    setTimeout(() => {
                        this.checkRigctlConnection();
                    }, 1000); // Wait a bit for backend auto-connect to complete
                }

                // Check if serial is already running (via auto-connect)
                if (config.serialEnabled && config.radioControlType === 'serial') {
                    setTimeout(() => {
                        this.checkSerialConnection();
                    }, 1000); // Wait a bit for backend auto-connect to complete
                }

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

    async saveAudioOutputConfig() {
        const config = {
            volume: parseFloat(this.volumeSlider.value) / 100.0,
            leftChannelEnabled: this.leftChannelEnabled.checked,
            rightChannelEnabled: this.rightChannelEnabled.checked,
            portAudioDevice: parseInt(this.portaudioDeviceSelect.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save audio output config:', data.message || data.error);
            }
        } catch (error) {
            console.error('Error saving audio output config:', error);
        }
    }

    async saveResamplingConfig() {
        const config = {
            resampleEnabled: this.resampleEnabledCheckbox.checked,
            resampleOutputRate: parseInt(this.resampleRateSelect.value),
            outputChannels: parseInt(this.outputChannelsSelect.value)
        };

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save resampling config:', data.message || data.error);
            }
        } catch (error) {
            console.error('Error saving resampling config:', error);
        }
    }

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
                // Lock/unlock device select and audio controls
                this.portaudioDeviceSelect.disabled = enabled;
                this.volumeSlider.disabled = !enabled;
                this.leftChannelEnabled.disabled = !enabled;
                this.rightChannelEnabled.disabled = !enabled;
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
                    // Only update device selection if PortAudio is actually enabled
                    // When disabled, keep the saved preference in the dropdown
                    if (status.portaudio.enabled && status.portaudio.deviceIndex !== undefined) {
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

                // Update volume and channel settings from broadcast
                if (status.volume !== undefined) {
                    const volumePercent = Math.round(status.volume * 100);
                    if (parseInt(this.volumeSlider.value) !== volumePercent) {
                        this.volumeSlider.value = volumePercent;
                        this.volumeValue.textContent = volumePercent;
                    }
                }
                if (status.leftChannelEnabled !== undefined && this.leftChannelEnabled.checked !== status.leftChannelEnabled) {
                    this.leftChannelEnabled.checked = status.leftChannelEnabled;
                }
                if (status.rightChannelEnabled !== undefined && this.rightChannelEnabled.checked !== status.rightChannelEnabled) {
                    this.rightChannelEnabled.checked = status.rightChannelEnabled;
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

            // Enable output controls
            this.updateOutputStatus();

            // Enable mode buttons
            this.modeButtons.forEach(btn => btn.disabled = false);
        } else {
            this.connectionStatus.textContent = 'Disconnected';
            this.connectionStatus.className = 'status-badge disconnected';
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
            this.uptimeSpan.textContent = '';

            // Hide session timer and instance info
            this.sessionTimerDiv.style.display = 'none';
            this.stopSessionTimer();
            this.instanceInfoDiv.style.display = 'none';

            // Disable output controls
            this.portaudioOutputEnabled.disabled = true;
            this.portaudioOutputEnabled.checked = false;
            this.fifoOutputEnabled.disabled = true;
            this.fifoOutputEnabled.checked = false;
            this.udpOutputEnabled.disabled = true;
            this.udpOutputEnabled.checked = false;

            // Disable mode buttons
            this.modeButtons.forEach(btn => btn.disabled = true);
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

        // Disconnect if currently connected
        if (this.connected) {
            await this.disconnect();
            // Wait a bit for disconnect to complete
            await new Promise(resolve => setTimeout(resolve, 500));
        }

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
            this.audioPreviewChannelControls.style.display = 'flex';
            this.startAudioStream();

            // Initialize audio visualizer with current bandwidth settings
            if (!this.audioVisualizer && this.spectrumCanvas && this.waterfallCanvas) {
                this.audioVisualizer = new AudioVisualizer(this.spectrumCanvas, this.waterfallCanvas);
                // Set initial bandwidth from current settings
                const bandwidthLow = parseInt(this.bandwidthLowInput.value) || 50;
                const bandwidthHigh = parseInt(this.bandwidthHighInput.value) || 2700;
                this.audioVisualizer.updateBandwidth(bandwidthLow, bandwidthHigh, this.currentMode);
            }
        } else {
            this.audioPreviewControls.style.display = 'none';
            this.audioMuteBtn.style.display = 'none';
            this.audioMuteBtn.disabled = true;
            this.audioPreviewChannelControls.style.display = 'none';
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

            // Get channel enable states
            const leftEnabled = this.audioPreviewLeftChannel.checked;
            const rightEnabled = this.audioPreviewRightChannel.checked;

            // Always create stereo output (2 channels) for browser audio
            const audioBuffer = this.audioContext.createBuffer(2, samplesPerChannel, sampleRate);

            if (channels === 1) {
                // Mono input: duplicate to both channels
                const leftData = audioBuffer.getChannelData(0);
                const rightData = audioBuffer.getChannelData(1);

                for (let i = 0; i < samplesPerChannel; i++) {
                    const sampleIndex = i * 2;
                    const sample = dataView.getInt16(sampleIndex, true); // little-endian
                    const normalizedSample = sample / 32768.0;

                    // Apply channel muting
                    leftData[i] = leftEnabled ? normalizedSample : 0;
                    rightData[i] = rightEnabled ? normalizedSample : 0;
                }
            } else {
                // Stereo input: process each channel separately
                const leftData = audioBuffer.getChannelData(0);
                const rightData = audioBuffer.getChannelData(1);

                for (let i = 0; i < samplesPerChannel; i++) {
                    // Left channel
                    const leftSampleIndex = (i * 2) * 2;
                    const leftSample = dataView.getInt16(leftSampleIndex, true);
                    leftData[i] = leftEnabled ? (leftSample / 32768.0) : 0;

                    // Right channel
                    const rightSampleIndex = (i * 2 + 1) * 2;
                    const rightSample = dataView.getInt16(rightSampleIndex, true);
                    rightData[i] = rightEnabled ? (rightSample / 32768.0) : 0;
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
                // Update frequency input
                this.frequencyInput.value = frequency;
                // Update spectrum display's tuned frequency immediately for visual feedback
                this.spectrumDisplay.tunedFreq = frequency;
                // Send complete tune request with current mode and bandwidth
                if (this.connected) {
                    this.applySettings();
                }
            });

            // Set mode callback for bookmark clicks
            this.spectrumDisplay.setModeCallback((mode) => {
                console.log(`Spectrum bookmark mode change: ${mode}`);
                // Map mode names if needed
                const modeMap = {
                    'CWR': 'cw',
                    'CW': 'cwu',
                };
                const mappedMode = modeMap[mode] || mode.toLowerCase();

                // Set flag to prevent mode change event from calling updateModeDefaults
                this.bookmarkModeChange = true;

                // Update mode select
                if (this.modeSelect.value !== mappedMode) {
                    this.modeSelect.value = mappedMode;
                    // Update bandwidth defaults for the new mode
                    this.updateModeDefaults();
                }

                // Clear flag after a short delay
                setTimeout(() => {
                    this.bookmarkModeChange = false;
                }, 100);
            });

            // Set initial control states
            const scrollMode = this.spectrumZoomScrollCheckbox.checked ? 'zoom' : 'pan';
            this.spectrumDisplay.setScrollMode(scrollMode);
            this.spectrumDisplay.setClickTuneEnabled(this.spectrumClickTuneCheckbox.checked);
            this.spectrumDisplay.setCenterTuneEnabled(this.spectrumCenterTuneCheckbox.checked);
            console.log(`Spectrum display initialized with center-tune: ${this.spectrumCenterTuneCheckbox.checked}`);

            // Set bookmarks if already loaded
            if (this.bookmarkSelect && this.bookmarkSelect.options.length > 1) {
                // Extract bookmarks from dropdown options
                const bookmarks = [];
                for (let i = 1; i < this.bookmarkSelect.options.length; i++) {
                    try {
                        const bookmark = JSON.parse(this.bookmarkSelect.options[i].value);
                        bookmarks.push(bookmark);
                    } catch (e) {
                        console.error('Error parsing bookmark:', e);
                    }
                }
                if (bookmarks.length > 0) {
                    this.spectrumDisplay.setBookmarks(bookmarks);
                }
            }

            // Set bands if already loaded
            if (this.loadedBands && this.loadedBands.length > 0) {
                console.log(`Applying ${this.loadedBands.length} previously loaded bands to spectrum display`);
                this.spectrumDisplay.setBands(this.loadedBands);
            }
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
            this.rigctlControls.style.display = 'none';
        } else if (type === 'rigctl') {
            this.flrigControls.style.display = 'none';
            this.rigctlControls.style.display = 'block';
        } else if (type === 'serial') {
            this.flrigControls.style.display = 'none';
            this.rigctlControls.style.display = 'none';
            this.serialControls.style.display = 'block';
            // Load serial ports when serial is selected
            this.loadSerialPorts();
        } else {
            this.flrigControls.style.display = 'none';
            this.rigctlControls.style.display = 'none';
            this.serialControls.style.display = 'none';
        }

        // Save the radio control type selection
        this.saveRadioControlType();
    }

    async saveRadioControlType() {
        const config = {
            radioControlType: this.radioControlType.value
        };

        try {
            const response = await fetch(`${this.apiBase}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                const data = await response.json();
                console.error('Failed to save radio control type:', data.message || data.error);
            }
        } catch (error) {
            console.error('Error saving radio control type:', error);
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

    async checkFlrigConnection() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/flrig/status`);
            if (response.ok) {
                const status = await response.json();

                if (status.connected) {
                    console.log('flrig is already connected (auto-connect)');
                    // Update UI to reflect connected state
                    this.flrigConnectBtn.disabled = true;
                    this.flrigDisconnectBtn.disabled = false;
                    this.flrigStatusDisplay.style.display = 'block';

                    // Update status display
                    this.updateFlrigStatus();

                    // Start polling flrig status
                    this.startFlrigStatusPolling();
                } else {
                    console.log('flrig not connected');
                }
            }
        } catch (error) {
            console.error('Failed to check flrig connection:', error);
        }
    }

    // Radio Control Methods (rigctl)

    async connectRigctl() {
        const config = {
            host: this.rigctlHost.value,
            port: parseInt(this.rigctlPort.value),
            vfo: this.rigctlVFO.value,
            syncToRig: this.rigctlSyncToRig.checked,
            syncFromRig: this.rigctlSyncFromRig.checked
        };

        try {
            const response = await fetch(`${this.apiBase}/api/radio/rigctl/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Connected to rigctl');
                this.rigctlConnectBtn.disabled = true;
                this.rigctlDisconnectBtn.disabled = false;
                this.rigctlStatusDisplay.style.display = 'block';
                this.updateRigctlStatus();

                // Start polling rigctl status
                this.startRigctlStatusPolling();
            } else {
                this.showError('Failed to connect to rigctl', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error connecting to rigctl', error.message);
        }
    }

    async disconnectRigctl() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/rigctl/disconnect`, {
                method: 'POST'
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Disconnected from rigctl');
                this.rigctlConnectBtn.disabled = false;
                this.rigctlDisconnectBtn.disabled = true;
                this.rigctlStatusDisplay.style.display = 'none';

                // Stop polling rigctl status
                this.stopRigctlStatusPolling();
            } else {
                this.showError('Failed to disconnect from rigctl', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error disconnecting from rigctl', error.message);
        }
    }

    async updateRigctlStatus() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/rigctl/status`);
            if (response.ok) {
                const status = await response.json();

                // Update connection status
                if (status.connected) {
                    this.rigctlConnectionStatus.textContent = 'Connected';
                    this.rigctlConnectionStatus.className = 'status-badge connected';
                } else {
                    this.rigctlConnectionStatus.textContent = 'Disconnected';
                    this.rigctlConnectionStatus.className = 'status-badge disconnected';
                }

                // Update frequency
                if (status.frequency) {
                    this.rigctlFrequency.textContent = this.formatFrequency(status.frequency);
                } else {
                    this.rigctlFrequency.textContent = '-';
                }

                // Update mode
                if (status.mode) {
                    this.rigctlMode.textContent = status.mode.toUpperCase();
                } else {
                    this.rigctlMode.textContent = '-';
                }

                // Update VFO
                if (status.vfo) {
                    this.rigctlVFOStatus.textContent = status.vfo;
                } else {
                    this.rigctlVFOStatus.textContent = '-';
                }

                // Update PTT
                if (status.ptt !== undefined) {
                    this.rigctlPTT.textContent = status.ptt ? 'ON' : 'OFF';
                } else {
                    this.rigctlPTT.textContent = '-';
                }
            }
        } catch (error) {
            console.error('Failed to fetch rigctl status:', error);
        }
    }

    startRigctlStatusPolling() {
        // Poll rigctl status every 2 seconds
        this.rigctlStatusInterval = setInterval(() => {
            this.updateRigctlStatus();
        }, 2000);
    }

    stopRigctlStatusPolling() {
        if (this.rigctlStatusInterval) {
            clearInterval(this.rigctlStatusInterval);
            this.rigctlStatusInterval = null;
        }
    }

    async updateRigctlSync() {
        // Only update if rigctl is connected
        const response = await fetch(`${this.apiBase}/api/radio/rigctl/status`);
        if (!response.ok) return;

        const status = await response.json();
        if (!status.connected) {
            console.log('rigctl not connected, skipping sync update');
            return;
        }

        const config = {
            syncToRig: this.rigctlSyncToRig.checked,
            syncFromRig: this.rigctlSyncFromRig.checked
        };

        try {
            const response = await fetch(`${this.apiBase}/api/radio/rigctl/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();

            if (response.ok) {
                console.log('Updated rigctl sync settings:', config);
                this.showSuccess(data.message || 'Sync settings updated');
            } else {
                this.showError('Failed to update sync settings', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error updating sync settings', error.message);
        }
    }

    async checkRigctlConnection() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/rigctl/status`);
            if (response.ok) {
                const status = await response.json();

                if (status.connected) {
                    console.log('rigctl is already connected (auto-connect)');
                    // Update UI to reflect connected state
                    this.rigctlConnectBtn.disabled = true;
                    this.rigctlDisconnectBtn.disabled = false;
                    this.rigctlStatusDisplay.style.display = 'block';

                    // Update status display
                    this.updateRigctlStatus();

                    // Start polling rigctl status
                    this.startRigctlStatusPolling();
                } else {
                    console.log('rigctl not connected');
                }
            }
        } catch (error) {
            console.error('Failed to check rigctl connection:', error);
        }
    }

    // Radio Control Methods (serial CAT server)

    async loadSerialPorts() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/serial/ports`);
            if (response.ok) {
                const data = await response.json();

                // Clear and populate serial port datalist
                const portDatalist = document.getElementById('serial-port-list');
                portDatalist.innerHTML = '';

                if (data.ports && data.ports.length > 0) {
                    data.ports.forEach(port => {
                        const option = document.createElement('option');
                        option.value = port;
                        portDatalist.appendChild(option);
                    });
                    console.log(`Loaded ${data.ports.length} serial ports`);
                } else {
                    console.log('No serial ports found');
                }
            }
        } catch (error) {
            console.error('Failed to load serial ports:', error);
            this.showError('Error loading serial ports', error.message);
        }
    }

    async startSerialServer() {
        const port = this.serialPort.value;
        if (!port) {
            this.showError('Port required', 'Please select a serial port');
            return;
        }

        const config = {
            port: port,
            baudrate: parseInt(this.serialBaudrate.value),
            vfo: this.serialVFO.value
        };

        try {
            const response = await fetch(`${this.apiBase}/api/radio/serial/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Serial CAT server started');
                this.serialStartBtn.disabled = true;
                this.serialStopBtn.disabled = false;
                this.serialStatusDisplay.style.display = 'block';
                this.updateSerialStatus();

                // Start polling serial status
                this.startSerialStatusPolling();
            } else {
                this.showError('Failed to start serial CAT server', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error starting serial CAT server', error.message);
        }
    }

    async stopSerialServer() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/serial/disconnect`, {
                method: 'POST'
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(data.message || 'Serial CAT server stopped');
                this.serialStartBtn.disabled = false;
                this.serialStopBtn.disabled = true;
                this.serialStatusDisplay.style.display = 'none';

                // Stop polling serial status
                this.stopSerialStatusPolling();
            } else {
                this.showError('Failed to stop serial CAT server', data.message || data.error);
            }
        } catch (error) {
            this.showError('Error stopping serial CAT server', error.message);
        }
    }

    async updateSerialStatus() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/serial/status`);
            if (response.ok) {
                const status = await response.json();

                // Update server status
                if (status.running) {
                    this.serialServerStatus.textContent = 'Running';
                    this.serialServerStatus.className = 'status-badge connected';
                } else {
                    this.serialServerStatus.textContent = 'Stopped';
                    this.serialServerStatus.className = 'status-badge disconnected';
                }

                // Update port
                if (status.port) {
                    this.serialPortStatus.textContent = status.port;
                } else {
                    this.serialPortStatus.textContent = '-';
                }

                // Update baud rate
                if (status.baudrate) {
                    this.serialBaudrateStatus.textContent = status.baudrate;
                } else {
                    this.serialBaudrateStatus.textContent = '-';
                }

                // Update VFO
                if (status.vfo) {
                    this.serialVFOStatus.textContent = status.vfo;
                } else {
                    this.serialVFOStatus.textContent = '-';
                }

                // Update frequency
                if (status.frequency) {
                    this.serialFrequency.textContent = this.formatFrequency(status.frequency);
                } else {
                    this.serialFrequency.textContent = '-';
                }

                // Update mode
                if (status.mode) {
                    this.serialMode.textContent = status.mode.toUpperCase();
                } else {
                    this.serialMode.textContent = '-';
                }
            }
        } catch (error) {
            console.error('Failed to fetch serial status:', error);
        }
    }

    startSerialStatusPolling() {
        // Poll serial status every 2 seconds
        this.serialStatusInterval = setInterval(() => {
            this.updateSerialStatus();
        }, 2000);
    }

    stopSerialStatusPolling() {
        if (this.serialStatusInterval) {
            clearInterval(this.serialStatusInterval);
            this.serialStatusInterval = null;
        }
    }

    async checkSerialConnection() {
        try {
            const response = await fetch(`${this.apiBase}/api/radio/serial/status`);
            if (response.ok) {
                const status = await response.json();

                if (status.running) {
                    console.log('Serial CAT server is already running (auto-connect)');
                    // Update UI to reflect running state
                    this.serialStartBtn.disabled = true;
                    this.serialStopBtn.disabled = false;
                    this.serialStatusDisplay.style.display = 'block';

                    // Update status display
                    this.updateSerialStatus();

                    // Start polling serial status
                    this.startSerialStatusPolling();
                } else {
                    console.log('Serial CAT server not running');
                }
            }
        } catch (error) {
            console.error('Failed to check serial connection:', error);
        }
    }

    // Bookmark Methods

    async loadBookmarks() {
        if (!this.connected) {
            console.log('Not connected, skipping bookmark load');
            return;
        }

        console.log('Loading bookmarks from API...');
        try {
            const response = await fetch(`${this.apiBase}/api/bookmarks`);
            console.log('Bookmarks API response status:', response.status);

            if (response.ok) {
                const bookmarks = await response.json();
                console.log('Received bookmarks:', bookmarks);
                this.populateBookmarks(bookmarks);

                // Update spectrum display with bookmarks
                if (this.spectrumDisplay) {
                    this.spectrumDisplay.setBookmarks(bookmarks);
                }

                console.log(`Successfully loaded ${bookmarks.length} bookmarks`);
            } else {
                const errorText = await response.text();
                console.error('Failed to load bookmarks:', response.status, errorText);
                this.clearBookmarks();
            }
        } catch (error) {
            console.error('Error loading bookmarks:', error);
            this.clearBookmarks();
        }
    }

    populateBookmarks(bookmarks) {
        if (!this.bookmarkSelect) return;

        // Clear existing options except the first one
        this.bookmarkSelect.innerHTML = '<option value="">-- Select Bookmark --</option>';

        // Add bookmarks
        if (bookmarks && bookmarks.length > 0) {
            bookmarks.forEach(bookmark => {
                const option = document.createElement('option');
                option.value = JSON.stringify(bookmark); // Store full bookmark data
                option.textContent = bookmark.name || 'Unnamed';
                this.bookmarkSelect.appendChild(option);
            });

            // Enable the dropdown
            this.bookmarkSelect.disabled = false;
            console.log(`Populated ${bookmarks.length} bookmarks`);
        } else {
            this.bookmarkSelect.disabled = true;
            console.log('No bookmarks available');
        }
    }

    clearBookmarks() {
        if (!this.bookmarkSelect) return;

        this.bookmarkSelect.innerHTML = '<option value="">-- Select Bookmark --</option>';
        this.bookmarkSelect.disabled = true;
    }

    onBookmarkSelected() {
        const selectedValue = this.bookmarkSelect.value;

        // Reset to default selection after processing
        setTimeout(() => {
            this.bookmarkSelect.value = '';
        }, 100);

        if (!selectedValue) return;

        try {
            const bookmark = JSON.parse(selectedValue);
            console.log('Selected bookmark:', bookmark);

            // Extract frequency and mode
            const frequency = bookmark.frequency;
            const mode = bookmark.mode;

            if (!frequency) {
                console.error('Bookmark missing frequency');
                return;
            }

            // Map mode names (similar to Python client)
            const modeMap = {
                'CWR': 'cw',
                'CW': 'cwu',  // CW -> CW-U
                'cw': 'cwu',  // Default CW to CW-U
                'cwu': 'cwu',
                'cwl': 'cwl'
            };

            // Convert mode to lowercase first, then check map
            let mappedMode = mode ? mode.toLowerCase() : 'usb';
            if (modeMap[mappedMode]) {
                mappedMode = modeMap[mappedMode];
            }

            // Update frequency input
            this.frequencyInput.value = frequency;

            // Update mode select if mode is provided
            if (mode) {
                // Check if the mode exists in the select options
                const modeOption = Array.from(this.modeSelect.options).find(
                    opt => opt.value === mappedMode
                );
                if (modeOption) {
                    // Set flag to prevent mode change event from calling updateModeDefaults
                    this.bookmarkModeChange = true;
                    this.modeSelect.value = mappedMode;
                    // Update bandwidth defaults for the new mode
                    this.updateModeDefaults();
                    // Clear flag after a short delay
                    setTimeout(() => {
                        this.bookmarkModeChange = false;
                    }, 100);
                } else {
                    console.warn(`Mode ${mappedMode} not found in mode select, keeping current mode`);
                }
            }

            // Apply the changes if connected - use applySettings to send both frequency AND mode
            if (this.connected) {
                this.applySettings();
                this.showSuccess(`Loaded bookmark: ${bookmark.name}`);
            } else {
                this.showInfo(`Bookmark loaded: ${bookmark.name} (connect to apply)`);
            }

        } catch (error) {
            console.error('Error parsing bookmark:', error);
            this.showError('Bookmark Error', 'Failed to load bookmark');
        }
    }

    // Band Methods

    async loadBands() {
        if (!this.connected) {
            console.log('Not connected, skipping band load');
            return;
        }

        console.log('Loading bands from API...');
        try {
            const response = await fetch(`${this.apiBase}/api/bands`);
            console.log('Bands API response status:', response.status);

            if (response.ok) {
                const bands = await response.json();
                console.log('Received bands:', bands);

                // Assign colors to bands (rainbow gradient with pastel colors)
                const colors = [
                    '#ffcccc', '#ffd9cc', '#ffe6cc', '#ffffcc', '#e6ffcc',
                    '#ccffcc', '#ccffe6', '#ccffff', '#cce6ff', '#ccccff',
                    '#d9ccff', '#e6ccff', '#ffccff', '#ffcce6'
                ];

                if (bands && bands.length > 0) {
                    bands.forEach((band, index) => {
                        band.color = colors[index % colors.length];
                    });

                    // Store bands for later use
                    this.loadedBands = bands;

                    // Populate band dropdown
                    this.populateBands(bands);

                    // Update spectrum display with bands (if it exists)
                    if (this.spectrumDisplay) {
                        console.log('Setting bands on spectrum display...');
                        this.spectrumDisplay.setBands(bands);
                    } else {
                        console.log('Spectrum display not initialized yet - bands stored for later');
                    }

                    console.log(`Successfully loaded ${bands.length} bands`);
                } else {
                    console.log('No bands available');
                }
            } else {
                const errorText = await response.text();
                console.error('Failed to load bands:', response.status, errorText);
            }
        } catch (error) {
            console.error('Error loading bands:', error);
        }
    }

    populateBands(bands) {
        if (!this.bandSelect) return;

        // Clear existing options except the first one
        this.bandSelect.innerHTML = '<option value="">-- Select Band --</option>';

        // Add bands
        if (bands && bands.length > 0) {
            bands.forEach(band => {
                const option = document.createElement('option');
                option.value = JSON.stringify(band); // Store full band data
                option.textContent = band.label || 'Unnamed';
                this.bandSelect.appendChild(option);
            });

            // Enable the dropdown
            this.bandSelect.disabled = false;
            console.log(`Populated ${bands.length} bands in dropdown`);
        } else {
            this.bandSelect.disabled = true;
            console.log('No bands available for dropdown');
        }
    }

    onBandSelected() {
        const selectedValue = this.bandSelect.value;

        // Reset to default selection after processing
        setTimeout(() => {
            this.bandSelect.value = '';
        }, 100);

        if (!selectedValue) return;

        try {
            const band = JSON.parse(selectedValue);
            console.log('Selected band:', band);

            // Calculate center frequency of the band
            const centerFreq = Math.floor((band.start + band.end) / 2);

            // Update frequency input
            this.frequencyInput.value = centerFreq;

            // Apply the frequency change if connected
            if (this.connected) {
                this.updateFrequency();
                this.showSuccess(`Tuned to ${band.label}: ${this.formatFrequency(centerFreq)}`);
            } else {
                this.showInfo(`Band loaded: ${band.label} (connect to apply)`);
            }

        } catch (error) {
            console.error('Error parsing band:', error);
            this.showError('Band Error', 'Failed to load band');
        }
    }

    // Band Conditions Methods

    async loadBandConditions() {
        if (!this.connected) {
            console.log('Not connected, skipping band conditions load');
            return;
        }

        console.log('Fetching band conditions from:', `${this.apiBase}/api/noisefloor/latest`);

        try {
            const response = await fetch(`${this.apiBase}/api/noisefloor/latest`);
            
            if (response.status === 204) {
                // No data available yet
                console.log('No band condition data available yet');
                return;
            }

            if (response.ok) {
                const data = await response.json();
                console.log('Received band conditions:', data);
                this.updateBandConditions(data);
            } else {
                console.error('Failed to load band conditions:', response.status);
            }
        } catch (error) {
            console.error('Error loading band conditions:', error);
        }
    }

    updateBandConditions(data) {
        // Store the band conditions data
        this.bandConditions = data;

        // Update band button colors
        this.updateBandButtonColors();
    }

    calculateBandStatus(ft8Snr) {
        if (!ft8Snr || ft8Snr <= 0) {
            return 'UNKNOWN';
        }

        if (ft8Snr < this.SNR_THRESHOLDS.POOR) {
            return 'POOR';
        } else if (ft8Snr < this.SNR_THRESHOLDS.FAIR) {
            return 'FAIR';
        } else if (ft8Snr < this.SNR_THRESHOLDS.GOOD) {
            return 'GOOD';
        } else {
            return 'EXCELLENT';
        }
    }

    updateBandButtonColors() {
        console.log('updateBandButtonColors called');
        console.log('Band conditions data:', this.bandConditions);
        console.log('Number of band buttons:', this.bandButtons.length);

        // Update colors for band buttons in the UI
        this.bandButtons.forEach(btn => {
            const bandLabel = btn.textContent.trim();
            console.log(`Processing button: "${bandLabel}"`);

            // Find matching band data (handle different naming conventions)
            let bandData = null;
            for (const [bandName, data] of Object.entries(this.bandConditions)) {
                console.log(`  Checking band name: "${bandName}" against "${bandLabel}"`);
                // Match band names like "20m" with button labels like "20m"
                if (bandName === bandLabel || bandName.toLowerCase() === bandLabel.toLowerCase()) {
                    bandData = data;
                    console.log(`  Match found! Data:`, data);
                    break;
                }
            }

            if (bandData && bandData.ft8_snr) {
                const status = this.calculateBandStatus(bandData.ft8_snr);
                const color = this.BAND_CONDITION_COLORS[status];

                // Apply color to button
                btn.style.backgroundColor = color;
                btn.style.borderColor = color;

                // Add tooltip with SNR value
                btn.title = `${bandLabel}: ${status} (${bandData.ft8_snr.toFixed(1)} dB SNR)`;

                console.log(`Updated ${bandLabel} button: ${status} (${bandData.ft8_snr.toFixed(1)} dB), color: ${color}`);
            } else {
                // No data available - use unknown color
                const color = this.BAND_CONDITION_COLORS.UNKNOWN;
                btn.style.backgroundColor = color;
                btn.style.borderColor = color;
                btn.title = `${bandLabel}: No data available`;
                console.log(`No data for ${bandLabel}, using UNKNOWN color: ${color}`);
            }
        });
    }

    startBandConditionsPolling() {
        console.log('startBandConditionsPolling() called');
        console.log('Connected:', this.connected);
        console.log('Band buttons count:', this.bandButtons ? this.bandButtons.length : 'undefined');

        // Load immediately
        this.loadBandConditions();

        // Then poll every 60 seconds
        this.bandConditionsInterval = setInterval(() => {
            this.loadBandConditions();
        }, 60000);

        console.log('Started band conditions polling (60 second interval)');
    }

    stopBandConditionsPolling() {
        if (this.bandConditionsInterval) {
            clearInterval(this.bandConditionsInterval);
            this.bandConditionsInterval = null;
            console.log('Stopped band conditions polling');
        }

        // Reset band button colors to default
        this.bandButtons.forEach(btn => {
            btn.style.backgroundColor = '';
            btn.style.borderColor = '';
            btn.title = '';
        });
    }

    // Instance Info Methods

    async loadInstanceInfo() {
        console.log('loadInstanceInfo: Fetching from', `${this.apiBase}/api/description`);
        try {
            const response = await fetch(`${this.apiBase}/api/description`);
            console.log('loadInstanceInfo: Response status:', response.status);
            
            if (response.ok) {
                const description = await response.json();
                console.log('loadInstanceInfo: Received description:', description);
                this.displayInstanceInfo(description);
            } else {
                const errorText = await response.text();
                console.log('loadInstanceInfo: No instance description available, status:', response.status, 'error:', errorText);
            }
        } catch (error) {
            console.error('loadInstanceInfo: Error loading instance info:', error);
        }
    }

    displayInstanceInfo(desc) {
        if (!desc || !this.instanceInfoDiv || !this.instanceInfoText) {
            return;
        }

        console.log('Instance description received:', desc);

        // Build the info string: callsign - name - location | version | Open Map
        const parts = [];
        
        // Handle both nested receiver object and flat structure
        const callsign = desc.receiver?.callsign || desc.callsign || desc.Callsign;
        const name = desc.receiver?.name || desc.name || desc.Name;
        const location = desc.receiver?.location || desc.location || desc.Location;
        const version = desc.version || desc.Version;
        const publicUUID = desc.public_uuid || desc.PublicUUID || desc.public_UUID;
        // public_url is nested in receiver object
        const publicURL = desc.receiver?.public_url || desc.public_url || desc.PublicURL || desc.public_URL;

        if (callsign) parts.push(callsign);
        if (name) parts.push(name);
        if (location) parts.push(location);

        let infoHTML = '';
        
        // Make the callsign/name/location part a link if public_url is available
        const infoText = parts.join(' - ');
        if (infoText) {
            if (publicURL) {
                infoHTML = `<a href="${publicURL}" target="_blank" style="color: #2196F3; text-decoration: none;">${infoText}</a>`;
            } else {
                infoHTML = infoText;
            }
        }

        // Add version with 'v' prefix
        if (version) {
            if (infoHTML) infoHTML += ' | ';
            infoHTML += 'v' + version;
        }

        // Add map link if public_uuid is available
        if (publicUUID) {
            if (infoHTML) infoHTML += ' | ';
            infoHTML += `<a href="https://instances.ubersdr.org/?uuid=${publicUUID}" target="_blank" style="color: #2196F3; text-decoration: none;">Open Map</a>`;
        }

        if (infoHTML) {
            this.instanceInfoText.innerHTML = infoHTML;
            this.instanceInfoDiv.style.display = 'block';
            console.log('Instance info displayed:', infoHTML);
        } else {
            console.log('No instance info to display');
        }
    }
}

// Initialize the client when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.uberSDR = new UberSDRClient();
});