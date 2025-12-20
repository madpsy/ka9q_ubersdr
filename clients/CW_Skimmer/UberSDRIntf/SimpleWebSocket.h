// SimpleWebSocket.h - Lightweight WebSocket client (no TLS)
// Based on RFC 6455 WebSocket Protocol

#pragma once

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>
#include <vector>
#include <sstream>
#include <random>

#pragma comment(lib, "ws2_32.lib")

namespace SimpleWS
{
    // WebSocket opcodes
    enum Opcode {
        CONTINUATION = 0x0,
        TEXT = 0x1,
        BINARY = 0x2,
        CLOSE = 0x8,
        PING = 0x9,
        PONG = 0xA
    };

    // WebSocket frame structure
    struct Frame {
        bool fin;
        Opcode opcode;
        bool masked;
        uint64_t payloadLength;
        uint8_t maskingKey[4];
        std::vector<uint8_t> payload;
    };

    class WebSocketClient
    {
    private:
        SOCKET sock;
        std::string host;
        int port;
        std::string path;
        bool connected;
        std::mt19937 rng;

        // Generate random masking key
        void generateMaskingKey(uint8_t* key) {
            for (int i = 0; i < 4; i++) {
                key[i] = (uint8_t)(rng() & 0xFF);
            }
        }

        // Apply XOR mask to payload
        void applyMask(std::vector<uint8_t>& data, const uint8_t* mask) {
            for (size_t i = 0; i < data.size(); i++) {
                data[i] ^= mask[i % 4];
            }
        }

        // Generate WebSocket key
        std::string generateKey() {
            uint8_t keyBytes[16];
            for (int i = 0; i < 16; i++) {
                keyBytes[i] = (uint8_t)(rng() & 0xFF);
            }
            return base64Encode(keyBytes, 16);
        }

        // Simple Base64 encoding
        std::string base64Encode(const uint8_t* data, size_t len) {
            static const char* base64Chars = 
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            
            std::string result;
            int val = 0;
            int valb = -6;
            
            for (size_t i = 0; i < len; i++) {
                val = (val << 8) + data[i];
                valb += 8;
                while (valb >= 0) {
                    result.push_back(base64Chars[(val >> valb) & 0x3F]);
                    valb -= 6;
                }
            }
            
            if (valb > -6) {
                result.push_back(base64Chars[((val << 8) >> (valb + 8)) & 0x3F]);
            }
            
            while (result.size() % 4) {
                result.push_back('=');
            }
            
            return result;
        }

    public:
        WebSocketClient() : sock(INVALID_SOCKET), connected(false) {
            rng.seed((unsigned int)time(NULL));
        }

        ~WebSocketClient() {
            disconnect();
        }

        // Connect to WebSocket server
        bool connect(const std::string& url) {
            // Parse URL: ws://host:port/path
            if (url.substr(0, 5) != "ws://") {
                return false;
            }

            std::string remainder = url.substr(5);
            size_t slashPos = remainder.find('/');
            std::string hostPort = (slashPos != std::string::npos) ? 
                remainder.substr(0, slashPos) : remainder;
            path = (slashPos != std::string::npos) ? 
                remainder.substr(slashPos) : "/";

            size_t colonPos = hostPort.find(':');
            if (colonPos != std::string::npos) {
                host = hostPort.substr(0, colonPos);
                port = atoi(hostPort.substr(colonPos + 1).c_str());
            } else {
                host = hostPort;
                port = 80;
            }

            // Create socket
            sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            if (sock == INVALID_SOCKET) {
                return false;
            }

            // Resolve host
            struct addrinfo hints, *result = NULL;
            ZeroMemory(&hints, sizeof(hints));
            hints.ai_family = AF_INET;
            hints.ai_socktype = SOCK_STREAM;
            hints.ai_protocol = IPPROTO_TCP;

            char portStr[10];
            sprintf_s(portStr, sizeof(portStr), "%d", port);

            if (getaddrinfo(host.c_str(), portStr, &hints, &result) != 0) {
                closesocket(sock);
                sock = INVALID_SOCKET;
                return false;
            }

            // Connect
            if (::connect(sock, result->ai_addr, (int)result->ai_addrlen) == SOCKET_ERROR) {
                freeaddrinfo(result);
                closesocket(sock);
                sock = INVALID_SOCKET;
                return false;
            }

            freeaddrinfo(result);

            // Perform WebSocket handshake
            if (!performHandshake()) {
                closesocket(sock);
                sock = INVALID_SOCKET;
                return false;
            }

            connected = true;
            return true;
        }

        // Disconnect
        void disconnect() {
            if (sock != INVALID_SOCKET) {
                // Send close frame
                if (connected) {
                    sendFrame(CLOSE, NULL, 0);
                }
                closesocket(sock);
                sock = INVALID_SOCKET;
            }
            connected = false;
        }

        // Send text message
        bool sendText(const std::string& message) {
            return sendFrame(TEXT, (const uint8_t*)message.c_str(), message.length());
        }

