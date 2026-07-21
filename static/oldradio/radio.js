
// Old Radio JavaScript - Pluggable Radio System
// Supports multiple radio models with different configurations
// Audio handling delegated to MinimalRadio class

// Generate a unique user session ID for linking connections
function generateUserSessionID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Generate UUID - will be regenerated when changing radios
let userSessionID = generateUserSessionID();
console.log('User Session ID:', userSessionID);

// Radio Configuration
let currentRadioConfig = null;
let availableRadios = [];

// Configuration from loaded radio
let MIN_FREQ = 600000;
let MAX_FREQ = 2000000;
let MODE = 'am';
let DIAL_GEAR_RATIO = 10;

// State
let minimalRadio = null; // MinimalRadio instance for audio handling
let currentFrequency = 1000000;
let currentVolume = 0.25;
let currentSquelch = 0; // Squelch level 0-1 (0 = off, 1 = max)
let currentSquelchSnr = -999; // Current squelch SNR threshold in dB (-999 = off)
let dialRotation = 0;
let volumeRotation = 0.25 * 330; // matches default currentVolume
let squelchRotation = 0; // Squelch knob starts at 0 (off)
let tuneTimeout = null;
let lastTuneTime = 0;
const TUNE_DEBOUNCE_MS = 25;
let urlUpdateTimeout = null;
let lastUrlUpdateTime = 0;
const URL_UPDATE_THROTTLE_MS = 1000;
let isChangingRadio = false;

// Signal LED
let vuLevel = 0;
let vuAnalyser = null;

// Visualiser (spectrum / oscilloscope / grille)
// Modes: 0 = spectrum bars (default), 1 = oscilloscope, 2 = grille
let visualiserMode = 0;
let visualiserCanvas = null;
let visualiserCtx = null;
let visualiserAnalyser = null;
let visualiserAnimFrame = null;
let visualiserResizeHandler = null; // stored so it can be removed on radio switch

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    const radioLoaded = await loadAvailableRadios();
    if (!radioLoaded) {
        await showRadioSelector();
    }
});

