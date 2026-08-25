// gen_vectors.cpp — generate golden test vectors for the Go Olivia port.
//
// Links only Jalocha's headers as carried by fldigi. Run once; the output is
// committed as testdata so the Go tests never need this program or fldigi.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <vector>
#include <string>

// The harness reads geometry the receiver keeps private. Legitimate for a
// one-shot vector generator; nothing ships from this file but its output.
#define private public
#include "pj_mfsk.h"
#undef private

static void write_pcm(const char *path, const std::vector<int8_t> &pcm) {
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    fwrite(pcm.data(), sizeof(int8_t), pcm.size(), f);
    fclose(f);
    fprintf(stderr, "wrote %s (%zu samples)\n", path, pcm.size());
}

// Quantise to 8 bits so the committed vector stays small. Olivia's soft decode
// works on ratios of tone energies, and 8 bits leaves ~48 dB of headroom over a
// mode that copies at -10 dB SNR, so this costs the decoder nothing. The
// reference is then run over these exact bytes, not over the full-scale
// original, so what is committed is precisely what fldigi was shown.
static std::vector<int8_t> quantise8(const std::vector<int16_t> &pcm) {
    std::vector<int8_t> out(pcm.size());
    for (size_t i = 0; i < pcm.size(); i++) {
        int v = pcm[i] >> 8;
        if (v > 127) v = 127;
        if (v < -128) v = -128;
        out[i] = (int8_t)v;
    }
    return out;
}

static std::vector<int16_t> expand8(const std::vector<int8_t> &pcm) {
    std::vector<int16_t> out(pcm.size());
    for (size_t i = 0; i < pcm.size(); i++) out[i] = (int16_t)(pcm[i] << 8);
    return out;
}

// Generate Olivia audio for `text` and return int16 PCM at outRate.
static std::vector<int16_t> generate(size_t tones, size_t bandwidth,
                                     double centerHz, double outRate,
                                     const std::string &text,
                                     size_t leadSymbols, size_t tailSymbols) {
    MFSK_Transmitter<double> Tx;
    Tx.bContestia = false;
    Tx.Tones = tones;
    Tx.Bandwidth = bandwidth;
    Tx.SampleRate = 8000.0;
    Tx.OutputSampleRate = outRate;
    double fc_offset = bandwidth * (1.0 - 0.5 / tones) / 2.0;
    Tx.FirstCarrierMultiplier = (centerHz - fc_offset) / 500.0;
    Tx.Reverse = 0;
    if (Tx.Preset() < 0) { fprintf(stderr, "Tx.Preset failed\n"); exit(1); }

    fprintf(stderr, "  %zu/%zu: baud=%.4f block=%.3fs cps=%.3f maxout=%zu\n",
            tones, bandwidth, Tx.BaudRate(), Tx.BlockPeriod(),
            Tx.CharactersPerSecond(), Tx.MaxOutputLen);

    std::vector<double> buf(Tx.MaxOutputLen + 16);
    std::vector<double> out;

    // Silence in front so the receiver has to acquire sync the way it would
    // on air, rather than starting already locked to sample zero.
    size_t leadLen = (size_t)(leadSymbols * outRate / 8000.0 * 256);
    for (size_t i = 0; i < leadLen; i++) out.push_back(0.0);

    Tx.Start();
    for (size_t i = 0; i < text.size(); i++) Tx.PutChar((uint8_t)text[i]);
    Tx.Stop();
    while (Tx.Running()) {
        int n = Tx.Output(buf.data());
        for (int i = 0; i < n; i++) out.push_back(buf[i]);
    }
    size_t tailLen = (size_t)(tailSymbols * outRate / 8000.0 * 256);
    for (size_t i = 0; i < tailLen; i++) out.push_back(0.0);

    // Scale to a comfortable level well clear of clipping.
    double peak = 0;
    for (size_t i = 0; i < out.size(); i++)
        if (fabs(out[i]) > peak) peak = fabs(out[i]);
    if (peak <= 0) peak = 1;
    double scale = 32000.0 / peak;

    std::vector<int16_t> pcm(out.size());
    for (size_t i = 0; i < out.size(); i++) {
        double v = out[i] * scale;
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;
        pcm[i] = (int16_t)lrint(v);
    }
    return pcm;
}

