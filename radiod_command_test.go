package main

import (
	"net"
	"testing"
	"time"
)

// tlv is one decoded Type-Length-Value element from a radiod command packet.
type tlv struct {
	tag   byte
	value []byte
}

// parseCommandPacket decodes a command packet the way radiod's
// decode_radio_commands() does: a leading packet-type byte, then TLVs until EOL.
// It mirrors radiod's extended-length rule (high bit set means the low 7 bits
// give the number of length bytes that follow).
func parseCommandPacket(t *testing.T, buf []byte) (pktType byte, tlvs []tlv) {
	t.Helper()
	if len(buf) < 2 {
		t.Fatalf("packet too short: %d bytes", len(buf))
	}
	pktType = buf[0]
	i := 1
	for i < len(buf) {
		tag := buf[i]
		i++
		if tag == tagEOL {
			return pktType, tlvs
		}
		if i >= len(buf) {
			t.Fatalf("truncated packet: tag 0x%02x has no length byte", tag)
		}
		length := int(buf[i])
		i++
		if length&0x80 != 0 {
			n := length & 0x7f
			length = 0
			for j := 0; j < n; j++ {
				if i >= len(buf) {
					t.Fatalf("truncated extended length for tag 0x%02x", tag)
				}
				length = length<<8 | int(buf[i])
				i++
			}
		}
		if i+length > len(buf) {
			t.Fatalf("tag 0x%02x claims %d bytes, only %d remain", tag, length, len(buf)-i)
		}
		tlvs = append(tlvs, tlv{tag: tag, value: buf[i : i+length]})
		i += length
	}
	t.Fatalf("packet has no EOL terminator")
	return 0, nil
}

func findTLV(tlvs []tlv, tag byte) (tlv, bool) {
	for _, e := range tlvs {
		if e.tag == tag {
			return e, true
		}
	}
	return tlv{}, false
}

// TestBuildTerminateCommand covers the teardown packet: LIFETIME is what radiod
// kills the channel on, and dropping it silently leaks channels.  RADIO_FREQUENCY
// must NOT be there -- it only ever served the forked radiod, and a command that
// carries parameters recreates a channel that has already gone.
func TestBuildTerminateCommand(t *testing.T) {
	const ssrc = 41287

	pktType, tlvs := parseCommandPacket(t, buildTerminateCommand(ssrc))

	if pktType != pktTypeCmd {
		t.Errorf("packet type = %d, want %d (CMD)", pktType, pktTypeCmd)
	}

	got, ok := findTLV(tlvs, tagOutputSSRC)
	if !ok {
		t.Fatal("no OUTPUT_SSRC in terminate packet")
	}
	if v := decodeInt64(got.value); v != ssrc {
		t.Errorf("OUTPUT_SSRC = %d, want %d", v, ssrc)
	}

	if _, ok := findTLV(tlvs, tagRadioFrequency); ok {
		t.Error("terminate packet carries RADIO_FREQUENCY; the forked radiod it was for is gone")
	}

	got, ok = findTLV(tlvs, tagLifetime)
	if !ok {
		t.Fatal("no LIFETIME in terminate packet: upstream radiod would never kill the channel")
	}
	if v := decodeInt64(got.value); v != terminateLifetimeFrames {
		t.Errorf("LIFETIME = %d, want %d", v, terminateLifetimeFrames)
	}

	if _, ok := findTLV(tlvs, tagCommandTag); !ok {
		t.Error("no COMMAND_TAG in terminate packet")
	}
}

// TestBuildPollCommand covers the poll packet.  The LIFETIME is what stops a
// poll that races a teardown from leaving an immortal channel upstream.
func TestBuildPollCommand(t *testing.T) {
	const ssrc = 99999

	pktType, tlvs := parseCommandPacket(t, buildPollCommand(ssrc))

	if pktType != pktTypeCmd {
		t.Errorf("packet type = %d, want %d (CMD)", pktType, pktTypeCmd)
	}

	got, ok := findTLV(tlvs, tagOutputSSRC)
	if !ok {
		t.Fatal("no OUTPUT_SSRC in poll packet")
	}
	if v := decodeInt64(got.value); v != ssrc {
		t.Errorf("OUTPUT_SSRC = %d, want %d", v, ssrc)
	}

	got, ok = findTLV(tlvs, tagLifetime)
	if !ok {
		t.Fatal("no LIFETIME in poll packet: a poll racing a teardown would leave an immortal channel upstream")
	}
	if v := decodeInt64(got.value); v != spectrumLifetimeFrames {
		t.Errorf("LIFETIME = %d, want %d", v, spectrumLifetimeFrames)
	}

	// A poll must not carry a frequency: it would retune the channel it is only
	// meant to be asking for data.
	if _, ok := findTLV(tlvs, tagRadioFrequency); ok {
		t.Error("poll packet carries RADIO_FREQUENCY; a poll must not retune the channel")
	}
}

