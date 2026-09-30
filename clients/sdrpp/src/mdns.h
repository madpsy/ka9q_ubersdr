#pragma once
#include <string>
#include <vector>

namespace ubersdr {
    struct MdnsService {
        std::string instance; // "My Receiver" from "My Receiver._ubersdr._tcp.local"
        std::string host;     // IPv4 address, dotted
        int port = 0;
        std::vector<std::string> txt;
    };

    // Browse for _ubersdr._tcp on every IPv4 interface for about timeoutMs.
    // Answers are heard two ways; see mdnsBrowse in mdns.cpp for why.
    std::vector<MdnsService> mdnsBrowse(const std::string& service = "_ubersdr._tcp.local", int timeoutMs = 2500);
}
