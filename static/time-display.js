// Time Display Module
// Updates UTC and local time displays in bottom left corner

function updateTimeDisplay() {
    const utcTimeEl = document.getElementById('utc-time');
    const localTimeEl = document.getElementById('local-time');
    
    if (!utcTimeEl || !localTimeEl) return;
    
    const now = new Date();
    
    // Format UTC time as HH:MM:SS
    const utcHours = String(now.getUTCHours()).padStart(2, '0');
    const utcMinutes = String(now.getUTCMinutes()).padStart(2, '0');
    const utcSeconds = String(now.getUTCSeconds()).padStart(2, '0');
    const utcTime = `${utcHours}:${utcMinutes}:${utcSeconds} UTC`;
    
    // Format local time as HH:MM:SS
    const localHours = String(now.getHours()).padStart(2, '0');
    const localMinutes = String(now.getMinutes()).padStart(2, '0');
    const localSeconds = String(now.getSeconds()).padStart(2, '0');
    const localTime = `${localHours}:${localMinutes}:${localSeconds} Local`;
    
    utcTimeEl.textContent = utcTime;
    localTimeEl.textContent = localTime;
}

// Initialize time display
document.addEventListener('DOMContentLoaded', () => {
    // Update immediately
    updateTimeDisplay();
    
    // Update every second
    setInterval(updateTimeDisplay, 1000);
});