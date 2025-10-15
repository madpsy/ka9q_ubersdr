/**
 * RTTY Decoder Extension for ka9q UberSDR
 * 
 * Decodes RTTY (Radioteletype) signals using FSK demodulation
 * Supports Baudot (ITA2) and ASCII encoding
 * Standard rates: 45.45, 50, 75 baud
 * Standard shifts: 170, 200, 425, 850 Hz
 */

class RTTYDecoder extends DecoderExtension {
    constructor() {
        super('rtty-decoder', {
            displayName: 'RTTY Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: { low: 0, high: 3000 }
        });

        // RTTY parameters
        this.baudRate = 45.45;  // Standard RTTY baud rate
        this.shift = 170;       // Standard RTTY shift in Hz
        this.encoding = 'baudot'; // 'baudot' or 'ascii'
        this.polarity = 'normal'; // 'normal' or 'reverse'

        // Audio processing
        this.sampleRate = 48000;
        this.audioBuffer = [];
        this.bufferSize = 4096;
        
        // FSK demodulation state
        this.markFreq = 2125;   // Mark frequency (default center + shift/2)
        this.spaceFreq = 1955;  // Space frequency (default center - shift/2)
        this.centerFreq = 2040; // Center frequency
        
        // Bit detection
        this.samplesPerBit = 0;
        this.bitPhase = 0;
        this.lastBit = 0;
        this.bitBuffer = 0;
        this.bitCount = 0;
        
        // Baudot state machine
        this.baudotMode = 'letters'; // 'letters' or 'figures'
        
        // Output
        this.decodedText = '';
        this.charCount = 0;
        
        // Signal detection
        this.markMagnitude = 0;
        this.spaceMagnitude = 0;
        this.signalStrength = 0;
        
        // Goertzel filter state for mark and space
        this.goertzelMark = { q1: 0, q2: 0, coeff: 0 };
        this.goertzelSpace = { q1: 0, q2: 0, coeff: 0 };
        
        // Debug
        this.debugEnabled = true;
        this.lastDebugTime = 0;
    }

    onInitialize() {
        this.radio.log('RTTY Decoder initialized', 'info');
        this.updateFrequencies();
        this.calculateGoertzelCoefficients();
    }

    onEnable() {
        const template = window.rtty_decoder_template;
        if (!template) {
            this.radio.log('RTTY template not found', 'error');
            return;
        }

        // Get the content element (works for both panel and modal)
        const container = this.getContentElement();
        if (container) {
            container.innerHTML = template;
        }
        
        // Use setTimeout to ensure DOM is ready before attaching listeners
        setTimeout(() => {
            this.setupEventListeners();
        }, 0);
        
        this.updateStatusBadge('ACTIVE', 'active');
        this.updateDisplay();
        
        this.radio.log('RTTY Decoder enabled', 'info');
    }

    onDisable() {
        this.updateStatusBadge('IDLE', '');
        this.radio.log('RTTY Decoder disabled', 'info');
    }

