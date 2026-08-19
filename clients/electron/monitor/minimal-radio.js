// Minimal Radio - Lightweight audio preview for noise floor monitoring
// Adapted from oldradio/radio.js with only essential audio functionality

// Audio protocol version asked for at connect.
//
// Versions 2 and 3 share the same 21-byte header — timestamp(8) sampleRate(4)
// channels(1) power(4) noise(4) — and differ only in the second signal-quality
// field.  Version 2 carries radiod's noise *density* N0 in dBFS/Hz, so
// `basebandPower - noise` comes out as S/N0 in dB·Hz: about 34 dB above the
// true SNR on a 2.65 kHz filter, and a different amount on every other filter
// width.  Version 3 carries the noise power over the demodulator passband
// instead, which makes the same subtraction an SNR in dB.
//
// This file talks to whatever instance the user picked, not to the build that
// served it, so the default stays at 2: an instance older than 0.1.60 clamps an
// unrecognised version to 1, whose header is 13 bytes with no signal-quality
// fields at all, and parsing that at offset 21 feeds garbage to the Opus
// decoder — audio breaks, not just the meter.  Callers with the instance's
// reported version in hand pass MinimalRadio.protocolVersionFor(v) instead.
//
// Either way this class exposes one scale: `signalSNR` and
// `getSignalQuality().snr` are always a true SNR in dB, because a version 2
// noise density is converted to passband noise power on arrival — see
// _noisePowerFrom() and channelNoisePower in radiod_status.go.
const DEFAULT_PROTOCOL_VERSION = 2;

// The oldest instance release asked for version 3.
//
// Version 3 landed in 0.1.60; the gate sits one release later, so a receiver
// has to be on a build that shipped after it rather than on the one that
// introduced it.  Anything older, and anything that does not report a version
// at all, keeps version 2 — which costs nothing but the wire format, since the
// noise density is converted on arrival either way.
const V3_MIN_INSTANCE_VERSION = [0, 1, 61];

class MinimalRadio {
    constructor(userSessionID = null, baseUrl = null, protocolVersion = DEFAULT_PROTOCOL_VERSION) {
        // Use provided session ID or generate new one
        this.userSessionID = userSessionID || this.generateUserSessionID();

        // Base URL for connecting to remote instances (null = use current host)
        this.baseUrl = baseUrl;

        // Audio protocol version to request (2 or 3 — see above)
        this.protocolVersion = (protocolVersion === 3) ? 3 : DEFAULT_PROTOCOL_VERSION;


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

        // Signal quality metrics (from the audio header — see DEFAULT_PROTOCOL_VERSION)
        this.basebandPower = null;  // Signal power in dBFS over the passband
        this.noisePower = null;     // Noise power in dBFS over the same passband
        this.signalSNR = null;      // Calculated SNR in dB (power - noise)

        // Signal quality display
        this.signalBarElement = null;
        this.signalBarUpdateInterval = null;
        this.signalBarContainer = null; // Container element for positioning

        // Adaptive range tracking for signal bar
        this.signalHistory = [];
        this.signalHistoryMaxSize = 20; // Keep last 20 samples for adaptive range

        // Playback settings
        this.currentFrequency = null;
        this.currentMode = 'usb';
        this.currentVolume = 0.5;
        this.isPlaying = false;

        // Server-side mute.  When true the server substitutes silence for this
        // session's audio instead of us throwing it away at the gain node, which
        // saves the instance the encode and the link the bytes.  Packets keep
        // flowing at full rate, so signal-quality metering is unaffected.
        // Carried into the connect URL (?muted=1) so a session is never audible
        // for the round trip it takes a set_mute message to arrive.
        this.serverMuted = false;
        this._connectMuted = false;  // serverMuted as it was when the URL was built
        
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

    // The protocol version to ask an instance for, given the version string it
    // reports to the collector (`version` on the /api/instances record).
    //
    // Anything unparseable or absent — an instance that predates the field, a
    // page whose API does not carry it — is treated as old and gets version 2.
    // A pre-release of the gate version ("0.1.61-rc1") counts as new enough:
    // the numbers are what matter, and version 3 was already in 0.1.60.
    static protocolVersionFor(instanceVersion) {
        const v = MinimalRadio._parseVersion(instanceVersion);
        if (!v) return DEFAULT_PROTOCOL_VERSION;
        for (let i = 0; i < 3; i++) {
            if (v[i] !== V3_MIN_INSTANCE_VERSION[i]) {
                return v[i] > V3_MIN_INSTANCE_VERSION[i] ? 3 : DEFAULT_PROTOCOL_VERSION;
            }
        }
        return 3;   // exactly the gate version
    }

    // "0.1.61", "v0.1.61", "0.1.61-rc1" → [0, 1, 61].  Null for anything else,
    // including a two-part version, which is deliberately not guessed at.
    static _parseVersion(version) {
        if (typeof version !== 'string') return null;
        const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
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

        // Adjust bandwidth based on mode
        if (this.currentMode === 'cwl' || this.currentMode === 'cwu') {
            this.bandwidthLow  = -200;
            this.bandwidthHigh = 200;
        } else if (this.currentMode === 'lsb') {
            this.bandwidthLow  = -2850;
            this.bandwidthHigh = -50;
        } else {
            this.bandwidthLow  = 50;
            this.bandwidthHigh = 2850;
        }

        console.log(`Starting preview: ${frequency} Hz, ${this.currentMode.toUpperCase()}, BW: ${this.bandwidthLow} to ${this.bandwidthHigh} Hz`);
        
        try {
            await this.connectWebSocket();
            this.isPlaying = true;
            this.startHeartbeat();
            this.startSignalBarUpdates();
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
        
        // Adjust bandwidth based on mode
        if (this.currentMode === 'cwl' || this.currentMode === 'cwu') {
            this.bandwidthLow  = -200;
            this.bandwidthHigh = 200;
        } else if (this.currentMode === 'lsb') {
            this.bandwidthLow  = -2850;
            this.bandwidthHigh = -50;
        } else {
            this.bandwidthLow  = 50;
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

        // Stop signal bar updates
        this.stopSignalBarUpdates();

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

    // Mute/unmute at the server.  Idempotent — repeated calls with the same
    // value send nothing, so this is safe to drive from a per-tick loop.
    // With no socket open the flag is simply remembered: connectWebSocket()
    // carries it in the URL, so a reconnect comes up in the same state.
    setServerMuted(muted) {
        const want = !!muted;
        if (want === this.serverMuted) return;
        this.serverMuted = want;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'set_mute', muted: want }));
        }
    }

