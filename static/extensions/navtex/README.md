# NAVTEX Decoder Extension

NAVTEX/DSC/Selcall FSK decoder extension for UberSDR that receives and displays maritime safety information broadcasts.

## Features

- **Real-time decoding** - Displays decoded text as it is received
- **CCIR476 error correction** - Forward error correction recovers text even with weak signals
- **Configurable parameters** - Adjust center frequency, shift, baud rate
- **Baud error visualization** - Visual indicator shows timing accuracy
- **Auto-scroll** - Automatically scrolls to show latest received text
- **Text export** - Save decoded messages as text files
- **Multiple modes** - Supports NAVTEX, DSC, and Selcall (NAVTEX implemented first)

## Usage

### Quick Start with Station Selector

1. **Enable the extension** - Click the NAVTEX icon in the decoder extensions panel
2. **Select a station** - Choose from the "Quick Tune" dropdown menu
3. **Click Start** - Begin decoding the FSK signal
4. **Watch the text** - Decoded characters appear in real-time in the console
5. **Save text** - Click "Save Text" to download the decoded messages

### Manual Tuning

1. **Enable the extension** - Click the NAVTEX icon in the decoder extensions panel
2. **Tune to a NAVTEX frequency** - Common frequencies include:
   - 518 kHz (USB) - International NAVTEX
   - 490 kHz (USB) - National NAVTEX
   - 4.210 MHz (USB) - HF NAVTEX
3. **Set mode to USB** - NAVTEX uses upper sideband
4. **Adjust settings** - Configure center frequency (500 Hz), shift (170 Hz), baud (100)
5. **Click Start** - Begin decoding
6. **Monitor baud error** - Green/red bar shows timing accuracy

## Configuration

### Center Frequency
- **Default: 500 Hz** - Standard NAVTEX/DSC center frequency
- Range: 1-10000 Hz
- Adjust if the signal is off-frequency

### Shift
- **Default: 170 Hz** - Standard FSK shift for NAVTEX/DSC
- Range: 1-1000 Hz
- Common values: 170 Hz (NAVTEX/DSC), 850 Hz (RTTY)

### Baud Rate
- **Default: 100 Bd** - Standard NAVTEX/DSC baud rate
- Range: 10-1000 Bd
- Common values: 100 Bd (NAVTEX/DSC), 45.45 Bd (RTTY), 50 Bd (RTTY)

### Encoding
- **CCIR476** - Forward error-correcting code used by NAVTEX
- 4/7 framing (4 mark bits, 3 space bits per character)
- Automatic error detection and correction

### Inverted
- **Default: Off** - Normal mark/space polarity
- Enable if the signal appears inverted

## Technical Details

### Audio Extension Integration

The NAVTEX decoder uses the UberSDR audio extension framework:

1. **Frontend** ([`main.js`](main.js:1)) - Manages UI and sends control messages
2. **Backend** ([`audio_extensions/navtex/`](../../../audio_extensions/navtex/)) - Processes audio and decodes FSK
3. **Communication** - Binary text messages via DX WebSocket

### Binary Protocol

Decoded text and baud error are sent as binary WebSocket messages:

**Text Message (0x01):**
```
[type:1][timestamp:8][text_length:4][text:length]
```

- `type` (1 byte): 0x01 = text message
- `timestamp` (8 bytes): Unix timestamp (big-endian uint64)
- `text_length` (4 bytes): Text length in bytes (big-endian uint32)
- `text` (variable): UTF-8 encoded text

**Baud Error (0x02):**
```
[type:1][error:8]
```

- `type` (1 byte): 0x02 = baud error
- `error` (8 bytes): Baud error value (float64, big-endian)

### FSK Demodulation

The backend decoder implements:
- **Biquad bandpass filters** - Separate mark and space frequencies
- **Zero-crossing detection** - Tracks and corrects baud rate timing
- **Bit synchronization** - Aligns to bit boundaries
- **CCIR476 decoding** - Forward error correction with alpha/rep phasing

### Baud Error Indicator

The baud error display shows timing accuracy:
- **Green bar (positive)** - Decoder is running slightly fast
- **Red bar (negative)** - Decoder is running slightly slow
- **Centered** - Perfect timing
- The decoder automatically corrects timing errors

## Common NAVTEX Stations

### MF (Medium Frequency)
- **518 kHz** - International NAVTEX (worldwide)
- **490 kHz** - National NAVTEX (country-specific)
- **4.210 MHz** - Tropical NAVTEX

### HF (High Frequency)
- **4.210 MHz** - HF NAVTEX
- **6.314 MHz** - HF NAVTEX
- **8.417 MHz** - HF NAVTEX
- **12.579 MHz** - HF NAVTEX
- **16.807 MHz** - HF NAVTEX

### DSC (Digital Selective Calling)
- **2.188 MHz** - MF DSC
- **4.208 MHz** - 4 MHz DSC
- **6.312 MHz** - 6 MHz DSC
- **8.415 MHz** - 8 MHz DSC
- **12.577 MHz** - 12 MHz DSC
- **16.805 MHz** - 16 MHz DSC

## Troubleshooting

### No text appears
- Check that you're tuned to an active NAVTEX/DSC frequency
- Verify mode is set to USB
- Ensure center frequency matches the signal (adjust if needed)
- Check that the decoder is running (status should show "Running")

### Garbled text
- Signal may be weak - CCIR476 error correction helps but has limits
- Check baud error indicator - large errors indicate timing problems
- Adjust center frequency to center on the signal
- Try a different frequency with stronger signal

### Baud error is large
- Signal may be off-frequency - adjust center frequency
- Transmitter may have timing issues
- The decoder will automatically track and correct small errors

### Text stops appearing
- Transmission may have ended (NAVTEX broadcasts are scheduled)
- Check signal strength on waterfall
- Verify decoder is still running

## Files

- [`manifest.json`](manifest.json:1) - Extension metadata and settings
- [`main.js`](main.js:1) - Frontend JavaScript implementation
- [`template.html`](template.html:1) - UI template
- [`styles.css`](styles.css:1) - Extension-specific styles
- [`README.md`](README.md:1) - This file

## References

- [NAVTEX on Wikipedia](https://en.wikipedia.org/wiki/Navtex)
- [CCIR476 on Wikipedia](https://en.wikipedia.org/wiki/CCIR_476)
- [DSC on Wikipedia](https://en.wikipedia.org/wiki/Digital_selective_calling)
- [Audio Extension Framework](../../../AUDIO_EXTENSION_FRAMEWORK.md)

## Version History

### 1.0.0 (2026-02-09)
- Initial release
- Real-time NAVTEX decoding with CCIR476 error correction
- FSK demodulation with baud rate tracking
- Configurable parameters
- Text export functionality
- Baud error visualization
