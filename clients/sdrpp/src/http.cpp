#include "http.h"
#include "tls_conn.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>

namespace ubersdr {
    const char* kUserAgent = "UberSDR-SDRpp/1.0";

    namespace {
        std::string lower(std::string s) {
            std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            return s;
        }

        std::string trim(const std::string& s) {
            size_t a = s.find_first_not_of(" \t\r\n");
            if (a == std::string::npos) { return ""; }
            size_t b = s.find_last_not_of(" \t\r\n");
            return s.substr(a, b - a + 1);
        }

        bool looksLocal(const std::string& host) {
            if (host.find('.') == std::string::npos) { return true; }  // single label, or IPv6
            if (host.size() > 6 && lower(host.substr(host.size() - 6)) == ".local") { return true; }
            return std::all_of(host.begin(), host.end(), [](char c) { return std::isdigit((unsigned char)c) || c == '.'; });
        }
    }

    std::string Url::hostHeader() const {
        std::string h = host.find(':') != std::string::npos ? "[" + host + "]" : host;
        if ((tls && port == 443) || (!tls && port == 80)) { return h; }
        return h + ":" + std::to_string(port);
    }

    std::string Url::str() const {
        return std::string(tls ? "https://" : "http://") + hostHeader() + basePath;
    }

    Url parseUrl(const std::string& text) {
        Url u;
        std::string s = trim(text);
        bool haveScheme = false;
        size_t sep = s.find("://");
        if (sep != std::string::npos) {
            std::string scheme = lower(s.substr(0, sep));
            if (scheme == "https" || scheme == "wss") { u.tls = true; }
            else if (scheme != "http" && scheme != "ws") { return Url(); }
            haveScheme = true;
            s = s.substr(sep + 3);
        }

        size_t slash = s.find('/');
        std::string authority = s.substr(0, slash);
        std::string path = slash == std::string::npos ? "" : s.substr(slash);
        size_t q = path.find_first_of("?#");
        if (q != std::string::npos) { path = path.substr(0, q); }
        while (!path.empty() && path.back() == '/') { path.pop_back(); }
        // A pasted WebSocket URL points at the endpoint, not the receiver.
        if (path.size() >= 3 && path.compare(path.size() - 3, 3, "/ws") == 0) { path.resize(path.size() - 3); }
        u.basePath = path;

        // Drop any user:password@ — the receiver password has its own field.
        size_t at = authority.rfind('@');
        if (at != std::string::npos) { authority = authority.substr(at + 1); }

        std::string portStr;
        if (!authority.empty() && authority[0] == '[') {
            size_t close = authority.find(']');
            if (close == std::string::npos) { return Url(); }
            u.host = authority.substr(1, close - 1);
            if (close + 1 < authority.size() && authority[close + 1] == ':') { portStr = authority.substr(close + 2); }
        }
        else {
            size_t colon = authority.rfind(':');
            if (colon != std::string::npos && authority.find(':') == colon) {
                u.host = authority.substr(0, colon);
                portStr = authority.substr(colon + 1);
            }
            else {
                u.host = authority;
            }
        }
        if (u.host.empty()) { return Url(); }

        if (!portStr.empty()) {
            if (!std::all_of(portStr.begin(), portStr.end(), [](char c) { return std::isdigit((unsigned char)c); })) { return Url(); }
            u.port = std::atoi(portStr.c_str());
        }
        else if (haveScheme) {
            u.port = u.tls ? 443 : 80;
        }
        else if (looksLocal(u.host)) {
            u.port = 8080;
        }
        else {
            u.tls = true;
            u.port = 443;
        }
        return u.valid() ? u : Url();
    }

