// Decoder Extension System for ka9q UberSDR
// Provides a unified interface for adding signal decoders (CW, WWV, RTTY, PSK31, FT8, etc.)
// Version: 2024-10-29-fix-bandwidth-race-condition

// ============================================================================
// Radio API - Provides radio state and control to decoder extensions
// ============================================================================

class RadioAPI {
    constructor() {
        this.callbacks = new Map();
        // Track mute state ourselves since window.isMuted isn't reliable
        this._muteState = false;
        // Track if we just set mute state (DOM needs time to update)
        this._justSetMute = false;
    }
    
    // === STATE QUERIES ===
    
    getFrequency() {
        const freqInput = document.getElementById('frequency');
        return freqInput ? parseInt(freqInput.value) : 0;
    }
    
    getMode() {
        return window.currentMode || 'usb';
    }
    
    getBandwidth() {
        return {
            low: window.currentBandwidthLow || 50,
            high: window.currentBandwidthHigh || 3000,
            center: (window.currentBandwidthLow + window.currentBandwidthHigh) / 2,
            width: Math.abs(window.currentBandwidthHigh - window.currentBandwidthLow)
        };
    }
    
    getAudioContext() {
        return window.audioContext;
    }
    
    getSampleRate() {
        return window.audioContext ? window.audioContext.sampleRate : 48000;
    }
    getBufferTime() {
        // Get the current audio buffer time in milliseconds
        // This is calculated as: (nextPlayTime - currentTime) * 1000
        if (!window.audioContext || !window.nextPlayTime) {
            return 0;
        }
        const currentTime = window.audioContext.currentTime;
        const bufferAhead = window.nextPlayTime - currentTime;
        return bufferAhead * 1000; // Convert to milliseconds
    }

    
    isConnected() {
        return window.wsManager ? window.wsManager.isConnected() : false;
    }
    
    getSessionId() {
        return window.userSessionID;
    }
    
    getSpectrumDisplay() {
        return window.spectrumDisplay;
    }
    
    getBands() {
        return window.amateurBands || [];
    }
    
    getBookmarks() {
        return window.bookmarks || [];
    }
    
    getBookmarkPositions() {
        return window.bookmarkPositions || [];
    }
    
    // === DX CLUSTER ACCESS ===

    getDXClusterClient() {
        return window.dxClusterClient;
    }

    isDXClusterConnected() {
        return window.dxClusterClient ? window.dxClusterClient.connected : false;
    }

    onDXSpot(callback) {
        // Subscribe to DX spots via the client's onSpot method
        if (!window.dxClusterClient) {
            console.warn('DX Cluster client not available');
            return null;
        }

        // Use the client's built-in subscription mechanism
        return window.dxClusterClient.onSpot(callback);
    }

    onDigitalSpot(callback) {
        // Subscribe to digital mode spots (FT8/FT4/WSPR) via the DX cluster websocket
        if (!window.dxClusterClient) {
            console.warn('DX Cluster client not available');
            return null;
        }

        // Use the client's built-in subscription mechanism for digital spots
        return window.dxClusterClient.onDigitalSpot(callback);
    }

    onCWSpot(callback) {
        // Subscribe to CW spots via the DX cluster websocket
        if (!window.dxClusterClient) {
            console.warn('DX Cluster client not available');
            return null;
        }

        // Use the client's built-in subscription mechanism for CW spots
        return window.dxClusterClient.onCWSpot(callback);
    }

    // === RADIO CONTROLS ===
    
    setFrequency(freq) {
        const freqInput = document.getElementById('frequency');
        if (freqInput) {
            freqInput.value = Math.round(freq);
            if (window.updateBandButtons) window.updateBandButtons(freq);
            if (window.updateURL) window.updateURL();
            
            if (this.isConnected()) {
                if (window.autoTune) window.autoTune();
            } else {
                if (window.connect) window.connect();
            }
            
            this.notifyFrequencyChange(freq);
            return true;
        }
        return false;
    }
    
