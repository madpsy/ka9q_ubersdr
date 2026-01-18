// PSKReporter Analytics JavaScript
// Handles loading and displaying PSKReporter submission statistics

let currentData = null;
let currentCountriesData = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Load countries for datalist
    loadCountriesList();
    
    // Set up event listeners
    document.getElementById('load-btn').addEventListener('click', loadAnalytics);
    document.getElementById('load-countries-btn').addEventListener('click', loadCountries);
    document.getElementById('clear-filters-btn').addEventListener('click', clearFilters);
    
    // Load receiver name
    loadReceiverName();
    
    // Load version
    loadVersion();
});

// Load receiver name from API
async function loadReceiverName() {
    try {
        const response = await fetch('/api/description');
        const data = await response.json();
        if (data.receiver && data.receiver.name) {
            document.getElementById('receiver-name').textContent = 
                `${data.receiver.name} - PSKReporter Submission & Locator Tracking`;
        }
    } catch (error) {
        console.error('Error loading receiver name:', error);
    }
}

// Load version
async function loadVersion() {
    try {
        const response = await fetch('/api/description');
        const data = await response.json();
        if (data.version) {
            document.getElementById('footer-version').textContent = `v${data.version}`;
        }
    } catch (error) {
        console.error('Error loading version:', error);
    }
}

