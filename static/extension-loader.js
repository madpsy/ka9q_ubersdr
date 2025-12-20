// Extension Loader - Auto-loads extensions from configuration
// No server-side logic required - pure client-side implementation

(async function() {
    try {
        // Load extension configuration from API endpoint
        const response = await fetch('/api/extensions').then(r => r.json());

        // Handle new API format with 'available' and 'default' keys
        const extensions = response.available || response; // Fallback to old format if needed
        const defaultExtension = response.default || null;
        
        console.log(`🔌 Loading ${extensions.length} extension(s)...`);
        if (defaultExtension) {
            console.log(`🎯 Default extension: ${defaultExtension}`);
        }
        
        // Array to store extension info for dropdown
        const extensionsList = [];
        
        // Load each enabled extension
        for (const ext of extensions) {
            const extName = ext.slug;
            try {
                // Load manifest
                const manifest = await fetch(`/extensions/${extName}/manifest.json`).then(r => r.json());
                
                console.log(`📦 Loading extension: ${manifest.displayName || extName}`);
                
                // Load CSS files if specified
                if (manifest.files?.styles) {
                    for (const css of manifest.files.styles) {
                        const link = document.createElement('link');
                        link.rel = 'stylesheet';
                        link.href = `/extensions/${extName}/${css}`;
                        document.head.appendChild(link);
                        console.log(`  ✓ Loaded CSS: ${css}`);
                    }
                }
                
                // Load HTML template if specified
                if (manifest.files?.template) {
                    const html = await fetch(`/extensions/${extName}/${manifest.files.template}`).then(r => r.text());
                    // Store template in global scope for extension to use
                    // Normalize extension name: replace hyphens with underscores for valid JS identifiers
                    const normalizedName = extName.replace(/-/g, '_');
                    window[`${normalizedName}_template`] = html;
                    console.log(`  ✓ Loaded template: ${manifest.files.template}`);
                }
                
                // Load additional scripts if specified (must load before main)
                if (manifest.files?.scripts) {
                    for (const scriptFile of manifest.files.scripts) {
                        await new Promise((resolve, reject) => {
                            const script = document.createElement('script');
                            script.src = `/extensions/${extName}/${scriptFile}`;
                            script.onload = () => {
                                console.log(`  ✓ Loaded script: ${scriptFile}`);
                                resolve();
                            };
                            script.onerror = (err) => {
                                console.error(`  ✗ Failed to load script: ${scriptFile}`, err);
                                reject(err);
                            };
                            document.body.appendChild(script);
                        });
                    }
                }
                
                // Load main JavaScript (after additional scripts)
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = `/extensions/${extName}/${manifest.files.main}`;
                    script.onload = () => {
                        console.log(`  ✓ Loaded script: ${manifest.files.main}`);
                        resolve();
                    };
                    script.onerror = (err) => {
                        console.error(`  ✗ Failed to load script: ${manifest.files.main}`, err);
                        reject(err);
                    };
                    document.body.appendChild(script);
                });
                
                // Store extension info for dropdown
                extensionsList.push({
                    slug: manifest.name || extName,
                    originalSlug: extName, // Keep original slug for matching
                    displayName: manifest.displayName || extName,
                    icon: manifest.icon
                });
                
                console.log(`✅ Successfully loaded extension: ${manifest.displayName || extName}`);
            } catch (err) {
                console.error(`❌ Failed to load extension "${extName}":`, err);
            }
        }
        
        // Populate extensions dropdown
        populateExtensionsDropdown(extensionsList);
        
        // Auto-load default extension if specified AND no URL parameter overrides it
        if (defaultExtension) {
            // Check if URL parameters specify extensions to load instead
            const urlParams = new URLSearchParams(window.location.search);
            const urlExtensions = urlParams.has('ext') ? urlParams.get('ext').split(',').filter(e => e.trim()) : [];
            
            // If URL specifies extensions, don't auto-load the default
            if (urlExtensions.length > 0) {
                console.log(`🔗 URL specifies extensions: ${urlExtensions.join(', ')} - skipping default auto-load`);
                return; // Exit early, let URL parameter code handle it
            }
            
            // Wait for audio context to be initialized before auto-loading
            // The toggleExtension function requires audioContext to exist
            const waitForAudioContext = () => {
                if (window.audioContext) {
                    const dropdown = document.getElementById('extensions-dropdown');

                    if (dropdown) {
                        // Find the extension by matching against both slug and originalSlug
                        const matchingExt = extensionsList.find(ext =>
                            ext.slug === defaultExtension || ext.originalSlug === defaultExtension
                        );

                        if (matchingExt) {
                            // Check if the option exists in dropdown
                            const option = Array.from(dropdown.options).find(opt => opt.value === matchingExt.slug);

                            if (option) {
                                // Auto-load the extension by directly enabling it
                                // This avoids race conditions with toggleExtension's state detection
                                if (window.decoderManager && window.audioContext) {
                                    const decoder = window.decoderManager.getDecoder(matchingExt.slug);
                                    if (decoder) {
                                        // Set flag to prevent URL parameter code from re-toggling
                                        window.extensionAutoLoaded = matchingExt.slug;

                                        // Get panel elements
                                        const panel = document.getElementById('extension-panel');
                                        const panelTitle = document.getElementById('extension-panel-title');
                                        const panelContent = document.getElementById('extension-panel-content');

                                        if (panel && panelTitle && panelContent) {
                                            // Load extension template into panel
                                            fetch(`extensions/${matchingExt.slug}/template.html`)
                                                .then(response => response.text())
                                                .then(html => {
                                                    panelContent.innerHTML = html;
                                                    panelTitle.textContent = decoder.displayName || matchingExt.slug;
                                                    panel.style.display = 'block';

                                                    // Initialize and enable decoder
                                                    const centerFreq = 800; // Default center frequency
                                                    window.decoderManager.initialize(matchingExt.slug, window.audioContext, window.analyser, centerFreq);
                                                    window.decoderManager.enable(matchingExt.slug);

                                                    console.log(`✅ Auto-loaded default extension: ${defaultExtension} (${matchingExt.displayName})`);
                                                })
                                                .catch(err => {
                                                    console.error(`Failed to load extension template: ${err.message}`);
                                                });
                                        }
                                    } else {
                                        console.warn(`⚠️ Decoder not found: ${matchingExt.slug}`);
                                    }
                                } else {
                                    console.warn(`⚠️ decoderManager or audioContext not available yet`);
                                }
                            } else {
                                console.warn(`⚠️ Default extension "${defaultExtension}" option not found in dropdown`);
                            }
                        } else {
                            console.warn(`⚠️ Default extension "${defaultExtension}" not found in available extensions`);
                        }
                    } else {
                        console.warn('⚠️ Extensions dropdown not found, cannot auto-load default extension');
                    }
                } else {
                    // Check again in 500ms
                    setTimeout(waitForAudioContext, 500);
                }
            };

            // Start checking for audio context after a short delay
            setTimeout(waitForAudioContext, 500);
        }

        console.log('🎉 Extension loading complete');
    } catch (err) {
        console.error('❌ Failed to load extensions configuration:', err);
        console.error('Make sure /api/extensions endpoint is accessible');
    }
})();

// Populate the extensions dropdown menu
function populateExtensionsDropdown(extensions) {
    const dropdown = document.getElementById('extensions-dropdown');
    if (!dropdown) {
        console.warn('Extensions dropdown not found in DOM');
        return;
    }
    
    // Clear existing options except the first one (placeholder)
    while (dropdown.options.length > 1) {
        dropdown.remove(1);
    }
    
    // Add option for each extension
    extensions.forEach(ext => {
        const option = document.createElement('option');
        option.value = ext.slug;
        // Use icon from manifest if available, otherwise default to 📊
        const icon = ext.icon || '📊';
        option.textContent = `${icon} ${ext.displayName}`;
        dropdown.appendChild(option);
    });
    
    console.log(`📋 Populated dropdown with ${extensions.length} extension(s)`);
}