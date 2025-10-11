// Old Radio JavaScript - Simple AM Receiver
// Frequency range: 600 kHz to 2000 kHz (AM broadcast band)

// Generate a unique user session ID for linking connections
function generateUserSessionID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Generate UUID once when page loads
const userSessionID = generateUserSessionID();
console.log('User Session ID:', userSessionID);

// Configuration
const MIN_FREQ = 600000;  // 600 kHz in Hz
const MAX_FREQ = 2000000; // 2000 kHz in Hz
const MODE = 'am';        // Fixed to AM mode
const DIAL_GEAR_RATIO = 10; // Number of full rotations to cover full frequency range

// State
let ws = null;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let nextPlayTime = 0; // Audio playback scheduling
let audioStartTime = 0; // Track when audio started for logging
let currentFrequency = 1000000; // Start at 1000 kHz
let currentVolume = 0.7;
let dialRotation = 0;
let volumeRotation = 231; // Start at ~70% volume (0.7 * 330 = 231 degrees)
let tuneTimeout = null; // For debouncing tune commands
let lastTuneTime = 0; // Track last tune command time
const TUNE_DEBOUNCE_MS = 200; // Maximum tune update rate
let urlUpdateTimeout = null; // For throttling URL updates
let lastUrlUpdateTime = 0; // Track last URL update time
const URL_UPDATE_THROTTLE_MS = 1000; // Only update URL once per second

// Signal LED
let vuLevel = 0;
let vuAnalyser = null; // Analyser for signal strength

// Oscilloscope
let oscilloscopeActive = true; // Start with oscilloscope visible
let oscilloscopeCanvas = null;
let oscilloscopeCtx = null;
let oscilloscopeAnalyser = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadSettingsFromURL();
    setupAudioStartButton();
    
    // Debug: Log screen and radio dimensions
    console.log('=== SCREEN DEBUG ===');
    console.log('Window width:', window.innerWidth);
    console.log('Window height:', window.innerHeight);
    console.log('Screen width:', screen.width);
    console.log('Device pixel ratio:', window.devicePixelRatio);
    
    const radioBody = document.querySelector('.radio-body');
    if (radioBody) {
        const rect = radioBody.getBoundingClientRect();
        const computed = window.getComputedStyle(radioBody);
        console.log('Radio body width:', rect.width);
        console.log('Radio body computed width:', computed.width);
        console.log('Radio body computed max-width:', computed.maxWidth);
        console.log('Radio body padding:', computed.padding);
    }
    console.log('==================');
});

// Audio Start Button
function setupAudioStartButton() {
    const overlay = document.getElementById('audio-start-overlay');
    const button = document.getElementById('audio-start-button');
    
    button.addEventListener('click', async () => {
        try {
            await initializeAudio();
            overlay.style.display = 'none';
            startRadio();
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            alert('Failed to start audio. Please check your browser permissions.');
        }
    });
}

// Initialize Audio Context
async function initializeAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Resume audio context if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    
    // Initialize playback timing to prevent audio glitches on startup
    nextPlayTime = audioContext.currentTime;
    audioStartTime = audioContext.currentTime;
    
    // Create analyser for signal strength LED (NOT connected to destination)
    // This will tap the signal before volume is applied
    vuAnalyser = audioContext.createAnalyser();
    vuAnalyser.fftSize = 2048;
    vuAnalyser.smoothingTimeConstant = 0; // No smoothing - instant response
    
    // Start signal LED update loop
    updateSignalLED();
    
    console.log('Audio context initialized:', audioContext.sampleRate, 'Hz');
}

// Start Radio
function startRadio() {
    setupDials();
    setupOscilloscope();
    connectWebSocket();
}

