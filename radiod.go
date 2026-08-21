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

	// spectrumFFTAverages is the SPECTRUM_AVG value sent when creating spectrum
	// channels, from spectrum.spectrum_fft_averages. Zero means unset, in which
	// case fftAverages() falls back to the default rather than sending 0 -- radiod
	// would clamp that to 1 and silently give the noisiest setting.
	spectrumFFTAverages int
}

// SetSpectrumFFTAverages sets the SPECTRUM_AVG value used for new spectrum
// channels.
//
// Zero or negative means "not configured" and selects the default, matching how
// LoadConfig treats an absent spectrum_fft_averages. It deliberately does NOT
// clamp up to the minimum: radiod already clamps anything below 1 to 1, so doing
// that here would turn an unset value into the noisiest possible display instead
// of the intended default. Values above the maximum are clamped down.
func (rc *RadiodController) SetSpectrumFFTAverages(n int) {
	switch {
	case n <= 0:
		n = defaultSpectrumFFTAverages
	case n > maxSpectrumFFTAverages:
		n = maxSpectrumFFTAverages
	}
	rc.spectrumFFTAverages = n
}

// fftAverages returns the configured SPECTRUM_AVG, defaulting if never set.
func (rc *RadiodController) fftAverages() int {
	if rc.spectrumFFTAverages < minSpectrumFFTAverages {
		return defaultSpectrumFFTAverages
	}
	return rc.spectrumFFTAverages
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

// AGCParams holds optional AGC parameter overrides for a channel.
// Any field left at its zero value is not sent (the preset default is kept).
// Use pointer fields so callers can distinguish "not set" from "set to zero".
type AGCParams struct {
	Enable       *bool    // AGC on/off (nil = use preset default)
	HangTime     *float32 // Hang time in seconds (nil = use preset default)
	RecoveryRate *float32 // Recovery rate in dB/s (nil = use preset default)
	Threshold    *float32 // Threshold in dB relative to headroom (nil = use preset default)
}

// SetAGC sends AGC parameter overrides to an existing channel identified by ssrc.
// Only non-nil fields in params are sent; nil fields leave the current value unchanged.
func (rc *RadiodController) SetAGC(ssrc uint32, params AGCParams) error {
	buf := make([]byte, 0, 64)

	// CMD packet type
	buf = append(buf, pktTypeCmd)

	// Identify the channel
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)

	if params.Enable != nil {
		val := byte(0)
		if *params.Enable {
			val = 1
		}
		buf = encodeByte(&buf, tagAgcEnable, val)
	}
	if params.HangTime != nil {
		buf = encodeFloat(&buf, tagAgcHangtime, *params.HangTime)
	}
	if params.RecoveryRate != nil {
		buf = encodeFloat(&buf, tagAgcRecoveryRate, *params.RecoveryRate)
	}
	if params.Threshold != nil {
		buf = encodeFloat(&buf, tagAgcThreshold, *params.Threshold)
	}

	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)

	if err := rc.sendCommand(buf); err != nil {
		return fmt.Errorf("failed to send AGC params for SSRC 0x%08x: %w", ssrc, err)
	}
	return nil
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
			buf = encodeFloat(&buf, tagSquelchOpen, -999.0)
			buf = encodeFloat(&buf, tagSquelchClose, -999.0)
		} else if squelchClose != nil {
			// Normal squelch operation with both thresholds
			buf = encodeFloat(&buf, tagSquelchOpen, *squelchOpen)
			buf = encodeFloat(&buf, tagSquelchClose, *squelchClose)
		}
	}

	// Add LIFETIME (tag 117) so radiod reaps this channel by itself if we stop
	// refreshing it -- see audioLifetimeFrames and keepaliveAudioChannels.
	buf = encodeInt32(&buf, tagLifetime, audioLifetimeFrames)

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

