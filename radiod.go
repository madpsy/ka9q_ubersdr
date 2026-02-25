package main

import (
	"fmt"
	"log"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/ipv4"
)

// RadiodController manages communication with ka9q-radio's radiod
type RadiodController struct {
	statusAddr      *net.UDPAddr
	dataAddr        *net.UDPAddr
	conn            *net.UDPConn
	iface           *net.Interface
	frontendTracker *FrontendStatusTracker
	cmdMu           sync.Mutex // Protects sendCommand for thread-safe parallel polling
}

// fnv1hash implements the FNV-1 hash algorithm
// Matches ka9q-radio's fnv1hash() from misc.c (lines 589-596)
// https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
func fnv1hash(data []byte) uint32 {
	hash := uint32(0x811c9dc5) // FNV-1 offset basis
	for _, b := range data {
		hash *= 0x01000193 // FNV-1 prime
		hash ^= uint32(b)
	}
	return hash
}

// makeMaddr generates a multicast address from a hostname using FNV-1 hash
// Matches ka9q-radio's make_maddr() from multicast.c (lines 786-797)
func makeMaddr(hostname string) string {
	// Generate hash of hostname
	hash := fnv1hash([]byte(hostname))

	// Create address in 239.0.0.0/8 (administratively scoped)
	addr := (239 << 24) | (hash & 0xffffff)

	// Avoid 239.0.0.0/24 and 239.128.0.0/24 to prevent MAC address collisions
	// These ranges map to the same Ethernet multicast MAC addresses
	if (addr & 0x007fff00) == 0 {
		addr |= (addr & 0xff) << 8
	}
	if (addr & 0x007fff00) == 0 {
		addr |= 0x00100000
	}

	// Convert to IP address string
	return fmt.Sprintf("%d.%d.%d.%d",
		(addr>>24)&0xff,
		(addr>>16)&0xff,
		(addr>>8)&0xff,
		addr&0xff)
}

// resolveMulticastAddr resolves a multicast address, with fallback to hash-based generation
// This matches ka9q-radio's behavior when DNS resolution fails
func resolveMulticastAddr(addrStr string) (*net.UDPAddr, error) {
	// First try standard DNS resolution
	addr, err := net.ResolveUDPAddr("udp", addrStr)
	if err == nil {
		return addr, nil
	}

	// DNS resolution failed - extract hostname and port
	// Format is typically "hostname:port" or just "hostname"
	parts := strings.Split(addrStr, ":")
	if len(parts) == 0 {
		return nil, fmt.Errorf("invalid address format: %s", addrStr)
	}

	hostname := parts[0]
	port := "0" // default port
	if len(parts) > 1 {
		port = parts[1]
	}

	// Generate multicast IP using FNV-1 hash (same as ka9q-radio)
	multicastIP := makeMaddr(hostname)

	// Parse the port
	portNum, err := strconv.Atoi(port)
	if err != nil {
		return nil, fmt.Errorf("invalid port in address %s: %w", addrStr, err)
	}

	// Create UDP address with generated IP
	generatedAddr := fmt.Sprintf("%s:%d", multicastIP, portNum)
	log.Printf("DNS resolution failed for %s, using FNV-1 hash-generated address: %s", addrStr, generatedAddr)

	return net.ResolveUDPAddr("udp", generatedAddr)
}

