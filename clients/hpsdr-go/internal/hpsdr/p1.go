package hpsdr

import (
	"encoding/binary"
	"net"
	"sync"
	"time"
)

// Protocol 1 ("Metis")
// ====================
//
// A Hermes Lite 2 is a protocol 1 board, so software written against real HL2
// hardware looks for protocol 1 and finds nothing on a protocol-2-only server.
// This is only the part that differs; the WebSocket, decoder, tuning range and
// reconnect handling underneath have no idea which protocol is on the other
// side.
//
// Everything is UDP on the discovery port:
//
//	host -> radio
//	  EF FE 02 + zeros            63 bytes   discovery request
//	  EF FE 04 <cmd>              64 bytes   run/stop; cmd bit 0 streams EP6
//	  EF FE 01 02 seq[4] + 2x512  1032       EP2, command and control
//	radio -> host
//	  60-byte discovery reply, and EP6:
//	  EF FE 01 06 seq[4] + 2x512  1032
//
// A 512-byte frame is 7F 7F 7F, five command bytes C0..C4, then 504 bytes of
// payload. On EP6 the payload is rounds of one sample from every receiver and
// a two-byte mic word: [I(3) Q(3)] x numRx | mic(2).
//
// ONE RECEIVER is served, which is what the discovery reply advertises and what
// a conforming client clamps itself to. At one receiver a round is 8 bytes and
// 504 divides by it exactly: 63 rounds a frame, 126 samples a packet. More is
// not a framing problem but an alignment one -- protocol 1 interleaves every
// receiver into one packet, and ours are independent WebSockets that drift.

const (
	p1USBPacket    = 1032
	p1Frame        = 512
	p1FramePayload = 504
	p1Sync         = 0x7F
	p1EP2          = 0x02
	p1EP6          = 0x06
	p1DiscoveryLen = 63
	p1ReplyLen     = 60

	// C0 carries MOX in bit 0 and the register address above it, so register
	// 0x02 (RX1 frequency) travels as 0x04.
	p1C0AddrMask = 0xFE
	p1C0MOX      = 0x01
	p1C0Config   = 0x00
	p1C0RX1Freq  = 0x04

	p1NumRx            = 1
	p1RoundBytes       = 6*p1NumRx + 2
	p1RoundsPerFrame   = p1FramePayload / p1RoundBytes
	P1SamplesPerPacket = 2 * p1RoundsPerFrame // 126

	// P1Watchdog is how long a streaming client may go silent before the
	// stream stops. A real radio has one; without it a client that dies
	// holds a receiver open against the UberSDR server forever.
	P1Watchdog = 3 * time.Second
)

// p1Host is the receiver plumbing protocol 1 drives. An interface so the
// coupling runs one way -- protocol 1 asks the bridge for things -- and so the
// tests can watch exactly what a packet made it do.
type p1Host interface {
	p1SetRate(rx, hz int)
	p1SetFreq(rx int, hz int64)
	p1Enable(rx int, on bool)
	p1StopAll()
	p1P2Busy() bool
	mac() [6]byte
	boardType() byte
	logf(format string, args ...any)
}

// packetWriter is the one thing protocol 1 needs from a socket.
type packetWriter interface {
	WriteTo(b []byte, addr net.Addr) (int, error)
}

// P1 is the protocol 1 client-facing state.
type P1 struct {
	host p1Host
	now  func() time.Time

	mu      sync.Mutex
	running bool
	conn    packetWriter
	client  net.Addr
	txSeq   uint32
	raddr   byte
	lastRx  time.Time

	// What the client last asked for, so a repeat is not a change. EP2 packets
	// arrive continuously; acting on every one would reconnect hundreds of
	// times a second.
	rateHz int
	freqHz int64

	warnedMOX   bool
	warnedRx    int
	saidRefused bool
	pkt         [p1USBPacket]byte
}

func newP1(host p1Host) *P1 {
	return &P1{host: host, now: time.Now}
}

// Active reports whether a protocol 1 client is streaming. While it is, the
// protocol 2 paths stand down and IQ leaves as EP6.
func (p *P1) Active() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running
}

// Client is where EP6 is going, or nil.
func (p *P1) Client() net.Addr {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running {
		return nil
	}
	return p.client
}

// IsP1 reports whether a datagram is protocol 1: every one opens EF FE, and
// every protocol 2 datagram opens with a sequence number whose first packet is
// zero -- but the check that matters is this one, made first.
func IsP1(b []byte) bool { return len(b) >= 3 && b[0] == 0xEF && b[1] == 0xFE }