// Setup Dial Controls
function setupDials() {
    const tuningDial = document.getElementById('tuning-dial');
    const volumeKnob = document.getElementById('volume-knob');
    const frequencyScale = document.querySelector('.frequency-scale');
    
    // Click on frequency scale to tune
    frequencyScale.addEventListener('click', (e) => {
        const rect = frequencyScale.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const normalized = clickX / rect.width;
        
        // Clamp to 0-1 range
        const clampedNormalized = Math.max(0, Math.min(1, normalized));
        
        // Calculate frequency from click position
        const freqHz = MIN_FREQ + clampedNormalized * (MAX_FREQ - MIN_FREQ);
        currentFrequency = Math.round(freqHz);
        
        // Update dial rotation to match frequency
        dialRotation = (clampedNormalized * 360) * DIAL_GEAR_RATIO;
        tuningDial.style.transform = `rotate(${dialRotation}deg)`;
        
        // Update display and send tune command
        updateFrequencyDisplay();
        throttledUpdateURL();
        sendTuneCommand();
    });
    
    // Tuning dial
    let isDraggingTuning = false;
    let lastAngleTuning = 0;
    
    // Mouse events for tuning dial
    tuningDial.addEventListener('mousedown', (e) => {
        isDraggingTuning = true;
        lastAngleTuning = getAngle(tuningDial, e);
        e.preventDefault();
    });
    
    // Touch events for tuning dial
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
            
            // Handle wrap-around at 180/-180 boundary
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            
            lastAngleTuning = angle;
            
            // Allow unlimited rotation
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
            
            // Handle wrap-around at 180/-180 boundary
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            
            lastAngleTuning = angle;
            
            // Allow unlimited rotation
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
    let isDraggingVolume = false;
    let lastAngleVolume = 0;
    
    // Mouse events for volume knob
    volumeKnob.addEventListener('mousedown', (e) => {
        isDraggingVolume = true;
        lastAngleVolume = getAngle(volumeKnob, e);
        e.preventDefault();
    });
    
    // Touch events for volume knob
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
            
            // Handle wrap-around at 180/-180 boundary
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            
            lastAngleVolume = angle;
            
            volumeRotation += delta;
            // Clamp to 0-330 degrees (0 to notch 11)
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
            
            // Handle wrap-around at 180/-180 boundary
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            
            lastAngleVolume = angle;
            
            volumeRotation += delta;
            // Clamp to 0-330 degrees (0 to notch 11)
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

// Get angle from center of element (works with both mouse and touch events)
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
    // Apply gear ratio: divide rotation by gear ratio for slower tuning
    const gearAdjustedRotation = dialRotation / DIAL_GEAR_RATIO;
    
    // Normalize rotation to 0-360 range for frequency mapping
    const normalizedRotation = ((gearAdjustedRotation % 360) + 360) % 360;
    
    // Map rotation (0-360) to frequency range (600-2000 kHz)
    const normalized = normalizedRotation / 360; // 0 to 1
    const freqKHz = MIN_FREQ / 1000 + normalized * ((MAX_FREQ - MIN_FREQ) / 1000);
    let freqHz = Math.round(freqKHz * 1000);
    
    // Wrap frequency at boundaries
    if (freqHz > MAX_FREQ) freqHz = MIN_FREQ + (freqHz - MAX_FREQ);
    if (freqHz < MIN_FREQ) freqHz = MAX_FREQ - (MIN_FREQ - freqHz);
    
    currentFrequency = freqHz;
    updateFrequencyDisplay();
    throttledUpdateURL();
    
    // Debounce tune commands - only send at most every 200ms
    const now = Date.now();
    if (now - lastTuneTime >= TUNE_DEBOUNCE_MS) {
        sendTuneCommand();
        lastTuneTime = now;
    } else {
        // Clear any pending tune command
        if (tuneTimeout) {
            clearTimeout(tuneTimeout);
        }
        // Schedule a tune command for later
        tuneTimeout = setTimeout(() => {
            sendTuneCommand();
            lastTuneTime = Date.now();
        }, TUNE_DEBOUNCE_MS - (now - lastTuneTime));
    }
}

// Send tune command to server
function sendTuneCommand() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tune',
            frequency: currentFrequency,
            mode: MODE,
            bandwidthLow: -5000,  // AM mode: -5000 to +5000 Hz
            bandwidthHigh: 5000
        }));
    }
}

// Update volume from knob position
function updateVolumeFromKnob() {
    // Map knob rotation (0 to 330) to volume (0 to 1)
    // 0° = 0%, 330° = 100% (notch 11)
    const maxRotation = 330;
    const clampedRotation = Math.min(volumeRotation, maxRotation);
    currentVolume = clampedRotation / maxRotation;
    throttledUpdateURL();
    console.log('Volume:', Math.round(currentVolume * 100) + '%');
}