// NewRadiodController creates a new radiod controller
func NewRadiodController(statusGroup, dataGroup, ifaceName string) (*RadiodController, error) {
	// Parse status multicast address (with FNV-1 hash fallback)
	statusAddr, err := resolveMulticastAddr(statusGroup)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve status address: %w", err)
	}

	// Parse data multicast address (with FNV-1 hash fallback)
	dataAddr, err := resolveMulticastAddr(dataGroup)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve data address: %w", err)
	}

	// Get network interface
	var iface *net.Interface
	if ifaceName != "" {
		iface, err = net.InterfaceByName(ifaceName)
		if err != nil {
			return nil, fmt.Errorf("failed to get interface %s: %w", ifaceName, err)
		}
	} else {
		// Use default interface if none specified
		iface, err = getDefaultInterface()
		if err != nil {
			log.Printf("Warning: could not determine default interface: %v", err)
		}
	}

	// Create UDP connection for sending control commands
	// Match ka9q-radio's connect_mcast() behavior from multicast.c
	conn, err := setupControlSocket(statusAddr, iface)
	if err != nil {
		return nil, fmt.Errorf("failed to create control socket: %w", err)
	}

	rc := &RadiodController{
		statusAddr:      statusAddr,
		dataAddr:        dataAddr,
		conn:            conn,
		iface:           iface,
		frontendTracker: NewFrontendStatusTracker(),
	}

	// Start STATUS packet listener to receive frontend status
	if err := rc.frontendTracker.StartStatusListener(statusAddr, iface); err != nil {
		log.Printf("Warning: Failed to start STATUS listener: %v", err)
		log.Printf("Frontend status (gain, overload counts) will not be available")
	}

	log.Printf("Radiod controller initialized (status: %s, data: %s, iface: %v)", statusGroup, dataGroup, iface)
	return rc, nil
}

// setupControlSocket creates a UDP socket for sending control commands
// This matches ka9q-radio's connect_mcast() and output_mcast() behavior
func setupControlSocket(addr *net.UDPAddr, iface *net.Interface) (*net.UDPConn, error) {
	// Create raw UDP socket
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return nil, fmt.Errorf("failed to create UDP socket: %w", err)
	}

	// Get raw file descriptor for socket options
	rawConn, err := conn.SyscallConn()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to get raw connection: %w", err)
	}

	// Set socket options to match ka9q-radio's multicast.c
	var sockErr error
	err = rawConn.Control(func(fd uintptr) {
		// Issue #5: Set IP_MULTICAST_LOOP = 1 (ensure local listeners get packets)
		if err := syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_LOOP, 1); err != nil {
			sockErr = fmt.Errorf("failed to set IP_MULTICAST_LOOP: %w", err)
			return
		}

		// Set IP_MULTICAST_TTL = 1 (local network only)
		if err := syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_TTL, 1); err != nil {
			sockErr = fmt.Errorf("failed to set IP_MULTICAST_TTL: %w", err)
			return
		}

		// Issue #2: Set IP_MULTICAST_IF to specify outbound interface
		if iface != nil {
			// Use ip_mreqn structure to set interface by index
			mreqn := syscall.IPMreqn{
				Ifindex: int32(iface.Index),
			}
			if err := syscall.SetsockoptIPMreqn(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, &mreqn); err != nil {
				sockErr = fmt.Errorf("failed to set IP_MULTICAST_IF: %w", err)
				return
			}
		}

		// Set non-blocking mode (better to drop packets than block real-time processing)
		if err := syscall.SetNonblock(int(fd), true); err != nil {
			sockErr = fmt.Errorf("failed to set non-blocking: %w", err)
			return
		}
	})

	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to control socket: %w", err)
	}
	if sockErr != nil {
		conn.Close()
		return nil, sockErr
	}

	// Issue #1: Join the multicast group (even for output sockets)
	// This avoids IGMP snooping issues on switches
	p := ipv4.NewPacketConn(conn)
	if iface != nil {
		if err := p.JoinGroup(iface, addr); err != nil {
			log.Printf("Warning: failed to join multicast group on %s: %v", iface.Name, err)
		}
	}

	// Issue #4: Also join on loopback interface for local traffic
	loopback, err := getLoopbackInterface()
	if err == nil && loopback != nil {
		if err := p.JoinGroup(loopback, addr); err != nil {
			log.Printf("Warning: failed to join multicast group on loopback: %v", err)
		}
	}

	return conn, nil
}

// getDefaultInterface returns the default network interface
func getDefaultInterface() (*net.Interface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	for _, iface := range ifaces {
		// Skip loopback and down interfaces
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		// Skip interfaces without multicast support
		if iface.Flags&net.FlagMulticast == 0 {
			continue
		}
		return &iface, nil
	}

	return nil, fmt.Errorf("no suitable interface found")
}

