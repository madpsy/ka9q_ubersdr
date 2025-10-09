// Spectrum Display - Full-band FFT visualization for ka9q UberSDR
// Connects to radiod's spectrum mode via WebSocket

class SpectrumDisplay {
    constructor(canvasId, config = {}) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            throw new Error(`Canvas element '${canvasId}' not found`);
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
                
                // Save current canvas content before resize
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = this.canvas.width;
                tempCanvas.height = this.canvas.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(this.canvas, 0, 0);
                
                // Resize canvas
                this.resizeCanvas();
                this.canvasWidth = this.canvas.width;
                this.canvasHeight = this.canvas.height;
                this.width = parseInt(this.canvas.style.width);
                this.height = parseInt(this.canvas.style.height);
                
                // Restore content if dimensions changed
                if (oldWidth !== this.width || oldHeight !== this.height) {
                    // Clear canvas with black
                    this.ctx.fillStyle = '#000';
                    this.ctx.fillRect(0, 0, this.width, this.height);
                    
                    // Copy old content, scaling horizontally if needed
                    this.ctx.drawImage(tempCanvas, 0, 0, oldWidth, oldHeight, 0, 0, this.width, this.height);
                    
                    // Recreate waterfall image data for new width
                    this.waterfallImageData = this.ctx.createImageData(this.width, 1);
                    
                    // Update overlay canvas dimensions to match new width
                    this.overlayDiv.style.width = this.width + 'px';
                    this.overlayCanvas.width = this.width;
                    
                    // Redraw the bandwidth indicator with new dimensions
                    this.drawTunedFrequencyCursor();
                    
                    console.log(`Canvas resized: ${this.width}x${this.height} CSS pixels`);
                }
            }, 250); // Debounce resize events
        });
        
        // Create overlay div for cursor indicator (positioned above canvas)
        this.overlayDiv = document.createElement('div');
        this.overlayDiv.style.position = 'relative';
        this.overlayDiv.style.width = this.width + 'px';
        this.overlayDiv.style.height = '35px'; // Height for label and arrow
        this.overlayDiv.style.pointerEvents = 'auto'; // Enable pointer events for bookmark clicks
        this.overlayDiv.style.cursor = 'pointer'; // Show pointer cursor over bookmarks
        
        // Create canvas inside overlay div
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = this.width;
        this.overlayCanvas.height = 35;
        this.overlayDiv.appendChild(this.overlayCanvas);
        
        // Insert overlay div before the main canvas
        this.canvas.parentElement.insertBefore(this.overlayDiv, this.canvas);
        
        this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true });
        
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
                            window.handleBookmarkClick(bookmark.frequency, bookmark.mode);
                            return;
                        }
                    }
                }
            }
        });
        
        // Configuration
        this.config = {
            wsUrl: config.wsUrl || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/user-spectrum`,
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
        this.reconnectDelay = 1000;
        this.pingInterval = null;
        
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
        this.setupMouseHandlers();
        
        // Color gradient cache
        this.colorGradient = this.createColorGradient();
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
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }
        
        console.log('Connecting to spectrum WebSocket:', this.config.wsUrl);
        
        try {
            this.ws = new WebSocket(this.config.wsUrl);
            
            this.ws.onopen = () => {
                console.log('Spectrum WebSocket connected');
                this.connected = true;
                this.reconnectDelay = 1000;
                
                // Start keepalive ping every 15 seconds
                this.startPing();
                
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
                
                // Stop keepalive ping
                this.stopPing();
                
                if (this.config.onDisconnect) {
                    this.config.onDisconnect();
                }
                this.scheduleReconnect();
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
        
        // Stop keepalive ping
        this.stopPing();
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.connected = false;
    }
    
    // Schedule reconnection attempt
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }
        
        console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
            this.connect();
        }, this.reconnectDelay);
    }
    
    // Start sending keepalive pings
    startPing() {
        // Clear any existing ping interval
        this.stopPing();
        
        // Send ping every 15 seconds to keep session alive
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 15000);
        
        console.log('Keepalive ping started (15s interval)');
    }
    
    // Stop sending keepalive pings
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
    
    // Handle incoming WebSocket messages
    handleMessage(msg) {
        switch (msg.type) {
            case 'config':
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
        
        // Draw waterfall on main canvas
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

        // Initialize waterfall image data if needed
        if (!this.waterfallImageData) {
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
        
        // Scroll existing waterfall down by 1 pixel
        // Use drawImage like the audio waterfall does (line 832 in app.js)
        // Important: scroll from line 30 down (leave room for frequency scale at top)
        this.ctx.drawImage(this.canvas, 0, 30, this.width, this.height - 31, 0, 31, this.width, this.height - 31);
        
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
        
        // Draw the new line at y=30 (below frequency scale)
        this.ctx.putImageData(this.waterfallImageData, 0, 30);

        this.waterfallLineCount++;

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

            // Draw timestamp on left with background (at y=30 where new line appears)
            this.ctx.font = 'bold 11px monospace';
            const textWidth = this.ctx.measureText(timestamp).width;

            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            this.ctx.fillRect(0, 30, textWidth + 6, 16);

            this.ctx.fillStyle = '#ffffff';
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 2;
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';

            this.ctx.strokeText(timestamp, 3, 32);
            this.ctx.fillText(timestamp, 3, 32);
        }

        // Always draw frequency scale (it gets scrolled away otherwise)
        this.drawFrequencyScale();
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
        
        // Calculate appropriate frequency step to ensure 5-10 markers visible
        // Target: bandwidth / 7 markers, rounded to nice values
        const targetStep = this.totalBandwidth / 7;
        
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
    
    // Draw cursor showing currently tuned frequency and bandwidth on overlay canvas
    drawTunedFrequencyCursor() {
        // Clear overlay canvas
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        
        // Draw bookmarks first (so cursor appears on top)
        // This needs to be redrawn because we just cleared the canvas
        if (typeof window.drawBookmarksOnSpectrum === 'function') {
            window.drawBookmarksOnSpectrum();
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
        const xLow = ((lowFreq - startFreq) / (endFreq - startFreq)) * this.width;
        const xHigh = ((highFreq - startFreq) / (endFreq - startFreq)) * this.width;
        
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
        // Use 3 decimal places when zoomed in (zoom level > 1)
        const decimals = this.zoomLevel > 1 ? 3 : 2;
        
        if (freq >= 1e9) {
            // GHz: show 2 or 3 decimals based on zoom
            const ghz = freq / 1e9;
            return `${ghz.toFixed(decimals)} GHz`;
        } else if (freq >= 1e6) {
            // MHz: show 2 or 3 decimals based on zoom
            const mhz = freq / 1e6;
            return `${mhz.toFixed(decimals)} MHz`;
        } else if (freq >= 1e3) {
            // kHz: show 1 or 2 decimals based on zoom
            const khz = freq / 1e3;
            return `${khz.toFixed(decimals - 1)} kHz`;
        } else {
            return `${freq.toFixed(0)} Hz`;
        }
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
                                window.handleBookmarkClick(bookmark.frequency, bookmark.mode);
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
                    const modeStr = pos.bookmark.mode.toUpperCase();
                    this.tooltip.textContent = `${pos.bookmark.name}: ${freqStr} ${modeStr}`;
                    
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
        
        // Update tooltip content
        this.tooltip.textContent = `${this.formatFrequency(freq)} | ${db.toFixed(1)} dB`;
        
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
        const newCenterFreq = this.currentTunedFreq || this.centerFreq;
        
        const currentTotalBW = this.binBandwidth * this.binCount;
        const newTotalBW = newBinBandwidth * this.binCount;
        
        console.log(`Zoom in: ${(currentTotalBW/1e6).toFixed(3)} MHz -> ${(newTotalBW/1e6).toFixed(3)} MHz ` +
                    `(${this.binBandwidth.toFixed(1)} -> ${newBinBandwidth.toFixed(1)} Hz/bin, ${this.binCount} bins)`);
        
        // Send zoom request to server - backend handles bin_count adjustment automatically
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: newCenterFreq,
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
        const newCenterFreq = this.currentTunedFreq || this.centerFreq;

        const currentTotalBW = this.binBandwidth * this.binCount;
        const newTotalBW = newBinBandwidth * this.binCount;

        console.log(`Zoom out: ${(currentTotalBW/1e6).toFixed(3)} MHz -> ${(newTotalBW/1e6).toFixed(3)} MHz ` +
                    `(${this.binBandwidth.toFixed(1)} -> ${newBinBandwidth.toFixed(1)} Hz/bin)`);

        // Send zoom request to server
        this.ws.send(JSON.stringify({
            type: 'zoom',
            frequency: newCenterFreq,
            binBandwidth: newBinBandwidth
        }));
    }
    
    // Reset zoom to full view (0-30 MHz)
    resetZoom() {
        if (!this.connected || !this.ws) return;

        console.log(`Reset zoom to full bandwidth view`);

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
        if (!this.spectrumData || !this.currentTunedFreq || !this.totalBandwidth) {
            // Reset meter if no data
            const meterBar = document.getElementById('signal-meter-bar');
            const meterValue = document.getElementById('signal-meter-value');
            if (meterBar) meterBar.style.width = '0%';
            if (meterValue) meterValue.textContent = '-- dB';
            return;
        }

        // Calculate frequency range for tuned bandwidth
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const lowFreq = this.currentTunedFreq + this.currentBandwidthLow;
        const highFreq = this.currentTunedFreq + this.currentBandwidthHigh;

        // Convert frequencies to bin indices
        const lowBinFloat = ((lowFreq - startFreq) / this.totalBandwidth) * this.spectrumData.length;
        const highBinFloat = ((highFreq - startFreq) / this.totalBandwidth) * this.spectrumData.length;

        const lowBin = Math.max(0, Math.floor(lowBinFloat));
        const highBin = Math.min(this.spectrumData.length - 1, Math.ceil(highBinFloat));

        // Find peak (maximum) dB across the bandwidth
        let peakDb = -120;
        for (let i = lowBin; i <= highBin; i++) {
            if (i >= 0 && i < this.spectrumData.length) {
                peakDb = Math.max(peakDb, this.spectrumData[i]);
            }
        }
        
        // Initialize peak history array and display throttling if needed
        if (!this.peakHistory) {
            this.peakHistory = [];
            this.peakHistoryMaxAge = 500; // 500ms window
            this.lastMeterUpdate = 0;
            this.meterUpdateInterval = 100; // Update display every 100ms
        }
        
        // Add current peak to history with timestamp
        const now = Date.now();
        this.peakHistory.push({ value: peakDb, timestamp: now });
        
        // Remove peaks older than 500ms
        this.peakHistory = this.peakHistory.filter(p => now - p.timestamp <= this.peakHistoryMaxAge);
        
        // Calculate average of peaks in the window
        const avgPeakDb = this.peakHistory.reduce((sum, p) => sum + p.value, 0) / this.peakHistory.length;

        // Throttle display updates to every 100ms for smoother appearance
        if (now - this.lastMeterUpdate < this.meterUpdateInterval) {
            return;
        }
        this.lastMeterUpdate = now;

        // Update meter display using averaged peak
        const meterBar = document.getElementById('signal-meter-bar');
        const meterValue = document.getElementById('signal-meter-value');

        if (meterBar && meterValue) {
            // S-meter style logarithmic scale
            // Weak signals (-120 to -80 dB) use 0-40% of meter
            // Medium signals (-80 to -60 dB) use 40-80% of meter
            // Strong signals (-60 to -20 dB) use 80-100% of meter (highly compressed)
            let percentage;
            if (avgPeakDb < -80) {
                // Weak: -120 to -80 dB maps to 0-40%
                percentage = ((avgPeakDb + 120) / 40) * 40;
            } else if (avgPeakDb < -60) {
                // Medium: -80 to -60 dB maps to 40-80%
                percentage = 40 + ((avgPeakDb + 80) / 20) * 40;
            } else {
                // Strong: -60 to -20 dB maps to 80-100% (highly compressed)
                percentage = 80 + ((avgPeakDb + 60) / 40) * 20;
            }

            percentage = Math.max(0, Math.min(100, percentage));

            meterBar.style.width = percentage + '%';
            meterValue.textContent = avgPeakDb.toFixed(1) + ' dBFS';

            // Color code both bar and text based on signal strength
            let color;
            if (avgPeakDb >= -70) {
                color = '#28a745'; // Green - strong signal
            } else if (avgPeakDb >= -85) {
                color = '#ffc107'; // Yellow - moderate signal
            } else {
                color = '#dc3545'; // Red - weak signal
            }
            
            // Add flashing animation for extremely strong signals (above -30 dB)
            if (avgPeakDb > -30) {
                meterValue.classList.add('flashing');
            } else {
                meterValue.classList.remove('flashing');
            }

            meterBar.style.background = color;
            meterValue.style.color = color;
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
}