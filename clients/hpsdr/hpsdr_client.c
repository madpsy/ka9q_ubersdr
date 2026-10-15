/*
 * hpsdr_client.c — an openHPSDR protocol 1 and protocol 2 client: tune a
 * bridge, demodulate what it sends, and play or record the audio.
 *
 * This is the other end of hpsdr_p1.c. The bridge has always been tested by
 * pointing real SDR software at it, which answers "does it work" and almost
 * nothing else: when the audio is wrong, that software reports a symptom rather
 * than a measurement, and the two candidate explanations — the bridge sending
 * the wrong thing, and the client mishandling the right thing — look identical
 * from the outside. This client exists to separate them. It prints what
 * actually arrived (sample rate against the rate it asked for, lost packets,
 * signal level in the 24-bit field) and it demodulates with a signal path
 * simple enough to read, so audio coming out wrong here means the bridge.
 *
 * That is why it is deliberately not a general-purpose SDR program: no
 * waterfall, no transmit, no filters beyond what the three modes need. It is an
 * instrument for testing the bridge beside it.
 *
 * Usage:
 *   ./ubersdr-hpsdr-client --freq 909000 --mode am --play
 *   ./ubersdr-hpsdr-client --freq 7100000 --mode lsb --rate 192 --wav out.wav
 *   ./ubersdr-hpsdr-client --host 127.0.0.1 --discover
 *
 * Build:
 *   make client          (it is not part of `make all`; see the Makefile)
 *
 * Audio goes out through a player process rather than a sound library, so this
 * adds no build dependency to a directory whose release binaries are pinned to
 * a particular libwebsockets soname. aplay, paplay and pw-play all read the raw
 * stream it writes; --player names a different one.
 */

#define _GNU_SOURCE 1

#include <arpa/inet.h>
#include <complex.h>
#include <errno.h>
#include <getopt.h>
#include <math.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------------ */
/* Protocol 1 on the wire                                                    */
/*                                                                           */
/* Only what a receive-only client needs. The layout is documented in full in  */
/* hpsdr_p1.h; these are the same constants from the host side, defined here   */
/* rather than shared so this program depends on nothing in the bridge and can */
/* be pointed at real hardware.                                               */
/* ------------------------------------------------------------------------ */

#define P1_PORT            1024
#define P1_USB_PACKET      1032   /* 8-byte header + two 512-byte frames */
#define P1_FRAME           512
#define P1_SYNC            0x7F
#define P1_ROUND_BYTES     8      /* I(3) Q(3) mic(2), at one receiver */
#define P1_ROUNDS_PER_FRAME 63
#define P1_SAMPLES_PER_PACKET (2 * P1_ROUNDS_PER_FRAME)
#define P1_EP2             0x02
#define P1_EP6             0x06

/*
 * C0 register addresses, already shifted into place.
 *
 * C0 carries MOX in bit 0 and the register address above it, so the address a
 * register map calls 0x02 travels as 0x04. Writing the unshifted number here is
 * a mistake that does not announce itself: the bridge matches nothing, ignores
 * the bank, and the receiver simply stays where it was, which looks like a
 * radio that will not tune rather than a client that never asked.
 */
#define P1_C0_CONFIG       0x00   /* register 0x00: sample rate, receiver count */
#define P1_C0_RX1_FREQ     0x04   /* register 0x02: RX1 NCO frequency, Hz BE32 */

/*
 * Protocol 2. The host configures the radio with three packets -- general
 * (port 1024, which also takes discovery), DDC-specific (1025: which DDCs run
 * and at what rate) and high-priority (1027: run, and each DDC's frequency) --
 * and the radio sends DDC n's IQ from port 1035+n. The high-priority packet is
 * resent as the keepalive.
 */
#define P2_PORT_GENERAL    1024
#define P2_PORT_DDC_SPEC   1025
#define P2_PORT_HIGH_PRIO  1027
#define P2_PORT_DDC0       1035
#define P2_DISCOVERY_LEN   60
#define P2_CONTROL_LEN     1444
#define P2_IQ_PACKET       1444
#define P2_IQ_HEADER       16     /* seq[4] timestamp[8] bits[2] samples[2] */
#define P2_SAMPLES_PER_PACKET 238
#define P2_MAX_RX          10

/* Audio is produced at this rate whatever the DDC runs at: every rate protocol
 * 1 offers is a power-of-two multiple of it, so the decimation is a chain of
 * halvings and needs no resampler. */
#define AUDIO_RATE 12000

/* Passband defaults and the ceiling the audio rate imposes. */
#define DEFAULT_BW_SSB  2400.0
#define DEFAULT_BW_AM   4500.0
#define DEFAULT_SSB_LOW  300.0
#define MAX_BW          5000.0

static volatile sig_atomic_t stop_now = 0;
static void on_signal(int sig) { (void)sig; stop_now = 1; }

/* ------------------------------------------------------------------------ */
/* Filters                                                                   */
/* ------------------------------------------------------------------------ */

/*
 * A windowed-sinc lowpass, normalised to unity gain at DC.
 *
 * Blackman rather than Hamming: the stopband matters more here than the
 * transition width, because everything this filter fails to remove is folded
 * on top of the audio by the decimation that follows it and cannot be told
 * apart afterwards.
 */
static void design_lowpass(float *h, int n, double cutoff_frac)
{
    const int m = n - 1;
    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        const double k = i - m / 2.0;
        const double s = (fabs(k) < 1e-9)
                       ? 2.0 * cutoff_frac
                       : sin(2.0 * M_PI * cutoff_frac * k) / (M_PI * k);
        const double w = 0.42 - 0.5 * cos(2.0 * M_PI * i / m)
                              + 0.08 * cos(4.0 * M_PI * i / m);
        h[i] = (float)(s * w);
        sum += h[i];
    }
    for (int i = 0; i < n; i++) h[i] /= (float)sum;
}

/* One decimate-by-two stage: lowpass, then keep every other sample. */
#define DECIM_TAPS 39

struct halfband {
    float h[DECIM_TAPS];
    float complex hist[DECIM_TAPS];
    int pos;
    int phase;
};

