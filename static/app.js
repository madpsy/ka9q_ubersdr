// Notification system
function showNotification(message, type = 'error', duration = 5000) {
    const toast = document.getElementById('notification-toast');
    if (!toast) return;

    // Set message and type
    toast.textContent = message;
    toast.className = 'notification-toast show ' + type;

    // Auto-hide after duration
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => {
            toast.classList.remove('show', 'hiding', type);
        }, 300); // Match animation duration
    }, duration);
}

// ka9q UberSDR Web Client

// Generate a unique session ID for this browser session
// This links audio and spectrum WebSocket connections together
function generateUserSessionID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Generate and store user session ID globally (exposed on window for spectrum-display.js)
const userSessionID = generateUserSessionID();
window.userSessionID = userSessionID;
console.log('User session ID:', userSessionID);

let ws = null;
window.ws = ws; // Expose for idle detector
let audioContext = null;
let reconnectTimer = null;
let reconnectAttempts = 0; // Track number of reconnection attempts
const maxReconnectAttempts = 10; // Give up after 10 attempts
let lastConnectionParams = null; // Store connection parameters for reconnection
let audioUserDisconnected = false; // Flag to prevent reconnection after user disconnect
let connectionFailureNotified = false; // Track if we've already shown the connection failure notification
let lastServerError = null; // Store last error message from server
// Expose audioContext globally for recorder
window.audioContext = null;
let audioQueue = [];
let isPlaying = false;
let isMuted = false;
let currentVolume = 0.7;
let nextPlayTime = 0;
let audioStartTime = 0;
let currentMode = 'usb';
let currentBandwidthLow = 50;
let currentBandwidthHigh = 3000;

// Stereo channel selection
let channelLeftEnabled = true;
let channelRightEnabled = true;
let channelSplitter = null;
let channelMerger = null;
let channelLeftGain = null;
let channelRightGain = null;
let monoMerger = null; // Converts stereo to mono for recorder

// Active Channels Display
let statsUpdateInterval = null;
let currentSessionId = null;

// Expose mode and bandwidth globally for recorder
window.currentMode = currentMode;
window.currentBandwidthLow = currentBandwidthLow;
window.currentBandwidthHigh = currentBandwidthHigh;

// Audio analysis
let analyser = null; // Analyser for spectrum/waterfall (taps signal before processing)
let vuAnalyser = null; // Dedicated analyser for VU meter (after all processing)
let spectrumCanvas = null;
let spectrumCtx = null;
let spectrumPeaks = null; // Array to store peak values for each bar
let spectrumLabelsCache = null; // Cached canvas for dB scale labels
let audioSpectrumTooltip = null; // Tooltip element for audio spectrum/waterfall
let audioSpectrumMouseX = -1; // Mouse X position on audio spectrum
let audioSpectrumMouseY = -1; // Mouse Y position on audio spectrum
let audioSpectrumLastData = null; // Store last spectrum data for tooltip
let audioSpectrumActiveCanvas = null; // Track which canvas the mouse is over

// Audio spectrum autoranging - temporal smoothing like main graph mode
let audioSpectrumMinHistory = []; // Track minimum values over time for stable noise floor
let audioSpectrumMaxHistory = []; // Track maximum values over time for stable ceiling
const audioSpectrumMinHistoryMaxAge = 2000; // 2 second window for noise floor
const audioSpectrumMaxHistoryMaxAge = 20000; // 20 second window for maximum (handles FT8 cycles)
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
let oscilloscopeFreqHistory = []; // Store recent frequency measurements for averaging
let oscilloscopeFreqHistoryMaxSize = 60; // Average over last 60 samples (~2 seconds at 30fps)
let waterfallIntensity = 0.0; // Intensity adjustment for waterfall (-1.0 to +1.0, 0 = normal)
let waterfallContrast = 50; // Contrast threshold for waterfall (0-100, suppresses noise floor)
let oscilloscopeZoom = 200; // Oscilloscope zoom level (1-200, affects timebase, default to max/slowest)
let oscilloscopeTriggerEnabled = false; // Enable continuous trigger tracking
let oscilloscopeTriggerFreq = 0; // Target frequency for trigger
let oscilloscopeYScale = 1.0; // Y-axis scale factor (1.0 = normal, >1 = zoomed in, <1 = zoomed out)
let oscilloscopeAutoScaleEnabled = true; // Enable continuous auto-scaling
let oscilloscopeFrequencyOffset = 0; // Frequency offset in Hz for adjusted dial frequency display
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
let noiseReductionMakeupGain = null; // GainNode for makeup gain after NR2
let noiseReductionAnalyser = null; // Analyser to monitor NR2 output for clipping
let noiseReductionClipping = false; // Track if NR2 output is clipping
let noiseReductionClipIndicatorTimeout = null; // Timeout for hiding clip indicator
let nr2 = null; // NR2 processor instance
let stereoVirtualizerEnabled = false; // Track if stereo virtualizer is enabled
let stereoSplitter = null; // ChannelSplitterNode to split mono to stereo
let stereoMerger = null; // ChannelMergerNode to merge back to stereo
let stereoDelayLeft = null; // DelayNode for left channel
let stereoDelayRight = null; // DelayNode for right channel
let stereoGainLeft = null; // GainNode for left channel separation
let stereoGainRight = null; // GainNode for right channel separation
let stereoWidthGain = null; // GainNode for overall width control

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

// Update page title with current frequency and mode
function updatePageTitle() {
    const freqInput = document.getElementById('frequency');
    if (freqInput && currentMode) {
        const freq = parseInt(freqInput.value);
        if (!isNaN(freq)) {
            const freqMHz = (freq / 1000000).toFixed(3);
            document.title = `UberSDR - ${freqMHz} MHz ${currentMode.toUpperCase()}`;
        }
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load settings from URL parameters first
    loadSettingsFromURL();

    // Fetch and display site description
    fetchSiteDescription();

    // Update page title with initial frequency and mode
    updatePageTitle();

    // Setup audio start overlay
    const audioStartButton = document.getElementById('audio-start-button');
    const audioStartOverlay = document.getElementById('audio-start-overlay');

    if (audioStartButton && audioStartOverlay) {
        // Disable button and show "Please wait..." while checking connection
        const originalHTML = audioStartButton.innerHTML;
        audioStartButton.disabled = true;
        audioStartButton.innerHTML = '<span>Please wait...</span>';

        // Check if connection will be allowed
        checkConnectionOnLoad(audioStartButton, audioStartOverlay, originalHTML);

        audioStartButton.addEventListener('click', () => {
            // Hide overlay
            audioStartOverlay.classList.add('hidden');

            // Start audio by triggering the current mode (from URL or default)
            // This will initialize audio context and connect
            // Preserve bandwidth values loaded from URL
            setMode(currentMode, true);
        });
    }

    // Set oscilloscope auto-scale button to enabled state by default
    const autoScaleBtn = document.getElementById('auto-scale-btn');
    if (autoScaleBtn) {
        autoScaleBtn.style.backgroundColor = '#28a745'; // Green when enabled
        autoScaleBtn.textContent = 'Auto Scale: ON';
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

    // Set audio visualization as enabled by default (expanded)
    audioVisualizationEnabled = true;

    // Hide compact VU meter since full visualization is shown
    const compactVU = document.getElementById('vu-meter-compact');
    if (compactVU) compactVU.style.display = 'none';

    // Show the full visualization content
    const content = document.getElementById('audio-visualization-content');
    if (content) content.style.display = 'block';

    // Add expanded class to toggle
    const toggle = document.getElementById('audio-viz-toggle');
    if (toggle) toggle.classList.add('expanded');

    // Create tooltip for audio spectrum/waterfall immediately (before canvas initialization)
    audioSpectrumTooltip = document.createElement('div');
    audioSpectrumTooltip.style.position = 'fixed';
    audioSpectrumTooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
    audioSpectrumTooltip.style.color = '#fff';
    audioSpectrumTooltip.style.padding = '8px 12px';
    audioSpectrumTooltip.style.borderRadius = '4px';
    audioSpectrumTooltip.style.fontSize = '12px';
    audioSpectrumTooltip.style.fontFamily = 'monospace';
    audioSpectrumTooltip.style.pointerEvents = 'none';
    audioSpectrumTooltip.style.zIndex = '10000';
    audioSpectrumTooltip.style.display = 'none';
    audioSpectrumTooltip.style.whiteSpace = 'nowrap';
    audioSpectrumTooltip.style.border = '1px solid #fff';
    document.body.appendChild(audioSpectrumTooltip);

    // Add mouse tracking for spectrum canvas
    if (spectrumCanvas) {
        spectrumCanvas.addEventListener('mousemove', (e) => {
            const rect = spectrumCanvas.getBoundingClientRect();
            audioSpectrumMouseX = e.clientX - rect.left;
            audioSpectrumMouseY = e.clientY - rect.top;
            audioSpectrumActiveCanvas = spectrumCanvas;
            updateAudioSpectrumTooltip(e.clientX, e.clientY);
        });

        spectrumCanvas.addEventListener('mouseleave', () => {
            audioSpectrumMouseX = -1;
            audioSpectrumMouseY = -1;
            audioSpectrumActiveCanvas = null;
            if (audioSpectrumTooltip) {
                audioSpectrumTooltip.style.display = 'none';
            }
        });
    }

    // Add mouse tracking for waterfall canvas
    if (waterfallCanvas) {
        waterfallCanvas.addEventListener('mousemove', (e) => {
            const rect = waterfallCanvas.getBoundingClientRect();
            audioSpectrumMouseX = e.clientX - rect.left;
            audioSpectrumMouseY = e.clientY - rect.top;
            audioSpectrumActiveCanvas = waterfallCanvas;
            updateAudioSpectrumTooltip(e.clientX, e.clientY);
        });

        waterfallCanvas.addEventListener('mouseleave', () => {
            audioSpectrumMouseX = -1;
            audioSpectrumMouseY = -1;
            audioSpectrumActiveCanvas = null;
            if (audioSpectrumTooltip) {
                audioSpectrumTooltip.style.display = 'none';
            }
        });
    }

    // Initialize canvas sizes
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

// Check connection status on page load
async function checkConnectionOnLoad(audioStartButton, audioStartOverlay, originalHTML) {
    try {
        const checkResponse = await fetch('/connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_session_id: userSessionID
            })
        });

        const checkData = await checkResponse.json();

        if (!checkData.allowed) {
            // Check if this is a terminated session (410 Gone status)
            if (checkResponse.status === 410) {
                // Show full-screen overlay for terminated sessions
                showTerminatedOverlay(checkData.reason);
            } else {
                // Connection not allowed - show error instead of play button
                audioStartButton.disabled = true;
                audioStartButton.style.backgroundColor = '#dc3545'; // Red
                audioStartButton.style.cursor = 'not-allowed';

                // Show error message in button
                let errorIcon = '🚫';
                if (checkData.reason.includes('banned')) {
                    errorIcon = '⛔';
                } else if (checkData.reason.includes('Maximum')) {
                    errorIcon = '👥';
                }

                audioStartButton.innerHTML = `<span>${errorIcon} ${checkData.reason}</span>`;

                // Also log the error
                log(`Connection not allowed: ${checkData.reason}`, 'error');
            }
        } else {
            // Connection allowed - enable the play button after 2 second delay
            setTimeout(() => {
                audioStartButton.disabled = false;
                audioStartButton.innerHTML = originalHTML;
            }, 2000);
        }
    } catch (err) {
        console.error('Connection check failed:', err);
        // On error, enable button after delay anyway
        setTimeout(() => {
            audioStartButton.disabled = false;
            audioStartButton.innerHTML = originalHTML;
        }, 2000);
    }
}

// Show full-screen overlay for terminated sessions
function showTerminatedOverlay(message) {
    // Create overlay if it doesn't exist
    let overlay = document.getElementById('terminated-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'terminated-overlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.95)';
        overlay.style.zIndex = '99999';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.color = '#fff';
        overlay.style.fontFamily = 'Arial, sans-serif';
        overlay.style.textAlign = 'center';
        overlay.style.padding = '20px';

        overlay.innerHTML = `
            <div style="max-width: 600px;">
                <div style="font-size: 80px; margin-bottom: 20px;">❌</div>
                <h1 style="font-size: 32px; margin-bottom: 20px; color: #dc3545;">Session Terminated</h1>
                <p style="font-size: 20px; margin-bottom: 30px; line-height: 1.5;">${message}</p>
                <button onclick="location.reload()" style="
                    background: #007bff;
                    color: white;
                    border: none;
                    padding: 15px 40px;
                    font-size: 18px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-weight: bold;
                ">Refresh Page</button>
            </div>
        `;

        document.body.appendChild(overlay);
    }

    // Show the overlay
    overlay.style.display = 'flex';
}

// Fetch and display site description
async function fetchSiteDescription() {
    try {
        const response = await fetch('/api/description');
        if (response.ok) {
            const data = await response.json();
            const descriptionEl = document.getElementById('site-description');
            if (descriptionEl && data.description) {
                descriptionEl.innerHTML = data.description;
            }
        } else {
            console.error('Failed to fetch site description:', response.status);
        }
    } catch (err) {
        console.error('Error fetching site description:', err);
    }
}

// Toggle connection
function toggleConnection() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        disconnect();
    } else {
        connect();
    }
}

