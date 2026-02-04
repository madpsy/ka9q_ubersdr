// Spectrum Display - Full-band FFT visualization for ka9q UberSDR
// Connects to radiod's spectrum mode via WebSocket

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

        // Line graph data smoothing - store recent spectrum data for averaging
        this.lineGraphDataHistory = [];
        this.lineGraphDataHistoryMaxAge = 300; // 300ms window for smoothing
        this.lineGraphDataHistoryMaxSize = 5; // Keep last 5 frames

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
                const newHeight = lineGraphVisible ? 300 : 600;

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
                    console.log(`Canvas height changed: ${oldHeight} -> ${this.height} CSS pixels (waterfall preserved)`);
                }
            }, 250); // Debounce resize events
        });

        // Create overlay div for cursor indicator (positioned above canvas)
        this.overlayDiv = document.createElement('div');
        this.overlayDiv.className = 'spectrum-frequency-overlay';
        this.overlayDiv.style.position = 'fixed';
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
        this.bandwidthLinesCanvas.height = 600;
        this.bandwidthLinesCanvas.style.position = 'absolute';
        this.bandwidthLinesCanvas.style.top = '0';
        this.bandwidthLinesCanvas.style.left = '0';
        this.bandwidthLinesCanvas.style.width = this.width + 'px';
        this.bandwidthLinesCanvas.style.height = '600px';
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
                        if (pos.country_name) {
                            tooltipText += `<br>Country: ${pos.country_name}`;
                        }
                        this.tooltip.innerHTML = tooltipText;

                        // Position tooltip near cursor
                        const tooltipX = e.clientX + 15;
                        const tooltipY = e.clientY - 10;

                        this.tooltip.style.left = tooltipX + 'px';
                        this.tooltip.style.top = tooltipY + 'px';
                        this.tooltip.style.display = 'block';
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

                        // Position tooltip near cursor
                        const tooltipX = e.clientX + 15;
                        const tooltipY = e.clientY - 10;

                        this.tooltip.style.left = tooltipX + 'px';
                        this.tooltip.style.top = tooltipY + 'px';
                        this.tooltip.style.display = 'block';
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
                        let tooltipText = `${pos.spot.dx_call}: ${freqStr}<br>Time: ${timeStr} UTC`;
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
                        this.tooltip.innerHTML = tooltipText;

                        // Position tooltip near cursor
                        const tooltipX = e.clientX + 15;
                        const tooltipY = e.clientY - 10;

                        this.tooltip.style.left = tooltipX + 'px';
                        this.tooltip.style.top = tooltipY + 'px';
                        this.tooltip.style.display = 'block';
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
                        let tooltipText = `${pos.spot.dx_call}: ${freqStr}<br>Time: ${timeStr} UTC<br>SNR: ${snrStr} dB<br>WPM: ${pos.spot.wpm}`;
                        if (pos.spot.country) {
                            tooltipText += `<br>Country: ${pos.spot.country}`;
                        }
                        if (pos.spot.comment) {
                            tooltipText += `<br>Comment: ${pos.spot.comment}`;
                        }
                        this.tooltip.innerHTML = tooltipText;

                        // Position tooltip near cursor
                        const tooltipX = e.clientX + 15;
                        const tooltipY = e.clientY - 10;

                        this.tooltip.style.left = tooltipX + 'px';
                        this.tooltip.style.top = tooltipY + 'px';
                        this.tooltip.style.display = 'block';
                        return;
                    }
                }
            }

            // No bookmark, DX spot, or CW spot under mouse, hide tooltip
            this.hideTooltip();
        });

        // Add mouseleave handler to hide tooltip when leaving overlay
        this.overlayCanvas.addEventListener('mouseleave', () => {
            this.hideTooltip();
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
                        return;
                    }
                }
            }

            // Check if click is on a bookmark
            if (typeof window.bookmarks !== 'undefined' && typeof window.handleBookmarkClick === 'function') {
                const startFreq = this.centerFreq - this.totalBandwidth / 2;
                const endFreq = this.centerFreq + this.totalBandwidth / 2;

                // Check each bookmark to see if click is near it
                for (let bookmark of window.bookmarks) {
                    if (bookmark.frequency >= startFreq && bookmark.frequency <= endFreq) {
                        const bookmarkX = ((bookmark.frequency - startFreq) / this.totalBandwidth) * this.width;

                        // Check if click is within 30 pixels of bookmark (wider hit area)
                        if (Math.abs(x - bookmarkX) <= 30) {
                            window.handleBookmarkClick(bookmark, e.shiftKey || e.ctrlKey, true);
                            return;
                        }
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
            colorScheme: config.colorScheme || 'jet', // Default to jet color scheme
            intensity: config.intensity !== undefined ? config.intensity : 0.20, // Intensity adjustment (-1.0 to +1.0)
            contrast: config.contrast !== undefined ? config.contrast : 70, // Contrast threshold (0-100)
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
        this.skipEdgeDetection = false;

        // Auto-ranging
        this.actualMinDb = this.config.minDb;
        this.actualMaxDb = this.config.maxDb;
        
        // Auto-range history for temporal smoothing (matching app.js waterfall behavior)
        this.autoRangeMinHistory = []; // Track minimum values over time for stable noise floor
        this.autoRangeMaxHistory = []; // Track maximum values over time for stable ceiling
        this.autoRangeMinHistoryMaxAge = 2000; // 2 second window for noise floor (matches app.js)
        this.autoRangeMaxHistoryMaxAge = 20000; // 20 second window for maximum (handles FT8 cycles, matches app.js)

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
        this.panThrottleMs = 50; // Throttle pan requests (50ms = 20 requests/sec max)
        this.lastDragX = -1; // Track last drag position to detect actual movement
        this.lastDragY = -1;

        // Client-side prediction for smooth dragging
        this.predictedFreqOffset = 0; // Frequency offset for visual prediction during drag
        this.lastServerCenterFreq = 0; // Track last confirmed center freq from server
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
            this.canvas.height = 300;
            this.height = 300;
            this.canvasHeight = 300;

            if (this.lineGraphCanvas) {
                this.lineGraphCanvas.classList.add('split-mode');
                this.lineGraphCanvas.style.display = 'block';
                this.lineGraphCanvas.width = this.width;
                this.lineGraphCanvas.height = 300;
                this.lineGraphCanvas.style.width = this.width + 'px';
                this.lineGraphCanvas.style.height = '300px';
            }

            this.bandwidthLinesCanvas.height = 600;
            this.bandwidthLinesCanvas.style.height = '600px';

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

        // Setup filter latency change listener for synchronization
        this.setupFilterLatencyListener();
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
                    maxLimit = 4000;
                    break;
                case 'lsb':
                    minLimit = -4000;
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
                    maxLimit = 4000;
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

        const processFrame = () => {
            if (!this.animationLoopRunning) return;

            // Check if spectrum sync is enabled
            if (this.spectrumSyncEnabled && window.audioContext && window.nextPlayTime) {
                const currentTime = window.audioContext.currentTime;
                const bufferAhead = window.nextPlayTime - currentTime;

                // Use cached filter latency in seconds (convert from ms)
                // This value is updated dynamically when filters are toggled or parameters change
                const filterLatency = this.cachedFilterLatency / 1000;

                // Process frames that should be displayed now
                const now = Date.now();

                // ADAPTIVE FRAME DROPPING: Prevent unbounded queue growth during high CPU
                // Drop old frames if queue is too large (prevents 5+ second lag)
                if (this.frameQueue.length > this.maxHealthyQueueSize) {
                    const dropped = this.frameQueue.length - this.maxHealthyQueueSize;
                    this.frameQueue.splice(0, dropped);
                    this.droppedFrameCount += dropped;
                    if (this.droppedFrameCount % 50 === 0) {
                        console.log(`Waterfall: Dropped ${this.droppedFrameCount} frames total to prevent lag (queue was ${this.frameQueue.length + dropped})`);
                    }
                }

                // Drop stale frames (older than maxFrameAge)
                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    const age = now - frame.receiveTime;

                    if (age > this.maxFrameAge) {
                        this.frameQueue.shift();
                        this.droppedFrameCount++;
                        if (this.droppedFrameCount % 50 === 0) {
                            console.log(`Waterfall: Dropped stale frame (${age}ms old, total dropped: ${this.droppedFrameCount})`);
                        }
                    } else {
                        break; // Rest of queue is fresh
                    }
                }

                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];

                    // Calculate when this frame should be displayed
                    // The audio path has these delays:
                    // 1. bufferAhead: Audio buffered ahead of playback (subtract to sync with current playback)
                    // 2. filterLatency: Processing delay from filters (ADD to delay waterfall to match delayed audio)
                    // 3. bufferMargin: Safety margin for timing jitter (subtract for conservative display)
                    //
                    // Audio captured at time T goes through filters (adding filterLatency) and plays at T + filterLatency
                    // Spectrum captured at time T should display when audio plays, so add filterLatency to delay it
                    const displayTime = frame.receiveTime - (bufferAhead * 1000) + (filterLatency * 1000) - (this.bufferMargin * 1000);

                    if (now >= displayTime) {
                        // Time to display this frame
                        this.frameQueue.shift();
                        this.displayFrame(frame.data);
                    } else {
                        // This frame and all subsequent frames are not ready yet
                        break;
                    }
                }
            } else {
                // Spectrum sync disabled OR no audio timing available - display frames immediately
                // But still drop very old frames to prevent processing huge backlog when returning from another tab
                const now = Date.now();
                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    const age = now - frame.receiveTime;

                    // Drop frames older than 5 seconds (much more lenient than sync mode's 500ms)
                    if (age > 5000) {
                        this.frameQueue.shift();
                        this.droppedFrameCount++;
                        if (this.droppedFrameCount % 50 === 0) {
                            console.log(`Waterfall (no sync): Dropped very old frame (${age}ms old, total dropped: ${this.droppedFrameCount})`);
                        }
                    } else {
                        break; // Rest of queue is fresh enough
                    }
                }

                // Display the next frame if available
                if (this.frameQueue.length > 0) {
                    const frame = this.frameQueue.shift();
                    this.displayFrame(frame.data);
                }
            }

            // Continue processing
            requestAnimationFrame(processFrame);
        };

        processFrame();
    }

    // Stop frame processing loop
    stopFrameProcessing() {
        this.animationLoopRunning = false;
        this.frameQueue = [];
        console.log('Stopped spectrum frame processing loop');
    }

    // Display a spectrum frame
    displayFrame(data) {
        this.spectrumData = data;
        this.lastUpdate = Date.now();
        this.draw();

        // Update tooltip with new data even if mouse hasn't moved
        if (this.mouseX >= 0 && this.mouseY >= 0 && !this.isDragging) {
            this.updateTooltip();
        }

        // Update signal meter with new data
        this.updateSignalMeter();

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

        console.log('Connecting to spectrum WebSocket:', wsUrl);

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer'; // Enable binary message handling

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
                    console.log('Peak hold cleared BEFORE config update to prevent NaN values');
                }

                this.centerFreq = msg.centerFreq;
                this.binCount = msg.binCount;
                this.binBandwidth = msg.binBandwidth;
                this.totalBandwidth = msg.totalBandwidth;

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

                // Only log config changes if they're significant (not from periodic sync)
                // Log if this is the first config OR if values actually changed
                if (!this.lastLoggedConfig ||
                    this.lastLoggedConfig.centerFreq !== this.centerFreq ||
                    this.lastLoggedConfig.binBandwidth !== this.binBandwidth ||
                    this.lastLoggedConfig.binCount !== this.binCount) {
                    
                    const startFreq = this.centerFreq - this.totalBandwidth / 2;
                    const endFreq = this.centerFreq + this.totalBandwidth / 2;
                    console.log(`Spectrum config: ${this.binCount} bins @ ${this.binBandwidth.toFixed(1)} Hz (zoom ${this.zoomLevel.toFixed(2)}x)`);
                    console.log(`  Center: ${(this.centerFreq/1e6).toFixed(3)} MHz`);
                    console.log(`  Range: ${(startFreq/1e6).toFixed(3)} - ${(endFreq/1e6).toFixed(3)} MHz`);
                    console.log(`  Total BW: ${(this.totalBandwidth/1e6).toFixed(3)} MHz`);
                    
                    // Store for next comparison
                    this.lastLoggedConfig = {
                        centerFreq: this.centerFreq,
                        binBandwidth: this.binBandwidth,
                        binCount: this.binCount
                    };
                }

                // Update cursor style based on new bandwidth
                this.updateCursorStyle();

                if (this.config.onConfig) {
                    this.config.onConfig(msg);
                }
                break;

            case 'spectrum':
                // Check if spectrum data frequency mismatches UI state (indicates drift)
                if (msg.frequency && Math.abs(msg.frequency - this.centerFreq) > 1000) {
                    console.warn(`⚠️ SPECTRUM MISMATCH: Data=${(msg.frequency/1e6).toFixed(3)} MHz, UI=${(this.centerFreq/1e6).toFixed(3)} MHz, diff=${((msg.frequency - this.centerFreq)/1000).toFixed(1)} kHz`);
                }
                
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

    // Draw the spectrum display (split mode only: line graph on top, waterfall on bottom)
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

        // Draw waterfall in bottom half
        this.drawWaterfall();

        // Draw tuned frequency cursor on overlay canvas
        this.drawTunedFrequencyCursor();
    }

    // Draw waterfall display
    drawWaterfall() {
        // Auto-range if enabled
        if (this.config.autoRange) {
            this.updateAutoRange();
        }

        // Don't apply predicted shift - it causes continuous movement when button is held
        // The shift was intended for smooth dragging but causes issues with stationary mouse
        // Commenting out for now - dragging will work but without client-side prediction
        // if (this.isDragging && this.predictedFreqOffset !== 0 && this.dragDidMove) {
        //     this.applyPredictedShift();
        // }

        // Waterfall starts at y=75 (below bookmarks + freq scale) when line graph is hidden, y=0 when visible (split mode - canvas is already positioned below line graph)
        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
        const waterfallStartY = lineGraphVisible ? 0 : 75;
        const waterfallHeight = this.height - waterfallStartY - 1;

        // Initialize waterfall image data if needed
        if (!this.waterfallImageData) {
            console.log(`[drawWaterfall] Initializing waterfall in ${this.displayMode} mode, canvas height: ${this.height}`);
            this.waterfallImageData = this.ctx.createImageData(this.width, 1);
            // Initialize with black background - only clear the waterfall drawing area
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, waterfallStartY, this.width, this.height - waterfallStartY);
        }

        // Initialize start time if needed
        if (!this.waterfallStartTime) {
            this.waterfallStartTime = Date.now();
            this.waterfallLineCount = 0;
        }

        // Log only first time in split mode
        if (this.displayMode === 'split' && !this.splitModeLogged) {
            console.log(`[drawWaterfall] Split mode - waterfallStartY: ${waterfallStartY}, waterfallHeight: ${waterfallHeight}, canvas height: ${this.height}`);
            this.splitModeLogged = true;
        }

        // Scroll existing waterfall down by 1 pixel
        // CRITICAL: Copy pixel-for-pixel without scaling to avoid stretching
        // Source and destination dimensions must match exactly
        this.ctx.drawImage(this.canvas, 0, waterfallStartY, this.width, waterfallHeight - 1, 0, waterfallStartY + 1, this.width, waterfallHeight - 1);

        // Create new line at top with current spectrum data (at y=30, below frequency scale)
        const pixelData = this.waterfallImageData.data;
        const dbRange = this.actualMaxDb - this.actualMinDb;

        // Server-side zoom: map bins to pixels with interpolation for smooth rendering
        // When bin_count is reduced for deep zoom, interpolate between bins to avoid pixelation
        for (let x = 0; x < this.width; x++) {
            // Map pixel x to exact bin position (floating point)
            const binPos = (x / this.width) * this.spectrumData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

            // Get dB value with linear interpolation between adjacent bins
            let db;
            if (binIndex >= 0 && binIndex < this.spectrumData.length - 1) {
                // Interpolate between current and next bin
                const db1 = this.spectrumData[binIndex];
                const db2 = this.spectrumData[binIndex + 1];
                db = db1 + (db2 - db1) * binFrac;
            } else if (binIndex === this.spectrumData.length - 1) {
                // Last bin, no interpolation
                db = this.spectrumData[binIndex];
            } else {
                // Out of range
                db = this.actualMinDb;
            }

            // Normalize to 0-1 range
            let normalized = Math.max(0, Math.min(1, (db - this.actualMinDb) / dbRange));

            // Apply contrast threshold (noise floor suppression)
            // Convert normalized (0-1) to magnitude (0-255) for contrast calculation
            let magnitude = normalized * 255;

            if (magnitude < this.config.contrast) {
                magnitude = 0;
            } else {
                // Rescale remaining values to use full range
                magnitude = ((magnitude - this.config.contrast) / (255 - this.config.contrast)) * 255;
            }

            // Apply intensity adjustment
            if (this.config.intensity < 0) {
                // Reduce intensity: multiply by (1 + intensity), where intensity is negative
                magnitude = magnitude * (1 + this.config.intensity);
            } else if (this.config.intensity > 0) {
                // Increase intensity: multiply by (1 + intensity * 2)
                magnitude = Math.min(255, magnitude * (1 + this.config.intensity * 2));
            }

            // Convert back to normalized (0-1) for color mapping
            normalized = magnitude / 255;

            // Convert to color
            const color = this.getColorRGB(normalized);

            const offset = x * 4;
            pixelData[offset] = color.r;
            pixelData[offset + 1] = color.g;
            pixelData[offset + 2] = color.b;
            pixelData[offset + 3] = 255; // Alpha
        }

        // Draw the new line at waterfallStartY (below frequency scale)
        this.ctx.putImageData(this.waterfallImageData, 0, waterfallStartY);

        this.waterfallLineCount++;

        // Log only first few lines in split mode
        if (this.displayMode === 'split' && this.waterfallLineCount <= 3) {
            console.log(`[drawWaterfall] Drew waterfall line #${this.waterfallLineCount} at y=${waterfallStartY}`);
        }

        // Timestamps removed per user request

        // Waterfall frequency scale removed - line graph has its own frequency scale
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

        // Apply client-side prediction: shift line graph if dragging AND mouse is actually moving
        // Don't apply shift if just holding button down without movement
        if (this.isDragging && this.predictedFreqOffset !== 0 && this.dragDidMove) {
            this.applyPredictedShiftToLineGraph();
        }

        const ctx = this.lineGraphCtx;
        const graphHeight = 300;
        const graphWidth = this.width;
        const graphTopMargin = 80; // Space for frequency scale at top (45px) + bookmarks overlay (45px)
        const graphDrawHeight = graphHeight - graphTopMargin; // Actual drawing area height

        // Clear canvas - black background for entire graph
        // (grey bookmark background is now in overlay)
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, graphWidth, graphHeight);

        // Apply temporal smoothing based on toggle
        const now = Date.now();

        let smoothedData;

        if (this.smoothingEnabled) {
            // Smoothing enabled: keep last 5 frames (300ms window) - heavy smoothing
            // Add current spectrum data to history
            this.lineGraphDataHistory.push({
                data: new Float32Array(this.spectrumData),
                timestamp: now
            });

            // Remove old data based on smoothing level
            const maxFrames = this.lineGraphDataHistoryMaxSize;
            const maxAge = this.lineGraphDataHistoryMaxAge;

            this.lineGraphDataHistory = this.lineGraphDataHistory
                .filter(d => now - d.timestamp <= maxAge)
                .slice(-maxFrames);

            // Create smoothed data by averaging recent frames
            smoothedData = new Float32Array(this.spectrumData.length);
            for (let i = 0; i < this.spectrumData.length; i++) {
                let sum = 0;
                for (let j = 0; j < this.lineGraphDataHistory.length; j++) {
                    sum += this.lineGraphDataHistory[j].data[i];
                }
                smoothedData[i] = sum / this.lineGraphDataHistory.length;
            }
        } else {
            // Smoothing disabled: use raw spectrum data directly (no averaging)
            smoothedData = this.spectrumData;
        }

        // Determine min/max based on manual or auto mode
        let minDb, maxDb;

        if (this.config.manualRangeEnabled) {
            // Use manual range values
            minDb = this.config.manualMinDb;
            maxDb = this.config.manualMaxDb;
        } else {
            // Find min and max values in smoothed data
            let currentMinDb = Infinity;
            let currentMaxDb = -Infinity;
            for (let i = 0; i < smoothedData.length; i++) {
                const db = smoothedData[i];
                if (isFinite(db)) {
                    currentMinDb = Math.min(currentMinDb, db);
                    currentMaxDb = Math.max(currentMaxDb, db);
                }
            }

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

            // Use smoothed minimum as floor, smoothed maximum as ceiling
            minDb = avgMinDb;
            maxDb = avgMaxDb;
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
            const normalized = Math.max(0, Math.min(1, (db - minDb) / dbRange));
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
        this.drawLineGraphDbScale(minDb, maxDb, graphHeight, graphTopMargin);

        // Draw thin grey separator line at bottom of spectrum (before waterfall)
        ctx.strokeStyle = '#808080'; // Grey color
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, graphHeight - 1); // Bottom of line graph canvas (y=299)
        ctx.lineTo(graphWidth, graphHeight - 1);
        ctx.stroke();
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
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;

        const firstDb = Math.ceil(minDb / dbStep) * dbStep;
        for (let db = firstDb; db <= maxDb; db += dbStep) {
            // Calculate y position in the drawing area (below frequency scale)
            const y = graphTopMargin + graphDrawHeight - ((db - minDb) / dbRange) * graphDrawHeight;

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

            // Calculate y position in the drawing area (below frequency scale)
            const y = graphTopMargin + graphDrawHeight - ((db - minDb) / dbRange) * graphDrawHeight;

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
            console.log(`Peak hold initialized with ${currentData.length} bins`);
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
            const normalized = Math.max(0, Math.min(1, (db - minDb) / dbRange));
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

                // CLIENT-SIDE PREDICTION: Update visual offset immediately for smooth dragging
                const oldPredictedOffset = this.predictedFreqOffset;
                this.predictedFreqOffset = newCenterFreq - this.lastServerCenterFreq;

                // Only redraw if the predicted offset actually changed
                if (Math.abs(this.predictedFreqOffset - oldPredictedOffset) > 0.1) {
                    if (this.spectrumData && this.spectrumData.length > 0) {
                        this.draw();
                    }
                }

                // Throttle pan requests
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (lineGraphDragDidMove && Math.abs(newCenterFreq - this.centerFreq) > 1000 && timeSinceLastPan >= this.panThrottleMs) {
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

            // Position tooltip near cursor
            const rect = this.lineGraphCanvas.getBoundingClientRect();
            const tooltipX = rect.left + x + 15;
            const tooltipY = rect.top + y - 10;

            this.tooltip.style.left = tooltipX + 'px';
            this.tooltip.style.top = tooltipY + 'px';
            this.tooltip.style.display = 'block';
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
            freqStep = 100e3; // 100 kHz
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

        this.ctx.font = 'bold 13px monospace';
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

    // Update overlay div position to match canvas position
    updateOverlayPosition() {
        // In split mode, overlay should be at the top of the container, not the waterfall canvas
        const lineGraphVisible = this.lineGraphCanvas && this.lineGraphCanvas.style.display !== 'none';
        
        if (lineGraphVisible) {
            // Use line graph canvas position (at top of container)
            const rect = this.lineGraphCanvas.getBoundingClientRect();
            this.overlayDiv.style.top = rect.top + 'px';
            this.overlayDiv.style.left = rect.left + 'px';
            this.overlayDiv.style.width = rect.width + 'px';
        } else {
            // Use waterfall canvas position
            const rect = this.canvas.getBoundingClientRect();
            this.overlayDiv.style.top = rect.top + 'px';
            this.overlayDiv.style.left = rect.left + 'px';
            this.overlayDiv.style.width = rect.width + 'px';
        }
        
        this.overlayDiv.style.height = '75px'; // 45px bookmarks + 30px frequency scale
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

        // Create or update offscreen canvas for marker caching if view changed
        if (viewChanged || !this.markerCache) {
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

            // Draw bookmarks on top of background
            if (typeof window.drawBookmarksOnSpectrum === 'function') {
                window.drawBookmarksOnSpectrum(this, console.log);
            }

            // Draw chat user markers AFTER bookmarks (higher z-index than bookmarks, lower than orange marker)
            this.drawChatUserMarkers();

            // Draw DX spots to cache
            if (typeof window.drawDXSpotsOnSpectrum === 'function') {
                window.drawDXSpotsOnSpectrum(this, console.log);
            }

            // Draw CW spots to cache
            if (typeof window.drawCWSpotsOnSpectrum === 'function') {
                window.drawCWSpotsOnSpectrum(this, console.log);
            }

            // Restore original context
            this.overlayCtx = originalCtx;

            // Update tracking variables (use effective center freq with prediction)
            this.lastMarkerCenterFreq = effectiveCenterFreq;
            this.lastMarkerTotalBandwidth = this.totalBandwidth;
            this.lastMarkerDisplayMode = this.displayMode;
        }

        // Clear overlay canvas
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // Draw cached markers (fast - just a bitmap copy)
        if (this.markerCache) {
            this.overlayCtx.drawImage(this.markerCache, 0, 0);
        }

        // Draw tuned frequency cursor on top (this changes frequently with tuning)
        if (this.currentTunedFreq && this.totalBandwidth) {
            this.drawTunedFrequencyCursorOnly();
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
            if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) {
                console.log(`Edge detection check: skipEdgeDetection=${this.skipEdgeDetection}, isDragging=${this.isDragging}, hasInputFocus=${hasInputFocus}`);
            }
            
            if (this.config.onFrequencyClick && !this.isDragging && !hasInputFocus && !this.skipEdgeDetection) {
                console.log(`Marker at edge - updating frequency to ${(newFreq/1e6).toFixed(3)} MHz`);
                this.skipNextPan = true; // Don't pan back when we update frequency
                this.config.onFrequencyClick(newFreq);
            }
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

        // Draw frequency label at top
        const freqLabel = this.formatFrequency(this.currentTunedFreq);
        this.overlayCtx.font = 'bold 12px monospace';
        this.overlayCtx.textAlign = 'center';
        this.overlayCtx.textBaseline = 'top';

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
        this.overlayCtx.fillText(freqLabel, x, labelY + 2);

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

        // Draw bandwidth bracket if both edges are visible
        if (xLow >= 0 && xLow <= this.width && xHigh >= 0 && xHigh <= this.width) {
            const bracketY = 45; // Position for bracket (at top of frequency scale section)
            const bracketHeight = 8;

            // Draw horizontal line connecting the edges (thicker)
            this.overlayCtx.strokeStyle = 'rgba(0, 255, 0, 0.9)'; // Brighter green
            this.overlayCtx.lineWidth = 3; // Thicker line
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(xLow, bracketY);
            this.overlayCtx.lineTo(xHigh, bracketY);
            this.overlayCtx.stroke();

            // Draw vertical ticks at edges (thicker)
            this.overlayCtx.lineWidth = 3;
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(xLow, bracketY - bracketHeight/2);
            this.overlayCtx.lineTo(xLow, bracketY + bracketHeight/2);
            this.overlayCtx.moveTo(xHigh, bracketY - bracketHeight/2);
            this.overlayCtx.lineTo(xHigh, bracketY + bracketHeight/2);
            this.overlayCtx.stroke();
        }

        // Draw vertical bandwidth lines extending down over waterfall/graph
        this.drawBandwidthLines(xLow, xHigh);
    }

    drawChatUserMarkers() {
        // Check if chat markers are enabled
        if (window.showChatMarkers === false) {
            console.log('[drawChatUserMarkers] Chat markers disabled by user preference');
            return;
        }
        
        // Draw purple markers for active chat users (excluding self)
        // Get data from stats endpoint (stored in window.activeChannels by app.js)
        console.log('[drawChatUserMarkers] window.activeChannels:', window.activeChannels);
        if (!window.activeChannels || window.activeChannels.length === 0) {
            console.log('[drawChatUserMarkers] No active channels data');
            return;
        }
        console.log('[drawChatUserMarkers] Processing', window.activeChannels.length, 'channels');

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
            console.log('[drawChatUserMarkers] Channel', index, ':', channel);
            
            // Skip the first channel (index 0) which is the current user
            if (index === 0) {
                console.log('[drawChatUserMarkers] Skipping index 0 (current user)');
                return;
            }

            // Skip channels without chat username
            if (!channel.chat_username || channel.chat_username.trim() === '') {
                console.log('[drawChatUserMarkers] Skipping - no chat username');
                return;
            }

            // Skip channels without frequency data
            if (!channel.frequency) {
                console.log('[drawChatUserMarkers] Skipping - no frequency');
                return;
            }

            const userFreq = channel.frequency;
            console.log('[drawChatUserMarkers] User frequency:', userFreq, 'Current tuned:', this.currentTunedFreq);

            // Skip if user is at the same frequency as us (within 100 Hz tolerance)
            if (this.currentTunedFreq && Math.abs(userFreq - this.currentTunedFreq) < 100) {
                console.log('[drawChatUserMarkers] Skipping - same frequency as us');
                return;
            }

            // Check if frequency is within visible range
            console.log('[drawChatUserMarkers] Visible range:', startFreq, 'to', endFreq);
            if (userFreq < startFreq || userFreq > endFreq) {
                console.log('[drawChatUserMarkers] Skipping - frequency outside visible range');
                return;
            }

            // Calculate x position
            const x = ((userFreq - startFreq) / (endFreq - startFreq)) * this.overlayCanvas.width;
            console.log('[drawChatUserMarkers] Drawing marker for', channel.chat_username, 'at x:', x);

            // Draw chat username label at top
            const chatLabel = channel.chat_username;
            this.overlayCtx.font = 'bold 12px monospace';
            this.overlayCtx.textAlign = 'center';
            this.overlayCtx.textBaseline = 'top';

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
            this.overlayCtx.fillText(chatLabel, x, labelY + 2);

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
                country_name: channel.country_name || channel.country_code
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

        // Calculate appropriate frequency step based on available width
        const minLabelSpacing = 80; // Minimum pixels between labels
        const calculatedMarkers = Math.floor(this.width / minLabelSpacing);
        const maxMarkers = Math.min(10, Math.max(3, calculatedMarkers));
        const targetStep = this.totalBandwidth / maxMarkers;
        
        let freqStep;
        if (targetStep >= 5e6) freqStep = 5e6;
        else if (targetStep >= 2e6) freqStep = 2e6;
        else if (targetStep >= 1e6) freqStep = 1e6;
        else if (targetStep >= 500e3) freqStep = 500e3;
        else if (targetStep >= 200e3) freqStep = 200e3;
        else if (targetStep >= 100e3) freqStep = 100e3;
        else if (targetStep >= 50e3) freqStep = 50e3;
        else if (targetStep >= 20e3) freqStep = 20e3;
        else if (targetStep >= 10e3) freqStep = 10e3;
        else if (targetStep >= 5e3) freqStep = 5e3;
        else if (targetStep >= 2e3) freqStep = 2e3;
        else if (targetStep >= 1e3) freqStep = 1e3;
        else if (targetStep >= 500) freqStep = 500;
        else if (targetStep >= 200) freqStep = 200;
        else freqStep = 100;

        ctx.font = 'bold 13px monospace';
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
        // Only draw if both edges are visible
        if (xLow < 0 || xLow > this.width || xHigh < 0 || xHigh > this.width) return;

        // Clear the bandwidth lines overlay canvas
        this.bandwidthLinesCtx.clearRect(0, 0, this.bandwidthLinesCanvas.width, this.bandwidthLinesCanvas.height);

        // Split mode: draw on line graph (from 70px where graph starts) and waterfall
        // Line graph is 300px tall, waterfall is 300px tall
        // Total height needed: 600px (to cover both)
        const startY = 70; // Start where line graph drawing area begins (after bookmarks + freq scale)
        const height = 600; // Cover both line graph and waterfall

        // Draw the bandwidth lines on the overlay canvas
        this.bandwidthLinesCtx.save();

        // Set line style for bandwidth edges
        this.bandwidthLinesCtx.strokeStyle = 'rgba(0, 255, 0, 0.6)'; // Semi-transparent green
        this.bandwidthLinesCtx.lineWidth = 2;
        this.bandwidthLinesCtx.setLineDash([5, 5]); // Dashed line pattern

        // Draw left edge line
        this.bandwidthLinesCtx.beginPath();
        this.bandwidthLinesCtx.moveTo(xLow, startY);
        this.bandwidthLinesCtx.lineTo(xLow, height);
        this.bandwidthLinesCtx.stroke();

        // Draw right edge line
        this.bandwidthLinesCtx.beginPath();
        this.bandwidthLinesCtx.moveTo(xHigh, startY);
        this.bandwidthLinesCtx.lineTo(xHigh, height);
        this.bandwidthLinesCtx.stroke();

        this.bandwidthLinesCtx.restore();
    }

    // Invalidate marker cache to force redraw of bookmarks and DX spots
    // This should be called when DX spots are added/removed or when bookmarks change
    invalidateMarkerCache() {
        this.markerCache = null;
        this.lastMarkerCenterFreq = null;
        this.lastMarkerTotalBandwidth = null;
        this.lastMarkerDisplayMode = null;
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
        let min = Infinity;
        let max = -Infinity;

        for (let i = 0; i < this.spectrumData.length; i++) {
            const db = this.spectrumData[i];
            if (isFinite(db)) {
                min = Math.min(min, db);
                max = Math.max(max, db);
            }
        }

        if (isFinite(min) && isFinite(max)) {
            // Add margin
            const targetMin = Math.floor(min - this.config.rangeMargin);
            const targetMax = Math.ceil(max + this.config.rangeMargin);

            // Track minimum values over time for stable noise floor (2 second window)
            this.autoRangeMinHistory.push({ value: targetMin, timestamp: now });
            this.autoRangeMinHistory = this.autoRangeMinHistory.filter(m => now - m.timestamp <= this.autoRangeMinHistoryMaxAge);

            // Track maximum values over time for stable ceiling (20 second window for FT8 cycles)
            this.autoRangeMaxHistory.push({ value: targetMax, timestamp: now });
            this.autoRangeMaxHistory = this.autoRangeMaxHistory.filter(m => now - m.timestamp <= this.autoRangeMaxHistoryMaxAge);

            // Calculate smoothed values (average of recent history)
            const avgMin = this.autoRangeMinHistory.reduce((sum, m) => sum + m.value, 0) / this.autoRangeMinHistory.length;
            const avgMax = this.autoRangeMaxHistory.reduce((sum, m) => sum + m.value, 0) / this.autoRangeMaxHistory.length;

            // Apply smoothed values
            this.actualMinDb = avgMin;
            this.actualMaxDb = avgMax;
        }
    }

    // Draw grid lines
    drawGrid() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;

        // Horizontal grid lines (dB levels)
        const dbStep = 10;
        const dbRange = this.actualMaxDb - this.actualMinDb;
        const minDb = Math.floor(this.actualMinDb / dbStep) * dbStep;
        const maxDb = Math.ceil(this.actualMaxDb / dbStep) * dbStep;

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
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';

        // dB labels on left
        const dbStep = 20;
        const dbRange = this.actualMaxDb - this.actualMinDb;
        const minDb = Math.floor(this.actualMinDb / dbStep) * dbStep;
        const maxDb = Math.ceil(this.actualMaxDb / dbStep) * dbStep;

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
        this.ctx.font = '12px monospace';
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
        this.ctx.font = '16px sans-serif';
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
            ]
        };

        return schemes[name] || schemes.viridis;
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

                // CLIENT-SIDE PREDICTION: Update visual offset immediately for smooth dragging
                const oldPredictedOffset = this.predictedFreqOffset;
                this.predictedFreqOffset = newCenterFreq - this.lastServerCenterFreq;

                // Only redraw if the predicted offset actually changed
                if (Math.abs(this.predictedFreqOffset - oldPredictedOffset) > 0.1) {
                    if (this.spectrumData && this.spectrumData.length > 0) {
                        this.draw();
                    }
                }

                // Throttle pan requests to avoid backend rounding issues
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (this.dragDidMove && Math.abs(newCenterFreq - this.centerFreq) > 1000 && timeSinceLastPan >= this.panThrottleMs) {
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
                // Check if click is on a bookmark (top 45 pixels where bookmarks are drawn)
                if (y <= 45 && typeof window.bookmarks !== 'undefined' && typeof window.handleBookmarkClick === 'function') {
                    const startFreq = this.centerFreq - this.totalBandwidth / 2;
                    const endFreq = this.centerFreq + this.totalBandwidth / 2;

                    // Check each bookmark to see if click is near it
                    for (let bookmark of window.bookmarks) {
                        if (bookmark.frequency >= startFreq && bookmark.frequency <= endFreq) {
                            const bookmarkX = ((bookmark.frequency - startFreq) / this.totalBandwidth) * this.width;

                            // Check if click is within 20 pixels of bookmark
                            if (Math.abs(x - bookmarkX) <= 20) {
                                window.handleBookmarkClick(bookmark, e.shiftKey || e.ctrlKey, true);
                                this.isDragging = false;
                                this.dragDidMove = false;
                                this.updateCursorStyle();
                                return;
                            }
                        }
                    }
                }

                // If not a bookmark click, handle as frequency tuning
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
        this.tooltip.style.fontFamily = 'monospace';
        this.tooltip.style.pointerEvents = 'none';
        this.tooltip.style.zIndex = '10000';
        this.tooltip.style.display = 'none';
        this.tooltip.style.whiteSpace = 'nowrap';
        this.tooltip.style.border = '1px solid #fff';
        document.body.appendChild(this.tooltip);

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

                // Clamp to reasonable limits
                newBinBandwidth = Math.max(1, Math.min(this.initialBinBandwidth || 1000, newBinBandwidth));

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
            smoothCheckbox.addEventListener('change', (e) => {
                this.smoothingEnabled = e.target.checked;
                console.log(`Spectrum smoothing ${this.smoothingEnabled ? 'enabled' : 'disabled'}`);
                // Clear history when toggling to avoid artifacts
                this.lineGraphDataHistory = [];
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
        const minDbSlider = document.getElementById('spectrum-min-db');
        const maxDbSlider = document.getElementById('spectrum-max-db');
        const minDbValue = document.getElementById('spectrum-min-db-value');
        const maxDbValue = document.getElementById('spectrum-max-db-value');

        // Load saved manual range settings from localStorage
        const savedManualRangeEnabled = localStorage.getItem('spectrumManualRangeEnabled');
        const savedMinDb = localStorage.getItem('spectrumManualMinDb');
        const savedMaxDb = localStorage.getItem('spectrumManualMaxDb');

        if (savedManualRangeEnabled !== null) {
            const isEnabled = savedManualRangeEnabled === 'true';
            this.config.manualRangeEnabled = isEnabled;
            if (manualRangeCheckbox) {
                manualRangeCheckbox.checked = isEnabled;
            }
            if (manualRangeControls) {
                manualRangeControls.style.display = isEnabled ? 'flex' : 'none';
            }
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

        if (manualRangeCheckbox) {
            manualRangeCheckbox.addEventListener('change', (e) => {
                this.config.manualRangeEnabled = e.target.checked;
                localStorage.setItem('spectrumManualRangeEnabled', e.target.checked.toString());

                if (manualRangeControls) {
                    manualRangeControls.style.display = e.target.checked ? 'flex' : 'none';
                }

                if (e.target.checked) {
                    // Clear auto-range history when switching to manual
                    this.autoRangeMinHistory = [];
                    this.autoRangeMaxHistory = [];
                    console.log(`Manual range enabled: ${this.config.manualMinDb} to ${this.config.manualMaxDb} dB`);
                } else {
                    console.log('Auto-range enabled');
                }
            });
        }

        if (minDbSlider && minDbValue) {
            minDbSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.config.manualMinDb = value;
                minDbValue.textContent = value.toFixed(0);
                localStorage.setItem('spectrumManualMinDb', value.toString());
            });
        }

        if (maxDbSlider && maxDbValue) {
            maxDbSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.config.manualMaxDb = value;
                maxDbValue.textContent = value.toFixed(0);
                localStorage.setItem('spectrumManualMaxDb', value.toString());
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
                if (e.deltaY < 0) {
                    this.zoomIn();
                } else {
                    this.zoomOut();
                }
            } else if (useScrollMode) {
                // Perform initial zoom on first scroll if at default zoom level
                // Use aggressive zoom similar to band buttons (zoom to show ~100 kHz view)
                if (!this.hasPerformedInitialZoom && this.zoomLevel === 1) {
                    this.hasPerformedInitialZoom = true;

                    // Calculate aggressive zoom similar to band buttons
                    // Target a focused bandwidth of ~100 kHz for good detail
                    const focusedBandwidth = 100000; // 100 kHz
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

                console.log(`Scroll: deltaY=${e.deltaY}, step=${step}Hz, delay=${delay}ms`);

                // Scroll up = increase frequency, scroll down = decrease frequency
                const delta = e.deltaY < 0 ? step : -step;
                let newFreq = currentFreq + delta;

                // Round to nearest step size for clean values
                newFreq = Math.round(newFreq / step) * step;

                // Clamp to valid range (100 kHz to 30 MHz)
                const MIN_FREQ = 100000;
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

                    // Position tooltip near cursor
                    const rect = this.canvas.getBoundingClientRect();
                    const tooltipX = rect.left + this.mouseX + 15;
                    const tooltipY = rect.top + this.mouseY - 10;

                    this.tooltip.style.left = tooltipX + 'px';
                    this.tooltip.style.top = tooltipY + 'px';
                    this.tooltip.style.display = 'block';
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

        // Position tooltip near cursor
        const rect = this.canvas.getBoundingClientRect();
        const tooltipX = rect.left + this.mouseX + 15;
        const tooltipY = rect.top + this.mouseY - 10;

        this.tooltip.style.left = tooltipX + 'px';
        this.tooltip.style.top = tooltipY + 'px';
        this.tooltip.style.display = 'block';
    }

    // Hide tooltip
    hideTooltip() {
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
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

            // If we're zoomed in and frequency changed, pan to follow it
            // Only pan if we have a valid zoom level and the frequency actually changed
            // Skip panning if the frequency change came from clicking the waterfall
            if (this.binBandwidth && this.initialBinBandwidth &&
                this.binBandwidth < this.initialBinBandwidth &&
                oldTunedFreq !== this.currentTunedFreq &&
                !this.skipNextPan) {

                console.log(`Frequency changed to ${(this.currentTunedFreq/1e6).toFixed(3)} MHz - panning spectrum to follow`);

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
        console.log('[SpectrumDisplay] zoomIn() called');
        if (!this.connected || !this.ws) return;

        // Halve the bin bandwidth = half the total bandwidth = 2x zoom
        const newBinBandwidth = this.binBandwidth / 2;

        // Minimum practical limit - backend will adjust bin_count if needed
        // This allows unlimited zoom depth via dynamic bin count reduction
        if (newBinBandwidth < 1) {
            console.log('Maximum zoom reached (1 Hz/bin minimum)');
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

        const currentTotalBW = this.binBandwidth * this.binCount;

        console.log(`Zoom in: ${(currentTotalBW/1e6).toFixed(3)} MHz -> ${(newTotalBW/1e6).toFixed(3)} MHz ` +
                    `(${this.binBandwidth.toFixed(1)} -> ${newBinBandwidth.toFixed(1)} Hz/bin, ${this.binCount} bins)`);

        // Clear peak hold before zoom to prevent misalignment
        this.peakHoldData = null;

        // Send zoom request to server - backend handles bin_count adjustment automatically
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: Math.round(newCenterFreq),
            binBandwidth: newBinBandwidth
        }));

        // Notify radioAPI immediately
        if (window.radioAPI) {
            window.radioAPI.notifyZoomChange(newBinBandwidth);
        }
    }

    // Zoom out - same bins over wider bandwidth (increase bin bandwidth)
    zoomOut() {
        console.log('[SpectrumDisplay] zoomOut() called');
        if (!this.connected || !this.ws) return;

        // Don't zoom out past initial bandwidth
        if (!this.initialBinBandwidth) {
            this.initialBinBandwidth = this.binBandwidth;
        }

        // Double the bin bandwidth = double the total bandwidth = 0.5x zoom
        let newBinBandwidth = this.binBandwidth * 2;

        // Clamp to initial bandwidth (don't zoom out past full view)
        if (newBinBandwidth >= this.initialBinBandwidth) {
            console.log('Already at full bandwidth, use Reset to return to default view');
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

        const currentTotalBW = this.binBandwidth * this.binCount;

        console.log(`Zoom out: ${(currentTotalBW/1e6).toFixed(3)} MHz -> ${(newTotalBW/1e6).toFixed(3)} MHz ` +
                    `(${this.binBandwidth.toFixed(1)} -> ${newBinBandwidth.toFixed(1)} Hz/bin)`);

        // Clear peak hold before zoom to prevent misalignment
        this.peakHoldData = null;

        // Send zoom request to server
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: Math.round(newCenterFreq),
            binBandwidth: newBinBandwidth
        }));

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

        // Send reset request to server - backend will use default config values
        this.ws.send(JSON.stringify({
            type: 'reset'
        }));
    }

    // Pan to a new center frequency (keeping current zoom level)
    panTo(frequency) {
        if (!this.connected || !this.ws) return;

        console.log(`Pan to: ${(frequency/1e6).toFixed(3)} MHz (binBandwidth: ${this.binBandwidth.toFixed(1)} Hz/bin, binCount: ${this.binCount})`);

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
        console.log('Sending pan message:', JSON.stringify(panMsg));
        this.ws.send(JSON.stringify(panMsg));
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

        // Check for supported modes
        const currentMode = window.currentMode ? window.currentMode.toLowerCase() : '';
        if (currentMode !== 'am' && currentMode !== 'sam' && currentMode !== 'usb' && currentMode !== 'lsb') {
            return;
        }

        if (!this.spectrumData || !this.currentTunedFreq || !this.totalBandwidth) {
            return;
        }

        // Initialize carrier detector if not already done
        if (!this.carrierDetector) {
            this.carrierDetector = new CarrierDetector();
        }

        const rect = e.target.getBoundingClientRect();
        const x = e.clientX - rect.left;

        // Calculate frequency range
        const startFreq = this.centerFreq - this.totalBandwidth / 2;

        // Use CarrierDetector to find carrier/edge
        const result = this.carrierDetector.detectCarrier(
            currentMode,
            this.spectrumData,
            this.currentTunedFreq,
            this.currentBandwidthLow,
            this.currentBandwidthHigh,
            startFreq,
            this.totalBandwidth
        );

        if (!result) {
            return;
        }

        // Calculate new dial frequency
        const offset = result.frequency - this.currentTunedFreq;
        const currentDialFreq = window.getCurrentDialFrequency ? window.getCurrentDialFrequency() : this.currentTunedFreq;
        let newDialFreq = Math.round(currentDialFreq + offset);

        // Account for typical 200 Hz audio offset and round to nearest 1 kHz
        if (currentMode === 'lsb') {
            // LSB: audio is below dial frequency (dial - 3000 Hz to dial - 200 Hz)
            // Detected edge is at dial - 200 Hz, so add 200 Hz to get dial frequency
            // Then round to nearest 1 kHz
            const adjustedFreq = newDialFreq + 200;
            newDialFreq = Math.round(adjustedFreq / 1000) * 1000;
        } else if (currentMode === 'usb') {
            // USB: audio is above dial frequency (dial + 200 Hz to dial + 3000 Hz)
            // Detected edge is at dial + 200 Hz, so subtract 200 Hz to get dial frequency
            // Then round to nearest 1 kHz
            const adjustedFreq = newDialFreq - 200;
            newDialFreq = Math.round(adjustedFreq / 1000) * 1000;
        }
        // AM/SAM modes don't need special rounding - use exact carrier frequency

        // Create menu text based on mode
        let menuText;
        if (currentMode === 'am' || currentMode === 'sam') {
            menuText = `Center Carrier at ${this.formatFrequency(newDialFreq)}`;
        } else {
            menuText = `Center ${currentMode.toUpperCase()} Edge at ${this.formatFrequency(newDialFreq)}`;
        }

        // Create context menu content
        this.contextMenu.innerHTML = '';
        const menuItem = document.createElement('div');
        menuItem.style.padding = '8px 16px';
        menuItem.style.cursor = 'pointer';
        menuItem.style.fontFamily = 'monospace';
        menuItem.style.fontSize = '13px';
        menuItem.textContent = menuText;

        // Hover effect
        menuItem.addEventListener('mouseenter', () => {
            menuItem.style.backgroundColor = '#007bff';
            menuItem.style.color = '#fff';
        });
        menuItem.addEventListener('mouseleave', () => {
            menuItem.style.backgroundColor = '';
            menuItem.style.color = '';
        });

        // Click handler
        menuItem.addEventListener('click', (clickEvent) => {
            clickEvent.stopPropagation();
            this.centerCarrier(newDialFreq);
            this.contextMenu.style.display = 'none';
        });

        this.contextMenu.appendChild(menuItem);

        // Position context menu at cursor
        this.contextMenu.style.left = e.clientX + 'px';
        this.contextMenu.style.top = e.clientY + 'px';
        this.contextMenu.style.display = 'block';
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

        // CRITICAL FIX: Clear any lingering prediction offset when not dragging
        // This prevents cursor/spectrum desync from persisting
        if (!this.isDragging && this.predictedFreqOffset !== 0) {
            console.log('Sync check: Clearing lingering prediction offset to prevent desync');
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
            console.log(`Sync check: Marker off-screen (tuned: ${(this.currentTunedFreq/1e6).toFixed(3)} MHz, ` +
                       `range: ${(startFreq/1e6).toFixed(3)}-${(endFreq/1e6).toFixed(3)} MHz)`);

            // If we're zoomed in, pan to bring marker back into view
            if (this.binBandwidth && this.initialBinBandwidth &&
                this.binBandwidth < this.initialBinBandwidth) {
                console.log('Sync correction: Panning to restore marker visibility');
                this.panTo(this.currentTunedFreq);
            }
        }
    }

    // Start periodic settings sync (500ms interval)
    // Sends current UI state to server to ensure spectrum and audio stay aligned
    startSettingsSync() {
        if (this.settingsSyncInterval) return;

        this.settingsSyncInterval = setInterval(() => {
            this.sendSettingsSync();
        }, 500); // 500ms = 2 times per second

        console.log('Started settings sync (500ms interval)');
    }

    // Stop periodic settings sync
    stopSettingsSync() {
        if (this.settingsSyncInterval) {
            clearInterval(this.settingsSyncInterval);
            this.settingsSyncInterval = null;
            console.log('Stopped settings sync');
        }
    }

    // Send settings sync message to server
    // Requests current status to re-sync UI state with server
    sendSettingsSync() {
        // Skip if not connected
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Skip while actively dragging (we're sending pan messages already)
        if (this.isDragging) {
            return;
        }

        // Request current status from server
        // Server will respond with 'config' message containing current centerFreq, binBandwidth, etc.
        // This re-synchronizes this.centerFreq with the actual displayed spectrum data
        this.ws.send(JSON.stringify({
            type: 'get_status'
        }));
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

            // Save current waterfall content before resize
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(this.canvas, 0, 0);

            // Adjust waterfall canvas height to only occupy bottom half
            this.canvas.width = this.width;
            this.canvas.height = 300;
            this.canvas.style.width = this.width + 'px';
            this.canvas.style.height = '300px';
            this.canvasHeight = 300;
            this.height = 300;

            // Get context (canvas resize clears it)
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = true;

            // Fill with black
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, 300);

            // Reset waterfall state to start fresh
            this.waterfallImageData = null;
            this.waterfallLineCount = 0;
            this.waterfallStartTime = null;

            console.log('Line graph (spectrum) enabled - waterfall canvas resized to 300px');
        } else {
            // Hide line graph - remove split mode class and hide
            this.lineGraphCanvas.classList.remove('split-mode');
            this.lineGraphCanvas.style.display = 'none';
            // Move waterfall to full height mode
            this.canvas.classList.remove('split-view');

            // Save current waterfall content before resize
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(this.canvas, 0, 0);

            // Restore waterfall canvas to full height
            this.canvas.width = this.width;
            this.canvas.height = 600;
            this.canvas.style.width = this.width + 'px';
            this.canvas.style.height = '600px';
            this.canvasHeight = 600;
            this.height = 600;

            // Get context (canvas resize clears it)
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = true;

            // Fill with black
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, 600);

            // Reset waterfall state to start fresh
            this.waterfallImageData = null;
            this.waterfallLineCount = 0;
            this.waterfallStartTime = null;

            // Clear the line graph canvas when hiding
            if (this.lineGraphCtx) {
                this.lineGraphCtx.clearRect(0, 0, this.lineGraphCanvas.width, this.lineGraphCanvas.height);
            }

            console.log('Line graph (spectrum) disabled - waterfall canvas resized to 600px');
        }

        // Force redraw to update display
        if (this.spectrumData && this.spectrumData.length > 0) {
            this.draw();
        }
    }
}