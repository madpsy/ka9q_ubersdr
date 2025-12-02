// WebSocket Connection Manager for ka9q UberSDR
// Handles connection, reconnection, session management, and message routing

export class WebSocketManager {
    constructor(config) {
        // Configuration
        this.userSessionID = config.userSessionID;
        this.onMessage = config.onMessage || (() => {});
        this.onConnect = config.onConnect || (() => {});
        this.onDisconnect = config.onDisconnect || (() => {});
        this.onError = config.onError || (() => {});
        this.log = config.log || console.log;
        
        // WebSocket state
        this.ws = null;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.lastConnectionParams = null;
        this.userDisconnected = false;
        this.connectionFailureNotified = false;
        this.lastServerError = null;
        
        // Periodic settings sync
        this.settingsSyncInterval = null;
        
        // Expose ws globally for compatibility
        window.ws = null;
    }

    // Check if connection will be allowed before attempting
    async checkConnection() {
        try {
            const requestBody = {
                user_session_id: this.userSessionID
            };

            // Add bypass password if available
            if (window.bypassPassword) {
                requestBody.password = window.bypassPassword;
            }

            const response = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            return {
                allowed: data.allowed,
                reason: data.reason,
                clientIp: data.client_ip,
                status: response.status
            };
        } catch (err) {
            console.error('Connection check failed:', err);
            return {
                allowed: true, // Allow connection attempt on check failure
                reason: 'Connection check failed',
                error: err
            };
        }
    }

