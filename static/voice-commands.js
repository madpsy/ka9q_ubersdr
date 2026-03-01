/**
 * Voice Commands Module
 * Handles voice command recording, WebSocket communication, and UI updates
 */

(function() {
    'use strict';

    let isRecording = false;
    let mediaRecorder = null;
    let audioContext = null;
    let mediaStream = null;
    let recordingTimeout = null;
    let audioWorkletNode = null;
    let countdownInterval = null;
    let recordingStartTime = null;
    let startConfirmed = false;
    let audioProcessor = null;

    const MAX_RECORDING_TIME = 10000; // 10 seconds in milliseconds

    /**
     * Initialize voice command button
     */
    function initializeVoiceCommandButton() {
        const button = document.getElementById('voice-command-button');
        if (!button) {
            console.log('[VoiceCommands] Button not found');
            return;
        }

        // Use mousedown/mouseup for press-and-hold behavior
        button.addEventListener('mousedown', handleMouseDown);
        button.addEventListener('mouseup', handleMouseUp);
        button.addEventListener('mouseleave', handleMouseUp); // Stop if mouse leaves button

        // Also support touch events for mobile
        button.addEventListener('touchstart', handleMouseDown);
        button.addEventListener('touchend', handleMouseUp);
        button.addEventListener('touchcancel', handleMouseUp);

        console.log('[VoiceCommands] Initialized (press-and-hold)');
    }

    /**
     * Handle mouse/touch down - start recording
     */
    async function handleMouseDown(e) {
        e.preventDefault();
        if (!isRecording) {
            await startRecording();
        }
    }

    /**
     * Handle mouse/touch up - stop recording
     */
    function handleMouseUp(e) {
        if (e) e.preventDefault();
        if (isRecording) {
            stopRecording();
        }
    }

    /**
     * Start voice command recording
     */
    async function startRecording() {
        const button = document.getElementById('voice-command-button');

        try {
            // Request microphone access
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Send start message first and wait for confirmation
            sendStartMessage();

            // Wait a bit for the backend to process the start message
            await new Promise(resolve => setTimeout(resolve, 100));

            // Create audio context for processing
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = audioContext.createMediaStreamSource(mediaStream);

            // Create script processor for audio chunks
            audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);

            audioProcessor.onaudioprocess = (e) => {
                if (!isRecording || !startConfirmed) return;

                const inputData = e.inputBuffer.getChannelData(0);
                // Convert Float32Array to Int16Array for backend
                const int16Data = float32ToInt16(inputData);
                // Convert to base64 for WebSocket transmission
                const base64Audio = arrayBufferToBase64(int16Data.buffer);

                // Send audio chunk via WebSocket
                sendAudioChunk(base64Audio);
            };

            source.connect(audioProcessor);
            audioProcessor.connect(audioContext.destination);

            // Update UI
            isRecording = true;
            recordingStartTime = Date.now();
            button.classList.add('recording');
            button.title = 'Stop Voice Command (Recording...)';
            
            // Hide the microphone icon
            const svg = button.querySelector('svg');
            if (svg) {
                svg.style.display = 'none';
            }

            // Create and add progress bar
            createProgressBar(button);

            // Start countdown timer
            startCountdown(button);

            // Set 10-second timeout
            recordingTimeout = setTimeout(() => {
                console.log('[VoiceCommands] 10-second timeout reached');
                stopRecording();
                showNotification('Voice command timeout (10 seconds maximum)', 'warning');
            }, MAX_RECORDING_TIME);

            console.log('[VoiceCommands] Recording started');
            showNotification('Listening... (10 seconds max)', 'info');

        } catch (error) {
            console.error('[VoiceCommands] Error starting recording:', error);
            showNotification('Failed to access microphone: ' + error.message, 'error');
            cleanupRecording();
        }
    }

    /**
     * Stop voice command recording
     */
    function stopRecording() {
        const button = document.getElementById('voice-command-button');

        if (!isRecording) return;

        // Clear timeout and countdown
        if (recordingTimeout) {
            clearTimeout(recordingTimeout);
            recordingTimeout = null;
        }
        
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }

        // Send stop message
        sendStopMessage();

        // Cleanup
        cleanupRecording();

        // Update UI
        isRecording = false;
        button.classList.remove('recording');
        button.title = 'Voice Commands';
        
        // Show the microphone icon again
        const svg = button.querySelector('svg');
        if (svg) {
            svg.style.display = 'block';
        }

        // Remove progress bar and countdown
        removeProgressBar(button);
        removeCountdown(button);

        console.log('[VoiceCommands] Recording stopped');
        showNotification('Processing voice command...', 'info');
    }

    /**
     * Cleanup recording resources
     */
    function cleanupRecording() {
        if (audioProcessor) {
            audioProcessor.disconnect();
            audioProcessor = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }

        startConfirmed = false;
    }

    /**
     * Send start message to backend
     */
    function sendStartMessage() {
        const ws = window.dxClusterClient?.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[VoiceCommands] WebSocket not connected');
            showNotification('WebSocket not connected', 'error');
            stopRecording();
            return;
        }

        const message = {
            type: 'voice_command_start'
        };

        ws.send(JSON.stringify(message));
        console.log('[VoiceCommands] Sent start message');
    }

    /**
     * Send audio chunk to backend
     */
    function sendAudioChunk(base64Audio) {
        const ws = window.dxClusterClient?.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[VoiceCommands] WebSocket not connected');
            stopRecording();
            return;
        }

        const message = {
            type: 'voice_command_audio',
            audio: base64Audio
        };

        ws.send(JSON.stringify(message));
    }

    /**
     * Send stop message to backend
     */
    function sendStopMessage() {
        const ws = window.dxClusterClient?.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[VoiceCommands] WebSocket not connected');
            return;
        }

        const message = {
            type: 'voice_command_stop'
        };

        ws.send(JSON.stringify(message));
        console.log('[VoiceCommands] Sent stop message');
    }

    /**
     * Handle voice command messages from backend
     */
    function handleVoiceCommandMessage(data) {
        console.log('[VoiceCommands] Received message:', data);

        switch (data.type) {
            case 'voice_command_started':
                console.log('[VoiceCommands] Backend confirmed start');
                startConfirmed = true;
                break;

            case 'voice_command_stopped':
                console.log('[VoiceCommands] Backend confirmed stop');
                break;

            case 'voice_command_transcription':
                handleTranscription(data);
                break;

            case 'voice_command_result':
                handleCommandResult(data);
                break;

            case 'voice_command_error':
                handleError(data);
                break;

            case 'voice_command_timeout':
                showNotification(data.message || 'Voice command timeout', 'warning');
                break;

            default:
                console.log('[VoiceCommands] Unknown message type:', data.type);
        }
    }

    /**
     * Handle transcription from backend
     */
    function handleTranscription(data) {
        const text = data.text || '';
        const recognized = data.recognized || false;

        console.log('[VoiceCommands] Transcription:', text, 'Recognized:', recognized);

        if (!recognized) {
            showNotification(`You said: "${text}" (no command recognized)`, 'info', 5000);
        }
    }

    /**
     * Handle command result from backend
     */
    function handleCommandResult(data) {
        const text = data.text || '';
        const command = data.command || '';
        const parameters = data.parameters || {};

        console.log('[VoiceCommands] Command:', command, 'Parameters:', parameters);

        // Build notification message
        let message = `You said: "${text}"\n\n`;
        message += `Command: ${command}\n`;
        message += `Parameters: ${JSON.stringify(parameters, null, 2)}`;

        showNotification(message, 'success', 8000);

        // TODO: Execute command based on command type and parameters
        // For now, just display it
    }

    /**
     * Handle error from backend
     */
    function handleError(data) {
        const error = data.error || 'Unknown error';
        console.error('[VoiceCommands] Error:', error);
        showNotification('Error: ' + error, 'error');
    }

    /**
     * Show notification to user
     */
    function showNotification(message, type = 'info', duration = 3000) {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `voice-command-notification ${type}`;
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: ${type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : type === 'success' ? '#4caf50' : '#2196f3'};
            color: white;
            padding: 15px 20px;
            border-radius: 4px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            z-index: 10000;
            max-width: 400px;
            white-space: pre-wrap;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.4;
        `;
        notification.textContent = message;

        document.body.appendChild(notification);

        // Auto-remove after duration
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.3s';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, duration);
    }

    /**
     * Create progress bar on button
     */
    function createProgressBar(button) {
        // Remove any existing progress bar
        removeProgressBar(button);
        
        // Create progress bar container
        const progressBar = document.createElement('div');
        progressBar.className = 'voice-command-progress';
        progressBar.style.cssText = `
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            width: 0%;
            background: linear-gradient(90deg, #4caf50, #8bc34a);
            transition: width 0.1s linear;
            border-radius: 0 0 4px 4px;
        `;
        
        button.style.position = 'relative';
        button.style.overflow = 'hidden';
        button.appendChild(progressBar);
        
        // Animate progress bar
        let progress = 0;
        const updateInterval = 100; // Update every 100ms
        const progressInterval = setInterval(() => {
            const elapsed = Date.now() - recordingStartTime;
            progress = (elapsed / MAX_RECORDING_TIME) * 100;
            
            if (progress >= 100) {
                progress = 100;
                clearInterval(progressInterval);
            }
            
            progressBar.style.width = progress + '%';
        }, updateInterval);
        
        // Store interval ID for cleanup
        progressBar.dataset.intervalId = progressInterval;
    }

    /**
     * Remove progress bar from button
     */
    function removeProgressBar(button) {
        const progressBar = button.querySelector('.voice-command-progress');
        if (progressBar) {
            const intervalId = progressBar.dataset.intervalId;
            if (intervalId) {
                clearInterval(parseInt(intervalId));
            }
            progressBar.remove();
        }
    }

    /**
     * Start countdown timer on button
     */
    function startCountdown(button) {
        // Add keyframes for pulse animation if not already added
        if (!document.getElementById('voice-command-pulse-animation')) {
            const style = document.createElement('style');
            style.id = 'voice-command-pulse-animation';
            style.textContent = `
                @keyframes voice-command-pulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.15); opacity: 0.9; }
                }
            `;
            document.head.appendChild(style);
        }

        // Create countdown display in center of button
        const countdown = document.createElement('div');
        countdown.className = 'voice-command-countdown';
        countdown.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 18px;
            font-weight: bold;
            text-shadow: 0 2px 4px rgba(0,0,0,0.5);
            z-index: 2;
            pointer-events: none;
        `;

        button.appendChild(countdown);

        // Update countdown every 100ms for smooth updates
        countdownInterval = setInterval(() => {
            const elapsed = Date.now() - recordingStartTime;
            const remaining = Math.max(0, Math.ceil((MAX_RECORDING_TIME - elapsed) / 1000));
            countdown.textContent = remaining + 's';

            // Add pulsing animation when time is running out
            if (remaining <= 3) {
                countdown.style.animation = 'voice-command-pulse 0.5s ease-in-out infinite';
                countdown.style.fontSize = '20px';
            } else if (remaining <= 5) {
                countdown.style.fontSize = '19px';
            }

            if (remaining === 0) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
        }, 100);
    }

    /**
     * Remove countdown from button
     */
    function removeCountdown(button) {
        const countdown = button.querySelector('.voice-command-countdown');
        if (countdown) {
            countdown.remove();
        }
    }

    /**
     * Convert Float32Array to Int16Array
     */
    function float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    /**
     * Convert ArrayBuffer to base64
     */
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    // Export functions to global scope
    window.initializeVoiceCommandButton = initializeVoiceCommandButton;
    window.handleVoiceCommandMessage = handleVoiceCommandMessage;

    console.log('[VoiceCommands] Module loaded');
})();
