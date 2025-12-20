// NR2 Spectral Subtraction Noise Reduction
// Implements overlap-add spectral subtraction similar to Hermes-Lite2 NR2

class NR2Processor {
    constructor(audioContext, fftSize = 2048, overlapFactor = 4) {
        this.audioContext = audioContext;
        this.fftSize = fftSize;
        this.hopSize = fftSize / overlapFactor;
        this.overlapFactor = overlapFactor;
        
        // FFT processor
        this.fft = new FFT(fftSize);
        
        // Windowing
        this.window = FFT.createHannWindow(fftSize);
        
        // Buffers
        this.inputBuffer = new Float32Array(fftSize);
        this.outputBuffer = new Float32Array(fftSize);
        this.overlapBuffer = new Float32Array(fftSize);
        this.inputBufferPos = 0;
        
        // FFT arrays
        this.real = new Float32Array(fftSize);
        this.imag = new Float32Array(fftSize);
        
        // Noise profile (magnitude spectrum)
        this.noiseProfile = new Float32Array(fftSize / 2 + 1);
        this.noiseProfileCount = 0;
        this.learningFrames = 30; // ~0.5 seconds at 60fps
        this.isLearning = true;
        
        // Adaptive noise tracking
        this.adaptiveNoiseTracking = true;  // Continuously adapt to changing noise
        this.noiseAdaptRate = 0.01;  // How fast to adapt (1% per frame)
        this.signalThreshold = 2.0;  // Only update noise when signal < threshold * noise
        
        // Parameters (will be updated from UI)
        this.alpha = 2.0;  // Over-subtraction factor
        this.beta = 0.01;  // Spectral floor
        
        // Processing state
        this.enabled = false;
    }
    
    // Update parameters from UI
    setParameters(strength, floor, adaptRate) {
        // Strength 0-100% maps to alpha 1.0-4.0
        this.alpha = 1.0 + (strength / 100) * 3.0;
        // Floor 0-10% maps to beta 0.001-0.1
        this.beta = 0.001 + (floor / 100) * 0.099;
        // Adapt rate 0.1-5.0% maps to 0.001-0.05
        if (adaptRate !== undefined) {
            this.noiseAdaptRate = adaptRate / 100;
        }
    }
    
    // Reset noise learning
    resetLearning() {
        this.noiseProfile.fill(0);
        this.noiseProfileCount = 0;
        this.isLearning = true;
    }
    
    // Process a buffer of audio samples
    process(input, output) {
        const inputLength = input.length;
        let inputPos = 0;
        let outputPos = 0;
        
        while (inputPos < inputLength) {
            // Fill input buffer
            const samplesToBuffer = Math.min(this.hopSize, inputLength - inputPos);
            
            // Shift existing samples
            for (let i = 0; i < this.fftSize - samplesToBuffer; i++) {
                this.inputBuffer[i] = this.inputBuffer[i + samplesToBuffer];
            }
            
            // Add new samples
            for (let i = 0; i < samplesToBuffer; i++) {
                this.inputBuffer[this.fftSize - samplesToBuffer + i] = input[inputPos + i];
            }
            
            // Process frame
            this.processFrame();
            
            // Output samples
            const samplesToOutput = Math.min(this.hopSize, output.length - outputPos);
            for (let i = 0; i < samplesToOutput; i++) {
                output[outputPos + i] = this.outputBuffer[i];
            }
            
            // Shift output buffer
            for (let i = 0; i < this.fftSize - this.hopSize; i++) {
                this.outputBuffer[i] = this.outputBuffer[i + this.hopSize];
            }
            for (let i = this.fftSize - this.hopSize; i < this.fftSize; i++) {
                this.outputBuffer[i] = 0;
            }
            
            inputPos += samplesToBuffer;
            outputPos += samplesToOutput;
        }
    }
    
    // Process one FFT frame
    processFrame() {
        // Apply window
        for (let i = 0; i < this.fftSize; i++) {
            this.real[i] = this.inputBuffer[i] * this.window[i];
            this.imag[i] = 0;
        }
        
        // Forward FFT
        this.fft.forward(this.real, this.imag);
        
        // Calculate magnitude spectrum
        const magnitude = new Float32Array(this.fftSize / 2 + 1);
        for (let i = 0; i <= this.fftSize / 2; i++) {
            magnitude[i] = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]);
        }
        
        // Learn noise profile
        if (this.isLearning && this.noiseProfileCount < this.learningFrames) {
            for (let i = 0; i <= this.fftSize / 2; i++) {
                this.noiseProfile[i] += magnitude[i];
            }
            this.noiseProfileCount++;
            
            if (this.noiseProfileCount >= this.learningFrames) {
                // Average the noise profile
                for (let i = 0; i <= this.fftSize / 2; i++) {
                    this.noiseProfile[i] /= this.learningFrames;
                }
                this.isLearning = false;
                console.log('NR2: Noise profile learned');
            }
            
            // During learning, pass through with window compensation
            for (let i = 0; i < this.fftSize; i++) {
                this.outputBuffer[i] += this.inputBuffer[i] * this.window[i];
            }
            return;
        }
        
        // Apply spectral subtraction if enabled
        if (this.enabled && !this.isLearning) {
            for (let i = 0; i <= this.fftSize / 2; i++) {
                // Adaptive noise tracking: update noise profile when signal is weak
                if (this.adaptiveNoiseTracking) {
                    // Only update noise estimate when current magnitude is close to noise floor
                    // (i.e., likely no strong signal present in this bin)
                    if (magnitude[i] < this.signalThreshold * this.noiseProfile[i]) {
                        // Exponential moving average: slowly track noise changes
                        this.noiseProfile[i] = (1 - this.noiseAdaptRate) * this.noiseProfile[i] +
                                               this.noiseAdaptRate * magnitude[i];
                    }
                }
                
                // Spectral subtraction with over-subtraction
                let cleanMag = magnitude[i] - this.alpha * this.noiseProfile[i];
                
                // Apply spectral floor to prevent musical noise
                cleanMag = Math.max(cleanMag, this.beta * magnitude[i]);
                
                // Update FFT bins with cleaned magnitude (preserve phase)
                if (magnitude[i] > 0) {
                    const scale = cleanMag / magnitude[i];
                    this.real[i] *= scale;
                    this.imag[i] *= scale;
                } else {
                    this.real[i] = 0;
                    this.imag[i] = 0;
                }
            }
            
            // Mirror for negative frequencies (real FFT symmetry)
            for (let i = this.fftSize / 2 + 1; i < this.fftSize; i++) {
                const mirrorIdx = this.fftSize - i;
                this.real[i] = this.real[mirrorIdx];
                this.imag[i] = -this.imag[mirrorIdx];
            }
        }
        
        // Inverse FFT
        this.fft.inverse(this.real, this.imag);
        
        // Overlap-add with window
        for (let i = 0; i < this.fftSize; i++) {
            this.outputBuffer[i] += this.real[i] * this.window[i];
        }
    }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NR2Processor;
}