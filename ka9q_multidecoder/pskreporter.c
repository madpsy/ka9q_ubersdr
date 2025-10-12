// PSKReporter implementation for ka9q-multidecoder
// Based on Python pskreporter.py and CWSL_DIGI C++
#define _GNU_SOURCE 1
#include "pskreporter.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <ctype.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

// Forward declarations
static void *send_thread_func(void *arg);
static void cleanup_sent_reports(struct pskreporter *psk);
static bool should_skip_report(struct pskreporter *psk, const struct psk_report *report, time_t *last_sent_ago);
static bool is_same_band(uint64_t freq1, uint64_t freq2);
static bool is_valid_grid_locator(const char *locator);
static int make_packets(struct pskreporter *psk);
static void build_header(uint8_t *buf, struct pskreporter *psk, time_t timestamp);
static int build_receiver_info(uint8_t *buf, struct pskreporter *psk);
static int build_sender_record(uint8_t *buf, const struct psk_report *report, bool has_locator);
static int build_descriptors(uint8_t *buf);
static bool send_packet(struct pskreporter *psk, const uint8_t *packet, size_t len);

// Validate grid locator format
static bool is_valid_grid_locator(const char *locator) {
    if (!locator || !*locator)
        return false;
    
    size_t len = strlen(locator);
    if (len != 4 && len != 6 && len != 8)
        return false;
    
    // First two characters must be A-R (valid Maidenhead)
    if (!isupper(locator[0]) || !isupper(locator[1]))
        return false;
    if (locator[0] < 'A' || locator[0] > 'R' || locator[1] < 'A' || locator[1] > 'R')
        return false;
    
    // Next two must be digits
    if (!isdigit(locator[2]) || !isdigit(locator[3]))
        return false;
    
    // If 6 or 8 characters, next two must be lowercase letters
    if (len >= 6) {
        if (!islower(locator[4]) || !islower(locator[5]))
            return false;
    }
    
    // If 8 characters, last two must be digits
    if (len == 8) {
        if (!isdigit(locator[6]) || !isdigit(locator[7]))
            return false;
    }
    
    return true;
}

// Initialize PSKReporter interface
struct pskreporter *pskreporter_init(const char *callsign, const char *locator,
                                     const char *program_name, const char *antenna) {
    if (!callsign || !locator || !program_name)
        return NULL;
    
    struct pskreporter *psk = calloc(1, sizeof(*psk));
    if (!psk)
        return NULL;
    
    // Copy configuration
    strncpy(psk->receiver_callsign, callsign, sizeof(psk->receiver_callsign) - 1);
    strncpy(psk->receiver_locator, locator, sizeof(psk->receiver_locator) - 1);
    strncpy(psk->program_name, program_name, sizeof(psk->program_name) - 1);
    if (antenna)
        strncpy(psk->antenna, antenna, sizeof(psk->antenna) - 1);
    
    // Initialize packet tracking
    psk->packet_id = (uint32_t)random();
    psk->sequence_number = 0;
    psk->packets_sent_with_descriptors = 0;
    psk->time_descriptors_sent = time(NULL) - 86400;
    
    // Allocate report queue
    psk->report_queue = calloc(PSK_MAX_QUEUE_SIZE, sizeof(struct psk_report));
    if (!psk->report_queue) {
        free(psk);
        return NULL;
    }
    psk->queue_head = 0;
    psk->queue_tail = 0;
    psk->queue_count = 0;
    
    // Initialize mutexes and condition variable
    pthread_mutex_init(&psk->queue_mutex, NULL);
    pthread_cond_init(&psk->queue_cond, NULL);
    pthread_mutex_init(&psk->sent_mutex, NULL);
    
    // Allocate sent reports tracking
    psk->sent_capacity = 1000;
    psk->sent_reports = calloc(psk->sent_capacity, sizeof(struct psk_report));
    if (!psk->sent_reports) {
        free(psk->report_queue);
        free(psk);
        return NULL;
    }
    psk->sent_count = 0;
    
    psk->sockfd = -1;
    psk->running = false;
    psk->connected = false;
    
    return psk;
}

