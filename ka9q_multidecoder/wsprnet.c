// WSPRNet implementation for ka9q-multidecoder
// Based on Python wsprnet.py
#define _GNU_SOURCE 1
#include "wsprnet.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

// Forward declarations
static void *send_thread_func(void *arg);
static void *worker_thread_func(void *arg);
static bool send_report(struct wsprnet *wspr, struct wspr_report *report);
static char *build_post_data(struct wsprnet *wspr, const struct wspr_report *report);
static char *build_http_request(const char *post_data);
static void url_encode(char *dest, size_t dest_size, const char *src);

// Retry delays in seconds
static const int retry_delays[] = {5, 15, 60};
static const int num_retry_delays = sizeof(retry_delays) / sizeof(retry_delays[0]);

// Initialize WSPRNet interface
struct wsprnet *wsprnet_init(const char *callsign, const char *locator,
                             const char *program_name, const char *program_version) {
    if (!callsign || !locator || !program_name || !program_version)
        return NULL;
    
    struct wsprnet *wspr = calloc(1, sizeof(*wspr));
    if (!wspr)
        return NULL;
    
    // Copy configuration
    strncpy(wspr->receiver_callsign, callsign, sizeof(wspr->receiver_callsign) - 1);
    strncpy(wspr->receiver_locator, locator, sizeof(wspr->receiver_locator) - 1);
    strncpy(wspr->program_name, program_name, sizeof(wspr->program_name) - 1);
    strncpy(wspr->program_version, program_version, sizeof(wspr->program_version) - 1);
    
    // Allocate report queue
    wspr->report_queue = calloc(WSPR_MAX_QUEUE_SIZE, sizeof(struct wspr_report));
    if (!wspr->report_queue) {
        free(wspr);
        return NULL;
    }
    wspr->queue_head = 0;
    wspr->queue_tail = 0;
    wspr->queue_count = 0;
    
    // Allocate retry queue
    wspr->retry_queue = calloc(WSPR_MAX_QUEUE_SIZE, sizeof(struct wspr_report));
    if (!wspr->retry_queue) {
        free(wspr->report_queue);
        free(wspr);
        return NULL;
    }
    wspr->retry_head = 0;
    wspr->retry_tail = 0;
    wspr->retry_count = 0;
    
    // Initialize mutexes and condition variable
    pthread_mutex_init(&wspr->queue_mutex, NULL);
    pthread_cond_init(&wspr->queue_cond, NULL);
    pthread_mutex_init(&wspr->retry_mutex, NULL);
    pthread_mutex_init(&wspr->stats_mutex, NULL);
    
    wspr->running = false;
    wspr->connected = false;
    wspr->count_sends_ok = 0;
    wspr->count_sends_errored = 0;
    wspr->count_retries = 0;
    
    return wspr;
}

// Connect to WSPRNet (start processing thread)
bool wsprnet_connect(struct wsprnet *wspr) {
    if (!wspr || wspr->connected)
        return false;
    
    fprintf(stdout, "WSPRNet: Starting interface for %s @ %s\n",
            wspr->receiver_callsign, wspr->receiver_locator);
    
    // Start worker threads
    wspr->running = true;
    wspr->connected = true;
    
    // Create worker threads for parallel HTTP requests
    for (int i = 0; i < WSPR_WORKER_THREADS; i++) {
        if (pthread_create(&wspr->worker_threads[i], NULL, worker_thread_func, wspr) != 0) {
            fprintf(stderr, "WSPRNet: Failed to create worker thread %d\n", i);
            wspr->running = false;
            wspr->connected = false;
            // Clean up already created threads
            for (int j = 0; j < i; j++) {
                pthread_cancel(wspr->worker_threads[j]);
                pthread_join(wspr->worker_threads[j], NULL);
            }
            return false;
        }
    }
    
    fprintf(stdout, "WSPRNet: Started %d worker threads for parallel uploads\n", WSPR_WORKER_THREADS);
    
    return true;
}