// Decode with fldigi's own receiver, to prove the vector is decodable and to
// record what the reference makes of it.
static std::string reference_decode(const std::vector<int16_t> &pcm,
                                    size_t tones, size_t bandwidth,
                                    double centerHz, double inRate) {
    MFSK_Receiver<double> Rx;
    Rx.bContestia = false;
    Rx.Tones = tones;
    Rx.Bandwidth = bandwidth;
    Rx.SampleRate = 8000.0;
    Rx.InputSampleRate = inRate;
    Rx.SyncMargin = 8;
    Rx.SyncIntegLen = 4;
    Rx.SyncThreshold = 3.2;
    double fc_offset = bandwidth * (1.0 - 0.5 / tones) / 2.0;
    Rx.FirstCarrierMultiplier = (centerHz - fc_offset) / 500.0;
    Rx.Reverse = 0;
    if (Rx.Preset() < 0) { fprintf(stderr, "Rx.Preset failed\n"); exit(1); }

    std::string got;
    std::vector<double> chunk;
    const size_t CHUNK = 512;
    for (size_t off = 0; off < pcm.size(); off += CHUNK) {
        size_t n = pcm.size() - off; if (n > CHUNK) n = CHUNK;
        chunk.assign(n, 0.0);
        for (size_t i = 0; i < n; i++) chunk[i] = pcm[off + i] / 32768.0;
        Rx.Process(chunk.data(), n);
        uint8_t ch;
        while (Rx.GetChar(ch) > 0) if (ch > 7) got.push_back((char)ch);
    }
    Rx.Flush();
    uint8_t ch;
    while (Rx.GetChar(ch) > 0) if (ch > 7) got.push_back((char)ch);
    return got;
}

static void emit_escaped(FILE *f, const std::string &s) {
    for (size_t i = 0; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') fprintf(f, "\\%c", c);
        else if (c == '\n') fprintf(f, "\\n");
        else if (c == '\r') fprintf(f, "\\r");
        else if (c < 32 || c > 126) fprintf(f, "\\u%04x", c);
        else fputc(c, f);
    }
}

