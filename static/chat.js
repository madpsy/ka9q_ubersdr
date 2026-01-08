/**
 * UberSDR Chat System
 * JavaScript client library for the live chat functionality
 * 
 * Usage:
 *   const chat = new UberSDRChat(websocket);
 *   chat.on('message', (data) => console.log(data));
 *   chat.setUsername('W1ABC');
 *   chat.sendMessage('Hello!');
 */

class UberSDRChat {
    constructor(websocket) {
        // Support both direct websocket reference and getter function
        if (typeof websocket === 'function') {
            this.getWebSocket = websocket;
        } else {
            this.getWebSocket = () => websocket;
        }
        this.username = null;
        this.frequency = null;
        this.mode = null;
        this.bwHigh = null;
        this.bwLow = null;
        this.zoomBW = null;
        this.mutedUsers = new Set();
        this.eventHandlers = {};
        this.debounceTimer = null;
        this.debounceDelay = 100; // 100ms debounce delay
        this.activeUsers = []; // Store active users for sync functionality
        this.pendingOperations = []; // Queue for operations waiting for WebSocket

        // Track last sent values to prevent duplicate sends
        this.lastSentFreq = null;
        this.lastSentMode = null;
        this.lastSentBwHigh = null;
        this.lastSentBwLow = null;
        this.lastSentZoomBW = null;

        // Load muted users from localStorage
        this.loadMutedUsers();

        // Set up message handler
        this.setupMessageHandler();
    }

    /**
     * Wait for WebSocket to be ready, with retry logic
     * @param {number} maxWaitMs - Maximum time to wait in milliseconds
     * @param {number} checkIntervalMs - How often to check in milliseconds
     * @returns {Promise<WebSocket|null>} - Returns WebSocket when ready, or null on timeout
     */
    waitForWebSocket(maxWaitMs = 2000, checkIntervalMs = 100) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const checkWebSocket = () => {
                const ws = this.getWebSocket();

                if (ws && ws.readyState === WebSocket.OPEN) {
                    resolve(ws);
                    return;
                }

                if (Date.now() - startTime >= maxWaitMs) {
                    console.warn('[Chat] WebSocket not ready after', maxWaitMs, 'ms');
                    resolve(null);
                    return;
                }

                setTimeout(checkWebSocket, checkIntervalMs);
            };

