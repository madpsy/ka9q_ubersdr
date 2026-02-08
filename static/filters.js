
// Audio Filters Module
// Extracted from app.js - contains all audio filter implementations
// NR2 remains in its own file (nr2.js)

// ============================================================================
// LATENCY CALCULATION AND DISPLAY
// ============================================================================

// Calculate latency for each filter based on current settings
function calculateFilterLatencies() {
    const latencies = {
        equalizer: 0,
        bandpass: 0,
        notch: 0,
        nr2: 0,
        compressor: 0,
        stereo: 0,
        squelch: 0
    };

    // Get current sample rate from audio context (changes with mode)
    const sampleRate = window.audioContext ? window.audioContext.sampleRate : 48000;

    // Equalizer: Fixed latency (~1ms per biquad filter at 48kHz, scales with sample rate)
    if (equalizerEnabled) {
        // Each biquad filter adds approximately 1 sample of latency
        // 12 bands = 12 samples latency
        latencies.equalizer = (12 / sampleRate) * 1000;
    }

    // Bandpass: Variable based on stages (each stage adds ~1 sample latency)
    if (bandpassEnabled) {
        const stages = parseInt(document.getElementById('bandpass-stages')?.value || 4);
        // Each stage adds approximately 1 sample of latency
        latencies.bandpass = (stages / sampleRate) * 1000;
    }

    // Notch: Variable based on number of notches (6 cascaded stages each)
    if (notchEnabled && notchFilters.length > 0) {
        // Each notch has 6 cascaded biquad stages = 6 samples latency per notch
        // Multiple notches are processed in series, so latencies add up
        const samplesLatency = notchFilters.length * 6;
        latencies.notch = (samplesLatency / sampleRate) * 1000;
    }

    // NR2: FFT-based latency (dynamic based on sample rate)
    const nr2Checkbox = document.getElementById('noise-reduction-enable');
    if (nr2Checkbox && nr2Checkbox.checked) {
        // NR2 uses overlap-add processing with a 2048-sample FFT buffer
        // PLUS a ScriptProcessorNode with a 2048-sample buffer (from app.js:5186)
        // The algorithm must fill the entire FFT buffer before producing output
        // AND the ScriptProcessorNode adds its own buffer latency
        // fftSize = 2048, overlapFactor = 4, hopSize = 512
        // scriptProcessorBuffer = 2048 (from app.js line 5186)
        // Total latency = fftSize + scriptProcessorBuffer = 4096 samples
        const fftSize = 2048;
        const scriptProcessorBuffer = 2048;
        latencies.nr2 = ((fftSize + scriptProcessorBuffer) / sampleRate) * 1000;
    }

    // Compressor: Based on attack time + lookahead (already in time units)
    if (compressorEnabled) {
        const attack = parseFloat(document.getElementById('compressor-attack')?.value || 0.003);
        latencies.compressor = (attack * 1000) + 5; // attack + 5ms lookahead
    }

    // Stereo Virtualizer: Direct delay value (already in ms)
    if (stereoVirtualizerEnabled) {
        const delay = parseInt(document.getElementById('stereo-delay')?.value || 16);
        latencies.stereo = delay;
    }

    // Squelch: Based on attack time (already in ms)
    if (squelchEnabled) {
        const attack = parseInt(document.getElementById('squelch-attack')?.value || 20);
        latencies.squelch = attack;
    }

    return latencies;
}

// Get total filter latency in milliseconds
function getTotalFilterLatency() {
    const latencies = calculateFilterLatencies();
    return Object.values(latencies).reduce((sum, lat) => sum + lat, 0);
}

// Update latency display badges for all filters
function updateAllLatencyDisplays() {
    const latencies = calculateFilterLatencies();

    updateLatencyBadge('equalizer', latencies.equalizer);
    updateLatencyBadge('bandpass', latencies.bandpass);
    updateLatencyBadge('notch', latencies.notch);
    updateLatencyBadge('noise-reduction', latencies.nr2);
    updateLatencyBadge('compressor', latencies.compressor);
    updateLatencyBadge('stereo-virtualizer', latencies.stereo);
    updateLatencyBadge('squelch', latencies.squelch);

    // Notify spectrum display of latency change for synchronization
    notifyFilterLatencyChanged();
}

// Notify listeners that filter latency has changed
function notifyFilterLatencyChanged() {
    const totalLatency = getTotalFilterLatency();

    // Dispatch custom event for spectrum display synchronization
    const event = new CustomEvent('filterLatencyChanged', {
        detail: { totalLatency }
    });
    window.dispatchEvent(event);

    console.log(`Filter latency changed: ${totalLatency.toFixed(1)}ms`);
}

// Update individual latency badge
function updateLatencyBadge(filterId, latencyMs) {
    const badge = document.getElementById(`${filterId}-latency-badge`);
    if (badge) {
        if (latencyMs > 0) {
            // Format with 1 decimal place for precision
            badge.textContent = `${latencyMs.toFixed(1)}ms`;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }
    }
}


// ============================================================================
// EQUALIZER (12-band parametric EQ)
// ============================================================================

let equalizerEnabled = false;
let eqFilters = [];
let eqMakeupGain = null;
let eqAnalyser = null;
let eqClipping = false;
let eqClipIndicatorTimeout = null;

function initializeEqualizer() {
    if (!window.audioContext) return;

    // Clear old filters (they belong to old audio context)
    eqFilters = [];

    const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
    frequencies.forEach(freq => {
        const filter = window.audioContext.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.0;
        filter.gain.value = 0;
        eqFilters.push(filter);
    });
    eqMakeupGain = window.audioContext.createGain();
    eqMakeupGain.gain.value = 1.0;
    eqAnalyser = window.audioContext.createAnalyser();
    eqAnalyser.fftSize = 2048;
    eqAnalyser.smoothingTimeConstant = 0;
    console.log('12-band equalizer initialized');
}

