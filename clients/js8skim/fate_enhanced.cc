//
// Enhanced JS8 decoder with multi-submode support, message reconstruction, and deduplication.
//
// Based on original js8skim by Robert Morris, AB1HL
// Enhanced with features from JS8Call desktop application
//

#include "snd.h"
#include "js8_enhanced.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <mutex>
#include <map>
#include <time.h>
#include <string>
#include <thread>

#include "defs.h"
#include "util.h"
#include "pack.h"
#include "js8.h"
#include "common.h"

int tuned_frequency = 0; // RF frequency we're tuned to
JS8EnhancedDecoder *enhanced_decoder = nullptr;

// Command line options
bool enable_deduplication = true;
bool enable_message_reconstruction = true;
bool enable_multi_submode = true;  // Enabled by default to catch all speeds
int enabled_submodes = (1 << JS8_NORMAL) | (1 << JS8_FAST) | (1 << JS8_TURBO) | (1 << JS8_SLOW);  // Default: all common modes (not Ultra)

void
usage()
{
  fprintf(stderr, "Usage: js8skim [OPTIONS] HOST:PORT,FREQUENCY\n");
  fprintf(stderr, "       js8skim [OPTIONS] unix:/path/to/socket,FREQUENCY\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Connection types:\n");
  fprintf(stderr, "  WebSocket:          HOST:PORT,FREQUENCY (uses Opus compression)\n");
  fprintf(stderr, "  Unix domain socket: unix:/path,FREQUENCY (uses PCM, local only)\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Options:\n");
  fprintf(stderr, "  --no-dedup          Disable deduplication (show all decodes)\n");
  fprintf(stderr, "  --no-reconstruct    Disable multi-frame message reconstruction\n");
  fprintf(stderr, "  --multi-submode     Enable multi-submode decoding (CPU intensive)\n");
  fprintf(stderr, "  --submodes=MODES    Comma-separated list: normal,fast,turbo,slow\n");
  fprintf(stderr, "                      (default: normal)\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Examples:\n");
  fprintf(stderr, "  js8skim localhost:8073,14074000\n");
  fprintf(stderr, "  js8skim --multi-submode --submodes=normal,fast unix:/tmp/ubersdr.sock,14074000\n");
  fprintf(stderr, "  js8skim --no-dedup 192.168.1.100:8073,14074000\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Output format: TIMESTAMP FREQUENCY CALLSIGN SNR [GRID] [SUBMODE] [TYPE]\n");
  fprintf(stderr, "\n");
  exit(1);
}

const char* submode_name(JS8Submode submode) {
    switch(submode) {
        case JS8_NORMAL: return "Normal";
        case JS8_FAST:   return "Fast";
        case JS8_TURBO:  return "Turbo";
        case JS8_SLOW:   return "Slow";
        case JS8_ULTRA:  return "Ultra";
        default:         return "Unknown";
    }
}

const char* frame_type_name(FrameType type) {
    switch(type) {
        case FRAME_HEARTBEAT:         return "HB";
        case FRAME_COMPOUND:          return "COMPOUND";
        case FRAME_COMPOUND_DIRECTED: return "COMPOUND_DIR";
        case FRAME_DIRECTED:          return "DIRECTED";
        case FRAME_DATA:              return "DATA";
        case FRAME_DATA_COMPRESSED:   return "DATA_COMP";
        default:                      return "UNKNOWN";
    }
}

