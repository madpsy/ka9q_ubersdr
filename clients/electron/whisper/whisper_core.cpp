// whisper_core.cpp — see whisper_core.h.
#include "whisper_core.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace whisperhelper {

namespace {

// One code point from UTF-8 at s[i], advancing i; U+FFFD and one byte for
// anything malformed (overlong forms and surrogates included), so that what
// comes out is always valid.
uint32_t nextCodePoint(const std::string &s, size_t &i) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    int len = 0;
    uint32_t cp = 0;
    if (c < 0x80) {
        i += 1;
        return c;
    } else if ((c & 0xE0) == 0xC0) {
        len = 2;
        cp = c & 0x1F;
    } else if ((c & 0xF0) == 0xE0) {
        len = 3;
        cp = c & 0x0F;
    } else if ((c & 0xF8) == 0xF0) {
        len = 4;
        cp = c & 0x07;
    } else {
        i += 1;
        return 0xFFFD;
    }
    if (i + len > s.size()) {
        i += 1;
        return 0xFFFD;
    }
    for (int k = 1; k < len; k++) {
        const unsigned char cc = static_cast<unsigned char>(s[i + k]);
        if ((cc & 0xC0) != 0x80) {
            i += 1;
            return 0xFFFD;
        }
        cp = (cp << 6) | (cc & 0x3F);
    }
    static const uint32_t least[] = {0, 0, 0x80, 0x800, 0x10000};
    if (cp < least[len] || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
        i += 1;
        return 0xFFFD;
    }
    i += len;
    return cp;
}

void appendUtf8(std::string &out, uint32_t cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

std::vector<uint32_t> decode(const std::string &s) {
    std::vector<uint32_t> out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size();) out.push_back(nextCodePoint(s, i));
    return out;
}

std::string encode(const std::vector<uint32_t> &cps) {
    std::string out;
    out.reserve(cps.size());
    for (uint32_t cp : cps) appendUtf8(out, cp);
    return out;
}

bool isSpace(uint32_t cp) {
    return cp == ' ' || cp == '\t' || cp == '\n' || cp == '\r' || cp == 0x00A0 || cp == 0x3000 ||
           (cp >= 0x2000 && cp <= 0x200B);
}

// Punctuation and symbols, for normalise(): ASCII's, Latin-1's, the general
// punctuation block, CJK punctuation, and the full-width forms of ASCII's.
bool isPunct(uint32_t cp) {
    if (cp < 0x80) return !((cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') || (cp >= '0' && cp <= '9'));
    return (cp >= 0x00A1 && cp <= 0x00BF) || cp == 0x00D7 || cp == 0x00F7 || (cp >= 0x2000 && cp <= 0x206F) ||
           (cp >= 0x2190 && cp <= 0x2BFF) || (cp >= 0x3000 && cp <= 0x303F) || (cp >= 0xFF01 && cp <= 0xFF0F) ||
           (cp >= 0xFF1A && cp <= 0xFF20) || (cp >= 0xFF3B && cp <= 0xFF40) || (cp >= 0xFF5B && cp <= 0xFF65) ||
           cp == 0xFFFD;
}

// Scripts written without spaces, where a "word" is a character or two.
bool isIdeographic(uint32_t cp) {
    return (cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
           (cp >= 0x0E00 && cp <= 0x0E7F) || (cp >= 0x20000 && cp <= 0x2FFFF);
}

std::vector<std::string> words(const std::string &normalised) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < normalised.size()) {
        size_t j = normalised.find(' ', i);
        if (j == std::string::npos) j = normalised.size();
        if (j > i) out.push_back(normalised.substr(i, j - i));
        i = j + 1;
    }
    return out;
}

bool contains(const std::string &haystack, const char *needle) {
    return haystack.find(needle) != std::string::npos;
}

}  // namespace

// ── The wire ─────────────────────────────────────────────────────────────────

std::string jsonString(const std::string &s) {
    std::string out;
    out.reserve(s.size() + 2);
    out += '"';
    for (size_t i = 0; i < s.size();) {
        const uint32_t cp = nextCodePoint(s, i);
        switch (cp) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            // The two line separators too: JSON allows them raw, but a reader
            // splitting on lines in JavaScript may not.
            if (cp < 0x20 || cp == 0x2028 || cp == 0x2029) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned>(cp));
                out += buf;
            } else {
                appendUtf8(out, cp);
            }
        }
    }
    out += '"';
    return out;
}

