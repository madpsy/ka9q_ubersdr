// Radiod Configuration Analyzer
// Parses radiod config and generates warnings based on configuration values

// Global variable to track pending save operation
let pendingRadiodSave = null;

/**
 * Parse INI-style radiod configuration
 * @param {string} configText - The raw config text
 * @returns {Object} Parsed configuration object with sections
 */
function parseRadiodConfig(configText) {
    const config = {};
    let currentSection = null;
    
    const lines = configText.split('\n');
    
    lines.forEach(line => {
        // Remove inline comments
        const commentIndex = line.indexOf('#');
        let effectiveLine = line;
        if (commentIndex >= 0) {
            effectiveLine = line.substring(0, commentIndex);
        }
        
        const trimmed = effectiveLine.trim();
        
        // Skip empty lines
        if (!trimmed) return;
        
        // Section headers [section]
        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            config[currentSection] = {};
            return;
        }
        
        // Key-value pairs
        if (trimmed.includes('=') && currentSection) {
            const equalIndex = trimmed.indexOf('=');
            const key = trimmed.substring(0, equalIndex).trim();
            const value = trimmed.substring(equalIndex + 1).trim();
            config[currentSection][key] = value;
        }
    });
    
    return config;
}

/**
 * Check if a parameter is commented out in the original config text
 * @param {string} configText - The raw config text
 * @param {string} section - Section name (e.g., 'rx888')
 * @param {string} param - Parameter name (e.g., 'gain')
 * @returns {boolean} True if the parameter line is commented out
 */
function isParameterCommented(configText, section, param) {
    const lines = configText.split('\n');
    let inSection = false;
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        // Check for section header
        if (trimmed === `[${section}]`) {
            inSection = true;
            continue;
        }
        
        // Check if we've moved to a new section
        if (inSection && trimmed.match(/^\[.+\]$/)) {
            inSection = false;
            break;
        }
        
        // Check if this line contains the parameter
        if (inSection && trimmed.includes(param)) {
            // Check if the line starts with # (commented out)
            // We need to check the original line, not trimmed
            const lineStart = line.trimStart();
            if (lineStart.startsWith('#')) {
                return true;
            }
            
            // Check if it's a key=value pair (not commented)
            if (trimmed.startsWith(param + '=') || trimmed.startsWith(param + ' =')) {
                return false;
            }
        }
    }
    
    // Parameter not found or section not found
    return true; // Treat as commented if not found
}

/**
 * Analyze radiod configuration and generate warnings
 * @param {string} configText - The raw config text
 * @returns {Object} Analysis results with warnings, errors, and info arrays
 */
function analyzeRadiodConfig(configText) {
    const warnings = [];
    const errors = [];
    const info = [];
    
    if (!configText || configText.trim() === '') {
        errors.push('Configuration is empty');
        return { warnings, errors, info };
    }
    
    // Parse the config
    const config = parseRadiodConfig(configText);
    
    // Check for [rx888] section
    if (!config['rx888']) {
        info.push('No [rx888] section found - warnings are specific to RX888 hardware');
        return { warnings, errors, info };
    }
    
    const rx888Config = config['rx888'];
    
    // 1. Check samprate
    if (rx888Config['samprate']) {
        const samprate = parseInt(rx888Config['samprate']);
        if (samprate !== 64800000) {
            warnings.push({
                type: 'samprate',
                message: `Sample rate is set to ${samprate.toLocaleString()} Hz. For optimal stability with RX888, it is recommended to use 64800000 Hz (64.8 MHz).`,
                suggestion: 'Set samprate = 64800000 in the [rx888] section'
            });
        }
    }
    
    // 2. Check if gain is set (not commented out)
    const gainCommented = isParameterCommented(configText, 'rx888', 'gain');
    if (!gainCommented && rx888Config['gain'] !== undefined) {
        warnings.push({
            type: 'agc_gain',
            message: 'Manual gain is configured. This will disable Automatic Gain Control (AGC).',
            suggestion: 'Comment out the "gain" parameter (add # at the start of the line) to enable AGC, or keep it set for manual gain control'
        });
    }
    
    // 3. Check if att (attenuation) is set (not commented out)
    const attCommented = isParameterCommented(configText, 'rx888', 'att');
    if (!attCommented && rx888Config['att'] !== undefined) {
        warnings.push({
            type: 'agc_att',
            message: 'Manual attenuation is configured. This will disable Automatic Gain Control (AGC).',
            suggestion: 'Comment out the "att" parameter (add # at the start of the line) to enable AGC, or keep it set for manual attenuation control'
        });
    }
    
    // 4. Check fft-threads in [global] section
    if (config['global']) {
        const fftThreadsCommented = isParameterCommented(configText, 'global', 'fft-threads');
        
        if (fftThreadsCommented) {
            warnings.push({
                type: 'fft_threads',
                message: 'FFT threads parameter is not set or is commented out.',
                suggestion: 'Add "fft-threads = 2" (or higher) in the [global] section for better performance. A value of at least 2 is highly recommended.'
            });
        } else if (config['global']['fft-threads']) {
            const fftThreads = parseInt(config['global']['fft-threads']);
            if (isNaN(fftThreads) || fftThreads < 2) {
                warnings.push({
                    type: 'fft_threads',
                    message: `FFT threads is set to ${config['global']['fft-threads']}. This may result in poor performance.`,
                    suggestion: 'Set fft-threads to at least 2 in the [global] section for optimal performance'
                });
            }
        }
    } else {
        errors.push('Missing [global] section - radiod may not start correctly');
    }
    
    return { warnings, errors, info };
}