    adjustFrequency(deltaHz) {
        const currentFreq = this.getFrequency();
        const newFreq = currentFreq + deltaHz;
        return this.setFrequency(newFreq);
    }
    
    setMode(mode, preserveBandwidth = false) {
        if (['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'].includes(mode)) {
            if (window.setMode) {
                window.setMode(mode, preserveBandwidth);
                this.notifyModeChange(mode);
                return true;
            }
        }
        return false;
    }
    
    setBandwidth(low, high) {
        const lowSlider = document.getElementById('bandwidth-low');
        const highSlider = document.getElementById('bandwidth-high');

        if (lowSlider && highSlider) {
            // IMPORTANT: Update slider min/max constraints first if needed
            // This prevents values from being clamped by current mode constraints
            // For example, USB mode has min=0 for low slider, but CW needs negative values
            if (low < parseInt(lowSlider.min)) {
                lowSlider.min = low;
            }
            if (high > parseInt(highSlider.max)) {
                highSlider.max = high;
            }
            
            lowSlider.value = low;
            highSlider.value = high;

            // Update global variables immediately (don't wait for updateBandwidth callback)
            window.currentBandwidthLow = low;
            window.currentBandwidthHigh = high;

            if (window.updateBandwidth) window.updateBandwidth();
            this.notifyBandwidthChange(low, high);
            return true;
        }
        return false;
    }

    // === AUDIO CONTROLS ===

