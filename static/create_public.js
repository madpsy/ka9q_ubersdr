// Public Instance Wizard JavaScript
let currentStep = 1;
let currentConfig = {};
let testPassed = false;
let generatedUUID = null;

// Initialize wizard on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadCurrentConfig();
    setupEventListeners();
    // Ensure finish button is disabled initially
    const finishBtn = document.getElementById('finishBtn');
    if (finishBtn) {
        finishBtn.disabled = true;
    }
    updateNavigationButtons();
});

// Load current configuration
async function loadCurrentConfig() {
    try {
        const response = await fetch('/admin/config');
        
        // If unauthorized, redirect to admin login with return URL
        if (response.status === 401) {
            const returnUrl = encodeURIComponent(window.location.pathname);
            window.location.href = `/admin.html?return=${returnUrl}`;
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

    // Step 2: Admin email (always first)
    const adminEmail = currentConfig.admin?.email || '';
    document.getElementById('adminEmail').value = adminEmail;
    
    // Validate email on load
    validateAdminEmail();

    // Step 2: Callsign (always second)
    const adminCallsign = currentConfig.admin?.callsign || '';
    document.getElementById('adminCallsign').value = adminCallsign.toUpperCase();
    
    // Validate callsign on load
    validateAdminCallsign();

    // Step 2: Connection settings
    document.getElementById('useMyIP').checked = ir.use_myip !== false;
    document.getElementById('instanceHost').value = ir.instance?.host || '';
    document.getElementById('instancePort').value = ir.instance?.port || 8080;
    document.getElementById('instanceTLS').checked = ir.instance?.tls || false;
    
    // Check if admin email ends with @example.com
    const isExampleEmail = adminEmail.toLowerCase().endsWith('@example.com');
    
    // Default create_domain to true for new setups (when instance_reporting is not enabled)
    // If instance_reporting is already enabled, use the configured value
    // But disable if email is @example.com
    const defaultCreateDomain = !ir.enabled && !isExampleEmail; // true if not enabled yet and email is valid
    document.getElementById('createDomain').checked = ir.create_domain !== undefined ? ir.create_domain : defaultCreateDomain;
    
    // Disable create domain checkbox and show warning if email is @example.com
    const createDomainCheckbox = document.getElementById('createDomain');
    const createDomainWarning = document.getElementById('createDomainWarning');
    
    if (isExampleEmail) {
        createDomainCheckbox.disabled = true;
        createDomainCheckbox.checked = false;
        if (createDomainWarning) {
            createDomainWarning.style.display = 'block';
        }
    } else {
        createDomainCheckbox.disabled = false;
        if (createDomainWarning) {
            createDomainWarning.style.display = 'none';
        }
    }

    // Update domain preview with callsign from config
    // This must happen BEFORE toggleManualConnectionFields which might trigger handleCreateDomainToggle
    updateDomainPreview();

    // If create domain is checked, trigger the toggle to show the info box
    if (document.getElementById('createDomain').checked) {
        handleCreateDomainToggle();
    }

    // Update manual connection fields visibility
    toggleManualConnectionFields();

    // Update review section with loaded config
    updateReviewSection();
}

// Setup event listeners
function setupEventListeners() {
    // Admin email validation
    document.getElementById('adminEmail').addEventListener('input', validateAdminEmail);
    document.getElementById('adminEmail').addEventListener('blur', validateAdminEmail);
    
    // Admin callsign validation
    document.getElementById('adminCallsign').addEventListener('input', validateAdminCallsign);
    document.getElementById('adminCallsign').addEventListener('blur', async function() {
        // First validate format
        if (validateAdminCallsign()) {
            // Then check availability
            await validateCallsignAvailability();
        }
    });
    
    // Use My IP checkbox
    document.getElementById('useMyIP').addEventListener('change', toggleManualConnectionFields);
    
    // TLS checkbox - update port when toggled
    document.getElementById('instanceTLS').addEventListener('change', handleTLSToggle);
    
    // Create domain checkbox
    document.getElementById('createDomain').addEventListener('change', handleCreateDomainToggle);
    
    // Update review when fields change
    const fields = ['useMyIP', 'instanceHost', 'instancePort', 'instanceTLS', 'createDomain'];
    fields.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', updateReviewSection);
            element.addEventListener('input', updateReviewSection);
        }
    });
}

