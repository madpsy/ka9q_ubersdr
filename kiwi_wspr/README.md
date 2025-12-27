# KiwiSDR WSPR Decoder

A Go implementation of a KiwiSDR WebSocket client with WSPR decoding and MQTT publishing capabilities. This application connects to multiple KiwiSDR receivers, records WSPR audio, decodes it using `wsprd`, and publishes spots to MQTT.

## Features

- **Multi-Instance Support**: Connect to multiple KiwiSDR receivers simultaneously
- **WSPR Decoding**: Automatic 2-minute cycle recording and decoding using `wsprd`
- **MQTT Publishing**: Publish decoded spots to MQTT broker
- **WebSocket Client**: Full KiwiSDR WebSocket protocol implementation
- **Audio Compression**: Optional IMA ADPCM compression support
- **WAV Recording**: Standard WAV file output
- **YAML Configuration**: Flexible configuration file support

## Architecture

The application consists of several components:

1. **KiwiClient** - WebSocket client for KiwiSDR communication
2. **WSPRCoordinator** - Manages WSPR recording/decoding cycles
3. **MQTTPublisher** - Publishes decoded spots to MQTT
4. **Configuration** - YAML-based configuration management

## Building

```bash
cd kiwi_wspr
go mod tidy
go build
```

## Configuration

Create a `config.yaml` file based on [`config.yaml.example`](config.yaml.example):

```yaml
receiver:
  callsign: "N0CALL"
  locator: "FN20"

mqtt:
  enabled: true
  broker: "tcp://localhost:1883"
  topic_prefix: "kiwi_wspr"

kiwi_instances:
  - name: "kiwi1"
    host: "44.31.241.9"
    port: 8073
    user: "kiwi_wspr"

wspr_bands:
  - name: "20m"
    frequency: 14.097
    instance: "kiwi1"
    enabled: true

decoder:
  wsprd_path: "/usr/local/bin/wsprd"
  work_dir: "./wspr_data"
```

## Usage

### WSPR Decoder Mode (with config file)

```bash
./kiwi_wspr --config config.yaml
```

This will:
1. Connect to configured KiwiSDR instances
2. Record 2-minute WSPR cycles for each enabled band
3. Decode using `wsprd`
4. Publish spots to MQTT topic: `{prefix}/digital_modes/WSPR/{band}`

### Standalone Recording Mode

```bash
# Record WSPR on 20m for 2 minutes
./kiwi_wspr -s kiwisdr.example.com -f 14.097 -m usb -d 120

# Record with compression
./kiwi_wspr -s kiwisdr.example.com -f 14.097 -m usb --compression -d 120
```

## MQTT Message Format

Decoded WSPR spots are published to: `{prefix}/digital_modes/WSPR/{band}`

Message format (JSON):
```json
{
  "mode": "WSPR",
  "band": "20m",
  "callsign": "W1ABC",
  "locator": "FN42",
  "snr": -15,
  "frequency": 14097100,
  "timestamp": "2025-12-27T10:00:00Z",
  "message": "W1ABC FN42 30",
  "dt": 0.5,
  "dbm": 30,
  "tx_frequency": 14097089
}
```

## Command Line Options

### Standalone Mode
- `-s, --server` - KiwiSDR server host
- `-p, --port` - KiwiSDR server port (default: 8073)
- `-f, --freq` - Frequency in kHz
- `-m, --mode` - Modulation mode (default: usb)
- `-d, --duration` - Recording duration in seconds
- `--compression` - Enable audio compression
- `-q, --quiet` - Quiet mode

### WSPR Decoder Mode
- `--config` - Path to configuration file (default: config.yaml)

## File Structure

```
kiwi_wspr/
├── main.go              # Main entry point
├── client.go            # KiwiSDR WebSocket client
├── config.go            # Basic configuration types
├── app_config.go        # YAML configuration loader
├── wspr_coordinator.go  # WSPR cycle management
├── mqtt_publisher.go    # MQTT publishing (TODO)
├── adpcm.go            # IMA ADPCM decoder
├── wav.go              # WAV file writer
├── config.yaml.example # Example configuration
└── README.md           # This file
```

## Requirements

- Go 1.21 or later
- `wsprd` binary from WSJT-X (for WSPR decoding)
- MQTT broker (if using MQTT publishing)

## Integration with UberSDR

This application is designed to work alongside the main UberSDR application:

1. Publishes to the same MQTT topic structure
2. Uses compatible JSON message format
3. Can be monitored by the wsprnet_mqtt aggregator

## Output Files

WAV files are named: `YYYYMMDDTHHMMSSz_FREQ_MODE.wav`

Example: `20251227T100000Z_14097000_usb.wav`

## Testing

Successfully tested with:
- KiwiSDR at 44.31.241.9:8073
- 10-second FT8 recording on 14.074 MHz
- Output: 229KB WAV file (16-bit PCM mono at 11999 Hz)

## License

Based on the KiwiSDR client Python implementation.

## See Also

- Original Python implementation: https://github.com/jks-prv/kiwiclient
- KiwiSDR project: http://kiwisdr.com/
- WSJT-X (wsprd): https://physics.princeton.edu/pulsar/k1jt/wsjtx.html
