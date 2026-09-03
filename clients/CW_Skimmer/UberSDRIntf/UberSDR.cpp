// UberSDR.cpp : WebSocket client implementation for ka9q_ubersdr

#define UBERSDRINTF_EXPORTS

// Prevent winsock.h from being included (we use winsock2.h)
#define WIN32_LEAN_AND_MEAN
#define _WINSOCKAPI_

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <rpc.h>
#include <stdio.h>
#include <string>
#include <sstream>
#include <vector>
#include <algorithm>
#include "UberSDR.h"
#include "UberSDRIntf.h"
#include "UberSDRShared.h"

#pragma comment(lib, "rpcrt4.lib")

// No zstd. Versions 1-3 wrapped every packet in a zstd frame; version 4's
// predictive codec replaced it, and on this data zstd was making packets LARGER
// anyway -- it is an LZ77 matcher over bytes, and a band-limited RF signal has
// no repeated byte strings. Dropping it removes the vcpkg dependency the build
// instructions used to require.

// Defined at global scope in UberSDRIntf.cpp. Declared here, outside the
// namespace, because a block-scope `extern` inside namespace UberSDRIntf names
// UberSDRIntf::ProcessIQData -- which nothing defines. MSVC resolves it to the
// global anyway; GCC does not, and GCC is right.
void ProcessIQData(int receiverID, const std::vector<uint8_t>& iqBytes);
void TrackCompressedBytes(int receiverID, size_t compressedBytes);

