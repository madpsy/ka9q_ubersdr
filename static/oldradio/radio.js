
// Old Radio JavaScript - Pluggable Radio System
// Supports multiple radio models with different configurations

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
let ws = null;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let nextPlayTime = 0;
let audioStartTime = 0;
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
let serverSampleRate = null;
let isChangingRadio = false;
let shouldReconnect = true;
let audioBufferCount = 0;

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
                shouldReconnect = false;
                
                // Close websocket immediately
                if (ws) {
                    // Remove all event handlers to prevent any more messages
                    const oldWs = ws;
                    ws = null; // Null it out immediately so no more messages are processed
                    
                    oldWs.onmessage = null;
                    oldWs.onerror = null;
                    oldWs.onclose = null;
                    oldWs.onopen = null;
                    
                    // Close the connection
                    if (oldWs.readyState !== WebSocket.CLOSED && oldWs.readyState !== WebSocket.CLOSING) {
                        oldWs.close();
                    }
                }
                
                // Close audio context
                if (audioContext) {
                    await audioContext.close();
                    audioContext = null;
                }
                
                // Wait a bit for server to clean up the old session
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Generate new session ID for the new radio
                userSessionID = generateUserSessionID();
                console.log('New User Session ID:', userSessionID);
                
                // Reset state (but don't reset audioStartButtonSetup - we'll clean it up properly)
                serverSampleRate = null;
                audioBufferCount = 0;
                
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
            // Don't initialize audio context yet - wait for first audio packet with sample rate
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

// Initialize Audio Context with specific sample rate
async function initializeAudio(sampleRate) {
    // If sample rate is provided, use it; otherwise use default
    if (sampleRate) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate });
    } else {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    
    // Start with a larger buffer to allow for fade-in
    nextPlayTime = audioContext.currentTime + 0.2;
    audioStartTime = audioContext.currentTime;
    
    vuAnalyser = audioContext.createAnalyser();
    vuAnalyser.fftSize = 2048;
    vuAnalyser.smoothingTimeConstant = 0;
    
    updateSignalLED();
    
    console.log('Audio context initialized:', audioContext.sampleRate, 'Hz');
}

// Start Radio
function startRadio() {
    setupDials();
    setupChannelButtons();
    setupSquelchKnob();
    // Don't setup oscilloscope yet - wait until audio context is initialized
    connectWebSocket();
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

// Send tune command to server
function sendTuneCommand() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const message = {
            type: 'tune',
            frequency: currentFrequency,
            mode: MODE,
            bandwidthLow: -5000,
            bandwidthHigh: 5000
        };
        
        // Always add squelch parameters for FM mode
        // Map squelch knob position (0-1) to dB SNR values
        // Position 0 (off): -999 dB (special value to force squelch always open)
        // Position 1 (max): 20 dB (strong signals only)
        // Use 2 dB hysteresis for stability
        let squelchOpen, squelchClose;
        if (currentSquelch === 0) {
            // Special case: knob fully off = force squelch open
            squelchOpen = -999;
            squelchClose = -999;
        } else {
            // Map 0.01-1.0 range to 1-20 dB (avoid 0 dB which is too sensitive)
            squelchOpen = 1 + (currentSquelch * 19); // 1 to 20 dB SNR range
            squelchClose = Math.max(1, squelchOpen - 2); // Clamp to 1 dB minimum
        }
        
        message.squelchOpen = squelchOpen;
        message.squelchClose = squelchClose;
        
        ws.send(JSON.stringify(message));
    }
}

