#ifndef ubersdr_h
#define ubersdr_h 1

#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <atomic>
#include <condition_variable>
#include "snd.h"

// UberSDR WebSocket-based audio input
// Connects to ka9q_ubersdr server for network-based SDR audio
class UberSDRSoundIn : public SoundIn {
private:
    // Audio format
    enum AudioFormat {
        FORMAT_OPUS,
        FORMAT_PCM
    };
    AudioFormat audio_format_;
    
    // Connection type
    enum ConnectionType {
        CONN_WEBSOCKET,
        CONN_UNIX_SOCKET
    };
    ConnectionType connection_type_;
    std::string unix_socket_path_;
    
    std::string host_;
    int port_;
    int frequency_;
    std::string mode_;
    int rate_;
    std::string user_session_id_;
    
    // Circular buffer for audio samples
    int n_;
    double *buf_;
    volatile int wi_;
    volatile int ri_;
    volatile double time_;
    std::mutex buf_mutex_;
    
    // WebSocket connection thread
    std::thread ws_thread_;
    std::atomic<bool> running_;
    std::atomic<bool> connected_;
    
    // Opus decoder state
    void *opus_decoder_;  // OpusDecoder*
    int opus_sample_rate_;
    int opus_channels_;
    
    // Signal quality metrics (from version 2 protocol)
    float baseband_power_;
    float noise_density_;
    float snr_;
    
    // Bandwidth settings
    int bandwidth_low_;
    int bandwidth_high_;
    
    // WebSocket implementation
    void websocket_loop();
    void process_binary_packet(const uint8_t* data, size_t len);
    void process_opus_packet(const uint8_t* data, size_t len);
    void process_pcm_packet(const uint8_t* data, size_t len);
    bool validate_connection();
    void send_tune_command(int ws_fd);
    void send_heartbeat(int ws_fd);
    int connect_websocket();
    void add_samples_to_buffer(const double* samples, int count);
    
    // Unix socket implementation
    void unix_socket_loop();
    int connect_unix_socket();
    
public:
    UberSDRSoundIn(std::string chan, int rate);
    ~UberSDRSoundIn();
    
    void start() override;
    std::vector<double> get(int n, double &t0, int latest) override;
    int rate() override { return rate_; }
    int set_freq(int hz) override;
    
    // Get signal quality metrics
    float get_snr() const { return snr_; }
    float get_baseband_power() const { return baseband_power_; }
    float get_noise_density() const { return noise_density_; }
};

#endif