// Bounds for the SPECTRUM_AVG value radiod is given: how many FFTs it folds into
// each spectrum response.
//
// This trades update speed against noise. radiod's own default is 10, which costs
// twice over: it smooths the waterfall so transients take several frames to
// appear, and it runs ten FFTs per poll instead of one. The FFT cost is the bigger
// problem, because the spectrum thread deliberately runs below the demods
// (upstream spectrum.c "Drop below demods") so it is starved first under load --
// and the channel command queue is only two deep and drops silently when full,
// turning that into missed frames rather than late ones.
//
// Below 1 is meaningless; radiod clamps it to 1 itself. Above 10 is radiod's own
// default, which is slow enough to look broken. Configurable via
// spectrum.spectrum_fft_averages.
const (
	defaultSpectrumFFTAverages = 4
	minSpectrumFFTAverages     = 1
	maxSpectrumFFTAverages     = 10
)

// buildCreateSpectrumCommand builds the packet that creates a spectrum channel.
func buildCreateSpectrumCommand(frequency uint64, binCount int, binBandwidth float64, ssrc uint32, fftAverages int) []byte {
	buf := make([]byte, 0, 1500)

	buf = append(buf, pktTypeCmd)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)

	// RADIO_FREQUENCY must come before PRESET
	buf = encodeDouble(&buf, tagRadioFrequency, float64(frequency))

	// PRESET must come early to set demod_type: it calls loadpreset(), which sets
	// demod_type=SPECT_DEMOD and the default parameters we then override below.
	buf = encodeString(&buf, tagPreset, "spectrum")

	// Bin count and resolution bandwidth are the only spectrum geometry we send.
	// LOW_EDGE/HIGH_EDGE are deliberately omitted: radiod derives the filter for a
	// spectrum channel from these two values itself (upstream spectrum.c
	// setup_wideband/setup_narrowband), and the forked radiod logs any edges we do
	// send as "informational for spectrum" and ignores them.  Sending them upstream
	// is worse than useless -- the decoder applies them to chan->filter for every
	// demod type and clamps to +/- output.samprate/2, triggering a filter rebuild on
	// every zoom and pan before setup_*() overwrites them anyway.
	buf = encodeInt32(&buf, tagBinCount, uint32(binCount))
	buf = encodeFloat(&buf, tagNoncoherentBinBw, float32(binBandwidth))

	// SPECTRUM_AVG; see the bounds constants above. radiod defaults to 10.
	buf = encodeInt32(&buf, tagSpectrumAvg, uint32(fftAverages))

	// LIFETIME so the channel reaps itself if we stop polling it.
	// Spectrum channels emit status ONLY in reply to a poll (upstream spectrum.c
	// sets output_interval = 0 and output.silent = true), so an unpolled one never
	// enters our status cache and the orphan sweep can never discover it -- it
	// would burn CPU forever, invisible.  The poll loop in user_spectrum.go is the
	// keepalive: every poll is a command, and every command reloads this counter.
	buf = encodeInt32(&buf, tagLifetime, spectrumLifetimeFrames)

	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)
	return buf
}

