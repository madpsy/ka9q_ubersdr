# Building UberSDRMonitor

## Prerequisites

- Visual Studio 2019 or later (with C++ desktop development)
- CMake (optional, but recommended)

## ✅ VERIFIED WORKING BUILD COMMAND (32-bit)

### Complete Build from Scratch (PowerShell)

```powershell
# Navigate to project directory
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor

# Create 32-bit build directory
mkdir build32
cd build32

# Configure and build (single command)
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
cmake -A Win32 ..
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32
```

**Output:** `build32\Release\UberSDRMonitor.exe` (32-bit)

**Build Time:** ~1-2 seconds

### Quick Rebuild (After Changes)

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Build
```

**Build Time:** <1 second (only changed files)

### Clean and Rebuild

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean,Build
```

### One-Line Build Command

```powershell
"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" && cd UberSDRMonitor && if not exist build32 mkdir build32 && cd build32 && cmake -A Win32 .. && msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32
```

### From CMD (Alternative)

```cmd
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32
"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" && msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32
```

### Using Visual Studio GUI

1. Open `UberSDRMonitor.sln` in Visual Studio (located in build32 directory)
2. Select "Release" configuration and "Win32" platform from toolbar
3. Build → Build Solution (Ctrl+Shift+B)
4. Find executable in `build32\Release\UberSDRMonitor.exe`

## Important Notes

### Why 32-bit (Win32)?
**CW Skimmer is a 32-bit application**, so the monitor is built as 32-bit for consistency. The `-A Win32` flag in cmake is **critical**.

### Dependencies
- **comctl32.lib** - Common controls (progress bars, etc.)
- **ws2_32.lib** - Winsock2 for TCP telnet client

### Build Directory
Use `build32` (not `build`) to clearly indicate 32-bit build.

## Features

The UberSDR Monitor includes:
- Real-time monitoring of UberSDR DLL status via shared memory
- Receiver status display (frequency, throughput, buffer metrics)
- IQ level meters for all 8 receivers
- WAV file recording capability
- **TCP telnet client** - Connects to localhost:7300, auto-login with "N0CALL"

## Verification

After building, verify the executable:

```powershell
# Check executable exists
Test-Path .\Release\UberSDRMonitor.exe

# View file details
dir .\Release\UberSDRMonitor.exe

# Run the monitor
.\Release\UberSDRMonitor.exe
```

## Build Output

Successful build shows:
```
Build succeeded.
    1 Warning(s)
    0 Error(s)
Time Elapsed 00:00:01.03

UberSDRMonitor.vcxproj -> C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32\Release\UberSDRMonitor.exe
```

## Usage

1. **Start CW Skimmer Server** with the UberSDR DLL loaded
2. **Run UberSDRMonitor.exe**
3. The monitor will automatically:
   - Connect to the DLL's shared memory
   - Connect to telnet server on localhost:7300
   - Send "N0CALL" when prompted for callsign
   - Display all telnet output in the text area at bottom

## Troubleshooting

### Build Errors

**Error: 'msbuild' is not recognized**
- Solution: Use the full path to VsDevCmd.bat as shown above
- This sets up the Visual Studio environment

**Error: 'cmake' is not recognized**
- Solution: Install CMake and restart PowerShell
- Or use Visual Studio's built-in CMake

**Error: Cannot find VsDevCmd.bat**
- Solution: Adjust path to match your Visual Studio installation
- Common paths:
  - VS 2022: `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat`
  - VS 2019: `C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\Common7\Tools\VsDevCmd.bat`

### Runtime Issues

**Monitor shows "DLL not loaded - waiting..."**
- The UberSDR DLL hasn't been loaded yet
- Start CW Skimmer Server with the UberSDR DLL
- The monitor will automatically connect when the DLL loads

**Telnet connection fails**
- Ensure telnet server is running on localhost:7300
- Check firewall settings
- Telnet will auto-reconnect every 5 seconds

## Clean Build

To perform a clean build:

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32

# Clean
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean

# Or clean and rebuild
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean,Build
```

## Complete Rebuild from Scratch

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor
Remove-Item -Recurse -Force build32
mkdir build32
cd build32

# Configure for 32-bit
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
cmake -A Win32 ..

# Build
msbuild UberSDRMonitor.vcxproj /p:Configuration=Release /p:Platform=Win32
```

## Debug Build

For debugging:

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRMonitor\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRMonitor.vcxproj /p:Configuration=Debug /p:Platform=Win32
```

Debug executable will include symbols and detailed logging.

## Files

- `UberSDRMonitor.cpp` - Main application code with telnet client
- `UberSDRMonitor.rc` - Dialog resource definition
- `resource.h` - Resource IDs
- `CMakeLists.txt` - CMake build configuration
- `../UberSDRIntf/UberSDRShared.h` - Shared memory structure definition

## License

Same as UberSDRIntf DLL