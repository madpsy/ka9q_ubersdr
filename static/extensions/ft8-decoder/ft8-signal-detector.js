// FT8 Signal Detector
// Multi-frequency signal detection with Costas sync pattern matching

class FT8SignalDetector {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        
        // FT8 parameters
        this.symbolPeriod = 0.16; // 160 ms
        this.toneSpacing = 6.25; // Hz
        this.numTones = 8;
        this.symbolCount = 79;
        
        // Frequency search range
        this.minFreq = 200;
        this.maxFreq = 3200;
        this.freqStep = 6.25; // Search in 6.25 Hz steps
        
        // Costas sync pattern (first 7 symbols of FT8)
        this.costasPattern = [3, 1, 4, 0, 6, 5, 2];
        
        // Time slot tracking
        this.slotDuration = 15.0; // seconds
        this.transmitDuration = 12.64; // seconds
        this.currentSlot = -1;
        this.slotStartTime = 0;
        
        // Audio buffer for time-slot processing
        this.audioBuffer = [];
        this.maxBufferSeconds = 15;
        this.slotAudioBuffer = []; // Buffer for current slot
        this.processingComplete = false;
        
        // Candidate signals
        this.candidates = [];
        this.maxCandidates = 50;
        
        // Detection thresholds
        this.minSNR = -20; // dB
        this.costasThreshold = 0.6; // Minimum correlation for Costas detection
    }
    
    // Update time slot based on system time
    updateTimeSlot() {
        const now = Date.now() / 1000; // seconds since epoch
        const secondsInMinute = now % 60;
        const newSlot = Math.floor(secondsInMinute / this.slotDuration);
        
        if (newSlot !== this.currentSlot) {
            const oldSlot = this.currentSlot;
            this.currentSlot = newSlot;
            this.slotStartTime = now - (secondsInMinute % this.slotDuration);
            
            // At slot boundary, process the previous slot's audio
            if (oldSlot >= 0 && this.slotAudioBuffer.length > 0) {
                // Process the complete transmission
                this.processSlotAudio();
            }
            
            // Clear buffers for new slot
            this.slotAudioBuffer = [];
            this.candidates = [];
            this.processingComplete = false;
            
            return true; // Slot changed
        }
        
        return false;
    }
    
    // Get time within current slot
    getSlotTime() {
        const now = Date.now() / 1000;
        return now - this.slotStartTime;
    }
    
    // Check if we're in the receive window
    isReceiveWindow() {
        const slotTime = this.getSlotTime();
        // Receive during first 12.64 seconds of each 15-second slot
        return slotTime >= 0 && slotTime <= this.transmitDuration;
    }
    
    // Add audio samples to buffer
    addAudioSamples(samples) {
        const slotTime = this.getSlotTime();
        
        // Only buffer during receive window (first 12.64 seconds)
        if (slotTime >= 0 && slotTime <= this.transmitDuration) {
            this.slotAudioBuffer.push(...samples);
        }
        
        // Also keep rolling buffer for waterfall
        this.audioBuffer.push(...samples);
        const maxSamples = this.sampleRate * this.maxBufferSeconds;
        if (this.audioBuffer.length > maxSamples) {
            this.audioBuffer = this.audioBuffer.slice(-maxSamples);
        }
    }
    
    // Detect signals - called continuously
    detectSignals() {
        // Update time slot (will trigger processing at slot boundary)
        this.updateTimeSlot();
        
        const slotTime = this.getSlotTime();
        
        // Check if we should process at end of receive window
        if (slotTime > this.transmitDuration && !this.processingComplete) {
            this.processSlotAudio();
            this.processingComplete = true;
        }
        
        return this.candidates;
    }
    
    // Process the complete slot audio buffer
    processSlotAudio() {
        // Need enough samples for complete transmission
        const expectedSamples = Math.floor(this.sampleRate * this.transmitDuration);
        
        if (this.slotAudioBuffer.length < expectedSamples * 0.9) {
            // Not enough audio captured
            return;
        }
        
        console.log(`Processing ${this.slotAudioBuffer.length} samples (${(this.slotAudioBuffer.length/this.sampleRate).toFixed(2)}s)`);
        
        // Search for signals across frequency range using the complete buffer
        const candidates = this.searchFrequenciesInBuffer(this.slotAudioBuffer);
        
        // Filter and rank candidates
        this.candidates = this.filterCandidates(candidates);
        
        console.log(`Found ${this.candidates.length} candidate(s)`);
    }
    
    // Search for signals across frequency range in a complete buffer
    searchFrequenciesInBuffer(audioBuffer) {
        const candidates = [];
        const numFreqs = Math.floor((this.maxFreq - this.minFreq) / this.freqStep);
        
        // Calculate how many symbols we can analyze
        const samplesPerSymbol = Math.floor(this.sampleRate * this.symbolPeriod);
        const maxSymbols = Math.min(
            Math.floor(audioBuffer.length / samplesPerSymbol),
            this.symbolCount
        );
        
        if (maxSymbols < 7) {
            return candidates; // Not enough for Costas
        }
        
        // Search each frequency
        for (let i = 0; i < numFreqs; i += 2) { // Step by 2 for speed (12.5 Hz steps)
            const baseFreq = this.minFreq + (i * this.freqStep);
            
            // Demodulate symbols at this frequency
            const symbols = this.demodulateAtFrequencyInBuffer(audioBuffer, baseFreq, maxSymbols);
            
            if (symbols.length >= 7) {
                // Check for Costas sync pattern
                const syncResult = this.detectCostasSync(symbols);
                
                if (syncResult.found) {
                    candidates.push({
                        frequency: baseFreq,
                        syncOffset: syncResult.offset,
                        syncScore: syncResult.score,
                        snr: syncResult.snr,
                        symbols: symbols,
                        timestamp: Date.now()
                    });
                }
            }
        }
        
        return candidates;
    }
    
    // Demodulate symbols at a specific frequency from a buffer
    demodulateAtFrequencyInBuffer(audioBuffer, baseFreq, maxSymbols) {
        const symbols = [];
        const samplesPerSymbol = Math.floor(this.sampleRate * this.symbolPeriod);
        
        for (let sym = 0; sym < maxSymbols; sym++) {
            const startSample = sym * samplesPerSymbol;
            const endSample = startSample + samplesPerSymbol;
            
            if (endSample > audioBuffer.length) break;
            
            const symbolSamples = audioBuffer.slice(startSample, endSample);
            const symbol = this.demodulateSymbol(symbolSamples, baseFreq);
            
            if (symbol) {
                symbols.push(symbol);
            }
        }
        
        return symbols;
    }
    
    // Demodulate a single symbol
    demodulateSymbol(samples, baseFreq) {
        const toneEnergies = new Float32Array(this.numTones);
        
        // Calculate energy in each tone
        for (let tone = 0; tone < this.numTones; tone++) {
            const freq = baseFreq + (tone * this.toneSpacing);
            toneEnergies[tone] = this.goertzel(samples, freq);
        }
        
        // Find maximum tone
        let maxTone = 0;
        let maxEnergy = toneEnergies[0];
        let totalEnergy = toneEnergies[0];
        
        for (let tone = 1; tone < this.numTones; tone++) {
            totalEnergy += toneEnergies[tone];
            if (toneEnergies[tone] > maxEnergy) {
                maxEnergy = toneEnergies[tone];
                maxTone = tone;
            }
        }
        
        // Calculate SNR (signal to noise ratio)
        const avgEnergy = totalEnergy / this.numTones;
        const snr = maxEnergy / (avgEnergy + 1e-10);
        
        return {
            tone: maxTone,
            energy: maxEnergy,
            energies: Array.from(toneEnergies),
            snr: snr
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
        
        const real = q1 - q2 * Math.cos(omega);
        const imag = q2 * Math.sin(omega);
        
        return Math.sqrt(real * real + imag * imag);
    }
    
    // Detect Costas sync pattern in symbol stream
    detectCostasSync(symbols) {
        let bestScore = 0;
        let bestOffset = -1;
        let bestSNR = 0;
        
        // Search for Costas pattern at different offsets
        for (let offset = 0; offset <= symbols.length - 7; offset++) {
            let score = 0;
            let totalSNR = 0;
            
            // Check match with Costas pattern
            for (let i = 0; i < 7; i++) {
                const symbol = symbols[offset + i];
                if (symbol.tone === this.costasPattern[i]) {
                    score += 1.0;
                    totalSNR += symbol.snr;
                }
            }
            
            // Normalize score
            const normalizedScore = score / 7.0;
            const avgSNR = totalSNR / 7.0;
            
            if (normalizedScore > bestScore) {
                bestScore = normalizedScore;
                bestOffset = offset;
                bestSNR = avgSNR;
            }
        }
        
        return {
            found: bestScore >= this.costasThreshold,
            offset: bestOffset,
            score: bestScore,
            snr: bestSNR
        };
    }
    
    // Filter and rank candidates
    filterCandidates(candidates) {
        // Remove duplicates (signals within 25 Hz are likely the same)
        const filtered = [];
        const freqTolerance = 25; // Hz
        
        for (const candidate of candidates) {
            let isDuplicate = false;
            
            for (const existing of filtered) {
                if (Math.abs(candidate.frequency - existing.frequency) < freqTolerance) {
                    // Keep the one with better sync score
                    if (candidate.syncScore > existing.syncScore) {
                        const index = filtered.indexOf(existing);
                        filtered[index] = candidate;
                    }
                    isDuplicate = true;
                    break;
                }
            }
            
            if (!isDuplicate) {
                filtered.push(candidate);
            }
        }
        
        // Sort by sync score (best first)
        filtered.sort((a, b) => b.syncScore - a.syncScore);
        
        // Limit number of candidates
        return filtered.slice(0, this.maxCandidates);
    }
    
    // Get best candidate for decoding
    getBestCandidate() {
        if (this.candidates.length === 0) return null;
        return this.candidates[0];
    }
    
    // Reset detector state
    reset() {
        this.audioBuffer = [];
        this.slotAudioBuffer = [];
        this.candidates = [];
        this.currentSlot = -1;
        this.processingComplete = false;
    }
}

// Export to global scope
window.FT8SignalDetector = FT8SignalDetector;

console.log('✅ FT8 Signal Detector loaded');