// Handle TLS checkbox toggle - update port accordingly
function handleTLSToggle() {
    const tlsEnabled = document.getElementById('instanceTLS').checked;
    const portField = document.getElementById('instancePort');
    
    if (tlsEnabled) {
        // Set to HTTPS port
        portField.value = 443;
    } else {
        // Set to HTTP port
        portField.value = 80;
    }
    
    updateReviewSection();
}

// Handle create domain checkbox toggle
function handleCreateDomainToggle() {
    const createDomain = document.getElementById('createDomain').checked;
    const manualConfigSection = document.getElementById('manualConfigSection');
    const domainInfo = document.getElementById('domainInfo');
    const portForwardingInfo = document.getElementById('portForwardingInfo');
    const instanceHostInput = document.getElementById('instanceHost');
    const portField = document.getElementById('instancePort');
    const tlsCheckbox = document.getElementById('instanceTLS');
    
    if (createDomain) {
        // Hide manual configuration section
        manualConfigSection.style.display = 'none';
        
        // Hide port forwarding info box
        if (portForwardingInfo) {
            portForwardingInfo.style.display = 'none';
        }
        
        // Show DNS info box
        domainInfo.style.display = 'block';
        
        // Set hostname internally (not visible to user)
        const callsign = (currentConfig.admin?.callsign || currentConfig.callsign || 'yourcallsign').toLowerCase();
        instanceHostInput.value = callsign + '.instance.ubersdr.org';
        
        // Auto-set port to 443 and enable TLS
        portField.value = '443';
        tlsCheckbox.checked = true;
    } else {
        // Show manual configuration section
        manualConfigSection.style.display = 'block';
        
        // Show port forwarding info box
        if (portForwardingInfo) {
            portForwardingInfo.style.display = 'block';
        }
        
        // Hide DNS info box
        domainInfo.style.display = 'none';
        
        // Clear hostname
        instanceHostInput.value = '';
        
        // Reset to defaults
        toggleManualConnectionFields();
    }
    
    updateReviewSection();
}

// Update domain preview with callsign from config
function updateDomainPreview() {
    // Get callsign from input field if available, otherwise from config
    const callsignInput = document.getElementById('adminCallsign');
    let callsign;
    
    if (callsignInput && callsignInput.value.trim()) {
        callsign = callsignInput.value.trim().toLowerCase();
    } else {
        callsign = (currentConfig.admin?.callsign || currentConfig.callsign || 'yourcallsign').toLowerCase();
    }
    
    updateDomainPreviewWithCallsign(callsign);
}

// Toggle hostname and TLS field visibility
async function toggleManualConnectionFields() {
    const useMyIP = document.getElementById('useMyIP').checked;
    const hostnameField = document.getElementById('hostnameField');
    const tlsField = document.getElementById('tlsField');
    const detectedIPDiv = document.getElementById('detectedIP');
    const portField = document.getElementById('instancePort');

    if (useMyIP) {
        hostnameField.style.display = 'none';
        tlsField.style.display = 'none';
        // Uncheck TLS when using auto IP
        document.getElementById('instanceTLS').checked = false;
        // Set port to 80 for Caddy HTTP
        portField.value = 80;
        // Show and fetch IP address
        detectedIPDiv.style.display = 'block';
        await fetchPublicIP();
    } else {
        hostnameField.style.display = 'block';
        tlsField.style.display = 'block';
        // Hide IP address display
        detectedIPDiv.style.display = 'none';
    }

    updateReviewSection();
}