/**
 * Render warnings as HTML elements
 * @param {Object} analysis - Analysis results from analyzeRadiodConfig
 * @returns {HTMLElement} Container div with all warnings
 */
function renderRadiodConfigWarnings(analysis) {
    const container = document.createElement('div');
    container.id = 'radiodConfigAnalysisWarnings';
    container.style.marginBottom = '15px';
    
    // Render errors (red)
    if (analysis.errors.length > 0) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'alert alert-error';
        errorDiv.style.marginBottom = '10px';
        
        let errorHTML = '<strong>❌ Configuration Errors:</strong>';
        errorHTML += '<ul style="margin: 10px 0 0 20px; line-height: 1.6;">';
        analysis.errors.forEach(error => {
            errorHTML += `<li>${error}</li>`;
        });
        errorHTML += '</ul>';
        
        errorDiv.innerHTML = errorHTML;
        container.appendChild(errorDiv);
    }
    
    // Render warnings (yellow/orange)
    if (analysis.warnings.length > 0) {
        const warnDiv = document.createElement('div');
        warnDiv.className = 'alert';
        warnDiv.style.background = '#fff3cd';
        warnDiv.style.border = '2px solid #ffc107';
        warnDiv.style.color = '#856404';
        warnDiv.style.marginBottom = '10px';
        
        let warnHTML = '<strong>⚠️ Configuration Warnings:</strong>';
        warnHTML += '<ul style="margin: 10px 0 0 20px; line-height: 1.6;">';
        analysis.warnings.forEach(warning => {
            warnHTML += `<li><strong>${warning.message}</strong>`;
            if (warning.suggestion) {
                warnHTML += `<br><em style="color: #856404; font-size: 13px;">💡 ${warning.suggestion}</em>`;
            }
            warnHTML += '</li>';
        });
        warnHTML += '</ul>';
        
        warnDiv.innerHTML = warnHTML;
        container.appendChild(warnDiv);
    }
    
    // Render info (blue)
    if (analysis.info.length > 0) {
        const infoDiv = document.createElement('div');
        infoDiv.className = 'alert alert-info';
        infoDiv.style.marginBottom = '10px';
        
        let infoHTML = '<strong>ℹ️ Configuration Info:</strong>';
        infoHTML += '<ul style="margin: 10px 0 0 20px; line-height: 1.6;">';
        analysis.info.forEach(infoItem => {
            infoHTML += `<li>${infoItem}</li>`;
        });
        infoHTML += '</ul>';
        
        infoDiv.innerHTML = infoHTML;
        container.appendChild(infoDiv);
    }
    
    return container;
}

/**
 * Update radiod config warnings in the UI
 * Called when config is loaded or edited
 * @param {string} configText - The current radiod config text
 */