// getLoopbackInterface returns the loopback interface
func getLoopbackInterface() (*net.Interface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			return &iface, nil
		}
	}

	return nil, fmt.Errorf("loopback interface not found")
}

// CreateChannel creates a new radiod channel with specified parameters and SSRC (default bandwidth)
func (rc *RadiodController) CreateChannel(name string, frequency uint64, mode string, sampleRate int, ssrc uint32) error {
	return rc.CreateChannelWithBandwidth(name, frequency, mode, sampleRate, ssrc, 0) // 0 = use radiod default
}

// CreateChannelWithBandwidth creates a new radiod channel with specified parameters, SSRC, and bandwidth
// NOTE: Bandwidth parameter is currently ignored - radiod preset filter settings are used
// Dynamic bandwidth control proved incompatible with radiod's command processing
func (rc *RadiodController) CreateChannelWithBandwidth(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int) error {
	return rc.CreateChannelWithSquelch(name, frequency, mode, sampleRate, ssrc, bandwidth, nil, nil)
}

// CreateChannelWithSquelch creates a new radiod channel with optional squelch parameters
// squelchOpen and squelchClose are pointers to allow nil (disabled) vs 0.0 (valid value)
// Values are in dB SNR - typical: open=10.0, close=8.0 for hysteresis
// Special value: squelchOpen=-999 sets "always open" mode (sends -999 for both thresholds)
func (rc *RadiodController) CreateChannelWithSquelch(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int, squelchOpen, squelchClose *float32) error {
	// Build control command with SSRC - match ka9q-multidecoder order exactly
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12)
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) - MUST come before PRESET
	buf = encodeDouble(&buf, 0x21, float64(frequency))

	// Add PRESET (tag 85 = 0x55)
	buf = encodeString(&buf, 0x55, mode)

	// Add STATUS_INTERVAL (tag 106 = 0x6A) for 100ms status updates
	// With default blocktime of 20ms, 5 frames = 100ms (10 Hz update rate)
	buf = encodeInt32(&buf, 0x6A, 5)

	// Add optional squelch parameters
	if squelchOpen != nil {
		// Check for special "always open" value (-999)
		if *squelchOpen == -999 {
			// Always open mode - send -999 for both thresholds
			buf = encodeByte(&buf, 0x5C, 1)       // SNR_SQUELCH = enabled
			buf = encodeFloat(&buf, 0x53, -999.0) // SQUELCH_OPEN = -999
			buf = encodeFloat(&buf, 0x54, -999.0) // SQUELCH_CLOSE = -999
		} else if squelchClose != nil {
			// Normal squelch operation with both thresholds
			buf = encodeByte(&buf, 0x5C, 1) // SNR_SQUELCH = enabled
			buf = encodeFloat(&buf, 0x53, *squelchOpen)
			buf = encodeFloat(&buf, 0x54, *squelchClose)
		}
	}

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	if DebugMode {
		log.Printf("DEBUG: Sending CreateChannel command (%d bytes) to %s", len(buf), rc.statusAddr)
		if squelchOpen != nil || squelchClose != nil {
			log.Printf("DEBUG: Squelch - open: %v, close: %v", squelchOpen, squelchClose)
		}
	}

	// Send command
	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send create command: %w", err)
	}

	squelchInfo := ""
	if squelchOpen != nil {
		if *squelchOpen == -999 {
			squelchInfo = ", squelch: always open"
		} else if squelchClose != nil {
			squelchInfo = fmt.Sprintf(", squelch: %.1f/%.1f dB", *squelchOpen, *squelchClose)
		}
	}
	log.Printf("Created channel: %s (SSRC: 0x%08x (%d), freq: %d Hz, mode: %s, rate: %d Hz%s)",
		name, ssrc, ssrc, frequency, mode, sampleRate, squelchInfo)
	return nil
}

