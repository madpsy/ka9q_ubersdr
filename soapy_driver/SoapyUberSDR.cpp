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
#include <curl/curl.h>

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

typedef websocketpp::client<websocketpp::config::asio_client> client;
typedef websocketpp::config::asio_client::message_type::ptr message_ptr;

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
    bool _bypassed;
    
    // WebSocket client
    client _wsClient;
    websocketpp::connection_hdl _wsHandle;
    std::thread _wsThread;
    std::atomic<bool> _streaming;
    std::atomic<bool> _connected;
    
    // I/Q buffer management
    std::queue<std::vector<std::complex<float>>> _iqBuffers;
    std::mutex _bufferMutex;
    std::condition_variable _bufferCV;
    
    // Helper functions
    double modeToSampleRate(const std::string &mode) const;
    std::string sampleRateToMode(double rate) const;
    void handleMessage(websocketpp::connection_hdl hdl, message_ptr msg);
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
    _bypassed = false;
    _userSessionID = generateUUID();
    
    if (!_password.empty()) {
        SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Created device for %s mode=%s (with password)",
                       _serverURL.c_str(), _currentMode.c_str());
    } else {
        SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Created device for %s mode=%s",
                       _serverURL.c_str(), _currentMode.c_str());
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
    
    auto deadline = std::chrono::steady_clock::now() + 
                   std::chrono::microseconds(timeoutUs);
    
    while (_iqBuffers.empty() && _streaming) {
        if (_bufferCV.wait_until(lock, deadline) == std::cv_status::timeout)
            return SOAPY_SDR_TIMEOUT;
    }
    
    if (!_streaming)
        return SOAPY_SDR_STREAM_ERROR;
    
    if (_iqBuffers.empty())
        return SOAPY_SDR_TIMEOUT;
    
    auto &iqData = _iqBuffers.front();
    size_t samplesToRead = std::min(numElems, iqData.size());
    
    std::complex<float> *outBuff = static_cast<std::complex<float>*>(buffs[0]);
    std::copy(iqData.begin(), iqData.begin() + samplesToRead, outBuff);
    
    _iqBuffers.pop();
    flags = 0;
    timeNs = 0;
    
    return samplesToRead;
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

void SoapyUberSDR::handleMessage(websocketpp::connection_hdl hdl, message_ptr msg)
{
    try {
        std::string payload = msg->get_payload();
        
        size_t typePos = payload.find("\"type\"");
        if (typePos == std::string::npos) return;
        
        size_t audioPos = payload.find("\"audio\"", typePos);
        if (audioPos == std::string::npos) return;
        
        size_t dataPos = payload.find("\"data\"");
        if (dataPos == std::string::npos) return;
        
        size_t dataStart = payload.find("\"", dataPos + 6) + 1;
        size_t dataEnd = payload.find("\"", dataStart);
        if (dataStart == std::string::npos || dataEnd == std::string::npos) return;
        
        std::string base64Data = payload.substr(dataStart, dataEnd - dataStart);
        
        std::vector<uint8_t> pcmBytes = base64_decode(base64Data);
        
        size_t numSamples = pcmBytes.size() / 4;
        std::vector<std::complex<float>> iqSamples(numSamples);
        
        for (size_t i = 0; i < numSamples; i++) {
            int16_t I = (pcmBytes[i*4] << 8) | pcmBytes[i*4+1];
            int16_t Q = (pcmBytes[i*4+2] << 8) | pcmBytes[i*4+3];
            iqSamples[i] = std::complex<float>(I / 32768.0f, Q / 32768.0f);
        }
        
        std::lock_guard<std::mutex> lock(_bufferMutex);
        _iqBuffers.push(std::move(iqSamples));
        _bufferCV.notify_one();
        
    } catch (const std::exception &e) {
        SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Message handling error: %s", e.what());
    }
}

