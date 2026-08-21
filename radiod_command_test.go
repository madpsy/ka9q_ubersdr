package main

import (
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

// TestBuildTerminateCommand covers the teardown packet, which has to work on
// both radiod versions: frequency 0 is what the forked radiod kills on, LIFETIME
// is what upstream kills on.  Dropping either one silently leaks channels on the
// corresponding version.
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

	// Frequency 0 encodes to a zero-length value under leading-zero suppression;
	// radiod's decode_double() maps that back to 0.0.
	got, ok = findTLV(tlvs, tagRadioFrequency)
	if !ok {
		t.Fatal("no RADIO_FREQUENCY in terminate packet: the forked radiod would never kill the channel")
	}
	if v := decodeDouble(got.value); v != 0 {
		t.Errorf("RADIO_FREQUENCY = %v, want 0", v)
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

	pktType, tlvs := parseCommandPacket(t, buildCreateSpectrumCommand(freq, binCount, binBW, ssrc, defaultSpectrumFFTAverages))

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
