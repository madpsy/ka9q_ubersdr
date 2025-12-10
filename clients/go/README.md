# Go Radio Client for ka9q_ubersdr

A command-line and REST API Go client for connecting to the ka9q_ubersdr WebSocket server to receive and output radio audio.

## Features

- **🌐 REST API & Web Interface**: Control the client via HTTP API with a modern web UI
- **🎛️ On-the-Fly Tuning**: Change frequency, mode, and bandwidth without reconnecting (like Python client)
- **Connection validation**: Checks server permission before connecting (respects IP bans, session limits, etc.)
- Connect to ka9q_ubersdr WebSocket server
- Support for multiple demodulation modes (AM, USB, LSB, FM, IQ, etc.)
- Configurable frequency and bandwidth
- **NR2 Spectral Subtraction Noise Reduction**: FFT-based noise reduction with adaptive learning
- Multiple output options:
  - **PortAudio**: Cross-platform real-time audio playback (Windows, macOS, Linux)
  - **stdout**: Raw PCM output to stdout (for piping to other tools)
  - **WAV file**: Record to PCM WAV file with optional time limit
- **WebSocket Updates**: Real-time status updates for web interface

## Requirements

- Go 1.21 or later
- For PortAudio output: PortAudio library (cross-platform audio I/O)

## Installation

### Quick Start

1. Navigate to the Go client directory:
```bash
cd clients/go
```

2. Build the client (this will automatically download dependencies):
```bash
go mod tidy
go build -o radio_client
```

3. Run the client:
```bash
./radio_client -h
```

### System Requirements

For PortAudio output, install the PortAudio development library:

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install portaudio19-dev

# Fedora/RHEL
sudo dnf install portaudio-devel

# Arch
sudo pacman -S portaudio
```

**macOS:**
```bash
# Using Homebrew
brew install portaudio
```

**Windows:**
PortAudio is typically bundled with the Go bindings. If you encounter issues:
- Download pre-built binaries from [PortAudio website](http://www.portaudio.com/)
- Or use MSYS2: `pacman -S mingw-w64-x86_64-portaudio`

## Usage

### API Mode (Web Interface)

Run the client with a REST API and web interface:

```bash
# Start API server on default port (8090)
./radio_client --api

# Start on custom port
./radio_client --api --api-port 9000
```

Then open your browser to `http://localhost:8090` to access the web interface.

**See [API_README.md](API_README.md) for complete REST API documentation.**

### CLI Mode (Command Line)

### Basic Examples

List available audio devices:
```bash
./radio_client --list-devices
```

Listen to 14.074 MHz USB via PortAudio (default device):
```bash
./radio_client -f 14074000 -m usb
```

Listen using a specific audio device:
```bash
./radio_client -f 14074000 -m usb --audio-device 2
```

Connect using full WebSocket URL:
```bash
./radio_client -u ws://radio.example.com:8073/ws -f 14074000 -m usb
```

Record 1000 kHz AM to WAV file for 60 seconds:
```bash
./radio_client -f 1000000 -m am -o wav -w recording.wav -t 60
```

Output raw PCM to stdout (pipe to another program):
```bash
./radio_client -f 7100000 -m lsb -o stdout | aplay -f S16_LE -r 12000 -c 1
```

Enable NR2 noise reduction:
```bash
./radio_client -f 14074000 -m usb -nr2
```

### Command-Line Options

```
Usage: radio_client [options]

Options:
  -u string
        Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)
  -H string
        Server hostname (default: localhost, ignored if --url is provided) (default "localhost")
  -p int
        Server port (default: 8080, ignored if --url is provided) (default 8080)
  -f int
        Frequency in Hz (e.g., 14074000 for 14.074 MHz)
  -m string
        Demodulation mode (am, sam, usb, lsb, fm, nfm, cwu, cwl)
  -b string
        Bandwidth in format low:high (e.g., -5000:5000)
  -o string
        Output mode (portaudio, stdout, wav) (default "portaudio")
  --audio-device int
        PortAudio device index (-1 for default, use --list-devices to see available devices) (default -1)
  --list-devices
        List available audio output devices and exit
  -w string
        WAV file path (required when output=wav)
  -t float
        Recording duration in seconds (for WAV output)
  -s
        Use WSS (WebSocket Secure, ignored if --url is provided)
  -nr2
        Enable NR2 spectral subtraction noise reduction
  -nr2-strength float
        NR2 noise reduction strength, 0-100% (default: 40) (default 40)
  -nr2-floor float
        NR2 spectral floor to prevent musical noise, 0-10% (default: 10) (default 10)
  -nr2-adapt-rate float
        NR2 noise profile adaptation rate, 0.1-5.0% (default: 1) (default 1)
```

