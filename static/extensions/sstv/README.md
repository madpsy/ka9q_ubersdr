# SSTV Decoder Extension

Slow Scan Television (SSTV) decoder extension for UberSDR that receives and displays SSTV images transmitted via HF radio.

## Features

- **Automatic mode detection** - Detects VIS codes and identifies 47 different SSTV modes
- **Real-time decoding** - Displays images as they are received line-by-line
- **Automatic sync correction** - Detects and corrects image slant using Hough Transform
- **FSK callsign decoding** - Automatically decodes callsigns transmitted after images
- **Color support** - Handles RGB, GBR, YUV, YUVY, and B/W color encodings
- **Image export** - Save decoded images as PNG files
- **Auto-save** - Optionally save images automatically when complete

## Supported Modes (47 total)

### Martin Modes (GBR)
- **M1**: 320x256, 446ms/line (slow, high quality)
- **M2**: 320x256, 227ms/line (fast)
- **M3**: 320x256, 446ms/line, 2x line height
- **M4**: 320x256, 227ms/line, 2x line height

### Scottie Modes (GBR)
- **S1**: 320x256, 428ms/line
- **S2**: 320x256, 278ms/line
- **SDX**: 320x256, 1050ms/line (very slow, best quality)

### Robot Modes (YUV)
- **R36**: 320x240, 150ms/line (most popular)
- **R72**: 320x240, 300ms/line
- **R12/R24**: 320x240, 100/200ms/line
- **R8-BW, R12-BW, R24-BW, R36-BW**: Black & white variants

### PD Modes (YUVY)
- **PD-50**: 320x256, 388ms/line
- **PD-90**: 320x256, 703ms/line
- **PD-120**: 640x496 (high resolution)
- **PD-160**: 512x400
- **PD-180**: 640x496
- **PD-240**: 640x496
- **PD-290**: 800x616 (highest resolution)

### Wraase SC Modes (RGB)
- **SC60**: 320x256, 240ms/line
- **SC120**: 320x256, 476ms/line
- **SC180**: 320x256, 711ms/line

### Pasokon Modes (RGB)
- **P3**: 640x496, 409ms/line
- **P5**: 640x496, 614ms/line
- **P7**: 640x496, 819ms/line

### MMSSTV Modes
- **MP series** (YUVY): MP73, MP115, MP140, MP175 - 320x256
- **MR series** (YUV): MR73, MR90, MR115, MR140, MR175 - 320x256
- **ML series** (YUV): ML180, ML240, ML280, ML320 - 640x496 (high resolution)

### Other
- **FAX480**: 512x480, black & white

## Usage

### Quick Start

1. **Enable the extension** - Click the SSTV icon in the decoder extensions panel
2. **Tune to an SSTV frequency** - Common frequencies:
   - 14.230 MHz (USB) - Primary SSTV frequency
   - 14.233 MHz (USB) - Alternative
   - 21.340 MHz (USB) - 15m band
   - 28.680 MHz (USB) - 10m band
3. **Set mode to USB** - SSTV uses upper sideband
4. **Click Start** - Begin listening for SSTV signals
5. **Wait for transmission** - The decoder will automatically:
   - Detect the VIS code
   - Identify the mode
   - Decode the image
   - Correct any slant
   - Decode the callsign (if present)
6. **Save image** - Click "Save Image" to download as PNG

### Configuration Options

#### Auto Sync Correction
- **Enabled (default)**: Automatically detects sync pulses and corrects image slant
- **Disabled**: No automatic correction (may result in slanted images)

#### Decode FSK Callsign
- **Enabled (default)**: Decodes FSK callsign transmitted after the image
- **Disabled**: Skips callsign decoding

#### MMSSTV Modes Only
- **Disabled (default)**: Accepts all 47 modes
- **Enabled**: Only decodes MMSSTV modes (MR/MP/ML series)

#### Auto-Save Images
- **Disabled (default)**: Manual save required
- **Enabled**: Automatically saves images when complete

#### Auto-Scroll
- **Enabled (default)**: Automatically scrolls to show latest received lines
- **Disabled**: Manual scrolling

## How SSTV Works

### VIS Code Detection
Before each image, a VIS (Vertical Interval Signaling) code is transmitted:
1. 300ms 1900 Hz calibration tone
2. 10ms break
3. 300ms 1900 Hz leader
4. 30ms 1200 Hz start bit
5. 8 or 16 data bits (30ms each, 1100 Hz = 1, 1300 Hz = 0)
6. 30ms 1200 Hz stop bit

The VIS code identifies which of the 47 modes is being used.