// Fetch public IP address
async function fetchPublicIP() {
    const ipSpan = document.getElementById('ipAddress');
    ipSpan.textContent = 'Loading...';

    try {
        const response = await fetch('https://instances.ubersdr.org/api/myip');
        if (!response.ok) {
            throw new Error('Failed to fetch IP');
        }
        const data = await response.json();
        ipSpan.textContent = data.ip;
    } catch (error) {
        ipSpan.textContent = 'Unable to detect';
        console.error('Error fetching public IP:', error);
    }
}

// Update review section
function updateReviewSection() {
    const createDomain = document.getElementById('createDomain').checked;
    const useMyIP = document.getElementById('useMyIP').checked;
    const instanceHost = document.getElementById('instanceHost').value;
    const instancePort = document.getElementById('instancePort').value;
    const instanceTLS = document.getElementById('instanceTLS').checked;
    
    // Admin Email
    const adminEmail = document.getElementById('adminEmail').value || '(not set)';
    document.getElementById('reviewEmail').textContent = adminEmail;
    
    // Callsign
    const adminCallsign = document.getElementById('adminCallsign').value || '(not set)';
    document.getElementById('reviewCallsign').textContent = adminCallsign;
    
    // Public UUID - show existing, generated, or placeholder
    let uuid;
    if (generatedUUID) {
        // Use the newly generated UUID from this session
        uuid = generatedUUID;
    } else if (currentConfig.instance_reporting?.instance_uuid) {
        // Use existing UUID from config (field name is instance_uuid)
        uuid = currentConfig.instance_reporting.instance_uuid;
    } else {
        // No UUID yet
        uuid = 'Will be generated on first test';
    }
    document.getElementById('reviewUUID').textContent = uuid;
    
    // Show create domain status
    document.getElementById('reviewDomainItem').style.display = 'flex';
    document.getElementById('reviewDomain').textContent = createDomain ? 'Yes (' + instanceHost + ')' : 'No';
    
    // Connection settings
    document.getElementById('reviewUseMyIP').textContent = useMyIP ? 'Yes' : 'No';

    // Always show port
    document.getElementById('reviewPortItem').style.display = 'flex';
    document.getElementById('reviewPort').textContent = instancePort;

    // Only show hostname and TLS if not using auto IP and not using create domain
    if (createDomain) {
        document.getElementById('reviewHostItem').style.display = 'none';
        document.getElementById('reviewTLSItem').style.display = 'none';
        document.getElementById('reviewUseMyIP').parentElement.style.display = 'none';
    } else {
        document.getElementById('reviewUseMyIP').parentElement.style.display = 'flex';
        if (useMyIP) {
            document.getElementById('reviewHostItem').style.display = 'none';
            document.getElementById('reviewTLSItem').style.display = 'none';
        } else {
            document.getElementById('reviewHostItem').style.display = 'flex';
            document.getElementById('reviewHost').textContent = instanceHost || '(not set)';
            document.getElementById('reviewTLSItem').style.display = 'flex';
            document.getElementById('reviewTLS').textContent = instanceTLS ? 'Yes' : 'No';
        }
    }
}

