// MIDI Control JavaScript for UberSDR Go Client

class MIDIControl {
    constructor(client) {
        this.client = client;
        this.connected = false;
        this.devices = [];
        this.mappings = [];
        this.learnMode = false;
        
        this.initializeElements();
        this.attachEventListeners();
        
        // Load config after a short delay to ensure everything is initialized
        setTimeout(() => this.loadConfig(), 500);
    }

    initializeElements() {
        // MIDI control elements
        this.midiEnabled = document.getElementById('midi-enabled');
        this.midiControls = document.getElementById('midi-controls');
        this.midiDeviceSelect = document.getElementById('midi-device-select');
        this.midiRefreshDevicesBtn = document.getElementById('midi-refresh-devices-btn');
        this.midiConnectBtn = document.getElementById('midi-connect-btn');
        this.midiDisconnectBtn = document.getElementById('midi-disconnect-btn');
        
        // MIDI status elements
        this.midiStatusDisplay = document.getElementById('midi-status-display');
        this.midiConnectionStatus = document.getElementById('midi-connection-status');
        this.midiDeviceName = document.getElementById('midi-device-name');
        this.midiMappingCount = document.getElementById('midi-mapping-count');
        this.midiLearnStatus = document.getElementById('midi-learn-status');
        
        // MIDI mappings elements
        this.midiMappingsSection = document.getElementById('midi-mappings-section');
        this.midiLearnBtn = document.getElementById('midi-learn-btn');
        this.midiStopLearnBtn = document.getElementById('midi-stop-learn-btn');
        this.midiClearMappingsBtn = document.getElementById('midi-clear-mappings-btn');
        this.midiLearnPanel = document.getElementById('midi-learn-panel');
        this.midiLearnFunction = document.getElementById('midi-learn-function');
        this.midiLearnMapBoth = document.getElementById('midi-learn-map-both');
        this.midiLearnMessage = document.getElementById('midi-learn-message');
        this.midiMappingsTbody = document.getElementById('midi-mappings-tbody');
    }

    attachEventListeners() {
        // Enable/disable MIDI
        this.midiEnabled.addEventListener('change', () => {
            if (this.midiEnabled.checked) {
                this.midiControls.style.display = 'block';
                this.refreshDevices();
            } else {
                this.midiControls.style.display = 'none';
                if (this.connected) {
                    this.disconnect();
                }
            }
        });

        // Refresh devices
        this.midiRefreshDevicesBtn.addEventListener('click', () => {
            this.refreshDevices();
        });

        // Device selection
        this.midiDeviceSelect.addEventListener('change', () => {
            this.midiConnectBtn.disabled = !this.midiDeviceSelect.value;
        });

        // Connect/disconnect
        this.midiConnectBtn.addEventListener('click', () => {
            this.connect();
        });

        this.midiDisconnectBtn.addEventListener('click', () => {
            this.disconnect();
        });

        // Learn mode
        this.midiLearnBtn.addEventListener('click', () => {
            this.startLearnMode();
        });

        this.midiStopLearnBtn.addEventListener('click', () => {
            this.stopLearnMode();
        });

        // Function selection in learn mode
        this.midiLearnFunction.addEventListener('change', async () => {
            if (this.midiLearnFunction.value && this.learnModeUIActive) {
                // Now that function is selected, actually start learn mode on backend
                try {
                    const response = await fetch(`${this.client.apiBase}/api/midi/learn/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            function: this.midiLearnFunction.value,
                            mapBoth: this.midiLearnMapBoth.checked
                        })
                    });

                    const data = await response.json();
                    
                    if (data.success) {
                        this.learnMode = true;
                        this.midiLearnMessage.textContent = 'Now press/turn a control on your MIDI device...';
                        this.midiLearnMessage.style.color = '#1976D2';
                    } else {
                        this.midiLearnMessage.textContent = 'Failed to start learn mode: ' + (data.message || 'Unknown error');
                        this.midiLearnMessage.style.color = '#ef4444';
                    }
                } catch (error) {
                    console.error('Failed to start learn mode:', error);
                    this.midiLearnMessage.textContent = 'Error starting learn mode: ' + error.message;
                    this.midiLearnMessage.style.color = '#ef4444';
                }
            }
        });

        // Clear mappings
        this.midiClearMappingsBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all MIDI mappings?')) {
                this.clearMappings();
            }
        });
    }

    async refreshDevices() {
        try {
            const response = await fetch(`${this.client.apiBase}/api/midi/devices`);
            const data = await response.json();
            
            this.devices = data.devices || [];
            this.updateDeviceList();
        } catch (error) {
            console.error('Failed to refresh MIDI devices:', error);
            this.client.showError('MIDI Error', 'Failed to refresh MIDI devices');
        }
    }

    updateDeviceList() {
        // Clear existing options
        this.midiDeviceSelect.innerHTML = '<option value="">-- Select MIDI Device --</option>';
        
        // Add devices
        this.devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.name;
            option.textContent = device.name;
            this.midiDeviceSelect.appendChild(option);
        });

        if (this.devices.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No MIDI devices found';
            option.disabled = true;
            this.midiDeviceSelect.appendChild(option);
        }
    }

    async connect() {
        const deviceName = this.midiDeviceSelect.value;
        if (!deviceName) return;

        try {
            const response = await fetch(`${this.client.apiBase}/api/midi/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceName })
            });

            const data = await response.json();
            
            if (data.success) {
                this.connected = true;
                this.updateConnectionStatus();
                this.loadMappings();
                this.client.showSuccess(`Connected to MIDI device: ${deviceName}`);
            } else {
                throw new Error(data.message || 'Connection failed');
            }
        } catch (error) {
            console.error('Failed to connect to MIDI device:', error);
            this.client.showError('MIDI Connection Error', error.message);
        }
    }

