// whisper_helper.cpp — on-device speech-to-text for the desktop client, as a
// child process.
//
//   whisper-helper --model PATH --vad-model PATH [--threads N] [--verbose]
//   whisper-helper --languages     a JSON array of Whisper's language codes
//   whisper-helper --version
//
// The desktop client's answer to window.ubersdrDesktop.stt (the contract is at
// the top of static/v2/src/extensions/whisper/engines/host.js). The phones have a
// recogniser in the platform; a desktop Electron has none it can use, so this
// brings one: whisper.cpp, linked in statically, with a multilingual model
// shipped beside it and Silero's voice-activity model to cut the audio into
// utterances.
//
// ── The protocol ─────────────────────────────────────────────────────────────
//
// stdin carries frames: [u8 type][u32 little-endian length][payload].
//
//   1 START  JSON {"lang": "en" | "auto" | ..., "session": n}. `lang` is a
//            Whisper language code; the integration maps BCP-47 tags to it.
//   2 AUDIO  PCM16 little-endian, 16 kHz mono, any length.
//   3 RESET  empty: forget the utterance in progress (a retune), keep going.
//   4 STOP   empty: end the session. Nothing more is said about it; the process
//            stays up for the next START.
//
// End of input is the end: the helper exits 0, so one whose parent has gone
// away does not outlive it.
//
// stdout carries one JSON object per line:
//
//   {"type":"ready"}                                  the models are loaded
//   {"type":"started","session":n}
//   {"type":"result","session":n,"text":"...","final":false|true}
//   {"type":"error","session":n|null,"code":"...","message":"...","fatal":bool}
//
// stderr is for people: this file's notes, and whisper.cpp's warnings and
// errors (its chatter is dropped unless --verbose).
//
// ── How it is arranged ───────────────────────────────────────────────────────
//
// Two threads. One only reads stdin, so the pipe never backs up however long a
// transcription takes — the page pushes audio in real time and a blocked pipe
// would stall the receiver's audio path in Electron's main process. The other
// runs the VAD over everything that arrives and transcribes each utterance as
// it ends (whisper_core.cpp decides where that is), with an interim transcript
// of the utterance in progress every two seconds of new speech when it can
// afford one. If it falls more than ten seconds behind, the oldest audio is
// dropped rather than letting the delay grow without bound.
//
// Exit codes: 0 end of input, 1 bad arguments, 2 a model could not be loaded,
// 3 the input stopped making sense.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <shellapi.h>
#else
#include <cerrno>
#include <unistd.h>
#endif

#if defined(WHISPER_HELPER_DISPATCH) && (defined(__x86_64__) || defined(_M_X64))
#include <cpuid.h>
#endif

#include "whisper.h"
#include "whisper_core.h"

using namespace whisperhelper;

#ifndef WHISPER_CPP_COMMIT
#define WHISPER_CPP_COMMIT "unknown"
#endif
#ifndef WHISPER_HELPER_VARIANT
#define WHISPER_HELPER_VARIANT "default"
#endif