// Update frequency display
function updateFrequencyDisplay() {
    const freqKHz = Math.round(currentFrequency / 1000);
    document.getElementById('frequency-value').textContent = freqKHz;
    
    // Update needle position
    const normalized = (currentFrequency - MIN_FREQ) / (MAX_FREQ - MIN_FREQ);
    const needlePos = normalized * 100;
    document.getElementById('frequency-needle').style.left = needlePos + '%';
}

// Update power indicator brightness based on signal level
function updatePowerIndicator(level) {
    const indicator = document.getElementById('power-indicator');
    // level is 0-1, map to opacity 0.1-1.0
    const opacity = 0.1 + (level * 0.9);
    indicator.style.opacity = opacity;
    
    // Also adjust box-shadow intensity
    const shadowIntensity = 5 + (level * 15); // 5px to 20px
    indicator.style.boxShadow = `0 0 ${shadowIntensity}px #ff6b35`;
}

// WebSocket Connection
function connectWebSocket() {
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
        
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
            if (audioContext) {
                connectWebSocket();
            }
        }, 3000);
    };
}

// Send periodic keepalive to prevent connection timeout
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 30000); // Every 30 seconds

// Handle WebSocket Messages
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'audio':
            handleAudioData(message);
            break;
        case 'status':
            // Status updates - silently ignore
            break;
        case 'error':
            console.error('Server error:', message.error);
            break;
        case 'pong':
            // Keepalive response - silently ignore
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// Handle Audio Data
function handleAudioData(message) {
    if (!audioContext || !message.data) return;
    
    try {
        // Decode base64 audio data
        const binaryString = atob(message.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // RTP audio from radiod is big-endian signed 16-bit PCM
        const numSamples = bytes.length / 2;
        const floatData = new Float32Array(numSamples);
        
        // Parse big-endian int16 and convert to float
        for (let i = 0; i < numSamples; i++) {
            const highByte = bytes[i * 2];
            const lowByte = bytes[i * 2 + 1];
            let sample = (highByte << 8) | lowByte;
            if (sample >= 0x8000) {
                sample -= 0x10000;
            }
            // Use 32767 (INT16_MAX) not 32768
            floatData[i] = sample / 32767.0;
        }
        
        // Create audio buffer BEFORE applying volume
        const audioBuffer = audioContext.createBuffer(1, floatData.length, message.sampleRate || 12000);
        audioBuffer.getChannelData(0).set(floatData);
        
        // Play audio buffer with proper timing (volume applied in playback)
        playAudioBuffer(audioBuffer);
        
    } catch (error) {
        console.error('Failed to process audio data:', error);
    }
}

// Play audio buffer with proper timing
function playAudioBuffer(buffer) {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    
    // Create gain node for volume control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = currentVolume;
    
    // Connect: source -> vuAnalyser (for signal measurement before volume)
    //          source -> oscilloscopeAnalyser (for oscilloscope display)
    //          source -> gain -> destination (for audio output with volume)
    // The analysers measure the signal BEFORE volume is applied
    source.connect(vuAnalyser);
    // Only connect to oscilloscope analyser if oscilloscope is active
    if (oscilloscopeAnalyser && oscilloscopeActive) {
        source.connect(oscilloscopeAnalyser);
    }
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Schedule playback to maintain continuous audio
    const currentTime = audioContext.currentTime;
    const bufferAhead = nextPlayTime - currentTime;
    
    // Check if we need to reset (falling behind or buffer critically low)
    const needsReset = nextPlayTime < currentTime || bufferAhead < 0.05;
    
    if (needsReset) {
        // Use gain ramping to fade out/in smoothly to eliminate pop
        const FADE_TIME = 0.01; // 10ms fade
        
        // Fade out current gain quickly
        gainNode.gain.setValueAtTime(currentVolume, currentTime);
        gainNode.gain.linearRampToValueAtTime(0, currentTime + FADE_TIME);
        
        // Reset position with small buffer
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime + FADE_TIME + 0.05; // Start after fade + small buffer
            console.log('Audio scheduler reset - was falling behind');
        } else {
            nextPlayTime = currentTime + FADE_TIME + 0.05;
            console.log(`Audio buffer critically low (${bufferAhead.toFixed(3)}s), resetting`);
        }
        
        // Fade back in
        gainNode.gain.setValueAtTime(0, nextPlayTime);
        gainNode.gain.linearRampToValueAtTime(currentVolume, nextPlayTime + FADE_TIME);
    }
    
    // Schedule this buffer to play at the next available time
    source.start(nextPlayTime);
    
    // Update next play time based on buffer duration
    nextPlayTime += buffer.duration;
    
    // Log timing info occasionally for debugging
    const timeSinceStart = currentTime - audioStartTime;
    if (Math.floor(timeSinceStart) % 10 === 0 && Math.floor(timeSinceStart) !== Math.floor(timeSinceStart - buffer.duration)) {
        const bufferAhead = nextPlayTime - currentTime;
        console.log(`Audio timing: ${bufferAhead.toFixed(3)}s buffered`);
    }
}