// Load available radios from radios.json
// Returns true if a radio was loaded, false otherwise
async function loadAvailableRadios() {
    try {
        const response = await fetch('radios/radios.json?v=' + Date.now());
        const data = await response.json();
        availableRadios = data.radios;

        // Check URL parameter for radio selection
        const params = new URLSearchParams(window.location.search);
        const radioParam = params.get('radio');

        if (radioParam) {
            const radio = availableRadios.find(r => r.id === radioParam);
            if (radio) {
                await loadRadio(radio.id);
                return true;
            }
        }

        // Load default radio if specified and no URL parameter
        if (data.default) {
            const defaultRadio = availableRadios.find(r => r.id === data.default);
            if (defaultRadio && availableRadios.length === 1) {
                // If only one radio, load it automatically
                await loadRadio(defaultRadio.id);
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error('Failed to load available radios:', error);
        return false;
    }
}

// Show radio selector overlay
async function showRadioSelector() {
    const overlay = document.getElementById('radio-selector-overlay');
    const radioList = document.getElementById('radio-list');

    // Clear existing options
    radioList.innerHTML = '';

    // Create radio options
    for (const radio of availableRadios) {
        const option = document.createElement('div');
        option.className = 'radio-option';
        option.innerHTML = `
            <h3>${radio.name}</h3>
            <p>${radio.description}</p>
        `;
        option.addEventListener('click', async () => {
            overlay.style.display = 'none';
            await loadRadio(radio.id);
        });
        radioList.appendChild(option);
    }

    // Hide the change radio button while selector is showing
    const changeRadioFloating = document.getElementById('change-radio-floating');
    if (changeRadioFloating) {
        changeRadioFloating.style.display = 'none';
    }

    overlay.style.display = 'flex';
}

// Load a specific radio configuration
async function loadRadio(radioId) {
    try {
        // Hide the radio selector overlay
        const selectorOverlay = document.getElementById('radio-selector-overlay');
        if (selectorOverlay) {
            selectorOverlay.style.display = 'none';
        }

        const radio = availableRadios.find(r => r.id === radioId);
        if (!radio) {
            console.error('Radio not found:', radioId);
            return;
        }

        // Load radio configuration (cache-busted to always get latest)
        const configResponse = await fetch(`${radio.path}/config.json?v=` + Date.now());
        currentRadioConfig = await configResponse.json();

        // Apply band for multi-band radios (merges band values into config).
        // Prefer the user's saved choice, else the config default. A URL `band`
        // param, applied later in loadSettingsFromURL, still takes precedence.
        if (currentRadioConfig.bands) {
            const savedBand = getSavedBand(radioId);
            const initialBand = (savedBand && currentRadioConfig.bands[savedBand])
                ? savedBand
                : (currentRadioConfig.defaultBand || Object.keys(currentRadioConfig.bands)[0]);
            applyBandConfig(initialBand);
        } else {
            currentBand = null;
        }

        // Update global configuration
        MIN_FREQ = currentRadioConfig.minFreq;
        MAX_FREQ = currentRadioConfig.maxFreq;
        // applyBandConfig already resolved the mode for multi-band radios; for the
        // rest this is just the radio's configured default.
        MODE = currentRadioConfig.mode;
        DIAL_GEAR_RATIO = currentRadioConfig.dialGearRatio;
        currentFrequency = currentRadioConfig.defaultFrequency;
        tuneOffset = 0;
        tuneRotation = 0;
        tuneNotch = 0;
        currentVolume = currentRadioConfig.defaultVolume;
        volumeRotation = currentVolume * 330;
        console.log('[loadRadio] defaultVolume from config:', currentRadioConfig.defaultVolume, '→ currentVolume:', currentVolume, 'volumeRotation:', volumeRotation);

        // Load radio template (cache-busted to always get latest)
        const templateResponse = await fetch(`${radio.path}/template.html?v=` + Date.now());
        const template = await templateResponse.text();

        // Replace template variables
        let processedTemplate = template
            .replace(/\{\{brand\}\}/g, currentRadioConfig.brand)
            .replace(/\{\{model\}\}/g, currentRadioConfig.model);

        // Load template into radio body
        document.getElementById('radio-body').innerHTML = processedTemplate;

        // Load radio-specific CSS and wait for it to load
        const styleLink = document.getElementById('radio-style');
        await new Promise((resolve) => {
            styleLink.onload = resolve;
            styleLink.href = `${radio.path}/style.css?v=` + Date.now();
        });

        // Generate frequency scale marks
        generateFrequencyScale();

        // Generate volume notches
        generateVolumeNotches();

        // Update URL with radio selection
        updateURLWithRadio(radioId);

        // Load settings from URL
        loadSettingsFromURL();

        // Show audio start overlay
        const audioOverlay = document.getElementById('audio-start-overlay');
        if (audioOverlay) {
            audioOverlay.style.display = 'flex';
        }

        // Setup audio start button (only once)
        setupAudioStartButton();

        // Show the change radio button
        const changeRadioFloating = document.getElementById('change-radio-floating');
        if (changeRadioFloating) {
            changeRadioFloating.style.display = 'block';
            changeRadioFloating.onclick = async () => {
                // Set flags to prevent processing audio and reconnection
                isChangingRadio = true;

                // Stop any active channel scan
                stopScan();

                // Cancel visualiser animation loop and clear stale references
                // so drawVisualiser() doesn't crash when the canvas is removed
                if (visualiserAnimFrame) {
                    cancelAnimationFrame(visualiserAnimFrame);
                    visualiserAnimFrame = null;
                }
                if (visualiserResizeHandler) {
                    window.removeEventListener('resize', visualiserResizeHandler);
                    visualiserResizeHandler = null;
                }
                visualiserCanvas = null;
                visualiserCtx = null;
                visualiserAnalyser = null;
                visualiserMode = 0; // reset to spectrum for next radio load

                // Stop MinimalRadio
                if (minimalRadio) {
                    await minimalRadio.stopPreview();
                    minimalRadio = null;
                }

                // Wait a bit for server to clean up the old session
                await new Promise(resolve => setTimeout(resolve, 500));

                // Generate new session ID for the new radio
                userSessionID = generateUserSessionID();
                console.log('New User Session ID:', userSessionID);

                // Clear the changing flag now that cleanup is done
                isChangingRadio = false;

                // Show selector
                showRadioSelector();
            };
        }

        console.log('Loaded radio:', radioId, currentRadioConfig);
    } catch (error) {
        console.error('Failed to load radio:', error);
        alert('Failed to load radio configuration');
    }
}

// Generate frequency scale marks dynamically
function generateFrequencyScale() {
    const scaleMarks = document.getElementById('scale-marks');
    if (!scaleMarks || !currentRadioConfig) return;

    scaleMarks.innerHTML = '';

    for (const mark of currentRadioConfig.frequencyScale) {
        const span = document.createElement('span');
        span.className = 'mark';
        span.style.left = mark.position;
        span.textContent = mark.label;
        scaleMarks.appendChild(span);
    }
}

// Generate volume notches dynamically
function generateVolumeNotches() {
    const volumeNotches = document.getElementById('volume-notches');
    if (!volumeNotches || !currentRadioConfig) return;

    volumeNotches.innerHTML = '';

    const notchCount = currentRadioConfig.volumeNotches;
    const angleStep = 330 / (notchCount - 1);

    for (let i = 0; i < notchCount; i++) {
        const span = document.createElement('span');
        span.className = 'notch';
        span.style.transform = `rotate(${i * angleStep}deg)`;
        span.textContent = i;
        volumeNotches.appendChild(span);
    }
}

// Update URL with radio selection
function updateURLWithRadio(radioId) {
    // Create fresh params with only the radio parameter
    // This clears any old freq/vol parameters from previous radio
    const params = new URLSearchParams();
    params.set('radio', radioId);
    const newURL = window.location.pathname + '?' + params.toString();
    window.history.replaceState({}, '', newURL);
}

// Audio Start Button
let audioStartButtonSetup = false;
let audioStartHandler = null;
let changeRadioHandler = null;

function setupAudioStartButton() {
    const overlay = document.getElementById('audio-start-overlay');
    const button = document.getElementById('audio-start-button');
    const changeButton = document.getElementById('change-radio-button');

    // Remove old event listeners if they exist
    if (audioStartHandler) {
        button.removeEventListener('click', audioStartHandler);
    }
    if (changeRadioHandler) {
        changeButton.removeEventListener('click', changeRadioHandler);
    }

    // Create new handlers
    audioStartHandler = async () => {
        try {
            overlay.style.display = 'none';
            startRadio();
        } catch (error) {
            console.error('Failed to start radio:', error);
            alert('Failed to start radio. Please check your browser permissions.');
        }
    };

    changeRadioHandler = () => {
        overlay.style.display = 'none';
        showRadioSelector();
    };

    // Add new event listeners
    button.addEventListener('click', audioStartHandler);
    changeButton.addEventListener('click', changeRadioHandler);

    audioStartButtonSetup = true;
}

// Start Radio
async function startRadio() {
    setupDials();
    setupChannelButtons();
    setupModeButton();
    setupSquelchKnob();
    setupTuneKnob();

    // Initialize MinimalRadio with our session ID
    minimalRadio = new MinimalRadio(userSessionID);
    console.log('[startRadio] calling setVolume with currentVolume:', currentVolume, 'volumeRotation:', volumeRotation);
    minimalRadio.setVolume(currentVolume);

    // Start audio preview
    try {
        await minimalRadio.startPreview(tunedFrequency(), MODE);
        console.log('Radio started successfully');

        // Wait a bit for audio context to be fully ready
        setTimeout(() => {
            // Setup VU meter and oscilloscope after audio context is initialized
            setupVUMeter();
            setupOscilloscope();
        }, 500);
    } catch (error) {
        console.error('Failed to start radio:', error);
        alert('Failed to start radio: ' + error.message);
    }
}

// Setup VU Meter
function setupVUMeter() {
    console.log('setupVUMeter called');
    if (!minimalRadio || !minimalRadio.audioContext) {
        console.error('Audio context not ready for VU meter', {
            minimalRadio: !!minimalRadio,
            audioContext: minimalRadio ? !!minimalRadio.audioContext : false
        });
        return;
    }

    console.log('Creating VU analyser...');
    vuAnalyser = minimalRadio.audioContext.createAnalyser();
    vuAnalyser.fftSize = 2048;
    vuAnalyser.smoothingTimeConstant = 0;

    // Connect analyser to MinimalRadio's audio stream
    console.log('Adding analyser to MinimalRadio, current analysers:', minimalRadio.externalAnalysers.length);
    minimalRadio.addAnalyser(vuAnalyser);
    console.log('Analyser added, now have:', minimalRadio.externalAnalysers.length, 'analysers');

    console.log('Starting updateSignalLED loop');
    updateSignalLED();
}

// Setup Dial Controls
function setupDials() {
    const tuningDial = document.getElementById('tuning-dial');
    const volumeKnob = document.getElementById('volume-knob');
    const frequencyScale = document.querySelector('.frequency-scale');

    // Click on frequency scale to tune (only if it exists)
    if (frequencyScale) {
        frequencyScale.addEventListener('click', (e) => {
            const rect = frequencyScale.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const normalized = clickX / rect.width;
            const clampedNormalized = Math.max(0, Math.min(1, normalized));

            const freqHz = MIN_FREQ + clampedNormalized * (MAX_FREQ - MIN_FREQ);
            currentFrequency = Math.round(freqHz);

            dialRotation = (clampedNormalized * 360) * DIAL_GEAR_RATIO;
            tuningDial.style.transform = `rotate(${dialRotation}deg)`;

            updateFrequencyDisplay();
            throttledUpdateURL();
            sendTuneCommand();
        });
    }

    // Tuning dial (only if it exists)
    if (!tuningDial) {
        console.log('No tuning dial found - not a dial-based radio');
        // Still setup volume knob if it exists
        if (volumeKnob) {
            setupVolumeKnob(volumeKnob);
        }
        return;
    }

    // Tuning dial
    let isDraggingTuning = false;
    let lastAngleTuning = 0;

    tuningDial.addEventListener('mousedown', (e) => {
        isDraggingTuning = true;
        lastAngleTuning = getAngle(tuningDial, e);
        e.preventDefault();
    });

    tuningDial.addEventListener('touchstart', (e) => {
        isDraggingTuning = true;
        const touch = e.touches[0];
        lastAngleTuning = getAngle(tuningDial, touch);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingTuning) {
            const angle = getAngle(tuningDial, e);
            let delta = angle - lastAngleTuning;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleTuning = angle;
            dialRotation += delta;

            tuningDial.style.transform = `rotate(${dialRotation}deg)`;
            updateFrequencyFromDial();
        }
    });

    document.addEventListener('touchmove', (e) => {
        if (isDraggingTuning) {
            const touch = e.touches[0];
            const angle = getAngle(tuningDial, touch);
            let delta = angle - lastAngleTuning;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleTuning = angle;
            dialRotation += delta;

            tuningDial.style.transform = `rotate(${dialRotation}deg)`;
            updateFrequencyFromDial();
            e.preventDefault();
        }
    });

    document.addEventListener('mouseup', () => {
        isDraggingTuning = false;
    });

    document.addEventListener('touchend', () => {
        isDraggingTuning = false;
    });

    // Volume knob
    if (volumeKnob) {
        setupVolumeKnob(volumeKnob);
    }
}

// Setup Volume Knob (separate function for reuse)
function setupVolumeKnob(volumeKnob) {
    let isDraggingVolume = false;
    let lastAngleVolume = 0;

    volumeKnob.addEventListener('mousedown', (e) => {
        isDraggingVolume = true;
        lastAngleVolume = getAngle(volumeKnob, e);
        e.preventDefault();
    });

    volumeKnob.addEventListener('touchstart', (e) => {
        isDraggingVolume = true;
        const touch = e.touches[0];
        lastAngleVolume = getAngle(volumeKnob, touch);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingVolume) {
            const angle = getAngle(volumeKnob, e);
            let delta = angle - lastAngleVolume;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleVolume = angle;
            volumeRotation += delta;
            volumeRotation = Math.max(0, Math.min(330, volumeRotation));

            volumeKnob.style.transform = `rotate(${volumeRotation}deg)`;
            updateVolumeFromKnob();
        }
    });

    document.addEventListener('touchmove', (e) => {
        if (isDraggingVolume) {
            const touch = e.touches[0];
            const angle = getAngle(volumeKnob, touch);
            let delta = angle - lastAngleVolume;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleVolume = angle;
            volumeRotation += delta;
            volumeRotation = Math.max(0, Math.min(330, volumeRotation));

            volumeKnob.style.transform = `rotate(${volumeRotation}deg)`;
            updateVolumeFromKnob();
            e.preventDefault();
        }
    });

    document.addEventListener('mouseup', () => {
        isDraggingVolume = false;
    });

    document.addEventListener('touchend', () => {
        isDraggingVolume = false;
    });
}

