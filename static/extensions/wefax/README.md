# WEFAX Decoder Extension

Weather Fax (WEFAX) decoder extension for UberSDR that receives and displays weather charts and satellite images transmitted via HF radio.

## Features

- **Real-time decoding** - Displays weather fax images as they are received
- **Automatic phasing** - Detects and corrects image alignment using phasing lines
- **Configurable parameters** - Adjust LPM, carrier frequency, deviation, and bandwidth
- **Auto-stop detection** - Automatically stops on stop signal (optional)
- **Image export** - Save decoded images as PNG files
- **Auto-scroll** - Automatically scrolls to show latest received lines

## Usage

### Quick Start with Station Selector

1. **Enable the extension** - Click the WEFAX icon in the decoder extensions panel
2. **Select a station** - Choose from the "Quick Tune" dropdown menu
3. **Click Tune** - Automatically sets frequency, mode, and LPM
4. **Click Start** - Begin decoding the weather fax signal
5. **Wait for image** - The decoder will automatically detect phasing lines and align the image
6. **Save image** - Click "Save Image" to download the decoded image as PNG

### Manual Tuning

1. **Enable the extension** - Click the WEFAX icon in the decoder extensions panel
2. **Tune to a WEFAX frequency** - Common frequencies include:
   - 3.855 MHz (USB)
   - 7.880 MHz (USB)
   - 13.882.5 MHz (USB)
   - 16.971 MHz (USB)
3. **Set mode to USB** - WEFAX uses upper sideband
4. **Adjust settings** - Configure LPM, carrier, and deviation to match the transmission
5. **Click Start** - Begin decoding the weather fax signal
6. **Wait for image** - The decoder will automatically detect phasing lines and align the image
7. **Save image** - Click "Save Image" to download the decoded image as PNG

## Configuration

### Lines Per Minute (LPM)
- **60 LPM** - Slow scan (rare)
- **90 LPM** - Medium scan
- **120 LPM** - Standard scan (most common)
- **240 LPM** - Fast scan

### Carrier Frequency
- **Default: 1900 Hz** - Standard WEFAX carrier
- Range: 1000-3000 Hz
- Adjust if the signal is off-frequency

### Deviation
- **Default: 400 Hz** - Standard WEFAX deviation
- Range: 100-800 Hz
- Affects the contrast and dynamic range

### Image Width
- **Default: 1809 pixels** - Standard IOC-576 format
- Range: 800-4000 pixels
- Common widths: 1809 (IOC-576), 1200 (IOC-288)

### Bandwidth
- **Narrow** - Tightest filtering, best for weak signals
- **Middle** - Balanced (default)
- **Wide** - Widest filtering, best for strong signals

### Use Phasing
- **Enabled (default)** - Automatically detects phasing lines and aligns image
- **Disabled** - No automatic alignment (manual phasing required)

### Auto-Stop
- **Disabled (default)** - Continues decoding indefinitely
- **Enabled** - Automatically stops when stop signal is detected

## Technical Details

### Audio Extension Integration

The WEFAX decoder uses the UberSDR audio extension framework:

1. **Frontend** ([`main.js`](main.js:1)) - Manages UI and sends control messages
2. **Backend** ([`audio_extensions/wefax/`](../../../audio_extensions/wefax/)) - Processes audio and decodes WEFAX
3. **Communication** - Binary image data sent via DX WebSocket

### Binary Protocol

Image lines are sent as binary WebSocket messages:

```
[type:1][line_number:4][width:4][pixel_data:width]
```

- `type` (1 byte): 0x01 = image line
- `line_number` (4 bytes): Big-endian uint32 line number
- `width` (4 bytes): Big-endian uint32 image width
- `pixel_data` (width bytes): Grayscale pixel values (0-255)

### Rendering

- Canvas grows dynamically as lines are received
- Lines are rendered in real-time with auto-scroll
- Image data is stored in canvas for export

## Common WEFAX Stations

### North America
- **NMG (New Orleans)** - 4.317.9, 8.503.9, 12.789.9, 17.146.4 MHz
- **NMF (Boston)** - 4.235, 6.340.5, 9.110, 12.750 MHz

### Europe
- **DDH47 (Germany)** - 3.855, 7.880, 13.882.5 MHz
- **GYA (UK)** - 2.618.5, 4.610, 8.040, 11.086.5 MHz

### Asia/Pacific
- **JMH (Japan)** - 3.622.5, 7.795, 9.970, 13.597.5 MHz
- **NMO (Hawaii)** - 10.865, 13.861.5 MHz

## Troubleshooting

### No image appears
- Check that you're tuned to an active WEFAX frequency
- Verify mode is set to USB
- Ensure carrier frequency matches the signal (adjust if needed)
- Try different bandwidth settings

### Image is slanted or misaligned
- Enable "Use Phasing" for automatic alignment
- Wait for phasing lines (transmitted at start of image)
- Adjust image width if using non-standard format

### Image is too dark or too bright
- Adjust deviation setting
- Check audio levels (should not be clipping)
- Try different bandwidth settings

### Image has horizontal lines or noise
- Signal may be weak - try narrow bandwidth
- Check for interference on the frequency
- Adjust carrier frequency to center on signal

## Files

- [`manifest.json`](manifest.json:1) - Extension metadata and settings
- [`main.js`](main.js:1) - Frontend JavaScript implementation
- [`template.html`](template.html:1) - UI template
- [`styles.css`](styles.css:1) - Extension-specific styles
- [`README.md`](README.md:1) - This file

## References

- [WEFAX on Wikipedia](https://en.wikipedia.org/wiki/Radiofax)
- [IOC-576 Standard](https://en.wikipedia.org/wiki/IOC-576)
- [Audio Extension Framework](../../../AUDIO_EXTENSION_FRAMEWORK.md)

## Version History

### 1.0.0 (2026-02-08)
- Initial release
- Real-time WEFAX decoding
- Automatic phasing detection
- Configurable parameters
- Image export functionality
