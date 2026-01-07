/**
 * Chat Radio Tracker Extension
 * Tracks radio frequency/mode/bandwidth changes and updates chat
 * Uses polling to detect changes (same approach as stats extension)
 */

class ChatRadioTracker extends DecoderExtension {
    constructor() {
        super('chat-tracker', {
            displayName: 'Chat Radio Tracker',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        this.lastFrequency = null;
        this.lastMode = null;
        this.lastBwLow = null;
        this.lastBwHigh = null;
        this.lastZoomBW = null;
        this.pollInterval = null;
    }

    onInitialize() {
        console.log('[ChatRadioTracker] Initialized');
    }

    onEnable() {
        console.log('[ChatRadioTracker] Enabled - polling for radio changes');

        // Poll every 100ms to detect changes
        this.pollInterval = setInterval(() => {
            this.checkForChanges();
        }, 100);

        // Initial check
        this.checkForChanges();
    }

    onDisable() {
        console.log('[ChatRadioTracker] Disabled');
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    onProcessAudio(dataArray) {
        // Not needed for chat tracking
    }

    checkForChanges() {
        if (!window.chatUI || !window.chatUI.chat || !window.chatUI.chat.isJoined()) {
            return;
        }

        // Get current values
        const freqInput = document.getElementById('frequency');
        const currentFreq = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
        const currentMode = window.currentMode || 'usb';
        const currentBwLow = window.currentBandwidthLow || 0;
        const currentBwHigh = window.currentBandwidthHigh || 0;
        const currentZoomBW = (window.spectrumDisplay && window.spectrumDisplay.binBandwidth) ? window.spectrumDisplay.binBandwidth : 0;

        // Check for frequency change
        if (currentFreq !== this.lastFrequency && currentFreq > 0) {
            console.log('[ChatRadioTracker] Frequency changed:', this.lastFrequency, '→', currentFreq);
            this.lastFrequency = currentFreq;
            window.chatUI.chat.updateFrequency(currentFreq);
        }

        // Check for mode change
        if (currentMode !== this.lastMode) {
            console.log('[ChatRadioTracker] Mode changed:', this.lastMode, '→', currentMode);
            this.lastMode = currentMode;
            window.chatUI.chat.updateMode(currentMode);
        }

        // Check for bandwidth change
        if (currentBwLow !== this.lastBwLow || currentBwHigh !== this.lastBwHigh) {
            console.log('[ChatRadioTracker] Bandwidth changed - low:', this.lastBwLow, '→', currentBwLow, 'high:', this.lastBwHigh, '→', currentBwHigh);
            this.lastBwLow = currentBwLow;
            this.lastBwHigh = currentBwHigh;
            window.chatUI.chat.updateBandwidth(currentBwHigh, currentBwLow);
        }

        // Check for zoom change
        if (currentZoomBW !== this.lastZoomBW && currentZoomBW > 0) {
            console.log('[ChatRadioTracker] Zoom changed:', this.lastZoomBW, '→', currentZoomBW);
            this.lastZoomBW = currentZoomBW;
            // Trigger a full update which includes zoom_bw
            window.chatUI.chat.debouncedSendFrequencyMode();
        }
    }
}

// Register the extension but DO NOT auto-enable
// RadioAPI event system should handle all change detection
// This is kept only as a manual fallback for debugging
if (window.decoderManager) {
    const tracker = new ChatRadioTracker();
    window.decoderManager.register(tracker);
    console.log('[ChatRadioTracker] Registered (disabled - use radioAPI events instead)');
    console.log('[ChatRadioTracker] To manually enable for debugging: window.decoderManager.enable("chat-tracker")');
} else {
    console.error('❌ decoderManager not available - Chat Radio Tracker cannot be registered');
}
