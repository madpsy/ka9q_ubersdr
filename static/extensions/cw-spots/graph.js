// CW Spots Graph Popup JavaScript
// Receives spot data from parent window via postMessage

// Register the datalabels plugin with Chart.js
Chart.register(ChartDataLabels);

class CWSpotsGraph {
    constructor() {
        this.spots = [];
        this.chart = null;
        this.ageFilter = 10; // minutes
        this.snrFilter = -999; // no filter
        this.lastSpotTime = null;
        this.showLabels = true; // Show callsign labels by default
        this.hoverTune = true; // Tune when hovering over spots
        this.autoTune = false; // Auto-tune to new spots
        this.parentCheckInterval = null;
        this.activeTooltip = null; // Track active tooltip from label hover

        this.init();
    }

    init() {
        console.log('CW Spots Graph: Initializing...');

        // Setup message listener from parent window
        window.addEventListener('message', (event) => {
            this.handleMessage(event);
        });

        // Setup UI event handlers
        this.setupEventHandlers();

        // Sync checkbox states (Firefox remembers form state across refreshes)
        this.syncCheckboxStates();

        // Initialize chart
        this.initChart();

        // Request initial data from parent
        this.requestInitialData();

        // Update status
        this.updateStatus('connected');

        // Start monitoring parent window
        this.startParentMonitoring();

        console.log('CW Spots Graph: Ready');
    }

    startParentMonitoring() {
        // Check if parent window is still open every 2 seconds
        this.parentCheckInterval = setInterval(() => {
            if (!window.opener || window.opener.closed) {
                this.showDisconnectedOverlay();
                clearInterval(this.parentCheckInterval);
            }
        }, 2000);
    }

    showDisconnectedOverlay() {
        const overlay = document.getElementById('disconnected-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
        }
        this.updateStatus('disconnected');
    }

