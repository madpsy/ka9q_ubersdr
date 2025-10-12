// Multi-band/multi-mode decoder for FT8, FT4, and WSPR with dynamic channel creation
// Based on ka9q-radio's jt-decoded.c
// Copyright 2023 Phil Karn, KA9Q
// Extended for dynamic channel creation 2025
#define _GNU_SOURCE 1
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <string.h>
#if defined(linux)
#include <bsd/string.h>
#endif
#include <math.h>
#include <complex.h>
#undef I
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <stdint.h>
#include <libgen.h>
#include <fcntl.h>
#include <locale.h>
#include <signal.h>
#include <netdb.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sysexits.h>
#include <sys/file.h>
#include <ctype.h>
#include <dirent.h>
#include <poll.h>

#include "../ka9q-radio/src/misc.h"
#include "../ka9q-radio/src/attr.h"
#include "../ka9q-radio/src/multicast.h"
#include "../ka9q-radio/src/rtp.h"
#include "../ka9q-radio/src/status.h"

#include "decode_parser.h"
#include "pskreporter.h"
#include "wsprnet.h"

// size of stdio buffer for disk I/O
#define BUFFERSIZE (1<<16)

// Maximum number of bands/frequencies to decode
#define MAX_BANDS 32

// Simplified .wav file header
struct wav {
  char ChunkID[4];
  int32_t ChunkSize;
  char Format[4];

  char Subchunk1ID[4];
  int32_t Subchunk1Size;
  int16_t AudioFormat;
  int16_t NumChannels;
  int32_t SampleRate;
  int32_t ByteRate;
  int16_t BlockAlign;
  int16_t BitsPerSample;

  char SubChunk2ID[4];
  int32_t Subchunk2Size;
};

// Mode definitions
enum mode_type {
  WSPR,
  FT8,
  FT4,
};

struct mode_info {
  double cycle_time;
  double transmission_time;
  char const *decode;
  char const *preset;  // ka9q-radio preset name
};

static struct mode_info Modetab[] = {
  { 120, 114, "wsprd", "usb"},      // WSPR - use USB preset with AGC enabled
  { 15, 12.64, "jt9", "usb"},       // FT8 - use USB preset (12kHz, proper bandwidth)
  { 7.5, 4.48, "jt9", "usb"},       // FT4 - use USB preset (12kHz, proper bandwidth)
  { 0, 0, NULL, NULL},
};

// Band configuration from config file
struct band_config {
  enum mode_type mode;
  uint64_t frequency;  // in Hz
  uint32_t ssrc;       // Learned SSRC from radiod (0 = not yet learned)
  bool enabled;
  bool channel_created;  // Has the dynamic channel been created?
};

// One for each session being recorded
struct session {
  struct session *prev;
  struct session *next;
  struct sockaddr sender;   // Sender's IP address and source port

  char filename[PATH_MAX];
  struct wav header;

  uint32_t ssrc;               // RTP stream source ID
  uint32_t next_timestamp;     // Next expected RTP timestamp
  
  int type;                    // RTP payload type (with marker stripped)
  int channels;                // 1 (PCM_MONO) or 2 (PCM_STEREO)
  unsigned int samprate;

  FILE *fp;                    // File being recorded
  void *iobuffer;              // Big buffer to reduce write rate

  int64_t SamplesWritten;
  int64_t TotalFileSamples;
  
  // Cycle tracking - the ONLY way to determine file lifecycle
  int64_t current_cycle;       // Which cycle number we're in (0, 1, 2, ...)
  int64_t file_cycle;          // Which cycle this file belongs to (-1 = no file)
  
  // Band-specific info
  struct band_config *band;
};

char const *App_path;
int Verbose;
bool Keep_wav;
char const *Recordings = "/dev/shm";
char const *Config_file = NULL;

struct band_config Bands[MAX_BANDS];
int Num_bands = 0;

// Radiod connection
char Status_mcast[256] = "hf-status.local";
char Data_mcast[256] = "pcm.local";
int Control_fd = -1;
int Status_fd = -1;
int Data_fd = -1;
struct sockaddr Control_dest;
struct sockaddr Status_source;
struct sockaddr Data_source;
int Mcast_ttl = 1;
int IP_tos = 48;

struct sockaddr Sender;
struct session *Sessions;

// Reporting configuration
char Receiver_callsign[32] = "";
char Receiver_locator[16] = "";
char Receiver_antenna[64] = "";
char Program_name[64] = "MM3NDH";
char Program_version[16] = "1.0";
bool PSKReporter_enabled = false;
bool WSPRNet_enabled = false;
bool Include_dead_time = false;  // Record entire cycle including dead time

// Reporting interfaces
struct pskreporter *Pskreporter = NULL;
struct wsprnet *Wsprnet = NULL;

void input_loop(void);
void cleanup(void);
void signal_handler(int sig);
void process_status_packet(uint8_t *buffer, int size);
struct session *init_session(struct session *sp, struct rtp_header *rtp, int size, struct band_config *band);
void process_file(struct session *sp);
void create_new_file(struct session *sp, time_t);
int load_config(char const *filename);
void parse_config_line(char *line, enum mode_type *current_mode);
int create_dynamic_channel(struct band_config *band);
int send_command(uint8_t *cmdbuffer, int len);
void process_spotfiles(void);

void usage(){
  fprintf(stdout,"Usage: %s [-L locale] [-v] [-k] [-d recording_dir] [-c config_file]\n", App_path);
  fprintf(stdout,"  -L locale        Set locale\n");
  fprintf(stdout,"  -v               Verbose mode (repeat for more verbosity)\n");
  fprintf(stdout,"  -k               Keep .wav files after decoding\n");
  fprintf(stdout,"  -d directory     Recording directory (default: current directory)\n");
  fprintf(stdout,"  -c config_file   Configuration file (required)\n");
  fprintf(stdout,"  -V               Show version and exit\n");
  exit(EX_USAGE);
}

