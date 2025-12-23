# Python Radio Client for ka9q_ubersdr

A command-line and GUI Python client for connecting to the ka9q_ubersdr WebSocket server to receive and output radio audio.

## Features

- **Graphical User Interface**: Optional Tkinter-based GUI for easy control (Linux only)
- **Rigctl Integration**: Control external radios via Hamlib's rigctld network protocol
- **Connection validation**: Checks server permission before connecting (respects IP bans, session limits, etc.)
- Connect to ka9q_ubersdr WebSocket server
- Support for multiple demodulation modes (AM, USB, LSB, FM, etc.)
- Configurable frequency and bandwidth with live updates
- **NR2 Spectral Subtraction Noise Reduction**: FFT-based noise reduction with adaptive learning
- Multiple output options:
  - **PyAudio**: Cross-platform real-time audio playback (Windows, macOS, Linux)
  - **PipeWire**: Real-time audio playback via PipeWire (Linux only)
  - **stdout**: Raw PCM output to stdout (for piping to other tools)
  - **WAV file**: Record to PCM WAV file with optional time limit
  - **FIFO (named pipe)**: Additional output to named pipe for multi-consumer streaming

## Requirements

- Python 3.7+
- `websockets` library
- `aiohttp` library
- `numpy` library
- `scipy` library (optional, required for NR2 noise reduction and audio filtering)
- `tkinter` library (usually included with Python, required for GUI mode)
- `pyaudio` library (optional, for cross-platform audio output)
- `sounddevice` library (optional, recommended for cross-platform audio output with better quality)
- `samplerate` library (optional, required for high-quality audio resampling with sounddevice)
- For PipeWire output: `pipewire-utils` package (provides `pw-play`, Linux only)

## Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. For cross-platform audio output (recommended for Windows/macOS):
```bash
# Option 1: sounddevice (recommended - better quality, click-free resampling)
pip install sounddevice samplerate

# Option 2: pyaudio (alternative)
pip install pyaudio
```

3. For PipeWire output (Linux only), install pipewire-utils:
```bash
# Debian/Ubuntu
sudo apt install pipewire-utils

# Fedora
sudo dnf install pipewire-utils

# Arch
sudo pacman -S pipewire
```

4. Make the script executable:
```bash
chmod +x radio_client.py
```

## Building Standalone Executable

You can build a standalone executable using PyInstaller, which bundles Python and all dependencies into a single file.

### Requirements

- PyInstaller: `pip install pyinstaller`
- An icon file: `ubersdr.ico` (should be in the same directory)

### Build Steps

1. Create and activate a virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Install PyInstaller:
```bash
pip install pyinstaller
```

4. Build the executable:

**For Windows:**
```bash
pyinstaller --onefile radio_client.py --icon=ubersdr.ico
```

**For Linux/macOS:**
```bash
pyinstaller --onefile radio_client.py --icon=ubersdr.ico --hidden-import=PIL._tkinter_finder
```

5. The built executable will be in the `dist/` directory:
```bash
# Linux/macOS
./dist/radio_client

# Windows
dist\radio_client.exe
```

### Build Notes

