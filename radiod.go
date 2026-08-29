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

	// frontendSamprate is the front end's sample rate, which is what decides how
	// expensive radiod's wideband spectrum algorithm is: setup_wideband() takes
	// fft_n = samprate / bin_bw. Zero means "not configured", in which case
	// spectrumAveragesFor leaves the wideband side alone.
	frontendSamprate int

	// Rate limit for spectrum retune commands, built on first use so that a
	// zero-value controller still works. See radiod_spectrum_pacing.go.
	pacerOnce sync.Once
	pacer     *spectrumUpdatePacer

	// SSRCs torn down within the last terminatedSSRCTTL, and refused until it
	// expires. See markTerminated.
	terminatedMu sync.Mutex
	terminated   map[uint32]time.Time

	// Bin count each live spectrum channel was created with, so an update can
	// never ask for more than its buffer holds. See spectrumBinCeiling.
	spectrumBinsMu sync.Mutex
	spectrumBins   map[uint32]int

	// Spacing between commands to one audio channel, so two of ours never land
	// in the same radiod block and get one of them dropped. See
	// radiod_audio_pacing.go.
	audioPacerOnce sync.Once
	audioCmdPacer  *audioCommandPacer
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

// SetFrontendSamprate records the front end's sample rate for spectrumAveragesFor.
//
// Taken from ReceiverConfig.Samprate() rather than from a status packet so it is
// known before the first channel is created, and so it is the same number the
// waterfall geometry is built from (websdr_scale.go). receiver_span.go already
// warns if radiod reports a different one.
func (rc *RadiodController) SetFrontendSamprate(hz int) {
	if hz < 0 {
		hz = 0
	}
	rc.frontendSamprate = hz
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

	// Status for an SSRC we have just terminated is stale on arrival; see the
	// check in handleStatusPacket.
	rc.frontendTracker.suppressed = rc.terminatedRecently

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

	// Gain is a manual output gain in dB, for linear and AM demods.
	//
	// radiod treats this as a mode switch, not just a level: decode_radio_commands
	// clears linear.agc on any GAIN command ("Doesn't make sense to change gain
	// and then have the AGC change it again", radio_status.c). Setting Gain
	// therefore turns the AGC off as a side effect, so pair it with Enable only
	// when that is what you mean -- see the encode order in SetAGC.
	Gain *float32
}

// buildAGCCommand assembles the AGC control packet. Split out from SetAGC so
// the tag order -- which radiod is sensitive to -- can be tested without a
// radiod to send it to.
func buildAGCCommand(ssrc uint32, params AGCParams) []byte {
	buf := make([]byte, 0, 64)

	// CMD packet type
	buf = append(buf, pktTypeCmd)

	// Identify the channel
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)

	if params.HangTime != nil {
		buf = encodeFloat(&buf, tagAgcHangtime, *params.HangTime)
	}
	if params.RecoveryRate != nil {
		buf = encodeFloat(&buf, tagAgcRecoveryRate, *params.RecoveryRate)
	}
	if params.Threshold != nil {
		buf = encodeFloat(&buf, tagAgcThreshold, *params.Threshold)
	}
	// Gain goes before Enable deliberately. radiod decodes tags in packet order
	// and GAIN clears the AGC flag, so a caller that sets both gets the enable
	// it asked for rather than having it silently undone.
	if params.Gain != nil {
		buf = encodeFloat(&buf, tagGain, *params.Gain)
	}
	if params.Enable != nil {
		val := byte(0)
		if *params.Enable {
			val = 1
		}
		buf = encodeByte(&buf, tagAgcEnable, val)
	}

	// LIFETIME, so that an update racing a teardown cannot leave an immortal
	// channel behind: radiod creates a channel for any command naming an unknown
	// SSRC, and one created from the template inherits an infinite lifetime.
	// markTerminated is what normally stops that; this is the backstop.
	buf = encodeInt32(&buf, tagLifetime, audioLifetimeFrames)

	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))
	buf = append(buf, tagEOL)

	return buf
}