static void halfband_init(struct halfband *f)
{
    memset(f, 0, sizeof(*f));
    /* Just under a quarter of the input rate, which is the output Nyquist.
     * The gap left below it is the transition band; content inside it folds,
     * and at 0.23 what folds lands above 2.7 kHz where none of the three modes
     * is listening. */
    design_lowpass(f->h, DECIM_TAPS, 0.23);
}

/* Returns true and writes *out when this input sample produced an output. */
static bool halfband_run(struct halfband *f, float complex x, float complex *out)
{
    f->hist[f->pos] = x;
    f->pos = (f->pos + 1) % DECIM_TAPS;

    f->phase ^= 1;
    if (f->phase) return false;   /* drop every other sample */

    float complex acc = 0;
    int idx = f->pos;
    for (int i = DECIM_TAPS - 1; i >= 0; i--) {
        acc += f->h[i] * f->hist[idx];
        idx = (idx + 1) % DECIM_TAPS;
    }
    *out = acc;
    return true;
}

/*
 * The passband filters.
 *
 * MAX_PB_TAPS bounds both. At 12 kHz a 161-tap filter has a transition of
 * roughly 300 Hz, which is sharp enough to sound like a communications filter
 * without being so sharp it rings; the count is fixed rather than scaled with
 * the bandwidth so that narrowing the passband narrows the passband and does
 * not also change the skirt.
 */
#define MAX_PB_TAPS 161

/*
 * SSB: a complex bandpass passing one sideband only.
 *
 * A real lowpass shifted up or down the spectrum. With the carrier already at
 * zero — which is where tuning the DDC to the signal puts it — the upper
 * sideband is the positive frequencies and the lower sideband the negative
 * ones, so passing only one and taking the real part recovers that sideband at
 * its natural audio pitch. This is the whole of SSB demodulation from complex
 * baseband; there is no phasing network and no Hilbert transform because the
 * samples are already analytic.
 *
 * The passband runs from `low` to `low + width`, so --bandwidth widens it
 * upwards from the low cut rather than about its centre: that is what a
 * communications receiver does, and it keeps the low cut where it was put.
 */
struct ssb {
    float complex h[MAX_PB_TAPS];
    float complex hist[MAX_PB_TAPS];
    int pos;
};

static void ssb_init(struct ssb *f, int upper, double low, double width)
{
    float lp[MAX_PB_TAPS];
    memset(f, 0, sizeof(*f));
    const double half = width / 2.0;
    const double centre = low + half;
    design_lowpass(lp, MAX_PB_TAPS, half / AUDIO_RATE);
    const double dir = upper ? 1.0 : -1.0;
    for (int i = 0; i < MAX_PB_TAPS; i++) {
        const double ph = 2.0 * M_PI * dir * centre * i / AUDIO_RATE;
        f->h[i] = lp[i] * (float complex)(cos(ph) + I * sin(ph));
    }
}

static float ssb_run(struct ssb *f, float complex x)
{
    f->hist[f->pos] = x;
    f->pos = (f->pos + 1) % MAX_PB_TAPS;

    float complex acc = 0;
    int idx = f->pos;
    for (int i = MAX_PB_TAPS - 1; i >= 0; i--) {
        acc += f->h[i] * f->hist[idx];
        idx = (idx + 1) % MAX_PB_TAPS;
    }
    /* Twice the real part: the discarded sideband carried half the power. */
    return 2.0f * crealf(acc);
}

/*
 * AM: a complex lowpass ahead of the envelope detector.
 *
 * Filtering before detection rather than after is what makes the bandwidth
 * setting mean anything. The envelope of a signal plus its neighbour is not the
 * envelope of the signal, so a station 5 kHz up is demodulated into the audio
 * along with the wanted one and no amount of filtering afterwards separates
 * them again. A complex lowpass at the audio bandwidth keeps a passband of plus
 * and minus that around the carrier, which is the RF bandwidth an AM receiver's
 * dial calls twice the audio bandwidth.
 */
struct amfilt {
    float h[MAX_PB_TAPS];
    float complex hist[MAX_PB_TAPS];
    int pos;
};

static void am_init(struct amfilt *f, double width)
{
    memset(f, 0, sizeof(*f));
    design_lowpass(f->h, MAX_PB_TAPS, width / AUDIO_RATE);
}

static float complex am_run(struct amfilt *f, float complex x)
{
    f->hist[f->pos] = x;
    f->pos = (f->pos + 1) % MAX_PB_TAPS;

    float complex acc = 0;
    int idx = f->pos;
    for (int i = MAX_PB_TAPS - 1; i >= 0; i--) {
        acc += f->h[i] * f->hist[idx];
        idx = (idx + 1) % MAX_PB_TAPS;
    }
    return acc;
}

/* ------------------------------------------------------------------------ */
/* Output                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * A WAV writer that patches its own header on close.
 *
 * The two sizes in a RIFF header are only known once the recording ends, so
 * they are written as zero and seeked back over. A file left behind by a
 * killed process therefore has a zero-length data chunk and most players show
 * it as empty rather than as silence, which is the honest outcome: nothing
 * promised how long the recording was going to be.
 */
struct wav {
    FILE *f;
    uint32_t frames;
    int rate;
    int channels;
};

static bool wav_open(struct wav *w, const char *path, int rate, int channels)
{
    memset(w, 0, sizeof(*w));
    w->f = fopen(path, "wb");
    if (!w->f) return false;
    w->rate = rate;
    w->channels = channels;

    const uint16_t bits = 16;
    const uint16_t block = (uint16_t)(channels * bits / 8);
    const uint32_t byterate = (uint32_t)(rate * block);
    const uint32_t zero = 0;
    const uint32_t fmtlen = 16;
    const uint16_t pcm = 1, ch = (uint16_t)channels;
    const uint32_t rate32 = (uint32_t)rate;

    fwrite("RIFF", 1, 4, w->f); fwrite(&zero, 4, 1, w->f);
    fwrite("WAVEfmt ", 1, 8, w->f); fwrite(&fmtlen, 4, 1, w->f);
    fwrite(&pcm, 2, 1, w->f); fwrite(&ch, 2, 1, w->f);
    fwrite(&rate32, 4, 1, w->f); fwrite(&byterate, 4, 1, w->f);
    fwrite(&block, 2, 1, w->f); fwrite(&bits, 2, 1, w->f);
    fwrite("data", 1, 4, w->f); fwrite(&zero, 4, 1, w->f);
    return true;
}

