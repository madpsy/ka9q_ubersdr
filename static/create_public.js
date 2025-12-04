// Public Instance Wizard JavaScript
let currentStep = 1;
let currentConfig = {};
let testPassed = false;
let generatedUUID = null;

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
        
        // If unauthorized, redirect to admin login
        if (response.status === 401) {
            window.location.href = '/admin.html';
            return;
        }
        
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
    const fields = ['useMyIP', 'instanceHost', 'instancePort', 'instanceTLS'];
    fields.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', updateReviewSection);
            element.addEventListener('input', updateReviewSection);
        }
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

// Update review section
function updateReviewSection() {
    const useMyIP = document.getElementById('useMyIP').checked;
    const instanceHost = document.getElementById('instanceHost').value;
    const instancePort = document.getElementById('instancePort').value;
    const instanceTLS = document.getElementById('instanceTLS').checked;
    
    // Public UUID - show existing or indicate it will be generated
    let uuid = currentConfig.instance_reporting?.public_uuid;
    if (!uuid && !generatedUUID) {
        uuid = 'Will be generated on first test';
    } else if (generatedUUID) {
        uuid = generatedUUID;
    }
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
}

// Navigation functions
function nextStep() {
    if (validateCurrentStep()) {
        if (currentStep < 3) {
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

    // If we're on step 3, ensure finish button is disabled until test passes
    if (step === 3) {
        const finishBtn = document.getElementById('finishBtn');
        if (finishBtn) {
            finishBtn.disabled = !testPassed;
        }
    }
    
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
    if (currentStep < 3) {
        nextBtn.style.display = 'inline-block';
        finishBtn.style.display = 'none';
    } else {
        nextBtn.style.display = 'none';
        finishBtn.style.display = 'inline-block';
        // Disable finish button initially on step 3 until test passes
        finishBtn.disabled = !testPassed;
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
    
    return true;
}

// Finish wizard and save configuration
async function finishWizard() {
    // Check if test has passed
    if (!testPassed) {
        showAlert('⚠️ You must successfully test the configuration before enabling public reporting.', 'error');
        return;
    }

    try {
        showAlert('Saving configuration...', 'info');

        // Build the configuration update with default values
        const useMyIP = document.getElementById('useMyIP').checked;

        // Update instance_reporting section with defaults
        const updatedConfig = {
            ...currentConfig,
            instance_reporting: {
                ...currentConfig.instance_reporting,
                enabled: true,
                use_https: true,  // Default to HTTPS
                use_myip: useMyIP,
                hostname: 'instances.ubersdr.org',  // Default hostname
                port: 443,  // Default HTTPS port
                report_interval_sec: 120,  // Default 2 minutes
                public_uuid: generatedUUID || currentConfig.instance_reporting?.public_uuid || generateUUID()
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

// Generate UUID v4
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Test instance reporter function
async function testInstanceReporter() {
    const button = document.getElementById('testButton');
    const testResult = document.getElementById('testResult');
    const finishButton = document.querySelector('.wizard-nav .btn-primary');
    const originalText = button.textContent;

    button.disabled = true;
    button.textContent = '⏳ Testing...';
    testResult.style.display = 'none';
    testPassed = false;

    try {
        // Generate UUID if it doesn't exist
        if (!generatedUUID && !currentConfig.instance_reporting?.public_uuid) {
            generatedUUID = generateUUID();
            // Update the review display
            document.getElementById('reviewUUID').textContent = generatedUUID;
        }

        // Get form values for the test
        const useMyIP = document.getElementById('useMyIP').checked;

        // Temporarily update config for testing
        const testConfig = {
            ...currentConfig,
            instance_reporting: {
                ...currentConfig.instance_reporting,
                enabled: true,
                use_https: true,
                use_myip: useMyIP,
                hostname: 'instances.ubersdr.org',
                port: 443,
                report_interval_sec: 120,
                public_uuid: generatedUUID || currentConfig.instance_reporting?.public_uuid
            }
        };

        // Add instance connection details if not using myip
        if (!useMyIP) {
            const instanceHost = document.getElementById('instanceHost').value.trim();
            const instancePort = parseInt(document.getElementById('instancePort').value);
            const instanceTLS = document.getElementById('instanceTLS').checked;

            testConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: instanceTLS
            };
        } else {
            testConfig.instance_reporting.instance = {
                host: '',
                port: 0,
                tls: false
            };
        }

        // Save the test config temporarily
        const saveResponse = await fetch('/admin/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testConfig)
        });

        if (!saveResponse.ok) {
            throw new Error('Failed to save test configuration');
        }

        // Now trigger the test
        const response = await fetch('/admin/instance-reporter-trigger', {
            method: 'POST'
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || 'Failed to trigger instance reporter');
        }

        const result = await response.json();

        // Format the response for display
        let message = '<strong>Instance Reporter Test Results:</strong><br><br>';
        message += `<strong>HTTP Response Code:</strong> ${result.collector_response_code || 'N/A'}<br>`;
        message += `<strong>Status:</strong> ${result.collector_response_status || 'N/A'}<br>`;
        message += `<strong>Message:</strong> ${result.collector_response_message || 'N/A'}<br>`;
        if (result.public_uuid) {
            message += `<strong>Public UUID:</strong> <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace;">${result.public_uuid}</code><br>`;
        }

        // Show result with appropriate styling
        testResult.innerHTML = message;
        testResult.style.display = 'block';

        if (result.collector_response_code === 200) {
            testResult.style.background = '#d4edda';
            testResult.style.border = '1px solid #c3e6cb';
            testResult.style.color = '#155724';
            testPassed = true;
            finishButton.disabled = false;
            showAlert('✅ Test successful! You can now enable public reporting.', 'success');
        } else {
            testResult.style.background = '#f8d7da';
            testResult.style.border = '1px solid #f5c6cb';
            testResult.style.color = '#721c24';
            testPassed = false;
            finishButton.disabled = true;
            showAlert('⚠️ Test failed. Please check your settings and try again.', 'error');
        }
    } catch (error) {
        testResult.innerHTML = `<strong>❌ Test Failed:</strong><br>${error.message}`;
        testResult.style.display = 'block';
        testResult.style.background = '#f8d7da';
        testResult.style.border = '1px solid #f5c6cb';
        testResult.style.color = '#721c24';
        showAlert('Error testing instance reporter: ' + error.message, 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
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