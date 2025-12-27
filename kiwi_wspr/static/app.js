let config = {};
let statusData = null;
let kiwiStatusData = {};

async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        console.log('Loaded config:', config);
        updateUI();
    } catch (e) {
        showAlert('Failed to load configuration: ' + e.message, 'error');
    }
}

async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        statusData = await response.json();
        updateStatusIndicators();
    } catch (e) {
        console.error('Failed to load status:', e);
    }
}

async function loadKiwiStatus() {
    try {
        const response = await fetch('/api/kiwi/status');
        kiwiStatusData = await response.json();
        updateInstanceHeaders();
    } catch (e) {
        console.error('Failed to load KiwiSDR status:', e);
    }
}

function updateStatusIndicators() {
    if (!statusData) return;
    
    // Update MQTT status indicator
    updateMQTTStatus();
    
    // Update band status indicators
    updateBandStatuses();
}

function updateMQTTStatus() {
    const mqttStatusEl = document.getElementById('mqtt-status-indicator');
    if (!mqttStatusEl) return;
    
    const isConnected = statusData.mqtt && statusData.mqtt.connected;
    const isEnabled = statusData.mqtt && statusData.mqtt.enabled;
    
    if (isEnabled && isConnected) {
        mqttStatusEl.innerHTML = '<span style="color: #28a745; font-size: 20px;">●</span> Connected';
        mqttStatusEl.style.color = '#28a745';
    } else if (isEnabled && !isConnected) {
        mqttStatusEl.innerHTML = '<span style="color: #dc3545; font-size: 20px;">●</span> Disconnected';
        mqttStatusEl.style.color = '#dc3545';
    } else {
        mqttStatusEl.innerHTML = '<span style="color: #6c757d; font-size: 20px;">●</span> Disabled';
        mqttStatusEl.style.color = '#6c757d';
    }
}

function updateBandStatuses() {
    if (!statusData || !statusData.bands) return;
    
    // Create a map of band statuses by name
    const bandStatusMap = {};
    statusData.bands.forEach(band => {
        bandStatusMap[band.name] = band;
    });
    
    // Update each band's status indicator in the UI
    config.WSPRBands?.forEach((band, idx) => {
        const bandStatus = bandStatusMap[band.Name];
        if (!bandStatus) return;
        
        // Find the band element and update its status
        const bandElements = document.querySelectorAll('.item');
        bandElements.forEach(el => {
            const bandNameEl = el.querySelector('strong');
            if (bandNameEl && bandNameEl.textContent.includes(band.Name)) {
                // Remove existing status indicator if present
                let statusIndicator = el.querySelector('.connection-status');
                if (!statusIndicator) {
                    statusIndicator = document.createElement('span');
                    statusIndicator.className = 'connection-status';
                    statusIndicator.style.marginLeft = '10px';
                    bandNameEl.parentNode.insertBefore(statusIndicator, bandNameEl.nextSibling);
                }
                
                // Update status indicator based on state
                const state = bandStatus.state || 'disabled';
                
                if (state === 'connected') {
                    // Green dot - successfully recording
                    const decodeInfo = bandStatus.last_decode_time
                        ? ` (${bandStatus.last_decode_count} spots, ${formatTimeAgo(bandStatus.last_decode_time)})`
                        : ' (waiting for decode)';
                    statusIndicator.innerHTML = `<span style="color: #28a745; font-size: 16px;">●</span>${decodeInfo}`;
                } else if (state === 'waiting') {
                    // Orange dot - coordinator started, waiting for first recording
                    statusIndicator.innerHTML = '<span style="color: #ff8c00; font-size: 16px;">●</span> (waiting)';
                } else if (state === 'failed') {
                    // Red dot - recording failed
                    const errorMsg = bandStatus.error ? ` - ${bandStatus.error}` : '';
                    const errorTitle = bandStatus.error ? ` title="${bandStatus.error}"` : '';
                    statusIndicator.innerHTML = `<span style="color: #dc3545; font-size: 16px;"${errorTitle}>●</span> (failed${errorMsg})`;
                } else {
                    // No indicator for disabled bands
                    statusIndicator.innerHTML = '';
                }
            }
        });
    });
}

