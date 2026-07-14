// Spectrum Display - Full-band FFT visualization for ka9q UberSDR
// Connects to radiod's spectrum mode via WebSocket

// ── Flag emoji helper ──────────────────────────────────────────────────────────
function _spectrumIso2ToFlag(code) {
    if (!code || code.length !== 2) return '';
    const c = code.toUpperCase();
    const base = 0x1F1E6 - 0x41;
    try { return String.fromCodePoint(base + c.charCodeAt(0), base + c.charCodeAt(1)); }
    catch (e) { return ''; }
}

class SpectrumDisplay {
    constructor(canvasId, config = {}) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            throw new Error(`Canvas element '${canvasId}' not found`);
        }

        // Line graph canvas for split view
        this.lineGraphCanvas = document.getElementById('spectrum-line-graph-canvas');
        this.lineGraphCtx = this.lineGraphCanvas ? this.lineGraphCanvas.getContext('2d', { alpha: false }) : null;
        // Display mode: locked to 'split' (line graph on top, waterfall on bottom)
        this.displayMode = 'split';

        // Line graph noise floor tracking for smoother display
        this.lineGraphMinHistory = [];
        this.lineGraphMinHistoryMaxAge = 2000; // 2 second window for noise floor

        // Line graph maximum tracking for smoother scaling
        this.lineGraphMaxHistory = [];
        this.lineGraphMaxHistoryMaxAge = 20000; // 20 second window for maximum (handles FT8 cycles)

        // Line graph EMA smoothing (replaces box-filter history).
        // Always-on; checkbox switches to a heavier multiplier for longer averaging.
        //
        // Algorithm matches VibeSDR signalProcessor.ts step 5:
        //   fallAlpha = min(0.95, 1 - exp(-dtSec / tcFall))
        //   riseAlpha = min(0.95, fallAlpha * 4)   ← derived, guarantees 4× ratio
        //
        // tcFall is ADAPTIVE: it scales with the measured data frame interval so the
        // trace always flows smoothly between frames regardless of server divisor.
        //   LIGHT (Smooth OFF): tcFall = 1× avgDataFrameMs → settles in ~1 frame
        //   HEAVY (Smooth ON):  tcFall = 4× avgDataFrameMs → averages over ~4 frames
        this.specEma = null;              // Float32Array, lazily allocated per bin count
        this.specEmaLastFrameTime = 0;    // wall-clock ms of last drawLineGraph rAF tick
        this.avgDataFrameMs = 100;        // EMA of inter-data-frame interval (ms), seed 100ms
        this.lastDataFrameTime = 0;       // wall-clock ms of last _consumeNewFrame call
        this.EMA_TC_LIGHT_MULTIPLIER = 1.0; // 1× frame interval — near-instant, no jump
        this.EMA_TC_HEAVY_MULTIPLIER = 4.0; // 4× frame interval — true averaging look

        // Peak hold line - tracks maximum values with slow decay
        this.peakHoldData = null;
        this.peakHoldDecayRate = 3.0; // dB per second decay rate (faster decay)
        this.lastPeakHoldUpdate = Date.now();
        this.peakHoldEnabled = true; // Default to enabled (will be overridden by localStorage in setupScrollHandler)

        // Frame buffering for audio synchronization
        this.frameQueue = [];
        this.maxQueueSize = 100;
        this.maxHealthyQueueSize = 10; // Keep queue small to prevent lag accumulation
        this.maxFrameAge = 500; // Drop frames older than 500ms (stale data)
        this.bufferMargin = 0.05; // 50ms safety margin (matching frequency tracking)
        this.animationLoopRunning = false;
        this.droppedFrameCount = 0; // Track dropped frames for debugging

        // Smooth waterfall scrolling - decouple visual scroll rate from data arrival rate
        // The accumulator advances at targetScrollRate px/sec every rAF tick,
        // scrolling 1 pixel each time it crosses a whole number.
        this.scrollAccumulator = 0;
        this.lastRafTime = null; // set on first rAF tick
        this.targetScrollRate = 10; // rows/sec — lazily set from spectrum_poll_period on first frame
        this.lastSpectrumRow = null; // most recent spectrum data, reused between data packets

        // GPU sub-pixel scroll mode — uses CSS translateY for smooth composited scrolling.
        // When enabled the rAF loop runs at 60fps and advances a float pixel offset each tick;
        // the canvas is shifted by that offset via CSS transform (GPU-composited, sub-pixel).
        // A new canvas row is only painted when the offset crosses a whole pixel boundary.
        // Enabled by default; user can disable via the "GPU" checkbox.
        this.gpuScrollEnabled = true; // set from localStorage in setupScrollHandler
        this.gpuScrollOffset = 0;     // fractional pixel offset (0 .. waterfallHeight)
        this.gpuNextWriteRow = 0;     // ring-buffer write pointer (canvas row index)

        // Waterfall height (user-resizable, persisted in localStorage).
        // Minimum is 1px — the waterfall can be collapsed to nothing in any mode.
        // Double-click on the handle resets to the default 300px.
        const savedWaterfallHeight = parseInt(localStorage.getItem('waterfallHeight'), 10);
        this.waterfallHeight = (Number.isFinite(savedWaterfallHeight) && savedWaterfallHeight >= 1)
            ? savedWaterfallHeight
            : 300;
        this.fullHeight = 300 + this.waterfallHeight; // spectrum line graph (300) + waterfall

        // Spectrum sync setting (controlled by user preference)
        this.spectrumSyncEnabled = window.spectrumSyncEnabled === true; // Default to disabled

        // Cache filter latency for synchronization (updated dynamically)
        this.cachedFilterLatency = 0; // milliseconds

        // Setup mouse handlers for line graph canvas
        if (this.lineGraphCanvas) {
            this.setupLineGraphMouseHandlers();
        }

        // Set canvas size to match container
        this.resizeCanvas();

        this.ctx = this.canvas.getContext('2d', { alpha: false });
        // Disable image smoothing for crisp pixels
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.mozImageSmoothingEnabled = true;
        this.ctx.webkitImageSmoothingEnabled = true;
        this.ctx.msImageSmoothingEnabled = true;

        // Store both canvas pixel dimensions and CSS dimensions
        this.canvasWidth = this.canvas.width;
        this.canvasHeight = this.canvas.height;
        this.width = parseInt(this.canvas.style.width) || this.canvas.width;
        this.height = parseInt(this.canvas.style.height) || this.canvas.height;

        // Handle window resize with debouncing
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const oldWidth = this.width;
                const oldHeight = this.height;

                // Calculate new dimensions without applying them yet
                const container = this.canvas.parentElement;
                const rect = container.getBoundingClientRect();
                const newWidth = Math.floor(rect.width);
                // Check if line graph (spectrum) is visible to determine waterfall height
                const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
                const newHeight = lineGraphVisible ? this.waterfallHeight : this.fullHeight;

                // Check if width actually changed
                if (oldWidth !== newWidth) {
                    // Save current canvas content before width change
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = this.canvas.width;
                    tempCanvas.height = this.canvas.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(this.canvas, 0, 0);

                    // Now resize canvas (this clears it)
                    this.canvas.style.width = newWidth + 'px';
                    this.canvas.style.height = newHeight + 'px';
                    this.canvas.width = newWidth;
                    this.canvas.height = newHeight;

                    // Update stored dimensions
                    this.width = newWidth;
                    this.height = newHeight;
                    this.canvasWidth = newWidth;
                    this.canvasHeight = newHeight;

                    // Reset context transform
                    this.ctx.setTransform(1, 0, 0, 1, 0, 0);

                    // Clear canvas with black
                    this.ctx.fillStyle = '#000';
                    this.ctx.fillRect(0, 0, this.width, this.height);

                    // Copy old content, scaling horizontally to new width but keeping original height
                    this.ctx.drawImage(tempCanvas, 0, 0, oldWidth, oldHeight, 0, 0, this.width, oldHeight);

                    // Recreate waterfall image data for new width
                    this.waterfallImageData = this.ctx.createImageData(this.width, 1);

                    // Update line graph canvas dimensions if it exists
                    if (this.lineGraphCanvas) {
                        this.lineGraphCanvas.width = this.width;
                        this.lineGraphCanvas.style.width = this.width + 'px';
                    }

                    // Update overlay canvas dimensions to match new width
                    this.overlayDiv.style.width = this.width + 'px';
                    this.overlayCanvas.width = this.width;

                    // Update bandwidth lines canvas dimensions
                    this.bandwidthLinesCanvas.width = this.width;
                    this.bandwidthLinesCanvas.style.width = this.width + 'px';

                    // Invalidate marker cache to force redraw at new width
                    this.invalidateMarkerCache();
                    // Invalidate overlay rect cache — canvas position changes on resize
                    this._overlayRectCache = null;

                    // Force immediate redraw of overlay (bookmarks and frequency scale)
                    if (this.totalBandwidth && this.centerFreq) {
                        this.drawTunedFrequencyCursor();
                    }

                    // Force immediate redraw of spectrum if we have data
                    if (this.spectrumData && this.spectrumData.length > 0) {
                        this.draw();
                    }

                    console.log(`Canvas width resized: ${oldWidth} -> ${this.width} CSS pixels`);
                } else if (oldHeight !== newHeight) {
                    // Height-only change - just update CSS, don't touch canvas pixels
                    this.canvas.style.height = newHeight + 'px';
                    this.height = newHeight;
                    // Invalidate overlay rect cache — the canvas top position in the viewport
                    // may have changed when the window height changes (e.g. browser chrome
                    // appearing/disappearing shifts the canvas vertically).
                    this._overlayRectCache = null;
                    console.log(`Canvas height changed: ${oldHeight} -> ${this.height} CSS pixels (waterfall preserved)`);
                }
            }, 250); // Debounce resize events
        });

        // Invalidate overlay rect cache on scroll — the canvas is in normal document flow
        // so its viewport-relative top position (getBoundingClientRect().top) changes
        // whenever the page is scrolled.  The overlay div is position:fixed so it must
        // be repositioned after every scroll to stay aligned with the canvas.
        window.addEventListener('scroll', () => {
            this._overlayRectCache = null;
        }, { passive: true });

        // Create overlay div for cursor indicator (positioned above canvas)
        this.overlayDiv = document.createElement('div');
        this.overlayDiv.className = 'spectrum-frequency-overlay';
        this.overlayDiv.style.position = 'fixed';
        this.overlayDiv.style.height = '75px'; // 45px bookmarks + 30px frequency scale — fixed, never changes
        this.overlayDiv.style.pointerEvents = 'none'; // Let clicks pass through to elements below
        // Position and size will be set dynamically based on canvas position

        // Create canvas inside overlay div (75px: 45px bookmarks + 30px frequency scale)
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = this.width;
        this.overlayCanvas.height = 75;
        this.overlayCanvas.style.pointerEvents = 'auto'; // Enable pointer events on canvas for bookmark clicks
        this.overlayCanvas.style.cursor = 'default';
        this.overlayDiv.appendChild(this.overlayCanvas);

        // Append overlay div to body (not to canvas parent) so it's in root stacking context
        document.body.appendChild(this.overlayDiv);
        
        // Update overlay position to match canvas
        this.updateOverlayPosition();

        this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true });

        // Create bandwidth lines overlay canvas (positioned over main canvas)
        this.bandwidthLinesCanvas = document.createElement('canvas');
        this.bandwidthLinesCanvas.width = this.width;
        this.bandwidthLinesCanvas.height = this.fullHeight;
        this.bandwidthLinesCanvas.style.position = 'absolute';
        this.bandwidthLinesCanvas.style.top = '0';
        this.bandwidthLinesCanvas.style.left = '0';
        this.bandwidthLinesCanvas.style.width = this.width + 'px';
        this.bandwidthLinesCanvas.style.height = this.fullHeight + 'px';
        this.bandwidthLinesCanvas.style.pointerEvents = 'none'; // Allow clicks to pass through
        this.bandwidthLinesCanvas.style.zIndex = '10'; // Above waterfall but below cursor overlay
        this.bandwidthLinesCtx = this.bandwidthLinesCanvas.getContext('2d', { alpha: true });

        // Insert bandwidth lines canvas after main canvas (so it overlays it)
        this.canvas.parentElement.insertBefore(this.bandwidthLinesCanvas, this.canvas.nextSibling);

        // Add mousemove handler for bookmark tooltips on overlay canvas
        this.overlayCanvas.addEventListener('mousemove', (e) => {
            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Check if mouse is over a chat user marker
            if (window.chatUserMarkerPositions && window.chatUserMarkerPositions.length > 0) {
                for (let pos of window.chatUserMarkerPositions) {
                    // Check if mouse is within chat user marker bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        // Show chat user info
                        const freqStr = this.formatFrequency(pos.frequency);
                        const modeStr = pos.mode ? pos.mode.toUpperCase() : 'N/A';
                        let tooltipText = `${pos.username}: ${freqStr} ${modeStr}`;
                        if (pos.country) {
                            tooltipText += `<br>Country: ${pos.country}`;
                        }
                        this.tooltip.innerHTML = tooltipText;

                        // Position tooltip near cursor (flips left near the right edge)
                        this.tooltip.style.display = 'block';
                        this._positionTooltipNearCursor(e.clientX, e.clientY);
                        return;
                    }
                }
            }

            // Check if mouse is over a bookmark
            if (window.bookmarkPositions && window.bookmarkPositions.length > 0) {
                for (let pos of window.bookmarkPositions) {
                    // Check if mouse is within bookmark bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        // Show bookmark info
                        const freqStr = this.formatFrequency(pos.bookmark.frequency);
                        const modeStr = pos.bookmark.mode ? pos.bookmark.mode.toUpperCase() : 'N/A';
                        let tooltipText = `${pos.bookmark.name}: ${freqStr} ${modeStr}`;
                        if (pos.bookmark.comment) {
                            tooltipText += `<br><em>${pos.bookmark.comment}</em>`;
                        }
                        if (pos.bookmark.extension) {
                            // Get display name from decoder manager if available
                            const displayName = window.decoderManager ?
                                window.decoderManager.getDisplayName(pos.bookmark.extension) :
                                pos.bookmark.extension;
                            tooltipText += `<br>Extension: ${displayName}`;
                        }
                        this.tooltip.innerHTML = tooltipText;

                        // Position tooltip near cursor (flips left near the right edge)
                        this.tooltip.style.display = 'block';
                        this._positionTooltipNearCursor(e.clientX, e.clientY);
                        return;
                    }
                }
            }

            // Check if mouse is over a DX spot (iterate in reverse to show most recent spot on top)
            if (window.dxSpotPositions && window.dxSpotPositions.length > 0) {
                for (let i = window.dxSpotPositions.length - 1; i >= 0; i--) {
                    const pos = window.dxSpotPositions[i];
                    // Check if mouse is within DX spot bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        // Continent name mapping
                        const continentNames = {
                            'AF': 'Africa',
                            'AS': 'Asia',
                            'EU': 'Europe',
                            'NA': 'North America',
                            'SA': 'South America',
                            'OC': 'Oceania',
                            'AN': 'Antarctica'
                        };

                        // Show DX spot info
                        const freqStr = this.formatFrequency(pos.spot.frequency);
                        const timeStr = pos.spot.time ? new Date(pos.spot.time).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' }) : 'N/A';
                        const dxFlag = _spectrumIso2ToFlag(pos.spot.country_code || '');
                        const dxCallDisplay = dxFlag ? dxFlag + '\u00A0' + pos.spot.dx_call : pos.spot.dx_call;
                        const _dxP = (pos.spot.dx_call || '').split('/');
                        const _dxB = _dxP.reduce((a, b) => b.length > a.length ? b : a, '').toUpperCase();
                        const _dxC = window._callsignLookupCache && window._callsignLookupCache.get(_dxB);
                        const _dxName = (_dxC && _dxC.data) ? (() => { const _n = _dxC.data.name_fmt || [_dxC.data.fname, _dxC.data.nickname ? `"${_dxC.data.nickname}"` : '', _dxC.data.name].filter(Boolean).join(' '); return _n.length > 30 ? _n.slice(0, 30) + '\u2026' : _n; })() : '';
                        let tooltipText = `${dxCallDisplay}: ${freqStr}`;
                        if (_dxName) tooltipText += `<br>Name: ${_dxName}`;
                        tooltipText += `<br>Time: ${timeStr} UTC`;
                        if (pos.spot.country) {
                            tooltipText += `<br>Country: ${pos.spot.country}`;
                        }
                        if (pos.spot.continent) {
                            const continentName = continentNames[pos.spot.continent] || pos.spot.continent;
                            tooltipText += ` (${continentName})`;
                        }
                        tooltipText += `<br>Spotter: ${pos.spot.spotter}`;
                        if (pos.spot.comment) {
                            tooltipText += `<br>Comment: ${pos.spot.comment}`;
                        }
                        {
                            const _img = (_dxC && _dxC.imageUrl)
                                ? `<img src="${_dxC.imageUrl}" style="width:56px;height:auto;border-radius:3px;flex-shrink:0;display:block;">`
                                : '';
                            // Only rebuild innerHTML when the spot changes or the cache entry
                            // is still pending (undefined = lookup not yet complete).
                            // Once the cache is settled (null or object) and we're on the
                            // same spot, skip the DOM write so the browser never re-fetches
                            // the callsign image on every pixel of mouse movement.
                            const _dxCacheComplete = _dxC !== undefined;
                            if (this._tooltipCallsign !== _dxB || !_dxCacheComplete) {
                                this._tooltipCallsign = _dxB;
                                this._tooltipText = tooltipText;
                                if (_img) {
                                    this.tooltip.style.whiteSpace = 'normal';
                                    this.tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px;">${_img}<div style="white-space:nowrap;">${tooltipText}</div></div>`;
                                } else {
                                    this.tooltip.style.whiteSpace = 'nowrap';
                                    this.tooltip.innerHTML = tooltipText;
                                }
                            }
                        }

                        // Position tooltip near cursor (flips left near the right edge)
                        this.tooltip.style.display = 'block';
                        this._positionTooltipNearCursor(e.clientX, e.clientY);
                        return;
                    }
                }
            }

            // Check if mouse is over a CW spot (iterate in reverse to show most recent spot on top)
            if (window.cwSpotPositions && window.cwSpotPositions.length > 0) {
                for (let i = window.cwSpotPositions.length - 1; i >= 0; i--) {
                    const pos = window.cwSpotPositions[i];
                    // Check if mouse is within CW spot bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        // Show CW spot info with WPM, SNR, and country
                        const freqStr = this.formatFrequency(pos.spot.frequency);
                        const timeStr = pos.spot.time ? new Date(pos.spot.time).toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' }) : 'N/A';
                        const snrStr = pos.spot.snr >= 0 ? `+${pos.spot.snr}` : pos.spot.snr;
                        const cwFlag = _spectrumIso2ToFlag(pos.spot.country_code || '');
                        const cwCallDisplay = cwFlag ? cwFlag + '\u00A0' + pos.spot.dx_call : pos.spot.dx_call;
                        const _cwP = (pos.spot.dx_call || '').split('/');
                        const _cwB = _cwP.reduce((a, b) => b.length > a.length ? b : a, '').toUpperCase();
                        const _cwC = window._callsignLookupCache && window._callsignLookupCache.get(_cwB);
                        const _cwName = (_cwC && _cwC.data) ? (() => { const _n = _cwC.data.name_fmt || [_cwC.data.fname, _cwC.data.nickname ? `"${_cwC.data.nickname}"` : '', _cwC.data.name].filter(Boolean).join(' '); return _n.length > 30 ? _n.slice(0, 30) + '\u2026' : _n; })() : '';
                        let tooltipText = `${cwCallDisplay}: ${freqStr}`;
                        if (_cwName) tooltipText += `<br>Name: ${_cwName}`;
                        tooltipText += `<br>Time: ${timeStr} UTC<br>SNR: ${snrStr} dB<br>WPM: ${pos.spot.wpm}`;
                        if (pos.spot.country) {
                            tooltipText += `<br>Country: ${pos.spot.country}`;
                        }
                        if (pos.spot.comment) {
                            tooltipText += `<br>Comment: ${pos.spot.comment}`;
                        }
                        {
                            const _img = (_cwC && _cwC.imageUrl)
                                ? `<img src="${_cwC.imageUrl}" style="width:56px;height:auto;border-radius:3px;flex-shrink:0;display:block;">`
                                : '';
                            const _cwCacheComplete = _cwC !== undefined;
                            if (this._tooltipCallsign !== _cwB || !_cwCacheComplete) {
                                this._tooltipCallsign = _cwB;
                                this._tooltipText = tooltipText;
                                if (_img) {
                                    this.tooltip.style.whiteSpace = 'normal';
                                    this.tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px;">${_img}<div style="white-space:nowrap;">${tooltipText}</div></div>`;
                                } else {
                                    this.tooltip.style.whiteSpace = 'nowrap';
                                    this.tooltip.innerHTML = tooltipText;
                                }
                            }
                        }

                        // Position tooltip near cursor (flips left near the right edge)
                        this.tooltip.style.display = 'block';
                        this._positionTooltipNearCursor(e.clientX, e.clientY);
                        return;
                    }
                }
            }

            // Check if mouse is over a voice activity marker
            if (window.voiceActivityPositions && window.voiceActivityPositions.length > 0) {
                for (let i = window.voiceActivityPositions.length - 1; i >= 0; i--) {
                    const pos = window.voiceActivityPositions[i];
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        const act = pos.activity || {};
                        const freqStr = this.formatFrequency(pos.frequency);
                        const modeStr = (pos.mode || '').toUpperCase();
                        const voiceFlag = _spectrumIso2ToFlag(act.dx_country_code || '');
                        const voiceLabel = voiceFlag ? voiceFlag + '\u00A0' + pos.label : pos.label;
                        const _vaP = (pos.label || '').split('/');
                        const _vaB = _vaP.reduce((a, b) => b.length > a.length ? b : a, '').toUpperCase();
                        const _vaC = window._callsignLookupCache && window._callsignLookupCache.get(_vaB);
                        const _vaName = (_vaC && _vaC.data) ? (() => { const _n = _vaC.data.name_fmt || [_vaC.data.fname, _vaC.data.nickname ? `"${_vaC.data.nickname}"` : '', _vaC.data.name].filter(Boolean).join(' '); return _n.length > 30 ? _n.slice(0, 30) + '\u2026' : _n; })() : '';
                        let tooltipText = `${voiceLabel}: ${freqStr}`;
                        if (_vaName) tooltipText += `<br>Name: ${_vaName}`;
                        if (modeStr) tooltipText += `<br>Mode: ${modeStr}`;
                        if (act.signal_above_noise != null) {
                            tooltipText += `<br>SNR: ${Math.round(act.signal_above_noise)} dB`;
                        }
                        if (act.confidence != null) {
                            tooltipText += `<br>Confidence: ${Math.round(act.confidence * 100)}%`;
                        }
                        {
                            const _img = (_vaC && _vaC.imageUrl)
                                ? `<img src="${_vaC.imageUrl}" style="width:56px;height:auto;border-radius:3px;flex-shrink:0;display:block;">`
                                : '';
                            const _vaCacheComplete = _vaC !== undefined;
                            if (this._tooltipCallsign !== _vaB || !_vaCacheComplete) {
                                this._tooltipCallsign = _vaB;
                                this._tooltipText = tooltipText;
                                if (_img) {
                                    this.tooltip.style.whiteSpace = 'normal';
                                    this.tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px;">${_img}<div style="white-space:nowrap;">${tooltipText}</div></div>`;
                                } else {
                                    this.tooltip.style.whiteSpace = 'nowrap';
                                    this.tooltip.innerHTML = tooltipText;
                                }
                            }
                        }

                        this.tooltip.style.display = 'block';
                        this._positionTooltipNearCursor(e.clientX, e.clientY);
                        return;
                    }
                }
            }

            // No bookmark, DX spot, CW spot, or voice marker under mouse, hide tooltip
            this.hideTooltip();
        });

        // Add mouseleave handler to hide tooltip when leaving overlay
        this.overlayCanvas.addEventListener('mouseleave', () => {
            this.hideTooltip();
        });

        // Right-click on overlay canvas: show bandwidth colour picker if near the bar
        this.overlayCanvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Bar sits at y=45; accept clicks within ±8px vertically
            const barY = 45;
            const hitY = Math.abs(y - barY) <= 8;

            // Accept clicks between xLow and xHigh (or within 8px of either edge)
            const xLow = this.lastBandwidthXLow;
            const xHigh = this.lastBandwidthXHigh;
            const hitX = xLow !== null && xHigh !== null && x >= xLow - 8 && x <= xHigh + 8;

            if (hitY && hitX) {
                this.showBandwidthColorMenu(e.clientX, e.clientY);
            }
        });

        // Add click handler for bookmarks, DX spots, CW spots, and chat user markers on overlay canvas
        this.overlayCanvas.addEventListener('click', (e) => {
            // Skip if we just finished a bandwidth drag
            if (this.bandwidthDragState && this.bandwidthDragState.wasDragging) {
                this.bandwidthDragState.wasDragging = false;
                return;
            }

            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Check if click is on a chat user marker first
            if (window.chatUserMarkerPositions && window.chatUserMarkerPositions.length > 0) {
                for (let i = window.chatUserMarkerPositions.length - 1; i >= 0; i--) {
                    const pos = window.chatUserMarkerPositions[i];
                    // Check if click is within chat user marker bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {
                        
                        // Tune to the chat user's frequency and mode using tuneToChannel from app.js
                        if (window.tuneToChannel) {
                            window.tuneToChannel(pos.frequency, pos.mode, pos.bandwidthLow, pos.bandwidthHigh);
                        }
                        return;
                    }
                }
            }

            // Check if click is on a DX spot (iterate in reverse to prioritize most recent spot)
            if (window.dxSpotPositions && window.dxSpotPositions.length > 0) {
                for (let i = window.dxSpotPositions.length - 1; i >= 0; i--) {
                    const pos = window.dxSpotPositions[i];
                    // Check if click is within DX spot bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {
                        
                        // Tune to the DX spot
                        if (window.dxClusterExtensionInstance) {
                            window.dxClusterExtensionInstance.tuneToSpot(pos.spot);
                        }
                        // Notify all callsign lookup surfaces (inline QRZ widget + popup).
                        // lookupCallsign() handles both cache hits (renders immediately) and
                        // cache misses (fires fetch → broadcasts 'callsign_lookup_complete').
                        // The popup-window path is checked first so we don't open a second window.
                        const dxCallsign = (pos.spot && pos.spot.dx_call) || '';
                        if (dxCallsign) {
                            const _dxParts = dxCallsign.split('/');
                            const _dxBase = _dxParts.reduce((a, b) => (b.length > a.length ? b : a), '');
                            if (window._callsignLookupWindow && !window._callsignLookupWindow.closed) {
                                const ext = window.dxClusterExtensionInstance;
                                const uuid = ext && ext.radio && ext.radio.getSessionId ? ext.radio.getSessionId() : '';
                                window._callsignLookupWindow.postMessage(
                                    { type: 'callsign_lookup', callsign: _dxBase, uuid },
                                    window.location.origin
                                );
                                window._callsignLookupWindow.focus();
                            }
                            // Always fetch/broadcast so the inline widget and tooltip image update
                            if (typeof window._fetchCallsignForMediaSession === 'function') {
                                window._fetchCallsignForMediaSession(_dxBase);
                            }
                        }
                        return;
                    }
                }
            }

            // Check if click is on a CW spot (iterate in reverse to prioritize most recent spot)
            if (window.cwSpotPositions && window.cwSpotPositions.length > 0) {
                for (let i = window.cwSpotPositions.length - 1; i >= 0; i--) {
                    const pos = window.cwSpotPositions[i];
                    // Check if click is within CW spot bounds
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {
                        
                        // Tune to the CW spot
                        if (window.cwSpotsExtensionInstance) {
                            window.cwSpotsExtensionInstance.tuneToSpot(pos.spot);
                        }
                        // Notify all callsign lookup surfaces (inline QRZ widget + popup).
                        // lookupCallsign() handles both cache hits (renders immediately) and
                        // cache misses (fires fetch → broadcasts 'callsign_lookup_complete').
                        // The popup-window path is checked first so we don't open a second window.
                        const cwCallsign = (pos.spot && pos.spot.dx_call) || '';
                        if (cwCallsign) {
                            const _cwParts = cwCallsign.split('/');
                            const _cwBase = _cwParts.reduce((a, b) => (b.length > a.length ? b : a), '');
                            if (window._callsignLookupWindow && !window._callsignLookupWindow.closed) {
                                const ext = window.cwSpotsExtensionInstance;
                                const uuid = ext && ext.radio && ext.radio.getSessionId ? ext.radio.getSessionId() : '';
                                window._callsignLookupWindow.postMessage(
                                    { type: 'callsign_lookup', callsign: _cwBase, uuid },
                                    window.location.origin
                                );
                                window._callsignLookupWindow.focus();
                            }
                            // Always fetch/broadcast so the inline widget and tooltip image update
                            if (typeof window._fetchCallsignForMediaSession === 'function') {
                                window._fetchCallsignForMediaSession(_cwBase);
                            }
                        }
                        return;
                    }
                }
            }

            // Check if click is on a voice activity marker (iterate in reverse)
            if (window.voiceActivityPositions && window.voiceActivityPositions.length > 0) {
                for (let i = window.voiceActivityPositions.length - 1; i >= 0; i--) {
                    const pos = window.voiceActivityPositions[i];
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {

                        // Tune to the marker's frequency and mode
                        if (typeof window.tuneToChannel === 'function') {
                            window.tuneToChannel(pos.frequency, pos.mode);
                        }

                        // If a callsign is known, fetch/broadcast so inline widget and tooltip image update
                        const callsign = pos.activity && pos.activity.dx_callsign;
                        if (callsign) {
                            const _vParts = callsign.split('/');
                            const _vBase = _vParts.reduce((a, b) => (b.length > a.length ? b : a), '');
                            if (window._callsignLookupWindow && !window._callsignLookupWindow.closed) {
                                const uuid = window.userSessionID || '';
                                window._callsignLookupWindow.postMessage(
                                    { type: 'callsign_lookup', callsign: _vBase, uuid },
                                    window.location.origin
                                );
                                window._callsignLookupWindow.focus();
                            }
                            // Always fetch/broadcast so the inline widget and tooltip image update
                            if (typeof window._fetchCallsignForMediaSession === 'function') {
                                window._fetchCallsignForMediaSession(_vBase);
                            }
                        }
                        return;
                    }
                }
            }

            // Check if click is on a bookmark label (use exact rendered label bounds)
            if (window.bookmarkPositions && window.bookmarkPositions.length > 0 &&
                typeof window.handleBookmarkClick === 'function') {
                for (let pos of window.bookmarkPositions) {
                    if (x >= pos.x - pos.width / 2 &&
                        x <= pos.x + pos.width / 2 &&
                        y >= pos.y &&
                        y <= pos.y + pos.height) {
                        window.handleBookmarkClick(pos.bookmark, e.shiftKey || e.ctrlKey, true);
                        return;
                    }
                }
            }
        });

        // Configuration
        // Get user session ID from app.js (generated on page load)
        const userSessionID = window.userSessionID || (typeof userSessionID !== 'undefined' ? userSessionID : '');
        const wsUrlBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/user-spectrum`;
        let wsUrlWithSession = userSessionID ? `${wsUrlBase}?user_session_id=${encodeURIComponent(userSessionID)}` : wsUrlBase;

        // Add bypass password if available
        if (window.bypassPassword) {
            wsUrlWithSession += `&password=${encodeURIComponent(window.bypassPassword)}`;
        }

        this.config = {
            wsUrl: config.wsUrl || wsUrlWithSession,
            minDb: config.minDb !== undefined ? config.minDb : -100,
            maxDb: config.maxDb !== undefined ? config.maxDb : 0,
            autoRange: true, // Auto-ranging always enabled
            manualRangeEnabled: false, // Manual range override
            manualMinDb: -120, // Manual minimum dB
            manualMaxDb: -40, // Manual maximum dB
            rangeMargin: config.rangeMargin || 5, // dB margin for auto-range
            autoContrast: 10, // Symmetric contrast: floor raised by +N, ceiling lowered by -N
            autoMinSpan: 30, // Minimum dynamic range in dB (null = disabled / full auto)
            colorScheme: config.colorScheme || 'jet', // Default to jet color scheme
            intensity: config.intensity !== undefined ? config.intensity : 0.20, // Intensity adjustment (-1.0 to +1.0)
            contrast: config.contrast !== undefined ? config.contrast : 35, // Contrast threshold (0-100), lower = more signals visible in auto mode
            showGrid: config.showGrid !== false,
            showLabels: config.showLabels !== false,
            updateRate: config.updateRate || 50, // ms
            onConnect: config.onConnect,
            onDisconnect: config.onDisconnect,
            onConfig: config.onConfig,
            onFrequencyClick: config.onFrequencyClick
        };

        // Spectrum data
        this.spectrumData = null;
        this.centerFreq = 0;
        this.binCount = 0;
        this.binBandwidth = 0;
        this.totalBandwidth = 0;

        // Zoom state
        this.zoomLevel = 1.0; // 1.0 = full bandwidth, higher = zoomed in
        this.zoomCenterFreq = 0; // Center frequency of zoomed view

        // Current tuned frequency (for cursor display)
        this.currentTunedFreq = 0;

        // Current bandwidth edges (for bandwidth indicator)
        this.currentBandwidthLow = 50;
        this.currentBandwidthHigh = 3000;

        // Bandwidth drag state
        this.bandwidthDragState = {
            isDragging: false,
            draggedEdge: null, // 'low' or 'high'
            startX: 0,
            startBandwidthValue: 0,
            hitTolerance: 10, // pixels
            wasDragging: false // flag to prevent click events after drag
        };

        // Track last spectrum view state for conditional marker redraw (performance optimization)
        this.lastMarkerCenterFreq = null;
        this.lastMarkerTotalBandwidth = null;
        this.lastMarkerDisplayMode = null;
        this.markerCache = null; // Offscreen canvas for caching markers
        this.markerCacheCtx = null;

        // Flag to prevent auto-pan when frequency is changed by clicking waterfall
        this.skipNextPan = false;

        // Flag to prevent edge detection when user manually changes frequency
        // This is temporarily set to true when user changes frequency to avoid interference
        this.skipEdgeDetectionTemporary = false;

        // User preference for edge detection (default disabled)
        // When false, edge detection is completely disabled
        this.edgeTuneEnabled = localStorage.getItem('edgeTuneEnabled') === 'true';

        // Bandwidth indicator colour (bar + vertical lines). Stored as a base colour name.
        // Default: green. Saved/loaded from localStorage.
        this.bandwidthIndicatorColor = localStorage.getItem('bandwidthIndicatorColor') || 'green';

        // Last computed xLow/xHigh for the bandwidth bar (used by right-click hit-test)
        this.lastBandwidthXLow = null;
        this.lastBandwidthXHigh = null;

        // Auto-ranging
        this.actualMinDb = this.config.minDb;
        this.actualMaxDb = this.config.maxDb;
        
        // Auto-range history for temporal smoothing (matching app.js waterfall behavior)
        this.autoRangeMinHistory = []; // Track minimum values over time for stable noise floor
        this.autoRangeMaxHistory = []; // Track maximum values over time for stable ceiling
        this.autoRangeMinHistoryMaxAge = 2000; // 2 second window for noise floor
        // Last committed clamped values — used for hysteresis to prevent flicker
        this._clampedMinDb = null;
        this._clampedMaxDb = null;
        // Same for line graph path
        this._lgClampedMinDb = null;
        this._lgClampedMaxDb = null;
        this.autoRangeMaxHistoryMaxAge = 5000; // 5 second window for maximum (faster recovery after strong signals)

        // Waterfall
        this.waterfallImageData = null;
        this.waterfallLineCount = 0;
        this.waterfallStartTime = null;

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.pingInterval = null;
        this.userDisconnected = false; // Flag to prevent reconnection after user disconnect
        this.connectionFailureNotified = false; // Track if we've already shown the connection failure notification

        // Animation
        this.animationFrame = null;
        this.lastUpdate = 0;

        // Bit rate tracking
        this.bytesReceived = 0;
        this.messageCount = 0;
        this.lastBitrateUpdate = Date.now();
        this.currentBitrate = 0;

        // Mouse interaction
        this.mouseX = -1;
        this.mouseY = -1;
        this.isDragging = false;
        this.dragDidMove = false;
        this.dragStartX = 0;
        this.dragStartFreq = 0;
        this.lastPanTime = 0;
        this.panThrottleMs = 25; // Throttle pan requests (25ms = 40 requests/sec max)
        this.lastDragX = -1; // Track last drag position to detect actual movement
        this.lastDragY = -1;

        // Client-side prediction for smooth dragging
        this.predictedFreqOffset = 0; // Frequency offset for visual prediction during drag
        this.lastServerCenterFreq = 0; // Track last confirmed center freq from server
        this._lineGraphDragActive = false; // Line-graph pan drag in progress (mirrors closure state in setupLineGraphMouseHandlers)
        this._lastMarkerCacheBuildTime = 0; // performance.now() of last marker cache rebuild (throttles rebuilds during drag)
        this.scrollEnabled = false; // Mouse scroll wheel disabled by default
        this.zoomScrollEnabled = true; // Zoom scroll wheel enabled by default
        this.smoothingEnabled = false; // Temporal smoothing disabled by default
        this.snapEnabled = true; // Snap enabled by default (uses frequency scroll step value)
        this.hasPerformedInitialZoom = false; // Track if we've done initial zoom on first scroll
        this.setupMouseHandlers();
        this.setupScrollHandler();
        this.setupTouchHandlers();

        // Periodic sync verification to prevent audio/spectrum drift
        this.lastSyncCheck = Date.now();
        this.syncCheckInterval = 100; // Check every 100ms
        this.startSyncMonitoring();

        // Periodic settings sync to prevent frequency/config drift
        // Will be started when WebSocket connection is established
        this.settingsSyncInterval = null;

        // Color gradient cache
        this.colorGradient = this.createColorGradient();

        // Initialize signal meter
        this.signalMeter = new SignalMeter();

        // Initialize S-meter needle display
        if (typeof initSMeterNeedle === 'function') {
            initSMeterNeedle();
        }

        // Setup bandwidth drag handlers on overlay canvas
        this.setupBandwidthDragHandlers();

        // Check localStorage preference for line graph visibility (default to false/unchecked)
        const savedState = localStorage.getItem('spectrumLineGraphEnabled');
        const lineGraphEnabled = savedState === 'true'; // Only true if explicitly saved as 'true'

        // Initialize split mode only if line graph is enabled
        if (this.displayMode === 'split' && lineGraphEnabled) {
            this.splitModeLogged = false;
            this.canvas.classList.add('split-view');
            this.canvas.height = this.waterfallHeight;
            this.height = this.waterfallHeight;
            this.canvasHeight = this.waterfallHeight;

            if (this.lineGraphCanvas) {
                this.lineGraphCanvas.classList.add('split-mode');
                this.lineGraphCanvas.style.display = 'block';
                this.lineGraphCanvas.width = this.width;
                this.lineGraphCanvas.height = 300;
                this.lineGraphCanvas.style.width = this.width + 'px';
                this.lineGraphCanvas.style.height = '300px';
            }

            this.bandwidthLinesCanvas.height = this.fullHeight;
            this.bandwidthLinesCanvas.style.height = this.fullHeight + 'px';

            this.overlayDiv.style.position = 'absolute';
            this.overlayDiv.style.top = '0';
            this.overlayDiv.style.left = '0';
            this.overlayDiv.style.zIndex = '15';
            this.overlayDiv.style.backgroundColor = '#adb5bd';

            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, 300);

            this.waterfallImageData = null;
        } else if (this.lineGraphCanvas) {
            // Line graph is disabled by default - hide it
            this.lineGraphCanvas.style.display = 'none';
        }

        // Spectrum line-graph background image (loaded from /api/spectrum-bg-image if set)
        this.lineGraphBgImage   = null;  // HTMLImageElement or null
        this.lineGraphBgOpacity = 0.30;  // 0.0–1.0, default 0.3

        // Load background image from server UI config if available
        this.loadLineGraphBgImage();

        // Station ID overlay settings (read from window.serverUIConfig, same pattern as bg image)
        this.stationIdOverlay = true;      // default: show overlay
        this.stationIdColor   = '#ffffff'; // default: white
        this.loadStationIdConfig();

        // Local weather line for station ID overlay (fetched from /api/weather, refreshed every 15 min)
        this._weatherLine = null;
        this.loadWeatherData();

        // Setup filter latency change listener for synchronization
        this.setupFilterLatencyListener();
    }

    /**
     * Load the spectrum line-graph background image from the server.
     * Reads the URL and opacity from window.serverUIConfig (populated by ui-config.js).
     * If no image URL is set, lineGraphBgImage remains null and no background is drawn.
     * Safe to call multiple times — re-fetches on each call so the admin can hot-reload.
     */
    loadLineGraphBgImage() {
        const cfg = window.serverUIConfig || {};
        const url = cfg.spectrum_bg_image || '';
        const opacity = (cfg.spectrum_bg_opacity !== undefined && cfg.spectrum_bg_opacity !== null)
            ? parseFloat(cfg.spectrum_bg_opacity) : 0.30;
        this.lineGraphBgOpacity = isNaN(opacity) ? 0.30 : opacity;

        if (!url) {
            this.lineGraphBgImage = null;
            return;
        }

        const img = new Image();
        img.onload  = () => { this.lineGraphBgImage = img; };
        img.onerror = () => {
            console.warn('[spectrum] Failed to load spectrum background image:', url);
            this.lineGraphBgImage = null;
        };
        // Cache-bust so a freshly uploaded image is always fetched
        img.src = url + '?t=' + Date.now();
    }

    /**
     * Load station ID overlay settings from window.serverUIConfig.
     * Called from constructor; safe to call again to hot-reload after admin saves.
     * station_id_overlay: boolean (default true — show overlay)
     * station_id_color:   #rrggbb hex string (default "#ffffff")
     */
    loadStationIdConfig() {
        const cfg = window.serverUIConfig || {};
        // Default to true (show) when the key is absent (e.g. old server without the field)
        this.stationIdOverlay = cfg.station_id_overlay !== false;
        const col = (cfg.station_id_color || '').trim();
        this.stationIdColor = /^#[0-9a-fA-F]{6}$/.test(col) ? col : '#ffffff';
    }

    /**
     * Fetch local weather and cache a one-line summary string in this._weatherLine
     * for use by drawStationIdOverlay().
     * Reads from window.weatherPromise (set by app.js) to avoid a duplicate HTTP
     * request that would exhaust the per-IP rate limiter.  Falls back to a direct
     * fetch only when the global is not yet available.
     * Silently does nothing on 404 (weather service not configured) or any error.
     * Refreshes every 15 minutes to match the server-side cache interval.
     */
    async loadWeatherData() {
        try {
            let wd;
            if (window.weatherPromise) {
                wd = await window.weatherPromise;
            } else {
                // Fallback: set the shared promise so subsequent callers reuse it too
                window.weatherPromise = fetch('/api/weather')
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null);
                wd = await window.weatherPromise;
            }
            if (!wd) {
                this._weatherLine = null;
                return;
            }
            if (!wd.weather || !wd.weather.length) {
                this._weatherLine = null;
                return;
            }
            const wxDesc = wd.weather[0].description
                .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            const temp = (wd.main && wd.main.temp !== undefined)
                ? `\u{1F321}\uFE0F${Math.round(wd.main.temp)}\u00B0C` : '';
            let wind = '';
            if (wd.wind && wd.wind.speed !== undefined) {
                const kmh = Math.round(wd.wind.speed * 3.6);
                const dir = (wd.wind.deg !== undefined)
                    ? ['N','NE','E','SE','S','SW','W','NW','N'][Math.round(wd.wind.deg / 45) % 8]
                    : '';
                wind = `\u{1F4A8}${kmh}\u00A0km/h${dir ? '\u00A0' + dir : ''}`;
            }
            this._weatherLine = [wxDesc, temp, wind].filter(Boolean).join('  ') || null;
        } catch (_) {
            this._weatherLine = null;
        }

        // Schedule next refresh in 15 minutes.
        // Reset the shared promise so the next call triggers a fresh fetch
        // (all consumers will then await the new promise).
        setTimeout(() => {
            window.weatherPromise = null;
            this.loadWeatherData();
        }, 15 * 60 * 1000);
    }

    // Setup listener for filter latency changes
    setupFilterLatencyListener() {
        window.addEventListener('filterLatencyChanged', (event) => {
            this.cachedFilterLatency = event.detail.totalLatency;
            console.log(`Spectrum sync: Filter latency updated to ${this.cachedFilterLatency.toFixed(1)}ms`);
        });

        // Initialize cached latency value
        if (window.getTotalFilterLatency) {
            this.cachedFilterLatency = window.getTotalFilterLatency();
            console.log(`Spectrum sync: Initial filter latency ${this.cachedFilterLatency.toFixed(1)}ms`);
        }
    }

    // Setup bandwidth drag handlers on overlay canvas
    setupBandwidthDragHandlers() {
        // Add mousedown handler to detect clicks on bandwidth bracket
        this.overlayCanvas.addEventListener('mousedown', (e) => {
            // Only handle in bookmark area (top 45px)
            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (y > 45 || !this.currentTunedFreq || !this.totalBandwidth) return;

            // Calculate bandwidth edge positions
            const effectiveCenterFreq = this.isDragging ?
                this.centerFreq + this.predictedFreqOffset :
                this.centerFreq;
            const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
            const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

            // Check if tuned frequency is visible
            if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) return;

            // Calculate bandwidth edge x positions
            const lowFreq = this.currentTunedFreq + this.currentBandwidthLow;
            const highFreq = this.currentTunedFreq + this.currentBandwidthHigh;
            let xLow = ((lowFreq - startFreq) / (endFreq - startFreq)) * this.width;
            let xHigh = ((highFreq - startFreq) / (endFreq - startFreq)) * this.width;

            // For LSB mode, swap positions
            if (this.currentBandwidthLow < 0 && this.currentBandwidthHigh < 0) {
                [xLow, xHigh] = [xHigh, xLow];
            }

            // Check if click is near bandwidth bracket (y=45, within hitTolerance)
            const bracketY = 45;
            if (Math.abs(y - bracketY) > this.bandwidthDragState.hitTolerance) return;

            // Check if click is near low or high edge
            const nearLow = Math.abs(x - xLow) <= this.bandwidthDragState.hitTolerance;
            const nearHigh = Math.abs(x - xHigh) <= this.bandwidthDragState.hitTolerance;

            if (nearLow || nearHigh) {
                // Start dragging
                this.bandwidthDragState.isDragging = true;
                this.bandwidthDragState.draggedEdge = nearLow ? 'low' : 'high';
                this.bandwidthDragState.startX = x;
                this.bandwidthDragState.startBandwidthValue = nearLow ?
                    this.currentBandwidthLow : this.currentBandwidthHigh;

                // Change cursor
                this.overlayCanvas.style.cursor = 'ew-resize';

                // Prevent default to avoid text selection
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // Add mousemove handler for dragging
        this.overlayCanvas.addEventListener('mousemove', (e) => {
            if (!this.bandwidthDragState.isDragging) {
                // Update cursor when hovering over bandwidth bracket
                const rect = this.overlayCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                if (y <= 45 && this.currentTunedFreq && this.totalBandwidth) {
                    const effectiveCenterFreq = this.isDragging ?
                        this.centerFreq + this.predictedFreqOffset :
                        this.centerFreq;
                    const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
                    const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

                    if (this.currentTunedFreq >= startFreq && this.currentTunedFreq <= endFreq) {
                        const lowFreq = this.currentTunedFreq + this.currentBandwidthLow;
                        const highFreq = this.currentTunedFreq + this.currentBandwidthHigh;
                        let xLow = ((lowFreq - startFreq) / (endFreq - startFreq)) * this.width;
                        let xHigh = ((highFreq - startFreq) / (endFreq - startFreq)) * this.width;

                        if (this.currentBandwidthLow < 0 && this.currentBandwidthHigh < 0) {
                            [xLow, xHigh] = [xHigh, xLow];
                        }

                        const bracketY = 45;
                        const nearBracket = Math.abs(y - bracketY) <= this.bandwidthDragState.hitTolerance;
                        const nearLow = Math.abs(x - xLow) <= this.bandwidthDragState.hitTolerance;
                        const nearHigh = Math.abs(x - xHigh) <= this.bandwidthDragState.hitTolerance;
    
                        if (nearBracket && (nearLow || nearHigh)) {
                            this.overlayCanvas.style.cursor = 'ew-resize';
                            return;
                        }
                    }
                }
                this.overlayCanvas.style.cursor = 'default';
                return;
            }

            // Handle dragging
            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const deltaX = x - this.bandwidthDragState.startX;

            // Calculate frequency per pixel based on current spectrum view
            const effectiveCenterFreq = this.isDragging ?
                this.centerFreq + this.predictedFreqOffset :
                this.centerFreq;
            const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
            const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;
            const hzPerPixel = this.totalBandwidth / this.width;

            // Convert horizontal pixel movement to frequency change
            // Dragging right = increase frequency (more positive or less negative)
            // Dragging left = decrease frequency (less positive or more negative)
            const freqDelta = deltaX * hzPerPixel;

            // Calculate new bandwidth value
            let newValue = this.bandwidthDragState.startBandwidthValue + freqDelta;

            // Get mode-specific bandwidth limits from app.js
            const currentMode = window.currentMode ? window.currentMode.toLowerCase() : 'usb';
            let minLimit, maxLimit;

            // Define limits based on mode (matching setMode() in app.js)
            switch (currentMode) {
                case 'usb':
                    minLimit = 0;
                    maxLimit = 6000;
                    break;
                case 'lsb':
                    minLimit = -6000;
                    maxLimit = 0;
                    break;
                case 'cw':
                case 'cwu':
                case 'cwl':
                    minLimit = -500;
                    maxLimit = 500;
                    break;
                case 'am':
                case 'sam':
                    minLimit = -5000;
                    maxLimit = 5000;
                    break;
                case 'fm':
                case 'nfm':
                    minLimit = -8000;
                    maxLimit = 8000;
                    break;
                default:
                    minLimit = 0;
                    maxLimit = 6000;
            }

            // Clamp to mode-specific limits
            newValue = Math.max(minLimit, Math.min(maxLimit, newValue));

            // Round to nearest 10 Hz for cleaner values
            newValue = Math.round(newValue / 10) * 10;

            // Update the appropriate bandwidth edge
            if (this.bandwidthDragState.draggedEdge === 'low') {
                // Ensure low doesn't exceed high
                if (currentMode === 'lsb') {
                    // LSB: low is more negative than high
                    newValue = Math.min(newValue, this.currentBandwidthHigh - 50);
                } else {
                    // Other modes: low is less than high
                    newValue = Math.min(newValue, this.currentBandwidthHigh - 50);
                }

                this.currentBandwidthLow = newValue;
                window.currentBandwidthLow = newValue;

                // Update slider and display value in DOM
                const sliderElement = document.getElementById('bandwidth-low');
                const valueElement = document.getElementById('bandwidth-low-value');
                if (sliderElement) sliderElement.value = newValue;
                if (valueElement) valueElement.textContent = newValue;
            } else {
                // Ensure high doesn't go below low
                if (currentMode === 'lsb') {
                    // LSB: high is less negative than low
                    newValue = Math.max(newValue, this.currentBandwidthLow + 50);
                } else {
                    // Other modes: high is greater than low
                    newValue = Math.max(newValue, this.currentBandwidthLow + 50);
                }

                this.currentBandwidthHigh = newValue;
                window.currentBandwidthHigh = newValue;

                // Update slider and display value in DOM
                const sliderElement = document.getElementById('bandwidth-high');
                const valueElement = document.getElementById('bandwidth-high-value');
                if (sliderElement) sliderElement.value = newValue;
                if (valueElement) valueElement.textContent = newValue;
            }

            // Update display immediately
            this.drawTunedFrequencyCursor();

            // Trigger tune command with throttling (updateBandwidthDisplay handles this)
            if (window.updateBandwidthDisplay) {
                window.updateBandwidthDisplay();
            }

            e.preventDefault();
        });

        // Add mouseup handler to stop dragging
        this.overlayCanvas.addEventListener('mouseup', (e) => {
            if (this.bandwidthDragState.isDragging) {
                this.bandwidthDragState.isDragging = false;
                this.bandwidthDragState.draggedEdge = null;
                this.bandwidthDragState.wasDragging = true; // Set flag to prevent click event
                this.overlayCanvas.style.cursor = 'default';

                // Trigger final bandwidth update
                if (window.updateBandwidth) {
                    window.updateBandwidth();
                }

                e.preventDefault();
                e.stopPropagation();
            }
        });

        // Add mouseleave handler to cancel dragging
        this.overlayCanvas.addEventListener('mouseleave', () => {
            if (this.bandwidthDragState.isDragging) {
                this.bandwidthDragState.isDragging = false;
                this.bandwidthDragState.draggedEdge = null;
                this.bandwidthDragState.wasDragging = true; // Set flag to prevent click event
                this.overlayCanvas.style.cursor = 'default';

                // Trigger final bandwidth update
                if (window.updateBandwidth) {
                    window.updateBandwidth();
                }
            }
        });
    }

    // Resize canvas to match container
    resizeCanvas() {
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();

        // Set CSS size first
        const cssWidth = Math.floor(rect.width);
        const cssHeight = 600;
        this.canvas.style.width = cssWidth + 'px';
        this.canvas.style.height = cssHeight + 'px';

        // Set canvas pixel dimensions to match CSS size (1:1 ratio, no DPI scaling)
        // This prevents stretching and keeps text crisp
        this.canvas.width = cssWidth;
        this.canvas.height = cssHeight;

        // Reset context transform (no scaling needed with 1:1 ratio)
        if (this.ctx) {
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
    }

    // Queue spectrum frame for synchronized display with audio
    queueSpectrumFrame(data, serverTimestamp) {
        const frame = {
            data: data,
            receiveTime: serverTimestamp || Date.now()  // Use server timestamp if provided, fallback to client time
        };

        // Add to queue
        this.frameQueue.push(frame);

        // Limit queue size to prevent unbounded growth
        if (this.frameQueue.length > this.maxQueueSize) {
            this.frameQueue.shift(); // Remove oldest frame
        }

        // Start animation loop if not already running
        if (!this.animationLoopRunning) {
            this.startFrameProcessing();
        }
    }

    // Start animation loop to process queued frames
    startFrameProcessing() {
        if (this.animationLoopRunning) return;

        this.animationLoopRunning = true;
        console.log('Started spectrum frame processing loop');

        // Target 30fps for the render loop — enough for smooth waterfall scrolling and
        // cursor updates while keeping CPU usage comparable to the original implementation.
        const TARGET_FPS = 30;
        const FRAME_INTERVAL_MS = 1000 / TARGET_FPS; // ~33.3ms

        const processFrame = (timestamp) => {
            if (!this.animationLoopRunning) return;

            // Pause check — page is hidden (tab switch, mobile background).
            // Keep rAF alive so we can resume instantly without re-registering,
            // but skip all drawing and data consumption to save CPU.
            if (this.animationPaused) {
                requestAnimationFrame(processFrame);
                return;
            }

            // User-triggered waterfall pause: the WebSocket is closed so no new
            // frames will arrive. Skip ALL per-tick work — frame queue management,
            // audio sync calculations, scroll accumulator, drawing — and just keep
            // the rAF alive so resume is instant. Any residual queued frames are
            // discarded; they will be stale by the time the user resumes anyway.
            if (this._drawingPaused) {
                this.frameQueue = []; // discard stale frames accumulated before pause
                requestAnimationFrame(processFrame);
                return;
            }

            // User-triggered drawing pause: keep consuming data (S-meter, signal bar
            // stay live) but skip all canvas drawing.
            const drawingPaused = this._drawingPaused;

            // --- Frame rate throttle ---
            // Both CPU and GPU modes are throttled to 30fps. The GPU sub-pixel offset
            // accumulator uses elapsed wall-clock time, so smoothness is preserved at
            // any frame rate — 30fps gives 2-6 sub-pixel composites per waterfall row
            // at typical scroll speeds, which is visually indistinguishable from 60fps.
            requestAnimationFrame(processFrame);

            // --- Initialise timing on first tick ---
            if (this.lastRafTime === null) {
                this.lastRafTime = timestamp;
            }

            const sinceLastFrame = timestamp - this.lastRafTime;
            if (sinceLastFrame < FRAME_INTERVAL_MS) {
                return; // too soon — skip this tick
            }

            // Cap elapsed to 200ms so a hidden/backgrounded tab doesn't cause a huge jump
            const elapsed = Math.min(sinceLastFrame, 200);
            this.lastRafTime = timestamp;

            // --- Lazily read spectrum_poll_period from the API description ---
            // window.instanceDescription is populated by fetchSiteDescription() in app.js.
            // We read it lazily here so it is always available by the time the first frame arrives.
            if (!this.targetScrollRateInitialised) {
                const pollMs = window.instanceDescription?.spectrum_poll_period;
                if (pollMs && pollMs > 0) {
                    this.targetScrollRate = 1000 / pollMs;
                    this.targetScrollRateInitialised = true;
                    console.log(`Waterfall smooth scroll: ${this.targetScrollRate.toFixed(2)} rows/sec (poll period: ${pollMs}ms)`);
                }
                // If not yet available, keep the default 10 rows/sec until next tick
            }

            // --- Consume incoming data frames ---
            // Track whether new data arrived this tick so we know whether to redraw the line graph.
            let newDataArrived = false;

            // When spectrum sync is enabled, honour audio timing; otherwise take the latest frame.
            if (this.spectrumSyncEnabled && window.audioContext && window.nextPlayTime) {
                const currentTime = window.audioContext.currentTime;
                const bufferAhead = window.nextPlayTime - currentTime;
                const filterLatency = this.cachedFilterLatency / 1000;
                const now = Date.now();

                // ADAPTIVE FRAME DROPPING: prevent unbounded queue growth
                if (this.frameQueue.length > this.maxHealthyQueueSize) {
                    const dropped = this.frameQueue.length - this.maxHealthyQueueSize;
                    this.frameQueue.splice(0, dropped);
                    this.droppedFrameCount += dropped;
                    if (this.droppedFrameCount % 50 === 0) {
                        console.log(`Waterfall: Dropped ${this.droppedFrameCount} frames total to prevent lag`);
                    }
                }

                // Drop stale frames
                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    if (now - frame.receiveTime > this.maxFrameAge) {
                        this.frameQueue.shift();
                        this.droppedFrameCount++;
                    } else {
                        break;
                    }
                }

                // Consume frames whose display time has arrived
                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    const displayTime = frame.receiveTime - (bufferAhead * 1000) + (filterLatency * 1000) - (this.bufferMargin * 1000);
                    if (now >= displayTime) {
                        this.frameQueue.shift();
                        this._consumeNewFrame(frame.data);
                        newDataArrived = true;
                    } else {
                        break;
                    }
                }
            } else {
                // No audio sync — drop very old frames then take the latest available
                const now = Date.now();
                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    if (now - frame.receiveTime > 5000) {
                        this.frameQueue.shift();
                        this.droppedFrameCount++;
                    } else {
                        break;
                    }
                }
                if (this.frameQueue.length > 0) {
                    const frame = this.frameQueue.shift();
                    this._consumeNewFrame(frame.data);
                    newDataArrived = true;
                }
            }

            // --- Smooth scroll accumulator (skipped when drawing is user-paused) ---
            if (!drawingPaused && this.lastSpectrumRow) {
                if (this.gpuScrollEnabled) {
                    // GPU mode: advance a float offset every tick.
                    // The offscreen canvas is stamped onto the visible canvas with a fractional
                    // Y offset using drawImage — this gives sub-pixel smooth scrolling entirely
                    // within canvas-space, with no CSS transform side effects on overlays.
                    this.gpuScrollOffset += (elapsed / 1000) * this.targetScrollRate;

                    // Paint new rows for each whole pixel crossed
                    while (this.gpuScrollOffset >= 1.0) {
                        this.scrollWaterfallGPU();
                        this.gpuScrollOffset -= 1.0;
                    }

                    // Stamp offscreen canvas onto visible canvas with fractional sub-pixel Y shift.
                    // drawImage supports float coordinates — the browser interpolates sub-pixel rows.
                    this.scrollWaterfallGPUComposite();
                } else {
                    // CPU mode: integer-pixel drawImage scroll at 30fps
                    this.scrollAccumulator += (elapsed / 1000) * this.targetScrollRate;

                    while (this.scrollAccumulator >= 1.0) {
                        this.scrollWaterfallOneRow();
                        this.scrollAccumulator -= 1.0;
                    }
                }
            }

            // --- Redraw line graph every rAF tick (30fps) so the EMA trace flows
            // smoothly between data frames regardless of the server divisor.
            // The EMA buffer (specEma) interpolates toward the latest spectrumData
            // each tick — identical to how the waterfall scroll accumulator repaints
            // at 30fps using lastSpectrumRow between data arrivals.
            // Cost: drawLineGraph() is a canvas 2D path draw — not expensive at 30fps.
            if (!drawingPaused && this.spectrumData) {
                this.drawLineGraph();
            }

            // --- Redraw overlay (cursor, bookmarks) every rendered frame ---
            if (!drawingPaused) {
                this.drawTunedFrequencyCursor();
            }
        };

        requestAnimationFrame(processFrame);
    }

    // Consume a newly-arrived spectrum data frame:
    // update spectrumData, run side-effects (signal meter, decoder extensions, tooltip),
    // but do NOT draw the waterfall row — that is handled by the smooth scroll accumulator.
    _consumeNewFrame(data) {
        this.spectrumData = data;
        this.lastSpectrumRow = data;
        const now = Date.now();
        this.lastUpdate = now;

        // Track inter-frame interval for adaptive EMA time constant.
        // EMA with α=0.2 gives a ~5-frame smoothed estimate — stable but responsive.
        if (this.lastDataFrameTime > 0) {
            const dt = Math.min(2000, Math.max(20, now - this.lastDataFrameTime));
            this.avgDataFrameMs = this.avgDataFrameMs * 0.8 + dt * 0.2;
        }
        this.lastDataFrameTime = now;

        // Update tooltip with new data even if mouse hasn't moved
        if (this.mouseX >= 0 && this.mouseY >= 0 && !this.isDragging) {
            this.updateTooltip();
        }

        // Process spectrum data for decoder extensions
        if (window.decoderManager) {
            const spectrumDataForExtensions = {
                powers: this.spectrumData,
                centerFreq: this.centerFreq,
                binBandwidth: this.binBandwidth,
                binCount: this.binCount,
                totalBandwidth: this.totalBandwidth
            };
            window.decoderManager.processSpectrum(spectrumDataForExtensions);
        }
    }

    // Stop frame processing loop
    stopFrameProcessing() {
        this.animationLoopRunning = false;
        this.frameQueue = [];
        console.log('Stopped spectrum frame processing loop');
    }

    // Pause the animation loop without stopping it.
    // The rAF callback keeps firing but returns immediately, costing ~0 CPU.
    // Use this when the page is hidden — avoids the overhead of stopping and
    // restarting the loop (which clears the frame queue and resets timing).
    pauseAnimation() {
        if (this.animationPaused) return;
        this.animationPaused = true;
        // Reset timing so the first resumed frame doesn't try to catch up on
        // all the elapsed time while paused (would cause a huge scroll jump).
        this.lastRafTime = null;
        this.scrollAccumulator = 0;
        this.gpuScrollOffset = 0;
        console.log('Spectrum animation paused');
    }

    // Resume the animation loop after a pause.
    resumeAnimation() {
        if (!this.animationPaused) return;
        this.animationPaused = false;
        console.log('Spectrum animation resumed');
    }

    // User-triggered pause: freeze the waterfall/spectrum canvas but keep the
    // WebSocket open and keep consuming data so the S-meter and signal bar stay live.
    // Also closes the WebSocket to stop the server sending spectrum data (saves bandwidth).
    userPause() {
        if (this._drawingPaused) return;
        this._drawingPaused = true;
        // Reset scroll accumulators so resume doesn't try to catch up
        this.scrollAccumulator = 0;
        this.gpuScrollOffset = 0;
        // Close WebSocket — scheduleReconnect() will skip auto-reconnect because
        // we set _userPaused before closing.
        this._userPaused = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('User paused — closing spectrum WebSocket');
            this.ws.close();
        }
        console.log('Spectrum drawing paused by user');
    }

    // User-triggered resume: unfreeze the canvas and reconnect the WebSocket.
    userResume() {
        if (!this._drawingPaused) return;
        this._drawingPaused = false;
        this._userPaused = false;
        // Reset timing so the first resumed frame doesn't jump
        this.lastRafTime = null;
        this.scrollAccumulator = 0;
        this.gpuScrollOffset = 0;
        // Reconnect immediately (no backoff)
        this.reconnectAttempts = 0;
        this.connect().catch(err => {
            console.error('User resume reconnect failed:', err);
        });
        console.log('Spectrum drawing resumed by user');
    }

    // Display a spectrum frame (legacy entry point — delegates to _consumeNewFrame).
    // The waterfall scroll is now driven by the smooth-scroll accumulator in
    // startFrameProcessing(), so this no longer calls drawWaterfall() directly.
    displayFrame(data) {
        this._consumeNewFrame(data);
    }

    // Connect to spectrum WebSocket
    async connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        // Check if connection will be allowed before attempting WebSocket connection
        try {
            const userSessionID = window.userSessionID || '';
            const requestBody = {
                user_session_id: userSessionID
            };

            // Add bypass password if available
            if (window.bypassPassword) {
                requestBody.password = window.bypassPassword;
            }

            const checkResponse = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const checkData = await checkResponse.json();

            if (!checkData.allowed) {
                // Connection not allowed - don't attempt WebSocket connection
                console.log(`Spectrum connection rejected: ${checkData.reason}`);

                // Don't attempt reconnection if banned, kicked, or max sessions reached
                if (checkData.reason.includes('banned') ||
                    checkData.reason.includes('terminated') ||
                    checkData.reason.includes('Maximum')) {
                    this.userDisconnected = true;
                    return;
                }

                // CRITICAL: Return here to prevent WebSocket creation
                return;
            }
            console.log('Spectrum connection check passed');
        } catch (err) {
            console.error('Spectrum connection check failed:', err);
            // Continue with connection attempt even if check fails
        }

        // Build WebSocket URL with session ID, password, and binary mode
        const userSessionID = window.userSessionID || '';
        const wsUrlBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/user-spectrum`;
        let wsUrl = userSessionID ? `${wsUrlBase}?user_session_id=${encodeURIComponent(userSessionID)}` : wsUrlBase;

        // Add bypass password if available
        if (window.bypassPassword) {
            wsUrl += `&password=${encodeURIComponent(window.bypassPassword)}`;
        }

        // Request binary8 mode for maximum bandwidth reduction (8-bit encoding)
        wsUrl += `&mode=binary8`;

        // Pass current view state so the server starts the session at the correct
        // frequency/zoom immediately — no post-connect zoom/pan round-trip needed
        // and no race with the server's initial config message.
        if (this.centerFreq > 0) {
            wsUrl += `&frequency=${Math.round(this.centerFreq)}`;
        }
        const _lastZoom = this._lastSentByType && this._lastSentByType.zoom;
        if (_lastZoom && _lastZoom.msg && _lastZoom.msg.binBandwidth > 0) {
            wsUrl += `&bin_bandwidth=${_lastZoom.msg.binBandwidth}`;
        }

        console.log('Connecting to spectrum WebSocket:', wsUrl);

        // Store connection URL params for external use (user_session_id, password, mode)
        this._lastConnectUrl = wsUrl;

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer'; // Enable binary message handling

            // Wrap ws.send to track the last sent message of each type.
            // All senders (app.js, bookmark-manager.js, chat-ui.js, extensions.js, etc.)
            // access spectrumDisplay.ws.send() directly, so wrapping here catches everything
            // without modifying any call sites. Re-applied on every reconnect.
            this._lastSentByType = this._lastSentByType || {};
            const _origSend = this.ws.send.bind(this.ws);
            this.ws.send = (data) => {
                if (typeof data === 'string') {
                    try {
                        const msg = JSON.parse(data);
                        if (msg && msg.type) {
                            this._lastSentByType[msg.type] = { msg, time: Date.now() };
                        }
                    } catch (e) { /* not JSON, ignore */ }
                }
                return _origSend(data);
            };

            // Track if we've detected binary protocol
            this.usingBinaryProtocol = false;
            this.binarySpectrumData = null; // State for delta decoding

            this.ws.onopen = () => {
                console.log('Spectrum WebSocket connected');
                this.connected = true;
                // Don't reset reconnection attempts immediately - wait for first successful message
                // This prevents resetting the counter when server immediately kicks us
                // The counter will be reset when we receive our first config message

                // Keepalive ping is now handled by idle detector based on user activity

                // Start periodic settings sync now that connection is established
                this.startSettingsSync();

                // Register visibility disconnect handler (once — idempotent)
                this.setupVisibilityDisconnect();

                // If reconnecting after a visibility-triggered disconnect, immediately
                // resend the last known zoom/pan/rate so the server is in sync.
                if (this._lastSentByType && Object.keys(this._lastSentByType).length > 0) {
                    this.sendSettingsSync();
                }

                if (this.config.onConnect) {
                    this.config.onConnect();
                }
            };

            this.ws.onmessage = async (event) => {
                try {
                    let msg;
                    let byteLength;

                    // Check if message is binary protocol (ArrayBuffer) or JSON
                    if (event.data instanceof ArrayBuffer) {
                        // Binary protocol - check magic header
                        const view = new DataView(event.data);
                        byteLength = event.data.byteLength;

                        // Check for "SPEC" magic (0x53 0x50 0x45 0x43)
                        if (byteLength >= 4 &&
                            view.getUint8(0) === 0x53 &&
                            view.getUint8(1) === 0x50 &&
                            view.getUint8(2) === 0x45 &&
                            view.getUint8(3) === 0x43) {

                            // Binary spectrum protocol detected
                            if (!this.usingBinaryProtocol) {
                                this.usingBinaryProtocol = true;
                                console.log('🚀 Binary spectrum protocol detected - bandwidth optimized!');
                            }

                            // Parse binary spectrum message
                            msg = this.parseBinarySpectrum(view);
                        } else {
                            // Legacy binary (gzipped JSON) - decompress
                            const decompressedStream = new Response(
                                new Blob([event.data]).stream().pipeThrough(new DecompressionStream('gzip'))
                            );
                            const decompressedText = await decompressedStream.text();
                            msg = JSON.parse(decompressedText);
                        }
                    } else if (event.data instanceof Blob) {
                        // Blob message - decompress with gzip (legacy format)
                        const compressedData = await event.data.arrayBuffer();
                        byteLength = compressedData.byteLength;

                        const decompressedStream = new Response(
                            new Blob([compressedData]).stream().pipeThrough(new DecompressionStream('gzip'))
                        );
                        const decompressedText = await decompressedStream.text();
                        msg = JSON.parse(decompressedText);
                    } else {
                        // Text message - parse directly (JSON)
                        byteLength = event.data.length;
                        msg = JSON.parse(event.data);
                    }

                    this.bytesReceived += byteLength;
                    this.messageCount++;

                    // Update bit rate display every second
                    const now = Date.now();
                    const timeSinceLastUpdate = now - this.lastBitrateUpdate;
                    if (timeSinceLastUpdate >= 1000) {
                        // Calculate KB/s
                        this.currentBitrate = (this.bytesReceived / 1024) / (timeSinceLastUpdate / 1000);

                        this.updateBitrateDisplay();

                        // Reset counters
                        this.bytesReceived = 0;
                        this.messageCount = 0;
                        this.lastBitrateUpdate = now;
                    }

                    this.handleMessage(msg);
                } catch (err) {
                    console.error('Error parsing spectrum message:', err);
                }
            };

            this.ws.onerror = (error) => {
                console.error('Spectrum WebSocket error:', error);
            };

            this.ws.onclose = () => {
                console.log('Spectrum WebSocket closed');
                this.connected = false;

                // Stop settings sync when connection closes
                this.stopSettingsSync();

                // Keepalive ping is now handled by idle detector

                if (this.config.onDisconnect) {
                    this.config.onDisconnect();
                }

                // Only schedule reconnect if we don't already have one pending
                if (!this.reconnectTimer) {
                    this.scheduleReconnect();
                }
            };
        } catch (err) {
            console.error('Failed to create spectrum WebSocket:', err);
            this.scheduleReconnect();
        }
    }

    // Disconnect from WebSocket
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Keepalive ping is now handled by idle detector

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        // Stop frame processing
        this.stopFrameProcessing();

        // Stop sync monitoring
        this.stopSyncMonitoring();

        // Stop settings sync
        this.stopSettingsSync();

        this.connected = false;
    }

    // Schedule reconnection attempt with exponential backoff
    scheduleReconnect() {
        // Don't reconnect if user explicitly disconnected (e.g., idle timeout)
        if (this.userDisconnected) {
            console.log('Skipping spectrum reconnect - user disconnected');
            return;
        }

        // Don't reconnect if we intentionally closed due to page being hidden —
        // the visibility handler will reconnect when the page becomes visible again.
        if (this._visibilityDisconnected) {
            console.log('Skipping spectrum reconnect - page hidden (will reconnect on visibility)');
            return;
        }

        if (this._userPaused) {
            console.log('Skipping spectrum reconnect - user paused (will reconnect on resume)');
            return;
        }

        // Check if we've exceeded max attempts FIRST
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log(`Spectrum reconnection failed after ${this.maxReconnectAttempts} attempts`);
            // Only show notification once when max attempts reached (check flag FIRST)
            if (!this.connectionFailureNotified && typeof showNotification === 'function') {
                this.connectionFailureNotified = true;
                showNotification('Connection lost. Please refresh the page.', 'error');
            }
            return;
        }

        // Don't schedule if we already have a timer pending
        if (this.reconnectTimer) {
            console.log('Spectrum reconnect already scheduled, skipping');
            return;
        }

        this.reconnectAttempts++;

        // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
        const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 60000);

        console.log(`Spectrum reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // Keepalive ping is now handled by idle detector based on user activity
    // These methods are kept for compatibility but do nothing
    startPing() {
        // No-op: ping handled by idle detector
    }

    stopPing() {
        // No-op: ping handled by idle detector
    }

    // Parse binary spectrum message
    parseBinarySpectrum(view) {
        // Parse header (22 bytes)
        const version = view.getUint8(4);
        const flags = view.getUint8(5);
        const timestamp = Number(view.getBigUint64(6, true)); // little-endian
        const frequency = Number(view.getBigUint64(14, true)); // little-endian

        if (version !== 0x01) {
            console.error('Unsupported binary protocol version:', version);
            return null;
        }

        let spectrumData;

        if (flags === 0x01) {
            // Full frame (float32)
            const binCount = (view.byteLength - 22) / 4;
            spectrumData = new Float32Array(binCount);

            for (let i = 0; i < binCount; i++) {
                spectrumData[i] = view.getFloat32(22 + i * 4, true); // little-endian
            }

            // Store for delta decoding
            this.binarySpectrumData = new Float32Array(spectrumData);

        } else if (flags === 0x02) {
            // Delta frame (float32)
            if (!this.binarySpectrumData) {
                console.error('Delta frame received before full frame');
                return null;
            }

            const changeCount = view.getUint16(22, true); // little-endian
            let offset = 24;

            // Apply changes to previous data
            for (let i = 0; i < changeCount; i++) {
                const index = view.getUint16(offset, true); // little-endian
                const value = view.getFloat32(offset + 2, true); // little-endian
                this.binarySpectrumData[index] = value;
                offset += 6;
            }

            spectrumData = this.binarySpectrumData;

        } else if (flags === 0x03) {
            // Full frame (uint8) - binary8 format
            const binCount = view.byteLength - 22;
            spectrumData = new Float32Array(binCount);

            for (let i = 0; i < binCount; i++) {
                // Convert uint8 to dBFS: 0 = -256 dB, 255 = -1 dB
                const uint8Value = view.getUint8(22 + i);
                spectrumData[i] = uint8Value - 256;
            }

            // Store for delta decoding (as uint8)
            this.binarySpectrumData8 = new Uint8Array(binCount);
            for (let i = 0; i < binCount; i++) {
                this.binarySpectrumData8[i] = view.getUint8(22 + i);
            }

            // Log first binary8 frame
            if (!this.binary8Logged) {
                this.binary8Logged = true;
                console.log('🚀 Binary8 protocol active - 75% bandwidth reduction vs float32!');
            }

        } else if (flags === 0x04) {
            // Delta frame (uint8) - binary8 format
            if (!this.binarySpectrumData8) {
                console.error('Binary8 delta frame received before full frame');
                return null;
            }

            const changeCount = view.getUint16(22, true); // little-endian
            let offset = 24;

            // Apply changes to previous uint8 data
            for (let i = 0; i < changeCount; i++) {
                const index = view.getUint16(offset, true); // little-endian
                const value = view.getUint8(offset + 2); // uint8 value
                this.binarySpectrumData8[index] = value;
                offset += 3; // 2 bytes index + 1 byte value
            }

            // Convert uint8 array to float32 for display
            spectrumData = new Float32Array(this.binarySpectrumData8.length);
            for (let i = 0; i < this.binarySpectrumData8.length; i++) {
                spectrumData[i] = this.binarySpectrumData8[i] - 256;
            }

        } else {
            console.error('Unknown binary frame flags:', flags);
            return null;
        }

        // Return in same format as JSON messages
        return {
            type: 'spectrum',
            data: Array.from(spectrumData),
            frequency: frequency,
            timestamp: timestamp
        };
    }

    // Handle incoming WebSocket messages
    handleMessage(msg) {
        switch (msg.type) {
            case 'error':
                // Handle rate limit errors (status 429)
                if (msg.status === 429) {
                    console.warn('⚠️ Spectrum rate limit exceeded:', msg.error);
                    return; // Don't show error to user, just log it
                }
                // Handle other errors normally
                console.error('Spectrum error:', msg.error);
                break;

            case 'config':
                // CRITICAL: Clear peak hold FIRST before updating any config values
                // This prevents NaN values when spectrum data arrives with old peak hold data
                const oldCenterFreq = this.centerFreq;
                const oldTotalBandwidth = this.totalBandwidth;
                const oldBinCount = this.binCount;

                // Clear peak hold immediately if frequency range or bin count will change
                if ((oldCenterFreq !== 0 && oldCenterFreq !== msg.centerFreq) ||
                    (oldTotalBandwidth !== 0 && oldTotalBandwidth !== msg.totalBandwidth) ||
                    (oldBinCount !== 0 && oldBinCount !== msg.binCount)) {
                    this.peakHoldData = null;
                }

                this.centerFreq = msg.centerFreq;
                this.binCount = msg.binCount;
                this.binBandwidth = msg.binBandwidth;
                this.totalBandwidth = msg.totalBandwidth;

                // Track the minimum binBandwidth seen from the server (= actual max zoom)
                if (!this.minBinBandwidth || this.binBandwidth < this.minBinBandwidth) {
                    this.minBinBandwidth = this.binBandwidth;
                }

                // Track server-confirmed center frequency for prediction sync
                this.lastServerCenterFreq = msg.centerFreq;

                // CRITICAL FIX: Always clear prediction offset when not dragging
                // This prevents lingering offsets from causing cursor/spectrum desync
                if (this.isDragging) {
                    // Adjust offset to account for server's actual position
                    const serverOffset = msg.centerFreq - this.dragStartFreq;
                    this.predictedFreqOffset = serverOffset;
                } else {
                    // Always reset prediction when server confirms position and we're not dragging
                    this.predictedFreqOffset = 0;
                }

                // Store initial bin bandwidth on first config (for zoom level calculation)
                if (!this.initialBinBandwidth) {
                    this.initialBinBandwidth = this.binBandwidth;
                }

                // Update zoom level: how much we've zoomed from initial
                this.zoomLevel = this.initialBinBandwidth / this.binBandwidth;

                // Keep zoom slider in sync with server-reported zoom level
                if (typeof window.updateZoomSlider === 'function') {
                    window.updateZoomSlider();
                }

                // Update cursor style based on new bandwidth
                this.updateCursorStyle();

                if (this.config.onConfig) {
                    this.config.onConfig(msg);
                }
                break;

            case 'spectrum':
                // Unwrap FFT bin ordering from radiod
                // radiod sends: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
                // We need: [negative freqs, positive freqs] for low-to-high frequency display
                const rawData = msg.data;
                const N = rawData.length;
                const halfBins = Math.floor(N / 2);

                const unwrappedData = new Float32Array(N);

                // Put second half (negative frequencies) first
                for (let i = 0; i < halfBins; i++) {
                    unwrappedData[i] = rawData[halfBins + i];
                }
                // Put first half (positive frequencies) second
                for (let i = 0; i < halfBins; i++) {
                    unwrappedData[halfBins + i] = rawData[i];
                }

                // Log only once for debugging
                if (!this.spectrumLogged) {
                    this.spectrumLogged = true;
                    console.log(`=== SPECTRUM UNWRAPPED ===`);
                    console.log(`After unwrap - First 5 bins: ${unwrappedData.slice(0, 5).map(v => v.toFixed(1)).join(', ')}`);
                    console.log(`After unwrap - Middle 5 bins: ${unwrappedData.slice(1022, 1027).map(v => v.toFixed(1)).join(', ')}`);
                    console.log(`After unwrap - Last 5 bins: ${unwrappedData.slice(-5).map(v => v.toFixed(1)).join(', ')}`);
                }

                // Queue frame with server timestamp for accurate synchronization
                this.queueSpectrumFrame(unwrappedData, msg.timestamp);
                break;

            case 'pong':
                // Keepalive response
                break;

            default:
                console.warn('Unknown spectrum message type:', msg.type);
        }
    }

    // Draw the spectrum display (split mode only: line graph on top, waterfall on bottom).
    // NOTE: With smooth scrolling, the waterfall is no longer driven from here — it is
    // advanced by the scroll accumulator in startFrameProcessing() via scrollWaterfallOneRow().
    // draw() is kept for any legacy callers; it redraws the line graph and overlay only.
    draw() {
        if (!this.spectrumData || this.spectrumData.length === 0) {
            this.drawPlaceholder();
            return;
        }

        // Draw line graph in top half
        this.drawLineGraph();

        // Update line graph tooltip with new data if mouse is over it
        if (this.lineGraphMouseX && this.lineGraphMouseY) {
            const x = this.lineGraphMouseX();
            const y = this.lineGraphMouseY();
            if (x >= 0 && y >= 0) {
                this.updateLineGraphTooltip(x, y);
            }
        }

        // Draw tuned frequency cursor on overlay canvas
        this.drawTunedFrequencyCursor();
    }

    // Scroll the waterfall canvas down by one pixel and paint the current spectrum data
    // as a new row at the top. Called by the smooth-scroll accumulator in startFrameProcessing()
    // at a steady rate derived from spectrum_poll_period, so the waterfall always scrolls
    // smoothly at ~60fps regardless of how infrequently new data arrives.
    scrollWaterfallOneRow() {
        if (!this.spectrumData || this.spectrumData.length === 0) return;

        // Update auto-range on every painted row so colours stay calibrated
        if (this.config.autoRange) {
            this.updateAutoRange();
        }

        // Waterfall starts at y=75 when line graph is hidden, y=0 in split mode
        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
        const waterfallStartY = lineGraphVisible ? 0 : 75;
        const waterfallHeight = this.height - waterfallStartY - 1;

        // Initialise image data buffer and canvas background on first call
        if (!this.waterfallImageData) {
            console.log(`[scrollWaterfallOneRow] Initialising waterfall in ${this.displayMode} mode, canvas height: ${this.height}`);
            this.waterfallImageData = this.ctx.createImageData(this.width, 1);
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, waterfallStartY, this.width, this.height - waterfallStartY);
        }

        if (!this.waterfallStartTime) {
            this.waterfallStartTime = Date.now();
            this.waterfallLineCount = 0;
        }

        // Log only first time in split mode
        if (this.displayMode === 'split' && !this.splitModeLogged) {
            console.log(`[scrollWaterfallOneRow] Split mode - waterfallStartY: ${waterfallStartY}, waterfallHeight: ${waterfallHeight}, canvas height: ${this.height}`);
            this.splitModeLogged = true;
        }

        // Scroll existing waterfall down by 1 pixel (pixel-perfect, no scaling)
        this.ctx.drawImage(this.canvas, 0, waterfallStartY, this.width, waterfallHeight - 1, 0, waterfallStartY + 1, this.width, waterfallHeight - 1);

        // Build the new top row from the most recent spectrum data
        const pixelData = this.waterfallImageData.data;
        const dbRange = this.actualMaxDb - this.actualMinDb;

        for (let x = 0; x < this.width; x++) {
            const binPos = (x / this.width) * this.spectrumData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

            let db;
            if (binIndex >= 0 && binIndex < this.spectrumData.length - 1) {
                const db1 = this.spectrumData[binIndex];
                const db2 = this.spectrumData[binIndex + 1];
                db = db1 + (db2 - db1) * binFrac;
            } else if (binIndex === this.spectrumData.length - 1) {
                db = this.spectrumData[binIndex];
            } else {
                db = this.actualMinDb;
            }

            let normalized = Math.max(0, Math.min(1, (db - this.actualMinDb) / dbRange));
            let magnitude = normalized * 255;

            if (!this.config.manualRangeEnabled && magnitude < this.config.contrast) {
                magnitude = 0;
            } else if (!this.config.manualRangeEnabled) {
                magnitude = ((magnitude - this.config.contrast) / (255 - this.config.contrast)) * 255;
            }

            if (this.config.intensity < 0) {
                magnitude = magnitude * (1 + this.config.intensity);
            } else if (this.config.intensity > 0) {
                magnitude = Math.min(255, magnitude * (1 + this.config.intensity * 2));
            }

            normalized = magnitude / 255;
            const color = this.getColorRGB(normalized);

            const offset = x * 4;
            pixelData[offset]     = color.r;
            pixelData[offset + 1] = color.g;
            pixelData[offset + 2] = color.b;
            pixelData[offset + 3] = 255;
        }

        this.ctx.putImageData(this.waterfallImageData, 0, waterfallStartY);
        this.waterfallLineCount++;

        if (this.displayMode === 'split' && this.waterfallLineCount <= 3) {
            console.log(`[scrollWaterfallOneRow] Drew waterfall line #${this.waterfallLineCount} at y=${waterfallStartY}`);
        }
    }

    // drawWaterfall() is kept for any legacy callers but now simply delegates to scrollWaterfallOneRow().
    drawWaterfall() {
        this.scrollWaterfallOneRow();
    }

    // GPU sub-pixel waterfall scroll.
    //
    // Strategy: use an offscreen canvas as the true waterfall buffer. It scrolls exactly
    // like the CPU path (drawImage + putImageData). The visible on-screen canvas is then
    // stamped from the offscreen canvas every whole-pixel step. Between whole-pixel steps
    // the CSS translateY on the on-screen canvas provides the fractional sub-pixel shift,
    // which the browser compositor handles in hardware — giving true smooth 60fps motion.
    //
    // This avoids the ring-buffer complexity entirely and is guaranteed correct.
    scrollWaterfallGPU() {
        if (!this.spectrumData || this.spectrumData.length === 0) return;

        if (this.config.autoRange) {
            this.updateAutoRange();
        }

        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
        const waterfallStartY = lineGraphVisible ? 0 : 75;
        const waterfallHeight = this.height - waterfallStartY - 1;

        // Lazily create the offscreen canvas (same dimensions as the visible canvas)
        if (!this.gpuOffscreenCanvas || this.gpuOffscreenCanvas.width !== this.width || this.gpuOffscreenCanvas.height !== this.height) {
            this.gpuOffscreenCanvas = document.createElement('canvas');
            this.gpuOffscreenCanvas.width = this.width;
            this.gpuOffscreenCanvas.height = this.height;
            this.gpuOffscreenCtx = this.gpuOffscreenCanvas.getContext('2d', { alpha: false });
            this.gpuOffscreenCtx.fillStyle = '#000';
            this.gpuOffscreenCtx.fillRect(0, 0, this.width, this.height);
        }

        if (!this.waterfallImageData) {
            this.waterfallImageData = this.gpuOffscreenCtx.createImageData(this.width, 1);
        }
        if (!this.waterfallStartTime) {
            this.waterfallStartTime = Date.now();
            this.waterfallLineCount = 0;
        }

        // 1. Scroll the offscreen canvas down by 1 pixel (same as CPU path)
        this.gpuOffscreenCtx.drawImage(
            this.gpuOffscreenCanvas,
            0, waterfallStartY, this.width, waterfallHeight - 1,
            0, waterfallStartY + 1, this.width, waterfallHeight - 1
        );

        // 2. Build the new top row from current spectrum data
        const pixelData = this.waterfallImageData.data;
        const dbRange = this.actualMaxDb - this.actualMinDb;

        for (let x = 0; x < this.width; x++) {
            const binPos = (x / this.width) * this.spectrumData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

            let db;
            if (binIndex >= 0 && binIndex < this.spectrumData.length - 1) {
                db = this.spectrumData[binIndex] + (this.spectrumData[binIndex + 1] - this.spectrumData[binIndex]) * binFrac;
            } else if (binIndex === this.spectrumData.length - 1) {
                db = this.spectrumData[binIndex];
            } else {
                db = this.actualMinDb;
            }

            let normalized = Math.max(0, Math.min(1, (db - this.actualMinDb) / dbRange));
            let magnitude = normalized * 255;

            if (!this.config.manualRangeEnabled && magnitude < this.config.contrast) {
                magnitude = 0;
            } else if (!this.config.manualRangeEnabled) {
                magnitude = ((magnitude - this.config.contrast) / (255 - this.config.contrast)) * 255;
            }

            if (this.config.intensity < 0) {
                magnitude = magnitude * (1 + this.config.intensity);
            } else if (this.config.intensity > 0) {
                magnitude = Math.min(255, magnitude * (1 + this.config.intensity * 2));
            }

            normalized = magnitude / 255;
            const color = this.getColorRGB(normalized);
            const offset = x * 4;
            pixelData[offset]     = color.r;
            pixelData[offset + 1] = color.g;
            pixelData[offset + 2] = color.b;
            pixelData[offset + 3] = 255;
        }

        // 3. Write the new row at the top of the offscreen canvas
        this.gpuOffscreenCtx.putImageData(this.waterfallImageData, 0, waterfallStartY);
        // Note: do NOT stamp to visible canvas here — scrollWaterfallGPUComposite() handles
        // that every rAF tick with the correct fractional sub-pixel offset.

        this.waterfallLineCount++;
    }

    // Composite the offscreen waterfall canvas onto the visible canvas with a fractional
    // sub-pixel Y offset. drawImage supports float destination coordinates — the browser
    // interpolates between rows, giving smooth sub-pixel motion entirely within canvas-space.
    // No CSS transform is used, so overlays (frequency bar, bookmarks) are unaffected.
    scrollWaterfallGPUComposite() {
        if (!this.gpuOffscreenCanvas) return;

        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
        const waterfallStartY = lineGraphVisible ? 0 : 75;
        const waterfallHeight = this.height - waterfallStartY;

        // Draw offscreen canvas onto visible canvas shifted down by the fractional offset.
        // Source: full waterfall area of offscreen canvas, minus the bottom strip that would
        //         scroll off the bottom edge.
        // Destination: shifted down by gpuScrollOffset (fractional pixels, 0..1).
        //
        // We do NOT clear the whole waterfall area first — that caused a 0..1px black gap
        // at the top to flicker every frame. Instead we draw the shifted content first, then
        // fill only the tiny exposed strip at the top (at most 1px, usually sub-pixel).
        const srcHeight = waterfallHeight - this.gpuScrollOffset; // clip bottom to avoid overflow
        this.ctx.drawImage(
            this.gpuOffscreenCanvas,
            0, waterfallStartY,                          // source x, y
            this.width, srcHeight,                       // source width, height (clipped)
            0, waterfallStartY + this.gpuScrollOffset,   // dest x, y (fractional)
            this.width, srcHeight                        // dest width, height
        );

        // Fill the sub-pixel gap at the top with black (at most 1px tall).
        // Only needed when waterfallStartY > 0 (full-screen mode with frequency scale above).
        // In split view (waterfallStartY = 0) the grey separator line on the line graph canvas
        // covers this seam, so filling it would cause visible flicker at the join.
        if (this.gpuScrollOffset > 0 && waterfallStartY > 0) {
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, waterfallStartY, this.width, this.gpuScrollOffset);
        }
    }

    // Reset GPU scroll state (called when switching modes or resizing)
    resetGPUScroll() {
        this.gpuScrollOffset = 0;
        this.gpuScrollBaseOffset = 0;
        // Discard offscreen canvas so it is recreated on next scrollWaterfallGPU() call
        this.gpuOffscreenCanvas = null;
        this.gpuOffscreenCtx = null;
        this.waterfallImageData = null;
        // Clear the visible canvas
        if (this.ctx) {
            const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
            const waterfallStartY = lineGraphVisible ? 0 : 75;
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, waterfallStartY, this.width, this.height - waterfallStartY);
        }
    }

    // Draw line graph in top half (split mode only)
    drawLineGraph() {
        // Skip if line graph is not visible
        if (!this.lineGraphCanvas || !this.lineGraphCtx || !this.spectrumData) return;
        if (this.lineGraphCanvas.style.display === 'none') return;

        // Set canvas size to match main canvas width
        if (this.lineGraphCanvas.width !== this.width) {
            this.lineGraphCanvas.width = this.width;
            this.lineGraphCanvas.height = 300;
            this.lineGraphCanvas.style.width = this.width + 'px';
            this.lineGraphCanvas.style.height = '300px';
        }

        // NOTE: the old applyPredictedShiftToLineGraph() call was removed here — it
        // copied the whole canvas through a freshly-allocated temp canvas, and its
        // result was then fully painted over by the black fillRect below, so it was
        // pure per-frame allocation churn with no visual effect.

        const ctx = this.lineGraphCtx;
        const graphHeight = 300;
        const graphWidth = this.width;
        const graphTopMargin = 80; // Space for frequency scale at top (45px) + bookmarks overlay (45px)
        const graphDrawHeight = graphHeight - graphTopMargin; // Actual drawing area height

        // Clear canvas - black background for entire graph
        // (grey bookmark background is now in overlay)
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, graphWidth, graphHeight);

        // Draw custom background image stretched to fill the spectrum drawing area
        // (below the 80 px frequency-scale margin, above the bottom separator)
        if (this.lineGraphBgImage) {
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, this.lineGraphBgOpacity));
            ctx.drawImage(this.lineGraphBgImage, 0, graphTopMargin, graphWidth, graphDrawHeight);
            ctx.restore();
        }

        // Apply asymmetric EMA smoothing (always on; checkbox controls time constant).
        //   - dtSec clamped min 0.01 / default 0.1 (matches signalProcessor.ts:152-154)
        //   - fallAlpha = 1 - exp(-dtSec / tcFall), capped at 0.95
        //   - riseAlpha = min(0.95, fallAlpha * 4)  ← derived from fall, guarantees 4× ratio
        const now = Date.now();
        const dtSec = this.specEmaLastFrameTime
            ? Math.min(0.5, Math.max(0.01, (now - this.specEmaLastFrameTime) / 1000))
            : 0.1; // conservative first-call default
        this.specEmaLastFrameTime = now;

        // Allocate / resize EMA buffer (primed from real data — zero settling delay)
        if (!this.specEma || this.specEma.length !== this.spectrumData.length) {
            this.specEma = new Float32Array(this.spectrumData);
        }

        // Adaptive fall time constant: scales with the measured data frame interval
        // so the trace always flows smoothly between frames regardless of divisor.
        //   LIGHT (Smooth OFF): tcFall = 1× avgDataFrameMs → settles in ~1 frame interval
        //   HEAVY (Smooth ON):  tcFall = 4× avgDataFrameMs → averages over ~4 frames
        // Rise is derived as fallAlpha * 4 (capped 0.95) — VibeSDR signalProcessor.ts:273.
        const frameIntervalSec = Math.min(1.0, Math.max(0.05, this.avgDataFrameMs / 1000));
        const mul    = this.smoothingEnabled ? this.EMA_TC_HEAVY_MULTIPLIER : this.EMA_TC_LIGHT_MULTIPLIER;
        const tcFall = frameIntervalSec * mul;
        const alphaFall = Math.min(0.95, 1.0 - Math.exp(-dtSec / tcFall));
        const alphaRise = Math.min(0.95, alphaFall * 4); // 4× faster attack, same cap

        // Per-bin asymmetric EMA: fast attack (signal rising), slow decay (signal falling)
        const smoothedData = new Float32Array(this.spectrumData.length);
        for (let i = 0; i < this.spectrumData.length; i++) {
            const target = this.spectrumData[i];
            const alpha  = target > this.specEma[i] ? alphaRise : alphaFall;
            this.specEma[i] += alpha * (target - this.specEma[i]);
            smoothedData[i] = this.specEma[i];
        }

        // Determine min/max based on manual or auto mode
        let minDb, maxDb;

        if (this.config.manualRangeEnabled) {
            // Use manual range values
            minDb = this.config.manualMinDb;
            maxDb = this.config.manualMaxDb;
        } else {
            // Use 10th percentile as noise floor (good balance: ignores quiet outlier bins while
            // still sitting close to the actual noise floor in typical HF spectrum)
            // Use absolute maximum for ceiling to ensure strong signals are always captured
            const values = [];
            let currentMaxDb = -Infinity;
            for (let i = 0; i < smoothedData.length; i++) {
                const db = smoothedData[i];
                if (isFinite(db)) {
                    values.push(db);
                    if (db > currentMaxDb) currentMaxDb = db;
                }
            }
            values.sort((a, b) => a - b);

            const floorIndex = Math.floor(values.length * 0.10);
            const currentMinDb = values.length > 0 ? values[floorIndex] : -120;
            if (!isFinite(currentMaxDb)) currentMaxDb = -40;

            // Track minimum values over time for stable noise floor
            this.lineGraphMinHistory.push({ value: currentMinDb, timestamp: now });

            // Remove values older than 2 seconds
            this.lineGraphMinHistory = this.lineGraphMinHistory.filter(m => now - m.timestamp <= this.lineGraphMinHistoryMaxAge);

            // Use the average of recent minimums as the noise floor for smoother display
            const avgMinDb = this.lineGraphMinHistory.reduce((sum, m) => sum + m.value, 0) / this.lineGraphMinHistory.length;

            // Track maximum values over time for stable ceiling
            this.lineGraphMaxHistory.push({ value: currentMaxDb, timestamp: now });

            // Remove values older than 2 seconds
            this.lineGraphMaxHistory = this.lineGraphMaxHistory.filter(m => now - m.timestamp <= this.lineGraphMaxHistoryMaxAge);

            // Use the average of recent maximums as the ceiling for smoother display
            const avgMaxDb = this.lineGraphMaxHistory.reduce((sum, m) => sum + m.value, 0) / this.lineGraphMaxHistory.length;

            // Use smoothed minimum as floor, smoothed maximum as ceiling.
            // The spectrum line graph auto-ranges independently from the waterfall.
            // Enforce minimum dynamic range before the contrast offset so the final
            // displayed span equals autoMinSpan (same logic as updateAutoRange).
            let rawMin = avgMinDb;
            let rawMax = avgMaxDb;
            if (this.config.autoMinSpan !== null) {
                const rawSpan = rawMax - rawMin;
                if (rawSpan < this.config.autoMinSpan) {
                    const deficit = this.config.autoMinSpan - rawSpan;
                    const newMax = Math.round(rawMax + deficit * 0.75);
                    const newMin = Math.round(rawMin - deficit * 0.25);
                    const hysteresis = 3;
                    if (this._lgClampedMinDb === null ||
                        Math.abs(newMin - this._lgClampedMinDb) > hysteresis ||
                        Math.abs(newMax - this._lgClampedMaxDb) > hysteresis) {
                        this._lgClampedMinDb = newMin;
                        this._lgClampedMaxDb = newMax;
                    }
                    rawMin = this._lgClampedMinDb;
                    rawMax = this._lgClampedMaxDb;
                } else {
                    this._lgClampedMinDb = null;
                    this._lgClampedMaxDb = null;
                }
            }
            minDb = rawMin;
            maxDb = rawMax;
        }
        const dbRange = maxDb - minDb;
        if (dbRange === 0 || !isFinite(dbRange)) return;

        // Create vertical gradient using the same color scheme as waterfall
        const gradient = this.createLineGraphGradient(ctx, graphHeight);

        // Draw filled area with graduated colors
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(0, graphHeight); // Start at bottom left

        for (let x = 0; x < graphWidth; x++) {
            // Map pixel x to exact bin position (floating point)
            const binPos = (x / graphWidth) * smoothedData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

            // Get dB value with linear interpolation between adjacent bins (using smoothed data)
            let db;
            if (binIndex >= 0 && binIndex < smoothedData.length - 1) {
                const db1 = smoothedData[binIndex];
                const db2 = smoothedData[binIndex + 1];
                db = db1 + (db2 - db1) * binFrac;
            } else if (binIndex === smoothedData.length - 1) {
                db = smoothedData[binIndex];
            } else {
                db = minDb;
            }

            // Calculate y position using actual data range (inverted - higher dB at top)
            // Draw in the area below the frequency scale (from graphTopMargin to graphHeight)
            // Apply gamma curve: gamma > 1 compresses low values (noise floor) toward the
            // bottom and expands the mid-range (weak signals), making them more visible.
            // contrast=0 → gamma≈0.5 (near-linear), contrast=15 → gamma≈1.4 (default,
            // decent noise compression), contrast=30 → gamma≈4.0 (strong compression).
            // The dB axis labels are placed at the same gamma-corrected positions so they
            // remain accurate — the scale is non-linear but always correct.
            const linearNorm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            const gamma = Math.pow(2, (this.config.autoContrast - 10) / 15);
            const normalized = Math.pow(linearNorm, gamma);
            const y = graphHeight - (normalized * graphDrawHeight);

            ctx.lineTo(x, y);
        }

        // Close the path at bottom right
        ctx.lineTo(graphWidth, graphHeight);
        ctx.closePath();
        ctx.fill();

        // Update and draw peak hold line
        this.updatePeakHold(smoothedData, minDb, maxDb);
        this.drawPeakHold(ctx, graphWidth, graphHeight, graphDrawHeight, graphTopMargin, minDb, maxDb);

        // Frequency scale is now drawn in overlay (always visible)

        // Draw dBFS scale on left side
        this.drawLineGraphDbScale(minDb, maxDb, graphDrawHeight, graphTopMargin);

        // Draw thin grey separator line at bottom of spectrum (before waterfall)
        ctx.strokeStyle = '#808080'; // Grey color
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, graphHeight - 1); // Bottom of line graph canvas (y=299)
        ctx.lineTo(graphWidth, graphHeight - 1);
        ctx.stroke();

        // Station ID overlay — top-right corner of the drawing area
        if (this.stationIdOverlay) {
            this.drawStationIdOverlay(ctx, graphWidth, graphTopMargin);
        }
    }

    /**
     * Draw the station ID overlay in the top-right corner of the spectrum line graph.
     * Line 1 (bold 13px): "<callsign> - <name>"  or just callsign or just name
     * Line 2 (11px, 75% opacity): location
     * Line 3 (11px, 75% opacity): local weather (only when /api/weather data is available)
     * Line 4 (11px, 75% opacity): active antenna name (only when ant_switch enabled)
     * Text colour comes from this.stationIdColor (set by loadStationIdConfig()).
     * A 1 px black drop-shadow is always added for legibility over any background.
     * Data comes from window.instanceDescription.receiver (populated by fetchSiteDescription()).
     * Active antenna name comes from window.activeAntennaLabel (polled every 30 s by app.js).
     */
    drawStationIdOverlay(ctx, graphWidth, graphTopMargin) {
        const receiver = window.instanceDescription?.receiver;
        if (!receiver) return;

        const callsign  = (receiver.callsign || '').trim();
        const name      = (receiver.name     || '').trim();
        const location  = (receiver.location || '').trim();
        const antLabel  = (window.activeAntennaLabel || '').trim();

        // Append UTC offset to location line if timezone_offset is configured
        // e.g. "London (UTC +1h)" or "Mumbai (UTC +5h30m)"
        const tzOffset = receiver.timezone_offset;
        let tzSuffix = '';
        if (typeof tzOffset === 'number') {
            const sign = tzOffset >= 0 ? '+' : '-';
            const abs  = Math.abs(tzOffset);
            const h    = Math.floor(abs / 60);
            const m    = abs % 60;
            tzSuffix   = m > 0 ? ` (UTC ${sign}${h}h${m}m)` : ` (UTC ${sign}${h}h)`;
        }
        const locationLine = location ? location + tzSuffix : tzSuffix.trim();

        // Nothing to show if both callsign and name are absent
        if (!callsign && !name) return;

        const line1  = (callsign && name) ? `${callsign} - ${name}` : (callsign || name);
        const rightX = graphWidth - 6;
        const topY   = graphTopMargin + 6;
        const col    = this.stationIdColor;

        ctx.save();
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'top';

        // Line 1: bold 13px — callsign - name
        this._setFont(ctx, 'bold 13px sans-serif');
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(line1, rightX + 1, topY + 1);   // 1 px drop-shadow
        ctx.fillStyle = col;
        ctx.fillText(line1, rightX, topY);

        // Track Y position for subsequent optional lines (each is 16px apart)
        let nextY = topY + 16;

        // Line 2: 11px — location (+ UTC offset) at 75% opacity
        if (locationLine) {
            this._setFont(ctx, '11px sans-serif');
            ctx.fillStyle   = 'rgba(0,0,0,0.55)';
            ctx.fillText(locationLine, rightX + 1, nextY + 1);
            ctx.globalAlpha = 0.75;
            ctx.fillStyle   = col;
            ctx.fillText(locationLine, rightX, nextY);
            ctx.globalAlpha = 1.0;
            nextY += 16;
        }

        // Line 3: 11px — local weather at 75% opacity (only when /api/weather data is available)
        if (this._weatherLine) {
            this._setFont(ctx, '11px sans-serif');
            ctx.fillStyle   = 'rgba(0,0,0,0.55)';
            ctx.fillText(this._weatherLine, rightX + 1, nextY + 1);
            ctx.globalAlpha = 0.75;
            ctx.fillStyle   = col;
            ctx.fillText(this._weatherLine, rightX, nextY);
            ctx.globalAlpha = 1.0;
            nextY += 16;
        }

        // Line 4: 11px — active antenna name at 75% opacity (ant_switch enabled only)
        if (antLabel) {
            this._setFont(ctx, '11px sans-serif');
            ctx.fillStyle   = 'rgba(0,0,0,0.55)';
            ctx.fillText(antLabel, rightX + 1, nextY + 1);
            ctx.globalAlpha = 0.75;
            ctx.fillStyle   = col;
            ctx.fillText(antLabel, rightX, nextY);
            ctx.globalAlpha = 1.0;
        }

        ctx.restore();
    }


    // Draw dBFS scale on left side of line graph
    drawLineGraphDbScale(minDb, maxDb, graphDrawHeight, graphTopMargin) {
        if (!this.lineGraphCtx) return;

        const ctx = this.lineGraphCtx;
        const dbRange = maxDb - minDb;
        if (dbRange === 0 || !isFinite(dbRange)) return;

        // Calculate appropriate dB step (aim for 5-8 major ticks)
        const targetStep = dbRange / 6;
        let dbStep;
        if (targetStep >= 20) dbStep = 20;
        else if (targetStep >= 10) dbStep = 10;
        else if (targetStep >= 5) dbStep = 5;
        else if (targetStep >= 2) dbStep = 2;
        else dbStep = 1;

        // Draw major ticks with labels
        this._setFont(ctx, 'bold 11px monospace');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;

        // Use the same gamma as drawLineGraph() so labels sit at the correct pixel positions
        const gamma = Math.pow(2, (this.config.autoContrast - 10) / 15);

        // Use a small inset (20% of dbStep) so ticks only appear/disappear when the
        // boundary has moved well past a grid line — prevents flickering on slow drift.
        const tickMargin = dbStep * 0.2;
        const firstDb = Math.ceil((minDb + tickMargin) / dbStep) * dbStep;
        const lastDb  = Math.floor((maxDb - tickMargin) / dbStep) * dbStep;
        for (let db = firstDb; db <= lastDb; db += dbStep) {
            // Calculate y position with gamma correction — matches where signals are drawn
            const linearNorm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            const y = graphTopMargin + graphDrawHeight - Math.pow(linearNorm, gamma) * graphDrawHeight;

            // Draw major tick (8 pixels long)
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(8, y);
            ctx.stroke();

            // Draw label with background for better visibility
            const label = `${db.toFixed(0)}`;
            const textWidth = ctx.measureText(label).width;

            // Semi-transparent background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(10, y - 7, textWidth + 4, 14);

            // White text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, 12 + textWidth, y);
        }

        // Draw minor ticks (at 1/5 of major step)
        const minorStep = dbStep / 5;
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        const firstMinor = Math.ceil(minDb / minorStep) * minorStep;
        for (let db = firstMinor; db <= maxDb; db += minorStep) {
            // Skip major ticks
            if (Math.abs(db % dbStep) < 0.01) continue;

            // Calculate y position with gamma correction — matches where signals are drawn
            const linearNorm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            const y = graphTopMargin + graphDrawHeight - Math.pow(linearNorm, gamma) * graphDrawHeight;

            // Draw minor tick (4 pixels long)
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(4, y);
            ctx.stroke();
        }
    }

    // Create vertical gradient for line graph using waterfall color scheme
    createLineGraphGradient(ctx, graphHeight) {
        const gradient = ctx.createLinearGradient(0, graphHeight, 0, 0);

        // Get the color scheme colors
        const colors = this.getColorScheme(this.config.colorScheme);

        // Create gradient stops based on the color scheme
        // Map colors from bottom (weak signal) to top (strong signal)
        for (let i = 0; i < colors.length; i++) {
            const position = i / (colors.length - 1);
            const color = colors[i];
            gradient.addColorStop(position, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.8)`);
        }

        return gradient;
    }

    // Update peak hold data with current spectrum and apply decay
    updatePeakHold(currentData, minDb, maxDb) {
        const now = Date.now();
        const timeDelta = (now - this.lastPeakHoldUpdate) / 1000; // seconds
        this.lastPeakHoldUpdate = now;

        // Initialize peak hold array if needed
        if (!this.peakHoldData || this.peakHoldData.length !== currentData.length) {
            this.peakHoldData = new Float32Array(currentData.length);
            for (let i = 0; i < currentData.length; i++) {
                this.peakHoldData[i] = currentData[i];
            }
            return;
        }

        // Check for NaN values in peak hold data - if found, reinitialize
        let hasNaN = false;
        for (let i = 0; i < this.peakHoldData.length; i++) {
            if (!isFinite(this.peakHoldData[i])) {
                hasNaN = true;
                break;
            }
        }
        
        if (hasNaN) {
            console.log('Peak hold contains NaN values, reinitializing');
            this.peakHoldData = new Float32Array(currentData.length);
            for (let i = 0; i < currentData.length; i++) {
                this.peakHoldData[i] = currentData[i];
            }
            return;
        }

        // Update peak hold: take max of current and decayed previous peak
        const decay = this.peakHoldDecayRate * timeDelta;
        for (let i = 0; i < currentData.length; i++) {
            // Decay previous peak
            const decayedPeak = this.peakHoldData[i] - decay;
            // Take maximum of current value and decayed peak
            this.peakHoldData[i] = Math.max(currentData[i], decayedPeak);
            // Clamp to valid range
            this.peakHoldData[i] = Math.max(minDb, Math.min(maxDb, this.peakHoldData[i]));
        }
    }

    // Draw peak hold line on line graph
    drawPeakHold(ctx, graphWidth, graphHeight, graphDrawHeight, graphTopMargin, minDb, maxDb) {
        // Skip if peak hold is disabled
        if (!this.peakHoldEnabled || !this.peakHoldData) return;

        const dbRange = maxDb - minDb;
        if (dbRange === 0 || !isFinite(dbRange)) return;

        // Verify peak hold data matches current spectrum length
        if (this.peakHoldData.length !== this.spectrumData.length) {
            console.log(`Peak hold length mismatch: ${this.peakHoldData.length} vs ${this.spectrumData.length}, clearing`);
            this.peakHoldData = null;
            return;
        }

        // Draw peak hold line in light yellow color as solid line
        ctx.strokeStyle = 'rgba(255, 255, 200, 0.5)'; // Light yellow, semi-transparent
        ctx.lineWidth = 1;
        ctx.beginPath();

        let firstPoint = true;
        let pointsDrawn = 0;
        for (let x = 0; x < graphWidth; x++) {
            // Map pixel x to exact bin position
            const binPos = (x / graphWidth) * this.peakHoldData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

            // Get dB value with linear interpolation
            let db;
            if (binIndex >= 0 && binIndex < this.peakHoldData.length - 1) {
                const db1 = this.peakHoldData[binIndex];
                const db2 = this.peakHoldData[binIndex + 1];
                db = db1 + (db2 - db1) * binFrac;
            } else if (binIndex === this.peakHoldData.length - 1) {
                db = this.peakHoldData[binIndex];
            } else {
                continue;
            }

            // Skip if dB value is invalid
            if (!isFinite(db)) {
                continue;
            }

            // Calculate y position - use graphTopMargin + graphDrawHeight as base, subtract normalized height
            // Apply the same gamma as drawLineGraph() so peak hold stays aligned with the filled area
            const linearNorm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            const gamma = Math.pow(2, (this.config.autoContrast - 10) / 15);
            const normalized = Math.pow(linearNorm, gamma);
            const y = graphTopMargin + graphDrawHeight - (normalized * graphDrawHeight);

            if (firstPoint) {
                ctx.moveTo(x, y);
                firstPoint = false;
            } else {
                ctx.lineTo(x, y);
            }
            pointsDrawn++;
        }


        ctx.stroke();
    }

    // Draw frequency scale for line graph

    // Setup mouse handlers for line graph canvas
    setupLineGraphMouseHandlers() {
        if (!this.lineGraphCanvas) return;

        // Track dragging state for line graph
        let lineGraphDragging = false;
        let lineGraphDragDidMove = false;
        let lineGraphDragStartX = 0;
        let lineGraphDragStartFreq = 0;

        // Track mouse position for line graph
        let lineGraphMouseX = -1;
        let lineGraphMouseY = -1;

        // Track mouse position for tooltip and dragging
        this.lineGraphCanvas.addEventListener('mousemove', (e) => {
            const rect = this.lineGraphCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Store mouse position for automatic tooltip updates
            lineGraphMouseX = x;
            lineGraphMouseY = y;

            // Handle dragging
            if (lineGraphDragging) {
                // Only process if mouse actually moved
                if (x === this.lastDragX && y === this.lastDragY) {
                    return; // No actual movement, ignore this event
                }
                this.lastDragX = x;
                this.lastDragY = y;

                const deltaX = x - lineGraphDragStartX;

                // Mark that we've moved if delta is significant
                if (Math.abs(deltaX) > 5) {
                    lineGraphDragDidMove = true;
                }

                // Calculate frequency change based on pixel movement
                const freqPerPixel = this.totalBandwidth / this.width;
                const freqDelta = -deltaX * freqPerPixel;
                let newCenterFreq = lineGraphDragStartFreq + freqDelta;

                // Apply boundary constraints (0-30 MHz)
                const halfBandwidth = this.totalBandwidth / 2;
                const minCenterFreq = 0 + halfBandwidth;
                const maxCenterFreq = 30e6 - halfBandwidth;

                // Clamp to boundaries
                newCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

                // CLIENT-SIDE PREDICTION: Update visual offset immediately for smooth dragging.
                // No synchronous draw() here — the 30fps rAF loop in startFrameProcessing()
                // picks the new offset up on its next tick. Drawing per mousemove event
                // stacked full redraws on top of the rAF loop and fed a jank spiral in
                // Firefox (slow frame → queued events → more draws → slower frames).
                this.predictedFreqOffset = newCenterFreq - this.lastServerCenterFreq;

                // Throttle pan requests
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (lineGraphDragDidMove && timeSinceLastPan >= this.panThrottleMs) {
                    this.panTo(newCenterFreq);
                    this.lastPanTime = now;
                    // Don't update lineGraphDragStartX/lineGraphDragStartFreq here - keep original drag start point
                }

                // Don't show tooltip while dragging
                this.hideTooltip();
            } else {
                // Update tooltip with frequency and dB value when not dragging
                this.updateLineGraphTooltip(x, y);
            }
        });

        this.lineGraphCanvas.addEventListener('mouseleave', () => {
            lineGraphDragging = false;
            this._lineGraphDragActive = false;
            lineGraphMouseX = -1;
            lineGraphMouseY = -1;
            this.hideTooltip();
            this.updateLineGraphCursorStyle();
        });

        // Store mouse position tracking for automatic updates
        this.lineGraphMouseX = () => lineGraphMouseX;
        this.lineGraphMouseY = () => lineGraphMouseY;

        // Mouse down - start dragging
        this.lineGraphCanvas.addEventListener('mousedown', (e) => {
            if (!this.spectrumData) return;

            // Check if we're showing full bandwidth (0-30 MHz)
            const startFreq = this.centerFreq - this.totalBandwidth / 2;
            const endFreq = this.centerFreq + this.totalBandwidth / 2;
            const isFullBandwidth = (startFreq <= 0 && endFreq >= 30e6);

            if (isFullBandwidth) {
                // Don't start dragging if showing full bandwidth
                return;
            }

            const rect = this.lineGraphCanvas.getBoundingClientRect();
            lineGraphDragStartX = e.clientX - rect.left;
            lineGraphDragStartFreq = this.centerFreq;
            this.lastServerCenterFreq = this.centerFreq; // Track starting server position
            this.predictedFreqOffset = 0; // Reset prediction offset
            lineGraphDragging = true;
            this._lineGraphDragActive = true;
            lineGraphDragDidMove = false;
            this.lastDragX = lineGraphDragStartX; // Initialize drag position tracking
            this.lastDragY = e.clientY - rect.top;
            this.lineGraphCanvas.style.cursor = 'default';

            // Prevent text selection while dragging
            e.preventDefault();
        });

        // Mouse up - stop dragging or handle click
        this.lineGraphCanvas.addEventListener('mouseup', (e) => {
            if (!this.spectrumData) return;

            // Ignore right-clicks (button 2) - they're handled by contextmenu event
            if (e.button === 2) {
                lineGraphDragging = false;
                this._lineGraphDragActive = false;
                lineGraphDragDidMove = false;
                return;
            }

            const rect = this.lineGraphCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;

            // If we didn't drag, treat it as a click to tune
            if (!lineGraphDragDidMove && this.config.onFrequencyClick && x >= 0 && x < this.width) {
                // Calculate frequency from click position
                const startFreq = this.centerFreq - this.totalBandwidth / 2;
                let freq = startFreq + (x / this.width) * this.totalBandwidth;

                // Apply snap if enabled and in USB/LSB mode (uses frequency scroll step value)
                if (this.snapEnabled) {
                    const currentMode = window.currentMode ? window.currentMode.toLowerCase() : '';
                    // Get snap step from frequency scroll dropdown (extract number from value like "500-fast")
                    const snapStep = window.frequencyScrollStep || 1000; // Default to 1 kHz if not set
                    if (currentMode === 'lsb') {
                        // LSB: add 200 Hz offset, then round to nearest step
                        const adjustedFreq = freq + 200;
                        freq = Math.round(adjustedFreq / snapStep) * snapStep;
                    } else if (currentMode === 'usb') {
                        // USB: subtract 200 Hz offset, then round to nearest step
                        const adjustedFreq = freq - 200;
                        freq = Math.round(adjustedFreq / snapStep) * snapStep;
                    }
                }

                // Set flag to skip auto-pan since this frequency change is from clicking
                this.skipNextPan = true;

                this.config.onFrequencyClick(freq);
            }

            lineGraphDragging = false;
            this._lineGraphDragActive = false;
            lineGraphDragDidMove = false;
            this.predictedFreqOffset = 0; // Clear prediction offset when drag ends
            this.updateLineGraphCursorStyle();

            // Redraw to clear any prediction artifacts
            if (this.spectrumData && this.spectrumData.length > 0) {
                this.draw();
            }
        });

        // Add context menu handler for line graph (right-click)
        this.lineGraphCanvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // Prevent default browser context menu
            this.handleContextMenu(e);
        });

        // Set initial cursor style
        this.updateLineGraphCursorStyle();
    }

    // Update line graph tooltip content and position
    updateLineGraphTooltip(x, y) {
        if (!this.spectrumData || !this.lineGraphCanvas) {
            this.hideTooltip();
            return;
        }

        if (x < 0 || x >= this.width) {
            this.hideTooltip();
            return;
        }

        const binIndex = Math.floor((x / this.width) * this.spectrumData.length);
        if (binIndex >= 0 && binIndex < this.spectrumData.length) {
            const db = this.spectrumData[binIndex];
            const startFreq = this.centerFreq - this.totalBandwidth / 2;
            const freq = startFreq + (x / this.width) * this.totalBandwidth;

            // Find strongest signal in spectrum
            let maxDb = -Infinity;
            let maxBinIndex = 0;
            for (let i = 0; i < this.spectrumData.length; i++) {
                if (this.spectrumData[i] > maxDb) {
                    maxDb = this.spectrumData[i];
                    maxBinIndex = i;
                }
            }

            // Calculate frequency of strongest signal
            const maxFreq = startFreq + (maxBinIndex / this.spectrumData.length) * this.totalBandwidth;

            // Update tooltip content with cursor position and strongest signal (use innerHTML for line breaks)
            this.tooltip.innerHTML = `Cursor: ${this.formatFrequency(freq)} | ${db.toFixed(1)} dB<br>Peak: ${this.formatFrequency(maxFreq)} | ${maxDb.toFixed(1)} dB`;

            // Position tooltip near cursor (flips left near the right edge)
            const rect = this.lineGraphCanvas.getBoundingClientRect();
            this.tooltip.style.display = 'block';
            this._positionTooltipNearCursor(rect.left + x, rect.top + y);
        }
    }

    // Update cursor style for line graph based on zoom level
    updateLineGraphCursorStyle() {
        if (!this.lineGraphCanvas || !this.totalBandwidth) return;

        // Check if we're showing full bandwidth (0-30 MHz)
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;
        const isFullBandwidth = (startFreq <= 0 && endFreq >= 30e6);

        // Set cursor based on whether dragging is allowed
        this.lineGraphCanvas.style.cursor = 'default';
    }

    // Draw frequency scale at top of waterfall
    drawFrequencyScale() {
        if (!this.totalBandwidth) return;

        // Apply client-side prediction offset during dragging
        const effectiveCenterFreq = this.centerFreq + this.predictedFreqOffset;
        const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
        const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

        // Clear the frequency scale area completely (solid black, not transparent)
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, 30);

        // Draw semi-transparent overlay for better text contrast
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, 0, this.width, 30);

        // Calculate appropriate frequency step based on available width
        // On narrow screens (mobile), show fewer markers to prevent overlap
        const minLabelSpacing = 80; // Minimum pixels between labels
        const calculatedMarkers = Math.floor(this.width / minLabelSpacing);
        const maxMarkers = Math.min(10, Math.max(3, calculatedMarkers)); // Cap at 10, minimum 3
        const targetStep = this.totalBandwidth / maxMarkers;

        let freqStep;
        if (targetStep >= 5e6) {
            freqStep = 5e6; // 5 MHz
        } else if (targetStep >= 2e6) {
            freqStep = 2e6; // 2 MHz
        } else if (targetStep >= 1e6) {
            freqStep = 1e6; // 1 MHz
        } else if (targetStep >= 500e3) {
            freqStep = 500e3; // 500 kHz
        } else if (targetStep >= 200e3) {
            freqStep = 200e3; // 200 kHz
        } else if (targetStep >= 100e3) {
            freqStep = 100e3; // 100 kHz (frequency scale marker step)
        } else if (targetStep >= 50e3) {
            freqStep = 50e3; // 50 kHz
        } else if (targetStep >= 20e3) {
            freqStep = 20e3; // 20 kHz
        } else if (targetStep >= 10e3) {
            freqStep = 10e3; // 10 kHz
        } else if (targetStep >= 5e3) {
            freqStep = 5e3; // 5 kHz
        } else if (targetStep >= 2e3) {
            freqStep = 2e3; // 2 kHz
        } else if (targetStep >= 1e3) {
            freqStep = 1e3; // 1 kHz
        } else if (targetStep >= 500) {
            freqStep = 500; // 500 Hz
        } else if (targetStep >= 200) {
            freqStep = 200; // 200 Hz
        } else {
            freqStep = 100; // 100 Hz
        }

        this._setFont(this.ctx, 'bold 13px monospace');
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // Draw major ticks and labels
        const firstFreq = Math.ceil(startFreq / freqStep) * freqStep;
        for (let freq = firstFreq; freq <= endFreq; freq += freqStep) {
            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;

            // Draw major tick mark (solid white, no transparency)
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(x - 1, 0, 2, 12);

            // Draw label with strong contrast
            this.ctx.fillStyle = '#ffffff';
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 3;

            const label = this.formatFrequencyScale(freq);
            this.ctx.strokeText(label, x, 20);
            this.ctx.fillText(label, x, 20);
        }

        // Draw minor ticks (at 1/5 of major step) - smaller, unlabeled
        const minorStep = freqStep / 5;
        this.ctx.fillStyle = '#ffffff'; // Solid white, no transparency
        const firstMinor = Math.ceil(startFreq / minorStep) * minorStep;
        for (let freq = firstMinor; freq <= endFreq; freq += minorStep) {
            // Skip major ticks
            if (Math.abs(freq % freqStep) < 1) continue;

            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;
            // Draw medium-sized tick (8 pixels tall, 1.5 pixels wide)
            this.ctx.fillRect(x - 0.75, 0, 1.5, 8);
        }
    }

    // Update overlay div position to match canvas position.
    // The overlay is position:fixed (viewport-relative), but the canvas is in the
    // normal document flow, so its viewport-relative top changes on resize AND on
    // scroll.  Calling getBoundingClientRect() every animation frame (60 fps) forces
    // a synchronous layout reflow and was measured at ~344 ms per profiling window
    // (12.5 % of total CPU).  We cache the result in _overlayRectCache and only
    // recompute when the cache is explicitly invalidated (resize handler, scroll
    // handler, toggleLineGraphVisibility).
    updateOverlayPosition() {
        if (!this._overlayRectCache) {
            const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
            const sourceCanvas = lineGraphVisible ? this.lineGraphCanvas : this.canvas;
            this._overlayRectCache = sourceCanvas.getBoundingClientRect();
        }
        const r = this._overlayRectCache;
        // Guard each write — setting .style properties triggers Recalculate Style + Layout
        // even when the value is unchanged. At 30fps this was ~440ms per profiling window.
        // The overlay position only changes on resize/scroll; height never changes (set at init).
        const top   = r.top   + 'px';
        const left  = r.left  + 'px';
        const width = r.width + 'px';
        if (this.overlayDiv.style.top   !== top)   this.overlayDiv.style.top   = top;
        if (this.overlayDiv.style.left  !== left)  this.overlayDiv.style.left  = left;
        if (this.overlayDiv.style.width !== width) this.overlayDiv.style.width = width;
    }

    // Draw cursor showing currently tuned frequency and bandwidth on overlay canvas
    drawTunedFrequencyCursor() {
        // Update overlay position in case canvas moved
        this.updateOverlayPosition();

        // Apply client-side prediction offset during dragging
        const effectiveCenterFreq = this.centerFreq + this.predictedFreqOffset;

        // Check if spectrum view has changed (pan/zoom) - regenerate marker cache if needed
        // Include prediction offset in change detection
        const viewChanged = this.lastMarkerCenterFreq !== effectiveCenterFreq ||
                           this.lastMarkerTotalBandwidth !== this.totalBandwidth ||
                           this.lastMarkerDisplayMode !== this.displayMode;

        // Also rebuild if signal brackets changed (time-gated, ~2s interval)
        const bracketsChanged = window._signalBracketsChanged === true;
        if (bracketsChanged) {
            window._signalBracketsChanged = false;
            this.markerCache = null; // force rebuild
        }

        // During an active pan drag the effective center changes every frame, which
        // would rebuild the marker cache — rasterizing every bookmark/spot label —
        // at the full frame rate. That rebuild is the dominant per-frame cost while
        // panning (canvas text is slow, especially in Firefox) and scales with the
        // number of visible markers. Instead, throttle rebuilds to 4/sec while
        // dragging and blit the existing cache with a pixel shift between rebuilds.
        // Markers scrolling in from the edges appear on the next throttled rebuild.
        const panDragActive = this.isDragging || this._lineGraphDragActive;
        let dragBlitShiftPx = null;
        if (viewChanged && panDragActive && this.markerCache &&
            this.lastMarkerCenterFreq !== null &&
            this.lastMarkerTotalBandwidth === this.totalBandwidth &&
            this.lastMarkerDisplayMode === this.displayMode &&
            (performance.now() - this._lastMarkerCacheBuildTime) < 250) {
            dragBlitShiftPx = ((effectiveCenterFreq - this.lastMarkerCenterFreq) / this.totalBandwidth)
                              * this.overlayCanvas.width;
        }

        // Create or update offscreen canvas for marker caching if view changed
        if (dragBlitShiftPx === null && (viewChanged || !this.markerCache)) {
            // Create offscreen canvas for caching markers (bookmarks + DX spots)
            if (!this.markerCache) {
                this.markerCache = document.createElement('canvas');
                this.markerCacheCtx = this.markerCache.getContext('2d', { alpha: true });
            }

            // Ensure cache canvas matches overlay size
            if (this.markerCache.width !== this.overlayCanvas.width ||
                this.markerCache.height !== this.overlayCanvas.height) {
                this.markerCache.width = this.overlayCanvas.width;
                this.markerCache.height = this.overlayCanvas.height;
            }

            // Clear marker cache
            this.markerCacheCtx.clearRect(0, 0, this.markerCache.width, this.markerCache.height);

            // Fill with grey background in waterfall mode
            if (this.displayMode === 'waterfall') {
                this.markerCacheCtx.fillStyle = '#adb5bd';
                this.markerCacheCtx.fillRect(0, 0, this.markerCache.width, this.markerCache.height);
            }

            // Temporarily swap context to draw markers to cache
            const originalCtx = this.overlayCtx;
            this.overlayCtx = this.markerCacheCtx;

            // Draw frequency scale FIRST (includes grey background for bookmarks)
            this.drawFrequencyScaleOnOverlay(this.markerCacheCtx);

            // Draw amateur band backgrounds and labels (band names like "160m", "80m")
            if (typeof window.drawAmateurBandBackgrounds === 'function') {
                window.drawAmateurBandBackgrounds(this);
            }

            // Draw chat user markers AFTER band labels but BEFORE bookmark markers
            this.drawChatUserMarkers();

            // Draw strong signal brackets (top-5 signals above noise floor)
            // Drawn before bookmarks so bookmark labels render on top
            if (typeof window.drawStrongSignalBrackets === 'function') {
                window.drawStrongSignalBrackets(this);
            }

            // Draw bookmark markers (but skip band backgrounds since we already drew them)
            if (typeof window.drawBookmarksOnSpectrum === 'function') {
                window.drawBookmarksOnSpectrum(this, console.log);
            }

            // Draw DX spots to cache
            if (typeof window.drawDXSpotsOnSpectrum === 'function') {
                window.drawDXSpotsOnSpectrum(this, console.log);
            }

            // Draw CW spots to cache
            if (typeof window.drawCWSpotsOnSpectrum === 'function') {
                window.drawCWSpotsOnSpectrum(this, console.log);
            }

            // Draw voice activity markers to cache
            if (typeof window.drawVoiceActivityOnSpectrum === 'function') {
                window.drawVoiceActivityOnSpectrum(this, console.log);
            }

            // Restore original context
            this.overlayCtx = originalCtx;

            // Update tracking variables (use effective center freq with prediction)
            this.lastMarkerCenterFreq = effectiveCenterFreq;
            this.lastMarkerTotalBandwidth = this.totalBandwidth;
            this.lastMarkerDisplayMode = this.displayMode;
            this._lastMarkerCacheBuildTime = performance.now();

            // Cursor content depends on view (x-position changes with pan/zoom), so
            // invalidate the cursor cache whenever the marker cache is rebuilt.
            this.cursorCache = null;
        }

        // Clear overlay canvas
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // Draw cached markers (fast - just a bitmap copy)
        if (this.markerCache) {
            if (dragBlitShiftPx !== null) {
                // Pan in progress: blit the cache shifted by the panned distance and
                // fill the exposed edge strip with the bar backgrounds (grey bookmark
                // strip 0-45px, translucent black frequency scale 45-75px) so no
                // transparent gap shows through until the next throttled rebuild.
                const dx = -dragBlitShiftPx;
                this.overlayCtx.drawImage(this.markerCache, dx, 0);
                const gapW = Math.min(Math.abs(dx), this.overlayCanvas.width);
                if (gapW >= 1) {
                    const gapX = dx > 0 ? 0 : this.overlayCanvas.width - gapW;
                    this.overlayCtx.fillStyle = '#adb5bd';
                    this.overlayCtx.fillRect(gapX, 0, gapW, 45);
                    this.overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                    this.overlayCtx.fillRect(gapX, 45, gapW, 30);
                }
            } else {
                this.overlayCtx.drawImage(this.markerCache, 0, 0);
            }
        }

        // Draw tuned frequency cursor on top.
        // The cursor only changes when the tuned frequency, bandwidth edges, or the
        // effective center frequency (drag prediction) changes.  Cache it to an
        // offscreen canvas so that on steady-state frames we do a single drawImage
        // instead of re-running all the canvas draw calls.
        if (this.currentTunedFreq && this.totalBandwidth) {
            const bandwidthChanged =
                this.lastCursorBandwidthLow  !== this.currentBandwidthLow ||
                this.lastCursorBandwidthHigh !== this.currentBandwidthHigh;

            // When bandwidth changes, immediately re-evaluate signal brackets with
            // the new BW filter rather than waiting for the 2-second timer.
            if (bandwidthChanged && typeof window.resetSignalBracketTimer === 'function') {
                window.resetSignalBracketTimer();
            }

            const cursorChanged =
                !this.cursorCache ||
                this.lastCursorTunedFreq      !== this.currentTunedFreq      ||
                bandwidthChanged                                              ||
                this.lastCursorCenterFreq     !== effectiveCenterFreq        ||
                this.lastCursorTotalBandwidth !== this.totalBandwidth;

            if (cursorChanged) {
                // Lazily create / resize the cursor cache canvas
                if (!this.cursorCache) {
                    this.cursorCache = document.createElement('canvas');
                    this.cursorCacheCtx = this.cursorCache.getContext('2d', { alpha: true });
                }
                if (this.cursorCache.width  !== this.overlayCanvas.width ||
                    this.cursorCache.height !== this.overlayCanvas.height) {
                    this.cursorCache.width  = this.overlayCanvas.width;
                    this.cursorCache.height = this.overlayCanvas.height;
                }
                this.cursorCacheCtx.clearRect(0, 0, this.cursorCache.width, this.cursorCache.height);

                // Render cursor into the offscreen cache
                const savedCtx = this.overlayCtx;
                this.overlayCtx = this.cursorCacheCtx;
                this.drawTunedFrequencyCursorOnly();
                this.overlayCtx = savedCtx;

                // Record what we cached
                this.lastCursorTunedFreq      = this.currentTunedFreq;
                this.lastCursorBandwidthLow   = this.currentBandwidthLow;
                this.lastCursorBandwidthHigh  = this.currentBandwidthHigh;
                this.lastCursorCenterFreq     = effectiveCenterFreq;
                this.lastCursorTotalBandwidth = this.totalBandwidth;
            }

            // Blit cursor cache onto overlay (always cheap)
            if (this.cursorCache) {
                this.overlayCtx.drawImage(this.cursorCache, 0, 0);
            }
        }
    }

    // Draw only the tuned frequency cursor (without bookmarks/DX spots)
    drawTunedFrequencyCursorOnly() {
        if (!this.currentTunedFreq || !this.totalBandwidth) return;

        // CRITICAL FIX: Use server frequency directly for cursor position
        // Only apply prediction offset during active dragging to prevent desync
        const effectiveCenterFreq = this.isDragging ?
            this.centerFreq + this.predictedFreqOffset :
            this.centerFreq;

        // Calculate frequency range from server data
        const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
        const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

        // Check if tuned frequency has scrolled off-screen
        if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) {
            // When marker scrolls off edge, update audio frequency to follow the spectrum edge
            // Calculate which edge the marker would be at
            let newFreq;
            const edgeMargin = this.totalBandwidth * 0.1; // 10% from edge

            if (this.currentTunedFreq < startFreq) {
                // Scrolled off left edge - tune to left edge position
                newFreq = startFreq + edgeMargin;
            } else {
                // Scrolled off right edge - tune to right edge position
                newFreq = endFreq - edgeMargin;
            }

            // Update the frequency via the callback
            // CRITICAL: Check if frequency input has focus before updating
            const freqInput = document.getElementById('frequency');
            const hasInputFocus = freqInput && document.activeElement === freqInput;
            
            // Debug logging for edge detection
            // if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) {
            //     console.log(`Edge detection check: edgeTuneEnabled=${this.edgeTuneEnabled}, skipEdgeDetectionTemporary=${this.skipEdgeDetectionTemporary}, isDragging=${this.isDragging}, hasInputFocus=${hasInputFocus}`);
            // }

            // Only perform edge detection if:
            // 1. Edge Tune is enabled by user preference
            // 2. Not temporarily disabled by manual frequency change
            // 3. Not currently dragging
            // 4. Frequency input doesn't have focus
            if (this.config.onFrequencyClick && this.edgeTuneEnabled && !this.skipEdgeDetectionTemporary && !this.isDragging && !hasInputFocus) {
                console.log(`Marker at edge - updating frequency to ${(newFreq/1e6).toFixed(3)} MHz`);
                this.skipNextPan = true; // Don't pan back when we update frequency
                this.config.onFrequencyClick(newFreq);
            }
            // Clear bandwidth lines when marker is off-screen
            this.bandwidthLinesCtx.clearRect(0, 0, this.bandwidthLinesCanvas.width, this.bandwidthLinesCanvas.height);
            return; // Don't draw marker if off-screen
        }

        // Calculate x position for center frequency
        const x = ((this.currentTunedFreq - startFreq) / (endFreq - startFreq)) * this.width;

        // Calculate x positions for bandwidth edges
        const lowFreq = this.currentTunedFreq + this.currentBandwidthLow;
        const highFreq = this.currentTunedFreq + this.currentBandwidthHigh;
        let xLow = ((lowFreq - startFreq) / (endFreq - startFreq)) * this.width;
        let xHigh = ((highFreq - startFreq) / (endFreq - startFreq)) * this.width;

        // For LSB mode (both bandwidth values negative), swap the positions
        // because the frequency scale is inverted
        if (this.currentBandwidthLow < 0 && this.currentBandwidthHigh < 0) {
            [xLow, xHigh] = [xHigh, xLow];
        }

        // Draw frequency label at top (without unit)
        const mhz = this.currentTunedFreq / 1e6;
        const freqLabel = mhz.toFixed(5);
        this._setFont(this.overlayCtx, 'bold 12px system-ui, -apple-system, sans-serif');
        this.overlayCtx.textAlign = 'center';
        this.overlayCtx.textBaseline = 'middle';

        // Background for label
        const labelWidth = this.overlayCtx.measureText(freqLabel).width + 6;
        const labelHeight = 14;
        const labelY = 1;

        this.overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.95)'; // Orange background
        this.overlayCtx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        this.overlayCtx.fillStyle = '#ffffff';
        this.overlayCtx.fillText(freqLabel, x, labelY + labelHeight / 2);

        // Draw longer downward arrow below label - extends to top of frequency scale (y=45)
        const arrowY = labelY + labelHeight;
        const arrowLength = 45 - arrowY; // Arrow extends to y=45 (top of frequency scale)
        this.overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.95)';
        this.overlayCtx.beginPath();
        this.overlayCtx.moveTo(x, arrowY + arrowLength); // Arrow tip at y=45
        this.overlayCtx.lineTo(x - 3, arrowY); // Left point
        this.overlayCtx.lineTo(x + 3, arrowY); // Right point
        this.overlayCtx.closePath();
        this.overlayCtx.fill();

        // Arrow border
        this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.stroke();

        // Draw bandwidth bracket — visible whenever the bandwidth region intersects the view.
        // Cases:
        //   lowVisible  && highVisible  → both ticks drawn normally
        //   lowVisible  && !highVisible → left tick drawn, right end clamped + arrow pointing right
        //   !lowVisible && highVisible  → right tick drawn, left end clamped + arrow pointing left
        //   !lowVisible && !highVisible && xLow<0 && xHigh>width → spans full view, arrows on both ends
        //   !lowVisible && !highVisible && both same side → bandwidth entirely off-screen, hide
        const lowVisible   = xLow  >= 0 && xLow  <= this.width;
        const highVisible  = xHigh >= 0 && xHigh <= this.width;
        const spansFullView = xLow < 0 && xHigh > this.width;
        const anyVisible   = lowVisible || highVisible || spansFullView;

        if (anyVisible) {
            const bracketY     = 45; // Position for bracket (at top of frequency scale section)
            const bracketHeight = 8;
            const arrowSize    = 6;  // Half-width of the arrowhead triangle

            // Clamp each edge to the canvas boundary for drawing purposes
            const drawXLow  = Math.max(0, Math.min(this.width, xLow));
            const drawXHigh = Math.max(0, Math.min(this.width, xHigh));

            // Store bar positions for right-click hit-test (only when on-screen)
            this.lastBandwidthXLow  = lowVisible  ? xLow  : null;
            this.lastBandwidthXHigh = highVisible ? xHigh : null;

            // Resolve colour with full opacity for bar/ticks
            const barColor = this.getBandwidthIndicatorColor(0.9);

            // Draw horizontal line connecting the (clamped) edges (thicker)
            this.overlayCtx.strokeStyle = barColor;
            this.overlayCtx.lineWidth = 3;
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(drawXLow, bracketY);
            this.overlayCtx.lineTo(drawXHigh, bracketY);
            this.overlayCtx.stroke();

            // Draw vertical tick at edges that are actually on-screen
            this.overlayCtx.lineWidth = 3;
            this.overlayCtx.beginPath();
            if (lowVisible) {
                this.overlayCtx.moveTo(xLow, bracketY - bracketHeight / 2);
                this.overlayCtx.lineTo(xLow, bracketY + bracketHeight / 2);
            }
            if (highVisible) {
                this.overlayCtx.moveTo(xHigh, bracketY - bracketHeight / 2);
                this.overlayCtx.lineTo(xHigh, bracketY + bracketHeight / 2);
            }
            this.overlayCtx.stroke();

            // Draw directional arrows at clamped ends where the edge is off-screen.
            // Arrow points toward the direction the off-screen edge lies.
            this.overlayCtx.fillStyle = barColor;

            // Left end arrow (pointing left) — low edge is off the left side
            if (!lowVisible) {
                const ax = drawXLow; // = 0
                this.overlayCtx.beginPath();
                this.overlayCtx.moveTo(ax,              bracketY);           // tip
                this.overlayCtx.lineTo(ax + arrowSize,  bracketY - arrowSize);
                this.overlayCtx.lineTo(ax + arrowSize,  bracketY + arrowSize);
                this.overlayCtx.closePath();
                this.overlayCtx.fill();
            }

            // Right end arrow (pointing right) — high edge is off the right side
            if (!highVisible) {
                const ax = drawXHigh; // = this.width
                this.overlayCtx.beginPath();
                this.overlayCtx.moveTo(ax,              bracketY);           // tip
                this.overlayCtx.lineTo(ax - arrowSize,  bracketY - arrowSize);
                this.overlayCtx.lineTo(ax - arrowSize,  bracketY + arrowSize);
                this.overlayCtx.closePath();
                this.overlayCtx.fill();
            }
        } else {
            // Both edges off-screen on the same side — bandwidth entirely outside view
            this.lastBandwidthXLow  = null;
            this.lastBandwidthXHigh = null;
        }

        // Draw vertical bandwidth lines extending down over waterfall/graph
        this.drawBandwidthLines(xLow, xHigh);
    }

    drawChatUserMarkers() {
        // Check if chat markers are enabled
        if (window.showChatMarkers === false) {
            return;
        }

        // Draw purple markers for active chat users (excluding self)
        // Get data from stats endpoint (stored in window.activeChannels by app.js)
        // NOTE: no console.log in this function — it runs on every marker cache
        // rebuild (every rendered frame while panning), so logging here is a
        // measurable jank source even with devtools closed.
        if (!window.activeChannels || window.activeChannels.length === 0) {
            return;
        }

        // Clear previous chat user marker positions
        if (!window.chatUserMarkerPositions) {
            window.chatUserMarkerPositions = [];
        }
        window.chatUserMarkerPositions = [];

        // Apply client-side prediction offset during dragging
        const effectiveCenterFreq = this.isDragging ?
            this.centerFreq + this.predictedFreqOffset :
            this.centerFreq;

        const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
        const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

        // Iterate through channels (skip index 0 which is the current user)
        window.activeChannels.forEach((channel, index) => {
            // Skip the first channel (index 0) which is the current user
            if (index === 0) {
                return;
            }

            // Skip channels without chat username
            if (!channel.chat_username || channel.chat_username.trim() === '') {
                return;
            }

            // Skip channels without frequency data
            if (!channel.frequency) {
                return;
            }

            const userFreq = channel.frequency;

            // Skip if user is at the same frequency as us (within 100 Hz tolerance)
            if (this.currentTunedFreq && Math.abs(userFreq - this.currentTunedFreq) < 100) {
                return;
            }

            // Check if frequency is within visible range
            if (userFreq < startFreq || userFreq > endFreq) {
                return;
            }

            // Calculate x position
            const x = ((userFreq - startFreq) / (endFreq - startFreq)) * this.overlayCanvas.width;

            // Draw chat username label at top
            const chatLabel = channel.chat_username;
            this._setFont(this.overlayCtx, 'bold 12px system-ui, -apple-system, sans-serif');
            this.overlayCtx.textAlign = 'center';
            this.overlayCtx.textBaseline = 'middle';

            // Background for label - purple
            const labelWidth = this.overlayCtx.measureText(chatLabel).width + 6;
            const labelHeight = 14;
            const labelY = 1;

            this.overlayCtx.fillStyle = 'rgba(147, 51, 234, 0.95)'; // Purple background
            this.overlayCtx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

            // Border for label
            this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            this.overlayCtx.lineWidth = 1;
            this.overlayCtx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

            // Label text
            this.overlayCtx.fillStyle = '#ffffff';
            this.overlayCtx.fillText(chatLabel, x, labelY + labelHeight / 2);

            // Draw longer downward arrow below label - extends to top of frequency scale (y=45)
            const arrowY = labelY + labelHeight;
            const arrowLength = 45 - arrowY;
            this.overlayCtx.fillStyle = 'rgba(147, 51, 234, 0.95)'; // Purple arrow
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(x, arrowY + arrowLength); // Arrow tip at y=45
            this.overlayCtx.lineTo(x - 3, arrowY); // Left point
            this.overlayCtx.lineTo(x + 3, arrowY); // Right point
            this.overlayCtx.closePath();
            this.overlayCtx.fill();

            // Arrow border
            this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            this.overlayCtx.lineWidth = 1;
            this.overlayCtx.stroke();

            // Store marker position for click detection
            window.chatUserMarkerPositions.push({
                x: x,
                y: labelY,
                width: labelWidth,
                height: labelHeight + arrowLength,
                username: channel.chat_username,
                frequency: channel.frequency,
                mode: channel.mode,
                bandwidthLow: channel.bandwidth_low,
                bandwidthHigh: channel.bandwidth_high,
                country: channel.country || channel.country_code
            });
        });
    }

    // Draw frequency scale on overlay canvas (always visible)
    drawFrequencyScaleOnOverlay(ctx) {
        if (!this.totalBandwidth) return;

        // Apply client-side prediction offset during dragging
        const effectiveCenterFreq = this.centerFreq + this.predictedFreqOffset;
        const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
        const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

        // Draw grey background for bookmark area (0-45px) - always visible
        ctx.fillStyle = '#adb5bd';
        ctx.fillRect(0, 0, this.width, 45);

        // Draw black background for frequency scale area (45-75px)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 45, this.width, 30);

        // Calculate appropriate frequency step based on available width.
        // Strategy:
        //   1. Pick an initial candidate step from the standard ladder using a rough
        //      pixel-per-label estimate (80px minimum spacing).
        //   2. Measure the actual rendered label width for a representative label.
        //   3. Walk up the ladder until one step-width >= label width + padding,
        //      guaranteeing labels never overlap regardless of zoom or canvas width.
        this._setFont(ctx, 'bold 13px monospace');

        // Ordered list of all valid step sizes (Hz)
        const stepLadder = [100, 200, 500, 1e3, 2e3, 5e3, 10e3, 20e3, 50e3,
                            100e3, 200e3, 500e3, 1e6, 2e6, 5e6, 10e6];

        // Rough initial candidate: aim for ~8 labels across the canvas
        const roughTargetStep = this.totalBandwidth / Math.max(1, Math.floor(this.width / 80));
        let freqStep = stepLadder[stepLadder.length - 1]; // fallback: largest step
        for (let i = 0; i < stepLadder.length; i++) {
            if (stepLadder[i] >= roughTargetStep) {
                freqStep = stepLadder[i];
                break;
            }
        }

        // Measure actual label width for a representative label at this step,
        // then bump up the step until one step-width comfortably fits the label.
        const sampleLabel = this.formatFrequencyScale(
            Math.round(effectiveCenterFreq / freqStep) * freqStep
        );
        const labelWidth = ctx.measureText(sampleLabel).width + 12; // +12px padding

        for (let i = stepLadder.indexOf(freqStep); i < stepLadder.length; i++) {
            const pixelsPerStep = (stepLadder[i] / this.totalBandwidth) * this.width;
            if (pixelsPerStep >= labelWidth) {
                freqStep = stepLadder[i];
                break;
            }
            freqStep = stepLadder[i]; // keep walking up even if we haven't found a fit yet
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw major ticks and labels (offset by 45px for bookmarks)
        const firstFreq = Math.ceil(startFreq / freqStep) * freqStep;
        for (let freq = firstFreq; freq <= endFreq; freq += freqStep) {
            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;

            // Draw tick mark (offset by 45px)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - 1, 45, 2, 12);

            // Draw label (offset by 45px)
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;

            const label = this.formatFrequencyScale(freq);
            ctx.strokeText(label, x, 65);
            ctx.fillText(label, x, 65);
        }

        // Draw minor ticks (at 1/5 of major step, offset by 45px)
        const minorStep = freqStep / 5;
        ctx.fillStyle = '#ffffff';
        const firstMinor = Math.ceil(startFreq / minorStep) * minorStep;
        for (let freq = firstMinor; freq <= endFreq; freq += minorStep) {
            // Skip major ticks
            if (Math.abs(freq % freqStep) < 1) continue;

            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;
            // Draw minor tick (8 pixels tall, 1.5 pixels wide, offset by 45px)
            ctx.fillRect(x - 0.75, 45, 1.5, 8);
        }
    }

    // Draw vertical green lines at bandwidth edges over waterfall/graph (split mode only)
    drawBandwidthLines(xLow, xHigh) {
        // Check if tuned frequency is visible first
        const effectiveCenterFreq = this.isDragging ?
            this.centerFreq + this.predictedFreqOffset :
            this.centerFreq;
        const startFreq = effectiveCenterFreq - this.totalBandwidth / 2;
        const endFreq = effectiveCenterFreq + this.totalBandwidth / 2;

        // Don't draw bandwidth lines if tuned frequency is off-screen
        if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) {
            // Clear any existing bandwidth lines
            this.bandwidthLinesCtx.clearRect(0, 0, this.bandwidthLinesCanvas.width, this.bandwidthLinesCanvas.height);
            return;
        }

        // Determine which edges are within the visible range
        const lowVisible  = xLow  >= 0 && xLow  <= this.width;
        const highVisible = xHigh >= 0 && xHigh <= this.width;

        // Clear the bandwidth lines overlay canvas
        this.bandwidthLinesCtx.clearRect(0, 0, this.bandwidthLinesCanvas.width, this.bandwidthLinesCanvas.height);

        // Nothing to draw if both edges are off-screen
        if (!lowVisible && !highVisible) return;

        // Split mode: draw on line graph (from 70px where graph starts) and waterfall
        // Line graph is 300px tall, waterfall is variable height
        // Total height needed: fullHeight (to cover both)
        const startY = 70; // Start where line graph drawing area begins (after bookmarks + freq scale)
        const height = this.fullHeight; // Cover both line graph and waterfall

        // Draw the bandwidth lines on the overlay canvas
        this.bandwidthLinesCtx.save();

        // Set line style for bandwidth edges
        this.bandwidthLinesCtx.strokeStyle = this.getBandwidthIndicatorColor(0.6);
        this.bandwidthLinesCtx.lineWidth = 2;
        this.bandwidthLinesCtx.setLineDash([5, 5]); // Dashed line pattern

        // Draw left edge line (only if within visible range)
        if (lowVisible) {
            this.bandwidthLinesCtx.beginPath();
            this.bandwidthLinesCtx.moveTo(xLow, startY);
            this.bandwidthLinesCtx.lineTo(xLow, height);
            this.bandwidthLinesCtx.stroke();
        }

        // Draw right edge line (only if within visible range)
        if (highVisible) {
            this.bandwidthLinesCtx.beginPath();
            this.bandwidthLinesCtx.moveTo(xHigh, startY);
            this.bandwidthLinesCtx.lineTo(xHigh, height);
            this.bandwidthLinesCtx.stroke();
        }

        this.bandwidthLinesCtx.restore();
    }

    // Invalidate marker cache to force redraw of bookmarks and DX spots
    // This should be called when DX spots are added/removed or when bookmarks change
    invalidateMarkerCache() {
        this.markerCache = null;
        this.lastMarkerCenterFreq = null;
        this.lastMarkerTotalBandwidth = null;
        this.lastMarkerDisplayMode = null;
        // Also invalidate cursor cache — it depends on the same view parameters
        this.cursorCache = null;
    }

    // Guard helper: only assign ctx.font when the value actually changes.
    // Parsing a font string is expensive (browser layout engine involvement) and
    // was measured at ~180 ms/profiling-window when called unconditionally at 60 fps.
    // Each CanvasRenderingContext2D tracks its own last-set font via a WeakMap so
    // multiple contexts (this.ctx, this.overlayCtx, this.lineGraphCtx, …) are handled
    // independently without any per-context setup.
    _setFont(ctx, font) {
        if (ctx.font !== font) ctx.font = font;
    }

    // Update auto-range based on current data (matching app.js waterfall behavior)
    updateAutoRange() {
        // Check for manual override FIRST
        if (this.config.manualRangeEnabled) {
            this.actualMinDb = this.config.manualMinDb;
            this.actualMaxDb = this.config.manualMaxDb;
            return;  // Skip automatic calculation
        }

        if (!this.spectrumData || this.spectrumData.length === 0) {
            return;
        }

        const now = Date.now();

        // Collect finite values and sort for percentile calculation
        const values = [];
        let absoluteMax = -Infinity;
        for (let i = 0; i < this.spectrumData.length; i++) {
            const db = this.spectrumData[i];
            if (isFinite(db)) {
                values.push(db);
                if (db > absoluteMax) absoluteMax = db;
            }
        }

        if (values.length > 0) {
            values.sort((a, b) => a - b);

            // Use 10th percentile as noise floor (good balance: ignores quiet outlier bins while
            // still sitting close to the actual noise floor in typical HF spectrum)
            // Use absolute maximum for ceiling to ensure strong signals are always captured
            const floorIndex = Math.floor(values.length * 0.10);
            const min = values[floorIndex];
            const max = absoluteMax;

            // Add margin
            const targetMin = Math.floor(min - this.config.rangeMargin);
            const targetMax = Math.ceil(max + this.config.rangeMargin);

            // Track minimum values over time for stable noise floor (2 second window)
            this.autoRangeMinHistory.push({ value: targetMin, timestamp: now });
            this.autoRangeMinHistory = this.autoRangeMinHistory.filter(m => now - m.timestamp <= this.autoRangeMinHistoryMaxAge);

            // Track maximum values over time for stable ceiling (5 second window for faster recovery)
            this.autoRangeMaxHistory.push({ value: targetMax, timestamp: now });
            this.autoRangeMaxHistory = this.autoRangeMaxHistory.filter(m => now - m.timestamp <= this.autoRangeMaxHistoryMaxAge);

            // Calculate smoothed values (average of recent history)
            const avgMin = this.autoRangeMinHistory.reduce((sum, m) => sum + m.value, 0) / this.autoRangeMinHistory.length;
            const avgMax = this.autoRangeMaxHistory.reduce((sum, m) => sum + m.value, 0) / this.autoRangeMaxHistory.length;

            // Apply smoothed values with user-controlled symmetric contrast offset
            this.actualMinDb = avgMin + this.config.autoContrast;
            this.actualMaxDb = avgMax - this.config.autoContrast;

            // Enforce minimum dynamic range on the FINAL displayed values (post-contrast).
            // autoMinSpan is the minimum visible dB span the user wants to see.
            // Uses a 75/25 split: 75% of the deficit expands the ceiling upward (headroom
            // for signals), 25% expands the floor downward (buffer below noise floor).
            // Hysteresis: only commit new clamped boundaries when they differ from the
            // last committed values by more than 3 dB — prevents rapid oscillation of
            // grid ticks when the smoothed values drift near a boundary.
            // This clamp only fires on quiet bands where auto has compressed the range
            // below the minimum; when signals are present and the natural range already
            // exceeds autoMinSpan the clamp never fires and existing behaviour is unchanged.
            if (this.config.autoMinSpan !== null) {
                const range = this.actualMaxDb - this.actualMinDb;
                if (range < this.config.autoMinSpan) {
                    const deficit = this.config.autoMinSpan - range;
                    const newMax = Math.round(this.actualMaxDb + deficit * 0.75);
                    const newMin = Math.round(this.actualMinDb - deficit * 0.25);
                    const hysteresis = 3; // dB dead-band
                    if (this._clampedMinDb === null ||
                        Math.abs(newMin - this._clampedMinDb) > hysteresis ||
                        Math.abs(newMax - this._clampedMaxDb) > hysteresis) {
                        this._clampedMinDb = newMin;
                        this._clampedMaxDb = newMax;
                    }
                    this.actualMinDb = this._clampedMinDb;
                    this.actualMaxDb = this._clampedMaxDb;
                } else {
                    // Natural range exceeds minimum — clear cached clamped values
                    this._clampedMinDb = null;
                    this._clampedMaxDb = null;
                }
            }
        }
    }

    // Draw grid lines
    drawGrid() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;

        // Horizontal grid lines (dB levels)
        // Use a 2 dB inset margin so ticks only appear/disappear when the boundary
        // has moved well past a grid line — prevents flickering when actualMinDb/
        // actualMaxDb drift slowly across a 10 dB boundary.
        const dbStep = 10;
        const dbRange = this.actualMaxDb - this.actualMinDb;
        const gridMargin = 2;
        const minDb = Math.floor((this.actualMinDb + gridMargin) / dbStep) * dbStep;
        const maxDb = Math.ceil((this.actualMaxDb - gridMargin) / dbStep) * dbStep;

        for (let db = minDb; db <= maxDb; db += dbStep) {
            const y = this.height - ((db - this.actualMinDb) / dbRange) * this.height;
            if (y >= 0 && y <= this.height) {
                this.ctx.beginPath();
                this.ctx.moveTo(0, y);
                this.ctx.lineTo(this.width, y);
                this.ctx.stroke();
            }
        }

        // Vertical grid lines (frequency)
        const freqStep = Math.pow(10, Math.floor(Math.log10(this.totalBandwidth / 10)));
        const startFreq = this.centerFreq - this.totalBandwidth / 2;

        for (let freq = Math.ceil(startFreq / freqStep) * freqStep;
             freq < startFreq + this.totalBandwidth;
             freq += freqStep) {
            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.height);
            this.ctx.stroke();
        }
    }

    // Draw frequency and dB labels
    drawLabels() {
        this.ctx.fillStyle = '#fff';
        this._setFont(this.ctx, '10px monospace');
        this.ctx.textAlign = 'left';

        // dB labels on left — use a 2 dB inset margin (same as drawGrid) so labels
        // only appear/disappear when the boundary has moved well past a grid line.
        const dbStep = 20;
        const dbRange = this.actualMaxDb - this.actualMinDb;
        const gridMargin = 2;
        const minDb = Math.floor((this.actualMinDb + gridMargin) / dbStep) * dbStep;
        const maxDb = Math.ceil((this.actualMaxDb - gridMargin) / dbStep) * dbStep;

        for (let db = minDb; db <= maxDb; db += dbStep) {
            const y = this.height - ((db - this.actualMinDb) / dbRange) * this.height;
            if (y >= 10 && y <= this.height - 10) {
                this.ctx.fillText(`${db} dB`, 5, y - 2);
            }
        }

        // Frequency labels at bottom
        this.ctx.textAlign = 'center';
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Start frequency
        this.ctx.fillText(this.formatFrequency(startFreq), 5, this.height - 5);

        // Center frequency
        this.ctx.fillText(this.formatFrequency(this.centerFreq), this.width / 2, this.height - 5);

        // End frequency
        this.ctx.textAlign = 'right';
        this.ctx.fillText(this.formatFrequency(endFreq), this.width - 5, this.height - 5);
    }

    // Apply predicted horizontal shift to waterfall canvas during dragging
    applyPredictedShift() {
        if (!this.predictedFreqOffset || !this.totalBandwidth) return;

        // Calculate pixel shift from frequency offset
        const pixelShift = (this.predictedFreqOffset / this.totalBandwidth) * this.width;

        // Only shift if movement is significant (at least 1 pixel)
        if (Math.abs(pixelShift) < 1) return;

        // Save current canvas content
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.canvas, 0, 0);

        // Clear canvas
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw shifted content
        // Negative offset = drag right = shift content left (show higher frequencies on right)
        // Positive offset = drag left = shift content right (show lower frequencies on left)
        this.ctx.drawImage(tempCanvas, -pixelShift, 0);

        // Fill gaps with black
        if (pixelShift > 0) {
            // Shifted right, fill left edge
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, pixelShift, this.height);
        } else {
            // Shifted left, fill right edge
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(this.width + pixelShift, 0, -pixelShift, this.height);
        }
    }

    // Apply predicted horizontal shift to line graph canvas during dragging
    applyPredictedShiftToLineGraph() {
        if (!this.predictedFreqOffset || !this.totalBandwidth || !this.lineGraphCanvas) return;

        // Calculate pixel shift from frequency offset
        const pixelShift = (this.predictedFreqOffset / this.totalBandwidth) * this.width;

        // Only shift if movement is significant (at least 1 pixel)
        if (Math.abs(pixelShift) < 1) return;

        // Save current canvas content
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.lineGraphCanvas.width;
        tempCanvas.height = this.lineGraphCanvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.lineGraphCanvas, 0, 0);

        // Clear canvas
        this.lineGraphCtx.fillStyle = '#000';
        this.lineGraphCtx.fillRect(0, 0, this.lineGraphCanvas.width, this.lineGraphCanvas.height);

        // Restore grey background for bookmarks area (top 45px)
        this.lineGraphCtx.fillStyle = '#adb5bd';
        this.lineGraphCtx.fillRect(0, 0, this.lineGraphCanvas.width, 45);

        // Draw shifted content
        // Negative offset = drag right = shift content left
        // Positive offset = drag left = shift content right
        this.lineGraphCtx.drawImage(tempCanvas, -pixelShift, 0);

        // Fill gaps with appropriate background
        if (pixelShift > 0) {
            // Shifted right, fill left edge
            // Top 45px: grey for bookmarks
            this.lineGraphCtx.fillStyle = '#adb5bd';
            this.lineGraphCtx.fillRect(0, 0, pixelShift, 45);
            // Rest: black for graph
            this.lineGraphCtx.fillStyle = '#000';
            this.lineGraphCtx.fillRect(0, 45, pixelShift, this.lineGraphCanvas.height - 45);
        } else {
            // Shifted left, fill right edge
            const rightEdge = this.lineGraphCanvas.width + pixelShift;
            // Top 45px: grey for bookmarks
            this.lineGraphCtx.fillStyle = '#adb5bd';
            this.lineGraphCtx.fillRect(rightEdge, 0, -pixelShift, 45);
            // Rest: black for graph
            this.lineGraphCtx.fillStyle = '#000';
            this.lineGraphCtx.fillRect(rightEdge, 45, -pixelShift, this.lineGraphCanvas.height - 45);
        }
    }

    // Draw cursor information
    drawCursorInfo() {
        if (!this.spectrumData) return;

        const binIndex = Math.floor((this.mouseX / this.width) * this.spectrumData.length);
        if (binIndex < 0 || binIndex >= this.spectrumData.length) return;

        const db = this.spectrumData[binIndex];
        const fullStartFreq = this.centerFreq - this.totalBandwidth / 2;
        const freq = fullStartFreq + (binIndex / this.spectrumData.length) * this.totalBandwidth;

        // Draw vertical line at cursor
        this.ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(this.mouseX, 0);
        this.ctx.lineTo(this.mouseX, this.height);
        this.ctx.stroke();

        // Draw info box
        const text = `${this.formatFrequency(freq)} | ${db.toFixed(1)} dB`;
        this._setFont(this.ctx, '12px monospace');
        const metrics = this.ctx.measureText(text);
        const boxWidth = metrics.width + 10;
        const boxHeight = 20;

        let boxX = this.mouseX + 10;
        let boxY = this.mouseY - 10;

        // Keep box on screen
        if (boxX + boxWidth > this.width) {
            boxX = this.mouseX - boxWidth - 10;
        }
        if (boxY < 0) {
            boxY = this.mouseY + 10;
        }

        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        this.ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
        this.ctx.strokeStyle = '#fff';
        this.ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

        this.ctx.fillStyle = '#fff';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(text, boxX + 5, boxY + 14);
    }

    // Draw placeholder when no data
    drawPlaceholder() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.ctx.fillStyle = '#666';
        this._setFont(this.ctx, '16px sans-serif');
        this.ctx.textAlign = 'center';
        this.ctx.fillText('Waiting for spectrum data...', this.width / 2, this.height / 2);
    }

    // Format frequency for display (used by tooltips and cursor - high precision)
    formatFrequency(freq) {
        if (freq >= 1e9) {
            // GHz: show 5 decimals
            const ghz = freq / 1e9;
            return `${ghz.toFixed(5)} GHz`;
        } else if (freq >= 1e6) {
            // MHz: show 5 decimals
            const mhz = freq / 1e6;
            return `${mhz.toFixed(5)} MHz`;
        } else if (freq >= 1e3) {
            // kHz: show 2 decimals
            const khz = freq / 1e3;
            return `${khz.toFixed(2)} kHz`;
        } else {
            return `${freq.toFixed(0)} Hz`;
        }
    }

    // Format frequency for scale markers (lower precision for cleaner display)
    formatFrequencyScale(freq) {
        // Always display in MHz format for consistency
        // Use 3 decimal places when zoomed in (zoom level > 1)
        const decimals = this.zoomLevel > 1 ? 3 : 2;
        const mhz = freq / 1e6;
        return `${mhz.toFixed(decimals)}`;
    }

    // Create color gradient for spectrum display
    createColorGradient() {
        const colors = this.getColorScheme(this.config.colorScheme);
        const gradient = [];
        const steps = 256;

        for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            const color = this.interpolateColors(colors, t);
            gradient.push(color);
        }

        return gradient;
    }

    // Get color scheme
    getColorScheme(name) {
        const schemes = {
            // Full 256-entry Turbo palette (Google AI) — converted from SDRPlusPlus turbo.json
            turbo: [
                [48,18,59],[50,21,67],[51,24,74],[52,27,81],[53,30,88],[54,33,95],[55,36,102],[56,39,109],
                [57,42,115],[58,45,121],[59,47,128],[60,50,134],[61,53,139],[62,56,145],[63,59,151],[63,62,156],
                [64,64,162],[65,67,167],[65,70,172],[66,73,177],[66,75,181],[67,78,186],[68,81,191],[68,84,195],
                [68,86,199],[69,89,203],[69,92,207],[69,94,211],[70,97,214],[70,100,218],[70,102,221],[70,105,224],
                [70,107,227],[71,110,230],[71,113,233],[71,115,235],[71,118,238],[71,120,240],[71,123,242],[70,125,244],
                [70,128,246],[70,130,248],[70,133,250],[70,135,251],[69,138,252],[69,140,253],[68,143,254],[67,145,254],
                [66,148,255],[65,150,255],[64,153,255],[62,155,254],[61,158,254],[59,160,253],[58,163,252],[56,165,251],
                [55,168,250],[53,171,248],[51,173,247],[49,175,245],[47,178,244],[46,180,242],[44,183,240],[42,185,238],
                [40,188,235],[39,190,233],[37,192,231],[35,195,228],[34,197,226],[32,199,223],[31,201,221],[30,203,218],
                [28,205,216],[27,208,213],[26,210,210],[26,212,208],[25,213,205],[24,215,202],[24,217,200],[24,219,197],
                [24,221,194],[24,222,192],[24,224,189],[25,226,187],[25,227,185],[26,228,182],[28,230,180],[29,231,178],
                [31,233,175],[32,234,172],[34,235,170],[37,236,167],[39,238,164],[42,239,161],[44,240,158],[47,241,155],
                [50,242,152],[53,243,148],[56,244,145],[60,245,142],[63,246,138],[67,247,135],[70,248,132],[74,248,128],
                [78,249,125],[82,250,122],[85,250,118],[89,251,115],[93,252,111],[97,252,108],[101,253,105],[105,253,102],
                [109,254,98],[113,254,95],[117,254,92],[121,254,89],[125,255,86],[128,255,83],[132,255,81],[136,255,78],
                [139,255,75],[143,255,73],[146,255,71],[150,254,68],[153,254,66],[156,254,64],[159,253,63],[161,253,61],
                [164,252,60],[167,252,58],[169,251,57],[172,251,56],[175,250,55],[177,249,54],[180,248,54],[183,247,53],
                [185,246,53],[188,245,52],[190,244,52],[193,243,52],[195,241,52],[198,240,52],[200,239,52],[203,237,52],
                [205,236,52],[208,234,52],[210,233,53],[212,231,53],[215,229,53],[217,228,54],[219,226,54],[221,224,55],
                [223,223,55],[225,221,55],[227,219,56],[229,217,56],[231,215,57],[233,213,57],[235,211,57],[236,209,58],
                [238,207,58],[239,205,58],[241,203,58],[242,201,58],[244,199,58],[245,197,58],[246,195,58],[247,193,58],
                [248,190,57],[249,188,57],[250,186,57],[251,184,56],[251,182,55],[252,179,54],[252,177,54],[253,174,53],
                [253,172,52],[254,169,51],[254,167,50],[254,164,49],[254,161,48],[254,158,47],[254,155,45],[254,153,44],
                [254,150,43],[254,147,42],[254,144,41],[253,141,39],[253,138,38],[252,135,37],[252,132,35],[251,129,34],
                [251,126,33],[250,123,31],[249,120,30],[249,117,29],[248,114,28],[247,111,26],[246,108,25],[245,105,24],
                [244,102,23],[243,99,21],[242,96,20],[241,93,19],[240,91,18],[239,88,17],[237,85,16],[236,83,15],
                [235,80,14],[234,78,13],[232,75,12],[231,73,12],[229,71,11],[228,69,10],[226,67,10],[225,65,9],
                [223,63,8],[221,61,8],[220,59,7],[218,57,7],[216,55,6],[214,53,6],[212,51,5],[210,49,5],
                [208,47,5],[206,45,4],[204,43,4],[202,42,4],[200,40,3],[197,38,3],[195,37,3],[193,35,2],
                [190,33,2],[188,32,2],[185,30,2],[183,29,2],[180,27,1],[178,26,1],[175,24,1],[172,23,1],
                [169,22,1],[167,20,1],[164,19,1],[161,18,1],[158,16,1],[155,15,1],[152,14,1],[149,13,1],
                [146,11,1],[142,10,1],[139,9,2],[136,8,2],[133,7,2],[129,6,2],[126,5,2],[122,4,3]
            ],
            viridis: [
                [68, 1, 84],
                [59, 82, 139],
                [33, 145, 140],
                [94, 201, 98],
                [253, 231, 37]
            ],
            plasma: [
                [13, 8, 135],
                [126, 3, 168],
                [204, 71, 120],
                [248, 149, 64],
                [240, 249, 33]
            ],
            jet: [
                [0, 0, 143],
                [0, 0, 255],
                [0, 255, 255],
                [255, 255, 0],
                [255, 0, 0],
                [128, 0, 0]
            ],
            // Sonar / Night Vision palettes — ported from VibeSDR colormaps.ts, brightened
            // 6 stops: black → dim → mid → bright → full → highlight
            // Aggressive early ramp so lower-end signals show colour quickly
            'sonar-green': [
                [0,0,0],[0,80,0],[0,180,0],[0,255,0],[160,255,160],[240,255,255]
            ],
            'sonar-orange': [
                [0,0,0],[100,30,0],[210,80,0],[255,150,30],[255,210,120],[255,248,220]
            ],
            'night-vision': [
                [0,0,0],[100,0,0],[210,10,10],[255,60,60],[255,160,160],[255,235,235]
            ]
        };

        return schemes[name] || schemes.jet;
    }

    // Interpolate between colors
    interpolateColors(colors, t) {
        const segments = colors.length - 1;
        const segment = Math.min(Math.floor(t * segments), segments - 1);
        const localT = (t * segments) - segment;

        const c1 = colors[segment];
        const c2 = colors[segment + 1];

        const r = Math.round(c1[0] + (c2[0] - c1[0]) * localT);
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * localT);
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * localT);

        return `rgb(${r}, ${g}, ${b})`;
    }

    // Get color for normalized value (returns CSS string)
    getColor(normalized) {
        const index = Math.floor(normalized * (this.colorGradient.length - 1));
        return this.colorGradient[index];
    }

    // Get color as RGB object for waterfall
    getColorRGB(normalized) {
        // Clamp normalized value to valid range [0, 1] to prevent undefined array access
        const clampedNormalized = Math.max(0, Math.min(1, normalized));
        const index = Math.floor(clampedNormalized * (this.colorGradient.length - 1));
        const colorStr = this.colorGradient[index];

        // Safety check: if colorStr is undefined, return black
        if (!colorStr) {
            console.warn(`getColorRGB: undefined color at index ${index} (normalized=${normalized})`);
            return { r: 0, g: 0, b: 0 };
        }

        // Parse rgb(r, g, b) string
        const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (match) {
            return {
                r: parseInt(match[1]),
                g: parseInt(match[2]),
                b: parseInt(match[3])
            };
        }

        // Fallback to black
        return { r: 0, g: 0, b: 0 };
    }

    // Setup mouse event handlers
    setupMouseHandlers() {
        // Create custom context menu for Center Carrier feature
        this.createContextMenu();

        // Track mouse position for tooltip
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            // Handle dragging
            if (this.isDragging) {
                // Only process if mouse actually moved
                if (this.mouseX === this.lastDragX && this.mouseY === this.lastDragY) {
                    return; // No actual movement, ignore this event
                }
                this.lastDragX = this.mouseX;
                this.lastDragY = this.mouseY;

                const deltaX = this.mouseX - this.dragStartX;

                // Mark that we've moved if delta is significant
                if (Math.abs(deltaX) > 5) {
                    this.dragDidMove = true;
                }

                // Calculate frequency change based on pixel movement
                // Negative deltaX (drag left) should increase frequency (pan right)
                // Positive deltaX (drag right) should decrease frequency (pan left)
                const freqPerPixel = this.totalBandwidth / this.width;
                const freqDelta = -deltaX * freqPerPixel;
                let newCenterFreq = this.dragStartFreq + freqDelta;

                // Apply boundary constraints (0-30 MHz)
                const halfBandwidth = this.totalBandwidth / 2;
                const minCenterFreq = 0 + halfBandwidth;
                const maxCenterFreq = 30e6 - halfBandwidth;

                // Clamp to boundaries
                newCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

                // CLIENT-SIDE PREDICTION: Update visual offset immediately for smooth dragging.
                // No synchronous draw() here — the 30fps rAF loop in startFrameProcessing()
                // picks the new offset up on its next tick (see line-graph handler note).
                this.predictedFreqOffset = newCenterFreq - this.lastServerCenterFreq;

                // Throttle pan requests to avoid backend rounding issues
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (this.dragDidMove && timeSinceLastPan >= this.panThrottleMs) {
                    this.panTo(newCenterFreq);
                    this.lastPanTime = now;
                    // Don't update dragStartX/dragStartFreq here - keep original drag start point
                }

                // Don't show tooltip while dragging
                this.hideTooltip();
            } else {
                // Update tooltip when not dragging
                this.updateTooltip();
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.mouseX = -1;
            this.mouseY = -1;
            this.isDragging = false;
            this.hideTooltip();
            this.canvas.style.cursor = 'default';
        });

        // Mouse down - start dragging
        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.spectrumData) return;

            // Check if we're showing full bandwidth (0-30 MHz)
            // If so, don't allow dragging
            const startFreq = this.centerFreq - this.totalBandwidth / 2;
            const endFreq = this.centerFreq + this.totalBandwidth / 2;
            const isFullBandwidth = (startFreq <= 0 && endFreq >= 30e6);

            if (isFullBandwidth) {
                // Don't start dragging if showing full bandwidth
                return;
            }

            const rect = this.canvas.getBoundingClientRect();
            this.dragStartX = e.clientX - rect.left;
            this.dragStartFreq = this.centerFreq;
            this.lastServerCenterFreq = this.centerFreq; // Track starting server position
            this.predictedFreqOffset = 0; // Reset prediction offset
            this.isDragging = true;
            this.dragDidMove = false; // Track if we actually moved
            this.lastDragX = this.mouseX; // Initialize drag position tracking
            this.lastDragY = this.mouseY;
            this.canvas.style.cursor = 'default';

            // Prevent text selection while dragging
            e.preventDefault();
        });

        // Mouse up - stop dragging or handle click
        this.canvas.addEventListener('mouseup', (e) => {
            if (!this.spectrumData) return;

            // Skip if bandwidth drag is active or just finished
            if (this.bandwidthDragState && (this.bandwidthDragState.isDragging || this.bandwidthDragState.wasDragging)) {
                if (this.bandwidthDragState.wasDragging) {
                    this.bandwidthDragState.wasDragging = false;
                }
                return;
            }

            // Ignore right-clicks (button 2) - they're handled by contextmenu event
            if (e.button === 2) {
                this.isDragging = false;
                this.dragDidMove = false;
                return;
            }

            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // If we didn't drag (dragDidMove is false), treat it as a click
            if (!this.dragDidMove) {
                // If not a bookmark click (bookmarks are handled by the overlay canvas click handler),
                // handle as frequency tuning
                if (this.config.onFrequencyClick) {
                    // Calculate frequency from server data range
                    const startFreq = this.centerFreq - this.totalBandwidth / 2;
                    let freq = startFreq + (x / this.width) * this.totalBandwidth;

                    // Apply snap if enabled and in USB/LSB mode (uses frequency scroll step value)
                    if (this.snapEnabled) {
                        const currentMode = window.currentMode ? window.currentMode.toLowerCase() : '';
                        // Get snap step from frequency scroll dropdown (extract number from value like "500-fast")
                        const snapStep = window.frequencyScrollStep || 1000; // Default to 1 kHz if not set
                        if (currentMode === 'lsb') {
                            // LSB: add 200 Hz offset, then round to nearest step
                            const adjustedFreq = freq + 200;
                            freq = Math.round(adjustedFreq / snapStep) * snapStep;
                        } else if (currentMode === 'usb') {
                            // USB: subtract 200 Hz offset, then round to nearest step
                            const adjustedFreq = freq - 200;
                            freq = Math.round(adjustedFreq / snapStep) * snapStep;
                        }
                    }

                    // Set flag to skip auto-pan since this frequency change is from clicking
                    this.skipNextPan = true;

                    this.config.onFrequencyClick(freq);
                }
            }

            this.isDragging = false;
            this.dragDidMove = false;
            this.predictedFreqOffset = 0; // Clear prediction offset when drag ends
            this.updateCursorStyle();

            // Redraw to clear any prediction artifacts
            if (this.spectrumData && this.spectrumData.length > 0) {
                this.draw();
            }
        });

        // Add context menu handler (right-click)
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // Prevent default browser context menu
            this.handleContextMenu(e);
        });

        // Update cursor style based on zoom level
        this.updateCursorStyle();

        // Create tooltip element
        this.tooltip = document.createElement('div');
        this.tooltip.style.position = 'fixed';
        this.tooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
        this.tooltip.style.color = '#fff';
        this.tooltip.style.padding = '8px 12px';
        this.tooltip.style.borderRadius = '4px';
        this.tooltip.style.fontSize = '12px';
        this.tooltip.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Twemoji Flags', ui-monospace, 'Courier New', monospace";
        this.tooltip.style.lineHeight = '1.4';
        this.tooltip.style.pointerEvents = 'none';
        this.tooltip.style.zIndex = '10000';
        this.tooltip.style.display = 'none';
        this.tooltip.style.whiteSpace = 'nowrap';
        this.tooltip.style.border = '1px solid #fff';
        document.body.appendChild(this.tooltip);

        // When a callsign lookup completes, update the tooltip image if it's still showing
        // the same callsign (handles the case where the user clicked a marker and the async
        // QRZ fetch finished while the tooltip was still visible).
        this._tooltipCallsign = null;
        this._tooltipText = null;
        window.addEventListener('callsign_lookup_complete', (ev) => {
            if (!this._tooltipCallsign || this.tooltip.style.display === 'none') return;
            const detail = ev.detail || {};
            const evCallsign = (detail.callsign || '').toUpperCase();
            if (evCallsign !== this._tooltipCallsign) return;
            const imageUrl = detail.imageUrl;
            if (!imageUrl) return;
            const _img = `<img src="${imageUrl}" style="width:56px;height:auto;border-radius:3px;flex-shrink:0;display:block;">`;
            this.tooltip.style.whiteSpace = 'normal';
            this.tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px;">${_img}<div style="white-space:nowrap;">${this._tooltipText}</div></div>`;
        });

        // Add touch gesture support for mobile pinch-to-zoom
        this.setupTouchHandlers();
    }

    // Setup touch event handlers for pinch-to-zoom and pan
    setupTouchHandlers() {
        let touchStartDistance = 0;
        let touchStartCenterX = 0;
        let touchStartFreq = 0;
        let touchStartBinBandwidth = 0;
        let isTouchPanning = false;
        let touchPanStartX = 0;
        let touchPanStartFreq = 0;

        const getTouchDistance = (touch1, touch2) => {
            const dx = touch2.clientX - touch1.clientX;
            const dy = touch2.clientY - touch1.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const getTouchCenter = (touch1, touch2) => {
            return {
                x: (touch1.clientX + touch2.clientX) / 2,
                y: (touch1.clientY + touch2.clientY) / 2
            };
        };

        const handleTouchStart = (e) => {
            // Ignore touches that land on the spectrum controls bar overlay
            // (checkboxes, buttons, selects) — let them handle the event natively.
            const controlsBar = document.querySelector('.spectrum-display-controls');
            if (controlsBar && e.touches.length > 0) {
                const touch = e.touches[0];
                const barRect = controlsBar.getBoundingClientRect();
                if (touch.clientY >= barRect.top && touch.clientY <= barRect.bottom &&
                    touch.clientX >= barRect.left && touch.clientX <= barRect.right) {
                    return; // Touch is inside the controls bar — don't start pan/zoom
                }
            }
            if (e.touches.length === 2) {
                // Two-finger touch - prepare for pinch zoom
                e.preventDefault();
                touchStartDistance = getTouchDistance(e.touches[0], e.touches[1]);
                const center = getTouchCenter(e.touches[0], e.touches[1]);
                const rect = this.canvas.getBoundingClientRect();
                touchStartCenterX = center.x - rect.left;
                touchStartFreq = this.centerFreq;
                touchStartBinBandwidth = this.binBandwidth;
                isTouchPanning = false;
            } else if (e.touches.length === 1) {
                // Single finger - prepare for pan
                const rect = this.canvas.getBoundingClientRect();
                touchPanStartX = e.touches[0].clientX - rect.left;
                touchPanStartFreq = this.centerFreq;
                isTouchPanning = true;
            }
        };

        const handleTouchMove = (e) => {
            if (e.touches.length === 2 && touchStartDistance > 0) {
                // Two-finger pinch zoom
                e.preventDefault();
                const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
                const scale = currentDistance / touchStartDistance;

                // Calculate new bin bandwidth (inverse of scale for zoom)
                let newBinBandwidth = touchStartBinBandwidth / scale;

                // Clamp to reasonable limits — 10 Hz/bin minimum matches the Max button floor
                newBinBandwidth = Math.max(10, Math.min(this.initialBinBandwidth || 1000, newBinBandwidth));

                // Get touch center position
                const center = getTouchCenter(e.touches[0], e.touches[1]);
                const rect = this.canvas.getBoundingClientRect();
                const centerX = center.x - rect.left;

                // Calculate frequency at touch center
                const startFreq = touchStartFreq - (touchStartBinBandwidth * this.binCount) / 2;
                const touchFreq = startFreq + (touchStartCenterX / this.width) * (touchStartBinBandwidth * this.binCount);

                // Calculate new center frequency to keep touch point at same position
                const newTotalBW = newBinBandwidth * this.binCount;
                const newCenterFreq = touchFreq;

                // Constrain to 0-30 MHz
                const halfBandwidth = newTotalBW / 2;
                const minCenterFreq = 0 + halfBandwidth;
                const maxCenterFreq = 30e6 - halfBandwidth;
                const clampedCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

                // Send zoom request
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'zoom',
                        frequency: Math.round(clampedCenterFreq),
                        binBandwidth: newBinBandwidth
                    }));

                    // Optimistically update zoom slider immediately (corrected when config arrives)
                    if (typeof window.updateZoomSlider === 'function') {
                        if (typeof window.clearZoomSliderSource === 'function') window.clearZoomSliderSource();
                        const _prev = this.binBandwidth;
                        this.binBandwidth = newBinBandwidth;
                        window.updateZoomSlider();
                        this.binBandwidth = _prev;
                    }
                }
            } else if (e.touches.length === 1 && isTouchPanning) {
                // Single finger pan
                e.preventDefault();
                const rect = this.canvas.getBoundingClientRect();
                const currentX = e.touches[0].clientX - rect.left;
                const deltaX = currentX - touchPanStartX;

                // Calculate frequency change
                const freqPerPixel = this.totalBandwidth / this.width;
                const freqDelta = -deltaX * freqPerPixel;
                let newCenterFreq = touchPanStartFreq + freqDelta;

                // Apply boundary constraints
                const halfBandwidth = this.totalBandwidth / 2;
                const minCenterFreq = 0 + halfBandwidth;
                const maxCenterFreq = 30e6 - halfBandwidth;
                newCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

                // Send pan request (throttled)
                const now = Date.now();
                if (now - this.lastPanTime >= this.panThrottleMs) {
                    this.panTo(newCenterFreq);
                    this.lastPanTime = now;
                }
            }
        };

        const handleTouchEnd = (e) => {
            if (e.touches.length < 2) {
                touchStartDistance = 0;
            }
            if (e.touches.length === 0) {
                isTouchPanning = false;
            }
        };

        // Add touch listeners to both canvases
        this.canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', handleTouchEnd, { passive: false });

        if (this.lineGraphCanvas) {
            this.lineGraphCanvas.addEventListener('touchstart', handleTouchStart, { passive: false });
            this.lineGraphCanvas.addEventListener('touchmove', handleTouchMove, { passive: false });
            this.lineGraphCanvas.addEventListener('touchend', handleTouchEnd, { passive: false });
        }
    }

    // Setup mouse wheel scroll handler
    setupScrollHandler() {
        // Throttle variables for scroll wheel
        let lastScrollTime = 0;
        // Accumulator for normalising trackpad vs mouse wheel delta across all devices.
        // Trackpad fires many small pixel-mode events; mouse fires one large event.
        // We accumulate until ≥ WHEEL_STEP_PX pixels have been scrolled, then act once.
        let wheelAccumulator = 0;

        // Setup checkbox handlers
        const scrollCheckbox = document.getElementById('spectrum-scroll-enable');
        const zoomScrollCheckbox = document.getElementById('spectrum-zoom-scroll-enable');
        const smoothCheckbox = document.getElementById('spectrum-smooth-enable');
        
        // Make scroll checkboxes mutually exclusive
        if (scrollCheckbox && zoomScrollCheckbox) {
            scrollCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    zoomScrollCheckbox.checked = false;
                    this.zoomScrollEnabled = false;
                }
                this.scrollEnabled = e.target.checked;
                console.log(`Spectrum scroll ${this.scrollEnabled ? 'enabled' : 'disabled'}`);
            });
            
            zoomScrollCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    scrollCheckbox.checked = false;
                    this.scrollEnabled = false;
                }
                this.zoomScrollEnabled = e.target.checked;
                console.log(`Spectrum zoom scroll ${this.zoomScrollEnabled ? 'enabled' : 'disabled'}`);
            });
        } else if (scrollCheckbox) {
            scrollCheckbox.addEventListener('change', (e) => {
                this.scrollEnabled = e.target.checked;
                console.log(`Spectrum scroll ${this.scrollEnabled ? 'enabled' : 'disabled'}`);
            });
        }

        // Setup smoothing checkbox handler
        if (smoothCheckbox) {
            // Load saved preference from localStorage (default to false/unchecked)
            const savedSmoothState = localStorage.getItem('spectrumSmoothEnabled');
            const isSmoothEnabled = savedSmoothState === 'true'; // Only true if explicitly saved as 'true'
            smoothCheckbox.checked = isSmoothEnabled;
            this.smoothingEnabled = isSmoothEnabled;

            smoothCheckbox.addEventListener('change', (e) => {
                this.smoothingEnabled = e.target.checked;
                localStorage.setItem('spectrumSmoothEnabled', e.target.checked.toString());
                console.log(`Spectrum smoothing ${this.smoothingEnabled ? 'enabled' : 'disabled'}`);
                // No need to clear specEma — the EMA converges to the new time
                // constant within a few frames without any visible artefact.
            });
        }

        // Setup GPU scroll checkbox handler
        const gpuScrollCheckbox = document.getElementById('spectrum-gpu-scroll-enable');
        if (gpuScrollCheckbox) {
            // Load saved preference from localStorage (default to true/checked)
            const savedGpuState = localStorage.getItem('spectrumGpuScrollEnabled');
            const isGpuEnabled = savedGpuState !== 'false'; // true unless explicitly saved as 'false'
            gpuScrollCheckbox.checked = isGpuEnabled;
            this.gpuScrollEnabled = isGpuEnabled;

            gpuScrollCheckbox.addEventListener('change', (e) => {
                this.gpuScrollEnabled = e.target.checked;
                localStorage.setItem('spectrumGpuScrollEnabled', e.target.checked.toString());
                console.log(`Spectrum GPU scroll ${this.gpuScrollEnabled ? 'enabled' : 'disabled'}`);

                // Reset GPU scroll state when toggling to avoid visual glitches
                this.resetGPUScroll();
                // Also reset CPU scroll accumulator
                this.scrollAccumulator = 0;
                this.lastRafTime = null; // reset timing so elapsed doesn't spike on next tick
            });
        }

        // Setup peak hold checkbox handler
        const holdCheckbox = document.getElementById('spectrum-hold-enable');
        if (holdCheckbox) {
            // Load saved preference from localStorage (default to true/checked)
            const savedHoldState = localStorage.getItem('spectrumHoldEnabled');
            const isHoldEnabled = savedHoldState !== 'false'; // Default to true unless explicitly saved as 'false'
            holdCheckbox.checked = isHoldEnabled;
            this.peakHoldEnabled = isHoldEnabled;

        holdCheckbox.addEventListener('change', (e) => {
            this.peakHoldEnabled = e.target.checked;
            localStorage.setItem('spectrumHoldEnabled', e.target.checked.toString());
            console.log(`Spectrum peak hold ${this.peakHoldEnabled ? 'enabled' : 'disabled'}`);

            // Clear peak hold data when disabling
            if (!this.peakHoldEnabled) {
                this.peakHoldData = null;
            }
        });
    }

        // Setup 1 KHz snap checkbox handler
        const snapCheckbox = document.getElementById('spectrum-snap-enable');
        if (snapCheckbox) {
            snapCheckbox.addEventListener('change', (e) => {
                this.snapEnabled = e.target.checked;
                const snapStep = window.frequencyScrollStep || 1000;
                console.log(`Spectrum snap ${this.snapEnabled ? 'enabled' : 'disabled'} (step: ${snapStep} Hz)`);
            });
        }

        // Setup Edge Tune checkbox handler
        const edgeTuneCheckbox = document.getElementById('spectrum-edge-tune-enable');
        if (edgeTuneCheckbox) {
            // Load saved preference from localStorage (default disabled)
            const savedState = localStorage.getItem('edgeTuneEnabled');
            const isEnabled = savedState === 'true';
            edgeTuneCheckbox.checked = isEnabled;
            this.edgeTuneEnabled = isEnabled;

            edgeTuneCheckbox.addEventListener('change', (e) => {
                this.edgeTuneEnabled = e.target.checked;
                localStorage.setItem('edgeTuneEnabled', e.target.checked.toString());
                console.log(`Spectrum edge tune ${this.edgeTuneEnabled ? 'enabled' : 'disabled'}`);
            });
        }

        // Setup line graph (spectrum) visibility toggle
        const lineGraphToggle = document.getElementById('spectrum-line-graph-enable');
        if (lineGraphToggle) {
            // Load saved preference from localStorage (default to false/unchecked)
            const savedState = localStorage.getItem('spectrumLineGraphEnabled');
            const isEnabled = savedState === 'true'; // Only true if explicitly saved as 'true'
            lineGraphToggle.checked = isEnabled;

            // Apply the loaded state immediately
            this.toggleLineGraphVisibility(isEnabled);

            lineGraphToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                // Save preference to localStorage
                localStorage.setItem('spectrumLineGraphEnabled', enabled.toString());
                this.toggleLineGraphVisibility(enabled);

                // Automatically adjust frame rate: reduced rate when line graph is hidden
                // (waterfall still runs but the line graph isn't drawn, so full rate
                // has less benefit). Full rate is restored when the line graph is shown.
                this.setRate(enabled ? 1 : 3);

                // Enable/disable smooth and hold checkboxes based on spectrum visibility
                if (smoothCheckbox) {
                    smoothCheckbox.disabled = !enabled;
                    if (!enabled) {
                        smoothCheckbox.checked = false;
                        this.smoothingEnabled = false;
                    }
                }
                if (holdCheckbox) {
                    holdCheckbox.disabled = !enabled;
                    if (!enabled) {
                        // Don't uncheck hold when disabling spectrum, just disable it
                        // This preserves the user's preference for when they re-enable spectrum
                    }
                }
            });
        }

        // Initialize smooth and hold checkbox states based on spectrum visibility
        if (smoothCheckbox && lineGraphToggle) {
            smoothCheckbox.disabled = !lineGraphToggle.checked;
        }
        if (holdCheckbox && lineGraphToggle) {
            holdCheckbox.disabled = !lineGraphToggle.checked;
        }

        // Setup manual range controls
        const manualRangeCheckbox = document.getElementById('spectrum-manual-range-enable');
        const manualRangeControls = document.getElementById('spectrum-manual-range-controls');
        const autoRangeControls = document.getElementById('spectrum-auto-range-controls');
        const minDbSlider = document.getElementById('spectrum-min-db');
        const maxDbSlider = document.getElementById('spectrum-max-db');
        const minDbValue = document.getElementById('spectrum-min-db-value');
        const maxDbValue = document.getElementById('spectrum-max-db-value');
        const autoContrastSlider = document.getElementById('spectrum-auto-contrast');
        const autoContrastValue = document.getElementById('spectrum-auto-contrast-value');
        const autoMinSpanSlider = document.getElementById('spectrum-auto-min-span');
        const autoMinSpanValue = document.getElementById('spectrum-auto-min-span-value');

        // Helper: sync auto/manual control visibility to current manual state
        const syncRangeControlVisibility = (manualEnabled) => {
            if (manualRangeControls) manualRangeControls.style.display = manualEnabled ? 'flex' : 'none';
            if (autoRangeControls)   autoRangeControls.style.display   = manualEnabled ? 'none' : 'flex';
        };

        // Load saved manual range settings from localStorage
        const savedManualRangeEnabled = localStorage.getItem('spectrumManualRangeEnabled');
        const savedMinDb = localStorage.getItem('spectrumManualMinDb');
        const savedMaxDb = localStorage.getItem('spectrumManualMaxDb');
        const savedAutoContrast = localStorage.getItem('spectrumAutoContrast');
        const savedAutoMinSpan = localStorage.getItem('spectrumAutoMinSpan');

        if (savedManualRangeEnabled !== null) {
            const isEnabled = savedManualRangeEnabled === 'true';
            this.config.manualRangeEnabled = isEnabled;
            if (manualRangeCheckbox) {
                manualRangeCheckbox.checked = isEnabled;
            }
            syncRangeControlVisibility(isEnabled);
        }

        if (savedMinDb !== null) {
            const minDb = parseFloat(savedMinDb);
            this.config.manualMinDb = minDb;
            if (minDbSlider) {
                minDbSlider.value = minDb;
            }
            if (minDbValue) {
                minDbValue.textContent = minDb.toFixed(0);
            }
        }

        if (savedMaxDb !== null) {
            const maxDb = parseFloat(savedMaxDb);
            this.config.manualMaxDb = maxDb;
            if (maxDbSlider) {
                maxDbSlider.value = maxDb;
            }
            if (maxDbValue) {
                maxDbValue.textContent = maxDb.toFixed(0);
            }
        }

        if (savedAutoContrast !== null) {
            const val = parseFloat(savedAutoContrast);
            this.config.autoContrast = val;
            if (autoContrastSlider) autoContrastSlider.value = val;
            if (autoContrastValue)  autoContrastValue.textContent = val.toFixed(0);
        } else {
            // No localStorage value — read the slider's current value which was already
            // set to the server default by ui-config.js (loadServerUIConfig).
            const sliderVal = autoContrastSlider ? parseFloat(autoContrastSlider.value) : 10;
            this.config.autoContrast = isNaN(sliderVal) ? 10 : sliderVal;
        }

        // Restore minimum dynamic range setting.
        // Slider value 0 = Auto (disabled), positive values = minimum dB span.
        if (savedAutoMinSpan !== null) {
            const val = parseFloat(savedAutoMinSpan);
            this.config.autoMinSpan = val === 0 ? null : val;
            if (autoMinSpanSlider) autoMinSpanSlider.value = val;
            if (autoMinSpanValue)  autoMinSpanValue.textContent = val === 0 ? 'Auto' : `${val}`;
        } else {
            // No localStorage value — read the slider's current value which was already
            // set to the server default by ui-config.js (loadServerUIConfig).
            const sliderVal = autoMinSpanSlider ? parseFloat(autoMinSpanSlider.value) : 30;
            const def = isNaN(sliderVal) ? 30 : sliderVal;
            this.config.autoMinSpan = def === 0 ? null : def;
            if (autoMinSpanSlider) autoMinSpanSlider.value = def;
            if (autoMinSpanValue)  autoMinSpanValue.textContent = def === 0 ? 'Auto' : `${def}`;
        }

        if (manualRangeCheckbox) {
            manualRangeCheckbox.addEventListener('change', (e) => {
                this.config.manualRangeEnabled = e.target.checked;
                localStorage.setItem('spectrumManualRangeEnabled', e.target.checked.toString());

                syncRangeControlVisibility(e.target.checked);

                if (e.target.checked) {
                    // Clear auto-range history and clamp cache when switching to manual
                    this.autoRangeMinHistory = [];
                    this.autoRangeMaxHistory = [];
                    this._clampedMinDb = null;
                    this._clampedMaxDb = null;
                    this._lgClampedMinDb = null;
                    this._lgClampedMaxDb = null;
                    console.log(`Manual range enabled: ${this.config.manualMinDb} to ${this.config.manualMaxDb} dB`);
                } else {
                    // Clear clamp cache when switching back to auto so it recalculates fresh
                    this._clampedMinDb = null;
                    this._clampedMaxDb = null;
                    this._lgClampedMinDb = null;
                    this._lgClampedMaxDb = null;
                    console.log('Auto-range enabled');
                }
            });
        }

        const MIN_DB_GAP = 10; // minimum dB separation between min and max sliders

        if (minDbSlider && minDbValue) {
            minDbSlider.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                // Clamp so min stays at least MIN_DB_GAP below max
                const maxAllowed = this.config.manualMaxDb - MIN_DB_GAP;
                if (value > maxAllowed) {
                    value = maxAllowed;
                    e.target.value = value;
                }
                this.config.manualMinDb = value;
                minDbValue.textContent = value.toFixed(0);
                localStorage.setItem('spectrumManualMinDb', value.toString());
            });
        }

        if (maxDbSlider && maxDbValue) {
            maxDbSlider.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                // Clamp so max stays at least MIN_DB_GAP above min
                const minAllowed = this.config.manualMinDb + MIN_DB_GAP;
                if (value < minAllowed) {
                    value = minAllowed;
                    e.target.value = value;
                }
                this.config.manualMaxDb = value;
                maxDbValue.textContent = value.toFixed(0);
                localStorage.setItem('spectrumManualMaxDb', value.toString());
            });
        }

        if (autoContrastSlider && autoContrastValue) {
            autoContrastSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.config.autoContrast = value;
                autoContrastValue.textContent = value.toFixed(0);
                localStorage.setItem('spectrumAutoContrast', value.toString());
            });
        }

        if (autoMinSpanSlider && autoMinSpanValue) {
            autoMinSpanSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.config.autoMinSpan = value === 0 ? null : value;
                autoMinSpanValue.textContent = value === 0 ? 'Auto' : `${value}`;
                localStorage.setItem('spectrumAutoMinSpan', value.toString());
            });
        }

        // Right-click on Min Span slider → reset to server default (falls back to 30 dB)
        if (autoMinSpanSlider && autoMinSpanValue) {
            autoMinSpanSlider.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const def = (window.serverUIConfig && window.serverUIConfig.min_span != null)
                    ? window.serverUIConfig.min_span : 30;
                this.config.autoMinSpan = def === 0 ? null : def;
                autoMinSpanSlider.value = def;
                autoMinSpanValue.textContent = def === 0 ? 'Auto' : `${def}`;
                localStorage.setItem('spectrumAutoMinSpan', def.toString());
            });
        }

        // Right-click on Contrast slider → reset to server default (falls back to 10)
        if (autoContrastSlider && autoContrastValue) {
            autoContrastSlider.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const def = (window.serverUIConfig && window.serverUIConfig.contrast != null)
                    ? window.serverUIConfig.contrast : 10;
                this.config.autoContrast = def;
                autoContrastSlider.value = def;
                autoContrastValue.textContent = def;
                localStorage.setItem('spectrumAutoContrast', def.toString());
            });
        }

        // Right-click on Min label → reset to default (-120)
        const minDbLabel = document.getElementById('spectrum-min-db-label');
        if (minDbLabel && minDbSlider && minDbValue) {
            minDbLabel.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const def = -120;
                this.config.manualMinDb = def;
                minDbSlider.value = def;
                minDbValue.textContent = def;
                localStorage.setItem('spectrumManualMinDb', def.toString());
            });
        }

        // Right-click on Max label → reset to default (-40)
        const maxDbLabel = document.getElementById('spectrum-max-db-label');
        if (maxDbLabel && maxDbSlider && maxDbValue) {
            maxDbLabel.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const def = -40;
                this.config.manualMaxDb = def;
                maxDbSlider.value = def;
                maxDbValue.textContent = def;
                localStorage.setItem('spectrumManualMaxDb', def.toString());
            });
        }

        // Store reference to snap checkbox and label for mode-based enable/disable
        this.snapCheckbox = snapCheckbox;
        this.snapLabel = document.getElementById('spectrum-snap-label');

        // Add wheel event listener to both main canvas and line graph canvas
        const handleWheel = (e) => {
            if (!this.scrollEnabled && !this.zoomScrollEnabled) return;
            if (!this.spectrumData) return;

            e.preventDefault();

            // ── Normalise wheel delta across all device types ──────────────────
            // deltaMode 0 = pixels (trackpad / high-res mouse), 1 = lines, 2 = pages.
            // Accumulate until ≥ WHEEL_STEP_PX pixels have been scrolled, then act
            // once.  A standard mouse click (~100–120 px) always clears the threshold
            // immediately; a trackpad swipe accumulates across many small events.
            // Reset to 0 (not remainder) to avoid "scroll debt" after fast swipes.
            const WHEEL_STEP_PX = 50;
            let normalizedDelta = e.deltaY;
            if (e.deltaMode === 1) normalizedDelta *= 16;   // lines → pixels
            if (e.deltaMode === 2) normalizedDelta *= 400;  // pages → pixels
            wheelAccumulator += normalizedDelta;
            if (Math.abs(wheelAccumulator) < WHEEL_STEP_PX) return;
            const wheelDirection = wheelAccumulator < 0 ? -1 : 1; // -1 = up/in
            wheelAccumulator = 0;
            // ── End normalisation ──────────────────────────────────────────────

            const now = Date.now();

            // Get throttle delay from global configuration (set by dropdown in app.js)
            // Optimized for 40 cmd/sec rate limit - default 25ms (40 updates/sec)
            const SCROLL_THROTTLE_MS = window.frequencyScrollDelay || 25;

            // Throttle scroll events to prevent rate limiting
            const timeSinceLastScroll = now - lastScrollTime;
            if (timeSinceLastScroll < SCROLL_THROTTLE_MS) {
                return; // Ignore this scroll event
            }
            lastScrollTime = now;

            // Check if Ctrl or Shift is pressed to reverse behavior
            const reverseMode = e.ctrlKey || e.shiftKey;

            // Determine which mode to use based on checkbox and modifier keys
            const useZoomMode = reverseMode ? this.scrollEnabled : this.zoomScrollEnabled;
            const useScrollMode = reverseMode ? this.zoomScrollEnabled : this.scrollEnabled;

            if (useZoomMode) {
                // Zoom mode: scroll up = zoom in, scroll down = zoom out
                if (wheelDirection < 0) {
                    this.zoomIn();
                } else {
                    this.zoomOut();
                }
            } else if (useScrollMode) {
                // Perform initial zoom on first scroll if at default zoom level
                // Use aggressive zoom similar to band buttons (zoom to show ~10 kHz view)
                if (!this.hasPerformedInitialZoom && this.zoomLevel === 1) {
                    this.hasPerformedInitialZoom = true;

                    // Calculate aggressive zoom similar to band buttons
                    // Target a focused bandwidth of ~10 kHz for good detail
                    const focusedBandwidth = 10000; // 10 kHz
                    const binCount = this.binCount || 2048;
                    const binBandwidth = focusedBandwidth / binCount;

                    // Send zoom message directly to WebSocket
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            type: 'zoom',
                            frequency: Math.round(this.centerFreq),
                            binBandwidth: binBandwidth
                        }));
                        console.log(`Initial zoom performed: ${(focusedBandwidth/1e6).toFixed(3)} MHz view (${binBandwidth.toFixed(1)} Hz/bin)`);
                    }
                }

                // Frequency scroll mode - use configured step and delay from dropdown
                const freqInput = document.getElementById('frequency');
                if (!freqInput) return;

                // Get current frequency from data-hz-value attribute
                const currentFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
                if (isNaN(currentFreq)) return;

                // Get step size from global configuration (set by dropdown in app.js)
                const step = window.frequencyScrollStep || 100; // Default to 100 Hz if not set
                const delay = window.frequencyScrollDelay || 100; // Default to 100ms if not set

                console.log(`Scroll: wheelDirection=${wheelDirection}, step=${step}Hz, delay=${delay}ms`);

                // Scroll up = increase frequency, scroll down = decrease frequency
                const delta = wheelDirection < 0 ? step : -step;
                let newFreq = currentFreq + delta;

                // Round to nearest step size for clean values
                newFreq = Math.round(newFreq / step) * step;

                // Clamp to valid range (10 kHz to 30 MHz)
                const MIN_FREQ = 10000;
                const MAX_FREQ = 30000000;
                newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newFreq));
                
                // Update frequency input
                if (window.setFrequencyInputValue) {
                    window.setFrequencyInputValue(newFreq);
                } else {
                    freqInput.value = newFreq;
                }
                
                // Update band buttons if function exists
                if (typeof window.updateBandButtons === 'function') {
                    window.updateBandButtons(newFreq);
                }
                
                // Update URL if function exists
                if (typeof window.updateURL === 'function') {
                    window.updateURL();
                }

                // Notify extensions of frequency change
                if (window.radioAPI) {
                    window.radioAPI.notifyFrequencyChange(newFreq);
                }

                // Announce frequency change for accessibility (TTS)
                if (window.ttsAnnouncements && window.ttsAnnouncements.isEnabled()) {
                    window.ttsAnnouncements.announceFrequencyChange(newFreq);
                }
                
                // Trigger tune
                if (typeof window.autoTune === 'function') {
                    window.autoTune();
                }
            }
        };
        
        // Add wheel listener to main canvas
        this.canvas.addEventListener('wheel', handleWheel, { passive: false });
        
        // Add wheel listener to line graph canvas if it exists
        if (this.lineGraphCanvas) {
            this.lineGraphCanvas.addEventListener('wheel', handleWheel, { passive: false });
        }
    }

    // Update cursor style based on whether dragging is allowed
    updateCursorStyle() {
        if (!this.canvas || !this.totalBandwidth) return;

        // Check if we're showing full bandwidth (0-30 MHz)
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;
        const isFullBandwidth = (startFreq <= 0 && endFreq >= 30e6);

        // Set cursor based on whether dragging is allowed
        this.canvas.style.cursor = 'default';
    }

    // Update tooltip content and position
    updateTooltip() {
        if (!this.spectrumData || this.mouseX < 0 || this.mouseY < 0) {
            this.hideTooltip();
            return;
        }

        // Check if mouse is over a bookmark (bookmarks are in overlay canvas at top, height 45px)
        if (window.bookmarkPositions && window.bookmarkPositions.length > 0 && this.mouseY <= 45) {
            for (let pos of window.bookmarkPositions) {
                // Check if mouse is within bookmark bounds (x position only, y is already checked)
                if (this.mouseX >= pos.x - pos.width / 2 &&
                    this.mouseX <= pos.x + pos.width / 2) {

                    // Show bookmark info
                    const freqStr = this.formatFrequency(pos.bookmark.frequency);
                    const modeStr = pos.bookmark.mode ? pos.bookmark.mode.toUpperCase() : 'N/A';
                    let tooltipText = `${pos.bookmark.name}: ${freqStr} ${modeStr}`;
                    if (pos.bookmark.comment) {
                        tooltipText += `\n${pos.bookmark.comment}`;
                    }
                    if (pos.bookmark.extension) {
                        // Get display name from decoder manager if available
                        const displayName = window.decoderManager ?
                            window.decoderManager.getDisplayName(pos.bookmark.extension) :
                            pos.bookmark.extension;
                        tooltipText += `\nExtension: ${displayName}`;
                    }
                    this.tooltip.textContent = tooltipText;

                    // Position tooltip near cursor (flips left near the right edge)
                    const rect = this.canvas.getBoundingClientRect();
                    this.tooltip.style.display = 'block';
                    this._positionTooltipNearCursor(rect.left + this.mouseX, rect.top + this.mouseY);
                    return;
                }
            }
        }

        const binIndex = Math.floor((this.mouseX / this.width) * this.spectrumData.length);
        if (binIndex < 0 || binIndex >= this.spectrumData.length) {
            this.hideTooltip();
            return;
        }

        const db = this.spectrumData[binIndex];
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const freq = startFreq + (this.mouseX / this.width) * this.totalBandwidth;

        // Find strongest signal in spectrum
        let maxDb = -Infinity;
        let maxBinIndex = 0;
        for (let i = 0; i < this.spectrumData.length; i++) {
            if (this.spectrumData[i] > maxDb) {
                maxDb = this.spectrumData[i];
                maxBinIndex = i;
            }
        }

        // Calculate frequency of strongest signal
        const maxFreq = startFreq + (maxBinIndex / this.spectrumData.length) * this.totalBandwidth;

        // Update tooltip content with cursor position and strongest signal (use innerHTML for line breaks)
        this.tooltip.innerHTML = `Cursor: ${this.formatFrequency(freq)} | ${db.toFixed(1)} dB<br>Peak: ${this.formatFrequency(maxFreq)} | ${maxDb.toFixed(1)} dB`;

        // Position tooltip near cursor (flips left near the right edge)
        const rect = this.canvas.getBoundingClientRect();
        this.tooltip.style.display = 'block';
        this._positionTooltipNearCursor(rect.left + this.mouseX, rect.top + this.mouseY);
    }

    // Position the tooltip relative to a cursor point (viewport coordinates).
    // The tooltip is position:fixed, so it normally sits 15px to the right of the
    // cursor. If that would push it off the right edge of the viewport, flip it to
    // the left of the cursor instead so it stays fully readable. The tooltip must
    // already be display:block with its content set so offsetWidth is accurate.
    _positionTooltipNearCursor(clientX, clientY) {
        if (!this.tooltip) return;
        const margin = 15;
        const tw = this.tooltip.offsetWidth;
        let left = clientX + margin;
        // Flip to the left of the cursor if it would overflow the right edge
        if (left + tw > window.innerWidth - 5) {
            left = clientX - tw - margin;
        }
        // Never let it run off the left edge either
        if (left < 5) left = 5;
        this.tooltip.style.left = left + 'px';
        this.tooltip.style.top = (clientY - 10) + 'px';
    }

    // Hide tooltip
    hideTooltip() {
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
        // Reset cached callsign so the next hover over the same spot re-renders
        // correctly (the tooltip was hidden, so it needs a fresh innerHTML write).
        this._tooltipCallsign = null;
    }

    // Update configuration
    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
        if (newConfig.colorScheme) {
            this.colorGradient = this.createColorGradient();
        }
        // Update tuned frequency if provided
        if (newConfig.tunedFreq !== undefined) {
            const oldTunedFreq = this.currentTunedFreq;
            this.currentTunedFreq = newConfig.tunedFreq;

            // NOTE: invalidateMarkerCache() on every tune event was removed (Fix 4).
            // drawChatUserMarkers() already checks this.currentTunedFreq at draw time
            // (line ~3143) so the cache does not need to be rebuilt on frequency changes.

            // If we're zoomed in and frequency changed, pan to follow it
            // Only pan if we have a valid zoom level and the frequency actually changed
            // Skip panning if the frequency change came from clicking the waterfall
            // ALSO skip panning if Edge Tune is disabled (user wants to scroll freely)
            if (this.binBandwidth && this.initialBinBandwidth &&
                this.binBandwidth < this.initialBinBandwidth &&
                oldTunedFreq !== this.currentTunedFreq &&
                !this.skipNextPan &&
                this.edgeTuneEnabled) {


                // Set flag to prevent sync monitoring from interfering during pan
                this.skipNextPan = true;

                this.panTo(this.currentTunedFreq);

                // Clear the flag after a delay to allow spectrum to update
                // 500ms should be enough for the server to respond and update the display
                setTimeout(() => {
                    this.skipNextPan = false;
                }, 500);
            } else if (this.skipNextPan) {
                // If skipNextPan was set (e.g., from clicking waterfall), clear it after a delay
                setTimeout(() => {
                    this.skipNextPan = false;
                }, 500);
            }
        }
        // Update bandwidth edges if provided
        if (newConfig.bandwidthLow !== undefined) {
            this.currentBandwidthLow = newConfig.bandwidthLow;
        }
        if (newConfig.bandwidthHigh !== undefined) {
            this.currentBandwidthHigh = newConfig.bandwidthHigh;
        }
        // Redraw to show cursor and bandwidth indicator
        if (this.spectrumData && this.spectrumData.length > 0) {
            this.draw();
        }
    }

    // Zoom in - same bins over narrower bandwidth (decrease bin bandwidth)
    // Backend now handles dynamic bin count adjustment for deep zoom levels
    zoomIn() {
        if (!this.connected || !this.ws) return;

        // Suppress edge detection during zoom transition to prevent
        // unwanted retuning when tuned near 0 or 30 MHz edges
        this.skipEdgeDetectionTemporary = true;
        setTimeout(() => { this.skipEdgeDetectionTemporary = false; }, 1000);

        // Halve the bin bandwidth = half the total bandwidth = 2x zoom
        const newBinBandwidth = this.binBandwidth / 2;

        // Minimum practical limit: 10 Hz/bin hard floor for normal UI operation.
        // The server supports down to 0.5 Hz/bin but that level is only reachable
        // via explicit requests (URL params, chat sync) — not via the +/scroll/Max
        // button path.  The Max button sends binBandwidth=10 directly; the + button
        // halves the current value and stops here.
        if (newBinBandwidth < 10) {
            console.log('Maximum zoom reached (10 Hz/bin hard floor)');
            return;
        }

        // Center on current tuned frequency, or spectrum center if not tuned
        let newCenterFreq = this.currentTunedFreq || this.centerFreq;

        // Calculate new total bandwidth
        const newTotalBW = newBinBandwidth * this.binCount;
        const halfBandwidth = newTotalBW / 2;

        // Constrain center frequency to keep view within 0-30 MHz
        const minCenterFreq = 0 + halfBandwidth;
        const maxCenterFreq = 30e6 - halfBandwidth;
        newCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

        // Clear peak hold before zoom to prevent misalignment
        this.peakHoldData = null;

        // Send zoom request to server - backend handles bin_count adjustment automatically
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: Math.round(newCenterFreq),
            binBandwidth: newBinBandwidth
        }));

        // Optimistically update zoom slider immediately (corrected when config arrives)
        if (typeof window.updateZoomSlider === 'function') {
            if (typeof window.clearZoomSliderSource === 'function') window.clearZoomSliderSource();
            const _prev = this.binBandwidth;
            this.binBandwidth = newBinBandwidth;
            window.updateZoomSlider();
            this.binBandwidth = _prev;
        }

        // Notify radioAPI immediately
        if (window.radioAPI) {
            window.radioAPI.notifyZoomChange(newBinBandwidth);
        }
    }

    // Zoom out - same bins over wider bandwidth (increase bin bandwidth)
    zoomOut() {
        if (!this.connected || !this.ws) return;

        // Suppress edge detection during zoom transition to prevent
        // unwanted retuning when tuned near 0 or 30 MHz edges
        this.skipEdgeDetectionTemporary = true;
        setTimeout(() => { this.skipEdgeDetectionTemporary = false; }, 1000);

        // Don't zoom out past initial bandwidth
        if (!this.initialBinBandwidth) {
            this.initialBinBandwidth = this.binBandwidth;
        }

        // Double the bin bandwidth = double the total bandwidth = 0.5x zoom
        let newBinBandwidth = this.binBandwidth * 2;

        // Clamp to initial bandwidth (don't zoom out past full view) — send reset
        if (newBinBandwidth >= this.initialBinBandwidth) {
            console.log('Zoom out reached full bandwidth — sending reset');
            this.resetZoom();
            // Optimistically move slider to 0
            if (typeof window.updateZoomSlider === 'function') {
                if (typeof window.clearZoomSliderSource === 'function') window.clearZoomSliderSource();
                const _prev = this.binBandwidth;
                this.binBandwidth = this.initialBinBandwidth;
                window.updateZoomSlider();
                this.binBandwidth = _prev;
            }
            return;
        }

        // Center on current tuned frequency, or spectrum center if not tuned
        let newCenterFreq = this.currentTunedFreq || this.centerFreq;

        // Calculate new total bandwidth
        const newTotalBW = newBinBandwidth * this.binCount;
        const halfBandwidth = newTotalBW / 2;

        // Constrain center frequency to keep view within 0-30 MHz
        const minCenterFreq = 0 + halfBandwidth;
        const maxCenterFreq = 30e6 - halfBandwidth;
        newCenterFreq = Math.max(minCenterFreq, Math.min(maxCenterFreq, newCenterFreq));

        // Clear peak hold before zoom to prevent misalignment
        this.peakHoldData = null;

        // Send zoom request to server
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: Math.round(newCenterFreq),
            binBandwidth: newBinBandwidth
        }));

        // Optimistically update zoom slider immediately (corrected when config arrives)
        if (typeof window.updateZoomSlider === 'function') {
            if (typeof window.clearZoomSliderSource === 'function') window.clearZoomSliderSource();
            const _prev = this.binBandwidth;
            this.binBandwidth = newBinBandwidth;
            window.updateZoomSlider();
            this.binBandwidth = _prev;
        }

        // Notify radioAPI immediately
        if (window.radioAPI) {
            window.radioAPI.notifyZoomChange(newBinBandwidth);
        }
    }

    // Reset zoom to full view (0-30 MHz)
    resetZoom() {
        if (!this.connected || !this.ws) return;

        console.log(`Reset zoom to full bandwidth view`);

        // Clear peak hold before reset to prevent misalignment
        this.peakHoldData = null;

        // Reset initial zoom flag so it will zoom in again on next scroll
        this.hasPerformedInitialZoom = false;

        // Clear stale zoom/pan records so sendSettingsSync() doesn't re-apply
        // the previous zoom level ~1 second after the reset. Without this,
        // every path that reaches full bandwidth (scroll wheel, zoom-out button,
        // Min button, Q key, slider at 0, mobile slider) snaps back one zoom
        // level because the 1s periodic sync re-sends the last recorded zoom msg.
        if (this._lastSentByType) {
            delete this._lastSentByType['zoom'];
            delete this._lastSentByType['pan'];
        }

        // Send reset request to server - backend will use default config values
        this.ws.send(JSON.stringify({
            type: 'reset'
        }));
    }

    // Pan to a new center frequency (keeping current zoom level)
    panTo(frequency) {
        if (!this.connected || !this.ws) return;

        // CRITICAL: Do NOT send binBandwidth when panning!
        // The backend's zoom-out restoration logic at user_spectrum_websocket.go:155-163
        // will trigger if binBandwidth > 200 AND binCount < default, causing unwanted zoom out.
        // By not sending binBandwidth, the backend keeps the current value unchanged.
        //
        // ALSO CRITICAL: Round frequency to integer!
        // The backend expects uint64, but JavaScript sends floating point from pixel calculations.
        // Sending a float causes JSON parsing error and closes the WebSocket.
        const panMsg = {
            type: 'pan',
            frequency: Math.round(frequency)  // Must be integer for Go's uint64
            // Deliberately NOT sending binBandwidth to avoid triggering zoom-out logic
        };
        this.ws.send(JSON.stringify(panMsg));
    }

    // Request a frame-rate divisor from the server.
    // divisor=1 (or 0) restores full rate; divisor=2 sends every other frame, etc.
    // Safe to call at any time — silently ignored if the WebSocket is not open.
    setRate(divisor) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const d = (divisor >= 1) ? Math.floor(divisor) : 1;
        this.ws.send(JSON.stringify({ type: 'set_rate', divisor: d }));
    }

    // Update bit rate display
    updateBitrateDisplay() {
        const bitrateElement = document.getElementById('spectrum-bitrate');
        if (bitrateElement) {
            if (this.currentBitrate > 0) {
                bitrateElement.textContent = `${this.currentBitrate.toFixed(1)} KB/s`;
                // Color code based on bandwidth usage
                if (this.currentBitrate < 50) {
                    bitrateElement.style.color = '#4CAF50'; // Green - good
                } else if (this.currentBitrate < 100) {
                    bitrateElement.style.color = '#FFA500'; // Orange - moderate
                } else {
                    bitrateElement.style.color = '#FF5722'; // Red - high
                }
            } else {
                bitrateElement.textContent = '-- KB/s';
                bitrateElement.style.color = '#888';
            }
        }
    }

    // Update signal meter based on peak (highest) dB in tuned bandwidth
    updateSignalMeter() {
        if (this.signalMeter) {
            this.signalMeter.update(
                this.spectrumData,
                this.currentTunedFreq,
                this.currentBandwidthLow,
                this.currentBandwidthHigh,
                this.centerFreq,
                this.totalBandwidth
            );
        }
    }

    // Resolve the current bandwidth indicator colour as an rgba() string.
    // `alpha` controls opacity (0–1).
    getBandwidthIndicatorColor(alpha) {
        const map = {
            green:   `rgba(0, 255, 0, ${alpha})`,
            red:     `rgba(255, 0, 0, ${alpha})`,
            cyan:    `rgba(0, 255, 255, ${alpha})`,
            white:   `rgba(255, 255, 255, ${alpha})`,
            yellow:  `rgba(255, 255, 0, ${alpha})`,
            orange:  `rgba(255, 165, 0, ${alpha})`,
            magenta: `rgba(255, 0, 255, ${alpha})`,
        };
        return map[this.bandwidthIndicatorColor] || map.green;
    }

    // Show a colour-picker context menu for the bandwidth indicator bar.
    // Called when the user right-clicks on the bar in the overlay canvas.
    showBandwidthColorMenu(clientX, clientY) {
        const colours = [
            { name: 'Green (default)', key: 'green',   rgb: '#00ff00' },
            { name: 'Red',             key: 'red',     rgb: '#ff0000' },
            { name: 'Cyan',            key: 'cyan',    rgb: '#00ffff' },
            { name: 'White',           key: 'white',   rgb: '#ffffff' },
            { name: 'Yellow',          key: 'yellow',  rgb: '#ffff00' },
            { name: 'Orange',          key: 'orange',  rgb: '#ffa500' },
            { name: 'Magenta',         key: 'magenta', rgb: '#ff00ff' },
        ];

        this.contextMenu.innerHTML = '';

        // Header label
        const header = document.createElement('div');
        header.style.padding = '6px 16px 4px';
        header.style.fontFamily = "ui-monospace, 'Courier New', monospace";
        header.style.fontSize = '11px';
        header.style.color = '#888';
        header.style.borderBottom = '1px solid #eee';
        header.textContent = 'Bandwidth indicator colour';
        this.contextMenu.appendChild(header);

        colours.forEach(({ name, key, rgb }) => {
            const item = document.createElement('div');
            item.style.padding = '7px 16px';
            item.style.cursor = 'pointer';
            item.style.fontFamily = "ui-monospace, 'Courier New', monospace";
            item.style.fontSize = '13px';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '10px';

            // Colour swatch
            const swatch = document.createElement('span');
            swatch.style.display = 'inline-block';
            swatch.style.width = '14px';
            swatch.style.height = '14px';
            swatch.style.borderRadius = '2px';
            swatch.style.border = '1px solid #aaa';
            swatch.style.backgroundColor = rgb;
            swatch.style.flexShrink = '0';
            item.appendChild(swatch);

            // Label (bold if currently selected)
            const label = document.createElement('span');
            label.textContent = name;
            if (key === this.bandwidthIndicatorColor) {
                label.style.fontWeight = 'bold';
            }
            item.appendChild(label);

            item.addEventListener('mouseenter', () => {
                item.style.backgroundColor = '#007bff';
                item.style.color = '#fff';
                swatch.style.border = '1px solid #fff';
            });
            item.addEventListener('mouseleave', () => {
                item.style.backgroundColor = '';
                item.style.color = '';
                swatch.style.border = '1px solid #aaa';
            });

            item.addEventListener('click', () => {
                this.bandwidthIndicatorColor = key;
                localStorage.setItem('bandwidthIndicatorColor', key);
                this.contextMenu.style.display = 'none';
                // Invalidate cursor cache so the new colour renders immediately.
                // Without this, drawTunedFrequencyCursor() reuses the cached bitmap
                // (none of the five cache-key values changed) and the old colour persists
                // until the next zoom or frequency change busts the cache naturally.
                this.cursorCache = null;
                this.lastCursorTunedFreq = null;
                // Force redraw so the new colour is visible immediately
                if (this.spectrumData && this.spectrumData.length > 0) {
                    this.draw();
                }
            });

            this.contextMenu.appendChild(item);
        });

        // Position and show
        this.contextMenu.style.left = clientX + 'px';
        this.contextMenu.style.top = clientY + 'px';
        this.contextMenu.style.display = 'block';
    }

    // Create custom context menu element
    createContextMenu() {
            this.contextMenu = document.createElement('div');
            this.contextMenu.style.position = 'fixed';
            this.contextMenu.style.backgroundColor = '#fff';
            this.contextMenu.style.border = '1px solid #ccc';
            this.contextMenu.style.borderRadius = '4px';
            this.contextMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
            this.contextMenu.style.padding = '4px 0';
            this.contextMenu.style.zIndex = '10001';
            this.contextMenu.style.display = 'none';
            this.contextMenu.style.minWidth = '200px';
            document.body.appendChild(this.contextMenu);

            // Hide context menu when clicking elsewhere
            document.addEventListener('click', () => {
                this.contextMenu.style.display = 'none';
            });
    }

    // Handle context menu (right-click)
    handleContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();

        if (!this.totalBandwidth || !this.centerFreq) {
            return;
        }

        const rect = e.target.getBoundingClientRect();
        const x = e.clientX - rect.left;

        // Frequency range (used by carrier detector)
        const startFreq = this.centerFreq - this.totalBandwidth / 2;

        // Current dial frequency — used by "Add DX Spot" so the spot lands exactly
        // where the user is tuned, not where the cursor happens to be.
        const dialFreq = window.getCurrentDialFrequency
            ? window.getCurrentDialFrequency()
            : (this.currentTunedFreq || Math.round(startFreq + (x / this.width) * this.totalBandwidth));

        // Build menu
        this.contextMenu.innerHTML = '';

        // ── "Center Carrier / Edge" item — only for AM/SAM/USB/LSB ──────────
        const currentMode = window.currentMode ? window.currentMode.toLowerCase() : '';
        const carrierModes = ['am', 'sam', 'usb', 'lsb'];
        if (carrierModes.includes(currentMode) && this.spectrumData && this.currentTunedFreq) {
            // Initialize carrier detector if not already done
            if (!this.carrierDetector) {
                this.carrierDetector = new CarrierDetector();
            }

            const result = this.carrierDetector.detectCarrier(
                currentMode,
                this.spectrumData,
                this.currentTunedFreq,
                this.currentBandwidthLow,
                this.currentBandwidthHigh,
                startFreq,
                this.totalBandwidth
            );

            if (result) {
                const offset = result.frequency - this.currentTunedFreq;
                const currentDialFreq = window.getCurrentDialFrequency
                    ? window.getCurrentDialFrequency() : this.currentTunedFreq;
                let newDialFreq = Math.round(currentDialFreq + offset);

                if (currentMode === 'lsb') {
                    newDialFreq = Math.round((newDialFreq + 200) / 1000) * 1000;
                } else if (currentMode === 'usb') {
                    newDialFreq = Math.round((newDialFreq - 200) / 1000) * 1000;
                }

                const menuText = (currentMode === 'am' || currentMode === 'sam')
                    ? `Center Carrier at ${this.formatFrequency(newDialFreq)}`
                    : `Center ${currentMode.toUpperCase()} Edge at ${this.formatFrequency(newDialFreq)}`;

                const carrierItem = this._makeContextMenuItem(menuText, () => {
                    this.centerCarrier(newDialFreq);
                });
                this.contextMenu.appendChild(carrierItem);
            }
        }

        // ── "Add DX Spot" item — only when DX cluster extension is active ───
        if (window.dxClusterExtensionInstance &&
            typeof window.dxClusterExtensionInstance.addLocalSpot === 'function') {
            const freqLabel = this.formatFrequency(dialFreq);
            const dxItem = this._makeContextMenuItem(`📍 Add DX Spot at ${freqLabel}`, () => {
                this._showAddLocalSpotModal(dialFreq, freqLabel);
            });
            this.contextMenu.appendChild(dxItem);
        }

        // ── "Add Bookmark" item — only when local bookmarks system is active ──
        if (window.localBookmarksUI && window.localBookmarksUI.manager) {
            const bmFreqLabel = this.formatFrequency(dialFreq);
            const bmItem = this._makeContextMenuItem(`⭐ Add Bookmark at ${bmFreqLabel}`, () => {
                this._showAddLocalBookmarkModal(
                    dialFreq,
                    bmFreqLabel,
                    currentMode,
                    window.currentBandwidthLow,
                    window.currentBandwidthHigh
                );
            });
            this.contextMenu.appendChild(bmItem);
        }

        // Don't show an empty menu
        if (this.contextMenu.children.length === 0) {
            return;
        }

        // Position and show
        this.contextMenu.style.left = e.clientX + 'px';
        this.contextMenu.style.top = e.clientY + 'px';
        this.contextMenu.style.display = 'block';
    }

    // Helper: create a styled context menu item div
    _makeContextMenuItem(text, onClick) {
        const item = document.createElement('div');
        item.style.padding = '8px 16px';
        item.style.cursor = 'pointer';
        item.style.fontFamily = "ui-monospace, 'Courier New', monospace";
        item.style.fontSize = '13px';
        item.textContent = text;
        item.addEventListener('mouseenter', () => {
            item.style.backgroundColor = '#007bff';
            item.style.color = '#fff';
        });
        item.addEventListener('mouseleave', () => {
            item.style.backgroundColor = '';
            item.style.color = '';
        });
        item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.contextMenu.style.display = 'none';
            onClick();
        });
        return item;
    }

    // Show a simple modal asking the user for a callsign/label, then inject a
    // local DX spot via window.dxClusterExtensionInstance.addLocalSpot().
    _showAddLocalSpotModal(freqHz, freqLabel) {
        // Remove any stale modal
        const existing = document.getElementById('_local-spot-modal');
        if (existing) existing.remove();

        // ── Backdrop ──────────────────────────────────────────────────────
        const backdrop = document.createElement('div');
        backdrop.id = '_local-spot-modal';
        Object.assign(backdrop.style, {
            position:        'fixed',
            inset:           '0',
            zIndex:          '20000',
            background:      'rgba(0,0,0,0.55)',
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'center',
        });

        // ── Dialog box ────────────────────────────────────────────────────
        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
            background:   '#1e2a38',
            border:       '1px solid rgba(127,140,141,0.5)',
            borderRadius: '8px',
            padding:      '20px 24px',
            boxShadow:    '0 8px 32px rgba(0,0,0,0.7)',
            minWidth:     '300px',
            maxWidth:     '380px',
            fontFamily:   'inherit',
            color:        '#ecf0f1',
        });

        // Title
        const title = document.createElement('div');
        title.textContent = '📍 Add Local DX Spot';
        Object.assign(title.style, {
            fontSize:     '14px',
            fontWeight:   '600',
            marginBottom: '4px',
        });

        // Frequency sub-label
        const freqSub = document.createElement('div');
        freqSub.textContent = freqLabel;
        Object.assign(freqSub.style, {
            fontSize:     '12px',
            color:        '#95a5a6',
            marginBottom: '14px',
            fontFamily:   "ui-monospace, 'Courier New', monospace",
        });

        // Label
        const label = document.createElement('label');
        label.textContent = 'Callsign / Label';
        Object.assign(label.style, {
            display:      'block',
            fontSize:     '11px',
            color:        '#95a5a6',
            marginBottom: '5px',
            textTransform:'uppercase',
            letterSpacing:'0.06em',
        });

        // Input
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'e.g. G0ABC';
        input.maxLength = 20;
        Object.assign(input.style, {
            width:        '100%',
            boxSizing:    'border-box',
            background:   '#0d1b2a',
            border:       '1px solid rgba(127,140,141,0.4)',
            borderRadius: '4px',
            color:        '#ecf0f1',
            fontSize:     '14px',
            fontFamily:   "ui-monospace, 'Courier New', monospace",
            padding:      '7px 10px',
            marginBottom: '16px',
            outline:      'none',
        });

        // Button row
        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display:        'flex',
            justifyContent: 'flex-end',
            gap:            '8px',
        });

        const makeBtn = (text, primary) => {
            const btn = document.createElement('button');
            btn.textContent = text;
            btn.type = 'button';
            Object.assign(btn.style, {
                padding:      '6px 16px',
                borderRadius: '4px',
                border:       primary ? 'none' : '1px solid rgba(127,140,141,0.4)',
                background:   primary ? '#e67e00' : 'transparent',
                color:        '#ecf0f1',
                fontSize:     '13px',
                cursor:       'pointer',
                fontFamily:   'inherit',
            });
            return btn;
        };

        const cancelBtn = makeBtn('Cancel', false);
        const addBtn    = makeBtn('Add Spot', true);

        const close = () => backdrop.remove();

        const confirm = () => {
            const raw = input.value.trim().toUpperCase();
            if (!raw) {
                input.style.borderColor = '#e74c3c';
                input.focus();
                return;
            }
            close();
            if (window.dxClusterExtensionInstance &&
                typeof window.dxClusterExtensionInstance.addLocalSpot === 'function') {
                window.dxClusterExtensionInstance.addLocalSpot(freqHz, raw);
            } else {
                console.warn('Add DX Spot: dxClusterExtensionInstance not available');
            }
        };

        cancelBtn.addEventListener('click', close);
        addBtn.addEventListener('click', confirm);

        // Force uppercase as the user types
        input.addEventListener('input', () => {
            const sel = input.selectionStart;
            input.value = input.value.toUpperCase();
            input.setSelectionRange(sel, sel);
        });

        // Keyboard: Enter = confirm, Escape = cancel
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); confirm(); }
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
        });

        // Click outside dialog = cancel
        backdrop.addEventListener('click', (ev) => {
            if (ev.target === backdrop) close();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(addBtn);
        dialog.appendChild(title);
        dialog.appendChild(freqSub);
        dialog.appendChild(label);
        dialog.appendChild(input);
        dialog.appendChild(btnRow);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        // Auto-focus the input after the modal is in the DOM
        requestAnimationFrame(() => input.focus());
    }

    // Show a quick modal asking only for a name, then save a local bookmark with
    // all current radio state (freq, mode, bandwidth) captured at right-click time.
    _showAddLocalBookmarkModal(freqHz, freqLabel, mode, bwLow, bwHigh) {
        // Remove any stale modal
        const existing = document.getElementById('_local-bookmark-quick-modal');
        if (existing) existing.remove();

        // ── Backdrop ──────────────────────────────────────────────────────
        const backdrop = document.createElement('div');
        backdrop.id = '_local-bookmark-quick-modal';
        Object.assign(backdrop.style, {
            position:       'fixed',
            inset:          '0',
            zIndex:         '20000',
            background:     'rgba(0,0,0,0.55)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
        });

        // ── Dialog box ────────────────────────────────────────────────────
        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
            background:   '#1e2a38',
            border:       '1px solid rgba(127,140,141,0.5)',
            borderRadius: '8px',
            padding:      '20px 24px',
            boxShadow:    '0 8px 32px rgba(0,0,0,0.7)',
            minWidth:     '300px',
            maxWidth:     '380px',
            fontFamily:   'inherit',
            color:        '#ecf0f1',
        });

        // Title
        const title = document.createElement('div');
        title.textContent = '⭐ Add Local Bookmark';
        Object.assign(title.style, {
            fontSize:     '14px',
            fontWeight:   '600',
            marginBottom: '4px',
        });

        // Frequency + mode sub-label
        const freqSub = document.createElement('div');
        const modeStr = mode ? mode.toUpperCase() : '';
        const bwStr = (typeof bwLow === 'number' && typeof bwHigh === 'number')
            ? `  BW: ${bwLow}/${bwHigh} Hz` : '';
        freqSub.textContent = `${freqLabel}${modeStr ? '  ' + modeStr : ''}${bwStr}`;
        Object.assign(freqSub.style, {
            fontSize:     '12px',
            color:        '#95a5a6',
            marginBottom: '14px',
            fontFamily:   "ui-monospace, 'Courier New', monospace",
        });

        // Label
        const label = document.createElement('label');
        label.textContent = 'Name / Callsign';
        Object.assign(label.style, {
            display:       'block',
            fontSize:      '11px',
            color:         '#95a5a6',
            marginBottom:  '5px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
        });

        // Error message element (hidden until needed)
        const errorMsg = document.createElement('div');
        Object.assign(errorMsg.style, {
            fontSize:     '11px',
            color:        '#e74c3c',
            marginBottom: '6px',
            display:      'none',
        });

        // Input
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'e.g. WWV 10 MHz';
        input.maxLength = 40;
        Object.assign(input.style, {
            width:        '100%',
            boxSizing:    'border-box',
            background:   '#0d1b2a',
            border:       '1px solid rgba(127,140,141,0.4)',
            borderRadius: '4px',
            color:        '#ecf0f1',
            fontSize:     '14px',
            fontFamily:   "ui-monospace, 'Courier New', monospace",
            padding:      '7px 10px',
            marginBottom: '16px',
            outline:      'none',
        });

        // Button row
        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display:        'flex',
            justifyContent: 'flex-end',
            gap:            '8px',
        });

        const makeBtn = (text, primary) => {
            const btn = document.createElement('button');
            btn.textContent = text;
            btn.type = 'button';
            Object.assign(btn.style, {
                padding:      '6px 16px',
                borderRadius: '4px',
                border:       primary ? 'none' : '1px solid rgba(127,140,141,0.4)',
                background:   primary ? '#27ae60' : 'transparent',
                color:        '#ecf0f1',
                fontSize:     '13px',
                cursor:       'pointer',
                fontFamily:   'inherit',
            });
            return btn;
        };

        const cancelBtn = makeBtn('Cancel', false);
        const addBtn    = makeBtn('Add Bookmark', true);

        const close = () => backdrop.remove();

        const confirm = async () => {
            const raw = input.value.trim();
            if (!raw) {
                input.style.borderColor = '#e74c3c';
                input.focus();
                return;
            }
            input.style.borderColor = 'rgba(127,140,141,0.4)';
            errorMsg.style.display = 'none';

            if (!window.localBookmarksUI || !window.localBookmarksUI.manager) {
                console.warn('Add Bookmark: localBookmarksUI not available');
                close();
                return;
            }

            try {
                await window.localBookmarksUI.manager.add({
                    name:           raw,
                    frequency:      freqHz,
                    mode:           mode ? mode.toLowerCase() : 'usb',
                    bandwidth_low:  typeof bwLow  === 'number' ? bwLow  : null,
                    bandwidth_high: typeof bwHigh === 'number' ? bwHigh : null,
                    group:          null,
                    comment:        null,
                    extension:      null,
                });
                close();
                // Refresh dropdown + invalidate spectrum marker cache → immediate redraw
                window.localBookmarksUI.updateMainDropdown();
            } catch (err) {
                // Most likely a duplicate-name error
                errorMsg.textContent = err.message || 'Could not save bookmark';
                errorMsg.style.display = 'block';
                input.style.borderColor = '#e74c3c';
                input.focus();
            }
        };

        cancelBtn.addEventListener('click', close);
        addBtn.addEventListener('click', confirm);

        // Keyboard: Enter = confirm, Escape = cancel
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); confirm(); }
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
        });

        // Click outside dialog = cancel
        backdrop.addEventListener('click', (ev) => {
            if (ev.target === backdrop) close();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(addBtn);
        dialog.appendChild(title);
        dialog.appendChild(freqSub);
        dialog.appendChild(label);
        dialog.appendChild(errorMsg);
        dialog.appendChild(input);
        dialog.appendChild(btnRow);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        // Auto-focus the input after the modal is in the DOM
        requestAnimationFrame(() => input.focus());
    }

    // Center carrier by adjusting dial frequency
    centerCarrier(newDialFreq) {
            // Update frequency input if available (correct ID is 'frequency', not 'frequency-input')
            const freqInput = document.getElementById('frequency');
            if (freqInput) {
                if (window.setFrequencyInputValue) {
                    window.setFrequencyInputValue(newDialFreq);
                } else {
                    freqInput.value = newDialFreq;
                }

                // Update band buttons
                if (typeof window.updateBandButtons === 'function') {
                    window.updateBandButtons(newDialFreq);
                }

                // Update URL
                if (typeof window.updateURL === 'function') {
                    window.updateURL();
                }
            }

            // Notify extensions of frequency change
            if (window.radioAPI) {
                window.radioAPI.notifyFrequencyChange(newDialFreq);
            }

            // Announce frequency change for accessibility (TTS)
            if (window.ttsAnnouncements && window.ttsAnnouncements.isEnabled()) {
                window.ttsAnnouncements.announceFrequencyChange(newDialFreq);
            }

            // Trigger tune via app.js function
            if (typeof window.autoTune === 'function') {
                window.autoTune();
            } else if (typeof window.tune === 'function') {
                window.tune();
            }

            // Show visual feedback
            this.showCenterCarrierFeedback();
    }

    // Show brief visual feedback when centering carrier
    showCenterCarrierFeedback() {
            const feedback = document.createElement('div');
            feedback.textContent = 'Carrier Centered';
            feedback.style.position = 'fixed';
            feedback.style.top = '50%';
            feedback.style.left = '50%';
            feedback.style.transform = 'translate(-50%, -50%)';
            feedback.style.backgroundColor = 'rgba(0, 123, 255, 0.9)';
            feedback.style.color = '#fff';
            feedback.style.padding = '12px 24px';
            feedback.style.borderRadius = '4px';
            feedback.style.fontSize = '16px';
            feedback.style.fontWeight = 'bold';
            feedback.style.zIndex = '10002';
            feedback.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
            document.body.appendChild(feedback);

            // Fade out and remove after 1 second
            setTimeout(() => {
                feedback.style.transition = 'opacity 0.5s';
                feedback.style.opacity = '0';
                setTimeout(() => {
                    document.body.removeChild(feedback);
                }, 500);
            }, 1000);
    }

    // Update snap checkbox state based on current mode
    updateSnapCheckboxState() {
        if (!this.snapCheckbox || !this.snapLabel) return;

        const currentMode = window.currentMode ? window.currentMode.toLowerCase() : '';
        const isSSBMode = currentMode === 'usb' || currentMode === 'lsb';

        // Enable/disable checkbox based on mode
        this.snapCheckbox.disabled = !isSSBMode;

        // Update label styling to show disabled state
        if (isSSBMode) {
            this.snapLabel.style.opacity = '1';
            this.snapLabel.style.cursor = 'pointer';
        } else {
            this.snapLabel.style.opacity = '0.5';
            this.snapLabel.style.cursor = 'not-allowed';
        }
    }

    // Get current status
    getStatus() {
        return {
            connected: this.connected,
            centerFreq: this.centerFreq,
            binCount: this.binCount,
            binBandwidth: this.binBandwidth,
            totalBandwidth: this.totalBandwidth,
            lastUpdate: this.lastUpdate,
            zoomLevel: this.zoomLevel,
            bitrate: this.currentBitrate
        };
    }

    // Start periodic sync monitoring to prevent audio/spectrum drift
    startSyncMonitoring() {
        // Use setInterval for regular checks
        this.syncMonitoringInterval = setInterval(() => {
            this.checkSync();
        }, this.syncCheckInterval);
        console.log(`Started sync monitoring (checking every ${this.syncCheckInterval}ms)`);
    }

    // Stop sync monitoring
    stopSyncMonitoring() {
        if (this.syncMonitoringInterval) {
            clearInterval(this.syncMonitoringInterval);
            this.syncMonitoringInterval = null;
            console.log('Stopped sync monitoring');
        }
    }

    // Check if spectrum display is in sync with audio frequency
    checkSync() {
        // Skip check if not connected or no data
        if (!this.connected || !this.spectrumData || !this.currentTunedFreq || !this.totalBandwidth) {
            return;
        }

        // CRITICAL FIX: Clear any lingering prediction offset when not dragging.
        // Must also respect _lineGraphDragActive — line-graph drags don't set
        // isDragging, and clearing the offset mid-drag fights the pan prediction.
        if (!this.isDragging && !this._lineGraphDragActive && this.predictedFreqOffset !== 0) {
            this.predictedFreqOffset = 0;
            // Redraw to apply correction immediately
            if (this.spectrumData && this.spectrumData.length > 0) {
                this.draw();
            }
            return;
        }

        // Skip check while actively dragging (prediction is intentionally offset)
        if (this.isDragging) {
            return;
        }

        // Skip check if we're waiting for a frequency change to settle
        if (this.skipNextPan) {
            return;
        }

        // Calculate where the tuned frequency marker should be displayed
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Check if marker is visible in current view
        const isVisible = this.currentTunedFreq >= startFreq && this.currentTunedFreq <= endFreq;

        if (!isVisible) {
            // Marker has drifted off-screen - this indicates sync loss
            // console.log(`Sync check: Marker off-screen (tuned: ${(this.currentTunedFreq/1e6).toFixed(3)} MHz, ` +
            //            `range: ${(startFreq/1e6).toFixed(3)}-${(endFreq/1e6).toFixed(3)} MHz)`);

            // If we're zoomed in, pan to bring marker back into view
            // Only do this if Edge Tune is enabled (otherwise user wants to scroll freely)
            if (this.binBandwidth && this.initialBinBandwidth &&
                this.binBandwidth < this.initialBinBandwidth &&
                this.edgeTuneEnabled) {
                console.log('Sync correction: Panning to restore marker visibility');
                this.panTo(this.currentTunedFreq);
            }
        }
    }

    // Start periodic settings sync (1000ms interval)
    // Actively resends zoom/pan/rate state to keep server in sync with client.
    startSettingsSync() {
        if (this.settingsSyncInterval) return;

        this.settingsSyncInterval = setInterval(() => {
            if (document.hidden) return; // skip while page is not visible
            this.sendSettingsSync();
        }, 1000); // 1s — resend last known zoom/pan/rate to server

        console.log('Started settings sync (1000ms interval)');
    }

    // Stop periodic settings sync
    stopSettingsSync() {
        if (this.settingsSyncInterval) {
            clearInterval(this.settingsSyncInterval);
            this.settingsSyncInterval = null;
            console.log('Stopped settings sync');
        }
    }

    // Setup visibility-based disconnect/reconnect.
    // When the page is hidden (tab switch, mobile background, screen lock):
    //   - waits 5 seconds before closing (handles brief tab switches gracefully)
    //   - if the page becomes visible again within 5s, the pending close is cancelled
    //   - after 5s, closes the spectrum WebSocket cleanly without triggering auto-reconnect
    // When the page becomes visible again after a close:
    //   - reconnects immediately using the last connection URL
    //   - resyncs zoom/pan/rate state once connected (via onopen + sendSettingsSync)
    // Registered once (guarded by _visibilityDisconnectHandler flag).
    setupVisibilityDisconnect() {
        if (this._visibilityDisconnectHandler) return; // already registered

        this._visibilityHideTimer = null; // pending close timer

        this._visibilityDisconnectHandler = () => {
            if (document.hidden) {
                // Page hidden — pause animation immediately (no point drawing while invisible)
                this.pauseAnimation();

                // Schedule WebSocket disconnect after 5s grace period.
                // If the user switches back within 5s, the timer is cancelled below.
                if (!this._visibilityHideTimer) {
                    console.log('Page hidden — animation paused, will disconnect WebSocket in 5s');
                    this._visibilityHideTimer = setTimeout(() => {
                        this._visibilityHideTimer = null;
                        if (document.hidden && this.ws && this.ws.readyState === WebSocket.OPEN) {
                            console.log('Page hidden 5s — disconnecting spectrum WebSocket');
                            this._visibilityDisconnected = true; // flag: we closed it intentionally
                            this.ws.close();
                            // ws.onclose will fire; scheduleReconnect() checks _visibilityDisconnected
                            // and skips the exponential-backoff reconnect
                        }
                    }, 5000);
                }
            } else {
                // Page visible again — resume animation immediately
                this.resumeAnimation();

                // Cancel any pending WebSocket close timer
                if (this._visibilityHideTimer) {
                    clearTimeout(this._visibilityHideTimer);
                    this._visibilityHideTimer = null;
                    console.log('Page visible within 5s — cancelled pending disconnect, animation resumed');
                }

                // Reconnect WebSocket if we were the ones who closed it after 5s
                if (this._visibilityDisconnected) {
                    console.log('Page visible — reconnecting spectrum WebSocket');
                    this._visibilityDisconnected = false;
                    // Reset reconnect counter so we get a fresh connection immediately
                    this.reconnectAttempts = 0;
                    this.connect().catch(err => {
                        console.error('Visibility reconnect failed:', err);
                    });
                    // sendSettingsSync is called from onopen after connect succeeds
                }
            }
        };

        document.addEventListener('visibilitychange', this._visibilityDisconnectHandler);
        console.log('Visibility disconnect handler registered (5s grace period)');
    }

    // Resend the last known zoom, pan, and rate parameters to the server.
    // Called every 1s to ensure the server stays in sync with the client's
    // current view — guards against missed messages, reconnects, or server restarts.
    sendSettingsSync() {
        // Skip if not connected
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Skip while actively dragging (live pan messages are already being sent)
        if (this.isDragging) {
            return;
        }

        const sent = this._lastSentByType || {};
        const lastZoom = sent.zoom;
        const lastPan  = sent.pan;

        // Always use the current confirmed center frequency from the server config
        // response — never replay a stale frequency from a recorded zoom/pan message.
        // This prevents the 1s sync from overwriting a frequency the user just tuned to.
        const currentFreq = this.centerFreq;

        if (lastZoom) {
            // Resend zoom with current frequency + last known binBandwidth.
            // The binBandwidth is what matters for zoom level; frequency must be current.
            this.ws.send(JSON.stringify({
                type: 'zoom',
                frequency: Math.round(currentFreq),
                binBandwidth: lastZoom.msg.binBandwidth
            }));
        } else if (lastPan) {
            // Resend pan with current frequency
            this.ws.send(JSON.stringify({
                type: 'pan',
                frequency: Math.round(currentFreq)
            }));
        } else if (currentFreq) {
            // No zoom/pan recorded yet but we know the current frequency — send a pan
            this.ws.send(JSON.stringify({
                type: 'pan',
                frequency: Math.round(currentFreq)
            }));
        } else {
            // No state at all — ask server for current state
            this.ws.send(JSON.stringify({ type: 'get_status' }));
        }

        // Resend last set_rate so the server frame-skip divisor stays correct
        const lastRate = sent.set_rate;
        if (lastRate) {
            this.ws.send(JSON.stringify(lastRate.msg));
        }
    }

    // Toggle line graph (spectrum) visibility
    toggleLineGraphVisibility(visible) {
        if (!this.lineGraphCanvas) return;

        if (visible) {
            // Show line graph - restore split mode class
            this.lineGraphCanvas.classList.add('split-mode');
            this.lineGraphCanvas.style.display = 'block';
            // Restore waterfall to split mode position (below line graph)
            this.canvas.classList.add('split-view');

            // Update CSS container height: spectrum (300px) + waterfall
            document.documentElement.style.setProperty('--spectrum-container-height', this.fullHeight + 'px');
            document.documentElement.style.setProperty('--waterfall-height', this.waterfallHeight + 'px');

            // Save current waterfall content before resize
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(this.canvas, 0, 0);

            // Adjust waterfall canvas height to only occupy bottom half
            this.canvas.width = this.width;
            this.canvas.height = this.waterfallHeight;
            this.canvas.style.width = this.width + 'px';
            this.canvas.style.height = this.waterfallHeight + 'px';
            this.canvasHeight = this.waterfallHeight;
            this.height = this.waterfallHeight;

            // Get context (canvas resize clears it)
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = true;

            // Fill with black
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, this.waterfallHeight);

            // Reset waterfall state to start fresh
            this.waterfallImageData = null;
            this.waterfallLineCount = 0;
            this.waterfallStartTime = null;

            console.log(`Line graph (spectrum) enabled - waterfall canvas resized to ${this.waterfallHeight}px`);
        } else {
            // Hide line graph - remove split mode class and hide
            this.lineGraphCanvas.classList.remove('split-mode');
            this.lineGraphCanvas.style.display = 'none';
            // Move waterfall to full height mode
            this.canvas.classList.remove('split-view');

            // Update CSS container height: waterfall fills full height (no spectrum above)
            document.documentElement.style.setProperty('--spectrum-container-height', this.fullHeight + 'px');
            document.documentElement.style.setProperty('--waterfall-height', this.waterfallHeight + 'px');

            // Save current waterfall content before resize
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(this.canvas, 0, 0);

            // Restore waterfall canvas to full height
            this.canvas.width = this.width;
            this.canvas.height = this.fullHeight;
            this.canvas.style.width = this.width + 'px';
            this.canvas.style.height = this.fullHeight + 'px';
            this.canvasHeight = this.fullHeight;
            this.height = this.fullHeight;

            // Get context (canvas resize clears it)
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = true;

            // Fill with black
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, this.fullHeight);

            // Reset waterfall state to start fresh
            this.waterfallImageData = null;
            this.waterfallLineCount = 0;
            this.waterfallStartTime = null;

            // Clear the line graph canvas when hiding
            if (this.lineGraphCtx) {
                this.lineGraphCtx.clearRect(0, 0, this.lineGraphCanvas.width, this.lineGraphCanvas.height);
            }

            console.log(`Line graph (spectrum) disabled - waterfall canvas resized to ${this.fullHeight}px`);
        }

        // Invalidate overlay rect cache — the source canvas switches between
        // lineGraphCanvas and waterfall canvas when toggling visibility.
        this._overlayRectCache = null;
        // Immediately recompute so the overlay snaps to the correct canvas
        // before the next animation frame (fixes pre-existing misposition bug).
        this.updateOverlayPosition();

        // Force redraw to update display
        if (this.spectrumData && this.spectrumData.length > 0) {
            this.draw();
        }
    }

    // Set waterfall height (called by drag-resize UI in app.js)
    // Minimum is 1px — the waterfall can be collapsed to nothing in any mode.
    // Double-click on the handle resets to the default 300px.
    setWaterfallHeight(h) {
        const newH = Math.max(1, Math.round(h));
        if (newH === this.waterfallHeight) return;

        this.waterfallHeight = newH;
        this.fullHeight = 300 + newH;

        localStorage.setItem('waterfallHeight', String(newH));

        // Update CSS variable so the container and split-mode rules track the new height
        document.documentElement.style.setProperty('--spectrum-container-height', this.fullHeight + 'px');
        document.documentElement.style.setProperty('--waterfall-height', newH + 'px');

        // Determine current display mode
        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';

        // Re-apply sizing for the current display mode
        if (lineGraphVisible) {
            // Split mode: waterfall sits below the fixed 300px line graph
            this.canvas.height = newH;
            this.canvas.style.height = newH + 'px';
            this.canvasHeight = newH;
            this.height = newH;
        } else {
            // Non-split mode: waterfall fills the full container
            this.canvas.height = this.fullHeight;
            this.canvas.style.height = this.fullHeight + 'px';
            this.canvasHeight = this.fullHeight;
            this.height = this.fullHeight;
        }

        // Re-acquire context (canvas resize clears it)
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.ctx.imageSmoothingEnabled = true;

        // Clear to black
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Resize the bandwidth lines overlay canvas to match the new full height
        // so the dashed low/high bandwidth marker lines extend through the whole waterfall.
        // IMPORTANT: resizing a canvas resets its drawing buffer and invalidates any
        // previously obtained context — re-acquire bandwidthLinesCtx after the resize.
        if (this.bandwidthLinesCanvas) {
            this.bandwidthLinesCanvas.height = this.fullHeight;
            this.bandwidthLinesCanvas.style.height = this.fullHeight + 'px';
            // Re-acquire context — the old reference is dead after a canvas resize
            this.bandwidthLinesCtx = this.bandwidthLinesCanvas.getContext('2d', { alpha: true });
        }

        // Reset waterfall state so it starts fresh at the new size
        this.waterfallImageData = null;
        this.waterfallLineCount = 0;
        this.waterfallStartTime = null;
        this.gpuScrollOffset = 0;
        this.gpuNextWriteRow = 0;

        // Invalidate the cursor cache so drawTunedFrequencyCursor() re-runs
        // drawTunedFrequencyCursorOnly() → drawBandwidthLines() at the new height.
        // Without this the cache hit-check (lastCursorTunedFreq etc.) would skip the
        // redraw because none of those values changed during a height-only resize.
        this.cursorCache = null;
        this.lastCursorTunedFreq = null;

        // Force redraw of bandwidth lines at new height
        if (this.totalBandwidth && this.centerFreq) {
            this.drawTunedFrequencyCursor();
        }

    }
}