// Setup Channel Buttons for CB radio
function setupChannelButtons() {
    const channelUpBtn = document.getElementById('channel-up');
    const channelDownBtn = document.getElementById('channel-down');
    const scanBtn = document.getElementById('channel-scan');

    if (!channelUpBtn || !channelDownBtn) {
        console.log('Channel buttons not found - not a channel-based radio');
        return;
    }
    if (!currentRadioConfig || !currentRadioConfig.channels) {
        console.log('No channels configured for this radio');
        return;
    }

    console.log('Setting up channel buttons for', currentRadioConfig.channels.length, 'channels');

    channelUpBtn.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('Channel UP clicked');
        stopScan();
        changeChannel(1);
    });

    channelDownBtn.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('Channel DOWN clicked');
        stopScan();
        changeChannel(-1);
    });

    if (scanBtn) {
        scanBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (scanActive) {
                stopScan();
            } else {
                startScan();
            }
        });
    }

    const bandToggle = document.getElementById('band-toggle');
    if (bandToggle && currentRadioConfig.bands) {
        bandToggle.addEventListener('click', (e) => {
            e.preventDefault();
            toggleBand();
        });
        updateBandDisplay();
    }
}

// Mode handling — the user can cycle through the demodulators below, but the
// choice is deliberately not persisted: selecting a band always asserts that
// band's own default mode (UK/EU = FM, US = AM).
const MODE_CYCLE = ['fm', 'am', 'lsb', 'usb'];

function setupModeButton() {
    const modeToggle = document.getElementById('mode-toggle');
    if (!modeToggle) return;

    modeToggle.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMode();
    });
    updateModeDisplay();
}

// Step to the next demodulator and retune in place
function toggleMode() {
    const idx = MODE_CYCLE.indexOf(MODE);
    MODE = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];

    if (currentRadioConfig) {
        currentRadioConfig.mode = MODE;
    }

    console.log('Mode switched to', MODE);
    updateModeDisplay();
    throttledUpdateURL();
    sendTuneCommand();
}

function updateModeDisplay() {
    const modeToggle = document.getElementById('mode-toggle');
    if (modeToggle) {
        modeToggle.textContent = MODE.toUpperCase();
    }
}

// Band handling for multi-band radios (e.g. CB with UK/EU channel plans)
let currentBand = null;

// Persist the user's band choice (e.g. UK vs EU) per radio across sessions.
function bandStorageKey(radioId) {
    return `oldradio-band-${radioId}`;
}

function getSavedBand(radioId) {
    try {
        return localStorage.getItem(bandStorageKey(radioId));
    } catch (e) {
        return null;
    }
}

function saveBand(radioId, band) {
    try {
        localStorage.setItem(bandStorageKey(radioId), band);
    } catch (e) {
        /* storage unavailable (e.g. private mode) — ignore */
    }
}

// Merge the named band's values into the active config and global freq limits.
// If the band defines its own "mode" (e.g. US CB uses "am"), that overrides the
// radio-level default; otherwise the radio-level mode is restored.
function applyBandConfig(bandName) {
    if (!currentRadioConfig || !currentRadioConfig.bands) return;
    const band = currentRadioConfig.bands[bandName];
    if (!band) return;

    currentBand = bandName;
    currentRadioConfig.minFreq = band.minFreq;
    currentRadioConfig.maxFreq = band.maxFreq;
    currentRadioConfig.defaultFrequency = band.defaultFrequency;
    currentRadioConfig.channels = band.channels;
    MIN_FREQ = band.minFreq;
    MAX_FREQ = band.maxFreq;

    // The band's own mode always wins (UK/EU = "fm", US = "am"), discarding any
    // manual mode selection. Written back into the config so the radio-level
    // `mode` doesn't clobber it after loadRadio applies the band.
    MODE = band.mode || currentRadioConfig.mode;
    currentRadioConfig.mode = MODE;

    updateBandDisplay();
    updateModeDisplay();
}

