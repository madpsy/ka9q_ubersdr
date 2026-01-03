package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"net"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/ipv4"
)

// Status tag numbers from ka9q-radio/src/status.h enum status_type
const (
	tagEOL              = 0
	tagCommandTag       = 1
	tagOutputSSRC       = 18
	tagLNAGain          = 30  // LNA_GAIN
	tagMixerGain        = 31  // MIXER_GAIN
	tagIFGain           = 32  // IF_GAIN
	tagIFPower          = 47  // IF_POWER
	tagRFAtten          = 96  // RF_ATTEN
	tagRFGain           = 97  // RF_GAIN
	tagRFAGC            = 98  // RF_AGC
	tagADOver           = 103 // AD_OVER - A/D overrange count
	tagSamplesSinceOver = 107 // SAMPLES_SINCE_OVER
)

// Packet type constants
const (
	pktTypeStatus = 0
	pktTypeCmd    = 1
)

// FrontendStatus holds frontend gain and overload information from radiod
type FrontendStatus struct {
	SSRC             uint32    // Channel SSRC this status belongs to
	LNAGain          int32     // LNA gain in dB
	MixerGain        int32     // Mixer gain in dB
	IFGain           int32     // IF gain in dB
	RFGain           float32   // RF gain (float)
	RFAtten          float32   // RF attenuation (float)
	RFAGC            int32     // RF AGC on/off
	IFPower          float32   // IF power in dBFS
	ADOverranges     int64     // A/D overrange count
	SamplesSinceOver int64     // Samples since last overrange
	LastUpdate       time.Time // When this status was last updated
}

// FrontendStatusTracker manages frontend status from radiod STATUS packets
type FrontendStatusTracker struct {
	mu             sync.RWMutex
	frontendStatus map[uint32]*FrontendStatus // Map of SSRC -> FrontendStatus
	statusListener *net.UDPConn
	stopListener   chan struct{}
}

// NewFrontendStatusTracker creates a new frontend status tracker
func NewFrontendStatusTracker() *FrontendStatusTracker {
	return &FrontendStatusTracker{
		frontendStatus: make(map[uint32]*FrontendStatus),
		stopListener:   make(chan struct{}),
	}
}

// StartStatusListener starts listening for STATUS packets from radiod
func (fst *FrontendStatusTracker) StartStatusListener(statusAddr *net.UDPAddr, iface *net.Interface) error {
	// Create UDP socket with SO_REUSEADDR and SO_REUSEPORT to allow multiple listeners
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var opErr error
			if err := c.Control(func(fd uintptr) {
				// Set SO_REUSEADDR to allow multiple binds to same address
				if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
					opErr = fmt.Errorf("failed to set SO_REUSEADDR: %w", err)
					return
				}
				// Set SO_REUSEPORT to allow multiple processes/goroutines to bind to same port
				if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, SO_REUSEPORT, 1); err != nil {
					opErr = fmt.Errorf("failed to set SO_REUSEPORT: %w", err)
					return
				}
			}); err != nil {
				return err
			}
			return opErr
		},
	}

	// Listen on the multicast address with reuse options
	listenPacket, err := lc.ListenPacket(context.Background(), "udp4", statusAddr.String())
	if err != nil {
		return fmt.Errorf("failed to create STATUS listener: %w", err)
	}

	conn := listenPacket.(*net.UDPConn)

	// Join multicast group
	p := ipv4.NewPacketConn(conn)
	if iface != nil {
		if err := p.JoinGroup(iface, statusAddr); err != nil {
			conn.Close()
			return fmt.Errorf("failed to join STATUS multicast group: %w", err)
		}
	}

	// Also join on loopback for local traffic
	loopback, err := getLoopbackInterface()
	if err == nil && loopback != nil {
		if err := p.JoinGroup(loopback, statusAddr); err != nil {
			log.Printf("Warning: failed to join STATUS multicast group on loopback: %v", err)
		}
	}

	fst.statusListener = conn
	log.Printf("Started frontend STATUS packet listener on %s (with SO_REUSEPORT)", statusAddr)

	// Start listener goroutine
	go fst.listenLoop()

	return nil
}

// listenLoop continuously receives and processes STATUS packets
func (fst *FrontendStatusTracker) listenLoop() {
	buf := make([]byte, 9000) // Large enough for any STATUS packet

	for {
		select {
		case <-fst.stopListener:
			return
		default:
		}

		// Set read deadline to allow checking stop channel
		fst.statusListener.SetReadDeadline(time.Now().Add(1 * time.Second))

		n, _, err := fst.statusListener.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Timeout is expected, check stop channel
			}
			log.Printf("Error reading STATUS packet: %v", err)
			continue
		}

		if n < 2 {
			continue // Too short
		}

		// Check packet type (first byte)
		if buf[0] != pktTypeStatus {
			continue // Not a STATUS packet
		}

		// Parse STATUS packet
		fst.parseStatusPacket(buf[1:n])
	}
}