static void wav_write(struct wav *w, const int16_t *s, int n)
{
    if (!w->f) return;
    fwrite(s, 2, (size_t)n, w->f);
    w->frames += (uint32_t)(n / w->channels);
}

static void wav_close(struct wav *w)
{
    if (!w->f) return;
    const uint32_t data = w->frames * (uint32_t)(w->channels * 2);
    const uint32_t riff = 36 + data;
    fseek(w->f, 4, SEEK_SET);  fwrite(&riff, 4, 1, w->f);
    fseek(w->f, 40, SEEK_SET); fwrite(&data, 4, 1, w->f);
    fclose(w->f);
    w->f = NULL;
}

/* ------------------------------------------------------------------------ */
/* Automatic gain                                                            */
/* ------------------------------------------------------------------------ */

/*
 * Automatic gain.
 *
 * The bridge delivers a very quiet signal — a strong medium-wave carrier
 * occupies about ten of the twenty-four bits — so a fixed gain would either
 * clip that or leave a weak band inaudible.
 *
 * The trap in writing one of these is what it does when the signal stops. An
 * AGC that only ever asks "how much gain reaches the target" answers "all of
 * it" during a pause between words, and the thing it then amplifies to full
 * scale is the receiver noise floor. The first version here did exactly that:
 * a 167 ms release and a ceiling of ten million, so a second of speech was
 * followed by a roar of white noise as soon as the speaker drew breath.
 *
 * Two things stop it. The gain is held for a hang time and then released
 * slowly, so short pauses do not move it at all; and it is bounded to a range
 * above whatever the loudest recent signal needed, so silence is quieter than
 * speech rather than louder. AGC_RANGE is that bound: 30 dB is enough to even
 * out fading without being enough to bring a noise floor up to a signal.
 */
#define AGC_TARGET   0.25f
#define AGC_ATTACK   0.20f      /* per sample, a few milliseconds */
#define AGC_RELEASE  5.6e-5f    /* per sample, about 1.5 seconds */
#define AGC_HANG     (AUDIO_RATE / 4)   /* quarter of a second */
#define AGC_RANGE    0.0316f    /* 30 dB below the loudest recent signal */
#define AGC_LOUD_DECAY 2.0e-5f  /* the "loudest recent" forgets over ~4 s */

struct agc {
    float peak;    /* what the gain is being set from */
    float loud;    /* the loudest recent signal, which bounds the gain */
    float gain;
    int hang;
    bool manual;
};

static void agc_init(struct agc *a, float manual_gain)
{
    memset(a, 0, sizeof(*a));
    a->peak = 1e-6f;
    a->loud = 1e-6f;
    a->gain = manual_gain > 0 ? manual_gain : 1.0f;
    a->manual = manual_gain > 0;
}

static float agc_run(struct agc *a, float x)
{
    if (a->manual) return x * a->gain;

    const float mag = fabsf(x);

    /* The loudest thing heard lately, forgotten slowly. */
    if (mag > a->loud) a->loud = mag;
    else a->loud += (mag - a->loud) * AGC_LOUD_DECAY;

    if (mag > a->peak) {
        a->peak += (mag - a->peak) * AGC_ATTACK;
        a->hang = AGC_HANG;
    } else if (a->hang > 0) {
        a->hang--;                    /* hold: a gap between words is not a fade */
    } else {
        a->peak += (mag - a->peak) * AGC_RELEASE;
    }

    /* Never take the gain further above what the loudest signal needed than
     * AGC_RANGE allows. This is the whole difference between a pause sounding
     * like silence and a pause sounding like noise. */
    float ref = a->peak;
    const float floor_ref = a->loud * AGC_RANGE;
    if (ref < floor_ref) ref = floor_ref;

    const float want = (ref > 1e-9f) ? (AGC_TARGET / ref) : 1.0f;
    a->gain += (want - a->gain) * 0.01f;

    float y = x * a->gain;
    if (y > 1.0f) y = 1.0f;
    if (y < -1.0f) y = -1.0f;
    return y;
}

/* ------------------------------------------------------------------------ */
/* Protocol 1 host side                                                      */
/* ------------------------------------------------------------------------ */

static int rate_to_bits(int khz)
{
    switch (khz) {
    case 48:  return 0;
    case 96:  return 1;
    case 192: return 2;
    case 384: return 3;
    default:  return -1;
    }
}

/* One EP2 command bank, sent as both frames of the packet. */
static void build_ep2(unsigned char *pkt, uint32_t seq,
                      unsigned char c0, unsigned char c1, unsigned char c2,
                      unsigned char c3, unsigned char c4)
{
    memset(pkt, 0, P1_USB_PACKET);
    pkt[0] = 0xEF; pkt[1] = 0xFE; pkt[2] = 0x01; pkt[3] = P1_EP2;
    pkt[4] = (unsigned char)(seq >> 24); pkt[5] = (unsigned char)(seq >> 16);
    pkt[6] = (unsigned char)(seq >> 8);  pkt[7] = (unsigned char)seq;
    for (int f = 0; f < 2; f++) {
        unsigned char *fr = pkt + 8 + (size_t)f * P1_FRAME;
        fr[0] = fr[1] = fr[2] = P1_SYNC;
        fr[3] = c0; fr[4] = c1; fr[5] = c2; fr[6] = c3; fr[7] = c4;
    }
}

static int32_t get24(const unsigned char *p)
{
    int32_t v = ((int32_t)p[0] << 16) | ((int32_t)p[1] << 8) | (int32_t)p[2];
    if (v & 0x800000) v -= 0x1000000;   /* sign-extend the 24-bit field */
    return v;
}

static double now_seconds(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* ------------------------------------------------------------------------ */
/* Protocol 2 host side                                                      */
/* ------------------------------------------------------------------------ */

static void put_be32(unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)(v >> 24); p[1] = (unsigned char)(v >> 16);
    p[2] = (unsigned char)(v >> 8);  p[3] = (unsigned char)v;
}