    hideDisconnectedOverlay() {
        const overlay = document.getElementById('disconnected-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }
    
    handleMessage(event) {
        const { type, data } = event.data;
        
        switch (type) {
            case 'cw_spot':
                this.addSpot(data);
                this.hideDisconnectedOverlay(); // Hide overlay if extension reconnects
                break;
            case 'cw_spots_initial':
                this.loadInitialSpots(data);
                this.hideDisconnectedOverlay(); // Hide overlay if extension reconnects
                break;
            case 'cw_spots_clear':
                this.clearSpots();
                break;
            case 'extension_disabled':
                this.showDisconnectedOverlay();
                break;
            case 'extension_enabled':
                this.hideDisconnectedOverlay();
                this.updateStatus('connected');
                break;
            default:
                // Ignore unknown message types
                break;
        }
    }
    
    requestInitialData() {
        // Ask parent window for current spots
        if (window.opener) {
            window.opener.postMessage({ type: 'request_initial_spots' }, '*');
        }
    }
    
    loadInitialSpots(spots) {
        console.log('CW Spots Graph: Loading', spots.length, 'initial spots');
        this.spots = spots.map(spot => ({
            ...spot,
            timestamp: new Date(spot.time)
        }));
        this.updateChart();
        this.updateUI();
    }
    
    addSpot(spot) {
        // Add timestamp
        spot.timestamp = new Date(spot.time);
        
        // Add to spots array
        this.spots.unshift(spot);
        
        // Limit array size
        if (this.spots.length > 5000) {
            this.spots = this.spots.slice(0, 5000);
        }
        
        // Update last spot time
        this.lastSpotTime = spot.timestamp;

        // Update latest spot display
        this.updateLatestSpot(spot);

        // Auto-tune if enabled
        if (this.autoTune) {
            this.tuneToSpot(spot);
        }

        // Update chart and UI
        this.updateChart();
        this.updateUI();
    }

    clearSpots() {
        this.spots = [];
        this.lastSpotTime = null;

        // Reset latest spot display
        const latestSpotEl = document.getElementById('latest-spot');
        if (latestSpotEl) {
            latestSpotEl.textContent = 'No spots yet';
            latestSpotEl.className = 'latest-spot no-spot';
            latestSpotEl.style.cursor = 'default';
            latestSpotEl.onclick = null;
            delete latestSpotEl.dataset.spot;
        }

        this.updateChart();
        this.updateUI();
    }
    
    setupEventHandlers() {
        // Age filter
        document.getElementById('graph-age-filter').addEventListener('change', (e) => {
            this.ageFilter = parseInt(e.target.value);
            this.updateChart();
            this.updateUI();
        });
        
        // SNR filter
        document.getElementById('graph-snr-filter').addEventListener('change', (e) => {
            this.snrFilter = parseInt(e.target.value);
            this.updateChart();
            this.updateUI();
        });
        
        // Clear button
        document.getElementById('clear-btn').addEventListener('click', () => {
            this.clearSpots();
            // Notify parent to clear as well
            if (window.opener) {
                window.opener.postMessage({ type: 'clear_spots_from_graph' }, '*');
            }
        });

        // Show labels checkbox
        document.getElementById('show-labels-checkbox').addEventListener('change', (e) => {
            this.showLabels = e.target.checked;
            this.updateChart();
        });

        // Hover-tune checkbox
        document.getElementById('hover-tune-checkbox').addEventListener('change', (e) => {
            this.hoverTune = e.target.checked;
        });

        // Auto-tune checkbox
        document.getElementById('auto-tune-checkbox').addEventListener('change', (e) => {
            this.autoTune = e.target.checked;
        });

        // Fullscreen button
        document.getElementById('fullscreen-btn').addEventListener('click', () => {
            this.toggleFullscreen();
        });
    }

    syncCheckboxStates() {
        // Sync JavaScript properties with checkbox states
        // (Firefox remembers form state across refreshes)
        const showLabelsCheckbox = document.getElementById('show-labels-checkbox');
        if (showLabelsCheckbox) {
            this.showLabels = showLabelsCheckbox.checked;
        }

        const hoverTuneCheckbox = document.getElementById('hover-tune-checkbox');
        if (hoverTuneCheckbox) {
            this.hoverTune = hoverTuneCheckbox.checked;
        }

        const autoTuneCheckbox = document.getElementById('auto-tune-checkbox');
        if (autoTuneCheckbox) {
            this.autoTune = autoTuneCheckbox.checked;
        }
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            // Enter fullscreen
            document.documentElement.requestFullscreen().catch(err => {
                console.error('Error attempting to enable fullscreen:', err);
            });
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }
    
    initChart() {
        const ctx = document.getElementById('spotsChart').getContext('2d');
        const self = this; // Capture reference for use in callbacks
        
        this.chart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: '#4CAF50',
                        borderWidth: 1,
                        callbacks: {
                            title: (items) => {
                                if (items.length > 0) {
                                    const spot = items[0].raw.spot;
                                    return spot.dx_call || 'Unknown';
                                }
                                return '';
                            },
                            label: (item) => {
                                const spot = item.raw.spot;
                                const lines = [];
                                lines.push(`Freq: ${(spot.frequency / 1e6).toFixed(4)} MHz`);
                                lines.push(`Band: ${spot.band || 'Unknown'}`);
                                lines.push(`SNR: ${spot.snr} dB`);
                                lines.push(`WPM: ${spot.wpm || 'N/A'}`);
                                if (spot.country) lines.push(`Country: ${spot.country}`);
                                if (spot.distance_km) lines.push(`Distance: ${Math.round(spot.distance_km)} km`);
                                return lines;
                            }
                        }
                    },
                    datalabels: {
                        display: (context) => {
                            return self.showLabels;
                        },
                        formatter: (value, context) => {
                            return value.spot.dx_call || 'Unknown';
                        },
                        color: '#ffffff',
                        font: {
                            size: 10,
                            weight: 'normal'
                        },
                        align: 'right',
                        offset: 4,
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        borderRadius: 3,
                        padding: {
                            top: 2,
                            bottom: 2,
                            left: 4,
                            right: 4
                        },
                        clip: false
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'minute',
                            displayFormats: {
                                minute: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time (UTC)',
                            color: '#aaa'
                        },
                        ticks: {
                            color: '#aaa'
                        },
                        grid: {
                            color: '#444'
                        },
                        afterFit: (scale) => {
                            // Add padding to the right to accommodate labels
                            scale.paddingRight = 60;
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Frequency (MHz)',
                            color: '#aaa'
                        },
                        ticks: {
                            color: '#aaa',
                            callback: function(value) {
                                return value.toFixed(3);
                            }
                        },
                        grid: {
                            color: '#444'
                        }
                    }
                },
                onClick: (event, elements) => {
                    if (elements.length > 0) {
                        const spot = elements[0].element.$context.raw.spot;
                        this.tuneToSpot(spot);
                    }
                },
                onHover: (event, elements) => {
                    if (this.hoverTune && elements.length > 0) {
                        // Get the chart element
                        const element = elements[0];
                        // Access the data through the chart's dataset
                        const datasetIndex = element.datasetIndex;
                        const index = element.index;
                        const spot = this.chart.data.datasets[datasetIndex].data[index].spot;
                        if (spot) {
                            this.tuneToSpot(spot);
                        }
                    }
                }
            }
        });
    }
    
    updateChart() {
        if (!this.chart) return;
        
        // Filter spots
        const filtered = this.getFilteredSpots();
        
        // Group by SNR for color coding
        const datasets = this.createDatasets(filtered);
        
        // Update chart
        this.chart.data.datasets = datasets;
        this.chart.update('none'); // Use 'none' mode for better performance
    }
    
    getFilteredSpots() {
        const now = new Date();
        const maxAge = this.ageFilter * 60 * 1000; // Convert to milliseconds
        
        return this.spots.filter(spot => {
            // Age filter
            if (this.ageFilter && (now - spot.timestamp) > maxAge) {
                return false;
            }
            
            // SNR filter
            if (this.snrFilter > -999 && spot.snr < this.snrFilter) {
                return false;
            }
            
            return true;
        });
    }
    
    createDatasets(spots) {
        // Group spots by SNR range for color coding
        const groups = {
            excellent: { label: 'Excellent (>26dB)', color: '#28a745', data: [] },
            good: { label: 'Good (13-26dB)', color: '#ffc107', data: [] },
            fair: { label: 'Fair (6-12dB)', color: '#ff8c00', data: [] },
            weak: { label: 'Weak (<6dB)', color: '#dc3545', data: [] }
        };
        
        spots.forEach(spot => {
            const point = {
                x: spot.timestamp,
                y: spot.frequency / 1e6, // Convert to MHz
                spot: spot
            };
            
            if (spot.snr > 26) {
                groups.excellent.data.push(point);
            } else if (spot.snr >= 13) {
                groups.good.data.push(point);
            } else if (spot.snr >= 6) {
                groups.fair.data.push(point);
            } else {
                groups.weak.data.push(point);
            }
        });
        
        // Create datasets
        return Object.values(groups).map(group => ({
            label: group.label,
            data: group.data,
            backgroundColor: group.color,
            borderColor: group.color,
            pointRadius: 4,
            pointHoverRadius: 6
        }));
    }
    
    tuneToSpot(spot) {
        // Send message to parent window to tune the receiver
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
                type: 'tune_to_spot',
                spot: spot
            }, '*');
            console.log('CW Spots Graph: Tuning to', spot.dx_call, 'on', (spot.frequency / 1e6).toFixed(3), 'MHz');
        } else {
            console.warn('CW Spots Graph: Cannot tune - parent window not available');
        }
    }
    
    updateLatestSpot(spot) {
        const latestSpotEl = document.getElementById('latest-spot');
        if (!latestSpotEl) return;

        // Determine SNR class
        let snrClass = 'snr-weak';
        if (spot.snr > 26) {
            snrClass = 'snr-excellent';
        } else if (spot.snr >= 13) {
            snrClass = 'snr-good';
        } else if (spot.snr >= 6) {
            snrClass = 'snr-fair';
        }

        // Format display text
        const callsign = spot.dx_call || 'Unknown';
        const frequency = (spot.frequency / 1e6).toFixed(4);
        const wpm = spot.wpm || 'N/A';
        const country = spot.country || '';
        const countryText = country ? ` • ${country}` : '';

        latestSpotEl.textContent = `${callsign} • ${frequency} MHz • ${wpm} WPM${countryText}`;
        latestSpotEl.className = `latest-spot ${snrClass}`;
        latestSpotEl.style.cursor = 'pointer';

        // Store spot data for click handler
        latestSpotEl.dataset.spot = JSON.stringify(spot);

        // Add click handler if not already added
        if (!latestSpotEl.onclick) {
            latestSpotEl.onclick = () => {
                const spotData = JSON.parse(latestSpotEl.dataset.spot);
                this.tuneToSpot(spotData);
            };
        }
    }

    updateUI() {
        // Update spot count
        const filtered = this.getFilteredSpots();
        const countEl = document.getElementById('spot-count');
        if (countEl) {
            countEl.textContent = `${filtered.length} spot${filtered.length !== 1 ? 's' : ''}`;
        }
        
        // Update last spot time
        const lastSpotEl = document.getElementById('last-spot-time');
        if (lastSpotEl && this.lastSpotTime) {
            const age = Math.floor((new Date() - this.lastSpotTime) / 1000);
            if (age < 60) {
                lastSpotEl.textContent = `Last: ${age}s ago`;
            } else if (age < 3600) {
                lastSpotEl.textContent = `Last: ${Math.floor(age / 60)}m ago`;
            } else {
                lastSpotEl.textContent = `Last: ${Math.floor(age / 3600)}h ago`;
            }
        } else if (lastSpotEl) {
            lastSpotEl.textContent = '';
        }
    }
    
    updateStatus(status) {
        const statusEl = document.getElementById('status-indicator');
        if (!statusEl) return;
        
        statusEl.className = 'status-badge';
        
        switch (status) {
            case 'connected':
                statusEl.classList.add('status-connected');
                statusEl.textContent = 'Connected';
                break;
            case 'disconnected':
                statusEl.classList.add('status-disconnected');
                statusEl.textContent = 'Disconnected';
                break;
            default:
                statusEl.classList.add('status-waiting');
                statusEl.textContent = 'Waiting';
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.cwSpotsGraph = new CWSpotsGraph();
    });
} else {
    window.cwSpotsGraph = new CWSpotsGraph();
}

// Update UI periodically
setInterval(() => {
    if (window.cwSpotsGraph) {
        window.cwSpotsGraph.updateUI();
    }
}, 1000);