// Switch to the next band, keeping the current channel number
function toggleBand() {
    if (!currentRadioConfig || !currentRadioConfig.bands) return;

    stopScan();

    // Remember the current channel number so we stay on it in the new band
    const currentChannel = currentRadioConfig.channels.find(ch => ch.frequency === currentFrequency);
    const channelNum = currentChannel ? currentChannel.number : null;

    const bandNames = Object.keys(currentRadioConfig.bands);
    const nextBand = bandNames[(bandNames.indexOf(currentBand) + 1) % bandNames.length];
    applyBandConfig(nextBand);
    saveBand(currentRadioConfig.id, nextBand);

    const newChannel = channelNum !== null
        ? currentRadioConfig.channels.find(ch => ch.number === channelNum)
        : null;
    currentFrequency = newChannel ? newChannel.frequency : currentRadioConfig.defaultFrequency;

    console.log('Band switched to', nextBand, '— channel', channelNum, '→', currentFrequency, 'Hz');

    resetTune(true);
    updateFrequencyDisplay();
    throttledUpdateURL();
    sendTuneCommand();
}

function updateBandDisplay() {
    const bandToggle = document.getElementById('band-toggle');
    if (bandToggle && currentBand) {
        bandToggle.textContent = currentBand;
    }
}

// Channel scanning — steps through channels at SCAN_STEP_MS per channel,
// stopping on any channel whose SNR is at/above the squelch threshold.
// With squelch off, SCAN_DEFAULT_SNR is used instead (the SNR at which the
// first signal bar lights) so the scan still stops on active channels.
let scanActive = false;
let scanTimer = null;
const SCAN_STEP_MS = 100;
const SCAN_DEFAULT_SNR = 30;

function startScan() {
    if (!currentRadioConfig || !currentRadioConfig.channels) return;
    scanActive = true;
    updateScanButtonState();
    scanStep();
}

function stopScan() {
    if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
    }
    if (!scanActive) return;
    scanActive = false;
    updateScanButtonState();
}

function scanStep() {
    if (!scanActive) return;
    changeChannel(1);
    scanTimer = setTimeout(() => {
        scanTimer = null;
        if (!scanActive) return;

        // Dwell over — stop here if the signal is above the squelch threshold
        // (or the default stop threshold when squelch is off)
        const stopSnr = currentSquelchSnr > SQUELCH_SENTINEL ? currentSquelchSnr : SCAN_DEFAULT_SNR;
        if (minimalRadio && minimalRadio.hasSignalQuality()) {
            const sq = minimalRadio.getSignalQuality();
            if (sq && sq.snr !== null && sq.snr >= stopSnr) {
                console.log('Scan stopped: SNR', sq.snr.toFixed(1), 'dB >= threshold', stopSnr, 'dB');
                stopScan();
                return;
            }
        }

        scanStep();
    }, SCAN_STEP_MS);
}

function updateScanButtonState() {
    const scanBtn = document.getElementById('channel-scan');
    if (scanBtn) {
        scanBtn.classList.toggle('scanning', scanActive);
    }
}

// Change channel for CB radio
function changeChannel(direction) {
    if (!currentRadioConfig || !currentRadioConfig.channels) {
        console.log('No channels available');
        return;
    }

    // Leaving the channel drops any clarifier offset — the new channel starts centred
    resetTune(true);

    // Find current channel
    const currentChannel = currentRadioConfig.channels.find(ch => ch.frequency === currentFrequency);
    if (!currentChannel) {
        console.log('Current frequency not found in channels, using first channel');
        // If current frequency doesn't match a channel, start at channel 1
        const firstChannel = currentRadioConfig.channels[0];
        currentFrequency = firstChannel.frequency;
        updateFrequencyDisplay();
        throttledUpdateURL();
        sendTuneCommand();
        return;
    }

    // Calculate new channel number
    let newChannelNum = currentChannel.number + direction;

    // Wrap around
    if (newChannelNum > currentRadioConfig.channels.length) {
        newChannelNum = 1;
    } else if (newChannelNum < 1) {
        newChannelNum = currentRadioConfig.channels.length;
    }

    // Find new channel
    const newChannel = currentRadioConfig.channels.find(ch => ch.number === newChannelNum);
    if (newChannel) {
        currentFrequency = newChannel.frequency;
        updateFrequencyDisplay();
        throttledUpdateURL();
        sendTuneCommand();
    } else {
        console.log('New channel not found!');
    }
}

// Get angle from center of element
function getAngle(element, event) {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const clientX = event.clientX !== undefined ? event.clientX : event.pageX;
    const clientY = event.clientY !== undefined ? event.clientY : event.pageY;
    const angle = Math.atan2(clientY - centerY, clientX - centerX);
    return angle * (180 / Math.PI);
}

// Update frequency from dial position
function updateFrequencyFromDial() {
    const gearAdjustedRotation = dialRotation / DIAL_GEAR_RATIO;
    const normalizedRotation = ((gearAdjustedRotation % 360) + 360) % 360;
    const normalized = normalizedRotation / 360;
    const freqKHz = MIN_FREQ / 1000 + normalized * ((MAX_FREQ - MIN_FREQ) / 1000);
    let freqHz = Math.round(freqKHz * 1000);

    if (freqHz > MAX_FREQ) freqHz = MIN_FREQ + (freqHz - MAX_FREQ);
    if (freqHz < MIN_FREQ) freqHz = MAX_FREQ - (MIN_FREQ - freqHz);

    currentFrequency = freqHz;
    updateFrequencyDisplay();
    throttledUpdateURL();

    const now = Date.now();
    if (now - lastTuneTime >= TUNE_DEBOUNCE_MS) {
        sendTuneCommand();
        lastTuneTime = now;
    } else {
        if (tuneTimeout) {
            clearTimeout(tuneTimeout);
        }
        tuneTimeout = setTimeout(() => {
            sendTuneCommand();
            lastTuneTime = Date.now();
        }, TUNE_DEBOUNCE_MS - (now - lastTuneTime));
    }
}

// Send tune command to server via MinimalRadio
function sendTuneCommand() {
    if (minimalRadio && minimalRadio.isPlaying) {
        minimalRadio.changeFrequency(tunedFrequency(), MODE);
    }
}

// Update volume from knob position
function updateVolumeFromKnob() {
    const maxRotation = 330;
    const clampedRotation = Math.min(volumeRotation, maxRotation);
    currentVolume = clampedRotation / maxRotation;

    // Update MinimalRadio volume
    if (minimalRadio) {
        minimalRadio.setVolume(currentVolume);
    }

    throttledUpdateURL();
}

