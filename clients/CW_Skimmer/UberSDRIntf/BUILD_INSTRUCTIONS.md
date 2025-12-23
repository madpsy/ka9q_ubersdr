# UberSDRIntf Build Instructions

## Overview

This document provides instructions for building the UberSDRIntf DLL with pcm-zstd support for CW Skimmer on Windows.

## Prerequisites

### Required Software

1. **Visual Studio 2019 or later** with C++ development tools
2. **CMake 3.15 or later**
3. **vcpkg** (for dependency management)

### Installing vcpkg

If you don't have vcpkg installed:

```cmd
cd C:\
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
bootstrap-vcpkg.bat
```

Add vcpkg to your PATH or note the full path for later use.

## Installing Dependencies

### Install zstd Library

The UberSDRIntf DLL requires the zstd compression library. Install it using vcpkg:

```cmd
vcpkg install zstd:x86-windows-static
```

**Important:** Use `x86-windows-static` (32-bit) because CW Skimmer is a 32-bit application.

### Verify Installation

Check that zstd was installed correctly:

```cmd
vcpkg list | findstr zstd
```

You should see output like:
```
zstd:x86-windows-static    1.5.x    Zstandard compression library
```

## Building the DLL

### Option 1: Using CMake GUI

1. Open CMake GUI
2. Set source directory to: `clients/CW_Skimmer/UberSDRIntf`
3. Set build directory to: `clients/CW_Skimmer/UberSDRIntf/build`
4. Click "Configure"
5. Select "Visual Studio 16 2019" (or your version)
6. Set platform to "Win32"
7. Add CMake variable:
   - Name: `CMAKE_TOOLCHAIN_FILE`
   - Type: `FILEPATH`
   - Value: `C:/vcpkg/scripts/buildsystems/vcpkg.cmake` (adjust path as needed)
8. Click "Configure" again
9. Click "Generate"
10. Click "Open Project" to open in Visual Studio
11. Build the solution (F7)

### Option 2: Using Command Line

```cmd
cd clients\CW_Skimmer\UberSDRIntf
mkdir build
cd build

cmake .. -G "Visual Studio 16 2019" -A Win32 ^
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake

cmake --build . --config Release
```

**Note:** Adjust the Visual Studio version and vcpkg path as needed.

## Build Output

After a successful build, you'll find:

- `build/Release/UberSDRIntf.dll` - The main DLL
- `build/Release/UberSDRIntf.lib` - Import library
- `build/UberSDRIntf.dll` - Copy in build root (for testing)

## Installation

### For CW Skimmer

1. Locate your CW Skimmer installation directory (typically `C:\Program Files (x86)\Afreet\SkimSrv`)
2. **Backup the existing UberSDRIntf.dll** (if present)
3. Copy `build/Release/UberSDRIntf.dll` to the CW Skimmer directory
4. Copy `UberSDRIntf.ini` to the same directory (if not already present)

### Configuration

Edit `UberSDRIntf.ini` to configure your UberSDR server connection:

```ini
[UberSDR]
ServerHost=your-server-hostname
ServerPort=8073
UseSSL=0
```

## Testing

1. Start CW Skimmer
2. Select "UberSDR" as the receiver type
3. Check the log file `UberSDRIntf.log` in the CW Skimmer directory
4. Look for these indicators of success:
   - WebSocket URL contains `format=pcm-zstd`
   - No "Invalid zstd frame" errors
   - No "JSON parse error" messages
   - Audio data is being received and processed

### Expected Log Messages

Successful connection:
```
WebSocket URL: ws://server:8073/ws?frequency=14000000&mode=iq&format=pcm-zstd&user_session_id=...
WebSocket connected for receiver 0
```

Successful data reception (binary format):
```
Processing binary pcm-zstd message
Decompressed 8192 bytes
Processing 4096 IQ samples
```

## Troubleshooting

### CMake can't find zstd

**Error:** `Could not find a package configuration file provided by "zstd"`

**Solution:** Ensure you:
1. Installed zstd with vcpkg: `vcpkg install zstd:x86-windows-static`
2. Specified the correct toolchain file: `-DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake`

### Wrong Architecture

**Error:** DLL won't load in CW Skimmer

**Solution:** Ensure you built for 32-bit (Win32/x86):
- Use `x86-windows-static` in vcpkg
- Use `-A Win32` in CMake
- CW Skimmer is a 32-bit application

### Missing DLL Dependencies

**Error:** "The program can't start because xxx.dll is missing"

**Solution:** We use static linking to avoid this. Ensure:
- You installed `zstd:x86-windows-static` (not `zstd:x86-windows`)
- CMake is configured with `CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded"`

### WebSocket Connection Fails

**Error:** "WebSocket connection failed"

**Solution:**
1. Check `UberSDRIntf.ini` has correct server settings
2. Verify server is running and accessible
3. Check firewall settings
4. Review `UberSDRIntf.log` for detailed error messages

### No Audio Data

**Error:** Connected but no audio

**Solution:**
1. Check server logs for format negotiation
2. Verify server supports pcm-zstd format
3. Check frequency and mode settings
4. Review `UberSDRIntf.log` for data reception messages

## Performance Expectations

With pcm-zstd format:

- **Bandwidth:** 60-70% reduction compared to JSON (2.5-3.5x compression)
- **CPU Usage:** Slightly lower (no base64 encoding/decoding)
- **Latency:** No significant change (zstd decompression is very fast)
- **Quality:** Identical (lossless compression)

## Development Notes

### Code Structure

- [`UberSDRIntf.cpp`](UberSDRIntf.cpp) - DLL entry point and CW Skimmer interface
- [`UberSDR.cpp`](UberSDR.cpp) - WebSocket client and message handling
- [`UberSDR.h`](UberSDR.h) - Class definitions
- [`UberSDRShared.h`](UberSDRShared.h) - Shared structures with CW Skimmer
- [`CMakeLists.txt`](CMakeLists.txt) - Build configuration

### Key Changes for pcm-zstd

1. Added `#include <zstd.h>` to [`UberSDR.cpp`](UberSDR.cpp:31)
2. Modified [`BuildWebSocketURL()`](UberSDR.cpp:439) to add `&format=pcm-zstd`
3. Rewrote [`HandleWebSocketMessage()`](UberSDR.cpp:1087) to handle binary messages
4. Updated [`CMakeLists.txt`](CMakeLists.txt:30-31) to find and link zstd

### Binary Format Details

See [`PCM_ZSTD_UPGRADE.md`](PCM_ZSTD_UPGRADE.md) for complete format specification.

## References

- [zstd Documentation](https://facebook.github.io/zstd/)
- [vcpkg Documentation](https://vcpkg.io/)
- [CMake Documentation](https://cmake.org/documentation/)
- [IXWebSocket Library](https://github.com/machinezone/IXWebSocket)

## Support

For issues or questions:

1. Check [`UberSDRIntf.log`](UberSDRIntf.log) for detailed error messages
2. Review [`PCM_ZSTD_UPGRADE.md`](PCM_ZSTD_UPGRADE.md) for format details
3. Compare with working implementations:
   - Python client: `clients/python/radio_client.py`
   - SoapySDR client: `clients/soapy_driver/SoapyUberSDR.cpp`
