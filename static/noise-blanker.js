// Noise Blanker - Frequency-domain impulse noise suppression
// Removes transient wideband noise (e.g., power line noise, ignition noise, electric fences)
// Uses FFT to detect broadband clicks and distinguish from narrowband speech

class NoiseBlanker {
    constructor(audioContext, sampleRate = 12000) {
        this.audioContext = audioContext;
        this.sampleRate = sampleRate;
        
        // Parameters
        this.threshold = 10.0;          // 10x average = ~20dB above noise floor
        this.blankDuration = 0.003;     // 3ms blanking duration
        this.blankSamples = Math.floor(sampleRate * this.blankDuration);
        this.avgWindow = Math.floor(sampleRate * 0.020);  // 20ms averaging window
        
        // FFT parameters for broadband detection
        this.fftSize = 128;  // Small FFT for quick spectral analysis
        this.fftBuffer = new Float32Array(this.fftSize);
        this.fftBufferPos = 0;
        this.spectralFlatnessThreshold = 0.3;  // 0-1, higher = more broadband required
        
        // Pre-compute FFT twiddle factors for efficiency
        this.setupFFT();
        
        // Create a Hann-like window for smooth blanking
        // At detection (windowPos=0): maximum attenuation (multiply by ~0.0)
        // At end (windowPos=blankSamples-1): no attenuation (multiply by 1.0)
        // This creates a smooth fade-out of the blanking effect
        this.window = new Float32Array(this.blankSamples);
        
        // Use a Hann window shape: starts at 0.0, ends at 1.0
        // This gives maximum attenuation at the start (when pulse detected)
        // and smoothly releases back to normal
        for (let i = 0; i < this.blankSamples; i++) {
            // Hann window from 0 to 1: 0.5 * (1 - cos(pi * i / N))
            // But we want 0 at start, 1 at end, so use: 0.5 * (1 - cos(pi * (i+1) / N))
            const t = (i + 1) / this.blankSamples;  // 0 to 1
            this.window[i] = 0.5 * (1.0 - Math.cos(Math.PI * t));
        }
        
        // State
        this.avgLevel = 0.0001;
        this.blankCounter = 0;
        this.enabled = false;
        
        // History buffer for running average
        this.history = new Float32Array(this.avgWindow);
        this.historyPos = 0;
        this.historySum = 0.0;
        
        // Warmup period
        this.warmupSamples = this.avgWindow * 2;
        this.warmupCounter = 0;
        
        // Statistics
        this.pulsesDetected = 0;
        this.lastPulseTime = 0;
        this.lastLogTime = 0;
        this.logInterval = 2.0;  // Log every 2 seconds max
        this.falsePositivesRejected = 0;
    }
    
    // Setup FFT computation (simple DFT for small size)
    setupFFT() {
        // For small FFT sizes, direct DFT is acceptable
        // Pre-compute cosine and sine tables
        this.cosTable = new Float32Array(this.fftSize * this.fftSize / 2);
        this.sinTable = new Float32Array(this.fftSize * this.fftSize / 2);
        
        for (let k = 0; k < this.fftSize / 2; k++) {
            for (let n = 0; n < this.fftSize; n++) {
                const idx = k * this.fftSize + n;
                const angle = -2.0 * Math.PI * k * n / this.fftSize;
                this.cosTable[idx] = Math.cos(angle);
                this.sinTable[idx] = Math.sin(angle);
            }
        }
    }
    
