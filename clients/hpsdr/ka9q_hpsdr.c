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
 * This program simulates an HPSDR Hermes board with 8 receiver slices
 * using multicast data from ka9q-radio. Currently it expects ka9q-radio
 * to be setup and using an RX-888 (MkII) SDR but I've tested an RTL Blog V4
 * and it seems to work.
 */

#include "ka9q_hpsdr.h"

static int do_exit = 0;
struct main_cb mcb;
static int sock_udp;
static int hp_sock;
static int interface_offset = 0;

static u_int send_flags = 0;
static u_int done_send_flags = 0;
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
             "curl -s --max-time 10 -A 'UberSDR_HPSDR/1.0' "
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

/*
 * Per-session data stored by lws alongside the wsi.
 * We keep a back-pointer to the rcvr_cb so the callback can reach it.
 */
struct ws_session_data {
    struct rcvr_cb *rcb;
};

static int ws_callback(struct lws *wsi,
                       enum lws_callback_reasons reason,
                       void *user, void *in, size_t len)
{
    /*
     * We pass rcb via the lws context user pointer (ctx_info.user).
     * Per-session data (user) is used only to cache the pointer after
     * LWS_CALLBACK_CLIENT_ESTABLISHED so subsequent callbacks are fast.
     */
    struct ws_session_data *sd = (struct ws_session_data *)user;
    struct rcvr_cb *rcb = NULL;

    if (sd) {
        if (sd->rcb) {
            rcb = sd->rcb;
        } else {
            /* First callback after session allocation — populate from context */
            rcb = (struct rcvr_cb *)lws_context_user(lws_get_context(wsi));
            sd->rcb = rcb;
        }
    }

    switch (reason) {

    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        if (sd && !sd->rcb) {
            rcb = (struct rcvr_cb *)lws_context_user(lws_get_context(wsi));
            sd->rcb = rcb;
        }
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
        if (rcb) rcb->reconnect_needed = 1;
        break;

    case LWS_CALLBACK_CLIENT_CLOSED:
        t_print("ws_callback(%d): connection closed\n",
                rcb ? rcb->rcvr_num : -1);
        if (rcb) rcb->reconnect_needed = 1;
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
        .per_session_data_size = sizeof(struct ws_session_data),
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
 */
void *ws_thread(void *arg)
{
    struct rcvr_cb *rcb = (struct rcvr_cb *)arg;

    rcb->iqSample_offset = rcb->iqSamples_remaining = 0;
    rcb->err_count = 0;
    rcb->last_sample_rate = 0;
    rcb->last_channels    = 0;

    /* Allocate a ZSTD decompression context for this receiver */
    rcb->zstd_dctx = ZSTD_createDCtx();
    if (!rcb->zstd_dctx) {
        t_print("ws_thread(%d): ZSTD_createDCtx failed\n", rcb->rcvr_num);
        pthread_exit(NULL);
    }

    t_print("ws_thread(%d): starting, url=%s\n", rcb->rcvr_num, mcb.ubersdr_url);

    while (!do_exit) {
        /* Wait until this DDC is enabled */
        if (!ddcenable[rcb->rcvr_num]) {
            usleep(50000);
            continue;
        }

        rcb->reconnect_needed = 0;

        /*
         * mcb.ubersdr_url is an HTTP base URL, e.g. "http://host:8080"
         * or "https://host:8443".  We:
         *   1. POST to /connection to get permission
         *   2. Derive ws:// (or wss://) for the WebSocket connection
         */

        /* --- Step 1: connection permission check --- */
        if (!check_ubersdr_connection_rcb(mcb.ubersdr_url, rcb)) {
            t_print("ws_thread(%d): connection not allowed, retrying in 5s\n", rcb->rcvr_num);
            sleep(5);
            continue;
        }

        /* --- Step 2: parse host/port from the HTTP base URL --- */
        char host[256] = {0};
        int  port = 80;
        int  use_ssl = 0;

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

        /* Extract host and optional port from "host[:port][/...]" */
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

        /* --- Step 3: build the WebSocket path with query string --- */
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

        /* Set up lws context */
        struct lws_context_creation_info ctx_info = {0};
        ctx_info.port      = CONTEXT_PORT_NO_LISTEN;
        ctx_info.protocols = ws_protocols;
        ctx_info.options   = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
        ctx_info.user      = rcb;   /* accessible via lws_context_user() */

        struct lws_context *ctx = lws_create_context(&ctx_info);
        if (!ctx) {
            t_print("ws_thread(%d): lws_create_context failed\n", rcb->rcvr_num);
            sleep(2);
            continue;
        }

        /* Connect — rcb is accessible via lws_context_user() in the callback */
        struct lws_client_connect_info ci = {0};
        ci.context        = ctx;
        ci.address        = host;
        ci.port           = port;
        ci.path           = full_path;
        ci.host           = host;
        ci.origin         = host;
        ci.protocol       = ws_protocols[0].name;
        ci.ssl_connection = use_ssl ? LCCSCF_USE_SSL : 0;

        struct lws *wsi = lws_client_connect_via_info(&ci);
        if (!wsi) {
            t_print("ws_thread(%d): lws_client_connect_via_info failed\n", rcb->rcvr_num);
            lws_context_destroy(ctx);
            sleep(2);
            continue;
        }

        /* Service loop — exits on shutdown, reconnect request, or DDC disable */
        while (!do_exit && !rcb->reconnect_needed && ddcenable[rcb->rcvr_num]) {
            /* If a new_freq is pending, request writeable callback */
            if (rcb->new_freq != 0)
                lws_callback_on_writable(wsi);

            int rc = lws_service(ctx, 50 /* ms timeout */);
            if (rc < 0) break;
        }

        lws_context_destroy(ctx);

        if (!do_exit && !ddcenable[rcb->rcvr_num] && !rcb->reconnect_needed) {
            t_print("ws_thread(%d): DDC disabled, disconnecting\n", rcb->rcvr_num);
        } else if (!do_exit && rcb->reconnect_needed) {
            t_print("ws_thread(%d): reconnecting in 1s\n", rcb->rcvr_num);
            sleep(1);
        }
    }

    ZSTD_freeDCtx(rcb->zstd_dctx);
    rcb->zstd_dctx = NULL;
    t_print("ws_thread(%d): exiting\n", rcb->rcvr_num);
    pthread_exit(NULL);
}

int find_net(char *find)
{
    DIR* dir;
    struct dirent* ent;
    char* endptr;

    if (!(dir = opendir("/sys/class/net"))) {
        perror("can't open /sys/class/net");
        return 0;
    }

    while((ent = readdir(dir)) != NULL) {
        if (!strcmp("print", find) && strcmp(".", ent->d_name) && strcmp("..", ent->d_name)) {
            printf("%s ", ent->d_name);
        } else if (!strcmp(ent->d_name, find)) {
            return 1;
        }
        if (*endptr != '\0') {
            continue;
        }
    }
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

    static struct option long_options[] = {
        {"url",        required_argument, 0, 'u'},
        {"password",   required_argument, 0, 'p'},
        {"interface",  required_argument, 0, 'i'},
        {"receivers",  required_argument, 0, 'n'},
        {"device",     required_argument, 0, 'd'},
        {"wideband",   no_argument,       0, 'w'},
        {"help",       no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt_index = 0;
    while((CmdOption = getopt_long(argc, argv, "u:p:i:n:d:wh", long_options, &opt_index)) != -1) {
        switch(CmdOption) {
        case 'h':
            printf("Usage: %s [options]\n\n", basename(argv[0]));
            printf("UberSDR Connection Options:\n");
            printf("  --url URL          UberSDR server URL (default http://localhost:8080)\n");
            printf("  --password PASS    UberSDR server password (optional)\n");
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
            continue;
        }

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
