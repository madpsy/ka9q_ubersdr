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
        // Display mode: 'waterfall', 'graph', or 'split'
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

        // Setup mouse handlers for line graph canvas
        if (this.lineGraphCanvas) {
            this.setupLineGraphMouseHandlers();
        }

        // Set canvas size to match container
        this.resizeCanvas();

        this.ctx = this.canvas.getContext('2d', { alpha: false });
        // Disable image smoothing for crisp pixels
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.mozImageSmoothingEnabled = false;
        this.ctx.webkitImageSmoothingEnabled = false;
        this.ctx.msImageSmoothingEnabled = false;

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
                const newHeight = 600;

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

                    // Update overlay canvas dimensions to match new width
                    this.overlayDiv.style.width = this.width + 'px';
                    this.overlayCanvas.width = this.width;

                    // Update bandwidth lines canvas dimensions
                    this.bandwidthLinesCanvas.width = this.width;
                    this.bandwidthLinesCanvas.style.width = this.width + 'px';

                    // Redraw the bandwidth indicator with new dimensions
                    this.drawTunedFrequencyCursor();

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

        // Create canvas inside overlay div
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = this.width;
        this.overlayCanvas.height = 35;
        this.overlayCanvas.style.pointerEvents = 'auto'; // Enable pointer events on canvas for bookmark clicks
        this.overlayCanvas.style.cursor = 'pointer';
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

            // No bookmark under mouse, hide tooltip
            this.hideTooltip();
        });

        // Add mouseleave handler to hide tooltip when leaving overlay
        this.overlayCanvas.addEventListener('mouseleave', () => {
            this.hideTooltip();
        });

        // Add click handler for bookmarks on overlay canvas
        this.overlayCanvas.addEventListener('click', (e) => {
            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

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
                            window.handleBookmarkClick(bookmark);
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
        const wsUrlWithSession = userSessionID ? `${wsUrlBase}?user_session_id=${encodeURIComponent(userSessionID)}` : wsUrlBase;

        this.config = {
            wsUrl: config.wsUrl || wsUrlWithSession,
            minDb: config.minDb !== undefined ? config.minDb : -100,
            maxDb: config.maxDb !== undefined ? config.maxDb : 0,
            autoRange: config.autoRange === true, // Disable auto-ranging by default
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

        // Flag to prevent auto-pan when frequency is changed by clicking waterfall
        this.skipNextPan = false;

        // Auto-ranging
        this.actualMinDb = this.config.minDb;
        this.actualMaxDb = this.config.maxDb;

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
        this.panThrottleMs = 150; // Throttle pan requests to avoid backend rounding issues
        this.scrollEnabled = false; // Mouse scroll wheel disabled by default
        this.zoomScrollEnabled = false; // Zoom scroll wheel disabled by default
        this.setupMouseHandlers();
        this.setupScrollHandler();

        // Color gradient cache
        this.colorGradient = this.createColorGradient();

        // Initialize signal meter
        this.signalMeter = new SignalMeter();

        // Initialize split mode if it's the default
        if (this.displayMode === 'split') {
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
        }
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

    // Connect to spectrum WebSocket
    async connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        // Check if connection will be allowed before attempting WebSocket connection
        try {
            const userSessionID = window.userSessionID || '';
            const checkResponse = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user_session_id: userSessionID
                })
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

console.log('Connecting to spectrum WebSocket:', this.config.wsUrl);


        try {
            this.ws = new WebSocket(this.config.wsUrl);

            this.ws.onopen = () => {
                console.log('Spectrum WebSocket connected');
                this.connected = true;
                // Don't reset reconnection attempts immediately - wait for first successful message
                // This prevents resetting the counter when server immediately kicks us
                // The counter will be reset when we receive our first config message

                // Keepalive ping is now handled by idle detector based on user activity

                if (this.config.onConnect) {
                    this.config.onConnect();
                }
            };

            this.ws.onmessage = async (event) => {
                try {
                    let msg;
                    let byteLength;

                    // Check if message is binary (compressed) or text (uncompressed)
                    if (event.data instanceof Blob) {
                        // Binary message - decompress with gzip
                        const compressedData = await event.data.arrayBuffer();
                        byteLength = compressedData.byteLength;

                        // Decompress using DecompressionStream (modern browsers)
                        const decompressedStream = new Response(
                            new Blob([compressedData]).stream().pipeThrough(new DecompressionStream('gzip'))
                        );
                        const decompressedText = await decompressedStream.text();
                        msg = JSON.parse(decompressedText);
                    } else {
                        // Text message - parse directly
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

                // Store initial bin bandwidth on first config (for zoom level calculation)
                if (!this.initialBinBandwidth) {
                    this.initialBinBandwidth = this.binBandwidth;
                }

                // Update zoom level: how much we've zoomed from initial
                this.zoomLevel = this.initialBinBandwidth / this.binBandwidth;

                const startFreq = this.centerFreq - this.totalBandwidth / 2;
                const endFreq = this.centerFreq + this.totalBandwidth / 2;
                console.log(`Spectrum config: ${this.binCount} bins @ ${this.binBandwidth.toFixed(1)} Hz (zoom ${this.zoomLevel.toFixed(2)}x)`);
                console.log(`  Center: ${(this.centerFreq/1e6).toFixed(3)} MHz`);
                console.log(`  Range: ${(startFreq/1e6).toFixed(3)} - ${(endFreq/1e6).toFixed(3)} MHz`);
                console.log(`  Total BW: ${(this.totalBandwidth/1e6).toFixed(3)} MHz`);

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

                this.spectrumData = new Float32Array(N);

                // Put second half (negative frequencies) first
                for (let i = 0; i < halfBins; i++) {
                    this.spectrumData[i] = rawData[halfBins + i];
                }
                // Put first half (positive frequencies) second
                for (let i = 0; i < halfBins; i++) {
                    this.spectrumData[halfBins + i] = rawData[i];
                }

                // Log only once for debugging
                if (!this.spectrumLogged) {
                    this.spectrumLogged = true;
                    console.log(`=== SPECTRUM UNWRAPPED ===`);
                    console.log(`After unwrap - First 5 bins: ${this.spectrumData.slice(0, 5).map(v => v.toFixed(1)).join(', ')}`);
                    console.log(`After unwrap - Middle 5 bins: ${this.spectrumData.slice(1022, 1027).map(v => v.toFixed(1)).join(', ')}`);
                    console.log(`After unwrap - Last 5 bins: ${this.spectrumData.slice(-5).map(v => v.toFixed(1)).join(', ')}`);
                }

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
                break;

            case 'pong':
                // Keepalive response
                break;

            default:
                console.warn('Unknown spectrum message type:', msg.type);
        }
    }

    // Draw the spectrum display
    draw() {
        if (!this.spectrumData || this.spectrumData.length === 0) {
            this.drawPlaceholder();
            return;
        }

        // Draw based on display mode
        if (this.displayMode === 'graph') {
            // Graph-only mode: draw line graph in full height
            this.drawLineGraphFullHeight();

            // Update line graph tooltip with new data if mouse is over it
            if (this.lineGraphMouseX && this.lineGraphMouseY) {
                const x = this.lineGraphMouseX();
                const y = this.lineGraphMouseY();
                if (x >= 0 && y >= 0) {
                    this.updateLineGraphTooltip(x, y);
                }
            }
        } else if (this.displayMode === 'split') {
            // Split mode: draw line graph in top half
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
        } else {
            // Waterfall-only mode (default)
            this.drawWaterfall();
        }

        // Draw tuned frequency cursor on overlay canvas
        this.drawTunedFrequencyCursor();
    }

    // Draw waterfall display
    drawWaterfall() {
        // Auto-range if enabled
        if (this.config.autoRange) {
            this.updateAutoRange();
        }

        // Initialize waterfall image data if needed
        if (!this.waterfallImageData) {
            console.log(`[drawWaterfall] Initializing waterfall in ${this.displayMode} mode, canvas height: ${this.height}`);
            this.waterfallImageData = this.ctx.createImageData(this.width, 1);
            // Initialize with black background
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, this.height);
        }

        // Initialize start time if needed
        if (!this.waterfallStartTime) {
            this.waterfallStartTime = Date.now();
            this.waterfallLineCount = 0;
        }

        // Calculate waterfall start position based on display mode
        // In split mode (300px height), start at y=150 (halfway down)
        // In waterfall-only mode (600px height), start at y=30 (below frequency scale)
        const waterfallStartY = this.displayMode === 'split' ? 150 : 30;
        const waterfallHeight = this.height - waterfallStartY - 1;

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

        // Draw timestamps on left side frequently (about 4 visible on 600px canvas)
        // With 600px height, we want timestamps every ~150 pixels
        // At 60 fps, that's every ~150 frames = ~2.5 seconds
        const linesPerSecond = 60; // Approximate frame rate
        const secondsPerTimestamp = 2.5; // Timestamp frequency
        const linesPerTimestamp = Math.floor(linesPerSecond * secondsPerTimestamp);

        if (this.waterfallLineCount % linesPerTimestamp === 0) {
            const elapsedSeconds = Math.floor((Date.now() - this.waterfallStartTime) / 1000);
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = elapsedSeconds % 60;
            const timestamp = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

            // Draw timestamp on left with background (at waterfallStartY where new line appears)
            this.ctx.font = 'bold 11px monospace';
            const textWidth = this.ctx.measureText(timestamp).width;

            // Save current state
            this.ctx.save();

            // Set fixed height for timestamp background (not affected by canvas scaling)
            const timestampHeight = 14;
            const timestampPadding = 2;

            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            this.ctx.fillRect(0, waterfallStartY, textWidth + 6, timestampHeight);

            this.ctx.fillStyle = '#ffffff';
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 2;
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';

            this.ctx.strokeText(timestamp, 3, waterfallStartY + timestampPadding);
            this.ctx.fillText(timestamp, 3, waterfallStartY + timestampPadding);

            // Restore state
            this.ctx.restore();
        }

        // Always draw frequency scale at top (y=0)
        this.drawFrequencyScale();
    }

    // Draw frequency scale at a specific Y position
    drawFrequencyScaleAtPosition(yPos) {
        if (!this.totalBandwidth) return;

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Clear the frequency scale area completely (solid black, not transparent)
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, yPos, this.width, 30);

        // Draw semi-transparent overlay for better text contrast
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, yPos, this.width, 30);

        // Calculate appropriate frequency step
        const targetStep = this.totalBandwidth / 7;

        let freqStep;
        if (targetStep >= 5e6) {
            freqStep = 5e6;
        } else if (targetStep >= 2e6) {
            freqStep = 2e6;
        } else if (targetStep >= 1e6) {
            freqStep = 1e6;
        } else if (targetStep >= 500e3) {
            freqStep = 500e3;
        } else if (targetStep >= 200e3) {
            freqStep = 200e3;
        } else if (targetStep >= 100e3) {
            freqStep = 100e3;
        } else if (targetStep >= 50e3) {
            freqStep = 50e3;
        } else if (targetStep >= 20e3) {
            freqStep = 20e3;
        } else if (targetStep >= 10e3) {
            freqStep = 10e3;
        } else if (targetStep >= 5e3) {
            freqStep = 5e3;
        } else if (targetStep >= 2e3) {
            freqStep = 2e3;
        } else if (targetStep >= 1e3) {
            freqStep = 1e3;
        } else if (targetStep >= 500) {
            freqStep = 500;
        } else if (targetStep >= 200) {
            freqStep = 200;
        } else {
            freqStep = 100;
        }

        this.ctx.font = 'bold 13px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // Draw major ticks and labels
        const firstFreq = Math.ceil(startFreq / freqStep) * freqStep;
        for (let freq = firstFreq; freq <= endFreq; freq += freqStep) {
            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;

            // Draw major tick mark
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(x - 1, yPos, 2, 12);

            // Draw label with strong contrast
            this.ctx.fillStyle = '#ffffff';
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 3;

            const label = this.formatFrequencyScale(freq);
            this.ctx.strokeText(label, x, yPos + 20);
            this.ctx.fillText(label, x, yPos + 20);
        }

        // Draw minor ticks
        const minorStep = freqStep / 5;
        this.ctx.fillStyle = '#ffffff';
        const firstMinor = Math.ceil(startFreq / minorStep) * minorStep;
        for (let freq = firstMinor; freq <= endFreq; freq += minorStep) {
            if (Math.abs(freq % freqStep) < 1) continue;

            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;
            this.ctx.fillRect(x - 0.75, yPos, 1.5, 8);
        }
    }

    // Draw line graph in top half (split mode)
    drawLineGraph() {
        // Skip processing if not in split mode to save CPU
        if (this.displayMode !== 'split') return;
        if (!this.lineGraphCanvas || !this.lineGraphCtx || !this.spectrumData) return;

        // Set canvas size to match main canvas width
        if (this.lineGraphCanvas.width !== this.width) {
            this.lineGraphCanvas.width = this.width;
            this.lineGraphCanvas.height = 300;
            this.lineGraphCanvas.style.width = this.width + 'px';
            this.lineGraphCanvas.style.height = '300px';
        }

        const ctx = this.lineGraphCtx;
        const graphHeight = 300;
        const graphWidth = this.width;
        const graphTopMargin = 70; // Space for frequency scale at top (35px) + bookmarks overlay (35px)
        const graphDrawHeight = graphHeight - graphTopMargin; // Actual drawing area height

        // Clear canvas and set background colors
        // Top 35px: grey background for bookmarks area (matching waterfall mode)
        ctx.fillStyle = '#adb5bd'; // Grey background color from body/container
        ctx.fillRect(0, 0, graphWidth, 35);
        // Rest: black background for graph
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 35, graphWidth, graphHeight - 35);

        // Add current spectrum data to history for temporal smoothing
        const now = Date.now();
        this.lineGraphDataHistory.push({
            data: new Float32Array(this.spectrumData),
            timestamp: now
        });

        // Remove old data (keep last 5 frames or data older than 300ms)
        this.lineGraphDataHistory = this.lineGraphDataHistory
            .filter(d => now - d.timestamp <= this.lineGraphDataHistoryMaxAge)
            .slice(-this.lineGraphDataHistoryMaxSize);

        // Create smoothed data by averaging recent frames
        const smoothedData = new Float32Array(this.spectrumData.length);
        for (let i = 0; i < this.spectrumData.length; i++) {
            let sum = 0;
            for (let j = 0; j < this.lineGraphDataHistory.length; j++) {
                sum += this.lineGraphDataHistory[j].data[i];
            }
            smoothedData[i] = sum / this.lineGraphDataHistory.length;
        }

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
        const minDb = avgMinDb;
        const maxDb = avgMaxDb;
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

        // Draw frequency scale at top
        this.drawLineGraphFrequencyScale();

        // Draw dBFS scale on left side
        this.drawLineGraphDbScale(minDb, maxDb, graphHeight, graphTopMargin);
    }

    // Draw line graph in full height (graph-only mode)
    drawLineGraphFullHeight() {
        // Skip processing if not in graph mode to save CPU
        if (this.displayMode !== 'graph') return;
        if (!this.lineGraphCanvas || !this.lineGraphCtx || !this.spectrumData) return;

        // Set canvas size to match main canvas
        if (this.lineGraphCanvas.width !== this.width || this.lineGraphCanvas.height !== 600) {
            this.lineGraphCanvas.width = this.width;
            this.lineGraphCanvas.height = 600;
            this.lineGraphCanvas.style.width = this.width + 'px';
            this.lineGraphCanvas.style.height = '600px';
        }

        const ctx = this.lineGraphCtx;
        const graphHeight = 600;
        const graphWidth = this.width;
        const graphTopMargin = 70; // Space for bookmarks (35px) + frequency scale (35px) at top
        const graphDrawHeight = graphHeight - graphTopMargin;

        // Clear canvas and set background colors
        // Top 35px: grey background for bookmarks area
        ctx.fillStyle = '#adb5bd';
        ctx.fillRect(0, 0, graphWidth, 35);
        // Rest: black background for graph
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 35, graphWidth, graphHeight - 35);

        // Add current spectrum data to history for temporal smoothing
        const now = Date.now();
        this.lineGraphDataHistory.push({
            data: new Float32Array(this.spectrumData),
            timestamp: now
        });

        // Remove old data
        this.lineGraphDataHistory = this.lineGraphDataHistory
            .filter(d => now - d.timestamp <= this.lineGraphDataHistoryMaxAge)
            .slice(-this.lineGraphDataHistoryMaxSize);

        // Create smoothed data
        const smoothedData = new Float32Array(this.spectrumData.length);
        for (let i = 0; i < this.spectrumData.length; i++) {
            let sum = 0;
            for (let j = 0; j < this.lineGraphDataHistory.length; j++) {
                sum += this.lineGraphDataHistory[j].data[i];
            }
            smoothedData[i] = sum / this.lineGraphDataHistory.length;
        }

        // Find min and max values
        let currentMinDb = Infinity;
        let currentMaxDb = -Infinity;
        for (let i = 0; i < smoothedData.length; i++) {
            const db = smoothedData[i];
            if (isFinite(db)) {
                currentMinDb = Math.min(currentMinDb, db);
                currentMaxDb = Math.max(currentMaxDb, db);
            }
        }

        // Track minimum and maximum values over time
        this.lineGraphMinHistory.push({ value: currentMinDb, timestamp: now });
        this.lineGraphMinHistory = this.lineGraphMinHistory.filter(m => now - m.timestamp <= this.lineGraphMinHistoryMaxAge);
        const avgMinDb = this.lineGraphMinHistory.reduce((sum, m) => sum + m.value, 0) / this.lineGraphMinHistory.length;

        this.lineGraphMaxHistory.push({ value: currentMaxDb, timestamp: now });
        this.lineGraphMaxHistory = this.lineGraphMaxHistory.filter(m => now - m.timestamp <= this.lineGraphMaxHistoryMaxAge);
        const avgMaxDb = this.lineGraphMaxHistory.reduce((sum, m) => sum + m.value, 0) / this.lineGraphMaxHistory.length;

        const minDb = avgMinDb;
        const maxDb = avgMaxDb;
        const dbRange = maxDb - minDb;
        if (dbRange === 0 || !isFinite(dbRange)) return;

        // Create vertical gradient using the same color scheme as waterfall
        const gradient = this.createLineGraphGradient(ctx, graphHeight);

        // Draw filled area
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(0, graphHeight);

        for (let x = 0; x < graphWidth; x++) {
            const binPos = (x / graphWidth) * smoothedData.length;
            const binIndex = Math.floor(binPos);
            const binFrac = binPos - binIndex;

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

            const normalized = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            const y = graphHeight - (normalized * graphDrawHeight);

            ctx.lineTo(x, y);
        }

        ctx.lineTo(graphWidth, graphHeight);
        ctx.closePath();
        ctx.fill();

        // Update and draw peak hold line
        this.updatePeakHold(smoothedData, minDb, maxDb);
        this.drawPeakHold(ctx, graphWidth, graphHeight, graphDrawHeight, graphTopMargin, minDb, maxDb);

        // Draw frequency scale at top
        this.drawLineGraphFrequencyScale();

        // Draw dBFS scale on left side
        this.drawLineGraphDbScale(minDb, maxDb, graphDrawHeight, graphTopMargin);
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
        if (!this.peakHoldData) return;

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
    drawLineGraphFrequencyScale() {
        if (!this.totalBandwidth || !this.lineGraphCtx) return;

        const ctx = this.lineGraphCtx;
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Clear the frequency scale area (starts at 35px to leave room for bookmarks)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 35, this.width, 30);

        // Calculate appropriate frequency step based on available width
        // On narrow screens (mobile), show fewer markers to prevent overlap
        const minLabelSpacing = 80; // Minimum pixels between labels
        const calculatedMarkers = Math.floor(this.width / minLabelSpacing);
        const maxMarkers = Math.min(10, Math.max(3, calculatedMarkers)); // Cap at 10, minimum 3
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

        // Draw major ticks and labels (offset by 35px for bookmarks)
        const firstFreq = Math.ceil(startFreq / freqStep) * freqStep;
        for (let freq = firstFreq; freq <= endFreq; freq += freqStep) {
            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;

            // Draw tick mark (offset by 35px)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - 1, 35, 2, 12);

            // Draw label (offset by 35px)
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;

            const label = this.formatFrequencyScale(freq);
            ctx.strokeText(label, x, 55);
            ctx.fillText(label, x, 55);
        }

        // Draw minor ticks (at 1/5 of major step, offset by 35px)
        const minorStep = freqStep / 5;
        ctx.fillStyle = '#ffffff';
        const firstMinor = Math.ceil(startFreq / minorStep) * minorStep;
        for (let freq = firstMinor; freq <= endFreq; freq += minorStep) {
            // Skip major ticks
            if (Math.abs(freq % freqStep) < 1) continue;

            const x = ((freq - startFreq) / this.totalBandwidth) * this.width;
            // Draw minor tick (8 pixels tall, 1.5 pixels wide, offset by 35px)
            ctx.fillRect(x - 0.75, 35, 1.5, 8);
        }
    }

    // Toggle through display modes: waterfall -> split -> graph -> waterfall
    toggleLineGraph() {
        console.log(`[toggleLineGraph] Current mode: ${this.displayMode}`);

        if (this.displayMode === 'waterfall') {
            // Switch to split mode
            console.log('[toggleLineGraph] Switching to SPLIT mode');
            this.displayMode = 'split';
            this.splitModeLogged = false; // Reset flag for new split mode session

            // Ensure main canvas is visible
            this.canvas.style.display = 'block';

            // Show line graph canvas with split-mode class
            if (this.lineGraphCanvas) {
                this.lineGraphCanvas.classList.remove('graph-only-mode');
                this.lineGraphCanvas.classList.add('split-mode');
                this.lineGraphCanvas.style.display = 'block';
            }

            // Add split-view class to main canvas
            this.canvas.classList.add('split-view');

            // Update canvas height to 300px (this clears the canvas!)
            this.canvas.height = 300;
            this.height = 300;
            this.canvasHeight = 300;

            // Reset waterfall line count when entering split mode
            this.waterfallLineCount = 0;

            console.log(`[toggleLineGraph] Split mode setup complete - canvas height: ${this.canvas.height}, display: ${this.canvas.style.display}`);

            // Update bandwidth lines canvas height to 600px for split mode (to cover both graph and waterfall)
            this.bandwidthLinesCanvas.height = 600;
            this.bandwidthLinesCanvas.style.height = '600px';

            // In split mode, position overlay absolutely at top (above line graph)
            this.overlayDiv.style.position = 'absolute';
            this.overlayDiv.style.top = '0';
            this.overlayDiv.style.left = '0';
            this.overlayDiv.style.zIndex = '15'; // Above line graph (z-index: 1)
            this.overlayDiv.style.backgroundColor = '#adb5bd'; // Grey background to match page

            // Clear with black
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, 300);

            // Reset waterfall image data
            this.waterfallImageData = null;

            // Update line graph cursor style
            this.updateLineGraphCursorStyle();

        } else if (this.displayMode === 'split') {
            // Switch to graph-only mode
            console.log('[toggleLineGraph] Switching to GRAPH mode');
            this.displayMode = 'graph';

            // Hide main canvas (waterfall)
            this.canvas.style.display = 'none';
            console.log('[toggleLineGraph] Main canvas hidden for graph mode');

            // Show bandwidth lines canvas in graph-only mode (600px to cover full graph)
            this.bandwidthLinesCanvas.style.display = 'block';
            this.bandwidthLinesCanvas.height = 600;
            this.bandwidthLinesCanvas.style.height = '600px';

            // Show overlay div (bookmarks) in graph-only mode, positioned at top
            this.overlayDiv.style.display = 'block';
            this.overlayDiv.style.position = 'absolute';
            this.overlayDiv.style.top = '0';
            this.overlayDiv.style.left = '0';
            this.overlayDiv.style.zIndex = '15';
            this.overlayDiv.style.backgroundColor = '#adb5bd';

            // Show line graph canvas at full height with graph-only-mode class
            if (this.lineGraphCanvas) {
                this.lineGraphCanvas.classList.remove('split-mode');
                this.lineGraphCanvas.classList.add('graph-only-mode');
            }

        } else {
            // Switch back to waterfall-only mode
            console.log('[toggleLineGraph] Switching to WATERFALL mode');
            this.displayMode = 'waterfall';

            // Hide line graph canvas and clear it
            if (this.lineGraphCanvas) {
                this.lineGraphCanvas.classList.remove('split-mode', 'graph-only-mode');
                this.lineGraphCanvas.style.display = 'none'; // Actually hide the canvas
                console.log('[toggleLineGraph] Line graph canvas hidden');
                // Clear the line graph canvas to prevent artifacts
                if (this.lineGraphCtx) {
                    this.lineGraphCtx.fillStyle = '#000';
                    this.lineGraphCtx.fillRect(0, 0, this.lineGraphCanvas.width, this.lineGraphCanvas.height);
                }
            }

            // Show main canvas
            this.canvas.style.display = 'block';
            this.canvas.classList.remove('split-view');
            console.log(`[toggleLineGraph] Main canvas shown, display: ${this.canvas.style.display}, height: ${this.canvas.height}`);

            // Show bandwidth lines canvas and restore to 600px height
            this.bandwidthLinesCanvas.style.display = 'block';
            this.bandwidthLinesCanvas.height = 600;
            this.bandwidthLinesCanvas.style.height = '600px';

            // Show overlay div (bookmarks)
            this.overlayDiv.style.display = 'block';

            // Update canvas height back to 600px
            this.canvas.height = 600;
            this.height = 600;
            this.canvasHeight = 600;

            // Update bandwidth lines canvas height back to 600px
            this.bandwidthLinesCanvas.height = 600;
            this.bandwidthLinesCanvas.style.height = '600px';

            // Restore overlay div to original relative positioning
            this.overlayDiv.style.position = 'relative';
            this.overlayDiv.style.top = 'auto';
            this.overlayDiv.style.left = 'auto';
            this.overlayDiv.style.zIndex = 'auto';
            this.overlayDiv.style.backgroundColor = ''; // Remove background color

            // Clear the waterfall canvas
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, 600);

            // Reset waterfall image data
            this.waterfallImageData = null;
        }

        // Redraw
        if (this.spectrumData && this.spectrumData.length > 0) {
            this.draw();
        }
    }

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

                // Throttle pan requests
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (lineGraphDragDidMove && Math.abs(newCenterFreq - this.centerFreq) > 1000 && timeSinceLastPan >= this.panThrottleMs) {
                    this.panTo(newCenterFreq);
                    this.lastPanTime = now;

                    // Update drag start position for smooth continuous dragging
                    lineGraphDragStartX = x;
                    lineGraphDragStartFreq = newCenterFreq;
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
            lineGraphDragging = true;
            lineGraphDragDidMove = false;
            this.lineGraphCanvas.style.cursor = 'grabbing';

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
                const freq = startFreq + (x / this.width) * this.totalBandwidth;

                // Set flag to skip auto-pan since this frequency change is from clicking
                this.skipNextPan = true;

                this.config.onFrequencyClick(freq);
            }

            lineGraphDragging = false;
            lineGraphDragDidMove = false;
            this.updateLineGraphCursorStyle();
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
        // Skip if not in graph or split mode to save CPU
        if (this.displayMode !== 'graph' && this.displayMode !== 'split') {
            this.hideTooltip();
            return;
        }
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
        // Skip if not in graph or split mode to save CPU
        if (this.displayMode !== 'graph' && this.displayMode !== 'split') return;
        if (!this.lineGraphCanvas || !this.totalBandwidth) return;

        // Check if we're showing full bandwidth (0-30 MHz)
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;
        const isFullBandwidth = (startFreq <= 0 && endFreq >= 30e6);

        // Set cursor based on whether dragging is allowed
        this.lineGraphCanvas.style.cursor = isFullBandwidth ? 'crosshair' : 'grab';
    }

    // Draw frequency scale at top of waterfall
    drawFrequencyScale() {
        if (!this.totalBandwidth) return;

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

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
        const rect = this.canvas.getBoundingClientRect();
        this.overlayDiv.style.top = rect.top + 'px';
        this.overlayDiv.style.left = rect.left + 'px';
        this.overlayDiv.style.width = rect.width + 'px';
        this.overlayDiv.style.height = '35px';
    }

    // Draw cursor showing currently tuned frequency and bandwidth on overlay canvas
    drawTunedFrequencyCursor() {
        // Update overlay position in case canvas moved
        this.updateOverlayPosition();
        
        // Clear overlay canvas
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // Draw bookmarks first (so cursor appears on top)
        // This needs to be redrawn because we just cleared the canvas
        if (typeof window.drawBookmarksOnSpectrum === 'function') {
            window.drawBookmarksOnSpectrum(this, console.log);
        }

        if (!this.currentTunedFreq || !this.totalBandwidth) return;

        // Calculate frequency range from server data
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Only draw if tuned frequency is within range
        if (this.currentTunedFreq < startFreq || this.currentTunedFreq > endFreq) return;

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
        const labelWidth = this.overlayCtx.measureText(freqLabel).width + 10;
        const labelHeight = 16;
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

        // Draw longer downward arrow below label
        const arrowY = labelY + labelHeight;
        const arrowLength = 14; // Longer arrow
        this.overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.95)';
        this.overlayCtx.beginPath();
        this.overlayCtx.moveTo(x, arrowY + arrowLength); // Arrow tip (longer)
        this.overlayCtx.lineTo(x - 6, arrowY); // Left point
        this.overlayCtx.lineTo(x + 6, arrowY); // Right point
        this.overlayCtx.closePath();
        this.overlayCtx.fill();

        // Arrow border
        this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.stroke();

        // Draw bandwidth bracket if both edges are visible
        if (xLow >= 0 && xLow <= this.width && xHigh >= 0 && xHigh <= this.width) {
            const bracketY = 30; // Position for bracket (at bottom of overlay, top of waterfall)
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

    // Draw vertical green lines at bandwidth edges over waterfall/graph
    drawBandwidthLines(xLow, xHigh) {
        // Only draw if both edges are visible
        if (xLow < 0 || xLow > this.width || xHigh < 0 || xHigh > this.width) return;

        // Clear the bandwidth lines overlay canvas
        this.bandwidthLinesCtx.clearRect(0, 0, this.bandwidthLinesCanvas.width, this.bandwidthLinesCanvas.height);

        // Determine start Y and height based on display mode
        let startY, height;

        if (this.displayMode === 'graph') {
            // Graph-only mode: draw from where graph starts (70px after bookmarks + freq scale)
            startY = 70;
            height = 600;
        } else if (this.displayMode === 'split') {
            // Split mode: draw on line graph (from 70px where graph starts) and waterfall
            // Line graph is 300px tall, waterfall is 300px tall
            // Total height needed: 600px (to cover both)
            startY = 70; // Start where line graph drawing area begins (after bookmarks + freq scale)
            height = 600; // Cover both line graph and waterfall
        } else {
            // Waterfall-only mode: draw full height
            startY = 30; // Start below frequency scale
            height = 600;
        }

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

    // Update auto-range based on current data
    updateAutoRange() {
        if (!this.spectrumData || this.spectrumData.length === 0) {
            return;
        }

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
            // Add margin - NO SMOOTHING to prevent fading
            const targetMin = Math.floor(min - this.config.rangeMargin);
            const targetMax = Math.ceil(max + this.config.rangeMargin);

            // Direct assignment - no exponential moving average
            this.actualMinDb = targetMin;
            this.actualMaxDb = targetMax;
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
        const index = Math.floor(normalized * (this.colorGradient.length - 1));
        const colorStr = this.colorGradient[index];

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

                // Throttle pan requests to avoid backend rounding issues
                const now = Date.now();
                const timeSinceLastPan = now - this.lastPanTime;

                // Only pan if we've moved significantly and enough time has passed
                if (this.dragDidMove && Math.abs(newCenterFreq - this.centerFreq) > 1000 && timeSinceLastPan >= this.panThrottleMs) {
                    this.panTo(newCenterFreq);
                    this.lastPanTime = now;

                    // Update drag start position for smooth continuous dragging
                    this.dragStartX = this.mouseX;
                    this.dragStartFreq = newCenterFreq;
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
            this.isDragging = true;
            this.dragDidMove = false; // Track if we actually moved
            this.canvas.style.cursor = 'grabbing';

            // Prevent text selection while dragging
            e.preventDefault();
        });

        // Mouse up - stop dragging or handle click
        this.canvas.addEventListener('mouseup', (e) => {
            if (!this.spectrumData) return;

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
                // Check if click is on a bookmark (top 35 pixels where bookmarks are drawn)
                if (y <= 35 && typeof window.bookmarks !== 'undefined' && typeof window.handleBookmarkClick === 'function') {
                    const startFreq = this.centerFreq - this.totalBandwidth / 2;
                    const endFreq = this.centerFreq + this.totalBandwidth / 2;

                    // Check each bookmark to see if click is near it
                    for (let bookmark of window.bookmarks) {
                        if (bookmark.frequency >= startFreq && bookmark.frequency <= endFreq) {
                            const bookmarkX = ((bookmark.frequency - startFreq) / this.totalBandwidth) * this.width;

                            // Check if click is within 20 pixels of bookmark
                            if (Math.abs(x - bookmarkX) <= 20) {
                                window.handleBookmarkClick(bookmark);
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
                    const freq = startFreq + (x / this.width) * this.totalBandwidth;

                    // Set flag to skip auto-pan since this frequency change is from clicking
                    this.skipNextPan = true;

                    this.config.onFrequencyClick(freq);
                }
            }

            this.isDragging = false;
            this.dragDidMove = false;
            this.updateCursorStyle();
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
    }

    // Setup mouse wheel scroll handler
    setupScrollHandler() {
        // Throttle variables for scroll wheel (250ms like zoom buttons)
        let lastScrollTime = 0;
        const SCROLL_THROTTLE_MS = 250;

        // Setup checkbox handlers
        const scrollCheckbox = document.getElementById('spectrum-scroll-enable');
        const zoomScrollCheckbox = document.getElementById('spectrum-zoom-scroll-enable');
        
        // Make checkboxes mutually exclusive
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

        // Add wheel event listener to both main canvas and line graph canvas
        const handleWheel = (e) => {
            if (!this.scrollEnabled && !this.zoomScrollEnabled) return;
            if (!this.spectrumData) return;
            
            e.preventDefault();

            // Throttle scroll events to prevent rate limiting (250ms like zoom buttons)
            const now = Date.now();
            const timeSinceLastScroll = now - lastScrollTime;
            if (timeSinceLastScroll < SCROLL_THROTTLE_MS) {
                return; // Ignore this scroll event
            }
            lastScrollTime = now;
            
            if (this.zoomScrollEnabled) {
                // Zoom mode: scroll up = zoom in, scroll down = zoom out
                if (e.deltaY < 0) {
                    this.zoomIn();
                } else {
                    this.zoomOut();
                }
            } else if (this.scrollEnabled) {
                // Frequency scroll mode: scroll up = increase frequency, scroll down = decrease frequency
                const freqInput = document.getElementById('frequency');
                if (!freqInput) return;
                
                const currentFreq = parseInt(freqInput.value);
                if (isNaN(currentFreq)) return;
                
                // Scroll up = increase frequency by 100 Hz
                // Scroll down = decrease frequency by 100 Hz
                const delta = e.deltaY < 0 ? 100 : -100;
                let newFreq = currentFreq + delta;
                
                // Round to nearest 100 Hz
                newFreq = Math.round(newFreq / 100) * 100;
                
                // Clamp to valid range (100 kHz to 30 MHz)
                const MIN_FREQ = 100000;
                const MAX_FREQ = 30000000;
                newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newFreq));
                
                // Update frequency input
                freqInput.value = newFreq;
                
                // Update band buttons if function exists
                if (typeof window.updateBandButtons === 'function') {
                    window.updateBandButtons(newFreq);
                }
                
                // Update URL if function exists
                if (typeof window.updateURL === 'function') {
                    window.updateURL();
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
        this.canvas.style.cursor = isFullBandwidth ? 'default' : 'grab';
    }

    // Update tooltip content and position
    updateTooltip() {
        if (!this.spectrumData || this.mouseX < 0 || this.mouseY < 0) {
            this.hideTooltip();
            return;
        }

        // Check if mouse is over a bookmark (bookmarks are in overlay canvas at top, height 35px)
        if (window.bookmarkPositions && window.bookmarkPositions.length > 0 && this.mouseY <= 35) {
            for (let pos of window.bookmarkPositions) {
                // Check if mouse is within bookmark bounds (x position only, y is already checked)
                if (this.mouseX >= pos.x - pos.width / 2 &&
                    this.mouseX <= pos.x + pos.width / 2) {

                    // Show bookmark info
                    const freqStr = this.formatFrequency(pos.bookmark.frequency);
                    const modeStr = pos.bookmark.mode ? pos.bookmark.mode.toUpperCase() : 'N/A';
                    let tooltipText = `${pos.bookmark.name}: ${freqStr} ${modeStr}`;
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
                this.panTo(this.currentTunedFreq);
            }

            // Reset the skip flag
            this.skipNextPan = false;
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
    }

    // Zoom out - same bins over wider bandwidth (increase bin bandwidth)
    zoomOut() {
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
    }

    // Reset zoom to full view (0-30 MHz)
    resetZoom() {
        if (!this.connected || !this.ws) return;

        console.log(`Reset zoom to full bandwidth view`);

        // Clear peak hold before reset to prevent misalignment
        this.peakHoldData = null;

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
        const newDialFreq = Math.round(currentDialFreq + offset);

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
                freqInput.value = newDialFreq;

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
}