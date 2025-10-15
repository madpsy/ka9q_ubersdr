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
        this.updateRate = 500; // Update every 500ms (2 Hz)
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
        // Load template from global scope (loaded by extension-loader.js)
        const template = window.stats_template;
        
        if (!template) {
            console.error('Stats extension template not loaded');
            return;
        }

        // Get container and inject template
        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
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
                const percentage = Math.max(0, Math.min(100, ((this.currentAudioLevel + 60) / 60) * 100));
                this.updateElementById('stats-audio-meter', (el) => {
                    el.style.width = percentage + '%';
                });
            } else {
                // No audio level available yet
                this.updateElement('stats-audio-level', 'No signal');
                this.updateElementById('stats-audio-meter', (el) => {
                    el.style.width = '0%';
                });
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
        const statusText = connected ? 'Connected' : 'Disconnected';
        const statusClass = connected ? 'stats-badge connected' : 'stats-badge disconnected';

        this.updateElementById('stats-connection-status', (el) => {
            el.textContent = statusText;
            el.className = statusClass;
        });
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
        // Check if container exists (will be updated in both panel and modal)
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
            // Update both panel and modal using helper
            this.updateElementById('audio-spectrum-display', (el) => {
                el.innerHTML = html;
            });
        } else {
            this.updateElement('stats-audio-peak-freq', 'No signal');
            this.updateElement('audio-spectrum-low', '-');
            this.updateElement('audio-spectrum-high', '-');
            const noSignalHtml = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #95a5a6;">No audio signal</div>';
            this.updateElementById('audio-spectrum-display', (el) => {
                el.innerHTML = noSignalHtml;
            });
        }
    }

    updateRFSpectrum() {
        // Check if container exists (will be updated in both panel and modal)
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
            // Update both panel and modal using helper
            this.updateElementById('rf-spectrum-display', (el) => {
                el.innerHTML = html;
            });
        } else {
            this.updateElement('stats-spectrum-peak-freq-display', 'No signal');
            this.updateElement('rf-spectrum-low', '-');
            this.updateElement('rf-spectrum-high', '-');
            const noDataHtml = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #95a5a6;">No spectrum data</div>';
            this.updateElementById('rf-spectrum-display', (el) => {
                el.innerHTML = noDataHtml;
            });
        }
    }

    updateElement(id, value) {
        // Use base class helper for automatic modal support
        this.updateElementById(id, (el) => {
            el.textContent = value;
        });
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