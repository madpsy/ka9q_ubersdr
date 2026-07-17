/**
 * Maidenhead Grid Overlay for Leaflet
 *
 * Draws 2-char (field), 4-char (square) and 6-char (subsquare) Maidenhead
 * locator grid lines and labels on a Leaflet map using a single <canvas>
 * element that is redrawn on every map move/zoom.  Labels are always centred
 * inside their grid square and are suppressed when the square is too small to
 * fit the text.
 *
 * Zoom thresholds (defaults, overridable via options):
 *   zoom < minZoom        → nothing drawn
 *   minZoom ≤ zoom < zoom4 → 2-char fields  (20° × 10°)
 *   zoom4   ≤ zoom < zoom6 → 4-char squares (2° × 1°)
 *   zoom    ≥ zoom6        → 6-char subsquares (5′ × 2.5′)
 */

class MaidenheadGrid {
    constructor(map, options = {}) {
        this.map = map;
        this.options = {
            color:       options.color       || '#ffdd00',
            weight:      options.weight      !== undefined ? options.weight      : 1,
            opacity:     options.opacity     !== undefined ? options.opacity     : 0.75,
            showLabels:  options.showLabels  !== undefined ? options.showLabels  : true,
            labelColor:  options.labelColor  || '#ffdd00',
            minZoom:     options.minZoom     !== undefined ? options.minZoom     : 2,
            zoom4:       options.zoom4       !== undefined ? options.zoom4       : 5,
            zoom6:       options.zoom6       !== undefined ? options.zoom6       : 9,
            // Minimum pixel width/height a grid cell must have before its label is drawn
            minLabelPx:  options.minLabelPx  !== undefined ? options.minLabelPx  : 40,
            // Font size for labels (px)
            fontSize:    options.fontSize    !== undefined ? options.fontSize    : 11,
        };

        this._wantGrid  = false;
        this._canvas    = null;
        this._ctx       = null;
        this._container = null;

        this.highlightLayer     = null;
        this.highlightedSquares = new Map();

        this._onMoveEnd  = null;
        this._onZoomEnd  = null;
        this._onViewReset= null;
    }

    // ── Bounds helpers ────────────────────────────────────────────────────────

    fieldToBounds(field) {
        const f = field.toUpperCase();
        const west  = (f.charCodeAt(0) - 65) * 20 - 180;
        const south = (f.charCodeAt(1) - 65) * 10 - 90;
        return { south, west, north: south + 10, east: west + 20 };
    }

    squareToBounds(locator) {
        const f = locator.substring(0, 2).toUpperCase();
        const s = locator.substring(2, 4);
        const west  = (f.charCodeAt(0) - 65) * 20 - 180 + parseInt(s[0]) * 2;
        const south = (f.charCodeAt(1) - 65) * 10 - 90  + parseInt(s[1]);
        return { south, west, north: south + 1, east: west + 2 };
    }

    subsquareToBounds(locator) {
        const sq  = this.squareToBounds(locator.substring(0, 4));
        const sub = locator.substring(4, 6).toLowerCase();
        const subLon = (sub.charCodeAt(0) - 97) * (2 / 24);
        const subLat = (sub.charCodeAt(1) - 97) * (1 / 24);
        const west  = sq.west  + subLon;
        const south = sq.south + subLat;
        return { south, west, north: south + (1 / 24), east: west + (2 / 24) };
    }

    // Legacy alias
    locatorToBounds(locator) { return this.squareToBounds(locator); }

    // ── Canvas layer ──────────────────────────────────────────────────────────

    _createCanvas() {
        if (this._canvas) return;

        // Place the canvas directly inside the map container (not a pane) so
        // it is never shifted by Leaflet's panning transforms.  We cover the
        // map exactly and use latLngToContainerPoint for all coordinates.
        const mapContainer = this.map.getContainer();
        const canvas = document.createElement('canvas');
        canvas.style.position      = 'absolute';
        canvas.style.top           = '0';
        canvas.style.left          = '0';
        canvas.style.pointerEvents = 'none';
        // Sit above tile panes (z-index ~200) but below controls (~1000)
        canvas.style.zIndex        = '400';
        mapContainer.appendChild(canvas);
        this._canvas = canvas;
        this._ctx    = canvas.getContext('2d');
    }

    _removeCanvas() {
        if (this._canvas) {
            this._canvas.parentNode && this._canvas.parentNode.removeChild(this._canvas);
            this._canvas = null;
            this._ctx    = null;
        }
    }