    // Connect to WebSocket
    async connect(params) {
        const { frequency, mode, bandwidthLow, bandwidthHigh } = params;
        
        // Clear any pending reconnection timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Store connection parameters for reconnection
        this.lastConnectionParams = { frequency, mode, bandwidthLow, bandwidthHigh };

        // Check if connection will be allowed
        const checkResult = await this.checkConnection();
        
        if (!checkResult.allowed) {
            this.log(`Connection rejected: ${checkResult.reason}`, 'error');
            this.onError({
                type: 'connection_rejected',
                reason: checkResult.reason,
                status: checkResult.status
            });
            
            // Store error for potential reconnection attempts
            this.lastServerError = checkResult.reason;
            
            // Don't attempt reconnection if banned or kicked
            if (checkResult.reason.includes('banned') || checkResult.reason.includes('terminated')) {
                this.lastConnectionParams = null;
                return false;
            }
            
            // For max sessions, schedule reconnection
            if (checkResult.reason.includes('Maximum')) {
                this.scheduleReconnect();
            }
            
            return false;
        }

        this.log(`Connection check passed (client IP: ${checkResult.clientIp})`);

        // Build WebSocket URL
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${window.location.host}/ws?frequency=${frequency}&mode=${mode}&bandwidthLow=${bandwidthLow}&bandwidthHigh=${bandwidthHigh}&user_session_id=${encodeURIComponent(this.userSessionID)}`;

        // Add bypass password if available
        if (window.bypassPassword) {
            wsUrl += `&password=${encodeURIComponent(window.bypassPassword)}`;
        }

        this.log(`Connecting to ${wsUrl}...`);

        try {
            this.ws = new WebSocket(wsUrl);
            window.ws = this.ws; // Expose globally
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.onError({
                type: 'websocket_creation_failed',
                error: error
            });
            return false;
        }

        // Setup event handlers
        this.ws.onopen = () => this.handleOpen();
        this.ws.onmessage = (event) => this.handleMessage(event);
        this.ws.onerror = (error) => this.handleError(error);
        this.ws.onclose = (event) => this.handleClose(event);

        return true;
    }

    // Handle WebSocket open
    handleOpen() {
        this.log('Connected!');
        this.onConnect();
        
        // Don't reset reconnection attempts immediately - wait for first successful message
        // This prevents resetting the counter when server immediately kicks us
        
        // Start periodic settings sync
        this.startSettingsSync();
    }

    // Handle incoming messages
    handleMessage(event) {
        try {
            const msg = JSON.parse(event.data);
            
            // Handle rate limit errors (status 429)
            if (msg.type === 'error' && msg.status === 429) {
                console.warn('⚠️ Audio rate limit exceeded:', msg.error);
                // Don't pass to onMessage, just log it
                return;
            }
            
            // Reset reconnection attempts on first successful message
            if (msg.type === 'status') {
                this.reconnectAttempts = 0;
                this.connectionFailureNotified = false;
            }
            
            this.onMessage(msg);
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    }

    // Handle WebSocket error
    handleError(error) {
        this.log('WebSocket error: ' + error);
        console.error('WebSocket error:', error);
        this.onError({
            type: 'websocket_error',
            error: error
        });
    }

    // Handle WebSocket close
    handleClose(event) {
        console.log('WebSocket closed - Code:', event.code, 'Reason:', event.reason, 'Clean:', event.wasClean);
        this.log('Disconnected');
        
        // Stop settings sync when connection closes
        this.stopSettingsSync();
        
        this.onDisconnect();
        
        this.ws = null;
        window.ws = null;

        // Show notification for abnormal closures ONLY ONCE
        // Code 1000 = normal closure (user initiated)
        // Code 1001 = going away (page navigation)
        if (event.code !== 1000 && event.code !== 1001 && !this.connectionFailureNotified) {
            this.connectionFailureNotified = true;
            
            let errorMessage;
            if (this.lastServerError) {
                errorMessage = `Connection failed: ${this.lastServerError}. Attempting to reconnect...`;
            } else if (!event.wasClean || event.code === 1006) {
                errorMessage = 'Connection failed. You may have been disconnected by an administrator. Attempting to reconnect...';
            } else {
                errorMessage = 'Connection lost. Attempting to reconnect...';
            }
            
            this.onError({
                type: 'connection_closed',
                message: errorMessage,
                code: event.code,
                reason: event.reason
            });
            
            this.lastServerError = null;
        }

        // Schedule reconnection if we have saved parameters AND user didn't explicitly disconnect
        if (this.lastConnectionParams && !this.userDisconnected && !window.audioUserDisconnected && !this.reconnectTimer) {
            this.scheduleReconnect();
        }
    }

    // Schedule reconnection attempt with exponential backoff
    scheduleReconnect() {
        // Check if we've exceeded max attempts
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.log('Maximum reconnection attempts reached. Please refresh the page.', 'error');
            this.onError({
                type: 'max_reconnect_attempts',
                message: 'Unable to reconnect after multiple attempts. You may have been disconnected by an administrator. Please refresh the page.'
            });
            return;
        }

        // Don't schedule if we already have a timer pending
        if (this.reconnectTimer) {
            console.log('Reconnect already scheduled, skipping');
            return;
        }

        this.reconnectAttempts++;

        // Calculate delay with exponential backoff
        // Attempt 1: 1s, 2: 2s, 3: 4s, 4: 8s, 5: 16s, 6: 32s, 7-10: 60s
        const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 60000);

        console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
        this.log(`Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${(delay/1000).toFixed(1)}s...`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;

            // Check connection before attempting to reconnect
            const checkResult = await this.checkConnection();

            if (!checkResult.allowed) {
                this.log(`Reconnection blocked: ${checkResult.reason}`, 'error');
                
                this.onError({
                    type: 'reconnection_blocked',
                    reason: checkResult.reason,
                    status: checkResult.status
                });

                // Clear reconnection parameters to prevent further attempts
                this.lastConnectionParams = null;
                this.reconnectAttempts = 0;
                return;
            }

            // Connection allowed - proceed with reconnect
            this.log('Connection check passed, proceeding with reconnect');
            this.reconnect();
        }, delay);
    }

    // Reconnect with saved parameters
    reconnect() {
        if (!this.lastConnectionParams) {
            this.log('No saved connection parameters, cannot reconnect', 'error');
            return;
        }

        this.log(`Reconnecting to ${this.formatFrequency(this.lastConnectionParams.frequency)} ${this.lastConnectionParams.mode.toUpperCase()} (BW: ${this.lastConnectionParams.bandwidthLow} to ${this.lastConnectionParams.bandwidthHigh} Hz)`);

        // Attempt to reconnect
        this.connect(this.lastConnectionParams);
    }

    // Disconnect from WebSocket
    disconnect() {
        // Clear reconnection timer when manually disconnecting
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Stop settings sync
        this.stopSettingsSync();

        // Mark as user-initiated disconnect
        this.userDisconnected = true;

        if (this.ws) {
            this.ws.close();
            this.ws = null;
            window.ws = null;
        }
    }

    // Send message through WebSocket
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    // Check if connected
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // Get connection state
    getState() {
        if (!this.ws) return 'disconnected';
        
        switch (this.ws.readyState) {
            case WebSocket.CONNECTING: return 'connecting';
            case WebSocket.OPEN: return 'connected';
            case WebSocket.CLOSING: return 'closing';
            case WebSocket.CLOSED: return 'disconnected';
            default: return 'unknown';
        }
    }

    // Reset user disconnect flag (for reconnection after idle)
    resetUserDisconnect() {
        this.userDisconnected = false;
    }

    // Format frequency for display
    formatFrequency(hz) {
        if (hz >= 1000000) {
            return (hz / 1000000).toFixed(3) + ' MHz';
        } else if (hz >= 1000) {
            return (hz / 1000).toFixed(1) + ' kHz';
        } else {
            return hz + ' Hz';
        }
    }

    // Start periodic settings sync (500ms interval)
    // Sends current UI state to server to ensure audio settings stay aligned
    startSettingsSync() {
        if (this.settingsSyncInterval) return;

        this.settingsSyncInterval = setInterval(() => {
            this.sendSettingsSync();
        }, 500); // 500ms = 2 times per second

        console.log('Audio: Started settings sync (500ms interval)');
    }

    // Stop periodic settings sync
    stopSettingsSync() {
        if (this.settingsSyncInterval) {
            clearInterval(this.settingsSyncInterval);
            this.settingsSyncInterval = null;
            console.log('Audio: Stopped settings sync');
        }
    }

    // Send settings sync message to server
    // Requests current status to re-sync UI state with server
    sendSettingsSync() {
        // Skip if not connected
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Request current status from server
        // Server will respond with 'status' message containing current frequency, mode, etc.
        // This re-synchronizes the UI with the actual server state
        this.ws.send(JSON.stringify({
            type: 'get_status'
        }));
    }
}