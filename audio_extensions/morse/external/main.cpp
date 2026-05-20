#include "CwDecoder.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

// JSON output format (one object per line):
//
//   decode event:
//     {"type":"decode","text":"CQ CQ DE W1AW","cost":0.12,"pitch":600,"speed":20}
//
//   stats update (pitch/speed changed without new text):
//     {"type":"stats","pitch":600,"speed":20}
//
// cost thresholds match AetherSDR's colour scheme:
//   < 0.15  -> "high"   (#00ff88 green)
//   < 0.35  -> "medium" (#e0e040 yellow)
//   < 0.60  -> "low"    (#ff9020 orange)
//   >= 0.60 -> "poor"   (filtered in AetherSDR by default)

static const char* confidenceLabel(float cost)
{
    if (cost < 0.15f) return "high";
    if (cost < 0.35f) return "medium";
    if (cost < 0.60f) return "low";
    return "poor";
}

// Minimal JSON string escape (printable ASCII only from ggmorse output).
static std::string jsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (c == '"')       out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c < 0x20)  out += ' ';
        else                out += static_cast<char>(c);
    }
    return out;
}

static void printUsage(const char* prog)
{
    fprintf(stderr,
        "Usage: %s [options]\n"
        "\n"
        "Reads mono int16 raw PCM from stdin at the configured sample rate.\n"
        "Writes one JSON object per line to stdout:\n"
        "  decode: {\"type\":\"decode\",\"text\":\"CQ DE W1AW\",\"cost\":0.12,\"confidence\":\"high\",\"pitch\":600,\"speed\":20}\n"
        "  stats:  {\"type\":\"stats\",\"pitch\":600,\"speed\":20}\n"
        "\n"
        "Options:\n"
        "  --sample-rate HZ  Input PCM sample rate in Hz (default: 12000)\n"
        "  --pitch HZ        Lock pitch to HZ (default: auto-detect)\n"
        "  --speed WPM       Lock speed to WPM (default: auto-detect)\n"
        "  --help            Show this message\n"
        "\n"
        "Example:\n"
        "  sox input.wav -t raw -r 12000 -c 1 -e signed -b 16 - | %s\n",
        prog, prog);
}

int main(int argc, char** argv)
{
    int   sampleRate = 12000;
    float lockPitch  = 0.0f;
    float lockSpeed  = 0.0f;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--help") == 0) { printUsage(argv[0]); return 0; }
        else if (strcmp(argv[i], "--sample-rate") == 0 && i + 1 < argc) { sampleRate = std::stoi(argv[++i]); }
        else if (strcmp(argv[i], "--pitch") == 0 && i + 1 < argc) { lockPitch = std::stof(argv[++i]); }
        else if (strcmp(argv[i], "--speed") == 0 && i + 1 < argc) { lockSpeed = std::stof(argv[++i]); }
        else { fprintf(stderr, "Unknown option: %s\n", argv[i]); return 1; }
    }

    CwDecoder decoder(sampleRate);

    decoder.start(
        [&decoder](const std::string& text, float cost) {
            fprintf(stdout,
                "{\"type\":\"decode\",\"text\":\"%s\",\"cost\":%.3f,\"confidence\":\"%s\",\"pitch\":%.0f,\"speed\":%.0f}\n",
                jsonEscape(text).c_str(),
                cost,
                confidenceLabel(cost),
                decoder.estimatedPitch(),
                decoder.estimatedSpeed());
            fflush(stdout);
        },
        [](CwDecoder::Stats s) {
            fprintf(stdout,
                "{\"type\":\"stats\",\"pitch\":%.0f,\"speed\":%.0f}\n",
                s.pitchHz, s.speedWpm);
            fflush(stdout);
        }
    );

    if (lockPitch > 0.0f || lockSpeed > 0.0f) {
        decoder.setKnownParameters(lockPitch > 0.0f ? lockPitch : 600.0f,
                                   lockSpeed > 0.0f ? lockSpeed : 20.0f);
    }

    constexpr int kBufFrames = 1024;
    int16_t buf[kBufFrames];

    while (!feof(stdin)) {
        size_t got = fread(buf, sizeof(int16_t), kBufFrames, stdin);
        if (got > 0) {
            decoder.feedAudio(buf, static_cast<int>(got));
        }
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    decoder.stop();
    return 0;
}