namespace {

const char *const HELPER_VERSION = "1";

enum : uint8_t { F_START = 1, F_AUDIO = 2, F_RESET = 3, F_STOP = 4 };

// Behind by this much audio, the oldest is dropped, back down to KEEP.
constexpr size_t MAX_BACKLOG = RATE * 10;
constexpr size_t KEEP_BACKLOG = RATE * 3;
// No frame is anywhere near this; one that claims to be has lost its framing,
// and nothing after it can be trusted.
constexpr uint32_t MAX_FRAME = 16u << 20;
// An interim waits for this much new audio at least, and for twice what the
// last one took, so interims never take more than half the time between them.
constexpr size_t INTERIM_EVERY = RATE * 2;
// ...and is skipped while this much audio is waiting: the final matters more.
constexpr size_t INTERIM_MAX_BACKLOG = RATE / 2;
// ...and while the speaker has been quiet for this long.
constexpr int INTERIM_PAUSE = RATE * 3 / 10;

std::atomic<bool> verbose{false};

// ── Output ───────────────────────────────────────────────────────────────────

std::mutex outLock;

void emit(const std::string &line) {
    std::lock_guard<std::mutex> g(outLock);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void note(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    std::lock_guard<std::mutex> g(outLock);
    std::fprintf(stderr, "whisper-helper: %s\n", buf);
    std::fflush(stderr);
}

std::string sessionField(bool has, long long session) {
    return has ? std::to_string(session) : std::string("null");
}

void emitError(bool hasSession, long long session, const char *code, const std::string &message, bool fatal) {
    emit(std::string("{\"type\":\"error\",\"session\":") + sessionField(hasSession, session) +
         ",\"code\":" + jsonString(code) + ",\"message\":" + jsonString(message) +
         ",\"fatal\":" + (fatal ? "true" : "false") + "}");
}

// whisper.cpp and ggml log through one callback. Their INFO is a running
// commentary — the VAD alone logs three lines per call — so only warnings and
// errors reach stderr unless --verbose.
void onLog(enum ggml_log_level level, const char *text, void *) {
    static thread_local bool lastShown = false;
    bool show;
    if (level == GGML_LOG_LEVEL_CONT) show = lastShown;
    else show = verbose.load() || level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR;
    lastShown = show;
    if (!show || !text) return;
    std::lock_guard<std::mutex> g(outLock);
    std::fputs(text, stderr);
    std::fflush(stderr);
}

// ── Input ────────────────────────────────────────────────────────────────────

struct Event {
    enum Kind { START, AUDIO, RESET, STOP, END } kind = END;
    std::string json;          // START
    std::vector<float> audio;  // AUDIO
    bool gap = false;          // AUDIO: older audio was dropped just before this
    uint64_t epoch = 0;        // the inbox's epoch when this was taken; see Abort
};

// What the reader hands the worker. Control frames purge the audio queued ahead
// of them as they arrive: after a retune or a stop, audio from before it is not
// worth a moment of the worker's time, and a worker that is behind would spend
// seconds transcribing it.
class Inbox {
public:
    void push(Event e) {
        std::lock_guard<std::mutex> g(lock_);
        if (e.kind == Event::AUDIO) {
            queued_ += e.audio.size();
            q_.push_back(std::move(e));
            if (queued_ > MAX_BACKLOG) shed();
        } else {
            purgeAudio();
            if (e.kind == Event::START) {
                StartRequest r = parseStart(e.json);
                session_ = r.session;
                hasSession_ = true;
                warned_ = false;
            }
            q_.push_back(std::move(e));
            // Whatever the worker is transcribing is stale now; see Abort.
            epoch_.fetch_add(1);
        }
        ready_.notify_one();
    }

    Event pop() {
        std::unique_lock<std::mutex> g(lock_);
        ready_.wait(g, [this] { return !q_.empty(); });
        return take();
    }

    bool tryPop(Event &out) {
        std::lock_guard<std::mutex> g(lock_);
        if (q_.empty()) return false;
        out = take();
        return true;
    }

    size_t backlog() {
        std::lock_guard<std::mutex> g(lock_);
        return queued_;
    }

    uint64_t epoch() const { return epoch_.load(); }
    // The epoch as of the last event taken: what the worker is working on is
    // current as long as epoch() still says this.
    uint64_t epochTaken() const { return epochTaken_.load(); }

private:
    Event take() {
        Event e = std::move(q_.front());
        q_.pop_front();
        if (e.kind == Event::AUDIO) queued_ -= e.audio.size();
        // Read under the lock that push() bumps it under, so a control frame
        // is either already counted here or will be seen as new.
        e.epoch = epoch_.load();
        epochTaken_ = e.epoch;
        return e;
    }

    void purgeAudio() {
        std::deque<Event> kept;
        for (auto &e : q_)
            if (e.kind != Event::AUDIO) kept.push_back(std::move(e));
        q_.swap(kept);
        queued_ = 0;
    }

    // Falling behind: drop the oldest audio, back down to KEEP_BACKLOG, and say
    // so once a session. Control frames have purged everything before them, so
    // all the audio in the queue is the current session's.
    void shed() {
        size_t dropped = 0;
        while (queued_ > KEEP_BACKLOG) {
            auto it = std::find_if(q_.begin(), q_.end(), [](const Event &e) { return e.kind == Event::AUDIO; });
            if (it == q_.end()) break;
            queued_ -= it->audio.size();
            dropped += it->audio.size();
            q_.erase(it);
        }
        auto first = std::find_if(q_.begin(), q_.end(), [](const Event &e) { return e.kind == Event::AUDIO; });
        if (first != q_.end()) first->gap = true;
        if (!warned_) {
            warned_ = true;
            char msg[160];
            std::snprintf(msg, sizeof msg,
                          "Transcription is falling behind the audio; %.1f s of it was skipped. "
                          "A smaller model or more threads would keep up.",
                          static_cast<double>(dropped) / RATE);
            emitError(hasSession_, session_, "falling-behind", msg, false);
        }
    }

    std::mutex lock_;
    std::condition_variable ready_;
    std::deque<Event> q_;
    size_t queued_ = 0;
    std::atomic<uint64_t> epoch_{0};
    std::atomic<uint64_t> epochTaken_{0};
    long long session_ = 0;
    bool hasSession_ = false;
    bool warned_ = false;
};

// Reads exactly n bytes; false at end of input or on error, which mean the same
// thing here: nobody is going to send anything more.
//
// The platform's read on the raw handle rather than fread on stdin: the CRT
// locks a stream for the length of a read, and exit() takes every stream's lock
// to flush it, so a process leaving while this thread sat in fread could hang
// on its way out (the same reasoning as ../omnirig/omnirig_helper.cpp).
bool readFully(void *buf, size_t n) {
    char *p = static_cast<char *>(buf);
    while (n > 0) {
#ifdef _WIN32
        DWORD got = 0;
        const DWORD want = static_cast<DWORD>(std::min<size_t>(n, 1u << 20));
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), p, want, &got, nullptr) || got == 0) return false;
#else
        ssize_t got = ::read(0, p, n);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) return false;
