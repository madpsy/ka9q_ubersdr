/**
 * @file
 * @author Nathan Handler
 * @brief device driver for CWSL WebSDR network source
 * @copyright 2025
 * @verbatim
 * Built-in driver for CWSL WebSDR in radiod
 * Connects to cwsl_websdr TCP server and receives IQ data via UDP
 * Based on the cwsl_netrx client implementation
 * @endverbatim
**/

#define _GNU_SOURCE 1
#include <assert.h>
#include <pthread.h>
#include <errno.h>
#include <iniparser/iniparser.h>
#include <sysexits.h>
#include <strings.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>

#include "conf.h"
#include "misc.h"
#include "radio.h"
#include "config.h"

// External from main.c
extern volatile bool Stop_transfers;

#define INPUT_PRIORITY 95
#define DEFAULT_SAMPRATE 192000
#define DEFAULT_PORT 50001
#define DEFAULT_UDP_PORT 50100
#define DEFAULT_RECEIVER_ID 0
#define DEFAULT_SCALING_FACTOR 16
#define UDP_BUFFER_SIZE 8192
#define TCP_TIMEOUT_MS 5000

// CWSL WebSDR protocol commands
#define CMD_ATTACH "attach"
#define CMD_DETACH "detach"
#define CMD_FREQUENCY "frequency"
#define CMD_START "start"
#define CMD_STOP "stop"
#define CMD_QUIT "quit"
#define RESP_OK "OK"

struct cwsl_websdr {
  struct frontend *frontend;
  
  // Connection parameters
  char host[256];
  int tcp_port;
  int udp_port;
  int receiver_id;
  int scaling_factor;
  
  // TCP control connection
  int tcp_fd;
  pthread_mutex_t tcp_mutex;
  
  // UDP data connection
  int udp_fd;
  struct sockaddr_in udp_addr;
  
  // WebSDR parameters from server
  int block_in_samples;
  int l0_frequency;
  
  // State
  bool connected;
  bool streaming;
  float scale;
  
  // Threads
  pthread_t tcp_thread;
  pthread_t udp_thread;
};

static char const *Cwsl_websdr_keys[] = {
  "calibrate",
  "description",
  "device",
  "frequency",
  "hardware",
  "host",
  "library",
  "port",
  "receiver",
  "samprate",
  "scaling",
  "udp_port",
  NULL
};

// Forward declarations
static int cwsl_connect(struct cwsl_websdr *cwsl);
static void cwsl_disconnect(struct cwsl_websdr *cwsl);
static int cwsl_send_command(struct cwsl_websdr *cwsl, const char *cmd, char *response, size_t resp_size);
static int cwsl_attach_receiver(struct cwsl_websdr *cwsl);
static int cwsl_start_streaming(struct cwsl_websdr *cwsl);
static void *cwsl_tcp_keepalive_thread(void *arg);
static void *cwsl_udp_read_thread(void *arg);

