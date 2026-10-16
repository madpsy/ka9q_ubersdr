// whisper_session.cpp — see whisper_session.h.
#include "whisper_session.h"

#include <algorithm>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "whisper.h"

namespace whisperhelper {

namespace {

// An interim waits for this much new audio at least, and for twice what the
// last one took, so interims never take more than half the time between them.
constexpr size_t INTERIM_EVERY = RATE * 2;
// ...and is skipped while this much audio is waiting: the final matters more.
constexpr size_t INTERIM_MAX_BACKLOG = RATE / 2;
// ...and while the speaker has been quiet for this long.
constexpr int INTERIM_PAUSE = RATE * 3 / 10;

std::string sessionField(bool has, long long session) {
    return has ? std::to_string(session) : std::string("null");
}

}  // namespace

Session::Session(whisper_context *ctx, whisper_vad_context *vad, SessionConfig cfg, SessionHost &host, bool verbose)
    : ctx_(ctx), vad_(vad), cfg_(cfg), host_(host), verbose_(verbose) {}

void Session::say(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    host_.note(buf);
}

void Session::emitError(const char *code, const std::string &message, bool fatal) {
    host_.emit(std::string("{\"type\":\"error\",\"session\":") + sessionField(hasSession_, session_) +
               ",\"code\":" + jsonString(code) + ",\"message\":" + jsonString(message) +
               ",\"fatal\":" + (fatal ? "true" : "false") + "}");
}

void Session::start(const std::string &json) {
    active_ = false;
    clear();
    StartRequest r = parseStart(json);
    const std::string code = whisperLanguage(r.lang);
    // Reported against the session asked for, whether or not it starts.
    session_ = r.session;
    hasSession_ = r.hasSession;
    if (code != "auto") {
        const bool known = whisper_lang_id(code.c_str()) >= 0;
        const bool modelHasIt = whisper_is_multilingual(ctx_) || code == "en";
        if (!known || !modelHasIt) {
            emitError("language-not-supported", "Whisper cannot recognise '" + r.lang + "' with this model.", true);
            return;
        }
    }
    lang_ = code;
    forgetLanguage();
    lastFinal_.clear();
    interimCost_ = 0;
    active_ = true;
    host_.emit("{\"type\":\"started\",\"session\":" + sessionField(hasSession_, session_) + "}");
}

void Session::reset() {
    // A retune: maybe to a station in another language.
    if (active_) clear();
    forgetLanguage();
}

void Session::stop() {
    active_ = false;
    clear();
    forgetLanguage();
}

// Forget the utterance in progress and the VAD's memory of the audio.
void Session::clear() {
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
void Session::forgetLanguage() {
    votes_.clear();
    settled_ = -1;
    failedUnderSettled_ = 0;
}

void Session::vote(int id, double seconds) {
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
        if (verbose_) say("language settled: %s", whisper_lang_str(best));
    }
}

// A final's decode, for the settled language's sake: failed is true if it
// failed the way a wrong language makes it fail.
void Session::judgeSettled(bool failed) {
    if (lang_ != "auto" || settled_ < 0) return;
    if (!failed) {
        failedUnderSettled_ = 0;
        return;
    }
    if (++failedUnderSettled_ < 2) return;
    if (verbose_) say("language unsettled: %s, after two failed finals", whisper_lang_str(settled_));
    forgetLanguage();
}

void Session::audio(const float *samples, size_t n, bool gap) {
    if (!active_) return;
    if (gap) {
        // Audio was dropped just before this: what is in progress is cut
        // off and will not join up with what follows, so it is finished as
        // it stands and the VAD starts again.
        if (seg_.inSpeech()) finish(seg_.take());
        clear();
    }
    vadIn_.insert(vadIn_.end(), samples, samples + n);
    const int window = seg_.config().window;
    const size_t windows = vadIn_.size() / static_cast<size_t>(window);
    if (windows == 0) return;
    // Whole windows only: whisper.cpp pads a partial one with zeros, and
    // the VAD would hear a burst of silence in the middle of a word. The
    // no_reset form keeps the LSTM's state from one call to the next,
    // which is what makes it a stream.
    if (!whisper_vad_detect_speech_no_reset(vad_, vadIn_.data(), static_cast<int>(windows * window))) {
        say("the VAD failed on %zu samples; dropped", windows * window);
        vadIn_.erase(vadIn_.begin(), vadIn_.begin() + static_cast<long>(windows * window));
        return;
    }
    const float *probs = whisper_vad_probs(vad_);
    const int count = std::min(static_cast<int>(windows), whisper_vad_n_probs(vad_));
    // Copied, because finish() below can take long enough for a control
    // frame to arrive, and the rest of this audio is then stale.
    std::vector<float> p(probs, probs + count);
    for (int i = 0; i < count; i++) {
        switch (seg_.push(vadIn_.data() + static_cast<size_t>(i) * window, p[i])) {
        case Segmenter::STARTED:
            interimMark_ = 0;
            lastInterim_.clear();
            break;
        case Segmenter::ENDED: finish(seg_.take()); break;
        case Segmenter::NONE: break;
        }
        if (host_.superseded()) break;
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
// hold, nothing at all, a third of the words its last interim had, or over
// its time budget — falls back on that interim, if it heard most of the
// utterance: it passed the same checks, and the reader has been looking at
// it. Measured live on small: a 20 s utterance whose interim had fifty
// words, and whose final was "the".
void Session::finish(Utterance u) {
    const std::string interimText = lastInterim_;
    const size_t interimHeard = interimMark_;
    interimMark_ = 0;
    lastInterim_.clear();
    if (!u.enough) {
        if (verbose_) say("%.2f s with %.2f s voiced: too little speech to transcribe", u.evidence.seconds, u.evidence.voicedSeconds);
        return;
    }
    Transcript t = transcribe(u.audio, false);
    if (t.stale) return;
    std::string text = cleanTranscript(t.text);
    const char *why = t.overBudget ? "over-budget" : rejectTranscript(text, u.evidence, lastFinal_);
    if (verbose_)
        say("final   %5.2f s audio, %.2f s voiced, p %.2f, %.1f dBFS -> %.2f s%s%s: %s", u.evidence.seconds,
            u.evidence.voicedSeconds, u.evidence.meanProb, u.evidence.rmsDb, t.took, why ? " REJECTED " : "",
            why ? why : "", t.text.c_str());
    const bool garbled = why && (!std::strcmp(why, "loop") || !std::strcmp(why, "too-many-words") ||
                                 !std::strcmp(why, "empty") || !std::strcmp(why, "over-budget"));
    const bool failed = why ? garbled : wordCount(text) * 3 < wordCount(interimText);
    // Only a final accepted as it decoded counts towards the language: not
    // one rejected, and not the interim it may fall back on below, which
    // is the cheaper decode.
    if (!why && !failed) vote(t.lang, u.evidence.seconds);
    judgeSettled(garbled);
    if (failed && !interimText.empty() && interimHeard * 2 >= u.audio.size()) {
        text = interimText;
        why = rejectTranscript(text, u.evidence, lastFinal_);
        if (verbose_) say("final   settled on the last interim%s%s", why ? ", REJECTED " : "", why ? why : "");
    }
    if (why) return;
    lastFinal_ = normalise(text);
    result(text, true);
}

void Session::interim() {
    if (!active_ || !seg_.inSpeech()) return;
    const size_t length = seg_.audio().size();
    const size_t due = std::max(INTERIM_EVERY, static_cast<size_t>(2.0 * interimCost_ * RATE));
    if (length < interimMark_ + due) return;
    if (seg_.voicedSamples() < static_cast<size_t>(RATE / 2)) return;
    // Already in a pause, the utterance is probably ending, and its final
    // will say more than an interim, sooner, without one in the way.
    if (seg_.pause() >= INTERIM_PAUSE) return;
    if (host_.backlog() > INTERIM_MAX_BACKLOG) return;
    interimMark_ = length;
    Transcript t = transcribe(seg_.audio(), true);
    interimCost_ = t.took;
    if (t.stale) return;
    const std::string text = cleanTranscript(t.text);
    const Evidence ev = seg_.evidence();
    const char *why = rejectTranscript(text, ev, lastFinal_);
    if (verbose_)
        say("interim %5.2f s audio -> %.2f s%s%s: %s", ev.seconds, t.took, why ? " REJECTED " : "", why ? why : "",
            t.text.c_str());
    if (why || text == lastInterim_) return;
    lastInterim_ = text;
    result(text, false);
}

void Session::result(const std::string &text, bool final) {
    host_.emit("{\"type\":\"result\",\"session\":" + sessionField(hasSession_, session_) + ",\"text\":" +
               jsonString(text) + ",\"final\":" + (final ? "true" : "false") + "}");
}

namespace {

// What whisper_full's abort callback weighs: a control event arriving, which
// makes the work stale, or a final running past its budget.
struct Abort {
    const SessionHost *host;
    std::chrono::steady_clock::time_point deadline;
    bool limited = false;
    bool overBudget = false;
};

}  // namespace

Session::Transcript Session::transcribe(const std::vector<float> &audio, bool interim) {
    Transcript t;
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = cfg_.threads;
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
    // The encoder sized to the audio instead of Whisper's full 30 s: always
    // for an interim (measured 2-3x faster on 5 s natively, with the same
    // words), and for a final where the config says so (see sizedFinals).
    if (interim || cfg_.sizedFinals) {
        const int frames = static_cast<int>(audio.size() / 320) + 64;
        p.audio_ctx = std::min(1500, (frames + 63) / 64 * 64);
    }
    if (interim) {
        // An interim is a preview that the final replaces, so it is bought
        // cheaply: no temperature fallback.
        p.temperature_inc = 0.0f;
    } else {
        // A fallback decodes again at a higher temperature; two candidates
        // rather than the default five keep it affordable.
        p.greedy.best_of = 2;
    }
    const auto t0 = std::chrono::steady_clock::now();
    Abort abort{&host_, t0};
    if (!interim && cfg_.finalBudget > 0) {
        abort.limited = true;
        abort.deadline = t0 + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                  std::chrono::duration<double>(std::max(cfg_.finalBudgetFloor, cfg_.finalBudget * seconds)));
    }
    p.abort_callback = [](void *data) {
        Abort *a = static_cast<Abort *>(data);
        if (a->host->superseded()) return true;
        if (a->limited && std::chrono::steady_clock::now() > a->deadline) {
            a->overBudget = true;
            return true;
        }
        return false;
    };
    p.abort_callback_user_data = &abort;

    const int rc = whisper_full(ctx_, p, audio.data(), static_cast<int>(audio.size()));
    t.took = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    if (host_.superseded()) {
        t.stale = true;
        return t;
    }
    if (abort.overBudget) {
        t.overBudget = true;
        return t;
    }
    if (rc != 0) {
        say("whisper_full failed (%d) on %.2f s of audio", rc, seconds);
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

}  // namespace whisperhelper
