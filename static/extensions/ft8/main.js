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
            show_cq_only: false
        };

        // State
        this.running = false;
        this.messages = []; // Array of decoded messages
        this.totalDecoded = 0;
        this.currentSlot = 0;
        this.slotDecoded = 0;
        this.autoScroll = true;
        this.lastSyncTime = null;
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

        // Min score input
        const minScoreInput = document.getElementById('ft8-min-score');
        if (minScoreInput) {
            minScoreInput.value = this.config.min_score;
            minScoreInput.addEventListener('change', (e) => {
                this.config.min_score = parseInt(e.target.value) || 10;
            });
        }

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

        // Frequency selector
        const freqSelect = document.getElementById('ft8-frequency-select');
        if (freqSelect) {
            freqSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    const [freq, mode] = e.target.value.split(',');
                    this.tuneToFrequency(parseInt(freq), mode);
                }
            });
        }

        console.log('FT8: Event handlers setup complete');
    }

    start() {
        console.log('FT8: Starting decoder');
        
        const params = {
            protocol: this.config.protocol,
            min_score: this.config.min_score,
            max_candidates: this.config.max_candidates
        };

        this.attachExtension(params);
        this.running = true;
        this.updateUI();
        this.updateStatus('Running', 'status-connected');
    }

    stop() {
        console.log('FT8: Stopping decoder');
        this.detachExtension();
        this.running = false;
        this.updateUI();
        this.updateStatus('Stopped', 'status-disconnected');
    }

    onBinaryMessage(data) {
        try {
            // Parse JSON message from decoder
            const decoder = new TextDecoder();
            const message = JSON.parse(decoder.decode(data));
            
            console.log('FT8: Decoded message:', message);
            
            // Add to messages array
            this.messages.push(message);
            this.totalDecoded++;
            this.slotDecoded++;
            
            // Update slot if changed
            if (message.slot_number !== this.currentSlot) {
                this.currentSlot = message.slot_number;
                this.slotDecoded = 1;
                
                // Auto-clear old messages if enabled
                if (this.config.auto_clear && this.messages.length > 100) {
                    this.messages = this.messages.slice(-100);
                }
            }
            
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

        // Filter if CQ only mode
        if (this.config.show_cq_only && !message.message.startsWith('CQ')) {
            return;
        }

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
        
        // Message
        const cellMsg = row.insertCell(4);
        cellMsg.textContent = message.message;
        cellMsg.className = 'ft8-cell-message';
        
        // Highlight CQ messages
        if (message.message.startsWith('CQ')) {
            cellMsg.classList.add('ft8-message-cq');
        }
        
        // Slot number
        const cellSlot = row.insertCell(5);
        cellSlot.textContent = message.slot_number;
        cellSlot.className = 'ft8-cell-slot';
        
        // Auto-scroll to top if enabled
        if (this.autoScroll) {
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
        // Re-render table with current filter
        const tbody = document.getElementById('ft8-messages-tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        // Add messages in reverse order (newest first)
        for (let i = this.messages.length - 1; i >= 0; i--) {
            this.addMessageToTable(this.messages[i]);
        }
    }

    exportMessages() {
        if (this.messages.length === 0) {
            alert('No messages to export');
            return;
        }
        
        // Create CSV content
        let csv = 'UTC,SNR,DeltaT,Frequency,Message,Protocol,Slot\n';
        
        for (const msg of this.messages) {
            csv += `${msg.utc},${msg.snr},${msg.delta_t},${msg.frequency},"${msg.message}",${msg.protocol},${msg.slot_number}\n`;
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
        
        if (decodeCount) {
            decodeCount.textContent = this.totalDecoded;
        }
        if (slotCount) {
            slotCount.textContent = this.slotDecoded;
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

    tuneToFrequency(freq, mode) {
        console.log(`FT8: Tuning to ${freq} Hz, mode ${mode}`);
        // This would call the radio tuning API
        // For now, just log it
        if (window.radioControl && window.radioControl.setFrequency) {
            window.radioControl.setFrequency(freq);
            window.radioControl.setMode(mode);
        }
    }

    onDetach() {
        console.log('FT8: Extension detached');
        this.running = false;
        this.updateUI();
        this.updateStatus('Stopped', 'status-disconnected');
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
