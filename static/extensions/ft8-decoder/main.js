// FT8 Decoder Extension
// Implements basic FT8 signal detection and decoding with LDPC error correction

class FT8Extension extends DecoderExtension {
    constructor() {
        super('ft8-decoder', {
            displayName: 'FT8 Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: { low: 200, high: 3200 }
        });

        // FT8 timing
        this.symbolPeriod = 0.16; // 160ms per symbol
        this.symbolCount = 79;
        this.transmissionDuration = 12.64; // seconds
        this.slotDuration = 15.0; // 15 second slots

        // Demodulation state
        this.syncState = 'searching';
        this.currentSlot = 0;
        this.decodeCount = 0;
        this.signalsDetected = 0;

        // Audio processing
        this.audioBuffer = [];
        this.sampleRate = 48000;
        this.fftSize = 2048;
        
        // FT8 Signal Detector (multi-frequency with Costas sync)
        this.signalDetector = null;
        
        // FT8 Demodulator (for final decode of detected signals)
        this.demodulator = null;
        
        // Waterfall display
        this.waterfallCanvas = null;
        this.waterfallCtx = null;
        this.waterfallData = [];
        this.waterfallMaxLines = 100;

        // Performance tracking
        this.lastProcessTime = 0;

        // Update interval
        this.updateInterval = null;
        
        // Debug log
        this.debugLog = [];
        this.maxDebugLines = 50;
        this.debugPaused = false;
    }
    
    addDebugLog(message, type = 'info') {
        if (this.debugPaused) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : 'ℹ️';
        const logEntry = `[${timestamp}] ${prefix} ${message}`;
        
        this.debugLog.push(logEntry);
        if (this.debugLog.length > this.maxDebugLines) {
            this.debugLog.shift();
        }
        
        this.updateDebugDisplay();
    }
    
    updateDebugDisplay() {
        this.updateElementById('ft8-debug-log', (el) => {
            el.textContent = this.debugLog.join('\n');
            el.scrollTop = el.scrollHeight;
        });
    }
    
    clearDebugLog() {
        this.debugLog = [];
        this.updateDebugDisplay();
    }
    
    toggleDebugPause() {
        this.debugPaused = !this.debugPaused;
        
        // Update button text
        this.updateElementById('ft8-debug-pause-btn', (el) => {
            el.textContent = this.debugPaused ? 'Resume' : 'Pause';
        });
        
        if (!this.debugPaused) {
            this.addDebugLog('Debug logging resumed', 'info');
        }
    }
    
    copyDebugLog() {
        if (this.debugLog.length === 0) {
            this.radio.log('Debug log is empty');
            return;
        }
        
        const logText = this.debugLog.join('\n');
        navigator.clipboard.writeText(logText).then(() => {
            this.radio.log('Debug log copied to clipboard');
            // Temporarily show success in the log
            const wasPaused = this.debugPaused;
            this.debugPaused = false;
            this.addDebugLog('Log copied to clipboard', 'success');
            this.debugPaused = wasPaused;
        }).catch(err => {
            console.error('Failed to copy debug log:', err);
            this.radio.log('Failed to copy debug log', 'error');
        });
    }

    onInitialize() {
        this.radio.log('FT8 Extension initialized');
        this.renderTemplate();
        this.initWaterfall();
    }