// Setup Squelch Knob
function setupSquelchKnob() {
    const squelchKnob = document.getElementById('squelch-knob');
    if (!squelchKnob) {
        console.log('No squelch knob found');
        return;
    }

    let isDraggingSquelch = false;
    let lastAngleSquelch = 0;

    squelchKnob.addEventListener('mousedown', (e) => {
        isDraggingSquelch = true;
        lastAngleSquelch = getAngle(squelchKnob, e);
        e.preventDefault();
    });

    squelchKnob.addEventListener('touchstart', (e) => {
        isDraggingSquelch = true;
        const touch = e.touches[0];
        lastAngleSquelch = getAngle(squelchKnob, touch);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingSquelch) {
            const angle = getAngle(squelchKnob, e);
            let delta = angle - lastAngleSquelch;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleSquelch = angle;
            squelchRotation += delta;
            squelchRotation = Math.max(0, Math.min(330, squelchRotation));

            squelchKnob.style.transform = `rotate(${squelchRotation}deg)`;
            updateSquelchFromKnob();
        }
    });

    document.addEventListener('touchmove', (e) => {
        if (isDraggingSquelch) {
            const touch = e.touches[0];
            const angle = getAngle(squelchKnob, touch);
            let delta = angle - lastAngleSquelch;

            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            lastAngleSquelch = angle;
            squelchRotation += delta;
            squelchRotation = Math.max(0, Math.min(330, squelchRotation));

            squelchKnob.style.transform = `rotate(${squelchRotation}deg)`;
            updateSquelchFromKnob();
            e.preventDefault();
        }
    });

    document.addEventListener('mouseup', () => {
        isDraggingSquelch = false;
    });

    document.addEventListener('touchend', () => {
        isDraggingSquelch = false;
    });
}

// Fine tuning knob — a free-turning clarifier. Each detent shifts the tuned
// frequency by TUNE_STEP_HZ; on channel-based radios the shift is kept as an
// offset from the channel frequency so channel up/down keeps working.
const TUNE_DETENT_DEG = 15;   // 24 detents per revolution
const TUNE_STEP_HZ = 100;
const TUNE_OFFSET_LIMIT = 5000;

let tuneRotation = 0;
let tuneNotch = 0;
let tuneOffset = 0;

// The frequency actually sent to the server (channel frequency + clarifier)
function tunedFrequency() {
    return isChannelRadio() ? currentFrequency + tuneOffset : currentFrequency;
}

function isChannelRadio() {
    return !!(currentRadioConfig && currentRadioConfig.channels);
}

