# UberSDR IQ Recorder

A simple Go client for recording IQ48 data from UberSDR to WAV files.

## Features

- Records IQ48 data streams from UberSDR instances
- **Multi-instance recording**: Record from multiple instances simultaneously
- **GPS timestamp alignment**: Automatically synchronizes recordings to start at the same GPS timestamp
- **Sample-accurate synchronization**: Ensures all recordings have identical sample counts
- **Metadata files**: Automatically saves receiver location and configuration data alongside each recording
- **Automatic filename generation**: Files are named with hostname, frequency, and timestamp
- Saves data in standard WAV format (16-bit stereo PCM)
- Configurable recording duration
- Sets User-Agent as "UberSDR IQ Recorder"
- Supports password-protected instances
- Graceful shutdown on Ctrl+C

## Building

```bash
cd clients/iq-recorder
go build -o build/iq-recorder .
```

## Usage

Basic usage (single instance):
```bash
./iq-recorder -host localhost -port 8073 -frequency 14074000 -duration 60
```

### Command Line Options

- `-host` - UberSDR server host (can be specified multiple times for multiple instances)
- `-port` - UberSDR server port (can be specified multiple times, must match number of hosts)
- `-name` - Optional friendly name for instance (can be specified multiple times)
- `-password` - Server password if required (can be specified multiple times)
- `-frequency` - Frequency to record in Hz (default: 14074000)
- `-duration` - Recording duration in seconds, 0 for unlimited (default: 60)
- `-output-dir` - Output directory for WAV files (default: ".")
- `-ssl` - Use SSL/TLS connection for all instances (default: false)
- `-align` - Align recordings to common GPS timestamp when recording multiple instances (default: true)

### Examples

**Record from a single instance:**
```bash
./iq-recorder -host m9psy.tunnel.ubersdr.org -port 443 -ssl -frequency 14074000 -duration 60
# Creates: m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:10:19.937Z.wav
```

**Record from multiple instances simultaneously:**
```bash
./iq-recorder \
  -host m9psy.tunnel.ubersdr.org -port 443 \
  -host g4zfq.tunnel.ubersdr.org -port 443 \
  -host w1aw.tunnel.ubersdr.org -port 443 \
  -ssl -frequency 14074000 -duration 300
# Creates three files:
#   m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:10:19.937Z.wav
#   g4zfq.tunnel.ubersdr.org_14074000_2026-01-21T15:10:20.142Z.wav
#   w1aw.tunnel.ubersdr.org_14074000_2026-01-21T15:10:20.358Z.wav
```

**Record with friendly names:**
```bash
./iq-recorder \
  -host m9psy.tunnel.ubersdr.org -port 443 -name m9psy \
  -host g4zfq.tunnel.ubersdr.org -port 443 -name g4zfq \
  -ssl -frequency 14074000 -duration 300
# Creates:
#   m9psy_14074000_2026-01-21T15:10:19.937Z.wav
#   g4zfq_14074000_2026-01-21T15:10:20.142Z.wav
```

**Record to a specific directory:**
```bash
./iq-recorder -host sdr.example.com -port 8073 -frequency 7074000 -duration 300 -output-dir /recordings
```

**Record indefinitely (until Ctrl+C):**
```bash
./iq-recorder \
  -host m9psy.tunnel.ubersdr.org -port 443 \
  -host g4zfq.tunnel.ubersdr.org -port 443 \
  -ssl -frequency 14074000 -duration 0
```

**Mix of different ports (if needed):**
```bash
./iq-recorder \
  -host localhost -port 8073 \
  -host remote.example.com -port 443 \
  -frequency 14074000 -duration 60
```

## Output Format

The recorder creates standard WAV files with the following specifications:
- Format: PCM (uncompressed)
- Sample Rate: 48 kHz (IQ48 mode)
- Channels: 2 (I and Q)
- Bit Depth: 16-bit
- Byte Order: Little-endian

### Filename Format

