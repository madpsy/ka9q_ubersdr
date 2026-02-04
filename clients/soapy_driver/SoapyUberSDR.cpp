/*
 * SoapySDR driver for KA9Q UberSDR
 *
 * This driver provides access to KA9Q UberSDR's wide IQ modes via WebSocket.
 * Supports iq48, iq96, iq192, and iq384 modes (48-384 kHz bandwidth).
 *
 * Copyright (c) 2024
 * SPDX-License-Identifier: BSL-1.0
 */

#include <SoapySDR/Device.hpp>
#include <SoapySDR/Registry.hpp>
#include <SoapySDR/Formats.hpp>
#include <SoapySDR/Logger.hpp>

#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <websocketpp/config/asio_no_tls_client.hpp>

#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <atomic>
#include <chrono>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <random>
#include <algorithm>
#include <set>
#include <memory>
#include <curl/curl.h>
#include <zstd.h>

// Base64 decoding
static const std::string base64_chars = 
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789+/";

static inline bool is_base64(unsigned char c) {
    return (isalnum(c) || (c == '+') || (c == '/'));
}

std::vector<uint8_t> base64_decode(const std::string &encoded_string) {
    int in_len = encoded_string.size();
    int i = 0;
    int j = 0;
    int in_ = 0;
    unsigned char char_array_4[4], char_array_3[3];
    std::vector<uint8_t> ret;

    while (in_len-- && (encoded_string[in_] != '=') && is_base64(encoded_string[in_])) {
        char_array_4[i++] = encoded_string[in_]; in_++;
        if (i == 4) {
            for (i = 0; i < 4; i++)
                char_array_4[i] = base64_chars.find(char_array_4[i]);

            char_array_3[0] = (char_array_4[0] << 2) + ((char_array_4[1] & 0x30) >> 4);
            char_array_3[1] = ((char_array_4[1] & 0xf) << 4) + ((char_array_4[2] & 0x3c) >> 2);
            char_array_3[2] = ((char_array_4[2] & 0x3) << 6) + char_array_4[3];

            for (i = 0; (i < 3); i++)
                ret.push_back(char_array_3[i]);
            i = 0;
        }
    }

    if (i) {
        for (j = i; j < 4; j++)
            char_array_4[j] = 0;

        for (j = 0; j < 4; j++)
            char_array_4[j] = base64_chars.find(char_array_4[j]);

        char_array_3[0] = (char_array_4[0] << 2) + ((char_array_4[1] & 0x30) >> 4);
        char_array_3[1] = ((char_array_4[1] & 0xf) << 4) + ((char_array_4[2] & 0x3c) >> 2);
        char_array_3[2] = ((char_array_4[2] & 0x3) << 6) + char_array_4[3];

        for (j = 0; (j < i - 1); j++) ret.push_back(char_array_3[j]);
    }

    return ret;
}

// Generate UUID v4
std::string generateUUID() {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dis(0, 15);
    std::uniform_int_distribution<> dis2(8, 11);

    std::stringstream ss;
    ss << std::hex;
    for (int i = 0; i < 8; i++) ss << dis(gen);
    ss << "-";
    for (int i = 0; i < 4; i++) ss << dis(gen);
    ss << "-4";
    for (int i = 0; i < 3; i++) ss << dis(gen);
    ss << "-";
    ss << dis2(gen);
    for (int i = 0; i < 3; i++) ss << dis(gen);
    ss << "-";
    for (int i = 0; i < 12; i++) ss << dis(gen);
    return ss.str();
}

// Support both TLS and non-TLS WebSocket connections
typedef websocketpp::client<websocketpp::config::asio_tls_client> tls_client;
typedef websocketpp::client<websocketpp::config::asio_client> plain_client;
typedef websocketpp::config::asio_tls_client::message_type::ptr tls_message_ptr;
typedef websocketpp::config::asio_client::message_type::ptr plain_message_ptr;
typedef websocketpp::lib::shared_ptr<websocketpp::lib::asio::ssl::context> context_ptr;

/***********************************************************************
 * Device implementation
 **********************************************************************/
class SoapyUberSDR : public SoapySDR::Device
{
public:
    SoapyUberSDR(const SoapySDR::Kwargs &args);
    ~SoapyUberSDR();

    // Identification API
    std::string getDriverKey(void) const;
    std::string getHardwareKey(void) const;
    SoapySDR::Kwargs getHardwareInfo(void) const;

    // Channels API
    size_t getNumChannels(const int direction) const;
    bool getFullDuplex(const int direction, const size_t channel) const;

    // Stream API
    std::vector<std::string> getStreamFormats(const int direction, const size_t channel) const;
    std::string getNativeStreamFormat(const int direction, const size_t channel, double &fullScale) const;
    
    SoapySDR::Stream *setupStream(
        const int direction,
        const std::string &format,
        const std::vector<size_t> &channels = std::vector<size_t>(),
        const SoapySDR::Kwargs &args = SoapySDR::Kwargs());
    
    void closeStream(SoapySDR::Stream *stream);
    size_t getStreamMTU(SoapySDR::Stream *stream) const;
    
    int activateStream(
        SoapySDR::Stream *stream,
        const int flags = 0,
        const long long timeNs = 0,
        const size_t numElems = 0);
    
    int deactivateStream(
        SoapySDR::Stream *stream,
        const int flags = 0,
        const long long timeNs = 0);
    
    int readStream(
        SoapySDR::Stream *stream,
        void * const *buffs,
        const size_t numElems,
        int &flags,
        long long &timeNs,
        const long timeoutUs = 100000);

    // Antenna API
    std::vector<std::string> listAntennas(const int direction, const size_t channel) const;
    void setAntenna(const int direction, const size_t channel, const std::string &name);
    std::string getAntenna(const int direction, const size_t channel) const;

    // Gain API
    std::vector<std::string> listGains(const int direction, const size_t channel) const;
    void setGain(const int direction, const size_t channel, const double value);
    double getGain(const int direction, const size_t channel) const;
    SoapySDR::Range getGainRange(const int direction, const size_t channel) const;

    // Frequency API
    void setFrequency(const int direction, const size_t channel, const double frequency, const SoapySDR::Kwargs &args = SoapySDR::Kwargs());
    double getFrequency(const int direction, const size_t channel) const;
    std::vector<std::string> listFrequencies(const int direction, const size_t channel) const;
    SoapySDR::RangeList getFrequencyRange(const int direction, const size_t channel) const;

    // Sample Rate API
    void setSampleRate(const int direction, const size_t channel, const double rate);
    double getSampleRate(const int direction, const size_t channel) const;
    std::vector<double> listSampleRates(const int direction, const size_t channel) const;
    SoapySDR::RangeList getSampleRateRange(const int direction, const size_t channel) const;

    // Bandwidth API
    double getBandwidth(const int direction, const size_t channel) const;
    std::vector<double> listBandwidths(const int direction, const size_t channel) const;
    SoapySDR::RangeList getBandwidthRange(const int direction, const size_t channel) const;