#endif
        p += got;
        n -= static_cast<size_t>(got);
    }
    return true;
}

void readerLoop(Inbox &inbox) {
    std::vector<unsigned char> payload;
    int carry = -1;  // an odd byte left over from the last AUDIO frame
    for (;;) {
        unsigned char head[5];
        if (!readFully(head, sizeof head)) break;
        const uint32_t len = static_cast<uint32_t>(head[1]) | (static_cast<uint32_t>(head[2]) << 8) |
                             (static_cast<uint32_t>(head[3]) << 16) | (static_cast<uint32_t>(head[4]) << 24);
        if (len > MAX_FRAME) {
            emitError(false, 0, "protocol", "A frame of " + std::to_string(len) + " bytes: the input has lost its framing.", true);
            std::fflush(stdout);
            std::_Exit(3);
        }
        payload.resize(len);
        if (len > 0 && !readFully(payload.data(), len)) break;

        Event e;
        switch (head[0]) {
        case F_START:
            e.kind = Event::START;
            e.json.assign(payload.begin(), payload.end());
            carry = -1;
            break;
        case F_AUDIO: {
            e.kind = Event::AUDIO;
            size_t i = 0;
            e.audio.reserve(len / 2 + 1);
            if (carry >= 0 && len > 0) {
                e.audio.push_back(static_cast<int16_t>(carry | (payload[0] << 8)) / 32768.0f);
                i = 1;
                carry = -1;
            }
            for (; i + 1 < len; i += 2)
                e.audio.push_back(static_cast<int16_t>(payload[i] | (payload[i + 1] << 8)) / 32768.0f);
            if (i < len) carry = payload[i];
            if (e.audio.empty()) continue;
            break;
        }
        case F_RESET: e.kind = Event::RESET; carry = -1; break;
        case F_STOP: e.kind = Event::STOP; carry = -1; break;
        default:
            emitError(false, 0, "protocol", "Unknown frame type " + std::to_string(head[0]) + "; skipped.", false);
            continue;
        }
        inbox.push(std::move(e));
    }
    Event end;
    end.kind = Event::END;
    inbox.push(std::move(end));
}

// ── Models ───────────────────────────────────────────────────────────────────

// Through stdio rather than whisper.cpp's own loader. Its loader opens a wide
// path only when built with MSVC; under mingw a model under C:\Users\José\
// would not open, and a user's name is not something to fail on.
FILE *openFile(const std::string &utf8) {
#ifdef _WIN32
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring wide(n > 0 ? static_cast<size_t>(n) : 1, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &wide[0], n);
    return _wfopen(wide.c_str(), L"rb");
#else
    return std::fopen(utf8.c_str(), "rb");
#endif
}

struct FileLoader {
    FILE *f = nullptr;
    whisper_model_loader loader{};

    explicit FileLoader(FILE *file) : f(file) {
        loader.context = this;
        loader.read = [](void *c, void *out, size_t n) { return std::fread(out, 1, n, static_cast<FileLoader *>(c)->f); };
        loader.eof = [](void *c) { return std::feof(static_cast<FileLoader *>(c)->f) != 0; };
        loader.close = [](void *c) {
            auto *self = static_cast<FileLoader *>(c);
            if (self->f) std::fclose(self->f);
            self->f = nullptr;
        };
    }
    ~FileLoader() {
        if (f) std::fclose(f);
    }
};

[[noreturn]] void modelFailure(const char *code, const std::string &message) {
    note("%s", message.c_str());
    emitError(false, 0, code, message, true);
    std::fflush(stdout);
    std::_Exit(2);
}

whisper_context *loadModel(const std::string &path) {
    FILE *f = openFile(path);
    if (!f) modelFailure("model-missing", "The speech model is missing: " + path);
    FileLoader fl(f);
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    whisper_context *ctx = whisper_init_with_params(&fl.loader, cp);
    if (!ctx) modelFailure("model-invalid", "The speech model could not be loaded: " + path);
    return ctx;
}

