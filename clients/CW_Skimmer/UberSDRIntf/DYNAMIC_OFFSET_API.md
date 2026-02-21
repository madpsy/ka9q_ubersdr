# Dynamic Frequency Offset API

## Overview

The UberSDR DLL now supports **dynamic per-receiver frequency offset control** via shared memory communication. This allows the monitor application (or other external tools) to send real-time frequency offset adjustments to individual receivers without restarting CW Skimmer.

## Architecture

### Two-Level Offset System

The frequency offset system operates on two levels:

1. **Global Offset (INI File)** - Set in `UberSDRIntf.ini` under `[Calibration]` section
   - Applied to ALL receivers
   - Static - requires DLL reload to change
   - Useful for systematic SDR calibration errors

2. **Per-Receiver Dynamic Offset** - Set via shared memory commands
   - Applied to individual receivers
   - Dynamic - can be changed in real-time
   - Useful for fine-tuning individual receiver frequencies

**Total Offset = Global Offset (INI) + Per-Receiver Offset (Dynamic)**

### Communication Method

The system uses **shared memory** with a **command queue** for bidirectional communication:

- **Monitor → DLL**: Commands sent via ring buffer in shared memory
- **DLL → Monitor**: Status updates via shared memory fields
- **Polling**: DLL polls command queue every 100ms

## Data Structures

### Command Types

```cpp
enum UberSDRCommandType {
    CMD_NONE = 0,
    CMD_SET_FREQUENCY_OFFSET = 1,  // Set offset but don't retune
    CMD_APPLY_OFFSET = 2           // Set offset and retune immediately
};
```

### Command Structure

```cpp
struct UberSDRCommand {
    volatile int32_t commandType;      // UberSDRCommandType
    volatile int32_t receiverID;       // Target receiver (0-7)
    volatile int32_t frequencyOffset;  // Frequency offset in Hz (can be negative)
    volatile int32_t sequenceNumber;   // Incremented for each command
    volatile int32_t acknowledged;     // Set to sequenceNumber by DLL when processed
    volatile int64_t timestamp;        // Command timestamp
};
```

### Receiver Status Fields

Each receiver in `UberSDRSharedStatus` has the following offset-related fields:

```cpp
struct ReceiverStatus {
    // ... other fields ...
    
    volatile int32_t frequencyOffset;       // Per-receiver offset in Hz (dynamic)
    volatile int32_t globalFrequencyOffset; // Global offset from INI file (read-only)
    volatile int32_t totalFrequencyOffset;  // Total offset (INI + per-receiver)
    volatile int32_t requestedOffset;       // Last requested offset from monitor
    volatile int32_t offsetApplied;         // Set to 1 when offset is applied
    
    // ... other fields ...
};
```

**Field Descriptions:**

- **`frequencyOffset`** - The per-receiver dynamic offset set via commands (can be changed in real-time)
- **`globalFrequencyOffset`** - The global offset from INI file (read-only, same for all receivers)
- **`totalFrequencyOffset`** - The actual offset applied = `globalFrequencyOffset + frequencyOffset`
- **`requestedOffset`** - The last offset value requested by the monitor
- **`offsetApplied`** - Flag indicating if the offset has been applied (1) or not (0)

## API Functions

### SendFrequencyOffsetCommand

Send a frequency offset command to the DLL.

```cpp
BOOL SendFrequencyOffsetCommand(
    UberSDRSharedStatus* pStatus,  // Pointer to shared memory
    int receiverID,                // Receiver ID (0-7)
    int frequencyOffset,           // Offset in Hz (can be negative)
    BOOL applyImmediately          // TRUE = retune now, FALSE = set only
);
```

**Parameters:**
- `pStatus` - Pointer to mapped shared memory structure
- `receiverID` - Target receiver (0-7)
- `frequencyOffset` - Frequency offset in Hz (positive or negative)
- `applyImmediately` - If TRUE, sends `CMD_APPLY_OFFSET` (retunes receiver immediately)
                       If FALSE, sends `CMD_SET_FREQUENCY_OFFSET` (sets offset for next tune)

**Returns:**
- `TRUE` - Command queued successfully
- `FALSE` - Failed (invalid parameters or queue full)

**Example:**
```cpp
// Set +50 Hz offset on receiver 0 and apply immediately
SendFrequencyOffsetCommand(pSharedStatus, 0, 50, TRUE);

// Set -100 Hz offset on receiver 1 (will apply on next tune)
SendFrequencyOffsetCommand(pSharedStatus, 1, -100, FALSE);
```

