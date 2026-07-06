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

// Generate the band colour palette from an intensity value (0.5–1.0).
// Range starts at 0.5 (the minimum/default) and goes to 1.0 (vivid).
//
//   i=0.5: alpha=0.20, floor=100  — original pastel appearance (default)
//   i=1.0: alpha=0.80, floor=0    — vivid, fully saturated
//
// Linear interpolation across the usable range [0.5, 1.0].
// At i=0.5, floor=100, so Red = rgba(255, 100, 100, 0.20) — exactly the original hardcoded value.
// Falls back to 0.5 if the value is missing, invalid, or below 0.5.
function generateBandColors(intensity) {
    const i = (typeof intensity === 'number' && isFinite(intensity))
        ? Math.max(0.5, Math.min(1, intensity))
        : 0.5;

    // Linear: 0.20 at i=0.5, 0.80 at i=1.0
    const alpha = +(0.20 + (i - 0.5) * 1.20).toFixed(3);

    // Linear floor: 100 at i=0.5, 0 at i=1.0
    const f = Math.round(100 - (i - 0.5) * 200);

    // Clamp each channel to [0, 255]
    const c = (v) => Math.min(255, Math.max(0, v));

    return [
        `rgba(255, ${c(f)},    ${c(f)},    ${alpha})`,   // Red
        `rgba(255, ${c(f+50)}, ${c(f)},    ${alpha})`,   // Orange-red
        `rgba(255, ${c(f+100)},${c(f)},    ${alpha})`,   // Orange
        `rgba(255, 255,        ${c(f)},    ${alpha})`,   // Yellow
        `rgba(${c(f+100)}, 255,${c(f)},    ${alpha})`,   // Yellow-green
        `rgba(${c(f)},    255, ${c(f)},    ${alpha})`,   // Green
        `rgba(${c(f)},    255, ${c(f+100)},${alpha})`,   // Cyan-green
        `rgba(${c(f)},    ${c(f+100)}, 255,${alpha})`,   // Cyan
        `rgba(${c(f)},    ${c(f)},    255, ${alpha})`,   // Blue
        `rgba(${c(f+50)}, ${c(f)},    255, ${alpha})`,   // Purple
    ];
}

// Resolved lazily in loadBands() once window.serverUIConfig is populated.
// Falls back to intensity=0.5 (original pastel appearance) if the endpoint is
// unavailable or the key is absent — no localStorage, owner-only setting.
let bandColors = generateBandColors(0.5);

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
            // Re-resolve the colour palette now that window.serverUIConfig is populated
            bandColors = generateBandColors(
                window.serverUIConfig?.band_color_intensity ?? 0.5
            );
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

            // Render custom quick-tune band buttons (bands with button_name set)
            renderCustomBandButtons();
        } else {
            console.error('[bookmark-manager.js] No bands available, status:', response.status);
        }
    } catch (err) {
        console.error('[bookmark-manager.js] Failed to load bands:', err);
    }
}

/**
 * Render the custom quick-tune band button row below the 160m–10m badges.
 * Only shown when at least one band has a button_name set.
 * Clicking a button tunes to the center of that band (reusing selectBandFromDropdown).
 */
function renderCustomBandButtons() {
    const row = document.getElementById('custom-band-buttons-row');
    const container = document.getElementById('custom-band-buttons-container');
    if (!row || !container) return;

    // Filter bands that have a button_name
    const customBands = (window.amateurBands || []).filter(b => b.button_name && b.button_name.trim() !== '');

    if (customBands.length === 0) {
        row.style.display = 'none';
        return;
    }

    // Build buttons
    container.innerHTML = '';
    customBands.forEach(band => {
        const centerHz = Math.round((band.start + band.end) / 2);
        const startKHz = (band.start / 1000).toFixed(1);
        const endKHz   = (band.end   / 1000).toFixed(1);

        // Build tooltip: label, freq range, group, mode
        let tooltip = `${band.label}\n${startKHz}–${endKHz} kHz`;
        if (band.group) tooltip += `\nGroup: ${band.group}`;
        if (band.mode)  tooltip += `\nMode: ${band.mode.toUpperCase()}`;

        const btn = document.createElement('div');
        btn.className = 'band-status-badge custom-band-button';
        btn.setAttribute('data-status', 'EXCELLENT'); // always green
        btn.setAttribute('title', tooltip);
        btn.textContent = band.button_name;
        btn.style.cursor = 'pointer';

        btn.addEventListener('click', () => {
            const centerHz = Math.round((band.start + band.end) / 2);
            // Use selectBandFromDropdown for full tuning parity (freq, mode, zoom, URL, auto-connect)
            if (typeof selectBandFromDropdown === 'function') {
                selectBandFromDropdown(JSON.stringify({
                    label: band.label,
                    start: band.start,
                    end:   band.end
                }));
            }
            // Fire extras that selectBandFromDropdown doesn't cover (same as setBand does)
            if (window.ttsAnnouncements && window.ttsAnnouncements.isEnabled()) {
                window.ttsAnnouncements.announceFrequencyChange(centerHz);
            }
            if (typeof updateVoiceActivityPopup === 'function') {
                updateVoiceActivityPopup(band.label);
            }
            if (window.radioAPI) {
                window.radioAPI.notifyFrequencyChange(centerHz);
            }
        });

        container.appendChild(btn);
    });

    row.style.display = '';
}

