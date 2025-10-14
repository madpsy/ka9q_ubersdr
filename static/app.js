// Import WebSocket Manager
import { WebSocketManager } from './websocket-manager.js';

// Import Bookmark Manager
import { loadBookmarks, drawBookmarksOnSpectrum, handleBookmarkClick } from './bookmark-manager.js';

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

// Initialize WebSocket Manager immediately after userSessionID is generated
const wsManager = new WebSocketManager({
    userSessionID: userSessionID,
    onMessage: handleMessage,
    onConnect: () => {
        log('Connected!');
        updateConnectionStatus('connected');
        startStatsUpdates();

        // Initialize audio context if not already done
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            window.audioContext = audioContext;
            nextPlayTime = audioContext.currentTime;
            audioStartTime = audioContext.currentTime;
            log(`Audio context initialized (sample rate: ${audioContext.sampleRate} Hz)`);

            // Create analyser for spectrum/waterfall
            analyser = audioContext.createAnalyser();
            analyser.fftSize = getOptimalFFTSize();
            analyser.smoothingTimeConstant = 0;
            updateFFTSizeDropdown();

            // Create dedicated analyser for VU meter
            vuAnalyser = audioContext.createAnalyser();
            vuAnalyser.fftSize = 2048;
            vuAnalyser.smoothingTimeConstant = 0;

            // Initialize stereo channel routing
            initializeStereoChannels();
            initializeSquelch();
            initializeCompressor();
            initializeLowpassFilter();
            initializeEqualizer();

            // Initialize waterfall timestamp
            waterfallStartTime = Date.now();
            waterfallLineCount = 0;

            updateOscilloscopeZoom();
            startVisualization();

            // Initialize CW decoder if in CW mode
            if (currentMode === 'cwu' || currentMode === 'cwl') {
                const centerFreq = bandpassEnabled && bandpassFilters.length > 0
                    ? bandpassFilters[0].frequency.value
                    : 800;
                initializeCWDecoder(audioContext, analyser, centerFreq);
            }

            // Open extensions from URL parameter if specified
            if (window.extensionsToOpen && window.extensionsToOpen.length > 0) {
                setTimeout(() => {
                    window.extensionsToOpen.forEach(extName => {
                        if (window.toggleExtension) {
                            window.toggleExtension(extName);
                            log(`Opened extension from URL: ${extName}`);
                        }
                    });
                    delete window.extensionsToOpen;
                }, 100);
            }
        }
    },
    onDisconnect: () => {
        log('Disconnected');
        updateConnectionStatus('disconnected');
        stopStatsUpdates();
    },
    onError: (error) => {
        if (error.type === 'connection_rejected' || error.type === 'reconnection_blocked') {
            showNotification(error.reason, 'error', 10000);

            // Show terminated overlay for 410 status
            if (error.status === 410) {
                showTerminatedOverlay(error.reason);
            }
        } else if (error.type === 'connection_closed') {
            showNotification(error.message, 'error', 10000);
        } else if (error.type === 'max_reconnect_attempts') {
            showNotification(error.message, 'error', 10000);
        } else if (error.type === 'websocket_error') {
            showNotification('Connection error occurred. Attempting to reconnect...', 'error');
        } else if (error.type === 'websocket_creation_failed') {
            showNotification('Failed to connect. Please refresh the page.', 'error');
            updateConnectionStatus('disconnected');
        }
    },
    log: log
});

let audioContext = null;
let audioUserDisconnected = false; // Flag to prevent reconnection after user disconnect
// Expose audioContext globally for recorder
window.audioContext = null;
// Expose ws globally for compatibility (will be set by wsManager)
window.ws = null;
let audioQueue = [];
let isPlaying = false;
let isMuted = false;
let currentVolume = 0.7;
let lastBufferDisplayUpdate = 0;
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
let vuPeakDecayRate = 0.1; // Percentage points per frame (slower decay for visibility)
let animationFrameId = null;
let waterfallIntensity = 0.0; // Intensity adjustment for waterfall (-1.0 to +1.0, 0 = normal)
let waterfallContrast = 50; // Contrast threshold for waterfall (0-100, suppresses noise floor)
let oscilloscope = null; // Oscilloscope instance
let lowpassFilters = []; // Array of cascaded low-pass filters for steep rolloff
let audioVisualizationEnabled = false; // Track if audio visualization is expanded
let noiseReductionEnabled = false; // Track if noise reduction is enabled
let noiseReductionProcessor = null; // ScriptProcessor for noise reduction
let noiseReductionStrength = 40; // Noise reduction strength (0-100%)
let noiseReductionFloor = 10; // Spectral floor (0-10%)
let noiseReductionMakeupGain = null; // GainNode for makeup gain after NR2
let noiseReductionAnalyser = null; // Analyser to monitor NR2 output for clipping
let noiseReductionClipping = false; // Track if NR2 output is clipping
let noiseReductionClipIndicatorTimeout = null; // Timeout for hiding clip indicator
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

