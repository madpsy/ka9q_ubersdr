#include "tls_conn.h"

#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <psa/crypto.h>

#include <chrono>
#include <cstring>
#include <mutex>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
static const sock_t kBadSock = INVALID_SOCKET;
static int sockErr() { return WSAGetLastError(); }
static void closeSock(sock_t s) { closesocket(s); }
static bool connectPending(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int sock_t;
static const sock_t kBadSock = -1;
static int sockErr() { return errno; }
static void closeSock(sock_t s) { ::close(s); }
static bool connectPending(int e) { return e == EINPROGRESS; }
#endif

namespace ubersdr {
    namespace {
        std::string mbedErr(int ret) {
            char buf[160];
            mbedtls_strerror(ret, buf, sizeof(buf));
            return buf;
        }

        void setBlocking(sock_t s, bool blocking) {
#ifdef _WIN32
            u_long nb = blocking ? 0 : 1;
            ioctlsocket(s, FIONBIO, &nb);
#else
            int fl = fcntl(s, F_GETFL, 0);
            fcntl(s, F_SETFL, blocking ? (fl & ~O_NONBLOCK) : (fl | O_NONBLOCK));
#endif
        }

        // One-time process state: Winsock, PSA (mbedTLS 3.6 needs it for TLS 1.3),
        // the RNG, and on platforms without a trust API the CA list.
        struct Global {
            mbedtls_entropy_context entropy;
            mbedtls_ctr_drbg_context drbg;
            mbedtls_x509_crt cas;
            int casLoaded = 0;
            std::mutex rngMtx;

            Global() {
#ifdef _WIN32
                WSADATA wsa;
                WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
                psa_crypto_init();
                mbedtls_entropy_init(&entropy);
                mbedtls_ctr_drbg_init(&drbg);
                const char* pers = "ubersdr_sdrpp";
                mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy, (const unsigned char*)pers, strlen(pers));
                mbedtls_x509_crt_init(&cas);
                if (!systemTrustIsNative()) {
                    casLoaded = loadSystemCAs(&cas);
                }
            }
        };

        Global& global() {
            static Global g;
            return g;
        }

        // ctr_drbg is not thread-safe without MBEDTLS_THREADING_C, and discovery,
        // the session and a probe can all be handshaking at once.
        int lockedRandom(void* p, unsigned char* out, size_t len) {
            Global* g = (Global*)p;
            std::lock_guard<std::mutex> lck(g->rngMtx);
            return mbedtls_ctr_drbg_random(&g->drbg, out, len);
        }

        // mbedtls_net_send writes with write(), which raises SIGPIPE when the peer
        // has gone, and SIGPIPE's default action ends the process: SDR++ itself,
        // not just this stream. So sends go through here instead.
        int sendNoSignal(void* ctx, const unsigned char* buf, size_t len) {
            sock_t s = (sock_t)((mbedtls_net_context*)ctx)->fd;
#if defined(_WIN32)
            int n = ::send(s, (const char*)buf, (int)len, 0);
            if (n < 0) { return WSAGetLastError() == WSAEWOULDBLOCK ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED; }
#elif defined(__APPLE__)
            ssize_t n = ::send(s, buf, len, 0); // SO_NOSIGPIPE is set on the socket
            if (n < 0) { return (errno == EAGAIN || errno == EINTR) ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED; }
#else
            ssize_t n = ::send(s, buf, len, MSG_NOSIGNAL);
            if (n < 0) { return (errno == EAGAIN || errno == EINTR) ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED; }
#endif
            return (int)n;
        }

        sock_t connectTCP(const std::string& host, int port, int timeoutMs, std::atomic<sock_t>& live) {
            struct addrinfo hints = {};
            hints.ai_family = AF_UNSPEC;
            hints.ai_socktype = SOCK_STREAM;
            hints.ai_protocol = IPPROTO_TCP;
            struct addrinfo* res = NULL;
            std::string portStr = std::to_string(port);
            int gai = getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res);
            if (gai != 0 || !res) {
                throw NetError("cannot resolve " + host);
            }

            auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
            std::string lastErr = "connection failed";
            sock_t s = kBadSock;
            for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
                s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
                if (s == kBadSock) { continue; }
                live = s;
                setBlocking(s, false);
                int rc = ::connect(s, ai->ai_addr, (int)ai->ai_addrlen);
                if (rc != 0 && !connectPending(sockErr())) {
                    lastErr = "connection refused";
                    live = kBadSock;
                    closeSock(s);
                    s = kBadSock;
                    continue;
                }
                if (rc != 0) {
                    int left = (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
                    if (left < 1) { left = 1; }
                    fd_set wr, ex;
                    FD_ZERO(&wr);
                    FD_ZERO(&ex);
                    FD_SET(s, &wr);
                    FD_SET(s, &ex);
                    struct timeval tv;
                    tv.tv_sec = left / 1000;
                    tv.tv_usec = (left % 1000) * 1000;
                    int n = select((int)s + 1, NULL, &wr, &ex, &tv);
                    int soErr = 0;
                    socklen_t len = sizeof(soErr);
                    if (n > 0) {
                        getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&soErr, &len);
                    }
                    if (n <= 0 || soErr != 0 || live.load() == kBadSock) {
                        lastErr = (n == 0) ? "connection timed out" : "connection refused";
                        live = kBadSock;
                        closeSock(s);
                        s = kBadSock;
                        continue;
                    }
                }
                setBlocking(s, true);
                break;
            }
            freeaddrinfo(res);
            if (s == kBadSock) {
                throw NetError(lastErr + " (" + host + ":" + std::to_string(port) + ")");
            }
            int one = 1;
            setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof(one));
