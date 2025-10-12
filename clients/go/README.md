# Go Radio Client for ka9q_ubersdr

A command-line Go client for connecting to the ka9q_ubersdr WebSocket server to receive and output radio audio.

## Features

- **Connection validation**: Checks server permission before connecting (respects IP bans, session limits, etc.)
- Connect to ka9q_ubersdr WebSocket server
- Support for multiple demodulation modes (AM, USB, LSB, FM, etc.)
- Configurable frequency and bandwidth
- **NR2 Spectral Subtraction Noise Reduction**: FFT-based noise reduction with adaptive learning
- Multiple output options:
  - **PipeWire**: Real-time audio playback via PipeWire
  - **stdout**: Raw PCM output to stdout (for piping to other tools)
  - **WAV file**: Record to PCM WAV file with optional time limit

## Requirements

- Go 1.21 or later
- For PipeWire output: `pipewire-utils` package (provides `pw-play`)

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

For PipeWire output, install pipewire-utils:
```bash
# Debian/Ubuntu
sudo apt install pipewire-utils

# Fedora
sudo dnf install pipewire-utils

# Arch
sudo pacman -S pipewire
```

## Usage

### Basic Examples

Listen to 14.074 MHz USB via PipeWire:
```bash
./radio_client -f 14074000 -m usb
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
        Output mode (pipewire, stdout, wav) (default "pipewire")
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

#### PipeWire (default)
Real-time audio playback through PipeWire:
```bash
./radio_client -f 14074000 -m usb
```

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
- Works with all output modes (PipeWire, stdout, WAV)

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

## Troubleshooting

### "pw-play not found"
Install pipewire-utils package for your distribution.

### Connection refused
- Verify the server is running
- Check the hostname and port
- Ensure firewall allows connections

### No audio output
- Check PipeWire is running: `systemctl --user status pipewire`
- Verify audio device: `pw-cli list-objects | grep node.name`
- Try stdout mode to verify data is being received

### Audio glitches or dropouts
- Check network connection quality
- Monitor server load
- Try increasing system audio buffer size

### NR2 causing audio artifacts
- Reduce `-nr2-strength` (try 30-40%)
- Increase `-nr2-floor` (try 12-15%)
- Ensure signal is strong enough (NR2 works best with SNR > 0 dB)

## Dependencies

- [github.com/google/uuid](https://github.com/google/uuid) - UUID generation
- [github.com/gorilla/websocket](https://github.com/gorilla/websocket) - WebSocket client
- [github.com/mjibson/go-dsp](https://github.com/mjibson/go-dsp) - FFT for NR2 processing

## License

This client is part of the ka9q_ubersdr project.