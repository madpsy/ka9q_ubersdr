// Package hpsdr is the radio side of the bridge: openHPSDR protocol 2 and
// protocol 1 as a Hermes / Hermes Lite 2 would speak them, driven by IQ from an
// UberSDR server instead of an ADC.
//
// The protocol is grounded in the openHPSDR Ethernet Protocol v4.3 (protocol 2),
// the Metis / Hermes Lite 2 register map (protocol 1), and in the C bridge in
// clients/hpsdr, which this is a port of. Where that bridge learned something
// on air -- the I/Q swap, the display gain, which discovery byte a client
// actually reads -- the reasoning is kept beside the code that depends on it.
package hpsdr

import (
	"encoding/binary"
	"fmt"
	"math"
)

// MaxReceivers is the most DDCs the bridge emulates.
const MaxReceivers = 10

// Protocol 2 port layout, as offsets from the discovery port (1024 on a real
// radio). Every one is fixed by the protocol: the client sends to them and
// reads which DDC a packet belongs to from the port it came from.
const (
	PortDiscovery   = 0  // 1024: discovery and the general packet (and all of protocol 1)
	PortDDCSpecific = 1  // 1025: host->radio DDC config; also the source of HP status
	PortMic         = 2  // 1026: radio->host mic; host->radio DUC specific (drained)
	PortHighPrio    = 3  // 1027: host->radio high priority; radio->host wideband
	PortAudio       = 4  // 1028: host->radio audio (drained)
	PortTXIQ        = 5  // 1029: host->radio TX IQ (drained)
	PortDDC0        = 11 // 1035+n: radio->host IQ from DDC n
)

// Device types in the discovery reply.
const (
	DeviceHermes     = 1
	DeviceHermesLite = 6
)

// Firmware versions reported. A Hermes Lite reporting below 40 is classed by
// clients as a V1 board with a reduced feature set, so it says 62, a plausible
// HL2 gateware version, which keeps the client on the modern path.
const (
	hermesFirmware     = 18
	hermesLiteFirmware = 62
)

func firmwareFor(device byte) byte {
	if device == DeviceHermesLite {
		return hermesLiteFirmware
	}
	return hermesFirmware
}

// Packet sizes.
const (
	p2DiscoveryLen = 60
	p2GeneralLen   = 60
	p2HighPrioLen  = 1444
	p2DDCSpecLen   = 1444
	p2IQLen        = 1444
	p2StatusLen    = 60
	p2MicLen       = 132

	// P2SamplesPerPacket is how many complex samples one DDC IQ packet carries:
	// 238 x 6 bytes = 1428, the payload of a 1444-byte packet.
	P2SamplesPerPacket = 238
)

// RateMask is the discovery reply's sample-rate bitmap: bits 0-3 are 48, 96,
// 192 and 384 kHz. It is the one field that tells a client which rates it may
// ask for, so it follows what this session is actually allowed to have.
func RateMask(ratesKHz []int) byte {
	var m byte
	for _, r := range ratesKHz {
		switch r {
		case 48:
			m |= 1
		case 96:
			m |= 2
		case 192:
			m |= 4
		case 384:
			m |= 8
		}
	}
	return m
}

// IsP2Discovery reports a protocol 2 discovery request: 60 bytes, four zero
// bytes of sequence, then 0x02.
func IsP2Discovery(b []byte) bool {
	return len(b) == p2DiscoveryLen && binary.BigEndian.Uint32(b) == 0 && b[4] == 0x02
}

// IsP2General reports a protocol 2 general packet: 60 bytes with 0x00 at [4].
// Protocol 1 datagrams are claimed before this is asked, so the leading EF FE
// of those cannot reach it.
func IsP2General(b []byte) bool {
	return len(b) == p2GeneralLen && b[4] == 0x00
}

// P2DiscoveryReply builds the 60-byte discovery reply.
//
// Answered even while streaming, with status 3 (busy), so a client that
// restarts can still find the radio instead of waiting out the watchdog.
func P2DiscoveryReply(busy bool, mac [6]byte, device byte, numRx int, rateMask byte) []byte {
	b := make([]byte, p2DiscoveryLen)
	b[4] = 0x02
	if busy {
		b[4] = 0x03
	}
	copy(b[5:11], mac[:])
	b[11] = device
	b[12] = 38 // protocol version supported, 3.8
	b[13] = firmwareFor(device)
	b[20] = byte(numRx)
	b[21] = 1 // number of ADCs
	b[22] = rateMask
	return b
}

