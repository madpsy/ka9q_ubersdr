// WEFAX Extension for ka9q UberSDR
// Decodes Weather Fax (WEFAX) transmissions
// Version: 1.0.0

class WEFAXExtension extends DecoderExtension {
    constructor() {
        console.log('WEFAX: Constructor called');
        super('wefax', {
            displayName: 'WEFAX Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 3000
        });
        console.log('WEFAX: Super constructor completed');

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
            const maxAttempts = 20;

            const canvas = document.getElementById('wefax-canvas');
            const startBtn = document.getElementById('wefax-start-btn');
            const stationSelect = document.getElementById('wefax-station-select');

            console.log(`WEFAX: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                canvas: !!canvas,
                startBtn: !!startBtn,
                stationSelect: !!stationSelect
            });

            if (canvas && startBtn && stationSelect) {
                console.log('WEFAX: All DOM elements found, setting up...');
                this.setupCanvas();
                this.setupEventHandlers();
                console.log('WEFAX: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`WEFAX: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('WEFAX: Failed to find DOM elements after', maxAttempts, 'attempts');
                console.error('WEFAX: Missing elements:', {
                    canvas: !canvas,
                    startBtn: !startBtn,
                    stationSelect: !stationSelect
                });
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

        // Check if canvas is in DOM
        const inDOM = document.body.contains(this.canvas);
        console.log('WEFAX: Canvas found, in DOM:', inDOM);
        
        // If canvas is not in DOM, it means the template was rendered but not attached
        // This can happen if innerHTML was used. Let's ensure it's attached.
        if (!inDOM) {
            const container = document.getElementById('wefax-canvas-container');
            if (container) {
                console.log('WEFAX: Canvas not in DOM, re-attaching to container');
                // Clear container and create new canvas
                container.innerHTML = '';
                this.canvas = document.createElement('canvas');
                this.canvas.id = 'wefax-canvas';
                this.canvas.className = 'wefax-canvas';
                container.appendChild(this.canvas);
                console.log('WEFAX: Canvas re-created and attached, in DOM:', document.body.contains(this.canvas));
            } else {
                console.error('WEFAX: Container not found, cannot attach canvas');
                return;
            }
        }

        this.ctx = this.canvas.getContext('2d');
        
        // Initialize canvas with default size
        this.imageWidth = parseInt(document.getElementById('wefax-image-width').value) || 1809;
        this.canvas.width = this.imageWidth;
        this.canvas.height = 100; // Initial height
        this.imageHeight = 0;
        this.currentLine = 0;

        // Force canvas to be visible by setting style attributes
        this.canvas.style.display = 'block';
        this.canvas.style.width = this.imageWidth + 'px';
        this.canvas.style.height = '100px';

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

        // Use event delegation on container for all clicks
        container.addEventListener('click', (e) => {
            console.log('WEFAX: Container click detected, target:', e.target.id, e.target.tagName);
            
            if (e.target.id === 'wefax-start-btn') {
                console.log('WEFAX: Start button clicked via delegation!');
                e.preventDefault();
                e.stopPropagation();
                this.startDecoder();
            } else if (e.target.id === 'wefax-stop-btn') {
                console.log('WEFAX: Stop button clicked via delegation!');
                e.preventDefault();
                e.stopPropagation();
                this.stopDecoder();
            } else if (e.target.id === 'wefax-clear-btn') {
                console.log('WEFAX: Clear button clicked via delegation!');
                e.preventDefault();
                e.stopPropagation();
                this.clearImage();
            } else if (e.target.id === 'wefax-save-btn') {
                console.log('WEFAX: Save button clicked via delegation!');
                e.preventDefault();
                e.stopPropagation();
                this.saveImage();
            }
        });

        // Use event delegation for change events too
        container.addEventListener('change', (e) => {
            console.log('WEFAX: Container change detected, target:', e.target.id);
            
            if (e.target.id === 'wefax-station-select') {
                console.log('WEFAX: Station selected:', e.target.value);
                // Automatically tune when a station is selected
                if (e.target.value) {
                    this.tuneToStation();
                }
            } else if (e.target.id === 'wefax-auto-scroll') {
                this.autoScroll = e.target.checked;
                console.log('WEFAX: Auto-scroll:', this.autoScroll);
            } else if (e.target.id.startsWith('wefax-')) {
                // Config change
                if (!this.running) {
                    this.updateConfig();
                }
            }
        });

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

        // For USB mode, tune 1.9 kHz down from the dial frequency
        // This centers the 1900 Hz carrier in the passband
        const dialFrequency = mode.toLowerCase() === 'usb' ? frequency - 1900 : frequency;

        // Disable edge detection when tuning to station
        if (window.spectrumDisplay) {
            window.spectrumDisplay.skipEdgeDetection = true;
        }

        // Set frequency and mode
        this.radio.setFrequency(dialFrequency);
        this.radio.setMode(mode, false);

        // Re-enable edge detection after a delay
        setTimeout(() => {
            if (window.spectrumDisplay) {
                window.spectrumDisplay.skipEdgeDetection = false;
            }
        }, 500);

        // Update LPM setting
        const lpmSelect = document.getElementById('wefax-lpm');
        if (lpmSelect) {
            lpmSelect.value = lpm.toString();
        }

        // Log the action
        const stationText = stationSelect.options[stationSelect.selectedIndex].text;
        this.radio.log(`Tuned to WEFAX station: ${stationText}`);
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
        console.log('WEFAX: startDecoder() called, running=', this.running);
        
        if (this.running) {
            console.log('WEFAX: Already running, returning');
            return;
        }

        console.log('WEFAX: Starting decoder...');

        // Update configuration
        this.updateConfig();
        console.log('WEFAX: Config updated:', this.config);

        // Reset canvas if width changed OR if canvas is not in DOM
        const newWidth = this.config.image_width;
        const canvasInDOM = this.canvas && document.body.contains(this.canvas);
        
        if (newWidth !== this.imageWidth || !canvasInDOM) {
            if (!canvasInDOM) {
                console.log('WEFAX: Canvas not in DOM, reinitializing');
            } else {
                console.log('WEFAX: Image width changed, resetting canvas');
            }
            this.imageWidth = newWidth;
            this.setupCanvas();
        }

        // Attach to audio extension via DX WebSocket
        console.log('WEFAX: Calling attachAudioExtension()');
        this.attachAudioExtension();

        // Update UI
        this.running = true;
        this.updateStatus('running', 'Running');
        
        const startBtn = document.getElementById('wefax-start-btn');
        const stopBtn = document.getElementById('wefax-stop-btn');
        
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;

        // Disable config controls while running
        this.setConfigControlsEnabled(false);
        
        console.log('WEFAX: Decoder started successfully');
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
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
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
        dxClient.ws.send(JSON.stringify(attachMsg));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
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
        dxClient.ws.send(JSON.stringify(detachMsg));
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('WEFAX: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('WEFAX: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as WEFAX data
                this.handleBinaryMessage(event.data);
                // DO NOT pass binary messages to original handler (chat.js can't handle them)
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    this.handleBinaryMessage(arrayBuffer);
                }).catch(err => {
                    console.error('WEFAX: Failed to convert Blob to ArrayBuffer:', err);
                });
                // DO NOT pass binary messages to original handler (chat.js can't handle them)
            } else {
                // Text message - pass to original handler
                // IMPORTANT: Check that originalDXHandler exists and is not our own handler
                if (this.originalDXHandler && this.originalDXHandler !== this.binaryMessageHandler) {
                    this.originalDXHandler.call(dxClient.ws, event);
                }
            }
        };

        dxClient.ws.onmessage = this.binaryMessageHandler;
        console.log('WEFAX: Binary message handler installed');
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
            console.log('WEFAX: Original message handler restored');
        }
        
        this.binaryMessageHandler = null;
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

        // Draw the line to main canvas
        this.ctx.putImageData(imageData, 0, lineNumber);

        // Also draw to modal canvas if in modal mode
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalCanvas = modalBody.querySelector('#wefax-canvas');
                if (modalCanvas) {
                    const modalCtx = modalCanvas.getContext('2d');
                    
                    // Ensure modal canvas is same size
                    if (modalCanvas.width !== this.canvas.width || modalCanvas.height !== this.canvas.height) {
                        modalCanvas.width = this.canvas.width;
                        modalCanvas.height = this.canvas.height;
                        modalCanvas.style.display = 'block';
                        modalCanvas.style.width = this.canvas.width + 'px';
                        modalCanvas.style.height = this.canvas.height + 'px';
                    }
                    
                    // Draw the line to modal canvas
                    modalCtx.putImageData(imageData, 0, lineNumber);
                }
            }
        }

        // Update line count
        if (lineNumber > this.currentLine) {
            this.currentLine = lineNumber;
            this.updateLineCount(this.currentLine);
        }

        // Auto-scroll to bottom (both panel and modal)
        if (this.autoScroll) {
            const container = document.getElementById('wefax-canvas-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
            
            // Also scroll modal if active
            if (this.modalMode && this.modalBodyId) {
                const modalBody = document.getElementById(this.modalBodyId);
                if (modalBody) {
                    const modalContainer = modalBody.querySelector('#wefax-canvas-container');
                    if (modalContainer) {
                        modalContainer.scrollTop = modalContainer.scrollHeight;
                    }
                }
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
        
        // Update inline style height to match
        this.canvas.style.height = newHeight + 'px';

        // Fill with black
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Copy old content back
        this.ctx.drawImage(tempCanvas, 0, 0);

        // Also grow modal canvas if in modal mode
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalCanvas = modalBody.querySelector('#wefax-canvas');
                if (modalCanvas) {
                    // Create temp canvas with modal's old content
                    const modalTempCanvas = document.createElement('canvas');
                    modalTempCanvas.width = modalCanvas.width;
                    modalTempCanvas.height = modalCanvas.height;
                    const modalTempCtx = modalTempCanvas.getContext('2d');
                    modalTempCtx.drawImage(modalCanvas, 0, 0);

                    // Resize modal canvas
                    modalCanvas.height = newHeight;
                    modalCanvas.style.height = newHeight + 'px';

                    // Fill with black
                    const modalCtx = modalCanvas.getContext('2d');
                    modalCtx.fillStyle = '#000000';
                    modalCtx.fillRect(0, 0, modalCanvas.width, modalCanvas.height);

                    // Copy old content back
                    modalCtx.drawImage(modalTempCanvas, 0, 0);
                    
                    console.log('WEFAX: Also grew modal canvas to', newHeight);
                }
            }
        }

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
        // Use the base class helper to update both panel and modal
        this.updateElementById('wefax-status-badge', (el) => {
            el.textContent = text;
            el.className = `status-badge status-${status}`;
        });
    }

    updateLineCount(count) {
        // Use the base class helper to update both panel and modal
        this.updateElementById('wefax-line-count', (el) => {
            el.textContent = `Lines: ${count}`;
        });
    }

    updateImageSize(width, height) {
        // Use the base class helper to update both panel and modal
        this.updateElementById('wefax-image-size', (el) => {
            el.textContent = `Size: ${width}x${height}`;
        });
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

    // Called when extension enters modal mode
    onEnterModal(modalBodyId) {
        console.log('WEFAX: Entering modal mode, modalBodyId:', modalBodyId);
        this.modalMode = true;
        this.modalBodyId = modalBodyId;
        
        // Wait a bit for modal DOM to be ready, then sync canvas
        setTimeout(() => {
            this.syncModalCanvas();
        }, 100);
    }

    // Called when extension exits modal mode
    onExitModal() {
        console.log('WEFAX: Exiting modal mode');
        this.modalMode = false;
        this.modalBodyId = null;
    }

    syncModalCanvas() {
        // Copy the entire main canvas to the modal canvas
        if (!this.modalMode || !this.modalBodyId || !this.canvas) {
            return;
        }

        const modalBody = document.getElementById(this.modalBodyId);
        if (!modalBody) {
            console.log('WEFAX: Modal body not found');
            return;
        }

        const modalCanvas = modalBody.querySelector('#wefax-canvas');
        if (!modalCanvas) {
            console.log('WEFAX: Modal canvas not found');
            return;
        }

        // Set modal canvas to same size as main canvas
        modalCanvas.width = this.canvas.width;
        modalCanvas.height = this.canvas.height;
        modalCanvas.style.display = 'block';
        modalCanvas.style.width = this.canvas.width + 'px';
        modalCanvas.style.height = this.canvas.height + 'px';

        // Copy entire canvas content
        const modalCtx = modalCanvas.getContext('2d');
        modalCtx.drawImage(this.canvas, 0, 0);

        console.log('WEFAX: Synced modal canvas with main canvas, size:', this.canvas.width, 'x', this.canvas.height);
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