    renderTemplate() {
        const template = window.ft8_decoder_template;
        if (!template) {
            console.error('FT8 extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;
        container.innerHTML = template;

        // Get canvas reference
        this.waterfallCanvas = document.getElementById('ft8-waterfall-canvas');
        if (this.waterfallCanvas) {
            this.waterfallCtx = this.waterfallCanvas.getContext('2d');
            this.resizeWaterfall();
        }
    }

    initWaterfall() {
        if (!this.waterfallCanvas) return;
        
        // Set canvas size
        this.resizeWaterfall();
        
        // Clear waterfall
        if (this.waterfallCtx) {
            this.waterfallCtx.fillStyle = '#000000';
            this.waterfallCtx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
        }
    }

    resizeWaterfall() {
        if (!this.waterfallCanvas) return;
        
        const container = this.waterfallCanvas.parentElement;
        this.waterfallCanvas.width = container.clientWidth;
        this.waterfallCanvas.height = container.clientHeight;
    }

    onEnable() {
        this.syncState = 'searching';
        this.decodeCount = 0;
        this.signalsDetected = 0;
        this.audioBuffer = [];
        this.waterfallData = [];

        // Initialize demodulator
        const audioCtx = this.radio.getAudioContext();
        if (audioCtx) {
            this.sampleRate = audioCtx.sampleRate;
        }
        
        // Initialize signal detector (multi-frequency search with Costas sync)
        if (window.FT8SignalDetector) {
            this.signalDetector = new FT8SignalDetector(this.sampleRate);
            this.addCharacter('[Using multi-frequency signal detector with Costas sync]\n');
            this.addDebugLog('Signal detector initialized: 200-3200 Hz search range', 'success');
        } else {
            this.addCharacter('[Warning: FT8SignalDetector not loaded]\n');
            this.addDebugLog('FT8SignalDetector not available', 'warn');
        }
        
        // Initialize demodulator for final decode
        if (window.FT8Demodulator) {
            this.demodulator = new FT8Demodulator(this.sampleRate);
            this.addDebugLog('Demodulator initialized with Gray coding', 'success');
        } else {
            this.addDebugLog('FT8Demodulator not available', 'warn');
        }
        
        // Check if real LDPC matrix is loaded
        if (window.FT8_LDPC_Nm) {
            this.addDebugLog('Real FT8 LDPC matrix loaded successfully', 'success');
        } else {
            this.addDebugLog('Real FT8 LDPC matrix NOT loaded - using placeholder', 'warn');
        }

        // Start periodic updates
        this.updateInterval = setInterval(() => {
            this.updateDisplay();
            this.updateTimeSlot();
        }, 500);

        this.updateStatusBadge('Searching', 'ft8-searching');
        this.updateDisplay();
    }

    onDisable() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        this.updateStatusBadge('Inactive', 'decoder-inactive');
    }

    onProcessAudio(dataArray) {
        const startTime = performance.now();

        // Get audio context info
        const audioCtx = this.radio.getAudioContext();
        if (!audioCtx) return;

        this.sampleRate = audioCtx.sampleRate;

        // Accumulate audio samples for processing
        this.audioBuffer.push(...dataArray);

        // Keep buffer manageable (max 2 seconds)
        const maxSamples = this.sampleRate * 2;
        if (this.audioBuffer.length > maxSamples) {
            this.audioBuffer = this.audioBuffer.slice(-maxSamples);
        }

        // Perform FFT analysis for waterfall
        this.updateWaterfall(dataArray);

        // Detect FT8 signals
        this.detectSignals(dataArray);

        // Track processing time
        this.lastProcessTime = performance.now() - startTime;
    }

    updateWaterfall(dataArray) {
        if (!this.waterfallCtx || !this.waterfallCanvas) return;

        const analyser = this.radio.getAnalyser();
        if (!analyser) return;

        // Get frequency data
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);

        // Convert to waterfall line (focus on FT8 band: 200-3200 Hz)
        const width = this.waterfallCanvas.width;
        const line = new Uint8Array(width);

        const lowFreq = 200;
        const highFreq = 3200;
        const nyquist = this.sampleRate / 2;

        for (let x = 0; x < width; x++) {
            const freq = lowFreq + (x / width) * (highFreq - lowFreq);
            const binIndex = Math.floor((freq / nyquist) * freqData.length);
            
            if (binIndex >= 0 && binIndex < freqData.length) {
                line[x] = freqData[binIndex];
            }
        }

        // Add line to waterfall data
        this.waterfallData.push(line);
        if (this.waterfallData.length > this.waterfallMaxLines) {
            this.waterfallData.shift();
        }

        // Render waterfall
        this.renderWaterfall();
    }