// CreateSpectrumChannel creates a new radiod spectrum channel with specified parameters
// CRITICAL: Must send PRESET first to set demod_type, then override parameters
func (rc *RadiodController) CreateSpectrumChannel(name string, frequency uint64, binCount int, binBandwidth float64, ssrc uint32) error {
	log.Printf("CreateSpectrumChannel called: name=%s, freq=%d, bins=%d, bw=%.1f, ssrc=0x%08x",
		name, frequency, binCount, binBandwidth, ssrc)

	// Send command
	if err := rc.sendCommand(buildCreateSpectrumCommand(frequency, binCount, binBandwidth, ssrc, rc.fftAverages())); err != nil {
		return fmt.Errorf("failed to send create spectrum command: %w", err)
	}

	log.Printf("Spectrum channel created: SSRC 0x%08x, freq=%d Hz, bins=%d, bw=%.1f Hz (span %.1f Hz)",
		ssrc, frequency, binCount, binBandwidth, float64(binCount)*binBandwidth)
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
	// No LOW_EDGE/HIGH_EDGE follows: radiod recomputes the spectrum filter from
	// bin count and bin bandwidth on its own.  See CreateSpectrumChannel.
	if binBandwidth > 0 {
		buf = encodeFloat(&buf, 0x5d, float32(binBandwidth))
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
			buf = encodeFloat(&buf, tagSquelchOpen, -999.0)
			buf = encodeFloat(&buf, tagSquelchClose, -999.0)
		} else if squelchClose != nil {
			// Normal squelch operation with both thresholds
			buf = encodeFloat(&buf, tagSquelchOpen, *squelchOpen)
			buf = encodeFloat(&buf, tagSquelchClose, *squelchClose)
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
//
// Note: SNR_SQUELCH (tag 57) is deliberately not sent.  This code used to send
// tag 0x5C labelled "SNR_SQUELCH ... CRITICAL for squelch to work!", but 0x5C is
// 92, not 57 -- 92 is COHERENT_BIN_SPACING in the forked radiod and UNUSED2
// upstream, and neither version has a decode case for it, so the write was
// always silently discarded.  Squelch gating lives in ubersdr's audio gate
// (set_audio_gate / min_snr), not in radiod, so nothing depended on it.  If
// radiod-side squelch is ever wanted, send tagSnrSquelch and re-test: enabling
// it changes the linear demod's audio path (upstream linear.c:349).
func (rc *RadiodController) UpdateSquelch(ssrc uint32, squelchOpen, squelchClose float32) error {
	// Build control command with SSRC to identify the channel
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12) - identifies which channel to update
	buf = encodeInt32(&buf, 0x12, ssrc)

	// Check for special "always open" value (-999)
	if squelchOpen == -999 {
		// Always open mode - send -999 for both thresholds
		buf = encodeFloat(&buf, tagSquelchOpen, -999.0)
		buf = encodeFloat(&buf, tagSquelchClose, -999.0)
	} else {
		// Normal squelch operation
		buf = encodeFloat(&buf, tagSquelchOpen, squelchOpen)
		buf = encodeFloat(&buf, tagSquelchClose, squelchClose)
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

// spectrumLifetimeFrames is the LIFETIME set on spectrum channels, in radiod
// blocks of 20 ms: 250 frames = 5 seconds.
//
// Every poll reloads the counter, so this only has to outlast the gap between
// polls.  The slowest regular poll is background_poll_period_ms (250 ms, for
// noise floor and frequency reference), giving 20x margin -- enough headroom for
// a per-session PollDivisor or a stalled tick without killing a channel out from
// under a live user.
//
// Audio channels deliberately do not get one.  They push status every 100 ms via
// STATUS_INTERVAL, so they stay in the status cache and the existing orphan sweep
// already reaps them after a restart.
const spectrumLifetimeFrames = 250

// audioLifetimeFrames is the LIFETIME set on audio channels, in radiod blocks of
// 20 ms: 750 frames = 15 seconds.
//
// Audio channels are kept alive by SessionManager.keepaliveAudioChannels, which
// refreshes every audioKeepaliveInterval (3 s), so five refreshes have to be
// missed before radiod reaps a channel. The margin exists because the failure
// mode is asymmetric: an orphan lingering costs some CPU, whereas a refresh
// delayed past the lifetime kills a LIVE user's audio mid-session.
//
// Five is enough because the keepalive does very little -- it snapshots the
// session map under a read lock and sends one small UDP datagram per channel,
// outside the lock. Starving that for 15 seconds means the process is already
// too wedged to be serving audio. Tightening further mainly buys faster orphan
// cleanup, which matters much less than not cutting off a listener.
//
// This is what lets radiod reap our channels on its own if ubersdr dies, without
// ubersdr having to hunt for channels afterwards -- and, importantly, without it
// touching channels it did not create.
const audioLifetimeFrames = 750

// terminateLifetimeFrames is the LIFETIME value sent to tear a channel down:
// one block, so radiod destroys the channel on its next pass through
// downconvert().  The lifetime check is the first thing in that loop, so it
// runs even though frequency 0 leaves the channel with no front end coverage.
const terminateLifetimeFrames = 1

// buildTerminateCommand builds the packet that tears down a channel.
//
// It carries two things, because the two radiod versions kill channels
// differently and this has to work on both during the migration:
//
//   - RADIO_FREQUENCY = 0 mutes the channel immediately on either version, and
//     is what actually destroys it on the forked radiod (which expires channels
//     parked at 0 Hz after Channel_idle_timeout).
//   - LIFETIME = 1 is what destroys it upstream, where the freq == 0 special
//     case was removed and the default lifetime is infinite.  The forked radiod
//     has no decode case for tag 117 and silently ignores it.
//
// Sending both means teardown works before, during and after the radiod swap.
func buildTerminateCommand(ssrc uint32) []byte {
	buf := make([]byte, 0, 64)
	buf = append(buf, pktTypeCmd)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)
	buf = encodeDouble(&buf, tagRadioFrequency, 0)
	buf = encodeInt32(&buf, tagLifetime, terminateLifetimeFrames)
	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)
	return buf
}

// buildPollCommand builds the packet that asks a channel for a status update.
//
// It carries LIFETIME as well as the SSRC; see UserSpectrumManager.sendPoll for
// why the lifetime is restated on every poll rather than left to radiod's
// reload-on-any-command behaviour.
func buildPollCommand(ssrc uint32) []byte {
	buf := make([]byte, 0, 64)
	buf = append(buf, pktTypeCmd)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)
	buf = encodeInt32(&buf, tagLifetime, spectrumLifetimeFrames)
	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)
	return buf
}

