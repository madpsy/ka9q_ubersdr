// PSKReporter Analytics JavaScript
// Handles loading and displaying PSKReporter submission statistics

let currentData = null;
let currentCountriesData = null;
let currentPage = 1;
let itemsPerPage = 100;
let filteredStats = [];
let allStats = []; // Store all stats before filtering
let tableFilter = ''; // Real-time table filter

// Band order for sorting
const BAND_ORDER = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '11m', '10m', '6m', '2m', '1.25m', '70cm'];

// Helper function to sort bands
function sortBands(bands) {
    return bands.sort((a, b) => {
        const indexA = BAND_ORDER.indexOf(a);
        const indexB = BAND_ORDER.indexOf(b);
        if (indexA === -1 && indexB === -1) return a.localeCompare(b);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Load countries for datalist
    loadCountriesList();

    // Set up event listeners
    document.getElementById('load-btn').addEventListener('click', loadAnalytics);
    document.getElementById('load-countries-btn').addEventListener('click', loadCountries);
    document.getElementById('clear-filters-btn').addEventListener('click', clearFilters);

    // Add Enter key listener to input fields
    document.getElementById('callsign-search').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            loadAnalytics();
        }
    });
    
    document.getElementById('country-search').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            loadAnalytics();
        }
    });

    // Add change listeners to dropdowns
    document.getElementById('hours-select').addEventListener('change', loadAnalytics);
    document.getElementById('mode-select').addEventListener('change', loadAnalytics);
    document.getElementById('band-select').addEventListener('change', loadAnalytics);
    document.getElementById('locator-filter').addEventListener('change', loadAnalytics);

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
    document.getElementById('locator-filter').value = '';
}

// Load analytics data
async function loadAnalytics() {
    const callsign = document.getElementById('callsign-search').value.trim();
    const country = document.getElementById('country-search').value.trim();
    const hours = document.getElementById('hours-select').value;
    const mode = document.getElementById('mode-select').value;
    const band = document.getElementById('band-select').value;
    const hasLocator = document.getElementById('locator-filter').value;

    // Build query parameters
    const params = new URLSearchParams();
    params.append('hours', hours);
    if (mode) params.append('mode', mode);
    if (band) params.append('band', band);
    if (callsign) params.append('callsign', callsign);
    if (country) params.append('country', country);
    if (hasLocator) params.append('has_locator', hasLocator);

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
    const country = document.getElementById('country-search').value.trim();

    // Build query parameters
    const params = new URLSearchParams();
    params.append('hours', hours);
    if (mode) params.append('mode', mode);
    if (band) params.append('band', band);
    if (country) params.append('country', country);

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
    if (!stats || stats.length === 0) {
        document.getElementById('submissions-table').innerHTML = '<p>No data available for the selected filters.</p>';
        return;
    }

    // Sort by submission count descending
    stats.sort((a, b) => b.submission_count - a.submission_count);

    // Store all stats and reset filter
    allStats = stats;
    tableFilter = '';
    filteredStats = stats;
    currentPage = 1;

    // Render current page
    renderTablePage();
}

