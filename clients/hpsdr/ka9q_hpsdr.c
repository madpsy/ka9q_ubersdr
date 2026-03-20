/* Copyright (C)
*   11/2025 - Rick Koch, N1GP
*   Wrote ka9q_hpsdr with the help of various open sources on the internet.
*     Christoph v. Wüllen, https://github.com/dl1ycf/pihpsdr
*     John Melton, https://github.com/g0orx/linhpsdr
*     Phil Karn, https://github.com/ka9q/ka9q-radio
*
*   It uses HPSDR Protocol-2 defined here:
*     https://github.com/TAPR/OpenHPSDR-Firmware/blob/master/Protocol%202/Documentation/openHPSDR%20Ethernet%20Protocol%20v4.3.pdf
*
*   This program is free software: you can redistribute it and/or modify
*   it under the terms of the GNU General Public License as published by
*   the Free Software Foundation, either version 3 of the License, or
*   (at your option) any later version.
*
*   This program is distributed in the hope that it will be useful,
*   but WITHOUT ANY WARRANTY; without even the implied warranty of
*   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*   GNU General Public License for more details.
*
*   You should have received a copy of the GNU General Public License
*   along with this program.  If not, see <https://www.gnu.org/licenses/>.
*
*/

/*
 * This program simulates an HPSDR Hermes board with up to 10 DDC receiver
 * slices, bridging HPSDR Protocol-2 clients (Thetis, piHPSDR, SparkSDR etc)
 * to UberSDR (https://github.com/ka9q/ubersdr).
 *
 * This file has been heavily modified from its original form for use with
 * UberSDR. It connects to the UberSDR WebSocket API using IQ mode
 * (iq48/iq96/iq192) rather than consuming ka9q-radio multicast streams.
 *
 * Key modifications:
 *   - WebSocket client using libwebsockets (one connection per DDC receiver)
 *   - Dynamic IQ sample rate selection based on HPSDR client bandwidth request
 *   - Reconnect logic: rate/mode changes trigger WebSocket disconnect+reconnect
 *     with the new IQ mode baked into the URL
 *   - lws context destroy/recreate on reconnect to avoid TLS teardown delays
 *   - Client disconnect watchdog: if no high-priority packet is received for
 *     5 seconds, streaming is stopped and DDC state is cleared
 *   - zstd decompression of PCM frames received from UberSDR
 */

#include "ka9q_hpsdr.h"

static int do_exit = 0;
struct main_cb mcb;
static int sock_udp;
static int hp_sock;
static int interface_offset = 0;

static u_int send_flags = 0;
static u_int done_send_flags = 0;

/*
 * Mutex serialising lws_create_context() calls across ws_threads.
 *
 * lws_context_init_ssl_library() calls OPENSSL_init_ssl() and checks a
 * one-time .bss flag.  Concurrent calls from multiple threads race on that
 * flag and can corrupt OpenSSL global state, causing SIGSEGV in
 * CRYPTO_THREAD_read_lock(rwlock=0x0) during a TLS handshake.
 *
 * Each ws_thread has its own lws_context (so lws_service() is never called
 * concurrently on the same context — lws is not thread-safe for that).
 * Only lws_create_context() needs serialisation.
 */
static pthread_mutex_t lws_ctx_create_mutex = PTHREAD_MUTEX_INITIALIZER;

static pthread_mutex_t send_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t send_cond = PTHREAD_COND_INITIALIZER;
static pthread_mutex_t done_send_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t done_send_cond = PTHREAD_COND_INITIALIZER;
static int running = 0;
static bool gen_rcvd = false;
static bool wbenable = false;
static int wide_len;
static int wide_size;
static int wide_rate;
static int wide_ppf;

static struct sockaddr_in addr_new;

// protocol2 stuff
static int bits = -1;
static long rxfreq[MAX_RCVRS] = {0,};
static int ddcenable[MAX_RCVRS] = {0,};
static int rxrate[MAX_RCVRS] = {0,};
static int adcdither = -1;
static int adcrandom = -1;
static int stepatt0 = -1;
static int ddc_port = 1025;
static int mic_port = 1026;
static int hp_port = 1027; // also wb_port
static int ddc0_port = 1035;
static unsigned char pbuf[MAX_RCVRS][238*6];

static pthread_t ws_thread_id[MAX_RCVRS];
static pthread_t highprio_thread_id = 0;
static pthread_t ddc_specific_thread_id = 0;
static pthread_t mic_thread_id = 0;
static pthread_t wb_thread_id = 0;
static pthread_t rx_thread_id[MAX_RCVRS] = {0,};
static void   *highprio_thread(void*);
static void   *ddc_specific_thread(void*);
static void   *mic_thread(void *);
static void   *wb_thread(void *);
static void   *rx_thread(void *);
static void   *ws_thread(void *);

// using clock_nanosleep of librt
extern int clock_nanosleep(clockid_t __clock_id, int __flags,
                           __const struct timespec *__req,
                           struct timespec *__rem);

uint64_t get_posix_clock_time_us()
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
        return (uint64_t)(ts.tv_sec * 1000000 + ts.tv_nsec / 1000);
    } else {
        return 0; // Error handling
    }
}

/* Generate a UUID v4 string into buf (must be at least 37 bytes) */
void generate_uuid(char *buf)
{
    uuid_t uu;
    uuid_generate_random(uu);
    uuid_unparse_lower(uu, buf);
}

/*
 * POST to ubersdr /connection endpoint to request permission.
 *
 * url      — base HTTP URL, e.g. "http://host:8080"
 * session  — per-receiver UUID string
 * password — optional password (may be empty string)
 *
 * Sends: POST /connection  Content-Type: application/json
 *        {"user_session_id":"<uuid>","password":"<pw>"}
 *
 * Expects JSON response: {"allowed":true,...}
 *
 * Returns true if allowed (or if the check itself fails — same behaviour
 * as the Go client which continues on network error).
 */
bool check_ubersdr_connection(const char *url)
{
    /* url is the base HTTP URL; append /connection */
    char http_url[512];
    /* Strip trailing slash if present */
    size_t ulen = strlen(url);
    if (ulen > 0 && url[ulen-1] == '/')
        ulen--;
    snprintf(http_url, sizeof(http_url), "%.*s/connection", (int)ulen, url);

    /* Build JSON body — session_id and password come from mcb */
    char json_body[512];
    snprintf(json_body, sizeof(json_body),
             "{\"user_session_id\":\"%s\",\"password\":\"%s\"}",
             /* We don't have a per-receiver session here; caller passes mcb fields.
              * Use a placeholder — real per-receiver call is done in ws_thread. */
             "", mcb.ubersdr_password);

    /* Use curl to POST and capture the response body */
    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
             "curl -s --max-time 10 -A 'UberSDR_HPSDR/1.0' "
             "-X POST -H 'Content-Type: application/json' "
             "-d '%s' '%s' 2>/dev/null",
             json_body, http_url);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        t_print("check_ubersdr_connection: popen failed, continuing anyway\n");
        return true; /* continue on error, same as Go client */
    }

    char resp[512] = {0};
    size_t rlen = 0;
    char line[128];
    while (fgets(line, sizeof(line), fp) != NULL && rlen < sizeof(resp) - 1) {
        size_t ll = strlen(line);
        if (rlen + ll < sizeof(resp) - 1) {
            memcpy(resp + rlen, line, ll);
            rlen += ll;
        }
    }
    resp[rlen] = '\0';
    pclose(fp);

    if (rlen == 0) {
        t_print("check_ubersdr_connection: no response from %s, continuing anyway\n", http_url);
        return true;
    }

    /* Simple JSON parse: look for "allowed":true or "allowed":false */
    char *allowed_ptr = strstr(resp, "\"allowed\"");
    if (!allowed_ptr) {
        t_print("check_ubersdr_connection: no 'allowed' field in response, continuing\n");
        return true;
    }

    char *colon = strchr(allowed_ptr, ':');
    if (!colon) return true;

    /* skip whitespace */
    colon++;
    while (*colon == ' ' || *colon == '\t') colon++;

    if (strncmp(colon, "true", 4) == 0) {
        t_print("check_ubersdr_connection: %s allowed\n", http_url);
        return true;
    }

    /* Extract reason if present */
    char *reason_ptr = strstr(resp, "\"reason\"");
    char reason[128] = "unknown";
    if (reason_ptr) {
        char *q1 = strchr(reason_ptr + 8, '"');
        if (q1) {
            char *q2 = strchr(q1 + 1, '"');
            if (q2) {
                size_t rn = q2 - q1 - 1;
                if (rn >= sizeof(reason)) rn = sizeof(reason) - 1;
                memcpy(reason, q1 + 1, rn);
                reason[rn] = '\0';
            }
        }
    }
    t_print("check_ubersdr_connection: %s rejected: %s\n", http_url, reason);
    return false;
}

/*
 * Per-receiver version of check_ubersdr_connection that uses the receiver's
 * own session_id.
 */
