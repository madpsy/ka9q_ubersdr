// UberSDRMonitor.cpp - Native Win32 monitor application for UberSDR DLL
// Displays real-time status information from the DLL via shared memory

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <math.h>
#include "../UberSDRIntf/UberSDRShared.h"
#include "resource.h"

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "ws2_32.lib")

#pragma comment(linker,"\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

// Simple FFT implementation for spectrum display
#define FFT_SIZE 16384
#define PI 3.14159265358979323846

// Complex number structure
struct Complex {
    float real;
    float imag;
};

// Marker line structure
#define MAX_MARKERS 10
struct MarkerLine {
    int x;  // X position in pixels
    int frequency;  // Frequency in Hz
    float signalDB;  // Signal level in dB
    float snr;  // SNR in dB
    bool active;
};

// DX Cluster spot structure
#define MAX_DX_SPOTS 50
#define MAX_MEASUREMENTS 10  // Maximum measurements to average per spot
struct DXSpot {
    char callsign[16];
    int reportedFrequency;  // Frequency reported by DX cluster in Hz
    int actualFrequency;    // Averaged measured peak frequency in Hz (0 if not yet measured)
    DWORD timestamp;        // Time when spot was received
    bool active;
    bool measured;          // True if we've completed measurement (success or timeout)
    int measurementFreqs[MAX_MEASUREMENTS];  // Array of measured frequencies
    int measurementCount;   // Number of valid measurements collected
};

// Spectrum window state
struct SpectrumWindow {
    HWND hWnd;
    HWND hSpotsWnd;  // Associated spots list window
    int receiverID;
    bool active;
    Complex fftBuffer[FFT_SIZE];
    float magnitudeDB[FFT_SIZE];
    float window[FFT_SIZE];  // Hanning window
    UINT_PTR timerId;
    float noiseFloor;  // Calculated noise floor in dB
    int lastMouseX;
    int lastMouseY;
    bool mouseInPlot;
    HWND hTooltip;
    char tooltipText[256];
    float smoothedMaxDB;  // Smoothed maximum for auto-scaling
    float smoothedMinDB;  // Smoothed minimum for auto-scaling
    MarkerLine markers[MAX_MARKERS];
    int markerCount;
    float zoomFactor;  // 1.0 = no zoom, >1.0 = zoomed in
    int zoomCenterFreq;  // Frequency to center zoom on
};

// WAV file header structure
#pragma pack(push, 1)
struct WAVHeader {
    char riff[4];           // "RIFF"
    uint32_t fileSize;      // File size - 8
    char wave[4];           // "WAVE"
    char fmt[4];            // "fmt "
    uint32_t fmtSize;       // 16 for PCM
    uint16_t audioFormat;   // 1 for PCM
    uint16_t numChannels;   // 2 for stereo
    uint32_t sampleRate;    // Sample rate
    uint32_t byteRate;      // SampleRate * NumChannels * BitsPerSample/8
    uint16_t blockAlign;    // NumChannels * BitsPerSample/8
    uint16_t bitsPerSample; // 16
    char data[4];           // "data"
    uint32_t dataSize;      // Size of data section
};
#pragma pack(pop)

// Recording state
struct RecordingState {
    bool recording;
    HANDLE hFile;
    int32_t lastReadPos;
    uint32_t samplesWritten;
    DWORD recordingStartTime;  // GetTickCount() when recording started
    int durationSeconds;        // Duration in seconds (0 = hold-to-record mode)
};

// Global variables
HINSTANCE g_hInst = NULL;
HWND g_hDlg = NULL;
HWND g_hInstanceList = NULL;  // Instance listbox control
HANDLE g_hSharedMemory = NULL;
const UberSDRSharedStatus* g_pStatus = NULL;
UINT_PTR g_timerId = 0;
UINT_PTR g_instanceTimerId = 0;
RecordingState g_recording[MAX_RX_COUNT] = {0};
WNDPROC g_originalButtonProc[MAX_RX_COUNT] = {0};

// Record button handles for color changes
HWND g_recordButtons[MAX_RX_COUNT] = {0};

// Spectrum windows
SpectrumWindow g_spectrumWindows[MAX_RX_COUNT] = {0};

// Multi-instance support
UberSDRInstanceInfo g_instances[16];  // Support up to 16 instances
int g_instanceCount = 0;
int g_selectedInstance = -1;

// DX Cluster spots
DXSpot g_dxSpots[MAX_DX_SPOTS] = {0};
int g_dxSpotCount = 0;
#define DX_SPOT_TIMEOUT 1800000  // 30 minutes in milliseconds

// Telnet connection state
SOCKET g_telnetSocket = INVALID_SOCKET;
bool g_telnetConnected = false;
bool g_telnetCallsignSent = false;
char g_telnetBuffer[4096] = {0};
int g_telnetBufferLen = 0;
DWORD g_lastReconnectAttempt = 0;

// Timer IDs
#define TIMER_UPDATE         1
#define TIMER_INSTANCE_CHECK 2

// Function prototypes
BOOL InitSharedMemory();
void CleanupSharedMemory();
void UpdateDisplay();
void UpdateInstanceList();
void FormatUptime(int64_t startTime, char* buffer, size_t bufferSize);
void FormatFrequency(int frequency, char* buffer, size_t bufferSize);
bool StartRecording(int receiverID);
void StopRecording(int receiverID);
void ProcessRecording(int receiverID);
LRESULT CALLBACK RecordButtonProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData);
INT_PTR CALLBACK DialogProc(HWND hDlg, UINT message, WPARAM wParam, LPARAM lParam);

// Spectrum display function prototypes
void InitHanningWindow(float* window, int size);
void PerformFFT(Complex* data, int size);
void ComputeSpectrum(int receiverID);
void ShowSpectrumWindow(int receiverID);
void CloseSpectrumWindow(int receiverID);
LRESULT CALLBACK SpectrumWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
void DrawSpectrum(HWND hwnd, HDC hdc, int receiverID);
float CalculateNoiseFloor(const float* magnitudeDB, int size);
int CompareFloat(const void* a, const void* b);

// Spots list window function prototypes
void ShowSpotsWindow(int receiverID);
void CloseSpotsWindow(int receiverID);
LRESULT CALLBACK SpotsWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
void UpdateSpotsListView(int receiverID);
void MeasureSpotPeakFrequency(int receiverID);

// Telnet function prototypes
BOOL InitWinsock();
void CleanupTelnet();
bool ConnectTelnet();
void ProcessTelnet();
void AppendTelnetText(const char* text);

// DX Cluster spot function prototypes
void ParseDXSpotLine(const char* line);
void AddDXSpot(const char* callsign, int frequency);
void CleanupOldSpots();
void DrawDXSpots(HDC hdc, int receiverID, int marginLeft, int marginTop, int plotWidth, int plotHeight, int minFreq, int maxFreq);
void CountSpotsForReceiver(int receiverID, int* uniqueCount, int* totalCount);
void UpdateSpotCounts();

// WinMain entry point
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow)
{
    g_hInst = hInstance;
    
    // Initialize Winsock
    if (!InitWinsock()) {
        MessageBoxA(NULL, "Failed to initialize Winsock", "Error", MB_OK | MB_ICONERROR);
        return 1;
    }
    
    // Initialize common controls
    INITCOMMONCONTROLSEX icex;
    icex.dwSize = sizeof(INITCOMMONCONTROLSEX);
    icex.dwICC = ICC_WIN95_CLASSES;
    InitCommonControlsEx(&icex);
    
    // Create dialog
    DialogBox(hInstance, MAKEINTRESOURCE(IDD_MAIN), NULL, DialogProc);
    
    // Cleanup Winsock
    CleanupTelnet();
    
    return 0;
}

// Initialize shared memory connection
BOOL InitSharedMemory()
{
    // Clean up stale instances first
    CleanupStaleInstances();
    
    // Enumerate all available instances
    g_instanceCount = EnumerateInstances(g_instances, 16);
    
    if (g_instanceCount == 0) {
        // No instances found - try legacy shared memory name for backward compatibility
        g_hSharedMemory = OpenFileMappingW(
            FILE_MAP_ALL_ACCESS,
            FALSE,
            UBERSDR_SHARED_MEMORY_NAME);
        
        // If not found, try Hermes
        if (g_hSharedMemory == NULL) {
            g_hSharedMemory = OpenFileMappingW(
                FILE_MAP_ALL_ACCESS,
                FALSE,
                L"HermesIntf_Status_v1");
        }
        
        if (g_hSharedMemory == NULL) {
            return FALSE;
        }
        
        g_pStatus = (const UberSDRSharedStatus*)MapViewOfFile(
            g_hSharedMemory,
            FILE_MAP_ALL_ACCESS,
            0, 0,
            sizeof(UberSDRSharedStatus));
        
        if (g_pStatus == NULL) {
            CloseHandle(g_hSharedMemory);
            g_hSharedMemory = NULL;
            return FALSE;
        }
        
        g_selectedInstance = -1;  // Legacy mode
        return TRUE;
    }
    else {
        // One or more instances found - show selection dialog
        // This allows user to see instance details even with single instance
        return FALSE;  // Indicate selection needed
    }
}

// Cleanup shared memory
void CleanupSharedMemory()
{
    if (g_pStatus != NULL) {
        UnmapViewOfFile((LPVOID)g_pStatus);
        g_pStatus = NULL;
    }
    
    if (g_hSharedMemory != NULL) {
        CloseHandle(g_hSharedMemory);
        g_hSharedMemory = NULL;
    }
}

// Format uptime string
void FormatUptime(int64_t startTime, char* buffer, size_t bufferSize)
{
    if (startTime == 0) {
        strcpy_s(buffer, bufferSize, "Not started");
        return;
    }
    
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER uli;
    uli.LowPart = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    int64_t now = (int64_t)(uli.QuadPart / 10000ULL - 11644473600000ULL);
    
    int64_t elapsed = (now - startTime) / 1000;  // Convert to seconds
    int hours = (int)(elapsed / 3600);
    int minutes = (int)((elapsed % 3600) / 60);
    int seconds = (int)(elapsed % 60);
    
    sprintf_s(buffer, bufferSize, "%02d:%02d:%02d", hours, minutes, seconds);
}

// Format frequency string
void FormatFrequency(int frequency, char* buffer, size_t bufferSize)
{
    if (frequency >= 1000000) {
        sprintf_s(buffer, bufferSize, "%.3f MHz", frequency / 1000000.0);
    } else if (frequency >= 1000) {
        sprintf_s(buffer, bufferSize, "%.1f kHz", frequency / 1000.0);
    } else {
        sprintf_s(buffer, bufferSize, "%d Hz", frequency);
    }
}

// Update instance list
void UpdateInstanceList()
{
    if (g_hInstanceList == NULL) return;
    
    // Save current selection
    int currentSelection = (int)SendMessage(g_hInstanceList, LB_GETCURSEL, 0, 0);
    
    // Clean up stale instances
    CleanupStaleInstances();
    
    // Enumerate instances
    g_instanceCount = EnumerateInstances(g_instances, 16);
    
    // Clear listbox
    SendMessage(g_hInstanceList, LB_RESETCONTENT, 0, 0);
    
    if (g_instanceCount == 0) {
        // Show "No instances found"
        SendMessageA(g_hInstanceList, LB_ADDSTRING, 0, (LPARAM)"No instances found - waiting for DLL...");
    } else {
        // Add each instance to listbox
        for (int i = 0; i < g_instanceCount; i++) {
            char serverHost[128];
            WideCharToMultiByte(CP_UTF8, 0, g_instances[i].serverHost, -1, serverHost, 128, NULL, NULL);
            
            // Format start time
            FILETIME ft;
            ULARGE_INTEGER uli;
            uli.QuadPart = (g_instances[i].startTime + 11644473600000ULL) * 10000ULL;
            ft.dwLowDateTime = uli.LowPart;
            ft.dwHighDateTime = uli.HighPart;
            
            SYSTEMTIME st;
            FileTimeToSystemTime(&ft, &st);
            
            char itemText[256];
            sprintf_s(itemText, sizeof(itemText),
                     "%s:%d (PID: %u, Started: %02d:%02d:%02d)",
                     serverHost, g_instances[i].serverPort, g_instances[i].processID,
                     st.wHour, st.wMinute, st.wSecond);
            
            SendMessageA(g_hInstanceList, LB_ADDSTRING, 0, (LPARAM)itemText);
        }
        
        // Restore previous selection if valid, otherwise select connected instance
        if (currentSelection >= 0 && currentSelection < g_instanceCount) {
            SendMessage(g_hInstanceList, LB_SETCURSEL, currentSelection, 0);
        } else if (g_selectedInstance >= 0 && g_selectedInstance < g_instanceCount) {
            SendMessage(g_hInstanceList, LB_SETCURSEL, g_selectedInstance, 0);
        }
    }
}

