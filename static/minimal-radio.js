// Minimal Radio - Lightweight audio preview for noise floor monitoring
// Adapted from oldradio/radio.js with only essential audio functionality

class MinimalRadio {
    constructor(userSessionID = null) {
        // Use provided session ID or generate new one
        this.userSessionID = userSessionID || this.generateUserSessionID();
        
        // Audio state
        this.ws = null;
        this.audioContext = null;
        this.nextPlayTime = 0;
        this.audioStartTime = 0;
        this.serverSampleRate = null;
        this.audioBufferCount = 0;
        
        // Opus decoder state
        this.opusDecoder = null;
        this.opusDecoderInitialized = false;
        this.opusDecoderSampleRate = null;
        this.opusDecoderChannels = null;

        // Playback settings
        this.currentFrequency = null;
        this.currentMode = 'usb';
        this.currentVolume = 0.5;
        this.isPlaying = false;
        
        // Fixed bandwidth for preview (2800 Hz)
        this.bandwidthLow = 50;
        this.bandwidthHigh = 2850;
        
        // Spectrum WebSocket state
        this.spectrumWs = null;
        this.spectrumConnected = false;
        this.spectrumCallback = null;
        this.spectrumConfig = null; // Store spectrum config (centerFreq, binCount, etc.)
        this.binarySpectrumData8 = null; // State for binary8 delta decoding
        
        // Heartbeat timer
        this.heartbeatInterval = null;
        
        // Connection validation cache (avoid duplicate /connection checks)
        this.connectionValidated = false;

        console.log('MinimalRadio initialized, session:', this.userSessionID);
    }
    
    // Start sending periodic heartbeats to keep connections alive
    startHeartbeat() {
        // Clear any existing interval
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Send heartbeat every 10 seconds
        this.heartbeatInterval = setInterval(() => {
            // Send to audio WebSocket
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
            
            // Send to spectrum WebSocket
            if (this.spectrumWs && this.spectrumWs.readyState === WebSocket.OPEN) {
                this.spectrumWs.send(JSON.stringify({ type: 'ping' }));
            }
        }, 10000);
        
        console.log('Heartbeat started (10s interval)');
    }
    
