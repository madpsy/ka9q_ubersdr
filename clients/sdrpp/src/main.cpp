// UberSDR source module for SDR++.
//
// Streams IQ from an UberSDR receiver (48 to 384 kHz wide, or 12 kHz on any
// receiver) into SDR++, which then does its own spectrum, waterfall and
// demodulation. Receivers come from the public directory, from mDNS on the LAN,
// or from a typed URL; a password unlocks whatever wide modes the operator
// reserves for it.
#include "http.h"
#include "iq_session.h"
#include "mdns.h"
#include "sdrpp_compat.h"
#include "server_api.h"
#include "tls_conn.h"

#include <config.h>
#include <core.h>
#include <gui/smgui.h>
#include <imgui.h>
#include <module.h>
#include <utils/flog.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>

#define CONCAT(a, b) ((std::string(a) + b).c_str())

SDRPP_MOD_INFO{
    /* Name:            */ "ubersdr_source",
    /* Description:     */ "UberSDR network receiver source for SDR++",
    /* Author:          */ "UberSDR",
    /* Version:         */ 1, 0, 0,
    /* Max instances    */ 1
};

ConfigManager config;

using namespace ubersdr;

namespace {
    enum SourceKind { SRC_DIRECTORY = 0, SRC_LAN = 1, SRC_MANUAL = 2 };
    const char* kSourceKinds = "Public directory\0Local network\0Manual\0";

    // Reduced-depth choices, lossless first. The index is what the menu keeps.
    const int kMargins[] = { 0, 60, 50, 40, 30, 26, 20, 15, 10 };
    const char* kMarginText = "Lossless\0" "60 dB (near lossless)\0" "50 dB\0" "40 dB\0" "30 dB\0"
                              "26 dB\0" "20 dB\0" "15 dB\0" "10 dB (default)\0";
    const int kMarginCount = sizeof(kMargins) / sizeof(kMargins[0]);

    int marginIndex(int db) {
        for (int i = 0; i < kMarginCount; i++) {
            if (kMargins[i] == db) { return i; }
        }
        return kMarginCount - 1;
    }

    std::string modesText(const std::vector<std::string>& modes) {
        std::string s;
        for (const auto& m : modes) {
            const IQMode* im = findIQMode(m);
            if (!im || m == "iq") { continue; }
            if (!s.empty()) { s += ","; }
            s += std::to_string((int)(im->sampleRate / 1000));
        }
        return s;
    }

    std::string formatDuration(long long secs) {
        if (secs < 0) { return "unlimited"; }
        char buf[32];
        if (secs >= 3600) { snprintf(buf, sizeof(buf), "%lldh %02lldm", secs / 3600, (secs % 3600) / 60); }
        else { snprintf(buf, sizeof(buf), "%lldm", secs / 60); }
        return buf;
    }
}

class UberSDRSourceModule : public ModuleManager::Instance {
public:
    UberSDRSourceModule(std::string name) : name(name), session(&stream) {
        config.acquire();
        sourceKind = std::clamp<int>(config.conf.value("source", (int)SRC_DIRECTORY), 0, 2);
        std::string manual = config.conf.value("manualUrl", std::string(""));
        strncpy(manualUrl, manual.c_str(), sizeof(manualUrl) - 1);
        selectedKey = config.conf.value("selectedUrl", std::string(""));
        verifyTLS = config.conf.value("verifyTls", true);
        config.release();

        handler.stream = &stream;
        handler.menuHandler = menuHandler;
        handler.selectHandler = menuSelected;
        handler.deselectHandler = menuDeselected;
        handler.startHandler = start;
        handler.stopHandler = stop;
        handler.tuneHandler = tune;
        sdrpp_compat::setContext(handler, this);

        loadServerPrefs();
        sdrpp_compat::registerSource("UberSDR", &handler);
    }

    ~UberSDRSourceModule() {
        stop(this);
        sigpath::sourceManager.unregisterSource("UberSDR");
        if (dirThread.joinable()) { dirThread.join(); }
        if (lanThread.joinable()) { lanThread.join(); }
        if (probeThread.joinable()) { probeThread.join(); }
    }

