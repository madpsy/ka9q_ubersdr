/*
 * p1_framing.c — the protocol 1 wire logic, without a socket.
 *
 * What this pins is the part that fails silently. A wrong sample rate code or a
 * mis-shifted register address does not crash: the bridge connects, streams,
 * and hands the client a correctly framed picture of the wrong thing. The live
 * test can only say "IQ arrived"; these say what the bytes meant.
 *
 * hpsdr_p1.c is linked against stubs for the receiver plumbing, so what the
 * decode DID is observable — which register was written, with what value —
 * rather than inferred from a receiver's behaviour two layers away.
 */

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "../ka9q_hpsdr.h"
#include "../hpsdr_p1.h"

/* ---- what the layer under test called ---------------------------------- */

static int  stub_rate_hz = -1;
static long stub_freq_hz = -1;
static int  stub_enabled = -1;
static int  stub_stop_all = 0;

void p1_host_set_rate(int rcvr, int rate_hz) { (void)rcvr; stub_rate_hz = rate_hz; }
void p1_host_set_freq(int rcvr, long hz)     { (void)rcvr; stub_freq_hz = hz; }
void p1_host_enable(int rcvr, bool on)       { (void)rcvr; stub_enabled = on ? 1 : 0; }
void p1_host_stop_all(void)                  { stub_stop_all++; }

/* Whether a protocol 2 client holds the receivers. The tests drive this
 * directly, because refusing to start on top of one is behaviour worth pinning
 * rather than a detail of how the two protocols happen to be wired. */
static bool stub_p2_busy = false;
bool p1_host_p2_busy(void) { return stub_p2_busy; }

