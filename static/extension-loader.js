// Extension Loader - Auto-loads extensions from configuration
// No server-side logic required - pure client-side implementation

(async function() {
    try {
        // Load all extension assets in a single request
        const response = await fetch('/api/extensions/bundle').then(r => r.json());

        const bundles = response.bundles || [];
        const defaultExtension = response.default || null;

        console.log(`🔌 Loading ${bundles.length} extension(s) from bundle...`);
        if (defaultExtension) {
            console.log(`🎯 Default extension: ${defaultExtension}`);
        }

        // Array to store extension info for dropdown
        const extensionsList = [];

        // Inject each enabled extension's assets from the bundle
        for (const bundle of bundles) {
            const extName = bundle.slug;
            try {
                console.log(`📦 Loading extension: ${bundle.displayName || extName}`);

                // Inject CSS inline as <style> elements (no extra GET)
                if (bundle.styles && bundle.styles.length > 0) {
                    for (const cssContent of bundle.styles) {
                        const style = document.createElement('style');
                        style.textContent = cssContent;
                        document.head.appendChild(style);
                        console.log(`  ✓ Injected CSS for: ${extName}`);
                    }
                }

                // Store HTML template in global scope (no extra GET)
                if (bundle.template) {
                    const normalizedName = extName.replace(/-/g, '_');
                    window[`${normalizedName}_template`] = bundle.template;
                    console.log(`  ✓ Injected template for: ${extName}`);
                }

                // Inject extra scripts[] inline (no extra GET, preserves load order)
                if (bundle.scripts && bundle.scripts.length > 0) {
                    for (const scriptContent of bundle.scripts) {
                        const script = document.createElement('script');
                        script.textContent = scriptContent;
                        document.body.appendChild(script);
                        console.log(`  ✓ Injected extra script for: ${extName}`);
                    }
                }

                // Inject main JS inline (no extra GET)
                if (bundle.main) {
                    const script = document.createElement('script');
                    script.textContent = bundle.main;
                    document.body.appendChild(script);
                    console.log(`  ✓ Injected main script for: ${extName}`);
                }

                // Store extension info for dropdown
                extensionsList.push({
                    slug: bundle.slug,
                    originalSlug: extName,
                    displayName: bundle.displayName || extName,
                    icon: bundle.icon
                });

                console.log(`✅ Successfully loaded extension: ${bundle.displayName || extName}`);
            } catch (err) {
                console.error(`❌ Failed to inject extension "${extName}":`, err);
            }
        }

        // Populate extensions dropdown
        populateExtensionsDropdown(extensionsList);

        // Auto-load default extension if specified AND no URL parameter overrides it
        if (defaultExtension) {
            // Check if we're on a mobile/narrow screen
            const isMobile = window.matchMedia('(max-width: 1024px)').matches;
            if (isMobile) {
                console.log(`📱 Mobile device detected - skipping default extension auto-load`);
                return; // Exit early, don't load extensions on mobile
            }

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
                                            // Template was already injected from bundle; use it directly
                                            const normalizedName = matchingExt.slug.replace(/-/g, '_');
                                            const templateHtml = window[`${normalizedName}_template`];
                                            if (templateHtml) {
                                                panelContent.innerHTML = templateHtml;
                                                panelTitle.textContent = decoder.displayName || matchingExt.slug;
                                                panel.style.display = 'block';

                                                // Initialize and enable decoder
                                                const centerFreq = 800; // Default center frequency
                                                window.decoderManager.initialize(matchingExt.slug, window.audioContext, window.analyser, centerFreq);
                                                window.decoderManager.enable(matchingExt.slug);

                                                // Notify extension that fresh DOM is ready for event binding
                                                if (typeof decoder.onActivate === 'function') {
                                                    decoder.onActivate();
                                                }

                                                console.log(`✅ Auto-loaded default extension: ${defaultExtension} (${matchingExt.displayName})`);
                                            } else {
                                                console.warn(`⚠️ Template not found for: ${matchingExt.slug}`);
                                            }
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
        console.error('❌ Failed to load extensions bundle:', err);
        console.error('Make sure /api/extensions/bundle endpoint is accessible');
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
