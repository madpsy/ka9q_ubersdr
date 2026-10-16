// whisper_wasm.cpp — the Whisper session, compiled to WebAssembly for a browser.
//
// The v2 page's on-device speech-to-text where there is no native app around it
// to bring a recogniser: whisper.cpp and the same Session the desktop client's
// helper runs (../whisper_session.cpp), in a Web Worker
// (static/v2/src/extensions/whisper/wasm/worker.entry.js), fed by
// static/v2/src/extensions/whisper/engines/wasm.js.
//
// What differs from the helper, and why — measured in Chrome 145 on 5 s chunks
// of an AM broadcast, single-threaded, in seconds of work per second of audio:
//
//   * One thread. Threads in WebAssembly need SharedArrayBuffer, which needs
//     the page cross-origin isolated, which no UberSDR server is. A thread
//     each would have helped — base's full-window final went 3.4 → 1.7 on two
//     — but sizing the encoder helps more and needs nothing from the server.
//   * Finals with the encoder sized to the utterance (SessionConfig.sizedFinals):
//     tiny 1.05–1.47 on Whisper's full 30 s window and 0.32 sized; base 3.4
//     against 0.69. The full window does not keep up in a browser at all.
//   * A budget on each final (SessionConfig.finalBudget): with the window
//     sized, a short utterance can loop through every temperature fallback —
//     base took 29 s over one 5 s chunk. Abandoned at the budget, the final
//     falls back on its interim, as any failed final does.
//   * No abandoning a decode for a retune. The worker's one thread is in
//     whisper_full until it returns, so a RESET waits behind it; the worker
//     tags each line with the event it came from and the page drops the stale
//     ones instead (see worker.entry.js).
//
// The models come from the page as bytes — it downloads them, checks them
// against the pins in ../models.json and keeps them in IndexedDB — and are
// loaded from memory.
#include <emscripten.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "whisper.h"
#include "whisper_core.h"
#include "whisper_session.h"

using namespace whisperhelper;

// The worker's half: see worker.entry.js.
EM_JS(void, js_line, (const char *s), { if (Module.onLine) Module.onLine(UTF8ToString(s)); });
EM_JS(void, js_note, (const char *s), { if (Module.onNote) Module.onNote(UTF8ToString(s)); });
EM_JS(double, js_backlog, (), { return Module.backlog ? Module.backlog() : 0; });

namespace {

// A final may take its audio's length, and two seconds at the least.
constexpr double FINAL_BUDGET = 1.0;

class WorkerHost : public SessionHost {
public:
    void emit(const std::string &line) override { js_line(line.c_str()); }
    void note(const std::string &text) override { js_note(text.c_str()); }
    bool superseded() const override { return false; }
    size_t backlog() const override { return static_cast<size_t>(js_backlog()); }
};

struct Memory {
    const uint8_t *data;
    size_t size;
    size_t pos;
};

whisper_context *g_ctx = nullptr;
whisper_vad_context *g_vad = nullptr;
WorkerHost g_host;
std::unique_ptr<Session> g_session;
bool g_verbose = false;
std::string g_out;

void onLog(enum ggml_log_level level, const char *text, void *) {
    static bool lastShown = false;
    bool show;
    if (level == GGML_LOG_LEVEL_CONT) show = lastShown;
    else show = g_verbose || level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR;
    lastShown = show;
    if (show && text) js_note(text);
}

// A new session whenever a model changes: it holds both.
void renew() {
    g_session.reset();
    if (!g_ctx || !g_vad) return;
    SessionConfig cfg;
    cfg.threads = 1;
    cfg.sizedFinals = true;
    cfg.finalBudget = FINAL_BUDGET;
    g_session.reset(new Session(g_ctx, g_vad, cfg, g_host, g_verbose));
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void stt_init(int verbose) {
    g_verbose = verbose != 0;
    whisper_log_set(onLog, nullptr);
}

// The speech model, from `size` bytes at `data`, which the caller frees after.
// 0 on success.
EMSCRIPTEN_KEEPALIVE int stt_load_model(const uint8_t *data, size_t size) {
    g_session.reset();
    if (g_ctx) whisper_free(g_ctx);
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    g_ctx = whisper_init_from_buffer_with_params(const_cast<uint8_t *>(data), size, cp);
    renew();
    return g_ctx ? 0 : -1;
}

// The voice-activity model, likewise.
EMSCRIPTEN_KEEPALIVE int stt_load_vad(const uint8_t *data, size_t size) {
    g_session.reset();
    if (g_vad) whisper_vad_free(g_vad);
    Memory m{data, size, 0};
    whisper_model_loader loader{};
    loader.context = &m;
    loader.read = [](void *c, void *out, size_t n) {
        Memory *mm = static_cast<Memory *>(c);
        const size_t k = std::min(n, mm->size - mm->pos);
        std::memcpy(out, mm->data + mm->pos, k);
        mm->pos += k;
        return k;
    };
    loader.eof = [](void *c) {
        Memory *mm = static_cast<Memory *>(c);
        return mm->pos >= mm->size;
    };
    loader.close = [](void *) {};
    whisper_vad_context_params vp = whisper_vad_default_context_params();
    vp.n_threads = 1;
    vp.use_gpu = false;
    g_vad = whisper_vad_init_with_params(&loader, vp);
    renew();
    return g_vad ? 0 : -1;
}

// Whether the speech model is multilingual: 1, 0, or -1 with none loaded.
EMSCRIPTEN_KEEPALIVE int stt_multilingual() { return g_ctx ? (whisper_is_multilingual(g_ctx) ? 1 : 0) : -1; }

// Whisper's languages as BCP-47 tags, a JSON array, in Whisper's own order.
EMSCRIPTEN_KEEPALIVE const char *stt_languages() {
    g_out = "[";
    for (int id = 0; id <= whisper_lang_max_id(); id++) {
        if (id) g_out += ",";
        g_out += jsonString(languageTag(whisper_lang_str(id)));
    }
    g_out += "]";
    return g_out.c_str();
}

// The protocol, as the helper's frames: see ../whisper_helper.cpp. Lines come
// back through Module.onLine. Each returns -1 with no models loaded.
EMSCRIPTEN_KEEPALIVE int stt_start(const char *json) {
    if (!g_session) return -1;
    g_session->start(json ? json : "");
    return 0;
}

EMSCRIPTEN_KEEPALIVE int stt_audio(const float *samples, int n, int gap) {
    if (!g_session) return -1;
    if (n > 0) g_session->audio(samples, static_cast<size_t>(n), gap != 0);
    return 0;
}

EMSCRIPTEN_KEEPALIVE int stt_reset() {
    if (!g_session) return -1;
    g_session->reset();
    return 0;
}

EMSCRIPTEN_KEEPALIVE int stt_stop() {
    if (!g_session) return -1;
    g_session->stop();
    return 0;
}

// Nothing is waiting: an interim, if one is due.
EMSCRIPTEN_KEEPALIVE int stt_interim() {
    if (!g_session) return -1;
    g_session->interim();
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char *stt_version() { return whisper_version(); }

}  // extern "C"
