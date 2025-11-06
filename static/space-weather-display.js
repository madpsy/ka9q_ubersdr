// Space Weather Display Module
// Fetches and displays compact space weather data under the audio buffer indicator

let spaceWeatherEnabled = false;
let spaceWeatherUpdateInterval = null;
let noiseFloorEnabled = false;

// Initialize space weather display
async function initSpaceWeatherDisplay() {
    try {
        // Check if space weather is enabled via the description endpoint
        const response = await fetch('/api/description');
        if (response.ok) {
            const data = await response.json();
            spaceWeatherEnabled = data.space_weather || false;
            noiseFloorEnabled = data.noise_floor || false;
            
            if (spaceWeatherEnabled) {
                // Fetch initial data
                await updateSpaceWeatherDisplay();
                
                // Update every 60 seconds
                spaceWeatherUpdateInterval = setInterval(updateSpaceWeatherDisplay, 60000);
                
                console.log('Space weather display initialized');
            }
        }
    } catch (err) {
        console.error('Failed to initialize space weather display:', err);
    }
}

// Fetch and update space weather display
async function updateSpaceWeatherDisplay() {
    try {
        const response = await fetch('/api/spaceweather');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        displaySpaceWeather(data);
    } catch (err) {
        console.error('Failed to fetch space weather:', err);
        // Hide display on error
        const display = document.getElementById('space-weather-display');
        if (display) {
            display.style.display = 'none';
        }
    }
}

// Display space weather data in compact format
function displaySpaceWeather(data) {
    const display = document.getElementById('space-weather-display');
    const textEl = document.getElementById('space-weather-text');
    const audioBuffer = document.getElementById('audio-buffer-display');
    
    if (!display || !textEl) return;
    
    // Format compact display: S:164 K:2 A:9 W:2.3 P:Good
    const solarFlux = data.solar_flux ? Math.round(data.solar_flux) : '--';
    const kIndex = data.k_index !== undefined ? data.k_index : '--';
    const aIndex = data.a_index !== undefined ? data.a_index : '--';
    const solarWind = data.solar_wind_bz !== undefined ? data.solar_wind_bz.toFixed(1) : '--';
    const propagation = data.propagation_quality || '--';
    
    // Build comprehensive tooltip with all information
    const tooltip = `Solar Flux: ${solarFlux} SFU (Solar Flux Units)
K-Index: ${kIndex} (${data.k_index_status || 'Unknown'})
A-Index: ${aIndex}
Solar Wind Bz: ${solarWind} nT (nanoTesla)
Propagation Quality: ${propagation}`;
    
    // Build compact text without individual tooltips
    const html = `S:${solarFlux} K:${kIndex} A:${aIndex} W:${solarWind} P:${propagation}`;
    
    textEl.innerHTML = html;
    textEl.title = tooltip;
    display.style.display = 'block';
    
    // Add click handler if noise floor is enabled
    if (noiseFloorEnabled) {
        display.style.cursor = 'pointer';
        display.onclick = function() {
            window.open('/bandconditions.html', '_blank');
        };
    }
    
    // Move audio buffer up when space weather is visible (16px = space weather height + small gap)
    if (audioBuffer) {
        audioBuffer.style.bottom = '16px';
    }
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSpaceWeatherDisplay);
} else {
    initSpaceWeatherDisplay();
}