    // Sensor API
    std::vector<std::string> listSensors(void) const;
    std::string readSensor(const std::string &key) const;

private:
    // Configuration
    std::string _serverURL;
    std::string _password;
    std::string _userSessionID;
    std::string _currentMode;
    uint64_t _currentFrequency;
    double _sampleRate;
    std::vector<std::string> _allowedIQModes;
    bool _useTLS;
    
    // WebSocket clients (only one will be used based on protocol)
    // Using unique_ptr to allow reconstruction after stop()
    std::unique_ptr<tls_client> _tlsClient;
    std::unique_ptr<plain_client> _plainClient;
    websocketpp::connection_hdl _wsHandle;
    std::thread _wsThread;
    std::atomic<bool> _streaming;
    std::atomic<bool> _connected;
    
    // I/Q buffer management
    std::queue<std::vector<std::complex<float>>> _iqBuffers;
    std::mutex _bufferMutex;
    std::condition_variable _bufferCV;
    static const size_t MAX_BUFFER_QUEUE_SIZE = 50; // Limit queue depth to prevent memory bloat
    
    // Partial buffer state for handling arbitrary read sizes
    std::vector<std::complex<float>> _partialBuffer;
    size_t _partialBufferOffset;
    
    // Helper functions
    double modeToSampleRate(const std::string &mode) const;
    std::string sampleRateToMode(double rate) const;
    void handleTLSMessage(websocketpp::connection_hdl hdl, tls_message_ptr msg);
    void handlePlainMessage(websocketpp::connection_hdl hdl, plain_message_ptr msg);
    void sendTuneCommand(uint64_t freq, const std::string &mode);
    bool checkConnectionAllowed();
    void connectWebSocket();
    void disconnectWebSocket();
};

// Constructor
SoapyUberSDR::SoapyUberSDR(const SoapySDR::Kwargs &args)
{
    if (args.count("server") == 0)
        throw std::runtime_error("SoapyUberSDR: 'server' argument required");
    
    _serverURL = args.at("server");
    _password = args.count("password") ? args.at("password") : "";
    _currentMode = args.count("mode") ? args.at("mode") : "iq96";
    _currentFrequency = 14074000;
    _sampleRate = modeToSampleRate(_currentMode);
    _streaming = false;
    _connected = false;
    _userSessionID = generateUUID();
    _partialBufferOffset = 0;
    
    // Detect if we should use TLS based on URL protocol
    _useTLS = (_serverURL.find("wss://") == 0);
    
    if (!_password.empty()) {
        SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Created device for %s mode=%s (with password) [%s]",
                       _serverURL.c_str(), _currentMode.c_str(), _useTLS ? "TLS" : "Plain");
    } else {
        SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Created device for %s mode=%s [%s]",
                       _serverURL.c_str(), _currentMode.c_str(), _useTLS ? "TLS" : "Plain");
    }
}

// Destructor
SoapyUberSDR::~SoapyUberSDR()
{
    if (_streaming) {
        deactivateStream(nullptr, 0, 0);
    }
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Device destroyed");
}

// Identification API
std::string SoapyUberSDR::getDriverKey(void) const { return "ubersdr"; }
std::string SoapyUberSDR::getHardwareKey(void) const { return "ka9q_ubersdr"; }

SoapySDR::Kwargs SoapyUberSDR::getHardwareInfo(void) const
{
    SoapySDR::Kwargs info;
    info["origin"] = "https://github.com/madpsy/ka9q_ubersdr";
    info["server"] = _serverURL;
    info["mode"] = _currentMode;
    info["bandwidth"] = std::to_string((int)_sampleRate) + " Hz";
    return info;
}

// Channels API
size_t SoapyUberSDR::getNumChannels(const int direction) const
{
    return (direction == SOAPY_SDR_RX) ? 1 : 0;
}

bool SoapyUberSDR::getFullDuplex(const int direction, const size_t channel) const
{
    return false;
}

// Stream API
std::vector<std::string> SoapyUberSDR::getStreamFormats(const int direction, const size_t channel) const
{
    std::vector<std::string> formats;
    formats.push_back(SOAPY_SDR_CF32);
    formats.push_back(SOAPY_SDR_CS16);
    return formats;
}

std::string SoapyUberSDR::getNativeStreamFormat(const int direction, const size_t channel, double &fullScale) const
{
    fullScale = 32768;
    return SOAPY_SDR_CF32;
}

SoapySDR::Stream *SoapyUberSDR::setupStream(
    const int direction,
    const std::string &format,
    const std::vector<size_t> &channels,
    const SoapySDR::Kwargs &args)
{
    if (direction != SOAPY_SDR_RX)
        throw std::runtime_error("SoapyUberSDR only supports RX");
    
    if (channels.size() > 1 || (channels.size() > 0 && channels[0] != 0))
        throw std::runtime_error("setupStream invalid channel selection");
    
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Stream setup complete");
    return (SoapySDR::Stream *) this;
}

void SoapyUberSDR::closeStream(SoapySDR::Stream *stream)
{
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Stream closed");
}

size_t SoapyUberSDR::getStreamMTU(SoapySDR::Stream *stream) const
{
    return 2048;
}

int SoapyUberSDR::activateStream(
    SoapySDR::Stream *stream,
    const int flags,
    const long long timeNs,
    const size_t numElems)
{
    if (_streaming)
        return SOAPY_SDR_STREAM_ERROR;
    
    _streaming = true;
    
    try {
        connectWebSocket();
    } catch (const std::exception &e) {
        SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Failed to connect: %s", e.what());
        _streaming = false;
        return SOAPY_SDR_STREAM_ERROR;
    }
    
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Stream activated");
    return 0;
}

int SoapyUberSDR::deactivateStream(SoapySDR::Stream *stream, const int flags, const long long timeNs)
{
    _streaming = false;
    disconnectWebSocket();
    
    std::lock_guard<std::mutex> lock(_bufferMutex);
    while (!_iqBuffers.empty())
        _iqBuffers.pop();
    
    // Clear partial buffer state
    _partialBuffer.clear();
    _partialBufferOffset = 0;
    
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Stream deactivated");
    return 0;
}

