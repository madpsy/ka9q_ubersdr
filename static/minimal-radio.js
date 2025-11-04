// Minimal Radio - Lightweight audio preview for noise floor monitoring
// Adapted from oldradio/radio.js with only essential audio functionality

class MinimalRadio {
    constructor() {
        // Generate unique session ID
        this.userSessionID = this.generateUserSessionID();
        
        // Audio state
        this.ws = null;
        this.audioContext = null;
        this.nextPlayTime = 0;
        this.audioStartTime = 0;
        this.serverSampleRate = null;
        this.audioBufferCount = 0;
        
        // Playback settings
        this.currentFrequency = null;
        this.currentMode = 'usb';
        this.currentVolume = 0.5;
        this.isPlaying = false;
        
        // Fixed bandwidth for preview (2800 Hz)
        this.bandwidthLow = 50;
        this.bandwidthHigh = 2850;
        
        console.log('MinimalRadio initialized, session:', this.userSessionID);
    }
    
    // Generate unique session ID
    generateUserSessionID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    
    // Start audio preview at specified frequency (mode auto-detected)
    async startPreview(frequency, mode = null) {
        if (this.isPlaying) {
            console.log('Already playing, stopping first');
            await this.stopPreview();
        }

        this.currentFrequency = frequency;

        // Auto-detect mode based on frequency if not specified
        // LSB for frequencies below 10 MHz, USB for 10 MHz and above
        if (mode === null) {
            this.currentMode = frequency < 10000000 ? 'lsb' : 'usb';
        } else {
            this.currentMode = mode;
        }

        // Adjust bandwidth for LSB mode
        if (this.currentMode === 'lsb') {
            this.bandwidthLow = -2850;
            this.bandwidthHigh = -50;
        } else {
            this.bandwidthLow = 50;
            this.bandwidthHigh = 2850;
        }

        console.log(`Starting preview: ${frequency} Hz, ${this.currentMode.toUpperCase()}, BW: ${this.bandwidthLow} to ${this.bandwidthHigh} Hz`);
        
        try {
            await this.connectWebSocket();
            this.isPlaying = true;
        } catch (error) {
            console.error('Failed to start preview:', error);
            throw error;
        }
    }
    
    // Change frequency without reconnecting (for hover tuning)
    changeFrequency(frequency, mode = null) {
        this.currentFrequency = frequency;
        
        // Auto-detect mode based on frequency if not specified
        if (mode === null) {
            this.currentMode = frequency < 10000000 ? 'lsb' : 'usb';
        } else {
            this.currentMode = mode;
        }
        
        // Adjust bandwidth for LSB mode
        if (this.currentMode === 'lsb') {
            this.bandwidthLow = -2850;
            this.bandwidthHigh = -50;
        } else {
            this.bandwidthLow = 50;
            this.bandwidthHigh = 2850;
        }
        
        // Send new tune command without reconnecting
        this.sendTuneCommand();
    }
    
    // Stop audio preview
    async stopPreview() {
        console.log('Stopping preview');
        this.isPlaying = false;
        
        // Close WebSocket
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }
        
        // Close audio context
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
        
