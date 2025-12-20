// Noise Floor Aggregate Analysis JavaScript
// Handles data fetching, visualization, and user interactions

// Available bands and fields
const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
const FIELDS = {
    'p5_db': 'Noise Floor',
    'p10_db': 'P10',
    'median_db': 'Median',
    'mean_db': 'Mean',
    'p95_db': 'Signal Peak',
    'max_db': 'Maximum',
    'min_db': 'Minimum',
    'dynamic_range': 'Dynamic Range',
    'occupancy_pct': 'Occupancy %',
    'ft8_snr': 'FT8 SNR'
};

// Band colors (matching noisefloor.js)
const BAND_COLORS = {
    '160m': '#4E79A7',
    '80m': '#F28E2B',
    '60m': '#E15759',
    '40m': '#76B7B2',
    '30m': '#59A14F',
    '20m': '#EDC948',
    '17m': '#B07AA1',
    '15m': '#FF9DA7',
    '12m': '#9C755F',
    '10m': '#BAB0AC'
};

// Lighter versions of band colors for comparison data
const BAND_COLORS_COMPARISON = {
    '160m': '#8FAFD4',
    '80m': '#F7B876',
    '60m': '#EE9B9C',
    '40m': '#A8D1CE',
    '30m': '#92C98A',
    '20m': '#F5E594',
    '17m': '#D0A8C5',
    '15m': '#FFC4CB',
    '12m': '#C5A393',
    '10m': '#D5CCC9'
};

// Global state
let currentData = null;
let charts = {};
let availableDates = [];
let datePickers = {};
let selectedDates = {
    primaryFrom: null,
    primaryTo: null,
    comparisonFrom: null,
    comparisonTo: null
};

// Initialize the page
document.addEventListener('DOMContentLoaded', () => {
    initializeBandCheckboxes();
    initializeFieldCheckboxes();
    fetchAvailableDates();
    setupComparisonToggle();
    loadVersion();
    
    // Load parameters from URL if present
    loadFromURL();
});

function initializeBandCheckboxes() {
    const container = document.getElementById('bandsCheckboxes');

    // Add "None" button
    const noneButton = document.createElement('button');
    noneButton.textContent = 'None';
    noneButton.className = 'btn-secondary';
    noneButton.style.marginBottom = '10px';
    noneButton.style.padding = '4px 8px';
    noneButton.style.fontSize = '0.9em';
    noneButton.onclick = () => {
        document.querySelectorAll('#bandsCheckboxes input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
    };
    container.appendChild(noneButton);

    BANDS.forEach(band => {
        const div = document.createElement('div');
        div.className = 'checkbox-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `band-${band}`;
        checkbox.value = band;
        checkbox.checked = true; // All bands selected by default

        const label = document.createElement('label');
        label.htmlFor = `band-${band}`;
        label.textContent = band;

        div.appendChild(checkbox);
        div.appendChild(label);
        container.appendChild(div);
    });
}

function initializeFieldCheckboxes() {
    const container = document.getElementById('fieldsCheckboxes');
    // Default selected fields
    const defaultFields = ['p5_db', 'p95_db', 'dynamic_range', 'ft8_snr'];

    // Add "None" button
    const noneButton = document.createElement('button');
    noneButton.textContent = 'None';
    noneButton.className = 'btn-secondary';
    noneButton.style.marginBottom = '10px';
    noneButton.style.padding = '4px 8px';
    noneButton.style.fontSize = '0.9em';
    noneButton.onclick = () => {
        document.querySelectorAll('#fieldsCheckboxes input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
    };
    container.appendChild(noneButton);

    Object.entries(FIELDS).forEach(([key, label]) => {
        const div = document.createElement('div');
        div.className = 'checkbox-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `field-${key}`;
        checkbox.value = key;
        checkbox.checked = defaultFields.includes(key);

        const labelEl = document.createElement('label');
        labelEl.htmlFor = `field-${key}`;
        labelEl.textContent = label;

        div.appendChild(checkbox);
        div.appendChild(labelEl);
        container.appendChild(div);
    });
}

async function fetchAvailableDates() {
    try {
        const response = await fetch('/api/noisefloor/dates?today=true');
        if (response.ok) {
            const data = await response.json();
            availableDates = data.dates || [];
            initializeDatePickers();
            setDefaultDates();
        }
    } catch (error) {
        console.error('Error fetching available dates:', error);
        // Initialize with empty dates list (allows any date)
        initializeDatePickers();
        setDefaultDates();
    }
}

function initializeDatePickers() {
    // Create date pickers for each input
    ['primaryFrom', 'primaryTo', 'comparisonFrom', 'comparisonTo'].forEach(id => {
        const isFrom = id.includes('From');
        const defaultTime = isFrom ? '00:00' : '23:59';
        
        datePickers[id] = new DatePicker(
            availableDates,
            (dateTime) => handleDateSelection(id, dateTime),
            null,
            { includeTime: true, defaultTime: defaultTime }
        );
    });
}

function openDatePicker(id) {
    datePickers[id].show();
}

function handleDateSelection(id, dateTime) {
    selectedDates[id] = dateTime;
    updateDateDisplay(id, dateTime);
}

function updateDateDisplay(id, dateTime) {
    const displayEl = document.getElementById(`${id}Display`);
    if (dateTime) {
        const date = new Date(dateTime);
        const formatted = date.toLocaleString('en-GB', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        displayEl.textContent = formatted;
        displayEl.classList.remove('empty');
    } else {
        displayEl.textContent = 'Select date and time...';
        displayEl.classList.add('empty');
    }
}

function setDefaultDates() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Set primary range to last week
    weekAgo.setHours(0, 0, 0, 0);
    now.setHours(23, 59, 59, 999);
    
    const primaryFrom = weekAgo.toISOString().slice(0, 16) + ':00';
    const primaryTo = now.toISOString().slice(0, 16) + ':00';
    
    handleDateSelection('primaryFrom', primaryFrom);
    handleDateSelection('primaryTo', primaryTo);
    
    // Set comparison range to week before that
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    twoWeeksAgo.setHours(0, 0, 0, 0);
    weekAgo.setHours(23, 59, 59, 999);
    
    const comparisonFrom = twoWeeksAgo.toISOString().slice(0, 16) + ':00';
    const comparisonTo = weekAgo.toISOString().slice(0, 16) + ':00';
    
    handleDateSelection('comparisonFrom', comparisonFrom);
    handleDateSelection('comparisonTo', comparisonTo);
}

function setupComparisonToggle() {
    const checkbox = document.getElementById('enableComparison');
    const section = document.getElementById('comparisonSection');
    
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            section.classList.add('active');
        } else {
            section.classList.remove('active');
        }
    });
}

