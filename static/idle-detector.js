// Idle Detection System
// Monitors user activity and shows confirmation dialog after inactivity period

class IdleDetector {
    constructor() {
        // These will be set dynamically from server config
        this.INACTIVITY_TIMEOUT = null; // Will be (session_timeout - 30) seconds
        this.CONFIRMATION_TIMEOUT = 30 * 1000; // 30 seconds in milliseconds (fixed)
        this.sessionTimeout = null; // Server's session_timeout value in seconds

        // Mobile-only: auto-pause the waterfall after 5 minutes of idle.
        // Independent of the session-timeout idle detection above.
        this.MOBILE_WATERFALL_PAUSE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
        this.mobileWaterfallPauseTimer = null;
        this._mobileAutoPaused = false; // true when we auto-paused the waterfall

        // All devices: drop spectrum to divisor=2 after an idle period.
        // Mobile idles faster (2.5 min) than desktop (5 min) since mobile data
        // is more bandwidth-sensitive.  Restores the correct divisor (1 if
        // spectrum visible, 3 if hidden) on any user activity.  Works on top of
        // the mobile full pause.
        this.IDLE_RATE_THROTTLE_TIMEOUT_MOBILE  = 2.5 * 60 * 1000; // 2.5 minutes
        this.IDLE_RATE_THROTTLE_TIMEOUT_DESKTOP = 5 * 60 * 1000;   // 5 minutes
        this.idleRateThrottleTimer = null;
        this._idleThrottled = false; // true while we have dropped to divisor=3
        
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

        // Mobile waterfall auto-pause: show the Pause checkbox on mobile and
        // restore the saved preference, then start the timer.
        this._initAutoPauseCheckbox();
        this._resetMobileWaterfallPauseTimer();

        // All-device idle rate throttle: start the idle countdown from init.
        this._resetIdleRateThrottleTimer();
        const throttleMins = this._idleRateThrottleTimeout() / 60000;
        console.log(`[IdleDetector] Idle rate throttle armed: spectrum drops to divisor=2 after ${throttleMins} min idle (${this._isMobileDevice() ? 'mobile' : 'desktop'})`);
        
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

        // Mobile waterfall auto-pause: resume the waterfall if we auto-paused it,
        // then restart the idle timer regardless.
        if (this._mobileAutoPaused) {
            this._mobileWaterfallResume();
        }
        this._resetMobileWaterfallPauseTimer();

        // All-device idle rate throttle: restore full rate if we throttled it,
        // then restart the 1-minute countdown.
        if (this._idleThrottled) {
            this._idleRateRestore();
        }
        this._resetIdleRateThrottleTimer();
        
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
    
    // ── Mobile waterfall auto-pause ──────────────────────────────────────────

    /**
     * Returns true when the page is running on a real mobile device.
     * Uses window._isMobile set by app.js (UA + touch-points detection),
     * which is the same flag used for the 📱/🖥️ device emoji on the map overlay.
     */
    _isMobileDevice() {
        return !!window._isMobile;
    }

    /**
     * Initialise the "Pause" checkbox that controls whether the 5-minute
     * mobile auto-pause is active.  Only shown on mobile devices.
     * Preference is persisted in localStorage under 'waterfallAutoPause'.
     */
    _initAutoPauseCheckbox() {
        if (!this._isMobileDevice()) return;

        const label = document.getElementById('spectrum-label-autopause');
        const cb    = document.getElementById('spectrum-autopause-enable');
        if (!label || !cb) return;

        // Restore saved preference (default: enabled)
        const saved = localStorage.getItem('waterfallAutoPause');
        const enabled = saved === null ? true : saved === 'true';
        cb.checked = enabled;

        // Show the label (hidden by default so it never appears on desktop)
        label.style.display = 'flex';
    }

    /**
     * Returns true when the user has the auto-pause feature enabled.
     * Defaults to true if no preference has been saved yet.
     */
    _isAutoPauseEnabled() {
        const cb = document.getElementById('spectrum-autopause-enable');
        if (cb) return cb.checked;
        // Fall back to localStorage if the DOM element isn't available yet
        const saved = localStorage.getItem('waterfallAutoPause');
        return saved === null ? true : saved === 'true';
    }

    /**
     * Start (or restart) the 5-minute idle timer that auto-pauses the waterfall
     * on mobile.  Safe to call at any time — clears any existing timer first.
     */
    _resetMobileWaterfallPauseTimer() {
        if (this.mobileWaterfallPauseTimer) {
            clearTimeout(this.mobileWaterfallPauseTimer);
            this.mobileWaterfallPauseTimer = null;
        }
        // Only arm the timer on real mobile devices with auto-pause enabled
        if (!this._isMobileDevice()) return;
        if (!this._isAutoPauseEnabled()) return;

        this.mobileWaterfallPauseTimer = setTimeout(() => {
            this._mobileWaterfallAutoPause();
        }, this.MOBILE_WATERFALL_PAUSE_TIMEOUT);
    }

    // ── All-device idle rate throttle ────────────────────────────────────────

    /**
     * The idle period before the spectrum is throttled, in milliseconds.
     * 2.5 minutes on mobile (only when auto-pause is enabled), 5 minutes on
     * desktop and on mobile with auto-pause disabled.
     */
    _idleRateThrottleTimeout() {
        return (this._isMobileDevice() && this._isAutoPauseEnabled())
            ? this.IDLE_RATE_THROTTLE_TIMEOUT_MOBILE
            : this.IDLE_RATE_THROTTLE_TIMEOUT_DESKTOP;
    }

    /**
     * Start (or restart) the idle timer that drops the spectrum frame-rate
     * divisor to 2 (2.5 min on mobile, 5 min on desktop).
     * Safe to call at any time — clears any existing timer first.
     */
    _resetIdleRateThrottleTimer() {
        if (this.idleRateThrottleTimer) {
            clearTimeout(this.idleRateThrottleTimer);
            this.idleRateThrottleTimer = null;
        }
        this.idleRateThrottleTimer = setTimeout(() => {
            this._idleRateThrottle();
        }, this._idleRateThrottleTimeout());
        // No log here — this is called on every activity event (mousemove etc.)
        // and would spam the console. Transition logs are in _idleRateThrottle /
        // _idleRateRestore which fire only on actual state changes.
    }

    /**
     * Drop the spectrum WebSocket to divisor=3 after 1 minute of idle.
     * Only acts if the spectrum is currently at full rate (divisor=1, i.e.
     * the line graph is visible) — if it's already at 3 there's nothing to do.
     */
    _idleRateThrottle() {
        const sd = window.spectrumDisplay;
        if (!sd) return;
        const throttleMins = this._idleRateThrottleTimeout() / 60000;
        const lineGraphEnabled = localStorage.getItem('spectrumLineGraphEnabled') === 'true';
        if (!lineGraphEnabled) {
            console.log(`[IdleDetector] ${throttleMins} min idle — spectrum already at divisor=3 (line graph hidden), no change`);
            return;
        }
        // Use divisor=2 when spectrum line is visible — less aggressive than 3,
        // keeps the trace responsive while still saving bandwidth when idle.
        console.log(`[IdleDetector] ${throttleMins} min idle — throttling spectrum from divisor=1 → divisor=2 (line graph visible)`);
        this._idleThrottled = true;
        sd.setRate(2);
    }

    /**
     * Restore the spectrum frame rate to the correct divisor for the current
     * line-graph visibility state.  Called when the user becomes active again.
     */
    _idleRateRestore() {
        if (!this._idleThrottled) return;
        this._idleThrottled = false;
        const sd = window.spectrumDisplay;
        if (!sd) return;
        const lineGraphEnabled = localStorage.getItem('spectrumLineGraphEnabled') === 'true';
        const divisor = lineGraphEnabled ? 1 : 3;
        console.log(`[IdleDetector] User active after idle throttle — restoring spectrum to divisor=${divisor} (line graph ${lineGraphEnabled ? 'visible' : 'hidden'})`);
        sd.setRate(divisor);
    }

    // ── End all-device idle rate throttle ────────────────────────────────────

    /** Auto-pause the waterfall after 5 minutes of mobile idle. */
    _mobileWaterfallAutoPause() {
        if (!this._isMobileDevice()) return;
        if (!this._isAutoPauseEnabled()) return;

        const sd = window.spectrumDisplay;
        if (!sd) return;

        // Don't double-pause if already paused (user may have paused manually)
        if (sd._drawingPaused) return;

        console.log('[IdleDetector] Mobile idle 5 min — auto-pausing waterfall');
        this._mobileAutoPaused = true;

        // Pause via the same path as the manual pause button
        sd.userPause();

        // Sync the pause button UI (mirrors toggleWaterfallPause() in app.js)
        const pauseIcon = document.getElementById('waterfall-pause-icon');
        const playIcon  = document.getElementById('waterfall-play-icon');
        const btn       = document.getElementById('waterfall-pause-btn');
        const overlay   = document.getElementById('waterfall-pause-overlay');
        if (pauseIcon) pauseIcon.style.display = 'none';
        if (playIcon)  playIcon.style.display  = '';
        if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.title = 'Resume waterfall'; }
        if (overlay) {
            const canvas = document.getElementById('spectrum-display-canvas');
            if (canvas) {
                const r = canvas.getBoundingClientRect();
                const centreX = r.left + r.width / 2 + window.scrollX;
                overlay.style.left = centreX + 'px';
                overlay.style.top  = (250 + window.scrollY) + 'px';
            }
            overlay.style.display = 'flex';
        }

    }

    /** Resume the waterfall that was auto-paused by mobile idle detection. */
    _mobileWaterfallResume() {
        if (!this._mobileAutoPaused) return;
        this._mobileAutoPaused = false;

        const sd = window.spectrumDisplay;
        if (!sd || !sd._drawingPaused) return;

        console.log('[IdleDetector] User active — resuming auto-paused waterfall');
        sd.userResume();

        // Sync the pause button UI
        const pauseIcon = document.getElementById('waterfall-pause-icon');
        const playIcon  = document.getElementById('waterfall-play-icon');
        const btn       = document.getElementById('waterfall-pause-btn');
        const overlay   = document.getElementById('waterfall-pause-overlay');
        if (pauseIcon) pauseIcon.style.display = '';
        if (playIcon)  playIcon.style.display  = 'none';
        if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.title = 'Pause waterfall'; }
        if (overlay)   overlay.style.display   = 'none';

    }

    // ── End mobile waterfall auto-pause ──────────────────────────────────────

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
        if (this.mobileWaterfallPauseTimer) {
            clearTimeout(this.mobileWaterfallPauseTimer);
        }
        if (this.idleRateThrottleTimer) {
            clearTimeout(this.idleRateThrottleTimer);
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