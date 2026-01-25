/**
 * Noise Analysis Overlay for HF Spectrum Display
 * 
 * This module fetches RF noise analysis data from the backend and overlays
 * detected noise sources on the existing wideband FFT spectrum chart.
 * 
 * Usage:
 *   const overlay = new NoiseAnalysisOverlay(chartInstance);
 *   overlay.enable();
 *   overlay.fetchAndDisplay();
 */

class NoiseAnalysisOverlay {
    constructor(chart) {
        this.chart = chart;
        this.enabled = false;
        this.analysisData = null;
        this.updateInterval = null;
        this.updateIntervalMs = 10000; // Update every 10 seconds
        
        // Color scheme for different noise types
        this.noiseColors = {
            'am_broadcast': 'rgba(100, 200, 255, 0.3)',      // Light blue (legitimate signal)
            'wideband_flat': 'rgba(255, 100, 100, 0.4)',     // Red
            'wideband_sloped': 'rgba(255, 150, 50, 0.4)',    // Orange
            'harmonic': 'rgba(255, 200, 0, 0.4)',            // Yellow
            'switching_supply': 'rgba(255, 180, 0, 0.4)',    // Amber
            'broadband_peak': 'rgba(255, 50, 50, 0.5)',      // Bright red
            'narrowband_spike': 'rgba(200, 100, 255, 0.4)',  // Purple
            'comb': 'rgba(150, 255, 100, 0.4)',              // Green
            'powerline': 'rgba(100, 255, 200, 0.3)',         // Cyan
            'unknown': 'rgba(150, 150, 150, 0.3)'            // Gray
        };
        
        // Border colors (more opaque)
        this.noiseBorderColors = {
            'am_broadcast': 'rgba(100, 200, 255, 0.8)',
            'wideband_flat': 'rgba(255, 100, 100, 0.8)',
            'wideband_sloped': 'rgba(255, 150, 50, 0.8)',
            'harmonic': 'rgba(255, 200, 0, 0.8)',
            'switching_supply': 'rgba(255, 180, 0, 0.8)',
            'broadband_peak': 'rgba(255, 50, 50, 0.9)',
            'narrowband_spike': 'rgba(200, 100, 255, 0.8)',
            'comb': 'rgba(150, 255, 100, 0.8)',
            'powerline': 'rgba(100, 255, 200, 0.8)',
            'unknown': 'rgba(150, 150, 150, 0.8)'
        };
    }
    
    /**
     * Enable the noise analysis overlay
     */
    enable() {
        this.enabled = true;
        this.startAutoUpdate();
        console.log('Noise analysis overlay enabled');
    }
    
    /**
     * Disable the noise analysis overlay
     */
    disable() {
        this.enabled = false;
        this.stopAutoUpdate();
        this.clearOverlay();
        console.log('Noise analysis overlay disabled');
    }
    
    /**
     * Toggle the overlay on/off
     */
    toggle() {
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
        return this.enabled;
    }
    
    /**
     * Start automatic updates
     */
    startAutoUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        // Fetch immediately
        this.fetchAndDisplay();
        