    // Get target host and protocol (use baseUrl if set, otherwise current location)
    getTargetHostAndProtocol() {
        if (this.baseUrl) {
            const url = new URL(this.baseUrl);
            return { host: url.host, protocol: url.protocol };
        }
        return { host: window.location.host, protocol: window.location.protocol };
    }

    // Connect to WebSocket
    async connectWebSocket() {
        try {
            // Determine host to connect to
            const { host: targetHost, protocol: targetProtocol } = this.getTargetHostAndProtocol();

            // Check connection permission (only if not already validated)
            if (!this.connectionValidated) {
                const httpProtocol = targetProtocol === 'https:' ? 'https:' : 'http:';
                const connectionUrl = `${httpProtocol}//${targetHost}/connection`;
                
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
                    
                    const errorMsg = errorData.reason || 'Server rejected connection';
                    console.warn('Connection not allowed:', response.status, errorMsg);
                    const err = new Error(errorMsg);
                    err.connectionRejected = true;
                    throw err;
                }
                
                const result = await response.json();
                console.log('Connection check result:', result);
                
                // Validate that connection is allowed
                if (!result.allowed) {
                    const errorMsg = result.reason || 'Connection not allowed by server';
                    console.warn('Connection not allowed by server:', errorMsg);
                    const err = new Error(errorMsg);
                    err.connectionRejected = true;
                    throw err;
                }
                
                // Mark as validated so we don't check again
                this.connectionValidated = true;

                // Store session time limit (0 = unlimited)
                this.maxSessionTime = result.max_session_time || 0;
            }
            
            // Create WebSocket connection with Opus format and the negotiated
            // signal-quality protocol version (see DEFAULT_PROTOCOL_VERSION)
            // Determine host and protocol (reuse from earlier in function)
            const { host: wsHost, protocol: wsProtocol } = this.getTargetHostAndProtocol();
            const protocol = wsProtocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${protocol}//${wsHost}/ws?frequency=${this.currentFrequency}&mode=${this.currentMode}&user_session_id=${encodeURIComponent(this.userSessionID)}&format=opus&version=${this.protocolVersion}`;
            this._connectMuted = this.serverMuted;
            if (this._connectMuted) wsUrl += '&muted=1';

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log(`WebSocket connected (Opus format, protocol version ${this.protocolVersion})`);
                this.sendTuneCommand();
                // Re-assert the mute state unless we asked for audio and still
                // want it.  Two reasons: the state can change while the socket
                // is handshaking, and instances older than the ?muted= param
                // silently ignore it — for those this message is the only thing
                // that mutes them (one round trip later than we'd like, which
                // the volume gain covers).  Both are no-ops on a current
                // instance that already read the URL.
                if (this.serverMuted || this._connectMuted) {
                    this.ws.send(JSON.stringify({ type: 'set_mute', muted: this.serverMuted }));
                    this._connectMuted = this.serverMuted;
                }
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
            case 'mute_updated':
                // Echo of our own set_mute — we already track the state locally.
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }
    