int
fate_cb(int *a87, double hz0, double hz1, double off,
        const char *comment, double snr, int pass, int correct_bits, int i3)
{
  std::string other_call;
  std::string grid_locator;
  
  std::string txt = unpack(a87, other_call);

  // Calculate actual RF frequency (tuned freq + audio offset)
  int actual_freq = tuned_frequency + (int)hz0;
  
  // Determine submode (for now, assume Normal - would need decoder modification to detect)
  JS8Submode submode = JS8_NORMAL;
  
  // Parse the decoded frame - now passing i3 so it can use real transmission type bits
  DecodedFrame frame = enhanced_decoder->parse_decode(txt, actual_freq, off, (int)snr, submode, i3);
  
  // The parse_decode function now handles i3 internally, so we don't need to override
  // But we keep these for backward compatibility and validation
  frame.is_first_frame = (i3 == 1);  // 001
  frame.is_last_frame = (i3 == 2);   // 010
  
  // Check for duplicates if enabled
  if (enable_deduplication) {
      if (enhanced_decoder->is_duplicate(frame)) {
          return 1; // Not a new decode
      }
      enhanced_decoder->add_to_cache(frame);
  }
  
  // Add to message buffer if reconstruction is enabled
  if (enable_message_reconstruction) {
      enhanced_decoder->add_to_buffer(frame);
      
      // Check if we have a complete message
      std::string complete_msg;
      if (enhanced_decoder->get_complete_message(actual_freq, complete_msg)) {
          // Print complete reconstructed message
          time_t now_time = time(NULL);
          struct tm *tm_info = gmtime(&now_time);
          char time_buf[32];
          strftime(time_buf, sizeof(time_buf), "%Y-%m-%dT%H:%M:%SZ", tm_info);
          
          printf("%s %d [COMPLETE] %s\n", time_buf, actual_freq, complete_msg.c_str());
          fflush(stdout);
      }
  }

  // Extract grid locator if present in the text
  for(size_t i = 0; i + 3 < txt.size(); i++){
    char c1 = txt[i];
    char c2 = txt[i + 1];
    char c3 = txt[i + 2];
    char c4 = txt[i + 3];
    if(c1 >= 'A' && c1 <= 'R' && c2 >= 'A' && c2 <= 'R' &&
       c3 >= '0' && c3 <= '9' && c4 >= '0' && c4 <= '9'){
      grid_locator = txt.substr(i, 4);
      break;
    }
  }

  // Print: TIMESTAMP FREQUENCY CALLSIGN SNR [GRID] [SUBMODE] [TYPE]
  if(other_call.size() > 0 || txt.size() > 0){
    // Get current time in ISO 8601 format with Z suffix
    time_t now_time = time(NULL);
    struct tm *tm_info = gmtime(&now_time);
    char time_buf[32];
    strftime(time_buf, sizeof(time_buf), "%Y-%m-%dT%H:%M:%SZ", tm_info);

    printf("%s %d", time_buf, actual_freq);
    
    if(other_call.size() > 0) {
        printf(" %s", other_call.c_str());
    } else {
        printf(" [%s]", txt.c_str());
    }
    
    printf(" %.1f", snr);
    
    if(grid_locator.size() > 0){
      printf(" %s", grid_locator.c_str());
    }
    
    // Add submode and frame type info
    printf(" %s", submode_name(frame.submode));
    printf(" %s", frame_type_name(frame.frame_type));
    
    // Indicate if part of multi-frame message
    if(frame.is_first_frame) {
        printf(" [FIRST]");
    } else if(frame.is_last_frame) {
        printf(" [LAST]");
    } else if(frame.block_number >= 0) {
        printf(" [BLK:%d]", frame.block_number);
    }
    
    printf("\n");
    fflush(stdout);
  }
  
  return 2;
}

void parse_submodes(const char* modes_str) {
    enabled_submodes = 0;
    std::string modes(modes_str);
    size_t pos = 0;
    
    while(pos < modes.length()) {
        size_t comma = modes.find(',', pos);
        std::string mode = modes.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
        
        if(mode == "normal") enabled_submodes |= (1 << JS8_NORMAL);
        else if(mode == "fast") enabled_submodes |= (1 << JS8_FAST);
        else if(mode == "turbo") enabled_submodes |= (1 << JS8_TURBO);
        else if(mode == "slow") enabled_submodes |= (1 << JS8_SLOW);
        else if(mode == "ultra") enabled_submodes |= (1 << JS8_ULTRA);
        else {
            fprintf(stderr, "Warning: Unknown submode '%s'\n", mode.c_str());
        }
        
        if(comma == std::string::npos) break;
        pos = comma + 1;
    }
    
    if(enabled_submodes == 0) {
        fprintf(stderr, "Warning: No valid submodes specified, using Normal\n");
        enabled_submodes = (1 << JS8_NORMAL);
    }
}

