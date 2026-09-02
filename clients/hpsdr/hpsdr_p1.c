/*
 * hpsdr_p1.c — openHPSDR protocol 1 ("Metis"). See hpsdr_p1.h for the wire
 * format and why this lives beside the protocol 2 server rather than forking it.
 */

#include "ka9q_hpsdr.h"
#include "hpsdr_p1.h"

#include <complex.h>
#include <pthread.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

/* ------------------------------------------------------------------------ */
/* Wire constants                                                           */
/* ------------------------------------------------------------------------ */

#define P1_USB_PACKET   1032   /* EF FE 01 <ep> | seq[4] | frame512 | frame512 */
#define P1_FRAME        512
#define P1_FRAME_PAYLOAD 504
#define P1_SYNC         0x7F

#define P1_EP2          0x02   /* host -> radio, command and control */
#define P1_EP6          0x06   /* radio -> host, IQ */

#define P1_DISCOVERY_LEN 63
#define P1_COMMAND_LEN   64
#define P1_REPLY_LEN     60

/* Command and control register addresses, as they appear in C0. The address is
 * shifted left one because C0 bit 0 is MOX, so register 0x00 is C0 0x00 and
 * register 0x02 (RX1 frequency) is C0 0x04. */
#define P1_C0_ADDR_MASK 0xFE
#define P1_C0_MOX       0x01
#define P1_C0_CONFIG    0x00   /* register 0x00: sample rate, receiver count */
#define P1_C0_RX1_FREQ  0x04   /* register 0x02: RX1 NCO frequency, Hz BE32 */

/*
 * Phase 1 advertises one receiver, and a conforming client clamps itself to
 * what the board reports rather than assuming. That is what keeps the round
 * geometry at the single case where 504 divides exactly by the 8-byte round.
 */
#define P1_NUM_RX 1

/* Rounds of [I(3) Q(3)] x numRx + mic(2) that fit in one frame's payload. */
#define P1_ROUND_BYTES (6 * P1_NUM_RX + 2)
#define P1_ROUNDS_PER_FRAME (P1_FRAME_PAYLOAD / P1_ROUND_BYTES)

/*
 * How long a streaming client may go silent before the stream is stopped.
 *
 * A real radio has this, and so does the protocol 2 path here: without it a
 * client that dies leaves the bridge holding a receiver open against the
 * UberSDR server forever, which costs the operator a channel and the user
 * nothing to fix.
 */
#define P1_WATCHDOG_SECONDS 3

/* ------------------------------------------------------------------------ */
/* State                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Guards everything below. The datagrams arrive on the main thread and the EP6
 * packets are sent from a WebSocket thread, so the client address and the
 * running flag are written by one and read by the other.
 */
static pthread_mutex_t p1_lock = PTHREAD_MUTEX_INITIALIZER;

static bool p1_running = false;
static int p1_sock = -1;              /* port 1024, shared with discovery */
static struct sockaddr_in p1_client;  /* where EP6 goes: the run command's source */
static unsigned int p1_tx_seq = 0;    /* EP6 sequence, 32-bit BE, per packet */
static unsigned char p1_raddr = 0;    /* free-running telemetry address, 0..4 */
static struct timespec p1_last_rx;    /* last packet from the client */

/* What the client last asked for, so a repeat is not treated as a change. */
static int p1_rate_hz = 0;
static long p1_freq_hz = 0;

static void p1_touch(void)
{
    clock_gettime(CLOCK_MONOTONIC, &p1_last_rx);
}

bool p1_active(void)
{
    pthread_mutex_lock(&p1_lock);
    const bool r = p1_running;
    pthread_mutex_unlock(&p1_lock);
    return r;
}

/* ------------------------------------------------------------------------ */
/* Discovery                                                                */
/* ------------------------------------------------------------------------ */

