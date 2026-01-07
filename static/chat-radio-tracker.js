/**
 * Chat Radio Tracker Extension
 * Tracks radio frequency/mode/bandwidth changes and updates chat
 * Works as a decoder extension to use the radioAPI event system
 */

class ChatRadioTracker extends DecoderExtension {
    constructor() {
        super('chat-tracker', {
            displayName: 'Chat Radio Tracker',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });
    }

    onInitialize() {
        console.log('[ChatRadioTracker] Initialized');
    }

    onEnable() {
        console.log('[ChatRadioTracker] Enabled - will track radio changes for chat');
    }

    onDisable() {
        console.log('[ChatRadioTracker] Disabled');
    }

    onProcessAudio(dataArray) {
        // Not needed for chat tracking
    }

    onFrequencyChanged(frequency) {
        console.log('[ChatRadioTracker] Frequency changed:', frequency);
        if (window.chatUI && window.chatUI.chat && window.chatUI.chat.isJoined()) {
            window.chatUI.chat.updateFrequency(frequency);
        }
    }

    onModeChanged(mode) {
        console.log('[ChatRadioTracker] Mode changed:', mode);
        if (window.chatUI && window.chatUI.chat && window.chatUI.chat.isJoined()) {
            window.chatUI.chat.updateMode(mode);
        }
    }

    onBandwidthChanged(low, high) {
        console.log('[ChatRadioTracker] Bandwidth changed - low:', low, 'high:', high);
        if (window.chatUI && window.chatUI.chat && window.chatUI.chat.isJoined()) {
            window.chatUI.chat.updateBandwidth(high, low);
        }
    }
}

// Register and auto-enable the extension when decoderManager is available
if (window.decoderManager) {
    const tracker = new ChatRadioTracker();
    window.decoderManager.register(tracker);
    
    // Auto-enable after a short delay to ensure chat UI is initialized
    setTimeout(() => {
        if (window.audioContext) {
            window.decoderManager.initialize('chat-tracker', window.audioContext, window.analyser, 0);
            window.decoderManager.enable('chat-tracker');
            console.log('✅ Chat Radio Tracker auto-enabled');
        } else {
            // Wait for audio context to be created
            const checkAudio = setInterval(() => {
                if (window.audioContext) {
                    clearInterval(checkAudio);
                    window.decoderManager.initialize('chat-tracker', window.audioContext, window.analyser, 0);
                    window.decoderManager.enable('chat-tracker');
                    console.log('✅ Chat Radio Tracker auto-enabled (delayed)');
                }
            }, 500);
        }
    }, 1000);
} else {
    console.error('❌ decoderManager not available - Chat Radio Tracker cannot be registered');
}