// Update display with current status
void UpdateDisplay()
{
    if (g_pStatus == NULL) {
        // Try to reconnect
        if (!InitSharedMemory()) {
            SetDlgItemTextA(g_hDlg, IDC_SERVER_STATUS, "DLL not loaded - waiting...");
            return;
        }
    }
    
    char buffer[256];
    
    // Server status
    sprintf_s(buffer, sizeof(buffer), "Server: %s:%d %s",
              g_pStatus->serverHost,
              g_pStatus->serverPort,
              g_pStatus->connected ? "[Connected]" : "[Disconnected]");
    SetDlgItemTextA(g_hDlg, IDC_SERVER_STATUS, buffer);
    
    // Sample rate and mode - calculate global median offset across all receivers
    int globalOffsets[MAX_DX_SPOTS];
    int globalMeasuredCount = 0;
    
    for (int i = 0; i < g_dxSpotCount; i++) {
    if (g_dxSpots[i].active && g_dxSpots[i].measured && g_dxSpots[i].actualFrequency > 0) {
        // Use 1 Hz precision - don't round to 100 Hz
        // Median will average out DX cluster's 100 Hz quantization for better accuracy
        int offset = g_dxSpots[i].reportedFrequency - g_dxSpots[i].actualFrequency;
        globalOffsets[globalMeasuredCount++] = offset;
    }
}
    
    // Get global fixed offset from INI (from first active receiver)
    int globalFixedOffset = 0;
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        if (g_pStatus->receivers[i].active) {
            globalFixedOffset = g_pStatus->receivers[i].globalFrequencyOffset;
            break;
        }
    }
    
    if (globalMeasuredCount > 0) {
        // Sort offsets to find median
        for (int i = 0; i < globalMeasuredCount - 1; i++) {
            for (int j = i + 1; j < globalMeasuredCount; j++) {
                if (globalOffsets[j] < globalOffsets[i]) {
                    int temp = globalOffsets[i];
                    globalOffsets[i] = globalOffsets[j];
                    globalOffsets[j] = temp;
                }
            }
        }
        
        // Calculate median
        float globalMedianOffset;
        if (globalMeasuredCount % 2 == 0) {
            globalMedianOffset = (globalOffsets[globalMeasuredCount / 2 - 1] + globalOffsets[globalMeasuredCount / 2]) / 2.0f;
        } else {
            globalMedianOffset = (float)globalOffsets[globalMeasuredCount / 2];
        }
        
        sprintf_s(buffer, sizeof(buffer), "Sample Rate: %d Hz    Mode: %s    Block Size: %d    INI Offset: %+d Hz    Global Median Offset: %+.0f Hz",
                  g_pStatus->sampleRate,
                  g_pStatus->mode,
                  g_pStatus->blockSize,
                  globalFixedOffset,
                  globalMedianOffset);
    } else {
        sprintf_s(buffer, sizeof(buffer), "Sample Rate: %d Hz    Mode: %s    Block Size: %d    INI Offset: %+d Hz",
                  g_pStatus->sampleRate,
                  g_pStatus->mode,
                  g_pStatus->blockSize,
                  globalFixedOffset);
    }
    SetDlgItemTextA(g_hDlg, IDC_SAMPLE_RATE, buffer);
    
    // Receiver status and level meters
    float totalThroughput = 0.0f;
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        char freqStr[64];
        FormatFrequency(g_pStatus->receivers[i].frequency, freqStr, sizeof(freqStr));
        
        if (g_pStatus->receivers[i].active) {
            // Build status string with ring buffer metrics
            int bufferPercent = (int)(g_pStatus->receivers[i].ringBufferFillLevel * 100.0f);
            int overruns = g_pStatus->receivers[i].ringBufferOverruns;
            int underruns = g_pStatus->receivers[i].ringBufferUnderruns;
            
            // Get per-receiver offset info
            int perRxOffset = g_pStatus->receivers[i].frequencyOffset;
            int totalOffset = g_pStatus->receivers[i].totalFrequencyOffset;
            
            if (overruns > 0 || underruns > 0) {
                sprintf_s(buffer, sizeof(buffer), "Rx%d: %s [Active] %.1f KB/s  Buf:%d%% (O:%d U:%d)  Offset:%+d Hz (Total:%+d Hz)",
                          i,
                          freqStr,
                          g_pStatus->receivers[i].throughputKBps,
                          bufferPercent,
                          overruns,
                          underruns,
                          perRxOffset,
                          totalOffset);
            } else {
                sprintf_s(buffer, sizeof(buffer), "Rx%d: %s [Active] %.1f KB/s  Buf:%d%%  Offset:%+d Hz (Total:%+d Hz)",
                          i,
                          freqStr,
                          g_pStatus->receivers[i].throughputKBps,
                          bufferPercent,
                          perRxOffset,
                          totalOffset);
            }
            totalThroughput += g_pStatus->receivers[i].throughputKBps;
            
            // Update level meters (convert 0.0-1.0 to 0-100 percentage)
            int levelI = (int)(g_pStatus->receivers[i].peakLevelI * 100.0f);
            int levelQ = (int)(g_pStatus->receivers[i].peakLevelQ * 100.0f);
            SendDlgItemMessage(g_hDlg, IDC_RX0_LEVEL_I + (i * 2), PBM_SETPOS, levelI, 0);
            SendDlgItemMessage(g_hDlg, IDC_RX0_LEVEL_Q + (i * 2), PBM_SETPOS, levelQ, 0);
        } else {
            sprintf_s(buffer, sizeof(buffer), "Rx%d: Inactive", i);
            
            // Clear level meters for inactive receivers
            SendDlgItemMessage(g_hDlg, IDC_RX0_LEVEL_I + (i * 2), PBM_SETPOS, 0, 0);
            SendDlgItemMessage(g_hDlg, IDC_RX0_LEVEL_Q + (i * 2), PBM_SETPOS, 0, 0);
        }
        
        SetDlgItemTextA(g_hDlg, IDC_RX0_STATUS + i, buffer);
    }
    
    // Statistics
    sprintf_s(buffer, sizeof(buffer), "Callbacks: %lld    Total Samples: %lld",
              g_pStatus->totalCallbacks,
              g_pStatus->totalSamples);
    SetDlgItemTextA(g_hDlg, IDC_CALLBACKS, buffer);
    
    // Uptime
    char uptimeStr[64];
    FormatUptime(g_pStatus->startTime, uptimeStr, sizeof(uptimeStr));
    sprintf_s(buffer, sizeof(buffer), "Uptime: %s    Active Receivers: %d",
              uptimeStr,
              g_pStatus->activeReceiverCount);
    SetDlgItemTextA(g_hDlg, IDC_UPTIME, buffer);
    
    // Total throughput - now shows ACTUAL compressed network bandwidth (not decompressed)
    // The DLL tracks compressed bytes received, so this is the real network usage
    sprintf_s(buffer, sizeof(buffer), "Network Bandwidth: %.1f KB/s (%.2f Mbps) | Active Receivers: %d",
              totalThroughput,
              (totalThroughput * 8.0f) / 1024.0f,
              g_pStatus->activeReceiverCount);
    SetDlgItemTextA(g_hDlg, IDC_TOTAL_THROUGHPUT, buffer);
    
    // Process any active recordings and check for duration expiry
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        if (g_recording[i].recording) {
            ProcessRecording(i);
            
            // Check if duration has expired (only for timed recordings, duration > 0)
            if (g_recording[i].durationSeconds > 0) {
                DWORD elapsed = GetTickCount() - g_recording[i].recordingStartTime;
                if (elapsed >= (DWORD)(g_recording[i].durationSeconds * 1000)) {
                    // Duration expired - stop recording
                    StopRecording(i);
                }
            }
        }
    }
    
    // Run FFT and spot measurement for all active receivers in background
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        if (g_pStatus->receivers[i].active) {
            // Initialize spectrum window data if not already done
            if (g_spectrumWindows[i].window[0] == 0.0f) {
                InitHanningWindow(g_spectrumWindows[i].window, FFT_SIZE);
            }
            
            // Compute spectrum for this receiver
            ComputeSpectrum(i);
            
            // Measure spot peak frequencies for this receiver
            MeasureSpotPeakFrequency(i);
        }
    }
    
    // Update spot counts for all receivers
    UpdateSpotCounts();
    
    // Process telnet connection
    ProcessTelnet();
}

// Start recording for a receiver
bool StartRecording(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return false;
    if (g_recording[receiverID].recording) return false;
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return false;
    
    // Generate filename with timestamp
    char filename[MAX_PATH];
    SYSTEMTIME st;
    GetLocalTime(&st);
    sprintf_s(filename, sizeof(filename), "RX%d_%04d%02d%02d_%02d%02d%02d_%dHz.wav",
              receiverID, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
              g_pStatus->receivers[receiverID].frequency);
    
    // Create WAV file
    g_recording[receiverID].hFile = CreateFileA(filename, GENERIC_WRITE, 0, NULL,
                                                 CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_recording[receiverID].hFile == INVALID_HANDLE_VALUE) {
        return false;
    }
    
    // Write WAV header (will update size later)
    WAVHeader header = {0};
    memcpy(header.riff, "RIFF", 4);
    memcpy(header.wave, "WAVE", 4);
    memcpy(header.fmt, "fmt ", 4);
    header.fmtSize = 16;
    header.audioFormat = 1;  // PCM
    header.numChannels = 2;  // Stereo (I and Q)
    header.sampleRate = g_pStatus->sampleRate;
    header.bitsPerSample = 16;
    header.blockAlign = header.numChannels * header.bitsPerSample / 8;
    header.byteRate = header.sampleRate * header.blockAlign;
    memcpy(header.data, "data", 4);
    header.dataSize = 0;  // Will update on close
    header.fileSize = sizeof(WAVHeader) - 8;  // Will update on close
    
    DWORD written;
    WriteFile(g_recording[receiverID].hFile, &header, sizeof(header), &written, NULL);
    
    // Initialize recording state
    g_recording[receiverID].recording = true;
    g_recording[receiverID].lastReadPos = g_pStatus->receivers[receiverID].iqBufferWritePos;
    g_recording[receiverID].samplesWritten = 0;
    
    // Change button color to red
    if (g_recordButtons[receiverID] != NULL) {
        InvalidateRect(g_recordButtons[receiverID], NULL, TRUE);
        // Set button to red background using owner draw or custom paint
        // For now, we'll use a simple approach with SetWindowLong to trigger custom drawing
        LONG_PTR style = GetWindowLongPtr(g_recordButtons[receiverID], GWL_STYLE);
        SetWindowLongPtr(g_recordButtons[receiverID], GWL_STYLE, style | BS_OWNERDRAW);
        InvalidateRect(g_recordButtons[receiverID], NULL, TRUE);
    }
    
    return true;
}

// Stop recording for a receiver
void StopRecording(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (!g_recording[receiverID].recording) return;
    
    // Update WAV header with final sizes
    if (g_recording[receiverID].hFile != INVALID_HANDLE_VALUE) {
        uint32_t dataSize = g_recording[receiverID].samplesWritten * 4;  // 2 channels * 2 bytes
        uint32_t fileSize = dataSize + sizeof(WAVHeader) - 8;
        
        SetFilePointer(g_recording[receiverID].hFile, 4, NULL, FILE_BEGIN);
        DWORD written;
        WriteFile(g_recording[receiverID].hFile, &fileSize, 4, &written, NULL);
        
        SetFilePointer(g_recording[receiverID].hFile, 40, NULL, FILE_BEGIN);
        WriteFile(g_recording[receiverID].hFile, &dataSize, 4, &written, NULL);
        
        CloseHandle(g_recording[receiverID].hFile);
        g_recording[receiverID].hFile = INVALID_HANDLE_VALUE;
    }
    
    g_recording[receiverID].recording = false;
    
    // Restore button to normal color
    if (g_recordButtons[receiverID] != NULL) {
        LONG_PTR style = GetWindowLongPtr(g_recordButtons[receiverID], GWL_STYLE);
        SetWindowLongPtr(g_recordButtons[receiverID], GWL_STYLE, style & ~BS_OWNERDRAW);
        InvalidateRect(g_recordButtons[receiverID], NULL, TRUE);
    }
}

// Button subclass procedure to handle click-to-record with duration support
LRESULT CALLBACK RecordButtonProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData)
{
    int rxId = (int)dwRefData;
    
    switch (msg)
    {
    case WM_LBUTTONDOWN:
        {
            // Get duration from edit box
            char durationText[16];
            GetDlgItemTextA(g_hDlg, IDC_RX0_DURATION + rxId, durationText, sizeof(durationText));
            int duration = atoi(durationText);
            
            if (g_recording[rxId].recording) {
                // Already recording - stop it (click to stop)
                StopRecording(rxId);
            } else {
                // Start recording
                g_recording[rxId].durationSeconds = duration;
                g_recording[rxId].recordingStartTime = GetTickCount();
                StartRecording(rxId);
            }
        }
        break;
        
    case WM_LBUTTONUP:
    case WM_CAPTURECHANGED:
        // For duration=0 (hold-to-record mode), stop when button is released
        if (g_recording[rxId].recording && g_recording[rxId].durationSeconds == 0) {
            StopRecording(rxId);
        }
        break;
        
    case WM_NCDESTROY:
        RemoveWindowSubclass(hwnd, RecordButtonProc, uIdSubclass);
        break;
    }
    
    return DefSubclassProc(hwnd, msg, wParam, lParam);
}

// Process recording - copy samples from circular buffer to file
void ProcessRecording(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (!g_recording[receiverID].recording) return;
    if (g_pStatus == NULL) return;
    
    int32_t writePos = g_pStatus->receivers[receiverID].iqBufferWritePos;
    int32_t readPos = g_recording[receiverID].lastReadPos;
    
    // Calculate available samples
    int32_t available;
    if (writePos >= readPos) {
        available = writePos - readPos;
    } else {
        available = IQ_BUFFER_SIZE - readPos + writePos;
    }
    
    if (available < 2) return;  // Need at least one I/Q pair
    
    // Write samples to file in batches for better performance
    // Use a temporary buffer to batch writes (reduces WriteFile calls dramatically)
    #define WRITE_BATCH_SIZE 8192  // Write 4KB at a time (2048 I/Q pairs)
    int16_t batchBuffer[WRITE_BATCH_SIZE];
    
    while (available >= 2) {
        // Fill batch buffer
        int batchCount = 0;
        while (available >= 2 && batchCount < WRITE_BATCH_SIZE) {
            batchBuffer[batchCount++] = g_pStatus->receivers[receiverID].iqBuffer[readPos];
            batchBuffer[batchCount++] = g_pStatus->receivers[receiverID].iqBuffer[readPos + 1];
            
            g_recording[receiverID].samplesWritten++;
            readPos = (readPos + 2) % IQ_BUFFER_SIZE;
            available -= 2;
        }
        
        // Write batch to file
        if (batchCount > 0) {
            DWORD written;
            WriteFile(g_recording[receiverID].hFile, batchBuffer, batchCount * sizeof(int16_t), &written, NULL);
        }
    }
    
    g_recording[receiverID].lastReadPos = readPos;
}

// Initialize Winsock
BOOL InitWinsock()
{
    WSADATA wsaData;
    int result = WSAStartup(MAKEWORD(2, 2), &wsaData);
    if (result != 0) {
        return FALSE;
    }
    return TRUE;
}

// Cleanup telnet connection
void CleanupTelnet()
{
    if (g_telnetSocket != INVALID_SOCKET) {
        closesocket(g_telnetSocket);
        g_telnetSocket = INVALID_SOCKET;
    }
    g_telnetConnected = false;
    g_telnetCallsignSent = false;
    WSACleanup();
}

// Connect to telnet server
bool ConnectTelnet()
{
    // Close existing socket if any
    if (g_telnetSocket != INVALID_SOCKET) {
        closesocket(g_telnetSocket);
        g_telnetSocket = INVALID_SOCKET;
    }
    
    // Get port from input field
    char portStr[16];
    GetDlgItemTextA(g_hDlg, IDC_TELNET_PORT, portStr, sizeof(portStr));
    int port = atoi(portStr);
    if (port <= 0 || port > 65535) {
        AppendTelnetText("Invalid port number\r\n");
        return false;
    }
    
    // Create socket
    g_telnetSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (g_telnetSocket == INVALID_SOCKET) {
        AppendTelnetText("Failed to create socket\r\n");
        return false;
    }
    
    // Set non-blocking mode
    u_long mode = 1;
    if (ioctlsocket(g_telnetSocket, FIONBIO, &mode) != 0) {
        closesocket(g_telnetSocket);
        g_telnetSocket = INVALID_SOCKET;
        AppendTelnetText("Failed to set non-blocking mode\r\n");
        return false;
    }
    
    // Setup address
    sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    
    // Attempt connection (non-blocking, so may return WSAEWOULDBLOCK)
    connect(g_telnetSocket, (sockaddr*)&addr, sizeof(addr));
    
    // Reset state
    g_telnetConnected = false;
    g_telnetCallsignSent = false;
    g_telnetBufferLen = 0;
    memset(g_telnetBuffer, 0, sizeof(g_telnetBuffer));
    
    char msg[128];
    sprintf_s(msg, sizeof(msg), "Connecting to localhost:%d...\r\n", port);
    AppendTelnetText(msg);
    
    // Disable Connect button, enable Disconnect button
    EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_CONNECT), FALSE);
    EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_DISCONNECT), TRUE);
    
    return true;
}

// Append text to telnet output control
void AppendTelnetText(const char* text)
{
    if (g_hDlg == NULL) return;
    
    HWND hEdit = GetDlgItem(g_hDlg, IDC_TELNET_OUTPUT);
    if (hEdit == NULL) return;
    
    // Get current text length
    int len = GetWindowTextLengthA(hEdit);
    
    // Aggressively manage buffer - start clearing earlier to prevent hitting the 32KB limit
    // Keep only the most recent ~8KB of data to ensure latest output is always visible
    if (len > 24000) {
        // Remove first 20KB of old data, keeping only recent content
        SendMessageA(hEdit, EM_SETSEL, 0, 20000);
        SendMessageA(hEdit, EM_REPLACESEL, FALSE, (LPARAM)"[...earlier output truncated...]\r\n");
        len = GetWindowTextLengthA(hEdit);
    }
    
    // Append new text
    SendMessageA(hEdit, EM_SETSEL, len, len);
    SendMessageA(hEdit, EM_REPLACESEL, FALSE, (LPARAM)text);
    
    // Scroll to bottom to show latest data
    SendMessageA(hEdit, EM_SCROLLCARET, 0, 0);
}

// Parse DX cluster spot line
// Format: DX de MM9PSY-#:   7037.2  9A1AA         8 dB  28 WPM                0704Z
void ParseDXSpotLine(const char* line)
{
    // Check if line starts with "DX de "
    if (strncmp(line, "DX de ", 6) != 0) {
        return;
    }
    
    // Parse the line - format is:
    // DX de SPOTTER:   FREQ  CALLSIGN  ...
    char callsign[16] = {0};
    float freqKHz = 0.0f;
    
    // Find the frequency (first number after "DX de ")
    const char* p = line + 6;
    
    // Skip to the colon
    while (*p && *p != ':') p++;
    if (*p == ':') p++;
    
    // Skip whitespace
    while (*p && (*p == ' ' || *p == '\t')) p++;
    
    // Read frequency
    if (sscanf_s(p, "%f", &freqKHz) == 1) {
        // Skip past the frequency
        while (*p && (*p == ' ' || *p == '\t' || *p == '.' || (*p >= '0' && *p <= '9'))) p++;
        
        // Skip whitespace
        while (*p && (*p == ' ' || *p == '\t')) p++;
        
        // Read callsign (up to next space or end of line)
        int i = 0;
        while (*p && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n' && i < 15) {
            callsign[i++] = *p++;
        }
        callsign[i] = '\0';
        
        // If we got both frequency and callsign, add the spot
        if (freqKHz > 0 && callsign[0] != '\0') {
            int freqHz = (int)(freqKHz * 1000.0f);
            AddDXSpot(callsign, freqHz);
        }
    }
}

