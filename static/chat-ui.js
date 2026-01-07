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
     * Automatically sends updates to chat when user changes these values
     */
    setupRadioTracking() {
        console.log('[ChatUI] Setting up radio tracking...');

        // Track frequency changes
        const originalHandleFrequencyChange = window.handleFrequencyChange;
        console.log('[ChatUI] handleFrequencyChange exists:', !!originalHandleFrequencyChange);
        if (originalHandleFrequencyChange) {
            window.handleFrequencyChange = () => {
                console.log('[ChatUI] Frequency changed, calling original and updating chat');
                originalHandleFrequencyChange();
                this.updateRadioSettings();
            };
        }

        // Track mode changes
        const originalSetMode = window.setMode;
        console.log('[ChatUI] setMode exists:', !!originalSetMode);
        if (originalSetMode) {
            window.setMode = (...args) => {
                console.log('[ChatUI] Mode changed, calling original and updating chat');
                originalSetMode(...args);
                this.updateRadioSettings();
            };
        }

        // Track bandwidth changes (already debounced in app.js)
        const originalUpdateBandwidth = window.updateBandwidth;
        console.log('[ChatUI] updateBandwidth exists:', !!originalUpdateBandwidth);
        if (originalUpdateBandwidth) {
            window.updateBandwidth = () => {
                console.log('[ChatUI] Bandwidth changed, calling original and updating chat');
                originalUpdateBandwidth();
                this.updateRadioSettings();
            };
        }

        // Also track bandwidth display updates (for slider changes)
        const originalUpdateBandwidthDisplay = window.updateBandwidthDisplay;
        console.log('[ChatUI] updateBandwidthDisplay exists:', !!originalUpdateBandwidthDisplay);
        if (originalUpdateBandwidthDisplay) {
            window.updateBandwidthDisplay = () => {
                console.log('[ChatUI] Bandwidth display changed, calling original and updating chat');
                originalUpdateBandwidthDisplay();
                this.updateRadioSettings();
            };
        }

        console.log('[ChatUI] Radio tracking setup complete');
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
                    <!-- Username setup (shown first) -->
                    <div id="chat-username-setup" class="chat-username-setup">
                        <input type="text" id="chat-username-input" 
                               placeholder="Enter username..." 
                               maxlength="15" 
                               pattern="[A-Za-z0-9]+"
                               class="chat-input">
                        <button id="chat-join-btn" class="chat-btn chat-btn-primary">Join</button>
                        <div id="chat-error" class="chat-error"></div>
                    </div>
                    
                    <!-- Chat interface (shown after joining) -->
                    <div id="chat-interface" class="chat-interface" style="display:none;">
                        <!-- Messages area -->
                        <div id="chat-messages" class="chat-messages"></div>
                        
                        <!-- Message input -->
                        <div class="chat-input-area">
                            <input type="text" id="chat-message-input" 
                                   placeholder="Type message..." 
                                   maxlength="250"
                                   class="chat-input">
                            <button id="chat-send-btn" class="chat-btn chat-btn-primary">Send</button>
                            <button id="chat-leave-btn" class="chat-btn chat-btn-danger">Leave</button>
                        </div>
                        
                        <!-- Active users (collapsible) -->
                        <div class="chat-users-header" onclick="chatUI.toggleUsers()">
                            <span>👥 Users (<span id="chat-user-count">0</span>)</span>
                            <span id="chat-users-toggle">▼</span>
                        </div>
                        <div id="chat-users-list" class="chat-users-list" style="display:none;"></div>
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
            content.style.display = 'block';
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
                width: 350px;
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
                width: 310px;
                height: 500px;
                background: rgba(40, 40, 40, 0.7);
                border: 1px solid rgba(100, 100, 100, 0.6);
                border-right: none;
                border-radius: 8px 0 0 8px;
                order: 1;
            }
            
            .chat-username-setup {
                padding: 12px;
            }
            
            .chat-interface {
                display: flex;
                flex-direction: column;
                height: 400px;
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
            
            .chat-users-header {
                padding: 6px 12px;
                background: #2a2a2a;
                color: #aaa;
                cursor: pointer;
                user-select: none;
                border-top: 1px solid #444;
                display: flex;
                justify-content: space-between;
                font-size: 11px;
            }
            
            .chat-users-header:hover {
                background: #333;
            }
            
            .chat-users-list {
                padding: 8px 12px;
                background: #222;
                color: #aaa;
                font-size: 11px;
                max-height: 100px;
                overflow-y: auto;
            }
            
            .chat-user-item {
                padding: 2px 0;
            }
            
            .chat-user-muted {
                opacity: 0.5;
                text-decoration: line-through;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Set up DOM event handlers
     */
    setupEventHandlers() {
        // Join button
        document.getElementById('chat-join-btn').addEventListener('click', () => {
            const username = document.getElementById('chat-username-input').value.trim();
            this.chat.setUsername(username);
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
        document.getElementById('chat-username-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('chat-join-btn').click();
            }
        });

        // Enter key in message input
        document.getElementById('chat-message-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
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
            
            document.getElementById('chat-username-setup').style.display = 'none';
            document.getElementById('chat-interface').style.display = 'flex';
            this.addSystemMessage(`You joined as ${data.username}`);
            this.chat.requestActiveUsers();

            // Send initial frequency/mode/bandwidth on join
            this.updateRadioSettings();
        });

        this.chat.on('user_joined', (data) => {
            this.addSystemMessage(`${data.username} joined`);
            this.chat.requestActiveUsers();
        });

        this.chat.on('user_left', (data) => {
            this.addSystemMessage(`${data.username} left`);
            this.chat.requestActiveUsers();
        });

        this.chat.on('active_users', (data) => {
            this.updateActiveUsers(data);
        });

        this.chat.on('error', (error) => {
            this.showError(error);
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
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';
        }
        
        // Save state to localStorage
        localStorage.setItem('ubersdr_chat_expanded', this.isExpanded.toString());
    }

    /**
     * Toggle users list
     */
    toggleUsers() {
        const usersList = document.getElementById('chat-users-list');
        const toggle = document.getElementById('chat-users-toggle');
        
        if (usersList.style.display === 'none') {
            usersList.style.display = 'block';
            toggle.textContent = '▲';
        } else {
            usersList.style.display = 'none';
            toggle.textContent = '▼';
        }
    }

    /**
     * Send a message
     */
    sendMessage() {
        const input = document.getElementById('chat-message-input');
        const message = input.value.trim();
        
        if (this.chat.sendMessage(message)) {
            input.value = '';
        }
    }

    /**
     * Leave chat
     */
    leaveChat() {
        this.chat.leave();
        document.getElementById('chat-username-setup').style.display = 'block';
        document.getElementById('chat-interface').style.display = 'none';
        document.getElementById('chat-username-input').value = '';
        document.getElementById('chat-messages').innerHTML = '';
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
        // Show in error div
        const errorDiv = document.getElementById('chat-error');
        if (errorDiv) {
            errorDiv.textContent = error;
            setTimeout(() => {
                errorDiv.textContent = '';
            }, 5000);
        }
        
        // Also add to messages
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
        document.getElementById('chat-user-count').textContent = data.count;
        const usersList = document.getElementById('chat-users-list');
        
        if (data.count === 0) {
            usersList.innerHTML = '<div style="color:#666;">No other users</div>';
            return;
        }
        
        const userItems = data.users.map(u => {
            let info = this.escapeHtml(u.username);
            
            // Add frequency (always show if set, even without mode)
            if (u.frequency) {
                const freqMHz = (u.frequency / 1000000).toFixed(3);
                info += ` <span style="color:#888;">${freqMHz} MHz</span>`;

                // Add mode if also set
                if (u.mode) {
                    info += ` <span style="color:#888;">${u.mode.toUpperCase()}</span>`;
                }
            }
            
            const muted = this.chat.isMuted(u.username);
            const muteClass = muted ? ' chat-user-muted' : '';
            
            return `<div class="chat-user-item${muteClass}" onclick="chatUI.toggleMute('${this.escapeHtml(u.username)}')" style="cursor:pointer;">${info}</div>`;
        }).join('');
        
        usersList.innerHTML = userItems;
    }

    /**
     * Toggle mute for a user
     */
    toggleMute(username) {
        const wasMuted = this.chat.toggleMute(username);
        this.addSystemMessage(wasMuted ? `Muted ${username}` : `Unmuted ${username}`);
        this.chat.requestActiveUsers(); // Refresh display
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

        // Set up radio tracking after a longer delay to ensure app.js has finished all its overrides
        // app.js overrides window.handleFrequencyChange around line 7539, so we need to wait
        setTimeout(() => {
            if (chatUI) {
                console.log('[ChatUI] Delayed setup of radio tracking...');
                chatUI.setupRadioTracking();
            }
        }, 2000); // 2 second delay to ensure app.js is fully loaded
    }
}