// HandleDatagram offers one datagram from the discovery port. It returns true
// when it was protocol 1 and has been dealt with.
func (p *P1) HandleDatagram(conn packetWriter, b []byte, from net.Addr) bool {
	if !IsP1(b) {
		return false
	}
	p.touch()
	switch b[2] {
	case 0x02:
		if len(b) >= p1DiscoveryLen && conn != nil {
			_, _ = conn.WriteTo(p.discoveryReply(), from)
		}
	case 0x04:
		// Bit 0 streams EP6. The other bits select the bandscope and disable
		// the radio's own watchdog, neither of which applies here.
		if len(b) >= 4 {
			if b[3]&0x01 != 0 {
				p.start(conn, from)
			} else {
				p.stop()
			}
		}
	case 0x01:
		if len(b) >= 4 && b[3] == p1EP2 {
			p.handleEP2(b)
		}
	}
	return true
}

func (p *P1) touch() {
	p.mu.Lock()
	p.lastRx = p.now()
	p.mu.Unlock()
}

// discoveryReply is the 60-byte reply. The offsets are not the protocol 2 ones:
// status at [2], MAC from [3], gateware at [9], board id at [10], and the
// receiver count at [19] -- not [20], which holds the bandscope bits and board
// build id and would be read as a receiver count in the dozens.
func (p *P1) discoveryReply() []byte {
	r := make([]byte, p1ReplyLen)
	r[0], r[1] = 0xEF, 0xFE
	r[2] = 0x02
	if p.Active() {
		r[2] = 0x03
	}
	mac := p.host.mac()
	copy(r[3:9], mac[:])
	r[9] = hermesLiteFirmware
	r[10] = p.host.boardType()
	r[19] = p1NumRx
	return r
}

// P1RateFromC1 decodes the two-bit sample rate field of the config register.
func P1RateFromC1(c1 byte) int {
	switch c1 & 0x03 {
	case 0:
		return 48000
	case 1:
		return 96000
	case 2:
		return 192000
	default:
		return 384000
	}
}

// handleEP2 applies both command banks. A frame without the sync bytes is not a
// command bank, and reading five bytes from it anyway would act on whatever
// happened to be there.
func (p *P1) handleEP2(b []byte) {
	if len(b) < p1USBPacket {
		return
	}
	for f := 0; f < 2; f++ {
		frame := b[8+f*p1Frame:]
		if frame[0] != p1Sync || frame[1] != p1Sync || frame[2] != p1Sync {
			continue
		}
		p.applyCC(frame[3:8])
	}
}

// applyCC decodes the registers a receive-only bridge can act on. The rest --
// filter relays, drive level, ADC gain -- are real on hardware and ignored on
// purpose: there is nothing behind this bridge for them to control.
func (p *P1) applyCC(cc []byte) {
	c0 := cc[0]
	// MOX is C0 bit 0 of every frame, not a register of its own, so a keyed
	// config bank is still a config bank.
	if c0&p1C0MOX != 0 {
		p.mu.Lock()
		first := !p.warnedMOX
		p.warnedMOX = true
		p.mu.Unlock()
		if first {
			p.host.logf("P1: client keyed (MOX); this bridge is receive-only, ignoring")
		}
	}
	switch c0 & p1C0AddrMask {
	case p1C0Config:
		rate := P1RateFromC1(cc[1])
		p.mu.Lock()
		changed := rate != p.rateHz
		p.rateHz = rate
		p.mu.Unlock()
		if changed {
			p.host.logf("P1: sample rate %d kHz", rate/1000)
			p.host.p1SetRate(0, rate)
		}
		// C4[6:3] is numRx-1. Reported, not acted on: a client asking for more
		// than the discovery reply offered has ignored it, which is worth saying
		// rather than quietly serving one anyway.
		want := int((cc[4]>>3)&0x0F) + 1
		p.mu.Lock()
		say := want != p1NumRx && p.warnedRx != want
		if say {
			p.warnedRx = want
		}
		p.mu.Unlock()
		if say {
			p.host.logf("P1: client asked for %d receivers; this bridge offers %d", want, p1NumRx)
		}
	case p1C0RX1Freq:
		hz := int64(binary.BigEndian.Uint32(cc[1:5]))
		p.mu.Lock()
		changed := hz != 0 && hz != p.freqHz
		if changed {
			p.freqHz = hz
		}
		p.mu.Unlock()
		if changed {
			p.host.p1SetFreq(0, hz)
		}
	}
}

