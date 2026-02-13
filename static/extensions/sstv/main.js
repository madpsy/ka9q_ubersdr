// SSTV Extension for ka9q UberSDR
// Decodes Slow Scan Television (SSTV) transmissions
// Version: 1.0.0

class SSTVExtension extends DecoderExtension {
    constructor() {
        console.log('SSTV: Constructor called');
        super('sstv', {
            displayName: 'SSTV Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 3000
        });
        console.log('SSTV: Super constructor completed');

        // Configuration
        this.config = {
            auto_sync: true,
            decode_fsk_id: true,
            mmsstv_only: false,
            auto_save: false
        };

        // State
        this.running = false;
        this.canvas = null;
        this.ctx = null;
        this.currentLine = 0;
        this.imageWidth = 320;
        this.imageHeight = 256;
        this.detectedMode = null;
        this.fskCallsign = null;
        this.autoScroll = true;

        // Binary message types
        this.MSG_IMAGE_LINE = 0x01;
        this.MSG_MODE_DETECTED = 0x02;
        this.MSG_STATUS = 0x03;
        this.MSG_SYNC_DETECTED = 0x04;
        this.MSG_COMPLETE = 0x05;
        this.MSG_FSK_ID = 0x06;
        this.MSG_IMAGE_START = 0x07;
        this.MSG_REDRAW_START = 0x08;
        this.MSG_TONE_FREQ = 0x09;
        
        // Redraw state
        this.isRedrawing = false;
        
        // Tone frequency tracking with smoothing
        this.toneFreqHistory = [];
        this.toneFreqHistorySize = 5; // Average over 5 samples (1 second)
    }

