#include "websocket.h"

#include <mbedtls/base64.h>

#include <chrono>
#include <cstring>
#include <random>

namespace ubersdr {
    namespace {
        enum : uint8_t {
            OP_CONT = 0x0,
            OP_TEXT = 0x1,
            OP_BINARY = 0x2,
            OP_CLOSE = 0x8,
            OP_PING = 0x9,
            OP_PONG = 0xA,
        };

        // The largest message accepted. A 384 kHz IQ packet is well under 64 KiB;
        // this only stops a corrupt length from allocating gigabytes.
        const uint64_t kMaxMessage = 16u << 20;

        std::mt19937& rng() {
            thread_local std::mt19937 r{ std::random_device{}() };
            return r;
        }
    }

    std::unique_ptr<WebSocket> WebSocket::connect(const Url& base, const std::string& pathAndQuery, bool verify, int timeoutMs) {
        std::unique_ptr<WebSocket> ws(new WebSocket());
        ws->conn = Conn::open(base.host, base.port, base.tls, verify, timeoutMs);

        uint8_t nonce[16];
        for (auto& b : nonce) { b = (uint8_t)rng()(); }
        unsigned char key[32];
        size_t keyLen = 0;
        mbedtls_base64_encode(key, sizeof(key), &keyLen, nonce, sizeof(nonce));

        std::string req = "GET " + base.basePath + pathAndQuery + " HTTP/1.1\r\n";
        req += "Host: " + base.hostHeader() + "\r\n";
        req += "Upgrade: websocket\r\n";
        req += "Connection: Upgrade\r\n";
        req += "Sec-WebSocket-Key: " + std::string((const char*)key, keyLen) + "\r\n";
        req += "Sec-WebSocket-Version: 13\r\n";
        req += std::string("User-Agent: ") + kUserAgent + "\r\n";
        req += "\r\n";
        ws->conn->writeAll(req);

        std::string head;
        uint8_t tmp[4096];
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        size_t end;
        while ((end = head.find("\r\n\r\n")) == std::string::npos) {
            if (std::chrono::steady_clock::now() > deadline) { throw NetError("timed out waiting for the WebSocket upgrade"); }
            if (head.size() > 65536) { throw NetError("oversized HTTP response to the WebSocket upgrade"); }
            size_t n = ws->conn->read(tmp, sizeof(tmp), 250);
            head.append((const char*)tmp, n);
        }
        std::string rest = head.substr(end + 4);
        head.resize(end);

        int status = 0;
        size_t sp = head.find(' ');
        if (sp != std::string::npos) { status = std::atoi(head.c_str() + sp + 1); }
        if (status != 101) {
            // The body says why (unsupported version, rate limit, banned...).
            // It may still be arriving; take what comes in a moment.
            std::string body = rest;
            try {
                for (int i = 0; i < 4 && body.size() < 512; i++) {
                    size_t n = ws->conn->read(tmp, sizeof(tmp), 250);
                    if (n == 0) { break; }
                    body.append((const char*)tmp, n);
                }
            }
            catch (const NetError&) {}
            while (!body.empty() && (body.back() == '\n' || body.back() == '\r' || body.back() == ' ')) { body.pop_back(); }
            if (body.size() > 200) { body.resize(200); }
            throw NetError("server refused the stream (HTTP " + std::to_string(status) + ")" + (body.empty() ? "" : ": " + body));
        }
        ws->buf.assign(rest.begin(), rest.end());
        return ws;
    }

