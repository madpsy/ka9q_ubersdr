// FT8/FT4 Extension for ka9q UberSDR
// Decodes FT8 and FT4 weak signal digital modes
// Version: 1.0.0

class FT8Extension extends DecoderExtension {
    constructor() {
        console.log('FT8: Constructor called');
        super('ft8', {
            displayName: 'FT8/FT4 Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 3000
        });
        console.log('FT8: Super constructor completed');

        // Configuration
        this.config = {
            protocol: 'FT8',
            min_score: 10,
            max_candidates: 100,
            auto_clear: false,
            show_cq_only: false,
            show_latest_only: true  // Default to checked
        };

        // State
        this.running = false;
        this.messages = []; // Array of decoded messages
        this.totalDecoded = 0;
        this.currentSlot = 0;
        this.slotDecoded = 0;
        this.candidateCount = 0;
        this.ldpcFailures = 0;
        this.crcFailures = 0;
        this.autoScroll = true;
        this.lastSyncTime = null;
        this.messageFilter = ''; // Filter text for messages
        
        // Sort state
        this.sortColumn = null; // Column index being sorted
        this.sortDirection = 'asc'; // 'asc' or 'desc'

        // Spectrum visualization
        this.spectrumCanvas = null;
        this.spectrumCtx = null;
    }

