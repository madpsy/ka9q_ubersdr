#include "ubersdr.h"
#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <opus/opus.h>
#include <curl/curl.h>

// Simple WebSocket implementation
// Frame format: [FIN(1bit)|RSV(3bits)|OPCODE(4bits)][MASK(1bit)|LEN(7bits)][Extended payload length][Masking key][Payload]

#define WS_OPCODE_TEXT 0x1
#define WS_OPCODE_BINARY 0x2
#define WS_OPCODE_CLOSE 0x8
#define WS_OPCODE_PING 0x9
#define WS_OPCODE_PONG 0xA

// Generate UUID for session ID (UUID v4 format)
static std::string generate_uuid() {
    char uuid[37];  // Exactly 36 chars + null terminator
    snprintf(uuid, sizeof(uuid), "%08x-%04x-4%03x-%04x-%012llx",
            (unsigned int)rand(),
            (unsigned int)(rand() & 0xFFFF),
            (unsigned int)(rand() & 0xFFF),
            (unsigned int)((rand() & 0x3FFF) | 0x8000),
            ((unsigned long long)rand() << 32) | (unsigned long long)rand());
    uuid[36] = '\0';  // Ensure null termination
    return std::string(uuid);
}

// HTTP POST helper for connection validation
static bool http_post_connection(const std::string& host, int port, const std::string& session_id) {
    CURL *curl = curl_easy_init();
    if (!curl) {
        fprintf(stderr, "UberSDR: Failed to initialize CURL\n");
        return false;
    }
    
    char url[256];
    snprintf(url, sizeof(url), "http://%s:%d/connection", host.c_str(), port);
    
    char json[256];
    snprintf(json, sizeof(json), "{\"user_session_id\":\"%s\"}", session_id.c_str());
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: Validating connection to %s\n", url);
    // fprintf(stderr, "UberSDR: POST data: %s\n", json);
    
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "User-Agent: UberSDR JS8Call");
    
    // Buffer to capture response
    std::string response_body;
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, +[](void *ptr, size_t size, size_t nmemb, void *userdata) -> size_t {
        ((std::string*)userdata)->append((char*)ptr, size * nmemb);
        return size * nmemb;
    });
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);
    
    CURLcode res = curl_easy_perform(curl);
    long response_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code);
    
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        fprintf(stderr, "UberSDR: Connection validation HTTP error: %s\n", curl_easy_strerror(res));
        fprintf(stderr, "UberSDR: This usually means the server is not reachable\n");
        return false;
    }
    
    // Reduced verbosity - only log errors
    // fprintf(stderr, "UberSDR: Connection validation response: HTTP %ld\n", response_code);
    // fprintf(stderr, "UberSDR: Response body: %s\n", response_body.c_str());
    
    if (response_code != 200) {
        fprintf(stderr, "UberSDR: Server rejected connection (HTTP %ld)\n", response_code);
        return false;
    }
    
    return true;
}

// WebSocket handshake
static bool websocket_handshake(int fd, const std::string& host, int port, const std::string& path) {
    char request[1024];
    snprintf(request, sizeof(request),
             "GET %s HTTP/1.1\r\n"
             "Host: %s:%d\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
             "Sec-WebSocket-Version: 13\r\n"
             "\r\n",
             path.c_str(), host.c_str(), port);
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: Sending WebSocket handshake:\n%s", request);
    
    if (send(fd, request, strlen(request), 0) < 0) {
        perror("WebSocket handshake send");
        return false;
    }
    
    // Read response with timeout
    fd_set readfds;
    struct timeval tv;
    FD_ZERO(&readfds);
    FD_SET(fd, &readfds);
    tv.tv_sec = 5;
    tv.tv_usec = 0;
    
    int ret = select(fd + 1, &readfds, NULL, NULL, &tv);
    if (ret <= 0) {
        fprintf(stderr, "WebSocket handshake timeout or error\n");
        return false;
    }
    
    // Read response
    char response[2048];
    int n = recv(fd, response, sizeof(response) - 1, 0);
    if (n <= 0) {
        fprintf(stderr, "WebSocket handshake failed to receive response (n=%d)\n", n);
        return false;
    }
    response[n] = '\0';
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: Received WebSocket handshake response (%d bytes):\n%s\n", n, response);
    
    // Check for "101 Switching Protocols"
    if (strstr(response, "101") == NULL && strstr(response, "Switching Protocols") == NULL) {
        fprintf(stderr, "WebSocket handshake failed: missing 101 status\n");
        return false;
    }
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: WebSocket handshake successful\n");
    return true;
}

