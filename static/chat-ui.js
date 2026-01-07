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
        this.isSyncing = false; // Flag to prevent update loops when syncing
        this.radioEventHandlers = {}; // Store references to our radio event handlers
        this.errorTimeout = null; // Track error display timeout

        // Load saved username from localStorage
        this.loadSavedUsername();

        this.createChatPanel();
        this.setupEventHandlers();
        this.setupChatEvents();
        // Don't call setupRadioTracking here - it will be called after delay in initializeChatUI

        // Auto-login if we have a saved username
        if (this.savedUsername) {
            setTimeout(() => {
                this.autoLogin();
            }, 1000); // Wait 1 second for WebSocket to be fully ready
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
            console.log('[ChatUI] Frequency changed event:', data.frequency, 'isSyncing:', this.isSyncing);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ frequency: data.frequency });
                
                // Always send to server - the server-side comparison will prevent loops
                this.chat.updateFrequency(data.frequency);
            }
        };

        this.radioEventHandlers.mode_changed = (data) => {
            console.log('[ChatUI] Mode changed event:', data.mode, 'isSyncing:', this.isSyncing);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ mode: data.mode });
                
                // Always send to server - the server-side comparison will prevent loops
                this.chat.updateMode(data.mode);
            }
        };

        this.radioEventHandlers.bandwidth_changed = (data) => {
            console.log('[ChatUI] Bandwidth changed event - low:', data.low, 'high:', data.high, 'isSyncing:', this.isSyncing);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ bw_low: data.low, bw_high: data.high });
                
                // Always send to server - the server-side comparison will prevent loops
                this.chat.updateBandwidth(data.high, data.low);
            }
        };

        this.radioEventHandlers.zoom_changed = (data) => {
            console.log('[ChatUI] Zoom changed event - binBandwidth:', data.binBandwidth, 'isSyncing:', this.isSyncing);
            if (this.chat && this.chat.isJoined()) {
                // Always update our own user in the local list
                this.updateOwnUserData({ zoom_bw: data.binBandwidth });
                
                // Always send to server - the server-side comparison will prevent loops
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
                                           maxlength="15"
                                           pattern="[A-Za-z0-9]+"
                                           class="chat-input"
                                           style="padding-right: 30px;">
                                    <span id="chat-username-validation" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 14px; display: none;"></span>
                                </div>
                                <button id="chat-join-btn" class="chat-btn chat-btn-primary" disabled style="opacity: 0.5; cursor: not-allowed;">Join</button>
                            </div>

                            <!-- Message input (shown when logged in) -->
                            <div id="chat-message-input-area" class="chat-input-area" style="display:none;">
                                <input type="text" id="chat-message-input"
                                       placeholder="Type message..."
                                       maxlength="250"
                                       class="chat-input">
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
                                <button id="chat-leave-btn" class="chat-btn chat-btn-danger chat-leave-btn-full" style="display:none;">Leave</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Chat tab (always visible, on right edge) -->
                <div id="chat-header" class="chat-header" onclick="chatUI.togglePanel()">
                    <span>💬</span>
                    <span id="chat-unread" class="chat-unread" style="display:none;"></span>
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
            // Request users if panel is already expanded on load
            setTimeout(() => {
                this.chat.requestActiveUsers();
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
                top: 50%;
                right: 0;
                transform: translateY(-50%);
                z-index: 900;
                font-family: Arial, sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: row;
                transition: all 0.3s ease;
            }
            
            .chat-panel.collapsed {
                width: 40px;
            }

            .chat-panel.expanded {
                width: 540px;
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
            }
            
            .chat-header:hover {
                background: rgba(70, 70, 70, 0.6);
            }
            
            .chat-unread {
                background: #dc3545;
                color: #fff;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 11px;
                font-weight: bold;
            }
            
            .chat-toggle-icon {
                font-size: 12px;
            }
            
            .chat-content {
                width: 500px;
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
            
            .chat-message-username {
                font-weight: bold;
                color: #4a9eff;
                cursor: pointer;
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
                flex: 1;
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
            
            .chat-btn-danger {
                background: #dc3545;
                color: #fff;
            }
            
            .chat-btn-danger:hover {
                background: #c82333;
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
                background: rgba(35, 35, 35, 0.8);
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
                background: #222;
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
            }

            .chat-leave-btn-full {
                width: 100%;
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

        usernameInput.addEventListener('input', (e) => {
            const value = e.target.value;
            // Remove any non-alphanumeric characters as user types
            const cleaned = value.replace(/[^A-Za-z0-9]/g, '');
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
                const isValid = cleaned.length >= 1 && cleaned.length <= 15;
                
                if (isValid) {
                    // Valid - green checkmark
                    validationIndicator.textContent = '✓';
                    validationIndicator.style.color = '#4ade80';
                    joinBtn.disabled = false;
                    joinBtn.style.opacity = '1';
                    joinBtn.style.cursor = 'pointer';
                } else {
                    // Invalid - red cross
                    validationIndicator.textContent = '✗';
                    validationIndicator.style.color = '#f87171';
                    joinBtn.disabled = true;
                    joinBtn.style.opacity = '0.5';
                    joinBtn.style.cursor = 'not-allowed';
                }
            }
        });

        // Join button
        joinBtn.addEventListener('click', () => {
            const username = usernameInput.value.trim();
            if (username.length >= 1 && username.length <= 15 && /^[A-Za-z0-9]+$/.test(username)) {
                this.chat.setUsername(username);
            }
        });

        // Send button
        document.getElementById('chat-send-btn').addEventListener('click', () => {
            this.sendMessage();
        });

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

        // Enter key in message input
        document.getElementById('chat-message-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.sendMessage();
                // Refocus after a short delay to ensure message is sent first
                setTimeout(() => {
                    document.getElementById('chat-message-input').focus();
                }, 10);
            }
        });
    }

    /**
     * Set up chat event handlers
     */
    setupChatEvents() {
        this.chat.on('message', (data) => {
            this.addChatMessage(data.username, data.message, data.timestamp);
            if (!this.isExpanded) {
                this.incrementUnread();
            }
        });

        this.chat.on('join_confirmed', (data) => {
            // Save username for auto-login next time
            this.saveUsername(data.username);

            // Switch from username input to message input
            document.getElementById('chat-username-input-area').style.display = 'none';
            document.getElementById('chat-message-input-area').style.display = 'flex';
            document.getElementById('chat-leave-btn').style.display = 'block';

            this.addSystemMessage(`You joined as ${data.username}`);

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
                    this.chat.requestActiveUsers();
                }, 100);
            } else {
                // No frequency/mode to send, request users immediately
                this.chat.requestActiveUsers();
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
            this.updateActiveUsers(data);
        });

        this.chat.on('user_update', (data) => {
            this.updateSingleUser(data);
            // If this is the user we're synced with, update our radio
            // But only if we're not currently in the middle of syncing (to prevent loops)
            if (this.syncedUsername === data.username && !this.isSyncing) {
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

        this.chat.on('error', (error) => {
            // Just log errors to console, don't show in UI
            console.warn('[ChatUI] Chat error:', error);
        });
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

            // Request active users when opening the panel (even if not logged in)
            // This allows users to see who's online before joining
            this.chat.requestActiveUsers();
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';
        }

        // Save state to localStorage
        localStorage.setItem('ubersdr_chat_expanded', this.isExpanded.toString());
    }

    /**
     * Send a message
     */
    sendMessage() {
        const input = document.getElementById('chat-message-input');
        const message = input.value.trim();
        
        if (this.chat.sendMessage(message)) {
            input.value = '';
            input.focus();
        }
    }

    /**
     * Leave chat
     */
    leaveChat() {
        this.chat.leave();

        // Clear saved username from localStorage
        this.clearSavedUsername();

        // Switch from message input back to username input
        document.getElementById('chat-message-input-area').style.display = 'none';
        document.getElementById('chat-username-input-area').style.display = 'flex';
        document.getElementById('chat-leave-btn').style.display = 'none';

        // Clear username input and validation indicator
        const usernameInput = document.getElementById('chat-username-input');
        const validationIndicator = document.getElementById('chat-username-validation');
        const joinBtn = document.getElementById('chat-join-btn');

        usernameInput.value = '';
        validationIndicator.style.display = 'none';
        joinBtn.disabled = true;
        joinBtn.style.opacity = '0.5';
        joinBtn.style.cursor = 'not-allowed';

        // Don't clear messages - keep chat history visible
        this.addSystemMessage('You left the chat');
    }

    /**
     * Add a chat message to the display
     */
    addChatMessage(username, message, timestamp) {
        const container = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-message';

        const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        div.innerHTML = `
            <span style="color:#666; font-size:10px; margin-right:4px;">${time}</span>
            <span class="chat-message-username" onclick="chatUI.toggleMute('${this.escapeHtml(username)}')">${this.escapeHtml(username)}:</span>
            <span>${this.escapeHtml(message)}</span>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
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
            console.log('[ChatUI] User:', u.username, 'freq:', u.frequency, 'mode:', u.mode);

            // Username (clickable to mute/unmute)
            let usernameSpan = `<span onclick="chatUI.toggleMute('${this.escapeHtml(u.username)}')" style="cursor:pointer; display:block; margin-bottom:2px;">${this.escapeHtml(u.username)}</span>`;

            // Add frequency (clickable to tune)
            let radioInfo = '';
            if (u.frequency) {
                const freqMHz = (u.frequency / 1000000).toFixed(3);
                radioInfo += `<span style="color:#888; cursor:pointer; text-decoration:underline; font-size:10px; display:block; margin-bottom:2px;" onclick="event.stopPropagation(); chatUI.tuneToUser('${this.escapeHtml(u.username)}')" title="Click to tune to ${freqMHz} MHz">${freqMHz} MHz</span>`;
            }

            const muted = this.chat.isMuted(u.username);
            const muteClass = muted ? ' chat-user-muted' : '';

            // Build tooltip with all radio settings
            let tooltip = u.username;
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

            // Add sync button (only if not our own user)
            const isOurUser = u.username === ourUsername;
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
    incrementUnread() {
        this.unreadCount++;
        const badge = document.getElementById('chat-unread');
        badge.textContent = this.unreadCount;
        badge.style.display = 'inline-block';
    }

    /**
     * Clear unread message count
     */
    clearUnread() {
        this.unreadCount = 0;
        document.getElementById('chat-unread').style.display = 'none';
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
        console.log('[ChatUI] Syncing to user:', userData.username, 'freq:', userData.frequency, 'mode:', userData.mode, 'bw_low:', userData.bw_low, 'bw_high:', userData.bw_high, 'zoom_bw:', userData.zoom_bw);

        // Only sync if we have frequency and mode data
        if (!userData.frequency || !userData.mode) {
            console.log('[ChatUI] Incomplete data for sync - need frequency and mode');
            return;
        }

        const bwLow = userData.bw_low !== undefined ? userData.bw_low : 0;
        const bwHigh = userData.bw_high !== undefined ? userData.bw_high : 0;
        const zoomBW = userData.zoom_bw !== undefined ? userData.zoom_bw : 0;

        // Store current values BEFORE syncing to compare later
        const oldFrequency = this.chat.frequency;
        const oldMode = this.chat.mode;
        const oldBwHigh = this.chat.bwHigh;
        const oldBwLow = this.chat.bwLow;
        const oldZoomBW = this.chat.zoomBW;

        // Set syncing flag to prevent sending updates back (avoid loops)
        this.isSyncing = true;

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

        // Step 4: Apply zoom_bw if provided and valid (do this BEFORE autoTune)
        if (zoomBW > 0 && window.spectrumDisplay && window.spectrumDisplay.ws && window.spectrumDisplay.ws.readyState === WebSocket.OPEN) {
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
        
        // Send the synced settings to the server so other users can see our changes
        // Only send if our values actually changed (prevents sync loops)
        if (this.chat && this.chat.isJoined()) {
            const changed = (
                oldFrequency !== userData.frequency ||
                oldMode !== userData.mode ||
                oldBwHigh !== bwHigh ||
                oldBwLow !== bwLow ||
                oldZoomBW !== zoomBW
            );
            
            if (changed) {
                console.log('[ChatUI] Settings changed, sending synced settings to server');
                this.chat.setFrequencyAndMode(userData.frequency, userData.mode, bwHigh, bwLow, zoomBW);
            } else {
                console.log('[ChatUI] Settings unchanged, skipping server update');
            }
        }

        // Clear syncing flag after a short delay to allow radio updates to settle
        setTimeout(() => {
            this.isSyncing = false;
            console.log('[ChatUI] Sync complete, re-enabling sync triggers');
        }, 500);

        // Removed "Synced to..." message per user request
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
