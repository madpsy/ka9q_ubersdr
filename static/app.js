// ka9q UberSDR Web Client
let ws = null;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let isMuted = false;
let currentVolume = 1.0;
let nextPlayTime = 0;
let audioStartTime = 0;
let currentMode = 'usb';
let currentBandwidthLow = 50;
let currentBandwidthHigh = 3000;

// Audio analysis
let analyser = null; // Analyser for spectrum/waterfall (taps signal before processing)
let vuAnalyser = null; // Dedicated analyser for VU meter (after all processing)
let spectrumCanvas = null;
let spectrumCtx = null;
let spectrumPeaks = null; // Array to store peak values for each bar
let waterfallCanvas = null;
let waterfallCtx = null;
let waterfallOverlayCanvas = null;
let waterfallOverlayCtx = null;
let waterfallImageData = null;
let waterfallStartTime = null;
let waterfallLineCount = 0;
let vuMeterBar = null;
let vuMeterPeak = null;
let vuRmsValue = null;
let vuPeakValue = null;
let vuMeterBarCompact = null;
let vuMeterPeakCompact = null;
let vuPeakHold = 0; // Peak hold value (0-100%)
let eqFilters = []; // Array to store equalizer filter nodes
let eqAnalyser = null; // Analyser to monitor equalizer output for clipping
let eqClipping = false; // Track if equalizer output is clipping
let eqClipIndicatorTimeout = null; // Timeout for hiding EQ clip indicator
let vuPeakDecayRate = 0.1; // Percentage points per frame (slower decay for visibility)
let oscilloscopeCanvas = null;
let oscilloscopeCtx = null;
let animationFrameId = null;
let waterfallIntensity = 0.0; // Intensity adjustment for waterfall (-1.0 to +1.0, 0 = normal)
let waterfallContrast = 50; // Contrast threshold for waterfall (0-100, suppresses noise floor)
let oscilloscopeZoom = 100; // Oscilloscope zoom level (1-100, affects timebase, default to max/slowest)
let bandpassFilters = []; // Array of cascaded bandpass filters for steep rolloff (4 stages = 48 dB/octave)
let bandpassEnabled = false;
let notchFilters = []; // Array of notch filter objects, each with {filters: [], center: Hz, width: Hz}
let notchEnabled = false;
const MAX_NOTCHES = 5; // Maximum number of notch filters
let compressor = null; // DynamicsCompressorNode for audio compression/AGC
let compressorMakeupGain = null; // GainNode for makeup gain after compression
let compressorAnalyser = null; // Analyser to monitor compressor output for clipping
let compressorEnabled = false;
let compressorClipping = false; // Track if compressor output is clipping
let compressorClipIndicatorTimeout = null; // Timeout for hiding clip indicator
let lowpassFilters = []; // Array of cascaded low-pass filters for steep rolloff
let audioVisualizationEnabled = false; // Track if audio visualization is expanded

// Amateur radio band ranges (in Hz)
const bandRanges = {
    '80m': { min: 3500000, max: 4000000 },
    '40m': { min: 7000000, max: 7300000 },
    '30m': { min: 10100000, max: 10150000 },
    '20m': { min: 14000000, max: 14350000 },
    '17m': { min: 18068000, max: 18168000 },
    '15m': { min: 21000000, max: 21450000 },
    '12m': { min: 24890000, max: 24990000 },
    '10m': { min: 28000000, max: 29700000 }
};

// Update band button highlighting based on frequency
function updateBandButtons(frequency) {
    document.querySelectorAll('.band-btn').forEach(btn => {
        const band = btn.getAttribute('data-band');
        const range = bandRanges[band];
        if (range && frequency >= range.min && frequency <= range.max) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load settings from URL parameters first
    loadSettingsFromURL();
    
    // Setup audio start overlay
    const audioStartButton = document.getElementById('audio-start-button');
    const audioStartOverlay = document.getElementById('audio-start-overlay');
    
    if (audioStartButton && audioStartOverlay) {
        audioStartButton.addEventListener('click', () => {
            // Hide overlay
            audioStartOverlay.classList.add('hidden');
            
            // Start audio by triggering the current mode (from URL or default)
            // This will initialize audio context and connect
            setMode(currentMode);
        });
    }
    
    // Setup volume control
    const volumeSlider = document.getElementById('volume');
    volumeSlider.addEventListener('input', (e) => {
        currentVolume = e.target.value / 100;
        document.getElementById('volume-value').textContent = e.target.value + '%';
        if (audioContext) {
            // Volume will be applied when playing audio
        }
    });
    
    // Update band buttons for initial frequency
    const initialFreq = parseInt(document.getElementById('frequency').value);
    updateBandButtons(initialFreq);
    
    // Initialize oscilloscope zoom display
    updateOscilloscopeZoom();

    // Setup visualizer elements
    spectrumCanvas = document.getElementById('spectrum-canvas');
    spectrumCtx = spectrumCanvas.getContext('2d');
    waterfallCanvas = document.getElementById('waterfall-canvas');
    waterfallCtx = waterfallCanvas.getContext('2d');
    waterfallOverlayCanvas = document.getElementById('waterfall-overlay-canvas');
    waterfallOverlayCtx = waterfallOverlayCanvas.getContext('2d');
    oscilloscopeCanvas = document.getElementById('oscilloscope-canvas');
    oscilloscopeCtx = oscilloscopeCanvas.getContext('2d');
    vuMeterBar = document.getElementById('vu-meter-bar');
    vuMeterPeak = document.getElementById('vu-meter-peak');
    vuRmsValue = document.getElementById('vu-rms-value');
    vuPeakValue = document.getElementById('vu-peak-value');
    vuMeterBarCompact = document.getElementById('vu-meter-bar-compact');
    vuMeterPeakCompact = document.getElementById('vu-meter-peak-compact');
    
    // Initialize waterfall with black background
    if (waterfallCtx) {
        waterfallCtx.fillStyle = '#000';
        waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
        waterfallImageData = waterfallCtx.createImageData(waterfallCanvas.width, 1);
    }
    
    // Add click handlers for spectrum and waterfall to adjust bandpass filter
    if (spectrumCanvas) {
        spectrumCanvas.addEventListener('click', (e) => {
            const rect = spectrumCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            
            // Calculate frequency from click position using shared mapping
            // Scale from CSS coordinates to canvas coordinates
            const canvasX = (x / rect.width) * spectrumCanvas.width;
            const freq = Math.round(pixelToFrequency(canvasX, spectrumCanvas.width));
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Clamp to valid range within display bandwidth
            const clampedFreq = Math.max(displayLow + 50, Math.min(displayHigh - 50, freq));
            
            // Enable bandpass filter if not already enabled
            if (!bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = true;
                    toggleBandpassFilter();
                }
            }
            
            // Update bandpass center frequency directly
            const centerSlider = document.getElementById('bandpass-center');
            if (centerSlider) {
                centerSlider.value = clampedFreq;
                // Trigger input event to update display
                centerSlider.dispatchEvent(new Event('input'));
            }
            
            // Update filters directly
            const width = parseInt(document.getElementById('bandpass-width').value);
            const Q = clampedFreq / width;
            for (let filter of bandpassFilters) {
                filter.frequency.value = clampedFreq;
                filter.Q.value = Q;
            }
            
            log(`Bandpass center adjusted to ${clampedFreq} Hz from spectrum click`);
        });
        
        // Add double-click handler to disable bandpass filter
        spectrumCanvas.addEventListener('dblclick', (e) => {
            if (bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = false;
                    toggleBandpassFilter();
                    log('Bandpass filter disabled from spectrum double-click');
                }
            }
        });
        
        // Add right-click handler to add notch filter
        spectrumCanvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // Prevent default context menu
            
            const rect = spectrumCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            
            // Calculate frequency from click position
            const canvasX = (x / rect.width) * spectrumCanvas.width;
            const freq = Math.round(pixelToFrequency(canvasX, spectrumCanvas.width));
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Clamp to valid range within display bandwidth
            const clampedFreq = Math.max(displayLow + 50, Math.min(displayHigh - 50, freq));
            
            // Add notch filter at this frequency
            addNotchFilter(clampedFreq);
        });
    }
    
    if (waterfallCanvas) {
        waterfallCanvas.addEventListener('click', (e) => {
            const rect = waterfallCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            
            // Calculate frequency from click position using shared mapping
            // Scale from CSS coordinates to canvas coordinates
            const canvasX = (x / rect.width) * waterfallCanvas.width;
            const freq = Math.round(pixelToFrequency(canvasX, waterfallCanvas.width));
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Clamp to valid range within display bandwidth
            const clampedFreq = Math.max(displayLow + 50, Math.min(displayHigh - 50, freq));
            
            // Enable bandpass filter if not already enabled
            if (!bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = true;
                    toggleBandpassFilter();
                }
            }
            
            // Update bandpass center frequency directly
            const centerSlider = document.getElementById('bandpass-center');
            if (centerSlider) {
                centerSlider.value = clampedFreq;
                // Trigger input event to update display
                centerSlider.dispatchEvent(new Event('input'));
            }
            
            // Update filters directly
            const width = parseInt(document.getElementById('bandpass-width').value);
            const Q = clampedFreq / width;
            for (let filter of bandpassFilters) {
                filter.frequency.value = clampedFreq;
                filter.Q.value = Q;
            }
            
            log(`Bandpass center adjusted to ${clampedFreq} Hz from waterfall click`);
        });
        
        // Add double-click handler to disable bandpass filter
        waterfallCanvas.addEventListener('dblclick', (e) => {
            if (bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = false;
                    toggleBandpassFilter();
                    log('Bandpass filter disabled from waterfall double-click');
                }
            }
        });
        
        // Add right-click handler to add notch filter
        waterfallCanvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // Prevent default context menu
            
            const rect = waterfallCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            
            // Calculate frequency from click position
            const canvasX = (x / rect.width) * waterfallCanvas.width;
            const freq = Math.round(pixelToFrequency(canvasX, waterfallCanvas.width));
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Clamp to valid range within display bandwidth
            const clampedFreq = Math.max(displayLow + 50, Math.min(displayHigh - 50, freq));
            
            // Add notch filter at this frequency
            addNotchFilter(clampedFreq);
        });
    }

    log('Ready to connect');
    
    // Handle window resize for audio visualizer canvases
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            // Update canvas dimensions to match CSS size
            if (spectrumCanvas && spectrumCtx) {
                const rect = spectrumCanvas.getBoundingClientRect();
                const oldWidth = spectrumCanvas.width;
                const oldHeight = spectrumCanvas.height;
                
                // Only resize if dimensions actually changed
                if (Math.abs(rect.width - oldWidth) > 1 || Math.abs(rect.height - oldHeight) > 1) {
                    spectrumCanvas.width = rect.width;
                    spectrumCanvas.height = rect.height;
                    // Reset peaks array for new width
                    spectrumPeaks = null;
                }
            }
            
            if (waterfallCanvas && waterfallCtx) {
                const rect = waterfallCanvas.getBoundingClientRect();
                const oldWidth = waterfallCanvas.width;
                const oldHeight = waterfallCanvas.height;
                
                // Only resize if dimensions actually changed
                if (Math.abs(rect.width - oldWidth) > 1 || Math.abs(rect.height - oldHeight) > 1) {
                    // Resize canvas - ensure minimum valid dimensions
                    const newWidth = Math.max(1, Math.floor(rect.width));
                    const newHeight = Math.max(1, Math.floor(rect.height));
                    
                    waterfallCanvas.width = newWidth;
                    waterfallCanvas.height = newHeight;
                    
                    // Clear waterfall to black (fresh start with correct frequency alignment)
                    waterfallCtx.fillStyle = '#000';
                    waterfallCtx.fillRect(0, 0, newWidth, newHeight);
                    
                    // Recreate waterfall image data for new width (only if width is valid)
                    if (newWidth > 0) {
                        waterfallImageData = waterfallCtx.createImageData(newWidth, 1);
                    }
                    
                    // Reset waterfall timing
                    waterfallStartTime = Date.now();
                    waterfallLineCount = 0;
                }
            }
            
            if (oscilloscopeCanvas && oscilloscopeCtx) {
                const rect = oscilloscopeCanvas.getBoundingClientRect();
                const oldWidth = oscilloscopeCanvas.width;
                const oldHeight = oscilloscopeCanvas.height;
                
                // Only resize if dimensions actually changed
                if (Math.abs(rect.width - oldWidth) > 1 || Math.abs(rect.height - oldHeight) > 1) {
                    oscilloscopeCanvas.width = rect.width;
                    oscilloscopeCanvas.height = rect.height;
                }
            }
        }, 250); // Debounce resize events
    });
});

