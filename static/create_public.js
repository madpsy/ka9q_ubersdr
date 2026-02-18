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
    
    // Custom ingress - if generate_tls is explicitly false and TLS is enabled, assume custom ingress
    const hasCustomIngress = ir.instance?.tls && ir.generate_tls === false;
    document.getElementById('customIngress').checked = hasCustomIngress || false;
    
    // Check if tunnel service is enabled
    const useTunnelValue = ir.tunnel_server_enabled || false;
    document.getElementById('useTunnel').checked = useTunnelValue;
    
    // Default tunnel to true for new setups (when instance_reporting is not enabled)
    // If instance_reporting is already enabled, use the configured value
    // Tunnel and create_domain are mutually exclusive
    let createDomainValue;
    let useTunnelDefaultValue;

    if (ir.enabled) {
        // Instance reporting is already enabled - use the configured values
        useTunnelDefaultValue = useTunnelValue;
        createDomainValue = ir.create_domain || false;
    } else {
        // Instance reporting is NOT enabled yet - default to tunnel (easiest option for new setups)
        useTunnelDefaultValue = true;
        createDomainValue = false;
    }

    // Set the tunnel checkbox (may override the value loaded from config for new setups)
    document.getElementById('useTunnel').checked = useTunnelDefaultValue;
    document.getElementById('createDomain').checked = createDomainValue;

    // Update domain preview with callsign from config
    // This must happen BEFORE toggleManualConnectionFields which might trigger handleCreateDomainToggle or handleUseTunnelToggle
    updateDomainPreview();

    // Update manual connection fields visibility
    toggleManualConnectionFields();
    
    // Update custom ingress visibility based on loaded state
    updateCustomIngressVisibility();

    // Update review section with loaded config
    updateReviewSection();
    
    // Update test section visibility based on tunnel selection
    updateTestSectionVisibility();
    
    // If tunnel is checked, trigger the toggle to show the info box (after updateTestSectionVisibility)
    if (document.getElementById('useTunnel').checked) {
        handleUseTunnelToggle();
    } else if (document.getElementById('createDomain').checked) {
        // If create domain is checked, trigger the toggle to show the info box
        handleCreateDomainToggle();
    }
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
    
    // Use tunnel checkbox
    document.getElementById('useTunnel').addEventListener('change', function() {
        handleUseTunnelToggle();
        updateTestSectionVisibility();
        updateNavigationButtons(); // Update finish button state
    });
    
    // Create domain checkbox
    document.getElementById('createDomain').addEventListener('change', function() {
        handleCreateDomainToggle();
        updateTestSectionVisibility();
        updateNavigationButtons(); // Update finish button state
    });
    
    // Custom ingress checkbox
    document.getElementById('customIngress').addEventListener('change', function() {
        updatePortForwardingInstructions();
        updateReviewSection();
    });
    
    // Update review when fields change
    const fields = ['adminEmail', 'adminCallsign', 'useMyIP', 'instanceHost', 'instancePort', 'instanceTLS', 'useTunnel', 'createDomain', 'customIngress'];
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
        // Uncheck custom ingress when TLS is disabled
        document.getElementById('customIngress').checked = false;
    }
    
    updateCustomIngressVisibility();
    updatePortForwardingInstructions();
    updateReviewSection();
}

