
// Audio Filters Module
// Extracted from app.js - contains all audio filter implementations
// NR2 remains in its own file (nr2.js)

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
        Q = Math.max(0.7, center / (width * stages));
    } else {
        const baseQ = Math.max(0.7, center / (width * stages));
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
        return;
    }
    if (bandpassFilters.length === 0) {
        if (window.audioContext) {
            initializeBandpassFilter();
        }
        return;
    }
    const actualCenter = (window.currentBandwidthLow < 0 && window.currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
    let Q;
    if (autoQ) {
        Q = Math.max(0.7, Math.abs(actualCenter) / (width * stages));
    } else {
        const baseQ = Math.max(0.7, Math.abs(actualCenter) / (width * stages));
        Q = baseQ * qMultiplier;
    }
    for (let filter of bandpassFilters) {
        filter.frequency.value = Math.abs(actualCenter);
        filter.Q.value = Q;
    }
    if (window.cwDecoder && window.cwDecoder.enabled) {
        window.updateCWDecoderFrequency(Math.abs(actualCenter));
    }
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
        filter.Q.value = Math.max(20, Math.abs(centerFreq) / (defaultWidth / 4));
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
        const Q = Math.max(20, Math.abs(displayCenter) / (width / 4));
        notch.center = displayCenter;
        notch.width = width;
        for (let filter of notch.filters) {
            filter.frequency.value = Math.abs(displayCenter);
            filter.Q.value = Q;
        }
        document.getElementById(`notch-center-value-${index}`).textContent = sliderCenter + ' Hz';
        document.getElementById(`notch-width-value-${index}`).textContent = width + ' Hz';
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
// EXPOSE ALL TO WINDOW
// ============================================================================

window.equalizerEnabled = equalizerEnabled;
window.eqFilters = eqFilters;
window.eqMakeupGain = eqMakeupGain;
window.eqAnalyser = eqAnalyser;
window.initializeEqualizer = initializeEqualizer;
window.toggleEqualizer = toggleEqualizer;
window.updateEqualizer = updateEqualizer;
window.resetEqualizer = resetEqualizer;
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

console.log('✅ Filters module loaded: Equalizer, Bandpass, Notch, Compressor, Stereo Virtualizer, Squelch');