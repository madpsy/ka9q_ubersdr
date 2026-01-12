//
// A simple JS8 decoder with line-based output.
//
// Robert Morris, AB1HL
//

#include "snd.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
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

void
usage()
{
  fprintf(stderr, "Usage: js8skim HOST:PORT,FREQUENCY\n");
  fprintf(stderr, "       js8skim unix:/path/to/socket,FREQUENCY\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Connection types:\n");
  fprintf(stderr, "  WebSocket:         HOST:PORT,FREQUENCY (uses Opus compression)\n");
  fprintf(stderr, "  Unix domain socket: unix:/path,FREQUENCY (uses PCM, local only)\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Examples:\n");
  fprintf(stderr, "  js8skim localhost:8073,14074000           # WebSocket (Opus)\n");
  fprintf(stderr, "  js8skim 192.168.1.100:8073,14074000       # WebSocket remote\n");
  fprintf(stderr, "  js8skim unix:/tmp/ubersdr.sock,14074000   # Unix socket (PCM)\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Output format: TIMESTAMP FREQUENCY CALLSIGN SNR [GRID]\n");
  fprintf(stderr, "\n");
  fprintf(stderr, "Note: Always uses USB mode for JS8 decoding\n");
  exit(1);
}

int
fate_cb(int *a87, double hz0, double hz1, double off,
        const char *comment, double snr, int pass, int correct_bits)
{
  std::string other_call;
  std::string grid_locator;
  
  std::string txt = unpack(a87, other_call);

  dups_mu.lock();
  bool already = dups[txt];
  dups[txt] = true;
  dups_mu.unlock();

  if(already){
    return(1); // not a new decode
  }

  // Extract grid locator if present in the text
  // Grid format is 4 characters: [A-R][A-R][0-9][0-9] like "FN42" or "EM79"
  // Search through entire string for the pattern
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

  // Print: TIMESTAMP FREQUENCY CALLSIGN SNR [GRID]
  if(other_call.size() > 0){
    // Get current time in ISO 8601 format with Z suffix
    time_t now_time = time(NULL);
    struct tm *tm_info = gmtime(&now_time);
    char time_buf[32];
    strftime(time_buf, sizeof(time_buf), "%Y-%m-%dT%H:%M:%SZ", tm_info);

    // Calculate actual RF frequency (tuned freq + audio offset)
    int actual_freq = tuned_frequency + (int)hz0;

    printf("%s %d %s %.1f", time_buf, actual_freq, other_call.c_str(), snr);
    if(grid_locator.size() > 0){
      printf(" %s", grid_locator.c_str());
    }
    printf("\n");
    fflush(stdout);
  }
  return 2;
}

int
main(int argc, char *argv[])
{
  char *ubersdr_spec = 0;

  if(argc < 2)
    usage();

  srandom(time((time_t*)0));

  int ai = 1;

  // First argument (if not a flag) is the ubersdr spec
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

  fflush(stdout);
  setvbuf(stdout, 0, _IOFBF, 0);

  // Parse frequency from ubersdr_spec
  size_t comma = std::string(ubersdr_spec).find(',');
  if(comma != std::string::npos){
    tuned_frequency = std::stoi(std::string(ubersdr_spec).substr(comma + 1));
  }

  // Connect to ubersdr and run the decoder
  SoundIn *sin = SoundIn::open("ubersdr", ubersdr_spec, 6000);
  sin->start();
  rx_loop(sin, fate_cb);
}