// Connect to PSKReporter server
bool pskreporter_connect(struct pskreporter *psk) {
    if (!psk || psk->connected)
        return false;
    
    // Resolve hostname
    struct addrinfo hints, *result;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_protocol = IPPROTO_UDP;
    
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", PSK_SERVER_PORT);
    
    int ret = getaddrinfo(PSK_SERVER_HOSTNAME, port_str, &hints, &result);
    if (ret != 0) {
        fprintf(stderr, "PSKReporter: Failed to resolve %s: %s\n", 
                PSK_SERVER_HOSTNAME, gai_strerror(ret));
        return false;
    }
    
    // Create UDP socket
    psk->sockfd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (psk->sockfd < 0) {
        fprintf(stderr, "PSKReporter: Failed to create socket: %s\n", strerror(errno));
        freeaddrinfo(result);
        return false;
    }
    
    // Connect to server
    if (connect(psk->sockfd, result->ai_addr, result->ai_addrlen) < 0) {
        fprintf(stderr, "PSKReporter: Failed to connect: %s\n", strerror(errno));
        close(psk->sockfd);
        psk->sockfd = -1;
        freeaddrinfo(result);
        return false;
    }
    
    memcpy(&psk->server_addr, result->ai_addr, sizeof(struct sockaddr_in));
    freeaddrinfo(result);
    
    fprintf(stdout, "PSKReporter: Connected to %s:%d\n", 
            PSK_SERVER_HOSTNAME, PSK_SERVER_PORT);
    
    // Start sending thread
    psk->running = true;
    psk->connected = true;
    
    if (pthread_create(&psk->send_thread, NULL, send_thread_func, psk) != 0) {
        fprintf(stderr, "PSKReporter: Failed to create thread\n");
        close(psk->sockfd);
        psk->sockfd = -1;
        psk->running = false;
        psk->connected = false;
        return false;
    }
    
    return true;
}

// Submit a report (thread-safe)
bool pskreporter_submit(struct pskreporter *psk, const struct decode_info *info) {
    if (!psk || !info || !psk->connected || !info->has_callsign)
        return false;
    
    // Create report
    struct psk_report report;
    memset(&report, 0, sizeof(report));
    
    strncpy(report.callsign, info->callsign, sizeof(report.callsign) - 1);
    strncpy(report.mode, info->mode, sizeof(report.mode) - 1);
    report.snr = info->snr;
    // For WSPR, use tx_frequency (dial + offset from wsprd); FT8/FT4 frequency already includes offset
    report.frequency = info->is_wspr ? info->tx_frequency : info->frequency;
    report.epoch_time = info->timestamp;
    
    // Only include locator if it's valid
    if (info->has_locator && info->locator[0] != '\0' && is_valid_grid_locator(info->locator)) {
        strncpy(report.locator, info->locator, sizeof(report.locator) - 1);
    } else {
        report.locator[0] = '\0';  // No locator
    }
    
    // Add to queue
    pthread_mutex_lock(&psk->queue_mutex);
    
    if (psk->queue_count >= PSK_MAX_QUEUE_SIZE) {
        pthread_mutex_unlock(&psk->queue_mutex);
        fprintf(stderr, "PSKReporter: Queue full, dropping report\n");
        return false;
    }
    
    psk->report_queue[psk->queue_tail] = report;
    psk->queue_tail = (psk->queue_tail + 1) % PSK_MAX_QUEUE_SIZE;
    psk->queue_count++;
    
    pthread_cond_signal(&psk->queue_cond);
    pthread_mutex_unlock(&psk->queue_mutex);
    
    return true;
}

// Simple structure to track per-decoder statistics
// Group by dial frequency (MHz integer) and mode
struct decoder_stats {
    uint64_t dial_freq;  // Rounded to MHz for grouping
    char mode[8];
    int count;
};

// Get dial frequency by truncating to MHz
static uint64_t get_dial_frequency(uint64_t signal_freq) {
    // Truncate to MHz to group signals from same decoder
    // e.g., 24.916 MHz -> 24 MHz, 14.074 MHz -> 14 MHz
    return (signal_freq / 1000000) * 1000000;
}

