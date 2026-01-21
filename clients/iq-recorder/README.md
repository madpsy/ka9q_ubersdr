# UberSDR IQ Recorder

A simple Go client for recording IQ48 data from UberSDR to WAV files.

## Features

- Records IQ48 data streams from UberSDR instances
- Saves data in standard WAV format (16-bit stereo PCM)
- Configurable recording duration
- Sets User-Agent as "UberSDR IQ Recorder"
- Supports password-protected instances
- Graceful shutdown on Ctrl+C

## Building

```bash
cd clients/iq-recorder
go build
```

## Usage

Basic usage:
```bash
./iq-recorder -host localhost -port 8073 -frequency 14074000 -duration 60 -output recording.wav
```

### Command Line Options

- `-host` - UberSDR server hostname (default: localhost)
- `-port` - UberSDR server port (default: 8073)
- `-frequency` - Frequency to record in Hz (default: 14074000)
- `-duration` - Recording duration in seconds, 0 for unlimited (default: 60)
- `-output` - Output WAV filename (default: iq_recording.wav)
- `-ssl` - Use SSL/TLS connection (default: false)
- `-password` - Server password if required (default: "")

### Examples

Record 5 minutes of IQ data at 7.074 MHz:
```bash
./iq-recorder -frequency 7074000 -duration 300 -output ft8_7mhz.wav
```

Record from a remote server with SSL:
```bash
./iq-recorder -host sdr.example.com -port 8073 -ssl -password mypass -frequency 14074000
```

Record indefinitely (until Ctrl+C):
```bash
./iq-recorder -frequency 14074000 -duration 0 -output continuous.wav
```

## Output Format

The recorder creates standard WAV files with the following specifications:
- Format: PCM (uncompressed)
- Sample Rate: 48 kHz (IQ48 mode)
- Channels: 2 (I and Q)
- Bit Depth: 16-bit
- Byte Order: Little-endian

These files can be opened in most audio software and SDR applications that support IQ data.

## Notes

- The IQ48 mode provides 48 kHz sample rate with I/Q data
- Recording will automatically stop when the specified duration is reached
- Press Ctrl+C to stop recording early
- The WAV header is properly updated with file sizes when recording stops
- File sizes: approximately 5.5 MB per minute of recording

## License

See the main repository LICENSE file.
