# Multi-Instance Support for CW Skimmer UberSDR Interface

## Overview

The UberSDR Interface DLL and Monitor application now support running multiple CW Skimmer Server instances simultaneously on the same machine without conflicts.

## What Changed

### Previous Behavior
- Single hardcoded shared memory name: `UberSDRIntf_Status_v1`
- Only one CW Skimmer Server instance could run per machine
- Monitor could only connect to one instance

### New Behavior
- Each DLL instance creates unique shared memory: `UberSDRIntf_Status_v1_{ProcessID}`
- Multiple CW Skimmer Server instances can run simultaneously
- Monitor automatically detects and connects to instances:
  - **0 instances**: Shows "Waiting for DLL..." message
  - **1 instance**: Auto-connects (backward compatible)
  - **2+ instances**: Shows selection dialog

## Technical Implementation

### DLL Side (UberSDRIntf.dll)

#### Instance Registration
On DLL load (`DllMain` - `DLL_PROCESS_ATTACH`):
1. Gets current process ID
2. Creates unique shared memory: `UberSDRIntf_Status_v1_{PID}`
3. Registers instance in Windows Registry:
   - Location: `HKEY_CURRENT_USER\Software\UberSDR\Instances\{PID}`
   - Values stored:
     - `ProcessID` (DWORD)
     - `ServerHost` (REG_SZ)
     - `ServerPort` (DWORD)
     - `StartTime` (QWORD)
     - `SharedMemoryName` (REG_SZ)
     - `LastHeartbeat` (QWORD)

#### Heartbeat Thread
- Updates `LastHeartbeat` registry value every 10 seconds
- Allows monitor to detect stale/crashed instances
- Automatically stops on DLL unload

#### Cleanup
On DLL unload (`DllMain` - `DLL_PROCESS_DETACH`):
1. Stops heartbeat thread
2. Deletes registry key
3. Unmaps and closes shared memory

### Monitor Side (UberSDRMonitor.exe)

#### Instance Enumeration
On startup:
1. Cleans up stale registry entries (dead processes, old heartbeats)
2. Enumerates all keys under `HKCU\Software\UberSDR\Instances`
3. Validates each instance:
   - Process still exists (`OpenProcess`)
   - Heartbeat is fresh (< 30 seconds old)
4. Builds list of valid instances

#### Connection Logic
- **No instances**: Shows waiting message, retries every 2 seconds
- **Single instance**: Auto-connects to shared memory (backward compatible)
- **Multiple instances**: Shows selection dialog, connects to selected instance

#### Stale Instance Detection
An instance is considered stale if:
- Process no longer exists
- Heartbeat is > 30 seconds old
- Shared memory no longer exists

Stale entries are automatically cleaned up on monitor startup.

## Usage

### Running Multiple Instances

1. **Install CW Skimmer Server in separate directories:**
   ```
   C:\SkimSrv1\
   C:\SkimSrv2\
   ```

2. **Configure each instance with different servers:**
   
   `C:\SkimSrv1\UberSDRIntf.ini`:
   ```ini
   [Server]
   Host=ubersdr.local
   Port=8080
   ```
   
   `C:\SkimSrv2\UberSDRIntf.ini`:
   ```ini
   [Server]
   Host=192.168.1.100
   Port=8080
   ```

3. **Start both CW Skimmer Server instances**

4. **Start UberSDRMonitor.exe:**
   - If only one instance is running: Auto-connects
   - If multiple instances are running: Shows selection dialog

### Monitor Selection Dialog

When multiple instances are detected, the monitor shows:

```
Multiple UberSDR instances detected. Select one:

[1] ubersdr.local:8080 (PID 1234, started 10:30:00)
[2] 192.168.1.100:8080 (PID 5678, started 10:35:00)

Auto-selecting first instance...
```

Currently auto-selects the first instance. Future enhancement will add proper radio button selection.

## Registry Structure

```
HKEY_CURRENT_USER\Software\UberSDR\Instances\
├── 1234\                           (Process ID)
│   ├── ProcessID = 1234            (DWORD)
│   ├── ServerHost = "ubersdr.local" (REG_SZ)
│   ├── ServerPort = 8080           (DWORD)
│   ├── StartTime = 1735488600000   (QWORD, milliseconds)
│   ├── SharedMemoryName = "UberSDRIntf_Status_v1_1234" (REG_SZ)
│   └── LastHeartbeat = 1735488610000 (QWORD, milliseconds)
└── 5678\
    ├── ProcessID = 5678
    ├── ServerHost = "192.168.1.100"
    ├── ServerPort = 8080
    ├── StartTime = 1735488900000
    ├── SharedMemoryName = "UberSDRIntf_Status_v1_5678"
    └── LastHeartbeat = 1735488910000
```