// Toggle connection
function toggleConnection() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        disconnect();
    } else {
        connect();
    }
}

// Connect to WebSocket
function connect() {
    const frequency = document.getElementById('frequency').value;
    const mode = currentMode;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${frequency}&mode=${mode}`;
    
    log(`Connecting to ${wsUrl}...`);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        log('Connected!');
        updateConnectionStatus('connected');
        
        // Initialize audio context
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            nextPlayTime = audioContext.currentTime;
            audioStartTime = audioContext.currentTime;
            log(`Audio context initialized (sample rate: ${audioContext.sampleRate} Hz)`);
            
            // Create analyser for spectrum/waterfall (taps signal before processing)
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 16384; // High resolution: 16384 bins for detailed frequency analysis
            analyser.smoothingTimeConstant = 0; // No smoothing - instant response, no fade
            
            // Create dedicated analyser for VU meter (will be connected after all processing)
            vuAnalyser = audioContext.createAnalyser();
            vuAnalyser.fftSize = 2048; // Smaller FFT for VU meter (we only need time domain data)
            vuAnalyser.smoothingTimeConstant = 0; // No smoothing
            
            // Initialize compressor
            initializeCompressor();
            
            // Initialize low-pass filter
            initializeLowpassFilter();
            
            // Initialize equalizer
            initializeEqualizer();
            
            // Note: EQ filters will be chained per-buffer in playAudioBuffer()
            // Do NOT chain them permanently here to avoid signal accumulation
            
            // Initialize waterfall timestamp
            waterfallStartTime = Date.now();
            waterfallLineCount = 0;
            
            // Update oscilloscope zoom display now that audio context exists
            updateOscilloscopeZoom();
            
            // Start visualization loop
            startVisualization();
            
            // Initialize CW decoder if in CW mode
            if (currentMode === 'cwu' || currentMode === 'cwl') {
                const centerFreq = bandpassEnabled && bandpassFilters.length > 0
                    ? bandpassFilters[0].frequency.value
                    : 800;
                initializeCWDecoder(audioContext, analyser, centerFreq);
            }
        }
    };
    
    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    };
    
    ws.onerror = (error) => {
        log('WebSocket error: ' + error);
        console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
        log('Disconnected');
        updateConnectionStatus('disconnected');
        ws = null;
    };
}

// Disconnect from WebSocket
function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    analyser = null;
    eqFilters = [];
    bandpassFilters = [];
    notchFilters = [];
    lowpassFilters = [];
    compressor = null;
    isPlaying = false;
    audioQueue = [];
    nextPlayTime = 0;
    audioStartTime = 0;
    waterfallStartTime = null;
    waterfallLineCount = 0;
    vuPeakHold = 0;
    
    // Reset visualizers
    if (vuMeterBar) vuMeterBar.style.width = '0%';
    if (vuMeterPeak) vuMeterPeak.style.left = '0%';
    if (vuRmsValue) vuRmsValue.textContent = '-∞ dB';
    if (vuPeakValue) vuPeakValue.textContent = '-∞ dB';
    if (spectrumCtx) {
        spectrumCtx.fillStyle = '#2c3e50';
        spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
    }
    if (oscilloscopeCtx) {
        oscilloscopeCtx.fillStyle = '#2c3e50';
        oscilloscopeCtx.fillRect(0, 0, oscilloscopeCanvas.width, oscilloscopeCanvas.height);
    }
    if (waterfallCtx) {
        waterfallCtx.fillStyle = '#000';
        waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
    }
}

// Handle incoming messages
function handleMessage(msg) {
    switch (msg.type) {
        case 'status':
            updateStatus(msg);
            break;
        case 'audio':
            handleAudio(msg);
            break;
        case 'error':
            log('Error: ' + msg.error, 'error');
            break;
        case 'pong':
            // Keepalive response
            break;
        default:
            console.log('Unknown message type:', msg.type);
    }
}

// Update status display
function updateStatus(msg) {
    if (msg.frequency) {
        document.getElementById('current-freq').textContent = formatFrequency(msg.frequency);
        updateBandButtons(msg.frequency);
        // Update spectrum display cursor
        if (spectrumDisplay) {
            spectrumDisplay.updateConfig({
                tunedFreq: msg.frequency,
                bandwidthLow: currentBandwidthLow,
                bandwidthHigh: currentBandwidthHigh
            });
        }
    }
    if (msg.mode) {
        document.getElementById('current-mode').textContent = msg.mode.toUpperCase();
    }
    // Sample rate display removed - no longer shown in UI
    log(`Status: ${formatFrequency(msg.frequency)} ${msg.mode.toUpperCase()}`);
}

// Handle audio data
function handleAudio(msg) {
    if (!audioContext) {
        return;
    }
    
    try {
        // Decode base64 PCM data
        const binaryString = atob(msg.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // RTP audio from radiod is big-endian signed 16-bit PCM
        // Monitor application confirms all modes use identical processing
        const numSamples = bytes.length / 2;
        const floatData = new Float32Array(numSamples);
        
        // Parse big-endian int16 and convert to float, exactly like monitor
        for (let i = 0; i < numSamples; i++) {
            const highByte = bytes[i * 2];
            const lowByte = bytes[i * 2 + 1];
            let sample = (highByte << 8) | lowByte;
            if (sample >= 0x8000) {
                sample -= 0x10000;
            }
            // Use 32767 (INT16_MAX) not 32768, matching monitor's SCALE16
            floatData[i] = sample / 32767.0;
        }
        
        // Create audio buffer
        const audioBuffer = audioContext.createBuffer(1, floatData.length, msg.sampleRate);
        audioBuffer.getChannelData(0).set(floatData);
        
        // Play audio
        playAudioBuffer(audioBuffer);
        
    } catch (e) {
        console.error('Failed to process audio:', e);
    }
}

// Play audio buffer with proper timing
function playAudioBuffer(buffer) {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    
    // Audio chain:
    // source -> analyser (for spectrum/waterfall) -> [compressor] -> [bandpass] -> EQ -> vuAnalyser (for VU meter) -> gain (for volume/mute) -> destination
    // The main analyser taps the signal for visualizations but doesn't affect it
    // The VU analyser measures after all processing but before volume/mute
    source.connect(analyser);
    
    // Build the audio processing chain step by step
    let nextNode = source;
    
    // Step 1: Compressor with makeup gain (optional)
    if (compressorEnabled && compressor) {
        // Disconnect compressor and makeup gain to clear old connections
        try {
            compressor.disconnect();
            if (compressorMakeupGain) {
                compressorMakeupGain.disconnect();
            }
        } catch (e) {
            // Ignore if already disconnected
        }
        
        // Connect to compressor
        nextNode.connect(compressor);
        nextNode = compressor;
        
        // Add makeup gain after compressor
        if (compressorMakeupGain) {
            nextNode.connect(compressorMakeupGain);
            nextNode = compressorMakeupGain;
        }
    }
    
    // Step 2: Bandpass filter (optional)
    if (bandpassEnabled && bandpassFilters.length > 0) {
        // Disconnect all bandpass filters first to clear any old connections
        for (let filter of bandpassFilters) {
            try {
                filter.disconnect();
            } catch (e) {
                // Ignore if already disconnected
            }
        }
        
        // Connect input to first filter
        nextNode.connect(bandpassFilters[0]);
        
        // Chain the filters together
        for (let i = 0; i < bandpassFilters.length - 1; i++) {
            bandpassFilters[i].connect(bandpassFilters[i + 1]);
        }
        
        nextNode = bandpassFilters[bandpassFilters.length - 1];
    }
    
    // Step 2.5: Notch filters (optional)
    if (notchEnabled && notchFilters.length > 0) {
        // Process each notch filter
        for (let notch of notchFilters) {
            if (notch.filters && notch.filters.length > 0) {
                // Disconnect all filters in this notch first
                for (let filter of notch.filters) {
                    try {
                        filter.disconnect();
                    } catch (e) {
                        // Ignore if already disconnected
                    }
                }
                
                // Connect input to first filter of this notch
                nextNode.connect(notch.filters[0]);
                
                // Chain the filters together within this notch
                for (let i = 0; i < notch.filters.length - 1; i++) {
                    notch.filters[i].connect(notch.filters[i + 1]);
                }
                
                nextNode = notch.filters[notch.filters.length - 1];
            }
        }
    }
    
    // Step 3: EQ chain (optional)
    if (equalizerEnabled && eqFilters.length > 0) {
        // Disconnect all EQ filters first to clear any old connections
        for (let filter of eqFilters) {
            try {
                filter.disconnect();
            } catch (e) {
                // Ignore if already disconnected
            }
        }
        
        // Connect input to first filter
        nextNode.connect(eqFilters[0]);
        
        // Chain the filters together
        for (let i = 0; i < eqFilters.length - 1; i++) {
            eqFilters[i].connect(eqFilters[i + 1]);
        }
        
        nextNode = eqFilters[eqFilters.length - 1];
    }
    
    // Step 4: Gain node for volume/mute control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = isMuted ? 0 : currentVolume;
    nextNode.connect(gainNode);
    
    // Step 5: Tap signal for monitoring AFTER all processing but BEFORE final output
    // These are just monitoring taps and don't affect the audio path
    if (compressorEnabled && compressorAnalyser) {
        gainNode.connect(compressorAnalyser);
    }
    if (equalizerEnabled && eqAnalyser) {
        gainNode.connect(eqAnalyser);
    }
    if (vuAnalyser) {
        gainNode.connect(vuAnalyser);
    }
    
    // Step 6: Final output to destination
    gainNode.connect(audioContext.destination);
    
    // Schedule playback to maintain continuous audio
    const currentTime = audioContext.currentTime;
    
    // If we're falling behind, reset the schedule
    if (nextPlayTime < currentTime) {
        nextPlayTime = currentTime;
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

// Tune to new frequency/mode/bandwidth
function tune() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('Not connected', 'error');
        return;
    }
    
    const frequency = parseInt(document.getElementById('frequency').value);
    const mode = currentMode;
    const bandwidthLow = currentBandwidthLow;
    const bandwidthHigh = currentBandwidthHigh;
    
    const msg = {
        type: 'tune',
        frequency: frequency,
        mode: mode,
        bandwidthLow: bandwidthLow,
        bandwidthHigh: bandwidthHigh
    };
    
    ws.send(JSON.stringify(msg));
    log(`Tuning to ${formatFrequency(frequency)} ${mode.toUpperCase()} (BW: ${bandwidthLow} to ${bandwidthHigh} Hz)...`);
}

// Validate frequency input - only allow digits and max 8 digits
function validateFrequencyInput(input) {
    // Remove any non-digit characters
    let value = input.value.replace(/\D/g, '');
    
    // Limit to 8 digits (max 30000000)
    if (value.length > 8) {
        value = value.substring(0, 8);
    }
    
    // Update input value
    input.value = value;
}

// Handle frequency input change - auto-connect if not connected
function handleFrequencyChange() {
    const freqInput = document.getElementById('frequency');
    let frequency = parseInt(freqInput.value);
    
    // Validate frequency range: 100 kHz to 30 MHz (in Hz)
    const MIN_FREQ = 100000;   // 100 kHz
    const MAX_FREQ = 30000000; // 30 MHz
    
    if (isNaN(frequency) || frequency < MIN_FREQ || frequency > MAX_FREQ) {
        // Clamp to valid range
        if (isNaN(frequency) || frequency < MIN_FREQ) {
            frequency = MIN_FREQ;
        } else if (frequency > MAX_FREQ) {
            frequency = MAX_FREQ;
        }
        
        // Update input with clamped value
        freqInput.value = frequency;
        log(`Frequency clamped to valid range: ${formatFrequency(frequency)}`, 'error');
    }
    
    // Update band button highlighting
    updateBandButtons(frequency);
    
    // Update URL with new frequency
    updateURL();
    
    // Auto-connect if not connected
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
    } else {
        autoTune();
    }
}

// Set frequency from preset button
function setFrequency(freq) {
    // Validate frequency range
    const MIN_FREQ = 100000;   // 100 kHz
    const MAX_FREQ = 30000000; // 30 MHz
    
    const clampedFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq));
    
    document.getElementById('frequency').value = clampedFreq;
    updateBandButtons(clampedFreq);
    log(`Frequency preset: ${formatFrequency(clampedFreq)}`);
    
    // Update URL with new frequency
    updateURL();
    
    // Auto-connect if not connected
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
    } else {
        autoTune();
    }
}

// Adjust frequency by a given amount (Hz)
function adjustFrequency(deltaHz) {
    const freqInput = document.getElementById('frequency');
    const currentFreq = parseInt(freqInput.value);
    const newFreq = currentFreq + deltaHz;
    
    // Clamp to valid range: 100 kHz to 30 MHz
    const MIN_FREQ = 100000;   // 100 kHz
    const MAX_FREQ = 30000000; // 30 MHz
    const clampedFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newFreq));
    
    freqInput.value = clampedFreq;
    updateBandButtons(clampedFreq);
    
    // Log with appropriate precision based on step size
    let stepDesc;
    if (Math.abs(deltaHz) >= 1000) {
        stepDesc = `${deltaHz > 0 ? '+' : ''}${deltaHz / 1000} kHz`;
    } else {
        stepDesc = `${deltaHz > 0 ? '+' : ''}${deltaHz} Hz`;
    }
    log(`Frequency adjusted: ${stepDesc} → ${formatFrequency(clampedFreq)}`);
    
    // Update URL with new frequency
    updateURL();
    
    autoTune();
}

// Load settings from URL parameters
function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);
    
    // Load frequency
    if (params.has('freq')) {
        const freq = parseInt(params.get('freq'));
        if (!isNaN(freq) && freq >= 100000 && freq <= 30000000) {
            document.getElementById('frequency').value = freq;
            updateBandButtons(freq);
        }
    }
    
    // Load mode
    if (params.has('mode')) {
        const mode = params.get('mode');
        const validModes = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];
        if (validModes.includes(mode)) {
            currentMode = mode;
        }
    }
    
    // Load bandwidth low
    if (params.has('bwl')) {
        const bwl = parseInt(params.get('bwl'));
        if (!isNaN(bwl)) {
            currentBandwidthLow = bwl;
            document.getElementById('bandwidth-low').value = bwl;
            document.getElementById('bandwidth-low-value').textContent = bwl;
        }
    }
    
    // Load bandwidth high
    if (params.has('bwh')) {
        const bwh = parseInt(params.get('bwh'));
        if (!isNaN(bwh)) {
            currentBandwidthHigh = bwh;
            document.getElementById('bandwidth-high').value = bwh;
            document.getElementById('bandwidth-high-value').textContent = bwh;
        }
    }
    
    log('Settings loaded from URL');
}

// Update URL with current settings
function updateURL() {
    const params = new URLSearchParams();
    
    // Add frequency
    const freq = parseInt(document.getElementById('frequency').value);
    if (!isNaN(freq)) {
        params.set('freq', freq);
    }
    
    // Add mode
    params.set('mode', currentMode);
    
    // Add bandwidth
    params.set('bwl', currentBandwidthLow);
    params.set('bwh', currentBandwidthHigh);
    
    // Update URL without reloading page
    const newURL = window.location.pathname + '?' + params.toString();
    window.history.replaceState({}, '', newURL);
}

// Set mode from buttons
function setMode(mode) {
    currentMode = mode;
    
    // Update button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`mode-${mode}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
    
    // Update bandwidth limits based on mode
    const bandwidthLowSlider = document.getElementById('bandwidth-low');
    const bandwidthHighSlider = document.getElementById('bandwidth-high');
    let minLow, maxLow, defaultLow, maxHigh, defaultHigh;
    
    switch(mode) {
    	case 'usb':
    		minLow = 0;
    		maxLow = 500;
    		defaultLow = 50;
    		maxHigh = 3200;
    		defaultHigh = 2700;
    		break;
    	case 'lsb':
    		minLow = -3200;
    		maxLow = -50;
    		defaultLow = -2700;
    		maxHigh = 0;
    		defaultHigh = -50;
    		break;
        case 'am':
        case 'sam':
            minLow = -6000;
            maxLow = 0;
            defaultLow = -5000;
            maxHigh = 6000;
            defaultHigh = 5000;
            break;
        case 'cwu':
        case 'cwl':
        	minLow = -500;
        	maxLow = 0;
        	defaultLow = -200;
        	maxHigh = 500;
        	defaultHigh = 200;
        	break;
        case 'fm':
            minLow = -8000;
            maxLow = 0;
            defaultLow = -8000;
            maxHigh = 8000;
            defaultHigh = 8000;
            break;
        case 'nfm':
            minLow = -6250;
            maxLow = 0;
            defaultLow = -6250;
            maxHigh = 6250;
            defaultHigh = 6250;
            break;
        default:
            minLow = 0;
            maxLow = 500;
            defaultLow = 50;
            maxHigh = 6000;
            defaultHigh = 3000;
    }
    
    // Update sliders min/max and values
    bandwidthLowSlider.min = minLow;
    bandwidthLowSlider.max = maxLow;
    bandwidthLowSlider.value = defaultLow;
    currentBandwidthLow = defaultLow;
    document.getElementById('bandwidth-low-value').textContent = defaultLow;
    
    bandwidthHighSlider.min = 0;  // High slider always starts at 0
    bandwidthHighSlider.max = maxHigh;
    bandwidthHighSlider.value = defaultHigh;
    currentBandwidthHigh = defaultHigh;
    document.getElementById('bandwidth-high-value').textContent = defaultHigh;
    
    log(`Mode changed to ${mode.toUpperCase()} (BW: ${defaultLow} to ${defaultHigh} Hz)`);
    
    // Update URL with new mode
    updateURL();
    
    // Show/hide CW decoder panel based on mode
    const cwDecoderPanel = document.getElementById('cw-decoder-panel');
    if (cwDecoderPanel) {
        if (mode === 'cwu' || mode === 'cwl') {
            cwDecoderPanel.style.display = 'block';
            
            // Auto-enable bandpass filter for CW modes with 500 Hz offset
            if (!bandpassEnabled && audioContext) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = true;
                    toggleBandpassFilter();
                    
                    // Set bandpass to 500 Hz center with 400 Hz width
                    const centerSlider = document.getElementById('bandpass-center');
                    const widthSlider = document.getElementById('bandpass-width');
                    if (centerSlider && widthSlider) {
                        centerSlider.value = 500;
                        widthSlider.value = 400;
                        updateBandpassFilter();
                    }
                    
                    log('Bandpass filter auto-enabled for CW mode at 500 Hz');
                }
            }
        } else {
            cwDecoderPanel.style.display = 'none';
            // Disable CW decoder if it was enabled
            const cwCheckbox = document.getElementById('cw-decoder-enable');
            if (cwCheckbox && cwCheckbox.checked) {
                cwCheckbox.checked = false;
                toggleCWDecoder();
            }
            
            // Disable bandpass filter when switching away from CW modes
            if (bandpassEnabled) {
                const bandpassCheckbox = document.getElementById('bandpass-enable');
                if (bandpassCheckbox) {
                    bandpassCheckbox.checked = false;
                    toggleBandpassFilter();
                    log('Bandpass filter disabled when switching from CW mode');
                }
            }
        }
    }
    
    // Auto-connect if not connected
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
    } else {
        autoTune();
    }
}