    void postInit() {}
    void enable() { enabled = true; }
    void disable() { enabled = false; }
    bool isEnabled() { return enabled; }

private:
    // ----- which receiver --------------------------------------------------------

    // The receiver the menu currently points at, whichever list it came from.
    Url currentUrl() {
        if (sourceKind == SRC_MANUAL) { return parseUrl(manualUrl); }
        std::lock_guard<std::mutex> lck(listMtx);
        const auto& list = sourceKind == SRC_DIRECTORY ? directory : lan;
        for (const auto& in : list) {
            if (in.url.str() == selectedKey) { return in.url; }
        }
        return Url();
    }

    // Per-receiver settings are keyed by URL, so switching between receivers
    // brings back each one's password, rate and quality.
    void loadServerPrefs() {
        Url u = currentUrl();
        std::string key = u.valid() ? u.str() : "";
        if (key == prefsKey) { return; }
        prefsKey = key;
        password[0] = 0;
        mode = "iq";
        marginDB = kMarginDefaultDB;
        info = ServerInfo();
        haveInfo = false;
        probeError.clear();
        if (!key.empty()) {
            config.acquire();
            if (config.conf.contains("servers") && config.conf["servers"].contains(key)) {
                const auto& s = config.conf["servers"][key];
                std::string pw = s.value("password", std::string(""));
                strncpy(password, pw.c_str(), sizeof(password) - 1);
                mode = s.value("mode", std::string("iq"));
                marginDB = s.value("minMargin", kMarginDefaultDB);
            }
            config.release();
        }
        if (!findIQMode(mode)) { mode = "iq"; }
        rebuildModeList();
        applySampleRate();
    }

    // The rate is SDR++'s global input rate, so it is only ours to set while
    // this source is the selected one and not streaming.
    void applySampleRate() {
        if (selected && !running) { core::setInputSampleRate(sampleRate()); }
    }

    void saveServerPrefs() {
        if (prefsKey.empty()) { return; }
        config.acquire();
        config.conf["servers"][prefsKey]["password"] = std::string(password);
        config.conf["servers"][prefsKey]["mode"] = mode;
        config.conf["servers"][prefsKey]["minMargin"] = marginDB;
        config.release(true);
    }

    void saveSelection() {
        config.acquire();
        config.conf["source"] = sourceKind;
        config.conf["manualUrl"] = std::string(manualUrl);
        config.conf["selectedUrl"] = selectedKey;
        config.conf["verifyTls"] = verifyTLS;
        config.release(true);
    }

    double sampleRate() {
        const IQMode* m = findIQMode(mode);
        return m ? m->sampleRate : 12000.0;
    }

    // Before Connect, every mode is offered and the stream will say if one is
    // not allowed; after it, only what /connection granted this session.
    void rebuildModeList() {
        modeNames.clear();
        modeListText.clear();
        if (haveInfo) {
            modeNames = info.allowedModes;
        }
        else {
            for (const auto& m : allIQModes()) { modeNames.push_back(m.name); }
        }
        if (std::find(modeNames.begin(), modeNames.end(), mode) == modeNames.end()) {
            // The saved rate is gone: take the widest this session may use.
            mode = modeNames.empty() ? "iq" : modeNames.back();
        }
        modeId = 0;
        for (size_t i = 0; i < modeNames.size(); i++) {
            const IQMode* m = findIQMode(modeNames[i]);
            modeListText += m ? m->label : modeNames[i];
            modeListText += '\0';
            if (modeNames[i] == mode) { modeId = (int)i; }
        }
    }

    // ----- discovery ---------------------------------------------------------------

    void refreshDirectory() {
        if (dirBusy) { return; }
        if (dirThread.joinable()) { dirThread.join(); }
        dirBusy = true;
        dirError.clear();
        bool verify = verifyTLS;
        dirThread = std::thread([this, verify] {
            try {
                auto list = fetchDirectory(verify);
                std::lock_guard<std::mutex> lck(listMtx);
                directory = std::move(list);
                dirLoaded = true;
            }
            catch (const std::exception& e) {
                std::lock_guard<std::mutex> lck(listMtx);
                dirError = e.what();
            }
            dirBusy = false;
            listsChanged = true;
        });
    }

