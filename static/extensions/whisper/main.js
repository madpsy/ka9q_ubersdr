// Whisper Extension for ka9q UberSDR
// Real-time speech-to-text transcription using OpenAI Whisper

class WhisperExtension extends DecoderExtension {
    constructor() {
        console.log('Whisper: Constructor called');
        super('whisper', {
            displayName: 'Speech-to-Text',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 2700
        });
        console.log('Whisper: Super constructor completed');

        // Configuration (UI-only settings)
        this.config = {
            auto_scroll: true,
            show_timestamps: true
        };

        // Transcription state - following WhisperLive client.py pattern
        this.transcript = [];  // Completed segments only
        this.lastSegment = null;  // Current incomplete segment being refined
        this.isRunning = false;
        this.autoScroll = true;
        this.showTimestamps = false;  // Disabled by default
        this.showOnlyIncomplete = true;  // Show only in-progress by default
        this.showFloatingWindow = false;  // Show transcription in floating window
        this.fontSize = 13;  // Default font size in pixels
        this.sessionStartTime = null;  // Track when decoder starts for wall clock timestamps
        this.renderedSegmentCount = 0;  // Track how many completed segments are rendered
        this.lastUpdateTime = null;  // Track time of last message update
        this.updateTimerInterval = null;  // Interval for updating the "time since last update" display
        this.handlersSetup = false;  // Track if event handlers have been set up

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
        if (this.handlersSetup) {
            console.log('Whisper: Event handlers already set up, skipping');
            return;
        }

        console.log('Whisper: Setting up event handlers');

        // Control buttons
        const startButton = document.getElementById('whisper-start-button');
        const stopButton = document.getElementById('whisper-stop-button');
        const clearButton = document.getElementById('whisper-clear-button');
        const copyButton = document.getElementById('whisper-copy-button');
        const saveButton = document.getElementById('whisper-save-button');
        const textSmallerButton = document.getElementById('whisper-text-smaller');
        const textLargerButton = document.getElementById('whisper-text-larger');

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
        if (textSmallerButton) {
            textSmallerButton.addEventListener('click', () => this.decreaseTextSize());
        }
        if (textLargerButton) {
            textLargerButton.addEventListener('click', () => this.increaseTextSize());
        }

        // Settings checkboxes
        const autoScrollCheckbox = document.getElementById('whisper-auto-scroll');
        const timestampsCheckbox = document.getElementById('whisper-show-timestamps');
        const showOnlyIncompleteCheckbox = document.getElementById('whisper-show-only-incomplete');
        const showFloatingWindowCheckbox = document.getElementById('whisper-show-floating-window');

        if (autoScrollCheckbox) {
            autoScrollCheckbox.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
            });
        }
        if (timestampsCheckbox) {
            timestampsCheckbox.addEventListener('change', (e) => {
                this.showTimestamps = e.target.checked;
                // For timestamp toggle, we need to re-render all segments
                this.forceFullRerender();
            });
        }
        if (showOnlyIncompleteCheckbox) {
            showOnlyIncompleteCheckbox.addEventListener('change', (e) => {
                this.showOnlyIncomplete = e.target.checked;
                // Need to re-render when toggling this mode
                this.forceFullRerender();
            });
        }
        if (showFloatingWindowCheckbox) {
            showFloatingWindowCheckbox.addEventListener('change', (e) => {
                this.showFloatingWindow = e.target.checked;
                this.updateFloatingWindow();
            });
        }

        this.handlersSetup = true;
        console.log('Whisper: Event handlers setup complete');
    }

    startDecoder() {
        console.log('Whisper: Starting decoder');
        
        this.isRunning = true;
        this.sessionStartTime = Date.now();  // Record start time for wall clock timestamps
        this.lastUpdateTime = null;  // Reset last update time
        this.updateButtonStates();
        this.updateStatus('Starting...', 'whisper-status-starting');

        // Show the "waiting for first chunk" message
        this.renderTranscription();

        // Start the update timer
        this.startUpdateTimer();

        // Attach to audio extension
        this.attachAudioExtension();
    }

    stopDecoder() {
        console.log('Whisper: Stopping decoder');
        
        this.isRunning = false;
        this.updateButtonStates();
        this.updateStatus('Stopped', 'whisper-status-stopped');

        // Stop the update timer
        this.stopUpdateTimer();

        // Remove floating window
        this.updateFloatingWindow();

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
            params: {} // No user-configurable parameters - all server-side
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
        this.transcript = [];
        this.lastSegment = null;
        this.renderedSegmentCount = 0;  // Reset rendered count

        // Clear the DOM
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (transcriptionElement) {
            transcriptionElement.innerHTML = '';
        }

        this.renderTranscription();
    }

    copyToClipboard() {
        // Get all completed segments plus the current incomplete one
        const allSegments = [...this.transcript];
        if (this.lastSegment) {
            allSegments.push(this.lastSegment);
        }
        const text = allSegments.map(seg => seg.text).join(' ');
        
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
        // Get all completed segments plus the current incomplete one
        const allSegments = [...this.transcript];
        if (this.lastSegment) {
            allSegments.push(this.lastSegment);
        }

        const text = allSegments.map(seg => {
            if (this.showTimestamps && seg.start !== undefined) {
                const startTime = parseFloat(seg.start);
                const endTime = parseFloat(seg.end);
                return `[${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s] ${seg.text}`;
            }
            return seg.text;
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
        // Byte 0: Message type (0x02 = segments JSON)
        // Remaining bytes: JSON data

        const view = new DataView(data);
        const messageType = view.getUint8(0);

        switch (messageType) {
            case 0x02: // Segments JSON
                this.handleSegments(view, data);
                break;
            default:
                console.warn(`Whisper: Unknown message type: 0x${messageType.toString(16).padStart(2, '0')}`);
        }
    }

    handleSegments(view, data) {
        // Binary protocol: [type:1][timestamp:8][json_length:4][json:N]
        // Extract timestamp (bytes 1-8, big-endian)
        const timestampNano = view.getBigUint64(1, false); // false = big-endian

        // Extract JSON length (bytes 9-12, big-endian)
        const jsonLength = view.getUint32(9, false); // false = big-endian

        // Extract JSON (bytes 13 onwards)
        const jsonBytes = new Uint8Array(data, 13, jsonLength);
        const decoder = new TextDecoder('utf-8');
        const jsonStr = decoder.decode(jsonBytes);

        let segments;
        try {
            segments = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Whisper: Failed to parse segments JSON:', e);
            return;
        }

        if (!Array.isArray(segments) || segments.length === 0) {
            return;
        }

        // Process segments following WhisperLive client.py pattern (lines 144-158)
        this.processSegments(segments);

        // Update last update time
        this.lastUpdateTime = Date.now();

        // Render updated transcription
        this.renderTranscription();

        // Auto-scroll if enabled - use requestAnimationFrame for proper timing
        if (this.autoScroll) {
            // Double requestAnimationFrame ensures browser has completed layout
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.scrollToBottom();
                });
            });
        }
    }

    processSegments(segments) {
        // Following WhisperLive client.py process_segments() method (lines 144-158)
        // Server sends last N segments, so we need to deduplicate
        const text = [];

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            // Match official client.py line 148: only process if text is different from previous
            // Use case-insensitive comparison to catch capitalization variations
            const segTextLower = seg.text.trim().toLowerCase();
            const isDifferent = text.length === 0 || text[text.length - 1] !== segTextLower;

            if (isDifferent) {
                text.push(segTextLower);

                // Last segment that's not completed becomes lastSegment
                if (i === segments.length - 1 && !seg.completed) {
                    this.lastSegment = seg;
                }
                // Completed segments are added to transcript if not already there
                else if (seg.completed) {
                    // Check if this segment extends/completes a previous partial segment
                    let isExtension = false;
                    if (this.transcript.length > 0) {
                        const lastTranscript = this.transcript[this.transcript.length - 1];
                        const lastTextLower = lastTranscript.text.trim().toLowerCase();

                        // Check if current segment contains the previous segment (extension)
                        // and has overlapping timestamps
                        if (segTextLower.includes(lastTextLower) &&
                            segTextLower.length > lastTextLower.length &&
                            parseFloat(seg.start) < parseFloat(lastTranscript.end)) {
                            // This is an extended version of the previous segment
                            this.transcript[this.transcript.length - 1] = seg;
                            this.renderedSegmentCount = Math.max(0, this.renderedSegmentCount - 1); // Force re-render
                            isExtension = true;
                        }
                    }

                    if (!isExtension) {
                        // Match official client.py line 157: only add if timestamp is after last segment
                        // This prevents both exact duplicates AND refined versions of same time segment
                        const shouldAdd = this.transcript.length === 0 ||
                            parseFloat(seg.start) >= parseFloat(this.transcript[this.transcript.length - 1].end);

                        if (shouldAdd) {
                            this.transcript.push(seg);
                        } else {
                            // Segment overlaps with previous - this is a refinement, replace the last one
                            this.transcript[this.transcript.length - 1] = seg;
                            this.renderedSegmentCount = Math.max(0, this.renderedSegmentCount - 1); // Force re-render
                        }
                    }
                }
            }
        }
    }

    renderTranscription() {
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (!transcriptionElement) return;

        // Handle "show only incomplete" mode
        if (this.showOnlyIncomplete) {
            // Clear everything and show only the incomplete segment
            transcriptionElement.innerHTML = '';

            if (this.lastSegment) {
                const lineDiv = this.createSegmentElement(this.lastSegment, true);
                transcriptionElement.appendChild(lineDiv);
            } else if (this.isRunning) {
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'whisper-transcription-empty';
                emptyDiv.textContent = 'Waiting for speech...';
                transcriptionElement.appendChild(emptyDiv);
            } else {
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'whisper-transcription-empty';
                emptyDiv.textContent = 'No transcription yet. Start the decoder to begin.';
                transcriptionElement.appendChild(emptyDiv);
            }
            // Update floating window
            this.updateFloatingWindow();
            return;
        }

        // Normal mode: show all segments
        // Handle empty state
        if (this.transcript.length === 0 && !this.lastSegment) {
            // Remove any existing content
            transcriptionElement.innerHTML = '';

            // Add empty state message
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'whisper-transcription-empty';
            if (this.isRunning) {
                emptyDiv.textContent = 'Transcription started, please wait for the first chunk of text...';
            } else {
                emptyDiv.textContent = 'No transcription yet. Start the decoder to begin.';
            }
            transcriptionElement.appendChild(emptyDiv);
            return;
        }

        // Remove empty state message if it exists
        const emptyMsg = transcriptionElement.querySelector('.whisper-transcription-empty');
        if (emptyMsg) {
            emptyMsg.remove();
        }

        // First, check if there's an existing incomplete element
        let incompleteElement = transcriptionElement.querySelector('.whisper-incomplete');

        // If the incomplete element exists but is now complete, convert it to a completed segment
        if (incompleteElement && this.renderedSegmentCount < this.transcript.length) {
            // The previously incomplete segment is now complete
            incompleteElement.classList.remove('whisper-incomplete');
            incompleteElement = null; // Clear reference so we create a new one for the next incomplete
        }

        // Append only NEW completed segments that haven't been rendered yet
        for (let i = this.renderedSegmentCount; i < this.transcript.length; i++) {
            const seg = this.transcript[i];
            const lineDiv = this.createSegmentElement(seg, false);
            transcriptionElement.appendChild(lineDiv);
        }
        this.renderedSegmentCount = this.transcript.length;

        // Re-check for incomplete element after adding new completed segments
        incompleteElement = transcriptionElement.querySelector('.whisper-incomplete');

        // Handle the incomplete segment (last one being refined)
        // IMPORTANT: This must be at the END to stay at the bottom
        if (this.lastSegment) {
            if (!incompleteElement) {
                // Create new incomplete element and append to the END
                incompleteElement = this.createSegmentElement(this.lastSegment, true);
                transcriptionElement.appendChild(incompleteElement);
            } else {
                // Update existing incomplete element in-place
                this.updateSegmentElement(incompleteElement, this.lastSegment);
                // Ensure it's at the end by moving it if needed
                if (incompleteElement !== transcriptionElement.lastElementChild) {
                    transcriptionElement.appendChild(incompleteElement);
                }
            }
        } else if (incompleteElement) {
            // Remove incomplete element if no longer needed
            incompleteElement.remove();
        }

        // Update floating window
        this.updateFloatingWindow();
    }

    createSegmentElement(seg, isIncomplete) {
        const lineDiv = document.createElement('div');
        lineDiv.className = `whisper-transcription-line ${isIncomplete ? 'whisper-incomplete' : ''}`;

        if (this.showTimestamps && seg.start !== undefined && this.sessionStartTime) {
            const timestampSpan = document.createElement('span');
            timestampSpan.className = 'whisper-timestamp';
            const segmentOffsetMs = parseFloat(seg.start) * 1000;
            const wallClockTime = new Date(this.sessionStartTime + segmentOffsetMs);
            const timeStr = wallClockTime.toISOString().substr(11, 8);  // HH:MM:SS format
            timestampSpan.textContent = `[${timeStr}] `;
            lineDiv.appendChild(timestampSpan);
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'whisper-text';
        textSpan.textContent = seg.text;
        lineDiv.appendChild(textSpan);

        return lineDiv;
    }

    updateSegmentElement(element, seg) {
        // Update text content without recreating the element
        const textSpan = element.querySelector('.whisper-text');
        if (textSpan) {
            textSpan.textContent = seg.text;
        }

        // Update timestamp if needed and timestamps are enabled
        if (this.showTimestamps && seg.start !== undefined && this.sessionStartTime) {
            let timestampSpan = element.querySelector('.whisper-timestamp');
            if (!timestampSpan) {
                // Create timestamp if it doesn't exist
                timestampSpan = document.createElement('span');
                timestampSpan.className = 'whisper-timestamp';
                element.insertBefore(timestampSpan, element.firstChild);
            }
            const segmentOffsetMs = parseFloat(seg.start) * 1000;
            const wallClockTime = new Date(this.sessionStartTime + segmentOffsetMs);
            const timeStr = wallClockTime.toISOString().substr(11, 8);
            timestampSpan.textContent = `[${timeStr}] `;
        } else {
            // Remove timestamp if timestamps are disabled
            const timestampSpan = element.querySelector('.whisper-timestamp');
            if (timestampSpan) {
                timestampSpan.remove();
            }
        }
    }

    forceFullRerender() {
        // Force a complete re-render of all segments (used when timestamps are toggled)
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (!transcriptionElement) return;

        // Clear everything
        transcriptionElement.innerHTML = '';

        // Reset counter to force re-render of all segments
        this.renderedSegmentCount = 0;

        // Re-render everything
        this.renderTranscription();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    scrollToBottom() {
        // The scrollbar belongs to the generic extension panel content, not the whisper-transcription div
        const extensionContent = document.getElementById('extension-panel-content');
        if (!extensionContent) {
            return;
        }

        // Set scroll position to maximum
        extensionContent.scrollTop = extensionContent.scrollHeight;
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
                // Text message - try to parse and handle
                try {
                    const message = JSON.parse(event.data);
                    this.handleTextMessage(message);
                } catch (e) {
                    // Not JSON or not for us, pass to original handler
                    if (this.originalDXHandler && this.originalDXHandler !== this.binaryMessageHandler) {
                        this.originalDXHandler.call(dxClient.ws, event);
                    }
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

    handleTextMessage(message) {
        // Handle text messages from the server
        if (message.type === 'audio_extension_error') {
            console.error('Whisper: Server error:', message.error);
            this.updateStatus('Error: ' + message.error, 'whisper-status-error');
            this.updateServerStatus('Error', 'whisper-status-error');
            this.isRunning = false;
            this.updateButtonStates();
        } else if (message.type === 'audio_extension_attached') {
            console.log('Whisper: Successfully attached to server');
            this.updateServerStatus('Connected', 'whisper-status-running');
        }
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

    startUpdateTimer() {
        // Clear any existing timer
        this.stopUpdateTimer();

        // Update immediately
        this.updateLastUpdateDisplay();

        // Update every second
        this.updateTimerInterval = setInterval(() => {
            this.updateLastUpdateDisplay();
        }, 1000);
    }

    stopUpdateTimer() {
        if (this.updateTimerInterval) {
            clearInterval(this.updateTimerInterval);
            this.updateTimerInterval = null;
        }

        // Reset display
        const lastUpdateElement = document.getElementById('whisper-last-update');
        if (lastUpdateElement) {
            lastUpdateElement.textContent = '--';
        }
    }

    updateLastUpdateDisplay() {
        const lastUpdateElement = document.getElementById('whisper-last-update');
        if (!lastUpdateElement) return;

        if (!this.lastUpdateTime) {
            lastUpdateElement.textContent = '--';
            return;
        }

        const now = Date.now();
        const elapsedMs = now - this.lastUpdateTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);

        if (elapsedSeconds < 60) {
            lastUpdateElement.textContent = `${elapsedSeconds}s`;
        } else {
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = elapsedSeconds % 60;
            lastUpdateElement.textContent = `${minutes}m${seconds}s`;
        }
    }

    increaseTextSize() {
        this.fontSize = Math.min(this.fontSize + 2, 32); // Max 32px
        this.updateTranscriptionFontSize();
    }

    decreaseTextSize() {
        this.fontSize = Math.max(this.fontSize - 2, 8); // Min 8px
        this.updateTranscriptionFontSize();
    }

    updateTranscriptionFontSize() {
        const transcriptionElement = document.getElementById('whisper-transcription');
        if (transcriptionElement) {
            transcriptionElement.style.fontSize = `${this.fontSize}px`;
        }
        // Also update floating window if it exists
        this.updateFloatingWindow();
    }

    updateFloatingWindow() {
        const shouldShow = this.showFloatingWindow && this.lastSegment && this.lastSegment.text;
        let floatingWindow = document.getElementById('whisper-floating-window');

        if (!shouldShow) {
            if (floatingWindow) {
                floatingWindow.remove();
            }
            return;
        }

        // Create floating window if it doesn't exist
        if (!floatingWindow) {
            floatingWindow = document.createElement('div');
            floatingWindow.id = 'whisper-floating-window';
            floatingWindow.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 400px;
                padding: 15px 20px;
                background-color: rgba(0, 0, 0, 0.6);
                border: 2px solid #ff9800;
                border-radius: 8px;
                color: #ff9800;
                font-family: Consolas, Monaco, monospace;
                font-size: ${this.fontSize}px;
                font-weight: bold;
                text-align: center;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
                z-index: 999999;
                cursor: move;
                user-select: none;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                word-wrap: break-word;
                white-space: pre-wrap;
                resize: both;
                overflow-y: auto;
                overflow-x: hidden;
                min-width: 200px;
                min-height: 50px;
            `;

            // Make it draggable
            let isDragging = false;
            let currentX;
            let currentY;
            let initialX;
            let initialY;

            floatingWindow.addEventListener('mousedown', (e) => {
                // Don't start dragging if clicking on the resize handle (bottom-right 15px corner)
                const rect = floatingWindow.getBoundingClientRect();
                const isResizeArea = (
                    e.clientX > rect.right - 15 &&
                    e.clientY > rect.bottom - 15
                );

                if (!isResizeArea) {
                    isDragging = true;
                    initialX = e.clientX - floatingWindow.offsetLeft;
                    initialY = e.clientY - floatingWindow.offsetTop;
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                    floatingWindow.style.left = currentX + 'px';
                    floatingWindow.style.top = currentY + 'px';
                    floatingWindow.style.transform = 'none';
                }
            });

            document.addEventListener('mouseup', () => {
                isDragging = false;
            });

            document.body.appendChild(floatingWindow);
            console.log('Whisper: Created floating window');
        }

        // Update content and font size
        floatingWindow.textContent = this.lastSegment.text;
        floatingWindow.style.fontSize = `${this.fontSize}px`;
    }

    onActivate() {
        console.log('Whisper: Extension activated');
        // Reset the flag so handlers can be re-attached to the new DOM
        this.handlersSetup = false;
        // Re-setup event handlers when extension is reopened
        this.waitForDOMAndSetupHandlers();
        // Apply the current font size
        setTimeout(() => this.updateTranscriptionFontSize(), 100);
    }

    onDeactivate() {
        console.log('Whisper: Extension deactivated');
        if (this.isRunning) {
            this.stopDecoder();
        }
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