// Update bandwidth display (called on input for real-time display)
function updateBandwidthDisplay() {
    const bandwidthLow = parseInt(document.getElementById('bandwidth-low').value);
    const bandwidthHigh = parseInt(document.getElementById('bandwidth-high').value);
    document.getElementById('bandwidth-low-value').textContent = bandwidthLow;
    document.getElementById('bandwidth-high-value').textContent = bandwidthHigh;
}

// Update bandwidth value and trigger tune (called on change when slider is released)
function updateBandwidth() {
    const bandwidthLow = parseInt(document.getElementById('bandwidth-low').value);
    const bandwidthHigh = parseInt(document.getElementById('bandwidth-high').value);
    currentBandwidthLow = bandwidthLow;
    currentBandwidthHigh = bandwidthHigh;
    document.getElementById('bandwidth-low-value').textContent = bandwidthLow;
    document.getElementById('bandwidth-high-value').textContent = bandwidthHigh;
    
    // Clear waterfall when bandwidth changes to avoid misaligned old data
    if (waterfallCtx) {
        waterfallCtx.fillStyle = '#000';
        waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
        waterfallStartTime = Date.now();
        waterfallLineCount = 0;
    }
    
    // Update spectrum display bandwidth indicator
    if (spectrumDisplay) {
        spectrumDisplay.updateConfig({
            bandwidthLow: bandwidthLow,
            bandwidthHigh: bandwidthHigh
        });
    }
    
    log(`Bandwidth changed to ${bandwidthLow} to ${bandwidthHigh} Hz`);
    
    // Update URL with new bandwidth
    updateURL();
    
    autoTune();
}

// Auto-tune when frequency or mode changes
function autoTune() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        tune();
    }
}

// Toggle mute
function toggleMute() {
    isMuted = !isMuted;
    const btn = document.getElementById('mute-btn');
    btn.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
    log(isMuted ? 'Muted' : 'Unmuted');
}

// Update connection status display (removed from UI, kept for compatibility)
function updateConnectionStatus(status) {
    // Status bar removed from UI - function kept for compatibility
    // Connection status is now shown via log messages only
}

// Format frequency for display
function formatFrequency(hz) {
    if (hz >= 1000000) {
        return (hz / 1000000).toFixed(3) + ' MHz';
    } else if (hz >= 1000) {
        return (hz / 1000).toFixed(1) + ' kHz';
    } else {
        return hz + ' Hz';
    }
}