        // Then fetch periodically
        this.updateInterval = setInterval(() => {
            this.fetchAndDisplay();
        }, this.updateIntervalMs);
    }
    
    /**
     * Stop automatic updates
     */
    stopAutoUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
    
    /**
     * Fetch noise analysis data from the backend
     */
    async fetchAnalysisData() {
        try {
            const response = await fetch('/api/noisefloor/analyze');
            
            if (!response.ok) {
                if (response.status === 204) {
                    console.log('No noise analysis data available yet');
                    return null;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            console.log(`Noise analysis: ${data.sources.length} sources detected, processing time: ${data.processing_time_ms.toFixed(1)}ms`);
            return data;
            
        } catch (error) {
            console.error('Error fetching noise analysis:', error);
            return null;
        }
    }
    
    /**
     * Fetch and display noise analysis overlay
     */
    async fetchAndDisplay() {
        if (!this.enabled) {
            return;
        }
        
        const data = await this.fetchAnalysisData();
        if (data) {
            this.analysisData = data;
            this.updateOverlay();
        }
    }
    
    /**
     * Clear all overlay annotations from the chart
     */
    clearOverlay() {
        if (!this.chart || !this.chart.options || !this.chart.options.plugins) {
            return;
        }
        
        // Remove all noise-related annotations
        if (this.chart.options.plugins.annotation && this.chart.options.plugins.annotation.annotations) {
            const annotations = this.chart.options.plugins.annotation.annotations;
            
            // Remove annotations that start with 'noise-'
            Object.keys(annotations).forEach(key => {
                if (key.startsWith('noise-')) {
                    delete annotations[key];
                }
            });
            
            this.chart.update('none'); // Update without animation
        }
    }
    
    /**
     * Update the chart overlay with current analysis data
     */
    updateOverlay() {
        if (!this.chart || !this.analysisData || !this.enabled) {
            return;
        }
        
        // Clear existing noise overlays
        this.clearOverlay();
        
        // Ensure annotation plugin is initialized
        if (!this.chart.options.plugins.annotation) {
            this.chart.options.plugins.annotation = { annotations: {} };
        }
        if (!this.chart.options.plugins.annotation.annotations) {
            this.chart.options.plugins.annotation.annotations = {};
        }
        
        const annotations = this.chart.options.plugins.annotation.annotations;
        
        // Add annotations for each detected noise source
        this.analysisData.sources.forEach((source, index) => {
            this.addNoiseAnnotation(annotations, source, index);
        });
        
        // Update chart
        this.chart.update('none'); // Update without animation for smooth overlay
    }
    
    /**
     * Add an annotation for a noise source
     */
    addNoiseAnnotation(annotations, source, index) {
        const startFreqMHz = source.center_frequency_hz / 1e6 - (source.bandwidth_hz / 2) / 1e6;
        const endFreqMHz = source.center_frequency_hz / 1e6 + (source.bandwidth_hz / 2) / 1e6;
        const centerFreqMHz = source.center_frequency_hz / 1e6;
        
        // Get colors for this noise type
        const fillColor = this.noiseColors[source.type] || this.noiseColors['unknown'];
        const borderColor = this.noiseBorderColors[source.type] || this.noiseBorderColors['unknown'];
        
        // Create box annotation for the noise region
        const boxKey = `noise-box-${index}`;
        annotations[boxKey] = {
            type: 'box',
            xMin: startFreqMHz,
            xMax: endFreqMHz,
            backgroundColor: fillColor,
            borderColor: borderColor,
            borderWidth: 2,
            borderDash: source.type === 'am_broadcast' ? [] : [5, 5], // Solid for AM, dashed for noise
            label: {
                display: true,
                content: this.formatNoiseLabel(source),
                enabled: true,
                position: 'start',
                backgroundColor: 'rgba(0, 0, 0, 0.7)',
                color: '#fff',
                font: {
                    size: 10,
                    weight: 'bold'
                },
                padding: 4
            }
        };
        
        // For harmonic sources, add markers for each harmonic
        if (source.harmonics && source.harmonics.length > 0) {
            source.harmonics.forEach((harmonic, hIndex) => {
                const harmFreqMHz = harmonic.frequency_hz / 1e6;
                const lineKey = `noise-harmonic-${index}-${hIndex}`;
                
                annotations[lineKey] = {
                    type: 'line',
                    xMin: harmFreqMHz,
                    xMax: harmFreqMHz,
                    borderColor: borderColor,
                    borderWidth: 1,
                    borderDash: [2, 2],
                    label: {
                        display: harmonic.harmonic <= 5, // Only label first 5 harmonics
                        content: `H${harmonic.harmonic}`,
                        enabled: true,
                        position: 'end',
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        color: '#fff',
                        font: {
                            size: 8
                        },
                        padding: 2
                    }
                };
            });
        }
        
        // For broadband peaks, add a marker at the peak
        if (source.type === 'broadband_peak' && source.peak_bin !== undefined) {
            const lineKey = `noise-peak-${index}`;
            annotations[lineKey] = {
                type: 'line',
                xMin: centerFreqMHz,
                xMax: centerFreqMHz,
                borderColor: 'rgba(255, 0, 0, 0.8)',
                borderWidth: 2,
                label: {
                    display: true,
                    content: '⚠ Peak',
                    enabled: true,
                    position: 'start',
                    backgroundColor: 'rgba(255, 0, 0, 0.8)',
                    color: '#fff',
                    font: {
                        size: 9,
                        weight: 'bold'
                    },
                    padding: 3
                }
            };
        }
    }
    
    /**
     * Format a label for a noise source
     */
    formatNoiseLabel(source) {
        const freqMHz = (source.center_frequency_hz / 1e6).toFixed(3);
        const confidence = Math.round(source.confidence);
        
        // Create label based on noise type
        let label = '';
        
        switch (source.type) {
            case 'am_broadcast':
                label = `📻 AM ${freqMHz} MHz`;
                break;
            case 'wideband_flat':
                label = `⚠ Wideband ${freqMHz} MHz (${confidence}%)`;
                break;
            case 'wideband_sloped':
                label = `⚠ Sloped ${freqMHz} MHz (${confidence}%)`;
                break;
            case 'harmonic':
            case 'switching_supply':
                const numHarmonics = source.harmonics ? source.harmonics.length : 0;
                label = `⚡ ${numHarmonics}H @ ${freqMHz} MHz`;
                break;
            case 'broadband_peak':
                label = `🔴 Peak ${freqMHz} MHz`;
                break;
            case 'narrowband_spike':
                label = `📍 Spike ${freqMHz} MHz`;
                break;
            case 'comb':
                const spacingKHz = (source.spacing_hz / 1e3).toFixed(1);
                label = `⚙ Comb ${spacingKHz} kHz`;
                break;
            case 'powerline':
                label = `⚡ Powerline ${source.fundamental_hz} Hz`;
                break;
            default:
                label = `? ${freqMHz} MHz`;
        }
        
        return label;
    }
    
    /**
     * Get a summary of detected noise sources
     */
    getSummary() {
        if (!this.analysisData) {
            return null;
        }
        
        const summary = {
            total_sources: this.analysisData.sources.length,
            baseline_db: this.analysisData.baseline_noise_db,
            dynamic_range_db: this.analysisData.dynamic_range_db,
            clean_percent: this.analysisData.clean_bins_percent,
            noisy_percent: this.analysisData.noisy_bins_percent,
            by_type: {},
            by_severity: {
                low: 0,
                medium: 0,
                high: 0,
                critical: 0
            }
        };
        
        // Count by type and severity
        this.analysisData.sources.forEach(source => {
            // Count by type
            if (!summary.by_type[source.type]) {
                summary.by_type[source.type] = 0;
            }
            summary.by_type[source.type]++;
            
            // Count by severity
            if (summary.by_severity[source.severity] !== undefined) {
                summary.by_severity[source.severity]++;
            }
        });
        
        return summary;
    }
    
    /**
     * Generate HTML for a noise summary panel
     */
    generateSummaryHTML() {
        const summary = this.getSummary();
        if (!summary) {
            return '<div class="noise-summary">No analysis data available</div>';
        }
        
        let html = '<div class="noise-summary">';
        html += `<h4>RF Noise Analysis</h4>`;
        html += `<div class="noise-stats">`;
        html += `<div><strong>Sources Detected:</strong> ${summary.total_sources}</div>`;
        html += `<div><strong>Baseline:</strong> ${summary.baseline_db.toFixed(1)} dB</div>`;
        html += `<div><strong>Dynamic Range:</strong> ${summary.dynamic_range_db.toFixed(1)} dB</div>`;
        html += `<div><strong>Clean Spectrum:</strong> ${summary.clean_percent.toFixed(1)}%</div>`;
        html += `</div>`;
        
        if (summary.total_sources > 0) {
            html += `<div class="noise-severity">`;
            html += `<h5>By Severity:</h5>`;
            if (summary.by_severity.critical > 0) html += `<div class="severity-critical">Critical: ${summary.by_severity.critical}</div>`;
            if (summary.by_severity.high > 0) html += `<div class="severity-high">High: ${summary.by_severity.high}</div>`;
            if (summary.by_severity.medium > 0) html += `<div class="severity-medium">Medium: ${summary.by_severity.medium}</div>`;
            if (summary.by_severity.low > 0) html += `<div class="severity-low">Low: ${summary.by_severity.low}</div>`;
            html += `</div>`;
            
            html += `<div class="noise-types">`;
            html += `<h5>By Type:</h5>`;
            Object.entries(summary.by_type).forEach(([type, count]) => {
                const displayName = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                html += `<div>${displayName}: ${count}</div>`;
            });
            html += `</div>`;
        }
        
        html += '</div>';
        return html;
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NoiseAnalysisOverlay;
}