    void scanLAN() {
        if (lanBusy) { return; }
        if (lanThread.joinable()) { lanThread.join(); }
        lanBusy = true;
        bool verify = verifyTLS;
        lanThread = std::thread([this, verify] {
            std::vector<Receiver> found;
            for (const auto& svc : mdnsBrowse()) {
                Receiver in;
                in.local = true;
                in.name = svc.instance;
                in.url.host = svc.host;
                in.url.port = svc.port;
                in.url.tls = false;
                for (const auto& t : svc.txt) {
                    // path= is where the receiver lives when it is not at /.
                    if (t.rfind("path=", 0) == 0 && t.size() > 5) {
                        std::string p = t.substr(5);
                        while (!p.empty() && p.back() == '/') { p.pop_back(); }
                        in.url.basePath = p;
                    }
                }
                describeReceiver(in, verify);
                found.push_back(in);
            }
            std::sort(found.begin(), found.end(), [](const Receiver& a, const Receiver& b) { return a.label() < b.label(); });
            {
                std::lock_guard<std::mutex> lck(listMtx);
                lan = std::move(found);
                lanScanned = true;
            }
            lanBusy = false;
            listsChanged = true;
        });
    }

    void rebuildLists() {
        std::lock_guard<std::mutex> lck(listMtx);
        std::string filter = filterText;
        std::transform(filter.begin(), filter.end(), filter.begin(), [](unsigned char c) { return (char)std::tolower(c); });
        auto matches = [&](const Receiver& in) {
            if (filter.empty()) { return true; }
            for (const std::string* f : { &in.name, &in.callsign, &in.location, &in.url.host }) {
                std::string l = *f;
                std::transform(l.begin(), l.end(), l.begin(), [](unsigned char c) { return (char)std::tolower(c); });
                if (l.find(filter) != std::string::npos) { return true; }
            }
            return false;
        };

        const auto& list = sourceKind == SRC_DIRECTORY ? directory : lan;
        shownKeys.clear();
        shownText.clear();
        shownId = -1;
        for (const auto& in : list) {
            if (sourceKind == SRC_DIRECTORY && !matches(in)) { continue; }
            std::string label = in.label();
            // What anyone may use, as advertised. A password or an allow-listed
            // IP can open more; Connect finds out.
            std::string modes = modesText(in.publicModes);
            if (!modes.empty()) { label += "  [" + modes + " kHz]"; }
            if (in.available >= 0 && in.maxClients > 0) {
                label += "  " + std::to_string(in.available) + "/" + std::to_string(in.maxClients) + " free";
            }
            std::string key = in.url.str();
            if (key == selectedKey) { shownId = (int)shownKeys.size(); }
            shownKeys.push_back(key);
            shownText += label;
            shownText += '\0';
        }
        if (shownId < 0 && !shownKeys.empty() && sourceKind != SRC_MANUAL) {
            // Keep a remembered choice that the filter hides; otherwise pick the first.
            bool known = false;
            for (const auto& in : list) { known = known || in.url.str() == selectedKey; }
            if (!known) {
                shownId = 0;
                selectedKey = shownKeys[0];
            }
        }
        if (shownText.empty()) { shownText = std::string("\0", 1); }
    }

    // ----- connecting ----------------------------------------------------------------

    void probe() {
        if (probeBusy) { return; }
        Url u = currentUrl();
        if (!u.valid()) {
            probeError = "no receiver selected";
            return;
        }
        if (probeThread.joinable()) { probeThread.join(); }
        probeBusy = true;
        probeError.clear();
        std::string pw = password;
        bool verify = verifyTLS;
        std::string key = u.str();
        probeThread = std::thread([this, u, pw, verify, key] {
            try {
                ServerInfo si = probeServer(u, pw, newSessionId(), verify);
                std::lock_guard<std::mutex> lck(probeMtx);
                probed = si;
                probedKey = key;
                probedOk = true;
            }
            catch (const std::exception& e) {
                std::lock_guard<std::mutex> lck(probeMtx);
                probedErr = e.what();
                probedKey = key;
                probedOk = false;
            }
            probeBusy = false;
            probeDone = true;
        });
    }