whisper_vad_context *loadVad(const std::string &path) {
    FILE *f = openFile(path);
    if (!f) modelFailure("vad-model-missing", "The voice-activity model is missing: " + path);
    FileLoader fl(f);
    whisper_vad_context_params vp = whisper_vad_default_context_params();
    // A 300 kB LSTM over 32 ms windows: one thread is plenty, and the others
    // are Whisper's.
    vp.n_threads = 1;
    vp.use_gpu = false;
    whisper_vad_context *vad = whisper_vad_init_with_params(&fl.loader, vp);
    if (!vad) modelFailure("vad-model-invalid", "The voice-activity model could not be loaded: " + path);
    return vad;
}

// ── The worker ───────────────────────────────────────────────────────────────

class Worker {
public:
    Worker(Inbox &inbox, whisper_context *ctx, whisper_vad_context *vad, int threads)
        : inbox_(inbox), ctx_(ctx), vad_(vad), threads_(threads) {}

    void run() {
        for (;;) {
            Event e;
            if (!inbox_.tryPop(e)) {
                // Caught up: the moment for an interim, if one is due.
                interim();
                e = inbox_.pop();
            }
            if (e.kind == Event::END) return;
            handle(e);
        }
    }

private:
    struct Transcript {
        std::string text;
        bool stale = false;
        double took = 0;
        int lang = -1;  // what Whisper detected, when it was left to; else -1
    };

    // A transcription in progress is abandoned the moment a control frame
    // arrives — the reader bumps the epoch — rather than finishing work whose
    // result would be thrown away anyway.
    struct Abort {
        const Inbox *inbox;
        uint64_t epoch;
    };

    void handle(Event &e) {
        switch (e.kind) {
        case Event::START: start(e.json); break;
        case Event::AUDIO: audio(e); break;
        case Event::RESET:
            // A retune: maybe to a station in another language.
            if (active_) clear();
            forgetLanguage();
            break;
        case Event::STOP:
            active_ = false;
            clear();
            forgetLanguage();
            break;
        case Event::END: break;
        }
    }

    void start(const std::string &json) {
        active_ = false;
        clear();
        StartRequest r = parseStart(json);
        const std::string code = whisperLanguage(r.lang);
        if (code != "auto") {
            const bool known = whisper_lang_id(code.c_str()) >= 0;
            const bool modelHasIt = whisper_is_multilingual(ctx_) || code == "en";
            if (!known || !modelHasIt) {
                emitError(r.hasSession, r.session, "language-not-supported",
                          "Whisper cannot recognise '" + r.lang + "' with this model.", true);
                return;
            }
        }
        session_ = r.session;
        hasSession_ = r.hasSession;
        lang_ = code;
        forgetLanguage();
        lastFinal_.clear();
        interimCost_ = 0;
        active_ = true;
        emit("{\"type\":\"started\",\"session\":" + sessionField(hasSession_, session_) + "}");
    }

    // Forget the utterance in progress and the VAD's memory of the audio.
    void clear() {
        seg_.reset();
        vadIn_.clear();
        whisper_vad_reset_state(vad_);
        interimMark_ = 0;
        lastInterim_.clear();
    }

    // "auto" settles on one language rather than leaving every utterance to
    // Whisper's detector, which on off-air audio is not steady: measured on an
    // English AM broadcast, three interims of one utterance came out English
    // and its final Welsh, looping.
    //
    // Only finals vote, each once, by the seconds of its utterance, and only
    // a final that was accepted as it decoded. Interims would count the same
    // audio again at every step of a growing utterance — two of them can
    // reach four seconds of votes off four seconds of speech — and they are
    // the cheapest decodes, on a shortened encoder, so the least reliable. A
    // language settles once it has two utterances, four seconds and twice the
    // votes of any other; from then on every decode uses it.
    //
    // A settled language is not taken on trust for ever: two finals in a row
    // that loop or come out empty under it — what Whisper does when told the
    // wrong language — unsettle it, and voting starts again. Otherwise it lasts
    // until a START, a RESET (a retune) or a STOP.
    struct Votes {
        double seconds = 0;
        int utterances = 0;
    };

    void forgetLanguage() {
        votes_.clear();
        settled_ = -1;
        failedUnderSettled_ = 0;
    }

    void vote(int id, double seconds) {
        if (id < 0) return;
        Votes &v = votes_[id];
        v.seconds += seconds;
        v.utterances++;
        int best = -1;
        double top = 0, second = 0;
        for (const auto &kv : votes_) {
            if (kv.second.seconds > top) {
                second = top;
                top = kv.second.seconds;
                best = kv.first;
            } else if (kv.second.seconds > second) {
                second = kv.second.seconds;
            }
        }
        if (best >= 0 && top >= 4.0 && top >= 2.0 * second && votes_[best].utterances >= 2) {
            settled_ = best;
            failedUnderSettled_ = 0;
            if (verbose) note("language settled: %s", whisper_lang_str(best));
        }
    }

