// IXSocketFactoryStub.cpp - Stub version without OpenSSL dependencies

#include "IXWebSocket/ixwebsocket/IXSocketFactory.h"
#include "IXWebSocket/ixwebsocket/IXSocket.h"
#include "IXWebSocket/ixwebsocket/IXUniquePtr.h"

namespace ix
{
    std::unique_ptr<Socket> createSocket(bool tls,
                                         int fd,
                                         std::string& errorMsg,
                                         const SocketTLSOptions& tlsOptions)
    {
        (void) tlsOptions;
        errorMsg.clear();
        
        if (tls)
        {
            errorMsg = "TLS support is disabled in this build";
            return nullptr;
        }
        
        // Create plain socket (no TLS)
        std::unique_ptr<Socket> socket = ix::make_unique<Socket>(fd);
        
        if (!socket->init(errorMsg))
        {
            socket.reset();
        }
        
        return socket;
    }
}