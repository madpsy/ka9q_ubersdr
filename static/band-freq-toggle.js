// Frequency Readout Display
// Shows current frequency in a digital readout format

// Always show frequency readout (no toggle)
let bandFreqMode = 'frequency';

// Throttling for frequency changes (matches spectrum zoom throttle)
let lastFreqChangeTime = 0;
const FREQ_CHANGE_THROTTLE_MS = 25; // 40 updates/sec max (matches rate limit)

/**
 * Update the frequency readout display with current frequency
 */
function updateFrequencyReadout() {
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;

    // Get frequency in Hz - use data-hz-value attribute if available, otherwise parse the value
    let freqHz = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) || 0;

    // Convert to MHz with 6 decimal places
    const freqMHz = freqHz / 1000000;
    const freqStr = freqMHz.toFixed(6);

    // Split into digits (format: XX.XXX.XXX - 2 whole, 3 decimal, 3 more decimal)
    const parts = freqStr.split('.');
    const wholePart = parts[0].padStart(2, '0'); // Ensure 2 digits (e.g., "14")
    const decimalPart = (parts[1] || '000000').padEnd(6, '0'); // Ensure exactly 6 decimal places

    // Update each digit
    const digits = document.querySelectorAll('.freq-digit');

    // First 2 digits are the whole MHz part (e.g., "14")
    if (digits[0]) digits[0].textContent = wholePart[0];
    if (digits[1]) digits[1].textContent = wholePart[1];

    // Next 3 digits are the first part of decimal (e.g., "074")
    for (let i = 0; i < 3; i++) {
        if (digits[i + 2]) {
            digits[i + 2].textContent = decimalPart[i];
        }
    }

    // Last 3 digits are the final decimal part (e.g., "000")
    for (let i = 0; i < 3; i++) {
        if (digits[i + 5]) {
            digits[i + 5].textContent = decimalPart[i + 3];
        }
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

            // Throttle wheel events
            const now = Date.now();
            if (now - lastFreqChangeTime < FREQ_CHANGE_THROTTLE_MS) return;
            lastFreqChangeTime = now;

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

    // Disable edge detection temporarily when user manually changes frequency
    if (window.spectrumDisplay) {
        window.spectrumDisplay.skipEdgeDetection = true;
        setTimeout(() => {
            if (window.spectrumDisplay) {
                window.spectrumDisplay.skipEdgeDetection = false;
            }
        }, 2000);
    }

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
        // Setup interaction
        setupFrequencyDigitInteraction();
        monitorFrequencyChanges();
        // Initial update
        updateFrequencyReadout();
    });
} else {
    // Setup interaction
    setupFrequencyDigitInteraction();
    monitorFrequencyChanges();
    // Initial update
    updateFrequencyReadout();
}

// Export functions to global scope
window.updateFrequencyReadout = updateFrequencyReadout;