    // Convert the header's noise field to noise power over the demodulator
    // passband, which is what makes `basebandPower - noise` an SNR in dB.
    //
    // Version 3 sends that figure already.  Version 2 sends the density N0 in
    // dBFS/Hz, so the bandwidth term has to be added here — the same
    // `N0 + 10·log10(BW)` the server applies in channelNoisePower(), over the
    // filter width we asked for in the tune command.  radiod may round that
    // width to a bin edge, which moves the result by well under a dB.
    //
    // A missing reading (-999) and an unusable bandwidth both come back as
    // "no data": returning the density unchanged would be silently wrong by
    // tens of dB, which is worse than reporting nothing.
    _noisePowerFrom(noise) {
        if (!(noise > -900)) return noise;
        if (this.protocolVersion >= 3) return noise;
        const bandwidth = Math.abs(this.bandwidthHigh - this.bandwidthLow);
        if (!(bandwidth > 0)) return -999;
        return noise + 10 * Math.log10(bandwidth);
    }

    // Handle binary Opus audio messages (version 2/3 protocol)
    async handleBinaryMessage(data) {
        try {
            // Convert Blob to ArrayBuffer if needed
            let arrayBuffer;
            if (data instanceof Blob) {
                arrayBuffer = await data.arrayBuffer();
            } else {
                arrayBuffer = data;
            }

            // Parse binary Opus packet header - version 2/3 layout
            // Format: [timestamp:8][sampleRate:4][channels:1][basebandPower:4][noise:4][opusData...]
            const view = new DataView(arrayBuffer);

            if (arrayBuffer.byteLength < 21) {
                console.error(`Binary packet too short for version ${this.protocolVersion}:`, arrayBuffer.byteLength, 'bytes (expected ≥21)');
                return;
            }

            // Parse header fields
            const timestamp = view.getBigUint64(0, true);   // 8 bytes, little-endian
            const sampleRate = view.getUint32(8, true);     // 4 bytes, little-endian
            const channels = view.getUint8(12);             // 1 byte
            const basebandPower = view.getFloat32(13, true); // 4 bytes, little-endian
            // Density on version 2, passband power on version 3 — normalised to
            // passband power either way so everything downstream sees one scale.
            const noisePower = this._noisePowerFrom(view.getFloat32(17, true));

            // Store signal quality metrics
            this.basebandPower = basebandPower;
            this.noisePower = noisePower;

            // Calculate SNR if both values are valid (not -999.0)
            if (basebandPower > -900 && noisePower > -900) {
                this.signalSNR = basebandPower - noisePower;
            } else {
                this.signalSNR = null;
            }

            // Opus data starts at byte 21 on version 2/3
            const opusData = new Uint8Array(arrayBuffer, 21);

            // Relay callback — fires before decode so the owner can forward raw Opus bytes
            // without paying the cost of decoding twice. Signal metrics are included so
            // followers can update signal bars and SNR charts from the frame header alone.
            // The noise figure passed on is the normalised one, so a follower's
            // `power - noise` is an SNR whatever version the owner negotiated.
            if (this.onAudioFrame) {
                this.onAudioFrame(sampleRate, channels, basebandPower, noisePower, opusData);
            }

            // Initialize audio context on first binary packet if not already done
            if (!this.audioContext) {
                this.serverSampleRate = sampleRate;
                this.audioBufferCount = 0;
                console.log('Initializing audio context from binary packet:', sampleRate, 'Hz');
                await this.initializeAudio(sampleRate);
            }

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

            // Validate decoded data has samples
            if (decoded.channelData[0].length === 0) {
                console.error('Opus decode returned zero-length samples - stopping playback');
                await this.stopPreview();
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
            // If we get a critical audio error, stop playback
            if (e.message && e.message.includes('createBuffer')) {
                console.error('Critical audio error detected - stopping playback');
                await this.stopPreview();
            }
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
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate, latencyHint: 'playback' });
        } else {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        // Start with larger buffer to allow for smooth start and avoid initial noise
        this.nextPlayTime = this.audioContext.currentTime + 0.5;
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
            // Determine host to connect to
            const { host: targetHost, protocol: targetProtocol } = this.getTargetHostAndProtocol();

            // Check connection permission (only if not already validated)
            if (!this.connectionValidated) {
                const httpProtocol = targetProtocol === 'https:' ? 'https:' : 'http:';
                const connectionUrl = `${httpProtocol}//${targetHost}/connection`;

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

                    const errorMsg = errorData.reason || 'Server rejected connection';
                    console.warn('Spectrum connection not allowed:', response.status, errorMsg);
                    const err = new Error(errorMsg);
                    err.connectionRejected = true;
                    throw err;
                }

                const result = await response.json();
                console.log('Spectrum connection check result:', result);

                if (!result.allowed) {
                    const errorMsg = result.reason || 'Spectrum connection not allowed by server';
                    console.warn('Spectrum connection not allowed by server:', errorMsg);
                    const err = new Error(errorMsg);
                    err.connectionRejected = true;
                    throw err;
                }
                
                // Mark as validated so we don't check again
                this.connectionValidated = true;
            }

