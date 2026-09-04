#ifndef _KA9Q_HPSDR_H
#define _KA9Q_HPSDR_H

/* Copyright (C)
*
*   11/2025 - Rick Koch, N1GP
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

#include <sched.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <errno.h>
#include <stdio.h>
#include <stdbool.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <termios.h>
#include <libgen.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <netdb.h>
#include <complex.h>
#include <sys/wait.h>
#include <spawn.h>
#include <dirent.h>
#include <ifaddrs.h>
#include <getopt.h>
#include <ctype.h>

#include <uuid/uuid.h>
#include "pcm_v4.h"
#include <libwebsockets.h>

#define HERMES_FW_VER 18
#define MAX_BUFFER_LEN 2048
#define MAX_RCVRS 10
#define MAX_PRGMS 2
#define HERMES_LITE 6

/* PCM binary protocol magic bytes (little-endian uint16) */
#define PCM_MAGIC_FULL    0x5043  /* "PC" — full 37-byte header  */
#define PCM_MAGIC_MINIMAL 0x504D  /* "PM" — minimal 13-byte header */
#define PCM_FULL_HEADER_SIZE    37
#define PCM_MINIMAL_HEADER_SIZE 13

/* WebSocket receive buffer — large enough for a full iq192 frame */
#define WS_RX_BUF_SIZE (128 * 1024)

/*
 * IQ accumulation buffer, in complex samples.
 * Must hold the largest possible decoded PCM frame (WS_RX_BUF_SIZE / 4
 * bytes-per-complex-sample = 32768 samples) plus up to one HPSDR packet
 * (238 samples) of leftover from the previous frame, so that a frame can
 * be appended at any fill level without overflow or truncation.
 */
#define IQ_RING_SAMPLES ((WS_RX_BUF_SIZE / 4) + 256)

struct main_cb {
    int wideband;
    int debug;
    int num_rxs;
    int device_type;            /* 1=Hermes, 6=HermesLite (default 6) */
    char interface[15];
    char ip[16];
    char ubersdr_url[256];      /* e.g. "http://localhost:8080" */
    char ubersdr_password[64];  /* optional */

    /* Reduced-depth IQ, in dB of margin under the band's own noise floor, or 0
     * for the lossless stream every client gets by default. Not a bit depth:
     * the server works out per packet how many bits that margin needs, which is
     * what makes the same request mean the same thing on a dead 6 m band and on
     * medium wave. Travels as min_margin in the WebSocket query string; a
     * server that has never heard of it simply sends the lossless stream. */
    int min_margin;

    struct rcvr_cb {
        int rcvr_num;
        int new_freq;
        int curr_freq;
        int output_rate;
        u_int rcvr_mask;
        float scale;
        int reconnect_needed;   /* set by ws_callback on rate change / error */
        int wsi_closed;         /* set by ws_callback when wsi is fully closed */
        struct main_cb* mcb;

        char session_id[37];    /* UUID v4 string */

        /* Protocol version 4 packet decoder — one per receiver, because each
         * has its own WebSocket and the decoder IS that stream: its predictor
         * taps carry the adaptation of every sample decoded on it so far.
         * Reset when the socket reconnects, since the server builds a fresh
         * encoder for a fresh socket, and fed every packet that arrives. */
        struct pcmv4_stream pcm;

        /* last PCM full-header values (reused for minimal-header packets) */
        int last_sample_rate;
        int last_channels;

        /* Last status the server reported, so the same one is not logged again.
         * It sends one after every tune, which is every time the operator moves
         * the dial. */
        int  last_status_rate;
        char last_status_mode[16];

        /* raw receive buffer for WebSocket frames */
        uint8_t ws_rx_buf[WS_RX_BUF_SIZE];

        /* Binary bytes taken off this receiver's WebSocket since the throughput
         * reporter last looked. Written by the socket's thread and read-and-
         * cleared by the reporter, so both ends go through the relaxed atomic
         * builtins: nothing is ordered against it, but a torn 64-bit count read
         * as a fraction of a second's traffic would report nonsense. */
        unsigned long long ws_bytes;

        int iqSample_offset;
        int iqSamples_remaining;
        float complex iqSamples[IQ_RING_SAMPLES];
    } rcb[MAX_RCVRS];
};

void load_packet(struct rcvr_cb* rcb);
void sdr_sighandler(int signum);
void new_protocol_general_packet(unsigned char *buffer);
void generate_uuid(char *buf);
bool check_ubersdr_connection(const char *url);

/* How far the receiver tunes, read from /api/description at startup. Defaults
 * to 10 kHz - 30 MHz, which is what this bridge assumed before the span became
 * configurable. */
extern long ubersdr_min_freq;
extern long ubersdr_max_freq;
void fetch_ubersdr_tuning_range(const char *url);

//
// message printing
//
#include <stdarg.h>
void t_print(const char *format, ...);
void t_perror(const char *string);

#endif // _KA9Q_HPSDR_H