// Send thread function
static void *send_thread_func(void *arg) {
    struct pskreporter *psk = (struct pskreporter *)arg;
    
    fprintf(stdout, "PSKReporter: Processing loop started\n");
    
    while (psk->running) {
        // Random sleep between 18-38 seconds
        int sleep_time = 18 + (random() % 21);
        
        fprintf(stdout, "PSKReporter: Sleeping for %d seconds before next send\n", sleep_time);
        
        for (int i = 0; i < sleep_time && psk->running; i++) {
            sleep(1);
        }
        
        if (!psk->running)
            break;
        
        // Clean up old sent reports
        cleanup_sent_reports(psk);
        
        // Check queue count safely
        pthread_mutex_lock(&psk->queue_mutex);
        int current_count = psk->queue_count;
        pthread_mutex_unlock(&psk->queue_mutex);
        
        fprintf(stdout, "PSKReporter: Woke up, checking queue (count=%d)\n", current_count);
        
        // Track statistics per decoder (dial freq + mode)
        struct decoder_stats stats[32];  // Support up to 32 different decoder combinations
        int num_stats = 0;
        
        // Make packets from queued reports
        int packet_count = 0;
        while (psk->running) {
            int count = make_packets(psk);
            packet_count += count;
            if (count == 0)
                break;
        }
        
        // Count reports per decoder from sent_reports (last packet_count entries)
        pthread_mutex_lock(&psk->sent_mutex);
        int start_idx = (psk->sent_count > packet_count) ? (psk->sent_count - packet_count) : 0;
        for (int i = start_idx; i < psk->sent_count; i++) {
            uint64_t dial_freq = get_dial_frequency(psk->sent_reports[i].frequency);
            const char *mode = psk->sent_reports[i].mode;
            
            // Find or create stats entry for this decoder
            int stats_idx = -1;
            for (int j = 0; j < num_stats; j++) {
                if (stats[j].dial_freq == dial_freq && strcmp(stats[j].mode, mode) == 0) {
                    stats_idx = j;
                    break;
                }
            }
            
            if (stats_idx == -1 && num_stats < 32) {
                stats_idx = num_stats++;
                stats[stats_idx].dial_freq = dial_freq;
                strncpy(stats[stats_idx].mode, mode, sizeof(stats[stats_idx].mode) - 1);
                stats[stats_idx].count = 0;
            }
            
            if (stats_idx >= 0) {
                stats[stats_idx].count++;
            }
        }
        pthread_mutex_unlock(&psk->sent_mutex);
        
        // Print summary grouped by decoder
        if (packet_count > 0) {
            fprintf(stdout, "PSKReporter Cycle Summary:\n");
            for (int i = 0; i < num_stats; i++) {
                fprintf(stdout, "  %3.0f MHz %s: %d reports\n",
                        stats[i].dial_freq / 1e6, stats[i].mode, stats[i].count);
            }
            fprintf(stdout, "  Total: %d reports sent this cycle\n", packet_count);
        } else {
            fprintf(stdout, "PSKReporter: No reports sent this cycle (all filtered as duplicates or queue empty)\n");
        }
    }
    
    fprintf(stdout, "PSKReporter: Processing loop stopped\n");
    return NULL;
}

// Clean up old sent reports
static void cleanup_sent_reports(struct pskreporter *psk) {
    time_t current_time = time(NULL);
    
    pthread_mutex_lock(&psk->sent_mutex);
    
    int new_count = 0;
    for (int i = 0; i < psk->sent_count; i++) {
        time_t age = current_time - psk->sent_reports[i].epoch_time;
        // Keep reports for 2x the duplicate window (like Python implementation)
        if (age >= 0 && age <= (PSK_MIN_SECONDS_BETWEEN_REPORTS * 2)) {
            if (new_count != i) {
                psk->sent_reports[new_count] = psk->sent_reports[i];
            }
            new_count++;
        }
    }
    psk->sent_count = new_count;
    
    pthread_mutex_unlock(&psk->sent_mutex);
}

// Check if two frequencies are on the same band
// Use finer divisor for LF/MF bands to match CWSL_DIGI behavior
static bool is_same_band(uint64_t freq1, uint64_t freq2) {
    int divisor = 1000000; // 1 MHz for HF and above
    // Use 100 kHz divisor for LF/MF bands (136 kHz, 472 kHz, etc.)
    if (freq1 <= 1000000 || freq2 <= 1000000) {
        divisor = 100000; // 100 kHz for LF/MF
    }
    return (freq1 / divisor) == (freq2 / divisor);
}