            // Create spectrum WebSocket connection with binary8 mode
            const protocol = targetProtocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${protocol}//${targetHost}/ws/user-spectrum?user_session_id=${encodeURIComponent(this.userSessionID)}`;

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

    // Get current signal quality metrics (from the audio header)
    getSignalQuality() {
        return {
            basebandPower: this.basebandPower,  // dBFS over the passband
            noisePower: this.noisePower,        // dBFS over the same passband
            snr: this.signalSNR                 // dB (a true SNR — see DEFAULT_PROTOCOL_VERSION)
        };
    }

    // Check if signal quality data is available
    hasSignalQuality() {
        return this.basebandPower !== null && this.noisePower !== null;
    }

    // Start signal bar updates (100ms interval)
    startSignalBarUpdates() {
        // Stop any existing interval
        this.stopSignalBarUpdates();

        // Update immediately
        this.updateSignalBar();

        // Update every 100ms
        this.signalBarUpdateInterval = setInterval(() => {
            this.updateSignalBar();
        }, 100);
    }

    // Stop signal bar updates
    stopSignalBarUpdates() {
        if (this.signalBarUpdateInterval) {
            clearInterval(this.signalBarUpdateInterval);
            this.signalBarUpdateInterval = null;
        }

        // Remove signal bar element if it exists
        if (this.signalBarElement) {
            // Clean up event listeners if they exist
            if (this.signalBarElement._scrollHandler) {
                window.removeEventListener('scroll', this.signalBarElement._scrollHandler, true);
            }
            if (this.signalBarElement._resizeHandler) {
                window.removeEventListener('resize', this.signalBarElement._resizeHandler);
            }
            // Cancel animation frame if it exists
            if (this.signalBarElement._animationFrameId) {
                cancelAnimationFrame(this.signalBarElement._animationFrameId);
            }

            this.signalBarElement.remove();
            this.signalBarElement = null;
        }

        this.signalBarContainer = null;
    }

    // Update signal bar display
    updateSignalBar() {
        if (!this.isPlaying) {
            console.log('Signal bar update skipped: not playing');
            return;
        }

        if (!this.hasSignalQuality()) {
            console.log('Signal bar update skipped: no signal quality data yet');
            return;
        }

        // Create signal bar element if it doesn't exist
        if (!this.signalBarElement) {
            console.log('Creating signal bar element...');
            this.signalBarElement = this.createSignalBarElement();
            if (!this.signalBarElement) {
                console.error('Failed to create signal bar element');
                return;
            }
        }

        // Update the bar with current signal strength
        const dbfs = this.basebandPower;
        const barFill = this.signalBarElement.querySelector('.signal-bar-fill');
        const barText = this.signalBarElement.querySelector('.signal-bar-text');

        if (barFill && barText) {
            // Add current value to history for smoothing
            this.signalHistory.push(dbfs);
            if (this.signalHistory.length > this.signalHistoryMaxSize) {
                this.signalHistory.shift();
            }

            // Use fixed range: -120 dBFS (weak) to -40 dBFS (strong)
            const minDb = -120;  // Weak signal
            const maxDb = -40;   // Strong signal

            // Calculate percentage
            const percentage = Math.max(0, Math.min(100, ((dbfs - minDb) / (maxDb - minDb)) * 100));

            // Update bar width (this creates the moving bar effect)
            barFill.style.width = percentage + '%';

            // Update bar color based on absolute dBFS value
            if (dbfs > -60) {
                barFill.style.background = 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'; // Green - strong
            } else if (dbfs > -90) {
                barFill.style.background = 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)'; // Yellow - medium
            } else {
                barFill.style.background = 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)'; // Red - weak
            }