// Connect to WebSocket
async function connect() {
    // Clear any pending reconnection timer
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const frequency = document.getElementById('frequency').value;
    const mode = currentMode;

    // Store connection parameters for reconnection
    lastConnectionParams = {
        frequency: frequency,
        mode: mode,
        bandwidthLow: currentBandwidthLow,
        bandwidthHigh: currentBandwidthHigh
    };
    // Check if connection will be allowed before attempting WebSocket connection
    try {
        const checkResponse = await fetch('/connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_session_id: userSessionID
            })
        });

        const checkData = await checkResponse.json();

        if (!checkData.allowed) {
            // Connection not allowed - show specific error
            log(`Connection rejected: ${checkData.reason}`, 'error');
            showNotification(`Connection rejected: ${checkData.reason}`, 'error', 10000);
            updateConnectionStatus('disconnected');

            // Store the error for potential reconnection attempts
            lastServerError = checkData.reason;

            // Don't attempt reconnection if banned or kicked
            if (checkData.reason.includes('banned') || checkData.reason.includes('terminated')) {
                // Clear reconnection parameters to prevent any retry
                lastConnectionParams = null;
                return;
            }

            // For max sessions, schedule reconnection (but don't create WebSocket)
            if (checkData.reason.includes('Maximum')) {
                scheduleReconnect();
            }

            // CRITICAL: Return here to prevent WebSocket creation
            return;
        }

        log(`Connection check passed (client IP: ${checkData.client_ip})`);
    } catch (err) {
        console.error('Connection check failed:', err);
        log('Connection check failed, attempting connection anyway...', 'error');
        // Continue with connection attempt even if check fails
    }


    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Include bandwidth parameters and user session ID in WebSocket URL
    const wsUrl = `${protocol}//${window.location.host}/ws?frequency=${frequency}&mode=${mode}&bandwidthLow=${currentBandwidthLow}&bandwidthHigh=${currentBandwidthHigh}&user_session_id=${encodeURIComponent(userSessionID)}`;

    log(`Connecting to ${wsUrl}...`);

    try {
        ws = new WebSocket(wsUrl);
        window.ws = ws; // Expose for idle detector
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        showNotification('Failed to connect. Please refresh the page.', 'error');
        updateConnectionStatus('disconnected');
        return;
    }

    ws.onopen = () => {
        log('Connected!');
        updateConnectionStatus('connected');

        // Don't reset reconnection attempts immediately - wait for first successful message
        // This prevents resetting the counter when server immediately kicks us
        // The counter will be reset when we receive our first status message

        // Start stats updates
        startStatsUpdates();

        // Initialize audio context
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            window.audioContext = audioContext; // Expose globally for recorder
            nextPlayTime = audioContext.currentTime;
            audioStartTime = audioContext.currentTime;
            log(`Audio context initialized (sample rate: ${audioContext.sampleRate} Hz)`);

            // Create analyser for spectrum/waterfall (taps signal before processing)
            analyser = audioContext.createAnalyser();
            analyser.fftSize = getOptimalFFTSize(); // Dynamic FFT size based on bandwidth
            analyser.smoothingTimeConstant = 0; // No smoothing - instant response, no fade

            // Update FFT size dropdown to reflect the chosen size
            updateFFTSizeDropdown();

            // Create dedicated analyser for VU meter (will be connected after all processing)
            vuAnalyser = audioContext.createAnalyser();
            vuAnalyser.fftSize = 2048; // Smaller FFT for VU meter (we only need time domain data)
            vuAnalyser.smoothingTimeConstant = 0; // No smoothing

            // Initialize stereo channel routing
            initializeStereoChannels();

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
        showNotification('Connection error occurred. Attempting to reconnect...', 'error');
    };

    ws.onclose = (event) => {
        console.log('WebSocket closed - Code:', event.code, 'Reason:', event.reason, 'Clean:', event.wasClean);
        log('Disconnected');
        updateConnectionStatus('disconnected');
        ws = null;
        window.ws = null; // Update exposed reference

        // Stop stats updates
        stopStatsUpdates();

        // Show notification for abnormal closures ONLY ONCE (not on every reconnection attempt)
        // Code 1000 = normal closure (user initiated)
        // Code 1001 = going away (page navigation)
        // Any other code or unclean close = show notification (but only the first time)
        if (event.code !== 1000 && event.code !== 1001 && !connectionFailureNotified) {
            connectionFailureNotified = true; // Set flag so we don't show again

            // Use specific error message if we received one from the server
            let errorMessage;
            if (lastServerError) {
                errorMessage = `Connection failed: ${lastServerError}. Attempting to reconnect...`;
            } else if (!event.wasClean || event.code === 1006) {
                // 1006 = abnormal closure (no close frame received)
                errorMessage = 'Connection failed. You may have been disconnected by an administrator. Attempting to reconnect...';
            } else {
                errorMessage = 'Connection lost. Attempting to reconnect...';
            }

            showNotification(errorMessage, 'error', 10000);

            // Clear the stored error after using it
            lastServerError = null;
        }

        // Schedule reconnection if we have saved parameters AND user didn't explicitly disconnect
        // Check window.audioUserDisconnected (set by idle detector) as well as local variable
        // Only schedule if we don't already have a reconnect pending
        if (lastConnectionParams && !audioUserDisconnected && !window.audioUserDisconnected && !reconnectTimer) {
            scheduleReconnect();
        }
    };
}

// Schedule reconnection attempt with exponential backoff
function scheduleReconnect() {
    // Check if we've exceeded max attempts FIRST
    if (reconnectAttempts >= maxReconnectAttempts) {
        log('Maximum reconnection attempts reached. Please refresh the page.', 'error');
        showNotification('Unable to reconnect after multiple attempts. You may have been disconnected by an administrator. Please refresh the page.', 'error', 10000);
        return;
    }

    // Don't schedule if we already have a timer pending OR if we're already attempting to reconnect
    if (reconnectTimer) {
        console.log('Reconnect already scheduled, skipping');
        return;
    }

    reconnectAttempts++;

    // Calculate delay for THIS attempt using exponential backoff
    // Attempt 1: 1s, 2: 2s, 3: 4s, 4: 8s, 5: 16s, 6: 32s, 7-10: 60s
    const delay = Math.min(Math.pow(2, reconnectAttempts - 1) * 1000, 60000);

    console.log(`Reconnection attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms...`);
    log(`Reconnecting (${reconnectAttempts}/${maxReconnectAttempts}) in ${(delay/1000).toFixed(1)}s...`);

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;

        // CRITICAL: Check /connection before attempting to reconnect
        try {
            const checkResponse = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user_session_id: userSessionID
                })
            });

            const checkData = await checkResponse.json();

            if (!checkData.allowed) {
                // Connection not allowed - stop reconnecting
                log(`Reconnection blocked: ${checkData.reason}`, 'error');

                // Check if this is a terminated session (410 Gone status)
                if (checkResponse.status === 410) {
                    // Show full-screen overlay for terminated sessions
                    showTerminatedOverlay(checkData.reason);
                } else {
                    // Show notification with appropriate icon based on reason
                    let errorIcon = '🚫';
                    if (checkData.reason.includes('banned')) {
                        errorIcon = '⛔';
                    } else if (checkData.reason.includes('Maximum')) {
                        errorIcon = '👥';
                    }

                    showNotification(`${errorIcon} ${checkData.reason}`, 'error', 15000);
                }

                // Clear reconnection parameters to prevent further attempts
                lastConnectionParams = null;
                reconnectAttempts = 0;
                return;
            }

            // Connection allowed - proceed with reconnect
            log(`Connection check passed, proceeding with reconnect`);
            reconnect();
        } catch (err) {
            console.error('Connection check failed during reconnect:', err);
            log('Connection check failed, will retry...', 'error');
            // Schedule another attempt
            scheduleReconnect();
        }
    }, delay);
}

// Reconnect with saved parameters
function reconnect() {
    if (!lastConnectionParams) {
        log('No saved connection parameters, cannot reconnect', 'error');
        return;
    }

    // Restore saved parameters
    document.getElementById('frequency').value = lastConnectionParams.frequency;
    currentMode = lastConnectionParams.mode;
    currentBandwidthLow = lastConnectionParams.bandwidthLow;
    currentBandwidthHigh = lastConnectionParams.bandwidthHigh;

    // Update UI to reflect restored parameters
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`mode-${currentMode}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    const bandwidthLowSlider = document.getElementById('bandwidth-low');
    const bandwidthHighSlider = document.getElementById('bandwidth-high');
    if (bandwidthLowSlider) {
        bandwidthLowSlider.value = currentBandwidthLow;
        document.getElementById('bandwidth-low-value').textContent = currentBandwidthLow;
    }
    if (bandwidthHighSlider) {
        bandwidthHighSlider.value = currentBandwidthHigh;
        document.getElementById('bandwidth-high-value').textContent = currentBandwidthHigh;
    }

    log(`Reconnecting to ${formatFrequency(lastConnectionParams.frequency)} ${lastConnectionParams.mode.toUpperCase()} (BW: ${lastConnectionParams.bandwidthLow} to ${lastConnectionParams.bandwidthHigh} Hz)`);

    // Attempt to reconnect (connect() will do another /connection check, but that's okay for safety)
    connect();
}

// Disconnect from WebSocket
function disconnect() {
    // Clear reconnection timer when manually disconnecting
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.close();
        ws = null;
        window.ws = null; // Update exposed reference
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
    channelSplitter = null;
    channelMerger = null;
    channelLeftGain = null;
    channelRightGain = null;
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

// Active Channels Stats Functions
function startStatsUpdates() {
    // Clear any existing interval
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
    }

    // Fetch immediately
    fetchAndDisplayStats();

    // Then fetch every 10 seconds
    statsUpdateInterval = setInterval(fetchAndDisplayStats, 10000);
}

function stopStatsUpdates() {
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
        statsUpdateInterval = null;
    }

    // Clear the display
    const listEl = document.getElementById('active-channels-list');
    if (listEl) {
        listEl.innerHTML = '<p style="color: #888; font-style: italic;">Not connected</p>';
    }
}

async function fetchAndDisplayStats() {
    try {
        // Build URL with session_id if we have one
        let url = '/stats';
        if (currentSessionId) {
            url += `?session_id=${currentSessionId}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Store session_id if we got one back
        if (data.session_id) {
            currentSessionId = data.session_id;
        }

        // Display the channels
        displayActiveChannels(data.channels || []);

    } catch (err) {
        console.error('Failed to fetch stats:', err);
        const listEl = document.getElementById('active-channels-list');
        if (listEl) {
            listEl.innerHTML = `<p style="color: #dc3545;">Error: ${err.message}</p>`;
        }
    }
}

