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
 * (iq48/iq96/iq192/iq384) rather than consuming ka9q-radio multicast streams.
 *
 * Key modifications:
 *   - WebSocket client using libwebsockets (one connection per DDC receiver)
 *   - Dynamic IQ sample rate selection based on HPSDR client bandwidth request
 *   - Reconnect logic: rate/mode changes trigger WebSocket disconnect+reconnect
 *     with the new IQ mode baked into the URL
 *   - lws context destroy/recreate on reconnect to avoid TLS teardown delays
 *   - Client disconnect watchdog: if no high-priority packet is received for
 *     5 seconds, streaming is stopped and DDC state is cleared
 *   - protocol version 4 decoding of the PCM frames received from UberSDR
 */

#include "ka9q_hpsdr.h"
#include "hpsdr_p1.h"

static int do_exit = 0;
struct main_cb mcb;
static int sock_udp;
static int hp_sock;
static int ddcspec_sock = -1;   /* bound to port 1025; also the source for HP status sends */
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
static struct timespec last_client_activity = {0};  // updated by any UDP receive from client
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
static pthread_t hpstat_thread_id = 0;
static pthread_t sink_thread_id = 0;
static pthread_t throughput_thread_id = 0;
static pthread_t rx_thread_id[MAX_RCVRS] = {0,};
static void   *highprio_thread(void*);
static void   *ddc_specific_thread(void*);
static void   *mic_thread(void *);
static void   *wb_thread(void *);
static void   *hpstat_thread(void *);
static void   *sink_thread(void *);
static void   *rx_thread(void *);
static void   *ws_thread(void *);

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
/*
 * How far this receiver tunes, from /api/description's `tuning_range`.
 *
 * The receiver is not always the 0-30 MHz box this bridge assumed: the span
 * follows the front end sample rate, so a 129.6 Msps RX888 reaches 60 MHz and
 * has 6 m in it. The server publishes the numbers from one place
 * (ReceiverConfig.TuningRange in receiver_span.go) and every other client reads
 * them the same way.
 *
 * The fallback is a contract rather than padding: a receiver that publishes
 * nothing — an older server, or one this bridge could not reach — must behave
 * exactly as this bridge did before the span became configurable.
 */
long ubersdr_min_freq = 10000;
long ubersdr_max_freq = 30000000;

/* Pull one JSON number out of an object, or leave *out alone if it is absent,
 * unparseable or not positive. Each field falls back on its own: the two are
 * independent facts, and a receiver that states one must not reset the other. */
static void parse_json_long(const char *obj, const char *key, long *out)
{
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(obj, pat);
    if (!p) return;
    p = strchr(p, ':');
    if (!p) return;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    char *end = NULL;
    double v = strtod(p, &end);
    if (end == p || !(v > 0)) return;
    *out = (long)v;
}

/*
 * Ask the receiver how much spectrum it covers.
 *
 * Failure is not an error: every path out leaves the 10 kHz - 30 MHz default in
 * force. A bridge that starts and warns wrongly beats one that refuses to
 * start, and there is nothing here a listener cannot work around by tuning.
 */
void fetch_ubersdr_tuning_range(const char *url)
{
    size_t ulen = strlen(url);
    if (ulen > 0 && url[ulen - 1] == '/') ulen--;

    char cmd[1024];
    snprintf(cmd, sizeof(cmd),
             "curl -s --max-time 10 -A 'UberSDR_HPSDR/1.0' '%.*s/api/description' 2>/dev/null",
             (int)ulen, url);

    FILE *fp = popen(cmd, "r");
    if (!fp) return;

    /* The object is far down a large document, so the whole body is read
     * rather than scanned line by line. */
    char *resp = NULL;
    size_t rlen = 0;
    char line[1024];
    while (fgets(line, sizeof(line), fp) != NULL) {
        size_t ll = strlen(line);
        char *tmp = realloc(resp, rlen + ll + 1);
        if (!tmp) { free(resp); pclose(fp); return; }
        resp = tmp;
        memcpy(resp + rlen, line, ll);
        rlen += ll;
        resp[rlen] = '\0';
    }
    pclose(fp);
    if (!resp) return;

    /* Read out of tuning_range and not from whatever else in the payload shares
     * the name: noise_floor publishes min_frequency too. */
    const char *tr = strstr(resp, "\"tuning_range\"");
    if (tr) {
        long min = 10000, max = 30000000;
        parse_json_long(tr, "min_frequency", &min);
        parse_json_long(tr, "max_frequency", &max);
        /* A max at or below the min is not a receiver, it is a
         * misconfiguration, and adopting it would leave every check below
         * inverted. Refused outright, both edges. */
        if (max > min) {
            ubersdr_min_freq = min;
            ubersdr_max_freq = max;
        } else {
            t_print("Receiver reports an inverted range (%ld - %ld Hz); assuming %ld - %ld\n",
                    min, max, ubersdr_min_freq, ubersdr_max_freq);
        }
    }
    free(resp);

    t_print("Receiver tunes %.3f kHz - %.3f MHz\n",
            ubersdr_min_freq / 1000.0, ubersdr_max_freq / 1000000.0);
}

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

/* ------------------------------------------------------------------------ */
/* The receiver plumbing protocol 1 drives.                                   */
/*                                                                            */
/* Declared in hpsdr_p1.h as an interface so the coupling runs one way: that   */
/* layer asks the bridge for things, and the bridge knows nothing about        */
/* protocol 1 beyond handing it datagrams.                                     */
/* ------------------------------------------------------------------------ */

static unsigned char p1_mac[6] = {0};

/*
 * Display gain for a channel rate, in kHz.
 *
 * Amplitude compensation for bandwidth: a wider channel collects more noise
 * power, so the same spectral density arrives as larger samples and needs less
 * gain to display at the same level. That is a 1/sqrt(BW) law, and the entries
 * follow it — 48 kHz at 8000 gives 8000/sqrt(4) = 4000 at 192, which is what
 * was there before this became a function. (96's 6000 is the odd one out
 * against the 5657 the law predicts; a round number, chosen by ear.)
 *
 * One table because both protocols pack the same samples into the same 24-bit
 * field: a client should not see a different level for choosing a different
 * protocol.
 */
static float scale_for_rate(int khz)
{
    switch (khz) {
    case 48:  return 8000.0f;
    case 96:  return 6000.0f;
    case 192: return 4000.0f;
    case 384: return 2828.0f;
    default:  return 4000.0f;
    }
}

const unsigned char *p1_host_mac(void) { return p1_mac; }
int p1_host_board_type(void) { return mcb.device_type; }

/* Is a protocol 2 client streaming? Both protocols drive the same receivers, so
 * the second one to arrive has to be turned away rather than allowed to
 * reconfigure the first one's session out from under it. */
bool p1_host_p2_busy(void) { return running && gen_rcvd; }

/* A rate change is a mode change, and the mode is baked into the WebSocket URL,
 * so it is applied the same way the protocol 2 path applies one: set the rate
 * and ask for a reconnect. The early return keeps a no-op from tearing the
 * WebSocket down and rebuilding it for nothing.
 *
 * The display gain is deliberately NOT set here. It is a function of the
 * bandwidth and is derived where the samples are scaled, because a stored copy
 * has to be kept in step with the rate and once was not: the receivers are
 * seeded at 192 kHz, so a client selecting 192 kHz — the commonest case, and
 * what p1_start assumes when the client has not said — took this early return
 * and kept the placeholder gain of 700 rather than that rate's 4000. Fifteen
 * decibels quiet, at 192 kHz alone, since every other rate differs from the
 * seed and got past the return. */