// Handle use tunnel checkbox toggle
function handleUseTunnelToggle() {
    const useTunnel = document.getElementById('useTunnel').checked;
    const createDomain = document.getElementById('createDomain');
    const createDomainField = document.getElementById('createDomainField');
    const manualConfigSection = document.getElementById('manualConfigSection');
    const tunnelInfo = document.getElementById('tunnelInfo');
    const domainInfo = document.getElementById('domainInfo');
    const portForwardingInfo = document.getElementById('portForwardingInfo');
    const instanceHostInput = document.getElementById('instanceHost');
    const portField = document.getElementById('instancePort');
    const tlsCheckbox = document.getElementById('instanceTLS');

    if (useTunnel) {
        // Uncheck create domain (mutually exclusive)
        createDomain.checked = false;

        // Hide create domain option
        if (createDomainField) {
            createDomainField.style.display = 'none';
        }

        // Hide manual configuration section
        manualConfigSection.style.display = 'none';

        // Hide other info boxes
        if (domainInfo) {
            domainInfo.style.display = 'none';
        }
        if (portForwardingInfo) {
            portForwardingInfo.style.display = 'none';
        }

        // Show tunnel info box
        tunnelInfo.style.display = 'block';

        // Set hostname internally - extract tunnel server host from config
        const callsignInput = document.getElementById('adminCallsign');
        const callsign = (callsignInput && callsignInput.value.trim())
            ? callsignInput.value.trim().toLowerCase()
            : (currentConfig.admin?.callsign || currentConfig.callsign || 'yourcallsign').toLowerCase();

        // Extract tunnel server host from config
        let tunnelHost = 'tunnel.ubersdr.org'; // default
        if (currentConfig.instance_reporting?.tunnel_server_host) {
            tunnelHost = currentConfig.instance_reporting.tunnel_server_host;
        }

        instanceHostInput.value = callsign + '.' + tunnelHost;

        // Auto-set port to 443 and enable TLS
        portField.value = '443';
        tlsCheckbox.checked = true;

        // Uncheck custom ingress when using tunnel
        document.getElementById('customIngress').checked = false;
    } else {
        // Show create domain option
        if (createDomainField) {
            createDomainField.style.display = 'block';
        }

        // Show manual configuration section
        manualConfigSection.style.display = 'block';

        // Show port forwarding info box
        if (portForwardingInfo) {
            portForwardingInfo.style.display = 'block';
        }

        // Hide tunnel info box
        tunnelInfo.style.display = 'none';

        // Clear hostname
        instanceHostInput.value = '';

        // Reset to defaults
        toggleManualConnectionFields();
    }

    updateCustomIngressVisibility();
    updateReviewSection();
}

