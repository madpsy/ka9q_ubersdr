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

/**
 * Check if browser is Chrome or Edge (Chromium-based)
 * @returns {boolean} True if Chrome or Edge
 */
function isChromiumBrowser() {
    const userAgent = navigator.userAgent.toLowerCase();
    const isChrome = userAgent.includes('chrome') && !userAgent.includes('edg');
    const isEdge = userAgent.includes('edg');
    return isChrome || isEdge;
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
 * Announce text using TTS
 * @param {string} text - Text to announce
 */
function announceChange(text) {
    if (!ttsEnabled || !ttsVoice) {
        return;
    }
    
    // Cancel any pending speech
    window.speechSynthesis.cancel();
    
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
    };
    
    utterance.onerror = (event) => {
        console.error('[TTS] Error:', event.error);
        isSpeaking = false;
    };
    
    console.log(`[TTS] Speaking: "${text}"`);
    window.speechSynthesis.speak(utterance);
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
        
        // Convert to MHz and format (always 3 decimal places)
        const frequencyMHz = (frequencyHz / 1000000).toFixed(3);
        const announcement = `${frequencyMHz} megahertz`;
        
        announceChange(announcement);
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
    announceChange(announcement);
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
        if (typeof showNotification === 'function') {
            showNotification('Text-to-Speech announcements enabled', 'success', 3000);
        }
    } else {
        ttsEnabled = false;
        window.speechSynthesis.cancel();
        console.log('[TTS] Disabled');
        if (typeof showNotification === 'function') {
            showNotification('Text-to-Speech announcements disabled', 'info', 3000);
        }
    }
    
    // Update UI button
    updateTTSButton();
}

/**
 * Update TTS button appearance
 */
function updateTTSButton() {
    const btn = document.getElementById('tts-announce-button');
    if (btn) {
        if (ttsEnabled) {
            btn.classList.add('active');
            btn.style.backgroundColor = '#28a745'; // Green when active
            btn.style.color = 'white';
        } else {
            btn.classList.remove('active');
            btn.style.backgroundColor = '';
            btn.style.color = '';
        }
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
