#pragma once

#include <string>
#include <vector>
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>

// IXWebSocket library
#include "IXWebSocket/ixwebsocket/IXWebSocket.h"

#pragma comment(lib, "ws2_32.lib")

#define MAX_RX_COUNT 8

namespace UberSDRIntf
{
    // WebSocket connection state
    enum ConnectionState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        ERROR_STATE
    };

    // Ring buffer for smoothing WebSocket data arrival
    struct RingBuffer {
        std::vector<float> buffer;  // Interleaved I/Q samples (float)
        size_t writePos;
        size_t readPos;
        size_t capacity;            // Total capacity in samples (I/Q pairs)
        CRITICAL_SECTION lock;
        int underrunCount;
        int overrunCount;
        
        RingBuffer() : writePos(0), readPos(0), capacity(0), underrunCount(0), overrunCount(0) {
            InitializeCriticalSection(&lock);
        }
        
        ~RingBuffer() {
            DeleteCriticalSection(&lock);
        }
        
        void init(size_t capacityInSamples) {
            EnterCriticalSection(&lock);
            capacity = capacityInSamples;
            buffer.resize(capacity * 2);  // *2 for I and Q
            writePos = 0;
            readPos = 0;
            underrunCount = 0;
            overrunCount = 0;
            LeaveCriticalSection(&lock);
        }
        
        size_t available() {
            // Returns number of samples available to read
            return (writePos - readPos + capacity) % capacity;
        }
        
        size_t space() {
            // Returns number of samples that can be written
            return capacity - available() - 1;
        }
        
        bool write(float I, float Q) {
            EnterCriticalSection(&lock);
            
            if (space() < 1) {
                overrunCount++;
                LeaveCriticalSection(&lock);
                return false;  // Buffer full
            }
            
            size_t idx = writePos * 2;
            buffer[idx] = I;
            buffer[idx + 1] = Q;
            writePos = (writePos + 1) % capacity;
            
            LeaveCriticalSection(&lock);
            return true;
        }
        
        bool read(float& I, float& Q) {
            EnterCriticalSection(&lock);
            
            if (available() < 1) {
                underrunCount++;
                LeaveCriticalSection(&lock);
                return false;  // Buffer empty
            }
            
            size_t idx = readPos * 2;
            I = buffer[idx];
            Q = buffer[idx + 1];
            readPos = (readPos + 1) % capacity;
            
            LeaveCriticalSection(&lock);
            return true;
        }
        
        float fillLevel() {
            // Returns fill level as percentage (0.0 to 1.0)
            return (float)available() / (float)capacity;
        }
    };

    // Receiver information
    struct ReceiverInfo {
        int frequency;
        std::string mode;
        bool active;
        ConnectionState state;
        std::string sessionId;
        ix::WebSocket* wsClient;
        RingBuffer ringBuffer;  // 500ms buffer for smoothing WebSocket data
        int generation;  // Incremented on each reconnection to detect stale callbacks
        CRITICAL_SECTION lock;  // Mutex for thread-safe access
        bool needsReconnect;    // Flag set by close callback
        HANDLE reconnectThread; // Handle to reconnection thread
        
        ReceiverInfo() : frequency(14074000), mode("iq192"), active(false),
                        state(DISCONNECTED), wsClient(nullptr), generation(0),
                        needsReconnect(false), reconnectThread(NULL) {
            InitializeCriticalSection(&lock);
        }
        
        ~ReceiverInfo() {
            DeleteCriticalSection(&lock);
        }
    };

    class UberSDR
    {
    public:
        // Configuration from INI file
        std::string configHost;
        int configPort;
        bool configFromFilename;
        bool debugRec;  // Enable 10-second WAV recording on start
        
        // Server connection
        std::string serverHost;
        int serverPort;
        bool useSSL;
        
        // Receiver management
        ReceiverInfo receivers[MAX_RX_COUNT];
        int maxReceivers;
        int activeReceivers;
        
        // Sample rate mapping
        int sampleRate;
        std::string iqMode;  // "iq48", "iq96", or "iq192"
        
        UberSDR(void);
        ~UberSDR(void);
        
        // Connection management
        int Connect(const std::string& host, int port, bool ssl);
        int Disconnect(void);
        bool CheckConnectionAllowed(int receiverID);
        
        // Receiver control
        int StartReceiver(int receiverID, int frequency, const std::string& mode);
        int StopReceiver(int receiverID);
        int SetFrequency(int receiverID, int frequency);
        
        // WebSocket operations
        std::string BuildWebSocketURL(int receiverID, int frequency, const std::string& mode);
        int ConnectWebSocket(int receiverID, const std::string& url);
        void DisconnectWebSocket(int receiverID);
        void HandleWebSocketMessage(int receiverID, const std::string& message);
        void SendKeepalive(int receiverID);
        
        // Reconnection thread
        static DWORD WINAPI ReconnectionThreadProc(LPVOID param);
        void HandleReconnection(int receiverID);
        
        // HTTP operations
        bool HttpPost(const std::string& path, const std::string& body, std::string& response);
        
    private:
        WSADATA wsaData;
        bool wsaInitialized;
        
        // INI file configuration
        int loadConfigFromIni(void);
        bool isValidHostname(const std::string& host);
        bool isValidPort(int port);
        
        // Mode selection based on sample rate
        std::string selectIQMode(int rateID);
    };
}