void p1_host_set_rate(int rcvr, int rate_hz)
{
    if (rcvr < 0 || rcvr >= MAX_RCVRS) return;
    if (mcb.rcb[rcvr].output_rate == rate_hz) return;

    mcb.rcb[rcvr].output_rate = rate_hz;
    rxrate[rcvr] = rate_hz / 1000;
    mcb.rcb[rcvr].reconnect_needed = 1;
}

void p1_host_set_freq(int rcvr, long hz)
{
    if (rcvr < 0 || rcvr >= MAX_RCVRS) return;
    if (hz != 0 && (hz < ubersdr_min_freq || hz > ubersdr_max_freq)) {
        t_print("P1: WARNING tuned to %.3f MHz, outside the receiver's "
                "%.3f kHz - %.3f MHz\n", hz / 1e6,
                ubersdr_min_freq / 1000.0, ubersdr_max_freq / 1000000.0);
    }
    rxfreq[rcvr] = hz;
    mcb.rcb[rcvr].new_freq = hz;
    t_print("P1: DDC%d tuned to %ld Hz\n", rcvr, hz);
}

void p1_host_enable(int rcvr, bool on)
{
    if (rcvr < 0 || rcvr >= MAX_RCVRS) return;
    ddcenable[rcvr] = on ? 1 : 0;
    mcb.rcb[rcvr].rcvr_mask = on ? (1 << rcvr) : 0;
    /* `running` gates the receive threads and the activity watchdog, exactly as
     * the protocol 2 high-priority packet sets it. */
    running = on ? 1 : 0;
    if (!on) {
        rxrate[rcvr] = 0;
        rxfreq[rcvr] = 0;
    }
    /* Wake anything blocked on the protocol 2 handshake so a disable cannot
     * wedge a thread that is waiting for a packet that will never come. */
    pthread_mutex_lock(&send_lock);
    pthread_cond_broadcast(&send_cond);
    pthread_mutex_unlock(&send_lock);
    pthread_mutex_lock(&done_send_lock);
    pthread_cond_broadcast(&done_send_cond);
    pthread_mutex_unlock(&done_send_lock);
}

void p1_host_stop_all(void)
{
    for (int i = 0; i < MAX_RCVRS; i++) {
        ddcenable[i] = 0;
        mcb.rcb[i].rcvr_mask = 0;
        rxrate[i] = 0;
        rxfreq[i] = 0;
    }
    running = 0;
}

/*
 * The IQ mode this receiver is running, in kHz.
 *
 * Named in two places — the connect URL and the tune message — and they have to
 * agree: the server changes a session's mode to whatever a tune tells it, so a
 * tune carrying a different mode from the one the socket was opened with
 * silently reconfigures the session. That is not hypothetical; it is what a
 * clamp left behind in one of the two did, downgrading a 384 kHz session to 192
 * the moment the client first moved the VFO. One function so there is one
 * answer.
 */
static int rcvr_iq_khz(const struct rcvr_cb *rcb)
{
    int khz = rcb->output_rate / 1000;
    if (khz > 384) khz = 384;   /* the widest mode the server offers */
    if (khz < 48) khz = 48;     /* and the narrowest */
    return khz;
}

/*
 * Decode one protocol version 4 binary frame from ubersdr into complex floats.
 *
 * Version 4 replaced the zstd wrapper and the fixed 37-byte header this used to
 * parse with a predictive codec and a header carrying only what changed; see
 * pcm_v4.h. The decoder is stateful across the whole socket, so it lives in the
 * receiver control block and every frame must reach it — a frame that skips it
 * leaves this side's filters where the server's no longer are, and everything
 * after decodes as noise.
 *
 * Samples arrive interleaved I/Q as int16, which is what this scales to ±1.0.
 *
 * On success, fills iq_out[] with complex float samples, sets *out_count,
 * *out_sample_rate, *out_channels, and returns true. Returns false on any
 * error.
 */
bool decode_pcm_frame(struct rcvr_cb *rcb,
                      const uint8_t *frame, size_t frame_len,
                      float complex *iq_out, int max_samples,
                      int *out_count, int *out_sample_rate, int *out_channels)
{
    /* A server older than 0.1.63 clamps the requested version to 1-3 and
     * answers with version 1 rather than refusing it, so its frames arrive as
     * zstd rather than as an error. Naming that beats a stream of bad magic
     * hundreds of times a second. */
    if (pcmv4_is_zstd_frame(frame, frame_len)) {
        t_print("decode_pcm_frame(%d): server does not support protocol version %d "
                "(needs UberSDR 0.1.63 or later)\n", rcb->rcvr_num, PCMV4_PROTOCOL_VERSION);
        return false;
    }

    struct pcmv4_header h;
    const int16_t *samples;
    char err[128];
    if (!pcmv4_decode(&rcb->pcm, frame, frame_len, &h, &samples, err, sizeof(err))) {
        t_print("decode_pcm_frame(%d): %s\n", rcb->rcvr_num, err);
        return false;
    }

    if (h.channels != 2) {
        t_print("decode_pcm_frame(%d): expected 2 channels of I/Q, got %d\n",
                rcb->rcvr_num, h.channels);
        return false;
    }

    *out_sample_rate = h.sample_rate;
    *out_channels    = h.channels;

    int n_complex = h.sample_count / 2;
    if (n_complex > max_samples)
        n_complex = max_samples;

    for (int i = 0; i < n_complex; i++) {
        const float fi = (float)samples[2 * i]     / 32768.0f;
        const float fq = (float)samples[2 * i + 1] / 32768.0f;
        iq_out[i] = fi + fq * I;
    }

    *out_count = n_complex;
    return true;
}

/*
 * Fetch public UberSDR instances from the instances API.
 * Filters to only those supporting the rates HPSDR carries (48-384 kHz).
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
 * Keeps the IQ modes this bridge can serve: 48, 96, 192 and 384 kHz, which are
 * exactly the four DDC rates the HPSDR protocol carries.
 * Returns number of modes found. */