function setPresetRange(preset) {
    const now = new Date();
    let primaryFrom, primaryTo, comparisonFrom, comparisonTo;
    
    switch (preset) {
        case 'yesterday': {
            // Primary: Today (00:00 to now)
            const today = new Date(now);
            today.setHours(0, 0, 0, 0);
            now.setHours(23, 59, 59, 999);
            
            primaryFrom = today.toISOString().slice(0, 16) + ':00';
            primaryTo = now.toISOString().slice(0, 16) + ':00';
            
            // Comparison: Yesterday (00:00 to 23:59)
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            yesterday.setHours(0, 0, 0, 0);
            const yesterdayEnd = new Date(yesterday);
            yesterdayEnd.setHours(23, 59, 59, 999);
            
            comparisonFrom = yesterday.toISOString().slice(0, 16) + ':00';
            comparisonTo = yesterdayEnd.toISOString().slice(0, 16) + ':00';
            break;
        }
        case 'week': {
            // Primary: Last 7 days (00:00 to now)
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            weekAgo.setHours(0, 0, 0, 0);
            now.setHours(23, 59, 59, 999);
            
            primaryFrom = weekAgo.toISOString().slice(0, 16) + ':00';
            primaryTo = now.toISOString().slice(0, 16) + ':00';
            
            // Comparison: Week before that (same duration)
            const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
            twoWeeksAgo.setHours(0, 0, 0, 0);
            const weekAgoEnd = new Date(weekAgo);
            weekAgoEnd.setHours(23, 59, 59, 999);
            
            comparisonFrom = twoWeeksAgo.toISOString().slice(0, 16) + ':00';
            comparisonTo = weekAgoEnd.toISOString().slice(0, 16) + ':00';
            break;
        }
        case 'month': {
            // Primary: Last 30 days (00:00 to now)
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            monthAgo.setHours(0, 0, 0, 0);
            now.setHours(23, 59, 59, 999);
            
            primaryFrom = monthAgo.toISOString().slice(0, 16) + ':00';
            primaryTo = now.toISOString().slice(0, 16) + ':00';
            
            // Comparison: Month before that (same duration)
            const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
            twoMonthsAgo.setHours(0, 0, 0, 0);
            const monthAgoEnd = new Date(monthAgo);
            monthAgoEnd.setHours(23, 59, 59, 999);
            
            comparisonFrom = twoMonthsAgo.toISOString().slice(0, 16) + ':00';
            comparisonTo = monthAgoEnd.toISOString().slice(0, 16) + ':00';
            break;
        }
        default:
            return;
    }
    
    // Set primary range
    handleDateSelection('primaryFrom', primaryFrom);
    handleDateSelection('primaryTo', primaryTo);
    
    // Enable comparison and set comparison range
    const comparisonCheckbox = document.getElementById('enableComparison');
    const comparisonSection = document.getElementById('comparisonSection');
    
    comparisonCheckbox.checked = true;
    comparisonSection.classList.add('active');
    
    handleDateSelection('comparisonFrom', comparisonFrom);
    handleDateSelection('comparisonTo', comparisonTo);
}

