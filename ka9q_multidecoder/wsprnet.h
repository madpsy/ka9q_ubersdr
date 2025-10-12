// WSPRNet interface for ka9q-multidecoder
// Based on Python wsprnet.py
#ifndef WSPRNET_H
#define WSPRNET_H

#include <stdint.h>
#include <stdbool.h>
#include <time.h>
#include <pthread.h>
#include "decode_parser.h"

// WSPRNet server configuration
#define WSPR_SERVER_HOSTNAME "wsprnet.org"
#define WSPR_SERVER_PORT 80
#define WSPR_MAX_QUEUE_SIZE 10000  // Increased from 1000 to handle multi-band decoding
#define WSPR_MAX_RETRIES 3
#define WSPR_WORKER_THREADS 5  // Number of parallel HTTP workers

// Mode codes from http://www.wsprnet.org/drupal/node/8983
#define WSPR_MODE_WSPR 2
#define WSPR_MODE_FST4W_120 3
#define WSPR_MODE_FST4W_300 5
#define WSPR_MODE_FST4W_900 16
#define WSPR_MODE_FST4W_1800 30

// WSPR report structure
struct wspr_report {
    char callsign[32];          // Transmitter callsign
    char locator[16];           // Transmitter grid locator
    int snr;                    // Signal-to-noise ratio in dB
    uint64_t frequency;         // Transmitter frequency in Hz
    uint64_t receiver_freq;     // Receiver frequency in Hz
    float dt;                   // Time drift in seconds
    int drift;                  // Frequency drift in Hz
    int dbm;                    // Transmitter power in dBm
    time_t epoch_time;          // Unix timestamp
    char mode[32];              // Mode name (WSPR, FST4W-120, etc.)
    int retry_count;            // Number of retry attempts
    time_t next_retry_time;     // Timestamp for next retry
};

// WSPRNet interface structure
struct wsprnet {
    // Configuration
    char receiver_callsign[32];
    char receiver_locator[16];
    char program_name[64];
    char program_version[16];
    
    // Report queues
    struct wspr_report *report_queue;
    int queue_head;
    int queue_tail;
    int queue_count;
    pthread_mutex_t queue_mutex;
    pthread_cond_t queue_cond;
    
    // Retry queue
    struct wspr_report *retry_queue;
    int retry_head;
    int retry_tail;
    int retry_count;
    pthread_mutex_t retry_mutex;
    
    // Threading
    pthread_t send_thread;
    pthread_t worker_threads[WSPR_WORKER_THREADS];
    bool running;
    bool connected;
    
    // Statistics
    int count_sends_ok;
    int count_sends_errored;
    int count_retries;
    pthread_mutex_t stats_mutex;
};

// Function declarations

// Initialize WSPRNet interface
struct wsprnet *wsprnet_init(const char *callsign, const char *locator,
                             const char *program_name, const char *program_version);

// Connect to WSPRNet (start processing thread)
bool wsprnet_connect(struct wsprnet *wspr);

// Submit a WSPR report (thread-safe)
bool wsprnet_submit(struct wsprnet *wspr, const struct decode_info *info);

// Stop WSPRNet processing
void wsprnet_stop(struct wsprnet *wspr);

// Free WSPRNet resources
void wsprnet_free(struct wsprnet *wspr);

// Get mode code from mode name
int wsprnet_get_mode_code(const char *mode);

#endif // WSPRNET_H