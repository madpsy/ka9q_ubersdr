#include "server_api.h"
#include "tls_conn.h"

#include <json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <random>
#include <stdexcept>

using nlohmann::json;

namespace ubersdr {
    const char* kDirectoryURL = "https://instances.ubersdr.org";

    const std::vector<IQMode>& allIQModes() {
        static const std::vector<IQMode> modes = {
            { "iq", 12000.0, "12 kHz" },
            { "iq48", 48000.0, "48 kHz" },
            { "iq96", 96000.0, "96 kHz" },
            { "iq192", 192000.0, "192 kHz" },
            { "iq384", 384000.0, "384 kHz" },
        };
        return modes;
    }

    const IQMode* findIQMode(const std::string& name) {
        for (const auto& m : allIQModes()) {
            if (name == m.name) { return &m; }
        }
        return NULL;
    }

    namespace {
        template <class T>
        T get(const json& j, const char* key, T def) {
            auto it = j.find(key);
            if (it == j.end() || it->is_null()) { return def; }
            try { return it->get<T>(); } catch (...) { return def; }
        }

        std::string lower(std::string s) {
            std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            return s;
        }

        void sortInstances(std::vector<Receiver>& list) {
            auto key = [](const Receiver& i) { return lower(i.callsign.empty() ? i.name : i.callsign); };
            std::stable_sort(list.begin(), list.end(), [&](const Receiver& a, const Receiver& b) { return key(a) < key(b); });
        }
    }

