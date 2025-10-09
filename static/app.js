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
let eqMakeupGain = null; // GainNode for makeup gain after EQ
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
let squelchEnabled = false; // Track if squelch is enabled
let squelchThreshold = -35; // Threshold in dB
let squelchHysteresis = 3; // Hysteresis in dB (prevents rapid open/close)
let squelchAttack = 0.020; // Attack time in seconds (20ms) - how fast gate opens
let squelchRelease = 0.500; // Release time in seconds (500ms) - how fast gate closes
let squelchGate = null; // GainNode used as gate
let squelchAnalyser = null; // Analyser to measure signal level
let squelchOpen = true; // Track if gate is currently open
let squelchCurrentLevel = -Infinity; // Current signal level in dB
let squelchTargetGain = 1.0; // Target gain value (0 = closed, 1 = open)
let noiseReductionEnabled = false; // Track if noise reduction is enabled
let noiseReductionProcessor = null; // ScriptProcessor for noise reduction
let noiseReductionStrength = 40; // Noise reduction strength (0-100%)
let noiseReductionFloor = 10; // Spectral floor (0-10%)
let nr2 = null; // NR2 processor instance

// Amateur radio band ranges (in Hz) - UK RSGB allocations
const bandRanges = {
    '80m': { min: 3500000, max: 3800000 },   // UK: 3.5-3.8 MHz
    '40m': { min: 7000000, max: 7200000 },   // UK: 7.0-7.2 MHz
    '30m': { min: 10100000, max: 10150000 }, // UK: 10.1-10.15 MHz (WARC band)
    '20m': { min: 14000000, max: 14350000 }, // UK: 14.0-14.35 MHz
    '17m': { min: 18068000, max: 18168000 }, // UK: 18.068-18.168 MHz (WARC band)
    '15m': { min: 21000000, max: 21450000 }, // UK: 21.0-21.45 MHz
    '12m': { min: 24890000, max: 24990000 }, // UK: 24.89-24.99 MHz (WARC band)
    '10m': { min: 28000000, max: 29700000 }  // UK: 28.0-29.7 MHz
};

// Bookmarks (expose on window for spectrum-display.js access)
let bookmarks = [];
window.bookmarks = bookmarks;

// Bookmark positions for hover detection (expose on window for spectrum-display.js access)
let bookmarkPositions = [];
window.bookmarkPositions = bookmarkPositions;

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
    
    // Set audio visualization as enabled by default (since it's visible)
    audioVisualizationEnabled = true;
    
    // Hide compact VU meter since full visualization is shown
    const compactVU = document.getElementById('vu-meter-compact');
    if (compactVU) compactVU.style.display = 'none';
    
    // Initialize canvas sizes for visible audio visualization
    setTimeout(() => {
        if (spectrumCanvas && spectrumCtx) {
            const rect = spectrumCanvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                spectrumCanvas.width = Math.floor(rect.width);
                spectrumCanvas.height = Math.floor(rect.height);
            }
        }
        
        if (waterfallCanvas && waterfallCtx) {
            const rect = waterfallCanvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const newWidth = Math.max(1, Math.floor(rect.width));
                const newHeight = Math.max(1, Math.floor(rect.height));
                
                waterfallCanvas.width = newWidth;
                waterfallCanvas.height = newHeight;
                
                // Also set overlay canvas to match
                if (waterfallOverlayCanvas) {
                    waterfallOverlayCanvas.width = newWidth;
                    waterfallOverlayCanvas.height = newHeight;
                }
                
                waterfallCtx.fillStyle = '#000';
                waterfallCtx.fillRect(0, 0, newWidth, newHeight);
                
                if (newWidth > 0) {
                    waterfallImageData = waterfallCtx.createImageData(newWidth, 1);
                }
            }
        }
        
        if (oscilloscopeCanvas && oscilloscopeCtx) {
            const rect = oscilloscopeCanvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                oscilloscopeCanvas.width = Math.floor(rect.width);
                oscilloscopeCanvas.height = Math.floor(rect.height);
            }
        }
    }, 100);
    
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
            
            // For LSB mode, convert negative frequency to positive for slider
            const sliderFreq = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? Math.abs(clampedFreq) : clampedFreq;
            
            console.log(`Spectrum click: freq=${freq}, displayLow=${displayLow}, displayHigh=${displayHigh}, clampedFreq=${clampedFreq}, sliderFreq=${sliderFreq}`);
            
            // Enable bandpass filter if not already enabled
            if (!bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = true;
                    toggleBandpassFilter();
                }
            }
            
            // Update bandpass center frequency
            const centerSlider = document.getElementById('bandpass-center');
            if (centerSlider) {
                console.log(`Before setting: slider min=${centerSlider.min}, max=${centerSlider.max}, value=${centerSlider.value}`);
                centerSlider.value = sliderFreq;
                console.log(`After setting: slider value=${centerSlider.value}`);
                // Call updateBandpassFilter to update both display and filters
                updateBandpassFilter();
            }
            
            log(`Bandpass center adjusted to ${sliderFreq} Hz from spectrum click`);
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
            
            // For LSB mode, convert negative frequency to positive for slider
            const sliderFreq = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? Math.abs(clampedFreq) : clampedFreq;
            
            console.log(`Waterfall click: freq=${freq}, displayLow=${displayLow}, displayHigh=${displayHigh}, clampedFreq=${clampedFreq}, sliderFreq=${sliderFreq}`);
            
            // Enable bandpass filter if not already enabled
            if (!bandpassEnabled) {
                const checkbox = document.getElementById('bandpass-enable');
                if (checkbox) {
                    checkbox.checked = true;
                    toggleBandpassFilter();
                }
            }
            
            // Update bandpass center frequency
            const centerSlider = document.getElementById('bandpass-center');
            if (centerSlider) {
                console.log(`Before setting: slider min=${centerSlider.min}, max=${centerSlider.max}, value=${centerSlider.value}`);
                centerSlider.value = sliderFreq;
                console.log(`After setting: slider value=${centerSlider.value}`);
                // Call updateBandpassFilter to update both display and filters
                updateBandpassFilter();
            }
            
            log(`Bandpass center adjusted to ${sliderFreq} Hz from waterfall click`);
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
                    
                    // Also resize overlay canvas to match
                    if (waterfallOverlayCanvas) {
                        waterfallOverlayCanvas.width = newWidth;
                        waterfallOverlayCanvas.height = newHeight;
                    }
                    
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
            
            // Initialize squelch (must be first in chain)
            initializeSquelch();
            
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
    squelchGate = null;
    squelchAnalyser = null;
    noiseReductionProcessor = null;
    noiseReductionEnabled = false;
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