int main(int argc, char *argv[]){
  App_path = argv[0];
  char const *locale = getenv("LANG");
  setlocale(LC_ALL, locale);
  setlinebuf(stdout);

  // Parse command line options
  int c;
  while((c = getopt(argc, argv, "d:L:vkVc:")) != EOF){
    switch(c){
    case 'c':
      Config_file = optarg;
      break;
    case 'd':
      Recordings = optarg;
      break;
    case 'L':
      locale = optarg;
      break;
    case 'v':
      Verbose++;
      break;
    case 'k':
      Keep_wav = true;
      break;
    case 'V':
      VERSION();
      exit(EX_OK);
    default:
      usage();
      break;
    }
  }
  setlocale(LC_ALL, locale);

  if(Config_file == NULL){
    fprintf(stdout, "Error: Configuration file required (-c option)\n");
    usage();
  }

  // Load configuration
  if(load_config(Config_file) != 0){
    fprintf(stdout, "Error loading configuration file: %s\n", Config_file);
    exit(EX_CONFIG);
  }

  if(Num_bands == 0){
    fprintf(stdout, "Error: No bands configured\n");
    exit(EX_CONFIG);
  }

  if(Verbose){
    fprintf(stdout, "Loaded %d band configurations:\n", Num_bands);
    for(int i = 0; i < Num_bands; i++){
      uint32_t ssrc = (uint32_t)round(Bands[i].frequency / 1000.0);
      fprintf(stdout, "  Band %d: %s %.6f MHz (SSRC will be 0x%08x = %u kHz)\n",
              i,
              Bands[i].mode == WSPR ? "WSPR" : Bands[i].mode == FT8 ? "FT8" : "FT4",
              Bands[i].frequency / 1e6, ssrc, ssrc);
    }
  }

  // Initialize reporting if configured
  if(PSKReporter_enabled && Receiver_callsign[0] && Receiver_locator[0]){
    // Combine program name and version like WSPRNet does
    char program_with_version[80];
    snprintf(program_with_version, sizeof(program_with_version), "%s %s", Program_name, Program_version);
    Pskreporter = pskreporter_init(Receiver_callsign, Receiver_locator, program_with_version, Receiver_antenna);
    if(Pskreporter){
      if(pskreporter_connect(Pskreporter)){
        fprintf(stdout, "PSKReporter: Enabled for %s @ %s\n", Receiver_callsign, Receiver_locator);
      } else {
        fprintf(stderr, "PSKReporter: Failed to connect\n");
        pskreporter_free(Pskreporter);
        Pskreporter = NULL;
      }
    }
  } else if(PSKReporter_enabled){
    fprintf(stderr, "PSKReporter: Enabled but missing callsign or locator in config\n");
  }

  if(WSPRNet_enabled && Receiver_callsign[0] && Receiver_locator[0]){
    Wsprnet = wsprnet_init(Receiver_callsign, Receiver_locator, Program_name, Program_version);
    if(Wsprnet){
      if(wsprnet_connect(Wsprnet)){
        fprintf(stdout, "WSPRNet: Enabled for %s @ %s\n", Receiver_callsign, Receiver_locator);
      } else {
        fprintf(stderr, "WSPRNet: Failed to connect\n");
        wsprnet_free(Wsprnet);
        Wsprnet = NULL;
      }
    }
  } else if(WSPRNet_enabled){
    fprintf(stderr, "WSPRNet: Enabled but missing callsign or locator in config\n");
  }

  // Change to recordings directory
  if(strlen(Recordings) > 0 && chdir(Recordings) != 0){
    fprintf(stdout, "Can't change to directory %s: %s, exiting\n", Recordings, strerror(errno));
    exit(EX_CANTCREAT);
  }

  // Clean up any existing sessions from previous runs
  if(Verbose)
    fprintf(stdout, "Cleaning up sessions from previous runs...\n");
  
  while(Sessions){
    struct session *next = Sessions->next;
    if(Sessions->fp){
      fclose(Sessions->fp);
      Sessions->fp = NULL;
    }
    FREE(Sessions->iobuffer);
    FREE(Sessions);
    Sessions = next;
  }
  Sessions = NULL;

  // Clean up old files from previous runs (all files in band directories)
  if(Verbose)
    fprintf(stdout, "Cleaning up old files from previous runs...\n");
  
  for(int i = 0; i < Num_bands; i++){
    char dir[PATH_MAX];
    snprintf(dir, sizeof(dir), "%llu", (unsigned long long)Bands[i].frequency);
    
    DIR *d = opendir(dir);
    if(d){
      struct dirent *entry;
      int file_count = 0;
      while((entry = readdir(d)) != NULL){
        // Skip . and .. entries
        if(strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
          continue;
        
        char filepath[PATH_MAX];
        snprintf(filepath, sizeof(filepath), "%s/%s", dir, entry->d_name);
        
        // Remove the file
        if(unlink(filepath) == 0){
          file_count++;
          if(Verbose > 1)
            fprintf(stdout, "  Removed: %s\n", filepath);
        } else if(Verbose > 1){
          fprintf(stdout, "  Failed to remove: %s (%s)\n", filepath, strerror(errno));
        }
      }
      closedir(d);
      
      if(Verbose && file_count > 0)
        fprintf(stdout, "  Cleaned up %d file(s) from %s\n", file_count, dir);
    }
  }
  
  // Clean up ALL old log files from previous runs (not just configured bands)
  if(Verbose)
    fprintf(stdout, "Cleaning up old log files...\n");
  
  // Clean up mode-specific log files using glob pattern
  DIR *dir = opendir(".");
  if(dir){
    struct dirent *entry;
    int log_count = 0;
    while((entry = readdir(dir)) != NULL){
      // Match FT8_*.log, FT4_*.log, WSPR_*.log patterns
      if((strstr(entry->d_name, "FT8_") == entry->d_name ||
          strstr(entry->d_name, "FT4_") == entry->d_name ||
          strstr(entry->d_name, "WSPR_") == entry->d_name) &&
         strstr(entry->d_name, ".log")){
        if(unlink(entry->d_name) == 0){
          log_count++;
          if(Verbose > 1)
            fprintf(stdout, "  Removed log file: %s\n", entry->d_name);
        }
      }
    }
    closedir(dir);
    if(Verbose && log_count > 0)
      fprintf(stdout, "  Cleaned up %d log file(s)\n", log_count);
  }
  
  // Clean up pskreporter.log and wsprnet.log
  unlink("pskreporter.log");
  unlink("wsprnet.log");

  // Set up control socket for sending commands to radiod
  char iface[1024];
  resolve_mcast(Status_mcast, &Control_dest, DEFAULT_STAT_PORT, iface, sizeof(iface), 0);
  Control_fd = connect_mcast(&Control_dest, iface, Mcast_ttl, IP_tos);
  
  if(Control_fd == -1){
    fprintf(stdout, "Can't set up control connection to %s\n", Status_mcast);
    exit(EX_IOERR);
  }

  if(Verbose)
    fprintf(stdout, "Control connection established to %s\n", Status_mcast);

  // Set up data socket for receiving PCM streams
  resolve_mcast(Data_mcast, &Data_source, DEFAULT_RTP_PORT, iface, sizeof(iface), 0);
  Data_fd = listen_mcast(NULL, &Data_source, iface);

  if(Data_fd == -1){
    fprintf(stdout, "Can't set up PCM input from %s\n", Data_mcast);
    exit(EX_IOERR);
  }

  int const n = 1 << 20; // 1 MB
  if(setsockopt(Data_fd, SOL_SOCKET, SO_RCVBUF, &n, sizeof(n)) == -1)
    perror("setsockopt");

  if(Verbose)
    fprintf(stdout, "Listening on %s for PCM data\n", Data_mcast);

  // Create dynamic channels for all configured bands
  for(int i = 0; i < Num_bands; i++){
    if(!Bands[i].enabled)
      continue;

    if(create_dynamic_channel(&Bands[i]) == 0){
      Bands[i].channel_created = true;
      if(Verbose)
        fprintf(stdout, "Created dynamic channel for %.6f MHz\n", Bands[i].frequency / 1e6);
    } else {
      fprintf(stderr, "Failed to create channel for %.6f MHz\n", Bands[i].frequency / 1e6);
      Bands[i].enabled = false;
    }
    
    // Small delay between channel creations
    usleep(100000);
  }

  // Set up signal handlers for clean exit
  signal(SIGINT, signal_handler);   // Ctrl+C
  signal(SIGTERM, signal_handler);  // kill command
  signal(SIGHUP, signal_handler);   // terminal hangup
  
  atexit(cleanup);

  input_loop();

  exit(EX_OK);
}

// Signal handler for clean shutdown
void signal_handler(int sig){
  if(Verbose)
    fprintf(stdout, "\nReceived signal %d, cleaning up...\n", sig);
  
  cleanup();
  exit(0);
}


// Create a dynamic channel using the control protocol
// SSRC is set to frequency in kHz (radiod convention)
int create_dynamic_channel(struct band_config *band){
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  
  *bp++ = CMD;  // Command packet type
  
  // Calculate SSRC from frequency (kHz convention used by radiod)
  uint32_t ssrc = (uint32_t)round(band->frequency / 1000.0);
  band->ssrc = ssrc;  // Store it immediately
  
  // Set SSRC - this tells radiod which channel to create/modify
  encode_int32(&bp, OUTPUT_SSRC, ssrc);
  
  // Set frequency
  encode_double(&bp, RADIO_FREQUENCY, (double)band->frequency);
  
  // Set mode preset
  encode_string(&bp, PRESET, Modetab[band->mode].preset, strlen(Modetab[band->mode].preset));
  
  // Add command tag for tracking
  encode_int32(&bp, COMMAND_TAG, arc4random());
  
  // End of list
  encode_eol(&bp);
  
  int const command_len = bp - cmdbuffer;
  
  if(Verbose > 1){
    fprintf(stdout, "Sending command to create channel: freq=%.6f MHz, mode=%s, SSRC=0x%08x (%u kHz)\n",
            band->frequency / 1e6, Modetab[band->mode].preset, ssrc, ssrc);
  }
  
  return send_command(cmdbuffer, command_len);
}

// Send command to radiod
int send_command(uint8_t *cmdbuffer, int len){
  if(sendto(Control_fd, cmdbuffer, len, 0, &Control_dest, sizeof(Control_dest)) != len){
    fprintf(stderr, "Command send error: %s\n", strerror(errno));
    return -1;
  }
  return 0;
}

// Process status packet (currently unused, but kept for future use)
void process_status_packet(uint8_t *buffer, int size){
  // Status packets not needed since we set SSRCs directly
  // This function is kept for potential future debugging
  (void)buffer;
  (void)size;
}

// Read from RTP network socket, assemble blocks of samples
void input_loop(){
  while(true){
    // Read from data socket only
    {
    uint8_t buffer[PKTSIZE];
    socklen_t socksize = sizeof(Sender);
    int size = recvfrom(Data_fd, buffer, sizeof(buffer), 0, &Sender, &socksize);
    int64_t const now = utc_time_ns();

    if(size <= 0){
      if(errno == EINTR)
        continue;
      continue;
    }
    if(size < RTP_MIN_SIZE)
      continue;

    struct rtp_header rtp;
    uint8_t const *dp = ntoh_rtp(&rtp, buffer);
    if(rtp.pad){
      size -= dp[size-1];
      rtp.pad = 0;
    }
    if(size <= 0)
      continue;

    int16_t const * const samples = (int16_t *)dp;
    size -= (dp - buffer);

    // Find which band this SSRC belongs to
    struct band_config *band = NULL;
    for(int i = 0; i < Num_bands; i++){
      if(Bands[i].enabled && Bands[i].ssrc == rtp.ssrc){
        band = &Bands[i];
        break;
      }
    }
    
    // If SSRC not found, ignore
    if(band == NULL){
      if(Verbose)
        fprintf(stdout, "Received packet with unknown SSRC 0x%08x, ignoring\n", rtp.ssrc);
      continue;  // Unknown SSRC
    }

    // Find or create session for this SSRC
    struct session *sp;
    for(sp = Sessions; sp != NULL; sp = sp->next){
      if(sp->ssrc == rtp.ssrc
         && rtp.type == sp->type
         && address_match(&sp->sender, &Sender)
         && sp->band == band)
        break;
    }
    
    if(sp == NULL){
      // New session
      sp = calloc(1, sizeof(*sp));
      if(!sp)
        exit(EX_TEMPFAIL);

      sp->prev = NULL;
      sp->next = Sessions;
      if(sp->next)
        sp->next->prev = sp;
      Sessions = sp;
      sp->band = band;
      
      if(Verbose > 1)
        fprintf(stdout, "Created new session for SSRC 0x%08x (%.6f MHz)\n",
                rtp.ssrc, band->frequency / 1e6);
    }
      
    memcpy(&sp->sender, &Sender, sizeof(sp->sender));
    sp->type = rtp.type;
    sp->ssrc = rtp.ssrc;
    sp->channels = channels_from_pt(sp->type);
    sp->samprate = samprate_from_pt(sp->type);
      
    enum mode_type mode = sp->band->mode;
    double const cycle_time = Modetab[mode].cycle_time;
    double const transmission_time = Modetab[mode].transmission_time;
    
    // Determine recording duration: full cycle or just transmission time
    double const recording_time = Include_dead_time ? cycle_time : transmission_time;
    
    // Calculate which cycle we're in (0, 1, 2, ...)
    int64_t const current_cycle = now / (int64_t)(cycle_time * BILLION);
    int64_t const modtime = now % (int64_t)(cycle_time * BILLION);
    double const modtime_sec = (double)modtime / BILLION;
    
    // Update session's current cycle
    sp->current_cycle = current_cycle;
    
    // STATE MACHINE: Determine what to do based on cycle and file state
    // Rule 1: If we're in a new cycle and have an old file, queue it for processing
    if(sp->fp != NULL && sp->file_cycle != current_cycle){
      if(Verbose)
        fprintf(stdout, "Cycle boundary: queuing file %s for processing (was cycle %lld, now %lld)\n",
                sp->filename, (long long)sp->file_cycle, (long long)current_cycle);
      process_file(sp);
      // sp->fp is now NULL, sp->file_cycle is now -1
      // Fall through to create new file for current cycle
    }
    
    // Rule 2: If we're past recording time and have a file, queue it for processing
    if(sp->fp != NULL && modtime_sec >= recording_time){
      if(Verbose)
        fprintf(stdout, "Recording ended: queuing file %s for processing (modtime=%.3f >= %.3f)\n",
                sp->filename, modtime_sec, recording_time);
      process_file(sp);
      // sp->fp is now NULL, sp->file_cycle is now -1
      // Don't create new file - we're past recording window
    }
    
    // Rule 3: If we have no file and we're in recording window, create one
    if(sp->fp == NULL && modtime_sec < recording_time){
      // Calculate cycle start time
      int64_t const cycle_start = now - modtime;
      time_t const cycle_start_sec = cycle_start / BILLION;
      
      create_new_file(sp, cycle_start_sec);
      assert(sp->fp != NULL);
      
      sp->file_cycle = current_cycle;  // Mark which cycle this file belongs to
      sp->next_timestamp = rtp.timestamp;
      sp->TotalFileSamples = 0;
      sp->SamplesWritten = 0;
      
      if(Verbose)
        fprintf(stdout, "Created file %s for cycle %lld (modtime=%.3f sec)\n",
                sp->filename, (long long)current_cycle, modtime_sec);
      
      // Write .wav header
      memcpy(sp->header.ChunkID, "RIFF", 4);
      sp->header.ChunkSize = 0xffffffff;
      memcpy(sp->header.Format, "WAVE", 4);
      memcpy(sp->header.Subchunk1ID, "fmt ", 4);
      sp->header.Subchunk1Size = 16;
      sp->header.AudioFormat = 1;
      sp->header.NumChannels = sp->channels;
      sp->header.SampleRate = sp->samprate;
      sp->header.ByteRate = sp->samprate * sp->channels * 16/8;
      sp->header.BlockAlign = sp->channels * 16/8;
      sp->header.BitsPerSample = 16;
      memcpy(sp->header.SubChunk2ID, "data", 4);
      sp->header.Subchunk2Size = 0xffffffff;
      fwrite(&sp->header, sizeof(sp->header), 1, sp->fp);
      fflush(sp->fp);
    }
    
    // Rule 4: Only write if we have an open file
    if(sp->fp == NULL){
      continue;  // No file open, skip this packet
    }
    
    // Write audio data
    int const samp_count = size / sizeof(*samples);
    off_t const offset = (int32_t)(rtp.timestamp - sp->next_timestamp) * sizeof(uint16_t) * sp->channels;
    fseeko(sp->fp, offset, SEEK_CUR);

    sp->TotalFileSamples += samp_count;
    sp->SamplesWritten += samp_count;

    // Write samples in little-endian order
    for(int n = 0; n < samp_count; n++){
      fputc(samples[n] >> 8, sp->fp);
      fputc(samples[n], sp->fp);
    }
    sp->next_timestamp = rtp.timestamp + samp_count / sp->channels;
    
    // Continuously reap children (decoders) at any time so they won't become zombies
    int status = 0;
    int pid;
    while((pid = waitpid(-1, &status, WNOHANG)) > 0){
      if(Verbose > 1)
        fprintf(stdout, "child %d wait status %d\n", pid, status);
    }
    
    // Periodically check for completed decode results (every 100 packets)
    static int packet_count = 0;
    if(++packet_count >= 100){
      packet_count = 0;
      process_spotfiles();
    }
  }
}
}

// Create new file for session
void create_new_file(struct session *sp, time_t start_time_sec){
  assert(sp != NULL);
  if(sp == NULL)
    return;
    
  struct tm const * const tm = gmtime(&start_time_sec);

  char dir[PATH_MAX];
  snprintf(dir, sizeof(dir), "%llu", (unsigned long long)sp->band->frequency);
  if(mkdir(dir, 0777) == -1 && errno != EEXIST)
    fprintf(stdout, "can't create directory %s: %s\n", dir, strerror(errno));

  char filename[PATH_MAX];
  switch(sp->band->mode){
  case FT4:
  case FT8:
    snprintf(filename, sizeof(filename), "%s/%llu/%02d%02d%02d_%02d%02d%02d.wav",
             Recordings,
             (unsigned long long)sp->band->frequency,
             (tm->tm_year+1900) % 100,
             tm->tm_mon+1,
             tm->tm_mday,
             tm->tm_hour,
             tm->tm_min,
             tm->tm_sec);
    break;
  case WSPR:
    snprintf(filename, sizeof(filename), "%s/%llu/%02d%02d%02d_%02d%02d.wav",
             Recordings,
             (unsigned long long)sp->band->frequency,
             (tm->tm_year+1900) % 100,
             tm->tm_mon+1,
             tm->tm_mday,
             tm->tm_hour,
             tm->tm_min);
    break;
  }
  
  int fd = -1;
  if((fd = open(filename, O_RDWR|O_CREAT, 0777)) != -1){
    strlcpy(sp->filename, filename, sizeof(sp->filename));
  } else {
    fprintf(stdout, "can't create/write file %s: %s\n", filename, strerror(errno));
    char const *bn = basename(filename);
    
    if((fd = open(bn, O_RDWR|O_CREAT, 0777)) == -1){
      fprintf(stdout, "can't create/write file %s: %s, can't create session\n", bn, strerror(errno));
      exit(EX_CANTCREAT);
    }
    strlcpy(sp->filename, bn, sizeof(sp->filename));
  }
  
  assert(fd != -1);
  flock(fd, LOCK_EX);
  sp->fp = fdopen(fd, "w+");
  assert(sp->fp != NULL);
  sp->iobuffer = malloc(BUFFERSIZE);
  assert(sp->iobuffer != NULL);
  setbuffer(sp->fp, sp->iobuffer, BUFFERSIZE);
  fcntl(fd, F_SETFL, O_NONBLOCK);
}

void cleanup(void){
  // Clean up WAV files and directories unless -k flag was used
  if(!Keep_wav){
    if(Verbose)
      fprintf(stdout, "Cleaning up WAV files and directories...\n");
    
    for(int i = 0; i < Num_bands; i++){
      char dir[PATH_MAX];
      snprintf(dir, sizeof(dir), "%llu", (unsigned long long)Bands[i].frequency);
      
      // Remove all .wav files in the directory
      DIR *d = opendir(dir);
      if(d){
        struct dirent *entry;
        int file_count = 0;
        while((entry = readdir(d)) != NULL){
          if(strstr(entry->d_name, ".wav")){
            char filepath[PATH_MAX];
            snprintf(filepath, sizeof(filepath), "%s/%s", dir, entry->d_name);
            if(unlink(filepath) == 0){
              file_count++;
              if(Verbose > 1)
                fprintf(stdout, "  Removed %s\n", filepath);
            }
          }
        }
        closedir(d);
        
        // Try to remove the directory (will only succeed if empty)
        if(rmdir(dir) == 0){
          if(Verbose > 1)
            fprintf(stdout, "  Removed directory %s\n", dir);
        }
        
        if(Verbose && file_count > 0)
          fprintf(stdout, "  Cleaned up %d WAV file(s) from %s\n", file_count, dir);
      }
    }
  }
  
  // Tell radiod to destroy our channels by setting frequency to 0
  // This triggers radiod's lifetime countdown (20 seconds)
  if(Control_fd != -1){
    if(Verbose)
      fprintf(stdout, "Requesting radiod to destroy %d channels...\n", Num_bands);
    
    for(int i = 0; i < Num_bands; i++){
      if(!Bands[i].enabled || Bands[i].ssrc == 0)
        continue;
      
      uint8_t cmdbuffer[PKTSIZE];
      uint8_t *bp = cmdbuffer;
      
      *bp++ = CMD;
      encode_int32(&bp, OUTPUT_SSRC, Bands[i].ssrc);
      encode_double(&bp, RADIO_FREQUENCY, 0.0);  // Setting freq=0 triggers cleanup
      encode_int32(&bp, COMMAND_TAG, arc4random());
      encode_eol(&bp);
      
      int const cmd_len = bp - cmdbuffer;
      if(sendto(Control_fd, cmdbuffer, cmd_len, 0, &Control_dest, sizeof(Control_dest)) == cmd_len){
        if(Verbose > 1)
          fprintf(stdout, "  Sent destroy request for SSRC 0x%08x (%.6f MHz)\n",
                  Bands[i].ssrc, Bands[i].frequency / 1e6);
      }
      
      usleep(10000);  // Small delay between commands
    }
  }
  
  // Stop reporting
  if(Pskreporter){
    pskreporter_stop(Pskreporter);
    pskreporter_free(Pskreporter);
    Pskreporter = NULL;
  }
  
  if(Wsprnet){
    wsprnet_stop(Wsprnet);
    wsprnet_free(Wsprnet);
    Wsprnet = NULL;
  }
  
  // Clean up sessions
  while(Sessions){
    struct session * const next_s = Sessions->next;
    if(Sessions->fp){
      fflush(Sessions->fp);
      fclose(Sessions->fp);
      Sessions->fp = NULL;
    }
    FREE(Sessions->iobuffer);
    FREE(Sessions);
    Sessions = next_s;
  }
  
  if(Control_fd != -1)
    close(Control_fd);
  if(Data_fd != -1)
    close(Data_fd);
}

// Close and process file - use double fork like jt-decoded.c
void process_file(struct session *sp){
  assert(sp != NULL && sp->fp != NULL);
  if(sp == NULL || sp->fp == NULL)
    return;

  if(Verbose)
    fprintf(stdout, "closing %s %'.1f/%'.1f sec\n", sp->filename,
            (float)sp->SamplesWritten / sp->samprate,
            (float)sp->TotalFileSamples / sp->samprate);
  
  // Write final .wav header with sizes and close file BEFORE forking
  fflush(sp->fp);
  struct stat statbuf;
  fstat(fileno(sp->fp), &statbuf);
  sp->header.ChunkSize = statbuf.st_size - 8;
  sp->header.Subchunk2Size = statbuf.st_size - sizeof(sp->header);
  rewind(sp->fp);
  fwrite(&sp->header, sizeof(sp->header), 1, sp->fp);
  fflush(sp->fp);
  fclose(sp->fp);
  sp->fp = NULL;  // Close in parent so next cycle creates new file
  sp->file_cycle = -1;  // Mark as no file

  FREE(sp->iobuffer);
  sp->TotalFileSamples = 0;
  sp->SamplesWritten = 0;
  
  // Save filename for child process to use
  char filename_copy[PATH_MAX];
  strlcpy(filename_copy, sp->filename, sizeof(filename_copy));

  // Create log file for decoder output (absolute path since we'll chdir)
  char logfile[PATH_MAX];
  enum mode_type mode = sp->band->mode;
  const char *mode_name = (mode == WSPR) ? "WSPR" : (mode == FT8) ? "FT8" : "FT4";
  char cwd[PATH_MAX];
  getcwd(cwd, sizeof(cwd));
  snprintf(logfile, sizeof(logfile), "%s/%s_%llu.log", cwd, mode_name, (unsigned long long)sp->band->frequency);
  
  // Create a temporary file to pass decoded spots back to parent
  char spotfile[PATH_MAX];
  snprintf(spotfile, sizeof(spotfile), "/tmp/spots_%llu_%ld.txt",
           (unsigned long long)sp->band->frequency, (long)time(NULL));
  
  uint64_t band_frequency = sp->band->frequency;  // Save for child
  
  // Create frequency-specific working directory for decoder (relative path)
  char work_dir[PATH_MAX];
  snprintf(work_dir, sizeof(work_dir), "%s/%llu", cwd, (unsigned long long)band_frequency);
  
  // Double fork pattern from jt-decoded.c
  int child = fork();
  if(child == 0){
    // Child process - close parent's file descriptors and sockets
    // to avoid interfering with parent
    if(Control_fd != -1) close(Control_fd);
    if(Data_fd != -1) close(Data_fd);
    
    // Child process - fork grandchild to run decoder
    int grandchild = fork();
    if(grandchild == 0){
      // Grandchild - change to frequency-specific directory to avoid file conflicts
      // This ensures decoded.txt, timer.out, jt9_wisdom.dat etc. are isolated per frequency
      if(chdir(work_dir) != 0){
        fprintf(stderr, "Failed to chdir to %s: %s\n", work_dir, strerror(errno));
        _Exit(EX_IOERR);
      }
      
      // Grandchild - exec decoder with stdout redirected to log file
      int log_fd = open(logfile, O_WRONLY | O_CREAT | O_TRUNC, 0644);
      if(log_fd != -1){
        dup2(log_fd, STDOUT_FILENO);
        close(log_fd);
      }
      
      char freq[100];
      snprintf(freq, sizeof(freq), "%lf", (double)band_frequency * 1e-6);
      
      switch(mode){
      case WSPR:
        if(Verbose)
          fprintf(stderr, "%s -f %s -w %s >> %s\n", Modetab[mode].decode, freq, filename_copy, logfile);
        execlp(Modetab[mode].decode, Modetab[mode].decode, "-f", freq, "-w", filename_copy, (char *)NULL);
        break;
      case FT8:
        if(Verbose)
          fprintf(stderr, "%s -8 -d 3 %s >> %s\n", Modetab[mode].decode, filename_copy, logfile);
        execlp(Modetab[mode].decode, Modetab[mode].decode, "-8", "-d", "3", filename_copy, (char *)NULL);
        break;
      case FT4:
        if(Verbose)
          fprintf(stderr, "%s -5 -d 3 %s >> %s\n", Modetab[mode].decode, filename_copy, logfile);
        execlp(Modetab[mode].decode, Modetab[mode].decode, "-5", "-d", "3", filename_copy, (char *)NULL);
        break;
      }
      fprintf(stderr, "execlp(%s) returned errno %d (%s)\n", Modetab[mode].decode, errno, strerror(errno));
      _Exit(EX_SOFTWARE);
    }
    
    if(Verbose > 1)
      fprintf(stdout, "forked grandchild %d\n", grandchild);
    
    // Child waits for grandchild decoder to finish
    int status = 0;
    if(waitpid(grandchild, &status, 0) == -1){
      fprintf(stdout, "error waiting for grandchild: errno %d (%s)\n", errno, strerror(errno));
      _Exit(EXIT_FAILURE);
    }
    
    if(Verbose > 1)
      fprintf(stdout, "grandchild %d waitpid status %d\n", grandchild, status);
    
    // Now read the log file and process decodes
    FILE *log_fp = fopen(logfile, "r");
    FILE *spot_fp = fopen(spotfile, "w");
    
    if(log_fp){
      char line[512];
      int decode_count = 0;
      
      // First pass: collect all decodes
      struct decode_info *decodes = NULL;
      int decode_capacity = 100;
      int num_decodes = 0;
      
      decodes = malloc(decode_capacity * sizeof(struct decode_info));
      if(!decodes){
        fclose(log_fp);
        if(spot_fp) fclose(spot_fp);
        _Exit(EXIT_FAILURE);
      }
      
      while(fgets(line, sizeof(line), log_fp)){
        // Print decoder output (skip EOF, DecodeFinished, and **** noise lines)
        if(Verbose && !strstr(line, "EOF on input") && !strstr(line, "<DecodeFinished>") && !strstr(line, "****"))
          fprintf(stdout, "%s", line);
        
        // Parse the decode
        struct decode_info info;
        memset(&info, 0, sizeof(info));
        info.frequency = band_frequency;
        info.timestamp = time(NULL);
        
        bool parsed = false;
        
        if(mode == WSPR){
          parsed = parse_wspr_line(line, band_frequency, &info);
          if(parsed)
            strlcpy(info.mode, "WSPR", sizeof(info.mode));
        } else if(mode == FT8){
          parsed = parse_ft8_line(line, band_frequency, &info);
          if(parsed)
            strlcpy(info.mode, "FT8", sizeof(info.mode));
        } else if(mode == FT4){
          parsed = parse_ft8_line(line, band_frequency, &info);
          if(parsed)
            strlcpy(info.mode, "FT4", sizeof(info.mode));
        }
        
        if(parsed && info.has_callsign){
          // Expand array if needed
          if(num_decodes >= decode_capacity){
            decode_capacity *= 2;
            struct decode_info *new_decodes = realloc(decodes, decode_capacity * sizeof(struct decode_info));
            if(!new_decodes){
              free(decodes);
              fclose(log_fp);
              if(spot_fp) fclose(spot_fp);
              _Exit(EXIT_FAILURE);
            }
            decodes = new_decodes;
          }
          
          decodes[num_decodes++] = info;
        }
      }
      
      fclose(log_fp);
      
      // Second pass: deduplicate - keep only strongest SNR for each callsign
      for(int i = 0; i < num_decodes; i++){
        if(!decodes[i].has_callsign) continue;
        
        int best_idx = i;
        for(int j = i + 1; j < num_decodes; j++){
          if(!decodes[j].has_callsign) continue;
          
          if(strcmp(decodes[i].callsign, decodes[j].callsign) == 0){
            if(decodes[j].snr > decodes[best_idx].snr){
              decodes[best_idx].has_callsign = false;
              best_idx = j;
            } else {
              decodes[j].has_callsign = false;
            }
          }
        }
        
        // Write the best decode for this callsign to spotfile
        if(decodes[best_idx].has_callsign && spot_fp){
          decode_count++;
          fprintf(spot_fp, "%s|%s|%s|%d|%llu|%llu|%ld|%d|%f|%d|%d\n",
                  decodes[best_idx].callsign, decodes[best_idx].locator, decodes[best_idx].mode,
                  decodes[best_idx].snr, (unsigned long long)decodes[best_idx].frequency,
                  (unsigned long long)decodes[best_idx].tx_frequency,
                  (long)decodes[best_idx].timestamp, decodes[best_idx].is_wspr ? 1 : 0,
                  decodes[best_idx].dt, decodes[best_idx].drift, decodes[best_idx].dbm);
        }
      }
      
      free(decodes);
      if(spot_fp)
        fclose(spot_fp);
      
      if(Verbose)
        fprintf(stdout, "Decoded %d unique spots from %s (deduplicated by callsign)\n", decode_count, filename_copy);
    }
    
    // Clean up WAV file
    if(!Keep_wav){
      unlink(filename_copy);
    }
    
    _Exit(EX_OK);
  }
  
  if(Verbose > 1)
    fprintf(stdout, "spawned child %d\n", child);
  
  // Parent returns immediately - child will be reaped by main loop
  // Child is blocking but runs in separate process
}

// Process any completed spotfiles from child decoders
void process_spotfiles(){
  DIR *dir = opendir("/tmp");
  if(!dir)
    return;
  
  struct dirent *entry;
  while((entry = readdir(dir)) != NULL){
    // Look for our spotfiles: spots_<frequency>_<timestamp>.txt
    if(strncmp(entry->d_name, "spots_", 6) != 0)
      continue;
    
    char spotfile[PATH_MAX];
    snprintf(spotfile, sizeof(spotfile), "/tmp/%s", entry->d_name);
    
    FILE *fp = fopen(spotfile, "r");
    if(!fp)
      continue;
    
    char line[512];
    int submitted_count = 0;
    
    while(fgets(line, sizeof(line), fp)){
      struct decode_info info;
      memset(&info, 0, sizeof(info));
      
      int is_wspr = 0;
      if(sscanf(line, "%15[^|]|%7[^|]|%15[^|]|%d|%llu|%llu|%ld|%d|%f|%d|%d",
                info.callsign, info.locator, info.mode,
                &info.snr, &info.frequency, &info.tx_frequency, &info.timestamp, &is_wspr,
                &info.dt, &info.drift, &info.dbm) >= 7){
        
        info.has_callsign = (info.callsign[0] != '\0');
        
        // Validate grid locator length
        size_t loc_len = strlen(info.locator);
        info.has_locator = (loc_len == 4 || loc_len == 6 || loc_len == 8);
        
        info.is_wspr = (is_wspr != 0);
        
        // Validate data quality - allow frequencies below 1 MHz for LF/MF bands
        bool valid_frequency = (info.frequency > 0);
        bool valid_tx_frequency = (!info.is_wspr || (info.tx_frequency > 0));
        bool valid_for_submission = info.has_callsign && valid_frequency && valid_tx_frequency;
        
        // Log to PSKReporter log
        if(!info.is_wspr){
          FILE *psk_log = fopen("pskreporter.log", "a");
          if(psk_log){
            fprintf(psk_log, "%ld|%s|%s|%s|%d|%llu|%s|%s\n",
                    (long)info.timestamp, info.mode, info.callsign, info.locator,
                    info.snr, (unsigned long long)info.frequency,
                    info.has_locator ? "valid_grid" : "invalid_grid",
                    valid_for_submission ? "SUBMITTED" : "REJECTED");
            fclose(psk_log);
          }
        }
        
        // Log to WSPRNet log
        if(info.is_wspr){
          FILE *wspr_log = fopen("wsprnet.log", "a");
          if(wspr_log){
            fprintf(wspr_log, "%ld|%s|%s|%d|%llu|%llu|%.2f|%d|%d|%s\n",
                    (long)info.timestamp, info.callsign, info.locator,
                    info.snr, (unsigned long long)info.frequency,
                    (unsigned long long)info.tx_frequency,
                    info.dt, info.drift, info.dbm,
                    valid_for_submission ? "SUBMITTED" : "REJECTED");
            fclose(wspr_log);
          }
        }
        
        // Skip invalid reports
        if(!valid_for_submission)
          continue;
        
        // Report to PSKReporter (valid FT8/FT4/WSPR with grid)
        if(Pskreporter && info.has_locator){
          if(pskreporter_submit(Pskreporter, &info)){
            submitted_count++;
            if(Verbose > 1)
              fprintf(stdout, "  PSKReporter: Queued %s from %s on %.6f MHz\n",
                      info.callsign, info.locator, info.frequency / 1e6);
          }
        }
        
        // Report to WSPRNet (only valid WSPR)
        if(Wsprnet && info.is_wspr){
          if(wsprnet_submit(Wsprnet, &info)){
            if(Verbose > 1)
              fprintf(stdout, "  WSPRNet: Queued %s from %s, tx %.6f MHz, rx %.6f MHz, %d dBm\n",
                      info.callsign, info.locator, info.tx_frequency / 1e6,
                      info.frequency / 1e6, info.dbm);
          }
        }
      }
    }
    
    fclose(fp);
    unlink(spotfile);  // Delete processed spotfile
    
    if(Verbose && submitted_count > 0)
      fprintf(stdout, "Processed spotfile %s: submitted %d spots\n", entry->d_name, submitted_count);
  }
  
  closedir(dir);
}


// Load configuration file
int load_config(char const *filename){
  FILE *fp = fopen(filename, "r");
  if(!fp){
    fprintf(stderr, "Cannot open config file: %s\n", filename);
    return -1;
  }

  char line[256];
  enum mode_type current_mode = FT8;
  
  while(fgets(line, sizeof(line), fp)){
    parse_config_line(line, &current_mode);
  }

  fclose(fp);
  return 0;
}

// Parse a single config file line
void parse_config_line(char *line, enum mode_type *current_mode){
  static enum { SECTION_NONE, SECTION_RECEIVER, SECTION_PSKREPORTER, SECTION_WSPRNET, SECTION_RADIOD, SECTION_RECORDING, SECTION_MODE } current_section = SECTION_NONE;
  
  // Remove comments
  char *comment = strchr(line, '#');
  if(comment)
    *comment = '\0';

  // Trim leading whitespace
  while(*line && isspace(*line))
    line++;
  
  // Trim trailing whitespace
  char *end = line + strlen(line) - 1;
  while(end > line && isspace(*end))
    *end-- = '\0';
  
  if(*line == '\0')
    return;

  // Check for section header
  if(line[0] == '['){
    char *bracket_end = strchr(line, ']');
    if(bracket_end){
      *bracket_end = '\0';
      char *section_name = line + 1;
      
      if(strcasecmp(section_name, "receiver") == 0){
        current_section = SECTION_RECEIVER;
      } else if(strcasecmp(section_name, "pskreporter") == 0){
        current_section = SECTION_PSKREPORTER;
      } else if(strcasecmp(section_name, "wsprnet") == 0){
        current_section = SECTION_WSPRNET;
      } else if(strcasecmp(section_name, "radiod") == 0){
        current_section = SECTION_RADIOD;
      } else if(strcasecmp(section_name, "recording") == 0){
        current_section = SECTION_RECORDING;
      } else if(strcasecmp(section_name, "FT8") == 0){
        *current_mode = FT8;
        current_section = SECTION_MODE;
      } else if(strcasecmp(section_name, "FT4") == 0){
        *current_mode = FT4;
        current_section = SECTION_MODE;
      } else if(strcasecmp(section_name, "WSPR") == 0){
        *current_mode = WSPR;
        current_section = SECTION_MODE;
      }
    }
    return;
  }

  // Parse key=value pairs for receiver/pskreporter/wsprnet/radiod/recording sections
  if(current_section == SECTION_RECEIVER || current_section == SECTION_PSKREPORTER || current_section == SECTION_WSPRNET || current_section == SECTION_RADIOD || current_section == SECTION_RECORDING){
    char *equals = strchr(line, '=');
    if(equals){
      *equals = '\0';
      char *key = line;
      char *value = equals + 1;
      
      // Trim key
      end = key + strlen(key) - 1;
      while(end > key && isspace(*end))
        *end-- = '\0';
      
      // Trim value
      while(*value && isspace(*value))
        value++;
      end = value + strlen(value) - 1;
      while(end > value && isspace(*end))
        *end-- = '\0';
      
      if(current_section == SECTION_RECEIVER){
        if(strcasecmp(key, "callsign") == 0)
          strlcpy(Receiver_callsign, value, sizeof(Receiver_callsign));
        else if(strcasecmp(key, "locator") == 0 || strcasecmp(key, "grid") == 0)
          strlcpy(Receiver_locator, value, sizeof(Receiver_locator));
        else if(strcasecmp(key, "antenna") == 0)
          strlcpy(Receiver_antenna, value, sizeof(Receiver_antenna));
        else if(strcasecmp(key, "program_name") == 0)
          strlcpy(Program_name, value, sizeof(Program_name));
        else if(strcasecmp(key, "program_version") == 0)
          strlcpy(Program_version, value, sizeof(Program_version));
      } else if(current_section == SECTION_PSKREPORTER){
        if(strcasecmp(key, "enabled") == 0)
          PSKReporter_enabled = (strcasecmp(value, "true") == 0 || strcasecmp(value, "yes") == 0 || strcmp(value, "1") == 0);
      } else if(current_section == SECTION_WSPRNET){
        if(strcasecmp(key, "enabled") == 0)
          WSPRNet_enabled = (strcasecmp(value, "true") == 0 || strcasecmp(value, "yes") == 0 || strcmp(value, "1") == 0);
      } else if(current_section == SECTION_RADIOD){
        if(strcasecmp(key, "status") == 0)
          strlcpy(Status_mcast, value, sizeof(Status_mcast));
        else if(strcasecmp(key, "data") == 0)
          strlcpy(Data_mcast, value, sizeof(Data_mcast));
      } else if(current_section == SECTION_RECORDING){
        if(strcasecmp(key, "include_dead_time") == 0)
          Include_dead_time = (strcasecmp(value, "true") == 0 || strcasecmp(value, "yes") == 0 || strcmp(value, "1") == 0);
      }
    }
    return;
  }

  // Parse frequency line - format: frequency
  if(current_section == SECTION_MODE){
    uint64_t freq = strtoull(line, NULL, 10);
    if(freq > 0 && Num_bands < MAX_BANDS){
      Bands[Num_bands].mode = *current_mode;
      Bands[Num_bands].frequency = freq;
      Bands[Num_bands].ssrc = 0;  // Will be learned from radiod
      Bands[Num_bands].enabled = true;
      Bands[Num_bands].channel_created = false;
      Num_bands++;
    }
  }
}