// Check if report should be skipped (duplicate)
// Check all sent reports to match CWSL_DIGI behavior
static bool should_skip_report(struct pskreporter *psk, const struct psk_report *report, time_t *last_sent_ago) {
    pthread_mutex_lock(&psk->sent_mutex);
    
    time_t current_time = time(NULL);
    
    // Check ALL sent reports (not just last 50) to properly detect duplicates
    for (int i = 0; i < psk->sent_count; i++) {
        if (strcmp(psk->sent_reports[i].callsign, report->callsign) == 0 &&
            is_same_band(psk->sent_reports[i].frequency, report->frequency) &&
            strcmp(psk->sent_reports[i].mode, report->mode) == 0) {
            // Found matching callsign/band/mode - check time since we last SENT it
            time_t time_since_last_sent = current_time - psk->sent_reports[i].epoch_time;
            if (time_since_last_sent <= PSK_MIN_SECONDS_BETWEEN_REPORTS) {
                // Too recent - skip as duplicate
                if (last_sent_ago) {
                    *last_sent_ago = time_since_last_sent;
                }
                pthread_mutex_unlock(&psk->sent_mutex);
                return true;
            }
        }
    }
    
    pthread_mutex_unlock(&psk->sent_mutex);
    return false;
}

// Make packets from queued reports
static int make_packets(struct pskreporter *psk) {
    pthread_mutex_lock(&psk->queue_mutex);
    
    if (psk->queue_count == 0) {
        pthread_mutex_unlock(&psk->queue_mutex);
        return 0;
    }
    
    pthread_mutex_unlock(&psk->queue_mutex);
    
    // Build packet
    uint8_t packet[PSK_MAX_UDP_PAYLOAD_SIZE];
    int offset = 0;
    
    // Add header (16 bytes)
    build_header(packet, psk, time(NULL));
    offset = 16;
    
    // Check if we need descriptors
    time_t time_since_descriptors = time(NULL) - psk->time_descriptors_sent;
    bool has_descriptors = false;
    
    if (time_since_descriptors >= 500 || psk->packets_sent_with_descriptors <= 3) {
        int desc_len = build_descriptors(packet + offset);
        offset += desc_len;
        has_descriptors = true;
    }
    
    // Add receiver information
    int recv_len = build_receiver_info(packet + offset, psk);
    offset += recv_len;
    
    // Add sender records
    int report_count = 0;
    
    while (offset < PSK_MAX_UDP_PAYLOAD_SIZE - 100) {
        pthread_mutex_lock(&psk->queue_mutex);
        
        if (psk->queue_count == 0) {
            pthread_mutex_unlock(&psk->queue_mutex);
            break;
        }
        
        struct psk_report report = psk->report_queue[psk->queue_head];
        psk->queue_head = (psk->queue_head + 1) % PSK_MAX_QUEUE_SIZE;
        psk->queue_count--;
        
        pthread_mutex_unlock(&psk->queue_mutex);
        
        // Skip duplicates
        time_t last_sent_ago = 0;
        if (should_skip_report(psk, &report, &last_sent_ago)) {
            fprintf(stdout, "PSKReporter: Skipping duplicate %s on %.3f MHz (%s) - last sent %ld seconds ago\n",
                    report.callsign, report.frequency / 1e6, report.mode, (long)last_sent_ago);
            continue;
        }
        
        // Add sender record
        bool has_locator = (report.locator[0] != '\0');
        int record_len = build_sender_record(packet + offset, &report, has_locator);
        offset += record_len;
        
        fprintf(stdout, "PSKReporter: Processing %s from %s on %.3f MHz, SNR %d dB (%s)\n",
                report.callsign,
                has_locator ? report.locator : "unknown",
                report.frequency / 1e6,
                report.snr,
                report.mode);
        
        // Track sent report with current timestamp (when we sent it, not when it was decoded)
        pthread_mutex_lock(&psk->sent_mutex);
        if (psk->sent_count < psk->sent_capacity) {
            report.epoch_time = time(NULL);  // Update to send time, not decode time
            psk->sent_reports[psk->sent_count++] = report;
        }
        pthread_mutex_unlock(&psk->sent_mutex);
        
        report_count++;
    }
    
    if (report_count == 0)
        return 0;
    
    // Update packet length in header
    packet[2] = (offset >> 8) & 0xFF;
    packet[3] = offset & 0xFF;
    
    // Send packet
    send_packet(psk, packet, offset);
    
    // Update tracking
    if (has_descriptors) {
        psk->time_descriptors_sent = time(NULL);
        psk->packets_sent_with_descriptors++;
    }
    
    psk->sequence_number++;
    
    // Wait 180ms before next packet
    usleep(180000);
    
    return report_count;
}

