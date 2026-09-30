#pragma once
// The one ABI difference between the SDR++ builds this module loads into.
//
// SourceManager::SourceHandler is the struct a source registers itself with.
// Upstream SDR++ lays it out as
//
//     stream, menu, select, deselect, start, stop, tune, ctx
//
// and SDR++ Community Edition inserts a gain callback before ctx:
//
//     stream, menu, select, deselect, start, stop, tune, gain, ctx
//
// Registering the wrong layout does not fail; the core just reads ctx from the
// wrong slot and the first callback crashes. So the module registers this
// superset and fills slot 7 according to which core it finds itself in:
// upstream reads it as ctx, and CE reads it as the gain callback, which it
// checks for NULL before calling.
//
// Every other header the module shares with the core (module.h, config.h,
// core.h, dsp/stream.h, smgui.h, imgui.h 1.87) is identical in both.
#include <dsp/stream.h>
#include <dsp/types.h>
#include <module.h>
#include <signal_path/source.h>

namespace sigpath {
    // Declared here rather than by including signal_path/signal_path.h, which
    // drags in the whole IQ front end and its FFTW/VOLK headers for the sake of
    // this one object.
    SDRPP_EXPORT SourceManager sourceManager;
}

namespace sdrpp_compat {
    struct SourceHandler {
        dsp::stream<dsp::complex_t>* stream;
        void (*menuHandler)(void* ctx);
        void (*selectHandler)(void* ctx);
        void (*deselectHandler)(void* ctx);
        void (*startHandler)(void* ctx);
        void (*stopHandler)(void* ctx);
        void (*tuneHandler)(double freq, void* ctx);
        void* slot7; // upstream: ctx.  CE: gain callback (NULL = none)
        void* slot8; // upstream: unused. CE: ctx
    };

    // True when the running core is SDR++ Community Edition, recognised by the
    // SourceManager::setGain it exports and upstream does not.
    bool isCommunityEdition();

    // Fill in ctx for whichever layout the running core reads.
    void setContext(SourceHandler& h, void* ctx);

    void registerSource(const std::string& name, SourceHandler* h);
}
