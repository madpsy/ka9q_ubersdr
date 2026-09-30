#pragma once
// The receiver's HTTP API and the public instance directory.
#include "http.h"

#include <string>
#include <vector>

namespace ubersdr {
    // An IQ mode and the rate it streams at. The rates are radiod's presets
    // (presets.conf), never resampled on either side.
    struct IQMode {
        const char* name;
        double sampleRate;
        const char* label;
    };
    // Every IQ mode, narrowest first. "iq" is open to everyone; the wide ones
    // are granted per session by /connection.
    const std::vector<IQMode>& allIQModes();
    const IQMode* findIQMode(const std::string& name);

    // What /connection and /api/description say about a receiver, for this
    // client and password. allowedModes is what this session may actually use
    // — it can be wider than what the directory advertises as public, because a
    // password or a bypassed IP unlocks every wide mode.
    struct ServerInfo {
        std::string name, callsign, location, version;
        double minFreq = 10e3, maxFreq = 30e6;
        std::vector<std::string> allowedModes; // always includes "iq"
        bool bypassed = false;
        int maxSessionTime = 0;       // seconds, 0 = unlimited
        long long dailyRemaining = -1; // seconds, -1 = unlimited
        std::string clientIP;
    };

    // Throws NetError when the receiver cannot be reached, and std::runtime_error
    // with the server's reason when it refuses this client.
    ServerInfo probeServer(const Url& url, const std::string& password, const std::string& sessionId, bool verify);

    // A receiver from the directory or from the LAN.
    struct Receiver {
        std::string name, callsign, location, version;
        Url url;
        std::vector<std::string> publicModes; // advertised, not a promise
        int available = -1, maxClients = -1;
        bool local = false;

        std::string label() const;
    };

    extern const char* kDirectoryURL;

    // Online receivers from instances.ubersdr.org, sorted by callsign. Throws.
    std::vector<Receiver> fetchDirectory(bool verify);

    // Fill in name, callsign and location for a receiver found on the LAN, from
    // its /api/description. Returns false if it did not answer.
    bool describeReceiver(Receiver& inst, bool verify);

    std::string newSessionId();
}
