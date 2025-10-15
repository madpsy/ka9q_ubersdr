// Extension Loader - Auto-loads extensions from configuration
// No server-side logic required - pure client-side implementation

(async function() {
    try {
        // Load extension configuration
        const config = await fetch('/extensions/extensions.json').then(r => r.json());
        
        console.log(`🔌 Loading ${config.enabled.length} extension(s)...`);
        
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
                    window[`${extName}_template`] = html;
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
                
                console.log(`✅ Successfully loaded extension: ${manifest.displayName || extName}`);
            } catch (err) {
                console.error(`❌ Failed to load extension "${extName}":`, err);
            }
        }
        
        console.log('🎉 Extension loading complete');
    } catch (err) {
        console.error('❌ Failed to load extensions configuration:', err);
        console.error('Make sure /extensions/extensions.json exists and is valid JSON');
    }
})();