    async disconnect() {
        try {
            const response = await fetch(`${this.client.apiBase}/api/midi/disconnect`, {
                method: 'POST'
            });

            const data = await response.json();
            
            if (data.success) {
                this.connected = false;
                this.updateConnectionStatus();
                this.client.showSuccess('Disconnected from MIDI device');
            }
        } catch (error) {
            console.error('Failed to disconnect from MIDI device:', error);
            this.client.showError('MIDI Error', 'Failed to disconnect from MIDI device');
        }
    }

    updateConnectionStatus() {
        if (this.connected) {
            this.midiConnectionStatus.textContent = 'Connected';
            this.midiConnectionStatus.className = 'status-badge connected';
            this.midiDeviceName.textContent = this.midiDeviceSelect.value;
            this.midiConnectBtn.disabled = true;
            this.midiDisconnectBtn.disabled = false;
            this.midiDeviceSelect.disabled = true;
            this.midiStatusDisplay.style.display = 'block';
            this.midiMappingsSection.style.display = 'block';
        } else {
            this.midiConnectionStatus.textContent = 'Disconnected';
            this.midiConnectionStatus.className = 'status-badge disconnected';
            this.midiDeviceName.textContent = '-';
            this.midiMappingCount.textContent = '0';
            this.midiConnectBtn.disabled = !this.midiDeviceSelect.value;
            this.midiDisconnectBtn.disabled = true;
            this.midiDeviceSelect.disabled = false;
            this.midiStatusDisplay.style.display = 'none';
            this.midiMappingsSection.style.display = 'none';
            this.stopLearnMode();
        }
    }

    async loadMappings() {
        try {
            const response = await fetch(`${this.client.apiBase}/api/midi/mappings`);
            const data = await response.json();
            
            this.mappings = data.mappings || [];
            console.log('Loaded MIDI mappings:', this.mappings);
            if (this.mappings.length > 0) {
                console.log('First mapping structure:', JSON.stringify(this.mappings[0], null, 2));
            }
            this.updateMappingsTable();
            this.midiMappingCount.textContent = this.mappings.length;
        } catch (error) {
            console.error('Failed to load MIDI mappings:', error);
        }
    }