static bool check_ubersdr_connection_rcb(const char *base_url, struct rcvr_cb *rcb)
{
    char http_url[512];
    size_t ulen = strlen(base_url);
    if (ulen > 0 && base_url[ulen-1] == '/') ulen--;
    snprintf(http_url, sizeof(http_url), "%.*s/connection", (int)ulen, base_url);

    char json_body[512];
    snprintf(json_body, sizeof(json_body),
             "{\"user_session_id\":\"%s\",\"password\":\"%s\"}",
             rcb->session_id, mcb.ubersdr_password);

    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
             "curl -s --max-time 3 -A 'UberSDR_HPSDR/1.0' "
             "-X POST -H 'Content-Type: application/json' "
             "-d '%s' '%s' 2>/dev/null",
             json_body, http_url);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        t_print("ws_thread(%d): connection check popen failed, continuing\n", rcb->rcvr_num);
        return true;
    }

    char resp[512] = {0};
    size_t rlen = 0;
    char line[128];
    while (fgets(line, sizeof(line), fp) != NULL && rlen < sizeof(resp) - 1) {
        size_t ll = strlen(line);
        if (rlen + ll < sizeof(resp) - 1) {
            memcpy(resp + rlen, line, ll);
            rlen += ll;
        }
    }
    resp[rlen] = '\0';
    pclose(fp);

    if (rlen == 0) {
        t_print("ws_thread(%d): no response from %s, continuing\n", rcb->rcvr_num, http_url);
        return true;
    }

    char *allowed_ptr = strstr(resp, "\"allowed\"");
    if (!allowed_ptr) return true;

    char *colon = strchr(allowed_ptr, ':');
    if (!colon) return true;
    colon++;
    while (*colon == ' ' || *colon == '\t') colon++;

    if (strncmp(colon, "true", 4) == 0) {
        t_print("ws_thread(%d): connection allowed\n", rcb->rcvr_num);
        return true;
    }

    t_print("ws_thread(%d): connection rejected by %s\n", rcb->rcvr_num, http_url);
    return false;
}

/*
 * Decode a zstd-compressed (or raw) PCM binary frame from ubersdr.
 *
 * Exact header layout (from ubersdr server source / Go client pcm_decoder.go):
 *
 * Full header (magic 0x5043 "PC" LE, 37 bytes):
 *   [0..1]   magic 0x5043 (little-endian uint16)
 *   [2]      version (must be 2)
 *   [3]      format type (0=PCM, 2=PCM-zstd)
 *   [4..11]  RTP timestamp (uint64, little-endian)
 *   [12..19] wall clock time (uint64, little-endian)
 *   [20..23] sample rate (uint32, little-endian)
 *   [24]     channels (uint8)
 *   [25..28] baseband power (float32, little-endian)
 *   [29..32] noise density (float32, little-endian)
 *   [33..36] reserved (uint32)
 *   [37+]    PCM data (big-endian int16 interleaved stereo: I=left, Q=right)
 *
 * Minimal header (magic 0x504D "PM" LE, 13 bytes):
 *   [0..1]   magic 0x504D (little-endian uint16)
 *   [2]      version
 *   [3..10]  RTP timestamp (uint64, little-endian)
 *   [11..12] reserved (uint16)
 *   [13+]    PCM data (same format as above)
 *   sample_rate and channels are inherited from the last full header.
 *
 * The entire frame (header + PCM) is zstd-compressed before transmission.
 *
 * On success, fills iq_out[] with complex float samples (scaled to ±1.0),
 * sets *out_count, *out_sample_rate, *out_channels, and returns true.
 * Returns false on any error.
 */
