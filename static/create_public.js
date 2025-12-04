// Public Instance Wizard JavaScript
let currentStep = 1;
let currentConfig = {};

// Initialize wizard on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadCurrentConfig();
    setupEventListeners();
    updateNavigationButtons();
});

// Load current configuration
async function loadCurrentConfig() {
    try {
        const response = await fetch('/admin/config');
        if (!response.ok) {
            throw new Error('Failed to load configuration');
        }
        
        currentConfig = await response.json();
        
        // Populate form fields with current values
        populateFormFields();
    } catch (error) {
        showAlert('Error loading configuration: ' + error.message, 'error');
    }
}

// Populate form fields with current config values
function populateFormFields() {
    const ir = currentConfig.instance_reporting || {};
    
    // Step 2: Connection settings
    document.getElementById('useMyIP').checked = ir.use_myip !== false;
    document.getElementById('instanceHost').value = ir.instance?.host || '';
    document.getElementById('instancePort').value = ir.instance?.port || 8080;
    document.getElementById('instanceTLS').checked = ir.instance?.tls || false;
    
    // Step 3: Advanced settings
    document.getElementById('reportInterval').value = ir.report_interval_sec || 120;
    document.getElementById('useHTTPS').checked = ir.use_https !== false;
    document.getElementById('hostname').value = ir.hostname || 'instances.ubersdr.org';
    document.getElementById('port').value = ir.port || 443;
    
    // Update manual connection fields visibility
    toggleManualConnectionFields();
    
    // Update review section
    updateReviewSection();
}

// Setup event listeners
function setupEventListeners() {
    // Use My IP checkbox
    document.getElementById('useMyIP').addEventListener('change', toggleManualConnectionFields);
    
    // Update review when fields change
    const fields = ['useMyIP', 'instanceHost', 'instancePort', 'instanceTLS', 
                    'reportInterval', 'useHTTPS', 'hostname', 'port'];
    fields.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', updateReviewSection);
            element.addEventListener('input', updateReviewSection);
        }
    });
    
    // HTTPS checkbox updates port
    document.getElementById('useHTTPS').addEventListener('change', (e) => {
        const portField = document.getElementById('port');
        if (e.target.checked) {
            portField.value = 443;
        } else {
            portField.value = 8443;
        }
        updateReviewSection();
    });
}

// Toggle manual connection fields visibility
function toggleManualConnectionFields() {
    const useMyIP = document.getElementById('useMyIP').checked;
    const manualFields = document.getElementById('manualConnectionFields');
    
    if (useMyIP) {
        manualFields.style.display = 'none';
    } else {
        manualFields.style.display = 'block';
    }
    
    updateReviewSection();
}

// Toggle collapsible sections
function toggleCollapsible(button) {
    const content = button.nextElementSibling;
    const icon = button.querySelector('span');
    
    if (content.style.display === 'block') {
        content.style.display = 'none';
        icon.textContent = '▶';
    } else {
        content.style.display = 'block';
        icon.textContent = '▼';
    }
}

// Update review section
function updateReviewSection() {
    const useMyIP = document.getElementById('useMyIP').checked;
    const instanceHost = document.getElementById('instanceHost').value;
    const instancePort = document.getElementById('instancePort').value;
    const instanceTLS = document.getElementById('instanceTLS').checked;
    const reportInterval = document.getElementById('reportInterval').value;
    const useHTTPS = document.getElementById('useHTTPS').checked;
    const hostname = document.getElementById('hostname').value;
    const port = document.getElementById('port').value;
    
    // Instance UUID
    const uuid = currentConfig.instance_reporting?.instance_uuid || 'Will be auto-generated';
    document.getElementById('reviewUUID').textContent = uuid;
    
    // Connection settings
    document.getElementById('reviewUseMyIP').textContent = useMyIP ? 'Yes' : 'No';
    
    if (useMyIP) {
        document.getElementById('reviewHostItem').style.display = 'none';
        document.getElementById('reviewPortItem').style.display = 'none';
        document.getElementById('reviewTLSItem').style.display = 'none';
    } else {
        document.getElementById('reviewHostItem').style.display = 'flex';
        document.getElementById('reviewPortItem').style.display = 'flex';
        document.getElementById('reviewTLSItem').style.display = 'flex';
        document.getElementById('reviewHost').textContent = instanceHost || '(not set)';
        document.getElementById('reviewPort').textContent = instancePort;
        document.getElementById('reviewTLS').textContent = instanceTLS ? 'Yes' : 'No';
    }
    
    // Reporting settings
    document.getElementById('reviewInterval').textContent = reportInterval + ' seconds';
    document.getElementById('reviewHTTPS').textContent = useHTTPS ? 'Yes' : 'No';
    document.getElementById('reviewServer').textContent = hostname + ':' + port;
}