int main(int argc, char **argv) {
    const char *outdir = argc > 1 ? argv[1] : ".";
    char path[1024];
    FILE *j;
    snprintf(path, sizeof(path), "%s/vectors.json", outdir);
    j = fopen(path, "w");
    if (!j) { perror(path); exit(1); }

    fprintf(j, "{\n");

    // ---- BinaryCode / GrayCode over the full byte range ----------------
    fprintf(j, "  \"binary_code\": [");
    for (int i = 0; i < 256; i++)
        fprintf(j, "%s%d", i ? "," : "", (int)BinaryCode((uint8_t)i));
    fprintf(j, "],\n");
    fprintf(j, "  \"gray_code\": [");
    for (int i = 0; i < 256; i++)
        fprintf(j, "%s%d", i ? "," : "", (int)(GrayCode<uint8_t>((uint8_t)i)));
    fprintf(j, "],\n");

    // ---- FHT on a few deterministic vectors ----------------------------
    fprintf(j, "  \"fht\": [\n");
    for (int v = 0; v < 3; v++) {
        const size_t N = 64;
        double d[N];
        for (size_t i = 0; i < N; i++) {
            switch (v) {
                case 0: d[i] = (i == 5) ? 1.0 : 0.0; break;                 // spike
                case 1: d[i] = sin(i * 0.37) * 0.5 + 0.25; break;           // smooth
                default: d[i] = ((i * 2654435761u) % 1000) / 500.0 - 1.0;   // pseudo-random
            }
        }
        fprintf(j, "    {\"in\": [");
        for (size_t i = 0; i < N; i++) fprintf(j, "%s%.17g", i ? "," : "", d[i]);
        FHT(d, N);
        fprintf(j, "], \"out\": [");
        for (size_t i = 0; i < N; i++) fprintf(j, "%s%.17g", i ? "," : "", d[i]);
        fprintf(j, "]}%s\n", v < 2 ? "," : "");
    }
    fprintf(j, "  ],\n");

    // ---- LowPass3_Filter response --------------------------------------
    {
        LowPass3_Filter<double> f;
        f.Set(0.0);
        fprintf(j, "  \"lowpass3\": {\"weight\": 0.25, \"feedback\": 0.1, \"in\": [");
        double in[40], out[40];
        for (int i = 0; i < 40; i++) in[i] = (i < 20) ? 1.0 : 0.25;
        for (int i = 0; i < 40; i++) {
            f.Process(in[i], 0.25, 0.1);
            out[i] = f.Output;
        }
        for (int i = 0; i < 40; i++) fprintf(j, "%s%.17g", i ? "," : "", in[i]);
        fprintf(j, "], \"out\": [");
        for (int i = 0; i < 40; i++) fprintf(j, "%s%.17g", i ? "," : "", out[i]);
        fprintf(j, "]},\n");
    }

    // ---- Geometry for every mode we intend to offer ---------------------
    {
        struct { size_t tones, bw; double center; } modes[] = {
            // fldigi's quick-change list, at the panel's default 1000 Hz centre.
            {4,125,1000},{4,250,1000},{4,500,1000},{4,1000,1000},{4,2000,1000},
            {8,125,1000},{8,250,1000},{8,500,1000},{8,1000,1000},{8,2000,1000},
            {16,500,1000},{16,1000,1000},{16,2000,1000},
            {32,1000,1000},{32,2000,1000},
            {64,500,1000},{64,1000,1000},{64,2000,1000},
            // The 2000 Hz modes again at a centre high enough to give the
            // frequency search some room. At 1000 Hz the tone block runs into
            // DC and DecodeMargin clamps to FirstCarrier; both cases are
            // recorded so the Go port reproduces the clamp exactly.
            {4,2000,1500},{8,2000,1500},{16,2000,1500},{32,2000,1500},{64,2000,1500},
            // Off-centre tuning, which is what the frequency search is for.
            {16,500,700},{16,500,1500},{8,250,2000},
        };
        fprintf(j, "  \"geometry\": [\n");
        size_t n = sizeof(modes)/sizeof(modes[0]);
        for (size_t i = 0; i < n; i++) {
            size_t tones = modes[i].tones, bw = modes[i].bw;
            double centerHz = modes[i].center;
            MFSK_Receiver<double> Rx;
            Rx.bContestia = false;
            Rx.Tones = tones; Rx.Bandwidth = bw;
            Rx.SampleRate = 8000.0; Rx.InputSampleRate = 12000.0;
            Rx.SyncMargin = 8; Rx.SyncIntegLen = 4; Rx.SyncThreshold = 3.2;
            double fc_offset = bw * (1.0 - 0.5 / tones) / 2.0;
            Rx.FirstCarrierMultiplier = (centerHz - fc_offset) / 500.0;
            Rx.Reverse = 0;
            if (Rx.Preset() < 0) { fprintf(stderr, "geometry preset failed\n"); exit(1); }
            fprintf(j, "    {\"tones\": %zu, \"bandwidth_in\": %zu, \"bandwidth\": %zu, "
                       "\"center_hz\": %.1f, \"symbol_len\": %zu, \"symbol_separ\": %zu, "
                       "\"first_carrier\": %zu, \"sync_margin\": %zu, \"baud\": %.10g, "
                       "\"block_period\": %.10g}%s\n",
                    tones, bw, Rx.Bandwidth, centerHz,
                    Rx.Demodulator.SymbolLen, Rx.Demodulator.SymbolSepar,
                    Rx.Demodulator.FirstCarrier, Rx.SyncMargin,
                    Rx.BaudRate(), Rx.BlockPeriod(),
                    i + 1 < n ? "," : "");
        }
        fprintf(j, "  ],\n");
    }

    // ---- End-to-end audio vectors --------------------------------------
    {
        struct { size_t tones, bw; double center; const char *text; const char *name; } cases[] = {
            {16, 500,  1000.0, "CQ DE M0ABC K", "olivia_16_500"},
            {8,  250,  1000.0, "DE G0XYZ K",    "olivia_8_250"},
            {32, 1000, 1000.0, "TEST DE M0ABC K", "olivia_32_1000"},
        };
        fprintf(j, "  \"audio\": [\n");
        size_t n = sizeof(cases)/sizeof(cases[0]);
        for (size_t i = 0; i < n; i++) {
            fprintf(stderr, "generating %s\n", cases[i].name);
            std::vector<int16_t> full = generate(cases[i].tones, cases[i].bw,
                                                cases[i].center, 12000.0,
                                                cases[i].text, 8, 8);
            std::vector<int8_t> pcm8 = quantise8(full);
            snprintf(path, sizeof(path), "%s/%s.s8", outdir, cases[i].name);
            write_pcm(path, pcm8);
            std::vector<int16_t> pcm = expand8(pcm8);
            std::string ref = reference_decode(pcm, cases[i].tones, cases[i].bw,
                                               cases[i].center, 12000.0);
            fprintf(stderr, "  reference decoded: \"%s\"\n", ref.c_str());
            fprintf(j, "    {\"name\": \"%s\", \"file\": \"%s.s8\", \"tones\": %zu, "
                       "\"bandwidth\": %zu, \"center_hz\": %.1f, \"sample_rate\": 12000, "
                       "\"format\": \"s8\", \"samples\": %zu, \"sent\": \"",
                    cases[i].name, cases[i].name, cases[i].tones, cases[i].bw,
                    cases[i].center, pcm.size());
            emit_escaped(j, cases[i].text);
            fprintf(j, "\", \"reference_decoded\": \"");
            emit_escaped(j, ref);
            fprintf(j, "\"}%s\n", i + 1 < n ? "," : "");
        }
        fprintf(j, "  ]\n");
    }

    fprintf(j, "}\n");
    fclose(j);
    fprintf(stderr, "wrote %s/vectors.json\n", outdir);
    return 0;
}
