// FSK/RTTY Extension for ka9q UberSDR
// Decodes FSK transmissions including RTTY, SITOR-B, and other modes
// Based on KiwiSDR FSK extension by John Seamons, ZL4VO/KF6VO
// Adapted for UberSDR by integrating with Web Audio API
// Version: 1.0.0

class FSKExtension extends DecoderExtension {
    constructor() {
        console.log('FSK: Constructor called');
        super('fsk', {
            displayName: 'FSK/RTTY Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 2400
        });
        console.log('FSK: Super constructor completed');

        // Configuration
        this.config = {
            shift: 170,
            baud: 45.45,
            framing: '5N1.5',
            inverted: false,
            encoding: 'ITA2',
            centerFreq: 1000
        };

        // State
        this.running = false;
        this.decoder = null;
        this.audioProcessor = null;
        this.processingInterval = null;
        this.textBuffer = [];
        this.maxBufferLines = 1000;
        
        // Audio processing
        this.scriptProcessor = null;
        this.analyserNode = null;
        
        // Status tracking
        this.lastCharTime = 0;
        this.charCount = 0;
        this.signalDetected = false;
        this.syncLocked = false;
    }

    onInitialize() {
        console.log('FSK: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('FSK: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 20;

            const outputDiv = document.getElementById('fsk-output');
            const startBtn = document.getElementById('fsk-start-btn');
            const clearBtn = document.getElementById('fsk-clear-btn');

            console.log(`FSK: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                outputDiv: !!outputDiv,
                startBtn: !!startBtn,
                clearBtn: !!clearBtn
            });

            if (outputDiv && startBtn && clearBtn) {
                console.log('FSK: All DOM elements found, setting up...');
                this.setupEventHandlers();
                console.log('FSK: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`FSK: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('FSK: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.fsk_template;

        if (!template) {
            console.error('FSK extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    getContentElement() {
        const container = document.querySelector('.extension-content[data-extension="fsk"]');
        if (!container) {
            console.error('FSK: Extension content container not found');
        }
        return container;
    }

    setupEventHandlers() {
        console.log('FSK: Setting up event handlers');

        // Start/Stop button
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.toggleDecoding());
        }

        // Clear button
        const clearBtn = document.getElementById('fsk-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearOutput());
        }

        // Preset selection
        const presetSelect = document.getElementById('fsk-preset-select');
        if (presetSelect) {
            presetSelect.addEventListener('change', (e) => this.applyPreset(e.target.value));
        }

        // Parameter controls
        const shiftInput = document.getElementById('fsk-shift');
        if (shiftInput) {
            shiftInput.addEventListener('change', (e) => {
                this.config.shift = parseFloat(e.target.value);
                this.updateDecoder();
            });
        }

        const baudInput = document.getElementById('fsk-baud');
        if (baudInput) {
            baudInput.addEventListener('change', (e) => {
                this.config.baud = parseFloat(e.target.value);
                this.updateDecoder();
            });
        }

        const framingSelect = document.getElementById('fsk-framing');
        if (framingSelect) {
            framingSelect.addEventListener('change', (e) => {
                this.config.framing = e.target.value;
                this.updateDecoder();
            });
        }

        const encodingSelect = document.getElementById('fsk-encoding');
        if (encodingSelect) {
            encodingSelect.addEventListener('change', (e) => {
                this.config.encoding = e.target.value;
                this.updateDecoder();
            });
        }

        const invertedCheck = document.getElementById('fsk-inverted');
        if (invertedCheck) {
            invertedCheck.addEventListener('change', (e) => {
                this.config.inverted = e.target.checked;
                this.updateDecoder();
            });
        }

        const centerFreqInput = document.getElementById('fsk-center-freq');
        if (centerFreqInput) {
            centerFreqInput.addEventListener('change', (e) => {
                this.config.centerFreq = parseFloat(e.target.value);
                this.updateDecoder();
            });
        }

        console.log('FSK: Event handlers setup complete');
    }

    applyPreset(preset) {
        console.log('FSK: Applying preset:', preset);
        
        switch(preset) {
            case 'ham':
                this.config.shift = 170;
                this.config.baud = 45.45;
                this.config.framing = '5N1.5';
                this.config.inverted = false;
                this.config.encoding = 'ITA2';
                break;
            case 'sitor-b':
                this.config.shift = 170;
                this.config.baud = 100;
                this.config.framing = '4/7';
                this.config.inverted = false;
                this.config.encoding = 'CCIR476';
                break;
            case 'wx':
                this.config.shift = 450;
                this.config.baud = 50;
                this.config.framing = '5N1.5';
                this.config.inverted = true;
                this.config.encoding = 'ITA2';
                break;
            case 'custom':
                // Keep current settings
                return;
        }

        // Update UI
        this.updateUIFromConfig();
        this.updateDecoder();
    }

    updateUIFromConfig() {
        const shiftInput = document.getElementById('fsk-shift');
        if (shiftInput) shiftInput.value = this.config.shift;

        const baudInput = document.getElementById('fsk-baud');
        if (baudInput) baudInput.value = this.config.baud;

        const framingSelect = document.getElementById('fsk-framing');
        if (framingSelect) framingSelect.value = this.config.framing;

        const encodingSelect = document.getElementById('fsk-encoding');
        if (encodingSelect) encodingSelect.value = this.config.encoding;

        const invertedCheck = document.getElementById('fsk-inverted');
        if (invertedCheck) invertedCheck.checked = this.config.inverted;

        const centerFreqInput = document.getElementById('fsk-center-freq');
        if (centerFreqInput) centerFreqInput.value = this.config.centerFreq;
    }

    toggleDecoding() {
        if (this.running) {
            this.stopDecoding();
        } else {
            this.startDecoding();
        }
    }

    startDecoding() {
        console.log('FSK: Starting decoding');

        if (!window.audioContext) {
            this.appendOutput('Error: Audio context not available. Please start audio first.\n', 'error');
            return;
        }

        // Create decoder
        this.initializeDecoder();

        this.running = true;
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Stop';
            startBtn.classList.add('active');
        }

        this.appendOutput('=== FSK Decoder Started ===\n', 'info');
        this.appendOutput(`Mode: ${this.config.encoding}, Baud: ${this.config.baud}, Shift: ${this.config.shift} Hz\n`, 'info');
    }

    stopDecoding() {
        console.log('FSK: Stopping decoding');

        this.running = false;
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Start';
            startBtn.classList.remove('active');
        }

        this.appendOutput('=== FSK Decoder Stopped ===\n', 'info');
    }

    initializeDecoder() {
        console.log('FSK: Initializing decoder');

        const sampleRate = window.audioContext.sampleRate;

        // Create JNX decoder instance
        this.decoder = new JNX();
        
        // Setup decoder with current configuration
        this.decoder.setup_values(
            sampleRate,
            this.config.centerFreq,
            this.config.shift,
            this.config.baud,
            this.config.framing,
            this.config.inverted,
            this.config.encoding,
            false, // show_raw
            false  // show_errs
        );

        // Set callbacks using the proper setter methods
        this.decoder.set_output_char_cb((char) => {
            this.handleDecodedChar(char);
        });

        this.decoder.set_baud_error_cb((error) => {
            // Optional: display baud error in status bar
            // console.log('Baud error:', error);
        });

        console.log('FSK: Decoder initialized');
    }

    updateDecoder() {
        if (this.running && this.decoder) {
            console.log('FSK: Updating decoder configuration');
            this.stopDecoding();
            setTimeout(() => this.startDecoding(), 100);
        }
    }

    // This method is called automatically by the DecoderExtension framework with audio data
    onProcessAudio(dataArray) {
        if (!this.running || !this.decoder) return;

        // Calculate audio level for indicator
        this.updateAudioLevel(dataArray);

        // Convert Float32Array to regular array and process
        const samples = Array.from(dataArray);
        this.decoder.process_data(samples, samples.length);

        // Update status indicators based on decoder state
        this.updateStatusIndicators();
    }

    updateStatusIndicators() {
        if (!this.decoder) return;

        // Signal indicator - based on audio level
        const signalIndicator = document.getElementById('fsk-signal-indicator');
        if (signalIndicator) {
            const hasSignal = this.decoder.audio_average > this.decoder.audio_minimum;
            if (hasSignal !== this.signalDetected) {
                this.signalDetected = hasSignal;
                if (hasSignal) {
                    signalIndicator.classList.add('active');
                } else {
                    signalIndicator.classList.remove('active');
                }
            }
        }

        // Sync indicator - based on decoder state
        const syncIndicator = document.getElementById('fsk-sync-indicator');
        if (syncIndicator) {
            const isSync = this.decoder.state === this.decoder.State_e.READ_DATA;
            if (isSync !== this.syncLocked) {
                this.syncLocked = isSync;
                if (isSync) {
                    syncIndicator.classList.add('active');
                } else {
                    syncIndicator.classList.remove('active');
                }
            }
        }

        // Decode indicator - based on recent character output
        const decodeIndicator = document.getElementById('fsk-decode-indicator');
        if (decodeIndicator) {
            const now = Date.now();
            const isDecoding = (now - this.lastCharTime) < 2000; // Active if char within last 2 seconds
            if (isDecoding) {
                decodeIndicator.classList.add('active');
            } else {
                decodeIndicator.classList.remove('active');
            }
        }
    }

    updateAudioLevel(samples) {
        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);
        
        // Convert to dB
        const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
        
        // Update UI (throttled to avoid excessive updates)
        if (!this.lastAudioUpdate || Date.now() - this.lastAudioUpdate > 100) {
            this.lastAudioUpdate = Date.now();
            
            const levelBar = document.getElementById('fsk-audio-level');
            const dbText = document.getElementById('fsk-audio-db');
            const statusText = document.getElementById('fsk-status-text');
            
            if (levelBar && dbText) {
                // Scale dB to percentage (assuming -60dB to 0dB range)
                const percentage = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
                levelBar.style.width = percentage + '%';
                
                if (isFinite(db)) {
                    dbText.textContent = db.toFixed(1) + ' dB';
                    if (statusText && db > -40) {
                        statusText.textContent = 'Receiving audio';
                        statusText.style.color = '#4CAF50';
                    } else if (statusText) {
                        statusText.textContent = 'Waiting for signal';
                        statusText.style.color = '#888';
                    }
                } else {
                    dbText.textContent = '-∞ dB';
                    if (statusText) {
                        statusText.textContent = 'No audio';
                        statusText.style.color = '#888';
                    }
                }
            }
        }
    }

