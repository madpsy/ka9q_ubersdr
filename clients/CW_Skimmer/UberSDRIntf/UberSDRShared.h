// UberSDRShared.h - Shared memory structure for DLL status monitoring
#ifndef UBERSDR_SHARED_H
#define UBERSDR_SHARED_H

#include <stdint.h>

#define UBERSDR_SHARED_MEMORY_NAME L"UberSDRIntf_Status_v1"
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
};

#endif // UBERSDRSHARED_H