int SoapyUberSDR::readStream(
    SoapySDR::Stream *stream,
    void * const *buffs,
    const size_t numElems,
    int &flags,
    long long &timeNs,
    const long timeoutUs)
{
    std::unique_lock<std::mutex> lock(_bufferMutex);
    std::complex<float> *outBuff = static_cast<std::complex<float>*>(buffs[0]);
    size_t totalCopied = 0;
    
    auto deadline = std::chrono::steady_clock::now() +
                   std::chrono::microseconds(timeoutUs);
    
    // First, try to consume from partial buffer if available
    if (_partialBufferOffset < _partialBuffer.size()) {
        size_t available = _partialBuffer.size() - _partialBufferOffset;
        size_t toCopy = std::min(numElems, available);
        
        std::copy(_partialBuffer.begin() + _partialBufferOffset,
                  _partialBuffer.begin() + _partialBufferOffset + toCopy,
                  outBuff);
        
        _partialBufferOffset += toCopy;
        totalCopied += toCopy;
        
        // If partial buffer is exhausted, clear it
        if (_partialBufferOffset >= _partialBuffer.size()) {
            _partialBuffer.clear();
            _partialBufferOffset = 0;
        }
        
        // If we've satisfied the request, return now
        if (totalCopied >= numElems) {
            flags = 0;
            timeNs = 0;
            return totalCopied;
        }
    }
    
    // Need more samples - wait for new buffer from queue
    while (_iqBuffers.empty() && _streaming) {
        if (_bufferCV.wait_until(lock, deadline) == std::cv_status::timeout) {
            // Return what we have so far, or timeout if nothing
            return totalCopied > 0 ? totalCopied : SOAPY_SDR_TIMEOUT;
        }
    }
    
    if (!_streaming)
        return totalCopied > 0 ? totalCopied : SOAPY_SDR_STREAM_ERROR;
    
    if (_iqBuffers.empty())
        return totalCopied > 0 ? totalCopied : SOAPY_SDR_TIMEOUT;
    
    // Get next buffer from queue
    auto &iqData = _iqBuffers.front();
    size_t remaining = numElems - totalCopied;
    size_t available = iqData.size();
    
    if (remaining >= available) {
        // Request can consume entire buffer
        std::copy(iqData.begin(), iqData.end(), outBuff + totalCopied);
        totalCopied += available;
        _iqBuffers.pop();
    } else {
        // Request needs only part of buffer - save remainder
        std::copy(iqData.begin(), iqData.begin() + remaining, outBuff + totalCopied);
        totalCopied += remaining;
        
        // Move remaining samples to partial buffer
        _partialBuffer = std::move(iqData);
        _partialBufferOffset = remaining;
        _iqBuffers.pop();
    }
    
    flags = 0;
    timeNs = 0;
    
    return totalCopied;
}

// Antenna API
std::vector<std::string> SoapyUberSDR::listAntennas(const int direction, const size_t channel) const
{
    std::vector<std::string> antennas;
    antennas.push_back("RX");
    return antennas;
}

void SoapyUberSDR::setAntenna(const int direction, const size_t channel, const std::string &name) {}
std::string SoapyUberSDR::getAntenna(const int direction, const size_t channel) const { return "RX"; }

// Gain API
std::vector<std::string> SoapyUberSDR::listGains(const int direction, const size_t channel) const
{
    return std::vector<std::string>();
}

void SoapyUberSDR::setGain(const int direction, const size_t channel, const double value) {}
double SoapyUberSDR::getGain(const int direction, const size_t channel) const { return 0; }
SoapySDR::Range SoapyUberSDR::getGainRange(const int direction, const size_t channel) const
{
    return SoapySDR::Range(0, 0);
}

// Frequency API
void SoapyUberSDR::setFrequency(
    const int direction,
    const size_t channel,
    const double frequency,
    const SoapySDR::Kwargs &args)
{
    _currentFrequency = (uint64_t)frequency;
    
    if (_streaming && _connected) {
        sendTuneCommand(_currentFrequency, _currentMode);
    }
    
    SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Frequency set to %llu Hz", _currentFrequency);
}

double SoapyUberSDR::getFrequency(const int direction, const size_t channel) const
{
    return (double)_currentFrequency;
}

std::vector<std::string> SoapyUberSDR::listFrequencies(const int direction, const size_t channel) const
{
    std::vector<std::string> names;
    names.push_back("RF");
    return names;
}

SoapySDR::RangeList SoapyUberSDR::getFrequencyRange(const int direction, const size_t channel) const
{
    SoapySDR::RangeList ranges;
    ranges.push_back(SoapySDR::Range(100e3, 30e6));
    return ranges;
}

// Sample Rate API
void SoapyUberSDR::setSampleRate(const int direction, const size_t channel, const double rate)
{
    std::string newMode = sampleRateToMode(rate);
    
    if (newMode != _currentMode) {
        _currentMode = newMode;
        _sampleRate = modeToSampleRate(newMode);
        
        if (_streaming) {
            deactivateStream(nullptr, 0, 0);
            activateStream(nullptr, 0, 0, 0);
        }
        
        SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Sample rate set to %.0f Hz (mode=%s)", 
                       _sampleRate, _currentMode.c_str());
    }
}

double SoapyUberSDR::getSampleRate(const int direction, const size_t channel) const
{
    return _sampleRate;
}

std::vector<double> SoapyUberSDR::listSampleRates(const int direction, const size_t channel) const
{
    std::vector<double> rates;
    rates.push_back(48000);
    rates.push_back(96000);
    rates.push_back(192000);
    rates.push_back(384000);
    return rates;
}

SoapySDR::RangeList SoapyUberSDR::getSampleRateRange(const int direction, const size_t channel) const
{
    SoapySDR::RangeList ranges;
    ranges.push_back(SoapySDR::Range(48000, 48000));
    ranges.push_back(SoapySDR::Range(96000, 96000));
    ranges.push_back(SoapySDR::Range(192000, 192000));
    ranges.push_back(SoapySDR::Range(384000, 384000));
    return ranges;
}

// Bandwidth API
double SoapyUberSDR::getBandwidth(const int direction, const size_t channel) const
{
    return _sampleRate;
}

std::vector<double> SoapyUberSDR::listBandwidths(const int direction, const size_t channel) const
{
    return listSampleRates(direction, channel);
}

SoapySDR::RangeList SoapyUberSDR::getBandwidthRange(const int direction, const size_t channel) const
{
    return getSampleRateRange(direction, channel);
}

// Sensor API
std::vector<std::string> SoapyUberSDR::listSensors(void) const
{
    std::vector<std::string> sensors;
    sensors.push_back("connection_status");
    sensors.push_back("server_url");
    sensors.push_back("mode");
    return sensors;
}

std::string SoapyUberSDR::readSensor(const std::string &key) const
{
    if (key == "connection_status")
        return _connected ? "connected" : "disconnected";
    if (key == "server_url")
        return _serverURL;
    if (key == "mode")
        return _currentMode;
    throw std::runtime_error("Unknown sensor: " + key);
}

// Helper functions
double SoapyUberSDR::modeToSampleRate(const std::string &mode) const
{
    if (mode == "iq48") return 48000;
    if (mode == "iq96") return 96000;
    if (mode == "iq192") return 192000;
    if (mode == "iq384") return 384000;
    return 96000;
}

std::string SoapyUberSDR::sampleRateToMode(double rate) const
{
    if (rate <= 48000) return "iq48";
    if (rate <= 96000) return "iq96";
    if (rate <= 192000) return "iq192";
    return "iq384";
}