function getSelectedBands() {
    const checkboxes = document.querySelectorAll('#bandsCheckboxes input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedFields() {
    const checkboxes = document.querySelectorAll('#fieldsCheckboxes input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.className = `status ${type}`;
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
}

function hideStatus() {
    document.getElementById('status').style.display = 'none';
}

function showLoading() {
    document.getElementById('loading').classList.add('active');
}

function hideLoading() {
    document.getElementById('loading').classList.remove('active');
}

async function fetchData() {
    // Validate inputs
    const bands = getSelectedBands();
    const fields = getSelectedFields();
    
    if (bands.length === 0) {
        showStatus('Please select at least one band', 'error');
        return;
    }
    
    if (fields.length === 0) {
        showStatus('Please select at least one metric', 'error');
        return;
    }
    
    const primaryFrom = selectedDates.primaryFrom;
    const primaryTo = selectedDates.primaryTo;
    
    if (!primaryFrom || !primaryTo) {
        showStatus('Please select primary time range', 'error');
        return;
    }
    
    // Validate that primary date range overlaps with available data
    if (!validateDateRange(primaryFrom, primaryTo)) {
        showStatus('Primary date range has no available data. Please select dates with data.', 'error');
        return;
    }
    
    // Build request
    const request = {
        primary: {
            from: new Date(primaryFrom).toISOString(),
            to: new Date(primaryTo).toISOString()
        },
        bands: bands,
        fields: fields,
        interval: document.getElementById('interval').value
    };
    
    // Add comparison if enabled
    const comparisonEnabled = document.getElementById('enableComparison').checked;
    if (comparisonEnabled) {
        const comparisonFrom = selectedDates.comparisonFrom;
        const comparisonTo = selectedDates.comparisonTo;

        if (!comparisonFrom || !comparisonTo) {
            showStatus('Please select comparison time range', 'error');
            return;
        }

        // Validate that comparison date range overlaps with available data
        if (!validateDateRange(comparisonFrom, comparisonTo)) {
            showStatus('Comparison date range has no available data. Please select dates with data.', 'error');
            return;
        }

        request.comparison = {
            from: new Date(comparisonFrom).toISOString(),
            to: new Date(comparisonTo).toISOString()
        };
    }
    
    // Update URL with current parameters
    updateURL(request, comparisonEnabled);
    
    // Fetch data
    showLoading();
    hideStatus();
    
    try {
        const response = await fetch('/api/noisefloor/aggregate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });
        
        if (!response.ok) {
            // Try to get error message from response body
            let errorMessage = 'Failed to fetch data';
            try {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    const error = await response.json();
                    errorMessage = error.error || errorMessage;
                } else {
                    // If not JSON, get the text body
                    const textError = await response.text();
                    errorMessage = textError || `HTTP ${response.status}: ${response.statusText}`;
                }
            } catch (parseError) {
                // If parsing fails, use status text
                errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMessage);
        }
        
        currentData = await response.json();
        displayData(currentData, request);

        // Show info message about interval used (always present now)
        const statusMsg = currentData.info || 'Data loaded successfully';
        showStatus(statusMsg, 'success');
        
    } catch (error) {
        console.error('Error fetching data:', error);
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        hideLoading();
    }
}

function displayData(data, request) {
    // Clear existing charts
    Object.values(charts).forEach(chart => chart.destroy());
    charts = {};
    
    // Display statistics
    displayStatistics(data, request);
    
    // Create charts for each field
    const chartsContainer = document.getElementById('chartsContainer');
    chartsContainer.innerHTML = '';
    
    request.fields.forEach(field => {
        createFieldChart(field, data, request);
    });
}

function displayStatistics(data, request) {
    const statsContainer = document.getElementById('statsContainer');
    statsContainer.innerHTML = '';
    
    const statsDiv = document.createElement('div');
    statsDiv.className = 'chart-container';
    statsDiv.innerHTML = '<h2>📊 Data Summary</h2>';
    
    const statsGrid = document.createElement('div');
    statsGrid.className = 'stats-grid';
    
    // Calculate total data points
    let totalPrimary = 0;
    let totalComparison = 0;
    
    Object.values(data.primary).forEach(bandData => {
        totalPrimary += bandData.length;
    });
    
    if (data.comparison) {
        Object.values(data.comparison).forEach(bandData => {
            totalComparison += bandData.length;
        });
    }
    
    // Add stat cards
    addStatCard(statsGrid, totalPrimary, 'Primary Data Points');
    if (data.comparison) {
        addStatCard(statsGrid, totalComparison, 'Comparison Data Points');
    }
    addStatCard(statsGrid, request.bands.length, 'Bands Analysed');
    addStatCard(statsGrid, request.fields.length, 'Metrics Tracked');
    
    // Add processing time if available
    if (data.processing_time_ms !== undefined) {
        const processingTime = data.processing_time_ms < 1000
            ? data.processing_time_ms.toFixed(0) + ' ms'
            : (data.processing_time_ms / 1000).toFixed(2) + ' s';
        addStatCard(statsGrid, processingTime, 'Processing Time');
    }
    
    statsDiv.appendChild(statsGrid);
    statsContainer.appendChild(statsDiv);
}

function addStatCard(container, value, label) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    
    // Handle both numeric and string values
    const displayValue = typeof value === 'number' ? value.toLocaleString() : value;
    
    card.innerHTML = `
        <div class="stat-value">${displayValue}</div>
        <div class="stat-label">${label}</div>
    `;
    container.appendChild(card);
}

function createFieldChart(field, data, request) {
    const chartsContainer = document.getElementById('chartsContainer');
    
    const chartDiv = document.createElement('div');
    chartDiv.className = 'chart-container';
    
    // Create header with title and difference toggle button
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '20px';
    
    const title = document.createElement('h2');
    title.textContent = FIELDS[field] || field;
    title.style.margin = '0';
    header.appendChild(title);
    
    // Add control buttons if comparison data exists and has data for at least one band
    if (data.comparison) {
        // Check if any of the selected bands have comparison data
        const hasComparisonData = request.bands.some(band =>
            data.comparison[band] && data.comparison[band].length > 0
        );

        if (hasComparisonData) {
            // Create button container
            const buttonContainer = document.createElement('div');
            buttonContainer.style.display = 'flex';
            buttonContainer.style.gap = '8px';

            // Hide Primary button
            const hidePrimaryButton = document.createElement('button');
            hidePrimaryButton.textContent = '👁️ Hide Primary';
            hidePrimaryButton.className = 'btn-secondary';
            hidePrimaryButton.style.padding = '8px 16px';
            hidePrimaryButton.style.fontSize = '0.9em';
            hidePrimaryButton.dataset.showing = 'true';
            hidePrimaryButton.onclick = () => toggleDatasetVisibility(field, 'primary', hidePrimaryButton);
            buttonContainer.appendChild(hidePrimaryButton);

            // Hide Comparison button
            const hideComparisonButton = document.createElement('button');
            hideComparisonButton.textContent = '👁️ Hide Comparison';
            hideComparisonButton.className = 'btn-secondary';
            hideComparisonButton.style.padding = '8px 16px';
            hideComparisonButton.style.fontSize = '0.9em';
            hideComparisonButton.dataset.showing = 'true';
            hideComparisonButton.onclick = () => toggleDatasetVisibility(field, 'comparison', hideComparisonButton);
            buttonContainer.appendChild(hideComparisonButton);

            // Difference button
            const diffButton = document.createElement('button');
            diffButton.textContent = '📊 Show Difference';
            diffButton.className = 'btn-secondary';
            diffButton.style.padding = '8px 16px';
            diffButton.style.fontSize = '0.9em';
            diffButton.onclick = () => toggleDifferenceView(field, data, request, diffButton);
            buttonContainer.appendChild(diffButton);

            header.appendChild(buttonContainer);
        }
    }
    
    chartDiv.appendChild(header);
    
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-wrapper';
    
    const canvas = document.createElement('canvas');
    canvas.id = `chart-${field}`;
    wrapper.appendChild(canvas);
    
    chartDiv.appendChild(wrapper);
    chartsContainer.appendChild(chartDiv);
    
    // Determine if we should use time-of-day alignment or elapsed time
    // Use time-of-day alignment when comparing similar-length periods (e.g., today vs yesterday)
    const useTimeOfDayAlignment = data.comparison && shouldUseTimeOfDayAlignment(data, request);
    
    // Create datasets
    const datasets = [];
    
    if (useTimeOfDayAlignment) {
        // Time-of-day alignment: align by hour of day (e.g., 17:00 yesterday aligns with 17:00 today)
        
        // Primary datasets
        request.bands.forEach(band => {
            if (data.primary[band]) {
                const bandData = data.primary[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    // Calculate milliseconds since midnight
                    const midnight = new Date(timestamp);
                    midnight.setHours(0, 0, 0, 0);
                    const timeOfDay = timestamp.getTime() - midnight.getTime();
                    
                    return {
                        x: timeOfDay,
                        y: point.values[field],
                        actualTime: timestamp // Store actual timestamp for tooltip
                    };
                });
                
                datasets.push({
                    label: data.comparison ? `${band} (Primary)` : band,
                    data: bandData,
                    borderColor: BAND_COLORS[band],
                    backgroundColor: BAND_COLORS[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: [] // Solid line for primary
                });
            }
        });
        
        // Comparison datasets
        request.bands.forEach(band => {
            if (data.comparison[band]) {
                const bandData = data.comparison[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    // Calculate milliseconds since midnight
                    const midnight = new Date(timestamp);
                    midnight.setHours(0, 0, 0, 0);
                    const timeOfDay = timestamp.getTime() - midnight.getTime();
                    
                    return {
                        x: timeOfDay,
                        y: point.values[field],
                        actualTime: timestamp // Store actual timestamp for tooltip
                    };
                });
                
                datasets.push({
                    label: `${band} (Comparison)`,
                    data: bandData,
                    borderColor: BAND_COLORS_COMPARISON[band],
                    backgroundColor: BAND_COLORS_COMPARISON[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: [] // Solid line (different color distinguishes it)
                });
            }
        });
    } else {
        // Elapsed time alignment: use relative time from start of each dataset
        let primaryStartTime = null;
        let comparisonStartTime = null;
        
        // Find earliest timestamp in primary data
        request.bands.forEach(band => {
            if (data.primary[band] && data.primary[band].length > 0) {
                const firstTime = new Date(data.primary[band][0].timestamp).getTime();
                if (primaryStartTime === null || firstTime < primaryStartTime) {
                    primaryStartTime = firstTime;
                }
            }
        });
        
        // Find earliest timestamp in comparison data
        if (data.comparison) {
            request.bands.forEach(band => {
                if (data.comparison[band] && data.comparison[band].length > 0) {
                    const firstTime = new Date(data.comparison[band][0].timestamp).getTime();
                    if (comparisonStartTime === null || firstTime < comparisonStartTime) {
                        comparisonStartTime = firstTime;
                    }
                }
            });
        }
        
        // Primary datasets
        request.bands.forEach(band => {
            if (data.primary[band]) {
                const bandData = data.primary[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    const relativeTime = timestamp.getTime() - primaryStartTime;
                    return {
                        x: relativeTime,
                        y: point.values[field],
                        actualTime: timestamp // Store actual timestamp for tooltip
                    };
                });
                
                datasets.push({
                    label: data.comparison ? `${band} (Primary)` : band,
                    data: bandData,
                    borderColor: BAND_COLORS[band],
                    backgroundColor: BAND_COLORS[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: [] // Solid line for primary
                });
            }
        });
        
        // Comparison datasets
        if (data.comparison) {
            request.bands.forEach(band => {
                if (data.comparison[band]) {
                    const bandData = data.comparison[band].map(point => {
                        const timestamp = new Date(point.timestamp);
                        const relativeTime = timestamp.getTime() - comparisonStartTime;
                        return {
                            x: relativeTime,
                            y: point.values[field],
                            actualTime: timestamp // Store actual timestamp for tooltip
                        };
                    });
                    
                    datasets.push({
                        label: `${band} (Comparison)`,
                        data: bandData,
                        borderColor: BAND_COLORS_COMPARISON[band],
                        backgroundColor: BAND_COLORS_COMPARISON[band],
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        borderDash: [] // Solid line (different color distinguishes it)
                    });
                }
            });
        }
    }
    
    // Create chart
    const ctx = canvas.getContext('2d');
    charts[field] = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',
                        modifierKey: 'ctrl',
                        onPanComplete: ({chart}) => syncAllCharts(chart)
                    },
                    zoom: {
                        drag: {
                            enabled: true,
                            backgroundColor: 'rgba(255, 255, 255, 0.3)',
                        },
                        mode: 'x',
                        onZoomComplete: ({chart}) => syncAllCharts(chart)
                    },
                    limits: {
                        x: {min: 'original', max: 'original'},
                    }
                },
                legend: {
                    display: true,
                    labels: { color: '#fff' }
                },
                tooltip: {
                    mode: 'nearest',
                    intersect: false,
                    axis: 'x',
                    callbacks: {
                        title: function(context) {
                            if (context[0]) {
                                if (useTimeOfDayAlignment) {
                                    // In time-of-day mode, show only the time (matching X-axis)
                                    // Use the X value from the nearest point
                                    const timeMs = context[0].parsed.x;
                                    return formatTimeOfDay(timeMs);
                                } else {
                                    // In elapsed time mode, show actual timestamp from the data point
                                    if (context[0].raw && context[0].raw.actualTime) {
                                        return context[0].raw.actualTime.toLocaleString('en-GB', {
                                            year: 'numeric',
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        });
                                    }
                                }
                            }
                            return '';
                        },
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(2);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: useTimeOfDayAlignment ? 'Time of Day' : getRelativeTimeLabel(request.interval),
                        color: '#fff'
                    },
                    min: useTimeOfDayAlignment ? 0 : undefined,
                    max: useTimeOfDayAlignment ? 86400000 : undefined, // 24 hours in milliseconds
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            if (useTimeOfDayAlignment) {
                                return formatTimeOfDay(value);
                            }
                            return formatRelativeTime(value, request.interval);
                        }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                y: {
                    title: {
                        display: true,
                        text: getYAxisLabel(field),
                        color: '#fff'
                    },
                    ticks: { color: '#fff' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            },
            onClick: function(event, activeElements, chart) {
                // Check for double-click to reset zoom on ALL charts
                const now = Date.now();
                if (chart.lastClickTime && (now - chart.lastClickTime) < 300) {
                    // Double-click detected - reset zoom on all charts
                    Object.values(charts).forEach(c => c.resetZoom());
                    chart.lastClickTime = null;
                } else {
                    chart.lastClickTime = now;
                }
            }
        }
    });
}