// Update volume from knob position
function updateVolumeFromKnob() {
    const maxRotation = 330;
    const clampedRotation = Math.min(volumeRotation, maxRotation);
    currentVolume = clampedRotation / maxRotation;
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
    
    // Debounce squelch updates like frequency tuning
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

// Show error overlay
function showErrorOverlay(message, isTerminated = false) {
    let overlay = document.getElementById('error-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'error-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:99999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:20px';
        document.body.appendChild(overlay);
    }

    const icon = isTerminated ? '❌' : '🚫';
    const title = isTerminated ? 'Session Terminated' : 'Connection Not Allowed';

    overlay.innerHTML = `
        <div style="max-width:600px">
            <div style="font-size:80px;margin-bottom:20px">${icon}</div>
            <h1 style="font-size:32px;margin-bottom:20px;color:#dc3545">${title}</h1>
            <p style="font-size:20px;margin-bottom:30px;line-height:1.5">${message}</p>
            <button onclick="location.reload()" style="background:#007bff;color:white;border:none;padding:15px 40px;font-size:18px;border-radius:5px;cursor:pointer;font-weight:bold">Refresh Page</button>
        </div>
    `;

    overlay.style.display = 'flex';
}

// WebSocket Connection
async function connectWebSocket() {
    // Don't connect if we're changing radios
    if (isChangingRadio) {
        console.log('Skipping connection - changing radios');
        return;
    }
    
    // Don't connect if there's already an active connection
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        console.log('Skipping connection - WebSocket already active', ws.readyState);
        return;
    }
    
    try {
        const httpProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const connectionUrl = `${httpProtocol}//${window.location.host}/connection`;

        console.log('Checking connection permission:', connectionUrl);

        const response = await fetch(connectionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_session_id: userSessionID
            })
        });

        if (!response.ok) {
            let errorData;
            try {
                errorData = await response.json();
            } catch (e) {
                errorData = { reason: 'Server rejected connection' };
            }

            console.error('Connection not allowed:', response.status, errorData);

            if (response.status === 410) {
                showErrorOverlay(errorData.reason || 'Your session has been terminated', true);
            } else {
                showErrorOverlay(errorData.reason || 'Server rejected connection', false);
            }

            updatePowerIndicator(0);
            return;
        }

        const result = await response.json();
        console.log('Connection check result:', result);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${currentFrequency}&mode=${MODE}&user_session_id=${encodeURIComponent(userSessionID)}`;

        console.log('Connecting to WebSocket:', wsUrl);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected');
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        ws.onclose = () => {
            console.log('WebSocket closed');
            updatePowerIndicator(0);

            // Only reconnect if we should (not when changing radios)
            if (shouldReconnect) {
                setTimeout(() => {
                    if (audioContext) {
                        connectWebSocket();
                    }
                }, 3000);
            }
        };

    } catch (error) {
        console.error('Failed to check connection permission:', error);
        showErrorOverlay(`Failed to connect: ${error.message}`, false);
        updatePowerIndicator(0);
    }
}

// Send periodic keepalive
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 30000);

// Handle WebSocket Messages
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'audio':
            handleAudioData(message);
            break;
        case 'status':
            break;
        case 'error':
            console.error('Server error:', message.error);
            // If we get a session conflict error, close the websocket and don't reconnect
            if (message.error && message.error.includes('active audio session')) {
                console.log('Session conflict detected, closing connection');
                if (ws) {
                    ws.close();
                    ws = null;
                }
                // Stop audio context to prevent reconnection
                if (audioContext) {
                    audioContext.close();
                    audioContext = null;
                }
                showErrorOverlay('Another session is already active. Please close other tabs/windows and refresh this page.', false);
            }
            break;
        case 'pong':
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// Handle Audio Data
async function handleAudioData(message) {
    if (!message.data) return;
    
    // Don't process audio if we're changing radios or if there's no audio context
    if (isChangingRadio || (!audioContext && !message.sampleRate)) return;
    
    // If we haven't initialized audio context yet and we have a sample rate, initialize it now
    if (!audioContext && message.sampleRate) {
        serverSampleRate = message.sampleRate;
        audioBufferCount = 0;  // Set BEFORE initializing audio
        console.log('Initializing audio context with server sample rate:', serverSampleRate, 'Hz');
        await initializeAudio(serverSampleRate);
        setupOscilloscope();
        // Don't process this first packet - let it be dropped so the next one starts cleanly
        return;
    }
    
    if (!audioContext) return;
    
    try {
        const binaryString = atob(message.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        const numSamples = bytes.length / 2;
        const floatData = new Float32Array(numSamples);
        
        for (let i = 0; i < numSamples; i++) {
            const highByte = bytes[i * 2];
            const lowByte = bytes[i * 2 + 1];
            let sample = (highByte << 8) | lowByte;
            if (sample >= 0x8000) {
                sample -= 0x10000;
            }
            floatData[i] = sample / 32767.0;
        }
        
        const audioBuffer = audioContext.createBuffer(1, floatData.length, message.sampleRate || serverSampleRate || 12000);
        audioBuffer.getChannelData(0).set(floatData);
        
        playAudioBuffer(audioBuffer);
        
    } catch (error) {
        console.error('Failed to process audio data:', error);
    }
}

// Play audio buffer
function playAudioBuffer(buffer) {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    
    const gainNode = audioContext.createGain();
    
    // Connect to analysers if they exist
    if (vuAnalyser) {
        source.connect(vuAnalyser);
    }
    if (oscilloscopeAnalyser && oscilloscopeActive) {
        source.connect(oscilloscopeAnalyser);
    }
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    const currentTime = audioContext.currentTime;
    const bufferAhead = nextPlayTime - currentTime;
    
    // Don't reset on the first few buffers - they're expected to have low buffer
    const needsReset = audioBufferCount >= 3 && (nextPlayTime < currentTime || bufferAhead < 0.05);
    
    // Handle first buffer fade-in FIRST, before any other gain settings
    if (audioBufferCount === 0) {
        const FADE_TIME = 0.5;
        // Use max of nextPlayTime and currentTime to ensure we're not setting gain in the past
        const fadeStartTime = Math.max(nextPlayTime, currentTime);
        gainNode.gain.setValueAtTime(0, fadeStartTime);
        gainNode.gain.linearRampToValueAtTime(currentVolume, fadeStartTime + FADE_TIME);
    } else if (needsReset) {
        const FADE_TIME = 0.01;
        
        gainNode.gain.setValueAtTime(currentVolume, currentTime);
        gainNode.gain.linearRampToValueAtTime(0, currentTime + FADE_TIME);
        
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime + FADE_TIME + 0.05;
            console.log('Audio scheduler reset - was falling behind');
        } else {
            nextPlayTime = currentTime + FADE_TIME + 0.05;
            console.log(`Audio buffer critically low (${bufferAhead.toFixed(3)}s), resetting`);
        }
        
        gainNode.gain.setValueAtTime(0, nextPlayTime);
        gainNode.gain.linearRampToValueAtTime(currentVolume, nextPlayTime + FADE_TIME);
    } else {
        // Normal playback - just set the gain
        gainNode.gain.value = currentVolume;
    }
    
    audioBufferCount++;
    
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
    
    const timeSinceStart = currentTime - audioStartTime;
    if (Math.floor(timeSinceStart) % 10 === 0 && Math.floor(timeSinceStart) !== Math.floor(timeSinceStart - buffer.duration)) {
        const bufferAhead = nextPlayTime - currentTime;
        console.log(`Audio timing: ${bufferAhead.toFixed(3)}s buffered`);
    }
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
    oscilloscopeCtx = oscilloscopeCanvas.getContext('2d');
    
    const resizeCanvas = () => {
        const rect = oscilloscopeCanvas.getBoundingClientRect();
        oscilloscopeCanvas.width = rect.width;
        oscilloscopeCanvas.height = rect.height;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    oscilloscopeAnalyser = audioContext.createAnalyser();
    oscilloscopeAnalyser.fftSize = 2048;
    oscilloscopeAnalyser.smoothingTimeConstant = 0.3;
    
    oscilloscopeOverlay.classList.add('active');
    drawOscilloscope();
    
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