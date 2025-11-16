// Decoder Spots Analytics JavaScript
(function() {
    'use strict';

    let currentData = null;
    let allCountries = [];
    let allContinents = [];
    let showGraphs = false;
    let countryMap = null;
    let countryGrid = null;
    let continentMap = null;
    let continentGrid = null;
    let countryColorMode = 'snr';
    let continentColorMode = 'snr';
    let countryLocatorData = [];
    let continentLocatorData = [];
    
    // Animation state
    let countryAnimation = {
        isPlaying: false,
        currentHourIndex: 0,
        hourlyData: null,
        intervalId: null,
        playbackSpeed: 1000 // 1 second per hour
    };
    
    let continentAnimation = {
        isPlaying: false,
        currentHourIndex: 0,
        hourlyData: null,
        intervalId: null,
        playbackSpeed: 1000 // 1 second per hour
    };

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
        
        // Initialize animation controls
        initializeAnimationControls();

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
                       document.getElementById('hours-select'),
                       document.getElementById('mode-select'),
                       document.getElementById('band-select')];
        
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
        document.getElementById('mode-select').value = 'FT8';
        document.getElementById('band-select').value = '';
        document.getElementById('min-snr-select').value = '-999';
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
        const countryInput = document.getElementById('country-search');
        let country = countryInput.value.trim();
        const continent = document.getElementById('continent-select').value;
        const mode = document.getElementById('mode-select').value;
        const band = document.getElementById('band-select').value;
        const minSNR = document.getElementById('min-snr-select').value;
        const hours = document.getElementById('hours-select').value;

        // Validate and normalize country input if provided
        if (country) {
            const normalizedCountry = getNormalizedCountryName(country);
            if (!normalizedCountry) {
                showStatus('Please select a valid country from the dropdown list', 'error');
                document.getElementById('load-btn').disabled = false;
                countryInput.focus();
                return;
            }
            country = normalizedCountry; // Use the exact name from the list
        }

        // Hide data container and show loading spinner
        document.getElementById('data-container').style.display = 'none';
        showStatus('Loading analytics...', '', true);
        document.getElementById('load-btn').disabled = true;

        try {
            let url = `/api/decoder/spots/analytics?hours=${hours}`;
            if (country) url += `&country=${encodeURIComponent(country)}`;
            if (continent) url += `&continent=${continent}`;
            if (mode) url += `&mode=${mode}`;
            if (band) url += `&band=${encodeURIComponent(band)}`;
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

        // Initialize maps if not already done
        initializeMaps();

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

        // Update country map with data
        updateCountryMap(data);
        
        // Show country animation controls
        document.getElementById('country-animation-controls').style.display = 'flex';

        // Display continent analytics (only if no specific country was selected)
        const continentSection = document.getElementById('continent-section');
        if (data.filters.country) {
            // Hide continent section when a specific country is selected
            continentSection.style.display = 'none';
            document.getElementById('continent-map').style.display = 'none';
            document.getElementById('continent-animation-controls').style.display = 'none';
        } else {
            continentSection.style.display = 'block';
            continentList.innerHTML = '';
            data.by_continent.forEach(continent => {
                const card = createEntityCard(continent, 'continent');
                continentList.appendChild(card);
            });
            
            // Update continent map with data
            updateContinentMap(data);
            
            // Show continent animation controls
            document.getElementById('continent-animation-controls').style.display = 'flex';
        }

        container.style.display = 'block';
    }

    function initializeMaps() {
        // Initialize country map
        if (!countryMap) {
            const countryMapDiv = document.getElementById('country-map');
            countryMapDiv.style.display = 'block';
            
            countryMap = L.map('country-map').setView([20, 0], 2);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(countryMap);
            
            countryGrid = new MaidenheadGrid(countryMap, {
                color: '#666',
                weight: 1,
                opacity: 0.3,
                showLabels: false
            });
            countryGrid.showGrid();
            
            // Color mode radio buttons
            document.querySelectorAll('input[name="country-color-mode"]').forEach(radio => {
                radio.addEventListener('change', function() {
                    countryColorMode = this.value;
                    updateCountryMapColors();
                });
            });
        }

        // Initialize continent map
        if (!continentMap) {
            const continentMapDiv = document.getElementById('continent-map');
            continentMapDiv.style.display = 'block';
            
            continentMap = L.map('continent-map').setView([20, 0], 2);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(continentMap);
            
            continentGrid = new MaidenheadGrid(continentMap, {
                color: '#666',
                weight: 1,
                opacity: 0.3,
                showLabels: false
            });
            continentGrid.showGrid();
            
            // Color mode radio buttons
            document.querySelectorAll('input[name="continent-color-mode"]').forEach(radio => {
                radio.addEventListener('change', function() {
                    continentColorMode = this.value;
                    updateContinentMapColors();
                });
            });
        }
    }

    function updateCountryMap(data) {
        if (!countryGrid) return;

        // Aggregate locators across all countries and bands
        const locatorMap = new Map();
        
        data.by_country.forEach(country => {
            country.bands.forEach(band => {
                band.unique_locators.forEach(loc => {
                    const key = loc.locator;
                    if (!locatorMap.has(key)) {
                        locatorMap.set(key, {
                            locator: loc.locator,
                            total_snr: 0,
                            snr_count: 0,
                            total_spots: 0,
                            total_callsigns: 0,
                            bands: [],
                            countries: new Set(),
                            callsignMap: new Map() // Use Map to deduplicate callsigns
                        });
                    }
                    const agg = locatorMap.get(key);
                    agg.total_snr += loc.avg_snr * loc.count; // Weight by count
                    agg.snr_count += loc.count;
                    agg.total_spots += loc.count;
                    agg.total_callsigns += loc.unique_callsigns;
                    agg.bands.push(band.band);
                    agg.countries.add(country.country);
                    // Collect callsign info and merge bands for same callsign
                    if (loc.callsigns && loc.callsigns.length > 0) {
                        loc.callsigns.forEach(csInfo => {
                            if (!agg.callsignMap.has(csInfo.callsign)) {
                                agg.callsignMap.set(csInfo.callsign, new Set());
                            }
                            // Add all bands for this callsign
                            csInfo.bands.forEach(band => agg.callsignMap.get(csInfo.callsign).add(band));
                        });
                    }
                });
            });
        });

        // Convert to array with calculated averages and deduplicated callsigns
        countryLocatorData = Array.from(locatorMap.values()).map(agg => {
            // Convert callsign map to array of CallsignInfo objects
            const callsigns = Array.from(agg.callsignMap.entries()).map(([callsign, bandsSet]) => ({
                callsign: callsign,
                bands: Array.from(bandsSet).sort()
            }));
            
            return {
                locator: agg.locator,
                avg_snr: agg.total_snr / agg.snr_count,
                count: agg.total_spots,
                unique_callsigns: agg.callsignMap.size, // Use actual unique count from deduplicated map
                bands: [...new Set(agg.bands)].join(', '),
                countries: Array.from(agg.countries).join(', '),
                callsigns: callsigns
            };
        });

        // Update colors based on current mode
        updateCountryMapColors();

        // Invalidate map size and fit bounds
        setTimeout(() => {
            countryMap.invalidateSize();
            if (countryLocatorData.length > 0) {
                const bounds = calculateBounds(countryLocatorData.map(l => l.locator));
                if (bounds) {
                    countryMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
                }
            }
        }, 100);
    }

    function updateContinentMap(data) {
        if (!continentGrid) return;

        // Aggregate locators across all continents and bands
        const locatorMap = new Map();
        
        data.by_continent.forEach(continent => {
            continent.bands.forEach(band => {
                band.unique_locators.forEach(loc => {
                    const key = loc.locator;
                    if (!locatorMap.has(key)) {
                        locatorMap.set(key, {
                            locator: loc.locator,
                            total_snr: 0,
                            snr_count: 0,
                            total_spots: 0,
                            total_callsigns: 0,
                            bands: [],
                            continents: new Set(),
                            callsignMap: new Map() // Use Map to deduplicate callsigns
                        });
                    }
                    const agg = locatorMap.get(key);
                    agg.total_snr += loc.avg_snr * loc.count; // Weight by count
                    agg.snr_count += loc.count;
                    agg.total_spots += loc.count;
                    agg.total_callsigns += loc.unique_callsigns;
                    agg.bands.push(band.band);
                    agg.continents.add(continent.continent_name);
                    // Collect callsign info and merge bands for same callsign
                    if (loc.callsigns && loc.callsigns.length > 0) {
                        loc.callsigns.forEach(csInfo => {
                            if (!agg.callsignMap.has(csInfo.callsign)) {
                                agg.callsignMap.set(csInfo.callsign, new Set());
                            }
                            // Add all bands for this callsign
                            csInfo.bands.forEach(band => agg.callsignMap.get(csInfo.callsign).add(band));
                        });
                    }
                });
            });
        });

        // Convert to array with calculated averages and deduplicated callsigns
        continentLocatorData = Array.from(locatorMap.values()).map(agg => {
            // Convert callsign map to array of CallsignInfo objects
            const callsigns = Array.from(agg.callsignMap.entries()).map(([callsign, bandsSet]) => ({
                callsign: callsign,
                bands: Array.from(bandsSet).sort()
            }));
            
            return {
                locator: agg.locator,
                avg_snr: agg.total_snr / agg.snr_count,
                count: agg.total_spots,
                unique_callsigns: agg.callsignMap.size, // Use actual unique count from deduplicated map
                bands: [...new Set(agg.bands)].join(', '),
                continents: Array.from(agg.continents).join(', '),
                callsigns: callsigns
            };
        });

        // Update colors based on current mode
        updateContinentMapColors();

        // Invalidate map size and fit bounds
        setTimeout(() => {
            continentMap.invalidateSize();
            if (continentLocatorData.length > 0) {
                const bounds = calculateBounds(continentLocatorData.map(l => l.locator));
                if (bounds) {
                    continentMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
                }
            }
        }, 100);
    }

    function updateCountryMapColors() {
        if (!countryGrid || countryLocatorData.length === 0) return;

        countryGrid.clearHighlights();

        const coloredLocators = countryLocatorData.map(loc => ({
            locator: loc.locator,
            style: {
                fillColor: getDynamicColor(loc, countryColorMode, countryLocatorData),
                fillOpacity: 0.35,
                color: '#333',
                weight: 1,
                opacity: 0.6
            },
            data: {
                avg_snr: loc.avg_snr,
                count: loc.count,
                unique_callsigns: loc.unique_callsigns,
                bands: loc.bands,
                countries: loc.countries,
                callsigns: loc.callsigns // Include callsign info for popup
            }
        }));

        countryGrid.highlightLocators(coloredLocators);
    }

    function updateContinentMapColors() {
        if (!continentGrid || continentLocatorData.length === 0) return;

        continentGrid.clearHighlights();

        const coloredLocators = continentLocatorData.map(loc => ({
            locator: loc.locator,
            style: {
                fillColor: getDynamicColor(loc, continentColorMode, continentLocatorData),
                fillOpacity: 0.35,
                color: '#333',
                weight: 1,
                opacity: 0.6
            },
            data: {
                avg_snr: loc.avg_snr,
                count: loc.count,
                unique_callsigns: loc.unique_callsigns,
                bands: loc.bands,
                continents: loc.continents,
                callsigns: loc.callsigns // Include callsign info for popup
            }
        }));

        continentGrid.highlightLocators(coloredLocators);
    }

    function getDynamicColor(locator, mode, allData) {
        if (mode === 'snr') {
            return getDynamicSNRColor(locator.avg_snr, allData);
        } else {
            return getDynamicSpotCountColor(locator.count, allData);
        }
    }

    function getDynamicSNRColor(snr, allData) {
        // Calculate min and max SNR from data
        const snrValues = allData.map(l => l.avg_snr);
        const minSNR = Math.min(...snrValues);
        const maxSNR = Math.max(...snrValues);
        const range = maxSNR - minSNR;

        if (range === 0) return '#7cb342'; // All same value

        // Normalize to 0-1 range
        const normalized = (snr - minSNR) / range;

        // Color gradient from red (0) to green (1)
        return getColorFromGradient(normalized);
    }

    function getDynamicSpotCountColor(count, allData) {
        // Calculate min and max spot counts from data
        const counts = allData.map(l => l.count);
        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);
        const range = maxCount - minCount;

        if (range === 0) return '#7cb342'; // All same value

        // Normalize to 0-1 range
        const normalized = (count - minCount) / range;

        // Color gradient from red (0) to green (1)
        return getColorFromGradient(normalized);
    }

    function getColorFromGradient(value) {
        // value is 0-1, where 0 is worst (red) and 1 is best (green)
        // Color stops: red -> orange -> yellow -> light green -> dark green
        if (value < 0.2) {
            // Red to orange
            const t = value / 0.2;
            return interpolateColor('#d32f2f', '#f57c00', t);
        } else if (value < 0.4) {
            // Orange to yellow
            const t = (value - 0.2) / 0.2;
            return interpolateColor('#f57c00', '#fbc02d', t);
        } else if (value < 0.6) {
            // Yellow to light green
            const t = (value - 0.4) / 0.2;
            return interpolateColor('#fbc02d', '#9ccc65', t);
        } else if (value < 0.8) {
            // Light green to medium green
            const t = (value - 0.6) / 0.2;
            return interpolateColor('#9ccc65', '#7cb342', t);
        } else {
            // Medium green to dark green
            const t = (value - 0.8) / 0.2;
            return interpolateColor('#7cb342', '#388e3c', t);
        }
    }

    function interpolateColor(color1, color2, factor) {
        // Parse hex colors
        const c1 = {
            r: parseInt(color1.slice(1, 3), 16),
            g: parseInt(color1.slice(3, 5), 16),
            b: parseInt(color1.slice(5, 7), 16)
        };
        const c2 = {
            r: parseInt(color2.slice(1, 3), 16),
            g: parseInt(color2.slice(3, 5), 16),
            b: parseInt(color2.slice(5, 7), 16)
        };

        // Interpolate
        const r = Math.round(c1.r + (c2.r - c1.r) * factor);
        const g = Math.round(c1.g + (c2.g - c1.g) * factor);
        const b = Math.round(c1.b + (c2.b - c1.b) * factor);

        // Convert back to hex
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }

    function calculateBounds(locators) {
        if (locators.length === 0) return null;

        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

        locators.forEach(locator => {
            try {
                const bounds = locatorToBounds(locator);
                minLat = Math.min(minLat, bounds.south);
                maxLat = Math.max(maxLat, bounds.north);
                minLon = Math.min(minLon, bounds.west);
                maxLon = Math.max(maxLon, bounds.east);
            } catch (e) {
                // Skip invalid locators
            }
        });

        return [[minLat, minLon], [maxLat, maxLon]];
    }

    function locatorToBounds(locator) {
        if (locator.length !== 4) {
            throw new Error('Locator must be 4 characters');
        }

        const field = locator.substring(0, 2).toUpperCase();
        const square = locator.substring(2, 4);

        const fieldLon = (field.charCodeAt(0) - 65) * 20 - 180;
        const fieldLat = (field.charCodeAt(1) - 65) * 10 - 90;

        const squareLon = parseInt(square[0]) * 2;
        const squareLat = parseInt(square[1]) * 1;

        const west = fieldLon + squareLon;
        const south = fieldLat + squareLat;
        const east = west + 2;
        const north = south + 1;

        return { south, west, north, east };
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
            const minSNR = band.min_snr >= 0 ? `+${band.min_snr.toFixed(1)}` : band.min_snr.toFixed(1);
            const avgSNR = band.avg_snr >= 0 ? `+${band.avg_snr.toFixed(1)}` : band.avg_snr.toFixed(1);
            const maxSNR = band.max_snr >= 0 ? `+${band.max_snr.toFixed(1)}` : band.max_snr.toFixed(1);

            // Use backend's best_hours_utc (top 3) and collate into ranges for "Best Hours"
            const bestHourRanges = collateContiguousHours(band.best_hours_utc);
            // Find the actual top hour by checking which has the most spots in hourly_distribution
            let topHour = null;
            let maxSpots = 0;
            if (band.best_hours_utc.length > 0) {
                band.best_hours_utc.forEach(hour => {
                    const hourKey = String(hour).padStart(2, '0');
                    const spots = band.hourly_distribution[hourKey] || 0;
                    if (spots > maxSpots) {
                        maxSpots = spots;
                        topHour = hour;
                    }
                });
            }

            // Get ALL hours with activity for "Active Hours" from hourly_distribution
            const activeHours = Object.entries(band.hourly_distribution)
                .filter(([hour, count]) => count > 0)
                .map(([hour, count]) => parseInt(hour))
                .sort((a, b) => a - b);
            const activeHourRanges = collateContiguousHours(activeHours);

            bandsHTML += `
                <div class="band-info${isBestBand ? ' band-info-best' : ''}">
                    <div class="band-header">
                        <span class="band-name">${band.band}</span>
                        <span class="band-spots">${band.spots.toLocaleString()} spots</span>
                    </div>
                    <div class="band-snr">SNR: Min ${minSNR} dB • Avg ${avgSNR} dB • Max ${maxSNR} dB</div>
                    <div class="best-hours">
                        <strong>Best Hours (UTC):</strong>
                        <div class="hour-badges">
                            ${band.best_hours_utc.map(hour => {
                                const hourStr = String(hour).padStart(2, '0') + ':00';
                                const isTopHour = hour === topHour;
                                return `<span class="hour-badge${isTopHour ? ' hour-badge-best' : ''}">${hourStr}</span>`;
                            }).join('')}
                        </div>
                    </div>
                    <div class="active-hours">
                        <strong>Active Hours (UTC):</strong>
                        <div class="hour-badges">
                            ${activeHourRanges.map(range => {
                                return `<span class="hour-badge">${range}</span>`;
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

    function collateContiguousHours(hours) {
        if (hours.length === 0) return [];

        const ranges = [];
        let start = hours[0];
        let end = hours[0];

        for (let i = 1; i < hours.length; i++) {
            if (hours[i] === end + 1) {
                // Contiguous hour
                end = hours[i];
            } else {
                // Gap found, save current range
                if (start === end) {
                    ranges.push(`${String(start).padStart(2, '0')}:00`);
                } else {
                    ranges.push(`${String(start).padStart(2, '0')}:00-${String(end).padStart(2, '0')}:00`);
                }
                start = hours[i];
                end = hours[i];
            }
        }

        // Add the last range
        if (start === end) {
            ranges.push(`${String(start).padStart(2, '0')}:00`);
        } else {
            ranges.push(`${String(start).padStart(2, '0')}:00-${String(end).padStart(2, '0')}:00`);
        }

        return ranges;
    }

    function showStatus(message, type, showSpinner = false) {
        const status = document.getElementById('status');
        status.className = 'status';
        if (type) {
            status.classList.add(type);
        }

        if (showSpinner) {
            status.innerHTML = message + '<span class="spinner"></span>';
        } else {
            status.textContent = message;
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

    function getNormalizedCountryName(countryName) {
        // Find the country in our list (case-insensitive) and return the exact name
        const found = allCountries.find(country =>
            country.name.toLowerCase() === countryName.toLowerCase()
        );
        return found ? found.name : null;
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

    // Modal functions - make them global so they can be called from HTML onclick
    window.openCallsignsModal = function(locator, callsigns) {
        const modal = document.getElementById('callsigns-modal');
        const modalTitle = document.getElementById('modal-title');
        const modalList = document.getElementById('modal-callsigns-list');
        
        modalTitle.textContent = `Callsigns for ${locator}`;
        
        // Clear previous content
        modalList.innerHTML = '';
        
        if (!callsigns || callsigns.length === 0) {
            modalList.innerHTML = '<p style="text-align: center; opacity: 0.7;">No callsign data available</p>';
        } else {
            // Sort callsigns alphabetically
            const sortedCallsigns = [...callsigns].sort((a, b) =>
                a.callsign.localeCompare(b.callsign)
            );
            
            sortedCallsigns.forEach(callsignInfo => {
                const item = document.createElement('div');
                item.className = 'callsign-item';
                
                const link = document.createElement('a');
                link.href = `https://www.qrz.com/db/${callsignInfo.callsign}`;
                link.target = '_blank';
                link.className = 'callsign-link';
                link.textContent = callsignInfo.callsign;
                
                const bandsDiv = document.createElement('div');
                bandsDiv.className = 'callsign-bands';
                
                if (callsignInfo.bands && callsignInfo.bands.length > 0) {
                    callsignInfo.bands.forEach(band => {
                        const badge = document.createElement('span');
                        badge.className = 'band-badge';
                        badge.textContent = band;
                        bandsDiv.appendChild(badge);
                    });
                }
                
                item.appendChild(link);
                item.appendChild(bandsDiv);
                modalList.appendChild(item);
            });
        }
        
        modal.style.display = 'block';
    };

    window.closeCallsignsModal = function() {
        const modal = document.getElementById('callsigns-modal');
        modal.style.display = 'none';
    };

    // Close modal when clicking outside of it
    window.onclick = function(event) {
        const modal = document.getElementById('callsigns-modal');
        if (event.target === modal) {
            closeCallsignsModal();
        }
    };

    // Close modal with Escape key
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            closeCallsignsModal();
        }
    });
    
    // Animation functions
    function initializeAnimationControls() {
        // Country animation controls
        const countryPlayBtn = document.getElementById('country-play-btn');
        const countryPauseBtn = document.getElementById('country-pause-btn');
        const countryStopBtn = document.getElementById('country-stop-btn');
        const countrySlider = document.getElementById('country-hour-slider');
        
        if (countryPlayBtn) {
            countryPlayBtn.addEventListener('click', () => playAnimation('country'));
            countryPauseBtn.addEventListener('click', () => pauseAnimation('country'));
            countryStopBtn.addEventListener('click', () => stopAnimation('country'));
            countrySlider.addEventListener('input', (e) => scrubToHour('country', parseInt(e.target.value)));
        }
        
        // Continent animation controls
        const continentPlayBtn = document.getElementById('continent-play-btn');
        const continentPauseBtn = document.getElementById('continent-pause-btn');
        const continentStopBtn = document.getElementById('continent-stop-btn');
        const continentSlider = document.getElementById('continent-hour-slider');
        
        if (continentPlayBtn) {
            continentPlayBtn.addEventListener('click', () => playAnimation('continent'));
            continentPauseBtn.addEventListener('click', () => pauseAnimation('continent'));
            continentStopBtn.addEventListener('click', () => stopAnimation('continent'));
            continentSlider.addEventListener('input', (e) => scrubToHour('continent', parseInt(e.target.value)));
        }
    }
    
    async function playAnimation(mapType) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        
        // If already playing, do nothing
        if (animation.isPlaying) return;
        
        // If no hourly data, fetch it first
        if (!animation.hourlyData) {
            await loadHourlyData(mapType);
            if (!animation.hourlyData) return; // Failed to load
        }
        
        // Show pause button, hide play button
        document.getElementById(`${mapType}-play-btn`).style.display = 'none';
        document.getElementById(`${mapType}-pause-btn`).style.display = 'inline-flex';
        
        animation.isPlaying = true;
        
        // Start animation loop
        animation.intervalId = setInterval(() => {
            updateMapForHour(mapType, animation.currentHourIndex);
            animation.currentHourIndex++;
            
            // Loop back to start after 24 hours
            if (animation.currentHourIndex >= 24) {
                animation.currentHourIndex = 0;
            }
            
            // Update slider
            document.getElementById(`${mapType}-hour-slider`).value = animation.currentHourIndex;
        }, animation.playbackSpeed);
        
        // Update immediately
        updateMapForHour(mapType, animation.currentHourIndex);
    }
    
    function pauseAnimation(mapType) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        
        if (!animation.isPlaying) return;
        
        animation.isPlaying = false;
        clearInterval(animation.intervalId);
        animation.intervalId = null;
        
        // Show play button, hide pause button
        document.getElementById(`${mapType}-play-btn`).style.display = 'inline-flex';
        document.getElementById(`${mapType}-pause-btn`).style.display = 'none';
    }
    
    function stopAnimation(mapType) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        
        pauseAnimation(mapType);
        
        // Reset to hour 0
        animation.currentHourIndex = 0;
        document.getElementById(`${mapType}-hour-slider`).value = 0;
        
        // Show all data (aggregate view)
        if (mapType === 'country') {
            updateCountryMapColors();
        } else {
            updateContinentMapColors();
        }
        
        // Update hour display
        document.getElementById(`${mapType}-hour-display`).textContent = 'Hour: 00:00';
    }
    
    function scrubToHour(mapType, hourIndex) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        
        // Pause if playing
        if (animation.isPlaying) {
            pauseAnimation(mapType);
        }
        
        // Update current hour
        animation.currentHourIndex = hourIndex;
        
        // Update map if we have hourly data
        if (animation.hourlyData) {
            updateMapForHour(mapType, hourIndex);
        }
    }
    
    async function loadHourlyData(mapType) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        
        // Show loading overlay
        document.getElementById('loading-overlay').style.display = 'flex';
        
        try {
            // Build URL with same filters as current analytics
            const countryInput = document.getElementById('country-search').value.trim();
            const country = countryInput ? getNormalizedCountryName(countryInput) : '';
            const continent = document.getElementById('continent-select').value;
            const mode = document.getElementById('mode-select').value;
            const band = document.getElementById('band-select').value;
            const minSNR = document.getElementById('min-snr-select').value;
            const hours = document.getElementById('hours-select').value;
            
            let url = `/api/decoder/spots/analytics/hourly?hours=${hours}`;
            if (country) url += `&country=${encodeURIComponent(country)}`;
            if (continent) url += `&continent=${continent}`;
            if (mode) url += `&mode=${mode}`;
            if (band) url += `&band=${encodeURIComponent(band)}`;
            if (minSNR && parseInt(minSNR) !== -999) {
                url += `&min_snr=${minSNR}`;
            }
            
            const response = await fetch(url);
            
            if (response.status === 429) {
                showStatus('Rate limit exceeded. Please wait before trying animation.', 'error');
                return;
            }
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            animation.hourlyData = data;
            
        } catch (error) {
            console.error('Error loading hourly data:', error);
            showStatus(`Error loading hourly data: ${error.message}`, 'error');
        } finally {
            document.getElementById('loading-overlay').style.display = 'none';
        }
    }
    
    function updateMapForHour(mapType, hourIndex) {
        const animation = mapType === 'country' ? countryAnimation : continentAnimation;
        const grid = mapType === 'country' ? countryGrid : continentGrid;
        const colorMode = mapType === 'country' ? countryColorMode : continentColorMode;
        
        if (!animation.hourlyData || !grid) return;
        
        // Get data for this hour - the API returns an array of 24 hours
        if (!animation.hourlyData.hourly_data || hourIndex >= animation.hourlyData.hourly_data.length) {
            console.error('Invalid hour index or missing hourly data');
            return;
        }
        
        const hourData = animation.hourlyData.hourly_data[hourIndex];
        if (!hourData || !hourData.locators) {
            console.log('No data for hour', hourIndex);
            // Clear the map for this hour
            grid.clearHighlights();
            document.getElementById(`${mapType}-hour-display`).textContent = `Hour: ${String(hourIndex).padStart(2, '0')}:00 (No data)`;
            return;
        }
        
        // Update hour display
        const hourStr = String(hourIndex).padStart(2, '0') + ':00';
        document.getElementById(`${mapType}-hour-display`).textContent = `Hour: ${hourStr}`;
        
        // Clear current highlights
        grid.clearHighlights();
        
        // The hourly data structure has locators directly in the hour object
        const locatorData = Object.entries(hourData.locators).map(([locator, data]) => ({
            locator: locator,
            avg_snr: data.avg_snr,
            count: data.count,
            unique_callsigns: data.callsigns ? data.callsigns.length : 0,
            callsigns: data.callsigns || []
        }));
        
        if (locatorData.length === 0) {
            console.log('No locators for hour', hourIndex);
            return;
        }
        
        // Apply colors
        const coloredLocators = locatorData.map(loc => ({
            locator: loc.locator,
            style: {
                fillColor: getDynamicColor(loc, colorMode, locatorData),
                fillOpacity: 0.35,
                color: '#333',
                weight: 1,
                opacity: 0.6
            },
            data: {
                avg_snr: loc.avg_snr,
                count: loc.count,
                unique_callsigns: loc.unique_callsigns,
                callsigns: loc.callsigns
            }
        }));
        
        grid.highlightLocators(coloredLocators);
    }
})();