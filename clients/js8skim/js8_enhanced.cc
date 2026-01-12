#include "js8_enhanced.h"
#include <sstream>
#include <algorithm>
#include <regex>
#include <functional>

JS8EnhancedDecoder::JS8EnhancedDecoder() {
}

JS8EnhancedDecoder::~JS8EnhancedDecoder() {
}

std::string JS8EnhancedDecoder::generate_cache_key(const std::string& text, int freq, JS8Submode submode) {
    // Simple hash: combine text, frequency, and submode
    std::hash<std::string> hasher;
    std::ostringstream oss;
    oss << text << "_" << freq << "_" << static_cast<int>(submode);
    return oss.str();
}

FrameType JS8EnhancedDecoder::parse_frame_type(const std::string& text) {
    // Detect frame type based on content patterns
    // This is a simplified version - full implementation would need more sophisticated parsing
    
    if (text.find("HB") != std::string::npos || text.find("♡") != std::string::npos) {
        return FRAME_HEARTBEAT;
    }
    
    // Check for directed messages (contains ":")
    if (text.find(":") != std::string::npos) {
        // Check if it's a compound callsign scenario
        std::regex compound_pattern(R"([A-Z0-9]+/[A-Z0-9]+)");
        if (std::regex_search(text, compound_pattern)) {
            if (text.find(">") != std::string::npos) {
                return FRAME_COMPOUND_DIRECTED;
            }
            return FRAME_COMPOUND;
        }
        return FRAME_DIRECTED;
    }
    
    // Check for CQ
    if (text.find("CQ") != std::string::npos) {
        return FRAME_DATA;
    }
    
    return FRAME_DATA;
}

TransmissionType JS8EnhancedDecoder::parse_tx_type_from_i3(int i3) {
    // Parse transmission type from i3 bits (from JS8Call protocol)
    // i3 encoding: 000=normal, 001=first, 010=last, 100=data
    switch(i3) {
        case 1:  // 001 - first frame
            return TX_FIRST;
        case 2:  // 010 - last frame
            return TX_LAST;
        case 4:  // 100 - data frame
            return TX_DATA;
        default: // 000 or other - normal continuation
            return TX_NORMAL;
    }
}

// Legacy text-based heuristic (kept for backward compatibility if i3 not available)
TransmissionType JS8EnhancedDecoder::parse_tx_type(const std::string& text) {
    // Check for continuation markers or block numbers
    if (text.find("^") == 0) {
        return TX_FIRST;
    }
    if (text.find("$") != std::string::npos || text.back() == '$') {
        return TX_LAST;
    }
    
    return TX_NORMAL;
}

bool JS8EnhancedDecoder::extract_callsigns(const std::string& text, std::string& from, std::string& to) {
    // Parse "TO: FROM: message" or "TO FROM message" format
    std::regex directed_pattern(R"(([A-Z0-9/]+)\s*:\s*([A-Z0-9/]+)\s*:?\s*)");
    std::smatch match;
    
    if (std::regex_search(text, match, directed_pattern)) {
        to = match[1].str();
        from = match[2].str();
        return true;
    }
    
    // Try simpler pattern "FROM TO message"
    std::regex simple_pattern(R"(^([A-Z0-9/]+)\s+([A-Z0-9/]+)\s+)");
    if (std::regex_search(text, match, simple_pattern)) {
        from = match[1].str();
        to = match[2].str();
        return true;
    }
    
    return false;
}

int JS8EnhancedDecoder::extract_block_number(const std::string& text) {
    // Look for block number patterns like [01], [02], etc.
    std::regex block_pattern(R"(\[(\d+)\])");
    std::smatch match;
    
    if (std::regex_search(text, match, block_pattern)) {
        return std::stoi(match[1].str());
    }
    
    return -1;  // No block number found
}

bool JS8EnhancedDecoder::is_duplicate(const DecodedFrame& frame) {
    std::lock_guard<std::mutex> lock(cache_mutex_);
    
    std::string key = generate_cache_key(frame.text, frame.frequency_hz, frame.submode);
    
    auto it = decode_cache_.find(key);
    if (it != decode_cache_.end()) {
        // Check if entry is still valid (not expired)
        time_t now = time(nullptr);
        if (now - it->second.timestamp < CACHE_EXPIRY) {
            return true;  // Duplicate
        }
        // Expired, will be replaced
    }
    
    return false;
}

void JS8EnhancedDecoder::add_to_cache(const DecodedFrame& frame) {
    std::lock_guard<std::mutex> lock(cache_mutex_);
    
    std::string key = generate_cache_key(frame.text, frame.frequency_hz, frame.submode);
    
    CacheEntry entry;
    entry.timestamp = frame.timestamp;
    entry.text = frame.text;
    entry.frequency_hz = frame.frequency_hz;
    entry.submode = frame.submode;
    
    decode_cache_[key] = entry;
}