// Render current page of table
function renderTablePage() {
    const tableContainer = document.getElementById('submissions-table');
    const stats = filteredStats;

    if (!stats || stats.length === 0) {
        tableContainer.innerHTML = '<p>No data available for the selected filters.</p>';
        return;
    }

    const totalPages = Math.ceil(stats.length / itemsPerPage);
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, stats.length);
    const pageStats = stats.slice(startIdx, endIdx);

    // Real-time filter input and pagination info
    let html = `
        <div style="margin-bottom: 15px; padding: 10px; background: rgba(255, 255, 255, 0.1); border-radius: 6px;">
            <div style="margin-bottom: 10px;">
                <input type="text"
                       id="table-filter"
                       placeholder="🔍 Filter by callsign, country, or locator..."
                       value="${escapeHtml(tableFilter)}"
                       style="width: 100%; padding: 10px; border-radius: 4px; background: rgba(255, 255, 255, 0.15); color: white; border: 1px solid rgba(255, 255, 255, 0.3); font-size: 1em;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <div>
                    Showing ${startIdx + 1}-${endIdx} of ${stats.length} combinations
                </div>
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; align-items: center; gap: 8px;">
                        Per page:
                        <select id="items-per-page" style="padding: 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.15); color: white; border: 1px solid rgba(255, 255, 255, 0.3);">
                            <option value="50">50</option>
                            <option value="100" selected>100</option>
                            <option value="250">250</option>
                            <option value="500">500</option>
                            <option value="1000">1000</option>
                        </select>
                    </label>
                    <button onclick="changePage(-1)" ${currentPage === 1 ? 'disabled' : ''} style="padding: 5px 15px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; ${currentPage === 1 ? 'opacity: 0.5;' : ''}">← Prev</button>
                    <span>Page ${currentPage} of ${totalPages}</span>
                    <button onclick="changePage(1)" ${currentPage === totalPages ? 'disabled' : ''} style="padding: 5px 15px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; ${currentPage === totalPages ? 'opacity: 0.5;' : ''}">Next →</button>
                </div>
            </div>
        </div>
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

    pageStats.forEach(stat => {
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

    // Set up pagination listeners
    setupPaginationListeners();
}

// Display countries by band/mode
function displayCountries(data) {
    const container = document.getElementById('countries-container');
    container.style.display = 'block';

    const grid = document.getElementById('countries-grid');
    const statsGrid = document.getElementById('countries-stats-grid');

    const bandModeData = data.countries_by_band_mode || {};

    if (Object.keys(bandModeData).length === 0) {
        grid.innerHTML = '<p>No data available for the selected filters.</p>';
        statsGrid.innerHTML = '';
        return;
    }

    // Get country filter
    const countryFilter = document.getElementById('country-search').value.trim().toLowerCase();

    // Calculate statistics
    const allCountries = new Set();
    const countriesByMode = {};
    const countriesByBand = {};

    Object.keys(bandModeData).forEach(band => {
        const modes = bandModeData[band];
        Object.keys(modes).forEach(mode => {
            const countries = modes[mode];
            countries.forEach(country => {
                // Apply country filter
                if (countryFilter && !country.toLowerCase().includes(countryFilter)) {
                    return;
                }
                
                allCountries.add(country);

                if (!countriesByMode[mode]) {
                    countriesByMode[mode] = new Set();
                }
                countriesByMode[mode].add(country);

                if (!countriesByBand[band]) {
                    countriesByBand[band] = new Set();
                }
                countriesByBand[band].add(country);
            });
        });
    });

    // Display stats cards
    let statsHtml = `
        <div class="stat-card">
            <div class="stat-value">${allCountries.size}</div>
            <div class="stat-label">Total Unique Countries</div>
        </div>
    `;

    // Add stats by mode
    Object.keys(countriesByMode).sort().forEach(mode => {
        statsHtml += `
            <div class="stat-card">
                <div class="stat-value">${countriesByMode[mode].size}</div>
                <div class="stat-label">${mode} Countries</div>
            </div>
        `;
    });

    // Add stats by band (sorted)
    const sortedBands = sortBands(Object.keys(countriesByBand));

    sortedBands.forEach(band => {
        statsHtml += `
            <div class="stat-card">
                <div class="stat-value">${countriesByBand[band].size}</div>
                <div class="stat-label">${band} Countries</div>
            </div>
        `;
    });

    statsGrid.innerHTML = statsHtml;

    let html = '';

    // Sort bands by frequency order
    const bands = sortBands(Object.keys(bandModeData));

    bands.forEach(band => {
        const modes = bandModeData[band];
        const modeNames = Object.keys(modes).sort();

        html += `<div class="band-section" style="margin-bottom: 30px;">`;
        html += `<h3 style="margin-bottom: 15px; color: #ffffff;">📻 ${escapeHtml(band)}</h3>`;

        modeNames.forEach(mode => {
            const allCountries = modes[mode];
            // Apply country filter
            const countries = allCountries.filter(country => {
                if (!countryFilter) return true;
                return country.toLowerCase().includes(countryFilter);
            });
            
            // Skip if no countries match the filter
            if (countries.length === 0) return;
            
            countries.sort();

            html += `
                <div style="margin-bottom: 20px; padding: 15px; background: rgba(255, 255, 255, 0.08); border-radius: 8px;">
                    <h4 style="margin: 0 0 10px 0; color: #fff;">${escapeHtml(mode)} (${countries.length} countries)</h4>
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

// Change page
function changePage(delta) {
    const totalPages = Math.ceil(filteredStats.length / itemsPerPage);
    currentPage = Math.max(1, Math.min(currentPage + delta, totalPages));
    renderTablePage();

    // Scroll to top of table
    document.getElementById('submissions-section').scrollIntoView({ behavior: 'smooth' });
}

// Change items per page
function changeItemsPerPage() {
    const select = document.getElementById('items-per-page');
    itemsPerPage = parseInt(select.value);
    currentPage = 1;
    renderTablePage();
}

// Apply real-time table filter
function applyTableFilter(filterText) {
    tableFilter = filterText.toLowerCase().trim();

    if (!tableFilter) {
        // No filter, show all stats
        filteredStats = allStats;
    } else {
        // Filter by callsign, country, or locator
        filteredStats = allStats.filter(stat => {
            const callsignMatch = stat.callsign.toLowerCase().includes(tableFilter);
            const countryMatch = stat.country && stat.country.toLowerCase().includes(tableFilter);
            const locatorMatch = stat.final_locator && stat.final_locator.toLowerCase().includes(tableFilter);
            const locatorsMatch = stat.locators && stat.locators.some(loc => loc.toLowerCase().includes(tableFilter));

            return callsignMatch || countryMatch || locatorMatch || locatorsMatch;
        });
    }

    // Reset to first page when filtering
    currentPage = 1;
    renderTablePage();
}

// Set up items per page change listener (called after table is rendered)
function setupPaginationListeners() {
    const select = document.getElementById('items-per-page');
    if (select) {
        select.value = itemsPerPage;
        select.removeEventListener('change', changeItemsPerPage);
        select.addEventListener('change', changeItemsPerPage);
    }

    // Set up table filter listener
    const filterInput = document.getElementById('table-filter');
    if (filterInput) {
        filterInput.removeEventListener('input', handleTableFilterInput);
        filterInput.addEventListener('input', handleTableFilterInput);
    }
}

// Handle table filter input
function handleTableFilterInput(e) {
    applyTableFilter(e.target.value);
}
