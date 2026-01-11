
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
let currentVolume = 0.7;
let currentSquelch = 0; // Squelch level 0-1 (0 = off, 1 = max)
let dialRotation = 0;
let volumeRotation = 231;
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

// Oscilloscope
let oscilloscopeActive = true;
let oscilloscopeCanvas = null;
let oscilloscopeCtx = null;
let oscilloscopeAnalyser = null;

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
        const response = await fetch('radios/radios.json');
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

        // Load radio configuration
        const configResponse = await fetch(`${radio.path}/config.json`);
        currentRadioConfig = await configResponse.json();

        // Update global configuration
        MIN_FREQ = currentRadioConfig.minFreq;
        MAX_FREQ = currentRadioConfig.maxFreq;
        MODE = currentRadioConfig.mode;
        DIAL_GEAR_RATIO = currentRadioConfig.dialGearRatio;
        currentFrequency = currentRadioConfig.defaultFrequency;
        currentVolume = currentRadioConfig.defaultVolume;
        volumeRotation = currentVolume * 330;

        // Load radio template
        const templateResponse = await fetch(`${radio.path}/template.html`);
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
            styleLink.href = `${radio.path}/style.css`;
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
    setupSquelchKnob();

    // Initialize MinimalRadio with our session ID
    minimalRadio = new MinimalRadio(userSessionID);
    minimalRadio.setVolume(currentVolume);

    // Start audio preview
    try {
        await minimalRadio.startPreview(currentFrequency, MODE);
        console.log('Radio started successfully');

        // Setup VU meter and oscilloscope after audio context is initialized
        setupVUMeter();
        setupOscilloscope();
    } catch (error) {
        console.error('Failed to start radio:', error);
        alert('Failed to start radio: ' + error.message);
    }
}

// Setup VU Meter
function setupVUMeter() {
    if (!minimalRadio || !minimalRadio.audioContext) {
        console.log('Audio context not ready for VU meter');
        return;
    }

    vuAnalyser = minimalRadio.audioContext.createAnalyser();
    vuAnalyser.fftSize = 2048;
    vuAnalyser.smoothingTimeConstant = 0;

    // Connect analyser to MinimalRadio's audio stream
    minimalRadio.addAnalyser(vuAnalyser);

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
        changeChannel(1);
    });

    channelDownBtn.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('Channel DOWN clicked');
        changeChannel(-1);
    });
}