int cwsl_websdr_setup(struct frontend *frontend, dictionary *dictionary, char const *section) {
  assert(dictionary != NULL);
  
  struct cwsl_websdr * const cwsl = (struct cwsl_websdr *)calloc(1, sizeof(struct cwsl_websdr));
  assert(cwsl != NULL);
  
  // Cross-link generic and hardware-specific control structures
  cwsl->frontend = frontend;
  frontend->context = cwsl;
  
  {
    char const *device = config_getstring(dictionary, section, "device", section);
    if(strcasecmp(device, "cwsl_websdr") != 0)
      return -1; // Not for us
  }
  
  config_validate_section(stderr, dictionary, section, Cwsl_websdr_keys, NULL);
  
  {
    char const *p = config_getstring(dictionary, section, "description", "cwsl-websdr");
    if(p != NULL) {
      strlcpy(frontend->description, p, sizeof(frontend->description));
    }
  }
  
  // Get connection parameters
  {
    char const *p = config_getstring(dictionary, section, "host", "localhost");
    strlcpy(cwsl->host, p, sizeof(cwsl->host));
  }
  
  cwsl->tcp_port = config_getint(dictionary, section, "port", DEFAULT_PORT);
  cwsl->udp_port = config_getint(dictionary, section, "udp_port", DEFAULT_UDP_PORT);
  cwsl->receiver_id = config_getint(dictionary, section, "receiver", -1); // -1 means auto-select
  cwsl->scaling_factor = config_getint(dictionary, section, "scaling", DEFAULT_SCALING_FACTOR);
  
  if(cwsl->scaling_factor < 1 || cwsl->scaling_factor > 64) {
    fprintf(stderr, "Invalid scaling factor %d, must be 1-64, using default %d\n",
            cwsl->scaling_factor, DEFAULT_SCALING_FACTOR);
    cwsl->scaling_factor = DEFAULT_SCALING_FACTOR;
  }
  
  frontend->samprate = config_getint(dictionary, section, "samprate", DEFAULT_SAMPRATE);
  if(frontend->samprate <= 0) {
    fprintf(stderr, "Invalid sample rate, reverting to default\n");
    frontend->samprate = DEFAULT_SAMPRATE;
  }
  
  // Initialize mutex
  pthread_mutex_init(&cwsl->tcp_mutex, NULL);
  
  // Get initial frequency if specified (needed for receiver selection)
  double init_frequency = 0;
  {
    char const *p = config_getstring(dictionary, section, "frequency", NULL);
    if(p != NULL)
      init_frequency = parse_frequency(p, false);
  }
  
  // Set target frequency before connecting (used by attach_receiver for auto-selection)
  if(init_frequency != 0) {
    frontend->frequency = init_frequency;
    frontend->lock = true;
  } else if(cwsl->receiver_id < 0) {
    fprintf(stderr, "Error: frequency must be specified when receiver is not explicitly set\n");
    free(cwsl);
    return -1;
  }
  
  // Connect to CWSL WebSDR server
  if(cwsl_connect(cwsl) != 0) {
    fprintf(stderr, "Failed to connect to CWSL WebSDR at %s:%d\n", cwsl->host, cwsl->tcp_port);
    free(cwsl);
    return -1;
  }
  
  // Attach to receiver (will auto-select based on target frequency if receiver_id < 0)
  if(cwsl_attach_receiver(cwsl) != 0) {
    fprintf(stderr, "Failed to attach to suitable receiver\n");
    cwsl_disconnect(cwsl);
    free(cwsl);
    return -1;
  }
  
  // Set frontend->frequency to the receiver's L0 (center frequency)
  // This is the actual LO frequency that ka9q-radio's DSP will use for offsets
  // Apply calibration correction to the L0 frequency
  frontend->frequency = cwsl->l0_frequency * (1 + frontend->calibrate);
  
  frontend->calibrate = config_getdouble(dictionary, section, "calibrate", 0);
  
  fprintf(stderr, "%s connected to %s:%d, receiver %d, samprate %'d Hz, UDP port %d, scaling %d, init freq %'.3lf Hz, calibrate %.3g\n",
          frontend->description, cwsl->host, cwsl->tcp_port, cwsl->receiver_id,
          frontend->samprate, cwsl->udp_port, cwsl->scaling_factor,
          frontend->frequency, frontend->calibrate);
  
  // Set frontend parameters
  frontend->min_IF = -0.47 * frontend->samprate;
  frontend->max_IF = 0.47 * frontend->samprate;
  frontend->isreal = false; // Complex IQ data
  frontend->bitspersample = 16; // 16-bit IQ samples from WebSDR
  
  return 0;
}

int cwsl_websdr_startup(struct frontend * const frontend) {
  struct cwsl_websdr * const cwsl = frontend->context;
  
  // Calculate scaling factor
  cwsl->scale = scale_AD(frontend);
  
  // Start UDP streaming
  if(cwsl_start_streaming(cwsl) != 0) {
    fprintf(stderr, "Failed to start IQ streaming\n");
    return -1;
  }
  
  // Start TCP keepalive thread
  pthread_create(&cwsl->tcp_thread, NULL, cwsl_tcp_keepalive_thread, cwsl);
  
  // Start UDP receive thread
  pthread_create(&cwsl->udp_thread, NULL, cwsl_udp_read_thread, cwsl);
  
  fprintf(stderr, "cwsl_websdr threads running\n");
  return 0;
}