static unsigned char stub_mac[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
const unsigned char *p1_host_mac(void) { return stub_mac; }
int p1_host_board_type(void) { return 6; }   /* Hermes Lite */

void t_print(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    (void)vfprintf(stderr, fmt, ap);
    va_end(ap);
}

/* ---- harness ------------------------------------------------------------ */

static int pass = 0, fail = 0;

static void ok(int cond, const char *what)
{
    if (cond) { printf("PASS %s\n", what); pass++; }
    else      { printf("FAIL %s\n", what); fail++; }
}

/* One EP2 packet carrying `bank` in both 512-byte frames. */
static void ep2_with(const unsigned char bank[5], unsigned char *pkt)
{
    memset(pkt, 0, 1032);
    pkt[0] = 0xEF; pkt[1] = 0xFE; pkt[2] = 0x01; pkt[3] = 0x02;
    for (int f = 0; f < 2; f++) {
        unsigned char *frame = pkt + 8 + f * 512;
        frame[0] = frame[1] = frame[2] = 0x7F;
        memcpy(frame + 3, bank, 5);
    }
}

static void feed(const unsigned char *pkt, int len)
{
    struct sockaddr_in from;
    memset(&from, 0, sizeof(from));
    from.sin_family = AF_INET;
    /* Socket -1: nothing in the EP2 path sends, and a discovery reply would
     * fail harmlessly rather than write to a real descriptor. */
    p1_handle_datagram(-1, pkt, len, &from);
}

int main(void)
{
    unsigned char pkt[1032];

    /* The four sample rates, as C1[1:0] of the config register. A wrong code
     * here asks the receiver for the wrong bandwidth and everything downstream
     * still works, which is why it is worth stating. */
    const int want[4] = {48000, 96000, 192000, 384000};
    for (int code = 0; code < 4; code++) {
        unsigned char bank[5] = {0x00, (unsigned char)code, 0x00, 0x00, 0x00};
        stub_rate_hz = -1;
        ep2_with(bank, pkt);
        feed(pkt, sizeof(pkt));
        char name[64];
        snprintf(name, sizeof(name), "ep2-rate-code-%d-is-%d-hz", code, want[code]);
        ok(stub_rate_hz == want[code], name);
    }

    /*
     * RX1 frequency is register 0x02, and C0 carries the address SHIFTED LEFT
     * ONE because C0 bit 0 is MOX — so it appears as 0x04, not 0x02. Reading it
     * unshifted would take the frequency bank for the config register.
     */
    {
        unsigned char bank[5] = {0x04, 0x00, 0x8F, 0x0D, 0x18};  /* 9410328 Hz */
        stub_freq_hz = -1;
        ep2_with(bank, pkt);
        feed(pkt, sizeof(pkt));
        ok(stub_freq_hz == 0x008F0D18, "ep2-rx1-frequency-is-big-endian-at-c0-0x04");
    }

    /* A bank at the unshifted address must NOT be read as a frequency. */
    {
        unsigned char bank[5] = {0x02, 0x00, 0x8F, 0x0D, 0x18};
        stub_freq_hz = -1;
        ep2_with(bank, pkt);
        feed(pkt, sizeof(pkt));
        ok(stub_freq_hz == -1, "ep2-register-0x01-is-not-the-rx1-frequency");
    }

    /*
     * MOX is bit 0 of C0 on every frame, so a keyed config bank is still a
     * config bank. Masking it off is what keeps a transmitting client's frames
     * from being ignored wholesale.
     */
    {
        /* Rate code 1, deliberately different from the 384 kHz the loop above
         * left set: the layer only calls down when the value CHANGES, so a
         * repeat would prove nothing about the masking either way. That dedupe
         * is not incidental — EP2 packets arrive continuously, and acting on
         * every one would ask for a reconnect hundreds of times a second. */
        unsigned char bank[5] = {0x00 | 0x01, 0x01, 0x00, 0x00, 0x00};
        stub_rate_hz = -1;
        ep2_with(bank, pkt);
        feed(pkt, sizeof(pkt));
        ok(stub_rate_hz == 96000, "ep2-mox-bit-does-not-hide-the-register");
    }

    /* And the dedupe itself: a repeated bank must not call down again. */
    {
        unsigned char bank[5] = {0x00, 0x01, 0x00, 0x00, 0x00};
        stub_rate_hz = -1;
        ep2_with(bank, pkt);
        feed(pkt, sizeof(pkt));
        ok(stub_rate_hz == -1, "ep2-unchanged-rate-does-not-reconnect");
    }

    /* A frame without the three sync bytes is not a command bank, and reading
     * five bytes from it anyway would act on whatever happened to be there. */
    {
        unsigned char bank[5] = {0x00, 0x00, 0x00, 0x00, 0x00};
        ep2_with(bank, pkt);
        pkt[8] = 0x00;                    /* break frame 0's sync */
        unsigned char freq[5] = {0x04, 0x01, 0x02, 0x03, 0x04};
        memcpy(pkt + 8 + 512 + 3, freq, 5);   /* frame 1 stays valid */
        stub_freq_hz = -1;
        feed(pkt, sizeof(pkt));
        ok(stub_freq_hz == 0x01020304, "ep2-unsynced-frame-skipped-valid-one-read");
    }

    /* Run and stop, which is what claims and releases the bridge. */
    {
        unsigned char run[64] = {0xEF, 0xFE, 0x04, 0x01};
        stub_enabled = -1;
        feed(run, sizeof(run));
        ok(p1_active() && stub_enabled == 1, "run-command-starts-the-stream");

        unsigned char stop[64] = {0xEF, 0xFE, 0x04, 0x00};
        stub_stop_all = 0;
        feed(stop, sizeof(stop));
        ok(!p1_active() && stub_enabled == 0 && stub_stop_all == 1,
           "stop-command-releases-every-receiver");
    }

    /*
     * Both protocols drive the same receivers, so the second client to arrive
     * has to be turned away rather than allowed to reconfigure the first one's
     * session. Refusing is the same answer a real radio gives.
     */
    {
        unsigned char run[64] = {0xEF, 0xFE, 0x04, 0x01};
        stub_p2_busy = true;
        stub_enabled = -1;
        feed(run, sizeof(run));
        ok(!p1_active() && stub_enabled == -1,
           "run-refused-while-a-protocol-2-client-streams");
        stub_p2_busy = false;
    }

    /* Protocol 2 datagrams must fall through untouched: a 60-byte packet of
     * zeros with 0x02 at [4] is protocol 2 discovery, not protocol 1. */
    {
        unsigned char p2[60] = {0};
        p2[4] = 0x02;
        struct sockaddr_in from;
        memset(&from, 0, sizeof(from));
        ok(!p1_handle_datagram(-1, p2, sizeof(p2), &from),
           "protocol-2-discovery-is-not-claimed");
    }

    /* Round geometry at one receiver: 6 bytes of IQ plus a 2-byte mic word is
     * 8, and 504 divides by it exactly — 63 rounds a frame, 126 a packet. */
    ok(P1_SAMPLES_PER_PACKET == 126, "one-receiver-is-126-samples-per-packet");
    ok(504 % 8 == 0, "one-receiver-round-divides-the-frame-payload");

    printf("\npassed %d, failed %d\n", pass, fail);
    return fail == 0 ? 0 : 1;
}