    std::string urlEncode(const std::string& s) {
        static const char* hex = "0123456789ABCDEF";
        std::string out;
        for (unsigned char c : s) {
            if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
                out += (char)c;
            }
            else {
                out += '%';
                out += hex[c >> 4];
                out += hex[c & 15];
            }
        }
        return out;
    }

    std::string jsonEscape(const std::string& s) {
        std::string out;
        for (unsigned char c : s) {
            switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                }
                else {
                    out += (char)c;
                }
            }
        }
        return out;
    }

    namespace {
        HttpResponse requestOnce(const Url& base, const std::string& method, const std::string& path,
                                 const std::string& body, const std::string& contentType, bool verify, int timeoutMs) {
            auto conn = Conn::open(base.host, base.port, base.tls, verify, timeoutMs);

            std::string req = method + " " + base.basePath + path + " HTTP/1.1\r\n";
            req += "Host: " + base.hostHeader() + "\r\n";
            req += std::string("User-Agent: ") + kUserAgent + "\r\n";
            req += "Accept: application/json\r\n";
            req += "Connection: close\r\n";
            if (!contentType.empty()) { req += "Content-Type: " + contentType + "\r\n"; }
            if (!body.empty() || method == "POST") { req += "Content-Length: " + std::to_string(body.size()) + "\r\n"; }
            req += "\r\n";
            req += body;
            conn->writeAll(req);

            // Read everything until the server closes, bounded in time and size.
            // Connection: close makes that the end of the response for every
            // framing, and the framing is only needed to strip chunk headers.
            std::string raw;
            uint8_t buf[16384];
            auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
            size_t headerEnd = std::string::npos;
            size_t contentLength = std::string::npos;
            for (;;) {
                if (std::chrono::steady_clock::now() > deadline) { throw NetError("timed out reading response"); }
                size_t n;
                try {
                    n = conn->read(buf, sizeof(buf), 500);
                }
                catch (const NetError&) {
                    break; // closed: that is the end of the body
                }
                raw.append((const char*)buf, n);
                if (raw.size() > (32u << 20)) { throw NetError("response too large"); }
                if (headerEnd == std::string::npos) {
                    headerEnd = raw.find("\r\n\r\n");
                    if (headerEnd != std::string::npos) {
                        std::string h = lower(raw.substr(0, headerEnd));
                        size_t cl = h.find("\r\ncontent-length:");
                        if (cl != std::string::npos) { contentLength = (size_t)std::strtoull(h.c_str() + cl + 17, NULL, 10); }
                    }
                }
                // Some servers hold the socket open despite Connection: close.
                if (headerEnd != std::string::npos && contentLength != std::string::npos &&
                    raw.size() >= headerEnd + 4 + contentLength) {
                    break;
                }
            }
            if (headerEnd == std::string::npos) { throw NetError("malformed HTTP response"); }

            HttpResponse resp;
            std::string head = raw.substr(0, headerEnd);
            size_t lineEnd = head.find("\r\n");
            std::string status = head.substr(0, lineEnd);
            size_t sp = status.find(' ');
            if (sp == std::string::npos) { throw NetError("malformed HTTP status line"); }
            resp.status = std::atoi(status.c_str() + sp + 1);
            size_t pos = lineEnd == std::string::npos ? head.size() : lineEnd + 2;
            while (pos < head.size()) {
                size_t e = head.find("\r\n", pos);
                if (e == std::string::npos) { e = head.size(); }
                std::string line = head.substr(pos, e - pos);
                size_t colon = line.find(':');
                if (colon != std::string::npos) { resp.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1)); }
                pos = e + 2;
            }

            std::string payload = raw.substr(headerEnd + 4);
            if (lower(resp.headers["transfer-encoding"]).find("chunked") != std::string::npos) {
                std::string out;
                size_t p = 0;
                while (p < payload.size()) {
                    size_t e = payload.find("\r\n", p);
                    if (e == std::string::npos) { break; }
                    size_t len = (size_t)std::strtoull(payload.c_str() + p, NULL, 16);
                    if (len == 0) { break; }
                    p = e + 2;
                    if (p + len > payload.size()) { len = payload.size() - p; }
                    out.append(payload, p, len);
                    p += len + 2;
                }
                payload.swap(out);
            }
            else if (contentLength != std::string::npos && payload.size() > contentLength) {
                payload.resize(contentLength);
            }
            resp.body.swap(payload);
            return resp;
        }
    }

    HttpResponse httpRequest(const Url& base, const std::string& method, const std::string& path,
                             const std::string& body, const std::string& contentType, bool verify, int timeoutMs) {
        HttpResponse r = requestOnce(base, method, path, body, contentType, verify, timeoutMs);
        if ((r.status == 301 || r.status == 302 || r.status == 307 || r.status == 308) && r.headers.count("location")) {
            // Only the scheme, host and port are taken from the redirect: the
            // request path is ours, and a receiver that moved to https keeps it.
            Url to = parseUrl(r.headers["location"]);
            if (to.valid()) {
                to.basePath = base.basePath;
                r = requestOnce(to, method, path, body, contentType, verify, timeoutMs);
            }
        }
        return r;
    }
}