    // A final's decode, for the settled language's sake: failed is true if it
    // failed the way a wrong language makes it fail.
    void judgeSettled(bool failed) {
        if (lang_ != "auto" || settled_ < 0) return;
        if (!failed) {
            failedUnderSettled_ = 0;
            return;
        }
        if (++failedUnderSettled_ < 2) return;
        if (verbose) note("language unsettled: %s, after two failed finals", whisper_lang_str(settled_));
        forgetLanguage();
    }

    void audio(Event &e) {
        if (!active_) return;
        if (e.gap) {
            // Audio was dropped just before this: what is in progress is cut
            // off and will not join up with what follows, so it is finished as
            // it stands and the VAD starts again.
            if (seg_.inSpeech()) finish(seg_.take());
            clear();
        }
        vadIn_.insert(vadIn_.end(), e.audio.begin(), e.audio.end());
        const int window = seg_.config().window;
        const size_t windows = vadIn_.size() / static_cast<size_t>(window);
        if (windows == 0) return;
        // Whole windows only: whisper.cpp pads a partial one with zeros, and
        // the VAD would hear a burst of silence in the middle of a word. The
        // no_reset form keeps the LSTM's state from one call to the next,
        // which is what makes it a stream.
        if (!whisper_vad_detect_speech_no_reset(vad_, vadIn_.data(), static_cast<int>(windows * window))) {
            note("the VAD failed on %zu samples; dropped", windows * window);
            vadIn_.erase(vadIn_.begin(), vadIn_.begin() + static_cast<long>(windows * window));
            return;
        }
        const float *probs = whisper_vad_probs(vad_);
        const int n = std::min(static_cast<int>(windows), whisper_vad_n_probs(vad_));
        // Copied, because finish() below can take long enough for a control
        // frame to arrive, and the rest of this audio is then stale.
        std::vector<float> p(probs, probs + n);
        for (int i = 0; i < n; i++) {
            switch (seg_.push(vadIn_.data() + static_cast<size_t>(i) * window, p[i])) {
            case Segmenter::STARTED:
                interimMark_ = 0;
                lastInterim_.clear();
                break;
            case Segmenter::ENDED: finish(seg_.take()); break;
            case Segmenter::NONE: break;
            }
            if (inbox_.epoch() != e.epoch) break;
        }
        vadIn_.erase(vadIn_.begin(), vadIn_.begin() + static_cast<long>(windows * window));
    }

    // An utterance has ended: its final transcript, if it has one worth
    // showing. An utterance whose final is rejected sends nothing — the page
    // has no way to withdraw an interim, and an empty final would settle the
    // interim as it stood (see localSegments.js foldResult); the next result
    // replaces it instead.
    //
    // A final that fails to decode — a loop, more words than the audio could
    // hold, nothing at all, or a third of the words its last interim had —
    // falls back on that interim, if it heard most of the utterance: it passed
    // the same checks, and the reader has been looking at it. Measured live on
    // small: a 20 s utterance whose interim had fifty words, and whose final
    // was "the".
    void finish(Utterance u) {
        const std::string interimText = lastInterim_;
        const size_t interimHeard = interimMark_;
        interimMark_ = 0;
        lastInterim_.clear();
        if (!u.enough) {
            if (verbose) note("%.2f s with %.2f s voiced: too little speech to transcribe", u.evidence.seconds, u.evidence.voicedSeconds);
            return;
        }
        Transcript t = transcribe(u.audio, false);
        if (t.stale) return;
        std::string text = cleanTranscript(t.text);
        const char *why = rejectTranscript(text, u.evidence, lastFinal_);
        if (verbose)
            note("final   %5.2f s audio, %.2f s voiced, p %.2f, %.1f dBFS -> %.2f s%s%s: %s", u.evidence.seconds,
                 u.evidence.voicedSeconds, u.evidence.meanProb, u.evidence.rmsDb, t.took, why ? " REJECTED " : "",
                 why ? why : "", t.text.c_str());
        const bool garbled = why && (!std::strcmp(why, "loop") || !std::strcmp(why, "too-many-words") || !std::strcmp(why, "empty"));
        const bool failed = why ? garbled : wordCount(text) * 3 < wordCount(interimText);
        // Only a final accepted as it decoded counts towards the language: not
        // one rejected, and not the interim it may fall back on below, which
        // is the cheaper decode.
        if (!why && !failed) vote(t.lang, u.evidence.seconds);
        judgeSettled(garbled);
        if (failed && !interimText.empty() && interimHeard * 2 >= u.audio.size()) {
            text = interimText;
            why = rejectTranscript(text, u.evidence, lastFinal_);
            if (verbose) note("final   settled on the last interim%s%s", why ? ", REJECTED " : "", why ? why : "");
        }
        if (why) return;
        lastFinal_ = normalise(text);
        result(text, true);
    }

