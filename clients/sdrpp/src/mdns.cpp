#include "mdns.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <map>
#include <set>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
typedef SOCKET sock_t;
static const sock_t kBadSock = INVALID_SOCKET;
static void closeSock(sock_t s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int sock_t;
static const sock_t kBadSock = -1;
static void closeSock(sock_t s) { ::close(s); }
#endif

namespace ubersdr {
    namespace {
        enum : uint16_t { T_A = 1, T_PTR = 12, T_TXT = 16, T_SRV = 33 };

        std::string lower(std::string s) {
            std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            return s;
        }

        // Split a name into labels on dots. Service and host names never
        // contain a literal dot inside a label, and the instance label is only
        // ever read from the wire, never written, so escapes are not needed.
        void putName(std::vector<uint8_t>& out, const std::string& name) {
            size_t start = 0;
            while (start < name.size()) {
                size_t dot = name.find('.', start);
                if (dot == std::string::npos) { dot = name.size(); }
                size_t len = std::min<size_t>(dot - start, 63);
                out.push_back((uint8_t)len);
                out.insert(out.end(), name.begin() + start, name.begin() + start + len);
                start = dot + 1;
            }
            out.push_back(0);
        }

        std::vector<uint8_t> buildQuery(const std::vector<std::pair<std::string, uint16_t>>& qs, bool unicastReply) {
            std::vector<uint8_t> m(12, 0);
            m[5] = (uint8_t)qs.size(); // QDCOUNT
            for (const auto& q : qs) {
                putName(m, q.first);
                m.push_back((uint8_t)(q.second >> 8));
                m.push_back((uint8_t)q.second);
                m.push_back(unicastReply ? 0x80 : 0x00); // QU bit
                m.push_back(0x01); // class IN
            }
            return m;
        }

        // Read a possibly-compressed name at off, which is advanced past it.
        // Labels are returned joined with dots; the instance label is also
        // returned on its own, since it may itself contain spaces or dots.
        bool readName(const uint8_t* msg, size_t len, size_t& off, std::string& name, std::string* first = NULL) {
            name.clear();
            size_t p = off;
            bool jumped = false;
            int hops = 0;
            bool firstLabel = true;
            for (;;) {
                if (p >= len) { return false; }
                uint8_t l = msg[p];
                if (l == 0) {
                    if (!jumped) { off = p + 1; }
                    return true;
                }
                if ((l & 0xC0) == 0xC0) {
                    if (p + 1 >= len || ++hops > 16) { return false; }
                    size_t ptr = ((size_t)(l & 0x3F) << 8) | msg[p + 1];
                    if (!jumped) { off = p + 2; }
                    jumped = true;
                    p = ptr;
                    continue;
                }
                if (p + 1 + l > len) { return false; }
                std::string label((const char*)msg + p + 1, l);
                if (firstLabel && first) { *first = label; }
                firstLabel = false;
                if (!name.empty()) { name += '.'; }
                name += label;
                p += 1 + l;
            }
        }

        struct Records {
            std::map<std::string, std::set<std::string>> ptr;                // service -> instance names
            std::map<std::string, std::string> instanceLabel;                // instance name -> first label
            std::map<std::string, std::pair<std::string, int>> srv;         // instance -> target, port
            std::map<std::string, std::vector<std::string>> txt;            // instance -> strings
            std::map<std::string, std::string> a;                           // host -> IPv4
        };

        void parse(const uint8_t* msg, size_t len, Records& rec) {
            if (len < 12) { return; }
            if (!(msg[2] & 0x80)) { return; } // a query, not a response
            int qd = (msg[4] << 8) | msg[5];
            int rr = ((msg[6] << 8) | msg[7]) + ((msg[8] << 8) | msg[9]) + ((msg[10] << 8) | msg[11]);
            size_t off = 12;
            std::string name;
            for (int i = 0; i < qd; i++) {
                if (!readName(msg, len, off, name) || off + 4 > len) { return; }
                off += 4;
            }
            for (int i = 0; i < rr; i++) {
                std::string first;
                if (!readName(msg, len, off, name, &first) || off + 10 > len) { return; }
                uint16_t type = (uint16_t)((msg[off] << 8) | msg[off + 1]);
                uint16_t rdlen = (uint16_t)((msg[off + 8] << 8) | msg[off + 9]);
                off += 10;
                if (off + rdlen > len) { return; }
                size_t rd = off;
                std::string key = lower(name);
                if (type == T_PTR) {
                    std::string target, label;
                    size_t p = rd;
                    if (readName(msg, len, p, target, &label)) {
                        rec.ptr[key].insert(lower(target));
                        rec.instanceLabel[lower(target)] = label;
                    }
                }
                else if (type == T_SRV && rdlen >= 7) {
                    int port = (msg[rd + 4] << 8) | msg[rd + 5];
                    std::string target;
                    size_t p = rd + 6;
                    if (readName(msg, len, p, target)) {
                        rec.srv[key] = { lower(target), port };
                        if (!rec.instanceLabel.count(key)) { rec.instanceLabel[key] = first; }
                    }
                }
                else if (type == T_TXT) {
                    std::vector<std::string> strs;
                    size_t p = rd;
                    while (p < rd + rdlen) {
                        uint8_t l = msg[p];
                        if (p + 1 + l > rd + rdlen) { break; }
                        if (l) { strs.emplace_back((const char*)msg + p + 1, l); }
                        p += 1 + l;
                    }
                    rec.txt[key] = strs;
                }
                else if (type == T_A && rdlen == 4) {
                    char ip[INET_ADDRSTRLEN];
                    inet_ntop(AF_INET, msg + rd, ip, sizeof(ip));
                    rec.a[key] = ip;
                }
                off += rdlen;
            }
        }

        std::vector<in_addr> ipv4Interfaces() {
            std::vector<in_addr> out;
#ifdef _WIN32
            ULONG size = 16384;
            std::vector<uint8_t> buf(size);
            IP_ADAPTER_ADDRESSES* aa = (IP_ADAPTER_ADDRESSES*)buf.data();
            ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
            ULONG rc = GetAdaptersAddresses(AF_INET, flags, NULL, aa, &size);
            if (rc == ERROR_BUFFER_OVERFLOW) {
                buf.resize(size);
                aa = (IP_ADAPTER_ADDRESSES*)buf.data();
                rc = GetAdaptersAddresses(AF_INET, flags, NULL, aa, &size);
            }
            if (rc != NO_ERROR) { return out; }
            for (IP_ADAPTER_ADDRESSES* a = aa; a; a = a->Next) {
                if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) { continue; }
                if (a->Flags & IP_ADAPTER_NO_MULTICAST) { continue; }
                for (IP_ADAPTER_UNICAST_ADDRESS* u = a->FirstUnicastAddress; u; u = u->Next) {
                    if (u->Address.lpSockaddr->sa_family == AF_INET) {
                        out.push_back(((sockaddr_in*)u->Address.lpSockaddr)->sin_addr);
                    }
                }
            }
#else
            struct ifaddrs* ifs = NULL;
            if (getifaddrs(&ifs) != 0) { return out; }
            for (struct ifaddrs* i = ifs; i; i = i->ifa_next) {
                if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) { continue; }
                if (!(i->ifa_flags & IFF_UP) || (i->ifa_flags & IFF_LOOPBACK) || !(i->ifa_flags & IFF_MULTICAST)) { continue; }
                out.push_back(((sockaddr_in*)i->ifa_addr)->sin_addr);
            }
            freeifaddrs(ifs);
#endif
            return out;
        }
    }

    std::vector<MdnsService> mdnsBrowse(const std::string& serviceIn, int timeoutMs) {
        std::vector<MdnsService> result;
        std::string service = lower(serviceIn);
        std::vector<in_addr> ifaces = ipv4Interfaces();

        sockaddr_in group = {};
        group.sin_family = AF_INET;
        group.sin_port = htons(5353);
        inet_pton(AF_INET, "224.0.0.251", &group.sin_addr);
        int ttl = 255, one = 1;

        // Two ways to hear answers, because each fails somewhere.
        //
        // mc: a real mDNS socket on 5353, shared with the OS's own responder,
        // joined to the group. Responders answer it by multicast, which every
        // firewall lets in. It fails where 5353 cannot be shared.
        //
        // uc: an ephemeral port, making the query "legacy unicast" (RFC 6762
        // section 6.7) so the answer comes straight back. That needs no port
        // and no group membership, but a stateful firewall (Linux conntrack
        // included) drops a unicast reply to a multicast query, and some
        // responders never send one.
        sock_t mc = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (mc != kBadSock) {
            setsockopt(mc, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof(one));
#ifdef SO_REUSEPORT
            setsockopt(mc, SOL_SOCKET, SO_REUSEPORT, (const char*)&one, sizeof(one));
#endif
            sockaddr_in any = {};
            any.sin_family = AF_INET;
            any.sin_addr.s_addr = htonl(INADDR_ANY);
            any.sin_port = htons(5353);
            bool joined = false;
            if (bind(mc, (sockaddr*)&any, sizeof(any)) == 0) {
                std::vector<in_addr> joinOn = ifaces;
                if (joinOn.empty()) {
                    in_addr anyIf;
                    anyIf.s_addr = htonl(INADDR_ANY);
                    joinOn.push_back(anyIf);
                }
                for (const auto& ifa : joinOn) {
                    ip_mreq mr = {};
                    mr.imr_multiaddr = group.sin_addr;
                    mr.imr_interface = ifa;
                    if (setsockopt(mc, IPPROTO_IP, IP_ADD_MEMBERSHIP, (const char*)&mr, sizeof(mr)) == 0) { joined = true; }
                }
            }
            if (!joined) {
                closeSock(mc);
                mc = kBadSock;
            }
            else {
                setsockopt(mc, IPPROTO_IP, IP_MULTICAST_TTL, (const char*)&ttl, sizeof(ttl));
                // A receiver on this same machine answers over loopback.
                unsigned char loop = 1;
                setsockopt(mc, IPPROTO_IP, IP_MULTICAST_LOOP, (const char*)&loop, sizeof(loop));
            }
        }

        sock_t uc = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (uc != kBadSock) {
            sockaddr_in local = {};
            local.sin_family = AF_INET;
            local.sin_addr.s_addr = htonl(INADDR_ANY);
            if (bind(uc, (sockaddr*)&local, sizeof(local)) != 0) {
                closeSock(uc);
                uc = kBadSock;
            }
            else {
                setsockopt(uc, IPPROTO_IP, IP_MULTICAST_TTL, (const char*)&ttl, sizeof(ttl));
            }
        }
        if (mc == kBadSock && uc == kBadSock) { return result; }

        auto sendOn = [&](sock_t s, const std::vector<uint8_t>& q) {
            if (s == kBadSock) { return; }
            if (ifaces.empty()) {
                sendto(s, (const char*)q.data(), (int)q.size(), 0, (sockaddr*)&group, sizeof(group));
                return;
            }
            // Out of every interface: the receiver may sit on any of them.
            for (const auto& ifa : ifaces) {
                setsockopt(s, IPPROTO_IP, IP_MULTICAST_IF, (const char*)&ifa, sizeof(ifa));
                sendto(s, (const char*)q.data(), (int)q.size(), 0, (sockaddr*)&group, sizeof(group));
            }
        };
        auto sendAll = [&](const std::vector<std::pair<std::string, uint16_t>>& qs) {
            sendOn(mc, buildQuery(qs, false));
            sendOn(uc, buildQuery(qs, true));
        };

        Records rec;
        auto start = std::chrono::steady_clock::now();
        auto deadline = start + std::chrono::milliseconds(timeoutMs);
        auto nextSend = start;
        int rounds = 0;
        uint8_t buf[9000];
        while (std::chrono::steady_clock::now() < deadline) {
            auto now = std::chrono::steady_clock::now();
            if (now >= nextSend) {
                // Ask for whatever is still missing. Responders usually volunteer
                // SRV, TXT and A with the PTR, but a legacy unicast answer may
                // carry the PTR alone, so each gap gets its own question.
                std::vector<std::pair<std::string, uint16_t>> qs;
                if (rounds < 3) { qs.push_back({ service, T_PTR }); }
                for (const auto& inst : rec.ptr[service]) {
                    if (!rec.srv.count(inst)) { qs.push_back({ inst, T_SRV }); }
                    if (!rec.txt.count(inst)) { qs.push_back({ inst, T_TXT }); }
                    auto it = rec.srv.find(inst);
                    if (it != rec.srv.end() && !rec.a.count(it->second.first)) { qs.push_back({ it->second.first, T_A }); }
                }
                if (!qs.empty()) { sendAll(qs); }
                rounds++;
                nextSend = now + std::chrono::milliseconds(400);
            }

            fd_set rd;
            FD_ZERO(&rd);
            sock_t maxfd = 0;
            for (sock_t s : { mc, uc }) {
                if (s == kBadSock) { continue; }
                FD_SET(s, &rd);
                if (s > maxfd) { maxfd = s; }
            }
            struct timeval tv = { 0, 100000 };
            if (select((int)maxfd + 1, &rd, NULL, NULL, &tv) <= 0) { continue; }
            for (sock_t s : { mc, uc }) {
                if (s == kBadSock || !FD_ISSET(s, &rd)) { continue; }
                int n = recv(s, (char*)buf, sizeof(buf), 0);
                if (n > 0) { parse(buf, (size_t)n, rec); }
            }
        }
        if (mc != kBadSock) { closeSock(mc); }
        if (uc != kBadSock) { closeSock(uc); }

        for (const auto& inst : rec.ptr[service]) {
            auto sv = rec.srv.find(inst);
            if (sv == rec.srv.end()) { continue; }
            auto a = rec.a.find(sv->second.first);
            if (a == rec.a.end()) { continue; }
            MdnsService m;
            m.instance = rec.instanceLabel.count(inst) ? rec.instanceLabel[inst] : inst;
            m.host = a->second;
            m.port = sv->second.second;
            if (rec.txt.count(inst)) { m.txt = rec.txt[inst]; }
            result.push_back(m);
        }
        return result;
    }
}