- The `--onefile` flag creates a single executable file
- The `--icon` flag sets the application icon (optional, omit if you don't have an icon file)
- The `--hidden-import=PIL._tkinter_finder` flag is required on Linux/macOS to properly bundle PIL's Tkinter integration
- The build process may take a few minutes
- The resulting executable is platform-specific (build on the target OS)
- The executable size will be larger (~50-100MB) as it includes Python and all dependencies

## Usage

### GUI Mode (Default)

Launch the graphical interface (default behavior):
```bash
./radio_client.py
```

Or with initial settings:
```bash
./radio_client.py -f 14074000 -m usb
```

The GUI provides:
- **Server connection field**: Enter server URL or host:port
- **Connect/Disconnect button**: Toggle connection state
- **Frequency control**: Enter frequency or use quick band buttons (160m-10m)
- **Mode selector**: Choose demodulation mode (AM, USB, LSB, etc.)
- **Bandwidth controls**: Adjust filter edges with presets (Narrow, Medium, Wide)
- **NR2 Noise Reduction**: Enable/disable noise reduction with adjustable strength and floor parameters
- **Rigctl Control**: Connect to rigctld to sync SDR frequency/mode with external radio
- **Live updates**: Change frequency, mode, bandwidth, or NR2 settings while connected
- **Status log**: View connection status and events

### Command-Line Mode

To use CLI mode instead of GUI, add the `--no-gui` flag:

Listen to 14.074 MHz USB via PyAudio (cross-platform):
```bash
./radio_client.py --no-gui -f 14074000 -m usb -o pyaudio
```

Listen to 14.074 MHz USB via PipeWire (Linux only):
```bash
./radio_client.py --no-gui -f 14074000 -m usb
```

Connect using full WebSocket URL:
```bash
./radio_client.py --no-gui -u ws://radio.example.com:8073/ws -f 14074000 -m usb
```

Record 1000 kHz AM to WAV file for 60 seconds:
```bash
./radio_client.py --no-gui -f 1000000 -m am -o wav -w recording.wav -t 60
```

Output raw PCM to stdout (pipe to another program):
```bash
./radio_client.py --no-gui -f 7100000 -m lsb -o stdout | aplay -f S16_LE -r 12000 -c 1
```

Enable NR2 noise reduction:
```bash
./radio_client.py --no-gui -f 14074000 -m usb --nr2
```

### Command-Line Options

```
usage: radio_client.py [-h] [--no-gui] [-u URL] [-H HOST] [-p PORT] [-f FREQUENCY]
                       [-m MODE] [-b BANDWIDTH] [-o {pipewire,stdout,wav}]
                       [-w FILE] [-t SECONDS] [-s] [--nr2]
                       [--nr2-strength PERCENT] [--nr2-floor PERCENT]
                       [--nr2-adapt-rate PERCENT] [--auto-reconnect]
                       [--fifo-path PATH] [--rigctl-host HOST]
                       [--rigctl-port PORT] [--rigctl-sync]

CLI Radio Client for ka9q_ubersdr

optional arguments:
  -h, --help            show this help message and exit
  --no-gui              Disable GUI and use command-line interface (requires --frequency and --mode)
  -u URL, --url URL     Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)
  -H HOST, --host HOST  Server hostname (default: localhost, ignored if --url is provided)
  -p PORT, --port PORT  Server port (default: 8080, ignored if --url is provided)
  -f FREQUENCY, --frequency FREQUENCY
                        Frequency in Hz (e.g., 14074000 for 14.074 MHz)
                        Required for CLI mode, optional for GUI mode
  -m MODE, --mode MODE  Demodulation mode
                        Choices: am, sam, usb, lsb, fm, nfm, cwu, cwl, iq
                        Required for CLI mode, optional for GUI mode
  -b BANDWIDTH, --bandwidth BANDWIDTH
                        Bandwidth in format low:high (e.g., -5000:5000)
  -o {pipewire,pyaudio,stdout,wav}, --output {pipewire,pyaudio,stdout,wav}
                        Output mode (default: pipewire, pyaudio works on all platforms)
                        Note: GUI mode always uses pipewire
  -w FILE, --wav-file FILE
                        WAV file path (required when output=wav)
  -t SECONDS, --time SECONDS
                        Recording duration in seconds (for WAV output)
  -s, --ssl             Use WSS (WebSocket Secure, ignored if --url is provided)
  --nr2                 Enable NR2 spectral subtraction noise reduction
  --nr2-strength PERCENT
                        NR2 noise reduction strength, 0-100% (default: 40)
  --nr2-floor PERCENT   NR2 spectral floor to prevent musical noise, 0-10% (default: 10)
  --nr2-adapt-rate PERCENT
                        NR2 noise profile adaptation rate, 0.1-5.0% (default: 1)
  --auto-reconnect      Automatically reconnect on connection loss with exponential backoff
  --fifo-path PATH      Also write audio to named pipe (FIFO) at this path (non-blocking,
                        works with any output mode)
  --rigctl-host HOST    Rigctl host (e.g., localhost) for controlling external radio
  --rigctl-port PORT    Rigctl port (default: 4532)
  --rigctl-sync         Enable rigctl frequency/mode sync on connect
```

### Connection Options

You can connect to the server in two ways:

1. **Using host/port/ssl flags** (default):
   ```bash
   ./radio_client.py -H localhost -p 8080 -f 14074000 -m usb
   ```

2. **Using full URL** (recommended for remote servers):
   ```bash
   # WebSocket (ws://)
   ./radio_client.py -u ws://radio.example.com:8080/ws -f 14074000 -m usb
   
   # Secure WebSocket (wss://)
   ./radio_client.py -u wss://radio.example.com/ws -f 14074000 -m usb
   ```

When using `-u/--url`, the `-H`, `-p`, and `-s` flags are ignored. The URL parameter allows you to specify the complete WebSocket endpoint, including custom paths if needed.

### Bandwidth Parameter

The bandwidth parameter allows you to specify custom filter edges:

- Format: `low:high` (both in Hz relative to center frequency)
- Example for AM: `-b -5000:5000` (10 kHz bandwidth)
- Example for USB: `-b 50:2700` (standard SSB bandwidth)
- Example for LSB: `-b -2700:-50` (standard SSB bandwidth)

If not specified, the server will use mode-specific defaults.

### Output Modes

#### sounddevice (cross-platform, recommended)
Real-time audio playback through sounddevice with high-quality resampling (works on Windows, macOS, and Linux):
```bash
./radio_client.py -f 14074000 -m usb -o sounddevice
```

sounddevice is the recommended output mode for all platforms, as it provides:
- High-quality, click-free audio resampling using libsamplerate
- Better hardware compatibility across different sample rates
- Lower latency than PyAudio on most systems

#### PyAudio (cross-platform, alternative)
Real-time audio playback through PyAudio (works on Windows, macOS, and Linux):
```bash
./radio_client.py -f 14074000 -m usb -o pyaudio
```

PyAudio is an alternative output mode that works on all platforms without requiring additional resampling libraries.

#### PipeWire (Linux only, default)
Real-time audio playback through PipeWire:
```bash
./radio_client.py -f 14074000 -m usb
```

#### stdout
Output raw PCM data to stdout for piping:
```bash
# Pipe to aplay
./radio_client.py -f 7100000 -m lsb -o stdout | aplay -f S16_LE -r 12000 -c 1

# Pipe to sox for processing
./radio_client.py -f 14074000 -m usb -o stdout | sox -t raw -r 12000 -e signed -b 16 -c 1 - output.wav

# Pipe to ffmpeg
./radio_client.py -f 1000000 -m am -o stdout | ffmpeg -f s16le -ar 12000 -ac 1 -i - output.mp3
```

#### WAV file
Record to a WAV file with optional time limit:
```bash
# Record for 60 seconds
./radio_client.py -f 14074000 -m usb -o wav -w recording.wav -t 60

# Record indefinitely (stop with Ctrl+C)
./radio_client.py -f 7100000 -m lsb -o wav -w recording.wav
```

#### FIFO (Named Pipe)
Stream audio to a named pipe (FIFO) in addition to the primary output mode. This allows multiple programs to read the same audio stream simultaneously:

```bash
# Stream to PipeWire AND a FIFO
./radio_client.py -f 14074000 -m usb --fifo-path /tmp/radio.fifo

# In another terminal, read from the FIFO (mono modes: USB, LSB, AM, FM, CW)
cat /tmp/radio.fifo | aplay -f S16_LE -r 12000 -c 1 -v

# For IQ modes only (stereo)
cat /tmp/radio.fifo | aplay -f S16_LE -r 12000 -c 2 -v

# Or pipe to sox for processing (mono)
cat /tmp/radio.fifo | sox -t raw -r 12000 -e signed -b 16 -c 1 - output.wav

# Or use with ffmpeg (mono)
ffmpeg -f s16le -ar 12000 -ac 1 -i /tmp/radio.fifo output.mp3

# Combine with stdout output
./radio_client.py -f 14074000 -m usb -o stdout --fifo-path /tmp/radio.fifo > /dev/null
```

**FIFO Features:**
- **Raw audio**: Outputs unprocessed audio directly from source (no volume, NR2, or channel processing)
- **Non-blocking**: Won't slow down primary audio output if no reader is attached
- **Multi-consumer**: Multiple programs can read from the same FIFO
- **Works with any output mode**: Can be used alongside PipeWire, stdout, or WAV output
- **Automatic cleanup**: FIFO is automatically created and removed on exit
- **Mono output**: Outputs mono (1 channel) for most modes, stereo (2 channels) for IQ modes

**Use Cases:**
- Monitor audio while recording to WAV
- Feed audio to multiple processing tools simultaneously
- Create audio analysis pipelines without affecting playback
- Tap audio stream for real-time visualization or logging

## Audio Format

The client receives audio from the server as:
- **Encoding**: Big-endian signed 16-bit PCM
- **Sample Rate**: Typically 12000 Hz (varies by server configuration)
- **Channels**: Mono (1 channel)

The client automatically converts to little-endian for compatibility with most audio tools.

## Examples by Use Case

### Monitoring FT8 on 20m
```bash
./radio_client.py -f 14074000 -m usb
```

### Recording AM broadcast
```bash
./radio_client.py -f 1000000 -m am -b -5000:5000 -o wav -w am_broadcast.wav -t 300
```

### Listening to SSB with custom bandwidth
```bash
./radio_client.py -f 7100000 -m lsb -b -2700:-50
```

### Recording CW with narrow filter
```bash
./radio_client.py -f 7030000 -m cwu -b -200:200 -o wav -w cw_recording.wav -t 120
```

### Connecting to remote server
```bash
# Using host/port flags
./radio_client.py -H radio.example.com -p 8080 -f 14074000 -m usb

# Using full URL (recommended)
./radio_client.py -u ws://radio.example.com:8080/ws -f 14074000 -m usb
```

### Using SSL/TLS connection
```bash
# Using SSL flag
./radio_client.py -H radio.example.com -s -f 14074000 -m usb

# Using secure WebSocket URL (recommended)
./radio_client.py -u wss://radio.example.com/ws -f 14074000 -m usb
```

## Rigctl Integration

The Python client can control external radios via Hamlib's `rigctld` network protocol. This allows you to synchronize your physical radio with the SDR frequency and mode.

### Requirements

- Hamlib's `rigctld` daemon running and accessible over the network
- Your radio connected and configured with rigctld

### Starting rigctld

Example for a Kenwood TS-590SG on /dev/ttyUSB0:
```bash
rigctld -m 2014 -r /dev/ttyUSB0 -s 57600
```

Example for a Yaesu FT-991A:
```bash
rigctld -m 1035 -r /dev/ttyUSB0 -s 38400
```

See `rigctl -l` for a list of supported radio models.

### Using Rigctl in GUI Mode

1. Launch the GUI:
   ```bash
   ./radio_client.py
   ```

2. In the Connection section, enter:
   - **Rigctl host**: `localhost` (or remote host)
   - **Rigctl port**: `4532` (default rigctld port)

3. Click **"Connect Rig"** to establish connection

4. Enable **"Sync"** checkbox to synchronize frequency/mode changes

When sync is enabled, changing the SDR frequency or mode will automatically update your physical radio.

### Using Rigctl from Command Line

Auto-connect to rigctld and enable sync:
```bash
./radio_client.py --rigctl-host localhost --rigctl-port 4532 --rigctl-sync
```

Connect to remote rigctld:
```bash
./radio_client.py --rigctl-host 192.168.1.100 --rigctl-port 4532
```

### Rigctl Features

- **Frequency Sync**: SDR frequency changes are sent to the radio
- **Mode Sync**: SDR mode changes are mapped to radio modes:
  - USB → USB
  - LSB → LSB
  - AM/SAM → AM
  - CWU/CWL → CW
  - FM/NFM → FM
- **Non-blocking**: Rigctl errors won't interrupt SDR operation
- **Auto-reconnect**: Connection can be toggled without restarting the GUI

### Rigctl Use Cases

- **Antenna switching**: Use radio's antenna tuner while monitoring on SDR
- **Transmit coordination**: Keep radio on same frequency as SDR for quick TX
- **Dual monitoring**: Listen on SDR while radio scans or monitors another frequency
- **Remote operation**: Control remote radio via rigctld over network

### Troubleshooting Rigctl

**Connection refused:**
- Verify rigctld is running: `ps aux | grep rigctld`
- Check rigctld is listening: `netstat -an | grep 4532`
- Test with rigctl: `rigctl -m 2 -r localhost:4532 f`

**Sync not working:**
- Ensure "Sync" checkbox is enabled in GUI
- Check rigctld logs for errors
- Verify radio is powered on and connected
- Try manual rigctl command: `echo "F 14074000" | nc localhost 4532`

**Mode not changing:**
- Some radios have limited mode support via CAT
- Check your radio's CAT command documentation
- Try setting mode manually on radio first

## NR2 Noise Reduction

The client includes an optional NR2 (Noise Reduction 2) spectral subtraction algorithm that can significantly reduce background noise while preserving signal quality.

### How It Works

1. **Learning Phase**: During the first ~0.5 seconds, NR2 learns the noise profile from the incoming audio
2. **FFT Processing**: Uses Fast Fourier Transform to analyze the frequency spectrum
3. **Spectral Subtraction**: Subtracts the learned noise profile from the signal spectrum
4. **Adaptive Tracking**: Continuously updates the noise profile during quiet periods to track changing noise conditions
5. **Overlap-Add**: Reconstructs the audio using windowed overlap-add technique for smooth output

### NR2 Command-Line Options

- `--nr2`: Enable NR2 noise reduction
- `--nr2-strength PERCENT`: Over-subtraction factor (0-100%, default: 50)
  - Higher values = more aggressive noise reduction
  - Too high may cause artifacts or "underwater" sound
  - Recommended range: 30-70%
  
- `--nr2-floor PERCENT`: Spectral floor to prevent musical noise (0-10%, default: 1)
  - Prevents complete silence in frequency bins
  - Higher values = less musical noise but more residual noise
  - Recommended range: 0.5-2%
  
- `--nr2-adapt-rate PERCENT`: Noise profile adaptation rate (0.1-5.0%, default: 1)
  - How quickly the noise profile updates during quiet periods
  - Higher values = faster adaptation to changing noise
  - Lower values = more stable noise profile
  - Recommended range: 0.5-2%

### NR2 Usage Examples

Default NR2 settings (good starting point):
```bash
./radio_client.py -f 14074000 -m usb --nr2
```

Aggressive noise reduction for very noisy signals:
```bash
./radio_client.py -f 7100000 -m lsb --nr2 --nr2-strength 70 --nr2-floor 1.5
```

Gentle noise reduction with fast adaptation:
```bash
./radio_client.py -f 14074000 -m usb --nr2 --nr2-strength 35 --nr2-adapt-rate 2.0
```

Record with noise reduction:
```bash
./radio_client.py -f 7100000 -m lsb --nr2 -o wav -w clean_audio.wav -t 60
```

### NR2 Usage Tips

- Start with default settings (`--nr2`) and adjust if needed
- For very noisy signals, increase `--nr2-strength` to 60-75%
- If you hear "musical noise" (chirping artifacts), increase `--nr2-floor` to 1.5-2%
- For rapidly changing noise conditions, increase `--nr2-adapt-rate` to 1.5-2%
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

## Troubleshooting

### "sounddevice not available" or "samplerate not available"
Install sounddevice and samplerate for best audio quality:
```bash
pip install sounddevice samplerate
```

On some systems, you may need to install libsamplerate development files first:
```bash
# Debian/Ubuntu
sudo apt install libsamplerate0-dev
pip install samplerate

# macOS (with Homebrew)
brew install libsamplerate
pip install samplerate

# Windows
pip install samplerate
```

### "PyAudio not available"
Install PyAudio:
```bash
pip install pyaudio
```

On some systems, you may need to install PortAudio development files first:
```bash
# Debian/Ubuntu
sudo apt install portaudio19-dev python3-pyaudio

# macOS (with Homebrew)
brew install portaudio
pip install pyaudio

# Windows
pip install pyaudio
```

### "pw-play not found"
Install pipewire-utils package for your distribution (Linux only).

### Connection refused
- Verify the server is running
- Check the hostname and port
- Ensure firewall allows connections

### No audio output
- Check PipeWire is running: `systemctl --user status pipewire`
- Verify audio device: `pw-cli list-objects | grep node.name`
- Try stdout mode to verify data is being received

### Audio glitches, clicks, or crackles
- Ensure you have `samplerate` library installed: `pip install samplerate`
- The `samplerate` library provides stateful, click-free audio resampling
- If using PyAudio mode, try switching to sounddevice mode: `-o sounddevice`
- Check network connection quality
- Monitor server load
- Try increasing system audio buffer size

### NR2 not available
If you see "scipy not available, NR2 noise reduction disabled":
```bash
pip install scipy
```

### NR2 causing audio artifacts
- Reduce `--nr2-strength` (try 30-40%)
- Increase `--nr2-floor` (try 1.5-2%)
- Ensure signal is strong enough (NR2 works best with SNR > 0 dB)

## License

This client is part of the ka9q_ubersdr project.