# UberSDR Extension System

This directory contains the fully dynamic extension system for UberSDR, which allows you to add custom decoders and features without modifying core files.

## Directory Structure

```
extensions/
├── README.md                    # This file
├── extensions.json              # Configuration file listing enabled extensions
└── [extension-name]/            # Each extension in its own directory
    ├── manifest.json            # Extension metadata and configuration
    ├── main.js                  # Main extension code
    ├── styles.css               # Optional: Extension-specific styles
    └── template.html            # Optional: HTML template
```

## Creating a New Extension

### Step 1: Create Extension Directory

Create a new directory under `extensions/` with your extension name:

```bash
mkdir extensions/my-extension
```

### Step 2: Create manifest.json

Create a `manifest.json` file in your extension directory:

```json
{
  "name": "my-extension",
  "displayName": "My Extension",
  "version": "1.0.0",
  "description": "Description of what your extension does",
  "author": "Your Name",
  "files": {
    "main": "main.js",
    "styles": ["styles.css"],
    "template": "template.html"
  },
  "config": {
    "autoTune": false,
    "requiresMode": null,
    "preferredBandwidth": null
  }
}
```

**Manifest Fields:**
- `name`: Unique identifier (must match directory name)
- `displayName`: Human-readable name shown in UI
- `version`: Semantic version number
- `description`: Brief description of functionality
- `author`: Extension author name
- `files.main`: Main JavaScript file (required)
- `files.styles`: Array of CSS files (optional)
- `files.template`: HTML template file (optional)
- `config`: Extension-specific configuration

### Step 3: Create main.js

Your main JavaScript file must extend `DecoderExtension`:

```javascript
class MyExtension extends DecoderExtension {
    constructor() {
        super('my-extension', {
            displayName: 'My Extension',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });
    }

    onInitialize() {
        // Called when extension is initialized
        this.radio.log('My Extension initialized');
    }

    onEnable() {
        // Called when extension is enabled
    }

    onDisable() {
        // Called when extension is disabled
    }

    onProcessAudio(dataArray) {
        // Called for each audio frame
        // dataArray: Float32Array of audio samples
    }

    onProcessSpectrum(spectrumData) {
        // Called for each spectrum update
        // spectrumData: { powers, binBandwidth, centerFreq }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new MyExtension());
    console.log('✅ My Extension registered');
}
```

### Step 4: Create styles.css (Optional)

Add extension-specific styles:

```css
.my-extension-container {
    /* Your styles here */
}
```

### Step 5: Create template.html (Optional)

Add HTML template that will be loaded into the extension panel:

```html
<div class="my-extension-container">
    <h3>My Extension</h3>
    <div id="my-extension-output"></div>
</div>
```

Access the template in your code:
```javascript
const template = window.my_extension_template;
container.innerHTML = template;
```

### Step 6: Enable Your Extension

Add your extension to `extensions.json`:

```json
{
  "enabled": [
    "stats",
    "my-extension"
  ]
}
```

## Radio API

Extensions have access to the Radio API via `this.radio`:

### State Queries
- `getFrequency()` - Current frequency in Hz
- `getMode()` - Current mode (usb, lsb, cwu, cwl, am, sam, fm, nfm)
- `getBandwidth()` - Returns `{low, high, center, width}`
- `getAudioContext()` - Web Audio API context
- `getSampleRate()` - Audio sample rate
- `getBufferTime()` - Current audio buffer time in ms
- `isConnected()` - WebSocket connection status
- `getSessionId()` - Current session ID
- `getSpectrumData()` - Current spectrum data
- `getBands()` - Available frequency bands
- `getBookmarks()` - User bookmarks

### Radio Controls
- `setFrequency(freq)` - Set frequency in Hz
- `adjustFrequency(deltaHz)` - Adjust frequency by delta
- `setMode(mode)` - Set demodulation mode
- `setBandwidth(low, high)` - Set bandwidth in Hz

### Audio Processing
- `getAnalyser()` - Get pre-filter analyser node
- `getVUAnalyser()` - Get post-filter analyser node
- `getAudioBuffer(analyser)` - Get audio buffer data

### Filter Controls
- `enableBandpassFilter(centerFreq, width)` - Enable bandpass filter
- `disableBandpassFilter()` - Disable bandpass filter
- `addNotchFilter(frequency, width)` - Add notch filter

### Spectrum Controls
- `zoomSpectrum(frequency, binBandwidth)` - Zoom spectrum display

### Utilities
- `log(message, type)` - Log message (types: 'info', 'error', 'warning')
- `formatFrequency(hz)` - Format frequency for display
- `getFrequencyBand(freq)` - Get band name for frequency

### Event System
- `on(event, callback)` - Subscribe to events
- `off(event, callback)` - Unsubscribe from events
- `emit(event, data)` - Emit custom events

**Available Events:**
- `frequency_changed` - Frequency changed
- `mode_changed` - Mode changed
- `bandwidth_changed` - Bandwidth changed

## Extension Lifecycle

1. **Discovery**: `extension-loader.js` reads `extensions.json`
2. **Loading**: For each enabled extension:
   - Load `manifest.json`
   - Load CSS files (if specified)
   - Load HTML template (if specified)
   - Load main JavaScript file
3. **Registration**: Extension registers itself via `decoderManager.register()`
4. **Initialization**: `onInitialize()` called
5. **Enable/Disable**: User toggles extension in UI
6. **Processing**: `onProcessAudio()` and `onProcessSpectrum()` called continuously

## Example: Stats Extension

See the `stats/` directory for a complete example that demonstrates:
- Manifest configuration
- Separate CSS file
- HTML template
- Audio processing
- Spectrum processing
- UI updates
- Radio API usage

## Best Practices

1. **Keep extensions focused**: Each extension should do one thing well
2. **Use external files**: Separate CSS, HTML, and JS for maintainability
3. **Handle errors gracefully**: Check for null/undefined before accessing data
4. **Clean up resources**: Remove event listeners in `onDisable()`
5. **Document your code**: Add comments explaining complex logic
6. **Test thoroughly**: Test with different modes and frequencies
7. **Version your extensions**: Use semantic versioning in manifest

## Troubleshooting

### Extension not loading
- Check browser console for errors
- Verify extension is listed in `extensions.json`
- Ensure `manifest.json` is valid JSON
- Check file paths in manifest match actual files

### Template not found
- Verify `template` field in manifest.json
- Check template file exists
- Access via `window.[extensionname]_template`

### Styles not applying
- Check CSS file is listed in manifest
- Verify CSS selectors are correct
- Use browser dev tools to inspect elements

### Extension not receiving data
- Ensure extension is enabled in UI
- Check `onProcessAudio()` and `onProcessSpectrum()` are implemented
- Verify audio/spectrum data is available

## Support

For questions or issues:
- Check existing extensions for examples
- Review the Radio API documentation above
- Open an issue on GitHub