bool decode_pcm_frame(struct rcvr_cb *rcb,
                      const uint8_t *compressed, size_t compressed_len,
                      float complex *iq_out, int max_samples,
                      int *out_count, int *out_sample_rate, int *out_channels)
{
    /* Try zstd decompression first; fall back to treating data as raw if it fails */
    size_t dec_size = ZSTD_decompressDCtx(rcb->zstd_dctx,
                                           rcb->ws_rx_buf, WS_RX_BUF_SIZE,
                                           compressed, compressed_len);
    const uint8_t *p;
    size_t p_len;

    if (ZSTD_isError(dec_size)) {
        /* Not zstd — treat the raw bytes as the decompressed frame */
        if (compressed_len > WS_RX_BUF_SIZE) {
            t_print("decode_pcm_frame: raw frame too large (%zu)\n", compressed_len);
            return false;
        }
        memcpy(rcb->ws_rx_buf, compressed, compressed_len);
        p     = rcb->ws_rx_buf;
        p_len = compressed_len;
    } else {
        p     = rcb->ws_rx_buf;
        p_len = dec_size;
    }

    if (p_len < 4) {
        t_print("decode_pcm_frame: frame too short (%zu bytes)\n", p_len);
        return false;
    }

    /* Magic is little-endian uint16 */
    uint16_t magic = (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
    const uint8_t *pcm_data;
    size_t pcm_len;

    if (magic == PCM_MAGIC_FULL) {
        /* Full header: 37 bytes */
        if (p_len < PCM_FULL_HEADER_SIZE) {
            t_print("decode_pcm_frame: full header too short (%zu)\n", p_len);
            return false;
        }
        uint8_t version = p[2];
        if (version != 2) {
            t_print("decode_pcm_frame: unsupported version %d\n", version);
            return false;
        }
        /* sample_rate at bytes 20-23 (LE uint32) */
        int sr = (int)((uint32_t)p[20] | ((uint32_t)p[21] << 8) |
                       ((uint32_t)p[22] << 16) | ((uint32_t)p[23] << 24));
        int ch = (int)p[24];
        *out_sample_rate = sr;
        *out_channels    = ch;
        /* Cache for minimal-header packets */
        rcb->last_sample_rate = sr;
        rcb->last_channels    = ch;
        pcm_data = p + PCM_FULL_HEADER_SIZE;
        pcm_len  = p_len - PCM_FULL_HEADER_SIZE;

    } else if (magic == PCM_MAGIC_MINIMAL) {
        /* Minimal header: 13 bytes; sample_rate/channels from last full header */
        if (p_len < PCM_MINIMAL_HEADER_SIZE) {
            t_print("decode_pcm_frame: minimal header too short (%zu)\n", p_len);
            return false;
        }
        if (rcb->last_sample_rate == 0 || rcb->last_channels == 0) {
            t_print("decode_pcm_frame: minimal header before full header\n");
            return false;
        }
        *out_sample_rate = rcb->last_sample_rate;
        *out_channels    = rcb->last_channels;
        pcm_data = p + PCM_MINIMAL_HEADER_SIZE;
        pcm_len  = p_len - PCM_MINIMAL_HEADER_SIZE;

    } else {
        t_print("decode_pcm_frame: unknown magic 0x%04X\n", magic);
        return false;
    }

    /* PCM data is big-endian int16 interleaved stereo: I=left, Q=right */
    int n_complex = (int)(pcm_len / 4); /* 4 bytes per complex sample (2×int16) */
    if (n_complex > max_samples)
        n_complex = max_samples;

    for (int i = 0; i < n_complex; i++) {
        int16_t i_raw = (int16_t)(((uint16_t)pcm_data[4*i]   << 8) | pcm_data[4*i+1]);
        int16_t q_raw = (int16_t)(((uint16_t)pcm_data[4*i+2] << 8) | pcm_data[4*i+3]);
        float fi = (float)i_raw / 32768.0f;
        float fq = (float)q_raw / 32768.0f;
        iq_out[i] = fi + fq * _Complex_I;
    }

    *out_count = n_complex;
    return true;
}

/*
 * Fetch public UberSDR instances from the instances API.
 * Filters to only those supporting iq48/iq96/iq192 (≤192 kHz).
 * Prints a numbered list and prompts the user to pick one.
 * On success, writes the chosen HTTP base URL into url_out (size url_out_size)
 * and returns true.  Returns false if discovery fails or user cancels.
 */
#define MAX_INSTANCES 64
#define MAX_IQ_MODES  8

struct ubersdr_instance {
    char name[128];
    char callsign[32];
    char location[128];
    char host[128];
    char port[8];
    bool tls;
    char iq_modes[MAX_IQ_MODES][16]; /* e.g. "iq48", "iq96", "iq192" */
    int  n_modes;
};

/* Find the matching closing brace for the '{' at *start.
 * Returns pointer to the '}', or NULL if not found. */
static const char *find_matching_brace(const char *start)
{
    int depth = 0;
    bool in_string = false;
    for (const char *p = start; *p; p++) {
        if (in_string) {
            if (*p == '\\') { p++; continue; } /* skip escaped char */
            if (*p == '"') in_string = false;
        } else {
            if (*p == '"') { in_string = true; continue; }
            if (*p == '{') depth++;
            else if (*p == '}') {
                depth--;
                if (depth == 0) return p;
            }
        }
    }
    return NULL;
}

/* Extract a JSON string value for key from obj into out (size out_size).
 * Returns true on success. */
static bool json_str(const char *obj, const char *key, char *out, size_t out_size)
{
    char search[64];
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *p = strstr(obj, search);
    if (!p) return false;
    p += strlen(search);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (*p != '"') return false;
    p++;
    const char *end = strchr(p, '"');
    if (!end) return false;
    size_t len = end - p;
    if (len >= out_size) len = out_size - 1;
    memcpy(out, p, len);
    out[len] = '\0';
    return true;
}

/* Extract a JSON number value for key from obj into out (size out_size).
 * Returns true on success. */
static bool json_num(const char *obj, const char *key, char *out, size_t out_size)
{
    char search[64];
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *p = strstr(obj, search);
    if (!p) return false;
    p += strlen(search);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (!isdigit((unsigned char)*p)) return false;
    size_t len = 0;
    while (isdigit((unsigned char)p[len])) len++;
    if (len >= out_size) len = out_size - 1;
    memcpy(out, p, len);
    out[len] = '\0';
    return true;
}

/* Extract a JSON boolean value for key. Returns 1=true, 0=false, -1=not found. */
static int json_bool(const char *obj, const char *key)
{
    char search[64];
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *p = strstr(obj, search);
    if (!p) return -1;
    p += strlen(search);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (strncmp(p, "true", 4) == 0) return 1;
    if (strncmp(p, "false", 5) == 0) return 0;
    return -1;
}

/* Parse the public_iq_modes array from an instance JSON object.
 * Only keeps modes ≤ iq192 (i.e. iq48, iq96, iq192).
 * Returns number of modes found. */
static int parse_iq_modes(const char *obj, char modes[][16], int max_modes)
{
    static const char *allowed[] = {"iq48", "iq96", "iq192", NULL};
    int n = 0;
    const char *p = strstr(obj, "\"public_iq_modes\"");
    if (!p) return 0;
    p = strchr(p, '[');
    if (!p) return 0;
    p++;
    while (n < max_modes) {
        const char *q1 = strchr(p, '"');
        if (!q1) break;
        const char *q2 = strchr(q1 + 1, '"');
        if (!q2) break;
        size_t mlen = q2 - q1 - 1;
        if (mlen < sizeof(modes[0]) - 1) {
            char mode[16];
            memcpy(mode, q1 + 1, mlen);
            mode[mlen] = '\0';
            /* Only keep modes ≤ iq192 */
            for (int i = 0; allowed[i]; i++) {
                if (strcmp(mode, allowed[i]) == 0) {
                    /* mlen < sizeof(modes[0])-1 is guaranteed by the outer if */
                    memcpy(modes[n], mode, mlen);
                    modes[n][mlen] = '\0';
                    n++;
                    break;
                }
            }
        }
        p = q2 + 1;
        /* Stop at end of array */
        const char *next_q = strchr(p, '"');
        const char *end_arr = strchr(p, ']');
        if (end_arr && (!next_q || end_arr < next_q)) break;
    }
    return n;
}

static int cmp_instance(const void *a, const void *b)
{
    const struct ubersdr_instance *ia = (const struct ubersdr_instance *)a;
    const struct ubersdr_instance *ib = (const struct ubersdr_instance *)b;
    const char *ka = ia->callsign[0] ? ia->callsign : ia->name;
    const char *kb = ib->callsign[0] ? ib->callsign : ib->name;
    return strcasecmp(ka, kb);
}

static bool discover_instances(char *url_out, size_t url_out_size, const char *auto_callsign)
{
    /* Fetch the instances list */
    char cmd[512];
    snprintf(cmd, sizeof(cmd),
             "curl -s --max-time 10 -A 'UberSDR_HPSDR/1.0' "
             "'https://instances.ubersdr.org/api/instances?online_only=true' 2>/dev/null");

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "discover: popen failed\n");
        return false;
    }

    /* Read full response */
    char *resp = NULL;
    size_t resp_len = 0;
    char line[1024];
    while (fgets(line, sizeof(line), fp) != NULL) {
        size_t ll = strlen(line);
        char *tmp = realloc(resp, resp_len + ll + 1);
        if (!tmp) { free(resp); pclose(fp); return false; }
        resp = tmp;
        memcpy(resp + resp_len, line, ll);
        resp_len += ll;
        resp[resp_len] = '\0';
    }
    pclose(fp);

    if (!resp || resp_len == 0) {
        fprintf(stderr, "discover: no response from instances API\n");
        free(resp);
        return false;
    }

    /* Find the start of the "instances" array */
    const char *instances_key = strstr(resp, "\"instances\"");
    if (!instances_key) {
        fprintf(stderr, "discover: no 'instances' key in response\n");
        free(resp);
        return false;
    }
    const char *arr_start = strchr(instances_key, '[');
    if (!arr_start) {
        fprintf(stderr, "discover: no instances array in response\n");
        free(resp);
        return false;
    }

    /* Parse instances array — use brace-counting to find each object */
    struct ubersdr_instance instances[MAX_INSTANCES];
    int n_instances = 0;

    const char *p = arr_start + 1;
    while (n_instances < MAX_INSTANCES) {
        /* Skip to next '{' */
        const char *obj_start = strchr(p, '{');
        if (!obj_start) break;

        /* Check we haven't passed the end of the array */
        const char *arr_end = strchr(p, ']');
        if (arr_end && arr_end < obj_start) break;

        /* Find matching '}' using brace counting */
        const char *obj_end = find_matching_brace(obj_start);
        if (!obj_end) break;

        /* Copy object into a NUL-terminated buffer for parsing */
        size_t obj_len = obj_end - obj_start + 1;
        char *obj = malloc(obj_len + 1);
        if (!obj) break;
        memcpy(obj, obj_start, obj_len);
        obj[obj_len] = '\0';

        struct ubersdr_instance inst;
        memset(&inst, 0, sizeof(inst));

        json_str(obj, "name",     inst.name,     sizeof(inst.name));
        json_str(obj, "callsign", inst.callsign, sizeof(inst.callsign));
        json_str(obj, "location", inst.location, sizeof(inst.location));
        json_str(obj, "host",     inst.host,     sizeof(inst.host));
        /* port is a JSON number, not a string */
        json_num(obj, "port",     inst.port,     sizeof(inst.port));

        /* tls is a JSON boolean */
        int tls_val = json_bool(obj, "tls");
        inst.tls = (tls_val == 1);

        inst.n_modes = parse_iq_modes(obj, inst.iq_modes, MAX_IQ_MODES);

        free(obj);

        /* Only include instances with at least one supported mode */
        if (inst.n_modes > 0 && inst.host[0] && inst.port[0]) {
            instances[n_instances++] = inst;
        }

        p = obj_end + 1;
    }

    free(resp);

    if (n_instances == 0) {
        fprintf(stderr, "discover: no suitable public instances found\n");
        return false;
    }

    /* Sort by callsign (falling back to name) case-insensitively */
    qsort(instances, n_instances, sizeof(instances[0]), cmp_instance);

    /* Clamp a string to max_len chars, appending ".." if truncated.
     * Writes into buf (must be at least max_len+1 bytes). */
    #define COL_CLAMP(src, buf, max_len) do { \
        size_t _sl = strlen(src); \
        if (_sl <= (max_len)) { \
            memcpy((buf), (src), _sl + 1); \
        } else { \
            memcpy((buf), (src), (max_len) - 2); \
            (buf)[(max_len) - 2] = '.'; \
            (buf)[(max_len) - 1] = '.'; \
            (buf)[(max_len)]     = '\0'; \
        } \
    } while (0)

    /* Display the list */
    printf("\nAvailable public UberSDR instances:\n");
    printf("%-4s %-12s %-35s %-38s %s\n", "No.", "Callsign", "Location", "Host:Port", "Modes");
    printf("%-4s %-12s %-35s %-38s %s\n", "---", "--------", "--------", "---------", "-----");

    for (int i = 0; i < n_instances; i++) {
        struct ubersdr_instance *inst = &instances[i];

        /* Build display name: prefer callsign, fall back to name */
        const char *display = inst->callsign[0] ? inst->callsign : inst->name;

        /* Clamped columns */
        char col_name[13], col_loc[36], col_hp[39];
        COL_CLAMP(display,       col_name, 12);
        COL_CLAMP(inst->location, col_loc, 35);

        char hostport[160];
        snprintf(hostport, sizeof(hostport), "%s:%s", inst->host, inst->port);
        COL_CLAMP(hostport, col_hp, 38);

        /* Build modes string */
        char modes_str[64] = {0};
        for (int m = 0; m < inst->n_modes; m++) {
            if (m > 0) strncat(modes_str, " ", sizeof(modes_str) - strlen(modes_str) - 1);
            strncat(modes_str, inst->iq_modes[m], sizeof(modes_str) - strlen(modes_str) - 1);
        }

        printf("%-4d %-12s %-35s %-38s %s\n",
               i + 1, col_name, col_loc, col_hp, modes_str);
    }

    #undef COL_CLAMP

    /* Auto-select by callsign if --callsign was given */
    struct ubersdr_instance *chosen = NULL;
    if (auto_callsign && auto_callsign[0]) {
        for (int i = 0; i < n_instances; i++) {
            if (strcasecmp(instances[i].callsign, auto_callsign) == 0) {
                chosen = &instances[i];
                break;
            }
        }
        if (!chosen) {
            fprintf(stderr, "discover: callsign '%s' not found in public instances\n", auto_callsign);
            return false;
        }
    } else {
        /* Prompt user */
        printf("\nEnter number (1-%d) or 0 to cancel: ", n_instances);
        fflush(stdout);

        int choice = 0;
        if (scanf("%d", &choice) != 1 || choice < 1 || choice > n_instances) {
            printf("Cancelled.\n");
            return false;
        }
        chosen = &instances[choice - 1];
    }

    const char *scheme = chosen->tls ? "https" : "http";
    snprintf(url_out, url_out_size, "%s://%s:%s", scheme, chosen->host, chosen->port);

    printf("Selected: %s (%s)\n", chosen->callsign[0] ? chosen->callsign : chosen->name, url_out);
    return true;
}

void sdr_sighandler (int signum)
{
    t_print ("Signal:%d caught, exiting!\n", signum);
    do_exit = 1;
    running = 0;
}

char *time_stamp ()
{
    char *timestamp = (char *) malloc (sizeof (char) * 16);
    time_t ltime = time (NULL);
    struct tm *tm;

    tm = localtime (&ltime);
    sprintf (timestamp, "%02d:%02d:%02d", tm->tm_hour, tm->tm_min, tm->tm_sec);
    return timestamp;
}

/* -----------------------------------------------------------------------
 * libwebsockets client for ubersdr
 * ----------------------------------------------------------------------- */

