// Spectrum Display Component for UberSDR Go Client
// Displays RF spectrum and waterfall from the UberSDR server

class SpectrumDisplay {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;
        this.spectrumCtx = spectrumCanvas.getContext('2d');
        this.waterfallCtx = waterfallCanvas.getContext('2d');

        // Spectrum data
        this.spectrumData = null;
        this.centerFreq = 0;
        this.binCount = 0;
        this.binBandwidth = 0;
        this.totalBandwidth = 0;
        this.initialBinBandwidth = 0;
        this.tunedFreq = 0;  // Tuned frequency (where we're listening)
        this.bandwidthLow = 0;  // Filter bandwidth low edge (Hz, relative to tuned freq)
        this.bandwidthHigh = 0;  // Filter bandwidth high edge (Hz, relative to tuned freq)

        // Bookmarks
        this.bookmarks = [];  // Array of bookmark objects with {name, frequency, mode}
        this.modeCallback = null;  // Callback for mode changes from bookmark clicks

        // Bands
        this.bands = [];  // Array of band objects with {label, start, end, color}

        // Display parameters
        this.minDb = -100;
        this.maxDb = 0;

        // Drag state for panning
        this.dragging = false;
        this.dragStartX = 0;
        this.dragStartFreq = 0;
        this.dragThreshold = 5;  // Pixels - movement less than this is considered a click

        // Pinch-to-zoom state
        this.pinching = false;
        this.initialPinchDistance = 0;
        this.initialPinchBandwidth = 0;
        this.pinchCenterFreq = 0;

        // Frequency change callback
        this.frequencyCallback = null;

        // Control settings
        this.scrollMode = 'zoom';  // 'zoom' or 'pan'
        this.clickTuneEnabled = true;
        this.centerTuneEnabled = true;
        this.snapFrequency = 500;  // Default snap frequency in Hz

        // Cursor/tooltip state
        this.cursorX = -1;
        this.cursorFreq = 0;
        this.cursorDbValue = null;

        // Waterfall
        this.waterfallImageData = null;
        this.waterfallHistory = [];
        this.maxHistory = waterfallCanvas.height;

        // WebSocket connection
        this.ws = null;
        this.connected = false;
        this.enabled = false;

        // Mouse interaction
        this.setupMouseHandlers();