    // Picked up on the UI thread, so the menu state only changes there.
    void collectProbe() {
        if (!probeDone) { return; }
        probeDone = false;
        std::lock_guard<std::mutex> lck(probeMtx);
        if (probedKey != prefsKey) { return; } // the selection moved on meanwhile
        if (probedOk) {
            info = probed;
            haveInfo = true;
            probeError.clear();
            rebuildModeList();
            applySampleRate();
            saveServerPrefs();
        }
        else {
            haveInfo = false;
            probeError = probedErr;
            rebuildModeList();
        }
    }

    // ----- SDR++ callbacks -----------------------------------------------------------

    static void menuSelected(void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        _this->selected = true;
        core::setInputSampleRate(_this->sampleRate());
        flog::info("UberSDRSourceModule '{0}': Menu Select!", _this->name);
    }

    static void menuDeselected(void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        _this->selected = false;
        flog::info("UberSDRSourceModule '{0}': Menu Deselect!", _this->name);
    }

    static void start(void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        if (_this->running) { return; }
        Url u = _this->currentUrl();
        if (!u.valid()) {
            _this->probeError = "no receiver selected";
            flog::error("UberSDR: no receiver selected");
            return;
        }
        IQSession::Params p;
        p.url = u;
        p.password = _this->password;
        p.sessionId = newSessionId();
        p.mode = _this->mode;
        p.frequency = _this->freq;
        p.minFreq = _this->haveInfo ? _this->info.minFreq : 0;
        p.maxFreq = _this->haveInfo ? _this->info.maxFreq : 1e12;
        p.minMarginDB = _this->marginDB;
        p.verify = _this->verifyTLS;
        _this->session.start(p);
        _this->running = true;
        flog::info("UberSDRSourceModule '{0}': Start!", _this->name);
    }

    static void stop(void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        if (!_this->running) { return; }
        _this->session.stop();
        _this->running = false;
        flog::info("UberSDRSourceModule '{0}': Stop!", _this->name);
    }

    static void tune(double freq, void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        _this->freq = freq;
        if (_this->running) { _this->session.tune(freq); }
    }

    static void menuHandler(void* ctx) {
        UberSDRSourceModule* _this = (UberSDRSourceModule*)ctx;
        _this->drawMenu();
    }

