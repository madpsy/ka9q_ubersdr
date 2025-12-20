# Audio Resampling in Go Client

The Go client supports audio resampling to convert the 12 kHz audio stream to sample rates that your audio device supports (e.g., 44.1 kHz, 48 kHz).

## Resampling Options

### 1. Simple Resampler (Default - No Dependencies)

The simple resampler uses linear interpolation. It's fast and works without any external dependencies, but audio quality is lower.

**Build:**
```bash
cd clients/go
go build
```

**Usage:**
```bash
# CLI
./radio_client -f 14074000 -m usb --resample --resample-rate 48000 --resample-quality fast

# Or use the web UI and select "Fast" quality
./radio_client --api
```

### 2. libsamplerate Resampler (High Quality - Requires CGo)

For professional audio quality matching the Python client, you can build with libsamplerate support. This uses the industry-standard Secret Rabbit Code resampling library.

**Install libsamplerate:**

Ubuntu/Debian:
```bash
sudo apt-get install libsamplerate0-dev
```

Fedora/RHEL:
```bash
sudo dnf install libsamplerate-devel
```

macOS:
```bash
brew install libsamplerate
```

Windows (MSYS2):
```bash
pacman -S mingw-w64-x86_64-libsamplerate
```

**Build with libsamplerate:**
```bash
cd clients/go
CGO_ENABLED=1 go build -tags cgo
```

**Usage:**
```bash
# CLI - will automatically use libsamplerate if available
./radio_client -f 14074000 -m usb --resample --resample-rate 48000 --resample-quality high

# Or use the web UI and select "High" quality
./radio_client --api
```

## How It Works

- **Without CGo**: Uses simple linear interpolation (fast quality)
- **With CGo + libsamplerate**: Uses SRC_SINC_BEST_QUALITY converter (high quality)
- The client automatically detects which resampler is available at runtime
- Falls back gracefully if libsamplerate is not available

## Quality Comparison

| Quality | Method | CPU Usage | Audio Quality | Dependencies |
|---------|--------|-----------|---------------|--------------|
| Fast | Linear interpolation | Low | Good | None |
| High (no CGo) | Linear interpolation | Low | Good | None |
| High (with CGo) | Sinc interpolation (libsamplerate) | Medium | Excellent | libsamplerate |

## Recommended Sample Rates

- **48000 Hz** - Most widely supported, recommended default
- **44100 Hz** - CD quality, very common
- **22050 Hz** - Half of 44.1 kHz, good compatibility
- **16000 Hz** - Common for voice applications

## Notes

- IQ modes (iq, iq48, iq96, iq192, iq384) cannot be resampled as they require exact sample rates
- Resampling is disabled automatically for IQ modes
- The resampler maintains state across audio chunks for click-free operation