# Building UberSDRIntf

## Prerequisites

- Visual Studio 2019 or later (with C++ desktop development)
- Git (for cloning IXWebSocket - already done)
- IXWebSocket library (already cloned in `UberSDRIntf/IXWebSocket/`)
- nlohmann/json library (already downloaded as `json.hpp`)

## ✅ VERIFIED WORKING BUILD COMMAND (32-bit for CW Skimmer)

### Complete Build from Scratch (PowerShell)

```powershell
# Navigate to project directory
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf

# Create 32-bit build directory
mkdir build32
cd build32

# Configure CMake for 32-bit (CRITICAL: -A Win32 flag)
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
cmake -A Win32 ..

# Build the DLL
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32
```
```
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32
```

**Output:** `build32\Release\UberSDRIntf.dll` (495 KB, 32-bit, static runtime)

**Build Time:** ~20-25 seconds

### Quick Rebuild (After Changes)

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Build
```

**Build Time:** ~2-4 seconds (only changed files)

### Clean and Rebuild

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean,Build
```

**Build Time:** ~20-25 seconds

### From CMD (Alternative)

```cmd
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32
"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" && msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32
```

### Using Visual Studio GUI

1. Open `UberSDRIntf.sln` in Visual Studio (located in build32 directory)
2. Select "Release" configuration and "Win32" platform from toolbar
3. Build → Build Solution (Ctrl+Shift+B)
4. Find DLL in `build32\Release\UberSDRIntf.dll`

## Important Notes

### Why 32-bit (Win32)?
**CW Skimmer is a 32-bit application** and cannot load 64-bit DLLs. The `-A Win32` flag in cmake is **critical**.

### Why Static Runtime (/MT)?
To avoid dependency on MSVCP140.dll and VCRUNTIME140.dll, we use static runtime linking (matches HermesIntf).

### Build Directory
Use `build32` (not `build`) to clearly indicate 32-bit build.

## Manual Build (Without CMake)

If you prefer to build without CMake:

### 1. Create Visual Studio Project

1. Open Visual Studio
2. Create New Project → Dynamic-Link Library (DLL)
3. Name: UberSDRIntf
4. Add existing files:
   - UberSDRIntf.cpp
   - UberSDR.cpp
   - UberSDRIntf.h
   - UberSDR.h

### 2. Add IXWebSocket Source Files

Add all `.cpp` files from `IXWebSocket/ixwebsocket/` except:
- Files containing "SSL" or "TLS" in the name
- Files containing "OpenSSL" or "MbedTLS"

### 3. Project Settings

**C/C++ → General → Additional Include Directories:**
```
$(ProjectDir)
$(ProjectDir)IXWebSocket
```

**C/C++ → Preprocessor → Preprocessor Definitions:**
```
UBERSDRINTF_EXPORTS
IXWEBSOCKET_USE_TLS=0
IXWEBSOCKET_USE_OPEN_SSL=0
WIN32
_WINDOWS
_USRDLL
```

**Linker → Input → Additional Dependencies:**
```
ws2_32.lib
crypt32.lib
```

### 4. Build

- Select Release configuration
- Build Solution (Ctrl+Shift+B)
- Output: `Release/UberSDRIntf.dll`

## Verification

After building, verify the DLL:

```powershell
# Check DLL exists
Test-Path .\Release\UberSDRIntf.dll

# View file details
dir .\Release\UberSDRIntf.dll

# Check DLL exports (from Developer Command Prompt)
dumpbin /EXPORTS .\Release\UberSDRIntf.dll

# Should show:
# - GetSdrInfo
# - StartRx
# - StopRx
# - SetRxFrequency
# - SetCtrlBits
# - ReadPort
```

## Build Output

Successful build shows:
```
Build succeeded.
    2 Warning(s)
    0 Error(s)
Time Elapsed 00:00:22.44

UberSDRIntf.vcxproj -> C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build\Release\UberSDRIntf.dll
```

