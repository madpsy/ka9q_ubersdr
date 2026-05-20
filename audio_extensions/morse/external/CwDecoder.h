#pragma once

#include "ggmorse/include/ggmorse/ggmorse.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Standalone CW decoder wrapping ggmorse. No Qt.
// Feed mono int16 PCM at the sample rate passed to the constructor via feedAudio();
// decoded text arrives via the callback supplied to start().
class CwDecoder {
public:
    struct Stats {
        float pitchHz  = 0.0f;
        float speedWpm = 0.0f;
        float cost     = 0.0f;
    };

    using TextCallback  = std::function<void(const std::string&, float cost)>;
    using StatsCallback = std::function<void(Stats)>;

    // sampleRate: input PCM sample rate in Hz (e.g. 12000 or 24000).
    // Must match the rate of PCM fed via feedAudio().
    explicit CwDecoder(int sampleRate = 12000) : m_sampleRate(sampleRate) {}
    ~CwDecoder() { stop(); }

    CwDecoder(const CwDecoder&)            = delete;
    CwDecoder& operator=(const CwDecoder&) = delete;

    void start(TextCallback onText, StatsCallback onStats = {});
    void stop();
    bool isRunning() const { return m_running.load(); }

    // Feed mono int16 PCM at the sample rate given to the constructor.
    void feedAudio(const int16_t* samples, int frames);

    void lockPitch(bool lock);
    void lockSpeed(bool lock);
    void setPitchRange(float minHz, float maxHz);
    void setKnownParameters(float pitchHz, float speedWpm);

    float estimatedPitch() const { return m_pitch.load(); }
    float estimatedSpeed() const { return m_speed.load(); }

private:
    void decodeLoop();
    void applyDecodeParams();

    int m_sampleRate; // input PCM sample rate in Hz

    std::unique_ptr<GGMorse> m_ggmorse;

    std::mutex            m_bufMutex;
    std::vector<int16_t>  m_ringBuf;
    int                   m_ringCapacity{12000 * 4}; // 4 s of mono int16, updated in start()

    std::atomic<bool>  m_running{false};
    std::atomic<float> m_pitch{0.0f};
    std::atomic<float> m_speed{0.0f};
    std::atomic<float> m_pitchRangeMin{500.0f};
    std::atomic<float> m_pitchRangeMax{700.0f};
    std::atomic<bool>  m_pitchLocked{false};
    std::atomic<bool>  m_speedLocked{false};

    TextCallback  m_onText;
    StatsCallback m_onStats;

    std::thread m_worker;
};