#ifdef __APPLE__
            setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
            return s;
        }
    }

    struct Conn::Impl {
        std::atomic<sock_t> sock{ kBadSock };
        mbedtls_net_context net;
        mbedtls_ssl_context ssl;
        mbedtls_ssl_config conf;
        bool sslInit = false;

        Impl() {
            mbedtls_net_init(&net);
            mbedtls_ssl_init(&ssl);
            mbedtls_ssl_config_init(&conf);
        }
        ~Impl() {
            if (sslInit) { mbedtls_ssl_close_notify(&ssl); }
            mbedtls_ssl_free(&ssl);
            mbedtls_ssl_config_free(&conf);
            sock_t s = sock.exchange(kBadSock);
            if (s != kBadSock) { closeSock(s); }
        }
    };

    std::unique_ptr<Conn> Conn::open(const std::string& host, int port, bool tls, bool verify, int timeoutMs) {
        Global& g = global();
        std::unique_ptr<Conn> c(new Conn());
        c->impl.reset(new Impl());
        c->tls = tls;
        Impl& im = *c->impl;

        sock_t s = connectTCP(host, port, timeoutMs, im.sock);
        im.sock = s;
        im.net.fd = (int)s;
        if (!tls) { return c; }

        int ret = mbedtls_ssl_config_defaults(&im.conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM,
                                              MBEDTLS_SSL_PRESET_DEFAULT);
        if (ret != 0) { throw NetError("TLS setup: " + mbedErr(ret)); }
        mbedtls_ssl_conf_rng(&im.conf, lockedRandom, &g);
        // OPTIONAL rather than REQUIRED: the handshake completes whatever the
        // certificate, and the verdict is taken below, before a byte of the
        // request is sent. That is what lets Windows and macOS judge the chain
        // with their own trust stores, which mbedTLS cannot read.
        mbedtls_ssl_conf_authmode(&im.conf, verify ? MBEDTLS_SSL_VERIFY_OPTIONAL : MBEDTLS_SSL_VERIFY_NONE);
        if (verify && !systemTrustIsNative()) {
            mbedtls_ssl_conf_ca_chain(&im.conf, &g.cas, NULL);
        }
        mbedtls_ssl_conf_read_timeout(&im.conf, 0);
        ret = mbedtls_ssl_setup(&im.ssl, &im.conf);
        if (ret != 0) { throw NetError("TLS setup: " + mbedErr(ret)); }
        im.sslInit = true;
        // SNI and the name mbedTLS checks the certificate against.
        mbedtls_ssl_set_hostname(&im.ssl, host.c_str());
        mbedtls_ssl_set_bio(&im.ssl, &im.net, sendNoSignal, NULL, mbedtls_net_recv_timeout);

        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        mbedtls_ssl_conf_read_timeout(&im.conf, 250);
        while ((ret = mbedtls_ssl_handshake(&im.ssl)) != 0) {
            if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE || ret == MBEDTLS_ERR_SSL_TIMEOUT) {
                if (std::chrono::steady_clock::now() > deadline || im.sock.load() == kBadSock) {
                    throw NetError("TLS handshake timed out (" + host + ")");
                }
                continue;
            }
            throw NetError("TLS handshake with " + host + " failed: " + mbedErr(ret));
        }

        if (verify) {
            std::string why;
            if (systemTrustIsNative()) {
                std::vector<DerCert> chain;
                for (const mbedtls_x509_crt* crt = mbedtls_ssl_get_peer_cert(&im.ssl); crt && crt->raw.p; crt = crt->next) {
                    chain.push_back({ crt->raw.p, crt->raw.len });
                }
                why = chain.empty() ? std::string("server sent no certificate")
                                    : verifyWithSystemTrust(host, chain.data(), chain.size());
            }
            else {
                uint32_t flags = mbedtls_ssl_get_verify_result(&im.ssl);
                if (g.casLoaded == 0) {
                    why = "no CA certificates found on this system";
                }
                else if (flags != 0) {
                    char buf[512];
                    mbedtls_x509_crt_verify_info(buf, sizeof(buf), "", flags);
                    why = buf;
                    while (!why.empty() && (why.back() == '\n' || why.back() == ' ')) { why.pop_back(); }
                    for (auto& ch : why) { if (ch == '\n') { ch = ';'; } }
                }
            }
            if (!why.empty()) {
                throw NetError("certificate for " + host + " not trusted: " + why);
            }
        }
        return c;
    }

    Conn::~Conn() = default;

    size_t Conn::read(uint8_t* buf, size_t len, int timeoutMs) {
        Impl& im = *impl;
        if (im.sock.load() == kBadSock) { throw NetError("connection closed"); }
        if (!tls) {
            int ret = mbedtls_net_recv_timeout(&im.net, buf, len, (uint32_t)(timeoutMs < 1 ? 1 : timeoutMs));
            if (ret == MBEDTLS_ERR_SSL_TIMEOUT || ret == MBEDTLS_ERR_SSL_WANT_READ) { return 0; }
            if (ret == 0) { throw NetError("connection closed by server"); }
            if (ret < 0) { throw NetError(im.sock.load() == kBadSock ? "connection closed" : "receive failed: " + mbedErr(ret)); }
            return (size_t)ret;
        }
        mbedtls_ssl_conf_read_timeout(&im.conf, (uint32_t)(timeoutMs < 1 ? 1 : timeoutMs));
        for (;;) {
            int ret = mbedtls_ssl_read(&im.ssl, buf, len);
            if (ret > 0) { return (size_t)ret; }
            if (ret == MBEDTLS_ERR_SSL_TIMEOUT || ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
                return 0;
            }
            // TLS 1.3 servers send tickets after the handshake; they are not data.
            if (ret == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) { continue; }
            if (ret == 0 || ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) { throw NetError("connection closed by server"); }
            throw NetError(im.sock.load() == kBadSock ? "connection closed" : "receive failed: " + mbedErr(ret));
        }
    }

    void Conn::readExact(uint8_t* buf, size_t len, int timeoutMs) {
        size_t got = 0;
        while (got < len) {
            size_t n = read(buf + got, len - got, timeoutMs);
            if (n == 0) { throw NetError("timed out waiting for server"); }
            got += n;
        }
    }

    void Conn::writeAll(const uint8_t* data, size_t len) {
        Impl& im = *impl;
        size_t off = 0;
        while (off < len) {
            if (im.sock.load() == kBadSock) { throw NetError("connection closed"); }
            int ret = tls ? mbedtls_ssl_write(&im.ssl, data + off, len - off)
                          : sendNoSignal(&im.net, data + off, len - off);
            if (ret == MBEDTLS_ERR_SSL_WANT_WRITE || ret == MBEDTLS_ERR_SSL_WANT_READ) { continue; }
            if (ret <= 0) { throw NetError("send failed: " + mbedErr(ret)); }
            off += (size_t)ret;
        }
    }

    void Conn::abort() {
        // Shut the socket down rather than closing it: the owner may be inside
        // select() or recv() on it right now, and a closed descriptor number can
        // be reused under it. The owner closes it when it destroys the Conn.
        sock_t s = impl->sock.load();
        if (s != kBadSock) {
#ifdef _WIN32
            ::shutdown(s, SD_BOTH);
#else
            ::shutdown(s, SHUT_RDWR);
#endif
        }
    }
}