static int ws_callback(struct lws *wsi,
                       enum lws_callback_reasons reason,
                       void *user, void *in, size_t len)
{
    /*
     * rcb is stored as the wsi user-data pointer (ci.userdata in
     * lws_client_connect_info), accessible via lws_wsi_user().
     * This works with a shared lws_context because each wsi carries
     * its own user pointer independently of the context user pointer.
     */
    struct rcvr_cb *rcb = (struct rcvr_cb *)lws_wsi_user(wsi);

    switch (reason) {

    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        t_print("ws_callback(%d): connection established\n",
                rcb ? rcb->rcvr_num : -1);
        break;

    case LWS_CALLBACK_CLIENT_RECEIVE:
        if (!rcb) break;
        {
            /* Skip text (JSON) frames — only process binary PCM frames */
            if (!lws_frame_is_binary(wsi)) {
                /* Log text messages for debugging */
                char txt[256] = {0};
                size_t tlen = len < sizeof(txt) - 1 ? len : sizeof(txt) - 1;
                memcpy(txt, in, tlen);
                t_print("ws_callback(%d): text msg: %s\n", rcb->rcvr_num, txt);
                break;
            }

            float complex iq_buf[2048];
            int n_samples = 0, sr = 0, ch = 0;

            bool ok = decode_pcm_frame(rcb,
                                       (const uint8_t *)in, len,
                                       iq_buf, 2048,
                                       &n_samples, &sr, &ch);
            if (!ok) break;

            /* Detect sample-rate change → need reconnect with new mode */
            if (rcb->last_sample_rate != 0 && rcb->last_sample_rate != sr) {
                t_print("ws_callback(%d): sample rate changed %d→%d, reconnecting\n",
                        rcb->rcvr_num, rcb->last_sample_rate, sr);
                rcb->reconnect_needed = 1;
                lws_set_timeout(wsi, PENDING_TIMEOUT_CLOSE_SEND, LWS_TO_KILL_ASYNC);
                break;
            }
            rcb->last_sample_rate = sr;
            rcb->last_channels    = ch;

            /* Scale and accumulate into iqSamples ring buffer */
            for (int i = 0; i < n_samples; i++) {
                float re = crealf(iq_buf[i]) * rcb->scale;
                float im = cimagf(iq_buf[i]) * rcb->scale;
                rcb->iqSamples[rcb->iqSamples_remaining + i] = re + im * _Complex_I;
            }

            if (rcb->iqSamples_remaining < 0)
                rcb->iqSamples_remaining = 0;

            rcb->iqSamples_remaining += n_samples;

            int samps_packet = 238;
            while (rcb->iqSamples_remaining > samps_packet) {
                load_packet(rcb);
                rcb->iqSamples_remaining -= samps_packet;
                rcb->iqSample_offset     += samps_packet;
            }

            if (rcb->iqSample_offset > 0 && rcb->iqSamples_remaining > 0) {
                memmove(&rcb->iqSamples[0],
                        &rcb->iqSamples[rcb->iqSample_offset],
                        rcb->iqSamples_remaining * sizeof(float complex));
                rcb->iqSample_offset = 0;
            }
        }
        break;

    case LWS_CALLBACK_CLIENT_WRITEABLE:
        if (!rcb) break;
        /* Send a frequency-tune JSON message if new_freq is pending */
        if (rcb->new_freq != 0) {
            long freq = rcb->new_freq;
            rcb->new_freq = 0;
            rcb->curr_freq = freq;

            char json[256];
            int rate_khz = rcb->output_rate / 1000;
            if (rate_khz > 192) rate_khz = 192;
            int jlen = snprintf(json + LWS_PRE, sizeof(json) - LWS_PRE,
                                "{\"type\":\"tune\",\"frequency\":%ld,\"mode\":\"iq%d\"}",
                                freq, rate_khz);
            lws_write(wsi, (unsigned char *)(json + LWS_PRE), jlen, LWS_WRITE_TEXT);
        }
        break;

    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        t_print("ws_callback(%d): connection error: %s\n",
                rcb ? rcb->rcvr_num : -1,
                in ? (char *)in : "(null)");
        if (rcb) {
            rcb->reconnect_needed = 1;
            rcb->wsi_closed = 1;
        }
        break;

    case LWS_CALLBACK_CLIENT_CLOSED:
        t_print("ws_callback(%d): connection closed\n",
                rcb ? rcb->rcvr_num : -1);
        if (rcb) {
            rcb->reconnect_needed = 1;
            rcb->wsi_closed = 1;
        }
        break;

    default:
        break;
    }
    return 0;
}

static struct lws_protocols ws_protocols[] = {
    {
        .name                  = "ubersdr",
        .callback              = ws_callback,
        .per_session_data_size = 0,
        .rx_buffer_size        = WS_RX_BUF_SIZE,
    },
    LWS_PROTOCOL_LIST_TERM
};

/*
 * ws_thread — one per receiver.
 *
 * Connects to ubersdr via WebSocket, receives PCM-zstd frames,
 * decodes them, and feeds iqSamples[] for rx_thread to consume.
 * Handles reconnection when reconnect_needed is set (e.g. rate change).
 *
 * Each thread has its own lws_context so lws_service() is never called
 * concurrently on the same context (lws is not thread-safe for that).
 *
 * lws_create_context() is serialised with lws_ctx_create_mutex because
 * lws_context_init_ssl_library() calls OPENSSL_init_ssl() and checks a
 * one-time .bss flag; concurrent calls race on that flag and corrupt
 * OpenSSL global state, causing SIGSEGV in CRYPTO_THREAD_read_lock().
 *
 * rcb is passed to each wsi via ci.userdata so the callback can retrieve
 * it with lws_wsi_user() without needing the context user pointer.
 */