// Log message to activity log (or console if log element doesn't exist)
function log(message, type = 'info') {
    const logEl = document.getElementById('log');
    if (!logEl) {
        // Log to console if log element doesn't exist
        console.log(`[${type}] ${message}`);
        return;
    }
    
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    entry.textContent = `[${timestamp}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
    
    // Keep only last 50 entries
    while (logEl.children.length > 50) {
        logEl.removeChild(logEl.firstChild);
    }
}

// Visualization functions
let lastWaterfallUpdate = 0;
let waterfallUpdateInterval = 33; // Update waterfall every 33ms (30fps) - default fast rate

// Shared frequency mapping helpers for consistent spectrum/waterfall alignment
function getFrequencyBinMapping() {
    if (!analyser || !audioContext) return null;
    
    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;
    const bufferLength = analyser.frequencyBinCount;
    
    // Handle both positive and negative bandwidth values (e.g., CW modes)
    // For FFT, we need absolute frequencies since FFT bins are always positive
    let binStartFreq, binEndFreq;
    let cwOffset = 0;
    
    // Check if we're in CW mode (narrow bandwidth around zero)
    // CW modes have an inherent 500 Hz offset in the audio from radiod
    if (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) {
        // CW mode: center the display on 500 Hz (the inherent CW offset)
        cwOffset = 500;
        const halfBW = Math.max(Math.abs(currentBandwidthLow), Math.abs(currentBandwidthHigh));
        binStartFreq = Math.max(0, cwOffset - halfBW);
        binEndFreq = cwOffset + halfBW;
    } else if (currentBandwidthLow < 0 && currentBandwidthHigh > 0) {
        // Bandwidth spans zero (e.g., AM/SAM: -5000 to +5000)
        // Show the full range from 0 to the maximum extent
        binStartFreq = 0;
        binEndFreq = Math.max(Math.abs(currentBandwidthLow), Math.abs(currentBandwidthHigh));
    } else if (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) {
        // Both negative (e.g., LSB: -2700 to -50)
        // Convert to positive frequencies (reversed order)
        binStartFreq = Math.abs(currentBandwidthHigh);
        binEndFreq = Math.abs(currentBandwidthLow);
    } else {
        // Both positive or zero (e.g., USB: 50 to 2700)
        binStartFreq = Math.max(0, currentBandwidthLow);
        binEndFreq = currentBandwidthHigh;
    }
    
    const bandwidth = binEndFreq - binStartFreq;
    
    const startBinIndex = Math.floor((binStartFreq / nyquist) * bufferLength);
    const binsForBandwidth = Math.floor((bandwidth / nyquist) * bufferLength);
    
    // Debug logging for CW modes
    if (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) {
        console.log(`CW Mode Debug: BW=${currentBandwidthLow} to ${currentBandwidthHigh}, cwOffset=${cwOffset}, display=${binStartFreq}-${binEndFreq}Hz, startBin=${startBinIndex}, numBins=${binsForBandwidth}`);
    }
    
    return {
        startBinIndex,
        binsForBandwidth,
        binStartFreq,
        binEndFreq,
        bandwidth,
        nyquist,
        bufferLength
    };
}

function frequencyToPixel(freq, canvasWidth) {
    // Get CW offset if in CW mode
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    
    // For CW mode, freq is in actual audio Hz (e.g., 500), need to map to display range (300-700)
    // For other modes, freq is relative to bandwidth (e.g., -200 to +200 or 50 to 2700)
    const displayLow = cwOffset + currentBandwidthLow;
    const displayHigh = cwOffset + currentBandwidthHigh;
    const displayBandwidth = displayHigh - displayLow;
    
    return ((freq - displayLow) / displayBandwidth) * canvasWidth;
}

function pixelToFrequency(pixel, canvasWidth) {
    // Get CW offset if in CW mode
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    
    // For CW mode, return actual audio Hz (e.g., 500)
    // For other modes, return frequency relative to bandwidth
    const displayLow = cwOffset + currentBandwidthLow;
    const displayHigh = cwOffset + currentBandwidthHigh;
    const displayBandwidth = displayHigh - displayLow;
    
    return displayLow + (pixel / canvasWidth) * displayBandwidth;
}

function startVisualization() {
    if (!analyser) return;
    
    function draw() {
        if (!analyser) return;
        
        const now = performance.now();
        
        // Always check for clipping (independent of visualization state)
        checkClipping();
        
        // Always update VU meter (for compact version when visualization is hidden)
        updateVUMeter();
        
        // Only update other visualizations if the section is expanded (performance optimization)
        if (audioVisualizationEnabled) {
            
            // Update oscilloscope (60fps)
            updateOscilloscope();
            
            // Update spectrum (60fps)
            updateSpectrum();
            
            // Update waterfall (throttled to 20fps for performance)
            if (now - lastWaterfallUpdate >= waterfallUpdateInterval) {
                updateWaterfall();
                lastWaterfallUpdate = now;
            }
        }
        
        // Process CW decoder if enabled (always run, independent of visualization)
        processCWAudio();
        
        animationFrameId = requestAnimationFrame(draw);
    }
    
    draw();
}

// Toggle audio visualization panel
function toggleAudioVisualization() {
    const content = document.getElementById('audio-visualization-content');
    const toggle = document.getElementById('audio-viz-toggle');
    const compactVU = document.getElementById('vu-meter-compact');
    
    if (content.style.display === 'none') {
        // Expand - show full visualization, hide compact VU meter
        content.style.display = 'block';
        toggle.classList.add('expanded');
        audioVisualizationEnabled = true;
        if (compactVU) compactVU.style.display = 'none';
        
        // Resize canvases to match their containers after expansion
        // Use setTimeout to ensure the display change has taken effect
        setTimeout(() => {
            if (spectrumCanvas && spectrumCtx) {
                const rect = spectrumCanvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    spectrumCanvas.width = Math.floor(rect.width);
                    spectrumCanvas.height = Math.floor(rect.height);
                    spectrumPeaks = null; // Reset peaks for new width
                }
            }
            
            if (waterfallCanvas && waterfallCtx) {
                const rect = waterfallCanvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    const newWidth = Math.max(1, Math.floor(rect.width));
                    const newHeight = Math.max(1, Math.floor(rect.height));
                    
                    waterfallCanvas.width = newWidth;
                    waterfallCanvas.height = newHeight;
                    
                    // Clear and recreate waterfall
                    waterfallCtx.fillStyle = '#000';
                    waterfallCtx.fillRect(0, 0, newWidth, newHeight);
                    
                    if (newWidth > 0) {
                        waterfallImageData = waterfallCtx.createImageData(newWidth, 1);
                    }
                    
                    waterfallStartTime = Date.now();
                    waterfallLineCount = 0;
                }
            }
            
            if (oscilloscopeCanvas && oscilloscopeCtx) {
                const rect = oscilloscopeCanvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    oscilloscopeCanvas.width = Math.floor(rect.width);
                    oscilloscopeCanvas.height = Math.floor(rect.height);
                }
            }
        }, 50); // Small delay to ensure layout is complete
        
        log('Audio visualization enabled');
    } else {
        // Collapse - hide visualization, show compact VU meter
        content.style.display = 'none';
        toggle.classList.remove('expanded');
        audioVisualizationEnabled = false;
        if (compactVU) compactVU.style.display = 'flex';
        log('Audio visualization disabled (performance mode)');
    }
}

// Check for clipping (runs independently of visualization state)
function checkClipping() {
    // Check for clipping at compressor output if enabled
    if (compressorEnabled && compressorAnalyser) {
        const compDataArray = new Uint8Array(compressorAnalyser.frequencyBinCount);
        compressorAnalyser.getByteTimeDomainData(compDataArray);
        
        let compMaxSample = 0;
        for (let i = 0; i < compDataArray.length; i++) {
            const normalized = (compDataArray[i] - 128) / 128;
            compMaxSample = Math.max(compMaxSample, Math.abs(normalized));
        }
        
        // Clipping occurs when samples exceed ±0.99 (close to ±1.0)
        if (compMaxSample > 0.99) {
            showCompressorClipIndicator();
        }
    }
    
    // Check for clipping at equalizer output if enabled
    if (equalizerEnabled && eqAnalyser) {
        const eqDataArray = new Uint8Array(eqAnalyser.frequencyBinCount);
        eqAnalyser.getByteTimeDomainData(eqDataArray);
        
        let eqMaxSample = 0;
        for (let i = 0; i < eqDataArray.length; i++) {
            const normalized = (eqDataArray[i] - 128) / 128;
            eqMaxSample = Math.max(eqMaxSample, Math.abs(normalized));
        }
        
        // Clipping occurs when samples exceed ±0.99 (close to ±1.0)
        if (eqMaxSample > 0.99) {
            showEqualizerClipIndicator();
        }
    }
}

function updateVUMeter() {
    // Use dedicated VU analyser (after all processing) if available, otherwise fall back to main analyser
    const activeAnalyser = vuAnalyser || analyser;
    if (!activeAnalyser) return;
    
    const dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteTimeDomainData(dataArray);
    
    // Calculate RMS (Root Mean Square)
    let sumSquares = 0;
    let maxSample = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
        maxSample = Math.max(maxSample, Math.abs(normalized));
    }
    
    const rms = Math.sqrt(sumSquares / dataArray.length);
    
    // Convert RMS to dB (with floor at -60 dB)
    const rmsDb = 20 * Math.log10(rms);
    const clampedRmsDb = Math.max(-60, Math.min(0, rmsDb));
    
    // Convert peak to dB
    const peakDb = 20 * Math.log10(maxSample);
    const clampedPeakDb = Math.max(-60, Math.min(0, peakDb));
    
    // Convert dB to percentage (0% = -60dB, 100% = 0dB)
    const rmsPercentage = ((clampedRmsDb + 60) / 60) * 100;
    
    // Update peak hold line - tracks the RMS bar's maximum position
    if (rmsPercentage > vuPeakHold) {
        vuPeakHold = rmsPercentage; // New peak
    } else {
        vuPeakHold = Math.max(0, vuPeakHold - vuPeakDecayRate); // Decay
    }
    
    const rmsText = clampedRmsDb === -Infinity ? '-∞ dB' : clampedRmsDb.toFixed(1) + ' dB';
    const peakText = clampedPeakDb === -Infinity ? '-∞ dB' : clampedPeakDb.toFixed(1) + ' dB';
    
    // Create gradient that shows only the portion up to current level
    // The gradient is sized to the full meter width, but we only show the portion covered by the bar
    const gradient = `linear-gradient(to right,
        #28a745 0%,
        #28a745 66.67%,
        #ffc107 66.67%,
        #ffc107 83.33%,
        #ff9800 83.33%,
        #ff9800 91.67%,
        #dc3545 91.67%,
        #dc3545 100%)`;
    
    // Update full VU meter (in visualization section)
    if (vuMeterBar && vuMeterPeak && vuRmsValue && vuPeakValue) {
        vuMeterBar.style.width = rmsPercentage + '%';
        vuMeterBar.style.background = gradient;
        vuMeterBar.style.backgroundSize = `${100 / (rmsPercentage / 100)}% 100%`;
        vuMeterBar.style.backgroundPosition = 'left center';
        vuMeterPeak.style.left = vuPeakHold + '%';
        vuRmsValue.textContent = rmsText;
        vuPeakValue.textContent = peakText;
    }
    
    // Update compact VU meter (in audio controls) - bar and peak only, no text values
    if (vuMeterBarCompact && vuMeterPeakCompact) {
        vuMeterBarCompact.style.width = rmsPercentage + '%';
        vuMeterBarCompact.style.background = gradient;
        vuMeterBarCompact.style.backgroundSize = `${100 / (rmsPercentage / 100)}% 100%`;
        vuMeterBarCompact.style.backgroundPosition = 'left center';
        vuMeterPeakCompact.style.left = vuPeakHold + '%';
    }
}

// Show compressor clipping indicator
function showCompressorClipIndicator() {
    const indicator = document.getElementById('compressor-clip-indicator');
    if (!indicator) return;
    
    // Show the indicator
    indicator.style.display = 'inline';
    compressorClipping = true;
    
    // Clear any existing timeout
    if (compressorClipIndicatorTimeout) {
        clearTimeout(compressorClipIndicatorTimeout);
    }
    
    // Hide after 2 seconds of no clipping
    compressorClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        compressorClipping = false;
    }, 2000);
}

// Show equalizer clipping indicator
function showEqualizerClipIndicator() {
    const indicator = document.getElementById('equalizer-clip-indicator');
    if (!indicator) return;
    
    // Show the indicator
    indicator.style.display = 'inline';
    eqClipping = true;
    
    // Clear any existing timeout
    if (eqClipIndicatorTimeout) {
        clearTimeout(eqClipIndicatorTimeout);
    }
    
    // Hide after 2 seconds of no clipping
    eqClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        eqClipping = false;
    }, 2000);
}

