/*
 * hpsdr_p1.h — openHPSDR protocol 1 ("Metis") client-facing layer.
 *
 * WHY THIS EXISTS
 *
 * ka9q_hpsdr.c is a protocol 2 server. Protocol 1 is a different wire format at
 * every layer — discovery packet, command transport, data framing and ports —
 * so a client that speaks one is invisible to a server that speaks the other.
 * A Hermes Lite 2 is a protocol 1 board, so anything written against real HL2
 * hardware looks for protocol 1 and finds nothing here.
 *
 * The two coexist rather than fork. Everything below the client-facing layer —
 * the WebSocket to UberSDR, the version 4 decoder, the tuning range, the
 * reconnect and rate handling — has no idea which protocol is on the other
 * side, and duplicating roughly 1500 lines of it into a second bridge would
 * mean fixing every future bug twice. So this file is only the parts that
 * differ, and it drives the same receiver control blocks the protocol 2 threads
 * do.
 *
 * They cannot run at once: both would be writing the same rcb[] and a real
 * radio cannot serve two clients either. Whichever protocol issues a run
 * command claims the bridge until it goes idle.
 *
 * WHAT IS ON THE WIRE
 *
 * Everything is UDP on port 1024, which the bridge already binds.
 *
 *   host -> radio
 *     EF FE 02 + zeros            63 bytes   discovery request
 *     EF FE 04 <cmd>              64 bytes   run/stop; cmd bit 0 streams EP6
 *     EF FE 01 02 seq[4] + 2x512  1032       EP2, command and control
 *
 *   radio -> host
 *     60-byte discovery reply, and EP6:
 *     EF FE 01 06 seq[4] + 2x512  1032
 *
 * A 512-byte frame is `7F 7F 7F` then five command bytes C0..C4 then 504 bytes
 * of payload. On EP6 the payload is a sequence of ROUNDS, each carrying one
 * sample from every active receiver followed by a two-byte mic word:
 *
 *     [ I(3) Q(3) ] x numRx | mic(2)
 *
 * so a round is 6*numRx+2 bytes, whole rounds only, and the tail of the frame
 * is zero padding rather than samples.
 *
 * PHASE 1 SERVES ONE RECEIVER, which is what the discovery reply advertises and
 * what a conforming client clamps itself to. At one receiver a round is 8 bytes
 * and 504 divides by it exactly: 63 rounds a frame, 126 samples a packet. More
 * than one is not a framing problem but an alignment one — protocol 1
 * interleaves every receiver into one packet, and ours are independent
 * WebSockets that drift — and it needs a policy for a starved receiver rather
 * than a bigger buffer.
 *
 * The facts above are grounded in openHPSDR protocol 1, the Hermes Lite 2
 * gateware register map, and the AetherSDR client this was built to satisfy.
 */

#ifndef UBERSDR_HPSDR_P1_H
#define UBERSDR_HPSDR_P1_H

#include <netinet/in.h>
#include <stdbool.h>

struct rcvr_cb;

/* Samples per receiver in one EP6 packet, at the one receiver phase 1 serves. */
#define P1_SAMPLES_PER_PACKET 126

/*
 * Offer one datagram from port 1024 to the protocol 1 layer.
 *
 * Returns true when it was a protocol 1 packet and has been dealt with, so the
 * caller stops looking at it. Anything else is left alone for the protocol 2
 * paths — the two formats cannot be confused, since every protocol 1 packet
 * starts EF FE and every protocol 2 one starts with four zero bytes.
 */
bool p1_handle_datagram(int sock, const unsigned char *buf, int len,
                        const struct sockaddr_in *from);

/* Is a protocol 1 client streaming? While true the protocol 2 threads stand
 * down and the receive path emits EP6 instead of protocol 2 IQ packets. */
bool p1_active(void);

/*
 * Pack and send one EP6 packet from a receiver's decoded IQ.
 *
 * Called from the WebSocket thread as samples accumulate, which is also what
 * paces it: the radio's own sample clock is the UberSDR stream, so there is no
 * timer here and nothing to drift against.
 */
void p1_send_packet(struct rcvr_cb *rcb);

/* Stop streaming if the client has gone quiet, mirroring what a real radio's
 * watchdog does. Called from the same place the protocol 2 watchdog runs. */
void p1_check_watchdog(void);

/*
 * The receiver plumbing this layer drives, implemented by ka9q_hpsdr.c.
 *
 * Declared as an interface rather than reached for directly so the coupling
 * runs one way: protocol 1 asks the bridge for things, and the bridge knows
 * nothing about protocol 1 beyond handing it datagrams.
 */
void p1_host_set_rate(int rcvr, int rate_hz);
void p1_host_set_freq(int rcvr, long hz);
void p1_host_enable(int rcvr, bool on);
void p1_host_stop_all(void);
bool p1_host_p2_busy(void);
const unsigned char *p1_host_mac(void);
int p1_host_board_type(void);

#endif /* UBERSDR_HPSDR_P1_H */