namespace {

// The value after `"key"` and its colon, or npos.
size_t findValue(const std::string &json, const char *key) {
    const std::string quoted = std::string("\"") + key + "\"";
    size_t at = json.find(quoted);
    while (at != std::string::npos) {
        size_t p = at + quoted.size();
        while (p < json.size() && isSpace(static_cast<unsigned char>(json[p]))) p++;
        if (p < json.size() && json[p] == ':') {
            p++;
            while (p < json.size() && isSpace(static_cast<unsigned char>(json[p]))) p++;
            return p;
        }
        at = json.find(quoted, at + 1);
    }
    return std::string::npos;
}

}  // namespace

StartRequest parseStart(const std::string &json) {
    StartRequest r;
    size_t p = findValue(json, "lang");
    if (p != std::string::npos && p < json.size() && json[p] == '"') {
        for (size_t i = p + 1; i < json.size() && json[i] != '"'; i++) {
            if (json[i] == '\\' && i + 1 < json.size()) i++;  // no language code has an escape in it
            r.lang += json[i];
        }
    }
    p = findValue(json, "session");
    if (p != std::string::npos && p < json.size() && (json[p] == '-' || (json[p] >= '0' && json[p] <= '9'))) {
        r.session = std::strtoll(json.c_str() + p, nullptr, 10);
        r.hasSession = true;
    }
    return r;
}

std::string whisperLanguage(const std::string &lang) {
    std::string code;
    for (char c : lang) {
        if (c == '-' || c == '_') break;
        code += static_cast<char>((c >= 'A' && c <= 'Z') ? c - 'A' + 'a' : c);
    }
    if (code.empty() || code == "auto" || code == "und") return "auto";
    // Whisper's list follows the codes its training data used: the old
    // ISO 639 forms for Hebrew, Indonesian, Javanese and Yiddish, and
    // macrolanguage Norwegian rather than Bokmål.
    static const char *const aliases[][2] = {
        {"iw", "he"}, {"in", "id"}, {"jv", "jw"}, {"ji", "yi"}, {"nb", "no"}, {"fil", "tl"}, {"cmn", "zh"},
    };
    for (const auto &a : aliases)
        if (code == a[0]) return a[1];
    return code;
}

// ── Utterances ───────────────────────────────────────────────────────────────

Segmenter::Segmenter(SegmenterConfig cfg) : cfg_(cfg), preRoll_(static_cast<size_t>(std::max(0, cfg.preRoll))) {}

void Segmenter::reset() {
    utt_.clear();
    inSpeech_ = false;
    ended_ = false;
    silenceRun_ = 0;
    voiced_ = 0;
    probSum_ = 0;
    energy_ = 0;
    preRollPos_ = 0;
    preRollFull_ = false;
}

void Segmenter::startUtterance() {
    utt_.clear();
    if (!preRoll_.empty()) {
        if (preRollFull_) utt_.insert(utt_.end(), preRoll_.begin() + preRollPos_, preRoll_.end());
        utt_.insert(utt_.end(), preRoll_.begin(), preRoll_.begin() + preRollPos_);
    }
    preRollPos_ = 0;
    preRollFull_ = false;
    inSpeech_ = true;
    silenceRun_ = 0;
    voiced_ = 0;
    probSum_ = 0;
    energy_ = 0;
}

void Segmenter::account(const float *samples, float prob) {
    double e = 0;
    for (int i = 0; i < cfg_.window; i++) e += static_cast<double>(samples[i]) * samples[i];
    energy_ += e;
    voiced_ += static_cast<size_t>(cfg_.window);
    probSum_ += prob;
}

