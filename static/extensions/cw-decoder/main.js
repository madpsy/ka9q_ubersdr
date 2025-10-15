// CW Decoder Extension - Decodes Morse code (CW) signals
// Uses audio tone detection and timing analysis to decode CW

class CWDecoderExtension extends DecoderExtension {
    constructor() {
        super('cw-decoder', {
            displayName: 'CW Decoder',
            autoTune: false,
            requiresMode: 'cwu',
            preferredBandwidth: { low: -250, high: 250 }
        });

        // Morse code table
        this.morseTable = {
            '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
            '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
            '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
            '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
            '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
            '--..': 'Z',
            '-----': '0', '.----': '1', '..---': '2', '...--': '3',
            '....-': '4', '.....': '5', '-....': '6', '--...': '7',
            '---..': '8', '----.': '9',
            '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'",
            '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')',
            '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=',
            '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"',
            '...-..-': '$', '.--.-.': '@', '...---...': 'SOS'
        };

        // Decoder state
        this.decodedText = '';
        this.currentSymbol = '';
        this.lastUpdateTime = 0;
        
        // Signal detection
        this.signalPresent = false;
        this.signalStartTime = 0;
        this.signalEndTime = 0;
        this.silenceStartTime = 0;
        
        // Timing parameters (adaptive)
        this.dotLength = 100; // ms, will be auto-adjusted
        this.dashLength = 300; // ms, typically 3x dot length
        this.symbolGap = 100; // ms, gap between dots/dashes
        this.letterGap = 300; // ms, gap between letters
        this.wordGap = 700; // ms, gap between words
        
        // Timing history for adaptive speed detection
        this.timingHistory = [];
        this.maxTimingHistory = 10;
        
        // Tone detection
        this.targetFrequency = 700; // Hz, typical CW tone
        this.frequencyTolerance = 100; // Hz
        this.signalThreshold = -40; // dB
        
        // Statistics
        this.wpm = 0;
        this.signalStrength = 0;
        this.detectedFrequency = 0;
        this.characterCount = 0;
        this.wordCount = 0;
        
