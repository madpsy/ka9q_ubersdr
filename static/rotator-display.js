/**
 * UberSDR Rotator Display Component
 * Reusable rotator visualization with configurable display options
 */

class RotatorDisplay {
    constructor(options = {}) {
        // Configuration options
        this.containerId = options.containerId || 'rotator-container';
        this.showMap = options.showMap !== false; // default true
        this.showCompass = options.showCompass !== false; // default true
        this.showControls = options.showControls || false; // default false
        this.showPassword = options.showPassword || false; // default false
        this.mapSize = options.mapSize || 800;
        this.compassSize = options.compassSize || 200;
        // Use !== undefined to allow 0 as a valid value (disables automatic updates)
        this.updateInterval = options.updateInterval !== undefined ? options.updateInterval : 1000;
        
        // State
        this.svg = null;
        this.projection = null;
        this.path = null;
        this.azimuthLineElement = null;
        this.beamConeElement = null;
        this.receiverLat = null;
        this.receiverLon = null;
        this.beamWidth = 45; // degrees
        this.updateTimer = null;
        this.currentZoom = 1;
        this.currentTransform = d3.zoomIdentity;
        this.mapGroup = null;
        this.countriesData = []; // Store countries data for tooltip
        
        // Initialize
        this.init();
    }
    
    async init() {
        // Fetch receiver location
        await this.fetchReceiverLocation();
        
        // Create UI elements
        if (this.showMap) {
            this.createMap();
        }
        if (this.showCompass) {
            this.createCompass();
        }
        
        // Start position updates
        this.startUpdates();
    }
    
    async fetchReceiverLocation() {
        try {
            const response = await fetch('/api/description');
            const data = await response.json();
            
            if (data.receiver && data.receiver.gps) {
                this.receiverLat = data.receiver.gps.lat;
                this.receiverLon = data.receiver.gps.lon;
                return true;
            }
        } catch (error) {
            console.error('[RotatorDisplay] Failed to fetch receiver location:', error);
        }
        return false;
    }
    
    async createMap() {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error('[RotatorDisplay] Container not found:', this.containerId);
            return;
        }
        