// General is what the bridge reads from the general packet.
type General struct {
	Seq uint32

	// FreqMode is byte 37. Bit 3 set means the DDC frequencies in the high
	// priority packet are phase words (freq * 2^32 / 122.88 MHz) rather than
	// Hz. Thetis, piHPSDR and deskHPSDR set it; some clients send raw Hz.
	FreqMode byte

	// PortOverride: bytes 5-22 remap the UDP ports. Only the defaults are
	// implemented, so a client that remaps them will not work and is told so.
	PortOverride bool

	// Wideband: byte 23 bit 0 enables it; 24-25 samples per packet; 26 sample
	// size; 27 rate; 28 frames per sweep.
	WidebandEnable bool
	WidebandLen    int
	WidebandSize   int
	WidebandRate   int
	WidebandPPF    int
}

// PhaseWord reports whether frequencies arrive as phase words.
func (g General) PhaseWord() bool { return g.FreqMode&0x08 != 0 }

// ParseGeneral reads a general packet. The caller has checked IsP2General.
func ParseGeneral(b []byte) General {
	g := General{
		Seq:            binary.BigEndian.Uint32(b),
		FreqMode:       b[37],
		WidebandEnable: b[23]&1 != 0,
		WidebandLen:    int(binary.BigEndian.Uint16(b[24:])),
		WidebandSize:   int(b[26]),
		WidebandRate:   int(b[27]),
		WidebandPPF:    int(b[28]),
	}
	for _, v := range b[5:23] {
		if v != 0 {
			g.PortOverride = true
			break
		}
	}
	return g
}

// HighPriority is what the bridge reads from the host's high priority packet.
type HighPriority struct {
	Seq  uint32
	Run  bool
	Freq [MaxReceivers]int64
}

// DDCClockHz is the clock a phase word is a fraction of.
const DDCClockHz = 122_880_000.0

// PhaseWordToHz converts a DDC phase word to Hz, rounding as the C bridge does.
func PhaseWordToHz(word uint32) int64 {
	return int64(math.Round(DDCClockHz * float64(word) / 4294967296.0))
}

// ParseHighPriority reads the host->radio high priority packet.
//
// Bytes 5/6 are CWX keying and 1443 the step attenuator; none apply to a
// receive-only bridge with no controllable front end, so they are not read.
func ParseHighPriority(b []byte, numRx int, phaseWord bool) (HighPriority, error) {
	var hp HighPriority
	if len(b) != p2HighPrioLen {
		return hp, fmt.Errorf("high priority packet of %d bytes, want %d", len(b), p2HighPrioLen)
	}
	hp.Seq = binary.BigEndian.Uint32(b)
	hp.Run = b[4]&0x01 != 0
	for i := 0; i < numRx && i < MaxReceivers; i++ {
		// Assembled unsigned: a phase word with bit 31 set is a frequency above
		// 61.44 MHz, not a negative one.
		word := binary.BigEndian.Uint32(b[9+4*i:])
		if phaseWord {
			hp.Freq[i] = PhaseWordToHz(word)
		} else {
			hp.Freq[i] = int64(word)
		}
	}
	return hp, nil
}

// DDCSpecific is what the bridge reads from the DDC specific packet.
type DDCSpecific struct {
	Seq     uint32
	Enable  [MaxReceivers]bool
	RateKHz [MaxReceivers]int

	// Clamped lists the DDCs that asked for more than 384 kHz, the widest rate
	// the server offers and the widest the protocol defines.
	Clamped []int

	// Synced is the first DDC with a nonzero sync byte (1363+n), or -1. Synced
	// DDCs (PureSignal, diversity) expect their samples interleaved in one
	// stream, which independent WebSockets cannot produce.
	Synced     int
	SyncedByte byte
}

// ParseDDCSpecific reads the DDC specific packet. Bytes 5/6, the per-ADC dither
// and random enables, have nothing behind them here and are not read.
func ParseDDCSpecific(b []byte, numRx int) (DDCSpecific, error) {
	d := DDCSpecific{Synced: -1}
	if len(b) != p2DDCSpecLen {
		return d, fmt.Errorf("DDC specific packet of %d bytes, want %d", len(b), p2DDCSpecLen)
	}
	d.Seq = binary.BigEndian.Uint32(b)
	for i := 0; i < numRx && i < MaxReceivers; i++ {
		d.Enable[i] = (b[7+i/8]>>(i%8))&1 != 0
		rate := int(binary.BigEndian.Uint16(b[18+6*i:]))
		if rate > 384 {
			d.Clamped = append(d.Clamped, i)
			rate = 384
		}
		d.RateKHz[i] = rate
		if d.Synced < 0 && b[1363+i] != 0 {
			d.Synced = i
			d.SyncedByte = b[1363+i]
		}
	}
	return d, nil
}

