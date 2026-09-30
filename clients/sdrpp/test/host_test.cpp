// SDR++ without its window: loads the built module through the core's own
// ModuleManager, exactly as SDR++ does at startup, and drives it through
// SourceManager. That exercises what live_test cannot — that the core finds the
// module, that the SourceHandler layout matches this core (upstream or CE), that
// the menu draws, and that samples reach SDR++'s IQ front end and its FFT.
//
//   host_test <module.so> <root dir> <receiver url> <mode> [seconds]
//
// The url must be in the module's normal form (scheme://host[:port]), since
// per-receiver settings are keyed by it.
//
// The root dir gets an ubersdr_source_config.json pointing at the receiver.
#include <core.h>
#include <imgui.h>
#include <module.h>
#include <signal_path/signal_path.h>
#include <utils/flog.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <thread>
#include <cstdlib>
#include <vector>

static std::vector<float> fftBuf(65536);
static std::atomic<int> fftFrames{ 0 };
static std::atomic<float> fftPeak{ -1000 };

static float* acquireFFT(void*) { return fftBuf.data(); }
static void releaseFFT(void*) {
    float peak = -1000;
    for (int i = 0; i < 1024; i++) {
        if (std::isfinite(fftBuf[i]) && fftBuf[i] > peak) { peak = fftBuf[i]; }
    }
    fftPeak = peak;
    fftFrames++;
}

// The menu is drawn in a fixed window so that simulated clicks land on it.
static void drawMenuFrame(float mx = -1, float my = -1, bool down = false) {
    ImGuiIO& io = ImGui::GetIO();
    io.DeltaTime = 1.0f / 60.0f;
    io.MousePos = ImVec2(mx, my);
    io.MouseDown[0] = down;
    ImGui::NewFrame();
    ImGui::SetNextWindowPos(ImVec2(0, 0));
    ImGui::SetNextWindowSize(ImVec2(400, 700));
    ImGui::Begin("source");
    sigpath::sourceManager.showSelectedMenu();
    ImGui::End();
    ImGui::Render();
}

int main(int argc, char** argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: %s <module> <root> <url> <mode> [seconds]\n", argv[0]);
        return 2;
    }
    std::string modPath = argv[1], root = argv[2], url = argv[3], mode = argv[4];
    int seconds = argc > 5 ? atoi(argv[5]) : 5;

    // HOST_TEST_DIRECTORY=1 picks the receiver from the public directory
    // instead of typing it, which is what exercises the directory menu.
    bool fromDirectory = getenv("HOST_TEST_DIRECTORY") != NULL;
    {
        std::ofstream cfg(root + "/ubersdr_source_config.json");
        cfg << "{\"source\":" << (fromDirectory ? 0 : 2) << ",\"manualUrl\":\"" << (fromDirectory ? "" : url)
            << "\",\"selectedUrl\":\"" << (fromDirectory ? url : "") << "\",\"verifyTls\":true,"
            << "\"servers\":{\"" << url << "\":{\"mode\":\"" << mode << "\",\"minMargin\":10,\"password\":\"\"}}}";
    }

    char a0[] = "host_test", a1[] = "--root";
    std::vector<char> rootArg(root.begin(), root.end());
    rootArg.push_back(0);
    char* av[] = { a0, a1, rootArg.data(), NULL };
    core::args.defineAll();
    if (core::args.parse(3, av) < 0) { return 2; }

    dsp::stream<dsp::complex_t> dummy;
    sigpath::iqFrontEnd.init(&dummy, 8000000, true, 1, false, 1024, 20.0, IQFrontEnd::FFTWindow::NUTTALL, acquireFFT, releaseFFT, NULL);

    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = ImVec2(800, 600);
    unsigned char* px;
    int w, h;
    io.Fonts->GetTexDataAsRGBA32(&px, &w, &h);

    auto mod = core::moduleManager.loadModule(modPath);
    if (!mod.handle) {
        printf("FAIL: module did not load\n");
        return 1;
    }
    if (core::moduleManager.createInstance("UberSDR", "ubersdr_source") != 0) {
        printf("FAIL: no instance\n");
        return 1;
    }
    core::moduleManager.doPostInitAll();

    auto names = sigpath::sourceManager.getSourceNames();
    bool found = false;
    for (auto& n : names) { found = found || n == "UberSDR"; }
    printf("sources registered: %zu, UberSDR %s\n", names.size(), found ? "present" : "MISSING");
    if (!found) { return 1; }

    sigpath::sourceManager.selectSource("UberSDR");
    // Draw for a while before starting, as a person would: the directory
    // loads in the background and the menu must survive every state of it.
    for (int i = 0; i < (fromDirectory ? 60 : 3); i++) {
        drawMenuFrame();
        if (fromDirectory) { std::this_thread::sleep_for(std::chrono::milliseconds(50)); }
    }

    // Click everywhere in the menu, a press and a release per point, the way a
    // person pokes at it: every button (Connect, Refresh), combo and checkbox
    // gets hit, and a Begin/EndDisabled pair that a click can unbalance aborts
    // the core's ImGui right here. Then close whatever popup is left open.
    bool clickOk = true;
    if (getenv("HOST_TEST_CLICK")) {
        for (float y = 5; y < 400; y += 9) {
            for (float x = 30; x < 400; x += 120) {
                drawMenuFrame(x, y, true);
                drawMenuFrame(x, y, false);
            }
        }
        drawMenuFrame(390, 690, true);
        drawMenuFrame(390, 690, false);
        for (int i = 0; i < 100; i++) {
            drawMenuFrame();
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        std::ifstream cfg(root + "/ubersdr_source_config.json");
        std::string all((std::istreambuf_iterator<char>(cfg)), std::istreambuf_iterator<char>());
        bool connected = all.find("\"servers\": {}") == std::string::npos && all.find("\"servers\":{}") == std::string::npos;
        printf("click sweep: survived, Connect %s\n", connected ? "answered" : "never answered");
        clickOk = connected;
    }

    sigpath::iqFrontEnd.start();
    sigpath::sourceManager.tune(7074000);
    sigpath::sourceManager.start();
    for (int i = 0; i < seconds * 10; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        drawMenuFrame(); // the menu is drawn every frame while streaming
        if (i == seconds * 5) { sigpath::sourceManager.tune(14074000); }
    }
    int frames = fftFrames;
    float peak = fftPeak;
    sigpath::sourceManager.stop();
    drawMenuFrame();
    sigpath::iqFrontEnd.stop();

    printf("fft frames: %d in %ds, peak %.1f dB\n", frames, seconds, peak);
    bool ok = frames >= seconds * 10 && peak > -200 && clickOk;
    printf("%s\n", ok ? "PASS" : "FAIL");
    fflush(stdout);

    // Tear down the way SDR++ does on exit: the instance goes first (it
    // unregisters its source), then the module's _END_ saves its config.
    core::moduleManager.deleteInstance("UberSDR");
    if (mod.end) { mod.end(); }
    printf("teardown done\n");
    fflush(stdout);
    return ok ? 0 : 1;
}