    void interim() {
        if (!active_ || !seg_.inSpeech()) return;
        const size_t length = seg_.audio().size();
        const size_t due = std::max(INTERIM_EVERY, static_cast<size_t>(2.0 * interimCost_ * RATE));
        if (length < interimMark_ + due) return;
        if (seg_.voicedSamples() < static_cast<size_t>(RATE / 2)) return;
        // Already in a pause, the utterance is probably ending, and its final
        // will say more than an interim, sooner, without one in the way.
        if (seg_.pause() >= INTERIM_PAUSE) return;
        if (inbox_.backlog() > INTERIM_MAX_BACKLOG) return;
        interimMark_ = length;
        Transcript t = transcribe(seg_.audio(), true);
        interimCost_ = t.took;
        if (t.stale) return;
        const std::string text = cleanTranscript(t.text);
        const Evidence ev = seg_.evidence();
        const char *why = rejectTranscript(text, ev, lastFinal_);
        if (verbose)
            note("interim %5.2f s audio -> %.2f s%s%s: %s", ev.seconds, t.took, why ? " REJECTED " : "", why ? why : "",
                 t.text.c_str());
        if (why || text == lastInterim_) return;
        lastInterim_ = text;
        result(text, false);
    }

    void result(const std::string &text, bool final) {
        emit("{\"type\":\"result\",\"session\":" + sessionField(hasSession_, session_) + ",\"text\":" +
             jsonString(text) + ",\"final\":" + (final ? "true" : "false") + "}");
    }

    Transcript transcribe(const std::vector<float> &audio, bool interim) {
        Transcript t;
        // Measured from the event that brought this audio, not from now: a
        // control frame that arrived since makes it stale already.
        Abort abort{&inbox_, inbox_.epochTaken()};
        whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        p.n_threads = threads_;
        const bool detect = lang_ == "auto" && settled_ < 0;
        p.language = lang_ != "auto" ? lang_.c_str() : settled_ >= 0 ? whisper_lang_str(settled_) : "auto";
        p.detect_language = false;
        p.translate = false;
        // Each utterance on its own. Conditioning on the previous text is how
        // Whisper carries a hallucination from one window into the next, and
        // the utterances here are cut at pauses, so there is little context to
        // lose.
        p.no_context = true;
        p.no_timestamps = true;
        p.print_progress = false;
        p.print_realtime = false;
        p.print_special = false;
        p.print_timestamps = false;
        p.suppress_blank = true;
        p.suppress_nst = true;
        // No more tokens than the audio could hold. A loop otherwise runs on to
        // the context's end, costing a second or more of decoding for text that
        // is rejected anyway.
        const double seconds = static_cast<double>(audio.size()) / RATE;
        p.max_tokens = std::min(220, static_cast<int>(24 + 8 * seconds));
        if (interim) {
            // An interim is a preview that the final replaces, so it is bought
            // cheaply: the encoder sized to the audio instead of Whisper's full
            // 30 s (measured 2-3x faster on 5 s, with the same words), and no
            // temperature fallback.
            const int frames = static_cast<int>(audio.size() / 320) + 64;
            p.audio_ctx = std::min(1500, (frames + 63) / 64 * 64);
            p.temperature_inc = 0.0f;
        } else {
            // A fallback decodes again at a higher temperature; two candidates
            // rather than the default five keep it affordable.
            p.greedy.best_of = 2;
        }
        p.abort_callback = [](void *data) {
            const Abort *a = static_cast<const Abort *>(data);
            return a->inbox->epoch() != a->epoch;
        };
        p.abort_callback_user_data = &abort;

        const auto t0 = std::chrono::steady_clock::now();
        const int rc = whisper_full(ctx_, p, audio.data(), static_cast<int>(audio.size()));
        t.took = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        if (inbox_.epoch() != abort.epoch) {
            t.stale = true;
            return t;
        }
        if (rc != 0) {
            note("whisper_full failed (%d) on %.2f s of audio", rc, seconds);
            return t;
        }
        const int n = whisper_full_n_segments(ctx_);
        for (int i = 0; i < n; i++) {
            const char *s = whisper_full_get_segment_text(ctx_, i);
            if (s) t.text += s;
        }
        // A decode that heard nothing has no say in the language; finish()
        // decides whether this one does.
        if (detect && !interim && !cleanTranscript(t.text).empty()) t.lang = whisper_full_lang_id(ctx_);
        return t;
    }

    Inbox &inbox_;
    whisper_context *ctx_;
    whisper_vad_context *vad_;
    int threads_;