function updateOscilloscope() {
    if (!analyser || !oscilloscopeCtx) return;
    
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);
    
    const width = oscilloscopeCanvas.width;
    const height = oscilloscopeCanvas.height;
    
    // Calculate how many samples to display based on zoom level
    // Invert zoom so higher slider value = slower timebase (more samples displayed)
    // Slider 1 = fast (1/100 of buffer), Slider 100 = slow (full buffer)
    const invertedZoom = 101 - oscilloscopeZoom; // Invert: 1->100, 100->1
    const samplesToDisplay = Math.floor(bufferLength / invertedZoom);
    const startSample = Math.floor((bufferLength - samplesToDisplay) / 2); // Center the view
    
    // Clear canvas
    oscilloscopeCtx.fillStyle = '#2c3e50';
    oscilloscopeCtx.fillRect(0, 0, width, height);
    
    // Draw grid lines
    oscilloscopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    oscilloscopeCtx.lineWidth = 1;
    
    // Horizontal grid lines
    for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * height;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(0, y);
        oscilloscopeCtx.lineTo(width, y);
        oscilloscopeCtx.stroke();
    }
    
    // Vertical grid lines
    for (let i = 0; i <= 8; i++) {
        const x = (i / 8) * width;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(x, 0);
        oscilloscopeCtx.lineTo(x, height);
        oscilloscopeCtx.stroke();
    }
    
    // Draw center line (zero crossing)
    oscilloscopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    oscilloscopeCtx.lineWidth = 1;
    oscilloscopeCtx.beginPath();
    oscilloscopeCtx.moveTo(0, height / 2);
    oscilloscopeCtx.lineTo(width, height / 2);
    oscilloscopeCtx.stroke();
    
    // Draw waveform
    oscilloscopeCtx.lineWidth = 2;
    oscilloscopeCtx.strokeStyle = '#00ff00'; // Classic oscilloscope green
    oscilloscopeCtx.beginPath();
    
    const sliceWidth = width / samplesToDisplay;
    let x = 0;
    
    for (let i = 0; i < samplesToDisplay; i++) {
        const sampleIndex = startSample + i;
        const v = dataArray[sampleIndex] / 128.0; // Normalize to 0-2
        const y = (v * height) / 2;
        
        if (i === 0) {
            oscilloscopeCtx.moveTo(x, y);
        } else {
            oscilloscopeCtx.lineTo(x, y);
        }
        
        x += sliceWidth;
    }
    
    oscilloscopeCtx.stroke();
}

function updateSpectrum() {
    if (!analyser || !spectrumCtx) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    
    // Clear canvas
    spectrumCtx.fillStyle = '#2c3e50';
    spectrumCtx.fillRect(0, 0, width, height);
    
    // Draw dB scale on left side
    spectrumCtx.font = 'bold 11px monospace';
    spectrumCtx.textAlign = 'left';
    spectrumCtx.textBaseline = 'middle';
    
    // dB scale: 0 dB at top, -60 dB at bottom (assuming 0-255 maps to -60 to 0 dB)
    const dbLevels = [0, -10, -20, -30, -40, -50, -60];
    
    for (let i = 0; i < dbLevels.length; i++) {
        const db = dbLevels[i];
        // Map dB to height: 0 dB = top (0), -60 dB = bottom (height)
        const y = ((Math.abs(db) / 60) * height);
        
        // Draw horizontal grid line
        spectrumCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        spectrumCtx.lineWidth = 1;
        spectrumCtx.beginPath();
        spectrumCtx.moveTo(0, y);
        spectrumCtx.lineTo(width, y);
        spectrumCtx.stroke();
        
        // Draw dB label with background
        const label = db + ' dB';
        const labelWidth = spectrumCtx.measureText(label).width + 6;
        
        spectrumCtx.fillStyle = 'rgba(44, 62, 80, 0.8)';
        spectrumCtx.fillRect(2, y - 8, labelWidth, 16);
        
        spectrumCtx.strokeStyle = '#000000';
        spectrumCtx.lineWidth = 3;
        spectrumCtx.strokeText(label, 5, y);
        
        spectrumCtx.fillStyle = '#ffffff';
        spectrumCtx.fillText(label, 5, y);
    }
    
    // Get frequency bin mapping using shared helper
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return;
    
    const { startBinIndex, binsForBandwidth } = binMapping;
    
    // Use canvas width for bars to match waterfall pixel-for-pixel
    // This ensures perfect alignment between spectrum and waterfall
    const numBars = width;
    const binsPerBar = binsForBandwidth / numBars;
    const barWidth = 1; // Each bar is 1 pixel wide for perfect alignment
    
    // Initialize peaks array if needed
    if (!spectrumPeaks || spectrumPeaks.length !== numBars) {
        spectrumPeaks = new Array(numBars).fill(0);
    }
    
    const peakDecayRate = 0.3; // Pixels per frame to decay (slower = longer hold)
    
    for (let i = 0; i < numBars; i++) {
        // Average the bins for this bar, starting from the correct offset
        // Use floating point for precise bin mapping
        const startBin = startBinIndex + (i * binsPerBar);
        const endBin = startBin + binsPerBar;
        
        let sum = 0;
        let count = 0;
        
        // Average all bins that contribute to this pixel
        for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < dataArray.length; binIndex++) {
            sum += dataArray[binIndex] || 0;
            count++;
        }
        
        const average = count > 0 ? sum / count : 0;
        
        // Calculate bar height (0-255 -> 0-height)
        const barHeight = (average / 255) * height;
        
        // Update peak hold
        if (barHeight > spectrumPeaks[i]) {
            spectrumPeaks[i] = barHeight; // New peak
        } else {
            spectrumPeaks[i] = Math.max(0, spectrumPeaks[i] - peakDecayRate); // Decay
        }
        
        // Color gradient based on signal level (amplitude)
        // Weak signal = green (120°), strong signal = red (0°)
        const levelPercent = average / 255; // 0 to 1
        const hue = 120 * (1 - levelPercent); // 120 (green) to 0 (red)
        spectrumCtx.fillStyle = `hsl(${hue}, 80%, 50%)`;
        
        // Draw bar (1 pixel wide, no gaps)
        const x = i;
        const y = height - barHeight;
        spectrumCtx.fillRect(x, y, barWidth, barHeight);
        
        // Draw peak hold line (1 pixel wide)
        if (spectrumPeaks[i] > 0) {
            const peakY = height - spectrumPeaks[i];
            spectrumCtx.fillStyle = '#ffffff'; // White peak line
            spectrumCtx.fillRect(x, peakY - 1, barWidth, 2); // 2px tall line
        }
    }
    
    // Draw bandpass filter indicators if enabled
    if (bandpassEnabled && bandpassFilters.length > 0) {
        const center = bandpassFilters[0].frequency.value;
        const filterBandwidth = parseInt(document.getElementById('bandpass-width').value);
        const lowFreq = center - filterBandwidth / 2;
        const highFreq = center + filterBandwidth / 2;
        
        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;
        
        // Only draw if within visible range
        if (center >= displayLow && center <= displayHigh) {
            // Draw center line (bright yellow) using shared mapping
            const centerX = frequencyToPixel(center, width);
            spectrumCtx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
            spectrumCtx.lineWidth = 2;
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(centerX, 0);
            spectrumCtx.lineTo(centerX, height);
            spectrumCtx.stroke();
            
            // Draw bandwidth edges (semi-transparent yellow) using shared mapping
            if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                const lowX = frequencyToPixel(lowFreq, width);
                spectrumCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                spectrumCtx.lineWidth = 1;
                spectrumCtx.beginPath();
                spectrumCtx.moveTo(lowX, 0);
                spectrumCtx.lineTo(lowX, height);
                spectrumCtx.stroke();
            }
            
            if (highFreq >= displayLow && highFreq <= displayHigh) {
                const highX = frequencyToPixel(highFreq, width);
                spectrumCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                spectrumCtx.lineWidth = 1;
                spectrumCtx.beginPath();
                spectrumCtx.moveTo(highX, 0);
                spectrumCtx.lineTo(highX, height);
                spectrumCtx.stroke();
            }
            
            // Draw shaded passband region using shared mapping
            if (lowFreq >= displayLow && highFreq <= displayHigh) {
                const lowX = Math.max(0, frequencyToPixel(lowFreq, width));
                const highX = Math.min(width, frequencyToPixel(highFreq, width));
                spectrumCtx.fillStyle = 'rgba(255, 255, 0, 0.1)';
                spectrumCtx.fillRect(lowX, 0, highX - lowX, height);
            }
        }
    }
    // Draw notch filter indicators if enabled
    if (notchEnabled && notchFilters.length > 0) {
        for (let notch of notchFilters) {
            const center = notch.center;
            const filterBandwidth = notch.width;
            const lowFreq = center - filterBandwidth / 2;
            const highFreq = center + filterBandwidth / 2;
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Only draw if within visible range
            if (center >= displayLow && center <= displayHigh) {
                // Draw shaded notch region first (so lines appear on top)
                if (lowFreq >= displayLow && highFreq <= displayHigh) {
                    const lowX = Math.max(0, frequencyToPixel(lowFreq, width));
                    const highX = Math.min(width, frequencyToPixel(highFreq, width));
                    spectrumCtx.fillStyle = 'rgba(255, 0, 0, 0.1)';
                    spectrumCtx.fillRect(lowX, 0, highX - lowX, height);
                }
                
                // Draw center line (bright red)
                const centerX = frequencyToPixel(center, width);
                spectrumCtx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
                spectrumCtx.lineWidth = 2;
                spectrumCtx.beginPath();
                spectrumCtx.moveTo(centerX, 0);
                spectrumCtx.lineTo(centerX, height);
                spectrumCtx.stroke();
                
                // Draw bandwidth edges (semi-transparent red)
                if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                    const lowX = frequencyToPixel(lowFreq, width);
                    spectrumCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    spectrumCtx.lineWidth = 1;
                    spectrumCtx.beginPath();
                    spectrumCtx.moveTo(lowX, 0);
                    spectrumCtx.lineTo(lowX, height);
                    spectrumCtx.stroke();
                }
                
                if (highFreq >= displayLow && highFreq <= displayHigh) {
                    const highX = frequencyToPixel(highFreq, width);
                    spectrumCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    spectrumCtx.lineWidth = 1;
                    spectrumCtx.beginPath();
                    spectrumCtx.moveTo(highX, 0);
                    spectrumCtx.lineTo(highX, height);
                    spectrumCtx.stroke();
                }
            }
        }
    }
    
    
    // Draw frequency labels in Hz
    spectrumCtx.fillStyle = '#000000';
    spectrumCtx.font = '10px monospace';
    spectrumCtx.textAlign = 'center';
    
    // Calculate appropriate label spacing based on bandwidth
    const audioBandwidth = currentBandwidthHigh - currentBandwidthLow;
    let labelStep;
    if (audioBandwidth <= 500) {
        labelStep = 100;
    } else if (audioBandwidth <= 2000) {
        labelStep = 250;
    } else if (audioBandwidth <= 5000) {
        labelStep = 500;
    } else {
        labelStep = 1000;
    }
    
    // Draw labels from low to high frequency using shared mapping
    const startFreq = Math.ceil(currentBandwidthLow / labelStep) * labelStep;
    for (let freq = startFreq; freq <= currentBandwidthHigh; freq += labelStep) {
        const x = frequencyToPixel(freq, width);
        spectrumCtx.fillText(freq + ' Hz', x, height - 5);
    }
}