// Cleanup thread to periodically remove expired cache entries
void cleanup_thread() {
    while(true) {
        sleep(60);  // Run every minute
        if(enhanced_decoder) {
            enhanced_decoder->cleanup_expired();
        }
    }
}

int
main(int argc, char *argv[])
{
  char *ubersdr_spec = 0;

  if(argc < 2)
    usage();

  srandom(time((time_t*)0));

  int ai = 1;

  // Parse options
  while(ai < argc && argv[ai][0] == '-'){
    if(strcmp(argv[ai], "--no-dedup") == 0){
      enable_deduplication = false;
      ai++;
    } else if(strcmp(argv[ai], "--no-reconstruct") == 0){
      enable_message_reconstruction = false;
      ai++;
    } else if(strcmp(argv[ai], "--multi-submode") == 0){
      enable_multi_submode = true;
      ai++;
    } else if(strncmp(argv[ai], "--submodes=", 11) == 0){
      parse_submodes(argv[ai] + 11);
      ai++;
    } else if(strcmp(argv[ai], "--help") == 0 || strcmp(argv[ai], "-h") == 0){
      usage();
    } else {
      fprintf(stderr, "Unknown option: %s\n", argv[ai]);
      usage();
    }
  }

  // First non-option argument is the ubersdr spec
  if(ai < argc && argv[ai][0] != '-'){
    ubersdr_spec = argv[ai];
    ai++;
  }

  // Check for any unexpected arguments
  if(ai < argc){
    fprintf(stderr, "Unknown option: %s\n", argv[ai]);
    usage();
  }

  if(ubersdr_spec == 0){
    fprintf(stderr, "Error: ubersdr HOST:PORT,FREQUENCY required\n");
    usage();
  }

  // Initialize enhanced decoder
  enhanced_decoder = new JS8EnhancedDecoder();

  // Print configuration
  fprintf(stderr, "JS8Skim Enhanced Decoder\n");
  fprintf(stderr, "Deduplication: %s\n", enable_deduplication ? "enabled" : "disabled");
  fprintf(stderr, "Message reconstruction: %s\n", enable_message_reconstruction ? "enabled" : "disabled");
  fprintf(stderr, "Multi-submode: %s\n", enable_multi_submode ? "enabled" : "disabled");
  fprintf(stderr, "Enabled submodes:");
  if(enabled_submodes & (1 << JS8_NORMAL)) fprintf(stderr, " Normal");
  if(enabled_submodes & (1 << JS8_FAST)) fprintf(stderr, " Fast");
  if(enabled_submodes & (1 << JS8_TURBO)) fprintf(stderr, " Turbo");
  if(enabled_submodes & (1 << JS8_SLOW)) fprintf(stderr, " Slow");
  if(enabled_submodes & (1 << JS8_ULTRA)) fprintf(stderr, " Ultra");
  fprintf(stderr, "\n\n");

  fflush(stdout);
  setvbuf(stdout, 0, _IOFBF, 0);

  // Parse frequency from ubersdr_spec
  size_t comma = std::string(ubersdr_spec).find(',');
  if(comma != std::string::npos){
    tuned_frequency = std::stoi(std::string(ubersdr_spec).substr(comma + 1));
  }

  // Start cleanup thread
  std::thread cleanup_th(cleanup_thread);
  cleanup_th.detach();

  // Connect to ubersdr and run the decoder
  SoundIn *sin = SoundIn::open("ubersdr", ubersdr_spec, 6000);
  sin->start();
  rx_loop(sin, fate_cb);
  
  delete enhanced_decoder;
}