// Helper function to synchronize zoom across all charts
function syncAllCharts(sourceChart) {
    // Prevent infinite loops by checking if we're already syncing
    if (sourceChart._syncing) return;

    const xMin = sourceChart.scales.x.min;
    const xMax = sourceChart.scales.x.max;

    // Mark all charts as syncing to prevent loops
    Object.values(charts).forEach(chart => chart._syncing = true);

    // Apply the same zoom to all other charts
    Object.values(charts).forEach(chart => {
        if (chart !== sourceChart) {
            chart.zoomScale('x', {min: xMin, max: xMax}, 'none');
        }
    });

    // Clear syncing flags
    Object.values(charts).forEach(chart => chart._syncing = false);
}

function shouldUseTimeOfDayAlignment(data, request) {
    // Use time-of-day alignment when both ranges are relatively short (< 3 days)
    // This is for comparing the same time across different days

    if (!request.comparison) {
        return false;
    }

    const primaryFrom = new Date(request.primary.from);
    const primaryTo = new Date(request.primary.to);
    const primaryDuration = (primaryTo - primaryFrom) / (1000 * 60 * 60 * 24); // days

    const comparisonFrom = new Date(request.comparison.from);
    const comparisonTo = new Date(request.comparison.to);
    const comparisonDuration = (comparisonTo - comparisonFrom) / (1000 * 60 * 60 * 24); // days

    // Check if both periods are on the same calendar day
    const primaryDate = primaryFrom.toISOString().split('T')[0];
    const comparisonDate = comparisonFrom.toISOString().split('T')[0];
    const sameDay = primaryDate === comparisonDate;

    // Don't use time-of-day alignment for same-day comparisons
    // (those should use relative time overlay instead)
    if (sameDay) {
        return false;
    }

    // Use time-of-day alignment if both periods are less than 3 days
    return primaryDuration <= 3 && comparisonDuration <= 3;
}