static void p2_send(int sock, struct sockaddr_in radio, int port,
                    const unsigned char *b, size_t n)
{
    radio.sin_port = htons((uint16_t)port);
    sendto(sock, b, n, 0, (const struct sockaddr *)&radio, sizeof(radio));
}

/*
 * The frequency of each DDC: the first is the one asked for, and any more --
 * there only to load the bridge -- step up from it 100 kHz at a time, folded
 * back into the receiver's range so none is asked for beyond 30 MHz.
 */
static uint32_t p2_ddc_freq(long freq, int ddc)
{
    long f = freq + 100000L * ddc;
    while (f > 30000000L) f -= 29000000L;
    return (uint32_t)f;
}

/* The high-priority packet: run, and each DDC's frequency in Hz. Sent to start
 * and stop the stream and, between, as the keepalive. */
static void p2_high_priority(int sock, struct sockaddr_in radio, uint32_t seq,
                             bool run, long freq, int nrx)
{
    unsigned char b[P2_CONTROL_LEN];
    memset(b, 0, sizeof(b));
    put_be32(b, seq);
    b[4] = run ? 1 : 0;
    for (int i = 0; i < nrx; i++) put_be32(b + 9 + 4 * i, p2_ddc_freq(freq, i));
    p2_send(sock, radio, P2_PORT_HIGH_PRIO, b, sizeof(b));
}

/* ------------------------------------------------------------------------ */
/* Finding radios                                                            */
/* ------------------------------------------------------------------------ */

#define MAX_RADIOS 16
#define P1_REPLY_LEN 60

struct radio {
    struct sockaddr_in addr;
    unsigned char mac[6];
    int status;      /* 2 idle, 3 already streaming to somebody */
    int gateware;
    int board;
    int receivers;
};

static const char *board_name(int id)
{
    switch (id) {
    case 0:  return "Metis";
    case 1:  return "Hermes";
    case 2:  return "Griffin";
    case 4:  return "Angelia";
    case 5:  return "Orion";
    case 6:  return "Hermes Lite";
    default: return "unknown";
    }
}

static void print_radio(int i, const struct radio *r)
{
    printf("  [%d] %-15s %02x:%02x:%02x:%02x:%02x:%02x  %s, gateware %d, "
           "%d receiver%s  %s\n",
           i, inet_ntoa(r->addr.sin_addr),
           r->mac[0], r->mac[1], r->mac[2], r->mac[3], r->mac[4], r->mac[5],
           board_name(r->board), r->gateware,
           r->receivers, r->receivers == 1 ? "" : "s",
           r->status == 0x03 ? "(streaming)" : "(idle)");
}

/*
 * Sweep for radios.
 *
 * Broadcast when no host was named, because a radio is normally somewhere on
 * the network rather than at an address the operator already knows. The sweep
 * goes to the global broadcast address and to each interface's own, since a
 * host with several networks sends a global broadcast out only one of them and
 * the radio is as likely to be on any of the others.
 *
 * Replies are gathered for a fixed window rather than stopping at the first,
 * so several radios are all found and the operator picks; stopping early would
 * make which one you get depend on which answered fastest.
 */
static int discover(int sock, const struct sockaddr_in *only,
                    struct radio *out, int max, int protocol)
{
    /* Each protocol has its own request, to the same port: protocol 1's opens
     * EF FE 02, protocol 2's is sixty bytes with only byte 4 set. A radio
     * answers in the protocol it was asked in. */
    unsigned char req[63];
    size_t reqlen = sizeof(req);
    memset(req, 0, sizeof(req));
    if (protocol == 1) {
        req[0] = 0xEF; req[1] = 0xFE; req[2] = 0x02;
    } else {
        req[4] = 0x02;
        reqlen = P2_DISCOVERY_LEN;
    }

    if (only) {
        sendto(sock, req, reqlen, 0, (const struct sockaddr *)only, sizeof(*only));
    } else {
        struct sockaddr_in b;
        memset(&b, 0, sizeof(b));
        b.sin_family = AF_INET;
        b.sin_port = htons(P1_PORT);
        b.sin_addr.s_addr = INADDR_BROADCAST;
        sendto(sock, req, reqlen, 0, (struct sockaddr *)&b, sizeof(b));

        struct ifconf ifc;
        char ifbuf[8192];
        ifc.ifc_len = sizeof(ifbuf);
        ifc.ifc_buf = ifbuf;
        if (ioctl(sock, SIOCGIFCONF, &ifc) == 0) {
            const int n = ifc.ifc_len / (int)sizeof(struct ifreq);
            for (int i = 0; i < n; i++) {
                struct ifreq r = ifc.ifc_req[i];
                if (ioctl(sock, SIOCGIFBRDADDR, &r) != 0) continue;
                struct sockaddr_in *ba = (struct sockaddr_in *)&r.ifr_broadaddr;
                if (ba->sin_family != AF_INET) continue;
                ba->sin_port = htons(P1_PORT);
                sendto(sock, req, reqlen, 0, (struct sockaddr *)ba, sizeof(*ba));
            }
        }
        /* Loopback takes neither broadcast, and a bridge on this machine is
         * the commonest case while testing. */
        struct sockaddr_in lo;
        memset(&lo, 0, sizeof(lo));
        lo.sin_family = AF_INET;
        lo.sin_port = htons(P1_PORT);
        lo.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        sendto(sock, req, reqlen, 0, (struct sockaddr *)&lo, sizeof(lo));
    }

