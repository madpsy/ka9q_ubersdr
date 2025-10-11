// CW Decoder Module for ka9q UberSDR
// Integrates with morse-pro library for real-time CW/Morse code decoding

class CWDecoder {
    constructor() {
        this.enabled = false;
        this.decoder = null;
        this.audioContext = null;
        this.analyser = null;
        this.processorNode = null;
        this.decodedText = '';
        this.maxTextLength = 1000; // Maximum characters to keep in buffer
        this.wpm = 20; // Default words per minute
        this.threshold = 0.0005; // Detection threshold (0-1) - 0.05% for weak signals
        this.centerFrequency = 400; // Default CW tone frequency in Hz
        
        // Goertzel algorithm state for tone detection
        this.goertzelCoeff = 0;
        this.goertzelQ1 = 0;
        this.goertzelQ2 = 0;
        this.sampleRate = 12000;
        this.targetFreq = 400;
        
        // Timing state for dot/dash detection
        this.signalState = false; // true = tone present, false = silence
        this.signalStartTime = 0;
        this.signalEndTime = 0;
        this.lastCharTime = 0;
        this.dotLength = 60; // ms, calculated from WPM
        this.currentSymbol = '';
        
        // Morse code table
        this.morseTable = {
            '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
            '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
            '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
            '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
            '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
            '--..': 'Z',
            '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
            '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
            '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'", '-.-.--': '!',
            '-..-.': '/', '-.--.': '(', '-.--.-': ')', '.-...': '&', '---...': ':',
            '-.-.-.': ';', '-...-': '=', '.-.-.': '+', '-....-': '-', '..--.-': '_',
            '.-..-.': '"', '...-..-': '$', '.--.-.': '@', '...---...': 'SOS'
        };
    }
    
    initialize(audioContext, analyser, centerFreq = 800) {
        this.audioContext = audioContext;
        this.analyser = analyser;
        this.sampleRate = audioContext.sampleRate;
        this.centerFrequency = centerFreq;
        this.targetFreq = centerFreq;
        
        // Calculate Goertzel coefficient for target frequency
        this.updateGoertzelCoeff();
        
        // Calculate dot length from WPM (PARIS standard: 50 dot units per word)
        this.updateTimingFromWPM();
        
        log('CW Decoder initialized at ' + centerFreq + ' Hz, ' + this.wpm + ' WPM');
    }
    
    updateGoertzelCoeff() {
        // Calculate the Goertzel coefficient for the target frequency
        // Use the actual sample rate from the audio context, not FFT size
        const omega = (2.0 * Math.PI * this.targetFreq) / this.sampleRate;
        this.goertzelCoeff = 2.0 * Math.cos(omega);
    }
    
    updateTimingFromWPM() {
        // PARIS standard: 50 dot units per word
        // At 20 WPM: 1 word = 60ms/20 = 3000ms, 1 dot = 3000/50 = 60ms
        this.dotLength = (60000 / this.wpm) / 50;
    }
    
    setWPM(wpm) {
        this.wpm = Math.max(5, Math.min(60, wpm)); // Clamp between 5-60 WPM
        this.updateTimingFromWPM();
        log('CW Decoder WPM set to ' + this.wpm);
    }
    
    setThreshold(threshold) {
        this.threshold = Math.max(0.1, Math.min(1.0, threshold));
        log('CW Decoder threshold set to ' + this.threshold.toFixed(2));
    }
    
    setCenterFrequency(freq) {
        this.centerFrequency = freq;
        this.targetFreq = freq;
        this.updateGoertzelCoeff();
        log('CW Decoder frequency set to ' + freq + ' Hz');
    }
    
