// Noise Blanker - Time-domain impulse noise suppression
// Designed for electric fence pulses, ignition noise, and similar transient interference
// Minimal latency (<5ms) with automatic threshold detection

class NoiseBlanker {
    constructor(audioContext, sampleRate = 12000) {
        this.audioContext = audioContext;
        this.sampleRate = sampleRate;
        
        // Fixed parameters optimized for impulse noise (no UI adjustment needed)
        this.threshold = 4.0;           // 4x average = ~12dB above noise floor
        this.blankDuration = 0.003;     // 3ms blanking duration
        this.blankSamples = Math.floor(sampleRate * this.blankDuration);
        this.avgWindow = Math.floor(sampleRate * 0.010);  // 10ms averaging window
        
        // Soft blanking parameters
        this.useSoftBlanking = true;    // Exponential decay instead of hard muting
        this.decayRate = 5.0;           // Decay speed (higher = faster)
        
        // State
        this.avgLevel = 0.0001;         // Initialize to small value to avoid division by zero
        this.blankCounter = 0;
        this.enabled = false;
        
        // Circular buffer for running average (minimal memory footprint)
        this.history = new Float32Array(this.avgWindow);
        this.historyPos = 0;
        this.historySum = 0.0;
        
        // Statistics (for debugging/monitoring)
        this.pulsesDetected = 0;
        this.lastPulseTime = 0;
    }
    
    // Process a buffer of audio samples
    process(input, output) {
        if (!this.enabled) {
            // Pass through when disabled
            output.set(input);
            return;
        }
        
        for (let i = 0; i < input.length; i++) {
            const sample = input[i];
            const absSample = Math.abs(sample);
            
            // Update running average using circular buffer
            // This provides a fast-moving noise floor estimate
            this.historySum -= this.history[this.historyPos];
            this.history[this.historyPos] = absSample;
            this.historySum += absSample;
            this.historyPos = (this.historyPos + 1) % this.avgWindow;
            this.avgLevel = Math.max(this.historySum / this.avgWindow, 0.0001);
            
            // Detect impulse: sample significantly above average
            if (absSample > this.avgLevel * this.threshold) {
                // Start blanking period
                if (this.blankCounter === 0) {
                    // New pulse detected
                    this.pulsesDetected++;
                    this.lastPulseTime = this.audioContext.currentTime;
                }
                this.blankCounter = this.blankSamples;
            }
            
            // Apply blanking
            if (this.blankCounter > 0) {
                if (this.useSoftBlanking) {
                    // Soft blanking: exponential decay
                    // Gain goes from 0 (at start) to 1 (at end of blanking period)
                    // This creates a smooth fade-in after the pulse
                    const progress = 1.0 - (this.blankCounter / this.blankSamples);
                    const blankGain = 1.0 - Math.exp(-this.decayRate * progress);
                    output[i] = sample * blankGain;
                } else {
                    // Hard blanking: complete muting
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
