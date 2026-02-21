// UberSDRShared.h - Shared memory structure for DLL status monitoring
#ifndef UBERSDR_SHARED_H
#define UBERSDR_SHARED_H

#include <stdint.h>

// Multi-instance support: Each DLL instance creates unique shared memory
// Format: UberSDRIntf_Status_v1_{ProcessID}
#define UBERSDR_SHARED_MEMORY_PREFIX L"UberSDRIntf_Status_v1"
#define UBERSDR_SHARED_MEMORY_NAME L"UberSDRIntf_Status_v1"  // Legacy name for backward compatibility

// Registry paths for instance tracking
#define UBERSDR_REGISTRY_ROOT L"Software\\UberSDR"
#define UBERSDR_REGISTRY_INSTANCES L"Software\\UberSDR\\Instances"

// Heartbeat interval (milliseconds)
#define UBERSDR_HEARTBEAT_INTERVAL 10000  // 10 seconds
#define UBERSDR_HEARTBEAT_TIMEOUT 30000   // 30 seconds (consider stale after this)

#define MAX_RX_COUNT 8
#define IQ_BUFFER_SIZE 384000  // Buffer for ~2 seconds at 192kHz (2 samples per I/Q pair)

// Command types for monitor-to-DLL communication
enum UberSDRCommandType {
    CMD_NONE = 0,
    CMD_SET_FREQUENCY_OFFSET = 1,  // Set per-receiver frequency offset
    CMD_APPLY_OFFSET = 2           // Apply offset and retune receiver
};

// Command structure for monitor-to-DLL communication
struct UberSDRCommand {
    volatile int32_t commandType;      // UberSDRCommandType
    volatile int32_t receiverID;       // Target receiver (0-7)
    volatile int32_t frequencyOffset;  // Frequency offset in Hz (can be negative)
    volatile int32_t sequenceNumber;   // Incremented for each command
    volatile int32_t acknowledged;     // Set to sequenceNumber by DLL when processed
    volatile int64_t timestamp;        // Command timestamp
};

// Shared status structure - updated by DLL, read by monitor
struct UberSDRSharedStatus {
    // Server information
    char serverHost[64];
    int serverPort;
    bool connected;
    
    // Audio configuration
    int sampleRate;
    char mode[16];
    int blockSize;
    
    // Receiver status
    struct ReceiverStatus {
        bool active;
        int frequency;
        char sessionId[40];
        int64_t samplesReceived;
        int64_t bytesReceived;
        int64_t lastUpdateTime;  // Unix timestamp in milliseconds
        float throughputKBps;    // Current throughput in KB/s
        float peakLevelI;        // Peak I level (0.0 to 1.0)
        float peakLevelQ;        // Peak Q level (0.0 to 1.0)
        
        // Ring buffer metrics
        float ringBufferFillLevel;  // Fill level (0.0 to 1.0)
        int ringBufferOverruns;     // Total overrun count
        int ringBufferUnderruns;    // Total underrun count
        int ringBufferCapacity;     // Buffer capacity in samples
        
        // Frequency offset control (per-receiver)
        volatile int32_t frequencyOffset;      // Per-receiver frequency offset in Hz (dynamic)
        volatile int32_t globalFrequencyOffset; // Global offset from INI file (read-only)
        volatile int32_t totalFrequencyOffset;  // Total offset (INI global + per-receiver)
        volatile int32_t requestedOffset;      // Requested offset from monitor
        volatile int32_t offsetApplied;        // Set to 1 when offset is applied
        
        // Circular buffer for IQ recording
        int16_t iqBuffer[IQ_BUFFER_SIZE];  // Interleaved I/Q samples (big-endian)
        volatile int32_t iqBufferWritePos;  // Current write position
        volatile int32_t iqBufferReadPos;   // Last read position (for monitor)
    } receivers[MAX_RX_COUNT];
    
    // Global statistics
    int64_t totalCallbacks;
    int64_t totalSamples;
    int64_t startTime;  // Unix timestamp in milliseconds
    int activeReceiverCount;
    
    // Status flags
    bool dllLoaded;
    bool rxStarted;
    int lastError;
    char lastErrorMsg[256];
    
    // Version info
    int structVersion;  // For future compatibility
    int64_t lastUpdateTime;  // Last time any field was updated
    
    // Multi-instance support
    DWORD processID;  // Process ID of the DLL instance
    
    // Command queue for monitor-to-DLL communication
    UberSDRCommand commandQueue[16];  // Ring buffer of commands
    volatile int32_t commandWritePos;  // Write position (monitor writes here)
    volatile int32_t commandReadPos;   // Read position (DLL reads here)
};

// Instance information structure (for monitor enumeration)
struct UberSDRInstanceInfo {
    DWORD processID;
    wchar_t serverHost[64];
    int serverPort;
    int64_t startTime;
    int64_t lastHeartbeat;
    wchar_t sharedMemoryName[128];
    bool isValid;  // Set to false if process no longer exists
};

// Helper functions for multi-instance support (implemented in UberSDRShared.cpp)
#ifdef __cplusplus
extern "C" {
#endif

// Get current time in milliseconds (Unix timestamp)
int64_t GetCurrentTimeMs();

// Build shared memory name for a given process ID
void BuildSharedMemoryName(DWORD processID, wchar_t* buffer, size_t bufferSize);

// Registry functions for instance tracking
BOOL RegisterInstance(DWORD processID, const char* serverHost, int serverPort, int64_t startTime);
BOOL UnregisterInstance(DWORD processID);
BOOL UpdateInstanceHeartbeat(DWORD processID);
int EnumerateInstances(UberSDRInstanceInfo* instances, int maxInstances);
void CleanupStaleInstances();

// Command functions for monitor-to-DLL communication
BOOL SendFrequencyOffsetCommand(UberSDRSharedStatus* pStatus, int receiverID, int frequencyOffset, BOOL applyImmediately);
BOOL WaitForCommandAck(UberSDRSharedStatus* pStatus, int32_t sequenceNumber, int timeoutMs);

#ifdef __cplusplus
}
#endif

#endif // UBERSDRSHARED_H