// Bookmarks are now managed by bookmark-manager.js
// Access via window.bookmarks and window.bookmarkPositions

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

    // Add keyboard shortcuts for frequency adjustment and spectrum zoom
    document.addEventListener('keydown', (e) => {
        // Check if recorder modal is open
        const recorderModal = document.getElementById('recorder-modal');
        const isRecorderModalOpen = recorderModal && recorderModal.style.display === 'flex';

        // If recorder modal is open and spacebar is pressed, toggle recording
        if (isRecorderModalOpen && e.key === ' ') {
            e.preventDefault();
            // Check the actual recording state from the UI
            const startBtn = document.getElementById('recorder-start-btn');
            const stopBtn = document.getElementById('recorder-stop-btn');
            if (stopBtn && !stopBtn.disabled) {
                // Recording is active, stop it
                stopRecording();
            } else if (startBtn && !startBtn.disabled) {
                // Recording is not active, start it
                startRecording();
            }
            return;
        }

        // F key: Focus on frequency input (works even when not in an input field)
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            const freqInput = document.getElementById('frequency');
            if (freqInput) {
                freqInput.focus();
                freqInput.select(); // Select all text for easy replacement
            }
            return;
        }

        // Escape or Enter key: Unfocus input fields to allow shortcuts
        if (e.key === 'Escape' || e.key === 'Enter') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                e.preventDefault();
                e.target.blur(); // Remove focus from the input
                return;
            }
        }

        // Only handle shortcuts when not typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        // Up arrow: Increase volume
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const volumeSlider = document.getElementById('volume');
            if (volumeSlider) {
                let newVolume = parseInt(volumeSlider.value) + 5;
                if (newVolume > 100) newVolume = 100;
                volumeSlider.value = newVolume;
                // Trigger the input event to update volume
                volumeSlider.dispatchEvent(new Event('input'));
            }
        }
        // Down arrow: Decrease volume
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const volumeSlider = document.getElementById('volume');
            if (volumeSlider) {
                let newVolume = parseInt(volumeSlider.value) - 5;
                if (newVolume < 0) newVolume = 0;
                volumeSlider.value = newVolume;
                // Trigger the input event to update volume
                volumeSlider.dispatchEvent(new Event('input'));
            }
        }
        // Left arrow: -1 kHz
        else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            adjustFrequency(-1000);
        }
        // Right arrow: +1 kHz
        else if (e.key === 'ArrowRight') {
            e.preventDefault();
            adjustFrequency(1000);
        }
        // A key: -100 Hz
        else if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            adjustFrequency(-100);
        }
        // D key: +100 Hz
        else if (e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            adjustFrequency(100);
        }
        // W key: Zoom in
        else if (e.key === 'w' || e.key === 'W') {
            e.preventDefault();
            spectrumZoomIn();
        }
        // S key: Zoom out
        else if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            spectrumZoomOut();
        }
        // Q key: Reset zoom
        else if (e.key === 'q' || e.key === 'Q') {
            e.preventDefault();
            spectrumResetZoom();
        }
        // E key: Max zoom
        else if (e.key === 'e' || e.key === 'E') {
            e.preventDefault();
            spectrumMaxZoom();
        }
        // M key: Toggle mute
        else if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            toggleMute();
        }
        // R key: Open recorder modal
        else if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            openRecorderModal();
        }
        // N key: Toggle NR2
        else if (e.key === 'n' || e.key === 'N') {
            e.preventDefault();
            toggleNR2Quick();
        }
        // U key: Set USB mode
        else if (e.key === 'u' || e.key === 'U') {
            e.preventDefault();
            setMode('usb');
        }
        // L key: Set LSB mode
        else if (e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            setMode('lsb');
        }
        // C key: Toggle between CWU and CWL
        else if (e.key === 'c' || e.key === 'C') {
            e.preventDefault();
            // Check current mode and toggle
            if (window.currentMode === 'cwu') {
                setMode('cwl');
            } else if (window.currentMode === 'cwl') {
                setMode('cwu');
            } else {
                // If not in CW mode, default to CWU
                setMode('cwu');
            }
        }
        // Number keys 1-8: Set band
        else if (e.key === '1') {
            e.preventDefault();
            setBand('80m');
        }
        else if (e.key === '2') {
            e.preventDefault();
            setBand('40m');
        }
        else if (e.key === '3') {
            e.preventDefault();
            setBand('30m');
        }
        else if (e.key === '4') {
            e.preventDefault();
            setBand('20m');
        }
        else if (e.key === '5') {
            e.preventDefault();
            setBand('17m');
        }
        else if (e.key === '6') {
            e.preventDefault();
            setBand('15m');
        }
        else if (e.key === '7') {
            e.preventDefault();
            setBand('12m');
        }
        else if (e.key === '8') {
            e.preventDefault();
            setBand('10m');
        }
    });

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
    // Initialize oscilloscope
    oscilloscope = new Oscilloscope('oscilloscope-canvas');
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

        if (oscilloscope) {
            oscilloscope.resize();
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

            if (oscilloscope) {
                oscilloscope.resize();
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

                // Add map if GPS coordinates are available
                if (data.receiver && data.receiver.gps &&
                    data.receiver.gps.lat !== 0 && data.receiver.gps.lon !== 0) {
                    const lat = data.receiver.gps.lat;
                    const lon = data.receiver.gps.lon;
                    const name = data.receiver.name || 'Receiver';
                    const location = data.receiver.location || '';
                    const asl = data.receiver.asl || 0;

                    // Load Leaflet CSS and JS dynamically
                    if (!document.getElementById('leaflet-css')) {
                        const leafletCSS = document.createElement('link');
                        leafletCSS.id = 'leaflet-css';
                        leafletCSS.rel = 'stylesheet';
                        leafletCSS.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
                        leafletCSS.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
                        leafletCSS.crossOrigin = '';
                        document.head.appendChild(leafletCSS);
                    }

                    if (!window.L) {
                        const leafletJS = document.createElement('script');
                        leafletJS.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
                        leafletJS.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
                        leafletJS.crossOrigin = '';
                        document.head.appendChild(leafletJS);

                        // Wait for Leaflet to load
                        await new Promise((resolve) => {
                            leafletJS.onload = resolve;
                        });
                    }

                    // Create map container
                    const mapContainer = document.createElement('div');
                    mapContainer.id = 'location-map';
                    mapContainer.style.marginTop = '15px';
                    mapContainer.style.width = '100%';
                    mapContainer.style.height = '200px';
                    mapContainer.style.border = '2px solid #444';
                    mapContainer.style.borderRadius = '4px';
                    mapContainer.style.overflow = 'hidden';
                    descriptionEl.appendChild(mapContainer);

                    // Initialize map (zoom level 6 for more zoomed out view)
                    const map = L.map('location-map').setView([lat, lon], 6);

                    // Add OpenStreetMap tiles
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                        maxZoom: 19
                    }).addTo(map);

                    // Add marker with permanent tooltip
                    const marker = L.marker([lat, lon]).addTo(map);
                    let tooltipContent = `<strong>${name}</strong>`;
                    if (location) {
                        tooltipContent += `<br>${location}`;
                    }
                    tooltipContent += `<br>${asl}m ASL`;
                    marker.bindTooltip(tooltipContent, {
                        permanent: true,
                        direction: 'top',
                        className: 'receiver-tooltip'
                    }).openTooltip();

                    // Add link to full map
                    const mapLink = document.createElement('div');
                    mapLink.style.marginTop = '5px';
                    mapLink.style.fontSize = '12px';
                    mapLink.style.textAlign = 'center';
                    mapLink.innerHTML = `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}" target="_blank" style="color: #007bff;">View larger map</a>`;
                    descriptionEl.appendChild(mapLink);
                }
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
    if (wsManager.isConnected()) {
        disconnect();
    } else {
        connect();
    }
}