function updateWaterfall() {
    if (!analyser || !waterfallCtx || !waterfallImageData) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    const width = waterfallCanvas.width;
    const height = waterfallCanvas.height;
    
    // Get frequency bin mapping using shared helper (same as spectrum)
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return;
    
    const { startBinIndex, binsForBandwidth } = binMapping;
    
    // Initialize start time if needed
    if (!waterfallStartTime) {
        waterfallStartTime = Date.now();
        waterfallLineCount = 0;
    }
    
    // Scroll existing waterfall down by 1 pixel (simple approach - no overlays on this canvas)
    if (width > 0 && height > 1) {
        try {
            waterfallCtx.drawImage(waterfallCanvas, 0, 0, width, height - 1, 0, 1, width, height - 1);
        } catch (e) {
            console.log('Skipping waterfall scroll (canvas empty after resize)');
        }
    }
    
    // Increment line counter
    waterfallLineCount++;
    
    // Create new line at top with current spectrum data
    const pixelData = waterfallImageData.data;
    
    // Use floating point for precise bin mapping (same as spectrum)
    const binsPerPixel = binsForBandwidth / width;
    
    for (let x = 0; x < width; x++) {
        // Map x position to frequency bin with precise floating point calculation
        const startBin = startBinIndex + (x * binsPerPixel);
        const endBin = startBin + binsPerPixel;
        
        // Average all bins that contribute to this pixel (same as spectrum)
        let sum = 0;
        let count = 0;
        
        for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < dataArray.length; binIndex++) {
            sum += dataArray[binIndex] || 0;
            count++;
        }
        
        let magnitude = count > 0 ? sum / count : 0;
        
        // Apply contrast threshold first (noise floor suppression)
        // Values below threshold are set to 0, making signals pop out
        if (magnitude < waterfallContrast) {
            magnitude = 0;
        } else {
            // Rescale remaining values to use full range
            // This makes signals above threshold more visible
            magnitude = ((magnitude - waterfallContrast) / (255 - waterfallContrast)) * 255;
        }
        
        // Apply intensity adjustment
        // Negative values: reduce intensity (darken)
        // Positive values: increase intensity (brighten)
        // 0: no change
        if (waterfallIntensity < 0) {
            // Reduce intensity: multiply by (1 + intensity), where intensity is negative
            // -1.0 -> 0x (black), -0.5 -> 0.5x, 0 -> 1x
            magnitude = magnitude * (1 + waterfallIntensity);
        } else if (waterfallIntensity > 0) {
            // Increase intensity: multiply by (1 + intensity * 2)
            // 0 -> 1x, 0.5 -> 2x, 1.0 -> 3x
            magnitude = Math.min(255, magnitude * (1 + waterfallIntensity * 2));
        }
        
        // Convert magnitude to color using a heat map
        // 0 = black, 255 = white, with blue->cyan->green->yellow->red in between
        const color = magnitudeToColor(magnitude);
        
        const offset = x * 4;
        pixelData[offset] = color.r;
        pixelData[offset + 1] = color.g;
        pixelData[offset + 2] = color.b;
        pixelData[offset + 3] = 255; // Alpha
    }
    
    // Draw the new line at the top
    waterfallCtx.putImageData(waterfallImageData, 0, 0);
    
    // Draw semi-transparent black bar at bottom for frequency labels
    // This must be drawn BEFORE filter indicators so they appear on top
    waterfallCtx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    waterfallCtx.fillRect(0, height - 30, width, 30);
    
    // Draw timestamps on left side frequently (about 4 visible on 400px canvas)
    // With 400px height, we want timestamps every ~100 pixels
    // At 60 fps, that's every ~100 frames = ~1.67 seconds
    const linesPerSecond = 60; // Approximate frame rate
    const secondsPerTimestamp = 1.5; // More frequent timestamps
    const linesPerTimestamp = Math.floor(linesPerSecond * secondsPerTimestamp);
    
    if (waterfallLineCount % linesPerTimestamp === 0) {
        const elapsedSeconds = Math.floor((Date.now() - waterfallStartTime) / 1000);
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        const timestamp = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        // Draw timestamp on left with background
        waterfallCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        waterfallCtx.fillRect(0, 0, 50, 16);
        
        waterfallCtx.font = 'bold 11px monospace';
        waterfallCtx.fillStyle = '#ffffff';
        waterfallCtx.strokeStyle = '#000000';
        waterfallCtx.lineWidth = 2;
        waterfallCtx.textAlign = 'left';
        waterfallCtx.textBaseline = 'top';
        
        waterfallCtx.strokeText(timestamp, 3, 2);
        waterfallCtx.fillText(timestamp, 3, 2);
    }
    
    // Draw detailed frequency scale with Hz labels using shared mapping
    waterfallCtx.font = 'bold 13px monospace';
    waterfallCtx.textAlign = 'center';
    waterfallCtx.textBaseline = 'middle';
    
    // Calculate appropriate label spacing based on bandwidth
    const audioBandwidth = currentBandwidthHigh - currentBandwidthLow;
    let labelStep;
    if (audioBandwidth <= 500) {
        labelStep = 100;
    } else if (audioBandwidth <= 2000) {
        labelStep = 250;
    } else if (audioBandwidth <= 5000) {
        labelStep = 500;
    } else {
        labelStep = 1000;
    }
    
    // Major ticks and labels using shared mapping
    const startFreq = Math.ceil(currentBandwidthLow / labelStep) * labelStep;
    for (let freq = startFreq; freq <= currentBandwidthHigh; freq += labelStep) {
        const x = frequencyToPixel(freq, width);
        
        // Draw major tick mark (white)
        waterfallCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        waterfallCtx.fillRect(x - 1, height - 30, 2, 12);
        
        // Draw label with strong contrast
        waterfallCtx.fillStyle = '#ffffff';
        waterfallCtx.strokeStyle = '#000000';
        waterfallCtx.lineWidth = 3;
        
        const label = freq + ' Hz';
        waterfallCtx.strokeText(label, x, height - 10);
        waterfallCtx.fillText(label, x, height - 10);
    }
    
    // Minor ticks (half of label step) using shared mapping
    const minorStep = labelStep / 2;
    waterfallCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    const minorStartFreq = Math.ceil(currentBandwidthLow / minorStep) * minorStep;
    for (let freq = minorStartFreq; freq < currentBandwidthHigh; freq += minorStep) {
        if ((freq - startFreq) % labelStep !== 0) { // Skip major ticks
            const x = frequencyToPixel(freq, width);
            waterfallCtx.fillRect(x, height - 25, 1, 7);
        }
    }
    
    // Clear overlay canvas and redraw all filter indicators
    if (waterfallOverlayCtx) {
        waterfallOverlayCtx.clearRect(0, 0, width, height);
    }
    
    // Draw bandpass filter indicators on overlay canvas
    if (waterfallOverlayCtx && bandpassEnabled && bandpassFilters.length > 0) {
        const center = bandpassFilters[0].frequency.value;
        const filterBandwidth = parseInt(document.getElementById('bandpass-width').value);
        const lowFreq = center - filterBandwidth / 2;
        const highFreq = center + filterBandwidth / 2;
        
        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;
        
        // Only draw if within visible range
        if (center >= displayLow && center <= displayHigh) {
            // Draw center line (bright yellow solid) on overlay
            const centerX = frequencyToPixel(center, width);
            waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
            waterfallOverlayCtx.lineWidth = 2;
            waterfallOverlayCtx.beginPath();
            waterfallOverlayCtx.moveTo(centerX, 0);
            waterfallOverlayCtx.lineTo(centerX, height - 30);
            waterfallOverlayCtx.stroke();
            
            // Draw bandwidth edges (semi-transparent yellow dashed) on overlay
            if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                const lowX = frequencyToPixel(lowFreq, width);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                waterfallOverlayCtx.lineWidth = 1;
                waterfallOverlayCtx.setLineDash([5, 5]);
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(lowX, 0);
                waterfallOverlayCtx.lineTo(lowX, height - 30);
                waterfallOverlayCtx.stroke();
                waterfallOverlayCtx.setLineDash([]);
            }
            
            if (highFreq >= displayLow && highFreq <= displayHigh) {
                const highX = frequencyToPixel(highFreq, width);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                waterfallOverlayCtx.lineWidth = 1;
                waterfallOverlayCtx.setLineDash([5, 5]);
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(highX, 0);
                waterfallOverlayCtx.lineTo(highX, height - 30);
                waterfallOverlayCtx.stroke();
                waterfallOverlayCtx.setLineDash([]);
            }
        }
    }
    
    // Draw notch filter indicators on overlay canvas
    if (waterfallOverlayCtx && notchEnabled && notchFilters.length > 0) {
        for (let notch of notchFilters) {
            const center = notch.center;
            const filterBandwidth = notch.width;
            const lowFreq = center - filterBandwidth / 2;
            const highFreq = center + filterBandwidth / 2;
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Only draw if within visible range
            if (center >= displayLow && center <= displayHigh) {
                // Draw center line (bright red solid) on overlay
                const centerX = frequencyToPixel(center, width);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
                waterfallOverlayCtx.lineWidth = 2;
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(centerX, 0);
                waterfallOverlayCtx.lineTo(centerX, height - 30);
                waterfallOverlayCtx.stroke();
                
                // Draw bandwidth edges (semi-transparent red dashed) on overlay
                if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                    const lowX = frequencyToPixel(lowFreq, width);
                    waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    waterfallOverlayCtx.lineWidth = 1;
                    waterfallOverlayCtx.setLineDash([5, 5]);
                    waterfallOverlayCtx.beginPath();
                    waterfallOverlayCtx.moveTo(lowX, 0);
                    waterfallOverlayCtx.lineTo(lowX, height - 30);
                    waterfallOverlayCtx.stroke();
                    waterfallOverlayCtx.setLineDash([]);
                }
                
                if (highFreq >= displayLow && highFreq <= displayHigh) {
                    const highX = frequencyToPixel(highFreq, width);
                    waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    waterfallOverlayCtx.lineWidth = 1;
                    waterfallOverlayCtx.setLineDash([5, 5]);
                    waterfallOverlayCtx.beginPath();
                    waterfallOverlayCtx.moveTo(highX, 0);
                    waterfallOverlayCtx.lineTo(highX, height - 30);
                    waterfallOverlayCtx.stroke();
                    waterfallOverlayCtx.setLineDash([]);
                }
            }
        }
    }
}



// Convert magnitude (0-255) to heat map color
function magnitudeToColor(magnitude) {
    // Normalize to 0-1
    const normalized = magnitude / 255;
    
    // Heat map: black -> blue -> cyan -> green -> yellow -> red -> white
    let r, g, b;
    
    if (normalized < 0.2) {
        // Black to blue
        const t = normalized / 0.2;
        r = 0;
        g = 0;
        b = Math.floor(t * 255);
    } else if (normalized < 0.4) {
        // Blue to cyan
        const t = (normalized - 0.2) / 0.2;
        r = 0;
        g = Math.floor(t * 255);
        b = 255;
    } else if (normalized < 0.6) {
        // Cyan to green
        const t = (normalized - 0.4) / 0.2;
        r = 0;
        g = 255;
        b = Math.floor((1 - t) * 255);
    } else if (normalized < 0.8) {
        // Green to yellow
        const t = (normalized - 0.6) / 0.2;
        r = Math.floor(t * 255);
        g = 255;
        b = 0;
    } else if (normalized < 0.95) {
        // Yellow to red
        const t = (normalized - 0.8) / 0.15;
        r = 255;
        g = Math.floor((1 - t) * 255);
        b = 0;
    } else {
        // Red to white (very strong signals)
        const t = (normalized - 0.95) / 0.05;
        r = 255;
        g = Math.floor(t * 255);
        b = Math.floor(t * 255);
    }
    
    return { r, g, b };
}

// Send periodic keepalive
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 30000); // Every 30 seconds

// Update FFT size
function updateFFTSize() {
    if (!analyser) return;
    
    const fftSize = parseInt(document.getElementById('fft-size').value);
    analyser.fftSize = fftSize;
    
    log(`FFT size changed to ${fftSize} (${(fftSize / 2).toLocaleString()} frequency bins)`);
}

// Update scroll rate
function updateScrollRate() {
    const scrollRate = parseInt(document.getElementById('scroll-rate').value);
    waterfallUpdateInterval = scrollRate;
    
    const fps = Math.round(1000 / scrollRate);
    log(`Waterfall scroll rate changed to ${fps} fps`);
}

// Update waterfall intensity
function updateWaterfallIntensity() {
    const intensity = parseFloat(document.getElementById('waterfall-intensity').value);
    waterfallIntensity = intensity;
    
    // Format display value with + or - sign
    const displayValue = intensity >= 0 ? '+' + intensity.toFixed(2) : intensity.toFixed(2);
    document.getElementById('waterfall-intensity-value').textContent = displayValue;
    
    log(`Waterfall intensity changed to ${displayValue}`);
}

// Update waterfall contrast (noise floor threshold)
function updateWaterfallContrast() {
    const contrast = parseInt(document.getElementById('waterfall-contrast').value);
    waterfallContrast = contrast;
    document.getElementById('waterfall-contrast-value').textContent = contrast;
    
    log(`Waterfall contrast changed to ${contrast} (noise floor suppression)`);
}