function toggleDifferenceView(field, data, request, button) {
    const chart = charts[field];
    if (!chart) return;
    
    // Check if we're currently showing difference
    const showingDifference = button.textContent.includes('Show Difference');
    
    if (showingDifference) {
        // Switch to difference view
        button.textContent = '📈 Show Original';
        
        // Calculate difference datasets
        const useTimeOfDayAlignment = data.comparison && shouldUseTimeOfDayAlignment(data, request);
        const differenceDatasets = [];
        
        request.bands.forEach(band => {
            if (data.primary[band] && data.comparison[band]) {
                // Create a map of comparison data by x value for easy lookup
                const comparisonMap = new Map();
                
                data.comparison[band].forEach(point => {
                    const timestamp = new Date(point.timestamp);
                    let xValue;
                    
                    if (useTimeOfDayAlignment) {
                        const midnight = new Date(timestamp);
                        midnight.setHours(0, 0, 0, 0);
                        xValue = timestamp.getTime() - midnight.getTime();
                    } else {
                        // For elapsed time, we need to use the comparison start time
                        // This is a simplified approach - we'll match by index instead
                        xValue = point.timestamp;
                    }
                    
                    comparisonMap.set(xValue, point.values[field]);
                });
                
                // Calculate differences
                const differenceData = [];
                data.primary[band].forEach((point, index) => {
                    const timestamp = new Date(point.timestamp);
                    let xValue;
                    
                    if (useTimeOfDayAlignment) {
                        const midnight = new Date(timestamp);
                        midnight.setHours(0, 0, 0, 0);
                        xValue = timestamp.getTime() - midnight.getTime();
                    } else {
                        xValue = point.timestamp;
                    }
                    
                    // Try to find matching comparison point
                    let comparisonValue = comparisonMap.get(xValue);
                    
                    // If no exact match and using elapsed time, try matching by index
                    if (comparisonValue === undefined && !useTimeOfDayAlignment) {
                        if (index < data.comparison[band].length) {
                            comparisonValue = data.comparison[band][index].values[field];
                        }
                    }
                    
                    if (comparisonValue !== undefined) {
                        const difference = point.values[field] - comparisonValue;
                        differenceData.push({
                            x: useTimeOfDayAlignment ? xValue : (timestamp.getTime() - new Date(data.primary[band][0].timestamp).getTime()),
                            y: difference,
                            actualTime: timestamp
                        });
                    }
                });
                
                if (differenceData.length > 0) {
                    differenceDatasets.push({
                        label: `${band} (Difference)`,
                        data: differenceData,
                        borderColor: BAND_COLORS[band],
                        backgroundColor: BAND_COLORS[band],
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4
                    });
                }
            }
        });
        
        // Update chart with difference data
        chart.data.datasets = differenceDatasets;
        chart.options.scales.y.title.text = `${getYAxisLabel(field)} (Primary - Comparison)`;
        
        // Add a zero reference line to make positive/negative clearer
        if (!chart.options.plugins.annotation) {
            chart.options.plugins.annotation = { annotations: {} };
        }
        chart.options.plugins.annotation.annotations = {
            zeroLine: {
                type: 'line',
                yMin: 0,
                yMax: 0,
                borderColor: 'rgba(255, 255, 255, 0.5)',
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                    display: true,
                    content: 'Zero (No Change)',
                    position: 'end',
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    color: '#fff',
                    font: {
                        size: 11
                    }
                }
            }
        };
        
        chart.update();
        
    } else {
        // Switch back to original view
        button.textContent = '📊 Show Difference';
        
        // Recreate original chart
        const canvas = document.getElementById(`chart-${field}`);
        const ctx = canvas.getContext('2d');
        
        // Destroy old chart
        chart.destroy();
        
        // Recreate chart with original data
        createFieldChartData(field, data, request, ctx);
    }
}

