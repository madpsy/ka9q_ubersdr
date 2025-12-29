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
#include "../UberSDRIntf/UberSDRShared.h"
#include "resource.h"

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "ws2_32.lib")

#pragma comment(linker,"\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

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

// Multi-instance support
UberSDRInstanceInfo g_instances[16];  // Support up to 16 instances
int g_instanceCount = 0;
int g_selectedInstance = -1;

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

// Telnet function prototypes
BOOL InitWinsock();
void CleanupTelnet();
bool ConnectTelnet();
void ProcessTelnet();
void AppendTelnetText(const char* text);

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
            FILE_MAP_READ,
            FALSE,
            UBERSDR_SHARED_MEMORY_NAME);
        
        // If not found, try Hermes
        if (g_hSharedMemory == NULL) {
            g_hSharedMemory = OpenFileMappingW(
                FILE_MAP_READ,
                FALSE,
                L"HermesIntf_Status_v1");
        }
        
        if (g_hSharedMemory == NULL) {
            return FALSE;
        }
        
        g_pStatus = (const UberSDRSharedStatus*)MapViewOfFile(
            g_hSharedMemory,
            FILE_MAP_READ,
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
    
    // Sample rate and mode
    sprintf_s(buffer, sizeof(buffer), "Sample Rate: %d Hz    Mode: %s    Block Size: %d",
              g_pStatus->sampleRate,
              g_pStatus->mode,
              g_pStatus->blockSize);
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
            
            if (overruns > 0 || underruns > 0) {
                sprintf_s(buffer, sizeof(buffer), "Rx%d: %s [Active] %.1f KB/s  Buf:%d%% (O:%d U:%d)  Session: %.8s...",
                          i,
                          freqStr,
                          g_pStatus->receivers[i].throughputKBps,
                          bufferPercent,
                          overruns,
                          underruns,
                          g_pStatus->receivers[i].sessionId);
            } else {
                sprintf_s(buffer, sizeof(buffer), "Rx%d: %s [Active] %.1f KB/s  Buf:%d%%  Session: %.8s...",
                          i,
                          freqStr,
                          g_pStatus->receivers[i].throughputKBps,
                          bufferPercent,
                          g_pStatus->receivers[i].sessionId);
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
    
    // Process any active recordings
    for (int i = 0; i < MAX_RX_COUNT; i++) {
        if (g_recording[i].recording) {
            ProcessRecording(i);
        }
    }
    
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
}

// Button subclass procedure to handle mouse down/up
LRESULT CALLBACK RecordButtonProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData)
{
    int rxId = (int)dwRefData;
    
    switch (msg)
    {
    case WM_LBUTTONDOWN:
        // Start recording when button is pressed
        if (!g_recording[rxId].recording) {
            StartRecording(rxId);
        }
        break;
        
    case WM_LBUTTONUP:
    case WM_CAPTURECHANGED:
        // Stop recording when button is released
        if (g_recording[rxId].recording) {
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
    
    // Write samples to file
    while (available >= 2) {
        int16_t sample[2];
        sample[0] = g_pStatus->receivers[receiverID].iqBuffer[readPos];
        sample[1] = g_pStatus->receivers[receiverID].iqBuffer[readPos + 1];
        
        DWORD written;
        WriteFile(g_recording[receiverID].hFile, sample, 4, &written, NULL);
        
        g_recording[receiverID].samplesWritten++;
        readPos = (readPos + 2) % IQ_BUFFER_SIZE;
        available -= 2;
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
        FILE_MAP_READ,
        FALSE,
        g_instances[instanceIndex].sharedMemoryName);
    
    if (g_hSharedMemory == NULL) {
        return FALSE;
    }
    
    g_pStatus = (const UberSDRSharedStatus*)MapViewOfFile(
        g_hSharedMemory,
        FILE_MAP_READ,
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
            
            // Subclass record buttons to handle mouse down/up
            for (int i = 0; i < MAX_RX_COUNT; i++) {
                HWND hButton = GetDlgItem(hDlg, IDC_RX0_RECORD + i);
                if (hButton != NULL) {
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
    
    case WM_COMMAND:
        {
            int wmId = LOWORD(wParam);
            int wmEvent = HIWORD(wParam);
            
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
            
            if (wmId == IDOK || wmId == IDCANCEL) {
                // Stop all recordings
                for (int i = 0; i < MAX_RX_COUNT; i++) {
                    if (g_recording[i].recording) {
                        StopRecording(i);
                    }
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