double cwsl_websdr_tune(struct frontend * const frontend, double freq) {
  struct cwsl_websdr * const cwsl = (struct cwsl_websdr *)frontend->context;
  assert(cwsl != NULL);
  
  if(frontend->lock)
    return frontend->frequency; // Don't change frequency
  
  // Send frequency command to server
  char cmd[128];
  char response[256];
  snprintf(cmd, sizeof(cmd), "%s %d", CMD_FREQUENCY, (int)freq);
  
  pthread_mutex_lock(&cwsl->tcp_mutex);
  int ret = cwsl_send_command(cwsl, cmd, response, sizeof(response));
  pthread_mutex_unlock(&cwsl->tcp_mutex);
  
  if(ret == 0 && strncmp(response, RESP_OK, strlen(RESP_OK)) == 0) {
    frontend->frequency = freq * (1 + frontend->calibrate);
    if(Verbose)
      fprintf(stderr, "Tuned to %.3lf Hz\n", frontend->frequency);
  } else {
    fprintf(stderr, "Failed to tune to %.3lf Hz: %s\n", freq, response);
  }
  
  return frontend->frequency;
}

// Connect to CWSL WebSDR TCP control port
static int cwsl_connect(struct cwsl_websdr *cwsl) {
  struct addrinfo hints, *result, *rp;
  char port_str[16];
  
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  
  snprintf(port_str, sizeof(port_str), "%d", cwsl->tcp_port);
  
  int ret = getaddrinfo(cwsl->host, port_str, &hints, &result);
  if(ret != 0) {
    fprintf(stderr, "getaddrinfo: %s\n", gai_strerror(ret));
    return -1;
  }
  
  // Try each address until we successfully connect
  for(rp = result; rp != NULL; rp = rp->ai_next) {
    cwsl->tcp_fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
    if(cwsl->tcp_fd == -1)
      continue;
    
    if(connect(cwsl->tcp_fd, rp->ai_addr, rp->ai_addrlen) != -1)
      break; // Success
    
    close(cwsl->tcp_fd);
  }
  
  freeaddrinfo(result);
  
  if(rp == NULL) {
    fprintf(stderr, "Could not connect to %s:%d\n", cwsl->host, cwsl->tcp_port);
    return -1;
  }
  
  cwsl->connected = true;
  return 0;
}

// Disconnect from CWSL WebSDR
static void cwsl_disconnect(struct cwsl_websdr *cwsl) {
  if(!cwsl->connected)
    return;
  
  // Stop streaming if active
  if(cwsl->streaming) {
    char response[256];
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "%s iq", CMD_STOP);
    cwsl_send_command(cwsl, cmd, response, sizeof(response));
    cwsl->streaming = false;
  }
  
  // Detach from receiver
  char response[256];
  char cmd[128];
  snprintf(cmd, sizeof(cmd), "%s %d", CMD_DETACH, cwsl->receiver_id);
  cwsl_send_command(cwsl, cmd, response, sizeof(response));
  
  // Send quit command
  cwsl_send_command(cwsl, CMD_QUIT, response, sizeof(response));
  
  // Close sockets
  if(cwsl->tcp_fd >= 0) {
    close(cwsl->tcp_fd);
    cwsl->tcp_fd = -1;
  }
  
  if(cwsl->udp_fd >= 0) {
    close(cwsl->udp_fd);
    cwsl->udp_fd = -1;
  }
  
  cwsl->connected = false;
}

// Send command and receive response
static int cwsl_send_command(struct cwsl_websdr *cwsl, const char *cmd, char *response, size_t resp_size) {
  if(!cwsl->connected || cwsl->tcp_fd < 0)
    return -1;
  
  // Send command with CRLF
  char buf[512];
  int len = snprintf(buf, sizeof(buf), "%s\r\n", cmd);
  
  if(send(cwsl->tcp_fd, buf, len, 0) != len) {
    fprintf(stderr, "Failed to send command: %s\n", strerror(errno));
    return -1;
  }
  
  // Receive response with timeout
  struct pollfd pfd;
  pfd.fd = cwsl->tcp_fd;
  pfd.events = POLLIN;
  
  int ret = poll(&pfd, 1, TCP_TIMEOUT_MS);
  if(ret <= 0) {
    fprintf(stderr, "Timeout waiting for response\n");
    return -1;
  }
  
  ssize_t n = recv(cwsl->tcp_fd, response, resp_size - 1, 0);
  if(n <= 0) {
    fprintf(stderr, "Failed to receive response: %s\n", strerror(errno));
    return -1;
  }
  
  response[n] = '\0';
  
  // Remove trailing whitespace
  while(n > 0 && (response[n-1] == '\r' || response[n-1] == '\n' || response[n-1] == ' '))
    response[--n] = '\0';
  
  return 0;
}

