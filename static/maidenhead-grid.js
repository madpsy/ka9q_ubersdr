/**
 * Maidenhead Grid Overlay for Leaflet
 * Draws 4-character Maidenhead locator grid squares on a Leaflet map
 */

class MaidenheadGrid {
    constructor(map, options = {}) {
        this.map = map;
        this.options = {
            color: options.color || '#3388ff',
            weight: options.weight || 1,
            opacity: options.opacity || 0.5,
            fillOpacity: options.fillOpacity || 0,
            showLabels: options.showLabels !== undefined ? options.showLabels : true,
            labelColor: options.labelColor || '#3388ff',
            labelSize: options.labelSize || '10px',
            minZoom: options.minZoom || 3,
            maxZoom: options.maxZoom || 18,
            ...options
        };
        
        this.gridLayer = null;
        this.labelLayer = null;
        this.highlightLayer = null; // Separate layer for highlighted squares
        this.gridVisible = false;
        this.highlightedSquares = new Map(); // Store highlighted squares
    }

    /**
     * Convert Maidenhead locator to lat/lon bounds
     * @param {string} locator - 4-character Maidenhead locator (e.g., "FN20")
     * @returns {object} - {south, west, north, east}
     */
    locatorToBounds(locator) {
        if (locator.length !== 4) {
            throw new Error('Locator must be 4 characters');
        }

        const field = locator.substring(0, 2).toUpperCase();
        const square = locator.substring(2, 4);

        // Field (first 2 characters): 20° longitude × 10° latitude
        const fieldLon = (field.charCodeAt(0) - 65) * 20 - 180;
        const fieldLat = (field.charCodeAt(1) - 65) * 10 - 90;

        // Square (last 2 digits): 2° longitude × 1° latitude
        const squareLon = parseInt(square[0]) * 2;
        const squareLat = parseInt(square[1]) * 1;

        const west = fieldLon + squareLon;
        const south = fieldLat + squareLat;
        const east = west + 2;
        const north = south + 1;

        return { south, west, north, east };
    }

    /**
     * Generate all valid 4-character Maidenhead locators
     * @returns {Array} - Array of locator strings
     */
    generateAllLocators() {
        const locators = [];
        
        // Fields: AA to RR (18 × 18 = 324 fields)
        for (let fieldLon = 0; fieldLon < 18; fieldLon++) {
            for (let fieldLat = 0; fieldLat < 18; fieldLat++) {
                const field = String.fromCharCode(65 + fieldLon) + String.fromCharCode(65 + fieldLat);
                
                // Squares: 00 to 99 (10 × 10 = 100 squares per field)
                for (let squareLon = 0; squareLon < 10; squareLon++) {
                    for (let squareLat = 0; squareLat < 10; squareLat++) {
                        const locator = field + squareLon + squareLat;
                        locators.push(locator);
                    }
                }
            }
        }
        
        return locators;
    }

    /**
     * Get visible locators based on current map bounds and zoom
     * @returns {Array} - Array of locator strings visible in current view
     */
    getVisibleLocators() {
        const bounds = this.map.getBounds();
        const zoom = this.map.getZoom();
        
        // Don't show grid if zoom is too low
        if (zoom < this.options.minZoom) {
            return [];
        }

        const visibleLocators = [];
        const mapSouth = bounds.getSouth();
        const mapNorth = bounds.getNorth();
        const mapWest = bounds.getWest();
        const mapEast = bounds.getEast();

        // Calculate field range
        const fieldLonStart = Math.max(0, Math.floor((mapWest + 180) / 20));
        const fieldLonEnd = Math.min(17, Math.floor((mapEast + 180) / 20));
        const fieldLatStart = Math.max(0, Math.floor((mapSouth + 90) / 10));
        const fieldLatEnd = Math.min(17, Math.floor((mapNorth + 90) / 10));

        for (let fieldLon = fieldLonStart; fieldLon <= fieldLonEnd; fieldLon++) {
            for (let fieldLat = fieldLatStart; fieldLat <= fieldLatEnd; fieldLat++) {
                const field = String.fromCharCode(65 + fieldLon) + String.fromCharCode(65 + fieldLat);
                
                for (let squareLon = 0; squareLon < 10; squareLon++) {
                    for (let squareLat = 0; squareLat < 10; squareLat++) {
                        const locator = field + squareLon + squareLat;
                        const locBounds = this.locatorToBounds(locator);
                        
                        // Check if locator intersects with map bounds
                        if (locBounds.east >= mapWest && locBounds.west <= mapEast &&
                            locBounds.north >= mapSouth && locBounds.south <= mapNorth) {
                            visibleLocators.push(locator);
                        }
                    }
                }
            }
        }

        return visibleLocators;
    }