### WaitForCommandAck

Wait for the DLL to acknowledge a command.

```cpp
BOOL WaitForCommandAck(
    UberSDRSharedStatus* pStatus,  // Pointer to shared memory
    int32_t sequenceNumber,        // Sequence number to wait for
    int timeoutMs                  // Timeout in milliseconds
);
```

**Parameters:**
- `pStatus` - Pointer to mapped shared memory structure
- `sequenceNumber` - Sequence number from command (returned by SendFrequencyOffsetCommand)
- `timeoutMs` - Maximum time to wait in milliseconds

**Returns:**
- `TRUE` - Command acknowledged by DLL
- `FALSE` - Timeout or error

**Example:**
```cpp
// Send command and wait for acknowledgment
if (SendFrequencyOffsetCommand(pSharedStatus, 0, 50, TRUE)) {
    // Get sequence number from command queue
    int32_t seqNum = pSharedStatus->commandQueue[
        (pSharedStatus->commandWritePos - 1) % 16
    ].sequenceNumber;
    
    if (WaitForCommandAck(pSharedStatus, seqNum, 5000)) {
        // Command processed successfully
    } else {
        // Timeout - DLL may not be responding
    }
}
```

## Usage Examples

### Example 1: Simple Offset Adjustment

```cpp
// Open shared memory for a specific process
HANDLE hSharedMem = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, 
                                     L"UberSDRIntf_Status_v1_12345");
UberSDRSharedStatus* pStatus = (UberSDRSharedStatus*)MapViewOfFile(
    hSharedMem, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(UberSDRSharedStatus));

// Adjust receiver 0 by +25 Hz and apply immediately
SendFrequencyOffsetCommand(pStatus, 0, 25, TRUE);

// Check status after a moment
Sleep(200);
printf("Receiver 0 offset: %d Hz (total: %d Hz)\n",
       pStatus->receivers[0].frequencyOffset,
       pStatus->receivers[0].totalFrequencyOffset);

// Cleanup
UnmapViewOfFile(pStatus);
CloseHandle(hSharedMem);
```

### Example 2: Fine-Tuning with Feedback

```cpp
// Incrementally adjust offset based on measurement
int currentOffset = pStatus->receivers[0].frequencyOffset;
int adjustment = -10;  // Adjust by -10 Hz

SendFrequencyOffsetCommand(pStatus, 0, currentOffset + adjustment, TRUE);

// Wait for application
if (WaitForCommandAck(pStatus, seqNum, 2000)) {
    if (pStatus->receivers[0].offsetApplied == 1) {
        printf("Offset applied successfully\n");
        printf("New total offset: %d Hz\n", 
               pStatus->receivers[0].totalFrequencyOffset);
    }
}
```

### Example 3: Reset Offset to Zero

```cpp
// Reset per-receiver offset (global INI offset still applies)
SendFrequencyOffsetCommand(pStatus, 0, 0, TRUE);
```

### Example 4: Monitor All Receivers

```cpp
// Display offset status for all active receivers
for (int i = 0; i < MAX_RX_COUNT; i++) {
    if (pStatus->receivers[i].active) {
        printf("Receiver %d:\n", i);
        printf("  Frequency: %d Hz\n", pStatus->receivers[i].frequency);
        printf("  Global offset (INI): %d Hz\n",
               pStatus->receivers[i].globalFrequencyOffset);
        printf("  Per-receiver offset: %d Hz\n",
               pStatus->receivers[i].frequencyOffset);
        printf("  Total offset: %d Hz\n",
               pStatus->receivers[i].totalFrequencyOffset);
        printf("  Actual tuned frequency: %d Hz\n",
               pStatus->receivers[i].frequency +
               pStatus->receivers[i].totalFrequencyOffset);
    }
}
```

## Command Processing Flow

1. **Monitor sends command**
   - Fills `UberSDRCommand` structure in command queue
   - Increments `commandWritePos` atomically
   - Optionally waits for acknowledgment

2. **DLL polls command queue** (every 100ms)
   - Checks if `commandReadPos != commandWritePos`
   - Processes pending commands in order
   - Updates receiver offset and/or retunes
   - Sets `acknowledged = sequenceNumber`
   - Increments `commandReadPos`