// SetAGC sends AGC parameter overrides to an existing channel identified by ssrc.
// Only non-nil fields in params are sent; nil fields leave the current value unchanged.
func (rc *RadiodController) SetAGC(ssrc uint32, params AGCParams) error {
	buf := buildAGCCommand(ssrc, params)

	if err := rc.sendAudioCommand(ssrc, buf); err != nil {
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

	// A create is the one command that legitimately follows a teardown of the
	// same SSRC; see clearTerminated.
	rc.clearTerminated(ssrc)

	if DebugMode {
		log.Printf("DEBUG: Sending CreateChannel command (%d bytes) to %s", len(buf), rc.statusAddr)
		if squelchOpen != nil || squelchClose != nil {
			log.Printf("DEBUG: Squelch - open: %v, close: %v", squelchOpen, squelchClose)
		}
	}

	// Send command
	if err := rc.sendAudioCommand(ssrc, buf); err != nil {
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

// maxSpectrumAveragingWindow bounds how much signal history one spectrum frame
// may be an average of.
//
// The averaging count alone does not say that. radiod builds each response from
// fft_avg FFTs of fft_n samples, and it chooses fft_n so that the channel's
// sample rate is fft_n * bin_bw -- so one FFT always spans 1/bin_bw seconds and
// the whole response spans fft_avg/bin_bw. That is the resolution bandwidth's
// own reciprocal, which no amount of engineering removes: 2 Hz bins need half a
// second of signal. What is removable is the *averaging* on top of it, which at
// 2 Hz/bin and the default four FFTs stretches one frame to two seconds of
// history.
//
// Two seconds is long enough that panning appears to do nothing: radiod retunes
// on the next block, but the ring it is averaging still holds the old
// frequency's samples, and dragging keeps refilling it faster than it drains.
// So the count is reduced at deep zoom to hold the window near this, trading
// a noisier trace for one that answers the mouse. At the shallow end nothing
// changes -- 10 Hz/bin with four averages is already only 0.4 s.
const maxSpectrumAveragingWindow = 0.5 // seconds

// maxWidebandTransformPoints bounds the transform work one wideband spectrum
// response may cost.
//
// radiod has two spectrum algorithms and the bin bandwidth picks between them.
// Above the crossover it uses the wideband one, and src/spectrum.c
// setup_wideband() sizes that from the FRONT END, not from the view:
//
//	fft_n = frontend samprate / bin_bw
//
// bin_count does not appear. So a 469 kHz view at 458 Hz/bin on a 129.6 Msps
// receiver makes radiod transform 283,116 points and keep 1,024 of them, and
// wideband_poll() does that fft_avg times per response. The length doubles with
// every zoom step, without limit -- setup_wideband's own comment says "should
// limit to a sane value" and then does not.
//
// Measured on a 129.6 Msps receiver, one websdr client per row, four averages
// at a 10 Hz poll:
//
//	view       bin_bw    fft_n     thread CPU
//	3.75 MHz   3662 Hz    35,389        12.0%
//	937 kHz     916 Hz   141,558        46.9%
//	469 kHz     458 Hz   283,116        97.2%
//
// which is 8.6e-5 %% per (fft_n x fft_avg) point across all three. This budget is
// 2^18 points, a little above what the top row already costs, so the shallow
// views that are affordable today keep all their averaging and only the deep ones
// give it up.
//
// Averaging is the right thing to trade there. It is a plain multiplier on the
// wideband cost, and at 458 Hz/bin four averages span 8.7 ms of a 100 ms frame
// interval -- it buys a little smoothness, not the frequency resolution or the
// span, both of which are untouched by this. radiod normalises the accumulator by
// fft_avg (gain = 2/(fft_avg * fft_n * fft_n)), so the levels do not move either;
// only the variance grows.
//
// It does NOT fix the underlying waste -- 99.6%% of that transform is still
// discarded -- it just bounds it. Asking radiod for a bin bandwidth on the
// narrowband side of the crossover is the real repair; see websdrSpectrumParams.
const maxWidebandTransformPoints = 1 << 18

// spectrumAveragesFor returns the SPECTRUM_AVG to use at a given bin bandwidth:
// the configured value, reduced where it would otherwise average over more than
// maxSpectrumAveragingWindow of signal, or cost more than
// maxWidebandTransformPoints of transform.
//
// The window is computed as fft_avg/bin_bw, which assumes radiod's spectrum
// overlap is zero. Any overlap makes the real window shorter, so this errs
// toward responsiveness rather than toward the lag it exists to prevent.
//
// The two limits bite at opposite ends -- the window at deep zoom below the
// crossover, the transform budget at deep zoom above it -- so neither can be
// dropped in favour of the other.
func (rc *RadiodController) spectrumAveragesFor(binBandwidth float64) int {
	configured := rc.fftAverages()
	if binBandwidth <= 0 {
		return configured
	}
	allowed := int(maxSpectrumAveragingWindow * binBandwidth)
	if n := rc.widebandAveragesFor(binBandwidth); n < allowed {
		allowed = n
	}
	if allowed >= configured {
		return configured
	}
	if allowed < minSpectrumFFTAverages {
		return minSpectrumFFTAverages
	}
	return allowed
}

// widebandAveragesFor returns how many averages maxWidebandTransformPoints
// affords at a bin bandwidth, or configured (i.e. no opinion) when this is not a
// wideband request or the front end sample rate was never set.
func (rc *RadiodController) widebandAveragesFor(binBandwidth float64) int {
	configured := rc.fftAverages()
	if rc.frontendSamprate <= 0 || binBandwidth <= radiodSpectrumCrossoverHz {
		// At or below the crossover radiod downconverts instead, and fft_n is
		// then about the bin count -- the front end's rate does not enter it.
		return configured
	}
	fftN := math.Round(float64(rc.frontendSamprate) / binBandwidth)
	if fftN < 1 {
		return configured
	}
	return int(maxWidebandTransformPoints / fftN)
}

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

	// Nothing held for a previous life of this SSRC may land on the new channel.
	rc.spectrumPacer().Cancel(ssrc)
	// ...and this SSRC is wanted again; see clearTerminated.
	rc.clearTerminated(ssrc)

	// Send command
	if err := rc.sendCommand(buildCreateSpectrumCommand(frequency, binCount, binBandwidth, ssrc, rc.spectrumAveragesFor(binBandwidth))); err != nil {
		return fmt.Errorf("failed to send create spectrum command: %w", err)
	}

	rc.noteSpectrumBins(ssrc, binCount)

	log.Printf("Spectrum channel created: SSRC 0x%08x, freq=%d Hz, bins=%d, bw=%.1f Hz (span %.1f Hz)",
		ssrc, frequency, binCount, binBandwidth, float64(binCount)*binBandwidth)
	return nil
}

// A radiod spectrum channel's bin_data buffer is sized once and never resized.
//
// ka9q-radio src/spectrum.c means to reallocate it whenever bin_count changes,
// but the guard compares chan->spectrum.bin_count against a local that the
// reinitialisation block a few lines earlier has already set to the same value,
// so only its "buffer is NULL" arm can ever fire. Every later change leaves the
// buffer at its original size while narrowband_poll and wideband_poll memset
// and fill bin_count entries into it.
//
// Asking a live channel for more bins than it was created with therefore writes
// past the end of a heap block, and radiod aborts with glibc's "corrupted size
// vs. prev_size in fastbins" -- taking every user's audio and waterfall with it,
// not just the one that asked. Fewer bins is harmless: the buffer is merely
// larger than needed.
//
// This is enforced here rather than in each caller because the consequence is
// a dead receiver, and a future protocol has no way to know the rule exists.
// Drop it if upstream fixes the guard and UPSTREAM_REF moves past the fix.
func (rc *RadiodController) noteSpectrumBins(ssrc uint32, binCount int) {
	if binCount <= 0 {
		return
	}
	rc.spectrumBinsMu.Lock()
	if rc.spectrumBins == nil {
		rc.spectrumBins = make(map[uint32]int)
	}
	rc.spectrumBins[ssrc] = binCount
	rc.spectrumBinsMu.Unlock()
}

// spectrumBinCeiling returns the largest bin count this SSRC's channel can
// safely be asked for, or 0 when we did not create it and so cannot know.
func (rc *RadiodController) spectrumBinCeiling(ssrc uint32) int {
	rc.spectrumBinsMu.Lock()
	defer rc.spectrumBinsMu.Unlock()
	return rc.spectrumBins[ssrc]
}

// forgetSpectrumBins drops the record for a torn-down SSRC, so a later channel
// on the same SSRC is measured against its own creation count.
func (rc *RadiodController) forgetSpectrumBins(ssrc uint32) {
	rc.spectrumBinsMu.Lock()
	delete(rc.spectrumBins, ssrc)
	rc.spectrumBinsMu.Unlock()
}

// UpdateSpectrumChannel updates spectrum channel parameters (for zoom/pan)
// binCount is needed to calculate filter edges when binBandwidth changes
// If binCount changes, it will also be sent to radiod
func (rc *RadiodController) UpdateSpectrumChannel(ssrc uint32, frequency uint64, binBandwidth float64, binCount int, sendBinCount bool) error {
	// Never above what the channel was created with; see noteSpectrumBins.
	if ceiling := rc.spectrumBinCeiling(ssrc); ceiling > 0 && binCount > ceiling {
		log.Printf("radiod: refusing to raise SSRC 0x%08x from %d to %d spectrum bins -- "+
			"radiod would overrun its bin_data buffer and abort; capping at %d",
			ssrc, ceiling, binCount, ceiling)
		binCount = ceiling
	}

	// Paced rather than sent outright: radiod drops commands that arrive faster
	// than it drains them, and where a channel ends up then depends on which of
	// a burst happened to survive. See radiod_spectrum_pacing.go.
	return rc.spectrumPacer().Submit(ssrc, spectrumUpdate{
		frequency:    frequency,
		binBandwidth: binBandwidth,
		binCount:     binCount,
		sendBinCount: sendBinCount,
		fftAverages:  rc.spectrumAveragesFor(binBandwidth),
	})
}

// buildUpdateSpectrumCommand encodes a spectrum retune command.
func buildUpdateSpectrumCommand(ssrc uint32, u spectrumUpdate) []byte {
	// Build control command to update spectrum parameters
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, 1) // CMD = 1

	// Add SSRC (tag 18 = 0x12)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) if changed
	if u.frequency > 0 {
		buf = encodeDouble(&buf, tagRadioFrequency, float64(u.frequency))
	}

	// Add BIN_COUNT (tag 94 = 0x5e) if it changed
	if u.sendBinCount && u.binCount > 0 {
		buf = encodeInt32(&buf, tagBinCount, uint32(u.binCount))
	}

	// Add NONCOHERENT_BIN_BW (tag 93 = 0x5d) if changed
	// No LOW_EDGE/HIGH_EDGE follows: radiod recomputes the spectrum filter from
	// bin count and bin bandwidth on its own.  See CreateSpectrumChannel.
	if u.binBandwidth > 0 {
		buf = encodeFloat(&buf, tagNoncoherentBinBw, float32(u.binBandwidth))
		// The averaging window scales with 1/bin_bw, so a zoom that changes the
		// bandwidth changes how much history each frame covers. Re-send the
		// count with it. See spectrumAveragesFor.
		if u.fftAverages > 0 {
			buf = encodeInt32(&buf, tagSpectrumAvg, uint32(u.fftAverages))
		}
	}

	// LIFETIME, so that an update racing a teardown cannot leave an immortal
	// channel behind: radiod creates a channel for any command naming an unknown
	// SSRC, and one created from the template inherits an infinite lifetime.
	// markTerminated is what normally stops that; this is the backstop.
	buf = encodeInt32(&buf, tagLifetime, spectrumLifetimeFrames)

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, tagEOL)

	return buf
}