// parseStatusPacket parses a STATUS packet and extracts frontend parameters
func (fst *FrontendStatusTracker) parseStatusPacket(data []byte) {
	status := &FrontendStatus{
		LastUpdate: time.Now(),
	}

	offset := 0
	for offset < len(data) {
		if offset+1 >= len(data) {
			break
		}

		tag := data[offset]
		offset++

		// EOL marker
		if tag == tagEOL {
			break
		}

		// Read length
		length := int(data[offset])
		offset++

		// Handle extended length encoding (length >= 128)
		if length&0x80 != 0 {
			lengthOfLength := length & 0x7f
			length = 0
			for i := 0; i < lengthOfLength && offset < len(data); i++ {
				length = (length << 8) | int(data[offset])
				offset++
			}
		}

		// Check bounds
		if offset+length > len(data) {
			break
		}

		// Extract value based on tag
		value := data[offset : offset+length]
		switch tag {
		case tagOutputSSRC:
			status.SSRC = decodeInt32(value)
		case tagLNAGain:
			status.LNAGain = int32(decodeInt32(value))
		case tagMixerGain:
			status.MixerGain = int32(decodeInt32(value))
		case tagIFGain:
			status.IFGain = int32(decodeInt32(value))
		case tagRFGain:
			status.RFGain = decodeFloat(value)
		case tagRFAtten:
			status.RFAtten = decodeFloat(value)
		case tagRFAGC:
			status.RFAGC = int32(decodeInt32(value))
		case tagIFPower:
			status.IFPower = decodeFloat(value)
		case tagADOver:
			status.ADOverranges = decodeInt64(value)
		case tagSamplesSinceOver:
			status.SamplesSinceOver = decodeInt64(value)
		}

		offset += length
	}

	// Store status if we got an SSRC
	if status.SSRC != 0 {
		fst.mu.Lock()
		fst.frontendStatus[status.SSRC] = status
		fst.mu.Unlock()
	}
}

// GetFrontendStatus returns the frontend status for a given SSRC
func (fst *FrontendStatusTracker) GetFrontendStatus(ssrc uint32) *FrontendStatus {
	fst.mu.RLock()
	defer fst.mu.RUnlock()

	status, ok := fst.frontendStatus[ssrc]
	if !ok {
		return nil
	}

	// Return a copy to avoid race conditions
	statusCopy := *status
	return &statusCopy
}

// GetAllFrontendStatus returns all frontend status entries
func (fst *FrontendStatusTracker) GetAllFrontendStatus() map[uint32]*FrontendStatus {
	fst.mu.RLock()
	defer fst.mu.RUnlock()

	// Return a copy of the map
	result := make(map[uint32]*FrontendStatus, len(fst.frontendStatus))
	for ssrc, status := range fst.frontendStatus {
		statusCopy := *status
		result[ssrc] = &statusCopy
	}
	return result
}

// Stop stops the STATUS packet listener
func (fst *FrontendStatusTracker) Stop() {
	close(fst.stopListener)
	if fst.statusListener != nil {
		fst.statusListener.Close()
	}
}

// TLV Decoding functions - reverse of encoding functions in radiod.go

// decodeInt32 decodes a 32-bit integer with leading zero suppression
func decodeInt32(data []byte) uint32 {
	if len(data) == 0 {
		return 0
	}

	var result uint32
	for _, b := range data {
		result = (result << 8) | uint32(b)
	}
	return result
}

// decodeInt64 decodes a 64-bit integer with leading zero suppression
func decodeInt64(data []byte) int64 {
	if len(data) == 0 {
		return 0
	}

	var result uint64
	for _, b := range data {
		result = (result << 8) | uint64(b)
	}
	return int64(result)
}

// decodeFloat decodes a float32 with leading zero suppression
func decodeFloat(data []byte) float32 {
	if len(data) == 0 {
		return 0
	}

	// Reconstruct the 32-bit value
	var bits uint32
	for _, b := range data {
		bits = (bits << 8) | uint32(b)
	}

	// Shift left to restore leading zeros only if data is shorter than 4 bytes
	if len(data) < 4 {
		shift := (4 - len(data)) * 8
		bits <<= shift
	}

	return math.Float32frombits(bits)
}

// decodeDouble decodes a float64 with leading zero suppression
func decodeDouble(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}

	// Reconstruct the 64-bit value
	var bits uint64
	for _, b := range data {
		bits = (bits << 8) | uint64(b)
	}

	// Shift left to restore leading zeros only if data is shorter than 8 bytes
	if len(data) < 8 {
		shift := (8 - len(data)) * 8
		bits <<= shift
	}

	return math.Float64frombits(bits)
}

// decodeInt8 decodes an 8-bit integer
func decodeInt8(data []byte) int8 {
	if len(data) == 0 {
		return 0
	}
	return int8(data[0])
}

// decodeBool decodes a boolean value
func decodeBool(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	return data[0] != 0
}

// decodeString decodes a string
func decodeString(data []byte) string {
	return string(data)
}

// Helper function to convert bytes to uint32 (big-endian)
func bytesToUint32(data []byte) uint32 {
	if len(data) < 4 {
		return 0
	}
	return binary.BigEndian.Uint32(data)
}

// Helper function to convert bytes to uint64 (big-endian)
func bytesToUint64(data []byte) uint64 {
	if len(data) < 8 {
		return 0
	}
	return binary.BigEndian.Uint64(data)
}
