// Bandwidth Control Module
// Handles keyboard shortcuts (z/x) for adjusting bandwidth with mode-specific behavior

// Throttling for bandwidth adjustments (25ms = 40 updates per second max)
// Optimized for 40 cmd/sec rate limit (using full capacity)
// Store on window to ensure persistence across module reloads
if (!window.bandwidthControlState) {
    window.bandwidthControlState = {
        lastAdjustTime: 0,
        throttleMs: 25
    };
}

/**
 * Adjust bandwidth based on current mode
 * @param {number} direction - 1 for increase, -1 for decrease
 */
export function adjustBandwidth(direction) {
    // Throttle updates to 40 per second (25ms interval)
    const now = Date.now();
    const timeSinceLastAdjust = now - window.bandwidthControlState.lastAdjustTime;
    
    if (timeSinceLastAdjust < window.bandwidthControlState.throttleMs) {
        return; // Skip this adjustment, too soon
    }
    
    window.bandwidthControlState.lastAdjustTime = now;
    
    const step = 50; // Hz step size
    const change = direction * step;
    
    const bandwidthLowSlider = document.getElementById('bandwidth-low');
    const bandwidthHighSlider = document.getElementById('bandwidth-high');
    
    if (!bandwidthLowSlider || !bandwidthHighSlider) {
        console.error('Bandwidth sliders not found');
        return;
    }
    
    // Get current mode and bandwidth from window globals (most reliable source)
    const currentMode = window.currentMode || 'usb';
    const currentBandwidthLow = window.currentBandwidthLow || parseInt(bandwidthLowSlider.value);
    const currentBandwidthHigh = window.currentBandwidthHigh || parseInt(bandwidthHighSlider.value);
    
    let newLow = currentBandwidthLow;
    let newHigh = currentBandwidthHigh;
    
    switch(currentMode) {
        case 'usb':
            // USB: only change high (upper edge)
            newHigh = currentBandwidthHigh + change;
            // In combined slider mode, enforce 50 Hz fixed low edge and 100 Hz min high
            if (document.getElementById('bandwidth-dot-toggle')?.classList.contains('active')) {
                newHigh = Math.max(100, Math.min(6000, newHigh));
                newLow = 50;
            } else {
                newHigh = Math.max(0, Math.min(6000, newHigh));
            }
            break;
            
        case 'lsb':
            // LSB: only change low (lower edge)
            newLow = currentBandwidthLow - change;
            // In combined slider mode, enforce -50 Hz fixed high edge and -100 Hz max low
            if (document.getElementById('bandwidth-dot-toggle')?.classList.contains('active')) {
                newLow = Math.max(-6000, Math.min(-100, newLow));
                newHigh = -50;
            } else {
                newLow = Math.max(-6000, Math.min(0, newLow));
            }
            break;
            
        case 'cwu':
        case 'cwl':
            // CW: change both symmetrically
            newLow = currentBandwidthLow - change;
            newHigh = currentBandwidthHigh + change;
            // Clamp to valid range (-500 to 500 Hz)
            newLow = Math.max(-500, Math.min(0, newLow));
            newHigh = Math.max(0, Math.min(500, newHigh));
            break;
            
        case 'am':
        case 'sam':
            // AM/SAM: change both symmetrically
            newLow = currentBandwidthLow - change;
            newHigh = currentBandwidthHigh + change;
            // Clamp to valid range (-6000 to 6000 Hz)
            newLow = Math.max(-6000, Math.min(0, newLow));
            newHigh = Math.max(0, Math.min(6000, newHigh));
            break;
            
        case 'fm':
            // FM: change both symmetrically
            newLow = currentBandwidthLow - change;
            newHigh = currentBandwidthHigh + change;
            // Clamp to valid range (-5000 to 5000 Hz)
            newLow = Math.max(-5000, Math.min(0, newLow));
            newHigh = Math.max(0, Math.min(5000, newHigh));
            break;
            
        case 'nfm':
            // NFM: change both symmetrically
            newLow = currentBandwidthLow - change;
            newHigh = currentBandwidthHigh + change;
            // Clamp to valid range (-6250 to 6250 Hz)
            newLow = Math.max(-6250, Math.min(0, newLow));
            newHigh = Math.max(0, Math.min(6250, newHigh));
            break;
            
        default:
            console.warn(`Unknown mode: ${currentMode}`);
            return;
    }
    
    // Update global references FIRST (before any other operations)
    window.currentBandwidthLow = newLow;
    window.currentBandwidthHigh = newHigh;
    
    // Update sliders and trigger change event to ensure all handlers are called
    bandwidthLowSlider.value = newLow;
    bandwidthHighSlider.value = newHigh;
    
    // Update display values directly
    const lowValueEl = document.getElementById('bandwidth-low-value');
    const highValueEl = document.getElementById('bandwidth-high-value');
    if (lowValueEl) {
        lowValueEl.textContent = newLow;
    }
    if (highValueEl) {
        highValueEl.textContent = newHigh;
    }

    // If the combined (single) slider is currently visible, keep it in sync
    const combinedGroup = document.getElementById('bandwidth-combined-group');
    if (combinedGroup && combinedGroup.style.display !== 'none') {
        const combinedSlider = document.getElementById('bandwidth-combined');
        const combinedValueEl = document.getElementById('bandwidth-combined-value');
        if (combinedSlider) {
            // Combined slider value is always the positive half-bandwidth
            const combinedVal = currentMode === 'lsb'
                ? Math.abs(newLow)
                : Math.abs(newHigh);
            combinedSlider.value = combinedVal;
            if (combinedValueEl) {
                combinedValueEl.textContent = combinedVal;
            }
        }
    }
    
    // Don't call updateBandwidth() as it re-reads the globals which may have been overwritten
    // Instead, do the side effects directly with our known-good values
    
    // Notify extension system of bandwidth change
    if (window.radioAPI) {
        window.radioAPI.notifyBandwidthChange(newLow, newHigh);
    }
    
    // Update FFT size based on new bandwidth
    if (window.analyser) {
        const oldFFTSize = window.analyser.fftSize;
        const bandwidth = Math.abs(newHigh - newLow);
        let newFFTSize;
        
        if (bandwidth < 300) {
            newFFTSize = 65536;
        } else if (bandwidth < 600) {
            newFFTSize = 32768;
        } else if (bandwidth < 1500) {
            newFFTSize = 16384;
        } else if (bandwidth < 4000) {
            newFFTSize = 16384;
        } else {
            newFFTSize = 8192;
        }
        
        if (oldFFTSize !== newFFTSize) {
            window.analyser.fftSize = newFFTSize;
            if (window.updateFFTSizeDropdown) {
                window.updateFFTSizeDropdown();
            }
            if (window.log) {
                window.log(`FFT size auto-adjusted to ${newFFTSize} for ${bandwidth} Hz bandwidth`);
            }
        }
    }
    
    // Clear waterfall when bandwidth changes
    if (window.waterfallCtx && window.waterfallCanvas) {
        window.waterfallCtx.fillStyle = '#000';
        window.waterfallCtx.fillRect(0, 0, window.waterfallCanvas.width, window.waterfallCanvas.height);
        window.waterfallStartTime = Date.now();
        window.waterfallLineCount = 0;
    }
    
    // Update spectrum display bandwidth indicator
    // Skip if chat is syncing to prevent flickering
    // Note: do NOT pass tunedFreq here — passing it triggers the pan-to-follow
    // logic in updateConfig() which can cause edge-tune to fire and change the
    // dial frequency. The mouse-slider path (updateBandwidth in app.js) also
    // omits tunedFreq for the same reason.
    if (window.spectrumDisplay && (!window.chatUI || !window.chatUI.isSyncing)) {
        window.spectrumDisplay.updateConfig({
            bandwidthLow: newLow,
            bandwidthHigh: newHigh
        });
    }
    
    // Update bandpass slider ranges if bandpass is enabled
    if (window.bandpassEnabled && window.updateBandpassSliderRanges) {
        window.updateBandpassSliderRanges();
    }
    
    // Log the change
    const directionText = direction > 0 ? 'increased' : 'decreased';
    if (window.log) {
        window.log(`Bandwidth ${directionText}: ${newLow} to ${newHigh} Hz`);
    }
    
    // Update URL with new bandwidth
    if (window.updateURL) {
        window.updateURL();
    }
    
    // Tune to new bandwidth (this will send the tune command to radiod)
    if (window.autoTune) {
        window.autoTune();
    }
}

