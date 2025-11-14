// Decoder Spots History JavaScript
(function() {
    'use strict';

    let selectedDate = null;
    let availableDates = [];
    let availableNames = [];
    let currentData = null;

    // Common HF band names (excluding VHF/UHF)
    const commonBands = [
        '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'
    ];

    // Initialize
    document.addEventListener('DOMContentLoaded', function() {
        initializeDatePicker();
        initializeControls();
        loadAvailableDates();
        fetchReceiverInfo();
    });

    function initializeControls() {
        const loadBtn = document.getElementById('load-btn');
        const modeSelect = document.getElementById('mode-select');
        const bandSelect = document.getElementById('band-select');
        const nameSelect = document.getElementById('name-select');
        const dedupCheckbox = document.getElementById('dedup-checkbox');

        loadBtn.addEventListener('click', loadSpots);

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

    async function loadSpots() {
        if (!selectedDate) {
            showStatus('Please select a date first', 'error');
            return;
        }

        const mode = document.getElementById('mode-select').value;
        const band = document.getElementById('band-select').value;
        const name = document.getElementById('name-select').value;
        const dedup = document.getElementById('dedup-checkbox').checked;

        showStatus('Loading spots...', '');
        document.getElementById('load-btn').disabled = true;

        try {
            let url = `/api/decoder/spots?date=${selectedDate}`;
            if (mode) url += `&mode=${mode}`;
            if (band) url += `&band=${band}`;
            if (name) url += `&name=${name}`;
            if (dedup) url += `&dedup=true`;

            const response = await fetch(url);
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

        // Update title
        const mode = document.getElementById('mode-select').value || 'All Modes';
        const band = document.getElementById('band-select').value || 'All Bands';
        const name = document.getElementById('name-select').value || 'All Names';
        let titleParts = [mode];
        if (band !== 'All Bands') titleParts.push(band);
        if (name !== 'All Names') titleParts.push(`(${name})`);
        titleParts.push(selectedDate);
        title.textContent = `${titleParts.join(' - ')}`;

        // Calculate statistics
        const stats = calculateStats(data.spots);
        
        // Display statistics
        statsGrid.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${data.count}</div>
                <div class="stat-label">Total Spots</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueCallsigns}</div>
                <div class="stat-label">Unique Callsigns</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.uniqueCountries}</div>
                <div class="stat-label">Countries</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgSNR > 0 ? '+' : ''}${stats.avgSNR}</div>
                <div class="stat-label">Avg SNR (dB)</div>
            </div>
        `;

        // Display spots table
        tbody.innerHTML = '';
        data.spots.forEach(spot => {
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

            row.innerHTML = `
                <td>${time}</td>
                <td><span class="mode-badge mode-${spot.mode.toLowerCase()}">${spot.mode}</span></td>
                <td>${spot.band}</td>
                <td>${spot.name || '-'}</td>
                <td><strong>${spot.callsign}</strong></td>
                <td>${spot.locator || '-'}</td>
                <td class="${snrClass}">${snrText} dB</td>
                <td>${freqMHz} MHz</td>
                <td>${spot.country || '-'}</td>
                <td style="font-family: monospace; font-size: 0.9em;">${spot.message || '-'}</td>
            `;
            tbody.appendChild(row);
        });

        container.style.display = 'block';
    }

    function calculateStats(spots) {
        const callsigns = new Set();
        const countries = new Set();
        let totalSNR = 0;

        spots.forEach(spot => {
            callsigns.add(spot.callsign);
            if (spot.country) countries.add(spot.country);
            totalSNR += spot.snr;
        });

        return {
            uniqueCallsigns: callsigns.size,
            uniqueCountries: countries.size,
            avgSNR: spots.length > 0 ? Math.round(totalSNR / spots.length) : 0
        };
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
})();