### Image Transmission
- Images are transmitted line-by-line
- Each line contains sync pulse + color channel data
- Color channels may be RGB, GBR, YUV, or YUVY depending on mode
- Typical resolutions: 320x256, 320x240, 640x496, 800x616

### Sync Correction
- Sync pulses (1200 Hz) mark the start of each line
- Hough Transform detects slant angle
- Sample rate is adjusted to correct slant
- Up to 3 correction iterations

### FSK Callsign
- Optional callsign transmitted after image
- 45.45 baud FSK (22ms/bit)
- 1900 Hz = 1, 2100 Hz = 0
- 6-bit ASCII encoding

## Common SSTV Frequencies

| Frequency | Band | Notes |
|-----------|------|-------|
| 3.845 MHz | 80m | LSB, evening activity |
| 7.171 MHz | 40m | LSB |
| 14.230 MHz | 20m | USB, **primary frequency** |
| 14.233 MHz | 20m | USB, alternative |
| 21.340 MHz | 15m | USB |
| 28.680 MHz | 10m | USB |

**Note**: Most SSTV activity is on 14.230 MHz USB.

## Technical Details

### Audio Extension Integration

The SSTV decoder uses the UberSDR audio extension framework:

1. **Frontend** ([`main.js`](main.js:1)) - Manages UI and handles binary messages
2. **Backend** ([`audio_extensions/sstv/`](../../../audio_extensions/sstv/)) - Processes audio and decodes SSTV
3. **Communication** - Binary data sent via DX WebSocket

### Binary Protocol

The decoder sends several message types:

#### Image Start (0x07)
```
[type:1][width:4][height:4]
```
Signals the start of a new image. Frontend clears canvas and resizes.

#### Mode Detected (0x02)
```
[type:1][mode_idx:1][extended:1][name_len:1][name:len]
```
Identifies the SSTV mode (e.g., "Martin M1").

#### Image Line (0x01)
```
[type:1][line:4][width:4][rgb_data:width*3]
```
Contains RGB pixel data for one line (3 bytes per pixel).

#### Image Complete (0x05)
```
[type:1][total_lines:4]
```
Signals image is complete. Frontend can trigger auto-save.

#### FSK Callsign (0x06)
```
[type:1][len:1][callsign:len]
```
Contains decoded callsign (e.g., "OH2EIQ").

#### Status (0x03)
```
[type:1][code:1][msg_len:2][message:len]
```
Status updates (e.g., "Decoding Martin M1...", "Aligning image...").

### Rendering

- Canvas is dynamically sized based on detected mode
- Lines are rendered in real-time as RGB data
- Image data is stored in canvas for export
- Auto-scroll keeps latest lines visible

## Troubleshooting

### No VIS Code Detected
- Ensure mode is USB (not LSB for HF)
- Check audio levels (should not clip)
- Verify you're tuned to the correct frequency
- Wait for transmission start (VIS is sent before image)

### Image Slanted
- Enable "Auto Sync Correction" (should be on by default)
- Wait for full image decode
- Decoder will automatically correct slant

### Wrong Colors
- Decoder automatically handles color space conversion
- Some modes use GBR or YUV (handled automatically)
- If colors still look wrong, the transmission may be corrupted

### Image Noise/Distortion
- Check signal strength (weak signals = more noise)
- Verify no interference on frequency
- Some noise is normal for weak signals

### No Callsign Displayed
- Not all transmissions include FSK callsign
- Ensure "Decode FSK Callsign" is enabled
- Callsign is transmitted after the image

## Files

- [`manifest.json`](manifest.json:1) - Extension metadata and settings
- [`main.js`](main.js:1) - Frontend JavaScript implementation
- [`template.html`](template.html:1) - UI template
- [`styles.css`](styles.css:1) - Extension-specific styles
- [`README.md`](README.md:1) - This file

## References

- [SSTV on Wikipedia](https://en.wikipedia.org/wiki/Slow-scan_television)
- [SSTV Handbook by OK2MNM](http://www.sstv-handbook.com/)
- [slowrx by OH2EIQ](https://github.com/windytan/slowrx)
- [MMSSTV Software](http://mmsstv.mods.jp/)
- [Audio Extension Framework](../../../AUDIO_EXTENSION_FRAMEWORK.md)

## Version History

### 1.0.0 (2026-02-09)
- Initial release
- 47 SSTV modes supported
- Automatic VIS detection (8-bit and 16-bit)
- Automatic sync correction
- FSK callsign decoding
- Real-time line-by-line rendering
- Image export functionality

## Credits

- **Oona Räisänen (OH2EIQ)**: Original slowrx SSTV decoder
- **John Seamons**: KiwiSDR adaptation
- **UberSDR Project**: Go port and UberSDR integration