    /**
     * Draw the grid lines on the map
     */
    drawGrid() {
        this.clearGrid();

        const visibleLocators = this.getVisibleLocators();
        
        if (visibleLocators.length === 0) {
            return;
        }

        // Create layer group for grid rectangles
        this.gridLayer = L.layerGroup();
        
        // Create layer group for labels if enabled
        if (this.options.showLabels) {
            this.labelLayer = L.layerGroup();
        }

        visibleLocators.forEach(locator => {
            const bounds = this.locatorToBounds(locator);
            
            // Create rectangle for grid square (outline only)
            const rectangle = L.rectangle(
                [[bounds.south, bounds.west], [bounds.north, bounds.east]],
                {
                    color: this.options.color,
                    weight: this.options.weight,
                    opacity: this.options.opacity,
                    fillOpacity: this.options.fillOpacity,
                    interactive: false
                }
            );
            
            this.gridLayer.addLayer(rectangle);

            // Add label if enabled and zoom is sufficient
            if (this.options.showLabels && this.map.getZoom() >= 5) {
                const centerLat = (bounds.south + bounds.north) / 2;
                const centerLon = (bounds.west + bounds.east) / 2;
                
                const label = L.marker([centerLat, centerLon], {
                    icon: L.divIcon({
                        className: 'maidenhead-label',
                        html: `<div style="color: ${this.options.labelColor}; font-size: ${this.options.labelSize}; font-weight: bold; text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white; pointer-events: none;">${locator}</div>`,
                        iconSize: [40, 20],
                        iconAnchor: [20, 10]
                    }),
                    interactive: false
                });
                
                this.labelLayer.addLayer(label);
            }
        });

        // Add layers to map
        this.gridLayer.addTo(this.map);
        if (this.labelLayer) {
            this.labelLayer.addTo(this.map);
        }

        this.gridVisible = true;
    }

    /**
     * Clear only the grid lines from the map (keeps highlights)
     */
    clearGrid() {
        if (this.gridLayer) {
            this.map.removeLayer(this.gridLayer);
            this.gridLayer = null;
        }
        if (this.labelLayer) {
            this.map.removeLayer(this.labelLayer);
            this.labelLayer = null;
        }
        this.gridVisible = false;
    }

    /**
     * Show the grid lines
     */
    showGrid() {
        if (!this.gridVisible) {
            this.drawGrid();
        }
    }

    /**
     * Hide the grid lines (keeps highlights visible)
     */
    hideGrid() {
        this.clearGrid();
    }

    /**
     * Toggle grid lines visibility (highlights remain)
     */
    toggleGrid() {
        if (this.gridVisible) {
            this.hideGrid();
        } else {
            this.showGrid();
        }
    }

    /**
     * Update grid when map moves or zooms
     */
    updateGrid() {
        if (this.gridVisible) {
            this.drawGrid();
        }
    }

    /**
     * Enable auto-update on map move/zoom
     */
    enableAutoUpdate() {
        this.map.on('moveend', () => this.update());
        this.map.on('zoomend', () => this.update());
    }

    /**
     * Disable auto-update
     */
    disableAutoUpdate() {
        this.map.off('moveend');
        this.map.off('zoomend');
    }