void SoapyUberSDR::sendTuneCommand(uint64_t freq, const std::string &mode)
{
    try {
        std::stringstream ss;
        ss << "{\"type\":\"tune\",\"frequency\":" << freq << ",\"mode\":\"" << mode << "\"}";
        _wsClient.send(_wsHandle, ss.str(), websocketpp::frame::opcode::text);
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

    // Simple JSON parsing for "allowed" and "bypassed" fields
    // For wide IQ modes, BOTH "allowed" and "bypassed" must be true
    size_t allowedPos = response.find("\"allowed\"");
    if (allowedPos != std::string::npos) {
        size_t truePos = response.find("true", allowedPos);
        size_t falsePos = response.find("false", allowedPos);

        if (truePos != std::string::npos && (falsePos == std::string::npos || truePos < falsePos)) {
            // Connection is allowed, now check for "bypassed" field
            size_t bypassedPos = response.find("\"bypassed\"");
            if (bypassedPos != std::string::npos) {
                size_t bypassedTruePos = response.find("true", bypassedPos);
                size_t bypassedFalsePos = response.find("false", bypassedPos);

                if (bypassedTruePos != std::string::npos && (bypassedFalsePos == std::string::npos || bypassedTruePos < bypassedFalsePos)) {
                    _bypassed = true;
                    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Connection allowed and bypassed - wide IQ modes available");
                    return true;
                } else {
                    _bypassed = false;
                    SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Connection allowed but not bypassed - wide IQ modes require bypass password");
                    return false;
                }
            } else {
                // No bypassed field in response - assume not bypassed
                _bypassed = false;
                SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: Connection allowed but not bypassed - wide IQ modes require bypass password");
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
    
    SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Connecting to %s", wsURL.c_str());
    
    _wsClient.clear_access_channels(websocketpp::log::alevel::all);
    _wsClient.clear_error_channels(websocketpp::log::elevel::all);
    _wsClient.init_asio();
    
    // Set User-Agent header
    _wsClient.set_user_agent("UberSDR_Soapy/1.0");
    
    _wsClient.set_message_handler([this](websocketpp::connection_hdl hdl, message_ptr msg) {
        handleMessage(hdl, msg);
    });
    
    websocketpp::lib::error_code ec;
    client::connection_ptr con = _wsClient.get_connection(wsURL, ec);
    if (ec) {
        throw std::runtime_error("WebSocket connection failed: " + ec.message());
    }
    
    _wsHandle = con->get_handle();
    _wsClient.connect(con);
    
    _wsThread = std::thread([this]() {
        try {
            _wsClient.run();
        } catch (const std::exception &e) {
            SoapySDR::logf(SOAPY_SDR_ERROR, "SoapyUberSDR: WebSocket thread error: %s", e.what());
        }
    });
    
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    _connected = true;
    
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: WebSocket connected");
}

void SoapyUberSDR::disconnectWebSocket()
{
    _connected = false;
    
    try {
        _wsClient.close(_wsHandle, websocketpp::close::status::normal, "");
        _wsClient.stop();
    } catch (...) {}
    
    if (_wsThread.joinable())
        _wsThread.join();
    
    SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: WebSocket disconnected");
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
        
        // Only add if we have host and port
        if (!instance["host"].empty() && !instance["port"].empty()) {
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
            SoapySDR::Kwargs dev;
            dev["driver"] = "ubersdr";
            dev["server"] = serverURL;
            dev["mode"] = mode;
            dev["label"] = "KA9Q UberSDR " + mode;
            dev["serial"] = serverURL + ":" + mode;
            results.push_back(dev);
        }
    } else {
        // Automatic discovery mode - fetch public instances
        SoapySDR::log(SOAPY_SDR_INFO, "SoapyUberSDR: Discovering public instances...");
        
        auto instances = fetchPublicInstances();
        
        if (instances.empty()) {
            SoapySDR::log(SOAPY_SDR_WARNING, "SoapyUberSDR: No public instances found, using localhost");
            // Fallback to localhost
            std::string serverURL = "ws://localhost:8080/ws";
            for (const auto& mode : modes) {
                SoapySDR::Kwargs dev;
                dev["driver"] = "ubersdr";
                dev["server"] = serverURL;
                dev["mode"] = mode;
                dev["label"] = "KA9Q UberSDR (localhost) " + mode;
                dev["serial"] = serverURL + ":" + mode;
                results.push_back(dev);
            }
        } else {
            SoapySDR::logf(SOAPY_SDR_INFO, "SoapyUberSDR: Found %zu public instance(s)", instances.size());
            
            // Create devices for each public instance
            for (const auto& instance : instances) {
                std::string host = instance.at("host");
                std::string port = instance.at("port");
                bool tls = (instance.count("tls") && instance.at("tls") == "true");
                std::string name = instance.count("name") ? instance.at("name") : host;
                std::string callsign = instance.count("callsign") ? instance.at("callsign") : "";
                std::string location = instance.count("location") ? instance.at("location") : "";
                
                // Build WebSocket URL
                std::string protocol = tls ? "wss" : "ws";
                std::string serverURL = protocol + "://" + host + ":" + port + "/ws";
                
                // Create label with station info
                std::string stationInfo = name;
                if (!callsign.empty()) {
                    stationInfo += " (" + callsign + ")";
                }
                if (!location.empty()) {
                    stationInfo += " - " + location;
                }
                
                for (const auto& mode : modes) {
                    SoapySDR::Kwargs dev;
                    dev["driver"] = "ubersdr";
                    dev["server"] = serverURL;
                    dev["mode"] = mode;
                    dev["label"] = stationInfo + " " + mode;
                    dev["serial"] = serverURL + ":" + mode;
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
    
    return results;
}

// Make device instance
static SoapySDR::Device *makeUberSDR(const SoapySDR::Kwargs &args)
{
    return new SoapyUberSDR(args);
}

// Registration
static SoapySDR::Registry registerUberSDR("ubersdr", &findUberSDR, &makeUberSDR, SOAPY_SDR_ABI_VERSION);
