// UberSDRIntf.cpp : Defines the exported functions for the DLL application.

// Define this before including UberSDRIntf.h to export functions
#define UBERSDRINTF_EXPORTS

// Prevent winsock.h from being included (we use winsock2.h)
#define WIN32_LEAN_AND_MEAN
#define _WINSOCKAPI_

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string>
#include <sstream>
#include <time.h>
#include <vector>

// Now include our headers
#include "UberSDRIntf.h"
#include "UberSDR.h"
#include "UberSDRShared.h"

#pragma comment(lib, "ws2_32.lib")

namespace UberSDRIntf
{
    ///////////////////////////////////////////////////////////////////////////////
    // Global variables
    
    // Settings from Skimmer server
    SdrSettings gSet;
    
    // Sample rate of Skimmer server
    int gSampleRate = 0;
    
    // Length of block for one call of IQProc
    int gBlockInSamples = 0;
    
    // Buffers for calling IQProc
    CmplxA gData1[MAX_RX_COUNT];
    CmplxA gData2[MAX_RX_COUNT];
    
    // Current length of data in Buffers for calling IQProc (in samples)
    int gDataSamples[MAX_RX_COUNT] = { 0 };
    
    // Receiver synchronization - WAIT FOR ALL (like Hermes Protocol 2)
    int gRxMask = 0;        // Bitmask of active receivers
    int gRxFilled = 0;      // Bitmask of receivers with full buffers
    int gActiveReceivers = 0; // Number of active receivers
    
    // Double buffering state (like Hermes Protocol 2)
    Cmplx *gInPtr[MAX_RX_COUNT] = {NULL};
    Cmplx *gOutPtr[MAX_RX_COUNT] = {NULL};
    int gBucket[MAX_RX_COUNT] = {0};  // Per-receiver bucket state (0 or 1)
    
    // Critical section for thread-safe access to shared state
    CRITICAL_SECTION gDataCriticalSection;
    bool gCriticalSectionInitialized = false;
    
    // Instance of UberSDR
    UberSDR myUberSDR;
    
    // Handle & ID of worker threads
    DWORD gidWrk[MAX_RX_COUNT] = { 0 };
    HANDLE ghWrk[MAX_RX_COUNT] = { NULL };
    
    // Stop flag
    volatile bool gStopFlag = false;
    
    // Device name buffer
    char display_name[100];
    
    // WAV recording for debugging
    FILE* gWavFile[MAX_RX_COUNT] = { NULL };
    int gWavSamplesWritten[MAX_RX_COUNT] = { 0 };
    int gWavFrequency[MAX_RX_COUNT] = { 0 };
    const int WAV_RECORD_SECONDS = 10;
    
    // Shared memory for status monitoring
    HANDLE ghSharedMemory = NULL;
    UberSDRSharedStatus* gpSharedStatus = NULL;
    
    // Multi-instance support
    DWORD gProcessID = 0;
    wchar_t gSharedMemoryName[128] = {0};
    HANDLE ghHeartbeatThread = NULL;
    DWORD gidHeartbeatThread = 0;
    volatile bool gHeartbeatStopFlag = false;
    
    // Note: Registry functions (RegisterInstance, UnregisterInstance, UpdateInstanceHeartbeat)
    // and helper functions (GetCurrentTimeMs, BuildSharedMemoryName) are now in UberSDRShared.cpp
    // and used by both DLL and monitor. The namespace versions have been removed to avoid duplication.
    
    ///////////////////////////////////////////////////////////////////////////////
    // Heartbeat thread - updates registry every 10 seconds
    DWORD WINAPI HeartbeatThread(LPVOID lpParameter)
    {
        write_text_to_log_file("Heartbeat thread started");
        
        while (!gHeartbeatStopFlag)
        {
            Sleep(UBERSDR_HEARTBEAT_INTERVAL);
            
            if (!gHeartbeatStopFlag) {
                UpdateInstanceHeartbeat(gProcessID);
            }
        }
        
        write_text_to_log_file("Heartbeat thread stopped");
        return 0;
    }
    
    // Note: EnumerateInstances and CleanupStaleInstances are now in UberSDRShared.cpp
    