    int nfound = 0;
    const double until = now_seconds() + 1.2;
    struct pollfd pfd = { .fd = sock, .events = POLLIN };
    while (nfound < max) {
        const double left = until - now_seconds();
        if (left <= 0) break;
        if (poll(&pfd, 1, (int)(left * 1000)) <= 0) continue;

        unsigned char b[2048];
        struct sockaddr_in from;
        socklen_t flen = sizeof(from);
        const ssize_t n = recvfrom(sock, b, sizeof(b), 0,
                                   (struct sockaddr *)&from, &flen);
        const unsigned char *mac;
        int status, gateware, board, receivers;
        if (protocol == 1) {
            if (n < P1_REPLY_LEN || b[0] != 0xEF || b[1] != 0xFE) continue;
            if (b[2] != 0x02 && b[2] != 0x03) continue;   /* not a discovery reply */
            mac = b + 3; status = b[2]; gateware = b[9]; board = b[10]; receivers = b[19];
        } else {
            /* Sequence zero, status 2 idle or 3 running, MAC at 5, board at
             * 11, firmware at 13, receivers at 20. */
            if (n < P2_DISCOVERY_LEN || b[0] || b[1] || b[2] || b[3]) continue;
            if (b[4] != 0x02 && b[4] != 0x03) continue;
            mac = b + 5; status = b[4]; gateware = b[13]; board = b[11]; receivers = b[20];
        }

        /*
         * Deduplicated by MAC, not by address. A radio bound to every
         * interface answers the sweep once per route it can be reached by —
         * a bridge on this machine turns up as 127.0.0.1 and as each local
         * address — and listing one radio three times invites picking the
         * route rather than the radio. The MAC is what identifies it; the
         * first address that answered is the one that works.
         */
        bool dup = false;
        for (int i = 0; i < nfound; i++)
            if (memcmp(out[i].mac, mac, 6) == 0) dup = true;
        if (dup) continue;

        struct radio *r = &out[nfound++];
        memset(r, 0, sizeof(*r));
        r->addr = from;
        r->addr.sin_port = htons(P1_PORT);
        memcpy(r->mac, mac, 6);
        r->status = status;
        r->gateware = gateware;
        r->board = board;
        r->receivers = receivers ? receivers : 1;
    }
    return nfound;
}

/* ------------------------------------------------------------------------ */

enum demod { MODE_USB, MODE_LSB, MODE_AM, MODE_IQ };

static void usage(const char *prog)
{
    printf("Usage: %s [options]\n\n", prog);
    printf("  --host ADDR       address of one radio; omit to sweep the network\n");
    printf("  --radio N         pick the Nth radio found, instead of being asked\n");
    printf("  --discover        list the radios found and exit\n");
    printf("  --protocol N      1 or 2 (default 1)\n");
    printf("  --receivers N     protocol 2 only: run N DDCs at once, 1-%d (default 1).\n", P2_MAX_RX);
    printf("                    The first is the one demodulated and recorded; the\n");
    printf("                    rest, 100 kHz apart, are counted, to load the bridge\n");
    printf("                    the way a multi-receiver client does.\n");
    printf("  --freq HZ         tune the receiver (default 909000)\n");
    printf("  --rate KHZ        48, 96, 192 or 384 (default 192)\n");
    printf("  --mode MODE       usb, lsb, am or iq (default am)\n");
    printf("  --bandwidth HZ    audio passband width: %d for SSB, %d for AM by\n",
           (int)DEFAULT_BW_SSB, (int)DEFAULT_BW_AM);
    printf("                    default, up to %d. Ignored in iq mode.\n", (int)MAX_BW);
    printf("                    SSB runs --low to --low+bandwidth; AM is 0 to\n");
    printf("                    bandwidth, which is half the RF width.\n");
    printf("  --low HZ          SSB low cut (default %d)\n", (int)DEFAULT_SSB_LOW);
    printf("  --play            play the audio (through aplay by default)\n");
    printf("  --player CMD      use a different player\n");
    printf("  --wav FILE        record the demodulated audio, 16-bit %d Hz mono\n", AUDIO_RATE);
    printf("  --iq-wav FILE     record the raw I/Q instead, 16-bit stereo at the DDC rate\n");
    printf("  --seconds N       stop after N seconds (default: until interrupted)\n");
    printf("  --gain G          fixed audio gain, disabling the AGC\n");
    printf("  --quiet           no periodic statistics\n");
    printf("\nExamples:\n");
    printf("  %s --freq 909000 --mode am --play\n", prog);
    printf("  %s --freq 7100000 --mode lsb --rate 192 --wav lsb.wav --seconds 30\n", prog);
    printf("  %s --rate 384 --mode iq --iq-wav iq384.wav --seconds 10\n", prog);
    printf("  %s --discover\n", prog);
    printf("  %s --protocol 2 --receivers 10 --rate 192 --mode iq --iq-wav ddc0.wav --seconds 60\n", prog);
}

