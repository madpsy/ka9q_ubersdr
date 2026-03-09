// TTS Announcements for Accessibility
// Announces frequency and mode changes using Google English voices only

// TTS State
let ttsEnabled = false;
let ttsVoice = null;
let ttsRate = 1.0;
let isSpeaking = false;
let frequencyChangeTimer = null;
let lastAnnouncedFrequency = null;
let lastAnnouncedMode = null;
let announcementQueue = [];
let isProcessingQueue = false;

/**
 * Check if browser is Chrome or Edge (Chromium-based)
 * @returns {boolean} True if Chrome or Edge
 */
function isChromiumBrowser() {
    const userAgent = navigator.userAgent.toLowerCase();
    // Check for Edge (modern Edge uses 'edg/' in user agent)
    const isEdge = userAgent.includes('edg/') || userAgent.includes('edge/');
    // Check for Chrome
    const isChrome = userAgent.includes('chrome/');
    const result = isChrome || isEdge;
    console.log('[TTS] Browser detection - UA:', navigator.userAgent);
    console.log('[TTS] Browser detection - isEdge:', isEdge, 'isChrome:', isChrome, 'result:', result);
    return result;
}

/**
 * Show modal dialog for unsupported browser
 */
function showUnsupportedBrowserModal() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'tts-browser-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;

    // Create modal content
    const modal = document.createElement('div');
    modal.style.cssText = `
        background: #2a2a2a;
        color: #e0e0e0;
        padding: 30px;
        border-radius: 12px;
        max-width: 500px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        font-family: Arial, sans-serif;
    `;

    modal.innerHTML = `
        <h2 style="margin-top: 0; color: #ff9800; font-size: 22px; display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 32px;">⚠️</span>
            Browser Not Supported
        </h2>
        <p style="line-height: 1.6; margin: 20px 0; font-size: 16px;">
            Text-to-Speech announcements require <strong>Google Chrome</strong> or
            <strong>Microsoft Edge</strong> for high-quality voice support.
        </p>
        <p style="line-height: 1.6; margin: 20px 0; font-size: 14px; color: #aaa;">
            Your current browser does not have the necessary Google English voices
            for clear and natural-sounding announcements.
        </p>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px;">
            <button id="tts-modal-close" style="
                background: #4CAF50;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
                transition: background 0.3s;
            ">
                OK
            </button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close modal on button click
    document.getElementById('tts-modal-close').addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    // Close modal on overlay click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });

    // Add hover effect to button
    const closeBtn = document.getElementById('tts-modal-close');
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = '#45a049';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = '#4CAF50';
    });
}

/**
 * Initialize TTS with Google English voice only
 * @returns {boolean} True if initialization successful
 */
function initializeTTS() {
    // Check if browser is Chrome or Edge
    if (!isChromiumBrowser()) {
        console.log('[TTS] Browser is not Chrome/Edge');
        showUnsupportedBrowserModal();
        return false;
    }
    
    if (!('speechSynthesis' in window)) {
        console.log('[TTS] Speech synthesis not supported');
        showUnsupportedBrowserModal();
        return false;
    }
    
    const voices = window.speechSynthesis.getVoices();
    
    // Filter for English voices only
    const englishVoices = voices.filter(v => v.lang.startsWith('en'));
    
    // Prioritize Google voices (following Whisper extension pattern)
    const googleEnglishVoices = englishVoices.filter(v =>
        v.name.toLowerCase().includes('google')
    );
    
    if (googleEnglishVoices.length === 0) {
        console.log('[TTS] No Google English voices available');
        showUnsupportedBrowserModal();
        return false;
    }
    
    // Try to select 'Google UK English Female' first (preferred, line 1304 pattern from Whisper)
    ttsVoice = googleEnglishVoices.find(v =>
        v.name === 'Google UK English Female' && v.lang === 'en-GB'
    );
    
    // Fall back to first Google English voice if preferred not found
    if (!ttsVoice) {
        ttsVoice = googleEnglishVoices[0];
    }
    
    console.log(`[TTS] Selected voice: ${ttsVoice.name} (${ttsVoice.lang})`);
    return true;
}

/**
 * Process the announcement queue
 */
function processAnnouncementQueue() {
    if (isProcessingQueue || announcementQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;
    const text = announcementQueue.shift();

    if (!ttsEnabled || !ttsVoice) {
        isProcessingQueue = false;
        announcementQueue = []; // Clear queue if TTS disabled
        return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = ttsRate;
    utterance.volume = 1.0;
    utterance.voice = ttsVoice;
    utterance.lang = 'en-US'; // Force English

    utterance.onstart = () => {
        isSpeaking = true;
    };

    utterance.onend = () => {
        isSpeaking = false;
        isProcessingQueue = false;
        // Process next item in queue
        if (announcementQueue.length > 0) {
            setTimeout(() => processAnnouncementQueue(), 100); // Small delay between announcements
        }
    };

    utterance.onerror = (event) => {
        console.error('[TTS] Error:', event.error);
        isSpeaking = false;
        isProcessingQueue = false;
        // Try to continue with queue despite error
        if (announcementQueue.length > 0) {
            setTimeout(() => processAnnouncementQueue(), 100);
        }
    };

    console.log(`[TTS] Speaking: "${text}" (${announcementQueue.length} remaining in queue)`);
    window.speechSynthesis.speak(utterance);
}

/**
 * Announce text using TTS with queue support
 * @param {string} text - Text to announce
 * @param {boolean} queue - If true, add to queue; if false, clear queue and announce immediately
 */
function announceChange(text, queue = false) {
    if (!ttsEnabled || !ttsVoice) {
        return;
    }

    if (queue) {
        // Add to queue
        announcementQueue.push(text);
        console.log(`[TTS] Queued: "${text}"`);
        processAnnouncementQueue();
    } else {
        // Clear queue and announce immediately
        window.speechSynthesis.cancel();
        announcementQueue = [text];
        isProcessingQueue = false;
        isSpeaking = false;
        processAnnouncementQueue();
    }
}

/**
 * Announce frequency change (with 1-second debounce)
 * Always announces in MHz format
 * @param {number} frequencyHz - Frequency in Hz
 */
function announceFrequencyChange(frequencyHz) {
    // Clear any pending announcement
    if (frequencyChangeTimer) {
        clearTimeout(frequencyChangeTimer);
    }
    
    // Wait 1 second for frequency to stabilize
    frequencyChangeTimer = setTimeout(() => {
        if (frequencyHz === lastAnnouncedFrequency) {
            return; // Already announced this frequency
        }
        
        lastAnnouncedFrequency = frequencyHz;
        
        // Convert to MHz and format, removing trailing zeros
        // e.g., 7100000 Hz = "7.1" MHz, 7100010 Hz = "7.10001" MHz
        let frequencyMHz = (frequencyHz / 1000000).toFixed(6); // Use 6 decimals for full precision
        frequencyMHz = parseFloat(frequencyMHz).toString(); // Remove trailing zeros

        const announcement = `${frequencyMHz} megahertz`;
        
        // Always queue frequency announcements
        // This ensures if mode was announced first, frequency follows naturally
        announceChange(announcement, true);
    }, 1000); // 1 second delay as requested
}

/**
 * Announce mode change (immediate, no debounce)
 * @param {string} mode - Mode name
 */
function announceModeChange(mode) {
    if (mode === lastAnnouncedMode) {
        return; // Already announced this mode
    }

    lastAnnouncedMode = mode;

    // Expand mode abbreviations for clarity
    const modeNames = {
        'usb': 'upper sideband',
        'lsb': 'lower sideband',
        'am': 'A M',
        'fm': 'F M',
        'nfm': 'narrow F M',
        'cw': 'C W',
        'cwu': 'C W upper',
        'cwl': 'C W lower'
    };

    const announcement = modeNames[mode.toLowerCase()] || mode;
    
    // Always queue mode announcements to work with frequency announcements
    // Mode changes happen immediately, frequency changes are debounced by 1 second
    // This ensures mode is announced first, then frequency follows
    announceChange(announcement, true);
}

/**
 * Toggle TTS on/off
 */
function toggleTTS() {
    if (!ttsEnabled) {
        // Try to initialize TTS
        if (!initializeTTS()) {
            return; // Initialization failed, modal already shown
        }
        ttsEnabled = true;
        console.log('[TTS] Enabled');

        // Update UI button immediately
        updateTTSButton();

        // Show notification using window.showNotification if available
        if (typeof window.showNotification === 'function') {
            window.showNotification('Text-to-Speech announcements enabled', 'success', 3000);
        } else {
            console.log('[TTS] Notification: TTS enabled');
        }

        // Speak the enabled message
        announceChange('Announcements enabled', false);
    } else {
        // Disable immediately for UI responsiveness
        ttsEnabled = false;

        // Update UI button immediately
        updateTTSButton();

        // Speak the disabled message before clearing
        const utterance = new SpeechSynthesisUtterance('Announcements disabled');
        utterance.rate = ttsRate;
        utterance.volume = 1.0;
        utterance.voice = ttsVoice;
        utterance.lang = 'en-US';

        utterance.onend = () => {
            // Clean up after speech completes
            window.speechSynthesis.cancel();
            announcementQueue = [];
            isProcessingQueue = false;
            isSpeaking = false;
        };

        window.speechSynthesis.speak(utterance);
        console.log('[TTS] Disabled');

        // Show notification using window.showNotification if available
        if (typeof window.showNotification === 'function') {
            window.showNotification('Text-to-Speech announcements disabled', 'info', 3000);
        } else {
            console.log('[TTS] Notification: TTS disabled');
        }
    }
}

/**
 * Update TTS button appearance
 */
function updateTTSButton() {
    const btn = document.getElementById('tts-announce-button');
    if (btn) {
        console.log('[TTS] Updating button, ttsEnabled:', ttsEnabled);
        if (ttsEnabled) {
            btn.classList.add('active');
            console.log('[TTS] Added active class, classList:', btn.classList.toString());
        } else {
            btn.classList.remove('active');
            console.log('[TTS] Removed active class, classList:', btn.classList.toString());
        }
    } else {
        console.error('[TTS] Button not found!');
    }
}

// Initialize voices when they become available
if (window.speechSynthesis) {
    // Voices may load asynchronously
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => {
            if (ttsEnabled && !ttsVoice) {
                initializeTTS();
            }
        };
    }
}

// Setup button click handler when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const ttsButton = document.getElementById('tts-announce-button');
    if (ttsButton) {
        ttsButton.addEventListener('click', toggleTTS);
        
        // Visually indicate if browser is not supported
        if (!isChromiumBrowser()) {
            ttsButton.style.opacity = '0.5';
            ttsButton.style.cursor = 'not-allowed';
            ttsButton.title = 'Text-to-Speech (Y key)\nRequires Chrome or Edge browser\nClick for more information';
        }
        
        console.log('[TTS] Button handler attached');
    }
});

// Expose functions globally for integration with app.js
window.ttsAnnouncements = {
    announceFrequencyChange,
    announceModeChange,
    toggleTTS,
    isEnabled: () => ttsEnabled
};

console.log('[TTS] TTS Announcements module loaded');
