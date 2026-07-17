/**
 * Maidenhead Grid Overlay for Leaflet
 * Draws 2-char (field), 4-char (square) and 6-char (subsquare) Maidenhead
 * locator grid lines on a Leaflet map, switching level automatically by zoom.
 *
 * Zoom thresholds (defaults, overridable via options):
 *   zoom < minZoom  → nothing drawn
 *   minZoom ≤ zoom < zoom4 → 2-char fields  (20° × 10°)
 *   zoom4   ≤ zoom < zoom6 → 4-char squares (2° × 1°)
 *   zoom    ≥ zoom6        → 6-char subsquares (5′ × 2.5′)
 */

class MaidenheadGrid {
    constructor(map, options = {}) {
        this.map = map;
        this.options = {
            color:       options.color       || '#3388ff',
            weight:      options.weight      || 1,
            opacity:     options.opacity     || 0.5,
            fillOpacity: options.fillOpacity !== undefined ? options.fillOpacity : 0,
            showLabels:  options.showLabels  !== undefined ? options.showLabels  : true,
            labelColor:  options.labelColor  || '#3388ff',
            // Minimum zoom to show anything at all
            minZoom:     options.minZoom     !== undefined ? options.minZoom  : 2,
            // Zoom at which to switch from 2-char → 4-char
            zoom4:       options.zoom4       !== undefined ? options.zoom4    : 5,
            // Zoom at which to switch from 4-char → 6-char
            zoom6:       options.zoom6       !== undefined ? options.zoom6    : 9,
            // Minimum zoom to show labels for each level
            labelZoom2:  options.labelZoom2  !== undefined ? options.labelZoom2 : 2,
            labelZoom4:  options.labelZoom4  !== undefined ? options.labelZoom4 : 5,
            labelZoom6:  options.labelZoom6  !== undefined ? options.labelZoom6 : 9,
        };

        this.gridLayer    = null;
        this.labelLayer   = null;
        this.highlightLayer = null;
        this._wantGrid    = false;   // true when the user has toggled the grid on
        this.gridVisible  = false;   // true only while layers are actually on the map
        this.highlightedSquares = new Map();

        this._onMoveEnd = null;
        this._onZoomEnd = null;
    }

    // ── Bounds helpers ────────────────────────────────────────────────────────

    /** 2-char field bounds (e.g. "IO") — 20° lon × 10° lat */
    fieldToBounds(field) {
        const f = field.toUpperCase();
        const west  = (f.charCodeAt(0) - 65) * 20 - 180;
        const south = (f.charCodeAt(1) - 65) * 10 - 90;
        return { south, west, north: south + 10, east: west + 20 };
    }

    /** 4-char square bounds (e.g. "IO91") — 2° lon × 1° lat */
    squareToBounds(locator) {
        const f = locator.substring(0, 2).toUpperCase();
        const s = locator.substring(2, 4);
        const west  = (f.charCodeAt(0) - 65) * 20 - 180 + parseInt(s[0]) * 2;
        const south = (f.charCodeAt(1) - 65) * 10 - 90  + parseInt(s[1]) * 1;
        return { south, west, north: south + 1, east: west + 2 };
    }