// Send WebSocket frame
static bool ws_send_frame(int fd, uint8_t opcode, const uint8_t* data, size_t len) {
    uint8_t header[14];
    int header_len = 2;
    
    // FIN bit set, opcode
    header[0] = 0x80 | opcode;
    
    // Mask bit set (client must mask), payload length
    if (len < 126) {
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header[1] = 0x80 | 126;
        header[2] = (len >> 8) & 0xFF;
        header[3] = len & 0xFF;
        header_len = 4;
    } else {
        header[1] = 0x80 | 127;
        for (int i = 0; i < 8; i++) {
            header[2 + i] = (len >> (56 - i * 8)) & 0xFF;
        }
        header_len = 10;
    }
    
    // Masking key (random)
    uint8_t mask[4];
    for (int i = 0; i < 4; i++) {
        mask[i] = rand() & 0xFF;
        header[header_len++] = mask[i];
    }
    
    // Send header
    if (send(fd, header, header_len, 0) < 0) {
        return false;
    }
    
    // Send masked payload
    uint8_t *masked = (uint8_t*)malloc(len);
    for (size_t i = 0; i < len; i++) {
        masked[i] = data[i] ^ mask[i % 4];
    }
    
    bool success = send(fd, masked, len, 0) == (ssize_t)len;
    free(masked);
    
    return success;
}

// Send JSON message
static bool ws_send_json(int fd, const std::string& json) {
    return ws_send_frame(fd, WS_OPCODE_TEXT, (const uint8_t*)json.c_str(), json.length());
}

UberSDRSoundIn::UberSDRSoundIn(std::string chan, int rate) {
    // Parse chan format:
    // WebSocket: "host:port,frequency" (always uses Opus)
    // Unix socket: "unix:/path/to/socket,frequency" (always uses PCM)
    
    if (chan.find("unix:") == 0) {
        // Unix domain socket mode - always PCM
        connection_type_ = CONN_UNIX_SOCKET;
        audio_format_ = FORMAT_PCM;
        
        size_t comma = chan.find(',');
        if (comma == std::string::npos) {
            fprintf(stderr, "UberSDR: Invalid unix socket format. Expected 'unix:/path,frequency'\n");
            fprintf(stderr, "Example: unix:/tmp/ubersdr.sock,14074000\n");
            exit(1);
        }
        
        unix_socket_path_ = chan.substr(5, comma - 5); // Skip "unix:"
        frequency_ = std::stoi(chan.substr(comma + 1));
        
        fprintf(stderr, "UberSDR: Unix socket mode: %s, freq=%d Hz, format=PCM\n",
                unix_socket_path_.c_str(), frequency_);
    } else {
        // WebSocket mode - always Opus
        connection_type_ = CONN_WEBSOCKET;
        audio_format_ = FORMAT_OPUS;
        
        size_t colon = chan.find(':');
        size_t comma = chan.find(',');
        
        if (colon == std::string::npos || comma == std::string::npos) {
            fprintf(stderr, "UberSDR: Invalid chan format. Expected 'host:port,frequency'\n");
            fprintf(stderr, "Example: 44.31.241.13:8080,14074000\n");
            exit(1);
        }
        
        host_ = chan.substr(0, colon);
        port_ = std::stoi(chan.substr(colon + 1, comma - colon - 1));
        frequency_ = std::stoi(chan.substr(comma + 1));
        
        fprintf(stderr, "UberSDR: WebSocket mode: %s:%d, freq=%d Hz, format=Opus\n",
                host_.c_str(), port_, frequency_);
    }
    
    // JS8Call only supports USB mode
    mode_ = "usb";
    bandwidth_low_ = 0;
    bandwidth_high_ = 3200;
    
    rate_ = (rate == -1) ? 12000 : rate;
    user_session_id_ = generate_uuid();
    
    // Allocate 60-second circular buffer
    n_ = rate_ * 60;
    buf_ = new double[n_];
    wi_ = 0;
    ri_ = 0;
    time_ = -1;
    
    running_ = false;
    connected_ = false;
    
    // Only initialize Opus decoder if using Opus format
    if (audio_format_ == FORMAT_OPUS) {
        int opus_rate = 12000;  // Opus sample rate
        int error;
        opus_decoder_ = opus_decoder_create(opus_rate, 1, &error);
        if (error != OPUS_OK) {
            fprintf(stderr, "Failed to create Opus decoder: %s (tried rate=%d)\n", opus_strerror(error), opus_rate);
            fprintf(stderr, "Note: Opus only supports 8000, 12000, 16000, 24000, or 48000 Hz\n");
            exit(1);
        }
        opus_sample_rate_ = opus_rate;
        opus_channels_ = 1;
        fprintf(stderr, "UberSDR: Opus decoder created (rate=%d Hz, channels=%d)\n", opus_sample_rate_, opus_channels_);
    } else {
        opus_decoder_ = nullptr;
        opus_sample_rate_ = rate_;
        opus_channels_ = 1;
        fprintf(stderr, "UberSDR: PCM mode (rate=%d Hz, channels=%d)\n", rate_, opus_channels_);
    }
    
    // Initialize signal quality
    baseband_power_ = -999.0f;
    noise_density_ = -999.0f;
    snr_ = -999.0f;
}