// Add a DX spot to the list
void AddDXSpot(const char* callsign, int frequency)
{
    DWORD currentTime = GetTickCount();
    
    // Check if this spot already exists (same callsign and frequency within 1 kHz)
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (g_dxSpots[i].active &&
            strcmp(g_dxSpots[i].callsign, callsign) == 0 &&
            abs(g_dxSpots[i].reportedFrequency - frequency) < 1000) {
            // Update timestamp
            g_dxSpots[i].timestamp = currentTime;
            return;
        }
    }
    
    // Find an empty slot or reuse oldest spot
    int slotIndex = -1;
    
    // First try to find an inactive slot
    for (int i = 0; i < MAX_DX_SPOTS; i++) {
        if (!g_dxSpots[i].active) {
            slotIndex = i;
            break;
        }
    }
    
    // If no inactive slot, find oldest spot
    if (slotIndex == -1) {
        DWORD oldestTime = currentTime;
        for (int i = 0; i < MAX_DX_SPOTS; i++) {
            if (g_dxSpots[i].timestamp < oldestTime) {
                oldestTime = g_dxSpots[i].timestamp;
                slotIndex = i;
            }
        }
    }
    
    // Add the spot
    if (slotIndex >= 0) {
        strcpy_s(g_dxSpots[slotIndex].callsign, sizeof(g_dxSpots[slotIndex].callsign), callsign);
        g_dxSpots[slotIndex].reportedFrequency = frequency;
        g_dxSpots[slotIndex].actualFrequency = 0;  // Not yet measured
        g_dxSpots[slotIndex].timestamp = currentTime;
        g_dxSpots[slotIndex].active = true;
        g_dxSpots[slotIndex].measured = false;
        g_dxSpots[slotIndex].measurementCount = 0;  // No measurements yet
        for (int i = 0; i < MAX_MEASUREMENTS; i++) {
            g_dxSpots[slotIndex].measurementFreqs[i] = 0;
        }
        
        // Update count if needed
        if (slotIndex >= g_dxSpotCount) {
            g_dxSpotCount = slotIndex + 1;
        }
    }
}

// Clean up old spots (older than 5 minutes)
void CleanupOldSpots()
{
    DWORD currentTime = GetTickCount();
    
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (g_dxSpots[i].active) {
            DWORD age = currentTime - g_dxSpots[i].timestamp;
            if (age > DX_SPOT_TIMEOUT) {
                g_dxSpots[i].active = false;
            }
        }
    }
}

// Draw DX spots on spectrum display
void DrawDXSpots(HDC hdc, int receiverID, int marginLeft, int marginTop, int plotWidth, int plotHeight, int minFreq, int maxFreq)
{
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return;
    
    int sampleRate = g_pStatus->sampleRate;
    int centerFreq = g_pStatus->receivers[receiverID].frequency;
    
    // Calculate the band edges for this receiver
    int bandMinFreq = centerFreq - sampleRate / 2;
    int bandMaxFreq = centerFreq + sampleRate / 2;
    
    // Structure to track visible spots with their positions
    struct VisibleSpot {
        int index;
        int x;
        int textWidth;
        int tier;  // Vertical tier for collision avoidance
    };
    
    VisibleSpot visibleSpots[MAX_DX_SPOTS];
    int visibleCount = 0;
    
    // First pass: collect all visible spots and calculate their positions
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (!g_dxSpots[i].active) continue;
        
        int spotFreq = g_dxSpots[i].reportedFrequency;
        
        // Check if spot is within the receiver's band
        if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
        
        // Check if spot is within the visible frequency range (considering zoom)
        if (spotFreq < minFreq || spotFreq > maxFreq) continue;
        
        // Calculate X position for this spot
        int visibleSpan = maxFreq - minFreq;
        float freqToX = (float)plotWidth / (float)visibleSpan;
        int x = marginLeft + (int)((spotFreq - minFreq) * freqToX);
        
        // Measure text width for collision detection
        SIZE textSize;
        GetTextExtentPoint32A(hdc, g_dxSpots[i].callsign, (int)strlen(g_dxSpots[i].callsign), &textSize);
        
        visibleSpots[visibleCount].index = i;
        visibleSpots[visibleCount].x = x;
        visibleSpots[visibleCount].textWidth = textSize.cx;
        visibleSpots[visibleCount].tier = 0;  // Will be assigned later
        visibleCount++;
    }
    
    // Second pass: assign tiers to avoid collisions
    // Sort spots by X position for easier collision detection
    for (int i = 0; i < visibleCount - 1; i++) {
        for (int j = i + 1; j < visibleCount; j++) {
            if (visibleSpots[j].x < visibleSpots[i].x) {
                VisibleSpot temp = visibleSpots[i];
                visibleSpots[i] = visibleSpots[j];
                visibleSpots[j] = temp;
            }
        }
    }
    
    // Assign tiers based on horizontal overlap
    #define MAX_TIERS 4
    #define MIN_SPACING 5  // Minimum pixels between labels
    
    for (int i = 0; i < visibleCount; i++) {
        int bestTier = 0;
        bool tierOccupied[MAX_TIERS] = {false};
        
        // Check which tiers are occupied by nearby spots
        for (int j = 0; j < i; j++) {
            int leftEdge = visibleSpots[i].x - visibleSpots[i].textWidth / 2 - MIN_SPACING;
            int rightEdge = visibleSpots[i].x + visibleSpots[i].textWidth / 2 + MIN_SPACING;
            int otherLeft = visibleSpots[j].x - visibleSpots[j].textWidth / 2;
            int otherRight = visibleSpots[j].x + visibleSpots[j].textWidth / 2;
            
            // Check for horizontal overlap
            if (!(rightEdge < otherLeft || leftEdge > otherRight)) {
                tierOccupied[visibleSpots[j].tier] = true;
            }
        }
        
        // Find first available tier
        for (int t = 0; t < MAX_TIERS; t++) {
            if (!tierOccupied[t]) {
                bestTier = t;
                break;
            }
        }
        
        visibleSpots[i].tier = bestTier;
    }
    
    // Third pass: draw all spots with their assigned tiers
    for (int i = 0; i < visibleCount; i++) {
        int spotIndex = visibleSpots[i].index;
        int x = visibleSpots[i].x;
        int tier = visibleSpots[i].tier;
        int spotFreq = g_dxSpots[spotIndex].reportedFrequency;
        
        int visibleSpan = maxFreq - minFreq;
        float freqToX = (float)plotWidth / (float)visibleSpan;
        
        // Draw semi-transparent orange highlight (300 Hz wide, centered on spot)
        int spotWidth = 300;  // 300 Hz total width
        int spotStartFreq = spotFreq - spotWidth / 2;
        int spotEndFreq = spotFreq + spotWidth / 2;
        
        // Calculate pixel positions for highlight
        int x1 = marginLeft + (int)((float)(spotStartFreq - minFreq) * freqToX);
        int x2 = marginLeft + (int)((float)(spotEndFreq - minFreq) * freqToX);
        
        // Clamp to plot area
        if (x1 < marginLeft) x1 = marginLeft;
        if (x2 > marginLeft + plotWidth) x2 = marginLeft + plotWidth;
        
        // Arrow points down from top of plot, adjusted for tier
        int tierHeight = 18;  // Vertical spacing between tiers
        int arrowTop = marginTop + 35 + (tier * tierHeight);  // Below FT8 labels, staggered by tier
        int arrowBottom = arrowTop + 15;
        int highlightTop = arrowBottom + 5;  // Start just under the arrow
        
        // Draw semi-transparent orange highlight
        if (x2 > x1) {
            HBRUSH highlightBrush = CreateSolidBrush(RGB(255, 165, 0));
            
            // Set transparency (blend mode)
            BLENDFUNCTION blend = {0};
            blend.BlendOp = AC_SRC_OVER;
            blend.SourceConstantAlpha = 64;  // 25% opacity (0-255)
            blend.AlphaFormat = 0;
            
            // Create memory DC for alpha blending
            HDC tempDC = CreateCompatibleDC(hdc);
            HBITMAP tempBitmap = CreateCompatibleBitmap(hdc, x2 - x1, plotHeight - (highlightTop - marginTop));
            HBITMAP oldBitmap = (HBITMAP)SelectObject(tempDC, tempBitmap);
            
            // Fill temp bitmap with orange
            RECT tempRect = {0, 0, x2 - x1, plotHeight - (highlightTop - marginTop)};
            FillRect(tempDC, &tempRect, highlightBrush);
            
            // Blend to main DC
            AlphaBlend(hdc, x1, highlightTop, x2 - x1, plotHeight - (highlightTop - marginTop),
                      tempDC, 0, 0, x2 - x1, plotHeight - (highlightTop - marginTop), blend);
            
            // Cleanup
            SelectObject(tempDC, oldBitmap);
            DeleteObject(tempBitmap);
            DeleteDC(tempDC);
            DeleteObject(highlightBrush);
        }
        
        // Draw downward arrow
        HPEN spotPen = CreatePen(PS_SOLID, 2, RGB(255, 165, 0));  // Orange color
        HBRUSH spotBrush = CreateSolidBrush(RGB(255, 165, 0));
        SelectObject(hdc, spotPen);
        SelectObject(hdc, spotBrush);
        
        int arrowWidth = 6;
        
        // Draw arrow shaft
        MoveToEx(hdc, x, arrowTop, NULL);
        LineTo(hdc, x, arrowBottom);
        
        // Draw arrow head (triangle pointing down)
        POINT arrowHead[3];
        arrowHead[0].x = x;
        arrowHead[0].y = arrowBottom + 5;
        arrowHead[1].x = x - arrowWidth / 2;
        arrowHead[1].y = arrowBottom;
        arrowHead[2].x = x + arrowWidth / 2;
        arrowHead[2].y = arrowBottom;
        Polygon(hdc, arrowHead, 3);
        
        DeleteObject(spotPen);
        DeleteObject(spotBrush);
        
        // Draw callsign above arrow
        SetTextColor(hdc, RGB(255, 165, 0));
        SetBkMode(hdc, TRANSPARENT);
        
        // Measure text to center it
        SIZE textSize;
        GetTextExtentPoint32A(hdc, g_dxSpots[spotIndex].callsign, (int)strlen(g_dxSpots[spotIndex].callsign), &textSize);
        int textX = x - textSize.cx / 2;
        int textY = arrowTop - textSize.cy - 2;
        
        // Make sure text doesn't go off screen
        if (textX < marginLeft) textX = marginLeft;
        if (textX + textSize.cx > marginLeft + plotWidth) textX = marginLeft + plotWidth - textSize.cx;
        
        TextOutA(hdc, textX, textY, g_dxSpots[spotIndex].callsign, (int)strlen(g_dxSpots[spotIndex].callsign));
    }
}

// Count spots for a specific receiver
void CountSpotsForReceiver(int receiverID, int* uniqueCount, int* totalCount)
{
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) {
        *uniqueCount = 0;
        *totalCount = 0;
        return;
    }
    
    int sampleRate = g_pStatus->sampleRate;
    int centerFreq = g_pStatus->receivers[receiverID].frequency;
    int bandMinFreq = centerFreq - sampleRate / 2;
    int bandMaxFreq = centerFreq + sampleRate / 2;
    
    // Track unique callsigns
    char uniqueCallsigns[MAX_DX_SPOTS][16];
    int uniqueCallsignCount = 0;
    int total = 0;
    
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (!g_dxSpots[i].active) continue;
        
        int spotFreq = g_dxSpots[i].reportedFrequency;
        
        // Check if spot is within this receiver's band
        if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
        
        total++;
        
        // Check if callsign is already in unique list
        bool found = false;
        for (int j = 0; j < uniqueCallsignCount; j++) {
            if (strcmp(uniqueCallsigns[j], g_dxSpots[i].callsign) == 0) {
                found = true;
                break;
            }
        }
        
        if (!found && uniqueCallsignCount < MAX_DX_SPOTS) {
            strcpy_s(uniqueCallsigns[uniqueCallsignCount], sizeof(uniqueCallsigns[uniqueCallsignCount]), g_dxSpots[i].callsign);
            uniqueCallsignCount++;
        }
    }
    
    *uniqueCount = uniqueCallsignCount;
    *totalCount = total;
}

// Update spot count displays for all receivers with median offset
void UpdateSpotCounts()
{
    if (g_hDlg == NULL) return;
    if (g_pStatus == NULL) return;
    
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        if (!g_pStatus->receivers[i].active) {
            SetDlgItemTextA(g_hDlg, IDC_RX0_SPOTS + i, "-");
            continue;
        }
        
        int sampleRate = g_pStatus->sampleRate;
        int centerFreq = g_pStatus->receivers[i].frequency;
        int bandMinFreq = centerFreq - sampleRate / 2;
        int bandMaxFreq = centerFreq + sampleRate / 2;
        
        int uniqueCount = 0;
        int totalCount = 0;
        int offsets[MAX_DX_SPOTS];
        int measuredCount = 0;
        
        // Track unique callsigns
        char uniqueCallsigns[MAX_DX_SPOTS][16];
        
        for (int j = 0; j < g_dxSpotCount; j++) {
            if (!g_dxSpots[j].active) continue;
            
            int spotFreq = g_dxSpots[j].reportedFrequency;
            if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
            
            totalCount++;
            
            // Check if callsign is unique
            bool found = false;
            for (int k = 0; k < uniqueCount; k++) {
                if (strcmp(uniqueCallsigns[k], g_dxSpots[j].callsign) == 0) {
                    found = true;
                    break;
                }
            }
            if (!found && uniqueCount < MAX_DX_SPOTS) {
                strcpy_s(uniqueCallsigns[uniqueCount], sizeof(uniqueCallsigns[uniqueCount]), g_dxSpots[j].callsign);
                uniqueCount++;
            }
            
            // Collect offsets for measured spots
            // Use 1 Hz precision - median will average out DX cluster's 100 Hz quantization
            if (g_dxSpots[j].measured && g_dxSpots[j].actualFrequency > 0) {
                int offset = g_dxSpots[j].reportedFrequency - g_dxSpots[j].actualFrequency;
                offsets[measuredCount++] = offset;
            }
        }
        
        char buffer[128];  // Increased buffer size for safety
        char medianBuffer[64];  // Buffer for median offset display
        
        if (totalCount > 0) {
            if (measuredCount > 0) {
                // Sort offsets to find median
                for (int j = 0; j < measuredCount - 1; j++) {
                    for (int k = j + 1; k < measuredCount; k++) {
                        if (offsets[k] < offsets[j]) {
                            int temp = offsets[j];
                            offsets[j] = offsets[k];
                            offsets[k] = temp;
                        }
                    }
                }
                
                // Calculate median
                float medianOffset;
                if (measuredCount % 2 == 0) {
                    medianOffset = (offsets[measuredCount / 2 - 1] + offsets[measuredCount / 2]) / 2.0f;
                } else {
                    medianOffset = (float)offsets[measuredCount / 2];
                }
                
                // Display spot counts without offset
                sprintf_s(buffer, sizeof(buffer), "%d/%d", uniqueCount, totalCount);
                
                // Display median offset in separate field
                sprintf_s(medianBuffer, sizeof(medianBuffer), "%+.0f Hz", medianOffset);
                
                // Auto-offset functionality removed - replaced with Duration recording feature
            } else {
                // Show that we're waiting for measurements
                sprintf_s(buffer, sizeof(buffer), "%d/%d", uniqueCount, totalCount);
                sprintf_s(medianBuffer, sizeof(medianBuffer), "measuring...");
            }
        } else {
            strcpy_s(buffer, sizeof(buffer), "-");
            strcpy_s(medianBuffer, sizeof(medianBuffer), "-");
        }
        
        SetDlgItemTextA(g_hDlg, IDC_RX0_SPOTS + i, buffer);
        SetDlgItemTextA(g_hDlg, IDC_RX0_MEDIAN + i, medianBuffer);
    }
}

