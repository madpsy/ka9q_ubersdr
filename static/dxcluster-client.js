// DX Cluster WebSocket Client
class DXClusterClient {
    constructor() {
        this.ws = null;
        this.reconnectDelay = 5000; // 5 seconds
        this.reconnectTimer = null;
        this.connected = false;
        this.userDisconnected = false; // Prevents auto-reconnect after explicit disconnect
        this.spotCallbacks = []; // Array of DX spot callbacks
        this.digitalSpotCallbacks = []; // Array of digital spot callbacks
        this.cwSpotCallbacks = []; // Array of CW spot callbacks
        this.receivedSpots = []; // Buffer for DX spots received before callbacks registered
        this.receivedDigitalSpots = []; // Buffer for digital spots received before callbacks registered
        this.receivedCWSpots = []; // Buffer for CW spots received before callbacks registered
        this.maxBufferedSpots = 100; // Maximum spots to buffer
        this.pendingSubscriptions = new Set(); // Queue for subscriptions when WebSocket not ready
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
                
                // Send any pending subscriptions
                this.processPendingSubscriptions();
                            };

            this.ws.onmessage = (event) => {
                // Handle binary messages (from audio extensions)
                if (event.data instanceof Blob) {
                    // Binary message - dispatch to audio extension handlers
                    this.handleBinaryMessage(event.data);
                    return;
                }

                // Handle text messages (JSON)
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

    processPendingSubscriptions() {
        if (this.pendingSubscriptions.size === 0) return;

        console.log('[DX Cluster] Processing', this.pendingSubscriptions.size, 'pending subscriptions');

        this.pendingSubscriptions.forEach(type => {
            this.ws.send(JSON.stringify({ type: type }));
            console.log('[DX Cluster] Sent pending subscription:', type);
        });

        this.pendingSubscriptions.clear();
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

            case 'subscription_status':
                // Subscription status confirmation from server
                break;

            // Audio extension message types - handled by extension system
            case 'audio_extension_attached':
            case 'audio_extension_detached':
            case 'audio_extension_status':
            case 'audio_extension_list':
            case 'audio_extension_error':
                // These are handled by the audio extension system, ignore here
                break;

            default:
                // Chat lives in the new interface only; this page ignores chat traffic.
                if (typeof message.type === 'string' && message.type.startsWith('chat_')) break;
                console.warn('[DX Cluster] Unknown message type:', message.type);
        }
    }

    // Handle binary messages (from audio extensions)
    handleBinaryMessage(blob) {
        // Binary messages are handled by the audio extension system
        // Dispatch a custom event that audio extensions can listen to
        const event = new CustomEvent('audioExtensionBinaryData', {
            detail: { blob: blob }
        });
        window.dispatchEvent(event);
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

    // Send subscription message to server
    subscribeToDXSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Subscribing to DX spots');
            this.ws.send(JSON.stringify({ type: 'subscribe_dx_spots' }));
        } else {
            console.log('[DX Cluster] Queueing DX spots subscription (WebSocket not ready)');
            this.pendingSubscriptions.add('subscribe_dx_spots');
        }
    }

    subscribeToDigitalSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Subscribing to digital spots');
            this.ws.send(JSON.stringify({ type: 'subscribe_digital_spots' }));
        } else {
            console.log('[DX Cluster] Queueing digital spots subscription (WebSocket not ready)');
            this.pendingSubscriptions.add('subscribe_digital_spots');
        }
    }

    subscribeToCWSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Subscribing to CW spots');
            this.ws.send(JSON.stringify({ type: 'subscribe_cw_spots' }));
        } else {
            console.log('[DX Cluster] Queueing CW spots subscription (WebSocket not ready)');
            this.pendingSubscriptions.add('subscribe_cw_spots');
        }
    }

    // Send unsubscription message to server
    unsubscribeFromDXSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Unsubscribing from DX spots');
            this.ws.send(JSON.stringify({ type: 'unsubscribe_dx_spots' }));
        }
    }

    unsubscribeFromDigitalSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Unsubscribing from digital spots');
            this.ws.send(JSON.stringify({ type: 'unsubscribe_digital_spots' }));
        }
    }

    unsubscribeFromCWSpots() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[DX Cluster] Unsubscribing from CW spots');
            this.ws.send(JSON.stringify({ type: 'unsubscribe_cw_spots' }));
        }
    }

    scheduleReconnect() {
        if (this.userDisconnected) return; // Don't reconnect after explicit disconnect
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

        // Prevent onclose from scheduling a reconnect
        this.userDisconnected = true;

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