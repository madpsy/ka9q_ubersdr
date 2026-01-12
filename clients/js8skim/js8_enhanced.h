#ifndef JS8_ENHANCED_H
#define JS8_ENHANCED_H

#include <string>
#include <map>
#include <set>
#include <vector>
#include <ctime>
#include <mutex>

// JS8 Submode definitions
enum JS8Submode {
    JS8_NORMAL = 0,  // JS8A - 1920 samples/symbol, 15s
    JS8_FAST   = 1,  // JS8B - 1200 samples/symbol, 10s
    JS8_TURBO  = 2,  // JS8C - 600 samples/symbol, 6s
    JS8_SLOW   = 4,  // JS8E - 3840 samples/symbol, 30s
    JS8_ULTRA  = 8   // JS8I - 384 samples/symbol, 4s (rarely used)
};

// Submode parameters
struct SubmodeParams {
    int samples_per_symbol;
    int tx_seconds;
    int start_delay_ms;
    const char* name;
};

// Get parameters for a submode
inline SubmodeParams get_submode_params(JS8Submode submode) {
    static const std::map<JS8Submode, SubmodeParams> params = {
        {JS8_NORMAL, {1920, 15, 500, "Normal"}},
        {JS8_FAST,   {1200, 10, 200, "Fast"}},
        {JS8_TURBO,  {600,  6,  100, "Turbo"}},
        {JS8_SLOW,   {3840, 30, 500, "Slow"}},
        {JS8_ULTRA,  {384,  4,  100, "Ultra"}}
    };
    auto it = params.find(submode);
    if (it != params.end()) {
        return it->second;
    }
    return {1920, 15, 500, "Normal"}; // default
}

// Frame type from JS8Call varicode.h
enum FrameType {
    FRAME_HEARTBEAT         = 0,   // [000]
    FRAME_COMPOUND          = 1,   // [001]
    FRAME_COMPOUND_DIRECTED = 2,   // [010]
    FRAME_DIRECTED          = 3,   // [011]
    FRAME_DATA              = 4,   // [10X]
    FRAME_DATA_COMPRESSED   = 6,   // [11X]
    FRAME_UNKNOWN           = 255
};

// Transmission type
enum TransmissionType {
    TX_NORMAL = 0,  // [000] - any other frame
    TX_FIRST  = 1,  // [001] - first frame of message
    TX_LAST   = 2,  // [010] - last frame of message
    TX_DATA   = 4   // [100] - flagged frame
};

// Decoded frame information
struct DecodedFrame {
    std::string text;
    int frequency_hz;
    double time_offset;
    int snr;
    JS8Submode submode;
    FrameType frame_type;
    TransmissionType tx_type;
    time_t timestamp;
    int i3;  // Raw i3 bits from decoder (000=normal, 001=first, 010=last, 100=data)
    
    // For multi-frame messages
    bool is_first_frame;
    bool is_last_frame;
    int block_number;  // extracted from message if present
};

// Message buffer for reconstructing multi-frame messages
struct MessageBuffer {
    std::string from_call;
    std::string to_call;
    std::vector<DecodedFrame> frames;
    time_t first_seen;
    time_t last_seen;
    bool is_complete;
    
    MessageBuffer() : first_seen(0), last_seen(0), is_complete(false) {}
};

// Deduplication cache entry
struct CacheEntry {
    time_t timestamp;
    std::string text;
    int frequency_hz;
    JS8Submode submode;
};

// Enhanced JS8 decoder manager
class JS8EnhancedDecoder {
private:
    // Deduplication cache: key = hash of (text, freq, submode)
    std::map<std::string, CacheEntry> decode_cache_;
    std::mutex cache_mutex_;
    
    // Message reconstruction buffers: key = frequency offset
    std::map<int, MessageBuffer> message_buffers_;
    std::mutex buffer_mutex_;
    
    // Cache expiry time (seconds)
    static const int CACHE_EXPIRY = 300;  // 5 minutes
    static const int BUFFER_EXPIRY = 60;  // 1 minute
    
    // Generate cache key
    std::string generate_cache_key(const std::string& text, int freq, JS8Submode submode);
    
    // Parse frame type from decoded text
    FrameType parse_frame_type(const std::string& text);
    
    // Parse transmission type from i3 bits (preferred method)
    TransmissionType parse_tx_type_from_i3(int i3);
    
    // Parse transmission type from text (legacy fallback)
    TransmissionType parse_tx_type(const std::string& text);
    
    // Extract callsigns from text
    bool extract_callsigns(const std::string& text, std::string& from, std::string& to);
    
    // Extract block number if present
    int extract_block_number(const std::string& text);
    
public:
    JS8EnhancedDecoder();
    ~JS8EnhancedDecoder();
    
    // Check if frame is duplicate
    bool is_duplicate(const DecodedFrame& frame);
    
    // Add frame to cache
    void add_to_cache(const DecodedFrame& frame);
    
    // Add frame to message buffer for reconstruction
    void add_to_buffer(const DecodedFrame& frame);
    
    // Check if message is complete and return it
    bool get_complete_message(int frequency, std::string& complete_text);
    
    // Clean expired entries
    void cleanup_expired();
    
    // Parse decoded text into DecodedFrame
    DecodedFrame parse_decode(const std::string& text, int freq, double time_off,
                              int snr, JS8Submode submode, int i3);
};

#endif // JS8_ENHANCED_H
