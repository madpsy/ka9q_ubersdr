// Whisper Extension for ka9q UberSDR
// Real-time speech-to-text transcription using OpenAI Whisper

class WhisperExtension extends DecoderExtension {
    constructor() {
        console.log('Whisper: Constructor called');
        super('whisper', {
            displayName: 'Whisper Speech-to-Text',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 2700
        });
        console.log('Whisper: Super constructor completed');

        // Configuration
        this.config = {
            model: 'base',
            language: 'auto',
            auto_scroll: true,
            show_timestamps: true
        };

        // Transcription state
        this.transcriptionLines = [];
        this.isRunning = false;
        this.autoScroll = true;
        this.showTimestamps = true;

        console.log('Whisper: Extension initialized');
    }

    onInitialize() {
        console.log('Whisper: onInitialize called');
        this.waitForDOMAndSetupHandlers();
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 50;
            const contentElement = this.getContentElement();
            
            console.log(`Whisper: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                hasContent: !!contentElement,
                hasStartButton: !!document.getElementById('whisper-start-button')
            });

            if (contentElement && document.getElementById('whisper-start-button')) {
                console.log('Whisper: DOM ready, setting up handlers');
                this.setupEventHandlers();
            } else if (attempts < maxAttempts) {
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('Whisper: Failed to find DOM elements after maximum attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        console.log('Whisper: renderTemplate called');
        return super.renderTemplate();
    }

    getContentElement() {
        return document.querySelector('.whisper-container');
    }

    setupEventHandlers() {
        console.log('Whisper: Setting up event handlers');

        // Control buttons
        const startButton = document.getElementById('whisper-start-button');
        const stopButton = document.getElementById('whisper-stop-button');
        const clearButton = document.getElementById('whisper-clear-button');
        const copyButton = document.getElementById('whisper-copy-button');
        const saveButton = document.getElementById('whisper-save-button');

        if (startButton) {
            startButton.addEventListener('click', () => this.startDecoder());
        }
        if (stopButton) {
            stopButton.addEventListener('click', () => this.stopDecoder());
        }
        if (clearButton) {
            clearButton.addEventListener('click', () => this.clearTranscription());
        }
        if (copyButton) {
            copyButton.addEventListener('click', () => this.copyToClipboard());
        }
        if (saveButton) {
            saveButton.addEventListener('click', () => this.saveTranscription());
        }

        // Settings checkboxes
        const autoScrollCheckbox = document.getElementById('whisper-auto-scroll');
        const timestampsCheckbox = document.getElementById('whisper-show-timestamps');

        if (autoScrollCheckbox) {
            autoScrollCheckbox.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
            });
        }
        if (timestampsCheckbox) {
            timestampsCheckbox.addEventListener('change', (e) => {
                this.showTimestamps = e.target.checked;
                this.renderTranscription();
            });
        }

        // Update display with current settings
        this.updateSettingsDisplay();

        console.log('Whisper: Event handlers setup complete');
    }

    updateSettingsDisplay() {
        const modelDisplay = document.getElementById('whisper-model-display');
        const languageDisplay = document.getElementById('whisper-language-display');

        if (modelDisplay) {
            modelDisplay.textContent = this.config.model || 'base';
        }
        if (languageDisplay) {
            languageDisplay.textContent = this.config.language || 'auto';
        }
    }

    startDecoder() {
        console.log('Whisper: Starting decoder');
        
        this.isRunning = true;
        this.updateButtonStates();
        this.updateStatus('Starting...', 'whisper-status-starting');

        // Attach to audio extension
        this.attachAudioExtension();
    }

    stopDecoder() {
        console.log('Whisper: Stopping decoder');
        
        this.isRunning = false;
        this.updateButtonStates();
        this.updateStatus('Stopped', 'whisper-status-stopped');

        // Detach from audio extension
        this.detachAudioExtension();
    }

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('Whisper: DX WebSocket not connected');
            this.updateStatus('Error: No connection', 'whisper-status-error');
            this.updateServerStatus('Not connected', 'whisper-status-error');
            return;
        }

        // Setup binary message handler before attaching
        this.setupBinaryMessageHandler();

        const message = {
            type: 'audio_extension_attach',
            extension_name: 'whisper',
            params: this.config
        };

        console.log('Whisper: Sending attach message:', message);
        dxClient.ws.send(JSON.stringify(message));

        this.updateStatus('Running', 'whisper-status-running');
        this.updateServerStatus('Connected', 'whisper-status-running');
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('Whisper: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler before detaching
        this.removeBinaryMessageHandler();

        const message = {
            type: 'audio_extension_detach'
        };

        console.log('Whisper: Sending detach message');
        dxClient.ws.send(JSON.stringify(message));

        this.updateServerStatus('Disconnected', 'whisper-status-stopped');
    }

    updateButtonStates() {
        const startButton = document.getElementById('whisper-start-button');
        const stopButton = document.getElementById('whisper-stop-button');

        if (startButton) {
            startButton.disabled = this.isRunning;
        }
        if (stopButton) {
            stopButton.disabled = !this.isRunning;
        }
    }

    updateStatus(text, className) {
        const statusElement = document.getElementById('whisper-status');
        if (statusElement) {
            statusElement.textContent = text;
            statusElement.className = 'whisper-status-value ' + (className || '');
        }
    }

    updateServerStatus(text, className) {
        const serverStatusElement = document.getElementById('whisper-server-status');
        if (serverStatusElement) {
            serverStatusElement.textContent = text;
            serverStatusElement.className = 'whisper-status-value ' + (className || '');
        }
    }

    clearTranscription() {
        console.log('Whisper: Clearing transcription');
        this.transcriptionLines = [];
        this.renderTranscription();
    }

    copyToClipboard() {
        const text = this.transcriptionLines.map(line => line.text).join('\n');
        
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                console.log('Whisper: Copied to clipboard');
                this.showTemporaryMessage('Copied to clipboard!');
            }).catch(err => {
                console.error('Whisper: Failed to copy:', err);
            });
        } else {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                console.log('Whisper: Copied to clipboard (fallback)');
                this.showTemporaryMessage('Copied to clipboard!');
            } catch (err) {
                console.error('Whisper: Failed to copy (fallback):', err);
            }
            document.body.removeChild(textarea);
        }
    }

    saveTranscription() {
        const text = this.transcriptionLines.map(line => {
            if (this.showTimestamps && line.timestamp) {
                return `[${line.timestamp}] ${line.text}`;
            }
            return line.text;
        }).join('\n');

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whisper_transcription_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Whisper: Saved transcription');
        this.showTemporaryMessage('Saved transcription!');
    }

    showTemporaryMessage(message) {
        const statusElement = document.getElementById('whisper-status');
        if (statusElement) {
            const originalText = statusElement.textContent;
            const originalClass = statusElement.className;
            statusElement.textContent = message;
            statusElement.className = 'whisper-status-value whisper-status-success';
            setTimeout(() => {
                statusElement.textContent = originalText;
                statusElement.className = originalClass;
            }, 2000);
        }
    }

    handleBinaryMessage(data) {
        // Binary protocol for Whisper transcription
        // Message format:
        // Byte 0: Message type (0x01 = transcription text)
        // Remaining bytes: UTF-8 encoded text

        const view = new DataView(data);
        const messageType = view.getUint8(0);

        console.log(`Whisper: Received binary message, type: 0x${messageType.toString(16).padStart(2, '0')}`);

        switch (messageType) {
            case 0x01: // Transcription text
                this.handleTranscriptionText(view, data);
                break;
            default:
                console.warn(`Whisper: Unknown message type: 0x${messageType.toString(16).padStart(2, '0')}`);
        }
    }

    handleTranscriptionText(view, data) {
        // Extract UTF-8 text from bytes 1 onwards
        const textBytes = new Uint8Array(data, 1);
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(textBytes).trim();

        if (!text) {
            return; // Ignore empty messages
        }

        console.log('Whisper: Transcription:', text);

        // Add to transcription with timestamp
        const timestamp = new Date().toLocaleTimeString();
        this.transcriptionLines.push({
            text: text,
            timestamp: timestamp
        });

        // Render updated transcription
        this.renderTranscription();

        // Auto-scroll if enabled
        if (this.autoScroll) {
            this.scrollToBottom();
        }
    }

    renderTranscription() {
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (!transcriptionElement) return;

        if (this.transcriptionLines.length === 0) {
            transcriptionElement.innerHTML = '<div class="whisper-transcription-empty">No transcription yet. Start the decoder to begin.</div>';
            return;
        }

        const html = this.transcriptionLines.map(line => {
            let lineHtml = '<div class="whisper-transcription-line">';
            if (this.showTimestamps && line.timestamp) {
                lineHtml += `<span class="whisper-timestamp">[${line.timestamp}]</span> `;
            }
            lineHtml += `<span class="whisper-text">${this.escapeHtml(line.text)}</span>`;
            lineHtml += '</div>';
            return lineHtml;
        }).join('');

        transcriptionElement.innerHTML = html;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    scrollToBottom() {
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (transcriptionElement) {
            transcriptionElement.scrollTop = transcriptionElement.scrollHeight;
        }
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) {
            console.error('Whisper: DX WebSocket not available');
            return;
        }

        // Store reference to original handler ONLY if we haven't already
        if (!this.originalDXHandler) {
            this.originalDXHandler = dxClient.ws.onmessage;
            console.log('Whisper: Stored original DX handler');
        }

        // Create new handler that intercepts binary messages only
        this.binaryMessageHandler = (event) => {
            // Check if this is a binary message (ArrayBuffer or Blob)
            if (event.data instanceof ArrayBuffer) {
                // Binary message - process as Whisper data
                if (this.isRunning) {
                    this.handleBinaryMessage(event.data);
                }
                // DO NOT pass binary messages to original handler
            } else if (event.data instanceof Blob) {
                // Binary message as Blob - convert to ArrayBuffer first
                event.data.arrayBuffer().then(arrayBuffer => {
                    if (this.isRunning) {
                        this.handleBinaryMessage(arrayBuffer);
                    }
                }).catch(err => {
                    console.error('Whisper: Failed to convert Blob to ArrayBuffer:', err);
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
        console.log('Whisper: Binary message handler installed');
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
            console.log('Whisper: Original message handler restored');
        }

        this.binaryMessageHandler = null;
    }

    onProcessAudio(dataArray) {
        // Whisper processes audio on the backend (Go side) via the audio extension framework
        // This method is required by DecoderExtension but does nothing for Whisper
        // Audio is sent to the backend when the decoder is attached via WebSocket
    }

    onEnable() {
        console.log('Whisper: Extension enabled');
        this.setupBinaryMessageHandler();
    }

    onDisable() {
        console.log('Whisper: Extension disabled');
        
        // Stop decoder if running
        if (this.isRunning) {
            this.stopDecoder();
        }

        // Remove binary message handler
        this.removeBinaryMessageHandler();
    }
}

// Register the extension
let whisperExtensionInstance = null;

if (window.decoderManager) {
    whisperExtensionInstance = new WhisperExtension();
    window.decoderManager.register(whisperExtensionInstance);
    console.log('Whisper extension registered:', whisperExtensionInstance);
} else {
    console.error('decoderManager not available for Whisper extension');
}

// Expose instance globally for debugging
window.whisperExtensionInstance = whisperExtensionInstance;