/*
 * Answer a discovery request.
 *
 * Byte for byte this is what a client parses, and the offsets are not the
 * protocol 2 ones: status at [2] rather than [4], MAC from [3], gateware
 * version at [9], board id at [10], and the receiver count at [19] — not [20],
 * which holds the bandscope bits and the board build id and would be read as a
 * receiver count in the dozens.
 *
 * Answered even while streaming, with status 3, so a client that restarts can
 * still find the radio instead of waiting out the watchdog.
 */
static void p1_send_discovery_reply(int sock, const struct sockaddr_in *to)
{
    unsigned char reply[P1_REPLY_LEN];
    memset(reply, 0, sizeof(reply));

    reply[0] = 0xEF;
    reply[1] = 0xFE;
    reply[2] = p1_active() ? 0x03 : 0x02;
    memcpy(&reply[3], p1_host_mac(), 6);
    /*
     * Gateware version. Clients classify a Hermes Lite reporting below 40 as a
     * V1 board with a reduced feature set, so this says 62 for the same reason
     * the protocol 2 reply does: it is a plausible HL2 gateware version and it
     * keeps the client on the modern path.
     */
    reply[9]  = 62;
    reply[10] = (unsigned char)p1_host_board_type();
    reply[19] = P1_NUM_RX;

    sendto(sock, reply, sizeof(reply), 0, (const struct sockaddr *)to, sizeof(*to));
}

/* ------------------------------------------------------------------------ */
/* EP2: command and control from the client                                 */
/* ------------------------------------------------------------------------ */

/* Sample rate is a two-bit field in C1 of the config register. */
static int p1_rate_from_c1(unsigned char c1)
{
    switch (c1 & 0x03) {
    case 0:  return 48000;
    case 1:  return 96000;
    case 2:  return 192000;
    default: return 384000;
    }
}

/*
 * Apply one five-byte command bank.
 *
 * Only the registers a receive-only bridge can act on are decoded. The rest are
 * real and meaningful on hardware — filter relays, transmit drive, ADC gain —
 * and are ignored deliberately rather than by omission: there is nothing behind
 * this bridge for them to control.
 */
static void p1_apply_cc(const unsigned char *cc)
{
    const unsigned char c0 = cc[0];

    /*
     * MOX is C0 bit 0 of every frame rather than a register of its own. This
     * bridge receives only, so a keyed frame is reported once and otherwise
     * ignored — silently dropping it would leave an operator wondering why
     * keying up does nothing.
     */
    static bool warned_mox = false;
    if ((c0 & P1_C0_MOX) && !warned_mox) {
        warned_mox = true;
        t_print("P1: client keyed (MOX) — this bridge is receive-only, ignoring\n");
    }

    switch (c0 & P1_C0_ADDR_MASK) {
    case P1_C0_CONFIG: {
        const int rate = p1_rate_from_c1(cc[1]);
        if (rate != p1_rate_hz) {
            p1_rate_hz = rate;
            t_print("P1: sample rate %d kHz\n", rate / 1000);
            p1_host_set_rate(0, rate);
        }
        /*
         * Receiver count is C4[6:3], a four-bit field holding numRx-1. Read and
         * reported but not acted on: phase 1 advertises one receiver and a
         * client that asks for more has ignored the discovery reply, which is
         * worth saying rather than quietly serving one anyway.
         */
        const int want_rx = ((cc[4] >> 3) & 0x0F) + 1;
        static int warned_rx = 0;
        if (want_rx != P1_NUM_RX && warned_rx != want_rx) {
            warned_rx = want_rx;
            t_print("P1: client asked for %d receivers; this bridge offers %d\n",
                    want_rx, P1_NUM_RX);
        }
        break;
    }
    case P1_C0_RX1_FREQ: {
        const long hz = ((long)cc[1] << 24) | ((long)cc[2] << 16) |
                        ((long)cc[3] << 8)  |  (long)cc[4];
        if (hz != 0 && hz != p1_freq_hz) {
            p1_freq_hz = hz;
            p1_host_set_freq(0, hz);
        }
        break;
    }
    default:
        break;
    }
}