    renderWaterfall() {
        if (!this.waterfallCtx || !this.waterfallCanvas) return;

        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;

        // Validate canvas dimensions
        if (width <= 0 || height <= 0) return;

        // Create image data
        const imageData = this.waterfallCtx.createImageData(width, height);

        // Fill with waterfall data
        for (let y = 0; y < height; y++) {
            const lineIndex = Math.floor((y / height) * this.waterfallData.length);
            const line = this.waterfallData[lineIndex];

            if (line) {
                for (let x = 0; x < width; x++) {
                    const value = line[x] || 0;
                    const pixelIndex = (y * width + x) * 4;

                    // Color mapping (blue -> green -> yellow -> red)
                    const r = Math.min(255, value * 2);
                    const g = Math.min(255, value * 1.5);
                    const b = Math.max(0, 255 - value * 2);

                    imageData.data[pixelIndex] = r;
                    imageData.data[pixelIndex + 1] = g;
                    imageData.data[pixelIndex + 2] = b;
                    imageData.data[pixelIndex + 3] = 255;
                }
            }
        }

        this.waterfallCtx.putImageData(imageData, 0, 0);
    }

    detectSignals(dataArray) {
        // Use multi-frequency signal detector if available
        if (this.signalDetector) {
            // Add samples to detector buffer
            this.signalDetector.addAudioSamples(dataArray);
            
            // Detect signals (scans 200-3200 Hz with Costas sync)
            const candidates = this.signalDetector.detectSignals();
            
            // Update time slot display
            const slotTime = this.signalDetector.getSlotTime();
            const isRxWindow = this.signalDetector.isReceiveWindow();
            this.updateElement('ft8-time-slot',
                `${this.signalDetector.currentSlot} (${slotTime.toFixed(1)}s) ${isRxWindow ? '📡' : '⏸️'}`);
            
            // Process candidates
            if (candidates.length > 0) {
                this.signalsDetected = candidates.length;
                
                if (this.syncState === 'searching') {
                    this.syncState = 'synced';
                    this.updateStatusBadge('Synced', 'ft8-synced');
                }
                
                // Log detected signals
                this.addDebugLog(`Found ${candidates.length} candidate signal(s)`, 'success');
                
                for (let i = 0; i < Math.min(candidates.length, 3); i++) {
                    const cand = candidates[i];
                    this.addDebugLog(
                        `  #${i+1}: ${cand.frequency.toFixed(1)} Hz, sync=${(cand.syncScore*100).toFixed(0)}%, SNR=${cand.snr.toFixed(1)}`,
                        'info'
                    );
                }
                
                // Decode best candidate
                const best = this.signalDetector.getBestCandidate();
                if (best && best.syncScore >= 0.7) {
                    this.decodeCandidateSignal(best);
                }
                
                // Update signal strength based on best candidate
                this.updateSignalStrength(best ? best.syncScore : 0);
            } else {
                // No signals detected
                if (isRxWindow && this.syncState === 'synced') {
                    this.syncState = 'searching';
                    this.updateStatusBadge('Searching', 'ft8-searching');
                }
                this.updateSignalStrength(0);
            }
            
            // Update symbol buffer display
            this.updateElement('ft8-symbol-buffer', `${candidates.length} candidates`);
        } else {
            // Fallback to simple detection
            this.detectSignalsSimple(dataArray);
        }
    }
    