    onInitialize() {
        console.log('FT8: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        console.log('FT8: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 20;

            const table = document.getElementById('ft8-messages-table');
            const startBtn = document.getElementById('ft8-start-btn');

            console.log(`FT8: DOM check attempt ${attempts + 1}/${maxAttempts}:`, {
                table: !!table,
                startBtn: !!startBtn
            });

            if (table && startBtn) {
                console.log('FT8: All DOM elements found, setting up...');
                this.setupCanvas();
                this.setupEventHandlers();
                console.log('FT8: Setup complete');
            } else if (attempts < maxAttempts) {
                console.log(`FT8: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                setTimeout(() => trySetup(attempts + 1), 100);
            } else {
                console.error('FT8: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.ft8_template;

        if (!template) {
            console.error('FT8: Template not found');
            return;
        }

        const container = document.getElementById('extension-content');
        if (container) {
            container.innerHTML = template;
            console.log('FT8: Template rendered');
        } else {
            console.error('FT8: Extension content container not found');
        }
    }

    setupCanvas() {
        this.spectrumCanvas = document.getElementById('ft8-spectrum-canvas');
        if (this.spectrumCanvas) {
            this.spectrumCtx = this.spectrumCanvas.getContext('2d');
            // Set canvas size to match display size
            const rect = this.spectrumCanvas.getBoundingClientRect();
            this.spectrumCanvas.width = rect.width;
            this.spectrumCanvas.height = rect.height;

            console.log('FT8: Spectrum canvas initialized');
        }
    }

    setupEventHandlers() {
        // Start/Stop buttons
        const startBtn = document.getElementById('ft8-start-btn');
        const stopBtn = document.getElementById('ft8-stop-btn');
        const clearBtn = document.getElementById('ft8-clear-btn');
        const exportBtn = document.getElementById('ft8-export-btn');

        if (startBtn) {
            startBtn.addEventListener('click', () => this.start());
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stop());
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearMessages());
        }
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportMessages());
        }

        // Protocol selector
        const protocolSelect = document.getElementById('ft8-protocol-select');
        if (protocolSelect) {
            protocolSelect.value = this.config.protocol;
            protocolSelect.addEventListener('change', (e) => {
                this.config.protocol = e.target.value;
                this.updateProtocolDisplay();
                if (this.running) {
                    // Restart with new protocol
                    this.stop();
                    setTimeout(() => this.start(), 100);
                }
            });
        }

        // Min score is fixed at 10 (not user-configurable)
        this.config.min_score = 10;

        // Checkboxes
        const showCQOnly = document.getElementById('ft8-show-cq-only');
        if (showCQOnly) {
            showCQOnly.checked = this.config.show_cq_only;
            showCQOnly.addEventListener('change', (e) => {
                this.config.show_cq_only = e.target.checked;
                this.filterMessages();
            });
        }

        const autoClear = document.getElementById('ft8-auto-clear');
        if (autoClear) {
            autoClear.checked = this.config.auto_clear;
            autoClear.addEventListener('change', (e) => {
                this.config.auto_clear = e.target.checked;
            });
        }

        const autoScroll = document.getElementById('ft8-auto-scroll');
        if (autoScroll) {
            autoScroll.checked = this.autoScroll;
            autoScroll.addEventListener('change', (e) => {
                this.autoScroll = e.target.checked;
            });
        }

        const showLatestOnly = document.getElementById('ft8-show-latest-only');
        if (showLatestOnly) {
            showLatestOnly.checked = this.config.show_latest_only;
            showLatestOnly.addEventListener('change', (e) => {
                this.config.show_latest_only = e.target.checked;
                this.filterMessages();
            });
        }

        // Message filter input
        const messageFilter = document.getElementById('ft8-message-filter');
        if (messageFilter) {
            messageFilter.value = this.messageFilter;
            messageFilter.addEventListener('input', (e) => {
                this.messageFilter = e.target.value.toLowerCase();
                this.filterMessages();
            });
        }

        // Frequency selector
        const freqSelect = document.getElementById('ft8-frequency-select');
        if (freqSelect) {
            freqSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    const [freq, mode] = e.target.value.split(',');
                    // Detect protocol from the selected option text
                    const selectedOption = e.target.options[e.target.selectedIndex];
                    const optionText = selectedOption.text;
                    const protocol = optionText.includes('FT4') ? 'FT4' : 'FT8';
                    this.tuneToFrequency(parseInt(freq), mode, protocol);
                }
            });
        }

        // Initialize totals display
        this.updateTotalsDisplay();

        // Add click handlers to table headers for sorting
        this.setupTableSorting();

        console.log('FT8: Event handlers setup complete');
    }

    setupTableSorting() {
        const table = document.getElementById('ft8-messages-table');
        if (!table) return;

        const headers = table.querySelectorAll('thead th');
        headers.forEach((header, index) => {
            header.style.cursor = 'pointer';
            header.style.userSelect = 'none';
            header.addEventListener('click', () => this.sortTable(index));
        });
    }

    sortTable(columnIndex) {
        // Toggle sort direction if clicking the same column
        if (this.sortColumn === columnIndex) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = columnIndex;
            this.sortDirection = 'asc';
        }

        // Get all visible rows
        const tbody = document.getElementById('ft8-messages-tbody');
        if (!tbody) return;

        const rows = Array.from(tbody.getElementsByTagName('tr'));
        
        // Sort rows based on column type
        rows.sort((a, b) => {
            const aCell = a.cells[columnIndex];
            const bCell = b.cells[columnIndex];
            
            if (!aCell || !bCell) return 0;

            let aValue, bValue;

            // Determine data type and extract values
            switch (columnIndex) {
                case 0: // UTC (time string)
                    aValue = aCell.textContent;
                    bValue = bCell.textContent;
                    return this.sortDirection === 'asc'
                        ? aValue.localeCompare(bValue)
                        : bValue.localeCompare(aValue);

                case 1: // SNR (number)
                case 2: // Delta T (number)
                case 3: // Frequency (number)
                case 4: // Distance (number)
                case 10: // Slot (number)
                    aValue = parseFloat(aCell.textContent) || 0;
                    bValue = parseFloat(bCell.textContent) || 0;
                    return this.sortDirection === 'asc'
                        ? aValue - bValue
                        : bValue - aValue;

                case 5: // Bearing (number with °)
                    aValue = parseFloat(aCell.textContent.replace('°', '')) || 0;
                    bValue = parseFloat(bCell.textContent.replace('°', '')) || 0;
                    return this.sortDirection === 'asc'
                        ? aValue - bValue
                        : bValue - aValue;

                case 6: // Country (string)
                case 7: // Continent (string)
                case 8: // TX Call (string)
                case 9: // Message (string)
                    aValue = aCell.textContent.trim();
                    bValue = bCell.textContent.trim();
                    return this.sortDirection === 'asc'
                        ? aValue.localeCompare(bValue)
                        : bValue.localeCompare(aValue);

                default:
                    return 0;
            }
        });

        // Re-append rows in sorted order
        rows.forEach(row => tbody.appendChild(row));

        // Update sort indicators
        this.updateSortIndicators(columnIndex);
    }

    updateSortIndicators(columnIndex) {
        const table = document.getElementById('ft8-messages-table');
        if (!table) return;

        const headers = table.querySelectorAll('thead th');
        headers.forEach((header, index) => {
            // Remove existing indicators
            header.textContent = header.textContent.replace(' ▲', '').replace(' ▼', '');
            
            // Add indicator to sorted column
            if (index === columnIndex) {
                header.textContent += this.sortDirection === 'asc' ? ' ▲' : ' ▼';
            }
        });
    }

    start() {
        if (this.running) {
            console.log('FT8: Already running');
            return;
        }

        console.log('FT8: Starting decoder');
        
        // Clear previous messages if auto-clear enabled
        if (this.config.auto_clear) {
            this.clearMessages();
        }

        // Attach to audio extension via DX WebSocket
        this.attachAudioExtension();

        this.running = true;
        this.updateUI();
        this.updateStatus('Running', 'status-connected');
    }

    stop() {
        if (!this.running) {
            console.log('FT8: Not running');
            return;
        }

        console.log('FT8: Stopping decoder');
        
        // Detach from audio extension
        this.detachAudioExtension();
        
        this.running = false;
        this.updateUI();
        this.updateStatus('Stopped', 'status-disconnected');
    }

    attachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('FT8: DX WebSocket not connected');
            return;
        }

        // Setup binary message handler before attaching
        this.setupBinaryMessageHandler();

        const message = {
            type: 'audio_extension_attach',
            extension_name: 'ft8',
            params: {
                protocol: this.config.protocol,
                min_score: this.config.min_score,
                max_candidates: this.config.max_candidates
            }
        };

        console.log('FT8: Sending attach command:', message);
        dxClient.ws.send(JSON.stringify(message));
    }

    detachAudioExtension() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || dxClient.ws.readyState !== WebSocket.OPEN) {
            console.error('FT8: DX WebSocket not connected');
            return;
        }

        // Remove binary message handler before detaching
        this.removeBinaryMessageHandler();

        const message = {
            type: 'audio_extension_detach'
        };

        console.log('FT8: Sending detach command');
        dxClient.ws.send(JSON.stringify(message));
    }

    setupBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws) return;

        // Remove any existing handler first to prevent duplicates
        this.removeBinaryMessageHandler();

        // Store reference to our handler
        this.binaryMessageHandler = (event) => {
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                this.onBinaryMessage(event.data);
            }
        };

        // Add our handler
        dxClient.ws.addEventListener('message', this.binaryMessageHandler);
        console.log('FT8: Binary message handler attached');
    }

    removeBinaryMessageHandler() {
        const dxClient = window.dxClusterClient;
        if (!dxClient || !dxClient.ws || !this.binaryMessageHandler) return;

        dxClient.ws.removeEventListener('message', this.binaryMessageHandler);
        this.binaryMessageHandler = null;
        console.log('FT8: Binary message handler removed');
    }

    async onBinaryMessage(data) {
        try {
            // Convert Blob to ArrayBuffer if necessary
            let arrayBuffer;
            if (data instanceof Blob) {
                arrayBuffer = await data.arrayBuffer();
            } else if (data instanceof ArrayBuffer) {
                arrayBuffer = data;
            } else {
                console.error('FT8: Unexpected data type:', typeof data);
                return;
            }

            // Parse JSON message from decoder
            const decoder = new TextDecoder();
            const message = JSON.parse(decoder.decode(arrayBuffer));
            
            console.log('FT8: Decoded message:', message);
            
            // Add to messages array
            this.messages.push(message);
            this.totalDecoded++;
            this.slotDecoded++;

            // Hard limit: Keep only the latest 1000 messages to prevent memory issues
            if (this.messages.length > 1000) {
                const removeCount = this.messages.length - 1000;
                this.messages = this.messages.slice(removeCount);
                
                // Remove old rows from DOM
                const tbody = document.getElementById('ft8-messages-tbody');
                if (tbody && tbody.rows.length > 1000) {
                    // Remove oldest rows (from the end since we insert at top)
                    for (let i = 0; i < removeCount; i++) {
                        if (tbody.rows.length > 1000) {
                            tbody.deleteRow(tbody.rows.length - 1);
                        }
                    }
                }
            }

            // Update decode statistics from message
            if (message.candidate_count !== undefined) {
                this.candidateCount = message.candidate_count;
            }
            if (message.ldpc_failures !== undefined) {
                this.ldpcFailures = message.ldpc_failures;
            }
            if (message.crc_failures !== undefined) {
                this.crcFailures = message.crc_failures;
            }

            // Update slot if changed
            if (message.slot_number !== this.currentSlot) {
                this.currentSlot = message.slot_number;
                this.slotDecoded = 1;

                // Auto-clear old messages if enabled
                if (this.config.auto_clear && this.messages.length > 100) {
                    const removeCount = this.messages.length - 100;
                    this.messages = this.messages.slice(removeCount);
                    
                    // Remove old rows from DOM
                    const tbody = document.getElementById('ft8-messages-tbody');
                    if (tbody && tbody.rows.length > 100) {
                        for (let i = 0; i < removeCount; i++) {
                            if (tbody.rows.length > 100) {
                                tbody.deleteRow(tbody.rows.length - 1);
                            }
                        }
                    }
                }

                // If showing latest only, re-filter to hide old slots
                if (this.config.show_latest_only) {
                    this.filterMessages();
                }
            }

            // Update slot display
            this.updateSlotDisplay(message.slot_number);

            // Update sync display (we're synced if we're receiving decodes)
            this.updateSyncDisplay(true);

            // Add to table
            this.addMessageToTable(message);
            
            // Update counters
            this.updateCounters();
            
        } catch (error) {
            console.error('FT8: Error parsing message:', error);
        }
    }

    addMessageToTable(message) {
        const tbody = document.getElementById('ft8-messages-tbody');
        if (!tbody) return;

        const row = tbody.insertRow(0); // Insert at top
        
        // UTC time
        const cellUTC = row.insertCell(0);
        cellUTC.textContent = message.utc;
        cellUTC.className = 'ft8-cell-time';
        
        // SNR
        const cellSNR = row.insertCell(1);
        cellSNR.textContent = message.snr.toFixed(1);
        cellSNR.className = 'ft8-cell-snr';
        if (message.snr >= 0) {
            cellSNR.classList.add('ft8-snr-positive');
        } else if (message.snr >= -10) {
            cellSNR.classList.add('ft8-snr-medium');
        } else {
            cellSNR.classList.add('ft8-snr-negative');
        }
        
        // Delta T
        const cellDT = row.insertCell(2);
        cellDT.textContent = message.delta_t.toFixed(1);
        cellDT.className = 'ft8-cell-dt';
        
        // Frequency
        const cellFreq = row.insertCell(3);
        cellFreq.textContent = message.frequency.toFixed(0);
        cellFreq.className = 'ft8-cell-freq';
        
        // Distance
        const cellDist = row.insertCell(4);
        if (message.distance_km !== undefined && message.distance_km !== null) {
            cellDist.textContent = message.distance_km.toFixed(0);
        } else {
            cellDist.textContent = '-';
        }
        cellDist.className = 'ft8-cell-distance';
        
        // Bearing
        const cellBrg = row.insertCell(5);
        if (message.bearing_deg !== undefined && message.bearing_deg !== null) {
            cellBrg.textContent = message.bearing_deg.toFixed(0) + '°';
        } else {
            cellBrg.textContent = '-';
        }
        cellBrg.className = 'ft8-cell-bearing';
        
        // Country
        const cellCountry = row.insertCell(6);
        cellCountry.textContent = message.country || '-';
        cellCountry.className = 'ft8-cell-country';
        
        // Continent
        const cellContinent = row.insertCell(7);
        cellContinent.textContent = message.continent || '-';
        cellContinent.className = 'ft8-cell-continent';
        
        // TX Callsign (normalized callsign used for CTY lookup)
        const cellTxCall = row.insertCell(8);
        if (message.tx_callsign && message.tx_callsign !== '-') {
            const link = document.createElement('a');
            link.href = `https://www.qrz.com/db/${message.tx_callsign}`;
            link.textContent = message.tx_callsign;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            cellTxCall.appendChild(link);
        } else {
            cellTxCall.textContent = '-';
        }
        cellTxCall.className = 'ft8-cell-tx-callsign';
        
        // Message
        const cellMsg = row.insertCell(9);
        cellMsg.textContent = message.message;
        cellMsg.className = 'ft8-cell-message';
        
        // Highlight CQ messages
        if (message.message.startsWith('CQ')) {
            cellMsg.classList.add('ft8-message-cq');
        }
        
        // Slot number
        const cellSlot = row.insertCell(10);
        cellSlot.textContent = message.slot_number;
        cellSlot.className = 'ft8-cell-slot';
        
        // Apply filters to this row only (efficient - no iteration through all rows)
        let shouldShow = true;
        
        // Filter by latest cycle only
        if (this.config.show_latest_only && this.currentSlot > 0 && message.slot_number !== this.currentSlot) {
            shouldShow = false;
        }
        
        // Filter by CQ only
        if (shouldShow && this.config.show_cq_only && !message.message.startsWith('CQ')) {
            shouldShow = false;
        }
        
        // Filter by message text or country
        if (shouldShow && this.messageFilter) {
            const matchesMessage = message.message.toLowerCase().includes(this.messageFilter);
            const matchesCountry = message.country && message.country.toLowerCase().includes(this.messageFilter);
            if (!matchesMessage && !matchesCountry) {
                shouldShow = false;
            }
        }
        
        // Show or hide the row
        row.style.display = shouldShow ? '' : 'none';
        
        // If sorting is active, re-sort the table to place new message in correct position
        if (this.sortColumn !== null) {
            this.sortTable(this.sortColumn);
        }
        
        // Auto-scroll to top if enabled (only if not sorting, as sorting changes scroll position)
        if (this.autoScroll && this.sortColumn === null) {
            const container = tbody.parentElement.parentElement;
            if (container) {
                container.scrollTop = 0;
            }
        }
    }

    clearMessages() {
        this.messages = [];
        this.totalDecoded = 0;
        this.slotDecoded = 0;
        
        const tbody = document.getElementById('ft8-messages-tbody');
        if (tbody) {
            tbody.innerHTML = '';
        }
        
        this.updateCounters();
    }

    filterMessages() {
        // Efficiently filter by hiding/showing rows instead of recreating DOM
        const tbody = document.getElementById('ft8-messages-tbody');
        if (!tbody) return;

        const rows = tbody.getElementsByTagName('tr');
        
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const countryCell = row.cells[6]; // Country column is at index 6
            const messageCell = row.cells[9]; // Message column is at index 9
            const slotCell = row.cells[10]; // Slot column is at index 10
            
            if (!messageCell || !slotCell) continue;
            
            const messageText = messageCell.textContent.toLowerCase();
            const countryText = countryCell ? countryCell.textContent.toLowerCase() : '';
            const slotNumber = parseInt(slotCell.textContent);
            
            let shouldShow = true;
            
            // Filter by latest cycle only
            if (this.config.show_latest_only && this.currentSlot > 0 && slotNumber !== this.currentSlot) {
                shouldShow = false;
            }
            
            // Filter by CQ only
            if (shouldShow && this.config.show_cq_only && !messageCell.textContent.startsWith('CQ')) {
                shouldShow = false;
            }
            
            // Filter by message text or country
            if (shouldShow && this.messageFilter) {
                const matchesMessage = messageText.includes(this.messageFilter);
                const matchesCountry = countryText.includes(this.messageFilter);
                if (!matchesMessage && !matchesCountry) {
                    shouldShow = false;
                }
            }
            
            // Show or hide the row
            row.style.display = shouldShow ? '' : 'none';
        }
    }

    exportMessages() {
        if (this.messages.length === 0) {
            alert('No messages to export');
            return;
        }
        
        // Create CSV content
        let csv = 'UTC,SNR,DeltaT,Frequency,Distance_km,Bearing_deg,Country,Continent,TX_Callsign,Callsign,Locator,Message,Protocol,Slot\n';

        for (const msg of this.messages) {
            const dist = msg.distance_km !== undefined && msg.distance_km !== null ? msg.distance_km.toFixed(1) : '';
            const brg = msg.bearing_deg !== undefined && msg.bearing_deg !== null ? msg.bearing_deg.toFixed(1) : '';
            const country = msg.country || '';
            const continent = msg.continent || '';
            const txCallsign = msg.tx_callsign || '';
            const callsign = msg.callsign || '';
            const locator = msg.locator || '';
            csv += `${msg.utc},${msg.snr},${msg.delta_t},${msg.frequency},${dist},${brg},"${country}","${continent}","${txCallsign}","${callsign}","${locator}","${msg.message}",${msg.protocol},${msg.slot_number}\n`;
        }
        
        // Download as file
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ft8_log_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    updateCounters() {
        const decodeCount = document.getElementById('ft8-decode-count');
        const slotCount = document.getElementById('ft8-slot-count');
        const candidateCount = document.getElementById('ft8-candidate-count');
        const ldpcFailures = document.getElementById('ft8-ldpc-failures');
        const crcFailures = document.getElementById('ft8-crc-failures');

        if (decodeCount) {
            decodeCount.textContent = this.totalDecoded;
        }
        if (slotCount) {
            slotCount.textContent = this.slotDecoded;
        }
        if (candidateCount) {
            candidateCount.textContent = this.candidateCount;
        }
        if (ldpcFailures) {
            ldpcFailures.textContent = this.ldpcFailures;
        }
        if (crcFailures) {
            crcFailures.textContent = this.crcFailures;
        }

        // Update totals display in status bar
        this.updateTotalsDisplay();
    }

    updateTotalsDisplay() {
        const totalsDisplay = document.getElementById('ft8-totals-display');
        if (totalsDisplay) {
            totalsDisplay.textContent = `Total: ${this.messages.length} | Slot: ${this.slotDecoded}`;
        }
    }

    updateProtocolDisplay() {
        const protocolDisplay = document.getElementById('ft8-protocol-display');
        if (protocolDisplay) {
            protocolDisplay.textContent = this.config.protocol;
        }
    }

    updateSlotDisplay(slotNumber) {
        const slotDisplay = document.getElementById('ft8-slot-display');
        if (slotDisplay) {
            slotDisplay.textContent = `Slot: ${slotNumber}`;
        }
    }

    updateSyncDisplay(synced) {
        const syncDisplay = document.getElementById('ft8-sync-display');
        if (syncDisplay) {
            if (synced) {
                syncDisplay.textContent = 'Sync: OK';
                syncDisplay.className = 'ft8-sync ft8-sync-ok';
            } else {
                syncDisplay.textContent = 'Sync: Waiting...';
                syncDisplay.className = 'ft8-sync';
            }
        }
    }

    updateStatus(text, badgeClass) {
        const statusBadge = document.getElementById('ft8-status-badge');
        if (statusBadge) {
            statusBadge.textContent = text;
            statusBadge.className = `status-badge ${badgeClass}`;
        }
    }

    updateUI() {
        const startBtn = document.getElementById('ft8-start-btn');
        const stopBtn = document.getElementById('ft8-stop-btn');
        
        if (startBtn) {
            startBtn.disabled = this.running;
        }
        if (stopBtn) {
            stopBtn.disabled = !this.running;
        }
    }

    tuneToFrequency(freq, mode, protocol) {
        console.log(`FT8: Tuning to ${freq} Hz, mode ${mode}, protocol ${protocol}`);

        // Set protocol dropdown if provided
        if (protocol) {
            const protocolSelect = document.getElementById('ft8-protocol-select');
            if (protocolSelect && protocolSelect.value !== protocol) {
                protocolSelect.value = protocol;
                this.config.protocol = protocol;
                this.updateProtocolDisplay();
            }
        }

        // Set frequency using the global function
        if (window.setFrequency) {
            window.setFrequency(freq);
        }

        // Set mode to USB
        if (window.setMode) {
            window.setMode('usb');
        }

        // Set bandwidth for FT8/FT4 (0 Hz low, 3200 Hz high)
        const bandwidthLowSlider = document.getElementById('bandwidth-low');
        const bandwidthHighSlider = document.getElementById('bandwidth-high');

        if (bandwidthLowSlider) {
            bandwidthLowSlider.value = 0;
            document.getElementById('bandwidth-low-value').textContent = '0';
            window.currentBandwidthLow = 0;
        }

        if (bandwidthHighSlider) {
            bandwidthHighSlider.value = 3200;
            document.getElementById('bandwidth-high-value').textContent = '3200';
            window.currentBandwidthHigh = 3200;
        }

        // Trigger bandwidth update
        if (window.updateBandwidth) {
            window.updateBandwidth();
        }
    }

    onDetach() {
        console.log('FT8: Extension detached');
        this.removeBinaryMessageHandler();
        this.running = false;
        this.updateUI();
        this.updateStatus('Stopped', 'status-disconnected');
    }

    onBinaryData(data) {
        // Alias for onBinaryMessage to match DecoderExtension interface
        this.onBinaryMessage(data);
    }

    onProcessAudio(dataArray) {
        // FT8 processes audio on the backend (Go side) via the audio extension framework
        // Draw spectrum visualization (always, even when stopped)
        this.drawSpectrum(dataArray);
    }

    drawSpectrum(dataArray) {
        if (!this.spectrumCanvas || !this.spectrumCtx) return;

        const ctx = this.spectrumCtx;
        const canvas = this.spectrumCanvas;
        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);

        // Get frequency data
        const analyser = this.radio.getAnalyser();
        if (!analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const freqData = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(freqData);

        // Calculate frequency range to display (0-3000 Hz)
        const sampleRate = window.audioContext ? window.audioContext.sampleRate : 48000;
        const nyquist = sampleRate / 2;
        const maxDisplayFreq = 3000;
        const binWidth = nyquist / bufferLength;
        const maxBin = Math.min(bufferLength, Math.floor(maxDisplayFreq / binWidth));

        // Draw spectrum bars
        const barWidth = width / maxBin;
        ctx.fillStyle = '#4a9eff';

        for (let i = 0; i < maxBin; i++) {
            const barHeight = (freqData[i] / 255) * height;
            const x = i * barWidth;
            const y = height - barHeight;

            // Color based on intensity
            const intensity = freqData[i] / 255;
            if (intensity > 0.7) {
                ctx.fillStyle = '#FF5722';
            } else if (intensity > 0.4) {
                ctx.fillStyle = '#FFC107';
            } else {
                ctx.fillStyle = '#4a9eff';
            }

            ctx.fillRect(x, y, barWidth, barHeight);
        }

        // Draw frequency scale at bottom
        ctx.fillStyle = '#666';
        ctx.font = '9px monospace';
        for (let freq = 0; freq <= maxDisplayFreq; freq += 500) {
            const x = (freq / maxDisplayFreq) * width;
            ctx.fillText(freq + 'Hz', x + 2, height - 5);
        }

        // Draw callsigns from latest cycle
        if (this.currentSlot > 0) {
            // Get messages from the current slot and sort by frequency
            const currentSlotMessages = this.messages
                .filter(msg => msg.slot_number === this.currentSlot && msg.tx_callsign && msg.tx_callsign !== '-' && msg.frequency)
                .sort((a, b) => a.frequency - b.frequency);

            // Draw each callsign at its frequency position
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';

            // Track used positions to avoid overlapping labels
            const usedPositions = [];
            const minHorizontalSpacing = 50; // Minimum pixels between labels horizontally
            const verticalSpacing = 14; // Vertical spacing between stacked labels

            for (const msg of currentSlotMessages) {
                const freq = msg.frequency;
                const x = (freq / maxDisplayFreq) * width;
                const callsign = msg.tx_callsign;
                const textWidth = ctx.measureText(callsign).width;

                // Find appropriate vertical position to avoid overlaps
                let yOffset = 15;
                let foundPosition = false;

                // Try different vertical positions until we find one that doesn't overlap
                while (!foundPosition && yOffset < height - 20) {
                    let overlaps = false;

                    // Check if this position overlaps with any existing label
                    for (const usedPos of usedPositions) {
                        const horizontalDistance = Math.abs(usedPos.x - x);
                        const verticalDistance = Math.abs(usedPos.y - yOffset);

                        // Check for overlap: labels are too close horizontally AND vertically
                        if (horizontalDistance < minHorizontalSpacing && verticalDistance < verticalSpacing) {
                            overlaps = true;
                            break;
                        }
                    }

                    if (!overlaps) {
                        foundPosition = true;
                    } else {
                        yOffset += verticalSpacing;
                    }
                }

                // If we ran out of vertical space, wrap back to the top
                if (yOffset >= height - 20) {
                    yOffset = 15;
                }

                // Draw vertical line from bottom to label
                ctx.strokeStyle = '#4caf50';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, height - 15);
                ctx.lineTo(x, yOffset + 10);
                ctx.stroke();

                // Draw background rectangle
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(x - textWidth / 2 - 2, yOffset - 10, textWidth + 4, 12);

                // Draw callsign text
                ctx.fillStyle = '#4caf50';
                ctx.fillText(callsign, x, yOffset);

                // Track this position
                usedPositions.push({ x: x, y: yOffset, width: textWidth });
            }

            // Reset text alignment
            ctx.textAlign = 'left';
        }
    }

    onEnable() {
        console.log('FT8: Extension enabled');
        this.setupBinaryMessageHandler();
    }

    onDisable() {
        console.log('FT8: Extension disabled');
        
        if (this.running) {
            this.stop();
        }
        
        this.removeBinaryMessageHandler();
    }
}

// Register the extension
let ft8ExtensionInstance = null;

if (window.decoderManager) {
    ft8ExtensionInstance = new FT8Extension();
    window.decoderManager.register(ft8ExtensionInstance);
    console.log('FT8 extension registered:', ft8ExtensionInstance);
} else {
    console.error('FT8: decoderManager not available - extension cannot be registered');
}

// Expose instance globally for debugging
window.ft8ExtensionInstance = ft8ExtensionInstance;
