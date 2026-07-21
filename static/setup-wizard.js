// Setup Wizard JavaScript
(function() {
    'use strict';

    // State management
    let currentStep = 1;
    const totalSteps = 6;
    let formData = {};
    let map = null;
    let marker = null;
    let lookupTestPassed = false; // tracks whether the lookup test has passed this session
    let wisdomLaunched = false;   // tracks whether Generate Wisdom has been clicked on step 5
    let gpsdoSSE = null;          // SSE connection to /gpsdo/events — open while on step 1
    let wizardEnabledWidgetIDs = new Set(); // widget_ids the user has toggled on in step 6

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
        loadExistingConfig(); // Load config after map is initialized (also populates timezone dropdown)
        fetchUserIP(); // Fetch user's IP address for admin restrictions
        
        // Auto-fill callsign fields when main callsign is entered
        document.getElementById('callsign').addEventListener('input', function(e) {
            const callsign = e.target.value.toUpperCase();
            e.target.value = callsign; // Update the field itself to uppercase
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

        // Toggle lookup settings section when enabled/disabled
        document.getElementById('lookupEnabled').addEventListener('change', function(e) {
            const show = e.target.value === 'true';
            document.getElementById('lookupSettings').style.display = show ? 'block' : 'none';
            // Reset test state when toggling
            if (!show) {
                lookupTestPassed = false;
                document.getElementById('lookupTestResult').textContent = '';
            }
        });

        // Reset test state when credentials change
        ['lookupProvider', 'lookupUsername', 'lookupPassword'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', function() {
                lookupTestPassed = false;
                document.getElementById('lookupTestResult').textContent = '';
            });
        });

        // Test lookup connection button
        document.getElementById('testLookupBtn').addEventListener('click', testLookupConnection);

        // Ensure conditional sections are visible on load for checkboxes that are checked by default
        if (document.getElementById('dxclusterEnabled').checked) {
            document.getElementById('dxclusterSettings').style.display = 'block';
        }
        if (document.getElementById('decoderEnabled').checked) {
            document.getElementById('decoderSettings').style.display = 'block';
        }

        // Real-time validation for DX cluster host and port
        document.getElementById('dxclusterHost').addEventListener('input', validateDXClusterHost);
        document.getElementById('dxclusterHost').addEventListener('blur', validateDXClusterHost);
        document.getElementById('dxclusterPort').addEventListener('input', validateDXClusterPort);
        document.getElementById('dxclusterPort').addEventListener('blur', validateDXClusterPort);

        // Test DX cluster connection button
        document.getElementById('testDXClusterBtn').addEventListener('click', testDXClusterConnection);

        // Password generator
        document.getElementById('generatePassword').addEventListener('click', generatePassword);

        // Admin IP restriction radio buttons - check for lockout warning
        document.getElementById('adminAllowLAN').addEventListener('change', checkAdminLockoutWarning);
        document.getElementById('adminAllowAll').addEventListener('change', checkAdminLockoutWarning);
    }

    // Timezone auto-detection from the marker position.  The lookup endpoint is
    // rate limited to one request per second per IP, and the marker moves
    // continuously while dragging, so the call is debounced by a second — only
    // the position the user settles on is looked up.
    let timezoneLookupTimer = null;
    let pendingTimezone = null; // set when the answer beats the dropdown loading

    function scheduleTimezoneLookup(lat, lon) {
        if (!isFinite(lat) || !isFinite(lon)) return;
        clearTimeout(timezoneLookupTimer);
        timezoneLookupTimer = setTimeout(function() {
            lookupTimezoneForLocation(lat, lon);
        }, 1000);
    }

    async function lookupTimezoneForLocation(lat, lon) {
        try {
            const resp = await fetch('/api/maidenhead/country', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lat: lat, lon: lon })
            });
            // 429 (too fast) or 503 (dataset absent) — keep whatever is selected
            if (!resp.ok) return;

            const data = await resp.json();
            // Land only: a marker dropped offshore returns no zone, and the
            // existing selection is better than blanking it
            if (!data.timezone) return;

            // The dataset spells plain UTC as "Etc/UTC"; the dropdown lists "UTC"
            const tz = data.timezone === 'Etc/UTC' ? 'UTC' : data.timezone;

            const sel = document.getElementById('timezone');
            if (!sel) return;
            sel.value = tz;
            updateTimezonePreview();
            if (sel.value !== tz) {
                // Dropdown not populated yet, or the server's tz list lacks the
                // name — remember it for loadTimezoneDropdown to apply
                pendingTimezone = tz;
            }
        } catch (e) {
            console.log('Timezone lookup failed:', e.message);
        }
    }

    // Live clock for whichever zone is selected.  Reading a real time is the only
    // way an operator can tell an auto-detected zone is wrong for them.
    function updateTimezonePreview() {
        const sel = document.getElementById('timezone');
        const box = document.getElementById('timezone-preview');
        const out = document.getElementById('timezone-preview-time');
        if (!sel || !box || !out) return;

        if (!sel.value) {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';

        try {
            out.textContent = new Intl.DateTimeFormat('en-GB', {
                timeZone: sel.value,
                weekday: 'short', day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false, timeZoneName: 'short'
            }).format(new Date());
        } catch (e) {
            // Zone the browser's tz data does not know — say so rather than
            // showing a stale time from the previous selection
            out.textContent = 'unknown timezone';
        }
    }

    async function loadTimezoneDropdown(preselect) {
        const sel = document.getElementById('timezone');
        if (!sel) return;
        try {
            const resp = await fetch('/admin/timezones');
            if (!resp.ok) throw new Error('Failed to fetch timezones');
            const zones = await resp.json();
            sel.innerHTML = '';
            // Blank placeholder
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Select timezone…';
            sel.appendChild(placeholder);
            zones.forEach(function(tz) {
                const opt = document.createElement('option');
                opt.value = tz.name;
                opt.textContent = tz.offset_string + '  ' + tz.name;
                sel.appendChild(opt);
            });
            // Pre-select the configured timezone if provided
            if (preselect) {
                sel.value = preselect;
                // If the value wasn't found in the list, fall back to placeholder
                if (sel.value !== preselect) sel.value = '';
            } else if (pendingTimezone) {
                // A map lookup answered while the list was still loading
                sel.value = pendingTimezone;
                pendingTimezone = null;
            }
            // 'change' only fires for user edits, so refresh the clock by hand
            updateTimezonePreview();
        } catch (e) {
            sel.innerHTML = '<option value="">Could not load timezones</option>';
            console.error('Timezone load error:', e);
        }
    }

    function setupEventListeners() {
        prevBtn.addEventListener('click', previousStep);
        nextBtn.addEventListener('click', nextStep);

        const tzSel = document.getElementById('timezone');
        if (tzSel) {
            tzSel.addEventListener('change', updateTimezonePreview);
            updateTimezonePreview();
            setInterval(updateTimezonePreview, 1000);
        }
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
            // Step 6 (Widgets) — always allow finishing
            nextBtn.textContent = 'Finish Setup →';
            nextBtn.disabled = false;
        } else if (currentStep === totalSteps - 1) {
            // Step 5 (Generate Wisdom) — disable until wisdom launched
            nextBtn.textContent = 'Next →';
            nextBtn.disabled = !wisdomLaunched;
        } else {
            nextBtn.textContent = 'Next →';
            nextBtn.disabled = false;
        }

        // Hide messages when changing steps
        hideMessages();
    }

    function previousStep() {
        if (currentStep > 1) {
            // Close GPSDO SSE when leaving step 1
            if (currentStep === 1 && gpsdoSSE) {
                gpsdoSSE.close();
                gpsdoSSE = null;
            }
            currentStep--;
            updateUI();
        }
    }

    async function nextStep() {
        // Step 6 is the "Widgets" screen — "Finish Setup" saves config then restarts
        if (currentStep === totalSteps) {
            await saveConfiguration();
            return;
        }

        // Validate current step
        if (!validateStep(currentStep)) {
            return;
        }

        // Collect data from current step
        collectStepData(currentStep);

        // Close GPSDO SSE when leaving step 1
        if (currentStep === 1 && gpsdoSSE) {
            gpsdoSSE.close();
            gpsdoSSE = null;
        }

        // Advance to next step; if entering step 6 load featured widgets
        currentStep++;
        updateUI();
        if (currentStep === totalSteps) {
            loadWizardFeaturedWidgets();
        }
    }

    async function testDXClusterConnection() {
        const host      = document.getElementById('dxclusterHost').value.trim();
        const port      = parseInt(document.getElementById('dxclusterPort').value, 10);
        const callsign  = document.getElementById('dxclusterCallsign').value.trim().toUpperCase();
        const resultEl  = document.getElementById('dxclusterTestResult');
        const transcript= document.getElementById('dxclusterTranscript');
        const btn       = document.getElementById('testDXClusterBtn');

        // Run inline validation first
        if (!validateDXClusterHost() || !validateDXClusterPort()) {
            resultEl.style.color = '#c33';
            resultEl.textContent = '✗ Fix the errors above first';
            return;
        }
        if (!callsign) {
            resultEl.style.color = '#c33';
            resultEl.textContent = '✗ Enter your callsign first';
            document.getElementById('dxclusterCallsign').focus();
            return;
        }

        btn.disabled = true;
        resultEl.style.color = '#718096';
        resultEl.textContent = 'Connecting…';
        transcript.style.display = 'none';
        transcript.textContent = '';

        try {
            const resp = await fetch('/admin/dxcluster/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, callsign })
            });
            const data = await resp.json();

            if (data.transcript && data.transcript.length > 0) {
                transcript.textContent = data.transcript.join('\n');
                transcript.style.display = 'block';
            }

            if (data.ok) {
                resultEl.style.color = '#155724';
                resultEl.textContent = '✓ ' + data.message;
            } else {
                resultEl.style.color = '#c33';
                resultEl.textContent = '✗ ' + (data.message || 'Test failed');
            }
        } catch (err) {
            resultEl.style.color = '#c33';
            resultEl.textContent = '✗ Request failed: ' + err.message;
        } finally {
            btn.disabled = false;
        }
    }

    async function testLookupConnection() {
        const provider  = document.getElementById('lookupProvider').value;
        const username  = document.getElementById('lookupUsername').value.trim();
        const password  = document.getElementById('lookupPassword').value.trim();
        const resultEl  = document.getElementById('lookupTestResult');
        const btn       = document.getElementById('testLookupBtn');

        if (!username || !password) {
            resultEl.style.color = '#c33';
            resultEl.textContent = '✗ Username and password are required';
            lookupTestPassed = false;
            return;
        }

        btn.disabled = true;
        resultEl.style.color = '#718096';
        resultEl.textContent = 'Testing…';

        try {
            const resp = await fetch('/admin/lookup/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, username, password })
            });
            const data = await resp.json();
            if (data.ok) {
                lookupTestPassed = true;
                resultEl.style.color = '#155724';
                resultEl.textContent = '✓ Connected' + (data.sub_exp ? ' (subscription expires: ' + data.sub_exp + ')' : '');
            } else {
                lookupTestPassed = false;
                resultEl.style.color = '#c33';
                resultEl.textContent = '✗ ' + (data.message || 'Test failed');
            }
        } catch (err) {
            lookupTestPassed = false;
            resultEl.style.color = '#c33';
            resultEl.textContent = '✗ Request failed: ' + err.message;
        } finally {
            btn.disabled = false;
        }
    }

    function validateStep(step) {
        hideMessages();
        
        const stepElement = document.querySelector(`.wizard-step[data-step="${step}"]`);
        const requiredFields = stepElement.querySelectorAll('[required]');
        
        // Step 3 validations
        if (step === 3) {
            // Validate DX cluster host and port if enabled
            const dxEnabled = document.getElementById('dxclusterEnabled').checked;
            if (dxEnabled) {
                const hostOk = validateDXClusterHost();
                const portOk = validateDXClusterPort();
                if (!hostOk) {
                    showError('DX cluster host is invalid — check the field below.');
                    document.getElementById('dxclusterHost').focus();
                    return false;
                }
                if (!portOk) {
                    showError('DX cluster port must be a number between 1 and 65535.');
                    document.getElementById('dxclusterPort').focus();
                    return false;
                }
            }

            // Block Next if lookup is enabled but test has not passed
            const lookupEnabled = document.getElementById('lookupEnabled').value === 'true';
            if (lookupEnabled && !lookupTestPassed) {
                showError('Please test the lookup service connection before continuing, or set Lookup Service to Disabled.');
                document.getElementById('testLookupBtn').focus();
                return false;
            }
        }

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
            } else if (input.type === 'radio') {
                if (input.checked) {
                    formData[input.name] = input.value;
                }
            } else {
                formData[input.name] = input.value;
            }
        });
    }

    async function loadExistingConfig() {
        try {
            // Try to load existing config to pre-fill fields
            const response = await fetch('/admin/config');
            
            // If unauthorized, redirect to admin login with return URL
            if (response.status === 401) {
                const returnUrl = encodeURIComponent(window.location.pathname);
                window.location.href = `/admin.html?return=${returnUrl}`;
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
                    setFieldValue('antenna', config.admin.antenna);
                    // Populate timezone dropdown and pre-select the configured value
                    loadTimezoneDropdown(config.admin.timezone || 'UTC');

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

                // Pre-fill admin IP restriction
                if (config.admin && config.admin.allowed_ips) {
                    const allowedIPs = config.admin.allowed_ips;
                    // Check if it's the LAN configuration (all three RFC 1918 ranges)
                    const isLANConfig = allowedIPs.includes('192.168.0.0/16') &&
                                       allowedIPs.includes('172.16.0.0/12') &&
                                       allowedIPs.includes('10.0.0.0/8');

                    if (isLANConfig) {
                        document.getElementById('adminAllowLAN').checked = true;
                    } else {
                        document.getElementById('adminAllowAll').checked = true;
                    }
                }

                // Pre-fill instance reporting fields
                if (config.instance_reporting) {
                    setCheckboxValue('remoteLogging', config.instance_reporting.remote_logging);
                }

                // Pre-fill DX cluster fields
                if (config.dxcluster) {
                    setCheckboxValue('dxclusterEnabled', config.dxcluster.enabled);
                    setFieldValue('dxclusterHost', config.dxcluster.host);
                    setFieldValue('dxclusterPort', config.dxcluster.port);
                    setFieldValue('dxclusterCallsign', config.dxcluster.callsign);
                    toggleConditionalSection('dxclusterEnabled', 'dxclusterSettings');
                }

                // Pre-fill EiBi setting
                if (config.eibi) {
                    setCheckboxValue('eibiEnabled', config.eibi.enabled);
                }

                // Pre-fill lookup service settings
                if (config.lookup_services) {
                    const ls = config.lookup_services;
                    document.getElementById('lookupEnabled').value = ls.enabled ? 'true' : 'false';
                    if (ls.provider) {
                        setFieldValue('lookupProvider', ls.provider);
                    }
                    if (ls.qrz) {
                        setFieldValue('lookupUsername', ls.qrz.username);
                        setFieldValue('lookupPassword', ls.qrz.password);
                    }
                    // Show/hide settings section based on enabled state
                    document.getElementById('lookupSettings').style.display = ls.enabled ? 'block' : 'none';
                    // If already enabled and saved, treat as tested (credentials were valid before)
                    if (ls.enabled) {
                        lookupTestPassed = true;
                        const resultEl = document.getElementById('lookupTestResult');
                        resultEl.style.color = '#155724';
                        resultEl.textContent = '✓ Previously configured';
                    }
                }
            }

            // Try to load decoder config
            const decoderResponse = await fetch('/admin/decoder-config');
            
            // If unauthorized, redirect to admin login with return URL
            if (decoderResponse.status === 401) {
                const returnUrl = encodeURIComponent(window.location.pathname);
                window.location.href = `/admin.html?return=${returnUrl}`;
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
            // Still populate the timezone dropdown even if no config exists yet
            loadTimezoneDropdown();
        }
    }

    async function saveConfiguration() {
        showLoading();
        hideMessages();

        try {
            // Load existing config first to preserve all fields
            const existingConfigResponse = await fetch('/admin/config');
            if (existingConfigResponse.status === 401) {
                const returnUrl = encodeURIComponent(window.location.pathname);
                window.location.href = `/admin.html?return=${returnUrl}`;
                return;
            }
            if (!existingConfigResponse.ok) {
                throw new Error('Failed to load existing configuration');
            }
            const existingConfig = await existingConfigResponse.json();

            // Determine admin allowed IPs based on radio button selection
            let adminAllowedIPs = ['0.0.0.0/0']; // Default: allow all
            if (formData.adminIPRestriction === 'lan') {
                // RFC 1918 private IP ranges
                adminAllowedIPs = ['192.168.0.0/16', '172.16.0.0/12', '10.0.0.0/8'];
            }

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
                    timezone: formData.timezone || 'UTC',
                    antenna: formData.antenna,
                    gps: {
                        lat: parseFloat(formData.latitude),
                        lon: parseFloat(formData.longitude)
                    },
                    asl: parseInt(formData.asl),
                    allowed_ips: adminAllowedIPs
                },
                server: {
                    ...existingConfig.server,
                    bypass_password: formData.bypassPassword || existingConfig.server?.bypass_password || "",
                    max_session_time: parseInt(formData.maxSessionTime),
                    max_sessions: parseInt(formData.maxSessions),
                    max_sessions_ip: parseInt(formData.maxSessionsIP)
                },
                instance_reporting: {
                    ...existingConfig.instance_reporting,
                    remote_logging: formData.remoteLogging
                },
                dxcluster: {
                    ...existingConfig.dxcluster,
                    enabled: formData.dxclusterEnabled,
                    host: formData.dxclusterHost || 'dxspider.co.uk',
                    port: parseInt(formData.dxclusterPort) || 7300,
                    callsign: formData.dxclusterEnabled ? formData.dxclusterCallsign.toUpperCase() : ''
                },
                eibi: {
                    ...existingConfig.eibi,
                    enabled: formData.eibiEnabled
                },
                lookup_services: {
                    ...existingConfig.lookup_services,
                    enabled: formData.lookupEnabled === 'true',
                    provider: formData.lookupProvider || 'qrz',
                    qrz: {
                        ...(existingConfig.lookup_services && existingConfig.lookup_services.qrz),
                        username: formData.lookupUsername || '',
                        password: formData.lookupPassword
                            ? formData.lookupPassword
                            : (existingConfig.lookup_services && existingConfig.lookup_services.qrz && existingConfig.lookup_services.qrz.password) || ''
                    }
                }
            };

            // Update cwskimmer pskreporter_antenna to match
            const existingCWSkimmerResponse = await fetch('/admin/cwskimmer-config');
            if (existingCWSkimmerResponse.ok) {
                const existingCWSkimmerConfig = await existingCWSkimmerResponse.json();
                existingCWSkimmerConfig.pskreporter_antenna = formData.antenna;
                await fetch('/admin/cwskimmer-config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(existingCWSkimmerConfig)
                });
            }

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

                // Enable existing bands based on checkbox state.
                // Only set enabled=true when the checkbox is checked; if unchecked,
                // leave the band's existing enabled value untouched so re-running
                // the wizard doesn't disable modes the user already had configured.
                if (existingBands.length > 0) {
                    existingBands.forEach(band => {
                        if (band.mode === 'FT8' && formData.ft8Enabled) {
                            band.enabled = true;
                        } else if (band.mode === 'FT4' && formData.ft4Enabled) {
                            band.enabled = true;
                        } else if (band.mode === 'WSPR' && formData.wsprEnabled) {
                            band.enabled = true;
                        } else if (band.mode === 'JS8' && formData.js8Enabled) {
                            band.enabled = true;
                        } else if (band.mode === 'FT2' && formData.ft2Enabled) {
                            band.enabled = true;
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
                        receiver_antenna: formData.antenna,
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

            // Re-fetch config after saving so we get the server-generated instance_uuid
            // (on a fresh install it doesn't exist until the first save)
            let instanceUUID = existingConfig?.instance_reporting?.instance_uuid || '';
            if (!instanceUUID) {
                try {
                    const freshResp = await fetch('/admin/config');
                    if (freshResp.ok) {
                        const freshConfig = await freshResp.json();
                        instanceUUID = freshConfig?.instance_reporting?.instance_uuid || '';
                    }
                } catch (_) {}
            }

            // Success! Show restart countdown
            hideLoading();
            showSuccess('Configuration saved successfully! Server is restarting...');

            // Show restart countdown and redirect
            setTimeout(() => {
                showRestartCountdown(instanceUUID);
            }, 500);

        } catch (error) {
            hideLoading();
            showError(`Failed to save configuration: ${error.message}`);
            console.error('Configuration save error:', error);
        }
    }

    // ── Real-time DX cluster field validation ────────────────────────────────

    function setFieldHint(fieldId, message, isError) {
        const field = document.getElementById(fieldId);
        if (!field) return;
        let hint = field.parentNode.querySelector('.field-hint-inline');
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'field-hint-inline';
            hint.style.cssText = 'font-size:12px;margin-top:4px;';
            field.parentNode.appendChild(hint);
        }
        if (message) {
            hint.textContent = message;
            hint.style.color = isError ? '#c0392b' : '#27ae60';
            field.style.borderColor = isError ? '#e74c3c' : '';
        } else {
            hint.textContent = '';
            field.style.borderColor = '';
        }
    }

    function validateDXClusterHost() {
        const field = document.getElementById('dxclusterHost');
        if (!field) return true;
        const host = field.value.trim();

        if (!host) {
            setFieldHint('dxclusterHost', 'Host is required.', true);
            return false;
        }
        if (/^https?:\/\//i.test(host) || host.includes('/')) {
            setFieldHint('dxclusterHost', 'Enter a hostname only, not a URL (e.g. dxspider.co.uk).', true);
            return false;
        }
        if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(host)) {
            setFieldHint('dxclusterHost', 'Not a valid hostname or IP address.', true);
            return false;
        }
        setFieldHint('dxclusterHost', '', false);
        return true;
    }

    function validateDXClusterPort() {
        const field = document.getElementById('dxclusterPort');
        if (!field) return true;
        const port = parseInt(field.value, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
            setFieldHint('dxclusterPort', 'Port must be between 1 and 65535.', true);
            return false;
        }
        setFieldHint('dxclusterPort', '', false);
        return true;
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
        
        // Auto-populate location on a fresh install (no coordinates set yet).
        // Priority: GPSDO (Leo Bodnar LBE-1420) → browser geolocation → default London.
        // If coordinates are already configured, never override them.
        const currentLat = parseFloat(latInput.value);
        const currentLon = parseFloat(lonInput.value);
        const isDefaultLocation = (
            (!latInput.value && !lonInput.value) ||
            (Math.abs(currentLat - 51.5074) < 0.001 && Math.abs(currentLon - (-0.1278)) < 0.001)
        );

        // Helper: apply a lat/lon to the map and inputs (used by GPSDO auto-populate)
        function applyLocation(lat, lon, altM) {
            latInput.value = lat.toFixed(6);
            lonInput.value = lon.toFixed(6);
            if (altM !== undefined && altM > 0) {
                const aslInput = document.getElementById('asl');
                if (aslInput && !aslInput.value) {
                    aslInput.value = Math.round(altM);
                }
            }
            if (marker) {
                marker.setLatLng([lat, lon]);
                map.setView([lat, lon], 10);
                updateMarkerTooltip();
                updateMaidenheadLocator();
            }
            // Covers GPSDO and browser geolocation on a fresh install
            scheduleTimezoneLookup(lat, lon);
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
            scheduleTimezoneLookup(position.lat, position.lng);
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
            scheduleTimezoneLookup(e.latlng.lat, e.latlng.lng);
        });

        // Initial tooltip update (after event listeners are set up)
        updateMarkerTooltip();

        // Single GPSDO health fetch: auto-populate coords on fresh install AND show hint panel.
        // On a fresh install (isDefaultLocation) we prefer GPSDO over browser geolocation.
        // The hint panel is always shown when the device has a valid GPS fix.
        fetch('/admin/gpsdo-health', { credentials: 'include' })
            .then(function(resp) {
                if (!resp.ok && resp.status !== 503) throw new Error('not available');
                return resp.json();
            })
            .then(function(health) {
                const gps = health && health.gps;
                const hasValidFix = health && health.enabled && gps &&
                    typeof gps.latitude === 'number' && typeof gps.longitude === 'number' &&
                    (gps.latitude !== 0 || gps.longitude !== 0);

                // Auto-populate on fresh install
                if (isDefaultLocation && hasValidFix) {
                    console.log('Using GPSDO location:', gps.latitude, gps.longitude);
                    applyLocation(gps.latitude, gps.longitude, gps.altitude_m);
                } else if (isDefaultLocation) {
                    // GPSDO not available — fall back to browser geolocation
                    if (navigator.geolocation) {
                        navigator.geolocation.getCurrentPosition(
                            function(position) {
                                applyLocation(position.coords.latitude, position.coords.longitude);
                            },
                            function(error) {
                                console.log('Geolocation not available or denied:', error.message);
                            },
                            { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 }
                        );
                    }
                }

                // Show hint panel whenever GPSDO has a valid fix (regardless of isDefaultLocation)
                if (hasValidFix) {
                    const hint     = document.getElementById('gpsdo-location-hint');
                    const hintText = document.getElementById('gpsdo-location-hint-text');
                    const btn      = document.getElementById('gpsdo-use-location-btn');
                    if (hint && hintText && btn) {
                        const lat = gps.latitude.toFixed(6);
                        const lon = gps.longitude.toFixed(6);
                        const alt = (gps.altitude_m !== undefined && gps.altitude_m > 0)
                            ? ` · ${Math.round(gps.altitude_m)} m ASL` : '';
                        const fix  = gps.fix ? ` · ${gps.fix}` : '';
                        const sats = (typeof gps.sats_used === 'number') ? ` · ${gps.sats_used} sats` : '';
                        hintText.textContent = `${lat}, ${lon}${alt}${fix}${sats}`;
                        btn.onclick = function() {
                            const latInput = document.getElementById('latitude');
                            const lonInput = document.getElementById('longitude');
                            const aslInput = document.getElementById('asl');
                            latInput.value = lat;
                            lonInput.value = lon;
                            if (aslInput && gps.altitude_m > 0) {
                                aslInput.value = Math.round(gps.altitude_m);
                            }
                            if (marker) {
                                marker.setLatLng([gps.latitude, gps.longitude]);
                                map.setView([gps.latitude, gps.longitude], 10);
                                updateMarkerTooltip();
                                updateMaidenheadLocator();
                            }
                        };
                        hint.style.display = 'block';
                    }
                }

                // Show GPSDO config section whenever the device is detected (enabled == true),
                // regardless of GPS fix.  Open an SSE stream for live status updates.
                if (health && health.enabled) {
                    initGPSDOConfigSection();
                }
            })
            .catch(function() {
                // GPSDO unavailable — fall back to browser geolocation on fresh install
                if (isDefaultLocation && navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        function(position) {
                            applyLocation(position.coords.latitude, position.coords.longitude);
                        },
                        function(error) {
                            console.log('Geolocation not available or denied:', error.message);
                        },
                        { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 }
                    );
                }
            });
    }

    // Initialise the GPSDO configuration section.
    // Opens an SSE stream to /gpsdo/events for live status, wires up the two action buttons.
    function initGPSDOConfigSection() {
        const section    = document.getElementById('gpsdo-config-section');
        const statusEl   = document.getElementById('gpsdo-config-status');
        const actionMsg  = document.getElementById('gpsdo-action-msg');
        const configBtn  = document.getElementById('gpsdo-configure-btn');
        const blinkBtn   = document.getElementById('gpsdo-blink-btn');
        if (!section || !configBtn || !blinkBtn) return;

        section.style.display = 'block';

        // Helper: update the status line from a device_status object
        function updateStatus(ds) {
            if (!ds) {
                statusEl.textContent = '(device not available)';
                return;
            }
            const freqMHz = (ds.frequency_hz / 1e6).toFixed(6).replace(/\.?0+$/, '') + ' MHz';
            const out = ds.output1_enabled ? '✅ output enabled' : '⚠️ output disabled';
            const ok  = ds.frequency_hz === 27000000 && ds.output1_enabled;
            statusEl.textContent = `${freqMHz} · ${out}`;
            statusEl.style.color = ok ? '#2e7d32' : '#b71c1c';
            // Dim the configure button if already correctly set
            configBtn.style.opacity = ok ? '0.5' : '1';
            configBtn.title = ok ? 'Already configured correctly' : '';
        }

        // Open SSE stream for live updates
        if (gpsdoSSE) { gpsdoSSE.close(); }
        gpsdoSSE = new EventSource('/gpsdo/events');
        gpsdoSSE.onmessage = function(e) {
            try {
                const data = JSON.parse(e.data);
                updateStatus(data.device_status);
            } catch (_) {}
        };
        gpsdoSSE.onerror = function() {
            statusEl.textContent = '(connection lost)';
            statusEl.style.color = '#b71c1c';
        };

        // Helper: POST to a GPSDO config endpoint
        function gpsdoPost(path, body, cb) {
            fetch(path, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            .then(function(r) { return r.json(); })
            .then(function(j) { cb(j.ok ? null : (j.error || 'unknown error')); })
            .catch(function(err) { cb(err.message || String(err)); });
        }

        // "Configure for RX888 Mk II" — set 27 MHz then enable output
        configBtn.onclick = function() {
            configBtn.disabled = true;
            blinkBtn.disabled  = true;
            actionMsg.textContent = 'Setting frequency…';
            actionMsg.style.color = '#1565c0';
            gpsdoPost('/gpsdo/config/frequency', { frequency_hz: 27000000, save: true }, function(err) {
                if (err) {
                    actionMsg.textContent = 'Frequency error: ' + err;
                    actionMsg.style.color = '#b71c1c';
                    configBtn.disabled = false;
                    blinkBtn.disabled  = false;
                    return;
                }
                actionMsg.textContent = 'Enabling output…';
                gpsdoPost('/gpsdo/config/output1', { enabled: true }, function(err2) {
                    configBtn.disabled = false;
                    blinkBtn.disabled  = false;
                    if (err2) {
                        actionMsg.textContent = 'Output error: ' + err2;
                        actionMsg.style.color = '#b71c1c';
                    } else {
                        actionMsg.textContent = '✅ Configured — 27 MHz, output enabled';
                        actionMsg.style.color = '#2e7d32';
                        setTimeout(function() { actionMsg.textContent = ''; }, 4000);
                    }
                });
            });
        };

        // "Blink LED"
        blinkBtn.onclick = function() {
            blinkBtn.disabled = true;
            actionMsg.textContent = 'Blinking…';
            actionMsg.style.color = '#1565c0';
            gpsdoPost('/gpsdo/config/blink', {}, function(err) {
                blinkBtn.disabled = false;
                if (err) {
                    actionMsg.textContent = 'Blink error: ' + err;
                    actionMsg.style.color = '#b71c1c';
                } else {
                    actionMsg.textContent = '💡 LED blinking for ~3 seconds';
                    actionMsg.style.color = '#1565c0';
                    setTimeout(function() { actionMsg.textContent = ''; }, 4000);
                }
            });
        };
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
            // Typed coordinates arrive a digit at a time — the debounce means only
            // the finished value is looked up
            scheduleTimezoneLookup(lat, lon);
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
    function showRestartCountdown(instanceUUID) {
        const overlay = document.getElementById('restartOverlay');
        const countdownEl = document.getElementById('countdownNumber');
        overlay.style.display = 'flex';

        // Show the UUID panel if we have a UUID
        if (instanceUUID) {
            const panel   = document.getElementById('instanceUUIDPanel');
            const uuidEl  = document.getElementById('instanceUUIDValue');
            if (panel && uuidEl) {
                uuidEl.textContent = instanceUUID;
                panel.style.display = 'block';
            }
        }

        let countdown = 20;
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

    // Copy instance UUID to clipboard
    window.copyInstanceUUID = function copyInstanceUUID() {
        const uuidEl = document.getElementById('instanceUUIDValue');
        const btn    = document.getElementById('instanceUUIDCopyBtn');
        if (!uuidEl || !btn) return;
        const text = uuidEl.textContent.trim();
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '📋'; }, 2000);
        }).catch(() => {
            btn.textContent = '❌';
            setTimeout(() => { btn.textContent = '📋'; }, 2000);
        });
    };

    // Fetch user's IP address from /api/myip
    let userIPAddress = null;
    async function fetchUserIP() {
        try {
            const response = await fetch('/api/myip');
            if (response.ok) {
                const data = await response.json();
                userIPAddress = data.ip;

                // Display the IP address
                const ipDisplay = document.getElementById('currentIPDisplay');
                const ipAddressSpan = document.getElementById('currentIPAddress');
                if (ipAddressSpan && userIPAddress) {
                    let displayText = userIPAddress;
                    if (data.country) {
                        displayText += ` (${data.country})`;
                    }
                    ipAddressSpan.textContent = displayText;
                    ipDisplay.style.display = 'block';
                }

                // Check if we should show the warning
                checkAdminLockoutWarning();
            }
        } catch (error) {
            console.log('Could not fetch user IP:', error);
        }
    }

    // Check if user would lock themselves out with LAN-only restriction
    function checkAdminLockoutWarning() {
        const lanRadio = document.getElementById('adminAllowLAN');
        const warningDiv = document.getElementById('lanWarning');

        if (!lanRadio || !warningDiv || !userIPAddress) {
            return;
        }

        // Check if LAN option is selected
        if (lanRadio.checked) {
            // Check if user's IP is in private ranges
            const isPrivateIP = isIPInPrivateRange(userIPAddress);

            // Show warning if NOT in private range
            warningDiv.style.display = isPrivateIP ? 'none' : 'block';
        } else {
            // Hide warning if "Allow all" is selected
            warningDiv.style.display = 'none';
        }
    }

    // Check if an IP address is in RFC 1918 private ranges
    function isIPInPrivateRange(ip) {
        if (!ip) return false;

        const parts = ip.split('.').map(Number);
        if (parts.length !== 4) return false;

        // 10.0.0.0/8
        if (parts[0] === 10) {
            return true;
        }

        // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
            return true;
        }

        // 192.168.0.0/16
        if (parts[0] === 192 && parts[1] === 168) {
            return true;
        }

        return false;
    }

    // ── Step 6: Featured Widgets ─────────────────────────────────────────────

    async function loadWizardFeaturedWidgets() {
        const container = document.getElementById('wizardWidgetsContainer');
        if (!container) return;

        container.innerHTML = '<div style="text-align:center;padding:30px;color:#718096;"><div class="spinner" style="margin:0 auto 16px;"></div><p>Loading featured widgets…</p></div>';

        try {
            // Fetch current enabled list and featured widgets in parallel
            const [enabledResp, publicResp] = await Promise.all([
                fetch('/admin/widgets/enabled'),
                fetch('/admin/widgets/public-with-instances')
            ]);

            // Pre-populate wizardEnabledWidgetIDs from the server's current enabled list
            if (enabledResp.ok) {
                const enabledData = await enabledResp.json();
                wizardEnabledWidgetIDs = new Set((enabledData.enabled || []).map(e => e.widget_id));
            }

            if (!publicResp.ok) throw new Error('HTTP ' + publicResp.status);
            const data = await publicResp.json();
            const featured = (data.widgets || []).filter(w => w.is_featured);

            if (featured.length === 0) {
                container.innerHTML = '<p style="color:#718096;font-size:14px;text-align:center;padding:20px 0;">No featured widgets are available right now. You can browse all widgets later from <strong>Admin → UI → Widgets</strong>.</p>';
                return;
            }

            renderWizardWidgets(featured, container);
        } catch (e) {
            container.innerHTML = '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:16px;color:#856404;font-size:14px;">' +
                '⚠️ Could not load featured widgets right now — this is not a problem. ' +
                'You can enable widgets at any time from <strong>Admin → UI → Widgets</strong>.' +
                '</div>';
        }
    }

    function renderWizardWidgets(widgets, container) {
        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;';

        widgets.forEach(w => {
            const isOn = wizardEnabledWidgetIDs.has(w.widget_id);
            const card = document.createElement('div');
            card.id = 'wizard-widget-card-' + w.widget_id;
            card.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:8px;border:1px solid ' +
                (isOn ? '#f59e0b' : '#e2e8f0') + ';background:' + (isOn ? '#fffbeb' : '#fff') +
                ';box-shadow:0 1px 4px rgba(0,0,0,.06);transition:border-color .2s,background .2s;';

            const nameRow = document.createElement('div');
            nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
            const nameEl = document.createElement('span');
            nameEl.style.cssText = 'font-weight:700;font-size:15px;color:#2d3748;flex:1;min-width:0;';
            nameEl.textContent = w.name;
            const badge = document.createElement('span');
            badge.style.cssText = 'padding:2px 8px;background:rgba(245,158,11,0.85);color:#fff;border-radius:10px;font-size:11px;font-weight:bold;white-space:nowrap;flex-shrink:0;';
            badge.textContent = '⭐ featured';
            nameRow.appendChild(nameEl);
            nameRow.appendChild(badge);

            card.appendChild(nameRow);

            if (w.description) {
                const desc = document.createElement('p');
                desc.style.cssText = 'margin:0;font-size:13px;color:#718096;line-height:1.5;';
                desc.textContent = w.description;
                card.appendChild(desc);
            }

            if (w.callsign) {
                const by = document.createElement('div');
                by.style.cssText = 'font-size:11px;color:#a0aec0;';
                by.textContent = 'by ' + w.callsign;
                card.appendChild(by);
            }

            const btn = document.createElement('button');
            btn.className = isOn ? 'btn btn-danger' : 'btn btn-primary';
            btn.style.cssText = 'margin-top:auto;font-size:13px;padding:8px 14px;width:100%;';
            btn.textContent = isOn ? 'Disable' : 'Enable';
            btn.addEventListener('click', () => toggleWizardWidget(w, btn, card));
            card.appendChild(btn);

            grid.appendChild(card);
        });

        container.appendChild(grid);

        const note = document.createElement('p');
        note.style.cssText = 'margin-top:16px;font-size:12px;color:#a0aec0;text-align:center;';
        note.textContent = 'You can change these at any time from Admin → UI → Widgets.';
        container.appendChild(note);
    }

    async function toggleWizardWidget(w, btn, card) {
        const isCurrentlyOn = wizardEnabledWidgetIDs.has(w.widget_id);
        btn.disabled = true;
        btn.textContent = '…';

        try {
            // Fetch the current server-side enabled list so we don't clobber other widgets
            const listResp = await fetch('/admin/widgets/enabled');
            if (!listResp.ok) throw new Error('HTTP ' + listResp.status);
            const listData = await listResp.json();
            const currentIDs = (listData.enabled || []).map(e => e.widget_id);

            let newList;
            if (isCurrentlyOn) {
                newList = currentIDs.filter(id => id !== w.widget_id);
            } else {
                if (currentIDs.length >= 10) throw new Error('Maximum 10 widgets can be enabled at once');
                newList = [...currentIDs, w.widget_id];
            }

            const resp = await fetch('/admin/widgets/enabled', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: newList })
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            if (isCurrentlyOn) {
                wizardEnabledWidgetIDs.delete(w.widget_id);
            } else {
                wizardEnabledWidgetIDs.add(w.widget_id);
            }

            const nowOn = wizardEnabledWidgetIDs.has(w.widget_id);
            card.style.border = '1px solid ' + (nowOn ? '#f59e0b' : '#e2e8f0');
            card.style.background = nowOn ? '#fffbeb' : '#fff';
            btn.className = nowOn ? 'btn btn-danger' : 'btn btn-primary';
            btn.textContent = nowOn ? 'Disable' : 'Enable';
        } catch (e) {
            btn.textContent = isCurrentlyOn ? 'Disable' : 'Enable';
            // Show a brief inline error without blocking the user
            const errEl = document.createElement('span');
            errEl.style.cssText = 'font-size:11px;color:#c33;margin-left:8px;';
            errEl.textContent = (e.message || 'Failed') + ' — try again';
            btn.parentNode.insertBefore(errEl, btn.nextSibling);
            setTimeout(() => errEl.remove(), 4000);
        } finally {
            btn.disabled = false;
        }
    }

    // Open Generate Wisdom script in popup window (mirrors admin.html behaviour)
    // Exposed on window so the inline onclick attribute in the HTML can reach it
    window.openGenerateWisdom = function openGenerateWisdom() {
        const terminalPath = '/terminal';
        const command = '~/ubersdr/generate_wisdom.sh';
        const url = `${terminalPath}/?arg=${encodeURIComponent(command)}`;

        const width = 1000;
        const height = 700;
        const left = (screen.width - width) / 2;
        const top = (screen.height - height) / 2;
        window.open(url, 'generate_wisdom_' + Date.now(),
            `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no`);

        // Unlock the Finish Setup button now that the script has been launched
        wisdomLaunched = true;
        nextBtn.disabled = false;
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();