    onInitialize() {
        console.log('SSTV: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('SSTV: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 20;

            const canvas = document.getElementById('sstv-canvas');
            const startBtn = document.getElementById('sstv-start-btn');

            console.log(`SSTV: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                canvas: !!canvas,
                startBtn: !!startBtn
            });

            if (canvas && startBtn) {
                console.log('SSTV: All DOM elements found, setting up...');
                this.setupCanvas();
                this.setupEventHandlers();
                console.log('SSTV: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`SSTV: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('SSTV: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.sstv_template;

        if (!template) {
            console.error('SSTV extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    setupCanvas() {
        this.canvas = document.getElementById('sstv-canvas');
        if (!this.canvas) {
            console.error('SSTV: Canvas element not found');
            return;
        }

        // Check if canvas is in DOM
        const inDOM = document.body.contains(this.canvas);
        console.log('SSTV: Canvas found, in DOM:', inDOM);
        
        // If canvas is not in DOM, it means the template was rendered but not attached
        if (!inDOM) {
            const container = document.getElementById('sstv-canvas-container');
            if (container) {
                console.log('SSTV: Canvas not in DOM, re-attaching to container');
                // Clear container and create new canvas
                container.innerHTML = '';
                this.canvas = document.createElement('canvas');
                this.canvas.id = 'sstv-canvas';
                this.canvas.className = 'sstv-canvas';
                container.appendChild(this.canvas);
                console.log('SSTV: Canvas re-created and attached, in DOM:', document.body.contains(this.canvas));
            } else {
                console.error('SSTV: Container not found, cannot attach canvas');
                return;
            }
        }

        this.ctx = this.canvas.getContext('2d');
        
        // Initialize with default size (will be updated when mode is detected)
        this.canvas.width = 320;
        this.canvas.height = 256;
        this.imageWidth = 320;
        this.imageHeight = 256;
        this.currentLine = 0;

        // Fill with black
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        console.log('SSTV: Canvas initialized:', this.imageWidth, 'x', this.imageHeight);
    }

    setupEventHandlers() {
        console.log('SSTV: Setting up event handlers');

        const container = this.getContentElement();
        if (!container) {
            console.error('SSTV: Container element not found');
            return;
        }

        // Use event delegation for clicks
        container.addEventListener('click', (e) => {
            if (e.target.id === 'sstv-start-btn') {
                e.preventDefault();
                e.stopPropagation();
                this.startDecoder();
            } else if (e.target.id === 'sstv-stop-btn') {
                e.preventDefault();
                e.stopPropagation();
                this.stopDecoder();
            } else if (e.target.id === 'sstv-clear-btn') {
                e.preventDefault();
                e.stopPropagation();
                this.clearImage();
            } else if (e.target.id === 'sstv-save-btn') {
                e.preventDefault();
                e.stopPropagation();
                this.saveImage();
            }
        });

        // Configuration changes
        container.addEventListener('change', (e) => {
            if (e.target.id === 'sstv-frequency-select') {
                console.log('SSTV: Frequency selected:', e.target.value);
                if (e.target.value) {
                    this.tuneToFrequency();
                }
            } else if (e.target.id === 'sstv-auto-scroll') {
                this.autoScroll = e.target.checked;
            } else if (e.target.id.startsWith('sstv-')) {
                if (!this.running) {
                    this.updateConfig();
                }
            }
        });
    }

    tuneToFrequency() {
        const freqSelect = document.getElementById('sstv-frequency-select');
        if (!freqSelect || !freqSelect.value) {
            return;
        }

        // Parse frequency value: "frequency,mode"
        const parts = freqSelect.value.split(',');
        if (parts.length !== 2) {
            console.error('SSTV: Invalid frequency format');
            return;
        }

        const frequency = parseInt(parts[0]);
        const mode = parts[1];

        console.log('SSTV: Tuning to:', frequency, mode);

        // Disable edge detection when tuning
        if (window.spectrumDisplay) {
            window.spectrumDisplay.skipEdgeDetection = true;
        }

        // Set frequency and mode
        this.radio.setFrequency(frequency);
        this.radio.setMode(mode, false);

        // Re-enable edge detection after a delay
        setTimeout(() => {
            if (window.spectrumDisplay) {
                window.spectrumDisplay.skipEdgeDetection = false;
            }
        }, 500);

        // Log the action
        const freqText = freqSelect.options[freqSelect.selectedIndex].text;
        this.radio.log(`SSTV: Tuned to ${freqText}`);
    }

    updateConfig() {
        const autoSyncEl = document.getElementById('sstv-auto-sync');
        const decodeFSKEl = document.getElementById('sstv-decode-fsk');
        const mmsstvOnlyEl = document.getElementById('sstv-mmsstv-only');
        const autoSaveEl = document.getElementById('sstv-auto-save');

        if (autoSyncEl) this.config.auto_sync = autoSyncEl.checked;
        if (decodeFSKEl) this.config.decode_fsk_id = decodeFSKEl.checked;
        if (mmsstvOnlyEl) this.config.mmsstv_only = mmsstvOnlyEl.checked;
        if (autoSaveEl) this.config.auto_save = autoSaveEl.checked;

        console.log('SSTV: Config updated:', this.config);
    }

    startDecoder() {
        if (this.running) {
            console.log('SSTV: Already running');
            return;
        }

        console.log('SSTV: Starting decoder');
        this.updateConfig();

        // Clear previous image
        this.clearImage();

        // Attach to audio extension via DX WebSocket
        this.attachAudioExtension();

        // Update UI
        this.running = true;
        this.updateButtonStates();
        this.radio.log('SSTV decoder started - waiting for signal...');
    }

    stopDecoder() {
        if (!this.running) {
            console.log('SSTV: Not running');
            return;
        }

        console.log('SSTV: Stopping decoder');

        // Detach from audio extension
        this.detachAudioExtension();

        // Update UI
        this.running = false;
        this.updateButtonStates();
        this.radio.log('SSTV decoder stopped');
    }

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('SSTV: DX WebSocket not connected');
            this.radio.log('SSTV: WebSocket not connected');
            return;
        }

        // Setup binary message handler before attaching
        this.setupBinaryMessageHandler();

        const message = {
            type: 'audio_extension_attach',
            extension_name: 'sstv',
            params: this.config
        };

        console.log('SSTV: Sending attach command:', message);
        dxClient.ws.send(JSON.stringify(message));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('SSTV: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler before detaching
        this.removeBinaryMessageHandler();

        const message = {
            type: 'audio_extension_detach'
        };

        console.log('SSTV: Sending detach command');
        dxClient.ws.send(JSON.stringify(message));
    }

    updateButtonStates() {
        const startBtn = document.getElementById('sstv-start-btn');
        const stopBtn = document.getElementById('sstv-stop-btn');

        if (startBtn) startBtn.disabled = this.running;
        if (stopBtn) stopBtn.disabled = !this.running;
    }

    clearImage() {
        console.log('SSTV: Clearing image');
        
        if (this.ctx) {
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        this.currentLine = 0;
        this.detectedMode = null;
        this.fskCallsign = null;

        // Clear mode and callsign displays
        const modeEl = document.getElementById('sstv-mode-display');
        const callsignEl = document.getElementById('sstv-callsign-display');
        const statusEl = document.getElementById('sstv-status');

        if (modeEl) modeEl.textContent = 'Waiting for signal...';
        if (callsignEl) callsignEl.textContent = '';
        if (statusEl) statusEl.textContent = 'Ready';
    }

    saveImage() {
        if (!this.canvas) {
            console.error('SSTV: No canvas to save');
            return;
        }

        // Generate filename with timestamp and mode
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const modeName = this.detectedMode || 'unknown';
        const callsign = this.fskCallsign ? `_${this.fskCallsign}` : '';
        const filename = `sstv_${modeName}${callsign}_${timestamp}.png`;

        // Convert canvas to blob and download
        this.canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('SSTV: Image saved as', filename);
            this.radio.log(`SSTV: Image saved as ${filename}`);
        });
    }

    // Handle binary messages from backend
    handleBinaryMessage(data) {
        const view = new DataView(data);
        const type = view.getUint8(0);

        switch (type) {
            case this.MSG_IMAGE_START:
                this.handleImageStart(view);
                break;

            case this.MSG_MODE_DETECTED:
                this.handleModeDetected(view, data);
                break;

            case this.MSG_IMAGE_LINE:
                this.handleImageLine(view, data);
                break;

            case this.MSG_STATUS:
                this.handleStatus(view, data);
                break;

            case this.MSG_SYNC_DETECTED:
                this.handleSyncDetected(view);
                break;

            case this.MSG_COMPLETE:
                this.handleComplete(view);
                break;

            case this.MSG_FSK_ID:
                this.handleFSKID(view, data);
                break;

            case this.MSG_REDRAW_START:
                this.handleRedrawStart();
                break;

            case this.MSG_TONE_FREQ:
                this.handleToneFreq(view);
                break;

            default:
                console.warn('SSTV: Unknown message type:', type);
        }
    }

    handleRedrawStart() {
        console.log('SSTV: Redraw start - corrected image incoming');
        this.isRedrawing = true;
        this.currentLine = 0;
        
        const statusEl = document.getElementById('sstv-status');
        if (statusEl) {
            statusEl.textContent = 'Redrawing with slant correction...';
        }
    }

    handleImageStart(view) {
        // [type:1][width:4][height:4]
        const width = view.getUint32(1);
        const height = view.getUint32(5);

        console.log('SSTV: Image start:', width, 'x', height);

        // Resize canvas
        this.imageWidth = width;
        this.imageHeight = height;
        this.canvas.width = width;
        this.canvas.height = height;
        this.currentLine = 0;

        // Clear canvas
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, width, height);

        this.radio.log(`SSTV: New image ${width}x${height}`);
    }

    handleModeDetected(view, data) {
        // [type:1][mode_idx:1][extended:1][name_len:1][name:len]
        const modeIdx = view.getUint8(1);
        const isExtended = view.getUint8(2) === 1;
        const nameLen = view.getUint8(3);
        const nameBytes = new Uint8Array(data, 4, nameLen);
        const modeName = new TextDecoder().decode(nameBytes);

        console.log('SSTV: Mode detected:', modeName, isExtended ? '(extended VIS)' : '');

        this.detectedMode = modeName;

        // Update mode display
        const modeEl = document.getElementById('sstv-mode-display');
        if (modeEl) {
            modeEl.textContent = modeName;
        }

        this.radio.log(`SSTV: Mode detected - ${modeName}`);
    }

    handleImageLine(view, data) {
        // [type:1][line:4][width:4][rgb_data:width*3]
        const line = view.getUint32(1);
        const width = view.getUint32(5);
        const rgbData = new Uint8Array(data, 9);

        if (line >= this.imageHeight) {
            console.warn('SSTV: Line number exceeds image height:', line, '>=', this.imageHeight);
            return;
        }

        // Create image data for this line
        const imageData = this.ctx.createImageData(width, 1);

        // Convert RGB data to RGBA
        for (let x = 0; x < width; x++) {
            const srcIdx = x * 3;
            const dstIdx = x * 4;

            imageData.data[dstIdx + 0] = rgbData[srcIdx + 0]; // R
            imageData.data[dstIdx + 1] = rgbData[srcIdx + 1]; // G
            imageData.data[dstIdx + 2] = rgbData[srcIdx + 2]; // B
            imageData.data[dstIdx + 3] = 255;                  // A
        }

        // Draw line to canvas
        this.ctx.putImageData(imageData, 0, line);

        this.currentLine = line + 1;

        // Auto-scroll if enabled
        if (this.autoScroll) {
            const container = document.getElementById('sstv-canvas-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }

        // Update progress
        const progress = Math.round((line / this.imageHeight) * 100);
        const statusEl = document.getElementById('sstv-status');
        if (statusEl) {
            statusEl.textContent = `Decoding: ${progress}% (line ${line}/${this.imageHeight})`;
        }
    }

    handleStatus(view, data) {
        // [type:1][code:1][msg_len:2][message:len]
        const statusCode = view.getUint8(1);
        const msgLen = view.getUint16(2);
        const msgBytes = new Uint8Array(data, 4, msgLen);
        const message = new TextDecoder().decode(msgBytes);

        console.log('SSTV: Status:', message);

        const statusEl = document.getElementById('sstv-status');
        if (statusEl) {
            statusEl.textContent = message;
        }

        this.radio.log(`SSTV: ${message}`);
    }

    handleSyncDetected(view) {
        // [type:1][quality:1]
        const quality = view.getUint8(1);

        console.log('SSTV: Sync detected, quality:', quality);
        this.radio.log('SSTV: Sync pulse detected');
    }

    handleComplete(view) {
        // [type:1][total_lines:4]
        const totalLines = view.getUint32(1);

        console.log('SSTV: Image complete, total lines:', totalLines);

        const statusEl = document.getElementById('sstv-status');
        if (statusEl) {
            statusEl.textContent = `Complete: ${totalLines} lines decoded`;
        }

        this.radio.log(`SSTV: Image complete (${totalLines} lines)`);

        // Auto-save if enabled
        if (this.config.auto_save) {
            this.saveImage();
        }
    }

    handleFSKID(view, data) {
        // [type:1][len:1][callsign:len]
        const len = view.getUint8(1);
        const callsignBytes = new Uint8Array(data, 2, len);
        const callsign = new TextDecoder().decode(callsignBytes);

        console.log('SSTV: FSK callsign:', callsign);

        this.fskCallsign = callsign;

        // Update callsign display
        const callsignEl = document.getElementById('sstv-callsign-display');
        if (callsignEl) {
            callsignEl.textContent = callsign;
        }

        this.radio.log(`SSTV: Callsign decoded - ${callsign}`);
    }

    handleToneFreq(view) {
        // [type:1][freq:4] - frequency in Hz * 10 for 0.1 Hz precision
        const freqTimes10 = view.getUint32(1);
        const freq = freqTimes10 / 10.0;

        // Add to history for smoothing
        this.toneFreqHistory.push(freq);
        if (this.toneFreqHistory.length > this.toneFreqHistorySize) {
            this.toneFreqHistory.shift();
        }

        // Calculate smoothed average
        const avgFreq = this.toneFreqHistory.reduce((a, b) => a + b, 0) / this.toneFreqHistory.length;

        // Update frequency display
        const freqDisplay = document.getElementById('sstv-tone-freq');
        if (freqDisplay) {
            if (avgFreq > 0) {
                freqDisplay.textContent = `${Math.round(avgFreq)} Hz`;
                // Color code based on proximity to 1900 Hz
                const diff = Math.abs(avgFreq - 1900);
                if (diff < 50) {
                    freqDisplay.style.color = '#4aff4a'; // Green - close to VIS leader
                } else if (diff < 200) {
                    freqDisplay.style.color = '#ffaa4a'; // Orange - nearby
                } else {
                    freqDisplay.style.color = '#4a9eff'; // Blue - far
                }
            } else {
                freqDisplay.textContent = '--- Hz';
                freqDisplay.style.color = '#666';
            }
        }
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('SSTV: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('SSTV: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as SSTV data
                if (this.running) {
                    this.handleBinaryMessage(event.data);
                }
                // DO NOT pass binary messages to original handler
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    if (this.running) {
                        this.handleBinaryMessage(arrayBuffer);
                    }
                }).catch(err => {
                    console.error('SSTV: Failed to convert Blob to ArrayBuffer:', err);
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
        console.log('SSTV: Binary message handler installed');
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
            console.log('SSTV: Original message handler restored');
        }
        
        this.binaryMessageHandler = null;
    }

    onProcessAudio(dataArray) {
        // SSTV processes audio on the backend (Go side) via the audio extension framework
        // This method is required by DecoderExtension but does nothing for SSTV
        // Audio is sent to the backend when the decoder is attached via WebSocket
    }

    onEnable() {
        console.log('SSTV: Extension enabled');
        this.setupBinaryMessageHandler();
    }

    onDisable() {
        console.log('SSTV: Extension disabled');
        
        if (this.running) {
            this.stopDecoder();
        }
        
        this.removeBinaryMessageHandler();
    }
}

// Register the extension
let sstvExtensionInstance = null;

if (window.decoderManager) {
    sstvExtensionInstance = new SSTVExtension();
    window.decoderManager.register(sstvExtensionInstance);
    console.log('SSTV extension registered:', sstvExtensionInstance);
} else {
    console.error('decoderManager not available for SSTV extension');
}

// Expose instance globally for debugging
window.sstvExtensionInstance = sstvExtensionInstance;