// TestSpectrumLifetimeOutlastsPolling guards the relationship the spectrum
// keepalive depends on: the lifetime has to be comfortably longer than the gap
// between polls, or channels die under live users.
func TestSpectrumLifetimeOutlastsPolling(t *testing.T) {
	const blockMillis = 20 // radiod default blocktime
	lifetimeMillis := spectrumLifetimeFrames * blockMillis

	// Slowest regular poll is background_poll_period_ms; see config.yaml.example.
	const slowestPollMillis = 250

	if lifetimeMillis < 4*slowestPollMillis {
		t.Errorf("spectrum LIFETIME is %d ms but the slowest poll period is %d ms; "+
			"too little margin for a per-session PollDivisor or a stalled tick",
			lifetimeMillis, slowestPollMillis)
	}
}

// TestBuildCreateSpectrumCommand covers the spectrum channel creation packet.
//
// SPECTRUM_AVG is the one that matters for responsiveness: radiod defaults to
// averaging 10 FFTs into every response, which both smooths the waterfall and
// runs ten FFTs per poll on a thread that is deliberately scheduled below the
// demods. Losing this tag silently returns the display to sluggish.
func TestBuildCreateSpectrumCommand(t *testing.T) {
	const (
		ssrc     = 54321
		freq     = uint64(15_000_000)
		binCount = 4096
		binBW    = 7324.21875
	)

	pktType, tlvs := parseCommandPacket(t, buildCreateSpectrumCommand(freq, binCount, binBW, ssrc, defaultSpectrumFFTAverages, radiodSpectrumCrossoverHz))

	if pktType != pktTypeCmd {
		t.Errorf("packet type = %d, want %d (CMD)", pktType, pktTypeCmd)
	}

	got, ok := findTLV(tlvs, tagSpectrumAvg)
	if !ok {
		t.Fatal("no SPECTRUM_AVG in create packet: radiod would average 10 FFTs per response")
	}
	if v := decodeInt64(got.value); v != defaultSpectrumFFTAverages {
		t.Errorf("SPECTRUM_AVG = %d, want %d", v, defaultSpectrumFFTAverages)
	}

	got, ok = findTLV(tlvs, tagBinCount)
	if !ok {
		t.Fatal("no BIN_COUNT in create packet")
	}
	if v := decodeInt64(got.value); v != binCount {
		t.Errorf("BIN_COUNT = %d, want %d", v, binCount)
	}

	if _, ok := findTLV(tlvs, tagNoncoherentBinBw); !ok {
		t.Error("no RESOLUTION_BW in create packet")
	}
	if _, ok := findTLV(tlvs, tagLifetime); !ok {
		t.Error("no LIFETIME in create packet: an unpolled spectrum channel would be immortal and invisible")
	}

	// PRESET has to be present for radiod to make this a spectrum channel at all.
	got, ok = findTLV(tlvs, tagPreset)
	if !ok {
		t.Fatal("no PRESET in create packet")
	}
	if string(got.value) != "spectrum" {
		t.Errorf("PRESET = %q, want %q", string(got.value), "spectrum")
	}

	// radiod derives the spectrum filter itself; sending edges causes a filter
	// rebuild on every zoom and pan.
	for _, tag := range []byte{tagLowEdge, tagHighEdge} {
		if _, ok := findTLV(tlvs, tag); ok {
			t.Errorf("create packet carries filter edge tag %d; radiod derives the spectrum filter itself", tag)
		}
	}
}

