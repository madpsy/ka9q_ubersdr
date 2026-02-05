// Import WebSocket Manager
import { WebSocketManager } from './websocket-manager.js';

// Import Bookmark Manager
import { loadBookmarks, drawBookmarksOnSpectrum, handleBookmarkClick } from './bookmark-manager.js';

// Import Bandwidth Control
import { adjustBandwidth, updateBandwidthTooltips, initializeBandwidthControl } from './bandwidth-control.js';

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

// Store bypass password globally (for WebSocket connections)
let bypassPassword = null;
window.bypassPassword = null;

// Initialize WebSocket Manager immediately after userSessionID is generated
const wsManager = new WebSocketManager({
    userSessionID: userSessionID,
    onMessage: handleMessage,
    onBinaryMessage: handleBinaryMessage,
    onConnect: () => {
        log('Connected!');
        updateConnectionStatus('connected');
        startStatsUpdates();

        // Initialize audio context if not already done
        if (!audioContext) {
            // Start with browser's default sample rate - will be recreated when first audio arrives
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            window.audioContext = audioContext;
            currentAudioContextSampleRate = audioContext.sampleRate;
            nextPlayTime = audioContext.currentTime;
            window.nextPlayTime = nextPlayTime;
            audioStartTime = audioContext.currentTime;
            log(`Audio context initialized (sample rate: ${audioContext.sampleRate} Hz, will match incoming audio)`);

            // Create analyser for spectrum/waterfall (pre-filter tap)
            analyser = audioContext.createAnalyser();
            analyser.fftSize = getOptimalFFTSize();
            analyser.smoothingTimeConstant = 0;
            updateFFTSizeDropdown();

            // Create post-filter analyser for visualization (same tap point as VU meter)
            postFilterAnalyser = audioContext.createAnalyser();
            postFilterAnalyser.fftSize = getOptimalFFTSize();
            postFilterAnalyser.smoothingTimeConstant = 0;

            // Create dedicated analyser for VU meter and visualizations
            vuAnalyser = audioContext.createAnalyser();
            vuAnalyser.fftSize = getOptimalFFTSize();
            vuAnalyser.smoothingTimeConstant = 0;

            // Expose analysers globally for extensions
            window.analyser = analyser;
            window.postFilterAnalyser = postFilterAnalyser;
            window.vuAnalyser = vuAnalyser;

            // Initialize stereo channel routing
            initializeStereoChannels();
            initializeSquelch();
            initializeCompressor();
            initializeLowpassFilter();
            initializeEqualizer();

            // Restore "Save Filters" checkbox state first
            if (window.restoreSaveFiltersCheckbox) {
                window.restoreSaveFiltersCheckbox();
            }

            // Restore filter settings from localStorage
            if (window.restoreFilterSettings) {
                window.restoreFilterSettings();
            }

            // Check if NR2 should be enabled after restoration
            const nr2Checkbox = document.getElementById('noise-reduction-enable');
            if (nr2Checkbox && nr2Checkbox.checked) {
                // Checkbox was restored as checked, now enable NR2
                toggleNoiseReduction();
            }

            // Initialize waterfall timestamp
            waterfallStartTime = Date.now();
            waterfallLineCount = 0;

            updateOscilloscopeZoom();
            startVisualization();

            // Start waterfall auto-adjust (always enabled)
            console.log('Attempting to start waterfall auto-adjust interval...');
            console.log('waterfallAutoAdjustInterval:', waterfallAutoAdjustInterval);
            console.log('WATERFALL_AUTO_ADJUST_UPDATE_RATE:', WATERFALL_AUTO_ADJUST_UPDATE_RATE);
            if (!waterfallAutoAdjustInterval) {
                waterfallAutoAdjustInterval = setInterval(updateWaterfallAutoAdjust, WATERFALL_AUTO_ADJUST_UPDATE_RATE);
                console.log('Waterfall auto-adjust interval started:', waterfallAutoAdjustInterval);
                log('Waterfall auto-adjust enabled');
            } else {
                console.log('Waterfall auto-adjust interval already exists');
            }

            // Open extensions from URL parameter if specified
            if (window.extensionsToOpen && window.extensionsToOpen.length > 0) {
                // Check if we're on a mobile/narrow screen
                const isMobile = window.matchMedia('(max-width: 768px)').matches;
                if (isMobile) {
                    log('📱 Mobile device detected - skipping URL extension loading');
                    delete window.extensionsToOpen;
                    delete window.extensionAutoLoaded;
                } else {
                    setTimeout(() => {
                        window.extensionsToOpen.forEach(extName => {
                            // Skip if this extension was already auto-loaded by extension-loader
                            if (window.extensionAutoLoaded === extName) {
                                log(`Skipping URL extension (already auto-loaded): ${extName}`);
                                return;
                            }
                            if (window.toggleExtension) {
                                window.toggleExtension(extName);
                                log(`Opened extension from URL: ${extName}`);
                            }
                        });
                        delete window.extensionsToOpen;
                        delete window.extensionAutoLoaded; // Clean up flag
                    }, 100);
                }
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
let currentAudioContextSampleRate = 0; // Track current AudioContext sample rate
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

// Signal quality metrics from audio packets (version 2 protocol)
let currentBasebandPower = -999.0; // dBFS
let currentNoiseDensity = -999.0; // dBFS
let lastSignalQualityUpdate = 0;

// SNR history for chart (10 seconds at 500ms updates = 20 data points)
let snrHistory = [];
const SNR_HISTORY_MAX_AGE = 10000; // 10 seconds in milliseconds
let snrChartCanvas = null;
let snrChartCtx = null;

// Audio buffer configuration (user-configurable)
let maxBufferMs = 200; // Default 200ms, can be changed by user
const MIN_BUFFER_MS = 40; // Minimum 40ms buffer for Chrome stability
const BUFFER_PRESETS = [50, 100, 150, 200, 300, 500]; // Available preset values
// Expose nextPlayTime globally for extensions
window.nextPlayTime = 0;
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

// Initialize global storage for active channels (populated by displayActiveChannels)
window.activeChannels = [];

// Expose mode and bandwidth globally for recorder
window.currentMode = currentMode;
window.currentBandwidthLow = currentBandwidthLow;
window.currentBandwidthHigh = currentBandwidthHigh;

// Audio analysis
let analyser = null; // Analyser for spectrum/waterfall (legacy - kept for compatibility)
let postFilterAnalyser = null; // Post-filter analyser (legacy - kept for compatibility)
let vuAnalyser = null; // Dedicated analyser for VU meter and all visualizations (after all processing, real-time)
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
let noiseBlankerEnabled = false; // Track if noise blanker is enabled
let noiseBlankerProcessor = null; // ScriptProcessor for noise blanker
let nb = null; // Noise blanker instance

// Amateur radio band ranges (in Hz) - UK RSGB allocations
const bandRanges = {
    '160m': { min: 1810000, max: 2000000 },  // UK: 1.81-2.0 MHz
    '80m': { min: 3500000, max: 3800000 },   // UK: 3.5-3.8 MHz
    '60m': { min: 5258500, max: 5406500 },   // UK: 5.2585-5.4065 MHz
    '40m': { min: 7000000, max: 7200000 },   // UK: 7.0-7.2 MHz
    '30m': { min: 10100000, max: 10150000 }, // UK: 10.1-10.15 MHz (WARC band)
    '20m': { min: 14000000, max: 14350000 }, // UK: 14.0-14.35 MHz
    '17m': { min: 18068000, max: 18168000 }, // UK: 18.068-18.168 MHz (WARC band)
    '15m': { min: 21000000, max: 21450000 }, // UK: 21.0-21.45 MHz
    '12m': { min: 24890000, max: 24990000 }, // UK: 24.89-24.99 MHz (WARC band)
    '10m': { min: 28000000, max: 29700000 }  // UK: 28.0-29.7 MHz
};

// Expose bandRanges globally for band state monitor
window.bandRanges = bandRanges;

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

    // Also update band status badges if the function exists
    if (window.updateBandBadgeActiveStates) {
        window.updateBandBadgeActiveStates();
    }
}

// Update page title with current frequency and mode
function updatePageTitle() {
    const freqInput = document.getElementById('frequency');
    if (freqInput && currentMode) {
        // Get frequency from data-hz-value attribute
        const freq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
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
            // Don't capture F key when typing in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                return;
            }
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
        // B key: Toggle Noise Blanker
        else if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            toggleNBQuick();
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
        // Number keys 1-0: Set band (matches visual order left to right)
        else if (e.key === '1') {
            e.preventDefault();
            setBand('160m');
        }
        else if (e.key === '2') {
            e.preventDefault();
            setBand('80m');
        }
        else if (e.key === '3') {
            e.preventDefault();
            setBand('60m');
        }
        else if (e.key === '4') {
            e.preventDefault();
            setBand('40m');
        }
        else if (e.key === '5') {
            e.preventDefault();
            setBand('30m');
        }
        else if (e.key === '6') {
            e.preventDefault();
            setBand('20m');
        }
        else if (e.key === '7') {
            e.preventDefault();
            setBand('17m');
        }
        else if (e.key === '8') {
            e.preventDefault();
            setBand('15m');
        }
        else if (e.key === '9') {
            e.preventDefault();
            setBand('12m');
        }
        else if (e.key === '0') {
            e.preventDefault();
            setBand('10m');
        }
        // Z key: Decrease bandwidth
        else if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            adjustBandwidth(-1);
        }
        // X key: Increase bandwidth
        else if (e.key === 'x' || e.key === 'X') {
            e.preventDefault();
            adjustBandwidth(1);
        }
    });

    // Setup audio start overlay
    const audioStartButton = document.getElementById('audio-start-button');
    const audioStartOverlay = document.getElementById('audio-start-overlay');

    if (audioStartButton && audioStartOverlay) {
        // Disable button and show "Please wait..." while checking connection
        // Store original HTML but keep the receiver-callsign element structure
        const originalHTML = audioStartButton.innerHTML;
        audioStartButton.disabled = true;
        // Keep the callsign element in the DOM so it can be populated later
        audioStartButton.innerHTML = '<span id="receiver-callsign" class="receiver-callsign"></span><span>Please wait...</span>';

        // Check if connection will be allowed
        checkConnectionOnLoad(audioStartButton, audioStartOverlay, originalHTML);

        audioStartButton.addEventListener('click', async () => {
            // Hide overlay
            audioStartOverlay.classList.add('hidden');

            // Resume AudioContext if suspended (required for iOS Safari)
            // MUST await this to ensure it completes before audio playback
            if (audioContext && audioContext.state === 'suspended') {
                try {
                    await audioContext.resume();
                    console.log('AudioContext resumed for iOS/Safari - state:', audioContext.state);
                    log('Audio context activated for iOS');
                } catch (err) {
                    console.error('Failed to resume AudioContext:', err);
                    log('Failed to activate audio context', 'error');
                }
            }

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

    // Set audio visualization as disabled by default (collapsed)
    audioVisualizationEnabled = false;

    // Show compact VU meter since full visualization is hidden
    const compactVU = document.getElementById('vu-meter-compact');
    if (compactVU) compactVU.style.display = 'flex';

    // Hide the full visualization content
    const content = document.getElementById('audio-visualization-content');
    if (content) content.style.display = 'none';

    // Remove expanded class from toggle
    const toggle = document.getElementById('audio-viz-toggle');
    if (toggle) toggle.classList.remove('expanded');

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

    // Initialize bandwidth control (tooltips and keyboard shortcuts)
    initializeBandwidthControl();

    // Expose bandwidth control functions globally
    window.adjustBandwidth = adjustBandwidth;
    window.updateBandwidthTooltips = updateBandwidthTooltips;

    // Initialize frequency scroll mode with default values
    if (typeof updateFrequencyScrollMode === 'function') {
        updateFrequencyScrollMode();
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
async function checkConnectionOnLoad(audioStartButton, audioStartOverlay, originalHTML, password = null) {
    try {
        const requestBody = {
            user_session_id: userSessionID
        };

        // Add password if provided
        if (password) {
            requestBody.password = password;
        }

        const checkResponse = await fetch('/connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
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
                let errorIcon = '';
                if (checkData.reason.includes('banned')) {
                    errorIcon = '';
                } else if (checkData.reason.includes('Maximum')) {
                    errorIcon = '';
                }

                audioStartButton.innerHTML = `<span>${errorIcon} ${checkData.reason}</span>`;

                // Show password bypass UI (unless this was already a password attempt)
                if (!password) {
                    const passwordContainer = document.getElementById('password-bypass-container');
                    if (passwordContainer) {
                        passwordContainer.style.display = 'block';
                        // Focus on password input
                        setTimeout(() => {
                            const passwordInput = document.getElementById('bypass-password-input');
                            if (passwordInput) {
                                passwordInput.focus();
                            }
                        }, 100);
                    }
                }

                // Also log the error
                log(`Connection not allowed: ${checkData.reason}`, 'error');
            }
        } else {
            // Connection allowed
            // If password was used, store it for WebSocket connections
            if (password) {
                bypassPassword = password;
                window.bypassPassword = password;
                log('Bypass password accepted');

                // Hide password UI
                const passwordContainer = document.getElementById('password-bypass-container');
                if (passwordContainer) {
                    passwordContainer.style.display = 'none';
                }

                // Clear any error messages
                const errorMessage = document.getElementById('password-error-message');
                if (errorMessage) {
                    errorMessage.style.display = 'none';
                }

                // Reconnect spectrum WebSocket with password
                if (window.spectrumDisplay) {
                    log('Reconnecting spectrum WebSocket with bypass password');
                    window.spectrumDisplay.disconnect();
                    setTimeout(() => {
                        window.spectrumDisplay.connect();
                    }, 100);
                }
            }

            // Set session info for countdown timer
            if (window.setSessionInfo && checkData.max_session_time !== undefined) {
                window.setSessionInfo(checkData.max_session_time);
            }

            // Enable the play button immediately (or after short delay)
            setTimeout(() => {
                audioStartButton.disabled = false;
                // Preserve the callsign text before restoring HTML
                const callsignEl = document.getElementById('receiver-callsign');
                const callsignText = callsignEl ? callsignEl.textContent : '';
                audioStartButton.innerHTML = originalHTML;
                // Re-populate the callsign after restoring HTML
                const newCallsignEl = document.getElementById('receiver-callsign');
                if (newCallsignEl && callsignText) {
                    newCallsignEl.textContent = callsignText;
                    console.log('[Callsign] Restored after button enable:', callsignText);
                }
                audioStartButton.style.backgroundColor = ''; // Reset color
                audioStartButton.style.cursor = ''; // Reset cursor
            }, password ? 500 : 2000); // Shorter delay if password was used
        }
    } catch (err) {
        console.error('Connection check failed:', err);
        // On error, enable button after delay anyway
        setTimeout(() => {
            audioStartButton.disabled = false;
            // Preserve the callsign text before restoring HTML
            const callsignEl = document.getElementById('receiver-callsign');
            const callsignText = callsignEl ? callsignEl.textContent : '';
            audioStartButton.innerHTML = originalHTML;
            // Re-populate the callsign after restoring HTML
            const newCallsignEl = document.getElementById('receiver-callsign');
            if (newCallsignEl && callsignText) {
                newCallsignEl.textContent = callsignText;
            }
        }, 2000);
    }
}

// Submit bypass password
window.submitBypassPassword = async function() {
    const passwordInput = document.getElementById('bypass-password-input');
    const errorMessage = document.getElementById('password-error-message');
    const submitButton = document.getElementById('bypass-password-submit');
    const audioStartButton = document.getElementById('audio-start-button');

    if (!passwordInput || !submitButton) return;

    const password = passwordInput.value.trim();

    if (!password) {
        if (errorMessage) {
            errorMessage.textContent = 'Please enter a password';
            errorMessage.style.display = 'block';
        }
        return;
    }

    // Disable submit button and show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Checking...';

    if (errorMessage) {
        errorMessage.style.display = 'none';
    }

    // Get the original HTML from the button's data attribute or reconstruct it
    const originalHTML = `<svg width="80" height="80" viewBox="0 0 80 80">
                    <polygon points="25,15 25,65 65,40" fill="white"/>
                </svg>
                <span>Click to Start</span>`;

    // Retry connection check with password
    try {
        await checkConnectionOnLoad(audioStartButton, document.getElementById('audio-start-overlay'), originalHTML, password);

        // Check if connection was successful
        if (bypassPassword === password) {
            // Success - password was accepted
            log('Connection allowed with bypass password');
        } else {
            // Password was rejected
            if (errorMessage) {
                errorMessage.textContent = 'Invalid password';
                errorMessage.style.display = 'block';
            }
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (err) {
        console.error('Password check failed:', err);
        if (errorMessage) {
            errorMessage.textContent = 'Connection error. Please try again.';
            errorMessage.style.display = 'block';
        }
    } finally {
        // Re-enable submit button
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
};

// Add Enter key support for password input
document.addEventListener('DOMContentLoaded', () => {
    const passwordInput = document.getElementById('bypass-password-input');
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                window.submitBypassPassword();
            }
        });
    }
});

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

                // Update footer version if available
                if (data.version) {
                    const footerVersionEl = document.getElementById('footer-version');
                    if (footerVersionEl) {
                        footerVersionEl.textContent = `• v${data.version}`;
                    }
                }

                // Update receiver callsign if available
                if (data.receiver && data.receiver.callsign) {
                    const callsignEl = document.getElementById('receiver-callsign');
                    if (callsignEl) {
                        callsignEl.textContent = data.receiver.callsign;
                        console.log('[Callsign] Set to:', data.receiver.callsign);
                    }
                }

                // Show band conditions button if noise floor monitoring is enabled
                if (data.noise_floor === true) {
                    const bandConditionsBtn = document.getElementById('band-conditions-button');
                    if (bandConditionsBtn) {
                        bandConditionsBtn.style.display = 'block';
                    }
                }

                // Show live map button if digital decodes are enabled
                if (data.digital_decodes === true) {
                    const digitalSpotsBtn = document.getElementById('digital-spots-button');
                    if (digitalSpotsBtn) {
                        digitalSpotsBtn.style.display = 'block';
                    }

                    // Also show footer link to live map
                    const footerLink = document.getElementById('footer-digitalspots-link');
                    if (footerLink) {
                        footerLink.style.display = 'inline';
                    }
                }

                // Show UUID button if public_uuid is available
                if (data.public_uuid && data.public_uuid.trim() !== '') {
                    const uuidBtn = document.getElementById('uuid-button');
                    if (uuidBtn) {
                        uuidBtn.style.display = 'block';
                        // Store the UUID for the copy function
                        window.publicUUID = data.public_uuid;
                    }
                }

                // Add map if GPS coordinates are available
                if (data.receiver && data.receiver.gps &&
                    data.receiver.gps.lat !== 0 && data.receiver.gps.lon !== 0) {
                    const lat = data.receiver.gps.lat;
                    const lon = data.receiver.gps.lon;
                    const name = data.receiver.name || 'Receiver';
                    const location = data.receiver.location || '';
                    const asl = data.receiver.asl || 0;

                    // Calculate day/night status using SunCalc if available
                    let dayNightStatus = '';
                    if (typeof SunCalc !== 'undefined') {
                        const times = SunCalc.getTimes(new Date(), lat, lon);
                        const now = new Date();
                        const isDaytime = now >= times.sunrise && now < times.sunset;
                        const icon = isDaytime ? '☀️' : '🌙';
                        const status = isDaytime ? 'Day' : 'Night';
                        dayNightStatus = ` ${icon} ${status}`;
                    }

                    // Load Leaflet CSS and JS dynamically
                    if (!document.getElementById('leaflet-css')) {
                        const leafletCSS = document.createElement('link');
                        leafletCSS.id = 'leaflet-css';
                        leafletCSS.rel = 'stylesheet';
                        leafletCSS.href = 'leaflet.css';
                        leafletCSS.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
                        leafletCSS.crossOrigin = '';
                        document.head.appendChild(leafletCSS);
                    }

                    if (!window.L) {
                        const leafletJS = document.createElement('script');
                        leafletJS.src = 'leaflet.js';
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

                    // Create custom icon for receiver (matching digitalspots_map.js)
                    const receiverIcon = L.divIcon({
                        className: '', // Empty className to avoid default Leaflet styling
                        html: '<div style="width: 20px; height: 20px; background: #ff0000; border: 3px solid rgba(255, 255, 255, 0.9); border-radius: 50%; box-shadow: 0 0 10px rgba(255, 0, 0, 0.5);"></div>',
                        iconSize: [20, 20],
                        iconAnchor: [10, 10]
                    });

                    // Add marker with custom icon and permanent tooltip
                    const marker = L.marker([lat, lon], { icon: receiverIcon }).addTo(map);
                    let tooltipContent = `<strong>${name}</strong>`;
                    if (location) {
                        tooltipContent += `<br>${location}`;
                    }
                    tooltipContent += `<br>${asl}m ASL${dayNightStatus}`;
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
                    // Use Google Maps with exact coordinates - this will show a pin at the precise location
                    mapLink.innerHTML = `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" style="color: #007bff;">View larger map</a>`;
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
    const freqInput = document.getElementById('frequency');
    // Get frequency from data-hz-value attribute
    const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
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
    console.log('[displayActiveChannels] Called with channels:', channels);
    const listEl = document.getElementById('active-channels-list');
    if (!listEl) return;
    
    // Store channels globally for spectrum display markers
    window.activeChannels = channels || [];
    console.log('[displayActiveChannels] Stored window.activeChannels:', window.activeChannels);
    
    // Invalidate spectrum display marker cache to force redraw with new chat user markers
    if (window.spectrumDisplay && window.spectrumDisplay.invalidateMarkerCache) {
        window.spectrumDisplay.invalidateMarkerCache();
        console.log('[displayActiveChannels] Invalidated spectrum marker cache');
    }

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
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Country</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #444;">Chat</th>';
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

        // Add country column with flag if country_code exists
        const country = channel.country || '';
        const countryCode = channel.country_code || '';
        const latitude = channel.latitude;
        const longitude = channel.longitude;
        let countryHtml = '';
        if (countryCode) {
            // Add flag image with onerror handler to hide if 404
            countryHtml = `<img src="flags/${countryCode.toLowerCase()}.svg"
                style="width: 20px; height: 15px; border: 1px solid #666; margin-right: 6px; vertical-align: middle;"
                onerror="this.style.display='none'">`;
        }
        // If latitude and longitude are available, make country name a clickable link to Google Maps
        if (latitude != null && longitude != null && country) {
            countryHtml += `<a href="https://www.google.com/maps?q=${latitude},${longitude}" target="_blank" style="color: #4a9eff; text-decoration: none;">${country}</a>`;
        } else {
            countryHtml += country;
        }
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${countryHtml}</td>`;

        // Add chat username column if it exists and has a value
        const chatUsername = channel.chat_username || '';
        html += `<td style="padding: 8px; border-bottom: 1px solid #333;">${chatUsername}</td>`;

        // Add "Go" button for other users' channels (not for current user)
        if (isCurrentUser) {
            html += `<td style="padding: 8px; border-bottom: 1px solid #333; text-align: center;">
                <span style="color: #888; font-style: italic;">You</span>
            </td>`;
        } else {
            // Disable button if mode is 'IQ' (case-insensitive)
            const isIQMode = channel.mode.toUpperCase() === 'IQ';
            const buttonDisabled = isIQMode ? 'disabled' : '';
            const buttonStyle = isIQMode
                ? 'background: #6c757d; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: not-allowed; font-size: 12px; font-weight: bold; opacity: 0.6;'
                : 'background: #007bff; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;';

            html += `<td style="padding: 8px; border-bottom: 1px solid #333; text-align: center;">
                <button onclick="tuneToChannel(${channel.frequency}, '${channel.mode}', ${channel.bandwidth_low}, ${channel.bandwidth_high})"
                    style="${buttonStyle}" ${buttonDisabled}>
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
    // Update frequency input (only if not currently being edited)
    const freqInput = document.getElementById('frequency');
    if (freqInput && document.activeElement !== freqInput) {
        setFrequencyInputValue(frequency);
    }
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

    // Disable edge detection temporarily when tuning to channel
    if (window.spectrumDisplay) {
        window.spectrumDisplay.skipEdgeDetection = true;
        setTimeout(() => {
            if (window.spectrumDisplay) {
                window.spectrumDisplay.skipEdgeDetection = false;
            }
        }, 2000);
    }

    // Tune to the new settings
    if (wsManager.isConnected()) {
        autoTune();
        log(`Tuned to channel: ${formatFrequency(frequency)} ${mode.toUpperCase()} (BW: ${bandwidthLow} to ${bandwidthHigh} Hz)`);
    } else {
        connect();
        log(`Connecting to channel: ${formatFrequency(frequency)} ${mode.toUpperCase()} (BW: ${bandwidthLow} to ${bandwidthHigh} Hz)`);
    }
}

// Handle incoming binary messages (Opus format)
async function handleBinaryMessage(data) {
    if (!audioContext) {
        return;
    }

    try {
        // Convert Blob to ArrayBuffer if needed
        let arrayBuffer;
        if (data instanceof Blob) {
            arrayBuffer = await data.arrayBuffer();
        } else {
            arrayBuffer = data;
        }

        // Parse binary packet header
        // Version 1 (13 bytes): timestamp(8) + sample_rate(4) + channels(1)
        // Version 2 (21 bytes): timestamp(8) + sample_rate(4) + channels(1) + baseband_power(4) + noise_density(4)
        const view = new DataView(arrayBuffer);

        if (arrayBuffer.byteLength < 13) {
            console.error('Binary packet too short:', arrayBuffer.byteLength, 'bytes');
            return;
        }

        const timestamp = view.getBigUint64(0, true); // little-endian
        const sampleRate = view.getUint32(8, true); // little-endian
        const channels = view.getUint8(12);

        // Check if this is version 2 packet (has signal quality fields)
        let basebandPower = -999.0;
        let noiseDensity = -999.0;
        let opusDataOffset = 13;

        if (arrayBuffer.byteLength >= 21) {
            // Version 2 packet - extract signal quality metrics
            basebandPower = view.getFloat32(13, true); // little-endian float32
            noiseDensity = view.getFloat32(17, true); // little-endian float32
            opusDataOffset = 21;

            // Update global signal quality values (throttled to avoid excessive updates)
            const now = performance.now();
            if (now - lastSignalQualityUpdate >= 500) {
                currentBasebandPower = basebandPower;
                currentNoiseDensity = noiseDensity;
                lastSignalQualityUpdate = now;

                // Calculate SNR and add to history
                if (basebandPower > -900 && noiseDensity > -900) {
                    const snr = Math.max(0, basebandPower - noiseDensity);
                    const timestamp = Date.now();
                    snrHistory.push({ value: snr, timestamp: timestamp });

                    // Remove old entries (older than 10 seconds)
                    snrHistory = snrHistory.filter(entry => timestamp - entry.timestamp <= SNR_HISTORY_MAX_AGE);
                }

                // Update display if modal is open
                updateSignalQualityDisplay();
            }
        }

        const opusData = new Uint8Array(arrayBuffer, opusDataOffset);

        // Initialize or reinitialize decoder if sample rate or channels changed
        if (!opusDecoderInitialized ||
            opusDecoderSampleRate !== sampleRate ||
            opusDecoderChannels !== channels) {
            const success = await initOpusDecoder(sampleRate, channels);
            if (!success) {
                console.error('Failed to initialize Opus decoder');
                return;
            }
        }

        // Check if AudioContext sample rate needs to change
        if (audioContext && sampleRate !== currentAudioContextSampleRate) {
            log(`Sample rate changed from ${currentAudioContextSampleRate} Hz to ${sampleRate} Hz - recreating AudioContext`);

            // Close old context
            audioContext.close();

            // Create new context with matching sample rate
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: sampleRate
            });
            window.audioContext = audioContext;
            currentAudioContextSampleRate = sampleRate;
            nextPlayTime = audioContext.currentTime;
            window.nextPlayTime = nextPlayTime;
            audioStartTime = audioContext.currentTime;

            // Reinitialize all audio nodes
            analyser = audioContext.createAnalyser();
            analyser.fftSize = getOptimalFFTSize();
            analyser.smoothingTimeConstant = 0;
            updateFFTSizeDropdown();

            postFilterAnalyser = audioContext.createAnalyser();
            postFilterAnalyser.fftSize = getOptimalFFTSize();
            postFilterAnalyser.smoothingTimeConstant = 0;

            vuAnalyser = audioContext.createAnalyser();
            vuAnalyser.fftSize = getOptimalFFTSize();
            vuAnalyser.smoothingTimeConstant = 0;

            window.analyser = analyser;
            window.postFilterAnalyser = postFilterAnalyser;
            window.vuAnalyser = vuAnalyser;

            // Reinitialize audio processing nodes
            initializeStereoChannels();
            initializeSquelch();
            initializeCompressor();
            initializeLowpassFilter();
            initializeEqualizer();

            // Restore filter settings
            if (window.restoreFilterSettings) {
                window.restoreFilterSettings();
            }

            // Reinitialize NR2 if it was enabled
            if (noiseReductionEnabled) {
                try {
                    if (noiseReductionProcessor) noiseReductionProcessor.disconnect();
                    if (noiseReductionMakeupGain) noiseReductionMakeupGain.disconnect();
                    if (noiseReductionAnalyser) noiseReductionAnalyser.disconnect();
                } catch (e) {
                    // Ignore disconnect errors from closed context
                }

                noiseReductionProcessor = null;
                noiseReductionMakeupGain = null;
                noiseReductionAnalyser = null;
                nr2 = null;

                const success = initNoiseReduction();
                if (success) {
                    if (nr2) {
                        nr2.enabled = true;
                        nr2.setParameters(noiseReductionStrength, noiseReductionFloor, 1.0);
                    }
                    log('✅ NR2 reinitialized after AudioContext recreation');
                } else {
                    noiseReductionEnabled = false;
                    const nr2Checkbox = document.getElementById('noise-reduction-enable');
                    if (nr2Checkbox) nr2Checkbox.checked = false;
                    log('❌ Failed to reinitialize NR2 - disabled', 'error');
                }
            }

            log(`AudioContext recreated at ${sampleRate} Hz (eliminates Chrome resampling artifacts)`);
        }

        // Decode Opus packet to PCM using decodeFrame method
        const decoded = await opusDecoder.decodeFrame(opusData);

        if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
            console.error('Opus decode returned empty data');
            return;
        }

        // Create stereo audio buffer from decoded PCM data
        // Use the sample rate from the decoded result
        const numChannels = Math.max(2, decoded.channelData.length);
        const audioBuffer = audioContext.createBuffer(
            numChannels,
            decoded.channelData[0].length,
            sampleRate  // Use sampleRate from packet header
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

        // Play the decoded audio
        playAudioBuffer(audioBuffer);

    } catch (e) {
        console.error('Failed to process binary Opus message:', e);
        log('Opus decoding error: ' + e.message, 'error');
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
        case 'squelch_updated':
            // Squelch state update from server (informational only)
            // The server sends this when squelch opens/closes
            break;
        default:
            console.log('Unknown message type:', msg.type);
    }
}

// Opus decoder context (will be initialized when needed)
let opusDecoder = null;
let opusDecoderInitialized = false;
let opusDecoderFailed = false;
let opusDecoderSampleRate = null;
let opusDecoderChannels = null;

// Initialize Opus decoder
async function initOpusDecoder(sampleRate, channels) {
    if (opusDecoderFailed) {
        return false;
    }

    if (opusDecoderInitialized) {
        // Silently return true if already initialized (normal during squelch)
        return true;
    }

    console.log('Initializing Opus decoder:', sampleRate, 'Hz,', channels, 'channels');

    // Check if OpusDecoder library is available
    // The library exports to window["opus-decoder"].OpusDecoder
    let OpusDecoderClass = null;
    if (typeof OpusDecoder !== 'undefined') {
        OpusDecoderClass = OpusDecoder;
    } else if (window["opus-decoder"] && window["opus-decoder"].OpusDecoder) {
        OpusDecoderClass = window["opus-decoder"].OpusDecoder;
    }

    console.log('Checking for OpusDecoder:', OpusDecoderClass ? 'found' : 'not found');
    if (!OpusDecoderClass) {
        console.error('OpusDecoder library not loaded - waiting for script to load');
        // Don't mark as failed yet - library may still be loading
        // Just return false and let it retry on next packet
        return false;
    }

    try {
        console.log('Creating OpusDecoder instance...');
        opusDecoder = new OpusDecoderClass({
            sampleRate: sampleRate,
            channels: channels
        });
        console.log('Waiting for decoder.ready...');
        await opusDecoder.ready;
        opusDecoderInitialized = true;
        opusDecoderSampleRate = sampleRate;
        opusDecoderChannels = channels;
        console.log('Opus decoder initialized successfully');
        log(`Opus decoder initialized for ${sampleRate} Hz, ${channels} channel(s)`);
        return true;
    } catch (e) {
        console.error('Failed to initialize Opus decoder:', e);
        log('Opus decoder initialization failed: ' + e.message, 'error');
        log('Falling back to PCM audio format', 'error');
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

        // Update frequency display (if element exists)
        const currentFreqElement = document.getElementById('current-freq');
        if (currentFreqElement) {
            currentFreqElement.textContent = freqText;
        }

        // Only update frequency input if user is not currently editing it
        const freqInput = document.getElementById('frequency');
        if (freqInput && document.activeElement !== freqInput) {
            setFrequencyInputValue(msg.frequency);
        }

        // Update mode display (without band name) (if element exists)
        if (msg.mode) {
            const modeText = msg.mode.toUpperCase();
            const currentModeElement = document.getElementById('current-mode');
            if (currentModeElement) {
                currentModeElement.textContent = modeText;
            }
        }

        // Update bandwidth display
        updateCurrentBandwidthDisplay(window.currentBandwidthLow, window.currentBandwidthHigh);

        // Update band display (if element exists)
        const bandElement = document.getElementById('current-band');
        if (bandElement) {
            bandElement.textContent = bandName || '-';
        }

        updateBandButtons(msg.frequency);
        // Update spectrum display cursor - use window globals for latest values
        // Skip bandwidth update if chat is syncing to prevent flickering
        if (spectrumDisplay) {
            const updateData = {
                tunedFreq: msg.frequency
            };
            // Only update bandwidth if not syncing (prevents old server values from overwriting sync)
            if (!window.chatUI || !window.chatUI.isSyncing) {
                updateData.bandwidthLow = window.currentBandwidthLow;
                updateData.bandwidthHigh = window.currentBandwidthHigh;
            }
            spectrumDisplay.updateConfig(updateData);
        }
    } else if (msg.mode) {
        // Mode update without frequency - just update mode text (if element exists)
        const currentModeElement = document.getElementById('current-mode');
        if (currentModeElement) {
            currentModeElement.textContent = msg.mode.toUpperCase();
        }
    }

    // Update page title
    updatePageTitle();

    // Update CAT sync state
    if (typeof updateCATSyncState === 'function') {
        updateCATSyncState();
    }

    // Only log status updates that are NOT from periodic sync (i.e., user-initiated changes)
    // Check if this is a significant change by comparing with last logged values
    if (!window.lastLoggedStatus ||
        window.lastLoggedStatus.frequency !== msg.frequency ||
        window.lastLoggedStatus.mode !== msg.mode) {
        log(`Status: ${formatFrequency(msg.frequency)} ${msg.mode.toUpperCase()}`);
        window.lastLoggedStatus = { frequency: msg.frequency, mode: msg.mode };
    }
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
    // Check if sample rate changed - if so, recreate AudioContext
    if (audioContext && msg.sampleRate !== currentAudioContextSampleRate) {
        log(`Sample rate changed from ${currentAudioContextSampleRate} Hz to ${msg.sampleRate} Hz - recreating AudioContext`);

        // Store old context reference to check if nodes belong to it
        const oldContext = audioContext;

        // Close old context
        oldContext.close();

        // Create new context with matching sample rate
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: msg.sampleRate
        });
        window.audioContext = audioContext;
        currentAudioContextSampleRate = msg.sampleRate;
        nextPlayTime = audioContext.currentTime;
        window.nextPlayTime = nextPlayTime;
        audioStartTime = audioContext.currentTime;

        // Reinitialize all audio nodes
        analyser = audioContext.createAnalyser();
        analyser.fftSize = getOptimalFFTSize();
        analyser.smoothingTimeConstant = 0;
        updateFFTSizeDropdown();

        postFilterAnalyser = audioContext.createAnalyser();
        postFilterAnalyser.fftSize = getOptimalFFTSize();
        postFilterAnalyser.smoothingTimeConstant = 0;

        vuAnalyser = audioContext.createAnalyser();
        vuAnalyser.fftSize = getOptimalFFTSize();
        vuAnalyser.smoothingTimeConstant = 0;

        window.analyser = analyser;
        window.postFilterAnalyser = postFilterAnalyser;
        window.vuAnalyser = vuAnalyser;

        // Reinitialize audio processing nodes
        initializeStereoChannels();
        initializeSquelch();
        initializeCompressor();
        initializeLowpassFilter();
        initializeEqualizer();

        // Restore filter settings
        if (window.restoreFilterSettings) {
            window.restoreFilterSettings();
        }

        // Reinitialize NR2 processor if it was enabled
        if (noiseReductionEnabled) {
            // Disconnect and clear old processor (belongs to closed AudioContext)
            try {
                if (noiseReductionProcessor) {
                    noiseReductionProcessor.disconnect();
                }
                if (noiseReductionMakeupGain) {
                    noiseReductionMakeupGain.disconnect();
                }
                if (noiseReductionAnalyser) {
                    noiseReductionAnalyser.disconnect();
                }
            } catch (e) {
                // Ignore disconnect errors from closed context
            }

            noiseReductionProcessor = null;
            noiseReductionMakeupGain = null;
            noiseReductionAnalyser = null;
            nr2 = null;

            // Reinitialize with new AudioContext
            const success = initNoiseReduction();
            if (success) {
                // Enable processing in NR2
                if (nr2) {
                    nr2.enabled = true;
                    nr2.setParameters(noiseReductionStrength, noiseReductionFloor, 1.0);
                }
                log('✅ NR2 reinitialized after AudioContext recreation');
            } else {
                // Failed to reinitialize - disable NR2
                noiseReductionEnabled = false;
                const nr2Checkbox = document.getElementById('noise-reduction-enable');
                if (nr2Checkbox) {
                    nr2Checkbox.checked = false;
                }
                log('❌ Failed to reinitialize NR2 - disabled', 'error');
            }
        }

        log(`AudioContext recreated at ${msg.sampleRate} Hz (eliminates Chrome resampling artifacts)`);
    }

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
    // Safety check: ensure audioContext and analysers are valid
    if (!audioContext || audioContext.state === 'closed') {
        console.warn('AudioContext is closed, skipping buffer');
        return;
    }

    // Resume AudioContext if suspended (iOS Safari fix)
    // This ensures audio can play even if context was suspended after initial resume
    // Use await to ensure resume completes before scheduling audio
    if (audioContext.state === 'suspended') {
        console.warn('AudioContext suspended during playback - resuming...');
        // Don't await here as it would block the audio chain
        // Just trigger resume and let it complete asynchronously
        audioContext.resume().then(() => {
            console.log('AudioContext resumed during playback - state:', audioContext.state);
        }).catch(err => {
            console.error('Failed to resume AudioContext during playback:', err);
        });
        // Return early to skip this buffer - next buffer will play after resume
        return;
    }

    // Safety check: ensure analysers belong to current context
    if (!analyser || analyser.context !== audioContext) {
        console.warn('Analyser belongs to old context, skipping buffer');
        return;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    // Audio chain:
    // source -> analyser (for spectrum/waterfall) -> [squelch] -> [compressor] -> [bandpass] -> [notch] -> EQ -> vuAnalyser (for visualizations) -> gain (for volume/mute) -> destination
    // The main analyser taps the signal early for spectrum/waterfall but doesn't affect it
    // The squelch gate is FIRST to prevent noise from reaching other filters
    // The vuAnalyser taps BEFORE volume/mute so visualizations work independently of volume settings
    source.connect(analyser);

    // Build the audio processing chain step by step
    let nextNode = source;

    // Step 0a: Noise Blanker (FIRST - remove impulse noise before any other processing)
    if (noiseBlankerEnabled && noiseBlankerProcessor) {
        // Safety check: ensure processor belongs to current AudioContext
        if (noiseBlankerProcessor.context !== audioContext) {
            console.warn('Noise Blanker processor belongs to old AudioContext, skipping connection');
            // Clear the old processor to trigger reinitialization
            noiseBlankerProcessor = null;
            nb = null;
        } else {
            try {
                noiseBlankerProcessor.disconnect();
            } catch (e) {
                // Ignore if already disconnected
            }

            // Connect processor in signal chain
            nextNode.connect(noiseBlankerProcessor);
            nextNode = noiseBlankerProcessor;
        }
    }

    // Step 0b: Noise Reduction (SECOND - clean signal before squelch/other processing)
    if (noiseReductionEnabled && noiseReductionProcessor) {
        // Safety check: ensure processor belongs to current AudioContext
        if (noiseReductionProcessor.context !== audioContext) {
            console.warn('NR2 processor belongs to old AudioContext, skipping connection');
            // Clear the old processor to trigger reinitialization
            noiseReductionProcessor = null;
            noiseReductionMakeupGain = null;
            noiseReductionAnalyser = null;
            nr2 = null;
        } else {
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

    // Step 6: Tap vuAnalyser and postFilterAnalyser BEFORE volume/mute
    // This ensures visualizations work independently of volume/mute settings
    if (vuAnalyser) {
        nextNode.connect(vuAnalyser);
    }
    if (postFilterAnalyser) {
        nextNode.connect(postFilterAnalyser);
    }

    // Step 7: Gain node for volume/mute control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = isMuted ? 0 : currentVolume;
    nextNode.connect(gainNode);

    // Step 8: Tap other analysers for clipping detection AFTER volume/mute
    // These monitor the actual output levels including volume/mute
    if (noiseReductionEnabled && noiseReductionAnalyser) {
        gainNode.connect(noiseReductionAnalyser);
    }
    if (compressorEnabled && compressorAnalyser) {
        gainNode.connect(compressorAnalyser);
    }
    if (equalizerEnabled && eqAnalyser) {
        gainNode.connect(eqAnalyser);
    }

    // Step 9: Stereo Virtualizer (optional, creates wider stereo image from mono)
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

    // Step 10: Recorder tap (BEFORE stereo conversion so it records full processed audio)
    if (window.recorderGainNode) {
        // If recorder is active, tap the signal before stereo conversion
        outputNode.connect(window.recorderGainNode);
    }

    // Step 11: Stereo channel routing (L/R selection for output only)
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

    // Step 12: Final output to destination
    outputNode.connect(audioContext.destination);

    // Buffer management using configurable threshold
    const MAX_BUFFER_SEC = maxBufferMs / 1000;
    const MIN_BUFFER_SEC = MIN_BUFFER_MS / 1000;
    const currentTime = audioContext.currentTime;

    // If we're falling behind (underrun), reset the schedule
    if (nextPlayTime < currentTime) {
        nextPlayTime = currentTime + MIN_BUFFER_SEC; // Add minimum buffer for Chrome
        window.nextPlayTime = nextPlayTime;
    }
    // If we're too far ahead (overrun), drop this packet to prevent lag accumulation
    else if ((nextPlayTime - currentTime) > MAX_BUFFER_SEC) {
        console.log(`Dropping audio packet: buffer at ${((nextPlayTime - currentTime) * 1000).toFixed(0)}ms (max ${maxBufferMs}ms)`);
        return; // Exit without scheduling this buffer
    }

    // Schedule this buffer to play at the next available time
    source.start(nextPlayTime);

    // Update next play time based on buffer duration
    nextPlayTime += buffer.duration;
    window.nextPlayTime = nextPlayTime;

    // Update buffer display and log timing info occasionally for debugging
    const timeSinceStart = currentTime - audioStartTime;
    const bufferAhead = nextPlayTime - currentTime;

    // Update buffer display element (throttled to ~2 updates per second)
    const now = performance.now();
    if (now - lastBufferDisplayUpdate >= 500) {
        // Update audio buffer display
        const bufferDisplay = document.getElementById('audio-buffer-display');
        const bufferBar = document.getElementById('audio-buffer-bar');
        const bufferText = document.getElementById('audio-buffer-text');
        if (bufferDisplay && bufferBar && bufferText) {
            const bufferMs = bufferAhead * 1000;
            const tooltipText = `Buffer: ${bufferMs.toFixed(0)}ms`;
            bufferDisplay.title = tooltipText;

            // Update text display
            bufferText.textContent = `${bufferMs.toFixed(0)}ms`;

            // Calculate bar width based on configurable max (show up to 1.5x max for visibility)
            const displayMax = maxBufferMs * 1.5;
            const widthPercent = Math.min((bufferMs / displayMax) * 100, 100);
            bufferBar.style.width = `${widthPercent}%`;

            // Calculate color based on buffer value (dynamic thresholds)
            // Green: 0-62.5% of max, Orange: 62.5-87.5% of max, Red: 87.5-100%+ of max
            const greenThreshold = maxBufferMs * 0.625;
            const orangeThreshold = maxBufferMs * 0.875;

            let color;
            if (bufferMs <= greenThreshold) {
                // Green zone
                color = '#28a745';
            } else if (bufferMs <= orangeThreshold) {
                // Orange zone - gradient from green to orange
                const ratio = (bufferMs - greenThreshold) / (orangeThreshold - greenThreshold);
                const r = Math.round(40 + (255 - 40) * ratio);
                const g = Math.round(167 + (193 - 167) * ratio);
                const b = Math.round(69 + (193 - 69) * ratio);
                color = `rgb(${r}, ${g}, ${b})`;
            } else {
                // Red zone
                color = '#dc3545';
            }
            bufferBar.style.backgroundColor = color;
        }

        lastBufferDisplayUpdate = now;
    }
}

// Tune to new frequency/mode/bandwidth
function tune() {
    if (!wsManager.isConnected()) {
        log('Not connected', 'error');
        return;
    }

    const freqInput = document.getElementById('frequency');
    // Get frequency from data-hz-value attribute if available
    const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
    const mode = currentMode;
    // Read from window globals to get the latest values
    const bandwidthLow = window.currentBandwidthLow;
    const bandwidthHigh = window.currentBandwidthHigh;

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
    // Store cursor position before any changes
    const cursorPos = input.selectionStart;
    const oldValue = input.value;

    // Remove any non-digit characters
    let value = oldValue.replace(/\D/g, '');

    // Limit to 8 digits (max 30000000)
    if (value.length > 8) {
        value = value.substring(0, 8);
    }

    // Only update if value actually changed (prevents unnecessary cursor resets)
    if (value !== oldValue) {
        input.value = value;

        // Calculate how many characters were removed before the cursor
        let removedBeforeCursor = 0;
        for (let i = 0; i < cursorPos && i < oldValue.length; i++) {
            if (!/\d/.test(oldValue[i])) {
                removedBeforeCursor++;
            }
        }

        // Restore cursor position, adjusting only for removed characters before cursor
        const newCursorPos = Math.max(0, Math.min(value.length, cursorPos - removedBeforeCursor));
        input.setSelectionRange(newCursorPos, newCursorPos);
    }
}

// Handle frequency input change - auto-connect if not connected
function handleFrequencyChange() {
    const freqInput = document.getElementById('frequency');
    const valueStr = freqInput.value.trim();

    // Don't validate incomplete input (less than 6 digits)
    // This prevents clamping while user is still typing
    if (valueStr.length < 6) {
        return;
    }

    let frequency = parseInt(valueStr);

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
        setFrequencyInputValue(frequency);
        log(`Frequency clamped to valid range: ${formatFrequency(frequency)}`, 'error');
    }

    // Update band button highlighting
    updateBandButtons(frequency);

    // Update band selector dropdown
    updateBandSelector();

    // Update spectrum cursor
    updateSpectrumCursor();

    // Update URL with new frequency
    updateURL();

    // Update CAT sync state
    if (typeof updateCATSyncState === 'function') {
        updateCATSyncState();
    }

    // Notify extensions of frequency change
    if (window.radioAPI) {
        window.radioAPI.notifyFrequencyChange(frequency);
    }

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

    setFrequencyInputValue(clampedFreq);
    updateBandButtons(clampedFreq);
    updateBandSelector();
    log(`Frequency preset: ${formatFrequency(clampedFreq)}`);

    // Update URL with new frequency
    updateURL();

    // Notify extensions of frequency change
    if (window.radioAPI) {
        window.radioAPI.notifyFrequencyChange(clampedFreq);
    }

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

    // Set frequency to band center (only if not currently being edited)
    const freqInput = document.getElementById('frequency');
    if (freqInput && document.activeElement !== freqInput) {
        setFrequencyInputValue(centerFreq);
    }
    updateBandButtons(centerFreq);
    updateBandSelector();

    // Check if band has a mode field in window.amateurBands
    let mode = null;
    if (window.amateurBands && window.amateurBands.length > 0) {
        const bandData = window.amateurBands.find(b => b.label === bandName);
        if (bandData && bandData.mode) {
            mode = bandData.mode;
            log(`Using band-specific mode: ${mode.toUpperCase()}`);
        }
    }

    // If no mode specified in band data, use default based on frequency
    // LSB below 10 MHz (80m, 40m), USB at 10 MHz and above (30m+)
    if (!mode) {
        mode = centerFreq < 10000000 ? 'lsb' : 'usb';
    }

    setMode(mode);

    // Update URL with new frequency and mode
    updateURL();

    // Notify extensions of frequency change
    if (window.radioAPI) {
        window.radioAPI.notifyFrequencyChange(centerFreq);
    }

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
        connect();
    } else {
        autoTune();
    }

    // Zoom spectrum to show entire band
    if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Set flag to prevent edge detection from interfering after zoom
        spectrumDisplay.skipEdgeDetection = true;
        // Clear the flag after a short delay (after zoom completes)
        setTimeout(() => {
            if (spectrumDisplay) {
                spectrumDisplay.skipEdgeDetection = false;
            }
        }, 2000);

        // Calculate bin bandwidth to show the full band width
        // Use a minimum bandwidth to prevent excessive zoom on narrow bands like 30m
        const minBandWidth = 100000; // 100 kHz minimum
        const effectiveBandWidth = Math.max(bandWidth, minBandWidth);
        // Use default bin count (1024) instead of current state to ensure consistent zoom
        const binCount = 1024; // Default from config.go
        const binBandwidth = effectiveBandWidth / binCount;

        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: centerFreq,
            binBandwidth: binBandwidth
        }));

        log(`Tuned to ${bandName} band: ${formatFrequency(centerFreq)} ${mode.toUpperCase()} (zoomed to ${formatFrequency(centerFreq - effectiveBandWidth/2)} - ${formatFrequency(centerFreq + effectiveBandWidth/2)})`);
    } else {
        log(`Tuned to ${bandName} band: ${formatFrequency(centerFreq)} ${mode.toUpperCase()}`);
    }
}