function toggleEqualizer() {
    const checkbox = document.getElementById('equalizer-enable');
    const badge = document.getElementById('equalizer-status-badge');
    equalizerEnabled = checkbox.checked;
    if (equalizerEnabled) {
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Equalizer enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Equalizer disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateEqualizer() {
    const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
    frequencies.forEach((freq, index) => {
        const slider = document.getElementById(`eq-${freq}`);
        const valueDisplay = document.getElementById(`eq-${freq}-value`);
        if (slider && valueDisplay && eqFilters[index]) {
            const gain = parseFloat(slider.value);
            eqFilters[index].gain.value = gain;
            valueDisplay.textContent = `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
        }
    });
    const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
    const makeupGainDisplay = document.getElementById('equalizer-makeup-gain-value');
    if (makeupGainSlider && makeupGainDisplay && eqMakeupGain) {
        const makeupGainDb = parseFloat(makeupGainSlider.value);
        eqMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
        makeupGainDisplay.textContent = `${makeupGainDb > 0 ? '+' : ''}${makeupGainDb.toFixed(1)} dB`;
    }
    saveFilterSettings();
}

function resetEqualizer() {
    const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
    frequencies.forEach((freq, index) => {
        const slider = document.getElementById(`eq-${freq}`);
        const valueDisplay = document.getElementById(`eq-${freq}-value`);
        if (slider && valueDisplay) {
            slider.value = 0;
            valueDisplay.textContent = '0 dB';
        }
        if (eqFilters[index]) {
            eqFilters[index].gain.value = 0;
        }
    });
    const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
    const makeupGainDisplay = document.getElementById('equalizer-makeup-gain-value');
    if (makeupGainSlider && makeupGainDisplay) {
        makeupGainSlider.value = 0;
        makeupGainDisplay.textContent = '+0 dB';
    }
    if (eqMakeupGain) {
        eqMakeupGain.gain.value = 1.0;
    }
    console.log('Equalizer reset');
}

function applyEQPreset(presetName) {
    // Enable equalizer if not already enabled
    if (!equalizerEnabled) {
        const checkbox = document.getElementById('equalizer-enable');
        if (checkbox) {
            checkbox.checked = true;
            toggleEqualizer();
        }
    }

    const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
    let presetValues = {};

    if (presetName === 'voice') {
        // Voice preset: Optimized for SSB voice communications
        // Roll off low frequencies, boost speech intelligibility range (300-3000 Hz)
        presetValues = {
            60: -6,      // Roll off very low frequencies
            170: -3,     // Reduce low rumble
            310: 0,      // Start of voice range
            600: 2,      // Boost lower voice fundamentals
            1000: 3,     // Boost mid-range for clarity
            1500: 4,     // Boost upper mid for intelligibility
            2000: 4,     // Peak boost for consonants
            2500: 3,     // Maintain presence
            3000: 2,     // Start rolling off
            4000: 0,     // Reduce sibilance
            6000: -3,    // Roll off high frequencies
            8000: -6     // Reduce noise and hiss
        };
    } else if (presetName === 'cw') {
        // CW preset: Narrow bandpass centered around typical CW tones (600-800 Hz)
        // Very aggressive filtering to isolate CW signals
        presetValues = {
            60: -12,     // Eliminate very low frequencies
            170: -12,    // Eliminate low frequencies
            310: -6,     // Reduce below CW range
            600: 6,      // Boost CW fundamental range
            1000: 6,     // Boost CW range
            1500: 0,     // Neutral above CW range
            2000: -6,    // Reduce harmonics
            2500: -9,    // Reduce high frequencies
            3000: -12,   // Eliminate high frequencies
            4000: -12,   // Eliminate very high frequencies
            6000: -12,   // Eliminate very high frequencies
            8000: -12    // Eliminate very high frequencies
        };
    } else {
        console.error('Unknown EQ preset:', presetName);
        return;
    }

    // Calculate total positive gain for makeup gain compensation
    let totalPositiveGain = 0;
    let positiveGainCount = 0;
    frequencies.forEach(freq => {
        const gain = presetValues[freq];
        if (gain > 0) {
            totalPositiveGain += gain;
            positiveGainCount++;
        }
    });

    // Calculate average positive gain for compensation
    const avgPositiveGain = positiveGainCount > 0 ? totalPositiveGain / positiveGainCount : 0;
    // Apply compensation: reduce makeup gain by approximately the average boost
    const makeupGainCompensation = Math.min(0, -avgPositiveGain * 0.7); // 70% compensation to avoid over-correction

    console.log(`Preset ${presetName}: Total positive gain=${totalPositiveGain.toFixed(1)} dB, Avg=${avgPositiveGain.toFixed(1)} dB, Compensation=${makeupGainCompensation.toFixed(1)} dB`);

    // Apply the preset values to sliders and filters
    frequencies.forEach((freq, index) => {
        const slider = document.getElementById(`eq-${freq}`);
        if (slider) {
            slider.value = presetValues[freq];
        }
    });

    // Apply makeup gain compensation to slider
    const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
    if (makeupGainSlider) {
        const compensatedGain = Math.max(-12, Math.min(12, makeupGainCompensation));
        makeupGainSlider.value = compensatedGain;
        console.log(`Set makeup gain slider to ${compensatedGain.toFixed(1)} dB`);
    }

    // Now call updateEqualizer to apply all changes to filters and displays
    updateEqualizer();

    console.log(`Applied ${presetName} EQ preset with ${makeupGainCompensation.toFixed(1)} dB makeup gain compensation`);
}

// EQ Quick Toggle - cycles through Off -> Voice -> CW -> Off
let eqQuickState = 'off'; // 'off', 'voice', 'cw'

function toggleEQQuick() {
    const button = document.getElementById('eq-quick-toggle');
    const checkbox = document.getElementById('equalizer-enable');
    
    if (!button || !checkbox) return;
    
    // Cycle through states: off -> voice -> cw -> off
    if (eqQuickState === 'off') {
        // Enable EQ and apply Voice preset
        eqQuickState = 'voice';
        applyEQPreset('voice');
        button.textContent = 'Voice';
        button.style.backgroundColor = '#28a745'; // Green
        console.log('EQ Quick Toggle: Voice preset enabled');
    } else if (eqQuickState === 'voice') {
        // Apply CW preset
        eqQuickState = 'cw';
        applyEQPreset('cw');
        button.textContent = 'CW';
        button.style.backgroundColor = '#17a2b8'; // Cyan
        console.log('EQ Quick Toggle: CW preset enabled');
    } else {
        // Disable EQ
        eqQuickState = 'off';
        if (checkbox.checked) {
            checkbox.checked = false;
            toggleEqualizer();
        }
        button.textContent = 'EQ';
        button.style.backgroundColor = '#6c757d'; // Gray
        console.log('EQ Quick Toggle: EQ disabled');
    }
}

function showEqualizerClipIndicator() {
    const indicator = document.getElementById('equalizer-clip-indicator');
    if (!indicator) return;
    indicator.style.display = 'inline';
    eqClipping = true;
    if (eqClipIndicatorTimeout) clearTimeout(eqClipIndicatorTimeout);
    eqClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        eqClipping = false;
    }, 2000);
}

// ============================================================================
// BANDPASS FILTER
// ============================================================================

let bandpassFilters = [];
let bandpassEnabled = false;

function toggleBandpassFilter() {
    const checkbox = document.getElementById('bandpass-enable');
    const badge = document.getElementById('bandpass-status-badge');
    bandpassEnabled = checkbox.checked;
    if (bandpassEnabled) {
        updateBandpassSliderRanges();
        if (bandpassFilters.length === 0 && window.audioContext) {
            initializeBandpassFilter();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Bandpass enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Bandpass disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateBandpassSliderRanges() {
    const centerSlider = document.getElementById('bandpass-center');
    const widthSlider = document.getElementById('bandpass-width');
    if (!centerSlider || !widthSlider) return;
    const cwOffset = (Math.abs(window.currentBandwidthLow) < 500 && Math.abs(window.currentBandwidthHigh) < 500) ? 500 : 0;
    let displayLow, displayHigh;
    if (window.currentBandwidthLow < 0 && window.currentBandwidthHigh <= 0) {
        displayLow = Math.abs(window.currentBandwidthHigh);
        displayHigh = Math.abs(window.currentBandwidthLow);
    } else {
        displayLow = cwOffset + window.currentBandwidthLow;
        displayHigh = cwOffset + window.currentBandwidthHigh;
    }
    const newMin = Math.max(50, displayLow);
    const newMax = displayHigh;
    centerSlider.min = newMin;
    centerSlider.max = newMax;
    const currentCenter = parseInt(centerSlider.value);
    if (currentCenter < newMin || currentCenter > newMax) {
        const clampedValue = Math.max(newMin, Math.min(newMax, currentCenter));
        centerSlider.value = clampedValue;
        updateBandpassFilter();
    }
}

function initializeBandpassFilter() {
    if (!window.audioContext) return;
    for (let filter of bandpassFilters) {
        try { filter.disconnect(); } catch (e) {}
    }
    bandpassFilters = [];
    const center = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    const stages = parseInt(document.getElementById('bandpass-stages').value);
    const autoQ = document.getElementById('bandpass-auto-q').checked;
    const qMultiplier = parseFloat(document.getElementById('bandpass-q-multiplier').value);
    let Q;
    if (autoQ) {
        // For bandpass: Q = center_freq / bandwidth
        // Multiply by stages/2 for more gradual control
        Q = Math.max(0.7, (center / width) * (stages / 2));
    } else {
        const baseQ = Math.max(0.7, (center / width) * (stages / 2));
        Q = baseQ * qMultiplier;
    }
    for (let i = 0; i < stages; i++) {
        const filter = window.audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = center;
        filter.Q.value = Q;
        bandpassFilters.push(filter);
    }
    console.log(`Bandpass initialized: ${center} Hz, ${stages} stages`);
}

function updateBandpassFilter() {
    const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    const stages = parseInt(document.getElementById('bandpass-stages').value);
    const autoQ = document.getElementById('bandpass-auto-q').checked;
    const qMultiplier = parseFloat(document.getElementById('bandpass-q-multiplier').value);
    const qControl = document.getElementById('bandpass-q-control');
    if (qControl) {
        qControl.style.display = autoQ ? 'none' : 'block';
    }
    document.getElementById('bandpass-center-value').textContent = sliderCenter + ' Hz';
    document.getElementById('bandpass-width-value').textContent = width + ' Hz';
    const stagesDisplay = document.getElementById('bandpass-stages-rolloff-value');
    if (stagesDisplay) {
        stagesDisplay.textContent = stages + ' (' + (stages * 12) + ' dB/oct)';
    }
    const qDisplay = document.getElementById('bandpass-q-multiplier-value');
    if (qDisplay) {
        qDisplay.textContent = qMultiplier.toFixed(1) + 'x';
    }
    if (bandpassFilters.length !== stages) {
        if (window.audioContext) {
            initializeBandpassFilter();
        }
        updateAllLatencyDisplays();
        saveFilterSettings();
        return;
    }
    if (bandpassFilters.length === 0) {
        if (window.audioContext) {
            initializeBandpassFilter();
        }
        updateAllLatencyDisplays();
        saveFilterSettings();
        return;
    }
    const actualCenter = (window.currentBandwidthLow < 0 && window.currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
    let Q;
    if (autoQ) {
        // For bandpass: Q = center_freq / bandwidth
        // Multiply by stages/2 for more gradual control
        Q = Math.max(0.7, (Math.abs(actualCenter) / width) * (stages / 2));
    } else {
        const baseQ = Math.max(0.7, (Math.abs(actualCenter) / width) * (stages / 2));
        Q = baseQ * qMultiplier;
    }
    for (let filter of bandpassFilters) {
        filter.frequency.value = Math.abs(actualCenter);
        filter.Q.value = Q;
    }
    if (window.cwDecoder && window.cwDecoder.enabled) {
        window.updateCWDecoderFrequency(Math.abs(actualCenter));
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function resetBandpassFilter() {
    const defaults = { center: 800, width: 200, stages: 4, autoQ: true, qMultiplier: 1.0 };
    document.getElementById('bandpass-center').value = defaults.center;
    document.getElementById('bandpass-width').value = defaults.width;
    document.getElementById('bandpass-stages').value = defaults.stages;
    document.getElementById('bandpass-auto-q').checked = defaults.autoQ;
    document.getElementById('bandpass-q-multiplier').value = defaults.qMultiplier;
    updateBandpassFilter();
    console.log('Bandpass filter reset');
}

// ============================================================================
// NOTCH FILTER
// ============================================================================

let notchFilters = [];
let notchEnabled = false;
const MAX_NOTCHES = 5;

function addManualNotch() {
    const centerFreq = Math.round((window.currentBandwidthLow + window.currentBandwidthHigh) / 2);
    addNotchFilter(centerFreq);
}

function addNotchFilter(centerFreq) {
    if (!window.audioContext) {
        console.error('Audio context not initialized');
        return;
    }
    if (notchFilters.length >= MAX_NOTCHES) {
        console.error(`Maximum of ${MAX_NOTCHES} notch filters reached`);
        return;
    }
    const defaultWidth = 50;
    const notch = {
        center: centerFreq,
        width: defaultWidth,
        filters: []
    };
    for (let i = 0; i < 6; i++) {
        const filter = window.audioContext.createBiquadFilter();
        filter.type = 'notch';
        filter.frequency.value = Math.abs(centerFreq);
        // For notch filters: Q = center_freq / bandwidth
        // With 6 cascaded stages, use a divisor of 3 for more gradual width control
        // Higher width value = lower Q = wider notch
        const effectiveQ = Math.max(0.7, Math.abs(centerFreq) / (defaultWidth * 3));
        filter.Q.value = effectiveQ;
        notch.filters.push(filter);
    }
    notchFilters.push(notch);
    if (!notchEnabled) {
        const checkbox = document.getElementById('notch-enable');
        if (checkbox) {
            checkbox.checked = true;
            toggleNotchFilter();
        }
    }
    updateNotchFilterUI();
    updateAllLatencyDisplays();
    saveFilterSettings();
    console.log(`Notch filter added at ${centerFreq} Hz`);
}

function removeNotchFilter(index) {
    if (index < 0 || index >= notchFilters.length) return;
    const notch = notchFilters[index];
    for (let filter of notch.filters) {
        try { filter.disconnect(); } catch (e) {}
    }
    notchFilters.splice(index, 1);
    updateNotchFilterUI();
    updateAllLatencyDisplays();
    saveFilterSettings();
    console.log(`Notch filter removed`);
}

function updateNotchFilterParams(index) {
    if (index < 0 || index >= notchFilters.length) return;
    const notch = notchFilters[index];
    const centerInput = document.getElementById(`notch-center-${index}`);
    const widthInput = document.getElementById(`notch-width-${index}`);
    if (centerInput && widthInput) {
        const sliderCenter = parseInt(centerInput.value);
        const width = parseInt(widthInput.value);
        const displayCenter = (window.currentBandwidthLow < 0 && window.currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
        // For notch filters: Q = center_freq / bandwidth
        // With 6 cascaded stages, use a divisor of 3 for more gradual width control
        // Higher width value = lower Q = wider notch
        const Q = Math.max(0.7, Math.abs(displayCenter) / (width * 3));
        notch.center = displayCenter;
        notch.width = width;
        for (let filter of notch.filters) {
            filter.frequency.value = Math.abs(displayCenter);
            filter.Q.value = Q;
        }
        document.getElementById(`notch-center-value-${index}`).textContent = sliderCenter + ' Hz';
        document.getElementById(`notch-width-value-${index}`).textContent = width + ' Hz';
        saveFilterSettings();
    }
}

function toggleNotchFilter() {
    const checkbox = document.getElementById('notch-enable');
    const badge = document.getElementById('notch-status-badge');
    notchEnabled = checkbox.checked;
    if (notchEnabled) {
        updateNotchFilterUI();
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Notch filters enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Notch filters disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateNotchFilterUI() {
    const container = document.getElementById('notch-list');
    if (!container) return;
    container.innerHTML = '';
    if (notchFilters.length === 0) {
        container.innerHTML = '<p style="color: #888; font-style: italic; margin: 10px 0;">Right-click on spectrum or waterfall to add notch filters (max 5)</p>';
        return;
    }
    const cwOffset = (Math.abs(window.currentBandwidthLow) < 500 && Math.abs(window.currentBandwidthHigh) < 500) ? 500 : 0;
    let sliderMin, sliderMax;
    if (window.currentBandwidthLow < 0 && window.currentBandwidthHigh <= 0) {
        sliderMin = Math.abs(window.currentBandwidthHigh);
        sliderMax = Math.abs(window.currentBandwidthLow);
    } else {
        sliderMin = cwOffset + window.currentBandwidthLow;
        sliderMax = cwOffset + window.currentBandwidthHigh;
    }
    notchFilters.forEach((notch, index) => {
        const sliderValue = Math.abs(notch.center);
        const notchDiv = document.createElement('div');
        notchDiv.className = 'notch-filter-item';
        notchDiv.innerHTML = `
            <div class="notch-filter-header">
                <span class="notch-filter-title">Notch ${index + 1}</span>
                <button onclick="removeNotchFilter(${index})" class="notch-remove-btn">✕</button>
            </div>
            <div class="control-group">
                <label for="notch-center-${index}">Center: <span id="notch-center-value-${index}">${sliderValue} Hz</span></label>
                <input type="range" id="notch-center-${index}" min="${sliderMin}" max="${sliderMax}" value="${sliderValue}" step="10" oninput="updateNotchFilterParams(${index})">
            </div>
            <div class="control-group">
                <label for="notch-width-${index}">Width: <span id="notch-width-value-${index}">${notch.width} Hz</span></label>
                <input type="range" id="notch-width-${index}" min="10" max="1000" value="${notch.width}" step="10" oninput="updateNotchFilterParams(${index})">
            </div>
        `;
        container.appendChild(notchDiv);
    });
    const countDisplay = document.getElementById('notch-count');
    if (countDisplay) {
        countDisplay.textContent = `${notchFilters.length}/${MAX_NOTCHES}`;
    }
}

function clearAllNotches() {
    for (let notch of notchFilters) {
        for (let filter of notch.filters) {
            try { filter.disconnect(); } catch (e) {}
        }
    }
    notchFilters = [];
    updateNotchFilterUI();
    updateAllLatencyDisplays();
    console.log('All notch filters cleared');
}

// ============================================================================
// COMPRESSOR/AGC
// ============================================================================

let compressor = null;
let compressorMakeupGain = null;
let compressorAnalyser = null;
let compressorEnabled = false;
let compressorClipping = false;
let compressorClipIndicatorTimeout = null;

function initializeCompressor() {
    if (!window.audioContext) return;
    compressor = window.audioContext.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressorMakeupGain = window.audioContext.createGain();
    compressorMakeupGain.gain.value = 1.0;
    compressorAnalyser = window.audioContext.createAnalyser();
    compressorAnalyser.fftSize = 2048;
    compressorAnalyser.smoothingTimeConstant = 0;
    console.log('Compressor initialized');
}

function toggleCompressor() {
    const checkbox = document.getElementById('compressor-enable');
    const badge = document.getElementById('compressor-status-badge');
    compressorEnabled = checkbox.checked;
    if (compressorEnabled) {
        if (!compressor && window.audioContext) {
            initializeCompressor();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Compressor enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Compressor disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateCompressor() {
    if (!compressor) {
        if (window.audioContext) {
            initializeCompressor();
        }
        return;
    }
    const threshold = parseFloat(document.getElementById('compressor-threshold').value);
    const ratio = parseFloat(document.getElementById('compressor-ratio').value);
    const attack = parseFloat(document.getElementById('compressor-attack').value);
    const release = parseFloat(document.getElementById('compressor-release').value);
    const makeupGainDb = parseFloat(document.getElementById('compressor-makeup-gain').value);
    compressor.threshold.value = threshold;
    compressor.ratio.value = ratio;
    compressor.attack.value = attack;
    compressor.release.value = release;
    if (compressorMakeupGain) {
        compressorMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
    }
    document.getElementById('compressor-threshold-value').textContent = threshold + ' dB';
    document.getElementById('compressor-ratio-value').textContent = ratio.toFixed(1) + ':1';
    document.getElementById('compressor-attack-value').textContent = attack.toFixed(3) + ' s';
    document.getElementById('compressor-release-value').textContent = release.toFixed(2) + ' s';
    document.getElementById('compressor-makeup-gain-value').textContent = '+' + makeupGainDb + ' dB';
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function resetCompressor() {
    if (!compressor) {
        if (window.audioContext) {
            initializeCompressor();
        }
        return;
    }
    const defaults = { threshold: -24, ratio: 12, attack: 0.003, release: 0.25, makeupGain: 0 };
    document.getElementById('compressor-threshold').value = defaults.threshold;
    document.getElementById('compressor-ratio').value = defaults.ratio;
    document.getElementById('compressor-attack').value = defaults.attack;
    document.getElementById('compressor-release').value = defaults.release;
    document.getElementById('compressor-makeup-gain').value = defaults.makeupGain;
    document.getElementById('compressor-threshold-value').textContent = defaults.threshold + ' dB';
    document.getElementById('compressor-ratio-value').textContent = defaults.ratio.toFixed(1) + ':1';
    document.getElementById('compressor-attack-value').textContent = defaults.attack.toFixed(3) + ' s';
    document.getElementById('compressor-release-value').textContent = defaults.release.toFixed(2) + ' s';
    document.getElementById('compressor-makeup-gain-value').textContent = '+' + defaults.makeupGain + ' dB';
    compressor.threshold.value = defaults.threshold;
    compressor.ratio.value = defaults.ratio;
    compressor.attack.value = defaults.attack;
    compressor.release.value = defaults.release;
    if (compressorMakeupGain) {
        compressorMakeupGain.gain.value = 1.0;
    }
    console.log('Compressor reset');
}

function showCompressorClipIndicator() {
    const indicator = document.getElementById('compressor-clip-indicator');
    if (!indicator) return;
    indicator.style.display = 'inline';
    compressorClipping = true;
    if (compressorClipIndicatorTimeout) clearTimeout(compressorClipIndicatorTimeout);
    compressorClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        compressorClipping = false;
    }, 2000);
}

// ============================================================================
// STEREO VIRTUALIZER
// ============================================================================

let stereoVirtualizerEnabled = false;
let stereoSplitter = null;
let stereoMerger = null;
let stereoDelayLeft = null;
let stereoDelayRight = null;
let stereoGainLeft = null;
let stereoGainRight = null;
let stereoWidthGain = null;
let stereoMakeupGain = null;
let stereoAnalyser = null;
let stereoClipping = false;
let stereoClipIndicatorTimeout = null;

function initializeStereoVirtualizer() {
    if (!window.audioContext) return;
    stereoSplitter = window.audioContext.createChannelSplitter(2);
    stereoDelayLeft = window.audioContext.createDelay(0.1);
    stereoDelayRight = window.audioContext.createDelay(0.1);
    stereoDelayLeft.delayTime.value = 0.016;
    stereoDelayRight.delayTime.value = 0;
    stereoGainLeft = window.audioContext.createGain();
    stereoGainRight = window.audioContext.createGain();
    stereoGainLeft.gain.value = 1.0;
    stereoGainRight.gain.value = 1.0;
    stereoWidthGain = window.audioContext.createGain();
    stereoWidthGain.gain.value = 0.5;
    stereoMerger = window.audioContext.createChannelMerger(2);
    stereoMakeupGain = window.audioContext.createGain();
    stereoMakeupGain.gain.value = 1.0;
    stereoAnalyser = window.audioContext.createAnalyser();
    stereoAnalyser.fftSize = 2048;
    stereoAnalyser.smoothingTimeConstant = 0;
    console.log('Stereo virtualizer initialized');
}

function toggleStereoVirtualizer() {
    const checkbox = document.getElementById('stereo-virtualizer-enable');
    const badge = document.getElementById('stereo-virtualizer-status-badge');
    stereoVirtualizerEnabled = checkbox.checked;
    if (stereoVirtualizerEnabled) {
        if (!stereoSplitter && window.audioContext) {
            initializeStereoVirtualizer();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Stereo virtualizer enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Stereo virtualizer disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateStereoVirtualizer() {
    const width = parseInt(document.getElementById('stereo-width').value);
    const delay = parseInt(document.getElementById('stereo-delay').value);
    const separation = parseInt(document.getElementById('stereo-separation').value);
    const makeupGainDb = parseFloat(document.getElementById('stereo-makeup-gain').value);
    document.getElementById('stereo-width-value').textContent = width + '%';
    document.getElementById('stereo-delay-value').textContent = delay + ' ms';
    document.getElementById('stereo-separation-value').textContent = separation + '%';
    document.getElementById('stereo-makeup-gain-value').textContent = '+' + makeupGainDb.toFixed(1) + ' dB';
    if (!stereoDelayLeft || !stereoDelayRight || !stereoGainLeft || !stereoGainRight || !stereoWidthGain || !stereoMakeupGain) {
        if (window.audioContext) {
            initializeStereoVirtualizer();
        }
        return;
    }
    stereoDelayLeft.delayTime.value = delay / 1000;
    stereoDelayRight.delayTime.value = 0;
    stereoGainLeft.gain.value = 1.0;
    stereoGainRight.gain.value = 1.0;
    stereoWidthGain.gain.value = width / 100;
    stereoMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function resetStereoVirtualizer() {
    const defaults = { width: 50, delay: 16, separation: 40, makeupGain: 0 };
    document.getElementById('stereo-width').value = defaults.width;
    document.getElementById('stereo-delay').value = defaults.delay;
    document.getElementById('stereo-separation').value = defaults.separation;
    document.getElementById('stereo-makeup-gain').value = defaults.makeupGain;
    updateStereoVirtualizer();
    console.log('Stereo virtualizer reset');
}

function showStereoClipIndicator() {
    const indicator = document.getElementById('stereo-virtualizer-clip-indicator');
    if (!indicator) return;
    indicator.style.display = 'inline';
    stereoClipping = true;
    if (stereoClipIndicatorTimeout) clearTimeout(stereoClipIndicatorTimeout);
    stereoClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        stereoClipping = false;
    }, 2000);
}

// ============================================================================
// SQUELCH / AUDIO GATE
// ============================================================================

let squelchEnabled = false;
let squelchThreshold = -35;
let squelchHysteresis = 3;
let squelchAttack = 0.020;
let squelchRelease = 0.500;
let squelchGate = null;
let squelchAnalyser = null;
let squelchOpen = true;
let squelchCurrentLevel = -Infinity;
let squelchTargetGain = 1.0;
let lastSquelchStatusUpdate = 0;
const squelchStatusUpdateInterval = 100;

function initializeSquelch() {
    if (!window.audioContext) return;
    squelchGate = window.audioContext.createGain();
    squelchGate.gain.value = 1.0;
    squelchAnalyser = window.audioContext.createAnalyser();
    squelchAnalyser.fftSize = 2048;
    squelchAnalyser.smoothingTimeConstant = 0.3;
    squelchOpen = true;
    squelchCurrentLevel = -Infinity;
    console.log('Squelch initialized');
}

function toggleSquelch() {
    const checkbox = document.getElementById('squelch-enable');
    const badge = document.getElementById('squelch-status-badge');
    squelchEnabled = checkbox.checked;
    if (squelchEnabled) {
        if (!squelchGate && window.audioContext) {
            initializeSquelch();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        console.log('Squelch enabled');
    } else {
        if (squelchGate) {
            squelchGate.gain.setValueAtTime(1.0, window.audioContext.currentTime);
            squelchOpen = true;
            updateSquelchStatus();
        }
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        console.log('Squelch disabled');
    }
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function updateSquelch() {
    const thresholdDb = parseInt(document.getElementById('squelch-threshold').value);
    const hysteresisDb = parseFloat(document.getElementById('squelch-hysteresis').value);
    const attackMs = parseInt(document.getElementById('squelch-attack').value);
    const releaseMs = parseInt(document.getElementById('squelch-release').value);
    squelchThreshold = thresholdDb;
    squelchHysteresis = hysteresisDb;
    squelchAttack = attackMs / 1000;
    squelchRelease = releaseMs / 1000;
    document.getElementById('squelch-threshold-value').textContent = thresholdDb + ' dB';
    document.getElementById('squelch-hysteresis-value').textContent = hysteresisDb + ' dB';
    document.getElementById('squelch-attack-value').textContent = attackMs + ' ms';
    document.getElementById('squelch-release-value').textContent = releaseMs + ' ms';
    updateAllLatencyDisplays();
    saveFilterSettings();
}

function resetSquelch() {
    const defaults = { threshold: -35, hysteresis: 3, attack: 20, release: 500 };
    document.getElementById('squelch-threshold').value = defaults.threshold;
    document.getElementById('squelch-hysteresis').value = defaults.hysteresis;
    document.getElementById('squelch-attack').value = defaults.attack;
    document.getElementById('squelch-release').value = defaults.release;
    updateSquelch();
    console.log('Squelch reset');
}

function processSquelch() {
    if (!squelchEnabled || !squelchAnalyser || !squelchGate || !window.audioContext) return;
    const dataArray = new Uint8Array(squelchAnalyser.frequencyBinCount);
    squelchAnalyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    squelchCurrentLevel = levelDb;
    const currentTime = window.audioContext.currentTime;
    let newTargetGain = squelchTargetGain;
    if (squelchOpen) {
        if (levelDb < (squelchThreshold - squelchHysteresis)) {
            newTargetGain = 0.0;
            squelchOpen = false;
        }
    } else {
        if (levelDb > (squelchThreshold + squelchHysteresis)) {
            newTargetGain = 1.0;
            squelchOpen = true;
        }
    }
    if (newTargetGain !== squelchTargetGain) {
        squelchTargetGain = newTargetGain;
        squelchGate.gain.cancelScheduledValues(currentTime);
        squelchGate.gain.setValueAtTime(squelchGate.gain.value, currentTime);
        const fadeTime = newTargetGain > 0 ? squelchAttack : squelchRelease;
        squelchGate.gain.linearRampToValueAtTime(squelchTargetGain, currentTime + fadeTime);
    }
    const now = performance.now();
    if (now - lastSquelchStatusUpdate >= squelchStatusUpdateInterval) {
        updateSquelchStatus();
        lastSquelchStatusUpdate = now;
    }
}

function updateSquelchStatus() {
    const statusEl = document.getElementById('squelch-status');
    const levelEl = document.getElementById('squelch-level');
    if (!statusEl || !levelEl) return;
    const currentGain = squelchGate ? squelchGate.gain.value : 1.0;
    if (currentGain > 0.9) {
        statusEl.textContent = 'OPEN';
        statusEl.style.color = '#28a745';
    } else if (currentGain < 0.1) {
        statusEl.textContent = 'CLOSED';
        statusEl.style.color = '#dc3545';
    } else if (squelchTargetGain > 0.5) {
        statusEl.textContent = 'OPENING';
        statusEl.style.color = '#ffc107';
    } else {
        statusEl.textContent = 'CLOSING';
        statusEl.style.color = '#ff9800';
    }
    if (squelchCurrentLevel === -Infinity) {
        levelEl.textContent = 'Level: -∞ dB';
    } else {
        levelEl.textContent = `Level: ${squelchCurrentLevel.toFixed(1)} dB`;
    }
}

// ============================================================================
// LOCAL STORAGE PERSISTENCE
// ============================================================================

const STORAGE_KEY_PREFIX = 'ka9q_filter_';
let isRestoringSettings = false;

function saveFilterSettings() {
    // Don't save while we're restoring settings
    if (isRestoringSettings) return;

    // Check if saving is enabled
    const saveEnabled = document.getElementById('save-filters-enable');
    if (!saveEnabled || !saveEnabled.checked) {
        return; // Don't save if checkbox is not checked
    }

    try {
        // Equalizer
        const eqSettings = {
            enabled: equalizerEnabled,
            bands: {},
            makeupGain: document.getElementById('equalizer-makeup-gain')?.value || 0
        };
        const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
        frequencies.forEach(freq => {
            const slider = document.getElementById(`eq-${freq}`);
            if (slider) eqSettings.bands[freq] = parseFloat(slider.value);
        });
        localStorage.setItem(STORAGE_KEY_PREFIX + 'equalizer', JSON.stringify(eqSettings));

        // Bandpass
        const bandpassSettings = {
            enabled: bandpassEnabled,
            center: document.getElementById('bandpass-center')?.value || 800,
            width: document.getElementById('bandpass-width')?.value || 200,
            stages: document.getElementById('bandpass-stages')?.value || 4,
            autoQ: document.getElementById('bandpass-auto-q')?.checked || true,
            qMultiplier: document.getElementById('bandpass-q-multiplier')?.value || 1.0
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'bandpass', JSON.stringify(bandpassSettings));

        // Notch
        const notchSettings = {
            enabled: notchEnabled,
            filters: notchFilters.map(n => ({ center: n.center, width: n.width }))
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'notch', JSON.stringify(notchSettings));

        // Compressor
        const compressorSettings = {
            enabled: compressorEnabled,
            threshold: document.getElementById('compressor-threshold')?.value || -24,
            ratio: document.getElementById('compressor-ratio')?.value || 12,
            attack: document.getElementById('compressor-attack')?.value || 0.003,
            release: document.getElementById('compressor-release')?.value || 0.25,
            makeupGain: document.getElementById('compressor-makeup-gain')?.value || 0
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'compressor', JSON.stringify(compressorSettings));

        // Stereo Virtualizer
        const stereoSettings = {
            enabled: stereoVirtualizerEnabled,
            width: document.getElementById('stereo-width')?.value || 50,
            delay: document.getElementById('stereo-delay')?.value || 16,
            separation: document.getElementById('stereo-separation')?.value || 40,
            makeupGain: document.getElementById('stereo-makeup-gain')?.value || 0
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'stereo', JSON.stringify(stereoSettings));

        // Squelch
        const squelchSettings = {
            enabled: squelchEnabled,
            threshold: document.getElementById('squelch-threshold')?.value || -35,
            hysteresis: document.getElementById('squelch-hysteresis')?.value || 3,
            attack: document.getElementById('squelch-attack')?.value || 20,
            release: document.getElementById('squelch-release')?.value || 500
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'squelch', JSON.stringify(squelchSettings));

        // Noise Reduction (NR2) - from app.js
        const nr2Checkbox = document.getElementById('noise-reduction-enable');
        const nr2Settings = {
            enabled: nr2Checkbox ? nr2Checkbox.checked : false,
            strength: document.getElementById('noise-reduction-strength')?.value || 40,
            floor: document.getElementById('noise-reduction-floor')?.value || 10,
            adaptRate: document.getElementById('noise-reduction-adapt-rate')?.value || 1.0,
            makeupGain: document.getElementById('noise-reduction-makeup-gain')?.value || -3
        };
        localStorage.setItem(STORAGE_KEY_PREFIX + 'nr2', JSON.stringify(nr2Settings));

        console.log('✅ Filter settings saved to localStorage');
    } catch (e) {
        console.error('Failed to save filter settings:', e);
    }
}

function restoreFilterSettings() {
    // Set flag to prevent saves during restoration
    isRestoringSettings = true;

    try {
        // Equalizer
        const eqSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'equalizer'));
        if (eqSettings) {
            const checkbox = document.getElementById('equalizer-enable');
            if (checkbox) {
                checkbox.checked = eqSettings.enabled;
                toggleEqualizer();
            }
            const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
            frequencies.forEach(freq => {
                const slider = document.getElementById(`eq-${freq}`);
                if (slider && eqSettings.bands[freq] !== undefined) {
                    slider.value = eqSettings.bands[freq];
                }
            });
            const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
            if (makeupGainSlider && eqSettings.makeupGain !== undefined) {
                makeupGainSlider.value = eqSettings.makeupGain;
            }
            updateEqualizer();
        }

        // Bandpass
        const bandpassSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'bandpass'));
        if (bandpassSettings) {
            const checkbox = document.getElementById('bandpass-enable');
            if (checkbox) {
                checkbox.checked = bandpassSettings.enabled;
                toggleBandpassFilter();
            }
            if (bandpassSettings.center) document.getElementById('bandpass-center').value = bandpassSettings.center;
            if (bandpassSettings.width) document.getElementById('bandpass-width').value = bandpassSettings.width;
            if (bandpassSettings.stages) document.getElementById('bandpass-stages').value = bandpassSettings.stages;
            if (bandpassSettings.autoQ !== undefined) document.getElementById('bandpass-auto-q').checked = bandpassSettings.autoQ;
            if (bandpassSettings.qMultiplier) document.getElementById('bandpass-q-multiplier').value = bandpassSettings.qMultiplier;
            updateBandpassFilter();
        }

        // Notch
        const notchSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'notch'));
        if (notchSettings) {
            // Clear existing notches first
            clearAllNotches();
            // Restore notch filters
            if (notchSettings.filters && notchSettings.filters.length > 0) {
                notchSettings.filters.forEach(n => {
                    addNotchFilter(n.center);
                    // Update width after adding
                    const index = notchFilters.length - 1;
                    if (index >= 0) {
                        notchFilters[index].width = n.width;
                    }
                });
                updateNotchFilterUI();
            }
            const checkbox = document.getElementById('notch-enable');
            if (checkbox) {
                checkbox.checked = notchSettings.enabled;
                toggleNotchFilter();
            }
        }

        // Compressor
        const compressorSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'compressor'));
        if (compressorSettings) {
            const checkbox = document.getElementById('compressor-enable');
            if (checkbox) {
                checkbox.checked = compressorSettings.enabled;
                toggleCompressor();
            }
            if (compressorSettings.threshold) document.getElementById('compressor-threshold').value = compressorSettings.threshold;
            if (compressorSettings.ratio) document.getElementById('compressor-ratio').value = compressorSettings.ratio;
            if (compressorSettings.attack) document.getElementById('compressor-attack').value = compressorSettings.attack;
            if (compressorSettings.release) document.getElementById('compressor-release').value = compressorSettings.release;
            if (compressorSettings.makeupGain !== undefined) document.getElementById('compressor-makeup-gain').value = compressorSettings.makeupGain;
            updateCompressor();
        }

        // Stereo Virtualizer
        const stereoSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'stereo'));
        if (stereoSettings) {
            const checkbox = document.getElementById('stereo-virtualizer-enable');
            if (checkbox) {
                checkbox.checked = stereoSettings.enabled;
                toggleStereoVirtualizer();
            }
            if (stereoSettings.width) document.getElementById('stereo-width').value = stereoSettings.width;
            if (stereoSettings.delay) document.getElementById('stereo-delay').value = stereoSettings.delay;
            if (stereoSettings.separation) document.getElementById('stereo-separation').value = stereoSettings.separation;
            if (stereoSettings.makeupGain !== undefined) document.getElementById('stereo-makeup-gain').value = stereoSettings.makeupGain;
            updateStereoVirtualizer();
        }

        // Squelch
        const squelchSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'squelch'));
        if (squelchSettings) {
            const checkbox = document.getElementById('squelch-enable');
            if (checkbox) {
                checkbox.checked = squelchSettings.enabled;
                toggleSquelch();
            }
            if (squelchSettings.threshold) document.getElementById('squelch-threshold').value = squelchSettings.threshold;
            if (squelchSettings.hysteresis) document.getElementById('squelch-hysteresis').value = squelchSettings.hysteresis;
            if (squelchSettings.attack) document.getElementById('squelch-attack').value = squelchSettings.attack;
            if (squelchSettings.release) document.getElementById('squelch-release').value = squelchSettings.release;
            updateSquelch();
        }

        // Noise Reduction (NR2) - from app.js
        const nr2Settings = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + 'nr2'));
        if (nr2Settings) {
            // Set slider values first
            if (nr2Settings.strength) document.getElementById('noise-reduction-strength').value = nr2Settings.strength;
            if (nr2Settings.floor) document.getElementById('noise-reduction-floor').value = nr2Settings.floor;
            if (nr2Settings.adaptRate) document.getElementById('noise-reduction-adapt-rate').value = nr2Settings.adaptRate;
            if (nr2Settings.makeupGain !== undefined) document.getElementById('noise-reduction-makeup-gain').value = nr2Settings.makeupGain;

            // Set checkbox state
            const checkbox = document.getElementById('noise-reduction-enable');
            if (checkbox) {
                checkbox.checked = nr2Settings.enabled;
            }

            // Update the parameters (this will update the display values)
            // This is safe to call even without audio context
            if (window.updateNoiseReduction) {
                window.updateNoiseReduction();
            }

            // Note: toggleNoiseReduction will be called automatically when audio context
            // is initialized if the checkbox is checked
        }

        console.log('✅ Filter settings restored from localStorage');
    } catch (e) {
        console.error('Failed to restore filter settings:', e);
    } finally {
        // Always clear the flag, even if there was an error
        isRestoringSettings = false;
    }
}

// Save and restore the "Save Filters" checkbox state
function toggleSaveFiltersEnabled() {
    const checkbox = document.getElementById('save-filters-enable');
    if (checkbox) {
        localStorage.setItem(STORAGE_KEY_PREFIX + 'saveEnabled', checkbox.checked);
        console.log('Save Filters checkbox state saved:', checkbox.checked);
    }
}

function restoreSaveFiltersCheckbox() {
    const savedState = localStorage.getItem(STORAGE_KEY_PREFIX + 'saveEnabled');
    if (savedState !== null) {
        const checkbox = document.getElementById('save-filters-enable');
        if (checkbox) {
            checkbox.checked = savedState === 'true';
            console.log('Save Filters checkbox state restored:', checkbox.checked);
        }
    }
}

// Clear all filter settings from localStorage
function clearFilterStorage() {
    // Show confirmation modal
    const modal = document.getElementById('clear-storage-modal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

function closeClearStorageModal() {
    const modal = document.getElementById('clear-storage-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function confirmClearStorage() {
    try {
        const keys = [
            'equalizer',
            'bandpass',
            'notch',
            'compressor',
            'stereoVirtualizer',
            'squelch',
            'nr2'
        ];
        keys.forEach(key => {
            localStorage.removeItem(STORAGE_KEY_PREFIX + key);
        });
        console.log('✅ Filter settings cleared from localStorage');
    } catch (error) {
        console.error('Error clearing filter settings:', error);
    }
    closeClearStorageModal();
}

// ============================================================================
// EXPOSE ALL TO WINDOW
// ============================================================================

window.saveFilterSettings = saveFilterSettings;
window.restoreFilterSettings = restoreFilterSettings;
window.clearFilterStorage = clearFilterStorage;
window.closeClearStorageModal = closeClearStorageModal;
window.confirmClearStorage = confirmClearStorage;
window.toggleSaveFiltersEnabled = toggleSaveFiltersEnabled;
window.restoreSaveFiltersCheckbox = restoreSaveFiltersCheckbox;

window.equalizerEnabled = equalizerEnabled;
window.eqFilters = eqFilters;
window.eqMakeupGain = eqMakeupGain;
window.eqAnalyser = eqAnalyser;
window.initializeEqualizer = initializeEqualizer;
window.toggleEqualizer = toggleEqualizer;
window.updateEqualizer = updateEqualizer;
window.resetEqualizer = resetEqualizer;
window.applyEQPreset = applyEQPreset;
window.toggleEQQuick = toggleEQQuick;
window.showEqualizerClipIndicator = showEqualizerClipIndicator;

window.bandpassFilters = bandpassFilters;
window.bandpassEnabled = bandpassEnabled;
window.toggleBandpassFilter = toggleBandpassFilter;
window.updateBandpassSliderRanges = updateBandpassSliderRanges;
window.initializeBandpassFilter = initializeBandpassFilter;
window.updateBandpassFilter = updateBandpassFilter;
window.resetBandpassFilter = resetBandpassFilter;

window.notchFilters = notchFilters;
window.notchEnabled = notchEnabled;
window.addManualNotch = addManualNotch;
window.addNotchFilter = addNotchFilter;
window.removeNotchFilter = removeNotchFilter;
window.updateNotchFilterParams = updateNotchFilterParams;
window.toggleNotchFilter = toggleNotchFilter;
window.updateNotchFilterUI = updateNotchFilterUI;
window.clearAllNotches = clearAllNotches;

window.compressor = compressor;
window.compressorMakeupGain = compressorMakeupGain;
window.compressorAnalyser = compressorAnalyser;
window.compressorEnabled = compressorEnabled;
window.initializeCompressor = initializeCompressor;
window.toggleCompressor = toggleCompressor;
window.updateCompressor = updateCompressor;
window.resetCompressor = resetCompressor;
window.showCompressorClipIndicator = showCompressorClipIndicator;

window.stereoVirtualizerEnabled = stereoVirtualizerEnabled;
window.stereoSplitter = stereoSplitter;
window.stereoMerger = stereoMerger;
window.stereoDelayLeft = stereoDelayLeft;
window.stereoDelayRight = stereoDelayRight;
window.stereoGainLeft = stereoGainLeft;
window.stereoGainRight = stereoGainRight;
window.stereoWidthGain = stereoWidthGain;
window.stereoMakeupGain = stereoMakeupGain;
window.stereoAnalyser = stereoAnalyser;
window.initializeStereoVirtualizer = initializeStereoVirtualizer;
window.toggleStereoVirtualizer = toggleStereoVirtualizer;
window.updateStereoVirtualizer = updateStereoVirtualizer;
window.resetStereoVirtualizer = resetStereoVirtualizer;
window.showStereoClipIndicator = showStereoClipIndicator;

window.squelchEnabled = squelchEnabled;
window.squelchThreshold = squelchThreshold;
window.squelchHysteresis = squelchHysteresis;
window.squelchAttack = squelchAttack;
window.squelchRelease = squelchRelease;
window.squelchGate = squelchGate;
window.squelchAnalyser = squelchAnalyser;
window.squelchOpen = squelchOpen;
window.squelchCurrentLevel = squelchCurrentLevel;
window.squelchTargetGain = squelchTargetGain;
window.initializeSquelch = initializeSquelch;
window.toggleSquelch = toggleSquelch;
window.updateSquelch = updateSquelch;
window.resetSquelch = resetSquelch;
window.processSquelch = processSquelch;
window.updateSquelchStatus = updateSquelchStatus;

window.calculateFilterLatencies = calculateFilterLatencies;
window.getTotalFilterLatency = getTotalFilterLatency;
window.updateAllLatencyDisplays = updateAllLatencyDisplays;
window.updateLatencyBadge = updateLatencyBadge;
window.notifyFilterLatencyChanged = notifyFilterLatencyChanged;

console.log('✅ Filters module loaded: Equalizer, Bandpass, Notch, Compressor, Stereo Virtualizer, Squelch');