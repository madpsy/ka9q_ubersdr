// Setup Wizard JavaScript
(function() {
    'use strict';

    // State management
    let currentStep = 1;
    const totalSteps = 4;
    let formData = {};
    let map = null;
    let marker = null;

    // DOM elements
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const errorMessage = document.getElementById('errorMessage');
    const successMessage = document.getElementById('successMessage');
    const loadingState = document.getElementById('loadingState');

    // Initialize wizard
    function init() {
        setupEventListeners();
        updateUI();
        initializeMap();
        loadExistingConfig(); // Load config after map is initialized
        
        // Auto-fill callsign fields when main callsign is entered
        document.getElementById('callsign').addEventListener('input', function(e) {
            const callsign = e.target.value.toUpperCase();
            document.getElementById('dxclusterCallsign').value = callsign;
            document.getElementById('receiverCallsign').value = callsign;
        });

        // Auto-calculate Maidenhead locator when lat/lon changes
        document.getElementById('latitude').addEventListener('input', updateMaidenheadLocator);
        document.getElementById('longitude').addEventListener('input', updateMaidenheadLocator);

        // Toggle conditional sections
        document.getElementById('dxclusterEnabled').addEventListener('change', function(e) {
            document.getElementById('dxclusterSettings').style.display = e.target.checked ? 'block' : 'none';
        });

        document.getElementById('decoderEnabled').addEventListener('change', function(e) {
            document.getElementById('decoderSettings').style.display = e.target.checked ? 'block' : 'none';
        });

        // Ensure conditional sections are visible on load for checkboxes that are checked by default
        if (document.getElementById('dxclusterEnabled').checked) {
            document.getElementById('dxclusterSettings').style.display = 'block';
        }
        if (document.getElementById('decoderEnabled').checked) {
            document.getElementById('decoderSettings').style.display = 'block';
        }

        // Password generator
        document.getElementById('generatePassword').addEventListener('click', generatePassword);
    }

    function setupEventListeners() {
        prevBtn.addEventListener('click', previousStep);
        nextBtn.addEventListener('click', nextStep);
    }

    function updateUI() {
        // Update progress bar
        document.querySelectorAll('.progress-step').forEach(step => {
            const stepNum = parseInt(step.dataset.step);
            step.classList.remove('active', 'completed');
            
            if (stepNum === currentStep) {
                step.classList.add('active');
            } else if (stepNum < currentStep) {
                step.classList.add('completed');
            }
        });

        // Update step visibility
        document.querySelectorAll('.wizard-step').forEach(step => {
            step.classList.remove('active');
            if (parseInt(step.dataset.step) === currentStep) {
                step.classList.add('active');
            }
        });

        // Refresh map when returning to step 1
        if (currentStep === 1 && map) {
            setTimeout(() => {
                map.invalidateSize();
            }, 100);
        }

        // Update button visibility and text
        prevBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
        
        if (currentStep === totalSteps) {
            nextBtn.textContent = 'Complete Setup';
        } else {
            nextBtn.textContent = 'Next →';
        }

        // Hide messages when changing steps
        hideMessages();
    }

    function previousStep() {
        if (currentStep > 1) {
            currentStep--;
            updateUI();
        }
    }

    async function nextStep() {
        // Validate current step
        if (!validateStep(currentStep)) {
            return;
        }

        // Collect data from current step
        collectStepData(currentStep);

        if (currentStep < totalSteps) {
            currentStep++;
            updateUI();
        } else {
            // Final step - save configuration
            await saveConfiguration();
        }
    }

    function validateStep(step) {
        hideMessages();
        
        const stepElement = document.querySelector(`.wizard-step[data-step="${step}"]`);
        const requiredFields = stepElement.querySelectorAll('[required]');
        
        // Step 1 specific validation
        if (step === 1) {
            // Validate callsign
            const callsignField = document.getElementById('callsign');
            if (callsignField) {
                const callsign = callsignField.value.trim().toUpperCase();
                
                if (!callsign) {
                    showError('Callsign is required');
                    callsignField.focus();
                    return false;
                }
                
                // Check length (max 10 characters)
                if (callsign.length > 10) {
                    showError('Callsign must be 10 characters or less');
                    callsignField.focus();
                    return false;
                }
                
                // Callsign pattern: alphanumeric and hyphens only, no spaces
                if (!/^[A-Z0-9\-]+$/.test(callsign)) {
                    showError('Callsign can only contain letters, numbers, and hyphens (no spaces)');
                    callsignField.focus();
                    return false;
                }
                
                // Check if callsign starts or ends with a hyphen
                if (callsign.startsWith('-') || callsign.endsWith('-')) {
                    showError('Callsign cannot start or end with a hyphen');
                    callsignField.focus();
                    return false;
                }
                
                // Check if callsign is N0CALL (placeholder)
                if (callsign === 'N0CALL') {
                    showError('Please use a real callsign. "N0CALL" is a placeholder and not allowed');
                    callsignField.focus();
                    return false;
                }
            }
            
            // Validate email
            const emailField = document.getElementById('email');
            if (emailField) {
                const email = emailField.value.trim();
                
                if (!email) {
                    showError('Email address is required');
                    emailField.focus();
                    return false;
                }
                
                // Email pattern
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    showError('Please enter a valid email address');
                    emailField.focus();
                    return false;
                }
                
                // Check if domain is example.com
                const domain = email.split('@')[1].toLowerCase();
                if (domain === 'example.com') {
                    showError('Please use a real email address. The domain "example.com" is not allowed');
                    emailField.focus();
                    return false;
                }
            }
        }
        
        for (const field of requiredFields) {
            // Skip validation if field is in a hidden conditional section
            const conditionalParent = field.closest('.conditional-section');
            if (conditionalParent && conditionalParent.style.display === 'none') {
                continue;
            }

            if (!field.value.trim()) {
                showError(`Please fill in all required fields: ${field.previousElementSibling.textContent}`);
                field.focus();
                return false;
            }

            // Locator validation (basic)
            if (field.id === 'receiverLocator' && field.value.trim()) {
                if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(field.value)) {
                    showError('Locator should be in format: FN42 or FN42ab');
                    field.focus();
                    return false;
                }
            }
        }

        return true;
    }

    function collectStepData(step) {
        const stepElement = document.querySelector(`.wizard-step[data-step="${step}"]`);
        const inputs = stepElement.querySelectorAll('input, textarea, select');
        
        inputs.forEach(input => {
            if (input.type === 'checkbox') {
                formData[input.name] = input.checked;
            } else {
                formData[input.name] = input.value;
            }
        });
    }

    async function loadExistingConfig() {
        try {
            // Try to load existing config to pre-fill fields
            const response = await fetch('/admin/config');
            
            // If unauthorized, redirect to admin login
            if (response.status === 401) {
                window.location.href = '/admin.html';
                return;
            }
            
            if (response.ok) {
                const config = await response.json();
                
                // Pre-fill admin fields
                if (config.admin) {
                    setFieldValue('callsign', config.admin.callsign);
                    setFieldValue('stationName', config.admin.name);
                    setFieldValue('email', config.admin.email);
                    setFieldValue('description', config.admin.description);
                    setFieldValue('location', config.admin.location);
                    setFieldValue('latitude', config.admin.gps?.lat);
                    setFieldValue('longitude', config.admin.gps?.lon);
                    setFieldValue('asl', config.admin.asl);

                    // Update map with loaded coordinates
                    if (config.admin.gps?.lat && config.admin.gps?.lon && map && marker) {
                        const lat = config.admin.gps.lat;
                        const lon = config.admin.gps.lon;
                        marker.setLatLng([lat, lon]);
                        map.setView([lat, lon], 10);
                        updateMarkerTooltip();
                        updateMaidenheadLocator();
                    }
                }

                // Pre-fill server fields
                if (config.server) {
                    setFieldValue('maxSessionTime', config.server.max_session_time);
                    setFieldValue('maxSessions', config.server.max_sessions);
                    setFieldValue('maxSessionsIP', config.server.max_sessions_ip);
                }

                // Pre-fill DX cluster fields
                if (config.dxcluster) {
                    setCheckboxValue('dxclusterEnabled', config.dxcluster.enabled);
                    setFieldValue('dxclusterCallsign', config.dxcluster.callsign);
                    toggleConditionalSection('dxclusterEnabled', 'dxclusterSettings');
                }
            }

            // Try to load decoder config
            const decoderResponse = await fetch('/admin/decoder-config');
            
            // If unauthorized, redirect to admin login
            if (decoderResponse.status === 401) {
                window.location.href = '/admin.html';
                return;
            }
            
            if (decoderResponse.ok) {
                const decoderConfig = await decoderResponse.json();
                
                if (decoderConfig.decoder) {
                    setCheckboxValue('decoderEnabled', decoderConfig.decoder.enabled);
                    setFieldValue('receiverCallsign', decoderConfig.decoder.receiver_callsign);
                    setFieldValue('receiverLocator', decoderConfig.decoder.receiver_locator);
                    setFieldValue('receiverAntenna', decoderConfig.decoder.receiver_antenna);
                    
                    // Only load PSKReporter/WSPRNet values if decoder is already enabled
                    // If decoder is disabled (default), keep the HTML default (checked)
                    if (decoderConfig.decoder.enabled) {
                        setCheckboxValue('pskreporterEnabled', decoderConfig.decoder.pskreporter_enabled);
                        setCheckboxValue('wsprnetEnabled', decoderConfig.decoder.wsprnet_enabled);
                    }
                    
                    toggleConditionalSection('decoderEnabled', 'decoderSettings');
                }
            }
        } catch (error) {
            console.log('Could not load existing config (this is normal for first-time setup)');
        }
    }

    async function saveConfiguration() {
        showLoading();
        hideMessages();

        try {
            // Load existing config first to preserve all fields
            const existingConfigResponse = await fetch('/admin/config');
            if (!existingConfigResponse.ok) {
                throw new Error('Failed to load existing configuration');
            }
            const existingConfig = await existingConfigResponse.json();

            // Merge wizard changes into existing config
            const mainConfig = {
                ...existingConfig,
                admin: {
                    ...existingConfig.admin,
                    callsign: formData.callsign.toUpperCase(),
                    name: formData.stationName,
                    email: formData.email,
                    description: formData.description || '',
                    location: formData.location,
                    gps: {
                        lat: parseFloat(formData.latitude),
                        lon: parseFloat(formData.longitude)
                    },
                    asl: parseInt(formData.asl)
                },
                server: {
                    ...existingConfig.server,
                    bypass_password: formData.bypassPassword || existingConfig.server?.bypass_password || "",
                    max_session_time: parseInt(formData.maxSessionTime),
                    max_sessions: parseInt(formData.maxSessions),
                    max_sessions_ip: parseInt(formData.maxSessionsIP)
                },
                dxcluster: {
                    ...existingConfig.dxcluster,
                    enabled: formData.dxclusterEnabled,
                    callsign: formData.dxclusterEnabled ? formData.dxclusterCallsign.toUpperCase() : ''
                }
            };

            // Save main config (no restart yet)
            const mainResponse = await fetch('/admin/config', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(mainConfig)
            });

            if (!mainResponse.ok) {
                throw new Error('Failed to save main configuration');
            }

            // Prepare decoder config if enabled
            if (formData.decoderEnabled) {
                // Load existing decoder config to preserve all fields
                const existingDecoderResponse = await fetch('/admin/decoder-config');
                let existingDecoderConfig = {};
                let existingBands = [];

                if (existingDecoderResponse.ok) {
                    existingDecoderConfig = await existingDecoderResponse.json();
                    if (existingDecoderConfig.decoder && existingDecoderConfig.decoder.bands) {
                        existingBands = existingDecoderConfig.decoder.bands;
                    }
                }

                // Enable/disable existing bands based on checkbox state
                if (existingBands.length > 0) {
                    existingBands.forEach(band => {
                        if (band.mode === 'FT8') {
                            band.enabled = formData.ft8Enabled || false;
                        } else if (band.mode === 'FT4') {
                            band.enabled = formData.ft4Enabled || false;
                        } else if (band.mode === 'WSPR') {
                            band.enabled = formData.wsprEnabled || false;
                        } else if (band.mode === 'JS8') {
                            band.enabled = formData.js8Enabled || false;
                        }
                    });
                }

                // Merge wizard changes into existing decoder config
                const decoderConfig = {
                    ...existingDecoderConfig,
                    decoder: {
                        ...existingDecoderConfig.decoder,
                        enabled: true,
                        receiver_callsign: formData.receiverCallsign.toUpperCase(),
                        receiver_locator: formData.receiverLocator.toUpperCase(),
                        receiver_antenna: formData.receiverAntenna || '',
                        pskreporter_enabled: formData.pskreporterEnabled,
                        wsprnet_enabled: formData.wsprnetEnabled,
                        bands: existingBands
                    }
                };

                // Save decoder config
                const decoderResponse = await fetch('/admin/decoder-config', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(decoderConfig)
                });

                if (!decoderResponse.ok) {
                    throw new Error('Failed to save decoder configuration');
                }
            }

            // Mark wizard as complete
            const wizardResponse = await fetch('/admin/wizard-complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!wizardResponse.ok) {
                throw new Error('Failed to mark wizard as complete');
            }

            // Success! Show restart countdown
            hideLoading();
            showSuccess('Configuration saved successfully! Server is restarting...');
            
            // Show restart countdown and redirect
            setTimeout(() => {
                showRestartCountdown();
            }, 500);

        } catch (error) {
            hideLoading();
            showError(`Failed to save configuration: ${error.message}`);
            console.error('Configuration save error:', error);
        }
    }

    function generatePassword() {
        const length = 16;
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        
        const passwordField = document.getElementById('bypassPassword');
        const generatedPasswordDiv = document.getElementById('generatedPassword');
        
        passwordField.value = password;
        generatedPasswordDiv.textContent = password;
        generatedPasswordDiv.style.display = 'block';
    }

    function initializeMap() {
        // Get initial coordinates or use default (London, UK)
        const latInput = document.getElementById('latitude');
        const lonInput = document.getElementById('longitude');
        const initialLat = parseFloat(latInput.value) || 51.5074;
        const initialLon = parseFloat(lonInput.value) || -0.1278;

        // Initialize map
        map = L.map('location-map').setView([initialLat, initialLon], 10);
        
        // Request user's location via browser geolocation API
        // Trigger if no coordinates OR if coordinates are the default London values
        const currentLat = parseFloat(latInput.value);
        const currentLon = parseFloat(lonInput.value);
        const isDefaultLocation = (
            (!latInput.value && !lonInput.value) ||
            (Math.abs(currentLat - 51.5074) < 0.001 && Math.abs(currentLon - (-0.1278)) < 0.001)
        );
        
        if (navigator.geolocation && isDefaultLocation) {
            navigator.geolocation.getCurrentPosition(
                function(position) {
                    // Success - update map and inputs with user's location
                    const userLat = position.coords.latitude;
                    const userLon = position.coords.longitude;
                    
                    latInput.value = userLat.toFixed(6);
                    lonInput.value = userLon.toFixed(6);
                    
                    marker.setLatLng([userLat, userLon]);
                    map.setView([userLat, userLon], 10);
                    updateMarkerTooltip();
                    updateMaidenheadLocator();
                },
                function(error) {
                    // Error or user denied - silently continue with default location
                    console.log('Geolocation not available or denied:', error.message);
                },
                {
                    enableHighAccuracy: false,
                    timeout: 5000,
                    maximumAge: 0
                }
            );
        }

        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(map);

        // Add draggable marker
        marker = L.marker([initialLat, initialLon], {
            draggable: true
        }).addTo(map);

        // Update inputs when marker is dragged
        marker.on('dragend', function(e) {
            const position = marker.getLatLng();
            latInput.value = position.lat.toFixed(6);
            lonInput.value = position.lng.toFixed(6);
            updateMarkerTooltip();
            updateMaidenheadLocator();
        });

        // Update marker when inputs change
        latInput.addEventListener('input', updateMarkerFromInputs);
        lonInput.addEventListener('input', updateMarkerFromInputs);

        // Also update tooltip when other fields change
        document.getElementById('stationName').addEventListener('input', updateMarkerTooltip);
        document.getElementById('location').addEventListener('input', updateMarkerTooltip);
        document.getElementById('asl').addEventListener('input', updateMarkerTooltip);

        // Allow clicking on map to move marker
        map.on('click', function(e) {
            marker.setLatLng(e.latlng);
            latInput.value = e.latlng.lat.toFixed(6);
            lonInput.value = e.latlng.lng.toFixed(6);
            updateMarkerTooltip();
            updateMaidenheadLocator();
        });

        // Initial tooltip update (after event listeners are set up)
        updateMarkerTooltip();
    }

    function updateMarkerFromInputs() {
        const latInput = document.getElementById('latitude');
        const lonInput = document.getElementById('longitude');
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);

        if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            marker.setLatLng([lat, lon]);
            map.setView([lat, lon], map.getZoom());
            updateMarkerTooltip();
        }
    }

    function updateMarkerTooltip() {
        if (!marker) return;

        // Get current form values
        const stationName = document.getElementById('stationName').value || 'Station';
        const location = document.getElementById('location').value || '';
        const asl = document.getElementById('asl').value || '0';

        // Build tooltip content
        let tooltipContent = `<strong>${stationName}</strong>`;
        if (location) {
            tooltipContent += `<br>${location}`;
        }
        tooltipContent += `<br>${asl}m ASL`;

        // Update or create tooltip
        marker.bindTooltip(tooltipContent, {
            permanent: true,
            direction: 'top',
            className: 'receiver-tooltip'
        }).openTooltip();
    }

    function updateMaidenheadLocator() {
        const latInput = document.getElementById('latitude');
        const lonInput = document.getElementById('longitude');
        const locatorInput = document.getElementById('receiverLocator');
        
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);
        
        // Only update if we have valid coordinates
        if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            try {
                // Calculate 6-character Maidenhead locator (field + square + subsquare)
                const locator = latLonToMaidenhead(lat, lon, 3);
                locatorInput.value = locator;
            } catch (error) {
                console.error('Error calculating Maidenhead locator:', error);
            }
        }
    }

    // Helper functions
    function setFieldValue(fieldId, value) {
        const field = document.getElementById(fieldId);
        if (field && value !== undefined && value !== null) {
            field.value = value;
        }
    }

    function setCheckboxValue(fieldId, value) {
        const field = document.getElementById(fieldId);
        if (field && value !== undefined && value !== null) {
            field.checked = value;
        }
    }

    function toggleConditionalSection(checkboxId, sectionId) {
        const checkbox = document.getElementById(checkboxId);
        const section = document.getElementById(sectionId);
        if (checkbox && section) {
            section.style.display = checkbox.checked ? 'block' : 'none';
        }
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
        successMessage.style.display = 'none';
        
        // Scroll to top to show error
        document.querySelector('.wizard-content').scrollTop = 0;
    }

    function showSuccess(message) {
        successMessage.textContent = message;
        successMessage.style.display = 'block';
        errorMessage.style.display = 'none';
        
        // Scroll to top to show success
        document.querySelector('.wizard-content').scrollTop = 0;
    }

    function hideMessages() {
        errorMessage.style.display = 'none';
        successMessage.style.display = 'none';
    }

    function showLoading() {
        loadingState.classList.add('active');
        document.querySelector('.wizard-step.active').style.display = 'none';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
    }

    function hideLoading() {
        loadingState.classList.remove('active');
        document.querySelector(`.wizard-step[data-step="${currentStep}"]`).style.display = 'block';
        prevBtn.disabled = false;
        nextBtn.disabled = false;
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
                // Redirect to main radio interface
                window.location.href = '/';
            }
        }, 1000);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();