    bool active_ = false;
    long long session_ = 0;
    bool hasSession_ = false;
    std::string lang_ = "auto";

    Segmenter seg_;
    std::vector<float> vadIn_;  // audio not yet through the VAD: less than a window
    size_t interimMark_ = 0;     // the utterance's length at its last interim
    double interimCost_ = 0;     // what the last interim took, seconds
    std::string lastInterim_;
    std::string lastFinal_;  // normalised
    std::map<int, Votes> votes_;   // "auto": the finals behind each detected language
    int settled_ = -1;             // ...and the one settled on, or -1
    int failedUnderSettled_ = 0;   // finals in a row that failed under it
};

// ── CPU dispatch ─────────────────────────────────────────────────────────────
//
// ggml picks its x86 instructions when it is compiled, and the difference is not
// small: on base, a 5 s utterance took 1.3 s with AVX2 and 9 s without, which
// is the difference between keeping up and not. ggml's own answer — a CPU
// backend per instruction set, picked at run time — needs the backends as
// shared libraries (GGML_CPU_ALL_VARIANTS requires GGML_BACKEND_DL), and an
// AVX2 build on a CPU without AVX2 dies on its first instruction. So there are
// two static builds: this one, built for any x86-64, and whisper-helper-avx2
// beside it. This one checks the CPU first thing and, if the other can run,
// hands over to it; if not, or if it is missing, it carries on, slowly.
//
// macOS needs none of this: its universal binary carries an x86_64h slice for
// Haswell and later, and the kernel picks it.
#if defined(WHISPER_HELPER_DISPATCH) && (defined(__x86_64__) || defined(_M_X64))

bool cpuRunsAvx2Build() {
    unsigned a, b, c, d;
    if (!__get_cpuid(1, &a, &b, &c, &d)) return false;
    const bool fma = c & (1u << 12), osxsave = c & (1u << 27), avx = c & (1u << 28), f16c = c & (1u << 29);
    if (!(fma && osxsave && avx && f16c)) return false;
    // The OS must save the YMM registers across a context switch, or AVX is
    // there and unusable.
    unsigned lo, hi;
    __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
    if ((lo & 6) != 6) return false;
    if (__get_cpuid_max(0, nullptr) < 7) return false;
    __cpuid_count(7, 0, a, b, c, d);
    const bool avx2 = b & (1u << 5), bmi2 = b & (1u << 8);
    return avx2 && bmi2;
}

#ifdef _WIN32
// Windows has no exec, so the AVX2 build runs as a child of this one, sharing
// its standard handles, and this one waits and passes its exit code on. The job
// object takes the child down with this process: the client stops a helper by
// killing it, and the process it holds is this one.
int handOver() {
    wchar_t self[32768];
    DWORD n = GetModuleFileNameW(nullptr, self, 32768);
    if (n == 0 || n >= 32768) return -1;
    std::wstring path(self, n);
    size_t slash = path.find_last_of(L"\\/");
    std::wstring target = path.substr(0, slash + 1) + L"whisper-helper-avx2.exe";
    if (GetFileAttributesW(target.c_str()) == INVALID_FILE_ATTRIBUTES) return -1;

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
        std::memset(&info, 0, sizeof info);
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof info);
    }
    STARTUPINFOW si;
    std::memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    for (HANDLE h : {si.hStdInput, si.hStdOutput, si.hStdError})
        if (h && h != INVALID_HANDLE_VALUE) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    std::wstring cmd = GetCommandLineW();
    PROCESS_INFORMATION pi;
    // CREATE_NO_WINDOW: the client starts this process without a console (Node's
    // windowsHide), and a console program started from one that has none is
    // given a new, visible console window by Windows — an empty black window
    // for as long as the helper runs, which kills the helper if closed. The
    // child needs only the pipes it inherits. Wine gives it no window either
    // way, so this is one thing the tests there cannot catch.
    if (!CreateProcessW(target.c_str(), &cmd[0], nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                        nullptr, &si, &pi))
        return -1;
    if (job) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    std::_Exit(static_cast<int>(code));
}
#else
// exec, so the client's child *is* the AVX2 build: same pid, same pipes.
int handOver(char **argv) {
    char self[4096];
    ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
    if (n <= 0) return -1;
    std::string path(self, static_cast<size_t>(n));
    std::string target = path.substr(0, path.find_last_of('/') + 1) + "whisper-helper-avx2";
    if (access(target.c_str(), X_OK) != 0) return -1;
    execv(target.c_str(), argv);
    return -1;  // only on failure
}
#endif