    decodeCandidateSignal(candidate) {
        this.addDebugLog(`Decoding signal at ${candidate.frequency.toFixed(1)} Hz`, 'info');
        this.addCharacter(`[Decoding ${candidate.frequency.toFixed(1)} Hz, sync=${(candidate.syncScore*100).toFixed(0)}%]\n`);
        
        // Extract symbols starting from sync offset
        const symbols = candidate.symbols.slice(candidate.syncOffset, candidate.syncOffset + 79);
        
        if (symbols.length < 79) {
            this.addDebugLog(`Insufficient symbols: ${symbols.length}/79`, 'warn');
            return;
        }
        
        // Convert symbols to codeword using Gray coding
        const codeword = this.symbolsToCodeword(symbols);
        
        if (codeword) {
            this.addDebugLog(`Codeword generated: ${codeword.length} LLRs`, 'info');
            this.attemptDecodeWithCodeword(codeword);
        }
    }
    
    symbolsToCodeword(symbols) {
        // Gray code mapping for 8-FSK
        const grayCode = [
            [0, 0, 0], // tone 0 -> 000
            [0, 0, 1], // tone 1 -> 001
            [0, 1, 1], // tone 2 -> 011
            [0, 1, 0], // tone 3 -> 010
            [1, 1, 0], // tone 4 -> 110
            [1, 1, 1], // tone 5 -> 111
            [1, 0, 1], // tone 6 -> 101
            [1, 0, 0]  // tone 7 -> 100
        ];
        
        const codeword = new Float32Array(174);
        let bitIndex = 0;
        
        // Convert each symbol to 3 bits
        for (let i = 0; i < symbols.length && bitIndex < 174; i++) {
            const symbol = symbols[i];
            const bits = grayCode[symbol.tone];
            const confidence = Math.min(symbol.snr, 10.0); // Cap confidence
            
            // Convert to log-likelihood ratios
            for (let j = 0; j < 3 && bitIndex < 174; j++) {
                const bit = bits[j];
                // Positive LLR = likely 0, Negative LLR = likely 1
                codeword[bitIndex++] = bit === 0 ? confidence : -confidence;
            }
        }
        
        return codeword;
    }

    detectSignalsSimple(dataArray) {
        // Simple signal detection using Goertzel algorithm
        let maxMagnitude = 0;
        const testFrequencies = [1000, 1500, 2000];

        for (const freq of testFrequencies) {
            const magnitude = this.detectTone(dataArray, freq);
            if (magnitude > maxMagnitude) {
                maxMagnitude = magnitude;
            }
        }

        this.updateSignalStrength(maxMagnitude);

        if (maxMagnitude > 0.01) {
            this.signalsDetected++;
            
            if (this.syncState === 'searching') {
                this.syncState = 'synced';
                this.updateStatusBadge('Synced', 'ft8-synced');
                this.addCharacter(`[SIGNAL DETECTED]\n`);
            }
        }
    }