static int parse_iq_modes(const char *obj, char modes[][16], int max_modes)
{
    static const char *allowed[] = {"iq48", "iq96", "iq192", "iq384", NULL};
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
            /* Only keep the rates the HPSDR protocol has a code for */
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
                char txt[256] = {0};
                size_t tlen = len < sizeof(txt) - 1 ? len : sizeof(txt) - 1;
                memcpy(txt, in, tlen);

                char type[32] = {0};
                json_str(txt, "type", type, sizeof(type));

                /*
                 * The server sends a status after every tune, so at one line of
                 * JSON per dial movement this was most of the log. It is worth
                 * keeping rather than dropping — it is what showed the session
                 * being downgraded to iq192 while the connect URL said iq384,
                 * which nothing else reported — so it is summarised, and only
                 * when it changes.
                 *
                 * Everything else prints in full. An error is rare and always
                 * worth reading, and a type this bridge does not know about is
                 * exactly the thing that should not be hidden.
                 */
                if (strcmp(type, "status") == 0) {
                    char rate[16] = {0}, mode[16] = {0};
                    json_num(txt, "sampleRate", rate, sizeof(rate));
                    json_str(txt, "mode", mode, sizeof(mode));
                    const int sr_reported = atoi(rate);
                    if (sr_reported != rcb->last_status_rate ||
                        strcmp(mode, rcb->last_status_mode) != 0) {
                        rcb->last_status_rate = sr_reported;
                        snprintf(rcb->last_status_mode, sizeof(rcb->last_status_mode),
                                 "%s", mode);
                        t_print("ws_callback(%d): server serving %s at %d Hz\n",
                                rcb->rcvr_num, mode, sr_reported);
                    }
                } else {
                    t_print("ws_callback(%d): %s\n", rcb->rcvr_num, txt);
                }
                break;
            }

            /* Counted before the decode and whatever it makes of the frame,
             * because this is what the link carried: the reduced-depth mode is
             * only visible here, where the same 384 kHz stream costs fewer
             * bytes for the same samples. */
            __atomic_fetch_add(&rcb->ws_bytes, (unsigned long long)len,
                               __ATOMIC_RELAXED);

            int n_samples = 0, sr = 0, ch = 0;

            if (rcb->iqSamples_remaining < 0)
                rcb->iqSamples_remaining = 0;

            /*
             * Decode directly into the tail of iqSamples[].  The buffer is
             * sized (IQ_RING_SAMPLES) for the largest possible frame plus
             * one packet of leftover, so nothing is truncated or overflowed.
             */
            int space = IQ_RING_SAMPLES - rcb->iqSamples_remaining;
            bool ok = decode_pcm_frame(rcb,
                                       (const uint8_t *)in, len,
                                       &rcb->iqSamples[rcb->iqSamples_remaining],
                                       space,
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

            /* Scale in place.
             *
             * Derived here rather than stored beside the rate. The two are one
             * fact — the gain is a function of the bandwidth — and keeping a
             * second copy meant keeping them in step, which is exactly what
             * failed: a receiver seeded at 192 kHz with a placeholder gain kept
             * that placeholder for any client that selected 192 kHz, because
             * the setter returned early on the rate already matching. There is
             * now nothing to keep in step.
             *
             * From the rate the samples ARRIVED at, not the rate the client
             * asked for, so a session the server serves narrower than requested
             * is still scaled for what it actually sent. */
            const float scale = scale_for_rate(sr / 1000);
            for (int i = 0; i < n_samples; i++) {
                rcb->iqSamples[rcb->iqSamples_remaining + i] *= scale;
            }

            rcb->iqSamples_remaining += n_samples;

            /*
             * Which framing the samples leave in, and how many go per packet,
             * is the only thing about this path that depends on the protocol.
             * Everything above it — the socket, the decode, the scaling — is
             * the same either way.
             *
             * The stream itself is the pacing in both cases: samples arrive at
             * the receiver's own rate, so a packet goes out when there are
             * enough for one and there is no timer to drift against.
             */
            const bool p1 = p1_active();
            const int samps_packet = p1 ? P1_SAMPLES_PER_PACKET : 238;
            while (rcb->iqSamples_remaining >= samps_packet) {
                if (p1)
                    p1_send_packet(rcb);
                else
                    load_packet(rcb);
                rcb->iqSamples_remaining -= samps_packet;
                rcb->iqSample_offset     += samps_packet;
            }

            /* Relocate any leftover to the front and reset the offset —
             * the offset must also be reset when nothing is left, otherwise
             * the next load_packet() would read from a stale offset. */
            if (rcb->iqSample_offset > 0) {
                if (rcb->iqSamples_remaining > 0) {
                    memmove(&rcb->iqSamples[0],
                            &rcb->iqSamples[rcb->iqSample_offset],
                            rcb->iqSamples_remaining * sizeof(float complex));
                }
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
            int rate_khz = rcvr_iq_khz(rcb);
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
 * Connects to ubersdr via WebSocket, receives lossless PCM frames,
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
    rcb->last_sample_rate = 0;
    rcb->last_channels    = 0;
    rcb->wsi_closed       = 0;

    /* The version 4 decoder for this receiver's socket. Allocation happens
     * lazily inside it; init only has to make it empty. */
    pcmv4_stream_init(&rcb->pcm);

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
        pcmv4_stream_free(&rcb->pcm);
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

        t_print("ws_thread(%d): outer loop top: reconnect_needed=%d rate=%d\n",
                rcb->rcvr_num, rcb->reconnect_needed, rcb->output_rate / 1000);

        /* --- Step 1: generate a fresh session ID and check connection permission.
         * A new UUID must be generated on every connect attempt — the server
         * invalidates the session when the WebSocket closes, so reusing the old
         * UUID on reconnect results in "Invalid session" errors. */
        generate_uuid(rcb->session_id);
        t_print("ws_thread(%d): checking connection permission (session=%s)\n",
                rcb->rcvr_num, rcb->session_id);
        if (!check_ubersdr_connection_rcb(mcb.ubersdr_url, rcb)) {
            t_print("ws_thread(%d): connection not allowed, retrying in 5s\n", rcb->rcvr_num);
            /* Sleep in short increments so a rate change wakes us promptly */
            for (int s = 0; s < 50 && !do_exit && !rcb->reconnect_needed; s++)
                usleep(100000); /* 100 ms × 50 = 5 s max */
            continue;
        }

        /* --- Step 2: build the WebSocket path with query string --- */
        char full_path[512];
        {
            int rate_khz = rcvr_iq_khz(rcb);
            /* "pcm-zstd" is still the server's name for the lossless format,
             * and IQ is only ever served losslessly; from version 4 what it
             * carries is a predictive codec rather than a zstd wrapper. Named
             * explicitly rather than left to the server's default, so the query
             * says what this bridge actually reads. */
            /* min_margin is only sent when it was asked for. An empty or
             * zero-valued parameter is not the same thing to the server as an
             * absent one -- absent is the lossless path, which is what every
             * client that has not asked for the reduced-depth mode must keep
             * getting. */
            char margin[32] = "";
            if (mcb.min_margin > 0) {
                snprintf(margin, sizeof(margin), "&min_margin=%d", mcb.min_margin);
            }
            if (mcb.ubersdr_password[0]) {
                snprintf(full_path, sizeof(full_path),
                         "/ws?frequency=%d&mode=iq%d&user_session_id=%s&password=%s"
                         "&format=pcm-zstd&version=%d%s",
                         rcb->curr_freq, rate_khz, rcb->session_id,
                         mcb.ubersdr_password, PCMV4_PROTOCOL_VERSION, margin);
            } else {
                snprintf(full_path, sizeof(full_path),
                         "/ws?frequency=%d&mode=iq%d&user_session_id=%s"
                         "&format=pcm-zstd&version=%d%s",
                         rcb->curr_freq, rate_khz, rcb->session_id,
                         PCMV4_PROTOCOL_VERSION, margin);
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
        /* A fresh socket is a fresh stream: the server builds a new encoder
         * for it, so the predictor state and header baseline start over too.
         * Done before connecting rather than after, because the first frame can
         * arrive inside lws_service below. */
        pcmv4_stream_reset(&rcb->pcm);
        rcb->last_status_rate = 0;
        rcb->last_status_mode[0] = '\0';

        /*
         * And so does the rate this connection is expected to carry.
         *
         * The guard in ws_callback exists to catch the rate changing UNDER a
         * live connection, which would silently reframe the IQ the client is
         * being sent. Across a reconnect a change is not a surprise, it is the
         * point: the mode is baked into the URL, so changing rate is precisely
         * why we are reconnecting. Leaving the old value here made the first
         * frame of the new connection disagree with it, set reconnect_needed,
         * and break out before it could be updated — a loop that reconnects
         * forever and never delivers a sample.
         *
         * It bites at any rate other than the 192 kHz this bridge starts at, so
         * it was reachable before 384 kHz was: a client that enables a DDC
         * first and sets the rate afterwards connects once at the default, and
         * every connection after that disagrees with it.
         */
        rcb->last_sample_rate = 0;
        rcb->last_channels    = 0;

        struct lws *wsi = lws_client_connect_via_info(&ci);
        if (!wsi) {
            t_print("ws_thread(%d): lws_client_connect_via_info failed\n", rcb->rcvr_num);
            sleep(2);
            continue;
        }
        t_print("ws_thread(%d): lws_client_connect_via_info succeeded\n", rcb->rcvr_num);

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
    pcmv4_stream_free(&rcb->pcm);
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

/* How often the throughput line goes out, in seconds. */
#define THROUGHPUT_INTERVAL 5.0

/*
 * What --min-margin may be set to. These are the server's own limits, from
 * lossyMinMarginDB and lossyMaxMarginDB in pcm_lossy.go, repeated here so a
 * value outside them is refused with a reason at startup rather than silently
 * clamped to something else halfway through a session.
 *
 * The floor is where the quantisation noise starts to lift the noise floor a
 * client can see: 15 dB down adds 0.14 dB to it, under what a receiver's own
 * readings resolve, and 6 dB down adds a full 1 dB. Above 60 dB the request
 * buys nothing measurable, and a client wanting less than that should leave the
 * option off and take the lossless stream rather than have one marked lossy and
 * shifted by zero.
 */
#define MIN_MARGIN_MIN_DB 15.0
#define MIN_MARGIN_MAX_DB 60.0

/*
 * Parse and validate a --min-margin argument, in dB.
 *
 * Strict on purpose. The server clamps whatever it is sent into its own range
 * and rounds it to a whole dB, so a typo -- "2O", "20dB", "6" -- would produce
 * a working but different stream, and nothing downstream would ever say so. The
 * one value accepted outside the range is 0, which is how a script says "no
 * reduced-depth mode" without having to build a different command line.
 */
static bool parse_min_margin(const char *arg, int *out)
{
    if (arg == NULL || *arg == '\0') {
        fprintf(stderr, "--min-margin: expected a value in dB\n");
        return false;
    }

    errno = 0;
    char *end = NULL;
    const double v = strtod(arg, &end);
    while (end != NULL && isspace((unsigned char)*end)) end++;
    if (end == arg || end == NULL || *end != '\0' || errno == ERANGE || !isfinite(v)) {
        fprintf(stderr, "--min-margin: '%s' is not a number of dB\n", arg);
        return false;
    }

    if (v == 0.0) {          /* an explicit "lossless", same as leaving it off */
        *out = 0;
        return true;
    }

    if (v < MIN_MARGIN_MIN_DB || v > MIN_MARGIN_MAX_DB) {
        fprintf(stderr,
                "--min-margin: %g dB is outside %g-%g; the server would not "
                "honour it as asked. Omit the option for a lossless stream\n",
                v, MIN_MARGIN_MIN_DB, MIN_MARGIN_MAX_DB);
        return false;
    }

    /* The server rounds to a whole dB, so the rounding happens here too and the
     * number this bridge reports is the one the stream was coded to. */
    const int dB = (int)lround(v);
    if ((double)dB != v) {
        t_print("--min-margin: %g dB rounded to %d, which is what the server "
                "would have done with it\n", v, dB);
    }
    *out = dB;
    return true;
}

/*
 * Reports what the IQ stream is actually costing, every five seconds while a
 * client is streaming.
 *
 * Counted off the WebSocket rather than worked out from the sample rate,
 * because the two are not the same number. Version 4 codes IQ predictively, so
 * a quiet band costs less than a busy one at the same rate, and the
 * reduced-depth mode less again -- and none of that is visible anywhere else.
 *
 * Nothing is printed while no client is connected. The counters are still
 * drained on every pass, so the first line after a client arrives covers its
 * own five seconds rather than everything the bridge ever received.
 */
static void *throughput_thread(void *arg)
{
    (void)arg;
    struct timespec last;
    clock_gettime(CLOCK_MONOTONIC, &last);
    bool was_running = false;

    while (!do_exit) {
        usleep(250000);

        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);

        /* A client arriving restarts the interval rather than joining whatever
         * is left of the one in progress. Otherwise the first line after a
         * client connects divides its traffic by five seconds most of which it
         * was not there for, and reports a rate it never ran at. */
        const bool now_running = (running != 0);
        if (now_running != was_running) {
            was_running = now_running;
            for (int i = 0; i < mcb.num_rxs; i++)
                __atomic_store_n(&mcb.rcb[i].ws_bytes, 0ULL, __ATOMIC_RELAXED);
            last = now;
            continue;
        }

        const double elapsed = (now.tv_sec - last.tv_sec) +
                               (now.tv_nsec - last.tv_nsec) * 1e-9;
        if (elapsed < THROUGHPUT_INTERVAL) continue;
        last = now;

        char line[256];
        int off = 0, active = 0;
        double total = 0.0;

        for (int i = 0; i < mcb.num_rxs; i++) {
            /* Read and cleared in one step, so the next interval starts from
             * zero and no traffic is counted twice or lost between the two. */
            const unsigned long long bytes =
                __atomic_exchange_n(&mcb.rcb[i].ws_bytes, 0ULL, __ATOMIC_RELAXED);
            if (!running || bytes == 0) continue;

            const double kbps = (double)bytes * 8.0 / 1000.0 / elapsed;
            total += kbps;
            active++;
            if (off >= 0 && off < (int)sizeof(line)) {
                off += snprintf(line + off, sizeof(line) - (size_t)off,
                                "%sDDC%d %.1f kbps", off ? "  " : " ", i, kbps);
            }
        }

        if (active == 0) continue;
        if (off < 0 || off >= (int)sizeof(line)) continue;

        if (active > 1) {
            t_print("IQ:%s  total %.1f kbps\n", line, total);
        } else {
            t_print("IQ:%s\n", line);
        }
    }
    return NULL;
}

int main (int argc, char *argv[])
{
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

    /*
     * Quiet libwebsockets: with one lws context per receiver thread the
     * default NOTICE/WARN level floods startup with context-creation
     * notices and harmless "netlink bind failed" warnings (only the
     * first context can bind the netlink monitor socket).
     */
    lws_set_log_level(LLL_ERR, NULL);

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
        {"min-margin", required_argument, 0, 'm'},
        {"debug",      no_argument,       0, 'v'},
        {"discover",   no_argument,       0, 'D'},
        {"callsign",   required_argument, 0, 'c'},
        {"help",       no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt_index = 0;
    while((CmdOption = getopt_long(argc, argv, "u:p:i:n:d:m:wvDc:h", long_options, &opt_index)) != -1) {
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
            printf("  --min-margin DB    Reduced-depth IQ: keep the quantisation floor at\n");
            printf("                     least DB below the band's own noise floor, %g-%g.\n",
                   MIN_MARGIN_MIN_DB, MIN_MARGIN_MAX_DB);
            printf("                     Omitted, the stream is lossless. Saves 15-60%% of\n");
            printf("                     the bandwidth depending on the band; needs UberSDR\n");
            printf("                     0.1.64 or later, and older servers ignore it and\n");
            printf("                     send the lossless stream\n");
            printf("  --debug            Log per-DDC frequency requests from the client\n");
            printf("\n");
            printf("Examples:\n");
            printf("  %s --url http://localhost:8080 --interface eth0\n", basename(argv[0]));
            printf("  %s --url https://sdr.example.com --password mypass --interface eth0\n", basename(argv[0]));
            printf("  %s --url http://localhost:8080 --device 1 --receivers 4 --interface eth0\n", basename(argv[0]));
            printf("  %s --discover --interface eth0\n", basename(argv[0]));
            printf("  %s --callsign K3GMQ --interface eth0\n", basename(argv[0]));
            printf("  %s --url http://localhost:8080 --min-margin 20 --interface eth0\n", basename(argv[0]));
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
        case 'm':
            if (!parse_min_margin(optarg, &mcb.min_margin)) return EXIT_FAILURE;
            break;
        case 'w':
            mcb.wideband = 1;
            break;
        case 'v':
            mcb.debug = 1;
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

    /* Asked once, now the URL is settled, and reported: it is the only place a
     * listener learns that this receiver reaches past 30 MHz, since the HPSDR
     * protocol gives the client no way to be told. */
    fetch_ubersdr_tuning_range(mcb.ubersdr_url);

    /* Said once, because it is the one setting whose effect is invisible from
     * the HPSDR side: the client sees the same samples at the same rate, and
     * only the throughput line every five seconds shows what it saved. */
    if (mcb.min_margin > 0) {
        t_print("Reduced-depth IQ: asking for %d dB of margin under the noise floor\n",
                mcb.min_margin);
    }

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
    /* Both protocols' discovery replies carry it, and protocol 1's builder is
     * in another file, so it is kept where either can reach it. */
    memcpy(p1_mac, hwaddr.ifr_addr.sa_data, 6);

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

    if (pthread_create(&hpstat_thread_id, NULL, hpstat_thread, NULL) < 0) {
        t_perror("***** ERROR: Create HP status thread");
    }

    if (pthread_create(&sink_thread_id, NULL, sink_thread, NULL) < 0) {
        t_perror("***** ERROR: Create sink thread");
    }

    if (pthread_create(&throughput_thread_id, NULL, throughput_thread, NULL) < 0) {
        t_perror("***** ERROR: Create throughput thread");
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
        mcb.rcb[i].rcvr_num = i;
        mcb.rcb[i].reconnect_needed = 0;
        mcb.rcb[i].rcvr_mask = 1 << i;

        /* Generate a unique session ID for this receiver */
        generate_uuid(mcb.rcb[i].session_id);

        if (pthread_create(&ws_thread_id[i], NULL, ws_thread, &mcb.rcb[i]) < 0) {
            t_perror("***** ERROR: Create ws_thread");
        }
    }

    t_print("Waiting on Discovery...\n");

    while (!do_exit) {
        lenaddr = sizeof(addr_from);
        bytes_read = recvfrom(sock_udp, buffer, sizeof(buffer), 0, (struct sockaddr *)&addr_from, &lenaddr);

        if (bytes_read < 0 && errno != EAGAIN) {
            t_perror("recvfrom");
            continue;
        }

        if (bytes_read <= 0) {
            continue;
        }

        clock_gettime(CLOCK_MONOTONIC, &last_client_activity);
        code = *code0;

        /*
         * Protocol 1 gets first refusal. The two formats cannot be confused —
         * every protocol 1 datagram opens EF FE and every protocol 2 one opens
         * with four zero bytes — so this consumes only what is unmistakably
         * protocol 1 and leaves everything else to the branches below.
         */
        if (p1_handle_datagram(sock_udp, buffer, (int)bytes_read, &addr_from))
            continue;

        /*
         * Here we have to handle the following "non standard" cases:
         * NewProtocol "Discovery" packet   60 bytes starting with 00 00 00 00 02
         * NewProtocol "General"   packet   60 bytes starting with 00 00 00 00 00
         *                                  ==> this starts NewProtocol radio
         */
        if (bytes_read == 60 && code == 0 && buffer[4] == 0x02) {
            /*
             * Always answer discovery — a running radio must reply with
             * status 3 (busy) so re-discovering clients still find it.
             * Never answering while running makes the radio invisible to
             * a client that restarts, until the activity watchdog fires.
             */
            t_print("NewProtocol discovery packet received from %s (status %d)\n",
                    inet_ntoa(addr_from.sin_addr), 2 + (running ? 1 : 0));
            // prepare response
            memset(buffer, 0, 60);
            buffer [4] = 0x02 + (running ? 1 : 0);
            for (i = 0; i < 6; ++i) buffer[i + 5] = hwaddr.ifr_addr.sa_data[i];
            buffer[11] = mcb.device_type;
            buffer[12] = 38;
            /*
             * Firmware version: for HermesLite (device 6) clients classify
             * version < 40 as "Hermes Lite V1" with reduced capabilities;
             * report 62 (a plausible HL2 gateware version) instead.
             */
            buffer[13] = (mcb.device_type == HERMES_LITE) ? 62 : HERMES_FW_VER;
            buffer[20] = mcb.num_rxs;
            buffer[21] = 1;
            /* Sample rate bitmask, bits 0-3 = 48/96/192/384 kHz. This is the
             * one field that tells the client which rates it may ask for, so a
             * stale 7 here is what made 384 kHz unreachable however wide the
             * receiver was. */
            buffer[22] = 0x0f;

            sendto(sock_udp, buffer, 60, 0, (struct sockaddr *)&addr_from, sizeof(addr_from));
            continue;
        }

        if (bytes_read == 60 && buffer[4] == 0x00) {
            /* Protocol 1 has the receivers. Taking the general packet now would
             * point the IQ at this client while the samples still leave as EP6
             * to the other one, so it is refused — and said out loud, because a
             * client that is being ignored deserves to know why. */
            if (p1_active()) {
                static bool said = false;
                if (!said) {
                    said = true;
                    t_print("P2: ignoring a client while a protocol 1 client is streaming\n");
                }
                continue;
            }
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
    while (!(done_send_flags & rcb->rcvr_mask) && running
           && ddcenable[rcb->rcvr_num]) {
        pthread_cond_wait (&done_send_cond, &done_send_lock);
    }
    done_send_flags &= ~rcb->rcvr_mask;
    pthread_mutex_unlock (&done_send_lock);

    /*
     * P2 wire order is I first, then Q (3 bytes each, big-endian).
     *
     * However, ubersdr's IQ stream uses the OPPOSITE spectral convention
     * to HPSDR: sending it real-part-first produces a mirrored spectrum
     * (signals appear on the wrong side of the dial frequency —
     * empirically confirmed on air).  Swapping the two components on the
     * wire is equivalent to conjugation and un-mirrors the spectrum, so
     * the imaginary part deliberately goes first here.
     */
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
    seqnum = ((unsigned long)buffer[0] << 24) + (buffer[1] << 16) + (buffer[2] << 8) + buffer[3];

    if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
        t_print("GP: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
    }

    /*
     * Byte 37, bit 3 (0x08): DDC/DUC frequency fields in the High Priority
     * packet are phase words (freq * 2^32 / 122.88e6) rather than raw Hz.
     * Most clients (Thetis, piHPSDR, deskHPSDR) set it; some send raw Hz.
     */
    rc = buffer[37];
    if (rc != bits) {
        bits = rc;
        t_print("GP: frequency mode byte37=0x%02x (%s)\n", bits,
                (bits & 0x08) ? "phase word" : "raw Hz");
    }

    /*
     * Bytes 5-22 carry the UDP port-override table (0 = default).
     * This bridge only implements the default ports — if a client
     * remaps them, nothing will work, so at least say so.
     */
    {
        static int port_override_warned = 0;
        int nonzero = 0;
        for (int k = 5; k <= 22; k++) {
            if (buffer[k]) { nonzero = 1; break; }
        }
        if (nonzero && !port_override_warned) {
            port_override_warned = 1;
            t_print("GP: WARNING client requests non-default UDP ports "
                    "(general packet bytes 5-22) — not supported, using defaults\n");
        }
    }

    if (!mcb.wideband && (buffer[23] & 1)) {
        static int wb_req_warned = 0;
        if (!wb_req_warned) {
            wb_req_warned = 1;
            t_print("GP: client requested wideband data but bridge started "
                    "without --wideband (ignored)\n");
        }
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
    int hp_watchdog_armed = 0;   // armed only after client proves it sends HP packets
    unsigned long hp_pkt_count = 0;
    struct timespec hp_rate_time = {0};

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
        /* Protocol 1 owns the receivers; this client's high-priority packets
         * would reconfigure them under it. Drained and dropped. */
        if (p1_active()) { usleep(50000); continue; }

        if (!running) seqnum = 0;

        rc = recvfrom(hp_sock, hp_buffer, 1444, 0, (struct sockaddr *)&addr, &lenaddr);

        if (rc < 0 && errno != EAGAIN) {
            t_perror("***** ERROR: HighPrio thread: recvmsg");
            break;
        }

        if (rc < 0) {
            // EAGAIN timeout — check activity-based watchdog
            if (running && last_client_activity.tv_sec != 0) {
                struct timespec now;
                clock_gettime(CLOCK_MONOTONIC, &now);
                double since_any = (now.tv_sec - last_client_activity.tv_sec) +
                                   (now.tv_nsec - last_client_activity.tv_nsec) * 1e-9;
                if (since_any > 10.0) {
                    t_print("HP: no client UDP activity for %.1fs, client disconnected\n", since_any);
                    running = 0;
                    hp_watchdog_armed = 0;
                    hp_pkt_count = 0;
                    last_client_activity.tv_sec = 0;
                    for (i = 0; i < mcb.num_rxs; i++) {
                        ddcenable[i] = 0;
                        mcb.rcb[i].rcvr_mask = 0;
                        rxrate[i] = 0;
                        rxfreq[i] = 0;
                    }
                    /* Wake any thread blocked on the send handshake so it
                     * can observe running == 0 and park itself. */
                    pthread_mutex_lock (&send_lock);
                    pthread_cond_broadcast (&send_cond);
                    pthread_mutex_unlock (&send_lock);
                    pthread_mutex_lock (&done_send_lock);
                    pthread_cond_broadcast (&done_send_cond);
                    pthread_mutex_unlock (&done_send_lock);
                }
            }
            continue;
        }

        // Successful receive — reset watchdog timer and count packets
        clock_gettime(CLOCK_MONOTONIC, &last_hp_time);
        last_client_activity = last_hp_time;
        hp_pkt_count++;
        // Arm watchdog once we've seen 100+ packets (client is actively sending HP packets)
        if (!hp_watchdog_armed && hp_pkt_count >= 100) {
            hp_watchdog_armed = 1;
            t_print("HP: watchdog armed after %lu packets\n", hp_pkt_count);
        }
        if (hp_rate_time.tv_sec == 0) {
            hp_rate_time = last_hp_time;
        } else {
            double rate_elapsed = (last_hp_time.tv_sec - hp_rate_time.tv_sec) +
                                  (last_hp_time.tv_nsec - hp_rate_time.tv_nsec) * 1e-9;
            if (rate_elapsed >= 10.0) {
                t_print("HP: %.0f packets/sec from client\n", hp_pkt_count / rate_elapsed);
                hp_pkt_count = 0;
                hp_rate_time = last_hp_time;
            }
        }

        if (rc != 1444) {
            /* A stray/short datagram must not kill the control thread */
            t_print("Received HighPrio packet with incorrect length %d (ignored)\n", rc);
            continue;
        }

        seqold = seqnum;
        seqnum = ((unsigned long)hp_buffer[0] << 24) + (hp_buffer[1] << 16) + (hp_buffer[2] << 8) + hp_buffer[3];

        if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
            t_print("HP: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
        }

        for (i = 0; i < mcb.num_rxs; i++) {
            /* assemble as uint32_t: byte << 24 on a signed int would
             * sign-extend for phase words with bit 31 set */
            uint32_t word = ((uint32_t)hp_buffer[ 9 + 4 * i] << 24)
                          + ((uint32_t)hp_buffer[10 + 4 * i] << 16)
                          + ((uint32_t)hp_buffer[11 + 4 * i] << 8)
                          +  (uint32_t)hp_buffer[12 + 4 * i];
            freq = (long)word;

            if (bits & 0x08) {
                freq = round(122880000.0 * (double) word / 4294967296.0);
            }

            if (freq != rxfreq[i]) {
                /* Reported rather than clamped, and not advertised at all: the
                 * HPSDR protocol has no field for a tuning range — the
                 * discovery reply carries a board type and firmware version and
                 * nothing else — so the client takes its limits from whatever
                 * hardware it thinks it is talking to. Passing the request on
                 * and saying so is the most this end can do. */
                if (freq != 0 && (freq < ubersdr_min_freq || freq > ubersdr_max_freq)) {
                    t_print("RX: WARNING DDC%d tuned to %.3f MHz, outside the receiver's "
                            "%.3f kHz - %.3f MHz\n", i, freq / 1e6,
                            ubersdr_min_freq / 1000.0, ubersdr_max_freq / 1000000.0);
                }
                mcb.rcb[i].new_freq = rxfreq[i] = freq;
                if (mcb.debug)
                    t_print("HP: DDC%d freq: %lu\n", i, freq);
            }
        }

        /* NOTE: bytes 5/6 of the host->radio HP packet are CWX keying
         * bits (CWX/dot/dash), NOT dither/random (those live in the
         * DDC-specific packet).  Byte 1443 is the ADC0 step attenuator.
         * None of these apply to this bridge: no TX and no controllable
         * front-end, so they are ignored. */

        rc = hp_buffer[4] & 0x01;
        if (rc != running) {
            running = rc;
            t_print("HP: Running = %d\n", rc);
            if (!running) {
                hp_watchdog_armed = 0;
                hp_pkt_count = 0;
                for (i = 0; i < mcb.num_rxs; i++) {
                    ddcenable[i] = 0;
                    mcb.rcb[i].rcvr_mask = 0;
                    rxrate[i] = 0;
                    rxfreq[i] = 0;
                }
                /* Wake any thread blocked on the send handshake so it
                 * can observe running == 0 and park itself. */
                pthread_mutex_lock (&send_lock);
                pthread_cond_broadcast (&send_cond);
                pthread_mutex_unlock (&send_lock);
                pthread_mutex_lock (&done_send_lock);
                pthread_cond_broadcast (&done_send_cond);
                pthread_mutex_unlock (&done_send_lock);
            } else {
                // running just went 1 — reset packet counter, watchdog arms after 100 packets
                hp_watchdog_armed = 0;
                hp_pkt_count = 0;
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

    /* Export the fd: HP status packets must originate from source port
     * 1025, so hpstat_thread() sends on this same socket. */
    ddcspec_sock = sock;

    seqnum = 0;

    t_print("Starting ddc_specific_thread()\n");
    while (!do_exit) {
        /* Protocol 1 owns the receivers; this client's DDC-specific packets
         * would reconfigure them under it. Drained and dropped. */
        if (p1_active()) { usleep(50000); continue; }

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

        clock_gettime(CLOCK_MONOTONIC, &last_client_activity);

        if (rc != 1444) {
            /* A stray/short datagram must not kill the control thread */
            t_print("RXspec: Received DDC specific packet with incorrect length %d (ignored)\n", rc);
            continue;
        }

        seqold = seqnum;
        seqnum = ((unsigned long)ddc_buffer[0] << 24) + (ddc_buffer[1] << 16) + (ddc_buffer[2] << 8) + ddc_buffer[3];

        if ((seqnum != 0 && seqnum != seqold + 1 ) && seqold != 0) {
            t_print("RXspec: SEQ ERROR, old=%lu new=%lu\n", seqold, seqnum);
        }

        /* Bytes 5/6 carry the per-ADC dither/random enables — ignored,
         * as this bridge has no controllable ADC front-end. */

        /*
         * Bytes 1363+ddc: per-DDC sync bitmap (PureSignal/diversity).
         * Synced DDCs expect their samples interleaved in one stream,
         * which this bridge cannot produce — warn instead of failing
         * silently.
         */
        {
            static int sync_warned = 0;
            for (i = 0; i < mcb.num_rxs && !sync_warned; i++) {
                if (ddc_buffer[1363 + i]) {
                    sync_warned = 1;
                    t_print("RX: WARNING client requests synced DDCs "
                            "(byte %d = 0x%02x) — diversity/PureSignal not supported\n",
                            1363 + i, ddc_buffer[1363 + i]);
                }
            }
        }

        for (i = 0; i < mcb.num_rxs; i++) {
            int modified = 0;
            struct rcvr_cb *rcb = &mcb.rcb[i];

            rc = (ddc_buffer[18 + 6 * i] << 8) + ddc_buffer[19 + 6 * i];
            /* 384 kHz is the widest IQ mode the server offers, and the widest
             * rate the HPSDR protocol defines, so the two meet exactly. Note
             * the server only serves the wide modes to a bypassed session — an
             * unprivileged one is refused at /connection rather than here. */
            if (rc > 384) {
                t_print("RX: WARNING DDC%d requested %d kHz but ubersdr max is 384 kHz — "
                        "expect broken audio/spectrum at this rate\n", i, rc);
                rc = 384;
            }
            if (rc != rxrate[i] && rc != 0) {
                rxrate[i] = rc;
                mcb.rcb[i].output_rate = (rxrate[i] * 1000);
                modified = 1;

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
                } else {
                    /* Disable: wake anything blocked on the handshake so
                     * neither rx_thread nor load_packet() wedges. */
                    pthread_mutex_lock (&send_lock);
                    pthread_cond_broadcast (&send_cond);
                    pthread_mutex_unlock (&send_lock);
                    pthread_mutex_lock (&done_send_lock);
                    pthread_cond_broadcast (&done_send_cond);
                    pthread_mutex_unlock (&done_send_lock);
                }
            }

            if (modified) {
                t_print("RX: DDC%d Enable=%d Rate=%d\n", i, ddcenable[i], rxrate[i]);
                rc = 0;
            }
        }
    }

    ddcspec_sock = -1;
    close(sock);
    ddc_specific_thread_id = 0;
    t_print("Ending ddc_specific_thread()\n");
    return NULL;
}

/*
 * hpstat_thread — sends the radio->host High Priority status packet.
 *
 * The protocol requires the radio to send a 60-byte status packet from
 * source port 1025 (~every 50 ms during RX): PTT/dot/dash bits, ADC
 * overload, power and AIN readings.  This bridge has no TX and no real
 * ADC telemetry, so all fields are zero — but the stream itself (with
 * correct sequence numbers) must exist: clients use it for meters and
 * some treat its absence as a dead radio.
 *
 * Sends on ddcspec_sock, which is bound to port 1025 by
 * ddc_specific_thread(), so the source port is correct.
 */
void *hpstat_thread(void *data)
{
    unsigned long seqnum = 0;
    unsigned char buffer[60];

    t_print("Starting hpstat_thread()\n");
    while (!do_exit) {
        /* Protocol 1's client-silence watchdog rides this thread's cadence: it
         * is the one that already ticks whether or not a client is connected,
         * and a stopped protocol 1 client would otherwise hold a receiver open
         * against the UberSDR server indefinitely. Protocol 1 sends its own
         * telemetry inside EP6, so nothing below this applies to it. */
        p1_check_watchdog();
        if (p1_active()) {
            usleep(50000);
            continue;
        }

        if (!running || !gen_rcvd || addr_new.sin_port == 0 || ddcspec_sock < 0) {
            seqnum = 0;
            usleep(50000);
            continue;
        }

        memset(buffer, 0, sizeof(buffer));
        buffer[0] = (seqnum >> 24) & 0xFF;
        buffer[1] = (seqnum >> 16) & 0xFF;
        buffer[2] = (seqnum >>  8) & 0xFF;
        buffer[3] = (seqnum >>  0) & 0xFF;
        seqnum++;
        /* byte 4: PTT/dot/dash = 0 (RX only); all telemetry fields zero */

        if (sendto(ddcspec_sock, buffer, sizeof(buffer), 0,
                   (struct sockaddr *)&addr_new, sizeof(addr_new)) < 0) {
            t_perror("***** ERROR: hpstat_thread sendto");
        }

        usleep(50000); /* 50 ms cadence (RX) */
    }

    t_print("Ending hpstat_thread()\n");
    return NULL;
}

/*
 * sink_thread — drains the host->radio ports this RX-only bridge does
 * not act on: 1028 (audio) and 1029 (TX IQ).
 *
 * Without listeners, every client audio/TX packet triggers an ICMP
 * port-unreachable, and clients send audio continuously during RX.
 * Draining also counts as client activity for the disconnect watchdog.
 *
 * (Port 1026 — DUC/TX specific — is drained in mic_thread, which owns
 * the socket bound to 1026 for sending mic data.)
 */
void *sink_thread(void *data)
{
    static const int sink_ports[] = { 1028, 1029 };
    enum { NSINK = sizeof(sink_ports) / sizeof(sink_ports[0]) };
    int socks[NSINK];
    unsigned char scratch[2048];
    struct sockaddr_in addr;
    int i, yes = 1;

    for (i = 0; i < NSINK; i++) {
        socks[i] = socket(AF_INET, SOCK_DGRAM, 0);
        if (socks[i] < 0) {
            t_perror("***** ERROR: sink_thread: socket");
            return NULL;
        }
        setsockopt(socks[i], SOL_SOCKET, SO_REUSEADDR, (void *)&yes, sizeof(yes));
        setsockopt(socks[i], SOL_SOCKET, SO_REUSEPORT, (void *)&yes, sizeof(yes));
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = (interface_offset > 0) ? inet_addr(mcb.ip) : htonl(INADDR_ANY);
        addr.sin_port = htons(sink_ports[i]);
        if (bind(socks[i], (struct sockaddr *)&addr, sizeof(addr)) < 0) {
            t_perror("sink_thread ERROR: bind");
            /* non-fatal: keep the other ports */
            close(socks[i]);
            socks[i] = -1;
        }
    }

    t_print("Starting sink_thread() (draining ports 1028/1029)\n");
    while (!do_exit) {
        fd_set fds;
        struct timeval tv;
        int maxfd = -1;

        FD_ZERO(&fds);
        for (i = 0; i < NSINK; i++) {
            if (socks[i] >= 0) {
                FD_SET(socks[i], &fds);
                if (socks[i] > maxfd) maxfd = socks[i];
            }
        }
        if (maxfd < 0) break;

        tv.tv_sec = 0;
        tv.tv_usec = 200000;
        if (select(maxfd + 1, &fds, NULL, NULL, &tv) <= 0) continue;

        for (i = 0; i < NSINK; i++) {
            if (socks[i] >= 0 && FD_ISSET(socks[i], &fds)) {
                while (recv(socks[i], scratch, sizeof(scratch), MSG_DONTWAIT) > 0) {
                    clock_gettime(CLOCK_MONOTONIC, &last_client_activity);
                }
            }
        }
    }

    for (i = 0; i < NSINK; i++) {
        if (socks[i] >= 0) close(socks[i]);
    }
    t_print("Ending sink_thread()\n");
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
        /* Protocol 1 owns the receivers and sends their samples itself. A
         * protocol 2 client that got as far as a general packet leaves
         * gen_rcvd and addr_new set, and protocol 1 then sets the enable, rate
         * and frequency this guard checks — so without this the thread falls
         * through to a handshake nothing will ever complete. It parks rather
         * than misbehaves, but parking on a condition variable that cannot be
         * signalled is not a state worth relying on. */
        if (p1_active() || !gen_rcvd || ddcenable[myddc] <= 0 || rxrate[myddc] == 0
            || rxfreq[myddc] == 0 || addr_new.sin_port == 0) {
            usleep(50000);
            seqnum = 0;
            continue;
        }

        /*
         * P2 DDC IQ packet header (16 bytes):
         *   0-3   sequence number (big-endian)
         *   4-11  timestamp (unused, zero)
         *   12-13 bits per sample (16-bit BE = 24)
         *   14-15 samples per frame (16-bit BE = 238)
         */
        p = rx_buffer;
        *(uint32_t*)p = htonl(seqnum++);
        p += 4;

        memset(p, 0, 8);   // no time stamps
        p += 8;

        *p++ = 0;          // bits per sample, high byte
        *p++ = 24;         // bits per sample, low byte
        *p++ = 0;          // samples per frame, high byte
        *p++ = 238;        // samples per frame, low byte

        pthread_mutex_lock (&send_lock);

        while (!(send_flags & rcb->rcvr_mask) && running && ddcenable[myddc]) {
            pthread_cond_wait (&send_cond, &send_lock);
        }
        send_flags &= ~rcb->rcvr_mask;
        pthread_mutex_unlock (&send_lock);

        if (!running || !ddcenable[myddc]) {
            /* Woken by stop/disable — don't send; release any blocked
             * load_packet() and go back to the idle check. */
            pthread_mutex_lock (&done_send_lock);
            done_send_flags |= rcb->rcvr_mask;
            pthread_cond_broadcast (&done_send_cond);
            pthread_mutex_unlock (&done_send_lock);
            continue;
        }

        memcpy(p, &pbuf[myddc][0], 1428); // I-Q data

        if (sendto(sock, rx_buffer, 1444, 0, (struct sockaddr * )&addr_new, sizeof(addr_new)) < 0) {
            /* Transient send errors must not kill the DDC stream — the
             * thread is only respawned on a run 0->1 transition. */
            t_perror("***** ERROR: RX thread sendto");
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
        /* Likewise: `running` is set by whichever protocol is streaming, so
         * this has to name the one it belongs to. */
        if (p1_active() || !gen_rcvd || !running || !wbenable) {
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

            /*
             * Honor the wideband packet length negotiated in the General
             * packet (byte 24-25, samples per packet; default 512).
             * Clamp to what fits our fixed buffer and divides the sweep.
             */
            int wlen = wide_len;
            if (wlen < 64 || wlen > 512 || (16384 % wlen) != 0) wlen = 512;
            int npkts = 16384 / wlen;      /* 16384 16-bit samples per sweep */
            int dbytes = wlen * 2;

            // frame
            for (i = 0; i < npkts; i++) {
                // update seq number
                p = wb_buffer;
                *(uint32_t*)p = htonl(seqnum++);
                p += 4;

                // packet
                for (j = 0; j < dbytes; j+=2) { //swap bytes
                    wb_buffer[j+5] = samples[j + (i * dbytes)];
                    wb_buffer[j+4] = samples[j + 1 + (i * dbytes)];
                }

                if (sendto(hp_sock, wb_buffer, dbytes + 4, 0,
                           (struct sockaddr * )&addr_new, sizeof(addr_new)) < 0) {
                    t_perror("***** ERROR: WB thread sendto");
                    break;
                }
            }
            usleep(66000);
        } else {
            static int wb_warned = 0;
            if (!wb_warned) {
                t_print("%s() filename: %s does not exist (will keep retrying)\n",
                        __FUNCTION__, filename);
                wb_warned = 1;
            }
            usleep(1000000);
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
        /* Drain incoming TX-specific packets — the host sends them to
         * port 1026, which this socket owns.  We don't act on them
         * (RX-only bridge) but must not let them pile up unread. */
        {
            unsigned char scratch[2048];
            while (recv(sock, scratch, sizeof(scratch), MSG_DONTWAIT) > 0) {
                clock_gettime(CLOCK_MONOTONIC, &last_client_activity);
            }
        }

        if (!gen_rcvd || !running || addr_new.sin_port == 0) {
            usleep(500000);
            seqnum = 0;
            /* keep the pacing clock current so we don't burst on resume */
            clock_gettime(CLOCK_MONOTONIC, &delay);
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
            /* Transient send errors must not kill the mic stream */
            t_perror("***** ERROR: Mic thread sendto");
        }
    }

    t_print("Ending mic_thread()\n");
    close(sock);
    return NULL;
}
