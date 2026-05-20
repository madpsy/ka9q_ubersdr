#include "CwDecoder.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

void CwDecoder::start(TextCallback onText, StatsCallback onStats)
{
    if (m_running.load()) return;

    m_onText  = std::move(onText);
    m_onStats = std::move(onStats);

    GGMorse::Parameters params;
    params.sampleRateInp   = static_cast<float>(m_sampleRate);
    params.sampleRateOut   = static_cast<float>(m_sampleRate);
    params.samplesPerFrame = GGMorse::kDefaultSamplesPerFrame;
    params.sampleFormatInp = GGMORSE_SAMPLE_FORMAT_I16;
    params.sampleFormatOut = GGMORSE_SAMPLE_FORMAT_I16;

    m_ggmorse = std::make_unique<GGMorse>(params);
    applyDecodeParams();

    // Ring capacity: 4 seconds of mono int16 at the configured sample rate
    m_ringCapacity = m_sampleRate * 4;

    {
        std::lock_guard<std::mutex> lock(m_bufMutex);
        m_ringBuf.clear();
    }

    m_running = true;
    m_worker  = std::thread([this] { decodeLoop(); });
}

void CwDecoder::stop()
{
    if (!m_running.load()) return;
    m_running = false;
    if (m_worker.joinable()) {
        m_worker.join();
    }
    m_ggmorse.reset();
}

void CwDecoder::feedAudio(const int16_t* samples, int frames)
{
    if (!m_running.load()) return;

    std::lock_guard<std::mutex> lock(m_bufMutex);
    m_ringBuf.insert(m_ringBuf.end(), samples, samples + frames);

    if (static_cast<int>(m_ringBuf.size()) > m_ringCapacity) {
        int excess = static_cast<int>(m_ringBuf.size()) - m_ringCapacity;
        m_ringBuf.erase(m_ringBuf.begin(), m_ringBuf.begin() + excess);
    }
}

void CwDecoder::lockPitch(bool lock)
{
    m_pitchLocked = lock;
    if (m_ggmorse) applyDecodeParams();
}

void CwDecoder::lockSpeed(bool lock)
{
    m_speedLocked = lock;
    if (m_ggmorse) applyDecodeParams();
}

void CwDecoder::setPitchRange(float minHz, float maxHz)
{
    m_pitchRangeMin = minHz;
    m_pitchRangeMax = maxHz;
    if (m_ggmorse) applyDecodeParams();
}

void CwDecoder::setKnownParameters(float pitchHz, float speedWpm)
{
    if (pitchHz <= 0.0f || speedWpm <= 0.0f) return;

    const bool unchanged = (m_pitch.load() == pitchHz)
        && (m_speed.load() == speedWpm)
        && m_pitchLocked.load()
        && m_speedLocked.load();
    if (unchanged) return;

    m_pitch       = pitchHz;
    m_speed       = speedWpm;
    m_pitchLocked = true;
    m_speedLocked = true;

    constexpr float kPad = 150.0f;
    m_pitchRangeMin = std::max(100.0f, pitchHz - kPad);
    m_pitchRangeMax = pitchHz + kPad;

    if (m_ggmorse) applyDecodeParams();
}

void CwDecoder::applyDecodeParams()
{
    GGMorse::ParametersDecode dp = GGMorse::getDefaultParametersDecode();
    dp.frequency_hz         = m_pitchLocked ? m_pitch.load() : -1.0f;
    dp.speed_wpm            = m_speedLocked ? m_speed.load() : -1.0f;
    dp.frequencyRangeMin_hz = m_pitchRangeMin;
    dp.frequencyRangeMax_hz = m_pitchRangeMax;
    m_ggmorse->setParametersDecode(dp);
}

void CwDecoder::decodeLoop()
{
    // resampleFactor = sampleRateInp / kBaseSampleRate (e.g. 12000/4000 = 3, or 24000/4000 = 6)
    // bytesPerFrame  = samplesPerFrame * resampleFactor * sizeof(int16_t)
    const int resampleFactor = static_cast<int>(m_ggmorse->getSampleRateInp() / GGMorse::kBaseSampleRate);
    const int samplesPerFrame = m_ggmorse->getSamplesPerFrame() * resampleFactor;

    while (m_running.load()) {
        {
            std::lock_guard<std::mutex> lock(m_bufMutex);
            if (static_cast<int>(m_ringBuf.size()) < samplesPerFrame) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
        }

        m_ggmorse->decode([this, samplesPerFrame](void* data, uint32_t nMaxBytes) -> uint32_t {
            if (!m_running.load()) return 0;

            std::lock_guard<std::mutex> lock(m_bufMutex);
            const uint32_t needed = nMaxBytes;
            const uint32_t avail  = static_cast<uint32_t>(m_ringBuf.size()) * sizeof(int16_t);
            if (avail < needed) return 0;

            const int samples = static_cast<int>(needed / sizeof(int16_t));
            std::memcpy(data, m_ringBuf.data(), needed);
            m_ringBuf.erase(m_ringBuf.begin(), m_ringBuf.begin() + samples);
            return needed;
        });

        const auto& stats = m_ggmorse->getStatistics();

        GGMorse::TxRx rxData;
        if (m_ggmorse->takeRxData(rxData) > 0 && stats.costFunction < 1.0f) {
            std::string text(reinterpret_cast<const char*>(rxData.data()), rxData.size());
            if (m_onText) m_onText(text, stats.costFunction);
        }

        if (stats.estimatedPitch_Hz > 0.0f) {
            m_pitch = stats.estimatedPitch_Hz;
            m_speed = stats.estimatedSpeed_wpm;
            if (m_onStats) m_onStats({stats.estimatedPitch_Hz, stats.estimatedSpeed_wpm, stats.costFunction});
        }
    }
}
