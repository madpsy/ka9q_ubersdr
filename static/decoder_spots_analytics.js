// Decoder Spots Analytics JavaScript
(function() {
    'use strict';

    let currentData = null;
    let allCountries = [];
    let allContinents = [];
    let showGraphs = false;

    // Continent name mapping
    const continentNames = {
        'AF': 'Africa',
        'AS': 'Asia',
        'EU': 'Europe',
        'NA': 'North America',
        'OC': 'Oceania',
        'SA': 'South America',
        'AN': 'Antarctica'
    };

    // Initialize
    document.addEventListener('DOMContentLoaded', function() {
        initializeControls();
        loadCountries();
        loadContinents();
        fetchReceiverInfo();
    });

    function initializeControls() {
        const loadBtn = document.getElementById('load-btn');
        const clearFiltersBtn = document.getElementById('clear-filters-btn');
        const countrySearch = document.getElementById('country-search');
        const continentSelect = document.getElementById('continent-select');
        const showGraphsToggle = document.getElementById('show-graphs-toggle');

        loadBtn.addEventListener('click', loadAnalytics);
        clearFiltersBtn.addEventListener('click', clearFilters);

        // Handle graph toggle
        showGraphsToggle.addEventListener('change', function() {
            showGraphs = this.checked;
            toggleGraphsVisibility();
        });

        // Clear country when continent is selected
        continentSelect.addEventListener('change', function() {
            if (this.value) {
                countrySearch.value = '';
            }
        });

        // Clear continent when country is typed
        countrySearch.addEventListener('input', function() {
            if (this.value) {
                continentSelect.value = '';
            }
        });

        // Add Enter key handler to inputs
        const inputs = [countrySearch, continentSelect, 
                       document.getElementById('min-snr-select'),
                       document.getElementById('hours-select')];
        
        inputs.forEach(input => {
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    loadAnalytics();
                }
            });
        });
    }

    function clearFilters() {
        document.getElementById('country-search').value = '';
        document.getElementById('continent-select').value = '';
        document.getElementById('min-snr-select').value = '0';
        document.getElementById('hours-select').value = '24';
        showStatus('Filters cleared', 'success');
    }

    async function loadCountries() {
        try {
            const response = await fetch('/api/cty/countries');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            
            if (data.success && data.data && data.data.countries) {
                allCountries = data.data.countries;
                
                // Populate datalist
                const datalist = document.getElementById('countries-datalist');
                datalist.innerHTML = '';
                
                allCountries.forEach(country => {
                    const option = document.createElement('option');
                    option.value = country.name;
                    datalist.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error loading countries:', error);
        }
    }

    async function loadContinents() {
        try {
            const response = await fetch('/api/cty/continents');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            
            if (data.success && data.data && data.data.continents) {
                allContinents = data.data.continents;
                
                // Populate select
                const select = document.getElementById('continent-select');
                // Keep the "All Continents" option
                
                allContinents.forEach(continent => {
                    const option = document.createElement('option');
                    option.value = continent.code;
                    option.textContent = `${continent.name} (${continent.count} countries)`;
                    select.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error loading continents:', error);
        }
    }

    async function loadAnalytics() {
        const country = document.getElementById('country-search').value.trim();
        const continent = document.getElementById('continent-select').value;
        const minSNR = document.getElementById('min-snr-select').value;
        const hours = document.getElementById('hours-select').value;

        showStatus('Loading analytics...', '');
        document.getElementById('load-btn').disabled = true;

        try {
            let url = `/api/decoder/spots/analytics?hours=${hours}`;
            if (country) url += `&country=${encodeURIComponent(country)}`;
            if (continent) url += `&continent=${continent}`;
            if (minSNR && parseInt(minSNR) !== -999) {
                url += `&min_snr=${minSNR}`;
            }

            const response = await fetch(url);
            
            if (response.status === 429) {
                showStatus('Rate limit exceeded. Please wait a moment before trying again.', 'error');
                return;
            }
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            currentData = data;

            if (!data.by_country || data.by_country.length === 0) {
                showStatus('No analytics data available for the selected criteria', 'error');
                document.getElementById('data-container').style.display = 'none';
                return;
            }

            displayAnalytics(data);
            showStatus(`Loaded analytics for ${data.time_range.hours} hours`, 'success');
        } catch (error) {
            console.error('Error loading analytics:', error);
            showStatus(`Error loading analytics: ${error.message}`, 'error');
            document.getElementById('data-container').style.display = 'none';
        } finally {
            document.getElementById('load-btn').disabled = false;
        }
    }

    function displayAnalytics(data) {
        const container = document.getElementById('data-container');
        const title = document.getElementById('data-title');
        const statsGrid = document.getElementById('stats-grid');
        const countryList = document.getElementById('country-list');
        const continentList = document.getElementById('continent-list');

        // Update title
        let titleParts = [];
        if (data.filters.country) {
            titleParts.push(data.filters.country);
        } else if (data.filters.continent) {
            titleParts.push(continentNames[data.filters.continent] || data.filters.continent);
        } else {
            titleParts.push('All Locations');
        }
        titleParts.push(`Last ${data.time_range.hours} hours`);
        if (data.filters.min_snr > -999) {
            titleParts.push(`SNR ≥ ${data.filters.min_snr} dB`);
        }
        title.textContent = titleParts.join(' • ');

        // Calculate summary statistics
        const totalCountries = data.by_country.length;
        const totalContinents = data.by_continent.length;
        const totalSpots = data.by_country.reduce((sum, c) => sum + c.total_spots, 0);
        
        // Get unique bands
        const allBands = new Set();
        data.by_country.forEach(country => {
            country.bands.forEach(band => allBands.add(band.band));
        });

        // Find most active band
        const bandTotals = {};
        data.by_country.forEach(country => {
            country.bands.forEach(band => {
                bandTotals[band.band] = (bandTotals[band.band] || 0) + band.spots;
            });
        });
        const mostActiveBand = Object.entries(bandTotals).sort((a, b) => b[1] - a[1])[0];

        // Display summary stats
        let statsHTML = `
            <div class="stat-card">
                <div class="stat-value">${totalSpots.toLocaleString()}</div>
                <div class="stat-label">Total Spots</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${totalCountries}</div>
                <div class="stat-label">Countries</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${totalContinents}</div>
                <div class="stat-label">Continents</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${allBands.size}</div>
                <div class="stat-label">Active Bands</div>
            </div>
        `;
        
        if (mostActiveBand) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${mostActiveBand[0]}</div>
                    <div class="stat-label">Most Active Band (${mostActiveBand[1]} spots)</div>
                </div>
            `;
        }

        statsGrid.innerHTML = statsHTML;

        // Display country analytics
        countryList.innerHTML = '';
        data.by_country.forEach(country => {
            const card = createEntityCard(country, 'country');
            countryList.appendChild(card);
        });

        // Display continent analytics (only if no specific country was selected)
        const continentSection = document.getElementById('continent-section');
        if (data.filters.country) {
            // Hide continent section when a specific country is selected
            continentSection.style.display = 'none';
        } else {
            continentSection.style.display = 'block';
            continentList.innerHTML = '';
            data.by_continent.forEach(continent => {
                const card = createEntityCard(continent, 'continent');
                continentList.appendChild(card);
            });
        }

        container.style.display = 'block';
    }

    function createEntityCard(entity, type) {
        const card = document.createElement('div');
        card.className = 'entity-card';

        const name = type === 'country' ? entity.country : 
                     (continentNames[entity.continent] || entity.continent);
        const subtitle = type === 'country' ? 
                        (continentNames[entity.continent] || entity.continent) :
                        `${entity.countries_count} countries`;

        let headerHTML = `
            <div class="entity-header">
                <div>
                    <div class="entity-name">${name}</div>
                    <div style="font-size: 0.9em; opacity: 0.7;">${subtitle}</div>
                </div>
                <div class="entity-spots">${entity.total_spots.toLocaleString()} spots</div>
            </div>
        `;

        // Find the band with most spots
        const maxBandSpots = Math.max(...entity.bands.map(b => b.spots));

        let bandsHTML = '';
        entity.bands.forEach(band => {
            const isBestBand = band.spots === maxBandSpots;
            const avgSNR = band.avg_snr >= 0 ? `+${band.avg_snr.toFixed(1)}` : band.avg_snr.toFixed(1);
            
            // Find the hour with most spots
            const hourCounts = Object.entries(band.hourly_distribution).map(([hour, count]) => ({
                hour: parseInt(hour),
                count: count
            }));
            const maxCount = Math.max(...hourCounts.map(h => h.count));
            const bestHour = hourCounts.find(h => h.count === maxCount)?.hour;
            
            bandsHTML += `
                <div class="band-info${isBestBand ? ' band-info-best' : ''}">
                    <div class="band-header">
                        <span class="band-name">${band.band}</span>
                        <span class="band-spots">${band.spots.toLocaleString()} spots</span>
                    </div>
                    <div class="band-snr">Avg SNR: ${avgSNR} dB</div>
                    <div class="best-hours">
                        <strong>Best Hours (UTC):</strong>
                        <div class="hour-badges">
                            ${band.best_hours_utc.map(hour => {
                                const isBest = hour === bestHour;
                                return `<span class="hour-badge${isBest ? ' hour-badge-best' : ''}">${String(hour).padStart(2, '0')}:00</span>`;
                            }).join('')}
                        </div>
                    </div>
                    ${showGraphs ? createHourlyChart(band.hourly_distribution) : ''}
                </div>
            `;
        });

        card.innerHTML = headerHTML + '<div class="bands-container">' + bandsHTML + '</div>';
        return card;
    }

    function createHourlyChart(hourlyDist) {
        // Create a simple text-based bar chart
        const hours = [];
        const counts = [];
        
        for (let i = 0; i < 24; i++) {
            const key = String(i).padStart(2, '0');
            hours.push(i);
            counts.push(hourlyDist[key] || 0);
        }

        const maxCount = Math.max(...counts);
        if (maxCount === 0) return '';

        let chartHTML = '<div class="hourly-chart" style="display: flex; align-items: flex-end; gap: 2px; height: 60px; padding: 5px;">';
        
        counts.forEach((count, i) => {
            const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
            const opacity = count > 0 ? 0.3 + (count / maxCount) * 0.7 : 0.1;
            chartHTML += `
                <div style="flex: 1; background: rgba(33, 150, 243, ${opacity}); height: ${height}%; 
                            border-radius: 2px; min-height: 2px;" 
                     title="${String(i).padStart(2, '0')}:00 - ${count} spots"></div>
            `;
        });
        
        chartHTML += '</div>';
        return chartHTML;
    }

    function showStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = 'status';
        if (type) {
            status.classList.add(type);
        }
    }

    async function fetchReceiverInfo() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();
                if (data.receiver && data.receiver.name) {
                    document.getElementById('receiver-name').textContent =
                        `${data.receiver.name}`;
                }
                if (data.version) {
                    document.getElementById('footer-version').textContent = `• v${data.version}`;
                }
            }
        } catch (error) {
            console.error('Error fetching receiver info:', error);
        }
    }

    function toggleGraphsVisibility() {
        const charts = document.querySelectorAll('.hourly-chart');
        charts.forEach(chart => {
            if (showGraphs) {
                chart.classList.remove('hidden');
            } else {
                chart.classList.add('hidden');
            }
        });

        // If data is already loaded, refresh the display
        if (currentData) {
            displayAnalytics(currentData);
        }
    }
})();