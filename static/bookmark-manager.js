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
                // Draw semi-transparent colored rectangle (45px height for bookmark area)
                ctx.fillStyle = band.color;
                ctx.fillRect(bandStartX, 0, bandWidth, 45);

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
        console.log('[bookmark-manager.js] loadBands() called');
        const response = await fetch('/api/bands');
        console.log('[bookmark-manager.js] Bands fetch response status:', response.status);
        if (response.ok) {
            const bandsData = await response.json();
            console.log('[bookmark-manager.js] Bands data received:', bandsData.length, 'bands');
            // Add colors to bands
            amateurBands = bandsData.map((band, index) => ({
                ...band,
                name: band.label, // Add 'name' alias for compatibility
                color: bandColors[index % bandColors.length]
            }));
            window.amateurBands = amateurBands; // Update window reference
            console.log(`[bookmark-manager.js] Loaded ${amateurBands.length} amateur radio bands`);
            console.log('[bookmark-manager.js] First band:', amateurBands[0]);
            console.log('[bookmark-manager.js] window.amateurBands set:', window.amateurBands.length);
            
            // Populate band dropdown after bands are loaded
            if (window.populateBandSelector) {
                console.log('[bookmark-manager.js] Calling populateBandSelector()');
                window.populateBandSelector();
            }
        } else {
            console.error('[bookmark-manager.js] No bands available, status:', response.status);
        }
    } catch (err) {
        console.error('[bookmark-manager.js] Failed to load bands:', err);
    }
}

// Load bookmarks from server
async function loadBookmarks() {
    try {
        console.log('[bookmark-manager.js] loadBookmarks() called');
        const response = await fetch('/api/bookmarks');
        console.log('[bookmark-manager.js] Fetch response status:', response.status);
        if (response.ok) {
            bookmarks = await response.json();
            window.bookmarks = bookmarks; // Update window reference
            console.log(`[bookmark-manager.js] Loaded ${bookmarks.length} bookmarks`);
            console.log('[bookmark-manager.js] First bookmark:', bookmarks[0]);
            console.log('[bookmark-manager.js] window.bookmarks set:', window.bookmarks.length);
            
            // Populate bookmark dropdown after bookmarks are loaded
            if (window.populateBookmarkSelector) {
                console.log('[bookmark-manager.js] Calling populateBookmarkSelector()');
                window.populateBookmarkSelector();
            }
        } else {
            console.error('[bookmark-manager.js] No bookmarks available, status:', response.status);
        }
    } catch (err) {
        console.error('[bookmark-manager.js] Failed to load bookmarks:', err);
    }
}

