// FT8 Demodulator
// Proper 8-FSK demodulation with symbol timing and soft decisions

class FT8Demodulator {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        
        // FT8 parameters
        this.symbolPeriod = 0.16; // 160 ms
        this.toneSpacing = 6.25; // Hz
        this.numTones = 8;
        this.symbolCount = 79;
        
        // Symbol timing
        this.samplesPerSymbol = Math.floor(this.sampleRate * this.symbolPeriod);
        this.symbolBuffer = [];
        this.sampleBuffer = [];
        
        // Base frequency (will be detected or set)
        this.baseFrequency = 1000; // Hz
        
        // Costas sync pattern for FT8
        this.costasPattern = [3, 1, 4, 0, 6, 5, 2];
        
        // Gray code mapping for 8-FSK
        // Maps tone number (0-7) to 3-bit Gray code
        this.grayCode = [
            [0, 0, 0], // tone 0 -> 000
            [0, 0, 1], // tone 1 -> 001
            [0, 1, 1], // tone 2 -> 011
            [0, 1, 0], // tone 3 -> 010
            [1, 1, 0], // tone 4 -> 110
            [1, 1, 1], // tone 5 -> 111
            [1, 0, 1], // tone 6 -> 101
            [1, 0, 0]  // tone 7 -> 100
        ];
    }
    
    // Demodulate a block of audio samples
    demodulate(audioSamples) {
        // Add samples to buffer
        this.sampleBuffer.push(...audioSamples);
        
        // Process complete symbols
        while (this.sampleBuffer.length >= this.samplesPerSymbol) {
            const symbolSamples = this.sampleBuffer.splice(0, this.samplesPerSymbol);
            const symbol = this.demodulateSymbol(symbolSamples);
            
            if (symbol !== null) {
                this.symbolBuffer.push(symbol);
            }
        }
        
        // Check if we have a complete message
        if (this.symbolBuffer.length >= this.symbolCount) {
            const symbols = this.symbolBuffer.splice(0, this.symbolCount);
            return this.symbolsToCodeword(symbols);
        }
        
        return null;
    }
    
    // Demodulate a single symbol using FFT-based tone detection
    demodulateSymbol(samples) {
        const toneEnergies = new Float32Array(this.numTones);
        
        // Calculate energy in each tone using Goertzel algorithm
        for (let tone = 0; tone < this.numTones; tone++) {
            const freq = this.baseFrequency + (tone * this.toneSpacing);
            toneEnergies[tone] = this.goertzel(samples, freq);
        }
        
        // Find tone with maximum energy
        let maxTone = 0;
        let maxEnergy = toneEnergies[0];
        
        for (let tone = 1; tone < this.numTones; tone++) {
            if (toneEnergies[tone] > maxEnergy) {
                maxEnergy = toneEnergies[tone];
                maxTone = tone;
            }
        }
        
        // Return symbol with soft decision information
        return {
            tone: maxTone,
            energy: maxEnergy,
            energies: toneEnergies,
            confidence: this.calculateConfidence(toneEnergies, maxTone)
        };
    }
    
    // Goertzel algorithm for single-frequency detection
    goertzel(samples, targetFreq) {
        const omega = (2.0 * Math.PI * targetFreq) / this.sampleRate;
        const coeff = 2.0 * Math.cos(omega);
        let q1 = 0, q2 = 0;
        
        for (let i = 0; i < samples.length; i++) {
            const q0 = coeff * q1 - q2 + samples[i];
            q2 = q1;
            q1 = q0;
        }
        
        const N = samples.length;
        const real = q1 - q2 * Math.cos(omega);
        const imag = q2 * Math.sin(omega);
        
        return Math.sqrt(real * real + imag * imag) / N;
    }
    
    // Calculate confidence of symbol decision
    calculateConfidence(energies, maxTone) {
        const maxEnergy = energies[maxTone];
        let secondMax = 0;
        
        for (let i = 0; i < energies.length; i++) {
            if (i !== maxTone && energies[i] > secondMax) {
                secondMax = energies[i];
            }
        }
        
        // Confidence is ratio of max to second-max
        return secondMax > 0 ? maxEnergy / secondMax : 10.0;
    }
    
    // Convert symbols to LDPC codeword with soft decisions
    symbolsToCodeword(symbols) {
        const codeword = new Float32Array(174);
        let bitIndex = 0;
        
        // Convert each symbol to 3 bits using Gray code
        for (let i = 0; i < symbols.length && bitIndex < 174; i++) {
            const symbol = symbols[i];
            const bits = this.grayCode[symbol.tone];
            const confidence = symbol.confidence;
            
            // Convert to log-likelihood ratios
            // Positive = likely 0, Negative = likely 1
            for (let j = 0; j < 3 && bitIndex < 174; j++) {
                const bit = bits[j];
                // Scale by confidence: higher confidence = stronger LLR
                codeword[bitIndex++] = bit === 0 ? confidence : -confidence;
            }
        }
        
        return codeword;
    }
    
    // Detect Costas sync pattern in symbol stream
    detectCostasSync(symbols) {
        if (symbols.length < 7) return -1;
        
        let bestScore = 0;
        let bestOffset = -1;
        
        // Search for Costas pattern
        for (let offset = 0; offset <= symbols.length - 7; offset++) {
            let score = 0;
            
            for (let i = 0; i < 7; i++) {
                if (symbols[offset + i].tone === this.costasPattern[i]) {
                    score += symbols[offset + i].confidence;
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestOffset = offset;
            }
        }
        
        // Require minimum score for valid sync
        return bestScore > 5.0 ? bestOffset : -1;
    }
    
    // Set base frequency for demodulation
    setBaseFrequency(freq) {
        this.baseFrequency = freq;
    }
    
    // Reset demodulator state
    reset() {
        this.symbolBuffer = [];
        this.sampleBuffer = [];
    }
}

// Export to global scope
window.FT8Demodulator = FT8Demodulator;

console.log('✅ FT8 Demodulator loaded');