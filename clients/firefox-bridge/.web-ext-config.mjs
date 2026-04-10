// web-ext configuration
// https://extensionworkshop.com/documentation/develop/web-ext-configuration-file/

export default {
    // Source directory containing the extension files
    sourceDir: 'extension',

    // Output directory for built .xpi files
    artifactsDir: 'dist',

    build: {
        // Overwrite existing artifacts on each build
        overwriteDest: true,
    },

    run: {
        // Default Firefox binary to use for `npm run dev`
        // Override with: WEB_EXT_FIREFOX=/path/to/firefox npm run dev
        firefox: 'firefox',

        // Keep the browser open after the extension is loaded
        keepProfileChanges: false,

        // Open the browser console automatically
        browserConsole: false,

        // Start URLs to open when running in dev mode
        startUrl: ['about:debugging#/runtime/this-firefox'],
    },

    lint: {
        // Treat warnings as errors in CI
        warningsAsErrors: false,
    },
};
