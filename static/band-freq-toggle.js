// Band/Frequency Toggle Functionality
// Allows toggling between band buttons and a frequency readout display

let bandFreqMode = 'bands'; // 'bands' or 'frequency'

/**
 * Toggle between band buttons and frequency readout display
 */
function toggleBandFreqDisplay() {
    const bandButtonsContainer = document.getElementById('band-buttons-container');
    const freqReadoutContainer = document.getElementById('freq-readout-container');
    
    if (bandFreqMode === 'bands') {
        // Switch to frequency mode
        bandFreqMode = 'frequency';
        bandButtonsContainer.style.display = 'none';
        freqReadoutContainer.style.display = 'flex';
        updateFrequencyReadout();
    } else {
        // Switch to bands mode
        bandFreqMode = 'bands';
        bandButtonsContainer.style.display = 'flex';
        freqReadoutContainer.style.display = 'none';
    }
}

/**
 * Update the frequency readout display with current frequency
 */
function updateFrequencyReadout() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;
    
    // Get frequency in Hz
    let freqHz = parseInt(freqInput.value) || 0;
    
    // Convert to MHz with 5 decimal places
    const freqMHz = freqHz / 1000000;
    const freqStr = freqMHz.toFixed(5);
    
    // Split into digits (format: XX.XXXXX)
    const parts = freqStr.split('.');
    const wholePart = parts[0].padStart(2, '0'); // Ensure 2 digits
    const decimalPart = parts[1] || '00000'; // Ensure 5 decimal places
    
    // Update each digit
    const digits = document.querySelectorAll('.freq-digit');
    const allDigits = wholePart + decimalPart;
    
    digits.forEach((digit, index) => {
        if (index < allDigits.length) {
            digit.textContent = allDigits[index];
        }
    });
}

/**
 * Setup frequency digit interaction (hover to increment/decrement)
 */
function setupFrequencyDigitInteraction() {
    const digits = document.querySelectorAll('.freq-digit');
    
    digits.forEach(digit => {
        let hoverInterval = null;
        let isIncrementing = true;
        
        // Mouse enter - start changing frequency
        digit.addEventListener('mouseenter', (e) => {
            const step = parseInt(digit.getAttribute('data-step'));
            
            // Determine if incrementing or decrementing based on mouse position
            const rect = digit.getBoundingClientRect();
            const mouseY = e.clientY;
            const digitCenterY = rect.top + rect.height / 2;
            isIncrementing = mouseY < digitCenterY;
            
            // Change frequency immediately
            changeFrequencyByStep(step, isIncrementing);
            
            // Continue changing while hovering
            hoverInterval = setInterval(() => {
                changeFrequencyByStep(step, isIncrementing);
            }, 150);
        });
        
        // Mouse leave - stop changing frequency
        digit.addEventListener('mouseleave', () => {
            if (hoverInterval) {
                clearInterval(hoverInterval);
                hoverInterval = null;
            }
        });
        
        // Mouse move - update direction based on position
        digit.addEventListener('mousemove', (e) => {
            const rect = digit.getBoundingClientRect();
            const mouseY = e.clientY;
            const digitCenterY = rect.top + rect.height / 2;
            const newIsIncrementing = mouseY < digitCenterY;
            
            // If direction changed, restart the interval
            if (newIsIncrementing !== isIncrementing) {
                isIncrementing = newIsIncrementing;
                if (hoverInterval) {
                    clearInterval(hoverInterval);
                    const step = parseInt(digit.getAttribute('data-step'));
                    changeFrequencyByStep(step, isIncrementing);
                    hoverInterval = setInterval(() => {
                        changeFrequencyByStep(step, isIncrementing);
                    }, 150);
                }
            }
        });
        
        // Click - single step change
        digit.addEventListener('click', (e) => {
            const step = parseInt(digit.getAttribute('data-step'));
            const rect = digit.getBoundingClientRect();
            const mouseY = e.clientY;
            const digitCenterY = rect.top + rect.height / 2;
            const increment = mouseY < digitCenterY;
            
            changeFrequencyByStep(step, increment);
        });
    });
}

/**
 * Change frequency by a specific step
 * @param {number} step - The step size in Hz
 * @param {boolean} increment - True to increment, false to decrement
 */
function changeFrequencyByStep(step, increment) {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;
    
    let currentFreq = parseInt(freqInput.value) || 0;
    
    if (increment) {
        currentFreq += step;
    } else {
        currentFreq -= step;
    }
    
    // Clamp frequency to reasonable bounds (0.1 MHz to 30 MHz for HF)
    currentFreq = Math.max(100000, Math.min(30000000, currentFreq));
    
    // Update the frequency input
    freqInput.value = currentFreq;
    
    // Update the readout display
    updateFrequencyReadout();
    
    // Apply the frequency change
    if (typeof handleFrequencyChange === 'function') {
        handleFrequencyChange();
    }
}

/**
 * Monitor frequency changes from other sources and update readout
 */
function monitorFrequencyChanges() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;
    
    // Update readout when frequency input changes
    freqInput.addEventListener('input', () => {
        if (bandFreqMode === 'frequency') {
            updateFrequencyReadout();
        }
    });
    
    // Also monitor for programmatic changes
    const observer = new MutationObserver(() => {
        if (bandFreqMode === 'frequency') {
            updateFrequencyReadout();
        }
    });
    
    observer.observe(freqInput, {
        attributes: true,
        attributeFilter: ['value']
    });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setupFrequencyDigitInteraction();
        monitorFrequencyChanges();
    });
} else {
    setupFrequencyDigitInteraction();
    monitorFrequencyChanges();
}

// Export functions to global scope
window.toggleBandFreqDisplay = toggleBandFreqDisplay;
window.updateFrequencyReadout = updateFrequencyReadout;