// Expose so it can be called externally if bands are reloaded
window.renderCustomBandButtons = renderCustomBandButtons;

// Load bookmarks from server
// Shared offscreen canvas context used to pre-measure label widths once at load time.
// Re-used by _stampLabelWidth() so we never call measureText() inside the hot draw path.
let _measureCtx = null;
function _getMeasureCtx() {
    if (!_measureCtx) {
        _measureCtx = document.createElement('canvas').getContext('2d');
        _measureCtx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    }
    return _measureCtx;
}

/** Stamp b._labelWidth in-place if not already set. */
function _stampLabelWidth(b) {
    if (!b._labelWidth) {
        b._labelWidth = _getMeasureCtx().measureText(b.name).width + 8;
    }
}
// Expose on window so local-bookmarks.js write paths can call it without a module import
window._stampLabelWidth = _stampLabelWidth;

async function loadBookmarks() {
    try {
        console.log('[bookmark-manager.js] loadBookmarks() called');
        const response = await fetch('/api/bookmarks');
        console.log('[bookmark-manager.js] Fetch response status:', response.status);
        if (response.ok) {
            bookmarks = await response.json();
            // Pre-cache label widths once so the hot draw path never calls measureText()
            bookmarks.forEach(_stampLabelWidth);
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

// Merge server + local bookmarks into window.bookmarks (the array read by click
// detection, the dial-wheel/VU-meter marker overlay and Media Session album).
// Kept synchronous so callers reacting to a bookmark change can refresh
// marker-derived UI immediately, without waiting for the next spectrum render.
function rebuildMergedBookmarks() {
    const localBookmarks = window.localBookmarksUI ? window.localBookmarksUI.manager.getAll() : [];
    const allBookmarks = [
        ...bookmarks.map(b => ({...b, source: 'server'})),
        ...localBookmarks.map(b => ({...b, source: 'local'}))
    ];
    window.bookmarks = allBookmarks;
    return allBookmarks;
}
window.rebuildMergedBookmarks = rebuildMergedBookmarks;

// Draw bookmark flags on the spectrum display (expose on window for spectrum-display.js access)
function drawBookmarksOnSpectrum(spectrumDisplay, log) {
    // Note: Band backgrounds are now drawn separately in spectrum-display.js
    // to control z-index ordering with chat markers
    // drawAmateurBandBackgrounds(spectrumDisplay); // Commented out - drawn separately

    // Merge server and local bookmarks (updates window.bookmarks for click detection)
    const allBookmarks = rebuildMergedBookmarks();

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

    // Sort allBookmarks by frequency so binary search works.
    // The server array is already sorted; local bookmarks may not be — sort the merged array.
    allBookmarks.sort((a, b) => a.frequency - b.frequency);

    // Binary search: find first index where frequency >= target
    function lowerBound(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid].frequency < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Slice to only the visible frequency window — O(log n) instead of O(n)
    const iStart = lowerBound(allBookmarks, startFreq);
    const iEnd   = lowerBound(allBookmarks, endFreq);
    const windowBookmarks = allBookmarks.slice(iStart, iEnd + 1).filter(
        b => b.frequency >= startFreq && b.frequency <= endFreq
    );

    // First pass: calculate positions for visible bookmarks
    const visibleBookmarks = [];
    windowBookmarks.forEach(bookmark => {
        // Calculate x position
        const x = ((bookmark.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Use pre-cached label width; fall back to measureText() only if missing
        // (e.g. a local bookmark added before _stampLabelWidth ran)
        const labelWidth = bookmark._labelWidth || (ctx.measureText(bookmark.name).width + 8);

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

    // Fix 3 — Density cap: when the visible window contains more bookmarks than can
    // be meaningfully rendered (e.g. zoomed all the way out with 1500 bookmarks), cap
    // the draw list to avoid thousands of canvas API calls per frame.
    // Local (user-added) bookmarks are always kept; server bookmarks are evenly sampled
    // across the full visible frequency range so labels are spread across the whole canvas.
    const MAX_RENDERABLE = 100; // two rows × ~50 labels across a typical 1920px canvas
    let cappedBookmarks;
    if (visibleBookmarks.length > MAX_RENDERABLE) {
        const localItems  = visibleBookmarks.filter(item => item.bookmark.source === 'local');
        const serverItems = visibleBookmarks.filter(item => item.bookmark.source !== 'local');
        const serverSlot  = Math.max(0, MAX_RENDERABLE - localItems.length);
        // Evenly sample server bookmarks across the sorted (by x) array so the result
        // is spread across the full visible width rather than bunched at one end.
        let sampledServer;
        if (serverItems.length <= serverSlot) {
            sampledServer = serverItems;
        } else {
            sampledServer = [];
            const step = serverItems.length / serverSlot;
            for (let i = 0; i < serverSlot; i++) {
                sampledServer.push(serverItems[Math.round(i * step)]);
            }
        }
        cappedBookmarks = localItems.concat(sampledServer);
    } else {
        cappedBookmarks = visibleBookmarks;
    }

    // Draw bookmarks with row assignments
    const labelHeight = 12;
    const arrowLength = 6;
    const rowSpacing = 15; // Vertical spacing between rows (increased from 13)

    // Sort bookmarks: server first (bottom layer), then local (top layer)
    // Within each group, draw row 1 first, then row 0
    const sortedBookmarks = [...cappedBookmarks].sort((a, b) => {
        // First sort by source (server=0, local=1)
        const sourceA = a.bookmark.source === 'local' ? 1 : 0;
        const sourceB = b.bookmark.source === 'local' ? 1 : 0;
        if (sourceA !== sourceB) return sourceA - sourceB;
        // Then by row (1 before 0)
        return b.row - a.row;
    });

    // Set font once outside the loop — avoids repeated style recalculation
    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    sortedBookmarks.forEach(item => {
        const { bookmark, x, labelWidth, row } = item;
        // Row 0 at y=30, Row 1 at y=15 (30 - 15) - shifted up 2px to clear the black freq notch at y=45
        const labelY = 30 - (row * rowSpacing);

        // Choose colors based on source
        const isLocal = bookmark.source === 'local';
        const bgColor = isLocal ? 'rgba(52, 152, 219, 0.95)' : 'rgba(255, 215, 0, 0.95)'; // Blue for local, gold for server
        const textColor = isLocal ? '#ffffff' : '#000000'; // White text on blue, black on gold

        // Background for label (ctx.font/textAlign/textBaseline set once above the loop)
        ctx.fillStyle = bgColor;
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = textColor;
        ctx.fillText(bookmark.name, x, labelY + labelHeight / 2);

        // Draw downward arrow - extends from label to baseline
        const arrowStartY = labelY + labelHeight;
        const arrowTipY = 30 + labelHeight + arrowLength; // Always point to same baseline
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

    // Modes supported by UberSDR's demodulator pipeline
    const SUPPORTED_MODES = new Set(['usb', 'lsb', 'am', 'sam', 'cwu', 'cwl', 'fm', 'nfm']);

    // Track whether setMode() was called — it calls autoTune() internally, so we must
    // NOT call autoTune() again at the end of this function.  Sending two tune messages
    // in rapid succession causes the server to restart the audio stream twice, producing
    // an audible stutter gap (especially noticeable on Android when switching between
    // modes with different sample rates, e.g. LSB → AM).
    let setModeCalled = false;

    // Set mode with proper bandwidth handling for CW modes
    if (setMode && bookmarkMode) {
        if (!SUPPORTED_MODES.has(bookmarkMode)) {
            // Unsupported mode (e.g. drm, iq, wfm, ecss from KiwiSDR bookmarks) —
            // skip the mode change to avoid corrupting the audio pipeline.
            if (log) {
                log(`Bookmark mode "${bookmarkMode}" is not supported by UberSDR — keeping current mode`);
            }
        } else if (bookmarkMode === 'cwu' || bookmarkMode === 'cwl') {
            // For CW modes, set narrow bandwidth before changing mode
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
            setModeCalled = true;
        } else {
            // For non-CW modes: if the bookmark carries custom bandwidth, apply it
            // using the same pattern as the CW path above:
            //   1. radioAPI.setBandwidth() — sets sliders, window globals, AND the
            //      module-local currentBandwidthLow/High in app.js (via updateBandwidth())
            //   2. setMode(mode, preserveBandwidth=true) — reads those pre-loaded values
            //      and fires a single autoTune() with the correct bandwidth.
            // Without step 1, setMode(preserve=true) would read the old local variable
            // value and send the wrong bandwidth.
            if (radioAPI && bandwidthLow !== undefined && bandwidthLow !== null &&
                bandwidthHigh !== undefined && bandwidthHigh !== null) {
                radioAPI.setBandwidth(bandwidthLow, bandwidthHigh);
                setMode(bookmarkMode, true);
            } else {
                // No custom bandwidth — let setMode reset to mode defaults as normal.
                setMode(bookmarkMode);
            }
            setModeCalled = true;
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

    // Connect if not connected, otherwise tune.
    // IMPORTANT: setMode() already calls autoTune() internally (which sends a tune
    // message to the server).  Only call autoTune() here if setMode was NOT called —
    // sending two tune messages in rapid succession causes the server to restart the
    // audio stream twice, producing an audible stutter gap on mode switches.
    if (wsManager && connect && autoTune) {
        if (!wsManager.isConnected()) {
            connect();
        } else if (!setModeCalled) {
            // setMode() was not called (no mode, unsupported mode) — send tune manually
            autoTune();
        }
        // else: setMode() already sent the tune — no second message needed
    }

    // Only zoom/center spectrum if Shift or Ctrl key was held
    if (shouldZoom && spectrumDisplay && spectrumDisplay.connected && spectrumDisplay.ws) {
        // Send zoom request to center and zoom to 10 Hz/bin — the maximum zoom for normal UI.
        // The server supports down to 0.5 Hz/bin but that is only reachable via explicit requests.
        spectrumDisplay.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: frequency,
            binBandwidth: 10.0  // 10 Hz/bin = maximum zoom for normal UI operation
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
// ── Strong Signal Brackets ────────────────────────────────────────────────────
// Detects the top-5 signals clearly above the noise floor and draws a red
// bracket (flat top bar + short downward legs) at y=0 of the overlay canvas.
//
// Detection runs at most once every BRACKET_UPDATE_INTERVAL_MS (2 s).
// Uses the EMA-smoothed spectrum (specEma) for stability.
// Hysteresis: appear at +15 dB above noise, disappear below +8 dB.
// ─────────────────────────────────────────────────────────────────────────────
const BRACKET_UPDATE_INTERVAL_MS = 2000;
const BRACKET_APPEAR_THRESHOLD_DB = 15;  // dB above noise to appear
const BRACKET_DISAPPEAR_THRESHOLD_DB = 8; // dB above noise to disappear
const BRACKET_TOP_SIGNALS = 5;
const BRACKET_MIN_BINS = 3; // ignore single-bin spikes

// Persistent state (survives across markerCache rebuilds)
let _bracketLastUpdateTime = 0;
let _bracketActive = []; // [{freqLow, freqHigh, peakFreq, peakDb, noiseDb}]

function _estimateNoiseFloor(data) {
    // 15th-percentile of the current frame — robust against strong signals
    const sorted = new Float32Array(data).sort();
    return sorted[Math.floor(sorted.length * 0.15)];
}

function _detectSignalRuns(data, noiseFloor, appearThreshold) {
    const threshold = noiseFloor + appearThreshold;
    const runs = [];
    let inRun = false;
    let runStart = 0;
    let peakIdx = 0;
    let peakDb = -Infinity;

    for (let i = 0; i < data.length; i++) {
        if (data[i] >= threshold) {
            if (!inRun) {
                inRun = true;
                runStart = i;
                peakIdx = i;
                peakDb = data[i];
            } else if (data[i] > peakDb) {
                peakDb = data[i];
                peakIdx = i;
            }
        } else {
            if (inRun) {
                inRun = false;
                const runLen = i - runStart;
                if (runLen >= BRACKET_MIN_BINS) {
                    runs.push({ startBin: runStart, endBin: i - 1, peakBin: peakIdx, peakDb });
                }
                peakDb = -Infinity;
            }
        }
    }
    // Close any open run at end of data
    if (inRun) {
        const runLen = data.length - runStart;
        if (runLen >= BRACKET_MIN_BINS) {
            runs.push({ startBin: runStart, endBin: data.length - 1, peakBin: peakIdx, peakDb });
        }
    }
    return runs;
}

function _binToFreq(bin, binCount, centerFreq, totalBandwidth) {
    return centerFreq - totalBandwidth / 2 + (bin / binCount) * totalBandwidth;
}

// Expand a run's bounds outward from its peak bin until the signal drops below
// noiseFloor + expandThresholdDb (default 4 dB).  This captures the full extent
// of spectrally uneven signals (e.g. SSB voice heavy on bass) that may dip below
// the detection threshold in some bins but are still clearly above the noise floor.
function _expandRunFromPeak(data, run, noiseFloor, expandThresholdDb) {
    const expandThreshold = noiseFloor + expandThresholdDb;
    let lo = run.peakBin;
    let hi = run.peakBin;

    // Walk left from peak
    while (lo > 0 && data[lo - 1] >= expandThreshold) lo--;
    // Walk right from peak
    while (hi < data.length - 1 && data[hi + 1] >= expandThreshold) hi++;

    return { ...run, startBin: lo, endBin: hi };
}

function updateStrongSignalBrackets(spectrumDisplay) {
    const now = Date.now();
    if (now - _bracketLastUpdateTime < BRACKET_UPDATE_INTERVAL_MS) return; // rate-limit
    _bracketLastUpdateTime = now;

    // Prefer EMA-smoothed data; fall back to raw
    const data = spectrumDisplay.specEma || spectrumDisplay.spectrumData;
    if (!data || data.length === 0) { _bracketActive = []; return; }

    const binCount = data.length;
    const centerFreq = spectrumDisplay.centerFreq;
    const totalBandwidth = spectrumDisplay.totalBandwidth;
    if (!centerFreq || !totalBandwidth) { _bracketActive = []; return; }

    const noiseFloor = _estimateNoiseFloor(data);

    // Detect all runs above the APPEAR threshold
    const newRuns = _detectSignalRuns(data, noiseFloor, BRACKET_APPEAR_THRESHOLD_DB);

    // Expand each run outward from its peak at a lower threshold (4 dB above noise).
    // This captures the full extent of spectrally uneven signals like SSB voice,
    // which may be strong in the bass but weaker at higher frequencies.
    const expandedRuns = newRuns.map(run => _expandRunFromPeak(data, run, noiseFloor, 4));

    // Filter: signal run width must be > 50% and < 150% of the current receive bandwidth.
    // Uses expanded bounds so uneven voice signals measure their true width.
    const rxBandwidthHz = Math.abs(
        (spectrumDisplay.currentBandwidthHigh || 2700) -
        (spectrumDisplay.currentBandwidthLow  || 50)
    );
    const minSignalWidthHz = rxBandwidthHz * 0.5;
    const maxSignalWidthHz = rxBandwidthHz * 1.5;
    const hzPerBin = totalBandwidth / binCount;
    const filteredRuns = expandedRuns.filter(run => {
        const runWidthHz = (run.endBin - run.startBin + 1) * hzPerBin;
        return runWidthHz >= minSignalWidthHz && runWidthHz <= maxSignalWidthHz;
    });

    // Sort by peak power, take top N
    filteredRuns.sort((a, b) => b.peakDb - a.peakDb);
    const topRuns = filteredRuns.slice(0, BRACKET_TOP_SIGNALS);

    // Convert bin indices to frequencies
    const newBrackets = topRuns.map(run => ({
        freqLow:  _binToFreq(run.startBin, binCount, centerFreq, totalBandwidth),
        freqHigh: _binToFreq(run.endBin,   binCount, centerFreq, totalBandwidth),
        peakFreq: _binToFreq(run.peakBin,  binCount, centerFreq, totalBandwidth),
        peakDb:   run.peakDb,
        noiseDb:  noiseFloor
    }));

    // Apply hysteresis: keep existing brackets that are still above disappear threshold
    const disappearThreshold = noiseFloor + BRACKET_DISAPPEAR_THRESHOLD_DB;
    const retained = _bracketActive.filter(existing => {
        // Find the peak bin for this existing bracket's frequency range
        const startBin = Math.round(((existing.freqLow  - (centerFreq - totalBandwidth / 2)) / totalBandwidth) * binCount);
        const endBin   = Math.round(((existing.freqHigh - (centerFreq - totalBandwidth / 2)) / totalBandwidth) * binCount);
        const s = Math.max(0, startBin);
        const e = Math.min(binCount - 1, endBin);
        let maxDb = -Infinity;
        for (let i = s; i <= e; i++) maxDb = Math.max(maxDb, data[i]);
        return maxDb >= disappearThreshold;
    });

    // Merge: start from new detections, add retained ones not already covered
    const merged = [...newBrackets];
    for (const r of retained) {
        const alreadyCovered = merged.some(b =>
            b.freqLow <= r.peakFreq && b.freqHigh >= r.peakFreq
        );
        if (!alreadyCovered) merged.push(r);
    }

    // Final cap at top N by peak power
    merged.sort((a, b) => b.peakDb - a.peakDb);
    const next = merged.slice(0, BRACKET_TOP_SIGNALS);

    // Detect change: different count or any bracket moved significantly (>1 bin width)
    const binWidth = totalBandwidth / binCount;
    const changed = next.length !== _bracketActive.length || next.some((b, i) => {
        const old = _bracketActive[i];
        return !old ||
            Math.abs(b.freqLow  - old.freqLow)  > binWidth * 2 ||
            Math.abs(b.freqHigh - old.freqHigh) > binWidth * 2;
    });

    _bracketActive = next;

    // Signal to spectrum-display.js that the markerCache needs rebuilding
    if (changed) {
        window._signalBracketsChanged = true;
    }
}

function drawStrongSignalBrackets(spectrumDisplay) {
    if (!spectrumDisplay || !spectrumDisplay.overlayCtx) return;
    if (!spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) return;

    // Run detection (rate-limited internally)
    updateStrongSignalBrackets(spectrumDisplay);

    if (_bracketActive.length === 0) return;

    const ctx = spectrumDisplay.overlayCtx;
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq   = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;
    const w = spectrumDisplay.width;

    const BAR_Y    = 0;   // top of overlay
    const BAR_H    = 2;   // horizontal bar thickness (px)
    const LEG_H    = 8;   // downward leg length (px)
    const COLOR    = '#ff2222';
    const GLOW     = 'rgba(255, 34, 34, 0.35)';

    ctx.save();

    for (const bracket of _bracketActive) {
        // Skip brackets entirely outside the visible window
        if (bracket.freqHigh < startFreq || bracket.freqLow > endFreq) continue;

        const xLeft  = Math.max(0, ((bracket.freqLow  - startFreq) / spectrumDisplay.totalBandwidth) * w);
        const xRight = Math.min(w, ((bracket.freqHigh - startFreq) / spectrumDisplay.totalBandwidth) * w);

        if (xRight - xLeft < 1) continue; // too narrow to draw

        // Glow shadow for visibility against any background
        ctx.shadowColor = GLOW;
        ctx.shadowBlur  = 4;

        ctx.fillStyle = COLOR;

        // Horizontal top bar
        ctx.fillRect(xLeft, BAR_Y, xRight - xLeft, BAR_H);

        // Left leg
        ctx.fillRect(xLeft, BAR_Y, 2, BAR_H + LEG_H);

        // Right leg
        ctx.fillRect(xRight - 2, BAR_Y, 2, BAR_H + LEG_H);
    }

    ctx.shadowBlur = 0;
    ctx.restore();
}

export {
    bookmarks,
    bookmarkPositions,
    amateurBands,
    loadBands,
    loadBookmarks,
    drawAmateurBandBackgrounds,
    drawBookmarksOnSpectrum,
    drawStrongSignalBrackets,
    handleBookmarkClick
};

// Expose functions on window for spectrum-display.js access
window.amateurBands = amateurBands;
window.loadBands = loadBands;
window.drawAmateurBandBackgrounds = drawAmateurBandBackgrounds;
window.drawBookmarksOnSpectrum = drawBookmarksOnSpectrum;
window.drawStrongSignalBrackets = drawStrongSignalBrackets;
window.handleBookmarkClick = handleBookmarkClick;