## Installation

```powershell
# From build32 directory
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32

# Copy to CW Skimmer directory
Copy-Item .\Release\UberSDRIntf.dll "C:\Program Files (x86)\Afreet\SkimSrv\"

# Or with custom server configuration
Copy-Item .\Release\UberSDRIntf.dll "C:\Program Files (x86)\Afreet\SkimSrv\UberSDRIntf_192.168.9.99_8080.dll"
```

Then:
1. Start CW Skimmer Server
2. Select "UberSDR-IQ192" from receiver dropdown
3. Monitor `UberSDRIntf_log_file.txt` in Skimmer directory

## Troubleshooting

### Build Errors

**Error: 'cmake' is not recognized**
- Solution: CMake not needed! Use the msbuild command shown above
- Or install CMake and restart PowerShell

**Error: 'msbuild' is not recognized**
- Solution: Use the full path to VsDevCmd.bat as shown above
- This sets up the Visual Studio environment

**Error: Cannot open include file 'openssl/...'**
- Solution: Already fixed with stub files
- Ensure IXSocketFactoryStub.cpp and IXUserAgentStub.cpp exist

**Error: Unresolved external symbol ProcessIQData**
- Solution: Already fixed - function moved outside namespace
- Rebuild with Clean,Build target

**Error: WinSock redefinition errors**
- Solution: Already fixed with WIN32_LEAN_AND_MEAN and _WINSOCKAPI_
- Ensure these are defined before including windows.h

### Runtime Errors

**DLL fails to load**
- Check dependencies with Dependency Walker
- Ensure Visual C++ Redistributable is installed

**No connection to server**
- Check `UberSDRIntf_log_file.txt` in Skimmer directory
- Verify server is running: `http://localhost:8080`
- Check firewall settings

## Testing

### Test with ka9q_ubersdr Server

1. Start ka9q_ubersdr server:
```bash
cd ka9q_ubersdr
go run .
```

2. Verify server is running:
```bash
curl http://localhost:8080/
```

3. Start CW Skimmer with UberSDRIntf.dll

4. Monitor log file:
```bash
tail -f UberSDRIntf_log_file.txt
```

Expected log entries:
```
2025-01-19 14:00:00.000: === UberSDRIntf DLL Loaded ===
2025-01-19 14:00:00.001: UberSDR initialized with server: localhost:8080
2025-01-19 14:00:01.000: GetSdrInfo called
2025-01-19 14:00:01.001: Connected to UberSDR server at localhost:8080
2025-01-19 14:00:02.000: StartRx called
2025-01-19 14:00:02.001: Starting receiver 0 at 14074000 Hz, mode iq192
2025-01-19 14:00:02.100: Receiver 0 WebSocket connected
```

## Performance

Expected performance metrics:
- **Latency**: 50-150ms (WebSocket + buffering)
- **CPU Usage**: <5% per receiver
- **Memory**: ~10MB per receiver
- **Network**: ~3 Mbps per receiver at 192 kHz

## Clean Build

To perform a clean build:

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf\build32

# Clean
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean

# Or clean and rebuild
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32 /t:Clean,Build
```

## Complete Rebuild from Scratch

```powershell
cd C:\Users\MadPsy\Repos\HermesIntf\UberSDRIntf
Remove-Item -Recurse -Force build32
mkdir build32
cd build32

# Configure for 32-bit
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
cmake -A Win32 ..

# Build
msbuild UberSDRIntf.vcxproj /p:Configuration=Release /p:Platform=Win32
```

## Debug Build

For debugging:

```bash
cmake --build . --config Debug
```

Debug DLL will include symbols and detailed logging.

## Cross-Compilation

Currently Windows-only. For Linux/macOS support, Wine or native port required.

## Next Steps

After successful build:
1. Test with ka9q_ubersdr server
2. Verify IQ data flow
3. Test frequency changes
4. Test multiple receivers (up to 8)
5. Verify CW Skimmer integration