// whisper_core.h — everything the Whisper helper decides that is not Whisper.
//
// The helper is a child process of the desktop client: the page's Speech-to-Text
// extension feeds it the receiver's audio through window.ubersdrDesktop.stt and
// shows what comes back (see static/v2/src/extensions/whisper/engines/host.js for
// that contract, and whisper_helper.cpp for the wire protocol). whisper.cpp is a
// C++ library with a model of tens of megabytes behind it, so it runs out here
// rather than in Electron, where a crash or a stall in it would take the window
// with it.
//
// Split from whisper_helper.cpp so that the parts with judgement in them — where
// an utterance starts and ends, which transcripts are Whisper talking to itself,
// what the wire's JSON looks like — build and are tested natively without a model
// (test/core_test.cpp). What is left in the other file is threads, pipes and
// whisper.cpp's API.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace whisperhelper {

// Whisper's one sample rate. The page resamples to it (Pcm16Batcher), because
// the receiver's own rate changes with the mode and Whisper given audio at the
// wrong rate does not fail — it loops a confident hallucination.
constexpr int RATE = 16000;

// ── The wire ─────────────────────────────────────────────────────────────────

// `s` as a JSON string literal, quotes included. Whisper's text is UTF-8 but is
// assembled from tokens, and a byte sequence that is not valid UTF-8 would make
// the whole line unparseable at the other end; those bytes become U+FFFD.
std::string jsonString(const std::string &s);

// START's payload. A hand-rolled reader for two known keys rather than a JSON
// library: the other end is ours, and a dependency for one object is not worth
// carrying into three toolchains.
struct StartRequest {
    std::string lang;    // as sent; "" when absent
    long long session = 0;
    bool hasSession = false;
};
StartRequest parseStart(const std::string &json);

// The language to hand Whisper for a START's `lang`: Whisper's own code, or
// "auto". The integration maps BCP-47 tags already; this takes the primary
// subtag and the handful of codes where Whisper's list predates the registry,
// so a tag that slipped through unmapped still means what it says.
std::string whisperLanguage(const std::string &lang);

// The other way: a Whisper language code as the BCP-47 tag a page lists and
// names. Whisper's codes are ISO 639-1 but for Javanese, which is "jw" to it and
// "jv" to everybody else. The desktop client does this in JavaScript on the
// helper's --languages list (stt.js); the browser build asks this.
std::string languageTag(const std::string &whisperCode);

// ── Utterances ───────────────────────────────────────────────────────────────

// Whisper transcribes a window of audio, not a stream, and cuts words where the
// window ends; fixed-length windows were measured doing exactly that. So the
// audio is cut where the speaker pauses, as the VAD (Silero, through whisper.cpp)
// hears it, and each piece is transcribed whole.
struct SegmenterConfig {
    int window = 512;            // samples per VAD probability (Silero at 16 kHz)
    float onThreshold = 0.5f;    // a window at or above this is speech...
    float offThreshold = 0.35f;  // ...and stays speech until it falls below this
    int preRoll = RATE * 3 / 10;   // audio kept from before the onset: the VAD hears
                                   // a word a little after it starts
    int endSilence = RATE * 7 / 10;  // the pause that ends an utterance
    // Past softMax a breath will do. A broadcast talker seldom pauses for
    // endSilence: measured live, utterances ran on to the 20 s cap, finals came
    // twenty seconds apart, and one of them dropped eight seconds from its
    // middle that the interims had heard. Eight seconds keeps captions settling
    // and Whisper's window short.
    int softMax = RATE * 8;
    int softSilence = RATE / 4;
    int maxLength = RATE * 20;       // and here it is cut regardless
    int tailPad = RATE / 4;          // silence kept after the last word
    int minSpeech = RATE / 4;        // less speech than this is a click, not a word
};

// What the transcript filter weighs against the text: how much speech the VAD
// heard, how sure it was, how loud it was.
struct Evidence {
    double seconds = 0;        // the utterance's whole length
    double voicedSeconds = 0;  // the windows the VAD called speech
    double meanProb = 0;       // its mean probability over those windows
    double rmsDb = -120;       // their level, dBFS
};

struct Utterance {
    std::vector<float> audio;
    Evidence evidence;
    bool enough = false;  // carries at least minSpeech of speech
};

class Segmenter {
public:
    enum Event { NONE, STARTED, ENDED };

    explicit Segmenter(SegmenterConfig cfg = SegmenterConfig());

    // One VAD window — exactly cfg.window samples — and its speech probability.
    // ENDED means an utterance is complete; take() it before the next push.
    Event push(const float *samples, float prob);

    bool inSpeech() const { return inSpeech_; }
    // The utterance so far, for an interim transcript.
    const std::vector<float> &audio() const { return utt_; }
    Evidence evidence() const;
    size_t voicedSamples() const { return voiced_; }
    // How long the speaker has been quiet, in samples, mid-utterance.
    int pause() const { return inSpeech_ ? silenceRun_ : 0; }

    // The utterance that has ended — or, mid-utterance, the one in progress,
    // ended now (the audio was cut by a drop and will not join up).
    Utterance take();
    // Forget everything, the pre-roll too: the receiver has been retuned.
    void reset();

    const SegmenterConfig &config() const { return cfg_; }

private:
    void startUtterance();
    void account(const float *samples, float prob);

    SegmenterConfig cfg_;
    std::vector<float> preRoll_;  // a ring, oldest first once full
    size_t preRollPos_ = 0;
    bool preRollFull_ = false;
    std::vector<float> utt_;
    bool inSpeech_ = false;
    bool ended_ = false;
    int silenceRun_ = 0;
    size_t voiced_ = 0;
    double probSum_ = 0;
    double energy_ = 0;
};

// ── Transcripts ──────────────────────────────────────────────────────────────

// Whisper's text with the non-speech annotations it was trained on removed —
// "[Music]", "(applause)", "♪" — and the whitespace tidied. Empty means there was
// nothing said.
std::string cleanTranscript(const std::string &text);

// Lower case, letters and digits only, single spaces: for comparing two
// transcripts, and one with the phrase list, without punctuation in the way.
std::string normalise(const std::string &text);

// How many words `text` says, counting two characters as one in the scripts
// written without spaces. For weighing one transcript against another, and
// against the length of the audio.
double wordCount(const std::string &text);

// Why a cleaned transcript should not be shown, or nullptr if it should be.
//
// Whisper was trained on subtitles, and given audio with no words in it, it
// writes what subtitles say over silence: "Thank you.", "Thanks for watching!",
// a translator's credit. The VAD keeps most silence away from it, and whisper.cpp
// drops windows its own no-speech probability rejects; this is the last line,
// and it judges the text against the evidence, so that a quiet, half-heard
// "Thank you." goes and a clearly spoken one stays. `previousFinal` is the last
// final line sent (normalised), which is never sent twice in a row.
const char *rejectTranscript(const std::string &text, const Evidence &ev, const std::string &previousFinal);

}  // namespace whisperhelper