Segmenter::Event Segmenter::push(const float *samples, float prob) {
    if (ended_) {
        // An ended utterance nobody took: it is dropped rather than carried
        // into the next one.
        utt_.clear();
        ended_ = false;
    }
    if (!inSpeech_) {
        if (prob >= cfg_.onThreshold) {
            startUtterance();
            utt_.insert(utt_.end(), samples, samples + cfg_.window);
            account(samples, prob);
            return STARTED;
        }
        for (int i = 0; i < cfg_.window && !preRoll_.empty(); i++) {
            preRoll_[preRollPos_++] = samples[i];
            if (preRollPos_ == preRoll_.size()) {
                preRollPos_ = 0;
                preRollFull_ = true;
            }
        }
        return NONE;
    }

    utt_.insert(utt_.end(), samples, samples + cfg_.window);
    if (prob >= cfg_.offThreshold) {
        silenceRun_ = 0;
        account(samples, prob);
    } else {
        silenceRun_ += cfg_.window;
    }

    const int length = static_cast<int>(utt_.size());
    const bool paused = silenceRun_ >= cfg_.endSilence || (length >= cfg_.softMax && silenceRun_ >= cfg_.softSilence);
    if (!paused && length < cfg_.maxLength) return NONE;

    if (paused) {
        // Keep tailPad of the pause; what is cut off is the start of the
        // silence before the next utterance, so it becomes its pre-roll.
        const int cut = std::max(0, silenceRun_ - cfg_.tailPad);
        std::vector<float> tail(utt_.end() - cut, utt_.end());
        utt_.resize(utt_.size() - static_cast<size_t>(cut));
        for (size_t i = 0; i < tail.size() && !preRoll_.empty(); i++) {
            preRoll_[preRollPos_++] = tail[i];
            if (preRollPos_ == preRoll_.size()) {
                preRollPos_ = 0;
                preRollFull_ = true;
            }
        }
    }
    inSpeech_ = false;
    ended_ = true;
    return ENDED;
}

Evidence Segmenter::evidence() const {
    Evidence ev;
    ev.seconds = static_cast<double>(utt_.size()) / RATE;
    ev.voicedSeconds = static_cast<double>(voiced_) / RATE;
    const double windows = static_cast<double>(voiced_) / cfg_.window;
    ev.meanProb = windows > 0 ? probSum_ / windows : 0;
    ev.rmsDb = voiced_ > 0 ? 10.0 * std::log10(energy_ / static_cast<double>(voiced_) + 1e-12) : -120;
    return ev;
}

Utterance Segmenter::take() {
    Utterance u;
    u.evidence = evidence();
    u.enough = voiced_ >= static_cast<size_t>(cfg_.minSpeech);
    u.audio.swap(utt_);
    utt_.clear();
    inSpeech_ = false;
    ended_ = false;
    silenceRun_ = 0;
    voiced_ = 0;
    probSum_ = 0;
    energy_ = 0;
    return u;
}

// ── Transcripts ──────────────────────────────────────────────────────────────

std::string cleanTranscript(const std::string &text) {
    const std::vector<uint32_t> in = decode(text);
    std::vector<uint32_t> out;
    out.reserve(in.size());
    // Annotations come in brackets: "[Music]", "(laughs)", "*sigh*", and in
    // CJK subtitles the full-width forms. An opener with no closer is left as
    // text — it may be a real parenthesis cut off by the utterance's end.
    static const uint32_t pairs[][2] = {
        {'[', ']'}, {'(', ')'}, {'*', '*'}, {0xFF08, 0xFF09}, {0x3010, 0x3011}, {0xFF3B, 0xFF3D},
    };
    for (size_t i = 0; i < in.size(); i++) {
        const uint32_t cp = in[i];
        bool skipped = false;
        for (const auto &p : pairs) {
            if (cp != p[0]) continue;
            size_t j = i + 1;
            while (j < in.size() && in[j] != p[1]) j++;
            if (j < in.size()) {
                i = j;
                skipped = true;
                out.push_back(' ');
            }
            break;
        }
        if (skipped) continue;
        // Music notes, which Whisper writes for anything sung or played.
        if (cp >= 0x2669 && cp <= 0x266F) {
            out.push_back(' ');
            continue;
        }
        out.push_back(cp);
    }
    // Whitespace collapsed and trimmed.
    std::vector<uint32_t> tidy;
    for (uint32_t cp : out) {
        if (isSpace(cp)) {
            if (!tidy.empty() && tidy.back() != ' ') tidy.push_back(' ');
        } else {
            tidy.push_back(cp);
        }
    }
    while (!tidy.empty() && tidy.back() == ' ') tidy.pop_back();
    // Nothing but punctuation — "...", "-" — is nothing said.
    bool any = false;
    for (uint32_t cp : tidy)
        if (!isPunct(cp) && !isSpace(cp)) any = true;
    return any ? encode(tidy) : std::string();
}