    void drawMenu() {
        collectProbe();
        if (listsChanged.exchange(false) || firstDraw) { rebuildLists(); }
        if (firstDraw) {
            firstDraw = false;
            if (sourceKind == SRC_DIRECTORY && !dirLoaded) { refreshDirectory(); }
            if (sourceKind == SRC_LAN && !lanScanned) { scanLAN(); }
        }

        // Everything that picks the receiver or how to reach it is fixed while
        // streaming; quality stays live.
        if (running) { SmGui::BeginDisabled(); }

        SmGui::LeftLabel("Receivers");
        SmGui::FillWidth();
        if (SmGui::Combo(CONCAT("##_ubersdr_kind_", name), &sourceKind, kSourceKinds)) {
            saveSelection();
            rebuildLists();
            if (sourceKind == SRC_DIRECTORY && !dirLoaded) { refreshDirectory(); }
            if (sourceKind == SRC_LAN && !lanScanned) { scanLAN(); }
            loadServerPrefs();
        }

        if (sourceKind == SRC_DIRECTORY) {
            SmGui::LeftLabel("Search");
            SmGui::FillWidth();
            if (SmGui::InputText(CONCAT("##_ubersdr_filter_", name), filterText, sizeof(filterText))) {
                rebuildLists();
            }
        }

        if (sourceKind == SRC_MANUAL) {
            SmGui::LeftLabel("URL");
            SmGui::FillWidth();
            if (SmGui::InputText(CONCAT("##_ubersdr_url_", name), manualUrl, sizeof(manualUrl))) {
                saveSelection();
                loadServerPrefs();
            }
            Url u = parseUrl(manualUrl);
            if (manualUrl[0] && !u.valid()) {
                SmGui::TextColored(ImVec4(1.0f, 0.4f, 0.4f, 1.0f), "Not a receiver address");
            }
            else if (u.valid()) {
                SmGui::Text(CONCAT("-> ", u.str()));
            }
        }
        else {
            bool busy = sourceKind == SRC_DIRECTORY ? (bool)dirBusy : (bool)lanBusy;
            SmGui::FillWidth();
            if (SmGui::Combo(CONCAT("##_ubersdr_list_", name), &shownId, shownText.c_str())) {
                if (shownId >= 0 && shownId < (int)shownKeys.size()) {
                    selectedKey = shownKeys[shownId];
                    saveSelection();
                    loadServerPrefs();
                }
            }
            if (busy) { SmGui::BeginDisabled(); }
            SmGui::FillWidth();
            SmGui::ForceSync();
            const char* label = sourceKind == SRC_DIRECTORY ? (busy ? "Loading...##_ubersdr_refresh" : "Refresh list##_ubersdr_refresh")
                                                              : (busy ? "Scanning...##_ubersdr_scan" : "Scan LAN##_ubersdr_scan");
            if (SmGui::Button(CONCAT(label, name))) {
                if (sourceKind == SRC_DIRECTORY) { refreshDirectory(); }
                else { scanLAN(); }
            }
            if (busy) { SmGui::EndDisabled(); }
            std::string note;
            {
                std::lock_guard<std::mutex> lck(listMtx);
                if (sourceKind == SRC_DIRECTORY && !dirError.empty()) { note = "Directory: " + dirError; }
                else if (sourceKind == SRC_LAN && lanScanned && lan.empty() && !busy) { note = "No receivers found on the LAN"; }
                else if (sourceKind == SRC_DIRECTORY && dirLoaded && shownKeys.empty()) { note = "No receivers match"; }
            }
            if (!note.empty()) { SmGui::TextColored(ImVec4(1.0f, 0.7f, 0.3f, 1.0f), note.c_str()); }
            // The key a receiver is remembered by may have changed with the list.
            if (currentUrl().valid() && currentUrl().str() != prefsKey) { loadServerPrefs(); }
        }

        SmGui::LeftLabel("Password");
        SmGui::FillWidth();
        if (SmGui::InputText(CONCAT("##_ubersdr_pw_", name), password, sizeof(password), ImGuiInputTextFlags_Password)) {
            // A password changes what /connection grants, so what we knew is stale.
            haveInfo = false;
            rebuildModeList();
            saveServerPrefs();
        }

        if (SmGui::Checkbox(CONCAT("Verify TLS certificate##_ubersdr_verify_", name), &verifyTLS)) {
            saveSelection();
        }

        SmGui::FillWidth();
        SmGui::ForceSync();
        if (probeBusy) { SmGui::BeginDisabled(); }
        if (SmGui::Button(CONCAT(probeBusy ? "Connecting...##_ubersdr_probe_" : "Connect##_ubersdr_probe_", name))) {
            probe();
        }
        if (probeBusy) { SmGui::EndDisabled(); }

        SmGui::LeftLabel("Samplerate");
        SmGui::FillWidth();
        if (SmGui::Combo(CONCAT("##_ubersdr_rate_", name), &modeId, modeListText.c_str())) {
            if (modeId >= 0 && modeId < (int)modeNames.size()) {
                mode = modeNames[modeId];
                applySampleRate();
                saveServerPrefs();
            }
        }

        if (running) { SmGui::EndDisabled(); }

        SmGui::LeftLabel("Quality");
        SmGui::FillWidth();
        int mi = marginIndex(marginDB);
        if (SmGui::Combo(CONCAT("##_ubersdr_margin_", name), &mi, kMarginText)) {
            marginDB = kMargins[std::clamp(mi, 0, kMarginCount - 1)];
            saveServerPrefs();
            if (running) { session.setMinMargin(marginDB); }
        }

        drawStatus();
    }