// Load countries list for datalist
async function loadCountriesList() {
    try {
        const response = await fetch('/api/cty/countries');
        const data = await response.json();
        const datalist = document.getElementById('countries-datalist');
        datalist.innerHTML = '';
        
        if (data.countries) {
            data.countries.forEach(country => {
                const option = document.createElement('option');
                option.value = country;
                datalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading countries:', error);
    }
}

// Clear all filters
function clearFilters() {
    document.getElementById('callsign-search').value = '';
    document.getElementById('country-search').value = '';
    document.getElementById('hours-select').value = '24';
    document.getElementById('mode-select').value = 'FT8';
    document.getElementById('band-select').value = '';
}

// Load analytics data
async function loadAnalytics() {
    const callsign = document.getElementById('callsign-search').value.trim();
    const country = document.getElementById('country-search').value.trim();
    const hours = document.getElementById('hours-select').value;
    const mode = document.getElementById('mode-select').value;
    const band = document.getElementById('band-select').value;
    
    // Build query parameters
    const params = new URLSearchParams();
    params.append('hours', hours);
    if (mode) params.append('mode', mode);
    if (band) params.append('band', band);
    if (callsign) params.append('callsign', callsign);
    if (country) params.append('country', country);
    
    // Show loading
    showLoading(true);
    setStatus('Loading PSKReporter analytics...');
    
    try {
        const response = await fetch(`/api/pskreporter/stats?${params.toString()}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        currentData = data;
        
        // Display results
        displayAnalytics(data);
        
        // Hide countries container
        document.getElementById('countries-container').style.display = 'none';
        
        setStatus(`Loaded ${data.count} unique callsign/band/mode combinations`);
    } catch (error) {
        console.error('Error loading analytics:', error);
        setStatus(`Error: ${error.message}`, true);
    } finally {
        showLoading(false);
    }
}

// Load countries by band/mode
async function loadCountries() {
    const hours = document.getElementById('hours-select').value;
    const mode = document.getElementById('mode-select').value;
    const band = document.getElementById('band-select').value;
    
    // Build query parameters
    const params = new URLSearchParams();
    params.append('hours', hours);
    if (mode) params.append('mode', mode);
    if (band) params.append('band', band);
    
    // Show loading
    showLoading(true);
    setStatus('Loading countries by band/mode...');
    
    try {
        const response = await fetch(`/api/pskreporter/countries?${params.toString()}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        currentCountriesData = data;
        
        // Display results
        displayCountries(data);
        
        // Hide submissions container
        document.getElementById('data-container').style.display = 'none';
        
        setStatus(`Loaded countries for ${Object.keys(data.countries_by_band_mode || {}).length} bands`);
    } catch (error) {
        console.error('Error loading countries:', error);
        setStatus(`Error: ${error.message}`, true);
    } finally {
        showLoading(false);
    }
}

// Display analytics data
function displayAnalytics(data) {
    const container = document.getElementById('data-container');
    container.style.display = 'block';
    
    // Update title
    const title = document.getElementById('data-title');
    const filters = [];
    if (data.filters.mode) filters.push(data.filters.mode);
    if (data.filters.band) filters.push(data.filters.band);
    if (data.filters.callsign) filters.push(`Callsign: ${data.filters.callsign}`);
    if (data.filters.country) filters.push(`Country: ${data.filters.country}`);
    
    title.textContent = `PSKReporter Submissions${filters.length > 0 ? ' - ' + filters.join(', ') : ''}`;
    
    // Display summary stats
    displaySummaryStats(data);
    
    // Display submissions table
    displaySubmissionsTable(data.stats);
}

// Display summary statistics
function displaySummaryStats(data) {
    const statsGrid = document.getElementById('stats-grid');
    
    // Calculate totals
    let totalSubmissions = 0;
    let totalSent = 0;
    let totalWithLocator = 0;
    let totalNoLocator = 0;
    let uniqueCallsigns = new Set();
    let uniqueCountries = new Set();
    
    data.stats.forEach(stat => {
        totalSubmissions += stat.submission_count;
        totalSent += stat.sent_count;
        totalWithLocator += stat.with_locator_count;
        totalNoLocator += stat.no_locator_count;
        uniqueCallsigns.add(stat.callsign);
        if (stat.country) uniqueCountries.add(stat.country);
    });
    
    const sendRate = totalSubmissions > 0 ? ((totalSent / totalSubmissions) * 100).toFixed(1) : 0;
    const locatorRate = totalSubmissions > 0 ? ((totalWithLocator / totalSubmissions) * 100).toFixed(1) : 0;
    
    statsGrid.innerHTML = `
        <div class="stat-card">
            <div class="stat-value">${data.count}</div>
            <div class="stat-label">Unique Combinations</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${uniqueCallsigns.size}</div>
            <div class="stat-label">Unique Callsigns</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalSubmissions}</div>
            <div class="stat-label">Total Submissions</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalSent}</div>
            <div class="stat-label">Sent to PSKReporter</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${sendRate}%</div>
            <div class="stat-label">Send Rate</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalWithLocator}</div>
            <div class="stat-label">With Locator</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalNoLocator}</div>
            <div class="stat-label">No Locator</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${locatorRate}%</div>
            <div class="stat-label">Locator Rate</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${uniqueCountries.size}</div>
            <div class="stat-label">Unique Countries</div>
        </div>
    `;
}

// Display submissions table
function displaySubmissionsTable(stats) {
    const tableContainer = document.getElementById('submissions-table');
    
    if (!stats || stats.length === 0) {
        tableContainer.innerHTML = '<p>No data available for the selected filters.</p>';
        return;
    }
    
    // Sort by submission count descending
    stats.sort((a, b) => b.submission_count - a.submission_count);
    
    let html = `
        <table style="width: 100%; border-collapse: collapse; background: rgba(255, 255, 255, 0.05); border-radius: 8px; overflow: hidden;">
            <thead>
                <tr style="background: rgba(255, 255, 255, 0.1);">
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Callsign</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Country</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Band</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Mode</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Submissions</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Sent</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Locators Seen</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">With Locator</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">No Locator</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Final Locator</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">First Seen</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid rgba(255, 255, 255, 0.2); white-space: nowrap;">Last Seen</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    stats.forEach(stat => {
        const locatorsList = stat.locators && stat.locators.length > 0
            ? stat.locators.join(', ')
            : '-';
        
        const finalLocator = stat.final_locator || '-';
        const locatorIcon = stat.with_locator_count > 0 ? '📍' : '❌';
        const sentIcon = stat.sent_count > 0 ? '📡' : '⏳';
        
        const firstSeen = new Date(stat.first_seen).toLocaleString();
        const lastSeen = new Date(stat.last_seen).toLocaleString();
        
        html += `
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.1); transition: background 0.3s ease;" onmouseover="this.style.background='rgba(255, 255, 255, 0.08)'" onmouseout="this.style.background='transparent'">
                <td style="padding: 10px;"><strong>${escapeHtml(stat.callsign)}</strong></td>
                <td style="padding: 10px;">${escapeHtml(stat.country || '-')}</td>
                <td style="padding: 10px;">${escapeHtml(stat.band)}</td>
                <td style="padding: 10px;">${escapeHtml(stat.mode)}</td>
                <td style="padding: 10px; text-align: center;">${stat.submission_count}</td>
                <td style="padding: 10px; text-align: center;">${sentIcon} ${stat.sent_count}</td>
                <td style="padding: 10px; text-align: center;" title="${escapeHtml(locatorsList)}">${locatorIcon} ${stat.locators ? stat.locators.length : 0}</td>
                <td style="padding: 10px; text-align: center;">${stat.with_locator_count}</td>
                <td style="padding: 10px; text-align: center;">${stat.no_locator_count}</td>
                <td style="padding: 10px;"><strong>${escapeHtml(finalLocator)}</strong></td>
                <td style="padding: 10px; font-size: 0.9em;">${firstSeen}</td>
                <td style="padding: 10px; font-size: 0.9em;">${lastSeen}</td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    tableContainer.innerHTML = html;
}

// Display countries by band/mode
function displayCountries(data) {
    const container = document.getElementById('countries-container');
    container.style.display = 'block';
    
    const grid = document.getElementById('countries-grid');
    
    const bandModeData = data.countries_by_band_mode || {};
    
    if (Object.keys(bandModeData).length === 0) {
        grid.innerHTML = '<p>No data available for the selected filters.</p>';
        return;
    }
    
    let html = '';
    
    // Sort bands
    const bands = Object.keys(bandModeData).sort();
    
    bands.forEach(band => {
        const modes = bandModeData[band];
        const modeNames = Object.keys(modes).sort();
        
        html += `<div class="band-section" style="margin-bottom: 30px;">`;
        html += `<h3 style="margin-bottom: 15px; color: #333;">📻 ${escapeHtml(band)}</h3>`;
        
        modeNames.forEach(mode => {
            const countries = modes[mode];
            countries.sort();
            
            html += `
                <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
                    <h4 style="margin: 0 0 10px 0; color: #555;">${escapeHtml(mode)} (${countries.length} countries)</h4>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            `;
            
            countries.forEach(country => {
                html += `<span style="padding: 4px 12px; background: #4CAF50; color: white; border-radius: 4px; font-size: 0.9em;">${escapeHtml(country)}</span>`;
            });
            
            html += `
                    </div>
                </div>
            `;
        });
        
        html += `</div>`;
    });
    
    grid.innerHTML = html;
}

// Utility functions
function showLoading(show) {
    document.getElementById('loading-overlay').style.display = show ? 'flex' : 'none';
}

function setStatus(message, isError = false) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.style.color = isError ? '#f44336' : '#ffffff';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