// Adjust frequency by a given amount (Hz)
function adjustFrequency(deltaHz) {
    const freqInput = document.getElementById('frequency');
    // Get current frequency from data-hz-value attribute
    const currentFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
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

    setFrequencyInputValue(roundedFreq);
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

    // Notify extensions of frequency change
    if (window.radioAPI) {
        window.radioAPI.notifyFrequencyChange(roundedFreq);
    }

    autoTune();
}

// Load settings from URL parameters
function loadSettingsFromURL() {
    const params = new URLSearchParams(window.location.search);

    // Load frequency
    if (params.has('freq')) {
        const freq = parseInt(params.get('freq'));
        if (!isNaN(freq) && freq >= 100000 && freq <= 30000000) {
            const freqInput = document.getElementById('frequency');
            if (freqInput && document.activeElement !== freqInput) {
                // Store as Hz value directly (don't use setFrequencyInputValue yet as unit may not be loaded)
                freqInput.value = freq;
                freqInput.setAttribute('data-hz-value', freq);
            }
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

    // Add frequency (get from data-hz-value attribute)
    const freqInput = document.getElementById('frequency');
    const freq = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
    if (!isNaN(freq) && freq > 0) {
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

    // Show/hide bandwidth vs squelch controls based on mode
    const bandwidthControls = document.getElementById('bandwidth-controls');
    const squelchControls = document.getElementById('squelch-controls');
    
    if (mode === 'fm' || mode === 'nfm') {
        // FM/NFM modes: hide bandwidth, show squelch
        bandwidthControls.style.display = 'none';
        squelchControls.style.display = 'block';
        
        // Send current squelch value to server when switching to FM mode
        if (wsManager && wsManager.ws && wsManager.ws.readyState === WebSocket.OPEN) {
            const squelchSlider = document.getElementById('squelch');
            if (squelchSlider) {
                const squelchValue = parseInt(squelchSlider.value);
                let squelchDb;
                if (squelchValue === 0) {
                    squelchDb = -999.0;
                } else {
                    squelchDb = -48.0 + (squelchValue - 1) * (68.0 / 99.0);
                }
                
                const msg = {
                    type: 'set_squelch',
                    squelchOpen: squelchDb
                };
                wsManager.send(msg);
                
                if (squelchDb === -999.0) {
                    log('Squelch: Open (no squelch)');
                } else {
                    log(`Squelch: Closed at ${squelchDb.toFixed(1)} dB SNR`);
                }
            }
        }
    } else {
        // Other modes: show bandwidth, hide squelch
        bandwidthControls.style.display = 'block';
        squelchControls.style.display = 'none';
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
    		maxHigh = 4000;
    		defaultHigh = 2700;
    		break;
    	case 'lsb':
    		minLow = -4000;
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
            minLow = -8000;
            maxLow = 0;
            defaultLow = -8000;
            maxHigh = 8000;
            defaultHigh = 8000;
            break;
        case 'nfm':
            minLow = -5000;
            maxLow = 0;
            defaultLow = -5000;
            maxHigh = 5000;
            defaultHigh = 5000;
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
    bandwidthHighSlider.min = (currentMode === 'lsb') ? -4000 : 0;
    bandwidthHighSlider.max = maxHigh;

    // Only reset bandwidth to defaults if not preserving (i.e., user clicked mode button)
    if (!preserveBandwidth) {
        bandwidthLowSlider.value = defaultLow;
        currentBandwidthLow = defaultLow;
        document.getElementById('bandwidth-low-value').textContent = defaultLow;

        bandwidthHighSlider.value = defaultHigh;
        currentBandwidthHigh = defaultHigh;
        document.getElementById('bandwidth-high-value').textContent = defaultHigh;

        // Update global references
        window.currentBandwidthLow = defaultLow;
        window.currentBandwidthHigh = defaultHigh;

        // Update bandwidth display
        updateCurrentBandwidthDisplay(defaultLow, defaultHigh);

        // Notify extension system of bandwidth change
        if (window.radioAPI) {
            window.radioAPI.notifyBandwidthChange(defaultLow, defaultHigh);
        }

        log(`Mode changed to ${mode.toUpperCase()} (BW: ${defaultLow} to ${defaultHigh} Hz)`);
    } else {
        // Preserve existing bandwidth values, just update the display
        bandwidthLowSlider.value = currentBandwidthLow;
        document.getElementById('bandwidth-low-value').textContent = currentBandwidthLow;

        bandwidthHighSlider.value = currentBandwidthHigh;
        document.getElementById('bandwidth-high-value').textContent = currentBandwidthHigh;

        // Update global references
        window.currentBandwidthLow = currentBandwidthLow;
        window.currentBandwidthHigh = currentBandwidthHigh;

        // Update bandwidth display
        updateCurrentBandwidthDisplay(currentBandwidthLow, currentBandwidthHigh);

        // Notify extension system of bandwidth change
        if (window.radioAPI) {
            window.radioAPI.notifyBandwidthChange(currentBandwidthLow, currentBandwidthHigh);
        }

        log(`Mode changed to ${mode.toUpperCase()} (BW: ${currentBandwidthLow} to ${currentBandwidthHigh} Hz)`);
    }

    // Update FFT size based on new bandwidth
    if (analyser) {
        const oldFFTSize = analyser.fftSize;
        const newFFTSize = getOptimalFFTSize();

        if (oldFFTSize !== newFFTSize) {
            analyser.fftSize = newFFTSize;
            if (postFilterAnalyser) {
                postFilterAnalyser.fftSize = newFFTSize;
            }
            if (vuAnalyser) {
                vuAnalyser.fftSize = newFFTSize;
            }
            updateFFTSizeDropdown();
            log(`FFT size auto-adjusted to ${newFFTSize} for ${Math.abs(currentBandwidthHigh - currentBandwidthLow)} Hz bandwidth`);
        }
    }

    // Update URL with new mode
    updateURL();

    // Update CAT sync state
    if (typeof updateCATSyncState === 'function') {
        updateCATSyncState();
    }

    // Notify extensions of mode change
    if (window.radioAPI) {
        window.radioAPI.notifyModeChange(mode);
    }

    // Update bandpass slider ranges for new mode (important for LSB)
    if (bandpassEnabled) {
        updateBandpassSliderRanges();
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

    // Update bandwidth tooltips when mode changes
    updateBandwidthTooltips();

    // Update snap checkbox state based on new mode
    if (spectrumDisplay && spectrumDisplay.updateSnapCheckboxState) {
        spectrumDisplay.updateSnapCheckboxState();
    }

    // Auto-connect if not connected
    if (!wsManager.isConnected()) {
        connect();
    } else {
        autoTune();
    }
}

// Throttling for bandwidth slider updates (25ms = 40 updates per second max)
// Optimized for 40 cmd/sec rate limit (using full capacity)
// Store on window to ensure persistence
if (!window.bandwidthSliderState) {
    window.bandwidthSliderState = {
        lastUpdateTime: 0,
        throttleMs: 25
    };
}

// Update bandwidth display (called on input for real-time display with throttled tune)
function updateBandwidthDisplay() {
    const bandwidthLow = parseInt(document.getElementById('bandwidth-low').value);
    const bandwidthHigh = parseInt(document.getElementById('bandwidth-high').value);
    document.getElementById('bandwidth-low-value').textContent = bandwidthLow;
    document.getElementById('bandwidth-high-value').textContent = bandwidthHigh;

    // Update bandwidth display in status
    updateCurrentBandwidthDisplay(bandwidthLow, bandwidthHigh);

    // Throttle tune updates to 40 per second (25ms interval) - same as Z/X keys
    const now = Date.now();
    const timeSinceLastUpdate = now - window.bandwidthSliderState.lastUpdateTime;

    if (timeSinceLastUpdate >= window.bandwidthSliderState.throttleMs) {
        window.bandwidthSliderState.lastUpdateTime = now;

        // Update global references
        currentBandwidthLow = bandwidthLow;
        currentBandwidthHigh = bandwidthHigh;
        window.currentBandwidthLow = bandwidthLow;
        window.currentBandwidthHigh = bandwidthHigh;

        // Notify extension system of bandwidth change
        if (window.radioAPI) {
            window.radioAPI.notifyBandwidthChange(bandwidthLow, bandwidthHigh);
        }

        // Update FFT size based on new bandwidth
        if (analyser) {
            const oldFFTSize = analyser.fftSize;
            const newFFTSize = getOptimalFFTSize();

            if (oldFFTSize !== newFFTSize) {
                analyser.fftSize = newFFTSize;
                if (postFilterAnalyser) {
                    postFilterAnalyser.fftSize = newFFTSize;
                }
                if (vuAnalyser) {
                    vuAnalyser.fftSize = newFFTSize;
                }
                updateFFTSizeDropdown();
            }
        }

        // Update spectrum display bandwidth indicator
        // Skip if chat is syncing to prevent flickering
        if (spectrumDisplay && (!window.chatUI || !window.chatUI.isSyncing)) {
            const freqInput = document.getElementById('frequency');
            const currentFreq = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
            spectrumDisplay.updateConfig({
                tunedFreq: currentFreq,
                bandwidthLow: bandwidthLow,
                bandwidthHigh: bandwidthHigh
            });
        }

        // Update bandpass slider ranges if bandpass is enabled
        if (bandpassEnabled && window.updateBandpassSliderRanges) {
            window.updateBandpassSliderRanges();
        }

        // Update URL with new bandwidth
        if (window.updateURL) {
            window.updateURL();
        }

        // Tune to new bandwidth (this will send the tune command to radiod)
        if (window.autoTune) {
            window.autoTune();
        }
    }
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

    // Update bandwidth display in status
    updateCurrentBandwidthDisplay(bandwidthLow, bandwidthHigh);

    // Notify extension system of bandwidth change
    if (window.radioAPI) {
        window.radioAPI.notifyBandwidthChange(bandwidthLow, bandwidthHigh);
    }

    // Update FFT size based on new bandwidth
    if (analyser) {
        const oldFFTSize = analyser.fftSize;
        const newFFTSize = getOptimalFFTSize();

        if (oldFFTSize !== newFFTSize) {
            analyser.fftSize = newFFTSize;
            if (postFilterAnalyser) {
                postFilterAnalyser.fftSize = newFFTSize;
            }
            if (vuAnalyser) {
                vuAnalyser.fftSize = newFFTSize;
            }
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
    // Skip if chat is syncing to prevent flickering
    if (spectrumDisplay && (!window.chatUI || !window.chatUI.isSyncing)) {
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

// Squelch control functions for FM/NFM modes
let squelchUpdateTimeout = null;

function updateSquelchDisplay() {
    const squelchSlider = document.getElementById('squelch');
    const squelchValue = parseInt(squelchSlider.value);
    const squelchLabel = document.getElementById('squelch-value');
    
    // Map scale value (0-100) to squelch value
    // 0 = "Open" (-999), 1-100 = -48 to +20 dB
    if (squelchValue === 0) {
        squelchLabel.textContent = 'Open';
    } else {
        const squelchDb = -48.0 + (squelchValue - 1) * (68.0 / 99.0);
        squelchLabel.textContent = squelchDb.toFixed(1) + ' dB';
    }
}

function updateSquelch() {
    const squelchSlider = document.getElementById('squelch');
    const squelchValue = parseInt(squelchSlider.value);
    
    // Map scale value (0-100) to squelch value
    let squelchDb;
    if (squelchValue === 0) {
        squelchDb = -999.0;
    } else {
        squelchDb = -48.0 + (squelchValue - 1) * (68.0 / 99.0);
    }
    
    // Send squelch update via WebSocket
    if (wsManager && wsManager.ws && wsManager.ws.readyState === WebSocket.OPEN) {
        const msg = {
            type: 'set_squelch',
            squelchOpen: squelchDb
        };
        wsManager.send(msg);
        
        if (squelchDb === -999.0) {
            log('Squelch: Open (no squelch)');
        } else {
            log(`Squelch: Closed at ${squelchDb.toFixed(1)} dB SNR`);
        }
    }
}

// Make squelch functions globally accessible for inline event handlers
window.updateSquelchDisplay = updateSquelchDisplay;
window.updateSquelch = updateSquelch;

// Update current bandwidth display in status text
function updateCurrentBandwidthDisplay(bandwidthLow, bandwidthHigh) {
    const bandwidthElement = document.getElementById('current-bandwidth');
    if (bandwidthElement) {
        // Calculate total bandwidth (absolute difference)
        const totalBandwidthHz = Math.abs(bandwidthHigh - bandwidthLow);
        // Convert to kHz with 1 decimal place
        const totalBandwidthKHz = (totalBandwidthHz / 1000).toFixed(1);
        bandwidthElement.textContent = `${totalBandwidthKHz} kHz`;
    }
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

    // When muting, reset the audio buffer to provide instant mute response
    if (isMuted && audioContext) {
        const currentTime = audioContext.currentTime;
        nextPlayTime = currentTime;
        window.nextPlayTime = nextPlayTime;
        log('Muted (buffer flushed for instant response)');
    } else {
        log('Unmuted');
    }
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

// Quick toggle for Noise Blanker
function toggleNBQuick() {
    noiseBlankerEnabled = !noiseBlankerEnabled;
    
    // Initialize NB if needed
    if (noiseBlankerEnabled && !nb) {
        initNoiseBlanker();
    }
    
    // Enable/disable the processor
    if (nb) {
        nb.enabled = noiseBlankerEnabled;
    }
    
    // Update button appearance
    const button = document.getElementById('nb-quick-toggle');
    if (button) {
        button.style.backgroundColor = noiseBlankerEnabled ? '#28a745' : '#17a2b8';
    }
    
    // Show notification
    showNotification(
        `Noise Blanker ${noiseBlankerEnabled ? 'enabled' : 'disabled'}`,
        'info',
        2000
    );
    
    log(`Noise Blanker ${noiseBlankerEnabled ? 'enabled' : 'disabled'}`, 'info');
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

// dBFS scale averaging and throttling
let lastDbScaleUpdate = 0;
const dbScaleUpdateInterval = 500; // Update scale every 500ms
let dbScaleHistory = { peak: [], floor: [] };
const dbScaleHistorySize = 10; // Average over 10 samples (5 seconds at 500ms intervals)
let cachedDbScale = { minDb: -80, maxDb: -20 }; // Cached scale values

// Peak/Floor/SNR display (updates twice as fast as scale)
let lastPeakFloorUpdate = 0;
const peakFloorUpdateInterval = 250; // Update peak/floor/SNR every 250ms (twice as fast)
let peakFloorHistory = { peak: [], floor: [] };
const peakFloorHistorySize = 5; // Average over 5 samples (1.25 seconds at 250ms intervals)
let cachedPeakFloor = { minDb: -80, maxDb: -20 }; // Cached peak/floor values for display

// Peak frequency display (updates at same rate as scale labels)
let lastPeakFreqUpdate = 0;
const peakFreqUpdateInterval = 500; // Update peak frequency every 500ms (same as scale)
let cachedPeakFreq = { value: 'N/A', unit: '' }; // Cached peak frequency for display

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
const vuMeterUpdateInterval = 33; // 30 fps (1000ms / 30 = 33ms) - matches oscilloscope


function startVisualization() {
    if (!analyser) return;

    function draw() {
        if (!analyser) return;

        const now = performance.now();

        // Always check for clipping (independent of visualization state)
        checkClipping();

        // Update VU meter every frame (no throttling) to match oscilloscope responsiveness
        updateVUMeter();

        // Only update other visualizations if the section is expanded (performance optimization)
        if (audioVisualizationEnabled) {

            // Update oscilloscope (throttled to 30fps)
            if (oscilloscope) {
                // Always use vuAnalyser for real-time display (matches what you're hearing)
                const activeAnalyser = vuAnalyser || analyser;
                oscilloscope.update(activeAnalyser, audioContext, currentMode, currentBandwidthLow, currentBandwidthHigh);
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

// Toggle audio controls panel (filters section)
function toggleAudioControls() {
    const content = document.getElementById('audio-controls-filters-content');
    const toggle = document.getElementById('audio-controls-toggle');

    if (content.style.display === 'none') {
        // Expand - show filters
        content.style.display = 'block';
        toggle.classList.add('expanded');
        log('Audio filters expanded');
    } else {
        // Collapse - hide filters
        content.style.display = 'none';
        toggle.classList.remove('expanded');
        log('Audio filters collapsed');
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
    const currentDialFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);

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
    setFrequencyInputValue(newDialFreq);
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

        // BUFFER COMPENSATION: Account for audio buffer when taking measurements
        // Schedule measurement to happen after buffered audio has played
        const currentTime = audioContext.currentTime;
        const bufferAhead = nextPlayTime - currentTime;
        const BUFFER_MARGIN = 0.05; // 50ms safety margin

        // If there's significant buffer, delay the measurement
        if (bufferAhead > BUFFER_MARGIN) {
            const delayMs = (bufferAhead + BUFFER_MARGIN) * 1000;

            // Schedule measurement after buffer time + margin
            setTimeout(() => {
                if (!oscilloscope.trackingEnabled || !analyser || !audioContext) {
                    return;
                }

                // Now take the measurement after buffer has played
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

                // Continue with rest of tracking logic (smoothing, adjustment, etc.)
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
                const currentDialFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);

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
                setFrequencyInputValue(newDialFreq);
                updateBandButtons(newDialFreq);
                updateURL();

                // Tune to new frequency
                if (wsManager.isConnected()) {
                    autoTune();
                }
            }, delayMs);

            return; // Exit this interval cycle, measurement scheduled
        }

        // Buffer is small, proceed with immediate measurement
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
        setFrequencyInputValue(newDialFreq);
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

    // Get float frequency data for absolute dBFS values
    let db = -Infinity;
    let peakDbFS = -Infinity;
    let maxBinIndex = startBinIndex;

    if (audioSpectrumLastData.floatDataArray) {
        // Average bins for this pixel (cursor position) - use float data for dBFS
        let sumDb = 0;
        let count = 0;
        for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < audioSpectrumLastData.floatDataArray.length; binIndex++) {
            const dbValue = audioSpectrumLastData.floatDataArray[binIndex];
            if (isFinite(dbValue)) {
                sumDb += dbValue;
                count++;
            }
        }
        db = count > 0 ? sumDb / count : -Infinity;

        // Find peak signal across entire spectrum using float data
        for (let binIndex = startBinIndex; binIndex < startBinIndex + binsForBandwidth && binIndex < audioSpectrumLastData.floatDataArray.length; binIndex++) {
            const dbValue = audioSpectrumLastData.floatDataArray[binIndex];
            if (isFinite(dbValue) && dbValue > peakDbFS) {
                peakDbFS = dbValue;
                maxBinIndex = binIndex;
            }
        }
    }

    // Calculate peak frequency using the same mapping as cursor
    // Convert bin index to pixel position, then to frequency for consistency
    const peakPixel = ((maxBinIndex - startBinIndex) / binsForBandwidth) * width;
    const peakFreq = Math.round(pixelToFrequency(peakPixel, width));

    const peakDb = peakDbFS;

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
    // Always use vuAnalyser for real-time display (matches what you're hearing)
    const activeAnalyser = vuAnalyser || analyser;
    if (!activeAnalyser || !spectrumCtx) return;

    const dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteFrequencyData(dataArray);

    // Also get float frequency data for absolute dBFS measurements
    const floatDataArray = new Float32Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getFloatFrequencyData(floatDataArray);

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

    // Use absolute dBFS scale from float frequency data with averaging and throttling
    const scaleNow = performance.now();

    // Update peak/floor/SNR values twice as fast (250ms)
    if (scaleNow - lastPeakFloorUpdate >= peakFloorUpdateInterval) {
        // Find the actual dBFS range in the visible bandwidth
        let currentMinDb = 0;
        let currentMaxDb = -Infinity;
        const scaleBinMapping = getFrequencyBinMapping();
        if (scaleBinMapping && floatDataArray) {
            const { startBinIndex, binsForBandwidth } = scaleBinMapping;
            for (let i = startBinIndex; i < startBinIndex + binsForBandwidth && i < floatDataArray.length; i++) {
                const dbValue = floatDataArray[i];
                if (isFinite(dbValue)) {
                    currentMaxDb = Math.max(currentMaxDb, dbValue);
                    if (currentMinDb === 0 || dbValue < currentMinDb) {
                        currentMinDb = dbValue;
                    }
                }
            }
        }

        // Add to peak/floor history for faster updates
        if (isFinite(currentMaxDb) && currentMaxDb !== -Infinity) {
            peakFloorHistory.peak.push(currentMaxDb);
            if (peakFloorHistory.peak.length > peakFloorHistorySize) {
                peakFloorHistory.peak.shift();
            }
        }
        if (isFinite(currentMinDb) && currentMinDb !== 0) {
            peakFloorHistory.floor.push(currentMinDb);
            if (peakFloorHistory.floor.length > peakFloorHistorySize) {
                peakFloorHistory.floor.shift();
            }
        }

        // Calculate averaged values for peak/floor display
        if (peakFloorHistory.peak.length > 0) {
            const avgPeak = peakFloorHistory.peak.reduce((sum, v) => sum + v, 0) / peakFloorHistory.peak.length;
            cachedPeakFloor.maxDb = avgPeak;
        }
        if (peakFloorHistory.floor.length > 0) {
            const avgFloor = peakFloorHistory.floor.reduce((sum, v) => sum + v, 0) / peakFloorHistory.floor.length;
            cachedPeakFloor.minDb = avgFloor;
        }

        lastPeakFloorUpdate = scaleNow;
    }

    // Update scale labels at slower rate (500ms)
    if (scaleNow - lastDbScaleUpdate >= dbScaleUpdateInterval) {
        // Add to scale history for slower updates
        if (peakFloorHistory.peak.length > 0) {
            const avgPeak = peakFloorHistory.peak.reduce((sum, v) => sum + v, 0) / peakFloorHistory.peak.length;
            dbScaleHistory.peak.push(avgPeak);
            if (dbScaleHistory.peak.length > dbScaleHistorySize) {
                dbScaleHistory.peak.shift();
            }
        }
        if (peakFloorHistory.floor.length > 0) {
            const avgFloor = peakFloorHistory.floor.reduce((sum, v) => sum + v, 0) / peakFloorHistory.floor.length;
            dbScaleHistory.floor.push(avgFloor);
            if (dbScaleHistory.floor.length > dbScaleHistorySize) {
                dbScaleHistory.floor.shift();
            }
        }

        // Calculate averaged values for scale labels
        if (dbScaleHistory.peak.length > 0) {
            const avgPeak = dbScaleHistory.peak.reduce((sum, v) => sum + v, 0) / dbScaleHistory.peak.length;
            cachedDbScale.maxDb = avgPeak;
        }
        if (dbScaleHistory.floor.length > 0) {
            const avgFloor = dbScaleHistory.floor.reduce((sum, v) => sum + v, 0) / dbScaleHistory.floor.length;
            cachedDbScale.minDb = avgFloor;
        }

        lastDbScaleUpdate = scaleNow;

        // Also update peak frequency at the same 500ms rate
        if (analyser && audioContext && oscilloscope) {
            const bufferLength = analyser.fftSize;
            const timeDataArray = new Uint8Array(bufferLength);
            analyser.getByteTimeDomainData(timeDataArray);
            const detectedFreq = oscilloscope.detectFrequencyFromWaveform(timeDataArray, audioContext.sampleRate);

            if (detectedFreq > 0 && detectedFreq >= 20 && detectedFreq <= 20000) {
                if (detectedFreq >= 1000) {
                    cachedPeakFreq.value = (detectedFreq / 1000).toFixed(2);
                    cachedPeakFreq.unit = ' kHz';
                } else {
                    cachedPeakFreq.value = Math.round(detectedFreq).toString();
                    cachedPeakFreq.unit = ' Hz';
                }
            } else {
                cachedPeakFreq.value = 'N/A';
                cachedPeakFreq.unit = '';
            }
        }
    }

    // Use cached/averaged scale values
    const displayMinDb = cachedDbScale.minDb;
    const displayMaxDb = cachedDbScale.maxDb;

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

    // Initialize peak hold array if needed (store dBFS values, not magnitudes)
    if (!spectrumPeaks || spectrumPeaks.length !== numPoints) {
        spectrumPeaks = new Array(numPoints).fill(-Infinity);
    }

    const peakDecayRate = 2.0; // dB per frame to decay (faster fall time)

    // Draw filled area
    spectrumCtx.fillStyle = gradient;
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, height); // Start at bottom left

    // Store dBFS values for peak hold (scale-independent)
    const dbfsValues = new Array(numPoints);

    // Also store normalized magnitudes for peak comparison
    const normalizedMagnitudes = new Array(numPoints);

    for (let i = 0; i < numPoints; i++) {
        // Average the bins for this point
        const startBin = startBinIndex + (i * binsPerPoint);
        const endBin = startBin + binsPerPoint;

        let sum = 0;
        let count = 0;
        let sumDbfs = 0;
        let countDbfs = 0;

        for (let binIndex = Math.floor(startBin); binIndex < Math.ceil(endBin) && binIndex < dataArray.length; binIndex++) {
            sum += dataArray[binIndex] || 0;
            count++;

            // Also average dBFS values for peak hold
            if (floatDataArray && binIndex < floatDataArray.length) {
                const dbValue = floatDataArray[binIndex];
                if (isFinite(dbValue)) {
                    sumDbfs += dbValue;
                    countDbfs++;
                }
            }
        }

        const average = count > 0 ? sum / count : 0;
        dbfsValues[i] = countDbfs > 0 ? sumDbfs / countDbfs : -Infinity; // Store dBFS for peak hold

        // Normalize magnitude for autoranging
        let normalizedMagnitude;
        if (magnitudeRange > 0) {
            normalizedMagnitude = (average - minMagnitude) / magnitudeRange;
        } else {
            normalizedMagnitude = average / 255;
        }

        // Store normalized magnitude for peak tracking
        normalizedMagnitudes[i] = normalizedMagnitude;

        // Calculate y position (inverted - higher magnitude at top)
        const y = height - (normalizedMagnitude * height);

        spectrumCtx.lineTo(i, y);
    }

    // Close the path at bottom right
    spectrumCtx.lineTo(width, height);
    spectrumCtx.closePath();
    spectrumCtx.fill();

    // Update peak hold line using normalized magnitudes (same scale as display)
    for (let i = 0; i < numPoints; i++) {
        const currentNormalized = normalizedMagnitudes[i];

        // Update peak hold with normalized values (0-1 range)
        if (!isFinite(spectrumPeaks[i]) || currentNormalized > spectrumPeaks[i]) {
            spectrumPeaks[i] = currentNormalized; // New peak
        } else {
            // Decay the peak (fixed rate in normalized 0-1 space)
            // At 30fps, decay 0.01 per frame = 0.3 per second = full range in ~3 seconds
            const decayAmount = 0.01;
            spectrumPeaks[i] = Math.max(0, spectrumPeaks[i] - decayAmount);
        }
    }

    // Draw peak hold line (light yellow, semi-transparent like main graph)
    spectrumCtx.strokeStyle = 'rgba(255, 255, 200, 0.5)';
    spectrumCtx.lineWidth = 1;

    // Draw peaks as separate segments, breaking when gap between adjacent peaks is too large
    let inSegment = false;
    let lastPeakY = -1;
    const MAX_PEAK_GAP = height * 0.15; // Break line if vertical gap > 15% of height

    for (let i = 0; i < numPoints; i++) {
        // Use normalized peak values (same coordinate system as current signal)
        if (isFinite(spectrumPeaks[i]) && spectrumPeaks[i] > 0.05) { // Only draw peaks above 5% of range
            const peakY = height - (spectrumPeaks[i] * height);

            if (peakY < height && peakY >= 0) {
                // Check if we should break the line due to large gap
                if (inSegment && lastPeakY >= 0 && Math.abs(peakY - lastPeakY) > MAX_PEAK_GAP) {
                    // Gap too large - end current segment and start new one
                    spectrumCtx.stroke();
                    spectrumCtx.beginPath();
                    spectrumCtx.moveTo(i, peakY);
                } else if (!inSegment) {
                    // Start a new segment
                    spectrumCtx.beginPath();
                    spectrumCtx.moveTo(i, peakY);
                    inSegment = true;
                } else {
                    spectrumCtx.lineTo(i, peakY);
                }
                lastPeakY = peakY;
            }
        } else {
            // Peak too low or invalid - end current segment if any
            if (inSegment) {
                spectrumCtx.stroke();
                inSegment = false;
                lastPeakY = -1;
            }
        }
    }

    // Stroke final segment if still drawing
    if (inSegment) {
        spectrumCtx.stroke();
    }

    // Draw bandpass filter indicators if enabled
    if (bandpassEnabled && bandpassFilters.length > 0) {
        // Use slider value for display (positive in LSB mode)
        const sliderCenter = parseInt(document.getElementById('bandpass-center').value);
        const filterBandwidth = parseInt(document.getElementById('bandpass-width').value);

        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;

        // For LSB mode, invert the frequency mapping to match the corrected display
        // LSB: slider 800 Hz should map to display position for 800 Hz (left side)
        let displayCenter, lowFreq, highFreq;
        if (currentMode === 'lsb') {
            // Map positive slider value to inverted display coordinates
            // For LSB: displayLow=-2700, displayHigh=-50
            // slider 800 -> display at position where freq label shows 800
            displayCenter = Math.abs(displayLow) + Math.abs(displayHigh) - sliderCenter;
            // Make it negative for LSB coordinate system
            displayCenter = -displayCenter;
            lowFreq = displayCenter - filterBandwidth / 2;
            highFreq = displayCenter + filterBandwidth / 2;
        } else {
            displayCenter = sliderCenter;
            lowFreq = displayCenter - filterBandwidth / 2;
            highFreq = displayCenter + filterBandwidth / 2;
        }

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
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;

            // notch.center is stored as the actual frequency value from the click
            // For LSB mode, we need to apply the same inversion as frequency labels
            let displayCenter, lowFreq, highFreq;
            if (currentMode === 'lsb') {
                // notch.center is negative in LSB (e.g., -800)
                // Map it to the inverted display position
                displayCenter = Math.abs(displayLow) + Math.abs(displayHigh) - Math.abs(notch.center);
                // Make it negative for LSB coordinate system
                displayCenter = -displayCenter;
                const filterBandwidth = notch.width;
                lowFreq = displayCenter - filterBandwidth / 2;
                highFreq = displayCenter + filterBandwidth / 2;
            } else {
                displayCenter = notch.center;
                const filterBandwidth = notch.width;
                lowFreq = displayCenter - filterBandwidth / 2;
                highFreq = displayCenter + filterBandwidth / 2;
            }

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


    // Draw debug info at top right (peak signal, noise floor, SNR, and peak frequency)
    // Use fixed-width layout: labels left-aligned, units right-aligned, values in between
    spectrumCtx.font = 'bold 11px monospace';
    spectrumCtx.textBaseline = 'top';

    // Use faster-updating peak/floor values (updated every 250ms, twice as fast as scale)
    const peakDb = isFinite(cachedPeakFloor.maxDb) ? cachedPeakFloor.maxDb.toFixed(1) : '-∞';
    const noiseDb = isFinite(cachedPeakFloor.minDb) ? cachedPeakFloor.minDb.toFixed(1) : '-∞';

    // Calculate SNR (Signal-to-Noise Ratio) in dB
    let snrValue = 'N/A';
    if (isFinite(cachedPeakFloor.maxDb) && isFinite(cachedPeakFloor.minDb)) {
        const snrDb = cachedPeakFloor.maxDb - cachedPeakFloor.minDb;
        snrValue = snrDb.toFixed(1);
    }

    // Use cached peak frequency (updated every 500ms, same as scale labels)
    const peakFreqValue = cachedPeakFreq.value;
    const peakFreqUnit = cachedPeakFreq.unit;

    // Fixed width box (120px wide to accommodate all text)
    const debugWidth = 120;
    const debugX = width - debugWidth - 4;
    spectrumCtx.fillStyle = 'rgba(44, 62, 80, 0.9)';
    spectrumCtx.fillRect(debugX, 2, debugWidth, 64);

    // Draw text with outline for visibility
    spectrumCtx.strokeStyle = '#000000';
    spectrumCtx.lineWidth = 3;
    spectrumCtx.fillStyle = '#ffffff';

    // Helper function to draw a line with label left-aligned and unit right-aligned
    const drawDebugLine = (label, value, unit, y) => {
        // Left-align label
        spectrumCtx.textAlign = 'left';
        spectrumCtx.strokeText(label, debugX + 4, y);
        spectrumCtx.fillText(label, debugX + 4, y);

        // Right-align unit
        spectrumCtx.textAlign = 'right';
        const unitText = value + unit;
        spectrumCtx.strokeText(unitText, debugX + debugWidth - 4, y);
        spectrumCtx.fillText(unitText, debugX + debugWidth - 4, y);
    };

    drawDebugLine('Peak:', peakDb, ' dB', 4);
    drawDebugLine('Floor:', noiseDb, ' dB', 16);
    drawDebugLine('SNR:', snrValue, ' dB', 28);
    // One line gap (12px), then peak frequency at 52px
    drawDebugLine('Peak:', peakFreqValue, peakFreqUnit, 52);

    // Store spectrum data for tooltip usage
    audioSpectrumLastData = {
        dataArray: new Uint8Array(dataArray),
        floatDataArray: new Float32Array(floatDataArray),
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
        // For LSB mode, invert the frequency display (0 Hz on left, max on right)
        // LSB: -2700 to -50 displays as 50 to 2700 (NOT reversed - lower frequencies on left)
        // For other modes, show the actual audio frequency (freq already includes CW offset)
        let displayFreq;
        if (currentMode === 'lsb') {
            // Map negative frequencies to positive display values in correct order
            // For LSB: freq goes from -2700 (left) to -50 (right)
            // We want to display: 50 (left) to 2700 (right)
            displayFreq = Math.abs(displayLow) + Math.abs(displayHigh) - Math.abs(freq);
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
    // Always use vuAnalyser for real-time display (matches what you're hearing)
    const activeAnalyser = vuAnalyser || analyser;
    if (!activeAnalyser || !waterfallCtx || !waterfallImageData) return;

    const dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteFrequencyData(dataArray);

    // Also get float frequency data for absolute dBFS measurements (for tooltip)
    const floatDataArray = new Float32Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getFloatFrequencyData(floatDataArray);

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
        floatDataArray: floatDataArray ? new Float32Array(floatDataArray) : null,
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

        // For LSB mode, invert the frequency display (0 Hz on left, max on right)
        // LSB: -2700 to -50 displays as 50 to 2700 (NOT reversed - lower frequencies on left)
        // For other modes, show the actual audio frequency (freq already includes CW offset)
        let displayFreq;
        if (currentMode === 'lsb') {
            // Map negative frequencies to positive display values in correct order
            // For LSB: freq goes from -2700 (left) to -50 (right)
            // We want to display: 50 (left) to 2700 (right)
            displayFreq = Math.abs(displayLow) + Math.abs(displayHigh) - Math.abs(freq);
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

        // Get display range (accounts for CW offset)
        const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + currentBandwidthLow;
        const displayHigh = cwOffset + currentBandwidthHigh;

        // For LSB mode, invert the frequency mapping to match the corrected display
        let displayCenter, lowFreq, highFreq;
        if (currentMode === 'lsb') {
            // Map positive slider value to inverted display coordinates
            displayCenter = Math.abs(displayLow) + Math.abs(displayHigh) - sliderCenter;
            // Make it negative for LSB coordinate system
            displayCenter = -displayCenter;
            lowFreq = displayCenter - filterBandwidth / 2;
            highFreq = displayCenter + filterBandwidth / 2;
        } else {
            displayCenter = sliderCenter;
            lowFreq = displayCenter - filterBandwidth / 2;
            highFreq = displayCenter + filterBandwidth / 2;
        }

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
            // Get display range (accounts for CW offset)
            const cwOffset = (Math.abs(currentBandwidthLow) < 500 && Math.abs(currentBandwidthHigh) < 500) ? 500 : 0;
            const displayLow = cwOffset + currentBandwidthLow;
            const displayHigh = cwOffset + currentBandwidthHigh;

            // Apply same inversion as frequency labels for LSB mode
            let displayCenter, lowFreq, highFreq;
            if (currentMode === 'lsb') {
                // notch.center is negative in LSB (e.g., -800)
                displayCenter = Math.abs(displayLow) + Math.abs(displayHigh) - Math.abs(notch.center);
                // Make it negative for LSB coordinate system
                displayCenter = -displayCenter;
                const filterBandwidth = notch.width;
                lowFreq = displayCenter - filterBandwidth / 2;
                highFreq = displayCenter + filterBandwidth / 2;
            } else {
                displayCenter = notch.center;
                const filterBandwidth = notch.width;
                lowFreq = displayCenter - filterBandwidth / 2;
                highFreq = displayCenter + filterBandwidth / 2;
            }

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
    // 2048  -> 11.72 Hz/bin (very coarse) - Fastest
    // 4096  -> 5.86 Hz/bin (coarse) - Fast
    // 8192  -> 2.93 Hz/bin (medium) - Balanced
    // 16384 -> 1.46 Hz/bin (fine) - High Detail
    // 32768 -> 0.73 Hz/bin (very fine) - Very High Detail
    // 65536 -> 0.37 Hz/bin (ultra fine) - Ultra High Detail

    if (bandwidth < 300) {
        return 32768;  // Very narrow CW: Very High Detail (0.73 Hz/bin)
    } else if (bandwidth < 600) {
        return 16384;  // CW modes: High Detail (1.46 Hz/bin)
    } else if (bandwidth < 1500) {
        return 2048;   // Narrow modes (USB/LSB): Fastest (11.72 Hz/bin) - Optimized for instant VU response
    } else if (bandwidth < 4000) {
        return 2048;   // Medium modes: Fastest (11.72 Hz/bin) - Optimized for instant VU response
    } else {
        return 4096;   // Wide modes (AM/FM): Fast (5.86 Hz/bin)
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

    // Update post-filter analyser to match
    if (postFilterAnalyser) {
        postFilterAnalyser.fftSize = newFFTSize;
    }

    // Update VU analyser to match (used for all visualizations)
    if (vuAnalyser) {
        vuAnalyser.fftSize = newFFTSize;
    }

    // Clear waterfall canvas to avoid misaligned old data
    if (waterfallCtx) {
        waterfallCtx.fillStyle = '#000';
        waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
        waterfallStartTime = Date.now();
        waterfallLineCount = 0;
    }

    // Reset spectrum peaks array to force recreation with correct dimensions
    spectrumPeaks = null;

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

// Waterfall auto-adjust state (always enabled)
let waterfallAutoAdjustEnabled = true;
let waterfallAutoAdjustInterval = null;
let waterfallNoiseFloorHistory = [];
let waterfallPeakHistory = [];
const WATERFALL_AUTO_ADJUST_HISTORY_SIZE = 10; // Average over 10 samples
const WATERFALL_AUTO_ADJUST_UPDATE_RATE = 500; // Update every 500ms


// Update waterfall auto-adjust values (always enabled)
function updateWaterfallAutoAdjust() {
    if (!analyser || !audioContext) return;

    // Get frequency data
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Get frequency bin mapping
    const binMapping = getFrequencyBinMapping();
    if (!binMapping) return;

    const { startBinIndex, binsForBandwidth } = binMapping;

    // Collect all magnitude values for percentile calculation
    const magnitudes = [];
    for (let i = startBinIndex; i < startBinIndex + binsForBandwidth && i < dataArray.length; i++) {
        const magnitude = dataArray[i];
        if (magnitude > 0) { // Ignore zero values
            magnitudes.push(magnitude);
        }
    }

    // Need valid data to proceed
    if (magnitudes.length === 0) return;

    // Sort for percentile calculation
    magnitudes.sort((a, b) => a - b);

    // Use percentiles to handle outliers
    // 10th percentile for noise floor (ignores very weak noise spikes)
    // 99th percentile for peak level (captures nearly all signals including strong ones)
    const noiseFloorIndex = Math.floor(magnitudes.length * 0.10);
    const peakIndex = Math.floor(magnitudes.length * 0.99);

    const noiseFloor = magnitudes[noiseFloorIndex];
    const peak = magnitudes[peakIndex];

    // Add to history for temporal smoothing
    waterfallNoiseFloorHistory.push(noiseFloor);
    waterfallPeakHistory.push(peak);

    if (waterfallNoiseFloorHistory.length > WATERFALL_AUTO_ADJUST_HISTORY_SIZE) {
        waterfallNoiseFloorHistory.shift();
    }
    if (waterfallPeakHistory.length > WATERFALL_AUTO_ADJUST_HISTORY_SIZE) {
        waterfallPeakHistory.shift();
    }

    // Need enough history before adjusting
    if (waterfallNoiseFloorHistory.length < WATERFALL_AUTO_ADJUST_HISTORY_SIZE) {
        return;
    }

    // Calculate smoothed values
    const avgNoiseFloor = waterfallNoiseFloorHistory.reduce((sum, v) => sum + v, 0) / waterfallNoiseFloorHistory.length;
    const avgPeak = waterfallPeakHistory.reduce((sum, v) => sum + v, 0) / waterfallPeakHistory.length;

    // Calculate dynamic range (95th percentile captures strong signals)
    const dynamicRange = avgPeak - avgNoiseFloor;

    // Calculate optimal contrast (noise floor suppression)
    // Set contrast very close to noise floor to preserve all signals
    // Only suppress the actual noise floor, not weak signals
    const optimalContrast = Math.round(avgNoiseFloor + (dynamicRange * 0.05));
    const clampedContrast = Math.max(0, Math.min(100, optimalContrast));

    // Calculate optimal intensity
    // Boost intensity based on how much dynamic range we have
    // More dynamic range = less boost needed
    // Less dynamic range = more boost needed
    let optimalIntensity;
    if (dynamicRange < 50) {
        // Low dynamic range - boost significantly
        optimalIntensity = 0.5;
    } else if (dynamicRange < 100) {
        // Medium dynamic range - moderate boost
        optimalIntensity = 0.3;
    } else if (dynamicRange < 150) {
        // Good dynamic range - slight boost
        optimalIntensity = 0.1;
    } else {
        // Excellent dynamic range - no boost needed
        optimalIntensity = 0.0;
    }

    // Apply optimal values directly (no UI controls)
    waterfallIntensity = optimalIntensity;
    waterfallContrast = clampedContrast;
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

// Initialize noise blanker processor
function initNoiseBlanker() {
    if (!audioContext) {
        log('Audio context not initialized', 'error');
        return false;
    }

    if (noiseBlankerProcessor) {
        log('Noise blanker already initialized');
        return true;
    }

    // Check if NoiseBlanker class is available
    if (typeof NoiseBlanker === 'undefined') {
        log('Noise Blanker library not loaded', 'error');
        log('Please ensure noise-blanker.js is loaded', 'error');
        return false;
    }

    try {
        // Get sample rate from audio context
        const sampleRate = audioContext.sampleRate;
        
        // Create Noise Blanker instance
        nb = new NoiseBlanker(audioContext, sampleRate);
        nb.enabled = noiseBlankerEnabled;

        // Create script processor: mono input, mono output (1 in, 1 out)
        // Small buffer for minimal latency (<5ms)
        const bufferSize = 512;
        noiseBlankerProcessor = audioContext.createScriptProcessor(bufferSize, 2, 2);
    
        noiseBlankerProcessor.onaudioprocess = (e) => {
            const inputL = e.inputBuffer.getChannelData(0);
            const inputR = e.inputBuffer.getChannelData(1);
            const outputL = e.outputBuffer.getChannelData(0);
            const outputR = e.outputBuffer.getChannelData(1);
    
            if (!noiseBlankerEnabled || !nb) {
                // Bypass: copy input to output
                outputL.set(inputL);
                outputR.set(inputR);
                return;
            }
    
            // Process both channels independently through Noise Blanker
            nb.process(inputL, outputL);
            nb.process(inputR, outputR);
        };

        log('✅ Noise Blanker initialized (impulse noise suppression, <5ms latency)');
        return true;
    } catch (e) {
        console.error('Failed to initialize noise blanker:', e);
        log('Failed to initialize noise blanker: ' + e.message, 'error');
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

    // Update latency displays
    if (window.updateAllLatencyDisplays) {
        window.updateAllLatencyDisplays();
    }

    // Save settings to localStorage
    if (window.saveFilterSettings) {
        window.saveFilterSettings();
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
            // Force parameter update to ensure processor activates immediately
            // This fixes browser-specific initialization race conditions
            nr2.setParameters(noiseReductionStrength, noiseReductionFloor, 1.0);
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

    // Update latency displays
    if (window.updateAllLatencyDisplays) {
        window.updateAllLatencyDisplays();
    }

    // Save settings to localStorage
    if (window.saveFilterSettings) {
        window.saveFilterSettings();
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
const ZOOM_THROTTLE_MS = 25;

// Bookmark functions moved to bookmark-manager.js
// They are imported at the top of this file and exposed on window by that module

// Initialize spectrum display on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load spectrum sync setting FIRST before creating spectrum display
    loadSpectrumSyncSetting();
    
    // Load chat markers setting
    loadChatMarkersSetting();

    // Load amateur radio bands
        loadBands();

        // Load bookmarks
        loadBookmarks();

        // Populate band selector dropdown after bands are loaded
        setTimeout(() => {
            populateBandSelector();
            populateBookmarkSelector();
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
                // Only log config changes that are significant (not from periodic sync)
                // Check if this is a user-initiated change
                if (!window.lastLoggedSpectrumConfig ||
                    window.lastLoggedSpectrumConfig.centerFreq !== config.centerFreq ||
                    window.lastLoggedSpectrumConfig.binBandwidth !== config.binBandwidth ||
                    window.lastLoggedSpectrumConfig.binCount !== config.binCount) {
                    log(`Spectrum: ${config.binCount} bins @ ${config.binBandwidth} Hz, ${formatFrequency(config.centerFreq)}`);

                    // Notify zoom change if binBandwidth changed
                    if (window.radioAPI && window.lastLoggedSpectrumConfig &&
                        window.lastLoggedSpectrumConfig.binBandwidth !== config.binBandwidth) {
                        window.radioAPI.notifyZoomChange(config.binBandwidth);
                    }

                    window.lastLoggedSpectrumConfig = {
                        centerFreq: config.centerFreq,
                        binBandwidth: config.binBandwidth,
                        binCount: config.binCount
                    };
                }
                // Update cursor with current frequency input value
                updateSpectrumCursor();
                // Update zoom display with new zoom level from config
                updateSpectrumZoomDisplay();
                // Update URL with new zoom parameters
                updateURL();
            },
            onFrequencyClick: (freq) => {
                // When user clicks on spectrum, tune to that frequency
                const freqInput = document.getElementById('frequency');
                if (freqInput && document.activeElement !== freqInput) {
                    setFrequencyInputValue(Math.round(freq));
                }

                // Update cursor immediately
                updateSpectrumCursor();

                // Update band selector
                updateBandSelector();

                // Update URL with new frequency
                updateURL();

                // Notify extensions of frequency change
                if (window.radioAPI) {
                    window.radioAPI.notifyFrequencyChange(Math.round(freq));
                }

                // Check if fully zoomed out (zoom level = 1.0)
                if (spectrumDisplay && spectrumDisplay.zoomLevel <= 1.0) {
                    // Fully zoomed out - perform max zoom at clicked frequency
                    if (spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
                        spectrumDisplay.ws.send(JSON.stringify({
                            type: 'zoom',
                            frequency: Math.round(freq),
                            binBandwidth: 400.0
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

        // Enable auto-adjust automatically (always on)
        spectrumAutoAdjustEnabled = true;
        if (!spectrumAutoAdjustInterval) {
            spectrumAutoAdjustInterval = setInterval(updateSpectrumAutoAdjust, 500);
        }
        log('RF Spectrum auto-adjust enabled');

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
            // Add input event listener for real-time validation
            // Use the window version which will be overridden later to support decimals
            freqInput.addEventListener('input', (e) => {
                if (window.validateFrequencyInput) {
                    window.validateFrequencyInput(e.target);
                } else {
                    validateFrequencyInput(e.target);
                }
            });

            // Add Enter key handler to apply frequency
            freqInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (window.handleFrequencyChange) {
                        window.handleFrequencyChange();
                    } else {
                        handleFrequencyChange();
                    }
                }
            });

            // Add blur handler to apply frequency when focus is lost
            freqInput.addEventListener('blur', () => {
                if (window.handleFrequencyChange) {
                    window.handleFrequencyChange();
                } else {
                    handleFrequencyChange();
                }
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
        // Get frequency from data-hz-value attribute
        const freq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
        if (!isNaN(freq)) {
            // CRITICAL: Use window globals, not local variables
            // Local variables may be stale if mode/bandwidth changed via chat sync
            spectrumDisplay.updateConfig({
                tunedFreq: freq,
                bandwidthLow: window.currentBandwidthLow,
                bandwidthHigh: window.currentBandwidthHigh
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

// RF Spectrum auto-adjust state
let spectrumAutoAdjustEnabled = false;
let spectrumAutoAdjustInterval = null;
const spectrumNoiseFloorHistory = [];
const spectrumPeakHistory = [];
const SPECTRUM_HISTORY_SIZE = 80; // 80 samples × 500ms = 40 second window


// Update RF spectrum auto-adjust values
function updateSpectrumAutoAdjust() {
    if (!spectrumDisplay || !spectrumDisplay.spectrumData || !spectrumDisplay.totalBandwidth) {
        return;
    }

    const spectrumData = spectrumDisplay.spectrumData;
    const centerFreq = spectrumDisplay.centerFreq;
    const totalBandwidth = spectrumDisplay.totalBandwidth;

    // Calculate frequency range
    const startFreq = centerFreq - totalBandwidth / 2;
    const endFreq = centerFreq + totalBandwidth / 2;

    // Get all dB values in visible range
    const visibleValues = [];
    for (let i = 0; i < spectrumData.length; i++) {
        const freq = startFreq + (i / spectrumData.length) * totalBandwidth;
        if (freq >= startFreq && freq <= endFreq) {
            const db = spectrumData[i];
            if (isFinite(db)) {
                visibleValues.push(db);
            }
        }
    }

    if (visibleValues.length === 0) {
        return;
    }

    // Sort values for percentile calculation
    visibleValues.sort((a, b) => a - b);

    // Calculate noise floor (5th percentile - lower to better identify true noise floor)
    const noiseFloorIndex = Math.floor(visibleValues.length * 0.05);
    const currentNoiseFloor = visibleValues[noiseFloorIndex];

    // Calculate peak signal (98th percentile - higher to focus on actual strong signals)
    const peakIndex = Math.floor(visibleValues.length * 0.98);
    const currentPeak = visibleValues[peakIndex];

    // Add to history for temporal smoothing
    spectrumNoiseFloorHistory.push(currentNoiseFloor);
    spectrumPeakHistory.push(currentPeak);

    // Keep only last N samples
    if (spectrumNoiseFloorHistory.length > SPECTRUM_HISTORY_SIZE) {
        spectrumNoiseFloorHistory.shift();
    }
    if (spectrumPeakHistory.length > SPECTRUM_HISTORY_SIZE) {
        spectrumPeakHistory.shift();
    }

    // Need enough history before adjusting (prevents immediate changes when signals appear/disappear)
    if (spectrumNoiseFloorHistory.length < SPECTRUM_HISTORY_SIZE) {
        return;
    }

    // Calculate smoothed values (average of history)
    const avgNoiseFloor = spectrumNoiseFloorHistory.reduce((sum, val) => sum + val, 0) / spectrumNoiseFloorHistory.length;
    const avgPeak = spectrumPeakHistory.reduce((sum, val) => sum + val, 0) / spectrumPeakHistory.length;

    // Calculate dynamic range
    const dynamicRange = avgPeak - avgNoiseFloor;

    // Contrast: Suppress noise floor more aggressively
    // Map noise floor to contrast range, with higher values for better suppression
    const minDb = -120;
    const maxDb = 0;
    const normalizedNoiseFloor = (avgNoiseFloor - minDb) / (maxDb - minDb);
    // Increase contrast to better suppress noise floor (add 20-30 instead of 10)
    const targetContrast = Math.max(0, Math.min(100, normalizedNoiseFloor * 100 + 25));

    // Intensity: Reduce brightness to prevent signals from being too hot
    // Negative values darken the display
    let targetIntensity;
    if (dynamicRange > 40) {
        targetIntensity = -0.3;  // Strong signals, darken significantly
    } else if (dynamicRange > 20) {
        targetIntensity = -0.1;  // Moderate signals, darken slightly
    } else {
        targetIntensity = 0.1;   // Weak signals, slight boost
    }

    // Apply intensity and contrast directly
    if (spectrumDisplay) {
        spectrumDisplay.updateConfig({
            intensity: targetIntensity,
            contrast: targetContrast
        });
    }
}


// Spectrum zoom control functions
function spectrumZoomIn() {
    console.log('[app.js] spectrumZoomIn() called, spectrumDisplay exists:', !!spectrumDisplay, 'radioAPI exists:', !!window.radioAPI);
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    spectrumDisplay.zoomIn();
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL

    // Notify radioAPI immediately (don't wait for config update)
    if (window.radioAPI && spectrumDisplay.binBandwidth) {
        // Estimate new binBandwidth (will be corrected when config arrives)
        const estimatedBinBandwidth = spectrumDisplay.binBandwidth / 2;
        window.radioAPI.notifyZoomChange(estimatedBinBandwidth);
    }
}

function spectrumZoomOut() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    spectrumDisplay.zoomOut();
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL

    // Notify radioAPI immediately (don't wait for config update)
    if (window.radioAPI && spectrumDisplay.binBandwidth) {
        // Estimate new binBandwidth (will be corrected when config arrives)
        const estimatedBinBandwidth = spectrumDisplay.binBandwidth * 2;
        window.radioAPI.notifyZoomChange(estimatedBinBandwidth);
    }
}

function spectrumResetZoom() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    spectrumDisplay.resetZoom();
    // Zoom display will be updated when config arrives from server
    updateURL(); // Save zoom to URL (will remove zoom params when at 1x)

    // Notify radioAPI immediately with default binBandwidth
    if (window.radioAPI) {
        // Default binBandwidth when fully zoomed out (will be corrected when config arrives)
        window.radioAPI.notifyZoomChange(14648.4375); // 30MHz / 2048 bins
    }
}

function spectrumMaxZoom() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    // Get current frequency from input
    const freqInput = document.getElementById('frequency');
    const frequency = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);

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

    // Notify radioAPI immediately with max zoom binBandwidth
    if (window.radioAPI) {
        window.radioAPI.notifyZoomChange(1.0);
    }
}

function spectrumCenterFrequency() {
    if (!spectrumDisplay) return;

    const now = Date.now();
    if (now - lastZoomTime < ZOOM_THROTTLE_MS) return;
    lastZoomTime = now;

    // Get current frequency from input
    const freqInput = document.getElementById('frequency');
    const frequency = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);

    if (isNaN(frequency)) {
        log('Invalid frequency for centering', 'error');
        return;
    }

    // Send zoom request to center at current frequency, keeping current bin bandwidth
    if (spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
        const currentBinBandwidth = spectrumDisplay.binBandwidth || 400.0;
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: currentBinBandwidth
        }));
        log(`Centered spectrum at ${formatFrequency(frequency)}`);
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

// Expose functions to global scope for HTML onclick/onchange handlers
// (Required because ES6 modules don't automatically expose functions globally)

// Spectrum controls
window.spectrumResetZoom = spectrumResetZoom;
window.spectrumZoomOut = spectrumZoomOut;
window.spectrumZoomIn = spectrumZoomIn;
window.spectrumMaxZoom = spectrumMaxZoom;
console.log('[app.js] Spectrum zoom functions exposed globally:', {
    spectrumZoomIn: typeof window.spectrumZoomIn,
    spectrumZoomOut: typeof window.spectrumZoomOut,
    spectrumResetZoom: typeof window.spectrumResetZoom,
    spectrumMaxZoom: typeof window.spectrumMaxZoom
});
window.spectrumCenterFrequency = spectrumCenterFrequency;
window.updateSpectrumColorScheme = updateSpectrumColorScheme;
window.updateSpectrumRange = updateSpectrumRange;
window.updateSpectrumGrid = updateSpectrumGrid;

// Helper function for spectrum display to get current dial frequency
window.getCurrentDialFrequency = function() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return 0;
    // Get frequency from data-hz-value attribute
    return parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
};

// Audio controls
window.toggleMute = toggleMute;
window.toggleNR2Quick = toggleNR2Quick;
window.toggleNBQuick = toggleNBQuick;
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
window.setFrequencyInputValue = setFrequencyInputValue;
window.setBand = setBand;
window.adjustFrequency = adjustFrequency;
window.setMode = setMode;
window.updateBandwidthDisplay = updateBandwidthDisplay;
window.updateBandwidth = updateBandwidth;

// Visualization controls
window.openRecorderModal = openRecorderModal;
window.toggleAudioVisualization = toggleAudioVisualization;
window.toggleAudioControls = toggleAudioControls;
window.updateFFTSize = updateFFTSize;
window.updateScrollRate = updateScrollRate;
window.updateOscilloscopeZoom = updateOscilloscopeZoom;

// Oscilloscope controls
window.autoSyncOscilloscope = autoSyncOscilloscope;
window.autoScaleOscilloscope = autoScaleOscilloscope;
window.shiftFrequencyTo1kHz = shiftFrequencyTo1kHz;


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

// Extension modal functions (defined before global exposure)
function openExtensionModal() {
    const modal = document.getElementById('extension-modal');
    const modalContent = document.getElementById('extension-modal-content');
    const panelContent = document.getElementById('extension-panel-content');
    const modalTitle = document.getElementById('extension-modal-title');
    const panelTitle = document.getElementById('extension-panel-title');

    // Clone the panel content into the modal
    modalContent.innerHTML = panelContent.innerHTML;
    modalTitle.textContent = panelTitle.textContent;

    // Enable modal mode for the active decoder
    if (window.decoderManager) {
        const activeDecoders = window.decoderManager.getActiveDecoders();
        if (activeDecoders.length > 0) {
            const decoder = window.decoderManager.getDecoder(activeDecoders[0]);
            if (decoder) {
                decoder.modalMode = true;
                decoder.modalBodyId = 'extension-modal-content';
                // Force an update to sync modal with current state
                decoder.updateDisplay();
            }
        }
    }

    // Show the modal
    modal.classList.add('show');
}

function closeExtensionModal() {
    const modal = document.getElementById('extension-modal');

    // Disable modal mode for the active decoder
    if (window.decoderManager) {
        const activeDecoders = window.decoderManager.getActiveDecoders();
        if (activeDecoders.length > 0) {
            const decoder = window.decoderManager.getDecoder(activeDecoders[0]);
            if (decoder) {
                decoder.modalMode = false;
                decoder.modalBodyId = null;
            }
        }
    }

    modal.classList.remove('show');
}

let extensionModalZoom = 1.0;
function zoomExtensionModal(delta) {
    extensionModalZoom = Math.max(0.5, Math.min(2.0, extensionModalZoom + delta));
    const wrapper = document.getElementById('extension-modal-content-wrapper');
    const zoomDisplay = document.getElementById('extension-modal-zoom');

    wrapper.style.transform = `scale(${extensionModalZoom})`;
    zoomDisplay.textContent = `${Math.round(extensionModalZoom * 100)}%`;
}

// Extension controls
window.toggleExtension = toggleExtension;
window.closeExtensionPanel = closeExtensionPanel;
window.openExtensionModal = openExtensionModal;
window.closeExtensionModal = closeExtensionModal;
window.zoomExtensionModal = zoomExtensionModal;

// Toggle extension from dropdown
function toggleExtension(extensionName) {
    const dropdown = document.getElementById('extensions-dropdown');
    const panel = document.getElementById('extension-panel');
    const panelTitle = document.getElementById('extension-panel-title');
    const panelContent = document.getElementById('extension-panel-content');

    if (!extensionName) {
        // Close extension panel when empty value selected
        if (panel && panel.style.display !== 'none') {
            panel.style.display = 'none';
            // Disable all active decoders
            if (window.decoderManager) {
                window.decoderManager.getActiveDecoders().forEach(name => {
                    window.decoderManager.disable(name);
                    log(`${name} extension disabled`);
                });
            }
        }
        // Update URL to remove extension parameter
        updateURL();
        return;
    }

    const decoder = window.decoderManager.getDecoder(extensionName);
    if (!decoder) {
        log(`Extension not found: ${extensionName}`, 'error');
        if (dropdown) dropdown.value = '';
        return;
    }

    if (!panel || !panelTitle || !panelContent) {
        log(`Extension panel elements not found`, 'error');
        if (dropdown) dropdown.value = '';
        return;
    }

    // Check if this extension is already enabled
    // Priority: check if panel is visible AND showing this extension
    // decoder.enabled alone is not reliable during initialization
    const isPanelVisible = panel.style.display !== 'none';
    const isShowingThisExtension = panelTitle.textContent === decoder.displayName;
    const isCurrentlyEnabled = isPanelVisible && isShowingThisExtension;

    if (isCurrentlyEnabled) {
        // Hide panel and disable decoder
        panel.style.display = 'none';
        window.decoderManager.disable(extensionName);
        log(`${extensionName} extension disabled`);

        // Update URL to remove extension parameter
        updateURL();
    } else {
        // Disable any currently active decoder
        const activeDecoders = window.decoderManager.getActiveDecoders();
        activeDecoders.forEach(name => {
            if (name !== extensionName) {
                window.decoderManager.disable(name);
            }
        });

        // Initialize and enable the new decoder
        if (!audioContext) {
            log('Please start audio first (click "Click to Start")', 'error');
            dropdown.value = '';
            return;
        }

        // Initialize decoder if needed
        if (!decoder.enabled) {
            const centerFreq = 800; // Default center frequency
            window.decoderManager.initialize(extensionName, audioContext, analyser, centerFreq);
        }

        // Load extension template into panel
        fetch(`extensions/${extensionName}/template.html`)
            .then(response => response.text())
            .then(html => {
                panelContent.innerHTML = html;
                panelTitle.textContent = decoder.displayName || extensionName;
                panel.style.display = 'block';

                // Enable decoder
                window.decoderManager.enable(extensionName);

                log(`${extensionName} extension enabled`);

                // Update URL with new extension state (after enabling)
                updateURL();
            })
            .catch(err => {
                log(`Failed to load extension template: ${err.message}`, 'error');
                dropdown.value = '';
            });
    }

    // Reset dropdown to empty (but don't trigger change event)
    // This allows the user to select the same extension again from the dropdown
    dropdown.value = '';
}

// Close extension panel
function closeExtensionPanel() {
    const panel = document.getElementById('extension-panel');
    if (panel) {
        panel.style.display = 'none';
        // Disable all active decoders
        if (window.decoderManager) {
            window.decoderManager.getActiveDecoders().forEach(name => {
                window.decoderManager.disable(name);
                log(`${name} extension disabled`);
            });
        }
        // Update URL to remove extension parameter
        updateURL();
    }
}

// Populate band selector dropdown with grouped bands
function populateBandSelector() {
    console.log('[app.js] populateBandSelector() called');
    const selector = document.getElementById('band-selector');
    console.log('[app.js] selector element:', selector);
    console.log('[app.js] window.amateurBands:', window.amateurBands);
    console.log('[app.js] window.amateurBands length:', window.amateurBands ? window.amateurBands.length : 'undefined');
    if (!selector || !window.amateurBands || window.amateurBands.length === 0) {
        console.log('[app.js] populateBandSelector() exiting early - missing selector or bands');
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
            // Display mode in brackets after band name if specified
            const displayText = band.mode ? `${band.label} (${band.mode.toUpperCase()})` : band.label;
            option.textContent = displayText;
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
            // Display mode in brackets after band name if specified
            const displayText = band.mode ? `${band.label} (${band.mode.toUpperCase()})` : band.label;
            option.textContent = displayText;
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

        // Set frequency to band center (only if not currently being edited)
        const freqInput = document.getElementById('frequency');
        if (freqInput && document.activeElement !== freqInput) {
            setFrequencyInputValue(centerFreq);
        }
        updateBandButtons(centerFreq);

        // Check if band has a mode field in window.amateurBands
        let mode = null;
        console.log('selectBandFromDropdown: Looking for band:', bandData.label);
        console.log('selectBandFromDropdown: Available bands:', window.amateurBands);

        if (window.amateurBands && window.amateurBands.length > 0) {
            const fullBandData = window.amateurBands.find(b => b.label === bandData.label);
            console.log('selectBandFromDropdown: Found band data:', fullBandData);

            if (fullBandData && fullBandData.mode) {
                mode = fullBandData.mode.toLowerCase(); // Ensure lowercase
                console.log('selectBandFromDropdown: Using band mode:', mode);
                log(`Using band-specific mode: ${mode.toUpperCase()}`);
            }
        }

        // If no mode specified in band data, use default based on frequency
        if (!mode) {
            mode = centerFreq < 10000000 ? 'lsb' : 'usb';
            console.log('selectBandFromDropdown: Using frequency-based mode:', mode);
        }

        setMode(mode);

        // Update URL with new frequency and mode
        updateURL();

        // Auto-connect if not connected
        if (!wsManager.isConnected()) {
            connect();
        } else {
            autoTune();
        }

        // Zoom spectrum to show entire band (same as band buttons)
        if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
            // Set flag to prevent edge detection from interfering after zoom
            spectrumDisplay.skipEdgeDetection = true;
            // Clear the flag after a short delay (after zoom completes)
            setTimeout(() => {
                if (spectrumDisplay) {
                    spectrumDisplay.skipEdgeDetection = false;
                }
            }, 2000);

            // Use a minimum bandwidth to prevent excessive zoom on narrow bands
            const minBandWidth = 100000; // 100 kHz minimum (same as band buttons)
            const effectiveBandWidth = Math.max(bandWidth, minBandWidth);
            // Use default bin count (1024) instead of current state to ensure consistent zoom
            const binCount = 1024; // Default from config.go
            const binBandwidth = effectiveBandWidth / binCount;

            spectrumDisplay.ws.send(JSON.stringify({
                type: 'zoom',
                frequency: centerFreq,
                binBandwidth: binBandwidth
            }));

            log(`Tuned to ${bandData.label}: ${formatFrequency(centerFreq)} ${mode.toUpperCase()} (zoomed to ${formatFrequency(centerFreq - effectiveBandWidth/2)} - ${formatFrequency(centerFreq + effectiveBandWidth/2)})`);
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

    // Get frequency from data-hz-value attribute
    let currentFreq = parseInt(freqInput.getAttribute('data-hz-value'));
    if (isNaN(currentFreq) || !currentFreq) {
        // Fallback: parse the display value intelligently based on magnitude
        const displayValue = parseFloat(freqInput.value);
        if (isNaN(displayValue)) {
            console.log('updateBandSelector: invalid frequency');
            selector.value = '';
            return;
        }
        // If value is small (< 100), assume it's in MHz and convert
        if (displayValue < 100) {
            currentFreq = Math.round(displayValue * 1000000);
        } else if (displayValue < 100000) {
            // Assume kHz
            currentFreq = Math.round(displayValue * 1000);
        } else {
            currentFreq = Math.round(displayValue);
        }
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

// Expose updateBandSelector globally
window.updateBandSelector = updateBandSelector;

// Populate bookmark selector dropdown
function populateBookmarkSelector() {
    console.log('[app.js] populateBookmarkSelector() called');
    const selector = document.getElementById('bookmark-selector');
    console.log('[app.js] selector element:', selector);
    console.log('[app.js] window.bookmarks:', window.bookmarks);
    console.log('[app.js] window.bookmarks length:', window.bookmarks ? window.bookmarks.length : 'undefined');
    if (!selector || !window.bookmarks || window.bookmarks.length === 0) {
        console.log('[app.js] populateBookmarkSelector() exiting early - missing selector or bookmarks');
        return;
    }

    // Clear existing options except the first one
    selector.innerHTML = '<option value="">Select Bookmark...</option>';

    // Group bookmarks by their group field
    const grouped = {};
    const ungrouped = [];

    window.bookmarks.forEach(bookmark => {
        if (bookmark.group) {
            if (!grouped[bookmark.group]) {
                grouped[bookmark.group] = [];
            }
            grouped[bookmark.group].push(bookmark);
        } else {
            ungrouped.push(bookmark);
        }
    });

    // Add grouped bookmarks with optgroup elements
    Object.keys(grouped).sort().forEach(groupName => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;

        grouped[groupName].forEach(bookmark => {
            const option = document.createElement('option');
            option.value = JSON.stringify({
                name: bookmark.name,
                frequency: bookmark.frequency,
                mode: bookmark.mode,
                extension: bookmark.extension,
                group: bookmark.group,
                comment: bookmark.comment
            });
            option.textContent = bookmark.name;
            optgroup.appendChild(option);
        });

        selector.appendChild(optgroup);
    });

    // Add ungrouped bookmarks at the end
    if (ungrouped.length > 0) {
        ungrouped.forEach(bookmark => {
            const option = document.createElement('option');
            option.value = JSON.stringify({
                name: bookmark.name,
                frequency: bookmark.frequency,
                mode: bookmark.mode,
                extension: bookmark.extension,
                comment: bookmark.comment
            });
            option.textContent = bookmark.name;
            selector.appendChild(option);
        });
    }

    log(`Bookmark selector populated with ${window.bookmarks.length} bookmarks`);
}

// Handle bookmark selection from dropdown
function selectBookmarkFromDropdown(value) {
    const selector = document.getElementById('bookmark-selector');

    if (!value) {
        return;
    }

    try {
        const bookmarkData = JSON.parse(value);

        // Use the existing handleBookmarkClick function from bookmark-manager.js
        // Pass false for shouldZoom and false for fromSpectrumMarker (dropdown selection)
        if (window.handleBookmarkClick) {
            window.handleBookmarkClick(bookmarkData, false, false);
        }

    } catch (e) {
        console.error('Error parsing bookmark data:', e);
        log('Error selecting bookmark', 'error');
    }

    // Reset dropdown to default after selection
    selector.value = '';
}

// Expose bookmark selector functions globally
window.populateBookmarkSelector = populateBookmarkSelector;
window.selectBookmarkFromDropdown = selectBookmarkFromDropdown;

// Audio Buffer Configuration Functions
function openBufferConfigModal() {
    const modal = document.getElementById('buffer-config-modal');
    if (modal) {
        // Highlight current selection by directly modifying button styles
        const buttons = modal.querySelectorAll('.buffer-preset-btn');
        buttons.forEach(btn => {
            const value = parseInt(btn.getAttribute('data-value'));
            if (value === maxBufferMs) {
                // Active state - green with glow
                btn.style.background = '#28a745';
                btn.style.borderColor = '#28a745';
                btn.style.color = 'white';
                btn.style.boxShadow = '0 0 10px rgba(40, 167, 69, 0.5)';
            } else {
                // Inactive state - default gray
                btn.style.background = '#34495e';
                btn.style.borderColor = '#7f8c8d';
                btn.style.color = '#ecf0f1';
                btn.style.boxShadow = 'none';
            }
        });

        // Update spectrum sync checkbox state
        const spectrumSyncCheckbox = document.getElementById('spectrum-sync-enable');
        if (spectrumSyncCheckbox) {
            spectrumSyncCheckbox.checked = window.spectrumSyncEnabled !== false;
        }

        // Update signal quality display
        updateSignalQualityDisplay();

        modal.style.display = 'flex';
    }
}

function closeBufferConfigModal() {
    const modal = document.getElementById('buffer-config-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function setBufferThreshold(value) {
    maxBufferMs = value;

    // Save to localStorage
    try {
        localStorage.setItem('audioBufferThreshold', value.toString());
    } catch (e) {
        console.error('Failed to save buffer threshold to localStorage:', e);
    }

    log(`Audio buffer threshold set to ${value}ms`);
    closeBufferConfigModal();
}

// Load buffer threshold from localStorage on startup
function loadBufferThreshold() {
    try {
        const saved = localStorage.getItem('audioBufferThreshold');
        if (saved) {
            const value = parseInt(saved);
            if (BUFFER_PRESETS.includes(value)) {
                maxBufferMs = value;
                log(`Loaded audio buffer threshold: ${value}ms`);
            }
        }
    } catch (e) {
        console.error('Failed to load buffer threshold from localStorage:', e);
    }
}

// Toggle spectrum sync
function toggleSpectrumSync() {
    const checkbox = document.getElementById('spectrum-sync-enable');
    if (!checkbox) return;

    window.spectrumSyncEnabled = checkbox.checked;

    // Save to localStorage
    try {
        localStorage.setItem('spectrumSyncEnabled', checkbox.checked ? 'true' : 'false');
    } catch (e) {
        console.error('Failed to save spectrum sync setting to localStorage:', e);
    }

    // Update spectrum display if it exists
    if (window.spectrumDisplay) {
        window.spectrumDisplay.spectrumSyncEnabled = checkbox.checked;
    }

    log(`Spectrum sync ${checkbox.checked ? 'enabled' : 'disabled'}`);
}

// Toggle chat user markers on spectrum
function toggleChatMarkers() {
    const checkbox = document.getElementById('show-chat-markers');
    if (!checkbox) return;

    window.showChatMarkers = checkbox.checked;

    // Save to localStorage
    try {
        localStorage.setItem('showChatMarkers', checkbox.checked ? 'true' : 'false');
    } catch (e) {
        console.error('Failed to save chat markers setting to localStorage:', e);
    }

    // Invalidate marker cache to force redraw
    if (window.spectrumDisplay) {
        window.spectrumDisplay.invalidateMarkerCache();
    }

    log(`Chat markers ${checkbox.checked ? 'enabled' : 'disabled'}`);
}

// Load spectrum sync setting from localStorage
function loadSpectrumSyncSetting() {
    try {
        const saved = localStorage.getItem('spectrumSyncEnabled');
        if (saved !== null) {
            window.spectrumSyncEnabled = saved === 'true';
            log(`Loaded spectrum sync setting: ${window.spectrumSyncEnabled ? 'enabled' : 'disabled'}`);
        } else {
            // Default to disabled
            window.spectrumSyncEnabled = false;
        }
    } catch (e) {
        console.error('Failed to load spectrum sync setting from localStorage:', e);
        window.spectrumSyncEnabled = false; // Default to disabled on error
    }
}

// Load chat markers setting from localStorage
function loadChatMarkersSetting() {
    try {
        const saved = localStorage.getItem('showChatMarkers');
        if (saved !== null) {
            window.showChatMarkers = saved === 'true';
            log(`Loaded chat markers setting: ${window.showChatMarkers ? 'enabled' : 'disabled'}`);
        } else {
            // Default to enabled
            window.showChatMarkers = true;
        }
        
        // Update checkbox state if it exists
        const checkbox = document.getElementById('show-chat-markers');
        if (checkbox) {
            checkbox.checked = window.showChatMarkers;
        }
    } catch (e) {
        console.error('Failed to load chat markers setting from localStorage:', e);
        window.showChatMarkers = true; // Default to enabled on error
    }
}

// Load buffer threshold on page load (spectrum sync is loaded earlier in the other DOMContentLoaded)
document.addEventListener('DOMContentLoaded', () => {
    loadBufferThreshold();
});

// Expose buffer configuration functions globally
window.openBufferConfigModal = openBufferConfigModal;
window.closeBufferConfigModal = closeBufferConfigModal;
window.setBufferThreshold = setBufferThreshold;
window.toggleSpectrumSync = toggleSpectrumSync;
window.toggleChatMarkers = toggleChatMarkers;

// Copy UUID to clipboard
function copyUUIDToClipboard() {
    if (!window.publicUUID) {
        showNotification('UUID not available', 'error');
        return;
    }

    // Use the Clipboard API if available
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window.publicUUID)
            .then(() => {
                showNotification('UUID copied to clipboard - Use this in the desktop client application', 'success', 3000);
                log('UUID copied to clipboard');
            })
            .catch(err => {
                console.error('Failed to copy UUID:', err);
                showNotification('Failed to copy UUID', 'error');
            });
    } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = window.publicUUID;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showNotification('UUID copied to clipboard - Use this in the desktop client application', 'success', 3000);
            log('UUID copied to clipboard');
        } catch (err) {
            console.error('Failed to copy UUID:', err);
            showNotification('Failed to copy UUID', 'error');
        }
        document.body.removeChild(textArea);
    }
}

// Expose UUID copy function globally
window.copyUUIDToClipboard = copyUUIDToClipboard;

// Frequency scroll configuration
let frequencyScrollMode = '500-fast'; // Default mode
let frequencyScrollStep = 500; // Hz
let frequencyScrollDelay = 25; // ms (optimized for 40 cmd/sec rate limit - 40 updates/sec)

// Toggle frequency scroll dropdown visibility (deprecated - dropdown now always visible)
function toggleFrequencyScrollDropdown() {
    // Function kept for compatibility but no longer needed
    // Dropdown is now always visible
    updateFrequencyScrollMode();
}

// Update frequency scroll mode from dropdown
function updateFrequencyScrollMode() {
    const dropdown = document.getElementById('frequency-scroll-mode');
    if (!dropdown) return;

    frequencyScrollMode = dropdown.value;

    // Parse the mode to get step and delay
    const [stepStr, speed] = frequencyScrollMode.split('-');
    const step = parseInt(stepStr);

    frequencyScrollStep = step;

    // Set delay based on speed
    // Optimized for 40 cmd/sec rate limit
    // "slow" = 50ms delay (20 updates/sec), "fast" = 25ms delay (40 updates/sec)
    frequencyScrollDelay = speed === 'slow' ? 50 : 25;

    // Set global variables for spectrum-display.js to use
    window.frequencyScrollStep = step;
    window.frequencyScrollDelay = frequencyScrollDelay;

    // Format step for display (show kHz for values >= 1000)
    const stepDisplay = step >= 1000 ? `${step / 1000} kHz` : `${step} Hz`;
    log(`Frequency scroll mode: ${stepDisplay} ${speed} (${frequencyScrollDelay}ms delay)`);
}

// Expose functions globally
window.toggleFrequencyScrollDropdown = toggleFrequencyScrollDropdown;
window.updateFrequencyScrollMode = updateFrequencyScrollMode;

// Frequency unit toggle functionality
let currentFrequencyUnit = 'kHz'; // Can be 'Hz', 'kHz', or 'MHz' - default to kHz

// Load frequency unit preference from localStorage
function loadFrequencyUnitPreference() {
    try {
        const saved = localStorage.getItem('frequencyUnit');
        if (saved && ['Hz', 'kHz', 'MHz'].includes(saved)) {
            currentFrequencyUnit = saved;
            // Update the label if it exists
            const unitLabel = document.getElementById('frequency-unit');
            if (unitLabel) {
                unitLabel.textContent = currentFrequencyUnit;
            }
            console.log(`Loaded frequency unit preference: ${currentFrequencyUnit}`);
            return true;
        }
    } catch (e) {
        console.error('Failed to load frequency unit preference:', e);
    }
    return false;
}

// Save frequency unit preference to localStorage
function saveFrequencyUnitPreference() {
    try {
        localStorage.setItem('frequencyUnit', currentFrequencyUnit);
    } catch (e) {
        console.error('Failed to save frequency unit preference:', e);
    }
}

// Toggle frequency unit (Hz -> kHz -> MHz -> Hz)
function toggleFrequencyUnit() {
    const unitLabel = document.getElementById('frequency-unit');
    const freqInput = document.getElementById('frequency');

    if (!unitLabel || !freqInput) return;

    // Get current value in Hz (internal representation)
    const currentHzValue = parseFloat(freqInput.getAttribute('data-hz-value') || freqInput.value);
    if (isNaN(currentHzValue)) return;

    // Cycle through units: Hz -> kHz -> MHz -> Hz
    if (currentFrequencyUnit === 'Hz') {
        currentFrequencyUnit = 'kHz';
    } else if (currentFrequencyUnit === 'kHz') {
        currentFrequencyUnit = 'MHz';
    } else {
        currentFrequencyUnit = 'Hz';
    }

    // Update the label
    unitLabel.textContent = currentFrequencyUnit;

    // Save preference
    saveFrequencyUnitPreference();

    // Convert and display the value in the new unit
    updateFrequencyDisplay();

    log(`Frequency unit changed to ${currentFrequencyUnit}`);
}

// Update frequency display based on current unit
function updateFrequencyDisplay() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;

    // Get the internal Hz value
    const hzValue = parseFloat(freqInput.getAttribute('data-hz-value') || freqInput.value);
    if (isNaN(hzValue)) return;

    // Store the Hz value as a data attribute
    freqInput.setAttribute('data-hz-value', hzValue);

    // Convert to display unit
    let displayValue;
    if (currentFrequencyUnit === 'kHz') {
        displayValue = (hzValue / 1000).toFixed(3); // 3 decimals to show 1 Hz changes
    } else if (currentFrequencyUnit === 'MHz') {
        displayValue = (hzValue / 1000000).toFixed(6);
    } else {
        displayValue = Math.round(hzValue).toString();
    }

    // Update the input field
    freqInput.value = displayValue;
}

// Helper function to set frequency value in Hz (used throughout the codebase)
function setFrequencyInputValue(hzValue) {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;

    const roundedHz = Math.round(hzValue);

    // CRITICAL: Set the Hz value attribute FIRST
    freqInput.setAttribute('data-hz-value', roundedHz);

    // Update display in current unit
    updateFrequencyDisplay();

    // CRITICAL: Ensure the attribute is still set after display update
    // (in case updateFrequencyDisplay somehow clears it)
    freqInput.setAttribute('data-hz-value', roundedHz);
}

// Convert displayed value to Hz when input changes
function convertDisplayedFrequencyToHz() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;

    const displayValue = parseFloat(freqInput.value);
    if (isNaN(displayValue)) return;

    // Convert to Hz based on current unit
    let hzValue;
    if (currentFrequencyUnit === 'kHz') {
        hzValue = displayValue * 1000;
    } else if (currentFrequencyUnit === 'MHz') {
        hzValue = displayValue * 1000000;
    } else {
        hzValue = displayValue;
    }

    // Store the Hz value
    freqInput.setAttribute('data-hz-value', Math.round(hzValue));
}

// Override the existing handleFrequencyChange to work with units
const originalHandleFrequencyChange = handleFrequencyChange;
window.handleFrequencyChange = function() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;

    // Convert displayed value to Hz first
    convertDisplayedFrequencyToHz();

    // Get the Hz value
    const hzValue = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);

    // Temporarily set the input to Hz string for the original validation
    const savedDisplayValue = freqInput.value;
    freqInput.value = hzValue.toString();

    // Disable edge detection temporarily when user manually changes frequency
    if (window.spectrumDisplay) {
        window.spectrumDisplay.skipEdgeDetection = true;
        setTimeout(() => {
            if (window.spectrumDisplay) {
                window.spectrumDisplay.skipEdgeDetection = false;
            }
        }, 2000);
    }

    // Call the original function (it will read freqInput.value as Hz)
    originalHandleFrequencyChange();

    // Restore the display value in the current unit
    updateFrequencyDisplay();

    // Notify extensions of frequency change (in case original didn't)
    if (window.radioAPI && hzValue) {
        window.radioAPI.notifyFrequencyChange(hzValue);
    }
};

// Override validateFrequencyInput to handle decimal points for kHz/MHz
const originalValidateFrequencyInput = validateFrequencyInput;
window.validateFrequencyInput = function(input) {
    if (currentFrequencyUnit === 'Hz') {
        // Hz mode: only allow digits (original behavior)
        originalValidateFrequencyInput(input);
    } else {
        // kHz/MHz mode: allow digits and one decimal point
        const cursorPos = input.selectionStart;
        const oldValue = input.value;

        // Allow digits, one decimal point, and handle multiple decimals
        let value = oldValue.replace(/[^\d.]/g, '');

        // Ensure only one decimal point
        const parts = value.split('.');
        if (parts.length > 2) {
            value = parts[0] + '.' + parts.slice(1).join('');
        }

        // Limit decimal places based on unit
        if (parts.length === 2) {
            if (currentFrequencyUnit === 'kHz') {
                // kHz: limit to 3 decimal places (to show 1 Hz precision)
                parts[1] = parts[1].substring(0, 3);
            } else if (currentFrequencyUnit === 'MHz') {
                // MHz: limit to 6 decimal places
                parts[1] = parts[1].substring(0, 6);
            }
            value = parts.join('.');
        }

        // Only update if value changed
        if (value !== oldValue) {
            input.value = value;

            // Restore cursor position
            const newCursorPos = Math.max(0, Math.min(value.length, cursorPos));
            input.setSelectionRange(newCursorPos, newCursorPos);
        }
    }
};

// Initialize frequency display on page load
document.addEventListener('DOMContentLoaded', () => {
    const freqInput = document.getElementById('frequency');
    if (freqInput) {
        // The HTML value is always in Hz (e.g., "14175000")
        const initialHz = parseInt(freqInput.value);
        if (!isNaN(initialHz)) {
            freqInput.setAttribute('data-hz-value', initialHz);
        }

        // Load saved unit preference (or use default kHz)
        const unitLoaded = loadFrequencyUnitPreference();

        // Update display to show in the current unit (kHz by default or saved preference)
        updateFrequencyDisplay();

        // Add blur event to convert and validate
        freqInput.addEventListener('blur', () => {
            convertDisplayedFrequencyToHz();
            updateFrequencyDisplay();
        });
    }

    // KiwiSDR CAT sync integration - connect implementation hooks
    const w = window;
    
    // Frequency setter implementation
    const setfreqImpl = (hz) => {
        const rounded = Math.round(Number(hz));
        if (!Number.isFinite(rounded) || rounded <= 0) return false;
        
        w.__catsync_state = w.__catsync_state || { hz: null, mode: null, requestedHz: null };
        w.__catsync_state.requestedHz = rounded;
        w.__catsync_state.hz = rounded;
        
        // Use the existing setFrequencyInputValue function
        setFrequencyInputValue(rounded);
        updateBandButtons(rounded);
        updateBandSelector();
        updateURL();
        
        // Notify extensions
        if (window.radioAPI) {
            window.radioAPI.notifyFrequencyChange(rounded);
        }
        
        // Auto-tune if connected
        if (wsManager.isConnected()) {
            autoTune();
        } else {
            connect();
        }
        
        return true;
    };
    
    // Mode setter implementation
    const setmodeImpl = (mode) => {
        const raw = String(mode || '').trim().toUpperCase();
        
        // Map KiwiSDR mode names to ka9q_ubersdr modes
        const modeMap = {
            'WFM': 'fm',
            'NFM': 'nfm',
            'NBFM': 'nfm',
            'CWU': 'cwu',
            'CWL': 'cwl',
            'DIGU': 'usb',
            'DIGL': 'lsb',
            'DSB': 'am',
            'USB': 'usb',
            'LSB': 'lsb',
            'AM': 'am',
            'SAM': 'sam',
            'FM': 'fm',
            'CW': 'cwu'  // Default CW to CWU
        };
        
        const mappedMode = modeMap[raw] || raw.toLowerCase();
        const validModes = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];
        const finalMode = validModes.includes(mappedMode) ? mappedMode : 'usb';
        
        w.__catsync_state = w.__catsync_state || { hz: null, mode: null, requestedHz: null };
        w.__catsync_state.mode = finalMode.toUpperCase();
        
        setMode(finalMode);
        return true;
    };
    
    // Zoom step implementation (for band zoom)
    const zoomStepImpl = (action) => {
        const toBand = w.ext_zoom?.TO_BAND;
        const isToBand = action === toBand || action === 'TO_BAND' || action === 0;
        
        if (!isToBand) return true; // Ignore other zoom actions
        
        // Zoom to show current band
        const freqInput = document.getElementById('frequency');
        const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
        
        if (frequency > 0 && window.amateurBands) {
            // Find the band containing current frequency
            const band = window.amateurBands.find(b => frequency >= b.start && frequency <= b.end);
            if (band) {
                const bandWidth = band.end - band.start;
                const centerFreq = Math.round((band.start + band.end) / 2);
                
                if (spectrumDisplay && spectrumDisplay.ws && spectrumDisplay.ws.readyState === WebSocket.OPEN) {
                    const minBandWidth = 100000; // 100 kHz minimum
                    const effectiveBandWidth = Math.max(bandWidth, minBandWidth);
                    const binCount = 1024;
                    const binBandwidth = effectiveBandWidth / binCount;
                    
                    spectrumDisplay.ws.send(JSON.stringify({
                        type: 'zoom',
                        frequency: centerFreq,
                        binBandwidth: binBandwidth
                    }));
                    
                    log(`CAT sync: Zoomed to ${band.label || 'band'}`);
                }
            }
        }
        
        return true;
    };
    
    // Register implementation hooks
    w.__catsync_setfreq_impl = setfreqImpl;
    w.__catsync_setmode_impl = setmodeImpl;
    w.__catsync_zoom_step_impl = zoomStepImpl;
    
    // Flush any queued commands
    if (typeof w.__catsync_flush === 'function') {
        w.__catsync_flush();
    }
    
    console.log('[CAT sync] Implementation hooks registered');
});

// Update CAT sync state when frequency/mode changes
function updateCATSyncState() {
    const w = window;
    if (!w.__catsync_state) return;
    
    const freqInput = document.getElementById('frequency');
    const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : null;
    
    if (frequency != null) {
        w.__catsync_state.hz = Math.round(frequency);
    }
    w.__catsync_state.mode = currentMode.toUpperCase();
    
    // Notify external integrations of changes
    const lastNotified = w.__catsync_last_notified || { hz: null, mode: null };
    const freqChanged = frequency != null && frequency !== lastNotified.hz;
    const modeChanged = currentMode !== lastNotified.mode;
    
    if (freqChanged || modeChanged) {
        try {
            if (typeof w.injection_environment_changed === 'function') {
                console.debug('[CAT sync] injection_environment_changed', { freqChanged, modeChanged, frequency, mode: currentMode });
                w.injection_environment_changed({ freq: freqChanged, mode: modeChanged });
            }
        } catch (e) {
            console.error('[CAT sync] Error calling injection_environment_changed:', e);
        }
        
        w.__catsync_last_notified = { hz: frequency, mode: currentMode };
    }
    
    // Call freqset_complete if we reached the requested frequency
    const requestedHz = w.__catsync_state.requestedHz;
    if (requestedHz != null && frequency != null && Math.round(frequency) === requestedHz) {
        try {
            const noop = w.__catsync_noop_freqset_complete;
            if (typeof w.freqset_complete === 'function' && w.freqset_complete !== noop) {
                w.freqset_complete();
            }
        } catch (e) {
            console.error('[CAT sync] Error calling freqset_complete:', e);
        }
        w.__catsync_state.requestedHz = null;
    }
}

// Expose toggle function globally
window.toggleFrequencyUnit = toggleFrequencyUnit;

// Draw SNR chart
function drawSNRChart() {
    if (!snrChartCanvas || !snrChartCtx) {
        snrChartCanvas = document.getElementById('snr-chart-canvas');
        if (!snrChartCanvas) return;
        snrChartCtx = snrChartCanvas.getContext('2d');
    }

    const width = snrChartCanvas.width;
    const height = snrChartCanvas.height;

    // Clear canvas
    snrChartCtx.fillStyle = '#2c3e50';
    snrChartCtx.fillRect(0, 0, width, height);

    if (snrHistory.length === 0) {
        // No data yet - show message
        snrChartCtx.fillStyle = '#888';
        snrChartCtx.font = '12px monospace';
        snrChartCtx.textAlign = 'center';
        snrChartCtx.textBaseline = 'middle';
        snrChartCtx.fillText('Waiting for data...', width / 2, height / 2);
        return;
    }

    // Find min and max SNR for scaling
    let minSNR = Math.min(...snrHistory.map(e => e.value));
    let maxSNR = Math.max(...snrHistory.map(e => e.value));

    // Add some padding to the range
    const range = maxSNR - minSNR;
    const padding = Math.max(5, range * 0.1); // At least 5 dB padding
    minSNR = Math.max(0, minSNR - padding);
    maxSNR = maxSNR + padding;

    // Ensure minimum range of 10 dB for readability
    if (maxSNR - minSNR < 10) {
        const center = (maxSNR + minSNR) / 2;
        minSNR = Math.max(0, center - 5);
        maxSNR = center + 5;
    }

    const snrRange = maxSNR - minSNR;

    // Draw horizontal grid lines and dB labels (left side only)
    snrChartCtx.font = 'bold 10px monospace';
    snrChartCtx.textAlign = 'left';
    snrChartCtx.textBaseline = 'middle';

    // Calculate appropriate step for grid lines (aim for 4-6 lines)
    let dbStep = 5;
    if (snrRange > 50) dbStep = 10;
    else if (snrRange > 25) dbStep = 5;
    else if (snrRange > 10) dbStep = 2;
    else dbStep = 1;

    const firstDb = Math.ceil(minSNR / dbStep) * dbStep;
    for (let db = firstDb; db <= maxSNR; db += dbStep) {
        const y = height - ((db - minSNR) / snrRange) * height;

        // Draw grid line
        snrChartCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        snrChartCtx.lineWidth = 1;
        snrChartCtx.beginPath();
        snrChartCtx.moveTo(0, y);
        snrChartCtx.lineTo(width, y);
        snrChartCtx.stroke();

        // Draw dB label on left (just the number)
        const label = db.toFixed(0);
        const labelWidth = snrChartCtx.measureText(label).width + 6;

        snrChartCtx.fillStyle = 'rgba(44, 62, 80, 0.8)';
        snrChartCtx.fillRect(2, y - 8, labelWidth, 16);

        snrChartCtx.strokeStyle = '#000000';
        snrChartCtx.lineWidth = 2;
        snrChartCtx.strokeText(label, 5, y);

        snrChartCtx.fillStyle = '#ffffff';
        snrChartCtx.fillText(label, 5, y);
    }

    // Draw SNR line graph
    if (snrHistory.length > 1) {
        snrChartCtx.strokeStyle = '#ffc107'; // Yellow/amber color
        snrChartCtx.lineWidth = 2;
        snrChartCtx.beginPath();

        const now = Date.now();
        const timeRange = SNR_HISTORY_MAX_AGE;

        snrHistory.forEach((entry, index) => {
            // Calculate x position based on time (right side is most recent)
            const age = now - entry.timestamp;
            const x = width - (age / timeRange) * width;

            // Calculate y position based on SNR value
            const y = height - ((entry.value - minSNR) / snrRange) * height;

            if (index === 0) {
                snrChartCtx.moveTo(x, y);
            } else {
                snrChartCtx.lineTo(x, y);
            }
        });

        snrChartCtx.stroke();

        // Draw filled area under the line
        snrChartCtx.fillStyle = 'rgba(255, 193, 7, 0.2)'; // Semi-transparent yellow
        snrChartCtx.beginPath();

        // Start from bottom left
        const firstAge = now - snrHistory[0].timestamp;
        const firstX = width - (firstAge / timeRange) * width;
        const firstY = height - ((snrHistory[0].value - minSNR) / snrRange) * height;
        snrChartCtx.moveTo(firstX, height);
        snrChartCtx.lineTo(firstX, firstY);

        // Draw line through all points
        snrHistory.forEach((entry) => {
            const age = now - entry.timestamp;
            const x = width - (age / timeRange) * width;
            const y = height - ((entry.value - minSNR) / snrRange) * height;
            snrChartCtx.lineTo(x, y);
        });

        // Close path at bottom right
        const lastAge = now - snrHistory[snrHistory.length - 1].timestamp;
        const lastX = width - (lastAge / timeRange) * width;
        snrChartCtx.lineTo(lastX, height);
        snrChartCtx.closePath();
        snrChartCtx.fill();
    }
}

// Update signal quality display in buffer config modal
function updateSignalQualityDisplay() {
    const basebandElement = document.getElementById('signal-baseband-power');
    const noiseElement = document.getElementById('signal-noise-density');
    const snrElement = document.getElementById('signal-snr');

    if (basebandElement) {
        if (currentBasebandPower > -900) {
            basebandElement.textContent = currentBasebandPower.toFixed(1) + ' dBFS';
        } else {
            basebandElement.textContent = 'N/A';
        }
    }

    if (noiseElement) {
        if (currentNoiseDensity > -900) {
            noiseElement.textContent = currentNoiseDensity.toFixed(1) + ' dBFS';
        } else {
            noiseElement.textContent = 'N/A';
        }
    }

    if (snrElement) {
        // Calculate SNR as the difference between baseband power and noise density
        // SNR = Signal - Noise (both in dBFS, so subtraction gives the ratio in dB)
        if (currentBasebandPower > -900 && currentNoiseDensity > -900) {
            const snr = currentBasebandPower - currentNoiseDensity;
            // Clamp at 0 dB minimum (signal should not be below noise floor)
            const clampedSnr = Math.max(0, snr);
            snrElement.textContent = clampedSnr.toFixed(1) + ' dB';
        } else {
            snrElement.textContent = 'N/A';
        }
    }

    // Draw SNR chart
    drawSNRChart();
}

// Expose signal quality update function globally
window.updateSignalQualityDisplay = updateSignalQualityDisplay;


// ============================================================================
// Popup Window Control System
// ============================================================================

// Track authorized control popup window
let controlPopup = null;

/**
 * Opens a control popup window that can send commands to this main window
 * @param {string} url - URL to open in the popup (e.g., 'control.html')
 * @param {number} width - Popup width in pixels (default: 400)
 * @param {number} height - Popup height in pixels (default: 600)
 * @returns {Window|null} Reference to the opened popup window
 */
function openControlPopup(url = 'control.html', width = 400, height = 600) {
    // Calculate centered position
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;
    
    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    
    // Open popup and store reference
    controlPopup = window.open(url, 'UberSDR_Control', features);
    
    if (controlPopup) {
        console.log('[Popup Control] Opened control popup:', url);
        
        // Monitor popup close
        const checkClosed = setInterval(() => {
            if (controlPopup && controlPopup.closed) {
                console.log('[Popup Control] Control popup closed');
                controlPopup = null;
                clearInterval(checkClosed);
            }
        }, 1000);
    } else {
        console.error('[Popup Control] Failed to open popup - check popup blocker');
    }
    
    return controlPopup;
}

/**
 * Secure message handler for popup control commands
 * Verifies origin and source before executing commands
 */
window.addEventListener('message', (event) => {
    // Security Check 1: Verify origin matches our domain
    const allowedOrigins = [
        window.location.origin,  // Same origin
        // Add additional trusted origins here if needed
    ];
    
    if (!allowedOrigins.includes(event.origin)) {
        console.warn('[Popup Control] Rejected message from unauthorized origin:', event.origin);
        return;
    }
    
    // Security Check 2: Verify source is our authorized popup
    if (controlPopup && event.source !== controlPopup) {
        console.warn('[Popup Control] Rejected message from unauthorized window');
        return;
    }
    
    // Parse command
    const { command, params } = event.data;
    
    if (!command) {
        console.warn('[Popup Control] Received message without command:', event.data);
        return;
    }
    
    console.log('[Popup Control] Processing command:', command, params);
    
    // Execute command
    try {
        switch (command) {
            case 'setFrequency':
                if (typeof params.frequency === 'number') {
                    setFrequency(params.frequency);
                    // Send acknowledgment
                    event.source.postMessage({
                        command: 'ack',
                        originalCommand: command,
                        success: true
                    }, event.origin);
                } else {
                    throw new Error('Invalid frequency parameter');
                }
                break;
                
            case 'setMode':
                if (typeof params.mode === 'string') {
                    const preserveBandwidth = params.preserveBandwidth !== undefined ? params.preserveBandwidth : false;
                    setMode(params.mode, preserveBandwidth);
                    event.source.postMessage({
                        command: 'ack',
                        originalCommand: command,
                        success: true
                    }, event.origin);
                } else {
                    throw new Error('Invalid mode parameter');
                }
                break;
                
            case 'setBandwidth':
                if (typeof params.low === 'number' && typeof params.high === 'number') {
                    currentBandwidthLow = params.low;
                    currentBandwidthHigh = params.high;
                    updateBandwidth();
                    event.source.postMessage({
                        command: 'ack',
                        originalCommand: command,
                        success: true
                    }, event.origin);
                } else {
                    throw new Error('Invalid bandwidth parameters');
                }
                break;
                
            case 'adjustFrequency':
                if (typeof params.deltaHz === 'number') {
                    adjustFrequency(params.deltaHz);
                    event.source.postMessage({
                        command: 'ack',
                        originalCommand: command,
                        success: true
                    }, event.origin);
                } else {
                    throw new Error('Invalid deltaHz parameter');
                }
                break;
                
            case 'getState':
                // Return current state to popup
                event.source.postMessage({
                    command: 'state',
                    state: {
                        frequency: currentFrequency,
                        mode: currentMode,
                        bandwidthLow: currentBandwidthLow,
                        bandwidthHigh: currentBandwidthHigh
                    }
                }, event.origin);
                break;
                
            default:
                console.warn('[Popup Control] Unknown command:', command);
                event.source.postMessage({
                    command: 'ack',
                    originalCommand: command,
                    success: false,
                    error: 'Unknown command'
                }, event.origin);
        }
    } catch (error) {
        console.error('[Popup Control] Error executing command:', error);
        event.source.postMessage({
            command: 'ack',
            originalCommand: command,
            success: false,
            error: error.message
        }, event.origin);
    }
});

// Expose openControlPopup globally for HTML onclick handlers
window.openControlPopup = openControlPopup;

console.log('[Popup Control] Secure popup control system initialized');

// ============================================================================
// Band Badge Right-Click Handler for Voice Activity Popup
// ============================================================================

/**
 * Opens voice activity popup for a specific band
 * @param {string} band - Band name (e.g., '40m', '20m')
 */
function openVoiceActivityPopup(band) {
    const url = `voice-activity.html?band=${encodeURIComponent(band)}`;
    return openControlPopup(url, 450, 650);
}

/**
 * Initialize right-click handlers on band badges
 */
function initializeBandBadgeRightClick() {
    const bandBadges = document.querySelectorAll('.band-status-badge');
    
    bandBadges.forEach(badge => {
        // Prevent default context menu
        badge.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const band = badge.getAttribute('data-band');
            if (band) {
                console.log(`[Band Badge] Opening voice activity popup for ${band}`);
                openVoiceActivityPopup(band);
            }
            return false;
        });
        
        // Add visual feedback on hover to indicate right-click is available
        badge.style.cursor = 'context-menu';
        badge.title = `Left-click to tune to ${badge.getAttribute('data-band')} | Right-click for voice activity`;
    });
    
    console.log(`[Band Badge] Initialized right-click handlers for ${bandBadges.length} band badges`);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeBandBadgeRightClick);
} else {
    // DOM already loaded
    initializeBandBadgeRightClick();
}

// Expose globally
window.openVoiceActivityPopup = openVoiceActivityPopup;
window.initializeBandBadgeRightClick = initializeBandBadgeRightClick;
