/**
 * UberSDR Chat UI Component
 * Adds a collapsible chat panel to the main page
 * Requires: chat.js library
 */

class ChatUI {
    constructor(websocket) {
        this.chat = new UberSDRChat(websocket);
        this.isExpanded = false;
        this.unreadCount = 0;
        this.savedUsername = null;
        this.syncedUsername = null; // Track which user we're synced with
        this.syncZoom = false; // Track whether to sync zoom bandwidth
        this.radioEventHandlers = {}; // Store references to our radio event handlers
        this.errorTimeout = null; // Track error display timeout
        
        // Track last sent values to prevent duplicate sends
        this.lastSentFreq = null;
        this.lastSentMode = null;
        this.lastSentBwLow = null;
        this.lastSentBwHigh = null;
        this.lastSentZoomBW = null;
        this.lastSentCAT = null;
        this.lastSentTX = null;
        this.usersRequestPending = false; // Track if we're waiting for users list response
        this.usersRequestTimer = null; // Timer for retry
        this.isAutoRejoining = false; // Track if we're in the middle of auto-rejoin
        this.pendingMessage = null; // Store message that failed to send during auto-rejoin
        this.hasMentions = false; // Track if there are unread mentions
        this.isReceivingHistory = true; // Track if we're receiving initial message history
        this.tabCompletionIndex = -1; // Track current tab completion index
        this.tabCompletionMatches = []; // Store matching usernames for tab completion
        this.audioContext = null; // Web Audio API context for notification sounds
        this.soundsMuted = false; // Track if notification sounds are muted
        this.lastSeenMessageTime = 0; // Track last message timestamp we've seen

        // Load saved username and preferences from localStorage
        this.loadSavedUsername();
        this.loadSoundMutePreference();
        this.loadZoomSyncPreference();
        this.loadLastSeenMessageTime();

        this.createChatPanel();
        this.setupEventHandlers();
        this.setupChatEvents();
        // Don't call setupRadioTracking here - it will be called after delay in initializeChatUI

        // Request user count on page load (even if collapsed and not logged in)
        // This ensures the badge shows the correct count
        setTimeout(() => {
            this.requestActiveUsersWithRetry();
        }, 1500);

        // Auto-login if we have a saved username
        if (this.savedUsername) {
            setTimeout(() => {
                this.autoLogin();
            }, 1000); // Wait 1 second for WebSocket to be fully ready
        }
    }

    /**
     * Play a notification sound for @ mentions
     */
    playMentionSound() {
        // Don't play if muted
        if (this.soundsMuted) {
            return;
        }

        try {
            // Create audio context on first use (must be after user interaction)
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            const ctx = this.audioContext;
            const now = ctx.currentTime;

            // Create oscillator for the "ding" sound
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            // Configure the sound - a pleasant "ding" at 800Hz
            oscillator.frequency.setValueAtTime(800, now);
            oscillator.type = 'sine';

            // Envelope: quick attack, short sustain, quick decay
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01); // Attack
            gainNode.gain.linearRampToValueAtTime(0.2, now + 0.05); // Sustain
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3); // Decay