        // Processing
        this.updateInterval = null;
        this.lastProcessTime = 0;
        this.processInterval = 10; // ms between processing cycles
    }

    onInitialize() {
        this.radio.log('CW Decoder Extension initialized');
        this.renderUI();
    }

    onEnable() {
        this.radio.log('CW Decoder enabled');
        
        // Reset state
        this.decodedText = '';
        this.currentSymbol = '';
        this.signalPresent = false;
        this.characterCount = 0;
        this.wordCount = 0;
        this.timingHistory = [];
        
        // Start processing
        this.lastProcessTime = Date.now();
        this.updateInterval = setInterval(() => {
            this.updateUI();
        }, 100);
        
        this.updateDisplay();
        this.updateStatusBadge('LISTENING', 'decoder-listening');
    }

    onDisable() {
        this.radio.log('CW Decoder disabled');
        
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        this.updateStatusBadge('DISABLED', 'decoder-disabled');
    }

    onProcessAudio(dataArray) {
        const now = Date.now();
        
        // Throttle processing
        if (now - this.lastProcessTime < this.processInterval) {
            return;
        }
        this.lastProcessTime = now;
        
        // Get audio analyser for frequency detection
        const analyser = this.radio.getVUAnalyser();
        if (!analyser) return;
        
        // Get frequency spectrum
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);
        
        const audioCtx = this.radio.getAudioContext();
        if (!audioCtx) return;
        
        const sampleRate = audioCtx.sampleRate;
        const nyquist = sampleRate / 2;
        
        // Detect tone around target frequency
        const targetBin = Math.floor((this.targetFrequency / nyquist) * freqData.length);
        const binRange = Math.floor((this.frequencyTolerance / nyquist) * freqData.length);
        
        // Find peak in target frequency range
        let peakAmplitude = 0;
        let peakBin = targetBin;
        
        for (let i = Math.max(0, targetBin - binRange); 
             i < Math.min(freqData.length, targetBin + binRange); 
             i++) {
            if (freqData[i] > peakAmplitude) {
                peakAmplitude = freqData[i];
                peakBin = i;
            }
        }
        
        // Convert to dB
        const peakDb = 20 * Math.log10(peakAmplitude / 255);
        this.signalStrength = peakDb;
        this.detectedFrequency = (peakBin / freqData.length) * nyquist;
        
        // Detect signal presence
        const signalDetected = peakDb > this.signalThreshold;
        
        // State machine for CW decoding
        if (signalDetected && !this.signalPresent) {
            // Signal started (key down)
            this.signalPresent = true;
            this.signalStartTime = now;
            
            // Check silence duration before this signal
            if (this.silenceStartTime > 0) {
                const silenceDuration = now - this.silenceStartTime;
                this.processSilence(silenceDuration);
            }
            
            this.updateStatusBadge('DECODING', 'decoder-active');
            
        } else if (!signalDetected && this.signalPresent) {
            // Signal ended (key up)
            this.signalPresent = false;
            this.signalEndTime = now;
            this.silenceStartTime = now;
            
            // Process the signal duration
            const signalDuration = now - this.signalStartTime;
            this.processSignal(signalDuration);
            
            this.updateStatusBadge('LISTENING', 'decoder-listening');
        }
        
        // Update signal strength meter
        const strength = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));
        this.updateSignalStrength(strength / 100);
    }

    processSignal(duration) {
        // Determine if this is a dot or dash
        // Use adaptive timing based on history
        
        const threshold = (this.dotLength + this.dashLength) / 2;
        
        if (duration < threshold) {
            // Dot
            this.currentSymbol += '.';
            this.updateTimingHistory(duration, 'dot');
        } else {
            // Dash
            this.currentSymbol += '-';
            this.updateTimingHistory(duration, 'dash');
        }
        
        this.lastUpdateTime = Date.now();
    }

    processSilence(duration) {
        // Determine what the silence means
        
        if (duration > this.wordGap) {
            // Word gap - decode current symbol and add space
            this.decodeCurrentSymbol();
            if (this.decodedText.length > 0 && !this.decodedText.endsWith(' ')) {
                this.decodedText += ' ';
                this.wordCount++;
                this.updateDisplay();
            }
        } else if (duration > this.letterGap) {
            // Letter gap - decode current symbol
            this.decodeCurrentSymbol();
        }
        // If less than letter gap, it's just a gap between dots/dashes in same letter
    }

    decodeCurrentSymbol() {
        if (this.currentSymbol.length === 0) return;
        
        const character = this.morseTable[this.currentSymbol];
        
        if (character) {
            this.decodedText += character;
            this.characterCount++;
            this.updateDisplay();
        } else if (this.currentSymbol.length > 0) {
            // Unknown symbol, show as [?]
            this.decodedText += '[?]';
            this.updateDisplay();
        }
        
        this.currentSymbol = '';
    }

    updateTimingHistory(duration, type) {
        this.timingHistory.push({ duration, type, time: Date.now() });
        
        // Keep only recent history
        if (this.timingHistory.length > this.maxTimingHistory) {
            this.timingHistory.shift();
        }
        
        // Adapt timing parameters based on history
        this.adaptTiming();
    }

    adaptTiming() {
        if (this.timingHistory.length < 3) return;
        
        // Calculate average dot and dash lengths
        const dots = this.timingHistory.filter(t => t.type === 'dot');
        const dashes = this.timingHistory.filter(t => t.type === 'dash');
        
        if (dots.length > 0) {
            const avgDot = dots.reduce((sum, t) => sum + t.duration, 0) / dots.length;
            this.dotLength = avgDot;
        }
        
        if (dashes.length > 0) {
            const avgDash = dashes.reduce((sum, t) => sum + t.duration, 0) / dashes.length;
            this.dashLength = avgDash;
        }
        
        // Update derived timings
        this.symbolGap = this.dotLength;
        this.letterGap = this.dotLength * 3;
        this.wordGap = this.dotLength * 7;
        
        // Calculate WPM (Words Per Minute)
        // Standard: PARIS = 50 dot lengths
        // WPM = 1200 / dot_length_ms
        this.wpm = Math.round(1200 / this.dotLength);
    }

    renderUI() {
        const template = window.cw_decoder_template;
        
        if (!template) {
            console.error('CW Decoder template not loaded');
            return;
        }
        
        const container = this.getContentElement();
        if (!container) return;
        
        container.innerHTML = template;
        
        // Add clear button handler
        const clearBtn = document.getElementById('cw-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearDecoded());
        }
        
        // Add copy button handler
        const copyBtn = document.getElementById('cw-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyDecoded());
        }
        
        // Add frequency adjustment handlers
        const freqInput = document.getElementById('cw-freq-input');
        if (freqInput) {
            freqInput.value = this.targetFrequency;
            freqInput.addEventListener('change', (e) => {
                this.targetFrequency = parseInt(e.target.value) || 700;
            });
        }
        
        const thresholdInput = document.getElementById('cw-threshold-input');
        if (thresholdInput) {
            thresholdInput.value = this.signalThreshold;
            thresholdInput.addEventListener('change', (e) => {
                this.signalThreshold = parseInt(e.target.value) || -40;
            });
        }
    }

    updateUI() {
        // Update statistics
        this.updateElementById('cw-wpm', (el) => {
            el.textContent = this.wpm > 0 ? `${this.wpm} WPM` : 'Detecting...';
        });
        
        this.updateElementById('cw-chars', (el) => {
            el.textContent = this.characterCount;
        });
        
        this.updateElementById('cw-words', (el) => {
            el.textContent = this.wordCount;
        });
        
        this.updateElementById('cw-signal-strength', (el) => {
            el.textContent = this.signalStrength.toFixed(1) + ' dB';
        });
        
        this.updateElementById('cw-detected-freq', (el) => {
            el.textContent = Math.round(this.detectedFrequency) + ' Hz';
        });
        
        this.updateElementById('cw-current-symbol', (el) => {
            el.textContent = this.currentSymbol || '(none)';
        });
        
        this.updateElementById('cw-dot-length', (el) => {
            el.textContent = Math.round(this.dotLength) + ' ms';
        });
        
        // Check for timeout on current symbol
        const now = Date.now();
        if (this.currentSymbol.length > 0 && 
            now - this.lastUpdateTime > this.letterGap * 2) {
            // Timeout - decode what we have
            this.decodeCurrentSymbol();
        }
    }

    clearDecoded() {
        this.decodedText = '';
        this.currentSymbol = '';
        this.characterCount = 0;
        this.wordCount = 0;
        this.updateDisplay();
        this.radio.log('Decoded text cleared');
    }

    copyDecoded() {
        if (this.decodedText.length === 0) {
            this.radio.log('No text to copy', 'warning');
            return;
        }
        
        navigator.clipboard.writeText(this.decodedText).then(() => {
            this.radio.log('Decoded text copied to clipboard');
            
            // Visual feedback
            const copyBtn = document.getElementById('cw-copy-btn');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                }, 2000);
            }
        }).catch(err => {
            this.radio.log('Failed to copy text: ' + err, 'error');
        });
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    onFrequencyChanged(frequency) {
        // Could auto-adjust target frequency based on tuned frequency
        this.radio.log(`Frequency changed to ${this.radio.formatFrequency(frequency)}`);
    }

    onModeChanged(mode) {
        if (mode !== 'cwu' && mode !== 'cwl') {
            this.radio.log('CW Decoder works best in CW mode', 'warning');
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new CWDecoderExtension());
    console.log('✅ CW Decoder Extension registered');
}