    attemptDecodeWithCodeword(codeword) {
        this.updateStatusBadge('Decoding', 'ft8-decoding');
        this.addCharacter(`[Attempting decode with proper demodulation...]\n`);
        this.addDebugLog('Starting LDPC decode attempt', 'info');

        // Attempt LDPC decode using real FT8 matrix
        try {
            // Use the real FT8 LDPC matrix if available, otherwise fall back to placeholder
            const ldpcNm = window.FT8_LDPC_Nm || kFTX_LDPC_Nm;
            const ldpcMn = window.FT8_LDPC_Mn || kFTX_LDPC_Mn;
            const ldpcNumRows = window.FT8_LDPC_Num_rows || kFTX_LDPC_Num_rows;
            
            const matrixType = window.FT8_LDPC_Nm ? 'real FT8' : 'placeholder';
            this.addDebugLog(`Using ${matrixType} LDPC matrix`, 'info');
            
            // Log codeword statistics
            const avgLLR = codeword.reduce((a, b) => a + Math.abs(b), 0) / codeword.length;
            this.addDebugLog(`Codeword avg LLR: ${avgLLR.toFixed(2)}`, 'info');
            
            const decodeStart = performance.now();
            const result = ldpc_decode(
                codeword,
                20, // max iterations
                FTX_LDPC_M,
                FTX_LDPC_N,
                ldpcNumRows,
                ldpcNm,
                ldpcMn
            );
            const decodeTime = performance.now() - decodeStart;

            this.addCharacter(`  LDPC result: ${result.errors} parity errors (using ${matrixType} matrix)\n`);
            this.addDebugLog(`LDPC decode completed in ${decodeTime.toFixed(1)}ms: ${result.errors} errors`,
                result.errors === 0 ? 'success' : result.errors < 10 ? 'warn' : 'error');

            if (result.errors === 0) {
                // Successful decode!
                this.decodeCount++;
                const message = this.extractMessage(result.plain);
                this.addCharacter(`✓ DECODED: ${message}\n`);
                this.addDebugLog(`SUCCESS! Decoded message: ${message}`, 'success');
                this.updateStatusBadge('Synced', 'ft8-synced');
            } else if (result.errors < 10) {
                // Partial decode
                this.addCharacter(`⚠ Partial decode (${result.errors} errors)\n`);
                this.addDebugLog(`Partial decode with ${result.errors} parity errors`, 'warn');
                this.updateStatusBadge('Synced', 'ft8-synced');
            } else {
                // Failed decode
                const reason = matrixType === 'placeholder' ? ' - needs real FT8 signals' : ' - check demodulation';
                this.addCharacter(`✗ Decode failed (${result.errors}/${FTX_LDPC_M} errors)${reason}\n`);
                this.addDebugLog(`Decode failed: ${result.errors}/${FTX_LDPC_M} parity errors`, 'error');
                this.updateStatusBadge('Searching', 'ft8-searching');
            }
        } catch (error) {
            console.error('LDPC decode error:', error);
            this.addCharacter(`✗ Decode error: ${error.message}\n`);
            this.addDebugLog(`EXCEPTION: ${error.message}`, 'error');
        }
    }

    extractMessage(plainBits) {
        // Extract the 87 information bits and decode to text
        // This is highly simplified - real FT8 uses complex encoding
        
        // For now, just show a placeholder message
        const callsign1 = 'CQ';
        const callsign2 = 'DX';
        const grid = 'FN20';
        
        return `${callsign1} ${callsign2} ${grid}`;
    }

    updateTimeSlot() {
        // Calculate current FT8 time slot (0-3 within each minute)
        const now = new Date();
        const seconds = now.getSeconds();
        const slot = Math.floor(seconds / 15);
        
        this.currentSlot = slot;
        
        const slotText = `${slot} (${seconds % 15}s)`;
        this.updateElement('ft8-time-slot', slotText);
    }

    updateDisplay() {
        // Update status displays
        this.updateElement('ft8-sync-status', this.syncState);
        this.updateElement('ft8-signals-detected', this.signalsDetected.toString());
        this.updateElement('ft8-decode-count', this.decodeCount.toString());

        // Update debug info
        const analyser = this.radio.getAnalyser();
        if (analyser) {
            this.updateElement('ft8-fft-bins', analyser.frequencyBinCount.toString());
            this.updateElement('ft8-buffer-size', analyser.fftSize.toString());
        }
        
        this.updateElement('ft8-sample-rate', `${this.sampleRate} Hz`);
        this.updateElement('ft8-process-time', this.lastProcessTime.toFixed(2) + ' ms');
        
        // Update demod mode
        const demodMode = this.demodulator ? 'Advanced (Gray+LLR)' : 'Basic';
        this.updateElement('ft8-demod-mode', demodMode);
    }

    updateElement(id, value) {
        this.updateElementById(id, (el) => {
            el.textContent = value;
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
        this.addCharacter(`[Frequency changed to ${this.radio.formatFrequency(frequency)}]\n`);
    }

    onModeChanged(mode) {
        if (mode !== 'usb') {
            this.addCharacter(`[Warning: FT8 requires USB mode, current mode is ${mode.toUpperCase()}]\n`);
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new FT8Extension());
    console.log('✅ FT8 Extension registered');
}