// Update oscilloscope zoom/timebase
function updateOscilloscopeZoom() {
    const sliderValue = parseInt(document.getElementById('oscilloscope-zoom').value);
    oscilloscopeZoom = sliderValue;
    
    // Calculate actual time window being displayed
    // Invert slider so higher value = slower timebase (more time displayed)
    // Slider 1 = fast (zoomed in), Slider 100 = slow (full buffer)
    if (analyser && audioContext) {
        const bufferLength = analyser.fftSize;
        const sampleRate = audioContext.sampleRate;
        const totalTimeMs = (bufferLength / sampleRate) * 1000;
        
        // Invert the zoom: slider 1 -> divide by 100, slider 100 -> divide by 1
        const invertedZoom = 101 - sliderValue;
        const displayedTimeMs = totalTimeMs / invertedZoom;
        
        // Format as ms or µs depending on size
        let timeDisplay;
        if (displayedTimeMs >= 1) {
            timeDisplay = displayedTimeMs.toFixed(1) + ' ms';
        } else {
            timeDisplay = (displayedTimeMs * 1000).toFixed(0) + ' µs';
        }
        
        document.getElementById('oscilloscope-zoom-value').textContent = timeDisplay;
        log(`Oscilloscope timebase changed to ${timeDisplay} per division`);
    } else {
        document.getElementById('oscilloscope-zoom-value').textContent = sliderValue + 'x';
    }
}

// Send periodic keepalive
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 30000); // Every 30 seconds

// Equalizer enabled state
let equalizerEnabled = false;

// Initialize equalizer filters
function initializeEqualizer() {
    if (!audioContext) return;
    
    const frequencies = [60, 170, 310, 600, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000];
    
    // Create biquad filters for each frequency band
    frequencies.forEach(freq => {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.0; // Bandwidth
        filter.gain.value = 0; // Start at 0 dB
        eqFilters.push(filter);
    });
    
    // Create analyser to monitor equalizer output for clipping detection
    eqAnalyser = audioContext.createAnalyser();
    eqAnalyser.fftSize = 2048;
    eqAnalyser.smoothingTimeConstant = 0;
    
    log('12-band equalizer initialized with clipping detection');
}

// Toggle equalizer on/off
function toggleEqualizer() {
    const checkbox = document.getElementById('equalizer-enable');
    const controls = document.getElementById('equalizer-controls');
    equalizerEnabled = checkbox.checked;
    
    if (equalizerEnabled) {
        controls.style.display = 'block';
        log('12-band equalizer enabled');
    } else {
        controls.style.display = 'none';
        log('12-band equalizer disabled');
    }
}

// Update equalizer when sliders change
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
}

// Reset equalizer to flat response
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
    
    log('Equalizer reset to flat response');
}

// Toggle bandpass filter on/off
function toggleBandpassFilter() {
    const checkbox = document.getElementById('bandpass-enable');
    const controls = document.getElementById('bandpass-controls');
    bandpassEnabled = checkbox.checked;
    
    if (bandpassEnabled) {
        controls.style.display = 'block';
        if (bandpassFilters.length === 0 && audioContext) {
            initializeBandpassFilter();
        }
        log('Bandpass filter enabled (4-stage cascade, 48 dB/octave)');
    } else {
        controls.style.display = 'none';
        log('Bandpass filter disabled');
    }
}

// Initialize bandpass filter (4 cascaded stages for 48 dB/octave rolloff)
function initializeBandpassFilter() {
    if (!audioContext) return;
    
    // Disconnect and clear any existing filters completely
    for (let filter of bandpassFilters) {
        try {
            filter.disconnect();
        } catch (e) {
            // Ignore errors if already disconnected
        }
    }
    bandpassFilters = [];
    
    // Get initial values from sliders
    const center = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    
    // Calculate Q value - use a LOW Q for each stage to avoid resonance/ringing
    // For cascaded filters, each stage multiplies the effect, so use very low Q
    // Q = center / width gives the basic bandwidth, but we need much lower for 4 stages
    const Q = Math.max(0.7, center / (width * 4)); // Divide by 4 for very gentle filtering per stage
    
    // Create 4 cascaded bandpass filters for steep rolloff
    // Each stage adds 12 dB/octave, so 4 stages = 48 dB/octave
    // Note: Do NOT chain them permanently here - they will be chained per-buffer
    for (let i = 0; i < 4; i++) {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = center;
        filter.Q.value = Q;
        
        bandpassFilters.push(filter);
    }
    
    log(`Bandpass filter initialized: ${center} Hz ± ${width/2} Hz, Q=${Q.toFixed(2)}, 4-stage cascade (48 dB/octave rolloff)`);
}

// Update bandpass filter parameters
function updateBandpassFilter() {
    if (bandpassFilters.length === 0) {
        if (audioContext) {
            initializeBandpassFilter();
        }
        return;
    }
    
    const center = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    const Q = Math.max(0.7, center / (width * 4)); // Low Q for cascaded filters to avoid resonance
    
    // Update all filter stages with same parameters
    for (let filter of bandpassFilters) {
        filter.frequency.value = center;
        filter.Q.value = Q;
    }
    
    // Update display values
    document.getElementById('bandpass-center-value').textContent = center + ' Hz';
    document.getElementById('bandpass-width-value').textContent = width + ' Hz';
    
    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {  // 5% chance to log
        log(`Bandpass: ${center} Hz ± ${width/2} Hz (Q=${Q.toFixed(2)}, 4-stage)`);
    }
    
    // Update CW decoder frequency if enabled
    if (cwDecoder && cwDecoder.enabled) {
        updateCWDecoderFrequency(center);
    }
}

// Notch filter functions
function addManualNotch() {
    // Add a notch at the center of the current bandwidth
    const centerFreq = Math.round((currentBandwidthLow + currentBandwidthHigh) / 2);
    addNotchFilter(centerFreq);
}

function addNotchFilter(centerFreq) {
    if (!audioContext) {
        log('Audio context not initialized', 'error');
        return;
    }
    
    if (notchFilters.length >= MAX_NOTCHES) {
        log(`Maximum of ${MAX_NOTCHES} notch filters reached. Remove one first.`, 'error');
        return;
    }
    
    // Default bandwidth and gain for new notch
    const defaultWidth = 100; // Hz
    const defaultGain = -40; // dB (negative = attenuation)
    
    // Create notch filter object with peaking filter for adjustable gain
    const notch = {
        center: centerFreq,
        width: defaultWidth,
        gain: defaultGain,
        filters: []
    };
    
    // Create 4 cascaded peaking filters with negative gain for adjustable notch depth
    // Peaking filters allow gain control, unlike pure notch filters
    // For peaking filters, higher Q = narrower bandwidth
    // Q = center_freq / bandwidth gives the correct relationship
    // 4 stages match the bandpass filter for consistency
    for (let i = 0; i < 4; i++) {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = centerFreq;
        // Use higher Q for narrower, more effective notch
        filter.Q.value = Math.max(1.0, centerFreq / defaultWidth);
        filter.gain.value = defaultGain / 4; // Split gain across 4 stages
        notch.filters.push(filter);
    }
    
    notchFilters.push(notch);
    
    // Enable notch filtering if not already enabled
    if (!notchEnabled) {
        const checkbox = document.getElementById('notch-enable');
        if (checkbox) {
            checkbox.checked = true;
            toggleNotchFilter();
        }
    }
    
    // Update UI to show the new notch
    updateNotchFilterUI();
    
    log(`Notch filter added at ${centerFreq} Hz (±${defaultWidth/2} Hz, ${defaultGain} dB, 4-stage cascade)`);
}

function removeNotchFilter(index) {
    if (index < 0 || index >= notchFilters.length) return;
    
    const notch = notchFilters[index];
    
    // Disconnect all filters in this notch
    for (let filter of notch.filters) {
        try {
            filter.disconnect();
        } catch (e) {
            // Ignore if already disconnected
        }
    }
    
    notchFilters.splice(index, 1);
    updateNotchFilterUI();
    
    log(`Notch filter removed from ${notch.center} Hz`);
}

function updateNotchFilterParams(index) {
    if (index < 0 || index >= notchFilters.length) return;
    
    const notch = notchFilters[index];
    const centerInput = document.getElementById(`notch-center-${index}`);
    const widthInput = document.getElementById(`notch-width-${index}`);
    const gainInput = document.getElementById(`notch-gain-${index}`);
    
    if (centerInput && widthInput && gainInput) {
        const center = parseInt(centerInput.value);
        const width = parseInt(widthInput.value);
        const gain = parseInt(gainInput.value);
        // Higher Q = narrower bandwidth for peaking filters
        const Q = Math.max(1.0, center / width);
        
        notch.center = center;
        notch.width = width;
        notch.gain = gain;
        
        // Update all filter stages in this notch
        for (let filter of notch.filters) {
            filter.frequency.value = center;
            filter.Q.value = Q;
            filter.gain.value = gain / 4; // Split gain across 4 stages
        }
        
        // Update display values
        document.getElementById(`notch-center-value-${index}`).textContent = center + ' Hz';
        document.getElementById(`notch-width-value-${index}`).textContent = width + ' Hz';
        document.getElementById(`notch-gain-value-${index}`).textContent = gain + ' dB';
    }
}

function toggleNotchFilter() {
    const checkbox = document.getElementById('notch-enable');
    const controls = document.getElementById('notch-controls');
    notchEnabled = checkbox.checked;
    
    if (notchEnabled) {
        controls.style.display = 'block';
        updateNotchFilterUI();
        log('Notch filters enabled');
    } else {
        controls.style.display = 'none';
        log('Notch filters disabled');
    }
}

function updateNotchFilterUI() {
    const container = document.getElementById('notch-list');
    if (!container) return;
    
    // Clear existing UI
    container.innerHTML = '';
    
    if (notchFilters.length === 0) {
        container.innerHTML = '<p style="color: #888; font-style: italic; margin: 10px 0;">Right-click on spectrum or waterfall to add notch filters (max 5)</p>';
        return;
    }
    
    // Get display range (accounts for CW offset)
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    const displayLow = cwOffset + currentBandwidthLow;
    const displayHigh = cwOffset + currentBandwidthHigh;
    
    // Create UI for each notch filter
    notchFilters.forEach((notch, index) => {
        const notchDiv = document.createElement('div');
        notchDiv.className = 'notch-filter-item';
        notchDiv.innerHTML = `
            <div class="notch-filter-header">
                <span class="notch-filter-title">Notch ${index + 1}</span>
                <button onclick="removeNotchFilter(${index})" class="notch-remove-btn">✕</button>
            </div>
            <div class="control-group">
                <label for="notch-center-${index}">Center: <span id="notch-center-value-${index}">${notch.center} Hz</span></label>
                <input type="range" id="notch-center-${index}" min="${displayLow}" max="${displayHigh}" value="${notch.center}" step="10" oninput="updateNotchFilterParams(${index})">
            </div>
            <div class="control-group">
                <label for="notch-width-${index}">Width: <span id="notch-width-value-${index}">${notch.width} Hz</span></label>
                <input type="range" id="notch-width-${index}" min="20" max="500" value="${notch.width}" step="10" oninput="updateNotchFilterParams(${index})">
            </div>
            <div class="control-group">
                <label for="notch-gain-${index}">Reduction: <span id="notch-gain-value-${index}">${notch.gain} dB</span></label>
                <input type="range" id="notch-gain-${index}" min="-60" max="0" value="${notch.gain}" step="1" oninput="updateNotchFilterParams(${index})">
            </div>
        `;
        container.appendChild(notchDiv);
    });
    
    // Update count display
    const countDisplay = document.getElementById('notch-count');
    if (countDisplay) {
        countDisplay.textContent = `${notchFilters.length}/${MAX_NOTCHES}`;
    }
}