### Connection Options

You can connect to the server in two ways:

1. **Using host/port/ssl flags** (default):
   ```bash
   ./radio_client -H localhost -p 8080 -f 14074000 -m usb
   ```

2. **Using full URL** (recommended for remote servers):
   ```bash
   # WebSocket (ws://)
   ./radio_client -u ws://radio.example.com:8080/ws -f 14074000 -m usb
   
   # Secure WebSocket (wss://)
   ./radio_client -u wss://radio.example.com/ws -f 14074000 -m usb
   ```

When using `-u`, the `-H`, `-p`, and `-s` flags are ignored. The URL parameter allows you to specify the complete WebSocket endpoint, including custom paths if needed.

### Bandwidth Parameter

The bandwidth parameter allows you to specify custom filter edges:

- Format: `low:high` (both in Hz relative to center frequency)
- Example for AM: `-b -5000:5000` (10 kHz bandwidth)
- Example for USB: `-b 50:2700` (standard SSB bandwidth)
- Example for LSB: `-b -2700:-50` (standard SSB bandwidth)

If not specified, the server will use mode-specific defaults.

### Output Modes

#### PortAudio (default)
Cross-platform real-time audio playback through PortAudio:
```bash
./radio_client -f 14074000 -m usb
```

PortAudio automatically selects the best audio backend for your system:
- **Linux**: ALSA, JACK, or PulseAudio
- **macOS**: CoreAudio
- **Windows**: WASAPI, DirectSound, or MME

##### Selecting Audio Output Device

List available devices:
```bash
./radio_client --list-devices
```

Example output:
```
Available PortAudio output devices:

  [0] Built-in Audio Analog Stereo
      Max channels: 2, Sample rate: 44100 Hz
      Latency: 5.8 ms

  [1] USB Audio Device (default)
      Max channels: 2, Sample rate: 48000 Hz
      Latency: 5.3 ms

  [2] HDMI Audio Output
      Max channels: 8, Sample rate: 48000 Hz
      Latency: 10.0 ms
```

Use a specific device:
```bash
./radio_client -f 14074000 -m usb --audio-device 1
```

If `--audio-device` is not specified or set to `-1`, the system default device is used.

#### stdout
Output raw PCM data to stdout for piping:
```bash
# Pipe to aplay
./radio_client -f 7100000 -m lsb -o stdout | aplay -f S16_LE -r 12000 -c 1

# Pipe to sox for processing
./radio_client -f 14074000 -m usb -o stdout | sox -t raw -r 12000 -e signed -b 16 -c 1 - output.wav

# Pipe to ffmpeg
./radio_client -f 1000000 -m am -o stdout | ffmpeg -f s16le -ar 12000 -ac 1 -i - output.mp3
```

#### WAV file
Record to a WAV file with optional time limit:
```bash
# Record for 60 seconds
./radio_client -f 14074000 -m usb -o wav -w recording.wav -t 60

# Record indefinitely (stop with Ctrl+C)
./radio_client -f 7100000 -m lsb -o wav -w recording.wav
```

## Audio Format

The client receives audio from the server as:
- **Encoding**: Big-endian signed 16-bit PCM
- **Sample Rate**: Typically 12000 Hz (varies by server configuration)
- **Channels**: Mono (1 channel)

The client automatically converts to little-endian for compatibility with most audio tools.

## Examples by Use Case

### Monitoring FT8 on 20m
```bash
./radio_client -f 14074000 -m usb
```

