# Pluggable Radio System

The oldradio interface now supports multiple radio models through a pluggable architecture. Users can select which vintage radio they want to use from a selection screen.

## Directory Structure

```
radios/
├── radios.json          # Registry of available radios
├── README.md            # This file
└── [radio-id]/          # Each radio has its own directory
    ├── config.json      # Radio configuration
    ├── template.html    # Radio HTML template
    └── style.css        # Radio-specific styles
```

## Creating a New Radio

To add a new radio model:

### 1. Create Radio Directory

Create a new directory under `radios/` with a unique ID (e.g., `radios/philco/`)

### 2. Create config.json

```json
{
  "id": "your-radio-id",
  "name": "Display Name",
  "brand": "BRAND NAME",
  "model": "MODEL DESCRIPTION",
  "description": "Brief description for selector",
  "minFreq": 600000,
  "maxFreq": 2000000,
  "mode": "am",
  "dialGearRatio": 10,
  "frequencyScale": [
    { "position": "0%", "label": "600" },
    { "position": "50%", "label": "1300" },
    { "position": "100%", "label": "2000" }
  ],
  "volumeNotches": 12,
  "defaultFrequency": 1000000,
  "defaultVolume": 0.7,
  "theme": {
    "primaryColor": "#d4a574",
    "secondaryColor": "#ff6b35",
    "bodyGradient": "linear-gradient(145deg, #8b6f47, #6b5537)",
    "borderColor": "#4a3a2a"
  }
}
```

### 3. Create template.html

The template should include these required elements with specific IDs:

- `speaker-grille` - Speaker grille container
- `oscilloscope-overlay` - Oscilloscope overlay
- `oscilloscope-canvas` - Canvas for oscilloscope
- `scale-marks` - Container for frequency scale marks
- `frequency-needle` - Frequency indicator needle
- `frequency-value` - Text display for frequency
- `tuning-dial` - Tuning dial control
- `volume-notches` - Container for volume notches
- `volume-knob` - Volume knob control
- `power-indicator` - Signal strength LED

Template variables:
- `{{brand}}` - Replaced with config.brand
- `{{model}}` - Replaced with config.model

### 4. Create style.css

Define radio-specific styles. The base styles are in the main `style.css`, so you only need to override:

- `.radio-body` - Radio body dimensions and styling
- `.radio-brand` - Brand name styling
- `.radio-model` - Model name styling
- `.speaker-grille` - Speaker grille appearance
- `.frequency-readout` - Frequency display styling
- `.dial`, `.knob` - Control knob styling
- Any other radio-specific elements

### 5. Register in radios.json

Add your radio to the `radios.json` file:

```json
{
  "radios": [
    {
      "id": "grundig",
      "name": "Grundig AM Receiver",
      "description": "Classic Grundig AM radio with vintage styling",
      "path": "radios/grundig"
    },
    {
      "id": "your-radio-id",
      "name": "Your Radio Name",
      "description": "Description shown in selector",
      "path": "radios/your-radio-id"
    }
  ],
  "default": "grundig"
}
```

## Configuration Options

### config.json Fields

- **id**: Unique identifier for the radio
- **name**: Display name shown in selector
- **brand**: Brand name shown on radio (supports template variable)
- **model**: Model description shown on radio (supports template variable)
- **description**: Brief description for radio selector
- **minFreq**: Minimum frequency in Hz (e.g., 600000 for 600 kHz)
- **maxFreq**: Maximum frequency in Hz (e.g., 2000000 for 2000 kHz)
- **mode**: Radio mode (currently only "am" supported)
- **dialGearRatio**: Gear ratio for tuning dial (higher = slower tuning)
- **frequencyScale**: Array of frequency markers for the scale
  - **position**: CSS position (e.g., "0%", "50%", "100%")
  - **label**: Text label for the marker
- **volumeNotches**: Number of volume notches (typically 11-12)
- **defaultFrequency**: Starting frequency in Hz
- **defaultVolume**: Starting volume (0.0 to 1.0)
- **theme**: Color theme (optional, for future use)

## URL Parameters

The radio system supports URL parameters:

- `?radio=grundig` - Select specific radio
- `?freq=1000000` - Set frequency (in Hz)
- `?vol=0.7` - Set volume (0.0 to 1.0)

Example: `?radio=grundig&freq=1500000&vol=0.8`

## Example: Grundig Radio

See `radios/grundig/` for a complete working example of a radio implementation.

## Tips

1. **Frequency Scale**: Adjust the frequency scale markers to match your radio's dial markings
2. **Gear Ratio**: Higher values make tuning slower and more precise
3. **Styling**: Use the Grundig radio as a template and modify colors, sizes, and layouts
4. **Testing**: Test your radio with different frequencies and volume levels
5. **Responsive**: Ensure your styles work on mobile devices

## Future Enhancements

Potential additions to the system:
- Support for different modes (FM, SSB, etc.)
- Custom frequency ranges per radio
- Radio-specific audio processing
- Animated controls
- Multiple speaker configurations