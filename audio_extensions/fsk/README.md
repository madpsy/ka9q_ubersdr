# FSK Audio Extension

The FSK (Frequency Shift Keying) audio extension provides decoding capabilities for various FSK-based digital modes including NAVTEX, Weather RTTY, and other RTTY variants.

## Supported Modes

### NAVTEX (SITOR-B)
- **Encoding**: CCIR476 (error-correcting code with 4-of-7 bit checking)
- **Baud Rate**: 100 baud
- **Shift**: 170 Hz
- **Framing**: 4/7 (4 mark bits, 7 total bits)
- **Inverted**: No
- **Use Case**: Maritime safety information broadcasts on 518 kHz and other frequencies

### Weather RTTY
- **Encoding**: ITA2/Baudot (5-bit character code)
- **Baud Rate**: 50 baud
- **Shift**: 450 Hz
- **Framing**: 5N1.5 (5 data bits, no parity, 1.5 stop bits)
- **Inverted**: Yes
- **Use Case**: Weather facsimile and RTTY broadcasts

### Ham Radio RTTY
- **Encoding**: ITA2/Baudot
- **Baud Rate**: 45.45 baud
- **Shift**: 170 Hz
- **Framing**: 5N1.5
- **Inverted**: No
- **Use Case**: Amateur radio RTTY communications

## Architecture

### Backend Components

#### ITA2 Encoder (`ita2.go`)
Implements the ITA2/Baudot 5-bit character encoding used by RTTY:
- **Character Tables**: Separate letter and figure shift tables (US-TTY variant)
- **Shift Mechanism**: LETTERS (0x1f) and FIGURES (0x1b) codes switch between modes
- **Processing**: Uses delayed character processing - shift codes affect the NEXT character
- **No Error Correction**: All 5-bit codes are valid (unlike CCIR476)

Key implementation detail: ITA2 processes the **previous** character because shift codes affect subsequent characters, not themselves. This matches the KiwiSDR reference implementation.

#### CCIR476 Encoder (`ccir476.go`)
Implements the CCIR476 error-correcting code used by NAVTEX:
- **7-bit codes** with exactly 4 mark bits and 3 space bits for error detection
- **Alpha/Rep phases** for forward error correction
- **Automatic resynchronization** on errors

#### FSK Demodulator (`fsk_demod.go`)
Core demodulation engine:
- **Dual-filter design**: Separate bandpass filters for mark and space frequencies
- **Baud rate tracking**: Zero-crossing detection with automatic correction
- **State machine**: NoSignal → Sync1 → Sync2 → ReadData
- **Encoding-agnostic**: Supports both CCIR476 and ITA2 through interface

### Configuration

The FSK extension accepts the following parameters:

```go
type FSKConfig struct {
    CenterFrequency float64 // Hz (audio center frequency)
    Shift           float64 // Hz (mark-space shift)
    BaudRate        float64 // Baud rate
    Inverted        bool    // Invert mark/space
    Framing         string  // Framing format (e.g., "4/7", "5N1.5")
    Encoding        string  // Character encoding ("CCIR476" or "ITA2")
}
```

### Presets

Three built-in presets are available:

```go
// NAVTEX/SITOR-B
NavtexConfig() // 500Hz center, 170Hz shift, 100 baud, CCIR476

// Weather RTTY  
WeatherConfig() // 1000Hz center, 450Hz shift, 50 baud, ITA2, inverted

// Default (NAVTEX)
DefaultFSKConfig()
```

## Frontend Integration

### Preset Selection

The frontend provides a dropdown with three presets:
- **NAVTEX** (500Hz/170/100) - Default
- **SITOR-B** (1000Hz/170/100) - Same as NAVTEX but different center frequency
- **Weather RTTY** (1000Hz/450/50) - Weather facsimile broadcasts
- **Custom** - Manual configuration

### Usage Example

```javascript
// Attach with weather RTTY preset
const attachMsg = {
    type: 'audio_extension_attach',
    extension_name: 'fsk',
    params: {
        preset: 'weather'  // Use preset
    }
};

// Or with custom parameters
const attachMsg = {
    type: 'audio_extension_attach',
    extension_name: 'fsk',
    params: {
        center_frequency: 1000,
        shift: 450,
        baud_rate: 50,
        inverted: true,
        framing: '5N1.5',
        encoding: 'ITA2'
    }
};
```

## Binary Protocol

The extension communicates via WebSocket using a binary protocol:

### Message Types

#### 0x01: Text Message
```
[type:1][timestamp:8][text_length:4][text:length]
```
- Decoded text characters from the FSK signal

#### 0x02: Baud Error
```
[type:1][error:8]
```
- Baud rate tracking error (float64, big-endian)
- Used for visual feedback on synchronization quality

#### 0x03: State Update
```
[type:1][state:1]
```
- Decoder state: 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData

## Implementation Notes

### ITA2 vs CCIR476

| Feature | ITA2 | CCIR476 |
|---------|------|---------|
| Bits per character | 5 | 7 |
| Error correction | None | 4-of-7 bit check + alpha/rep |
| Shift mechanism | Simple (LTRS/FIGS) | Complex (with phasing) |
| Typical use | RTTY, Weather | NAVTEX, SITOR-B |
| Sync strategy | Immediate | 4-character validation |

### Character Processing

**ITA2**: Processes the previous character because shift codes affect the next character:
```go
// Current code is stored for next iteration
i.lastCode = code

// Previous code is processed with current shift state
switch i.lastCode {
case i.letters: i.shift = false
case i.figures: i.shift = true
default: output(decode(i.lastCode, i.shift))
}
```

**CCIR476**: Processes current character with alpha/rep error correction:
```go
// Compare alpha and rep phases
if bitSuccess && c.c1 == code {
    chr = code  // Perfect match
} else if bitSuccess {
    chr = code  // Use alpha
} else if c.checkBits(c.c1) {
    chr = c.c1  // Use rep
}
```

### Baud Rate Tracking

The demodulator uses zero-crossing detection to track and correct baud rate drift:
1. Detect mark/space transitions
2. Histogram zero-crossing positions over multiple bit periods
3. Find peak position (most common crossing point)
4. Apply correction to bit sampling timing

This allows the decoder to maintain sync even with slight frequency drift.

## Testing

To test NAVTEX mode (should still work):
1. Tune to a NAVTEX frequency (e.g., 518 kHz)
2. Set mode to USB with 2.4 kHz bandwidth
3. Select "NAVTEX" preset
4. Start decoder

To test Weather RTTY mode:
1. Tune to a weather RTTY frequency
2. Set mode to USB with 2.4 kHz bandwidth  
3. Select "Weather RTTY" preset
4. Start decoder

## References

- [Baudot Code (Wikipedia)](https://en.wikipedia.org/wiki/Baudot_code)
- [CCIR476 Standard](https://en.wikipedia.org/wiki/CCIR_476)
- [KiwiSDR FSK Implementation](https://github.com/jks-prv/Beagle_SDR_GPS/tree/master/web/extensions/FSK)
- ITA2 character tables based on US-TTY variant

## Future Enhancements

Potential additions:
- ASCII encoding support (7N1, 8N1 framing)
- DSC (Digital Selective Calling) support
- SITOR-A (ARQ mode)
- Selcall decoding
- Configurable character tables (international ITA2 variants)