// Update Signal LED from analyser
function updateSignalLED() {
    if (!vuAnalyser) {
        requestAnimationFrame(updateSignalLED);
        return;
    }
    
    const dataArray = new Uint8Array(vuAnalyser.frequencyBinCount);
    vuAnalyser.getByteTimeDomainData(dataArray);
    
    // Calculate RMS (Root Mean Square)
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
    }
    
    const rms = Math.sqrt(sumSquares / dataArray.length);
    
    // Convert RMS to dB (with floor at -60 dB)
    const rmsDb = 20 * Math.log10(rms + 0.0001);
    const clampedRmsDb = Math.max(-60, Math.min(0, rmsDb));
    
    // Convert dB to percentage (0% = -60dB, 100% = 0dB)
    const rmsPercentage = ((clampedRmsDb + 60) / 60);
    
    // Apply light smoothing for display stability
    vuLevel = vuLevel * 0.8 + rmsPercentage * 0.2;
    
    // Update signal indicator brightness
    updatePowerIndicator(vuLevel);
    
    requestAnimationFrame(updateSignalLED);
}

// Setup Oscilloscope
function setupOscilloscope() {
    const speakerGrille = document.getElementById('speaker-grille');
    const oscilloscopeOverlay = document.getElementById('oscilloscope-overlay');
    oscilloscopeCanvas = document.getElementById('oscilloscope-canvas');
    oscilloscopeCtx = oscilloscopeCanvas.getContext('2d');
    
    // Set canvas size to match its display size
    const resizeCanvas = () => {
        const rect = oscilloscopeCanvas.getBoundingClientRect();
        oscilloscopeCanvas.width = rect.width;
        oscilloscopeCanvas.height = rect.height;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Create separate analyser for oscilloscope
    oscilloscopeAnalyser = audioContext.createAnalyser();
    oscilloscopeAnalyser.fftSize = 2048;
    oscilloscopeAnalyser.smoothingTimeConstant = 0.3;
    
    // Start with oscilloscope visible
    oscilloscopeOverlay.classList.add('active');
    drawOscilloscope();
    
    // Toggle oscilloscope on speaker click
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

// Draw Oscilloscope Waveform
function drawOscilloscope() {
    if (!oscilloscopeActive || !oscilloscopeAnalyser) return;
    
    requestAnimationFrame(drawOscilloscope);
    
    const bufferLength = oscilloscopeAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    oscilloscopeAnalyser.getByteTimeDomainData(dataArray);
    
    const width = oscilloscopeCanvas.width;
    const height = oscilloscopeCanvas.height;
    
    // Clear canvas with vintage radio background
    oscilloscopeCtx.fillStyle = '#0a0805';
    oscilloscopeCtx.fillRect(0, 0, width, height);
    
    // Draw grid lines (vintage oscilloscope style)
    oscilloscopeCtx.strokeStyle = 'rgba(212, 165, 116, 0.15)';
    oscilloscopeCtx.lineWidth = 1;
    
    // Horizontal grid lines
    for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(0, y);
        oscilloscopeCtx.lineTo(width, y);
        oscilloscopeCtx.stroke();
    }
    
    // Vertical grid lines
    for (let i = 0; i <= 10; i++) {
        const x = (width / 10) * i;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(x, 0);
        oscilloscopeCtx.lineTo(x, height);
        oscilloscopeCtx.stroke();
    }
    
    // Draw waveform with vintage glow effect
    oscilloscopeCtx.lineWidth = 2;
    oscilloscopeCtx.strokeStyle = '#ff6b35';
    oscilloscopeCtx.shadowBlur = 10;
    oscilloscopeCtx.shadowColor = '#ff6b35';
    
    oscilloscopeCtx.beginPath();
    
    const sliceWidth = width / bufferLength;
    let x = 0;
    
    // Calculate DC offset (average value) to center the waveform
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
    }
    const dcOffset = sum / bufferLength;
    
    // Apply gain to make waveform more visible
    const gain = 5.0; // Amplify the signal for better visibility
    
    for (let i = 0; i < bufferLength; i++) {
        // Remove DC offset, normalize to -1 to 1 range, then apply gain
        const v = ((dataArray[i] - dcOffset) / 128.0) * gain;
        // Clamp to prevent overflow
        const clampedV = Math.max(-1, Math.min(1, v));
        // Map to canvas coordinates (center at height/2)
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
    
    // Reset shadow for next frame
    oscilloscopeCtx.shadowBlur = 0;
}

// Load settings from URL parameters
function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);
    
    // Load frequency if provided
    if (params.has('freq')) {
        let freq = parseInt(params.get('freq'));
        if (!isNaN(freq)) {
            // Clamp frequency to valid range
            freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq));
            currentFrequency = freq;
            // Calculate dial rotation from frequency (accounting for gear ratio)
            // Map frequency to 0-360 degrees, then apply gear ratio
            const normalized = (freq - MIN_FREQ) / (MAX_FREQ - MIN_FREQ);
            dialRotation = (normalized * 360) * DIAL_GEAR_RATIO;
            
            // Update dial visual position
            const tuningDial = document.getElementById('tuning-dial');
            if (tuningDial) {
                tuningDial.style.transform = `rotate(${dialRotation}deg)`;
            }
            
            // Update frequency display
            updateFrequencyDisplay();
            
            console.log('Loaded frequency from URL:', freq, 'Hz');
        }
    }
    
    // Load volume if provided
    if (params.has('vol')) {
        const vol = parseFloat(params.get('vol'));
        if (!isNaN(vol) && vol >= 0 && vol <= 1) {
            currentVolume = vol;
            volumeRotation = vol * 330;
            
            // Update volume knob visual position
            const volumeKnob = document.getElementById('volume-knob');
            if (volumeKnob) {
                volumeKnob.style.transform = `rotate(${volumeRotation}deg)`;
            }
            
            console.log('Loaded volume from URL:', Math.round(vol * 100) + '%');
        }
    }
}

// Throttled URL update to prevent "too many calls" error
function throttledUpdateURL() {
    const now = Date.now();
    
    // Clear any pending update
    if (urlUpdateTimeout) {
        clearTimeout(urlUpdateTimeout);
    }
    
    // If enough time has passed, update immediately
    if (now - lastUrlUpdateTime >= URL_UPDATE_THROTTLE_MS) {
        updateURL();
        lastUrlUpdateTime = now;
    } else {
        // Otherwise, schedule an update for later
        urlUpdateTimeout = setTimeout(() => {
            updateURL();
            lastUrlUpdateTime = Date.now();
        }, URL_UPDATE_THROTTLE_MS - (now - lastUrlUpdateTime));
    }
}

// Update URL with current settings
function updateURL() {
    try {
        const params = new URLSearchParams();
        params.set('freq', currentFrequency);
        params.set('vol', currentVolume.toFixed(2));
        
        // Update URL without reloading page
        const newURL = window.location.pathname + '?' + params.toString();
        window.history.replaceState({}, '', newURL);
    } catch (e) {
        // Silently ignore if we hit rate limits
        console.debug('URL update skipped:', e.message);
    }
}

// Initialize frequency display
updateFrequencyDisplay();