function displayActiveChannels(channels) {
    const listEl = document.getElementById('active-channels-list');
    if (!listEl) return;

    if (channels.length === 0) {
        listEl.innerHTML = '<p style="color: #888; font-style: italic;">No active channels</p>';
        return;
    }

    // Build table HTML
    let html = '<table style="width: 100%; border-collapse: collapse;">';
    html += '<thead><tr>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">#</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Frequency</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Mode</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Bandwidth</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Active</th>';
    html += '<th style="text-align: center; padding: 8px; border-bottom: 2px solid #444;">Action</th>';
    html += '</tr></thead><tbody>';

    channels.forEach((channel, idx) => {
        // Highlight current user (index 0)
        const isCurrentUser = idx === 0;
        const rowStyle = isCurrentUser
            ? 'background-color: rgba(40, 167, 69, 0.2); font-weight: bold;'
            : '';

        html += `<tr style="${rowStyle}">`;
        // Don't show icon number for current user, leave cell empty
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${isCurrentUser ? '' : channel.index}</td>`;
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${formatFrequency(channel.frequency)}</td>`;
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${channel.mode.toUpperCase()}</td>`;
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${channel.bandwidth_low} to ${channel.bandwidth_high} Hz</td>`;

        // Calculate time since last active
        const lastActive = new Date(channel.last_active);
        const now = new Date();
        const secondsAgo = Math.floor((now - lastActive) / 1000);
        let activeText;
        if (secondsAgo < 60) {
            activeText = `${secondsAgo}s ago`;
        } else if (secondsAgo < 3600) {
            activeText = `${Math.floor(secondsAgo / 60)}m ago`;
        } else {
            activeText = `${Math.floor(secondsAgo / 3600)}h ago`;
        }

        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${activeText}</td>`;

        // Add "Go" button for other users' channels (not for current user)
        if (isCurrentUser) {
            html += `<td style="padding: 8px; border-bottom: 1px solid #333; text-align: center;">
                <span style="color: #888; font-style: italic;">You</span>
            </td>`;
        } else {
            html += `<td style="padding: 8px; border-bottom: 1px solid #333; text-align: center;">
                <button onclick="tuneToChannel(${channel.frequency}, '${channel.mode}', ${channel.bandwidth_low}, ${channel.bandwidth_high})"
                    style="background: #007bff; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">
                    Go
                </button>
            </td>`;
        }

        html += '</tr>';
    });

    html += '</tbody></table>';

    listEl.innerHTML = html;
}

// Tune to a channel from the active channels list
function tuneToChannel(frequency, mode, bandwidthLow, bandwidthHigh) {
    // Update frequency input
    document.getElementById('frequency').value = frequency;
    updateBandButtons(frequency);

    // Update mode
    currentMode = mode;
    window.currentMode = mode;

    // Update mode button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`mode-${mode}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    // Update bandwidth sliders
    currentBandwidthLow = bandwidthLow;
    currentBandwidthHigh = bandwidthHigh;
    window.currentBandwidthLow = bandwidthLow;
    window.currentBandwidthHigh = bandwidthHigh;

    const bandwidthLowSlider = document.getElementById('bandwidth-low');
    const bandwidthHighSlider = document.getElementById('bandwidth-high');

    if (bandwidthLowSlider) {
        bandwidthLowSlider.value = bandwidthLow;
        document.getElementById('bandwidth-low-value').textContent = bandwidthLow;
    }

    if (bandwidthHighSlider) {
        bandwidthHighSlider.value = bandwidthHigh;
        document.getElementById('bandwidth-high-value').textContent = bandwidthHigh;
    }

    // Update URL
    updateURL();

    // Tune to the new settings
    if (ws && ws.readyState === WebSocket.OPEN) {
        autoTune();
        log(`Tuned to channel: ${formatFrequency(frequency)} ${mode.toUpperCase()} (BW: ${bandwidthLow} to ${bandwidthHigh} Hz)`);
    } else {
        connect();
        log(`Connecting to channel: ${formatFrequency(frequency)} ${mode.toUpperCase()} (BW: ${bandwidthLow} to ${bandwidthHigh} Hz)`);
    }
}

// Handle incoming messages
function handleMessage(msg) {
    switch (msg.type) {
        case 'status':
            // Store session ID if provided
            if (msg.sessionId) {
                currentSessionId = msg.sessionId;
            }

            // Reset reconnection attempts and notification flag on first successful message
            // This indicates a stable connection (not immediately kicked)
            reconnectAttempts = 0;
            connectionFailureNotified = false;

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

    // Update page title
    updatePageTitle();

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

    // Create stereo audio buffer (duplicate mono to both channels)
    const audioBuffer = audioContext.createBuffer(2, floatData.length, msg.sampleRate);
    audioBuffer.getChannelData(0).set(floatData); // Left channel
    audioBuffer.getChannelData(1).set(floatData); // Right channel (duplicate)

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

        // Create stereo audio buffer from decoded PCM data
        const numChannels = Math.max(2, decoded.channelData.length); // Always at least 2 channels
        const audioBuffer = audioContext.createBuffer(
            numChannels,
            decoded.channelData[0].length,
            decoded.sampleRate
        );

        // Copy decoded data to audio buffer
        if (decoded.channelData.length === 1) {
            // Mono source - duplicate to both channels
            audioBuffer.getChannelData(0).set(decoded.channelData[0]);
            audioBuffer.getChannelData(1).set(decoded.channelData[0]);
        } else {
            // Stereo or multi-channel source
            for (let channel = 0; channel < decoded.channelData.length && channel < 2; channel++) {
                audioBuffer.getChannelData(channel).set(decoded.channelData[channel]);
            }
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
            if (noiseReductionMakeupGain) {
                noiseReductionMakeupGain.disconnect();
            }
        } catch (e) {
            // Ignore if already disconnected
        }

        // Connect processor in signal chain
        nextNode.connect(noiseReductionProcessor);
        nextNode = noiseReductionProcessor;

        // Add makeup gain after NR2
        if (noiseReductionMakeupGain) {
            nextNode.connect(noiseReductionMakeupGain);
            nextNode = noiseReductionMakeupGain;
        }
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
    if (noiseReductionEnabled && noiseReductionAnalyser) {
        gainNode.connect(noiseReductionAnalyser);
    }
    if (compressorEnabled && compressorAnalyser) {
        gainNode.connect(compressorAnalyser);
    }
    if (equalizerEnabled && eqAnalyser) {
        gainNode.connect(eqAnalyser);
    }
    if (vuAnalyser) {
        gainNode.connect(vuAnalyser);
    }

    // Step 8: Stereo Virtualizer (optional, creates wider stereo image from mono)
    let outputNode = gainNode;
    if (stereoVirtualizerEnabled && stereoSplitter && stereoMerger && stereoMakeupGain) {
        // Disconnect stereo nodes to clear old connections
        try {
            stereoSplitter.disconnect();
            stereoDelayLeft.disconnect();
            stereoDelayRight.disconnect();
            stereoGainLeft.disconnect();
            stereoGainRight.disconnect();
            stereoWidthGain.disconnect();
            stereoMerger.disconnect();
            stereoMakeupGain.disconnect();
            if (stereoAnalyser) stereoAnalyser.disconnect();
        } catch (e) {
            // Ignore if already disconnected
        }

        // Build stereo virtualizer chain:
        // Input (mono) -> Splitter -> [Left: No delay + gain, Right: Delay + gain] -> Merger -> Width -> Makeup Gain -> Output
        // Equal gains on both channels for balanced output

        // Split mono signal - connect input to both channels
        outputNode.connect(stereoSplitter);

        // Left channel: no delay + balanced gain
        stereoSplitter.connect(stereoDelayLeft, 0); // Channel 0 (mono) to left delay node
        stereoDelayLeft.connect(stereoGainLeft);
        stereoGainLeft.connect(stereoMerger, 0, 0); // To left output channel

        // Right channel: with delay + balanced gain (Haas effect)
        stereoSplitter.connect(stereoDelayRight, 0); // Channel 0 (mono) to right delay node
        stereoDelayRight.connect(stereoGainRight);
        stereoGainRight.connect(stereoMerger, 0, 1); // To right output channel

        // Width control after merger
        stereoMerger.connect(stereoWidthGain);

        // Makeup gain after width control
        stereoWidthGain.connect(stereoMakeupGain);

        // Connect analyser for clipping detection
        if (stereoAnalyser) {
            stereoMakeupGain.connect(stereoAnalyser);
        }

        outputNode = stereoMakeupGain;
    }

    // Step 9: Recorder tap (BEFORE stereo conversion so it records full processed audio)
    if (window.recorderGainNode) {
        // If recorder is active, tap the signal before stereo conversion
        outputNode.connect(window.recorderGainNode);
    }

    // Step 10: Stereo channel routing (L/R selection for output only)
    if (channelSplitter && channelMerger && channelLeftGain && channelRightGain) {
        // Disconnect nodes to clear old connections
        try {
            channelSplitter.disconnect();
            channelLeftGain.disconnect();
            channelRightGain.disconnect();
            channelMerger.disconnect();
        } catch (e) {
            // Ignore if already disconnected
        }

        // Connect stereo routing chain
        outputNode.connect(channelSplitter);

        // Split to L and R gain nodes
        channelSplitter.connect(channelLeftGain, 0);  // Left channel
        channelSplitter.connect(channelRightGain, 1); // Right channel

        // Merge back to stereo
        channelLeftGain.connect(channelMerger, 0, 0);  // Left to left
        channelRightGain.connect(channelMerger, 0, 1); // Right to right

        outputNode = channelMerger;
    }

    // Step 11: Final output to destination
    outputNode.connect(audioContext.destination);

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

    // Update page title
    updatePageTitle();

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
function setMode(mode, preserveBandwidth = false) {
    currentMode = mode;
    window.currentMode = mode; // Update global reference

    // Update page title
    updatePageTitle();

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

    // For LSB mode, high slider needs negative range; for other modes it starts at 0
    bandwidthHighSlider.min = (currentMode === 'lsb') ? -3200 : 0;
    bandwidthHighSlider.max = maxHigh;

    // Only reset bandwidth to defaults if not preserving (i.e., user clicked mode button)
    if (!preserveBandwidth) {
        bandwidthLowSlider.value = defaultLow;
        currentBandwidthLow = defaultLow;
        document.getElementById('bandwidth-low-value').textContent = defaultLow;

        bandwidthHighSlider.value = defaultHigh;
        currentBandwidthHigh = defaultHigh;
        document.getElementById('bandwidth-high-value').textContent = defaultHigh;

        log(`Mode changed to ${mode.toUpperCase()} (BW: ${defaultLow} to ${defaultHigh} Hz)`);
    } else {
        // Preserve existing bandwidth values, just update the display
        bandwidthLowSlider.value = currentBandwidthLow;
        document.getElementById('bandwidth-low-value').textContent = currentBandwidthLow;

        bandwidthHighSlider.value = currentBandwidthHigh;
        document.getElementById('bandwidth-high-value').textContent = currentBandwidthHigh;

        log(`Mode changed to ${mode.toUpperCase()} (BW: ${currentBandwidthLow} to ${currentBandwidthHigh} Hz)`);
    }

    // Update FFT size based on new bandwidth
    if (analyser) {
        const oldFFTSize = analyser.fftSize;
        const newFFTSize = getOptimalFFTSize();

        if (oldFFTSize !== newFFTSize) {
            analyser.fftSize = newFFTSize;
            updateFFTSizeDropdown();
            log(`FFT size auto-adjusted to ${newFFTSize} for ${Math.abs(currentBandwidthHigh - currentBandwidthLow)} Hz bandwidth`);
        }
    }

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

    // Show/hide "Set 1 kHz" button based on mode
    const set1kHzBtn = document.getElementById('set-1khz-btn');
    if (set1kHzBtn) {
        if (['usb', 'lsb', 'cwu', 'cwl'].includes(mode)) {
            set1kHzBtn.style.display = 'inline-block';
        } else {
            set1kHzBtn.style.display = 'none';
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
    // Update global references
    window.currentBandwidthLow = bandwidthLow;
    window.currentBandwidthHigh = bandwidthHigh;
    document.getElementById('bandwidth-low-value').textContent = bandwidthLow;
    document.getElementById('bandwidth-high-value').textContent = bandwidthHigh;

    // Update FFT size based on new bandwidth
    if (analyser) {
        const oldFFTSize = analyser.fftSize;
        const newFFTSize = getOptimalFFTSize();

        if (oldFFTSize !== newFFTSize) {
            analyser.fftSize = newFFTSize;
            updateFFTSizeDropdown();
            log(`FFT size auto-adjusted to ${newFFTSize} for ${Math.abs(bandwidthHigh - bandwidthLow)} Hz bandwidth`);
        }
    }

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

// Update channel selection (L/R checkboxes)
function updateChannelSelection() {
    const leftCheckbox = document.getElementById('channel-left');
    const rightCheckbox = document.getElementById('channel-right');

    if (leftCheckbox) {
        channelLeftEnabled = leftCheckbox.checked;
    }
    if (rightCheckbox) {
        channelRightEnabled = rightCheckbox.checked;
    }

    // Update gain nodes if they exist
    if (channelLeftGain) {
        channelLeftGain.gain.value = channelLeftEnabled ? 1.0 : 0.0;
    }
    if (channelRightGain) {
        channelRightGain.gain.value = channelRightEnabled ? 1.0 : 0.0;
    }

    // Log the change
    const status = [];
    if (channelLeftEnabled) status.push('L');
    if (channelRightEnabled) status.push('R');
    log(`Channel output: ${status.length > 0 ? status.join('+') : 'Muted'}`);
}

// Initialize stereo channel nodes
function initializeStereoChannels() {
    if (!audioContext) return;

    // Create mono merger for recorder (converts stereo to mono)
    monoMerger = audioContext.createChannelMerger(1);

    // Create channel splitter (2 channels)
    channelSplitter = audioContext.createChannelSplitter(2);

    // Create gain nodes for L and R
    channelLeftGain = audioContext.createGain();
    channelRightGain = audioContext.createGain();

    // Set initial gain values based on checkbox state
    channelLeftGain.gain.value = channelLeftEnabled ? 1.0 : 0.0;
    channelRightGain.gain.value = channelRightEnabled ? 1.0 : 0.0;

    // Create channel merger (2 channels)
    channelMerger = audioContext.createChannelMerger(2);

    log('Stereo channel routing initialized (L/R selection enabled, mono recording)');
}

// Quick toggle for NR2 filter
function toggleNR2Quick() {
    const checkbox = document.getElementById('noise-reduction-enable');
    const btn = document.getElementById('nr2-quick-toggle');

    if (!checkbox) return;

    // Toggle the checkbox
    checkbox.checked = !checkbox.checked;

    // Call the main toggle function
    toggleNoiseReduction();

    // Update button appearance
    if (checkbox.checked) {
        btn.style.backgroundColor = '#28a745'; // Green when enabled
        log('NR2 enabled via quick toggle');
    } else {
        btn.style.backgroundColor = '#fd7e14'; // Orange when disabled
        log('NR2 disabled via quick toggle');
    }
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

// Oscilloscope throttling
let lastOscilloscopeUpdate = 0;
const oscilloscopeUpdateInterval = 33; // 30 fps (1000ms / 30 = 33ms)

// Spectrum throttling
let lastSpectrumUpdate = 0;
const spectrumUpdateInterval = 33; // 30 fps (1000ms / 30 = 33ms)

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

            // Update oscilloscope (throttled to 30fps)
            if (now - lastOscilloscopeUpdate >= oscilloscopeUpdateInterval) {
                updateOscilloscope();
                lastOscilloscopeUpdate = now;
            }

            // Update spectrum (throttled to 30fps)
            if (now - lastSpectrumUpdate >= spectrumUpdateInterval) {
                updateSpectrum();
                lastSpectrumUpdate = now;
            }

            // Update waterfall (throttled to 30fps for performance)
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
    // Check for clipping at stereo virtualizer output if enabled
    if (stereoVirtualizerEnabled && stereoAnalyser) {
        const stereoDataArray = new Uint8Array(stereoAnalyser.frequencyBinCount);
        stereoAnalyser.getByteTimeDomainData(stereoDataArray);

        let stereoMaxSample = 0;
        for (let i = 0; i < stereoDataArray.length; i++) {
            const normalized = (stereoDataArray[i] - 128) / 128;
            stereoMaxSample = Math.max(stereoMaxSample, Math.abs(normalized));
        }

        // Clipping occurs when samples exceed ±0.99 (close to ±1.0)
        if (stereoMaxSample > 0.99) {
            showStereoClipIndicator();
        }
    }

    // Check for clipping at noise reduction output if enabled
    if (noiseReductionEnabled && noiseReductionAnalyser) {
        const nrDataArray = new Uint8Array(noiseReductionAnalyser.frequencyBinCount);
        noiseReductionAnalyser.getByteTimeDomainData(nrDataArray);

        let nrMaxSample = 0;
        for (let i = 0; i < nrDataArray.length; i++) {
            const normalized = (nrDataArray[i] - 128) / 128;
            nrMaxSample = Math.max(nrMaxSample, Math.abs(normalized));
        }

        // Clipping occurs when samples exceed ±0.99 (close to ±1.0)
        if (nrMaxSample > 0.99) {
            showNoiseReductionClipIndicator();
        }
    }

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

    // Calculate frequency using zero-crossing detection
    const detectedFreq = detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);

    // Add to frequency history for averaging
    if (detectedFreq > 0) {
        oscilloscopeFreqHistory.push(detectedFreq);
        // Keep only last N samples
        if (oscilloscopeFreqHistory.length > oscilloscopeFreqHistoryMaxSize) {
            oscilloscopeFreqHistory.shift();
        }
    }

    // Calculate averaged frequency
    const avgFreq = oscilloscopeFreqHistory.length > 0
        ? oscilloscopeFreqHistory.reduce((sum, f) => sum + f, 0) / oscilloscopeFreqHistory.length
        : detectedFreq;

    // Debug logging (remove after testing)
    if (Math.random() < 0.01) { // Log 1% of frames to avoid spam
        console.log(`Oscilloscope freq: detected=${detectedFreq.toFixed(1)}, history size=${oscilloscopeFreqHistory.length}, avg=${avgFreq.toFixed(1)}`);
    }

    // Calculate DC offset for AM/SAM modes (always needed for proper display)
    let dcOffset = 128; // Default to no offset
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    dcOffset = sum / dataArray.length;

    // Auto scale if enabled
    if (oscilloscopeAutoScaleEnabled) {
        // Find peak-to-peak amplitude relative to DC offset
        let min = 255;
        let max = 0;

        for (let i = 0; i < dataArray.length; i++) {
            // Center the signal by removing DC offset
            const centered = dataArray[i] - dcOffset + 128;
            min = Math.min(min, centered);
            max = Math.max(max, centered);
        }

        // Convert to normalized amplitude (-1.0 to +1.0)
        const minNorm = (min - 128) / 128;
        const maxNorm = (max - 128) / 128;
        const peakToPeak = maxNorm - minNorm;

        if (peakToPeak > 0.01) {
            // Calculate scale factor to fit signal with 10% padding (use 80% of display height)
            const targetRange = 1.6;
            const newScale = targetRange / peakToPeak;

            // Clamp to reasonable range (0.1x to 10x) and apply smoothing
            const clampedScale = Math.max(0.1, Math.min(10, newScale));
            // Smooth the scale changes to avoid jitter (exponential moving average)
            oscilloscopeYScale = oscilloscopeYScale * 0.9 + clampedScale * 0.1;
        }
    }

    // Calculate how many samples to display based on zoom level using logarithmic scale
    // Slider 1 = minimum zoom (0.5% of buffer), Slider 200 = maximum zoom (full buffer)
    const minFraction = 0.005; // 0.5% of buffer
    const maxFraction = 1.0;    // Full buffer

    // Logarithmic interpolation
    const logMin = Math.log10(minFraction);
    const logMax = Math.log10(maxFraction);
    const logRange = logMax - logMin;

    // Map slider (1-200) to log range
    const normalizedSlider = (oscilloscopeZoom - 1) / 199; // 0 to 1
    const logValue = logMin + (normalizedSlider * logRange);
    const fraction = Math.pow(10, logValue);

    const samplesToDisplay = Math.floor(bufferLength * fraction);

    // Find trigger point if trigger is enabled
    let startSample;
    if (oscilloscopeTriggerEnabled && oscilloscopeTriggerFreq > 0) {
        // Find rising edge zero crossing for stable trigger
        const threshold = 128; // Midpoint
        let triggerPoint = -1;

        // Search for rising edge in first half of buffer
        for (let i = 1; i < bufferLength / 2; i++) {
            if (dataArray[i - 1] < threshold && dataArray[i] >= threshold) {
                triggerPoint = i;
                break;
            }
        }

        // If found trigger, start from there; otherwise center the view
        if (triggerPoint >= 0 && triggerPoint + samplesToDisplay < bufferLength) {
            startSample = triggerPoint;
        } else {
            startSample = Math.floor((bufferLength - samplesToDisplay) / 2);
        }
    } else {
        startSample = Math.floor((bufferLength - samplesToDisplay) / 2); // Center the view
    }

    // Clear canvas
    oscilloscopeCtx.fillStyle = '#2c3e50';
    oscilloscopeCtx.fillRect(0, 0, width, height);

    // Draw grid lines with labels
    oscilloscopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    oscilloscopeCtx.lineWidth = 1;

    // Horizontal grid lines (amplitude divisions)
    // Range is -1.0 to +1.0 (normalized audio amplitude), 5 divisions = 0.5 per division
    oscilloscopeCtx.font = 'bold 10px monospace';
    oscilloscopeCtx.textAlign = 'left';
    oscilloscopeCtx.textBaseline = 'middle';
    oscilloscopeCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';

    for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * height;
        oscilloscopeCtx.beginPath();
        oscilloscopeCtx.moveTo(0, y);
        oscilloscopeCtx.lineTo(width, y);
        oscilloscopeCtx.stroke();

        // Y-axis labels (normalized amplitude, adjusted for scale)
        // Top = +1.0/scale, Center = 0.0, Bottom = -1.0/scale
        const baseAmplitude = 1.0 - (i / 4) * 2.0;
        const scaledAmplitude = baseAmplitude / oscilloscopeYScale;
        const label = scaledAmplitude.toFixed(2); // Use 2 decimals for scaled values

        // Draw label with background for visibility
        const labelText = label;
        const textWidth = oscilloscopeCtx.measureText(labelText).width;
        oscilloscopeCtx.fillStyle = 'rgba(44, 62, 80, 0.8)';
        oscilloscopeCtx.fillRect(2, y - 6, textWidth + 4, 12);

        oscilloscopeCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        oscilloscopeCtx.fillText(labelText, 4, y);
    }

    // Vertical grid lines (time divisions)
    oscilloscopeCtx.textAlign = 'center';
    oscilloscopeCtx.textBaseline = 'top';

    // Calculate time per division based on oscilloscope zoom
    if (analyser && audioContext) {
        const bufferLength = analyser.fftSize;
        const sampleRate = audioContext.sampleRate;
        const totalTimeMs = (bufferLength / sampleRate) * 1000;
        const invertedZoom = 201 - oscilloscopeZoom;
        const displayedTimeMs = totalTimeMs / invertedZoom;
        const timePerDivision = displayedTimeMs / 8; // 8 divisions

        for (let i = 0; i <= 8; i++) {
            const x = (i / 8) * width;
            oscilloscopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            oscilloscopeCtx.lineWidth = 1;
            oscilloscopeCtx.beginPath();
            oscilloscopeCtx.moveTo(x, 0);
            oscilloscopeCtx.lineTo(x, height);
            oscilloscopeCtx.stroke();

            // X-axis labels (time) - only on bottom divisions to avoid clutter
            if (i > 0 && i < 8) {
                const timeValue = i * timePerDivision;
                let timeLabel;

                if (timeValue >= 1) {
                    timeLabel = timeValue.toFixed(1) + 'ms';
                } else {
                    timeLabel = (timeValue * 1000).toFixed(0) + 'µs';
                }

                // Draw label with background at bottom
                const textWidth = oscilloscopeCtx.measureText(timeLabel).width;
                oscilloscopeCtx.fillStyle = 'rgba(44, 62, 80, 0.8)';
                oscilloscopeCtx.fillRect(x - textWidth / 2 - 2, height - 14, textWidth + 4, 12);

                oscilloscopeCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                oscilloscopeCtx.fillText(timeLabel, x, height - 12);
            }
        }
    } else {
        // Fallback if audio context not available
        for (let i = 0; i <= 8; i++) {
            const x = (i / 8) * width;
            oscilloscopeCtx.beginPath();
            oscilloscopeCtx.moveTo(x, 0);
            oscilloscopeCtx.lineTo(x, height);
            oscilloscopeCtx.stroke();
        }
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
        // Remove DC offset before normalizing
        const centered = dataArray[sampleIndex] - dcOffset + 128;
        const v = centered / 128.0; // Normalize to 0-2
        // Apply Y-axis scaling
        const scaledV = ((v - 1.0) * oscilloscopeYScale) + 1.0; // Scale around center (1.0)
        const y = (scaledV * height) / 2;

        if (i === 0) {
            oscilloscopeCtx.moveTo(x, y);
        } else {
            oscilloscopeCtx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    oscilloscopeCtx.stroke();

    // Draw detected frequency in top right corner (using averaged value)
    if (avgFreq > 0) {
        oscilloscopeCtx.font = 'bold 14px monospace';
        oscilloscopeCtx.textAlign = 'right';
        oscilloscopeCtx.textBaseline = 'top';

        // Always show in Hz with no decimal places (frequencies are whole numbers)
        const freqText = `${Math.round(avgFreq)} Hz`;

        // Calculate adjusted dial frequency if tracking is enabled
        let adjustedFreqText = '';
        let totalHeight = 20;
        if (frequencyTrackingEnabled) {
            const freqInput = document.getElementById('frequency');
            if (freqInput) {
                const currentDialFreq = parseInt(freqInput.value);
                if (!isNaN(currentDialFreq)) {
                    // The offset represents the dial frequency adjustment needed
                    // For USB/CWU: positive offset means dial should go UP (add offset)
                    // For LSB/CWL: positive offset means dial should go DOWN (subtract offset, but offset is already inverted)
                    // Since offset is already mode-corrected in applyOffset(), we always ADD it here
                    const adjustedDialFreq = currentDialFreq + oscilloscopeFrequencyOffset;
                    // Always display adjusted frequency when tracking is enabled, even if offset is 0
                    // This provides visual feedback that tracking is active
                    adjustedFreqText = `${(adjustedDialFreq / 1000).toFixed(2)} kHz`;
                    totalHeight = 40; // Increase height for two lines
                }
            }
        }

        // Background for text
        const textWidth = Math.max(
            oscilloscopeCtx.measureText(freqText).width,
            adjustedFreqText ? oscilloscopeCtx.measureText(adjustedFreqText).width : 0
        );
        oscilloscopeCtx.fillStyle = 'rgba(44, 62, 80, 0.9)';
        oscilloscopeCtx.fillRect(width - textWidth - 12, 4, textWidth + 8, totalHeight);

        // Text with outline - detected frequency
        oscilloscopeCtx.strokeStyle = '#000000';
        oscilloscopeCtx.lineWidth = 3;
        oscilloscopeCtx.strokeText(freqText, width - 6, 6);

        oscilloscopeCtx.fillStyle = '#00ff00';
        oscilloscopeCtx.fillText(freqText, width - 6, 6);

        // Draw adjusted frequency underneath if offset is set
        if (adjustedFreqText) {
            oscilloscopeCtx.font = 'bold 12px monospace';
            oscilloscopeCtx.strokeStyle = '#000000';
            oscilloscopeCtx.lineWidth = 3;
            oscilloscopeCtx.strokeText(adjustedFreqText, width - 6, 24);

            oscilloscopeCtx.fillStyle = '#ffaa00'; // Orange color for adjusted frequency
            oscilloscopeCtx.fillText(adjustedFreqText, width - 6, 24);
        }
    }
}

// Tracking mode state
let frequencyTrackingEnabled = false;
let frequencyTrackingInterval = null;
let frequencyTrackingStartFreq = null;
let frequencyTrackingHistory = []; // History of detected frequencies for smoothing
let frequencyTrackingStableCount = 0; // Count of consecutive stable readings
let frequencyTrackingLocked = false; // Track if we're locked on target
const TRACKING_LOCK_THRESHOLD = 2; // Hz - consider locked if within this range
const TRACKING_UPDATE_RATE = 1000; // ms - much slower updates (1 second)
const TRACKING_DRIFT_LIMIT = 1000; // Hz
const TRACKING_HISTORY_SIZE = 3; // Fewer samples, but require consistency
const TRACKING_MIN_ERROR = 0.5; // Hz - very small threshold for precision (never stop tracking)
const TRACKING_COARSE_THRESHOLD = 10; // Hz - use stronger correction above this
const TRACKING_DAMPING_COARSE = 0.3; // Apply 30% correction for large errors
const TRACKING_DAMPING_FINE = 0.5; // Apply 50% correction for small errors (more aggressive when close)

// Modal dialog functions for frequency offset
function showOffsetModal() {
    const modal = document.getElementById('offset-modal');
    const input = document.getElementById('offset-input');

    if (modal && input) {
        input.value = '1000'; // Default to 1 kHz
        modal.style.display = 'flex';

        input.focus();
        input.select();

        // Add keyboard event listener for Enter and Escape
        const handleKeyPress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyOffset();
                input.removeEventListener('keydown', handleKeyPress);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeOffsetModal();
                input.removeEventListener('keydown', handleKeyPress);
            }
        };
        input.addEventListener('keydown', handleKeyPress);
    }
}

function closeOffsetModal() {
    const modal = document.getElementById('offset-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function applyOffset() {
    const input = document.getElementById('offset-input');
    if (!input) return;

    const expectedFreq = parseFloat(input.value);
    if (isNaN(expectedFreq) || expectedFreq < 0) {
        log('Invalid frequency. Please enter a positive number.', 'error');
        return;
    }

    // Calculate offset: we're moving the signal TO 1 kHz, so offset = 1000 - expectedFreq
    // If they expect it at 0 Hz, offset = 1000 (we're moving it up by 1 kHz)
    // If they expect it at 1000 Hz, offset = 0 (it's already there)
    // If they expect it at 2000 Hz, offset = -1000 (we're moving it down by 1 kHz)
    const targetFreq = 1000; // We're always adjusting TO 1 kHz
    let offset = targetFreq - expectedFreq;

    // Apply correct sign based on mode
    // USB/CWU: negative offset means dial goes down
    // LSB/CWL: negative offset means dial goes up (inverted)
    if (currentMode === 'lsb' || currentMode === 'cwl') {
        offset = -offset;
    }

    // Store the offset with correct sign
    oscilloscopeFrequencyOffset = offset;
    log(`Expected signal at ${expectedFreq} Hz, adjusting to 1000 Hz (offset: ${offset} Hz, ${currentMode.toUpperCase()} mode)`);

    // Close modal
    closeOffsetModal();

    // Continue with frequency shift
    performFrequencyShift();
}

// Shift detected frequency to 1 kHz by adjusting dial frequency
function shiftFrequencyTo1kHz() {
    // Only works in USB, LSB, CWU, CWL modes
    if (!['usb', 'lsb', 'cwu', 'cwl'].includes(currentMode)) {
        log('Set 1 kHz only works in USB, LSB, CWU, or CWL modes', 'error');
        return;
    }

    if (!analyser || !audioContext) {
        log('Audio not initialized', 'error');
        return;
    }

    const button = document.getElementById('set-1khz-btn');

    // If tracking is already enabled, disable it
    if (frequencyTrackingEnabled) {
        disableFrequencyTracking();
        oscilloscopeFrequencyOffset = 0; // Reset offset when disabling
        if (button) {
            button.style.backgroundColor = '#6c757d'; // Gray
            button.textContent = 'Set 1 kHz';
        }
        log('Frequency tracking disabled');
        return;
    }

    // Show modal dialog for offset input (non-blocking)
    showOffsetModal();
}

// Perform the actual frequency shift (called after offset is set)
function performFrequencyShift() {
    if (!analyser || !audioContext) {
        log('Audio not initialized', 'error');
        return;
    }

    const button = document.getElementById('set-1khz-btn');

    // Get current detected frequency from oscilloscope
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const detectedFreq = detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);

    if (detectedFreq <= 0 || detectedFreq < 20 || detectedFreq > 20000) {
        log('No valid signal detected for frequency shift', 'error');
        return;
    }

    // Perform initial shift
    const targetFreq = 1000; // Target audio frequency (1 kHz)
    const shiftAmount = targetFreq - detectedFreq;

    // Get current dial frequency
    const freqInput = document.getElementById('frequency');
    const currentDialFreq = parseInt(freqInput.value);

    // Calculate new dial frequency based on mode
    let newDialFreq;
    if (currentMode === 'usb' || currentMode === 'cwu') {
        newDialFreq = currentDialFreq - shiftAmount;
    } else if (currentMode === 'lsb' || currentMode === 'cwl') {
        newDialFreq = currentDialFreq + shiftAmount;
    }

    // Clamp to valid range (100 kHz to 30 MHz)
    const MIN_FREQ = 100000;
    const MAX_FREQ = 30000000;
    newDialFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newDialFreq));
    newDialFreq = Math.round(newDialFreq);

    // Update frequency input
    freqInput.value = newDialFreq;
    updateBandButtons(newDialFreq);
    updateURL();

    // Tune to new frequency
    if (ws && ws.readyState === WebSocket.OPEN) {
        autoTune();
    }

    // Calculate adjusted dial frequency for display
    const adjustedDialFreq = newDialFreq - oscilloscopeFrequencyOffset;

    log(`Shifted ${currentMode.toUpperCase()} signal from ${detectedFreq.toFixed(1)} Hz to ${targetFreq} Hz (dial: ${formatFrequency(currentDialFreq)} → ${formatFrequency(newDialFreq)})`);
    if (oscilloscopeFrequencyOffset !== 0) {
        log(`Adjusted dial frequency (with ${oscilloscopeFrequencyOffset} Hz offset): ${formatFrequency(adjustedDialFreq)}`);
    }

    // Enable tracking mode
    frequencyTrackingStartFreq = newDialFreq;
    enableFrequencyTracking();

    if (button) {
        button.style.backgroundColor = '#28a745'; // Green when tracking
        button.textContent = 'Tracking: ON';
    }

    log('Frequency tracking enabled (click again to disable)');
}

// Enable frequency tracking
function enableFrequencyTracking() {
    if (frequencyTrackingInterval) {
        clearInterval(frequencyTrackingInterval);
    }

    frequencyTrackingEnabled = true;

    frequencyTrackingInterval = setInterval(() => {
        if (!frequencyTrackingEnabled || !analyser || !audioContext) {
            disableFrequencyTracking();
            return;
        }

        // Check if still in correct mode
        if (!['usb', 'lsb', 'cwu', 'cwl'].includes(currentMode)) {
            disableFrequencyTracking();
            log('Frequency tracking disabled (mode changed)', 'error');
            return;
        }

        // Get current detected frequency
        const bufferLength = analyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        const detectedFreq = detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);

        if (detectedFreq <= 0 || detectedFreq < 20 || detectedFreq > 20000) {
            // No valid signal, skip this update
            return;
        }

        const targetFreq = 1000;
        const currentError = targetFreq - detectedFreq;

        // Update lock status and button color
        const button = document.getElementById('set-1khz-btn');
        const wasLocked = frequencyTrackingLocked;
        frequencyTrackingLocked = Math.abs(currentError) <= TRACKING_LOCK_THRESHOLD;

        if (button) {
            if (frequencyTrackingLocked) {
                button.style.backgroundColor = '#28a745'; // Green when locked
                button.textContent = 'Tracking: LOCKED';
            } else {
                button.style.backgroundColor = '#fd7e14'; // Orange when adjusting
                button.textContent = 'Tracking: ADJUSTING';
            }
        }

        // Only adjust if error is above minimum threshold (0.5 Hz)
        if (Math.abs(currentError) < TRACKING_MIN_ERROR) {
            return;
        }

        // Add to history for smoothing
        frequencyTrackingHistory.push(currentError);
        if (frequencyTrackingHistory.length > TRACKING_HISTORY_SIZE) {
            frequencyTrackingHistory.shift();
        }

        // Need enough history before adjusting
        if (frequencyTrackingHistory.length < TRACKING_HISTORY_SIZE) {
            return;
        }

        // Calculate smoothed error (average of recent errors)
        const smoothedError = frequencyTrackingHistory.reduce((sum, e) => sum + e, 0) / frequencyTrackingHistory.length;

        // Check if all errors in history have the same sign (all positive or all negative)
        // This prevents oscillation by only adjusting when error is consistent
        const allSameSign = frequencyTrackingHistory.every(e => e * smoothedError > 0);
        if (!allSameSign) {
            // Errors are oscillating, clear history and wait for consistency
            frequencyTrackingHistory = [];
            return;
        }

        // Only adjust if smoothed error is still significant
        if (Math.abs(smoothedError) < TRACKING_MIN_ERROR) {
            return;
        }

        // Adaptive damping with three tiers to handle the final 1 Hz adjustment
        // When error is 1 Hz with 50% damping, it calculates 0.5 Hz which rounds unpredictably
        // Solution: use 100% correction for very small errors (≤2 Hz)
        let dampingFactor;
        if (Math.abs(smoothedError) > TRACKING_COARSE_THRESHOLD) {
            dampingFactor = TRACKING_DAMPING_COARSE;  // 30% for large errors (>10 Hz)
        } else if (Math.abs(smoothedError) > 2) {
            dampingFactor = TRACKING_DAMPING_FINE;     // 50% for medium errors (2-10 Hz)
        } else {
            dampingFactor = 1.0;                        // 100% for tiny errors (≤2 Hz) - nail it!
        }

        // Apply damping factor to prevent overshoot
        const shiftAmount = smoothedError * dampingFactor;

        // Get current dial frequency
        const freqInput = document.getElementById('frequency');
        const currentDialFreq = parseInt(freqInput.value);

        // Check drift from start frequency
        const driftFromStart = Math.abs(currentDialFreq - frequencyTrackingStartFreq);
        if (driftFromStart > TRACKING_DRIFT_LIMIT) {
            disableFrequencyTracking();
            log(`Frequency tracking disabled (drifted ${driftFromStart} Hz from start)`, 'error');
            return;
        }

        // Calculate new dial frequency
        let newDialFreq;
        if (currentMode === 'usb' || currentMode === 'cwu') {
            newDialFreq = currentDialFreq - shiftAmount;
        } else if (currentMode === 'lsb' || currentMode === 'cwl') {
            newDialFreq = currentDialFreq + shiftAmount;
        }

        // Clamp to valid range
        const MIN_FREQ = 100000;
        const MAX_FREQ = 30000000;
        newDialFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newDialFreq));
        newDialFreq = Math.round(newDialFreq);

        // Update frequency input
        freqInput.value = newDialFreq;
        updateBandButtons(newDialFreq);
        updateURL();

        // Tune to new frequency
        if (ws && ws.readyState === WebSocket.OPEN) {
            autoTune();
        }

    }, TRACKING_UPDATE_RATE);
}