    std::string newSessionId() {
        std::random_device rd;
        std::mt19937_64 g(((uint64_t)rd() << 32) ^ rd());
        uint8_t b[16];
        for (auto& x : b) { x = (uint8_t)g(); }
        b[6] = (b[6] & 0x0F) | 0x40; // version 4
        b[8] = (b[8] & 0x3F) | 0x80; // RFC 4122 variant
        char s[37];
        snprintf(s, sizeof(s), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                 b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
        return s;
    }

    ServerInfo probeServer(const Url& url, const std::string& password, const std::string& sessionId, bool verify) {
        ServerInfo info;

        // The description is informative only: an old or locked-down receiver
        // that does not serve it still streams, over the default range.
        try {
            HttpResponse d = httpRequest(url, "GET", "/api/description", "", "", verify);
            if (d.status == 200) {
                json j = json::parse(d.body, nullptr, false);
                if (j.is_object()) {
                    info.version = get<std::string>(j, "version", "");
                    if (j.contains("receiver") && j["receiver"].is_object()) {
                        const json& r = j["receiver"];
                        info.name = get<std::string>(r, "name", "");
                        info.callsign = get<std::string>(r, "callsign", "");
                        info.location = get<std::string>(r, "location", "");
                    }
                    if (j.contains("tuning_range") && j["tuning_range"].is_object()) {
                        double lo = get<double>(j["tuning_range"], "min_frequency", info.minFreq);
                        double hi = get<double>(j["tuning_range"], "max_frequency", info.maxFreq);
                        if (hi > lo) {
                            info.minFreq = lo;
                            info.maxFreq = hi;
                        }
                    }
                }
            }
        }
        catch (const NetError&) {
            throw; // unreachable: no point asking /connection
        }
        catch (...) {}

        std::string body = "{\"user_session_id\":\"" + sessionId + "\"";
        if (!password.empty()) { body += ",\"password\":\"" + jsonEscape(password) + "\""; }
        body += "}";
        HttpResponse c = httpRequest(url, "POST", "/connection", body, "application/json", verify);
        json j = json::parse(c.body, nullptr, false);
        if (!j.is_object()) {
            if (c.status == 200) {
                // A server too old to answer in JSON: it predates the gating, so
                // assume the open mode only and let the stream say otherwise.
                info.allowedModes = { "iq" };
                return info;
            }
            throw std::runtime_error("receiver answered HTTP " + std::to_string(c.status));
        }
        if (!get<bool>(j, "allowed", true)) {
            std::string reason = get<std::string>(j, "reason", "");
            throw std::runtime_error(reason.empty() ? "receiver refused the connection" : reason);
        }
        info.bypassed = get<bool>(j, "bypassed", false);
        info.maxSessionTime = get<int>(j, "max_session_time", 0);
        info.dailyRemaining = get<long long>(j, "daily_time_remaining_secs", -1);
        info.clientIP = get<std::string>(j, "client_ip", "");

        // Plain "iq" is never in the list: it is not gated, so it is always there.
        info.allowedModes.push_back("iq");
        if (j.contains("allowed_iq_modes") && j["allowed_iq_modes"].is_array()) {
            for (const auto& m : j["allowed_iq_modes"]) {
                if (!m.is_string()) { continue; }
                std::string name = m.get<std::string>();
                if (name != "iq" && findIQMode(name)) { info.allowedModes.push_back(name); }
            }
        }
        // Narrowest first, whatever order the server listed them in.
        std::vector<std::string> ordered;
        for (const auto& m : allIQModes()) {
            if (std::find(info.allowedModes.begin(), info.allowedModes.end(), m.name) != info.allowedModes.end()) {
                ordered.push_back(m.name);
            }
        }
        info.allowedModes.swap(ordered);
        return info;
    }

    std::string Receiver::label() const {
        std::string n = name.empty() ? url.host : name;
        std::string upperName = n, upperCall = callsign;
        std::transform(upperName.begin(), upperName.end(), upperName.begin(), [](unsigned char c) { return (char)std::toupper(c); });
        std::transform(upperCall.begin(), upperCall.end(), upperCall.begin(), [](unsigned char c) { return (char)std::toupper(c); });
        if (!callsign.empty() && upperName.find(upperCall) == std::string::npos) { return callsign + " - " + n; }
        return n;
    }

    std::vector<Receiver> fetchDirectory(bool verify) {
        Url dir = parseUrl(kDirectoryURL);
        HttpResponse r = httpRequest(dir, "GET", "/api/instances?online_only=true", "", "", verify, 15000);
        if (r.status != 200) { throw std::runtime_error("directory returned HTTP " + std::to_string(r.status)); }
        json j = json::parse(r.body, nullptr, false);
        if (!j.is_object() || !j.contains("instances") || !j["instances"].is_array()) {
            throw std::runtime_error("unexpected directory response");
        }
        std::vector<Receiver> out;
        for (const auto& e : j["instances"]) {
            if (!e.is_object()) { continue; }
            Receiver in;
            in.url.host = get<std::string>(e, "host", "");
            in.url.port = get<int>(e, "port", 0);
            in.url.tls = get<bool>(e, "tls", false);
            if (!in.url.valid()) { continue; }
            in.name = get<std::string>(e, "name", "");
            in.callsign = get<std::string>(e, "callsign", "");
            in.location = get<std::string>(e, "location", "");
            in.version = get<std::string>(e, "version", "");
            in.maxClients = get<int>(e, "max_clients", -1);
            in.available = get<int>(e, "available_clients", -1);
            if (e.contains("public_iq_modes") && e["public_iq_modes"].is_array()) {
                for (const auto& m : e["public_iq_modes"]) {
                    if (m.is_string() && findIQMode(m.get<std::string>())) { in.publicModes.push_back(m.get<std::string>()); }
                }
            }
            // Listed whether or not it advertises a wide mode: plain iq is open
            // everywhere, and a password can unlock the rest.
            out.push_back(in);
        }
        sortInstances(out);
        return out;
    }

    bool describeReceiver(Receiver& inst, bool verify) {
        try {
            HttpResponse d = httpRequest(inst.url, "GET", "/api/description", "", "", verify, 4000);
            if (d.status != 200) { return false; }
            json j = json::parse(d.body, nullptr, false);
            if (!j.is_object()) { return false; }
            inst.version = get<std::string>(j, "version", inst.version);
            if (j.contains("receiver") && j["receiver"].is_object()) {
                const json& r = j["receiver"];
                inst.name = get<std::string>(r, "name", inst.name);
                inst.callsign = get<std::string>(r, "callsign", inst.callsign);
                inst.location = get<std::string>(r, "location", inst.location);
            }
            inst.maxClients = get<int>(j, "max_clients", inst.maxClients);
            inst.available = get<int>(j, "available_clients", inst.available);
            if (j.contains("public_iq_modes") && j["public_iq_modes"].is_array()) {
                inst.publicModes.clear();
                for (const auto& m : j["public_iq_modes"]) {
                    if (m.is_string() && findIQMode(m.get<std::string>())) { inst.publicModes.push_back(m.get<std::string>()); }
                }
            }
            return true;
        }
        catch (...) {
            return false;
        }
    }
}
