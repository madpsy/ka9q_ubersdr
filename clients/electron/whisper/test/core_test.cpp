// core_test.cpp — the helper's decisions, natively, with no model.
//
//   g++ -std=c++17 -I.. core_test.cpp ../whisper_core.cpp -o core_test && ./core_test
//
// run.sh beside this does exactly that. What it cannot reach is whisper.cpp
// itself and the process around it; helper.test.js drives the real binary.
#include "whisper_core.h"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace whisperhelper;

namespace {

int failures = 0;
int passes = 0;

#define CHECK(cond)                                                                   \
    do {                                                                              \
        if (!(cond)) {                                                                \
            std::printf("      %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
            ok = false;                                                               \
        }                                                                             \
    } while (0)

struct Test {
    const char *name;
    bool (*fn)();
};
std::vector<Test> &tests() {
    static std::vector<Test> t;
    return t;
}
struct Register {
    Register(const char *name, bool (*fn)()) { tests().push_back({name, fn}); }
};
#define TEST(name)                                  \
    bool name();                                    \
    Register reg_##name(#name, name);               \
    bool name()

// Feeds `seconds` of windows at probability `p`, of a constant `level`;
// returns the events seen.
std::vector<Segmenter::Event> feed(Segmenter &s, double seconds, float p, float level = 0.1f,
                                   std::vector<Utterance> *taken = nullptr) {
    std::vector<Segmenter::Event> out;
    const int w = s.config().window;
    std::vector<float> win(static_cast<size_t>(w), level);
    const int n = static_cast<int>(std::lround(seconds * RATE / w));
    for (int i = 0; i < n; i++) {
        Segmenter::Event e = s.push(win.data(), p);
        if (e != Segmenter::NONE) out.push_back(e);
        if (e == Segmenter::ENDED) {
            Utterance u = s.take();
            if (taken) taken->push_back(std::move(u));
        }
    }
    return out;
}

Evidence strong(double seconds) {
    Evidence ev;
    ev.seconds = seconds;
    ev.voicedSeconds = seconds * 0.9;
    ev.meanProb = 0.95;
    ev.rmsDb = -20;
    return ev;
}

Evidence weak(double seconds) {
    Evidence ev = strong(seconds);
    ev.rmsDb = -45;
    ev.meanProb = 0.6;
    return ev;
}

// ── The wire ─────────────────────────────────────────────────────────────────

TEST(json_escapes_and_repairs_utf8) {
    bool ok = true;
    CHECK(jsonString("a\"b\\c\n") == "\"a\\\"b\\\\c\\n\"");
    CHECK(jsonString(std::string("\x01", 1)) == "\"\\u0001\"");
    CHECK(jsonString("caf\xc3\xa9") == "\"caf\xc3\xa9\"");
    // A token boundary inside a character: the stray bytes become U+FFFD.
    CHECK(jsonString("x\xe4\xb8") == "\"x\xef\xbf\xbd\xef\xbf\xbd\"");
    CHECK(jsonString("\xc0\xaf") == "\"\xef\xbf\xbd\xef\xbf\xbd\"");  // overlong '/'
    CHECK(jsonString("\xe2\x80\xa8") == "\"\\u2028\"");
    return ok;
}

TEST(start_payload) {
    bool ok = true;
    StartRequest r = parseStart("{\"lang\":\"de\",\"session\":42}");
    CHECK(r.lang == "de" && r.session == 42 && r.hasSession);
    r = parseStart("{ \"session\" : 7 , \"lang\" : \"auto\" }");
    CHECK(r.lang == "auto" && r.session == 7);
    r = parseStart("{}");
    CHECK(r.lang.empty() && !r.hasSession);
    return ok;
}

TEST(language_codes) {
    bool ok = true;
    CHECK(whisperLanguage("en") == "en");
    CHECK(whisperLanguage("en-GB") == "en");
    CHECK(whisperLanguage("zh-Hant") == "zh");
    CHECK(whisperLanguage("pt_BR") == "pt");
    CHECK(whisperLanguage("") == "auto");
    CHECK(whisperLanguage("AUTO") == "auto");
    CHECK(whisperLanguage("nb") == "no");
    CHECK(whisperLanguage("jv") == "jw");
    CHECK(whisperLanguage("iw") == "he");
    CHECK(languageTag("jw") == "jv");
    CHECK(languageTag("en") == "en");
    CHECK(languageTag("YUE") == "yue");
    // A round trip lands on the code it started from.
    CHECK(whisperLanguage(languageTag("jw")) == "jw");
    return ok;
}

// ── Utterances ───────────────────────────────────────────────────────────────

TEST(segmenter_ends_on_a_pause_with_preroll_and_tail) {
    bool ok = true;
    Segmenter s;
    const SegmenterConfig &c = s.config();
    std::vector<Utterance> u;
    feed(s, 1.0, 0.05f, 0.001f, &u);
    std::vector<Segmenter::Event> e = feed(s, 2.0, 0.9f, 0.1f, &u);
    CHECK(e.size() == 1 && e[0] == Segmenter::STARTED);
    CHECK(s.inSpeech());
    e = feed(s, 0.5, 0.05f, 0.001f, &u);  // shorter than the end pause
    CHECK(e.empty() && s.inSpeech());
    e = feed(s, 0.5, 0.05f, 0.001f, &u);
    CHECK(e.size() == 1 && e[0] == Segmenter::ENDED);
    CHECK(u.size() == 1);
    if (u.size() == 1) {
        // pre-roll (whole windows' worth of it) + 2 s of speech + the tail pad
        const double secs = static_cast<double>(u[0].audio.size()) / RATE;
        const double want = (c.preRoll + 2 * RATE + c.tailPad) / static_cast<double>(RATE);
        CHECK(std::fabs(secs - want) < 0.07);
        CHECK(u[0].enough);
        CHECK(std::fabs(u[0].evidence.voicedSeconds - 2.0) < 0.05);
        CHECK(std::fabs(u[0].evidence.rmsDb - 20 * std::log10(0.1)) < 0.1);
        CHECK(std::fabs(u[0].evidence.meanProb - 0.9) < 1e-3);
    }
    return ok;
}

TEST(segmenter_hysteresis_keeps_a_dip) {
    bool ok = true;
    Segmenter s;
    std::vector<Utterance> u;
    feed(s, 1.0, 0.9f, 0.1f, &u);
    // Below the onset threshold but above the release one: still speech.
    std::vector<Segmenter::Event> e = feed(s, 2.0, 0.4f, 0.1f, &u);
    CHECK(e.empty() && s.inSpeech());
    return ok;
}

TEST(segmenter_cuts_long_speech) {
    bool ok = true;
    Segmenter s;
    std::vector<Utterance> u;
    std::vector<Segmenter::Event> e = feed(s, 21.0, 0.9f, 0.1f, &u);
    CHECK(u.size() == 1);
    if (!u.empty()) CHECK(u[0].audio.size() <= static_cast<size_t>(s.config().maxLength + s.config().window));
    // Speech carries on: a new utterance at once.
    CHECK(s.inSpeech());
    return ok;
}

TEST(segmenter_takes_a_shorter_pause_once_long) {
    bool ok = true;
    Segmenter s;
    std::vector<Utterance> u;
    feed(s, 16.0, 0.9f, 0.1f, &u);
    CHECK(u.empty());
    feed(s, 0.3, 0.05f, 0.001f, &u);  // past softSilence, short of endSilence
    CHECK(u.size() == 1);
    return ok;
}

TEST(segmenter_flags_a_click) {
    bool ok = true;
    Segmenter s;
    std::vector<Utterance> u;
    feed(s, 0.1, 0.9f, 0.1f, &u);
    feed(s, 1.0, 0.05f, 0.001f, &u);
    CHECK(u.size() == 1);
    if (!u.empty()) CHECK(!u[0].enough);
    return ok;
}

TEST(segmenter_reset_forgets_everything) {
    bool ok = true;
    Segmenter s;
    std::vector<Utterance> u;
    feed(s, 1.0, 0.05f, 0.5f, &u);
    feed(s, 1.0, 0.9f, 0.1f, &u);
    s.reset();
    CHECK(!s.inSpeech() && s.audio().empty());
    feed(s, 0.064, 0.9f, 0.1f, &u);
    // No pre-roll from before the reset: the new utterance is just its windows.
    CHECK(s.audio().size() == static_cast<size_t>(2 * s.config().window));
    return ok;
}

// ── Transcripts ──────────────────────────────────────────────────────────────

TEST(clean_strips_annotations) {
    bool ok = true;
    CHECK(cleanTranscript(" Hello  world ") == "Hello world");
    CHECK(cleanTranscript("[Music]").empty());
    CHECK(cleanTranscript("(upbeat music) Good morning.") == "Good morning.");
    CHECK(cleanTranscript("\xe2\x99\xaa la la \xe2\x99\xaa") == "la la");
    CHECK(cleanTranscript("...").empty());
    CHECK(cleanTranscript(" - ").empty());
    CHECK(cleanTranscript("\xef\xbc\x88\xe5\xad\x97\xe5\xb9\x95\xef\xbc\x89").empty());  // （字幕）
    CHECK(cleanTranscript("an open (paren") == "an open (paren");
    CHECK(cleanTranscript("\xe4\xbd\xa0\xe5\xa5\xbd") == "\xe4\xbd\xa0\xe5\xa5\xbd");
    return ok;
}

TEST(normalise_for_comparison) {
    bool ok = true;
    CHECK(normalise("Thank you!") == "thank you");
    CHECK(normalise("  Don't   stop. ") == "dont stop");
    CHECK(normalise("Caf\xc3\xa9, s'il vous pla\xc3\xaet") == "caf\xc3\xa9 sil vous pla\xc3\xaet");
    CHECK(normalise("\xe8\xb0\xa2\xe8\xb0\xa2\xe3\x80\x82") == "\xe8\xb0\xa2\xe8\xb0\xa2");
    return ok;
}

TEST(word_count) {
    bool ok = true;
    CHECK(wordCount("Hello, world!") == 2);
    CHECK(wordCount("") == 0);
    CHECK(wordCount("\xe4\xbd\xa0\xe5\xa5\xbd\xe4\xb8\x96\xe7\x95\x8c") == 2);  // four characters
    return ok;
}

TEST(reject_silence_phrases_only_on_weak_evidence) {
    bool ok = true;
    CHECK(rejectTranscript("Thank you.", weak(1.0), "") != nullptr);
    CHECK(rejectTranscript("Thanks for watching!", weak(2.0), "") != nullptr);
    CHECK(rejectTranscript("you", weak(1.0), "") != nullptr);
    // Clearly spoken, it stays.
    CHECK(rejectTranscript("Thank you.", strong(1.0), "") == nullptr);
    // A real sentence on weak evidence is not judged by the phrase list.
    CHECK(rejectTranscript("The wind is from the west.", weak(2.0), "") == nullptr);
    return ok;
}

TEST(reject_credits_in_a_short_line) {
    bool ok = true;
    CHECK(rejectTranscript("Subtitles by the Amara.org community", strong(3.0), "") != nullptr);
    CHECK(rejectTranscript("Sous-titres réalisés par la communauté d'Amara.org", strong(3.0), "") != nullptr);
    CHECK(rejectTranscript("\xe5\xad\x97\xe5\xb9\x95\xe7\x94\xb1" "Amara.org\xe7\xa4\xbe\xe5\x8c\xba\xe6\x8f\x90\xe4\xbe\x9b", strong(3.0), "") != nullptr);
    // In a long sentence the words can be real.
    CHECK(rejectTranscript("The novel was translated by a team of four people working over many years in Paris and Rome",
                           strong(8.0), "") == nullptr);
    return ok;
}

TEST(reject_repeat_of_previous_final) {
    bool ok = true;
    CHECK(rejectTranscript("This is the news.", strong(2.0), normalise("This is the news")) != nullptr);
    CHECK(rejectTranscript("This is the news.", strong(2.0), normalise("Here is the news")) == nullptr);
    return ok;
}

TEST(reject_loops_and_impossible_rates) {
    bool ok = true;
    CHECK(rejectTranscript("I wanted two hours a week, each week, where? I wanted two hours a week, each week, where? "
                           "I wanted two hours a week, each week, where? I wanted two hours a week, each week, where?",
                           strong(8.0), "") != nullptr);
    CHECK(rejectTranscript("the the the the the the", strong(5.0), "") != nullptr);
    // Three calls is how CQ is called.
    CHECK(rejectTranscript("CQ CQ CQ this is G4ABC calling", strong(4.0), "") == nullptr);
    // Thirty words from one second of audio.
    CHECK(rejectTranscript("a b c d e f g h i j k l m n o p q r s t u v w x y z one two three four", strong(1.0), "") !=
          nullptr);
    return ok;
}

}  // namespace

int main() {
    for (const Test &t : tests()) {
        const bool ok = t.fn();
        std::printf("  %s %s\n", ok ? "ok  " : "FAIL", t.name);
        if (ok) passes++;
        else failures++;
    }
    std::printf("%d passed, %d failed\n", passes, failures);
    return failures ? 1 : 0;
}