function toggleDatasetVisibility(field, datasetType, button) {
    const chart = charts[field];
    if (!chart) return;

    const isShowing = button.dataset.showing === 'true';
    const newState = !isShowing;

    // Update button state and text
    button.dataset.showing = newState.toString();
    if (datasetType === 'primary') {
        button.textContent = newState ? '👁️ Hide Primary' : '👁️‍🗨️ Show Primary';
    } else {
        button.textContent = newState ? '👁️ Hide Comparison' : '👁️‍🗨️ Show Comparison';
    }

    // Toggle visibility of matching datasets
    chart.data.datasets.forEach(dataset => {
        const isPrimary = dataset.label.includes('(Primary)') || (!dataset.label.includes('(Comparison)') && !dataset.label.includes('(Difference)'));
        const isComparison = dataset.label.includes('(Comparison)');

        if (datasetType === 'primary' && isPrimary) {
            dataset.hidden = !newState;
        } else if (datasetType === 'comparison' && isComparison) {
            dataset.hidden = !newState;
        }
    });

    chart.update();
}

function createFieldChartData(field, data, request, ctx) {
    // This is the chart creation logic extracted from createFieldChart
    // We'll need to refactor createFieldChart to use this
    const useTimeOfDayAlignment = data.comparison && shouldUseTimeOfDayAlignment(data, request);
    const datasets = [];
    
    if (useTimeOfDayAlignment) {
        // Time-of-day alignment code (same as in createFieldChart)
        request.bands.forEach(band => {
            if (data.primary[band]) {
                const bandData = data.primary[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    const midnight = new Date(timestamp);
                    midnight.setHours(0, 0, 0, 0);
                    const timeOfDay = timestamp.getTime() - midnight.getTime();
                    
                    return {
                        x: timeOfDay,
                        y: point.values[field],
                        actualTime: timestamp
                    };
                });
                
                datasets.push({
                    label: data.comparison ? `${band} (Primary)` : band,
                    data: bandData,
                    borderColor: BAND_COLORS[band],
                    backgroundColor: BAND_COLORS[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: []
                });
            }
        });
        
        request.bands.forEach(band => {
            if (data.comparison[band]) {
                const bandData = data.comparison[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    const midnight = new Date(timestamp);
                    midnight.setHours(0, 0, 0, 0);
                    const timeOfDay = timestamp.getTime() - midnight.getTime();
                    
                    return {
                        x: timeOfDay,
                        y: point.values[field],
                        actualTime: timestamp
                    };
                });
                
                datasets.push({
                    label: `${band} (Comparison)`,
                    data: bandData,
                    borderColor: BAND_COLORS_COMPARISON[band],
                    backgroundColor: BAND_COLORS_COMPARISON[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: []
                });
            }
        });
    } else {
        // Elapsed time alignment code (same as in createFieldChart)
        let primaryStartTime = null;
        let comparisonStartTime = null;
        
        request.bands.forEach(band => {
            if (data.primary[band] && data.primary[band].length > 0) {
                const firstTime = new Date(data.primary[band][0].timestamp).getTime();
                if (primaryStartTime === null || firstTime < primaryStartTime) {
                    primaryStartTime = firstTime;
                }
            }
        });
        
        if (data.comparison) {
            request.bands.forEach(band => {
                if (data.comparison[band] && data.comparison[band].length > 0) {
                    const firstTime = new Date(data.comparison[band][0].timestamp).getTime();
                    if (comparisonStartTime === null || firstTime < comparisonStartTime) {
                        comparisonStartTime = firstTime;
                    }
                }
            });
        }
        
        request.bands.forEach(band => {
            if (data.primary[band]) {
                const bandData = data.primary[band].map(point => {
                    const timestamp = new Date(point.timestamp);
                    const relativeTime = timestamp.getTime() - primaryStartTime;
                    return {
                        x: relativeTime,
                        y: point.values[field],
                        actualTime: timestamp
                    };
                });
                
                datasets.push({
                    label: data.comparison ? `${band} (Primary)` : band,
                    data: bandData,
                    borderColor: BAND_COLORS[band],
                    backgroundColor: BAND_COLORS[band],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    borderDash: []
                });
            }
        });
        
        if (data.comparison) {
            request.bands.forEach(band => {
                if (data.comparison[band]) {
                    const bandData = data.comparison[band].map(point => {
                        const timestamp = new Date(point.timestamp);
                        const relativeTime = timestamp.getTime() - comparisonStartTime;
                        return {
                            x: relativeTime,
                            y: point.values[field],
                            actualTime: timestamp
                        };
                    });
                    
                    datasets.push({
                        label: `${band} (Comparison)`,
                        data: bandData,
                        borderColor: BAND_COLORS_COMPARISON[band],
                        backgroundColor: BAND_COLORS_COMPARISON[band],
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        borderDash: []
                    });
                }
            });
        }
    }
    
    // Create new chart
    charts[field] = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',
                        modifierKey: 'ctrl',
                        onPanComplete: ({chart}) => syncAllCharts(chart)
                    },
                    zoom: {
                        drag: {
                            enabled: true,
                            backgroundColor: 'rgba(255, 255, 255, 0.3)',
                        },
                        mode: 'x',
                        onZoomComplete: ({chart}) => syncAllCharts(chart)
                    },
                    limits: {
                        x: {min: 'original', max: 'original'},
                    }
                },
                legend: {
                    display: true,
                    labels: { color: '#fff' }
                },
                tooltip: {
                    mode: 'nearest',
                    intersect: false,
                    axis: 'x',
                    callbacks: {
                        title: function(context) {
                            if (context[0]) {
                                if (useTimeOfDayAlignment) {
                                    // In time-of-day mode, show only the time (matching X-axis)
                                    // Use the X value from the nearest point
                                    const timeMs = context[0].parsed.x;
                                    return formatTimeOfDay(timeMs);
                                } else {
                                    // In elapsed time mode, show actual timestamp from the data point
                                    if (context[0].raw && context[0].raw.actualTime) {
                                        return context[0].raw.actualTime.toLocaleString('en-GB', {
                                            year: 'numeric',
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        });
                                    }
                                }
                            }
                            return '';
                        },
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(2);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: useTimeOfDayAlignment ? 'Time of Day' : getRelativeTimeLabel(request.interval),
                        color: '#fff'
                    },
                    min: useTimeOfDayAlignment ? 0 : undefined,
                    max: useTimeOfDayAlignment ? 86400000 : undefined,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            if (useTimeOfDayAlignment) {
                                return formatTimeOfDay(value);
                            }
                            return formatRelativeTime(value, request.interval);
                        }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                y: {
                    title: {
                        display: true,
                        text: getYAxisLabel(field),
                        color: '#fff'
                    },
                    ticks: { color: '#fff' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            },
            onClick: function(event, activeElements, chart) {
                // Check for double-click to reset zoom on ALL charts
                const now = Date.now();
                if (chart.lastClickTime && (now - chart.lastClickTime) < 300) {
                    // Double-click detected - reset zoom on all charts
                    Object.values(charts).forEach(c => c.resetZoom());
                    chart.lastClickTime = null;
                } else {
                    chart.lastClickTime = now;
                }
            }
        }
    });
}

