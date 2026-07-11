// Time Display Module
// Updates UTC, local time, and session countdown displays in bottom left corner

// Session tracking variables
let sessionStartTime = null;
let sessionMaxTime = null; // in seconds, 0 means unlimited

// Format a Date as HH:MM:SS using its UTC fields (so we can apply our own offset)
function _fmtHHMMSS(date) {
    const h = String(date.getUTCHours()).padStart(2, '0');
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function updateTimeDisplay() {
    const utcTimeEl = document.getElementById('utc-time');
    const localTimeEl = document.getElementById('local-time');
    const sessionTimeEl = document.getElementById('session-time');

    if (!utcTimeEl || !localTimeEl || !sessionTimeEl) return;

    const now = new Date();

    // Format UTC time as HH:MM:SS using ISO string (same logic as bandconditions.js)
    const utcTime = now.toISOString().substr(11, 8) + ' UTC';
    utcTimeEl.textContent = utcTime;

    // Server local time: read timezone_offset (minutes) from the globally cached
    // window.instanceDescription (populated by fetchSiteDescription() in app.js).
    // Read lazily on every tick so we pick it up as soon as it becomes available
    // without needing a separate fetch or polling loop.
    const tzOffset = window.instanceDescription?.receiver?.timezone_offset;
    if (typeof tzOffset === 'number') {
        // Shift UTC epoch by the server's configured offset
        const serverDate = new Date(now.getTime() + tzOffset * 60 * 1000);
        localTimeEl.textContent = _fmtHHMMSS(serverDate) + ' Local';
    } else {
        // Fallback to client local time until instanceDescription is populated
        localTimeEl.textContent = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }) + ' Local';
    }

    // Update session countdown
    updateSessionCountdown(sessionTimeEl);
}

function updateSessionCountdown(sessionTimeEl) {
    if (!sessionTimeEl) return;

    // If we don't have session info yet, show loading
    if (sessionMaxTime === null) {
        sessionTimeEl.textContent = '--:--:-- Max';
        sessionTimeEl.style.color = '';
        return;
    }

    // If session is unlimited (0), show "Unlimited"
    if (sessionMaxTime === 0) {
        sessionTimeEl.textContent = 'Unlimited';
        sessionTimeEl.style.color = '';
        return;
    }

    // Calculate time remaining
    if (!sessionStartTime) {
        sessionTimeEl.textContent = '--:--:-- Max';
        sessionTimeEl.style.color = '';
        return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.floor((now - sessionStartTime) / 1000);
    const remainingSeconds = Math.max(0, sessionMaxTime - elapsedSeconds);

    // Format as HH:MM:SS
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;

    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} Max`;
    sessionTimeEl.textContent = timeString;

    // Turn red if less than 5 minutes remaining
    if (remainingSeconds < 300) {
        sessionTimeEl.style.color = '#dc3545'; // Red
    } else {
        sessionTimeEl.style.color = '';
    }
}

// Function to set session info (called from app.js after /connection fetch)
function setSessionInfo(maxSessionTime) {
    sessionMaxTime = maxSessionTime !== undefined ? maxSessionTime : null;
    sessionStartTime = Date.now();

    console.log('Session info set:', {
        maxTime: sessionMaxTime,
        unlimited: sessionMaxTime === 0
    });
}

// Expose function globally so app.js can call it
window.setSessionInfo = setSessionInfo;

// Expose current session timing so other modules (e.g. Media Session) can
// align with the bottom-left session countdown. Returns null until known.
// maxTime: seconds (0 = unlimited), startTime: epoch ms, remaining: seconds.
window.getSessionTiming = function getSessionTiming() {
    if (sessionMaxTime === null || sessionStartTime === null) return null;
    const elapsedSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
    const remaining = sessionMaxTime === 0
        ? 0
        : Math.max(0, sessionMaxTime - elapsedSeconds);
    return {
        maxTime: sessionMaxTime,
        startTime: sessionStartTime,
        unlimited: sessionMaxTime === 0,
        elapsed: elapsedSeconds,
        remaining: remaining
    };
};

// Initialize time display
document.addEventListener('DOMContentLoaded', () => {
    // Update immediately
    updateTimeDisplay();

    // Update every second using simple setInterval (same as bandconditions.js)
    setInterval(() => {
        updateTimeDisplay();
    }, 1000);
});