    void drawStatus() {
        if (haveInfo) {
            std::string who = info.callsign;
            if (!info.name.empty()) { who += (who.empty() ? "" : " - ") + info.name; }
            if (!who.empty()) { SmGui::Text(who.c_str()); }
            if (!info.location.empty()) { SmGui::Text(info.location.c_str()); }
            std::string access = info.bypassed ? "Full access (password or allowed IP)" : "Public access";
            SmGui::Text(access.c_str());
            if (info.maxSessionTime > 0) { SmGui::Text(("Session limit: " + formatDuration(info.maxSessionTime)).c_str()); }
            if (info.dailyRemaining >= 0) { SmGui::Text(("Time left today: " + formatDuration(info.dailyRemaining)).c_str()); }
        }
        if (!probeError.empty()) {
            SmGui::TextColored(ImVec4(1.0f, 0.4f, 0.4f, 1.0f), probeError.c_str());
        }

        IQSession::Status s = session.status();
        char buf[256];
        switch (s.state) {
        case IQSession::State::Idle:
            SmGui::Text(running ? "Status: starting" : "Status: idle");
            break;
        case IQSession::State::Connecting:
            SmGui::Text("Status: connecting...");
            break;
        case IQSession::State::Streaming: {
            std::string depth = s.shift == 0 ? "lossless" : "reduced depth (" + std::to_string(s.shift) + " bits)";
            snprintf(buf, sizeof(buf), "Streaming, %.0f kB/s (%.2f Mbit/s)", s.kbytesPerSec, s.kbytesPerSec * 8.0 / 1000.0);
            SmGui::TextColored(ImVec4(0.3f, 1.0f, 0.3f, 1.0f), buf);
            snprintf(buf, sizeof(buf), "Samples: %s", depth.c_str());
            SmGui::TextColored(ImVec4(0.3f, 1.0f, 0.3f, 1.0f), buf);
            if (!s.message.empty()) { SmGui::TextColored(ImVec4(1.0f, 0.7f, 0.3f, 1.0f), s.message.c_str()); }
            break;
        }
        case IQSession::State::Failed:
            SmGui::TextColored(ImVec4(1.0f, 0.4f, 0.4f, 1.0f), ("Stopped: " + s.message).c_str());
            break;
        }
    }

    std::string name;
    bool enabled = true;
    bool running = false;
    bool selected = false;
    double freq = 14074000.0;

    dsp::stream<dsp::complex_t> stream;
    sdrpp_compat::SourceHandler handler = {};
    IQSession session;

    // Where receivers come from, and which one is chosen.
    int sourceKind = SRC_DIRECTORY;
    char manualUrl[1024] = "";
    char filterText[128] = "";
    std::string selectedKey;
    bool verifyTLS = true;
    bool firstDraw = true;

    std::mutex listMtx;
    std::vector<Receiver> directory, lan;
    std::string dirError;
    bool dirLoaded = false, lanScanned = false;
    std::atomic<bool> dirBusy{ false }, lanBusy{ false }, listsChanged{ false };
    std::thread dirThread, lanThread;
    std::vector<std::string> shownKeys;
    std::string shownText;
    int shownId = -1;

    // The chosen receiver's settings and what it told us.
    std::string prefsKey = "\x01"; // never a real key, so the first load runs
    char password[256] = "";
    std::string mode = "iq";
    int marginDB = kMarginDefaultDB;
    std::vector<std::string> modeNames;
    std::string modeListText;
    int modeId = 0;
    ServerInfo info;
    bool haveInfo = false;
    std::string probeError;

    std::thread probeThread;
    std::atomic<bool> probeBusy{ false }, probeDone{ false };
    std::mutex probeMtx;
    ServerInfo probed;
    std::string probedKey, probedErr;
    bool probedOk = false;
};

MOD_EXPORT void _INIT_() {
    json def = json({});
    def["source"] = (int)SRC_DIRECTORY;
    def["manualUrl"] = "";
    def["selectedUrl"] = "";
    def["verifyTls"] = true;
    def["servers"] = json::object();
    config.setPath(core::args["root"].s() + "/ubersdr_source_config.json");
    config.load(def);
    config.enableAutoSave();
}

MOD_EXPORT ModuleManager::Instance* _CREATE_INSTANCE_(std::string name) {
    return new UberSDRSourceModule(name);
}

MOD_EXPORT void _DELETE_INSTANCE_(ModuleManager::Instance* instance) {
    delete (UberSDRSourceModule*)instance;
}

MOD_EXPORT void _END_() {
    config.disableAutoSave();
    config.save();
}