/* Both 512-byte frames of an EP2 packet, each sync-framed. A frame that is not
 * sync-framed is not a command bank and reading five bytes from it anyway would
 * be acting on whatever happened to be there. */
static void p1_handle_ep2(const unsigned char *buf, int len)
{
    if (len < P1_USB_PACKET)
        return;
    for (int f = 0; f < 2; f++) {
        const unsigned char *frame = buf + 8 + (size_t)f * P1_FRAME;
        if (frame[0] != P1_SYNC || frame[1] != P1_SYNC || frame[2] != P1_SYNC)
            continue;
        p1_apply_cc(frame + 3);
    }
}

/* ------------------------------------------------------------------------ */
/* Run and stop                                                             */
/* ------------------------------------------------------------------------ */

static void p1_start(int sock, const struct sockaddr_in *from)
{
    /*
     * A protocol 2 client already has the receivers. Both protocols drive the
     * same ones, so starting here would reconfigure that session out from under
     * it — and the samples would then leave as EP6 to this client, with the
     * other one simply going quiet and never being told why.
     *
     * Refused rather than queued: this is the same answer a real radio gives,
     * and the discovery reply already says status 3 so a client that asked
     * first had its warning.
     */
    if (!p1_active() && p1_host_p2_busy()) {
        static bool said = false;
        if (!said) {
            said = true;
            t_print("P1: refusing a client while a protocol 2 client is streaming\n");
        }
        return;
    }

    pthread_mutex_lock(&p1_lock);
    const bool was = p1_running;
    p1_running = true;
    p1_sock = sock;
    p1_client = *from;
    p1_tx_seq = 0;
    p1_raddr = 0;
    pthread_mutex_unlock(&p1_lock);
    p1_touch();

    if (!was) {
        t_print("P1: client started the stream\n");
        /* Whatever rate the client already configured; 192 kHz if it has not
         * said yet, which matches what the bridge starts at. */
        if (p1_rate_hz == 0)
            p1_rate_hz = 192000;
        p1_host_set_rate(0, p1_rate_hz);
        p1_host_enable(0, true);
    }
}

static void p1_stop(void)
{
    pthread_mutex_lock(&p1_lock);
    const bool was = p1_running;
    p1_running = false;
    pthread_mutex_unlock(&p1_lock);

    if (was) {
        t_print("P1: client stopped the stream\n");
        p1_host_enable(0, false);
        p1_host_stop_all();
    }
}

void p1_check_watchdog(void)
{
    if (!p1_active())
        return;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec - p1_last_rx.tv_sec >= P1_WATCHDOG_SECONDS) {
        t_print("P1: no packets from the client for %d s, stopping\n", P1_WATCHDOG_SECONDS);
        p1_stop();
    }
}

/* ------------------------------------------------------------------------ */
/* Datagram entry point                                                     */
/* ------------------------------------------------------------------------ */

bool p1_handle_datagram(int sock, const unsigned char *buf, int len,
                        const struct sockaddr_in *from)
{
    if (len < 3 || buf[0] != 0xEF || buf[1] != 0xFE)
        return false;   /* not protocol 1; leave it for the protocol 2 paths */

    p1_touch();

    switch (buf[2]) {
    case 0x02:
        if (len >= P1_DISCOVERY_LEN)
            p1_send_discovery_reply(sock, from);
        return true;

    case 0x04:
        /* Run command. Bit 0 streams EP6; the other bits select the bandscope
         * and disable the radio's own watchdog, neither of which applies here. */
        if (len >= 4) {
            if (buf[3] & 0x01)
                p1_start(sock, from);
            else
                p1_stop();
        }
        return true;

    case 0x01:
        if (len >= 4 && buf[3] == P1_EP2)
            p1_handle_ep2(buf, len);
        return true;

    default:
        return true;    /* protocol 1, but nothing this bridge implements */
    }
}

