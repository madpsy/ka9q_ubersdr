let config = {};

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

function updateUI() {
    document.getElementById('callsign').value = config.Receiver.Callsign || '';
    document.getElementById('locator').value = config.Receiver.Locator || '';
    document.getElementById('mqtt-enabled').checked = config.MQTT.Enabled || false;
    document.getElementById('mqtt-broker').value = config.MQTT.Broker || '';
    document.getElementById('mqtt-prefix').value = config.MQTT.TopicPrefix || '';
    
    updateInstancesList();
    updateBandsList();
}

function updateInstancesList() {
    const list = document.getElementById('instances-list');
    list.innerHTML = '';
    
    if (!config.KiwiInstances || config.KiwiInstances.length === 0) {
        list.innerHTML = '<li class="item"><div class="item-info">No instances configured</div></li>';
        return;
    }
    
    config.KiwiInstances.forEach((inst, idx) => {
        const li = document.createElement('li');
        li.className = 'item';
        li.innerHTML = `
            <div class="item-info">
                <strong>${inst.Name}</strong> - ${inst.Host}:${inst.Port}
                <div style="font-size: 12px; color: #666; margin-top: 4px;">User: ${inst.User}</div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary" onclick="editInstance(${idx})">Edit</button>
                <button class="btn btn-danger" onclick="deleteInstance(${idx})">Delete</button>
            </div>
        `;
        list.appendChild(li);
    });
}

function updateBandsList() {
    const list = document.getElementById('bands-list');
    list.innerHTML = '';
    
    if (!config.WSPRBands || config.WSPRBands.length === 0) {
        list.innerHTML = '<li class="item"><div class="item-info">No bands configured</div></li>';
        return;
    }
    
    config.WSPRBands.forEach((band, idx) => {
        const li = document.createElement('li');
        li.className = 'item';
        li.innerHTML = `
            <div class="item-info">
                <strong>${band.Name}</strong> - ${band.Frequency} MHz on ${band.Instance}
                <span class="status ${band.Enabled ? 'status-enabled' : 'status-disabled'}">
                    ${band.Enabled ? 'Enabled' : 'Disabled'}
                </span>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary" onclick="toggleBand(${idx})">
                    ${band.Enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-danger" onclick="deleteBand(${idx})">Delete</button>
            </div>
        `;
        list.appendChild(li);
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
                ${fields.map(f => `
                    <div class="form-group">
                        <label>${f.label}</label>
                        <input type="${f.type || 'text'}" id="modal-${f.id}" value="${f.value || ''}" placeholder="${f.placeholder || ''}">
                    </div>
                `).join('')}
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
        { id: 'password', label: 'Password (optional)', type: 'password' }
    ], (values) => {
        if (!config.KiwiInstances) config.KiwiInstances = [];
        config.KiwiInstances.push({
            Name: values.name,
            Host: values.host,
            Port: parseInt(values.port),
            User: values.user,
            Password: values.password
        });
        updateInstancesList();
    });
}

function editInstance(idx) {
    const inst = config.KiwiInstances[idx];
    showModal('Edit KiwiSDR Instance', [
        { id: 'name', label: 'Instance Name', value: inst.Name },
        { id: 'host', label: 'Host', value: inst.Host },
        { id: 'port', label: 'Port', type: 'number', value: inst.Port },
        { id: 'user', label: 'User', value: inst.User },
        { id: 'password', label: 'Password (optional)', type: 'password', value: inst.Password }
    ], (values) => {
        config.KiwiInstances[idx] = {
            Name: values.name,
            Host: values.host,
            Port: parseInt(values.port),
            User: values.user,
            Password: values.password
        };
        updateInstancesList();
    });
}

function deleteInstance(idx) {
    if (confirm('Delete this instance?')) {
        config.KiwiInstances.splice(idx, 1);
        updateInstancesList();
    }
}

function addBand() {
    const instances = config.KiwiInstances.map(i => i.Name).join(', ');
    showModal('Add WSPR Band', [
        { id: 'name', label: 'Band Name', placeholder: '20m' },
        { id: 'frequency', label: 'Frequency (MHz)', type: 'number', placeholder: '14.097' },
        { id: 'instance', label: 'Instance Name', placeholder: instances }
    ], (values) => {
        if (!config.WSPRBands) config.WSPRBands = [];
        config.WSPRBands.push({
            Name: values.name,
            Frequency: parseFloat(values.frequency),
            Instance: values.instance,
            Enabled: true
        });
        updateBandsList();
    });
}

function toggleBand(idx) {
    config.WSPRBands[idx].Enabled = !config.WSPRBands[idx].Enabled;
    updateBandsList();
}

function deleteBand(idx) {
    if (confirm('Delete this band?')) {
        config.WSPRBands.splice(idx, 1);
        updateBandsList();
    }
}

async function saveConfig() {
    config.Receiver.Callsign = document.getElementById('callsign').value;
    config.Receiver.Locator = document.getElementById('locator').value;
    config.MQTT.Enabled = document.getElementById('mqtt-enabled').checked;
    config.MQTT.Broker = document.getElementById('mqtt-broker').value;
    config.MQTT.TopicPrefix = document.getElementById('mqtt-prefix').value;

    try {
        const response = await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (response.ok) {
            showAlert('✅ Configuration saved successfully!', 'success');
        } else {
            const error = await response.text();
            showAlert('❌ Error: ' + error, 'error');
        }
    } catch (e) {
        showAlert('❌ Error: ' + e.message, 'error');
    }
}

function showAlert(message, type) {
    const alert = document.getElementById('alert');
    alert.className = 'alert alert-' + type;
    alert.textContent = message;
    alert.style.display = 'block';
    setTimeout(() => { alert.style.display = 'none'; }, 5000);
}

// Load config on page load
loadConfig();