// start claims the bridge for a protocol 1 client.
//
// Refused while a protocol 2 client is streaming: both drive the same
// receivers, and starting would reconfigure that session out from under it
// while its samples went here instead. That is the answer a real radio gives,
// and its discovery reply already said busy.
func (p *P1) start(conn packetWriter, from net.Addr) {
	if !p.Active() && p.host.p1P2Busy() {
		p.mu.Lock()
		say := !p.saidRefused
		p.saidRefused = true
		p.mu.Unlock()
		if say {
			p.host.logf("P1: refusing a client while a protocol 2 client is streaming")
		}
		return
	}
	p.mu.Lock()
	was := p.running
	p.running = true
	p.conn = conn
	p.client = from
	p.txSeq = 0
	p.raddr = 0
	p.lastRx = p.now()
	if !was && p.rateHz == 0 {
		// 192 kHz if the client has not said yet, which is what the bridge
		// starts at.
		p.rateHz = 192000
	}
	rate, freq := p.rateHz, p.freqHz
	p.mu.Unlock()
	if !was {
		p.host.logf("P1: client %s started the stream", from)
		p.host.p1SetRate(0, rate)
		// The frequency too. A stop clears the receiver, while the dedupe here
		// remembers what the client last sent -- so a client that stops and
		// starts on the same frequency repeats an EP2 that looks like no change,
		// and without this the receiver would sit at 0 Hz and never connect.
		if freq != 0 {
			p.host.p1SetFreq(0, freq)
		}
		p.host.p1Enable(0, true)
	}
}

func (p *P1) stop() {
	p.mu.Lock()
	was := p.running
	p.running = false
	p.mu.Unlock()
	if was {
		p.host.logf("P1: client stopped the stream")
		p.host.p1Enable(0, false)
		p.host.p1StopAll()
	}
}

// CheckWatchdog stops the stream when the client has gone quiet.
func (p *P1) CheckWatchdog() {
	p.mu.Lock()
	expired := p.running && p.now().Sub(p.lastRx) >= P1Watchdog
	p.mu.Unlock()
	if expired {
		p.host.logf("P1: no packets from the client for %s, stopping", P1Watchdog)
		p.stop()
	}
}

// fillStatus writes the five status bytes that open an EP6 frame.
//
// The radio free-runs through telemetry addresses 0..4 so the client collects
// temperature, power and firmware without asking; C0 carries the address at
// bits [6:3]. Address 0's low byte is the firmware version, and its bit 25 is
// transmit-permitted, ACTIVE LOW: left clear, so a client sees transmit
// inhibited, which is true. Power and temperature report zero because there is
// nothing behind them, and invented numbers on a client's meters mean nothing.
func (p *P1) fillStatus(cc []byte) {
	raddr := p.raddr
	p.raddr = (p.raddr + 1) % 5
	cc[0] = raddr << 3
	cc[1], cc[2], cc[3], cc[4] = 0, 0, 0, 0
	if raddr == 0 {
		cc[4] = hermesLiteFirmware
	}
}

// BuildEP6 packs one EP6 packet from 126 complex samples (interleaved re, im,
// scaled to the 24-bit field). It advances the sequence and status rotation.
// Returns nil when no client is streaming.
func (p *P1) BuildEP6(iq []float32) ([]byte, packetWriter, net.Addr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running || p.conn == nil {
		return nil, nil, nil
	}
	pkt := p.pkt[:]
	clear(pkt)
	pkt[0], pkt[1], pkt[2], pkt[3] = 0xEF, 0xFE, 0x01, p1EP6
	binary.BigEndian.PutUint32(pkt[4:], p.txSeq)
	p.txSeq++
	s := 0
	for f := 0; f < 2; f++ {
		frame := pkt[8+f*p1Frame:]
		frame[0], frame[1], frame[2] = p1Sync, p1Sync, p1Sync
		p.fillStatus(frame[3:8])
		round := frame[8:]
		for r := 0; r < p1RoundsPerFrame; r++ {
			PutIQ24(round, iq[2*s], iq[2*s+1])
			// round[6:8], the mic word, stays zero.
			round = round[p1RoundBytes:]
			s++
		}
		// The tail of the frame is padding: a round never straddles frames.
	}
	out := make([]byte, p1USBPacket)
	copy(out, pkt)
	return out, p.conn, p.client
}
