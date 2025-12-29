# Multi-Instance Support Design

## Overview
Enable multiple CW Skimmer Server instances to run simultaneously on the same machine without conflicts.

## Problem
Currently, both DLL and Monitor use a hardcoded shared memory name `UberSDRIntf_Status_v1`, causing conflicts when multiple instances run.

## Solution Design

### 1. Instance Identification
- Each DLL instance generates a unique ID on load using Process ID
- Format: `{ProcessID}` (simple, reliable, automatically unique per process)
- Shared memory name becomes: `UberSDRIntf_Status_v1_{ProcessID}`

### 2. Registry-Based Instance Directory
**Registry Location:** `HKEY_CURRENT_USER\Software\UberSDR\Instances`

**Per-Instance Key:** `HKEY_CURRENT_USER\Software\UberSDR\Instances\{ProcessID}`

**Values stored per instance:**
- `ProcessID` (DWORD): Process ID
- `ServerHost` (REG_SZ): Server hostname/IP
- `ServerPort` (DWORD): Server port
- `StartTime` (QWORD): Start time in milliseconds
- `SharedMemoryName` (REG_SZ): Full shared memory name
- `LastHeartbeat` (QWORD): Last update time (for stale detection)

### 3. DLL Implementation

#### Initialization (DllMain - DLL_PROCESS_ATTACH)
1. Get current process ID
2. Generate shared memory name: `UberSDRIntf_Status_v1_{PID}`
3. Create shared memory with unique name
4. Create registry key: `HKCU\Software\UberSDR\Instances\{PID}`
5. Write instance metadata to registry
6. Initialize shared memory structure

#### Heartbeat Updates
- Update `LastHeartbeat` registry value every 10 seconds
- Allows monitor to detect stale/crashed instances

#### Cleanup (DllMain - DLL_PROCESS_DETACH)
1. Mark shared memory as unloaded
2. Delete registry key: `HKCU\Software\UberSDR\Instances\{PID}`
3. Unmap and close shared memory

### 4. Monitor Implementation

#### Startup
1. Enumerate all keys under `HKCU\Software\UberSDR\Instances`
2. For each key:
   - Read metadata
   - Verify process still exists (OpenProcess)
   - Check heartbeat freshness (< 30 seconds old)
   - Clean up stale entries
3. Build list of valid instances

#### Instance Selection
- **If 0 instances:** Show "Waiting for DLL..." message
- **If 1 instance:** Auto-connect (backward compatible)
- **If 2+ instances:** Show selection dialog with:
  - Server host:port
  - Process ID
  - Start time
  - Status (Connected/Disconnected)

#### Selection Dialog
```
Multiple UberSDR Instances Detected

Select instance to monitor:

○ ubersdr.local:8080 (PID 1234, started 10:30:00) [Connected]
○ 192.168.1.100:8080 (PID 5678, started 10:35:00) [Connected]

[OK] [Cancel] [Refresh]
```

#### Connection
1. Read `SharedMemoryName` from selected instance's registry key
2. Open shared memory with that name
3. Map view and start monitoring

#### Periodic Refresh
- Re-enumerate instances every 5 seconds
- Detect if current instance disappeared
- Auto-reconnect or show selection dialog

### 5. Stale Instance Cleanup

**Stale Detection Criteria:**
- Process no longer exists (OpenProcess fails)
- Heartbeat > 30 seconds old
- Shared memory no longer exists

**Cleanup Actions:**
- Delete stale registry keys
- Log cleanup action

### 6. Error Handling

**DLL Side:**
- If registry write fails: Log warning, continue (shared memory still works)
- If shared memory creation fails: Fatal error (existing behavior)

**Monitor Side:**
- If no instances found: Show waiting message, retry every 2 seconds
- If selected instance disappears: Show error, return to selection
- If registry access fails: Fall back to legacy behavior (try default name)

### 7. Backward Compatibility

**Legacy Monitor (old version):**
- Will not find new shared memory names
- Will show "DLL not loaded" message
- User must upgrade monitor

**New Monitor with Legacy DLL:**
- Will not find registry entries
- Falls back to trying default shared memory name
- Works with old DLL

### 8. Security Considerations

- Use HKEY_CURRENT_USER (per-user, no admin rights needed)
- Shared memory created with default security (same as current)
- No sensitive data stored in registry

### 9. Implementation Files

**Modified Files:**
- `UberSDRShared.h` - Add constants, helper functions
- `UberSDRIntf.cpp` - Instance registration, heartbeat
- `UberSDRMonitor.cpp` - Instance enumeration, selection dialog
- `resource.h` - Dialog resource IDs
- `UberSDRMonitor.rc` - Selection dialog UI

**New Files:**
- `MULTI_INSTANCE_DESIGN.md` - This design document

### 10. Testing Plan

**Test 1: Single Instance (Backward Compatibility)**
- Start one CW Skimmer Server
- Start Monitor
- Verify auto-connect without dialog
- Verify metrics display correctly

**Test 2: Multiple Instances**
- Start two CW Skimmer Servers in different directories
- Configure different servers in each INI file
- Start Monitor
- Verify selection dialog appears
- Select each instance, verify correct data

**Test 3: Stale Cleanup**
- Start CW Skimmer Server
- Kill process abnormally (Task Manager)
- Start Monitor
- Verify stale entry is cleaned up
- Verify no error messages

**Test 4: Dynamic Instance Changes**
- Start Monitor with one instance
- Start second instance
- Verify Monitor detects new instance (manual refresh)
- Stop first instance
- Verify Monitor handles disappearance gracefully

**Test 5: Registry Failure**
- Deny registry write access (test only)
- Verify DLL still loads and functions
- Verify Monitor falls back gracefully

### 11. Performance Impact

- **DLL:** Minimal - one-time registry write on load, periodic heartbeat (10s)
- **Monitor:** Minimal - registry enumeration every 5s, negligible overhead
- **Memory:** No change - same shared memory structure
- **Network:** No change - no network operations added

### 12. Future Enhancements

- Add instance nickname/label in registry
- Add "Monitor All" mode showing all instances in tabs
- Add remote monitoring (network-based instance discovery)
- Add instance health metrics in registry