function clearAllNotches() {
    // Disconnect all filters
    for (let notch of notchFilters) {
        for (let filter of notch.filters) {
            try {
                filter.disconnect();
            } catch (e) {
                // Ignore if already disconnected
            }
        }
    }
    
    notchFilters = [];
    updateNotchFilterUI();
    log('All notch filters cleared');
}
    
    // CW Decoder control functions
    function toggleCWDecoder() {
        const checkbox = document.getElementById('cw-decoder-enable');
        const controls = document.getElementById('cw-decoder-controls');
        
        if (checkbox.checked) {
            controls.style.display = 'block';
            
            // Initialize decoder if not already done
            if (!cwDecoder && audioContext && analyser) {
                const centerFreq = bandpassEnabled && bandpassFilters.length > 0
                    ? bandpassFilters[0].frequency.value
                    : 800;
                initializeCWDecoder(audioContext, analyser, centerFreq);
            }
            
            // Enable decoder
            startCWDecoding();
            log('CW Decoder enabled');
        } else {
            controls.style.display = 'none';
            
            // Disable decoder
            stopCWDecoding();
            log('CW Decoder disabled');
        }
    }
    
    function updateCWDecoderWPM() {
        const wpm = parseInt(document.getElementById('cw-wpm').value);
        document.getElementById('cw-wpm-value').textContent = wpm;
        updateCWDecoderWPM(wpm);
    }
    
    function updateCWDecoderThreshold() {
        const threshold = parseFloat(document.getElementById('cw-threshold').value);
        document.getElementById('cw-threshold-value').textContent = threshold.toFixed(2);
        updateCWDecoderThreshold(threshold);
    }

// Initialize compressor
function initializeCompressor() {
    if (!audioContext) return;
    
    // Create DynamicsCompressorNode
    compressor = audioContext.createDynamicsCompressor();
    
    // Set default parameters (good for voice/SSB)
    compressor.threshold.value = -24;  // dB - signals above this are compressed
    compressor.knee.value = 30;        // dB - smooth transition (soft knee)
    compressor.ratio.value = 12;       // Compression ratio (12:1 is aggressive AGC)
    compressor.attack.value = 0.003;   // seconds - how fast to compress (3ms)
    compressor.release.value = 0.25;   // seconds - how fast to release (250ms)
    
    // Create makeup gain node
    compressorMakeupGain = audioContext.createGain();
    compressorMakeupGain.gain.value = 1.0; // 0 dB default (no makeup gain)
    
    // Create analyser to monitor compressor output for clipping detection
    compressorAnalyser = audioContext.createAnalyser();
    compressorAnalyser.fftSize = 2048;
    compressorAnalyser.smoothingTimeConstant = 0;
    
    log('Audio compressor initialized (AGC mode with makeup gain and clipping detection)');
}

// Toggle compressor on/off
function toggleCompressor() {
    const checkbox = document.getElementById('compressor-enable');
    const controls = document.getElementById('compressor-controls');
    compressorEnabled = checkbox.checked;
    
    if (compressorEnabled) {
        controls.style.display = 'block';
        if (!compressor && audioContext) {
            initializeCompressor();
        }
        log('Audio compressor enabled (AGC)');
    } else {
        controls.style.display = 'none';
        log('Audio compressor disabled');
    }
}

// Update compressor parameters
function updateCompressor() {
    if (!compressor) {
        if (audioContext) {
            initializeCompressor();
        }
        return;
    }
    
    const threshold = parseFloat(document.getElementById('compressor-threshold').value);
    const ratio = parseFloat(document.getElementById('compressor-ratio').value);
    const attack = parseFloat(document.getElementById('compressor-attack').value);
    const release = parseFloat(document.getElementById('compressor-release').value);
    const makeupGainDb = parseFloat(document.getElementById('compressor-makeup-gain').value);
    
    // Update compressor parameters
    compressor.threshold.value = threshold;
    compressor.ratio.value = ratio;
    compressor.attack.value = attack;
    compressor.release.value = release;
    
    // Update makeup gain (convert dB to linear gain)
    if (compressorMakeupGain) {
        compressorMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
    }
    
    // Update display values
    document.getElementById('compressor-threshold-value').textContent = threshold + ' dB';
    document.getElementById('compressor-ratio-value').textContent = ratio.toFixed(1) + ':1';
    document.getElementById('compressor-attack-value').textContent = attack.toFixed(3) + ' s';
    document.getElementById('compressor-release-value').textContent = release.toFixed(2) + ' s';
    document.getElementById('compressor-makeup-gain-value').textContent = '+' + makeupGainDb + ' dB';
    
    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {  // 5% chance to log
        log(`Compressor: ${threshold} dB threshold, ${ratio}:1 ratio, ${(attack*1000).toFixed(0)}ms attack, ${(release*1000).toFixed(0)}ms release, +${makeupGainDb} dB makeup gain`);
    }
}

// Reset compressor to default values
function resetCompressor() {
    if (!compressor) {
        if (audioContext) {
            initializeCompressor();
        }
        return;
    }
    
    // Default values (good for voice/SSB)
    const defaultThreshold = -24;
    const defaultRatio = 12;
    const defaultAttack = 0.003;
    const defaultRelease = 0.25;
    const defaultMakeupGain = 0;
    
    // Update sliders
    document.getElementById('compressor-threshold').value = defaultThreshold;
    document.getElementById('compressor-ratio').value = defaultRatio;
    document.getElementById('compressor-attack').value = defaultAttack;
    document.getElementById('compressor-release').value = defaultRelease;
    document.getElementById('compressor-makeup-gain').value = defaultMakeupGain;
    
    // Update display values
    document.getElementById('compressor-threshold-value').textContent = defaultThreshold + ' dB';
    document.getElementById('compressor-ratio-value').textContent = defaultRatio.toFixed(1) + ':1';
    document.getElementById('compressor-attack-value').textContent = defaultAttack.toFixed(3) + ' s';
    document.getElementById('compressor-release-value').textContent = defaultRelease.toFixed(2) + ' s';
    document.getElementById('compressor-makeup-gain-value').textContent = '+' + defaultMakeupGain + ' dB';
    
    // Update compressor parameters
    compressor.threshold.value = defaultThreshold;
    compressor.ratio.value = defaultRatio;
    compressor.attack.value = defaultAttack;
    compressor.release.value = defaultRelease;
    
    // Update makeup gain
    if (compressorMakeupGain) {
        compressorMakeupGain.gain.value = Math.pow(10, defaultMakeupGain / 20);
    }
    
    log('Compressor reset to default values');
}

// Low-pass filter functions (removed - using radiod bandwidth instead)
function initializeLowpassFilter() {
    // No longer used - bandwidth is controlled by radiod
    return;
}

function updateLowpassFilter() {
    // No longer used - bandwidth is controlled by radiod
    return;
}

// Spectrum Display (Full-band FFT from radiod)
let spectrumDisplay = null;
let lastZoomTime = 0;
const ZOOM_THROTTLE_MS = 1000;

// Initialize spectrum display on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initialize spectrum display
    try {
        spectrumDisplay = new SpectrumDisplay('spectrum-display-canvas', {
            minDb: -120,
            maxDb: -20,
            colorScheme: 'jet',
            intensity: 0.20,  // Default +0.20 for brighter display
            contrast: 70,     // Default 70 for more noise suppression
            showGrid: true,
            showLabels: true,
            onConnect: () => {
                // Spectrum status display removed from UI
                log('Spectrum display connected');
            },
            onDisconnect: () => {
                // Spectrum status display removed from UI
                log('Spectrum display disconnected');
            },
            onConfig: (config) => {
                log(`Spectrum: ${config.binCount} bins @ ${config.binBandwidth} Hz, ${formatFrequency(config.centerFreq)}`);
                // Update cursor with current frequency input value
                updateSpectrumCursor();
            },
            onFrequencyClick: (freq) => {
                // When user clicks on spectrum, tune to that frequency
                document.getElementById('frequency').value = Math.round(freq);
                
                // Update cursor immediately
                updateSpectrumCursor();
                
                // Connect if not already connected
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    connect();
                    log(`Connecting and tuning to ${formatFrequency(freq)} from spectrum click`);
                } else {
                    autoTune();
                    log(`Tuned to ${formatFrequency(freq)} from spectrum click`);
                }
            }
        });
        
        // Connect to spectrum WebSocket
        spectrumDisplay.connect();
        
        // Set initial cursor position
        updateSpectrumCursor();
        
        // Update cursor when frequency input changes
        const freqInput = document.getElementById('frequency');
        if (freqInput) {
            freqInput.addEventListener('input', updateSpectrumCursor);
            freqInput.addEventListener('change', updateSpectrumCursor);
        }
    } catch (err) {
        console.error('Failed to initialize spectrum display:', err);
        log('Failed to initialize spectrum display: ' + err.message, 'error');
    }
});

// Update spectrum cursor to show current frequency
function updateSpectrumCursor() {
    if (!spectrumDisplay) return;
    
    const freqInput = document.getElementById('frequency');
    if (freqInput) {
        const freq = parseInt(freqInput.value);
        if (!isNaN(freq)) {
            spectrumDisplay.updateConfig({
                tunedFreq: freq,
                bandwidthLow: currentBandwidthLow,
                bandwidthHigh: currentBandwidthHigh
            });
        }
    }
}

// Spectrum display control functions
function updateSpectrumColorScheme() {
    if (!spectrumDisplay) return;
    
    const scheme = document.getElementById('spectrum-colorscheme').value;
    spectrumDisplay.updateConfig({ colorScheme: scheme });
    log(`Spectrum color scheme changed to ${scheme}`);
}

function updateSpectrumRange() {
    if (!spectrumDisplay) return;
    
    const minDb = parseInt(document.getElementById('spectrum-min-db').value);
    const maxDb = parseInt(document.getElementById('spectrum-max-db').value);
    
    document.getElementById('spectrum-min-db-value').textContent = minDb;
    document.getElementById('spectrum-max-db-value').textContent = maxDb;
    
    spectrumDisplay.updateConfig({ minDb, maxDb });
}

function updateSpectrumGrid() {
    if (!spectrumDisplay) return;
    
    const showGrid = document.getElementById('spectrum-grid').checked;
    spectrumDisplay.updateConfig({ showGrid });
}

function updateSpectrumIntensity() {
    if (!spectrumDisplay) return;
    
    const intensity = parseFloat(document.getElementById('spectrum-intensity').value);
    
    // Format display value with + or - sign
    const displayValue = intensity >= 0 ? '+' + intensity.toFixed(2) : intensity.toFixed(2);
    document.getElementById('spectrum-intensity-value').textContent = displayValue;
    
    spectrumDisplay.updateConfig({ intensity });
    log(`Spectrum intensity changed to ${displayValue}`);
}

function updateSpectrumContrast() {
    if (!spectrumDisplay) return;
    
    const contrast = parseInt(document.getElementById('spectrum-contrast').value);
    document.getElementById('spectrum-contrast-value').textContent = contrast;
    
    spectrumDisplay.updateConfig({ contrast });
    log(`Spectrum contrast changed to ${contrast} (noise floor suppression)`);
}

// Spectrum zoom control functions
function spectrumZoomIn() {
    if (!spectrumDisplay) return;
    
    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;
    
    spectrumDisplay.zoomIn();
    updateSpectrumZoomDisplay();
    log(`Spectrum zoomed in to ${spectrumDisplay.zoomLevel.toFixed(1)}×`);
}

function spectrumZoomOut() {
    if (!spectrumDisplay) return;
    
    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;
    
    spectrumDisplay.zoomOut();
    updateSpectrumZoomDisplay();
    log(`Spectrum zoomed out to ${spectrumDisplay.zoomLevel.toFixed(1)}×`);
}

function spectrumResetZoom() {
    if (!spectrumDisplay) return;
    
    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;
    
    spectrumDisplay.resetZoom();
    updateSpectrumZoomDisplay();
    log('Spectrum zoom reset to full view');
}

function updateSpectrumZoomDisplay() {
    if (!spectrumDisplay) return;
    
    const zoomLevel = spectrumDisplay.zoomLevel;
    const displayText = zoomLevel === 1 ? '1×' : zoomLevel.toFixed(1) + '×';
    const zoomElement = document.getElementById('spectrum-zoom-level');
    if (zoomElement) {
        zoomElement.textContent = displayText;
    }
}