// CreateSpectrumChannel creates a new radiod spectrum channel with specified parameters
// CRITICAL: Must send PRESET first to set demod_type, then override parameters
func (rc *RadiodController) CreateSpectrumChannel(name string, frequency uint64, binCount int, binBandwidth float64, ssrc uint32) error {
	log.Printf("CreateSpectrumChannel called: name=%s, freq=%d, bins=%d, bw=%.1f, ssrc=0x%08x",
		name, frequency, binCount, binBandwidth, ssrc)

	// Calculate filter edges for full bandwidth coverage
	// Total bandwidth = binCount * binBandwidth
	// For 0-30 MHz with center at 15 MHz: edges at ±15 MHz
	halfBandwidth := float64(binCount) * binBandwidth / 2.0

	// Build control command for spectrum mode
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12)
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) - MUST come before PRESET
	buf = encodeDouble(&buf, 0x21, float64(frequency))

	// Add PRESET (tag 85 = 0x55) - MUST come early to set demod_type
	// This calls loadpreset() which sets demod_type=SPECT_DEMOD and default parameters
	buf = encodeString(&buf, 0x55, "spectrum")

	// Now override the preset defaults with our custom parameters
	// These come AFTER preset so they override the defaults

	// Add LOW_EDGE (tag 39 = 0x27) - lower frequency edge relative to center
	buf = encodeDouble(&buf, 0x27, -halfBandwidth)

	// Add HIGH_EDGE (tag 40 = 0x28) - upper frequency edge relative to center
	buf = encodeDouble(&buf, 0x28, halfBandwidth)

	// Add BIN_COUNT (tag 94 = 0x5e)
	buf = encodeInt32(&buf, 0x5e, uint32(binCount))

	// Add NONCOHERENT_BIN_BW (tag 93 = 0x5d)
	buf = encodeFloat(&buf, 0x5d, float32(binBandwidth))

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	// Send command
	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send create spectrum command: %w", err)
	}

	log.Printf("Spectrum channel created: SSRC 0x%08x, freq=%d Hz, LOW=%.1f Hz, HIGH=%.1f Hz, bins=%d, bw=%.1f Hz",
		ssrc, frequency, -halfBandwidth, halfBandwidth, binCount, binBandwidth)
	return nil
}

// UpdateSpectrumChannel updates spectrum channel parameters (for zoom/pan)
// binCount is needed to calculate filter edges when binBandwidth changes
// If binCount changes, it will also be sent to radiod
func (rc *RadiodController) UpdateSpectrumChannel(ssrc uint32, frequency uint64, binBandwidth float64, binCount int, sendBinCount bool) error {
	// Build control command to update spectrum parameters
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12)
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) if changed
	if frequency > 0 {
		buf = encodeDouble(&buf, 0x21, float64(frequency))
	}

	// Add BIN_COUNT (tag 94 = 0x5e) if it changed
	if sendBinCount && binCount > 0 {
		buf = encodeInt32(&buf, 0x5e, uint32(binCount))
	}

	// Add NONCOHERENT_BIN_BW (tag 93 = 0x5d) if changed
	if binBandwidth > 0 {
		buf = encodeFloat(&buf, 0x5d, float32(binBandwidth))

		// When bin bandwidth changes, we must also update filter edges
		// Calculate new filter edges based on total bandwidth
		halfBandwidth := float64(binCount) * binBandwidth / 2.0

		// Add LOW_EDGE (tag 39 = 0x27)
		buf = encodeDouble(&buf, 0x27, -halfBandwidth)

		// Add HIGH_EDGE (tag 40 = 0x28)
		buf = encodeDouble(&buf, 0x28, halfBandwidth)
	}

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	// Send command
	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send update spectrum command: %w", err)
	}

	return nil
}

// UpdateChannel updates an existing channel's frequency, mode, and/or bandwidth edges
// This allows changing parameters without destroying and recreating the channel
// bandwidthLow and bandwidthHigh are the filter edges in Hz (can be negative for low edge)
// sendBandwidth controls whether to send bandwidth parameters
func (rc *RadiodController) UpdateChannel(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool) error {
	return rc.UpdateChannelWithSquelch(ssrc, frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, nil, nil)
}