    setupEventListeners() {
        // Use event delegation on document to catch clicks from both panel and modal
        document.addEventListener('click', (e) => {
            // Clear button
            if (e.target.id === 'rtty-clear-button' || e.target.closest('#rtty-clear-button')) {
                console.log('RTTY: Clear button clicked');
                this.decodedText = '';
                this.charCount = 0;
                this.updateDisplay();
                this.logDebug('Output cleared');
                e.preventDefault();
                e.stopPropagation();
            }
            
            // Auto tune button
            if (e.target.id === 'rtty-auto-tune' || e.target.closest('#rtty-auto-tune')) {
                console.log('RTTY: Auto tune button clicked');
                this.autoTune();
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // Use event delegation for change events
        document.addEventListener('change', (e) => {
            // Baud rate selector
            if (e.target.id === 'rtty-baud-rate') {
                this.baudRate = parseFloat(e.target.value);
                this.updateFrequencies();
                this.calculateGoertzelCoefficients();
                this.logDebug(`Baud rate changed to ${this.baudRate}`);
            }

            // Shift selector
            if (e.target.id === 'rtty-shift') {
                this.shift = parseInt(e.target.value);
                this.updateFrequencies();
                this.calculateGoertzelCoefficients();
                this.logDebug(`Shift changed to ${this.shift} Hz`);
            }

            // Encoding selector
            if (e.target.id === 'rtty-encoding') {
                this.encoding = e.target.value;
                this.logDebug(`Encoding changed to ${this.encoding}`);
            }

            // Polarity selector
            if (e.target.id === 'rtty-polarity') {
                this.polarity = e.target.value;
                this.logDebug(`Polarity changed to ${this.polarity}`);
            }
        });
        
        // Set initial values
        const baudSelect = document.getElementById('rtty-baud-rate');
        if (baudSelect) baudSelect.value = this.baudRate.toString();
        
        const shiftSelect = document.getElementById('rtty-shift');
        if (shiftSelect) shiftSelect.value = this.shift.toString();
        
        const encodingSelect = document.getElementById('rtty-encoding');
        if (encodingSelect) encodingSelect.value = this.encoding;
        
        const polaritySelect = document.getElementById('rtty-polarity');
        if (polaritySelect) polaritySelect.value = this.polarity;
        
        console.log('RTTY: Event listeners attached using delegation');
    }

    updateFrequencies() {
        // Calculate mark and space frequencies based on center and shift
        this.markFreq = this.centerFreq + (this.shift / 2);
        this.spaceFreq = this.centerFreq - (this.shift / 2);
        this.samplesPerBit = this.sampleRate / this.baudRate;
        
        // Use helper method for automatic modal support
        this.updateElementById('rtty-mark-freq', (el) => {
            el.textContent = this.markFreq.toFixed(1);
        });
        this.updateElementById('rtty-space-freq', (el) => {
            el.textContent = this.spaceFreq.toFixed(1);
        });
    }

    calculateGoertzelCoefficients() {
        // Calculate Goertzel coefficients for mark and space frequencies
        const k_mark = Math.round((this.bufferSize * this.markFreq) / this.sampleRate);
        const k_space = Math.round((this.bufferSize * this.spaceFreq) / this.sampleRate);
        
        this.goertzelMark.coeff = 2 * Math.cos((2 * Math.PI * k_mark) / this.bufferSize);
        this.goertzelSpace.coeff = 2 * Math.cos((2 * Math.PI * k_space) / this.bufferSize);
    }

    onProcessAudio(dataArray) {
        if (!this.enabled) return;

        // Add samples to buffer
        for (let i = 0; i < dataArray.length; i++) {
            this.audioBuffer.push(dataArray[i]);
        }

        // Process when we have enough samples
        while (this.audioBuffer.length >= this.bufferSize) {
            const samples = this.audioBuffer.splice(0, this.bufferSize);
            this.processBlock(samples);
        }
    }

    processBlock(samples) {
        // Reset Goertzel filters
        this.goertzelMark.q1 = 0;
        this.goertzelMark.q2 = 0;
        this.goertzelSpace.q1 = 0;
        this.goertzelSpace.q2 = 0;

        // Apply Goertzel algorithm for both mark and space frequencies
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            
            // Mark frequency
            const q0_mark = this.goertzelMark.coeff * this.goertzelMark.q1 - this.goertzelMark.q2 + sample;
            this.goertzelMark.q2 = this.goertzelMark.q1;
            this.goertzelMark.q1 = q0_mark;
            
            // Space frequency
            const q0_space = this.goertzelSpace.coeff * this.goertzelSpace.q1 - this.goertzelSpace.q2 + sample;
            this.goertzelSpace.q2 = this.goertzelSpace.q1;
            this.goertzelSpace.q1 = q0_space;
        }

        // Calculate magnitudes
        this.markMagnitude = Math.sqrt(
            this.goertzelMark.q1 * this.goertzelMark.q1 + 
            this.goertzelMark.q2 * this.goertzelMark.q2 - 
            this.goertzelMark.q1 * this.goertzelMark.q2 * this.goertzelMark.coeff
        );
        
        this.spaceMagnitude = Math.sqrt(
            this.goertzelSpace.q1 * this.goertzelSpace.q1 + 
            this.goertzelSpace.q2 * this.goertzelSpace.q2 - 
            this.goertzelSpace.q1 * this.goertzelSpace.q2 * this.goertzelSpace.coeff
        );

        // Determine bit value (mark = 1, space = 0)
        let bit = this.markMagnitude > this.spaceMagnitude ? 1 : 0;
        
        // Apply polarity
        if (this.polarity === 'reverse') {
            bit = 1 - bit;
        }

        // Update signal strength
        this.signalStrength = Math.max(this.markMagnitude, this.spaceMagnitude);
        const signalDb = 20 * Math.log10(this.signalStrength + 1e-10);
        this.updateSignalStrength(Math.max(0, Math.min(100, (signalDb + 60) / 60 * 100)));
        this.updateElementById('rtty-signal-value', (el) => {
            el.textContent = signalDb.toFixed(1) + ' dB';
        });

        // Bit sampling and decoding
        this.decodeBit(bit);
    }

    decodeBit(bit) {
        // Improved bit sampling with synchronization
        this.bitPhase += this.bufferSize;
        
        if (this.bitPhase >= this.samplesPerBit) {
            this.bitPhase -= this.samplesPerBit;
            
            // Detect start bit (transition from mark to space)
            if (this.bitCount === 0 && bit === 0 && this.lastBit === 1) {
                // Start bit detected - resync timing
                this.bitPhase = this.samplesPerBit / 2;  // Sample in middle of next bit
                this.bitCount = 1;
                this.bitBuffer = 0;
                if (Math.random() < 0.02) {  // 2% of start bits
                    this.logDebug(`Start bit detected, resynced timing`);
                }
            } else if (this.bitCount > 0 && this.bitCount <= 5) {
                // Data bits (5 bits for Baudot, 7-8 for ASCII)
                this.bitBuffer |= (bit << (this.bitCount - 1));
                this.bitCount++;
            } else if (this.bitCount > 5) {
                // Stop bit(s) - should be mark (1)
                if (bit === 1) {
                    // Valid character received
                    const binaryStr = this.bitBuffer.toString(2).padStart(5, '0');
                    if (Math.random() < 0.05) {  // 5% of characters
                        this.logDebug(`✓ Decoded: 0b${binaryStr} (0x${this.bitBuffer.toString(16)})`);
                    }
                    this.decodeCharacter(this.bitBuffer);
                } else {
                    // Framing error - resync on next start bit
                    if (Math.random() < 0.02) {  // 2% of framing errors
                        this.logDebug(`✗ Framing error: stop=${bit}, resetting`);
                    }
                }
                this.bitCount = 0;
                this.bitBuffer = 0;
            }
            
            this.lastBit = bit;
        }
    }

    decodeCharacter(code) {
        let char = '';
        
        if (this.encoding === 'baudot') {
            char = this.decodeBaudot(code);
        } else {
            // ASCII decoding
            char = String.fromCharCode(code);
        }
        
        if (char) {
            this.decodedText += char;
            this.charCount++;
            this.updateDisplay();
        }
    }

    decodeBaudot(code) {
        // Baudot (ITA2) character tables
        const lettersTable = {
            0x00: '\0', 0x01: 'E', 0x02: '\n', 0x03: 'A', 0x04: ' ',
            0x05: 'S', 0x06: 'I', 0x07: 'U', 0x08: '\r', 0x09: 'D',
            0x0A: 'R', 0x0B: 'J', 0x0C: 'N', 0x0D: 'F', 0x0E: 'C',
            0x0F: 'K', 0x10: 'T', 0x11: 'Z', 0x12: 'L', 0x13: 'W',
            0x14: 'H', 0x15: 'Y', 0x16: 'P', 0x17: 'Q', 0x18: 'O',
            0x19: 'B', 0x1A: 'G', 0x1B: 'FIGS', 0x1C: 'M', 0x1D: 'X',
            0x1E: 'V', 0x1F: 'LTRS'
        };
        
        const figuresTable = {
            0x00: '\0', 0x01: '3', 0x02: '\n', 0x03: '-', 0x04: ' ',
            0x05: "'", 0x06: '8', 0x07: '7', 0x08: '\r', 0x09: '$',
            0x0A: '4', 0x0B: '\a', 0x0C: ',', 0x0D: '!', 0x0E: ':',
            0x0F: '(', 0x10: '5', 0x11: '+', 0x12: ')', 0x13: '2',
            0x14: '#', 0x15: '6', 0x16: '0', 0x17: '1', 0x18: '9',
            0x19: '?', 0x1A: '&', 0x1B: 'FIGS', 0x1C: '.', 0x1D: '/',
            0x1E: ';', 0x1F: 'LTRS'
        };
        
        // Check for mode shift characters
        if (code === 0x1F) {
            this.baudotMode = 'letters';
            return '';
        } else if (code === 0x1B) {
            this.baudotMode = 'figures';
            return '';
        }
        
        // Decode based on current mode
        const table = this.baudotMode === 'letters' ? lettersTable : figuresTable;
        return table[code] || '';
    }

    updateStatusBadge(text, className) {
        // Override base class to use our custom ID
        this.updateElementById('rtty-status-badge', (el) => {
            el.textContent = text;
            el.className = `status-badge ${className}`;
        });
    }

    autoTune() {
        // Real auto-tune: scan audio spectrum to find strongest RTTY signal
        console.log('RTTY: autoTune() called');
        this.logDebug('Auto-tune: Scanning spectrum...');
        
        // Update badge first
        console.log('RTTY: Updating badge to TUNING');
        this.updateStatusBadge('TUNING', 'synced');
        
        // Get audio analyser
        const analyser = this.radio.getVUAnalyser();
        console.log('RTTY: Analyser:', analyser ? 'found' : 'NOT FOUND');
        if (!analyser) {
            this.logDebug('Auto-tune: No audio analyser available');
            console.log('RTTY: No analyser, returning');
            this.updateStatusBadge('ACTIVE', 'active');
            return;
        }

        const audioCtx = this.radio.getAudioContext();
        console.log('RTTY: Audio context:', audioCtx ? 'found' : 'NOT FOUND');
        if (!audioCtx) {
            this.logDebug('Auto-tune: No audio context available');
            console.log('RTTY: No audio context, returning');
            this.updateStatusBadge('ACTIVE', 'active');
            return;
        }

        // Get frequency spectrum data
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyser.getFloatFrequencyData(dataArray);

        const sampleRate = audioCtx.sampleRate;
        const nyquist = sampleRate / 2;

        // Calculate the audio bandwidth bin range (same as CW decoder and app.js)
        const bandwidth = this.radio.getBandwidth();
        let binStartFreq, binEndFreq;

        // Use the same logic as app.js getFrequencyBinMapping
        if (Math.abs(bandwidth.low) < 500 && Math.abs(bandwidth.high) < 500) {
            // CW mode: center on 500 Hz offset
            const cwOffset = 500;
            const halfBW = Math.max(Math.abs(bandwidth.low), Math.abs(bandwidth.high));
            binStartFreq = Math.max(0, cwOffset - halfBW);
            binEndFreq = cwOffset + halfBW;
        } else if (bandwidth.low < 0 && bandwidth.high > 0) {
            // AM/SAM/FM: spans zero
            binStartFreq = 0;
            binEndFreq = Math.max(Math.abs(bandwidth.low), Math.abs(bandwidth.high));
        } else if (bandwidth.low < 0 && bandwidth.high <= 0) {
            // LSB: convert negative to positive
            binStartFreq = Math.abs(bandwidth.high);
            binEndFreq = Math.abs(bandwidth.low);
        } else {
            // USB: use as-is
            binStartFreq = Math.max(0, bandwidth.low);
            binEndFreq = bandwidth.high;
        }

        this.logDebug(`Auto-tune: Scanning ${binStartFreq.toFixed(0)}-${binEndFreq.toFixed(0)} Hz audio bandwidth`);

        // Search for strongest pair of tones separated by the shift frequency
        let bestScore = -Infinity;
        let bestCenterFreq = this.centerFreq;

        // Scan within the actual audio bandwidth, ensuring room for both tones
        const minFreq = Math.max(binStartFreq + this.shift/2, 500);
        const maxFreq = Math.min(binEndFreq - this.shift/2, 2500);
        const step = 25; // Hz

        this.logDebug(`Auto-tune: Scanning ${minFreq.toFixed(0)}-${maxFreq.toFixed(0)} Hz for RTTY pairs`);

        for (let centerFreq = minFreq; centerFreq <= maxFreq; centerFreq += step) {
            const markFreq = centerFreq + (this.shift / 2);
            const spaceFreq = centerFreq - (this.shift / 2);

            // Convert frequencies to bin indices
            const markBin = Math.round((markFreq / nyquist) * bufferLength);
            const spaceBin = Math.round((spaceFreq / nyquist) * bufferLength);

            // Check if bins are in valid range
            if (markBin >= bufferLength || spaceBin < 0) continue;

            // Get power at mark and space frequencies (average nearby bins for stability)
            const markPower = this.getAveragePower(dataArray, markBin, 2);
            const spacePower = this.getAveragePower(dataArray, spaceBin, 2);

            // Score is the AVERAGE of both tones (not sum - dB values don't add linearly!)
            // We want both tones to be present and strong
            const score = (markPower + spacePower) / 2;

            if (score > bestScore) {
                bestScore = score;
                bestCenterFreq = centerFreq;
            }
        }

        // Get detailed info about the best signal found
        if (bestCenterFreq > 0) {
            const markFreq = bestCenterFreq + (this.shift / 2);
            const spaceFreq = bestCenterFreq - (this.shift / 2);
            const markBin = Math.round((markFreq / nyquist) * bufferLength);
            const spaceBin = Math.round((spaceFreq / nyquist) * bufferLength);
            
            const markPower = this.getAveragePower(dataArray, markBin, 2);
            const spacePower = this.getAveragePower(dataArray, spaceBin, 2);
            const separation = markFreq - spaceFreq;
            
            // Log detailed peak information
            this.logDebug(`Auto-tune: Best signal at ${bestCenterFreq.toFixed(0)} Hz (avg: ${bestScore.toFixed(1)} dB)`);
            this.logDebug(`  Mark:  ${markFreq.toFixed(1)} Hz @ ${markPower.toFixed(1)} dB`);
            this.logDebug(`  Space: ${spaceFreq.toFixed(1)} Hz @ ${spacePower.toFixed(1)} dB`);
            this.logDebug(`  Separation: ${separation.toFixed(1)} Hz (expected: ${this.shift} Hz)`);
            
            console.log(`RTTY: Best score: ${bestScore.toFixed(1)} dB at ${bestCenterFreq.toFixed(0)} Hz`);
            console.log(`RTTY: Mark=${markFreq.toFixed(1)} Hz (${markPower.toFixed(1)} dB), Space=${spaceFreq.toFixed(1)} Hz (${spacePower.toFixed(1)} dB)`);
        }
        
        // Use -70 dB threshold (reasonable for averaged tone power)
        if (bestScore > -70 && isFinite(bestScore)) {
            const oldCenter = this.centerFreq;
            this.centerFreq = bestCenterFreq;
            this.updateFrequencies();
            this.calculateGoertzelCoefficients();
            
            this.logDebug(`Auto-tune: ✓ Tuned from ${oldCenter.toFixed(0)} Hz to ${bestCenterFreq.toFixed(0)} Hz`);
            console.log(`RTTY: Tuned to ${bestCenterFreq.toFixed(0)} Hz`);
        } else {
            this.logDebug(`Auto-tune: ✗ Score ${bestScore.toFixed(1)} dB too weak (threshold -70 dB)`);
            this.logDebug('Auto-tune: Keeping current frequency');
            console.log('RTTY: No strong signal found');
        }

        console.log('RTTY: Updating badge back to ACTIVE');
        this.updateStatusBadge('ACTIVE', 'active');
        console.log('RTTY: autoTune() complete');
    }

    getAveragePower(dataArray, centerBin, radius) {
        // Average power across nearby bins for more stable measurement
        let sum = 0;
        let count = 0;
        
        for (let i = centerBin - radius; i <= centerBin + radius; i++) {
            if (i >= 0 && i < dataArray.length && isFinite(dataArray[i])) {
                sum += dataArray[i];
                count++;
            }
        }
        
        return count > 0 ? sum / count : -Infinity;
    }

    updateDisplay() {
        // Update decoded text output - works in both panel and modal
        this.updateElementById('rtty-output', (el) => {
            el.textContent = this.decodedText;
            // Auto-scroll to bottom
            el.scrollTop = el.scrollHeight;
        });
        
        // Update character count
        this.updateElementById('rtty-char-count', (el) => {
            el.textContent = `${this.charCount} chars`;
        });
    }

    logDebug(message) {
        if (!this.debugEnabled) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const debugLine = `[${timestamp}] ${message}\n`;
        
        console.log('RTTY Debug:', message);
        
        // Use updateElementById for automatic modal support
        this.updateElementById('rtty-debug-output', (el) => {
            el.textContent += debugLine;
            el.scrollTop = el.scrollHeight;
        });
    }

    getContentElement() {
        // Get the decoder extension content element (works for both panel and modal)
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new RTTYDecoder());
    console.log('✅ RTTY Decoder registered');
} else {
    console.error('❌ DecoderManager not found - RTTY Decoder not registered');
}