function setupTuneKnob() {
    const tuneKnob = document.getElementById('tune-knob');
    if (!tuneKnob) return;

    let isDraggingTune = false;
    let lastAngleTune = 0;

    // Rotate freely — no end stops — and fire a step on each detent crossed
    const applyRotation = (angle) => {
        let delta = angle - lastAngleTune;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        lastAngleTune = angle;
        tuneRotation += delta;

        const notch = Math.round(tuneRotation / TUNE_DETENT_DEG);
        if (notch !== tuneNotch) {
            stepTune(notch - tuneNotch);
            tuneNotch = notch;
            // Snap to the detent so the knob feels clicky rather than continuous
            tuneKnob.style.transform = `rotate(${notch * TUNE_DETENT_DEG}deg)`;
        }
    };

    tuneKnob.addEventListener('mousedown', (e) => {
        isDraggingTune = true;
        lastAngleTune = getAngle(tuneKnob, e);
        e.preventDefault();
    });

    tuneKnob.addEventListener('touchstart', (e) => {
        isDraggingTune = true;
        lastAngleTune = getAngle(tuneKnob, e.touches[0]);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingTune) applyRotation(getAngle(tuneKnob, e));
    });

    document.addEventListener('touchmove', (e) => {
        if (isDraggingTune) {
            applyRotation(getAngle(tuneKnob, e.touches[0]));
            e.preventDefault();
        }
    });

    document.addEventListener('mouseup', () => { isDraggingTune = false; });
    document.addEventListener('touchend', () => { isDraggingTune = false; });

    // Scroll wheel over the knob steps one detent at a time
    tuneKnob.addEventListener('wheel', (e) => {
        e.preventDefault();
        tuneNotch += e.deltaY < 0 ? 1 : -1;
        tuneRotation = tuneNotch * TUNE_DETENT_DEG;
        tuneKnob.style.transform = `rotate(${tuneRotation}deg)`;
        stepTune(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    // Double click recentres the clarifier
    tuneKnob.addEventListener('dblclick', (e) => {
        e.preventDefault();
        resetTune();
    });

    updateTuneDisplay();
}

// Shift the tuned frequency by `steps` detents
function stepTune(steps) {
    if (!steps) return;
    const delta = steps * TUNE_STEP_HZ;

    if (isChannelRadio()) {
        tuneOffset = Math.max(-TUNE_OFFSET_LIMIT, Math.min(TUNE_OFFSET_LIMIT, tuneOffset + delta));
    } else {
        currentFrequency = Math.max(MIN_FREQ, Math.min(MAX_FREQ, currentFrequency + delta));
        throttledUpdateURL();
    }

    updateFrequencyDisplay();
    updateTuneDisplay();
    sendTuneCommand();
}

// Recentre the clarifier and spin the knob back to its zero position.
// `silent` skips the retune for callers (e.g. changeChannel) that tune anyway.
function resetTune(silent) {
    tuneRotation = 0;
    tuneNotch = 0;
    const tuneKnob = document.getElementById('tune-knob');
    if (tuneKnob) tuneKnob.style.transform = 'rotate(0deg)';

    const wasOffset = tuneOffset !== 0;
    tuneOffset = 0;
    updateTuneDisplay();

    if (wasOffset && !silent) {
        updateFrequencyDisplay();
        sendTuneCommand();
    }
}

// Label doubles as the clarifier readout so the offset is always visible
function updateTuneDisplay() {
    const label = document.getElementById('tune-label');
    if (!label) return;
    label.textContent = tuneOffset === 0
        ? 'TUNE'
        : `${tuneOffset > 0 ? '+' : '-'}${Math.abs(tuneOffset)} Hz`;
}

// SNR squelch constants — mirror the main interface values
const SQUELCH_SNR_MIN = 24;   // slider far-left = disabled (matches SNR_SQUELCH_OFF_VAL)
const SQUELCH_SNR_MAX = 80;   // slider far-right = 80 dB threshold
const SQUELCH_SENTINEL = -999; // sent to server when disabled

// Debounce timer for server-side gate command
let _squelchSendTimer = null;

// Send set_audio_gate to the server via MinimalRadio's WebSocket
function sendSquelchGate(minSnr) {
    if (_squelchSendTimer) clearTimeout(_squelchSendTimer);
    _squelchSendTimer = setTimeout(() => {
        if (minimalRadio && minimalRadio.ws && minimalRadio.ws.readyState === WebSocket.OPEN) {
            minimalRadio.ws.send(JSON.stringify({ type: 'set_audio_gate', min_snr: minSnr }));
        }
    }, 80);
}

// Update squelch from knob position — SNR-based gate
// Knob at 0° → squelch OFF (gate always open)
// Knob at 1°–330° → SNR threshold mapped linearly from SQUELCH_SNR_MIN+0.5 to SQUELCH_SNR_MAX dB
function updateSquelchFromKnob() {
    const maxRotation = 330;
    const clampedRotation = Math.min(squelchRotation, maxRotation);
    currentSquelch = clampedRotation / maxRotation;

    let snrThreshold;
    if (clampedRotation === 0) {
        // Knob fully counter-clockwise → squelch OFF
        snrThreshold = SQUELCH_SENTINEL;
    } else {
        // Map 1°–330° linearly to SQUELCH_SNR_MIN+0.5 … SQUELCH_SNR_MAX dB
        const fraction = clampedRotation / maxRotation; // 0.003 … 1.0
        snrThreshold = SQUELCH_SNR_MIN + 0.5 + fraction * (SQUELCH_SNR_MAX - SQUELCH_SNR_MIN - 0.5);
        snrThreshold = Math.round(snrThreshold * 2) / 2; // round to nearest 0.5 dB
    }
    currentSquelchSnr = snrThreshold;

    // Apply to MinimalRadio client-side gate
    if (minimalRadio) {
        minimalRadio.setSNRSquelch(snrThreshold);
    }

    // Also send server-side audio gate command
    sendSquelchGate(snrThreshold);
}

// Update frequency display
function updateFrequencyDisplay() {
    const freqElement = document.getElementById('frequency-value');
    if (!freqElement) return;

    // Check if this is a channel-based radio
    if (currentRadioConfig && currentRadioConfig.channels) {
        // Find the channel number for current frequency
        const channel = currentRadioConfig.channels.find(ch => ch.frequency === currentFrequency);
        if (channel) {
            // Update channel number display
            const channelElement = document.getElementById('channel-number');
            if (channelElement) {
                channelElement.textContent = String(channel.number).padStart(2, '0');
            }
            // Update frequency display in MHz, including any clarifier offset
            freqElement.textContent = (tunedFrequency() / 1000000).toFixed(5);

            // Update signal bars based on signal strength
            updateSignalBars();
        }
    } else {
        // Traditional frequency display in kHz
        const freqKHz = Math.round(currentFrequency / 1000);
        freqElement.textContent = freqKHz;
    }

    // Update needle position if it exists
    const needle = document.getElementById('frequency-needle');
    if (needle) {
        const normalized = (currentFrequency - MIN_FREQ) / (MAX_FREQ - MIN_FREQ);
        const needlePos = normalized * 100;
        needle.style.left = needlePos + '%';
    }
}

// Update signal bars for CB radio with sub-bar dimming and squelch colouring.
// Uses vuLevel (0-1) which is already updated by updateSignalLED() from live SNR data.
// vuLevel 0 = SNR ≤ 30 dB (no bars), vuLevel 1 = SNR ≥ 60 dB (all 8 bars).
// Bars below the squelch threshold are orange; bars at/above it are green.
// The leading (partial) bar dims proportionally within its range for an analog feel.
function updateSignalBars() {
    const NUM_BARS = 8;
    const SNR_MIN = 30;
    const SNR_MAX = 60;
    const activeBars = vuLevel * NUM_BARS; // e.g. 3.7 means bars 1-3 full, bar 4 at 70%

    // Convert squelch SNR threshold to bar position (same 30-60 dB scale)
    // squelchBarPos = 0 means no squelch, > NUM_BARS means all bars are below threshold
    const squelchActive = currentSquelchSnr > SQUELCH_SENTINEL;
    const squelchBarPos = squelchActive
        ? Math.max(0, (currentSquelchSnr - SNR_MIN) / (SNR_MAX - SNR_MIN) * NUM_BARS)
        : 0;

    for (let i = 1; i <= NUM_BARS; i++) {
        const bar = document.getElementById(`signal-bar-${i}`);
        if (!bar) continue;

        // Is this bar below the squelch threshold?
        const belowSquelch = squelchActive && i <= squelchBarPos;
        // Colours: orange for below-squelch, green for above
        const onColour  = belowSquelch ? [255, 107, 0] : [0, 255, 0];   // #ff6b00 or #00ff00
        const offColour = belowSquelch ? [34,  11, 0]  : [0,  34, 0];   // dim orange or dim green

        if (activeBars >= i) {
            // Fully lit
            const [r, g, b] = onColour;
            bar.style.background = `rgb(${r},${g},${b})`;
            bar.style.boxShadow = `0 0 5px rgb(${r},${g},${b})`;
        } else if (activeBars > i - 1) {
            // Partially lit — fraction of this bar that's filled
            const frac = activeBars - (i - 1); // 0..1
            const r = Math.round(offColour[0] + frac * (onColour[0] - offColour[0]));
            const g = Math.round(offColour[1] + frac * (onColour[1] - offColour[1]));
            const b = Math.round(offColour[2] + frac * (onColour[2] - offColour[2]));
            const glow = Math.round(frac * 5);
            bar.style.background = `rgb(${r},${g},${b})`;
            bar.style.boxShadow = frac > 0.1 ? `0 0 ${glow}px rgb(${r},${g},${b})` : 'none';
        } else {
            // Off
            const [r, g, b] = offColour;
            bar.style.background = `rgb(${r},${g},${b})`;
            bar.style.boxShadow = 'none';
        }
    }
}

// Update power indicator brightness
function updatePowerIndicator(level) {
    const indicator = document.getElementById('power-indicator');
    if (!indicator) return;

    const opacity = 0.1 + (level * 0.9);
    indicator.style.opacity = opacity;

    const shadowIntensity = 5 + (level * 15);
    indicator.style.boxShadow = `0 0 ${shadowIntensity}px #ff6b35`;
}

// Update Signal LED
function updateSignalLED() {
    if (!minimalRadio) {
        requestAnimationFrame(updateSignalLED);
        return;
    }

    // Use SNR from signal quality data if available
    if (minimalRadio.hasSignalQuality && minimalRadio.hasSignalQuality()) {
        const signalQuality = minimalRadio.getSignalQuality();
        if (signalQuality && signalQuality.snr !== null) {
            // Map SNR to 0-1 range using 30-60 dB window
            // 30 dB = 0%, 60 dB = 100%
            const snrPercentage = Math.max(0, Math.min(1, (signalQuality.snr - 30) / 30));

            // Smooth the value
            vuLevel = vuLevel * 0.8 + snrPercentage * 0.2;
            updatePowerIndicator(vuLevel);
            updateSignalBars();

            requestAnimationFrame(updateSignalLED);
            return;
        }
    }

    // Fallback to audio RMS if signal quality not available
    if (!vuAnalyser) {
        requestAnimationFrame(updateSignalLED);
        return;
    }

    const dataArray = new Uint8Array(vuAnalyser.frequencyBinCount);
    vuAnalyser.getByteTimeDomainData(dataArray);

    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / dataArray.length);
    const rmsDb = 20 * Math.log10(rms + 0.0001);
    const clampedRmsDb = Math.max(-60, Math.min(0, rmsDb));
    const rmsPercentage = ((clampedRmsDb + 60) / 60);

    vuLevel = vuLevel * 0.8 + rmsPercentage * 0.2;
    updatePowerIndicator(vuLevel);
    updateSignalBars();

    requestAnimationFrame(updateSignalLED);
}

// Setup Visualiser (spectrum / oscilloscope / grille cycling)
function setupOscilloscope() {
    const speakerGrille = document.getElementById('speaker-grille');
    visualiserCanvas = document.getElementById('visualiser-canvas');

    console.log('[setupOscilloscope] speakerGrille:', speakerGrille, 'canvas:', visualiserCanvas, 'audioCtx:', minimalRadio?.audioContext);

    if (!minimalRadio || !minimalRadio.audioContext) {
        console.log('Visualiser not available — no audio context');
        return;
    }

    // ── Fallback: legacy oscilloscope canvas (e.g. Grundig) ──────────────────
    // If this radio has no #visualiser-canvas but does have #oscilloscope-canvas,
    // wire up the old-style oscilloscope toggle on the speaker grille.
    if (!visualiserCanvas) {
        const legacyCanvas = document.getElementById('oscilloscope-canvas');
        const legacyOverlay = document.getElementById('oscilloscope-overlay');
        if (legacyCanvas && speakerGrille) {
            console.log('[setupOscilloscope] using legacy oscilloscope canvas');
            // Set up analyser for the legacy canvas
            const legacyAnalyser = minimalRadio.audioContext.createAnalyser();
            legacyAnalyser.fftSize = 2048;
            legacyAnalyser.smoothingTimeConstant = 0.8;
            minimalRadio.addAnalyser(legacyAnalyser);

            // Size the canvas
            const sizeLegacy = () => {
                legacyCanvas.width = legacyCanvas.offsetWidth || 300;
                legacyCanvas.height = legacyCanvas.offsetHeight || 120;
            };
            sizeLegacy();
            window.addEventListener('resize', sizeLegacy);

            const legacyCtx = legacyCanvas.getContext('2d');
            let legacyVisible = false;
            let legacyAnimFrame = null;

            const drawLegacy = () => {
                if (!legacyVisible) { legacyAnimFrame = null; return; }
                legacyAnimFrame = requestAnimationFrame(drawLegacy);
                const w = legacyCanvas.width, h = legacyCanvas.height;
                const buf = new Uint8Array(legacyAnalyser.frequencyBinCount);
                legacyAnalyser.getByteTimeDomainData(buf);
                legacyCtx.fillStyle = 'rgba(0,0,0,0.85)';
                legacyCtx.fillRect(0, 0, w, h);
                legacyCtx.lineWidth = 2;
                legacyCtx.strokeStyle = '#ff6b35';
                legacyCtx.shadowBlur = 8;
                legacyCtx.shadowColor = '#ff6b35';
                legacyCtx.beginPath();
                const slice = w / buf.length;
                let x = 0;
                for (let i = 0; i < buf.length; i++) {
                    const v = ((buf[i] - 128) / 128.0) * 1.5;
                    const y = h / 2 - Math.max(-1, Math.min(1, v)) * h / 2;
                    i === 0 ? legacyCtx.moveTo(x, y) : legacyCtx.lineTo(x, y);
                    x += slice;
                }
                legacyCtx.stroke();
                legacyCtx.shadowBlur = 0;
            };

            speakerGrille.addEventListener('click', () => {
                legacyVisible = !legacyVisible;
                if (legacyOverlay) legacyOverlay.style.opacity = legacyVisible ? '1' : '0';
                if (legacyVisible && !legacyAnimFrame) drawLegacy();
            });
        } else {
            console.log('[setupOscilloscope] no visualiser or oscilloscope canvas found — skipping');
        }
        return;
    }

    // ── Primary path: CB radio 3-mode visualiser (#visualiser-canvas) ────────
    visualiserCtx = visualiserCanvas.getContext('2d');

    const resizeCanvas = () => {
        if (!visualiserCanvas) return;
        const rect = visualiserCanvas.getBoundingClientRect();
        visualiserCanvas.width = rect.width || visualiserCanvas.offsetWidth || 200;
        visualiserCanvas.height = rect.height || visualiserCanvas.offsetHeight || 100;
    };
    resizeCanvas();
    visualiserResizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);

    visualiserAnalyser = minimalRadio.audioContext.createAnalyser();
    visualiserAnalyser.fftSize = 1024;
    visualiserAnalyser.smoothingTimeConstant = 0.75;
    minimalRadio.addAnalyser(visualiserAnalyser);

    // audioStartHandler is on the overlay button (#audio-start-button in index.html),
    // not on the speaker grille — no need to remove it here.

    // Default: spectrum mode (mode 0) — canvas visible, no grille class
    _applyVisualiserMode();
    drawVisualiser();

    if (speakerGrille) {
        console.log('[setupOscilloscope] attaching click handler to speaker-grille');
        speakerGrille.addEventListener('click', () => {
            console.log('[visualiser] click! mode was', visualiserMode);
            visualiserMode = (visualiserMode + 1) % 3;
            _applyVisualiserMode();
            if (visualiserMode !== 2) {
                // Cancel any stale frame and restart the draw loop
                if (visualiserAnimFrame) {
                    cancelAnimationFrame(visualiserAnimFrame);
                    visualiserAnimFrame = null;
                }
                drawVisualiser();
            }
        });
    } else {
        console.warn('[setupOscilloscope] speaker-grille element NOT FOUND in DOM');
    }
}

