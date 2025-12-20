// Bookmark Manager Module
// Handles loading, displaying, and interacting with frequency bookmarks

// Bookmarks array (exposed on window for spectrum-display.js access)
let bookmarks = [];
window.bookmarks = bookmarks;

// Bookmark positions for hover detection (exposed on window for spectrum-display.js access)
let bookmarkPositions = [];
window.bookmarkPositions = bookmarkPositions;

// Amateur Radio Bands array (loaded from server)
let amateurBands = [];
window.amateurBands = amateurBands;

// Color palette for bands (rainbow gradient)
const bandColors = [
    'rgba(255, 100, 100, 0.2)',   // Red
    'rgba(255, 150, 100, 0.2)',   // Orange-red
    'rgba(255, 200, 100, 0.2)',   // Orange
    'rgba(255, 255, 100, 0.2)',   // Yellow
    'rgba(200, 255, 100, 0.2)',   // Yellow-green
    'rgba(100, 255, 100, 0.2)',   // Green
    'rgba(100, 255, 200, 0.2)',   // Cyan-green
    'rgba(100, 200, 255, 0.2)',   // Cyan
    'rgba(100, 100, 255, 0.2)',   // Blue
    'rgba(150, 100, 255, 0.2)'    // Purple
];

// Draw amateur radio band backgrounds on the spectrum overlay
function drawAmateurBandBackgrounds(spectrumDisplay) {
    if (!spectrumDisplay || !spectrumDisplay.overlayCtx) {
        return;
    }

    const ctx = spectrumDisplay.overlayCtx;
    
    if (!spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) {
        return;
    }

    // Calculate visible frequency range
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Sort bands by width (widest first) so narrower bands are drawn on top
    const sortedBands = [...amateurBands].sort((a, b) => {
        const widthA = a.end - a.start;
        const widthB = b.end - b.start;
        return widthB - widthA; // Descending order (widest first)
    });

    // Draw band backgrounds for each amateur band that's visible
    sortedBands.forEach(band => {
        // Check if band overlaps with visible spectrum
        if (band.end >= startFreq && band.start <= endFreq) {
            // Calculate pixel positions
            const bandStartX = Math.max(0, ((band.start - startFreq) / spectrumDisplay.totalBandwidth) * spectrumDisplay.width);
            const bandEndX = Math.min(spectrumDisplay.width, ((band.end - startFreq) / spectrumDisplay.totalBandwidth) * spectrumDisplay.width);
            const bandWidth = bandEndX - bandStartX;
            
            if (bandWidth > 0) {
                // Draw semi-transparent colored rectangle (35px height for bookmark area)
                ctx.fillStyle = band.color;
                ctx.fillRect(bandStartX, 0, bandWidth, 35);

                // Prepare label styling
                ctx.font = 'bold 9px monospace';
                ctx.textBaseline = 'top';
                const labelText = band.name;
                const textWidth = ctx.measureText(labelText).width;
                const labelY = 2;
                const padding = 2;
                const labelWidth = textWidth + padding * 2;

                // Helper function to draw a label at a specific X position
                const drawLabel = (x) => {
                    // Ensure label stays within band boundaries
                    const minX = bandStartX + labelWidth / 2;
                    const maxX = bandEndX - labelWidth / 2;
                    const clampedX = Math.max(minX, Math.min(maxX, x));

                    // Background rectangle for text
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.fillRect(clampedX - labelWidth / 2, labelY, labelWidth, 10);

                    // Draw text (centered)
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
                    ctx.textAlign = 'center';
                    ctx.fillText(labelText, clampedX, labelY + 1);
                };

                // Intelligent label spacing that adapts to text length
                // For short labels (like "20m"), use default 180px spacing
                // For long labels, increase spacing to prevent overlap
                const baseSpacing = 180; // Base spacing for short labels
                const minGap = 20; // Minimum gap between labels
                const minRequiredSpacing = labelWidth + minGap;

                // Use the larger of base spacing or text-aware spacing
                const intelligentSpacing = Math.max(baseSpacing, minRequiredSpacing);

                // Minimum width thresholds
                const minWidthForAnyLabel = 30;
                const minWidthForMultipleLabels = intelligentSpacing;

                if (bandWidth < minWidthForAnyLabel) {
                    // Too narrow for any labels
                    return;
                } else if (bandWidth < minWidthForMultipleLabels) {
                    // Single label in center (only if label fits)
                    if (labelWidth <= bandWidth) {
                        drawLabel(bandStartX + bandWidth / 2);
                    }
                } else {
                    // Calculate number of labels based on intelligent spacing
                    // This ensures labels never overlap, regardless of text length
                    const numLabels = Math.max(2, Math.floor(bandWidth / intelligentSpacing) + 1);
                    const actualSpacing = bandWidth / (numLabels - 1);

                    // Draw labels at regular intervals
                    for (let i = 0; i < numLabels; i++) {
                        const x = bandStartX + (i * actualSpacing);
                        drawLabel(x);
                    }
                }
            }
        }
    });
}