UberSDRSoundIn::~UberSDRSoundIn() {
    running_ = false;
    if (ws_thread_.joinable()) {
        ws_thread_.join();
    }
    
    if (opus_decoder_) {
        opus_decoder_destroy((OpusDecoder*)opus_decoder_);
    }
    
    delete[] buf_;
}

void UberSDRSoundIn::start() {
    running_ = true;
    if (connection_type_ == CONN_WEBSOCKET) {
        ws_thread_ = std::thread(&UberSDRSoundIn::websocket_loop, this);
    } else {
        ws_thread_ = std::thread(&UberSDRSoundIn::unix_socket_loop, this);
    }
}

int UberSDRSoundIn::set_freq(int hz) {
    frequency_ = hz;
    // Mode will be updated by send_tune_command if needed
    return hz;
}

void UberSDRSoundIn::add_samples_to_buffer(const double* samples, int count) {
    std::lock_guard<std::mutex> lock(buf_mutex_);
    
    for (int i = 0; i < count; i++) {
        if (((wi_ + 1) % n_) != ri_) {
            buf_[wi_] = samples[i];
            wi_ = (wi_ + 1) % n_;
        } else {
            // Buffer overflow - drop samples
            break;
        }
    }
    
    time_ = now();
}

void UberSDRSoundIn::process_binary_packet(const uint8_t* data, size_t len) {
    if (audio_format_ == FORMAT_PCM) {
        process_pcm_packet(data, len);
    } else {
        process_opus_packet(data, len);
    }
}

void UberSDRSoundIn::process_opus_packet(const uint8_t* data, size_t len) {
    // Version 2 binary format:
    // [timestamp:8][sampleRate:4][channels:1][basebandPower:4][noiseDensity:4][opusData...]
    
    if (len < 21) {
        fprintf(stderr, "UberSDR: Opus packet too short: %zu bytes\n", len);
        return;
    }
    
    // Parse header (little-endian)
    uint64_t timestamp = 0;
    for (int i = 0; i < 8; i++) {
        timestamp |= ((uint64_t)data[i]) << (i * 8);
    }
    
    uint32_t sample_rate = 0;
    for (int i = 0; i < 4; i++) {
        sample_rate |= ((uint32_t)data[8 + i]) << (i * 8);
    }
    
    uint8_t channels = data[12];
    
    // Parse float32 values (little-endian)
    uint32_t bp_bits = 0, nd_bits = 0;
    for (int i = 0; i < 4; i++) {
        bp_bits |= ((uint32_t)data[13 + i]) << (i * 8);
        nd_bits |= ((uint32_t)data[17 + i]) << (i * 8);
    }
    
    float *bp_ptr = (float*)&bp_bits;
    float *nd_ptr = (float*)&nd_bits;
    baseband_power_ = *bp_ptr;
    noise_density_ = *nd_ptr;
    
    if (baseband_power_ > -900 && noise_density_ > -900) {
        snr_ = baseband_power_ - noise_density_;
    }
    
    // Decode Opus data
    const uint8_t* opus_data = data + 21;
    size_t opus_len = len - 21;
    
    // Decode to PCM (max frame size is 5760 for 120ms at 48kHz)
    int16_t pcm[5760 * 2];  // Stereo just in case
    int frame_size = opus_decode((OpusDecoder*)opus_decoder_, opus_data, opus_len, pcm, 5760, 0);
    
    if (frame_size < 0) {
        fprintf(stderr, "UberSDR: Opus decode error: %s\n", opus_strerror(frame_size));
        return;
    }
    
    // Convert to double
    double *samples = new double[frame_size];
    for (int i = 0; i < frame_size; i++) {
        samples[i] = pcm[i] / 32768.0;
    }
    
    // Downsample if needed (Opus outputs at 12000 Hz, we need 6000 Hz)
    if (opus_sample_rate_ != rate_) {
        // Simple 2:1 downsampling (take every other sample)
        int downsampled_size = frame_size / 2;
        double *downsampled = new double[downsampled_size];
        for (int i = 0; i < downsampled_size; i++) {
            downsampled[i] = samples[i * 2];
        }
        delete[] samples;
        samples = downsampled;
        frame_size = downsampled_size;
    }
    
    add_samples_to_buffer(samples, frame_size);
    delete[] samples;
}