// UpdateChannel updates an existing channel's frequency, mode, and/or bandwidth edges
// This allows changing parameters without destroying and recreating the channel
// bandwidthLow and bandwidthHigh are the filter edges in Hz (can be negative for low edge)
// sendBandwidth controls whether to send bandwidth parameters
func (rc *RadiodController) UpdateChannel(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool) error {
	return rc.UpdateChannelWithAGC(ssrc, frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, nil)
}

// UpdateChannelWithAGC updates a channel and, in the same command, overrides the
// AGC parameters the preset would otherwise impose.  agc == nil leaves the AGC alone.
//
// One command, not three.  See buildUpdateCommand for why that matters.
func (rc *RadiodController) UpdateChannelWithAGC(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, agc *AGCParams) error {
	return rc.UpdateChannelFull(ssrc, frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, nil, nil, agc)
}

// UpdateChannelWithSquelch updates an existing channel including optional squelch parameters
// squelchOpen and squelchClose are pointers to allow nil (no change) vs 0.0 (valid value)
// Special value: squelchOpen=-999 sets "always open" mode (sends -999 for both thresholds)
func (rc *RadiodController) UpdateChannelWithSquelch(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, squelchOpen, squelchClose *float32) error {
	return rc.UpdateChannelFull(ssrc, frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, squelchOpen, squelchClose, nil)
}

