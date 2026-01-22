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
        svg.style.background = 'transparent';
        svg.style.borderRadius = '10px';
        svg.style.display = 'block';
        container.appendChild(svg);
        
        this.svg = d3.select(svg);
        
        // Create tooltip element
        this.createTooltip(container);
        
        // Create azimuthal equidistant projection centered on receiver
        this.projection = d3.geoAzimuthalEquidistant()
            .center([this.receiverLon, this.receiverLat])
            .scale(this.mapSize / 2 / Math.PI * 0.9)
            .translate([this.mapSize / 2, this.mapSize / 2])
            .clipAngle(180);
        
        this.path = d3.geoPath().projection(this.projection);
        
        // Draw graticule (grid lines)
        const graticule = d3.geoGraticule();
        this.svg.append("path")
            .datum(graticule)
            .attr("class", "graticule")
            .attr("d", this.path)
            .style("fill", "none")
            .style("stroke", "rgba(255,255,255,0.1)")
            .style("stroke-width", "0.5");
        
        // Draw distance circles (without labels first)
        this.drawDistanceCircles(false);
        
        // Load and draw world map
        try {
            const response = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
            const world = await response.json();
            const countries = topojson.feature(world, world.objects.countries);
            
            this.svg.append("g")
                .selectAll("path")
                .data(countries.features)
                .enter().append("path")
                .attr("class", "country")
                .attr("d", this.path)
                .style("fill", "#2c3e50")
                .style("stroke", "#4a5f7f")
                .style("stroke-width", "0.5");
        } catch (error) {
            console.error('[RotatorDisplay] Failed to load world map:', error);
        }
        
        // Draw distance labels AFTER countries so they appear on top
        this.drawDistanceLabels();
        
        // Draw center point (receiver location)
        this.svg.append("circle")
            .attr("cx", this.mapSize / 2)
            .attr("cy", this.mapSize / 2)
            .attr("r", 6)
            .attr("fill", "#ff4444")
            .attr("stroke", "#fff")
            .attr("stroke-width", 2);
        
        // Create beam cone element
        this.beamConeElement = this.svg.append("path")
            .attr("class", "beam-cone")
            .style("fill", "rgba(218, 165, 32, 0.2)")
            .style("stroke", "#DAA520")
            .style("stroke-width", "2");
        
        // Create center azimuth line element
        this.azimuthLineElement = this.svg.append("line")
            .attr("class", "azimuth-line")
            .attr("x1", this.mapSize / 2)
            .attr("y1", this.mapSize / 2)
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
        
        const [mouseX, mouseY] = d3.pointer(event);
        const coords = this.projection.invert([mouseX, mouseY]);
        
        if (!coords) {
            this.tooltip.style.display = 'none';
            return;
        }
        
        const [clickLon, clickLat] = coords;
        
        // Calculate bearing from screen coordinates (0° = North/up, clockwise)
        const centerX = this.mapSize / 2;
        const centerY = this.mapSize / 2;
        const dx = mouseX - centerX;
        const dy = mouseY - centerY;
        
        let bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
        if (bearing < 0) bearing += 360;
        
        // Calculate distance using great circle formula
        const distance = this.calculateDistance(this.receiverLat, this.receiverLon, clickLat, clickLon);
        
        // Update tooltip content
        this.tooltip.textContent = `${Math.round(bearing)}° | ${distance.toLocaleString()} km`;
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
        
        const [mouseX, mouseY] = d3.pointer(event);
        const coords = this.projection.invert([mouseX, mouseY]);
        
        if (!coords) return;
        
        // Calculate bearing from screen coordinates (0° = North/up, clockwise)
        const centerX = this.mapSize / 2;
        const centerY = this.mapSize / 2;
        const dx = mouseX - centerX;
        const dy = mouseY - centerY;
        
        let bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
        if (bearing < 0) bearing += 360;
        
        const roundedBearing = Math.round(bearing);
        
        // Emit custom event that can be handled by the parent page
        const mapClickEvent = new CustomEvent('rotator-map-click', {
            detail: { bearing: roundedBearing }
        });
        document.dispatchEvent(mapClickEvent);
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
            
            this.svg.append("path")
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
                    this.svg.append("text")
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
                this.svg.append("text")
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
                label.style.transform = 'translateX(-50%)';
                label.style.fontSize = '12px';
                label.style.fontWeight = 'bold';
                label.style.color = '#fff';
                label.style.transformOrigin = `50% ${this.compassSize/2 - 20}px`;
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