function _applyVisualiserMode() {
    const grille = document.getElementById('speaker-grille');
    if (!grille) return;
    if (visualiserMode === 2) {
        // Grille: show grille pattern, hide canvas
        grille.classList.add('show-grille');
    } else {
        // Spectrum or oscilloscope: show canvas
        grille.classList.remove('show-grille');
    }
}

// Unified draw loop — draws spectrum (mode 0) or oscilloscope (mode 1)
function drawVisualiser() {
    if (visualiserMode === 2 || !visualiserAnalyser || !visualiserCtx || !visualiserCanvas) {
        visualiserAnimFrame = null;
        return;
    }

    visualiserAnimFrame = requestAnimationFrame(drawVisualiser);

    const width = visualiserCanvas.width;
    const height = visualiserCanvas.height;

    if (visualiserMode === 0) {
        // ── Spectrum bars (green theme) ──────────────────────────────────
        const bufferLength = visualiserAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        visualiserAnalyser.getByteFrequencyData(dataArray);

        visualiserCtx.fillStyle = '#000';
        visualiserCtx.fillRect(0, 0, width, height);

        // Subtle grid lines
        visualiserCtx.strokeStyle = 'rgba(0, 255, 0, 0.06)';
        visualiserCtx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            const y = (height / 4) * i;
            visualiserCtx.beginPath();
            visualiserCtx.moveTo(0, y);
            visualiserCtx.lineTo(width, y);
            visualiserCtx.stroke();
        }

        // Only use the lower ~60% of bins (audio content)
        const usedBins = Math.floor(bufferLength * 0.6);
        const barCount = Math.min(usedBins, 48);
        const barW = width / barCount;
        const gap = Math.max(1, Math.floor(barW * 0.15));

        for (let i = 0; i < barCount; i++) {
            // Average a small bin range per bar
            const binStart = Math.floor((i / barCount) * usedBins);
            const binEnd = Math.floor(((i + 1) / barCount) * usedBins);
            let sum = 0;
            for (let b = binStart; b < binEnd; b++) sum += dataArray[b];
            const avg = sum / Math.max(1, binEnd - binStart);

            const fraction = avg / 255;
            const barH = fraction * height;
            const x = i * barW;

            // Colour: dim green → bright green → yellow-green at peaks
            const g = Math.round(180 + fraction * 75);
            const r = fraction > 0.75 ? Math.round((fraction - 0.75) * 4 * 200) : 0;
            visualiserCtx.fillStyle = `rgb(${r},${g},0)`;
            visualiserCtx.shadowBlur = fraction > 0.5 ? 6 : 0;
            visualiserCtx.shadowColor = '#00ff00';
            visualiserCtx.fillRect(x + gap / 2, height - barH, barW - gap, barH);
        }
        visualiserCtx.shadowBlur = 0;

    } else {
        // ── Oscilloscope (green theme, matches CB aesthetic) ─────────────
        const bufferLength = visualiserAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        visualiserAnalyser.getByteTimeDomainData(dataArray);

        visualiserCtx.fillStyle = '#000';
        visualiserCtx.fillRect(0, 0, width, height);

        // Grid lines
        visualiserCtx.strokeStyle = 'rgba(0, 255, 0, 0.08)';
        visualiserCtx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (height / 4) * i;
            visualiserCtx.beginPath();
            visualiserCtx.moveTo(0, y);
            visualiserCtx.lineTo(width, y);
            visualiserCtx.stroke();
        }
        for (let i = 0; i <= 10; i++) {
            const x = (width / 10) * i;
            visualiserCtx.beginPath();
            visualiserCtx.moveTo(x, 0);
            visualiserCtx.lineTo(x, height);
            visualiserCtx.stroke();
        }

        visualiserCtx.lineWidth = 2;
        visualiserCtx.strokeStyle = '#00ff00';
        visualiserCtx.shadowBlur = 8;
        visualiserCtx.shadowColor = '#00ff00';
        visualiserCtx.beginPath();

        // Use 128 as DC midpoint (standard for getByteTimeDomainData)
        // gain of 1.5 gives a natural waveform without clipping
        const sliceWidth = width / bufferLength;
        let x = 0;
        const gain = 1.5;

        for (let i = 0; i < bufferLength; i++) {
            const v = ((dataArray[i] - 128) / 128.0) * gain;
            const clampedV = Math.max(-1, Math.min(1, v));
            const y = height / 2 - (clampedV * height / 2);
            if (i === 0) visualiserCtx.moveTo(x, y);
            else visualiserCtx.lineTo(x, y);
            x += sliceWidth;
        }
        visualiserCtx.lineTo(width, height / 2);
        visualiserCtx.stroke();
        visualiserCtx.shadowBlur = 0;
    }
}