/**
 * Update bandwidth slider tooltips based on current mode
 */
export function updateBandwidthTooltips() {
    const currentMode = window.currentMode || 'usb';
    const lowSlider = document.getElementById('bandwidth-low');
    const highSlider = document.getElementById('bandwidth-high');
    
    if (!lowSlider || !highSlider) return;
    
    let lowTooltip = '';
    let highTooltip = '';
    
    switch(currentMode) {
        case 'usb':
            lowTooltip = 'Lower edge (fixed) - Use Z/X keys to adjust upper edge';
            highTooltip = 'Upper edge (adjustable) - Press Z to decrease, X to increase';
            break;
            
        case 'lsb':
            lowTooltip = 'Lower edge (adjustable) - Press Z to decrease, X to increase';
            highTooltip = 'Upper edge (fixed) - Use Z/X keys to adjust lower edge';
            break;
            
        case 'cwu':
        case 'cwl':
            lowTooltip = 'Lower edge - Press Z to decrease both edges, X to increase both edges';
            highTooltip = 'Upper edge - Press Z to decrease both edges, X to increase both edges';
            break;
            
        case 'am':
        case 'sam':
            lowTooltip = 'Lower edge - Press Z to decrease both edges, X to increase both edges';
            highTooltip = 'Upper edge - Press Z to decrease both edges, X to increase both edges';
            break;
            
        case 'fm':
        case 'nfm':
            lowTooltip = 'Lower edge - Press Z to decrease both edges, X to increase both edges';
            highTooltip = 'Upper edge - Press Z to decrease both edges, X to increase both edges';
            break;
    }
    
    lowSlider.title = lowTooltip;
    highSlider.title = highTooltip;

    // Also update the combined slider tooltip
    const combinedSlider = document.getElementById('bandwidth-combined');
    if (combinedSlider) {
        combinedSlider.title = 'Bandwidth - Press Z to decrease, X to increase';
    }
}

/**
 * Initialize bandwidth control tooltips
 */
export function initializeBandwidthControl() {
    // Set initial tooltips
    updateBandwidthTooltips();
    
    // Update tooltips when mode changes
    // This will be called from app.js setMode function
    if (window.log) {
        window.log('Bandwidth control initialized with keyboard shortcuts (Z/X)');
    }
}