    updateMappingsTable() {
        if (this.mappings.length === 0) {
            this.midiMappingsTbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; color: #999;">
                        No mappings configured. Use Learn Mode to add mappings.
                    </td>
                </tr>
            `;
            return;
        }

        this.midiMappingsTbody.innerHTML = '';
        
        this.mappings.forEach(mapping => {
            const row = document.createElement('tr');
            
            // MIDI Control - handle both Key and key field names
            const controlCell = document.createElement('td');
            const key = mapping.Key || mapping.key;
            controlCell.textContent = this.formatMIDIKey(key);
            row.appendChild(controlCell);
            
            // Function - handle both Function and function field names
            const functionCell = document.createElement('td');
            functionCell.textContent = mapping.Function || mapping.function;
            row.appendChild(functionCell);
            
            // Throttle - handle both ThrottleMs and throttleMs
            const throttleCell = document.createElement('td');
            const throttleMs = mapping.ThrottleMs !== undefined ? mapping.ThrottleMs : mapping.throttleMs;
            throttleCell.textContent = throttleMs ? `${throttleMs} ms` : 'None';
            row.appendChild(throttleCell);
            
            // Mode - handle both Mode and mode
            const modeCell = document.createElement('td');
            modeCell.textContent = mapping.Mode || mapping.mode || '-';
            row.appendChild(modeCell);
            
            // Actions
            const actionsCell = document.createElement('td');
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'btn btn-small';
            deleteBtn.onclick = () => this.deleteMapping(key);
            actionsCell.appendChild(deleteBtn);
            row.appendChild(actionsCell);
            
            this.midiMappingsTbody.appendChild(row);
        });
    }

    formatMIDIKey(key) {
        console.log('formatMIDIKey called with:', key);
        
        let type, channel, data1;
        
        // Check if key is a string in format "type:channel:data1"
        if (typeof key === 'string') {
            const parts = key.split(':');
            if (parts.length === 3) {
                type = parseInt(parts[0]);
                channel = parseInt(parts[1]);
                data1 = parseInt(parts[2]);
            }
        } else {
            // Handle object format
            type = key.Type || key.type;
            channel = (key.Channel !== undefined ? key.Channel : key.channel);
            data1 = key.Data1 !== undefined ? key.Data1 : key.data1;
        }
        
        console.log('Extracted values - type:', type, 'channel:', channel, 'data1:', data1);
        
        // Display channel as 1-16 (add 1 to 0-indexed channel)
        const displayChannel = (channel !== undefined && channel !== null) ? channel + 1 : 'N/A';
        
        if (type === 144 || type === 0x90) { // Note On
            return `Note ${data1} (Ch ${displayChannel})`;
        } else if (type === 128 || type === 0x80) { // Note Off
            return `Note Off ${data1} (Ch ${displayChannel})`;
        } else if (type === 176 || type === 0xB0) { // CC
            return `CC ${data1} (Ch ${displayChannel})`;
        } else {
            return `Type ${type} Data ${data1} (Ch ${displayChannel})`;
        }
    }

    async deleteMapping(key) {
        try {
            let type, channel, data1;
            
            // Check if key is a string in format "type:channel:data1"
            if (typeof key === 'string') {
                const parts = key.split(':');
                if (parts.length === 3) {
                    type = parseInt(parts[0]);
                    channel = parseInt(parts[1]);
                    data1 = parseInt(parts[2]);
                }
            } else {
                // Handle object format
                type = key.Type || key.type;
                channel = key.Channel !== undefined ? key.Channel : key.channel;
                data1 = key.Data1 !== undefined ? key.Data1 : key.data1;
            }
            
            const response = await fetch(
                `${this.client.apiBase}/api/midi/mappings/${type}/${channel}/${data1}`,
                { method: 'DELETE' }
            );

            const data = await response.json();
            
            if (data.success) {
                this.loadMappings();
                this.client.showSuccess('Mapping deleted');
            }
        } catch (error) {
            console.error('Failed to delete mapping:', error);
            this.client.showError('MIDI Error', 'Failed to delete mapping');
        }
    }

    async clearMappings() {
        // Delete all mappings one by one
        for (const mapping of this.mappings) {
            await this.deleteMapping(mapping.key);
        }
        this.loadMappings();
    }

    async startLearnMode() {
        // Show the learn panel first so user can select a function
        this.midiLearnPanel.style.display = 'block';
        this.midiLearnBtn.style.display = 'none';
        this.midiStopLearnBtn.style.display = 'inline-block';
        this.midiStopLearnBtn.disabled = false;
        this.midiLearnStatus.textContent = 'Active';
        this.midiLearnStatus.className = 'status-badge connected';
        this.midiLearnMessage.textContent = 'Select a function above, then press/turn a control on your MIDI device...';
        this.midiLearnMessage.style.color = '#666';
        
        // Set up a flag to track if we've sent the learn request
        this.learnModeUIActive = true;
        this.learnMode = false; // Backend not in learn mode yet
    }

    async stopLearnMode() {
        // Stop backend learn mode if it was started
        if (this.learnMode) {
            try {
                await fetch(`${this.client.apiBase}/api/midi/learn/stop`, {
                    method: 'POST'
                });
            } catch (error) {
                console.error('Failed to stop learn mode:', error);
            }
        }

        // Reset UI state
        this.learnMode = false;
        this.learnModeUIActive = false;
        this.midiLearnPanel.style.display = 'none';
        this.midiLearnBtn.style.display = 'inline-block';
        this.midiStopLearnBtn.style.display = 'none';
        this.midiLearnStatus.textContent = 'Inactive';
        this.midiLearnStatus.className = 'status-badge';
        this.midiLearnFunction.value = '';
        this.midiLearnMapBoth.checked = false;
        
        // Reload mappings to show any new ones
        this.loadMappings();
    }

    handleLearnModeUpdate(data) {
        if (data.type === 'midi_learn_captured') {
            this.midiLearnMessage.textContent = data.message;
            this.midiLearnMessage.style.color = '#1976D2';
        } else if (data.type === 'midi_learn_completed') {
            this.midiLearnMessage.textContent = data.message;
            this.midiLearnMessage.style.color = '#22c55e';
            
            // Auto-stop learn mode after successful mapping
            setTimeout(() => {
                this.stopLearnMode();
            }, 2000);
        }
    }

    async loadConfig() {
        try {
            console.log('Loading MIDI config...');
            // Load MIDI status to check if it's enabled and connected
            const response = await fetch(`${this.client.apiBase}/api/midi/status`);
            const data = await response.json();
            console.log('MIDI status:', data);
            
            // If MIDI is connected, enable the checkbox and show controls
            if (data.connected) {
                console.log('MIDI is connected, enabling UI...');
                this.midiEnabled.checked = true;
                this.midiControls.style.display = 'block';
                this.connected = true;
                
                // Load devices and select the connected one
                await this.refreshDevices();
                if (data.device_name) {
                    console.log('Setting device select to:', data.device_name);
                    this.midiDeviceSelect.value = data.device_name;
                }
                
                this.updateConnectionStatus();
                this.loadMappings();
                console.log('MIDI config loaded successfully');
            } else {
                console.log('MIDI not connected');
            }
        } catch (error) {
            console.error('Failed to load MIDI config:', error);
        }
    }

    async updateStatus() {
        try {
            const response = await fetch(`${this.client.apiBase}/api/midi/status`);
            const data = await response.json();
            
            if (data.connected !== this.connected) {
                this.connected = data.connected;
                this.updateConnectionStatus();
                
                if (this.connected) {
                    this.loadMappings();
                }
            }
            
            if (data.learning_mode !== this.learnMode) {
                this.learnMode = data.learning_mode;
                if (!this.learnMode) {
                    this.stopLearnMode();
                }
            }
        } catch (error) {
            // Silently fail - MIDI might not be available
        }
    }
}