namespace UberSDRIntf
{
    ///////////////////////////////////////////////////////////////////////////////
    // Constructor
    UberSDR::UberSDR(void)
    {
        // Initialize defaults
        configHost = "127.0.0.1";
        configPort = 8080;
        configFromFilename = false;
        debugRec = false;  // Disable WAV recording by default
        useSSL = false;
        maxReceivers = 8;
        activeReceivers = 0;
        sampleRate = 192000;
        iqMode = "iq192";
        frequencyOffset = 0;  // Default to no frequency correction
        swapIQ = true;  // Default to true for backward compatibility
        
        // Initialize WinSock
        wsaInitialized = false;
        int iResult = WSAStartup(MAKEWORD(2, 2), &wsaData);
        if (iResult != 0) {
            rt_exception("WSAStartup failed");
            return;
        }
        wsaInitialized = true;
        
        // Initialize receivers (using constructor defaults)
        for (int i = 0; i < MAX_RX_COUNT; i++)
        {
            // ReceiverInfo constructor handles initialization
        }
        
        // Try to load configuration from INI file
        loadConfigFromIni();
        
        // Set server configuration
        serverHost = configHost;
        serverPort = configPort;
        
        std::stringstream ss;
        ss << "UberSDR initialized with server: " << serverHost << ":" << serverPort;
        write_text_to_log_file(ss.str());
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Destructor
    UberSDR::~UberSDR(void)
    {
        try {
            write_text_to_log_file("UberSDR destructor called");
            
            Disconnect();
            
            write_text_to_log_file("Cleaning up WebSocket clients...");
            // Clean up WebSocket clients
            for (int i = 0; i < MAX_RX_COUNT; i++)
            {
                if (receivers[i].wsClient != nullptr) {
                    try {
                        std::stringstream ss;
                        ss << "Deleting WebSocket client " << i;
                        write_text_to_log_file(ss.str());
                        delete receivers[i].wsClient;
                        receivers[i].wsClient = nullptr;
                    }
                    catch (...) {
                        write_text_to_log_file("Exception deleting WebSocket client");
                    }
                }
            }
            
            write_text_to_log_file("WebSocket clients cleaned up");
            
            if (wsaInitialized) {
                WSACleanup();
            }
            
            write_text_to_log_file("UberSDR destructor completed");
        }
        catch (const std::exception& e) {
            // Can't use write_text_to_log_file here as it might be destroyed
        }
        catch (...) {
            // Silent catch - destructor must not throw
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Load configuration from INI file
    int UberSDR::loadConfigFromIni(void)
    {
        char szFileName[MAX_PATH];
        char iniPath[MAX_PATH];
        HMODULE hm = NULL;
        
        // Get DLL module handle
        if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCSTR)&GetSdrInfo,
            &hm))
        {
            write_text_to_log_file("GetModuleHandle failed, using defaults");
            return 1;
        }
        
        // Get full DLL path
        GetModuleFileNameA(hm, szFileName, sizeof(szFileName));
        
        // Build INI file path (same directory as DLL, named UberSDRIntf.ini)
        strcpy_s(iniPath, sizeof(iniPath), szFileName);
        char* lastSlash = strrchr(iniPath, '\\');
        if (lastSlash != NULL) {
            *(lastSlash + 1) = '\0';
            strcat_s(iniPath, sizeof(iniPath), "UberSDRIntf.ini");
        } else {
            strcpy_s(iniPath, sizeof(iniPath), "UberSDRIntf.ini");
        }
        
        std::stringstream ss;
        ss << "Looking for INI file: " << iniPath;
        write_text_to_log_file(ss.str());
        
        // Check if INI file exists
        DWORD attrib = GetFileAttributesA(iniPath);
        if (attrib == INVALID_FILE_ATTRIBUTES) {
            write_text_to_log_file("INI file not found, using defaults (127.0.0.1:8080)");
            return 1;
        }
        
        // Read host from INI file
        char host[256];
        GetPrivateProfileStringA("Server", "Host", "127.0.0.1", host, sizeof(host), iniPath);
        
        // Read port from INI file
        int port = GetPrivateProfileIntA("Server", "Port", 8080, iniPath);
        
        // Read debug_rec from INI file (0 = false, non-zero = true)
        int debugRecInt = GetPrivateProfileIntA("Server", "debug_rec", 0, iniPath);
        debugRec = (debugRecInt != 0);
        
        // Read frequency offset from INI file (can be positive or negative)
        frequencyOffset = GetPrivateProfileIntA("Calibration", "FrequencyOffset", 0, iniPath);
        
        // Read swap_iq from INI file (default: 1 = true for backward compatibility)
        int swapIQInt = GetPrivateProfileIntA("Calibration", "swap_iq", 1, iniPath);
        swapIQ = (swapIQInt != 0);
        
        // Validate and apply configuration
        if (isValidHostname(host) && isValidPort(port)) {
            configHost = host;
            configPort = port;
            
            ss.str("");
            ss << "Configuration loaded from INI: " << configHost << ":" << configPort
               << ", debug_rec=" << (debugRec ? "true" : "false")
               << ", frequencyOffset=" << frequencyOffset << " Hz"
               << ", swap_iq=" << (swapIQ ? "true" : "false");
            write_text_to_log_file(ss.str());
            return 0;
        } else {
            ss.str("");
            ss << "Invalid configuration in INI file (Host=" << host << ", Port=" << port << "), using defaults";
            write_text_to_log_file(ss.str());
            return 1;
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Validate hostname
    bool UberSDR::isValidHostname(const std::string& host)
    {
        if (host.empty() || host.length() > 253) {
            return false;
        }
        
        // Check if it's an IP address
        struct sockaddr_in sa;
        if (inet_pton(AF_INET, host.c_str(), &(sa.sin_addr)) == 1) {
            return true;
        }
        
        // Basic hostname validation
        for (char c : host) {
            if (!isalnum(c) && c != '.' && c != '-') {
                return false;
            }
        }
        
        return true;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Validate port
    bool UberSDR::isValidPort(int port)
    {
        return (port > 0 && port <= 65535);
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Select IQ mode based on sample rate
    std::string UberSDR::selectIQMode(int rateID)
    {
        if (rateID == 0) return "iq48";   // 48 kHz
        if (rateID == 1) return "iq96";   // 96 kHz
        if (rateID == 2) return "iq192";  // 192 kHz
        return "iq192";  // Default
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Connect to server
    int UberSDR::Connect(const std::string& host, int port, bool ssl)
    {
        serverHost = host;
        serverPort = port;
        useSSL = ssl;
        
        std::stringstream ss;
        ss << "Connecting to " << serverHost << ":" << serverPort;
        write_text_to_log_file(ss.str());
        
        // For now, just validate that we can resolve the host
        struct addrinfo hints, *result = NULL;
        ZeroMemory(&hints, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        
        char portStr[10];
        sprintf_s(portStr, sizeof(portStr), "%d", port);
        
        int iResult = getaddrinfo(host.c_str(), portStr, &hints, &result);
        if (iResult != 0) {
            ss.str("");
            ss << "getaddrinfo failed: " << iResult;
            write_text_to_log_file(ss.str());
            return 1;
        }
        
        freeaddrinfo(result);
        write_text_to_log_file("Server address resolved successfully");
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Disconnect from server
    int UberSDR::Disconnect(void)
    {
        write_text_to_log_file("Disconnecting from server");
        
        // Stop all receivers
        for (int i = 0; i < MAX_RX_COUNT; i++)
        {
            if (receivers[i].active) {
                StopReceiver(i);
            }
        }
        
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Check if connection is allowed (HTTP POST to /connection)
    bool UberSDR::CheckConnectionAllowed(int receiverID)
    {
        // Generate a proper UUID using Windows RPC
        UUID uuid;
        UuidCreate(&uuid);
        
        RPC_CSTR uuidStr;
        UuidToStringA(&uuid, &uuidStr);
        
        std::string uuidString = (char*)uuidStr;
        RpcStringFreeA(&uuidStr);
        
        std::stringstream ss;
        ss << "Generated UUID for receiver " << receiverID << ": " << uuidString;
        write_text_to_log_file(ss.str());
        
        // Store the UUID for this receiver with mutex protection
        EnterCriticalSection(&receivers[receiverID].lock);
        receivers[receiverID].sessionId = uuidString;
        std::string sessionIdCopy = receivers[receiverID].sessionId;
        LeaveCriticalSection(&receivers[receiverID].lock);
        
        // Build body using the copied UUID to ensure consistency
        std::stringstream body;
        body << "{\"user_session_id\":\"" << sessionIdCopy << "\"}";
        
        ss.str("");
        ss << "HTTP POST body for receiver " << receiverID << ": " << body.str();
        write_text_to_log_file(ss.str());
        
        std::string response;
        if (!HttpPost("/connection", body.str(), response)) {
            ss.str("");
            ss << "Connection check failed for receiver " << receiverID << " (server not responding)";
            write_text_to_log_file(ss.str());
            return false;  // Do NOT attempt WebSocket connection if HTTP check fails
        }
        
        write_text_to_log_file("HTTP Response: " + response);
        
        // Parse response (simple check for "allowed":true)
        if (response.find("\"allowed\":true") != std::string::npos) {
            ss.str("");
            ss << "Connection allowed for receiver " << receiverID;
            write_text_to_log_file(ss.str());
            return true;
        }
        
        ss.str("");
        ss << "Connection rejected for receiver " << receiverID << ": " << response;
        write_text_to_log_file(ss.str());
        return false;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // HTTP POST request
    bool UberSDR::HttpPost(const std::string& path, const std::string& body, std::string& response)
    {
        SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock == INVALID_SOCKET) {
            return false;
        }
        
        // Resolve server address
        struct addrinfo hints, *result = NULL;
        ZeroMemory(&hints, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        
        char portStr[10];
        sprintf_s(portStr, sizeof(portStr), "%d", serverPort);
        
        if (getaddrinfo(serverHost.c_str(), portStr, &hints, &result) != 0) {
            closesocket(sock);
            return false;
        }
        
        // Connect
        if (connect(sock, result->ai_addr, (int)result->ai_addrlen) == SOCKET_ERROR) {
            freeaddrinfo(result);
            closesocket(sock);
            return false;
        }
        
        freeaddrinfo(result);
        
        // Build HTTP request
        std::stringstream request;
        request << "POST " << path << " HTTP/1.1\r\n";
        request << "Host: " << serverHost << ":" << serverPort << "\r\n";
        request << "Content-Type: application/json\r\n";
        request << "User-Agent: UberSDR Client 1.0 (dll)\r\n";
        request << "Content-Length: " << body.length() << "\r\n";
        request << "Connection: close\r\n";
        request << "\r\n";
        request << body;
        
        std::string reqStr = request.str();
        
        // Send request
        if (send(sock, reqStr.c_str(), (int)reqStr.length(), 0) == SOCKET_ERROR) {
            closesocket(sock);
            return false;
        }
        
        // Receive response
        char buffer[4096];
        int bytesReceived;
        response.clear();
        
        while ((bytesReceived = recv(sock, buffer, sizeof(buffer) - 1, 0)) > 0) {
            buffer[bytesReceived] = '\0';
            response += buffer;
        }
        
        closesocket(sock);
        return true;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Get total frequency offset (global + per-receiver)
    int UberSDR::GetTotalFrequencyOffset(int receiverID)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return frequencyOffset;  // Just return global offset
        }
        
        EnterCriticalSection(&receivers[receiverID].lock);
        int totalOffset = frequencyOffset + receivers[receiverID].perReceiverOffset;
        LeaveCriticalSection(&receivers[receiverID].lock);
        
        return totalOffset;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Build WebSocket URL (matches Go client format)
    std::string UberSDR::BuildWebSocketURL(int receiverID, int frequency, const std::string& mode)
    {
        // Use the UUID that was generated in CheckConnectionAllowed with mutex protection
        EnterCriticalSection(&receivers[receiverID].lock);
        std::string uuidString = receivers[receiverID].sessionId;
        
        // If not set, generate a new one (should not happen in normal flow)
        if (uuidString.empty()) {
            LeaveCriticalSection(&receivers[receiverID].lock);
            
            UUID uuid;
            UuidCreate(&uuid);
            
            RPC_CSTR uuidStr;
            UuidToStringA(&uuid, &uuidStr);
            
            uuidString = (char*)uuidStr;
            RpcStringFreeA(&uuidStr);
            
            EnterCriticalSection(&receivers[receiverID].lock);
            receivers[receiverID].sessionId = uuidString;
        }
        LeaveCriticalSection(&receivers[receiverID].lock);
        
        // NOTE: Frequency offset is now applied in software (IQ processing), not at tune time
        // This allows Skimmer Server to receive frequency-shifted IQ data
        
        std::stringstream url;
        url << (useSSL ? "wss://" : "ws://");
        url << serverHost << ":" << serverPort;
        url << "/ws?frequency=" << frequency;  // No offset applied here
        url << "&mode=" << mode;
        // The format name is historical: it selects the lossless path, which
        // from version 4 is the predictive codec rather than a zstd wrapper.
        url << "&format=pcm-zstd";
        // Named explicitly rather than left to the server's default of 1. A
        // server from 0.1.63 on refuses a version it cannot serve; an older one
        // answers with version 1, which HandleWebSocketMessage recognises and
        // reports.
        url << "&version=" << ubersdr::kPCMProtocolVersion;
        url << "&user_session_id=" << uuidString;
        
        return url.str();
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Start receiver
    int UberSDR::StartReceiver(int receiverID, int frequency, const std::string& mode)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return 1;
        }
        
        std::stringstream ss;
        ss << "Starting receiver " << receiverID << " at " << frequency << " Hz, mode " << mode;
        write_text_to_log_file(ss.str());
        
        // Initialize ring buffer (2000ms at current sample rate for better jitter absorption)
        size_t bufferCapacity = (sampleRate * 2000) / 1000;  // 2000ms worth of samples
        // The cushion this receiver builds before it joins the mix; see
        // RING_TARGET_MS, which the consumer's rate trim also settles at. The
        // give-up bound is 2 s, twenty times what building the cushion takes on
        // a link that can carry the stream.
        size_t primeSamples = (sampleRate * RING_TARGET_MS) / 1000;
        size_t primeGiveUpSamples = (size_t)sampleRate * 2;
        receivers[receiverID].ringBuffer.init(bufferCapacity, primeSamples, primeGiveUpSamples);
        
        ss.str("");
        ss << "Initialized ring buffer for receiver " << receiverID
           << ": " << bufferCapacity << " samples ("
           << (bufferCapacity * 8 / 1024) << " KB)";
        write_text_to_log_file(ss.str());
        
        // Check if connection is allowed (HTTP POST to /connection)
        if (!CheckConnectionAllowed(receiverID)) {
            std::stringstream ss;
            ss << "Connection not allowed for receiver " << receiverID << " - aborting StartReceiver";
            write_text_to_log_file(ss.str());
            receivers[receiverID].active = false;
            receivers[receiverID].state = ERROR_STATE;
            return 1;
        }
        
        // Build WebSocket URL
        std::string url = BuildWebSocketURL(receiverID, frequency, mode);
        ss.str("");
        ss << "WebSocket URL: " << url;
        write_text_to_log_file(ss.str());
        
        // Store receiver configuration
        receivers[receiverID].frequency = frequency;
        receivers[receiverID].mode = mode;
        receivers[receiverID].active = true;
        receivers[receiverID].state = CONNECTING;
        
        // Connect WebSocket (implementation needed)
        int result = ConnectWebSocket(receiverID, url);
        if (result == 0) {
            receivers[receiverID].state = CONNECTED;
            activeReceivers++;
            write_text_to_log_file("Receiver " + std::to_string(receiverID) + " connected");
        } else {
            receivers[receiverID].state = ERROR_STATE;
            receivers[receiverID].active = false;
            write_text_to_log_file("Failed to connect receiver " + std::to_string(receiverID));
        }
        
        return result;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Stop receiver
    int UberSDR::StopReceiver(int receiverID)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return 1;
        }
        
        EnterCriticalSection(&receivers[receiverID].lock);
        bool wasActive = receivers[receiverID].active;
        LeaveCriticalSection(&receivers[receiverID].lock);
        
        if (!wasActive) {
            return 0;
        }
        
        try {
            std::stringstream ss;
            ss << "Stopping receiver " << receiverID;
            write_text_to_log_file(ss.str());
            
            // Set active to false and clear reconnect flag
            EnterCriticalSection(&receivers[receiverID].lock);
            receivers[receiverID].active = false;
            receivers[receiverID].needsReconnect = false;
            receivers[receiverID].state = DISCONNECTED;
            HANDLE threadHandle = receivers[receiverID].reconnectThread;
            LeaveCriticalSection(&receivers[receiverID].lock);
            
            // Wait for reconnection thread to exit if it's running
            if (threadHandle != NULL) {
                write_text_to_log_file("Waiting for reconnection thread to exit...");
                WaitForSingleObject(threadHandle, 5000);  // Wait up to 5 seconds
                CloseHandle(threadHandle);
                
                EnterCriticalSection(&receivers[receiverID].lock);
                receivers[receiverID].reconnectThread = NULL;
                LeaveCriticalSection(&receivers[receiverID].lock);
            }
            
            DisconnectWebSocket(receiverID);
            
            if (activeReceivers > 0) {
                activeReceivers--;
            }
            
            write_text_to_log_file("Receiver stopped successfully");
            return 0;
        }
        catch (const std::exception& e) {
            std::stringstream ss;
            ss << "Exception in StopReceiver: " << e.what();
            write_text_to_log_file(ss.str());
            return 1;
        }
        catch (...) {
            write_text_to_log_file("Unknown exception in StopReceiver");
            return 1;
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Set frequency
    int UberSDR::SetFrequency(int receiverID, int frequency)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return 1;
        }
        
        std::stringstream ss;
        ss << "Setting frequency for receiver " << receiverID << " to " << frequency << " Hz";
        write_text_to_log_file(ss.str());
        
        // If receiver is active, send tune message instead of reconnecting
        if (receivers[receiverID].active && receivers[receiverID].wsClient != nullptr) {
            // NOTE: Frequency offset is now applied in software (IQ processing), not at tune time
            // Send tune message without offset - offset will be applied to IQ data
            
            // Build tune message JSON
            std::stringstream tuneMsg;
            tuneMsg << "{\"type\":\"tune\",\"frequency\":" << frequency << "}";  // No offset applied
            
            ss.str("");
            ss << "Sending tune message to receiver " << receiverID << ": " << tuneMsg.str();
            write_text_to_log_file(ss.str());
            
            // Send tune message via WebSocket
            try {
                receivers[receiverID].wsClient->send(tuneMsg.str());
                receivers[receiverID].frequency = frequency;
                write_text_to_log_file("Tune message sent successfully");
                return 0;
            }
            catch (const std::exception& e) {
                ss.str("");
                ss << "Exception sending tune message: " << e.what() << " - will reconnect";
                write_text_to_log_file(ss.str());
                
                // Tune failed - disconnect and reconnect with new frequency
                DisconnectWebSocket(receiverID);
                
                // Check connection allowed before reconnecting
                if (!CheckConnectionAllowed(receiverID)) {
                    write_text_to_log_file("Connection not allowed for receiver reconnection");
                    return 1;
                }
                
                // Reconnect with new frequency
                std::string url = BuildWebSocketURL(receiverID, frequency, receivers[receiverID].mode);
                receivers[receiverID].frequency = frequency;
                receivers[receiverID].state = CONNECTING;
                
                int result = ConnectWebSocket(receiverID, url);
                if (result == 0) {
                    receivers[receiverID].state = CONNECTED;
                    write_text_to_log_file("Receiver reconnected successfully");
                } else {
                    receivers[receiverID].state = ERROR_STATE;
                    receivers[receiverID].active = false;
                    write_text_to_log_file("Failed to reconnect receiver");
                }
                return result;
            }
            catch (...) {
                write_text_to_log_file("Unknown exception sending tune message - will reconnect");
                
                // Tune failed - disconnect and reconnect
                DisconnectWebSocket(receiverID);
                
                // Check connection allowed before reconnecting
                if (!CheckConnectionAllowed(receiverID)) {
                    write_text_to_log_file("Connection not allowed for receiver reconnection");
                    return 1;
                }
                
                // Reconnect with new frequency
                std::string url = BuildWebSocketURL(receiverID, frequency, receivers[receiverID].mode);
                receivers[receiverID].frequency = frequency;
                receivers[receiverID].state = CONNECTING;
                
                int result = ConnectWebSocket(receiverID, url);
                if (result == 0) {
                    receivers[receiverID].state = CONNECTED;
                    write_text_to_log_file("Receiver reconnected successfully");
                } else {
                    receivers[receiverID].state = ERROR_STATE;
                    receivers[receiverID].active = false;
                    write_text_to_log_file("Failed to reconnect receiver");
                }
                return result;
            }
        }
        
        receivers[receiverID].frequency = frequency;
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Reconnection thread entry point
    DWORD WINAPI UberSDR::ReconnectionThreadProc(LPVOID param)
    {
        struct ThreadParam {
            UberSDR* instance;
            int receiverID;
        };
        
        ThreadParam* tp = (ThreadParam*)param;
        UberSDR* instance = tp->instance;
        int receiverID = tp->receiverID;
        delete tp;
        
        instance->HandleReconnection(receiverID);
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Handle reconnection in dedicated thread
    void UberSDR::HandleReconnection(int receiverID)
    {
        std::stringstream ss;
        ss << "Reconnection thread started for receiver " << receiverID;
        write_text_to_log_file(ss.str());
        
        // Retry forever with exponential backoff capped at 60 seconds
        int retryDelay = 1000; // Start with 1 second
        const int maxDelay = 60000; // Cap at 60 seconds
        bool reconnected = false;
        int attempt = 0;
        
        while (!reconnected) {
            attempt++;
            
            // Check if still active (might have been stopped)
            EnterCriticalSection(&receivers[receiverID].lock);
            bool stillActive = receivers[receiverID].active;
            bool stillNeedsReconnect = receivers[receiverID].needsReconnect;
            LeaveCriticalSection(&receivers[receiverID].lock);
            
            if (!stillActive || !stillNeedsReconnect) {
                ss.str("");
                ss << "Receiver " << receiverID << " no longer needs reconnection, thread exiting";
                write_text_to_log_file(ss.str());
                
                EnterCriticalSection(&receivers[receiverID].lock);
                receivers[receiverID].needsReconnect = false;
                receivers[receiverID].reconnectThread = NULL;
                LeaveCriticalSection(&receivers[receiverID].lock);
                return;
            }
            
            ss.str("");
            ss << "Reconnection attempt " << attempt
               << " for receiver " << receiverID << " (waiting " << (retryDelay/1000) << "s)";
            write_text_to_log_file(ss.str());
            
            Sleep(retryDelay);
            
            // Do HTTP connection check before reconnecting
            if (!CheckConnectionAllowed(receiverID)) {
                ss.str("");
                ss << "Connection check failed for receiver " << receiverID
                   << " on attempt " << attempt << ", will retry";
                write_text_to_log_file(ss.str());
                
                // Double the delay for next attempt (exponential backoff), cap at 60s
                retryDelay = (retryDelay * 2 > maxDelay) ? maxDelay : retryDelay * 2;
                continue;
            }
            
            // HTTP check succeeded - proceed with WebSocket reconnection
            EnterCriticalSection(&receivers[receiverID].lock);
            receivers[receiverID].generation++;
            int currentFreq = receivers[receiverID].frequency;
            std::string currentMode = receivers[receiverID].mode;
            LeaveCriticalSection(&receivers[receiverID].lock);
            
            // Build new WebSocket URL with current frequency
            std::string reconnectUrl = BuildWebSocketURL(receiverID, currentFreq, currentMode);
            
            ss.str("");
            ss << "Reconnecting to: " << reconnectUrl << " (gen " << receivers[receiverID].generation << ")";
            write_text_to_log_file(ss.str());
            
            // Disconnect old WebSocket properly
            EnterCriticalSection(&receivers[receiverID].lock);
            if (receivers[receiverID].wsClient != nullptr) {
                receivers[receiverID].wsClient->setOnMessageCallback(nullptr);
                receivers[receiverID].wsClient->stop();
                LeaveCriticalSection(&receivers[receiverID].lock);
                
                Sleep(100);
                
                EnterCriticalSection(&receivers[receiverID].lock);
                delete receivers[receiverID].wsClient;
                receivers[receiverID].wsClient = nullptr;
                LeaveCriticalSection(&receivers[receiverID].lock);
            } else {
                LeaveCriticalSection(&receivers[receiverID].lock);
            }
            
            // Reconnect with new WebSocket
            EnterCriticalSection(&receivers[receiverID].lock);
            receivers[receiverID].state = CONNECTING;
            LeaveCriticalSection(&receivers[receiverID].lock);
            
            int result = ConnectWebSocket(receiverID, reconnectUrl);
            if (result == 0) {
                EnterCriticalSection(&receivers[receiverID].lock);
                receivers[receiverID].state = CONNECTED;
                receivers[receiverID].needsReconnect = false;
                receivers[receiverID].reconnectThread = NULL;
                LeaveCriticalSection(&receivers[receiverID].lock);
                
                ss.str("");
                ss << "Automatic reconnection successful for receiver " << receiverID
                   << " on attempt " << attempt;
                write_text_to_log_file(ss.str());
                reconnected = true;
            } else {
                ss.str("");
                ss << "WebSocket connection failed for receiver " << receiverID
                   << " on attempt " << attempt << ", will retry";
                write_text_to_log_file(ss.str());
                
                // Double the delay for next attempt (exponential backoff), cap at 60s
                retryDelay = (retryDelay * 2 > maxDelay) ? maxDelay : retryDelay * 2;
            }
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Connect WebSocket using IXWebSocket
    int UberSDR::ConnectWebSocket(int receiverID, const std::string& url)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return 1;
        }

        // A new socket is a new stream, and the version 4 predictor is the
        // stream: its taps hold the adaptation of every sample the PREVIOUS
        // socket carried, while the server opens the new one with an encoder
        // whose taps are zero. Decoding against the old ones does not fail --
        // it returns plausible full-scale noise, for the life of the
        // connection, because nothing in the protocol ever resynchronises the
        // predictor. The periodic metadata resync only restores the HEADER
        // baseline, so not one packet is ever reported as bad.
        //
        // The reset belongs here rather than in the callers because every path
        // that reaches this function opens a socket: StartReceiver, both of
        // SetFrequency's fallbacks when the tune message throws, and
        // HandleReconnection -- which is the one that fires in normal running,
        // and the one that used to miss the reset.
        receivers[receiverID].pcmDecoder.reset();
        receivers[receiverID].pcmStreamBroken = false;

        // The new stream starts with whatever the dead one left in the ring
        // buffer, which after an outage is nothing. Build the cushion again
        // before this receiver rejoins the mix, for the reason in reprime().
        receivers[receiverID].ringBuffer.reprime();

        std::stringstream ss;
        ss << "Connecting WebSocket for receiver " << receiverID << " to: " << url;
        write_text_to_log_file(ss.str());
        
        try {
            // Create WebSocket client
            write_text_to_log_file("Creating WebSocket client object...");
            receivers[receiverID].wsClient = new ix::WebSocket();
            write_text_to_log_file("WebSocket client object created");
        }
        catch (const std::exception& e) {
            ss.str("");
            ss << "Exception creating WebSocket: " << e.what();
            write_text_to_log_file(ss.str());
            return 1;
        }
        catch (...) {
            write_text_to_log_file("Unknown exception creating WebSocket");
            return 1;
        }
        
        // Set URL
        receivers[receiverID].wsClient->setUrl(url);
        
        // Disable automatic reconnection - we'll handle it manually
        receivers[receiverID].wsClient->disableAutomaticReconnection();
        
        // Disable TLS verification (we're using plain ws://)
        ix::SocketTLSOptions tlsOptions;
        tlsOptions.disable_hostname_validation = true;
        receivers[receiverID].wsClient->setTLSOptions(tlsOptions);
        
        // Capture generation counter to detect stale callbacks
        int currentGeneration = receivers[receiverID].generation;
        
        // Setup message callback with generation check
        receivers[receiverID].wsClient->setOnMessageCallback(
            [this, receiverID, currentGeneration](const ix::WebSocketMessagePtr& msg)
            {
                // Check if this callback is still valid with lock protection
                EnterCriticalSection(&receivers[receiverID].lock);
                bool isStale = (receivers[receiverID].generation != currentGeneration);
                bool isActive = receivers[receiverID].active;
                ix::WebSocket* wsPtr = receivers[receiverID].wsClient;
                LeaveCriticalSection(&receivers[receiverID].lock);
                
                // If stale callback or wsClient is null, ignore all messages
                if (isStale || wsPtr == nullptr) {
                    return;
                }
                
                if (msg->type == ix::WebSocketMessageType::Message)
                {
                    // Double-check receiver is still active before processing
                    if (!isActive) {
                        return;
                    }
                    // Handle incoming message
                    HandleWebSocketMessage(receiverID, msg->str);
                }
                else if (msg->type == ix::WebSocketMessageType::Open)
                {
                    std::stringstream ss;
                    ss << "Receiver " << receiverID << " WebSocket connected (gen " << currentGeneration << ")";
                    write_text_to_log_file(ss.str());
                    
                    EnterCriticalSection(&receivers[receiverID].lock);
                    receivers[receiverID].state = CONNECTED;
                    LeaveCriticalSection(&receivers[receiverID].lock);
                }
                else if (msg->type == ix::WebSocketMessageType::Close)
                {
                    std::stringstream ss;
                    ss << "Receiver " << receiverID << " WebSocket closed: "
                       << msg->closeInfo.code << " " << msg->closeInfo.reason
                       << " (gen " << currentGeneration << ")";
                    write_text_to_log_file(ss.str());
                    
                    EnterCriticalSection(&receivers[receiverID].lock);
                    receivers[receiverID].state = DISCONNECTED;
                    
                    // Only attempt reconnection if receiver is still supposed to be active
                    // and this is the current generation (not a stale callback)
                    if (receivers[receiverID].active &&
                        receivers[receiverID].generation == currentGeneration &&
                        !receivers[receiverID].needsReconnect) {
                        
                        // Set flag and spawn reconnection thread
                        receivers[receiverID].needsReconnect = true;
                        LeaveCriticalSection(&receivers[receiverID].lock);
                        
                        write_text_to_log_file("Spawning reconnection thread...");
                        
                        // Create thread parameter
                        struct ThreadParam {
                            UberSDR* instance;
                            int receiverID;
                        };
                        ThreadParam* tp = new ThreadParam;
                        tp->instance = this;
                        tp->receiverID = receiverID;
                        
                        // Spawn reconnection thread
                        EnterCriticalSection(&receivers[receiverID].lock);
                        receivers[receiverID].reconnectThread = CreateThread(
                            NULL, 0, ReconnectionThreadProc, tp, 0, NULL);
                        LeaveCriticalSection(&receivers[receiverID].lock);
                        
                        if (receivers[receiverID].reconnectThread == NULL) {
                            write_text_to_log_file("Failed to create reconnection thread");
                            delete tp;
                            EnterCriticalSection(&receivers[receiverID].lock);
                            receivers[receiverID].needsReconnect = false;
                            LeaveCriticalSection(&receivers[receiverID].lock);
                        }
                    } else {
                        LeaveCriticalSection(&receivers[receiverID].lock);
                    }
                }
                else if (msg->type == ix::WebSocketMessageType::Error)
                {
                    std::stringstream ss;
                    ss << "Receiver " << receiverID << " WebSocket error: "
                       << msg->errorInfo.reason
                       << " (gen " << currentGeneration << ")";
                    write_text_to_log_file(ss.str());
                    
                    EnterCriticalSection(&receivers[receiverID].lock);
                    receivers[receiverID].state = ERROR_STATE;
                    LeaveCriticalSection(&receivers[receiverID].lock);
                }
                else if (msg->type == ix::WebSocketMessageType::Pong)
                {
                    // Pong received (keepalive response)
                }
            }
        );
        
        // Start connection
        try {
            write_text_to_log_file("Starting WebSocket connection...");
            receivers[receiverID].wsClient->start();
            write_text_to_log_file("WebSocket start() called");
        }
        catch (const std::exception& e) {
            ss.str("");
            ss << "Exception starting WebSocket: " << e.what();
            write_text_to_log_file(ss.str());
            return 1;
        }
        catch (...) {
            write_text_to_log_file("Unknown exception starting WebSocket");
            return 1;
        }
        
        // Wait for connection (with timeout)
        int timeout = 5000; // 5 seconds
        int elapsed = 0;
        while (receivers[receiverID].state == CONNECTING && elapsed < timeout) {
            Sleep(100);
            elapsed += 100;
        }
        
        if (receivers[receiverID].state != CONNECTED) {
            ss.str("");
            ss << "WebSocket connection timeout or failed for receiver " << receiverID;
            write_text_to_log_file(ss.str());
            return 1;
        }
        
        ss.str("");
        ss << "Receiver " << receiverID << " WebSocket connected successfully";
        write_text_to_log_file(ss.str());
        return 0;
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Disconnect WebSocket
    void UberSDR::DisconnectWebSocket(int receiverID)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return;
        }
        
        ix::WebSocket* wsToDelete = nullptr;
        
        try {
            EnterCriticalSection(&receivers[receiverID].lock);
            
            if (receivers[receiverID].wsClient != nullptr) {
                std::stringstream ss;
                ss << "Disconnecting WebSocket for receiver " << receiverID << " (gen " << receivers[receiverID].generation << ")";
                write_text_to_log_file(ss.str());
                
                // Increment generation to invalidate any pending callbacks
                receivers[receiverID].generation++;
                write_text_to_log_file("Generation incremented");
                
                // Store pointer and null it out FIRST while holding lock
                wsToDelete = receivers[receiverID].wsClient;
                receivers[receiverID].wsClient = nullptr;
                receivers[receiverID].state = DISCONNECTED;
                write_text_to_log_file("wsClient pointer nulled");
                
                LeaveCriticalSection(&receivers[receiverID].lock);
                
                // Now work with the local pointer outside the lock
                if (wsToDelete != nullptr) {
                    write_text_to_log_file("Clearing callback...");
                    try {
                        wsToDelete->setOnMessageCallback(nullptr);
                        write_text_to_log_file("Callback cleared");
                    }
                    catch (...) {
                        write_text_to_log_file("Exception clearing callback");
                    }
                    
                    // Give time for any in-flight callbacks to see the null wsClient
                    Sleep(200);
                    
                    write_text_to_log_file("Stopping WebSocket client...");
                    try {
                        wsToDelete->stop();
                        write_text_to_log_file("WebSocket stop() called");
                    }
                    catch (const std::exception& e) {
                        std::stringstream ss;
                        ss << "Exception in stop(): " << e.what();
                        write_text_to_log_file(ss.str());
                    }
                    catch (...) {
                        write_text_to_log_file("Unknown exception in stop()");
                    }
                    
                    // Wait longer for WebSocket to fully stop
                    Sleep(300);
                    
                    write_text_to_log_file("Deleting WebSocket client...");
                    try {
                        delete wsToDelete;
                        write_text_to_log_file("WebSocket client deleted");
                    }
                    catch (const std::exception& e) {
                        std::stringstream ss;
                        ss << "Exception in delete: " << e.what();
                        write_text_to_log_file(ss.str());
                    }
                    catch (...) {
                        write_text_to_log_file("Unknown exception in delete");
                    }
                }
            } else {
                receivers[receiverID].state = DISCONNECTED;
                LeaveCriticalSection(&receivers[receiverID].lock);
                write_text_to_log_file("wsClient was already null");
            }
        }
        catch (const std::exception& e) {
            std::stringstream ss;
            ss << "Exception in DisconnectWebSocket: " << e.what();
            write_text_to_log_file(ss.str());
            
            // Try to clean up if we have a pointer
            if (wsToDelete != nullptr) {
                try {
                    delete wsToDelete;
                }
                catch (...) {
                    // Silent - we're already in error handling
                }
            }
        }
        catch (...) {
            write_text_to_log_file("Unknown exception in DisconnectWebSocket");
            
            // Try to clean up if we have a pointer
            if (wsToDelete != nullptr) {
                try {
                    delete wsToDelete;
                }
                catch (...) {
                    // Silent - we're already in error handling
                }
            }
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Handle WebSocket message - protocol version 4 binary frames
    //
    // Versions 1 to 3 sent a zstd frame wrapping a fixed 29- or 13-byte header
    // and the samples verbatim. Version 4 sends a variable-length header and a
    // predictively coded body; see pcm_v4.hpp.
    //
    // Every frame must reach the decoder even if the result is discarded: the
    // predictor derives its filter taps from the samples already decoded, so a
    // skipped packet desynchronises this side from the server permanently.
    void UberSDR::HandleWebSocketMessage(int receiverID, const std::string& message)
    {
        try {
            if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
                return;
            }
            if (message.size() < 4) {
                write_text_to_log_file("Message too small");
                return;
            }

            const uint8_t* wire = reinterpret_cast<const uint8_t*>(message.data());
            const size_t wireSize = message.size();

            // Bytes actually received, which is what the monitor reports as
            // network bandwidth. Under version 4 this is the coded size; there
            // is no separate compressed and decompressed figure any more.
            ::TrackCompressedBytes(receiverID, wireSize);

            // A server older than 0.1.63 clamps a version it cannot serve down
            // to 1 and answers with a zstd frame rather than refusing. Naming
            // that beats logging a bad magic for every packet at 192 kHz.
            if (ubersdr::PCMv4StreamDecoder::isZstdFrame(wire, wireSize)) {
                write_text_to_log_file("Server does not support audio protocol version 4 "
                                       "(needs UberSDR 0.1.63 or later) - this DLL reads version 4 only");
                return;
            }

            ubersdr::PCMv4Header header;
            std::string err;
            if (!receivers[receiverID].pcmDecoder.decode(wire, wireSize, header, err)) {
                // Not one lost packet: the end of this stream. The predictor
                // derives its taps from the samples already decoded, so a
                // packet that fails to reach it leaves these filters where the
                // server's no longer are, and every packet after it decodes as
                // full-scale noise -- silently, because nothing in the protocol
                // ever resynchronises a predictor. The only recovery is a new
                // socket, so ask for one the way a dropped connection does: the
                // close callback spawns the reconnection thread, and
                // ConnectWebSocket resets the decoder on the way back up.
                //
                // close() rather than stop(): stop() joins the very thread this
                // callback runs on. The flag makes this once per stream, since
                // the packets already in flight behind this one will fail too.
                if (!receivers[receiverID].pcmStreamBroken) {
                    receivers[receiverID].pcmStreamBroken = true;

                    std::stringstream ss;
                    ss << "PCM v4 decode error on receiver " << receiverID
                       << " (" << wireSize << " bytes): " << err
                       << " - closing the socket to resynchronise";
                    write_text_to_log_file(ss.str());

                    EnterCriticalSection(&receivers[receiverID].lock);
                    ix::WebSocket* ws = receivers[receiverID].wsClient;
                    LeaveCriticalSection(&receivers[receiverID].lock);
                    if (ws != nullptr) {
                        ws->close(1000, "pcm v4 decode error");
                    }
                }
                return;
            }

            const int16_t* samples = receivers[receiverID].pcmDecoder.samples();
            const int sampleCount = header.sampleCount;
            if (samples == NULL || sampleCount <= 0) {
                return;
            }

            // Must be whole I/Q frames: two channels, two samples per frame.
            if (sampleCount % 2 != 0) {
                std::stringstream ss;
                ss << "Sample count not a whole number of I/Q frames: " << sampleCount;
                write_text_to_log_file(ss.str());
                return;
            }

            // Serialised big-endian because that is what ProcessIQData reads,
            // and it reads that because versions 1 to 3 put radiod's own
            // big-endian samples on the wire untouched. Version 4 changes the
            // encoding, not the byte order of anything: it carries int16 VALUES
            // rather than sample bytes, so the byte order here is this DLL's
            // choice. Keeping it big-endian confines the change to this function
            // and leaves the code that feeds CW Skimmer exactly as it was.
            std::vector<uint8_t> iqBytes((size_t)sampleCount * 2);
            for (int i = 0; i < sampleCount; ++i) {
                const uint16_t v = (uint16_t)samples[i];
                iqBytes[(size_t)i * 2]     = (uint8_t)(v >> 8);
                iqBytes[(size_t)i * 2 + 1] = (uint8_t)(v & 0xFF);
            }

            ::ProcessIQData(receiverID, iqBytes);
        }
        catch (const std::exception& e) {
            std::stringstream ss;
            ss << "Error processing message for receiver " << receiverID << ": " << e.what();
            write_text_to_log_file(ss.str());
        }
    }

    ///////////////////////////////////////////////////////////////////////////////
    // Send keepalive ping
    void UberSDR::SendKeepalive(int receiverID)
    {
        if (receiverID < 0 || receiverID >= MAX_RX_COUNT) {
            return;
        }

        if (receivers[receiverID].wsClient != nullptr &&
            receivers[receiverID].state == CONNECTED) {
            std::string pingMsg = "{\"type\":\"ping\"}";
            receivers[receiverID].wsClient->send(pingMsg);
        }
    }
    
    ///////////////////////////////////////////////////////////////////////////////
    // Process commands from monitor (via shared memory)
    void UberSDR::ProcessCommands(UberSDRSharedStatus* pSharedStatus)
    {
        // This function is called periodically from the DLL to check for commands
        // from the monitor application via shared memory
        
        if (pSharedStatus == NULL) {
            return;  // Shared memory not initialized
        }
        
        // Check if there are any pending commands
        while (pSharedStatus->commandReadPos != pSharedStatus->commandWritePos) {
            int readPos = pSharedStatus->commandReadPos;
            UberSDRCommand& cmd = pSharedStatus->commandQueue[readPos % 16];
            
            // Process command based on type
            if (cmd.commandType == CMD_SET_FREQUENCY_OFFSET) {
                int rxID = cmd.receiverID;
                if (rxID >= 0 && rxID < MAX_RX_COUNT) {
                    // Calculate total offset (INI global + per-receiver)
                    int totalOffset = frequencyOffset + cmd.frequencyOffset;
                    
                    // Calculate phase increment for software frequency shift
                    // NEGATE phase increment: positive offset shifts spectrum DOWN
                    // phaseIncrement = -2 * PI * offset / sampleRate
                    double phaseInc = -2.0 * 3.14159265358979323846 * (double)totalOffset / (double)sampleRate;
                    
                    EnterCriticalSection(&receivers[rxID].lock);
                    receivers[rxID].perReceiverOffset = cmd.frequencyOffset;
                    receivers[rxID].phaseIncrement = phaseInc;
                    receivers[rxID].phaseAccumulator = 0.0;  // Reset phase accumulator
                    LeaveCriticalSection(&receivers[rxID].lock);
                    
                    // Update shared memory status
                    pSharedStatus->receivers[rxID].frequencyOffset = cmd.frequencyOffset;
                    pSharedStatus->receivers[rxID].totalFrequencyOffset = totalOffset;
                    pSharedStatus->receivers[rxID].requestedOffset = cmd.frequencyOffset;
                    pSharedStatus->receivers[rxID].offsetApplied = 0;  // Not yet applied
                    
                    std::stringstream ss;
                    ss << "Set frequency offset for receiver " << rxID << " to " << cmd.frequencyOffset
                       << " Hz (total: " << totalOffset << " Hz including INI offset " << frequencyOffset
                       << " Hz) - software shift enabled";
                    write_text_to_log_file(ss.str());
                    
                    // Acknowledge command
                    cmd.acknowledged = cmd.sequenceNumber;
                }
            }
            else if (cmd.commandType == CMD_APPLY_OFFSET) {
                int rxID = cmd.receiverID;
                if (rxID >= 0 && rxID < MAX_RX_COUNT && receivers[rxID].active) {
                    // Calculate total offset (INI global + per-receiver)
                    int totalOffset = frequencyOffset + cmd.frequencyOffset;
                    
                    // Calculate phase increment for software frequency shift
                    // NEGATE phase increment: positive offset shifts spectrum DOWN
                    // phaseIncrement = -2 * PI * offset / sampleRate
                    double phaseInc = -2.0 * 3.14159265358979323846 * (double)totalOffset / (double)sampleRate;
                    
                    // Set the offset and phase increment
                    EnterCriticalSection(&receivers[rxID].lock);
                    receivers[rxID].perReceiverOffset = cmd.frequencyOffset;
                    receivers[rxID].phaseIncrement = phaseInc;
                    receivers[rxID].phaseAccumulator = 0.0;  // Reset phase accumulator
                    LeaveCriticalSection(&receivers[rxID].lock);
                    
                    // Update shared memory status
                    pSharedStatus->receivers[rxID].frequencyOffset = cmd.frequencyOffset;
                    pSharedStatus->receivers[rxID].totalFrequencyOffset = totalOffset;
                    pSharedStatus->receivers[rxID].requestedOffset = cmd.frequencyOffset;
                    
                    std::stringstream ss;
                    ss << "CMD_APPLY_OFFSET: Rx" << rxID << " offset=" << cmd.frequencyOffset
                       << " Hz, total=" << totalOffset << " Hz, phaseInc=" << phaseInc
                       << " (sampleRate=" << sampleRate << ")";
                    write_text_to_log_file(ss.str());
                    
                    // NOTE: No longer retuning the receiver - offset is applied in software
                    // The IQ data will be frequency-shifted in the processing path
                    
                    // Mark as applied
                    pSharedStatus->receivers[rxID].offsetApplied = 1;
                    
                    // Acknowledge command
                    cmd.acknowledged = cmd.sequenceNumber;
                }
            }
            
            // Move to next command
            pSharedStatus->commandReadPos = (readPos + 1) % 16;
        }
    }
}