    resetWPM() {
        this.observedDurations = [];
        this.wpm = null;
        const wpmElement = document.getElementById('cw-wpm-value');
        if (wpmElement) {
            wpmElement.textContent = '-- (auto-detecting)';
        }
        log('CW Decoder WPM reset - will auto-detect from signal');
    }
    
    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.decodedText = '';
        this.currentSymbol = '';
        this.signalState = false;
        this.goertzelQ1 = 0;
        this.goertzelQ2 = 0;
        this.updateDisplay();
        this.addCharacter('[CW DECODER ACTIVE]\n');
        log('CW Decoder enabled - listening for CW signals');
    }
    
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.addCharacter('\n[CW DECODER STOPPED]');
        log('CW Decoder disabled');
    }
    
    // Goertzel algorithm - frequency-selective tone detection
    detectTone(samples) {
        // Reset Goertzel state for new block
        this.goertzelQ1 = 0;
        this.goertzelQ2 = 0;
        
        // Process all samples through Goertzel filter
        for (let i = 0; i < samples.length; i++) {
            const q0 = this.goertzelCoeff * this.goertzelQ1 - this.goertzelQ2 + samples[i];
            this.goertzelQ2 = this.goertzelQ1;
            this.goertzelQ1 = q0;
        }
        
        // Calculate magnitude at target frequency using standard Goertzel formula
        // This gives us the power at the target frequency
        const N = samples.length;
        const omega = (2.0 * Math.PI * this.targetFreq) / this.sampleRate;
        const cosine = Math.cos(omega);
        const sine = Math.sin(omega);
        
        const real = this.goertzelQ1 - this.goertzelQ2 * cosine;
        const imag = this.goertzelQ2 * sine;
        
        // Calculate magnitude and normalize by N for proper scaling
        // Multiply by 2/N to match FFT magnitude scaling
        const magnitude = (2.0 / N) * Math.sqrt(real * real + imag * imag);
        
        return magnitude;
    }
    
    processAudio() {
        if (!this.enabled) {
            console.log('CW Decoder: not enabled');
            return;
        }
        
        if (!this.analyser) {
            console.log('CW Decoder: no analyser');
            return;
        }
        
        // Get time domain data
        const bufferLength = this.analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);
        this.analyser.getFloatTimeDomainData(dataArray);
        
        // Check if we're getting data
        let hasData = false;
        for (let i = 0; i < Math.min(100, dataArray.length); i++) {
            if (dataArray[i] !== 0) {
                hasData = true;
                break;
            }
        }
        
        if (!hasData && Math.random() < 0.01) {
            console.log('CW Decoder: WARNING - all audio samples are zero!');
        }
        
        // Detect tone using RMS
        const magnitude = this.detectTone(dataArray);
        
        // Simple noise gate: require signal to be significantly above recent average
        if (!this.recentMagnitudes) {
            this.recentMagnitudes = [];
        }
        this.recentMagnitudes.push(magnitude);
        if (this.recentMagnitudes.length > 30) { // Keep last 30 samples (~0.5 seconds at 60fps)
            this.recentMagnitudes.shift();
        }
        
        // Calculate average of recent magnitudes
        const avgMagnitude = this.recentMagnitudes.reduce((a, b) => a + b, 0) / this.recentMagnitudes.length;
        
        // Tone is present if current magnitude is 2x the recent average AND above threshold
        const tonePresent = magnitude > (avgMagnitude * 2) && magnitude > this.threshold;
        
        // Update signal strength display
        this.updateSignalStrength(magnitude);
        
        // Debug: Show signal strength every 100 frames (about once per second at 60fps)
        if (Math.random() < 0.01) {
            console.log(`CW Decoder: magnitude=${magnitude.toFixed(4)}, threshold=${this.threshold.toFixed(2)}, tone=${tonePresent}, fftSize=${bufferLength}, hasData=${hasData}`);
        }
        
        const now = Date.now();
        
        // State machine for dot/dash detection
        if (tonePresent && !this.signalState) {
            // Tone started
            this.signalState = true;
            this.signalStartTime = now;
            console.log('CW: TONE START');
            
            // Check for character gap (3 dot lengths)
            if (this.signalEndTime > 0 && (now - this.signalEndTime) > (this.dotLength * 3)) {
                this.decodeSymbol();
            }
            
            // Check for word gap (7 dot lengths)
            if (this.signalEndTime > 0 && (now - this.signalEndTime) > (this.dotLength * 7)) {
                this.addCharacter(' ');
            }
            
        } else if (!tonePresent && this.signalState) {
            // Tone ended
            this.signalState = false;
            this.signalEndTime = now;
            
            const duration = now - this.signalStartTime;
            
            // Auto-adapt dot length based on observed durations
            if (!this.observedDurations) {
                this.observedDurations = [];
            }
            this.observedDurations.push(duration);
            if (this.observedDurations.length > 20) {
                this.observedDurations.shift();
                // Use shortest duration as dot length estimate
                const minDuration = Math.min(...this.observedDurations);
                this.dotLength = minDuration * 1.2; // Add 20% margin
                
                // Calculate and display WPM from dot length
                // PARIS standard: 50 dot units per word
                // WPM = 60000 / (dotLength * 50)
                this.wpm = Math.round(60000 / (this.dotLength * 50));
                this.updateWPMDisplay();
            }
            
            console.log(`CW: TONE END - duration=${duration}ms, dotLength=${this.dotLength.toFixed(0)}ms`);
            
            // Classify as dot or dash (dash = 3x dot length)
            if (duration < (this.dotLength * 2)) {
                this.currentSymbol += '.';
                console.log('CW: Added DOT');
            } else {
                this.currentSymbol += '-';
                console.log('CW: Added DASH');
            }
        }
        
        // Auto-decode if symbol is getting long or timeout
        if (this.currentSymbol.length > 0 && !this.signalState) {
            if ((now - this.signalEndTime) > (this.dotLength * 3) || this.currentSymbol.length > 6) {
                this.decodeSymbol();
            }
        }
    }
    
    decodeSymbol() {
        if (this.currentSymbol.length === 0) return;
        
        const character = this.morseTable[this.currentSymbol];
        if (character) {
            this.addCharacter(character);
        } else {
            // Unknown symbol, add placeholder
            this.addCharacter('?');
        }
        
        this.currentSymbol = '';
    }
    
    addCharacter(char) {
        this.decodedText += char;
        
        // Trim if too long
        if (this.decodedText.length > this.maxTextLength) {
            this.decodedText = this.decodedText.substring(this.decodedText.length - this.maxTextLength);
        }
        
        this.updateDisplay();
    }
    
    updateDisplay() {
        const displayElement = document.getElementById('cw-decoded-text');
        if (displayElement) {
            displayElement.textContent = this.decodedText;
            // Auto-scroll to bottom
            displayElement.scrollTop = displayElement.scrollHeight;
        }
        
        const symbolElement = document.getElementById('cw-current-symbol');
        if (symbolElement) {
            symbolElement.textContent = this.currentSymbol || '—';
        }
    }
    
    updateWPMDisplay() {
        const wpmElement = document.getElementById('cw-wpm-value');
        if (wpmElement && this.wpm) {
            wpmElement.textContent = this.wpm + ' WPM (auto)';
        }
    }
    
    updateSignalStrength(magnitude) {
        const signalBar = document.getElementById('cw-signal-bar');
        const signalValue = document.getElementById('cw-signal-value');
        
        if (signalBar && signalValue) {
            // Convert magnitude to percentage (0-100%)
            const percentage = Math.min(100, magnitude * 100);
            signalBar.style.width = percentage + '%';
            signalValue.textContent = percentage.toFixed(0) + '%';
            
            // Color code: green if above threshold, yellow if close, red if below
            if (magnitude > this.threshold) {
                signalBar.style.background = '#28a745'; // Green - signal detected
            } else if (magnitude > this.threshold * 0.7) {
                signalBar.style.background = '#ffc107'; // Yellow - close to threshold
            } else {
                signalBar.style.background = '#6c757d'; // Gray - no signal
            }
        }
    }
    
    clearText() {
        this.decodedText = '';
        this.currentSymbol = '';
        this.updateDisplay();
        log('CW Decoder text cleared');
    }
    
    copyText() {
        if (this.decodedText.length === 0) return;
        
        navigator.clipboard.writeText(this.decodedText).then(() => {
            log('CW decoded text copied to clipboard');
        }).catch(err => {
            console.error('Failed to copy text:', err);
        });
    }
}