    handleDecodedChar(char) {
        if (typeof char === 'string') {
            this.appendOutput(char);
            // Track character decoding for status indicator
            this.lastCharTime = Date.now();
            this.charCount++;
        }
    }

    appendOutput(text, className = '') {
        const outputDiv = document.getElementById('fsk-output');
        if (!outputDiv) return;

        const span = document.createElement('span');
        if (className) {
            span.className = className;
        }
        span.textContent = text;
        outputDiv.appendChild(span);

        // Auto-scroll to bottom
        outputDiv.scrollTop = outputDiv.scrollHeight;

        // Limit buffer size
        while (outputDiv.childNodes.length > this.maxBufferLines) {
            outputDiv.removeChild(outputDiv.firstChild);
        }
    }

    clearOutput() {
        const outputDiv = document.getElementById('fsk-output');
        if (outputDiv) {
            outputDiv.innerHTML = '';
        }
        this.textBuffer = [];
    }

    onEnable() {
        console.log('FSK: Extension enabled');
    }

    onDisable() {
        console.log('FSK: Extension disabled');
        if (this.running) {
            this.stopDecoding();
        }
    }

    onDestroy() {
        console.log('FSK: Extension destroyed');
        this.stopDecoding();
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new FSKExtension());
    console.log('✅ FSK Extension registered');
}