void SoapyUberSDR::handleTLSMessage(websocketpp::connection_hdl hdl, tls_message_ptr msg)
{
    try {
        const std::string& payload = msg->get_payload();
        
        // Log message type for debugging
        SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Received message, opcode=%d, size=%zu",
                      (int)msg->get_opcode(), payload.size());
        
        // Check if this is a binary message (pcm-zstd format)
        if (msg->get_opcode() == websocketpp::frame::opcode::binary) {
            const uint8_t* compressedData = reinterpret_cast<const uint8_t*>(payload.data());
            size_t compressedSize = payload.size();
            
            // Decompress with zstd
            size_t decompressedSize = ZSTD_getFrameContentSize(compressedData, compressedSize);
            if (decompressedSize == ZSTD_CONTENTSIZE_ERROR || decompressedSize == ZSTD_CONTENTSIZE_UNKNOWN) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Invalid zstd frame");
                return;
            }
            
            std::vector<uint8_t> decompressed(decompressedSize);
            size_t actualSize = ZSTD_decompress(decompressed.data(), decompressedSize,
                                                compressedData, compressedSize);
            if (ZSTD_isError(actualSize)) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Zstd decompression error: %s",
                              ZSTD_getErrorName(actualSize));
                return;
            }
            
            // Parse binary header (little-endian)
            if (actualSize < 13) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Packet too small");
                return;
            }
            
            const uint8_t* data = decompressed.data();
            uint16_t magic = data[0] | (data[1] << 8);
            
            size_t headerSize;
            size_t dataOffset;
            
            if (magic == 0x5043) {  // "PC" - Full header
                headerSize = 29;
                dataOffset = 29;
            } else if (magic == 0x504D) {  // "PM" - Minimal header
                headerSize = 13;
                dataOffset = 13;
            } else {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Invalid PCM magic: 0x%04x", magic);
                return;
            }
            
            if (actualSize < headerSize) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Packet too small for header");
                return;
            }
            
            // PCM data starts after header
            const uint8_t* pcmData = data + dataOffset;
            size_t pcmSize = actualSize - dataOffset;
            
            // Calculate sample count from PCM data size
            // Each sample is 4 bytes (2 channels * 2 bytes per sample)
            size_t sampleCount = pcmSize / 4;
            
            if (pcmSize % 4 != 0) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: PCM data size not multiple of 4: %zu", pcmSize);
                return;
            }
            
            // Convert big-endian PCM to complex float
            std::vector<std::complex<float>> iqSamples(sampleCount);
            for (size_t i = 0; i < sampleCount; i++) {
                int16_t I = (pcmData[i*4] << 8) | pcmData[i*4+1];
                int16_t Q = (pcmData[i*4+2] << 8) | pcmData[i*4+3];
                iqSamples[i] = std::complex<float>(I / 32768.0f, Q / 32768.0f);
            }
            
            std::lock_guard<std::mutex> lock(_bufferMutex);
            
            // Limit queue depth to prevent memory bloat and excessive latency
            if (_iqBuffers.size() >= MAX_BUFFER_QUEUE_SIZE) {
                SoapySDR::logf(SOAPY_SDR_WARNING,
                    "SoapyUberSDR: Buffer queue full (%zu), dropping oldest buffer",
                    _iqBuffers.size());
                _iqBuffers.pop();
            }
            
            _iqBuffers.push(std::move(iqSamples));
            _bufferCV.notify_one();
        } else {
            // Log first few bytes of non-binary messages for debugging
            if (payload.size() > 0) {
                std::string preview = payload.substr(0, std::min(size_t(100), payload.size()));
                SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Non-binary message: %s", preview.c_str());
            }
        }
        
    } catch (const std::exception &e) {
        SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: TLS message handling error: %s", e.what());
    }
}

void SoapyUberSDR::handlePlainMessage(websocketpp::connection_hdl hdl, plain_message_ptr msg)
{
    try {
        const std::string& payload = msg->get_payload();
        
        // Log message type for debugging
        SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Received message, opcode=%d, size=%zu",
                      (int)msg->get_opcode(), payload.size());
        
        // Check if this is a binary message (pcm-zstd format)
        if (msg->get_opcode() == websocketpp::frame::opcode::binary) {
            const uint8_t* compressedData = reinterpret_cast<const uint8_t*>(payload.data());
            size_t compressedSize = payload.size();
            
            // Decompress with zstd
            size_t decompressedSize = ZSTD_getFrameContentSize(compressedData, compressedSize);
            if (decompressedSize == ZSTD_CONTENTSIZE_ERROR || decompressedSize == ZSTD_CONTENTSIZE_UNKNOWN) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Invalid zstd frame");
                return;
            }
            
            std::vector<uint8_t> decompressed(decompressedSize);
            size_t actualSize = ZSTD_decompress(decompressed.data(), decompressedSize,
                                                compressedData, compressedSize);
            if (ZSTD_isError(actualSize)) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Zstd decompression error: %s",
                              ZSTD_getErrorName(actualSize));
                return;
            }
            
            // Parse binary header (little-endian)
            if (actualSize < 13) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Packet too small");
                return;
            }
            
            const uint8_t* data = decompressed.data();
            uint16_t magic = data[0] | (data[1] << 8);
            
            size_t headerSize;
            size_t dataOffset;
            
            if (magic == 0x5043) {  // "PC" - Full header
                headerSize = 29;
                dataOffset = 29;
            } else if (magic == 0x504D) {  // "PM" - Minimal header
                headerSize = 13;
                dataOffset = 13;
            } else {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Invalid PCM magic: 0x%04x", magic);
                return;
            }
            
            if (actualSize < headerSize) {
                SoapySDR::log(SOAPY_SDR_ERROR, "SoapyUberSDR: Packet too small for header");
                return;
            }
            
            // PCM data starts after header
            const uint8_t* pcmData = data + dataOffset;
            size_t pcmSize = actualSize - dataOffset;
            
            // Calculate sample count from PCM data size
            // Each sample is 4 bytes (2 channels * 2 bytes per sample)
            size_t sampleCount = pcmSize / 4;
            
            if (pcmSize % 4 != 0) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: PCM data size not multiple of 4: %zu", pcmSize);
                return;
            }
            
            // Convert big-endian PCM to complex float
            std::vector<std::complex<float>> iqSamples(sampleCount);
            for (size_t i = 0; i < sampleCount; i++) {
                int16_t I = (pcmData[i*4] << 8) | pcmData[i*4+1];
                int16_t Q = (pcmData[i*4+2] << 8) | pcmData[i*4+3];
                iqSamples[i] = std::complex<float>(I / 32768.0f, Q / 32768.0f);
            }
            
            std::lock_guard<std::mutex> lock(_bufferMutex);
            
            // Limit queue depth to prevent memory bloat and excessive latency
            if (_iqBuffers.size() >= MAX_BUFFER_QUEUE_SIZE) {
                SoapySDR::logf(SOAPY_SDR_WARNING,
                    "SoapyUberSDR: Buffer queue full (%zu), dropping oldest buffer",
                    _iqBuffers.size());
                _iqBuffers.pop();
            }
            
            _iqBuffers.push(std::move(iqSamples));
            _bufferCV.notify_one();
        } else {
            // Log first few bytes of non-binary messages for debugging
            if (payload.size() > 0) {
                std::string preview = payload.substr(0, std::min(size_t(100), payload.size()));
                SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Non-binary message: %s", preview.c_str());
            }
        }
        
    } catch (const std::exception &e) {
        SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Plain message handling error: %s", e.what());
    }
}