// TestSpectrumFFTAveragesClamping covers the controller-side clamp. radiod clamps
// anything below 1 to 1 itself, so an out-of-range value would not error -- it
// would quietly give the noisiest possible display.
func TestSpectrumFFTAveragesClamping(t *testing.T) {
	cases := []struct{ set, want int }{
		{0, defaultSpectrumFFTAverages},  // never set
		{-5, defaultSpectrumFFTAverages}, // nonsense; treated as unset, not as the noisiest setting
		{1, 1},                           // minimum
		{4, 4},                           // default
		{10, 10},                         // maximum
		{99, maxSpectrumFFTAverages},     // beyond radiod's own default
	}
	for _, c := range cases {
		rc := &RadiodController{}
		rc.SetSpectrumFFTAverages(c.set)
		if got := rc.fftAverages(); got != c.want {
			t.Errorf("SetSpectrumFFTAverages(%d) -> fftAverages() = %d, want %d", c.set, got, c.want)
		}
	}

	// A controller that was never configured must still send a sane value rather
	// than 0, which radiod would clamp to 1.
	rc := &RadiodController{}
	if got := rc.fftAverages(); got != defaultSpectrumFFTAverages {
		t.Errorf("unconfigured controller sends %d, want %d", got, defaultSpectrumFFTAverages)
	}
}

// TestBuildKeepaliveCommand covers the audio-channel keepalive.
//
// This is what lets radiod reap our own channels when ubersdr stops running,
// and it is why we no longer sweep up channels we did not create. Losing the
// LIFETIME tag here would make audio channels immortal, silently.
func TestBuildKeepaliveCommand(t *testing.T) {
	const ssrc = 12345

	pktType, tlvs := parseCommandPacket(t, buildKeepaliveCommand(ssrc, audioLifetimeFrames))

	if pktType != pktTypeCmd {
		t.Errorf("packet type = %d, want %d (CMD)", pktType, pktTypeCmd)
	}

	got, ok := findTLV(tlvs, tagOutputSSRC)
	if !ok {
		t.Fatal("no OUTPUT_SSRC in keepalive packet")
	}
	if v := decodeInt64(got.value); v != ssrc {
		t.Errorf("OUTPUT_SSRC = %d, want %d", v, ssrc)
	}

	got, ok = findTLV(tlvs, tagLifetime)
	if !ok {
		t.Fatal("no LIFETIME in keepalive packet: audio channels would never be reaped")
	}
	if v := decodeInt64(got.value); v != audioLifetimeFrames {
		t.Errorf("LIFETIME = %d, want %d", v, audioLifetimeFrames)
	}

	// A keepalive must not carry a frequency: it would retune a channel it is
	// only meant to be keeping alive.
	if _, ok := findTLV(tlvs, tagRadioFrequency); ok {
		t.Error("keepalive packet carries RADIO_FREQUENCY; it must not retune the channel")
	}
}

// TestAudioLifetimeOutlastsKeepalive guards the margin the whole scheme rests
// on. If the lifetime ever drops near the refresh interval, a single delayed
// tick kills a live user's audio mid-session.
func TestAudioLifetimeOutlastsKeepalive(t *testing.T) {
	const blockMillis = 20 // radiod default blocktime
	lifetime := time.Duration(audioLifetimeFrames) * blockMillis * time.Millisecond

	if lifetime < 4*audioKeepaliveInterval {
		t.Errorf("audio LIFETIME is %v but keepalive runs every %v; too little margin "+
			"for a delayed tick, and the failure mode is killing a live session",
			lifetime, audioKeepaliveInterval)
	}
}

// newLoopbackRadiod returns a controller whose commands land in a UDP socket the
// test can read, so the packets the send paths build can be inspected without a
// radiod. Every send path goes through sendCommandRaw's single WriteTo, so a
// plain unicast socket stands in for the multicast group faithfully enough.
func newLoopbackRadiod(t *testing.T) (*RadiodController, *net.UDPConn) {
	t.Helper()
	sink, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen sink: %v", err)
	}
	sender, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		sink.Close()
		t.Fatalf("listen sender: %v", err)
	}
	t.Cleanup(func() { sink.Close(); sender.Close() })
	return &RadiodController{conn: sender, statusAddr: sink.LocalAddr().(*net.UDPAddr)}, sink
}

// nextPacket returns the next command packet to reach the sink, or ok=false if
// none arrives. A dropped command is indistinguishable from one never sent,
// which is exactly what is being asserted.
func nextPacket(t *testing.T, sink *net.UDPConn) ([]byte, bool) {
	t.Helper()
	if err := sink.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	buf := make([]byte, 2048)
	n, _, err := sink.ReadFromUDP(buf)
	if err != nil {
		return nil, false
	}
	return buf[:n], true
}

