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

    // Get frequency in Hz - use data-hz-value attribute if available, otherwise parse the value
    let freqHz = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) || 0;

    // Convert to MHz with 5 decimal places
    const freqMHz = freqHz / 1000000;
    const freqStr = freqMHz.toFixed(5);

    // Split into digits (format: XX.XXXXX)
    const parts = freqStr.split('.');
    const wholePart = parts[0].padStart(2, '0'); // Ensure 2 digits (e.g., "07")
    const decimalPart = (parts[1] || '00000').padEnd(5, '0'); // Ensure exactly 5 decimal places

    // Update each digit
    const digits = document.querySelectorAll('.freq-digit');

    // First 2 digits are the whole MHz part
    if (digits[0]) digits[0].textContent = wholePart[0];
    if (digits[1]) digits[1].textContent = wholePart[1];

    // Next 5 digits are the decimal part
    for (let i = 0; i < 5; i++) {
        if (digits[i + 2]) {
            digits[i + 2].textContent = decimalPart[i];
        }
    }

    // Last digit (if exists, for 8th position)
    if (digits[7] && decimalPart.length > 5) {
        digits[7].textContent = decimalPart[5] || '0';
    }
}

/**
 * Setup frequency digit interaction (scroll wheel and click to increment/decrement)
 */
function setupFrequencyDigitInteraction() {
    const digits = document.querySelectorAll('.freq-digit');

    digits.forEach(digit => {
        // Mouse wheel scroll - increment/decrement at this digit's step
        digit.addEventListener('wheel', (e) => {
            e.preventDefault(); // Prevent page scroll
            const step = parseInt(digit.getAttribute('data-step'));
            const increment = e.deltaY < 0; // Scroll up = increment, scroll down = decrement

            changeFrequencyByStep(step, increment);
        }, { passive: false });

        // Hover - show it's interactive
        digit.addEventListener('mouseenter', () => {
            digit.style.cursor = 'ns-resize'; // Up/down arrow cursor
        });

        // Reset cursor on mouse leave
        digit.addEventListener('mouseleave', () => {
            digit.style.cursor = 'pointer';
        });

        // Click - single step change (click upper half = increment, lower half = decrement)
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

    // Get current frequency from data-hz-value attribute
    let currentFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) || 0;

    if (increment) {
        currentFreq += step;
    } else {
        currentFreq -= step;
    }

    // Clamp frequency to reasonable bounds (0.1 MHz to 30 MHz for HF)
    currentFreq = Math.max(100000, Math.min(30000000, currentFreq));

    // Use the global setFrequencyInputValue function to properly update the input
    if (typeof window.setFrequencyInputValue === 'function') {
        window.setFrequencyInputValue(currentFreq);
    } else {
        // Fallback if function not available yet
        freqInput.value = currentFreq;
        freqInput.setAttribute('data-hz-value', currentFreq);
    }

    // Update the readout display
    updateFrequencyReadout();

    // Update band buttons
    if (typeof window.updateBandButtons === 'function') {
        window.updateBandButtons(currentFreq);
    }

    // Update band selector
    if (typeof window.updateBandSelector === 'function') {
        window.updateBandSelector();
    }

    // Update URL
    if (typeof window.updateURL === 'function') {
        window.updateURL();
    }

    // Apply the frequency change
    if (typeof window.autoTune === 'function') {
        window.autoTune();
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

    // Also monitor for programmatic changes to data-hz-value attribute
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'data-hz-value') {
                if (bandFreqMode === 'frequency') {
                    updateFrequencyReadout();
                }
            }
        });
    });

    observer.observe(freqInput, {
        attributes: true,
        attributeFilter: ['data-hz-value']
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
