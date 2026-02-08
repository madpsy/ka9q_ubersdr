# WEFAX Audio Extension

Weather Fax (WEFAX) decoder for HF radiofax transmissions. This extension decodes analog weather fax images transmitted over shortwave radio.

## Overview

WEFAX is a slow-scan analog image transmission mode used primarily for transmitting weather maps, satellite images, and other meteorological data over HF radio. This decoder implements:

- **FM Demodulation**: Extracts image data from frequency-modulated carrier
- **17-tap FIR Filter**: Low-pass filtering with 3 bandwidth options
- **Start/Stop Detection**: Fourier transform-based detection of 300Hz/450Hz tones
- **Phasing Line Detection**: Automatic image alignment using phasing lines
- **Real-time Streaming**: Sends decoded image lines as they're received

## Ported from KiwiSDR

This implementation is a direct port of the KiwiSDR WEFAX decoder from C++ to pure Go:
- Source: `github.com/jks-prv/KiwiSDR/extensions/FAX/`
- Original author: Sean D'Epagnier (weatherfax_pi for OpenCPN)
- Adapted by: John Seamons (KiwiSDR)

## Configuration Parameters

### Required Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lpm` | integer | 120 | Lines per minute (60, 90, 120, 240) |
| `image_width` | integer | 1809 | Image width in pixels |
| `carrier` | float | 1900.0 | Carrier frequency in Hz |
| `deviation` | float | 400.0 | Deviation in Hz |

### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `bandwidth` | integer | 1 | Filter bandwidth (0=narrow, 1=middle, 2=wide) |
| `use_phasing` | boolean | true | Enable phasing line detection |
| `auto_stop` | boolean | false | Auto-stop on stop signal |
| `include_headers_in_images` | boolean | false | Include start/stop headers |

## Common WEFAX Frequencies

| Frequency | Station | Location | LPM | IOC |
|-----------|---------|----------|-----|-----|
| 3855 kHz | Northwood | UK | 120 | 576 |
| 4610 kHz | Northwood | UK | 120 | 576 |
| 8040 kHz | Northwood | UK | 120 | 576 |
| 7880 kHz | Boston | USA | 120 | 576 |
| 10536 kHz | Boston | USA | 120 | 576 |
| 13988.5 kHz | Boston | USA | 120 | 576 |
| 3016 kHz | New Orleans | USA | 120 | 576 |
| 4317.9 kHz | New Orleans | USA | 120 | 576 |
| 8503.9 kHz | New Orleans | USA | 120 | 576 |
| 12789.9 kHz | New Orleans | USA | 120 | 576 |

## Usage Example

### WebSocket Request

```json
{
  "command": "start_audio_extension",
  "extension": "wefax",
  "params": {
    "lpm": 120,
    "image_width": 1809,
    "carrier": 1900.0,
    "deviation": 400.0,
    "bandwidth": 1,
    "use_phasing": true,
    "auto_stop": false
  }
}
```

### Binary Output Protocol

The decoder streams image lines in real-time using a binary protocol:

```
[type:1][line_number:4][width:4][pixel_data:width]
```

- **type** (1 byte): Message type (0x01 = image line)
- **line_number** (4 bytes): Line number (big-endian uint32)
- **width** (4 bytes): Image width in pixels (big-endian uint32)
- **pixel_data** (width bytes): Grayscale pixel data (0-255 per pixel)

### JavaScript Client Example

```javascript
// Start WEFAX decoder
ws.send(JSON.stringify({
  command: 'start_audio_extension',
  extension: 'wefax',
  params: {
    lpm: 120,
    image_width: 1809,
    carrier: 1900.0,
    deviation: 400.0,
    use_phasing: true
  }
}));

// Receive binary image data
ws.onmessage = function(event) {
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then(buffer => {
      const view = new DataView(buffer);
      const type = view.getUint8(0);
      
      if (type === 0x01) {  // Image line
        const lineNumber = view.getUint32(1);
        const width = view.getUint32(5);
        const pixels = new Uint8Array(buffer, 9, width);
        
        // Draw line to canvas
        drawImageLine(lineNumber, width, pixels);
      }
    });
  }
};

function drawImageLine(lineNumber, width, pixels) {
  const canvas = document.getElementById('faxCanvas');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, 1);
  
  for (let i = 0; i < width; i++) {
    const gray = pixels[i];
    imageData.data[i * 4 + 0] = gray;  // R
    imageData.data[i * 4 + 1] = gray;  // G
    imageData.data[i * 4 + 2] = gray;  // B
    imageData.data[i * 4 + 3] = 255;   // A
  }
  
  ctx.putImageData(imageData, 0, lineNumber);
}
```

## Technical Details

### FIR Filter

17-tap low-pass filter with three bandwidth options:
- **Narrow**: Tightest filtering, best for weak signals
- **Middle**: Balanced (default)
- **Wide**: Widest bandwidth, best for strong signals

### FM Demodulation

The decoder uses I/Q demodulation:
1. Mix incoming audio with carrier frequency
2. Apply FIR filters to I and Q channels
3. Calculate phase difference between samples
4. Convert phase difference to pixel intensity

### Start/Stop Detection

Uses Fourier transform to detect:
- **Start tone**: 300 Hz (IOC 576) or 675 Hz (IOC 288)
- **Stop tone**: 450 Hz

Detection threshold: 5.0 (arbitrary units)

### Phasing Line Detection

Phasing lines are transmitted at the start of each image to indicate the correct horizontal alignment. The decoder:
1. Collects 40 phasing lines
2. Finds the position of the black-to-white transition
3. Calculates median position
4. Validates distribution (rejects if 90th - 10th percentile > 1/6 line width)
5. Applies offset to align subsequent image lines

### Sample Rate Adaptation

The decoder adapts to slight variations in sample rate:
- Tracks fractional sample accumulation
- Blends adjacent lines when needed
- Maintains synchronization over long transmissions

## Performance

- **CPU Usage**: Low (single-threaded, efficient algorithms)
- **Memory**: ~10 MB for typical 1809x2000 image
- **Latency**: Real-time (lines decoded as received)
- **Sample Rate**: Any (tested with 12000, 24000, 48000 Hz)

## Troubleshooting

### Image appears slanted
- Enable `use_phasing` (should be on by default)
- Check that carrier frequency is accurate
- Verify LPM setting matches transmission

### Image too dark or too bright
- Adjust receiver AGC settings
- Check deviation parameter (typically 400 Hz)
- Verify carrier frequency

### No image received
- Confirm correct frequency and mode (USB typically)
- Check that audio is reaching the decoder
- Verify carrier frequency (use waterfall to find exact frequency)
- Try different bandwidth settings

### Image has horizontal lines/noise
- Increase filter bandwidth (try `bandwidth: 2`)
- Check for interference on frequency
- Verify signal strength is adequate

## License

This code is ported from the KiwiSDR project and weatherfax_pi, both licensed under GPL v3.

Original copyright:
- Copyright (C) 2015 by Sean D'Epagnier (weatherfax_pi)
- Adapted for KiwiSDR by John Seamons

Go port:
- Copyright (C) 2026 (UberSDR project)

This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 3 of the License, or (at your option) any later version.
