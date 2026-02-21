// Morse Code (CW) Decoder Extension for ka9q UberSDR
// Multi-channel decoder supporting up to 5 simultaneous CW signals
// Backend-based decoder using WebSocket communication
// Version: 1.0.0

class MorseExtension extends DecoderExtension {
    constructor() {
        console.log('Morse: Constructor called');
        super('morse', {
            displayName: 'Morse Code Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 2400
        });
        console.log('Morse: Super constructor completed');

        // Configuration
        this.config = {
            bandwidth: 100,
            min_wpm: 12,
            max_wpm: 45,
            threshold_snr: 10
        };

        // State
        this.running = false;
        this.autoScroll = true;
        this.showMorse = true;
        this.showTimestamp = false; // Disabled by default

        // Channel state (5 channels)
        this.channels = [];
        for (let i = 0; i < 5; i++) {
            this.channels.push({
                id: i,
                active: false,
                frequency: 0,
                wpm: 0,
                snr: 0,
                textBuffer: '',
                morseBuffer: ''
            });
        }

        // Channel frequencies (user-specified)
        this.channelFrequencies = [0, 0, 0, 0, 0];

        this.activeChannelCount = 0;

        // Binary message handler
        this.binaryMessageHandler = null;
        this.originalDXHandler = null;

        // Spectrum visualization
        this.spectrumCanvas = null;
        this.spectrumCtx = null;

        // Channel colors (5 distinct colors)
        this.channelColors = [
            '#FF5722', // Red-Orange (Channel 0)
            '#2196F3', // Blue (Channel 1)
            '#4CAF50', // Green (Channel 2)
            '#FFC107', // Amber (Channel 3)
            '#9C27B0'  // Purple (Channel 4)
        ];
    }

    onInitialize() {
        console.log('Morse: onInitialize called');
        this.renderTemplate();
        this.showDevelopmentWarning();
        this.waitForDOMAndSetupHandlers();
        console.log('Morse: onInitialize complete');
    }