void SoapyUberSDR::sendTuneCommand(uint64_t freq, const std::string &mode)
{
    try {
        std::stringstream ss;
        ss << "{\"type\":\"tune\",\"frequency\":" << freq << ",\"mode\":\"" << mode << "\"}";

        if (_useTLS) {
            _tlsClient->send(_wsHandle, ss.str(), websocketpp::frame::opcode::text);
        } else {
            _plainClient->send(_wsHandle, ss.str(), websocketpp::frame::opcode::text);
        }

        SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Sent tune command: %s", ss.str().c_str());
    } catch (const std::exception &e) {
        SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Failed to send tune command: %s", e.what());
    }
}

// CURL write callback
static size_t soapy_curl_write_callback(void *contents, size_t size, size_t nmemb, void *userp)
{
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

bool SoapyUberSDR::checkConnectionAllowed()
{
    // Extract base URL from WebSocket URL
    std::string baseURL = _serverURL;
    
    // Convert ws:// to http:// or wss:// to https://
    if (baseURL.find("ws://") == 0) {
        baseURL = "http://" + baseURL.substr(5);
    } else if (baseURL.find("wss://") == 0) {
        baseURL = "https://" + baseURL.substr(6);
    }
    
    // Remove /ws path if present
    size_t wsPos = baseURL.find("/ws");
    if (wsPos != std::string::npos) {
        baseURL = baseURL.substr(0, wsPos);
    }
    
    // Build connection check URL
    std::string checkURL = baseURL + "/connection";
    
    // Build JSON request body
    std::stringstream jsonBody;
    jsonBody << "{\"user_session_id\":\"" << _userSessionID << "\"";
    if (!_password.empty()) {
        jsonBody << ",\"password\":\"" << _password << "\"";
    }
    jsonBody << "}";
    std::string postData = jsonBody.str();
    
    SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Checking connection permission at %s", checkURL.c_str());
    
    // Initialize CURL
    CURL *curl = curl_easy_init();
    if (!curl) {
        SoapySDR::log(SOAPY_SDR_WARNING, "SoapyUberSDR: Failed to initialize CURL, attempting connection anyway");
        return true;
    }
    
    std::string response;
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "User-Agent: UberSDR_Soapy/1.0");
    
    curl_easy_setopt(curl, CURLOPT_URL, checkURL.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postData.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, soapy_curl_write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    
    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        SoapySDR::logf(SOAPY_SDR_WARNING, "SoapyUberSDR: Connection check failed: %s, attempting connection anyway",
                       curl_easy_strerror(res));
        return true;
    }
    
    // Parse JSON response
    SoapySDR::logf(SOAPY_SDR_DEBUG, "SoapyUberSDR: Connection check response: %s", response.c_str());

    // Parse "allowed" field
    size_t allowedPos = response.find("\"allowed\"");
    if (allowedPos != std::string::npos) {
        size_t truePos = response.find("true", allowedPos);
        size_t falsePos = response.find("false", allowedPos);

        if (truePos != std::string::npos && (falsePos == std::string::npos || truePos < falsePos)) {
            // Connection is allowed, now parse allowed_iq_modes array
            _allowedIQModes.clear();
            
            size_t modesPos = response.find("\"allowed_iq_modes\"");
            if (modesPos != std::string::npos) {
                size_t arrayStart = response.find("[", modesPos);
                size_t arrayEnd = response.find("]", arrayStart);
                
                if (arrayStart != std::string::npos && arrayEnd != std::string::npos) {
                    std::string modesArray = response.substr(arrayStart + 1, arrayEnd - arrayStart - 1);
                    
                    // Parse each mode in the array
                    size_t pos = 0;
                    while (pos < modesArray.length()) {
                        size_t quoteStart = modesArray.find("\"", pos);
                        if (quoteStart == std::string::npos) break;
                        
                        size_t quoteEnd = modesArray.find("\"", quoteStart + 1);
                        if (quoteEnd == std::string::npos) break;
                        
                        std::string mode = modesArray.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
                        _allowedIQModes.push_back(mode);
                        pos = quoteEnd + 1;
                    }
                }
            }
            
            // Check if current mode is allowed
            bool modeAllowed = std::find(_allowedIQModes.begin(), _allowedIQModes.end(), _currentMode) != _allowedIQModes.end();
            
            if (modeAllowed) {
                SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Connection allowed - mode '%s' is available", _currentMode.c_str());
                return true;
            } else {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Connection allowed but mode '%s' is not in allowed list", _currentMode.c_str());
                if (!_allowedIQModes.empty()) {
                    std::string allowedList;
                    for (size_t i = 0; i < _allowedIQModes.size(); i++) {
                        if (i > 0) allowedList += ", ";
                        allowedList += _allowedIQModes[i];
                    }
                    SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Allowed modes: %s", allowedList.c_str());
                }
                return false;
            }
        } else if (falsePos != std::string::npos) {
            // Extract reason if present
            size_t reasonPos = response.find("\"reason\"");
            std::string reason = "Connection not allowed";
            if (reasonPos != std::string::npos) {
                size_t reasonStart = response.find("\"", reasonPos + 8) + 1;
                size_t reasonEnd = response.find("\"", reasonStart);
                if (reasonStart != std::string::npos && reasonEnd != std::string::npos) {
                    reason = response.substr(reasonStart, reasonEnd - reasonStart);
                }
            }
            SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Connection rejected: %s", reason.c_str());
            return false;
        }
    }
    
    // If we can't parse the response, allow connection
    SoapySDR::log(SOAPY_SDR_WARNING, "SoapyUberSDR: Could not parse connection check response, attempting connection anyway");
    return true;
}