// UpdateChannelFull is the one place a channel update is sent, carrying every
// parameter that may have to change together.
func (rc *RadiodController) UpdateChannelFull(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, squelchOpen, squelchClose *float32, agc *AGCParams) error {
	if err := rc.sendAudioCommand(ssrc, buildUpdateCommand(ssrc, frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, squelchOpen, squelchClose, agc)); err != nil {
		return fmt.Errorf("failed to send update command: %w", err)
	}
	return nil
}

// buildUpdateCommand builds the channel update packet.
//
// Everything a retune changes travels in this one packet, and the tag order is
// load-bearing.  Both facts come from how radiod handles commands:
//
//   - Its per-channel command queue holds exactly one entry, and a command
//     arriving while that entry is still pending is DROPPED, silently
//     (ka9q-radio src/radio_status.c, "An entry already exists. Drop ours").
//     The channel thread drains the queue once per block, so two commands sent
//     back to back are a coin toss.  This is what a mode change used to work
//     around by sleeping 500 ms between sending the mode and sending the
//     bandwidth -- half a second in which the channel ran the preset's filter
//     and the preset's AGC instead of the ones asked for.  One packet cannot
//     race itself.
//
//   - Tags are decoded in packet order (decode_radio_commands), and PRESET
//     loads a preset that overwrites the filter edges and the AGC settings.
//     So PRESET goes first and everything it would clobber goes after it,
//     where it wins: LOW_EDGE/HIGH_EDGE assign chan->filter.min_IF/max_IF
//     directly, and AGC_HANGTIME/AGC_RECOVERY_RATE/AGC_THRESHOLD assign
//     chan->linear.*.  If the preset also changed the demod type or sample
//     rate, radiod restarts the demod thread afterwards and rebuilds the
//     filter from those same overridden edges.
//
// Moving PRESET after the edges, or splitting this packet in two, silently
// restores the old behaviour -- see TestBuildUpdateCommandOrdering.
func buildUpdateCommand(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, squelchOpen, squelchClose *float32, agc *AGCParams) []byte {
	buf := make([]byte, 0, 1500)

	// Start with CMD packet type
	buf = append(buf, pktTypeCmd)

	// Add SSRC (tag 18 = 0x12) - identifies which channel to update
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)

	// Add RADIO_FREQUENCY (tag 33 = 0x21) if provided
	if frequency > 0 {
		buf = encodeDouble(&buf, tagRadioFrequency, float64(frequency))
	}

	// Add PRESET (tag 85 = 0x55) if provided.  Everything below overrides it.
	if mode != "" {
		buf = encodeString(&buf, tagPreset, mode)
	}

	// Add bandwidth via LOW_EDGE and HIGH_EDGE if requested
	if sendBandwidth {
		buf = encodeFloat(&buf, tagLowEdge, float32(bandwidthLow))
		buf = encodeFloat(&buf, tagHighEdge, float32(bandwidthHigh))
	}

	// AGC overrides.  A preset reload resets all of these, so on a mode change
	// they have to ride along with the mode rather than chase it.
	if agc != nil {
		if agc.Enable != nil {
			val := byte(0)
			if *agc.Enable {
				val = 1
			}
			buf = encodeByte(&buf, tagAgcEnable, val)
		}
		if agc.HangTime != nil {
			buf = encodeFloat(&buf, tagAgcHangtime, *agc.HangTime)
		}
		if agc.RecoveryRate != nil {
			buf = encodeFloat(&buf, tagAgcRecoveryRate, *agc.RecoveryRate)
		}
		if agc.Threshold != nil {
			buf = encodeFloat(&buf, tagAgcThreshold, *agc.Threshold)
		}
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
	buf = encodeInt32(&buf, tagStatusInterval, 5)

	// LIFETIME, so that an update racing a teardown cannot leave an immortal
	// channel behind: radiod creates a channel for any command naming an unknown
	// SSRC, and one created from the template inherits an infinite lifetime.
	// markTerminated is what normally stops that; this is the backstop.
	buf = encodeInt32(&buf, tagLifetime, audioLifetimeFrames)

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, tagCommandTag, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, tagEOL)

	return buf
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

	// LIFETIME, so that an update racing a teardown cannot leave an immortal
	// channel behind: radiod creates a channel for any command naming an unknown
	// SSRC, and one created from the template inherits an infinite lifetime.
	// markTerminated is what normally stops that; this is the backstop.
	buf = encodeInt32(&buf, tagLifetime, audioLifetimeFrames)

	// Add COMMAND_TAG (tag 1 = 0x01)
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix()))

	// Add EOL marker
	buf = append(buf, 0)

	// Send command
	if err := rc.sendAudioCommand(ssrc, buf); err != nil {
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
// downconvert().  The lifetime check is the first thing in that loop, so the
// channel goes silent on that same pass.
const terminateLifetimeFrames = 1

// buildTerminateCommand builds the packet that tears down a channel.
//
// LIFETIME = 1 is the whole mechanism: the channel expires on radiod's next pass
// through downconvert().  The packet used to carry RADIO_FREQUENCY = 0 as well,
// which is how the forked radiod killed channels (it expired ones parked at
// 0 Hz after Channel_idle_timeout); upstream removed that special case, and the
// fork is no longer deployed, so the tag is gone.
func buildTerminateCommand(ssrc uint32) []byte {
	buf := make([]byte, 0, 64)
	buf = append(buf, pktTypeCmd)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)
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
	if err := rc.sendAudioCommand(ssrc, buildKeepaliveCommand(ssrc, audioLifetimeFrames)); err != nil {
		return fmt.Errorf("failed to refresh lifetime for SSRC 0x%08x: %w", ssrc, err)
	}
	return nil
}