void JS8EnhancedDecoder::add_to_buffer(const DecodedFrame& frame) {
    std::lock_guard<std::mutex> lock(buffer_mutex_);
    
    // Use frequency as key for message buffer
    int freq_key = frame.frequency_hz;
    
    // KEY FIX: If this is a FIRST frame (i3=1), clear any existing buffer at this frequency
    // This matches JS8Call's behavior (mainwindow.cpp:3999-4001)
    // Now using i3 bits instead of text heuristics
    if (frame.i3 == 1 || frame.is_first_frame) {
        auto it = message_buffers_.find(freq_key);
        if (it != message_buffers_.end()) {
            // Clear existing buffer - new message starting
            message_buffers_.erase(it);
        }
    }
    
    auto it = message_buffers_.find(freq_key);
    if (it == message_buffers_.end()) {
        // Create new buffer
        MessageBuffer buffer;
        buffer.first_seen = frame.timestamp;
        buffer.last_seen = frame.timestamp;
        
        // Try to extract callsigns
        extract_callsigns(frame.text, buffer.from_call, buffer.to_call);
        
        buffer.frames.push_back(frame);
        message_buffers_[freq_key] = buffer;
    } else {
        // Add to existing buffer
        it->second.frames.push_back(frame);
        it->second.last_seen = frame.timestamp;
        
        // Check if message is complete (i3=2 means LAST frame)
        if (frame.i3 == 2 || frame.is_last_frame) {
            it->second.is_complete = true;
        }
    }
}

bool JS8EnhancedDecoder::get_complete_message(int frequency, std::string& complete_text) {
    std::lock_guard<std::mutex> lock(buffer_mutex_);
    
    auto it = message_buffers_.find(frequency);
    if (it == message_buffers_.end()) {
        return false;
    }
    
    if (!it->second.is_complete) {
        return false;
    }
    
    // Reconstruct complete message from frames
    std::ostringstream oss;
    
    // Sort frames by block number if available
    std::vector<DecodedFrame> sorted_frames = it->second.frames;
    std::sort(sorted_frames.begin(), sorted_frames.end(),
              [](const DecodedFrame& a, const DecodedFrame& b) {
                  if (a.block_number >= 0 && b.block_number >= 0) {
                      return a.block_number < b.block_number;
                  }
                  return a.timestamp < b.timestamp;
              });
    
    // Concatenate frame texts
    for (const auto& frame : sorted_frames) {
        oss << frame.text;
        if (&frame != &sorted_frames.back()) {
            oss << " ";
        }
    }
    
    complete_text = oss.str();
    
    // Remove the completed message from buffer
    message_buffers_.erase(it);
    
    return true;
}

void JS8EnhancedDecoder::cleanup_expired() {
    time_t now = time(nullptr);
    
    // Clean cache
    {
        std::lock_guard<std::mutex> lock(cache_mutex_);
        for (auto it = decode_cache_.begin(); it != decode_cache_.end(); ) {
            if (now - it->second.timestamp > CACHE_EXPIRY) {
                it = decode_cache_.erase(it);
            } else {
                ++it;
            }
        }
    }
    
    // Clean message buffers
    {
        std::lock_guard<std::mutex> lock(buffer_mutex_);
        for (auto it = message_buffers_.begin(); it != message_buffers_.end(); ) {
            if (now - it->second.last_seen > BUFFER_EXPIRY) {
                it = message_buffers_.erase(it);
            } else {
                ++it;
            }
        }
    }
}

DecodedFrame JS8EnhancedDecoder::parse_decode(const std::string& text, int freq,
                                               double time_off, int snr, JS8Submode submode, int i3) {
    DecodedFrame frame;
    frame.text = text;
    frame.frequency_hz = freq;
    frame.time_offset = time_off;
    frame.snr = snr;
    frame.submode = submode;
    frame.timestamp = time(nullptr);
    frame.i3 = i3;
    
    // Parse frame type
    frame.frame_type = parse_frame_type(text);
    
    // Parse transmission type from i3 bits (preferred) or fallback to text heuristics
    if (i3 >= 0) {
        frame.tx_type = parse_tx_type_from_i3(i3);
    } else {
        frame.tx_type = parse_tx_type(text);
    }
    
    // Determine if first/last frame based on tx_type
    frame.is_first_frame = (frame.tx_type == TX_FIRST);
    frame.is_last_frame = (frame.tx_type == TX_LAST);
    
    // Extract block number if present
    frame.block_number = extract_block_number(text);
    
    return frame;
}
