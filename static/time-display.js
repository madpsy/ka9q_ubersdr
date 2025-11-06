// Time Display Module
// Updates UTC and local time displays in bottom left corner

function updateTimeDisplay() {
    const utcTimeEl = document.getElementById('utc-time');
    const localTimeEl = document.getElementById('local-time');

    if (!utcTimeEl || !localTimeEl) return;

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
}

// Initialize time display
document.addEventListener('DOMContentLoaded', () => {
    // Update immediately
    updateTimeDisplay();
    // Update every second using simple setInterval (same as bandconditions.js)
    setInterval(() => {
        updateTimeDisplay();
    }, 1000);
});