### Recording AM broadcast
```bash
./radio_client -f 1000000 -m am -b -5000:5000 -o wav -w am_broadcast.wav -t 300
```

### Listening to SSB with custom bandwidth
```bash
./radio_client -f 7100000 -m lsb -b -2700:-50
```

### Recording CW with narrow filter
```bash
./radio_client -f 7030000 -m cwu -b -200:200 -o wav -w cw_recording.wav -t 120
```

### Connecting to remote server
```bash
# Using host/port flags
./radio_client -H radio.example.com -p 8080 -f 14074000 -m usb

# Using full URL (recommended)
./radio_client -u ws://radio.example.com:8080/ws -f 14074000 -m usb
```

### Using SSL/TLS connection
```bash
# Using SSL flag
./radio_client -H radio.example.com -s -f 14074000 -m usb

# Using secure WebSocket URL (recommended)
./radio_client -u wss://radio.example.com/ws -f 14074000 -m usb
```

## NR2 Noise Reduction

The client includes an optional NR2 (Noise Reduction 2) spectral subtraction algorithm that can significantly reduce background noise while preserving signal quality.

### How It Works

1. **Learning Phase**: During the first ~0.5 seconds, NR2 learns the noise profile from the incoming audio
2. **FFT Processing**: Uses Fast Fourier Transform to analyze the frequency spectrum
3. **Spectral Subtraction**: Subtracts the learned noise profile from the signal spectrum
4. **Adaptive Tracking**: Continuously updates the noise profile during quiet periods to track changing noise conditions
5. **Overlap-Add**: Reconstructs the audio using windowed overlap-add technique for smooth output

### NR2 Command-Line Options

- `-nr2`: Enable NR2 noise reduction
- `-nr2-strength float`: Over-subtraction factor (0-100%, default: 40)
  - Higher values = more aggressive noise reduction
  - Too high may cause artifacts or "underwater" sound
  - Recommended range: 30-70%
  
- `-nr2-floor float`: Spectral floor to prevent musical noise (0-10%, default: 10)
  - Prevents complete silence in frequency bins
  - Higher values = less musical noise but more residual noise
  - Recommended range: 5-15%
  
- `-nr2-adapt-rate float`: Noise profile adaptation rate (0.1-5.0%, default: 1)
  - How quickly the noise profile updates during quiet periods
  - Higher values = faster adaptation to changing noise
  - Lower values = more stable noise profile
  - Recommended range: 0.5-2%

### NR2 Usage Examples

Default NR2 settings (good starting point):
```bash
./radio_client -f 14074000 -m usb -nr2
```

Aggressive noise reduction for very noisy signals:
```bash
./radio_client -f 7100000 -m lsb -nr2 -nr2-strength 70 -nr2-floor 15
```

Gentle noise reduction with fast adaptation:
```bash
./radio_client -f 14074000 -m usb -nr2 -nr2-strength 35 -nr2-adapt-rate 2.0
```

Record with noise reduction:
```bash
./radio_client -f 7100000 -m lsb -nr2 -o wav -w clean_audio.wav -t 60
```

### NR2 Usage Tips

- Start with default settings (`-nr2`) and adjust if needed
- For very noisy signals, increase `-nr2-strength` to 60-75%
- If you hear "musical noise" (chirping artifacts), increase `-nr2-floor` to 12-15%
- For rapidly changing noise conditions, increase `-nr2-adapt-rate` to 1.5-2%
- The algorithm works best with continuous noise (static, hiss) rather than impulsive noise (clicks, pops)
- NR2 adds minimal latency (~85ms) due to FFT processing
- Works with all output modes (PortAudio, stdout, WAV)

### When to Use NR2

**Good use cases:**
- Weak signals with high background noise
- Static or hiss from atmospheric conditions
- Continuous noise from local interference
- Recording weak DX stations

**Not recommended for:**
- Already clean signals (may degrade quality)
- Signals with very low SNR (< -10 dB)
- Impulsive noise (power line noise, clicks)
- Very strong signals (unnecessary processing)

## Building from Source

