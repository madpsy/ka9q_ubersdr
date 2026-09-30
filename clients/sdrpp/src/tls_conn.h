#pragma once
// A TCP connection, optionally wrapped in TLS.
//
// Everything the module says to a receiver or to the instance directory goes
// through this: plain HTTP on a LAN, HTTPS for the public ones and for tunnels.
// mbedTLS does the TLS on every platform; whether the server's certificate is
// trusted is decided by the operating system's own trust store where it has an
// API for that (see trust.cpp).
//
// A Conn is used from one thread. abort() is the exception: any thread may call
// it to break a blocked read or connect, after which the owner sees an error and
// tears the connection down itself.
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

namespace ubersdr {
    struct NetError : std::runtime_error {
        using std::runtime_error::runtime_error;
    };

    class Conn {
    public:
        // Connect to host:port, and if tls, complete the handshake and check the
        // certificate against host (unless verify is false). Throws NetError.
        static std::unique_ptr<Conn> open(const std::string& host, int port, bool tls, bool verify,
                                          int timeoutMs = 8000);
        ~Conn();

        // Read up to len bytes. Returns the count, or 0 when nothing arrived
        // within timeoutMs. Throws NetError when the peer closed or on error.
        size_t read(uint8_t* buf, size_t len, int timeoutMs);

        // Read exactly len bytes, waiting at most timeoutMs for each piece.
        void readExact(uint8_t* buf, size_t len, int timeoutMs);

        void writeAll(const uint8_t* data, size_t len);
        void writeAll(const std::string& s) { writeAll((const uint8_t*)s.data(), s.size()); }

        // Unblock whatever the owning thread is waiting on. Safe from any thread.
        void abort();

        bool isTLS() const { return tls; }

    private:
        Conn() = default;
        struct Impl;
        std::unique_ptr<Impl> impl;
        bool tls = false;
    };

    // Platform trust decision for a certificate chain the server presented,
    // leaf first, each DER encoded. Returns an empty string when the chain is
    // trusted for host, or the reason it is not. Implemented in trust.cpp.
    struct DerCert {
        const uint8_t* data;
        size_t len;
    };
    std::string verifyWithSystemTrust(const std::string& host, const DerCert* chain, size_t count);

    // True when verifyWithSystemTrust is the OS's verdict (Windows, macOS);
    // false when mbedTLS checks against CA files loaded by loadSystemCAs.
    bool systemTrustIsNative();

    // Where to find CA certificates on platforms without a trust API. Returns
    // the number of certificates loaded into the mbedtls_x509_crt at chain.
    int loadSystemCAs(void* chain);
}