void *ws_thread(void *arg)
{
    struct rcvr_cb *rcb = (struct rcvr_cb *)arg;

    rcb->iqSample_offset = rcb->iqSamples_remaining = 0;
    rcb->err_count = 0;
    rcb->last_sample_rate = 0;
    rcb->last_channels    = 0;
    rcb->wsi_closed       = 0;
    int ever_connected = 0; /* skip /connection check on rate-change reconnects */

    /* Allocate a ZSTD decompression context for this receiver */
    rcb->zstd_dctx = ZSTD_createDCtx();
    if (!rcb->zstd_dctx) {
        t_print("ws_thread(%d): ZSTD_createDCtx failed\n", rcb->rcvr_num);
        pthread_exit(NULL);
    }

    t_print("ws_thread(%d): starting, url=%s\n", rcb->rcvr_num, mcb.ubersdr_url);

    /* --- Parse host/port/ssl from the URL once (URL never changes) --- */
    char host[256] = {0};
    int  port = 80;
    int  use_ssl = 0;
    {
        const char *url = mcb.ubersdr_url;
        if (strncmp(url, "https://", 8) == 0) {
            use_ssl = 1;
            port = 443;
            url += 8;
        } else if (strncmp(url, "http://", 7) == 0) {
            url += 7;
        } else if (strncmp(url, "wss://", 6) == 0) {
            use_ssl = 1;
            port = 443;
            url += 6;
        } else if (strncmp(url, "ws://", 5) == 0) {
            url += 5;
        }

        const char *slash = strchr(url, '/');
        const char *colon = strchr(url, ':');
        if (slash && colon && colon < slash) {
            size_t hlen = colon - url;
            if (hlen >= sizeof(host)) hlen = sizeof(host) - 1;
            memcpy(host, url, hlen);
            host[hlen] = '\0';
            port = atoi(colon + 1);
        } else if (colon && (!slash || colon < slash)) {
            size_t hlen = colon - url;
            if (hlen >= sizeof(host)) hlen = sizeof(host) - 1;
            memcpy(host, url, hlen);
            host[hlen] = '\0';
            port = atoi(colon + 1);
        } else if (slash) {
            size_t hlen = slash - url;
            if (hlen >= sizeof(host)) hlen = sizeof(host) - 1;
            memcpy(host, url, hlen);
            host[hlen] = '\0';
        } else {
            size_t ulen = strlen(url);
            if (ulen >= sizeof(host)) ulen = sizeof(host) - 1;
            memcpy(host, url, ulen);
            host[ulen] = '\0';
        }
    }

    /* --- Create the lws context once for the lifetime of this thread.
     * Serialise with lws_ctx_create_mutex to prevent concurrent
     * OPENSSL_init_ssl() calls from racing on the one-time init flag. --- */
    struct lws_context_creation_info ctx_info = {0};
    ctx_info.port      = CONTEXT_PORT_NO_LISTEN;
    ctx_info.protocols = ws_protocols;
    ctx_info.options   = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;

    pthread_mutex_lock(&lws_ctx_create_mutex);
    struct lws_context *ctx = lws_create_context(&ctx_info);
    pthread_mutex_unlock(&lws_ctx_create_mutex);

    if (!ctx) {
        t_print("ws_thread(%d): lws_create_context failed\n", rcb->rcvr_num);
        ZSTD_freeDCtx(rcb->zstd_dctx);
        rcb->zstd_dctx = NULL;
        pthread_exit(NULL);
    }

    while (!do_exit) {
        /* Wait until this DDC is enabled */
        if (!ddcenable[rcb->rcvr_num]) {
            usleep(50000);
            continue;
        }

        /*
         * Do NOT clear reconnect_needed here — it may have been set by
         * ddc_specific_thread() while we were sleeping/retrying.  The new
         * output_rate is already written before reconnect_needed is set, so
         * we just need to carry it through to the URL build below.
         */
        rcb->wsi_closed = 0;

        /*
         * mcb.ubersdr_url is an HTTP base URL, e.g. "http://host:8080"
         * or "https://host:8443".  We:
         *   1. POST to /connection to get permission
         *   2. Connect via WebSocket on the same host
         */

        t_print("ws_thread(%d): outer loop top: ever_connected=%d reconnect_needed=%d rate=%d\n",
                rcb->rcvr_num, ever_connected, rcb->reconnect_needed, rcb->output_rate / 1000);

        /* --- Step 1: connection permission check ---
         * Skip on rate-change reconnects — we were already allowed.
         * Only check on the very first connect attempt. */
        if (!ever_connected) {
            t_print("ws_thread(%d): checking connection permission\n", rcb->rcvr_num);
            if (!check_ubersdr_connection_rcb(mcb.ubersdr_url, rcb)) {
                t_print("ws_thread(%d): connection not allowed, retrying in 5s\n", rcb->rcvr_num);
                /* Sleep in short increments so a rate change wakes us promptly */
                for (int s = 0; s < 50 && !do_exit && !rcb->reconnect_needed; s++)
                    usleep(100000); /* 100 ms × 50 = 5 s max */
                continue;
            }
        } else {
            t_print("ws_thread(%d): skipping connection check (ever_connected)\n", rcb->rcvr_num);
        }

        /* --- Step 2: build the WebSocket path with query string --- */
        char full_path[512];
        {
            int rate_khz = rcb->output_rate / 1000;
            if (rate_khz > 192) rate_khz = 192;
            if (mcb.ubersdr_password[0]) {
                snprintf(full_path, sizeof(full_path),
                         "/ws?frequency=%d&mode=iq%d&user_session_id=%s&password=%s&version=2",
                         rcb->curr_freq, rate_khz, rcb->session_id,
                         mcb.ubersdr_password);
            } else {
                snprintf(full_path, sizeof(full_path),
                         "/ws?frequency=%d&mode=iq%d&user_session_id=%s&version=2",
                         rcb->curr_freq, rate_khz, rcb->session_id);
            }
        }

        /* --- Step 3: connect via WebSocket.
         * Pass rcb as ci.userdata so the callback can retrieve it via
         * lws_wsi_user() without needing the context user pointer. --- */
        struct lws_client_connect_info ci = {0};
        ci.context        = ctx;
        ci.address        = host;
        ci.port           = port;
        ci.path           = full_path;
        ci.host           = host;
        ci.origin         = host;
        ci.protocol       = ws_protocols[0].name;
        ci.userdata       = rcb;
        ci.ssl_connection = use_ssl ? (LCCSCF_USE_SSL |
                                       LCCSCF_ALLOW_SELFSIGNED |
                                       LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK) : 0;

        t_print("ws_thread(%d): calling lws_client_connect_via_info (rate=%d kHz, path=%s)\n",
                rcb->rcvr_num, rcb->output_rate / 1000, full_path);
        struct lws *wsi = lws_client_connect_via_info(&ci);
        if (!wsi) {
            t_print("ws_thread(%d): lws_client_connect_via_info failed\n", rcb->rcvr_num);
            sleep(2);
            continue;
        }
        t_print("ws_thread(%d): lws_client_connect_via_info succeeded\n", rcb->rcvr_num);

        ever_connected = 1;
        t_print("ws_thread(%d): entering service loop\n", rcb->rcvr_num);

        /* Service loop — exits on shutdown, reconnect request, or DDC disable.
         * Only this thread calls lws_service() on ctx — lws is not thread-safe
         * for concurrent service on the same context. */
        while (!do_exit && ddcenable[rcb->rcvr_num]) {
            /* If a new_freq is pending, request writeable callback */
            if (rcb->new_freq != 0)
                lws_callback_on_writable(wsi);

            int rc = lws_service(ctx, 50 /* ms timeout */);
            if (rc < 0) {
                t_print("ws_thread(%d): lws_service returned %d, breaking\n", rcb->rcvr_num, rc);
                break;
            }

            /* Once the wsi is closed we can safely reconnect */
            if (rcb->wsi_closed) {
                t_print("ws_thread(%d): wsi_closed, breaking service loop\n", rcb->rcvr_num);
                break;
            }

            /* Rate change requires reconnect with new mode in URL */
            if (rcb->reconnect_needed) {
                t_print("ws_thread(%d): reconnect_needed=%d, breaking service loop (rate=%d kHz)\n",
                        rcb->rcvr_num, rcb->reconnect_needed, rcb->output_rate / 1000);
                break;
            }
        }

        t_print("ws_thread(%d): exited service loop: do_exit=%d ddcenable=%d wsi_closed=%d reconnect_needed=%d\n",
                rcb->rcvr_num, do_exit, ddcenable[rcb->rcvr_num],
                rcb->wsi_closed, rcb->reconnect_needed);

        /* If we need to reconnect, destroy and recreate the lws context so
         * we don't have to wait for the old wsi to drain (which can take
         * many seconds for TLS teardown).  Each thread owns its own context
         * so this is safe. */
        if (!do_exit && (rcb->reconnect_needed || !rcb->wsi_closed)) {
            t_print("ws_thread(%d): destroying lws context for reconnect\n", rcb->rcvr_num);
            lws_context_destroy(ctx);

            pthread_mutex_lock(&lws_ctx_create_mutex);
            ctx = lws_create_context(&ctx_info);
            pthread_mutex_unlock(&lws_ctx_create_mutex);

            if (!ctx) {
                t_print("ws_thread(%d): lws_create_context failed on reconnect\n", rcb->rcvr_num);
                break;
            }
            rcb->wsi_closed = 1; /* context is fresh, treat as closed */
            t_print("ws_thread(%d): lws context recreated\n", rcb->rcvr_num);
        }

        t_print("ws_thread(%d): post-drain: ddcenable=%d reconnect_needed=%d do_exit=%d\n",
                rcb->rcvr_num, ddcenable[rcb->rcvr_num], rcb->reconnect_needed, do_exit);

        if (!do_exit && !ddcenable[rcb->rcvr_num] && !rcb->reconnect_needed) {
            t_print("ws_thread(%d): DDC disabled, disconnecting\n", rcb->rcvr_num);
        } else if (!do_exit && rcb->reconnect_needed) {
            t_print("ws_thread(%d): reconnecting in 1s (rate=%d kHz)\n",
                    rcb->rcvr_num, rcb->output_rate / 1000);
            rcb->reconnect_needed = 0;
            sleep(1);
            t_print("ws_thread(%d): sleep done, looping back\n", rcb->rcvr_num);
        }
    }

    lws_context_destroy(ctx);
    ZSTD_freeDCtx(rcb->zstd_dctx);
    rcb->zstd_dctx = NULL;
    t_print("ws_thread(%d): exiting\n", rcb->rcvr_num);
    pthread_exit(NULL);
}

int find_net(char *find)
{
    DIR* dir;
    struct dirent* ent;

    if (!(dir = opendir("/sys/class/net"))) {
        perror("can't open /sys/class/net");
        return 0;
    }

    while((ent = readdir(dir)) != NULL) {
        if (!strcmp("print", find) && strcmp(".", ent->d_name) && strcmp("..", ent->d_name)) {
            printf("%s ", ent->d_name);
        } else if (!strcmp(ent->d_name, find)) {
            closedir(dir);
            return 1;
        }
    }
    closedir(dir);
    return 0;
}

