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
            center_frequency: 600,
            bandwidth: 100,
            min_wpm: 12,
            max_wpm: 45,
            threshold_snr: 10
        };

        // State
        this.running = false;
        this.autoScroll = true;
        this.showMorse = true;
        this.showTimestamp = true;
        
        // Channel state (5 channels)
        this.channels = [];
        for (let i = 0; i < 5; i++) {
            this.channels.push({
                id: i,
                active: false,
                frequency: 0,
                wpm: 0,
                textBuffer: '',
                morseBuffer: ''
            });
        }
        
        this.activeChannelCount = 0;

        // Binary message handler
        this.binaryMessageHandler = null;
        this.originalDXHandler = null;
    }

    onInitialize() {
        console.log('Morse: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('Morse: onInitialize complete');
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
            'morse-center-freq',
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

        const showTimestampCheckbox = document.getElementById('morse-show-timestamp');
        if (showTimestampCheckbox) {
            showTimestampCheckbox.addEventListener('change', (e) => {
                this.showTimestamp = e.target.checked;
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
            standard: { center_frequency: 600, bandwidth: 100, min_wpm: 12, max_wpm: 45, threshold_snr: 10 },
            fast: { center_frequency: 600, bandwidth: 100, min_wpm: 20, max_wpm: 60, threshold_snr: 10 },
            slow: { center_frequency: 600, bandwidth: 100, min_wpm: 5, max_wpm: 20, threshold_snr: 10 }
        };

        if (preset !== 'custom' && presets[preset]) {
            const config = presets[preset];
            document.getElementById('morse-center-freq').value = config.center_frequency;
            document.getElementById('morse-bandwidth').value = config.bandwidth;
            document.getElementById('morse-min-wpm').value = config.min_wpm;
            document.getElementById('morse-max-wpm').value = config.max_wpm;
            document.getElementById('morse-threshold-snr').value = config.threshold_snr;
            this.updateConfig();
        }
    }

    updateConfig() {
        this.config = {
            center_frequency: parseFloat(document.getElementById('morse-center-freq').value),
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

    startDecoder() {
        console.log('Morse: Starting decoder with config:', this.config);

        // Setup binary message handler
        this.setupBinaryHandler();

        // Attach audio extension
        this.attachAudioExtension();

        this.running = true;
        this.updateStatus('Running - Scanning for CW signals...');
        
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

        // Send attach message
        const attachMsg = {
            type: 'audio_extension_attach',
            extension_name: 'morse',
            params: {
                center_frequency: this.config.center_frequency,
                bandwidth: this.config.bandwidth,
                min_wpm: this.config.min_wpm,
                max_wpm: this.config.max_wpm,
                threshold_snr: this.config.threshold_snr
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
        const numActive = view.getUint8(1);
        let offset = 2;

        for (let i = 0; i < numActive; i++) {
            const id = view.getUint8(offset);
            const freq = view.getFloat64(offset + 1, false);
            const wpm = view.getFloat64(offset + 9, false);
            
            this.updateChannelStatus(id, freq, wpm);
            offset += 17;
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

    updateChannelStatus(id, frequency, wpm) {
        this.channels[id].frequency = frequency;
        this.channels[id].wpm = wpm;

        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (channelEl) {
            const freqEl = channelEl.querySelector('.morse-channel-freq');
            if (freqEl) freqEl.textContent = `${frequency.toFixed(0)} Hz`;
            
            const wpmEl = channelEl.querySelector('.morse-channel-wpm');
            if (wpmEl) wpmEl.textContent = `${wpm.toFixed(1)} WPM`;
        }
    }

    appendToChannel(id, morse, text, timestamp) {
        const channel = this.channels[id];
        const channelEl = document.getElementById(`morse-channel-${id}`);
        if (!channelEl) return;

        const textEl = channelEl.querySelector('.morse-channel-text');
        const morseEl = channelEl.querySelector('.morse-channel-morse');
        if (!textEl || !morseEl) return;

        // Add timestamp if enabled
        let timestampStr = '';
        if (this.showTimestamp) {
            const date = new Date(timestamp * 1000);
            timestampStr = `<span class="morse-timestamp">${date.toLocaleTimeString()}</span>`;
        }

        // Append text
        if (text) {
            textEl.innerHTML += timestampStr + text;
            channel.textBuffer += text;
        }

        // Append morse
        if (morse && this.showMorse) {
            morseEl.innerHTML += morse;
            channel.morseBuffer += morse;
        }

        // Auto-scroll
        if (this.autoScroll) {
            const contentEl = channelEl.querySelector('.morse-channel-content');
            if (contentEl) {
                contentEl.scrollTop = contentEl.scrollHeight;
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
            if (textEl) textEl.innerHTML = '';
            if (morseEl) morseEl.innerHTML = '';
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