// Measure peak frequency for unmeasured spots with SNR checking and averaging
// Collects up to 10 measurements over 5 seconds, requiring minimum 10 dB SNR
void MeasureSpotPeakFrequency(int receiverID)
{
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return;
    
    SpectrumWindow* spec = &g_spectrumWindows[receiverID];
    // Don't check spec->active - we run FFT in background now
    
    DWORD currentTime = GetTickCount();
    int sampleRate = g_pStatus->sampleRate;
    int centerFreq = g_pStatus->receivers[receiverID].frequency;
    int bandMinFreq = centerFreq - sampleRate / 2;
    int bandMaxFreq = centerFreq + sampleRate / 2;
    
    // Minimum SNR required for valid measurement (10 dB above noise floor)
    const float MIN_SNR_DB = 10.0f;
    
    // Check each unmeasured spot
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (!g_dxSpots[i].active || g_dxSpots[i].measured) continue;
        
        // Check if spot is within 5 seconds of arrival (extended window for CW keying)
        DWORD age = currentTime - g_dxSpots[i].timestamp;
        if (age > 5000) {
            // Timed out after 5 seconds
            if (g_dxSpots[i].measurementCount > 0) {
                // We got some measurements - calculate average
                int sum = 0;
                for (int j = 0; j < g_dxSpots[i].measurementCount; j++) {
                    sum += g_dxSpots[i].measurementFreqs[j];
                }
                g_dxSpots[i].actualFrequency = sum / g_dxSpots[i].measurementCount;
            } else {
                // No valid measurements - mark as failed
                g_dxSpots[i].actualFrequency = 0;
            }
            g_dxSpots[i].measured = true;
            continue;
        }
        
        int spotFreq = g_dxSpots[i].reportedFrequency;
        if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
        
        // Skip if we already have maximum measurements
        if (g_dxSpots[i].measurementCount >= MAX_MEASUREMENTS) {
            // Calculate average and mark as complete
            int sum = 0;
            for (int j = 0; j < g_dxSpots[i].measurementCount; j++) {
                sum += g_dxSpots[i].measurementFreqs[j];
            }
            g_dxSpots[i].actualFrequency = sum / g_dxSpots[i].measurementCount;
            g_dxSpots[i].measured = true;
            continue;
        }
        
        // Find peak within ±150 Hz of reported frequency
        int searchWidth = 150;  // Hz
        int searchStart = spotFreq - searchWidth;
        int searchEnd = spotFreq + searchWidth;
        
        // Convert to FFT bins
        int fullMinFreq = centerFreq - sampleRate / 2;
        int binStart = (int)(((float)(searchStart - fullMinFreq) / sampleRate) * FFT_SIZE);
        int binEnd = (int)(((float)(searchEnd - fullMinFreq) / sampleRate) * FFT_SIZE);
        
        if (binStart < 0) binStart = 0;
        if (binEnd >= FFT_SIZE) binEnd = FFT_SIZE - 1;
        
        // Find peak in this range
        float maxDB = -200.0f;
        int peakBin = binStart;
        
        for (int bin = binStart; bin <= binEnd; bin++) {
            int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
            if (spec->magnitudeDB[shiftedBin] > maxDB) {
                maxDB = spec->magnitudeDB[shiftedBin];
                peakBin = bin;
            }
        }
        
        // Check SNR - only accept measurement if signal is strong enough
        float snr = maxDB - spec->noiseFloor;
        if (snr < MIN_SNR_DB) {
            // Signal too weak or not present - skip this measurement attempt
            // Will try again on next timer tick (30 Hz = every 33ms)
            continue;
        }
        
        // Valid signal detected - proceed with measurement
        
        // Use parabolic interpolation for sub-bin accuracy
        float binOffset = 0.0f;
        if (peakBin > binStart && peakBin < binEnd) {
            // Get the three points around the peak
            int leftBin = (peakBin - 1 + FFT_SIZE / 2) % FFT_SIZE;
            int centerBin = (peakBin + FFT_SIZE / 2) % FFT_SIZE;
            int rightBin = (peakBin + 1 + FFT_SIZE / 2) % FFT_SIZE;
            
            float left = spec->magnitudeDB[leftBin];
            float center = spec->magnitudeDB[centerBin];
            float right = spec->magnitudeDB[rightBin];
            
            // Parabolic interpolation formula
            // offset = 0.5 * (left - right) / (left - 2*center + right)
            float denominator = left - 2.0f * center + right;
            if (fabs(denominator) > 0.001f) {
                binOffset = 0.5f * (left - right) / denominator;
                // Clamp offset to reasonable range
                if (binOffset < -0.5f) binOffset = -0.5f;
                if (binOffset > 0.5f) binOffset = 0.5f;
            }
        }
        
        // Convert peak bin (with sub-bin offset) back to frequency
        float exactBin = peakBin + binOffset;
        int peakFreq = fullMinFreq + (int)(exactBin * sampleRate / FFT_SIZE);
        
        // Store this measurement
        g_dxSpots[i].measurementFreqs[g_dxSpots[i].measurementCount] = peakFreq;
        g_dxSpots[i].measurementCount++;
        
        // If we have enough measurements (at least 3), we can consider it measured
        // But continue collecting up to MAX_MEASUREMENTS for better averaging
        if (g_dxSpots[i].measurementCount >= 3) {
            // Calculate running average
            int sum = 0;
            for (int j = 0; j < g_dxSpots[i].measurementCount; j++) {
                sum += g_dxSpots[i].measurementFreqs[j];
            }
            g_dxSpots[i].actualFrequency = sum / g_dxSpots[i].measurementCount;
            // Don't mark as measured yet - keep collecting more measurements
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// Spots List Window Functions

// Spots window procedure
LRESULT CALLBACK SpotsWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    int receiverID = (int)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    
    switch (msg)
    {
    case WM_CREATE:
        {
            CREATESTRUCT* cs = (CREATESTRUCT*)lParam;
            receiverID = (int)(INT_PTR)cs->lpCreateParams;
            SetWindowLongPtr(hwnd, GWLP_USERDATA, receiverID);
            
            // Create static text for median offset and spot counts display
            CreateWindowExA(
                0,
                "STATIC",
                "Median Offset: calculating...",
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                10, 5, 700, 20,
                hwnd,
                (HMENU)2,
                g_hInst,
                NULL);
            
            // Create ListView control
            HWND hListView = CreateWindowExW(
                0,
                WC_LISTVIEWW,
                L"",
                WS_CHILD | WS_VISIBLE | WS_BORDER | LVS_REPORT | LVS_SINGLESEL,
                0, 30, 0, 0,  // Will be sized in WM_SIZE, starts at y=30 to leave room for label
                hwnd,
                (HMENU)1,
                g_hInst,
                NULL);
            
            if (hListView) {
                // Set extended styles
                ListView_SetExtendedListViewStyle(hListView, LVS_EX_FULLROWSELECT | LVS_EX_GRIDLINES);
                
                // Add columns
                LVCOLUMNA col = {0};
                col.mask = LVCF_TEXT | LVCF_WIDTH;
                
                col.pszText = "Time";
                col.cx = 80;
                ListView_InsertColumn(hListView, 0, &col);
                
                col.pszText = "Callsign";
                col.cx = 100;
                ListView_InsertColumn(hListView, 1, &col);
                
                col.pszText = "Reported";
                col.cx = 100;
                ListView_InsertColumn(hListView, 2, &col);
                
                col.pszText = "Actual";
                col.cx = 100;
                ListView_InsertColumn(hListView, 3, &col);
                
                col.pszText = "Offset";
                col.cx = 80;
                ListView_InsertColumn(hListView, 4, &col);
                
                // Initial update
                UpdateSpotsListView(receiverID);
            }
            
            // Start update timer (1 Hz)
            SetTimer(hwnd, 1, 1000, NULL);
        }
        return 0;
        
    case WM_TIMER:
        UpdateSpotsListView(receiverID);
        return 0;
        
    case WM_SIZE:
        {
            // Resize ListView to fill window below the label
            HWND hListView = GetDlgItem(hwnd, 1);
            if (hListView) {
                RECT rect;
                GetClientRect(hwnd, &rect);
                SetWindowPos(hListView, NULL, 0, 30, rect.right, rect.bottom - 30, SWP_NOZORDER);
            }
        }
        return 0;
        
    case WM_CLOSE:
        CloseSpotsWindow(receiverID);
        return 0;
        
    case WM_DESTROY:
        KillTimer(hwnd, 1);
        return 0;
    }
    
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

// Update spots list view
void UpdateSpotsListView(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (!g_spectrumWindows[receiverID].active) return;
    
    HWND hSpotsWnd = g_spectrumWindows[receiverID].hSpotsWnd;
    if (!hSpotsWnd || !IsWindow(hSpotsWnd)) return;
    
    HWND hListView = GetDlgItem(hSpotsWnd, 1);
    if (!hListView) return;
    
    // Get receiver frequency range
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return;
    
    int sampleRate = g_pStatus->sampleRate;
    int centerFreq = g_pStatus->receivers[receiverID].frequency;
    int bandMinFreq = centerFreq - sampleRate / 2;
    int bandMaxFreq = centerFreq + sampleRate / 2;
    
    // Clear list
    ListView_DeleteAllItems(hListView);
    
    // Calculate median offset and count spots for this receiver's band
    int offsets[MAX_DX_SPOTS];
    int measuredCount = 0;
    int totalCount = 0;
    char uniqueCallsigns[MAX_DX_SPOTS][16];
    int uniqueCount = 0;
    
    for (int i = 0; i < g_dxSpotCount; i++) {
        if (!g_dxSpots[i].active) continue;
        
        int spotFreq = g_dxSpots[i].reportedFrequency;
        if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
        
        totalCount++;
        
        // Track unique callsigns
        bool found = false;
        for (int j = 0; j < uniqueCount; j++) {
            if (strcmp(uniqueCallsigns[j], g_dxSpots[i].callsign) == 0) {
                found = true;
                break;
            }
        }
        if (!found && uniqueCount < MAX_DX_SPOTS) {
            strcpy_s(uniqueCallsigns[uniqueCount], sizeof(uniqueCallsigns[uniqueCount]), g_dxSpots[i].callsign);
            uniqueCount++;
        }
        
        if (g_dxSpots[i].measured && g_dxSpots[i].actualFrequency > 0) {
            // Use 1 Hz precision - median will average out DX cluster's 100 Hz quantization
            int offset = g_dxSpots[i].reportedFrequency - g_dxSpots[i].actualFrequency;
            offsets[measuredCount++] = offset;
        }
    }
    
    // Update median offset label with spot counts
    HWND hLabel = GetDlgItem(hSpotsWnd, 2);
    if (hLabel) {
        char labelText[256];
        if (measuredCount > 0) {
            // Sort offsets to find median
            for (int i = 0; i < measuredCount - 1; i++) {
                for (int j = i + 1; j < measuredCount; j++) {
                    if (offsets[j] < offsets[i]) {
                        int temp = offsets[i];
                        offsets[i] = offsets[j];
                        offsets[j] = temp;
                    }
                }
            }
            
            // Calculate median
            float medianOffset;
            if (measuredCount % 2 == 0) {
                medianOffset = (offsets[measuredCount / 2 - 1] + offsets[measuredCount / 2]) / 2.0f;
            } else {
                medianOffset = (float)offsets[measuredCount / 2];
            }
            
            sprintf_s(labelText, sizeof(labelText), "Median Offset: %+.1f Hz | Spots: %d unique / %d total (%d measured)",
                     medianOffset, uniqueCount, totalCount, measuredCount);
        } else {
            sprintf_s(labelText, sizeof(labelText), "Median Offset: no measured spots yet | Spots: %d unique / %d total",
                     uniqueCount, totalCount);
        }
        SetWindowTextA(hLabel, labelText);
    }
    
    // Add spots (newest first) - only show spots that were actually measured
    int itemIndex = 0;
    for (int i = g_dxSpotCount - 1; i >= 0; i--) {
        if (!g_dxSpots[i].active) continue;
        
        // Only show spots that were actually measured (actualFrequency > 0)
        if (!g_dxSpots[i].measured || g_dxSpots[i].actualFrequency == 0) continue;
        
        int spotFreq = g_dxSpots[i].reportedFrequency;
        if (spotFreq < bandMinFreq || spotFreq > bandMaxFreq) continue;
        
        // Convert timestamp to local time
        DWORD timestamp = g_dxSpots[i].timestamp;
        SYSTEMTIME st;
        GetLocalTime(&st);  // Get current local time as base
        
        // Calculate time from timestamp (GetTickCount wraps every 49.7 days)
        // For display purposes, we'll show the time the spot was received
        // We need to convert the tick count to actual time
        DWORD currentTick = GetTickCount();
        DWORD ageTicks = currentTick - timestamp;
        
        // Subtract age from current time to get spot time
        FILETIME ft, localFt;
        GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER uli;
        uli.LowPart = ft.dwLowDateTime;
        uli.HighPart = ft.dwHighDateTime;
        
        // Subtract age in 100-nanosecond intervals (1 tick = 1 ms = 10000 * 100ns)
        uli.QuadPart -= (ULONGLONG)ageTicks * 10000ULL;
        
        ft.dwLowDateTime = uli.LowPart;
        ft.dwHighDateTime = uli.HighPart;
        
        // Convert to local time
        FileTimeToLocalFileTime(&ft, &localFt);
        FileTimeToSystemTime(&localFt, &st);
        
        // Add item
        LVITEMA item = {0};
        item.mask = LVIF_TEXT;
        item.iItem = itemIndex;
        
        // Column 0: Time (HH:MM:SS)
        char buffer[32];
        sprintf_s(buffer, sizeof(buffer), "%02d:%02d:%02d", st.wHour, st.wMinute, st.wSecond);
        item.iSubItem = 0;
        item.pszText = buffer;
        ListView_InsertItem(hListView, &item);
        
        // Column 1: Callsign
        item.iSubItem = 1;
        item.pszText = g_dxSpots[i].callsign;
        ListView_SetItem(hListView, &item);
        
        // Column 2: Reported frequency
        sprintf_s(buffer, sizeof(buffer), "%.1f", g_dxSpots[i].reportedFrequency / 1000.0f);
        item.iSubItem = 2;
        item.pszText = buffer;
        ListView_SetItem(hListView, &item);
        
        // Column 3: Actual frequency
        if (g_dxSpots[i].measured && g_dxSpots[i].actualFrequency > 0) {
            sprintf_s(buffer, sizeof(buffer), "%.1f", g_dxSpots[i].actualFrequency / 1000.0f);
        } else {
            strcpy_s(buffer, sizeof(buffer), "-");
        }
        item.iSubItem = 3;
        item.pszText = buffer;
        ListView_SetItem(hListView, &item);
        
        // Column 4: Offset (reported - actual, so positive means need to tune higher)
        // Use 1 Hz precision for better median accuracy
        if (g_dxSpots[i].measured && g_dxSpots[i].actualFrequency > 0) {
            int offset = g_dxSpots[i].reportedFrequency - g_dxSpots[i].actualFrequency;
            sprintf_s(buffer, sizeof(buffer), "%+d", offset);
        } else {
            strcpy_s(buffer, sizeof(buffer), "-");
        }
        item.iSubItem = 4;
        item.pszText = buffer;
        ListView_SetItem(hListView, &item);
        
        itemIndex++;
    }
}

// Show spots window for a receiver
void ShowSpotsWindow(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (!g_spectrumWindows[receiverID].active) return;
    
    // If window already exists, bring it to front
    if (g_spectrumWindows[receiverID].hSpotsWnd != NULL &&
        IsWindow(g_spectrumWindows[receiverID].hSpotsWnd)) {
        SetForegroundWindow(g_spectrumWindows[receiverID].hSpotsWnd);
        return;
    }
    
    // Register window class if not already registered
    static bool classRegistered = false;
    if (!classRegistered) {
        WNDCLASSA wc = {0};
        wc.lpfnWndProc = SpotsWindowProc;
        wc.hInstance = g_hInst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.lpszClassName = "UberSDRSpotsWindow";
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        RegisterClassA(&wc);
        classRegistered = true;
    }
    
    // Create window
    char title[128];
    sprintf_s(title, sizeof(title), "Spots - Receiver %d", receiverID);
    
    HWND hwnd = CreateWindowExA(
        0,
        "UberSDRSpotsWindow",
        title,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT,
        500, 400,
        NULL,
        NULL,
        g_hInst,
        (LPVOID)(INT_PTR)receiverID);
    
    if (hwnd == NULL) {
        return;
    }
    
    g_spectrumWindows[receiverID].hSpotsWnd = hwnd;
    
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
}

// Close spots window
void CloseSpotsWindow(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    
    if (g_spectrumWindows[receiverID].hSpotsWnd != NULL) {
        DestroyWindow(g_spectrumWindows[receiverID].hSpotsWnd);
        g_spectrumWindows[receiverID].hSpotsWnd = NULL;
    }
}

// Process telnet connection and data
void ProcessTelnet()
{
    DWORD currentTime = GetTickCount();
    
    // If no socket, don't auto-reconnect (user must click Connect button)
    if (g_telnetSocket == INVALID_SOCKET) {
        return;
    }
    
    // Check if connection is established
    if (!g_telnetConnected) {
        fd_set writeSet, errorSet;
        FD_ZERO(&writeSet);
        FD_ZERO(&errorSet);
        FD_SET(g_telnetSocket, &writeSet);
        FD_SET(g_telnetSocket, &errorSet);
        
        timeval timeout = {0, 0};
        int result = select(0, NULL, &writeSet, &errorSet, &timeout);
        
        if (result > 0) {
            if (FD_ISSET(g_telnetSocket, &errorSet)) {
                // Connection failed
                AppendTelnetText("Connection failed\r\n");
                closesocket(g_telnetSocket);
                g_telnetSocket = INVALID_SOCKET;
                g_lastReconnectAttempt = currentTime;
                return;
            }
            if (FD_ISSET(g_telnetSocket, &writeSet)) {
                // Connection established
                g_telnetConnected = true;
                AppendTelnetText("Connected!\r\n");
            }
        }
        return;
    }
    
    // Read available data
    char buffer[1024];
    int received = recv(g_telnetSocket, buffer, sizeof(buffer) - 1, 0);
    
    if (received > 0) {
        buffer[received] = '\0';
        
        // Append to internal buffer for prompt detection
        if (g_telnetBufferLen + received < sizeof(g_telnetBuffer) - 1) {
            memcpy(g_telnetBuffer + g_telnetBufferLen, buffer, received);
            g_telnetBufferLen += received;
            g_telnetBuffer[g_telnetBufferLen] = '\0';
        }
        
        // Display received data
        AppendTelnetText(buffer);
        
        // Parse each line for DX spots
        char* lineStart = buffer;
        char* lineEnd;
        while ((lineEnd = strstr(lineStart, "\n")) != NULL) {
            *lineEnd = '\0';
            ParseDXSpotLine(lineStart);
            lineStart = lineEnd + 1;
        }
        // Parse last line if no newline at end
        if (*lineStart != '\0') {
            ParseDXSpotLine(lineStart);
        }
        
        // Clean up old spots periodically
        CleanupOldSpots();
        
        // Check for callsign prompt and send response if not already sent
        if (!g_telnetCallsignSent &&
            strstr(g_telnetBuffer, "Please enter your callsign:") != NULL) {
            const char* callsign = "N0CALL\r\n";
            int sent = send(g_telnetSocket, callsign, (int)strlen(callsign), 0);
            if (sent > 0) {
                g_telnetCallsignSent = true;
                AppendTelnetText(">>> Sent: N0CALL\r\n");
            }
        }
    }
    else if (received == 0) {
        // Connection closed gracefully
        AppendTelnetText("Connection closed by server\r\n");
        closesocket(g_telnetSocket);
        g_telnetSocket = INVALID_SOCKET;
        g_telnetConnected = false;
        // Re-enable Connect button
        EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_CONNECT), TRUE);
        EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_DISCONNECT), FALSE);
    }
    else {
        // Check for error
        int error = WSAGetLastError();
        if (error != WSAEWOULDBLOCK) {
            // Real error occurred
            char errorMsg[128];
            sprintf_s(errorMsg, sizeof(errorMsg), "Connection error: %d\r\n", error);
            AppendTelnetText(errorMsg);
            closesocket(g_telnetSocket);
            g_telnetSocket = INVALID_SOCKET;
            g_telnetConnected = false;
            // Re-enable Connect button
            EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_CONNECT), TRUE);
            EnableWindow(GetDlgItem(g_hDlg, IDC_TELNET_DISCONNECT), FALSE);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// Spectrum Display Functions