    _redraw() {
        if (!this._wantGrid || !this._canvas) return;

        const map  = this.map;
        const zoom = map.getZoom();
        const size = map.getSize();
        const dpr  = window.devicePixelRatio || 1;

        // Size the canvas to match the map container exactly
        this._canvas.width        = size.x * dpr;
        this._canvas.height       = size.y * dpr;
        this._canvas.style.width  = size.x + 'px';
        this._canvas.style.height = size.y + 'px';

        const ctx = this._ctx;
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.save();
        ctx.scale(dpr, dpr);
        // No translate needed — latLngToContainerPoint already returns coords
        // relative to the map container, which is exactly where our canvas sits.

        if (zoom < this.options.minZoom) { ctx.restore(); return; }

        // Choose grid level
        let items, boundsOf;
        if (zoom >= this.options.zoom6) {
            items    = this._visibleSubsquares();
            boundsOf = loc => this.subsquareToBounds(loc);
        } else if (zoom >= this.options.zoom4) {
            items    = this._visibleSquares();
            boundsOf = loc => this.squareToBounds(loc);
        } else {
            items    = this._visibleFields();
            boundsOf = loc => this.fieldToBounds(loc);
        }

        // Parse colour + apply opacity
        const col = this._hexToRgb(this.options.color);
        const strokeStyle = col
            ? `rgba(${col.r},${col.g},${col.b},${this.options.opacity})`
            : this.options.color;
        const labelStyle = col
            ? `rgba(${col.r},${col.g},${col.b},${Math.min(1, this.options.opacity + 0.2)})`
            : this.options.color;

        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth   = this.options.weight;

        const fontSize = this.options.fontSize;
        ctx.font        = `bold ${fontSize}px monospace`;
        ctx.textAlign   = 'center';
        ctx.textBaseline= 'middle';

        const minPx = this.options.minLabelPx;

        items.forEach(loc => {
            const bnd = boundsOf(loc);

            // Convert corners to pixel coords (container-relative)
            const sw = map.latLngToContainerPoint(L.latLng(bnd.south, bnd.west));
            const ne = map.latLngToContainerPoint(L.latLng(bnd.north, bnd.east));

            const x = Math.min(sw.x, ne.x);
            const y = Math.min(sw.y, ne.y);
            const w = Math.abs(ne.x - sw.x);
            const h = Math.abs(ne.y - sw.y);

            // Skip cells entirely outside the canvas
            if (x + w < 0 || x > size.x || y + h < 0 || y > size.y) return;

            ctx.strokeRect(x, y, w, h);

            // Draw label only when the cell is large enough
            if (this.options.showLabels && w >= minPx && h >= minPx) {
                const cx = x + w / 2;
                const cy = y + h / 2;

                // Dark halo for legibility
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                ctx.strokeText(loc, cx, cy);

                ctx.fillStyle   = labelStyle;
                ctx.strokeStyle = strokeStyle;
                ctx.lineWidth   = this.options.weight;
                ctx.fillText(loc, cx, cy);
            }
        });

        ctx.restore();
    }

    _hexToRgb(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null;
    }

    // ── Visible locator generators ────────────────────────────────────────────

    _visibleFields() {
        const b = this.map.getBounds();
        const results = [];
        const lonStart = Math.max(0,  Math.floor((b.getWest()  + 180) / 20));
        const lonEnd   = Math.min(17, Math.floor((b.getEast()  + 180) / 20));
        const latStart = Math.max(0,  Math.floor((b.getSouth() + 90)  / 10));
        const latEnd   = Math.min(17, Math.floor((b.getNorth() + 90)  / 10));
        for (let lo = lonStart; lo <= lonEnd; lo++)
            for (let la = latStart; la <= latEnd; la++)
                results.push(String.fromCharCode(65 + lo) + String.fromCharCode(65 + la));
        return results;
    }

    _visibleSquares() {
        const b = this.map.getBounds();
        const mW = b.getWest(), mE = b.getEast(), mS = b.getSouth(), mN = b.getNorth();
        const results = [];
        const fLonStart = Math.max(0,  Math.floor((mW + 180) / 20));
        const fLonEnd   = Math.min(17, Math.floor((mE + 180) / 20));
        const fLatStart = Math.max(0,  Math.floor((mS + 90)  / 10));
        const fLatEnd   = Math.min(17, Math.floor((mN + 90)  / 10));
        for (let flo = fLonStart; flo <= fLonEnd; flo++) {
            for (let fla = fLatStart; fla <= fLatEnd; fla++) {
                const field      = String.fromCharCode(65 + flo) + String.fromCharCode(65 + fla);
                const fieldWest  = flo * 20 - 180;
                const fieldSouth = fla * 10 - 90;
                for (let slo = 0; slo < 10; slo++) {
                    for (let sla = 0; sla < 10; sla++) {
                        const w = fieldWest  + slo * 2;
                        const s = fieldSouth + sla;
                        if (w + 2 >= mW && w <= mE && s + 1 >= mS && s <= mN)
                            results.push(field + slo + sla);
                    }
                }
            }
        }
        return results;
    }