    getMuted() {
        // If we just set mute state, return our tracked state
        // (DOM needs time to update after toggleMute)
        if (this._justSetMute) {
            return this._muteState;
        }

        // Check the actual mute button state in the DOM by reading its text
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            // Button text is '🔇 Unmute' when muted, '🔊 Mute' when not muted
            const isMuted = muteBtn.textContent.includes('Unmute');
            // Sync our internal state with the actual state
            this._muteState = isMuted;
            return isMuted;
        }
        // Fallback to our tracked state if button not found
        return this._muteState;
    }

    setMuted(muted) {
        // Get current state (will use tracked state if we just set it)
        const currentlyMuted = this.getMuted();

        // If already in desired state, nothing to do
        if (currentlyMuted === muted) {
            return true;
        }

        // Need to toggle - use window.toggleMute() which handles everything
        if (window.toggleMute) {
            window.toggleMute();
            // Update our tracked state immediately
            this._muteState = muted;
            // Mark that we just set mute (so getMuted returns tracked state)
            this._justSetMute = true;
            // After 100ms, allow reading from DOM again
            setTimeout(() => {
                this._justSetMute = false;
            }, 100);
            return true;
        }

        return false;
    }

    toggleMute() {
        // Just call window.toggleMute and update our state
        if (window.toggleMute) {
            window.toggleMute();
            // Toggle our tracked state
            this._muteState = !this._muteState;
            // Mark that we just set mute
            this._justSetMute = true;
            setTimeout(() => {
                this._justSetMute = false;
            }, 100);
            return true;
        }
        return false;
    }

    // === AUDIO PROCESSING ===
    
    getAnalyser() {
        return window.analyser;
    }
    
    getVUAnalyser() {
        return window.vuAnalyser;
    }
    
    getAudioBuffer(analyser = null) {
        const activeAnalyser = analyser || this.getAnalyser();
        if (!activeAnalyser) return null;
        
        const bufferLength = activeAnalyser.fftSize;
        const timeData = new Float32Array(bufferLength);
        const freqData = new Uint8Array(activeAnalyser.frequencyBinCount);
        
        activeAnalyser.getFloatTimeDomainData(timeData);
        activeAnalyser.getByteFrequencyData(freqData);
        
        return {
            timeDomain: timeData,
            frequency: freqData,
            sampleRate: this.getSampleRate(),
            fftSize: bufferLength
        };
    }
    
    // === FILTER CONTROLS ===
    
    enableBandpassFilter(centerFreq, width) {
        const checkbox = document.getElementById('bandpass-enable');
        const centerSlider = document.getElementById('bandpass-center');
        const widthSlider = document.getElementById('bandpass-width');
        
        if (checkbox && centerSlider && widthSlider) {
            centerSlider.value = centerFreq;
            widthSlider.value = width;
            checkbox.checked = true;
            if (window.toggleBandpassFilter) window.toggleBandpassFilter();
            if (window.updateBandpassFilter) window.updateBandpassFilter();
            return true;
        }
        return false;
    }
    
    disableBandpassFilter() {
        const checkbox = document.getElementById('bandpass-enable');
        if (checkbox && checkbox.checked) {
            checkbox.checked = false;
            if (window.toggleBandpassFilter) window.toggleBandpassFilter();
            return true;
        }
        return false;
    }
    
    addNotchFilter(frequency, width = 50) {
        if (window.addNotchFilter) {
            window.addNotchFilter(frequency, width);
        }
    }
    
    // === SPECTRUM CONTROLS ===
    
    zoomSpectrum(frequency, binBandwidth) {
        const spectrum = this.getSpectrumDisplay();
        if (spectrum && spectrum.ws && spectrum.ws.readyState === WebSocket.OPEN) {
            spectrum.ws.send(JSON.stringify({
                type: 'zoom',
                frequency: frequency,
                binBandwidth: binBandwidth
            }));
            return true;
        }
        return false;
    }
    
    getSpectrumData() {
        const spectrum = this.getSpectrumDisplay();
        if (spectrum) {
            return {
                centerFreq: spectrum.centerFreq,
                binBandwidth: spectrum.binBandwidth,
                binCount: spectrum.binCount,
                zoomLevel: spectrum.zoomLevel
            };
        }
        return null;
    }
    
    // === LOGGING ===
    
    log(message, type = 'info') {
        if (window.log) {
            window.log(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }
    
    // === EVENT SYSTEM ===
    
    on(event, callback) {
        if (!this.callbacks.has(event)) {
            this.callbacks.set(event, []);
        }
        this.callbacks.get(event).push(callback);
    }
    
    off(event, callback) {
        if (this.callbacks.has(event)) {
            const callbacks = this.callbacks.get(event);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }
    
    emit(event, data) {
        if (this.callbacks.has(event)) {
            this.callbacks.get(event).forEach(callback => callback(data));
        }
    }
    
    // Internal notification methods
    notifyFrequencyChange(freq) {
        this.emit('frequency_changed', { frequency: freq });
    }
    
    notifyModeChange(mode) {
        this.emit('mode_changed', { mode: mode });
    }
    
    notifyBandwidthChange(low, high) {
        this.emit('bandwidth_changed', { low: low, high: high });
    }
    
    // === UTILITY METHODS ===
    
    formatFrequency(hz) {
        if (window.formatFrequency) {
            return window.formatFrequency(hz);
        }
        // Fallback formatting
        if (hz >= 1000000) {
            return (hz / 1000000).toFixed(3) + ' MHz';
        } else if (hz >= 1000) {
            return (hz / 1000).toFixed(1) + ' kHz';
        } else {
            return hz + ' Hz';
        }
    }
    
    getFrequencyBand(freq) {
        const bands = {
            '160m': { min: 1800000, max: 2000000 },
            '80m': { min: 3500000, max: 3800000 },
            '60m': { min: 5330500, max: 5406500 },
            '40m': { min: 7000000, max: 7200000 },
            '30m': { min: 10100000, max: 10150000 },
            '20m': { min: 14000000, max: 14350000 },
            '17m': { min: 18068000, max: 18168000 },
            '15m': { min: 21000000, max: 21450000 },
            '12m': { min: 24890000, max: 24990000 },
            '10m': { min: 28000000, max: 29700000 }
        };
        
        for (const [band, range] of Object.entries(bands)) {
            if (freq >= range.min && freq <= range.max) {
                return band;
            }
        }
        return null;
    }
}

// ============================================================================
// DecoderExtension - Base class for all decoder extensions
// ============================================================================

class DecoderExtension {
    constructor(name, config = {}) {
        this.name = name;
        this.displayName = config.displayName || name; // Human-readable name
        this.enabled = false;
        this.config = {
            centerFrequency: 800,
            threshold: 0.0005,
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null,
            ...config
        };

        // Radio API access
        this.radio = radioAPI;

        // UI elements (auto-discovered by convention)
        this.panelId = `${name}-decoder-panel`;
        this.textDisplayId = `${name}-decoded-text`;
        this.statusBadgeId = `${name}-status-badge`;
        this.signalBarId = `${name}-signal-bar`;

        // Modal mode tracking
        this.modalMode = false;
        this.modalBodyId = null;

        // Output buffer
        this.decodedText = '';
        this.maxTextLength = 1000;

        // Event listeners
        this.eventListeners = [];
    }
    
    // === LIFECYCLE METHODS ===
    
    initialize(audioContext, analyser, centerFreq) {
        this.config.centerFrequency = centerFreq;
        
        // Check mode requirements
        if (this.config.requiresMode) {
            const currentMode = this.radio.getMode();
            if (currentMode !== this.config.requiresMode) {
                this.radio.log(
                    `${this.name} decoder requires ${this.config.requiresMode} mode, switching...`,
                    'info'
                );
                this.radio.setMode(this.config.requiresMode);
            }
        }
        
        // Set preferred bandwidth
        if (this.config.preferredBandwidth) {
            this.radio.setBandwidth(
                this.config.preferredBandwidth.low,
                this.config.preferredBandwidth.high
            );
        }
        
        // Subscribe to radio events
        this.subscribeToRadioEvents();
        
        this.onInitialize();
    }
    
    subscribeToRadioEvents() {
        const freqHandler = (data) => this.onFrequencyChanged(data.frequency);
        this.radio.on('frequency_changed', freqHandler);
        this.eventListeners.push({ event: 'frequency_changed', handler: freqHandler });
        
        const modeHandler = (data) => this.onModeChanged(data.mode);
        this.radio.on('mode_changed', modeHandler);
        this.eventListeners.push({ event: 'mode_changed', handler: modeHandler });
        
        const bwHandler = (data) => this.onBandwidthChanged(data.low, data.high);
        this.radio.on('bandwidth_changed', bwHandler);
        this.eventListeners.push({ event: 'bandwidth_changed', handler: bwHandler });
    }
    
    unsubscribeFromRadioEvents() {
        this.eventListeners.forEach(({ event, handler }) => {
            this.radio.off(event, handler);
        });
        this.eventListeners = [];
    }
    
    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.decodedText = '';
        this.updateDisplay();
        this.addCharacter(`[${this.name.toUpperCase()} DECODER ACTIVE]\n`);
        this.addCharacter(`Frequency: ${this.radio.formatFrequency(this.radio.getFrequency())}\n`);
        this.addCharacter(`Mode: ${this.radio.getMode().toUpperCase()}\n`);
        this.onEnable();
    }
    
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.addCharacter(`\n[${this.name.toUpperCase()} DECODER STOPPED]`);
        this.unsubscribeFromRadioEvents();
        this.onDisable();
    }
    
    // Processing method (called in animation loop)
    processAudio() {
        if (!this.enabled) return;

        // Get analyser - may not be available yet (before audio starts)
        const analyser = this.radio.getAnalyser();
        if (!analyser) {
            // Don't call onProcessAudio if no analyser - audio hasn't started yet
            return;
        }

        const bufferLength = analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);
        analyser.getFloatTimeDomainData(dataArray);

        this.onProcessAudio(dataArray);
    }
    
    // === UTILITY METHODS ===
    
    addCharacter(char) {
        this.decodedText += char;
        if (this.decodedText.length > this.maxTextLength) {
            this.decodedText = this.decodedText.substring(
                this.decodedText.length - this.maxTextLength
            );
        }
        this.updateDisplay();
    }
    
    updateDisplay() {
        // Update the original panel
        const displayElement = document.getElementById(this.textDisplayId);
        if (displayElement) {
            displayElement.textContent = this.decodedText;
            displayElement.scrollTop = displayElement.scrollHeight;
        }

        // Also update modal if in modal mode
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalDisplayElement = modalBody.querySelector(`#${this.textDisplayId}`);
                if (modalDisplayElement) {
                    modalDisplayElement.textContent = this.decodedText;
                    modalDisplayElement.scrollTop = modalDisplayElement.scrollHeight;
                }
            }
        }
    }
    
    updateSignalStrength(magnitude) {
        const percentage = Math.min(100, magnitude * 100);
        let bgColor;

        if (magnitude > this.config.threshold) {
            bgColor = '#28a745';
        } else if (magnitude > this.config.threshold * 0.7) {
            bgColor = '#ffc107';
        } else {
            bgColor = '#6c757d';
        }

        // Update the original panel
        const signalBar = document.getElementById(this.signalBarId);
        if (signalBar) {
            signalBar.style.width = percentage + '%';
            signalBar.style.background = bgColor;
        }

        // Also update modal if in modal mode
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalSignalBar = modalBody.querySelector(`#${this.signalBarId}`);
                if (modalSignalBar) {
                    modalSignalBar.style.width = percentage + '%';
                    modalSignalBar.style.background = bgColor;
                }
            }
        }
    }
    
    updateStatusBadge(status, className = 'decoder-active') {
        // Update the original panel
        const badge = document.getElementById(this.statusBadgeId);
        if (badge) {
            badge.textContent = status;
            badge.className = `decoder-status-badge ${className}`;
        }

        // Also update modal if in modal mode
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalBadge = modalBody.querySelector(`#${this.statusBadgeId}`);
                if (modalBadge) {
                    modalBadge.textContent = status;
                    modalBadge.className = `decoder-status-badge ${className}`;
                }
            }
        }
    }

    // Helper method for extensions to update custom elements in both panel and modal
    updateElementById(id, updateFn) {
        // Update in panel
        const panelEl = document.getElementById(id);
        if (panelEl) {
            updateFn(panelEl);
        }

        // Update in modal if active
        if (this.modalMode && this.modalBodyId) {
            const modalBody = document.getElementById(this.modalBodyId);
            if (modalBody) {
                const modalEl = modalBody.querySelector(`#${id}`);
                if (modalEl) {
                    updateFn(modalEl);
                }
            }
        }
    }

    clearText() {
        this.decodedText = '';
        this.updateDisplay();
    }
    
    copyText() {
        if (this.decodedText.length === 0) return;
        navigator.clipboard.writeText(this.decodedText).then(() => {
            this.radio.log(`${this.name} decoded text copied to clipboard`);
        }).catch(err => {
            console.error('Failed to copy text:', err);
        });
    }
    
    // Goertzel tone detection (shared utility)
    detectTone(samples, targetFreq) {
        const sampleRate = this.radio.getSampleRate();
        const omega = (2.0 * Math.PI * targetFreq) / sampleRate;
        const coeff = 2.0 * Math.cos(omega);
        let q1 = 0, q2 = 0;
        
        for (let i = 0; i < samples.length; i++) {
            const q0 = coeff * q1 - q2 + samples[i];
            q2 = q1;
            q1 = q0;
        }
        
        const N = samples.length;
        const cosine = Math.cos(omega);
        const sine = Math.sin(omega);
        const real = q1 - q2 * cosine;
        const imag = q2 * sine;
        
        return (2.0 / N) * Math.sqrt(real * real + imag * imag);
    }
    
    // === ABSTRACT METHODS (must be implemented by subclasses) ===
    
    onInitialize() {
        // Override in subclass
    }
    
    onEnable() {
        // Override in subclass
    }
    
    onDisable() {
        // Override in subclass
    }
    
    onProcessAudio(dataArray) {
        throw new Error('onProcessAudio must be implemented by subclass');
    }
    
    // === CONFIGURATION METHODS ===
    
    setParameter(name, value) {
        this.config[name] = value;
        this.onParameterChanged(name, value);
    }
    
    onParameterChanged(name, value) {
        // Override in subclass
    }
    
    // === RADIO EVENT HANDLERS (can be overridden by subclasses) ===
    
    onFrequencyChanged(frequency) {
        if (this.config.autoTune) {
            this.config.centerFrequency = frequency;
            this.radio.log(`${this.name}: Tracking frequency ${this.radio.formatFrequency(frequency)}`);
        }
    }
    
    onModeChanged(mode) {
        if (this.config.requiresMode && mode !== this.config.requiresMode) {
            this.radio.log(
                `${this.name}: Warning - mode changed to ${mode}, decoder requires ${this.config.requiresMode}`,
                'error'
            );
        }
    }
    
    onBandwidthChanged(low, high) {
        // Override in subclass to react to bandwidth changes
    }
}

