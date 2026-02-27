// Screen Wake Lock Manager
// Prevents mobile browsers from suspending WebSocket connections by keeping screen on

class ScreenWakeLock {
    constructor() {
        this.wakeLock = null;
        this.isSupported = 'wakeLock' in navigator;
        this.isEnabled = false;
        
        // Log browser support
        if (this.isSupported) {
            console.log('✓ Wake Lock API supported');
        } else {
            console.log('⚠️ Wake Lock API not supported on this browser');
        }
        
        // Setup visibility change handler to re-acquire wake lock
        this.setupVisibilityHandler();
    }

    async enable() {
        if (!this.isSupported) {
            console.log('Wake Lock API not supported - screen may sleep on mobile');
            return false;
        }

        // Don't request if already enabled
        if (this.wakeLock !== null) {
            console.log('Wake lock already active');
            return true;
        }

        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            this.isEnabled = true;
            console.log('✓ Screen wake lock enabled - screen will stay on');

            // Listen for wake lock release
            this.wakeLock.addEventListener('release', () => {
                console.log('Wake lock was released');
                this.wakeLock = null;
            });

            return true;
        } catch (err) {
            // Common errors:
            // - NotAllowedError: User denied permission or not triggered by user gesture
            // - NotSupportedError: Wake Lock not supported
            console.error('Failed to enable wake lock:', err.name, err.message);
            return false;
        }
    }

    async disable() {
        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
                this.isEnabled = false;
                console.log('Wake lock disabled - screen can sleep normally');
            } catch (err) {
                console.error('Error releasing wake lock:', err);
            }
        }
    }

    setupVisibilityHandler() {
        // Re-acquire wake lock when page becomes visible again
        // This handles cases where:
        // - User switches tabs and comes back
        // - User locks phone and unlocks it
        // - Browser was backgrounded and brought to foreground
        document.addEventListener('visibilitychange', async () => {
            if (!document.hidden && this.isEnabled && this.wakeLock === null) {
                console.log('Page visible again - re-acquiring wake lock');
                await this.enable();
            }
        });
    }

    getStatus() {
        return {
            supported: this.isSupported,
            enabled: this.isEnabled,
            active: this.wakeLock !== null
        };
    }
}

// Create global instance
const screenWakeLock = new ScreenWakeLock();

// Expose to window for debugging and access from other modules
window.screenWakeLock = screenWakeLock;

// Export for ES6 modules
export { screenWakeLock };