// Build packet header
static void build_header(uint8_t *buf, struct pskreporter *psk, time_t timestamp) {
    int offset = 0;
    
    // Version (0x000A)
    buf[offset++] = 0x00;
    buf[offset++] = 0x0A;
    
    // Length (filled in later)
    buf[offset++] = 0x00;
    buf[offset++] = 0x00;
    
    // Timestamp
    uint32_t ts = htonl((uint32_t)timestamp);
    memcpy(buf + offset, &ts, 4);
    offset += 4;
    
    // Sequence number
    uint32_t seq = htonl(psk->sequence_number);
    memcpy(buf + offset, &seq, 4);
    offset += 4;
    
    // Random ID
    uint32_t id = htonl(psk->packet_id);
    memcpy(buf + offset, &id, 4);
}

// Build receiver information record
static int build_receiver_info(uint8_t *buf, struct pskreporter *psk) {
    int offset = 0;
    uint8_t payload[256];
    int payload_len = 0;
    
    // Callsign
    int call_len = strlen(psk->receiver_callsign);
    payload[payload_len++] = call_len;
    memcpy(payload + payload_len, psk->receiver_callsign, call_len);
    payload_len += call_len;
    
    // Locator
    int loc_len = strlen(psk->receiver_locator);
    payload[payload_len++] = loc_len;
    memcpy(payload + payload_len, psk->receiver_locator, loc_len);
    payload_len += loc_len;
    
    // Program name
    int prog_len = strlen(psk->program_name);
    payload[payload_len++] = prog_len;
    memcpy(payload + payload_len, psk->program_name, prog_len);
    payload_len += prog_len;
    
    // Antenna information (if provided)
    if (psk->antenna[0] != '\0') {
        int ant_len = strlen(psk->antenna);
        payload[payload_len++] = ant_len;
        memcpy(payload + payload_len, psk->antenna, ant_len);
        payload_len += ant_len;
    } else {
        // Empty antenna field
        payload[payload_len++] = 0;
    }
    
    // Pad to 4-byte boundary
    while (payload_len % 4 != 0)
        payload[payload_len++] = 0;
    
    // Build record
    buf[offset++] = 0x99;
    buf[offset++] = 0x92;
    
    uint16_t total_size = payload_len + 4;
    buf[offset++] = (total_size >> 8) & 0xFF;
    buf[offset++] = total_size & 0xFF;
    
    memcpy(buf + offset, payload, payload_len);
    offset += payload_len;
    
    return offset;
}

// Build sender record
static int build_sender_record(uint8_t *buf, const struct psk_report *report, bool has_locator) {
    int offset = 0;
    uint8_t payload[256];
    int payload_len = 0;
    
    // Record type
    if (has_locator) {
        payload[payload_len++] = 0x64;
        payload[payload_len++] = 0xAF;
    } else {
        payload[payload_len++] = 0x62;
        payload[payload_len++] = 0xA7;
    }
    payload[payload_len++] = 0x00;
    payload[payload_len++] = 0x00;
    
    // Callsign
    int call_len = strlen(report->callsign);
    payload[payload_len++] = call_len;
    memcpy(payload + payload_len, report->callsign, call_len);
    payload_len += call_len;
    
    // Frequency (Hz)
    uint32_t freq = htonl((uint32_t)report->frequency);
    memcpy(payload + payload_len, &freq, 4);
    payload_len += 4;
    
    // SNR (preserve sign bit for negative values)
    payload[payload_len++] = (uint8_t)(report->snr & 0xFF);
    
    // Mode
    int mode_len = strlen(report->mode);
    payload[payload_len++] = mode_len;
    memcpy(payload + payload_len, report->mode, mode_len);
    payload_len += mode_len;
    
    // Locator (if present)
    if (has_locator) {
        int loc_len = strlen(report->locator);
        payload[payload_len++] = loc_len;
        memcpy(payload + payload_len, report->locator, loc_len);
        payload_len += loc_len;
    }
    
    // Info source (always 1)
    payload[payload_len++] = 0x01;
    
    // Timestamp
    uint32_t ts = htonl((uint32_t)report->epoch_time);
    memcpy(payload + payload_len, &ts, 4);
    payload_len += 4;
    
    // Pad to 4-byte boundary
    while (payload_len % 4 != 0)
        payload[payload_len++] = 0;
    
    // Update length field
    payload[2] = (payload_len >> 8) & 0xFF;
    payload[3] = payload_len & 0xFF;
    
    memcpy(buf, payload, payload_len);
    return payload_len;
}