// Connect to WebSocket
async function connect() {
    const frequency = document.getElementById('frequency').value;
    const mode = currentMode;

    await wsManager.connect({
        frequency: frequency,
        mode: mode,
        bandwidthLow: currentBandwidthLow,
        bandwidthHigh: currentBandwidthHigh
    });
}


// Disconnect from WebSocket
function disconnect() {
    wsManager.disconnect();

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
    updateBandSelector();

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
    if (wsManager.isConnected()) {
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

// Find which amateur band contains a frequency
function findBandForFrequency(frequency) {
    if (!window.amateurBands || window.amateurBands.length === 0) {
        return null;
    }

    for (let band of window.amateurBands) {
        if (frequency >= band.start && frequency <= band.end) {
            return band.name || band.label;
        }
    }
    return null;
}

// Update status display
function updateStatus(msg) {
    if (msg.frequency) {
        const freqText = formatFrequency(msg.frequency);
        const bandName = findBandForFrequency(msg.frequency);

        // Update frequency display with band name if available
        document.getElementById('current-freq').textContent = freqText;

        // Update mode display with band name appended if in a band
        if (msg.mode) {
            const modeText = msg.mode.toUpperCase();
            const modeElement = document.getElementById('current-mode');
            if (bandName) {
                modeElement.textContent = `${modeText} • ${bandName}`;
            } else {
                modeElement.textContent = modeText;
            }
        }

        updateBandButtons(msg.frequency);
        // Update spectrum display cursor
        if (spectrumDisplay) {
            spectrumDisplay.updateConfig({
                tunedFreq: msg.frequency,
                bandwidthLow: currentBandwidthLow,
                bandwidthHigh: currentBandwidthHigh
            });
        }
    } else if (msg.mode) {
        // Mode update without frequency - just update mode text
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

    // Update buffer display and log timing info occasionally for debugging
    const timeSinceStart = currentTime - audioStartTime;
    const bufferAhead = nextPlayTime - currentTime;

    // Update buffer display element (throttled to ~2 updates per second)
    const now = performance.now();
    if (now - lastBufferDisplayUpdate >= 500) {
        const bufferDisplay = document.getElementById('audio-buffer-display');
        if (bufferDisplay) {
            bufferDisplay.textContent = `Buffer: ${(bufferAhead * 1000).toFixed(0)}ms`;
        }
        lastBufferDisplayUpdate = now;
    }

    // Log timing info occasionally for debugging
    if (Math.floor(timeSinceStart) % 10 === 0 && Math.floor(timeSinceStart) !== Math.floor(timeSinceStart - buffer.duration)) {
        console.log(`Audio timing: ${bufferAhead.toFixed(3)}s buffered`);
    }
}

// Tune to new frequency/mode/bandwidth
function tune() {
    if (!wsManager.isConnected()) {
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

    wsManager.send(msg);
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

    // Update band selector dropdown
    updateBandSelector();

    // Update URL with new frequency
    updateURL();

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
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
    updateBandSelector();
    log(`Frequency preset: ${formatFrequency(clampedFreq)}`);

    // Update URL with new frequency
    updateURL();

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
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
    updateBandSelector();

    // Set mode based on frequency: LSB below 10 MHz (80m, 40m), USB at 10 MHz and above (30m+)
    // This follows amateur radio convention where LSB is used on lower HF bands
    const mode = centerFreq < 10000000 ? 'lsb' : 'usb';
    setMode(mode);

    // Update URL with new frequency and mode
    updateURL();

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
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

    // Apply rounding based on step size
    // For ±100 Hz steps (buttons/arrows): round to nearest 100 Hz (matching scroll wheel)
    // For ±10 Hz steps: round to nearest 10 Hz
    let roundedFreq;
    if (Math.abs(deltaHz) === 100) {
        // Round to nearest 100 Hz for 100 Hz steps
        roundedFreq = Math.round(clampedFreq / 100) * 100;
    } else {
        // Round to nearest 10 Hz for other steps (like 10 Hz buttons)
        roundedFreq = Math.round(clampedFreq / 10) * 10;
    }

    freqInput.value = roundedFreq;
    updateBandButtons(roundedFreq);
    updateBandSelector();

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

    // Load extensions (will be opened after audio context is initialized)
    if (params.has('ext')) {
        const extensions = params.get('ext').split(',').filter(e => e.trim());
        if (extensions.length > 0) {
            // Store for later application when audio context is ready
            window.extensionsToOpen = extensions;
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

    // Add currently open extensions
    if (window.decoderManager) {
        const activeExtensions = window.decoderManager.getActiveDecoders();
        if (activeExtensions.length > 0) {
            params.set('ext', activeExtensions.join(','));
        }
    }

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

    // Show/hide "Set 1 kHz" button based on mode (only for USB/LSB)
    const set1kHzBtn = document.getElementById('set-1khz-btn');
    if (set1kHzBtn) {
        if (['usb', 'lsb'].includes(mode)) {
            set1kHzBtn.style.display = 'inline-block';
        } else {
            set1kHzBtn.style.display = 'none';
        }
    }

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
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
    if (wsManager.isConnected()) {
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
    // Get frequency bin mapping to understand the actual FFT frequency range
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return 0;

    const { binStartFreq, binEndFreq } = binMapping;
    const bandwidth = binEndFreq - binStartFreq;

    // Map pixel to FFT bin frequency (always positive)
    const fftFreq = binStartFreq + (pixel / canvasWidth) * bandwidth;

    // For LSB mode, return negative frequency for display
    // For USB/other modes, return positive frequency
    if (currentBandwidthLow < 0 && currentBandwidthHigh <= 0) {
        return -fftFreq;
    } else {
        return fftFreq;
    }
}

// VU meter throttling
let lastVUMeterUpdate = 0;
const vuMeterUpdateInterval = 100; // 10 fps (1000ms / 10 = 100ms)


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
            if (oscilloscope) {
                oscilloscope.update(analyser, audioContext, currentMode, currentBandwidthLow, currentBandwidthHigh);
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

        // Process all decoder extensions (always run, independent of visualization)
        if (window.decoderManager) {
            window.decoderManager.processAudio();
        }

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

            if (oscilloscope) {
                oscilloscope.resize();
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

// Oscilloscope functions moved to oscilloscope.js

// Tracking mode state - now managed by oscilloscope instance

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
    if (oscilloscope) {
        oscilloscope.frequencyOffset = offset;
    }
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
    if (oscilloscope && oscilloscope.trackingEnabled) {
        disableFrequencyTracking();
        if (oscilloscope) {
            oscilloscope.frequencyOffset = 0; // Reset offset when disabling
        }
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
    if (!analyser || !audioContext || !oscilloscope) {
        log('Audio not initialized', 'error');
        return;
    }

    const button = document.getElementById('set-1khz-btn');

    // Get current detected frequency from oscilloscope
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const detectedFreq = oscilloscope.detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);

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
    if (wsManager.isConnected()) {
        autoTune();
    }

    // Calculate adjusted dial frequency for display
    const offset = oscilloscope ? oscilloscope.frequencyOffset : 0;
    const adjustedDialFreq = newDialFreq - offset;

    log(`Shifted ${currentMode.toUpperCase()} signal from ${detectedFreq.toFixed(1)} Hz to ${targetFreq} Hz (dial: ${formatFrequency(currentDialFreq)} → ${formatFrequency(newDialFreq)})`);
    if (offset !== 0) {
        log(`Adjusted dial frequency (with ${offset} Hz offset): ${formatFrequency(adjustedDialFreq)}`);
    }

    // Enable tracking mode
    if (oscilloscope) {
        oscilloscope.trackingStartFreq = newDialFreq;
    }
    enableFrequencyTracking();

    if (button) {
        button.style.backgroundColor = '#28a745'; // Green when tracking
        button.textContent = 'Tracking: ON';
    }

    log('Frequency tracking enabled (click again to disable)');
}

// Enable frequency tracking
function enableFrequencyTracking() {
    if (!oscilloscope) return;

    if (oscilloscope.trackingInterval) {
        clearInterval(oscilloscope.trackingInterval);
    }

    oscilloscope.trackingEnabled = true;

    oscilloscope.trackingInterval = setInterval(() => {
        if (!oscilloscope.trackingEnabled || !analyser || !audioContext) {
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

        const detectedFreq = oscilloscope.detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);

        if (detectedFreq <= 0 || detectedFreq < 20 || detectedFreq > 20000) {
            // No valid signal, skip this update
            return;
        }

        const targetFreq = 1000;
        const currentError = targetFreq - detectedFreq;

        // Update lock status and button color
        const button = document.getElementById('set-1khz-btn');
        const wasLocked = oscilloscope.trackingLocked;
        oscilloscope.trackingLocked = Math.abs(currentError) <= oscilloscope.TRACKING_LOCK_THRESHOLD;

        if (button) {
            if (oscilloscope.trackingLocked) {
                button.style.backgroundColor = '#28a745'; // Green when locked
                button.textContent = 'Tracking: LOCKED';
            } else {
                button.style.backgroundColor = '#fd7e14'; // Orange when adjusting
                button.textContent = 'Tracking: ADJUSTING';
            }
        }

        // Only adjust if error is above minimum threshold
        if (Math.abs(currentError) < oscilloscope.TRACKING_MIN_ERROR) {
            return;
        }

        // Add to history for smoothing
        oscilloscope.trackingHistory.push(currentError);
        if (oscilloscope.trackingHistory.length > oscilloscope.TRACKING_HISTORY_SIZE) {
            oscilloscope.trackingHistory.shift();
        }

        // Need enough history before adjusting
        if (oscilloscope.trackingHistory.length < oscilloscope.TRACKING_HISTORY_SIZE) {
            return;
        }

        // Calculate smoothed error
        const smoothedError = oscilloscope.trackingHistory.reduce((sum, e) => sum + e, 0) / oscilloscope.trackingHistory.length;

        // Check if all errors in history have the same sign
        const allSameSign = oscilloscope.trackingHistory.every(e => e * smoothedError > 0);
        if (!allSameSign) {
            oscilloscope.trackingHistory = [];
            return;
        }

        // Only adjust if smoothed error is still significant
        if (Math.abs(smoothedError) < oscilloscope.TRACKING_MIN_ERROR) {
            return;
        }

        // Adaptive damping
        let dampingFactor;
        if (Math.abs(smoothedError) > oscilloscope.TRACKING_COARSE_THRESHOLD) {
            dampingFactor = oscilloscope.TRACKING_DAMPING_COARSE;
        } else if (Math.abs(smoothedError) > 2) {
            dampingFactor = oscilloscope.TRACKING_DAMPING_FINE;
        } else {
            dampingFactor = 1.0;
        }

        const shiftAmount = smoothedError * dampingFactor;

        // Get current dial frequency
        const freqInput = document.getElementById('frequency');
        const currentDialFreq = parseInt(freqInput.value);

        // Check drift from start frequency
        const driftFromStart = Math.abs(currentDialFreq - oscilloscope.trackingStartFreq);
        if (driftFromStart > oscilloscope.TRACKING_DRIFT_LIMIT) {
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
        if (wsManager.isConnected()) {
            autoTune();
        }

    }, oscilloscope.TRACKING_UPDATE_RATE);
}

// Disable frequency tracking
function disableFrequencyTracking() {
    if (!oscilloscope) return;

    oscilloscope.trackingEnabled = false;
    oscilloscope.trackingHistory = [];
    oscilloscope.trackingStableCount = 0;
    oscilloscope.trackingLocked = false;

    if (oscilloscope.trackingInterval) {
        clearInterval(oscilloscope.trackingInterval);
        oscilloscope.trackingInterval = null;
    }

    const button = document.getElementById('set-1khz-btn');
    if (button) {
        button.style.backgroundColor = '#6c757d';
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

    // Average bins for this pixel (cursor position)
    let sum = 0;
    let count = 0;
    for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < audioSpectrumLastData.dataArray.length; binIndex++) {
        sum += audioSpectrumLastData.dataArray[binIndex] || 0;
        count++;
    }
    const magnitude = count > 0 ? sum / count : 0;

    // Convert magnitude to dB (same as display scale)
    const db = magnitude > 0 ? 20 * Math.log10(magnitude / 255) : -Infinity;

    // Find peak signal across entire spectrum
    let maxMagnitude = 0;
    let maxBinIndex = startBinIndex;
    for (let binIndex = startBinIndex; binIndex < startBinIndex + binsForBandwidth && binIndex < audioSpectrumLastData.dataArray.length; binIndex++) {
        const mag = audioSpectrumLastData.dataArray[binIndex] || 0;
        if (mag > maxMagnitude) {
            maxMagnitude = mag;
            maxBinIndex = binIndex;
        }
    }

    // Calculate peak frequency using the same mapping as cursor
    // Convert bin index to pixel position, then to frequency for consistency
    const peakPixel = ((maxBinIndex - startBinIndex) / binsForBandwidth) * width;
    const peakFreq = Math.round(pixelToFrequency(peakPixel, width));

    // Convert peak magnitude to dB
    const peakDb = maxMagnitude > 0 ? 20 * Math.log10(maxMagnitude / 255) : -Infinity;

    // freq and peakFreq are already in the correct coordinate system from pixelToFrequency()
    // For LSB they're negative, for USB they're positive
    // Just display them with absolute values and proper formatting
    const displayFreq = Math.abs(freq);
    const displayPeakFreq = Math.abs(peakFreq);

    // Format frequencies (helper function)
    const formatFreq = (f) => f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`;

    // Update tooltip with cursor and peak info (use innerHTML for line break, matching main waterfall)
    const cursorText = `Cursor: ${formatFreq(displayFreq)} | ${db === -Infinity ? '-∞' : db.toFixed(1)} dB`;
    const peakText = `Peak: ${formatFreq(displayPeakFreq)} | ${peakDb === -Infinity ? '-∞' : peakDb.toFixed(1)} dB`;
    audioSpectrumTooltip.innerHTML = `${cursorText}<br>${peakText}`;

    audioSpectrumTooltip.style.left = (clientX + 15) + 'px';
    audioSpectrumTooltip.style.top = (clientY - 10) + 'px';
    audioSpectrumTooltip.style.display = 'block';
}

// Frequency detection moved to oscilloscope.js

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
        // For LSB/CWL modes, invert the frequency display (0 Hz on left, max on right)
        // LSB: -2700 to -50 displays as 2700 to 0 (reversed)
        // For other modes, show the actual audio frequency (freq already includes CW offset)
        let displayFreq;
        if (currentMode === 'lsb' || currentMode === 'cwl') {
            // Invert: most negative freq shows as highest, least negative shows as lowest
            // For LSB: -2700 to -50 displays as 2700 to 50
            // For CWL: -200 to 200 (with 500 Hz offset) displays as 700 to 300
            displayFreq = Math.abs(freq);
        } else if (currentMode === 'am' || currentMode === 'sam' || currentMode === 'fm' || currentMode === 'nfm') {
            // AM/SAM/FM/NFM: Show audio frequency from 0 Hz (left) to max (right)
            // freq ranges from -bandwidth to +bandwidth, map to 0 to bandwidth
            // Left edge -> 0 Hz, Center -> bandwidth/2, Right edge -> bandwidth
            displayFreq = (freq + Math.abs(currentBandwidthLow)) / 2;
        } else {
            displayFreq = freq;
        }
        spectrumCtx.fillText(displayFreq + ' Hz', x, height - 5);
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

        // For LSB/CWL modes, invert the frequency display (0 Hz on left, max on right)
        // LSB: -2700 to -50 displays as 2700 to 0 (reversed)
        // For other modes, show the actual audio frequency (freq already includes CW offset)
        let displayFreq;
        if (currentMode === 'lsb' || currentMode === 'cwl') {
            // Invert: most negative freq shows as highest, least negative shows as lowest
            // For LSB: -2700 to -50 displays as 2700 to 50
            // For CWL: -200 to 200 (with 500 Hz offset) displays as 700 to 300
            displayFreq = Math.abs(freq);
        } else if (currentMode === 'am' || currentMode === 'sam' || currentMode === 'fm' || currentMode === 'nfm') {
            // AM/SAM/FM/NFM: Show audio frequency from 0 Hz (left) to max (right)
            // freq ranges from -bandwidth to +bandwidth, map to 0 to bandwidth
            // Left edge -> 0 Hz, Center -> bandwidth/2, Right edge -> bandwidth
            displayFreq = (freq + Math.abs(currentBandwidthLow)) / 2;
        } else {
            displayFreq = freq;
        }

        // Draw major tick mark (white)
        waterfallCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        waterfallCtx.fillRect(x - 1, height - 30, 2, 12);

        // Draw label with strong contrast
        waterfallCtx.fillStyle = '#ffffff';
        waterfallCtx.strokeStyle = '#000000';
        waterfallCtx.lineWidth = 3;

        const label = displayFreq + ' Hz';
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
    if (oscilloscope) {
        oscilloscope.setZoom(sliderValue);
    }

    // Calculate actual time window being displayed using logarithmic scale
    if (analyser && audioContext) {
        const bufferLength = analyser.fftSize;
        const sampleRate = audioContext.sampleRate;
        const totalTimeMs = (bufferLength / sampleRate) * 1000;

        const minFraction = 0.005;
        const maxFraction = 1.0;
        const logMin = Math.log10(minFraction);
        const logMax = Math.log10(maxFraction);
        const logRange = logMax - logMin;
        const normalizedSlider = (sliderValue - 1) / 199;
        const logValue = logMin + (normalizedSlider * logRange);
        const fraction = Math.pow(10, logValue);
        const displayedTimeMs = totalTimeMs * fraction;

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
    if (!oscilloscope || !analyser || !audioContext) {
        log('Audio not initialized', 'error');
        return;
    }

    const button = document.getElementById('auto-sync-btn');
    const result = oscilloscope.autoSync(analyser, audioContext);

    if (result === false) {
        // Trigger was disabled
        if (button) {
            button.style.backgroundColor = '#17a2b8';
            button.textContent = 'Auto Sync';
        }
        log('Oscilloscope trigger disabled (free run)');
    } else if (!result) {
        // No signal found
        log('No strong signal detected for auto sync', 'error');
    } else {
        // Trigger enabled successfully
        const slider = document.getElementById('oscilloscope-zoom');
        if (slider) {
            slider.value = result.zoom;
            updateOscilloscopeZoom();
        }

        if (button) {
            button.style.backgroundColor = '#28a745';
            button.textContent = 'Trigger: ON';
        }

        log(`Auto sync: ${result.frequency.toFixed(1)} Hz signal, timebase adjusted (trigger locked)`);
    }
}
// Toggle auto scale oscilloscope Y-axis (continuous adjustment on/off)
function autoScaleOscilloscope() {
    if (!oscilloscope) return;

    const button = document.getElementById('auto-scale-btn');
    const enabled = oscilloscope.toggleAutoScale();

    if (enabled) {
        if (button) {
            button.style.backgroundColor = '#28a745';
            button.textContent = 'Auto Scale: ON';
        }
        log('Oscilloscope auto scale enabled (continuous adjustment)');
    } else {
        if (button) {
            button.style.backgroundColor = '#17a2b8';
            button.textContent = 'Auto Scale';
        }
        log('Oscilloscope auto scale disabled (reset to 1:1)');
    }
}


// Keepalive is now handled by idle-detector.js (activity-based heartbeats)
// Fixed 30-second interval removed to allow proper idle detection

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
        if (wsManager.isConnected()) {
            autoTune();
        }

        log(`Shifted ${currentMode.toUpperCase()} signal from ${lockedFreq} Hz to ${targetFreq} Hz (dial: ${formatFrequency(currentDialFreq)} → ${formatFrequency(newDialFreq)})`);
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

        // Create script processor: mono input, stereo output (1 in, 2 out)
        const bufferSize = 2048;
        noiseReductionProcessor = audioContext.createScriptProcessor(bufferSize, 1, 2);

        noiseReductionProcessor.onaudioprocess = (e) => {
            // Process mono input through NR2
            const input = e.inputBuffer.getChannelData(0);
            const outputL = e.outputBuffer.getChannelData(0);

            // Process through NR2 to left channel
            nr2.process(input, outputL);

            // Duplicate left channel to right channel
            const outputR = e.outputBuffer.getChannelData(1);
            outputR.set(outputL);
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

function resetNoiseReduction() {
    const defaults = { strength: 40, floor: 10, adaptRate: 1.0, makeupGain: -3 };
    document.getElementById('noise-reduction-strength').value = defaults.strength;
    document.getElementById('noise-reduction-floor').value = defaults.floor;
    document.getElementById('noise-reduction-adapt-rate').value = defaults.adaptRate;
    document.getElementById('noise-reduction-makeup-gain').value = defaults.makeupGain;
    updateNoiseReduction();
    console.log('Noise reduction reset');
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
const ZOOM_THROTTLE_MS = 250;

// Bookmark functions moved to bookmark-manager.js
// They are imported at the top of this file and exposed on window by that module

// Initialize spectrum display on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load amateur radio bands
        loadBands();
    
        // Load bookmarks
        loadBookmarks();
    
        // Populate band selector dropdown after bands are loaded
        setTimeout(() => {
            populateBandSelector();
        }, 500);

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

                // Update band selector
                updateBandSelector();

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
                    if (!wsManager.isConnected()) {
                        connect();
                    } else {
                        autoTune();
                    }
                } else {
                    // Already zoomed in - just tune
                    if (!wsManager.isConnected()) {
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

        // Update cursor and band selector when frequency input changes
        const freqInput = document.getElementById('frequency');
        if (freqInput) {
            freqInput.addEventListener('input', () => {
                updateSpectrumCursor();
                updateBandSelector();
            });
            freqInput.addEventListener('change', () => {
                updateSpectrumCursor();
                updateBandSelector();
            });
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

// Expose functions to global scope for HTML onclick/onchange handlers
// (Required because ES6 modules don't automatically expose functions globally)

// Spectrum controls
window.toggleSpectrumLineGraph = toggleSpectrumLineGraph;
window.spectrumResetZoom = spectrumResetZoom;
window.spectrumZoomOut = spectrumZoomOut;
window.spectrumZoomIn = spectrumZoomIn;
window.spectrumMaxZoom = spectrumMaxZoom;
window.updateSpectrumColorScheme = updateSpectrumColorScheme;
window.updateSpectrumRange = updateSpectrumRange;
window.updateSpectrumGrid = updateSpectrumGrid;
window.updateSpectrumIntensity = updateSpectrumIntensity;
window.updateSpectrumContrast = updateSpectrumContrast;

// Helper function for spectrum display to get current dial frequency
window.getCurrentDialFrequency = function() {
    const freqInput = document.getElementById('frequency');
    return freqInput ? parseInt(freqInput.value) : 0;
};

// Audio controls
window.toggleMute = toggleMute;
window.toggleNR2Quick = toggleNR2Quick;
window.updateChannelSelection = updateChannelSelection;

// Expose core functions for bookmark-manager.js
window.wsManager = wsManager;
window.updateBandButtons = updateBandButtons;
window.updateURL = updateURL;
window.connect = connect;
window.autoTune = autoTune;
window.formatFrequency = formatFrequency;
window.log = log;

// Frequency/Mode controls
window.validateFrequencyInput = validateFrequencyInput;
window.handleFrequencyChange = handleFrequencyChange;
window.setFrequency = setFrequency;
window.setBand = setBand;
window.adjustFrequency = adjustFrequency;
window.setMode = setMode;
window.updateBandwidthDisplay = updateBandwidthDisplay;
window.updateBandwidth = updateBandwidth;

// Visualization controls
window.openRecorderModal = openRecorderModal;
window.toggleAudioVisualization = toggleAudioVisualization;
window.updateFFTSize = updateFFTSize;
window.updateScrollRate = updateScrollRate;
window.updateWaterfallIntensity = updateWaterfallIntensity;
window.updateWaterfallContrast = updateWaterfallContrast;
window.updateOscilloscopeZoom = updateOscilloscopeZoom;

// Oscilloscope controls
window.autoSyncOscilloscope = autoSyncOscilloscope;
window.autoScaleOscilloscope = autoScaleOscilloscope;
window.shiftFrequencyTo1kHz = shiftFrequencyTo1kHz;

// CW decoder controls
window.toggleCWDecoder = toggleCWDecoder;
window.updateCWDecoderWPM = updateCWDecoderWPM;
window.updateCWDecoderThreshold = updateCWDecoderThreshold;
window.updateCWDecoderFrequency = updateCWDecoderFrequency;
window.huntCWSignal = huntCWSignal;
window.shiftCWSignalTo700Hz = shiftCWSignalTo700Hz;
window.resetCWDecoderWPM = resetCWDecoderWPM;
window.clearCWText = clearCWText;
window.copyCWText = copyCWText;

// Filter controls
window.toggleNotchFilter = toggleNotchFilter;
window.addManualNotch = addManualNotch;
window.clearAllNotches = clearAllNotches;
window.toggleBandpassFilter = toggleBandpassFilter;
window.updateBandpassFilter = updateBandpassFilter;
window.resetBandpassFilter = resetBandpassFilter;
window.toggleNoiseReduction = toggleNoiseReduction;
window.updateNoiseReduction = updateNoiseReduction;
window.resetNoiseReduction = resetNoiseReduction;
window.toggleSquelch = toggleSquelch;
window.updateSquelch = updateSquelch;
window.resetSquelch = resetSquelch;
window.toggleCompressor = toggleCompressor;
window.updateCompressor = updateCompressor;
window.resetCompressor = resetCompressor;
window.toggleStereoVirtualizer = toggleStereoVirtualizer;
window.updateStereoVirtualizer = updateStereoVirtualizer;
window.resetStereoVirtualizer = resetStereoVirtualizer;
window.toggleEqualizer = toggleEqualizer;
window.updateEqualizer = updateEqualizer;
window.resetEqualizer = resetEqualizer;

// Recorder controls
window.closeRecorderModal = closeRecorderModal;
window.startRecording = startRecording;
window.stopRecording = stopRecording;
window.downloadRecording = downloadRecording;
window.clearRecording = clearRecording;

// Modal controls
window.closeOffsetModal = closeOffsetModal;
window.applyOffset = applyOffset;

// Channel controls
window.tuneToChannel = tuneToChannel;

// Extension controls
window.toggleExtension = toggleExtension;

// Toggle extension from dropdown
function toggleExtension(extensionName) {
    const dropdown = document.getElementById('extensions-dropdown');
    
    if (!extensionName) {
        // Close all open extension panels when empty value selected
        const allPanels = document.querySelectorAll('.decoder-extension-panel');
        allPanels.forEach(panel => {
            if (panel.style.display !== 'none') {
                const panelId = panel.id;
                const name = panelId.replace('-decoder-panel', '');
                const decoder = window.decoderManager.getDecoder(name);
                if (decoder) {
                    panel.style.display = 'none';
                    window.decoderManager.disable(name);
                    log(`${name} extension disabled`);
                }
            }
        });
        // Update URL to remove extension parameter
        updateURL();
        return;
    }
    
    const decoder = window.decoderManager.getDecoder(extensionName);
    if (!decoder) {
        log(`Extension not found: ${extensionName}`, 'error');
        dropdown.value = '';
        return;
    }
    
    const panel = document.getElementById(`${extensionName}-decoder-panel`);
    const checkbox = document.getElementById(`${extensionName}-decoder-enable`);
    
    if (!panel) {
        log(`Extension panel not found for: ${extensionName}`, 'error');
        dropdown.value = '';
        return;
    }
    
    // Toggle panel visibility
    if (panel.style.display === 'none' || !panel.style.display) {
        // Show panel
        panel.style.display = 'block';
        
        // Initialize and enable decoder if not already done
        if (!decoder.enabled) {
            if (!audioContext) {
                log('Please start audio first (click "Click to Start")', 'error');
                panel.style.display = 'none';
                dropdown.value = '';
                return;
            }
            
            const centerFreq = 800; // Default center frequency
            window.decoderManager.initialize(extensionName, audioContext, analyser, centerFreq);
            window.decoderManager.enable(extensionName);
            
            if (checkbox) {
                checkbox.checked = true;
            }
        }
        
        log(`${extensionName} extension enabled`);
    } else {
        // Hide panel
        panel.style.display = 'none';
        
        // Disable decoder
        window.decoderManager.disable(extensionName);
        
        if (checkbox) {
            checkbox.checked = false;
        }
        
        log(`${extensionName} extension disabled`);
    }
    
    // Update URL with new extension state
    updateURL();

    // Reset dropdown
    dropdown.value = '';
}

// Populate band selector dropdown with grouped bands
function populateBandSelector() {
    const selector = document.getElementById('band-selector');
    if (!selector || !window.amateurBands || window.amateurBands.length === 0) {
        return;
    }

    // Clear existing options except the first one
    selector.innerHTML = '<option value="">Select Band...</option>';

    // Group bands by their group field
    const grouped = {};
    const ungrouped = [];

    window.amateurBands.forEach(band => {
        if (band.group && band.group.trim() !== '') {
            if (!grouped[band.group]) {
                grouped[band.group] = [];
            }
            grouped[band.group].push(band);
        } else {
            ungrouped.push(band);
        }
    });

    // Add grouped bands with optgroup
    const groupNames = Object.keys(grouped).sort();
    groupNames.forEach(groupName => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;
        
        grouped[groupName].forEach(band => {
            const option = document.createElement('option');
            option.value = JSON.stringify({
                label: band.label,
                start: band.start,
                end: band.end
            });
            option.textContent = band.label;
            optgroup.appendChild(option);
        });
        
        selector.appendChild(optgroup);
    });

    // Add ungrouped bands under "Other" if any exist
    if (ungrouped.length > 0) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = 'Other';
        
        ungrouped.forEach(band => {
            const option = document.createElement('option');
            option.value = JSON.stringify({
                label: band.label,
                start: band.start,
                end: band.end
            });
            option.textContent = band.label;
            optgroup.appendChild(option);
        });
        
        selector.appendChild(optgroup);
    }

    log('Band selector populated with grouped bands');
}

// Handle band selection from dropdown
function selectBandFromDropdown(value) {
    const selector = document.getElementById('band-selector');

    if (!value) {
        return;
    }

    try {
        const bandData = JSON.parse(value);

        // Calculate band center frequency
        const centerFreq = Math.round((bandData.start + bandData.end) / 2);

        // Calculate band width
        const bandWidth = bandData.end - bandData.start;

        // Set frequency to band center
        document.getElementById('frequency').value = centerFreq;
        updateBandButtons(centerFreq);

        // Set mode based on frequency: LSB below 10 MHz, USB at 10 MHz and above
        const mode = centerFreq < 10000000 ? 'lsb' : 'usb';
        setMode(mode);

        // Update URL with new frequency and mode
        updateURL();

        // Auto-connect if not connected
        if (!wsManager.isConnected()) {
            connect();
        } else {
            autoTune();
        }

        // Zoom spectrum to show band with focused view (0.6x band width)
        if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
            const focusedBandwidth = bandWidth * 0.6;
            const binCount = spectrumDisplay.binCount || 2048;
            const binBandwidth = focusedBandwidth / binCount;

            spectrumDisplay.ws.send(JSON.stringify({
                type: 'zoom',
                frequency: centerFreq,
                binBandwidth: binBandwidth
            }));

            log(`Tuned to ${bandData.label}: ${formatFrequency(centerFreq)} ${mode.toUpperCase()} (zoomed to ${formatFrequency(centerFreq - focusedBandwidth/2)} - ${formatFrequency(centerFreq + focusedBandwidth/2)})`);
        } else {
            log(`Tuned to ${bandData.label}: ${formatFrequency(centerFreq)} ${mode.toUpperCase()}`);
        }

    } catch (e) {
        console.error('Error parsing band data:', e);
        log('Error selecting band', 'error');
    }

    // Keep the selection visible (don't reset)
    // selector.value remains as the selected band
}

// Update band selector to match current frequency
function updateBandSelector() {
    const selector = document.getElementById('band-selector');
    if (!selector || !window.amateurBands || window.amateurBands.length === 0) {
        console.log('updateBandSelector: selector or bands not available');
        return;
    }

    const freqInput = document.getElementById('frequency');
    if (!freqInput) {
        console.log('updateBandSelector: frequency input not found');
        return;
    }

    const currentFreq = parseInt(freqInput.value);
    if (isNaN(currentFreq)) {
        console.log('updateBandSelector: invalid frequency');
        selector.value = '';
        return;
    }

    console.log('updateBandSelector: checking frequency', currentFreq);

    // Find which band contains the current frequency
    let matchingBand = null;
    for (let band of window.amateurBands) {
        if (currentFreq >= band.start && currentFreq <= band.end) {
            matchingBand = band;
            console.log('updateBandSelector: found matching band', band.label);
            break;
        }
    }

    if (matchingBand) {
        // Find the option with this band's data and select it
        // We need to iterate through options to find the matching one
        // because JSON.stringify order might differ
        let foundOption = false;
        for (let i = 0; i < selector.options.length; i++) {
            const option = selector.options[i];
            if (option.value) {
                try {
                    const optionData = JSON.parse(option.value);
                    if (optionData.label === matchingBand.label &&
                        optionData.start === matchingBand.start &&
                        optionData.end === matchingBand.end) {
                        console.log('updateBandSelector: setting selector to', optionData.label);
                        selector.value = option.value;
                        foundOption = true;
                        break;
                    }
                } catch (e) {
                    // Skip invalid options
                }
            }
        }

        if (!foundOption) {
            console.log('updateBandSelector: no matching option found in dropdown');
            selector.value = '';
        }
    } else {
        // No matching band, reset to default
        console.log('updateBandSelector: no matching band for frequency', currentFreq);
        selector.value = '';
    }
}

// Expose functions to global scope
window.populateBandSelector = populateBandSelector;
window.selectBandFromDropdown = selectBandFromDropdown;
window.updateBandSelector = updateBandSelector;