std::string normalise(const std::string &text) {
    std::string out;
    bool space = true;
    for (size_t i = 0; i < text.size();) {
        uint32_t cp = nextCodePoint(text, i);
        if (cp >= 'A' && cp <= 'Z') cp += 'a' - 'A';
        if (cp == '\'' || cp == 0x2019) continue;  // "don't" and "dont" are the same word
        if (isPunct(cp) || isSpace(cp)) {
            if (!space) out += ' ';
            space = true;
            continue;
        }
        appendUtf8(out, cp);
        space = false;
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

namespace {

// What subtitles say over silence, normalised. Every one of these is something
// a person might really say on the air, so they are only rejected on weak
// evidence; see rejectTranscript.
const char *const SILENCE_PHRASES[] = {
    "you", "i", "so", "oh", "uh", "um", "hmm", "okay", "bye", "bye bye", "the end",
    "thank you", "thanks", "thank you very much", "thank you so much", "thank you all",
    "thanks for watching", "thank you for watching", "thanks for listening", "thank you for listening",
    "please subscribe", "subscribe", "like and subscribe", "see you next time", "see you in the next video",
    "merci", "danke", "gracias", "obrigado", "grazie",
    "продолжение следует", "спасибо", "спасибо за внимание",
    "ご視聴ありがとうございました", "시청해주셔서 감사합니다", "谢谢观看", "谢谢", "謝謝",
};

// Credits — the subtitler's, the translator's — which are never speech. Only
// in a short line: "translated by" can be said, in a sentence round it.
const char *const CREDIT_PHRASES[] = {
    "amara org", "subtitles by", "subtitled by", "subtitle by", "captions by", "captioning by", "captioned by",
    "transcribed by", "transcription by", "translated by", "translation by", "sous titres", "sous titrage",
    "untertitel", "untertitelung", "subtítulos", "subtitulos", "napisy", "ondertiteling", "legendas",
    "редактор субтитров", "субтитры", "字幕", "明镜", "點點", "订阅", "www", "http",
};

// The speaking rate no transcript can honestly exceed: about twice a fast
// talker's, so only a transcript with words the audio could not hold fails.
double wordBudget(double seconds) { return 6.0 * seconds + 4.0; }

}  // namespace

double wordCount(const std::string &text) {
    double count = 0;
    for (const std::string &word : words(normalise(text))) {
        const std::vector<uint32_t> cps = decode(word);
        size_t ideo = 0;
        for (uint32_t cp : cps)
            if (isIdeographic(cp)) ideo++;
        count += ideo ? std::max(1.0, ideo / 2.0) : 1.0;
    }
    return count;
}

const char *rejectTranscript(const std::string &text, const Evidence &ev, const std::string &previousFinal) {
    const std::string n = normalise(text);
    if (n.empty()) return "empty";
    if (!previousFinal.empty() && n == previousFinal) return "repeat";

    const std::vector<std::string> w = words(n);
    const double count = wordCount(n);

    if (count <= 12) {
        for (const char *phrase : CREDIT_PHRASES)
            if (contains(n, phrase)) return "credits";
    }

    // Weak: quiet, or the VAD only half sure, or hardly any of it voiced. The
    // level is absolute because the page taps the audio before the volume
    // control, so it is the receiver's own: speech on AM broadcast and on HF
    // SSB measured -18 to -21 dBFS RMS, the noise between signals -38.
    const bool weak = ev.rmsDb < -35.0 || ev.meanProb < 0.7 || ev.voicedSeconds < 0.6;
    if (weak) {
        for (const char *phrase : SILENCE_PHRASES)
            if (n == phrase) return "silence-phrase";
    }

    if (count > wordBudget(ev.seconds)) return "too-many-words";

    // A loop: the same words over and over, Whisper having lost its place.
    // "CQ CQ CQ" is a real thing to say, so a short phrase takes four repeats
    // (one word five) and a phrase of five words or more three, covering at
    // least half the line.
    const size_t total = w.size();
    for (size_t k = 1; k <= 16 && k * 3 <= total; k++) {
        const size_t need = k == 1 ? 5 : k < 5 ? 4 : 3;
        for (size_t start = 0; start + k * need <= total; start++) {
            size_t reps = 1;
            while (start + (reps + 1) * k <= total &&
                   std::equal(w.begin() + start, w.begin() + start + k, w.begin() + start + reps * k))
                reps++;
            if (reps >= need && reps * k * 2 >= total) return "loop";
        }
    }
    return nullptr;
}

}  // namespace whisperhelper
