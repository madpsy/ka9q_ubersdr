/**
 * Audio Recorder Module
 * Handles recording of the current audio stream with download capability
 */

let audioRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingEndTime = null;
let recordingTimerInterval = null;
let recordingMetadata = {};
let signalDataLog = []; // Array to store signal measurements
let signalDataInterval = null; // Interval for collecting signal data
const MAX_RECORDING_TIME_MS = 10 * 60 * 1000; // 10 minutes in milliseconds

/**
 * Initialize the audio recorder
 */
function initializeRecorder() {
    // Recorder will be initialized when recording starts
    console.log('Audio recorder module loaded');
}

/**
 * Open the recorder modal
 */
function openRecorderModal() {
    const modal = document.getElementById('recorder-modal');
    if (modal) {
        modal.style.display = 'flex';
        updateRecorderUI();
    }
}

/**
 * Close the recorder modal
 */
function closeRecorderModal() {
    const modal = document.getElementById('recorder-modal');
    if (modal) {
        modal.style.display = 'none';
        
        // Reset the recorder state when closing
        // Stop recording if active
        if (isRecording) {
            stopRecording();
        }
        
        // Clear any existing recording
        recordedChunks = [];
        recordingStartTime = null;
        recordingEndTime = null;
        recordingMetadata = {};
        updateRecordingTime(0);
        updateRecorderUI();
    }
}

/**
 * Start recording audio
 */
async function startRecording() {
    try {
        // Get the audio context
        if (!window.audioContext || !window.audioContext.destination) {
            throw new Error('Audio context not available. Please start audio playback first.');
        }

        // Capture metadata at start of recording
        const freqInput = document.getElementById('frequency');
        // Get frequency in Hz from data attribute (handles kHz/MHz units correctly)
        let frequency = 0;
        if (freqInput) {
            const hzValue = freqInput.getAttribute('data-hz-value');
            frequency = hzValue ? parseInt(hzValue) : parseInt(freqInput.value);
        }
        
        recordingMetadata = {
            startTime: new Date().toISOString(),
            frequency: frequency,
            mode: window.currentMode || 'unknown',
            bandwidthLow: window.currentBandwidthLow || 0,
            bandwidthHigh: window.currentBandwidthHigh || 0
        };

        // Create a MediaStreamDestination to capture the audio
        const dest = window.audioContext.createMediaStreamDestination();
        
        // Create a gain node to tap into the audio stream
        // This will be connected in the audio chain in app.js
        if (!window.recorderGainNode) {
            window.recorderGainNode = window.audioContext.createGain();
            window.recorderGainNode.gain.value = 1.0; // Unity gain (no change to audio)
        }
        
        // Connect the recorder gain node to MediaStreamDestination for recording
        // NOTE: Do NOT connect to audioContext.destination here - app.js handles that
        // to avoid dual connection which would double the audio volume
        window.recorderGainNode.connect(dest);

        // Create MediaRecorder
        const options = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'audio/webm';
        }
        
        audioRecorder = new MediaRecorder(dest.stream, options);
        recordedChunks = [];

        audioRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        audioRecorder.onstop = () => {
            recordingEndTime = Date.now();
            console.log('Recording stopped, chunks:', recordedChunks.length);
        };

        audioRecorder.start(1000); // Collect data every second
        isRecording = true;
        recordingStartTime = Date.now();
        recordingEndTime = null;
        
        // Initialize signal data log
        signalDataLog = [];
        
        // Start collecting signal data every second
        signalDataInterval = setInterval(() => {
            const timestamp = new Date().toISOString();
            const basebandPower = window.currentBasebandPower || -999;
            const noiseDensity = window.currentNoiseDensity || -999;
            const snr = (basebandPower > -900 && noiseDensity > -900) ? Math.max(0, basebandPower - noiseDensity) : null;
            
            signalDataLog.push({
                timestamp: timestamp,
                basebandPower: basebandPower > -900 ? basebandPower.toFixed(2) : 'N/A',
                noiseDensity: noiseDensity > -900 ? noiseDensity.toFixed(2) : 'N/A',
                snr: snr !== null ? snr.toFixed(2) : 'N/A'
            });
        }, 1000); // Collect every second
        
        // Start timer
        startRecordingTimer();
        
        updateRecorderUI();
        console.log('Recording started');
    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Failed to start recording: ' + error.message);
    }
}

/**
 * Stop recording audio
 */
function stopRecording() {
    if (audioRecorder && isRecording) {
        audioRecorder.stop();
        isRecording = false;
        
        // Stop signal data collection
        if (signalDataInterval) {
            clearInterval(signalDataInterval);
            signalDataInterval = null;
        }
        
        stopRecordingTimer();
        updateRecorderUI();
        console.log('Recording stopped');
    }
}

/**
 * Start the recording timer
 */
function startRecordingTimer() {
    recordingTimerInterval = setInterval(() => {
        if (recordingStartTime) {
            const elapsed = Date.now() - recordingStartTime;
            updateRecordingTime(elapsed);
            
            // Auto-stop after 10 minutes
            if (elapsed >= MAX_RECORDING_TIME_MS) {
                stopRecording();
                alert('Recording automatically stopped after 10 minutes (maximum length)');
            }
        }
    }, 100);
}

/**
 * Stop the recording timer
 */
function stopRecordingTimer() {
    if (recordingTimerInterval) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
    }
}

/**
 * Update the recording time display
 */
function updateRecordingTime(elapsed) {
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const timeString = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    
    const timeDisplay = document.getElementById('recording-time');
    if (timeDisplay) {
        timeDisplay.textContent = timeString;
    }
}

/**
 * Download the recorded audio as a ZIP file with metadata
 */