    _visibleSubsquares() {
        const b = this.map.getBounds();
        const mW = b.getWest(), mE = b.getEast(), mS = b.getSouth(), mN = b.getNorth();
        const results = [];
        const stepLon = 2 / 24, stepLat = 1 / 24;
        for (const sq of this._visibleSquares()) {
            const sqB = this.squareToBounds(sq);
            for (let slo = 0; slo < 24; slo++) {
                for (let sla = 0; sla < 24; sla++) {
                    const w = sqB.west  + slo * stepLon;
                    const s = sqB.south + sla * stepLat;
                    if (w + stepLon >= mW && w <= mE && s + stepLat >= mS && s <= mN)
                        results.push(sq + String.fromCharCode(97 + slo) + String.fromCharCode(97 + sla));
                }
            }
        }
        return results;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    showGrid() {
        this._wantGrid = true;
        this._createCanvas();
        this._redraw();
    }

    hideGrid() {
        this._wantGrid = false;
        if (this._ctx) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }

    toggleGrid() {
        this._wantGrid ? this.hideGrid() : this.showGrid();
    }

    /** Called on map move/zoom */
    updateGrid() {
        if (this._wantGrid) this._redraw();
    }

    clearGrid() {
        this.hideGrid();
        this._removeCanvas();
    }

    // ── Auto-update ───────────────────────────────────────────────────────────

    enableAutoUpdate() {
        this._onMoveEnd   = () => this.updateGrid();
        this._onZoomEnd   = () => this.updateGrid();
        this._onViewReset = () => this.updateGrid();
        this.map.on('moveend',   this._onMoveEnd);
        this.map.on('zoomend',   this._onZoomEnd);
        this.map.on('viewreset', this._onViewReset);
    }

    disableAutoUpdate() {
        if (this._onMoveEnd)   this.map.off('moveend',   this._onMoveEnd);
        if (this._onZoomEnd)   this.map.off('zoomend',   this._onZoomEnd);
        if (this._onViewReset) this.map.off('viewreset', this._onViewReset);
        this._onMoveEnd = this._onZoomEnd = this._onViewReset = null;
    }

    isGridVisible()          { return this._wantGrid; }
    getHighlightedLocators() { return Array.from(this.highlightedSquares.keys()); }

    // ── Highlight API (Leaflet rectangles — unaffected by canvas) ────────────

    highlightLocators(locators, defaultStyle = {}) {
        if (!this.highlightLayer) {
            this.highlightLayer = L.layerGroup().addTo(this.map);
        }

        const baseStyle = {
            color:       defaultStyle.color       || '#ff0000',
            weight:      defaultStyle.weight      || 2,
            opacity:     defaultStyle.opacity     || 0.8,
            fillColor:   defaultStyle.fillColor   || '#ff0000',
            fillOpacity: defaultStyle.fillOpacity || 0.2,
            interactive: defaultStyle.interactive !== undefined ? defaultStyle.interactive : true,
            ...defaultStyle
        };

        locators.forEach(item => {
            try {
                const locator     = typeof item === 'string' ? item : item.locator;
                const customStyle = typeof item === 'object' && item.style ? item.style : {};
                const data        = typeof item === 'object' && item.data  ? item.data  : null;

                let bnd;
                if      (locator.length >= 6) bnd = this.subsquareToBounds(locator.substring(0, 6));
                else if (locator.length >= 4) bnd = this.squareToBounds(locator.substring(0, 4));
                else                          bnd = this.fieldToBounds(locator.substring(0, 2));

                const finalStyle = { ...baseStyle, ...customStyle };
                const rectangle  = L.rectangle(
                    [[bnd.south, bnd.west], [bnd.north, bnd.east]],
                    finalStyle
                );

                this.highlightedSquares.set(locator, { rectangle, data });

                if (data && finalStyle.interactive) {
                    let tip = `<strong>${locator}</strong><br>`;
                    if (data.avg_snr          !== undefined) tip += `Avg SNR: ${data.avg_snr.toFixed(1)} dB<br>`;
                    if (data.count            !== undefined) tip += `Spots: ${data.count}<br>`;
                    if (data.unique_callsigns !== undefined) tip += `Unique Callsigns: ${data.unique_callsigns}`;
                    rectangle.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 0.9 });

                    if (data.callsigns && data.callsigns.length > 0) {
                        rectangle.on('click', () => {
                            if (typeof window.openCallsignsModal === 'function')
                                window.openCallsignsModal(locator, data.callsigns);
                        });
                    }
                }

                this.highlightLayer.addLayer(rectangle);
            } catch (e) {
                console.warn(`Invalid locator: ${item}`, e);
            }
        });
    }

    clearHighlights() {
        if (this.highlightLayer) {
            this.highlightLayer.clearLayers();
            this.highlightedSquares.clear();
        }
    }

    removeHighlights(locators) {
        locators.forEach(locator => {
            const item = this.highlightedSquares.get(locator);
            if (item && this.highlightLayer) {
                this.highlightLayer.removeLayer(item.rectangle);
                this.highlightedSquares.delete(locator);
            }
        });
    }

    getHighlightData(locator) {
        const item = this.highlightedSquares.get(locator);
        return item ? item.data : null;
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaidenheadGrid;
}
