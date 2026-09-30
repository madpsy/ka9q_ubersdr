#pragma once
#include <map>
#include <string>

namespace ubersdr {
    extern const char* kUserAgent;

    // A receiver's address, as typed or as found by discovery.
    struct Url {
        bool tls = false;
        std::string host;     // no brackets, even for IPv6
        int port = 0;
        std::string basePath; // "" or "/something", never a trailing slash

        // "host" or "host:port" for the Host header, default port omitted.
        std::string hostHeader() const;
        // "https://host[:port][/base]"
        std::string str() const;
        bool valid() const { return !host.empty() && port > 0 && port < 65536; }
    };

    // Accepts http://, https://, ws:// and wss:// URLs, or a bare host with an
    // optional port. A bare name with no port is taken to be a public receiver
    // (https on 443) unless it looks local — an IP address, a .local name or a
    // single label — which gets UberSDR's own default of http on 8080. Returns
    // an invalid Url when nothing usable is there.
    Url parseUrl(const std::string& text);

    std::string urlEncode(const std::string& s);
    std::string jsonEscape(const std::string& s);

    struct HttpResponse {
        int status = 0;
        std::map<std::string, std::string> headers; // lower-case names
        std::string body;
    };

    // One request on a fresh connection. Follows a single redirect. Throws
    // NetError on transport failure; an HTTP error status is returned, not thrown.
    HttpResponse httpRequest(const Url& base, const std::string& method, const std::string& path,
                             const std::string& body = "", const std::string& contentType = "",
                             bool verify = true, int timeoutMs = 8000);
}