    // Compute magnitude spectrum (only positive frequencies)
    computeSpectrum(buffer) {
        const spectrum = new Float32Array(this.fftSize / 2);
        
        // Apply Hann window to input
        const windowed = new Float32Array(this.fftSize);
        for (let i = 0; i < this.fftSize; i++) {
            const w = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / this.fftSize));
            windowed[i] = buffer[i] * w;
        }
        
        // Compute DFT for positive frequencies only
        for (let k = 0; k < this.fftSize / 2; k++) {
            let real = 0.0;
            let imag = 0.0;
            
            for (let n = 0; n < this.fftSize; n++) {
                const idx = k * this.fftSize + n;
                real += windowed[n] * this.cosTable[idx];
                imag += windowed[n] * this.sinTable[idx];
            }
            
            // Magnitude
            spectrum[k] = Math.sqrt(real * real + imag * imag);
        }
        
        return spectrum;
    }
    
    // Calculate spectral flatness (geometric mean / arithmetic mean)
    // Returns 0-1, where 1 = perfectly flat (broadband), 0 = single tone
    calculateSpectralFlatness(spectrum) {
        let geometricMean = 1.0;
        let arithmeticMean = 0.0;
        const epsilon = 1e-10;  // Avoid log(0)
        
        for (let i = 0; i < spectrum.length; i++) {
            const mag = spectrum[i] + epsilon;
            geometricMean *= Math.pow(mag, 1.0 / spectrum.length);
            arithmeticMean += mag / spectrum.length;
        }
        
        if (arithmeticMean < epsilon) return 0.0;
        return geometricMean / arithmeticMean;
    }
    
    // Check if current signal is broadband (impulse noise characteristic)
    isBroadbandClick() {
        // Compute spectrum of recent samples
        const spectrum = this.computeSpectrum(this.fftBuffer);
        
        // Calculate spectral flatness
        const flatness = this.calculateSpectralFlatness(spectrum);
        
        // Broadband clicks have high spectral flatness
        return flatness > this.spectralFlatnessThreshold;
    }
    
    // Update noise blanker parameters
    setParameters(threshold = null, avgWindowMs = null, spectralFlatnessThreshold = null) {
        if (threshold !== null) {
            this.threshold = parseFloat(threshold);
        }
        
        if (avgWindowMs !== null) {
            const newWindow = Math.floor(this.sampleRate * avgWindowMs / 1000.0);
            if (newWindow !== this.avgWindow) {
                this.avgWindow = newWindow;
                this.history = new Float32Array(this.avgWindow);
                this.historyPos = 0;
                this.historySum = 0.0;
                this.warmupSamples = this.avgWindow * 2;
                this.warmupCounter = 0;
            }
        }
        
        if (spectralFlatnessThreshold !== null) {
            this.spectralFlatnessThreshold = parseFloat(spectralFlatnessThreshold);
        }
    }
    
    // Process a buffer of audio samples
    process(input, output) {
        if (!this.enabled) {
            output.set(input);
            return;
        }
        
        for (let i = 0; i < input.length; i++) {
            const sample = input[i];
            const absSample = Math.abs(sample);
            
            // Update FFT buffer
            this.fftBuffer[this.fftBufferPos] = sample;
            this.fftBufferPos = (this.fftBufferPos + 1) % this.fftSize;
            
            // Update running average
            this.historySum -= this.history[this.historyPos];
            this.history[this.historyPos] = absSample;
            this.historySum += absSample;
            this.historyPos = (this.historyPos + 1) % this.avgWindow;
            this.avgLevel = Math.max(this.historySum / this.avgWindow, 0.0001);
            
            // Skip detection during warmup
            if (this.warmupCounter < this.warmupSamples) {
                this.warmupCounter++;
                output[i] = sample;
                continue;
            }
            
            // Detect pulse - first check amplitude
            if (absSample > this.avgLevel * this.threshold) {
                // Then check if it's broadband (impulse noise) or narrowband (speech)
                if (this.isBroadbandClick()) {
                    if (this.blankCounter === 0) {
                        this.pulsesDetected++;
                        // Log detection (rate-limited)
                        const currentTime = this.audioContext.currentTime;
                        if (currentTime - this.lastLogTime > this.logInterval) {
                            console.log(`[NB] Broadband pulse detected! Sample=${absSample.toFixed(6)}, Avg=${this.avgLevel.toFixed(6)}, ` +
                                      `Threshold=${(this.avgLevel * this.threshold).toFixed(6)}, Ratio=${(absSample/this.avgLevel).toFixed(1)}x`);
                            this.lastLogTime = currentTime;
                        }
                    }
                    // Start blanking from the MIDDLE of the window (maximum attenuation)
                    // so the detected pulse itself gets blanked
                    this.blankCounter = this.blankSamples;
                } else {
                    // Narrowband peak (likely speech) - don't blank
                    if (this.blankCounter === 0) {
                        this.falsePositivesRejected++;
                        const currentTime = this.audioContext.currentTime;
                        if (currentTime - this.lastLogTime > this.logInterval) {
                            console.log(`[NB] Narrowband peak rejected (speech?) Sample=${absSample.toFixed(6)}, Ratio=${(absSample/this.avgLevel).toFixed(1)}x`);
                            this.lastLogTime = currentTime;
                        }
                    }
                }
            }
            
            // Apply windowed blanking
            if (this.blankCounter > 0) {
                // Calculate position in window (counts down from blankSamples to 1)
                // We want to apply maximum attenuation NOW (at detection), so we need
                // to map blankCounter to the middle of the window
                // When blankCounter = blankSamples (just detected), use middle of window
                // When blankCounter = 1 (end), use end of window
                const windowPos = this.blankSamples - this.blankCounter;
                
                // Apply window (attenuates in middle, preserves edges)
                const attenuation = this.window[windowPos];
                output[i] = sample * attenuation;
                
                this.blankCounter--;
            } else {
                output[i] = sample;
            }
        }
    }
    
    // Reset noise blanker state
    reset() {
        this.history.fill(0);
        this.historyPos = 0;
        this.historySum = 0.0;
        this.avgLevel = 0.0001;
        this.blankCounter = 0;
        this.warmupCounter = 0;
        this.pulsesDetected = 0;
        this.falsePositivesRejected = 0;
        this.lastLogTime = 0;
        this.fftBuffer.fill(0);
        this.fftBufferPos = 0;
    }
    
    // Get statistics about noise blanker operation
    getStats() {
        return {
            enabled: this.enabled,
            pulsesDetected: this.pulsesDetected,
            falsePositivesRejected: this.falsePositivesRejected,
            avgLevel: this.avgLevel,
            thresholdLevel: this.avgLevel * this.threshold,
            blanking: this.blankCounter > 0,
            blankDurationMs: this.blankDuration * 1000,
            spectralFlatnessThreshold: this.spectralFlatnessThreshold
        };
    }
}

// Create and configure a noise blanker
function createNoiseBlanker(audioContext, sampleRate = 12000, threshold = 10.0, avgWindowMs = 20, spectralFlatnessThreshold = 0.3) {
    const nb = new NoiseBlanker(audioContext, sampleRate);
    nb.setParameters(threshold, avgWindowMs, spectralFlatnessThreshold);
    nb.enabled = true;
    return nb;
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NoiseBlanker;
}