        // Create SVG for map (directly, no wrapper div)
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = `${this.containerId}-map-svg`;
        svg.setAttribute('width', this.mapSize);
        svg.setAttribute('height', this.mapSize);
        svg.setAttribute('viewBox', `0 0 ${this.mapSize} ${this.mapSize}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.background = 'rgba(26, 37, 47, 0.6)';
        svg.style.borderRadius = '10px';
        svg.style.display = 'block';
        container.appendChild(svg);
        
        this.svg = d3.select(svg);

        // Create a group for all map elements (for zooming)
        this.mapGroup = this.svg.append("g");

        // Create a separate group for markers that will be manually positioned
        // This group is NOT transformed by zoom, so markers stay constant size
        this.markerGroup = this.svg.append("g");

        // Add zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.5, 8])  // Allow zoom from 0.5x to 8x
            .on("zoom", (event) => {
                this.mapGroup.attr("transform", event.transform);
                const previousZoom = this.currentZoom;
                this.currentZoom = event.transform.k;
                this.currentTransform = event.transform;

                // Update receiver marker position to follow the map center
                if (this.receiverMarker) {
                    const centerScreen = this.currentTransform.apply([this.mapSize / 2, this.mapSize / 2]);
                    this.receiverMarker
                        .attr("cx", centerScreen[0])
                        .attr("cy", centerScreen[1]);
                }

                // Redraw markers when zoom level changes significantly
                if (Math.abs(this.currentZoom - previousZoom) > 0.1) {
                    this.redrawMarkersAfterZoom();
                }
            });

        this.svg.call(zoom);

        // Create tooltip element
        this.createTooltip(container);
        
        // Create azimuthal equidistant projection centered on receiver
        // Rotate by -90 degrees to align North with the top of the map
        this.projection = d3.geoAzimuthalEquidistant()
            .rotate([-this.receiverLon, -this.receiverLat, 0])
            .scale(this.mapSize / 2 / Math.PI * 0.9)
            .translate([this.mapSize / 2, this.mapSize / 2])
            .clipAngle(180);
        
        this.path = d3.geoPath().projection(this.projection);
        
        // Draw graticule (grid lines)
        const graticule = d3.geoGraticule();
        this.mapGroup.append("path")
            .datum(graticule)
            .attr("class", "graticule")
            .attr("d", this.path)
            .style("fill", "none")
            .style("stroke", "rgba(255,255,255,0.15)")
            .style("stroke-width", "0.5");

        // Draw distance circles (without labels first)
        this.drawDistanceCircles(false);

        // Load and draw world map
        try {
            const response = await fetch('countries-110m.json');
            const world = await response.json();
            const countries = topojson.feature(world, world.objects.countries);

            this.mapGroup.append("g")
                .selectAll("path")
                .data(countries.features)
                .enter().append("path")
                .attr("class", "country")
                .attr("d", this.path)
                .style("fill", "#3d5a80")
                .style("stroke", "#98c1d9")
                .style("stroke-width", "1");
        } catch (error) {
            console.error('[RotatorDisplay] Failed to load world map:', error);
        }

        // Draw distance labels AFTER countries so they appear on top
        this.drawDistanceLabels();

        // Draw center point (receiver location) in markerGroup so it doesn't scale with zoom
        // Position it at the center in screen coordinates
        this.receiverMarker = this.markerGroup.append("circle")
            .attr("cx", this.mapSize / 2)
            .attr("cy", this.mapSize / 2)
            .attr("r", 6)
            .attr("fill", "#ff4444")
            .attr("stroke", "#fff")
            .attr("stroke-width", 2);

        // Create beam cone element
        this.beamConeElement = this.mapGroup.append("path")
            .attr("class", "beam-cone")
            .attr("d", "")  // Initialize with empty path (invisible)
            .style("fill", "rgba(218, 165, 32, 0.2)")
            .style("stroke", "#DAA520")
            .style("stroke-width", "2");

        // Create center azimuth line element
        this.azimuthLineElement = this.mapGroup.append("line")
            .attr("class", "azimuth-line")
            .attr("x1", this.mapSize / 2)
            .attr("y1", this.mapSize / 2)
            .attr("x2", this.mapSize / 2)  // Initialize to center (invisible)
            .attr("y2", this.mapSize / 2)  // Initialize to center (invisible)
            .style("stroke", "#DAA520")
            .style("stroke-width", "2")
            .style("fill", "none")
            .style("stroke-linecap", "round");
        
        // Add mouse event handlers
        this.svg.on("mousemove", (event) => this.handleMapMouseMove(event));
        this.svg.on("mouseleave", () => this.handleMapMouseLeave());
        this.svg.on("click", (event) => this.handleMapClick(event));
    }
    
    createTooltip(container) {
        const tooltip = document.createElement('div');
        tooltip.id = `${this.containerId}-tooltip`;
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'rgba(0, 0, 0, 0.8)';
        tooltip.style.color = '#fff';
        tooltip.style.padding = '8px 12px';
        tooltip.style.borderRadius = '6px';
        tooltip.style.fontSize = '13px';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.zIndex = '1000';
        tooltip.style.whiteSpace = 'nowrap';
        tooltip.style.display = 'none';
        tooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
        container.appendChild(tooltip);
        this.tooltip = tooltip;
    }
    
    handleMapMouseMove(event) {
        if (!this.projection || !this.receiverLat || !this.receiverLon) return;

        // Get mouse coordinates relative to SVG
        const [mouseX, mouseY] = d3.pointer(event);

        // Apply inverse transform to get coordinates in the map's coordinate system
        const [transformedX, transformedY] = this.currentTransform.invert([mouseX, mouseY]);

        const coords = this.projection.invert([transformedX, transformedY]);

        if (!coords) {
            this.tooltip.style.display = 'none';
            return;
        }

        const [clickLon, clickLat] = coords;

        // Calculate true bearing using great circle formula
        const bearing = this.calculateBearing(this.receiverLat, this.receiverLon, clickLat, clickLon);

        // Calculate distance using great circle formula
        const distance = this.calculateDistance(this.receiverLat, this.receiverLon, clickLat, clickLon);

        // Find nearest country if countries data is available
        let tooltipHTML = `${Math.round(bearing)}° | ${distance.toLocaleString()} km`;
        if (this.countriesData && this.countriesData.length > 0) {
            const nearestCountry = this.findClosestCountry(bearing, distance);
            if (nearestCountry) {
                tooltipHTML += `<br><span style="color: #4CAF50;">${nearestCountry.name}</span>`;
            }
        }

        // Update tooltip content
        this.tooltip.innerHTML = tooltipHTML;
        this.tooltip.style.display = 'block';

        // Position tooltip near cursor (offset to avoid covering the point)
        const container = document.getElementById(this.containerId);
        const rect = container.getBoundingClientRect();
        this.tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
        this.tooltip.style.top = (event.clientY - rect.top + 15) + 'px';
    }
    
    handleMapMouseLeave() {
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
    }
    
    handleMapClick(event) {
        if (!this.projection || !this.receiverLat || !this.receiverLon) return;

        // Get mouse coordinates relative to SVG
        const [mouseX, mouseY] = d3.pointer(event);

        // Apply inverse transform to get coordinates in the map's coordinate system
        const [transformedX, transformedY] = this.currentTransform.invert([mouseX, mouseY]);

        const coords = this.projection.invert([transformedX, transformedY]);

        if (!coords) return;

        const [clickLon, clickLat] = coords;

        // Calculate true bearing using great circle formula
        const bearing = this.calculateBearing(this.receiverLat, this.receiverLon, clickLat, clickLon);
        const roundedBearing = Math.round(bearing);

        // Calculate distance using great circle formula
        const distance = this.calculateDistance(this.receiverLat, this.receiverLon, clickLat, clickLon);

        // Emit custom event that can be handled by the parent page
        const mapClickEvent = new CustomEvent('rotator-map-click', {
            detail: { bearing: roundedBearing, distance: distance }
        });
        document.dispatchEvent(mapClickEvent);
    }
    
    calculateBearing(lat1, lon1, lat2, lon2) {
        // Calculate initial bearing from point 1 to point 2
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) -
                  Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        // Normalize to 0-360
        bearing = (bearing + 360) % 360;

        return bearing;
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        
        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        
        return Math.round(R * c);
    }
    
    drawDistanceCircles(includeLabels = true) {
        const distances = [2000, 4000, 6000, 8000, 10000, 12000]; // km
        
        distances.forEach(distance => {
            const circle = d3.geoCircle()
                .center([this.receiverLon, this.receiverLat])
                .radius(distance / 111.32); // Convert km to degrees (approximate)
            
            this.mapGroup.append("path")
                .datum(circle())
                .attr("class", "distance-circle")
                .attr("d", this.path)
                .style("fill", "none")
                .style("stroke", "rgba(255,255,255,0.2)")
                .style("stroke-width", "1")
                .style("stroke-dasharray", "2,2");

            if (includeLabels) {
                // Add distance label at top (0 degrees)
                const labelPoint = this.calculateDestinationPoint(this.receiverLat, this.receiverLon, 0, distance);
                const projected = this.projection([labelPoint[1], labelPoint[0]]);

                if (projected) {
                    this.mapGroup.append("text")
                        .attr("class", "distance-label")
                        .attr("x", projected[0])
                        .attr("y", projected[1] - 5)
                        .text(distance + " km")
                        .style("fill", "rgba(255,255,255,0.5)")
                        .style("font-size", "10px")
                        .style("text-anchor", "middle");
                }
            }
        });
    }
    
    drawDistanceLabels() {
        const distances = [2000, 4000, 6000, 8000, 10000, 12000]; // km
        
        distances.forEach(distance => {
            // Add distance label at top (0 degrees)
            const labelPoint = this.calculateDestinationPoint(this.receiverLat, this.receiverLon, 0, distance);
            const projected = this.projection([labelPoint[1], labelPoint[0]]);

            if (projected) {
                this.mapGroup.append("text")
                    .attr("class", "distance-label")
                    .attr("x", projected[0])
                    .attr("y", projected[1] - 5)
                    .text(distance + " km")
                    .style("fill", "rgba(255,255,255,0.5)")
                    .style("font-size", "10px")
                    .style("text-anchor", "middle");
            }
        });
    }
    
    calculateDestinationPoint(lat, lon, bearing, distance) {
        const R = 6371; // Earth radius in km
        const δ = distance / R; // Angular distance in radians
        const θ = bearing * Math.PI / 180; // Bearing in radians (0° = North, clockwise)
        
        const φ1 = lat * Math.PI / 180;
        const λ1 = lon * Math.PI / 180;
        
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) +
                             Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
        
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
                                   Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
        
        return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
    }
    
    createCompass() {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error('[RotatorDisplay] Container not found:', this.containerId);
            return;
        }
        
        // Create compass container
        const compassDiv = document.createElement('div');
        compassDiv.id = `${this.containerId}-compass`;
        compassDiv.style.position = 'relative';
        compassDiv.style.width = this.compassSize + 'px';
        compassDiv.style.height = this.compassSize + 'px';
        compassDiv.style.borderRadius = '50%';
        compassDiv.style.background = 'radial-gradient(circle, #2c3e50 0%, #1a252f 100%)';
        compassDiv.style.boxShadow = '0 10px 40px rgba(0,0,0,0.5), inset 0 0 20px rgba(0,0,0,0.3)';
        compassDiv.style.margin = '20px auto';
        container.appendChild(compassDiv);
        
        // Create compass ring
        const ring = document.createElement('div');
        ring.id = `${this.containerId}-compass-ring`;
        ring.style.position = 'absolute';
        ring.style.width = '100%';
        ring.style.height = '100%';
        ring.style.borderRadius = '50%';
        compassDiv.appendChild(ring);
        
        // Create ticks and labels
        const cardinals = ['N', 'E', 'S', 'W'];
        const cardinalAngles = [0, 90, 180, 270];

        for (let i = 0; i < 360; i += 5) {
            const tick = document.createElement('div');
            tick.style.position = 'absolute';
            tick.style.width = '1px';
            tick.style.height = '8px';
            tick.style.background = 'rgba(255,255,255,0.5)';
            tick.style.left = '50%';
            tick.style.top = '5px';
            tick.style.transformOrigin = `50% ${this.compassSize/2 - 5}px`;
            tick.style.transform = `rotate(${i}deg)`;

            if (i % 30 === 0) {
                tick.style.height = '12px';
                tick.style.width = '2px';
                tick.style.background = 'rgba(255,255,255,0.8)';

                // Add label for major ticks
                const label = document.createElement('div');
                label.style.position = 'absolute';
                label.style.left = '50%';
                label.style.top = '20px';
                label.style.fontSize = '12px';
                label.style.fontWeight = 'bold';
                label.style.color = '#fff';
                label.style.transformOrigin = `50% ${this.compassSize/2 - 20}px`;
                // Keep label upright by rotating it around the compass center
                label.style.transform = `translateX(-50%) rotate(${i}deg)`;

                const cardinalIndex = cardinalAngles.indexOf(i);
                if (cardinalIndex !== -1) {
                    label.textContent = cardinals[cardinalIndex];
                    label.style.fontSize = '14px';
                    label.style.color = '#4CAF50';
                } else {
                    label.textContent = i;
                }

                ring.appendChild(label);
            }

            ring.appendChild(tick);
        }
        
        // Create needle
        const needle = document.createElement('div');
        needle.id = `${this.containerId}-compass-needle`;
        needle.style.position = 'absolute';
        needle.style.width = '3px';
        needle.style.height = (this.compassSize * 0.35) + 'px';
        needle.style.background = 'linear-gradient(to bottom, #ff4444 0%, #ff4444 50%, #fff 50%, #fff 100%)';
        needle.style.left = '50%';
        needle.style.top = '50%';
        needle.style.transformOrigin = '50% 50%';
        needle.style.transform = 'translate(-50%, -50%) rotate(0deg)';
        needle.style.borderRadius = '2px';
        needle.style.boxShadow = '0 0 5px rgba(255,68,68,0.5)';
        needle.style.transition = 'transform 0.5s ease-out';
        needle.style.zIndex = '5';
        
        // Create arrow tip at the top of the needle
        const arrow = document.createElement('div');
        arrow.style.position = 'absolute';
        arrow.style.width = '0';
        arrow.style.height = '0';
        arrow.style.borderLeft = '5px solid transparent';
        arrow.style.borderRight = '5px solid transparent';
        arrow.style.borderBottom = '10px solid #ff4444';
        arrow.style.top = '-10px';
        arrow.style.left = '50%';
        arrow.style.transform = 'translateX(-50%)';
        needle.appendChild(arrow);
        
        compassDiv.appendChild(needle);
        
        // Create center point
        const center = document.createElement('div');
        center.style.position = 'absolute';
        center.style.width = '10px';
        center.style.height = '10px';
        center.style.background = '#4CAF50';
        center.style.borderRadius = '50%';
        center.style.top = '50%';
        center.style.left = '50%';
        center.style.transform = 'translate(-50%, -50%)';
        center.style.boxShadow = '0 0 10px #4CAF50';
        center.style.zIndex = '10';
        compassDiv.appendChild(center);
    }
    
    updateAzimuthDisplay(azimuth) {
        // Update map
        if (this.showMap && this.svg && this.projection) {
            const centerX = this.mapSize / 2;
            const centerY = this.mapSize / 2;
            const radius = this.mapSize / 2;
            
            // Convert azimuth to radians (0° = North/up, clockwise)
            const angleRad = (azimuth - 90) * Math.PI / 180;
            
            // Calculate endpoint
            const endX = centerX + radius * Math.cos(angleRad);
            const endY = centerY + radius * Math.sin(angleRad);
            
            // Update center line
            if (this.azimuthLineElement) {
                this.azimuthLineElement
                    .attr("x2", endX)
                    .attr("y2", endY);
            }
            
            // Draw beam cone
            if (this.beamConeElement) {
                const halfBeam = this.beamWidth / 2;
                const leftAzimuth = azimuth - halfBeam;
                const rightAzimuth = azimuth + halfBeam;
                
                const leftAngleRad = (leftAzimuth - 90) * Math.PI / 180;
                const rightAngleRad = (rightAzimuth - 90) * Math.PI / 180;
                
                const leftX = centerX + radius * Math.cos(leftAngleRad);
                const leftY = centerY + radius * Math.sin(leftAngleRad);
                const rightX = centerX + radius * Math.cos(rightAngleRad);
                const rightY = centerY + radius * Math.sin(rightAngleRad);
                
                const largeArcFlag = this.beamWidth > 180 ? 1 : 0;
                const pathData = `M ${centerX},${centerY} L ${leftX},${leftY} A ${radius},${radius} 0 ${largeArcFlag} 1 ${rightX},${rightY} Z`;
                
                this.beamConeElement.attr("d", pathData);
            }
        }
        
        // Update compass needle
        if (this.showCompass) {
            const needle = document.getElementById(`${this.containerId}-compass-needle`);
            if (needle) {
                needle.style.transform = `translate(-50%, -50%) rotate(${azimuth}deg)`;
            }
        }
    }
    
    /**
     * Show a marker for a country on the azimuthal map
     * @param {string} countryName - Name of the country
     * @param {number} bearing - Bearing in degrees
     * @param {number} distance - Distance in kilometers
     * @param {Array} allCountries - Optional array of all countries for showing cone markers
     * @param {number} currentAzimuth - Current rotator azimuth for cone calculation
     */
    showCountryMarker(countryName, bearing, distance, allCountries = null, currentAzimuth = null) {
        if (!this.showMap || !this.mapGroup || !this.projection) return;
        
        // Remove any existing country markers
        this.markerGroup.selectAll('.country-marker').remove();
        this.markerGroup.selectAll('.cone-marker').remove();
        
        // Show smaller markers for countries within the beam cone if data provided
        if (allCountries && currentAzimuth !== null) {
            this.showConeMarkers(allCountries, currentAzimuth, bearing);
        }
        
        // Calculate the position on the map using bearing and distance
        const destPoint = this.calculateDestinationPoint(this.receiverLat, this.receiverLon, bearing, distance);
        const projected = this.projection([destPoint[1], destPoint[0]]);
        
        if (!projected) return;
        
        const [x, y] = projected;

        // Transform coordinates from map space to screen space
        const screenCoords = this.currentTransform.apply([x, y]);

        // Create marker group for selected country (larger, on top)
        const markerGroup = this.markerGroup.append('g')
            .attr('class', 'country-marker')
            .attr('transform', `translate(${screenCoords[0]}, ${screenCoords[1]})`);
        
        // Add marker circle
        markerGroup.append('circle')
            .attr('r', 8)
            .attr('fill', '#4CAF50')
            .attr('stroke', '#fff')
            .attr('stroke-width', 2)
            .style('filter', 'drop-shadow(0 0 6px rgba(76, 175, 80, 0.8))');
        
        // Add country name label
        markerGroup.append('text')
            .attr('x', 0)
            .attr('y', -15)
            .attr('text-anchor', 'middle')
            .attr('fill', '#fff')
            .attr('font-size', '14px')
            .attr('font-weight', 'bold')
            .style('text-shadow', '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)')
            .text(countryName);
        
        // Add distance/bearing label below
        markerGroup.append('text')
            .attr('x', 0)
            .attr('y', 25)
            .attr('text-anchor', 'middle')
            .attr('fill', '#4CAF50')
            .attr('font-size', '11px')
            .style('text-shadow', '0 0 4px rgba(0,0,0,0.8)')
            .text(`${bearing}° | ${Math.round(distance)} km`);
    }
    
    /**
     * Show smaller markers for countries within the beam cone
     * @param {Array} allCountries - Array of all countries
     * @param {number} currentAzimuth - Current rotator azimuth
     * @param {number} selectedBearing - Bearing of the selected country to exclude
     */
    showConeMarkers(allCountries, currentAzimuth, selectedBearing) {
        if (!allCountries || allCountries.length === 0) {
            return;
        }
        
        const halfBeam = this.beamWidth / 2;
        const minBearing = currentAzimuth - halfBeam;
        const maxBearing = currentAzimuth + halfBeam;
        
        // Find countries within the cone
        const countriesInCone = allCountries.filter(country => {
            // Skip the selected country
            if (country.bearing === selectedBearing) return false;
            
            // Skip countries within 1000km of receiver
            if (country.distance_km < 1000) return false;
            
            // Check if bearing is within cone (handle wrap-around at 0/360)
            let inCone = false;
            if (minBearing < 0) {
                inCone = country.bearing >= (360 + minBearing) || country.bearing <= maxBearing;
            } else if (maxBearing > 360) {
                inCone = country.bearing >= minBearing || country.bearing <= (maxBearing - 360);
            } else {
                inCone = country.bearing >= minBearing && country.bearing <= maxBearing;
            }
            
            return inCone;
        });
        
        // Group countries by distance ranges to ensure distribution across the cone
        // Start from 1000km since we filter out closer countries
        // Increase limits based on zoom level to show more countries when zoomed in
        const zoomMultiplier = Math.max(1, Math.floor(this.currentZoom));
        const distanceRanges = [
            { min: 1000, max: 3000, limit: 3 * zoomMultiplier },
            { min: 3000, max: 6000, limit: 3 * zoomMultiplier },
            { min: 6000, max: 10000, limit: 3 * zoomMultiplier },
            { min: 10000, max: Infinity, limit: 3 * zoomMultiplier }
        ];
        
        let selectedCountries = [];
        distanceRanges.forEach(range => {
            const inRange = countriesInCone.filter(c =>
                c.distance_km >= range.min && c.distance_km < range.max
            );
            // Sort by distance within range and take the limit
            inRange.sort((a, b) => a.distance_km - b.distance_km);
            selectedCountries = selectedCountries.concat(inRange.slice(0, range.limit));
        });
        
        // Track marker positions for collision detection
        const markerPositions = [];
        
        // Add markers for selected countries
        let addedCount = 0;
        selectedCountries.forEach(country => {
            const destPoint = this.calculateDestinationPoint(
                this.receiverLat, this.receiverLon,
                country.bearing, country.distance_km
            );
            const projected = this.projection([destPoint[1], destPoint[0]]);
            
            if (!projected) return;
            
            const [x, y] = projected;

            // Transform coordinates from map space to screen space
            const screenCoords = this.currentTransform.apply([x, y]);

            // Zoom-aware collision detection in screen space
            // This allows more countries to be displayed when zoomed in
            const baseDistance = country.distance_km < 2000 ? 30 : 20;
            const minDistance = baseDistance;

            // Check for collision with existing markers (in screen space)
            const hasCollision = markerPositions.some(pos => {
                const dx = pos.x - screenCoords[0];
                const dy = pos.y - screenCoords[1];
                return Math.sqrt(dx * dx + dy * dy) < minDistance;
            });

            if (hasCollision) return;

            // Record position (in screen space)
            markerPositions.push({ x: screenCoords[0], y: screenCoords[1] });

            // Create smaller marker group
            const markerGroup = this.markerGroup.append('g')
                .attr('class', 'cone-marker')
                .attr('transform', `translate(${screenCoords[0]}, ${screenCoords[1]})`);
            
            // Add smaller marker circle
            markerGroup.append('circle')
                .attr('r', 4)
                .attr('fill', 'rgba(255, 193, 7, 0.8)')
                .attr('stroke', '#fff')
                .attr('stroke-width', 1)
                .style('filter', 'drop-shadow(0 0 3px rgba(255, 193, 7, 0.6))');
            
            // Add country name label with text wrapping for long names
            const maxCharsPerLine = 12;
            const countryName = country.name;

            if (countryName.length <= maxCharsPerLine) {
                // Short name - single line
                markerGroup.append('text')
                    .attr('x', 0)
                    .attr('y', -10)
                    .attr('text-anchor', 'middle')
                    .attr('fill', 'rgba(255, 255, 255, 0.9)')
                    .attr('font-size', '12px')
                    .attr('font-weight', 'bold')
                    .style('text-shadow', '0 0 3px rgba(0,0,0,0.8)')
                    .text(countryName);
            } else {
                // Long name - split into two lines
                const words = countryName.split(' ');
                let line1 = '';
                let line2 = '';

                // Try to split at a space
                if (words.length > 1) {
                    const midPoint = Math.ceil(words.length / 2);
                    line1 = words.slice(0, midPoint).join(' ');
                    line2 = words.slice(midPoint).join(' ');
                } else {
                    // No spaces, split in middle
                    const mid = Math.ceil(countryName.length / 2);
                    line1 = countryName.substring(0, mid);
                    line2 = countryName.substring(mid);
                }

                const textElement = markerGroup.append('text')
                    .attr('x', 0)
                    .attr('text-anchor', 'middle')
                    .attr('fill', 'rgba(255, 255, 255, 0.9)')
                    .attr('font-size', '12px')
                    .attr('font-weight', 'bold')
                    .style('text-shadow', '0 0 3px rgba(0,0,0,0.8)');

                textElement.append('tspan')
                    .attr('x', 0)
                    .attr('dy', '-16')
                    .text(line1);

                textElement.append('tspan')
                    .attr('x', 0)
                    .attr('dy', '12')
                    .text(line2);
            }
            
            addedCount++;
        });
    }
    
    /**
     * Update cone markers to show countries in current beam direction
     * @param {Array} allCountries - Array of all countries
     * @param {number} currentAzimuth - Current rotator azimuth
     */
    updateConeMarkers(allCountries, currentAzimuth) {
        if (!this.showMap || !this.mapGroup || !this.projection) return;
        
        // Remove existing cone markers (but not country marker)
        this.markerGroup.selectAll('.cone-marker').remove();
        
        // Show cone markers
        this.showConeMarkers(allCountries, currentAzimuth, null);
    }
    
    /**
     * Clear the country marker from the map
     */
    clearCountryMarker() {
        if (this.markerGroup) {
            this.markerGroup.selectAll('.country-marker').remove();
            this.markerGroup.selectAll('.cone-marker').remove();
        }
    }

    /**
     * Redraw markers after zoom level changes to show more/fewer countries
     * This is called from rotator.html's updateStatus function
     */
    redrawMarkersAfterZoom() {
        // This will be triggered by the parent page's updateStatus function
        // which already has the logic to redraw markers based on selectedCountry
        const event = new CustomEvent('rotator-zoom-changed', {
            detail: { zoom: this.currentZoom }
        });
        document.dispatchEvent(event);
    }

    /**
     * Set countries data for tooltip display
     * @param {Array} countries - Array of country objects with bearing and distance_km
     */
    setCountriesData(countries) {
        this.countriesData = countries || [];
    }

    /**
     * Find the closest country to a given bearing and distance
     * @param {number} targetBearing - Target bearing in degrees
     * @param {number} targetDistance - Target distance in km
     * @returns {Object|null} - Closest country object or null
     */
    findClosestCountry(targetBearing, targetDistance) {
        if (!this.countriesData || this.countriesData.length === 0) return null;

        let closestCountry = null;
        let minScore = Infinity;

        // Filter countries that are within reasonable distance range (±2000km)
        const distanceThreshold = 2000;
        const candidates = this.countriesData.filter(country => {
            const distanceDiff = Math.abs(country.distance_km - targetDistance);
            return distanceDiff <= distanceThreshold;
        });

        // If no candidates within threshold, use all countries but weight distance more heavily
        const countriesToCheck = candidates.length > 0 ? candidates : this.countriesData;
        const useStrictDistance = candidates.length === 0;

        // Weight factors for scoring
        // When within threshold: bearing matters more
        // When outside threshold: distance matters much more
        const bearingWeight = useStrictDistance ? 0.5 : 2.0;
        const distanceWeight = useStrictDistance ? 0.5 : 0.05;

        countriesToCheck.forEach(country => {
            // Calculate bearing difference (handle wrap-around at 0/360)
            let bearingDiff = Math.abs(country.bearing - targetBearing);
            if (bearingDiff > 180) {
                bearingDiff = 360 - bearingDiff;
            }

            // Calculate distance difference
            const distanceDiff = Math.abs(country.distance_km - targetDistance);

            // Calculate weighted score (lower is better)
            const score = (bearingDiff * bearingWeight) + (distanceDiff * distanceWeight);

            if (score < minScore) {
                minScore = score;
                closestCountry = country;
            }
        });

        return closestCountry;
    }
    
    async updatePosition() {
        try {
            const response = await fetch('/api/rotctl/status');
            const data = await response.json();
            
            if (data.position && data.position.azimuth !== undefined) {
                this.updateAzimuthDisplay(data.position.azimuth);
            }
            
            // Emit status update event for other components to listen to
            const statusEvent = new CustomEvent('rotator-status-update', {
                detail: data
            });
            document.dispatchEvent(statusEvent);
        } catch (error) {
            console.error('[RotatorDisplay] Failed to update position:', error);
            // Emit disconnected status on error
            const statusEvent = new CustomEvent('rotator-status-update', {
                detail: { connected: false }
            });
            document.dispatchEvent(statusEvent);
        }
    }
    
    startUpdates() {
        // Only start automatic updates if updateInterval is greater than 0
        if (this.updateInterval > 0) {
            // Initial update
            this.updatePosition();
            
            // Set up interval
            this.updateTimer = setInterval(() => {
                this.updatePosition();
            }, this.updateInterval);
        }
    }
    
    stopUpdates() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }
    
    destroy() {
        this.stopUpdates();
        const container = document.getElementById(this.containerId);
        if (container) {
            container.innerHTML = '';
        }
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RotatorDisplay;
}
