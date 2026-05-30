/**
 * Audio Recorder Module
 * Handles recording of the current audio stream with download capability
 * Supports WebM/Opus (compressed) and PCM WAV (lossless) formats
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

// WAV recording state
let wavWorkletNode = null;
let wavPcmChunks = []; // Array of Float32Array buffers
let wavSampleRate = 48000;
let wavNumChannels = 1;

/**
 * Get the currently selected recording format ('webm' or 'wav')
 */
function getSelectedFormat() {
    const wavRadio = document.getElementById('recorder-format-wav');
    return (wavRadio && wavRadio.checked) ? 'wav' : 'webm';
}

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
        wavPcmChunks = [];
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

        // Create a gain node to tap into the audio stream
        if (!window.recorderGainNode) {
            window.recorderGainNode = window.audioContext.createGain();
            window.recorderGainNode.gain.value = 1.0; // Unity gain (no change to audio)
        }

        const format = getSelectedFormat();

        if (format === 'wav') {
            await startWavRecording();
        } else {
            await startWebmRecording();
        }

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
        console.log(`Recording started (format: ${format})`);
    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Failed to start recording: ' + error.message);
    }
}

/**
 * Start WebM/Opus recording via MediaRecorder
 */
async function startWebmRecording() {
    const dest = window.audioContext.createMediaStreamDestination();
    window.recorderGainNode.connect(dest);

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
        console.log('WebM recording stopped, chunks:', recordedChunks.length);
    };

    audioRecorder.start(1000); // Collect data every second
}

/**
 * Start WAV/PCM recording via AudioWorklet (runs on audio rendering thread,
 * immune to main-thread jank that causes crackles with ScriptProcessorNode).
 */
async function startWavRecording() {
    wavPcmChunks = [];
    wavSampleRate = window.audioContext.sampleRate;
    wavNumChannels = 1; // mono — matches the SDR audio output

    // Load the worklet module if not already loaded
    try {
        await window.audioContext.audioWorklet.addModule('pcm-recorder-worklet.js');
    } catch (e) {
        // Module may already be registered — ignore "already exists" errors
        if (!e.message || !e.message.includes('already')) {
            throw e;
        }
    }

    wavWorkletNode = new AudioWorkletNode(window.audioContext, 'pcm-recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
    });

    // Receive PCM chunks from the audio thread
    wavWorkletNode.port.onmessage = (event) => {
        if (event.data.samples) {
            wavPcmChunks.push(event.data.samples);
        }
    };

    wavWorkletNode.port.postMessage({ command: 'start' });

    window.recorderGainNode.connect(wavWorkletNode);
    // Connect to destination to keep the graph alive
    wavWorkletNode.connect(window.audioContext.destination);
}

/**
 * Stop recording audio
 */
function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    recordingEndTime = Date.now();

    const format = getSelectedFormat();

    if (format === 'wav') {
        stopWavRecording();
    } else {
        stopWebmRecording();
    }

    // Stop signal data collection
    if (signalDataInterval) {
        clearInterval(signalDataInterval);
        signalDataInterval = null;
    }

    stopRecordingTimer();
    updateRecorderUI();
    console.log('Recording stopped');
}

/**
 * Stop WebM recording
 */
function stopWebmRecording() {
    if (audioRecorder) {
        audioRecorder.stop();
        audioRecorder = null;
    }
}

/**
 * Stop WAV recording
 */