// Global instance
let cwDecoder = null;

// Initialize decoder when audio context is ready
function initializeCWDecoder(audioContext, analyser, centerFreq) {
    if (!cwDecoder) {
        cwDecoder = new CWDecoder();
    }
    cwDecoder.initialize(audioContext, analyser, centerFreq);
}

// Start processing audio for CW decoding
function startCWDecoding() {
    if (cwDecoder) {
        cwDecoder.enable();
    }
}

// Stop processing audio
function stopCWDecoding() {
    if (cwDecoder) {
        cwDecoder.disable();
    }
}

// Update decoder parameters
function updateCWDecoderWPM(wpm) {
    if (cwDecoder) {
        cwDecoder.setWPM(wpm);
    }
}

function updateCWDecoderThreshold(threshold) {
    if (cwDecoder) {
        cwDecoder.setThreshold(threshold);
    }
}

function updateCWDecoderFrequency(freq) {
    if (cwDecoder) {
        cwDecoder.setCenterFrequency(freq);
    }
}

// Clear decoded text
function clearCWText() {
    if (cwDecoder) {
        cwDecoder.clearText();
    }
}

// Copy decoded text to clipboard
function copyCWText() {
    if (cwDecoder) {
        cwDecoder.copyText();
    }
}

// Process audio (call this in animation loop)
function processCWAudio() {
    if (cwDecoder && cwDecoder.enabled) {
        cwDecoder.processAudio();
    }
}