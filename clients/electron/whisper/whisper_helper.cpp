// whisper_helper.cpp — on-device speech-to-text for the desktop client, as a
// child process.
//
//   whisper-helper --model PATH --vad-model PATH [--threads N] [--sized-finals] [--verbose]
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
// runs a Session (whisper_session.cpp, shared with the browser's WebAssembly
// build in wasm/) over everything that arrives: the VAD, each utterance
// transcribed as it ends (whisper_core.cpp decides where that is), and an
// interim transcript of the utterance in progress every two seconds of new
// speech when it can afford one. If it falls more than ten seconds behind, the
// oldest audio is dropped rather than letting the delay grow without bound.
//
// --sized-finals transcribes finals with Whisper's encoder sized to the
// utterance, as interims are, instead of its full 30 s window: several times
// cheaper, and what the browser build does. Off by default until it has been
// weighed on off-air audio against the full window (test/ab.js).
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
#include "whisper_session.h"

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

    size_t backlog() const {
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

    mutable std::mutex lock_;
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

// ── The session ──────────────────────────────────────────────────────────────

// What a Session needs, from the inbox: whisper_session.cpp is the whole of
// what happens to the audio, shared with the browser's WebAssembly build.
class InboxHost : public SessionHost {
public:
    explicit InboxHost(Inbox &inbox) : inbox_(inbox) {}
    void emit(const std::string &line) override { ::emit(line); }
    void note(const std::string &text) override { ::note("%s", text.c_str()); }
    // A control frame has arrived since the event in hand was taken: the
    // reader bumps the epoch, so a decode in progress is abandoned the moment
    // one does rather than finishing work whose result would be thrown away.
    bool superseded() const override { return inbox_.epoch() != inbox_.epochTaken(); }
    size_t backlog() const override { return inbox_.backlog(); }

private:
    Inbox &inbox_;
};

void run(Inbox &inbox, Session &session) {
    for (;;) {
        Event e;
        if (!inbox.tryPop(e)) {
            // Caught up: the moment for an interim, if one is due.
            session.interim();
            e = inbox.pop();
        }
        switch (e.kind) {
        case Event::START: session.start(e.json); break;
        case Event::AUDIO: session.audio(e.audio.data(), e.audio.size(), e.gap); break;
        case Event::RESET: session.reset(); break;
        case Event::STOP: session.stop(); break;
        case Event::END: return;
        }
    }
}

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
                 "usage: whisper-helper --model PATH --vad-model PATH [--threads N] [--sized-finals] [--verbose]\n"
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
    SessionConfig cfg;
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
        } else if (a == "--sized-finals") {
            cfg.sizedFinals = true;
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
    note("ready: %s, %d threads, %s build, %s finals, loaded in %.2f s",
         whisper_is_multilingual(ctx) ? "multilingual" : "English only", threads, WHISPER_HELPER_VARIANT,
         cfg.sizedFinals ? "sized" : "full-window",
         std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    emit("{\"type\":\"ready\"}");

    cfg.threads = threads;
    InboxHost host(inbox);
    Session session(ctx, vad, cfg, host, verbose.load());
    run(inbox, session);

    reader.join();
    whisper_free(ctx);
    whisper_vad_free(vad);
    return 0;
}