// TestCommandSSRC covers the SSRC the terminated-SSRC check reads back out of an
// encoded packet. It has to agree with radiod's own get_ssrc() for every packet
// ubersdr sends, or the check either misses a sender or blocks the wrong channel.
func TestCommandSSRC(t *testing.T) {
	const ssrc = 41287

	packets := map[string][]byte{
		"terminate":       buildTerminateCommand(ssrc),
		"keepalive":       buildKeepaliveCommand(ssrc, audioLifetimeFrames),
		"poll":            buildPollCommand(ssrc),
		"spectrum create": buildCreateSpectrumCommand(14_000_000, 1024, 100, ssrc, 4, radiodSpectrumCrossoverHz),
		"spectrum update": buildUpdateSpectrumCommand(ssrc, spectrumUpdate{frequency: 14_000_000, binBandwidth: 100}),
	}
	for name, pkt := range packets {
		got, ok := commandSSRC(pkt)
		if !ok {
			t.Errorf("%s: no SSRC found; the terminated-SSRC check would not cover this sender", name)
			continue
		}
		if got != ssrc {
			t.Errorf("%s: SSRC = %d, want %d", name, got, ssrc)
		}
	}

	if _, ok := commandSSRC([]byte{pktTypeStatus, tagOutputSSRC, 2, 0xa1, 0x47, tagEOL}); ok {
		t.Error("status packet reported an SSRC; only commands may be filtered")
	}
	if _, ok := commandSSRC([]byte{pktTypeCmd, tagEOL}); ok {
		t.Error("empty command reported an SSRC")
	}
	if _, ok := commandSSRC([]byte{pktTypeCmd, tagOutputSSRC, 4, 0x00}); ok {
		t.Error("truncated TLV reported an SSRC")
	}
}

// TestTerminatedSSRCBlocksResurrection is the regression test for channels that
// outlived their session by exactly audioLifetimeFrames.
//
// radiod creates a channel for any command naming an unknown SSRC, so a
// keepalive that was already in flight when the terminate went out brought the
// channel back at 0 Hz, where it sat for the full 15 seconds. Verified against
// the real radiod (upstream cce087e2): the terminate itself works, the
// resurrection is what did not. See markTerminated.
func TestTerminatedSSRCBlocksResurrection(t *testing.T) {
	rc, sink := newLoopbackRadiod(t)
	const ssrc, other = 41287, 41288

	if err := rc.DisableChannel("test", ssrc); err != nil {
		t.Fatalf("DisableChannel: %v", err)
	}
	pkt, ok := nextPacket(t, sink)
	if !ok {
		t.Fatal("terminate was not sent: the tombstone must not block the terminate itself")
	}
	if _, tlvs := parseCommandPacket(t, pkt); func() bool { _, ok := findTLV(tlvs, tagLifetime); return !ok }() {
		t.Error("packet on the wire is not the terminate")
	}

	// Everything that could resurrect the channel is now refused.
	if err := rc.RefreshAudioLifetime(ssrc); err != nil {
		t.Errorf("RefreshAudioLifetime after teardown: %v (a raced keepalive is not an error)", err)
	}
	if _, ok := nextPacket(t, sink); ok {
		t.Error("keepalive for a torn-down SSRC reached radiod: it would recreate the channel for 15 s")
	}
	if err := rc.sendCommand(buildPollCommand(ssrc)); err != nil {
		t.Errorf("poll after teardown: %v", err)
	}
	if _, ok := nextPacket(t, sink); ok {
		t.Error("poll for a torn-down SSRC reached radiod")
	}
	if err := rc.SetAGC(ssrc, AGCParams{Threshold: float32Ptr(-15)}); err != nil {
		t.Errorf("SetAGC after teardown: %v", err)
	}
	if _, ok := nextPacket(t, sink); ok {
		t.Error("AGC update for a torn-down SSRC reached radiod: with no session to refresh it, that channel is immortal")
	}

	// Other channels are untouched.
	if err := rc.RefreshAudioLifetime(other); err != nil {
		t.Fatalf("RefreshAudioLifetime(other): %v", err)
	}
	if _, ok := nextPacket(t, sink); !ok {
		t.Error("keepalive for a live SSRC was dropped")
	}

	// Creating the channel again readmits the SSRC.
	if err := rc.CreateChannel("test", 14_000_000, "usb", 12000, ssrc); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, ok := nextPacket(t, sink); !ok {
		t.Fatal("create for a torn-down SSRC was dropped; the channel could never come back")
	}
	if err := rc.RefreshAudioLifetime(ssrc); err != nil {
		t.Fatalf("RefreshAudioLifetime after re-create: %v", err)
	}
	if _, ok := nextPacket(t, sink); !ok {
		t.Error("keepalive still blocked after the channel was re-created: it would be reaped after 15 s")
	}
}

