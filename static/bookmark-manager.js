// Bookmark Manager Module
// Handles loading, displaying, and interacting with frequency bookmarks

// Bookmarks array (exposed on window for spectrum-display.js access)
let bookmarks = [];
window.bookmarks = bookmarks;

// Bookmark positions for hover detection (exposed on window for spectrum-display.js access)
let bookmarkPositions = [];
window.bookmarkPositions = bookmarkPositions;

// Load bookmarks from server
async function loadBookmarks() {
    try {
        const response = await fetch('/api/bookmarks');
        if (response.ok) {
            bookmarks = await response.json();
            window.bookmarks = bookmarks; // Update window reference
            console.log(`Loaded ${bookmarks.length} bookmarks`);
            // Bookmarks will be drawn automatically when spectrum display draws
        } else {
            console.error('No bookmarks available');
        }
    } catch (err) {
        console.error('Failed to load bookmarks:', err);
    }
}

// Draw bookmark flags on the spectrum display (expose on window for spectrum-display.js access)
function drawBookmarksOnSpectrum(spectrumDisplay, log) {
    if (!spectrumDisplay || !bookmarks || bookmarks.length === 0) {
        bookmarkPositions = [];
        window.bookmarkPositions = bookmarkPositions;
        return;
    }

    const ctx = spectrumDisplay.overlayCtx;

    if (!ctx || !spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) {
        bookmarkPositions = [];
        window.bookmarkPositions = bookmarkPositions;
        return;
    }

    // Calculate frequency range (same as frequency cursor)
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Clear bookmark positions array
    bookmarkPositions = [];

    // Draw each bookmark that's within the visible range
    bookmarks.forEach(bookmark => {
        // Only draw if tuned frequency is within range (same check as cursor)
        if (bookmark.frequency < startFreq || bookmark.frequency > endFreq) {
            return;
        }

        // Calculate x position (same formula as frequency cursor at line 633)
        const x = ((bookmark.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Draw at same height as bandwidth marker (y=20)
        const labelY = 20;

        // Draw bookmark label (similar to frequency cursor but gold)
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Background for label
        const labelWidth = ctx.measureText(bookmark.name).width + 8;
        const labelHeight = 12;

        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)'; // Gold background
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = '#000000'; // Black text on gold background
        ctx.fillText(bookmark.name, x, labelY + 2);

        // Draw downward arrow below label (smaller than frequency cursor)
        const arrowY = labelY + labelHeight;
        const arrowLength = 6;
        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)';
        ctx.beginPath();
        ctx.moveTo(x, arrowY + arrowLength); // Arrow tip
        ctx.lineTo(x - 4, arrowY); // Left point
        ctx.lineTo(x + 4, arrowY); // Right point
        ctx.closePath();
        ctx.fill();

        // Arrow border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Store bookmark position for hover detection
        bookmarkPositions.push({
            x: x,
            y: labelY,
            width: labelWidth,
            height: labelHeight + arrowLength,
            bookmark: bookmark
        });
    });

    // Update window reference
    window.bookmarkPositions = bookmarkPositions;
}

// Handle bookmark click (expose on window for spectrum-display.js access)
// This function is called with just frequency and mode from spectrum-display.js
function handleBookmarkClick(frequency, mode) {
    // Access required functions from window object
    const wsManager = window.wsManager;
    const setMode = window.setMode;
    const updateBandButtons = window.updateBandButtons;
    const updateURL = window.updateURL;
    const connect = window.connect;
    const autoTune = window.autoTune;
    const spectrumDisplay = window.spectrumDisplay;
    const formatFrequency = window.formatFrequency;
    const log = window.log;

    // Set frequency
    const freqInput = document.getElementById('frequency');
    if (freqInput) {
        freqInput.value = frequency;
    }
    
    if (updateBandButtons) {
        updateBandButtons(frequency);
    }

    // Set mode (mode is already lowercase from JSON)
    if (setMode) {
        setMode(mode);
    }

    // Update URL
    if (updateURL) {
        updateURL();
    }

    // Connect if not connected, otherwise tune
    if (wsManager && connect && autoTune) {
        if (!wsManager.isConnected()) {
            connect();
        } else {
            autoTune();
        }
    }

    // Zoom spectrum to maximum (1 Hz/bin)
    if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Send zoom request directly to 1 Hz/bin for maximum zoom
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: 1.0  // Minimum bin bandwidth = maximum zoom
        }));
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${mode.toUpperCase()} (zoomed to max)`);
        }
    } else {
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${mode.toUpperCase()}`);
        }
    }
}

// Export functions
export {
    bookmarks,
    bookmarkPositions,
    loadBookmarks,
    drawBookmarksOnSpectrum,
    handleBookmarkClick
};

// Expose functions on window for spectrum-display.js access
window.drawBookmarksOnSpectrum = drawBookmarksOnSpectrum;
window.handleBookmarkClick = handleBookmarkClick;