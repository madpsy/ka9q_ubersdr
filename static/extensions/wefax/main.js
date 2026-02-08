// WEFAX Extension for ka9q UberSDR
// Decodes Weather Fax (WEFAX) transmissions
// Version: 1.0.0

class WEFAXExtension extends DecoderExtension {
    constructor() {
        super('wefax', {
            displayName: 'WEFAX Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 3000
        });

        // Configuration
        this.config = {
            lpm: 120,
            carrier: 1900,
            deviation: 400,
            image_width: 1809,
            bandwidth: 1,
            use_phasing: true,
            auto_stop: false
        };

        // State
        this.running = false;
        this.canvas = null;
        this.ctx = null;
        this.imageData = null;
        this.currentLine = 0;
        this.imageWidth = 1809;
        this.imageHeight = 0;
        this.maxHeight = 4000;
        this.autoScroll = true;

        // Binary message handler
        this.binaryMessageHandler = null;
    }

    onInitialize() {
        console.log('WEFAX: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('WEFAX: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 10;

            const canvas = document.getElementById('wefax-canvas');
            const startBtn = document.getElementById('wefax-start-btn');

            if (canvas && startBtn) {
                this.setupCanvas();
                this.setupEventHandlers();
                console.log('WEFAX: Event handlers set up successfully');
            } else if (attempts < maxAttempts) {
                console.log(`WEFAX: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                requestAnimationFrame(() => trySetup(attempts + 1));
            } else {
                console.error('WEFAX: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.wefax_template;

        if (!template) {
            console.error('WEFAX extension template not loaded');
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
        this.canvas = document.getElementById('wefax-canvas');
        if (!this.canvas) {
            console.error('WEFAX: Canvas element not found');
            return;
        }

        this.ctx = this.canvas.getContext('2d');
        
        // Initialize canvas with default size
        this.imageWidth = parseInt(document.getElementById('wefax-image-width').value) || 1809;
        this.canvas.width = this.imageWidth;
        this.canvas.height = 100; // Initial height
        this.imageHeight = 0;
        this.currentLine = 0;

        // Create image data buffer
        this.imageData = this.ctx.createImageData(this.imageWidth, 1);

        // Fill with black
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        console.log('WEFAX: Canvas initialized:', this.imageWidth, 'x', this.canvas.height);
    }

    setupEventHandlers() {
        console.log('WEFAX: Setting up event handlers');

        const container = this.getContentElement();
        if (!container) {
            console.error('WEFAX: Container element not found');
            return;
        }

        // Start button
        const startBtn = document.getElementById('wefax-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.startDecoder());
        }

        // Stop button
        const stopBtn = document.getElementById('wefax-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopDecoder());
        }

        // Clear button
        const clearBtn = document.getElementById('wefax-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearImage());
        }

        // Save button
        const saveBtn = document.getElementById('wefax-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveImage());
        }

        // Auto-scroll checkbox
        const autoScrollCheckbox = document.getElementById('wefax-auto-scroll');
        if (autoScrollCheckbox) {
            autoScrollCheckbox.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
            });
        }

        // Station selector
        const stationSelect = document.getElementById('wefax-station-select');
        const tuneBtn = document.getElementById('wefax-tune-btn');
        
        if (stationSelect) {
            stationSelect.addEventListener('change', (e) => {
                if (tuneBtn) {
                    tuneBtn.disabled = !e.target.value;
                }
            });
        }

        if (tuneBtn) {
            tuneBtn.addEventListener('click', () => this.tuneToStation());
        }

        // Configuration change handlers (only apply when stopped)
        const configInputs = [
            'wefax-lpm',
            'wefax-carrier',
            'wefax-deviation',
            'wefax-image-width',
            'wefax-bandwidth',
            'wefax-use-phasing',
            'wefax-auto-stop'
        ];

        configInputs.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('change', () => {
                    if (!this.running) {
                        this.updateConfig();
                    }
                });
            }
        });
    }

    tuneToStation() {
        const stationSelect = document.getElementById('wefax-station-select');
        if (!stationSelect || !stationSelect.value) {
            return;
        }

        // Parse station value: "frequency,mode,lpm"
        const parts = stationSelect.value.split(',');
        if (parts.length !== 3) {
            console.error('WEFAX: Invalid station format');
            return;
        }

        const frequency = parseInt(parts[0]);
        const mode = parts[1];
        const lpm = parseInt(parts[2]);

        console.log('WEFAX: Tuning to station:', frequency, mode, lpm);

        // Set frequency and mode
        this.radio.setFrequency(frequency);
        this.radio.setMode(mode, false);

        // Update LPM setting
        const lpmSelect = document.getElementById('wefax-lpm');
        if (lpmSelect) {
            lpmSelect.value = lpm.toString();
        }

        // Log the action
        const stationText = stationSelect.options[stationSelect.selectedIndex].text;
        this.radio.log(`Tuned to WEFAX station: ${stationText}`);

        // Reset selector
        stationSelect.value = '';
        const tuneBtn = document.getElementById('wefax-tune-btn');
        if (tuneBtn) {
            tuneBtn.disabled = true;
        }
    }

    updateConfig() {
        this.config.lpm = parseInt(document.getElementById('wefax-lpm').value);
        this.config.carrier = parseFloat(document.getElementById('wefax-carrier').value);
        this.config.deviation = parseFloat(document.getElementById('wefax-deviation').value);
        this.config.image_width = parseInt(document.getElementById('wefax-image-width').value);
        this.config.bandwidth = parseInt(document.getElementById('wefax-bandwidth').value);
        this.config.use_phasing = document.getElementById('wefax-use-phasing').checked;
        this.config.auto_stop = document.getElementById('wefax-auto-stop').checked;

        console.log('WEFAX: Config updated:', this.config);
    }

    startDecoder() {
        if (this.running) {
            console.log('WEFAX: Already running');
            return;
        }

        console.log('WEFAX: Starting decoder');

        // Update configuration
        this.updateConfig();

        // Reset canvas if width changed
        const newWidth = this.config.image_width;
        if (newWidth !== this.imageWidth) {
            this.imageWidth = newWidth;
            this.setupCanvas();
        }

        // Attach to audio extension via DX WebSocket
        this.attachAudioExtension();

        // Update UI
        this.running = true;
        this.updateStatus('running', 'Running');
        document.getElementById('wefax-start-btn').disabled = true;
        document.getElementById('wefax-stop-btn').disabled = false;

        // Disable config controls while running
        this.setConfigControlsEnabled(false);
    }

    stopDecoder() {
        if (!this.running) {
            console.log('WEFAX: Not running');
            return;
        }

        console.log('WEFAX: Stopping decoder');

        // Detach from audio extension
        this.detachAudioExtension();

        // Update UI
        this.running = false;
        this.updateStatus('disconnected', 'Stopped');
        document.getElementById('wefax-start-btn').disabled = false;
        document.getElementById('wefax-stop-btn').disabled = true;

        // Enable config controls
        this.setConfigControlsEnabled(true);
    }

    setConfigControlsEnabled(enabled) {
        const configInputs = [
            'wefax-lpm',
            'wefax-carrier',
            'wefax-deviation',
            'wefax-image-width',
            'wefax-bandwidth',
            'wefax-use-phasing',
            'wefax-auto-stop'
        ];

        configInputs.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.disabled = !enabled;
            }
        });
    }

    attachAudioExtension() {
        if (!this.radio.dxWebSocket || this.radio.dxWebSocket.readyState !== WebSocket.OPEN) {
            console.error('WEFAX: DX WebSocket not connected');
            this.updateStatus('error', 'WebSocket Error');
            return;
        }

        // Setup binary message handler
        this.setupBinaryMessageHandler();

        // Send attach message
        const attachMsg = {
            type: 'audio_extension_attach',
            extension_name: 'wefax',
            params: {
                lpm: this.config.lpm,
                carrier: this.config.carrier,
                deviation: this.config.deviation,
                image_width: this.config.image_width,
                bandwidth: this.config.bandwidth,
                use_phasing: this.config.use_phasing,
                auto_stop: this.config.auto_stop
            }
        };

        console.log('WEFAX: Sending attach message:', attachMsg);
        this.radio.dxWebSocket.send(JSON.stringify(attachMsg));
    }

    detachAudioExtension() {
        if (!this.radio.dxWebSocket || this.radio.dxWebSocket.readyState !== WebSocket.OPEN) {
            console.error('WEFAX: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler
        this.removeBinaryMessageHandler();

        // Send detach message
        const detachMsg = {
            type: 'audio_extension_detach'
        };

        console.log('WEFAX: Sending detach message');
        this.radio.dxWebSocket.send(JSON.stringify(detachMsg));
    }

    setupBinaryMessageHandler() {
        // Store original onmessage handler if it exists
        const originalHandler = this.radio.dxWebSocket.onmessage;

        // Create new handler that processes both text and binary messages
        this.binaryMessageHandler = (event) => {
            if (typeof event.data === 'string') {
                // Text message - pass to original handler
                if (originalHandler) {
                    originalHandler.call(this.radio.dxWebSocket, event);
                }
            } else {
                // Binary message - process as WEFAX data
                this.handleBinaryMessage(event.data);
            }
        };

        this.radio.dxWebSocket.onmessage = this.binaryMessageHandler;
        console.log('WEFAX: Binary message handler installed');
    }

    removeBinaryMessageHandler() {
        if (this.binaryMessageHandler) {
            // Restore original handler (if we stored it)
            // For now, we'll just remove our handler
            // The DX cluster client will reinstall its handler
            this.binaryMessageHandler = null;
            console.log('WEFAX: Binary message handler removed');
        }
    }

    handleBinaryMessage(data) {
        // Binary protocol: [type:1][line_number:4][width:4][data:width]
        // type: 0x01 = image line
        const uint8Array = new Uint8Array(data);

        if (uint8Array.length < 9) {
            console.error('WEFAX: Invalid binary message length:', uint8Array.length);
            return;
        }

        const type = uint8Array[0];
        if (type !== 0x01) {
            console.error('WEFAX: Unknown binary message type:', type);
            return;
        }

        // Parse line number (big-endian uint32)
        const lineNumber = (uint8Array[1] << 24) | (uint8Array[2] << 16) | 
                          (uint8Array[3] << 8) | uint8Array[4];

        // Parse width (big-endian uint32)
        const width = (uint8Array[5] << 24) | (uint8Array[6] << 16) | 
                     (uint8Array[7] << 8) | uint8Array[8];

        // Extract pixel data
        const pixelData = uint8Array.slice(9);

        if (pixelData.length !== width) {
            console.error('WEFAX: Width mismatch:', pixelData.length, 'vs', width);
            return;
        }

        // Render the line
        this.renderImageLine(lineNumber, pixelData);
    }

    renderImageLine(lineNumber, pixelData) {
        if (!this.canvas || !this.ctx) {
            console.error('WEFAX: Canvas not initialized');
            return;
        }

        // Grow canvas if needed
        if (lineNumber >= this.canvas.height) {
            const newHeight = Math.min(lineNumber + 100, this.maxHeight);
            this.growCanvas(newHeight);
        }

        // Create image data for this line
        const imageData = this.ctx.createImageData(this.imageWidth, 1);
        
        // Fill with grayscale pixel data
        for (let i = 0; i < this.imageWidth && i < pixelData.length; i++) {
            const pixelValue = pixelData[i];
            const offset = i * 4;
            imageData.data[offset] = pixelValue;     // R
            imageData.data[offset + 1] = pixelValue; // G
            imageData.data[offset + 2] = pixelValue; // B
            imageData.data[offset + 3] = 255;        // A
        }

        // Draw the line
        this.ctx.putImageData(imageData, 0, lineNumber);

        // Update line count
        if (lineNumber > this.currentLine) {
            this.currentLine = lineNumber;
            this.updateLineCount(this.currentLine);
        }

        // Auto-scroll to bottom
        if (this.autoScroll) {
            const container = document.getElementById('wefax-canvas-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    growCanvas(newHeight) {
        if (newHeight <= this.canvas.height) {
            return;
        }

        console.log('WEFAX: Growing canvas from', this.canvas.height, 'to', newHeight);

        // Create temporary canvas with old content
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.canvas, 0, 0);

        // Resize main canvas
        this.canvas.height = newHeight;

        // Fill with black
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Copy old content back
        this.ctx.drawImage(tempCanvas, 0, 0);

        this.imageHeight = newHeight;
        this.updateImageSize(this.imageWidth, this.imageHeight);
    }

    clearImage() {
        if (!this.canvas || !this.ctx) {
            return;
        }

        console.log('WEFAX: Clearing image');

        // Reset canvas
        this.canvas.height = 100;
        this.imageHeight = 0;
        this.currentLine = 0;

        // Fill with black
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Update UI
        this.updateLineCount(0);
        this.updateImageSize(this.imageWidth, 0);
    }

    saveImage() {
        if (!this.canvas) {
            console.error('WEFAX: Canvas not initialized');
            return;
        }

        console.log('WEFAX: Saving image');

        // Create a cropped canvas with actual image content
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = this.imageWidth;
        croppedCanvas.height = Math.max(this.currentLine + 1, 1);
        const croppedCtx = croppedCanvas.getContext('2d');

        // Copy image content
        croppedCtx.drawImage(this.canvas, 0, 0, this.imageWidth, croppedCanvas.height, 
                            0, 0, this.imageWidth, croppedCanvas.height);

        // Convert to blob and download
        croppedCanvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Generate filename with timestamp
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            a.download = `wefax_${timestamp}.png`;
            
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('WEFAX: Image saved:', a.download);
            this.radio.log(`WEFAX image saved: ${a.download}`);
        }, 'image/png');
    }

    updateStatus(status, text) {
        const badge = document.getElementById('wefax-status-badge');
        if (badge) {
            badge.textContent = text;
            badge.className = `status-badge status-${status}`;
        }
    }

    updateLineCount(count) {
        const lineCountEl = document.getElementById('wefax-line-count');
        if (lineCountEl) {
            lineCountEl.textContent = `Lines: ${count}`;
        }
    }

    updateImageSize(width, height) {
        const imageSizeEl = document.getElementById('wefax-image-size');
        if (imageSizeEl) {
            imageSizeEl.textContent = `Size: ${width}x${height}`;
        }
    }

    onEnable() {
        console.log('WEFAX: Extension enabled');
        // Extension is enabled but not automatically started
        // User must click Start button
    }

    onDisable() {
        console.log('WEFAX: Extension disabled');
        
        // Stop decoder if running
        if (this.running) {
            this.stopDecoder();
        }
    }

    onProcessAudio(dataArray) {
        // WEFAX extension doesn't process audio directly
        // Audio is processed by the backend extension
    }
}

// Register the extension
let wefaxExtensionInstance = null;

if (window.decoderManager) {
    wefaxExtensionInstance = new WEFAXExtension();
    window.decoderManager.register(wefaxExtensionInstance);
    console.log('WEFAX extension registered:', wefaxExtensionInstance);
} else {
    console.error('decoderManager not available for WEFAX extension');
}

// Expose instance globally for debugging
window.wefaxExtensionInstance = wefaxExtensionInstance;