// Stub kept for compatibility — actual draw is now drawVisualiser()
function drawOscilloscope() {}

// Load settings from URL
function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);

    // Apply band before freq so MIN/MAX limits are correct for clamping
    if (params.has('band') && currentRadioConfig && currentRadioConfig.bands) {
        const band = params.get('band');
        if (currentRadioConfig.bands[band] && band !== currentBand) {
            applyBandConfig(band);
            saveBand(currentRadioConfig.id, band);
            currentFrequency = currentRadioConfig.defaultFrequency;
            console.log('Loaded band from URL:', band);
        }
    }

    // Mode comes after band so it overrides the band's default
    if (params.has('mode')) {
        const mode = params.get('mode').toLowerCase();
        if (MODE_CYCLE.includes(mode)) {
            MODE = mode;
            if (currentRadioConfig) {
                currentRadioConfig.mode = mode;
            }
            updateModeDisplay();
            console.log('Loaded mode from URL:', mode);
        }
    }

    if (params.has('freq')) {
        let freq = parseInt(params.get('freq'));
        if (!isNaN(freq)) {
            freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq));
            currentFrequency = freq;
            const normalized = (freq - MIN_FREQ) / (MAX_FREQ - MIN_FREQ);
            dialRotation = (normalized * 360) * DIAL_GEAR_RATIO;

            const tuningDial = document.getElementById('tuning-dial');
            if (tuningDial) {
                tuningDial.style.transform = `rotate(${dialRotation}deg)`;
            }

            updateFrequencyDisplay();
            console.log('Loaded frequency from URL:', freq, 'Hz');
        }
    } else {
        // No URL parameter, use default from config and update dial position
        const normalized = (currentFrequency - MIN_FREQ) / (MAX_FREQ - MIN_FREQ);
        dialRotation = (normalized * 360) * DIAL_GEAR_RATIO;

        const tuningDial = document.getElementById('tuning-dial');
        if (tuningDial) {
            tuningDial.style.transform = `rotate(${dialRotation}deg)`;
        }

        updateFrequencyDisplay();
    }

    if (params.has('vol')) {
        const vol = parseFloat(params.get('vol'));
        if (!isNaN(vol) && vol >= 0 && vol <= 1) {
            currentVolume = vol;
            volumeRotation = vol * 330;

            const volumeKnob = document.getElementById('volume-knob');
            if (volumeKnob) {
                volumeKnob.style.transform = `rotate(${volumeRotation}deg)`;
            }

            console.log('[loadSettingsFromURL] vol param:', vol, '→ currentVolume:', currentVolume, 'volumeRotation:', volumeRotation);
        }
    } else {
        // No URL parameter, use default from config and update knob position
        volumeRotation = currentVolume * 330;
        console.log('[loadSettingsFromURL] no vol param, using currentVolume:', currentVolume, 'volumeRotation:', volumeRotation);

        const volumeKnob = document.getElementById('volume-knob');
        if (volumeKnob) {
            volumeKnob.style.transform = `rotate(${volumeRotation}deg)`;
        }
    }
}

// Throttled URL update
function throttledUpdateURL() {
    const now = Date.now();

    if (urlUpdateTimeout) {
        clearTimeout(urlUpdateTimeout);
    }

    if (now - lastUrlUpdateTime >= URL_UPDATE_THROTTLE_MS) {
        updateURL();
        lastUrlUpdateTime = now;
    } else {
        urlUpdateTimeout = setTimeout(() => {
            updateURL();
            lastUrlUpdateTime = Date.now();
        }, URL_UPDATE_THROTTLE_MS - (now - lastUrlUpdateTime));
    }
}

// Update URL with current settings
function updateURL() {
    try {
        const params = new URLSearchParams(window.location.search);
        params.set('freq', currentFrequency);
        params.set('vol', currentVolume.toFixed(2));
        if (currentBand && currentRadioConfig && currentRadioConfig.bands) {
            params.set('band', currentBand);
        }
        if (MODE) {
            params.set('mode', MODE);
        }

        const newURL = window.location.pathname + '?' + params.toString();
        window.history.replaceState({}, '', newURL);
    } catch (e) {
        console.debug('URL update skipped:', e.message);
    }
}

// Initialize frequency display (only if element exists)
if (document.getElementById('frequency-value')) {
    updateFrequencyDisplay();
}