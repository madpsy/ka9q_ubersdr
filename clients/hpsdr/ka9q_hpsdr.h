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
#include <zstd.h>
#include <libwebsockets.h>

#define HERMES_FW_VER 18
#define MAX_BUFFER_LEN 2048
#define HPSDR_FRAME_LEN 1032
#define IQ_FRAME_DATA_LEN 63
#define IQ_BUF_COUNT 1024
#define MAX_RCVRS 10
#define MAX_PRGMS 2
#define MAXSTR 128
#define HERMES 1
#define HERMES_LITE 6
#define MIN(x, y) (((x) < (y)) ? (x) : (y))

/* PCM binary protocol magic bytes (little-endian uint16) */
#define PCM_MAGIC_FULL    0x5043  /* "PC" — full 37-byte header  */
#define PCM_MAGIC_MINIMAL 0x504D  /* "PM" — minimal 13-byte header */
#define PCM_FULL_HEADER_SIZE    37
#define PCM_MINIMAL_HEADER_SIZE 13

/* WebSocket receive buffer — large enough for a full iq192 frame */
#define WS_RX_BUF_SIZE (128 * 1024)

struct main_cb {
    u_int rcvrs_mask;
    int nsamps_packet;

    int wideband;
    int num_rxs;
    int device_type;            /* 1=Hermes, 6=HermesLite (default 6) */
    char interface[15];
    char ip[16];
    char ubersdr_url[256];      /* e.g. "http://localhost:8080" */
    char ubersdr_password[64];  /* optional */

    struct rcvr_cb {
        int rcvr_num;
        u_int err_count;
        int new_freq;
        int curr_freq;
        int output_rate;
        u_int rcvr_mask;
        float scale;
        int reconnect_needed;   /* set by ws_callback on rate change / error */
        int wsi_closed;         /* set by ws_callback when wsi is fully closed */
        struct main_cb* mcb;

        char session_id[37];    /* UUID v4 string */

        /* zstd decompression context — one per receiver */
        ZSTD_DCtx *zstd_dctx;

        /* last PCM full-header values (reused for minimal-header packets) */
        int last_sample_rate;
        int last_channels;

        /* raw receive buffer for WebSocket frames */
        uint8_t ws_rx_buf[WS_RX_BUF_SIZE];

        int iqSample_offset;
        int iqSamples_remaining;
        float complex iqSamples[IQ_BUF_COUNT + IQ_FRAME_DATA_LEN * 2];
    } rcb[MAX_RCVRS];
};

void load_packet(struct rcvr_cb* rcb);
void sdr_sighandler(int signum);
void hpsdrsim_stop_threads(void);
int new_protocol_running(void);
void new_protocol_general_packet(unsigned char *buffer);
void generate_uuid(char *buf);
bool check_ubersdr_connection(const char *url);

//
// message printing
//
#include <stdarg.h>
void t_print(const char *format, ...);
void t_perror(const char *string);

#endif // _KA9Q_HPSDR_H