// UpdateChannelWithSquelch updates an existing channel including optional squelch parameters
// squelchOpen and squelchClose are pointers to allow nil (no change) vs 0.0 (valid value)
// Special value: squelchOpen=-999 sets "always open" mode (sends -999 for both thresholds)
func (rc *RadiodController) UpdateChannelWithSquelch(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, squelchOpen, squelchClose *float32) error {
	// Build control command with SSRC to identify the channel
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12) - identifies which channel to update
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) if provided
	if frequency > 0 {
		buf = encodeDouble(&buf, 0x21, float64(frequency))
	}

	// Add PRESET (tag 85 = 0x55) if provided
	if mode != "" {
		buf = encodeString(&buf, 0x55, mode)
	}

	// Add bandwidth via LOW_EDGE and HIGH_EDGE if requested
	if sendBandwidth {
		// Add LOW_EDGE (tag 39 = 0x27)
		buf = encodeFloat(&buf, 0x27, float32(bandwidthLow))

		// Add HIGH_EDGE (tag 40 = 0x28)
		buf = encodeFloat(&buf, 0x28, float32(bandwidthHigh))
	}

	// Add optional squelch parameters
	if squelchOpen != nil {
		// Check for special "always open" value (-999)
		if *squelchOpen == -999 {
			// Always open mode - send -999 for both thresholds
			buf = encodeByte(&buf, 0x5C, 1)       // SNR_SQUELCH = enabled
			buf = encodeFloat(&buf, 0x53, -999.0) // SQUELCH_OPEN = -999
			buf = encodeFloat(&buf, 0x54, -999.0) // SQUELCH_CLOSE = -999
		} else if squelchClose != nil {
			// Normal squelch operation with both thresholds
			buf = encodeByte(&buf, 0x5C, 1) // SNR_SQUELCH = enabled
			buf = encodeFloat(&buf, 0x53, *squelchOpen)
			buf = encodeFloat(&buf, 0x54, *squelchClose)
		}
	}

	// Add STATUS_INTERVAL (tag 106 = 0x6A) for 100ms status updates
	// With default blocktime of 20ms, 5 frames = 100ms (10 Hz update rate)
	// This must be sent with every update because mode changes reload presets
	// which reset output_interval to the preset default (25 frames = 500ms)
	buf = encodeInt32(&buf, 0x6A, 5)

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	// Send command
	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send update command: %w", err)
	}

	return nil
}

// UpdateSquelch updates only the squelch thresholds for an existing channel
// This is useful for adjusting squelch without changing other parameters
// squelchOpen and squelchClose are in dB SNR
// Special value: squelchOpen=-999 sets "always open" mode (sends -999 for both thresholds)
func (rc *RadiodController) UpdateSquelch(ssrc uint32, squelchOpen, squelchClose float32) error {
	// Build control command with SSRC to identify the channel
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12) - identifies which channel to update
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Enable SNR squelch (tag 92 = 0x5C) - CRITICAL for squelch to work!
	buf = encodeByte(&buf, 0x5C, 1) // SNR_SQUELCH = enabled

	// Check for special "always open" value (-999)
	if squelchOpen == -999 {
		// Always open mode - send -999 for both thresholds
		buf = encodeFloat(&buf, 0x53, -999.0) // SQUELCH_OPEN = -999
		buf = encodeFloat(&buf, 0x54, -999.0) // SQUELCH_CLOSE = -999
	} else {
		// Normal squelch operation
		buf = encodeFloat(&buf, 0x53, squelchOpen)
		buf = encodeFloat(&buf, 0x54, squelchClose)
	}

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	// Send command
	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send squelch update command: %w", err)
	}

	return nil
}

// DisableChannel disables a channel by setting its frequency to 0
func (rc *RadiodController) DisableChannel(name string, ssrc uint32) error {
	cmd := rc.buildCommand(name, ssrc, map[string]interface{}{
		"radio.frequency": uint64(0),
	})

	if err := rc.sendCommand(cmd); err != nil {
		return fmt.Errorf("failed to send disable command: %w", err)
	}

	log.Printf("Disabled channel: %s (SSRC: 0x%08x)", name, ssrc)
	return nil
}