    showDevelopmentWarning() {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'morse-dev-overlay';
        overlay.innerHTML = `
            <div class="morse-dev-overlay-content">
                <div class="morse-dev-overlay-title">
                    ⚠️ Development Notice
                </div>
                <div class="morse-dev-overlay-message">
                    This Morse Code Decoder extension is currently under development and does not function properly.
                    Features may be incomplete, unstable, or non-functional.
                </div>
                <button class="morse-dev-overlay-button" id="morse-dev-ok-btn">OK</button>
            </div>
        `;

        // Add to body
        document.body.appendChild(overlay);

        // Setup OK button handler
        const okBtn = document.getElementById('morse-dev-ok-btn');
        if (okBtn) {
            okBtn.addEventListener('click', () => {
                overlay.remove();
            });
        }

        console.log('Morse: Development warning overlay displayed');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 20;

            const startBtn = document.getElementById('morse-start-btn');
            const clearAllBtn = document.getElementById('morse-clear-all-btn');
            const settingsBtn = document.getElementById('morse-settings-btn');

            console.log(`Morse: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                startBtn: !!startBtn,
                clearAllBtn: !!clearAllBtn,
                settingsBtn: !!settingsBtn
            });

            if (startBtn && clearAllBtn && settingsBtn) {
                console.log('Morse: All DOM elements found, setting up...');
                this.setupCanvas();
                this.setupEventHandlers();
                console.log('Morse: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`Morse: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('Morse: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.morse_template;

        if (!template) {
            console.error('Morse extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    getContentElement() {
        const container = document.querySelector('.extension-content[data-extension="morse"]');
        if (!container) {
            console.error('Morse: Extension content container not found');
        }
        return container;
    }

    setupCanvas() {
        this.spectrumCanvas = document.getElementById('morse-spectrum-canvas');
        if (this.spectrumCanvas) {
            this.spectrumCtx = this.spectrumCanvas.getContext('2d');
            // Set canvas size to match display size
            const rect = this.spectrumCanvas.getBoundingClientRect();
            this.spectrumCanvas.width = rect.width;
            this.spectrumCanvas.height = rect.height;

            // Add click handlers for channel management
            this.spectrumCanvas.addEventListener('click', (e) => this.handleSpectrumClick(e, false));
            this.spectrumCanvas.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.handleSpectrumClick(e, true);
            });

            console.log('Morse: Spectrum canvas initialized with click handlers');
        }
    }

    handleSpectrumClick(e, isRightClick) {
        const rect = this.spectrumCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        // Calculate frequency from click position (0-3000 Hz range)
        const maxDisplayFreq = 3000;
        const clickedFreq = Math.round((x / width) * maxDisplayFreq);

        if (isRightClick) {
            // Right-click: Remove channel at this frequency
            this.removeChannelAtFrequency(clickedFreq);
        } else {
            // Left-click: Add channel at this frequency
            this.addChannelAtFrequency(clickedFreq);
        }
    }

    addChannelAtFrequency(frequency) {
        // Check if we already have 5 active channels
        const activeCount = this.channels.filter(ch => ch.active).length;
        if (activeCount >= 5) {
            this.showStatusMessage('Maximum of 5 channels reached. Right-click to remove a channel first.', 'error');
            return;
        }

        // Find first inactive channel
        const channelId = this.channels.findIndex(ch => !ch.active);
        if (channelId === -1) {
            this.showStatusMessage('All channels are active', 'error');
            return;
        }

        // Set frequency and enable channel
        const freqInput = document.getElementById(`morse-freq-${channelId}`);
        if (freqInput) {
            freqInput.value = frequency;
        }

        this.channelFrequencies[channelId] = frequency;
        this.channels[channelId].active = true;
        this.channels[channelId].frequency = frequency;

        // Update UI
        const enableBtn = document.getElementById(`morse-enable-${channelId}`);
        if (enableBtn) {
            enableBtn.textContent = 'Disable';
            enableBtn.classList.remove('btn-small');
            enableBtn.classList.add('btn-danger');
        }

        const channelEl = document.getElementById(`morse-channel-${channelId}`);
        if (channelEl) {
            channelEl.classList.add('active');
            channelEl.classList.remove('idle');
            const statusEl = channelEl.querySelector('.morse-channel-status');
            if (statusEl) statusEl.textContent = 'Active';
        }

        console.log(`Morse: Added channel ${channelId} at ${frequency} Hz`);

        // Restart decoder if running
        if (this.running) {
            this.stopDecoder();
            setTimeout(() => this.startDecoder(), 100);
        }
    }

    removeChannelAtFrequency(frequency) {
        // Find channel closest to clicked frequency
        const bandwidth = this.config.bandwidth;
        let closestChannel = -1;
        let closestDistance = Infinity;

        for (let i = 0; i < 5; i++) {
            if (this.channels[i].active) {
                const distance = Math.abs(this.channels[i].frequency - frequency);
                if (distance < closestDistance && distance < bandwidth) {
                    closestDistance = distance;
                    closestChannel = i;
                }
            }
        }

        if (closestChannel !== -1) {
            // Disable the channel
            this.channelFrequencies[closestChannel] = 0;
            this.channels[closestChannel].active = false;

            const enableBtn = document.getElementById(`morse-enable-${closestChannel}`);
            if (enableBtn) {
                enableBtn.textContent = 'Enable';
                enableBtn.classList.remove('btn-danger');
                enableBtn.classList.add('btn-small');
            }

            const channelEl = document.getElementById(`morse-channel-${closestChannel}`);
            if (channelEl) {
                channelEl.classList.remove('active');
                channelEl.classList.add('idle');
                const statusEl = channelEl.querySelector('.morse-channel-status');
                if (statusEl) statusEl.textContent = 'Idle';
            }

            console.log(`Morse: Removed channel ${closestChannel}`);

            // Restart decoder if running
            if (this.running) {
                this.stopDecoder();
                setTimeout(() => this.startDecoder(), 100);
            }
        }
    }

    setupEventHandlers() {
        // Start/Stop button
        const startBtn = document.getElementById('morse-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.toggleDecoder());
        }

        // Clear all button
        const clearAllBtn = document.getElementById('morse-clear-all-btn');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => this.clearAllChannels());
        }

        // Settings button
        const settingsBtn = document.getElementById('morse-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.toggleSettings());
        }

        // Preset selector
        const presetSelect = document.getElementById('morse-preset-select');
        if (presetSelect) {
            presetSelect.addEventListener('change', (e) => this.applyPreset(e.target.value));
        }

        // Configuration inputs
        const configInputs = [
            'morse-bandwidth',
            'morse-min-wpm',
            'morse-max-wpm',
            'morse-threshold-snr'
        ];

        configInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('change', () => this.updateConfig());
            }
        });

        // Display options
        const showMorseCheckbox = document.getElementById('morse-show-morse');
        if (showMorseCheckbox) {
            showMorseCheckbox.addEventListener('change', (e) => {
                this.showMorse = e.target.checked;
                this.updateMorseVisibility();
            });
        }

        const autoScrollCheckbox = document.getElementById('morse-auto-scroll');
        if (autoScrollCheckbox) {
            autoScrollCheckbox.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
            });
        }

        // Channel-specific buttons
        for (let i = 0; i < 5; i++) {
            const clearBtn = document.querySelector(`#morse-channel-${i} .morse-channel-clear-btn`);
            if (clearBtn) {
                clearBtn.addEventListener('click', () => this.clearChannel(i));
            }

            const copyBtn = document.querySelector(`#morse-channel-${i} .morse-channel-copy-btn`);
            if (copyBtn) {
                copyBtn.addEventListener('click', () => this.copyChannel(i));
            }

            const enableBtn = document.getElementById(`morse-enable-${i}`);
            if (enableBtn) {
                enableBtn.addEventListener('click', () => this.toggleChannel(i));
            }
        }
    }

    toggleSettings() {
        const panel = document.getElementById('morse-config-panel');
        if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    }

    applyPreset(preset) {
        const presets = {
            standard: { bandwidth: 100, min_wpm: 12, max_wpm: 45, threshold_snr: 10 },
            fast: { bandwidth: 100, min_wpm: 20, max_wpm: 60, threshold_snr: 10 },
            slow: { bandwidth: 100, min_wpm: 5, max_wpm: 20, threshold_snr: 10 }
        };

        if (preset !== 'custom' && presets[preset]) {
            const config = presets[preset];
            document.getElementById('morse-bandwidth').value = config.bandwidth;
            document.getElementById('morse-min-wpm').value = config.min_wpm;
            document.getElementById('morse-max-wpm').value = config.max_wpm;
            document.getElementById('morse-threshold-snr').value = config.threshold_snr;
            this.updateConfig();
        }
    }

    updateConfig() {
        this.config = {
            bandwidth: parseFloat(document.getElementById('morse-bandwidth').value),
            min_wpm: parseFloat(document.getElementById('morse-min-wpm').value),
            max_wpm: parseFloat(document.getElementById('morse-max-wpm').value),
            threshold_snr: parseFloat(document.getElementById('morse-threshold-snr').value)
        };

        // If decoder is running, restart with new config
        if (this.running) {
            this.stopDecoder();
            setTimeout(() => this.startDecoder(), 100);
        }
    }

    toggleDecoder() {
        if (this.running) {
            this.stopDecoder();
        } else {
            this.startDecoder();
        }
    }

    toggleChannel(channelId) {
        const freqInput = document.getElementById(`morse-freq-${channelId}`);
        const enableBtn = document.getElementById(`morse-enable-${channelId}`);

        if (!freqInput || !enableBtn) return;

        const channel = this.channels[channelId];

        if (channel.active) {
            // Disable channel
            this.channelFrequencies[channelId] = 0;
            channel.active = false;
            enableBtn.textContent = 'Enable';
            enableBtn.classList.remove('btn-danger');
            enableBtn.classList.add('btn-small');

            const channelEl = document.getElementById(`morse-channel-${channelId}`);
            if (channelEl) {
                channelEl.classList.remove('active');
                channelEl.classList.add('idle');
                const statusEl = channelEl.querySelector('.morse-channel-status');
                if (statusEl) statusEl.textContent = 'Idle';
            }
        } else {
            // Enable channel
            const freq = parseFloat(freqInput.value);
            if (freq < 100 || freq > 5000) {
                this.showStatusMessage('Frequency must be between 100 and 5000 Hz', 'error');
                return;
            }

            // Check if we already have 5 active channels
            const activeCount = this.channels.filter(ch => ch.active).length;
            if (activeCount >= 5) {
                this.showStatusMessage('Maximum of 5 channels reached', 'error');
                return;
            }

            this.channelFrequencies[channelId] = freq;
            channel.active = true;
            channel.frequency = freq;
            enableBtn.textContent = 'Disable';
            enableBtn.classList.remove('btn-small');
            enableBtn.classList.add('btn-danger');

            const channelEl = document.getElementById(`morse-channel-${channelId}`);
            if (channelEl) {
                channelEl.classList.add('active');
                channelEl.classList.remove('idle');
                const statusEl = channelEl.querySelector('.morse-channel-status');
                if (statusEl) statusEl.textContent = 'Active';
            }
        }

        // Restart decoder if running
        if (this.running) {
            this.stopDecoder();
            setTimeout(() => this.startDecoder(), 100);
        }
    }

    startDecoder() {
        console.log('Morse: Starting decoder with config:', this.config);
        console.log('Morse: Channel frequencies:', this.channelFrequencies);

        // Setup binary message handler
        this.setupBinaryHandler();

        // Attach audio extension
        this.attachAudioExtension();

        this.running = true;
        this.updateStatus('Running - Manual frequency control');

        const startBtn = document.getElementById('morse-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Stop';
            startBtn.classList.remove('btn-primary');
            startBtn.classList.add('btn-danger');
        }
    }

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('Morse: DX WebSocket not connected');
            this.updateStatus('Error: WebSocket not connected');
            return;
        }

        // Send attach message with channel frequencies
        const attachMsg = {
            type: 'audio_extension_attach',
            extension_name: 'morse',
            params: {
                bandwidth: this.config.bandwidth,
                min_wpm: this.config.min_wpm,
                max_wpm: this.config.max_wpm,
                threshold_snr: this.config.threshold_snr,
                channel_frequencies: this.channelFrequencies
            }
        };

        console.log('Morse: Sending attach message:', attachMsg);
        dxClient.ws.send(JSON.stringify(attachMsg));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('Morse: DX WebSocket not connected');
            return;
        }

        // Send detach message
        const detachMsg = {
            type: 'audio_extension_detach'
        };

        console.log('Morse: Sending detach message');
        dxClient.ws.send(JSON.stringify(detachMsg));
    }

    stopDecoder() {
        console.log('Morse: Stopping decoder');

        // Detach audio extension
        this.detachAudioExtension();

        // Restore original DX handler
        this.restoreBinaryHandler();

        this.running = false;
        this.updateStatus('Stopped');

        const startBtn = document.getElementById('morse-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Start';
            startBtn.classList.remove('btn-danger');
            startBtn.classList.add('btn-primary');
        }
    }

    setupBinaryHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('Morse: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('Morse: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as Morse data
                this.handleBinaryMessage(event.data);
                // DO NOT pass binary messages to original handler
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    this.handleBinaryMessage(arrayBuffer);
                }).catch(err => {
                    console.error('Morse: Failed to convert Blob to ArrayBuffer:', err);
                });
                // DO NOT pass binary messages to original handler
            } else {
                // Text message - pass to original handler
                if (this.originalDXHandler && this.originalDXHandler !== this.binaryMessageHandler) {
                    this.originalDXHandler.call(dxClient.ws, event);
                }
            }
        };

        dxClient.ws.onmessage = this.binaryMessageHandler;
        console.log('Morse: Binary message handler installed');
    }

    restoreBinaryHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            return;
        }

        // Restore original handler
        if (this.originalDXHandler) {
            dxClient.ws.onmessage = this.originalDXHandler;
            this.originalDXHandler = null;
            console.log('Morse: Original message handler restored');
        }

        this.binaryMessageHandler = null;
    }

    handleBinaryMessage(data) {
        const view = new DataView(data);
        const type = view.getUint8(0);
        const decoderId = view.getUint8(1);

        switch (type) {
            case 0x01: // Combined morse+text message
                this.handleCombinedMessage(view, decoderId);
                break;
            case 0x03: // WPM update
                this.handleWPMUpdate(view, decoderId);
                break;
            case 0x04: // Decoder assignment
                this.handleDecoderAssignment(view, decoderId);
                break;
            case 0x05: // Status update
                this.handleStatusUpdate(view);
                break;
            default:
                console.warn('Morse: Unknown message type:', type);
        }
    }

    handleCombinedMessage(view, decoderId) {
        // [type:1][decoder_id:1][timestamp:8][morse_length:4][morse:length][text_length:4][text:length]
        const timestamp = Number(view.getBigUint64(2, false));
        const morseLength = view.getUint32(10, false);

        const morseBytes = new Uint8Array(view.buffer, 14, morseLength);
        const morse = new TextDecoder().decode(morseBytes);

        const textOffset = 14 + morseLength;
        const textLength = view.getUint32(textOffset, false);
        const textBytes = new Uint8Array(view.buffer, textOffset + 4, textLength);
        const text = new TextDecoder().decode(textBytes);

        this.appendToChannel(decoderId, morse, text, timestamp);
    }

    handleWPMUpdate(view, decoderId) {
        // [type:1][decoder_id:1][wpm:8]
        const wpm = view.getFloat64(2, false);
        this.updateChannelWPM(decoderId, wpm);
    }

    handleDecoderAssignment(view, decoderId) {
        // [type:1][decoder_id:1][frequency:8][active:1]
        const frequency = view.getFloat64(2, false);
        const active = view.getUint8(10) === 1;

        if (active) {
            this.activateChannel(decoderId, frequency);
        } else {
            this.deactivateChannel(decoderId);
        }
    }

    handleStatusUpdate(view) {
        // [type:1][num_active:1][decoder_data...]
        // decoder_data: [id:1][frequency:8][wpm:8][snr:8]
        const numActive = view.getUint8(1);
        let offset = 2;

        for (let i = 0; i < numActive; i++) {
            const id = view.getUint8(offset);
            const freq = view.getFloat64(offset + 1, false);
            const wpm = view.getFloat64(offset + 9, false);
            const snr = view.getFloat64(offset + 17, false);

            this.updateChannelStatus(id, freq, wpm, snr);
            offset += 25;
        }

        this.activeChannelCount = numActive;
        this.updateActiveCount();
    }

    activateChannel(id, frequency) {
        const channel = this.channels[id];
        channel.active = true;
        channel.frequency = frequency;

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            channelEl.classList.add('active');
            channelEl.classList.remove('idle');

            const statusEl = channelEl.querySelector('.morse-channel-status');
            if (statusEl) statusEl.textContent = 'Active';

            const freqEl = channelEl.querySelector('.morse-channel-freq');
            if (freqEl) freqEl.textContent = `${frequency.toFixed(0)} Hz`;
        }

        this.activeChannelCount++;
        this.updateActiveCount();
        console.log(`Morse: Channel ${id} activated at ${frequency} Hz`);
    }

    deactivateChannel(id) {
        const channel = this.channels[id];
        channel.active = false;

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            channelEl.classList.remove('active');
            channelEl.classList.add('idle');

            const statusEl = channelEl.querySelector('.morse-channel-status');
            if (statusEl) statusEl.textContent = 'Idle';

            const freqEl = channelEl.querySelector('.morse-channel-freq');
            if (freqEl) freqEl.textContent = '---';

            const wpmEl = channelEl.querySelector('.morse-channel-wpm');
            if (wpmEl) wpmEl.textContent = '-- WPM';
        }

        this.activeChannelCount--;
        this.updateActiveCount();
        console.log(`Morse: Channel ${id} deactivated`);
    }

    updateChannelWPM(id, wpm) {
        const channel = this.channels[id];
        channel.wpm = wpm;

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            const wpmEl = channelEl.querySelector('.morse-channel-wpm');
            if (wpmEl) wpmEl.textContent = `${wpm.toFixed(1)} WPM`;
        }
    }

    updateChannelStatus(id, frequency, wpm, snr) {
        this.channels[id].frequency = frequency;
        this.channels[id].wpm = wpm;
        this.channels[id].snr = snr;

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            const freqEl = channelEl.querySelector('.morse-channel-freq');
            if (freqEl) freqEl.textContent = `${frequency.toFixed(0)} Hz`;

            const wpmEl = channelEl.querySelector('.morse-channel-wpm');
            if (wpmEl) wpmEl.textContent = `${wpm.toFixed(1)} WPM`;

            const snrEl = channelEl.querySelector('.morse-channel-snr');
            if (snrEl) snrEl.textContent = `${snr.toFixed(1)} dB`;
        }
    }

    appendToChannel(id, morse, text, timestamp) {
        const channel = this.channels[id];
        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (!channelEl) return;

        const textEl = channelEl.querySelector('.morse-channel-text');
        const morseEl = channelEl.querySelector('.morse-channel-morse');
        if (!textEl || !morseEl) return;

        // Append text (no timestamps)
        if (text) {
            textEl.textContent += text;
            channel.textBuffer += text;
        }

        // Append morse
        if (morse && this.showMorse) {
            morseEl.textContent += morse;
            channel.morseBuffer += morse;
        }

        // Auto-scroll horizontally to the right (newest content) - scroll each container independently
        if (this.autoScroll) {
            const textContainer = channelEl.querySelector('.morse-channel-text-container');
            const morseContainer = channelEl.querySelector('.morse-channel-morse-container');
            if (textContainer) {
                textContainer.scrollLeft = textContainer.scrollWidth;
            }
            if (morseContainer) {
                morseContainer.scrollLeft = morseContainer.scrollWidth;
            }
        }
    }

    clearChannel(id) {
        const channel = this.channels[id];
        channel.textBuffer = '';
        channel.morseBuffer = '';

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            const textEl = channelEl.querySelector('.morse-channel-text');
            const morseEl = channelEl.querySelector('.morse-channel-morse');
            if (textEl) textEl.textContent = '';
            if (morseEl) morseEl.textContent = '';
        }
    }

    clearAllChannels() {
        for (let i = 0; i < 5; i++) {
            this.clearChannel(i);
        }
    }

    copyChannel(id) {
        const channel = this.channels[id];
        const text = channel.textBuffer;

        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                console.log(`Morse: Channel ${id} text copied to clipboard`);
                this.updateStatus(`Channel ${id} copied to clipboard`);
                setTimeout(() => this.updateStatus('Running'), 2000);
            }).catch(err => {
                console.error('Morse: Failed to copy:', err);
            });
        }
    }

    updateMorseVisibility() {
        for (let i = 0; i < 5; i++) {
            const channelEl = document.getElementById(`morse-channel-${i}`);
            if (channelEl) {
                const morseEl = channelEl.querySelector('.morse-channel-morse');
                if (morseEl) {
                    if (this.showMorse) {
                        morseEl.classList.remove('hidden');
                    } else {
                        morseEl.classList.add('hidden');
                    }
                }
            }
        }
    }

    updateActiveCount() {
        const indicator = document.getElementById('morse-active-channels');
        if (indicator) {
            const valueEl = indicator.querySelector('.morse-indicator-value');
            if (valueEl) {
                valueEl.textContent = `${this.activeChannelCount}/5`;
            }
        }
    }

    updateStatus(text) {
        const statusEl = document.getElementById('morse-status-text');
        if (statusEl) {
            statusEl.textContent = text;
        }
    }

    showStatusMessage(message, type = 'info') {
        const statusEl = document.getElementById('morse-status-text');
        if (!statusEl) return;

        // Store original status
        const originalText = statusEl.textContent;
        const originalColor = statusEl.style.color;

        // Set message with color
        statusEl.textContent = message;
        if (type === 'error') {
            statusEl.style.color = '#f44336';
        } else if (type === 'success') {
            statusEl.style.color = '#4CAF50';
        } else {
            statusEl.style.color = '#FFC107';
        }

        // Restore original status after 3 seconds
        setTimeout(() => {
            statusEl.textContent = originalText;
            statusEl.style.color = originalColor;
        }, 3000);
    }

    onProcessAudio(dataArray) {
        // Morse processes audio on the backend (Go side) via the audio extension framework
        // But we still draw the spectrum visualization here
        this.drawSpectrum(dataArray);
    }

    drawSpectrum(dataArray) {
        if (!this.spectrumCanvas || !this.spectrumCtx) return;

        const ctx = this.spectrumCtx;
        const canvas = this.spectrumCanvas;
        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);

        // Get frequency data
        const analyser = this.radio.getAnalyser();
        if (!analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const freqData = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(freqData);

        // Calculate frequency range to display (0-3000 Hz)
        const sampleRate = window.audioContext ? window.audioContext.sampleRate : 48000;
        const nyquist = sampleRate / 2;
        const maxDisplayFreq = 3000;
        const binWidth = nyquist / bufferLength;
        const maxBin = Math.min(bufferLength, Math.floor(maxDisplayFreq / binWidth));

        // Draw spectrum bars
        const barWidth = width / maxBin;
        ctx.fillStyle = '#4CAF50';

        for (let i = 0; i < maxBin; i++) {
            const barHeight = (freqData[i] / 255) * height;
            const x = i * barWidth;
            const y = height - barHeight;

            // Color based on intensity
            const intensity = freqData[i] / 255;
            if (intensity > 0.7) {
                ctx.fillStyle = '#FF5722';
            } else if (intensity > 0.4) {
                ctx.fillStyle = '#FFC107';
            } else {
                ctx.fillStyle = '#4CAF50';
            }

            ctx.fillRect(x, y, barWidth, barHeight);
        }

        // Draw channel markers with bandwidth indicators
        const bandwidth = this.config.bandwidth;

        for (let i = 0; i < 5; i++) {
            if (this.channels[i].active && this.channels[i].frequency > 0) {
                const freq = this.channels[i].frequency;
                const color = this.channelColors[i];

                // Calculate positions
                const centerX = (freq / maxDisplayFreq) * width;
                const leftX = ((freq - bandwidth / 2) / maxDisplayFreq) * width;
                const rightX = ((freq + bandwidth / 2) / maxDisplayFreq) * width;

                // Draw bandwidth region (semi-transparent)
                ctx.fillStyle = color + '20'; // Add alpha for transparency
                ctx.fillRect(leftX, 0, rightX - leftX, height);

                // Draw bandwidth markers (dashed lines)
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);

                // Left bandwidth marker
                ctx.beginPath();
                ctx.moveTo(leftX, 0);
                ctx.lineTo(leftX, height);
                ctx.stroke();

                // Right bandwidth marker
                ctx.beginPath();
                ctx.moveTo(rightX, 0);
                ctx.lineTo(rightX, height);
                ctx.stroke();

                // Draw center frequency line (solid)
                ctx.setLineDash([]);
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(centerX, 0);
                ctx.lineTo(centerX, height);
                ctx.stroke();

                // Draw label
                ctx.fillStyle = color;
                ctx.font = 'bold 11px monospace';
                ctx.fillText(`Ch${i}`, centerX + 3, 14);
                ctx.font = '10px monospace';
                ctx.fillText(`${freq}Hz`, centerX + 3, 26);
            }
        }

        // Draw frequency scale at bottom
        ctx.fillStyle = '#000';
        ctx.font = '9px monospace';
        for (let freq = 0; freq <= maxDisplayFreq; freq += 500) {
            const x = (freq / maxDisplayFreq) * width;
            ctx.fillText(freq + 'Hz', x + 2, height - 5);
        }
    }

    onEnable() {
        console.log('Morse: Extension enabled');
        this.setupBinaryHandler();
    }

    onDisable() {
        console.log('Morse: Extension disabled');

        if (this.running) {
            this.stopDecoder();
        }

        this.restoreBinaryHandler();
    }

    onActivate() {
        console.log('Morse: Extension activated');
    }

    onDeactivate() {
        console.log('Morse: Extension deactivated');
        if (this.running) {
            this.stopDecoder();
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new MorseExtension());
    console.log('✅ Morse Extension registered');
} else {
    console.error('decoderManager not available for Morse extension');
}