// Build descriptor records
static int build_descriptors(uint8_t *buf) {
    int offset = 0;
    
    // Receiver descriptor (now includes antenna field)
    // Format: 0x0003 (descriptor type), length, 0x9992 (receiver record type), field count, padding
    // Then field descriptors: field_id (2 bytes), type (2 bytes), length (2 bytes), enterprise_id (2 bytes)
    uint8_t recv_desc[] = {
        0x00, 0x03,             // Descriptor type
        0x00, 0x2C,             // Length: 44 bytes (was 0x24/36, now +8 for antenna field)
        0x99, 0x92,             // Receiver record type
        0x00, 0x04,             // Field count: 4 fields (was 3, now includes antenna)
        0x00, 0x00,             // Padding
        // Field 1: receiverCallsign (0x8002)
        0x80, 0x02, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        // Field 2: receiverLocator (0x8004)
        0x80, 0x04, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        // Field 3: decoderSoftware (0x8008)
        0x80, 0x08, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        // Field 4: antennaInformation (0x8009) - NEW
        0x80, 0x09, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x00, 0x00,             // Padding
    };
    memcpy(buf + offset, recv_desc, sizeof(recv_desc));
    offset += sizeof(recv_desc);
    
    // Sender descriptor (with locator)
    uint8_t send_desc_loc[] = {
        0x00, 0x02, 0x00, 0x3C, 0x64, 0xAF, 0x00, 0x07,
        0x80, 0x01, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x05, 0x00, 0x04, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x0A, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x03, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x0B, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
        0x00, 0x96, 0x00, 0x04,
    };
    memcpy(buf + offset, send_desc_loc, sizeof(send_desc_loc));
    offset += sizeof(send_desc_loc);
    
    // Sender descriptor (without locator)
    uint8_t send_desc_no_loc[] = {
        0x00, 0x02, 0x00, 0x2E, 0x62, 0xA7, 0x00, 0x06,
        0x80, 0x01, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x05, 0x00, 0x04, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x0A, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
        0x80, 0x0B, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
        0x00, 0x96, 0x00, 0x04,
    };
    memcpy(buf + offset, send_desc_no_loc, sizeof(send_desc_no_loc));
    offset += sizeof(send_desc_no_loc);
    
    return offset;
}

// Send packet to PSKReporter
static bool send_packet(struct pskreporter *psk, const uint8_t *packet, size_t len) {
    if (psk->sockfd < 0)
        return false;
    
    ssize_t sent = send(psk->sockfd, packet, len, 0);
    if (sent < 0) {
        fprintf(stderr, "PSKReporter: Failed to send packet: %s\n", strerror(errno));
        return false;
    }
    
    return true;
}

// Stop PSKReporter
void pskreporter_stop(struct pskreporter *psk) {
    if (!psk)
        return;
    
    fprintf(stdout, "PSKReporter: Stopping...\n");
    
    psk->running = false;
    
    // Wake up thread
    pthread_cond_signal(&psk->queue_cond);
    
    // Wait for thread to finish
    if (psk->connected) {
        pthread_join(psk->send_thread, NULL);
    }
    
    if (psk->sockfd >= 0) {
        close(psk->sockfd);
        psk->sockfd = -1;
    }
    
    psk->connected = false;
    
    fprintf(stdout, "PSKReporter: Stopped\n");
}

// Free PSKReporter resources
void pskreporter_free(struct pskreporter *psk) {
    if (!psk)
        return;
    
    if (psk->running)
        pskreporter_stop(psk);
    
    pthread_mutex_destroy(&psk->queue_mutex);
    pthread_cond_destroy(&psk->queue_cond);
    pthread_mutex_destroy(&psk->sent_mutex);
    
    free(psk->report_queue);
    free(psk->sent_reports);
    free(psk);
}