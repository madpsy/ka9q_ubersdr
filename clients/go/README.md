# UberSDR Go Radio Client

A native Go client for the UberSDR radio system with support for audio output, MIDI controllers, and radio control.

## Features

- WebSocket connection to UberSDR server
- PortAudio output for local audio playback
- MIDI controller support for radio control
- Serial CAT control (Kenwood, Yaesu, Icom protocols)
- Instance discovery via mDNS/Zeroconf
- REST API for control and configuration
- Persistent configuration storage

## Quick Start

### On Raspberry Pi (Native Installation)

1. **Build the binary:**
   ```bash
   cd clients/go
   ./build-native.sh
   ```

2. **Install as a system service:**
   ```bash
   sudo ./install.sh
   ```

3. **Check service status:**
   ```bash
   sudo systemctl status ubersdr-radio-client
   ```

4. **View logs:**
   ```bash
   sudo journalctl -u ubersdr-radio-client -f
   ```

### Using Docker

See the [docker/README.md](docker/README.md) for Docker installation instructions with audio and MIDI support.

## Installation Scripts

### build-native.sh
Builds the binary natively on the current platform (ARM64, ARM32, or x86_64).

**Requirements:**
- Go 1.21 or later
- PortAudio development libraries
- libsamplerate development libraries
- pkg-config

**Install dependencies on Raspberry Pi:**
```bash
sudo apt-get update
sudo apt-get install -y golang portaudio19-dev libsamplerate0-dev pkg-config
```

**Usage:**
```bash
./build-native.sh
```

Output: `build/radio_client-linux-arm64` (or appropriate architecture)

### install.sh
Installs the radio client as a systemd service.

**What it does:**
- Creates a dedicated `radio` user
- Installs binary to `/usr/local/bin/radio_client`
- Creates config directory at `/var/lib/ubersdr`
- Sets up systemd service with automatic restart
- Adds user to `audio` group for device access
- Enables service to start on boot

**Usage:**
```bash
sudo ./install.sh
```

**Service Management:**
```bash
# Start service
sudo systemctl start ubersdr-radio-client

# Stop service
sudo systemctl stop ubersdr-radio-client

# Restart service
sudo systemctl restart ubersdr-radio-client

# View status
sudo systemctl status ubersdr-radio-client

# View logs
sudo journalctl -u ubersdr-radio-client -f

# Disable auto-start
sudo systemctl disable ubersdr-radio-client
```

### uninstall.sh
Removes the installed service and binary.

**What it does:**
- Stops and disables the service
- Removes systemd service file
- Removes binary from `/usr/local/bin`
- Removes the `radio` user
- Preserves configuration directory

**Usage:**
```bash
sudo ./uninstall.sh
```

**Note:** Configuration in `/var/lib/ubersdr` is preserved. To remove it:
```bash
sudo rm -rf /var/lib/ubersdr
```

## Configuration

Configuration is stored in JSON format at:
- **System service:** `/var/lib/ubersdr/config.json`
- **Manual run:** `~/.config/ubersdr/config.json`

The configuration file is created automatically on first run and includes:
- Server connection settings
- Audio output preferences
- MIDI controller mappings
- Radio control settings
- Bookmark management

## API Access

The client provides a REST API on port 8090 (configurable):

```bash
# Get status
curl http://localhost:8090/api/status

# List audio devices
curl http://localhost:8090/api/audio/devices

# Get configuration
curl http://localhost:8090/api/config
```

## Audio and MIDI Support

### Audio Devices
The client uses PortAudio for audio output. Available devices can be listed via:
```bash
./build/radio_client --list-devices
```

### MIDI Controllers
MIDI controller support is built-in. The client will automatically detect connected MIDI devices.

**Supported MIDI messages:**
- Note On/Off for frequency control
- Control Change for volume, bandwidth, etc.
- Program Change for mode selection

### Device Permissions
The `radio` user is automatically added to the `audio` group during installation, providing access to:
- Audio devices (`/dev/snd/*`)
- MIDI devices (`/dev/snd/midi*`, `/dev/snd/seq`)

## Building for Different Architectures

### Native Build (Recommended)
Build directly on the target platform:
```bash
./build-native.sh
```

### Cross-Compilation
For cross-compilation from x86_64 to ARM, use Docker:
```bash
./build-arm.sh
```

**Note:** The `build-arm.sh` script requires an x86_64 host with Docker.

## Troubleshooting

### Audio Devices Not Found
1. Check if PortAudio can see devices:
   ```bash
   aplay -l
   ```

2. Verify user is in audio group:
   ```bash
   groups radio
   ```

3. Check service logs:
   ```bash
   sudo journalctl -u ubersdr-radio-client -n 50
   ```

### MIDI Controller Not Detected
1. List MIDI devices:
   ```bash
   aconnect -l
   ```

2. Check permissions:
   ```bash
   ls -l /dev/snd/midi*
   ```

3. Verify ALSA sequencer is loaded:
   ```bash
   lsmod | grep snd_seq
   ```

### Service Won't Start
1. Check service status:
   ```bash
   sudo systemctl status ubersdr-radio-client
   ```

2. View detailed logs:
   ```bash
   sudo journalctl -u ubersdr-radio-client -xe
   ```

3. Test binary manually:
   ```bash
   sudo -u radio /usr/local/bin/radio_client --api
   ```

### Library Version Errors
If you see `GLIBCXX` version errors, rebuild natively:
```bash
./build-native.sh
sudo ./install.sh
```

## Development

### Running Manually
```bash
# Build
go build -o radio_client .

# Run with API server
./radio_client --api

# List audio devices
./radio_client --list-devices

# Connect to specific server
./radio_client --server ws://example.com:8073/ws
```

### Environment Variables
- `API_PORT` - API server port (default: 8090)
- `CONFIG_FILE` - Path to config file
- `ALSA_CARD` - Default ALSA card number
- `PULSE_SERVER` - PulseAudio server (set to `none` to disable)

## License

See the main repository LICENSE file.

## Support

For issues and questions, please use the main repository's issue tracker.