/* ------------------------------------------------------------------------ */
/* EP6: IQ to the client                                                    */
/* ------------------------------------------------------------------------ */

/*
 * The five status bytes that open each EP6 frame.
 *
 * The radio free-runs through telemetry addresses 0..4 rather than waiting to
 * be asked, so a client collects temperature, power and firmware without
 * requesting them. C0 carries the address at bits [6:3]; the sequence is
 * 0, 8, 16, 24, 32.
 *
 * Address 0 is the one that matters here: its low byte is the firmware version,
 * and bit 25 is transmit-permitted, ACTIVE LOW. It is left clear on purpose —
 * this bridge receives only, so a client reading it sees transmit inhibited,
 * which is true. The power and temperature addresses report zero because there
 * is no measurement behind them, and inventing plausible ones would put numbers
 * on a client's meters that mean nothing.
 */
static void p1_fill_status(unsigned char *cc)
{
    const unsigned char raddr = p1_raddr;
    p1_raddr = (unsigned char)((p1_raddr + 1) % 5);

    cc[0] = (unsigned char)(raddr << 3);
    cc[1] = cc[2] = cc[3] = cc[4] = 0;

    if (raddr == 0) {
        cc[4] = 62;   /* firmware version, matching the discovery reply */
    }
}

/* 24-bit big-endian signed, which is what both protocols carry and what the
 * scale factor in the receiver control block is already sized for. */
static void p1_put24(unsigned char *p, int v)
{
    p[0] = (unsigned char)((v >> 16) & 0xFF);
    p[1] = (unsigned char)((v >> 8) & 0xFF);
    p[2] = (unsigned char)(v & 0xFF);
}

void p1_send_packet(struct rcvr_cb *rcb)
{
    pthread_mutex_lock(&p1_lock);
    if (!p1_running || p1_sock < 0) {
        pthread_mutex_unlock(&p1_lock);
        return;
    }
    const int sock = p1_sock;
    const struct sockaddr_in to = p1_client;
    const unsigned int seq = p1_tx_seq++;
    pthread_mutex_unlock(&p1_lock);

    const float complex *iq = &rcb->iqSamples[rcb->iqSample_offset];

    unsigned char pkt[P1_USB_PACKET];
    memset(pkt, 0, sizeof(pkt));
    pkt[0] = 0xEF;
    pkt[1] = 0xFE;
    pkt[2] = 0x01;
    pkt[3] = P1_EP6;
    pkt[4] = (unsigned char)((seq >> 24) & 0xFF);
    pkt[5] = (unsigned char)((seq >> 16) & 0xFF);
    pkt[6] = (unsigned char)((seq >> 8) & 0xFF);
    pkt[7] = (unsigned char)(seq & 0xFF);

    int sample = 0;
    for (int f = 0; f < 2; f++) {
        unsigned char *frame = pkt + 8 + (size_t)f * P1_FRAME;
        frame[0] = frame[1] = frame[2] = P1_SYNC;
        p1_fill_status(frame + 3);

        unsigned char *round = frame + 8;
        for (int r = 0; r < P1_ROUNDS_PER_FRAME; r++, sample++) {
            /*
             * UberSDR's IQ uses the opposite spectral convention to HPSDR, so
             * the imaginary part goes in the I slot: swapping the two on the
             * wire is a conjugation, which un-mirrors the spectrum. Exactly
             * what load_packet does for protocol 2, and confirmed there on air.
             */
            p1_put24(round,     (int)cimagf(iq[sample]));
            p1_put24(round + 3, (int)crealf(iq[sample]));
            round[6] = 0;   /* mic / VNA word, silent on a receive-only bridge */
            round[7] = 0;
            round += P1_ROUND_BYTES;
        }
        /* The remainder of the frame stays zero. A round never straddles a
         * frame boundary, so the tail is padding rather than samples. */
    }

    sendto(sock, pkt, sizeof(pkt), 0, (const struct sockaddr *)&to, sizeof(to));
}