// put24 writes a 24-bit big-endian two's complement value.
func put24(p []byte, v int32) {
	p[0] = byte(v >> 16)
	p[1] = byte(v >> 8)
	p[2] = byte(v)
}

// PutIQ24 writes one complex sample as the six bytes both protocols carry.
//
// The IMAGINARY part goes first. UberSDR's IQ uses the opposite spectral
// convention to HPSDR: sending it real-part-first produces a mirrored spectrum,
// signals on the wrong side of the dial -- confirmed on air with the C bridge.
// Swapping the two on the wire is a conjugation, which un-mirrors it.
//
// Conversion truncates toward zero, as C's (int) cast of a float does, so the
// two bridges put the same integers on the wire.
func PutIQ24(p []byte, re, im float32) {
	put24(p, int32(im))
	put24(p[3:], int32(re))
}

// BuildP2IQ fills a 1444-byte DDC IQ packet from 238 complex samples given as
// interleaved re, im pairs already scaled to the 24-bit field.
//
// Header: sequence (4, BE), timestamp (8, unused and zero), bits per sample
// (2, BE, 24), samples per frame (2, BE, 238).
func BuildP2IQ(dst []byte, seq uint32, iq []float32) {
	_ = dst[p2IQLen-1]
	binary.BigEndian.PutUint32(dst, seq)
	clear(dst[4:12])
	binary.BigEndian.PutUint16(dst[12:], 24)
	binary.BigEndian.PutUint16(dst[14:], P2SamplesPerPacket)
	p := dst[16:]
	for i := 0; i < P2SamplesPerPacket; i++ {
		PutIQ24(p[6*i:], iq[2*i], iq[2*i+1])
	}
}

// BuildP2Status is the radio->host high priority status packet.
//
// The protocol wants one every ~50 ms during receive, from port 1025: PTT and
// key bits, ADC overload, power and AIN readings. This bridge has no transmitter
// and no ADC telemetry, so every field is zero -- but the stream itself, with
// its sequence numbers, must exist: clients drive meters from it and some treat
// its absence as a dead radio.
func BuildP2Status(seq uint32) []byte {
	b := make([]byte, p2StatusLen)
	binary.BigEndian.PutUint32(b, seq)
	return b
}

// BuildP2Mic is a silent mic packet: 64 samples at 48 kHz, one every 1.333 ms.
// Some clients time themselves off it.
func BuildP2Mic(seq uint32) []byte {
	b := make([]byte, p2MicLen)
	binary.BigEndian.PutUint32(b, seq)
	return b
}

// MicInterval is the mic packet cadence: 64 samples at 48 kHz.
const MicInterval = 1_333_333 // ns

// WidebandSweepBytes is one sweep of the wideband file: 16384 16-bit samples.
const WidebandSweepBytes = 32768

// WidebandPacketLen is the samples per wideband packet the client negotiated,
// or 512 when what it asked for does not fit the buffer or divide the sweep.
func WidebandPacketLen(asked int) int {
	if asked < 64 || asked > 512 || 16384%asked != 0 {
		return 512
	}
	return asked
}

// BuildWideband splits one sweep into packets: sequence (4, BE, restarting at
// zero every sweep) then the samples byte-swapped to big-endian.
func BuildWideband(sweep []byte, samplesPerPacket int) [][]byte {
	n := 16384 / samplesPerPacket
	dbytes := samplesPerPacket * 2
	out := make([][]byte, n)
	for i := 0; i < n; i++ {
		pkt := make([]byte, dbytes+4)
		binary.BigEndian.PutUint32(pkt, uint32(i))
		src := sweep[i*dbytes : (i+1)*dbytes]
		for j := 0; j < dbytes; j += 2 {
			pkt[4+j] = src[j+1]
			pkt[5+j] = src[j]
		}
		out[i] = pkt
	}
	return out
}

// ScaleForKHz is the display gain for a channel rate.
//
// A wider channel collects more noise power, so the same spectral density
// arrives as larger samples and needs less gain to show at the same level: a
// 1/sqrt(BW) law, 48 kHz at 8000 giving 4000 at 192. (96's 6000 against the
// 5657 the law predicts is a round number chosen by ear in the C bridge.)
//
// Derived from the rate the samples ARRIVED at, never stored beside a requested
// rate: the C bridge once kept a copy that fell out of step and played 192 kHz
// fifteen decibels quiet.
func ScaleForKHz(khz int) float32 {
	switch khz {
	case 48:
		return 8000
	case 96:
		return 6000
	case 192:
		return 4000
	case 384:
		return 2828
	default:
		return 4000
	}
}