// DisableChannelSilent disables a channel by setting its frequency to 0 (without logging)
// Used by cleanup processes that log in bulk
func (rc *RadiodController) DisableChannelSilent(name string, ssrc uint32) error {
	cmd := rc.buildCommand(name, ssrc, map[string]interface{}{
		"radio.frequency": uint64(0),
	})

	if err := rc.sendCommand(cmd); err != nil {
		return fmt.Errorf("failed to send disable command: %w", err)
	}

	return nil
}

// TerminateChannel terminates a channel by setting frequency to 0
// This is the same as DisableChannel - channels will expire after idle timeout
// Note: This is a placeholder until we find a reliable way to immediately terminate channels
func (rc *RadiodController) TerminateChannel(name string, ssrc uint32) error {
	// Just use DisableChannel - it's the most reliable method
	// Trying to force termination with DEMOD_TYPE=-1 or OUTPUT_SAMPRATE changes
	// causes radiod to reload presets which recreates the channel
	return rc.DisableChannel(name, ssrc)
}

// buildCommand constructs a radiod control command packet
// Format: TLV (Type-Length-Value) encoding with leading zero suppression
// Tag numbers from ka9q-radio/src/status.h enum status_type
// This matches ka9q-radio's encode_int64() and encode_double() exactly
func (rc *RadiodController) buildCommand(channelName string, ssrc uint32, params map[string]interface{}) []byte {
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1 (from enum pkt_type)

	// Add SSRC (tag 18 = 0x12 for OUTPUT_SSRC) with leading zero suppression
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Add parameters in the same order as multidecoder
	for key, value := range params {
		switch key {
		case "radio.frequency":
			// Tag 33 (0x21): RADIO_FREQUENCY (double)
			// Must encode as IEEE 754 double with leading zero suppression
			freq := value.(uint64)
			buf = encodeDouble(&buf, 0x21, float64(freq))

		case "radio.mode":
			// Tag 85 (0x55): PRESET (string) - mode preset name
			mode := value.(string)
			buf = encodeString(&buf, 0x55, mode)
		}
	}

	// Add COMMAND_TAG for tracking (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker (tag 0)
	buf = append(buf, 0)

	return buf
}

// encodeInt32 encodes a 32-bit integer with leading zero suppression
// Matches ka9q-radio's encode_int32() -> encode_int64()
func encodeInt32(buf *[]byte, tag byte, value uint32) []byte {
	*buf = append(*buf, tag)

	if value == 0 {
		*buf = append(*buf, 0) // Zero length for zero value
		return *buf
	}

	// Convert to uint64 and suppress leading zeros
	x := uint64(value)
	length := 8
	for length > 0 && ((x >> 56) == 0) {
		x <<= 8
		length--
	}

	*buf = append(*buf, byte(length))
	for i := 0; i < length; i++ {
		*buf = append(*buf, byte(x>>56))
		x <<= 8
	}

	return *buf
}

// encodeDouble encodes a double (float64) with leading zero suppression
// Matches ka9q-radio's encode_double() which converts to uint64 then suppresses zeros
func encodeDouble(buf *[]byte, tag byte, value float64) []byte {
	*buf = append(*buf, tag)

	// Convert double to uint64 via IEEE 754 bits
	bits := math.Float64bits(value)

	if bits == 0 {
		*buf = append(*buf, 0) // Zero length for zero value
		return *buf
	}

	// Suppress leading zeros
	length := 8
	for length > 0 && ((bits >> 56) == 0) {
		bits <<= 8
		length--
	}

	*buf = append(*buf, byte(length))
	for i := 0; i < length; i++ {
		*buf = append(*buf, byte(bits>>56))
		bits <<= 8
	}

	return *buf
}