```bash
# Clone the repository
git clone https://github.com/ka9q/ubersdr.git
cd ubersdr/clients/go

# Build (automatically downloads dependencies)
go mod tidy
go build -o radio_client

# Install (optional)
go install
```

Note: `go mod tidy` ensures all dependencies are properly resolved and downloaded. The `go build` command will also download any missing dependencies automatically.

## Cross-Compilation

Build for different platforms:

```bash
# Linux AMD64
GOOS=linux GOARCH=amd64 go build -o radio_client-linux-amd64

# Linux ARM64 (Raspberry Pi, etc.)
GOOS=linux GOARCH=arm64 go build -o radio_client-linux-arm64

# macOS AMD64
GOOS=darwin GOARCH=amd64 go build -o radio_client-darwin-amd64

# macOS ARM64 (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o radio_client-darwin-arm64

# Windows AMD64
GOOS=windows GOARCH=amd64 go build -o radio_client-windows-amd64.exe
```

**Note:** Cross-compilation with PortAudio requires the target platform's PortAudio library. For true cross-platform builds, compile on the target platform or use a cross-compilation toolchain with the appropriate libraries.

## Troubleshooting

### PortAudio initialization errors
- **Linux**: Install `portaudio19-dev` package
- **macOS**: Install PortAudio via Homebrew: `brew install portaudio`
- **Windows**: Ensure PortAudio DLL is in your PATH or application directory

### "cannot find -lportaudio" during build
Install the PortAudio development library for your platform (see System Requirements above).

### Wrong audio device selected
Use `--list-devices` to see all available devices and their indices, then use `--audio-device N` to select the correct one.

### Audio device not showing up
- Ensure the device is properly connected and recognized by your system
- Try running `--list-devices` as administrator/root if devices are missing
- On Linux, check that your user is in the `audio` group

### Connection refused
- Verify the server is running
- Check the hostname and port
- Ensure firewall allows connections

### No audio output
- Verify your audio device is working with other applications
- Check system audio settings and volume levels
- Try stdout mode to verify data is being received: `-o stdout | aplay -f S16_LE -r 12000 -c 1`
- On Linux, check if PulseAudio/PipeWire is running

### Audio glitches or dropouts
- Check network connection quality
- Monitor server load
- Try increasing system audio buffer size

### NR2 causing audio artifacts
- Reduce `-nr2-strength` (try 30-40%)
- Increase `-nr2-floor` (try 12-15%)
- Ensure signal is strong enough (NR2 works best with SNR > 0 dB)

## API Mode

The Go client now includes a full REST API and web interface for controlling the radio. Key features:

- **Connect/Disconnect**: Manage SDR server connections via HTTP
- **Tune Command**: Change frequency/mode/bandwidth without reconnecting (matches Python client functionality)
- **Audio Device Selection**: List and select audio output devices
- **Real-time Updates**: WebSocket for instant status updates
- **Modern Web UI**: Responsive interface with frequency controls, band buttons, and status display

For complete API documentation, see [API_README.md](API_README.md).

### Quick API Examples

```bash
# Start API server
./radio_client --api

# Connect to SDR (using curl)
curl -X POST http://localhost:8090/api/connect \
  -H "Content-Type: application/json" \
  -d '{"host":"localhost","port":8080,"frequency":14074000,"mode":"usb"}'

# Change frequency without reconnecting
curl -X POST http://localhost:8090/api/tune \
  -H "Content-Type: application/json" \
  -d '{"frequency":7074000}'

# Get status
curl http://localhost:8090/api/status
```

## Dependencies

- [github.com/google/uuid](https://github.com/google/uuid) - UUID generation
- [github.com/gordonklaus/portaudio](https://github.com/gordonklaus/portaudio) - PortAudio Go bindings for cross-platform audio
- [github.com/gorilla/websocket](https://github.com/gorilla/websocket) - WebSocket client
- [github.com/gorilla/mux](https://github.com/gorilla/mux) - HTTP router for REST API
- [github.com/mjibson/go-dsp](https://github.com/mjibson/go-dsp) - FFT for NR2 processing

## License

This client is part of the ka9q_ubersdr project.