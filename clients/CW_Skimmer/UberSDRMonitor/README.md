# UberSDR Monitor

A native Windows application that displays real-time status information from the UberSDR DLL via shared memory.

## Features

- **Real-time monitoring** of UberSDR DLL status
- **Server connection status** - shows host, port, and connection state
- **Receiver status** - displays frequency, activity, and throughput for all 8 receivers
- **Statistics** - callback count, uptime, and total network throughput
- **No DLL dependency** - communicates via shared memory
- **Lightweight** - minimal CPU and memory usage

## Building

### Using CMake (Recommended)

**Step 1: Configure the build**
```cmd
cd UberSDRMonitor
mkdir build
cd build
"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" .. -G "Visual Studio 17 2022" -A Win32
```

**Step 2: Build the application**
```cmd
"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" --build . --config Release
```

The executable will be in `build/Release/UberSDRMonitor.exe`

**Note:** If CMake is in your PATH, you can use the shorter commands:
```cmd
cd UberSDRMonitor
mkdir build
cd build
cmake .. -G "Visual Studio 17 2022" -A Win32
cmake --build . --config Release
```

### Using Visual Studio

1. Open `UberSDRMonitor.sln` (if created) or create a new Win32 project
2. Add all `.cpp`, `.rc`, and `.h` files
3. Set project to use Multi-Byte Character Set (MBCS)
4. Build as Win32 Release

## Usage

1. **Start CW Skimmer Server** with the UberSDR DLL loaded
2. **Run UberSDRMonitor.exe**
3. The monitor will automatically connect to the DLL's shared memory
4. Status updates every second

### Display Information

**Server Status:**
- Server host and port
- Connection state (Connected/Disconnected)
- Sample rate and IQ mode
- Block size

**Receiver Status (for each of 8 receivers):**
- Frequency (in MHz/kHz)
- Active/Inactive state
- Network throughput (KB/s)
- Session ID

**Statistics:**
- Total callbacks to CW Skimmer
- Total samples processed
- Uptime since DLL loaded
- Active receiver count
- Total network throughput (KB/s and Mbps)

## Troubleshooting

**"DLL not loaded - waiting..."**
- The UberSDR DLL hasn't been loaded yet
- Start CW Skimmer Server with the UberSDR DLL
- The monitor will automatically connect when the DLL loads

**No data showing:**
- Ensure CW Skimmer Server is running
- Check that receivers are started (not just in initialization mode)
- Verify the DLL is the correct version with shared memory support

## Technical Details

### Shared Memory

The monitor connects to a shared memory region named `UberSDRIntf_Status_v1` created by the DLL. This allows real-time monitoring without any performance impact on the DLL or CW Skimmer Server.

### Update Rate

The display updates every 1 second. Throughput calculations are performed by the DLL every second based on actual bytes received.

### Memory Usage

- Shared memory: ~2 KB
- Application memory: ~2 MB
- CPU usage: <1%

## Files

- `UberSDRMonitor.cpp` - Main application code
- `UberSDRMonitor.rc` - Dialog resource definition
- `resource.h` - Resource IDs
- `CMakeLists.txt` - CMake build configuration
- `../UberSDRIntf/UberSDRShared.h` - Shared memory structure definition

## License

Same as UberSDRIntf DLL