async function downloadRecording() {
    if (recordedChunks.length === 0) {
        alert('No recording available to download');
        return;
    }

    try {
        // Check if JSZip is available
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip library not loaded');
        }

        // Create audio blob
        const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
        
        // Calculate duration
        const durationMs = recordingEndTime ? (recordingEndTime - recordingStartTime) : 0;
        const durationSec = Math.floor(durationMs / 1000);
        const minutes = Math.floor(durationSec / 60);
        const seconds = durationSec % 60;
        const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        // Get instance information from global window.instanceDescription
        let instanceInfo = '';
        if (window.instanceDescription && window.instanceDescription.receiver) {
            const receiver = window.instanceDescription.receiver;
            instanceInfo = 'Receiver Information:\n';
            instanceInfo += '---------------------\n';
            if (receiver.callsign) {
                instanceInfo += `Callsign: ${receiver.callsign}\n`;
            }
            if (receiver.name) {
                instanceInfo += `Name: ${receiver.name}\n`;
            }
            if (receiver.location) {
                instanceInfo += `Location: ${receiver.location}\n`;
            }
            if (receiver.gps && receiver.gps.lat !== 0 && receiver.gps.lon !== 0) {
                instanceInfo += `Latitude: ${receiver.gps.lat.toFixed(6)}\n`;
                instanceInfo += `Longitude: ${receiver.gps.lon.toFixed(6)}\n`;
                if (receiver.gps.maidenhead) {
                    instanceInfo += `Maidenhead: ${receiver.gps.maidenhead}\n`;
                }
            }
            if (receiver.asl) {
                instanceInfo += `Altitude: ${receiver.asl}m ASL\n`;
            }
            if (receiver.antenna) {
                instanceInfo += `Antenna: ${receiver.antenna}\n`;
            }
            instanceInfo += '\n';
        }
        
        // Create metadata text
        const metadata = `SDR Recording Metadata
========================

${instanceInfo}Start Time (UTC): ${recordingMetadata.startTime}
End Time (UTC): ${recordingEndTime ? new Date(recordingEndTime).toISOString() : 'N/A'}
Duration: ${durationStr} (${durationSec} seconds)

Radio Settings:
--------------
Frequency: ${recordingMetadata.frequency} Hz (${formatFrequency(recordingMetadata.frequency)})
Mode: ${recordingMetadata.mode.toUpperCase()}
Bandwidth Low: ${recordingMetadata.bandwidthLow} Hz
Bandwidth High: ${recordingMetadata.bandwidthHigh} Hz

Recording Format:
----------------
Container: WebM
Codec: Opus
Sample Rate: ${window.audioContext ? window.audioContext.sampleRate : 'Unknown'} Hz

Generated by UberSDR Web Client
`;

        // Create signal data CSV
        let signalDataCSV = 'UTC Time,Baseband Power (dBFS),Noise Density (dBFS),SNR (dB)\n';
        signalDataLog.forEach(entry => {
            signalDataCSV += `${entry.timestamp},${entry.basebandPower},${entry.noiseDensity},${entry.snr}\n`;
        });
        
        // Create ZIP file
        const zip = new JSZip();
        
        // Generate base filename with timestamp
        const timestamp = new Date(recordingStartTime).toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const baseFilename = `sdr-recording-${timestamp}`;
        
        // Add files to ZIP
        zip.file(`${baseFilename}.webm`, audioBlob);
        zip.file(`${baseFilename}.txt`, metadata);
        zip.file(`${baseFilename}-signal.csv`, signalDataCSV);
        
        // Generate ZIP blob
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        
        // Download ZIP file
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${baseFilename}.zip`;
        
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        console.log('Recording downloaded as ZIP with metadata');
    } catch (error) {
        console.error('Error creating ZIP file:', error);
        alert('Failed to create ZIP file: ' + error.message);
    }
}

/**
 * Format frequency for display (uses global formatFrequency from app.js)
 * Note: window.formatFrequency is defined in app.js and handles Hz/kHz/MHz conversion
 */

/**
 * Clear the current recording
 */
function clearRecording() {
    if (isRecording) {
        if (!confirm('Stop and clear the current recording?')) {
            return;
        }
        stopRecording();
    }
    
    recordedChunks = [];
    recordingStartTime = null;
    recordingEndTime = null;
    recordingMetadata = {};
    signalDataLog = [];
    updateRecordingTime(0);
    updateRecorderUI();
    console.log('Recording cleared');
}

/**
 * Update the recorder UI based on current state
 */
function updateRecorderUI() {
    const startBtn = document.getElementById('recorder-start-btn');
    const stopBtn = document.getElementById('recorder-stop-btn');
    const downloadBtn = document.getElementById('recorder-download-btn');
    const clearBtn = document.getElementById('recorder-clear-btn');
    const statusIndicator = document.getElementById('recorder-status-indicator');
    const statusText = document.getElementById('recorder-status-text');

    if (isRecording) {
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        if (downloadBtn) downloadBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
        if (statusIndicator) {
            statusIndicator.classList.add('recording');
            statusIndicator.classList.remove('stopped');
        }
        if (statusText) statusText.textContent = 'Recording...';
    } else {
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        if (downloadBtn) downloadBtn.disabled = recordedChunks.length === 0;
        if (clearBtn) clearBtn.disabled = recordedChunks.length === 0;
        if (statusIndicator) {
            statusIndicator.classList.remove('recording');
            statusIndicator.classList.add('stopped');
        }
        if (statusText) {
            statusText.textContent = recordedChunks.length > 0 ? 'Ready' : 'Stopped';
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRecorder);
} else {
    initializeRecorder();
}