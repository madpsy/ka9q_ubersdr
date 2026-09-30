#pragma once
// A minimal RFC 6455 client: what UberSDR's /ws endpoint needs and nothing more.
// No extensions are offered, so frames are never compressed.
#include "http.h"
#include "tls_conn.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ubersdr {
    class WebSocket {
    public:
        struct Message {
            bool binary = false;
            std::vector<uint8_t> data;
        };

        // Throws NetError. A refusal before the upgrade (the server answers
        // plain HTTP) carries the status and the server's own words.
        static std::unique_ptr<WebSocket> connect(const Url& base, const std::string& pathAndQuery, bool verify,
                                                  int timeoutMs = 8000);

        // Wait up to timeoutMs for one whole message. Returns false on timeout.
        // Pings are answered here. Throws NetError when the connection ends; a
        // close frame's reason, if the server gave one, is the error text.
        bool recv(Message& msg, int timeoutMs);

        void sendText(const std::string& text);
        void close();
        void abort() { conn->abort(); }

    private:
        WebSocket() = default;
        void sendFrame(uint8_t opcode, const uint8_t* data, size_t len);
        bool tryParse(Message& msg);

        std::unique_ptr<Conn> conn;
        std::vector<uint8_t> buf;   // bytes read but not yet parsed
        size_t bufStart = 0;
        std::vector<uint8_t> partial; // payload of a fragmented message
        bool partialBinary = false;
        bool closed = false;
    };
}
