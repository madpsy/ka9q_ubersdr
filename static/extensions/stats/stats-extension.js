// Stats Extension - Shows current radio state information
// Demonstrates the decoder extension API

class StatsExtension extends DecoderExtension {
    constructor() {
        super('stats', {
            displayName: 'Stats Monitor',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        this.updateInterval = null;
        this.updateRate = 1000; // Update every 1 second
    }

    onInitialize() {
        this.radio.log('Stats Extension initialized');
        this.renderModernStats();
    }

    onEnable() {
        // Initialize audio level
        this.currentAudioLevel = undefined;

        // Initialize audio processing demo data
        this.audioPeakValue = 0;
        this.audioZeroCrossings = 0;
        this.audioDominantFreq = 0;
        this.audioFrequencyData = null;
        this.audioSampleRate = 48000;

        // Initialize spectrum processing demo data
        this.spectrumPeakFreq = 0;
        this.spectrumPeakBin = 0;
        this.spectrumPeakPower = -Infinity;
        this.spectrumAvgPower = 0;
        this.spectrumOccupancy = 0;
        this.currentSpectrumData = null;

        // Start periodic updates
        this.updateInterval = setInterval(() => {
            this.updateStats();
        }, this.updateRate);

        // Initial update
        this.updateStats();
    }

    onDisable() {
        // Stop periodic updates
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    onProcessAudio(dataArray) {
        // Calculate audio level from VU analyser (after all processing)
        const vuAnalyser = this.radio.getVUAnalyser();

        if (!vuAnalyser) {
            // VU analyser not available yet
            this.currentAudioLevel = undefined;
            return;
        }

        const vuData = new Uint8Array(vuAnalyser.frequencyBinCount);
        vuAnalyser.getByteTimeDomainData(vuData);

        // Calculate RMS (Root Mean Square)
        let sumSquares = 0;
        for (let i = 0; i < vuData.length; i++) {
            const normalized = (vuData[i] - 128) / 128;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / vuData.length);
        const db = 20 * Math.log10(rms);

        // Store for display
        this.currentAudioLevel = db;

        // === AUDIO PROCESSING DEMONSTRATION ===
        // This section demonstrates that extensions can process audio data

        // 1. Peak Detection - Find maximum amplitude
        let peak = 0;
        for (let i = 0; i < vuData.length; i++) {
            const normalized = Math.abs((vuData[i] - 128) / 128);
            if (normalized > peak) peak = normalized;
        }
        this.audioPeakValue = peak;

        // 2. Zero-Crossing Rate - Count sign changes (indicates frequency content)
        let zeroCrossings = 0;
        for (let i = 1; i < vuData.length; i++) {
            const prev = vuData[i - 1] - 128;
            const curr = vuData[i] - 128;
            if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
                zeroCrossings++;
            }
        }
        this.audioZeroCrossings = zeroCrossings;

        // 3. Dominant Frequency Detection - Use zero-crossing detection (same as oscilloscope)
        const audioCtx = this.radio.getAudioContext();
        if (audioCtx) {
            this.audioDominantFreq = this.detectFrequencyFromWaveform(vuData, audioCtx.sampleRate);
        }

        // 4. Get actual frequency spectrum data for visualization
        const freqData = new Uint8Array(vuAnalyser.frequencyBinCount);
        vuAnalyser.getByteFrequencyData(freqData);
        this.audioFrequencyData = freqData;
        this.audioSampleRate = audioCtx ? audioCtx.sampleRate : 48000;
    }

    onProcessSpectrum(spectrumData) {
        // === SPECTRUM PROCESSING DEMONSTRATION ===
        // This section demonstrates that extensions can process spectrum data

        if (!spectrumData || !spectrumData.powers) {
            return;
        }

        const powers = spectrumData.powers;
        const binBandwidth = spectrumData.binBandwidth;
        const centerFreq = spectrumData.centerFreq;

        // 1. Peak Detection - Find strongest signal
        let peakPower = -Infinity;
        let peakBin = 0;
        for (let i = 0; i < powers.length; i++) {
            if (powers[i] > peakPower) {
                peakPower = powers[i];
                peakBin = i;
            }
        }

        this.spectrumPeakPower = peakPower;
        this.spectrumPeakBin = peakBin;
        // Calculate frequency of peak (bin offset from center)
        const binOffset = peakBin - (powers.length / 2);
        this.spectrumPeakFreq = centerFreq + (binOffset * binBandwidth);

        // Store spectrum data for visualization
        this.currentSpectrumData = spectrumData;

        // 2. Average Power Calculation
        let sumPower = 0;
        for (let i = 0; i < powers.length; i++) {
            sumPower += powers[i];
        }
        this.spectrumAvgPower = sumPower / powers.length;

        // 3. Bandwidth Occupancy - Percentage of bins above threshold
        const threshold = this.spectrumAvgPower + 10; // 10 dB above average
        let occupiedBins = 0;
        for (let i = 0; i < powers.length; i++) {
            if (powers[i] > threshold) {
                occupiedBins++;
            }
        }
        this.spectrumOccupancy = (occupiedBins / powers.length) * 100;
    }

    // Detect frequency from waveform using zero-crossing (same method as oscilloscope)
    detectFrequencyFromWaveform(dataArray, sampleRate) {
        if (!dataArray || dataArray.length < 2) return 0;

        const zeroCrossings = [];
        const threshold = 128;

        // Find all zero-crossings with interpolation
        for (let i = 1; i < dataArray.length; i++) {
            const prev = dataArray[i - 1];
            const curr = dataArray[i];

            // Detect positive-going zero crossing
            if (prev < threshold && curr >= threshold) {
                // Linear interpolation to find exact crossing point
                const fraction = (threshold - prev) / (curr - prev);
                const crossingIndex = (i - 1) + fraction;
                zeroCrossings.push(crossingIndex);
            }
        }

        // Need at least 2 crossings to calculate frequency
        if (zeroCrossings.length < 2) return 0;

        // Calculate average period between crossings
        let totalPeriod = 0;
        for (let i = 1; i < zeroCrossings.length; i++) {
            totalPeriod += zeroCrossings[i] - zeroCrossings[i - 1];
        }
        const avgPeriod = totalPeriod / (zeroCrossings.length - 1);

        // Convert period to frequency
        const frequency = sampleRate / avgPeriod;

        // Sanity check: audio range
        if (frequency < 20 || frequency > 20000) return 0;

        return frequency;
    }

    renderModernStats() {
        // Create modern HTML structure instead of plain text
        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = `
            <style>
                .stats-modern-container {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    color: #ecf0f1;
                    padding: 0;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 15px;
                    margin-bottom: 15px;
                }

                .stats-card {
                    background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                    border-radius: 8px;
                    padding: 18px;
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                    border-left: 4px solid;
                    transition: all 0.3s ease;
                }

                .stats-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
                }

                .stats-card.frequency { border-left-color: #3498db; }
                .stats-card.mode { border-left-color: #e74c3c; }
                .stats-card.bandwidth { border-left-color: #f39c12; }
                .stats-card.audio { border-left-color: #2ecc71; }
                .stats-card.connection { border-left-color: #9b59b6; }
                .stats-card.spectrum { border-left-color: #1abc9c; }

                .stats-card-header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 12px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid rgba(255, 255, 255, 0.1);
                }

                .stats-card-icon {
                    font-size: 1.5em;
                    width: 36px;
                    height: 36px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.1);
                }

                .stats-card-title {
                    font-size: 1.1em;
                    font-weight: bold;
                    color: #ecf0f1;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .stats-card-content {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .stats-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 6px 0;
                }

                .stats-label {
                    font-size: 0.9em;
                    color: #95a5a6;
                    font-weight: 500;
                }

                .stats-value {
                    font-size: 1.1em;
                    font-weight: bold;
                    color: #ecf0f1;
                    font-family: 'Courier New', monospace;
                }

                .stats-value.highlight {
                    color: #3498db;
                    font-size: 1.3em;
                }

                .stats-badge {
                    display: inline-block;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.85em;
                    font-weight: bold;
                    text-transform: uppercase;
                }

                .stats-badge.connected {
                    background: #27ae60;
                    color: white;
                }

                .stats-badge.disconnected {
                    background: #e74c3c;
                    color: white;
                }

                .stats-badge.active {
                    background: #3498db;
                    color: white;
                }

                .stats-meter {
                    width: 100%;
                    height: 8px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-top: 4px;
                }

                .stats-meter-fill {
                    height: 100%;
                    background: linear-gradient(to right, #2ecc71 0%, #f39c12 50%, #e74c3c 100%);
                    border-radius: 4px;
                    transition: width 0.3s ease;
                }

                .vertical-spectrum {
                    display: flex;
                    align-items: flex-end;
                    justify-content: space-around;
                    height: 120px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    padding: 8px;
                    gap: 2px;
                    margin-top: 8px;
                }

                .spectrum-bar {
                    flex: 1;
                    background: linear-gradient(to top, #2ecc71 0%, #f39c12 50%, #e74c3c 100%);
                    border-radius: 2px;
                    min-height: 2px;
                    transition: height 0.1s ease;
                    position: relative;
                }

                .spectrum-bar.peak {
                    background: linear-gradient(to top, #3498db 0%, #e74c3c 100%);
                    box-shadow: 0 0 8px rgba(52, 152, 219, 0.8);
                }

                .spectrum-label {
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.75em;
                    color: #95a5a6;
                    margin-top: 4px;
                }

                .stats-list-card {
                    background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                    border-radius: 8px;
                    padding: 18px;
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                    border-left: 4px solid #16a085;
                }

                .stats-list-header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 12px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid rgba(255, 255, 255, 0.1);
                }

                .stats-list-content {
                    max-height: 200px;
                    overflow-y: auto;
                    padding-right: 8px;
                }

                .stats-list-content::-webkit-scrollbar {
                    width: 6px;
                }

                .stats-list-content::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 3px;
                }

                .stats-list-content::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 3px;
                }

                .stats-list-content::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.3);
                }

                .stats-list-item {
                    padding: 8px 12px;
                    margin-bottom: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 4px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    transition: all 0.2s ease;
                }

                .stats-list-item:hover {
                    background: rgba(255, 255, 255, 0.1);
                    transform: translateX(4px);
                }

                .stats-list-item-name {
                    font-weight: 500;
                    color: #ecf0f1;
                }

                .stats-list-item-value {
                    font-family: 'Courier New', monospace;
                    color: #3498db;
                    font-size: 0.9em;
                }
            </style>

            <div class="stats-modern-container">
                <div class="stats-grid">
                    <!-- Radio Card -->
                    <div class="stats-card frequency">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">📡</div>
                            <div class="stats-card-title">Radio</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Frequency</span>
                                <span class="stats-value highlight" id="stats-frequency">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Band</span>
                                <span class="stats-value" id="stats-band">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Mode</span>
                                <span class="stats-badge active" id="stats-mode">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">BW Low</span>
                                <span class="stats-value" id="stats-bw-low">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">BW High</span>
                                <span class="stats-value" id="stats-bw-high">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">BW Width</span>
                                <span class="stats-value" id="stats-bw-width">-</span>
                            </div>
                        </div>
                    </div>

                    <!-- Audio Card -->
                    <div class="stats-card audio">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">🔊</div>
                            <div class="stats-card-title">Audio</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Sample Rate</span>
                                <span class="stats-value" id="stats-sample-rate">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">State</span>
                                <span class="stats-badge active" id="stats-audio-state">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Buffer Time</span>
                                <span class="stats-value" id="stats-buffer-time">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Level</span>
                                <span class="stats-value" id="stats-audio-level">-</span>
                            </div>
                            <div class="stats-meter">
                                <div class="stats-meter-fill" id="stats-audio-meter" style="width: 0%"></div>
                            </div>
                            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1);">
                                <div style="font-size: 0.85em; color: #95a5a6; margin-bottom: 8px; font-weight: 600;">
                                    📊 AUDIO PROCESSING DEMO
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Peak Amplitude</span>
                                    <span class="stats-value" id="stats-audio-peak">-</span>
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Zero Crossings</span>
                                    <span class="stats-value" id="stats-audio-zcr">-</span>
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Dominant Freq</span>
                                    <span class="stats-value" id="stats-audio-domfreq">-</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Spectrum Card -->
                    <div class="stats-card spectrum">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">📈</div>
                            <div class="stats-card-title">Spectrum</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Center</span>
                                <span class="stats-value" id="stats-spectrum-center">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Bin BW</span>
                                <span class="stats-value" id="stats-spectrum-binbw">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Bins</span>
                                <span class="stats-value" id="stats-spectrum-bins">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Zoom</span>
                                <span class="stats-value" id="stats-spectrum-zoom">-</span>
                            </div>
                            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1);">
                                <div style="font-size: 0.85em; color: #95a5a6; margin-bottom: 8px; font-weight: 600;">
                                    📊 SPECTRUM PROCESSING DEMO
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Peak Frequency</span>
                                    <span class="stats-value" id="stats-spectrum-peakfreq">-</span>
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Peak Power</span>
                                    <span class="stats-value" id="stats-spectrum-peakpower">-</span>
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Avg Power</span>
                                    <span class="stats-value" id="stats-spectrum-avgpower">-</span>
                                </div>
                                <div class="stats-item">
                                    <span class="stats-label">Occupancy</span>
                                    <span class="stats-value" id="stats-spectrum-occupancy">-</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Connection Card -->
                    <div class="stats-card connection">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">🔗</div>
                            <div class="stats-card-title">Connection</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Status</span>
                                <span class="stats-badge" id="stats-connection-status">-</span>
                            </div>
                            <div class="stats-item">
                                <span class="stats-label">Session</span>
                                <span class="stats-value" id="stats-session">-</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Signal Strength Indicators -->
                <div class="stats-grid" style="margin-bottom: 15px;">
                    <!-- Audio Peak Signal Card -->
                    <div class="stats-card audio">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">🎵</div>
                            <div class="stats-card-title">Audio Spectrum</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Peak Frequency</span>
                                <span class="stats-value highlight" id="stats-audio-peak-freq">-</span>
                            </div>
                            <div class="vertical-spectrum" id="audio-spectrum-display"></div>
                            <div class="spectrum-label">
                                <span id="audio-spectrum-low">-</span>
                                <span id="audio-spectrum-high">-</span>
                            </div>
                        </div>
                    </div>

                    <!-- Spectrum Peak Signal Card -->
                    <div class="stats-card spectrum">
                        <div class="stats-card-header">
                            <div class="stats-card-icon">📡</div>
                            <div class="stats-card-title">RF Spectrum</div>
                        </div>
                        <div class="stats-card-content">
                            <div class="stats-item">
                                <span class="stats-label">Peak Frequency</span>
                                <span class="stats-value highlight" id="stats-spectrum-peak-freq-display">-</span>
                            </div>
                            <div class="vertical-spectrum" id="rf-spectrum-display"></div>
                            <div class="spectrum-label">
                                <span id="rf-spectrum-low">-</span>
                                <span id="rf-spectrum-high">-</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Bands List -->
                <div class="stats-list-card" id="stats-bands-card" style="display: none;">
                    <div class="stats-list-header">
                        <div class="stats-card-icon">📻</div>
                        <div class="stats-card-title">Bands</div>
                        <span class="stats-badge active" id="stats-bands-count">0</span>
                    </div>
                    <div class="stats-list-content" id="stats-bands-list"></div>
                </div>

                <!-- Bookmarks List -->
                <div class="stats-list-card" id="stats-bookmarks-card" style="display: none; margin-top: 15px;">
                    <div class="stats-list-header">
                        <div class="stats-card-icon">🔖</div>
                        <div class="stats-card-title">Bookmarks</div>
                        <span class="stats-badge active" id="stats-bookmarks-count">0</span>
                    </div>
                    <div class="stats-list-content" id="stats-bookmarks-list"></div>
                </div>
            </div>
        `;
    }

    updateStats() {
        // Frequency Information
        const freq = this.radio.getFrequency();
        const band = this.radio.getFrequencyBand(freq);
        this.updateElement('stats-frequency', this.radio.formatFrequency(freq));
        this.updateElement('stats-band', band || 'N/A');

        // Mode Information
        const mode = this.radio.getMode();
        this.updateElement('stats-mode', mode.toUpperCase());

        // Bandwidth Information
        const bw = this.radio.getBandwidth();
        this.updateElement('stats-bw-low', `${bw.low} Hz`);
        this.updateElement('stats-bw-high', `${bw.high} Hz`);
        this.updateElement('stats-bw-width', `${Math.round(bw.width)} Hz`);

        // Audio Information
        const audioCtx = this.radio.getAudioContext();
        if (audioCtx) {
            this.updateElement('stats-sample-rate', `${audioCtx.sampleRate} Hz`);
            this.updateElement('stats-audio-state', audioCtx.state);

            // Update buffer time
            const bufferTime = this.radio.getBufferTime();
            if (bufferTime > 0) {
                this.updateElement('stats-buffer-time', bufferTime.toFixed(0) + ' ms');
            } else {
                this.updateElement('stats-buffer-time', 'N/A');
            }

            if (this.currentAudioLevel !== undefined && isFinite(this.currentAudioLevel)) {
                const levelStr = this.currentAudioLevel.toFixed(1) + ' dB';
                this.updateElement('stats-audio-level', levelStr);

                // Update audio meter (map -60 to 0 dB to 0-100%)
                const meterEl = document.getElementById('stats-audio-meter');
                if (meterEl) {
                    const percentage = Math.max(0, Math.min(100, ((this.currentAudioLevel + 60) / 60) * 100));
                    meterEl.style.width = percentage + '%';
                }
            } else {
                // No audio level available yet
                this.updateElement('stats-audio-level', 'No signal');
                const meterEl = document.getElementById('stats-audio-meter');
                if (meterEl) {
                    meterEl.style.width = '0%';
                }
            }
        } else {
            // No audio context yet
            this.updateElement('stats-sample-rate', 'Not started');
            this.updateElement('stats-audio-state', 'Not started');
            this.updateElement('stats-buffer-time', 'Not started');
            this.updateElement('stats-audio-level', 'Not started');
        }

        // Connection Information
        const connected = this.radio.isConnected();
        const statusEl = document.getElementById('stats-connection-status');
        if (statusEl) {
            statusEl.textContent = connected ? 'Connected' : 'Disconnected';
            statusEl.className = connected ? 'stats-badge connected' : 'stats-badge disconnected';
        }
        this.updateElement('stats-session', this.radio.getSessionId());

        // Spectrum Information
        const spectrumData = this.radio.getSpectrumData();
        if (spectrumData) {
            this.updateElement('stats-spectrum-center', this.radio.formatFrequency(spectrumData.centerFreq));
            this.updateElement('stats-spectrum-binbw', spectrumData.binBandwidth.toFixed(1) + ' Hz');
            this.updateElement('stats-spectrum-bins', spectrumData.binCount);
            this.updateElement('stats-spectrum-zoom', Math.round(spectrumData.zoomLevel) + '×');

            // Update spectrum processing demo values
            if (this.spectrumPeakFreq > 0) {
                this.updateElement('stats-spectrum-peakfreq', this.radio.formatFrequency(this.spectrumPeakFreq));
            } else {
                this.updateElement('stats-spectrum-peakfreq', 'N/A');
            }
            
            if (isFinite(this.spectrumPeakPower)) {
                this.updateElement('stats-spectrum-peakpower', this.spectrumPeakPower.toFixed(1) + ' dB');
            } else {
                this.updateElement('stats-spectrum-peakpower', 'N/A');
            }
            
            if (isFinite(this.spectrumAvgPower)) {
                this.updateElement('stats-spectrum-avgpower', this.spectrumAvgPower.toFixed(1) + ' dB');
            } else {
                this.updateElement('stats-spectrum-avgpower', 'N/A');
            }
            
            this.updateElement('stats-spectrum-occupancy', this.spectrumOccupancy.toFixed(1) + '%');
        }
        
        // Update audio processing demo values
        if (this.audioPeakValue !== undefined) {
            this.updateElement('stats-audio-peak', (this.audioPeakValue * 100).toFixed(1) + '%');
        } else {
            this.updateElement('stats-audio-peak', 'N/A');
        }
        
        if (this.audioZeroCrossings !== undefined) {
            this.updateElement('stats-audio-zcr', this.audioZeroCrossings + '/frame');
        } else {
            this.updateElement('stats-audio-zcr', 'N/A');
        }
        
        if (this.audioDominantFreq !== undefined && this.audioDominantFreq > 0) {
            this.updateElement('stats-audio-domfreq', this.audioDominantFreq.toFixed(0) + ' Hz');
        } else {
            this.updateElement('stats-audio-domfreq', 'N/A');
        }

        // Update Audio Spectrum Display
        this.updateAudioSpectrum();

        // Update RF Spectrum Display
        this.updateRFSpectrum();

        // Bands Information
        const bands = this.radio.getBands();
        if (bands && bands.length > 0) {
            const bandsCard = document.getElementById('stats-bands-card');
            const bandsList = document.getElementById('stats-bands-list');
            const bandsCount = document.getElementById('stats-bands-count');

            if (bandsCard) bandsCard.style.display = 'block';
            if (bandsCount) bandsCount.textContent = bands.length;

            if (bandsList) {
                // Group bands by their 'group' property
                const groupedBands = {};
                bands.forEach(band => {
                    const group = band.group || 'Other';
                    if (!groupedBands[group]) {
                        groupedBands[group] = [];
                    }
                    groupedBands[group].push(band);
                });

                // Build HTML with groups
                let html = '';
                Object.keys(groupedBands).sort().forEach(group => {
                    html += `
                        <div style="margin-top: 12px; margin-bottom: 8px; padding: 4px 8px; background: rgba(255,255,255,0.1); border-radius: 4px; font-weight: 600; font-size: 0.9em; color: #3498db;">
                            ${group}
                        </div>
                    `;
                    groupedBands[group].forEach(band => {
                        const start = this.radio.formatFrequency(band.start);
                        const end = this.radio.formatFrequency(band.end);
                        html += `
                            <div class="stats-list-item">
                                <span class="stats-list-item-name">${band.name || band.label}</span>
                                <span class="stats-list-item-value">${start} - ${end}</span>
                            </div>
                        `;
                    });
                });
                bandsList.innerHTML = html;
            }
        }

        // Bookmarks Information
        const bookmarks = this.radio.getBookmarks();
        if (bookmarks && bookmarks.length > 0) {
            const bookmarksCard = document.getElementById('stats-bookmarks-card');
            const bookmarksList = document.getElementById('stats-bookmarks-list');
            const bookmarksCount = document.getElementById('stats-bookmarks-count');

            if (bookmarksCard) bookmarksCard.style.display = 'block';
            if (bookmarksCount) bookmarksCount.textContent = bookmarks.length;

            if (bookmarksList) {
                bookmarksList.innerHTML = bookmarks.map(bookmark => {
                    const freqStr = this.radio.formatFrequency(bookmark.frequency);
                    return `
                        <div class="stats-list-item">
                            <span class="stats-list-item-name">${bookmark.name}</span>
                            <span class="stats-list-item-value">${freqStr} (${bookmark.mode.toUpperCase()})</span>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    updateAudioSpectrum() {
        const container = document.getElementById('audio-spectrum-display');
        if (!container) return;

        // Display peak frequency
        if (this.audioDominantFreq !== undefined && this.audioDominantFreq > 0 && this.audioFrequencyData) {
            this.updateElement('stats-audio-peak-freq', this.audioDominantFreq.toFixed(0) + ' Hz');

            // Use actual frequency spectrum data around the peak frequency
            const numBars = 25;
            const rangeHz = 4000; // ±2 kHz
            const centerFreq = this.audioDominantFreq;
            const lowFreq = Math.max(20, centerFreq - rangeHz / 2);
            const highFreq = Math.min(20000, centerFreq + rangeHz / 2);

            this.updateElement('audio-spectrum-low', lowFreq.toFixed(0) + ' Hz');
            this.updateElement('audio-spectrum-high', highFreq.toFixed(0) + ' Hz');

            // Calculate which FFT bins correspond to our frequency range
            const nyquist = this.audioSampleRate / 2;
            const binCount = this.audioFrequencyData.length;

            // Generate bars using actual FFT data
            let html = '';
            let maxAmplitude = 0;
            let peakBarIndex = -1;
            const barAmplitudes = [];

            // First pass: collect amplitudes and find max
            for (let i = 0; i < numBars; i++) {
                const freq = lowFreq + (i / (numBars - 1)) * (highFreq - lowFreq);
                const binIndex = Math.floor((freq / nyquist) * binCount);

                if (binIndex >= 0 && binIndex < binCount) {
                    const amplitude = this.audioFrequencyData[binIndex] / 255; // Normalize to 0-1
                    barAmplitudes.push(amplitude);
                    if (amplitude > maxAmplitude) {
                        maxAmplitude = amplitude;
                        peakBarIndex = i;
                    }
                } else {
                    barAmplitudes.push(0);
                }
            }

            // Second pass: render bars
            for (let i = 0; i < numBars; i++) {
                const amplitude = barAmplitudes[i];
                const height = Math.max(2, amplitude * 100);

                const isPeak = (i === peakBarIndex && amplitude > 0.5);
                const barClass = isPeak ? 'spectrum-bar peak' : 'spectrum-bar';

                html += `<div class="${barClass}" style="height: ${height}%"></div>`;
            }
            container.innerHTML = html;
        } else {
            this.updateElement('stats-audio-peak-freq', 'No signal');
            this.updateElement('audio-spectrum-low', '-');
            this.updateElement('audio-spectrum-high', '-');
            container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #95a5a6;">No audio signal</div>';
        }
    }

    updateRFSpectrum() {
        const container = document.getElementById('rf-spectrum-display');
        if (!container) return;

        if (this.currentSpectrumData && this.spectrumPeakFreq > 0) {
            this.updateElement('stats-spectrum-peak-freq-display', this.radio.formatFrequency(this.spectrumPeakFreq));

            const powers = this.currentSpectrumData.powers;
            const binBandwidth = this.currentSpectrumData.binBandwidth;
            const centerFreq = this.currentSpectrumData.centerFreq;
            const peakBin = this.spectrumPeakBin;

            // Show ±5 kHz around the peak (adjustable)
            const displayRangeHz = 10000; // 10 kHz total
            const binsToShow = Math.min(25, Math.floor(displayRangeHz / binBandwidth));
            const halfBins = Math.floor(binsToShow / 2);

            const startBin = Math.max(0, peakBin - halfBins);
            const endBin = Math.min(powers.length - 1, peakBin + halfBins);

            // Calculate frequency range
            const startFreq = centerFreq + ((startBin - powers.length / 2) * binBandwidth);
            const endFreq = centerFreq + ((endBin - powers.length / 2) * binBandwidth);

            this.updateElement('rf-spectrum-low', this.radio.formatFrequency(startFreq));
            this.updateElement('rf-spectrum-high', this.radio.formatFrequency(endFreq));

            // Find min/max power in the display range for scaling
            let minPower = Infinity;
            let maxPower = -Infinity;
            for (let i = startBin; i <= endBin; i++) {
                if (powers[i] < minPower) minPower = powers[i];
                if (powers[i] > maxPower) maxPower = powers[i];
            }

            const powerRange = maxPower - minPower;

            // Generate bars
            let html = '';
            for (let i = startBin; i <= endBin; i++) {
                const power = powers[i];
                const normalizedPower = powerRange > 0 ? (power - minPower) / powerRange : 0;
                const height = Math.max(2, normalizedPower * 100);

                const isPeak = i === peakBin;
                const barClass = isPeak ? 'spectrum-bar peak' : 'spectrum-bar';

                html += `<div class="${barClass}" style="height: ${height}%"></div>`;
            }
            container.innerHTML = html;
        } else {
            this.updateElement('stats-spectrum-peak-freq-display', 'No signal');
            this.updateElement('rf-spectrum-low', '-');
            this.updateElement('rf-spectrum-high', '-');
            container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #95a5a6;">No spectrum data</div>';
        }
    }

    updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = value;
        }
    }

    getContentElement() {
        // Get the decoder extension content element
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    onFrequencyChanged(frequency) {
        // Update immediately when frequency changes
        this.updateStats();
    }

    onModeChanged(mode) {
        // Update immediately when mode changes
        this.updateStats();
    }

    onBandwidthChanged(low, high) {
        // Update immediately when bandwidth changes
        console.log('Stats extension received bandwidth change:', low, high);
        this.updateStats();
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new StatsExtension());
    console.log('✅ Stats Extension registered');
}