    ///////////////////////////////////////////////////////////////////////////////
    // Initialize shared memory
    BOOL InitSharedMemory()
    {
        // Initialize critical section first
        if (!gCriticalSectionInitialized) {
            InitializeCriticalSection(&gDataCriticalSection);
            gCriticalSectionInitialized = true;
            write_text_to_log_file("Critical section initialized");
        }
        
        // Clean up stale instances from previous crashes/exits
        // This ensures the registry doesn't accumulate dead entries even if monitor is never run
        CleanupStaleInstances();
        write_text_to_log_file("Cleaned up stale registry instances");
        
        // Get process ID for multi-instance support
        gProcessID = GetCurrentProcessId();
        
        // Build unique shared memory name
        BuildSharedMemoryName(gProcessID, gSharedMemoryName, 128);
        
        std::stringstream ss;
        ss << "Creating shared memory: " << std::string(gSharedMemoryName, gSharedMemoryName + wcslen(gSharedMemoryName));
        write_text_to_log_file(ss.str());
        
        ghSharedMemory = CreateFileMappingW(
            INVALID_HANDLE_VALUE,
            NULL,
            PAGE_READWRITE,
            0,
            sizeof(UberSDRSharedStatus),
            gSharedMemoryName);
        
        if (ghSharedMemory == NULL) {
            write_text_to_log_file("Failed to create shared memory");
            return FALSE;
        }
        
        gpSharedStatus = (UberSDRSharedStatus*)MapViewOfFile(
            ghSharedMemory,
            FILE_MAP_ALL_ACCESS,
            0, 0,
            sizeof(UberSDRSharedStatus));
        
        if (gpSharedStatus == NULL) {
            write_text_to_log_file("Failed to map shared memory");
            CloseHandle(ghSharedMemory);
            ghSharedMemory = NULL;
            return FALSE;
        }
        
        // Initialize structure
        ZeroMemory(gpSharedStatus, sizeof(UberSDRSharedStatus));
        gpSharedStatus->structVersion = 1;
        gpSharedStatus->dllLoaded = true;
        gpSharedStatus->startTime = ::GetCurrentTimeMs();
        gpSharedStatus->lastUpdateTime = ::GetCurrentTimeMs();
        gpSharedStatus->processID = gProcessID;
        
        // Initialize command queue
        gpSharedStatus->commandWritePos = 0;
        gpSharedStatus->commandReadPos = 0;
        
        // Copy server info
        strncpy_s(gpSharedStatus->serverHost, sizeof(gpSharedStatus->serverHost),
                  myUberSDR.serverHost.c_str(), _TRUNCATE);
        gpSharedStatus->serverPort = myUberSDR.serverPort;
        
        write_text_to_log_file("Shared memory initialized");
        
        // Register instance in registry
        if (RegisterInstance(gProcessID, myUberSDR.serverHost.c_str(),
                           myUberSDR.serverPort, gpSharedStatus->startTime)) {
            write_text_to_log_file("Instance registered in registry");
        } else {
            write_text_to_log_file("Warning: Failed to register instance in registry (non-fatal)");
        }
        
        // Start heartbeat thread
        gHeartbeatStopFlag = false;
        ghHeartbeatThread = CreateThread(NULL, 0, HeartbeatThread, NULL, 0, &gidHeartbeatThread);
        if (ghHeartbeatThread == NULL) {
            write_text_to_log_file("Warning: Failed to start heartbeat thread (non-fatal)");
        } else {
            write_text_to_log_file("Heartbeat thread started");
        }
        
        return TRUE;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Cleanup shared memory
    void CleanupSharedMemory()
    {
        // Stop heartbeat thread
        if (ghHeartbeatThread != NULL) {
            write_text_to_log_file("Stopping heartbeat thread...");
            gHeartbeatStopFlag = true;
            WaitForSingleObject(ghHeartbeatThread, 2000);  // Wait up to 2 seconds
            CloseHandle(ghHeartbeatThread);
            ghHeartbeatThread = NULL;
            write_text_to_log_file("Heartbeat thread stopped");
        }
        
        // Unregister instance from registry
        if (gProcessID != 0) {
            if (UnregisterInstance(gProcessID)) {
                write_text_to_log_file("Instance unregistered from registry");
            } else {
                write_text_to_log_file("Warning: Failed to unregister instance from registry");
            }
        }
        
        if (gpSharedStatus != NULL) {
            gpSharedStatus->dllLoaded = false;
            gpSharedStatus->lastUpdateTime = ::GetCurrentTimeMs();
            UnmapViewOfFile(gpSharedStatus);
            gpSharedStatus = NULL;
        }
        
        if (ghSharedMemory != NULL) {
            CloseHandle(ghSharedMemory);
            ghSharedMemory = NULL;
        }
        
        // Cleanup critical section
        if (gCriticalSectionInitialized) {
            DeleteCriticalSection(&gDataCriticalSection);
            gCriticalSectionInitialized = false;
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Update shared memory status
    void UpdateSharedStatus()
    {
        if (gpSharedStatus == NULL) return;
        
        gpSharedStatus->connected = myUberSDR.activeReceivers > 0;
        gpSharedStatus->sampleRate = gSampleRate;
        strncpy_s(gpSharedStatus->mode, sizeof(gpSharedStatus->mode),
                  myUberSDR.iqMode.c_str(), _TRUNCATE);
        gpSharedStatus->blockSize = gBlockInSamples;
        gpSharedStatus->rxStarted = (gSet.RecvCount > 0);
        gpSharedStatus->activeReceiverCount = myUberSDR.activeReceivers;
        gpSharedStatus->lastUpdateTime = ::GetCurrentTimeMs();
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Allocate working buffers
    BOOL Alloc(void)
    {
        int i;
        
        // Free existing buffers
        for (i = 0; i < MAX_RX_COUNT; i++)
        {
            if (gData1[i] != NULL) {
                _aligned_free(gData1[i]);
                gData1[i] = NULL;
            }
            if (gData2[i] != NULL) {
                _aligned_free(gData2[i]);
                gData2[i] = NULL;
            }
        }
        
        // Decode sample rate
        if (gSet.RateID == RATE_48KHZ) {
            gSampleRate = 48000;
        } else if (gSet.RateID == RATE_96KHZ) {
            gSampleRate = 96000;
        } else if (gSet.RateID == RATE_192KHZ) {
            gSampleRate = 192000;
        } else {
            rt_exception("Unknown sample rate");
            return FALSE;
        }
        
        // Compute length of block in samples
        gBlockInSamples = (int)((float)gSampleRate / (float)BLOCKS_PER_SEC);
        
        std::stringstream ss;
        ss << "Allocating buffers: " << gSampleRate << " Hz, " 
           << gBlockInSamples << " samples per block";
        write_text_to_log_file(ss.str());
        
        // Allocate buffers for calling IQProc
        for (i = 0; i < MAX_RX_COUNT; i++)
        {
            gData1[i] = (CmplxA)_aligned_malloc(gBlockInSamples * sizeof(Cmplx), 16);
            gData2[i] = (CmplxA)_aligned_malloc(gBlockInSamples * sizeof(Cmplx), 16);
            
            if (gData1[i] == NULL || gData2[i] == NULL)
            {
                rt_exception("Low memory");
                return FALSE;
            }
            
            memset(gData1[i], 0, gBlockInSamples * sizeof(Cmplx));
            memset(gData2[i], 0, gBlockInSamples * sizeof(Cmplx));
            gDataSamples[i] = 0;
        }
        
        write_text_to_log_file("Buffer allocation successful");
        return TRUE;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Worker thread for each receiver
    DWORD WINAPI Worker(LPVOID lpParameter)
    {
        int receiverID = (int)(INT_PTR)lpParameter;
        
        std::stringstream ss;
        ss << "Worker thread started for receiver " << receiverID;
        write_text_to_log_file(ss.str());
        
        // WebSocket message processing happens in the WebSocket thread
        // This thread manages the receiver state and processes commands
        while (!gStopFlag && myUberSDR.receivers[receiverID].active)
        {
            // Process commands from monitor every 100ms
            if (receiverID == 0) {  // Only process commands once (from receiver 0's thread)
                myUberSDR.ProcessCommands(gpSharedStatus);
            }
            Sleep(100);
        }
        
        ss.str("");
        ss << "Worker thread stopped for receiver " << receiverID;
        write_text_to_log_file(ss.str());
        
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Write WAV header
    void WriteWavHeader(FILE* file, int sampleRate, int numChannels)
    {
        // WAV header for 32-bit float stereo IQ data
        uint32_t dataSize = 0; // Will be updated when closing
        uint32_t fileSize = 36 + dataSize;
        
        // RIFF header
        fwrite("RIFF", 1, 4, file);
        fwrite(&fileSize, 4, 1, file);
        fwrite("WAVE", 1, 4, file);
        
        // fmt chunk
        fwrite("fmt ", 1, 4, file);
        uint32_t fmtSize = 16;
        fwrite(&fmtSize, 4, 1, file);
        uint16_t audioFormat = 3; // IEEE float
        fwrite(&audioFormat, 2, 1, file);
        uint16_t channels = numChannels;
        fwrite(&channels, 2, 1, file);
        uint32_t sampleRateVal = sampleRate;
        fwrite(&sampleRateVal, 4, 1, file);
        uint32_t byteRate = sampleRate * numChannels * 4; // 4 bytes per float sample
        fwrite(&byteRate, 4, 1, file);
        uint16_t blockAlign = numChannels * 4;
        fwrite(&blockAlign, 2, 1, file);
        uint16_t bitsPerSample = 32;
        fwrite(&bitsPerSample, 2, 1, file);
        
        // data chunk
        fwrite("data", 1, 4, file);
        fwrite(&dataSize, 4, 1, file);
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Update WAV header with actual data size
    void UpdateWavHeader(FILE* file, int numSamples, int numChannels)
    {
        uint32_t dataSize = numSamples * numChannels * 4; // 4 bytes per float
        uint32_t fileSize = 36 + dataSize;
        
        fseek(file, 4, SEEK_SET);
        fwrite(&fileSize, 4, 1, file);
        
        fseek(file, 40, SEEK_SET);
        fwrite(&dataSize, 4, 1, file);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Track compressed bytes received (called from UberSDR.cpp before decompression)
// This provides accurate network bandwidth measurement
void TrackCompressedBytes(int receiverID, size_t compressedBytes)
{
    using namespace UberSDRIntf;
    
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
        return;
    }
    
    // Track compressed bytes for network bandwidth calculation
    static int64_t compressedBytesReceived[MAX_RX_COUNT] = {0};
    static int64_t lastCompressedBytesReceived[MAX_RX_COUNT] = {0};
    static int64_t lastCompressedThroughputUpdate[MAX_RX_COUNT] = {0};
    
    compressedBytesReceived[receiverID] += compressedBytes;
    
    // Update compressed throughput every second
    int64_t now = GetCurrentTimeMs();
    if (now - lastCompressedThroughputUpdate[receiverID] >= 1000) {
        if (gpSharedStatus != NULL && receiverID < MAX_RX_COUNT) {
            int64_t bytesDelta = compressedBytesReceived[receiverID] - lastCompressedBytesReceived[receiverID];
            float elapsed = (float)(now - lastCompressedThroughputUpdate[receiverID]) / 1000.0f;
            
            // Store compressed throughput in bytesReceived field (repurposing for network bandwidth)
            gpSharedStatus->receivers[receiverID].bytesReceived = compressedBytesReceived[receiverID];
            gpSharedStatus->receivers[receiverID].throughputKBps = (float)bytesDelta / 1024.0f / elapsed;
            
            lastCompressedBytesReceived[receiverID] = compressedBytesReceived[receiverID];
        }
        lastCompressedThroughputUpdate[receiverID] = now;
    }
}

///////////////////////////////////////////////////////////////////////////////
// Process IQ data from WebSocket (called from UberSDR.cpp)
// This must be outside the namespace to be accessible
void ProcessIQData(int receiverID, const std::vector<uint8_t>& iqBytes)
{
    using namespace UberSDRIntf;
    
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
        return;
    }
    
    // Critical section is initialized in InitSharedMemory() during DLL load
    
    // Track peak levels for audio meters (per-receiver, thread-local via static)
    static float peakI[MAX_RX_COUNT] = {0};
    static float peakQ[MAX_RX_COUNT] = {0};
    static int64_t lastPeakUpdate[MAX_RX_COUNT] = {0};
    
    // Note: Compressed bytes are now tracked in TrackCompressedBytes() called from HandleWebSocketMessage
    // This gives us accurate network bandwidth instead of decompressed data size
    
    // Check if it's time to update peak levels (every 100ms)
    int64_t now = GetCurrentTimeMs();
    if (now - lastPeakUpdate[receiverID] >= 100) {
        // Update peak levels in shared memory
        if (gpSharedStatus != NULL && receiverID < MAX_RX_COUNT) {
            gpSharedStatus->receivers[receiverID].peakLevelI = peakI[receiverID];
            gpSharedStatus->receivers[receiverID].peakLevelQ = peakQ[receiverID];
        }
        
        // Decay peaks for next period
        peakI[receiverID] *= 0.7f;
        peakQ[receiverID] *= 0.7f;
        lastPeakUpdate[receiverID] = now;
    }
    
    // IQ data format: interleaved I/Q samples, big-endian int16
    // Each sample: 2 bytes I + 2 bytes Q = 4 bytes total
    int numSamples = iqBytes.size() / 4;
    
    for (int i = 0; i < numSamples; i++)
    {
        // Extract big-endian int16 I and Q
        int16_t I = (int16_t)((iqBytes[i*4] << 8) | iqBytes[i*4+1]);
        int16_t Q = (int16_t)((iqBytes[i*4+2] << 8) | iqBytes[i*4+3]);
        
        // Track peak levels (normalize to 0.0-1.0 range)
        float absI = (float)abs(I) / 32768.0f;
        float absQ = (float)abs(Q) / 32768.0f;
        if (absI > peakI[receiverID]) peakI[receiverID] = absI;
        if (absQ > peakQ[receiverID]) peakQ[receiverID] = absQ;
        
        // Store in circular buffer for recording (outside critical section)
        if (gpSharedStatus != NULL) {
            int32_t writePos = gpSharedStatus->receivers[receiverID].iqBufferWritePos;
            gpSharedStatus->receivers[receiverID].iqBuffer[writePos] = I;
            gpSharedStatus->receivers[receiverID].iqBuffer[writePos + 1] = Q;
            writePos = (writePos + 2) % IQ_BUFFER_SIZE;
            gpSharedStatus->receivers[receiverID].iqBufferWritePos = writePos;
        }
        
        // Build 32-bit values directly from bytes (like Hermes does)
        // This avoids sign extension issues when shifting int16_t values
        // Hermes puts 24-bit samples in bits [31:8], we put 16-bit samples in bits [31:16]
        
        int32_t I_32, Q_32;
        
        if (myUberSDR.swapIQ) {
            // Swap I and Q for correct sideband orientation in CW Skimmer (default behavior)
            I_32 = ((int32_t)iqBytes[i*4+2] << 24) | ((int32_t)iqBytes[i*4+3] << 16);  // Read Q as I, bits [31:16]
            Q_32 = ((int32_t)iqBytes[i*4] << 24) | ((int32_t)iqBytes[i*4+1] << 16);    // Read I as Q, bits [31:16]
        } else {
            // No swap - read I as I, Q as Q
            I_32 = ((int32_t)iqBytes[i*4] << 24) | ((int32_t)iqBytes[i*4+1] << 16);    // Read I as I, bits [31:16]
            Q_32 = ((int32_t)iqBytes[i*4+2] << 24) | ((int32_t)iqBytes[i*4+3] << 16);  // Read Q as Q, bits [31:16]
        }
        
        // Normalize to proper range and negate Q to match Hermes (Im = -Q)
        // Divide by 2^31 to get ±1.0 range (same as WAV file normalization)
        float I_float = (float)I_32 / 2147483648.0f;
        float Q_float = (float)-Q_32 / 2147483648.0f;
        
        // RING BUFFER: Write to ring buffer instead of directly to gInPtr
        // This decouples async WebSocket reception from sync processing
        if (!myUberSDR.receivers[receiverID].ringBuffer.write(I_float, Q_float)) {
            // Buffer overrun - silently drop samples
            // (Logging removed to reduce log verbosity)
        }
        
        // Write to WAV file if recording (first 10 seconds)
        if (gWavFile[receiverID] != NULL && gWavSamplesWritten[receiverID] < (gSampleRate * WAV_RECORD_SECONDS))
        {
            // Write as stereo float: I (left), Q (right)
            // Values are already normalized to ±1.0 range
            fwrite(&I_float, sizeof(float), 1, gWavFile[receiverID]);
            fwrite(&Q_float, sizeof(float), 1, gWavFile[receiverID]);
            gWavSamplesWritten[receiverID]++;
            
            // Close file after 10 seconds
            if (gWavSamplesWritten[receiverID] >= (gSampleRate * WAV_RECORD_SECONDS))
            {
                UpdateWavHeader(gWavFile[receiverID], gWavSamplesWritten[receiverID], 2);
                fclose(gWavFile[receiverID]);
                gWavFile[receiverID] = NULL;
                
                std::stringstream ss;
                ss << "WAV recording completed for receiver " << receiverID
                   << " (" << gWavSamplesWritten[receiverID] << " samples)";
                write_text_to_log_file(ss.str());
            }
        }
        
        // Update shared memory sample count (for received samples, not processed)
        if (gpSharedStatus != NULL && receiverID < MAX_RX_COUNT) {
            gpSharedStatus->receivers[receiverID].samplesReceived++;
            gpSharedStatus->receivers[receiverID].lastUpdateTime = ::GetCurrentTimeMs();
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// Ring buffer consumer - reads from ring buffers and fills processing buffers
// This runs in a separate thread to provide consistent timing
// HIGH-RESOLUTION TIMING: Uses QueryPerformanceCounter for precise sample timing
void ConsumeRingBuffers()
{
    using namespace UberSDRIntf;
    
    // High-resolution timing setup
    LARGE_INTEGER frequency, startTime, currentTime;
    QueryPerformanceFrequency(&frequency);
    int64_t samplesProcessed = 0;
    bool timingInitialized = false;
    
    std::stringstream ss;
    ss << "Ring buffer consumer: High-resolution timing enabled (frequency: "
       << frequency.QuadPart << " Hz)";
    write_text_to_log_file(ss.str());
    
    while (!gStopFlag)
    {
        // Check if we have active receivers
        if (gActiveReceivers == 0) {
            Sleep(10);
            timingInitialized = false;
            samplesProcessed = 0;
            continue;
        }
        
        // Initialize timing on first sample
        if (!timingInitialized) {
            QueryPerformanceCounter(&startTime);
            samplesProcessed = 0;
            timingInitialized = true;
            
            ss.str("");
            ss << "Ring buffer consumer: Timing initialized at sample rate " << gSampleRate << " Hz";
            write_text_to_log_file(ss.str());
        }
        
        // Calculate target time for this sample (in performance counter ticks)
        // Target = startTime + (samplesProcessed * ticksPerSecond / sampleRate)
        int64_t targetTicks = startTime.QuadPart +
            ((samplesProcessed * frequency.QuadPart) / gSampleRate);
        
        // Try to read one sample from each active receiver's ring buffer
        bool anyBufferEmpty = false;
        
        for (int receiverID = 0; receiverID < gSet.RecvCount; receiverID++)
        {
            if (!myUberSDR.receivers[receiverID].active) {
                continue;
            }
            
            float I_float, Q_float;
            if (!myUberSDR.receivers[receiverID].ringBuffer.read(I_float, Q_float)) {
                // Buffer underrun - mark that at least one buffer is empty
                anyBufferEmpty = true;
                
                // Fill with zeros (silence) and continue
                // This prevents one slow receiver from holding up all others
                I_float = 0.0f;
                Q_float = 0.0f;
                
                // Buffer underrun - silently fill with zeros
                // (Logging removed to reduce log verbosity)
            }
            
            // SOFTWARE FREQUENCY SHIFT: Apply frequency offset in IQ domain
            // This shifts the spectrum without retuning the radio
            // Complex multiply: (I + jQ) * e^(j*phase) = (I + jQ) * (cos + j*sin)
            float shifted_I = I_float;
            float shifted_Q = Q_float;
            
            EnterCriticalSection(&myUberSDR.receivers[receiverID].lock);
            double phaseIncrement = myUberSDR.receivers[receiverID].phaseIncrement;
            
            if (phaseIncrement != 0.0) {
                // Get current phase
                double phase = myUberSDR.receivers[receiverID].phaseAccumulator;
                
                // Calculate sin/cos for this phase
                double cosPhase = cos(phase);
                double sinPhase = sin(phase);
                
                // Complex multiply: (I + jQ) * (cos + j*sin)
                // Real part: I*cos - Q*sin
                // Imag part: I*sin + Q*cos
                shifted_I = (float)(I_float * cosPhase - Q_float * sinPhase);
                shifted_Q = (float)(I_float * sinPhase + Q_float * cosPhase);
                
                // Increment phase and wrap to avoid precision loss
                phase += phaseIncrement;
                if (phase > 2.0 * 3.14159265358979323846) {
                    phase -= 2.0 * 3.14159265358979323846;
                } else if (phase < -2.0 * 3.14159265358979323846) {
                    phase += 2.0 * 3.14159265358979323846;
                }
                myUberSDR.receivers[receiverID].phaseAccumulator = phase;
            }
            LeaveCriticalSection(&myUberSDR.receivers[receiverID].lock);
            
            // Write to WAV file if recording (first 10 seconds)
            // NOTE: WAV file gets ORIGINAL (unshifted) IQ data for debugging
            if (gWavFile[receiverID] != NULL && gWavSamplesWritten[receiverID] < (gSampleRate * WAV_RECORD_SECONDS))
            {
                // Write as stereo float: I (left), Q (right)
                fwrite(&I_float, sizeof(float), 1, gWavFile[receiverID]);
                fwrite(&Q_float, sizeof(float), 1, gWavFile[receiverID]);
                gWavSamplesWritten[receiverID]++;
                
                // Close file after 10 seconds
                if (gWavSamplesWritten[receiverID] >= (gSampleRate * WAV_RECORD_SECONDS))
                {
                    UpdateWavHeader(gWavFile[receiverID], gWavSamplesWritten[receiverID], 2);
                    fclose(gWavFile[receiverID]);
                    gWavFile[receiverID] = NULL;
                    
                    std::stringstream ss;
                    ss << "WAV recording completed for receiver " << receiverID
                       << " (" << gWavSamplesWritten[receiverID] << " samples)";
                    write_text_to_log_file(ss.str());
                }
            }
            
            // Write SHIFTED samples to processing buffer (Skimmer Server gets shifted IQ)
            gInPtr[receiverID]->Re = shifted_I;
            gInPtr[receiverID]->Im = shifted_Q;
            (gInPtr[receiverID])++;
            
            gDataSamples[receiverID]++;
            
            // Check if THIS receiver's buffer is full
            if (gDataSamples[receiverID] >= gBlockInSamples)
        {
            // Track timing for diagnostics
            static int64_t lastBufferFillTime[MAX_RX_COUNT] = {0};
            int64_t bufferFillTime = GetCurrentTimeMs();
            int64_t timeSinceLastFill = bufferFillTime - lastBufferFillTime[receiverID];
            lastBufferFillTime[receiverID] = bufferFillTime;
            
            // CRITICAL: Enter critical section for ALL buffer management
            // This ensures atomic buffer switching and prevents race conditions
            int64_t lockWaitStart = ::GetCurrentTimeMs();
            EnterCriticalSection(&gDataCriticalSection);
            int64_t lockWaitTime = ::GetCurrentTimeMs() - lockWaitStart;
            
            // MATCH HERMES EXACTLY: Check if not already filled, then mark and toggle
            // This prevents double-toggling when a receiver fills again before callback
            int myBit = (1 << receiverID);
            if (!(gRxFilled & myBit))
            {
                gRxFilled |= myBit;
                gBucket[receiverID] ^= 1;  // Toggle bucket for THIS receiver
            }
            
            // Double buffer switch (INSIDE lock to ensure atomicity with gOutPtr)
            // This is critical - gOutPtr must be consistent when callback is made
            if (gBucket[receiverID] & 1)
            {
                gInPtr[receiverID] = gData2[receiverID];   // Switch input to gData2
                gOutPtr[receiverID] = gData1[receiverID];  // Output from gData1
            }
            else
            {
                gInPtr[receiverID] = gData1[receiverID];   // Switch input to gData1
                gOutPtr[receiverID] = gData2[receiverID];  // Output from gData2
            }
            gDataSamples[receiverID] = 0;
            
            // Lock wait time tracking (logging removed to reduce verbosity)
            
            // Check if all receivers are ready and make callback if so
            if (gRxFilled == gRxMask)
            {
                // Update shared memory callback count
                if (gpSharedStatus != NULL) {
                    gpSharedStatus->totalCallbacks++;
                    gpSharedStatus->totalSamples += gBlockInSamples;
                }
                
                // Log first few callbacks for debugging
                static int callCount = 0;
                if (callCount < 10) {
                    std::stringstream ss;
                    ss << "Calling pIQProc #" << callCount << ": " << gBlockInSamples << " samples @ " << gSampleRate << " Hz, "
                       << gSet.RecvCount << " receivers. Rx0: I=" << gOutPtr[0][0].Re << ", Q=" << gOutPtr[0][0].Im;
                    if (gSet.RecvCount > 1) {
                        ss << ", Rx1: I=" << gOutPtr[1][0].Re << ", Q=" << gOutPtr[1][0].Im;
                    }
                    write_text_to_log_file(ss.str());
                    callCount++;
                }
                
                // Periodic status update every 10 seconds (logging removed, metrics still tracked)
                static int64_t lastStatusLog = 0;
                int64_t now = GetCurrentTimeMs();
                if (now - lastStatusLog >= 10000) {
                    // Update ring buffer metrics in shared memory (without logging)
                    for (int i = 0; i < gSet.RecvCount; i++) {
                        if (myUberSDR.receivers[i].active && gpSharedStatus) {
                            float fillLevel = myUberSDR.receivers[i].ringBuffer.fillLevel();
                            int overruns = myUberSDR.receivers[i].ringBuffer.overrunCount;
                            int underruns = myUberSDR.receivers[i].ringBuffer.underrunCount;
                            
                            gpSharedStatus->receivers[i].ringBufferFillLevel = fillLevel;
                            gpSharedStatus->receivers[i].ringBufferOverruns = overruns;
                            gpSharedStatus->receivers[i].ringBufferUnderruns = underruns;
                            gpSharedStatus->receivers[i].ringBufferCapacity = (int)myUberSDR.receivers[i].ringBuffer.capacity;
                        }
                    }
                    lastStatusLog = now;
                }
                
                // Pass output pointers (like Hermes Protocol 2)
                if (gSet.pIQProc != NULL) {
                    (*gSet.pIQProc)(gSet.THandle, gOutPtr);
                }
                
                // Reset filled mask for next round
                gRxFilled = 0;
            }
            // Receiver waiting for others (logging removed to reduce verbosity)
            
            LeaveCriticalSection(&gDataCriticalSection);
        }
        }
        
        // Increment sample counter
        samplesProcessed++;
        
        // HIGH-RESOLUTION TIMING: Wait until target time for this sample
        // This ensures precise sample rate regardless of processing variations
        QueryPerformanceCounter(&currentTime);
        int64_t ticksRemaining = targetTicks - currentTime.QuadPart;
        
        if (ticksRemaining > 0) {
            // Calculate microseconds remaining
            int64_t usRemaining = (ticksRemaining * 1000000) / frequency.QuadPart;
            
            // If more than 1ms away, sleep to yield CPU
            if (usRemaining > 1000) {
                Sleep(1);
            }
            
            // Busy-wait for final precision (last ~1ms)
            while (currentTime.QuadPart < targetTicks) {
                // Yield CPU if still >100us away
                if ((targetTicks - currentTime.QuadPart) * 1000000 / frequency.QuadPart > 100) {
                    Sleep(0);  // Yield to other threads
                }
                QueryPerformanceCounter(&currentTime);
            }
        } else if (ticksRemaining < -frequency.QuadPart / 100) {
            // More than 10ms behind - we're falling behind, log warning once per second
            static int64_t lastWarning = 0;
            int64_t now = GetCurrentTimeMs();
            if (now - lastWarning > 1000) {
                int64_t usBehind = (-ticksRemaining * 1000000) / frequency.QuadPart;
                std::stringstream ss;
                ss << "WARNING: Ring buffer consumer falling behind by " << usBehind << " us";
                write_text_to_log_file(ss.str());
                lastWarning = now;
            }
        }
    }
    
    write_text_to_log_file("Ring buffer consumer: High-resolution timing stopped");
}

///////////////////////////////////////////////////////////////////////////////
// Ring buffer consumer thread
DWORD WINAPI RingBufferConsumerThread(LPVOID lpParameter)
{
    using namespace UberSDRIntf;
    write_text_to_log_file("Ring buffer consumer thread started");
    ConsumeRingBuffers();
    write_text_to_log_file("Ring buffer consumer thread stopped");
    return 0;
}

namespace UberSDRIntf
{
    // Ring buffer consumer thread handle
    HANDLE ghRingBufferConsumer = NULL;
    DWORD gidRingBufferConsumer = 0;
    ///////////////////////////////////////////////////////////////////////////////
    // Keepalive thread - sends ping every 30 seconds
    DWORD WINAPI KeepaliveThread(LPVOID lpParameter)
    {
        write_text_to_log_file("Keepalive thread started");
        
        while (!gStopFlag)
        {
            Sleep(30000); // 30 seconds
            
            if (!gStopFlag) {
                // Send ping to all active receivers
                for (int i = 0; i < MAX_RX_COUNT; i++)
                {
                    if (myUberSDR.receivers[i].active) {
                        myUberSDR.SendKeepalive(i);
                    }
                }
            }
        }
        
        write_text_to_log_file("Keepalive thread stopped");
        return 0;
    }
    
    // Keepalive thread handle
    HANDLE ghKeepalive = NULL;
    DWORD gidKeepalive = 0;
    
}

///////////////////////////////////////////////////////////////////////////////
// DllMain function - MUST be outside namespace!
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved)
{
    using namespace UberSDRIntf;
    
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        for (int i = 0; i < MAX_RX_COUNT; i++)
        {
            gData1[i] = NULL;
            gData2[i] = NULL;
        }
        write_text_to_log_file("=== UberSDRIntf DLL Loaded ===");
        InitSharedMemory();
        break;
        
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
        break;
        
    case DLL_PROCESS_DETACH:
        write_text_to_log_file("=== UberSDRIntf DLL Unloaded ===");
        CleanupSharedMemory();
        break;
    }
    
    return TRUE;
}

namespace UberSDRIntf
{
    ///////////////////////////////////////////////////////////////////////////////
    // Exported API functions
    
    extern "C"
    {
        UBERSDRINTF_API void __stdcall GetSdrInfo(PSdrInfo pInfo)
        {
            try {
                std::stringstream ss;
                ss << "GetSdrInfo called with pInfo=" << (void*)pInfo;
                write_text_to_log_file(ss.str());
                
                if (pInfo == NULL) {
                    write_text_to_log_file("GetSdrInfo: pInfo is NULL!");
                    return;
                }
                
                // Connect to server to get capabilities
                if (myUberSDR.Connect(myUberSDR.serverHost, myUberSDR.serverPort, false) == 0)
                {
                    if (myUberSDR.configFromFilename) {
                        sprintf_s(display_name, sizeof(display_name), "UberSDR-%s:%d",
                                myUberSDR.serverHost.c_str(),
                                myUberSDR.serverPort);
                    } else {
                        sprintf_s(display_name, sizeof(display_name), "UberSDR-IQ192");
                    }
                    
                    pInfo->DeviceName = display_name;
                    pInfo->MaxRecvCount = 8;  // Support up to 8 IQ streams
                    pInfo->ExactRates[RATE_48KHZ] = 48000.0f;
                    pInfo->ExactRates[RATE_96KHZ] = 96000.0f;
                    pInfo->ExactRates[RATE_192KHZ] = 192000.0f;
                    
                    std::stringstream ss;
                    ss << "Connected to UberSDR server at "
                       << myUberSDR.serverHost << ":" << myUberSDR.serverPort;
                    write_text_to_log_file(ss.str());
                }
                else
                {
                    pInfo->DeviceName = "UberSDR (disconnected)";
                    pInfo->MaxRecvCount = 0;
                    
                    std::stringstream ss;
                    ss << "Failed to connect to "
                       << myUberSDR.serverHost << ":" << myUberSDR.serverPort;
                    write_text_to_log_file(ss.str());
                }
            }
            catch (const std::exception& e) {
                std::stringstream ss;
                ss << "Exception in GetSdrInfo: " << e.what();
                write_text_to_log_file(ss.str());
                if (pInfo != NULL) {
                    pInfo->DeviceName = "UberSDR (error)";
                    pInfo->MaxRecvCount = 0;
                }
            }
            catch (...) {
                write_text_to_log_file("Unknown exception in GetSdrInfo");
                if (pInfo != NULL) {
                    pInfo->DeviceName = "UberSDR (error)";
                    pInfo->MaxRecvCount = 0;
                }
            }
        }
        
        UBERSDRINTF_API void __stdcall StartRx(PSdrSettings pSettings)
        {
            write_text_to_log_file(">>> StartRx CALLED <<<");
            std::stringstream ss;
            ss << "StartRx entry: sizeof(SdrSettings)=" << sizeof(SdrSettings)
               << ", pSettings=" << (void*)pSettings;
            write_text_to_log_file(ss.str());
            
            if (pSettings == NULL) {
                write_text_to_log_file("StartRx: pSettings is NULL!");
                return;
            }
            
            // Make a copy of SDR settings
            memcpy(&gSet, pSettings, sizeof(gSet));
            
            // From skimmer server version 1.1 in high bytes is something strange
            gSet.RateID &= 0xFF;
            
            ss.str("");
            ss << "StartRx: " << gSet.RecvCount << " receivers at ";
            if (gSet.RateID == RATE_48KHZ) ss << "48";
            else if (gSet.RateID == RATE_96KHZ) ss << "96";
            else if (gSet.RateID == RATE_192KHZ) ss << "192";
            ss << " kHz";
            write_text_to_log_file(ss.str());
            
            // MATCH HERMES: Always allocate buffers, even with RecvCount=0
            // Hermes calls Alloc() regardless of RecvCount
            if (!Alloc())
            {
                rt_exception("Failed to allocate buffers");
                return;
            }
            
            // MATCH HERMES: Start worker thread(s) even with RecvCount=0
            // Hermes creates its worker thread regardless of RecvCount
            gStopFlag = false;
            
            // Only start actual receivers if RecvCount > 0
            if (gSet.RecvCount > 0)
            {
                // Initialize receiver synchronization masks (like Hermes Protocol 2)
                EnterCriticalSection(&gDataCriticalSection);
                gRxMask = 0;
                gRxFilled = 0;
                gActiveReceivers = gSet.RecvCount;
                for (int i = 0; i < gSet.RecvCount; i++)
                {
                    gRxMask |= (1 << i);  // Set bit for each active receiver
                    gDataSamples[i] = 0;
                    gBucket[i] = 0;  // Reset per-receiver bucket state
                    // Reset buffer pointers
                    gInPtr[i] = gData1[i];
                    gOutPtr[i] = gData1[i];
                }
                LeaveCriticalSection(&gDataCriticalSection);
                
                ss.str("");
                ss << "Initialized " << gSet.RecvCount << " receivers with mask 0x"
                   << std::hex << gRxMask << std::dec;
                write_text_to_log_file(ss.str());
                
                // Determine IQ mode based on sample rate
                std::string iqMode;
                if (gSet.RateID == RATE_48KHZ) iqMode = "iq48";
                else if (gSet.RateID == RATE_96KHZ) iqMode = "iq96";
                else if (gSet.RateID == RATE_192KHZ) iqMode = "iq192";
                
                myUberSDR.iqMode = iqMode;
                myUberSDR.sampleRate = gSampleRate;
                
                ss.str("");
                ss << "Using IQ mode: " << iqMode;
                write_text_to_log_file(ss.str());
                
                // Start worker threads for each receiver
                for (int i = 0; i < gSet.RecvCount; i++)
                {
                    // Start receiver with default frequency (will be set by SetRxFrequency)
                    int result = myUberSDR.StartReceiver(i, 14074000, iqMode);
                    if (result != 0)
                    {
                        ss.str("");
                        ss << "Failed to start receiver " << i;
                        rt_exception(ss.str());
                        continue;
                    }
                    
                    // Initialize phase increment for software frequency shift
                    // Use INI global offset as initial offset
                    // NEGATE phase increment: positive offset shifts spectrum DOWN
                    double totalOffset = (double)myUberSDR.frequencyOffset;
                    double phaseInc = -2.0 * 3.14159265358979323846 * totalOffset / (double)gSampleRate;
                    
                    EnterCriticalSection(&myUberSDR.receivers[i].lock);
                    myUberSDR.receivers[i].phaseIncrement = phaseInc;
                    myUberSDR.receivers[i].phaseAccumulator = 0.0;
                    LeaveCriticalSection(&myUberSDR.receivers[i].lock);
                    
                    // Update shared memory for this receiver
                    if (gpSharedStatus != NULL) {
                        gpSharedStatus->receivers[i].active = true;
                        gpSharedStatus->receivers[i].frequency = 14074000;
                        gpSharedStatus->receivers[i].frequencyOffset = 0;  // Initialize per-receiver offset
                        gpSharedStatus->receivers[i].globalFrequencyOffset = myUberSDR.frequencyOffset;  // INI offset
                        gpSharedStatus->receivers[i].totalFrequencyOffset = myUberSDR.frequencyOffset;  // INI offset (software shift)
                        gpSharedStatus->receivers[i].requestedOffset = 0;
                        gpSharedStatus->receivers[i].offsetApplied = 0;
                        strncpy_s(gpSharedStatus->receivers[i].sessionId,
                                  sizeof(gpSharedStatus->receivers[i].sessionId),
                                  myUberSDR.receivers[i].sessionId.c_str(), _TRUNCATE);
                    }
                    
                    // Start worker thread
                    ghWrk[i] = CreateThread(NULL, 0, Worker, (LPVOID)(INT_PTR)i, 0, &gidWrk[i]);
                    if (ghWrk[i] == NULL)
                    {
                        ss.str("");
                        ss << "Failed to start worker thread for receiver " << i;
                        rt_exception(ss.str());
                    }
                }
                
                // Start ring buffer consumer thread
                write_text_to_log_file("Starting ring buffer consumer thread...");
                ghRingBufferConsumer = CreateThread(NULL, 0, RingBufferConsumerThread, NULL, 0, &gidRingBufferConsumer);
                if (ghRingBufferConsumer == NULL)
                {
                    rt_exception("Failed to start ring buffer consumer thread");
                }
                else
                {
                    write_text_to_log_file("Ring buffer consumer thread started successfully");
                }
                
                write_text_to_log_file("All receivers started");
                UpdateSharedStatus();
            }
            else
            {
                write_text_to_log_file("StartRx: RecvCount is 0 (initialization call)");
            }
            
            write_text_to_log_file("StartRx completed");
        }
        
        UBERSDRINTF_API void __stdcall StopRx(void)
        {
            write_text_to_log_file(">>> StopRx CALLED <<<");
            
            try {
                // Set stop flag for worker threads
                gStopFlag = true;
                
                // Only wait for threads that were actually started (matching Hermes behavior)
                // Hermes only waits if ghWrk != NULL, we only wait for receivers that were started
                int receiversToStop = (gSet.RecvCount > 0) ? gSet.RecvCount : 0;
                
                std::stringstream ss;
                ss << "StopRx: Stopping " << receiversToStop << " receivers";
                write_text_to_log_file(ss.str());
                
                // Stop ring buffer consumer thread first
                if (ghRingBufferConsumer != NULL)
                {
                    write_text_to_log_file("Stopping ring buffer consumer thread...");
                    WaitForSingleObject(ghRingBufferConsumer, 1000);
                    CloseHandle(ghRingBufferConsumer);
                    ghRingBufferConsumer = NULL;
                    write_text_to_log_file("Ring buffer consumer thread stopped");
                }
                
                // Wait for and close worker threads (only up to RecvCount)
                for (int i = 0; i < receiversToStop; i++)
                {
                	if (ghWrk[i] != NULL)
                	{
                		WaitForSingleObject(ghWrk[i], 100);
                		CloseHandle(ghWrk[i]);
                		ghWrk[i] = NULL;
                	}
                }
                
                // Stop all active receivers (only if they were started)
                for (int i = 0; i < receiversToStop; i++)
                {
                    if (myUberSDR.receivers[i].active) {
                        myUberSDR.StopReceiver(i);
                    }
                }
                
                write_text_to_log_file("StopRx completed");
            }
            catch (const std::exception& e) {
                std::stringstream ss;
                ss << "Exception in StopRx: " << e.what();
                write_text_to_log_file(ss.str());
            }
            catch (...) {
                write_text_to_log_file("Unknown exception in StopRx");
            }
        }
        
        UBERSDRINTF_API void __stdcall SetRxFrequency(int Frequency, int Receiver)
        {
            try {
                std::stringstream ss;
                ss << "SetRxFrequency called: Rx#" << Receiver << " Frequency: " << Frequency;
                write_text_to_log_file(ss.str());
                
                if (Receiver < 0 || Receiver >= MAX_RX_COUNT)
                {
                    ss.str("");
                    ss << "SetRxFrequency: Invalid receiver ID " << Receiver;
                    write_text_to_log_file(ss.str());
                    return;
                }
                
                // Store frequency for WAV filename
                gWavFrequency[Receiver] = Frequency;
                
                // Start WAV recording if debug_rec is enabled and not already recording
                if (myUberSDR.debugRec && gWavFile[Receiver] == NULL && gSampleRate > 0)
                {
                    char filename[256];
                    sprintf_s(filename, sizeof(filename), "%d.wav", Frequency);
                    
                    errno_t err = fopen_s(&gWavFile[Receiver], filename, "wb");
                    if (err == 0 && gWavFile[Receiver] != NULL)
                    {
                        WriteWavHeader(gWavFile[Receiver], gSampleRate, 2); // Stereo IQ
                        gWavSamplesWritten[Receiver] = 0;
                        
                        ss.str("");
                        ss << "Started WAV recording to " << filename << " (10 seconds, debug_rec=true)";
                        write_text_to_log_file(ss.str());
                    }
                }
                
                // MATCH HERMES BEHAVIOR: Only change frequency if receiver is already active
                // CW Skimmer will call StartRx() again when adding receivers, not just SetRxFrequency()
                if (!myUberSDR.receivers[Receiver].active)
                {
                    ss.str("");
                    ss << "SetRxFrequency: Receiver " << Receiver << " not active (ignoring, waiting for StartRx)";
                    write_text_to_log_file(ss.str());
                    return;
                }
                
                // Receiver is active, just change frequency
                myUberSDR.SetFrequency(Receiver, Frequency);
                
                // Update shared memory
                if (gpSharedStatus != NULL && Receiver < MAX_RX_COUNT) {
                    gpSharedStatus->receivers[Receiver].frequency = Frequency;
                    gpSharedStatus->lastUpdateTime = ::GetCurrentTimeMs();
                }
            }
            catch (const std::exception& e) {
                std::stringstream ss;
                ss << "Exception in SetRxFrequency: " << e.what();
                write_text_to_log_file(ss.str());
                rt_exception(ss.str());
            }
            catch (...) {
                write_text_to_log_file("Unknown exception in SetRxFrequency");
                rt_exception("Unknown exception in SetRxFrequency");
            }
        }
        
        UBERSDRINTF_API void __stdcall SetCtrlBits(unsigned char Bits)
        {
            try {
                std::stringstream ss;
                ss << "SetCtrlBits called with Bits=" << (int)Bits;
                write_text_to_log_file(ss.str());
            }
            catch (...) {
                write_text_to_log_file("Exception in SetCtrlBits");
            }
        }
        
        UBERSDRINTF_API int __stdcall ReadPort(int PortNumber)
        {
            try {
                std::stringstream ss;
                ss << "ReadPort called with PortNumber=" << PortNumber;
                write_text_to_log_file(ss.str());
                return 0;
            }
            catch (...) {
                write_text_to_log_file("Exception in ReadPort");
                return 0;
            }
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Utility functions
    
    void write_text_to_log_file(const std::string &text)
    {
        SYSTEMTIME st;
        GetLocalTime(&st);
        char buffer[30];
        
        sprintf_s(buffer, sizeof(buffer), "%04d-%02d-%02d %02d:%02d:%02d.%03d",
                st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
        
        FILE* log_file = NULL;
        fopen_s(&log_file, "UberSDRIntf_log_file.txt", "a");
        if (log_file != NULL)
        {
            fprintf(log_file, "%s: %s\n", buffer, text.c_str());
            fflush(log_file);  // Force immediate write to disk
            fclose(log_file);
        }
    }
    
    void rt_exception(const std::string &text)
    {
        const char *error = text.c_str();
        if (gSet.pErrorProc != NULL) {
            (*gSet.pErrorProc)(gSet.THandle, (char *)error);
        }
        
        write_text_to_log_file("ERROR: " + text);
    }
}