// Handle create domain checkbox toggle
function handleCreateDomainToggle() {
    const createDomain = document.getElementById('createDomain').checked;
    const useTunnel = document.getElementById('useTunnel');
    const useTunnelField = document.getElementById('useTunnelField');
    const manualConfigSection = document.getElementById('manualConfigSection');
    const domainInfo = document.getElementById('domainInfo');
    const tunnelInfo = document.getElementById('tunnelInfo');
    const portForwardingInfo = document.getElementById('portForwardingInfo');
    const instanceHostInput = document.getElementById('instanceHost');
    const portField = document.getElementById('instancePort');
    const tlsCheckbox = document.getElementById('instanceTLS');

    if (createDomain) {
        // Uncheck tunnel (mutually exclusive)
        useTunnel.checked = false;

        // Hide tunnel option
        if (useTunnelField) {
            useTunnelField.style.display = 'none';
        }

        // Hide manual configuration section
        manualConfigSection.style.display = 'none';

        // Hide other info boxes
        if (tunnelInfo) {
            tunnelInfo.style.display = 'none';
        }
        if (portForwardingInfo) {
            portForwardingInfo.style.display = 'none';
        }

        // Show DNS info box
        domainInfo.style.display = 'block';

        // Set hostname internally (not visible to user) - use form input value
        const callsignInput = document.getElementById('adminCallsign');
        const callsign = (callsignInput && callsignInput.value.trim())
            ? callsignInput.value.trim().toLowerCase()
            : (currentConfig.admin?.callsign || currentConfig.callsign || 'yourcallsign').toLowerCase();
        instanceHostInput.value = callsign + '.instance.ubersdr.org';

        // Auto-set port to 443 and enable TLS
        portField.value = '443';
        tlsCheckbox.checked = true;

        // Uncheck custom ingress when using create domain
        document.getElementById('customIngress').checked = false;
    } else {
        // Show tunnel option
        if (useTunnelField) {
            useTunnelField.style.display = 'block';
        }

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

    updateCustomIngressVisibility();
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
        // Uncheck custom ingress when using auto IP
        document.getElementById('customIngress').checked = false;
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

    updateCustomIngressVisibility();
    updatePortForwardingInstructions();
    updateReviewSection();
}

// Update custom ingress field visibility
function updateCustomIngressVisibility() {
    const instanceTLS = document.getElementById('instanceTLS').checked;
    const customIngressField = document.getElementById('customIngressField');
    
    // Show custom ingress checkbox only if TLS is checked
    if (instanceTLS) {
        customIngressField.style.display = 'block';
    } else {
        customIngressField.style.display = 'none';
        // Uncheck it when hiding
        document.getElementById('customIngress').checked = false;
    }
}

// Update port forwarding instructions based on current state
function updatePortForwardingInstructions() {
    const useMyIP = document.getElementById('useMyIP').checked;
    const instanceTLS = document.getElementById('instanceTLS').checked;
    const customIngress = document.getElementById('customIngress').checked;
    const portForwardingUseMyIP = document.getElementById('portForwardingUseMyIP');
    const portForwardingNoTLS = document.getElementById('portForwardingNoTLS');
    const portForwardingWithTLS = document.getElementById('portForwardingWithTLS');
    const portForwardingCustomIngress = document.getElementById('portForwardingCustomIngress');

    // Hide all sections first
    if (portForwardingUseMyIP) portForwardingUseMyIP.style.display = 'none';
    if (portForwardingNoTLS) portForwardingNoTLS.style.display = 'none';
    if (portForwardingWithTLS) portForwardingWithTLS.style.display = 'none';
    if (portForwardingCustomIngress) portForwardingCustomIngress.style.display = 'none';

    if (useMyIP) {
        // Show simplified instructions for auto IP
        if (portForwardingUseMyIP) portForwardingUseMyIP.style.display = 'block';
    } else {
        // Manual configuration
        if (instanceTLS && customIngress) {
            // Show custom ingress instructions
            if (portForwardingCustomIngress) portForwardingCustomIngress.style.display = 'block';
        } else if (instanceTLS) {
            // Show TLS/domain instructions
            if (portForwardingWithTLS) portForwardingWithTLS.style.display = 'block';
        } else {
            // Show non-TLS instructions
            if (portForwardingNoTLS) portForwardingNoTLS.style.display = 'block';
        }
    }
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
    const useTunnel = document.getElementById('useTunnel').checked;
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

    // Show tunnel status (only if tunnel is selected)
    if (useTunnel) {
        document.getElementById('reviewTunnelItem').style.display = 'flex';
        document.getElementById('reviewTunnel').textContent = 'Yes (' + instanceHost + ')';
        // Hide port, create domain, and other connection details when tunnel is selected
        document.getElementById('reviewPortItem').style.display = 'none';
        document.getElementById('reviewDomainItem').style.display = 'none';
        document.getElementById('reviewHostItem').style.display = 'none';
        document.getElementById('reviewTLSItem').style.display = 'none';
        document.getElementById('reviewUseMyIP').parentElement.style.display = 'none';
    } else if (createDomain) {
        // Show create domain status
        document.getElementById('reviewTunnelItem').style.display = 'none';
        document.getElementById('reviewDomainItem').style.display = 'flex';
        document.getElementById('reviewDomain').textContent = 'Yes (' + instanceHost + ')';
        // Show port for create domain
        document.getElementById('reviewPortItem').style.display = 'flex';
        document.getElementById('reviewPort').textContent = instancePort;
        // Hide other connection details
        document.getElementById('reviewHostItem').style.display = 'none';
        document.getElementById('reviewTLSItem').style.display = 'none';
        document.getElementById('reviewUseMyIP').parentElement.style.display = 'none';
    } else {
        // Manual configuration - show all relevant fields
        document.getElementById('reviewTunnelItem').style.display = 'none';
        document.getElementById('reviewDomainItem').style.display = 'none';
        
        // Connection settings
        document.getElementById('reviewUseMyIP').textContent = useMyIP ? 'Yes' : 'No';

        // Always show port
        document.getElementById('reviewPortItem').style.display = 'flex';
        document.getElementById('reviewPort').textContent = instancePort;

        // Show hostname and TLS based on useMyIP
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

// Update test section visibility based on tunnel selection
function updateTestSectionVisibility() {
    const useTunnel = document.getElementById('useTunnel').checked;
    const testSection = document.getElementById('testSection');
    
    if (testSection) {
        if (useTunnel) {
            // Hide test section for tunnel service
            testSection.style.display = 'none';
        } else {
            // Show test section for other options
            testSection.style.display = 'block';
        }
    }
}

// Navigation functions
async function nextStep() {
    if (await validateCurrentStep()) {
        if (currentStep < 3) {
            // Show email verification modal when moving from step 2 to step 3
            if (currentStep === 2) {
                showEmailVerificationModal();
            } else {
                currentStep++;
                showStep(currentStep);
            }
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
        // Check if tunnel service is selected - if so, skip test requirement
        const useTunnel = document.getElementById('useTunnel').checked;
        if (useTunnel) {
            // Tunnel service doesn't require testing (will work after restart)
            finishBtn.disabled = false;
        } else {
            // Other options require testing
            finishBtn.disabled = !testPassed;
        }
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
    
    // Check if callsign starts or ends with a hyphen
    if (callsign.startsWith('-') || callsign.endsWith('-')) {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Callsign cannot start or end with a hyphen.';
        callsignInput.style.borderColor = '#dc3545';
        return false;
    }
    
    // Check if callsign is N0CALL (placeholder callsign)
    if (callsign === 'N0CALL') {
        errorDiv.style.display = 'block';
        errorMessage.textContent = 'Please use a real callsign. "N0CALL" is a placeholder and not allowed.';
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
    const introCallsignTunnel = document.getElementById('introCallsignTunnel');
    const preview1 = document.getElementById('domainPreview');
    const preview2 = document.getElementById('domainPreview2');
    const preview3 = document.getElementById('domainPreview3');
    const tunnelPreview = document.getElementById('tunnelPreview');
    const tunnelPreview2 = document.getElementById('tunnelPreview2');
    const tunnelPreview3 = document.getElementById('tunnelPreview3');

    if (introCallsign) introCallsign.textContent = callsign;
    if (introCallsignTunnel) introCallsignTunnel.textContent = callsign;
    if (preview1) preview1.textContent = callsign;
    if (preview2) preview2.textContent = callsign;
    if (preview3) preview3.textContent = callsign;
    if (tunnelPreview) tunnelPreview.textContent = callsign;
    if (tunnelPreview2) tunnelPreview2.textContent = callsign;
    if (tunnelPreview3) tunnelPreview3.textContent = callsign;

    // Update hostname internally if create domain or tunnel is checked
    const createDomain = document.getElementById('createDomain').checked;
    const useTunnel = document.getElementById('useTunnel').checked;

    if (createDomain) {
        document.getElementById('instanceHost').value = callsign + '.instance.ubersdr.org';
    } else if (useTunnel) {
        // Extract tunnel server host from config
        let tunnelHost = 'tunnel.ubersdr.org'; // default
        if (currentConfig.instance_reporting?.tunnel_server_host) {
            tunnelHost = currentConfig.instance_reporting.tunnel_server_host;
        }
        document.getElementById('instanceHost').value = callsign + '.' + tunnelHost;
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
        const createDomain = document.getElementById('createDomain').checked;
        const useTunnel = document.getElementById('useTunnel').checked;

        if (!useMyIP && !createDomain && !useTunnel) {
            const host = document.getElementById('instanceHost').value.trim();
            const port = parseInt(document.getElementById('instancePort').value);

            if (!host) {
                showAlert('Please enter a fully qualified domain name', 'error');
                return false;
            }

            // Validate that host is a domain name, not an IP address
            if (!validateDomainName(host)) {
                showAlert('Please enter a valid domain name (not an IP address). Use "Automatically use my public IP address" if you want to use an IP address.', 'error');
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

// Validate that a string is a domain name and not an IP address
function validateDomainName(host) {
    // Check if it's an IPv4 address
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Pattern.test(host)) {
        return false; // It's an IP address
    }
    
    // Check if it's an IPv6 address (simplified check)
    if (host.includes(':') && /^[0-9a-fA-F:]+$/.test(host)) {
        return false; // It's likely an IPv6 address
    }
    
    // Check if it looks like a domain name (contains at least one dot and valid characters)
    const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!domainPattern.test(host)) {
        return false; // Invalid domain format
    }
    
    // Must contain at least one dot (e.g., example.com)
    if (!host.includes('.')) {
        return false;
    }
    
    return true; // It's a valid domain name
}

// Finish wizard and save configuration
async function finishWizard() {
    // Check if tunnel service is selected
    const useTunnel = document.getElementById('useTunnel').checked;
    
    // Check if test has passed (skip for tunnel service)
    if (!useTunnel && !testPassed) {
        showAlert('⚠️ You must successfully test the configuration before enabling public reporting.', 'error');
        return;
    }

    try {
        showAlert('Saving configuration...', 'info');

        // Get the updated email and callsign from the form
        const adminEmail = document.getElementById('adminEmail').value.trim();
        const adminCallsign = document.getElementById('adminCallsign').value.trim().toUpperCase();

        // Build the configuration update with default values
        const createDomain = document.getElementById('createDomain').checked;
        const useMyIP = document.getElementById('useMyIP').checked;

        // Update both admin section and instance_reporting section
        const updatedConfig = {
            ...currentConfig,
            admin: {
                ...currentConfig.admin,
                email: adminEmail,
                callsign: adminCallsign
            },
            instance_reporting: {
                ...currentConfig.instance_reporting,
                enabled: true,
                use_https: true,  // Default to HTTPS
                use_myip: (createDomain || useTunnel) ? false : useMyIP,
                hostname: 'instances.ubersdr.org',  // Default hostname
                port: 443,  // Default HTTPS port
                report_interval_sec: 120,  // Default 2 minutes
                // Generate UUID if needed (for tunnel service, this happens here since no test is required)
                instance_uuid: generatedUUID || currentConfig.instance_reporting?.instance_uuid || generateUUID(),
                create_domain: createDomain,
                tunnel_server_enabled: useTunnel
            }
        };

        // Add instance connection details
        const instancePort = parseInt(document.getElementById('instancePort').value);
        const customIngress = document.getElementById('customIngress').checked;

        if (useTunnel) {
            // When using tunnel, hostname is set internally
            const instanceHost = document.getElementById('instanceHost').value.trim();
            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: true
            };
            // Disable TLS certificate generation when using tunnel (tunnel handles TLS)
            updatedConfig.instance_reporting.generate_tls = false;
        } else if (createDomain) {
            // When using create domain, hostname is set internally
            const instanceHost = document.getElementById('instanceHost').value.trim();
            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: true
            };
            // Enable TLS certificate generation when using create domain (unless custom ingress)
            updatedConfig.instance_reporting.generate_tls = !customIngress;
        } else if (!useMyIP) {
            const instanceHost = document.getElementById('instanceHost').value.trim();
            const instanceTLS = document.getElementById('instanceTLS').checked;

            updatedConfig.instance_reporting.instance = {
                host: instanceHost,
                port: instancePort,
                tls: instanceTLS
            };
            // Enable TLS certificate generation when TLS is enabled with custom domain (unless custom ingress)
            updatedConfig.instance_reporting.generate_tls = instanceTLS && !customIngress;
        } else {
            // When using myip, clear hostname and force TLS to false
            updatedConfig.instance_reporting.instance = {
                host: '',
                port: instancePort,
                tls: false
            };
            // Disable TLS certificate generation when using IP address
            updatedConfig.instance_reporting.generate_tls = false;
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
        const adminEmail = document.getElementById('adminEmail').value.trim();
        const adminCallsign = document.getElementById('adminCallsign').value.trim().toUpperCase();
        const createDomain = document.getElementById('createDomain').checked;
        const useTunnel = document.getElementById('useTunnel').checked;
        const useMyIP = document.getElementById('useMyIP').checked;
        const instancePort = parseInt(document.getElementById('instancePort').value);

        // Build test parameters to send to the endpoint
        const testParams = {
            admin_email: adminEmail,
            admin_callsign: adminCallsign,
            use_myip: (createDomain || useTunnel) ? false : useMyIP,
            // When create_domain or useTunnel is true, collector makes HTTP request, so use port 80 for test
            instance_port: (createDomain || useTunnel) ? 80 : instancePort,
            instance_uuid: generatedUUID || currentConfig.instance_reporting?.instance_uuid,
            create_domain: createDomain
        };

        if (useTunnel) {
            // When using tunnel, hostname is set internally
            const instanceHost = document.getElementById('instanceHost').value.trim();
            testParams.instance_host = instanceHost;
            // Collector ignores TLS and makes HTTP request when tunnel is used
            testParams.instance_tls = false;
        } else if (createDomain) {
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

        // Always parse as JSON since the endpoint always returns JSON now
        const result = await response.json();

        // Check if the request failed
        if (!response.ok || result.status === 'error') {
            // Extract error details from JSON response
            const errorMsg = result.message || 'Failed to trigger instance reporter';
            throw new Error(errorMsg);
        }

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
            // Don't show alert - the test result box already shows the error details
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
        // Don't show alert - the test result box already shows the error
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
    const emailAddressEl = document.getElementById('overlayEmailAddress');
    overlay.style.display = 'flex';

    // Set the email address in the overlay
    const adminEmail = document.getElementById('adminEmail').value.trim();
    if (emailAddressEl && adminEmail) {
        emailAddressEl.textContent = adminEmail;
    }

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

// Show email verification modal
function showEmailVerificationModal() {
    const modal = document.getElementById('emailVerificationModal');
    const displayEmail = document.getElementById('modalDisplayEmail');
    const confirmInput = document.getElementById('emailConfirmInput');
    const errorDiv = document.getElementById('emailMismatchError');
    
    // Get the email from the form
    const adminEmail = document.getElementById('adminEmail').value.trim();
    
    // Display the email in the modal
    displayEmail.textContent = adminEmail;
    
    // Clear the confirmation input and error
    confirmInput.value = '';
    errorDiv.style.display = 'none';
    
    // Show the modal
    modal.style.display = 'flex';
    
    // Focus on the input field
    setTimeout(() => {
        confirmInput.focus();
    }, 100);
    
    // Add enter key listener to confirm input
    confirmInput.onkeypress = function(e) {
        if (e.key === 'Enter') {
            confirmEmailVerification();
        }
    };
}

// Cancel email verification and go back
function cancelEmailVerification() {
    const modal = document.getElementById('emailVerificationModal');
    modal.style.display = 'none';
}

// Confirm email verification
function confirmEmailVerification() {
    const originalEmail = document.getElementById('adminEmail').value.trim().toLowerCase();
    const confirmEmail = document.getElementById('emailConfirmInput').value.trim().toLowerCase();
    const errorDiv = document.getElementById('emailMismatchError');
    const confirmButton = document.getElementById('confirmEmailButton');
    
    // Check if emails match
    if (originalEmail !== confirmEmail) {
        errorDiv.style.display = 'block';
        document.getElementById('emailConfirmInput').style.borderColor = '#dc3545';
        return;
    }
    
    // Emails match - proceed to next step
    errorDiv.style.display = 'none';
    confirmButton.disabled = true;
    confirmButton.textContent = 'Proceeding...';
    
    // Hide modal
    const modal = document.getElementById('emailVerificationModal');
    modal.style.display = 'none';
    
    // Move to next step
    currentStep++;
    showStep(currentStep);
    
    // Reset button state
    setTimeout(() => {
        confirmButton.disabled = false;
        confirmButton.textContent = 'Confirm';
    }, 500);
}