// Load amateur radio bands from server
async function loadBands() {
    try {
        const response = await fetch('/api/bands');
        if (response.ok) {
            const bandsData = await response.json();
            // Add colors to bands
            amateurBands = bandsData.map((band, index) => ({
                ...band,
                name: band.label, // Add 'name' alias for compatibility
                color: bandColors[index % bandColors.length]
            }));
            window.amateurBands = amateurBands; // Update window reference
            console.log(`Loaded ${amateurBands.length} amateur radio bands`);
        } else {
            console.error('No bands available');
        }
    } catch (err) {
        console.error('Failed to load bands:', err);
    }
}

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
    // Draw amateur band backgrounds first (before bookmarks)
    drawAmateurBandBackgrounds(spectrumDisplay);

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
// This function is called with bookmark object from spectrum-display.js
function handleBookmarkClick(bookmarkOrFrequency, mode) {
    // Support both old API (frequency, mode) and new API (bookmark object)
    let frequency, bookmarkMode, extension;
    
    if (typeof bookmarkOrFrequency === 'object') {
        // New API: bookmark object
        frequency = bookmarkOrFrequency.frequency;
        bookmarkMode = bookmarkOrFrequency.mode;
        extension = bookmarkOrFrequency.extension;
    } else {
        // Old API: separate frequency and mode parameters
        frequency = bookmarkOrFrequency;
        bookmarkMode = mode;
    }
    
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
    const toggleExtension = window.toggleExtension;
    const radioAPI = window.radioAPI;

    // Set frequency (only if user is not currently editing it)
    const freqInput = document.getElementById('frequency');
    if (freqInput && document.activeElement !== freqInput) {
        freqInput.value = frequency;
    }
    
    if (updateBandButtons) {
        updateBandButtons(frequency);
    }

    // Set mode with proper bandwidth handling for CW modes
    if (setMode && bookmarkMode) {
        // For CW modes, set narrow bandwidth before changing mode
        if (bookmarkMode === 'cwu' || bookmarkMode === 'cwl') {
            if (radioAPI) {
                // Set CW bandwidth first
                radioAPI.setBandwidth(-200, 200);
                // Then set mode with bandwidth preservation
                radioAPI.setMode(bookmarkMode, true);
            } else {
                // Fallback if radioAPI not available
                setMode(bookmarkMode);
            }
        } else {
            // For non-CW modes, use default bandwidth
            setMode(bookmarkMode);
        }
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
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${bookmarkMode.toUpperCase()} (zoomed to max)`);
        }
    } else {
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${bookmarkMode.toUpperCase()}`);
        }
    }
    
    // Open extension if specified
    if (extension && toggleExtension) {
        // Small delay to ensure radio is tuned first
        setTimeout(() => {
            // Check if this extension is already active
            const panel = document.getElementById('extension-panel');
            const panelTitle = document.getElementById('extension-panel-title');
            const decoder = window.decoderManager ? window.decoderManager.getDecoder(extension) : null;

            const isPanelVisible = panel && panel.style.display !== 'none';
            const isShowingThisExtension = panelTitle && decoder && panelTitle.textContent === decoder.displayName;
            const isAlreadyActive = isPanelVisible && isShowingThisExtension;

            // Only toggle if not already active
            if (!isAlreadyActive) {
                toggleExtension(extension);
                if (log) {
                    log(`Opening ${extension} extension`);
                }
            } else if (log) {
                log(`${extension} extension already active`);
            }
        }, 100);
    }
}

// Export functions
export {
    bookmarks,
    bookmarkPositions,
    amateurBands,
    loadBands,
    loadBookmarks,
    drawAmateurBandBackgrounds,
    drawBookmarksOnSpectrum,
    handleBookmarkClick
};

// Expose functions on window for spectrum-display.js access
window.amateurBands = amateurBands;
window.loadBands = loadBands;
window.drawAmateurBandBackgrounds = drawAmateurBandBackgrounds;
window.drawBookmarksOnSpectrum = drawBookmarksOnSpectrum;
window.handleBookmarkClick = handleBookmarkClick;