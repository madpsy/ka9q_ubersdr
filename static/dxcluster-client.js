// DX Cluster WebSocket Client
class DXClusterClient {
    constructor() {
        this.ws = null;
        this.reconnectDelay = 5000; // 5 seconds
        this.reconnectTimer = null;
        this.connected = false;
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
        const wsUrl = `${protocol}//${window.location.host}/ws/dxcluster?user_session_id=${encodeURIComponent(userSessionId)}`;

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
        // Handle different message types silently
        // Extensions can subscribe via radioAPI.onDXSpot() for spot notifications
        switch (message.type) {
            case 'status':
                // Status update received
                break;

            case 'spot':
                // Spot received - handled by radioAPI subscribers
                break;

            case 'pong':
                // Response to ping
                break;

            default:
                console.warn('[DX Cluster] Unknown message type:', message.type);
        }
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