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
            autoTune: true,
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
        
        // Bit detection - state machine approach
        this.samplesPerBit = 0;
        this.sampleCounter = 0;  // Counts down samples within current bit/state
        this.lastBit = 1;  // Start in mark (idle) state
        this.bitBuffer = 0;
        this.bitCount = 0;
        
        // State machine states (matching C++ implementation)
        this.STATE_IDLE = 0;
        this.STATE_START = 1;
        this.STATE_DATA = 2;
        this.STATE_STOP = 3;
        this.STATE_STOP2 = 4;
        this.state = this.STATE_IDLE;
        
        // Baudot state machine
        this.baudotMode = 'letters'; // 'letters' or 'figures'
        
        // Output
        this.decodedText = '';
        this.charCount = 0;
        
        // Signal detection
        this.markMagnitude = 0;
        this.spaceMagnitude = 0;
        this.signalStrength = 0;
        this.signalPresent = false;
        this.squelchThreshold = -45;  // dB threshold for signal presence
        this.squelchHysteresis = 5;   // dB hysteresis to prevent flapping

        // Squelch averaging (1 second window)
        this.signalHistory = [];
        this.signalHistorySize = Math.ceil(1000 / (this.bufferSize / this.sampleRate * 1000)); // ~1 second of blocks
        this.averageSignalDb = -100;

        // Auto-tune control
        this.autoTuneInterval = 15000; // 15 seconds between auto-tunes
        this.lastAutoTuneTime = 0;
        this.autoTuneEnabled = true;
        
        // Goertzel filter state for mark and space
        this.goertzelMark = { q1: 0, q2: 0, coeff: 0 };
        this.goertzelSpace = { q1: 0, q2: 0, coeff: 0 };
        
        // Debug
        this.debugEnabled = true;
        this.lastDebugTime = 0;
        this.debugLines = [];
        this.maxDebugLines = 200;
    }

    onInitialize() {
        this.radio.log('RTTY Decoder initialized', 'info');
        this.updateFrequencies();
        this.calculateGoertzelCoefficients();
        this.logDebug(`Initialized: sampleRate=${this.sampleRate}, baudRate=${this.baudRate}, samplesPerBit=${this.samplesPerBit.toFixed(2)}`);
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

            // Copy debug button
            if (e.target.id === 'rtty-copy-debug' || e.target.closest('#rtty-copy-debug')) {
                console.log('RTTY: Copy debug button clicked');
                const debugText = this.debugLines.join('');
                navigator.clipboard.writeText(debugText).then(() => {
                    this.logDebug('Debug log copied to clipboard');
                }).catch(err => {
                    console.error('Failed to copy debug log:', err);
                    this.logDebug('Failed to copy debug log');
                });
                e.preventDefault();
                e.stopPropagation();
            }

            // Clear debug button
            if (e.target.id === 'rtty-clear-debug' || e.target.closest('#rtty-clear-debug')) {
                console.log('RTTY: Clear debug button clicked');
                this.debugLines = [];
                this.updateElementById('rtty-debug-output', (el) => {
                    el.textContent = '';
                });
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
                // Reset decoder state when changing baud rate
                this.bitCount = 0;
                this.bitPhase = 0;
                this.bitBuffer = 0;
                this.logDebug(`Baud rate changed to ${this.baudRate}, samplesPerBit=${this.samplesPerBit.toFixed(2)}`);
            }

            // Shift selector
            if (e.target.id === 'rtty-shift') {
                this.shift = parseInt(e.target.value);
                this.updateFrequencies();
                this.calculateGoertzelCoefficients();
                this.logDebug(`Shift changed to ${this.shift} Hz, mark=${this.markFreq.toFixed(1)}, space=${this.spaceFreq.toFixed(1)}`);
            }

            // Encoding selector
            if (e.target.id === 'rtty-encoding') {
                this.encoding = e.target.value;
                this.logDebug(`Encoding changed to ${this.encoding}`);
            }

            // Polarity selector
            if (e.target.id === 'rtty-polarity') {
                this.polarity = e.target.value;
                this.logDebug(`Polarity changed to ${this.polarity} (mark=${this.polarity === 'normal' ? '1' : '0'}, space=${this.polarity === 'normal' ? '0' : '1'})`);
            }
        });

        // Use event delegation for input events (for real-time slider updates)
        document.addEventListener('input', (e) => {
            // Squelch slider
            if (e.target.id === 'rtty-squelch') {
                this.squelchThreshold = parseFloat(e.target.value);
                this.updateElementById('rtty-squelch-value', (el) => {
                    el.textContent = `${this.squelchThreshold} dB`;
                });
                if (Math.random() < 0.1) {  // 10% logging to avoid spam
                    this.logDebug(`Squelch changed to ${this.squelchThreshold} dB`);
                }
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

        const squelchSlider = document.getElementById('rtty-squelch');
        if (squelchSlider) {
            squelchSlider.value = this.squelchThreshold.toString();
            this.updateElementById('rtty-squelch-value', (el) => {
                el.textContent = `${this.squelchThreshold} dB`;
            });
        }

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
        // Process block with Goertzel to get overall bit decision
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

        // Calculate magnitudes (normalized by buffer size)
        const markMagSq = (
            this.goertzelMark.q1 * this.goertzelMark.q1 +
            this.goertzelMark.q2 * this.goertzelMark.q2 -
            this.goertzelMark.q1 * this.goertzelMark.q2 * this.goertzelMark.coeff
        );
        
        const spaceMagSq = (
            this.goertzelSpace.q1 * this.goertzelSpace.q1 +
            this.goertzelSpace.q2 * this.goertzelSpace.q2 -
            this.goertzelSpace.q1 * this.goertzelSpace.q2 * this.goertzelSpace.coeff
        );

        // Normalize by buffer size to get consistent dB readings
        this.markMagnitude = Math.sqrt(markMagSq) / this.bufferSize;
        this.spaceMagnitude = Math.sqrt(spaceMagSq) / this.bufferSize;

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

        // Add to signal history for averaging
        this.signalHistory.push(signalDb);
        if (this.signalHistory.length > this.signalHistorySize) {
            this.signalHistory.shift();
        }

        // Calculate average signal level over last ~1 second
        if (this.signalHistory.length > 0) {
            this.averageSignalDb = this.signalHistory.reduce((a, b) => a + b, 0) / this.signalHistory.length;
        }

        // Check if AVERAGED signal is strong enough (squelch with hysteresis)
        // Hysteresis prevents flapping: once open, requires signal to drop more to close
        if (this.signalPresent) {
            // Currently open - close only if signal drops below (threshold - hysteresis)
            if (this.averageSignalDb < (this.squelchThreshold - this.squelchHysteresis)) {
                this.signalPresent = false;
            }
        } else {
            // Currently closed - open only if signal rises above threshold
            if (this.averageSignalDb > this.squelchThreshold) {
                this.signalPresent = true;
            }
        }

        // Update signal display with squelch status
        this.updateElementById('rtty-signal-value', (el) => {
            const squelchStatus = this.signalPresent ? '🟢 OPEN' : '🔴 CLOSED';
            el.textContent = `${signalDb.toFixed(1)} dB (avg: ${this.averageSignalDb.toFixed(1)}) ${squelchStatus}`;
        });

        // Only process bits if signal is present
        if (this.signalPresent) {
            // Process this block's bit decision through the state machine
            // We decrement the counter by the number of samples in this block
            // and make bit decisions when counter reaches zero
            this.processBitStateMachine(bit, samples.length);
        } else {
            // No signal - reset decoder state
            if (this.state !== this.STATE_IDLE) {
                this.state = this.STATE_IDLE;
                this.bitCount = 0;
                this.bitBuffer = 0;
                this.lastBit = 1;
                this.sampleCounter = 0;
            }
        }

        // Periodic auto-tune
        if (this.autoTuneEnabled) {
            const now = Date.now();
            if (now - this.lastAutoTuneTime > this.autoTuneInterval) {
                this.lastAutoTuneTime = now;
                this.autoTune();
            }
        }
    }

    processBitStateMachine(bit, sampleCount) {
        // State machine that processes blocks of samples
        // Matches C++ implementation logic exactly
        
        switch (this.state) {
            case this.STATE_IDLE:
                // Wait for start bit (space detected)
                if (bit === 0) {
                    // Start bit detected - move to START state
                    // Set counter to half symbol length to sample in middle of bits
                    this.sampleCounter = Math.floor(this.samplesPerBit / 2);
                    this.state = this.STATE_START;
                    this.logDebug(`✓ Start bit detected, counter=${this.sampleCounter}`);
                }
                break;

            case this.STATE_START:
                // Verify start bit is still space after half symbol
                this.sampleCounter -= sampleCount;
                if (this.sampleCounter <= 0) {
                    if (bit === 0) {
                        // Valid start bit - begin collecting data
                        this.sampleCounter = Math.floor(this.samplesPerBit);
                        this.bitCount = 0;
                        this.bitBuffer = 0;
                        this.state = this.STATE_DATA;
                        this.logDebug(`✓ Start bit confirmed, collecting data`);
                    } else {
                        // False start - back to idle
                        this.state = this.STATE_IDLE;
                        this.logDebug(`✗ False start bit`);
                    }
                }
                break;

            case this.STATE_DATA:
                // Collect data bits
                this.sampleCounter -= sampleCount;
                if (this.sampleCounter <= 0) {
                    // Sample the bit (LSB first for RTTY)
                    this.bitBuffer |= (bit << this.bitCount);
                    this.bitCount++;
                    this.sampleCounter = Math.floor(this.samplesPerBit);

                    const binaryStr = this.bitBuffer.toString(2).padStart(5, '0');
                    this.logDebug(`  Bit ${this.bitCount}: bit=${bit}, buffer=0b${binaryStr}, mark=${this.markMagnitude.toFixed(6)}, space=${this.spaceMagnitude.toFixed(6)}`);
                }

                // Check if we have all data bits (separate from counter check, like C++)
                if (this.bitCount >= 5) {
                    this.state = this.STATE_STOP;
                }
                break;

            case this.STATE_STOP:
                // Check stop bit
                this.sampleCounter -= sampleCount;
                if (this.sampleCounter <= 0) {
                    if (bit === 1) {
                        // Valid stop bit - decode character
                        const binaryStr = this.bitBuffer.toString(2).padStart(5, '0');
                        const char = this.decodeBaudot(this.bitBuffer);
                        this.logDebug(`✓ FINAL: 0b${binaryStr} (0x${this.bitBuffer.toString(16)}) = '${char}'`);

                        if (char) {
                            this.decodedText += char;
                            this.charCount++;
                            this.updateDisplay();
                        }
                    } else {
                        // Framing error
                        const binaryStr = this.bitBuffer.toString(2).padStart(5, '0');
                        this.logDebug(`✗ Framing error: stop bit=${bit}, buffer=0b${binaryStr}`);
                    }

                    // Move to STOP2 state (like C++)
                    this.state = this.STATE_STOP2;
                    this.sampleCounter = Math.floor(this.samplesPerBit / 2);
                    this.bitBuffer = 0;
                    this.bitCount = 0;
                }
                break;

            case this.STATE_STOP2:
                // Wait another half symbol before returning to idle (like C++)
                this.sampleCounter -= sampleCount;
                if (this.sampleCounter <= 0) {
                    this.state = this.STATE_IDLE;
                }
                break;
        }

        this.lastBit = bit;
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

    decodeBaudotCode(code) {
        // Just check if code is valid, don't update state
        const lettersTable = {
            0x00: '\0', 0x01: 'E', 0x02: '\n', 0x03: 'A', 0x04: ' ',
            0x05: 'S', 0x06: 'I', 0x07: 'U', 0x08: '\r', 0x09: 'D',
            0x0A: 'R', 0x0B: 'J', 0x0C: 'N', 0x0D: 'F', 0x0E: 'C',
            0x0F: 'K', 0x10: 'T', 0x11: 'Z', 0x12: 'L', 0x13: 'W',
            0x14: 'H', 0x15: 'Y', 0x16: 'P', 0x17: 'Q', 0x18: 'O',
            0x19: 'B', 0x1A: 'G', 0x1B: 'FIGS', 0x1C: 'M', 0x1D: 'X',
            0x1E: 'V', 0x1F: 'LTRS'
        };
        return lettersTable[code] !== undefined;
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
            // Letters shift
            this.baudotMode = 'letters';
            return '';
        } else if (code === 0x1B) {
            // Figures shift
            this.baudotMode = 'figures';
            return '';
        } else if (code === 0x04) {
            // Unshift-on-space (C++ line 466-468)
            // Space character automatically shifts back to letters mode
            this.baudotMode = 'letters';
            return ' ';
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
        this.logDebug('Auto-tune: Scanning...');
        
        this.updateStatusBadge('TUNING', 'synced');

        const analyser = this.radio.getVUAnalyser();
        const audioCtx = this.radio.getAudioContext();

        if (!analyser || !audioCtx) {
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

        // Search for strongest pair of tones separated by the shift frequency
        let bestScore = -Infinity;
        let bestCenterFreq = this.centerFreq;

        // Scan within the actual audio bandwidth, ensuring room for both tones
        const minFreq = Math.max(binStartFreq + this.shift/2, 500);
        const maxFreq = Math.min(binEndFreq - this.shift/2, 2500);
        const step = 50; // Hz - larger step for faster scanning

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
            
            // Only log if significantly different from current frequency
            if (Math.abs(bestCenterFreq - this.centerFreq) > 50) {
                this.logDebug(`Found signal at ${bestCenterFreq.toFixed(0)} Hz (${bestScore.toFixed(1)} dB)`);
            }
        }
        
        // Use -65 dB threshold and require significant frequency change to avoid jitter
        const freqChange = Math.abs(bestCenterFreq - this.centerFreq);
        if (bestScore > -65 && isFinite(bestScore) && freqChange > 50) {
            this.centerFreq = bestCenterFreq;
            this.updateFrequencies();
            this.calculateGoertzelCoefficients();
            this.logDebug(`Tuned to ${bestCenterFreq.toFixed(0)} Hz`);
        }

        this.updateStatusBadge('ACTIVE', 'active');
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

        // Add to debug lines array and limit to maxDebugLines
        this.debugLines.push(debugLine);
        if (this.debugLines.length > this.maxDebugLines) {
            this.debugLines.shift();
        }

        // Use updateElementById for automatic modal support
        this.updateElementById('rtty-debug-output', (el) => {
            el.textContent = this.debugLines.join('');
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