// Opus decoder context (will be initialized when needed)
let opusDecoder = null;
let opusDecoderInitialized = false;
let opusDecoderFailed = false;

// Initialize Opus decoder
async function initOpusDecoder(sampleRate, channels) {
    console.log('initOpusDecoder called:', sampleRate, 'Hz,', channels, 'channels');
    
    if (opusDecoderFailed) {
        console.log('Decoder previously failed, skipping');
        return false;
    }
    
    if (opusDecoderInitialized) {
        console.log('Decoder already initialized');
        return true;
    }
    
    // Check if OpusDecoder library is available
    console.log('Checking for OpusDecoder:', typeof OpusDecoder);
    if (typeof OpusDecoder === 'undefined') {
        console.error('OpusDecoder library not loaded');
        log('ERROR: Opus decoder library failed to load from CDN', 'error');
        log('Please disable Opus in config.yaml: set audio.opus.enabled: false', 'error');
        opusDecoderFailed = true;
        return false;
    }
    
    try {
        console.log('Creating OpusDecoder instance...');
        opusDecoder = new OpusDecoder({
            sampleRate: sampleRate,
            channels: channels
        });
        console.log('Waiting for decoder.ready...');
        await opusDecoder.ready;
        opusDecoderInitialized = true;
        console.log('Opus decoder initialized successfully');
        log(`Opus decoder initialized for ${sampleRate} Hz, ${channels} channel(s)`);
        return true;
    } catch (e) {
        console.error('Failed to initialize Opus decoder:', e);
        log('Opus decoder initialization failed: ' + e.message, 'error');
        log('Please disable Opus in config.yaml: set audio.opus.enabled: false', 'error');
        opusDecoderFailed = true;
        return false;
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
async function handleAudio(msg) {
    if (!audioContext) {
        return;
    }
    
    try {
        const audioFormat = msg.audioFormat || 'pcm'; // Default to PCM if not specified
        
        if (audioFormat === 'opus') {
            // Handle Opus-encoded audio
            await handleOpusAudio(msg);
        } else {
            // Handle PCM audio (original behavior)
            handlePCMAudio(msg);
        }
    } catch (e) {
        console.error('Failed to process audio:', e);
    }
}

// Handle PCM audio data
function handlePCMAudio(msg) {
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
}

// Handle Opus-encoded audio data
async function handleOpusAudio(msg) {
    console.log('handleOpusAudio called, packet size:', msg.data.length);
    
    // Initialize Opus decoder if needed
    const decoderReady = await initOpusDecoder(msg.sampleRate, msg.channels || 1);
    
    if (!decoderReady || !opusDecoder) {
        console.error('Decoder not ready');
        // Decoder failed to initialize - error already logged
        // Silently drop this packet to avoid spam
        return;
    }
    
    console.log('Decoder ready, decoding packet...');
    
    try {
        // Decode base64 Opus data
        const binaryString = atob(msg.data);
        const opusPacket = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            opusPacket[i] = binaryString.charCodeAt(i);
        }
        
        console.log('Opus packet size:', opusPacket.length, 'bytes');
        
        // Decode Opus packet to PCM
        const decoded = await opusDecoder.decode(opusPacket);
        
        console.log('Decoded result:', decoded);
        
        if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
            console.error('Opus decode returned empty data');
            return;
        }
        
        console.log('Decoded channels:', decoded.channelData.length, 'samples:', decoded.channelData[0].length);
        
        // Create audio buffer from decoded PCM data
        const audioBuffer = audioContext.createBuffer(
            decoded.channelData.length,
            decoded.channelData[0].length,
            decoded.sampleRate
        );
        
        // Copy decoded data to audio buffer
        for (let channel = 0; channel < decoded.channelData.length; channel++) {
            audioBuffer.getChannelData(channel).set(decoded.channelData[channel]);
        }
        
        console.log('Playing decoded audio buffer');
        
        // Play the decoded audio
        playAudioBuffer(audioBuffer);
        
    } catch (e) {
        console.error('Failed to decode Opus audio:', e);
        log('Opus decoding error: ' + e.message, 'error');
        
        // Mark decoder as failed to avoid repeated errors
        opusDecoderFailed = true;
        log('Disabling Opus decoder due to errors. Please use PCM mode.', 'error');
    }
}