// Submit a WSPR report (thread-safe)
bool wsprnet_submit(struct wsprnet *wspr, const struct decode_info *info) {
    if (!wspr || !info || !wspr->connected)
        return false;
    
    // Only accept WSPR reports
    if (strcmp(info->mode, "WSPR") != 0)
        return false;
    
    if (!info->has_callsign || !info->has_locator)
        return false;
    
    // Filter out hashed callsigns (shown as <...>)
    if (strcmp(info->callsign, "<...>") == 0) {
        return false;
    }
    
    // Create report
    struct wspr_report report;
    memset(&report, 0, sizeof(report));
    
    strncpy(report.callsign, info->callsign, sizeof(report.callsign) - 1);
    strncpy(report.locator, info->locator, sizeof(report.locator) - 1);
    strncpy(report.mode, info->mode, sizeof(report.mode) - 1);
    report.snr = info->snr;
    report.frequency = info->tx_frequency;
    report.receiver_freq = info->frequency;
    report.dt = info->dt;
    report.drift = info->drift;
    report.dbm = info->dbm;
    report.epoch_time = info->timestamp;
    report.retry_count = 0;
    report.next_retry_time = 0;
    
    // Add to queue
    pthread_mutex_lock(&wspr->queue_mutex);
    
    if (wspr->queue_count >= WSPR_MAX_QUEUE_SIZE) {
        pthread_mutex_unlock(&wspr->queue_mutex);
        fprintf(stderr, "WSPRNet: Queue full, dropping report\n");
        return false;
    }
    
    wspr->report_queue[wspr->queue_tail] = report;
    wspr->queue_tail = (wspr->queue_tail + 1) % WSPR_MAX_QUEUE_SIZE;
    wspr->queue_count++;
    
    pthread_cond_signal(&wspr->queue_cond);
    pthread_mutex_unlock(&wspr->queue_mutex);
    
    return true;
}

// Worker thread function - processes reports from queue in parallel
static void *worker_thread_func(void *arg) {
    struct wsprnet *wspr = (struct wsprnet *)arg;
    
    while (wspr->running) {
        struct wspr_report report;
        bool have_report = false;
        
        // Try to get a report from the main queue
        pthread_mutex_lock(&wspr->queue_mutex);
        if (wspr->queue_count > 0) {
            report = wspr->report_queue[wspr->queue_head];
            wspr->queue_head = (wspr->queue_head + 1) % WSPR_MAX_QUEUE_SIZE;
            wspr->queue_count--;
            have_report = true;
        }
        pthread_mutex_unlock(&wspr->queue_mutex);
        
        // If no new report, check retry queue
        if (!have_report) {
            time_t current_time = time(NULL);
            pthread_mutex_lock(&wspr->retry_mutex);
            
            if (wspr->retry_count > 0) {
                report = wspr->retry_queue[wspr->retry_head];
                
                if (report.next_retry_time <= current_time) {
                    wspr->retry_head = (wspr->retry_head + 1) % WSPR_MAX_QUEUE_SIZE;
                    wspr->retry_count--;
                    have_report = true;
                }
            }
            pthread_mutex_unlock(&wspr->retry_mutex);
        }
        
        // If we have a report, send it
        if (have_report) {
            // Debug output
            fprintf(stdout, "WSPRNet: Sending %s from %s on %.6f MHz (rx %.6f MHz), SNR %d dB, %d dBm\n",
                    report.callsign, report.locator,
                    report.frequency / 1e6, report.receiver_freq / 1e6,
                    report.snr, report.dbm);
            
            // Send report
            bool success = send_report(wspr, &report);
            
            pthread_mutex_lock(&wspr->stats_mutex);
            if (success) {
                wspr->count_sends_ok++;
                fprintf(stdout, "WSPRNet: Successfully sent report for %s\n", report.callsign);
            } else {
                // Check if we should retry
                if (report.retry_count < WSPR_MAX_RETRIES) {
                    int delay_index = (report.retry_count < num_retry_delays) ?
                                     report.retry_count : (num_retry_delays - 1);
                    int delay = retry_delays[delay_index];
                    report.retry_count++;
                    report.next_retry_time = time(NULL) + delay;
                    
                    // Add to retry queue
                    pthread_mutex_lock(&wspr->retry_mutex);
                    if (wspr->retry_count < WSPR_MAX_QUEUE_SIZE) {
                        wspr->retry_queue[wspr->retry_tail] = report;
                        wspr->retry_tail = (wspr->retry_tail + 1) % WSPR_MAX_QUEUE_SIZE;
                        wspr->retry_count++;
                        wspr->count_retries++;
                    }
                    pthread_mutex_unlock(&wspr->retry_mutex);
                    
                    fprintf(stderr, "WSPRNet: Failed to send report for %s, will retry in %ds (attempt %d/%d)\n",
                            report.callsign, delay, report.retry_count, WSPR_MAX_RETRIES);
                } else {
                    wspr->count_sends_errored++;
                    fprintf(stderr, "WSPRNet: Failed to send report for %s after %d retries, giving up\n",
                            report.callsign, WSPR_MAX_RETRIES);
                }
            }
            pthread_mutex_unlock(&wspr->stats_mutex);
        } else {
            // No reports available, sleep briefly
            usleep(100000);  // 100ms
        }
    }
    
    return NULL;
}

