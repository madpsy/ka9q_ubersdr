// Decoder Spots History JavaScript
(function() {
    'use strict';

    let selectedDate = null;
    let availableDates = [];
    let availableNames = [];
    let currentData = null;
    let filteredData = null; // Stores filtered spots
    let activeFilter = null; // Tracks which filter is active
    let clientSearchText = ''; // Client-side search text
    let clientCountryFilter = ''; // Client-side country filter
    let clientCQOnly = false; // Client-side CQ only filter
    let currentPage = 1;
    let recordsPerPage = 100;
    let sortColumn = 'timestamp';
    let sortDirection = 'desc'; // Start with newest first
    let spotsMap = null; // Map instance
    let ctyCountryMap = new Map(); // country name -> ISO2 code

    // Date/time period used for the currently loaded data (reused by the
    // per-callsign spot history modal so it covers the same period)
    let lastQueryPeriod = null;

    // Callsign spot history modal state
    let modalCallsign = null;
    let modalSpots = [];
    let modalPage = 1;
    let modalPerPage = 25;
    let modalRefSpot = null; // spot the modal was opened from (used by "Show on Map")
    let modalRequestId = 0;
    let modalSortColumn = 'timestamp';
    let modalSortDirection = 'desc';
    let modalFilters = { search: '', mode: '', band: '', name: '', minSNR: -999, cqOnly: false, withLocator: false };

    function digHistIso2ToFlag(code) {
        if (!code || code.length !== 2) return '';
        return String.fromCodePoint(
            0x1F1E6 - 0x41 + code.toUpperCase().charCodeAt(0),
            0x1F1E6 - 0x41 + code.toUpperCase().charCodeAt(1)
        ) + ' ';
    }

    function flagForCountry(countryName) {
        if (!countryName) return '';
        return digHistIso2ToFlag(ctyCountryMap.get(countryName));
    }

    async function loadCTYCountries() {
        try {
            const resp = await fetch('/api/cty/countries');
            if (!resp.ok) return;
            const json = await resp.json();
            const countries = json && json.data && json.data.countries;
            if (Array.isArray(countries)) {
                countries.forEach(entry => {
                    if (entry.name && entry.country_code) {
                        ctyCountryMap.set(entry.name, entry.country_code);
                    }
                });
                populateCountrySelect(countries);
            }
        } catch (e) {
            console.warn('[Decoder Spots History] Failed to load CTY countries:', e);
        }
    }

    // Populate the top Country filter from the CTY entity list. The API already
    // returns them sorted by name, and spots.country stores the same entity
    // name, so the value can be sent through as an exact match.
    function populateCountrySelect(countries) {
        const select = document.getElementById('country-select');
        if (!select) return;

        const current = select.value;
        select.innerHTML = '<option value="">All Countries</option>';

        countries.forEach(entry => {
            if (!entry.name) return;
            const option = document.createElement('option');
            option.value = entry.name;
            option.textContent = `${digHistIso2ToFlag(entry.country_code)}${entry.name}`;
            select.appendChild(option);
        });

        select.value = current;
    }

    // Common HF band names (excluding VHF/UHF)
    const commonBands = [
        '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'
    ];

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
        loadCTYCountries();
        initializeDatePicker();
        initializeControls();
        initializeCallsignModal();
        initializeMap();
        loadAvailableDates().then(() => {
            // Auto-select today's date if available
            autoSelectTodayAndLoad();
        });
        fetchReceiverInfo();
    });

    async function initializeMap() {
        // Initialize the map module
        if (typeof DecoderSpotsHistoryMap !== 'undefined') {
            spotsMap = new DecoderSpotsHistoryMap();
            await spotsMap.initMap();
        } else {
            console.warn('DecoderSpotsHistoryMap not loaded');
        }
    }
    function applyClientFilter(filterType) {
        if (!currentData || !currentData.spots) {
            showStatus('No data loaded to filter', 'error');
            return;
        }

        activeFilter = filterType;
        currentPage = 1;

        if (!filterType) {
            filteredData = null;
            updateFilterButtonStates();
            displaySpots(currentData);
            showStatus('Showing all spots', 'success');
            scrollToMap();
            return;
        }

        const spots = currentData.spots;

        switch(filterType) {
            case 'multiple-bands':
                filteredData = filterCallsignsMultipleBands(spots);
                showStatus(`Filtered to ${filteredData.length} spots from callsigns on multiple bands`, 'success');
                break;
            case 'multiple-modes':
                filteredData = filterCallsignsMultipleModes(spots);
                showStatus(`Filtered to ${filteredData.length} spots from callsigns on multiple modes`, 'success');
                break;
            case 'least-country':
                filteredData = filterLeastCommonCountry(spots);
                if (filteredData.length > 0) {
                    showStatus(`Filtered to ${filteredData.length} spots from least common country`, 'success');
                } else {
                    showStatus('No country data available to filter', 'error');
                    filteredData = null;
                    activeFilter = null;
                }
                break;
            case 'least-continent':
                filteredData = filterLeastCommonContinent(spots);
                if (filteredData.length > 0) {
                    showStatus(`Filtered to ${filteredData.length} spots from least common continent`, 'success');
                } else {
                    showStatus('No continent data available to filter', 'error');
                    filteredData = null;
                    activeFilter = null;
                }
                break;
        }

        updateFilterButtonStates();
        displaySpots(currentData);
        scrollToMap();
    }

    function scrollToMap() {
        const mapSection = document.getElementById('map-section');
        if (mapSection && mapSection.style.display !== 'none') {
            mapSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function applyAdditionalClientFilters(spots) {
        let filtered = spots;

        // Apply search filter (searches callsign, locator, country, continent, and message)
        if (clientSearchText) {
            const searchLower = clientSearchText.toLowerCase();
            filtered = filtered.filter(spot => {
                return (spot.callsign && spot.callsign.toLowerCase().includes(searchLower)) ||
                       (spot.locator && spot.locator.toLowerCase().includes(searchLower)) ||
                       (spot.country && spot.country.toLowerCase().includes(searchLower)) ||
                       (spot.continent && spot.continent.toLowerCase().includes(searchLower)) ||
                       (spot.message && spot.message.toLowerCase().includes(searchLower));
            });
        }

        // Apply country filter
        if (clientCountryFilter) {
            filtered = filtered.filter(spot => spot.country === clientCountryFilter);
        }

        // Apply CQ only filter
        if (clientCQOnly) {
            filtered = filtered.filter(spot => spot.message && spot.message.startsWith('CQ '));
        }

        return filtered;
    }

    function populateCountryFilter(spots) {
        const countrySelect = document.getElementById('client-country-filter');
        if (!countrySelect) return;

        // Save current selection
        const currentSelection = countrySelect.value;

        // Get unique countries
        const countries = new Set();
        spots.forEach(spot => {
            if (spot.country) {
                countries.add(spot.country);
            }
        });

        // Sort countries alphabetically
        const sortedCountries = Array.from(countries).sort();

        // Clear existing options except "All"
        countrySelect.innerHTML = '<option value="">All</option>';

        // Add country options (with flag emoji)
        sortedCountries.forEach(country => {
            const option = document.createElement('option');
            option.value = country;
            option.textContent = flagForCountry(country) + country;
            option.style.background = '#1a1a2e';
            option.style.color = '#ffffff';
            countrySelect.appendChild(option);
        });

        // Restore previous selection if it still exists
        if (currentSelection && sortedCountries.includes(currentSelection)) {
            countrySelect.value = currentSelection;
        }
    }

    function filterCallsignsMultipleBands(spots) {
        const callsignBands = new Map();
        spots.forEach(spot => {
            if (!callsignBands.has(spot.callsign)) {
                callsignBands.set(spot.callsign, new Set());
            }
            callsignBands.get(spot.callsign).add(spot.band);
        });

        const multipleBandCallsigns = new Set();
        for (const [callsign, bands] of callsignBands.entries()) {
            if (bands.size > 1) {
                multipleBandCallsigns.add(callsign);
            }
        }

        return spots.filter(spot => multipleBandCallsigns.has(spot.callsign));
    }

    function filterCallsignsMultipleModes(spots) {
        const callsignModes = new Map();
        spots.forEach(spot => {
            if (!callsignModes.has(spot.callsign)) {
                callsignModes.set(spot.callsign, new Set());
            }
            callsignModes.get(spot.callsign).add(spot.mode);
        });

        const multipleModeCallsigns = new Set();
        for (const [callsign, modes] of callsignModes.entries()) {
            if (modes.size > 1) {
                multipleModeCallsigns.add(callsign);
            }
        }

        return spots.filter(spot => multipleModeCallsigns.has(spot.callsign));
    }

    function filterLeastCommonCountry(spots) {
        const countryCounts = new Map();
        spots.forEach(spot => {
            if (spot.country) {
                countryCounts.set(spot.country, (countryCounts.get(spot.country) || 0) + 1);
            }
        });

        if (countryCounts.size === 0) return [];

        let minCount = Infinity;
        let leastCommonCountry = null;
        for (const [country, count] of countryCounts.entries()) {
            if (count < minCount) {
                minCount = count;
                leastCommonCountry = country;
            }
        }

        return spots.filter(spot => spot.country === leastCommonCountry);
    }

    function filterLeastCommonContinent(spots) {
        const continentCounts = new Map();
        spots.forEach(spot => {
            if (spot.continent) {
                continentCounts.set(spot.continent, (continentCounts.get(spot.continent) || 0) + 1);
            }
        });

        if (continentCounts.size === 0) return [];

        let minCount = Infinity;
        let leastCommonContinent = null;
        for (const [continent, count] of continentCounts.entries()) {
            if (count < minCount) {
                minCount = count;
                leastCommonContinent = continent;
            }
        }

        return spots.filter(spot => spot.continent === leastCommonContinent);
    }


    function initializeControls() {
        const loadBtn = document.getElementById('load-btn');
        const clearFiltersBtn = document.getElementById('clear-filters-btn');
        const downloadBtn = document.getElementById('download-csv-btn');
        const modeSelect = document.getElementById('mode-select');
        const bandSelect = document.getElementById('band-select');
        const nameSelect = document.getElementById('name-select');
        const callsignInput = document.getElementById('callsign-input');
        const locatorInput = document.getElementById('locator-input');
        const startTimeInput = document.getElementById('start-time-input');
        const endTimeInput = document.getElementById('end-time-input');
        const recordsPerPageSelect = document.getElementById('records-per-page');

        loadBtn.addEventListener('click', loadSpots);
        clearFiltersBtn.addEventListener('click', clearFilters);
        downloadBtn.addEventListener('click', downloadCSV);

        // Add client-side filter button event listeners
        document.getElementById('filter-multiple-bands').addEventListener('click', () => {
            applyClientFilter('multiple-bands');
        });
        document.getElementById('filter-multiple-modes').addEventListener('click', () => {
            applyClientFilter('multiple-modes');
        });
        document.getElementById('filter-least-country').addEventListener('click', () => {
            applyClientFilter('least-country');
        });
        document.getElementById('filter-least-continent').addEventListener('click', () => {
            applyClientFilter('least-continent');
        });
        document.getElementById('filter-show-all').addEventListener('click', () => {
            applyClientFilter(null);
        });

        // Add event listeners for additional client-side filters
        const clientSearchInput = document.getElementById('client-search-input');
        const clientCountrySelect = document.getElementById('client-country-filter');
        const clientCQOnlyCheckbox = document.getElementById('client-cq-only');

        clientSearchInput.addEventListener('input', function() {
            clientSearchText = this.value.trim();
            if (currentData) {
                currentPage = 1;
                displaySpots(currentData);
            }
        });

        clientCountrySelect.addEventListener('change', function() {
            clientCountryFilter = this.value;
            if (currentData) {
                currentPage = 1;
                displaySpots(currentData);
            }
        });

        clientCQOnlyCheckbox.addEventListener('change', function() {
            clientCQOnly = this.checked;
            if (currentData) {
                currentPage = 1;
                displaySpots(currentData);
            }
        });

        // Add Enter key handler to all form inputs to trigger load
        const formInputs = [
            modeSelect, bandSelect, nameSelect, callsignInput, locatorInput,
            startTimeInput, endTimeInput,
            document.getElementById('continent-select'),
            document.getElementById('country-select'),
            document.getElementById('min-distance-select'),
            document.getElementById('min-snr-select')
        ];
        
        formInputs.forEach(input => {
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    loadSpots();
                }
            });
        });

        // Handle records per page change
        recordsPerPageSelect.addEventListener('change', function() {
            const value = this.value;
            recordsPerPage = value === 'all' ? Infinity : parseInt(value);
            currentPage = 1;
            if (currentData) {
                displaySpots(currentData);
            }
        });

        // Add click handlers to sortable table headers
        document.addEventListener('click', function(e) {
            const th = e.target.closest('th.sortable');
            // Modal table headers are handled separately by the modal itself
            if (th && !th.classList.contains('modal-sortable') && currentData) {
                const column = th.dataset.column;
                if (sortColumn === column) {
                    // Toggle direction if same column
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    // New column, default to ascending
                    sortColumn = column;
                    sortDirection = 'asc';
                }
                currentPage = 1; // Reset to first page when sorting
                displaySpots(currentData);
            }
        });

        // Add callsign input validation
        callsignInput.addEventListener('input', function(e) {
            // Convert to uppercase and remove non-alphanumeric characters
            let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            // Limit to 6 characters
            if (value.length > 6) {
                value = value.substring(0, 6);
            }
            e.target.value = value;
        });

        // Add locator input validation (Maidenhead grid locator format)
        locatorInput.addEventListener('input', function(e) {
            // Convert to uppercase and remove non-alphanumeric characters
            let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            // Limit to 6 characters
            if (value.length > 6) {
                value = value.substring(0, 6);
            }
            e.target.value = value;
        });

        // Populate band select with common bands
        commonBands.forEach(band => {
            const option = document.createElement('option');
            option.value = band;
            option.textContent = band;
            bandSelect.appendChild(option);
        });

        // Fetch and populate available names
        loadAvailableNames();
    }

    function clearFilters() {
        // Clear all filters except date
        document.getElementById('mode-select').value = '';
        document.getElementById('band-select').value = '';
        document.getElementById('name-select').value = '';
        document.getElementById('callsign-input').value = '';
        document.getElementById('locator-input').value = '';
        document.getElementById('start-time-input').value = '';
        document.getElementById('end-time-input').value = '';
        document.getElementById('continent-select').value = '';
        document.getElementById('country-select').value = '';
        document.getElementById('min-distance-select').value = '0';
        document.getElementById('min-snr-select').value = '-999';

        showStatus('Filters cleared', 'success');
    }

    async function loadAvailableNames() {
        try {
            const response = await fetch('/api/decoder/spots/names');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            availableNames = data.names || [];
            
            // Populate name select
            const nameSelect = document.getElementById('name-select');
            availableNames.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                nameSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Error loading available names:', error);
        }
    }

    function initializeDatePicker() {
        const datePickerBtn = document.getElementById('datePickerBtn');
        const datePickerOverlay = document.getElementById('datePickerOverlay');
        const closeDatePicker = document.getElementById('closeDatePicker');
        const cancelDatePicker = document.getElementById('cancelDatePicker');

        datePickerBtn.addEventListener('click', () => {
            datePickerOverlay.classList.add('active');
            renderDatePicker();
        });

        closeDatePicker.addEventListener('click', () => {
            datePickerOverlay.classList.remove('active');
        });

        cancelDatePicker.addEventListener('click', () => {
            datePickerOverlay.classList.remove('active');
        });

        datePickerOverlay.addEventListener('click', (e) => {
            if (e.target === datePickerOverlay) {
                datePickerOverlay.classList.remove('active');
            }
        });

        // Month navigation
        document.getElementById('prevMonth').addEventListener('click', () => {
            changeMonth(-1);
        });

        document.getElementById('nextMonth').addEventListener('click', () => {
            changeMonth(1);
        });
    }

    let currentMonth = new Date();

    function renderDatePicker() {
        const calendar = document.getElementById('datePickerCalendar');
        const monthYearDisplay = document.getElementById('monthYearDisplay');

        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();

        monthYearDisplay.textContent = currentMonth.toLocaleDateString('en-US', { 
            month: 'long', 
            year: 'numeric' 
        });

        // Clear calendar
        calendar.innerHTML = '';

        // Add day headers
        const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        dayHeaders.forEach(day => {
            const header = document.createElement('div');
            header.className = 'date-picker-day-header';
            header.textContent = day;
            calendar.appendChild(header);
        });

        // Get first day of month and number of days
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        // Add empty cells for days before month starts
        for (let i = 0; i < firstDay; i++) {
            const emptyDay = document.createElement('div');
            emptyDay.className = 'date-picker-day empty';
            calendar.appendChild(emptyDay);
        }

        // Add days
        for (let day = 1; day <= daysInMonth; day++) {
            const dayElement = document.createElement('div');
            dayElement.className = 'date-picker-day';
            dayElement.textContent = day;

            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            
            // Check if date has data
            if (availableDates.includes(dateStr)) {
                dayElement.classList.add('available');
            } else {
                dayElement.classList.add('disabled');
            }

            // Check if selected
            if (selectedDate === dateStr) {
                dayElement.classList.add('selected');
            }

            dayElement.addEventListener('click', () => {
                if (!dayElement.classList.contains('disabled')) {
                    selectDate(dateStr);
                }
            });

            calendar.appendChild(dayElement);
        }
    }

    function changeMonth(delta) {
        currentMonth.setMonth(currentMonth.getMonth() + delta);
        renderDatePicker();
    }

    function selectDate(dateStr) {
        selectedDate = dateStr;
        document.getElementById('selectedDateText').textContent = dateStr;
        document.getElementById('datePickerOverlay').classList.remove('active');
        renderDatePicker();
    }

    async function loadAvailableDates() {
        try {
            const response = await fetch('/api/decoder/spots/dates');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            availableDates = data.dates || [];
            
            // Set current month to most recent date if available
            if (availableDates.length > 0) {
                const mostRecent = new Date(availableDates[0]);
                currentMonth = new Date(mostRecent.getFullYear(), mostRecent.getMonth(), 1);
            }
        } catch (error) {
            console.error('Error loading available dates:', error);
            showStatus('Failed to load available dates', 'error');
        }
    }

    function autoSelectTodayAndLoad() {
        // Get today's date in YYYY-MM-DD format
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        // Check if today's date is available
        if (availableDates.includes(todayStr)) {
            selectDate(todayStr);
            // Auto-load spots after a short delay to ensure UI is ready
            setTimeout(() => {
                loadSpots();
            }, 100);
        } else if (availableDates.length > 0) {
            // If today is not available, select the most recent date
            selectDate(availableDates[0]);
            setTimeout(() => {
                loadSpots();
            }, 100);
        } else {
            showStatus('No spot data available yet', 'error');
        }
    }

    function updateFilterButtonStates() {
        const buttons = {
            'filter-multiple-bands': 'multiple-bands',
            'filter-multiple-modes': 'multiple-modes',
            'filter-least-country': 'least-country',
            'filter-least-continent': 'least-continent'
        };

        for (const [buttonId, filterType] of Object.entries(buttons)) {
            const button = document.getElementById(buttonId);
            if (button) {
                if (activeFilter === filterType) {
                    button.style.fontWeight = 'bold';
                    button.style.boxShadow = '0 0 10px rgba(255,255,255,0.5)';
                } else {
                    button.style.fontWeight = 'normal';
                    button.style.boxShadow = 'none';
                }
            }
        }

        const showAllBtn = document.getElementById('filter-show-all');
        if (showAllBtn) {
            if (!activeFilter) {
                showAllBtn.style.fontWeight = 'bold';
                showAllBtn.style.boxShadow = '0 0 10px rgba(255,255,255,0.5)';
            } else {
                showAllBtn.style.fontWeight = 'bold';
                showAllBtn.style.boxShadow = 'none';
            }
        }
    }

    async function loadSpots() {
        if (!selectedDate) {
            showStatus('Please select a date first', 'error');
            return;
        }

        const mode = document.getElementById('mode-select').value;
        const band = document.getElementById('band-select').value;
        const name = document.getElementById('name-select').value;
        const callsign = document.getElementById('callsign-input').value.trim().toUpperCase();
        const locator = document.getElementById('locator-input').value.trim().toUpperCase();
        const startTime = document.getElementById('start-time-input').value.trim();
        const endTime = document.getElementById('end-time-input').value.trim();
        const continent = document.getElementById('continent-select').value;
        const country = document.getElementById('country-select').value;
        const minDistance = document.getElementById('min-distance-select').value;
        const minSNR = document.getElementById('min-snr-select').value;

        // Validate callsign if provided
        if (callsign && !/^[A-Z0-9]{1,6}$/.test(callsign)) {
            showStatus('Invalid callsign format. Use 1-6 alphanumeric characters only.', 'error');
            document.getElementById('load-btn').disabled = false;
            return;
        }

        // Validate locator if provided (Maidenhead format: 2 letters, 2 digits, optional 2 letters)
        if (locator && !/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(locator)) {
            showStatus('Invalid locator format. Use Maidenhead grid format (e.g., FN20, FN20xr).', 'error');
            document.getElementById('load-btn').disabled = false;
            return;
        }

        // Hide data container and show loading spinner
        document.getElementById('data-container').style.display = 'none';
        showStatus('Loading spots...', '', true);
        document.getElementById('load-btn').disabled = true;

        try {
            let url = `/api/decoder/spots?date=${selectedDate}`;
            if (mode) url += `&mode=${mode}`;
            if (band) url += `&band=${band}`;
            if (name) url += `&name=${name}`;
            if (callsign) url += `&callsign=${encodeURIComponent(callsign)}`;
            if (locator) url += `&locator=${encodeURIComponent(locator)}`;
            if (startTime) url += `&start_time=${encodeURIComponent(startTime)}`;
            if (endTime) url += `&end_time=${encodeURIComponent(endTime)}`;
            if (continent) url += `&continent=${continent}`;
            if (country) url += `&country=${encodeURIComponent(country)}`;
            if (minDistance && parseFloat(minDistance) > 0) {
                url += `&min_distance=${minDistance}`;
            }
            if (minSNR && parseInt(minSNR) !== -999) {
                url += `&min_snr=${minSNR}`;
            }

            // Remember the period so the callsign history modal can reuse it
            lastQueryPeriod = { date: selectedDate, startTime: startTime, endTime: endTime };

            const response = await fetch(url);

            // Handle 204 No Content response (no spots found)
            if (response.status === 204) {
                showStatus('No spots found for the selected criteria', 'error');
                document.getElementById('data-container').style.display = 'none';
                return;
            }
            
            // Handle 429 Too Many Requests response (rate limited)
            if (response.status === 429) {
                showStatus('Rate limit exceeded. Please wait a moment before trying again.', 'error');
                document.getElementById('data-container').style.display = 'none';
                return;
            }
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            currentData = data;

            if (!data.spots || data.spots.length === 0) {
                showStatus('No spots found for the selected criteria', 'error');
                document.getElementById('data-container').style.display = 'none';
                return;
            }

            // Reset filters when loading new data
            filteredData = null;
            activeFilter = null;
            updateFilterButtonStates();

            displaySpots(data);
            showStatus(`Loaded ${data.count} spots`, 'success');
        } catch (error) {
            console.error('Error loading spots:', error);
            showStatus(`Error loading spots: ${error.message}`, 'error');
            document.getElementById('data-container').style.display = 'none';
        } finally {
            document.getElementById('load-btn').disabled = false;
        }
    }

    function displaySpots(data) {
        const container = document.getElementById('data-container');
        const title = document.getElementById('data-title');
        const statsGrid = document.getElementById('stats-grid');
        const tbody = document.getElementById('spots-tbody');

        // Populate country filter dropdown with all available countries
        populateCountryFilter(data.spots);

        // Use filtered data if a filter is active, otherwise use all data
        let spotsToDisplay = filteredData ? filteredData : data.spots;

        // Apply additional client-side filters (search, country, CQ only)
        spotsToDisplay = applyAdditionalClientFilters(spotsToDisplay);

        // Sort the data
        const sortedSpots = sortSpots([...spotsToDisplay], sortColumn, sortDirection);

        // Update sort indicators in table headers
        updateSortIndicators();

        // Calculate pagination
        const totalRecords = spotsToDisplay.length;
        const totalPages = recordsPerPage === Infinity ? 1 : Math.ceil(totalRecords / recordsPerPage);
        
        // Ensure current page is valid
        if (currentPage > totalPages) {
            currentPage = totalPages || 1;
        }

        // Calculate start and end indices for current page
        const startIndex = (currentPage - 1) * recordsPerPage;
        const endIndex = recordsPerPage === Infinity ? totalRecords : Math.min(startIndex + recordsPerPage, totalRecords);
        const pageSpots = sortedSpots.slice(startIndex, endIndex);

        // Update pagination info
        const paginationInfo = document.getElementById('pagination-info');
        if (recordsPerPage === Infinity) {
            paginationInfo.textContent = `Showing all ${totalRecords} records`;
        } else {
            paginationInfo.textContent = `Showing ${startIndex + 1}-${endIndex} of ${totalRecords} records`;
        }

        // Render pagination buttons
        renderPaginationButtons(totalPages);

        // Update title
        const mode = document.getElementById('mode-select').value || 'All Modes';
        const band = document.getElementById('band-select').value || 'All Bands';
        const name = document.getElementById('name-select').value || 'All Names';
        let titleParts = [mode];
        if (band !== 'All Bands') titleParts.push(band);
        if (name !== 'All Names') titleParts.push(`(${name})`);
        titleParts.push(selectedDate);
        title.textContent = `${titleParts.join(' - ')}`;

        // Calculate statistics (always use full dataset for stats)
        const stats = calculateStats(data.spots);
        
        // Display statistics
        let statsHTML = `
            <div class="stat-card">
                <div class="stat-value">${data.count}</div>
                <div class="stat-label">Total Spots</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueCallsigns}</div>
                <div class="stat-label">Unique Callsigns</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueLocators}</div>
                <div class="stat-label">Unique Locators</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.callsignsMultipleBands}</div>
                <div class="stat-label">Callsigns on Multiple Bands</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.callsignsMultipleModes}</div>
                <div class="stat-label">Callsigns on Multiple Modes</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueCountries}</div>
                <div class="stat-label">Countries</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueContinents}</div>
                <div class="stat-label">Continents</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgSNR > 0 ? '+' : ''}${stats.avgSNR}</div>
                <div class="stat-label">Avg SNR (dB)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.minSNR > 0 ? '+' : ''}${stats.minSNR}</div>
                <div class="stat-label">Min SNR (dB)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.maxSNR > 0 ? '+' : ''}${stats.maxSNR}</div>
                <div class="stat-label">Max SNR (dB)</div>
            </div>
        `;

        // Add distance statistics if available
        if (stats.hasDistance) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${stats.minDistance.toFixed(0)} km</div>
                    <div class="stat-label">Min Distance</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.maxDistance.toFixed(0)} km</div>
                    <div class="stat-label">Max Distance</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.avgDistance.toFixed(0)} km</div>
                    <div class="stat-label">Avg Distance</div>
                </div>
            `;
        }

        // Add most common statistics
        if (stats.mostCommonLocator) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${stats.mostCommonLocator.value}</div>
                    <div class="stat-label">Most Common Locator (${stats.mostCommonLocator.count})</div>
                </div>
            `;
        }

        if (stats.mostCommonCountry) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${flagForCountry(stats.mostCommonCountry.value)}${stats.mostCommonCountry.value}</div>
                    <div class="stat-label">Most Common Country (${stats.mostCommonCountry.count})</div>
                </div>
            `;
        }

        if (stats.mostCommonContinent) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${continentNames[stats.mostCommonContinent.value] || stats.mostCommonContinent.value}</div>
                    <div class="stat-label">Most Common Continent (${stats.mostCommonContinent.count})</div>
                </div>
            `;
        }

        if (stats.mostCommonBand) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${stats.mostCommonBand.value}</div>
                    <div class="stat-label">Most Common Band (${stats.mostCommonBand.count})</div>
                </div>
            `;
        }

        if (stats.leastCommonBand && stats.uniqueBands > 1) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${stats.leastCommonBand.value}</div>
                    <div class="stat-label">Least Common Band (${stats.leastCommonBand.count})</div>
                </div>
            `;
        }

        // Add least common statistics (only if there are multiple)
        if (stats.leastCommonLocator && stats.uniqueLocators > 1) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${stats.leastCommonLocator.value}</div>
                    <div class="stat-label">Least Common Locator (${stats.leastCommonLocator.count})</div>
                </div>
            `;
        }

        if (stats.leastCommonCountry && stats.uniqueCountries > 1) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${flagForCountry(stats.leastCommonCountry.value)}${stats.leastCommonCountry.value}</div>
                    <div class="stat-label">Least Common Country (${stats.leastCommonCountry.count})</div>
                </div>
            `;
        }

        if (stats.leastCommonContinent && stats.uniqueContinents > 1) {
            statsHTML += `
                <div class="stat-card">
                    <div class="stat-value">${continentNames[stats.leastCommonContinent.value] || stats.leastCommonContinent.value}</div>
                    <div class="stat-label">Least Common Continent (${stats.leastCommonContinent.count})</div>
                </div>
            `;
        }

        statsGrid.innerHTML = statsHTML;

        // Display spots table (only current page)
        tbody.innerHTML = '';
        pageSpots.forEach(spot => {
            const row = document.createElement('tr');
            
            const time = new Date(spot.timestamp).toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const snrClass = spot.snr >= 0 ? 'snr-positive' : 'snr-negative';
            const snrText = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;

            const freqMHz = (spot.frequency / 1000000).toFixed(6);

            // Format distance and bearing
            const distanceText = spot.distance_km ? `${spot.distance_km.toFixed(0)} km` : '-';
            const bearingText = spot.bearing_deg ? `${spot.bearing_deg.toFixed(0)}°` : '-';
            
            row.innerHTML = `
                <td>${time}</td>
                <td><span class="mode-badge mode-${spot.mode.toLowerCase()}">${spot.mode}</span></td>
                <td>${spot.band}</td>
                <td>${spot.name || '-'}</td>
                <td><strong><a href="https://www.qrz.com/db/${spot.callsign}" target="_blank" class="callsign-link" style="color: inherit; text-decoration: none; cursor: pointer;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${flagForCountry(spot.country)}${spot.callsign}</a></strong></td>
                <td>${spot.locator || '-'}</td>
                <td class="${snrClass}">${snrText} dB</td>
                <td>${freqMHz} MHz</td>
                <td>${distanceText}</td>
                <td>${bearingText}</td>
                <td>${spot.country || '-'}</td>
                <td>${spot.continent ? (continentNames[spot.continent] || spot.continent) : '-'}</td>
                <td style="text-align: right;">${spot.seen_count || 1}</td>
            `;
            
            // Add click handler to row (but not on callsign link)
            row.style.cursor = 'pointer';
            row.title = 'Click for full spot history for this callsign';
            row.addEventListener('click', function(e) {
                // Don't trigger if clicking on the callsign link
                if (e.target.closest('.callsign-link')) {
                    return;
                }

                openCallsignModal(spot);
            });
            
            tbody.appendChild(row);
        });

        container.style.display = 'block';

        // Update map with filtered or all spots
        updateMap(spotsToDisplay);
    }

    function updateMap(spots) {
        if (!spotsMap) {
            console.warn('Map not initialized');
            return;
        }

        // Show map section
        spotsMap.show();

        // Clear existing markers first to ensure clean state
        spotsMap.clearMarkers();

        // Add all spots to map (clustering handles performance)
        spotsMap.addSpots(spots);
    }

    function sortSpots(spots, column, direction) {
        return spots.sort((a, b) => {
            let aVal, bVal;

            // Get values based on column
            switch(column) {
                case 'timestamp':
                    aVal = a.timestamp;
                    bVal = b.timestamp;
                    break;
                case 'mode':
                    aVal = a.mode;
                    bVal = b.mode;
                    break;
                case 'band':
                    aVal = a.band;
                    bVal = b.band;
                    break;
                case 'name':
                    aVal = a.name || '';
                    bVal = b.name || '';
                    break;
                case 'callsign':
                    aVal = a.callsign;
                    bVal = b.callsign;
                    break;
                case 'locator':
                    aVal = a.locator || '';
                    bVal = b.locator || '';
                    break;
                case 'snr':
                    aVal = a.snr;
                    bVal = b.snr;
                    break;
                case 'frequency':
                    aVal = a.frequency;
                    bVal = b.frequency;
                    break;
                case 'distance_km':
                    aVal = a.distance_km || 0;
                    bVal = b.distance_km || 0;
                    break;
                case 'bearing_deg':
                    aVal = a.bearing_deg || 0;
                    bVal = b.bearing_deg || 0;
                    break;
                case 'country':
                    aVal = a.country || '';
                    bVal = b.country || '';
                    break;
                case 'continent':
                    aVal = a.continent || '';
                    bVal = b.continent || '';
                    break;
                case 'seen_count':
                    aVal = a.seen_count || 1;
                    bVal = b.seen_count || 1;
                    break;
                default:
                    return 0;
            }

            // Compare values
            let comparison = 0;
            if (typeof aVal === 'string') {
                comparison = aVal.localeCompare(bVal);
            } else {
                comparison = aVal - bVal;
            }

            return direction === 'asc' ? comparison : -comparison;
        });
    }

    function updateSortIndicators() {
        // Remove all sort classes
        document.querySelectorAll('th.sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
        });

        // Add sort class to current column
        const currentTh = document.querySelector(`th.sortable[data-column="${sortColumn}"]`);
        if (currentTh) {
            currentTh.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    }

    function renderPaginationButtons(totalPages) {
        const buttonsContainerTop = document.getElementById('pagination-buttons');
        const buttonsContainerBottom = document.getElementById('pagination-buttons-bottom');
        
        buttonsContainerTop.innerHTML = '';
        buttonsContainerBottom.innerHTML = '';

        if (totalPages <= 1) {
            return; // No pagination needed
        }

        // Render buttons in both locations
        renderPaginationButtonsInContainer(buttonsContainerTop, totalPages);
        renderPaginationButtonsInContainer(buttonsContainerBottom, totalPages);
    }

    function renderPaginationButtonsInContainer(buttonsContainer, totalPages) {

        // Previous button
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '‹ Previous';
        prevBtn.disabled = currentPage === 1;
        prevBtn.style.padding = '5px 10px';
        prevBtn.style.background = currentPage === 1 ? 'rgba(255,255,255,0.1)' : 'rgba(33, 150, 243, 0.8)';
        prevBtn.style.border = '1px solid rgba(255,255,255,0.2)';
        prevBtn.style.borderRadius = '4px';
        prevBtn.style.color = 'white';
        prevBtn.style.cursor = currentPage === 1 ? 'not-allowed' : 'pointer';
        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                displaySpots(currentData);
            }
        });
        buttonsContainer.appendChild(prevBtn);

        // Page number buttons (show first, last, current, and nearby pages)
        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - 2);
        let endPage = Math.min(totalPages, currentPage + 2);

        // Adjust if we're near the start or end
        if (currentPage <= 3) {
            endPage = Math.min(totalPages, maxButtons);
        } else if (currentPage >= totalPages - 2) {
            startPage = Math.max(1, totalPages - maxButtons + 1);
        }

        // First page button
        if (startPage > 1) {
            addPageButton(1, buttonsContainer);
            if (startPage > 2) {
                const ellipsis = document.createElement('span');
                ellipsis.textContent = '...';
                ellipsis.style.padding = '5px 10px';
                ellipsis.style.color = 'rgba(255,255,255,0.5)';
                buttonsContainer.appendChild(ellipsis);
            }
        }

        // Page number buttons
        for (let i = startPage; i <= endPage; i++) {
            addPageButton(i, buttonsContainer);
        }

        // Last page button
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                const ellipsis = document.createElement('span');
                ellipsis.textContent = '...';
                ellipsis.style.padding = '5px 10px';
                ellipsis.style.color = 'rgba(255,255,255,0.5)';
                buttonsContainer.appendChild(ellipsis);
            }
            addPageButton(totalPages, buttonsContainer);
        }

        // Next button
        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next ›';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.style.padding = '5px 10px';
        nextBtn.style.background = currentPage === totalPages ? 'rgba(255,255,255,0.1)' : 'rgba(33, 150, 243, 0.8)';
        nextBtn.style.border = '1px solid rgba(255,255,255,0.2)';
        nextBtn.style.borderRadius = '4px';
        nextBtn.style.color = 'white';
        nextBtn.style.cursor = currentPage === totalPages ? 'not-allowed' : 'pointer';
        nextBtn.addEventListener('click', () => {
            if (currentPage < totalPages) {
                currentPage++;
                displaySpots(currentData);
            }
        });
        buttonsContainer.appendChild(nextBtn);
    }

    function addPageButton(pageNum, container) {
        const btn = document.createElement('button');
        btn.textContent = pageNum;
        btn.style.padding = '5px 10px';
        btn.style.minWidth = '35px';
        btn.style.background = pageNum === currentPage ? 'rgba(33, 150, 243, 1)' : 'rgba(255,255,255,0.1)';
        btn.style.border = '1px solid rgba(255,255,255,0.2)';
        btn.style.borderRadius = '4px';
        btn.style.color = 'white';
        btn.style.cursor = 'pointer';
        btn.style.fontWeight = pageNum === currentPage ? 'bold' : 'normal';
        btn.addEventListener('click', () => {
            currentPage = pageNum;
            displaySpots(currentData);
        });
        container.appendChild(btn);
    }

    function calculateStats(spots) {
        const callsigns = new Set();
        const countries = new Map();
        const continents = new Map();
        const locators = new Map();
        const bands = new Map();
        const callsignBands = new Map(); // Track bands per callsign
        const callsignModes = new Map(); // Track modes per callsign
        let totalSNR = 0;
        let minSNR = Infinity;
        let maxSNR = -Infinity;
        let totalDistance = 0;
        let minDistance = Infinity;
        let maxDistance = -Infinity;
        let distanceCount = 0;

        spots.forEach(spot => {
            callsigns.add(spot.callsign);
            totalSNR += spot.snr;
            minSNR = Math.min(minSNR, spot.snr);
            maxSNR = Math.max(maxSNR, spot.snr);

            // Track bands per callsign
            if (!callsignBands.has(spot.callsign)) {
                callsignBands.set(spot.callsign, new Set());
            }
            callsignBands.get(spot.callsign).add(spot.band);

            // Track modes per callsign
            if (!callsignModes.has(spot.callsign)) {
                callsignModes.set(spot.callsign, new Set());
            }
            callsignModes.get(spot.callsign).add(spot.mode);

            // Count countries
            if (spot.country) {
                countries.set(spot.country, (countries.get(spot.country) || 0) + 1);
            }

            // Count continents
            if (spot.continent) {
                continents.set(spot.continent, (continents.get(spot.continent) || 0) + 1);
            }

            // Count locators
            if (spot.locator) {
                locators.set(spot.locator, (locators.get(spot.locator) || 0) + 1);
            }

            // Count bands
            if (spot.band) {
                bands.set(spot.band, (bands.get(spot.band) || 0) + 1);
            }

            // Calculate distance statistics
            if (spot.distance_km != null) {
                totalDistance += spot.distance_km;
                minDistance = Math.min(minDistance, spot.distance_km);
                maxDistance = Math.max(maxDistance, spot.distance_km);
                distanceCount++;
            }
        });

        // Find most and least common items
        const getMostCommon = (map) => {
            if (map.size === 0) return null;
            let maxCount = 0;
            let maxValue = null;
            for (const [value, count] of map.entries()) {
                if (count > maxCount) {
                    maxCount = count;
                    maxValue = value;
                }
            }
            return { value: maxValue, count: maxCount };
        };

        const getLeastCommon = (map) => {
            if (map.size === 0) return null;
            let minCount = Infinity;
            let minValue = null;
            for (const [value, count] of map.entries()) {
                if (count < minCount) {
                    minCount = count;
                    minValue = value;
                }
            }
            return { value: minValue, count: minCount };
        };

        // Count callsigns on multiple bands
        let callsignsMultipleBands = 0;
        for (const [callsign, bandSet] of callsignBands.entries()) {
            if (bandSet.size > 1) {
                callsignsMultipleBands++;
            }
        }

        // Count callsigns on multiple modes
        let callsignsMultipleModes = 0;
        for (const [callsign, modeSet] of callsignModes.entries()) {
            if (modeSet.size > 1) {
                callsignsMultipleModes++;
            }
        }

        const stats = {
            uniqueCallsigns: callsigns.size,
            callsignsMultipleBands: callsignsMultipleBands,
            callsignsMultipleModes: callsignsMultipleModes,
            uniqueCountries: countries.size,
            uniqueContinents: continents.size,
            uniqueLocators: locators.size,
            uniqueBands: bands.size,
            avgSNR: spots.length > 0 ? Math.round(totalSNR / spots.length) : 0,
            minSNR: spots.length > 0 ? minSNR : 0,
            maxSNR: spots.length > 0 ? maxSNR : 0,
            hasDistance: distanceCount > 0,
            mostCommonLocator: getMostCommon(locators),
            mostCommonCountry: getMostCommon(countries),
            mostCommonContinent: getMostCommon(continents),
            mostCommonBand: getMostCommon(bands),
            leastCommonLocator: getLeastCommon(locators),
            leastCommonCountry: getLeastCommon(countries),
            leastCommonContinent: getLeastCommon(continents),
            leastCommonBand: getLeastCommon(bands)
        };

        if (distanceCount > 0) {
            stats.minDistance = minDistance;
            stats.maxDistance = maxDistance;
            stats.avgDistance = totalDistance / distanceCount;
        }

        return stats;
    }

    // ---------------------------------------------------------------------
    // Callsign spot history modal
    // ---------------------------------------------------------------------

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function initializeCallsignModal() {
        const overlay = document.getElementById('callsignModalOverlay');
        if (!overlay) return;

        document.getElementById('callsignModalClose').addEventListener('click', closeCallsignModal);
        document.getElementById('callsignModalCloseBtn').addEventListener('click', closeCallsignModal);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeCallsignModal();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                closeCallsignModal();
            }
        });

        document.getElementById('callsignModalShowMap').addEventListener('click', () => {
            const spot = modalRefSpot;
            closeCallsignModal();
            showSpotOnMap(spot);
        });

        document.getElementById('callsign-records-per-page').addEventListener('change', function() {
            modalPerPage = this.value === 'all' ? Infinity : parseInt(this.value);
            modalPage = 1;
            renderCallsignModalTable();
        });

        // Filter controls — all client side, the modal already holds every spot
        const searchInput = document.getElementById('callsign-modal-search');
        searchInput.addEventListener('input', function() {
            modalFilters.search = this.value.trim().toLowerCase();
            modalPage = 1;
            renderCallsignModalTable();
        });

        ['mode', 'band', 'name'].forEach(key => {
            document.getElementById(`callsign-modal-${key}`).addEventListener('change', function() {
                modalFilters[key] = this.value;
                modalPage = 1;
                renderCallsignModalTable();
            });
        });

        document.getElementById('callsign-modal-min-snr').addEventListener('change', function() {
            modalFilters.minSNR = parseInt(this.value);
            modalPage = 1;
            renderCallsignModalTable();
        });

        document.getElementById('callsign-modal-cq-only').addEventListener('change', function() {
            modalFilters.cqOnly = this.checked;
            modalPage = 1;
            renderCallsignModalTable();
        });

        document.getElementById('callsign-modal-with-locator').addEventListener('change', function() {
            modalFilters.withLocator = this.checked;
            modalPage = 1;
            renderCallsignModalTable();
        });

        document.getElementById('callsign-modal-clear-filters').addEventListener('click', () => {
            resetCallsignModalFilters();
            renderCallsignModalTable();
        });

        // "View decodes" button inside map popups. Delegated, because Leaflet
        // rebuilds popup DOM on demand.
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.popup-view-decodes');
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();

            const { callsign, band, mode } = btn.dataset;

            // Prefer the full spot the marker was built from, so the modal gets
            // country/locator too; fall back to what the button carries.
            let spot = null;
            if (spotsMap && spotsMap.markers) {
                const entry = spotsMap.markers.get(`${callsign}-${band}-${mode}`);
                if (entry) spot = entry.spot;
            }
            openCallsignModal(spot || { callsign, band, mode });
        });

        // Sortable headers inside the modal table
        document.getElementById('callsignModalTable').addEventListener('click', function(e) {
            const th = e.target.closest('th.modal-sortable');
            if (!th) return;
            const column = th.dataset.column;
            if (modalSortColumn === column) {
                modalSortDirection = modalSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                modalSortColumn = column;
                modalSortDirection = 'asc';
            }
            modalPage = 1;
            renderCallsignModalTable();
        });
    }

    function resetCallsignModalFilters() {
        modalFilters = { search: '', mode: '', band: '', name: '', minSNR: -999, cqOnly: false, withLocator: false };
        modalPage = 1;

        const searchInput = document.getElementById('callsign-modal-search');
        if (searchInput) searchInput.value = '';
        ['mode', 'band', 'name'].forEach(key => {
            const el = document.getElementById(`callsign-modal-${key}`);
            if (el) el.value = '';
        });
        const snrEl = document.getElementById('callsign-modal-min-snr');
        if (snrEl) snrEl.value = '-999';
        const cqEl = document.getElementById('callsign-modal-cq-only');
        if (cqEl) cqEl.checked = false;
        const locEl = document.getElementById('callsign-modal-with-locator');
        if (locEl) locEl.checked = false;
    }

    // Populate the mode/band/name dropdowns from the spots actually returned
    function populateCallsignModalFilterOptions() {
        const fill = (id, values) => {
            const select = document.getElementById(id);
            if (!select) return;
            const current = select.value;
            select.innerHTML = '<option value="">All</option>';
            values.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                select.appendChild(opt);
            });
            select.value = values.includes(current) ? current : '';
        };

        const uniqueSorted = (key) =>
            [...new Set(modalSpots.map(s => s[key]).filter(Boolean))].sort();

        fill('callsign-modal-mode', uniqueSorted('mode'));
        fill('callsign-modal-band', uniqueSorted('band'));
        fill('callsign-modal-name', uniqueSorted('name'));
    }

    function getFilteredModalSpots() {
        let spots = modalSpots;
        const f = modalFilters;

        if (f.mode) spots = spots.filter(s => s.mode === f.mode);
        if (f.band) spots = spots.filter(s => s.band === f.band);
        if (f.name) spots = spots.filter(s => s.name === f.name);
        if (f.minSNR > -999) spots = spots.filter(s => typeof s.snr === 'number' && s.snr >= f.minSNR);
        if (f.cqOnly) spots = spots.filter(s => s.message && s.message.toUpperCase().startsWith('CQ'));
        if (f.withLocator) spots = spots.filter(s => !!s.locator);

        if (f.search) {
            spots = spots.filter(s => {
                const continent = s.continent ? (continentNames[s.continent] || s.continent) : '';
                return [s.message, s.locator, s.band, s.mode, s.name, s.country, continent, s.callsign]
                    .some(v => v && String(v).toLowerCase().includes(f.search));
            });
        }

        return sortModalSpots(spots.slice());
    }

    function sortModalSpots(spots) {
        const dir = modalSortDirection === 'asc' ? 1 : -1;
        const col = modalSortColumn;

        return spots.sort((a, b) => {
            let av = a[col];
            let bv = b[col];

            if (col === 'timestamp') {
                return (new Date(av) - new Date(bv)) * dir;
            }
            // Numeric columns (distance/bearing may be missing — sort those last)
            if (typeof av === 'number' || typeof bv === 'number') {
                if (av == null) return 1;
                if (bv == null) return -1;
                return (av - bv) * dir;
            }
            av = (av || '').toString().toLowerCase();
            bv = (bv || '').toString().toLowerCase();
            if (av === bv) return 0;
            return av < bv ? -dir : dir;
        });
    }

    function updateCallsignModalSortIndicators() {
        // Same convention as the main table: sort-asc/sort-desc drive the arrow
        document.querySelectorAll('#callsignModalTable th.modal-sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
        });

        const currentTh = document.querySelector(
            `#callsignModalTable th.modal-sortable[data-column="${modalSortColumn}"]`);
        if (currentTh) {
            currentTh.classList.add(modalSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    }

    // Scroll the page to the map section and open the popup for a spot.
    // Safe to call while the modal overlay is up — the overlay is fixed, so the
    // page scrolls underneath it and the map is in view once the modal closes.
    function showSpotOnMap(spot) {
        if (!spotsMap || !spot || !spot.locator) return;

        const mapSection = document.getElementById('map-section');
        if (mapSection) {
            mapSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Open popup after the scroll animation
        setTimeout(() => {
            spotsMap.openSpotPopup(spot.callsign, spot.band, spot.mode);
        }, 500);
    }

    function closeCallsignModal() {
        const overlay = document.getElementById('callsignModalOverlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
        modalRequestId++; // invalidate any in-flight fetch
    }

    function setCallsignModalStatus(message) {
        const status = document.getElementById('callsignModalStatus');
        const content = document.getElementById('callsignModalContent');
        if (message) {
            status.textContent = message;
            status.style.display = 'block';
            content.style.display = 'none';
        } else {
            status.style.display = 'none';
            content.style.display = 'block';
        }
    }

    async function openCallsignModal(spot) {
        const overlay = document.getElementById('callsignModalOverlay');
        if (!overlay) return;

        modalCallsign = spot.callsign;
        modalRefSpot = spot;
        modalSpots = [];
        modalPage = 1;
        modalSortColumn = 'timestamp';
        modalSortDirection = 'desc';
        resetCallsignModalFilters();

        const period = lastQueryPeriod || { date: selectedDate, startTime: '', endTime: '' };
        if (!period.date) {
            return;
        }

        document.getElementById('callsignModalTitle').innerHTML =
            `${flagForCountry(spot.country)}${escapeHtml(spot.callsign)}`;

        let periodText = period.date;
        if (period.startTime || period.endTime) {
            periodText += ` ${period.startTime || '00:00'}–${period.endTime || '23:59'} UTC`;
        } else {
            periodText += ' (full day, UTC)';
        }
        document.getElementById('callsignModalSubtitle').textContent =
            `All spots • ${periodText}`;

        const qrzLink = document.getElementById('callsignModalQrz');
        qrzLink.href = `https://www.qrz.com/db/${encodeURIComponent(spot.callsign)}`;

        document.getElementById('callsignModalShowMap').style.display =
            (spotsMap && spot.locator) ? 'inline-block' : 'none';

        overlay.classList.add('active');
        setCallsignModalStatus('Loading spot history…');

        // Move the page behind the overlay to the map and open this spot's popup,
        // so dismissing the modal leaves the user on the map as before.
        showSpotOnMap(spot);

        const requestId = ++modalRequestId;

        try {
            let url = `/api/decoder/spots?date=${encodeURIComponent(period.date)}` +
                      `&callsign=${encodeURIComponent(spot.callsign)}` +
                      `&deduplicate=false&locators_only=false`;
            if (period.startTime) url += `&start_time=${encodeURIComponent(period.startTime)}`;
            if (period.endTime) url += `&end_time=${encodeURIComponent(period.endTime)}`;

            const response = await fetch(url);

            // Ignore responses for a modal that has since been closed/reopened
            if (requestId !== modalRequestId) return;

            if (response.status === 204) {
                setCallsignModalStatus('No spots found for this callsign in the selected period');
                return;
            }
            if (response.status === 429) {
                setCallsignModalStatus('Rate limit exceeded. Please wait a couple of seconds and try again.');
                return;
            }
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            if (requestId !== modalRequestId) return;

            modalSpots = (data.spots || []).slice().sort((a, b) =>
                new Date(b.timestamp) - new Date(a.timestamp));

            if (modalSpots.length === 0) {
                setCallsignModalStatus('No spots found for this callsign in the selected period');
                return;
            }

            setCallsignModalStatus(null);
            renderCallsignModalStats();
            populateCallsignModalFilterOptions();
            renderCallsignModalTable();
        } catch (error) {
            if (requestId !== modalRequestId) return;
            console.error('Error loading callsign spot history:', error);
            setCallsignModalStatus(`Error loading spot history: ${error.message}`);
        }
    }

    function renderCallsignModalStats() {
        const statsGrid = document.getElementById('callsignModalStats');
        const spots = modalSpots;

        const bands = new Set();
        const modes = new Set();
        let bestSNR = null;

        spots.forEach(s => {
            if (s.band) bands.add(s.band);
            if (s.mode) modes.add(s.mode);
            if (typeof s.snr === 'number' && (bestSNR === null || s.snr > bestSNR)) bestSNR = s.snr;
        });

        const timeFmt = { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const last = new Date(spots[0].timestamp).toLocaleTimeString('en-US', timeFmt);
        const first = new Date(spots[spots.length - 1].timestamp).toLocaleTimeString('en-US', timeFmt);

        let html = `
            <div class="stat-card">
                <div class="stat-value">${spots.length}</div>
                <div class="stat-label">Total Spots</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${bands.size}</div>
                <div class="stat-label">Bands (${escapeHtml([...bands].join(', '))})</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${modes.size}</div>
                <div class="stat-label">Modes (${escapeHtml([...modes].join(', '))})</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${bestSNR === null ? '-' : (bestSNR >= 0 ? '+' + bestSNR : bestSNR) + ' dB'}</div>
                <div class="stat-label">Best SNR</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${first} – ${last}</div>
                <div class="stat-label">First / Last Heard</div>
            </div>
        `;

        statsGrid.innerHTML = html;
    }

    function renderCallsignModalTable() {
        const tbody = document.getElementById('callsignModalTbody');
        const spots = getFilteredModalSpots();
        const total = spots.length;
        const totalPages = modalPerPage === Infinity ? 1 : Math.max(1, Math.ceil(total / modalPerPage));

        if (modalPage > totalPages) modalPage = totalPages;

        const startIdx = modalPerPage === Infinity ? 0 : (modalPage - 1) * modalPerPage;
        const endIdx = modalPerPage === Infinity ? total : Math.min(startIdx + modalPerPage, total);
        const pageSpots = spots.slice(startIdx, endIdx);

        updateCallsignModalSortIndicators();

        tbody.innerHTML = '';

        if (total === 0) {
            const row = document.createElement('tr');
            row.innerHTML = `<td colspan="13" style="text-align: center; padding: 20px; opacity: 0.7;">No spots match the current filters</td>`;
            tbody.appendChild(row);
        }

        pageSpots.forEach(spot => {
            const row = document.createElement('tr');

            const time = new Date(spot.timestamp).toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const snrClass = spot.snr >= 0 ? 'snr-positive' : 'snr-negative';
            const snrText = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
            const freqMHz = (spot.frequency / 1000000).toFixed(6);
            const distanceText = spot.distance_km ? `${spot.distance_km.toFixed(0)} km` : '-';
            const bearingText = spot.bearing_deg ? `${spot.bearing_deg.toFixed(0)}°` : '-';

            row.innerHTML = `
                <td>${time}</td>
                <td><span class="mode-badge mode-${escapeHtml((spot.mode || '').toLowerCase())}">${escapeHtml(spot.mode)}</span></td>
                <td>${escapeHtml(spot.band)}</td>
                <td>${escapeHtml(spot.name) || '-'}</td>
                <td><strong>${flagForCountry(spot.country)}${escapeHtml(spot.callsign)}</strong></td>
                <td>${escapeHtml(spot.locator) || '-'}</td>
                <td class="${snrClass}">${snrText} dB</td>
                <td>${freqMHz} MHz</td>
                <td>${distanceText}</td>
                <td>${bearingText}</td>
                <td>${escapeHtml(spot.country) || '-'}</td>
                <td>${spot.continent ? escapeHtml(continentNames[spot.continent] || spot.continent) : '-'}</td>
                <td style="font-family: ui-monospace, 'Courier New', monospace; font-size: 0.9em; line-height: 1.4;">${escapeHtml(spot.message) || '-'}</td>
            `;

            tbody.appendChild(row);
        });

        // Pagination info
        const pageInfo = document.getElementById('callsignModalPageInfo');
        if (total === 0) {
            pageInfo.textContent = `0 of ${modalSpots.length} spots`;
        } else if (total === modalSpots.length) {
            pageInfo.textContent = `Showing ${startIdx + 1}-${endIdx} of ${total}`;
        } else {
            pageInfo.textContent = `Showing ${startIdx + 1}-${endIdx} of ${total} (filtered from ${modalSpots.length})`;
        }

        renderCallsignModalPageButtons(totalPages);
    }

    function renderCallsignModalPageButtons(totalPages) {
        const container = document.getElementById('callsignModalPageButtons');
        container.innerHTML = '';

        if (totalPages <= 1) return;

        const addButton = (label, page, disabled, active) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.disabled = !!disabled;
            if (active) btn.classList.add('active');
            if (!disabled && !active) {
                btn.addEventListener('click', () => {
                    modalPage = page;
                    renderCallsignModalTable();
                });
            } else if (active) {
                btn.disabled = true;
            }
            container.appendChild(btn);
        };

        addButton('‹ Prev', modalPage - 1, modalPage === 1, false);

        // Show a window of pages around the current one
        const windowSize = 5;
        let start = Math.max(1, modalPage - Math.floor(windowSize / 2));
        let end = Math.min(totalPages, start + windowSize - 1);
        start = Math.max(1, end - windowSize + 1);

        if (start > 1) {
            addButton('1', 1, false, modalPage === 1);
            if (start > 2) {
                const dots = document.createElement('span');
                dots.textContent = '…';
                dots.style.padding = '5px';
                container.appendChild(dots);
            }
        }

        for (let p = start; p <= end; p++) {
            addButton(String(p), p, false, p === modalPage);
        }

        if (end < totalPages) {
            if (end < totalPages - 1) {
                const dots = document.createElement('span');
                dots.textContent = '…';
                dots.style.padding = '5px';
                container.appendChild(dots);
            }
            addButton(String(totalPages), totalPages, false, modalPage === totalPages);
        }

        addButton('Next ›', modalPage + 1, modalPage === totalPages, false);
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

    async function downloadCSV() {
        if (!selectedDate) {
            showStatus('Please select a date first', 'error');
            return;
        }

        // Build URL with all current filter parameters
        const mode = document.getElementById('mode-select').value;
        const band = document.getElementById('band-select').value;
        const name = document.getElementById('name-select').value;
        const callsign = document.getElementById('callsign-input').value.trim().toUpperCase();
        const locator = document.getElementById('locator-input').value.trim().toUpperCase();
        const startTime = document.getElementById('start-time-input').value.trim();
        const endTime = document.getElementById('end-time-input').value.trim();
        const continent = document.getElementById('continent-select').value;
        const country = document.getElementById('country-select').value;
        const minDistance = document.getElementById('min-distance-select').value;
        const minSNR = document.getElementById('min-snr-select').value;

        let url = `/api/decoder/spots/csv?date=${selectedDate}`;
        if (mode) url += `&mode=${mode}`;
        if (band) url += `&band=${band}`;
        if (name) url += `&name=${name}`;
        if (callsign) url += `&callsign=${encodeURIComponent(callsign)}`;
        if (locator) url += `&locator=${encodeURIComponent(locator)}`;
        if (startTime) url += `&start_time=${encodeURIComponent(startTime)}`;
        if (endTime) url += `&end_time=${encodeURIComponent(endTime)}`;
        if (continent) url += `&continent=${continent}`;
        if (country) url += `&country=${encodeURIComponent(country)}`;
        if (minDistance && parseFloat(minDistance) > 0) {
            url += `&min_distance=${minDistance}`;
        }
        if (minSNR && parseInt(minSNR) !== -999) {
            url += `&min_snr=${minSNR}`;
        }

        try {
            // Create a temporary link and trigger download
            const link = document.createElement('a');
            link.href = url;
            
            // Build filename based on filters
            let filename = `decoder-spots-${selectedDate}`;
            if (mode) filename += `-${mode}`;
            if (band) filename += `-${band}`;
            if (name) filename += `-${name}`;
            filename += '.csv';
            
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            showStatus('CSV download started', 'success');
        } catch (error) {
            console.error('Error downloading CSV:', error);
            showStatus('Error starting CSV download', 'error');
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
})();