// Attach to receiver - automatically finds best receiver for target frequency
static int cwsl_attach_receiver(struct cwsl_websdr *cwsl) {
  char cmd[128];
  char response[512];
  
  // Check if we should auto-select receiver
  if(cwsl->receiver_id >= 0) {
    // Explicit receiver specified, just attach to it
    snprintf(cmd, sizeof(cmd), "%s %d", CMD_ATTACH, cwsl->receiver_id);
    
    if(cwsl_send_command(cwsl, cmd, response, sizeof(response)) != 0)
      return -1;
    
    if(strncmp(response, RESP_OK, strlen(RESP_OK)) != 0) {
      fprintf(stderr, "Attach failed: %s\n", response);
      return -1;
    }
  } else {
    // Auto-select receiver based on target frequency
    double target_freq = cwsl->frontend->frequency;
    // Try to find receiver with L0 closest to target frequency
    int best_receiver = -1;
    int best_l0 = 0;
    int min_distance = INT_MAX;
    
    fprintf(stderr, "Searching for receiver covering %.3lf MHz...\n", target_freq / 1e6);
    
    for(int rx = 0; rx < 8; rx++) {
      snprintf(cmd, sizeof(cmd), "%s %d", CMD_ATTACH, rx);
      if(cwsl_send_command(cwsl, cmd, response, sizeof(response)) != 0) {
        fprintf(stderr, "  Receiver %d: timeout or error\n", rx);
        continue;
      }
      
      if(strncmp(response, RESP_OK, strlen(RESP_OK)) != 0) {
        fprintf(stderr, "  Receiver %d: %s\n", rx, response);
        continue;
      }
      
      // Parse L0 from response
      int l0 = 0;
      char *l0_str = strstr(response, "L0=");
      if(l0_str) {
        sscanf(l0_str, "L0=%d", &l0);
      }
      
      int distance = abs((int)target_freq - l0);
      
      fprintf(stderr, "  Receiver %d: L0=%.3lf MHz, distance=%.3lf MHz\n",
              rx, l0/1e6, distance/1e6);
      
      if(distance < min_distance) {
        min_distance = distance;
        best_receiver = rx;
        best_l0 = l0;
      }
      
      // Detach before trying next - use a short delay to ensure server processes it
      snprintf(cmd, sizeof(cmd), "%s %d", CMD_DETACH, rx);
      if(cwsl_send_command(cwsl, cmd, response, sizeof(response)) != 0) {
        fprintf(stderr, "  Warning: failed to detach from receiver %d\n", rx);
      }
      usleep(100000); // 100ms delay between receiver checks
    }
    
    if(best_receiver < 0) {
      fprintf(stderr, "No suitable receiver found for %.3lf MHz\n", target_freq / 1e6);
      return -1;
    }
    
    fprintf(stderr, "Selected receiver %d (L0=%.3lf MHz, distance=%.3lf MHz)\n",
            best_receiver, best_l0/1e6, min_distance/1e6);
    
    // Attach to best receiver
    cwsl->receiver_id = best_receiver;
    snprintf(cmd, sizeof(cmd), "%s %d", CMD_ATTACH, cwsl->receiver_id);
    
    if(cwsl_send_command(cwsl, cmd, response, sizeof(response)) != 0)
      return -1;
    
    if(strncmp(response, RESP_OK, strlen(RESP_OK)) != 0) {
      fprintf(stderr, "Attach failed: %s\n", response);
      return -1;
    }
  }
  
  // Parse parameters from final attach response
  char *token = strtok(response + strlen(RESP_OK), " ");
  while(token != NULL) {
    if(strncmp(token, "SampleRate=", 11) == 0) {
      cwsl->frontend->samprate = atoi(token + 11);
    } else if(strncmp(token, "BlockInSamples=", 15) == 0) {
      cwsl->block_in_samples = atoi(token + 15);
    } else if(strncmp(token, "L0=", 3) == 0) {
      cwsl->l0_frequency = atoi(token + 3);
    }
    token = strtok(NULL, " ");
  }
  
  fprintf(stderr, "Attached to receiver %d: SampleRate=%d, BlockInSamples=%d, L0=%d\n",
          cwsl->receiver_id, cwsl->frontend->samprate, cwsl->block_in_samples, cwsl->l0_frequency);
  
  return 0;
}