    /** 6-char subsquare bounds (e.g. "IO91vl") — 5′ lon × 2.5′ lat */
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
                const field     = String.fromCharCode(65 + flo) + String.fromCharCode(65 + fla);
                const fieldWest = flo * 20 - 180;
                const fieldSouth= fla * 10 - 90;
                for (let slo = 0; slo < 10; slo++) {
                    for (let sla = 0; sla < 10; sla++) {
                        const w = fieldWest  + slo * 2;
                        const s = fieldSouth + sla * 1;
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
        for (const sq of this._visibleSquares()) {
            const sqB = this.squareToBounds(sq);
            const step_lon = 2 / 24;
            const step_lat = 1 / 24;
            for (let slo = 0; slo < 24; slo++) {
                for (let sla = 0; sla < 24; sla++) {
                    const w = sqB.west  + slo * step_lon;
                    const s = sqB.south + sla * step_lat;
                    if (w + step_lon >= mW && w <= mE && s + step_lat >= mS && s <= mN)
                        results.push(sq + String.fromCharCode(97 + slo) + String.fromCharCode(97 + sla));
                }
            }
        }
        return results;
    }

    // ── Draw / clear ──────────────────────────────────────────────────────────

    /**
     * (Re)draw the grid for the current viewport and zoom.
     * Always clears existing layers first, then rebuilds.
     */
    drawGrid() {
        // Remove existing layers without touching _wantGrid
        if (this.gridLayer)  { this.map.removeLayer(this.gridLayer);  this.gridLayer  = null; }
        if (this.labelLayer) { this.map.removeLayer(this.labelLayer); this.labelLayer = null; }
        this.gridVisible = false;

        const zoom = this.map.getZoom();
        if (zoom < this.options.minZoom) return;

        let items, boundsOf, showLabel, labelSize;

        if (zoom >= this.options.zoom6) {
            items      = this._visibleSubsquares();
            boundsOf   = loc => this.subsquareToBounds(loc);
            showLabel  = this.options.showLabels && zoom >= this.options.labelZoom6;
            labelSize  = '9px';
        } else if (zoom >= this.options.zoom4) {
            items      = this._visibleSquares();
            boundsOf   = loc => this.squareToBounds(loc);
            showLabel  = this.options.showLabels && zoom >= this.options.labelZoom4;
            labelSize  = zoom >= 7 ? '10px' : '9px';
        } else {
            items      = this._visibleFields();
            boundsOf   = loc => this.fieldToBounds(loc);
            showLabel  = this.options.showLabels && zoom >= this.options.labelZoom2;
            labelSize  = zoom >= 4 ? '11px' : '10px';
        }

        if (items.length === 0) return;

        this.gridLayer = L.layerGroup();
        if (showLabel) this.labelLayer = L.layerGroup();

        items.forEach(loc => {
            const bnd = boundsOf(loc);

            L.rectangle(
                [[bnd.south, bnd.west], [bnd.north, bnd.east]],
                {
                    color:       this.options.color,
                    weight:      this.options.weight,
                    opacity:     this.options.opacity,
                    fillOpacity: this.options.fillOpacity,
                    interactive: false
                }
            ).addTo(this.gridLayer);

            if (showLabel) {
                const centerLat = (bnd.south + bnd.north) / 2;
                const centerLon = (bnd.west  + bnd.east)  / 2;
                L.marker([centerLat, centerLon], {
                    icon: L.divIcon({
                        className: 'maidenhead-label',
                        html: `<div style="color:${this.options.labelColor};font-size:${labelSize};font-weight:bold;text-shadow:0 0 3px #000,0 0 3px #000,1px 1px 2px #000,-1px -1px 2px #000;pointer-events:none;white-space:nowrap;">${loc}</div>`,
                        iconSize:   [60, 14],
                        iconAnchor: [30, 7]
                    }),
                    interactive: false
                }).addTo(this.labelLayer);
            }
        });

        this.gridLayer.addTo(this.map);
        if (this.labelLayer) this.labelLayer.addTo(this.map);
        this.gridVisible = true;
    }

    clearGrid() {
        if (this.gridLayer)  { this.map.removeLayer(this.gridLayer);  this.gridLayer  = null; }
        if (this.labelLayer) { this.map.removeLayer(this.labelLayer); this.labelLayer = null; }
        this.gridVisible = false;
        this._wantGrid   = false;
    }

    showGrid() {
        this._wantGrid = true;
        this.drawGrid();
    }

    hideGrid() {
        this._wantGrid = false;
        if (this.gridLayer)  { this.map.removeLayer(this.gridLayer);  this.gridLayer  = null; }
        if (this.labelLayer) { this.map.removeLayer(this.labelLayer); this.labelLayer = null; }
        this.gridVisible = false;
    }

    toggleGrid() {
        this._wantGrid ? this.hideGrid() : this.showGrid();
    }

    /** Called on map move/zoom — only redraws if the user wants the grid */
    updateGrid() {
        if (this._wantGrid) this.drawGrid();
    }

    // ── Auto-update ───────────────────────────────────────────────────────────

    enableAutoUpdate() {
        this._onMoveEnd = () => this.updateGrid();
        this._onZoomEnd = () => this.updateGrid();
        this.map.on('moveend', this._onMoveEnd);
        this.map.on('zoomend', this._onZoomEnd);
    }

    disableAutoUpdate() {
        if (this._onMoveEnd) this.map.off('moveend', this._onMoveEnd);
        if (this._onZoomEnd) this.map.off('zoomend', this._onZoomEnd);
        this._onMoveEnd = null;
        this._onZoomEnd = null;
    }

    // ── Highlight API ─────────────────────────────────────────────────────────

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

    isGridVisible()          { return this._wantGrid; }
    getHighlightedLocators() { return Array.from(this.highlightedSquares.keys()); }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaidenheadGrid;
}