// Send a single report to WSPRNet
static bool send_report(struct wsprnet *wspr, struct wspr_report *report) {
    int sockfd = -1;
    bool success = false;
    
    // Resolve hostname
    struct addrinfo hints, *result;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", WSPR_SERVER_PORT);
    
    int ret = getaddrinfo(WSPR_SERVER_HOSTNAME, port_str, &hints, &result);
    if (ret != 0) {
        fprintf(stderr, "WSPRNet: Failed to resolve %s: %s\n", 
                WSPR_SERVER_HOSTNAME, gai_strerror(ret));
        return false;
    }
    
    // Create TCP socket
    sockfd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sockfd < 0) {
        fprintf(stderr, "WSPRNet: Failed to create socket: %s\n", strerror(errno));
        freeaddrinfo(result);
        return false;
    }
    
    // Set timeout
    struct timeval timeout;
    timeout.tv_sec = 3;
    timeout.tv_usec = 0;
    setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    
    // Connect to server
    if (connect(sockfd, result->ai_addr, result->ai_addrlen) < 0) {
        fprintf(stderr, "WSPRNet: Failed to connect: %s\n", strerror(errno));
        close(sockfd);
        freeaddrinfo(result);
        return false;
    }
    
    freeaddrinfo(result);
    
    // Build POST data
    char *post_data = build_post_data(wspr, report);
    if (!post_data) {
        close(sockfd);
        return false;
    }
    
    // Build HTTP request
    char *request = build_http_request(post_data);
    free(post_data);
    
    if (!request) {
        close(sockfd);
        return false;
    }
    
    // Send request
    size_t request_len = strlen(request);
    ssize_t sent = send(sockfd, request, request_len, 0);
    free(request);
    
    if (sent < 0) {
        fprintf(stderr, "WSPRNet: Failed to send request: %s\n", strerror(errno));
        close(sockfd);
        return false;
    }
    
    // Read response
    char response[4096];
    ssize_t received = recv(sockfd, response, sizeof(response) - 1, 0);
    
    if (received > 0) {
        response[received] = '\0';
        
        // Check for success (HTTP 200 OK)
        if (strstr(response, "200 OK") || strstr(response, "HTTP/1.1 200")) {
            success = true;
        } else {
            fprintf(stderr, "WSPRNet: Unexpected response: %.100s\n", response);
        }
    } else if (received == 0) {
        fprintf(stderr, "WSPRNet: Connection closed by server\n");
    } else {
        fprintf(stderr, "WSPRNet: Failed to receive response: %s\n", strerror(errno));
    }
    
    close(sockfd);
    return success;
}

// Build POST data for WSPRNet submission
static char *build_post_data(struct wsprnet *wspr, const struct wspr_report *report) {
    // Convert epoch time to UTC datetime
    struct tm *tm_info = gmtime(&report->epoch_time);
    if (!tm_info)
        return NULL;
    
    char date[16], time_str[16];
    strftime(date, sizeof(date), "%y%m%d", tm_info);
    strftime(time_str, sizeof(time_str), "%H%M", tm_info);
    
    // Get mode code
    int mode_code = wsprnet_get_mode_code(report->mode);
    
    // Build parameters
    char *post_data = malloc(2048);
    if (!post_data)
        return NULL;
    
    char encoded_rcall[128], encoded_rgrid[128];
    char encoded_tcall[128], encoded_tgrid[128];
    char encoded_version[256];
    
    url_encode(encoded_rcall, sizeof(encoded_rcall), wspr->receiver_callsign);
    url_encode(encoded_rgrid, sizeof(encoded_rgrid), wspr->receiver_locator);
    url_encode(encoded_tcall, sizeof(encoded_tcall), report->callsign);
    url_encode(encoded_tgrid, sizeof(encoded_tgrid), report->locator);
    
    char version_str[128];
    snprintf(version_str, sizeof(version_str), "%s %s", 
             wspr->program_name, wspr->program_version);
    url_encode(encoded_version, sizeof(encoded_version), version_str);
    
    snprintf(post_data, 2048,
             "function=wspr&rcall=%s&rgrid=%s&rqrg=%.6f&date=%s&time=%s&sig=%d&dt=%.2f&drift=%d&tcall=%s&tgrid=%s&tqrg=%.6f&dbm=%d&version=%s&mode=%d",
             encoded_rcall,
             encoded_rgrid,
             report->receiver_freq / 1000000.0,  // Receiver dial frequency (rqrg)
             date,
             time_str,
             report->snr,
             report->dt,
             report->drift,
             encoded_tcall,
             encoded_tgrid,
             report->frequency / 1000000.0,      // Transmitter frequency from wsprd (tqrg)
             report->dbm,
             encoded_version,
             mode_code);
    
    return post_data;
}