function updateRadiodConfigWarnings(configText) {
    // Remove existing warnings
    const existingWarnings = document.getElementById('radiodConfigAnalysisWarnings');
    if (existingWarnings) {
        existingWarnings.remove();
    }
    
    // Analyze config
    const analysis = analyzeRadiodConfig(configText);
    
    // Only show warnings if there are any
    if (analysis.warnings.length > 0 || analysis.errors.length > 0 || analysis.info.length > 0) {
        const warningsDiv = renderRadiodConfigWarnings(analysis);
        
        // Insert warnings after the main "I Have No Fear" warning and before the editor
        const editor = document.getElementById('radiodConfigEditor');
        const radiodWarning = document.getElementById('radiodWarning');
        
        if (editor && radiodWarning) {
            // Insert after radiodWarning
            radiodWarning.parentNode.insertBefore(warningsDiv, editor);
        }
    }
}

/**
 * Check if there are any warnings before saving
 * @param {boolean} restart - Whether this is a save & restart operation
 * @returns {boolean} True if save should proceed, false if cancelled
 */
function checkRadiodWarningsBeforeSave(restart) {
    const editor = document.getElementById('radiodConfigEditor');
    if (!editor) return true;
    
    const configText = editor.value;
    const analysis = analyzeRadiodConfig(configText);
    
    // If no warnings or errors, proceed with save
    if (analysis.warnings.length === 0 && analysis.errors.length === 0) {
        return true;
    }
    
    // Store the restart flag for later use
    pendingRadiodSave = { restart: restart };
    
    // Show modal with warnings
    showRadiodWarningsModal(analysis);
    
    // Return false to prevent immediate save
    return false;
}

/**
 * Show modal with radiod config warnings
 * @param {Object} analysis - Analysis results
 */
function showRadiodWarningsModal(analysis) {
    const modal = document.getElementById('radiodWarningsModal');
    const content = document.getElementById('radiodWarningsModalContent');
    
    if (!modal || !content) return;
    
    let html = '<p style="margin-bottom: 20px; font-size: 15px;">The following issues were detected in your radiod configuration:</p>';
    
    // Render errors
    if (analysis.errors.length > 0) {
        html += '<div style="margin-bottom: 15px; padding: 15px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px;">';
        html += '<strong style="color: #721c24;">❌ Errors:</strong>';
        html += '<ul style="margin: 10px 0 0 20px; color: #721c24; line-height: 1.8;">';
        analysis.errors.forEach(error => {
            html += `<li>${error}</li>`;
        });
        html += '</ul></div>';
    }
    
    // Render warnings
    if (analysis.warnings.length > 0) {
        html += '<div style="margin-bottom: 15px; padding: 15px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 5px;">';
        html += '<strong style="color: #856404;">⚠️ Warnings:</strong>';
        html += '<ul style="margin: 10px 0 0 20px; color: #856404; line-height: 1.8;">';
        analysis.warnings.forEach(warning => {
            html += `<li><strong>${warning.message}</strong>`;
            if (warning.suggestion) {
                html += `<br><em style="font-size: 13px;">💡 ${warning.suggestion}</em>`;
            }
            html += '</li>';
        });
        html += '</ul></div>';
    }
    
    html += '<p style="margin-top: 20px; font-size: 14px; color: #666;"><strong>Do you want to save this configuration anyway?</strong></p>';
    
    content.innerHTML = html;
    modal.style.display = 'block';
}

/**
 * Close radiod warnings modal
 */
function closeRadiodWarningsModal() {
    const modal = document.getElementById('radiodWarningsModal');
    if (modal) {
        modal.style.display = 'none';
    }
    pendingRadiodSave = null;
    
    // Reload the config to discard any unsaved changes
    if (typeof loadRadiodConfig === 'function') {
        loadRadiodConfig();
    }
}

/**
 * Confirm save after viewing warnings
 * This is called when user clicks "Save Anyway" in the modal
 */
function confirmRadiodSave() {
    closeRadiodWarningsModal();
    
    if (pendingRadiodSave) {
        // Proceed with the actual save operation
        // Call the original save function with bypass flag
        actualSaveRadiodConfig(pendingRadiodSave.restart);
        pendingRadiodSave = null;
    }
}
