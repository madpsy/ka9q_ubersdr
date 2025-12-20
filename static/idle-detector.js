// Idle Detection System
// Monitors user activity and shows confirmation dialog after inactivity period

class IdleDetector {
    constructor() {
        // These will be set dynamically from server config
        this.INACTIVITY_TIMEOUT = null; // Will be (session_timeout - 30) seconds
        this.CONFIRMATION_TIMEOUT = 30 * 1000; // 30 seconds in milliseconds (fixed)
        this.sessionTimeout = null; // Server's session_timeout value in seconds
        
        this.inactivityTimer = null;
        this.confirmationTimer = null;
        this.isShowingConfirmation = false;
        this.isTimedOut = false;
        this.lastActivityTime = Date.now();
        this.lastHeartbeatTime = 0; // Track when last heartbeat was sent
        this.inactivityLogTimer = null;
        
        // Events to monitor for user activity
        this.activityEvents = [
            'mousedown',
            'mousemove',
            'keypress',
            'keydown',
            'scroll',
            'touchstart',
            'click',
            'wheel'
        ];
        
        this.init();
    }
    
    async init() {
        // Fetch session timeout from server
        await this.fetchSessionTimeout();
        
        // Bind activity handlers to all monitored events
        this.activityEvents.forEach(event => {
            document.addEventListener(event, () => this.handleActivity(), true);
        });
        
        // Handle visibility changes (tab switching)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && !this.isTimedOut) {
                this.handleActivity();
            }
        });
        
        // Create confirmation overlay (hidden initially)
        this.createConfirmationOverlay();
        
        // Start initial timer
        this.resetInactivityTimer();
        
        // Start periodic inactivity logging
        this.startInactivityLogging();
        
        const warningMinutes = Math.floor(this.INACTIVITY_TIMEOUT / 60000);
        const warningSeconds = Math.floor((this.INACTIVITY_TIMEOUT % 60000) / 1000);
        console.log(`Idle detector initialized: ${warningMinutes}m ${warningSeconds}s inactivity → 30s confirmation (server timeout: ${this.sessionTimeout}s)`);
    }
    
    async fetchSessionTimeout() {
        try {
            // Fetch session timeout from /connection endpoint
            const response = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user_session_id: window.userSessionID || 'unknown'
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                console.log('Fetched connection data:', data);
                // Use nullish coalescing to properly handle 0 value (0 is valid, means no timeout)
                this.sessionTimeout = data.session_timeout !== undefined ? data.session_timeout : 300;
                
                // Calculate inactivity timeout: show warning 30 seconds before server timeout
                // If session_timeout is 0 (no timeout), disable idle detection
                if (this.sessionTimeout === 0) {
                    console.log('✓ Server session timeout disabled (0) - idle detection DISABLED for this IP');
                    this.INACTIVITY_TIMEOUT = null;
                } else if (this.sessionTimeout <= 30) {
                    // If timeout is 30 seconds or less, show warning immediately
                    console.warn(`Server session timeout (${this.sessionTimeout}s) is too short for idle detection`);
                    this.INACTIVITY_TIMEOUT = 1000; // 1 second
                } else {
                    // Normal case: warn 30 seconds before timeout
                    this.INACTIVITY_TIMEOUT = (this.sessionTimeout - 30) * 1000;
                }
                
                console.log(`Fetched session timeout from server: ${this.sessionTimeout}s, warning at: ${this.INACTIVITY_TIMEOUT}ms`);
            } else {
                console.error('Failed to fetch session timeout, using default 5 minutes');
                this.sessionTimeout = 300;
                this.INACTIVITY_TIMEOUT = 270 * 1000; // 4.5 minutes
            }
        } catch (err) {
            console.error('Error fetching session timeout:', err);
            // Default to 5 minutes if fetch fails
            this.sessionTimeout = 300;
            this.INACTIVITY_TIMEOUT = 270 * 1000; // 4.5 minutes
        }
    }
    
    createConfirmationOverlay() {
        // Create overlay container
        this.overlay = document.createElement('div');
        this.overlay.id = 'idle-confirmation-overlay';
        this.overlay.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            z-index: 10000;
            justify-content: center;
            align-items: center;
        `;
        
        // Create dialog box
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #2c3e50;
            border: 3px solid #e74c3c;
            border-radius: 10px;
            padding: 30px;
            max-width: 500px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        `;
        
        // Warning icon
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 64px;
            margin-bottom: 20px;
        `;
        icon.textContent = '⚠️';
        
        // Title
        const title = document.createElement('h2');
        title.style.cssText = `
            color: #e74c3c;
            margin: 0 0 15px 0;
            font-size: 24px;
        `;
        title.textContent = 'Are You Still There?';
        
        // Message (will be updated with actual idle time)
        this.idleTimeDisplay = document.createElement('p');
        this.idleTimeDisplay.style.cssText = `
            color: #ecf0f1;
            font-size: 16px;
            margin: 0 0 10px 0;
            line-height: 1.5;
        `;
        
        // Countdown display
        this.countdownDisplay = document.createElement('p');
        this.countdownDisplay.style.cssText = `
            color: #f39c12;
            font-size: 20px;
            font-weight: bold;
            margin: 15px 0;
        `;
        
        // Confirm button
        const confirmButton = document.createElement('button');
        confirmButton.style.cssText = `
            background: #27ae60;
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 18px;
            font-weight: bold;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 10px;
            transition: background 0.3s;
        `;
        confirmButton.textContent = 'Yes, I\'m Here!';
        confirmButton.onmouseover = () => confirmButton.style.background = '#229954';
        confirmButton.onmouseout = () => confirmButton.style.background = '#27ae60';
        confirmButton.onclick = () => this.handleConfirmation();
        
        // Assemble dialog
        dialog.appendChild(icon);
        dialog.appendChild(title);
        dialog.appendChild(this.idleTimeDisplay);
        dialog.appendChild(this.countdownDisplay);
        dialog.appendChild(confirmButton);
        
        this.overlay.appendChild(dialog);
        document.body.appendChild(this.overlay);
    }
    
    handleActivity() {
        // Ignore activity if already timed out
        if (this.isTimedOut) {
            return;
        }
        
        // If confirmation is showing, user activity confirms presence
        if (this.isShowingConfirmation) {
            this.handleConfirmation();
            return;
        }
        
        // Calculate time since last activity
        const now = Date.now();
        const timeSinceLastActivity = this.lastActivityTime ? (now - this.lastActivityTime) : 0;
        const timeSinceLastHeartbeat = now - this.lastHeartbeatTime;

        // Send heartbeat to server when:
        // 1. User is active AND at least 10 seconds since last heartbeat
        // 2. User returns after being idle (>= 30 seconds since last activity)
        // This keeps connection alive when user is present (max once per 10s), and notifies server when user returns
        const shouldSendHeartbeat = (timeSinceLastHeartbeat >= 10000 || timeSinceLastActivity >= 30000);

        if (shouldSendHeartbeat) {
            let heartbeatsSent = 0;

            // Send heartbeat to audio WebSocket
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ type: 'ping' }));
                heartbeatsSent++;
            } else if (window.ws) {
                console.log(`Audio WebSocket not open (state: ${window.ws.readyState})`);
            }

            // Send heartbeat to spectrum WebSocket
            if (window.spectrumDisplay && window.spectrumDisplay.ws && window.spectrumDisplay.ws.readyState === WebSocket.OPEN) {
                window.spectrumDisplay.ws.send(JSON.stringify({ type: 'ping' }));
                heartbeatsSent++;
            } else {
                if (!window.spectrumDisplay) {
                    console.log('Spectrum display not initialized');
                } else if (!window.spectrumDisplay.ws) {
                    console.log('Spectrum WebSocket not created');
                } else {
                    console.log(`Spectrum WebSocket not open (state: ${window.spectrumDisplay.ws.readyState})`);
                }
            }

            if (heartbeatsSent > 0) {
                this.lastHeartbeatTime = now;
                if (timeSinceLastActivity >= 30000) {
                    console.log(`Heartbeat sent to ${heartbeatsSent} channel(s) - user returned after ${Math.floor(timeSinceLastActivity/1000)}s idle`);
                } else {
                    console.log(`Heartbeat sent to ${heartbeatsSent} channel(s) - user active`);
                }
            }
        }

        // Update last activity time
        this.lastActivityTime = now;
        
        // Reset the inactivity timer
        this.resetInactivityTimer();
    }
    
    resetInactivityTimer() {
        // Don't start timer if idle detection is disabled (session_timeout = 0)
        if (this.INACTIVITY_TIMEOUT === null) {
            return;
        }
        
        // Clear existing timer
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }
        
        // Start new timer
        this.inactivityTimer = setTimeout(() => {
            this.showConfirmation();
        }, this.INACTIVITY_TIMEOUT);
    }
    
    startInactivityLogging() {
        // Log inactivity duration every 30 seconds
        this.inactivityLogTimer = setInterval(() => {
            if (!this.isTimedOut && !this.isShowingConfirmation) {
                const now = Date.now();
                const inactiveSeconds = Math.floor((now - this.lastActivityTime) / 1000);
                
                if (inactiveSeconds >= 30) {
                    const minutes = Math.floor(inactiveSeconds / 60);
                    const seconds = inactiveSeconds % 60;
                    
                    if (minutes > 0) {
                        console.log(`Inactive for ${minutes}m ${seconds}s`);
                    } else {
                        console.log(`Inactive for ${seconds}s`);
                    }
                }
            }
        }, 30000); // Every 30 seconds
    }
    
    showConfirmation() {
        console.log('Showing inactivity confirmation dialog');
        this.isShowingConfirmation = true;
        
        // Show overlay
        this.overlay.style.display = 'flex';
        
        // Start countdown
        let remainingSeconds = this.CONFIRMATION_TIMEOUT / 1000;
        this.updateCountdown(remainingSeconds);
        
        this.confirmationTimer = setInterval(() => {
            remainingSeconds--;
            this.updateCountdown(remainingSeconds);
            
            if (remainingSeconds <= 0) {
                this.handleTimeout();
            }
        }, 1000);
    }
    
    updateCountdown(seconds) {
        // Update idle time display (how long user has been idle)
        if (this.idleTimeDisplay) {
            const now = Date.now();
            const idleSeconds = Math.floor((now - this.lastActivityTime) / 1000);
            const idleMinutes = Math.floor(idleSeconds / 60);
            const idleSecondsRemainder = idleSeconds % 60;

            if (idleMinutes > 0) {
                this.idleTimeDisplay.textContent = `You've been inactive for ${idleMinutes} minute${idleMinutes !== 1 ? 's' : ''} and ${idleSecondsRemainder} second${idleSecondsRemainder !== 1 ? 's' : ''}.`;
            } else {
                this.idleTimeDisplay.textContent = `You've been inactive for ${idleSeconds} second${idleSeconds !== 1 ? 's' : ''}.`;
            }
        }

        // Update countdown display (time until disconnect)
        if (this.countdownDisplay) {
            this.countdownDisplay.textContent = `Disconnecting in ${seconds} second${seconds !== 1 ? 's' : ''}...`;
        }
    }
    
    handleConfirmation() {
        console.log('User confirmed presence');
        
        // Clear confirmation timer
        if (this.confirmationTimer) {
            clearInterval(this.confirmationTimer);
            this.confirmationTimer = null;
        }
        
        // Hide overlay
        this.overlay.style.display = 'none';
        this.isShowingConfirmation = false;
        
        // Reset inactivity timer
        this.resetInactivityTimer();
    }
    
    handleTimeout() {
        console.log('User timed out - closing connections');
        
        // Clear timers
        if (this.confirmationTimer) {
            clearInterval(this.confirmationTimer);
            this.confirmationTimer = null;
        }
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
        
        // Mark as timed out to prevent reconnection
        this.isTimedOut = true;
        
        // Close WebSocket connections (prevent auto-reconnect)
        this.closeConnections();
        
        // Show timeout message
        this.showTimeoutMessage();
    }
    
    closeConnections() {
        // Close main audio WebSocket
        if (window.ws) {
            // Set user disconnect flag to prevent auto-reconnect
            window.audioUserDisconnected = true;
            
            // Clear reconnection parameters to prevent auto-reconnect
            window.lastConnectionParams = null;
            
            // Clear any pending reconnect timer
            if (window.reconnectTimer) {
                clearTimeout(window.reconnectTimer);
                window.reconnectTimer = null;
            }
            
            // Close the WebSocket
            window.ws.close();
            window.ws = null;
            console.log('Closed audio WebSocket');
        }
        
        // Close spectrum display WebSocket and prevent reconnection
        if (window.spectrumDisplay) {
            // Mark as disconnected by user to prevent auto-reconnect
            window.spectrumDisplay.userDisconnected = true;

            // Clear spectrum reconnect timer BEFORE disconnecting
            if (window.spectrumDisplay.reconnectTimer) {
                clearTimeout(window.spectrumDisplay.reconnectTimer);
                window.spectrumDisplay.reconnectTimer = null;
            }

            // Disconnect the WebSocket
            if (window.spectrumDisplay.ws) {
                window.spectrumDisplay.disconnect();
                console.log('Closed spectrum WebSocket');
            }

            // Clear reconnect timer again after disconnect (in case onclose created a new one)
            if (window.spectrumDisplay.reconnectTimer) {
                clearTimeout(window.spectrumDisplay.reconnectTimer);
                window.spectrumDisplay.reconnectTimer = null;
            }
        }
        
        // Stop audio context
        if (window.audioContext) {
            window.audioContext.close();
            window.audioContext = null;
            console.log('Closed audio context');
        }
    }
    
    showTimeoutMessage() {
        // Update overlay to show timeout message
        this.overlay.innerHTML = '';
        
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #2c3e50;
            border: 3px solid #e74c3c;
            border-radius: 10px;
            padding: 40px;
            max-width: 500px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        `;
        
        // Icon
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 64px;
            margin-bottom: 20px;
        `;
        icon.textContent = '⏱️';
        
        // Title
        const title = document.createElement('h2');
        title.style.cssText = `
            color: #e74c3c;
            margin: 0 0 15px 0;
            font-size: 24px;
        `;
        title.textContent = 'Session Timed Out';
        
        // Message
        const message = document.createElement('p');
        message.style.cssText = `
            color: #ecf0f1;
            font-size: 16px;
            margin: 0 0 20px 0;
            line-height: 1.5;
        `;
        message.textContent = 'Your session has been closed due to inactivity. Please refresh the page to reconnect.';
        
        // Refresh button
        const refreshButton = document.createElement('button');
        refreshButton.style.cssText = `
            background: #3498db;
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 18px;
            font-weight: bold;
            border-radius: 5px;
            cursor: pointer;
            transition: background 0.3s;
        `;
        refreshButton.textContent = 'Refresh Page';
        refreshButton.onmouseover = () => refreshButton.style.background = '#2980b9';
        refreshButton.onmouseout = () => refreshButton.style.background = '#3498db';
        refreshButton.onclick = () => window.location.reload();
        
        dialog.appendChild(icon);
        dialog.appendChild(title);
        dialog.appendChild(message);
        dialog.appendChild(refreshButton);
        
        this.overlay.appendChild(dialog);
        this.overlay.style.display = 'flex';
    }
    
    destroy() {
        // Clean up event listeners
        this.activityEvents.forEach(event => {
            document.removeEventListener(event, this.handleActivity, true);
        });
        
        // Clear timers
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }
        if (this.confirmationTimer) {
            clearInterval(this.confirmationTimer);
        }
        if (this.inactivityLogTimer) {
            clearInterval(this.inactivityLogTimer);
        }
        
        // Remove overlay
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
    }
}

// Initialize idle detector when DOM is ready
let idleDetector = null;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        idleDetector = new IdleDetector();
    });
} else {
    idleDetector = new IdleDetector();
}

// Expose for debugging
window.idleDetector = idleDetector;