void UberSDRSoundIn::process_pcm_packet(const uint8_t* data, size_t len) {
    // Version 2 binary format for PCM:
    // [timestamp:8][sampleRate:4][channels:1][basebandPower:4][noiseDensity:4][pcmData...]
    
    if (len < 21) {
        fprintf(stderr, "UberSDR: PCM packet too short: %zu bytes\n", len);
        return;
    }
    
    // Parse header (little-endian)
    uint64_t timestamp = 0;
    for (int i = 0; i < 8; i++) {
        timestamp |= ((uint64_t)data[i]) << (i * 8);
    }
    
    uint32_t sample_rate = 0;
    for (int i = 0; i < 4; i++) {
        sample_rate |= ((uint32_t)data[8 + i]) << (i * 8);
    }
    
    uint8_t channels = data[12];
    
    // Parse float32 values (little-endian)
    uint32_t bp_bits = 0, nd_bits = 0;
    for (int i = 0; i < 4; i++) {
        bp_bits |= ((uint32_t)data[13 + i]) << (i * 8);
        nd_bits |= ((uint32_t)data[17 + i]) << (i * 8);
    }
    
    float *bp_ptr = (float*)&bp_bits;
    float *nd_ptr = (float*)&nd_bits;
    baseband_power_ = *bp_ptr;
    noise_density_ = *nd_ptr;
    
    if (baseband_power_ > -900 && noise_density_ > -900) {
        snr_ = baseband_power_ - noise_density_;
    }
    
    // PCM data starts at byte 21 (int16_t samples)
    const int16_t* pcm_data = (const int16_t*)(data + 21);
    int frame_size = (len - 21) / sizeof(int16_t);
    
    // Convert to double
    double *samples = new double[frame_size];
    for (int i = 0; i < frame_size; i++) {
        samples[i] = pcm_data[i] / 32768.0;
    }
    
    // Resample if needed
    if ((int)sample_rate != rate_) {
        // Simple 2:1 downsampling if sample_rate is 2x rate_
        if (sample_rate == (uint32_t)(rate_ * 2)) {
            int downsampled_size = frame_size / 2;
            double *downsampled = new double[downsampled_size];
            for (int i = 0; i < downsampled_size; i++) {
                downsampled[i] = samples[i * 2];
            }
            delete[] samples;
            samples = downsampled;
            frame_size = downsampled_size;
        } else if (sample_rate != (uint32_t)rate_) {
            fprintf(stderr, "UberSDR: Warning: sample rate mismatch %d != %d\n",
                    sample_rate, rate_);
        }
    }
    
    add_samples_to_buffer(samples, frame_size);
    delete[] samples;
}

void UberSDRSoundIn::send_tune_command(int ws_fd) {
    char json[512];
    snprintf(json, sizeof(json),
             "{\"type\":\"tune\",\"frequency\":%d,\"mode\":\"%s\",\"bandwidthLow\":%d,\"bandwidthHigh\":%d}",
             frequency_, mode_.c_str(), bandwidth_low_, bandwidth_high_);
    ws_send_json(ws_fd, json);
}