function formatTimeOfDay(milliseconds) {
    // Convert milliseconds since midnight to HH:MM format
    const hours = Math.floor(milliseconds / (1000 * 60 * 60));
    const minutes = Math.floor((milliseconds % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function getRelativeTimeLabel(interval) {
    switch (interval) {
        case 'minute':
        case 'hour':
            return 'Elapsed Time (hours)';
        case 'day':
            return 'Elapsed Time (days)';
        case 'week':
            return 'Elapsed Time (weeks)';
        case 'month':
            return 'Elapsed Time (months)';
        default:
            return 'Elapsed Time';
    }
}

function formatRelativeTime(milliseconds, interval) {
    const hours = milliseconds / (1000 * 60 * 60);
    const days = hours / 24;
    const weeks = days / 7;
    const months = days / 30;
    
    switch (interval) {
        case 'minute':
        case 'hour':
            return hours.toFixed(1) + 'h';
        case 'day':
            return days.toFixed(1) + 'd';
        case 'week':
            return weeks.toFixed(1) + 'w';
        case 'month':
            return months.toFixed(1) + 'm';
        default:
            return hours.toFixed(1) + 'h';
    }
}

function getTimeUnit(interval) {
    switch (interval) {
        case 'minute': return 'minute';
        case 'hour': return 'hour';
        case 'day': return 'day';
        case 'week': return 'week';
        case 'month': return 'month';
        default: return 'hour';
    }
}

function getDisplayFormats(interval) {
    switch (interval) {
        case 'minute':
            return { minute: 'HH:mm', hour: 'MMM d HH:mm' };
        case 'hour':
            return { hour: 'HH:mm', day: 'MMM d' };
        case 'day':
            return { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy' };
        case 'week':
            return { week: 'MMM d', month: 'MMM yyyy' };
        case 'month':
            return { month: 'MMM yyyy', year: 'yyyy' };
        default:
            return { hour: 'HH:mm' };
    }
}

function getYAxisLabel(field) {
    if (field.includes('_db')) {
        return 'Power (dB)';
    } else if (field === 'occupancy_pct') {
        return 'Occupancy (%)';
    } else if (field === 'dynamic_range') {
        return 'Dynamic Range (dB)';
    }
    return 'Value';
}

function exportData() {
    if (!currentData) {
        showStatus('No data to export. Please fetch data first.', 'error');
        return;
    }
    
    // Convert data to CSV
    let csv = 'Timestamp,Band,Dataset,';
    const fields = getSelectedFields();
    csv += fields.join(',') + ',Sample Count\n';
    
    // Export primary data
    Object.entries(currentData.primary).forEach(([band, dataPoints]) => {
        dataPoints.forEach(point => {
            csv += `${point.timestamp},${band},Primary,`;
            csv += fields.map(f => point.values[f] || '').join(',');
            csv += `,${point.sample_count}\n`;
        });
    });
    
    // Export comparison data if present
    if (currentData.comparison) {
        Object.entries(currentData.comparison).forEach(([band, dataPoints]) => {
            dataPoints.forEach(point => {
                csv += `${point.timestamp},${band},Comparison,`;
                csv += fields.map(f => point.values[f] || '').join(',');
                csv += `,${point.sample_count}\n`;
            });
        });
    }
    
    // Download CSV
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `noisefloor_aggregate_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showStatus('Data exported successfully', 'success');
}

function updateURL(request, comparisonEnabled) {
    const params = new URLSearchParams();
    
    // Add primary time range
    params.set('from', selectedDates.primaryFrom);
    params.set('to', selectedDates.primaryTo);
    
    // Add comparison if enabled
    if (comparisonEnabled && request.comparison) {
        params.set('comp', '1');
        params.set('compFrom', selectedDates.comparisonFrom);
        params.set('compTo', selectedDates.comparisonTo);
    }
    
    // Add bands
    params.set('bands', request.bands.join(','));
    
    // Add fields
    params.set('fields', request.fields.join(','));
    
    // Add interval
    params.set('interval', request.interval);
    
    // Update URL without reloading page
    const newURL = `${window.location.pathname}?${params.toString()}`;
    window.history.pushState({}, '', newURL);
}

function loadFromURL() {
    const params = new URLSearchParams(window.location.search);
    
    // Check if we have parameters
    if (!params.has('from') || !params.has('to')) {
        return; // No parameters, use defaults
    }
    
    // Wait for date pickers to be initialized
    const checkInitialized = setInterval(() => {
        if (Object.keys(datePickers).length === 4) {
            clearInterval(checkInitialized);
            applyURLParameters(params);
        }
    }, 100);
}

function applyURLParameters(params) {
    // Load primary time range
    if (params.has('from') && params.has('to')) {
        handleDateSelection('primaryFrom', params.get('from'));
        handleDateSelection('primaryTo', params.get('to'));
    }
    
    // Load comparison if present
    if (params.has('comp') && params.get('comp') === '1') {
        document.getElementById('enableComparison').checked = true;
        document.getElementById('comparisonSection').classList.add('active');
        
        if (params.has('compFrom') && params.has('compTo')) {
            handleDateSelection('comparisonFrom', params.get('compFrom'));
            handleDateSelection('comparisonTo', params.get('compTo'));
        }
    }
    
    // Load bands
    if (params.has('bands')) {
        const bands = params.get('bands').split(',');
        // Uncheck all first
        document.querySelectorAll('#bandsCheckboxes input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        // Check selected bands
        bands.forEach(band => {
            const checkbox = document.getElementById(`band-${band}`);
            if (checkbox) checkbox.checked = true;
        });
    }
    
    // Load fields
    if (params.has('fields')) {
        const fields = params.get('fields').split(',');
        // Uncheck all first
        document.querySelectorAll('#fieldsCheckboxes input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        // Check selected fields
        fields.forEach(field => {
            const checkbox = document.getElementById(`field-${field}`);
            if (checkbox) checkbox.checked = true;
        });
    }
    
    // Load interval
    if (params.has('interval')) {
        document.getElementById('interval').value = params.get('interval');
    }
    
    // Auto-fetch data after a short delay to ensure everything is loaded
    setTimeout(() => {
        fetchData();
    }, 500);
}

async function loadVersion() {
    try {
        const response = await fetch('/api/description');
        if (response.ok) {
            const data = await response.json();

            // Update version in footer
            const versionSpan = document.getElementById('footer-version');
            if (versionSpan && data.version) {
                versionSpan.textContent = `v${data.version}`;
            }

            // Update receiver name in subtitle
            const receiverNameEl = document.getElementById('receiver-name');
            if (receiverNameEl) {
                if (data.receiver && data.receiver.name) {
                    receiverNameEl.textContent = data.receiver.name;
                } else {
                    receiverNameEl.textContent = 'Long-term HF propagation analysis and comparison';
                }
            }
        }
    } catch (error) {
        console.error('Error loading version:', error);
        // Set fallback text if fetch fails
        const receiverNameEl = document.getElementById('receiver-name');
        if (receiverNameEl) {
            receiverNameEl.textContent = 'Long-term HF propagation analysis and comparison';
        }
    }
}

// validateDateRange checks if a date range overlaps with available data dates
function validateDateRange(fromDateTime, toDateTime) {
    if (availableDates.length === 0) {
        // If we haven't loaded dates yet, allow the request (backend will validate)
        return true;
    }

    // Extract just the date part (YYYY-MM-DD) from the datetime strings
    const fromDate = fromDateTime.split('T')[0];
    const toDate = toDateTime.split('T')[0];

    // Check if any available date falls within the range
    for (const availableDate of availableDates) {
        if (availableDate >= fromDate && availableDate <= toDate) {
            return true; // Found at least one date with data in the range
        }
    }

    return false; // No dates with data in this range
}