            checkWebSocket();
        });
    }

    /**
     * Set up WebSocket message handler to process chat messages
     */
    setupMessageHandler() {
        // Store reference to the original handler that we'll wrap
        // This needs to be captured once at initialization
        const ws = this.getWebSocket();
        if (ws) {
            this.originalHandler = ws.onmessage;
        }

        // Create a message handler that will be reused
        this.messageHandler = (event) => {
            const msg = JSON.parse(event.data);

            // Handle chat messages
            if (msg.type && msg.type.startsWith('chat_')) {
                this.handleChatMessage(msg);
            }

            // Call original handler for non-chat messages
            // Always get the current handler in case websocket was recreated
            if (this.originalHandler && typeof this.originalHandler === 'function') {
                this.originalHandler(event);
            }
        };

        // Install the handler on the current websocket
        if (ws) {
            ws.onmessage = this.messageHandler;
        }

        // Set up a periodic check to reinstall handler if websocket reconnects
        this.setupReconnectHandler();
    }

    /**
     * Monitor for websocket reconnections and reinstall message handler
     */
    setupReconnectHandler() {
        // Check every second if we need to reinstall the handler
        setInterval(() => {
            const ws = this.getWebSocket();
            if (ws && ws.onmessage !== this.messageHandler) {
                console.log('[Chat] Websocket reconnected, reinstalling message handler');
                // Save the new original handler (from DX cluster)
                this.originalHandler = ws.onmessage;
                // Install our wrapper
                ws.onmessage = this.messageHandler;
            }
        }, 1000);
    }

    /**
     * Handle incoming chat messages
     */
    handleChatMessage(msg) {
        console.log('[Chat] Received message type:', msg.type, 'data:', msg.data);

        switch(msg.type) {
            case 'chat_message':
                // Check if user is muted
                if (!this.mutedUsers.has(msg.data.username)) {
                    this.emit('message', msg.data);
                }
                break;
                
            case 'chat_user_joined':
                // Check if this is us joining
                if (msg.data.username === this.username) {
                    this.emit('join_confirmed', msg.data);
                } else {
                    this.emit('user_joined', msg.data);
                }
                break;
                
            case 'chat_user_left':
                this.emit('user_left', msg.data);
                break;
                
            case 'chat_active_users':
                console.log('[Chat] Emitting active_users event with data:', msg.data);
                // Store active users for sync functionality
                this.activeUsers = msg.data.users || [];
                this.emit('active_users', msg.data);
                break;
                
            case 'chat_user_update':
                console.log('[Chat] Received user update:', msg.data);
                this.emit('user_update', msg.data);
                break;
                
            case 'chat_error':
                this.emit('error', msg.error);
                break;
        }
    }

    /**
     * Register an event handler
     * Events: message, user_joined, user_left, active_users, error, join_confirmed
     */
    on(event, handler) {
        if (!this.eventHandlers[event]) {
            this.eventHandlers[event] = [];
        }
        this.eventHandlers[event].push(handler);
    }

    /**
     * Emit an event to all registered handlers
     */
    emit(event, data) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].forEach(handler => handler(data));
        }
    }

    /**
     * Validate username format
     * @param {string} username - Username to validate
     * @returns {object} {valid: boolean, error: string}
     */
    validateUsername(username) {
        if (!username || typeof username !== 'string') {
            return { valid: false, error: 'Username is required' };
        }
        if (username.length < 1 || username.length > 15) {
            return { valid: false, error: 'Username must be 1-15 characters' };
        }
        if (!/^[A-Za-z0-9]+$/.test(username)) {
            return { valid: false, error: 'Username must contain only letters and numbers' };
        }
        return { valid: true };
    }

    /**
     * Set username (required before sending messages)
     * @param {string} username - Alphanumeric, 1-15 characters
     */
    async setUsername(username) {
        // Validate username
        const validation = this.validateUsername(username);
        if (!validation.valid) {
            this.emit('error', validation.error);
            return false;
        }

        // Try to get WebSocket immediately
        let ws = this.getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            // Wait for WebSocket to be ready (up to 2 seconds)
            console.log('[Chat] WebSocket not ready, waiting...');
            ws = await this.waitForWebSocket(2000);
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            this.username = username; // Store temporarily, will be confirmed by server
            ws.send(JSON.stringify({
                type: 'chat_set_username',
                username: username
            }));
            return true;
        } else {
            this.emit('error', 'WebSocket not connected');
            return false;
        }
    }

    /**
     * Validate message format
     * @param {string} message - Message to validate
     * @returns {object} {valid: boolean, error: string}
     */
    validateMessage(message) {
        if (!message || typeof message !== 'string') {
            return { valid: false, error: 'Message is required' };
        }
        if (message.length < 1) {
            return { valid: false, error: 'Message cannot be empty' };
        }
        if (message.length > 250) {
            return { valid: false, error: 'Message must be 250 characters or less' };
        }
        // Allow printable ASCII, newlines, and Unicode characters (including emojis)
        // Only reject control characters (except newline and space)
        for (let i = 0; i < message.length; i++) {
            const code = message.charCodeAt(i);
            // Reject control characters except newline (10) and space (32)
            if (code < 32 && code !== 10) {
                return { valid: false, error: 'Message contains invalid control characters' };
            }
            // Reject DEL character (127)
            if (code === 127) {
                return { valid: false, error: 'Message contains invalid control characters' };
            }
        }
        return { valid: true };
    }

    /**
     * Send a chat message
     * @param {string} message - Message text, max 250 characters
     */
    sendMessage(message) {
        if (!this.username) {
            this.emit('error', 'Username not set');
            return false;
        }

        // Validate message
        const validation = this.validateMessage(message);
        if (!validation.valid) {
            this.emit('error', validation.error);
            return false;
        }

        const ws = this.getWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'chat_message',
                message: message
            }));
            return true;
        } else {
            // Only emit error for user-initiated actions like sending messages
            this.emit('error', 'WebSocket not connected');
            return false;
        }
    }

    /**
     * Validate frequency
     * @param {number} frequency - Frequency in Hz
     * @returns {object} {valid: boolean, error: string}
     */
    validateFrequency(frequency) {
        if (typeof frequency !== 'number' || isNaN(frequency)) {
            return { valid: false, error: 'Frequency must be a number' };
        }
        if (!Number.isInteger(frequency)) {
            return { valid: false, error: 'Frequency must be a whole number (integer)' };
        }
        if (frequency < 0) {
            return { valid: false, error: 'Frequency cannot be negative' };
        }
        if (frequency > 30000000) {
            return { valid: false, error: 'Frequency must be 30 MHz (30000000 Hz) or less' };
        }
        return { valid: true };
    }

    /**
     * Validate mode
     * @param {string} mode - Mode string
     * @returns {object} {valid: boolean, error: string}
     */
    validateMode(mode) {
        if (!mode || typeof mode !== 'string') {
            return { valid: false, error: 'Mode is required' };
        }
        const validModes = ['usb', 'lsb', 'am', 'fm', 'cwu', 'cwl', 'sam', 'nfm'];
        if (!validModes.includes(mode.toLowerCase())) {
            return { valid: false, error: 'Mode must be one of: ' + validModes.join(', ') };
        }
        return { valid: true };
    }

    /**
     * Validate bandwidth value
     * @param {number} bw - Bandwidth value in Hz
     * @param {string} name - Name for error message (bw_high or bw_low)
     * @returns {object} {valid: boolean, error: string}
     */
    validateBandwidth(bw, name) {
        if (typeof bw !== 'number' || isNaN(bw)) {
            return { valid: false, error: `${name} must be a number` };
        }
        if (!Number.isInteger(bw)) {
            return { valid: false, error: `${name} must be a whole number (integer)` };
        }
        if (bw < -10000 || bw > 10000) {
            return { valid: false, error: `${name} must be between -10000 and 10000 Hz` };
        }
        return { valid: true };
    }

    /**
     * Set frequency and mode (optional)
     * @param {number} frequency - Frequency in Hz (0 to 30000000)
     * @param {string} mode - Mode: usb, lsb, am, fm, cwu, cwl, sam, nfm
     * @param {number} bwHigh - High bandwidth cutoff in Hz (-10000 to 10000), optional
     * @param {number} bwLow - Low bandwidth cutoff in Hz (-10000 to 10000), optional
     * @param {number} zoomBW - Spectrum zoom bandwidth in Hz, optional
     */
    setFrequencyAndMode(frequency, mode, bwHigh = 0, bwLow = 0, zoomBW = 0) {
        // Validate frequency
        const freqValidation = this.validateFrequency(frequency);
        if (!freqValidation.valid) {
            this.emit('error', freqValidation.error);
            return false;
        }

        // Validate mode
        const modeValidation = this.validateMode(mode);
        if (!modeValidation.valid) {
            this.emit('error', modeValidation.error);
            return false;
        }

        // Validate bandwidth high
        const bwHighValidation = this.validateBandwidth(bwHigh, 'bw_high');
        if (!bwHighValidation.valid) {
            this.emit('error', bwHighValidation.error);
            return false;
        }

        // Validate bandwidth low
        const bwLowValidation = this.validateBandwidth(bwLow, 'bw_low');
        if (!bwLowValidation.valid) {
            this.emit('error', bwLowValidation.error);
            return false;
        }

        const ws = this.getWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
            this.frequency = frequency;
            this.mode = mode.toLowerCase();
            this.bwHigh = bwHigh;
            this.bwLow = bwLow;
            this.zoomBW = zoomBW;

            const payload = {
                type: 'chat_set_frequency_mode',
                frequency: frequency,
                mode: mode.toLowerCase(),
                bw_high: bwHigh,
                bw_low: bwLow
            };

            // Only include zoom_bw if it's set (greater than 0)
            if (zoomBW > 0) {
                payload.zoom_bw = zoomBW;
            }

            ws.send(JSON.stringify(payload));
            return true;
        } else {
            // Don't emit error - this is called automatically and will retry
            console.log('[Chat] WebSocket not ready for setFrequencyAndMode, will retry');
            return false;
        }
    }

    /**
     * Update frequency with debouncing
     * @param {number} frequency - Frequency in Hz (0 to 30000000)
     */
    updateFrequency(frequency) {
        // Validate frequency
        const freqValidation = this.validateFrequency(frequency);
        if (!freqValidation.valid) {
            this.emit('error', freqValidation.error);
            return false;
        }

        // Store the new frequency
        this.frequency = frequency;

        // Debounce the send
        this.debouncedSendFrequencyMode();
        return true;
    }

    /**
     * Update mode with debouncing
     * @param {string} mode - Mode: usb, lsb, am, fm, cwu, cwl, sam, nfm
     */
    updateMode(mode) {
        // Validate mode
        const modeValidation = this.validateMode(mode);
        if (!modeValidation.valid) {
            this.emit('error', modeValidation.error);
            return false;
        }

        // Store the new mode
        this.mode = mode.toLowerCase();

        // Debounce the send
        this.debouncedSendFrequencyMode();
        return true;
    }

    /**
     * Update bandwidth with debouncing
     * @param {number} bwHigh - High bandwidth cutoff in Hz (-10000 to 10000)
     * @param {number} bwLow - Low bandwidth cutoff in Hz (-10000 to 10000)
     */
    updateBandwidth(bwHigh, bwLow) {
        // Validate bandwidth high
        const bwHighValidation = this.validateBandwidth(bwHigh, 'bw_high');
        if (!bwHighValidation.valid) {
            this.emit('error', bwHighValidation.error);
            return false;
        }

        // Validate bandwidth low
        const bwLowValidation = this.validateBandwidth(bwLow, 'bw_low');
        if (!bwLowValidation.valid) {
            this.emit('error', bwLowValidation.error);
            return false;
        }

        // Store the new bandwidth
        this.bwHigh = bwHigh;
        this.bwLow = bwLow;

        // Debounce the send
        this.debouncedSendFrequencyMode();
        return true;
    }

    /**
     * Debounced send of frequency/mode/bandwidth
     * Waits 250ms after the last change before sending
     */
    debouncedSendFrequencyMode() {
        // Clear any existing timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Set a new timer
        this.debounceTimer = setTimeout(() => {
            this.sendFrequencyMode();
            this.debounceTimer = null;
        }, this.debounceDelay);
    }

    /**
     * Update last sent tracking values
     * Call this when receiving updates from other users to prevent echo
     * @param {object} values - Object with frequency, mode, bwHigh, bwLow, zoomBW
     */
    updateLastSentValues(values) {
        if (values.frequency !== undefined) {
            this.lastSentFreq = values.frequency;
        }
        if (values.mode !== undefined) {
            this.lastSentMode = values.mode.toLowerCase();
        }
        if (values.bwHigh !== undefined) {
            this.lastSentBwHigh = values.bwHigh;
        }
        if (values.bwLow !== undefined) {
            this.lastSentBwLow = values.bwLow;
        }
        if (values.zoomBW !== undefined) {
            this.lastSentZoomBW = values.zoomBW;
        }
    }

    /**
     * Send current frequency/mode/bandwidth to server
     * Internal method called by debounced updates
     * Always reads fresh values from app.js globals to ensure accuracy
     */
    sendFrequencyMode() {
        console.log('[Chat] sendFrequencyMode called, username:', this.username);

        if (!this.username) {
            console.log('[Chat] No username set, skipping send');
            // Don't send if not joined chat
            return false;
        }

        const ws = this.getWebSocket();
        console.log('[Chat] WebSocket state:', ws ? ws.readyState : 'no ws', 'OPEN=', WebSocket.OPEN);

        if (ws && ws.readyState === WebSocket.OPEN) {
            // Always read fresh values from app.js globals to ensure we send current state
            const freqInput = document.getElementById('frequency');
            const currentFreq = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : this.frequency;
            const currentMode = window.currentMode || this.mode;
            const currentBwLow = window.currentBandwidthLow !== undefined ? window.currentBandwidthLow : this.bwLow;
            const currentBwHigh = window.currentBandwidthHigh !== undefined ? window.currentBandwidthHigh : this.bwHigh;
            const currentZoomBW = (window.spectrumDisplay && window.spectrumDisplay.binBandwidth) ? window.spectrumDisplay.binBandwidth : this.zoomBW;

            // Check if values have actually changed from last send (client-side deduplication)
            if (currentFreq === this.lastSentFreq &&
                currentMode === this.lastSentMode &&
                currentBwHigh === this.lastSentBwHigh &&
                currentBwLow === this.lastSentBwLow &&
                currentZoomBW === this.lastSentZoomBW) {
                console.log('[Chat] Skipping duplicate send (no changes from last send)');
                return false;
            }

            const payload = {
                type: 'chat_set_frequency_mode',
                frequency: currentFreq,
                mode: currentMode,
                bw_high: currentBwHigh,
                bw_low: currentBwLow
            };

            // Only include zoom_bw if it's set (greater than 0)
            if (currentZoomBW > 0) {
                payload.zoom_bw = currentZoomBW;
            }

            console.log('[Chat] Sending frequency/mode update:', payload);
            ws.send(JSON.stringify(payload));

            // Update last sent values
            this.lastSentFreq = currentFreq;
            this.lastSentMode = currentMode;
            this.lastSentBwHigh = currentBwHigh;
            this.lastSentBwLow = currentBwLow;
            this.lastSentZoomBW = currentZoomBW;

            return true;
        } else {
            // Don't emit error for frequency/mode updates - they're debounced and will retry
            // This prevents spamming "WebSocket not connected" errors during reconnection
            console.log('[Chat] WebSocket not ready for frequency/mode update, will retry on next change');
            return false;
        }
    }

    /**
     * Request the list of active users
     */
    requestActiveUsers() {
        const ws = this.getWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'chat_request_users'
            }));
            return true;
        }
        return false;
    }

    /**
     * Leave chat cleanly (keeps WebSocket open for DX spots)
     */
    leave() {
        const ws = this.getWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'chat_leave'
            }));
            this.username = null;
            this.frequency = null;
            this.mode = null;
            this.bwHigh = null;
            this.bwLow = null;
            this.zoomBW = null;
            return true;
        }
        return false;
    }

    /**
     * Mute a user (client-side filtering)
     * @param {string} username - Username to mute
     */
    muteUser(username) {
        this.mutedUsers.add(username);
        this.saveMutedUsers();
        this.emit('user_muted', username);
    }

    /**
     * Unmute a user
     * @param {string} username - Username to unmute
     */
    unmuteUser(username) {
        this.mutedUsers.delete(username);
        this.saveMutedUsers();
        this.emit('user_unmuted', username);
    }

    /**
     * Toggle mute status for a user
     * @param {string} username - Username to toggle
     */
    toggleMute(username) {
        if (this.mutedUsers.has(username)) {
            this.unmuteUser(username);
            return false; // Now unmuted
        } else {
            this.muteUser(username);
            return true; // Now muted
        }
    }

    /**
     * Check if a user is muted
     * @param {string} username - Username to check
     */
    isMuted(username) {
        return this.mutedUsers.has(username);
    }

    /**
     * Get list of muted users
     */
    getMutedUsers() {
        return Array.from(this.mutedUsers);
    }

    /**
     * Save muted users to localStorage
     */
    saveMutedUsers() {
        try {
            localStorage.setItem('ubersdr_muted_users', JSON.stringify([...this.mutedUsers]));
        } catch (e) {
            console.error('Failed to save muted users:', e);
        }
    }

    /**
     * Load muted users from localStorage
     */
    loadMutedUsers() {
        try {
            const saved = localStorage.getItem('ubersdr_muted_users');
            if (saved) {
                this.mutedUsers = new Set(JSON.parse(saved));
            }
        } catch (e) {
            console.error('Failed to load muted users:', e);
            this.mutedUsers = new Set();
        }
    }

    /**
     * Get current username
     */
    getUsername() {
        return this.username;
    }

    /**
     * Get current frequency
     */
    getFrequency() {
        return this.frequency;
    }

    /**
     * Get current mode
     */
    getMode() {
        return this.mode;
    }

    /**
     * Get current bandwidth settings
     */
    getBandwidth() {
        return {
            high: this.bwHigh,
            low: this.bwLow
        };
    }

    /**
     * Get current zoom bandwidth
     */
    getZoomBW() {
        return this.zoomBW;
    }

    /**
     * Check if user has joined chat (username is set and confirmed)
     */
    isJoined() {
        return this.username !== null;
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UberSDRChat;
}
