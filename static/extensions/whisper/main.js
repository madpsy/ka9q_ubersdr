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
        this.showOnlyIncomplete = false;  // Show only in-progress disabled by default
        this.hideIncomplete = false;  // Hide in-progress segment
        this.showFloatingWindow = false;  // Show transcription in floating window
        this.fontSize = 13;  // Default font size in pixels
        this.lineLimit = 10;  // Default line limit
        this.selectedLanguage = 'en';  // Default to English
        this.sessionStartTime = null;  // Track when decoder starts for wall clock timestamps
        this.renderedSegmentCount = 0;  // Track how many completed segments are rendered
        this.lastUpdateTime = null;  // Track time of last message update
        this.updateTimerInterval = null;  // Interval for updating the "time since last update" display
        this.handlersSetup = false;  // Track if event handlers have been set up
        this.detectedLanguage = null;  // Detected language from server
        this.detectedLanguageProb = null;  // Language detection probability

        // Text-to-Speech configuration
        this.ttsEnabled = false;
        this.ttsRate = 1.0;
        this.ttsVoice = null;
        this.ttsQueue = [];
        this.isSpeaking = false;
        this.ttsMuteSDR = true;  // Mute SDR when TTS is active (enabled by default)
        this.sdrWasMuted = false;  // Track if SDR was already muted before TTS
        this.ttsSentenceBuffer = '';  // Buffer for accumulating text until a complete sentence

        // Frequency change detection
        this.frequencyChangeHandler = null;  // Event handler for frequency changes
        this.frequencyChangeTimer = null;  // Timer for auto-restart after frequency change
        this.wasRunningBeforeFreqChange = false;  // Track if decoder was running before frequency change

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
        const ttsToggleButton = document.getElementById('whisper-tts-toggle');
        const ttsVoiceSelect = document.getElementById('whisper-tts-voice');
        const ttsRateSlider = document.getElementById('whisper-tts-rate');
        const ttsRateValue = document.getElementById('whisper-tts-rate-value');
        const ttsMuteSDRCheckbox = document.getElementById('whisper-tts-mute-sdr');
        const ttsMuteSDRLabel = document.querySelector('.whisper-tts-mute-sdr-label');

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
        
        // Summarise button
        const summariseButton = document.getElementById('whisper-summarise-button');
        if (summariseButton) {
            summariseButton.addEventListener('click', () => this.requestSummary());
        }
        
        // Summary modal controls
        const summaryModal = document.getElementById('whisper-summary-modal');
        const summaryClose = document.getElementById('whisper-summary-close');
        const summaryOk = document.getElementById('whisper-summary-ok');
        const summaryCopy = document.getElementById('whisper-summary-copy');
        
        if (summaryClose) {
            summaryClose.addEventListener('click', () => this.closeSummaryModal());
        }
        if (summaryOk) {
            summaryOk.addEventListener('click', () => this.closeSummaryModal());
        }
        if (summaryCopy) {
            summaryCopy.addEventListener('click', () => this.copySummaryToClipboard());
        }
        // Close modal when clicking outside
        if (summaryModal) {
            summaryModal.addEventListener('click', (e) => {
                if (e.target === summaryModal) {
                    this.closeSummaryModal();
                }
            });
        }
        
        if (textSmallerButton) {
            textSmallerButton.addEventListener('click', () => this.decreaseTextSize());
        }
        if (textLargerButton) {
            textLargerButton.addEventListener('click', () => this.increaseTextSize());
        }

        // TTS controls
        if (ttsToggleButton) {
            ttsToggleButton.addEventListener('click', () => this.toggleTTS());
        }
        if (ttsVoiceSelect) {
            ttsVoiceSelect.addEventListener('change', (e) => {
                const voices = window.speechSynthesis.getVoices();
                this.ttsVoice = voices.find(v => v.name === e.target.value) || null;
            });
        }
        if (ttsRateSlider) {
            ttsRateSlider.addEventListener('input', (e) => {
                this.ttsRate = parseFloat(e.target.value);
                if (ttsRateValue) {
                    ttsRateValue.textContent = `${this.ttsRate.toFixed(1)}x`;
                }
            });
        }
        if (ttsMuteSDRCheckbox) {
            ttsMuteSDRCheckbox.addEventListener('change', (e) => {
                this.ttsMuteSDR = e.target.checked;
                // If TTS is currently active, apply the mute state immediately
                if (this.ttsEnabled) {
                    this.applySDRMuteState();
                }
            });
        }

        // Initialize TTS voices
        this.initializeTTSVoices();

        // Settings checkboxes and selects
        const autoScrollCheckbox = document.getElementById('whisper-auto-scroll');
        const timestampsCheckbox = document.getElementById('whisper-show-timestamps');
        const showOnlyIncompleteCheckbox = document.getElementById('whisper-show-only-incomplete');
        const hideIncompleteCheckbox = document.getElementById('whisper-hide-incomplete');
        const showFloatingWindowCheckbox = document.getElementById('whisper-show-floating-window');
        const languageSelect = document.getElementById('whisper-language');
        const lineLimitSelect = document.getElementById('whisper-line-limit');

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
        if (hideIncompleteCheckbox) {
            hideIncompleteCheckbox.addEventListener('change', (e) => {
                this.hideIncomplete = e.target.checked;
                // Need to re-render when toggling this mode
                this.forceFullRerender();
            });
        }
        if (languageSelect) {
            languageSelect.addEventListener('change', (e) => {
                this.selectedLanguage = e.target.value;
                console.log('Whisper: Language changed to:', this.selectedLanguage);

                // Auto-select matching TTS voice for the selected language
                this.autoSelectTTSVoice(this.selectedLanguage);
            });
        }
        if (lineLimitSelect) {
            lineLimitSelect.addEventListener('change', (e) => {
                const value = e.target.value;
                this.lineLimit = value === 'unlimited' ? null : parseInt(value, 10);

                // When hiding incomplete, disable and uncheck the related checkboxes
                if (this.hideIncomplete) {
                    // Disable and uncheck "Only show in-progress"
                    if (showOnlyIncompleteCheckbox) {
                        showOnlyIncompleteCheckbox.checked = false;
                        showOnlyIncompleteCheckbox.disabled = true;
                        this.showOnlyIncomplete = false;
                    }
                    // Disable and uncheck "Show modal"
                    if (showFloatingWindowCheckbox) {
                        showFloatingWindowCheckbox.checked = false;
                        showFloatingWindowCheckbox.disabled = true;
                        this.showFloatingWindow = false;
                        this.updateFloatingWindow();
                    }
                } else {
                    // Re-enable the checkboxes
                    if (showOnlyIncompleteCheckbox) {
                        showOnlyIncompleteCheckbox.disabled = false;
                    }
                    if (showFloatingWindowCheckbox) {
                        showFloatingWindowCheckbox.disabled = false;
                    }
                }

                // Re-render to apply the change
                this.forceFullRerender();
            });
        }
        if (showFloatingWindowCheckbox) {
            showFloatingWindowCheckbox.addEventListener('change', (e) => {
                this.showFloatingWindow = e.target.checked;
                this.updateFloatingWindow();
            });
        }
        if (lineLimitSelect) {
            lineLimitSelect.addEventListener('change', (e) => {
                const value = e.target.value;
                this.lineLimit = value === 'unlimited' ? null : parseInt(value, 10);
                // Re-render to apply the new limit
                this.forceFullRerender();
            });
        }

        // Populate language dropdown
        this.populateLanguageDropdown();

        this.handlersSetup = true;
        console.log('Whisper: Event handlers setup complete');
    }

    populateLanguageDropdown() {
        const languageSelect = document.getElementById('whisper-language');
        if (!languageSelect) return;

        // Load languages from languages.js
        fetch('/languages.js')
            .then(response => response.text())
            .then(script => {
                // Execute the script to get WHISPER_LANGUAGES
                eval(script);

                if (typeof WHISPER_LANGUAGES !== 'undefined') {
                    // Clear existing options
                    languageSelect.innerHTML = '';

                    // Sort languages alphabetically by name
                    const sortedLanguages = [...WHISPER_LANGUAGES].sort((a, b) =>
                        a.name.localeCompare(b.name)
                    );

                    // Populate with all languages
                    sortedLanguages.forEach(lang => {
                        const option = document.createElement('option');
                        option.value = lang.code;
                        option.textContent = lang.name;
                        if (lang.code === 'en') {
                            option.selected = true;
                        }
                        languageSelect.appendChild(option);
                    });

                    console.log('Whisper: Populated language dropdown with', sortedLanguages.length, 'languages (sorted alphabetically)');
                } else {
                    console.error('Whisper: WHISPER_LANGUAGES not found in languages.js');
                }
            })
            .catch(error => {
                console.error('Whisper: Failed to load languages.js:', error);
            });
    }

    startDecoder() {
        console.log('Whisper: Starting decoder');
        
        this.isRunning = true;
        this.sessionStartTime = Date.now();  // Record start time for wall clock timestamps
        this.lastUpdateTime = null;  // Reset last update time
        this.detectedLanguage = null;  // Reset detected language
        this.detectedLanguageProb = null;
        this.updateDetectedLanguageDisplay();
        this.updateButtonStates();
        this.updateStatus('Starting...', 'whisper-status-starting');

        // Show the "waiting for first chunk" message
        this.renderTranscription();

        // Start the update timer
        this.startUpdateTimer();
        
        // Start frequency monitoring
        this.startFrequencyMonitoring();

        // Attach to audio extension
        this.attachAudioExtension();
    }

    stopDecoder(skipFrequencyMonitoring = false) {
        console.log('Whisper: Stopping decoder');

        this.isRunning = false;
        this.updateButtonStates();
        this.updateStatus('Stopped', 'whisper-status-stopped');

        // Stop the update timer
        this.stopUpdateTimer();

        // Stop frequency monitoring (unless we're stopping due to frequency change)
        if (!skipFrequencyMonitoring) {
            this.stopFrequencyMonitoring();
        }

        // Stop any ongoing TTS
        this.stopSpeaking();

        // Clear TTS sentence buffer
        this.ttsSentenceBuffer = '';

        // Restore SDR mute state (unmute if it was muted by TTS)
        this.restoreSDRMuteState();

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
            params: {
                language: this.selectedLanguage
            }
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
        const languageSelect = document.getElementById('whisper-language');

        if (startButton) {
            startButton.disabled = this.isRunning;
        }
        if (stopButton) {
            stopButton.disabled = !this.isRunning;
        }
        if (languageSelect) {
            languageSelect.disabled = this.isRunning;
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

        // Clear TTS sentence buffer
        this.ttsSentenceBuffer = '';

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

        // Build filename with callsign, frequency, mode, start time, and last message time
        const callsign = window.instanceDescription?.receiver?.callsign || 'UNKNOWN';
        const frequency = this.radio ? this.radio.getFrequency() : 0;
        const freqMHz = (frequency / 1000000).toFixed(3);
        const mode = this.radio ? this.radio.getMode().toUpperCase() : 'USB';

        // Format start time (session start)
        const startTime = this.sessionStartTime ? new Date(this.sessionStartTime) : new Date();
        const startTimeStr = startTime.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Remove milliseconds

        // Format last message time (last segment end time)
        let lastTimeStr = startTimeStr;
        if (allSegments.length > 0) {
            const lastSegment = allSegments[allSegments.length - 1];
            if (lastSegment.end !== undefined && this.sessionStartTime) {
                const lastSegmentOffsetMs = parseFloat(lastSegment.end) * 1000;
                const lastTime = new Date(this.sessionStartTime + lastSegmentOffsetMs);
                lastTimeStr = lastTime.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            }
        }

        const filename = `${callsign}_${freqMHz}MHz_${mode}_${startTimeStr}_to_${lastTimeStr}.txt`;

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Whisper: Saved transcription as', filename);
        this.showTemporaryMessage('Saved transcription!');
    }

    requestSummary() {
        // Count completed segments (not just displayed ones)
        const completedSegments = this.transcript.length;

        if (completedSegments === 0) {
            alert('No completed segments to summarize. Please wait for some transcription to complete.');
            return;
        }

        console.log(`Whisper: Requesting summary of ${completedSegments} completed segments`);

        // Show modal with spinner
        this.showSummaryModal();

        // Send summary request to backend as JSON message
        const message = {
            type: 'audio_extension_control',
            extension_name: 'whisper',
            control_type: 'summary_request',
            n_segments: completedSegments
        };

        // Send via WebSocket (using DX cluster WebSocket)
        const dxClient = window.dxClusterClient;
        if (dxClient && dxClient.ws && dxClient.ws.readyState === WebSocket.OPEN) {
            dxClient.ws.send(JSON.stringify(message));
            console.log(`Whisper: Sent summary request for ${completedSegments} segments`);
        } else {
            console.error('Whisper: WebSocket not connected, cannot request summary');
            this.showSummaryError('Not connected to server. Please start the decoder first.');
        }
    }

    showSummaryModal() {
        const modal = document.getElementById('whisper-summary-modal');
        const spinner = document.getElementById('whisper-summary-spinner');
        const content = document.getElementById('whisper-summary-content');
        const error = document.getElementById('whisper-summary-error');
        const copyButton = document.getElementById('whisper-summary-copy');

        if (modal) {
            modal.style.display = 'flex';
        }
        if (spinner) {
            spinner.style.display = 'block';
        }
        if (content) {
            content.style.display = 'none';
        }
        if (error) {
            error.style.display = 'none';
        }
        if (copyButton) {
            copyButton.style.display = 'none';
        }
    }

    closeSummaryModal() {
        const modal = document.getElementById('whisper-summary-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    showSummaryError(errorMessage) {
        const spinner = document.getElementById('whisper-summary-spinner');
        const content = document.getElementById('whisper-summary-content');
        const error = document.getElementById('whisper-summary-error');

        if (spinner) {
            spinner.style.display = 'none';
        }
        if (content) {
            content.style.display = 'none';
        }
        if (error) {
            error.textContent = errorMessage;
            error.style.display = 'block';
        }
    }

    handleSummaryResponse(view, data) {
        // Binary protocol: [type:1][timestamp:8][json_length:4][json:N]
        console.log('Whisper: Received summary response');

        // Extract JSON length (bytes 9-12, big-endian)
        const jsonLength = view.getUint32(9, false);

        // Extract JSON data (bytes 13 onwards)
        const jsonBytes = new Uint8Array(data, 13, jsonLength);
        const jsonStr = new TextDecoder().decode(jsonBytes);

        let summaryData;
        try {
            summaryData = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Whisper: Failed to parse summary JSON:', e);
            this.showSummaryError('Failed to parse summary response');
            return;
        }

        console.log('Whisper: Summary data:', summaryData);

        // Display summary in modal
        const spinner = document.getElementById('whisper-summary-spinner');
        const content = document.getElementById('whisper-summary-content');
        const error = document.getElementById('whisper-summary-error');
        const summaryText = document.getElementById('whisper-summary-text');
        const segmentsInfo = document.getElementById('whisper-summary-segments-info');
        const copyButton = document.getElementById('whisper-summary-copy');

        if (spinner) {
            spinner.style.display = 'none';
        }
        if (error) {
            error.style.display = 'none';
        }
        if (content) {
            content.style.display = 'block';
        }
        if (copyButton) {
            copyButton.style.display = 'inline-block';
        }

        if (summaryText) {
            summaryText.textContent = summaryData.summary || 'No summary available';
        }

        if (segmentsInfo) {
            const segmentsUsed = summaryData.segments_used || 0;
            const segmentsRequested = summaryData.segments_requested || 0;
            const targetLanguage = summaryData.target_language || 'en';
            segmentsInfo.textContent = `Summarised ${segmentsUsed} of ${segmentsRequested} requested segments (Language: ${targetLanguage})`;
        }
    }

    copySummaryToClipboard() {
        const summaryText = document.getElementById('whisper-summary-text');
        if (summaryText) {
            const text = summaryText.textContent;
            navigator.clipboard.writeText(text).then(() => {
                console.log('Whisper: Summary copied to clipboard');
                this.showTemporaryMessage('Summary copied!');
            }).catch(err => {
                console.error('Whisper: Failed to copy summary:', err);
                alert('Failed to copy summary to clipboard');
            });
        }
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
        // Byte 0: Message type (0x02 = segments JSON, 0x03 = language detection, 0x04 = error)
        // Remaining bytes: Data

        const view = new DataView(data);
        const messageType = view.getUint8(0);

        switch (messageType) {
            case 0x02: // Segments JSON
                this.handleSegments(view, data);
                break;
            case 0x03: // Language detection
                this.handleLanguageDetection(view, data);
                break;
            case 0x04: // Error message
                this.handleErrorMessage(view, data);
                break;
            case 0x05: // Summary response
                this.handleSummaryResponse(view, data);
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
        // Backend handles deduplication with send_last_n_segments=1
        // Just process segments directly
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            // Completed segments are sent by backend after deduplication
            if (seg.completed) {
                this.transcript.push(seg);
                // Speak completed segment if TTS is enabled
                this.speakSegment(seg.text);
            }
            // Last segment that's not completed becomes lastSegment
            else if (i === segments.length - 1) {
                this.lastSegment = seg;
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

        // If the incomplete element exists and we have new completed segments, remove it
        // (the completed version will be appended from the transcript array)
        if (incompleteElement && this.renderedSegmentCount < this.transcript.length) {
            incompleteElement.remove();
            incompleteElement = null;
        }

        // Append only NEW completed segments that haven't been rendered yet
        for (let i = this.renderedSegmentCount; i < this.transcript.length; i++) {
            const seg = this.transcript[i];
            const lineDiv = this.createSegmentElement(seg, false);
            transcriptionElement.appendChild(lineDiv);
        }
        this.renderedSegmentCount = this.transcript.length;

        // Apply line limit if set
        if (this.lineLimit !== null) {
            const completedElements = Array.from(transcriptionElement.querySelectorAll('.whisper-transcription-line:not(.whisper-incomplete)'));
            if (completedElements.length > this.lineLimit) {
                // Remove oldest segments to stay within limit
                const toRemove = completedElements.length - this.lineLimit;
                for (let i = 0; i < toRemove; i++) {
                    completedElements[i].remove();
                }
            }
        }

        // Re-check for incomplete element after adding new completed segments
        incompleteElement = transcriptionElement.querySelector('.whisper-incomplete');

        // Handle the incomplete segment (last one being refined)
        // IMPORTANT: This must be at the END to stay at the bottom
        // Skip if hideIncomplete is enabled
        if (this.lastSegment && !this.hideIncomplete) {
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
            // Remove incomplete element if no longer needed or if hideIncomplete is enabled
            incompleteElement.remove();
        }

        // Also remove incomplete element if hideIncomplete is enabled
        if (this.hideIncomplete && incompleteElement) {
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
        const shouldShow = this.showFloatingWindow && this.isRunning && this.lastSegment && this.lastSegment.text;
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

    handleLanguageDetection(view, data) {
        // Binary protocol: [type:1][timestamp:8][json_length:4][json:N]
        // Extract timestamp (bytes 1-8, big-endian)
        const timestampNano = view.getBigUint64(1, false);

        // Extract JSON length (bytes 9-12, big-endian)
        const jsonLength = view.getUint32(9, false);

        // Extract JSON (bytes 13 onwards)
        const jsonBytes = new Uint8Array(data, 13, jsonLength);
        const decoder = new TextDecoder('utf-8');
        const jsonStr = decoder.decode(jsonBytes);

        let languageData;
        try {
            languageData = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Whisper: Failed to parse language detection JSON:', e);
            return;
        }

        this.detectedLanguage = languageData.language;
        this.detectedLanguageProb = languageData.language_prob;

        console.log(`Whisper: Detected language: ${this.detectedLanguage} (${(this.detectedLanguageProb * 100).toFixed(1)}%)`);

        // Update the display
        this.updateDetectedLanguageDisplay();
    }

    handleErrorMessage(view, data) {
        // Binary protocol: [type:1][timestamp:8][error_length:4][error:N]
        // Extract timestamp (bytes 1-8, big-endian)
        const timestampNano = view.getBigUint64(1, false);

        // Extract error message length (bytes 9-12, big-endian)
        const errorLength = view.getUint32(9, false);

        // Extract error message (bytes 13 onwards)
        const errorBytes = new Uint8Array(data, 13, errorLength);
        const decoder = new TextDecoder('utf-8');
        const errorMsg = decoder.decode(errorBytes);

        console.error('Whisper: Connection error:', errorMsg);
        
        // Update status to show error and stop the decoder
        this.updateStatus('Error: ' + errorMsg, 'whisper-status-error');
        this.updateServerStatus('Not connected', 'whisper-status-error');
        this.isRunning = false;
        this.updateButtonStates();
    }

    updateDetectedLanguageDisplay() {
        const languageElement = document.getElementById('whisper-detected-language');
        if (!languageElement) return;

        if (this.detectedLanguage && this.detectedLanguageProb) {
            const languageNames = {
                'en': 'English',
                'es': 'Spanish',
                'fr': 'French',
                'de': 'German',
                'it': 'Italian',
                'pt': 'Portuguese',
                'ru': 'Russian',
                'zh': 'Chinese',
                'ja': 'Japanese',
                'ko': 'Korean',
                'ar': 'Arabic',
                'hi': 'Hindi',
                'nl': 'Dutch',
                'pl': 'Polish',
                'tr': 'Turkish',
                'sv': 'Swedish',
                'da': 'Danish',
                'no': 'Norwegian',
                'fi': 'Finnish'
            };

            const languageName = languageNames[this.detectedLanguage] || this.detectedLanguage.toUpperCase();
            const probability = (this.detectedLanguageProb * 100).toFixed(0);

            languageElement.textContent = `(${languageName} ${probability}%)`;
            languageElement.style.display = 'inline';
            languageElement.style.marginLeft = '8px';
            languageElement.style.fontSize = '0.9em';
            languageElement.style.color = '#888';
            languageElement.style.fontStyle = 'italic';
        } else {
            languageElement.style.display = 'none';
        }
    }

    startFrequencyMonitoring() {
        // Subscribe to frequency change events
        this.frequencyChangeHandler = (data) => {
            const newFrequency = data.frequency;
            console.log(`Whisper: Frequency changed to ${newFrequency}`);

            // Clear transcription on frequency change
            this.clearTranscription();

            // Stop decoder if running
            if (this.isRunning) {
                console.log('Whisper: Stopping decoder due to frequency change');
                this.wasRunningBeforeFreqChange = true;
                this.stopDecoder(true); // Skip stopping frequency monitoring
                this.updateStatus('Paused (frequency change)', 'whisper-status-paused');
            }

            // Clear any existing restart timer
            if (this.frequencyChangeTimer) {
                clearTimeout(this.frequencyChangeTimer);
            }

            // Set timer to restart after 1 second of stability
            this.frequencyChangeTimer = setTimeout(() => {
                if (this.wasRunningBeforeFreqChange) {
                    console.log('Whisper: Frequency stable for 3 seconds, restarting decoder');
                    this.wasRunningBeforeFreqChange = false;
                    this.startDecoder();
                }
            }, 3000);
        };

        this.radio.on('frequency_changed', this.frequencyChangeHandler);
        console.log('Whisper: Frequency monitoring started');
    }

    stopFrequencyMonitoring() {
        if (this.frequencyChangeHandler) {
            this.radio.off('frequency_changed', this.frequencyChangeHandler);
            this.frequencyChangeHandler = null;
        }

        if (this.frequencyChangeTimer) {
            clearTimeout(this.frequencyChangeTimer);
            this.frequencyChangeTimer = null;
        }

        this.wasRunningBeforeFreqChange = false;
        console.log('Whisper: Frequency monitoring stopped');
    }

    // Text-to-Speech Methods
    initializeTTSVoices() {
        if (!('speechSynthesis' in window)) {
            console.log('Whisper: Speech synthesis not supported');
            return;
        }

        const populateVoices = () => {
            const voices = window.speechSynthesis.getVoices();
            const voiceSelect = document.getElementById('whisper-tts-voice');

            if (!voiceSelect || voices.length === 0) return;

            // Clear existing options except the first (default)
            while (voiceSelect.options.length > 1) {
                voiceSelect.remove(1);
            }

            // Add voices, prioritizing English voices
            const englishVoices = voices.filter(v => v.lang.startsWith('en'));
            const otherVoices = voices.filter(v => !v.lang.startsWith('en'));

            if (englishVoices.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'English';
                englishVoices.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.name;
                    option.textContent = `${voice.name} (${voice.lang})`;
                    optgroup.appendChild(option);
                });
                voiceSelect.appendChild(optgroup);
            }

            if (otherVoices.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Other Languages';
                otherVoices.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.name;
                    option.textContent = `${voice.name} (${voice.lang})`;
                    optgroup.appendChild(option);
                });
                voiceSelect.appendChild(optgroup);
            }

            // Try to auto-select preferred voices in order:
            // 1. Google UK English Female (Chrome)
            // 2. Microsoft UK online voices (Edge - higher quality, UK accent)
            // 3. Microsoft US online voices (Edge - higher quality, US accent)
            // 4. Any Microsoft online voice
            // 5. Any Microsoft English voice (excluding 'default')
            const googleUK = voices.find(v => v.name === 'Google UK English Female' && v.lang === 'en-GB');
            const msUKOnline = voices.find(v =>
                v.lang === 'en-GB' &&
                v.name.toLowerCase().includes('microsoft') &&
                v.name.toLowerCase().includes('online')
            );
            const msUSOnline = voices.find(v =>
                v.lang === 'en-US' &&
                v.name.toLowerCase().includes('microsoft') &&
                v.name.toLowerCase().includes('online')
            );
            const msAnyOnline = voices.find(v =>
                v.lang.startsWith('en') &&
                v.name.toLowerCase().includes('microsoft') &&
                v.name.toLowerCase().includes('online')
            );
            const msNonDefault = voices.find(v =>
                v.lang.startsWith('en') &&
                v.name.toLowerCase().includes('microsoft') &&
                !v.name.toLowerCase().includes('default')
            );

            const preferredVoice = googleUK || msUKOnline || msUSOnline || msAnyOnline || msNonDefault;
            if (preferredVoice) {
                voiceSelect.value = preferredVoice.name;
                this.ttsVoice = preferredVoice;
                console.log(`Whisper: Auto-selected preferred voice: ${preferredVoice.name} (${preferredVoice.lang})`);
            }

            console.log(`Whisper: Loaded ${voices.length} TTS voices`);
        };

        // Voices may load asynchronously
        populateVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = populateVoices;
        }
    }

    autoSelectTTSVoice(languageCode) {
        const voices = window.speechSynthesis.getVoices();
        const voiceSelect = document.getElementById('whisper-tts-voice');

        if (!voiceSelect || voices.length === 0) {
            console.log('Whisper: Cannot auto-select TTS voice - voices not loaded yet');
            return;
        }

        // Map common Whisper language codes to TTS language codes
        // Whisper uses 2-letter codes, TTS often uses full locale codes
        const languageMap = {
            'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE', 'it': 'it-IT',
            'pt': 'pt-PT', 'ru': 'ru-RU', 'ja': 'ja-JP', 'ko': 'ko-KR',
            'zh': 'zh-CN', 'ar': 'ar-SA', 'hi': 'hi-IN', 'nl': 'nl-NL',
            'pl': 'pl-PL', 'tr': 'tr-TR', 'sv': 'sv-SE', 'da': 'da-DK',
            'no': 'no-NO', 'fi': 'fi-FI', 'cs': 'cs-CZ', 'el': 'el-GR',
            'he': 'he-IL', 'hu': 'hu-HU', 'ro': 'ro-RO', 'sk': 'sk-SK',
            'uk': 'uk-UA', 'id': 'id-ID', 'th': 'th-TH', 'vi': 'vi-VN'
        };

        // Get the full locale code if available, otherwise use the language code
        const targetLang = languageMap[languageCode] || languageCode;

        // Find matching voices, prioritizing Google and Microsoft voices
        const matchingVoices = voices.filter(v =>
            v.lang.startsWith(languageCode) || v.lang === targetLang
        );

        if (matchingVoices.length === 0) {
            console.log(`Whisper: No TTS voice found for language: ${languageCode}`);
            return;
        }

        // Prioritize Google voices (Chrome) and Microsoft voices (Edge)
        let selectedVoice = matchingVoices.find(v => v.name.toLowerCase().includes('google'));

        // Fall back to Microsoft voices if no Google voice found
        if (!selectedVoice) {
            selectedVoice = matchingVoices.find(v => v.name.toLowerCase().includes('microsoft'));
        }

        // Fall back to first matching voice if no Google or Microsoft voice found
        if (!selectedVoice) {
            selectedVoice = matchingVoices[0];
        }

        // Update the dropdown and voice
        voiceSelect.value = selectedVoice.name;
        this.ttsVoice = selectedVoice;

        console.log(`Whisper: Auto-selected TTS voice: ${selectedVoice.name} (${selectedVoice.lang}) for language: ${languageCode}`);
    }

    showFirefoxTTSWarning() {
        // Check if browser is Firefox
        const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

        // Only show warning for Firefox users, and only once per session
        if (!isFirefox || sessionStorage.getItem('whisper_firefox_tts_warning_shown')) {
            return;
        }

        // Mark as shown
        sessionStorage.setItem('whisper_firefox_tts_warning_shown', 'true');

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        // Create modal content
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #2a2a2a;
            color: #e0e0e0;
            padding: 25px;
            border-radius: 8px;
            max-width: 450px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            font-family: Arial, sans-serif;
        `;

        modal.innerHTML = `
            <h3 style="margin-top: 0; color: #ff9800; font-size: 18px;">
                ⚠️ Firefox TTS Quality Notice
            </h3>
            <p style="line-height: 1.6; margin: 15px 0;">
                Firefox does not have high-quality text-to-speech voices.
                TTS will work, but the voice quality may be limited.
            </p>
            <p style="line-height: 1.6; margin: 15px 0;">
                For better TTS quality, we recommend using <strong>Google Chrome</strong>
                or <strong>Microsoft Edge</strong>, which include natural-sounding voices.
            </p>
            <button id="whisper-firefox-warning-ok" style="
                background: #4CAF50;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin-top: 10px;
                width: 100%;
            ">
                OK, I Understand
            </button>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close modal on button click
        document.getElementById('whisper-firefox-warning-ok').addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        // Close modal on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    toggleTTS() {
        this.ttsEnabled = !this.ttsEnabled;

        const ttsButton = document.getElementById('whisper-tts-toggle');
        const ttsVoiceSelect = document.getElementById('whisper-tts-voice');
        const ttsRateSlider = document.getElementById('whisper-tts-rate');
        const ttsRateValue = document.getElementById('whisper-tts-rate-value');
        const ttsMuteSDRLabel = document.querySelector('.whisper-tts-mute-sdr-label');

        if (this.ttsEnabled) {
            // Enable TTS
            if (ttsButton) {
                ttsButton.textContent = '🔊 TTS';
                ttsButton.classList.add('whisper-tts-active');
            }
            // Show voice, rate, and mute SDR controls
            if (ttsVoiceSelect) ttsVoiceSelect.style.display = 'inline-block';
            if (ttsRateSlider) ttsRateSlider.style.display = 'inline-block';
            if (ttsRateValue) ttsRateValue.style.display = 'inline-block';
            if (ttsMuteSDRLabel) ttsMuteSDRLabel.style.display = 'flex';

            // Apply SDR mute state if enabled
            this.applySDRMuteState();

            // Show Firefox TTS quality warning
            this.showFirefoxTTSWarning();

            console.log('Whisper: TTS enabled');
        } else {
            // Disable TTS
            if (ttsButton) {
                ttsButton.textContent = '🔇 TTS';
                ttsButton.classList.remove('whisper-tts-active');
            }
            // Hide voice, rate, and mute SDR controls
            if (ttsVoiceSelect) ttsVoiceSelect.style.display = 'none';
            if (ttsRateSlider) ttsRateSlider.style.display = 'none';
            if (ttsRateValue) ttsRateValue.style.display = 'none';
            if (ttsMuteSDRLabel) ttsMuteSDRLabel.style.display = 'none';

            // Restore SDR mute state
            this.restoreSDRMuteState();

            // Stop any ongoing speech
            this.stopSpeaking();

            console.log('Whisper: TTS disabled');
        }
    }

    applySDRMuteState() {
        if (!this.ttsMuteSDR) {
            console.log('Whisper: Mute SDR option disabled, not muting');
            return;
        }

        // Check current SDR mute state
        const isMuted = this.getSDRMuteState();
        this.sdrWasMuted = isMuted;
        console.log(`Whisper: SDR mute state before TTS: ${isMuted ? 'muted' : 'unmuted'}`);

        // Mute SDR if not already muted
        if (!isMuted && window.toggleMute) {
            window.toggleMute();
            console.log('Whisper: Muted SDR for TTS');
        } else if (isMuted) {
            console.log('Whisper: SDR already muted, leaving as is');
        }
    }

    restoreSDRMuteState() {
        if (!this.ttsMuteSDR) {
            console.log('Whisper: Mute SDR option disabled, not restoring');
            return;
        }

        console.log(`Whisper: Restoring SDR mute state (was muted before: ${this.sdrWasMuted})`);

        // Only unmute if SDR wasn't muted before we started TTS
        const isMuted = this.getSDRMuteState();
        console.log(`Whisper: Current SDR mute state: ${isMuted ? 'muted' : 'unmuted'}`);

        if (isMuted && !this.sdrWasMuted && window.toggleMute) {
            console.log('Whisper: Unmuting SDR (was unmuted before TTS)');
            window.toggleMute();
        } else if (!isMuted) {
            console.log('Whisper: SDR already unmuted');
        } else if (this.sdrWasMuted) {
            console.log('Whisper: SDR was muted before TTS, leaving muted');
        }
    }

    getSDRMuteState() {
        // First check the global isMuted variable (most reliable)
        if (typeof window.isMuted !== 'undefined') {
            return window.isMuted;
        }
        // Fallback: check if SDR is currently muted by looking at the mute button state
        const muteButton = document.getElementById('mute-btn');
        if (muteButton) {
            // Button text is '🔇 Unmute' when muted, '🔊 Mute' when unmuted
            return muteButton.textContent.includes('Unmute');
        }
        return false;
    }

    speakSegment(text) {
        if (!this.ttsEnabled || !('speechSynthesis' in window) || !text || text.trim() === '') {
            return;
        }

        // Remove overlapping words at segment boundaries
        const cleanedText = this.removeSegmentOverlap(this.ttsSentenceBuffer, text.trim());

        // Add text to sentence buffer
        this.ttsSentenceBuffer += (this.ttsSentenceBuffer ? ' ' : '') + cleanedText;

        // Check if buffer contains complete sentences (ending with . ! or ?)
        const completeSentences = this.extractCompleteSentences(this.ttsSentenceBuffer);

        if (completeSentences.sentences.length > 0) {
            // Add complete sentences to TTS queue
            completeSentences.sentences.forEach(sentence => {
                this.ttsQueue.push(sentence);
            });

            // Update buffer to keep only the incomplete part
            this.ttsSentenceBuffer = completeSentences.remainder;

            console.log(`Whisper: Added ${completeSentences.sentences.length} complete sentence(s) to TTS queue (${this.ttsQueue.length} total items)`);

            // If currently speaking, just queue it - will be batched when current utterance ends
            if (this.isSpeaking) {
                return;
            }

            // Start speaking immediately, batching all queued segments
            this.speakQueuedSegments();
        } else {
            console.log(`Whisper: Buffering incomplete sentence: "${this.ttsSentenceBuffer}"`);
        }
    }

    removeSegmentOverlap(existingText, newText) {
        // Remove overlapping words at segment boundaries
        // Example: "has been" at end of existing + "has been detained" at start of new
        // Should result in just "has been detained" being added
        if (!existingText) {
            return newText;
        }

        const existingWords = existingText.trim().split(/\s+/);
        const newWords = newText.trim().split(/\s+/);

        // Check for overlaps of 1-3 words at the boundary
        for (let overlapSize = Math.min(3, existingWords.length, newWords.length); overlapSize >= 1; overlapSize--) {
            const endOfExisting = existingWords.slice(-overlapSize).join(' ').toLowerCase();
            const startOfNew = newWords.slice(0, overlapSize).join(' ').toLowerCase();

            if (endOfExisting === startOfNew) {
                // Found overlap - remove it from the new text
                const remainingWords = newWords.slice(overlapSize);
                const result = remainingWords.join(' ');
                console.log(`Whisper: Removed ${overlapSize}-word overlap: "${endOfExisting}"`);
                return result;
            }
        }

        // No overlap found
        return newText;
    }

    extractCompleteSentences(text) {
        // Split text into sentences based on sentence terminators from multiple languages:
        // Western (English, Spanish, French, etc.): . ! ?
        // CJK (Chinese/Japanese/Korean): 。！？
        // Arabic/Urdu/Persian: ؟ ۔
        // Greek: ; (question mark)
        // Devanagari (Hindi, Bengali, etc.): । ॥
        // Thai/Lao: ฯ ຯ ໆ
        // Armenian: ։ ՞ ՜
        // Burmese/Myanmar: ။ ၊
        // Khmer: ។ ៕
        // Ethiopic/Amharic: ። ፧ ፨
        // Keep the terminator with the sentence
        const sentenceRegex = /[^.!?。！？؟۔;।॥ฯຯໆ։՞՜။၊។៕።፧፨]+[.!?。！？؟۔;।॥ฯຯໆ։՞՜။၊។៕።፧፨]+/g;
        const sentences = [];
        let match;
        let lastIndex = 0;

        while ((match = sentenceRegex.exec(text)) !== null) {
            sentences.push(match[0].trim());
            lastIndex = sentenceRegex.lastIndex;
        }

        // Everything after the last complete sentence is the remainder
        const remainder = text.substring(lastIndex).trim();

        return {
            sentences: sentences,
            remainder: remainder
        };
    }

    speakQueuedSegments() {
        if (this.isSpeaking || this.ttsQueue.length === 0) {
            return;
        }

        this.isSpeaking = true;

        // Batch all queued segments for smooth continuous speech
        const segmentsToSpeak = [...this.ttsQueue];
        this.ttsQueue = [];

        // Join segments with a space for natural flow
        const combinedText = segmentsToSpeak.join(' ');

        const utterance = new SpeechSynthesisUtterance(combinedText);
        utterance.rate = this.ttsRate;
        utterance.volume = 1.0;
        utterance.pitch = 1.0;

        // Use detected language if available, otherwise use voice's language
        if (this.detectedLanguage) {
            utterance.lang = this.detectedLanguage;
        }

        // Use selected voice if available
        if (this.ttsVoice) {
            utterance.voice = this.ttsVoice;
        }

        // Handle completion to process any new segments that arrived
        utterance.onend = () => {
            this.isSpeaking = false;
            // Check if new segments arrived while speaking and batch them
            if (this.ttsQueue.length > 0) {
                console.log(`Whisper: Processing next batch (${this.ttsQueue.length} segments in queue)`);
                this.speakQueuedSegments();
            }
        };

        // Handle errors
        utterance.onerror = (event) => {
            console.error('Whisper: TTS error:', event.error);
            this.isSpeaking = false;
            // Try next batch in queue
            if (this.ttsQueue.length > 0) {
                setTimeout(() => this.speakQueuedSegments(), 100);
            }
        };

        const segmentCount = segmentsToSpeak.length;
        const logMsg = segmentCount > 1
            ? `Whisper: Speaking ${segmentCount} batched segments (${combinedText.length} chars, rate: ${this.ttsRate}x)`
            : `Whisper: Speaking text (${combinedText.length} chars, rate: ${this.ttsRate}x)`;
        console.log(logMsg);

        window.speechSynthesis.speak(utterance);
    }

    stopSpeaking() {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            this.ttsQueue = [];
            this.isSpeaking = false;
            console.log('Whisper: TTS stopped and queue cleared');
        }
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
