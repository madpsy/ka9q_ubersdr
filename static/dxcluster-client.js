// DX Cluster WebSocket Client
class DXClusterClient {
    constructor() {
        this.ws = null;
        this.reconnectDelay = 5000; // 5 seconds
        this.reconnectTimer = null;
        this.connected = false;
        this.spotCallbacks = []; // Array of DX spot callbacks
        this.digitalSpotCallbacks = []; // Array of digital spot callbacks
        this.cwSpotCallbacks = []; // Array of CW spot callbacks
        this.receivedSpots = []; // Buffer for DX spots received before callbacks registered
        this.receivedDigitalSpots = []; // Buffer for digital spots received before callbacks registered
        this.receivedCWSpots = []; // Buffer for CW spots received before callbacks registered
        this.maxBufferedSpots = 100; // Maximum spots to buffer
    }

    connect() {
        // Get user session ID from global state (set by app.js as window.userSessionID)
        const userSessionId = window.userSessionID || '';
        
        if (!userSessionId) {
            console.error('[DX Cluster] No user session ID available, cannot connect');
            this.scheduleReconnect();
            return;
        }

        // Determine WebSocket URL based on current page protocol
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${window.location.host}/ws/dxcluster?user_session_id=${encodeURIComponent(userSessionId)}`;

        // Add bypass password if available
        if (window.bypassPassword) {
            wsUrl += `&password=${encodeURIComponent(window.bypassPassword)}`;
        }

        console.log('[DX Cluster] Connecting to:', wsUrl);

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[DX Cluster] Connected');
                this.connected = true;
                
                // Clear any pending reconnect timer
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                
                // Initialize chat UI if not already initialized
                if (typeof initializeChatUI === 'function' && !window.chatUI) {
                    initializeChatUI(this.ws);
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('[DX Cluster] Failed to parse message:', error, event.data);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[DX Cluster] WebSocket error:', error);
            };

            this.ws.onclose = (event) => {
                console.log('[DX Cluster] Disconnected:', event.code, event.reason);
                this.connected = false;
                this.ws = null;

                // Attempt to reconnect
                this.scheduleReconnect();
            };

        } catch (error) {
            console.error('[DX Cluster] Failed to create WebSocket:', error);
            this.scheduleReconnect();
        }
    }

    handleMessage(message) {
        // Handle different message types
        switch (message.type) {
            case 'status':
                // Status update received
                break;

            case 'dx_spot':
                // DX Cluster spot received (not digital_spot)
                if (message.data) {
                    // If no callbacks registered yet, buffer the spot
                    if (this.spotCallbacks.length === 0) {
                        this.receivedSpots.push(message.data);
                        // Limit buffer size
                        if (this.receivedSpots.length > this.maxBufferedSpots) {
                            this.receivedSpots.shift();
                        }
                    } else {
                        // Notify all callbacks
                        this.spotCallbacks.forEach(callback => {
                            try {
                                callback(message.data);
                            } catch (error) {
                                console.error('[DX Cluster] Error in spot callback:', error);
                            }
                        });
                    }
                }
                break;

            case 'digital_spot':
                // Digital mode spot (FT8/FT4/WSPR)
                if (message.data) {
                    // If no callbacks registered yet, buffer the spot
                    if (this.digitalSpotCallbacks.length === 0) {
                        this.receivedDigitalSpots.push(message.data);
                        // Limit buffer size
                        if (this.receivedDigitalSpots.length > this.maxBufferedSpots) {
                            this.receivedDigitalSpots.shift();
                        }
                    } else {
                        // Notify all callbacks
                        this.digitalSpotCallbacks.forEach(callback => {
                            try {
                                callback(message.data);
                            } catch (error) {
                                console.error('[DX Cluster] Error in digital spot callback:', error);
                            }
                        });
                    }
                }
                break;

            case 'cw_spot':
                // CW spot from CW Skimmer
                if (message.data) {
                    // If no callbacks registered yet, buffer the spot
                    if (this.cwSpotCallbacks.length === 0) {
                        this.receivedCWSpots.push(message.data);
                        // Limit buffer size
                        if (this.receivedCWSpots.length > this.maxBufferedSpots) {
                            this.receivedCWSpots.shift();
                        }
                    } else {
                        // Notify all callbacks
                        this.cwSpotCallbacks.forEach(callback => {
                            try {
                                callback(message.data);
                            } catch (error) {
                                console.error('[DX Cluster] Error in CW spot callback:', error);
                            }
                        });
                    }
                }
                break;

            case 'pong':
                // Response to ping
                break;

            default:
                console.warn('[DX Cluster] Unknown message type:', message.type);
        }
    }

    // Subscribe to DX spot notifications
    onSpot(callback) {
        this.spotCallbacks.push(callback);
        
        // Send any buffered spots to the new callback
        if (this.receivedSpots.length > 0) {
            this.receivedSpots.forEach(spot => {
                try {
                    callback(spot);
                } catch (error) {
                    console.error('[DX Cluster] Error sending buffered spot:', error);
                }
            });
            // Clear the buffer after sending
            this.receivedSpots = [];
        }
        
        // Return unsubscribe function
        return () => {
            const index = this.spotCallbacks.indexOf(callback);
            if (index > -1) {
                this.spotCallbacks.splice(index, 1);
            }
        };
    }

    // Subscribe to digital spot notifications (FT8/FT4/WSPR)
    onDigitalSpot(callback) {
        this.digitalSpotCallbacks.push(callback);
        
        // Send any buffered digital spots to the new callback
        if (this.receivedDigitalSpots.length > 0) {
            this.receivedDigitalSpots.forEach(spot => {
                try {
                    callback(spot);
                } catch (error) {
                    console.error('[DX Cluster] Error sending buffered digital spot:', error);
                }
            });
            // Clear the buffer after sending
            this.receivedDigitalSpots = [];
        }
        
        // Return unsubscribe function
        return () => {
            const index = this.digitalSpotCallbacks.indexOf(callback);
            if (index > -1) {
                this.digitalSpotCallbacks.splice(index, 1);
            }
        };
    }

    // Subscribe to CW spot notifications
    onCWSpot(callback) {
        this.cwSpotCallbacks.push(callback);
        
        // Send any buffered CW spots to the new callback
        if (this.receivedCWSpots.length > 0) {
            this.receivedCWSpots.forEach(spot => {
                try {
                    callback(spot);
                } catch (error) {
                    console.error('[DX Cluster] Error sending buffered CW spot:', error);
                }
            });
            // Clear the buffer after sending
            this.receivedCWSpots = [];
        }
        
        // Return unsubscribe function
        return () => {
            const index = this.cwSpotCallbacks.indexOf(callback);
            if (index > -1) {
                this.cwSpotCallbacks.splice(index, 1);
            }
        };
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            return; // Already scheduled
        }

        console.log(`[DX Cluster] Reconnecting in ${this.reconnectDelay / 1000} seconds...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);
    }

    disconnect() {
        console.log('[DX Cluster] Disconnecting...');
        
        // Clear reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Close WebSocket
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.connected = false;
    }

    sendPing() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }
}

// Create global instance
window.dxClusterClient = new DXClusterClient();

// Auto-connect when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[DX Cluster] Auto-connecting...');
        window.dxClusterClient.connect();
    });
} else {
    console.log('[DX Cluster] Auto-connecting...');
    window.dxClusterClient.connect();
}

// Optional: Send periodic pings to keep connection alive
setInterval(() => {
    if (window.dxClusterClient.connected) {
        window.dxClusterClient.sendPing();
    }
}, 30000); // Every 30 seconds