int main(int argc, char **argv)
{
    const char *host = NULL;      /* NULL means "sweep the network" */
    int radio_index = -1;
    const char *player = "aplay -q -f S16_LE -r 12000 -c 1 -t raw -";
    const char *wav_path = NULL, *iqwav_path = NULL;
    long freq = 909000;
    int rate_khz = 192;
    enum demod mode = MODE_AM;
    bool do_play = false, discover_only = false, quiet = false;
    double seconds = 0;
    float manual_gain = 0;
    double bandwidth = 0;            /* 0 means "the default for this mode" */
    double ssb_low = DEFAULT_SSB_LOW;
    int protocol = 1;
    int nrx = 1;

    static struct option opts[] = {
        {"host",     required_argument, 0, 'H'},
        {"radio",    required_argument, 0, 'R'},
        {"discover", no_argument,       0, 'D'},
        {"protocol", required_argument, 0, 'X'},
        {"receivers",required_argument, 0, 'N'},
        {"freq",     required_argument, 0, 'f'},
        {"rate",     required_argument, 0, 'r'},
        {"mode",     required_argument, 0, 'm'},
        {"bandwidth",required_argument, 0, 'b'},
        {"low",      required_argument, 0, 'l'},
        {"play",     no_argument,       0, 'p'},
        {"player",   required_argument, 0, 'P'},
        {"wav",      required_argument, 0, 'w'},
        {"iq-wav",   required_argument, 0, 'W'},
        {"seconds",  required_argument, 0, 's'},
        {"gain",     required_argument, 0, 'g'},
        {"quiet",    no_argument,       0, 'q'},
        {"help",     no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int c;
    while ((c = getopt_long(argc, argv, "H:R:DX:N:f:r:m:b:l:pP:w:W:s:g:qh", opts, NULL)) != -1) {
        switch (c) {
        case 'H': host = optarg; break;
        case 'R': radio_index = atoi(optarg); break;
        case 'D': discover_only = true; break;
        case 'X': protocol = atoi(optarg); break;
        case 'N': nrx = atoi(optarg); break;
        case 'f': freq = atol(optarg); break;
        case 'r': rate_khz = atoi(optarg); break;
        case 'p': do_play = true; break;
        case 'P': player = optarg; do_play = true; break;
        case 'w': wav_path = optarg; break;
        case 'W': iqwav_path = optarg; break;
        case 's': seconds = atof(optarg); break;
        case 'g': manual_gain = (float)atof(optarg); break;
        case 'b': bandwidth = atof(optarg); break;
        case 'l': ssb_low = atof(optarg); break;
        case 'q': quiet = true; break;
        case 'm':
            if      (!strcasecmp(optarg, "usb")) mode = MODE_USB;
            else if (!strcasecmp(optarg, "lsb")) mode = MODE_LSB;
            else if (!strcasecmp(optarg, "am"))  mode = MODE_AM;
            else if (!strcasecmp(optarg, "iq"))  mode = MODE_IQ;
            else { fprintf(stderr, "unknown mode '%s'\n", optarg); return 2; }
            break;
        case 'h': usage(argv[0]); return 0;
        default:  usage(argv[0]); return 2;
        }
    }

    if (bandwidth <= 0)
        bandwidth = (mode == MODE_AM) ? DEFAULT_BW_AM : DEFAULT_BW_SSB;
    if (mode != MODE_IQ) {
        /* The audio rate is what bounds this: the passband has to fit under
         * Nyquist with room for the filter's skirt, and everything above
         * MAX_BW was already removed by the decimation chain that produced
         * these samples, so allowing more would only promise what is not
         * there. */
        if (bandwidth > MAX_BW) {
            fprintf(stderr, "--bandwidth %.0f is beyond the %.0f Hz this client "
                            "produces at %d Hz audio\n", bandwidth, MAX_BW, AUDIO_RATE);
            return 2;
        }
        if (ssb_low < 0 || (mode != MODE_AM && ssb_low + bandwidth > MAX_BW)) {
            fprintf(stderr, "--low %.0f plus --bandwidth %.0f exceeds %.0f Hz\n",
                    ssb_low, bandwidth, MAX_BW);
            return 2;
        }
    }

    if (protocol != 1 && protocol != 2) {
        fprintf(stderr, "--protocol must be 1 or 2\n");
        return 2;
    }
    if (nrx < 1 || nrx > P2_MAX_RX || (protocol == 1 && nrx != 1)) {
        fprintf(stderr, "--receivers is 1-%d, and protocol 2 only\n", P2_MAX_RX);
        return 2;
    }

    const int speed_bits = rate_to_bits(rate_khz);
    if (speed_bits < 0) {
        fprintf(stderr, "--rate must be 48, 96, 192 or 384\n");
        return 2;
    }
    if (!do_play && !wav_path && !iqwav_path && !discover_only) {
        fprintf(stderr, "nothing to do: give --play, --wav or --iq-wav\n");
        return 2;
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);   /* the player exiting must not kill this */

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) { perror("socket"); return 1; }
    int yes = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    /* The stream is 25 Mbit/s at 384 kHz; the default receive buffer drops
     * packets at that rate and the loss looks exactly like a bridge fault. */
    int rcvbuf = 4 * 1024 * 1024;
    setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));

    struct sockaddr_in dst;
    memset(&dst, 0, sizeof(dst));
    dst.sin_family = AF_INET;
    dst.sin_port = htons(P1_PORT);
    const bool host_given = (host != NULL);
    if (host_given && inet_pton(AF_INET, host, &dst.sin_addr) != 1) {
        fprintf(stderr, "bad --host '%s'\n", host);
        return 2;
    }

    /* Find the radios before streaming to one. */
    struct radio found[MAX_RADIOS];
    int nfound = discover(sock, host_given ? &dst : NULL, found, MAX_RADIOS, protocol);

    if (nfound == 0) {
        if (host_given)
            fprintf(stderr, "no reply from %s:%d — is the bridge running?\n", host, P1_PORT);
        else
            fprintf(stderr, "no radios answered on the network. Give --host if it is\n"
                            "somewhere a broadcast does not reach.\n");
        return 1;
    }

    printf("%d radio%s:\n", nfound, nfound == 1 ? "" : "s");
    for (int i = 0; i < nfound; i++) print_radio(i, &found[i]);

    if (discover_only) return 0;

    int chosen = 0;
    if (nfound > 1) {
        if (radio_index >= 0) {
            if (radio_index >= nfound) {
                fprintf(stderr, "--radio %d, but only %d were found\n", radio_index, nfound);
                return 2;
            }
            chosen = radio_index;
        } else if (isatty(STDIN_FILENO)) {
            /* Asked rather than guessed: picking one of several radios on
             * somebody's network is not a default this can get right. */
            char line[32];
            printf("which radio? [0-%d] ", nfound - 1);
            fflush(stdout);
            if (!fgets(line, sizeof(line), stdin)) return 1;
            chosen = atoi(line);
            if (chosen < 0 || chosen >= nfound) {
                fprintf(stderr, "no such radio\n");
                return 2;
            }
        } else {
            fprintf(stderr, "several radios found and no terminal to ask on; "
                            "use --radio N or --host\n");
            return 2;
        }
    } else if (radio_index > 0) {
        fprintf(stderr, "--radio %d, but only one was found\n", radio_index);
        return 2;
    }

    dst = found[chosen].addr;
    if (nrx > found[chosen].receivers) {
        fprintf(stderr, "--receivers %d, but radio %d offers %d\n", nrx, chosen, found[chosen].receivers);
        return 2;
    }
    if (found[chosen].status == 0x03)
        printf("note: radio %d reports a client already streaming; "
               "starting will take it over\n", chosen);

    /* Configure before starting, so the first samples are already at the rate
     * and frequency asked for rather than at whatever the bridge last used. */
    uint32_t seq = 0;
    unsigned char pkt[P1_USB_PACKET];
    unsigned char start[64];
    if (protocol == 1) {
        build_ep2(pkt, seq++, P1_C0_CONFIG, (unsigned char)speed_bits, 0, 0, 0);
        sendto(sock, pkt, sizeof(pkt), 0, (struct sockaddr *)&dst, sizeof(dst));
        build_ep2(pkt, seq++, P1_C0_RX1_FREQ,
                  (unsigned char)(freq >> 24), (unsigned char)(freq >> 16),
                  (unsigned char)(freq >> 8),  (unsigned char)freq);
        sendto(sock, pkt, sizeof(pkt), 0, (struct sockaddr *)&dst, sizeof(dst));

        memset(start, 0, sizeof(start));
        start[0] = 0xEF; start[1] = 0xFE; start[2] = 0x04; start[3] = 0x01;
        sendto(sock, start, sizeof(start), 0, (struct sockaddr *)&dst, sizeof(dst));
    } else {
        /* General: frequencies in raw Hz (byte 37's phase-word bit clear). */
        unsigned char g[P2_DISCOVERY_LEN];
        memset(g, 0, sizeof(g));
        p2_send(sock, dst, P2_PORT_GENERAL, g, sizeof(g));

        /* DDC-specific: the DDCs to run, and each one's rate in kHz. */
        unsigned char d[P2_CONTROL_LEN];
        memset(d, 0, sizeof(d));
        for (int i = 0; i < nrx; i++) {
            d[7 + i / 8] |= (unsigned char)(1 << (i % 8));
            d[18 + 6 * i] = (unsigned char)(rate_khz >> 8);
            d[19 + 6 * i] = (unsigned char)rate_khz;
        }
        p2_send(sock, dst, P2_PORT_DDC_SPEC, d, sizeof(d));

        p2_high_priority(sock, dst, seq++, true, freq, nrx);
    }

    printf("streaming (protocol %d", protocol);
    if (nrx > 1) printf(", %d DDCs, demodulating the first", nrx);
    printf("): %ld Hz, %d kHz, %s", freq, rate_khz,
           mode == MODE_USB ? "USB" : mode == MODE_LSB ? "LSB" :
           mode == MODE_AM  ? "AM"  : "raw I/Q");
    if (mode == MODE_AM)
        printf(", passband 0-%.0f Hz (%.1f kHz RF)", bandwidth, 2 * bandwidth / 1000.0);
    else if (mode != MODE_IQ)
        printf(", passband %.0f-%.0f Hz", ssb_low, ssb_low + bandwidth);
    printf("\n");

    /* One halving per factor of two between the DDC rate and the audio rate. */
    int stages = 0;
    for (int r = rate_khz * 1000; r > AUDIO_RATE; r /= 2) stages++;
    struct halfband dec[6];
    for (int i = 0; i < stages; i++) halfband_init(&dec[i]);

    struct ssb sideband;
    struct amfilt amlp;
    if (mode == MODE_USB || mode == MODE_LSB)
        ssb_init(&sideband, mode == MODE_USB, ssb_low, bandwidth);
    else if (mode == MODE_AM)
        am_init(&amlp, bandwidth);

    struct agc gain;
    agc_init(&gain, manual_gain);

    struct wav wav = {0}, iqwav = {0};
    if (wav_path && !wav_open(&wav, wav_path, AUDIO_RATE, 1)) {
        fprintf(stderr, "cannot write %s: %s\n", wav_path, strerror(errno));
        return 1;
    }
    if (iqwav_path && !wav_open(&iqwav, iqwav_path, rate_khz * 1000, 2)) {
        fprintf(stderr, "cannot write %s: %s\n", iqwav_path, strerror(errno));
        return 1;
    }
    FILE *audio = do_play ? popen(player, "w") : NULL;
    if (do_play && !audio) {
        fprintf(stderr, "cannot start the player: %s\n", strerror(errno));
        return 1;
    }

    /* DC blocker for AM: the envelope of an AM carrier is the audio riding on
     * a large constant, and the constant is not audio. */
    float dc = 0;

    struct pollfd pfd = { .fd = sock, .events = POLLIN };
    unsigned char buf[2048];

    const double t0 = now_seconds();
    double next_cc = t0, next_report = t0 + 5.0;
    uint32_t last_seq = 0;
    bool have_seq = false;
    long long packets = 0, lost = 0, samples = 0;
    double sumsq = 0;
    long peak24 = 0;
    int16_t out[4096];
    int nout = 0;
    int16_t iqout[2 * P2_SAMPLES_PER_PACKET];
    int32_t si[P2_SAMPLES_PER_PACKET], sq[P2_SAMPLES_PER_PACKET];

    /* Protocol 2's other DDCs: counted, not demodulated. */
    long long ddc_packets[P2_MAX_RX] = {0}, ddc_lost[P2_MAX_RX] = {0};
    uint32_t ddc_seq[P2_MAX_RX] = {0};
    bool ddc_have[P2_MAX_RX] = {false};

    while (!stop_now) {
        const double t = now_seconds();
        if (seconds > 0 && t - t0 >= seconds) break;

        /* The bridge stops sending to a client that goes quiet, so a control
         * packet doubles as the keepalive: in protocol 1 the command bank,
         * which real client software sends continuously because it is also
         * the transmit audio stream; in protocol 2 the high-priority packet. */
        if (t >= next_cc) {
            if (protocol == 1) {
                build_ep2(pkt, seq++, P1_C0_CONFIG, (unsigned char)speed_bits, 0, 0, 0);
                sendto(sock, pkt, sizeof(pkt), 0, (struct sockaddr *)&dst, sizeof(dst));
                next_cc = t + 0.05;
            } else {
                p2_high_priority(sock, dst, seq++, true, freq, nrx);
                next_cc = t + 0.1;
            }
        }

        if (poll(&pfd, 1, 20) <= 0) continue;
        struct sockaddr_in from;
        socklen_t flen = sizeof(from);
        ssize_t n = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&from, &flen);

        /* Each protocol fills si/sq; everything after is the same. */
        int niq = 0;
        uint32_t s;
        if (protocol == 1) {
            if (n < P1_USB_PACKET) continue;
            if (buf[0] != 0xEF || buf[1] != 0xFE || buf[3] != P1_EP6) continue;
            s = ((uint32_t)buf[4] << 24) | ((uint32_t)buf[5] << 16) |
                ((uint32_t)buf[6] << 8)  |  (uint32_t)buf[7];
            for (int f = 0; f < 2; f++) {
                const unsigned char *fr = buf + 8 + (size_t)f * P1_FRAME;
                if (fr[0] != P1_SYNC || fr[1] != P1_SYNC || fr[2] != P1_SYNC) continue;
                const unsigned char *round = fr + 8;
                for (int r = 0; r < P1_ROUNDS_PER_FRAME; r++, round += P1_ROUND_BYTES) {
                    si[niq] = get24(round);
                    sq[niq] = get24(round + 3);
                    niq++;
                }
            }
        } else {
            const int ddc = ntohs(from.sin_port) - P2_PORT_DDC0;
            if (n < P2_IQ_PACKET || ddc < 0 || ddc >= nrx) continue;
            s = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16) |
                ((uint32_t)buf[2] << 8)  |  (uint32_t)buf[3];
            if (ddc_have[ddc] && s != ddc_seq[ddc] + 1)
                ddc_lost[ddc] += (long long)(s - ddc_seq[ddc] - 1);
            ddc_seq[ddc] = s;
            ddc_have[ddc] = true;
            ddc_packets[ddc]++;
            if (ddc != 0) continue;
            /* I then Q, 24-bit big-endian, 238 to a packet. */
            const unsigned char *iq = buf + P2_IQ_HEADER;
            for (; niq < P2_SAMPLES_PER_PACKET; niq++, iq += 6) {
                si[niq] = get24(iq);
                sq[niq] = get24(iq + 3);
            }
        }

        if (have_seq && s != last_seq + 1) lost += (long long)(s - last_seq - 1);
        last_seq = s;
        have_seq = true;
        packets++;

        for (int k = 0; k < niq; k++) {
            const int32_t i24 = si[k];
            const int32_t q24 = sq[k];
            if (labs(i24) > peak24) peak24 = labs(i24);
            sumsq += (double)i24 * i24;
            samples++;

            if (iqwav.f) {
                /* The 24-bit field into 16 bits, which is what a WAV can
                 * carry: the low eight bits are below the level anything
                 * here resolves anyway. */
                iqout[2 * k]     = (int16_t)(i24 >> 8);
                iqout[2 * k + 1] = (int16_t)(q24 >> 8);
            }

            if (mode == MODE_IQ) continue;

            float complex z = ((float)i24 + I * (float)q24) / 8388608.0f;
            bool alive = true;
            for (int st = 0; st < stages && alive; st++)
                alive = halfband_run(&dec[st], z, &z);
            if (!alive) continue;

            float a;
            if (mode == MODE_AM) {
                /*
                 * Envelope detection, then normalised by the carrier.
                 *
                 * The carrier is what the envelope of an AM signal rides
                 * on, and it is not audio, so it has to come out. Dividing
                 * by it rather than only subtracting it is what makes the
                 * result modulation depth — the same audio whether the
                 * station is strong or weak, and, which is the point here,
                 * silence during a pause. Subtracting alone leaves a
                 * near-zero signal that an AGC is then free to mistake for
                 * a fade and amplify.
                 */
                const float mag = cabsf(am_run(&amlp, z));
                dc += (mag - dc) * 0.001f;
                a = (mag - dc) / fmaxf(dc, 1e-6f);
                if (a >  2.0f) a =  2.0f;
                if (a < -2.0f) a = -2.0f;
            } else {
                a = ssb_run(&sideband, z);
            }
            a = agc_run(&gain, a);

            out[nout++] = (int16_t)lrintf(a * 32767.0f);
            if (nout == (int)(sizeof(out) / sizeof(out[0]))) {
                if (audio) { fwrite(out, 2, (size_t)nout, audio); fflush(audio); }
                wav_write(&wav, out, nout);
                nout = 0;
            }
        }
        if (iqwav.f && niq) wav_write(&iqwav, iqout, 2 * niq);

        if (!quiet && t >= next_report) {
            const double el = t - t0;
            const double sps = samples / el;
            printf("  %6.1fs  %8.0f samples/s (%.4f of %d)  lost %lld  "
                   "level RMS %.0f peak %ld\n",
                   el, sps, sps / (rate_khz * 1000.0), rate_khz * 1000,
                   lost, sqrt(sumsq / (double)(samples ? samples : 1)), peak24);
            fflush(stdout);
            next_report = t + 5.0;
        }
    }

    if (nout) {
        if (audio) fwrite(out, 2, (size_t)nout, audio);
        wav_write(&wav, out, nout);
    }

    if (protocol == 1) {
        memset(start, 0, sizeof(start));
        start[0] = 0xEF; start[1] = 0xFE; start[2] = 0x04; start[3] = 0x00;
        sendto(sock, start, sizeof(start), 0, (struct sockaddr *)&dst, sizeof(dst));
    } else {
        p2_high_priority(sock, dst, seq++, false, freq, nrx);
    }

    if (audio) pclose(audio);
    wav_close(&wav);
    wav_close(&iqwav);
    close(sock);

    const double el = now_seconds() - t0;
    printf("\nstopped after %.1fs: %lld packets, %lld samples, %lld lost\n",
           el, packets, samples, lost);
    if (samples)
        printf("  delivered %.0f samples/s against %d asked for (%.4f)\n",
               samples / el, rate_khz * 1000, (samples / el) / (rate_khz * 1000.0));
    if (nrx > 1) {
        long long all = 0, all_lost = 0;
        for (int i = 0; i < nrx; i++) {
            printf("  DDC%d %8.3f MHz: %lld packets (%.0f samples/s), %lld lost\n", i,
                   p2_ddc_freq(freq, i) / 1e6, ddc_packets[i],
                   ddc_packets[i] * (double)P2_SAMPLES_PER_PACKET / el, ddc_lost[i]);
            all += ddc_packets[i];
            all_lost += ddc_lost[i];
        }
        printf("  all %d DDCs: %lld packets (%.0f/s), %lld lost\n", nrx, all, all / el, all_lost);
    }
    if (wav_path)   printf("  wrote %s\n", wav_path);
    if (iqwav_path) printf("  wrote %s\n", iqwav_path);
    return 0;
}