void dispatch(char **argv) {
    // For tests, and for anyone chasing a fault in the AVX2 build.
    const char *force = std::getenv("WHISPER_HELPER_VARIANT");
    if (force && std::strcmp(force, "baseline") == 0) return;
    // The client's language probe: a list either build prints the same, so not
    // worth a second process. --version still hands over, to name the build
    // that would really run.
    for (int i = 1; argv[i]; i++)
        if (std::strcmp(argv[i], "--languages") == 0) return;
    if (!cpuRunsAvx2Build()) return;
#ifdef _WIN32
    (void)argv;
    handOver();
#else
    handOver(argv);
#endif
    note("this CPU has AVX2 but whisper-helper-avx2 did not start; carrying on without it, much more slowly");
}

#endif

// ── Arguments ────────────────────────────────────────────────────────────────

// The command line as UTF-8. On Windows main()'s argv is in the ANSI code page,
// which mangles a model path under a user's home with the wrong name in it.
std::vector<std::string> arguments(int argc, char **argv) {
    std::vector<std::string> out;
#ifdef _WIN32
    (void)argc;
    (void)argv;
    int n = 0;
    LPWSTR *w = CommandLineToArgvW(GetCommandLineW(), &n);
    for (int i = 0; w && i < n; i++) {
        int len = WideCharToMultiByte(CP_UTF8, 0, w[i], -1, nullptr, 0, nullptr, nullptr);
        std::string s(len > 0 ? static_cast<size_t>(len) : 1, '\0');
        if (len > 0) WideCharToMultiByte(CP_UTF8, 0, w[i], -1, &s[0], len, nullptr, nullptr);
        s.resize(std::strlen(s.c_str()));
        out.push_back(s);
    }
    if (w) LocalFree(w);
#else
    for (int i = 0; i < argc; i++) out.emplace_back(argv[i]);
#endif
    return out;
}

int usage() {
    std::fprintf(stderr,
                 "usage: whisper-helper --model PATH --vad-model PATH [--threads N] [--verbose]\n"
                 "       whisper-helper --languages\n"
                 "       whisper-helper --version\n");
    return 1;
}

int defaultThreads() {
    // Bounded: this runs beside a receiver, a browser engine and whatever else
    // the machine is for, and beyond four threads Whisper's encoder gains
    // little for the cores it takes.
    const unsigned hw = std::thread::hardware_concurrency();
    if (hw <= 1) return 1;
    return static_cast<int>(std::min(4u, hw - 1));
}

}  // namespace

int main(int argc, char **argv) {
#if defined(WHISPER_HELPER_DISPATCH) && (defined(__x86_64__) || defined(_M_X64))
    dispatch(argv);
#endif
#ifdef _WIN32
    // Binary pipes: the frames are binary, and text mode would turn every
    // "\n" written into "\r\n".
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    whisper_log_set(onLog, nullptr);

    const std::vector<std::string> args = arguments(argc, argv);
    std::string model, vadModel;
    int threads = 0;
    for (size_t i = 1; i < args.size(); i++) {
        const std::string &a = args[i];
        const bool hasValue = i + 1 < args.size();
        if (a == "--version") {
            std::printf("whisper-helper %s (whisper.cpp %s %s, %s)\n", HELPER_VERSION, whisper_version(),
                        WHISPER_CPP_COMMIT, WHISPER_HELPER_VARIANT);
            return 0;
        } else if (a == "--languages") {
            std::string out = "[";
            for (int id = 0; id <= whisper_lang_max_id(); id++) {
                if (id) out += ",";
                out += jsonString(whisper_lang_str(id));
            }
            std::printf("%s]\n", out.c_str());
            return 0;
        } else if (a == "--model" && hasValue) {
            model = args[++i];
        } else if (a == "--vad-model" && hasValue) {
            vadModel = args[++i];
        } else if (a == "--threads" && hasValue) {
            threads = std::atoi(args[++i].c_str());
            if (threads < 1) return usage();
        } else if (a == "--verbose") {
            verbose = true;
        } else {
            return usage();
        }
    }
    if (model.empty() || vadModel.empty()) return usage();
    if (threads == 0) threads = defaultThreads();

    // Reading starts before the models load, so audio sent meanwhile waits in
    // the inbox rather than in a pipe that would fill in two seconds.
    Inbox inbox;
    std::thread reader(readerLoop, std::ref(inbox));

    const auto t0 = std::chrono::steady_clock::now();
    whisper_vad_context *vad = loadVad(vadModel);
    whisper_context *ctx = loadModel(model);
    note("ready: %s, %d threads, %s build, loaded in %.2f s", whisper_is_multilingual(ctx) ? "multilingual" : "English only",
         threads, WHISPER_HELPER_VARIANT,
         std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    emit("{\"type\":\"ready\"}");

    Worker(inbox, ctx, vad, threads).run();

    reader.join();
    whisper_free(ctx);
    whisper_vad_free(vad);
    return 0;
}