// Navigation functions
async function nextStep() {
    if (await validateCurrentStep()) {
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
    
    // Clear any alert messages when changing steps
    const alertBox = document.getElementById('alertBox');
    if (alertBox) {
        alertBox.style.display = 'none';
    }
    
    // Update navigation buttons (this will handle the finish button state)
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
    if (currentStep < 3) {
        nextBtn.style.display = 'inline-block';
        finishBtn.style.display = 'none';
    } else {
        nextBtn.style.display = 'none';
        finishBtn.style.display = 'inline-block';
        // Always check test status when showing finish button
        finishBtn.disabled = !testPassed;
    }
}

// Email validation function
function validateAdminEmail() {
    const emailInput = document.getElementById('adminEmail');
    const email = emailInput.value.trim();
    const errorDiv = document.getElementById('emailValidationError');
    const errorMessage = document.getElementById('emailErrorMessage');
    
    // Email regex pattern
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    // Check if email is empty
    if (!email) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Email address is required.';
        emailInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Check if email is valid format
    if (!emailPattern.test(email)) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Please enter a valid email address.';
        emailInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Check if domain is example.com
    const domain = email.split('@')[1].toLowerCase();
    if (domain === 'example.com') {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Please use a real email address. The domain "example.com" is not allowed.';
        emailInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Email is valid
    errorDiv.style.display = 'none';
    emailInput.style.borderColor = '#28a745';
    return true;
}

// Callsign validation function
function validateAdminCallsign() {
    const callsignInput = document.getElementById('adminCallsign');
    const callsign = callsignInput.value.trim().toUpperCase();
    const errorDiv = document.getElementById('callsignValidationError');
    const errorMessage = document.getElementById('callsignErrorMessage');
    
    // Update input to uppercase
    callsignInput.value = callsign;
    
    // Callsign regex pattern: alphanumeric and hyphens only, no spaces
    const callsignPattern = /^[A-Z0-9\-]+$/;
    
    // Check if callsign is empty
    if (!callsign) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Callsign is required.';
        callsignInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Check length (max 10 characters)
    if (callsign.length > 10) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Callsign must be 10 characters or less.';
        callsignInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Check if callsign matches pattern (alphanumeric and hyphens only)
    if (!callsignPattern.test(callsign)) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Callsign can only contain letters, numbers, and hyphens (no spaces).';
        callsignInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Callsign is valid
    errorDiv.style.display = 'none';
    callsignInput.style.borderColor = '#28a745';
    
    // Update domain previews with the new callsign
    updateDomainPreviewWithCallsign(callsign.toLowerCase());
    
    return true;
}

// Update domain preview with specific callsign
function updateDomainPreviewWithCallsign(callsign) {
    const introCallsign = document.getElementById('introCallsign');
    const preview1 = document.getElementById('domainPreview');
    const preview2 = document.getElementById('domainPreview2');
    const preview3 = document.getElementById('domainPreview3');
    
    if (introCallsign) introCallsign.textContent = callsign;
    if (preview1) preview1.textContent = callsign;
    if (preview2) preview2.textContent = callsign;
    if (preview3) preview3.textContent = callsign;
    
    // Update hostname internally if create domain is checked
    const createDomain = document.getElementById('createDomain').checked;
    if (createDomain) {
        document.getElementById('instanceHost').value = callsign + '.instance.ubersdr.org';
    }
}

// Check if callsign is available in the registry
async function validateCallsignAvailability() {
    const callsign = document.getElementById('adminCallsign').value.trim().toUpperCase();
    
    if (!callsign) {
        return false;
    }
    
    try {
        // Step 1: Check if callsign exists in registry
        const response = await fetch(`https://instances.ubersdr.org/api/callsign/${callsign}`);
        
        if (response.status === 404) {
            // Callsign not found - it's available!
            showCallsignStatus('success', 'Callsign is available');
            return true;
        }
        
        if (response.status === 200) {
            // Callsign exists - need to check if it's ours
            const registryData = await response.json();
            
            // Step 2: Get our SECRET UUID from config (this is the private instance_uuid)
            const ourSecretUUID = currentConfig.instance_reporting?.instance_uuid;
            
            if (!ourSecretUUID) {
                // We don't have a UUID yet (new instance) but callsign is taken
                showCallsignStatus('error', `Callsign ${callsign} is already registered to another instance`);
                return false;
            }
            
            // Step 3: Look up our public UUID using our SECRET UUID
            const lookupResponse = await fetch(`https://instances.ubersdr.org/api/lookup/${ourSecretUUID}`);
            
            if (lookupResponse.status === 200) {
                const ourData = await lookupResponse.json();
                
                // Step 4: Compare public UUIDs
                // ourData.public_uuid is OUR public UUID (looked up from our secret UUID)
                // registryData.public_uuid is the public UUID of whoever owns this callsign
                if (ourData.public_uuid === registryData.public_uuid) {
                    // It's OUR instance - allow it!
                    showCallsignStatus('success', 'This is your registered callsign');
                    return true;
                } else {
                    // Different instance owns this callsign
                    showCallsignStatus('error', `Callsign ${callsign} is already registered to another instance`);
                    return false;
                }
            } else {
                // Our secret UUID not found in registry yet (first time setup)
                // But callsign is already taken by someone else
                showCallsignStatus('error', `Callsign ${callsign} is already registered to another instance`);
                return false;
            }
        }
        
        // Other status codes - allow to proceed
        return true;
        
    } catch (error) {
        console.error('Error checking callsign availability:', error);
        // Network error - don't block the wizard
        showCallsignStatus('warning', 'Unable to check callsign availability (network error)');
        return true;
    }
}

function showCallsignStatus(type, message) {
    const errorDiv = document.getElementById('callsignValidationError');
    const errorMessage = document.getElementById('callsignErrorMessage');
    const callsignInput = document.getElementById('adminCallsign');
    const alertBox = document.getElementById('alertBox');
    
    if (type === 'error') {
        errorDiv.style.display = 'block';
        errorDiv.style.background = '#f8d7da';
        errorDiv.style.borderLeft = '4px solid #dc3545';
        errorMessage.textContent = message;
        callsignInput.style.borderColor = '#dc3545';
    } else if (type === 'success') {
        errorDiv.style.display = 'none';
        callsignInput.style.borderColor = '#28a745';
        // Clear any alert messages when validation succeeds
        if (alertBox) {
            alertBox.style.display = 'none';
        }
    } else if (type === 'warning') {
        errorDiv.style.display = 'block';
        errorDiv.style.background = '#fff3cd';
        errorDiv.style.borderLeft = '4px solid #ffc107';
        errorMessage.textContent = message;
        callsignInput.style.borderColor = '#ffc107';
    }
}

// Validation
async function validateCurrentStep() {
    if (currentStep === 2) {
        // Always validate admin email first
        if (!validateAdminEmail()) {
            showAlert('Please enter a valid email address that does not use example.com', 'error');
            return false;
        }
        
        // Validate callsign format second
        if (!validateAdminCallsign()) {
            showAlert('Please enter a valid callsign (max 10 characters, alphanumeric and hyphens only)', 'error');
            return false;
        }
        
        // Validate callsign availability third (async)
        if (!await validateCallsignAvailability()) {
            showAlert('This callsign is already registered to another instance. Please use a different callsign.', 'error');
            return false;
        }
        
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
        const createDomain = document.getElementById('createDomain').checked;
        const useMyIP = document.getElementById('useMyIP').checked;

        // Update instance_reporting section with defaults
        const updatedConfig = {
            ...currentConfig,
            instance_reporting: {
                ...currentConfig.instance_reporting,
                enabled: true,
                use_https: true,  // Default to HTTPS
                use_myip: createDomain ? false : useMyIP,
                hostname: 'instances.ubersdr.org',  // Default hostname
                port: 443,  // Default HTTPS port
                report_interval_sec: 120,  // Default 2 minutes
                instance_uuid: generatedUUID || currentConfig.instance_reporting?.instance_uuid || generateUUID(),
                create_domain: createDomain
            }
        };

        // Add instance connection details
        const instancePort = parseInt(document.getElementById('instancePort').value);

        if (createDomain) {
            // When using create domain, hostname is set internally
            const instanceHost = document.getElementById('instanceHost').value.trim();
            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: true
            };
        } else if (!useMyIP) {
            const instanceHost = document.getElementById('instanceHost').value.trim();
            const instanceTLS = document.getElementById('instanceTLS').checked;

            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: instanceTLS
            };
        } else {
            // When using myip, clear hostname and force TLS to false
            updatedConfig.instance_reporting.instance = {
                host: '',
                port: instancePort,
                tls: false
            };
        }
        
        // Save configuration with restart to apply instance_reporting changes
        const response = await fetch('/admin/config?restart=true', {
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
        showAlert(result.message || 'Configuration saved successfully! Server is restarting...', 'success');
        
        // Show restart countdown and redirect to admin panel
        setTimeout(() => {
            showRestartCountdown();
        }, 500);
        
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
    const finishButton = document.getElementById('finishBtn');
    const originalText = button.textContent;

    button.disabled = true;
    button.textContent = '⏳ Testing...';
    testResult.style.display = 'none';
    testPassed = false;

    try {
        // Generate UUID if it doesn't exist
        if (!generatedUUID && !currentConfig.instance_reporting?.instance_uuid) {
            generatedUUID = generateUUID();
            // Update the review display
            document.getElementById('reviewUUID').textContent = generatedUUID;
        }

        // Get form values for the test
        const createDomain = document.getElementById('createDomain').checked;
        const useMyIP = document.getElementById('useMyIP').checked;
        const instancePort = parseInt(document.getElementById('instancePort').value);

        // Build test parameters to send to the endpoint
        const testParams = {
            use_myip: createDomain ? false : useMyIP,
            // When create_domain is true, collector makes HTTP request, so use port 80 for test
            instance_port: createDomain ? 80 : instancePort,
            instance_uuid: generatedUUID || currentConfig.instance_reporting?.instance_uuid,
            create_domain: createDomain
        };

        if (createDomain) {
            // When using create domain, hostname is set internally
            const instanceHost = document.getElementById('instanceHost').value.trim();
            testParams.instance_host = instanceHost;
            // Collector ignores TLS and makes HTTP request when create_domain is true
            testParams.instance_tls = false;
        } else if (!useMyIP) {
            const instanceHost = document.getElementById('instanceHost').value.trim();
            const instanceTLS = document.getElementById('instanceTLS').checked;
            testParams.instance_host = instanceHost;
            testParams.instance_tls = instanceTLS;
        } else {
            // When using myip, clear hostname and force TLS to false
            testParams.instance_host = '';
            testParams.instance_tls = false;
        }

        // Trigger the test with parameters (no config save needed)
        const response = await fetch('/admin/instance-reporter-trigger', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testParams)
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
            // Show the success info box
            document.getElementById('successInfo').style.display = 'block';
            showAlert('✅ Test successful! You can now enable public reporting.', 'success');
        } else {
            testResult.style.background = '#f8d7da';
            testResult.style.border = '1px solid #f5c6cb';
            testResult.style.color = '#721c24';
            testPassed = false;
            finishButton.disabled = true;
            // Hide the success info box
            document.getElementById('successInfo').style.display = 'none';
            showAlert('⚠️ Test failed. Please check your settings and try again.', 'error');
        }
    } catch (error) {
        testResult.innerHTML = `<strong>❌ Test Failed:</strong><br>${error.message}`;
        testResult.style.display = 'block';
        testResult.style.background = '#f8d7da';
        testResult.style.border = '1px solid #f5c6cb';
        testResult.style.color = '#721c24';
        testPassed = false;
        finishButton.disabled = true;
        // Hide the success info box
        document.getElementById('successInfo').style.display = 'none';
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

// Show restart countdown overlay
function showRestartCountdown() {
    const overlay = document.getElementById('restartOverlay');
    const countdownEl = document.getElementById('countdownNumber');
    overlay.style.display = 'flex';

    let countdown = 15;
    countdownEl.textContent = countdown;

    const interval = setInterval(() => {
        countdown--;
        countdownEl.textContent = countdown;

        if (countdown <= 0) {
            clearInterval(interval);
            // Redirect to admin panel
            window.location.href = '/admin.html';
        }
    }, 1000);
}