void SoapyUberSDR::connectWebSocket()
{
    // Check if connection is allowed before attempting WebSocket connection
    if (!checkConnectionAllowed()) {
        throw std::runtime_error("Connection not allowed by server");
    }

    std::stringstream ss;
    ss << _serverURL;
    if (_serverURL.find('?') == std::string::npos)
        ss << "?";
    else
        ss << "&";
    ss << "frequency=" << _currentFrequency;
    ss << "&mode=" << _currentMode;
    ss << "&format=pcm-zstd";  // Request binary PCM with zstd compression
    ss << "&user_session_id=" << _userSessionID;
    if (!_password.empty()) {
        // URL encode password (simple implementation for common characters)
        std::string encodedPassword;
        for (char c : _password) {
            if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
                encodedPassword += c;
            } else {
                char hex[4];
                snprintf(hex, sizeof(hex), "%%%02X", (unsigned char)c);
                encodedPassword += hex;
            }
        }
        ss << "&password=" << encodedPassword;
    }

    std::string wsURL = ss.str();

    SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Connecting to %s [%s]", wsURL.c_str(), _useTLS ? "TLS" : "Plain");

    if (_useTLS) {
        // Reconstruct TLS client to ensure clean state after previous stop()
        _tlsClient.reset(new tls_client());

        // TLS WebSocket connection
        _tlsClient->clear_access_channels(websocketpp::log::alevel::all);
        _tlsClient->clear_error_channels(websocketpp::log::elevel::all);
        _tlsClient->init_asio();

        // Set up TLS/SSL context for secure WebSocket connections
        _tlsClient->set_tls_init_handler([](websocketpp::connection_hdl) {
            context_ptr ctx = websocketpp::lib::make_shared<websocketpp::lib::asio::ssl::context>(
                websocketpp::lib::asio::ssl::context::sslv23);

            try {
                ctx->set_options(websocketpp::lib::asio::ssl::context::default_workarounds |
                               websocketpp::lib::asio::ssl::context::no_sslv2 |
                               websocketpp::lib::asio::ssl::context::no_sslv3 |
                               websocketpp::lib::asio::ssl::context::single_dh_use);

                // Set verify mode to none to accept self-signed certificates
                ctx->set_verify_mode(websocketpp::lib::asio::ssl::verify_none);
            } catch (std::exception &e) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: TLS init error: %s", e.what());
            }
            return ctx;
        });

        _tlsClient->set_user_agent("UberSDR_Soapy/1.0");

        _tlsClient->set_message_handler([this](websocketpp::connection_hdl hdl, tls_message_ptr msg) {
            handleTLSMessage(hdl, msg);
        });

        websocketpp::lib::error_code ec;
        tls_client::connection_ptr con = _tlsClient->get_connection(wsURL, ec);
        if (ec) {
            throw std::runtime_error("TLS WebSocket connection failed: " + ec.message());
        }

        _wsHandle = con->get_handle();
        _tlsClient->connect(con);

        _wsThread = std::thread([this]() {
            try {
                _tlsClient->run();
            } catch (const std::exception &e) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: TLS WebSocket thread error: %s", e.what());
            }
        });
    } else {
        // Reconstruct plain client to ensure clean state after previous stop()
        _plainClient.reset(new plain_client());

        // Plain WebSocket connection
        _plainClient->clear_access_channels(websocketpp::log::alevel::all);
        _plainClient->clear_error_channels(websocketpp::log::elevel::all);
        _plainClient->init_asio();

        _plainClient->set_user_agent("UberSDR_Soapy/1.0");

        _plainClient->set_message_handler([this](websocketpp::connection_hdl hdl, plain_message_ptr msg) {
            handlePlainMessage(hdl, msg);
        });

        websocketpp::lib::error_code ec;
        plain_client::connection_ptr con = _plainClient->get_connection(wsURL, ec);
        if (ec) {
            throw std::runtime_error("Plain WebSocket connection failed: " + ec.message());
        }

        _wsHandle = con->get_handle();
        _plainClient->connect(con);

        _wsThread = std::thread([this]() {
            try {
                _plainClient->run();
            } catch (const std::exception &e) {
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Plain WebSocket thread error: %s", e.what());
            }
        });
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    _connected = true;

    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: WebSocket connected");
}

void SoapyUberSDR::disconnectWebSocket()
{
    _connected = false;

    try {
        if (_useTLS && _tlsClient) {
            _tlsClient->close(_wsHandle, websocketpp::close::status::normal, "");
            _tlsClient->stop();
        } else if (_plainClient) {
            _plainClient->close(_wsHandle, websocketpp::close::status::normal, "");
            _plainClient->stop();
        }
    } catch (...) {}

    if (_wsThread.joinable())
        _wsThread.join();

    // Note: Client will be reconstructed in connectWebSocket() on next activation
    // This avoids the "invalid state" error from reusing a stopped client

    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: WebSocket disconnected");
}

// Helper function to discover local instances via mDNS
static std::vector<std::map<std::string, std::string>> discoverLocalInstances()
{
    std::vector<std::map<std::string, std::string>> instances;

    // Try to discover local instances using avahi-browse (Linux) or dns-sd (macOS)
    // This is a simple implementation that runs the system command

    #ifdef __linux__
    // Use avahi-browse on Linux
    FILE* pipe = popen("avahi-browse -t -r _ubersdr._tcp 2>/dev/null | grep -A 10 'hostname ='", "r");
    #elif __APPLE__
    // Use dns-sd on macOS
    FILE* pipe = popen("timeout 2 dns-sd -B _ubersdr._tcp 2>/dev/null", "r");
    #else
    // Not supported on other platforms
    return instances;
    #endif

    if (!pipe) {
        // avahi-browse not available - this is not an error, just means no local discovery
        return instances;
    }

    char buffer[256];
    std::string output;
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }
    pclose(pipe);

    // Parse avahi-browse output (Linux)
    #ifdef __linux__
    // Look for hostname and port in avahi-browse output
    // Format: "hostname = [ubersdr.local]" and "port = [8080]"
    // Prefer IPv4 over IPv6 by checking the address field
    std::map<std::string, std::map<std::string, std::string>> instanceMap;
    size_t pos = 0;
    while (true) {
        size_t hostnamePos = output.find("hostname = [", pos);
        if (hostnamePos == std::string::npos) break;

        size_t hostnameStart = hostnamePos + 12;
        size_t hostnameEnd = output.find("]", hostnameStart);
        if (hostnameEnd == std::string::npos) break;

        std::string hostname = output.substr(hostnameStart, hostnameEnd - hostnameStart);

        // Look for address after hostname to determine IPv4 vs IPv6 and capture the IP
        size_t addressPos = output.find("address = [", hostnameEnd);
        bool isIPv4 = false;
        std::string ipAddress;
        if (addressPos != std::string::npos && addressPos < hostnameEnd + 100) {
            size_t addressStart = addressPos + 11;
            size_t addressEnd = output.find("]", addressStart);
            if (addressEnd != std::string::npos) {
                ipAddress = output.substr(addressStart, addressEnd - addressStart);
                // Simple check: IPv4 addresses don't contain colons (except in port), IPv6 do
                isIPv4 = (ipAddress.find(':') == std::string::npos);
            }
        }

        // Look for port after hostname
        size_t portPos = output.find("port = [", hostnameEnd);
        if (portPos == std::string::npos || portPos > hostnameEnd + 200) {
            pos = hostnameEnd;
            continue;
        }

        size_t portStart = portPos + 8;
        size_t portEnd = output.find("]", portStart);
        if (portEnd == std::string::npos) {
            pos = hostnameEnd;
            continue;
        }

        std::string port = output.substr(portStart, portEnd - portStart);

        // Remove .local suffix if present
        if (hostname.length() > 6 && hostname.substr(hostname.length() - 6) == ".local") {
            hostname = hostname.substr(0, hostname.length() - 6);
        }

        // Create unique key
        std::string uniqueKey = hostname + ":" + port;

        // Only add/replace if this is IPv4, or if we haven't seen this instance yet
        if (isIPv4 || instanceMap.find(uniqueKey) == instanceMap.end()) {
            std::map<std::string, std::string> instance;
            instance["name"] = hostname;
            // Use IP address instead of .local hostname for better compatibility
            instance["host"] = isIPv4 && !ipAddress.empty() ? ipAddress : hostname + ".local";
            instance["port"] = port;
            instance["tls"] = "false";
            instance["public_iq_modes"] = "iq48,iq96,iq192,iq384";
            instance["local"] = "true";
            instanceMap[uniqueKey] = instance;
        }

        pos = portEnd;
    }

    // Convert map to vector
    for (const auto& pair : instanceMap) {
        instances.push_back(pair.second);
    }
    #endif

    return instances;
}

