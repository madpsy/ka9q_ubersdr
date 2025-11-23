tsForMap = spots;
        if (spots.length > mapMarkerLimit) {
            spotsForMap = [...spots].sort((a, b) => {
                return new Date(b.timestamp) - new Date(a.timestamp);
            }).slice(0, mapMarkerLimit);
        }

        spotsMap.addSpots(spotsForMap);
    }

    function sortSpots(spots, column, direction) {
        return spots.sort((a, b) => {
            let aVal, bVal;

            switch(column) {
                case 'timestamp':
                    aVal = a.timestamp;
                    bVal = b.timestamp;
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
                default:
                    return 0;
            }

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
        document.querySelectorAll('th.sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
        });

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
            return;
        }

        renderPaginationButtonsInContainer(buttonsContainerTop, totalPages);
        renderPaginationButtonsInContainer(buttonsContainerBottom, totalPages);
    }

    function renderPaginationButtonsInContainer(buttonsContainer, totalPages) {
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

        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - 2);
        let endPage = Math.min(totalPages, currentPage + 2);

        if (currentPage <= 3) {
            endPage = Math.min(totalPages, maxButtons);
        } else if (currentPage >= totalPages - 2) {
            startPage = Math.max(1, totalPages - maxButtons + 1);
        }

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

        for (let i = startPage; i <= endPage; i++) {
            addPageButton(i, buttonsContainer);
        }

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
        const callsignBands = new Map();
        let totalSNR = 0;
        let minSNR = Infinity;
        let maxSNR = -Infinity;
        let totalDistance = 0;
        let minDistance = Infinity;
        let maxDistance = -Infinity;
        let distanceCount = 0;
        let totalWPM = 0;
        let wpmCount = 0;

        spots.forEach(spot => {
            callsigns.add(spot.callsign);
            totalSNR += spot.snr;
            minSNR = Math.min(minSNR, spot.snr);
            maxSNR = Math.max(maxSNR, spot.snr);

            if (spot.wpm) {
                totalWPM += spot.wpm;
                wpmCount++;
            }

            if (!callsignBands.has(spot.callsign)) {
                callsignBands.set(spot.callsign, new Set());
            }
            callsignBands.get(spot.callsign).add(spot.band);

            if (spot.country) {
                countries.set(spot.country, (countries.get(spot.country) || 0) + 1);
            }

            if (spot.continent) {
                continents.set(spot.continent, (continents.get(spot.continent) || 0) + 1);
            }

            if (spot.distance_km != null) {
                totalDistance += spot.distance_km;
                minDistance = Math.min(minDistance, spot.distance_km);
                maxDistance = Math.max(maxDistance, spot.distance_km);
                distanceCount++;
            }
        });

        let callsignsMultipleBands = 0;
        for (const [callsign, bandSet] of callsignBands.entries()) {
            if (bandSet.size > 1) {
                callsignsMultipleBands++;
            }
        }

        const stats = {
            uniqueCallsigns: callsigns.size,
            callsignsMultipleBands: callsignsMultipleBands,
            uniqueCountries: countries.size,
            uniqueContinents: continents.size,
            avgSNR: spots.length > 0 ? Math.round(totalSNR / spots.length) : 0,
            minSNR: spots.length > 0 ? minSNR : 0,
            maxSNR: spots.length > 0 ? maxSNR : 0,
            avgWPM: wpmCount > 0 ? Math.round(totalWPM / wpmCount) : 0,
            hasDistance: distanceCount > 0
        };

        if (distanceCount > 0) {
            stats.minDistance = minDistance;
            stats.maxDistance = maxDistance;
            stats.avgDistance = totalDistance / distanceCount;
        }

        return stats;
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

        const band = document.getElementById('band-select').value;
        const name = document.getElementById('name-select').value;
        const callsign = document.getElementById('callsign-input').value.trim().toUpperCase();
        const startTime = document.getElementById('start-time-input').value.trim();
        const endTime = document.getElementById('end-time-input').value.trim();
        const continent = document.getElementById('continent-select').value;
        const direction = document.getElementById('direction-select').value;
        const minDistance = document.getElementById('min-distance-select').value;
        const minSNR = document.getElementById('min-snr-select').value;

        let url = `/api/cwskimmer/spots/csv?date=${selectedDate}`;
        if (band) url += `&band=${band}`;
        if (name) url += `&name=${name}`;
        if (callsign) url += `&callsign=${encodeURIComponent(callsign)}`;
        if (startTime) url += `&start_time=${encodeURIComponent(startTime)}`;
        if (endTime) url += `&end_time=${encodeURIComponent(endTime)}`;
        if (continent) url += `&continent=${continent}`;
        if (direction) url += `&direction=${direction}`;
        if (minDistance && parseFloat(minDistance) > 0) {
            url += `&min_distance=${minDistance}`;
        }
        if (minSNR && parseInt(minSNR) !== -999) {
            url += `&min_snr=${minSNR}`;
        }

        try {
            const link = document.createElement('a');
            link.href = url;
            
            let filename = `cw-spots-${selectedDate}`;
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