// TestTerminatedSSRCExpires covers the TTL: the tombstone must not outlive the
// in-flight commands it exists to absorb, or a re-used SSRC stays mute.
func TestTerminatedSSRCExpires(t *testing.T) {
	rc, sink := newLoopbackRadiod(t)
	const ssrc = 41287

	rc.markTerminated(ssrc)
	if !rc.terminatedRecently(ssrc) {
		t.Fatal("SSRC not refused immediately after teardown")
	}

	rc.terminatedMu.Lock()
	rc.terminated[ssrc] = time.Now().Add(-terminatedSSRCTTL - time.Second)
	rc.terminatedMu.Unlock()

	if rc.terminatedRecently(ssrc) {
		t.Error("SSRC still refused after the TTL expired")
	}
	if err := rc.RefreshAudioLifetime(ssrc); err != nil {
		t.Fatalf("RefreshAudioLifetime: %v", err)
	}
	if _, ok := nextPacket(t, sink); !ok {
		t.Error("command dropped after the tombstone expired")
	}
}

// TestUpdatePathsCarryLifetime is the backstop for the same bug: if a command
// ever does land on a torn-down SSRC, radiod creates the channel from its
// template, whose lifetime is infinite. Carrying LIFETIME turns that permanent
// orphan into one that reaps itself.
func TestUpdatePathsCarryLifetime(t *testing.T) {
	rc, sink := newLoopbackRadiod(t)
	const ssrc = 41287

	send := func(name string, fn func() error, want uint32) {
		t.Helper()
		if err := fn(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		pkt, ok := nextPacket(t, sink)
		if !ok {
			t.Fatalf("%s: nothing sent", name)
		}
		_, tlvs := parseCommandPacket(t, pkt)
		got, ok := findTLV(tlvs, tagLifetime)
		if !ok {
			t.Errorf("%s: no LIFETIME; a command racing a teardown would create an immortal channel", name)
			return
		}
		if v := uint32(decodeInt(got.value)); v != want {
			t.Errorf("%s: LIFETIME = %d, want %d", name, v, want)
		}
	}

	send("SetAGC", func() error { return rc.SetAGC(ssrc, AGCParams{Threshold: float32Ptr(-15)}) }, audioLifetimeFrames)
	send("UpdateChannel", func() error {
		return rc.UpdateChannel(ssrc, 14_000_000, "usb", 50, 3000, true)
	}, audioLifetimeFrames)
	send("UpdateSquelch", func() error { return rc.UpdateSquelch(ssrc, -10, -12) }, audioLifetimeFrames)

	pkt := buildUpdateSpectrumCommand(ssrc, spectrumUpdate{frequency: 14_000_000, binBandwidth: 100})
	_, tlvs := parseCommandPacket(t, pkt)
	got, ok := findTLV(tlvs, tagLifetime)
	if !ok {
		t.Fatal("spectrum update carries no LIFETIME")
	}
	if v := uint32(decodeInt(got.value)); v != spectrumLifetimeFrames {
		t.Errorf("spectrum update LIFETIME = %d, want %d", v, spectrumLifetimeFrames)
	}
}

func float32Ptr(v float32) *float32 { return &v }

// TestTerminatedChannelLeavesTheStatusCache covers the admin panel's side of a
// teardown.
//
// radiod answers every command with a status packet, and the terminate is a
// command -- its reply arrives about 10 ms later, after markTerminated has
// already evicted the SSRC. Filing that reply put the row back for a channel
// that no longer existed, and since nothing refreshed it again the panel showed
// it with no session and a "last" column counting up until the 30 s stale sweep.
func TestTerminatedChannelLeavesTheStatusCache(t *testing.T) {
	rc, _ := newLoopbackRadiod(t)
	rc.frontendTracker = NewFrontendStatusTracker()
	rc.frontendTracker.suppressed = rc.terminatedRecently
	const ssrc = 41287

	fileStatus := func() {
		rc.frontendTracker.mu.Lock()
		rc.frontendTracker.channelStatus[ssrc] = &ChannelStatus{SSRC: ssrc, LastUpdate: time.Now()}
		rc.frontendTracker.frontendStatus[ssrc] = &FrontendStatus{SSRC: ssrc, LastUpdate: time.Now()}
		rc.frontendTracker.mu.Unlock()
	}
	cached := func() bool {
		rc.frontendTracker.mu.RLock()
		defer rc.frontendTracker.mu.RUnlock()
		_, ok := rc.frontendTracker.channelStatus[ssrc]
		return ok
	}

	fileStatus()
	if !cached() {
		t.Fatal("status was not cached to begin with")
	}

	if err := rc.DisableChannel("test", ssrc); err != nil {
		t.Fatalf("DisableChannel: %v", err)
	}
	if cached() {
		t.Error("terminated channel still in the status cache")
	}
	if !rc.frontendTracker.suppressed(ssrc) {
		t.Error("status for a just-terminated SSRC is not being refused; its dying packet would re-file the row")
	}

	// A channel created again under the same SSRC must show up as normal.
	if err := rc.CreateChannel("test", 14_000_000, "usb", 12000, ssrc); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if rc.frontendTracker.suppressed(ssrc) {
		t.Fatal("status still refused after the channel was re-created")
	}
	fileStatus()
	if !cached() {
		t.Error("status for a re-created channel was not cached")
	}
}

// TestBuildUpdateCommandOrdering covers the channel update packet.
//
// Two invariants, both silent when broken and both expensive.
//
// Everything a retune changes must be in ONE packet: radiod's per-channel
// command queue holds a single entry and drops anything arriving while it is
// occupied, so a bandwidth or AGC command sent after the mode is not merely late
// but may never be applied.  And PRESET must come FIRST, because radiod decodes
// tags in packet order and PRESET loads a preset that overwrites both the filter
// edges and the AGC settings -- so anything it would clobber has to be decoded
// after it to survive.
//
// Get either wrong and the channel runs the preset's wide filter and the
// preset's AGC for as long as it takes something else to fix it, which sounds
// exactly like a burst of noise on every mode change.
func TestBuildUpdateCommandOrdering(t *testing.T) {
	hang, recov, thresh := float32(1.1), float32(20), float32(-15)
	agc := &AGCParams{HangTime: &hang, RecoveryRate: &recov, Threshold: &thresh}

	_, tlvs := parseCommandPacket(t, buildUpdateCommand(4242, 14_074_000, "usb", 50, 2700, true, nil, nil, agc))

	indexOf := func(tag byte) int {
		for i, e := range tlvs {
			if e.tag == tag {
				return i
			}
		}
		return -1
	}

	preset := indexOf(tagPreset)
	if preset < 0 {
		t.Fatal("no PRESET in the update packet")
	}
	for _, c := range []struct {
		tag  byte
		name string
	}{
		{tagLowEdge, "LOW_EDGE"},
		{tagHighEdge, "HIGH_EDGE"},
		{tagAgcHangtime, "AGC_HANGTIME"},
		{tagAgcRecoveryRate, "AGC_RECOVERY_RATE"},
		{tagAgcThreshold, "AGC_THRESHOLD"},
	} {
		i := indexOf(c.tag)
		if i < 0 {
			t.Errorf("no %s in the update packet: the preset's value would stand", c.name)
			continue
		}
		if i < preset {
			t.Errorf("%s is decoded before PRESET, so the preset reload overwrites it", c.name)
		}
	}

	if _, ok := findTLV(tlvs, tagRadioFrequency); !ok {
		t.Error("no RADIO_FREQUENCY in the update packet")
	}
	if _, ok := findTLV(tlvs, tagLifetime); !ok {
		t.Error("no LIFETIME in the update packet: an update racing a teardown would leave an immortal channel")
	}
	if _, ok := findTLV(tlvs, tagStatusInterval); !ok {
		t.Error("no STATUS_INTERVAL: a preset reload resets radiod to 500 ms status updates")
	}
}

// A retune that is not changing the AGC must not mention it. Sending the tags
// with stale values would override the preset of whatever mode is being switched
// to, which is precisely what the AGC override exists to do deliberately.
func TestBuildUpdateCommandOmitsUnsetParameters(t *testing.T) {
	_, tlvs := parseCommandPacket(t, buildUpdateCommand(4242, 0, "", 0, 0, false, nil, nil, nil))

	for _, c := range []struct {
		tag  byte
		name string
	}{
		{tagPreset, "PRESET"},
		{tagLowEdge, "LOW_EDGE"},
		{tagHighEdge, "HIGH_EDGE"},
		{tagAgcHangtime, "AGC_HANGTIME"},
		{tagAgcRecoveryRate, "AGC_RECOVERY_RATE"},
		{tagAgcThreshold, "AGC_THRESHOLD"},
		{tagRadioFrequency, "RADIO_FREQUENCY"},
	} {
		if _, ok := findTLV(tlvs, c.tag); ok {
			t.Errorf("update packet carries %s when nothing asked for it", c.name)
		}
	}
}
