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

// Helper functions for multi-instance support (implemented in UberSDRIntf.cpp)
#ifdef __cplusplus
extern "C" {
#endif

// Build shared memory name for a given process ID
void BuildSharedMemoryName(DWORD processID, wchar_t* buffer, size_t bufferSize);

// Registry functions for instance tracking
BOOL RegisterInstance(DWORD processID, const char* serverHost, int serverPort, int64_t startTime);
BOOL UnregisterInstance(DWORD processID);
BOOL UpdateInstanceHeartbeat(DWORD processID);
int EnumerateInstances(UberSDRInstanceInfo* instances, int maxInstances);
void CleanupStaleInstances();

#ifdef __cplusplus
}
#endif

#endif // UBERSDRSHARED_H