function formatTimeAgo(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function updateUI() {
    document.getElementById('mqtt-enabled').checked = config.MQTT.Enabled || false;
    document.getElementById('mqtt-host').value = config.MQTT.Host || 'localhost';
    document.getElementById('mqtt-port').value = config.MQTT.Port || 1883;
    document.getElementById('mqtt-use-tls').checked = config.MQTT.UseTLS || false;
    document.getElementById('mqtt-prefix').value = config.MQTT.TopicPrefix || '';
    document.getElementById('mqtt-username').value = config.MQTT.Username || '';
    document.getElementById('mqtt-password').value = config.MQTT.Password || '';
    document.getElementById('mqtt-qos').value = config.MQTT.QoS !== undefined ? config.MQTT.QoS : 0;
    document.getElementById('mqtt-retain').checked = config.MQTT.Retain || false;
    
    updateInstancesAndBands();
}

function updateInstancesAndBands() {
    const container = document.getElementById('instances-container');
    container.innerHTML = '';
    
    if (!config.KiwiInstances || config.KiwiInstances.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No instances configured</div>';
        return;
    }
    
    config.KiwiInstances.forEach((inst, instIdx) => {
        // Create instance card
        const instanceCard = document.createElement('div');
        instanceCard.style.marginBottom = '20px';
        instanceCard.style.border = '2px solid #ddd';
        instanceCard.style.borderRadius = '8px';
        instanceCard.style.padding = '15px';
        instanceCard.style.backgroundColor = inst.Enabled ? '#fff' : '#f5f5f5';
        
        // Instance header
        const instanceHeader = document.createElement('div');
        instanceHeader.style.display = 'flex';
        instanceHeader.style.justifyContent = 'space-between';
        instanceHeader.style.alignItems = 'center';
        instanceHeader.style.marginBottom = '15px';
        instanceHeader.style.paddingBottom = '10px';
        instanceHeader.style.borderBottom = '1px solid #ddd';
        
        // Get KiwiSDR status for this instance
        const kiwiStatus = kiwiStatusData[inst.Name];
        let statusLine = `${inst.Host}:${inst.Port} • User: ${inst.User}`;
        
        // Add user count if available
        if (kiwiStatus && !kiwiStatus.error && kiwiStatus.users && kiwiStatus.users_max) {
            statusLine += ` • Users: (${kiwiStatus.users}/${kiwiStatus.users_max})`;
        }
        
        // Show KiwiSDR name if available
        let kiwiNameLine = '';
        if (kiwiStatus && !kiwiStatus.error && kiwiStatus.name) {
            kiwiNameLine = `<div style="font-size: 12px; color: #888; margin-top: 3px; font-style: italic;">${kiwiStatus.name}</div>`;
        }
        
        instanceHeader.innerHTML = `
            <div>
                <h3 style="margin: 0; display: inline-block;">🌐 ${inst.Name}</h3>
                <span class="status ${inst.Enabled ? 'status-enabled' : 'status-disabled'}" style="margin-left: 10px;">
                    ${inst.Enabled ? 'Enabled' : 'Disabled'}
                </span>
                <div style="font-size: 13px; color: #666; margin-top: 5px;">
                    ${statusLine}
                </div>
                ${kiwiNameLine}
            </div>
            <div class="item-actions">
                ${kiwiStatus && !kiwiStatus.error ? `<button class="btn btn-secondary" onclick="showKiwiInfo('${inst.Name}')">Info</button>` : ''}
                <button class="btn btn-secondary" onclick="toggleInstance(${instIdx})">
                    ${inst.Enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-secondary" onclick="editInstance(${instIdx})">Edit</button>
                <button class="btn btn-danger" onclick="deleteInstance(${instIdx})">Delete</button>
            </div>
        `;
        
        instanceCard.appendChild(instanceHeader);
        
        // Get bands for this instance and sort them
        let instanceBands = config.WSPRBands ? config.WSPRBands.filter(b => b.Instance === inst.Name) : [];
        
        // Sort bands: enabled first, then by frequency
        instanceBands.sort((a, b) => {
            // First priority: enabled status (enabled bands first)
            if (a.Enabled !== b.Enabled) {
                return b.Enabled ? 1 : -1;
            }
            // Second priority: frequency (ascending)
            return a.Frequency - b.Frequency;
        });
        
        // Bands list
        const bandsContainer = document.createElement('div');
        bandsContainer.style.marginLeft = '20px';
        
        if (instanceBands.length === 0) {
            bandsContainer.innerHTML = '<div style="padding: 10px; color: #999; font-style: italic;">No bands configured for this instance</div>';
        } else {
            const bandsList = document.createElement('ul');
            bandsList.className = 'item-list';
            bandsList.style.marginTop = '10px';
            
            instanceBands.forEach(band => {
                const bandIdx = config.WSPRBands.indexOf(band);
                const li = document.createElement('li');
                li.className = 'item';
                
                // Grey out bands if instance is disabled
                const isInstanceDisabled = !inst.Enabled;
                li.style.backgroundColor = isInstanceDisabled ? '#e8e8e8' : '#f9f9f9';
                li.style.opacity = isInstanceDisabled ? '0.6' : '1';
                
                li.innerHTML = `
                    <div class="item-info">
                        <strong>📻 ${band.Name}</strong> - ${band.Frequency} kHz
                        <span class="status ${band.Enabled ? 'status-enabled' : 'status-disabled'}">
                            ${band.Enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        ${isInstanceDisabled ? '<span style="color: #999; font-size: 12px; margin-left: 10px;">(Instance Disabled)</span>' : ''}
                    </div>
                    <div class="item-actions">
                        <button class="btn ${band.Enabled ? 'btn-danger' : 'btn-success'}" onclick="toggleBand(${bandIdx})" ${isInstanceDisabled ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
                            ${band.Enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button class="btn btn-secondary" onclick="duplicateBand(${bandIdx})" ${isInstanceDisabled ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>Duplicate</button>
                        <button class="btn btn-danger" onclick="deleteBand(${bandIdx})" ${isInstanceDisabled ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>Delete</button>
                    </div>
                `;
                bandsList.appendChild(li);
            });
            
            bandsContainer.appendChild(bandsList);
        }
        
        // Button container for instance actions
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginTop = '10px';
        buttonContainer.style.marginLeft = '20px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.flexWrap = 'wrap';
        
        // Add band button for this instance
        const addBandBtn = document.createElement('button');
        addBandBtn.className = 'btn btn-success';
        addBandBtn.textContent = '+ Add Band to ' + inst.Name;
        
        // Enable All button
        const enableAllBtn = document.createElement('button');
        enableAllBtn.className = 'btn btn-primary';
        enableAllBtn.textContent = '✓ Enable All Bands';
        enableAllBtn.onclick = () => enableAllBands(inst.Name);
        
        // Disable All button
        const disableAllBtn = document.createElement('button');
        disableAllBtn.className = 'btn btn-secondary';
        disableAllBtn.textContent = '✗ Disable All Bands';
        disableAllBtn.onclick = () => disableAllBands(inst.Name);
        
        // Disable buttons if instance is disabled or no bands
        if (!inst.Enabled || instanceBands.length === 0) {
            addBandBtn.disabled = true;
            addBandBtn.style.opacity = '0.5';
            addBandBtn.style.cursor = 'not-allowed';
            
            enableAllBtn.disabled = true;
            enableAllBtn.style.opacity = '0.5';
            enableAllBtn.style.cursor = 'not-allowed';
            
            disableAllBtn.disabled = true;
            disableAllBtn.style.opacity = '0.5';
            disableAllBtn.style.cursor = 'not-allowed';
        } else {
            addBandBtn.onclick = () => addBandToInstance(inst.Name);
        }
        
        buttonContainer.appendChild(addBandBtn);
        if (instanceBands.length > 0) {
            buttonContainer.appendChild(enableAllBtn);
            buttonContainer.appendChild(disableAllBtn);
        }
        
        instanceCard.appendChild(bandsContainer);
        instanceCard.appendChild(buttonContainer);
        container.appendChild(instanceCard);
    });
}

function showModal(title, fields, onSave) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>${title}</h3>
                <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            </div>
            <div class="modal-body">
                ${fields.map(f => {
                    if (f.options) {
                        // Dropdown field
                        return `
                            <div class="form-group">
                                <label>${f.label}</label>
                                <select id="modal-${f.id}">
                                    ${f.options.map(opt => `<option value="${opt}" ${opt === f.value ? 'selected' : ''}>${opt}</option>`).join('')}
                                </select>
                            </div>
                        `;
                    } else {
                        // Regular input field
                        return `
                            <div class="form-group">
                                <label>${f.label}</label>
                                <input type="${f.type || 'text'}" id="modal-${f.id}" value="${f.value || ''}" placeholder="${f.placeholder || ''}">
                            </div>
                        `;
                    }
                }).join('')}
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                <button class="btn btn-primary" onclick="saveModal()">Save</button>
            </div>
        </div>
    `;
    
    modal.querySelector('.btn-primary').onclick = () => {
        const values = {};
        fields.forEach(f => {
            const input = document.getElementById('modal-' + f.id);
            values[f.id] = f.type === 'number' ? parseFloat(input.value) : input.value;
        });
        onSave(values);
        modal.remove();
    };
    
    document.body.appendChild(modal);
}

function addInstance() {
    showModal('Add KiwiSDR Instance', [
        { id: 'name', label: 'Instance Name', placeholder: 'kiwi1' },
        { id: 'host', label: 'Host', placeholder: '44.31.241.9' },
        { id: 'port', label: 'Port', type: 'number', value: '8073' },
        { id: 'user', label: 'User', value: 'kiwi_wspr' },
        { id: 'password', label: 'Password (optional)', type: 'password' },
        { id: 'mqtt_topic_prefix', label: 'MQTT Topic Prefix (optional - overrides global)', placeholder: 'Leave empty to use global prefix' }
    ], (values) => {
        if (!config.KiwiInstances) config.KiwiInstances = [];
        config.KiwiInstances.push({
            Name: values.name,
            Host: values.host,
            Port: parseInt(values.port),
            User: values.user,
            Password: values.password,
            MQTTTopicPrefix: values.mqtt_topic_prefix || '',
            Enabled: true
        });
        updateInstancesAndBands();
    });
}

function editInstance(idx) {
    const inst = config.KiwiInstances[idx];
    showModal('Edit KiwiSDR Instance', [
        { id: 'name', label: 'Instance Name', value: inst.Name },
        { id: 'host', label: 'Host', value: inst.Host },
        { id: 'port', label: 'Port', type: 'number', value: inst.Port },
        { id: 'user', label: 'User', value: inst.User },
        { id: 'password', label: 'Password (optional)', type: 'password', value: inst.Password },
        { id: 'mqtt_topic_prefix', label: 'MQTT Topic Prefix (optional - overrides global)', value: inst.MQTTTopicPrefix || '', placeholder: 'Leave empty to use global prefix' }
    ], (values) => {
        config.KiwiInstances[idx] = {
            Name: values.name,
            Host: values.host,
            Port: parseInt(values.port),
            User: values.user,
            Password: values.password,
            MQTTTopicPrefix: values.mqtt_topic_prefix || '',
            Enabled: config.KiwiInstances[idx].Enabled !== undefined ? config.KiwiInstances[idx].Enabled : true
        };
        updateInstancesAndBands();
    });
}

function deleteInstance(idx) {
    if (confirm('Delete this instance?')) {
        config.KiwiInstances.splice(idx, 1);
        updateInstancesAndBands();
    }
}

function toggleInstance(idx) {
    config.KiwiInstances[idx].Enabled = !config.KiwiInstances[idx].Enabled;
    updateInstancesAndBands();
}

function addBandToInstance(instanceName) {
    showModal('Add WSPR Band to ' + instanceName, [
        { id: 'name', label: 'Band Name', placeholder: '20m' },
        { id: 'frequency', label: 'Frequency (kHz)', type: 'number', placeholder: '14097.0' }
    ], (values) => {
        if (!config.WSPRBands) config.WSPRBands = [];
        config.WSPRBands.push({
            Name: values.name,
            Frequency: parseFloat(values.frequency),
            Instance: instanceName,
            Enabled: true
        });
        updateInstancesAndBands();
    });
}

function addBand() {
    const instanceNames = config.KiwiInstances ? config.KiwiInstances.map(i => i.Name) : [];
    
    if (instanceNames.length === 0) {
        showAlert('Please add at least one KiwiSDR instance first', 'error');
        return;
    }
    
    showModal('Add WSPR Band', [
        { id: 'name', label: 'Band Name', placeholder: '20m' },
        { id: 'frequency', label: 'Frequency (kHz)', type: 'number', placeholder: '14097.0' },
        { id: 'instance', label: 'Instance Name', options: instanceNames, value: instanceNames[0] }
    ], (values) => {
        if (!config.WSPRBands) config.WSPRBands = [];
        config.WSPRBands.push({
            Name: values.name,
            Frequency: parseFloat(values.frequency),
            Instance: values.instance,
            Enabled: true
        });
        updateInstancesAndBands();
    });
}

function toggleBand(idx) {
    config.WSPRBands[idx].Enabled = !config.WSPRBands[idx].Enabled;
    updateInstancesAndBands();
}

function duplicateBand(idx) {
    const band = config.WSPRBands[idx];
    
    // Get list of instances excluding the current one
    const otherInstances = config.KiwiInstances
        .filter(inst => inst.Name !== band.Instance)
        .map(inst => inst.Name);
    
    if (otherInstances.length === 0) {
        showAlertModal('Cannot Duplicate Band', '❌ No other instances available. Please add another KiwiSDR instance first to duplicate this band.');
        return;
    }
    
    showModal('Duplicate Band: ' + band.Name, [
        {
            id: 'instance',
            label: 'Duplicate to Instance',
            options: otherInstances,
            value: otherInstances[0]
        }
    ], (values) => {
        if (!config.WSPRBands) config.WSPRBands = [];
        config.WSPRBands.push({
            Name: band.Name,
            Frequency: band.Frequency,
            Instance: values.instance,
            Enabled: true  // Enable by default
        });
        updateInstancesAndBands();
        showAlert(`✅ Band "${band.Name}" duplicated to ${values.instance}`, 'success');
    });
}

function deleteBand(idx) {
    if (confirm('Delete this band?')) {
        config.WSPRBands.splice(idx, 1);
        updateInstancesAndBands();
    }
}

function enableAllBands(instanceName) {
    if (!config.WSPRBands) return;
    
    let count = 0;
    config.WSPRBands.forEach(band => {
        if (band.Instance === instanceName && !band.Enabled) {
            band.Enabled = true;
            count++;
        }
    });
    
    updateInstancesAndBands();
    
    if (count > 0) {
        showAlert(`✅ Enabled ${count} band${count !== 1 ? 's' : ''} for ${instanceName}`, 'success');
    } else {
        showAlert(`ℹ️ All bands for ${instanceName} are already enabled`, 'success');
    }
}

function disableAllBands(instanceName) {
    if (!config.WSPRBands) return;
    
    let count = 0;
    config.WSPRBands.forEach(band => {
        if (band.Instance === instanceName && band.Enabled) {
            band.Enabled = false;
            count++;
        }
    });
    
    updateInstancesAndBands();
    
    if (count > 0) {
        showAlert(`✅ Disabled ${count} band${count !== 1 ? 's' : ''} for ${instanceName}`, 'success');
    } else {
        showAlert(`ℹ️ All bands for ${instanceName} are already disabled`, 'success');
    }
}

async function saveConfig() {
    config.MQTT.Enabled = document.getElementById('mqtt-enabled').checked;
    config.MQTT.Host = document.getElementById('mqtt-host').value;
    config.MQTT.Port = parseInt(document.getElementById('mqtt-port').value);
    config.MQTT.UseTLS = document.getElementById('mqtt-use-tls').checked;
    config.MQTT.TopicPrefix = document.getElementById('mqtt-prefix').value;
    config.MQTT.Username = document.getElementById('mqtt-username').value;
    config.MQTT.Password = document.getElementById('mqtt-password').value;
    config.MQTT.QoS = parseInt(document.getElementById('mqtt-qos').value);
    config.MQTT.Retain = document.getElementById('mqtt-retain').checked;

    try {
        const response = await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        // Scroll to top to show the alert message
        window.scrollTo({ top: 0, behavior: 'smooth' });

        if (response.ok) {
            showAlert('✅ Configuration saved successfully!', 'success');
            
            // Immediately refresh status to show updated MQTT connection and band states
            await loadStatus();
            await loadKiwiStatus();
        } else {
            const error = await response.text();
            showAlert('❌ Error: ' + error, 'error');
        }
    } catch (e) {
        showAlert('❌ Error: ' + e.message, 'error');
    }
}

function exportConfig() {
    // Create a JSON blob from the current config
    const configJson = JSON.stringify(config, null, 2);
    const blob = new Blob([configJson], { type: 'application/json' });
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kiwi_wspr_config_' + new Date().toISOString().split('T')[0] + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showAlert('✅ Configuration exported successfully!', 'success');
}

function importConfig(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedConfig = JSON.parse(e.target.result);
            
            // Validate that it looks like a valid config
            if (!importedConfig.MQTT || !importedConfig.KiwiInstances) {
                showAlert('❌ Invalid configuration file format', 'error');
                return;
            }
            
            // Update the config
            config = importedConfig;
            updateUI();
            showAlert('✅ Configuration imported successfully! Remember to save.', 'success');
        } catch (err) {
            showAlert('❌ Error parsing configuration file: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
    
    // Reset the file input so the same file can be imported again
    event.target.value = '';
}

function showAlertModal(title, message) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>${title}</h3>
                <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0; line-height: 1.6;">${message}</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary" onclick="this.closest('.modal').remove()">OK</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function showAlert(message, type) {
    const alert = document.getElementById('alert');
    alert.className = 'alert alert-' + type;
    alert.textContent = message;
    alert.style.display = 'block';
    setTimeout(() => { alert.style.display = 'none'; }, 5000);
}

async function testMQTT() {
    // Get current MQTT settings from UI
    const mqttConfig = {
        enabled: true, // Always true for testing
        host: document.getElementById('mqtt-host').value,
        port: parseInt(document.getElementById('mqtt-port').value),
        use_tls: document.getElementById('mqtt-use-tls').checked,
        username: document.getElementById('mqtt-username').value,
        password: document.getElementById('mqtt-password').value,
        topic_prefix: document.getElementById('mqtt-prefix').value,
        qos: parseInt(document.getElementById('mqtt-qos').value),
        retain: document.getElementById('mqtt-retain').checked
    };

    // Validate required fields
    if (!mqttConfig.host) {
        showAlert('❌ Please enter MQTT broker host', 'error');
        return;
    }

    if (!mqttConfig.port || mqttConfig.port < 1 || mqttConfig.port > 65535) {
        showAlert('❌ Please enter a valid MQTT broker port (1-65535)', 'error');
        return;
    }

    // Show testing message
    showAlert('🔄 Testing MQTT connection...', 'success');

    try {
        const response = await fetch('/api/mqtt/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mqttConfig)
        });

        const result = await response.json();

        if (result.success) {
            showAlert(result.message, 'success');
        } else {
            showAlert(result.message, 'error');
        }
    } catch (e) {
        showAlert('❌ Error testing MQTT: ' + e.message, 'error');
    }
}

function showKiwiInfo(instanceName) {
    const kiwiStatus = kiwiStatusData[instanceName];
    
    if (!kiwiStatus || kiwiStatus.error) {
        showAlertModal('KiwiSDR Info', `❌ Unable to retrieve status for ${instanceName}`);
        return;
    }
    
    const infoHTML = `
        <div style="line-height: 1.8;">
            <p style="margin: 10px 0;"><strong>Status:</strong> ${kiwiStatus.status || 'N/A'}</p>
            <p style="margin: 10px 0;"><strong>Offline:</strong> ${kiwiStatus.offline || 'N/A'}</p>
            <p style="margin: 10px 0;"><strong>Name:</strong> ${kiwiStatus.name || 'N/A'}</p>
            <p style="margin: 10px 0;"><strong>Users:</strong> ${kiwiStatus.users || '0'}/${kiwiStatus.users_max || '0'}</p>
            <p style="margin: 10px 0;"><strong>Location:</strong> ${kiwiStatus.loc || 'N/A'}</p>
            <p style="margin: 10px 0;"><strong>Software Version:</strong> ${kiwiStatus.sw_version || 'N/A'}</p>
            <p style="margin: 10px 0;"><strong>Antenna:</strong> ${kiwiStatus.antenna || 'N/A'}</p>
            <p style="margin: 10px 0; font-size: 12px; color: #888;"><strong>Last Updated:</strong> ${new Date(kiwiStatus.last_update).toLocaleString()}</p>
        </div>
    `;
    
    showAlertModal(`KiwiSDR Info: ${instanceName}`, infoHTML);
}

function updateInstanceHeaders() {
    // Only update the instance header info without rebuilding the entire DOM
    if (!config.KiwiInstances) return;
    
    config.KiwiInstances.forEach((inst, instIdx) => {
        const kiwiStatus = kiwiStatusData[inst.Name];
        
        // Find the instance card
        const instanceCards = document.querySelectorAll('#instances-container > div');
        if (instIdx >= instanceCards.length) return;
        
        const instanceCard = instanceCards[instIdx];
        const instanceHeader = instanceCard.querySelector('div');
        if (!instanceHeader) return;
        
        // Build status line
        let statusLine = `${inst.Host}:${inst.Port} • User: ${inst.User}`;
        if (kiwiStatus && !kiwiStatus.error && kiwiStatus.users && kiwiStatus.users_max) {
            statusLine += ` • Users: (${kiwiStatus.users}/${kiwiStatus.users_max})`;
        }
        
        // Show KiwiSDR name if available
        let kiwiNameLine = '';
        if (kiwiStatus && !kiwiStatus.error && kiwiStatus.name) {
            kiwiNameLine = `<div style="font-size: 12px; color: #888; margin-top: 3px; font-style: italic;">${kiwiStatus.name}</div>`;
        }
        
        // Update only the header content
        instanceHeader.innerHTML = `
            <div>
                <h3 style="margin: 0; display: inline-block;">🌐 ${inst.Name}</h3>
                <span class="status ${inst.Enabled ? 'status-enabled' : 'status-disabled'}" style="margin-left: 10px;">
                    ${inst.Enabled ? 'Enabled' : 'Disabled'}
                </span>
                <div style="font-size: 13px; color: #666; margin-top: 5px;">
                    ${statusLine}
                </div>
                ${kiwiNameLine}
            </div>
            <div class="item-actions">
                ${kiwiStatus && !kiwiStatus.error ? `<button class="btn btn-secondary" onclick="showKiwiInfo('${inst.Name}')">Info</button>` : ''}
                <button class="btn btn-secondary" onclick="toggleInstance(${instIdx})">
                    ${inst.Enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-secondary" onclick="editInstance(${instIdx})">Edit</button>
                <button class="btn btn-danger" onclick="deleteInstance(${instIdx})">Delete</button>
            </div>
        `;
    });
}

// Start status polling
function startStatusPolling() {
    // Load status immediately
    loadStatus();
    loadKiwiStatus();
    
    // Poll every 10 seconds
    setInterval(loadStatus, 10000);
    setInterval(loadKiwiStatus, 10000);
}

// Load config and start status polling on page load
loadConfig();
startStatusPolling();
