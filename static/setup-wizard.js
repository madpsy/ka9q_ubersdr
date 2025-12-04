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
        loadExistingConfig();
        initializeMap();
        
        // Auto-fill callsign fields when main callsign is entered
        document.getElementById('callsign').addEventListener('input', function(e) {
            const callsign = e.target.value.toUpperCase();
            document.getElementById('dxclusterCallsign').value = callsign;
            document.getElementById('receiverCallsign').value = callsign;
        });

        // Toggle conditional sections
        document.getElementById('dxclusterEnabled').addEventListener('change', function(e) {
            document.getElementById('dxclusterSettings').style.display = e.target.checked ? 'block' : 'none';
        });

        document.getElementById('decoderEnabled').addEventListener('change', function(e) {
            document.getElementById('decoderSettings').style.display = e.target.checked ? 'block' : 'none';
        });

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

            // Email validation
            if (field.type === 'email' && !isValidEmail(field.value)) {
                showError('Please enter a valid email address');
                field.focus();
                return false;
            }

            // Callsign validation (basic)
            if (field.id.toLowerCase().includes('callsign') && field.value.trim()) {
                if (!/^[A-Z0-9\/]+$/i.test(field.value)) {
                    showError('Callsign should only contain letters, numbers, and forward slashes');
                    field.focus();
                    return false;
                }
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
                const decoderConfig = await response.json();
                
                if (decoderConfig.decoder) {
                    setCheckboxValue('decoderEnabled', decoderConfig.decoder.enabled);
                    setFieldValue('receiverCallsign', decoderConfig.decoder.receiver_callsign);
                    setFieldValue('receiverLocator', decoderConfig.decoder.receiver_locator);
                    setFieldValue('receiverAntenna', decoderConfig.decoder.receiver_antenna);
                    setCheckboxValue('pskreporterEnabled', decoderConfig.decoder.pskreporter_enabled);
                    setCheckboxValue('wsprnetEnabled', decoderConfig.decoder.wsprnet_enabled);
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
            // Prepare main config update
            const mainConfig = {
                admin: {
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
                    bypass_passwords: [formData.bypassPassword],
                    max_session_time: parseInt(formData.maxSessionTime),
                    max_sessions: parseInt(formData.maxSessions),
                    max_sessions_ip: parseInt(formData.maxSessionsIP)
                },
                dxcluster: {
                    enabled: formData.dxclusterEnabled,
                    callsign: formData.dxclusterEnabled ? formData.dxclusterCallsign.toUpperCase() : ''
                }
            };

            // Save main config
            const mainResponse = await fetch('/admin/config', {
                method: 'POST',
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
                const decoderConfig = {
                    decoder: {
                        enabled: true,
                        receiver_callsign: formData.receiverCallsign.toUpperCase(),
                        receiver_locator: formData.receiverLocator.toUpperCase(),
                        receiver_antenna: formData.receiverAntenna || '',
                        pskreporter_enabled: formData.pskreporterEnabled,
                        wsprnet_enabled: formData.wsprnetEnabled,
                        bands: []
                    }
                };

                // Add enabled modes to bands
                if (formData.ft8Enabled) {
                    decoderConfig.decoder.bands.push({
                        name: 'FT8',
                        enabled: true
                    });
                }
                if (formData.ft4Enabled) {
                    decoderConfig.decoder.bands.push({
                        name: 'FT4',
                        enabled: true
                    });
                }
                if (formData.wsprEnabled) {
                    decoderConfig.decoder.bands.push({
                        name: 'WSPR',
                        enabled: true
                    });
                }

                // Save decoder config
                const decoderResponse = await fetch('/admin/decoder-config', {
                    method: 'POST',
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

            // Success!
            hideLoading();
            showSuccess('Configuration saved successfully! Redirecting to admin panel...');
            
            // Redirect to admin panel after 2 seconds
            setTimeout(() => {
                window.location.href = '/admin.html';
            }, 2000);

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
        });

        // Update marker when inputs change
        latInput.addEventListener('input', updateMarkerFromInputs);
        lonInput.addEventListener('input', updateMarkerFromInputs);

        // Allow clicking on map to move marker
        map.on('click', function(e) {
            marker.setLatLng(e.latlng);
            latInput.value = e.latlng.lat.toFixed(6);
            lonInput.value = e.latlng.lng.toFixed(6);
        });
    }

    function updateMarkerFromInputs() {
        const latInput = document.getElementById('latitude');
        const lonInput = document.getElementById('longitude');
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);

        if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            marker.setLatLng([lat, lon]);
            map.setView([lat, lon], map.getZoom());
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
        if (field && value !== undefined) {
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

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();