// Change channel for CB radio
function changeChannel(direction) {
    if (!currentRadioConfig || !currentRadioConfig.channels) {
        console.log('No channels available');
        return;
    }

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

    console.log('Current channel:', currentChannel.number, 'Direction:', direction);

    // Calculate new channel number
    let newChannelNum = currentChannel.number + direction;

    // Wrap around
    if (newChannelNum > currentRadioConfig.channels.length) {
        newChannelNum = 1;
    } else if (newChannelNum < 1) {
        newChannelNum = currentRadioConfig.channels.length;
    }

    console.log('New channel number:', newChannelNum);

    // Find new channel
    const newChannel = currentRadioConfig.channels.find(ch => ch.number === newChannelNum);
    if (newChannel) {
        console.log('Changing to channel', newChannel.number, 'frequency', newChannel.frequency);
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
        minimalRadio.changeFrequency(currentFrequency, MODE);
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
    console.log('Volume:', Math.round(currentVolume * 100) + '%');
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

// Update squelch from knob position
function updateSquelchFromKnob() {
    const maxRotation = 330;
    const clampedRotation = Math.min(squelchRotation, maxRotation);
    currentSquelch = clampedRotation / maxRotation;

    const squelchDb = -20 + (currentSquelch * 40);
    if (currentSquelch === 0) {
        console.log('Squelch: OFF (always open at', squelchDb.toFixed(1), 'dB)');
    } else {
        console.log('Squelch:', squelchDb.toFixed(1), 'dB');
    }

    // Note: MinimalRadio doesn't currently support squelch control
    // This would need to be added to MinimalRadio if squelch is needed
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
            // Update frequency display in MHz
            freqElement.textContent = (currentFrequency / 1000000).toFixed(5);

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

// Update signal bars for CB radio
function updateSignalBars() {
    for (let i = 1; i <= 5; i++) {
        const bar = document.getElementById(`signal-bar-${i}`);
        if (bar) {
            if (vuLevel * 5 >= i) {
                bar.classList.add('active');
            } else {
                bar.classList.remove('active');
            }
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

    requestAnimationFrame(updateSignalLED);
}

// Setup Oscilloscope
function setupOscilloscope() {
    const speakerGrille = document.getElementById('speaker-grille');
    const oscilloscopeOverlay = document.getElementById('oscilloscope-overlay');
    oscilloscopeCanvas = document.getElementById('oscilloscope-canvas');

    if (!oscilloscopeCanvas || !minimalRadio || !minimalRadio.audioContext) {
        console.log('Oscilloscope not available');
        return;
    }

    oscilloscopeCtx = oscilloscopeCanvas.getContext('2d');

    const resizeCanvas = () => {
        const rect = oscilloscopeCanvas.getBoundingClientRect();
        oscilloscopeCanvas.width = rect.width;
        oscilloscopeCanvas.height = rect.height;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    oscilloscopeAnalyser = minimalRadio.audioContext.createAnalyser();
    oscilloscopeAnalyser.fftSize = 2048;
    oscilloscopeAnalyser.smoothingTimeConstant = 0.3;

    // Connect analyser to MinimalRadio's audio stream
    minimalRadio.addAnalyser(oscilloscopeAnalyser);

    oscilloscopeOverlay.classList.add('active');
    drawOscilloscope();

    if (speakerGrille) {
        speakerGrille.addEventListener('click', () => {
            oscilloscopeActive = !oscilloscopeActive;
            if (oscilloscopeActive) {
                oscilloscopeOverlay.classList.add('active');
                drawOscilloscope();
            } else {
                oscilloscopeOverlay.classList.remove('active');
            }
        });
    }
}

// Draw Oscilloscope
function drawOscilloscope() {
    if (!oscilloscopeActive || !oscilloscopeAnalyser) return;

    requestAnimationFrame(drawOscilloscope);

    const bufferLength = oscilloscopeAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    oscilloscopeAnalyser.getByteTimeDomainData(dataArray);

    const width = oscilloscopeCanvas.width;
    const height = oscilloscopeCanvas.height;

    oscilloscopeCtx.fillStyle = '#0a0805';
    oscilloscopeCtx.fillRect(0, 0, width, height);

    oscilloscopeCtx.strokeStyle = 'rgba(212, 165, 116, 0.15)';
    oscilloscopeCtx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(0, y);
        oscilloscopeCtx.lineTo(width, y);
        oscilloscopeCtx.stroke();
    }

    for (let i = 0; i <= 10; i++) {
        const x = (width / 10) * i;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(x, 0);
        oscilloscopeCtx.lineTo(x, height);
        oscilloscopeCtx.stroke();
    }

    oscilloscopeCtx.lineWidth = 2;
    oscilloscopeCtx.strokeStyle = '#ff6b35';
    oscilloscopeCtx.shadowBlur = 10;
    oscilloscopeCtx.shadowColor = '#ff6b35';

    oscilloscopeCtx.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;

    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
    }
    const dcOffset = sum / bufferLength;

    const gain = 5.0;

    for (let i = 0; i < bufferLength; i++) {
        const v = ((dataArray[i] - dcOffset) / 128.0) * gain;
        const clampedV = Math.max(-1, Math.min(1, v));
        const y = height / 2 - (clampedV * height / 2);

        if (i === 0) {
            oscilloscopeCtx.moveTo(x, y);
        } else {
            oscilloscopeCtx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    oscilloscopeCtx.lineTo(width, height / 2);
    oscilloscopeCtx.stroke();
    oscilloscopeCtx.shadowBlur = 0;
}

// Load settings from URL
function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);

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

            console.log('Loaded volume from URL:', Math.round(vol * 100) + '%');
        }
    } else {
        // No URL parameter, use default from config and update knob position
        volumeRotation = currentVolume * 330;

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