        // Send binary message
        bool sendBinary(const uint8_t* data, size_t length) {
            return sendFrame(BINARY, data, length);
        }

        // Send ping
        bool sendPing() {
            return sendFrame(PING, NULL, 0);
        }

        // Receive frame
        bool receiveFrame(Frame& frame) {
            if (!connected || sock == INVALID_SOCKET) {
                return false;
            }

            // Read first 2 bytes
            uint8_t header[2];
            if (recv(sock, (char*)header, 2, 0) != 2) {
                return false;
            }

            frame.fin = (header[0] & 0x80) != 0;
            frame.opcode = (Opcode)(header[0] & 0x0F);
            frame.masked = (header[1] & 0x80) != 0;
            frame.payloadLength = header[1] & 0x7F;

            // Extended payload length
            if (frame.payloadLength == 126) {
                uint8_t len[2];
                if (recv(sock, (char*)len, 2, 0) != 2) {
                    return false;
                }
                frame.payloadLength = (len[0] << 8) | len[1];
            } else if (frame.payloadLength == 127) {
                uint8_t len[8];
                if (recv(sock, (char*)len, 8, 0) != 8) {
                    return false;
                }
                frame.payloadLength = 0;
                for (int i = 0; i < 8; i++) {
                    frame.payloadLength = (frame.payloadLength << 8) | len[i];
                }
            }

            // Masking key (server should not mask)
            if (frame.masked) {
                if (recv(sock, (char*)frame.maskingKey, 4, 0) != 4) {
                    return false;
                }
            }

            // Payload
            if (frame.payloadLength > 0) {
                frame.payload.resize((size_t)frame.payloadLength);
                size_t totalReceived = 0;
                while (totalReceived < frame.payloadLength) {
                    int received = recv(sock, (char*)&frame.payload[totalReceived], 
                                      (int)(frame.payloadLength - totalReceived), 0);
                    if (received <= 0) {
                        return false;
                    }
                    totalReceived += received;
                }

                if (frame.masked) {
                    applyMask(frame.payload, frame.maskingKey);
                }
            }

            return true;
        }

        // Check if connected
        bool isConnected() const {
            return connected;
        }

    private:
        // Perform WebSocket handshake
        bool performHandshake() {
            std::string key = generateKey();

            // Build handshake request
            std::stringstream request;
            request << "GET " << path << " HTTP/1.1\r\n";
            request << "Host: " << host << ":" << port << "\r\n";
            request << "Upgrade: websocket\r\n";
            request << "Connection: Upgrade\r\n";
            request << "Sec-WebSocket-Key: " << key << "\r\n";
            request << "Sec-WebSocket-Version: 13\r\n";
            request << "User-Agent: UberSDR Client 1.0 (dll)\r\n";
            request << "\r\n";

            std::string reqStr = request.str();

            // Send handshake
            if (send(sock, reqStr.c_str(), (int)reqStr.length(), 0) == SOCKET_ERROR) {
                return false;
            }

            // Receive response
            char buffer[4096];
            int received = recv(sock, buffer, sizeof(buffer) - 1, 0);
            if (received <= 0) {
                return false;
            }
            buffer[received] = '\0';

            std::string response(buffer);

            // Check for "101 Switching Protocols"
            if (response.find("101") == std::string::npos) {
                return false;
            }

            // Check for "Upgrade: websocket"
            if (response.find("Upgrade: websocket") == std::string::npos &&
                response.find("upgrade: websocket") == std::string::npos) {
                return false;
            }

            return true;
        }

        // Send WebSocket frame
        bool sendFrame(Opcode opcode, const uint8_t* data, size_t length) {
            if (!connected || sock == INVALID_SOCKET) {
                return false;
            }

            std::vector<uint8_t> frame;

            // First byte: FIN + opcode
            frame.push_back(0x80 | (uint8_t)opcode);

            // Second byte: MASK + payload length
            if (length < 126) {
                frame.push_back(0x80 | (uint8_t)length);
            } else if (length < 65536) {
                frame.push_back(0x80 | 126);
                frame.push_back((uint8_t)(length >> 8));
                frame.push_back((uint8_t)(length & 0xFF));
            } else {
                frame.push_back(0x80 | 127);
                for (int i = 7; i >= 0; i--) {
                    frame.push_back((uint8_t)((length >> (i * 8)) & 0xFF));
                }
            }

            // Masking key
            uint8_t maskingKey[4];
            generateMaskingKey(maskingKey);
            for (int i = 0; i < 4; i++) {
                frame.push_back(maskingKey[i]);
            }

            // Payload (masked)
            if (data && length > 0) {
                std::vector<uint8_t> payload(data, data + length);
                applyMask(payload, maskingKey);
                frame.insert(frame.end(), payload.begin(), payload.end());
            }

            // Send frame
            int sent = send(sock, (const char*)frame.data(), (int)frame.size(), 0);
            return (sent == (int)frame.size());
        }
    };
}