void UberSDRSoundIn::send_heartbeat(int ws_fd) {
    ws_send_json(ws_fd, "{\"type\":\"ping\"}");
}

int UberSDRSoundIn::connect_websocket() {
    // Resolve hostname
    struct hostent *he = gethostbyname(host_.c_str());
    if (!he) {
        fprintf(stderr, "UberSDR: Failed to resolve host %s\n", host_.c_str());
        return -1;
    }
    
    // Create socket
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("UberSDR socket");
        return -1;
    }
    
    // Connect
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port_);
    memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);
    
    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("UberSDR connect");
        close(fd);
        return -1;
    }
    
    // Build WebSocket path (always uses Opus format)
    char path[1024];  // Increased buffer size
    snprintf(path, sizeof(path),
             "/ws?frequency=%d&mode=usb&user_session_id=%s&format=opus&version=2",
             frequency_, user_session_id_.c_str());
    
    // Perform WebSocket handshake
    if (!websocket_handshake(fd, host_, port_, path)) {
        close(fd);
        return -1;
    }
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: WebSocket connected\n");
    return fd;
}

void UberSDRSoundIn::websocket_loop() {
    // Validate connection first
    if (!http_post_connection(host_, port_, user_session_id_)) {
        fprintf(stderr, "UberSDR: Connection validation failed - cannot connect to server\n");
        fprintf(stderr, "UberSDR: Please check:\n");
        fprintf(stderr, "  1. Server is running at %s:%d\n", host_.c_str(), port_);
        fprintf(stderr, "  2. Server /connection endpoint is accessible\n");
        fprintf(stderr, "  3. No firewall blocking the connection\n");
        running_ = false;
        return;
    }
    
    // Reduced verbosity
    // fprintf(stderr, "UberSDR: Connection validation successful\n");
    
    while (running_) {
        int ws_fd = connect_websocket();
        if (ws_fd < 0) {
            fprintf(stderr, "UberSDR: Failed to connect, retrying in 5 seconds...\n");
            sleep(5);
            continue;
        }
        
        connected_ = true;
        // Reduced verbosity
        // fprintf(stderr, "UberSDR: Connection established, sending tune command\n");

        // Send initial tune command
        send_tune_command(ws_fd);
        // fprintf(stderr, "UberSDR: Tune command sent\n");

        // Set socket to non-blocking for polling
        int flags = fcntl(ws_fd, F_GETFL, 0);
        fcntl(ws_fd, F_SETFL, flags | O_NONBLOCK);
        // fprintf(stderr, "UberSDR: Socket set to non-blocking, entering receive loop\n");
        
        time_t last_heartbeat = time(NULL);
        std::vector<uint8_t> frame_buffer;
        frame_buffer.reserve(65536);  // Reserve space but allow growth
        size_t frame_pos = 0;
        bool in_frame = false;
        uint8_t frame_opcode = 0;
        size_t frame_payload_len = 0;
        size_t frame_header_len = 0;
        
        while (running_ && connected_) {
            // Send heartbeat every 10 seconds
            time_t now_time = time(NULL);
            if (now_time - last_heartbeat >= 10) {
                send_heartbeat(ws_fd);
                last_heartbeat = now_time;
            }
            
            // Poll for data
            struct pollfd pfd;
            pfd.fd = ws_fd;
            pfd.events = POLLIN;
            
            int ret = poll(&pfd, 1, 100);  // 100ms timeout
            if (ret < 0) {
                perror("UberSDR poll");
                break;
            }
            
            if (ret == 0) {
                continue;  // Timeout, loop again
            }
            
            // Read data
            uint8_t buf[4096];
            ssize_t n = recv(ws_fd, buf, sizeof(buf), 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    continue;
                }
                fprintf(stderr, "UberSDR: Connection closed (n=%zd, errno=%d: %s)\n", n, errno, strerror(errno));
                break;
            }
            
            // Parse WebSocket frames
            for (ssize_t i = 0; i < n; ) {
                if (!in_frame) {
                    // Start of new frame
                    if (i + 1 >= n) {
                        fprintf(stderr, "UberSDR: Not enough bytes for frame header (need 2, have %zd)\n", n - i);
                        break;  // Need at least 2 bytes
                    }
                    
                    uint8_t byte0 = buf[i];
                    uint8_t byte1 = buf[i + 1];
                    
                    bool fin = (byte0 & 0x80) != 0;
                    frame_opcode = byte0 & 0x0F;
                    bool masked = (byte1 & 0x80) != 0;
                    frame_payload_len = byte1 & 0x7F;
                    
                    frame_header_len = 2;
                    i += 2;
                    
                    // Extended payload length
                    if (frame_payload_len == 126) {
                        if (i + 2 > n) {
                            fprintf(stderr, "UberSDR: Not enough bytes for extended length\n");
                            break;
                        }
                        frame_payload_len = ((uint16_t)buf[i] << 8) | buf[i + 1];
                        frame_header_len += 2;
                        i += 2;
                    } else if (frame_payload_len == 127) {
                        if (i + 8 > n) {
                            fprintf(stderr, "UberSDR: Not enough bytes for extended length (64-bit)\n");
                            break;
                        }
                        frame_payload_len = 0;
                        for (int j = 0; j < 8; j++) {
                            frame_payload_len = (frame_payload_len << 8) | buf[i + j];
                        }
                        frame_header_len += 8;
                        i += 8;
                    }
                    
                    // Skip masking key if present (server shouldn't mask)
                    if (masked) {
                        if (i + 4 > n) {
                            fprintf(stderr, "UberSDR: Not enough bytes for mask key\n");
                            break;
                        }
                        frame_header_len += 4;
                        i += 4;
                    }
                    
                    // Sanity check on payload length
                    if (frame_payload_len > 1024 * 1024) {  // 1MB max
                        fprintf(stderr, "UberSDR: Frame too large: %zu bytes, skipping\n", frame_payload_len);
                        in_frame = false;
                        break;
                    }
                    
                    frame_pos = 0;
                    frame_buffer.clear();
                    frame_buffer.reserve(frame_payload_len);
                    in_frame = true;
                    
                    if (!fin) {
                        fprintf(stderr, "UberSDR: Warning: fragmented frames not fully supported\n");
                    }
                    
                    // Continue to read payload in same iteration
                    continue;
                }
                
                // Accumulate frame payload
                size_t bytes_to_copy = std::min((size_t)(n - i), frame_payload_len - frame_pos);
                for (size_t j = 0; j < bytes_to_copy; j++) {
                    frame_buffer.push_back(buf[i + j]);
                }
                frame_pos += bytes_to_copy;
                i += bytes_to_copy;
                
                if (frame_pos >= frame_payload_len) {
                    // Complete frame received
                    if (frame_opcode == WS_OPCODE_BINARY) {
                        process_binary_packet(frame_buffer.data(), frame_payload_len);
                    } else if (frame_opcode == WS_OPCODE_TEXT) {
                        // JSON message - log errors only
                        std::string text((char*)frame_buffer.data(), frame_payload_len);
                        if (text.find("\"type\":\"error\"") != std::string::npos) {
                            fprintf(stderr, "UberSDR: Server error: %s\n", text.c_str());
                        }
                    } else if (frame_opcode == WS_OPCODE_CLOSE) {
                        fprintf(stderr, "UberSDR: Server sent close frame\n");
                        connected_ = false;
                    } else if (frame_opcode == WS_OPCODE_PING) {
                        ws_send_frame(ws_fd, WS_OPCODE_PONG, frame_buffer.data(), frame_payload_len);
                    }
                    
                    in_frame = false;
                    frame_buffer.clear();
                }
            }
        }
        
        close(ws_fd);
        connected_ = false;
        
        if (running_) {
            fprintf(stderr, "UberSDR: Reconnecting in 2 seconds...\n");
            sleep(2);
        }
    }
}

