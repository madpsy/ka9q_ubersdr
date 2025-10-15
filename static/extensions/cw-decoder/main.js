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
        this.signalThreshold = -40; // dB (manual threshold)
        this.autoTuneFrequency = false; // Auto-tune to detected frequency
        this.useAdaptiveThreshold = true; // Use noise floor + offset instead of fixed threshold
        this.thresholdAboveNoise = 6; // dB above noise floor for adaptive threshold (lower = more sensitive)
        this.hysteresis = 3; // dB hysteresis for key up/down (prevents flutter)
        this.noiseFloor = -120; // Calculated noise floor
        
        // Noise floor smoothing (like app.js lines 3717-3792)
        this.noiseFloorHistory = [];
        this.noiseFloorHistoryMaxAge = 2000; // 2 second window for stable noise floor
        
        // Auto-tune training
        this.autoTuneHistory = []; // Store frequency measurements for averaging
        this.autoTuneTrainingPeriod = 3000; // 3 seconds of training
        this.autoTuneUpdateInterval = 1000; // Update target frequency every 1 second
        this.lastAutoTuneUpdate = 0;
        
        // Statistics
        this.wpm = 0;
        this.signalStrength = 0;
        this.detectedFrequency = 0;
        this.zeroCrossingFrequency = 0;
        this.characterCount = 0;
        this.wordCount = 0;
        
        // Processing
        this.updateInterval = null;
        this.lastProcessTime = 0;
        this.processInterval = 10; // ms between processing cycles
    }

    onInitialize() {
        this.radio.log('CW Decoder Extension initialized');
        // Make instance globally accessible for inline event handlers
        window.cwDecoderInstance = this;
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
        this.autoTuneHistory = [];
        this.lastAutoTuneUpdate = 0;

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

        const audioCtx = this.radio.getAudioContext();
        if (!audioCtx) return;

        const sampleRate = audioCtx.sampleRate;

        // Get frequency spectrum data using FLOAT data for actual dBFS values (like app.js does)
        const floatFreqData = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(floatFreqData);
        
        let nyquist = sampleRate / 2;
        let targetBin = Math.floor((this.targetFrequency / nyquist) * floatFreqData.length);
        let binRange = Math.floor((this.frequencyTolerance / nyquist) * floatFreqData.length);
        
        // Get amplitude at the EXACT target frequency bin (not the peak in range)
        // This is more sensitive to the presence/absence of the CW tone
        const amplitudeDb = floatFreqData[targetBin];
        
        // Also find peak for display purposes
        let peakDb = -Infinity;
        let peakBin = targetBin;
        
        for (let i = Math.max(0, targetBin - binRange);
             i < Math.min(floatFreqData.length, targetBin + binRange);
             i++) {
            const dbValue = floatFreqData[i];
            if (isFinite(dbValue) && dbValue > peakDb) {
                peakDb = dbValue;
                peakBin = i;
            }
        }
        
        this.signalStrength = amplitudeDb;
        this.detectedFrequency = (peakBin / floatFreqData.length) * nyquist;
        
        // Debug: show both target and peak
        console.log(`[DEBUG] Target bin ${targetBin} (${this.targetFrequency} Hz): ${amplitudeDb.toFixed(1)} dB, Peak bin ${peakBin}: ${peakDb.toFixed(1)} dB`);

        // Also get zero-crossing frequency for display
        const zcFreq = this.detectFrequencyZeroCrossing(dataArray);
        this.zeroCrossingFrequency = zcFreq;
        
        // Calculate noise floor using EXACT same approach as app.js (lines 3750-3792)
        // Scan the full audio FFT spectrum (0 to Nyquist) for minimum dB value
        // CRITICAL: Must exclude -Infinity bins which appear as very low values
        let currentMinDb = 0;
        let validBins = 0;
        for (let i = 0; i < floatFreqData.length; i++) {
            const dbValue = floatFreqData[i];
            // Only consider finite values above -140 dB (exclude -Infinity bins)
            // -Infinity bins can appear as values around -150 dB or lower
            if (isFinite(dbValue) && dbValue > -140) {
                if (currentMinDb === 0 || dbValue < currentMinDb) {
                    currentMinDb = dbValue;
                }
                validBins++;
            }
        }
        
        // If no valid bins found, noise floor calculation failed
        if (validBins === 0) {
            console.log('[CW] No valid FFT bins found for noise floor calculation');
            return;
        }
        
        console.log(`[CW] Noise floor from ${validBins} valid bins out of ${floatFreqData.length} total`);
        
        // Apply temporal smoothing (2 second window like app.js)
        this.noiseFloorHistory.push({ value: currentMinDb, timestamp: now });
        this.noiseFloorHistory = this.noiseFloorHistory.filter(h => now - h.timestamp <= this.noiseFloorHistoryMaxAge);
        const avgNoiseFloor = this.noiseFloorHistory.length > 0
            ? this.noiseFloorHistory.reduce((sum, h) => sum + h.value, 0) / this.noiseFloorHistory.length
            : currentMinDb;
        
        this.noiseFloor = avgNoiseFloor;
        
        // Use adaptive threshold: noise floor + offset
        const effectiveThreshold = this.noiseFloor + this.thresholdAboveNoise;
        
        console.log(`[CW] Signal: ${amplitudeDb.toFixed(1)} dB, Noise: ${this.noiseFloor.toFixed(1)} dB, Threshold: ${effectiveThreshold.toFixed(1)} dB`);

        // Auto-tune target frequency if enabled and signal is strong
        if (this.autoTuneFrequency && amplitudeDb > effectiveThreshold && zcFreq > 100 && zcFreq < 3000) {
            // Collect frequency measurements for training
            this.autoTuneHistory.push({
                frequency: zcFreq,
                time: now
            });
            
            // Remove old measurements (keep last 3 seconds)
            this.autoTuneHistory = this.autoTuneHistory.filter(h => now - h.time < this.autoTuneTrainingPeriod);
            
            // Only update target frequency every 1 second and after training period
            if (now - this.lastAutoTuneUpdate >= this.autoTuneUpdateInterval &&
                this.autoTuneHistory.length > 0) {
                
                // Calculate average frequency from history
                const avgFreq = this.autoTuneHistory.reduce((sum, h) => sum + h.frequency, 0) / this.autoTuneHistory.length;
                
                // Use exponential moving average for smooth tracking
                const alpha = 0.2; // Smoothing factor (higher = faster response)
                this.targetFrequency = alpha * avgFreq + (1 - alpha) * this.targetFrequency;
                
                // Update the input field
                const freqInput = document.getElementById('cw-freq-input');
                if (freqInput) {
                    freqInput.value = Math.round(this.targetFrequency);
                }
                
                this.lastAutoTuneUpdate = now;
                console.log(`Auto-tune: ${this.autoTuneHistory.length} samples, avg: ${avgFreq.toFixed(1)} Hz, target: ${this.targetFrequency.toFixed(1)} Hz`);
            }
        }

        // Determine signal state with hysteresis
        // Use different thresholds for key down vs key up to prevent flutter
        const keyDownThreshold = effectiveThreshold;
        const keyUpThreshold = effectiveThreshold - 3; // 3 dB hysteresis

        let signalDetected;
        if (this.signalPresent) {
            // Currently keyed - need to drop below lower threshold to release
            signalDetected = amplitudeDb > keyUpThreshold;
        } else {
            // Currently released - need to exceed upper threshold to key
            signalDetected = amplitudeDb > keyDownThreshold;
        }

        // Log signal strength periodically (every 500ms)
        if (!this.lastSignalLog || now - this.lastSignalLog > 500) {
            console.log(`Signal: ${amplitudeDb.toFixed(1)} dB | Threshold: ${keyDownThreshold.toFixed(1)}/${keyUpThreshold.toFixed(1)} dB | State: ${this.signalPresent ? 'KEYED' : 'released'}`);
            this.lastSignalLog = now;
        }
        
        if (signalDetected && !this.signalPresent) {
            // Signal started (key down)
            console.log(`KEY DOWN - Signal: ${amplitudeDb.toFixed(1)} dB, Threshold: ${keyDownThreshold.toFixed(1)} dB`);
            this.signalPresent = true;
            this.signalStartTime = now;
            
            // Check silence duration before this signal
            if (this.silenceStartTime > 0) {
                const silenceDuration = now - this.silenceStartTime;
                console.log(`  Silence before: ${silenceDuration}ms`);
                this.processSilence(silenceDuration);
            }
            
            this.updateStatusBadge('DECODING', 'decoder-active');
            
        } else if (!signalDetected && this.signalPresent) {
            // Signal ended (key up)
            console.log(`KEY UP - Signal: ${amplitudeDb.toFixed(1)} dB, Threshold: ${keyUpThreshold.toFixed(1)} dB`);
            this.signalPresent = false;
            this.signalEndTime = now;
            this.silenceStartTime = now;
            
            // Process the signal duration
            const signalDuration = now - this.signalStartTime;
            console.log(`  Signal duration: ${signalDuration}ms`);
            this.processSignal(signalDuration);
            
            this.updateStatusBadge('LISTENING', 'decoder-listening');
        }
        
        // Update signal strength meter (map -60 to 0 dB range to 0-100%)
        const strength = Math.max(0, Math.min(100, ((amplitudeDb + 60) / 60) * 100));
        this.updateSignalStrength(strength / 100);
    }

    processSignal(duration) {
        // Determine if this is a dot or dash
        // Use adaptive timing based on history
        
        const threshold = (this.dotLength + this.dashLength) / 2;
        
        console.log(`Signal detected: ${duration}ms (threshold: ${threshold}ms)`);
        
        if (duration < threshold) {
            // Dot
            this.currentSymbol += '.';
            console.log('  -> DOT');
            this.updateTimingHistory(duration, 'dot');
        } else {
            // Dash
            this.currentSymbol += '-';
            console.log('  -> DASH');
            this.updateTimingHistory(duration, 'dash');
        }
        
        console.log(`Current symbol: ${this.currentSymbol}`);
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
        if (this.timingHistory.length < 3) {
            console.log(`Timing: Need more samples (have ${this.timingHistory.length}, need 3)`);
            return;
        }
        
        // Calculate average dot and dash lengths
        const dots = this.timingHistory.filter(t => t.type === 'dot');
        const dashes = this.timingHistory.filter(t => t.type === 'dash');
        
        console.log(`Timing history: ${dots.length} dots, ${dashes.length} dashes`);
        
        if (dots.length > 0) {
            const dotDurations = dots.map(t => t.duration);
            const avgDot = dots.reduce((sum, t) => sum + t.duration, 0) / dots.length;
            console.log(`  Dot durations: ${dotDurations.join(', ')} ms`);
            console.log(`  Average dot: ${avgDot.toFixed(1)} ms`);
            this.dotLength = avgDot;
        }
        
        if (dashes.length > 0) {
            const dashDurations = dashes.map(t => t.duration);
            const avgDash = dashes.reduce((sum, t) => sum + t.duration, 0) / dashes.length;
            console.log(`  Dash durations: ${dashDurations.join(', ')} ms`);
            console.log(`  Average dash: ${avgDash.toFixed(1)} ms`);
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
        
        console.log(`Updated timing: dot=${this.dotLength.toFixed(1)}ms, dash=${this.dashLength.toFixed(1)}ms, WPM=${this.wpm}`);
    }

    toggleAutoTune(enabled) {
        console.log('toggleAutoTune called with:', enabled);
        this.autoTuneFrequency = enabled;
        
        const freqInput = document.getElementById('cw-freq-input');
        if (freqInput) {
            freqInput.disabled = enabled;
            console.log('Input disabled set to:', freqInput.disabled);
        } else {
            console.error('Could not find freq input!');
        }
        
        this.radio.log(`Auto-tune ${enabled ? 'enabled' : 'disabled'}`);
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
        const autoTuneCheckbox = document.getElementById('cw-auto-tune');
        
        console.log('CW Decoder: Setting up controls');
        console.log('  freqInput found:', !!freqInput);
        console.log('  autoTuneCheckbox found:', !!autoTuneCheckbox);
        
        if (freqInput) {
            freqInput.value = this.targetFrequency;
            freqInput.addEventListener('change', (e) => {
                this.targetFrequency = parseInt(e.target.value) || 700;
                console.log('Manual frequency changed to:', this.targetFrequency);
            });
        } else {
            console.error('CW Decoder: freq input not found!');
        }

        if (autoTuneCheckbox) {
            console.log('CW Decoder: Setting up auto-tune checkbox');
            autoTuneCheckbox.checked = this.autoTuneFrequency;
            
            // Set initial state of input field
            if (freqInput) {
                freqInput.disabled = this.autoTuneFrequency;
                console.log('  Initial disabled state:', freqInput.disabled);
            }
            
            autoTuneCheckbox.addEventListener('change', (e) => {
                console.log('=== AUTO-TUNE CHECKBOX CHANGED ===');
                console.log('  Checked:', e.target.checked);
                this.autoTuneFrequency = e.target.checked;
                console.log('  this.autoTuneFrequency:', this.autoTuneFrequency);
                
                // Disable/enable manual input when auto-tune is toggled
                if (freqInput) {
                    freqInput.disabled = this.autoTuneFrequency;
                    console.log('  Input disabled set to:', freqInput.disabled);
                    console.log('  Input element:', freqInput);
                } else {
                    console.error('  freqInput is null!');
                }
                
                this.radio.log(`Auto-tune ${this.autoTuneFrequency ? 'enabled' : 'disabled'}`);
            });
            console.log('CW Decoder: Auto-tune event listener attached');
        } else {
            console.error('CW Decoder: auto-tune checkbox not found!');
        }
        
        const thresholdInput = document.getElementById('cw-threshold-input');
        if (thresholdInput) {
            thresholdInput.value = this.signalThreshold;
            thresholdInput.addEventListener('change', (e) => {
                this.signalThreshold = parseInt(e.target.value) || -40;
            });
        }
    }

    // Removed canvas-based rendering

    detectFrequencyZeroCrossing(dataArray) {
        // Use zero-crossing method to detect dominant frequency
        const sampleRate = this.radio.getSampleRate();
        let crossings = 0;
        let lastSample = dataArray[0];

        // Count zero crossings
        for (let i = 1; i < dataArray.length; i++) {
            if ((lastSample >= 0 && dataArray[i] < 0) ||
                (lastSample < 0 && dataArray[i] >= 0)) {
                crossings++;
            }
            lastSample = dataArray[i];
        }

        // Frequency = (crossings / 2) / (samples / sampleRate)
        const duration = dataArray.length / sampleRate;
        const frequency = (crossings / 2) / duration;

        return frequency;
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
        
        this.updateElementById('cw-zerocrossing-freq', (el) => {
            el.textContent = Math.round(this.zeroCrossingFrequency) + ' Hz';
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

    updateDisplay() {
        const displayElement = document.getElementById('decoder-display');
        if (displayElement) {
            displayElement.textContent = this.decodedText;
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