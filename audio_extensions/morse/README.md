# Morse Code (CW) Audio Decoder

This audio extension implements a real-time Morse code (CW) decoder for ubersdr, based on the PyMorseLive algorithm.

## Features

- **Multi-Channel Decoding**: Simultaneously decodes up to 5 CW signals
- **Automatic Signal Detection**: FFT-based spectrum analysis finds active CW tones
- **Adaptive WPM Detection**: Automatically adjusts to each sender's speed (12-45 WPM by default)
- **Timing-Based Decoding**: Uses mark/space duration analysis for robust decoding
- **SNR-Based Signal Detection**: Envelope detection with configurable SNR threshold
- **Real-time Output**: Streams decoded text, Morse elements, and WPM updates to the client

## Algorithm

The multi-channel decoder combines spectrum analysis with timing-based decoding:

1. **Spectrum Analysis**: FFT-based analysis (using gonum) detects up to 5 strongest CW tones
2. **Decoder Assignment**: Automatically assigns decoders to detected signals
3. **Envelope Detection**: Each decoder uses a Goertzel filter to track its assigned tone
4. **SNR Estimation**: Calculates signal-to-noise ratio using percentile-based noise floor
5. **Transition Detection**: Detects key-up and key-down transitions based on SNR thresholds
6. **Timing Classification**: Classifies mark/space durations as dots, dashes, or separators
7. **Adaptive WPM**: Each decoder independently tracks its signal's WPM
8. **Character Decoding**: Converts Morse patterns to characters using lookup table
9. **Idle Management**: Removes decoders after 15 seconds of inactivity

## Configuration Parameters

- **`center_frequency`** (float, default: 600 Hz): CW tone frequency to decode
- **`bandwidth`** (float, default: 100 Hz): Filter bandwidth around center frequency
- **`min_wpm`** (float, default: 12): Minimum words per minute
- **`max_wpm`** (float, default: 45): Maximum words per minute
- **`threshold_snr`** (float, default: 10 dB): SNR threshold for signal detection

## Output Protocol

The extension sends binary messages over the DX WebSocket:

### Text Message (0x01)
```
[type:1][timestamp:8][text_length:4][text:length]
```
- Decoded text characters

### Morse Elements (0x02)
```
[type:1][timestamp:8][morse_length:4][morse:length]
```
- Raw Morse elements: `.` (dit), `-` (dah), ` ` (character separator), `/` (word separator)

### WPM Update (0x03)
```
[type:1][wpm:8]
```
- Current WPM estimate (float64, big-endian)

### Decoder Assignment (0x04)
```
[type:1][decoder_id:1][frequency:8][active:1]
```
- Decoder assignment/removal notification
- `decoder_id`: 0-4 (decoder slot)
- `frequency`: Center frequency in Hz (float64, big-endian)
- `active`: 1 = assigned, 0 = removed

### Status Update (0x05)
```
[type:1][num_active:1][decoder_data...]
```
- Status of all active decoders
- `decoder_data`: `[id:1][frequency:8][wpm:8]` repeated for each active decoder

## Usage Example

```javascript
// Attach Morse decoder
dxWebSocket.send(JSON.stringify({
    type: 'audio_extension_attach',
    extension_name: 'morse',
    params: {
        center_frequency: 600,  // Hz
        bandwidth: 100,         // Hz
        min_wpm: 12,
        max_wpm: 45,
        threshold_snr: 10       // dB
    }
}));

// Handle messages
dxWebSocket.onmessage = (event) => {
    if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        console.log('Control message:', msg);
    } else {
        // Binary result from decoder
        const view = new DataView(event.data);
        const type = view.getUint8(0);
        
        if (type === 0x01) {
            // Text message
            const timestamp = view.getBigUint64(1, false);
            const length = view.getUint32(9, false);
            const text = new TextDecoder().decode(
                new Uint8Array(event.data, 13, length)
            );
            console.log('Decoded text:', text);
        } else if (type === 0x02) {
            // Morse elements
            const timestamp = view.getBigUint64(1, false);
            const length = view.getUint32(9, false);
            const morse = new TextDecoder().decode(
                new Uint8Array(event.data, 13, length)
            );
            console.log('Morse:', morse);
        } else if (type === 0x03) {
            // WPM update
            const wpm = view.getFloat64(1, false);
            console.log('WPM:', wpm.toFixed(1));
        }
    }
};
```

## Implementation Files

- **`decoder.go`**: Core Morse decoder with timing analysis
- **`signal_processing.go`**: Envelope detector, Goertzel filter, and SNR estimator
- **`morse_table.go`**: Morse code to character lookup table
- **`extension.go`**: Audio extension wrapper
- **`register.go`**: Extension factory and metadata

## Technical Details

### Timing Specifications

Based on PARIS standard (1 dit = 1.2 / WPM seconds):

- **Dot Short**: 0.8 × time_unit (minimum dot duration)
- **Dot Long**: 2.0 × time_unit (maximum dot duration)
- **Character Separator Short**: 1.5 × time_unit (minimum gap between characters)
- **Character Separator Long**: 4.0 × time_unit (maximum gap between characters)
- **Word Separator**: 6.5 × time_unit (minimum gap between words)

### Signal Processing

- **Goertzel Filter**: Single-frequency DFT for efficient tone detection
- **Envelope Follower**: Exponential moving average with α = 0.1
- **Noise Floor**: 20th percentile of recent signal samples
- **WPM Smoothing**: Exponential moving average with α = 0.3

## Credits

Based on the PyMorseLive algorithm by the PyMorseLive project.
Ported to Go for integration with ubersdr.