// Draw bookmark flags on the spectrum display (expose on window for spectrum-display.js access)
function drawBookmarksOnSpectrum(spectrumDisplay, log) {
    // Note: Band backgrounds are now drawn separately in spectrum-display.js
    // to control z-index ordering with chat markers
    // drawAmateurBandBackgrounds(spectrumDisplay); // Commented out - drawn separately

    // Merge server and local bookmarks
    const localBookmarks = window.localBookmarksUI ? window.localBookmarksUI.manager.getAll() : [];
    const allBookmarks = [
        ...bookmarks.map(b => ({...b, source: 'server'})),
        ...localBookmarks.map(b => ({...b, source: 'local'}))
    ];

    // Update window.bookmarks to include local bookmarks for click detection
    window.bookmarks = allBookmarks;

    if (!spectrumDisplay || !allBookmarks || allBookmarks.length === 0) {
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

    // First pass: calculate positions for visible bookmarks
    const visibleBookmarks = [];
    allBookmarks.forEach(bookmark => {
        // Only process if tuned frequency is within range
        if (bookmark.frequency < startFreq || bookmark.frequency > endFreq) {
            return;
        }

        // Calculate x position
        const x = ((bookmark.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Measure label width
        ctx.font = 'bold 10px monospace';
        const labelWidth = ctx.measureText(bookmark.name).width + 8;

        visibleBookmarks.push({
            bookmark: bookmark,
            x: x,
            labelWidth: labelWidth,
            row: 0  // Will be assigned: 0 = bottom row, 1 = top row
        });
    });

    // Sort by x position
    visibleBookmarks.sort((a, b) => a.x - b.x);

    // Simple two-row collision detection
    // Assign bookmarks to rows to avoid overlaps
    const row0Bookmarks = []; // Bottom row
    const row1Bookmarks = []; // Top row

    visibleBookmarks.forEach(current => {
        // Check if it overlaps with any bookmark in row 0
        const overlapsRow0 = row0Bookmarks.some(other => {
            const currentLeft = current.x - current.labelWidth / 2;
            const currentRight = current.x + current.labelWidth / 2;
            const otherLeft = other.x - other.labelWidth / 2;
            const otherRight = other.x + other.labelWidth / 2;
            // 3px gap threshold
            return !(currentRight + 3 < otherLeft || currentLeft - 3 > otherRight);
        });

        if (!overlapsRow0) {
            // No overlap in row 0, place it there
            current.row = 0;
            row0Bookmarks.push(current);
        } else {
            // Overlaps row 0, try row 1
            const overlapsRow1 = row1Bookmarks.some(other => {
                const currentLeft = current.x - current.labelWidth / 2;
                const currentRight = current.x + current.labelWidth / 2;
                const otherLeft = other.x - other.labelWidth / 2;
                const otherRight = other.x + other.labelWidth / 2;
                return !(currentRight + 3 < otherLeft || currentLeft - 3 > otherRight);
            });

            if (!overlapsRow1) {
                // No overlap in row 1, place it there
                current.row = 1;
                row1Bookmarks.push(current);
            } else {
                // Overlaps both rows - place in row 0 anyway (will overlap)
                current.row = 0;
                row0Bookmarks.push(current);
            }
        }
    });

    // Draw bookmarks with row assignments
    const labelHeight = 12;
    const arrowLength = 6;
    const rowSpacing = 15; // Vertical spacing between rows (increased from 13)

    // Sort bookmarks: server first (bottom layer), then local (top layer)
    // Within each group, draw row 1 first, then row 0
    const sortedBookmarks = [...visibleBookmarks].sort((a, b) => {
        // First sort by source (server=0, local=1)
        const sourceA = a.bookmark.source === 'local' ? 1 : 0;
        const sourceB = b.bookmark.source === 'local' ? 1 : 0;
        if (sourceA !== sourceB) return sourceA - sourceB;
        // Then by row (1 before 0)
        return b.row - a.row;
    });

    sortedBookmarks.forEach(item => {
        const { bookmark, x, labelWidth, row } = item;
        // Row 0 at y=32, Row 1 at y=17 (32 - 15) - shifted down to avoid band name overlap
        const labelY = 32 - (row * rowSpacing);

        // Choose colors based on source
        const isLocal = bookmark.source === 'local';
        const bgColor = isLocal ? 'rgba(52, 152, 219, 0.95)' : 'rgba(255, 215, 0, 0.95)'; // Blue for local, gold for server
        const textColor = isLocal ? '#ffffff' : '#000000'; // White text on blue, black on gold

        // Draw bookmark label
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Background for label
        ctx.fillStyle = bgColor;
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = textColor;
        ctx.fillText(bookmark.name, x, labelY + 2);

        // Draw downward arrow - extends from label to baseline
        const arrowStartY = labelY + labelHeight;
        const arrowTipY = 32 + labelHeight + arrowLength; // Always point to same baseline (adjusted for new position)
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.moveTo(x, arrowTipY); // Arrow tip at baseline
        ctx.lineTo(x - 4, arrowStartY); // Left point at label bottom
        ctx.lineTo(x + 4, arrowStartY); // Right point at label bottom
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
            height: labelHeight + (arrowTipY - arrowStartY),
            bookmark: bookmark,
            comment: bookmark.comment || null
        });
    });

    // Update window reference
    window.bookmarkPositions = bookmarkPositions;
}

// Handle bookmark click (expose on window for spectrum-display.js access)
// This function is called with bookmark object from spectrum-display.js
// Second parameter can be either mode (old API) or shouldZoom boolean (new API with modifier key)
// Third parameter indicates if click came from spectrum marker (true) or dropdown (false/undefined)
function handleBookmarkClick(bookmarkOrFrequency, modeOrShouldZoom, fromSpectrumMarker) {
    // Support both old API (frequency, mode) and new API (bookmark object, shouldZoom)
    let frequency, bookmarkMode, extension, shouldZoom, bandwidthLow, bandwidthHigh;
    
    if (typeof bookmarkOrFrequency === 'object') {
        // New API: bookmark object
        frequency = bookmarkOrFrequency.frequency;
        bookmarkMode = bookmarkOrFrequency.mode;
        extension = bookmarkOrFrequency.extension;
        bandwidthLow = bookmarkOrFrequency.bandwidth_low;
        bandwidthHigh = bookmarkOrFrequency.bandwidth_high;
        // Second parameter is shouldZoom boolean (true if Shift/Ctrl held)
        shouldZoom = typeof modeOrShouldZoom === 'boolean' ? modeOrShouldZoom : false;
    } else {
        // Old API: separate frequency and mode parameters
        frequency = bookmarkOrFrequency;
        bookmarkMode = modeOrShouldZoom;
        shouldZoom = false; // Default to no zoom for old API
    }

    // Default fromSpectrumMarker to false if not provided (e.g., from dropdown)
    fromSpectrumMarker = fromSpectrumMarker === true;
    
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
        if (window.setFrequencyInputValue) {
            window.setFrequencyInputValue(frequency);
        } else {
            freqInput.value = frequency;
        }
    }
    
    if (updateBandButtons) {
        updateBandButtons(frequency);
    }

    // Set mode with proper bandwidth handling for CW modes
    if (setMode && bookmarkMode) {
        // For CW modes, set narrow bandwidth before changing mode
        if (bookmarkMode === 'cwu' || bookmarkMode === 'cwl') {
            if (radioAPI) {
                // Set CW bandwidth first (use bookmark bandwidth if available)
                if (bandwidthLow !== undefined && bandwidthLow !== null &&
                    bandwidthHigh !== undefined && bandwidthHigh !== null) {
                    radioAPI.setBandwidth(bandwidthLow, bandwidthHigh);
                } else {
                    radioAPI.setBandwidth(-200, 200);
                }
                // Then set mode with bandwidth preservation
                radioAPI.setMode(bookmarkMode, true);
            } else {
                // Fallback if radioAPI not available
                setMode(bookmarkMode);
            }
        } else {
            // For non-CW modes, set mode first then bandwidth
            setMode(bookmarkMode);
            
            // Apply bookmark bandwidth if available
            if (radioAPI && bandwidthLow !== undefined && bandwidthLow !== null &&
                bandwidthHigh !== undefined && bandwidthHigh !== null) {
                radioAPI.setBandwidth(bandwidthLow, bandwidthHigh);
            }
        }
    }

    // Update URL
    if (updateURL) {
        updateURL();
    }

    // Set skipNextPan flag to prevent auto-centering only when clicking spectrum marker
    // (not from dropdown, as dropdown selections may be outside visible spectrum)
    if (!shouldZoom && fromSpectrumMarker && spectrumDisplay) {
        spectrumDisplay.skipNextPan = true;
    }

    // Connect if not connected, otherwise tune
    if (wsManager && connect && autoTune) {
        if (!wsManager.isConnected()) {
            connect();
        } else {
            autoTune();
        }
    }

    // Only zoom/center spectrum if Shift or Ctrl key was held
    if (shouldZoom && spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Send zoom request to center and zoom to 1 Hz/bin for maximum zoom
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: 1.0  // Minimum bin bandwidth = maximum zoom
        }));
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${bookmarkMode.toUpperCase()} (centered and zoomed)`);
        }
    } else if (!fromSpectrumMarker) {
        // For dropdown selections, send pan request to center on bookmark
        if (spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
            // Set flag to prevent edge detection from interfering after pan
            spectrumDisplay.skipEdgeDetectionTemporary = true;
            // Clear the flag after a short delay (after pan completes)
            setTimeout(() => {
                if (spectrumDisplay) {
                    spectrumDisplay.skipEdgeDetectionTemporary = false;
                }
            }, 2000);

            spectrumDisplay.ws.send(JSON.stringify({
                type: 'pan',
                frequency: frequency
            }));
        }
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${bookmarkMode.toUpperCase()}`);
        }
    } else {
        if (log && formatFrequency) {
            log(`Tuned to bookmark: ${formatFrequency(frequency)} ${bookmarkMode.toUpperCase()} (hold Shift/Ctrl to center/zoom)`);
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