function stopWavRecording() {
    if (wavWorkletNode) {
        wavWorkletNode.port.postMessage({ command: 'stop' });
        wavWorkletNode.disconnect();
        wavWorkletNode = null;
    }
    console.log('WAV recording stopped, PCM chunks:', wavPcmChunks.length);
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
 * Encode collected PCM chunks into a WAV ArrayBuffer.
 * Format: 16-bit signed PCM, mono, at the audio context sample rate.
 * Note: the source audio has already been Opus-decoded by the browser, so this
 * is an uncompressed capture of the decoded output — no additional generation
 * loss, but the original Opus decode is still lossy.
 */
function encodeWav(pcmChunks, sampleRate, numChannels) {
    // Flatten all Float32Array chunks into one
    let totalSamples = 0;
    for (const chunk of pcmChunks) {
        totalSamples += chunk.length;
    }

    const pcmData = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of pcmChunks) {
        pcmData.set(chunk, offset);
        offset += chunk.length;
    }

    // Convert float32 [-1, 1] to int16 [-32768, 32767]
    const int16Data = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcmData[i]));
        int16Data[i] = s < 0 ? s * 32768 : s * 32767;
    }

    const byteRate = sampleRate * numChannels * 2; // 2 bytes per int16 sample
    const blockAlign = numChannels * 2;
    const dataSize = int16Data.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);           // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true);  // SampleRate
    view.setUint32(28, byteRate, true);    // ByteRate
    view.setUint16(32, blockAlign, true);  // BlockAlign
    view.setUint16(34, 16, true);          // BitsPerSample

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write PCM samples
    const dataView = new Uint8Array(buffer, 44);
    const int16Bytes = new Uint8Array(int16Data.buffer);
    dataView.set(int16Bytes);

    return buffer;
}

/**
 * Helper: write an ASCII string into a DataView at a given offset
 */
function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

/**
 * Download the recorded audio as a ZIP file with metadata
 */
async function downloadRecording() {
    const format = getSelectedFormat();
    const hasData = format === 'wav' ? wavPcmChunks.length > 0 : recordedChunks.length > 0;

    if (!hasData) {
        alert('No recording available to download');
        return;
    }

    try {
        // Check if JSZip is available
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip library not loaded');
        }

        // Calculate duration
        const durationMs = recordingEndTime ? (recordingEndTime - recordingStartTime) : 0;
        const durationSec = Math.floor(durationMs / 1000);
        const minutes = Math.floor(durationSec / 60);
        const seconds = durationSec % 60;
        const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        // Build audio blob / buffer
        let audioData;
        let audioExt;
        let formatLine;

        if (format === 'wav') {
            const wavBuffer = encodeWav(wavPcmChunks, wavSampleRate, wavNumChannels);
            audioData = new Blob([wavBuffer], { type: 'audio/wav' });
            audioExt = 'wav';
            formatLine = `Container: WAV\nCodec: PCM (16-bit signed, little-endian)\nSample Rate: ${wavSampleRate} Hz\nChannels: ${wavNumChannels}`;
        } else {
            audioData = new Blob(recordedChunks, { type: 'audio/webm' });
            audioExt = 'webm';
            formatLine = `Container: WebM\nCodec: Opus\nSample Rate: ${window.audioContext ? window.audioContext.sampleRate : 'Unknown'} Hz`;
        }
        
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
${formatLine}

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
        zip.file(`${baseFilename}.${audioExt}`, audioData);
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
        
        console.log(`Recording downloaded as ZIP (format: ${audioExt})`);
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
    wavPcmChunks = [];
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
    const formatToggle = document.getElementById('recorder-format-toggle');

    const format = getSelectedFormat();
    const hasData = format === 'wav' ? wavPcmChunks.length > 0 : recordedChunks.length > 0;

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
        // Lock format toggle during recording
        if (formatToggle) {
            formatToggle.querySelectorAll('input[type="radio"]').forEach(r => {
                r.disabled = true;
                r.parentElement.style.opacity = '0.45';
                r.parentElement.style.cursor = 'default';
            });
        }
    } else {
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        if (downloadBtn) downloadBtn.disabled = !hasData;
        if (clearBtn) clearBtn.disabled = !hasData;
        if (statusIndicator) {
            statusIndicator.classList.remove('recording');
            statusIndicator.classList.add('stopped');
        }
        if (statusText) {
            statusText.textContent = hasData ? 'Ready' : 'Stopped';
        }
        // Unlock format toggle when not recording
        if (formatToggle) {
            formatToggle.querySelectorAll('input[type="radio"]').forEach(r => {
                r.disabled = false;
                r.parentElement.style.opacity = '';
                r.parentElement.style.cursor = 'pointer';
            });
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRecorder);
} else {
    initializeRecorder();
}