// Navigation functions
function nextStep() {
    if (validateCurrentStep()) {
        if (currentStep < 4) {
            currentStep++;
            showStep(currentStep);
        }
    }
}

function previousStep() {
    if (currentStep > 1) {
        currentStep--;
        showStep(currentStep);
    }
}

function showStep(step) {
    // Hide all steps
    document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.progress-step').forEach(s => s.classList.remove('active'));
    
    // Show current step
    document.querySelector(`.wizard-step[data-step="${step}"]`).classList.add('active');
    document.querySelector(`.progress-step[data-step="${step}"]`).classList.add('active');
    
    // Mark previous steps as completed
    for (let i = 1; i < step; i++) {
        document.querySelector(`.progress-step[data-step="${i}"]`).classList.add('completed');
    }
    
    // Update navigation buttons
    updateNavigationButtons();
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateNavigationButtons() {
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const finishBtn = document.getElementById('finishBtn');
    
    // Show/hide previous button
    prevBtn.style.display = currentStep > 1 ? 'inline-block' : 'none';
    
    // Show/hide next and finish buttons
    if (currentStep < 4) {
        nextBtn.style.display = 'inline-block';
        finishBtn.style.display = 'none';
    } else {
        nextBtn.style.display = 'none';
        finishBtn.style.display = 'inline-block';
    }
}

// Validation
function validateCurrentStep() {
    if (currentStep === 2) {
        const useMyIP = document.getElementById('useMyIP').checked;
        
        if (!useMyIP) {
            const host = document.getElementById('instanceHost').value.trim();
            const port = parseInt(document.getElementById('instancePort').value);
            
            if (!host) {
                showAlert('Please enter a hostname or IP address', 'error');
                return false;
            }
            
            if (!port || port < 1 || port > 65535) {
                showAlert('Please enter a valid port number (1-65535)', 'error');
                return false;
            }
        }
    }
    
    if (currentStep === 3) {
        const interval = parseInt(document.getElementById('reportInterval').value);
        const port = parseInt(document.getElementById('port').value);
        
        if (!interval || interval < 60 || interval > 3600) {
            showAlert('Report interval must be between 60 and 3600 seconds', 'error');
            return false;
        }
        
        if (!port || port < 1 || port > 65535) {
            showAlert('Please enter a valid port number (1-65535)', 'error');
            return false;
        }
    }
    
    return true;
}

// Finish wizard and save configuration
async function finishWizard() {
    try {
        showAlert('Saving configuration...', 'info');
        
        // Build the configuration update
        const useMyIP = document.getElementById('useMyIP').checked;
        const reportInterval = parseInt(document.getElementById('reportInterval').value);
        const useHTTPS = document.getElementById('useHTTPS').checked;
        const hostname = document.getElementById('hostname').value.trim();
        const port = parseInt(document.getElementById('port').value);
        
        // Update instance_reporting section
        const updatedConfig = {
            ...currentConfig,
            instance_reporting: {
                ...currentConfig.instance_reporting,
                enabled: true,
                use_https: useHTTPS,
                use_myip: useMyIP,
                hostname: hostname,
                port: port,
                report_interval_sec: reportInterval
            }
        };
        
        // Add instance connection details if not using myip
        if (!useMyIP) {
            const instanceHost = document.getElementById('instanceHost').value.trim();
            const instancePort = parseInt(document.getElementById('instancePort').value);
            const instanceTLS = document.getElementById('instanceTLS').checked;
            
            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: instanceTLS
            };
        } else {
            // Clear instance details if using myip
            updatedConfig.instance_reporting.instance = {
                host: '',
                port: 0,
                tls: false
            };
        }
        
        // Save configuration (no restart needed for instance_reporting)
        const response = await fetch('/admin/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updatedConfig)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || 'Failed to save configuration');
        }
        
        const result = await response.json();
        showAlert(result.message || 'Configuration saved successfully!', 'success');
        
        // Redirect to admin panel after a short delay
        setTimeout(() => {
            window.location.href = '/admin.html';
        }, 2000);
        
    } catch (error) {
        showAlert('Error saving configuration: ' + error.message, 'error');
    }
}

// Cancel wizard
function cancelWizard() {
    if (confirm('Are you sure you want to cancel? Your changes will not be saved.')) {
        window.location.href = '/admin.html';
    }
}

// Show alert message
function showAlert(message, type) {
    const alertBox = document.getElementById('alertBox');
    alertBox.className = 'alert alert-' + type;
    alertBox.textContent = message;
    alertBox.style.display = 'block';
    
    // Auto-hide success messages after 5 seconds
    if (type === 'success' || type === 'info') {
        setTimeout(() => {
            alertBox.style.display = 'none';
        }, 5000);
    }
    
    // Scroll alert into view
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}