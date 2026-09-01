// Minimal Radio - Lightweight audio preview for noise floor monitoring

// Audio protocol version asked for at connect.
//
// Version 4 carries the same Opus payload as version 3 and the same meaning for
// the signal-quality pair; what changed is the header in front of it. Version 3
// sent a fixed 21 bytes on every packet — timestamp(8) sampleRate(4)
// channels(1) power(4) noise(4) — of which the last three fields hardly ever
// moved. Version 4 sends a flags byte, a varint timestamp delta, and then only
// the fields that actually changed, with a full resynchronisation whenever the
// mode changes and every five seconds regardless. That averages about 4 bytes
// against 21, which on frames this small is between an eighth and a fifth of
// the whole stream. See pcm_v4_header.go.
//
// Both quality figures are dBFS over the demodulator passband from version 3
// on, which is what makes `basebandPower - noisePower` an SNR in dB. On version
// 2 the same subtraction gave S/N0 in dB·Hz, about 34 dB high on a 2.65 kHz
// filter and a different amount high on every other filter width, which is why
// a threshold set on SSB gated wrongly on CW. See channelNoisePower in
// radiod_status.go.
//
// Safe to hardcode here because this file is served by the instance it talks
// to. The copy under clients/electron/monitor connects to arbitrary remote
// instances and negotiates against the version each one reports instead, since
// asking for a version an instance does not implement is not a clean failure:
// up to and including 0.1.62 the server silently clamps it to 1, whose header
// is 13 bytes with no signal-quality fields at all, and only from 0.1.63 is the
// connection refused outright.
const PROTOCOL_VERSION = 4;

// Everything below shares one lexical scope with whatever else the page loads:
// this is a plain script, so a top-level `const` here and a top-level `const` of
// the same name in band_activity.html would be a redeclaration that stops both
// scripts from parsing. Hence the MR_ prefix — band_activity.html already
// declares its own SPEC_POPCOUNT, which is exactly the collision this avoids.

// Version 4 Opus header flags. They live in the LOW bits deliberately: an Opus
// frame carries no magic, and frames are sorted by elimination — a version 4
// PCM magic, else Opus — so the two must not be able to collide. They cannot:
// the PCM magic's first byte is 0x50, which has bit 4 set, while a flags byte
// using only bits 0 and 1 never exceeds 0x03.
const MR_OPUS_V4_QUALITY = 1 << 0;
const MR_OPUS_V4_METADATA = 1 << 1;

// "PCM4" little-endian, the magic on a version 4 lossless frame.
const MR_PCM_V4_MAGIC = 0x344d4350;

// Signal quality travels as signed centidecibels, with one codepoint reserved
// for "radiod reported nothing" — the -999 sentinel cannot be represented,
// since -99900 overflows an int16.
const MR_QUALITY_NO_READING = -32768;

// dB from a centidecibel reading, or null where there was no reading.
function mrQualityDb(v) {
    return v === MR_QUALITY_NO_READING ? null : v / 100;
}

// LEB128, as Go's binary.PutUvarint writes it. Returns [value, nextOffset], or
// null for a varint that runs off the end of the frame.
function mrUvarint(u8, off) {
    let x = 0, s = 0;
    for (let i = off; i < u8.length && i < off + 10; i++) {
        const b = u8[i];
        if (b < 0x80) return [x + b * Math.pow(2, s), i + 1];
        x += (b & 0x7f) * Math.pow(2, s);
        s += 7;
    }
    return null;
}

// The signed form, as binary.PutVarint writes it: zigzag over the above. The
// halving is arithmetic rather than a shift because a timestamp delta is not
// promised to fit in the 32 bits a shift would truncate it to.
function mrVarint(u8, off) {
    const r = mrUvarint(u8, off);
    if (!r) return null;
    const u = r[0];
    return [(u % 2 === 0) ? u / 2 : -(u + 1) / 2, r[1]];
}

// Whether a binary frame is a version 4 lossless PCM packet rather than Opus.
// Both arrive on the same socket, because the server picks the format per
// packet and forces PCM in IQ modes whatever was negotiated.
function mrIsPCMv4Frame(buffer) {
    if (buffer.byteLength < 5) return false;
    return new DataView(buffer).getUint32(0, true) === MR_PCM_V4_MAGIC;
}

