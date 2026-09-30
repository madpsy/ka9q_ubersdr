// omnirig_core.cpp — see omnirig_core.h.
#include "omnirig_core.h"

#include <cstdio>
#include <cstdlib>

namespace omnirig {

Vfo parseVfo(const std::string &s) {
    if (s == "A" || s == "a") return Vfo::A;
    if (s == "B" || s == "b") return Vfo::B;
    return Vfo::Current;
}

bool Snapshot::operator==(const Snapshot &o) const {
    return status == o.status && statusText == o.statusText && rigType == o.rigType && freq == o.freq &&
           mode == o.mode && tx == o.tx && vfo == o.vfo && split == o.split && readable == o.readable &&
           writeable == o.writeable;
}

// Whether the rig is receiving on B. Vfo reports the pair as RX then TX (PM_VFOBA
// is receive on B, transmit on A), or a single VFO on rigs that have no split.
static bool receivingOnB(long vfo) {
    return vfo == PM_VFOB || vfo == PM_VFOBA || vfo == PM_VFOBB;
}

// A VFO asked for by name is read from and written to its own property where
// the rig has one, and Freq where it does not — the same fallback the Python
// client makes. Current prefers Freq, which OmniRig defines as the frequency of
// the VFO in use; a rig description that only has FreqA and FreqB is answered
// from whichever of them the rig says it is receiving on.
//
// `params` is ReadableParams for a read and WriteableParams for a write: the
// same rig can often read a property it cannot set.
const char *Session::frequencyProperty(long params, long vfo) const {
    bool b = vfo_ == Vfo::B || (vfo_ == Vfo::Current && receivingOnB(vfo));
    if (vfo_ == Vfo::Current && (params & PM_FREQ)) return "Freq";
    if (params & (b ? PM_FREQB : PM_FREQA)) return b ? "FreqB" : "FreqA";
    if (params & PM_FREQ) return "Freq";
    return nullptr;
}

bool Session::poll(std::string &line) {
    line.clear();
    Snapshot s;
    // Status is the one read whose failure is taken as the server going away;
    // it is also the first, so a dead server is noticed before anything else is
    // asked of it.
    if (!rig_.get("Status", s.status)) return false;
    if (!rig_.getText("StatusStr", s.statusText)) return false;
    if (!rig_.getText("RigType", s.rigType)) return false;
    // Everything else only means something while the rig is on line. Offline,
    // OmniRig goes on answering with whatever it last had, which would be shown
    // as a rig sitting on a frequency it may have left an hour ago.
    if (s.status == ST_ONLINE) {
        if (!rig_.get("ReadableParams", s.readable)) return false;
        if (!rig_.get("WriteableParams", s.writeable)) return false;
        if (!rig_.get("Vfo", s.vfo)) return false;
        if (const char *p = frequencyProperty(s.readable, s.vfo)) {
            if (!rig_.get(p, s.freq)) return false;
        }
        if (!rig_.get("Mode", s.mode)) return false;
        if (!rig_.get("Tx", s.tx)) return false;
        if (!rig_.get("Split", s.split)) return false;
    }
    if (reported_ && s == last_) return true;
    last_ = s;
    reported_ = true;
    line = stateLine(s);
    return true;
}

// The value after the command word, as a whole number, or false for anything
// else — a command with junk after it is refused rather than half-obeyed.
static bool parseArg(const std::string &line, size_t at, long &out) {
    std::string rest = line.substr(at);
    size_t start = rest.find_first_not_of(" \t");
    if (start == std::string::npos) return false;
    const char *s = rest.c_str() + start;
    char *end = nullptr;
    long long v = std::strtoll(s, &end, 10);
    if (end == s) return false;
    while (*end == ' ' || *end == '\t' || *end == '\r') end++;
    if (*end) return false;
    if (v < 0 || v > 0x7fffffffLL) return false;
    out = static_cast<long>(v);
    return true;
}

std::string Session::command(const std::string &raw, bool &quit) {
    std::string line = raw;
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) line.pop_back();
    if (line.empty()) return "";
    if (line == "quit") {
        quit = true;
        return "";
    }

    if (line.compare(0, 5, "freq ") == 0) {
        long hz;
        if (!parseArg(line, 5, hz) || hz == 0) return warnLine("bad frequency: " + line);
        // What the rig can write is read fresh rather than taken from the last
        // poll: a command can arrive before the first one.
        long writeable = 0, vfo = 0;
        if (!rig_.get("WriteableParams", writeable) || !rig_.get("Vfo", vfo)) {
            return warnLine("OmniRig did not answer");
        }
        const char *p = frequencyProperty(writeable, vfo);
        if (!p) return warnLine("this rig's frequency cannot be set through OmniRig");
        if (!rig_.put(p, hz)) return warnLine(std::string("setting ") + p + " failed");
        return "";
    }

    if (line.compare(0, 5, "mode ") == 0) {
        long mode;
        // Exactly one mode bit: OmniRig takes Mode as a single RigParamX.
        if (!parseArg(line, 5, mode) || (mode & ~MODE_MASK) || !mode || (mode & (mode - 1))) {
            return warnLine("bad mode: " + line);
        }
        long writeable = 0;
        if (!rig_.get("WriteableParams", writeable)) return warnLine("OmniRig did not answer");
        // A mode this rig's description cannot set is left alone, not forced:
        // writing it anyway makes OmniRig send the rig a command it has none for.
        if (!(writeable & mode)) return warnLine("this rig cannot be set to that mode through OmniRig");
        if (!rig_.put("Mode", mode)) return warnLine("setting Mode failed");
        return "";
    }

    return warnLine("unknown command: " + line);
}

std::string jsonString(const std::string &s) {
    std::string out = "\"";
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
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += static_cast<char>(c);
            }
        }
    }
    return out + "\"";
}

// Concatenated rather than streamed: iostreams bring the whole locale machinery
// into a static link, and were most of the helper's size.
std::string stateLine(const Snapshot &s) {
    return "{\"type\":\"state\",\"status\":" + std::to_string(s.status) +
           ",\"statusText\":" + jsonString(s.statusText) + ",\"rigType\":" + jsonString(s.rigType) +
           ",\"freq\":" + std::to_string(s.freq) + ",\"mode\":" + std::to_string(s.mode) +
           ",\"tx\":" + std::to_string(s.tx) + ",\"vfo\":" + std::to_string(s.vfo) +
           ",\"split\":" + std::to_string(s.split) + ",\"readable\":" + std::to_string(s.readable) +
           ",\"writeable\":" + std::to_string(s.writeable) + "}";
}

std::string readyLine(long interfaceVersion, long softwareVersion, int rigNumber) {
    return "{\"type\":\"ready\",\"rig\":" + std::to_string(rigNumber) +
           ",\"interfaceVersion\":" + std::to_string(interfaceVersion) +
           ",\"softwareVersion\":" + std::to_string(softwareVersion) + "}";
}

std::string errorLine(const std::string &code, const std::string &message) {
    return "{\"type\":\"error\",\"code\":" + jsonString(code) + ",\"message\":" + jsonString(message) + "}";
}

std::string warnLine(const std::string &message) {
    return "{\"type\":\"warn\",\"message\":" + jsonString(message) + "}";
}

}  // namespace omnirig