// terminatedSSRCTTL is how long a torn-down SSRC keeps refusing commands.
//
// It only has to outlast whatever was already in flight for that SSRC when the
// teardown happened: a keepalive SessionManager snapshotted before the session
// left the map, a spectrum poll dispatched in its own goroutine, or the initial
// AGC push that websocket.go delays by 500 ms. Ten seconds covers all of those
// with room to spare, and is short of audioLifetimeFrames, so even a leaked
// entry could not keep a legitimate channel down longer than radiod's own reap.
const terminatedSSRCTTL = 10 * time.Second

// markTerminated starts refusing commands for an SSRC we have just torn down.
//
// radiod creates a channel for ANY command naming an unknown SSRC (upstream
// lookup_or_create_chan), so a command that lands after the terminate does not
// get ignored -- it brings the channel back, at 0 Hz with the template's
// parameters, making no audio and belonging to no session. Measured against the
// pinned radiod (upstream cce087e2, run under a sig_gen front end): a keepalive
// 150 ms after a terminate resurrects the channel carrying LIFETIME =
// audioLifetimeFrames, and it then sits there for the full 15 seconds before
// reaping itself -- which is exactly what "sessions take 15 seconds to go away"
// looks like from outside. A command with no LIFETIME tag is worse: the
// template's lifetime is infinite, so that channel never goes away at all.
//
// Ordering alone cannot fix this. Polls go out in their own goroutines and
// keepaliveAudioChannels snapshots its targets under a read lock and sends
// outside it, so there is always a send that can already be in flight when the
// terminate goes out. The refusal therefore lives at the socket, which every
// sender has to pass through.
func (rc *RadiodController) markTerminated(ssrc uint32) {
	now := time.Now()

	rc.terminatedMu.Lock()
	if rc.terminated == nil {
		rc.terminated = make(map[uint32]time.Time)
	}
	// Expire on the way past rather than from a timer: entries are only added on
	// teardown, so sweeping here keeps the map bounded without another goroutine.
	for s, at := range rc.terminated {
		if now.Sub(at) > terminatedSSRCTTL {
			delete(rc.terminated, s)
		}
	}
	rc.terminated[ssrc] = now
	rc.terminatedMu.Unlock()

	// Nothing more will be sent to this channel, so stop tracking when it last
	// was -- otherwise a long-lived receiver keeps one entry per session it has
	// ever served.
	rc.audioPacer().Forget(ssrc)

	// Drop it from the status cache in the same breath, so the admin panel stops
	// showing the channel at once rather than waiting for the stale sweep. Taken
	// after terminatedMu is released: the status listener consults
	// terminatedRecently before it takes fst.mu, and the two must not nest in
	// opposite orders.
	if rc.frontendTracker != nil {
		rc.frontendTracker.mu.Lock()
		delete(rc.frontendTracker.channelStatus, ssrc)
		delete(rc.frontendTracker.frontendStatus, ssrc)
		rc.frontendTracker.mu.Unlock()
	}
}