// Helper function to fetch public instances from API
static std::vector<std::map<std::string, std::string>> fetchPublicInstances()
{
    std::vector<std::map<std::string, std::string>> instances;
    
    CURL *curl = curl_easy_init();
    if (!curl) {
        return instances;
    }
    
    std::string response;
    std::string apiURL = "https://instances.ubersdr.org/api/instances";
    
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "User-Agent: UberSDR_Soapy/1.0");
    
    curl_easy_setopt(curl, CURLOPT_URL, apiURL.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, soapy_curl_write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    
    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        return instances;
    }
    
    // Simple JSON parsing for instances array
    // Look for "instances":[...] and extract each instance
    size_t instancesPos = response.find("\"instances\"");
    if (instancesPos == std::string::npos) {
        // Try parsing as direct array
        instancesPos = 0;
    } else {
        instancesPos = response.find("[", instancesPos);
    }
    
    if (instancesPos == std::string::npos) {
        return instances;
    }
    
    // Parse each instance object
    size_t pos = instancesPos;
    while (true) {
        size_t objStart = response.find("{", pos);
        if (objStart == std::string::npos) break;
        
        size_t objEnd = response.find("}", objStart);
        if (objEnd == std::string::npos) break;
        
        std::string instanceObj = response.substr(objStart, objEnd - objStart + 1);
        
        // Extract fields
        std::map<std::string, std::string> instance;
        
        // Helper lambda to extract JSON string value
        auto extractValue = [&instanceObj](const std::string &key) -> std::string {
            size_t keyPos = instanceObj.find("\"" + key + "\"");
            if (keyPos == std::string::npos) return "";
            
            size_t colonPos = instanceObj.find(":", keyPos);
            if (colonPos == std::string::npos) return "";
            
            size_t valueStart = instanceObj.find_first_not_of(" \t\n\r", colonPos + 1);
            if (valueStart == std::string::npos) return "";
            
            if (instanceObj[valueStart] == '"') {
                // String value
                valueStart++;
                size_t valueEnd = instanceObj.find("\"", valueStart);
                if (valueEnd == std::string::npos) return "";
                return instanceObj.substr(valueStart, valueEnd - valueStart);
            } else if (instanceObj[valueStart] == 't') {
                // true
                return "true";
            } else if (instanceObj[valueStart] == 'f') {
                // false
                return "false";
            } else {
                // Number
                size_t valueEnd = instanceObj.find_first_of(",}", valueStart);
                if (valueEnd == std::string::npos) return "";
                return instanceObj.substr(valueStart, valueEnd - valueStart);
            }
        };
        
        instance["name"] = extractValue("name");
        instance["host"] = extractValue("host");
        instance["port"] = extractValue("port");
        instance["tls"] = extractValue("tls");
        instance["callsign"] = extractValue("callsign");
        instance["location"] = extractValue("location");
        
        // Extract public_iq_modes array
        size_t modesPos = instanceObj.find("\"public_iq_modes\"");
        if (modesPos != std::string::npos) {
            size_t arrayStart = instanceObj.find("[", modesPos);
            size_t arrayEnd = instanceObj.find("]", arrayStart);
            
            if (arrayStart != std::string::npos && arrayEnd != std::string::npos) {
                std::string modesArray = instanceObj.substr(arrayStart + 1, arrayEnd - arrayStart - 1);
                
                // Parse each mode in the array and concatenate with commas
                std::string publicModes;
                size_t modePos = 0;
                while (modePos < modesArray.length()) {
                    size_t quoteStart = modesArray.find("\"", modePos);
                    if (quoteStart == std::string::npos) break;
                    
                    size_t quoteEnd = modesArray.find("\"", quoteStart + 1);
                    if (quoteEnd == std::string::npos) break;
                    
                    std::string mode = modesArray.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
                    if (!publicModes.empty()) publicModes += ",";
                    publicModes += mode;
                    modePos = quoteEnd + 1;
                }
                
                instance["public_iq_modes"] = publicModes;
            }
        }
        
        // Only add if we have host, port, and at least one public IQ mode
        if (!instance["host"].empty() && !instance["port"].empty() && !instance["public_iq_modes"].empty()) {
            instances.push_back(instance);
        }
        
        pos = objEnd + 1;
        
        // Check if we've reached the end of the array
        size_t nextObj = response.find("{", pos);
        size_t arrayEnd = response.find("]", pos);
        if (arrayEnd != std::string::npos && (nextObj == std::string::npos || arrayEnd < nextObj)) {
            break;
        }
    }
    
    return instances;
}

