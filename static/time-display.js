// Time Display Module
// Updates UTC, local time, and session countdown displays in bottom left corner

// Session tracking variables
let sessionStartTime = null;
let sessionMaxTime = null; // in seconds, 0 means unlimited

function updateTimeDisplay() {
    const utcTimeEl = document.getElementById('utc-time');
    const localTimeEl = document.getElementById('local-time');
    const sessionTimeEl = document.getElementById('session-time');

    if (!utcTimeEl || !localTimeEl || !sessionTimeEl) return;

    const now = new Date();

    // Format UTC time as HH:MM:SS using ISO string (same logic as bandconditions.js)
    const utcTime = now.toISOString().substr(11, 8) + ' UTC';

    // Format local time as HH:MM:SS using toLocaleTimeString for accuracy
    const localTime = now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }) + ' Local';

    utcTimeEl.textContent = utcTime;
    localTimeEl.textContent = localTime;

    // Update session countdown
    updateSessionCountdown(sessionTimeEl);
}

function updateSessionCountdown(sessionTimeEl) {
    if (!sessionTimeEl) return;

    // If we don't have session info yet, show loading
    if (sessionMaxTime === null) {
        sessionTimeEl.textContent = '--:--:-- Session';
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
        sessionTimeEl.textContent = '--:--:-- Session';
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

    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} Session`;
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

// Initialize time display
document.addEventListener('DOMContentLoaded', () => {
    // Update immediately
    updateTimeDisplay();

    // Update every second using simple setInterval (same as bandconditions.js)
    setInterval(() => {
        updateTimeDisplay();
    }, 1000);
});