int proc_find(char name[][16], char *find)
{
    DIR* dir;
    struct dirent* ent;
    char* endptr;
    int i, name_found = 0;
    char buf[512];

    if (!(dir = opendir("/proc"))) {
        perror("can't open /proc");
        return 0;
    }

    while((ent = readdir(dir)) != NULL) {
        long lpid = strtol(ent->d_name, &endptr, 10);
        if (*endptr != '\0') {
            continue;
        }

        snprintf(buf, sizeof(buf), "/proc/%ld/cmdline", lpid);
        FILE* fp = fopen(buf, "r");

        if (fp) {
            if (fgets(buf, sizeof(buf), fp) != NULL) {
                // check the first token in the file, the program name
                char* first = strtok(buf, "\0");
                if (strstr(first, find) != NULL) {
                    for (i = 0; i < sizeof(buf); i++) {
                        if (!strcmp(&buf[i], "-i")) {
                            strcpy(name[name_found], &buf[i+3]);
                            if (++name_found > MAX_PRGMS)
                                goto finishup;
                            break;
                        }
                    }
                }
            }
            fclose(fp);
        }
    }

finishup:
    closedir(dir);
    return name_found;
}
int main (int argc, char *argv[])
{
    uint8_t id[4] = { 0xef, 0xfe, 1, 6 };
    struct sockaddr_in addr_udp;
    struct sockaddr_in addr_from;
    socklen_t lenaddr;
    struct timeval tv;
    int yes = 1;
    int bytes_read;
    uint32_t i, code;
    u_char buffer[MAX_BUFFER_LEN];
    uint32_t *code0;
    int CmdOption;
    struct sigaction sigact;

    code0 = (uint32_t *) buffer;
    memset(&mcb, 0, sizeof(mcb));
    // set defaults
    mcb.num_rxs = MAX_RCVRS;
    mcb.wideband = false;
    mcb.device_type = HERMES_LITE;
    strcpy(mcb.ubersdr_url, "http://localhost:8080");

    /* --callsign / --discover state */
    const char *callsign_arg = NULL;
    int do_discover = 0;

    static struct option long_options[] = {
        {"url",        required_argument, 0, 'u'},
        {"password",   required_argument, 0, 'p'},
        {"interface",  required_argument, 0, 'i'},
        {"receivers",  required_argument, 0, 'n'},
        {"device",     required_argument, 0, 'd'},
        {"wideband",   no_argument,       0, 'w'},
        {"discover",   no_argument,       0, 'D'},
        {"callsign",   required_argument, 0, 'c'},
        {"help",       no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt_index = 0;
    while((CmdOption = getopt_long(argc, argv, "u:p:i:n:d:wDc:h", long_options, &opt_index)) != -1) {
        switch(CmdOption) {
        case 'h':
            printf("Usage: %s [options]\n\n", basename(argv[0]));
            printf("UberSDR Connection Options:\n");
            printf("  --url URL          UberSDR server URL (default http://localhost:8080)\n");
            printf("  --password PASS    UberSDR server password (optional)\n");
            printf("  --discover         Fetch public instances and pick one interactively\n");
            printf("  --callsign CALL    Select a public instance by callsign (implies --discover)\n");
            printf("\n");
            printf("HPSDR Emulation Options:\n");
            printf("  --interface IFACE  Network interface to bind to (auto-detected if omitted)\n");
            printf("  --receivers N      Number of receiver slices (default %d, max %d)\n", MAX_RCVRS, MAX_RCVRS);
            printf("  --device N         Device type: 1=Hermes, 6=HermesLite (default 6)\n");
            printf("  --wideband         Enable wideband data (default disabled)\n");
            printf("\n");
            printf("Examples:\n");
            printf("  %s --url http://localhost:8080 --interface eth0\n", basename(argv[0]));
            printf("  %s --url https://sdr.example.com --password mypass --interface eth0\n", basename(argv[0]));
            printf("  %s --url http://localhost:8080 --device 1 --receivers 4 --interface eth0\n", basename(argv[0]));
            printf("  %s --discover --interface eth0\n", basename(argv[0]));
            printf("  %s --callsign K3GMQ --interface eth0\n", basename(argv[0]));
            return EXIT_SUCCESS;
            break;

        case 'i':
            strcpy(mcb.interface, optarg);
            break;
        case 'n':
            mcb.num_rxs = atoi(optarg);
            break;
        case 'p':
            strncpy(mcb.ubersdr_password, optarg, sizeof(mcb.ubersdr_password) - 1);
            break;
        case 'u':
            strncpy(mcb.ubersdr_url, optarg, sizeof(mcb.ubersdr_url) - 1);
            break;
        case 'd':
            mcb.device_type = atoi(optarg);
            break;
        case 'w':
            mcb.wideband = 1;
            break;
        case 'D':
            do_discover = 1;
            break;
        case 'c':
            callsign_arg = optarg;
            do_discover = 1;
            break;
        }
    }

    /* Run discovery (interactive or auto-select by callsign) */
    if (do_discover) {
        if (!discover_instances(mcb.ubersdr_url, sizeof(mcb.ubersdr_url), callsign_arg)) {
            return EXIT_FAILURE;
        }
    }
    printf("\n");

    int same_int = 0, prgms_found = 0;
    char myproc[MAX_PRGMS][16] = {0,};
    prgms_found = proc_find(myproc, "ubersdr-hpsdr-bridge");
    if (prgms_found > MAX_PRGMS) {
        printf("These are already max: %d ubersdr-hpsdr-bridge programs running.\n", MAX_PRGMS);
        return EXIT_FAILURE;
    }

    if (strlen(mcb.interface) == 0) {
        /* Auto-detect default route interface */
        FILE *pfd = popen("ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i==\"dev\") print $(i+1)}'", "r");
        if (pfd != NULL) {
            if (fgets(mcb.interface, sizeof(mcb.interface) - 1, pfd) != NULL) {
                /* strip trailing newline */
                mcb.interface[strcspn(mcb.interface, "\n")] = '\0';
            }
            pclose(pfd);
        }
        if (strlen(mcb.interface) == 0) {
            printf("Could not auto-detect network interface. Use --interface to specify one.\n");
            printf("Available interfaces:\n\t");
            find_net("print");
            printf("\n");
            return EXIT_FAILURE;
        }
        printf("Auto-detected network interface: %s\n", mcb.interface);
    }

    if (find_net(mcb.interface) == 0) {
        printf("%s not found\n", mcb.interface);
        return EXIT_FAILURE;
    }

    // see how many different net interfaces these prgm's are
    // using and check before using the same one
    for (i = 0; i < prgms_found; i++) {
        if (!strcmp(myproc[i], mcb.interface))
            same_int++;
    }

    if (same_int > 1) {
        printf("interface %s already in use\n", mcb.interface);
        return EXIT_FAILURE;
    }

    if ((sock_udp = socket(AF_INET, SOCK_DGRAM, 0)) < 0) {
        t_perror("socket");
        return EXIT_FAILURE;
    }

    if (prgms_found > 1) {
        interface_offset++;
        mcb.wideband = 0;
        if (setsockopt(sock_udp, SOL_SOCKET, SO_BINDTODEVICE,
                       mcb.interface, sizeof(mcb.interface)) < 0) {
            perror ("SO_BINDTODEVICE");
        }
    }

    struct ifreq hwaddr;
    memset(&hwaddr, 0, sizeof(hwaddr));
    strncpy(hwaddr.ifr_name, mcb.interface, IFNAMSIZ - 1);
    ioctl(sock_udp, SIOCGIFHWADDR, &hwaddr);

    struct ifaddrs *ifap, *ifa;
    struct sockaddr_in *sa;
    char *addr;

    // get the IP address of the desired interface
    getifaddrs (&ifap);
    for (ifa = ifap; ifa; ifa = ifa->ifa_next) {
        if (ifa->ifa_addr && ifa->ifa_addr->sa_family==AF_INET) {
            sa = (struct sockaddr_in *) ifa->ifa_addr;
            addr = inet_ntoa(sa->sin_addr);
            if (!strcmp(mcb.interface, ifa->ifa_name)) {
                strcpy(mcb.ip, addr);
            }
        }
    }
    freeifaddrs(ifap);

    setsockopt(sock_udp, SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
    setsockopt(sock_udp, SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
    tv.tv_sec = 0;
    tv.tv_usec = 1000;
    setsockopt(sock_udp, SOL_SOCKET, SO_RCVTIMEO, (void *)&tv, sizeof(tv));
    memset(&addr_udp, 0, sizeof(addr_udp));
    addr_udp.sin_family = AF_INET;
    addr_udp.sin_addr.s_addr = htonl(INADDR_ANY);
    addr_udp.sin_port = htons(1024);

    if (bind(sock_udp, (struct sockaddr *)&addr_udp, sizeof(addr_udp)) < 0) {
        t_perror("main ERROR: bind");
        return EXIT_FAILURE;
    }

    if (pthread_create(&highprio_thread_id, NULL, highprio_thread, NULL) < 0) {
        t_perror("***** ERROR: Create HighPrio thread");
    }

    if (pthread_create(&ddc_specific_thread_id, NULL, ddc_specific_thread, NULL) < 0) {
        t_perror("***** ERROR: Create DDC specific thread");
    }

    if (pthread_create(&mic_thread_id, NULL, mic_thread, NULL) < 0) {
        t_perror("***** ERROR: Create MIC thread");
    }

    if (mcb.wideband) {
        if (pthread_create(&wb_thread_id, NULL, wb_thread, NULL) < 0) {
            t_perror("***** ERROR: Create WB thread");
        }
    }

    sigact.sa_handler = sdr_sighandler;
    sigemptyset (&sigact.sa_mask);
    sigact.sa_flags = 0;
    sigaction (SIGINT, &sigact, NULL);
    sigaction (SIGTERM, &sigact, NULL);
    sigaction (SIGQUIT, &sigact, NULL);
    sigaction (SIGPIPE, &sigact, NULL);

    pthread_mutex_init (&send_lock, NULL);
    pthread_cond_init (&send_cond, NULL);
    pthread_mutex_init (&done_send_lock, NULL);
    pthread_cond_init (&done_send_cond, NULL);

    for (i = 0; i < mcb.num_rxs; i++) {
        mcb.rcb[i].mcb = &mcb;
        mcb.rcb[i].new_freq = 0;
        mcb.rcb[i].curr_freq = 10000000;
        mcb.rcb[i].output_rate = 192000;
        mcb.rcb[i].scale = 700.0f;
        mcb.rcb[i].rcvr_num = i;
        mcb.rcb[i].reconnect_needed = 0;
        mcb.rcvrs_mask |= 1 << i;
        mcb.rcb[i].rcvr_mask = 1 << i;

        /* Generate a unique session ID for this receiver */
        generate_uuid(mcb.rcb[i].session_id);

        if (pthread_create(&ws_thread_id[i], NULL, ws_thread, &mcb.rcb[i]) < 0) {
            t_perror("***** ERROR: Create ws_thread");
        }
    }

    t_print("Waiting on Discovery...\n");

    while (!do_exit) {
        memcpy(buffer, id, 4);
        lenaddr = sizeof(addr_from);
        bytes_read = recvfrom(sock_udp, buffer, HPSDR_FRAME_LEN, 0, (struct sockaddr *)&addr_from, &lenaddr);

        if (bytes_read < 0 && errno != EAGAIN) {
            t_perror("recvfrom");
            continue;
        }

        if (bytes_read <= 0) {
            continue;
        }

        code = *code0;

        /*
         * Here we have to handle the following "non standard" cases:
         * NewProtocol "Discovery" packet   60 bytes starting with 00 00 00 00 02
         * NewProtocol "General"   packet   60 bytes starting with 00 00 00 00 00
         *                                  ==> this starts NewProtocol radio
         */
        if (code == 0 && buffer[4] == 0x02 && !running) {
            t_print("NewProtocol discovery packet received from %s\n", inet_ntoa(addr_from.sin_addr));
            // prepare response
            memset(buffer, 0, 60);
            buffer [4] = 0x02 + running;
            for (i = 0; i < 6; ++i) buffer[i + 5] = hwaddr.ifr_addr.sa_data[i];
            buffer[11] = mcb.device_type;
            buffer[12] = 38;
            buffer[13] = 18;
            buffer[20] = mcb.num_rxs;
            buffer[21] = 1;
            buffer[22] = 7; // sample rate bitmask: bits 0+1+2 = 48/96/192 kHz (ubersdr cap)

            sendto(sock_udp, buffer, 60, 0, (struct sockaddr *)&addr_from, sizeof(addr_from));
            continue;
        }

        if (bytes_read == 60 && buffer[4] == 0x00) {
            // handle "general packet" of the new protocol
            memset(&addr_new, 0, sizeof(addr_new));
            addr_new.sin_family = AF_INET;
            addr_new.sin_addr.s_addr = addr_from.sin_addr.s_addr;
            addr_new.sin_port = addr_from.sin_port;
            new_protocol_general_packet(buffer);
            continue;
        }
    }

    close(sock_udp);

    return EXIT_SUCCESS;
}

void t_print(const char *format, ...)
{
    va_list(args);
    va_start(args, format);
    struct timespec ts;
    double now;
    static double starttime;
    static int first = 1;
    char line[1024];
    clock_gettime(CLOCK_MONOTONIC, &ts);
    now = ts.tv_sec + 1E-9 * ts.tv_nsec;

    if (first) {
        first = 0;
        starttime = now;
    }

    //
    // After 11 days, the time reaches 999999.999 so we simply wrap around
    //
    if (now - starttime >= 999999.995) {
        starttime += 1000000.0;
    }

    //
    // We have to use vsnt_print to handle the varargs stuff
    // g_print() seems to be thread-safe but call it only ONCE.
    //
    vsnprintf(line, 1024, format, args);
    printf("%10.6f %s", now - starttime, line);
    fflush(stdout);
}

void t_perror(const char *string)
{
    t_print("%s: %s\n", string, strerror(errno));
}

void load_packet (struct rcvr_cb *rcb)
{
    float complex *out_buf = &rcb->iqSamples[rcb->iqSample_offset];
    int i, j, IQData;
    int k = rcb->rcvr_num;

    pthread_mutex_lock (&done_send_lock);
    while (!(done_send_flags & rcb->rcvr_mask) && running) {
        pthread_cond_wait (&done_send_cond, &done_send_lock);
    }
    done_send_flags &= ~rcb->rcvr_mask;
    pthread_mutex_unlock (&done_send_lock);

    for (i = 0, j = 0; i < 238; i++, j+=6) {
        IQData = (int)cimagf(out_buf[i]);
        pbuf[k][j] = IQData >> 16;
        pbuf[k][j+1] = IQData >> 8;
        pbuf[k][j+2] = IQData & 0xff;
        IQData = (int)crealf(out_buf[i]);
        pbuf[k][j+3] = IQData >> 16;
        pbuf[k][j+4] = IQData >> 8;
        pbuf[k][j+5] = IQData & 0xff;
    }

    pthread_mutex_lock (&send_lock);
    send_flags |= rcb->rcvr_mask;
    pthread_cond_broadcast (&send_cond);
    pthread_mutex_unlock (&send_lock);
}

void new_protocol_general_packet(unsigned char *buffer)
{
    static unsigned long seqnum = 0;
    unsigned long seqold;
    int rc;

    gen_rcvd = true;

    seqold = seqnum;
    seqnum = (buffer[0] >> 24) + (buffer[1] << 16) + (buffer[2] << 8) + buffer[3];

    if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
        t_print("GP: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
    }

    if (mcb.wideband) {
        rc = buffer[23] & 1;
        if (rc != wbenable) {
            wbenable = rc;
            t_print("GP: Wideband Enable Flag is %d\n", wbenable);
        }

        rc = (buffer[24] << 8) + buffer[25];
        if (rc != wide_len) {
            wide_len = rc;
            t_print("GP: WideBand Length is %d\n", rc);
        }

        rc = buffer[26];
        if (rc != wide_size) {
            wide_size = rc;
            t_print("GP: Wideband sample size is %d\n", rc);
        }

        rc = buffer[27];
        if (rc != wide_rate) {
            wide_rate = rc;
            t_print("GP: Wideband sample rate is %d\n", rc);
        }

        rc = buffer[28];
        if (rc != wide_ppf) {
            wide_ppf = rc;
            t_print("GP: Wideband PPF is %d\n", rc);
        }
    }
}

void *highprio_thread(void *data)
{
    struct sockaddr_in addr;
    socklen_t lenaddr = sizeof(addr);
    unsigned long seqnum = 0, seqold;
    unsigned char hp_buffer[2000];
    struct timeval tv;
    int i, rc, yes = 1;
    long freq;
    struct timespec last_hp_time = {0};
    clock_gettime(CLOCK_MONOTONIC, &last_hp_time);

    hp_sock = socket(AF_INET, SOCK_DGRAM, 0);

    if (hp_sock < 0) {
        t_perror("***** ERROR: HP: socket");
        return NULL;
    }

    setsockopt(hp_sock, SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
    setsockopt(hp_sock, SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
    tv.tv_sec = 0;
    tv.tv_usec = 10000;
    setsockopt(hp_sock, SOL_SOCKET, SO_RCVTIMEO, (void *)&tv, sizeof(tv));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = (interface_offset > 0) ? inet_addr(mcb.ip) : htonl(INADDR_ANY);
    addr.sin_port = htons(hp_port);

    if (bind(hp_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        t_perror("highprio_thread ERROR: bind");
        close(hp_sock);
        return NULL;
    }

    t_print("Starting highprio_thread()\n");
    while (!do_exit) {
        if (!running) seqnum = 0;

        rc = recvfrom(hp_sock, hp_buffer, 1444, 0, (struct sockaddr *)&addr, &lenaddr);

        if (rc < 0 && errno != EAGAIN) {
            t_perror("***** ERROR: HighPrio thread: recvmsg");
            break;
        }

        if (rc < 0) {
            // EAGAIN timeout — check watchdog
            if (running) {
                struct timespec now;
                clock_gettime(CLOCK_MONOTONIC, &now);
                double elapsed = (now.tv_sec - last_hp_time.tv_sec) +
                                 (now.tv_nsec - last_hp_time.tv_nsec) * 1e-9;
                if (elapsed > 5.0) {
                    t_print("HP: no high-priority packet for %.1fs, client disconnected\n", elapsed);
                    running = 0;
                    for (i = 0; i < mcb.num_rxs; i++) {
                        ddcenable[i] = 0;
                        mcb.rcb[i].rcvr_mask = 0;
                        rxrate[i] = 0;
                        rxfreq[i] = 0;
                    }
                }
            }
            continue;
        }

        // Successful receive — reset watchdog timer
        clock_gettime(CLOCK_MONOTONIC, &last_hp_time);

        if (rc != 1444) {
            t_print("Received HighPrio packet with incorrect length %d\n", rc);
            break;
        }

        seqold = seqnum;
        seqnum = (hp_buffer[0] >> 24) + (hp_buffer[1] << 16) + (hp_buffer[2] << 8) + hp_buffer[3];

        if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
            t_print("HP: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
        }

        for (i = 0; i < mcb.num_rxs; i++) {
            freq = (hp_buffer[ 9 + 4 * i] << 24) + (hp_buffer[10 + 4 * i] << 16) + (hp_buffer[11 + 4 * i] << 8) + hp_buffer[12 + 4 * i];

            if (bits & 0x08) {
                freq = round(122880000.0 * (double) freq / 4294967296.0);
            }

            if (freq != rxfreq[i]) {
                mcb.rcb[i].new_freq = rxfreq[i] = freq;
                //t_print("HP: DDC%d freq: %lu\n", i, freq);
            }
        }

        rc = hp_buffer[5] & 0x01;
        if (rc != adcdither) {
            adcdither = rc;
            //t_print("RX: ADC dither=%d\n", adcdither);
        }

        rc = hp_buffer[6] & 0x01;
        if (rc != adcrandom) {
            adcrandom = rc;
            //t_print("RX: ADC random=%d\n", adcrandom);
        }

        rc = hp_buffer[1443];
        if (rc != stepatt0) {
            stepatt0 = rc;
            //t_print("HP: StepAtt0 = %d\n", stepatt0);
        }

        rc = hp_buffer[4] & 0x01;
        if (rc != running) {
            running = rc;
            t_print("HP: Running = %d\n", rc);
            if (!running) {
                for (i = 0; i < mcb.num_rxs; i++) {
                    ddcenable[i] = 0;
                    mcb.rcb[i].rcvr_mask = 0;
                    rxrate[i] = 0;
                    rxfreq[i] = 0;
                }
            } else {
                for (i = 0; i < mcb.num_rxs; i++) {
                    if (rx_thread_id[i] == 0) {
                        if (pthread_create(&rx_thread_id[i], NULL, rx_thread, (void *) (uintptr_t) i) < 0) {
                            t_perror("***** ERROR: Create RX thread");
                        }
                    }
                }
            }
        }
    }

    t_print("Ending highprio_thread()\n");
    close(hp_sock);
    return NULL;
}

void *ddc_specific_thread(void *data)
{
    int sock;
    struct sockaddr_in addr;
    socklen_t lenaddr = sizeof(addr);
    unsigned long seqnum, seqold;
    struct timeval tv;
    unsigned char ddc_buffer[2000];
    int yes = 1;
    int rc;
    int i;

    sock = socket(AF_INET, SOCK_DGRAM, 0);

    if (sock < 0) {
        t_perror("***** ERROR: ddc_specific_thread: socket");
        return NULL;
    }

    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
    setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
    tv.tv_sec = 0;
    tv.tv_usec = 10000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (void *)&tv, sizeof(tv));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = (interface_offset > 0) ? inet_addr(mcb.ip) : htonl(INADDR_ANY);
    addr.sin_port = htons(ddc_port);

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        t_perror("ddc_specific_thread ERROR: bind");
        close(sock);
        return NULL;
    }

    seqnum = 0;

    t_print("Starting ddc_specific_thread()\n");
    while (!do_exit) {
        if (!running) {
            seqnum = 0;
            usleep(50000);
            continue;
        }

        rc = recvfrom(sock, ddc_buffer, 1444, 0, (struct sockaddr *)&addr, &lenaddr);
        if (rc < 0 && errno != EAGAIN) {
            t_perror("***** ERROR: DDC specific thread: recvmsg");
            break;
        }

        if (rc < 0) {
            continue;
        }

        if (rc != 1444) {
            t_print("RXspec: Received DDC specific packet with incorrect length");
            break;
        }

        seqold = seqnum;
        seqnum = (ddc_buffer[0] >> 24) + (ddc_buffer[1] << 16) + (ddc_buffer[2] << 8) + ddc_buffer[3];

        if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
            t_print("RXspec: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
        }

        for (i = 0; i < mcb.num_rxs; i++) {
            int modified = 0;
            struct rcvr_cb *rcb = &mcb.rcb[i];

            rc = (ddc_buffer[18 + 6 * i] << 8) + ddc_buffer[19 + 6 * i];
            /* Clamp to 192 kHz — ubersdr WebSocket only supports up to iq192 */
            if (rc > 192) rc = 192;
            if (rc != rxrate[i] && rc != 0) {
                rxrate[i] = rc;
                mcb.rcb[i].output_rate = (rxrate[i] * 1000);
                modified = 1;

                switch(rxrate[i]) {
                case 48:
                    mcb.rcb[i].scale = 8000.0f;
                    break;
                case 96:
                    mcb.rcb[i].scale = 6000.0f;
                    break;
                case 192:
                default:
                    mcb.rcb[i].scale = 4000.0f;
                    break;
                }

                /* Rate change requires WebSocket reconnect (mode is baked into URL) */
                rcb->reconnect_needed = 1;
            }

            rc = (ddc_buffer[7 + (i / 8)] >> (i % 8)) & 0x01;
            if (rc != ddcenable[i]) {
                modified = 1;
                ddcenable[i] = rc;
                mcb.rcb[i].rcvr_mask = 1 << i;
                if (ddcenable[i]) {
                    pthread_mutex_lock (&send_lock);
                    send_flags |= 1 << i;
                    pthread_cond_broadcast (&send_cond);
                    pthread_mutex_unlock (&send_lock);
                }
            }

            if (modified) {
                t_print("RX: DDC%d Enable=%d Rate=%d\n", i, ddcenable[i], rxrate[i]);
                rc = 0;
            }
        }
    }

    close(sock);
    ddc_specific_thread_id = 0;
    t_print("Ending ddc_specific_thread()\n");
    return NULL;
}

void *rx_thread(void *data)
{
    // One instance of this thread is started for each DDC
    int sock;
    struct sockaddr_in addr;
    unsigned long seqnum;
    unsigned char rx_buffer[1444];
    int myddc;
    int yes = 1;
    unsigned char *p;
    struct rcvr_cb *rcb;

    myddc = (int) (uintptr_t) data;
    rcb = &mcb.rcb[myddc];

    if (myddc < 0 || myddc >= mcb.num_rxs) {
        return NULL;
    }

    seqnum = 0;

    sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        t_perror("***** ERROR: RXthread: socket");
        return NULL;
    }

    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
    setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = (interface_offset > 0) ? inet_addr(mcb.ip) : htonl(INADDR_ANY);
    addr.sin_port = htons(ddc0_port + myddc);

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        t_perror("rx_thread ERROR: bind");
        close(sock);
        return NULL;
    }

    t_print("Starting rx_thread(%d)\n", myddc);
    while (!do_exit) {
        if (!gen_rcvd || ddcenable[myddc] <= 0 || rxrate[myddc] == 0 || rxfreq[myddc] == 0) {
            usleep(50000);
            seqnum = 0;
            continue;
        }

        p = rx_buffer;
        *(uint32_t*)p = htonl(seqnum++);
        p += 4;

        // no time stamps
        p += 9;

        *p++ = 24; // bits per sample
        *p++ = 0;
        *p++ = 238; // samps per packet

        pthread_mutex_lock (&send_lock);

        while (!(send_flags & rcb->rcvr_mask) && running) {
            pthread_cond_wait (&send_cond, &send_lock);
        }
        send_flags &= ~rcb->rcvr_mask;
        pthread_mutex_unlock (&send_lock);

        memcpy(p, &pbuf[myddc][0], 1428); // I-Q data

#if 0  // for debug
        if (seqnum > 1000 && myddc == 1) {
            t_print ("rcvrs_mask:%x send_flags:%d\n", mcb.rcvrs_mask, send_flags);

            for (int i = 0; i < 1444; i++) {
                printf("%4d:%2x ", i, rx_buffer[i]);

                if (!((i + 1) % 8))
                    printf("\n");
            }
            //exit(0);
        }
#endif

        if (sendto(sock, rx_buffer, 1444, 0, (struct sockaddr * )&addr_new, sizeof(addr_new)) < 0) {
            t_perror("***** ERROR: RX thread sendto");
            break;
        }

        pthread_mutex_lock (&done_send_lock);
        done_send_flags |= rcb->rcvr_mask;
        pthread_cond_broadcast (&done_send_cond);
        pthread_mutex_unlock (&done_send_lock);

        if (rcb->new_freq) {
            /* ws_thread picks up new_freq and sends a JSON tune message */
            rcb->curr_freq = rcb->new_freq;
            /* new_freq is cleared by ws_thread after sending the tune message */
        }
    }

    close(sock);
    t_print("Ending rx_thread(%d)\n", myddc);
    rx_thread_id[myddc] = 0;
    ddcenable[myddc] = 0;
    return NULL;
}

#define BIN_SAMPLE_CNT 32768

void *wb_thread(void *data)
{
    // NOTE: this thread reuses the hp_sock socket since two sockets
    //       can't send/recv on the same port/address (1027)
    unsigned long seqnum = 0;
    unsigned char wb_buffer[1028];
    uint8_t samples[BIN_SAMPLE_CNT];
    unsigned char *p;
    int i, j;
    FILE *bfile;
    char *filename = "/dev/shm/rx888wb.bin";
    size_t bytes_read;

    t_print("Starting wb_thread()\n");
    while (!do_exit) {
        if (!gen_rcvd || !running || !wbenable) {
            usleep(50000);
            continue;
        }

        bfile = fopen(filename, "rb");
        if (bfile != NULL) {
            bytes_read = fread(samples, 1, BIN_SAMPLE_CNT, bfile);
            if (bytes_read != 32768) {
                //t_print("%s, bytes_read:%ld bytes_wanted:%d\n",
                //       __FUNCTION__, bytes_read, BIN_SAMPLE_CNT);
                fclose(bfile);
                continue; // skip it and continue
            }
            seqnum = 0; // reset per frame
            fclose(bfile);

            // frame
            for (i = 0; i < 32; i++) {
                // update seq number
                p = wb_buffer;
                *(uint32_t*)p = htonl(seqnum++);
                p += 4;

                // packet
                for (j = 0; j < 1024; j+=2) { //swap bytes
                    wb_buffer[j+5] = samples[j + (i * 1024)];
                    wb_buffer[j+4] = samples[j + 1 + (i * 1024)];
                }

                if (sendto(hp_sock, wb_buffer, 1028, 0,
                           (struct sockaddr * )&addr_new, sizeof(addr_new)) < 0) {
                    t_perror("***** ERROR: WB thread sendto");
                    break;
                }
            }
            usleep(66000);
        } else {
            t_print("%s() filename: %s does not exist\n", __FUNCTION__, filename);
            break;
        }
    }

    t_print("Ending wb_thread()\n");
    return NULL;
}

//
// The microphone thread just sends silence, that is
// a "zeroed" mic frame every 1.333 msec and needs to
// be sent for some app's timing purposes.
//
void *mic_thread(void *data)
{
    int sock;
    unsigned long seqnum = 0;
    struct sockaddr_in addr;
    unsigned char mic_buffer[132];
    unsigned char *p;
    int yes = 1;
    struct timespec delay;
    sock = socket(AF_INET, SOCK_DGRAM, 0);

    if (sock < 0) {
        t_perror("***** ERROR: Mic thread: socket");
        return NULL;
    }

    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
    setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = (interface_offset > 0) ? inet_addr(mcb.ip) : htonl(INADDR_ANY);
    addr.sin_port = htons(mic_port);

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        t_perror("mic_thread ERROR: bind");
        close(sock);
        return NULL;
    }

    memset(mic_buffer, 0, 132);
    clock_gettime(CLOCK_MONOTONIC, &delay);

    t_print("Starting mic_thread()\n");
    while (!do_exit) {
        if (!gen_rcvd || !running) {
            usleep(500000);
            seqnum = 0;
            continue;
        }
        // update seq number
        p = mic_buffer;
        *(uint32_t*)p = htonl(seqnum++);
        p += 4;

        // 64 samples with 48000 kHz, makes 1333333 nsec
        delay.tv_nsec += 1333333;

        while (delay.tv_nsec >= 1000000000) {
            delay.tv_nsec -= 1000000000;
            delay.tv_sec++;
        }

        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &delay, NULL);

        if (sendto(sock, mic_buffer, 132, 0, (struct sockaddr * )&addr_new, sizeof(addr_new)) < 0) {
            t_perror("***** ERROR: Mic thread sendto");
            break;
        }
    }

    t_print("Ending mic_thread()\n");
    close(sock);
    return NULL;
}