        // Reset state
        this.serverSampleRate = null;
        this.audioBufferCount = 0;
        this.nextPlayTime = 0;
        this.audioStartTime = 0;
    }
    
    // Set volume (0.0 to 1.0)
    setVolume(volume) {
        this.currentVolume = Math.max(0, Math.min(1, volume));
        console.log('Volume set to:', Math.round(this.currentVolume * 100) + '%');
    }
    
    // Connect to WebSocket
    async connectWebSocket() {
        try {
            // Check connection permission
            const httpProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
            const connectionUrl = `${httpProtocol}//${window.location.host}/connection`;
            
            console.log('Checking connection permission:', connectionUrl);
            
            const response = await fetch(connectionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_session_id: this.userSessionID })
            });
            
            if (!response.ok) {
                let errorData;
                try {
                    errorData = await response.json();
                } catch (e) {
                    errorData = { reason: 'Server rejected connection' };
                }
                
                console.error('Connection not allowed:', response.status, errorData);
                
                // Show user-friendly error message
                const errorMsg = errorData.reason || 'Server rejected connection';
                alert(`Connection Error: ${errorMsg}`);
                throw new Error(errorMsg);
            }
            
            const result = await response.json();
            console.log('Connection check result:', result);
            
            // Validate that connection is allowed
            if (!result.allowed) {
                const errorMsg = 'Connection not allowed by server';
                console.error(errorMsg, result);
                alert(`Connection Error: ${errorMsg}`);
                throw new Error(errorMsg);
            }
            
            // Create WebSocket connection
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${this.currentFrequency}&mode=${this.currentMode}&user_session_id=${encodeURIComponent(this.userSessionID)}`;
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.sendTuneCommand();
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleWebSocketMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket closed');
                // Only reconnect if we're still supposed to be playing
                // Check again after a small delay to avoid race conditions
                setTimeout(() => {
                    if (this.isPlaying && this.ws === null) {
                        console.log('Reconnecting WebSocket...');
                        this.connectWebSocket();
                    }
                }, 100);
            };
            
        } catch (error) {
            console.error('Failed to connect:', error);
            throw error;
        }
    }
    
    // Send tune command to server
    sendTuneCommand() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const message = {
                type: 'tune',
                frequency: this.currentFrequency,
                mode: this.currentMode,
                bandwidthLow: this.bandwidthLow,
                bandwidthHigh: this.bandwidthHigh
            };
            this.ws.send(JSON.stringify(message));
            // Tune command sent (logging disabled to reduce console spam)
        }
    }
    
    // Handle WebSocket messages
    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'audio':
                this.handleAudioData(message);
                break;
            case 'status':
                // Status updates (optional)
                break;
            case 'error':
                console.error('Server error:', message.error);
                break;
            case 'pong':
                // Keepalive response
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }
    
    // Handle audio data
    async handleAudioData(message) {
        if (!message.data) return;
        
        // Initialize audio context on first audio packet
        if (!this.audioContext && message.sampleRate) {
            this.serverSampleRate = message.sampleRate;
            this.audioBufferCount = 0;
            console.log('Initializing audio context:', this.serverSampleRate, 'Hz');
            await this.initializeAudio(this.serverSampleRate);
            return; // Skip first packet
        }
        
        if (!this.audioContext) return;
        
        try {
            // Decode base64 PCM data
            const binaryString = atob(message.data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Convert big-endian int16 to float
            const numSamples = bytes.length / 2;
            const floatData = new Float32Array(numSamples);
            
            for (let i = 0; i < numSamples; i++) {
                const highByte = bytes[i * 2];
                const lowByte = bytes[i * 2 + 1];
                let sample = (highByte << 8) | lowByte;
                if (sample >= 0x8000) {
                    sample -= 0x10000;
                }
                floatData[i] = sample / 32767.0;
            }
            
            // Create audio buffer
            const audioBuffer = this.audioContext.createBuffer(
                1,
                floatData.length,
                message.sampleRate || this.serverSampleRate || 12000
            );
            audioBuffer.getChannelData(0).set(floatData);
            
            this.playAudioBuffer(audioBuffer);
            
        } catch (error) {
            console.error('Failed to process audio data:', error);
        }
    }
    
    // Initialize audio context
    async initializeAudio(sampleRate) {
        if (sampleRate) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate });
        } else {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        
        // Start with buffer to allow for smooth start
        this.nextPlayTime = this.audioContext.currentTime + 0.2;
        this.audioStartTime = this.audioContext.currentTime;
        
        console.log('Audio context initialized:', this.audioContext.sampleRate, 'Hz');
    }
    
    // Play audio buffer
    playAudioBuffer(buffer) {
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        
        const gainNode = this.audioContext.createGain();
        source.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        const currentTime = this.audioContext.currentTime;
        const bufferAhead = this.nextPlayTime - currentTime;
        
        // Reset if buffer is too low (after first few buffers)
        const needsReset = this.audioBufferCount >= 3 && (this.nextPlayTime < currentTime || bufferAhead < 0.05);
        
        // Fade in on first buffer
        if (this.audioBufferCount === 0) {
            const FADE_TIME = 0.5;
            const fadeStartTime = Math.max(this.nextPlayTime, currentTime);
            gainNode.gain.setValueAtTime(0, fadeStartTime);
            gainNode.gain.linearRampToValueAtTime(this.currentVolume, fadeStartTime + FADE_TIME);
        } else if (needsReset) {
            // Quick fade out/in on reset
            const FADE_TIME = 0.01;
            gainNode.gain.setValueAtTime(this.currentVolume, currentTime);
            gainNode.gain.linearRampToValueAtTime(0, currentTime + FADE_TIME);
            
            this.nextPlayTime = currentTime + FADE_TIME + 0.05;
            gainNode.gain.setValueAtTime(0, this.nextPlayTime);
            gainNode.gain.linearRampToValueAtTime(this.currentVolume, this.nextPlayTime + FADE_TIME);
            
            console.log('Audio buffer reset');
        } else {
            // Normal playback
            gainNode.gain.value = this.currentVolume;
        }
        
        this.audioBufferCount++;
        
        source.start(this.nextPlayTime);
        this.nextPlayTime += buffer.duration;
    }
}

// Export for use in other modules
window.MinimalRadio = MinimalRadio;