// Start IQ streaming
static int cwsl_start_streaming(struct cwsl_websdr *cwsl) {
  // Create UDP socket
  cwsl->udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if(cwsl->udp_fd < 0) {
    fprintf(stderr, "Failed to create UDP socket: %s\n", strerror(errno));
    return -1;
  }
  
  // Bind to UDP port
  memset(&cwsl->udp_addr, 0, sizeof(cwsl->udp_addr));
  cwsl->udp_addr.sin_family = AF_INET;
  cwsl->udp_addr.sin_addr.s_addr = INADDR_ANY;
  cwsl->udp_addr.sin_port = htons(cwsl->udp_port);
  
  if(bind(cwsl->udp_fd, (struct sockaddr *)&cwsl->udp_addr, sizeof(cwsl->udp_addr)) < 0) {
    fprintf(stderr, "Failed to bind UDP socket to port %d: %s\n", cwsl->udp_port, strerror(errno));
    close(cwsl->udp_fd);
    return -1;
  }
  
  // Send start command
  char cmd[128];
  char response[256];
  snprintf(cmd, sizeof(cmd), "%s iq %d %d", CMD_START, cwsl->udp_port, cwsl->scaling_factor);
  
  pthread_mutex_lock(&cwsl->tcp_mutex);
  int ret = cwsl_send_command(cwsl, cmd, response, sizeof(response));
  pthread_mutex_unlock(&cwsl->tcp_mutex);
  
  if(ret != 0 || strncmp(response, RESP_OK, strlen(RESP_OK)) != 0) {
    fprintf(stderr, "Failed to start streaming: %s\n", response);
    close(cwsl->udp_fd);
    return -1;
  }
  
  cwsl->streaming = true;
  
  if(Verbose)
    fprintf(stderr, "Started IQ streaming on UDP port %d with scaling factor %d\n",
            cwsl->udp_port, cwsl->scaling_factor);
  
  return 0;
}

// TCP keepalive thread
static void *cwsl_tcp_keepalive_thread(void *arg) {
  struct cwsl_websdr *cwsl = arg;
  
  pthread_detach(pthread_self());
  
  while(cwsl->connected && cwsl->streaming) {
    sleep(10);
    
    // Just check connection status
    // The server expects the TCP connection to stay alive during streaming
  }
  
  return NULL;
}

// UDP receive thread
static void *cwsl_udp_read_thread(void *arg) {
  struct cwsl_websdr *cwsl = arg;
  struct frontend *frontend = cwsl->frontend;
  
  realtime(INPUT_PRIORITY);
  stick_core();
  
  uint8_t buffer[UDP_BUFFER_SIZE];
  
  while(cwsl->streaming && !Stop_transfers) {
    ssize_t n = recv(cwsl->udp_fd, buffer, sizeof(buffer), 0);
    if(n <= 0) {
      if(errno == EINTR)
        continue;
      fprintf(stderr, "UDP recv error: %s\n", strerror(errno));
      break;
    }
    
    // CWSL WebSDR sends 16-bit signed IQ samples (I, Q interleaved)
    // Format: int16_t I, int16_t Q, int16_t I, int16_t Q, ...
    int sampcount = n / 4; // 4 bytes per complex sample (2 bytes I + 2 bytes Q)
    
    if(sampcount <= 0)
      continue;
    
    float complex * const wptr = frontend->in.input_write_pointer.c;
    int16_t *samples = (int16_t *)buffer;
    float energy = 0;
    
    for(int i = 0; i < sampcount; i++) {
      // Extract I and Q components
      int16_t i_val = samples[2*i];
      int16_t q_val = samples[2*i + 1];
      
      // Check for overrange (clipping)
      if(i_val == INT16_MIN || i_val == INT16_MAX) {
        frontend->overranges++;
        frontend->samp_since_over = 0;
      } else
        frontend->samp_since_over++;
      
      if(q_val == INT16_MIN || q_val == INT16_MAX) {
        frontend->overranges++;
        frontend->samp_since_over = 0;
      } else
        frontend->samp_since_over++;
      
      // Convert to complex float and apply scaling
      float complex samp = CMPLXF((float)i_val, (float)q_val);
      energy += cnrmf(samp);
      wptr[i] = cwsl->scale * samp;
    }
    
    write_cfilter(&frontend->in, NULL, sampcount); // Update write pointer, invoke FFT
    frontend->if_power += 0.05 * (energy / sampcount - frontend->if_power);
    frontend->samples += sampcount;
  }
  
  // Clean shutdown
  if(Verbose)
    fprintf(stderr, "cwsl_websdr: UDP thread shutting down\n");
  
  cwsl_disconnect(cwsl);
  
  return NULL;
}