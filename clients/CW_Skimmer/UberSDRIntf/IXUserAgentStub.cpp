// IXUserAgentStub.cpp - Stub version without OpenSSL dependencies

#include "IXWebSocket/ixwebsocket/IXUserAgent.h"
#include "IXWebSocket/ixwebsocket/IXWebSocketVersion.h"
#include <sstream>

// Platform name
#if defined(_WIN32) || defined(_WIN64)
#define PLATFORM_NAME "windows"
#elif defined(__linux__)
#define PLATFORM_NAME "linux"
#elif defined(__APPLE__)
#define PLATFORM_NAME "macos"
#else
#define PLATFORM_NAME "unknown"
#endif

namespace ix
{
    std::string userAgent()
    {
        std::stringstream ss;
        
        // IXWebSocket Version
        ss << "ixwebsocket/" << IX_WEBSOCKET_VERSION;
        
        // Platform
        ss << " " << PLATFORM_NAME;
        
        // TLS status
        ss << " nossl";
        
        return ss.str();
    }
}