            // Update text
            barText.textContent = `${dbfs.toFixed(1)} dBFS`;
        } else {
            console.error('Signal bar elements not found:', { barFill, barText });
        }
    }

    // Create signal bar element
    createSignalBarElement() {
        console.log('Creating signal bar element...');

        const bar = document.createElement('div');
        bar.className = 'signal-strength-bar';
        bar.style.cssText = `
            position: fixed;
            width: 120px;
            height: 18px;
            background: rgba(40, 40, 40, 0.95);
            border: 2px solid rgba(255, 255, 255, 0.5);
            border-radius: 4px;
            overflow: visible;
            font-size: 10px;
            z-index: 10000;
            box-shadow: 0 2px 6px rgba(0,0,0,0.7);
            padding: 2px;
        `;

        const fill = document.createElement('div');
        fill.className = 'signal-bar-fill';
        fill.style.cssText = `
            position: absolute;
            left: 2px;
            top: 2px;
            height: calc(100% - 4px);
            width: 0%;
            background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%);
            border-radius: 2px;
            transition: width 0.3s ease, background 0.3s ease;
            z-index: 1;
        `;

        const text = document.createElement('div');
        text.className = 'signal-bar-text';
        text.style.cssText = `
            position: relative;
            top: 0;
            left: 0;
            right: 0;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            text-shadow: 0 1px 3px rgba(0,0,0,0.9);
            pointer-events: none;
            z-index: 2;
        `;
        text.textContent = '-- dBFS';

        bar.appendChild(fill);
        bar.appendChild(text);

        // Look for the pulsing marker icon (instances.html map)
        // The marker with pulsing animation is the active one
        const markers = document.querySelectorAll('.custom-marker');
        console.log(`Found ${markers.length} custom markers`);

        for (const marker of markers) {
            const pulsingElement = marker.querySelector('[style*="pulse"]');
            if (pulsingElement) {
                console.log('Found pulsing marker, positioning signal bar');
                const rect = marker.getBoundingClientRect();
                bar.style.left = (rect.left + rect.width + 5) + 'px';
                bar.style.top = rect.top + 'px';
                bar.style.display = 'block';
                document.body.appendChild(bar);
                this.signalBarContainer = marker;

                console.log(`Signal bar positioned at (${bar.style.left}, ${bar.style.top})`);

                // Update position on scroll/resize
                this.setupBarPositionTracking(bar, marker);
                return bar;
            }
        }

        console.warn('No pulsing marker found, using fallback position');
        // Fallback: append to body at top-left (visible for debugging)
        bar.style.left = '10px';
        bar.style.top = '10px';
        bar.style.display = 'block';
        document.body.appendChild(bar);
        return bar;
    }

    // Setup position tracking for signal bar (for map markers that can move)
    setupBarPositionTracking(bar, marker) {
        const updatePosition = () => {
            if (!this.isPlaying || !bar.parentElement) {
                return;
            }

            // Re-find the pulsing marker in case DOM was recreated (map refresh)
            const markers = document.querySelectorAll('.custom-marker');
            let activeMarker = null;
            for (const m of markers) {
                const pulsingElement = m.querySelector('[style*="pulse"]');
                if (pulsingElement) {
                    activeMarker = m;
                    break;
                }
            }

            if (activeMarker) {
                const rect = activeMarker.getBoundingClientRect();
                bar.style.left = (rect.left + rect.width + 5) + 'px';
                bar.style.top = rect.top + 'px';
                bar.style.display = 'block';
            } else {
                // No active marker found - hide the bar
                bar.style.display = 'none';
            }
        };

        // Update on scroll, resize, and continuously via animation frame
        const scrollHandler = () => updatePosition();
        const resizeHandler = () => updatePosition();

        window.addEventListener('scroll', scrollHandler, true);
        window.addEventListener('resize', resizeHandler);

        // Also update continuously via requestAnimationFrame to track map panning and DOM changes
        let animationFrameId;
        const continuousUpdate = () => {
            updatePosition();
            if (this.isPlaying && bar.parentElement) {
                animationFrameId = requestAnimationFrame(continuousUpdate);
            }
        };
        animationFrameId = requestAnimationFrame(continuousUpdate);

        // Store handlers and animation frame ID for cleanup
        bar._scrollHandler = scrollHandler;
        bar._resizeHandler = resizeHandler;
        bar._animationFrameId = animationFrameId;
    }
}

// Export for use in other modules
window.MinimalRadio = MinimalRadio;