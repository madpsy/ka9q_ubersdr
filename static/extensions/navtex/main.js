// NAVTEX Extension for ka9q UberSDR
// Decodes NAVTEX, DSC, and Selcall FSK transmissions
// Version: 1.0.0

class NAVTEXExtension extends DecoderExtension {
    constructor() {
        console.log('NAVTEX: Constructor called');
        super('navtex', {
            displayName: 'NAVTEX Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 500
        });
        console.log('NAVTEX: Super constructor completed');

        // Configuration
        this.config = {
            center_frequency: 500,
            shift: 170,
            baud_rate: 100,
            inverted: false,
            framing: '4/7',
            encoding: 'CCIR476'
        };

        // State
        this.running = false;
        this.textBuffer = '';
        this.charCount = 0;
        this.autoScroll = true;
        this.baudError = 0;
        this.needsTimestamp = true; // Track if we need to add timestamp at start of line

        // Binary message handler
        this.binaryMessageHandler = null;
    }

    onInitialize() {
        console.log('NAVTEX: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('NAVTEX: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 20;

            const consoleEl = document.getElementById('navtex-console');
            const startBtn = document.getElementById('navtex-start-btn');
            const stationSelect = document.getElementById('navtex-station-select');

            console.log(`NAVTEX: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                consoleEl: !!consoleEl,
                startBtn: !!startBtn,
                stationSelect: !!stationSelect
            });

            if (consoleEl && startBtn && stationSelect) {
                console.log('NAVTEX: All DOM elements found, setting up...');
                this.setupBaudCanvas();
                this.setupEventHandlers();
                console.log('NAVTEX: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`NAVTEX: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('NAVTEX: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.navtex_template;

        if (!template) {
            console.error('NAVTEX extension template not loaded');
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

    setupBaudCanvas() {
        this.baudCanvas = document.getElementById('navtex-baud-canvas');
        if (!this.baudCanvas) {
            console.error('NAVTEX: Baud canvas element not found');
            return;
        }

        this.baudCtx = this.baudCanvas.getContext('2d');
        this.drawBaudError(0);
    }

    setupEventHandlers() {
        console.log('NAVTEX: Setting up event handlers');

        const container = this.getContentElement();
        if (!container) {
            console.error('NAVTEX: Container element not found');
            return;
        }

        // Use event delegation on container for all clicks
        container.addEventListener('click', (e) => {
            console.log('NAVTEX: Container click detected, target:', e.target.id, e.target.tagName);
            
            if (e.target.id === 'navtex-start-btn') {
                console.log('NAVTEX: Start button clicked!');
                e.preventDefault();
                e.stopPropagation();
                this.startDecoder();
            } else if (e.target.id === 'navtex-stop-btn') {
                console.log('NAVTEX: Stop button clicked!');
                e.preventDefault();
                e.stopPropagation();
                this.stopDecoder();
            } else if (e.target.id === 'navtex-clear-btn') {
                console.log('NAVTEX: Clear button clicked!');
                e.preventDefault();
                e.stopPropagation();
                this.clearConsole();
            } else if (e.target.id === 'navtex-save-btn') {
                console.log('NAVTEX: Save button clicked!');
                e.preventDefault();
                e.stopPropagation();
                this.saveText();
            }
        });

        // Use event delegation for change events
        container.addEventListener('change', (e) => {
            console.log('NAVTEX: Container change detected, target:', e.target.id);
            
            if (e.target.id === 'navtex-station-select') {
                console.log('NAVTEX: Station selected:', e.target.value);
                if (e.target.value) {
                    this.tuneToStation();
                }
            } else if (e.target.id === 'navtex-auto-scroll') {
                this.autoScroll = e.target.checked;
                console.log('NAVTEX: Auto-scroll:', this.autoScroll);
            } else if (e.target.id.startsWith('navtex-')) {
                // Config change
                if (!this.running) {
                    this.updateConfig();
                }
            }
        });

        // Configuration change handlers (only apply when stopped)
        const configInputs = [
            'navtex-center-freq',
            'navtex-shift',
            'navtex-baud',
            'navtex-encoding',
            'navtex-inverted'
        ];

        configInputs.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('change', () => {
                    if (!this.running) {
                        this.updateConfig();
                    } else {
                        console.log('NAVTEX: Config change ignored - decoder is running');
                        this.radio.log('NAVTEX: Configuration changes require stopping and restarting the decoder');
                    }
                });
            }
        });
    }

    tuneToStation() {
        const stationSelect = document.getElementById('navtex-station-select');
        if (!stationSelect || !stationSelect.value) {
            return;
        }

        // Parse station value: "frequency,mode,baud,shift"
        const parts = stationSelect.value.split(',');
        if (parts.length !== 4) {
            console.error('NAVTEX: Invalid station format');
            return;
        }

        const frequency = parseInt(parts[0]);
        const mode = parts[1];
        const baud = parseInt(parts[2]);
        const shift = parseInt(parts[3]);

        console.log('NAVTEX: Tuning to station:', frequency, mode, baud, shift);

        // Get the center frequency from the input box
        const centerInput = document.getElementById('navtex-center-freq');
        const centerHz = centerInput ? parseFloat(centerInput.value) : 500;

        // For USB mode, tune down by the center frequency from the dial frequency
        const dialFrequency = mode.toLowerCase() === 'usb' ? frequency - centerHz : frequency;

        // Set frequency and mode
        this.radio.setFrequency(dialFrequency);
        this.radio.setMode(mode, false);

        // Update settings
        const baudInput = document.getElementById('navtex-baud');
        if (baudInput) {
            baudInput.value = baud.toString();
        }

        const shiftInput = document.getElementById('navtex-shift');
        if (shiftInput) {
            shiftInput.value = shift.toString();
        }

        // Log the action
        const stationText = stationSelect.options[stationSelect.selectedIndex].text;
        this.radio.log(`Tuned to: ${stationText}`);
    }

    updateConfig() {
        this.config.center_frequency = parseFloat(document.getElementById('navtex-center-freq').value);
        this.config.shift = parseFloat(document.getElementById('navtex-shift').value);
        this.config.baud_rate = parseFloat(document.getElementById('navtex-baud').value);
        this.config.inverted = document.getElementById('navtex-inverted').checked;
        this.config.encoding = document.getElementById('navtex-encoding').value;
        this.config.framing = '4/7'; // Fixed for NAVTEX

        console.log('NAVTEX: Config updated:', this.config);
    }

    startDecoder() {
        console.log('NAVTEX: startDecoder() called, running=', this.running);
        
        if (this.running) {
            console.log('NAVTEX: Already running, returning');
            return;
        }

        console.log('NAVTEX: Starting decoder...');

        // Update configuration
        this.updateConfig();
        console.log('NAVTEX: Config updated:', this.config);

        // Attach to audio extension via DX WebSocket
        console.log('NAVTEX: Calling attachAudioExtension()');
        this.attachAudioExtension();

        // Update UI
        this.running = true;
        this.updateStatus('running', 'Running');
        
        const startBtn = document.getElementById('navtex-start-btn');
        const stopBtn = document.getElementById('navtex-stop-btn');
        
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;

        // Disable config controls while running
        this.setConfigControlsEnabled(false);

        console.log('NAVTEX: Decoder started successfully');
    }

    stopDecoder() {
        if (!this.running) {
            console.log('NAVTEX: Not running');
            return;
        }

        console.log('NAVTEX: Stopping decoder');

        // Detach from audio extension
        this.detachAudioExtension();

        // Update UI
        this.running = false;
        this.updateStatus('disconnected', 'Stopped');
        document.getElementById('navtex-start-btn').disabled = false;
        document.getElementById('navtex-stop-btn').disabled = true;

        // Enable config controls
        this.setConfigControlsEnabled(true);
    }

    setConfigControlsEnabled(enabled) {
        const configInputs = [
            'navtex-center-freq',
            'navtex-shift',
            'navtex-baud',
            'navtex-encoding',
            'navtex-inverted'
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
            console.error('NAVTEX: DX WebSocket not connected');
            this.updateStatus('error', 'WebSocket Error');
            return;
        }

        // Setup binary message handler
        this.setupBinaryMessageHandler();

        // Send attach message
        const attachMsg = {
            type: 'audio_extension_attach',
            extension_name: 'navtex',
            params: {
                center_frequency: this.config.center_frequency,
                shift: this.config.shift,
                baud_rate: this.config.baud_rate,
                inverted: this.config.inverted,
                framing: this.config.framing,
                encoding: this.config.encoding
            }
        };

        console.log('NAVTEX: Sending attach message:', attachMsg);
        dxClient.ws.send(JSON.stringify(attachMsg));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('NAVTEX: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler
        this.removeBinaryMessageHandler();

        // Send detach message
        const detachMsg = {
            type: 'audio_extension_detach'
        };

        console.log('NAVTEX: Sending detach message');
        dxClient.ws.send(JSON.stringify(detachMsg));
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('NAVTEX: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('NAVTEX: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as NAVTEX data
                this.handleBinaryMessage(event.data);
                // DO NOT pass binary messages to original handler
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    this.handleBinaryMessage(arrayBuffer);
                }).catch(err => {
                    console.error('NAVTEX: Failed to convert Blob to ArrayBuffer:', err);
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
        console.log('NAVTEX: Binary message handler installed');
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
            console.log('NAVTEX: Original message handler restored');
        }
        
        this.binaryMessageHandler = null;
    }

    handleBinaryMessage(data) {
        // Binary protocol:
        // type: 0x01 = text message: [type:1][timestamp:8][text_length:4][text:length]
        // type: 0x02 = baud error: [type:1][error:8]
        const uint8Array = new Uint8Array(data);

        if (uint8Array.length < 1) {
            console.error('NAVTEX: Invalid binary message length:', uint8Array.length);
            return;
        }

        const type = uint8Array[0];

        if (type === 0x01) {
            // Text message
            if (uint8Array.length < 13) {
                console.error('NAVTEX: Invalid text message length:', uint8Array.length);
                return;
            }

            // Parse timestamp (big-endian uint64) - not currently used
            // const timestamp = ...

            // Parse text length (big-endian uint32)
            const textLength = (uint8Array[9] << 24) | (uint8Array[10] << 16) |
                              (uint8Array[11] << 8) | uint8Array[12];

            // Extract text data
            const textData = uint8Array.slice(13, 13 + textLength);
            const text = new TextDecoder('utf-8').decode(textData);

            // Display the text
            this.displayText(text);
        } else if (type === 0x02) {
            // Baud error
            if (uint8Array.length < 9) {
                console.error('NAVTEX: Invalid baud error message length:', uint8Array.length);
                return;
            }

            // Parse error value (float64, big-endian)
            const dataView = new DataView(data);
            const error = dataView.getFloat64(1, false); // false = big-endian

            // Update baud error display
            this.updateBaudError(error);
        } else {
            console.error('NAVTEX: Unknown binary message type:', type);
        }
    }

    displayText(text) {
        const consoleEl = document.getElementById('navtex-console');
        if (!consoleEl) return;

        // Process text character by character to add timestamps at line feeds
        let processedText = '';
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Add timestamp at the start of a new line
            if (this.needsTimestamp && char !== '\r') {
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
            
            // Skip carriage returns (they're often paired with \n)
            // but don't affect timestamp logic
        }

        // Append text to buffer and console
        this.textBuffer += processedText;
        consoleEl.textContent += processedText;
        this.charCount += text.length;

        // Update character count
        this.updateCharCount(this.charCount);

        // Auto-scroll to bottom
        if (this.autoScroll) {
            const container = document.getElementById('navtex-console-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    updateBaudError(error) {
        this.baudError = error;
        this.drawBaudError(error);

        // Update text value
        const baudValue = document.getElementById('navtex-baud-value');
        if (baudValue) {
            baudValue.textContent = error.toFixed(1);
        }
    }

    drawBaudError(error) {
        if (!this.baudCtx) return;

        const canvas = this.baudCanvas;
        const ctx = this.baudCtx;
        const width = canvas.width;
        const height = canvas.height;
        const centerY = height / 2;

        // Clear canvas
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);

        // Draw center line
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();

        // Draw error bar
        const maxError = 8;
        const clampedError = Math.max(-maxError, Math.min(maxError, error));
        const barHeight = (clampedError / maxError) * (height / 2);

        if (barHeight > 0) {
            ctx.fillStyle = '#28a745'; // Green for positive
            ctx.fillRect(0, centerY - barHeight, width, barHeight);
        } else if (barHeight < 0) {
            ctx.fillStyle = '#dc3545'; // Red for negative
            ctx.fillRect(0, centerY, width, -barHeight);
        }
    }

    clearConsole() {
        const consoleEl = document.getElementById('navtex-console');
        if (consoleEl) {
            consoleEl.textContent = '';
        }
        this.textBuffer = '';
        this.charCount = 0;
        this.needsTimestamp = true; // Reset timestamp flag when clearing
        this.updateCharCount(0);
        console.log('NAVTEX: Console cleared');
    }

    saveText() {
        if (!this.textBuffer) {
            console.log('NAVTEX: No text to save');
            return;
        }

        console.log('NAVTEX: Saving text');

        const blob = new Blob([this.textBuffer], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        a.download = `navtex_${timestamp}.txt`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('NAVTEX: Text saved:', a.download);
        this.radio.log(`NAVTEX text saved: ${a.download}`);
    }

    updateStatus(status, text) {
        this.updateElementById('navtex-status-badge', (el) => {
            el.textContent = text;
            el.className = `status-badge status-${status}`;
        });
    }

    updateCharCount(count) {
        this.updateElementById('navtex-char-count', (el) => {
            el.textContent = `Chars: ${count}`;
        });
    }

    onEnable() {
        console.log('NAVTEX: Extension enabled');
    }

    onDisable() {
        console.log('NAVTEX: Extension disabled');
        
        if (this.running) {
            this.stopDecoder();
        }
    }

    onProcessAudio(dataArray) {
        // NAVTEX extension doesn't process audio directly
        // Audio is processed by the backend extension
    }
}

// Register the extension
let navtexExtensionInstance = null;

if (window.decoderManager) {
    navtexExtensionInstance = new NAVTEXExtension();
    window.decoderManager.register(navtexExtensionInstance);
    console.log('NAVTEX extension registered:', navtexExtensionInstance);
} else {
    console.error('decoderManager not available for NAVTEX extension');
}

// Expose instance globally for debugging
window.navtexExtensionInstance = navtexExtensionInstance;