// Build complete HTTP POST request
static char *build_http_request(const char *post_data) {
    size_t post_len = strlen(post_data);
    size_t request_size = 1024 + post_len;
    char *request = malloc(request_size);
    
    if (!request)
        return NULL;
    
    snprintf(request, request_size,
             "POST /post? HTTP/1.1\r\n"
             "Connection: Keep-Alive\r\n"
             "Host: %s\r\n"
             "Content-Type: application/x-www-form-urlencoded\r\n"
             "Content-Length: %zu\r\n"
             "Accept-Language: en-US,*\r\n"
             "User-Agent: Mozilla/5.0\r\n"
             "\r\n"
             "%s",
             WSPR_SERVER_HOSTNAME,
             post_len,
             post_data);
    
    return request;
}

// URL encode a string
static void url_encode(char *dest, size_t dest_size, const char *src) {
    const char *hex = "0123456789ABCDEF";
    size_t dest_pos = 0;
    
    while (*src && dest_pos < dest_size - 4) {
        if ((*src >= 'A' && *src <= 'Z') ||
            (*src >= 'a' && *src <= 'z') ||
            (*src >= '0' && *src <= '9') ||
            *src == '-' || *src == '_' || *src == '.' || *src == '~') {
            dest[dest_pos++] = *src;
        } else if (*src == ' ') {
            dest[dest_pos++] = '+';
        } else {
            dest[dest_pos++] = '%';
            dest[dest_pos++] = hex[(*src >> 4) & 0x0F];
            dest[dest_pos++] = hex[*src & 0x0F];
        }
        src++;
    }
    dest[dest_pos] = '\0';
}

// Get mode code from mode name
int wsprnet_get_mode_code(const char *mode) {
    if (strcmp(mode, "WSPR") == 0)
        return WSPR_MODE_WSPR;
    else if (strcmp(mode, "FST4W-120") == 0)
        return WSPR_MODE_FST4W_120;
    else if (strcmp(mode, "FST4W-300") == 0)
        return WSPR_MODE_FST4W_300;
    else if (strcmp(mode, "FST4W-900") == 0)
        return WSPR_MODE_FST4W_900;
    else if (strcmp(mode, "FST4W-1800") == 0)
        return WSPR_MODE_FST4W_1800;
    else
        return WSPR_MODE_WSPR;  // Default
}

// Stop WSPRNet processing
void wsprnet_stop(struct wsprnet *wspr) {
    if (!wspr)
        return;
    
    fprintf(stdout, "WSPRNet: Stopping...\n");
    
    wspr->running = false;
    
    // Wait for all worker threads to finish
    if (wspr->connected) {
        for (int i = 0; i < WSPR_WORKER_THREADS; i++) {
            pthread_join(wspr->worker_threads[i], NULL);
        }
    }
    
    wspr->connected = false;
    
    // Print statistics
    pthread_mutex_lock(&wspr->stats_mutex);
    fprintf(stdout, "WSPRNet: Successful reports: %d, Failed reports: %d, Retries: %d\n",
            wspr->count_sends_ok, wspr->count_sends_errored, wspr->count_retries);
    pthread_mutex_unlock(&wspr->stats_mutex);
    
    fprintf(stdout, "WSPRNet: Stopped\n");
}

// Free WSPRNet resources
void wsprnet_free(struct wsprnet *wspr) {
    if (!wspr)
        return;
    
    if (wspr->running)
        wsprnet_stop(wspr);
    
    pthread_mutex_destroy(&wspr->queue_mutex);
    pthread_cond_destroy(&wspr->queue_cond);
    pthread_mutex_destroy(&wspr->retry_mutex);
    pthread_mutex_destroy(&wspr->stats_mutex);
    
    free(wspr->report_queue);
    free(wspr->retry_queue);
    free(wspr);
}