Files are automatically named using the pattern:
```
{hostname_or_name}_{frequency}_{timestamp}.wav
{hostname_or_name}_{frequency}_{timestamp}.json
```

For example:
- WAV file: `m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:10:19.937Z.wav`
- Metadata file: `m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:10:19.937Z.json`

Or with friendly names:
- WAV file: `m9psy_14074000_2026-01-21T15:10:19.937Z.wav`
- Metadata file: `m9psy_14074000_2026-01-21T15:10:19.937Z.json`

The timestamp is derived from the first GPS-synchronized packet received, ensuring accurate time correlation across multiple recordings.

### Metadata Files

Each recording is accompanied by a JSON metadata file containing:
- Receiver location (latitude, longitude, altitude)
- Receiver callsign and description
- GPS status and TDOA capability
- Antenna information
- Frequency reference data
- Server version and configuration

Example metadata:
```json
{
  "receiver": {
    "callsign": "M9PSY",
    "location": "Dalgety Bay, Scotland, UK",
    "antenna": "Multi-band HF antenna",
    "gps": {
      "gps_enabled": true,
      "lat": 56.0403,
      "lon": -3.3554,
      "tdoa_enabled": true
    },
    "asl": 30
  },
  "frequency_reference": {
    "enabled": true,
    "expected_frequency": 10000000,
    "detected_frequency": 9999999.64,
    "frequency_offset": -0.36,
    "signal_strength": -101.5,
    "snr": 31.9
  }
}
```

These files can be opened in most audio software and SDR applications that support IQ data.

## Timestamp Alignment & Sample Synchronization

When recording from multiple instances simultaneously (default behavior), the recorder automatically synchronizes all recordings to start at the same GPS timestamp and ensures they contain the exact same number of samples.

**How it works:**
1. All instances connect and begin buffering incoming data
2. The recorder waits for all instances to receive their first GPS timestamp
3. An alignment timestamp is calculated (1 second after the latest first timestamp)
4. Each recorder processes its buffer, trimming samples before the alignment point
5. All recordings begin writing from the exact same GPS timestamp
6. A target sample count is calculated based on the duration (duration × 48000 samples/second)
7. All recorders stop when they reach the exact target sample count
8. The final sample counts are verified and logged

**Benefits:**
- **Sample-accurate synchronization** across all instances
- **Identical sample counts** in all recordings (critical for TDOA/beamforming)
- Enables precise time-domain correlation and phase-coherent processing
- Accounts for network latency differences between instances
- All WAV files share the same timestamp in their filename
- Recordings can be directly compared sample-by-sample

**Example output:**
```
Target sample count for synchronized recording: 240000 samples (5 seconds at 48000 Hz)
...
Instance 0 (m9psy.tunnel.ubersdr.org): 240000 samples
Instance 1 (g4zfq.tunnel.ubersdr.org): 240000 samples
Instance 2 (w1aw.tunnel.ubersdr.org): 240000 samples
✓ All recordings have identical sample count: 240000 samples
```

**To disable alignment** (for single instance or independent recordings):
```bash
./iq-recorder -align=false -host ... -host ...
```

## Notes

- The IQ48 mode provides 48 kHz sample rate with I/Q data
- Recording will automatically stop when the specified duration is reached
- Press Ctrl+C to stop all recordings early (all instances will stop gracefully)
- The WAV header is properly updated with file sizes when recording stops
- File sizes: approximately 5.5 MB per minute of recording (WAV) + ~2 KB (JSON metadata)
- When recording multiple instances, each instance runs in its own goroutine
- All instances record the same frequency simultaneously
- Each instance can have its own host, port, and password
- Log messages are prefixed with the instance identifier for easy tracking
- Alignment adds ~1-2 seconds of startup time while waiting for all instances to sync
- **All synchronized recordings will have exactly the same number of samples**
- Metadata is fetched from `/api/description` before recording starts
- If metadata fetch fails, recording continues without the metadata file

## License

See the main repository LICENSE file.