// Initialize Hanning window coefficients
void InitHanningWindow(float* window, int size)
{
    for (int i = 0; i < size; i++) {
        window[i] = 0.5f * (1.0f - cosf(2.0f * PI * i / (size - 1)));
    }
}

// Simple Cooley-Tukey FFT implementation (radix-2, in-place)
void PerformFFT(Complex* data, int size)
{
    // Bit-reversal permutation
    int j = 0;
    for (int i = 0; i < size - 1; i++) {
        if (i < j) {
            Complex temp = data[i];
            data[i] = data[j];
            data[j] = temp;
        }
        int k = size / 2;
        while (k <= j) {
            j -= k;
            k /= 2;
        }
        j += k;
    }
    
    // FFT computation
    for (int len = 2; len <= size; len *= 2) {
        float angle = -2.0f * PI / len;
        Complex wlen = { cosf(angle), sinf(angle) };
        
        for (int i = 0; i < size; i += len) {
            Complex w = { 1.0f, 0.0f };
            for (int j = 0; j < len / 2; j++) {
                Complex u = data[i + j];
                Complex v = {
                    data[i + j + len / 2].real * w.real - data[i + j + len / 2].imag * w.imag,
                    data[i + j + len / 2].real * w.imag + data[i + j + len / 2].imag * w.real
                };
                
                data[i + j].real = u.real + v.real;
                data[i + j].imag = u.imag + v.imag;
                data[i + j + len / 2].real = u.real - v.real;
                data[i + j + len / 2].imag = u.imag - v.imag;
                
                float w_temp = w.real * wlen.real - w.imag * wlen.imag;
                w.imag = w.real * wlen.imag + w.imag * wlen.real;
                w.real = w_temp;
            }
        }
    }
}

// Compare function for qsort
int CompareFloat(const void* a, const void* b)
{
    float fa = *(const float*)a;
    float fb = *(const float*)b;
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return 0;
}

// Calculate noise floor using 10th percentile method (reliable for signals present)
float CalculateNoiseFloor(const float* magnitudeDB, int size)
{
    // Create a copy for sorting
    float* sorted = (float*)malloc(size * sizeof(float));
    if (sorted == NULL) return -100.0f;
    
    memcpy(sorted, magnitudeDB, size * sizeof(float));
    
    // Sort the array
    qsort(sorted, size, sizeof(float), CompareFloat);
    
    // Use 10th percentile as noise floor (robust against signals)
    int percentileIndex = (int)(size * 0.10f);
    if (percentileIndex >= size) percentileIndex = size - 1;
    
    float noiseFloor = sorted[percentileIndex];
    
    free(sorted);
    return noiseFloor;
}

// Compute spectrum from IQ data
void ComputeSpectrum(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return;
    
    SpectrumWindow* spec = &g_spectrumWindows[receiverID];
    
    // Read IQ samples from circular buffer
    int32_t writePos = g_pStatus->receivers[receiverID].iqBufferWritePos;
    int32_t readPos = (writePos - FFT_SIZE * 2 + IQ_BUFFER_SIZE) % IQ_BUFFER_SIZE;
    
    // Ensure we have valid data
    if (readPos < 0) readPos += IQ_BUFFER_SIZE;
    
    // Copy samples and apply window
    for (int i = 0; i < FFT_SIZE; i++) {
        int bufIdx = (readPos + i * 2) % IQ_BUFFER_SIZE;
        
        // Convert int16 to float and normalize (-1.0 to +1.0)
        float I = g_pStatus->receivers[receiverID].iqBuffer[bufIdx] / 32768.0f;
        float Q = g_pStatus->receivers[receiverID].iqBuffer[bufIdx + 1] / 32768.0f;
        
        // Apply Hanning window
        spec->fftBuffer[i].real = I * spec->window[i];
        spec->fftBuffer[i].imag = Q * spec->window[i];
    }
    
    // Perform FFT
    PerformFFT(spec->fftBuffer, FFT_SIZE);
    
    // Compute magnitude in dB with proper scaling
    // FFT output needs to be scaled by 1/N for proper magnitude
    float scale = 1.0f / FFT_SIZE;
    
    for (int i = 0; i < FFT_SIZE; i++) {
        float real = spec->fftBuffer[i].real * scale;
        float imag = spec->fftBuffer[i].imag * scale;
        float magnitude = sqrtf(real * real + imag * imag);
        
        // Convert to dBFS (dB relative to full scale)
        // Add small value to avoid log(0), then convert to dB
        if (magnitude < 1e-10f) magnitude = 1e-10f;
        
        // For IQ data, we want power spectrum, so use 10*log10(mag^2) = 20*log10(mag)
        // Reference level is 1.0 (full scale), so this gives dBFS
        spec->magnitudeDB[i] = 20.0f * log10f(magnitude);
    }
    
    // Calculate noise floor using 10th percentile method
    spec->noiseFloor = CalculateNoiseFloor(spec->magnitudeDB, FFT_SIZE);
    
    // Find actual maximum value in spectrum
    float currentMax = spec->magnitudeDB[0];
    for (int i = 1; i < FFT_SIZE; i++) {
        if (spec->magnitudeDB[i] > currentMax) {
            currentMax = spec->magnitudeDB[i];
        }
    }
    
    // Smooth the max/min values with exponential moving average
    // Alpha = 0.05 for very slow, smooth transitions
    float alpha = 0.05f;
    if (spec->smoothedMaxDB == 0.0f && spec->smoothedMinDB == 0.0f) {
        // Initialize on first run
        spec->smoothedMaxDB = currentMax + 5.0f;  // Add headroom above peak
        spec->smoothedMinDB = spec->noiseFloor - 3.0f;  // Small headroom below noise floor
    } else {
        // Smooth updates - only increase max quickly, decrease slowly
        float targetMax = currentMax + 5.0f;
        if (targetMax > spec->smoothedMaxDB) {
            // Increase faster
            spec->smoothedMaxDB = 0.2f * targetMax + 0.8f * spec->smoothedMaxDB;
        } else {
            // Decrease slower
            spec->smoothedMaxDB = alpha * targetMax + (1.0f - alpha) * spec->smoothedMaxDB;
        }
        
        // Smooth min value - keep close to noise floor
        float targetMin = spec->noiseFloor - 3.0f;
        spec->smoothedMinDB = alpha * targetMin + (1.0f - alpha) * spec->smoothedMinDB;
    }
}

// FT8 frequencies for HF ham bands (in Hz)
struct FT8Band {
    int minFreq;
    int maxFreq;
    int ft8Freq;
    const char* name;
};

static const FT8Band ft8Bands[] = {
    { 1800000, 2000000, 1840000, "160m" },    // 160m: 1.840 MHz
    { 3500000, 4000000, 3573000, "80m" },     // 80m: 3.573 MHz
    { 5330000, 5405000, 5357000, "60m" },     // 60m: 5.357 MHz
    { 7000000, 7300000, 7074000, "40m" },     // 40m: 7.074 MHz
    { 10100000, 10150000, 10136000, "30m" },  // 30m: 10.136 MHz
    { 14000000, 14350000, 14074000, "20m" },  // 20m: 14.074 MHz
    { 18068000, 18168000, 18100000, "17m" },  // 17m: 18.100 MHz
    { 21000000, 21450000, 21074000, "15m" },  // 15m: 21.074 MHz
    { 24890000, 24990000, 24915000, "12m" },  // 12m: 24.915 MHz
    { 28000000, 29700000, 28074000, "10m" },  // 10m: 28.074 MHz
    { 50000000, 54000000, 50313000, "6m" },   // 6m: 50.313 MHz
};