// Disable frequency tracking
function disableFrequencyTracking() {
    frequencyTrackingEnabled = false;
    frequencyTrackingHistory = []; // Clear history
    frequencyTrackingStableCount = 0; // Reset stability counter
    frequencyTrackingLocked = false; // Reset lock status

    if (frequencyTrackingInterval) {
        clearInterval(frequencyTrackingInterval);
        frequencyTrackingInterval = null;
    }

    const button = document.getElementById('set-1khz-btn');
    if (button) {
        button.style.backgroundColor = '#6c757d'; // Gray
        button.textContent = 'Set 1 kHz';
    }
}

// Update audio spectrum tooltip with frequency and dB
function updateAudioSpectrumTooltip(clientX, clientY) {
    // Don't show tooltip if audio visualization is not enabled
    if (!audioVisualizationEnabled) {
        if (audioSpectrumTooltip) {
            audioSpectrumTooltip.style.display = 'none';
        }
        return;
    }

    if (!audioSpectrumTooltip || !audioSpectrumLastData || audioSpectrumMouseX < 0) {
        if (audioSpectrumTooltip) {
            audioSpectrumTooltip.style.display = 'none';
        }
        return;
    }

    const canvas = spectrumCanvas || waterfallCanvas;
    if (!canvas) return;

    const width = canvas.width;
    const x = audioSpectrumMouseX;

    // Calculate frequency from x position using shared mapping
    const freq = Math.round(pixelToFrequency(x, width));

    // Get magnitude at this x position from stored data
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return;

    const { startBinIndex, binsForBandwidth } = binMapping;
    const binsPerPixel = binsForBandwidth / width;
    const startBin = startBinIndex + (x * binsPerPixel);
    const endBin = startBin + binsPerPixel;

    // Average bins for this pixel
    let sum = 0;
    let count = 0;
    for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < audioSpectrumLastData.dataArray.length; binIndex++) {
        sum += audioSpectrumLastData.dataArray[binIndex] || 0;
        count++;
    }
    const magnitude = count > 0 ? sum / count : 0;

    // Convert magnitude to dB (same as display scale)
    const db = magnitude > 0 ? 20 * Math.log10(magnitude / 255) : -Infinity;
    const dbText = db === -Infinity ? '-∞ dB' : db.toFixed(1) + ' dB';

    // Format frequency
    const freqText = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${freq} Hz`;

    // Update tooltip
    audioSpectrumTooltip.textContent = `${freqText} | ${dbText}`;
    audioSpectrumTooltip.style.left = (clientX + 15) + 'px';
    audioSpectrumTooltip.style.top = (clientY - 10) + 'px';
    audioSpectrumTooltip.style.display = 'block';
}

// Detect frequency from waveform using zero-crossing detection
function detectFrequencyFromWaveform(dataArray, sampleRate) {
    if (!dataArray || dataArray.length < 2) return 0;

    // Find zero crossings (where signal crosses 128, the midpoint)
    const zeroCrossings = [];
    const threshold = 128;

    for (let i = 1; i < dataArray.length; i++) {
        const prev = dataArray[i - 1];
        const curr = dataArray[i];

        // Detect upward zero crossing (from below to above threshold)
        if (prev < threshold && curr >= threshold) {
            // Interpolate exact crossing point for better accuracy
            const fraction = (threshold - prev) / (curr - prev);
            const crossingIndex = (i - 1) + fraction;
            zeroCrossings.push(crossingIndex);
        }
    }

    // Need at least 2 crossings to measure a period
    if (zeroCrossings.length < 2) return 0;

    // Calculate average period between crossings
    let totalPeriod = 0;
    for (let i = 1; i < zeroCrossings.length; i++) {
        totalPeriod += zeroCrossings[i] - zeroCrossings[i - 1];
    }
    const avgPeriod = totalPeriod / (zeroCrossings.length - 1);

    // Convert period (in samples) to frequency
    const frequency = sampleRate / avgPeriod;

    // Sanity check: only return frequencies in audible range (20 Hz - 20 kHz)
    if (frequency < 20 || frequency > 20000) return 0;

    return frequency;
}

// Create cached canvas for dB scale labels (dynamic based on actual data range)
function createSpectrumLabelsCache(width, height, minDb, maxDb) {
    // Create offscreen canvas for labels
    const cache = document.createElement('canvas');
    cache.width = width;
    cache.height = height;
    const ctx = cache.getContext('2d');

    // Draw dB scale labels
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const dbRange = maxDb - minDb;
    if (dbRange === 0 || !isFinite(dbRange)) return cache;

    // Calculate appropriate dB step (aim for 5-8 major ticks)
    const targetStep = dbRange / 6;
    let dbStep;
    if (targetStep >= 20) dbStep = 20;
    else if (targetStep >= 10) dbStep = 10;
    else if (targetStep >= 5) dbStep = 5;
    else if (targetStep >= 2) dbStep = 2;
    else dbStep = 1;

    // Draw major ticks with labels
    const firstDb = Math.ceil(minDb / dbStep) * dbStep;
    for (let db = firstDb; db <= maxDb; db += dbStep) {
        // Calculate y position
        const y = ((maxDb - db) / dbRange) * height;

        // Draw horizontal grid line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();

        // Draw dB label with background (no "dB" text to save space)
        const label = db.toFixed(0);
        const labelWidth = ctx.measureText(label).width + 6;

        ctx.fillStyle = 'rgba(44, 62, 80, 0.8)';
        ctx.fillRect(2, y - 8, labelWidth, 16);

        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeText(label, 5, y);

        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, 5, y);
    }

    return cache;
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

    // Find min and max values in current frame (original simple approach)
    let currentMinMagnitude = 255;
    let currentMaxMagnitude = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const magnitude = dataArray[i];
        if (magnitude > 0) { // Ignore zero values
            currentMinMagnitude = Math.min(currentMinMagnitude, magnitude);
            currentMaxMagnitude = Math.max(currentMaxMagnitude, magnitude);
        }
    }

    // Temporal smoothing for stable display (like main graph mode)
    const now = Date.now();

    // Track minimum values over time for stable noise floor (2 second window)
    audioSpectrumMinHistory.push({ value: currentMinMagnitude, timestamp: now });
    audioSpectrumMinHistory = audioSpectrumMinHistory.filter(m => now - m.timestamp <= audioSpectrumMinHistoryMaxAge);
    const avgMinMagnitude = audioSpectrumMinHistory.length > 0
        ? audioSpectrumMinHistory.reduce((sum, m) => sum + m.value, 0) / audioSpectrumMinHistory.length
        : currentMinMagnitude;

    // Track maximum values over time for stable ceiling (20 second window)
    audioSpectrumMaxHistory.push({ value: currentMaxMagnitude, timestamp: now });
    audioSpectrumMaxHistory = audioSpectrumMaxHistory.filter(m => now - m.timestamp <= audioSpectrumMaxHistoryMaxAge);
    const avgMaxMagnitude = audioSpectrumMaxHistory.length > 0
        ? audioSpectrumMaxHistory.reduce((sum, m) => sum + m.value, 0) / audioSpectrumMaxHistory.length
        : currentMaxMagnitude;

    // Use smoothed minimum as floor, smoothed maximum as ceiling
    // This matches the main graph mode behavior exactly (spectrum-display.js lines 913-916)
    let minMagnitude = avgMinMagnitude;
    let maxMagnitude = avgMaxMagnitude;
    let magnitudeRange = maxMagnitude - minMagnitude;

    // Fallback to reasonable range if no valid data
    if (magnitudeRange <= 0 || !isFinite(magnitudeRange)) {
        minMagnitude = 0;
        maxMagnitude = 255;
        magnitudeRange = 255;
    }

    // Calculate dB scale from actual signal range - like main graph mode
    // Convert from magnitude (0-255) to approximate dBFS
    // dBFS = 20 * log10(magnitude / 255), where 255 = 0 dBFS
    const displayMinDb = minMagnitude > 0 ? 20 * Math.log10(minMagnitude / 255) : -60;
    const displayMaxDb = maxMagnitude > 0 ? 20 * Math.log10(maxMagnitude / 255) : -10;

    // Create or use cached labels if size changed OR range changed significantly (>1 dB)
    const cacheKey = `${width}x${height}_${Math.round(displayMinDb)}_${Math.round(displayMaxDb)}`;
    if (!spectrumLabelsCache || spectrumLabelsCache.cacheKey !== cacheKey) {
        spectrumLabelsCache = createSpectrumLabelsCache(width, height, displayMinDb, displayMaxDb);
        spectrumLabelsCache.cacheKey = cacheKey;
    }

    // Draw cached labels (much faster than redrawing text) - only if cache is valid
    if (spectrumLabelsCache && spectrumLabelsCache.width > 0 && spectrumLabelsCache.height > 0) {
        spectrumCtx.drawImage(spectrumLabelsCache, 0, 0);
    }

    // Get frequency bin mapping using shared helper
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return;

    const { startBinIndex, binsForBandwidth } = binMapping;

    // Draw as line graph (like main spectrum display)
    const numPoints = width;
    const binsPerPoint = binsForBandwidth / numPoints;

    // Create gradient for filled area using waterfall heat map colors
    // Black -> Blue -> Cyan -> Green -> Yellow -> Red -> White
    const gradient = spectrumCtx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(0, 0, 143, 0.8)');      // Dark blue at bottom
    gradient.addColorStop(0.2, 'rgba(0, 0, 255, 0.8)');    // Blue
    gradient.addColorStop(0.4, 'rgba(0, 255, 255, 0.8)');  // Cyan
    gradient.addColorStop(0.6, 'rgba(255, 255, 0, 0.8)');  // Yellow
    gradient.addColorStop(0.8, 'rgba(255, 0, 0, 0.8)');    // Red
    gradient.addColorStop(1, 'rgba(128, 0, 0, 0.8)');      // Dark red at top

    // Initialize peak hold array if needed
    if (!spectrumPeaks || spectrumPeaks.length !== numPoints) {
        spectrumPeaks = new Array(numPoints).fill(0);
    }

    const peakDecayRate = 0.5; // Pixels per frame to decay

    // Draw filled area
    spectrumCtx.fillStyle = gradient;
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, height); // Start at bottom left

    for (let i = 0; i < numPoints; i++) {
        // Average the bins for this point
        const startBin = startBinIndex + (i * binsPerPoint);
        const endBin = startBin + binsPerPoint;

        let sum = 0;
        let count = 0;

        for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < dataArray.length; binIndex++) {
            sum += dataArray[binIndex] || 0;
            count++;
        }

        const average = count > 0 ? sum / count : 0;

        // Normalize magnitude for autoranging
        let normalizedMagnitude;
        if (magnitudeRange > 0) {
            normalizedMagnitude = (average - minMagnitude) / magnitudeRange;
        } else {
            normalizedMagnitude = average / 255;
        }

        // Calculate y position (inverted - higher magnitude at top)
        const y = height - (normalizedMagnitude * height);

        // Update peak hold
        if (y < spectrumPeaks[i]) {
            spectrumPeaks[i] = y; // New peak (lower y = higher on screen)
        } else {
            spectrumPeaks[i] = Math.min(height, spectrumPeaks[i] + peakDecayRate); // Decay
        }

        spectrumCtx.lineTo(i, y);
    }

    // Close the path at bottom right
    spectrumCtx.lineTo(width, height);
    spectrumCtx.closePath();
    spectrumCtx.fill();

    // Draw peak hold line (light yellow, semi-transparent like main graph)
    spectrumCtx.strokeStyle = 'rgba(255, 255, 200, 0.5)';
    spectrumCtx.lineWidth = 1;
    spectrumCtx.beginPath();

    let firstPeak = true;
    for (let i = 0; i < numPoints; i++) {
        if (spectrumPeaks[i] < height) {
            if (firstPeak) {
                spectrumCtx.moveTo(i, spectrumPeaks[i]);
                firstPeak = false;
            } else {
                spectrumCtx.lineTo(i, spectrumPeaks[i]);
            }
        }
    }

    spectrumCtx.stroke();

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

    // Draw CW decoder frequency indicator if enabled
    if (cwDecoder && cwDecoder.enabled) {
        const cwFreq = cwDecoder.centerFrequency;

        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;

        // Only draw if within visible range
        if (cwFreq >= displayLow && cwFreq <= displayHigh) {
            // Draw center line (dark orange)
            const centerX = frequencyToPixel(cwFreq, width);
            spectrumCtx.strokeStyle = 'rgba(255, 140, 0, 0.9)'; // Dark orange
            spectrumCtx.lineWidth = 2;
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(centerX, 0);
            spectrumCtx.lineTo(centerX, height);
            spectrumCtx.stroke();

            // Add label at top
            spectrumCtx.font = 'bold 10px monospace';
            spectrumCtx.textAlign = 'center';
            spectrumCtx.textBaseline = 'top';

            const label = 'CW';
            const labelWidth = spectrumCtx.measureText(label).width + 6;

            spectrumCtx.fillStyle = 'rgba(255, 140, 0, 0.95)';
            spectrumCtx.fillRect(centerX - labelWidth / 2, 2, labelWidth, 12);

            spectrumCtx.fillStyle = '#000000';
            spectrumCtx.fillText(label, centerX, 4);
        }
    }

    // Draw debug info at top right (peak signal and noise floor)
    spectrumCtx.font = 'bold 11px monospace';
    spectrumCtx.textAlign = 'right';
    spectrumCtx.textBaseline = 'top';

    // Convert to dB for display
    const peakDb = maxMagnitude > 0 ? (20 * Math.log10(maxMagnitude / 255)).toFixed(1) : '-∞';
    const noiseDb = minMagnitude > 0 ? (20 * Math.log10(minMagnitude / 255)).toFixed(1) : '-∞';

    // Background for debug info
    const debugText1 = `Peak: ${peakDb} dB`;
    const debugText2 = `Floor: ${noiseDb} dB`;
    const debugWidth = Math.max(
        spectrumCtx.measureText(debugText1).width,
        spectrumCtx.measureText(debugText2).width
    ) + 8;

    spectrumCtx.fillStyle = 'rgba(44, 62, 80, 0.9)';
    spectrumCtx.fillRect(width - debugWidth - 4, 2, debugWidth, 28);

    // Draw text with outline for visibility
    spectrumCtx.strokeStyle = '#000000';
    spectrumCtx.lineWidth = 3;
    spectrumCtx.fillStyle = '#ffffff';

    spectrumCtx.strokeText(debugText1, width - 6, 4);
    spectrumCtx.fillText(debugText1, width - 6, 4);

    spectrumCtx.strokeText(debugText2, width - 6, 16);
    spectrumCtx.fillText(debugText2, width - 6, 16);

    // Store spectrum data for tooltip usage
    audioSpectrumLastData = {
        dataArray: new Uint8Array(dataArray),
        timestamp: Date.now()
    };

    // Update tooltip content with new data if mouse is over THIS canvas
    if (audioSpectrumMouseX >= 0 && audioSpectrumMouseY >= 0 &&
        audioVisualizationEnabled && audioSpectrumActiveCanvas === spectrumCanvas) {
        // Get the rect to calculate client coordinates
        const rect = spectrumCanvas.getBoundingClientRect();
        const clientX = rect.left + audioSpectrumMouseX;
        const clientY = rect.top + audioSpectrumMouseY;
        updateAudioSpectrumTooltip(clientX, clientY);
    }

    // Draw frequency labels in Hz
    spectrumCtx.fillStyle = '#000000';
    spectrumCtx.font = '10px monospace';
    spectrumCtx.textAlign = 'center';

    // Calculate appropriate label spacing based on bandwidth
    // Dynamically adjust to ensure we always show labels
    const audioBandwidth = Math.abs(currentBandwidthHigh - currentBandwidthLow);
    let labelStep;
    if (audioBandwidth <= 100) {
        labelStep = 20;  // Very narrow (CW): 20 Hz steps
    } else if (audioBandwidth <= 200) {
        labelStep = 50;  // Narrow CW: 50 Hz steps
    } else if (audioBandwidth <= 500) {
        labelStep = 100; // Narrow: 100 Hz steps
    } else if (audioBandwidth <= 1000) {
        labelStep = 200; // Medium-narrow: 200 Hz steps
    } else if (audioBandwidth <= 2000) {
        labelStep = 250; // Medium: 250 Hz steps
    } else if (audioBandwidth <= 5000) {
        labelStep = 500; // Wide: 500 Hz steps
    } else {
        labelStep = 1000; // Very wide: 1 kHz steps
    }

    // Draw labels from low to high frequency using shared mapping
    // Account for CW offset in display coordinates
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    const displayLow = cwOffset + currentBandwidthLow;
    const displayHigh = cwOffset + currentBandwidthHigh;

    const startFreq = Math.ceil(displayLow / labelStep) * labelStep;
    for (let freq = startFreq; freq <= displayHigh; freq += labelStep) {
        const x = frequencyToPixel(freq, width);
        // Show the actual audio frequency (freq already includes CW offset)
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

    // Scroll the entire waterfall down by 1 pixel
    waterfallCtx.drawImage(waterfallCanvas, 0, 0, width, height - 1, 0, 1, width, height - 1);

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

    // Store spectrum data for tooltip usage (waterfall uses same data)
    audioSpectrumLastData = {
        dataArray: new Uint8Array(dataArray),
        timestamp: Date.now()
    };

    // Update tooltip content with new data if mouse is over THIS canvas
    if (audioSpectrumMouseX >= 0 && audioSpectrumMouseY >= 0 &&
        audioVisualizationEnabled && audioSpectrumActiveCanvas === waterfallCanvas) {
        // Get the rect to calculate client coordinates
        const rect = waterfallCanvas.getBoundingClientRect();
        const clientX = rect.left + audioSpectrumMouseX;
        const clientY = rect.top + audioSpectrumMouseY;
        updateAudioSpectrumTooltip(clientX, clientY);
    }

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
        waterfallCtx.font = 'bold 11px monospace';
        const textWidth = waterfallCtx.measureText(timestamp).width;
        waterfallCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        waterfallCtx.fillRect(0, 0, textWidth + 6, 16);

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
    // Dynamically adjust to ensure we always show labels
    const audioBandwidth = Math.abs(currentBandwidthHigh - currentBandwidthLow);
    let labelStep;
    if (audioBandwidth <= 100) {
        labelStep = 20;  // Very narrow (CW): 20 Hz steps
    } else if (audioBandwidth <= 200) {
        labelStep = 50;  // Narrow CW: 50 Hz steps
    } else if (audioBandwidth <= 500) {
        labelStep = 100; // Narrow: 100 Hz steps
    } else if (audioBandwidth <= 1000) {
        labelStep = 200; // Medium-narrow: 200 Hz steps
    } else if (audioBandwidth <= 2000) {
        labelStep = 250; // Medium: 250 Hz steps
    } else if (audioBandwidth <= 5000) {
        labelStep = 500; // Wide: 500 Hz steps
    } else {
        labelStep = 1000; // Very wide: 1 kHz steps
    }

    // Major ticks and labels using shared mapping
    // Account for CW offset in display coordinates
    const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
    const displayLow = cwOffset + currentBandwidthLow;
    const displayHigh = cwOffset + currentBandwidthHigh;

    const startFreq = Math.ceil(displayLow / labelStep) * labelStep;
    for (let freq = startFreq; freq <= displayHigh; freq += labelStep) {
        const x = frequencyToPixel(freq, width);

        // Draw major tick mark (white)
        waterfallCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        waterfallCtx.fillRect(x - 1, height - 30, 2, 12);

        // Draw label with strong contrast
        waterfallCtx.fillStyle = '#ffffff';
        waterfallCtx.strokeStyle = '#000000';
        waterfallCtx.lineWidth = 3;

        // Show the actual audio frequency (freq already includes CW offset)
        const label = freq + ' Hz';
        waterfallCtx.strokeText(label, x, height - 10);
        waterfallCtx.fillText(label, x, height - 10);
    }

    // Minor ticks (half of label step) using shared mapping
    const minorStep = labelStep / 2;
    waterfallCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    const minorStartFreq = Math.ceil(displayLow / minorStep) * minorStep;
    for (let freq = minorStartFreq; freq < displayHigh; freq += minorStep) {
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

        // Draw CW decoder frequency indicator if enabled
        if (cwDecoder && cwDecoder.enabled) {
            const cwFreq = cwDecoder.centerFrequency;

            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;

            // Only draw if within visible range
            if (cwFreq >= displayLow && cwFreq <= displayHigh) {
                // CRITICAL: Account for CSS scale(0.75) on .audio-visualization-section
                const cssScale = 0.75;
                const scaledWidth = waterfallOverlayCanvas.width / cssScale;

                // Draw center line (dark orange solid) on overlay - full height
                const centerX = frequencyToPixel(cwFreq, scaledWidth);
                waterfallOverlayCtx.strokeStyle = 'rgba(255, 140, 0, 0.9)'; // Dark orange
                waterfallOverlayCtx.lineWidth = 2 / cssScale;
                waterfallOverlayCtx.beginPath();
                waterfallOverlayCtx.moveTo(centerX, 0);
                waterfallOverlayCtx.lineTo(centerX, waterfallOverlayCanvas.height);
                waterfallOverlayCtx.stroke();
            }
        }
    }
}



// Pre-computed color lookup table for waterfall (256 entries)
// Heat map: black -> blue -> cyan -> green -> yellow -> red -> white
let colorLookupTable = null;

function initializeColorLookupTable() {
    colorLookupTable = new Array(256);

    for (let magnitude = 0; magnitude < 256; magnitude++) {
        const normalized = magnitude / 255;
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

        colorLookupTable[magnitude] = { r, g, b };
    }
}

// Convert magnitude (0-255) to heat map color using lookup table
function magnitudeToColor(magnitude) {
    // Initialize lookup table on first use
    if (!colorLookupTable) {
        initializeColorLookupTable();
    }

    // Clamp magnitude to valid range and use lookup table
    const index = Math.max(0, Math.min(255, Math.floor(magnitude)));
    return colorLookupTable[index];
}

// Get optimal FFT size based on current bandwidth
function getOptimalFFTSize() {
    const bandwidth = Math.abs(currentBandwidthHigh - currentBandwidthLow);

    // Target: maintain good bin density across all bandwidths
    // At 48kHz sample rate, each FFT size gives:
    // 2048  -> 11.72 Hz/bin (very coarse)
    // 4096  -> 5.86 Hz/bin (coarse)
    // 8192  -> 2.93 Hz/bin (medium)
    // 16384 -> 1.46 Hz/bin (fine)
    // 32768 -> 0.73 Hz/bin (very fine)
    // 65536 -> 0.37 Hz/bin (ultra fine)

    if (bandwidth < 300) {
        return 65536;  // Very narrow CW: ultra fine resolution (0.37 Hz/bin)
    } else if (bandwidth < 600) {
        return 32768;  // CW modes: very fine resolution (0.73 Hz/bin)
    } else if (bandwidth < 1500) {
        return 16384;  // Narrow modes: fine resolution (1.46 Hz/bin)
    } else if (bandwidth < 4000) {
        return 16384;  // Medium modes: fine resolution (1.46 Hz/bin)
    } else {
        return 8192;   // Wide modes: medium resolution (2.93 Hz/bin)
    }
}

// Update FFT size dropdown to match current analyser setting
function updateFFTSizeDropdown() {
    if (!analyser) return;

    const dropdown = document.getElementById('fft-size');
    if (dropdown) {
        dropdown.value = analyser.fftSize.toString();
    }
}

// Update FFT size (called when user manually changes dropdown)
function updateFFTSize() {
    if (!analyser) return;

    const newFFTSize = parseInt(document.getElementById('fft-size').value);
    const oldFFTSize = analyser.fftSize;

    analyser.fftSize = newFFTSize;

    // Force update the display to reflect new FFT size
    updateOscilloscopeZoom();

    // Log the change with both old and new values for debugging
    log(`FFT size changed from ${oldFFTSize} to ${newFFTSize} (${(newFFTSize / 2).toLocaleString()} frequency bins)`);
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

    // Calculate actual time window being displayed using logarithmic scale
    // This provides intuitive control across the entire range
    if (analyser && audioContext) {
        const bufferLength = analyser.fftSize;
        const sampleRate = audioContext.sampleRate;
        const totalTimeMs = (bufferLength / sampleRate) * 1000;

        // Use logarithmic scale for smooth, intuitive control
        // Slider 1 = minimum zoom (1/200 of buffer), Slider 200 = maximum zoom (full buffer)
        // Formula: displayedTime = totalTime * (10^((slider-1)/100))
        // This gives us a 100:1 range with smooth transitions
        const minFraction = 0.005; // Show at least 0.5% of buffer (1/200)
        const maxFraction = 1.0;    // Show full buffer at max

        // Logarithmic interpolation between min and max
        const logMin = Math.log10(minFraction);
        const logMax = Math.log10(maxFraction);
        const logRange = logMax - logMin;

        // Map slider (1-200) to log range
        const normalizedSlider = (sliderValue - 1) / 199; // 0 to 1
        const logValue = logMin + (normalizedSlider * logRange);
        const fraction = Math.pow(10, logValue);

        const displayedTimeMs = totalTimeMs * fraction;

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

// Toggle auto sync oscilloscope (trigger lock on/off)
function autoSyncOscilloscope() {
    const button = document.getElementById('auto-sync-btn');

    // If already enabled, disable it
    if (oscilloscopeTriggerEnabled) {
        oscilloscopeTriggerEnabled = false;
        oscilloscopeTriggerFreq = 0;
        if (button) {
            button.style.backgroundColor = '#17a2b8'; // Cyan when off
            button.textContent = 'Auto Sync';
        }
        log('Oscilloscope trigger disabled (free run)');
        return;
    }

    // Otherwise, enable trigger and adjust timebase
    if (!analyser || !audioContext) {
        log('Audio not initialized', 'error');
        return;
    }

    // Use FFT to find the strongest frequency component (more robust than zero-crossing with noise)
    const bufferLength = analyser.fftSize;
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(frequencyData);

    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    // Find the bin with maximum magnitude
    let maxMagnitude = 0;
    let maxBinIndex = 0;

    for (let i = 0; i < frequencyData.length; i++) {
        if (frequencyData[i] > maxMagnitude) {
            maxMagnitude = frequencyData[i];
            maxBinIndex = i;
        }
    }

    // Check if we have a strong enough signal
    if (maxMagnitude < 50) {
        log('No strong signal detected for auto sync (signal too weak)', 'error');
        return;
    }

    // Convert bin index to frequency
    const detectedFreq = (maxBinIndex / frequencyData.length) * nyquist;

    if (detectedFreq < 20 || detectedFreq > 20000) {
        log('Detected frequency out of range for auto sync', 'error');
        return;
    }

    // Calculate period of the signal
    const periodSeconds = 1 / detectedFreq;
    const periodMs = periodSeconds * 1000;

    // We want to show 2-3 complete cycles on screen
    // The oscilloscope has 8 horizontal divisions
    // So we want each division to show about 1/3 of a cycle
    const targetCycles = 2.5; // Show 2.5 cycles across the screen
    const targetTimeMs = periodMs * targetCycles;

    // Calculate what zoom level gives us this time window using logarithmic scale
    const totalBufferTimeMs = (bufferLength / audioContext.sampleRate) * 1000;

    // Calculate target fraction of buffer to display
    const targetFraction = targetTimeMs / totalBufferTimeMs;

    // Reverse the logarithmic calculation to find slider value
    const minFraction = 0.005;
    const maxFraction = 1.0;
    const logMin = Math.log10(minFraction);
    const logMax = Math.log10(maxFraction);
    const logRange = logMax - logMin;

    // Clamp target fraction to valid range
    const clampedFraction = Math.max(minFraction, Math.min(maxFraction, targetFraction));

    // Calculate normalized slider position (0 to 1)
    const logValue = Math.log10(clampedFraction);
    const normalizedSlider = (logValue - logMin) / logRange;

    // Convert to slider value (1 to 200)
    const targetSliderValue = Math.round(1 + (normalizedSlider * 199));

    // Clamp to valid range (1-200)
    const clampedValue = Math.max(1, Math.min(200, targetSliderValue));

    // Update the slider
    const slider = document.getElementById('oscilloscope-zoom');
    if (slider) {
        slider.value = clampedValue;
        oscilloscopeZoom = clampedValue;
        updateOscilloscopeZoom();
    }

    // Enable continuous trigger tracking
    oscilloscopeTriggerEnabled = true;
    oscilloscopeTriggerFreq = detectedFreq;

    // Update button appearance
    if (button) {
        button.style.backgroundColor = '#28a745'; // Green when locked
        button.textContent = 'Trigger: ON';
    }

    log(`Auto sync: ${detectedFreq.toFixed(1)} Hz signal, timebase adjusted to show ${targetCycles} cycles (trigger locked)`);
}
// Toggle auto scale oscilloscope Y-axis (continuous adjustment on/off)
function autoScaleOscilloscope() {
    const button = document.getElementById('auto-scale-btn');

    // Toggle the state
    oscilloscopeAutoScaleEnabled = !oscilloscopeAutoScaleEnabled;

    if (oscilloscopeAutoScaleEnabled) {
        if (button) {
            button.style.backgroundColor = '#28a745'; // Green when enabled
            button.textContent = 'Auto Scale: ON';
        }
        log('Oscilloscope auto scale enabled (continuous adjustment)');
    } else {
        // Reset to 1:1 when disabled
        oscilloscopeYScale = 1.0;
        if (button) {
            button.style.backgroundColor = '#17a2b8'; // Cyan when off
            button.textContent = 'Auto Scale';
        }
        log('Oscilloscope auto scale disabled (reset to 1:1)');
    }
}


// Keepalive is now handled by idle-detector.js (activity-based heartbeats)
// Fixed 30-second interval removed to allow proper idle detection

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

// Initialize bandpass filter (configurable cascaded stages for adjustable rolloff)
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
    const stages = parseInt(document.getElementById('bandpass-stages').value);
    const autoQ = document.getElementById('bandpass-auto-q').checked;
    const qMultiplier = parseFloat(document.getElementById('bandpass-q-multiplier').value);

    // Calculate Q value
    let Q;
    if (autoQ) {
        // Auto mode: use a LOW Q for each stage to avoid resonance/ringing
        // For cascaded filters, each stage multiplies the effect, so use very low Q
        // Q = center / width gives the basic bandwidth, but we need much lower for multiple stages
        Q = Math.max(0.7, center / (width * stages));
    } else {
        // Manual mode: apply multiplier to auto-calculated Q
        const baseQ = Math.max(0.7, center / (width * stages));
        Q = baseQ * qMultiplier;
    }

    // Create cascaded bandpass filters for steep rolloff
    // Each stage adds 12 dB/octave, so N stages = N*12 dB/octave
    // Note: Do NOT chain them permanently here - they will be chained per-buffer
    for (let i = 0; i < stages; i++) {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = center;
        filter.Q.value = Q;

        bandpassFilters.push(filter);
    }

    const rolloff = stages * 12;
    log(`Bandpass filter initialized: ${center} Hz ± ${width/2} Hz, Q=${Q.toFixed(2)}, ${stages}-stage cascade (${rolloff} dB/octave rolloff)`);
}

// Update bandpass filter parameters
function updateBandpassFilter() {
    const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
    const width = parseInt(document.getElementById('bandpass-width').value);
    const stages = parseInt(document.getElementById('bandpass-stages').value);
    const autoQ = document.getElementById('bandpass-auto-q').checked;
    const qMultiplier = parseFloat(document.getElementById('bandpass-q-multiplier').value);

    // Show/hide Q multiplier control based on Auto Q checkbox
    const qControl = document.getElementById('bandpass-q-control');
    if (qControl) {
        qControl.style.display = autoQ ? 'none' : 'block';
    }

    // Update display values
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

    // If number of stages changed, reinitialize filters
    if (bandpassFilters.length !== stages) {
        if (audioContext) {
            initializeBandpassFilter();
        }
        return;
    }

    // If no filters exist yet, initialize them
    if (bandpassFilters.length === 0) {
        if (audioContext) {
            initializeBandpassFilter();
        }
        return;
    }

    // For LSB mode, slider shows positive values but filter needs negative frequencies
    // Convert back to negative for the actual audio filter
    const actualCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;

    // Calculate Q value
    let Q;
    if (autoQ) {
        // Auto mode: adjust Q based on number of stages
        Q = Math.max(0.7, Math.abs(actualCenter) / (width * stages));
    } else {
        // Manual mode: apply multiplier to auto-calculated Q
        const baseQ = Math.max(0.7, Math.abs(actualCenter) / (width * stages));
        Q = baseQ * qMultiplier;
    }

    console.log(`updateBandpassFilter: sliderCenter=${sliderCenter}, actualCenter=${actualCenter}, width=${width}, stages=${stages}, Q=${Q.toFixed(2)}, autoQ=${autoQ}`);

    // Update all filter stages with actual frequency (negative for LSB)
    for (let filter of bandpassFilters) {
        filter.frequency.value = Math.abs(actualCenter); // Web Audio API uses absolute frequencies
        filter.Q.value = Q;
    }

    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {  // 5% chance to log
        const rolloff = stages * 12;
        log(`Bandpass: ${sliderCenter} Hz ± ${width/2} Hz (Q=${Q.toFixed(2)}, ${stages}-stage, ${rolloff} dB/oct)`);
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

    // Default bandwidth for new notch (narrower for CW signals)
    const defaultWidth = 50; // Hz (reduced from 100 for better CW performance)

    // centerFreq comes from click handler and may be negative in LSB mode
    // Store it as-is for display purposes
    // Create notch filter object with TRUE notch filters (infinite attenuation at center)
    const notch = {
        center: centerFreq,  // Store display value (negative for LSB)
        width: defaultWidth,
        filters: []
    };

    console.log(`addNotchFilter: centerFreq=${centerFreq}, abs=${Math.abs(centerFreq)}`);

    // Create 6 cascaded TRUE notch filters for VERY deep attenuation
    // Web Audio API notch filters provide ~20-30 dB attenuation per stage at center
    // 6 stages = 120-180 dB total attenuation (essentially complete elimination)
    // Q controls the bandwidth: higher Q = narrower notch
    for (let i = 0; i < 6; i++) {
        const filter = audioContext.createBiquadFilter();
        filter.type = 'notch';  // TRUE notch filter (not peaking)
        // Web Audio API uses absolute frequencies
        filter.frequency.value = Math.abs(centerFreq);
        // Very high Q for extremely narrow notch - critical for CW signals
        // Use even higher Q for sharper notch (Q = center / (width / 4))
        filter.Q.value = Math.max(20, Math.abs(centerFreq) / (defaultWidth / 4));
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

    log(`True notch filter added at ${centerFreq} Hz (±${defaultWidth/2} Hz, 6-stage cascade for 120-180 dB attenuation)`);
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

    if (centerInput && widthInput) {
        const sliderCenter = parseInt(centerInput.value);
        const width = parseInt(widthInput.value);

        // Slider shows positive values (50-2700)
        // For LSB mode, convert back to negative for display coordinates
        const displayCenter = (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) ? -sliderCenter : sliderCenter;

        // Very high Q for extremely narrow notch - critical for CW signals
        // Use even higher Q for sharper notch (Q = center / (width / 4))
        const Q = Math.max(20, Math.abs(displayCenter) / (width / 4));

        notch.center = displayCenter; // Store display value (negative for LSB)
        notch.width = width;

        console.log(`updateNotchFilterParams[${index}]: sliderCenter=${sliderCenter}, displayCenter=${displayCenter}, width=${width}, Q=${Q.toFixed(2)}`);

        // Update all filter stages in this notch
        // Web Audio API uses absolute frequencies
        for (let filter of notch.filters) {
            filter.frequency.value = Math.abs(displayCenter);
            filter.Q.value = Q;
            // True notch filters provide ~20-30 dB per stage, 6 stages = 120-180 dB total
        }

        // Update display values (show positive)
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
                <span class="notch-filter-title">Notch ${index + 1} (True Notch)</span>
                <button onclick="removeNotchFilter(${index})" class="notch-remove-btn">✕</button>
            </div>
            <div class="control-group">
                <label for="notch-center-${index}">Center: <span id="notch-center-value-${index}">${sliderValue} Hz</span></label>
                <input type="range" id="notch-center-${index}" min="${sliderMin}" max="${sliderMax}" value="${sliderValue}" step="10" oninput="updateNotchFilterParams(${index})">
            </div>
            <div class="control-group">
                <label for="notch-width-${index}">Width: <span id="notch-width-value-${index}">${notch.width} Hz</span></label>
                <input type="range" id="notch-width-${index}" min="10" max="200" value="${notch.width}" step="5" oninput="updateNotchFilterParams(${index})">
            </div>
            <div class="info-text" style="color: #888; font-size: 0.9em; margin-top: 5px;">
                120-180 dB attenuation (6-stage cascade)
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
        if (cwDecoder) {
            cwDecoder.setWPM(wpm);
        }
    }

    function updateCWDecoderThreshold() {
        const threshold = parseFloat(document.getElementById('cw-threshold').value);
        document.getElementById('cw-threshold-value').textContent = threshold.toFixed(4);
        if (cwDecoder) {
            cwDecoder.setThreshold(threshold);
        }
    }

    function updateCWDecoderFrequency() {
        const freq = parseInt(document.getElementById('cw-frequency').value);
        document.getElementById('cw-frequency-value').textContent = freq;
        if (cwDecoder) {
            cwDecoder.setCenterFrequency(freq);
        }
    }

    function resetCWDecoderWPM() {
        if (cwDecoder) {
            cwDecoder.resetWPM();
        }
    }

    // Hunt for CW signals - always finds the strongest bin in the audio spectrum
    function huntCWSignal() {
        if (!analyser) {
            log('Audio not initialized', 'error');
            return;
        }

        // Get frequency data
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);

        const sampleRate = audioContext.sampleRate;
        const nyquist = sampleRate / 2;

        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;

        // Find the strongest bin within our bandwidth
        let maxMagnitude = 0;
        let maxFreq = 0;
        let maxBinIndex = -1;

        for (let i = 0; i < dataArray.length; i++) {
            const freq = (i / dataArray.length) * nyquist;

            // Only look within our audio bandwidth
            if (freq < displayLow || freq > displayHigh) continue;

            const magnitude = dataArray[i];

            // Track the strongest bin
            if (magnitude > maxMagnitude) {
                maxMagnitude = magnitude;
                maxFreq = freq;
                maxBinIndex = i;
            }
        }

        if (maxBinIndex === -1 || maxMagnitude < 50) {
            log('No CW signals found - try adjusting threshold or check audio', 'error');
            return;
        }

        // Update frequency slider to the strongest bin
        const freqSlider = document.getElementById('cw-frequency');
        const targetFreq = Math.round(maxFreq);

        if (freqSlider) {
            freqSlider.value = targetFreq;
            updateCWDecoderFrequency();
        }

        log(`Hunt: Found strongest signal at ${targetFreq} Hz (strength: ${maxMagnitude}/255)`);
    }

    // Shift CW signal to 500 Hz by adjusting dial frequency
    function shiftCWSignalTo700Hz() {
        if (!cwDecoder || !cwDecoder.enabled) {
            log('CW Decoder not enabled', 'error');
            return;
        }

        // Get current locked frequency
        const lockedFreq = cwDecoder.centerFrequency;
        const targetFreq = 500; // Target audio frequency (CW offset center)
        const shiftAmount = targetFreq - lockedFreq;

        // Get current dial frequency
        const freqInput = document.getElementById('frequency');
        const currentDialFreq = parseInt(freqInput.value);

        // Calculate new dial frequency based on mode
        // In CW modes, the dial frequency is the RF carrier
        // Audio frequency = RF signal - RF carrier (for CWU) or RF carrier - RF signal (for CWL)
        // To move a signal DOWN in audio, we move the dial UP (and vice versa)
        let newDialFreq;
        if (currentMode === 'cwu') {
            // CWU: To decrease audio freq, increase dial freq (inverse relationship)
            newDialFreq = currentDialFreq - shiftAmount;
        } else if (currentMode === 'cwl') {
            // CWL: To decrease audio freq, decrease dial freq (same relationship due to inversion)
            newDialFreq = currentDialFreq + shiftAmount;
        } else {
            log('Not in CW mode', 'error');
            return;
        }

        // Clamp to valid range (100 kHz to 30 MHz)
        const MIN_FREQ = 100000;
        const MAX_FREQ = 30000000;
        newDialFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newDialFreq));

        // Update frequency input
        freqInput.value = newDialFreq;
        updateBandButtons(newDialFreq);

        // Update CW decoder frequency to 500 Hz
        const cwFreqSlider = document.getElementById('cw-frequency');
        if (cwFreqSlider) {
            cwFreqSlider.value = targetFreq;
            updateCWDecoderFrequency();
        }

        // Update URL
        updateURL();

        // Tune to new frequency
        if (ws && ws.readyState === WebSocket.OPEN) {
            autoTune();
        }

        log(`Shifted ${currentMode.toUpperCase()} signal from ${lockedFreq} Hz to ${targetFreq} Hz (dial: ${formatFrequency(currentDialFreq)} → ${formatFrequency(newDialFreq)})`);
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
        nr2.setParameters(noiseReductionStrength, noiseReductionFloor, 1.0);

        // Create script processor
        const bufferSize = 2048;
        noiseReductionProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        noiseReductionProcessor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const output = e.outputBuffer.getChannelData(0);

            // Process through NR2
            nr2.process(input, output);
        };

        // Create makeup gain node
        noiseReductionMakeupGain = audioContext.createGain();
        noiseReductionMakeupGain.gain.value = Math.pow(10, -3 / 20); // Default -3 dB

        // Create analyser to monitor NR2 output for clipping detection
        noiseReductionAnalyser = audioContext.createAnalyser();
        noiseReductionAnalyser.fftSize = 2048;
        noiseReductionAnalyser.smoothingTimeConstant = 0;

        log('✅ NR2 Noise Reduction initialized with makeup gain and clipping detection');
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
    const adaptRateSlider = document.getElementById('noise-reduction-adapt-rate');
    const makeupGainSlider = document.getElementById('noise-reduction-makeup-gain');

    if (strengthSlider) {
        noiseReductionStrength = parseFloat(strengthSlider.value);
        document.getElementById('noise-reduction-strength-value').textContent = noiseReductionStrength + '%';
    }

    if (floorSlider) {
        noiseReductionFloor = parseFloat(floorSlider.value);
        document.getElementById('noise-reduction-floor-value').textContent = noiseReductionFloor + '%';
    }

    let adaptRate = 1.0; // Default value
    if (adaptRateSlider) {
        adaptRate = parseFloat(adaptRateSlider.value);
        document.getElementById('noise-reduction-adapt-rate-value').textContent = adaptRate.toFixed(1) + '%';
    }

    // Update makeup gain
    if (makeupGainSlider && noiseReductionMakeupGain) {
        const makeupGainDb = parseFloat(makeupGainSlider.value);
        noiseReductionMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);
        document.getElementById('noise-reduction-makeup-gain-value').textContent = (makeupGainDb >= 0 ? '+' : '') + makeupGainDb + ' dB';
    }

    // Update NR2 processor parameters
    if (nr2) {
        nr2.setParameters(noiseReductionStrength, noiseReductionFloor, adaptRate);
    }
}

// Show noise reduction clipping indicator
function showNoiseReductionClipIndicator() {
    const indicator = document.getElementById('noise-reduction-clip-indicator');
    if (!indicator) return;

    // Show the indicator
    indicator.style.display = 'inline';
    noiseReductionClipping = true;

    // Clear any existing timeout
    if (noiseReductionClipIndicatorTimeout) {
        clearTimeout(noiseReductionClipIndicatorTimeout);
    }

    // Hide after 2 seconds of no clipping
    noiseReductionClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        noiseReductionClipping = false;
    }, 2000);
}

// Show stereo virtualizer clipping indicator
function showStereoClipIndicator() {
    const indicator = document.getElementById('stereo-virtualizer-clip-indicator');
    if (!indicator) return;

    // Show the indicator
    indicator.style.display = 'inline';
    stereoClipping = true;

    // Clear any existing timeout
    if (stereoClipIndicatorTimeout) {
        clearTimeout(stereoClipIndicatorTimeout);
    }

    // Hide after 2 seconds of no clipping
    stereoClipIndicatorTimeout = setTimeout(() => {
        indicator.style.display = 'none';
        stereoClipping = false;
    }, 2000);
}

// Toggle noise reduction on/off
function toggleNoiseReduction() {
    const checkbox = document.getElementById('noise-reduction-enable');
    const statusBadge = document.getElementById('noise-reduction-status-badge');
    const quickToggleBtn = document.getElementById('nr2-quick-toggle');

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

        // Update quick toggle button appearance
        if (quickToggleBtn) {
            quickToggleBtn.style.backgroundColor = '#28a745'; // Green when enabled
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

        // Update quick toggle button appearance
        if (quickToggleBtn) {
            quickToggleBtn.style.backgroundColor = '#fd7e14'; // Orange when disabled
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

                // Update URL with new frequency
                updateURL();

                // Check if fully zoomed out (zoom level = 1.0)
                if (spectrumDisplay && spectrumDisplay.zoomLevel <= 1.0) {
                    // Fully zoomed out - perform max zoom at clicked frequency
                    if (spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
                        spectrumDisplay.ws.send(JSON.stringify({
                            type: 'zoom',
                            frequency: Math.round(freq),
                            binBandwidth: 1.0  // Maximum zoom (1 Hz/bin)
                        }));
                        log(`Tuned to ${formatFrequency(freq)} and zoomed to max from spectrum click`);
                    }

                    // Connect if not already connected
                    if (!ws || ws.readyState !== WebSocket.OPEN) {
                        connect();
                    } else {
                        autoTune();
                    }
                } else {
                    // Already zoomed in - just tune
                    if (!ws || ws.readyState !== WebSocket.OPEN) {
                        connect();
                        log(`Connecting and tuning to ${formatFrequency(freq)} from spectrum click`);
                    } else {
                        autoTune();
                        log(`Tuned to ${formatFrequency(freq)} from spectrum click`);
                    }
                }
            }
        });

        // Expose for idle detector
        window.spectrumDisplay = spectrumDisplay;

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

function toggleSpectrumLineGraph() {
    if (!spectrumDisplay) return;

    spectrumDisplay.toggleLineGraph();

    // Update button appearance and text based on mode
    const button = document.getElementById('spectrum-line-graph-toggle');
    if (button) {
        if (spectrumDisplay.displayMode === 'waterfall') {
            // Waterfall mode - button shows what's next (Split)
            button.style.background = '';
            button.style.color = '';
            button.textContent = 'Split';
        } else if (spectrumDisplay.displayMode === 'split') {
            // Split mode - button shows what's next (Graph) - keep green
            button.style.background = '#28a745';
            button.style.color = 'white';
            button.textContent = 'Graph';
        } else {
            // Graph mode - button shows what's next (Waterfall)
            button.style.background = '#28a745';
            button.style.color = 'white';
            button.textContent = 'Waterfall';
        }
    }
}

// Initialize button text for split mode default
document.addEventListener('DOMContentLoaded', () => {
    // Wait for spectrum display to be initialized
    setTimeout(() => {
        const button = document.getElementById('spectrum-line-graph-toggle');
        if (button && spectrumDisplay && spectrumDisplay.displayMode === 'split') {
            button.style.background = '#28a745';
            button.style.color = 'white';
            button.textContent = 'Graph';
        }
    }, 100);
});

// Stereo Virtualizer Functions

// Initialize stereo virtualizer
function initializeStereoVirtualizer() {
    if (!audioContext) return;

    // Create channel splitter (mono to 2 channels)
    stereoSplitter = audioContext.createChannelSplitter(2);

    // Create delay nodes for Haas effect
    stereoDelayLeft = audioContext.createDelay(0.1);
    stereoDelayRight = audioContext.createDelay(0.1);
    stereoDelayLeft.delayTime.value = 0.016; // 16ms default
    stereoDelayRight.delayTime.value = 0; // No delay on right

    // Create gain nodes for channel separation/independence
    stereoGainLeft = audioContext.createGain();
    stereoGainRight = audioContext.createGain();
    stereoGainLeft.gain.value = 1.0; // Full gain on both channels
    stereoGainRight.gain.value = 1.0;

    // Create gain node for overall width control
    stereoWidthGain = audioContext.createGain();
    stereoWidthGain.gain.value = 0.5; // 50% width default

    // Create channel merger (2 channels back to stereo)
    stereoMerger = audioContext.createChannelMerger(2);

    // Create makeup gain node
    stereoMakeupGain = audioContext.createGain();
    stereoMakeupGain.gain.value = 1.0; // 0 dB default

    // Create analyser to monitor output for clipping detection
    stereoAnalyser = audioContext.createAnalyser();
    stereoAnalyser.fftSize = 2048;
    stereoAnalyser.smoothingTimeConstant = 0;

    log('Stereo virtualizer initialized (Haas effect + channel separation + makeup gain)');
}

// Toggle stereo virtualizer on/off
function toggleStereoVirtualizer() {
    const checkbox = document.getElementById('stereo-virtualizer-enable');
    const badge = document.getElementById('stereo-virtualizer-status-badge');
    stereoVirtualizerEnabled = checkbox.checked;

    if (stereoVirtualizerEnabled) {
        if (!stereoSplitter && audioContext) {
            initializeStereoVirtualizer();
        }
        if (badge) {
            badge.textContent = 'ENABLED';
            badge.classList.remove('filter-disabled');
            badge.classList.add('filter-enabled');
        }
        log('Stereo virtualizer enabled (creates wider stereo image)');
    } else {
        if (badge) {
            badge.textContent = 'DISABLED';
            badge.classList.remove('filter-enabled');
            badge.classList.add('filter-disabled');
        }
        log('Stereo virtualizer disabled');
    }
}

// Update stereo virtualizer parameters
function updateStereoVirtualizer() {
    const width = parseInt(document.getElementById('stereo-width').value);
    const delay = parseInt(document.getElementById('stereo-delay').value);
    const separation = parseInt(document.getElementById('stereo-separation').value);
    const makeupGainDb = parseFloat(document.getElementById('stereo-makeup-gain').value);

    // Update display values
    document.getElementById('stereo-width-value').textContent = width + '%';
    document.getElementById('stereo-delay-value').textContent = delay + ' ms';
    document.getElementById('stereo-separation-value').textContent = separation + '%';
    document.getElementById('stereo-makeup-gain-value').textContent = '+' + makeupGainDb.toFixed(1) + ' dB';

    if (!stereoDelayLeft || !stereoDelayRight || !stereoGainLeft || !stereoGainRight || !stereoWidthGain || !stereoMakeupGain) {
        if (audioContext) {
            initializeStereoVirtualizer();
        }
        return;
    }

    // Update delay times (convert ms to seconds)
    // Left channel gets the delay, right stays at 0
    stereoDelayLeft.delayTime.value = delay / 1000;
    stereoDelayRight.delayTime.value = 0;

    // Update separation (0-100% -> 0.0-1.0)
    // Keep both channels at full gain for equal volume
    const separationValue = separation / 100;
    stereoGainLeft.gain.value = 1.0;
    stereoGainRight.gain.value = 1.0;

    // Update width (0-100% -> 0.0-1.0)
    const widthValue = width / 100;
    stereoWidthGain.gain.value = widthValue;

    // Update makeup gain (convert dB to linear)
    stereoMakeupGain.gain.value = Math.pow(10, makeupGainDb / 20);

    // Log occasionally (not on every slider movement)
    if (Math.random() < 0.05) {
        log(`Stereo virtualizer: ${width}% width, ${delay}ms delay, ${separation}% separation, +${makeupGainDb.toFixed(1)} dB makeup`);
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
