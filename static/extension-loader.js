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
        
        // Auto-load default extension if specified
        if (defaultExtension) {
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
                                // Directly call toggleExtension with the extension name
                                // This ensures proper initialization without race conditions
                                if (window.toggleExtension) {
                                    window.toggleExtension(matchingExt.slug);
                                    console.log(`✅ Auto-loaded default extension: ${defaultExtension} (${matchingExt.displayName})`);
                                } else {
                                    console.warn(`⚠️ toggleExtension function not available yet`);
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