// buildKeepaliveCommand builds the packet that refreshes a channel's lifetime.
//
// radiod reloads the countdown on ANY command for the SSRC, so the tag is
// restated rather than relied on: if this command were ever to recreate a
// channel that had already gone, it must come back with a finite lifetime
// instead of the template's infinite one.
func buildKeepaliveCommand(ssrc uint32, lifetimeFrames uint32) []byte {
	buf := make([]byte, 0, 64)
	buf = append(buf, pktTypeCmd)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)
	buf = encodeInt32(&buf, tagLifetime, lifetimeFrames)
	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)
	return buf
}

// RefreshAudioLifetime resets the self-destruct timer on an audio channel.
func (rc *RadiodController) RefreshAudioLifetime(ssrc uint32) error {
	if err := rc.sendCommand(buildKeepaliveCommand(ssrc, audioLifetimeFrames)); err != nil {
		return fmt.Errorf("failed to refresh lifetime for SSRC 0x%08x: %w", ssrc, err)
	}
	return nil
}

// DisableChannel tears down a channel: frequency 0 to mute it, LIFETIME to
// destroy it.  See buildTerminateCommand.
func (rc *RadiodController) DisableChannel(name string, ssrc uint32) error {
	if err := rc.sendCommand(buildTerminateCommand(ssrc)); err != nil {
		return fmt.Errorf("failed to send disable command: %w", err)
	}

	log.Printf("Disabled channel: %s (SSRC: 0x%08x)", name, ssrc)
	return nil
}

// TerminateChannel tears a channel down and immediately evicts it from the
// status cache so the admin panel stops showing it.
// A torn-down channel goes silent, so radiod stops refreshing its STATUS packet.
// Without the eager eviction the cache entry lingers for up to 30 seconds
// (the cleanupStaleEntries threshold), causing the admin panel to show the channel
// long after radiod has expired it.
func (rc *RadiodController) TerminateChannel(name string, ssrc uint32) error {
	// DisableChannel carries both kill mechanisms; see buildTerminateCommand.
	// Do not try to force termination with DEMOD_TYPE=-1 or an OUTPUT_SAMPRATE
	// change: that makes radiod reload presets, which recreates the channel.
	err := rc.DisableChannel(name, ssrc)
	// Eagerly remove from the status cache so the admin panel reflects the
	// termination immediately rather than waiting up to 30 s for stale cleanup.
	if rc.frontendTracker != nil {
		rc.frontendTracker.mu.Lock()
		delete(rc.frontendTracker.channelStatus, ssrc)
		rc.frontendTracker.mu.Unlock()
	}
	return err
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

	if rc.conn == nil {
		return fmt.Errorf("radiod connection not initialised")
	}

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