// Popcount of a byte, for the version 2 spectrum delta: its mask has to be
// counted in full before a single bin is touched, and a bit at a time cost more
// than the apply itself.
const MR_POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) MR_POPCOUNT[i] = MR_POPCOUNT[i >> 1] + (i & 1);

// Spectrum wire protocol version asked for at connect. Frames are
// self-describing and parseBinarySpectrum reads both, so a server too old to
// know the parameter simply keeps sending version 1.
const MR_SPECTRUM_VERSION = 2;

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

        // Version 4 header state. Stateful by design: a packet carries only
        // what changed since the last one, so this must be cleared whenever a
        // socket is opened — what the previous session announced does not
        // describe this one.
        this._resetOpusHeaderState();

        // Playback settings
        this.currentFrequency = null;
        this.currentMode = 'usb';
        this.currentVolume = 0.5;
        this.isPlaying = false;

        // SNR squelch gate
        // snrSquelchThreshold: -999 = disabled, otherwise minimum SNR in dB
        this.snrSquelchThreshold = -999;
        this._squelchOpen = true;   // current gate state (open = audio passes)
        this._squelchHysteresis = 2; // dB hysteresis to prevent chatter
        
        // Bandwidth settings (will be adjusted based on mode)
        this.bandwidthLow = 50;
        this.bandwidthHigh = 2850;
        
        // Spectrum WebSocket state
        this.spectrumWs = null;
        this.spectrumConnected = false;
        this.spectrumCallback = null;
        this.spectrumConfig = null; // Store spectrum config (centerFreq, binCount, etc.)
        this.binarySpectrumData8 = null; // Wire codes the deltas are applied to
        this.spectrumScale = null;       // { ref, step } from the last version 2 full frame

        // Signal quality metrics (from the version 4 protocol header)
        this.signalQuality = null;
        this.signalQualityCallback = null;

        // External analysers that should be connected to audio
        this.externalAnalysers = [];

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

        // Adjust bandwidth based on mode
        this.setBandwidthForMode(this.currentMode);

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
        
        // Adjust bandwidth based on mode
        this.setBandwidthForMode(this.currentMode);
        
        // Send new tune command without reconnecting
        this.sendTuneCommand();
    }
    
    // Set bandwidth based on mode
    setBandwidthForMode(mode) {
        switch (mode.toLowerCase()) {
            case 'lsb':
                this.bandwidthLow = -2850;
                this.bandwidthHigh = -50;
                break;
            case 'usb':
                this.bandwidthLow = 50;
                this.bandwidthHigh = 2850;
                break;
            case 'am':
                // AM uses symmetric bandwidth around carrier
                this.bandwidthLow = -5000;
                this.bandwidthHigh = 5000;
                break;
            case 'fm':
                // FM uses wider bandwidth
                this.bandwidthLow = -8000;
                this.bandwidthHigh = 8000;
                break;
            case 'cw':
            case 'cwu':
            case 'cwl':
                // CW is centered on the dial frequency, not offset like
                // USB/LSB — matches the main receiver's symmetric ±500 Hz
                // default (see combinedValueToLowHigh in app.js).
                this.bandwidthLow = -500;
                this.bandwidthHigh = 500;
                break;
            default:
                // Default to USB bandwidth
                this.bandwidthLow = 50;
                this.bandwidthHigh = 2850;
                break;
        }
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
        this._resetOpusHeaderState();

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
    }

    // Set SNR squelch threshold.
    // threshold: -999 (or any value <= -998) = disabled (gate always open)
    //            otherwise: minimum SNR in dB required for audio to pass
    setSNRSquelch(threshold) {
        this.snrSquelchThreshold = threshold;
        if (threshold <= -998) {
            // Gate disabled — always open
            this._squelchOpen = true;
        }
        // Gate state will be re-evaluated on the next audio buffer via _evaluateSquelch()
    }

    // Evaluate squelch gate against current signal quality.
    // Returns true if audio should pass (gate open), false if muted.
    _evaluateSquelch() {
        const t = this.snrSquelchThreshold;
        if (t <= -998) return true; // disabled

        const sq = this.signalQuality;
        if (!sq || sq.snr === null || sq.snr === undefined) return true; // no data → open

        const snr = sq.snr;
        if (this._squelchOpen) {
            // Gate is open: close it if SNR drops below threshold
            if (snr < t) {
                this._squelchOpen = false;
            }
        } else {
            // Gate is closed: open it if SNR rises above threshold + hysteresis
            if (snr >= t + this._squelchHysteresis) {
                this._squelchOpen = true;
            }
        }
        return this._squelchOpen;
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
            
            // Create WebSocket connection with Opus format and the current
            // protocol version (for signal quality metrics)
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${this.currentFrequency}&mode=${this.currentMode}&user_session_id=${encodeURIComponent(this.userSessionID)}&format=opus&version=${PROTOCOL_VERSION}`;

            // The header decoder tracks what the peer has told it, and this
            // socket has been told nothing yet — including on the reconnect
            // path below, where the server starts a fresh encoder.
            this._resetOpusHeaderState();

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
            // There is no 'signal_quality' case: that reading has never
            // travelled as a text message, it rides the binary header, and the
            // case that used to be here called a handleSignalQuality() this
            // class does not define — so it could only ever have thrown.

            case 'error':
                console.error('Server error:', message.error);
                break;
            case 'pong':
                // Keepalive response
                break;
            default:
                // Unhandled message types are silently ignored
                break;
        }
    }

    // Set callback for signal quality updates
    onSignalQuality(callback) {
        this.signalQualityCallback = callback;
    }

    // Get latest signal quality metrics: { basebandPower, noisePower, snr }, all
    // in dB/dBFS, with snr a true SNR (see PROTOCOL_VERSION).
    getSignalQuality() {
        return this.signalQuality;
    }

    // Check if signal quality data is available
    hasSignalQuality() {
        return this.signalQuality !== null &&
               this.signalQuality.basebandPower !== null &&
               this.signalQuality.noisePower !== null;
    }

    // Clear what the version 4 header decoder has been told. A fresh socket
    // gets a fresh encoder on the server, so this has to run in step with one.
    _resetOpusHeaderState() {
        this._opusHeader = {
            haveMetadata: false,
            sampleRate: 0,
            channels: 1,
            power: MR_QUALITY_NO_READING,
            noise: MR_QUALITY_NO_READING,
            timestamp: 0
        };
    }

    // Decode the version 4 header at the front of an Opus frame, returning
    // { bodyOffset, sampleRate, channels, basebandPower, noisePower, timestamp }
    // or null for a frame that cannot be read — including one that arrives
    // before any resynchronisation point, which is what joining a stream
    // part-way through looks like. The five-second resync is what ends that.
    //
    // The mirror of AppendOpusHeader in pcm_v4_header.go, and a copy of
    // OpusV4HeaderDecoder in static/v2/src/radio/pcm-v4.js, which is the same
    // decoder for the v2 bundle. This is a plain script with no build step and
    // cannot import from there, so a change to the format has to be made in
    // both places; pcm-v4.js is the one to change first.
    _decodeOpusHeader(buffer) {
        const u8 = new Uint8Array(buffer);
        const view = new DataView(buffer);
        if (u8.length < 2) return null;

        const flags = u8[0];
        if (flags & ~(MR_OPUS_V4_QUALITY | MR_OPUS_V4_METADATA)) return null;

        const state = this._opusHeader;
        let off = 1;
        let timestamp = state.timestamp;

        // The metadata bit marks a resynchronisation, which is also what
        // carries a full timestamp; the two never differ.
        if (flags & MR_OPUS_V4_METADATA) {
            if (off + 8 > u8.length) return null;
            timestamp = Number(view.getBigUint64(off, true));
            off += 8;
        } else {
            if (!state.haveMetadata) return null;
            const d = mrVarint(u8, off);
            if (!d) return null;
            timestamp += d[0];
            off = d[1];
        }

        if (flags & MR_OPUS_V4_METADATA) {
            const r = mrUvarint(u8, off);
            if (!r) return null;
            state.sampleRate = r[0];
            off = r[1];
            if (off >= u8.length) return null;
            state.channels = u8[off++] || 1;
            state.haveMetadata = true;
        }

        if (flags & MR_OPUS_V4_QUALITY) {
            if (off + 4 > u8.length) return null;
            state.power = view.getInt16(off, true);
            state.noise = view.getInt16(off + 2, true);
            off += 4;
        }

        if (!state.sampleRate) return null;
        state.timestamp = timestamp;

        return {
            bodyOffset: off,
            sampleRate: state.sampleRate,
            channels: state.channels,
            basebandPower: mrQualityDb(state.power),
            noisePower: mrQualityDb(state.noise),
            timestamp: timestamp
        };
    }

    // Handle binary Opus audio messages (version 2+ protocol)
    async handleBinaryMessage(data) {
        try {
            // Convert Blob to ArrayBuffer if needed
            let arrayBuffer;
            if (data instanceof Blob) {
                arrayBuffer = await data.arrayBuffer();
            } else {
                arrayBuffer = data;
            }

            // Sort the frame before parsing it. The server picks the format per
            // packet, so a session that negotiated Opus is sent lossless PCM the
            // moment it tunes to IQ, and always if the server was built without
            // libopus. This class decodes Opus only; the four-byte magic is what
            // tells the two apart, and it cannot false-positive on an Opus frame
            // (see MR_OPUS_V4_QUALITY).
            if (mrIsPCMv4Frame(arrayBuffer)) {
                console.warn('Ignoring lossless PCM frame: MinimalRadio decodes Opus only');
                return;
            }

            // Version 4 header: variable length, carrying only what changed
            // since the last packet, so where the Opus payload begins has to be
            // parsed rather than assumed. Slicing at version 3's fixed offset
            // would not fail loudly — it would feed the decoder a few bytes of
            // audio as though they were metadata, which sounds like noise
            // rather than like an error.
            const header = this._decodeOpusHeader(arrayBuffer);
            if (!header) {
                console.error('Unreadable version 4 Opus header:', arrayBuffer.byteLength, 'bytes');
                return;
            }
            const sampleRate = header.sampleRate;
            const channels = header.channels;

            // Store signal quality metrics.  Both fields are dBFS over the
            // demodulator passband from version 3 on, so the subtraction is an
            // SNR in dB; either is null when radiod had no status to report.
            const basebandPower = header.basebandPower;
            const noisePower = header.noisePower;
            this.signalQuality = {
                basebandPower: basebandPower,
                noisePower: noisePower,
                snr: (basebandPower !== null && noisePower !== null) ? basebandPower - noisePower : null,
                timestamp: header.timestamp
            };

            // Call callback if registered
            if (this.signalQualityCallback) {
                this.signalQualityCallback(this.signalQuality);
            }

            const opusData = new Uint8Array(arrayBuffer, header.bodyOffset);

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
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate, latencyHint: 'playback' });
        } else {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
        }
        
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        
        // Start with buffer to allow for smooth start
        this.nextPlayTime = this.audioContext.currentTime + 0.2;
        this.audioStartTime = this.audioContext.currentTime;
        
        console.log('Audio context initialized:', this.audioContext.sampleRate, 'Hz');
    }
    
    // Add an external analyser to be connected to audio
    addAnalyser(analyser) {
        if (!this.externalAnalysers.includes(analyser)) {
            this.externalAnalysers.push(analyser);
        }
    }

    // Remove an external analyser
    removeAnalyser(analyser) {
        const index = this.externalAnalysers.indexOf(analyser);
        if (index > -1) {
            this.externalAnalysers.splice(index, 1);
        }
    }

    // Play audio buffer
    playAudioBuffer(buffer) {
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        
        const gainNode = this.audioContext.createGain();
        source.connect(gainNode);
        
        // Connect to external analysers if any
        if (this.externalAnalysers && this.externalAnalysers.length > 0) {
            for (const analyser of this.externalAnalysers) {
                source.connect(analyser);
            }
        }
        
        gainNode.connect(this.audioContext.destination);
        
        const currentTime = this.audioContext.currentTime;
        const bufferAhead = this.nextPlayTime - currentTime;
        
        // Reset if buffer is too low (after first few buffers)
        const needsReset = this.audioBufferCount >= 3 && (this.nextPlayTime < currentTime || bufferAhead < 0.05);

        // Evaluate SNR squelch gate — 0 if gated (muted), currentVolume if open
        const gateOpen = this._evaluateSquelch();
        const targetVolume = gateOpen ? this.currentVolume : 0;
        
        // Fade in on first buffer
        if (this.audioBufferCount === 0) {
            const FADE_TIME = 0.5;
            const fadeStartTime = Math.max(this.nextPlayTime, currentTime);
            gainNode.gain.setValueAtTime(0, fadeStartTime);
            gainNode.gain.linearRampToValueAtTime(targetVolume, fadeStartTime + FADE_TIME);
        } else if (needsReset) {
            // Quick fade out/in on reset
            const FADE_TIME = 0.01;
            gainNode.gain.setValueAtTime(targetVolume, currentTime);
            gainNode.gain.linearRampToValueAtTime(0, currentTime + FADE_TIME);
            
            this.nextPlayTime = currentTime + FADE_TIME + 0.05;
            gainNode.gain.setValueAtTime(0, this.nextPlayTime);
            gainNode.gain.linearRampToValueAtTime(targetVolume, this.nextPlayTime + FADE_TIME);
            
            console.log('Audio buffer reset');
        } else {
            // Normal playback — apply a short ramp so squelch open/close doesn't click
            const SQUELCH_RAMP = 0.02;
            gainNode.gain.setValueAtTime(gainNode.gain.value, currentTime);
            gainNode.gain.linearRampToValueAtTime(targetVolume, currentTime + SQUELCH_RAMP);
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

            // Request binary8 mode for maximum bandwidth reduction (8-bit
            // encoding), and version 2 of the frame format on top of it — a
            // change mask instead of an index per changed bin, and a
            // quantisation scale derived from the data rather than a fixed
            // 1 dB step over a 256 dB window. Measured on real frames that is
            // about 2.15x smaller for the same content; see user_spectrum_v2.go.
            wsUrl += `&mode=binary8&version=${MR_SPECTRUM_VERSION}`;

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

    // Parse a binary "SPEC" spectrum frame.
    //
    // Both versions arrive here. Frames are self-describing, and a server too
    // old to understand the version parameter keeps sending version 1 whatever
    // was asked for:
    //
    //   v1 (22-byte header)
    //     0x03 full  : [code u8 × n]                       dB = code - 256
    //     0x04 delta : [count u16][index u16, value u8] × count
    //   v2 (24-byte header, two more for a sequence number)
    //     0x05 full  : [refCentiDB i16][stepCentiDB u8][code u8 × n]
    //     0x06 delta : [mask ⌈n/8⌉ bytes][value u8 per set bit]
    //                                            dB = (ref + code × step) / 100
    //
    // Version 2's scale travels with each full frame rather than being fixed,
    // so the resolution follows the data instead of spending more than half a
    // 256 dB window on decibels the bins never occupy. A delta never restates
    // it: the scale may only change on a full frame.
    //
    // THIS IS A COPY. The canonical definition of the format — header layout,
    // both versions, the change mask, the scale arithmetic — is
    // static/v2/src/lib/specFrame.js, which the v2 bundle's waterfall and band
    // panel both import, and band_activity.html carries a second copy for the
    // same reason this one exists: a plain page with no build step cannot
    // import from there. specFrame.js is the one to change first.
    parseBinarySpectrum(view) {
        const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (u8.length < 22) return null;

        const version = u8[4];
        const flags = u8[5];
        if (version !== 0x01 && version !== 0x02) {
            console.error('Unsupported binary protocol version:', version);
            return null;
        }

        // Version 2 puts a sequence number at offset 6 and pushes everything
        // after it along by two.
        const headerLen = version === 0x02 ? 24 : 22;
        if (u8.length < headerLen) return null;
        const tsOffset = version === 0x02 ? 8 : 6;
        const timestamp = Number(view.getBigUint64(tsOffset, true)); // little-endian
        const frequency = Number(view.getBigUint64(tsOffset + 8, true)); // little-endian

        if (!this._applySpectrumFrame(flags, u8.subarray(headerLen))) return null;

        // Codes to dBFS. Version 1 has no scale of its own, which is what the
        // null case below stands for.
        const codes = this.binarySpectrumData8;
        const scale = this.spectrumScale;
        const spectrumData = new Float32Array(codes.length);
        for (let i = 0; i < codes.length; i++) {
            spectrumData[i] = scale ? (scale.ref + codes[i] * scale.step) / 100 : codes[i] - 256;
        }

        // Return in same format as JSON messages
        return {
            type: 'spectrum',
            data: Array.from(spectrumData),
            frequency: frequency,
            timestamp: timestamp
        };
    }

    // Fold one frame's body into the accumulated codes, returning whether they
    // can now be read. A frame is dropped whole rather than applied part way:
    // half-updated bins would stay wrong until the next full frame.
    _applySpectrumFrame(flags, body) {
        if (flags === 0x05) {
            // Version 2 full frame: [refCentiDB i16][stepCentiDB u8][codes...]
            if (body.length < 3) return false;
            const step = body[2];
            if (step === 0) return false;
            const ref = ((body[0] | (body[1] << 8)) << 16) >> 16;
            const binCount = body.length - 3;
            this.spectrumScale = { ref: ref, step: step };
            if (!this.binarySpectrumData8 || this.binarySpectrumData8.length !== binCount) {
                this.binarySpectrumData8 = new Uint8Array(binCount);
            }
            this.binarySpectrumData8.set(body.subarray(3));
            return true;
        }

        if (flags === 0x06) {
            // Version 2 delta: one bit per bin, then one value byte per set
            // bit. The count is implied, so a length that disagrees with the
            // mask is malformed. Stray bits past binCount in the trailing byte
            // are counted here — with the value bytes they imply — and then
            // never applied.
            const codes = this.binarySpectrumData8;
            if (!codes || !this.spectrumScale) {
                console.error('Spectrum delta frame received before a full frame');
                return false;
            }
            const n = codes.length;
            const maskLen = (n + 7) >> 3;
            if (body.length < maskLen) return false;
            let expected = 0;
            for (let b = 0; b < maskLen; b++) expected += MR_POPCOUNT[body[b]];
            if (body.length !== maskLen + expected) return false;

            // Byte-wise, because a quiet delta's mask is mostly zero bytes and
            // each one skipped is eight bins never looked at. Within a byte,
            // peel set bits low to high — `m & -m` isolates the lowest, clz32
            // names it, `m &= m - 1` clears it — the order they were packed in.
            let vi = maskLen;
            const whole = n >> 3;
            for (let b = 0; b < whole; b++) {
                let m = body[b];
                if (m === 0) continue;
                const base = b << 3;
                do {
                    codes[base + (31 - Math.clz32(m & -m))] = body[vi++];
                    m &= m - 1;
                } while (m);
            }
            if (whole < maskLen) {
                let m = body[whole] & ((1 << (n & 7)) - 1);
                const base = whole << 3;
                while (m) {
                    codes[base + (31 - Math.clz32(m & -m))] = body[vi++];
                    m &= m - 1;
                }
            }
            return true;
        }

        if (flags === 0x03) {
            // Version 1 full frame (uint8) — binary8 format
            const binCount = body.length;
            if (!this.binarySpectrumData8 || this.binarySpectrumData8.length !== binCount) {
                this.binarySpectrumData8 = new Uint8Array(binCount);
            }
            this.binarySpectrumData8.set(body);
            // The fixed -256..0 dB mapping applies; a scale left over from a
            // version 2 stream would be wrong.
            this.spectrumScale = null;
            return true;
        }

        if (flags === 0x04) {
            // Version 1 delta (uint8) — [count u16] then index/value triples
            const codes = this.binarySpectrumData8;
            if (!codes) {
                console.error('Binary8 delta frame received before full frame');
                return false;
            }
            if (body.length < 2) return false;
            const count = body[0] | (body[1] << 8);
            if (2 + count * 3 > body.length) return false;
            for (let i = 0; i < count; i++) {
                const off = 2 + i * 3;
                const idx = body[off] | (body[off + 1] << 8);
                if (idx < codes.length) codes[idx] = body[off + 2];
            }
            return true;
        }

        console.error('Unknown binary frame flags:', flags);
        return false;
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
        // The accumulator and the scale describe the stream that just ended.
        this.binarySpectrumData8 = null;
        this.spectrumScale = null;
    }
}

// Export for use in other modules
window.MinimalRadio = MinimalRadio;