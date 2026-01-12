# Building JS8Skim Enhanced

## Quick Start

```bash
cd clients/js8skim
make js8skim-enhanced
```

This will create the `js8skim-enhanced` executable with all new features.

## Build Both Versions

```bash
cd clients/js8skim
make all
```

This builds:
- `js8skim` - Original version (simple, fast)
- `js8skim-enhanced` - Enhanced version with multi-submode, reconstruction, and deduplication

## Prerequisites

Same as original js8skim:
- C++ compiler with C++17 support
- FFTW3 library
- Opus library (for audio compression)
- libcurl (for WebSocket support)

### Install Dependencies

**Ubuntu/Debian:**
```bash
sudo apt-get install build-essential libfftw3-dev libopus-dev libcurl4-openssl-dev
```

**macOS (with Homebrew):**
```bash
brew install fftw opus curl
```

**macOS (with MacPorts):**
```bash
sudo port install fftw-3 opus curl
```

## Build Commands

### Build Enhanced Version Only
```bash
make js8skim-enhanced
```

### Build Original Version Only
```bash
make js8skim
```

### Build Both
```bash
make all
```

### Clean Build Artifacts
```bash
make clean
```

## Verify Build

After building, test the executable:

```bash
# Show help
./js8skim-enhanced --help

# Test with a connection (replace with your server)
./js8skim-enhanced localhost:8073,14074000
```

You should see output like:
```
JS8Skim Enhanced Decoder
Deduplication: enabled
Message reconstruction: enabled
Multi-submode: disabled
Enabled submodes: Normal
```

## Troubleshooting

### "command not found: c++"

Install a C++ compiler:
```bash
# Ubuntu/Debian
sudo apt-get install g++

# macOS
xcode-select --install
```

### "fftw3.h: No such file or directory"

Install FFTW3 development files:
```bash
# Ubuntu/Debian
sudo apt-get install libfftw3-dev

# macOS
brew install fftw
```

### "opus/opus.h: No such file or directory"

Install Opus development files:
```bash
# Ubuntu/Debian
sudo apt-get install libopus-dev

# macOS
brew install opus
```

### "curl/curl.h: No such file or directory"

Install libcurl development files:
```bash
# Ubuntu/Debian
sudo apt-get install libcurl4-openssl-dev

# macOS (usually pre-installed)
brew install curl
```

### Linker errors about pthread

The Makefile already includes `-pthread`, but if you still have issues:
```bash
# Manually add pthread flag
c++ -O -std=c++17 fate_enhanced.cc js8.cc common.cc libldpc.cc pack.cc unpack.cc snd.cc fft.cc util.cc ubersdr.cc js8_enhanced.cc -o js8skim-enhanced -lfftw3 -lopus -lcurl -pthread
```

## File Structure After Build

```
clients/js8skim/
├── js8skim              # Original executable
├── js8skim-enhanced     # Enhanced executable
├── *.o                  # Object files (if any)
└── [source files]
```

## Running

### Original Version
```bash
./js8skim HOST:PORT,FREQUENCY
```

### Enhanced Version
```bash
# With all features (default)
./js8skim-enhanced HOST:PORT,FREQUENCY

# With options
./js8skim-enhanced --multi-submode --submodes=normal,fast HOST:PORT,FREQUENCY
./js8skim-enhanced --no-dedup HOST:PORT,FREQUENCY
./js8skim-enhanced --no-reconstruct HOST:PORT,FREQUENCY
```

## Installation (Optional)

To install system-wide:

```bash
# Build first
make js8skim-enhanced

# Copy to system bin directory
sudo cp js8skim-enhanced /usr/local/bin/

# Now you can run from anywhere
js8skim-enhanced localhost:8073,14074000
```

## Development Build

For development with debug symbols:

```bash
# Edit Makefile, change first line to:
CXX = c++ -g -O0

# Then build
make clean
make js8skim-enhanced
```

This creates a debug build suitable for use with gdb or lldb.