    // Stop sending heartbeats
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
            console.log('Heartbeat stopped');
        }
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
            this.startHeartbeat();
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

        // Stop heartbeat
        this.stopHeartbeat();

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

        // Reset Opus decoder state
        this.opusDecoder = null;
        this.opusDecoderInitialized = false;
        this.opusDecoderSampleRate = null;
        this.opusDecoderChannels = null;

        // Reset state
        this.serverSampleRate = null;
        this.audioBufferCount = 0;
        this.nextPlayTime = 0;
        this.audioStartTime = 0;

        // Reset connection validation flag for next session
        this.connectionValidated = false;
    }
    
    // Set volume (0.0 to 1.0)
    setVolume(volume) {
        this.currentVolume = Math.max(0, Math.min(1, volume));
        console.log('Volume set to:', Math.round(this.currentVolume * 100) + '%');
    }
    
    // Connect to WebSocket
    async connectWebSocket() {
        try {
            // Check connection permission (only if not already validated)
            if (!this.connectionValidated) {
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
                
                // Mark as validated so we don't check again
                this.connectionValidated = true;
            }
            
            // Create WebSocket connection with Opus format
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${this.currentFrequency}&mode=${this.currentMode}&user_session_id=${encodeURIComponent(this.userSessionID)}&format=opus`;

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected (Opus format)');
                this.sendTuneCommand();
            };

            this.ws.onmessage = async (event) => {
                try {
                    // Check if binary (Opus) or text (JSON)
                    if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                        await this.handleBinaryMessage(event.data);
                    } else {
                        const message = JSON.parse(event.data);
                        this.handleWebSocketMessage(message);
                    }
                } catch (error) {
                    console.error('Failed to process WebSocket message:', error);
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
    
    // Handle binary Opus audio messages
    async handleBinaryMessage(data) {
        if (!this.audioContext) {
            return;
        }

        try {
            // Convert Blob to ArrayBuffer if needed
            let arrayBuffer;
            if (data instanceof Blob) {
                arrayBuffer = await data.arrayBuffer();
            } else {
                arrayBuffer = data;
            }

            // Parse binary packet header (matching Python client format)
            // 8 bytes: timestamp (uint64, little-endian)
            // 4 bytes: sample rate (uint32, little-endian)
            // 1 byte: channels (uint8)
            // remaining: Opus encoded data
            const view = new DataView(arrayBuffer);

            if (arrayBuffer.byteLength < 13) {
                console.error('Binary packet too short:', arrayBuffer.byteLength, 'bytes');
                return;
            }

            const timestamp = view.getBigUint64(0, true); // little-endian
            const sampleRate = view.getUint32(8, true); // little-endian
            const channels = view.getUint8(12);
            const opusData = new Uint8Array(arrayBuffer, 13);

            // Initialize or reinitialize decoder if sample rate or channels changed
            if (!this.opusDecoderInitialized ||
                this.opusDecoderSampleRate !== sampleRate ||
                this.opusDecoderChannels !== channels) {
                const success = await this.initOpusDecoder(sampleRate, channels);
                if (!success) {
                    console.error('Failed to initialize Opus decoder');
                    return;
                }
            }

            // Decode Opus packet to PCM using decodeFrame method
            const decoded = await this.opusDecoder.decodeFrame(opusData);

            if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
                console.error('Opus decode returned empty data');
                return;
            }

            // Create stereo audio buffer from decoded PCM data
            const numChannels = Math.max(2, decoded.channelData.length);
            const audioBuffer = this.audioContext.createBuffer(
                numChannels,
                decoded.channelData[0].length,
                sampleRate
            );

            // Copy decoded data to audio buffer
            if (decoded.channelData.length === 1) {
                // Mono source - duplicate to both channels
                audioBuffer.getChannelData(0).set(decoded.channelData[0]);
                audioBuffer.getChannelData(1).set(decoded.channelData[0]);
            } else {
                // Stereo or multi-channel source
                for (let channel = 0; channel < decoded.channelData.length && channel < 2; channel++) {
                    audioBuffer.getChannelData(channel).set(decoded.channelData[channel]);
                }
            }

            // Play the decoded audio
            this.playAudioBuffer(audioBuffer);

        } catch (e) {
            console.error('Failed to process binary Opus message:', e);
        }
    }

    // Handle audio data (legacy PCM format - kept for compatibility)
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

    // Initialize Opus decoder
    async initOpusDecoder(sampleRate, channels) {
        console.log('initOpusDecoder called:', sampleRate, 'Hz,', channels, 'channels');

        if (this.opusDecoderInitialized) {
            console.log('Decoder already initialized');
            return true;
        }

        // Check if OpusDecoder library is available
        let OpusDecoderClass = null;
        if (typeof OpusDecoder !== 'undefined') {
            OpusDecoderClass = OpusDecoder;
        } else if (window["opus-decoder"] && window["opus-decoder"].OpusDecoder) {
            OpusDecoderClass = window["opus-decoder"].OpusDecoder;
        }

        console.log('Checking for OpusDecoder:', OpusDecoderClass ? 'found' : 'not found');
        if (!OpusDecoderClass) {
            console.error('OpusDecoder library not loaded');
            return false;
        }

        try {
            console.log('Creating OpusDecoder instance...');
            this.opusDecoder = new OpusDecoderClass({
                sampleRate: sampleRate,
                channels: channels
            });
            console.log('Waiting for decoder.ready...');
            await this.opusDecoder.ready;
            this.opusDecoderInitialized = true;
            this.opusDecoderSampleRate = sampleRate;
            this.opusDecoderChannels = channels;
            console.log('Opus decoder initialized successfully');
            return true;
        } catch (e) {
            console.error('Failed to initialize Opus decoder:', e);
            return false;
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

    // Connect to spectrum WebSocket for real-time FFT updates
    async connectSpectrum(band, callback) {
        if (this.spectrumWs && this.spectrumWs.readyState === WebSocket.OPEN) {
            console.log('Spectrum WebSocket already connected');
            return;
        }

        this.spectrumCallback = callback;

        try {
            // Check connection permission (only if not already validated)
            if (!this.connectionValidated) {
                const httpProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
                const connectionUrl = `${httpProtocol}//${window.location.host}/connection`;

                console.log('Checking spectrum connection permission:', connectionUrl);

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

                    console.error('Spectrum connection not allowed:', response.status, errorData);
                    const errorMsg = errorData.reason || 'Server rejected connection';
                    throw new Error(errorMsg);
                }

                const result = await response.json();
                console.log('Spectrum connection check result:', result);

                if (!result.allowed) {
                    const errorMsg = 'Spectrum connection not allowed by server';
                    console.error(errorMsg, result);
                    throw new Error(errorMsg);
                }
                
                // Mark as validated so we don't check again
                this.connectionValidated = true;
            }

            // Create spectrum WebSocket connection with binary8 mode
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${protocol}//${window.location.host}/ws/user-spectrum?user_session_id=${encodeURIComponent(this.userSessionID)}`;

            // Add bypass password if available
            if (window.bypassPassword) {
                wsUrl += `&password=${encodeURIComponent(window.bypassPassword)}`;
            }

            // Request binary8 mode for maximum bandwidth reduction (8-bit encoding)
            wsUrl += `&mode=binary8`;

            console.log('Connecting to spectrum WebSocket:', wsUrl);
            this.spectrumWs = new WebSocket(wsUrl);
            this.spectrumWs.binaryType = 'arraybuffer'; // Enable binary message handling

            this.spectrumWs.onopen = () => {
                console.log('Spectrum WebSocket connected');
                this.spectrumConnected = true;

                // Request spectrum for specific band
                // We'll need to get band config (center freq, bandwidth) from noisefloor config
                // For now, just log that we're connected
            };

            this.spectrumWs.onmessage = async (event) => {
                try {
                    let msg;

                    // Check if message is binary protocol (ArrayBuffer) or JSON
                    if (event.data instanceof ArrayBuffer) {
                        // Binary protocol - check magic header
                        const view = new DataView(event.data);

                        // Check for "SPEC" magic (0x53 0x50 0x45 0x43)
                        if (event.data.byteLength >= 4 &&
                            view.getUint8(0) === 0x53 &&
                            view.getUint8(1) === 0x50 &&
                            view.getUint8(2) === 0x45 &&
                            view.getUint8(3) === 0x43) {

                            // Binary spectrum protocol detected
                            console.log('Binary spectrum protocol detected');

                            // Parse binary spectrum message
                            msg = this.parseBinarySpectrum(view);
                        } else {
                            // Legacy binary (gzipped JSON) - decompress
                            try {
                                const decompressedStream = new Response(
                                    new Blob([event.data]).stream().pipeThrough(new DecompressionStream('gzip'))
                                );
                                const decompressedText = await decompressedStream.text();
                                msg = JSON.parse(decompressedText);
                            } catch (decompressErr) {
                                console.error('Failed to decompress gzip data:', decompressErr);
                                return;
                            }
                        }
                    } else if (event.data instanceof Blob) {
                        // Blob message - convert to ArrayBuffer and check format
                        const arrayBuffer = await event.data.arrayBuffer();
                        const view = new DataView(arrayBuffer);

                        // Check for "SPEC" magic
                        if (arrayBuffer.byteLength >= 4 &&
                            view.getUint8(0) === 0x53 &&
                            view.getUint8(1) === 0x50 &&
                            view.getUint8(2) === 0x45 &&
                            view.getUint8(3) === 0x43) {

                            // Binary spectrum protocol
                            msg = this.parseBinarySpectrum(view);
                        } else {
                            // Legacy gzipped JSON
                            try {
                                const decompressedStream = new Response(
                                    new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
                                );
                                const decompressedText = await decompressedStream.text();
                                msg = JSON.parse(decompressedText);
                            } catch (decompressErr) {
                                console.error('Failed to decompress gzip data:', decompressErr);
                                return;
                            }
                        }
                    } else {
                        // Text message - parse directly
                        msg = JSON.parse(event.data);
                    }

                    if (msg) {
                        this.handleSpectrumMessage(msg);
                    }
                } catch (err) {
                    console.error('Error parsing spectrum message:', err);
                }
            };

            this.spectrumWs.onerror = (error) => {
                console.error('Spectrum WebSocket error:', error);
            };

            this.spectrumWs.onclose = () => {
                console.log('Spectrum WebSocket closed');
                this.spectrumConnected = false;

                // Don't auto-reconnect - let the user control this
            };

        } catch (error) {
            console.error('Failed to connect spectrum WebSocket:', error);
            throw error;
        }
    }

    // Parse binary spectrum message (matching spectrum-display.js)
    parseBinarySpectrum(view) {
        // Parse header (22 bytes)
        const version = view.getUint8(4);
        const flags = view.getUint8(5);
        const timestamp = Number(view.getBigUint64(6, true)); // little-endian
        const frequency = Number(view.getBigUint64(14, true)); // little-endian

        if (version !== 0x01) {
            console.error('Unsupported binary protocol version:', version);
            return null;
        }

        let spectrumData;

        if (flags === 0x03) {
            // Full frame (uint8) - binary8 format
            const binCount = view.byteLength - 22;
            spectrumData = new Float32Array(binCount);

            for (let i = 0; i < binCount; i++) {
                // Convert uint8 to dBFS: 0 = -256 dB, 255 = -1 dB
                const uint8Value = view.getUint8(22 + i);
                spectrumData[i] = uint8Value - 256;
            }

            // Store for delta decoding (as uint8)
            this.binarySpectrumData8 = new Uint8Array(binCount);
            for (let i = 0; i < binCount; i++) {
                this.binarySpectrumData8[i] = view.getUint8(22 + i);
            }

            console.log('Binary8 spectrum frame received:', binCount, 'bins');

        } else if (flags === 0x04) {
            // Delta frame (uint8) - binary8 format
            if (!this.binarySpectrumData8) {
                console.error('Binary8 delta frame received before full frame');
                return null;
            }

            const changeCount = view.getUint16(22, true); // little-endian
            let offset = 24;

            // Apply changes to previous uint8 data
            for (let i = 0; i < changeCount; i++) {
                const index = view.getUint16(offset, true); // little-endian
                const value = view.getUint8(offset + 2); // uint8 value
                this.binarySpectrumData8[index] = value;
                offset += 3; // 2 bytes index + 1 byte value
            }

            // Convert uint8 array to float32 for display
            spectrumData = new Float32Array(this.binarySpectrumData8.length);
            for (let i = 0; i < this.binarySpectrumData8.length; i++) {
                spectrumData[i] = this.binarySpectrumData8[i] - 256;
            }

        } else {
            console.error('Unknown binary frame flags:', flags);
            return null;
        }

        // Return in same format as JSON messages
        return {
            type: 'spectrum',
            data: Array.from(spectrumData),
            frequency: frequency,
            timestamp: timestamp
        };
    }

    // Handle spectrum WebSocket messages
    handleSpectrumMessage(msg) {
        switch (msg.type) {
            case 'config':
                // Store spectrum configuration
                this.spectrumConfig = {
                    centerFreq: msg.centerFreq,
                    binCount: msg.binCount,
                    binBandwidth: msg.binBandwidth,
                    totalBandwidth: msg.totalBandwidth
                };

                console.log('Spectrum config received:', this.spectrumConfig);
                break;

            case 'spectrum':
                // Unwrap FFT bin ordering from radiod
                // radiod sends: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
                // We need: [negative freqs, positive freqs] for low-to-high frequency display
                const rawData = msg.data;
                const N = rawData.length;
                const halfBins = Math.floor(N / 2);

                const unwrappedData = new Float32Array(N);

                // Put second half (negative frequencies) first
                for (let i = 0; i < halfBins; i++) {
                    unwrappedData[i] = rawData[halfBins + i];
                }
                // Put first half (positive frequencies) second
                for (let i = 0; i < halfBins; i++) {
                    unwrappedData[halfBins + i] = rawData[i];
                }

                // Call callback with unwrapped spectrum data
                if (this.spectrumCallback) {
                    this.spectrumCallback({
                        data: unwrappedData,
                        config: this.spectrumConfig,
                        timestamp: msg.timestamp
                    });
                }
                break;

            case 'error':
                console.error('Spectrum server error:', msg.error);
                break;

            case 'pong':
                // Keepalive response
                break;

            default:
                console.warn('Unknown spectrum message type:', msg.type);
        }
    }

    // Disconnect spectrum WebSocket
    disconnectSpectrum() {
        if (this.spectrumWs) {
            console.log('Disconnecting spectrum WebSocket');
            if (this.spectrumWs.readyState === WebSocket.OPEN || this.spectrumWs.readyState === WebSocket.CONNECTING) {
                this.spectrumWs.close();
            }
            this.spectrumWs = null;
        }
        this.spectrumConnected = false;
        this.spectrumCallback = null;
        this.spectrumConfig = null;
    }
}

// Export for use in other modules
window.MinimalRadio = MinimalRadio;