// Find available devices
static SoapySDR::KwargsList findUberSDR(const SoapySDR::Kwargs &args)
{
    SoapySDR::KwargsList results;
    size_t localCount = 0;  // Track number of local instances for sorting
    
    if (args.count("driver") && args.at("driver") != "ubersdr")
        return results;
    
    std::vector<std::string> modes = {"iq48", "iq96", "iq192", "iq384"};
    if (args.count("mode")) {
        std::string requestedMode = args.at("mode");
        if (std::find(modes.begin(), modes.end(), requestedMode) != modes.end())
            modes = {requestedMode};
        else
            return results;
    }
    
    // Check if manual server is specified
    if (args.count("server")) {
        // Manual mode - use specified server
        std::string serverURL = args.at("server");
        
        for (const auto& mode : modes) {
            // Convert mode to bandwidth display (e.g., "iq48" -> "48 kHz")
            std::string bandwidth = mode.substr(2) + " kHz"; // Remove "iq" prefix and add " kHz"
            
            SoapySDR::Kwargs dev;
            dev["driver"] = "ubersdr";
            dev["server"] = serverURL;
            dev["mode"] = mode;
            dev["label"] = "KA9Q UberSDR " + bandwidth;
            dev["serial"] = serverURL + ":" + mode;
            results.push_back(dev);
        }
    } else {
        // Automatic discovery mode - discover local and fetch public instances
        SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Discovering local and public instances...");

        // First, discover local instances via mDNS
        auto localInstances = discoverLocalInstances();
        if (!localInstances.empty()) {
            SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Found %zu local instance(s)", localInstances.size());

            // Create devices for each local instance
            for (const auto& instance : localInstances) {
                std::string host = instance.at("host");
                std::string port = instance.at("port");
                std::string name = instance.count("name") ? instance.at("name") : host;

                // Parse public_iq_modes
                std::vector<std::string> publicModes;
                if (instance.count("public_iq_modes")) {
                    std::string modesStr = instance.at("public_iq_modes");
                    size_t pos = 0;
                    while (pos < modesStr.length()) {
                        size_t commaPos = modesStr.find(",", pos);
                        if (commaPos == std::string::npos) {
                            publicModes.push_back(modesStr.substr(pos));
                            break;
                        }
                        publicModes.push_back(modesStr.substr(pos, commaPos - pos));
                        pos = commaPos + 1;
                    }
                }

                // Build WebSocket URL
                std::string serverURL = "ws://" + host + ":" + port + "/ws";

                // Only create devices for available IQ modes
                for (const auto& mode : publicModes) {
                    // Convert mode to bandwidth display (e.g., "iq48" -> "48 kHz")
                    std::string bandwidth = mode.substr(2) + " kHz"; // Remove "iq" prefix and add " kHz"

                    SoapySDR::Kwargs dev;
                    dev["driver"] = "ubersdr";
                    dev["server"] = serverURL;
                    dev["mode"] = mode;
                    dev["label"] = "[Local] " + name + " " + bandwidth;
                    dev["serial"] = serverURL + ":" + mode;
                    results.push_back(dev);
                }
            }
            
            // Sort local instances alphabetically by label
            localCount = results.size();
            if (localCount > 0) {
                std::sort(results.begin(), results.end(),
                    [](const SoapySDR::Kwargs& a, const SoapySDR::Kwargs& b) {
                        return a.at("label") < b.at("label");
                    });
            }
        }

        // Then fetch public instances
        auto instances = fetchPublicInstances();

        if (instances.empty()) {
            SoapySDR::log(SOAPY_SDR_WARNING, "SoapyUberSDR: No public instances found, using localhost");
            // Fallback to localhost
            std::string serverURL = "ws://localhost:8080/ws";
            for (const auto& mode : modes) {
                // Convert mode to bandwidth display (e.g., "iq48" -> "48 kHz")
                std::string bandwidth = mode.substr(2) + " kHz"; // Remove "iq" prefix and add " kHz"
                
                SoapySDR::Kwargs dev;
                dev["driver"] = "ubersdr";
                dev["server"] = serverURL;
                dev["mode"] = mode;
                dev["label"] = "KA9Q UberSDR (localhost) " + bandwidth;
                dev["serial"] = serverURL + ":" + mode;
                results.push_back(dev);
            }
        } else {
            SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Found %zu public instance(s)", instances.size());
            
            // Helper function to sanitize strings for device string format
            // Removes/replaces characters that break SoapySDR's comma-separated key=value format
            auto sanitizeForDeviceString = [](const std::string& str) -> std::string {
                std::string result;
                for (char c : str) {
                    if (c == ',') {
                        // Replace commas with semicolons to avoid breaking device string parsing
                        result += ';';
                    } else if (c == '=' || c == '\n' || c == '\r' || c == '\t') {
                        // Skip characters that break key=value format or are control characters
                        continue;
                    } else {
                        result += c;
                    }
                }
                // Trim leading/trailing whitespace
                size_t start = result.find_first_not_of(" ");
                size_t end = result.find_last_not_of(" ");
                if (start != std::string::npos && end != std::string::npos) {
                    return result.substr(start, end - start + 1);
                }
                return result;
            };

            // Create devices for each public instance
            for (const auto& instance : instances) {
                std::string host = instance.at("host");
                std::string port = instance.at("port");
                bool tls = (instance.count("tls") && instance.at("tls") == "true");
                std::string name = sanitizeForDeviceString(instance.count("name") ? instance.at("name") : host);
                std::string callsign = sanitizeForDeviceString(instance.count("callsign") ? instance.at("callsign") : "");
                std::string location = sanitizeForDeviceString(instance.count("location") ? instance.at("location") : "");
                
                // Parse public_iq_modes
                std::vector<std::string> publicModes;
                if (instance.count("public_iq_modes")) {
                    std::string modesStr = instance.at("public_iq_modes");
                    size_t pos = 0;
                    while (pos < modesStr.length()) {
                        size_t commaPos = modesStr.find(",", pos);
                        if (commaPos == std::string::npos) {
                            publicModes.push_back(modesStr.substr(pos));
                            break;
                        }
                        publicModes.push_back(modesStr.substr(pos, commaPos - pos));
                        pos = commaPos + 1;
                    }
                }
                
                // Skip instance if no public modes
                if (publicModes.empty()) {
                    continue;
                }
                
                // Build WebSocket URL
                std::string protocol = tls ? "wss" : "ws";
                std::string serverURL = protocol + "://" + host + ":" + port + "/ws";
                
                // Create label with station info - keep it concise for dropdown display
                std::string stationInfo;
                if (!callsign.empty()) {
                    // Use callsign as primary identifier if available
                    stationInfo = callsign;
                } else if (!name.empty()) {
                    // Otherwise use name
                    stationInfo = name;
                } else {
                    // Fallback to host
                    stationInfo = host;
                }
                
                // Only create devices for public IQ modes
                for (const auto& mode : publicModes) {
                    // Convert mode to bandwidth display (e.g., "iq48" -> "48 kHz")
                    std::string bandwidth = mode.substr(2) + " kHz"; // Remove "iq" prefix and add " kHz"

                    // Create a short serial number for display (just identifier + mode)
                    std::string shortSerial = stationInfo + ":" + mode;

                    SoapySDR::Kwargs dev;
                    dev["driver"] = "ubersdr";
                    dev["server"] = serverURL;
                    dev["mode"] = mode;
                    dev["label"] = stationInfo + " " + bandwidth;
                    dev["serial"] = shortSerial;
                    if (!callsign.empty()) {
                        dev["callsign"] = callsign;
                    }
                    if (!location.empty()) {
                        dev["location"] = location;
                    }
                    results.push_back(dev);
                }
            }
        }
    }
    
    // Sort public instances alphabetically by label (after local instances)
    // Local instances were already sorted, so we only sort the newly added public instances
    if (results.size() > localCount) {
        std::sort(results.begin() + localCount, results.end(),
            [](const SoapySDR::Kwargs& a, const SoapySDR::Kwargs& b) {
                return a.at("label") < b.at("label");
            });
    }
    
    return results;
}

// Make device instance
static SoapySDR::Device *makeUberSDR(const SoapySDR::Kwargs &args)
{
    return new SoapyUberSDR(args);
}

// Registration
static SoapySDR::Registry registerUberSDR("ubersdr", &findUberSDR, &makeUberSDR, SOAPY_SDR_ABI_VERSION);