// Draw spectrum display
void DrawSpectrum(HWND hwnd, HDC hdc, int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) return;
    
    SpectrumWindow* spec = &g_spectrumWindows[receiverID];
    
    RECT rect;
    GetClientRect(hwnd, &rect);
    
    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;
    
    // Margins
    int marginLeft = 60;
    int marginRight = 20;
    int marginTop = 40;
    int marginBottom = 40;
    
    int plotWidth = width - marginLeft - marginRight;
    int plotHeight = height - marginTop - marginBottom;
    
    // Clear background
    HBRUSH bgBrush = CreateSolidBrush(RGB(0, 0, 0));
    FillRect(hdc, &rect, bgBrush);
    DeleteObject(bgBrush);
    
    // Get frequency range with zoom applied
    int sampleRate = g_pStatus->sampleRate;
    int centerFreq = g_pStatus->receivers[receiverID].frequency;
    int minFreq, maxFreq;
    
    // Calculate actual spectrum boundaries
    int spectrumMinFreq = centerFreq - sampleRate / 2;
    int spectrumMaxFreq = centerFreq + sampleRate / 2;
    
    // Apply zoom
    if (spec->zoomFactor > 1.0f && spec->zoomCenterFreq != 0) {
        // Zoom centered on last marker
        int zoomedSpan = (int)(sampleRate / spec->zoomFactor);
        minFreq = spec->zoomCenterFreq - zoomedSpan / 2;
        maxFreq = spec->zoomCenterFreq + zoomedSpan / 2;
        
        // Clamp to spectrum boundaries to avoid empty space
        if (minFreq < spectrumMinFreq) {
            int shift = spectrumMinFreq - minFreq;
            minFreq = spectrumMinFreq;
            maxFreq += shift;
            if (maxFreq > spectrumMaxFreq) maxFreq = spectrumMaxFreq;
        }
        if (maxFreq > spectrumMaxFreq) {
            int shift = maxFreq - spectrumMaxFreq;
            maxFreq = spectrumMaxFreq;
            minFreq -= shift;
            if (minFreq < spectrumMinFreq) minFreq = spectrumMinFreq;
        }
    } else {
        // Normal view
        minFreq = spectrumMinFreq;
        maxFreq = spectrumMaxFreq;
    }
    
    // Draw noise floor info and markers in top right (fixed position, left-aligned)
    SetTextColor(hdc, RGB(200, 200, 200));
    SetBkMode(hdc, TRANSPARENT);
    char noiseFloorText[64];
    sprintf_s(noiseFloorText, sizeof(noiseFloorText), "Noise Floor: %.1f dB", spec->noiseFloor);
    int infoX = width - 380;  // Fixed X position from right edge
    int infoY = 10;
    TextOutA(hdc, infoX, infoY, noiseFloorText, (int)strlen(noiseFloorText));
    infoY += 20;
    
    // Draw marker info with fixed-width formatting to prevent jitter
    for (int i = 0; i < spec->markerCount; i++) {
        if (spec->markers[i].active) {
            char markerText[128];
            if (spec->markers[i].frequency >= 1000000) {
                sprintf_s(markerText, sizeof(markerText), "M%d: %9.3f MHz | %6.1f dB | SNR: %6.1f dB",
                         i + 1, spec->markers[i].frequency / 1000000.0,
                         spec->markers[i].signalDB, spec->markers[i].snr);
            } else if (spec->markers[i].frequency >= 1000) {
                sprintf_s(markerText, sizeof(markerText), "M%d: %9.1f kHz | %6.1f dB | SNR: %6.1f dB",
                         i + 1, spec->markers[i].frequency / 1000.0,
                         spec->markers[i].signalDB, spec->markers[i].snr);
            } else {
                sprintf_s(markerText, sizeof(markerText), "M%d: %9d Hz | %6.1f dB | SNR: %6.1f dB",
                         i + 1, spec->markers[i].frequency,
                         spec->markers[i].signalDB, spec->markers[i].snr);
            }
            TextOutA(hdc, infoX, infoY, markerText, (int)strlen(markerText));
            infoY += 20;
        }
    }
    
    // Check if FT8 frequency is visible and draw highlight
    for (int i = 0; i < sizeof(ft8Bands) / sizeof(ft8Bands[0]); i++) {
        int ft8Freq = ft8Bands[i].ft8Freq;
        int ft8Width = 3000;  // FT8 bandwidth is ~3 kHz
        
        // Check if FT8 frequency range is visible in current display
        // Show marker whenever FT8 frequency is visible, regardless of where we're tuned
        if (ft8Freq + ft8Width >= minFreq && ft8Freq - ft8Width <= maxFreq) {
            // Also check if FT8 frequency is within the receiver's actual spectrum range
            if (ft8Freq >= spectrumMinFreq && ft8Freq <= spectrumMaxFreq) {
                // Calculate pixel positions for FT8 range
                int ft8StartFreq = ft8Freq;
                int ft8EndFreq = ft8Freq + ft8Width;
                
                // Map frequencies to X coordinates using the visible frequency range
                int visibleSpan = maxFreq - minFreq;
                float freqToX = (float)plotWidth / (float)visibleSpan;
                int x1 = marginLeft + (int)((ft8StartFreq - minFreq) * freqToX);
                int x2 = marginLeft + (int)((ft8EndFreq - minFreq) * freqToX);
                
                // Clamp to plot area
                if (x1 < marginLeft) x1 = marginLeft;
                if (x2 > marginLeft + plotWidth) x2 = marginLeft + plotWidth;
                
                // Draw semi-transparent yellow highlight
                RECT highlightRect;
                highlightRect.left = x1;
                highlightRect.top = marginTop;
                highlightRect.right = x2;
                highlightRect.bottom = marginTop + plotHeight;
                
                // Create semi-transparent yellow brush
                HBRUSH ft8Brush = CreateSolidBrush(RGB(255, 255, 0));
                
                // Set transparency (blend mode)
                BLENDFUNCTION blend = {0};
                blend.BlendOp = AC_SRC_OVER;
                blend.SourceConstantAlpha = 64;  // 25% opacity (0-255)
                blend.AlphaFormat = 0;
                
                // Create memory DC for alpha blending
                HDC tempDC = CreateCompatibleDC(hdc);
                HBITMAP tempBitmap = CreateCompatibleBitmap(hdc, x2 - x1, plotHeight);
                HBITMAP oldBitmap = (HBITMAP)SelectObject(tempDC, tempBitmap);
                
                // Fill temp bitmap with yellow
                RECT tempRect = {0, 0, x2 - x1, plotHeight};
                FillRect(tempDC, &tempRect, ft8Brush);
                
                // Blend to main DC
                AlphaBlend(hdc, x1, marginTop, x2 - x1, plotHeight,
                          tempDC, 0, 0, x2 - x1, plotHeight, blend);
                
                // Cleanup
                SelectObject(tempDC, oldBitmap);
                DeleteObject(tempBitmap);
                DeleteDC(tempDC);
                DeleteObject(ft8Brush);
                
                // Calculate FT8 signal level (average in FT8 range)
                int ft8BinStart = (int)((ft8StartFreq - minFreq) * FFT_SIZE / (float)sampleRate);
                int ft8BinEnd = (int)((ft8EndFreq - minFreq) * FFT_SIZE / (float)sampleRate);
                if (ft8BinStart < 0) ft8BinStart = 0;
                if (ft8BinEnd >= FFT_SIZE) ft8BinEnd = FFT_SIZE - 1;
                
                float ft8SignalSum = 0.0f;
                int ft8BinCount = 0;
                for (int bin = ft8BinStart; bin <= ft8BinEnd; bin++) {
                    int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
                    ft8SignalSum += spec->magnitudeDB[shiftedBin];
                    ft8BinCount++;
                }
                float ft8SignalLevel = (ft8BinCount > 0) ? (ft8SignalSum / ft8BinCount) : spec->noiseFloor;
                float ft8SNR = ft8SignalLevel - spec->noiseFloor;
                
                // Draw FT8 label with SNR
                SetTextColor(hdc, RGB(255, 255, 0));
                SetBkMode(hdc, TRANSPARENT);
                char ft8Label[64];
                sprintf_s(ft8Label, sizeof(ft8Label), "FT8 %s", ft8Bands[i].name);
                TextOutA(hdc, x1 + 5, marginTop + 5, ft8Label, (int)strlen(ft8Label));
                
                // Draw SNR below the band label
                char snrLabel[64];
                sprintf_s(snrLabel, sizeof(snrLabel), "SNR: %.1f dB", ft8SNR);
                TextOutA(hdc, x1 + 5, marginTop + 20, snrLabel, (int)strlen(snrLabel));
            }
            break;  // Only one band matches
        }
    }
    
    // Draw title
    SetTextColor(hdc, RGB(255, 255, 255));
    SetBkMode(hdc, TRANSPARENT);
    char title[128];
    char freqStr[64];
    FormatFrequency(g_pStatus->receivers[receiverID].frequency, freqStr, sizeof(freqStr));
    if (spec->zoomFactor > 1.0f) {
        sprintf_s(title, sizeof(title), "Spectrum - Receiver %d - %s @ %d Hz (Zoom: %.1fx)",
                  receiverID, freqStr, g_pStatus->sampleRate, spec->zoomFactor);
    } else {
        sprintf_s(title, sizeof(title), "Spectrum - Receiver %d - %s @ %d Hz",
                  receiverID, freqStr, g_pStatus->sampleRate);
    }
    TextOutA(hdc, marginLeft, 10, title, (int)strlen(title));
    
    // Draw zoom controls in top left
    SetTextColor(hdc, RGB(200, 200, 200));
    const char* zoomHelp = "[+] Zoom In  [-] Zoom Out  [Scroll Wheel] Zoom";
    TextOutA(hdc, marginLeft, 25, zoomHelp, (int)strlen(zoomHelp));
    
    // Draw grid and axes
    HPEN gridPen = CreatePen(PS_SOLID, 1, RGB(40, 40, 40));
    HPEN axisPen = CreatePen(PS_SOLID, 1, RGB(100, 100, 100));
    HPEN spectrumPen = CreatePen(PS_SOLID, 2, RGB(0, 255, 0));
    
    // Y-axis (dB scale: auto-scale with smoothing)
    float minDB = spec->smoothedMinDB;
    float maxDB = spec->smoothedMaxDB;
    
    // Round to nearest 10 dB for cleaner display
    minDB = floorf(minDB / 10.0f) * 10.0f;
    maxDB = ceilf(maxDB / 10.0f) * 10.0f;
    
    // Clamp to reasonable range
    if (minDB < -120.0f) minDB = -120.0f;
    if (minDB > -40.0f) minDB = -40.0f;
    if (maxDB > 0.0f) maxDB = 0.0f;
    if (maxDB < -80.0f) maxDB = -80.0f;
    
    // Ensure minimum range of 20 dB
    if (maxDB - minDB < 20.0f) {
        maxDB = minDB + 20.0f;
        if (maxDB > 0.0f) {
            maxDB = 0.0f;
            minDB = maxDB - 20.0f;
        }
    }
    
    SelectObject(hdc, axisPen);
    MoveToEx(hdc, marginLeft, marginTop, NULL);
    LineTo(hdc, marginLeft, marginTop + plotHeight);
    LineTo(hdc, marginLeft + plotWidth, marginTop + plotHeight);
    
    // Y-axis labels and grid (dynamic based on scale)
    SelectObject(hdc, gridPen);
    int dbRange = (int)(maxDB - minDB);
    int dbStep = 20;
    
    // Adjust step size for smaller ranges
    if (dbRange <= 40) dbStep = 10;
    if (dbRange <= 20) dbStep = 5;
    
    // Start from rounded value
    int startDB = ((int)minDB / dbStep) * dbStep;
    
    for (int db = startDB; db <= (int)maxDB; db += dbStep) {
        if (db < minDB || db > maxDB) continue;
        
        int y = marginTop + (int)((maxDB - db) / (maxDB - minDB) * plotHeight);
        
        // Grid line
        MoveToEx(hdc, marginLeft, y, NULL);
        LineTo(hdc, marginLeft + plotWidth, y);
        
        // Label
        char label[16];
        sprintf_s(label, sizeof(label), "%d dB", db);
        TextOutA(hdc, 5, y - 7, label, (int)strlen(label));
    }
    
    // X-axis labels (frequency) - use zoomed frequency range
    int visibleSpan = maxFreq - minFreq;
    for (int i = 0; i <= 4; i++) {
        int x = marginLeft + (plotWidth * i) / 4;
        int freq = minFreq + (visibleSpan * i) / 4;
        
        char label[32];
        if (abs(freq) >= 1000000) {
            sprintf_s(label, sizeof(label), "%.3f", freq / 1000000.0f);
        } else if (abs(freq) >= 1000) {
            sprintf_s(label, sizeof(label), "%.1f", freq / 1000.0f);
        } else {
            sprintf_s(label, sizeof(label), "%d", freq);
        }
        
        SIZE textSize;
        GetTextExtentPoint32A(hdc, label, (int)strlen(label), &textSize);
        TextOutA(hdc, x - textSize.cx / 2, marginTop + plotHeight + 5, label, (int)strlen(label));
    }
    
    // X-axis unit label
    int midFreq = (minFreq + maxFreq) / 2;
    const char* unit = (abs(midFreq) >= 1000000) ? "MHz" : "kHz";
    TextOutA(hdc, marginLeft + plotWidth / 2 - 10, marginTop + plotHeight + 20, unit, (int)strlen(unit));
    
    // Draw spectrum
    SelectObject(hdc, spectrumPen);
    
    // Calculate which FFT bins correspond to the visible frequency range
    int fullMinFreq = centerFreq - sampleRate / 2;
    int fullMaxFreq = centerFreq + sampleRate / 2;
    
    bool firstPoint = true;
    for (int x = 0; x < plotWidth; x++) {
        // Map screen X position to frequency
        float freqAtX = minFreq + (x / (float)plotWidth) * (maxFreq - minFreq);
        
        // Map frequency to FFT bin
        float binFloat = ((freqAtX - fullMinFreq) / (float)sampleRate) * FFT_SIZE;
        int bin = (int)binFloat;
        
        if (bin < 0 || bin >= FFT_SIZE) continue;
        
        // Shift bin for FFT output order
        int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
        
        float db = spec->magnitudeDB[shiftedBin];
        
        // Clamp to display range
        if (db < minDB) db = minDB;
        if (db > maxDB) db = maxDB;
        
        int screenX = marginLeft + x;
        int y = marginTop + (int)((maxDB - db) / (maxDB - minDB) * plotHeight);
        
        if (firstPoint) {
            MoveToEx(hdc, screenX, y, NULL);
            firstPoint = false;
        } else {
            LineTo(hdc, screenX, y);
        }
    }
    
    // Draw marker lines
    for (int i = 0; i < spec->markerCount; i++) {
        if (spec->markers[i].active) {
            HPEN markerPen = CreatePen(PS_SOLID, 2, RGB(255, 0, 0));
            SelectObject(hdc, markerPen);
            MoveToEx(hdc, spec->markers[i].x, marginTop, NULL);
            LineTo(hdc, spec->markers[i].x, marginTop + plotHeight);
            DeleteObject(markerPen);
            
            // Draw marker number
            SetTextColor(hdc, RGB(255, 0, 0));
            char markerNum[8];
            sprintf_s(markerNum, sizeof(markerNum), "M%d", i + 1);
            TextOutA(hdc, spec->markers[i].x + 3, marginTop + 5, markerNum, (int)strlen(markerNum));
        }
    }
    
    // Draw DX cluster spots
    DrawDXSpots(hdc, receiverID, marginLeft, marginTop, plotWidth, plotHeight, minFreq, maxFreq);
    
    // Draw cursor line if mouse is in plot area
    if (spec->mouseInPlot && spec->lastMouseX >= marginLeft &&
        spec->lastMouseX <= marginLeft + plotWidth) {
        HPEN cursorPen = CreatePen(PS_DASH, 1, RGB(255, 255, 255));
        SelectObject(hdc, cursorPen);
        MoveToEx(hdc, spec->lastMouseX, marginTop, NULL);
        LineTo(hdc, spec->lastMouseX, marginTop + plotHeight);
        DeleteObject(cursorPen);
    }
    
    DeleteObject(gridPen);
    DeleteObject(axisPen);
    DeleteObject(spectrumPen);
}

