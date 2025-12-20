# TCI IQ Streaming Implementation

This document describes the IQ streaming support added to the Python TCI server implementation.

## Overview

The TCI (Transceiver Control Interface) protocol supports multiple stream types, including:
- **Audio streams** (type 1) - Demodulated audio for digital modes
- **IQ streams** (type 0) - Raw complex baseband samples for SDR applications

This implementation adds full IQ streaming support to complement the existing audio streaming.

## TCI Protocol IQ Stream Specification

According to the TCI Protocol v2.0 specification, IQ streams use the following structure:

```c
struct Stream {
    uint32_t receiver;      // Receiver number
    uint32_t sample_rate;   // Sampling rate (48/96/192/384 kHz)
    uint32_t format;        // Sample type (3 = float32)
    uint32_t codec;         // Compression algorithm (0 = none)
    uint32_t crc;           // Checksum (0 = not used)
    uint32_t length;        // Number of FLOATS (not complex samples)
    uint32_t type;          // Stream type (0 = IQ_STREAM)
    uint32_t channels;      // Number of channels (2 for IQ: I and Q)
    uint32_t reserv[8];     // Reserved fields
    uint8_t data[...];      // IQ data (float32 interleaved I,Q,I,Q,...)
};
```

### Key Differences from Audio Streams

| Property | Audio Stream (type 1) | IQ Stream (type 0) |
|----------|----------------------|-------------------|
| Type | 1 (RX_AUDIO_STREAM) | 0 (IQ_STREAM) |
| Channels | 1 or 2 (configurable) | Always 2 (I and Q) |
| Sample Rates | 8/12/24/48 kHz | 48/96/192/384 kHz |
| Data Format | Demodulated audio | Raw complex baseband |
| Use Case | Digital modes (JTDX, WSJT-X) | SDR apps, skimmers, recording |

## Implementation Details

### New TCI Server Features

1. **IQ Sample Rate Control**
   ```python
   # Command: iq_samplerate:rate;
   # Valid rates: 48000, 96000, 192000, 384000 Hz
   await self._set_iq_samplerate(48000)
   ```

2. **IQ Streaming Control**
   ```python
   # Start IQ streaming: iq_start:receiver;
   await self._start_iq_streaming(0)
   
   # Stop IQ streaming: iq_stop:receiver;
   await self._stop_iq_streaming(0)
   ```

3. **IQ Data Transmission**
   ```python
   # Send IQ data to connected clients
   server.send_iq_data(rx=0, iq_data=bytes, sample_rate=48000)
   ```

### Integration with Radio Client

The Python radio client already supports IQ modes:
- `iq` - Standard IQ mode (bandwidth-limited)
- `iq48` - 48 kHz IQ bandwidth
- `iq96` - 96 kHz IQ bandwidth
- `iq192` - 192 kHz IQ bandwidth
- `iq384` - 384 kHz IQ bandwidth

These modes provide the raw IQ data that can be forwarded to TCI clients.

## Usage Example

### Starting IQ Streaming

```python
from tci_server import TCIServer

# Create TCI server
server = TCIServer(radio_client, port=40001)
server.start()

# Client sends commands:
# 1. Set IQ sample rate
#    iq_samplerate:96000;
#
# 2. Start IQ streaming for receiver 0
#    iq_start:0;

# Server sends IQ data when available
iq_data = get_iq_samples()  # Your IQ data source
server.send_iq_data(rx=0, iq_data=iq_data, sample_rate=96000)
```

### IQ Data Format

IQ data must be provided as:
- **Format**: float32 (32-bit floating point)
- **Layout**: Interleaved I and Q samples: `[I0, Q0, I1, Q1, I2, Q2, ...]`
- **Byte order**: Little-endian
- **Range**: Normalized to [-1.0, 1.0]

Example of generating IQ data:
```python
import numpy as np

# Generate 1000 complex samples
num_samples = 1000
i_samples = np.random.randn(num_samples).astype(np.float32)
q_samples = np.random.randn(num_samples).astype(np.float32)

# Interleave I and Q
iq_data = np.empty(num_samples * 2, dtype=np.float32)
iq_data[0::2] = i_samples  # Even indices = I
iq_data[1::2] = q_samples  # Odd indices = Q

# Convert to bytes
iq_bytes = iq_data.tobytes()

# Send to TCI clients
server.send_iq_data(0, iq_bytes, sample_rate=48000)
```

## Testing

A test script is provided to verify IQ streaming functionality:

```bash
cd clients/python
python test_tci_iq.py
```

This will:
1. Start a TCI server on port 40001
2. Simulate IQ data transmission at various sample rates
3. Allow you to connect with a TCI client to verify reception

## Compatible Applications

Applications that support TCI IQ streaming:
- **CW Skimmer** - CW decoding and skimming
- **HDSDR** - SDR receiver software
- **Custom SDR applications** - Any software implementing TCI protocol

## Bandwidth Matching

The radio client's IQ modes correspond to TCI sample rates:

| Radio Mode | Bandwidth | TCI Sample Rate |
|------------|-----------|-----------------|
| `iq48` | ±24 kHz | 48 kHz |
| `iq96` | ±48 kHz | 96 kHz |
| `iq192` | ±96 kHz | 192 kHz |
| `iq384` | ±192 kHz | 384 kHz |

When a TCI client requests a specific IQ sample rate, the radio client should be configured to use the corresponding IQ mode to match the bandwidth.

## Performance Considerations

1. **Data Rate**: IQ streaming requires significantly more bandwidth than audio
   - 48 kHz: ~384 KB/s (48000 samples/s × 2 channels × 4 bytes)
   - 384 kHz: ~3 MB/s (384000 samples/s × 2 channels × 4 bytes)

2. **Network**: Use local connections or high-speed networks for high sample rates

3. **CPU**: IQ processing is more CPU-intensive than audio streaming

## Future Enhancements

Potential improvements:
- [ ] Automatic mode switching based on requested IQ sample rate
- [ ] IQ data compression (codec support)
- [ ] Multiple simultaneous IQ streams
- [ ] IQ recording to file
- [ ] Spectrum analysis from IQ data

## References

- [TCI Protocol Specification v2.0](~/Downloads/TCI Protocol.txt)
- [Expert Electronics TCI Documentation](https://eesdr.com/)
- Radio client IQ modes: [`radio_client.py`](radio_client.py:312-315)