// PSKReporter interface for ka9q-multidecoder
// Based on CWSL_DIGI C++ implementation and Python pskreporter.py
#ifndef _PSKREPORTER_H
#define _PSKREPORTER_H 1

#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <time.h>
#include "decode_parser.h"

// PSKReporter constants
#define PSK_SERVER_HOSTNAME "report.pskreporter.info"
#define PSK_SERVER_PORT 4739
#define PSK_MIN_SECONDS_BETWEEN_REPORTS 120
#define PSK_MAX_UDP_PAYLOAD_SIZE 1342
#define PSK_MAX_QUEUE_SIZE 10000  // Increased from 1000 to handle multi-band decoding

// Report structure for queue
struct psk_report {
    char callsign[MAX_CALLSIGN_LEN];
    char locator[MAX_LOCATOR_LEN];
    int snr;
    uint64_t frequency;
    time_t epoch_time;
    char mode[8];
};

// PSKReporter context
struct pskreporter {
    // Configuration
    char receiver_callsign[MAX_CALLSIGN_LEN];
    char receiver_locator[MAX_LOCATOR_LEN];
    char program_name[64];
    char antenna[64];
    
    // Socket
    int sockfd;
    struct sockaddr_in server_addr;
    
    // Packet tracking
    uint32_t packet_id;
    uint32_t sequence_number;
    int packets_sent_with_descriptors;
    time_t time_descriptors_sent;
    
    // Report queue
    struct psk_report *report_queue;
    int queue_head;
    int queue_tail;
    int queue_count;
    pthread_mutex_t queue_mutex;
    pthread_cond_t queue_cond;
    
    // Sent reports tracking (for duplicate prevention)
    struct psk_report *sent_reports;
    int sent_count;
    int sent_capacity;
    pthread_mutex_t sent_mutex;
    
    // Threading
    pthread_t send_thread;
    bool running;
    bool connected;
};

// Initialize PSKReporter interface
struct pskreporter *pskreporter_init(const char *callsign, const char *locator,
                                     const char *program_name, const char *antenna);

// Connect to PSKReporter server
bool pskreporter_connect(struct pskreporter *psk);

// Submit a report (thread-safe, queues for async sending)
bool pskreporter_submit(struct pskreporter *psk, const struct decode_info *info);

// Stop and cleanup
void pskreporter_stop(struct pskreporter *psk);

// Free resources
void pskreporter_free(struct pskreporter *psk);

#endif // _PSKREPORTER_H