// clearTerminated readmits an SSRC.
//
// Creating a channel is the one command that legitimately follows a teardown of
// the same SSRC: allocateSSRC can hand the number straight back out, and
// noise_floor's reconnectBand deliberately reuses its own.
func (rc *RadiodController) clearTerminated(ssrc uint32) {
	rc.terminatedMu.Lock()
	delete(rc.terminated, ssrc)
	rc.terminatedMu.Unlock()
}

// terminatedRecently reports whether commands for ssrc are currently refused.
func (rc *RadiodController) terminatedRecently(ssrc uint32) bool {
	rc.terminatedMu.Lock()
	defer rc.terminatedMu.Unlock()
	at, ok := rc.terminated[ssrc]
	if !ok {
		return false
	}
	if time.Since(at) > terminatedSSRCTTL {
		delete(rc.terminated, ssrc)
		return false
	}
	return true
}

// commandSSRC returns the OUTPUT_SSRC a command packet carries.
//
// It mirrors radiod's own get_ssrc() (upstream decode_status.c): walk the TLVs
// and take the first OUTPUT_SSRC. Reading the SSRC back out of the encoded
// packet, rather than threading it through every call site, is deliberate --
// the check then covers every sender, including any that builds a packet inline.
func commandSSRC(cmd []byte) (uint32, bool) {
	if len(cmd) < 3 || cmd[0] != pktTypeCmd {
		return 0, false
	}
	buf := cmd[1:]
	for i := 0; i < len(buf); {
		tag := buf[i]
		i++
		if tag == tagEOL || i >= len(buf) {
			return 0, false
		}
		optlen := int(buf[i])
		i++
		if optlen&0x80 != 0 {
			n := optlen & 0x7f
			optlen = 0
			for ; n > 0 && i < len(buf); n-- {
				optlen = optlen<<8 | int(buf[i])
				i++
			}
		}
		if i+optlen > len(buf) {
			return 0, false
		}
		if tag == tagOutputSSRC {
			var v uint32
			for _, b := range buf[i : i+optlen] {
				v = v<<8 | uint32(b)
			}
			return v, true
		}
		i += optlen
	}
	return 0, false
}

