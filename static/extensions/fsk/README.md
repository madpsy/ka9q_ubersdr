# FSK/RTTY Decoder Extension

A comprehensive FSK (Frequency Shift Keying) and RTTY (Radioteletype) decoder for UberSDR.

## Features

- **Multiple Encoding Modes:**
  - ITA2 (Baudot) - Standard RTTY with LTRS/FIGS shift
  - ASCII - 7/8-bit ASCII encoding
  - CCIR476 - Error-correcting code for SITOR-B

- **Flexible Configuration:**
  - Adjustable frequency shift (50-1000 Hz)
  - Variable baud rates (36-300 baud)
  - Multiple framing formats (5N1, 5N1.5, 5N2, 7N1, 8N1, 4/7)
  - Inverted/non-inverted modes
  - Adjustable center frequency

- **Built-in Presets:**
  - **Ham RTTY**: 170 Hz shift, 45.45 baud (standard amateur radio)
  - **SITOR-B**: 170 Hz shift, 100 baud, CCIR476 encoding
  - **Weather**: 450 Hz shift, 50 baud (weather broadcasts)

## Usage

1. **Start Audio**: Ensure audio is playing in UberSDR
2. **Select Mode**: Choose USB mode with appropriate bandwidth (2.4 kHz recommended)
3. **Tune**: Tune to an FSK/RTTY signal
4. **Configure**: Select a preset or adjust parameters manually
5. **Start Decoding**: Click the "Start" button
6. **View Output**: Decoded text appears in the output window

## Configuration Parameters

### Shift (Hz)
The frequency difference between mark and space tones. Common values:
- 170 Hz - Amateur radio RTTY, SITOR-B
- 200 Hz - Commercial RTTY
- 425 Hz - Military RTTY
- 450 Hz - Weather broadcasts
- 850 Hz - Military RTTY

### Baud Rate
The symbol rate in symbols per second:
- 45.45 - Standard amateur RTTY
- 50 - Weather broadcasts, some commercial
- 75 - Commercial RTTY
- 100 - SITOR-B, some commercial
- 150-300 - High-speed modes

### Center Frequency
The audio frequency at the center of the FSK signal (typically 1000-2000 Hz for USB reception).

### Framing
The bit structure of each character:
- **5N1**: 5 data bits, no parity, 1 stop bit
- **5N1.5**: 5 data bits, no parity, 1.5 stop bits (standard RTTY)
- **5N2**: 5 data bits, no parity, 2 stop bits
- **7N1**: 7 data bits, no parity, 1 stop bit
- **8N1**: 8 data bits, no parity, 1 stop bit
- **4/7**: CCIR476 format (4 data bits, 7 total bits)

### Encoding
The character set used:
- **ITA2 (Baudot)**: 5-bit code with LTRS/FIGS shift (standard RTTY)
- **ASCII**: 7 or 8-bit ASCII
- **CCIR476**: Error-correcting code used in SITOR-B

### Inverted
Swaps mark and space tones. Some stations transmit inverted FSK.

## Technical Details

This extension is based on the KiwiSDR FSK extension by John Seamons (ZL4VO/KF6VO) and has been adapted to work with UberSDR's Web Audio API architecture.

### Signal Processing
- Biquad bandpass filters for mark/space separation
- Zero-crossing detection for baud rate tracking
- Adaptive bit synchronization
- Audio level monitoring

### Architecture
The decoder runs entirely in the browser using JavaScript:
1. Audio samples are captured from the Web Audio API
2. FSK demodulation is performed using digital filters
3. Bit timing is synchronized using zero-crossing detection
4. Characters are decoded according to the selected encoding
5. Decoded text is displayed in real-time

## Credits

- Original KiwiSDR FSK extension: John Seamons, ZL4VO/KF6VO
- FSK demodulator algorithm: Paul Lutus (lutusp@arachnoid.com)
- UberSDR adaptation: UberSDR Project

## License

Based on GPL-licensed code from the KiwiSDR project.
