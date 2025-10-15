// Extension Loader - Auto-loads extensions from configuration
// No server-side logic required - pure client-side implementation

(async function() {
    try {
        // Load extension configuration
        const config = await fetch('/extensions/extensions.json').then(r => r.json());
        
        console.log(`🔌 Loading ${config.enabled.length} extension(s)...`);
        
        // Array to store extension info for dropdown
        const extensionsList = [];
        
        // Load each enabled extension
        for (const extName of config.enabled) {
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
                
                // Load main JavaScript
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
        
        console.log('🎉 Extension loading complete');
    } catch (err) {
        console.error('❌ Failed to load extensions configuration:', err);
        console.error('Make sure /extensions/extensions.json exists and is valid JSON');
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