3. **Status updated in shared memory**
   - `frequencyOffset` - Per-receiver offset
   - `totalFrequencyOffset` - Global + per-receiver
   - `offsetApplied` - Set to 1 when retune completes

## Command Types Explained

### CMD_SET_FREQUENCY_OFFSET

Sets the per-receiver offset but **does not retune** the receiver immediately.

**Use case:** Pre-configure offset before receiver starts, or set offset that will apply on next frequency change.

**Behavior:**
- Updates `receivers[rxID].perReceiverOffset`
- Updates shared memory status fields
- Does NOT send tune message to server
- Offset will be applied on next `SetFrequency()` call

### CMD_APPLY_OFFSET

Sets the per-receiver offset and **immediately retunes** the receiver.

**Use case:** Real-time frequency adjustment while receiver is active.

**Behavior:**
- Updates `receivers[rxID].perReceiverOffset`
- Calls `SetFrequency(rxID, currentFrequency)` to retune
- Sends tune message to server with new total offset
- Sets `offsetApplied = 1` when complete

## Offset Calculation

When building WebSocket URLs or tune messages, the DLL calculates:

```cpp
int totalOffset = frequencyOffset + receivers[receiverID].perReceiverOffset;
int actualFrequency = requestedFrequency + totalOffset;
```

**Example:**
- INI file: `FrequencyOffset=100` (global)
- Per-receiver offset: `50` Hz (dynamic)
- CW Skimmer requests: `14074000` Hz
- **Actual tuned frequency:** `14074150` Hz

## Thread Safety

The implementation uses several mechanisms for thread safety:

1. **Volatile fields** - All command and status fields are `volatile`
2. **Atomic operations** - `InterlockedExchange()` for queue pointers
3. **Critical sections** - Protect receiver state in DLL
4. **Ring buffer** - Lock-free command queue (16 slots)

## Limitations

1. **Queue size**: 16 commands maximum
   - If queue is full, `SendFrequencyOffsetCommand()` returns FALSE
   - Commands are processed every 100ms, so queue rarely fills

2. **Receiver must be active**: `CMD_APPLY_OFFSET` only works on active receivers
   - Check `receivers[rxID].active` before sending

3. **No command cancellation**: Once queued, commands will be processed
   - Send a new command to override previous one

4. **Polling interval**: 100ms between command checks
   - Typical latency: 0-100ms for command processing

## Troubleshooting

### Command not acknowledged

**Possible causes:**
- DLL not running or crashed
- Receiver not active (for `CMD_APPLY_OFFSET`)
- Invalid receiver ID
- Shared memory not properly mapped

**Solution:**
- Check `pStatus->dllLoaded` is TRUE
- Verify `pStatus->receivers[rxID].active` is TRUE
- Check DLL log file for errors

### Offset not applied

**Check:**
1. `offsetApplied` flag in shared memory
2. `totalFrequencyOffset` includes your change
3. DLL log file for tune messages
4. Server is responding to tune requests

### Unexpected total offset

**Remember:**
- Total offset = INI global offset + per-receiver offset
- Check `FrequencyOffset` in `UberSDRIntf.ini`
- Use `totalFrequencyOffset` field to see actual value

## Integration with Monitor Application

The monitor application can use this API to:

1. **Display current offsets** for all receivers
2. **Provide UI controls** for fine-tuning (e.g., ±1 Hz, ±10 Hz buttons)
3. **Implement automatic calibration** based on known signals
4. **Log offset changes** for analysis
5. **Synchronize offsets** across multiple receivers

## Performance Considerations

- **Command latency**: Typically 0-100ms (polling interval)
- **Retune latency**: Depends on WebSocket round-trip time
- **CPU overhead**: Minimal (polling every 100ms)
- **Memory overhead**: ~2KB for command queue

## Future Enhancements

Possible future improvements:

1. **Event-based notification** instead of polling
2. **Command priority levels**
3. **Batch commands** for multiple receivers
4. **Offset history/undo**
5. **Automatic offset learning** from known signals

## See Also

- [`INI_CONFIGURATION.md`](INI_CONFIGURATION.md) - Global offset configuration
- [`UberSDRShared.h`](UberSDRShared.h) - Data structure definitions
- [`UberSDRShared.cpp`](UberSDRShared.cpp) - API implementation
- [`UberSDR.cpp`](UberSDR.cpp) - Command processing implementation