std::vector<double> UberSDRSoundIn::get(int n, double &t0, int latest) {
    std::lock_guard<std::mutex> lock(buf_mutex_);
    
    std::vector<double> v;
    
    if (time_ < 0 && wi_ == ri_) {
        // No input has ever arrived
        t0 = -1;
        return v;
    }
    
    if (latest) {
        // Discard old samples, keep only the most recent n
        while (((wi_ + n_ - ri_) % n_) > n) {
            ri_ = (ri_ + 1) % n_;
        }
    }
    
    // Calculate time of first sample
    t0 = time_;
    if (wi_ >= ri_) {
        t0 -= (wi_ - ri_) * (1.0 / rate_);
    } else {
        t0 -= ((wi_ + n_) - ri_) * (1.0 / rate_);
    }
    
    // Copy samples
    while ((int)v.size() < n && ri_ != wi_) {
        v.push_back(buf_[ri_]);
        ri_ = (ri_ + 1) % n_;
    }
    
    return v;
}

// Unix domain socket implementation
int UberSDRSoundIn::connect_unix_socket() {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("UberSDR unix socket");
        return -1;
    }
    
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, unix_socket_path_.c_str(), sizeof(addr.sun_path) - 1);
    
    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("UberSDR unix socket connect");
        close(fd);
        return -1;
    }
    
    // Send initial configuration message (Unix socket always uses PCM)
    char config[256];
    snprintf(config, sizeof(config),
             "{\"type\":\"tune\",\"frequency\":%d,\"mode\":\"%s\","
             "\"bandwidthLow\":%d,\"bandwidthHigh\":%d,\"format\":\"pcm\"}\n",
             frequency_, mode_.c_str(), bandwidth_low_, bandwidth_high_);
    
    if (send(fd, config, strlen(config), 0) < 0) {
        perror("UberSDR unix socket send config");
        close(fd);
        return -1;
    }
    
    fprintf(stderr, "UberSDR: Unix socket connected\n");
    return fd;
}

