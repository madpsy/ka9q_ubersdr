# Building UberSDR Go Client

This document explains how to build the UberSDR Go client for multiple platforms.

## Prerequisites

### Required Dependencies

The following libraries are **required** for building:

1. **PortAudio** - Cross-platform audio I/O library
2. **libsamplerate** - High-quality audio resampling library

#### Installing on Linux (Debian/Ubuntu)
```bash
sudo apt install portaudio19-dev libsamplerate0-dev
```

#### Installing on macOS
```bash
brew install portaudio libsamplerate
```

#### Installing on Windows (MSYS2)
```bash
pacman -S mingw-w64-x86_64-portaudio mingw-w64-x86_64-libsamplerate
```

## Building for Current Platform

The simplest way to build is for your current platform:

```bash
./build.sh
```

This will create a binary in the `build/` directory named appropriately for your platform.

## Cross-Compilation

Cross-compiling Go programs with CGo (required for PortAudio and libsamplerate) requires installing cross-compilation toolchains for each target platform.

### Linux Host → Other Platforms

#### Building for ARM32 (Raspberry Pi, etc.)

```bash
# Install ARM32 cross-compiler and libraries
sudo apt install gcc-arm-linux-gnueabihf
sudo apt install libportaudio2:armhf libsamplerate0:armhf

# Install development headers (may need to add armhf architecture first)
sudo dpkg --add-architecture armhf
sudo apt update
sudo apt install portaudio19-dev:armhf libsamplerate0-dev:armhf

# Set environment variables and build
export CC=arm-linux-gnueabihf-gcc
export CXX=arm-linux-gnueabihf-g++
export CGO_ENABLED=1
export GOOS=linux
export GOARCH=arm
export GOARM=7
export PKG_CONFIG_PATH=/usr/lib/arm-linux-gnueabihf/pkgconfig

go build -tags cgo -o build/radio_client-linux-arm32
```

#### Building for ARM64

```bash
# Install ARM64 cross-compiler and libraries
sudo apt install gcc-aarch64-linux-gnu
sudo dpkg --add-architecture arm64
sudo apt update
sudo apt install portaudio19-dev:arm64 libsamplerate0-dev:arm64

# Set environment variables and build
export CC=aarch64-linux-gnu-gcc
export CXX=aarch64-linux-gnu-g++
export CGO_ENABLED=1
export GOOS=linux
export GOARCH=arm64
export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig

go build -tags cgo -o build/radio_client-linux-arm64
```

#### Building for Windows from Linux

```bash
# Install MinGW-w64 cross-compiler
sudo apt install gcc-mingw-w64-x86-64

# You'll need to cross-compile PortAudio and libsamplerate for Windows
# or use pre-built Windows libraries. This is complex and may be easier
# to build directly on Windows.

# Alternative: Use Docker with a Windows build environment
```

#### Building for macOS from Linux

Cross-compiling for macOS from Linux is very complex and requires:
- OSXCross toolchain
- macOS SDK
- Cross-compiled versions of PortAudio and libsamplerate

It's recommended to build for macOS on an actual macOS machine.

### macOS Host → Other Platforms

#### Building for macOS (both architectures)

```bash
# Intel Mac
GOOS=darwin GOARCH=amd64 CGO_ENABLED=1 go build -tags cgo -o build/radio_client-macos-amd64

# Apple Silicon
GOOS=darwin GOARCH=arm64 CGO_ENABLED=1 go build -tags cgo -o build/radio_client-macos-arm64

# Universal binary (both architectures)
lipo -create build/radio_client-macos-amd64 build/radio_client-macos-arm64 \
     -output build/radio_client-macos-universal
```

Cross-compiling from macOS to Linux/Windows requires similar complexity as above.

### Windows Host → Other Platforms

Building on Windows is best done using MSYS2:

```bash
# In MSYS2 MinGW64 shell
pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-portaudio mingw-w64-x86_64-libsamplerate

# Build for Windows
go build -tags cgo -o build/radio_client-windows-amd64.exe
```

Cross-compiling from Windows to Linux/macOS is complex and not recommended.

## Recommended Build Strategy

For most users, the easiest approach is:

1. **Build on the target platform** - Build directly on each platform you need to support
2. **Use CI/CD** - Set up GitHub Actions or similar to build on multiple platforms automatically
3. **Use Docker** - Create Docker containers with the necessary toolchains for each platform

## Docker-Based Cross-Compilation

A more reliable approach is using Docker with pre-configured build environments:

```bash
# Example: Building for ARM64 using Docker
docker run --rm -v "$PWD":/workspace -w /workspace \
  arm64v8/golang:1.21 \
  bash -c "apt update && apt install -y portaudio19-dev libsamplerate0-dev && go build -tags cgo -o build/radio_client-linux-arm64"
```

## Troubleshooting

### CGo Errors

If you see errors like "undefined: C.something", ensure:
- CGO_ENABLED=1 is set
- The required libraries are installed
- pkg-config can find the libraries: `pkg-config --libs portaudio-2.0 samplerate`

### Cross-Compilation Failures

Cross-compilation with CGo is notoriously difficult. If you encounter issues:
1. Verify the cross-compiler is installed correctly
2. Check that cross-compiled libraries are available
3. Ensure PKG_CONFIG_PATH points to the correct location
4. Consider building on the target platform instead

### Library Version Mismatches

If you get runtime errors about missing libraries:
- The binary was built with different library versions than available at runtime
- Solution: Build on a system with similar library versions to your target, or statically link libraries

## Build Output

Successful builds will create binaries in the `build/` directory:
- `radio_client-linux-amd64` - Linux x86_64
- `radio_client-linux-arm32` - Linux ARM 32-bit (ARMv7)
- `radio_client-linux-arm64` - Linux ARM 64-bit
- `radio_client-windows-amd64.exe` - Windows x86_64
- `radio_client-macos-amd64` - macOS Intel
- `radio_client-macos-arm64` - macOS Apple Silicon

## Usage

After building, run the appropriate binary for your platform:

```bash
# Linux/macOS
./build/radio_client-linux-amd64 --api

# Windows
build\radio_client-windows-amd64.exe --api
```

See the main [README.md](README.md) for usage instructions.