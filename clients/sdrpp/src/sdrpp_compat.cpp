#include "sdrpp_compat.h"
#include <utils/flog.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace sdrpp_compat {
    bool isCommunityEdition() {
        static const bool ce = [] {
#ifdef _WIN32
            HMODULE core = GetModuleHandleW(L"sdrpp_core.dll");
            return core && GetProcAddress(core, "?setGain@SourceManager@@QEAAXN@Z") != NULL;
#else
            return dlsym(RTLD_DEFAULT, "_ZN13SourceManager7setGainEd") != NULL;
#endif
        }();
        return ce;
    }

    void setContext(SourceHandler& h, void* ctx) {
        if (isCommunityEdition()) {
            h.slot7 = NULL;
            h.slot8 = ctx;
        }
        else {
            h.slot7 = ctx;
            h.slot8 = NULL;
        }
    }

    void registerSource(const std::string& name, SourceHandler* h) {
        flog::info("UberSDR: registering with {0} SDR++", isCommunityEdition() ? "Community Edition" : "upstream");
        sigpath::sourceManager.registerSource(name, reinterpret_cast<SourceManager::SourceHandler*>(h));
    }
}