void UberSDRSoundIn::unix_socket_loop() {
    while (running_) {
        int sock_fd = connect_unix_socket();
        if (sock_fd < 0) {
            fprintf(stderr, "UberSDR: Failed to connect to unix socket, retrying in 5 seconds...\n");
            sleep(5);
            continue;
        }
        
        connected_ = true;
        
        // Set socket to non-blocking
        int flags = fcntl(sock_fd, F_GETFL, 0);
        fcntl(sock_fd, F_SETFL, flags | O_NONBLOCK);
        
        time_t last_heartbeat = time(NULL);
        
        // Simple framing: [length:4][data:length]
        uint32_t expected_len = 0;
        bool reading_header = true;
        std::vector<uint8_t> header_buf;
        std::vector<uint8_t> frame_buffer;
        frame_buffer.reserve(65536);
        
        while (running_ && connected_) {
            // Send heartbeat every 10 seconds
            time_t now_time = time(NULL);
            if (now_time - last_heartbeat >= 10) {
                const char* heartbeat = "{\"type\":\"ping\"}\n";
                send(sock_fd, heartbeat, strlen(heartbeat), 0);
                last_heartbeat = now_time;
            }
            
            // Poll for data
            struct pollfd pfd;
            pfd.fd = sock_fd;
            pfd.events = POLLIN;
            
            int ret = poll(&pfd, 1, 100);
            if (ret < 0) {
                perror("UberSDR poll");
                break;
            }
            
            if (ret == 0) {
                continue;
            }
            
            // Read data
            uint8_t buf[4096];
            ssize_t n = recv(sock_fd, buf, sizeof(buf), 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    continue;
                }
                fprintf(stderr, "UberSDR: Unix socket closed\n");
                break;
            }
            
            // Simple framing protocol
            for (ssize_t i = 0; i < n; i++) {
                if (reading_header) {
                    header_buf.push_back(buf[i]);
                    if (header_buf.size() == 4) {
                        // Read length (little-endian)
                        expected_len = 0;
                        for (int j = 0; j < 4; j++) {
                            expected_len |= ((uint32_t)header_buf[j]) << (j * 8);
                        }
                        header_buf.clear();
                        reading_header = false;
                        frame_buffer.clear();
                        frame_buffer.reserve(expected_len);
                    }
                } else {
                    frame_buffer.push_back(buf[i]);
                    if (frame_buffer.size() >= expected_len) {
                        // Complete frame received
                        process_binary_packet(frame_buffer.data(), expected_len);
                        reading_header = true;
                    }
                }
            }
        }
        
        close(sock_fd);
        connected_ = false;
        
        if (running_) {
            fprintf(stderr, "UberSDR: Reconnecting in 2 seconds...\n");
            sleep(2);
        }
    }
}
