// FSK/RTTY Extension for ka9q UberSDR
// Decodes FSK transmissions including RTTY, SITOR-B, and other modes
// Backend-based decoder using WebSocket communication
// Version: 2.0.0

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
            center_frequency: 500,  // Default to NAVTEX center frequency
            shift: 170,
            baud_rate: 100,         // Default to NAVTEX baud rate
            framing: '4/7',         // CCIR476 framing
            inverted: false,
            encoding: 'CCIR476'     // Note: Backend currently only supports CCIR476
        };

        // State
        this.running = false;
        this.textBuffer = '';
        this.charCount = 0;
        this.autoScroll = true;
        this.baudError = 0;
        this.decoderState = 0; // 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData
        this.maxBufferLines = 1000;
        this.consoleLines = 25; // Default number of visible lines
        this.needsTimestamp = true; // Track if we need to add timestamp at start of line

        // Binary message handler
        this.binaryMessageHandler = null;
        this.originalDXHandler = null;

        // Spectrum visualization
        this.spectrumCanvas = null;
        this.spectrumCtx = null;
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

            const consoleEl = document.getElementById('fsk-console');
            const startBtn = document.getElementById('fsk-start-btn');
            const copyBtn = document.getElementById('fsk-copy-btn');
            const saveBtn = document.getElementById('fsk-save-btn');
            const clearBtn = document.getElementById('fsk-clear-btn');

            console.log(`FSK: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                consoleEl: !!consoleEl,
                startBtn: !!startBtn,
                copyBtn: !!copyBtn,
                saveBtn: !!saveBtn,
                clearBtn: !!clearBtn
            });

            if (consoleEl && startBtn && copyBtn && saveBtn && clearBtn) {
                console.log('FSK: All DOM elements found, setting up...');
                this.setupCanvas();
                this.setupBaudBar();
                this.setupEventHandlers();
                this.updateConsoleHeight(); // Set initial console height
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

    setupCanvas() {
        this.spectrumCanvas = document.getElementById('fsk-spectrum-canvas');
        if (this.spectrumCanvas) {
            this.spectrumCtx = this.spectrumCanvas.getContext('2d');
            // Set canvas size to match display size
            const rect = this.spectrumCanvas.getBoundingClientRect();
            this.spectrumCanvas.width = rect.width;
            this.spectrumCanvas.height = rect.height;
            
            // Add click handler for tuning
            this.spectrumCanvas.addEventListener('click', (e) => {
                const rect = this.spectrumCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const width = rect.width;
                
                // Calculate frequency from click position (0-3000 Hz range)
                const maxDisplayFreq = 3000;
                const clickedFreq = (x / width) * maxDisplayFreq;
                
                // Update center frequency
                this.config.center_frequency = Math.round(clickedFreq);
                
                // Update UI
                const centerFreqInput = document.getElementById('fsk-center-freq');
                if (centerFreqInput) {
                    centerFreqInput.value = this.config.center_frequency;
                }
                
                // Restart decoding with new frequency
                if (this.isDecoding) {
                    this.stopDecoding();
                    setTimeout(() => this.startDecoding(), 100);
                }
                
                console.log(`FSK: Tuned to ${this.config.center_frequency} Hz`);
            });
            
            // Add visual feedback on hover
            this.spectrumCanvas.style.cursor = 'crosshair';
            
            console.log('FSK: Spectrum canvas initialized with click-to-tune');
        }
    }

    setupBaudBar() {
        this.baudBar = document.getElementById('fsk-baud-bar');
        this.baudValue = document.getElementById('fsk-baud-value');

        // Initialize to 0
        this.updateBaudBar(0);
    }

    updateBaudBar(error) {
        const bar = document.getElementById('fsk-baud-bar');
        const value = document.getElementById('fsk-baud-value');

        if (!bar) return;

        const maxError = 8;
        const clampedError = Math.max(-maxError, Math.min(maxError, error));
        const percentage = Math.abs(clampedError) / maxError * 50; // 0-50%

        if (clampedError > 0) {
            // Positive error - green bar extending upward from center
            bar.style.bottom = '50%';
            bar.style.height = percentage + '%';
            bar.style.background = '#28a745';
        } else if (clampedError < 0) {
            // Negative error - red bar extending downward from center
            bar.style.bottom = (50 - percentage) + '%';
            bar.style.height = percentage + '%';
            bar.style.background = '#dc3545';
        } else {
            // No error - hide bar
            bar.style.height = '0%';
        }

        // Update numeric value
        if (value) {
            value.textContent = error.toFixed(1);
        }
    }

    setupEventHandlers() {
        console.log('FSK: Setting up event handlers');

        // Start/Stop button
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.toggleDecoding());
        }

        // Copy button
        const copyBtn = document.getElementById('fsk-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyToClipboard());
        }

        // Save button
        const saveBtn = document.getElementById('fsk-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveText());
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
            });
        }

        const baudInput = document.getElementById('fsk-baud');
        if (baudInput) {
            baudInput.addEventListener('change', (e) => {
                this.config.baud_rate = parseFloat(e.target.value);
            });
        }

        const framingSelect = document.getElementById('fsk-framing');
        if (framingSelect) {
            framingSelect.addEventListener('change', (e) => {
                this.config.framing = e.target.value;
            });
        }

        const encodingSelect = document.getElementById('fsk-encoding');
        if (encodingSelect) {
            encodingSelect.addEventListener('change', (e) => {
                this.config.encoding = e.target.value;
            });
        }

        const invertedCheck = document.getElementById('fsk-inverted');
        if (invertedCheck) {
            invertedCheck.addEventListener('change', (e) => {
                this.config.inverted = e.target.checked;
            });
        }

        const centerFreqInput = document.getElementById('fsk-center-freq');
        if (centerFreqInput) {
            centerFreqInput.addEventListener('change', (e) => {
                this.config.center_frequency = parseFloat(e.target.value);
            });
        }

        // Console controls
        const autoScrollCheck = document.getElementById('fsk-auto-scroll');
        if (autoScrollCheck) {
            autoScrollCheck.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
                console.log('FSK: Auto-scroll:', this.autoScroll);
            });
        }

        const consoleLinesSelect = document.getElementById('fsk-console-lines');
        if (consoleLinesSelect) {
            consoleLinesSelect.addEventListener('change', (e) => {
                this.consoleLines = parseInt(e.target.value);
                this.updateConsoleHeight();
                console.log('FSK: Console lines:', this.consoleLines);
            });
        }

        console.log('FSK: Event handlers setup complete');

        // Apply default preset (NAVTEX) to initialize UI
        this.applyPreset('navtex');
    }

    applyPreset(preset) {
        console.log('FSK: Applying preset:', preset);
        
        switch(preset) {
            case 'navtex':
                // NAVTEX International (518 kHz) - CCIR476, 100 baud, 170 Hz shift, 500 Hz center
                this.config.center_frequency = 500;
                this.config.shift = 170;
                this.config.baud_rate = 100;
                this.config.framing = '4/7';
                this.config.inverted = false;
                this.config.encoding = 'CCIR476';
                break;
            case 'sitor-b':
                // SITOR-B (same as NAVTEX but different center freq)
                this.config.center_frequency = 1000;
                this.config.shift = 170;
                this.config.baud_rate = 100;
                this.config.framing = '4/7';
                this.config.inverted = false;
                this.config.encoding = 'CCIR476';
                break;
            case 'weather':
                // Weather RTTY - ITA2/Baudot, 50 baud, 450 Hz shift, 1000 Hz center, inverted
                this.config.center_frequency = 1000;
                this.config.shift = 450;
                this.config.baud_rate = 50;
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
    }

    updateUIFromConfig() {
        const centerFreqInput = document.getElementById('fsk-center-freq');
        if (centerFreqInput) centerFreqInput.value = this.config.center_frequency;

        const shiftInput = document.getElementById('fsk-shift');
        if (shiftInput) shiftInput.value = this.config.shift;

        const baudInput = document.getElementById('fsk-baud');
        if (baudInput) baudInput.value = this.config.baud_rate;

        const framingSelect = document.getElementById('fsk-framing');
        if (framingSelect) framingSelect.value = this.config.framing;

        const encodingSelect = document.getElementById('fsk-encoding');
        if (encodingSelect) encodingSelect.value = this.config.encoding;

        const invertedCheck = document.getElementById('fsk-inverted');
        if (invertedCheck) invertedCheck.checked = this.config.inverted;
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

        if (this.running) {
            console.log('FSK: Already running');
            return;
        }

        // Attach to audio extension via DX WebSocket
        this.attachAudioExtension();

        this.running = true;
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Stop';
            startBtn.classList.add('active');
        }

        this.appendOutput('=== FSK Decoder Started ===\n', 'info');
        this.appendOutput(`Mode: ${this.config.encoding}, Baud: ${this.config.baud_rate}, Shift: ${this.config.shift} Hz\n`, 'info');
    }

    stopDecoding() {
        console.log('FSK: Stopping decoding');

        if (!this.running) {
            return;
        }

        // Detach from audio extension
        this.detachAudioExtension();

        this.running = false;
        const startBtn = document.getElementById('fsk-start-btn');
        if (startBtn) {
            startBtn.textContent = 'Start';
            startBtn.classList.remove('active');
        }

        // Clear all status indicators when stopped (they come from backend)
        const signalIndicator = document.getElementById('fsk-signal-indicator');
        const syncIndicator = document.getElementById('fsk-sync-indicator');
        const decodeIndicator = document.getElementById('fsk-decode-indicator');
        
        if (signalIndicator) signalIndicator.classList.remove('active');
        if (syncIndicator) syncIndicator.classList.remove('active');
        if (decodeIndicator) decodeIndicator.classList.remove('active');

        this.appendOutput('=== FSK Decoder Stopped ===\n', 'info');
    }

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('FSK: DX WebSocket not connected');
            this.appendOutput('Error: WebSocket not connected\n', 'error');
            return;
        }

        // Setup binary message handler
        this.setupBinaryMessageHandler();

        // Send attach message
        const attachMsg = {
            type: 'audio_extension_attach',
            extension_name: 'fsk',
            params: {
                center_frequency: this.config.center_frequency,
                shift: this.config.shift,
                baud_rate: this.config.baud_rate,
                inverted: this.config.inverted,
                framing: this.config.framing,
                encoding: this.config.encoding
            }
        };

        console.log('FSK: Sending attach message:', attachMsg);
        dxClient.ws.send(JSON.stringify(attachMsg));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('FSK: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler
        this.removeBinaryMessageHandler();

        // Send detach message
        const detachMsg = {
            type: 'audio_extension_detach'
        };

        console.log('FSK: Sending detach message');
        dxClient.ws.send(JSON.stringify(detachMsg));
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('FSK: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('FSK: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as FSK data
                this.handleBinaryMessage(event.data);
                // DO NOT pass binary messages to original handler
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    this.handleBinaryMessage(arrayBuffer);
                }).catch(err => {
                    console.error('FSK: Failed to convert Blob to ArrayBuffer:', err);
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
        console.log('FSK: Binary message handler installed');
    }

    removeBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            return;
        }

        // Restore original handler
        if (this.originalDXHandler) {
            dxClient.ws.onmessage = this.originalDXHandler;
            this.originalDXHandler = null;
            console.log('FSK: Original message handler restored');
        }
        
        this.binaryMessageHandler = null;
    }

    handleBinaryMessage(data) {
        // Binary protocol:
        // type: 0x01 = text message: [type:1][timestamp:8][text_length:4][text:length]
        // type: 0x02 = baud error: [type:1][error:8]
        // type: 0x03 = state update: [type:1][state:1]
        const uint8Array = new Uint8Array(data);

        if (uint8Array.length < 1) {
            console.error('FSK: Invalid binary message length:', uint8Array.length);
            return;
        }

        const type = uint8Array[0];

        if (type === 0x01) {
            // Text message
            if (uint8Array.length < 13) {
                console.error('FSK: Invalid text message length:', uint8Array.length);
                return;
            }

            // Parse text length (big-endian uint32)
            const textLength = (uint8Array[9] << 24) | (uint8Array[10] << 16) |
                              (uint8Array[11] << 8) | uint8Array[12];

            // Extract text data
            const textData = uint8Array.slice(13, 13 + textLength);
            const text = new TextDecoder('utf-8').decode(textData);

            // Display the text
            this.appendOutput(text);
        } else if (type === 0x02) {
            // Baud error
            if (uint8Array.length < 9) {
                console.error('FSK: Invalid baud error message length:', uint8Array.length);
                return;
            }

            // Parse error value (float64, big-endian)
            const dataView = new DataView(data);
            const error = dataView.getFloat64(1, false); // false = big-endian

            // Update baud error display
            this.updateBaudError(error);
        } else if (type === 0x03) {
            // State update
            if (uint8Array.length < 2) {
                console.error('FSK: Invalid state message length:', uint8Array.length);
                return;
            }

            const state = uint8Array[1];
            this.updateDecoderState(state);
        } else {
            console.error('FSK: Unknown binary message type:', type);
        }
    }

    updateBaudError(error) {
        this.baudError = error;
        this.updateBaudBar(error);
    }

    updateDecoderState(state) {
        this.decoderState = state;
        
        // Update status indicators based on state
        const signalIndicator = document.getElementById('fsk-signal-indicator');
        const syncIndicator = document.getElementById('fsk-sync-indicator');
        const decodeIndicator = document.getElementById('fsk-decode-indicator');

        if (signalIndicator) {
            // Signal detected if not in NoSignal state
            if (state !== 0) {
                signalIndicator.classList.add('active');
            } else {
                signalIndicator.classList.remove('active');
            }
        }

        if (syncIndicator) {
            // Synced if in Sync2 or ReadData state
            if (state === 2 || state === 3) {
                syncIndicator.classList.add('active');
            } else {
                syncIndicator.classList.remove('active');
            }
        }

        if (decodeIndicator) {
            // Decoding if in ReadData state
            if (state === 3) {
                decodeIndicator.classList.add('active');
            } else {
                decodeIndicator.classList.remove('active');
            }
        }
    }

    appendOutput(text, className = '') {
        const consoleEl = document.getElementById('fsk-console');
        if (!consoleEl) return;

        // Check if timestamps are enabled
        const showTimestamp = document.getElementById('fsk-show-timestamp')?.checked ?? true;

        // Process text character by character to add timestamps at line feeds
        let processedText = '';

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Add timestamp at the start of a new line (if enabled)
            if (showTimestamp && this.needsTimestamp && char !== '\r') {
                const now = new Date();
                const timestamp = now.toISOString().substring(11, 19); // HH:MM:SS format
                processedText += `[${timestamp}] `;
                this.needsTimestamp = false;
            }

            // Add the character
            processedText += char;

            // Mark that we need a timestamp after a line feed
            if (char === '\n') {
                this.needsTimestamp = true;
            }
        }

        // Append text to buffer and console
        this.textBuffer += processedText;
        consoleEl.textContent += processedText;
        this.charCount += text.length;

        // Auto-scroll to bottom
        if (this.autoScroll) {
            const container = document.getElementById('fsk-console-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    clearOutput() {
        const consoleEl = document.getElementById('fsk-console');
        if (consoleEl) {
            consoleEl.textContent = '';
        }
        this.textBuffer = '';
        this.charCount = 0;
        this.needsTimestamp = true;
    }

    copyToClipboard() {
        // Use textBuffer and remove carriage returns to avoid extra blank lines
        const text = this.textBuffer.replace(/\r/g, '');
        if (!text) {
            console.log('FSK: No text to copy');
            return;
        }

        // Use the Clipboard API
        navigator.clipboard.writeText(text).then(() => {
            console.log('FSK: Text copied to clipboard');
            // Provide visual feedback
            const copyBtn = document.getElementById('fsk-copy-btn');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                copyBtn.style.background = '#4CAF50';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.background = '';
                }, 1500);
            }
        }).catch(err => {
            console.error('FSK: Failed to copy text:', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                console.log('FSK: Text copied to clipboard (fallback)');
            } catch (err) {
                console.error('FSK: Fallback copy failed:', err);
            }
            document.body.removeChild(textArea);
        });
    }

    saveText() {
        // Use textBuffer and remove carriage returns to avoid extra blank lines
        const text = this.textBuffer.replace(/\r/g, '');
        if (!text) {
            console.log('FSK: No text to save');
            return;
        }

        console.log('FSK: Saving text');

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        a.download = `fsk_${timestamp}.txt`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('FSK: Text saved:', a.download);
    }

    updateConsoleHeight() {
        const container = document.getElementById('fsk-console-container');
        if (!container) {
            console.warn('FSK: Console container not found');
            return;
        }

        // Calculate height based on line count
        // Approximate 20px per line plus some padding
        const lineHeight = 20;
        const padding = 10;
        const height = (this.consoleLines * lineHeight) + padding;

        // Override flex with specific height and disable flex-grow
        container.style.flex = 'none';
        container.style.height = `${height}px`;
        container.style.minHeight = `${height}px`;
        console.log(`FSK: Console height updated to ${height}px (${this.consoleLines} lines)`);
    }

    // This method is called automatically by the DecoderExtension framework with audio data
    // For backend-based decoder, we don't process audio here - it's handled by the backend
    // But we still show FFT and audio levels regardless of decoder state
    onProcessAudio(dataArray) {
        // Calculate and update audio level (always, even when stopped)
        this.updateAudioLevel(dataArray);

        // Draw spectrum visualization (always, even when stopped)
        this.drawSpectrum(dataArray);
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

        // Draw mark and space frequency markers
        const markFreq = this.config.center_frequency + (this.config.shift / 2);
        const spaceFreq = this.config.center_frequency - (this.config.shift / 2);

        // Draw mark frequency line (red)
        const markX = (markFreq / maxDisplayFreq) * width;
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(markX, 0);
        ctx.lineTo(markX, height);
        ctx.stroke();

        // Draw space frequency line (blue)
        const spaceX = (spaceFreq / maxDisplayFreq) * width;
        ctx.strokeStyle = '#0000ff';
        ctx.beginPath();
        ctx.moveTo(spaceX, 0);
        ctx.lineTo(spaceX, height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw labels
        ctx.fillStyle = '#ff0000';
        ctx.font = '10px monospace';
        ctx.fillText('Mark', markX + 5, 12);
        ctx.fillText(`${markFreq.toFixed(0)} Hz`, markX + 5, 24);

        ctx.fillStyle = '#0000ff';
        ctx.fillText('Space', spaceX + 5, 12);
        ctx.fillText(`${spaceFreq.toFixed(0)} Hz`, spaceX + 5, 24);

        // Draw frequency scale
        ctx.fillStyle = '#666';
        ctx.font = '9px monospace';
        for (let freq = 0; freq <= maxDisplayFreq; freq += 500) {
            const x = (freq / maxDisplayFreq) * width;
            ctx.fillText(freq + 'Hz', x + 2, height - 5);
        }
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
