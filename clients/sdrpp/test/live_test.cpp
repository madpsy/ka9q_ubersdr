// Live check of everything below the menu: directory, mDNS, /connection, TLS,
// the WebSocket and the v4 decoder, feeding a real dsp::stream the way SDR++
// reads it. Linked against a real libsdrpp_core, so flog and VOLK are the ones
// the module uses when SDR++ loads it.
//
//   live_test <url> [mode] [seconds] [margin_dB] [password]
//
// Prints what it measured and exits non-zero if the stream did not deliver the
// mode's sample rate.
#include "http.h"
#include "iq_session.h"
#include "mdns.h"
#include "server_api.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <thread>

using namespace ubersdr;

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <url> [mode] [seconds] [margin_dB] [password]\n", argv[0]);
        return 2;
    }
    Url url = parseUrl(argv[1]);
    std::string mode = argc > 2 ? argv[2] : "iq48";
    int seconds = argc > 3 ? atoi(argv[3]) : 6;
    int margin = argc > 4 ? atoi(argv[4]) : 0;
    std::string password = argc > 5 ? argv[5] : "";
    if (!url.valid()) {
        fprintf(stderr, "bad url\n");
        return 2;
    }
    printf("receiver: %s\n", url.str().c_str());

    if (getenv("LIVE_DISCOVERY")) {
        try {
            auto dir = fetchDirectory(true);
            printf("directory: %zu receivers\n", dir.size());
        }
        catch (const std::exception& e) {
            printf("directory: FAILED %s\n", e.what());
        }
        auto t0 = std::chrono::steady_clock::now();
        auto lan = mdnsBrowse();
        printf("mdns: %zu found in %.1fs\n", lan.size(),
               std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
        for (auto& s : lan) { printf("  %s  %s:%d  txt=%zu\n", s.instance.c_str(), s.host.c_str(), s.port, s.txt.size()); }
    }

    ServerInfo info;
    try {
        info = probeServer(url, password, newSessionId(), true);
    }
    catch (const std::exception& e) {
        printf("probe: FAILED %s\n", e.what());
        return 1;
    }
    printf("probe: %s / %s, %.0f-%.0f Hz, bypassed=%d, modes:", info.callsign.c_str(), info.name.c_str(),
           info.minFreq, info.maxFreq, info.bypassed);
    for (auto& m : info.allowedModes) { printf(" %s", m.c_str()); }
    printf("\n");

    dsp::stream<dsp::complex_t> stream;
    std::atomic<long long> samples{ 0 };
    std::atomic<double> sumsq{ 0 };
    std::thread reader([&] {
        for (;;) {
            int n = stream.read();
            if (n < 0) { break; }
            double s = 0;
            for (int i = 0; i < n; i++) { s += stream.readBuf[i].re * stream.readBuf[i].re + stream.readBuf[i].im * stream.readBuf[i].im; }
            sumsq = sumsq + s;
            samples += n;
            stream.flush();
        }
    });

    IQSession session(&stream);
    IQSession::Params p;
    p.url = url;
    p.password = password;
    p.sessionId = newSessionId();
    p.mode = mode;
    p.frequency = 7074000;
    p.minFreq = info.minFreq;
    p.maxFreq = info.maxFreq;
    p.minMarginDB = margin;
    session.start(p);

    // Let it settle, then measure over the rest.
    std::this_thread::sleep_for(std::chrono::seconds(2));
    long long s0 = samples;
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < seconds; i++) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (i == seconds / 3) { session.tune(14074000); }
        if (i == (2 * seconds) / 3) { session.setMinMargin(margin == 0 ? 26 : 0); }
        auto st = session.status();
        printf("t=%d state=%d %.0f kB/s shift=%d %s\n", i, (int)st.state, st.kbytesPerSec, st.shift, st.message.c_str());
    }
    double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    double rate = (samples - s0) / el;
    auto st = session.status();
    session.stop();
    stream.stopReader();
    reader.join();

    const IQMode* m = findIQMode(mode);
    double want = m ? m->sampleRate : 0;
    double rms = samples > 0 ? std::sqrt(sumsq / samples) : 0;
    printf("measured %.0f samples/s (mode %.0f), rms %.2e dBFS %.1f, final state %d %s\n", rate, want, rms,
           rms > 0 ? 20 * std::log10(rms) : -999.0, (int)st.state, st.message.c_str());
    bool ok = want > 0 && std::fabs(rate - want) / want < 0.03 && rms > 0;
    printf("%s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}