            // Play the sound
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } catch (e) {
            console.warn('[ChatUI] Failed to play mention sound:', e);
        }
    }

    /**
     * Toggle sound mute state
     */
    toggleSoundMute() {
        this.soundsMuted = !this.soundsMuted;

        // Update button appearance
        const muteBtn = document.getElementById('chat-mute-btn');
        if (muteBtn) {
            muteBtn.textContent = this.soundsMuted ? '🔇' : '🔊';
            muteBtn.title = this.soundsMuted ? 'Unmute notification sounds' : 'Mute notification sounds';
        }

        // Save preference to localStorage
        try {
            localStorage.setItem('ubersdr_chat_sounds_muted', this.soundsMuted.toString());
        } catch (e) {
            console.error('Failed to save mute preference:', e);
        }

        // Show feedback message
        this.addSystemMessage(this.soundsMuted ? 'Notification sounds muted' : 'Notification sounds enabled');
    }

    /**
     * Load sound mute preference from localStorage
     */
    loadSoundMutePreference() {
        try {
            const saved = localStorage.getItem('ubersdr_chat_sounds_muted');
            if (saved !== null) {
                this.soundsMuted = saved === 'true';
            }
        } catch (e) {
            console.error('Failed to load mute preference:', e);
        }
    }

    /**
     * Trigger pulse animation on user count badge
     */
    pulseUserCountBadge() {
        const badge = document.getElementById('chat-user-count-badge');
        if (badge && badge.style.display !== 'none') {
            // Add pulse class
            badge.classList.add('pulse');
            // Remove it after animation completes
            setTimeout(() => {
                badge.classList.remove('pulse');
            }, 600);
        }
    }

    /**
     * Load last seen message timestamp from localStorage
     */
    loadLastSeenMessageTime() {
        try {
            const saved = localStorage.getItem('ubersdr_chat_last_seen_message');
            if (saved !== null) {
                this.lastSeenMessageTime = parseInt(saved, 10) || 0;
            }
        } catch (e) {
            console.error('Failed to load last seen message time:', e);
        }
    }

    /**
     * Save last seen message timestamp to localStorage
     */
    saveLastSeenMessageTime(timestamp) {
        try {
            this.lastSeenMessageTime = timestamp;
            localStorage.setItem('ubersdr_chat_last_seen_message', timestamp.toString());
        } catch (e) {
            console.error('Failed to save last seen message time:', e);
        }
    }

    /**
     * Set up tracking of radio frequency/mode/bandwidth changes
     * Uses the existing radioAPI event system
     */
    setupRadioTracking() {
        console.log('[ChatUI] Setting up radio tracking via radioAPI...');

        if (!window.radioAPI) {
            console.error('[ChatUI] radioAPI not available, cannot track radio changes');
            return;
        }

        // Define event handlers and store references
        this.radioEventHandlers.frequency_changed = (data) => {
            console.log('[ChatUI] Frequency changed event:', data.frequency);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ frequency: data.frequency });

                // Send to server - server-side deduplication prevents loops
                this.chat.updateFrequency(data.frequency);
            }
        };

        this.radioEventHandlers.mode_changed = (data) => {
            console.log('[ChatUI] Mode changed event:', data.mode);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ mode: data.mode });

                // Send to server - server-side deduplication prevents loops
                this.chat.updateMode(data.mode);
            }
        };

        this.radioEventHandlers.bandwidth_changed = (data) => {
            console.log('[ChatUI] Bandwidth changed event - low:', data.low, 'high:', data.high);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ bw_low: data.low, bw_high: data.high });

                // Send to server - server-side deduplication prevents loops
                this.chat.updateBandwidth(data.high, data.low);
            }
        };

        this.radioEventHandlers.zoom_changed = (data) => {
            console.log('[ChatUI] Zoom changed event - binBandwidth:', data.binBandwidth);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ zoom_bw: data.binBandwidth });

                // Send to server - server-side deduplication prevents loops
                this.chat.debouncedSendFrequencyMode();
            }
        };

        // Subscribe to events
        window.radioAPI.on('frequency_changed', this.radioEventHandlers.frequency_changed);
        window.radioAPI.on('mode_changed', this.radioEventHandlers.mode_changed);
        window.radioAPI.on('bandwidth_changed', this.radioEventHandlers.bandwidth_changed);
        window.radioAPI.on('zoom_changed', this.radioEventHandlers.zoom_changed);

        // Periodically verify event listeners are still registered (every 5 seconds)
        // This fixes the issue where listeners mysteriously disappear
        this.radioTrackingInterval = setInterval(() => {
            if (!window.radioAPI) return;

            // Check if our handlers are still in the callbacks map
            const events = ['frequency_changed', 'mode_changed', 'bandwidth_changed', 'zoom_changed'];
            let needsReregistration = false;

            for (const event of events) {
                const callbacks = window.radioAPI.callbacks.get(event);
                if (!callbacks || !callbacks.includes(this.radioEventHandlers[event])) {
                    console.warn(`[ChatUI] Event listener for '${event}' was lost, re-registering...`);
                    needsReregistration = true;
                    break;
                }
            }

            if (needsReregistration) {
                // Re-register all handlers
                console.log('[ChatUI] Re-registering radio event listeners');
                window.radioAPI.on('frequency_changed', this.radioEventHandlers.frequency_changed);
                window.radioAPI.on('mode_changed', this.radioEventHandlers.mode_changed);
                window.radioAPI.on('bandwidth_changed', this.radioEventHandlers.bandwidth_changed);
                window.radioAPI.on('zoom_changed', this.radioEventHandlers.zoom_changed);
            }
        }, 5000);

        console.log('[ChatUI] Radio tracking setup complete via radioAPI events');
    }

    /**
     * Update radio settings in chat (debounced)
     * Called whenever frequency, mode, or bandwidth changes
     */
    updateRadioSettings() {
        console.log('[ChatUI] updateRadioSettings called, isJoined:', this.chat ? this.chat.isJoined() : 'no chat');

        if (!this.chat || !this.chat.isJoined()) {
            console.log('[ChatUI] Not joined to chat, skipping update');
            return; // Not joined to chat, skip update
        }

        // Get current values from app.js globals
        const freqInput = document.getElementById('frequency');
        const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
        const mode = window.currentMode || 'usb';
        const bwLow = window.currentBandwidthLow || 0;
        const bwHigh = window.currentBandwidthHigh || 0;

        console.log('[ChatUI] Current values - freq:', frequency, 'mode:', mode, 'bwLow:', bwLow, 'bwHigh:', bwHigh);

        // Update frequency
        if (frequency && !isNaN(frequency)) {
            console.log('[ChatUI] Updating frequency:', frequency);
            this.chat.updateFrequency(frequency);
        }

        // Update mode
        if (mode) {
            console.log('[ChatUI] Updating mode:', mode);
            this.chat.updateMode(mode);
        }

        // Update bandwidth
        if (bwLow !== undefined && bwHigh !== undefined) {
            console.log('[ChatUI] Updating bandwidth - high:', bwHigh, 'low:', bwLow);
            this.chat.updateBandwidth(bwHigh, bwLow);
        }
    }

    /**
     * Load saved username from localStorage
     */
    loadSavedUsername() {
        try {
            this.savedUsername = localStorage.getItem('ubersdr_chat_username');
        } catch (e) {
            console.error('Failed to load saved username:', e);
        }
    }

    /**
     * Save username to localStorage
     */
    saveUsername(username) {
        try {
            localStorage.setItem('ubersdr_chat_username', username);
            this.savedUsername = username;
        } catch (e) {
            console.error('Failed to save username:', e);
        }
    }

    /**
     * Clear saved username from localStorage
     */
    clearSavedUsername() {
        try {
            localStorage.removeItem('ubersdr_chat_username');
            this.savedUsername = null;
        } catch (e) {
            console.error('Failed to clear saved username:', e);
        }
    }

    /**
     * Auto-login with saved username
     */
    autoLogin() {
        if (this.savedUsername && this.chat) {
            console.log('Auto-logging in as:', this.savedUsername);
            this.chat.setUsername(this.savedUsername);
        }
    }

    /**
     * Create the chat panel HTML and inject into page
     */
    createChatPanel() {
        // Load saved state from localStorage
        const savedState = localStorage.getItem('ubersdr_chat_expanded');
        this.isExpanded = savedState === 'true';

        // Generate random username placeholder: user<4 random digits>
        const randomUsername = 'user' + Math.floor(1000 + Math.random() * 9000);

        const chatHTML = `
            <div id="chat-panel" class="chat-panel ${this.isExpanded ? 'expanded' : 'collapsed'}">
                <!-- Chat content (slides out from right) -->
                <div id="chat-content" class="chat-content" style="display:${this.isExpanded ? 'flex' : 'none'};">
                    <!-- Single unified chat interface -->
                    <div id="chat-interface" class="chat-interface">
                        <div class="chat-main-area">
                            <!-- Messages area -->
                            <div id="chat-messages" class="chat-messages"></div>

                            <!-- Username input (shown when not logged in) -->
                            <div id="chat-username-input-area" class="chat-input-area">
                                <div style="position: relative; flex: 1;">
                                    <input type="text" id="chat-username-input"
                                           placeholder="Choose a username..."
                                           value="${randomUsername}"
                                           maxlength="15"
                                           class="chat-input"
                                           style="padding-right: 30px;">
                                    <span id="chat-username-validation" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 14px; display: none;"></span>
                                </div>
                                <button id="chat-join-btn" class="chat-btn chat-btn-primary" disabled style="opacity: 0.5; cursor: not-allowed;">Join</button>
                            </div>

                            <!-- Message input (shown when logged in) -->
                            <div id="chat-message-input-area" class="chat-input-area" style="display:none;">
                                <div style="position: relative; flex: 1;">
                                    <input type="text" id="chat-message-input"
                                           placeholder="Type message..."
                                           maxlength="250"
                                           class="chat-input"
                                           style="padding-right: 30px;">
                                    <span id="chat-emoji-btn" class="chat-emoji-btn" onclick="chatUI.toggleEmojiPicker()" title="Insert emoji">😊</span>
                                    <div id="chat-emoji-picker" class="chat-emoji-picker" style="display:none;"></div>
                                    <div id="chat-mention-suggestions" class="chat-mention-suggestions" style="display:none;"></div>
                                </div>
                                <button id="chat-send-btn" class="chat-btn chat-btn-primary">Send</button>
                            </div>
                        </div>

                        <!-- Active users sidebar -->
                        <div class="chat-users-sidebar">
                            <div class="chat-users-header">
                                <span>👥 Users (<span id="chat-user-count">0</span>)</span>
                            </div>
                            <div id="chat-users-list" class="chat-users-list"></div>
                            <div class="chat-users-footer">
                                <button id="chat-mute-btn" class="chat-btn chat-btn-mute" onclick="chatUI.toggleSoundMute()" title="Mute notification sounds" style="display:none;">🔊</button>
                                <button id="chat-zoom-btn" class="chat-btn chat-btn-mute" onclick="chatUI.toggleZoomSync()" title="Sync zoom level" style="display:none;">🔍</button>
                                <button id="chat-leave-btn" class="chat-btn chat-btn-danger" style="display:none;">Leave</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Chat tab (always visible, on right edge) -->
                <div id="chat-header" class="chat-header" onclick="chatUI.togglePanel()">
                    <span>💬</span>
                    <span id="chat-collapse-arrow" class="chat-collapse-arrow" style="display:none;">→</span>
                    <span id="chat-mention" class="chat-mention" style="display:none;">❗</span>
                    <span id="chat-unread" class="chat-unread" style="display:none;"></span>
                    <span id="chat-user-count-badge" class="chat-user-count-badge" style="display:none;">0</span>
                </div>
            </div>

            <!-- Leave Chat Confirmation Modal -->
            <div id="chat-leave-modal" class="chat-modal" style="display:none;">
                <div class="chat-modal-content">
                    <h3>Leave Chat?</h3>
                    <p>Are you sure you want to leave the chat?</p>
                    <div class="chat-modal-buttons">
                        <button class="chat-btn chat-btn-secondary" onclick="chatUI.hideLeaveChatModal()">Cancel</button>
                        <button class="chat-btn chat-btn-danger" onclick="chatUI.confirmLeaveChat()">Leave</button>
                    </div>
                </div>
            </div>
        `;

        // Inject CSS
        this.injectCSS();

        // Inject HTML before audio buffer display
        const audioBuffer = document.getElementById('audio-buffer-display');
        if (audioBuffer && audioBuffer.parentNode) {
            audioBuffer.insertAdjacentHTML('beforebegin', chatHTML);
        } else {
            // Fallback: append to body
            document.body.insertAdjacentHTML('beforeend', chatHTML);
        }

        // Restore saved state
        const content = document.getElementById('chat-content');
        if (this.isExpanded) {
            content.style.display = 'flex';
            // Show collapse arrow if expanded on load
            const arrow = document.getElementById('chat-collapse-arrow');
            if (arrow) {
                arrow.style.display = 'block';
            }
            // Request users if panel is already expanded on load
            setTimeout(() => {
                this.requestActiveUsersWithRetry();
            }, 1000);
        }
    }

    /**
     * Inject CSS styles for chat panel
     */
    injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .chat-panel {
                position: fixed;
                bottom: 50px;
                right: 0;
                z-index: 900;
                font-family: Arial, sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                transition: all 0.3s ease;
            }

            .chat-panel.collapsed {
                width: 40px;
            }

            .chat-panel.expanded {
                width: min(540px, 100vw);
                max-width: 100vw;
            }

            .chat-header {
                width: 40px;
                height: 100px;
                padding: 8px 0;
                background: rgba(50, 50, 50, 0.7);
                color: #fff;
                cursor: pointer;
                user-select: none;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                font-size: 20px;
                border: 1px solid rgba(100, 100, 100, 0.5);
                border-right: none;
                border-radius: 8px 0 0 8px;
                order: 2;
                flex-shrink: 0;
                position: relative;
                overflow: visible;
            }

            .chat-header:hover {
                background: rgba(70, 70, 70, 0.6);
            }

            .chat-mention {
                position: absolute;
                top: 5px;
                left: 0;
                right: 0;
                text-align: center;
                font-size: 16px;
                animation: pulse 1s ease-in-out infinite;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.7; transform: scale(1.1); }
            }

            .chat-unread {
                background: #dc3545;
                color: #fff;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 11px;
                font-weight: bold;
            }

            .chat-collapse-arrow {
                position: absolute;
                bottom: 8px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 20px;
                color: #fff;
                font-weight: bold;
                z-index: 10;
                pointer-events: none;
            }

            .chat-user-count-badge {
                position: absolute;
                bottom: 5px;
                left: 0;
                right: 0;
                text-align: center;
                background: #fff;
                color: #000;
                border-radius: 50%;
                width: 20px;
                height: 20px;
                line-height: 20px;
                font-size: 10px;
                font-weight: bold;
                margin: 0 auto;
                transition: all 0.3s ease;
            }

            .chat-user-count-badge.pulse {
                animation: badge-pulse 0.6s ease-out;
            }

            @keyframes badge-pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.3); background: #4a9eff; }
                100% { transform: scale(1); }
            }

            .chat-toggle-icon {
                font-size: 12px;
            }

            .chat-content {
                width: min(500px, calc(100vw - 40px));
                max-width: 100%;
                height: 500px;
                background: rgba(40, 40, 40, 0.7);
                border: 1px solid rgba(100, 100, 100, 0.6);
                border-right: none;
                border-radius: 8px 0 0 8px;
                order: 1;
                flex-shrink: 0;
            }

            .chat-username-setup {
                padding: 12px;
                width: 100%;
                box-sizing: border-box;
            }

            .chat-interface {
                display: flex;
                flex-direction: row;
                height: 100%;
            }

            .chat-main-area {
                width: 350px;
                display: flex;
                flex-direction: column;
                flex-shrink: 0;
            }

            .chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
                background: rgba(30, 30, 30, 0.6);
                color: #ddd;
                font-size: 12px;
            }

            .chat-message {
                margin: 4px 0;
                padding: 3px;
                word-wrap: break-word;
            }

            .chat-message-mention {
                background: rgba(255, 193, 7, 0.2);
                border-left: 3px solid #ffc107;
                padding-left: 6px;
                margin-left: -3px;
            }

            .chat-message-username {
                font-weight: bold;
                color: #4a9eff;
                cursor: pointer;
            }

            .chat-message-username.own-message {
                color: #ff9f40;
            }

            .chat-message-username:hover {
                text-decoration: underline;
            }

            .chat-message-system {
                color: #999;
                font-style: italic;
                font-size: 11px;
            }

            .chat-message-error {
                color: #ff6b6b;
                font-weight: bold;
            }

            .chat-input-area {
                padding: 8px;
                background: #2a2a2a;
                display: flex;
                gap: 4px;
                flex-shrink: 0;
            }

            .chat-input {
                width: 100%;
                padding: 6px 8px;
                background: #1a1a1a;
                border: 1px solid #555;
                color: #fff;
                border-radius: 4px;
                font-size: 12px;
            }

            .chat-input:focus {
                outline: none;
                border-color: #4a9eff;
            }

            .chat-emoji-btn {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 16px;
                cursor: pointer;
                user-select: none;
                opacity: 0.6;
                transition: opacity 0.2s;
            }

            .chat-emoji-btn:hover {
                opacity: 1;
            }

            .chat-emoji-picker {
                position: absolute;
                bottom: 100%;
                right: 0;
                background: #2a2a2a;
                border: 1px solid #4a9eff;
                border-radius: 8px;
                padding: 8px;
                margin-bottom: 4px;
                display: grid;
                grid-template-columns: repeat(8, 1fr);
                gap: 4px;
                z-index: 1001;
                box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            }

            .chat-emoji-picker span {
                font-size: 20px;
                cursor: pointer;
                padding: 4px;
                border-radius: 4px;
                transition: background 0.2s;
                text-align: center;
            }

            .chat-emoji-picker span:hover {
                background: #4a9eff;
            }

            .chat-mention-suggestions {
                position: absolute;
                bottom: 100%;
                left: 0;
                right: 0;
                background: #2a2a2a;
                border: 1px solid #4a9eff;
                border-radius: 4px 4px 0 0;
                max-height: 150px;
                overflow-y: auto;
                z-index: 1000;
                margin-bottom: 2px;
            }

            .chat-mention-suggestion-item {
                padding: 6px 8px;
                cursor: pointer;
                color: #ddd;
                font-size: 12px;
            }

            .chat-mention-suggestion-item:hover,
            .chat-mention-suggestion-item.selected {
                background: #4a9eff;
                color: #fff;
            }

            .chat-btn {
                padding: 6px 12px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: bold;
            }

            .chat-btn-primary {
                background: #4a9eff;
                color: #fff;
            }

            .chat-btn-primary:hover {
                background: #3a8eef;
            }

            .chat-btn.chat-btn-danger {
                background: #ff9800 !important;
                color: #fff !important;
            }

            .chat-btn.chat-btn-danger:hover {
                background: #e68900 !important;
            }

            .chat-error {
                color: #ff6b6b;
                font-size: 11px;
                margin-top: 6px;
                min-height: 16px;
            }

            .chat-users-sidebar {
                width: 150px;
                display: flex;
                flex-direction: column;
                background: transparent;
                border-left: 1px solid rgba(100, 100, 100, 0.4);
            }

            .chat-users-header {
                padding: 6px 8px;
                background: #2a2a2a;
                color: #aaa;
                user-select: none;
                border-bottom: 1px solid #444;
                font-size: 11px;
                text-align: center;
                flex-shrink: 0;
            }

            .chat-users-list {
                flex: 1;
                padding: 8px;
                background: rgba(30, 30, 30, 0.6);
                color: #aaa;
                font-size: 11px;
                overflow-y: auto;
                min-height: 0;
            }

            .chat-users-footer {
                padding: 8px;
                background: #2a2a2a;
                border-top: 1px solid #444;
                flex-shrink: 0;
                display: flex;
                gap: 4px;
            }

            .chat-btn-mute {
                background: #555;
                color: #fff;
                padding: 6px 8px;
                font-size: 14px;
                flex: 0 0 auto;
            }

            .chat-btn-mute:hover {
                background: #666;
            }

            .chat-btn-mute.active {
                background: #dc3545;
                color: #fff;
            }

            #chat-zoom-btn {
                background: #28a745;
                color: #fff;
            }

            #chat-zoom-btn:hover {
                background: #218838;
            }

            #chat-zoom-btn.active {
                background: #dc3545;
                color: #fff;
            }

            #chat-zoom-btn.active:hover {
                background: #c82333;
            }

            .chat-btn-danger {
                flex: 1;
            }

            .chat-user-item {
                padding: 6px 4px;
                margin-bottom: 6px;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                border-bottom: 1px solid #333;
            }

            .chat-user-item:last-child {
                border-bottom: none;
            }

            .chat-user-muted {
                opacity: 0.5;
                text-decoration: line-through;
            }

            .chat-sync-btn {
                padding: 2px 4px !important;
                font-size: 9px !important;
                border: 1px solid #4a9eff !important;
                background: transparent !important;
                color: #4a9eff !important;
                border-radius: 3px !important;
                cursor: pointer !important;
                user-select: none !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
            }

            .chat-sync-btn:hover {
                background: rgba(74, 158, 255, 0.1) !important;
            }

            .chat-sync-btn.active {
                background: #4a9eff !important;
                color: #fff !important;
                border-color: #4a9eff !important;
            }

            /* Mobile responsive styles */
            @media (max-width: 768px) {
                .chat-panel.expanded {
                    width: 100vw;
                    right: 0;
                }

                .chat-content {
                    width: calc(100vw - 40px);
                    height: 400px;
                }

                .chat-main-area {
                    width: 60%;
                    min-width: 200px;
                }

                .chat-users-sidebar {
                    width: 40%;
                    min-width: 120px;
                }

                .chat-input {
                    font-size: 16px; /* Prevents zoom on iOS */
                }

                .chat-messages {
                    font-size: 11px;
                }

                .chat-user-item {
                    padding: 4px 2px;
                    margin-bottom: 4px;
                }
            }

            /* Very small screens */
            @media (max-width: 480px) {
                .chat-content {
                    height: 350px;
                }

                .chat-main-area {
                    width: 65%;
                }

                .chat-users-sidebar {
                    width: 35%;
                }

                .chat-messages {
                    font-size: 10px;
                    padding: 6px;
                }

                .chat-input-area {
                    padding: 6px;
                }

                .chat-btn {
                    padding: 5px 8px;
                    font-size: 11px;
                }
            }

            /* Leave Chat Modal */
            .chat-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }

            .chat-modal-content {
                background: #2a2a2a;
                border: 1px solid #4a9eff;
                border-radius: 8px;
                padding: 20px;
                min-width: 300px;
                max-width: 400px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            }

            .chat-modal-content h3 {
                margin: 0 0 12px 0;
                color: #fff;
                font-size: 18px;
            }

            .chat-modal-content p {
                margin: 0 0 20px 0;
                color: #ddd;
                font-size: 14px;
            }

            .chat-modal-buttons {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
            }

            .chat-btn-secondary {
                background: #555;
                color: #fff;
            }

            .chat-btn-secondary:hover {
                background: #666;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Set up DOM event handlers
     */
    setupEventHandlers() {
        // Username input validation
        const usernameInput = document.getElementById('chat-username-input');
        const validationIndicator = document.getElementById('chat-username-validation');
        const joinBtn = document.getElementById('chat-join-btn');

        const validateUsername = (e) => {
            const value = e.target.value;
            // Allow alphanumeric, hyphens, underscores, forward slashes
            const cleaned = value.replace(/[^A-Za-z0-9\-_\/]/g, '');
            if (value !== cleaned) {
                e.target.value = cleaned;
            }

            // Show/hide validation indicator and update button state
            if (cleaned.length === 0) {
                // Empty - hide indicator
                validationIndicator.style.display = 'none';
                joinBtn.disabled = true;
                joinBtn.style.opacity = '0.5';
                joinBtn.style.cursor = 'not-allowed';
            } else {
                // Has content - show indicator
                validationIndicator.style.display = 'block';
                const isLengthValid = cleaned.length >= 1 && cleaned.length <= 15;

                // Check if starts or ends with special characters
                const startsWithSpecial = /^[-_\/]/.test(cleaned);
                const endsWithSpecial = /[-_\/]$/.test(cleaned);

                // Check if username is already taken (case-insensitive)
                const isTaken = this.chat.activeUsers.some(u =>
                    u.username.toLowerCase() === cleaned.toLowerCase()
                );

                if (!isLengthValid) {
                    // Invalid length - red cross
                    validationIndicator.textContent = '✗';
                    validationIndicator.style.color = '#f87171';
                    validationIndicator.title = 'Username must be 1-15 characters';
                    joinBtn.disabled = true;
                    joinBtn.style.opacity = '0.5';
                    joinBtn.style.cursor = 'not-allowed';
                } else if (startsWithSpecial || endsWithSpecial) {
                    // Starts or ends with special character - red cross
                    validationIndicator.textContent = '✗';
                    validationIndicator.style.color = '#f87171';
                    validationIndicator.title = 'Username cannot start or end with - _ /';
                    joinBtn.disabled = true;
                    joinBtn.style.opacity = '0.5';
                    joinBtn.style.cursor = 'not-allowed';
                } else if (isTaken) {
                    // Username taken - red cross
                    validationIndicator.textContent = '✗';
                    validationIndicator.style.color = '#f87171';
                    validationIndicator.title = 'Username already in use';
                    joinBtn.disabled = true;
                    joinBtn.style.opacity = '0.5';
                    joinBtn.style.cursor = 'not-allowed';
                } else {
                    // Valid and available - green checkmark
                    validationIndicator.textContent = '✓';
                    validationIndicator.style.color = '#4ade80';
                    validationIndicator.title = 'Username available';
                    joinBtn.disabled = false;
                    joinBtn.style.opacity = '1';
                    joinBtn.style.cursor = 'pointer';
                }
            }
        };

        usernameInput.addEventListener('input', validateUsername);

        // Trigger validation immediately if there's a pre-filled value
        if (usernameInput.value) {
            validateUsername({ target: usernameInput });
            // Set cursor to end of pre-filled username
            usernameInput.setSelectionRange(usernameInput.value.length, usernameInput.value.length);
        }

        // Join button
        joinBtn.addEventListener('click', () => {
            const username = usernameInput.value.trim();
            // Allow alphanumeric plus hyphens, underscores, forward slashes (not at start/end)
            // Pattern: single alphanumeric char OR alphanumeric at start and end with anything in middle
            if (username.length >= 1 && username.length <= 15 &&
                /^[A-Za-z0-9]([A-Za-z0-9\-_\/]*[A-Za-z0-9])?$/.test(username)) {
                this.chat.setUsername(username);
            }
        });

        // Send button
        const sendBtn = document.getElementById('chat-send-btn');
        sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        // Message input - show mention suggestions as they type and update send button state
        const messageInput = document.getElementById('chat-message-input');
        messageInput.addEventListener('input', (e) => {
            this.updateMentionSuggestions();
            // Update send button state based on input content
            const hasContent = e.target.value.trim().length > 0;
            sendBtn.disabled = !hasContent;
            sendBtn.style.opacity = hasContent ? '1' : '0.5';
            sendBtn.style.cursor = hasContent ? 'pointer' : 'not-allowed';
        });

        // Initialize send button as disabled (no message on load)
        sendBtn.disabled = true;
        sendBtn.style.opacity = '0.5';
        sendBtn.style.cursor = 'not-allowed';

        // Leave button
        document.getElementById('chat-leave-btn').addEventListener('click', () => {
            this.leaveChat();
        });

        // Enter key in username input
        document.getElementById('chat-username-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('chat-join-btn').click();
            }
        });

        // Enter key and tab completion in message input
        document.getElementById('chat-message-input').addEventListener('keydown', (e) => {
            const suggestionsDiv = document.getElementById('chat-mention-suggestions');
            const hasSuggestions = suggestionsDiv.style.display !== 'none';

            if (e.key === 'Enter') {
                e.preventDefault();
                // If suggestions are showing, complete with selected suggestion
                if (hasSuggestions && this.tabCompletionIndex >= 0) {
                    this.completeMention();
                } else {
                    // Only send if there's content
                    const messageInput = document.getElementById('chat-message-input');
                    if (messageInput && messageInput.value.trim().length > 0) {
                        this.sendMessage();
                    }
                }
                // Reset tab completion
                this.tabCompletionIndex = -1;
                this.tabCompletionMatches = [];
                this.hideMentionSuggestions();
                // Refocus after a short delay to ensure message is sent first
                setTimeout(() => {
                    document.getElementById('chat-message-input').focus();
                }, 10);
            } else if (e.key === 'Tab') {
                e.preventDefault();
                if (hasSuggestions && this.tabCompletionMatches.length > 0) {
                    this.completeMention();
                }
            } else if (e.key === 'ArrowDown' && hasSuggestions) {
                e.preventDefault();
                this.tabCompletionIndex = Math.min(this.tabCompletionIndex + 1, this.tabCompletionMatches.length - 1);
                this.updateMentionSuggestions();
            } else if (e.key === 'ArrowUp' && hasSuggestions) {
                e.preventDefault();
                this.tabCompletionIndex = Math.max(this.tabCompletionIndex - 1, 0);
                this.updateMentionSuggestions();
            } else if (e.key === 'Escape' && hasSuggestions) {
                e.preventDefault();
                this.hideMentionSuggestions();
            }
        });
    }

    /**
     * Set up chat event handlers
     */
    setupChatEvents() {
        this.chat.on('message', (data) => {
            // Check if this message mentions us (only for new messages, not history)
            const isMention = !this.isReceivingHistory &&
                              this.chat.username &&
                              data.message.toLowerCase().includes('@' + this.chat.username.toLowerCase());

            this.addChatMessage(data.username, data.message, data.timestamp, isMention);

            // Only count as unread if:
            // 1. Panel is collapsed
            // 2. Message is newer than last seen time
            const messageTime = new Date(data.timestamp).getTime();
            if (!this.isExpanded && messageTime > this.lastSeenMessageTime) {
                this.incrementUnread(isMention);
            }

            // Play sound if we were mentioned (and it's a new message)
            if (isMention && messageTime > this.lastSeenMessageTime) {
                this.playMentionSound();
            }
        });

        this.chat.on('join_confirmed', (data) => {
            // Check if this was an auto-rejoin (UI already shows message input)
            const wasAutoRejoin = this.isAutoRejoining;

            // Clear auto-rejoining flag on successful join
            this.isAutoRejoining = false;

            // After a short delay, mark that we're done receiving history
            // This allows the initial 50 messages to load without triggering mention notifications
            setTimeout(() => {
                this.isReceivingHistory = false;
                console.log('[ChatUI] Now tracking new messages for mentions');
            }, 1000);

            // Save username for auto-login next time
            this.saveUsername(data.username);

            // Only switch UI if this wasn't an auto-rejoin
            if (!wasAutoRejoin) {
                // Switch from username input to message input
                document.getElementById('chat-username-input-area').style.display = 'none';
                document.getElementById('chat-message-input-area').style.display = 'flex';
                document.getElementById('chat-leave-btn').style.display = 'block';
                document.getElementById('chat-mute-btn').style.display = 'block';
                document.getElementById('chat-zoom-btn').style.display = 'block';

                // Update mute button to reflect current state
                const muteBtn = document.getElementById('chat-mute-btn');
                if (muteBtn) {
                    muteBtn.textContent = this.soundsMuted ? '🔇' : '🔊';
                    muteBtn.title = this.soundsMuted ? 'Unmute notification sounds' : 'Mute notification sounds';
                }

                // Update zoom button to reflect current state
                const zoomBtn = document.getElementById('chat-zoom-btn');
                if (zoomBtn) {
                    if (this.syncZoom) {
                        zoomBtn.classList.add('active');
                    } else {
                        zoomBtn.classList.remove('active');
                    }
                    zoomBtn.title = this.syncZoom ? 'Disable zoom sync' : 'Enable zoom sync';
                }

                this.addSystemMessage(`You joined as ${data.username}`);

                // Focus the message input after a short delay to ensure UI is updated
                setTimeout(() => {
                    const messageInput = document.getElementById('chat-message-input');
                    if (messageInput) {
                        messageInput.focus();
                    }
                }, 100);
            } else {
                // Auto-rejoin succeeded - just log it
                console.log('[ChatUI] Auto-rejoin successful as:', data.username);

                // Send any pending message that failed before rejoin
                if (this.pendingMessage) {
                    console.log('[ChatUI] Sending pending message after auto-rejoin:', this.pendingMessage);
                    const messageToSend = this.pendingMessage;
                    this.pendingMessage = null; // Clear before sending to avoid loops

                    // Send after a short delay to ensure join is fully processed
                    setTimeout(() => {
                        if (this.chat.sendMessage(messageToSend)) {
                            // Message sent successfully - clear the input field
                            const messageInput = document.getElementById('chat-message-input');
                            if (messageInput) {
                                messageInput.value = '';
                            }
                        }
                    }, 100);
                }
            }

            // Send initial frequency/mode/bandwidth on join (immediate, no debounce)
            const freqInput = document.getElementById('frequency');
            const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : 0;
            const mode = window.currentMode || 'usb';
            const bwLow = window.currentBandwidthLow || 0;
            const bwHigh = window.currentBandwidthHigh || 0;
            const zoomBW = (window.spectrumDisplay && window.spectrumDisplay.binBandwidth) ? window.spectrumDisplay.binBandwidth : 0;

            if (frequency && mode) {
                console.log('[ChatUI] Sending initial radio settings on join - freq:', frequency, 'mode:', mode, 'zoom_bw:', zoomBW);
                this.chat.setFrequencyAndMode(frequency, mode, bwHigh, bwLow, zoomBW);

                // Wait a moment for server to process, then request active users
                // This ensures our frequency/mode is included in the response
                setTimeout(() => {
                    this.requestActiveUsersWithRetry();
                }, 100);
            } else {
                // No frequency/mode to send, request users immediately
                this.requestActiveUsersWithRetry();
            }
        });

        this.chat.on('user_joined', (data) => {
            this.addSystemMessage(`${data.username} joined`);
            // Add new user to local list (they may not have radio data yet)
            if (!this.chat.activeUsers.find(u => u.username === data.username)) {
                this.chat.activeUsers.push({
                    username: data.username
                });
                this.updateActiveUsers({
                    users: this.chat.activeUsers,
                    count: this.chat.activeUsers.length
                });
                // Pulse the user count badge when someone joins
                this.pulseUserCountBadge();
            }
        });

        this.chat.on('user_left', (data) => {
            this.addSystemMessage(`${data.username} left`);
            // Remove user from local list
            const userIndex = this.chat.activeUsers.findIndex(u => u.username === data.username);
            if (userIndex >= 0) {
                this.chat.activeUsers.splice(userIndex, 1);
                this.updateActiveUsers({
                    users: this.chat.activeUsers,
                    count: this.chat.activeUsers.length
                });
            }
        });

        this.chat.on('active_users', (data) => {
            // Clear pending request flag and timer since we got a response
            this.usersRequestPending = false;
            if (this.usersRequestTimer) {
                clearTimeout(this.usersRequestTimer);
                this.usersRequestTimer = null;
            }
            this.updateActiveUsers(data);
        });

        this.chat.on('user_update', (data) => {
            this.updateSingleUser(data);
            // If this is the user we're synced with, update our radio
            // Server-side deduplication prevents loops, no need for isSyncing flag
            if (this.syncedUsername === data.username) {
                // Get the full user data from activeUsers to ensure we have all fields
                const fullUserData = this.chat.activeUsers.find(u => u.username === data.username);
                if (fullUserData) {
                    this.syncToUser(fullUserData);
                } else {
                    // Fallback to partial data if full data not available
                    this.syncToUser(data);
                }
            }
        });

        this.chat.on('idle_updates', (data) => {
            // Bulk update of idle times for all idle users
            if (data.users && Array.isArray(data.users)) {
                data.users.forEach(idleUser => {
                    const user = this.chat.activeUsers.find(u => u.username === idleUser.username);
                    if (user) {
                        user.is_idle = idleUser.is_idle;
                        user.idle_minutes = idleUser.idle_minutes;
                    }
                });
                // Refresh the display with updated idle times
                this.updateActiveUsers({
                    users: this.chat.activeUsers,
                    count: this.chat.activeUsers.length
                });
            }
        });

        this.chat.on('error', (error) => {
            // Show errors in the UI so users know what went wrong
            console.warn('[ChatUI] Chat error:', error);

            // Suppress rate limit errors - just log them
            if (error.includes('rate limit exceeded')) {
                console.log('[ChatUI] Rate limit hit, suppressing error message');
                return;
            }

            // Suppress "must subscribe to chat first" errors - these happen during re-subscription
            // and are handled automatically by the retry logic
            if (error.includes('must subscribe to chat first')) {
                console.log('[ChatUI] Subscription in progress, suppressing error message');
                return;
            }

            // If we're auto-rejoining and get an error, it means rejoin failed
            if (this.isAutoRejoining) {
                console.log('[ChatUI] Auto-rejoin failed with error:', error);
                this.isAutoRejoining = false;
                // Clear saved username since it's not working
                this.clearSavedUsername();
                // Reset UI to username input view
                this.resetToUsernameInput();
                // Show the error to user
                this.showError('Auto-rejoin failed: ' + error);
                return;
            }

            // If server says username not set but we think we have one, re-join automatically
            // This handles WebSocket reconnections and server restarts gracefully
            if (error === 'username not set' && this.savedUsername && this.chat) {
                console.log('[ChatUI] Server lost our session, automatically re-joining as:', this.savedUsername);

                // Store any pending message from the input field
                const messageInput = document.getElementById('chat-message-input');
                if (messageInput && messageInput.value.trim()) {
                    this.pendingMessage = messageInput.value.trim();
                    console.log('[ChatUI] Stored pending message for retry after rejoin:', this.pendingMessage);
                }

                this.isAutoRejoining = true;
                // Set flag to indicate we're receiving history to prevent duplicate messages
                this.isReceivingHistory = true;
                this.chat.setUsername(this.savedUsername);
                // Request users after a short delay to allow join to complete
                setTimeout(() => {
                    this.requestActiveUsersWithRetry();
                }, 200);
                return; // Don't show error to user, we're handling it automatically
            }

            this.showError(error);
        });
    }

    /**
     * Request active users with retry logic
     * If we don't get a response within 1 second, retry once
     */
    requestActiveUsersWithRetry() {
        // Don't send if already pending
        if (this.usersRequestPending) {
            console.log('[ChatUI] Users request already pending, skipping');
            return;
        }

        console.log('[ChatUI] Requesting active users');
        this.usersRequestPending = true;

        // Send the request
        this.chat.requestActiveUsers();

        // Set up retry timer (1 second)
        this.usersRequestTimer = setTimeout(() => {
            if (this.usersRequestPending) {
                console.log('[ChatUI] No response to users request, retrying once...');
                this.usersRequestPending = false;
                this.chat.requestActiveUsers();
                // Don't set up another retry - only retry once
            }
        }, 1000);
    }

    /**
     * Toggle chat panel expanded/collapsed
     */
    togglePanel() {
        this.isExpanded = !this.isExpanded;
        const panel = document.getElementById('chat-panel');
        const content = document.getElementById('chat-content');

        if (this.isExpanded) {
            panel.classList.remove('collapsed');
            panel.classList.add('expanded');
            content.style.display = 'flex';
            this.clearUnread();

            // Show collapse arrow when expanded
            const arrow = document.getElementById('chat-collapse-arrow');
            console.log('[ChatUI] Showing collapse arrow, element:', arrow, 'display:', arrow ? arrow.style.display : 'null');
            if (arrow) {
                arrow.style.display = 'block';
                console.log('[ChatUI] Arrow display set to block, computed style:', window.getComputedStyle(arrow).display);
            } else {
                console.error('[ChatUI] Arrow element not found!');
            }

            // Hide user count badge when expanded
            const badge = document.getElementById('chat-user-count-badge');
            if (badge) {
                badge.style.display = 'none';
            }

            // Re-subscribe to chat when opening the panel if not subscribed
            // This ensures we can receive messages and request users even if we previously left
            const needsSubscription = this.chat && !this.chat.isSubscribed;
            if (needsSubscription) {
                console.log('[ChatUI] Re-subscribing to chat on panel open');
                // Set flag to indicate we're receiving history to prevent duplicate messages
                this.isReceivingHistory = true;
                // Wait for subscription to complete before requesting users
                this.chat.subscribeToChat().then(() => {
                    // Request active users after subscription completes
                    setTimeout(() => {
                        this.requestActiveUsersWithRetry();
                    }, 100);
                    // After a delay, mark that we're done receiving history
                    setTimeout(() => {
                        this.isReceivingHistory = false;
                        console.log('[ChatUI] Done receiving history after re-subscription');
                    }, 1500);
                });
            }

            // Scroll to bottom of messages and focus input after a short delay
            setTimeout(() => {
                const messagesContainer = document.getElementById('chat-messages');
                if (messagesContainer) {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }

                // Focus on the appropriate input field
                if (this.chat && this.chat.isJoined()) {
                    // User is logged in - focus message input
                    const messageInput = document.getElementById('chat-message-input');
                    if (messageInput) {
                        messageInput.focus();
                    }
                } else {
                    // User not logged in - focus username input
                    const usernameInput = document.getElementById('chat-username-input');
                    if (usernameInput) {
                        usernameInput.focus();
                        // Move cursor to end of text
                        usernameInput.setSelectionRange(usernameInput.value.length, usernameInput.value.length);
                    }
                }
            }, 50);

            // Request active users when opening the panel (only if we didn't need to subscribe)
            // If we needed to subscribe, the request happens after subscription completes
            if (!needsSubscription) {
                this.requestActiveUsersWithRetry();
            }
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';

            // Hide collapse arrow when collapsed
            const arrow = document.getElementById('chat-collapse-arrow');
            if (arrow) {
                arrow.style.display = 'none';
            }

            // Show user count badge when collapsed (if there are users)
            const userCount = parseInt(document.getElementById('chat-user-count').textContent || '0');
            const badge = document.getElementById('chat-user-count-badge');
            if (badge && userCount > 0) {
                badge.style.display = 'block';
            }
        }

        // Save state to localStorage
        localStorage.setItem('ubersdr_chat_expanded', this.isExpanded.toString());
    }

    /**
     * Send a message
     */
    sendMessage() {
        const input = document.getElementById('chat-message-input');
        const sendBtn = document.getElementById('chat-send-btn');
        const message = input.value.trim();

        // Don't send empty messages
        if (message.length === 0) {
            return;
        }

        if (this.chat.sendMessage(message)) {
            input.value = '';
            // Disable send button after clearing input
            sendBtn.disabled = true;
            sendBtn.style.opacity = '0.5';
            sendBtn.style.cursor = 'not-allowed';
            input.focus();
        }
    }

    /**
     * Update mention suggestions dropdown as user types
     */
    updateMentionSuggestions() {
        const input = document.getElementById('chat-message-input');
        const text = input.value;
        const cursorPos = input.selectionStart;

        // Find the word before the cursor that starts with @
        const textBeforeCursor = text.substring(0, cursorPos);
        const match = textBeforeCursor.match(/@(\w*)$/);

        if (!match) {
            this.hideMentionSuggestions();
            return;
        }

        const partialUsername = match[1].toLowerCase();

        // Find matching usernames
        this.tabCompletionMatches = this.chat.activeUsers
            .map(u => u.username)
            .filter(username => username.toLowerCase().startsWith(partialUsername))
            .sort();

        if (this.tabCompletionMatches.length === 0) {
            this.hideMentionSuggestions();
            return;
        }

        // Reset index if matches changed
        if (this.tabCompletionIndex >= this.tabCompletionMatches.length) {
            this.tabCompletionIndex = 0;
        } else if (this.tabCompletionIndex < 0) {
            this.tabCompletionIndex = 0;
        }

        // Show suggestions
        this.showMentionSuggestions();
    }

    /**
     * Show mention suggestions dropdown
     */
    showMentionSuggestions() {
        const suggestionsDiv = document.getElementById('chat-mention-suggestions');
        suggestionsDiv.innerHTML = '';

        this.tabCompletionMatches.forEach((username, index) => {
            const item = document.createElement('div');
            item.className = 'chat-mention-suggestion-item';
            if (index === this.tabCompletionIndex) {
                item.classList.add('selected');
            }
            item.textContent = '@' + username;
            item.onclick = () => {
                this.tabCompletionIndex = index;
                this.completeMention();
            };
            suggestionsDiv.appendChild(item);
        });

        suggestionsDiv.style.display = 'block';
    }

    /**
     * Hide mention suggestions dropdown
     */
    hideMentionSuggestions() {
        const suggestionsDiv = document.getElementById('chat-mention-suggestions');
        suggestionsDiv.style.display = 'none';
        this.tabCompletionIndex = -1;
        this.tabCompletionMatches = [];
    }

    /**
     * Complete the mention with the selected username
     */
    completeMention() {
        if (this.tabCompletionMatches.length === 0 || this.tabCompletionIndex < 0) {
            return;
        }

        const input = document.getElementById('chat-message-input');
        const text = input.value;
        const cursorPos = input.selectionStart;

        // Find the @ mention before cursor
        const textBeforeCursor = text.substring(0, cursorPos);
        const match = textBeforeCursor.match(/@(\w*)$/);

        if (!match) {
            return;
        }

        const atPosition = match.index;
        const completedUsername = this.tabCompletionMatches[this.tabCompletionIndex];
        const textAfterCursor = text.substring(cursorPos);
        const newText = text.substring(0, atPosition) + '@' + completedUsername + ' ' + textAfterCursor;

        input.value = newText;
        // Set cursor position after the completed username and space
        const newCursorPos = atPosition + completedUsername.length + 2; // +2 for @ and space
        input.setSelectionRange(newCursorPos, newCursorPos);

        this.hideMentionSuggestions();
    }

    /**
     * Reset UI to username input view (used when auto-rejoin fails)
     */
    resetToUsernameInput() {
        // Switch from message input back to username input
        document.getElementById('chat-message-input-area').style.display = 'none';
        document.getElementById('chat-username-input-area').style.display = 'flex';
        document.getElementById('chat-leave-btn').style.display = 'none';
        document.getElementById('chat-mute-btn').style.display = 'none';
        document.getElementById('chat-zoom-btn').style.display = 'none';

        // Generate a new random username and populate the input
        const usernameInput = document.getElementById('chat-username-input');
        const validationIndicator = document.getElementById('chat-username-validation');
        const joinBtn = document.getElementById('chat-join-btn');

        // Generate new random username: user<4 random digits>
        const randomUsername = 'user' + Math.floor(1000 + Math.random() * 9000);
        usernameInput.value = randomUsername;

        // Trigger validation for the new random username
        const event = new Event('input', { bubbles: true });
        usernameInput.dispatchEvent(event);

        // Move cursor to end of text
        usernameInput.setSelectionRange(usernameInput.value.length, usernameInput.value.length);

        // Clear username from chat object
        this.chat.username = null;
    }

    /**
     * Show leave chat confirmation modal
     */
    showLeaveChatModal() {
        const modal = document.getElementById('chat-leave-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    /**
     * Hide leave chat confirmation modal
     */
    hideLeaveChatModal() {
        const modal = document.getElementById('chat-leave-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    /**
     * Confirm and execute leave chat
     */
    confirmLeaveChat() {
        this.hideLeaveChatModal();
        this.chat.leave();

        // Clear saved username from localStorage
        this.clearSavedUsername();

        // Reset UI to username input view
        this.resetToUsernameInput();

        // Clear message history to prevent duplicates when rejoining
        const messagesContainer = document.getElementById('chat-messages');
        if (messagesContainer) {
            messagesContainer.innerHTML = '';
        }
        this.addSystemMessage('You left the chat');

        // Collapse the chat panel
        if (this.isExpanded) {
            this.togglePanel();
        }
    }

    /**
     * Leave chat (shows confirmation modal)
     */
    leaveChat() {
        this.showLeaveChatModal();
    }

    /**
     * Add a chat message to the display
     */
    addChatMessage(username, message, timestamp, isMention = false) {
        const container = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = isMention ? 'chat-message chat-message-mention' : 'chat-message';

        const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        // Check if this message is from us
        const isOwnMessage = this.chat && this.chat.username === username;
        const usernameClass = isOwnMessage ? 'chat-message-username own-message' : 'chat-message-username';

        // Clicking username tunes to their frequency (except for our own)
        let usernameHtml;
        if (isOwnMessage) {
            usernameHtml = `<span class="${usernameClass}" style="cursor:default;">${this.escapeHtml(username)}:</span>`;
        } else {
            // Dynamic tooltip that updates on hover to show current frequency/mode
            usernameHtml = `<span class="${usernameClass}" onclick="chatUI.tuneToUser('${this.escapeHtml(username)}')" onmouseover="chatUI.updateUsernameTooltip(this, '${this.escapeHtml(username)}')">${this.escapeHtml(username)}:</span>`;
        }

        // Process message: escape HTML, then linkify URLs, then highlight mentions
        let messageHtml = this.escapeHtml(message);

        // Convert URLs to clickable links
        messageHtml = this.linkifyUrls(messageHtml);

        // Highlight @mentions in the message text
        if (this.chat && this.chat.username) {
            // Replace @username with highlighted version (case-insensitive)
            const mentionRegex = new RegExp(`(@${this.chat.username})`, 'gi');
            messageHtml = messageHtml.replace(mentionRegex, '<span style="background:#ffc107; color:#000; padding:1px 3px; border-radius:3px; font-weight:bold;">$1</span>');
        }

        div.innerHTML = `
            <span style="color:#666; font-size:10px; margin-right:4px;">${time}</span>
            ${usernameHtml}
            <span>${messageHtml}</span>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    /**
     * Convert URLs in text to clickable links
     */
    linkifyUrls(text) {
        // Match URLs starting with http:// or https://
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        return text.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#4a9eff; text-decoration:underline;">$1</a>');
    }

    /**
     * Toggle emoji picker visibility
     */
    toggleEmojiPicker() {
        const picker = document.getElementById('chat-emoji-picker');
        if (picker.style.display === 'none') {
            this.showEmojiPicker();
        } else {
            this.hideEmojiPicker();
        }
    }

    /**
     * Show emoji picker with common emojis
     */
    showEmojiPicker() {
        const picker = document.getElementById('chat-emoji-picker');

        // Common emojis
        const emojis = [
            '😊', '😂', '🤣', '😍', '😎', '🤔', '👍', '👎',
            '❤️', '🎉', '🔥', '⭐', '✨', '💯', '🚀', '🎯',
            '👋', '🙏', '💪', '🤝', '👏', '🎵', '📻', '📡',
            '🌟', '💡', '⚡', '🌈', '☀️', '🌙', '⚙️', '🔧'
        ];

        picker.innerHTML = emojis.map(emoji =>
            `<span onclick="chatUI.insertEmoji('${emoji}')">${emoji}</span>`
        ).join('');

        picker.style.display = 'grid';

        // Close picker when clicking outside
        setTimeout(() => {
            document.addEventListener('click', this.closeEmojiPickerOnClickOutside);
        }, 0);
    }

    /**
     * Hide emoji picker
     */
    hideEmojiPicker() {
        const picker = document.getElementById('chat-emoji-picker');
        picker.style.display = 'none';
        document.removeEventListener('click', this.closeEmojiPickerOnClickOutside);
    }

    /**
     * Close emoji picker when clicking outside
     */
    closeEmojiPickerOnClickOutside = (e) => {
        const picker = document.getElementById('chat-emoji-picker');
        const btn = document.getElementById('chat-emoji-btn');
        if (picker && !picker.contains(e.target) && e.target !== btn) {
            this.hideEmojiPicker();
        }
    }

    /**
     * Insert emoji at cursor position in message input
     */
    insertEmoji(emoji) {
        const input = document.getElementById('chat-message-input');
        const sendBtn = document.getElementById('chat-send-btn');
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;

        // Insert emoji at cursor position
        input.value = text.substring(0, start) + emoji + text.substring(end);

        // Move cursor after emoji
        const newPos = start + emoji.length;
        input.setSelectionRange(newPos, newPos);

        // Update send button state since we now have content
        const hasContent = input.value.trim().length > 0;
        sendBtn.disabled = !hasContent;
        sendBtn.style.opacity = hasContent ? '1' : '0.5';
        sendBtn.style.cursor = hasContent ? 'pointer' : 'not-allowed';

        // Focus input
        input.focus();

        // Hide picker
        this.hideEmojiPicker();
    }

    /**
     * Tune to a user's settings from a chat message frequency click
     */
    tuneToUser(username) {
        // Find the user in activeUsers list
        const user = this.chat.activeUsers.find(u => u.username === username);
        if (user && user.frequency && user.mode) {
            console.log('[ChatUI] Tuning to user settings:', user);
            this.syncToUser(user);
        } else {
            console.warn('[ChatUI] User not found or missing frequency/mode:', username);
        }
    }

    /**
     * Add a system message
     */
    addSystemMessage(text) {
        const container = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-message chat-message-system';
        div.textContent = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    /**
     * Show an error message
     */
    showError(error) {
        // Just show errors in the messages area
        const container = document.getElementById('chat-messages');
        if (container) {
            const div = document.createElement('div');
            div.className = 'chat-message chat-message-error';
            div.textContent = 'Error: ' + error;
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }
    }

    /**
     * Update active users list
     */
    updateActiveUsers(data) {
        console.log('[ChatUI] Received active users update:', data);

        document.getElementById('chat-user-count').textContent = data.count;

        // Update the badge on the chat toggle button
        const badge = document.getElementById('chat-user-count-badge');
        if (badge) {
            badge.textContent = data.count;
            // Show badge only when collapsed and there are users
            if (!this.isExpanded && data.count > 0) {
                badge.style.display = 'block';
            } else {
                badge.style.display = 'none';
            }
        }

        const usersList = document.getElementById('chat-users-list');

        if (data.count === 0) {
            // Show different message based on whether user has joined
            if (this.chat && this.chat.isJoined()) {
                usersList.innerHTML = '<div style="color:#666;">No other users</div>';
            } else {
                usersList.innerHTML = '<div style="color:#666;">Join chat to see active users</div>';
            }
            return;
        }

        // Get our own username to exclude from sync
        const ourUsername = this.chat.username;

        // Sort users: synced user first, then alphabetically
        const sortedUsers = [...data.users].sort((a, b) => {
            // Synced user always first
            if (a.username === this.syncedUsername) return -1;
            if (b.username === this.syncedUsername) return 1;
            // Then alphabetically
            return a.username.localeCompare(b.username);
        });

        const userItems = sortedUsers.map(u => {
            console.log('[ChatUI] User:', u.username, 'freq:', u.frequency, 'mode:', u.mode, 'cat:', u.cat, 'tx:', u.tx, 'idle_minutes:', u.idle_minutes);

            // Check if this is our own user
            const isOurUser = u.username === ourUsername;

            // Build status icons (CAT control, TX status, and idle status)
            let statusIcons = '';
            if (u.cat) {
                statusIcons += ' 🔧'; // CAT control active
            }
            if (u.tx) {
                statusIcons += ' 📡'; // Transmitting
            }
            // Add idle icon if user is idle (server determines threshold)
            if (u.is_idle) {
                statusIcons += ' 💤'; // Idle
            }

            // Username - bold if it's us, clickable to mute/unmute if it's not us
            let usernameSpan;
            if (isOurUser) {
                // Our own username - bold, not clickable
                usernameSpan = `<span style="font-weight:bold; display:block; margin-bottom:2px;">${this.escapeHtml(u.username)}${statusIcons}</span>`;
            } else {
                // Other user - clickable to mute/unmute
                usernameSpan = `<span onclick="chatUI.toggleMute('${this.escapeHtml(u.username)}')" style="cursor:pointer; display:block; margin-bottom:2px;">${this.escapeHtml(u.username)}${statusIcons}</span>`;
            }

            // Add frequency - clickable to tune for others, just display for us
            let radioInfo = '';
            if (u.frequency) {
                const freqMHz = (u.frequency / 1000000).toFixed(3);
                const modeText = u.mode ? ` (${u.mode.toUpperCase()})` : '';
                if (isOurUser) {
                    // Our own frequency - not clickable, bold
                    radioInfo += `<span style="color:#888; font-size:10px; display:block; margin-bottom:2px; font-weight:bold;">${freqMHz} MHz${modeText}</span>`;
                } else {
                    // Other user's frequency - clickable to tune
                    radioInfo += `<span style="color:#888; cursor:pointer; text-decoration:underline; font-size:10px; display:block; margin-bottom:2px;" onclick="event.stopPropagation(); chatUI.tuneToUser('${this.escapeHtml(u.username)}')" title="Click to tune to ${freqMHz} MHz">${freqMHz} MHz${modeText}</span>`;
                }
            }

            const muted = this.chat.isMuted(u.username);
            const muteClass = muted ? ' chat-user-muted' : '';

            // Build tooltip with all radio settings
            let tooltip = u.username;
            if (u.is_idle && u.idle_minutes) {
                tooltip += `\nIdle: ${u.idle_minutes} minutes`;
            }
            if (u.frequency) {
                tooltip += `\nFrequency: ${(u.frequency / 1000000).toFixed(6)} MHz`;
            }
            if (u.mode) {
                tooltip += `\nMode: ${u.mode.toUpperCase()}`;
            }
            if (u.bw_low !== undefined) {
                tooltip += `\nBW Low: ${u.bw_low} Hz`;
            }
            if (u.bw_high !== undefined) {
                tooltip += `\nBW High: ${u.bw_high} Hz`;
            }
            if (u.zoom_bw !== undefined && u.zoom_bw > 0) {
                tooltip += `\nZoom BW: ${u.zoom_bw.toFixed(1)} Hz`;
            }
            if (u.cat) {
                tooltip += `\nCAT Control: Active`;
            }
            if (u.tx) {
                tooltip += `\nStatus: Transmitting`;
            }

            // Add sync button (only if not our own user)
            const isSynced = this.syncedUsername === u.username;
            const syncBtnClass = isSynced ? 'chat-sync-btn active' : 'chat-sync-btn';
            const syncBtnText = isSynced ? '✓' : '🔗';
            const syncBtn = isOurUser ? '' : `<button class="${syncBtnClass}" onclick="event.stopPropagation(); chatUI.toggleSync('${this.escapeHtml(u.username)}');" title="${isSynced ? 'Stop syncing' : 'Sync to this user'}">${syncBtnText}</button>`;

            return `<div class="chat-user-item${muteClass}" title="${this.escapeHtml(tooltip)}">
                <div style="flex: 1; min-width: 0;">
                    ${usernameSpan}
                    ${radioInfo}
                </div>
                ${syncBtn}
            </div>`;
        }).join('');

        usersList.innerHTML = userItems;
    }

    /**
     * Update a single user's information
     * Update the stored activeUsers array with the new data
     */
    updateSingleUser(userData) {
        console.log('[ChatUI] User update received for:', userData.username);
        // Update the user in the activeUsers array
        const userIndex = this.chat.activeUsers.findIndex(u => u.username === userData.username);
        if (userIndex >= 0) {
            // Merge the update with existing user data
            this.chat.activeUsers[userIndex] = {
                ...this.chat.activeUsers[userIndex],
                ...userData
            };
        }
        // Refresh the display without requesting from server
        this.updateActiveUsers({
            users: this.chat.activeUsers,
            count: this.chat.activeUsers.length
        });
    }

    /**
     * Update our own user's data in the local activeUsers list
     * Called when we change our radio settings locally
     */
    updateOwnUserData(updates) {
        if (!this.chat || !this.chat.username) {
            return;
        }

        const ourUsername = this.chat.username;
        const userIndex = this.chat.activeUsers.findIndex(u => u.username === ourUsername);

        if (userIndex >= 0) {
            // Merge the updates with existing user data
            this.chat.activeUsers[userIndex] = {
                ...this.chat.activeUsers[userIndex],
                ...updates
            };

            // Refresh the display
            this.updateActiveUsers({
                users: this.chat.activeUsers,
                count: this.chat.activeUsers.length
            });
        }
    }

    /**
     * Toggle mute for a user
     */
    toggleMute(username) {
        const wasMuted = this.chat.toggleMute(username);
        this.addSystemMessage(wasMuted ? `Muted ${username}` : `Unmuted ${username}`);
        // Refresh display locally without server request
        this.updateActiveUsers({
            users: this.chat.activeUsers,
            count: this.chat.activeUsers.length
        });
    }

    /**
     * Increment unread message count
     */
    incrementUnread(isMention = false) {
        this.unreadCount++;
        const badge = document.getElementById('chat-unread');
        badge.textContent = this.unreadCount;
        badge.style.display = 'inline-block';

        // Show mention indicator if this is a mention
        if (isMention) {
            this.hasMentions = true;
            const mentionIndicator = document.getElementById('chat-mention');
            if (mentionIndicator) {
                mentionIndicator.style.display = 'block';
            }
        }
    }

    /**
     * Clear unread message count
     */
    clearUnread() {
        this.unreadCount = 0;
        this.hasMentions = false;
        document.getElementById('chat-unread').style.display = 'none';
        const mentionIndicator = document.getElementById('chat-mention');
        if (mentionIndicator) {
            mentionIndicator.style.display = 'none';
        }

        // Save current time as last seen message time
        this.saveLastSeenMessageTime(Date.now());
    }

    /**
     * Update tooltip for a username span to show current frequency/mode
     * Called on mouseover to provide dynamic tooltip
     */
    updateUsernameTooltip(element, username) {
        const user = this.chat.activeUsers.find(u => u.username === username);
        if (user && user.frequency && user.mode) {
            const freqMHz = (user.frequency / 1000000).toFixed(3);
            element.title = `Click to tune to ${freqMHz} MHz (${user.mode.toUpperCase()})`;
        } else {
            element.title = 'No frequency for user';
        }
    }

    /**
     * Toggle sync with a user
     */
    toggleSync(username) {
        if (this.syncedUsername === username) {
            // Unsync
            this.syncedUsername = null;
            this.addSystemMessage(`Stopped syncing with ${username}`);
        } else {
            // Sync with this user
            this.syncedUsername = username;
            this.addSystemMessage(`Now syncing with ${username}`);

            // Immediately sync to their current settings if available
            const users = this.chat.activeUsers || [];
            const user = users.find(u => u.username === username);
            if (user) {
                this.syncToUser(user);
            }
        }

        // Refresh the user list to update button states locally
        this.updateActiveUsers({
            users: this.chat.activeUsers,
            count: this.chat.activeUsers.length
        });
    }

    /**
     * Sync our radio to a user's settings
     */
    syncToUser(userData) {
        console.log(`[ChatUI] Syncing to ${userData.username}: freq=${userData.frequency} Hz, mode=${userData.mode ? userData.mode.toUpperCase() : 'N/A'}, bw_low=${userData.bw_low}, bw_high=${userData.bw_high}, zoom_bw=${userData.zoom_bw}`);

        // Only sync if we have frequency and mode data
        if (!userData.frequency || !userData.mode) {
            console.log('[ChatUI] Incomplete data for sync - need frequency and mode');
            return;
        }

        const bwLow = userData.bw_low !== undefined ? userData.bw_low : 0;
        const bwHigh = userData.bw_high !== undefined ? userData.bw_high : 0;
        const zoomBW = userData.zoom_bw !== undefined ? userData.zoom_bw : 0;

        // Disable edge detection temporarily when syncing (same as tuneToChannel)
        if (window.spectrumDisplay) {
            window.spectrumDisplay.skipEdgeDetection = true;
            setTimeout(() => {
                if (window.spectrumDisplay) {
                    window.spectrumDisplay.skipEdgeDetection = false;
                }
            }, 2000);
        }

        // Step 1: Update frequency
        const freqInput = document.getElementById('frequency');
        if (freqInput && window.setFrequencyInputValue) {
            window.setFrequencyInputValue(userData.frequency);
        }
        if (window.updateBandButtons) {
            window.updateBandButtons(userData.frequency);
        }
        if (window.updateBandSelector) {
            window.updateBandSelector();
        }

        // Step 2: Pre-set sliders to target values BEFORE calling setMode
        // This ensures setMode reads the correct values when preserveBandwidth=true
        const bwLowSlider = document.getElementById('bandwidth-low');
        const bwHighSlider = document.getElementById('bandwidth-high');

        if (bwLowSlider) {
            bwLowSlider.value = bwLow;
        }
        if (bwHighSlider) {
            bwHighSlider.value = bwHigh;
        }

        // Step 3: Update mode (preserve bandwidth - will read from sliders we just set)
        window.currentMode = userData.mode;
        if (typeof setMode === 'function') {
            console.log('[ChatUI] Calling setMode with preserveBandwidth=true');
            // Pass true to preserve bandwidth (sets up slider ranges and reads current slider values)
            setMode(userData.mode, true);
        }

        // Step 4: Force update all bandwidth values again to ensure they stuck
        // (setMode may have adjusted them based on mode limits)
        window.currentBandwidthLow = bwLow;
        window.currentBandwidthHigh = bwHigh;

        // Update spectrum display via updateConfig to ensure proper redraw
        // This is the ONLY way to reliably update the bandwidth lines
        if (window.spectrumDisplay) {
            window.spectrumDisplay.updateConfig({
                bandwidthLow: bwLow,
                bandwidthHigh: bwHigh
            });
        }

        // Re-update sliders and display values to ensure they match
        if (bwLowSlider) {
            bwLowSlider.value = bwLow;
            const bwLowValue = document.getElementById('bandwidth-low-value');
            if (bwLowValue) {
                bwLowValue.textContent = bwLow;
            }
        }

        if (bwHighSlider) {
            bwHighSlider.value = bwHigh;
            const bwHighValue = document.getElementById('bandwidth-high-value');
            if (bwHighValue) {
                bwHighValue.textContent = bwHigh;
            }
        }

        // Update bandwidth display
        if (window.updateCurrentBandwidthDisplay) {
            window.updateCurrentBandwidthDisplay(bwLow, bwHigh);
        }

        // Update URL
        if (window.updateURL) {
            window.updateURL();
        }

        // Notify radioAPI of bandwidth change (after all updates are complete)
        if (window.radioAPI) {
            window.radioAPI.notifyBandwidthChange(bwLow, bwHigh);
        }

        // Step 4: Apply zoom_bw if provided, valid, AND zoom sync is enabled (do this BEFORE autoTune)
        if (this.syncZoom && zoomBW > 0 && window.spectrumDisplay && window.spectrumDisplay.ws && window.spectrumDisplay.ws.readyState === WebSocket.OPEN) {
            console.log('[ChatUI] Applying synced zoom_bw:', zoomBW, 'Hz/bin at frequency:', userData.frequency);

            // Calculate new total bandwidth and apply boundary constraints (0-30 MHz)
            const binCount = window.spectrumDisplay.binCount || 2048;
            const newTotalBW = zoomBW * binCount;
            const halfBandwidth = newTotalBW / 2;

            // Constrain center frequency to keep view within 0-30 MHz
            const minCenterFreq = 0 + halfBandwidth;
            const maxCenterFreq = 30e6 - halfBandwidth;
            const clampedCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, userData.frequency));

            console.log('[ChatUI] Zoom constraints - totalBW:', (newTotalBW/1e6).toFixed(3), 'MHz, clamped freq:', (clampedCenterFreq/1e6).toFixed(3), 'MHz');

            // Send zoom command to spectrum display using the correct message format
            window.spectrumDisplay.ws.send(JSON.stringify({
                type: 'zoom',
                frequency: Math.round(clampedCenterFreq),
                binBandwidth: zoomBW
            }));
        }

        // Step 5: Tune with the correct bandwidth values
        if (typeof autoTune === 'function') {
            console.log('[ChatUI] Auto-tuning with synced bandwidth');
            autoTune();
        }

        // Update our own user data in the local list after sync completes
        this.updateOwnUserData({
            frequency: userData.frequency,
            mode: userData.mode,
            bw_low: bwLow,
            bw_high: bwHigh,
            zoom_bw: zoomBW
        });

        // Don't send updates directly - let the radio event handlers do it
        // The GUI changes above will trigger radioAPI events which are debounced
        // The first send will go through (to notify other users we changed)
        // Subsequent duplicate sends will be blocked by sendFrequencyMode() deduplication
        console.log('[ChatUI] Sync complete - waiting for debounced radio events to notify others');
        // Removed "Synced to..." message per user request
    }

    /**
     * Load zoom sync preference from localStorage
     */
    loadZoomSyncPreference() {
        try {
            const saved = localStorage.getItem('ubersdr_chat_zoom_sync');
            if (saved !== null) {
                this.syncZoom = saved === 'true';
            }
        } catch (e) {
            console.error('Failed to load zoom sync preference:', e);
        }
    }

    /**
     * Toggle zoom sync state
     */
    toggleZoomSync() {
        this.syncZoom = !this.syncZoom;

        // Update button appearance
        const zoomBtn = document.getElementById('chat-zoom-btn');
        if (zoomBtn) {
            if (this.syncZoom) {
                zoomBtn.classList.add('active');
            } else {
                zoomBtn.classList.remove('active');
            }
            zoomBtn.title = this.syncZoom ? 'Disable zoom sync' : 'Enable zoom sync';
        }

        // Save preference to localStorage
        try {
            localStorage.setItem('ubersdr_chat_zoom_sync', this.syncZoom.toString());
        } catch (e) {
            console.error('Failed to save zoom sync preference:', e);
        }

        // Show feedback message
        this.addSystemMessage(this.syncZoom ? 'Zoom sync enabled' : 'Zoom sync disabled');

        // If zoom was just enabled and we're currently synced with someone, apply their zoom immediately
        if (this.syncZoom && this.syncedUsername) {
            const user = this.chat.activeUsers.find(u => u.username === this.syncedUsername);
            if (user && user.zoom_bw > 0) {
                console.log('[ChatUI] Zoom enabled - applying synced user zoom immediately');
                this.syncToUser(user);
            }
        }
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Global instance (will be initialized when WebSocket connects)
let chatUI = null;

/**
 * Initialize chat UI with WebSocket
 * Call this after WebSocket is connected
 */
function initializeChatUI(websocket) {
    if (!chatUI) {
        chatUI = new ChatUI(websocket);
        // Expose globally for debugging and access
        window.chatUI = chatUI;

        // Set up radio tracking immediately - radioAPI should exist by now
        console.log('[ChatUI] Initializing radio tracking, radioAPI exists:', !!window.radioAPI);
        if (window.radioAPI) {
            chatUI.setupRadioTracking();
        } else {
            // Fallback: wait for radioAPI to be available
            console.warn('[ChatUI] radioAPI not available yet, waiting...');
            setTimeout(() => {
                if (chatUI && window.radioAPI) {
                    console.log('[ChatUI] Delayed setup of radio tracking...');
                    chatUI.setupRadioTracking();
                } else {
                    console.error('[ChatUI] radioAPI still not available after delay');
                }
            }, 1000);
        }
    }
}