// Spectrum window procedure
LRESULT CALLBACK SpectrumWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    int receiverID = (int)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    
    switch (msg)
    {
    case WM_CREATE:
        {
            CREATESTRUCT* cs = (CREATESTRUCT*)lParam;
            receiverID = (int)(INT_PTR)cs->lpCreateParams;
            SetWindowLongPtr(hwnd, GWLP_USERDATA, receiverID);
            
            // Initialize Hanning window
            InitHanningWindow(g_spectrumWindows[receiverID].window, FFT_SIZE);
            
            // Initialize mouse tracking and scaling
            g_spectrumWindows[receiverID].mouseInPlot = false;
            g_spectrumWindows[receiverID].lastMouseX = -1;
            g_spectrumWindows[receiverID].lastMouseY = -1;
            g_spectrumWindows[receiverID].smoothedMaxDB = 0.0f;
            g_spectrumWindows[receiverID].smoothedMinDB = 0.0f;
            g_spectrumWindows[receiverID].markerCount = 0;
            g_spectrumWindows[receiverID].zoomFactor = 1.0f;
            g_spectrumWindows[receiverID].zoomCenterFreq = 0;
            for (int i = 0; i < MAX_MARKERS; i++) {
                g_spectrumWindows[receiverID].markers[i].active = false;
            }
            
            // Create tooltip
            g_spectrumWindows[receiverID].hTooltip = CreateWindowExA(
                WS_EX_TOPMOST,
                TOOLTIPS_CLASSA,
                NULL,
                WS_POPUP | TTS_NOPREFIX | TTS_ALWAYSTIP,
                CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
                hwnd, NULL, g_hInst, NULL);
            
            if (g_spectrumWindows[receiverID].hTooltip) {
                SetWindowPos(g_spectrumWindows[receiverID].hTooltip, HWND_TOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                
                TOOLINFOA ti = {0};
                ti.cbSize = sizeof(TOOLINFOA);
                ti.uFlags = TTF_SUBCLASS;
                ti.hwnd = hwnd;
                ti.hinst = g_hInst;
                ti.lpszText = g_spectrumWindows[receiverID].tooltipText;
                GetClientRect(hwnd, &ti.rect);
                SendMessageA(g_spectrumWindows[receiverID].hTooltip, TTM_ADDTOOLA, 0, (LPARAM)&ti);
                SendMessageA(g_spectrumWindows[receiverID].hTooltip, TTM_SETDELAYTIME, TTDT_INITIAL, 0);
                SendMessageA(g_spectrumWindows[receiverID].hTooltip, TTM_SETDELAYTIME, TTDT_AUTOPOP, 32767);
            }
            
            // Start update timer (30 Hz)
            g_spectrumWindows[receiverID].timerId = SetTimer(hwnd, 1, 33, NULL);
        }
        return 0;
        
    case WM_TIMER:
        // Compute and redraw spectrum
        ComputeSpectrum(receiverID);
        
        // Measure peak frequencies for unmeasured spots
        MeasureSpotPeakFrequency(receiverID);
        
        // Update marker and tooltip values
        if (g_pStatus != NULL && g_pStatus->receivers[receiverID].active) {
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            
            RECT rect;
            GetClientRect(hwnd, &rect);
            int width = rect.right - rect.left;
            
            int marginLeft = 60;
            int marginRight = 20;
            int plotWidth = width - marginLeft - marginRight;
            
            int sampleRate = g_pStatus->sampleRate;
            int centerFreq = g_pStatus->receivers[receiverID].frequency;
            
            // Calculate visible frequency range with zoom applied (same logic as DrawSpectrum)
            int spectrumMinFreq = centerFreq - sampleRate / 2;
            int spectrumMaxFreq = centerFreq + sampleRate / 2;
            int minFreq, maxFreq;
            
            if (spec->zoomFactor > 1.0f && spec->zoomCenterFreq != 0) {
                // Zoom centered on last marker
                int zoomedSpan = (int)(sampleRate / spec->zoomFactor);
                minFreq = spec->zoomCenterFreq - zoomedSpan / 2;
                maxFreq = spec->zoomCenterFreq + zoomedSpan / 2;
                
                // Clamp to spectrum boundaries
                if (minFreq < spectrumMinFreq) {
                    int shift = spectrumMinFreq - minFreq;
                    minFreq = spectrumMinFreq;
                    maxFreq += shift;
                    if (maxFreq > spectrumMaxFreq) maxFreq = spectrumMaxFreq;
                }
                if (maxFreq > spectrumMaxFreq) {
                    int shift = maxFreq - spectrumMaxFreq;
                    maxFreq = spectrumMaxFreq;
                    minFreq -= shift;
                    if (minFreq < spectrumMinFreq) minFreq = spectrumMinFreq;
                }
            } else {
                // Normal view
                minFreq = spectrumMinFreq;
                maxFreq = spectrumMaxFreq;
            }
            
            int visibleSpan = maxFreq - minFreq;
            
            // Update all active markers - recalculate X position from frequency
            for (int i = 0; i < spec->markerCount; i++) {
                if (spec->markers[i].active) {
                    // Recalculate X position from stored frequency based on current zoom
                    int markerFreq = spec->markers[i].frequency;
                    float freqToX = (float)plotWidth / (float)visibleSpan;
                    int newX = marginLeft + (int)((markerFreq - minFreq) * freqToX);
                    spec->markers[i].x = newX;
                    
                    // Update signal level and SNR at marker frequency
                    int fullMinFreq = centerFreq - sampleRate / 2;
                    float binFloat = ((markerFreq - fullMinFreq) / (float)sampleRate) * FFT_SIZE;
                    int bin = (int)binFloat;
                    
                    if (bin >= 0 && bin < FFT_SIZE) {
                        int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
                        spec->markers[i].signalDB = spec->magnitudeDB[shiftedBin];
                        spec->markers[i].snr = spec->markers[i].signalDB - spec->noiseFloor;
                    }
                }
            }
            
            // Update tooltip if mouse is in plot area
            if (spec->mouseInPlot) {
                int mouseX = spec->lastMouseX;
                
                // Calculate frequency and signal at cursor using visible span (zoom-aware)
                float freqOffset = ((mouseX - marginLeft) / (float)plotWidth) * visibleSpan;
                int cursorFreq = minFreq + (int)freqOffset;
                
                int bin = (int)((mouseX - marginLeft) * FFT_SIZE / (float)plotWidth);
                if (bin >= 0 && bin < FFT_SIZE) {
                    int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
                    float signalLevel = spec->magnitudeDB[shiftedBin];
                    float snr = signalLevel - spec->noiseFloor;
                    
                    // Update tooltip text
                    if (cursorFreq >= 1000000) {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%.3f MHz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq / 1000000.0, signalLevel, snr);
                    } else if (cursorFreq >= 1000) {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%.1f kHz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq / 1000.0, signalLevel, snr);
                    } else {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%d Hz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq, signalLevel, snr);
                    }
                    
                    // Update tooltip
                    if (spec->hTooltip) {
                        TOOLINFOA ti = {0};
                        ti.cbSize = sizeof(TOOLINFOA);
                        ti.hwnd = hwnd;
                        ti.lpszText = spec->tooltipText;
                        SendMessageA(spec->hTooltip, TTM_UPDATETIPTEXTA, 0, (LPARAM)&ti);
                    }
                }
            }
        }
        
        InvalidateRect(hwnd, NULL, FALSE);
        return 0;
        
    case WM_PAINT:
        {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            
            // Get client rect for double buffering
            RECT rect;
            GetClientRect(hwnd, &rect);
            int width = rect.right - rect.left;
            int height = rect.bottom - rect.top;
            
            // Create memory DC and bitmap for double buffering
            HDC memDC = CreateCompatibleDC(hdc);
            HBITMAP memBitmap = CreateCompatibleBitmap(hdc, width, height);
            HBITMAP oldBitmap = (HBITMAP)SelectObject(memDC, memBitmap);
            
            // Draw to memory DC
            DrawSpectrum(hwnd, memDC, receiverID);
            
            // Copy to screen (eliminates flicker)
            BitBlt(hdc, 0, 0, width, height, memDC, 0, 0, SRCCOPY);
            
            // Cleanup
            SelectObject(memDC, oldBitmap);
            DeleteObject(memBitmap);
            DeleteDC(memDC);
            
            EndPaint(hwnd, &ps);
        }
        return 0;
    
    case WM_MOUSEMOVE:
        {
            if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) break;
            
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            
            // Track mouse enter/leave
            TRACKMOUSEEVENT tme = {0};
            tme.cbSize = sizeof(TRACKMOUSEEVENT);
            tme.dwFlags = TME_LEAVE;
            tme.hwndTrack = hwnd;
            TrackMouseEvent(&tme);
            
            int mouseX = LOWORD(lParam);
            int mouseY = HIWORD(lParam);
            
            // Only update if mouse moved significantly (reduce redraws)
            if (abs(mouseX - spec->lastMouseX) < 3 && spec->mouseInPlot) {
                return 0;
            }
            
            // Get window dimensions
            RECT rect;
            GetClientRect(hwnd, &rect);
            int width = rect.right - rect.left;
            int height = rect.bottom - rect.top;
            
            // Margins (must match DrawSpectrum)
            int marginLeft = 60;
            int marginRight = 20;
            int marginTop = 40;
            int marginBottom = 40;
            
            int plotWidth = width - marginLeft - marginRight;
            int plotHeight = height - marginTop - marginBottom;
            
            // Check if mouse is in plot area
            if (mouseX >= marginLeft && mouseX <= marginLeft + plotWidth &&
                mouseY >= marginTop && mouseY <= marginTop + plotHeight) {
                
                bool wasInPlot = spec->mouseInPlot;
                spec->mouseInPlot = true;
                spec->lastMouseX = mouseX;
                spec->lastMouseY = mouseY;
                
                // Calculate frequency at cursor using zoom-aware range (same logic as DrawSpectrum)
                int sampleRate = g_pStatus->sampleRate;
                int centerFreq = g_pStatus->receivers[receiverID].frequency;
                
                // Calculate visible frequency range with zoom applied
                int spectrumMinFreq = centerFreq - sampleRate / 2;
                int spectrumMaxFreq = centerFreq + sampleRate / 2;
                int minFreq, maxFreq;
                
                if (spec->zoomFactor > 1.0f && spec->zoomCenterFreq != 0) {
                    // Zoom centered on last marker
                    int zoomedSpan = (int)(sampleRate / spec->zoomFactor);
                    minFreq = spec->zoomCenterFreq - zoomedSpan / 2;
                    maxFreq = spec->zoomCenterFreq + zoomedSpan / 2;
                    
                    // Clamp to spectrum boundaries
                    if (minFreq < spectrumMinFreq) {
                        int shift = spectrumMinFreq - minFreq;
                        minFreq = spectrumMinFreq;
                        maxFreq += shift;
                        if (maxFreq > spectrumMaxFreq) maxFreq = spectrumMaxFreq;
                    }
                    if (maxFreq > spectrumMaxFreq) {
                        int shift = maxFreq - spectrumMaxFreq;
                        maxFreq = spectrumMaxFreq;
                        minFreq -= shift;
                        if (minFreq < spectrumMinFreq) minFreq = spectrumMinFreq;
                    }
                } else {
                    // Normal view
                    minFreq = spectrumMinFreq;
                    maxFreq = spectrumMaxFreq;
                }
                
                int visibleSpan = maxFreq - minFreq;
                float freqOffset = ((mouseX - marginLeft) / (float)plotWidth) * visibleSpan;
                int cursorFreq = minFreq + (int)freqOffset;
                
                // Calculate FFT bin at cursor
                int bin = (int)((mouseX - marginLeft) * FFT_SIZE / (float)plotWidth);
                if (bin >= 0 && bin < FFT_SIZE) {
                    // Shift bin to match FFT output order
                    int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
                    float signalLevel = spec->magnitudeDB[shiftedBin];
                    float snr = signalLevel - spec->noiseFloor;
                    
                    // Update tooltip text (single line for better display)
                    if (cursorFreq >= 1000000) {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%.3f MHz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq / 1000000.0, signalLevel, snr);
                    } else if (cursorFreq >= 1000) {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%.1f kHz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq / 1000.0, signalLevel, snr);
                    } else {
                        sprintf_s(spec->tooltipText, sizeof(spec->tooltipText),
                                 "%d Hz  |  Signal: %.1f dB  |  SNR: %.1f dB",
                                 cursorFreq, signalLevel, snr);
                    }
                    
                    // Update tooltip
                    if (spec->hTooltip) {
                        TOOLINFOA ti = {0};
                        ti.cbSize = sizeof(TOOLINFOA);
                        ti.hwnd = hwnd;
                        ti.lpszText = spec->tooltipText;
                        SendMessageA(spec->hTooltip, TTM_UPDATETIPTEXTA, 0, (LPARAM)&ti);
                    }
                }
                
                // Only redraw if entering plot or moved significantly
                if (!wasInPlot) {
                    InvalidateRect(hwnd, NULL, FALSE);
                }
            } else {
                if (spec->mouseInPlot) {
                    spec->mouseInPlot = false;
                    InvalidateRect(hwnd, NULL, FALSE);
                }
            }
        }
        return 0;
    
    case WM_MOUSELEAVE:
        {
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            if (spec->mouseInPlot) {
                spec->mouseInPlot = false;
                InvalidateRect(hwnd, NULL, FALSE);
            }
        }
        return 0;
    
    case WM_LBUTTONDOWN:
        {
            if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) break;
            
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            int mouseX = LOWORD(lParam);
            int mouseY = HIWORD(lParam);
            
            RECT rect;
            GetClientRect(hwnd, &rect);
            int width = rect.right - rect.left;
            
            int marginLeft = 60;
            int marginRight = 20;
            int marginTop = 40;
            int marginBottom = 40;
            int plotWidth = width - marginLeft - marginRight;
            int plotHeight = rect.bottom - rect.top - marginTop - marginBottom;
            
            // Check if click is in plot area
            if (mouseX >= marginLeft && mouseX <= marginLeft + plotWidth &&
                mouseY >= marginTop && mouseY <= marginTop + plotHeight) {
                
                // Calculate frequency at click position using zoom-aware range
                int sampleRate = g_pStatus->sampleRate;
                int centerFreq = g_pStatus->receivers[receiverID].frequency;
                
                // Calculate visible frequency range with zoom applied (same logic as DrawSpectrum)
                int spectrumMinFreq = centerFreq - sampleRate / 2;
                int spectrumMaxFreq = centerFreq + sampleRate / 2;
                int minFreq, maxFreq;
                
                if (spec->zoomFactor > 1.0f && spec->zoomCenterFreq != 0) {
                    // Zoom centered on last marker
                    int zoomedSpan = (int)(sampleRate / spec->zoomFactor);
                    minFreq = spec->zoomCenterFreq - zoomedSpan / 2;
                    maxFreq = spec->zoomCenterFreq + zoomedSpan / 2;
                    
                    // Clamp to spectrum boundaries
                    if (minFreq < spectrumMinFreq) {
                        int shift = spectrumMinFreq - minFreq;
                        minFreq = spectrumMinFreq;
                        maxFreq += shift;
                        if (maxFreq > spectrumMaxFreq) maxFreq = spectrumMaxFreq;
                    }
                    if (maxFreq > spectrumMaxFreq) {
                        int shift = maxFreq - spectrumMaxFreq;
                        maxFreq = spectrumMaxFreq;
                        minFreq -= shift;
                        if (minFreq < spectrumMinFreq) minFreq = spectrumMinFreq;
                    }
                } else {
                    // Normal view
                    minFreq = spectrumMinFreq;
                    maxFreq = spectrumMaxFreq;
                }
                
                int visibleSpan = maxFreq - minFreq;
                float freqOffset = ((mouseX - marginLeft) / (float)plotWidth) * visibleSpan;
                int clickFreq = minFreq + (int)freqOffset;
                
                // Calculate signal level at click frequency
                int fullMinFreq = centerFreq - sampleRate / 2;
                float binFloat = ((clickFreq - fullMinFreq) / (float)sampleRate) * FFT_SIZE;
                int bin = (int)binFloat;
                
                if (bin >= 0 && bin < FFT_SIZE) {
                    int shiftedBin = (bin + FFT_SIZE / 2) % FFT_SIZE;
                    float signalLevel = spec->magnitudeDB[shiftedBin];
                    float snr = signalLevel - spec->noiseFloor;
                    
                    // Add marker if we have space
                    if (spec->markerCount < MAX_MARKERS) {
                        spec->markers[spec->markerCount].x = mouseX;
                        spec->markers[spec->markerCount].frequency = clickFreq;
                        spec->markers[spec->markerCount].signalDB = signalLevel;
                        spec->markers[spec->markerCount].snr = snr;
                        spec->markers[spec->markerCount].active = true;
                        spec->markerCount++;
                        
                        // Set zoom center to this marker
                        spec->zoomCenterFreq = clickFreq;
                        
                        InvalidateRect(hwnd, NULL, FALSE);
                    }
                }
            }
        }
        return 0;
    
    case WM_LBUTTONDBLCLK:
        {
            if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) break;
            
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            
            // Clear all markers and reset zoom on double-click
            for (int i = 0; i < MAX_MARKERS; i++) {
                spec->markers[i].active = false;
            }
            spec->markerCount = 0;
            spec->zoomFactor = 1.0f;
            spec->zoomCenterFreq = 0;
            InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;
    
    case WM_KEYDOWN:
        {
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            
            if (wParam == VK_OEM_PLUS || wParam == VK_ADD || wParam == 0xBB) {  // + key
                // Zoom in
                if (spec->zoomCenterFreq != 0) {
                    spec->zoomFactor *= 1.5f;
                    if (spec->zoomFactor > 20.0f) spec->zoomFactor = 20.0f;
                    InvalidateRect(hwnd, NULL, FALSE);
                }
            }
            else if (wParam == VK_OEM_MINUS || wParam == VK_SUBTRACT || wParam == 0xBD) {  // - key
                // Zoom out
                spec->zoomFactor /= 1.5f;
                if (spec->zoomFactor < 1.0f) spec->zoomFactor = 1.0f;
                InvalidateRect(hwnd, NULL, FALSE);
            }
        }
        return 0;
    
    case WM_MOUSEWHEEL:
        {
            SpectrumWindow* spec = &g_spectrumWindows[receiverID];
            int delta = GET_WHEEL_DELTA_WPARAM(wParam);
            
            if (delta > 0) {
                // Scroll up - zoom in
                if (spec->zoomCenterFreq != 0) {
                    spec->zoomFactor *= 1.2f;
                    if (spec->zoomFactor > 20.0f) spec->zoomFactor = 20.0f;
                    InvalidateRect(hwnd, NULL, FALSE);
                }
            } else if (delta < 0) {
                // Scroll down - zoom out
                spec->zoomFactor /= 1.2f;
                if (spec->zoomFactor < 1.0f) spec->zoomFactor = 1.0f;
                InvalidateRect(hwnd, NULL, FALSE);
            }
        }
        return 0;
        
    case WM_SIZE:
        InvalidateRect(hwnd, NULL, TRUE);
        return 0;
    
    case WM_CLOSE:
        CloseSpectrumWindow(receiverID);
        return 0;
        
    case WM_DESTROY:
        if (g_spectrumWindows[receiverID].timerId != 0) {
            KillTimer(hwnd, g_spectrumWindows[receiverID].timerId);
            g_spectrumWindows[receiverID].timerId = 0;
        }
        if (g_spectrumWindows[receiverID].hTooltip != NULL) {
            DestroyWindow(g_spectrumWindows[receiverID].hTooltip);
            g_spectrumWindows[receiverID].hTooltip = NULL;
        }
        return 0;
    }
    
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

// Show spectrum window for a receiver
void ShowSpectrumWindow(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    if (g_pStatus == NULL || !g_pStatus->receivers[receiverID].active) {
        MessageBoxA(g_hDlg, "Receiver is not active", "Cannot Show Spectrum", MB_OK | MB_ICONWARNING);
        return;
    }
    
    // If window already exists, bring it to front
    if (g_spectrumWindows[receiverID].hWnd != NULL && IsWindow(g_spectrumWindows[receiverID].hWnd)) {
        SetForegroundWindow(g_spectrumWindows[receiverID].hWnd);
        return;
    }
    
    // Register window class if not already registered
    static bool classRegistered = false;
    if (!classRegistered) {
        WNDCLASSA wc = {0};
        wc.lpfnWndProc = SpectrumWindowProc;
        wc.hInstance = g_hInst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.lpszClassName = "UberSDRSpectrumWindow";
        wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;  // Redraw on resize, enable double-click
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        RegisterClassA(&wc);
        classRegistered = true;
    }
    
    // Create window - 4:1 aspect ratio (1600x400)
    char title[128];
    sprintf_s(title, sizeof(title), "Spectrum - Receiver %d", receiverID);
    
    HWND hwnd = CreateWindowExA(
        0,
        "UberSDRSpectrumWindow",
        title,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT,
        1600, 400,  // 4:1 aspect ratio
        NULL,
        NULL,
        g_hInst,
        (LPVOID)(INT_PTR)receiverID);
    
    if (hwnd == NULL) {
        MessageBoxA(g_hDlg, "Failed to create spectrum window", "Error", MB_OK | MB_ICONERROR);
        return;
    }
    
    g_spectrumWindows[receiverID].hWnd = hwnd;
    g_spectrumWindows[receiverID].receiverID = receiverID;
    g_spectrumWindows[receiverID].active = true;
    
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    
    // Automatically open spots window
    ShowSpotsWindow(receiverID);
}