// encodeFloat encodes a float32 with leading zero suppression
// Matches ka9q-radio's encode_float() which converts to uint32 then suppresses zeros
func encodeFloat(buf *[]byte, tag byte, value float32) []byte {
	*buf = append(*buf, tag)

	// Convert float to uint32 via IEEE 754 bits
	bits := math.Float32bits(value)

	if bits == 0 {
		*buf = append(*buf, 0) // Zero length for zero value
		return *buf
	}

	// Suppress leading zeros
	length := 4
	for length > 0 && ((bits >> 24) == 0) {
		bits <<= 8
		length--
	}

	*buf = append(*buf, byte(length))
	for i := 0; i < length; i++ {
		*buf = append(*buf, byte(bits>>24))
		bits <<= 8
	}

	return *buf
}

// encodeByte encodes a single byte value
func encodeByte(buf *[]byte, tag byte, value byte) []byte {
	*buf = append(*buf, tag)
	*buf = append(*buf, 1) // Length = 1
	*buf = append(*buf, value)
	return *buf
}

// encodeString encodes a string
// Matches ka9q-radio's encode_string()
func encodeString(buf *[]byte, tag byte, value string) []byte {
	*buf = append(*buf, tag)

	length := len(value)
	if length < 128 {
		*buf = append(*buf, byte(length))
	} else {
		// For longer strings, use extended length encoding
		// Not needed for our use case, but included for completeness
		*buf = append(*buf, 0x80|2)
		*buf = append(*buf, byte(length>>8))
		*buf = append(*buf, byte(length))
	}

	*buf = append(*buf, []byte(value)...)
	return *buf
}

// sendCommand sends a command packet to radiod
// Thread-safe: protected by mutex for parallel polling
func (rc *RadiodController) sendCommand(cmd []byte) error {
	rc.cmdMu.Lock()
	defer rc.cmdMu.Unlock()

	// Set write deadline
	if err := rc.conn.SetWriteDeadline(time.Now().Add(1 * time.Second)); err != nil {
		return fmt.Errorf("failed to set write deadline: %w", err)
	}

	// Send command using WriteTo since we're not using a connected socket
	n, err := rc.conn.WriteTo(cmd, rc.statusAddr)
	if err != nil {
		return fmt.Errorf("failed to write command: %w", err)
	}

	if n != len(cmd) {
		return fmt.Errorf("incomplete write: sent %d of %d bytes", n, len(cmd))
	}

	return nil
}

// Close closes the radiod controller connection
func (rc *RadiodController) Close() error {
	// Stop frontend status tracker
	if rc.frontendTracker != nil {
		rc.frontendTracker.Stop()
	}

	if rc.conn != nil {
		return rc.conn.Close()
	}
	return nil
}

// GetDataAddr returns the data multicast address
func (rc *RadiodController) GetDataAddr() *net.UDPAddr {
	return rc.dataAddr
}

// GetInterface returns the network interface
func (rc *RadiodController) GetInterface() *net.Interface {
	return rc.iface
}

// GetFrontendStatus returns the frontend status for a given SSRC
// Returns nil if no status is available for that SSRC
func (rc *RadiodController) GetFrontendStatus(ssrc uint32) *FrontendStatus {
	if rc.frontendTracker == nil {
		return nil
	}
	return rc.frontendTracker.GetFrontendStatus(ssrc)
}

// GetAllFrontendStatus returns all frontend status entries
// Returns a map of SSRC -> FrontendStatus
func (rc *RadiodController) GetAllFrontendStatus() map[uint32]*FrontendStatus {
	if rc.frontendTracker == nil {
		return make(map[uint32]*FrontendStatus)
	}
	return rc.frontendTracker.GetAllFrontendStatus()
}

// GetChannelStatus returns the channel status for a given SSRC
// Returns nil if no status is available for that SSRC
func (rc *RadiodController) GetChannelStatus(ssrc uint32) *ChannelStatus {
	if rc.frontendTracker == nil {
		return nil
	}
	return rc.frontendTracker.GetChannelStatus(ssrc)
}

// GetAllChannelStatus returns all channel status entries
// Returns a map of SSRC -> ChannelStatus
func (rc *RadiodController) GetAllChannelStatus() map[uint32]*ChannelStatus {
	if rc.frontendTracker == nil {
		return make(map[uint32]*ChannelStatus)
	}
	return rc.frontendTracker.GetAllChannelStatus()
}