// ============================================================================
// DecoderManager - Central registry for all decoder extensions
// ============================================================================

class DecoderManager {
    constructor() {
        this.decoders = new Map();
        this.activeDecoders = new Set();
    }
    
    register(decoder) {
        if (!(decoder instanceof DecoderExtension)) {
            throw new Error('Decoder must extend DecoderExtension');
        }
        
        // Check for duplicate registration
        if (this.decoders.has(decoder.name)) {
            console.warn(`⚠️ Decoder "${decoder.name}" is already registered. Skipping duplicate registration.`);
            return false;
        }
        
        this.decoders.set(decoder.name, decoder);
        console.log(`✅ Registered decoder: ${decoder.name}`);
        return true;
    }
    
    initialize(name, audioContext, analyser, centerFreq) {
        const decoder = this.decoders.get(name);
        if (!decoder) {
            throw new Error(`Decoder not found: ${name}`);
        }
        decoder.initialize(audioContext, analyser, centerFreq);
    }
    
    enable(name) {
        const decoder = this.decoders.get(name);
        if (decoder) {
            decoder.enable();
            this.activeDecoders.add(name);
        }
    }
    
    disable(name) {
        const decoder = this.decoders.get(name);
        if (decoder) {
            decoder.disable();
            this.activeDecoders.delete(name);
        }
    }
    
    processAudio() {
        // Process all enabled decoders
        this.decoders.forEach(decoder => {
            if (decoder.enabled) {
                decoder.processAudio();
            }
        });
    }

    processSpectrum(spectrumData) {
        // Process spectrum data for all enabled decoders
        this.decoders.forEach(decoder => {
            if (decoder.enabled && typeof decoder.onProcessSpectrum === 'function') {
                decoder.onProcessSpectrum(spectrumData);
            }
        });
    }
    
    getDecoder(name) {
        return this.decoders.get(name);
    }
    
    listDecoders() {
        return Array.from(this.decoders.keys());
    }
    
    getDisplayName(name) {
        const decoder = this.decoders.get(name);
        return decoder ? decoder.displayName : name;
    }
    
    getActiveDecoders() {
        return Array.from(this.activeDecoders);
    }
}

// ============================================================================
// Global instances
// ============================================================================

const radioAPI = new RadioAPI();
const decoderManager = new DecoderManager();

// Expose to global scope
window.radioAPI = radioAPI;
window.decoderManager = decoderManager;
window.DecoderExtension = DecoderExtension;

console.log('✅ Decoder Extension System loaded');