// Close spectrum window
void CloseSpectrumWindow(int receiverID)
{
    if (receiverID < 0 || receiverID >= MAX_RX_COUNT) return;
    
    // Close associated spots window first
    CloseSpotsWindow(receiverID);
    
    if (g_spectrumWindows[receiverID].hWnd != NULL) {
        DestroyWindow(g_spectrumWindows[receiverID].hWnd);
        g_spectrumWindows[receiverID].hWnd = NULL;
        g_spectrumWindows[receiverID].active = false;
    }
}

// Dialog procedure for instance selection
INT_PTR CALLBACK InstanceSelectionDialogProc(HWND hDlg, UINT message, WPARAM wParam, LPARAM lParam)
{
    static HWND hListBox = NULL;
    
    switch (message)
    {
    case WM_INITDIALOG:
        {
            // Set dialog title
            SetWindowTextA(hDlg, "Select UberSDR Instance");
            
            // Create listbox
            hListBox = CreateWindowExA(
                WS_EX_CLIENTEDGE,
                "LISTBOX",
                "",
                WS_CHILD | WS_VISIBLE | WS_VSCROLL | LBS_NOTIFY | LBS_HASSTRINGS,
                10, 10, 460, 150,
                hDlg,
                (HMENU)IDC_INSTANCE_LIST,
                g_hInst,
                NULL);
            
            // Create OK button
            CreateWindowA(
                "BUTTON",
                "OK",
                WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
                190, 170, 80, 25,
                hDlg,
                (HMENU)IDOK,
                g_hInst,
                NULL);
            
            // Create Cancel button
            CreateWindowA(
                "BUTTON",
                "Cancel",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                280, 170, 80, 25,
                hDlg,
                (HMENU)IDCANCEL,
                g_hInst,
                NULL);
            
            // Add instances to listbox
            for (int i = 0; i < g_instanceCount; i++) {
                char serverHost[128];
                WideCharToMultiByte(CP_UTF8, 0, g_instances[i].serverHost, -1, serverHost, 128, NULL, NULL);
                
                // Format start time
                FILETIME ft;
                ULARGE_INTEGER uli;
                uli.QuadPart = (g_instances[i].startTime + 11644473600000ULL) * 10000ULL;
                ft.dwLowDateTime = uli.LowPart;
                ft.dwHighDateTime = uli.HighPart;
                
                SYSTEMTIME st;
                FileTimeToSystemTime(&ft, &st);
                
                char itemText[256];
                sprintf_s(itemText, sizeof(itemText),
                         "%s:%d (PID: %u, Started: %02d:%02d:%02d)",
                         serverHost, g_instances[i].serverPort, g_instances[i].processID,
                         st.wHour, st.wMinute, st.wSecond);
                
                SendMessageA(hListBox, LB_ADDSTRING, 0, (LPARAM)itemText);
            }
            
            // Select first item by default
            SendMessage(hListBox, LB_SETCURSEL, 0, 0);
            
            return TRUE;
        }
    
    case WM_COMMAND:
        {
            int wmId = LOWORD(wParam);
            int wmEvent = HIWORD(wParam);
            
            if (wmId == IDC_INSTANCE_LIST && wmEvent == LBN_DBLCLK) {
                // Double-click on list item - same as OK
                int selectedIndex = (int)SendMessage(hListBox, LB_GETCURSEL, 0, 0);
                if (selectedIndex != LB_ERR) {
                    EndDialog(hDlg, selectedIndex);
                }
                return TRUE;
            }
            else if (wmId == IDOK) {
                // OK button clicked
                int selectedIndex = (int)SendMessage(hListBox, LB_GETCURSEL, 0, 0);
                if (selectedIndex == LB_ERR) {
                    selectedIndex = 0;  // Default to first if none selected
                }
                EndDialog(hDlg, selectedIndex);
                return TRUE;
            }
            else if (wmId == IDCANCEL) {
                // Cancel - return first instance
                EndDialog(hDlg, 0);
                return TRUE;
            }
        }
        break;
    
    case WM_CLOSE:
        EndDialog(hDlg, 0);
        return TRUE;
    }
    
    return FALSE;
}

// Show instance selection dialog
int ShowInstanceSelectionDialog(HWND hParent)
{
    // Build message text with all instances
    char message[2048] = "Select an instance:\n\n";
    
    for (int i = 0; i < g_instanceCount; i++) {
        char serverHost[128];
        WideCharToMultiByte(CP_UTF8, 0, g_instances[i].serverHost, -1, serverHost, 128, NULL, NULL);
        
        // Format start time
        FILETIME ft;
        ULARGE_INTEGER uli;
        uli.QuadPart = (g_instances[i].startTime + 11644473600000ULL) * 10000ULL;
        ft.dwLowDateTime = uli.LowPart;
        ft.dwHighDateTime = uli.HighPart;
        
        SYSTEMTIME st;
        FileTimeToSystemTime(&ft, &st);
        
        char line[256];
        sprintf_s(line, sizeof(line),
                 "[%d] %s:%d (PID: %u, Started: %02d:%02d:%02d)\n",
                 i + 1,
                 serverHost, g_instances[i].serverPort, g_instances[i].processID,
                 st.wHour, st.wMinute, st.wSecond);
        
        strcat_s(message, sizeof(message), line);
    }
    
    strcat_s(message, sizeof(message), "\nEnter selection (1-");
    char numStr[16];
    sprintf_s(numStr, sizeof(numStr), "%d", g_instanceCount);
    strcat_s(message, sizeof(message), numStr);
    strcat_s(message, sizeof(message), "):");
    
    // Show input dialog
    char input[16] = "1";  // Default to first
    
    // Use a simple message box for now - we can improve this later
    MessageBoxA(hParent, message, "Select UberSDR Instance", MB_OK | MB_ICONINFORMATION);
    
    // For now, just return 0 (first instance)
    // TODO: Create proper input dialog
    return 0;
}

// Connect to selected instance
BOOL ConnectToInstance(int instanceIndex)
{
    if (instanceIndex < 0 || instanceIndex >= g_instanceCount) {
        return FALSE;
    }
    
    // Close existing connection if any
    if (g_pStatus != NULL) {
        UnmapViewOfFile((LPVOID)g_pStatus);
        g_pStatus = NULL;
    }
    
    if (g_hSharedMemory != NULL) {
        CloseHandle(g_hSharedMemory);
        g_hSharedMemory = NULL;
    }
    
    // Open shared memory for selected instance
    g_hSharedMemory = OpenFileMappingW(
        FILE_MAP_ALL_ACCESS,
        FALSE,
        g_instances[instanceIndex].sharedMemoryName);
    
    if (g_hSharedMemory == NULL) {
        return FALSE;
    }
    
    g_pStatus = (const UberSDRSharedStatus*)MapViewOfFile(
        g_hSharedMemory,
        FILE_MAP_ALL_ACCESS,
        0, 0,
        sizeof(UberSDRSharedStatus));
    
    if (g_pStatus == NULL) {
        CloseHandle(g_hSharedMemory);
        g_hSharedMemory = NULL;
        return FALSE;
    }
    
    g_selectedInstance = instanceIndex;
    return TRUE;
}

// Dialog procedure
INT_PTR CALLBACK DialogProc(HWND hDlg, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_INITDIALOG:
        {
            g_hDlg = hDlg;
            
            // Center dialog on screen
            RECT rc;
            GetWindowRect(hDlg, &rc);
            int x = (GetSystemMetrics(SM_CXSCREEN) - (rc.right - rc.left)) / 2;
            int y = (GetSystemMetrics(SM_CYSCREEN) - (rc.bottom - rc.top)) / 2;
            SetWindowPos(hDlg, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
            
            // Get handle to instance listbox (defined in resource file)
            g_hInstanceList = GetDlgItem(hDlg, IDC_INSTANCE_LIST);
            
            // Start instance list update timer (1 second interval)
            g_instanceTimerId = SetTimer(hDlg, TIMER_INSTANCE_CHECK, 1000, NULL);
            
            // Initial instance list update
            UpdateInstanceList();
            
            // Set default telnet port
            SetDlgItemTextA(hDlg, IDC_TELNET_PORT, "7300");
            
            // Initially disable Disconnect button
            EnableWindow(GetDlgItem(hDlg, IDC_TELNET_DISCONNECT), FALSE);
            
            // Initialize progress bars (range 0-100 for percentage)
            for (int i = 0; i < MAX_RX_COUNT; i++) {
                SendDlgItemMessage(hDlg, IDC_RX0_LEVEL_I + (i * 2), PBM_SETRANGE, 0, MAKELPARAM(0, 100));
                SendDlgItemMessage(hDlg, IDC_RX0_LEVEL_Q + (i * 2), PBM_SETRANGE, 0, MAKELPARAM(0, 100));
            }
            
            // Initialize duration edit boxes to 0 (hold-to-record mode)
            for (int i = 0; i < MAX_RX_COUNT; i++) {
                SetDlgItemTextA(hDlg, IDC_RX0_DURATION + i, "0");
            }
            
            // Subclass record buttons and store handles for color changes
            for (int i = 0; i < MAX_RX_COUNT; i++) {
                HWND hButton = GetDlgItem(hDlg, IDC_RX0_RECORD + i);
                if (hButton != NULL) {
                    g_recordButtons[i] = hButton;
                    SetWindowSubclass(hButton, RecordButtonProc, i, (DWORD_PTR)i);
                }
            }
            
            // Try to connect to shared memory (legacy mode for backward compatibility)
            // If instances are found, user will use the instance list to connect
            if (!InitSharedMemory()) {
                if (g_instanceCount == 0) {
                    SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, "Waiting for DLL to load...");
                } else {
                    SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, "Select an instance from the list above and click Connect");
                }
            }
            
            // Don't auto-connect to telnet - user must click Connect button
            
            // Start update timer (100ms interval for smooth level meters)
            g_timerId = SetTimer(hDlg, TIMER_UPDATE, 100, NULL);
            
            // Initial update
            UpdateDisplay();
            
            return TRUE;
        }
    
    case WM_TIMER:
        if (wParam == TIMER_UPDATE) {
            UpdateDisplay();
        }
        else if (wParam == TIMER_INSTANCE_CHECK) {
            UpdateInstanceList();
        }
        return TRUE;
    
    case WM_DRAWITEM:
        {
            // Handle owner-draw for record buttons (red when recording)
            LPDRAWITEMSTRUCT pDIS = (LPDRAWITEMSTRUCT)lParam;
            
            // Check if this is a record button
            int rxId = -1;
            for (int i = 0; i < MAX_RX_COUNT; i++) {
                if (pDIS->hwndItem == g_recordButtons[i]) {
                    rxId = i;
                    break;
                }
            }
            
            if (rxId >= 0) {
                // Draw button with red background if recording
                HBRUSH hBrush;
                if (g_recording[rxId].recording) {
                    hBrush = CreateSolidBrush(RGB(255, 0, 0));  // Red
                } else {
                    hBrush = CreateSolidBrush(GetSysColor(COLOR_BTNFACE));  // Normal
                }
                
                FillRect(pDIS->hDC, &pDIS->rcItem, hBrush);
                DeleteObject(hBrush);
                
                // Draw button text
                SetBkMode(pDIS->hDC, TRANSPARENT);
                SetTextColor(pDIS->hDC, g_recording[rxId].recording ? RGB(255, 255, 255) : RGB(0, 0, 0));
                DrawTextA(pDIS->hDC, "Rec", -1, &pDIS->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                
                // Draw button border
                if (pDIS->itemState & ODS_SELECTED) {
                    DrawEdge(pDIS->hDC, &pDIS->rcItem, EDGE_SUNKEN, BF_RECT);
                } else {
                    DrawEdge(pDIS->hDC, &pDIS->rcItem, EDGE_RAISED, BF_RECT);
                }
                
                return TRUE;
            }
        }
        return FALSE;
    
    case WM_COMMAND:
        {
            int wmId = LOWORD(wParam);
            int wmEvent = HIWORD(wParam);
            
            // Auto-offset functionality removed - Duration recording feature replaces it
            
            // Handle double-click on instance list
            if (wmId == IDC_INSTANCE_LIST && wmEvent == LBN_DBLCLK) {
                int selectedIndex = (int)SendMessage(g_hInstanceList, LB_GETCURSEL, 0, 0);
                if (selectedIndex != LB_ERR && selectedIndex < g_instanceCount) {
                    if (ConnectToInstance(selectedIndex)) {
                        char msg[128];
                        sprintf_s(msg, sizeof(msg), "Connected to instance %d", selectedIndex);
                        SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, msg);
                    } else {
                        SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, "Failed to connect to selected instance");
                    }
                }
                return TRUE;
            }
            
            // Handle telnet Connect button
            if (wmId == IDC_TELNET_CONNECT) {
                ConnectTelnet();
                return TRUE;
            }
            
            // Handle telnet Disconnect button
            if (wmId == IDC_TELNET_DISCONNECT) {
                if (g_telnetSocket != INVALID_SOCKET) {
                    AppendTelnetText("Disconnecting...\r\n");
                    closesocket(g_telnetSocket);
                    g_telnetSocket = INVALID_SOCKET;
                    g_telnetConnected = false;
                    EnableWindow(GetDlgItem(hDlg, IDC_TELNET_CONNECT), TRUE);
                    EnableWindow(GetDlgItem(hDlg, IDC_TELNET_DISCONNECT), FALSE);
                }
                return TRUE;
            }
            
            // Handle instance Connect button
            if (wmId == IDC_CONNECT_BUTTON) {
                int selectedIndex = (int)SendMessage(g_hInstanceList, LB_GETCURSEL, 0, 0);
                if (selectedIndex != LB_ERR && selectedIndex < g_instanceCount) {
                    if (ConnectToInstance(selectedIndex)) {
                        char msg[128];
                        sprintf_s(msg, sizeof(msg), "Connected to instance %d", selectedIndex);
                        SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, msg);
                    } else {
                        SetDlgItemTextA(hDlg, IDC_SERVER_STATUS, "Failed to connect to selected instance");
                    }
                } else {
                    MessageBoxA(hDlg, "Please select an instance from the list", "No Selection", MB_OK | MB_ICONINFORMATION);
                }
                return TRUE;
            }
            
            // Handle Spectrum buttons
            if (wmId >= IDC_RX0_SPECTRUM && wmId <= IDC_RX7_SPECTRUM) {
                int rxId = wmId - IDC_RX0_SPECTRUM;
                ShowSpectrumWindow(rxId);
                return TRUE;
            }
            
            if (wmId == IDOK || wmId == IDCANCEL) {
                // Stop all recordings
                for (int i = 0; i < MAX_RX_COUNT; i++) {
                    if (g_recording[i].recording) {
                        StopRecording(i);
                    }
                }
                
                // Close all spectrum windows
                for (int i = 0; i < MAX_RX_COUNT; i++) {
                    CloseSpectrumWindow(i);
                }
                
                if (g_timerId != 0) {
                    KillTimer(hDlg, g_timerId);
                    g_timerId = 0;
                }
                CleanupTelnet();
                CleanupSharedMemory();
                EndDialog(hDlg, wmId);
                return TRUE;
            }
        }
        break;
    
    case WM_CLOSE:
        // Stop all recordings
        for (int i = 0; i < MAX_RX_COUNT; i++) {
            if (g_recording[i].recording) {
                StopRecording(i);
            }
        }
        
        // Close all spectrum windows
        for (int i = 0; i < MAX_RX_COUNT; i++) {
            CloseSpectrumWindow(i);
        }
        
        if (g_timerId != 0) {
            KillTimer(hDlg, g_timerId);
            g_timerId = 0;
        }
        if (g_instanceTimerId != 0) {
            KillTimer(hDlg, g_instanceTimerId);
            g_instanceTimerId = 0;
        }
        CleanupTelnet();
        CleanupSharedMemory();
        EndDialog(hDlg, 0);
        return TRUE;
    }
    
    return FALSE;
}