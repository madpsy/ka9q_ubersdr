// whisper_session.h — one recognising session: audio in, transcripts out.
//
// Everything between the audio arriving and a line going back to the page:
// the VAD cutting the audio into utterances, an interim transcript of the one in
// progress when it can be afforded, the final when it ends, the filter that
// keeps Whisper talking to itself off the screen, and settling on a language
// when it was left to Whisper. whisper_core.cpp holds the judgements that need
// no model; this holds the ones that drive whisper.cpp.
//
// Two programs are built around it:
//
//   whisper_helper.cpp   the desktop client's helper, a native process: one
//                        thread reads frames off stdin into an inbox, another
//                        runs this session over them.
//   wasm/whisper_wasm.cpp
//                        the same session compiled to WebAssembly for the v2
//                        page in a browser, in a Web Worker, fed by
//                        static/v2/src/extensions/whisper/engines/wasm.js.
//
// Neither owns any of the behaviour here, so a fix to how utterances are cut or
// which transcripts are dropped reaches both. What differs between them — the
// queue, whether a decode can be abandoned mid-way, how many threads, how big
// Whisper's window — is what SessionHost and SessionConfig carry.
#pragma once

#include <cstddef>
#include <map>
#include <string>
#include <vector>

#include "whisper_core.h"

struct whisper_context;
struct whisper_vad_context;

namespace whisperhelper {

struct SessionConfig {
    int threads = 1;
    // A final transcribed with Whisper's encoder sized to the utterance, as an
    // interim always is, rather than over its full 30 s window. The full window
    // is what Whisper was trained on; sized is several times cheaper — measured
    // in WebAssembly, 5 to 15 times on 5 s utterances — and is what makes a
    // browser keep up at all. Off for the helper unless --sized-finals.
    bool sizedFinals = false;
    // A final may take at most this many seconds per second of its audio, and
    // never less than finalBudgetFloor seconds, before it is abandoned and
    // finish() falls back on the interim, as it does for any final that fails.
    // A loop that every temperature fallback repeats was measured taking 29 s
    // over 5 s of audio in a browser. 0: no limit.
    double finalBudget = 0;
    double finalBudgetFloor = 2.0;
};

// What a session needs from the program around it.
class SessionHost {
public:
    virtual ~SessionHost() = default;
    // One protocol line: a JSON object, without the newline.
    virtual void emit(const std::string &line) = 0;
    // A line for people, about what the session is doing.
    virtual void note(const std::string &text) = 0;
    // True once a control event — START, RESET, STOP — has arrived that the
    // session has not handled yet: the work in hand is stale, and a decode is
    // abandoned. A host that cannot tell while a decode runs says false.
    virtual bool superseded() const = 0;
    // Audio waiting to be handed to the session, in samples.
    virtual size_t backlog() const = 0;
};

class Session {
public:
    Session(whisper_context *ctx, whisper_vad_context *vad, SessionConfig cfg, SessionHost &host, bool verbose);

    // START's JSON payload: {"lang": "...", "session": n}.
    void start(const std::string &json);
    // 16 kHz mono. `gap`: audio was dropped just before this.
    void audio(const float *samples, size_t n, bool gap);
    // RESET: a retune.
    void reset();
    // STOP.
    void stop();
    // The host has nothing waiting: the moment for an interim, if one is due.
    void interim();

    const SessionConfig &config() const { return cfg_; }

private:
    struct Transcript {
        std::string text;
        bool stale = false;
        bool overBudget = false;
        double took = 0;
        int lang = -1;  // what Whisper detected, when it was left to; else -1
    };

    struct Votes {
        double seconds = 0;
        int utterances = 0;
    };

    void say(const char *fmt, ...);
    void emitError(const char *code, const std::string &message, bool fatal);
    void clear();
    void forgetLanguage();
    void vote(int id, double seconds);
    void judgeSettled(bool failed);
    void finish(Utterance u);
    void result(const std::string &text, bool final);
    Transcript transcribe(const std::vector<float> &audio, bool interim);

    whisper_context *ctx_;
    whisper_vad_context *vad_;
    SessionConfig cfg_;
    SessionHost &host_;
    bool verbose_;

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

}  // namespace whisperhelper