// Play audio buffer with proper timing
function playAudioBuffer(buffer) {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    
    // Audio chain:
    // source -> analyser (for spectrum/waterfall) -> [squelch] -> [compressor] -> [bandpass] -> [notch] -> EQ -> vuAnalyser (for VU meter) -> gain (for volume/mute) -> destination
    // The main analyser taps the signal for visualizations but doesn't affect it
    // The squelch gate is FIRST to prevent noise from reaching other filters
    // The VU analyser measures after all processing but before volume/mute
    source.connect(analyser);
    
    // Build the audio processing chain step by step
    let nextNode = source;
    
    // Step 0: Noise Reduction (FIRST - clean signal before squelch/other processing)
    if (noiseReductionEnabled && noiseReductionProcessor) {
        try {
            noiseReductionProcessor.disconnect();
        } catch (e) {
            // Ignore if already disconnected
        }
        
        // Connect processor in signal chain
        nextNode.connect(noiseReductionProcessor);
        nextNode = noiseReductionProcessor;
    }
    
    // Step 1: Squelch gate (after noise reduction so it sees cleaned signal)
    if (squelchEnabled && squelchGate) {
        // Disconnect squelch gate to clear old connections
        try {
            squelchGate.disconnect();
            if (squelchAnalyser) {
                squelchAnalyser.disconnect();
            }
        } catch (e) {
            // Ignore if already disconnected
        }
        
        // Connect to squelch gate
        nextNode.connect(squelchGate);
        nextNode = squelchGate;
        
        // Also connect to squelch analyser for level monitoring
        if (squelchAnalyser) {
            source.connect(squelchAnalyser);
        }
    }
    
    // Step 2: Compressor with makeup gain (optional)
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
    
    // Step 3: Bandpass filter (optional)
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
    
    // Step 4: Notch filters (optional)
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
    
    // Step 5: EQ chain with makeup gain (optional)
    if (equalizerEnabled && eqFilters.length > 0) {
        // Disconnect all EQ filters first to clear any old connections
        for (let filter of eqFilters) {
            try {
                filter.disconnect();
            } catch (e) {
                // Ignore if already disconnected
            }
        }
        
        // Disconnect makeup gain to clear old connections
        if (eqMakeupGain) {
            try {
                eqMakeupGain.disconnect();
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
        
        // Connect last EQ filter to makeup gain
        nextNode = eqFilters[eqFilters.length - 1];
        if (eqMakeupGain) {
            nextNode.connect(eqMakeupGain);
            nextNode = eqMakeupGain;
        }
    }
    
    // Step 6: Gain node for volume/mute control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = isMuted ? 0 : currentVolume;
    nextNode.connect(gainNode);
    
    // Step 7: Tap signal for monitoring AFTER all processing but BEFORE final output
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
    
    // Step 8: Final output to destination
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
    
    // Re-learn noise profile when frequency changes (if NR2 is enabled)
    if (noiseReductionEnabled && nr2) {
        nr2.resetLearning();
        log('NR2: Re-learning noise profile for new frequency...');
    }
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

// Set band - zoom spectrum to show entire band and tune to center
function setBand(bandName) {
    const range = bandRanges[bandName];
    if (!range) {
        log(`Unknown band: ${bandName}`, 'error');
        return;
    }
    
    // Calculate band center frequency
    const centerFreq = Math.round((range.min + range.max) / 2);
    
    // Calculate band width
    const bandWidth = range.max - range.min;
    
    // Set frequency to band center
    document.getElementById('frequency').value = centerFreq;
    updateBandButtons(centerFreq);
    
    // Set mode based on frequency: LSB below 10 MHz (80m, 40m), USB at 10 MHz and above (30m+)
    // This follows amateur radio convention where LSB is used on lower HF bands
    const mode = centerFreq < 10000000 ? 'lsb' : 'usb';
    setMode(mode);
    
    // Update URL with new frequency and mode
    updateURL();
    
    // Auto-connect if not connected
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
    } else {
        autoTune();
    }
    
    // Zoom spectrum to show band with tighter view (0.6x band width for more detail)
    // This provides one additional zoom level beyond showing the full band
    if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Calculate bin bandwidth to show 60% of the band width
        // This gives a focused view while still showing context
        // totalBandwidth = binBandwidth * binCount
        // Assuming binCount is typically 2048, calculate binBandwidth
        const focusedBandwidth = bandWidth * 0.6;
        const binCount = spectrumDisplay.binCount || 2048;
        const binBandwidth = focusedBandwidth / binCount;
        
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: centerFreq,
            binBandwidth: binBandwidth
        }));
        
        log(`Tuned to ${bandName} band: ${formatFrequency(centerFreq)} ${mode.toUpperCase()} (zoomed to ${formatFrequency(centerFreq - focusedBandwidth/2)} - ${formatFrequency(centerFreq + focusedBandwidth/2)})`);
    } else {
        log(`Tuned to ${bandName} band: ${formatFrequency(centerFreq)} ${mode.toUpperCase()}`);
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
    
    // Round down to nearest 10 Hz (set last digit to 0)
    const roundedFreq = Math.floor(clampedFreq / 10) * 10;
    
    freqInput.value = roundedFreq;
    updateBandButtons(roundedFreq);
    
    // Log with appropriate precision based on step size
    let stepDesc;
    if (Math.abs(deltaHz) >= 1000) {
        stepDesc = `${deltaHz > 0 ? '+' : ''}${deltaHz / 1000} kHz`;
    } else {
        stepDesc = `${deltaHz > 0 ? '+' : ''}${deltaHz} Hz`;
    }
    log(`Frequency adjusted: ${stepDesc} → ${formatFrequency(roundedFreq)}`);
    
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

    // Load spectrum zoom parameters (will be applied when spectrum display initializes)
    if (params.has('zoom_freq') && params.has('zoom_bw')) {
        const zoomFreq = parseInt(params.get('zoom_freq'));
        const zoomBw = parseFloat(params.get('zoom_bw'));
        if (!isNaN(zoomFreq) && !isNaN(zoomBw) && zoomBw > 0) {
            // Store for later application when spectrum display is ready
            window.spectrumZoomParams = { frequency: zoomFreq, binBandwidth: zoomBw };
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

    // Add spectrum zoom parameters if zoomed
    // Check if spectrum display exists, has valid zoom data, AND is connected
    if (spectrumDisplay &&
        spectrumDisplay.centerFreq &&
        spectrumDisplay.binBandwidth &&
        spectrumDisplay.ws &&
        spectrumDisplay.ws.readyState === WebSocket.OPEN) {
        // Only add zoom params if actually zoomed (not at default 1x)
        if (spectrumDisplay.zoomLevel > 1) {
            params.set('zoom_freq', Math.round(spectrumDisplay.centerFreq));
            params.set('zoom_bw', spectrumDisplay.binBandwidth.toFixed(1));
        }
    } else {
        // If spectrum display not ready yet or not connected, preserve existing zoom params from URL
        const currentParams = new URLSearchParams(window.location.search);
        if (currentParams.has('zoom_freq') && currentParams.has('zoom_bw')) {
            params.set('zoom_freq', currentParams.get('zoom_freq'));
            params.set('zoom_bw', currentParams.get('zoom_bw'));
        }
    }
    
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
    		maxLow = 0;
    		defaultLow = -2700;
    		maxHigh = 0;
    		defaultHigh = -50;  // -50 Hz is correct for LSB upper edge
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
            minLow = -5000;
            maxLow = 0;
            defaultLow = -5000;
            maxHigh = 5000;
            defaultHigh = 5000;
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
    
    // For LSB mode, high slider needs negative range; for other modes it starts at 0
    bandwidthHighSlider.min = (currentMode === 'lsb') ? -3200 : 0;
    bandwidthHighSlider.max = maxHigh;
    bandwidthHighSlider.value = defaultHigh;
    currentBandwidthHigh = defaultHigh;
    document.getElementById('bandwidth-high-value').textContent = defaultHigh;
    
    log(`Mode changed to ${mode.toUpperCase()} (BW: ${defaultLow} to ${defaultHigh} Hz)`);
    
    // Update URL with new mode
    updateURL();
    
    // Update bandpass slider ranges for new mode (important for LSB)
    if (bandpassEnabled) {
        updateBandpassSliderRanges();
    }
    
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
    
    // Update bandpass slider ranges if bandpass is enabled
    if (bandpassEnabled) {
        updateBandpassSliderRanges();
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

// VU meter throttling
let lastVUMeterUpdate = 0;
const vuMeterUpdateInterval = 100; // 10 fps (1000ms / 10 = 100ms)

// Squelch status throttling
let lastSquelchStatusUpdate = 0;
const squelchStatusUpdateInterval = 100; // 10 Hz (1000ms / 10 = 100ms)

function startVisualization() {
    if (!analyser) return;
    
    function draw() {
        if (!analyser) return;
        
        const now = performance.now();
        
        // Always check for clipping (independent of visualization state)
        checkClipping();
        
        // Update VU meter at 30 fps (for compact version when visualization is hidden)
        if (now - lastVUMeterUpdate >= vuMeterUpdateInterval) {
            updateVUMeter();
            lastVUMeterUpdate = now;
        }
        
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
        
        // Process squelch gate if enabled (always run, independent of visualization)
        processSquelch();
        
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
                    
                    // Also resize overlay canvas to match
                    if (waterfallOverlayCanvas) {
                        waterfallOverlayCanvas.width = newWidth;
                        waterfallOverlayCanvas.height = newHeight;
                    }
                    
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
        // Use slider value for display (positive in LSB mode)
        const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
        const filterBandwidth = parseInt(document.getElementById('bandpass-width').value);
        
        // For LSB mode, convert positive slider value back to negative for display coordinates
        const displayCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
        const lowFreq = displayCenter - filterBandwidth / 2;
        const highFreq = displayCenter + filterBandwidth / 2;
        
        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;
        
        console.log(`Spectrum bandpass viz: sliderCenter=${sliderCenter}, displayCenter=${displayCenter}, displayLow=${displayLow}, displayHigh=${displayHigh}`);
        
        // Only draw if within visible range
        if (displayCenter >= displayLow && displayCenter <= displayHigh) {
            // Draw center line (bright yellow) using shared mapping
            const centerX = frequencyToPixel(displayCenter, width);
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
            // notch.center is stored as display value (negative for LSB)
            const displayCenter = notch.center;
            const filterBandwidth = notch.width;
            const lowFreq = displayCenter - filterBandwidth / 2;
            const highFreq = displayCenter + filterBandwidth / 2;
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            console.log(`Spectrum notch viz: displayCenter=${displayCenter}, displayLow=${displayLow}, displayHigh=${displayHigh}, visible=${displayCenter >= displayLow && displayCenter <= displayHigh}`);
            
            // Only draw if within visible range
            if (displayCenter >= displayLow && displayCenter <= displayHigh) {
                // Draw shaded notch region first (so lines appear on top)
                if (lowFreq >= displayLow && highFreq <= displayHigh) {
                    const lowX = Math.max(0, frequencyToPixel(lowFreq, width));
                    const highX = Math.min(width, frequencyToPixel(highFreq, width));
                    spectrumCtx.fillStyle = 'rgba(255, 0, 0, 0.1)';
                    spectrumCtx.fillRect(lowX, 0, highX - lowX, height);
                }
                
                // Draw center line (bright red)
                const centerX = frequencyToPixel(displayCenter, width);
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
    
    // Redraw waterfall overlay to ensure filter lines persist
    drawWaterfallFilterOverlay();
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
    
    // Redraw filter overlays
    drawWaterfallFilterOverlay();
}

// Draw filter indicators on waterfall overlay canvas
function drawWaterfallFilterOverlay() {
    if (!waterfallOverlayCtx || !waterfallOverlayCanvas) return;
    
    // Clear overlay canvas
    waterfallOverlayCtx.clearRect(0, 0, waterfallOverlayCanvas.width, waterfallOverlayCanvas.height);
    
    const width = waterfallOverlayCanvas.width;
    const height = waterfallOverlayCanvas.height;
    
    // Draw bandpass filter indicators
    if (bandpassEnabled && bandpassFilters.length > 0) {
        // Use slider value for display (positive in LSB mode)
        const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
        const filterBandwidth = parseInt(document.getElementById('bandpass-width').value);
        
        // For LSB mode, convert positive slider value back to negative for display coordinates
        const displayCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
        const lowFreq = displayCenter - filterBandwidth / 2;
        const highFreq = displayCenter + filterBandwidth / 2;
        
        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;
        
        console.log(`Waterfall bandpass viz: sliderCenter=${sliderCenter}, displayCenter=${displayCenter}, displayLow=${displayLow}, displayHigh=${displayHigh}`);
        
        // Only draw if within visible range
        if (displayCenter >= displayLow && displayCenter <= displayHigh) {
            // CRITICAL: Account for CSS scale(0.75) on .audio-visualization-section
            // The overlay canvas is scaled by CSS, so we need to scale our drawing coordinates
            const cssScale = 0.75;
            const scaledWidth = waterfallOverlayCanvas.width / cssScale;
            
            // Draw center line (bright yellow solid) on overlay - full height
            const centerX = frequencyToPixel(displayCenter, scaledWidth);
            waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
            waterfallOverlayCtx.lineWidth = 2 / cssScale; // Scale line width too
            waterfallOverlayCtx.beginPath();
            waterfallOverlayCtx.moveTo(centerX, 0);
            waterfallOverlayCtx.lineTo(centerX, waterfallOverlayCanvas.height);
            waterfallOverlayCtx.stroke();
            
            // Draw bandwidth edges (semi-transparent yellow dashed) on overlay - full height
            if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                const lowX = frequencyToPixel(lowFreq, scaledWidth);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                waterfallOverlayCtx.lineWidth = 1 / cssScale;
                waterfallOverlayCtx.setLineDash([5 / cssScale, 5 / cssScale]);
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(lowX, 0);
                waterfallOverlayCtx.lineTo(lowX, waterfallOverlayCanvas.height);
                waterfallOverlayCtx.stroke();
                waterfallOverlayCtx.setLineDash([]);
            }
            
            if (highFreq >= displayLow && highFreq <= displayHigh) {
                const highX = frequencyToPixel(highFreq, scaledWidth);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
                waterfallOverlayCtx.lineWidth = 1 / cssScale;
                waterfallOverlayCtx.setLineDash([5 / cssScale, 5 / cssScale]);
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(highX, 0);
                waterfallOverlayCtx.lineTo(highX, waterfallOverlayCanvas.height);
                waterfallOverlayCtx.stroke();
                waterfallOverlayCtx.setLineDash([]);
            }
        }
    }
    
    // Draw notch filter indicators
    if (notchEnabled && notchFilters.length > 0) {
        for (let notch of notchFilters) {
            // notch.center is stored as display value (negative for LSB)
            const displayCenter = notch.center;
            const filterBandwidth = notch.width;
            const lowFreq = displayCenter - filterBandwidth / 2;
            const highFreq = displayCenter + filterBandwidth / 2;
            
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;
            
            // Only draw if within visible range
            if (displayCenter >= displayLow && displayCenter <= displayHigh) {
                // CRITICAL: Account for CSS scale(0.75) on .audio-visualization-section
                const cssScale = 0.75;
                const scaledWidth = waterfallOverlayCanvas.width / cssScale;
                
                // Draw center line (bright red solid) on overlay - full height
                const centerX = frequencyToPixel(displayCenter, scaledWidth);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
                waterfallOverlayCtx.lineWidth = 2 / cssScale;
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(centerX, 0);
                waterfallOverlayCtx.lineTo(centerX, waterfallOverlayCanvas.height);
                waterfallOverlayCtx.stroke();
                
                // Draw bandwidth edges (semi-transparent red dashed) on overlay - full height
                if (lowFreq >= displayLow && lowFreq <= displayHigh) {
                    const lowX = frequencyToPixel(lowFreq, scaledWidth);
                    waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    waterfallOverlayCtx.lineWidth = 1 / cssScale;
                    waterfallOverlayCtx.setLineDash([5 / cssScale, 5 / cssScale]);
                    waterfallOverlayCtx.beginPath();
                    waterfallOverlayCtx.moveTo(lowX, 0);
                    waterfallOverlayCtx.lineTo(lowX, waterfallOverlayCanvas.height);
                    waterfallOverlayCtx.stroke();
                    waterfallOverlayCtx.setLineDash([]);
                }
                
                if (highFreq >= displayLow && highFreq <= displayHigh) {
                    const highX = frequencyToPixel(highFreq, scaledWidth);
                    waterfallOverlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    waterfallOverlayCtx.lineWidth = 1 / cssScale;
                    waterfallOverlayCtx.setLineDash([5 / cssScale, 5 / cssScale]);
                    waterfallOverlayCtx.beginPath();
                    waterfallOverlayCtx.moveTo(highX, 0);
                    waterfallOverlayCtx.lineTo(highX, waterfallOverlayCanvas.height);
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
    
    // Create makeup gain node
    eqMakeupGain = audioContext.createGain();
    eqMakeupGain.gain.value = 1.0; // 0 dB default (no makeup gain)
    
    // Create analyser to monitor equalizer output for clipping detection
    eqAnalyser = audioContext.createAnalyser();
    eqAnalyser.fftSize = 2048;
    eqAnalyser.smoothingTimeConstant = 0;
    
    log('12-band equalizer initialized with makeup gain and clipping detection');
}

// Toggle equalizer on/off
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
        log('12-band equalizer enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
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
    
    // Update makeup gain
    const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
    const makeupGainDisplay = document.getElementById('equalizer-makeup-gain-value');
    
    if (makeupGainSlider && makeupGainDisplay && eqMakeupGain) {
        const makeupGainDb = parseFloat(makeupGainSlider.value);
        eqMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
        makeupGainDisplay.textContent = `${makeupGainDb > 0 ? '+' : ''}${makeupGainDb.toFixed(1)} dB`;
    }
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
    
    // Reset makeup gain
    const makeupGainSlider = document.getElementById('equalizer-makeup-gain');
    const makeupGainDisplay = document.getElementById('equalizer-makeup-gain-value');
    
    if (makeupGainSlider && makeupGainDisplay) {
        makeupGainSlider.value = 0;
        makeupGainDisplay.textContent = '+0 dB';
    }
    
    if (eqMakeupGain) {
        eqMakeupGain.gain.value = 1.0;
    }
    
    log('Equalizer reset to flat response');
}

// Toggle bandpass filter on/off
function toggleBandpassFilter() {
    const checkbox = document.getElementById('bandpass-enable');
    const badge = document.getElementById('bandpass-status-badge');
    bandpassEnabled = checkbox.checked;
    
    if (bandpassEnabled) {
        // Update slider ranges FIRST before initializing filter
        updateBandpassSliderRanges();
        
        if (bandpassFilters.length === 0 && audioContext) {
            initializeBandpassFilter();
        }
        
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        log('Bandpass filter enabled (4-stage cascade, 48 dB/octave)');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        log('Bandpass filter disabled');
    }
}

// Update bandpass slider ranges based on current bandwidth (for LSB support)
function updateBandpassSliderRanges() {
    const centerSlider = document.getElementById('bandpass-center');
    const widthSlider = document.getElementById('bandpass-width');
    
    if (!centerSlider || !widthSlider) return;
    
    // Get display range (accounts for CW offset and negative frequencies)
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    
    // For LSB mode, bandwidth is negative (e.g., -2700 to -50)
    // We need to convert to positive display values (50 to 2700)
    let displayLow, displayHigh;
    
    if (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) {
        // LSB mode: both negative, convert to positive and reverse order
        displayLow = Math.abs(currentBandwidthHigh);  // -50 -> 50
        displayHigh = Math.abs(currentBandwidthLow);  // -2700 -> 2700
    } else {
        // USB/other modes: use as-is with CW offset
        displayLow = cwOffset + currentBandwidthLow;
        displayHigh = cwOffset + currentBandwidthHigh;
    }
    
    console.log(`updateBandpassSliderRanges: mode=${currentMode}, BW=${currentBandwidthLow} to ${currentBandwidthHigh}, cwOffset=${cwOffset}, displayLow=${displayLow}, displayHigh=${displayHigh}`);
    
    // Update center slider range
    const newMin = Math.max(50, displayLow);
    const newMax = displayHigh;
    centerSlider.min = newMin;
    centerSlider.max = newMax;
    
    console.log(`Bandpass center slider: min=${centerSlider.min}, max=${centerSlider.max}, current value=${centerSlider.value}`);
    
    // Clamp current value to new range
    const currentCenter = parseInt(centerSlider.value);
    if (currentCenter < newMin || currentCenter > newMax) {
        const clampedValue = Math.max(newMin, Math.min(newMax, currentCenter));
        console.log(`Clamping bandpass center from ${currentCenter} to ${clampedValue}`);
        centerSlider.value = clampedValue;
        updateBandpassFilter();
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
    
    const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    
    // For LSB mode, slider shows positive values but filter needs negative frequencies
    // Convert back to negative for the actual audio filter
    const actualCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
    
    const Q = Math.max(0.7, Math.abs(actualCenter) / (width * 4)); // Low Q for cascaded filters to avoid resonance
    
    console.log(`updateBandpassFilter: sliderCenter=${sliderCenter}, actualCenter=${actualCenter}, width=${width}, Q=${Q.toFixed(2)}`);
    
    // Update all filter stages with actual frequency (negative for LSB)
    for (let filter of bandpassFilters) {
        filter.frequency.value = Math.abs(actualCenter); // Web Audio API uses absolute frequencies
        filter.Q.value = Q;
    }
    
    // Update display values (show positive)
    document.getElementById('bandpass-center-value').textContent = sliderCenter + ' Hz';
    document.getElementById('bandpass-width-value').textContent = width + ' Hz';
    
    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {  // 5% chance to log
        log(`Bandpass: ${sliderCenter} Hz ± ${width/2} Hz (Q=${Q.toFixed(2)}, 4-stage)`);
    }
    
    // Update CW decoder frequency if enabled
    if (cwDecoder && cwDecoder.enabled) {
        updateCWDecoderFrequency(Math.abs(actualCenter));
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
    
    // centerFreq comes from click handler and may be negative in LSB mode
    // Store it as-is for display purposes
    // Create notch filter object with peaking filter for adjustable gain
    const notch = {
        center: centerFreq,  // Store display value (negative for LSB)
        width: defaultWidth,
        gain: defaultGain,
        filters: []
    };
    
    console.log(`addNotchFilter: centerFreq=${centerFreq}, abs=${Math.abs(centerFreq)}`);
    
    // Create 4 cascaded peaking filters with negative gain for adjustable notch depth
    // Peaking filters allow gain control, unlike pure notch filters
    // For peaking filters, higher Q = narrower bandwidth
    // Q = center_freq / bandwidth gives the correct relationship
    // 4 stages match the bandpass filter for consistency
    for (let i = 0; i < 4; i++) {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'peaking';
        // Web Audio API uses absolute frequencies
        filter.frequency.value = Math.abs(centerFreq);
        // Use higher Q for narrower, more effective notch
        filter.Q.value = Math.max(1.0, Math.abs(centerFreq) / defaultWidth);
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
        const sliderCenter = parseInt(centerInput.value);
        const width = parseInt(widthInput.value);
        const gain = parseInt(gainInput.value);
        
        // Slider shows positive values (50-2700)
        // For LSB mode, convert back to negative for display coordinates
        const displayCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;
        
        // Higher Q = narrower bandwidth for peaking filters
        const Q = Math.max(1.0, Math.abs(displayCenter) / width);
        
        notch.center = displayCenter; // Store display value (negative for LSB)
        notch.width = width;
        notch.gain = gain;
        
        console.log(`updateNotchFilterParams[${index}]: sliderCenter=${sliderCenter}, displayCenter=${displayCenter}, width=${width}, Q=${Q.toFixed(2)}`);
        
        // Update all filter stages in this notch
        // Web Audio API uses absolute frequencies
        for (let filter of notch.filters) {
            filter.frequency.value = Math.abs(displayCenter);
            filter.Q.value = Q;
            filter.gain.value = gain / 4; // Split gain across 4 stages
        }
        
        // Update display values (show positive)
        document.getElementById(`notch-center-value-${index}`).textContent = sliderCenter + ' Hz';
        document.getElementById(`notch-width-value-${index}`).textContent = width + ' Hz';
        document.getElementById(`notch-gain-value-${index}`).textContent = gain + ' dB';
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
        log('Notch filters enabled');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
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
    
    // Get display range (accounts for CW offset and LSB negative frequencies)
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    
    // For LSB mode, convert negative bandwidth to positive slider range
    let sliderMin, sliderMax;
    if (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) {
        // LSB: -2700 to -50 becomes 50 to 2700 for sliders
        sliderMin = Math.abs(currentBandwidthHigh);
        sliderMax = Math.abs(currentBandwidthLow);
    } else {
        // USB/other modes
        sliderMin = cwOffset + currentBandwidthLow;
        sliderMax = cwOffset + currentBandwidthHigh;
    }
    
    // Create UI for each notch filter
    notchFilters.forEach((notch, index) => {
        // Convert stored display value (negative for LSB) to positive slider value
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
    const badge = document.getElementById('compressor-status-badge');
    compressorEnabled = checkbox.checked;
    
    if (compressorEnabled) {
        if (!compressor && audioContext) {
            initializeCompressor();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        log('Audio compressor enabled (AGC)');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
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

// Noise Reduction Functions (NR2 Spectral Subtraction with Overlap-Add)

// Initialize noise reduction processor
function initNoiseReduction() {
    if (!audioContext) {
        log('Audio context not initialized', 'error');
        return false;
    }
    
    if (noiseReductionProcessor) {
        log('Noise reduction already initialized');
        return true;
    }
    
    // Check if FFT and NR2 classes are available
    if (typeof FFT === 'undefined' || typeof NR2Processor === 'undefined') {
        log('NR2 libraries not loaded', 'error');
        log('Please ensure fft.js and nr2.js are loaded', 'error');
        return false;
    }
    
    try {
        // Create NR2 processor instance
        nr2 = new NR2Processor(audioContext, 2048, 4);
        nr2.setParameters(noiseReductionStrength, noiseReductionFloor);
        
        // Create script processor
        const bufferSize = 2048;
        noiseReductionProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        noiseReductionProcessor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const output = e.outputBuffer.getChannelData(0);
            
            // Process through NR2
            nr2.process(input, output);
        };
        
        log('✅ NR2 Noise Reduction initialized');
        log('Using proper FFT-based spectral subtraction with overlap-add');
        return true;
    } catch (e) {
        console.error('Failed to initialize noise reduction:', e);
        log('Failed to initialize noise reduction: ' + e.message, 'error');
        return false;
    }
}

// Update noise reduction parameters from sliders
function updateNoiseReduction() {
    const strengthSlider = document.getElementById('noise-reduction-strength');
    const floorSlider = document.getElementById('noise-reduction-floor');
    
    if (strengthSlider) {
        noiseReductionStrength = parseFloat(strengthSlider.value);
        document.getElementById('noise-reduction-strength-value').textContent = noiseReductionStrength + '%';
    }
    
    if (floorSlider) {
        noiseReductionFloor = parseFloat(floorSlider.value);
        document.getElementById('noise-reduction-floor-value').textContent = noiseReductionFloor + '%';
    }
    
    // Update NR2 processor parameters
    if (nr2) {
        nr2.setParameters(noiseReductionStrength, noiseReductionFloor);
    }
}


// Toggle noise reduction on/off
function toggleNoiseReduction() {
    const checkbox = document.getElementById('noise-reduction-enable');
    const statusBadge = document.getElementById('noise-reduction-status-badge');
    
    if (!checkbox) {
        console.error('Noise reduction checkbox not found');
        return;
    }
    
    noiseReductionEnabled = checkbox.checked;
    
    if (noiseReductionEnabled) {
        if (!audioContext) {
            log('Please start audio first (click "Click to Start")', 'error');
            checkbox.checked = false;
            noiseReductionEnabled = false;
            return;
        }
        
        if (!noiseReductionProcessor) {
            const success = initNoiseReduction();
            if (!success) {
                checkbox.checked = false;
                noiseReductionEnabled = false;
                return;
            }
        }
        
        // Enable processing in NR2
        if (nr2) {
            nr2.enabled = true;
        }
        
        if (statusBadge) {
            statusBadge.textContent = 'ENABLED';
            statusBadge.className = 'filter-status-badge filter-enabled';
        }
        log('✅ NR2 Noise Reduction ENABLED');
        log('Using FFT-based spectral subtraction with overlap-add processing');
    } else {
        // Disable processing in NR2
        if (nr2) {
            nr2.enabled = false;
        }
        
        if (statusBadge) {
            statusBadge.textContent = 'DISABLED';
            statusBadge.className = 'filter-status-badge filter-disabled';
        }
        
        log('❌ NR2 Noise Reduction DISABLED');
    }
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

// Load bookmarks from server
async function loadBookmarks() {
    try {
        const response = await fetch('/api/bookmarks');
        if (response.ok) {
            bookmarks = await response.json();
            window.bookmarks = bookmarks; // Update window reference
            log(`Loaded ${bookmarks.length} bookmarks`);
            // Bookmarks will be drawn automatically when spectrum display draws
        } else {
            log('No bookmarks available', 'error');
        }
    } catch (err) {
        console.error('Failed to load bookmarks:', err);
        log('Failed to load bookmarks: ' + err.message, 'error');
    }
}

// Draw bookmark flags on the spectrum display (expose on window for spectrum-display.js access)
function drawBookmarksOnSpectrum() {
    if (!spectrumDisplay || !bookmarks || bookmarks.length === 0) {
        bookmarkPositions = [];
        window.bookmarkPositions = bookmarkPositions;
        return;
    }

    const ctx = spectrumDisplay.overlayCtx;
    
    if (!ctx || !spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) {
        bookmarkPositions = [];
        window.bookmarkPositions = bookmarkPositions;
        return;
    }

    // Calculate frequency range (same as frequency cursor)
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Clear bookmark positions array
    bookmarkPositions = [];

    // Draw each bookmark that's within the visible range
    bookmarks.forEach(bookmark => {
        // Only draw if tuned frequency is within range (same check as cursor)
        if (bookmark.frequency < startFreq || bookmark.frequency > endFreq) {
            return;
        }
        
        // Calculate x position (same formula as frequency cursor at line 633)
        const x = ((bookmark.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Draw at same height as bandwidth marker (y=20)
        const labelY = 20;
        
        // Draw bookmark label (similar to frequency cursor but gold)
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        
        // Background for label
        const labelWidth = ctx.measureText(bookmark.name).width + 8;
        const labelHeight = 12;
        
        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)'; // Gold background
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);
        
        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);
        
        // Label text
        ctx.fillStyle = '#000000'; // Black text on gold background
        ctx.fillText(bookmark.name, x, labelY + 2);
        
        // Draw downward arrow below label (smaller than frequency cursor)
        const arrowY = labelY + labelHeight;
        const arrowLength = 6;
        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)';
        ctx.beginPath();
        ctx.moveTo(x, arrowY + arrowLength); // Arrow tip
        ctx.lineTo(x - 4, arrowY); // Left point
        ctx.lineTo(x + 4, arrowY); // Right point
        ctx.closePath();
        ctx.fill();
        
        // Arrow border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Store bookmark position for hover detection
        bookmarkPositions.push({
            x: x,
            y: labelY,
            width: labelWidth,
            height: labelHeight + arrowLength,
            bookmark: bookmark
        });
    });
    
    // Update window reference
    window.bookmarkPositions = bookmarkPositions;
}
window.drawBookmarksOnSpectrum = drawBookmarksOnSpectrum;

// Handle bookmark click (expose on window for spectrum-display.js access)
function handleBookmarkClick(frequency, mode) {
    // Set frequency
    document.getElementById('frequency').value = frequency;
    updateBandButtons(frequency);

    // Set mode (mode is already lowercase from JSON)
    setMode(mode);

    // Update URL
    updateURL();

    // Connect if not connected, otherwise tune
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
    } else {
        autoTune();
    }

    // Zoom spectrum to maximum (1 Hz/bin)
    if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Send zoom request directly to 1 Hz/bin for maximum zoom
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: 1.0  // Minimum bin bandwidth = maximum zoom
        }));
        log(`Tuned to bookmark: ${formatFrequency(frequency)} ${mode.toUpperCase()} (zoomed to max)`);
    } else {
        log(`Tuned to bookmark: ${formatFrequency(frequency)} ${mode.toUpperCase()}`);
    }
}
window.handleBookmarkClick = handleBookmarkClick;

// Initialize spectrum display on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load bookmarks
    loadBookmarks();

    // Initialize spectrum display
    try {
        spectrumDisplay = new SpectrumDisplay('spectrum-display-canvas', {
            minDb: -120,
            maxDb: -20,
            colorScheme: 'jet',
            intensity: 0.30,  // Default +0.30 for brighter display
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
                // Update zoom display with new zoom level from config
                updateSpectrumZoomDisplay();
                // Update URL with new zoom parameters
                updateURL();
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
        
        // Apply zoom from URL parameters if present
        if (window.spectrumZoomParams) {
            const { frequency, binBandwidth } = window.spectrumZoomParams;
            // Wait a bit for the connection to establish and initial config to arrive
            setTimeout(() => {
                if (spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
                    spectrumDisplay.ws.send(JSON.stringify({
                        type: 'zoom',
                        frequency: frequency,
                        binBandwidth: binBandwidth
                    }));
                    log(`Restored spectrum zoom from URL: ${formatFrequency(frequency)} @ ${binBandwidth} Hz/bin`);
                }
            }, 1000);
            delete window.spectrumZoomParams;
        }

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
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL
}

function spectrumZoomOut() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    spectrumDisplay.zoomOut();
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL
}

function spectrumResetZoom() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    spectrumDisplay.resetZoom();
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL (will remove zoom params when at 1x)
}

function spectrumMaxZoom() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    // Get current frequency from input
    const freqInput = document.getElementById('frequency');
    const frequency = parseInt(freqInput.value);
    
    if (isNaN(frequency)) {
        log('Invalid frequency for max zoom', 'error');
        return;
    }

    // Send zoom request to maximum (1 Hz/bin) at current frequency
    if (spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: 1.0  // Minimum bin bandwidth = maximum zoom
        }));
        log(`Zoomed to maximum at ${formatFrequency(frequency)}`);
    }
    
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL
}

function updateSpectrumZoomDisplay() {
    if (!spectrumDisplay) return;

    const zoomLevel = spectrumDisplay.zoomLevel;
    const displayText = Math.round(zoomLevel) + '×';
    const zoomElement = document.getElementById('spectrum-zoom-level');
    if (zoomElement) {
        zoomElement.textContent = displayText;
    }
}

// Squelch (Audio Gate) Functions

// Initialize squelch gate
function initializeSquelch() {
    if (!audioContext) return;
    
    // Create gain node to act as gate
    squelchGate = audioContext.createGain();
    squelchGate.gain.value = 1.0; // Start open
    
    // Create analyser to monitor signal level
    squelchAnalyser = audioContext.createAnalyser();
    squelchAnalyser.fftSize = 2048;
    squelchAnalyser.smoothingTimeConstant = 0.3; // Some smoothing for level detection
    
    squelchOpen = true;
    squelchCurrentLevel = -Infinity;
    
    log('Squelch gate initialized');
}

// Toggle squelch on/off
function toggleSquelch() {
    const checkbox = document.getElementById('squelch-enable');
    const badge = document.getElementById('squelch-status-badge');
    squelchEnabled = checkbox.checked;
    
    if (squelchEnabled) {
        if (!squelchGate && audioContext) {
            initializeSquelch();
        }
        // Start monitoring squelch level
        if (!animationFrameId) {
            startVisualization();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        log('Squelch enabled (audio gate active)');
    } else {
        // Open the gate when disabled
        if (squelchGate) {
            squelchGate.gain.setValueAtTime(1.0, audioContext.currentTime);
            squelchOpen = true;
            updateSquelchStatus();
        }
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        log('Squelch disabled');
    }
}

// Update squelch parameters
function updateSquelch() {
    const thresholdDb = parseInt(document.getElementById('squelch-threshold').value);
    const hysteresisDb = parseFloat(document.getElementById('squelch-hysteresis').value);
    const attackMs = parseInt(document.getElementById('squelch-attack').value);
    const releaseMs = parseInt(document.getElementById('squelch-release').value);
    
    squelchThreshold = thresholdDb;
    squelchHysteresis = hysteresisDb;
    squelchAttack = attackMs / 1000; // Convert to seconds
    squelchRelease = releaseMs / 1000; // Convert to seconds
    
    // Update display values
    document.getElementById('squelch-threshold-value').textContent = thresholdDb + ' dB';
    document.getElementById('squelch-hysteresis-value').textContent = hysteresisDb + ' dB';
    document.getElementById('squelch-attack-value').textContent = attackMs + ' ms';
    document.getElementById('squelch-release-value').textContent = releaseMs + ' ms';
    
    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {
        log(`Squelch: ${thresholdDb} dB threshold, ${hysteresisDb} dB hysteresis, ${attackMs}ms attack, ${releaseMs}ms release`);
    }
}

// Process squelch gate (called from visualization loop)
function processSquelch() {
    if (!squelchEnabled || !squelchAnalyser || !squelchGate || !audioContext) return;
    
    // Get signal level
    const dataArray = new Uint8Array(squelchAnalyser.frequencyBinCount);
    squelchAnalyser.getByteTimeDomainData(dataArray);
    
    // Calculate RMS level
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    
    // Convert to dB
    const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    squelchCurrentLevel = levelDb;
    
    // Determine target gain using hysteresis
    // Hysteresis prevents rapid open/close when signal hovers near threshold
    const currentTime = audioContext.currentTime;
    let newTargetGain = squelchTargetGain;
    
    if (squelchOpen) {
        // Gate is open - close only if signal drops below (threshold - hysteresis)
        if (levelDb < (squelchThreshold - squelchHysteresis)) {
            newTargetGain = 0.0;
            squelchOpen = false;
        }
    } else {
        // Gate is closed - open only if signal rises above (threshold + hysteresis)
        if (levelDb > (squelchThreshold + squelchHysteresis)) {
            newTargetGain = 1.0;
            squelchOpen = true;
        }
    }
    
    // Apply smooth fade if target changed
    if (newTargetGain !== squelchTargetGain) {
        squelchTargetGain = newTargetGain;
        squelchGate.gain.cancelScheduledValues(currentTime);
        squelchGate.gain.setValueAtTime(squelchGate.gain.value, currentTime);
        // Use attack time when opening (0->1), release time when closing (1->0)
        const fadeTime = newTargetGain > 0 ? squelchAttack : squelchRelease;
        squelchGate.gain.linearRampToValueAtTime(squelchTargetGain, currentTime + fadeTime);
    }
    
    // Update status display at 10 Hz (throttled)
    const now = performance.now();
    if (now - lastSquelchStatusUpdate >= squelchStatusUpdateInterval) {
        updateSquelchStatus();
        lastSquelchStatusUpdate = now;
    }
}

// Update squelch status display
function updateSquelchStatus() {
    const statusEl = document.getElementById('squelch-status');
    const levelEl = document.getElementById('squelch-level');
    
    if (!statusEl || !levelEl) return;
    
    // Get actual current gain value to show real-time state during fade
    const currentGain = squelchGate ? squelchGate.gain.value : 1.0;
    
    // Update status text and color based on actual gain
    // Consider gate "open" if gain > 0.5, "closing/opening" if in between
    if (currentGain > 0.9) {
        statusEl.textContent = 'OPEN';
        statusEl.style.color = '#28a745'; // Green
    } else if (currentGain < 0.1) {
        statusEl.textContent = 'CLOSED';
        statusEl.style.color = '#dc3545'; // Red
    } else if (squelchTargetGain > 0.5) {
        statusEl.textContent = 'OPENING';
        statusEl.style.color = '#ffc107'; // Yellow/amber
    } else {
        statusEl.textContent = 'CLOSING';
        statusEl.style.color = '#ff9800'; // Orange
    }
    
    // Update level display
    if (squelchCurrentLevel === -Infinity) {
        levelEl.textContent = 'Level: -∞ dB';
    } else {
        levelEl.textContent = `Level: ${squelchCurrentLevel.toFixed(1)} dB`;
    }
}