    bool WebSocket::tryParse(Message& msg) {
        for (;;) {
            size_t avail = buf.size() - bufStart;
            const uint8_t* p = buf.data() + bufStart;
            if (avail < 2) { return false; }
            bool fin = (p[0] & 0x80) != 0;
            uint8_t op = p[0] & 0x0F;
            bool masked = (p[1] & 0x80) != 0;
            uint64_t len = p[1] & 0x7F;
            size_t hdr = 2;
            if (len == 126) {
                if (avail < 4) { return false; }
                len = ((uint64_t)p[2] << 8) | p[3];
                hdr = 4;
            }
            else if (len == 127) {
                if (avail < 10) { return false; }
                len = 0;
                for (int i = 0; i < 8; i++) { len = (len << 8) | p[2 + i]; }
                hdr = 10;
            }
            if (len > kMaxMessage) { throw NetError("oversized WebSocket frame"); }
            uint8_t mask[4] = { 0, 0, 0, 0 };
            if (masked) {
                if (avail < hdr + 4) { return false; }
                memcpy(mask, p + hdr, 4);
                hdr += 4;
            }
            if (avail < hdr + len) { return false; }

            const uint8_t* payload = p + hdr;
            std::vector<uint8_t> data(payload, payload + len);
            if (masked) {
                for (size_t i = 0; i < data.size(); i++) { data[i] ^= mask[i & 3]; }
            }
            bufStart += hdr + (size_t)len;

            switch (op) {
            case OP_PING:
                sendFrame(OP_PONG, data.data(), data.size());
                continue;
            case OP_PONG:
                continue;
            case OP_CLOSE: {
                std::string reason;
                if (data.size() > 2) { reason.assign(data.begin() + 2, data.end()); }
                if (!closed) {
                    try { sendFrame(OP_CLOSE, data.data(), data.size() >= 2 ? 2 : 0); } catch (...) {}
                    closed = true;
                }
                throw NetError(reason.empty() ? "server closed the stream" : reason);
            }
            case OP_TEXT:
            case OP_BINARY:
                if (fin) {
                    msg.binary = (op == OP_BINARY);
                    msg.data.swap(data);
                    return true;
                }
                partialBinary = (op == OP_BINARY);
                partial.swap(data);
                continue;
            case OP_CONT:
                partial.insert(partial.end(), data.begin(), data.end());
                if (partial.size() > kMaxMessage) { throw NetError("oversized WebSocket message"); }
                if (fin) {
                    msg.binary = partialBinary;
                    msg.data.swap(partial);
                    partial.clear();
                    return true;
                }
                continue;
            default:
                throw NetError("unknown WebSocket opcode");
            }
        }
    }

    bool WebSocket::recv(Message& msg, int timeoutMs) {
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        uint8_t tmp[65536];
        for (;;) {
            if (tryParse(msg)) { return true; }
            // Compact before the buffer grows: everything before bufStart is spent.
            if (bufStart > 0) {
                buf.erase(buf.begin(), buf.begin() + bufStart);
                bufStart = 0;
            }
            int left = (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
            if (left <= 0) { return false; }
            size_t n = conn->read(tmp, sizeof(tmp), left);
            if (n == 0) { return false; }
            buf.insert(buf.end(), tmp, tmp + n);
        }
    }

    void WebSocket::sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
        std::vector<uint8_t> f;
        f.reserve(len + 14);
        f.push_back(0x80 | opcode);
        if (len < 126) {
            f.push_back(0x80 | (uint8_t)len);
        }
        else if (len < 65536) {
            f.push_back(0x80 | 126);
            f.push_back((uint8_t)(len >> 8));
            f.push_back((uint8_t)len);
        }
        else {
            f.push_back(0x80 | 127);
            for (int i = 7; i >= 0; i--) { f.push_back((uint8_t)((uint64_t)len >> (8 * i))); }
        }
        uint32_t m = rng()();
        uint8_t mask[4] = { (uint8_t)m, (uint8_t)(m >> 8), (uint8_t)(m >> 16), (uint8_t)(m >> 24) };
        f.insert(f.end(), mask, mask + 4);
        for (size_t i = 0; i < len; i++) { f.push_back(data[i] ^ mask[i & 3]); }
        conn->writeAll(f.data(), f.size());
    }

    void WebSocket::sendText(const std::string& text) {
        sendFrame(OP_TEXT, (const uint8_t*)text.data(), text.size());
    }

    void WebSocket::close() {
        if (closed) { return; }
        closed = true;
        uint8_t code[2] = { 0x03, 0xE8 }; // 1000, normal closure
        try { sendFrame(OP_CLOSE, code, 2); } catch (...) {}
    }
}
