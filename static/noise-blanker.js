// Noise Blanker - Time-domain impulse noise suppression
// Designed for electric fence pulses, ignition noise, and similar transient interference
// Minimal latency (<5ms) with automatic threshold detection

class NoiseBlanker {
    constructor(audioContext, sampleRate = 12000) {
        this.audioContext = audioContext;
        this.sampleRate = sampleRate;
        
        // Optimized parameters for impulse noise suppression
        this.threshold = 8.0;           // 8x average = ~18dB above noise floor (more conservative)
        this.blankDuration = 0.002;     // 2ms blanking duration (shorter)
        this.blankSamples = Math.floor(sampleRate * this.blankDuration);
        this.avgWindow = Math.floor(sampleRate * 0.050);  // 50ms averaging window (longer for stability)
        
        // Soft blanking with smooth transitions
        this.useSoftBlanking = true;
        this.fadeInSamples = Math.floor(sampleRate * 0.001);  // 1ms fade-in
        
        // State
        this.avgLevel = 0.0001;
        this.blankCounter = 0;
        this.enabled = false;
        
        // Circular buffer for running average
        this.history = new Float32Array(this.avgWindow);
        this.historyPos = 0;
        this.historySum = 0.0;
        
        // Warmup period to establish baseline
        this.warmupSamples = this.avgWindow * 2;
        this.warmupCounter = 0;
        
        // Statistics
        this.pulsesDetected = 0;
        this.lastPulseTime = 0;
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
            
            // Update running average (always update for stable tracking)
            this.historySum -= this.history[this.historyPos];
            this.history[this.historyPos] = absSample;
            this.historySum += absSample;
            this.historyPos = (this.historyPos + 1) % this.avgWindow;
            this.avgLevel = Math.max(this.historySum / this.avgWindow, 0.0001);
            
            // Warmup period: pass through while establishing baseline
            if (this.warmupCounter < this.warmupSamples) {
                this.warmupCounter++;
                output[i] = sample;
                continue;
            }
            
            // Detect impulse: sample significantly above running average
            const isImpulse = absSample > this.avgLevel * this.threshold;
            
            if (isImpulse && this.blankCounter === 0) {
                // New impulse detected - start blanking period
                this.blankCounter = this.blankSamples;
                this.pulsesDetected++;
                this.lastPulseTime = this.audioContext.currentTime;
            }
            
            // Apply blanking with smooth fade-in
            if (this.blankCounter > 0) {
                if (this.useSoftBlanking) {
                    // Calculate fade-in using raised cosine window
                    const samplesFromStart = this.blankSamples - this.blankCounter;
                    
                    if (samplesFromStart < this.fadeInSamples) {
                        // Smooth fade-in using raised cosine (Hann window)
                        const fadeProgress = samplesFromStart / this.fadeInSamples;
                        const fadeGain = 0.5 * (1.0 - Math.cos(Math.PI * fadeProgress));
                        output[i] = sample * fadeGain;
                    } else {
                        // After fade-in, pass through normally
                        output[i] = sample;
                    }
                } else {
                    // Hard blanking: zero out the sample
                    output[i] = 0;
                }
                this.blankCounter--;
            } else {
                // No blanking active
                output[i] = sample;
            }
        }
    }
    
    // Reset state (useful when changing frequency or mode)
    reset() {
        this.history.fill(0);
        this.historyPos = 0;
        this.historySum = 0.0;
        this.avgLevel = 0.0001;
        this.blankCounter = 0;
        this.warmupCounter = 0;
        this.pulsesDetected = 0;
    }
    
    // Get statistics
    getStats() {
        return {
            enabled: this.enabled,
            pulsesDetected: this.pulsesDetected,
            lastPulseTime: this.lastPulseTime,
            currentAvgLevel: this.avgLevel,
            threshold: this.avgLevel * this.threshold,
            blankDurationMs: this.blankDuration * 1000
        };
    }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NoiseBlanker;
}