        // Initialize waterfall
        this.initWaterfall();
    }

    initWaterfall() {
        this.waterfallImageData = this.waterfallCtx.createImageData(
            this.waterfallCanvas.width,
            this.waterfallCanvas.height
        );
        // Fill with black
        for (let i = 0; i < this.waterfallImageData.data.length; i += 4) {
            this.waterfallImageData.data[i] = 0;     // R
            this.waterfallImageData.data[i + 1] = 0; // G
            this.waterfallImageData.data[i + 2] = 0; // B
            this.waterfallImageData.data[i + 3] = 255; // A
        }
    }

    enable(ws) {
        if (this.enabled) return;

        this.ws = ws;
        this.enabled = true;

        console.log(`Spectrum display enable() called with tunedFreq: ${this.tunedFreq}`);

        // Send spectrum stream enable message
        const msg = {
            type: 'spectrum_stream',
            enabled: true,
            room: 'spectrum_preview'
        };

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            console.log('Spectrum stream enabled, waiting for config...');

            // Force an initial draw to show overlays even before spectrum data arrives
            // This ensures bookmarks, bands, frequency line, and bandwidth markers are visible
            if (this.tunedFreq > 0 && this.totalBandwidth === 0) {
                // Set a temporary bandwidth for initial display (will be updated when config arrives)
                this.centerFreq = this.tunedFreq;
                this.totalBandwidth = 200000; // 200 kHz default
                this.binCount = 2048;
                this.binBandwidth = this.totalBandwidth / this.binCount;
                console.log('Setting temporary display parameters for initial draw');

                // Create dummy spectrum data for initial draw
                this.spectrumData = new Array(this.binCount).fill(-100);

                // Draw once to show overlays
                this.draw();
            }
        }
    }

    disable() {
        if (!this.enabled) return;

        this.enabled = false;

        // Send spectrum stream disable message
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'spectrum_stream',
                enabled: false,
                room: 'spectrum_preview'
            };
            this.ws.send(JSON.stringify(msg));
            console.log('Spectrum stream disabled');
        }

        // Clear displays
        this.clear();
    }

    handleMessage(data) {
        if (!this.enabled) return;

        const msgType = data.type;

        if (msgType === 'config') {
            // Configuration update
            const oldBinCount = this.binCount;
            this.centerFreq = data.centerFreq || 0;
            this.binCount = data.binCount || 0;
            this.binBandwidth = data.binBandwidth || 0;
            this.totalBandwidth = data.totalBandwidth || 0;

            // Store the maximum available bandwidth (from receiver) - only on FIRST config
            // This must be set before any zoom commands are sent to capture the true maximum
            if (this.initialBinBandwidth === 0 && oldBinCount === 0) {
                this.initialBinBandwidth = this.binBandwidth;
                console.log(`Initial receiver bandwidth: ${this.initialBinBandwidth} Hz/bin`);
            }

            console.log(`Spectrum config: ${this.binCount} bins @ ${this.binBandwidth.toFixed(2)} Hz/bin = ${(this.totalBandwidth/1000).toFixed(1)} kHz total`);

            // Send initial zoom to 200 kHz if this is first config
            // Use tunedFreq if set, otherwise fall back to centerFreq
            if (oldBinCount === 0 && this.binCount > 0) {
                const zoomFreq = this.tunedFreq || this.centerFreq;
                const initialZoomBandwidth = 200000; // 200 kHz initial view
                console.log(`Sending initial zoom to ${zoomFreq} Hz (tunedFreq: ${this.tunedFreq}, centerFreq: ${this.centerFreq})`);
                this.sendZoomCommand(zoomFreq, initialZoomBandwidth);

                // Store the initial zoom bandwidth for reset functionality
                this.initialZoomBandwidth = initialZoomBandwidth;
            }
        } else if (msgType === 'spectrum') {
            // Spectrum data update
            const rawData = data.data || [];

            if (rawData.length > 0) {
                // Unwrap FFT bin ordering
                const N = rawData.length;
                const halfBins = Math.floor(N / 2);

                // Rearrange: [negative freqs, positive freqs]
                this.spectrumData = [...rawData.slice(halfBins), ...rawData.slice(0, halfBins)];

                // Update displays
                this.draw();
            }
        }
    }

    sendZoomCommand(frequency, bandwidth) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;

        // Constrain frequency to keep view within 10 kHz - 30 MHz
        const halfBw = bandwidth / 2;
        const minCenter = 10000 + halfBw;
        const maxCenter = 30000000 - halfBw;
        const constrainedFreq = Math.max(minCenter, Math.min(maxCenter, frequency));

        const binBandwidth = bandwidth / this.binCount;

        const command = {
            type: 'zoom',
            frequency: constrainedFreq,
            binBandwidth: binBandwidth
        };

        console.log(`Sending zoom: ${(bandwidth/1000).toFixed(1)} kHz at ${(constrainedFreq/1e6).toFixed(3)} MHz (${binBandwidth.toFixed(2)} Hz/bin) - requested ${(frequency/1e6).toFixed(3)} MHz`);
        this.ws.send(JSON.stringify(command));
    }

    sendPanCommand(frequency) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.totalBandwidth === 0) return;

        // Constrain frequency to keep view within 10 kHz - 30 MHz
        const halfBw = this.totalBandwidth / 2;
        const minCenter = 10000 + halfBw;
        const maxCenter = 30000000 - halfBw;
        const constrainedFreq = Math.max(minCenter, Math.min(maxCenter, frequency));

        const command = {
            type: 'pan',
            frequency: constrainedFreq
        };

        console.log(`Sending pan: ${(constrainedFreq/1e6).toFixed(3)} MHz (bandwidth: ${(this.totalBandwidth/1000).toFixed(1)} kHz)`);
        this.ws.send(JSON.stringify(command));
    }

    draw() {
        if (!this.spectrumData) return;

        // Auto-range dB scale
        const validData = this.spectrumData.filter(v => isFinite(v));
        if (validData.length > 0) {
            const p1 = this.percentile(validData, 1);
            const p99 = this.percentile(validData, 99);
            // Ensure percentile values are finite before using them
            if (isFinite(p1) && isFinite(p99)) {
                this.minDb = p1 - 2;
                this.maxDb = p99 + 5;
            } else {
                // Fallback to safe defaults if percentiles are invalid
                this.minDb = -100;
                this.maxDb = 0;
            }
        } else {
            // No valid data - use safe defaults
            this.minDb = -100;
            this.maxDb = 0;
        }

        this.drawSpectrum();
        this.drawWaterfall();

        // Update SNR and peak frequency displays
        this.updateSignalMetrics();

        // Redraw cursor and tooltip if active
        if (this.cursorX >= 0) {
            // Recalculate dB value at cursor position with updated spectrum data
            const marginLeft = 50;
            const marginRight = 20;
            const graphWidth = this.spectrumCanvas.width - marginLeft - marginRight;
            const x = this.cursorX - marginLeft;

            if (x >= 0 && x <= graphWidth && this.spectrumData && this.spectrumData.length > 0) {
                const binIndex = Math.floor((x / graphWidth) * this.spectrumData.length);
                if (binIndex >= 0 && binIndex < this.spectrumData.length) {
                    this.cursorDbValue = this.spectrumData[binIndex];
                }
            }

            this.drawCursorLine(this.spectrumCanvas, this.cursorX);
            this.drawCursorLine(this.waterfallCanvas, this.cursorX);

            // Determine which canvas to draw tooltip on based on cursor position
            const rect = this.spectrumCanvas.getBoundingClientRect();
            const scaleY = this.spectrumCanvas.height / rect.height;
            const canvasY = this.cursorY * scaleY;

            // Draw appropriate tooltip based on what we're hovering over
            if (this.hoveringBookmark) {
                // Redraw bookmark tooltip
                const mode = (this.hoveringBookmark.mode || 'USB').toUpperCase();
                const freqMhz = (this.cursorFreq / 1e6).toFixed(6);
                const tooltipText = `${this.hoveringBookmark.name}\n${freqMhz} MHz\n${mode}`;
                this.drawBookmarkTooltip(this.cursorCanvas, this.cursorX, this.cursorY, tooltipText, this.hoveringBookmark.isLocal);
            } else if (this.cursorCanvas === this.spectrumCanvas) {
                this.drawTooltip(this.spectrumCanvas, this.cursorX, canvasY, this.cursorFreq, this.cursorDbValue);
            } else {
                this.drawTooltip(this.waterfallCanvas, this.cursorX, canvasY, this.cursorFreq, this.cursorDbValue);
            }
        }
    }

    drawSpectrum() {
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;

        // Clear
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        if (!this.spectrumData || this.spectrumData.length === 0) return;

        const marginLeft = 50;
        const marginRight = 20;
        const marginTop = 30;
        const marginBottom = 30;  // Increased to make room for frequency scale
        const graphWidth = width - marginLeft - marginRight;
        const graphHeight = height - marginTop - marginBottom;

        // Draw band backgrounds FIRST (behind everything)
        this.drawBandBackgrounds(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);

        // Draw dB scale
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';

        for (let i = 0; i < 5; i++) {
            const db = this.minDb + (i / 4) * (this.maxDb - this.minDb);
            const y = marginTop + graphHeight - (i / 4) * graphHeight;

            ctx.fillText(db.toFixed(0), marginLeft - 10, y + 4);

            // Grid line
            ctx.strokeStyle = '#333333';
            ctx.beginPath();
            ctx.moveTo(marginLeft, y);
            ctx.lineTo(marginLeft + graphWidth, y);
            ctx.stroke();
        }

        // Draw frequency scale at bottom
        this.drawFrequencyScale(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);

        // Draw spectrum line
        const dbRange = this.maxDb - this.minDb;
        if (dbRange === 0) return;

        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.beginPath();

        let firstPoint = true;
        for (let i = 0; i < this.spectrumData.length; i++) {
            const db = this.spectrumData[i];
            if (!isFinite(db)) continue;

            const x = marginLeft + (i / this.spectrumData.length) * graphWidth;
            const normalized = Math.max(0, Math.min(1, (db - this.minDb) / dbRange));
            const y = marginTop + graphHeight - (normalized * graphHeight);

            if (firstPoint) {
                ctx.moveTo(x, y);
                firstPoint = false;
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();

        // Draw filled area
        ctx.fillStyle = 'rgba(30, 144, 255, 0.3)';
        ctx.lineTo(marginLeft + graphWidth, marginTop + graphHeight);
        ctx.lineTo(marginLeft, marginTop + graphHeight);
        ctx.closePath();
        ctx.fill();

        // Draw bookmarks (above spectrum)
        this.drawBookmarks(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);

        // Draw tuned frequency marker and bandwidth filter
        this.drawTunedFrequencyMarker(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);
        this.drawBandwidthFilter(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);
    }

    drawBandBackgrounds(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (!this.bands || this.bands.length === 0 || this.totalBandwidth === 0) {
            console.log('drawBandBackgrounds: skipping - bands=', this.bands?.length, 'totalBandwidth=', this.totalBandwidth);
            return;
        }

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Y position and height for band section (aligned with bookmark tops at Y=0)
        const bandY = 0;
        const bandHeight = 18;

        // First, fill entire bookmark section with light grey to show gaps between bands
        ctx.fillStyle = '#d3d3d3';
        ctx.fillRect(marginLeft, bandY, graphWidth, bandHeight);

        // Sort bands by width (widest first) for proper layering
        const sortedBands = [...this.bands].sort((a, b) => {
            const widthA = a.end - a.start;
            const widthB = b.end - b.start;
            return widthB - widthA;
        });

        // Draw colored rectangles for each band
        for (const band of sortedBands) {
            const bandStart = band.start || 0;
            const bandEnd = band.end || 0;

            // Check if band overlaps with visible range
            if (bandEnd < startFreq || bandStart > endFreq) continue;

            // Calculate visible portion of band
            const visibleStart = Math.max(bandStart, startFreq);
            const visibleEnd = Math.min(bandEnd, endFreq);

            // Calculate x positions
            const startX = marginLeft + ((visibleStart - startFreq) / this.totalBandwidth) * graphWidth;
            const endX = marginLeft + ((visibleEnd - startFreq) / this.totalBandwidth) * graphWidth;
            const width = endX - startX;

            // Draw colored rectangle with semi-transparent stipple pattern
            ctx.fillStyle = band.color || '#cccccc';
            ctx.globalAlpha = 0.6;
            ctx.fillRect(startX, bandY, width, bandHeight);
            ctx.globalAlpha = 1.0;
        }

        // Draw band labels with intelligent spacing
        for (const band of this.bands) {
            const bandStart = band.start || 0;
            const bandEnd = band.end || 0;
            const label = band.label || 'Unknown';

            // Check if band overlaps with visible range
            if (bandEnd < startFreq || bandStart > endFreq) continue;

            // Calculate visible portion of band
            const visibleStart = Math.max(bandStart, startFreq);
            const visibleEnd = Math.min(bandEnd, endFreq);

            // Calculate x positions
            const startX = marginLeft + ((visibleStart - startFreq) / this.totalBandwidth) * graphWidth;
            const endX = marginLeft + ((visibleEnd - startFreq) / this.totalBandwidth) * graphWidth;
            const width = endX - startX;

            // Measure label width
            ctx.font = 'bold 9px monospace';
            const labelWidth = ctx.measureText(label).width;

            // Determine how many labels to draw based on band width
            // Only show label if band is wide enough (at least 50 pixels)
            if (width < 50) continue;

            const labelSpacing = labelWidth + 60;  // Increased minimum spacing between labels
            const numLabels = Math.max(1, Math.floor(width / labelSpacing));

            // Draw labels
            ctx.fillStyle = 'black';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (numLabels === 1) {
                // Single label in center
                const centerX = (startX + endX) / 2;
                ctx.fillText(label, centerX, bandY + bandHeight / 2);
            } else {
                // Multiple labels evenly spaced
                for (let i = 0; i < numLabels; i++) {
                    const labelX = startX + (width / (numLabels + 1)) * (i + 1);
                    ctx.fillText(label, labelX, bandY + bandHeight / 2);
                }
            }
        }
    }

    drawBookmarks(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (!this.bookmarks || this.bookmarks.length === 0 || this.totalBandwidth === 0) {
            console.log('drawBookmarks: skipping - bookmarks=', this.bookmarks?.length, 'totalBandwidth=', this.totalBandwidth);
            return;
        }

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Y position for bookmarks (above spectrum, below the orange frequency label)
        const bookmarkY = 0;

        for (const bookmark of this.bookmarks) {
            const freq = bookmark.frequency || 0;
            const name = bookmark.name || 'Unknown';

            // Only draw if bookmark is within visible range
            if (freq < startFreq || freq > endFreq) continue;

            // Calculate x position
            const freqOffset = freq - startFreq;
            const x = marginLeft + (freqOffset / this.totalBandwidth) * graphWidth;

            // Draw bookmark label with color based on whether it's local or server
            const labelWidth = name.length * 7 + 8;
            const labelHeight = 12;

            // Choose color: cyan for local bookmarks, gold for server bookmarks
            const bookmarkColor = bookmark.isLocal ? '#00CED1' : '#FFD700';

            // Colored background
            ctx.fillStyle = bookmarkColor;
            ctx.fillRect(x - labelWidth / 2, bookmarkY, labelWidth, labelHeight);

            // White border
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - labelWidth / 2, bookmarkY, labelWidth, labelHeight);

            // Black text
            ctx.fillStyle = 'black';
            ctx.font = 'bold 9px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(name, x, bookmarkY + 6);

            // Draw downward arrow below label
            const arrowY = bookmarkY + labelHeight;
            const arrowLength = 6;

            // Arrow triangle (same color as bookmark with white border)
            ctx.fillStyle = bookmarkColor;
            ctx.beginPath();
            ctx.moveTo(x, arrowY + arrowLength);  // Tip
            ctx.lineTo(x - 4, arrowY);             // Left
            ctx.lineTo(x + 4, arrowY);             // Right
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.stroke();
        }
    }

    drawTunedFrequencyMarker(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (this.tunedFreq === 0 || this.totalBandwidth === 0) {
            console.log('drawTunedFrequencyMarker: skipping - tunedFreq=', this.tunedFreq, 'totalBandwidth=', this.totalBandwidth);
            return;
        }

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Check if tuned frequency is visible
        if (this.tunedFreq < startFreq || this.tunedFreq > endFreq) {
            console.log('drawTunedFrequencyMarker: tuned freq not visible - tunedFreq=', this.tunedFreq, 'range=', startFreq, '-', endFreq);
            return;
        }

        // Calculate x position
        const freqOffset = this.tunedFreq - startFreq;
        const x = marginLeft + (freqOffset / this.totalBandwidth) * graphWidth;

        // Draw vertical dashed line
        ctx.strokeStyle = '#FFA500';  // Orange
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x, marginTop);
        ctx.lineTo(x, marginTop + graphHeight);
        ctx.stroke();
        ctx.setLineDash([]);  // Reset dash
        ctx.lineWidth = 1;

        // Draw frequency label above the line (moved down to avoid overlap with bands/bookmarks)
        const freqMhz = this.tunedFreq / 1e6;
        ctx.fillStyle = '#FFA500';  // Orange
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${freqMhz.toFixed(6)} MHz`, x, marginTop - 5);
    }

    drawBandwidthFilter(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (this.totalBandwidth === 0 || this.tunedFreq === 0) {
            return;
        }
        if (this.bandwidthLow === 0 && this.bandwidthHigh === 0) {
            return;
        }
        // Check for undefined bandwidth values
        if (this.bandwidthLow === undefined || this.bandwidthHigh === undefined) {
            console.warn('drawBandwidthFilter: bandwidth values are undefined!');
            return;
        }

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Calculate filter edge frequencies
        const filterLowFreq = this.tunedFreq + this.bandwidthLow;
        const filterHighFreq = this.tunedFreq + this.bandwidthHigh;

        // Check if filter overlaps with visible range (allow partial visibility)
        if (filterHighFreq < startFreq || filterLowFreq > endFreq) {
            return;
        }

        // Clamp filter edges to visible range for drawing
        const visibleLowFreq = Math.max(filterLowFreq, startFreq);
        const visibleHighFreq = Math.min(filterHighFreq, endFreq);

        // Calculate x positions for visible portion
        const lowX = marginLeft + ((visibleLowFreq - startFreq) / this.totalBandwidth) * graphWidth;
        const highX = marginLeft + ((visibleHighFreq - startFreq) / this.totalBandwidth) * graphWidth;

        // Draw semi-transparent yellow overlay for visible portion
        ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
        ctx.fillRect(lowX, marginTop, highX - lowX, graphHeight);

        // Draw solid yellow lines at filter edges (only if edge is visible)
        ctx.strokeStyle = '#FFFF00';  // Yellow
        ctx.lineWidth = 2;
        
        // Draw low edge line if it's within visible range
        if (filterLowFreq >= startFreq && filterLowFreq <= endFreq) {
            ctx.beginPath();
            ctx.moveTo(lowX, marginTop);
            ctx.lineTo(lowX, marginTop + graphHeight);
            ctx.stroke();
        }
        
        // Draw high edge line if it's within visible range
        if (filterHighFreq >= startFreq && filterHighFreq <= endFreq) {
            const highEdgeX = marginLeft + ((filterHighFreq - startFreq) / this.totalBandwidth) * graphWidth;
            ctx.beginPath();
            ctx.moveTo(highEdgeX, marginTop);
            ctx.lineTo(highEdgeX, marginTop + graphHeight);
            ctx.stroke();
        }
        
        ctx.lineWidth = 1;
    }

    drawFrequencyScale(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (this.totalBandwidth === 0) return;

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const scaleY = this.spectrumCanvas.height - marginBottom + 10;

        ctx.fillStyle = '#ffffff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';

        // Draw 5 frequency markers
        for (let i = 0; i < 5; i++) {
            const freq = startFreq + (i / 4) * this.totalBandwidth;
            const x = marginLeft + (i / 4) * graphWidth;

            // Draw tick
            ctx.strokeStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(x, scaleY - 5);
            ctx.lineTo(x, scaleY);
            ctx.stroke();

            // Draw label
            const freqMhz = freq / 1e6;
            ctx.fillText(freqMhz.toFixed(3), x, scaleY + 10);
        }
    }

    drawWaterfall() {
        if (!this.spectrumData || this.spectrumData.length === 0) return;

        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;

        // Use same margins as spectrum display
        const marginLeft = 50;
        const marginRight = 20;
        const graphWidth = width - marginLeft - marginRight;

        // Scroll waterfall down
        const imageData = this.waterfallImageData;
        const data = imageData.data;

        // Shift pixels down by one row
        for (let y = height - 1; y > 0; y--) {
            for (let x = 0; x < width; x++) {
                const srcIdx = ((y - 1) * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                data[dstIdx] = data[srcIdx];
                data[dstIdx + 1] = data[srcIdx + 1];
                data[dstIdx + 2] = data[srcIdx + 2];
                data[dstIdx + 3] = 255;
            }
        }

        // Add new spectrum line at top (only in the graph area)
        const dbRange = this.maxDb - this.minDb;

        // Fill left margin with black
        for (let x = 0; x < marginLeft; x++) {
            const idx = x * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
        }

        // Fill graph area with spectrum data
        for (let x = 0; x < graphWidth; x++) {
            const binIdx = Math.floor((x / graphWidth) * this.spectrumData.length);
            const db = this.spectrumData[binIdx];

            if (isFinite(db)) {
                const normalized = Math.max(0, Math.min(1, (db - this.minDb) / dbRange));
                const rgb = this.dbToRgb(normalized);

                const canvasX = marginLeft + x;
                const idx = canvasX * 4;
                data[idx] = rgb[0];
                data[idx + 1] = rgb[1];
                data[idx + 2] = rgb[2];
                data[idx + 3] = 255;
            }
        }

        // Fill right margin with black
        for (let x = marginLeft + graphWidth; x < width; x++) {
            const idx = x * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
        }

        // Draw to canvas
        this.waterfallCtx.putImageData(imageData, 0, 0);

        // Draw tuned frequency marker and bandwidth filter on waterfall
        this.drawTunedFrequencyMarkerOnWaterfall();
        this.drawBandwidthFilterOnWaterfall();
    }

    drawTunedFrequencyMarkerOnWaterfall() {
        if (this.tunedFreq === 0 || this.totalBandwidth === 0) return;

        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        const marginLeft = 50;
        const marginRight = 20;
        const graphWidth = width - marginLeft - marginRight;

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Check if tuned frequency is visible
        if (this.tunedFreq < startFreq || this.tunedFreq > endFreq) return;

        // Calculate x position
        const freqOffset = this.tunedFreq - startFreq;
        const x = marginLeft + (freqOffset / this.totalBandwidth) * graphWidth;

        // Draw vertical dashed line
        ctx.strokeStyle = '#FFA500';  // Orange
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.setLineDash([]);  // Reset dash
        ctx.lineWidth = 1;
    }

    drawBandwidthFilterOnWaterfall() {
        if (this.totalBandwidth === 0 || this.tunedFreq === 0) return;
        if (this.bandwidthLow === 0 && this.bandwidthHigh === 0) return;

        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        const marginLeft = 50;
        const marginRight = 20;
        const graphWidth = width - marginLeft - marginRight;

        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const endFreq = this.centerFreq + this.totalBandwidth / 2;

        // Calculate filter edge frequencies
        const filterLowFreq = this.tunedFreq + this.bandwidthLow;
        const filterHighFreq = this.tunedFreq + this.bandwidthHigh;

        // Check if filter overlaps with visible range (allow partial visibility)
        if (filterHighFreq < startFreq || filterLowFreq > endFreq) return;

        // Clamp filter edges to visible range for drawing
        const visibleLowFreq = Math.max(filterLowFreq, startFreq);
        const visibleHighFreq = Math.min(filterHighFreq, endFreq);

        // Calculate x positions for visible portion
        const lowX = marginLeft + ((visibleLowFreq - startFreq) / this.totalBandwidth) * graphWidth;
        const highX = marginLeft + ((visibleHighFreq - startFreq) / this.totalBandwidth) * graphWidth;

        // Draw semi-transparent yellow overlay for visible portion
        ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
        ctx.fillRect(lowX, 0, highX - lowX, height);

        // Draw solid yellow lines at filter edges (only if edge is visible)
        ctx.strokeStyle = '#FFFF00';  // Yellow
        ctx.lineWidth = 2;
        
        // Draw low edge line if it's within visible range
        if (filterLowFreq >= startFreq && filterLowFreq <= endFreq) {
            ctx.beginPath();
            ctx.moveTo(lowX, 0);
            ctx.lineTo(lowX, height);
            ctx.stroke();
        }
        
        // Draw high edge line if it's within visible range
        if (filterHighFreq >= startFreq && filterHighFreq <= endFreq) {
            const highEdgeX = marginLeft + ((filterHighFreq - startFreq) / this.totalBandwidth) * graphWidth;
            ctx.beginPath();
            ctx.moveTo(highEdgeX, 0);
            ctx.lineTo(highEdgeX, height);
            ctx.stroke();
        }
        
        ctx.lineWidth = 1;
    }

    dbToRgb(normalized) {
        // Color gradient: blue (low) -> cyan -> green -> yellow -> red (high)
        let r, g, b;

        if (normalized < 0.25) {
            const t = normalized / 0.25;
            r = 0;
            g = Math.floor(t * 255);
            b = 255;
        } else if (normalized < 0.5) {
            const t = (normalized - 0.25) / 0.25;
            r = 0;
            g = 255;
            b = Math.floor((1 - t) * 255);
        } else if (normalized < 0.75) {
            const t = (normalized - 0.5) / 0.25;
            r = Math.floor(t * 255);
            g = 255;
            b = 0;
        } else {
            const t = (normalized - 0.75) / 0.25;
            r = 255;
            g = Math.floor((1 - t) * 255);
            b = 0;
        }

        return [r, g, b];
    }

    percentile(arr, p) {
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.floor((p / 100) * sorted.length);
        return sorted[index];
    }

    // Calculate signal metrics (SNR and peak frequency/dB)
    calculateSignalMetrics() {
        if (!this.spectrumData || this.spectrumData.length === 0 || this.totalBandwidth === 0) {
            return { snr: null, peakFreq: null, peakDb: null, floorDb: null };
        }

        const validData = this.spectrumData.filter(v => isFinite(v));
        if (validData.length === 0) {
            return { snr: null, peakFreq: null, peakDb: null, floorDb: null };
        }

        // Calculate noise floor (minimum dB in full spectrum)
        const floorDb = Math.min(...validData);

        // Find peak in bandwidth if tuned frequency is set
        let peakDb, peakFreq;

        if (this.tunedFreq > 0 && this.bandwidthLow !== 0 && this.bandwidthHigh !== 0) {
            // Calculate signal metrics within the bandwidth filter
            const startFreq = this.centerFreq - this.totalBandwidth / 2;

            // Calculate absolute frequencies for bandwidth edges
            const filterLowFreq = this.tunedFreq + this.bandwidthLow;
            const filterHighFreq = this.tunedFreq + this.bandwidthHigh;

            // Map frequencies to bin indices
            const lowBin = Math.floor((filterLowFreq - startFreq) / this.totalBandwidth * this.spectrumData.length);
            const highBin = Math.floor((filterHighFreq - startFreq) / this.totalBandwidth * this.spectrumData.length);

            // Ensure bins are within valid range
            const clampedLowBin = Math.max(0, Math.min(this.spectrumData.length - 1, lowBin));
            const clampedHighBin = Math.max(0, Math.min(this.spectrumData.length - 1, highBin));

            // Extract bandwidth data
            const bandwidthData = this.spectrumData.slice(clampedLowBin, clampedHighBin + 1);
            const validBandwidthData = bandwidthData.filter(v => isFinite(v));

            if (validBandwidthData.length > 0) {
                // Find peak (maximum) dB within the bandwidth
                peakDb = Math.max(...validBandwidthData);

                // Find the bin index of the peak within the bandwidth
                const peakBinInBandwidth = bandwidthData.indexOf(peakDb);
                const peakBinIndex = clampedLowBin + peakBinInBandwidth;

                // Calculate peak frequency
                const freqOffset = (peakBinIndex / this.spectrumData.length - 0.5) * this.totalBandwidth;
                peakFreq = this.centerFreq + freqOffset;
            }
        } else {
            // No bandwidth filter set - find peak in full spectrum
            peakDb = Math.max(...validData);

            // Find the bin index of the peak
            const peakBinIndex = this.spectrumData.indexOf(peakDb);

            // Calculate peak frequency
            const freqOffset = (peakBinIndex / this.spectrumData.length - 0.5) * this.totalBandwidth;
            peakFreq = this.centerFreq + freqOffset;
        }

        // Calculate SNR
        const snr = peakDb !== undefined ? peakDb - floorDb : null;

        return { snr, peakFreq, peakDb, floorDb };
    }

    // Update the signal metrics display elements
    updateSignalMetrics() {
        const metrics = this.calculateSignalMetrics();

        // Update SNR display
        const snrDisplay = document.getElementById('spectrum-snr-display');
        const snrValue = document.getElementById('spectrum-snr-value');
        const snrNumber = document.getElementById('spectrum-snr-number');

        if (snrDisplay && snrValue && snrNumber && metrics.snr !== null && metrics.snr !== undefined) {
            snrNumber.textContent = metrics.snr.toFixed(1);

            // Color based on SNR quality (matching Python client)
            // Color the value and "dB", not the "SNR:" label
            if (metrics.snr >= 20) {
                snrValue.style.color = '#00ff00';  // Green - excellent
            } else if (metrics.snr >= 10) {
                snrValue.style.color = '#ffff00';  // Yellow - good
            } else {
                snrValue.style.color = '#ff6600';  // Orange - poor
            }

            snrDisplay.style.display = 'block';
        } else if (snrDisplay) {
            snrDisplay.style.display = 'none';
        }

        // Update peak frequency/dB display
        const peakDisplay = document.getElementById('spectrum-peak-display');
        const peakFreqSpan = document.getElementById('spectrum-peak-freq');
        const peakLevelSpan = document.getElementById('spectrum-peak-level');

        if (peakDisplay && peakFreqSpan && peakLevelSpan &&
            metrics.peakFreq !== null && metrics.peakFreq !== undefined &&
            metrics.peakDb !== null && metrics.peakDb !== undefined) {
            peakFreqSpan.textContent = (metrics.peakFreq / 1e6).toFixed(4);
            peakLevelSpan.textContent = metrics.peakDb.toFixed(1);
            peakDisplay.style.display = 'block';
        } else if (peakDisplay) {
            peakDisplay.style.display = 'none';
        }
    }

    setupMouseHandlers() {
        // Touch event support
        this.setupTouchHandlers();

        // Mouse wheel for zoom or frequency stepping
        const handleWheel = (e) => {
            // Do nothing if scroll mode is 'none' (both checkboxes unchecked)
            if (this.scrollMode === 'none') {
                return;
            }

            e.preventDefault();

            if (this.scrollMode === 'zoom') {
                // Zoom mode: scroll to zoom in/out
                if (e.deltaY < 0) {
                    this.zoomIn();
                } else {
                    this.zoomOut();
                }
            } else if (this.scrollMode === 'pan') {
                // Pan mode: scroll to step frequency up/down
                // This matches Python client behavior where pan mode steps frequency
                if (!this.frequencyCallback) return;

                // Get current frequency
                const currentFreq = this.tunedFreq || 14074000;
                const stepSize = this.snapFrequency; // Use configurable snap frequency
                const direction = e.deltaY < 0 ? 1 : -1; // Scroll up = increase freq
                const newFreq = currentFreq + (direction * stepSize);

                // Call frequency callback to update frequency
                this.frequencyCallback(newFreq);
            }
        };

        this.spectrumCanvas.addEventListener('wheel', handleWheel);
        this.waterfallCanvas.addEventListener('wheel', handleWheel);

        // Mouse down - start drag
        const handleMouseDown = (e) => {
            this.dragging = true;
            this.dragStartX = e.offsetX;
            this.dragStartFreq = this.centerFreq;
        };

        this.spectrumCanvas.addEventListener('mousedown', handleMouseDown);
        this.waterfallCanvas.addEventListener('mousedown', handleMouseDown);

        // Mouse up - end drag or process click
        const handleMouseUp = (e) => {
            if (this.dragging) {
                const dragDistance = Math.abs(e.offsetX - this.dragStartX);
                if (dragDistance < this.dragThreshold) {
                    // Small movement - treat as click
                    this.handleClick(e);
                }
            }
            this.dragging = false;
        };

        this.spectrumCanvas.addEventListener('mouseup', handleMouseUp);
        this.waterfallCanvas.addEventListener('mouseup', handleMouseUp);

        // Mouse move - handle drag and tooltip
        const handleMouseMove = (e) => {
            const canvas = e.target;
            const rect = canvas.getBoundingClientRect();
            const marginLeft = 50;
            const marginRight = 20;
            const marginTop = 30;
            const graphWidth = canvas.width - marginLeft - marginRight;

            // Get mouse position relative to canvas (accounting for canvas scaling)
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const canvasX = (e.clientX - rect.left) * scaleX;
            const canvasY = (e.clientY - rect.top) * scaleY;

            // Handle dragging
            if (this.dragging && this.totalBandwidth !== 0) {
                // Calculate frequency change based on pixel movement
                const dx = e.offsetX - this.dragStartX;
                const freqPerPixel = this.totalBandwidth / graphWidth;
                const freqChange = -dx * freqPerPixel;  // Negative for natural drag direction

                let newCenter = this.dragStartFreq + freqChange;

                // Constrain to valid range (keep view within 10 kHz - 30 MHz)
                const halfBw = this.totalBandwidth / 2;
                const minCenter = 10000 + halfBw;
                const maxCenter = 30000000 - halfBw;
                newCenter = Math.max(minCenter, Math.min(maxCenter, newCenter));

                // Check if tuned frequency will be off-screen after pan
                if (this.tunedFreq !== 0) {
                    const startFreq = newCenter - halfBw;
                    const endFreq = newCenter + halfBw;

                    // If tuned frequency is outside the new view, retune to keep it visible
                    if (this.tunedFreq < startFreq || this.tunedFreq > endFreq) {
                        let newTunedFreq;
                        if (this.tunedFreq < startFreq) {
                            // Tuned freq is off the left edge - retune to left edge
                            newTunedFreq = startFreq + (halfBw * 0.1);  // 10% from edge
                        } else {
                            // Tuned freq is off the right edge - retune to right edge
                            newTunedFreq = endFreq - (halfBw * 0.1);  // 10% from edge
                        }

                        // Snap to configured boundary
                        newTunedFreq = Math.round(newTunedFreq / this.snapFrequency) * this.snapFrequency;

                        // Call frequency callback to update tuned frequency
                        if (this.frequencyCallback) {
                            this.frequencyCallback(newTunedFreq);
                        }
                    }
                }

                // Send pan command
                this.sendPanCommand(newCenter);
            }

            // Handle tooltip/cursor (when not dragging)
        if (!this.dragging && this.totalBandwidth !== 0) {
            const x = canvasX - marginLeft;

            // Check if hovering over a bookmark (only on spectrum canvas)
            const bookmarkSectionBottom = marginTop - 10;
            if (canvas === this.spectrumCanvas && canvasY < bookmarkSectionBottom && this.bookmarks && this.bookmarks.length > 0) {
                const startFreq = this.centerFreq - this.totalBandwidth / 2;
                const endFreq = this.centerFreq + this.totalBandwidth / 2;

                // Check which bookmark we're hovering over
                let foundBookmark = false;
                for (const bookmark of this.bookmarks) {
                    const freq = bookmark.frequency || 0;
                    if (freq < startFreq || freq > endFreq) continue;

                    const freqOffset = freq - startFreq;
                    const bookmarkX = marginLeft + (freqOffset / this.totalBandwidth) * graphWidth;
                    const name = bookmark.name || 'Unknown';
                    const labelWidth = name.length * 7 + 8;

                    // Check if mouse is over this bookmark
                    if (Math.abs(canvasX - bookmarkX) < labelWidth / 2) {
                        // Hovering over bookmark - show bookmark tooltip
                        foundBookmark = true;
                        this.cursorX = canvasX;
                        this.cursorY = canvasY;
                        this.cursorCanvas = canvas;
                        this.cursorFreq = freq;
                        this.cursorDbValue = null;
                        this.hoveringBookmark = bookmark;  // Store bookmark for redraw

                        // Draw cursor line on both canvases
                        this.drawCursorLine(this.spectrumCanvas, canvasX);
                        this.drawCursorLine(this.waterfallCanvas, canvasX);

                        // Draw bookmark tooltip
                        const mode = (bookmark.mode || 'USB').toUpperCase();
                        const freqMhz = (freq / 1e6).toFixed(6);
                        const tooltipText = `${name}\n${freqMhz} MHz\n${mode}`;
                        this.drawBookmarkTooltip(canvas, canvasX, canvasY, tooltipText, bookmark.isLocal);
                        return;
                    }
                }

                // If we're in bookmark section but not over a bookmark, clear and return
                if (!foundBookmark) {
                    this.hoveringBookmark = null;
                    this.cursorX = -1;
                    this.draw();
                    return;
                }
            }

                // Clear bookmark hover state when in normal tooltip area
                this.hoveringBookmark = null;

                // Clear tooltip and cursor if outside graph area
                if (x < 0 || x > graphWidth) {
                    this.cursorX = -1;
                    this.draw();
                    return;
                }

                // Calculate frequency at cursor
                const freqOffset = (x / graphWidth - 0.5) * this.totalBandwidth;
                const freq = this.centerFreq + freqOffset;

                // Get dB value at cursor position
                let dbValue = null;
                if (this.spectrumData && this.spectrumData.length > 0) {
                    const binIndex = Math.floor((x / graphWidth) * this.spectrumData.length);
                    if (binIndex >= 0 && binIndex < this.spectrumData.length) {
                        dbValue = this.spectrumData[binIndex];
                    }
                }

                // Store cursor state
                this.cursorX = canvasX;
                this.cursorY = e.clientY - rect.top;
                this.cursorCanvas = canvas;
                this.cursorFreq = freq;
                this.cursorDbValue = dbValue;

                // Draw cursor line on both canvases
                this.drawCursorLine(this.spectrumCanvas, canvasX);
                this.drawCursorLine(this.waterfallCanvas, canvasX);

                // Draw tooltip on the canvas being hovered
                this.drawTooltip(canvas, canvasX, canvasY, freq, dbValue);
            }
        };

        this.spectrumCanvas.addEventListener('mousemove', handleMouseMove);
        this.waterfallCanvas.addEventListener('mousemove', handleMouseMove);

        // Mouse leave - clear tooltip
        const handleMouseLeave = () => {
            if (!this.dragging) {
                this.cursorX = -1;
                this.hoveringBookmark = null;
                this.draw();
            }
        };

        this.spectrumCanvas.addEventListener('mouseleave', handleMouseLeave);
        this.waterfallCanvas.addEventListener('mouseleave', handleMouseLeave);
    }

    setupTouchHandlers() {
        // Touch start - begin drag or pinch
        const handleTouchStart = (e) => {
            if (e.touches.length === 1) {
                e.preventDefault();
                const touch = e.touches[0];
                const rect = e.target.getBoundingClientRect();
                const scaleX = e.target.width / rect.width;
                const offsetX = (touch.clientX - rect.left) * scaleX;

                this.dragging = true;
                this.dragStartX = offsetX;
                this.dragStartFreq = this.centerFreq;
                this.pinching = false;
            } else if (e.touches.length === 2) {
                e.preventDefault();
                // Start pinch-to-zoom
                this.pinching = true;
                this.dragging = false;

                const touch1 = e.touches[0];
                const touch2 = e.touches[1];

                // Calculate initial distance between fingers
                const dx = touch2.clientX - touch1.clientX;
                const dy = touch2.clientY - touch1.clientY;
                this.initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
                this.initialPinchBandwidth = this.totalBandwidth;

                // Calculate center point of pinch (in frequency space)
                const rect = e.target.getBoundingClientRect();
                const scaleX = e.target.width / rect.width;
                const marginLeft = 50;
                const marginRight = 20;
                const graphWidth = e.target.width - marginLeft - marginRight;

                const centerX = ((touch1.clientX + touch2.clientX) / 2 - rect.left) * scaleX;
                const x = centerX - marginLeft;

                if (x >= 0 && x <= graphWidth && this.totalBandwidth !== 0) {
                    const freqOffset = (x / graphWidth - 0.5) * this.totalBandwidth;
                    this.pinchCenterFreq = this.centerFreq + freqOffset;
                } else {
                    this.pinchCenterFreq = this.centerFreq;
                }
            }
        };

        this.spectrumCanvas.addEventListener('touchstart', handleTouchStart, { passive: false });
        this.waterfallCanvas.addEventListener('touchstart', handleTouchStart, { passive: false });

        // Touch move - handle drag or pinch
        const handleTouchMove = (e) => {
            if (e.touches.length === 1 && this.dragging && !this.pinching) {
                e.preventDefault();
                const touch = e.touches[0];
                const canvas = e.target;
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const offsetX = (touch.clientX - rect.left) * scaleX;

                if (this.totalBandwidth !== 0) {
                    const marginLeft = 50;
                    const marginRight = 20;
                    const graphWidth = canvas.width - marginLeft - marginRight;

                    // Calculate frequency change based on pixel movement
                    const dx = offsetX - this.dragStartX;
                    const freqPerPixel = this.totalBandwidth / graphWidth;
                    const freqChange = -dx * freqPerPixel;

                    let newCenter = this.dragStartFreq + freqChange;

                    // Constrain to valid range
                    const halfBw = this.totalBandwidth / 2;
                    const minCenter = 10000 + halfBw;
                    const maxCenter = 30000000 - halfBw;
                    newCenter = Math.max(minCenter, Math.min(maxCenter, newCenter));

                    // Check if tuned frequency will be off-screen after pan
                    if (this.tunedFreq !== 0) {
                        const startFreq = newCenter - halfBw;
                        const endFreq = newCenter + halfBw;

                        if (this.tunedFreq < startFreq || this.tunedFreq > endFreq) {
                            let newTunedFreq;
                            if (this.tunedFreq < startFreq) {
                                newTunedFreq = startFreq + (halfBw * 0.1);
                            } else {
                                newTunedFreq = endFreq - (halfBw * 0.1);
                            }

                            newTunedFreq = Math.round(newTunedFreq / this.snapFrequency) * this.snapFrequency;

                            if (this.frequencyCallback) {
                                this.frequencyCallback(newTunedFreq);
                            }
                        }
                    }

                    // Send pan command
                    this.sendPanCommand(newCenter);
                }
            } else if (e.touches.length === 2 && this.pinching) {
                e.preventDefault();

                const touch1 = e.touches[0];
                const touch2 = e.touches[1];

                // Calculate current distance between fingers
                const dx = touch2.clientX - touch1.clientX;
                const dy = touch2.clientY - touch1.clientY;
                const currentDistance = Math.sqrt(dx * dx + dy * dy);

                // Calculate zoom factor based on pinch distance change
                const distanceRatio = this.initialPinchDistance / currentDistance;

                // Calculate new bandwidth (inverse relationship: pinch in = zoom in = smaller bandwidth)
                let newBandwidth = this.initialPinchBandwidth * distanceRatio;

                // Constrain bandwidth to reasonable limits
                const minBandwidth = this.binCount * 1; // 1 Hz/bin minimum
                // Allow zooming out up to the maximum receiver bandwidth if available
                const maxBandwidth = this.initialBinBandwidth > 0 ? this.initialBinBandwidth * this.binCount : Infinity;
                newBandwidth = Math.max(minBandwidth, Math.min(maxBandwidth, newBandwidth));

                // Calculate new bin bandwidth
                const newBinBandwidth = newBandwidth / this.binCount;

                // Constrain center frequency to keep view within 10 kHz - 30 MHz
                const halfBandwidth = newBandwidth / 2;
                const minCenter = 10000 + halfBandwidth;
                const maxCenter = 30000000 - halfBandwidth;

                // Constrain the pinch center to valid range
                let zoomCenter = this.pinchCenterFreq;
                zoomCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));

                // Send zoom command
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const command = {
                        type: 'zoom',
                        frequency: zoomCenter,
                        binBandwidth: newBinBandwidth
                    };
                    console.log(`Pinch zoom: ${(newBandwidth/1000).toFixed(1)} kHz at ${(zoomCenter/1e6).toFixed(3)} MHz`);
                    this.ws.send(JSON.stringify(command));
                }
            }
        };

        this.spectrumCanvas.addEventListener('touchmove', handleTouchMove, { passive: false });
        this.waterfallCanvas.addEventListener('touchmove', handleTouchMove, { passive: false });

        // Touch end - end drag/pinch or process tap
        const handleTouchEnd = (e) => {
            if (e.touches.length === 0) {
                // All fingers lifted
                if (this.dragging && !this.pinching) {
                    e.preventDefault();
                    const touch = e.changedTouches[0];
                    const rect = e.target.getBoundingClientRect();
                    const scaleX = e.target.width / rect.width;
                    const offsetX = (touch.clientX - rect.left) * scaleX;

                    const dragDistance = Math.abs(offsetX - this.dragStartX);
                    if (dragDistance < this.dragThreshold) {
                        // Small movement - treat as tap
                        // Create a synthetic event for handleClick
                        const syntheticEvent = {
                            target: e.target,
                            clientX: touch.clientX,
                            clientY: touch.clientY
                        };
                        this.handleClick(syntheticEvent);
                    }
                }
                this.dragging = false;
                this.pinching = false;
            } else if (e.touches.length === 1 && this.pinching) {
                // One finger lifted during pinch - switch back to drag mode
                e.preventDefault();
                this.pinching = false;
                this.dragging = true;

                const touch = e.touches[0];
                const rect = e.target.getBoundingClientRect();
                const scaleX = e.target.width / rect.width;
                const offsetX = (touch.clientX - rect.left) * scaleX;

                this.dragStartX = offsetX;
                this.dragStartFreq = this.centerFreq;
            }
        };

        this.spectrumCanvas.addEventListener('touchend', handleTouchEnd, { passive: false });
        this.waterfallCanvas.addEventListener('touchend', handleTouchEnd, { passive: false });

        // Touch cancel - end drag/pinch
        const handleTouchCancel = () => {
            this.dragging = false;
            this.pinching = false;
        };

        this.spectrumCanvas.addEventListener('touchcancel', handleTouchCancel);
        this.waterfallCanvas.addEventListener('touchcancel', handleTouchCancel);
    }

    handleClick(e) {
        if (this.totalBandwidth === 0) return;

        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const marginLeft = 50;
        const marginRight = 20;
        const marginTop = 30;
        const graphWidth = canvas.width - marginLeft - marginRight;

        // Get click position relative to canvas (accounting for canvas scaling)
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        // Check if click is in bookmark section (above spectrum graph)
        const bookmarkSectionBottom = marginTop - 10;  // Just above orange frequency label
        if (canvasY < bookmarkSectionBottom && this.bookmarks && this.bookmarks.length > 0) {
            // Click is in bookmark area - check which bookmark was clicked
            const startFreq = this.centerFreq - this.totalBandwidth / 2;
            const endFreq = this.centerFreq + this.totalBandwidth / 2;

            for (const bookmark of this.bookmarks) {
                const freq = bookmark.frequency || 0;
                // Skip bookmarks outside visible range
                if (freq < startFreq || freq > endFreq) continue;

                // Calculate bookmark x position
                const freqOffset = freq - startFreq;
                const x = marginLeft + (freqOffset / this.totalBandwidth) * graphWidth;

                // Check if click is within bookmark bounds
                const name = bookmark.name || 'Unknown';
                const labelWidth = name.length * 7 + 8;
                if (Math.abs(canvasX - x) < labelWidth / 2) {
                    // Clicked on this bookmark - tune to it
                    this.handleBookmarkClick(bookmark);
                    return;
                }
            }
        }

        // Normal click-to-tune behavior (only if enabled)
        if (!this.clickTuneEnabled) return;

        const x = canvasX - marginLeft;
        if (x < 0 || x > graphWidth) return;

        // Map x position to frequency offset from center (-0.5 to +0.5 of bandwidth)
        const freqOffset = (x / graphWidth - 0.5) * this.totalBandwidth;
        const clickedFreq = this.centerFreq + freqOffset;

        // Snap to nearest boundary based on snap setting
        const newFreq = Math.round(clickedFreq / this.snapFrequency) * this.snapFrequency;

        // Call frequency callback to tune to clicked frequency
        if (this.frequencyCallback) {
            this.frequencyCallback(newFreq);
        }

        // If center-tune is enabled, also re-center the spectrum on the new frequency
        if (this.centerTuneEnabled && this.ws && this.ws.readyState === WebSocket.OPEN) {
            setTimeout(() => {
                this.sendZoomCommand(newFreq, this.totalBandwidth);
            }, 100); // Small delay to let frequency update propagate
        }
    }

    handleBookmarkClick(bookmark) {
        const freq = bookmark.frequency || 0;
        const mode = bookmark.mode || 'USB';

        console.log(`Bookmark clicked: ${bookmark.name} - ${freq} Hz, ${mode}`);

        // Call mode callback FIRST to change mode before frequency
        if (mode && this.modeCallback) {
            this.modeCallback(mode.toUpperCase());
        }

        // Then call frequency callback to tune to bookmark frequency
        // Use a longer delay to ensure mode change is sent to server first
        if (freq && this.frequencyCallback) {
            setTimeout(() => {
                this.frequencyCallback(freq);
            }, 150);
        }
    }

    drawCursorLine(canvas, x) {
        const ctx = canvas.getContext('2d');

        // Save the current state
        ctx.save();

        // Draw dashed white vertical line
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();

        // Restore the state
        ctx.restore();
    }

    drawTooltip(canvas, x, y, freq, dbValue) {
        const ctx = canvas.getContext('2d');

        // Format tooltip text
        let text = `${(freq / 1e6).toFixed(6)} MHz`;
        if (dbValue !== null && !isNaN(dbValue)) {
            text += `\n${dbValue.toFixed(1)} dB`;
        }

        // Set font for measuring
        ctx.font = 'bold 9px monospace';

        // Measure text size
        const lines = text.split('\n');
        const lineHeight = 14;
        const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
        const textHeight = lines.length * lineHeight;

        // Position tooltip (left or right of cursor depending on space)
        let tooltipX, anchor;
        if (x > canvas.width / 2) {
            tooltipX = x - 10;
            anchor = 'right';
        } else {
            tooltipX = x + 10;
            anchor = 'left';
        }
        const tooltipY = y - 10;

        // Draw white background
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);

        let bgX, bgY, bgWidth, bgHeight;
        if (anchor === 'right') {
            bgX = tooltipX - textWidth - 4;
            bgY = tooltipY - textHeight / 2 - 2;
            bgWidth = textWidth + 4;
            bgHeight = textHeight + 4;
        } else {
            bgX = tooltipX - 2;
            bgY = tooltipY - textHeight / 2 - 2;
            bgWidth = textWidth + 4;
            bgHeight = textHeight + 4;
        }

        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
        ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

        // Draw text
        ctx.fillStyle = 'black';
        ctx.textBaseline = 'middle';
        ctx.textAlign = anchor === 'right' ? 'right' : 'left';

        lines.forEach((line, i) => {
            const lineY = tooltipY - textHeight / 2 + (i + 0.5) * lineHeight;
            const lineX = anchor === 'right' ? tooltipX - 2 : tooltipX + 2;
            ctx.fillText(line, lineX, lineY);
        });
    }

    drawBookmarkTooltip(canvas, x, y, text, isLocal) {
        const ctx = canvas.getContext('2d');

        // Set font for measuring
        ctx.font = 'bold 10px monospace';

        // Measure text size
        const lines = text.split('\n');
        const lineHeight = 16;
        const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
        const textHeight = lines.length * lineHeight;

        // Position tooltip (left or right of cursor depending on space)
        let tooltipX, anchor;
        if (x > canvas.width / 2) {
            tooltipX = x - 10;
            anchor = 'right';
        } else {
            tooltipX = x + 10;
            anchor = 'left';
        }
        const tooltipY = y + 10;  // Below cursor for bookmarks

        // Draw background with color matching bookmark type (cyan for local, gold for server)
        const bookmarkColor = isLocal ? '#00CED1' : '#FFD700';
        ctx.fillStyle = bookmarkColor;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);

        let bgX, bgY, bgWidth, bgHeight;
        const padding = 6;
        if (anchor === 'right') {
            bgX = tooltipX - textWidth - padding * 2;
            bgY = tooltipY - padding;
            bgWidth = textWidth + padding * 2;
            bgHeight = textHeight + padding * 2;
        } else {
            bgX = tooltipX;
            bgY = tooltipY - padding;
            bgWidth = textWidth + padding * 2;
            bgHeight = textHeight + padding * 2;
        }

        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
        ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

        // Draw text in black
        ctx.fillStyle = 'black';
        ctx.textBaseline = 'top';
        ctx.textAlign = anchor === 'right' ? 'right' : 'left';

        lines.forEach((line, i) => {
            const lineY = tooltipY + i * lineHeight;
            const lineX = anchor === 'right' ? tooltipX - padding : tooltipX + padding;
            ctx.fillText(line, lineX, lineY);
        });
    }

    zoomIn() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;

        // Halve the bin bandwidth = half the total bandwidth = 2x zoom
        const newBinBandwidth = this.binBandwidth / 2;

        // Minimum practical limit
        if (newBinBandwidth < 1) {
            console.log('Maximum zoom reached (1 Hz/bin minimum)');
            return;
        }

        // Calculate new total bandwidth
        const newTotalBandwidth = newBinBandwidth * this.binCount;

        // Prefer tuned frequency, but constrain to keep view within 10 kHz - 30 MHz
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 10000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;

        // Start with preferred center (tuned freq or current center)
        let zoomCenter = this.tunedFreq || this.centerFreq;

        // Constrain to valid range
        zoomCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));

        console.log(`Zoom in: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz at ${(zoomCenter/1e6).toFixed(3)} MHz`);

        this.sendZoomCommand(zoomCenter, newTotalBandwidth);
    }

    zoomOut() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;

        // Double the bin bandwidth = double the total bandwidth = 0.5x zoom
        let newBinBandwidth = this.binBandwidth * 2;

        // Don't zoom out past the maximum receiver bandwidth if we know it
        if (this.initialBinBandwidth > 0 && newBinBandwidth > this.initialBinBandwidth) {
            // Check if we're already at max
            if (this.binBandwidth >= this.initialBinBandwidth) {
                console.log('Already at full receiver bandwidth');
                return;
            }
            // Clamp to max receiver bandwidth
            newBinBandwidth = this.initialBinBandwidth;
        }

        // Calculate new total bandwidth
        const newTotalBandwidth = newBinBandwidth * this.binCount;

        // Prefer tuned frequency, but constrain to keep view within 10 kHz - 30 MHz
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 10000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;

        // Start with preferred center (tuned freq or current center)
        let zoomCenter = this.tunedFreq || this.centerFreq;

        // Constrain to valid range
        zoomCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));

        console.log(`Zoom out: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz at ${(zoomCenter/1e6).toFixed(3)} MHz`);

        this.sendZoomCommand(zoomCenter, newTotalBandwidth);
    }

    zoomReset() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0 || this.initialBinBandwidth === 0) return;

        // Reset to full receiver bandwidth (zoom all the way out)
        const newTotalBandwidth = this.initialBinBandwidth * this.binCount;

        // Center at 15 MHz (half of 30 MHz) to show full HF spectrum
        const zoomCenter = 15000000;

        // Constrain center frequency
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 10000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;
        const constrainedCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));

        console.log(`Zoom reset: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz at ${(constrainedCenter/1e6).toFixed(1)} MHz`);

        this.sendZoomCommand(constrainedCenter, newTotalBandwidth);
    }

    zoomMax() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;

        // Zoom to maximum bandwidth (1 Hz/bin minimum)
        const newBinBandwidth = 1;
        const newTotalBandwidth = newBinBandwidth * this.binCount;

        // Center on tuned frequency
        const zoomCenter = this.tunedFreq || this.centerFreq;

        // Constrain center frequency
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 10000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;
        const constrainedCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));

        console.log(`Zoom max: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz`);

        this.sendZoomCommand(constrainedCenter, newTotalBandwidth);
    }

    setFrequencyCallback(callback) {
        this.frequencyCallback = callback;
    }

    setScrollMode(mode) {
        this.scrollMode = mode;
        console.log(`Spectrum scroll mode set to: ${mode}`);
    }

    setClickTuneEnabled(enabled) {
        this.clickTuneEnabled = enabled;
        console.log(`Spectrum click-to-tune ${enabled ? 'enabled' : 'disabled'}`);
    }

    setCenterTuneEnabled(enabled) {
        this.centerTuneEnabled = enabled;
        console.log(`Spectrum center-tune ${enabled ? 'enabled' : 'disabled'}`);
    }

    setSnapFrequency(snapHz) {
        this.snapFrequency = snapHz;
        console.log(`Spectrum snap frequency set to: ${snapHz} Hz`);
    }

    updateBandwidth(low, high) {
        console.log(`updateBandwidth called with low=${low}, high=${high}`);
        this.bandwidthLow = low;
        this.bandwidthHigh = high;
        console.log(`After setting: this.bandwidthLow=${this.bandwidthLow}, this.bandwidthHigh=${this.bandwidthHigh}`);
        // Trigger redraw if spectrum data exists
        if (this.spectrumData) {
            console.log('Triggering draw() from updateBandwidth');
            this.draw();
        } else {
            console.log('No spectrum data yet, skipping draw()');
        }
    }

    setBookmarks(bookmarks) {
        this.bookmarks = bookmarks || [];
        console.log(`Spectrum display: ${this.bookmarks.length} bookmarks set`);
        // Redraw to show bookmarks
        if (this.spectrumData) {
            this.draw();
        }
    }

    setBands(bands) {
        this.bands = bands || [];
        console.log(`Spectrum display: ${this.bands.length} bands set`);
        // Redraw to show bands
        if (this.spectrumData) {
            this.draw();
        }
    }

    setModeCallback(callback) {
        this.modeCallback = callback;
    }


    clear() {
        // Clear spectrum
        this.spectrumCtx.fillStyle = '#000000';
        this.spectrumCtx.fillRect(0, 0, this.spectrumCanvas.width, this.spectrumCanvas.height);

        // Clear waterfall
        this.initWaterfall();
        this.waterfallCtx.putImageData(this.waterfallImageData, 0, 0);

        this.spectrumData = null;
    }
}