## Backward Compatibility

### With Old Monitor
- Old monitor will not find new shared memory names
- Will show "DLL not loaded" message
- **Solution**: Upgrade monitor to new version

### With Old DLL
- New monitor will not find registry entries
- Falls back to trying default shared memory name
- **Result**: Works with old DLL (single instance only)

## Files Modified

### Core Implementation
- [`UberSDRShared.h`](UberSDRIntf/UberSDRShared.h) - Added constants, structures, function declarations
- [`UberSDRIntf.cpp`](UberSDRIntf/UberSDRIntf.cpp) - Registry functions, unique shared memory, heartbeat
- [`UberSDRMonitor.cpp`](UberSDRMonitor/UberSDRMonitor.cpp) - Instance enumeration, selection, connection

### Documentation
- [`MULTI_INSTANCE_DESIGN.md`](UberSDRIntf/MULTI_INSTANCE_DESIGN.md) - Detailed design document
- [`MULTI_INSTANCE_README.md`](MULTI_INSTANCE_README.md) - This file

## Testing Checklist

### ✓ Single Instance (Backward Compatibility)
- [x] Start one CW Skimmer Server
- [x] Start Monitor
- [x] Verify auto-connect without dialog
- [x] Verify metrics display correctly

### ⚠ Multiple Instances
- [ ] Start two CW Skimmer Servers in different directories
- [ ] Configure different servers in each INI file
- [ ] Start Monitor
- [ ] Verify selection dialog appears
- [ ] Select each instance, verify correct data

### ⚠ Stale Cleanup
- [ ] Start CW Skimmer Server
- [ ] Kill process abnormally (Task Manager)
- [ ] Start Monitor
- [ ] Verify stale entry is cleaned up
- [ ] Verify no error messages

### ⚠ Dynamic Changes
- [ ] Start Monitor with one instance
- [ ] Start second instance
- [ ] Verify Monitor detects new instance (manual refresh)
- [ ] Stop first instance
- [ ] Verify Monitor handles disappearance gracefully

## Known Limitations

1. **Selection Dialog**: Currently auto-selects first instance. Proper radio button dialog not yet implemented.
2. **No Dynamic Refresh**: Monitor doesn't automatically detect new instances after startup (requires restart).
3. **Windows Only**: Uses Windows-specific APIs (Registry, Process handles).

## Future Enhancements

- [ ] Proper selection dialog with radio buttons and OK/Cancel
- [ ] Dynamic instance detection (refresh button or automatic)
- [ ] Instance nickname/label support
- [ ] "Monitor All" mode with tabs for each instance
- [ ] Remote monitoring (network-based discovery)
- [ ] Instance health metrics in registry

## Troubleshooting

### Monitor shows "Waiting for DLL..."
- **Cause**: No instances registered in registry
- **Solution**: 
  1. Verify CW Skimmer Server is running
  2. Check registry: `HKCU\Software\UberSDR\Instances`
  3. Check DLL log file: `UberSDRIntf_log_file.txt`

### Monitor can't connect to instance
- **Cause**: Shared memory name mismatch or stale entry
- **Solution**:
  1. Restart Monitor (triggers stale cleanup)
  2. Verify process is still running
  3. Check registry heartbeat timestamp

### Multiple instances conflict
- **Cause**: Instances in same directory sharing INI file
- **Solution**: Install each instance in separate directory

### Registry entries not cleaned up
- **Cause**: Abnormal termination (crash, kill)
- **Solution**: Start Monitor (auto-cleans stale entries)

## Performance Impact

- **DLL**: Minimal
  - One-time registry write on load
  - Heartbeat update every 10 seconds
  - No impact on audio processing

- **Monitor**: Minimal
  - Registry enumeration on startup only
  - No ongoing registry access
  - Same shared memory access as before

- **Memory**: No change
  - Same shared memory structure
  - Small registry overhead (< 1 KB per instance)

## Security Considerations

- Uses `HKEY_CURRENT_USER` (per-user, no admin rights needed)
- Shared memory created with default security
- No sensitive data stored in registry
- Process ID validation prevents spoofing

## Support

For issues or questions:
1. Check log file: `UberSDRIntf_log_file.txt`
2. Check registry: `HKCU\Software\UberSDR\Instances`
3. Review design document: [`MULTI_INSTANCE_DESIGN.md`](UberSDRIntf/MULTI_INSTANCE_DESIGN.md)
4. Contact maintainer

## Version History

### v2.0.0 (2025-12-29)
- Added multi-instance support
- Registry-based instance tracking
- Automatic instance enumeration
- Backward compatible with single instance
- Stale instance cleanup
- Heartbeat monitoring