    /**
     * Highlight specific locators (remains visible even when grid is hidden)
     * @param {Array} locators - Array of locator strings or objects with locator and style
     * @param {object} defaultStyle - Default style options for highlighted squares
     */
    highlightLocators(locators, defaultStyle = {}) {
        // Initialize highlight layer if it doesn't exist
        if (!this.highlightLayer) {
            this.highlightLayer = L.layerGroup().addTo(this.map);
        }

        const baseStyle = {
            color: defaultStyle.color || '#ff0000',
            weight: defaultStyle.weight || 2,
            opacity: defaultStyle.opacity || 0.8,
            fillColor: defaultStyle.fillColor || '#ff0000',
            fillOpacity: defaultStyle.fillOpacity || 0.2,
            interactive: defaultStyle.interactive !== undefined ? defaultStyle.interactive : true,
            ...defaultStyle
        };

        locators.forEach(item => {
            try {
                // Support both string locators and objects with {locator, style, data}
                const locator = typeof item === 'string' ? item : item.locator;
                const customStyle = typeof item === 'object' && item.style ? item.style : {};
                const data = typeof item === 'object' && item.data ? item.data : null;
                
                const bounds = this.locatorToBounds(locator);
                const finalStyle = { ...baseStyle, ...customStyle };
                
                const rectangle = L.rectangle(
                    [[bounds.south, bounds.west], [bounds.north, bounds.east]],
                    finalStyle
                );
                
                // Store reference for later removal
                this.highlightedSquares.set(locator, { rectangle, data });
                
                // Add popup or tooltip if data is provided
                if (data && finalStyle.interactive) {
                    let tooltipContent = `<strong>${locator}</strong><br>`;
                    if (data.avg_snr !== undefined) {
                        tooltipContent += `Avg SNR: ${data.avg_snr.toFixed(1)} dB<br>`;
                    }
                    if (data.count !== undefined) {
                        tooltipContent += `Spots: ${data.count}<br>`;
                    }
                    if (data.unique_callsigns !== undefined) {
                        tooltipContent += `Unique Callsigns: ${data.unique_callsigns}`;
                    }
                    
                    // Add hover tooltip
                    rectangle.bindTooltip(tooltipContent, {
                        direction: 'top',
                        offset: [0, -10],
                        opacity: 0.9
                    });
                    
                    // Add click handler to open callsigns modal if callsigns data is available
                    if (data.callsigns && data.callsigns.length > 0) {
                        rectangle.on('click', function() {
                            if (typeof window.openCallsignsModal === 'function') {
                                window.openCallsignsModal(locator, data.callsigns);
                            }
                        });
                    }
                }
                
                this.highlightLayer.addLayer(rectangle);
            } catch (e) {
                console.warn(`Invalid locator: ${item}`, e);
            }
        });
    }

    /**
     * Clear all highlighted locators
     */
    clearHighlights() {
        if (this.highlightLayer) {
            this.highlightLayer.clearLayers();
            this.highlightedSquares.clear();
        }
    }

    /**
     * Remove specific highlighted locators
     * @param {Array} locators - Array of locator strings to remove
     */
    removeHighlights(locators) {
        locators.forEach(locator => {
            const item = this.highlightedSquares.get(locator);
            if (item && this.highlightLayer) {
                this.highlightLayer.removeLayer(item.rectangle);
                this.highlightedSquares.delete(locator);
            }
        });
    }

    /**
     * Get data for a highlighted locator
     * @param {string} locator - Locator string
     * @returns {object|null} - Data associated with the locator
     */
    getHighlightData(locator) {
        const item = this.highlightedSquares.get(locator);
        return item ? item.data : null;
    }

    /**
     * Check if grid lines are visible
     * @returns {boolean}
     */
    isGridVisible() {
        return this.gridVisible;
    }

    /**
     * Get all highlighted locators
     * @returns {Array} - Array of locator strings
     */
    getHighlightedLocators() {
        return Array.from(this.highlightedSquares.keys());
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaidenheadGrid;
}