// DisableChannel tears down a channel by expiring its LIFETIME.
// See buildTerminateCommand.
func (rc *RadiodController) DisableChannel(name string, ssrc uint32) error {
	// Refuse further commands for this SSRC BEFORE the terminate goes out, so a
	// send already queued behind cmdMu cannot slip past it and resurrect the
	// channel. The terminate itself bypasses the check by going out raw.
	rc.markTerminated(ssrc)

	// The bin ceiling belonged to the channel being torn down; the next one on
	// this SSRC gets its own. See noteSpectrumBins.
	rc.forgetSpectrumBins(ssrc)

	if err := rc.sendCommandRaw(buildTerminateCommand(ssrc)); err != nil {
		log.Printf("Terminate for SSRC 0x%08x was NOT sent: %v", ssrc, err)
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
	// Anything the pacer is holding must go first. A retune landing after the
	// kill would not be ignored: radiod creates a channel for any command that
	// carries parameters, so the trailing send would resurrect this one.
	rc.spectrumPacer().Cancel(ssrc)

	// DisableChannel expires the channel's LIFETIME; see buildTerminateCommand.
	// Do not try to force termination with DEMOD_TYPE=-1 or an OUTPUT_SAMPRATE
	// change: that makes radiod reload presets, which recreates the channel.
	// DisableChannel also evicts the SSRC from the status cache and refuses its
	// late status packets; see markTerminated.
	return rc.DisableChannel(name, ssrc)
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
	if ssrc, ok := commandSSRC(cmd); ok && rc.terminatedRecently(ssrc) {
		// Sending this would recreate the channel we just tore down; see
		// markTerminated. Not an error: the caller raced a teardown, which is
		// exactly what this is here to absorb.
		log.Printf("Dropped command for SSRC 0x%08x: channel torn down within the last %v", ssrc, terminatedSSRCTTL)
		return nil
	}
	return rc.sendCommandRaw(cmd)
}

// sendCommandRaw writes a command packet to radiod with no terminated-SSRC
// check. Only the teardown path uses it directly; everything else goes through
// sendCommand.
func (rc *RadiodController) sendCommandRaw(cmd []byte) error {
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
