package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// withBlockedState swaps the two package-level values the feature hangs off and
// puts them back afterwards, so tests can run in any order.
func withBlockedState(t *testing.T, clips map[int]*blockedClip, bands []Band) {
	t.Helper()
	oldClips := blockedClips
	oldRanges := blockedRanges.Load()
	t.Cleanup(func() {
		blockedClips = oldClips
		if oldRanges != nil {
			blockedRanges.Store(oldRanges)
		} else {
			blockedRanges.Store(&[]blockedRange{})
		}
	})
	blockedClips = clips
	rebuildBlockedRanges(bands)
}

// writeWAV builds a 16-bit PCM WAV. `extraChunk` inserts a LIST chunk before
// the data, which is what an audio editor leaves behind and what the canonical
// 44-byte-header assumption would trip over.
func writeWAV(t *testing.T, path string, rate, channels int, samples []int16, extraChunk bool) {
	t.Helper()

	data := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(data[i*2:], uint16(s))
	}

	var body []byte
	appendChunk := func(id string, payload []byte) {
		body = append(body, id...)
		var sz [4]byte
		binary.LittleEndian.PutUint32(sz[:], uint32(len(payload)))
		body = append(body, sz[:]...)
		body = append(body, payload...)
		if len(payload)%2 == 1 {
			body = append(body, 0)
		}
	}

	fmtChunk := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtChunk[0:], 1) // PCM
	binary.LittleEndian.PutUint16(fmtChunk[2:], uint16(channels))
	binary.LittleEndian.PutUint32(fmtChunk[4:], uint32(rate))
	binary.LittleEndian.PutUint32(fmtChunk[8:], uint32(rate*channels*2)) // byte rate
	binary.LittleEndian.PutUint16(fmtChunk[12:], uint16(channels*2))     // block align
	binary.LittleEndian.PutUint16(fmtChunk[14:], 16)                     // bits
	appendChunk("fmt ", fmtChunk)
	if extraChunk {
		appendChunk("LIST", []byte("INFOhere is a comment"))
	}
	appendChunk("data", data)

	out := append([]byte("RIFF"), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(out[4:8], uint32(4+len(body)))
	out = append(out, "WAVE"...)
	out = append(out, body...)

	if err := os.WriteFile(path, out, 0644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func TestLoadBlockedClipParsesChunksAndSwapsByteOrder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blocked-12.wav")
	samples := []int16{0x0102, -2, 0x7FFF, 0}
	writeWAV(t, path, 12000, 1, samples, true)

	clip, err := loadBlockedClip(path)
	if err != nil {
		t.Fatalf("loadBlockedClip: %v", err)
	}
	if clip.rate != 12000 {
		t.Errorf("rate = %d, want 12000", clip.rate)
	}
	if len(clip.pcmBE) != len(samples)*2 {
		t.Fatalf("got %d bytes, want %d", len(clip.pcmBE), len(samples)*2)
	}
	// radiod's PCM is big-endian; the file is little-endian. Reading the clip
	// back the way bytesToInt16Samples does must return what was written.
	for i, want := range samples {
		got := int16(binary.BigEndian.Uint16(clip.pcmBE[i*2:]))
		if got != want {
			t.Errorf("sample %d = %d, want %d (byte order not swapped)", i, got, want)
		}
	}
}

func TestLoadBlockedClipRejectsUnusableFiles(t *testing.T) {
	dir := t.TempDir()

	stereo := filepath.Join(dir, "blocked-stereo.wav")
	writeWAV(t, stereo, 12000, 2, []int16{1, 2, 3, 4}, false)
	if _, err := loadBlockedClip(stereo); err == nil {
		t.Error("a stereo file was accepted; the announcement has to be mono")
	}

	notRIFF := filepath.Join(dir, "blocked-junk.wav")
	if err := os.WriteFile(notRIFF, []byte("this is not a wav file at all"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadBlockedClip(notRIFF); err == nil {
		t.Error("a non-RIFF file was accepted")
	}

	missing := filepath.Join(dir, "blocked-nothere.wav")
	if _, err := loadBlockedClip(missing); err == nil {
		t.Error("a missing file was accepted")
	}
}

// The clip is never a whole number of packets, so a packet routinely straddles
// the wrap. If that is not seamless the listener hears a click every time the
// announcement repeats.
func TestBlockedClipFillWrapsSeamlessly(t *testing.T) {
	// 7 samples: deliberately coprime with the 4-sample packet below, so the
	// wrap lands at a different offset every time round.
	clip := &blockedClip{rate: 12000}
	for i := 1; i <= 7; i++ {
		clip.pcmBE = append(clip.pcmBE, byte(0), byte(i))
	}

	const packets = 9
	var got []byte
	cursor := 0
	for i := 0; i < packets; i++ {
		pkt := make([]byte, 8) // 4 samples
		cursor = clip.fill(pkt, cursor)
		got = append(got, pkt...)
	}

	for i, b := range got {
		want := clip.pcmBE[i%len(clip.pcmBE)]
		if b != want {
			t.Fatalf("byte %d = %d, want %d — the loop is not continuous across the wrap", i, b, want)
		}
	}
	if cursor%2 != 0 {
		t.Errorf("cursor = %d, must stay on a sample boundary", cursor)
	}
}

func TestRebuildBlockedRangesMatchesGroupLoosely(t *testing.T) {
	withBlockedState(t, nil, []Band{
		{Label: "20m", Start: 14000000, End: 14350000, Group: "HF"},
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: " Blocked "},
		{Label: "Shouty", Start: 5000000, End: 5100000, Group: "BLOCKED"},
		{Label: "Inverted", Start: 9000000, End: 8000000, Group: "blocked"},
		{Label: "Empty", Start: 7000000, End: 7000000, Group: "blocked"},
	})

	cases := []struct {
		hz    uint64
		want  bool
		label string
	}{
		{526499, false, ""},
		{526500, true, "Medium wave"},  // inclusive low edge
		{1000000, true, "Medium wave"}, // inside
		{1606500, true, "Medium wave"}, // inclusive high edge
		{1606501, false, ""},           //
		{5050000, true, "Shouty"},      // case-insensitive group
		{14200000, false, ""},          // an ordinary band is not blocked
		{8500000, false, ""},           // inverted range dropped
		{7000000, false, ""},           // zero-width range dropped
		{0, false, ""},                 // "no frequency" is never blocked
	}
	for _, tc := range cases {
		r, blocked := blockedRangeAt(tc.hz)
		if blocked != tc.want {
			t.Errorf("blockedRangeAt(%d) = %v, want %v", tc.hz, blocked, tc.want)
			continue
		}
		if blocked && r.Label != tc.label {
			t.Errorf("blockedRangeAt(%d) matched %q, want %q", tc.hz, r.Label, tc.label)
		}
	}
}

// A clip for one rate only. 12 kHz is blocked; 24 kHz has nothing to play and
// must therefore be served the real band rather than silence.
func announcementClips() map[int]*blockedClip {
	clip := &blockedClip{rate: 12000}
	for i := 0; i < 64; i++ {
		clip.pcmBE = append(clip.pcmBE, 0x11, 0x22)
	}
	return map[int]*blockedClip{12000: clip}
}

func blockedTestSession(freq uint64, rate, channels int) *Session {
	return &Session{
		Frequency:  freq,
		SampleRate: rate,
		Channels:   channels,
	}
}

func TestApplyBlockedAudioSubstitutesForOrdinaryListeners(t *testing.T) {
	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})

	s := blockedTestSession(1000000, 12000, 1)
	pcm := make([]byte, 16)
	s.applyBlockedAudio(pcm, 12000, 1)

	for i, b := range pcm {
		if want := blockedClips[12000].pcmBE[i]; b != want {
			t.Fatalf("byte %d = %#x, want %#x — the announcement was not substituted", i, b, want)
		}
	}
	if !s.blockActive.Load() {
		t.Error("blockActive is false while the announcement is playing; the audio gate would squelch it")
	}
	if s.blockCursor != 16 {
		t.Errorf("blockCursor = %d, want 16", s.blockCursor)
	}

	// Leaving the range hands the band back and clears the flag...
	s.Frequency = 14200000
	real := []byte{1, 2, 3, 4}
	s.applyBlockedAudio(real, 12000, 1)
	if real[0] != 1 || real[3] != 4 {
		t.Error("audio outside a blocked range was replaced")
	}
	if s.blockActive.Load() {
		t.Error("blockActive stayed set after leaving the blocked range")
	}

	// ...and coming back restarts the announcement rather than resuming it
	// halfway, so nobody joins mid-sentence.
	s.Frequency = 1000000
	s.applyBlockedAudio(make([]byte, 4), 12000, 1)
	if s.blockCursor != 4 {
		t.Errorf("blockCursor = %d after re-entering the range, want 4 (restarted)", s.blockCursor)
	}
}

func TestApplyBlockedAudioFailureModesRouteAudioNormally(t *testing.T) {
	untouched := func(t *testing.T, s *Session, rate int, why string) {
		t.Helper()
		pcm := []byte{9, 8, 7, 6}
		s.applyBlockedAudio(pcm, rate, s.Channels)
		if pcm[0] != 9 || pcm[1] != 8 || pcm[2] != 7 || pcm[3] != 6 {
			t.Errorf("%s: audio was altered, want it routed normally", why)
		}
		if s.blockActive.Load() {
			t.Errorf("%s: blockActive was set even though nothing was substituted", why)
		}
	}

	blockedBands := []Band{{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"}}

	t.Run("no clips loaded at all", func(t *testing.T) {
		withBlockedState(t, nil, blockedBands)
		untouched(t, blockedTestSession(1000000, 12000, 1), 12000, "no announcement loaded")
	})

	t.Run("no clip for this sample rate", func(t *testing.T) {
		withBlockedState(t, announcementClips(), blockedBands)
		// An AM channel is 24 kHz and only the 12 kHz clip was loaded.
		untouched(t, blockedTestSession(1000000, 24000, 1), 24000, "no clip at 24 kHz")
	})

	t.Run("bypassed listener", func(t *testing.T) {
		withBlockedState(t, announcementClips(), blockedBands)
		s := blockedTestSession(1000000, 12000, 1)
		s.blockExempt = true
		untouched(t, s, 12000, "bypassed listener")
	})

	t.Run("spectrum session", func(t *testing.T) {
		withBlockedState(t, announcementClips(), blockedBands)
		s := blockedTestSession(1000000, 12000, 1)
		s.IsSpectrum = true
		untouched(t, s, 12000, "spectrum session")
	})
}

// IQ is the one case that is silenced rather than passed through: it carries the
// raw RF the block exists to withhold, and no announcement can be carried in a
// complex stream.
func TestApplyBlockedAudioSilencesIQ(t *testing.T) {
	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})

	s := blockedTestSession(1000000, 12000, 2)
	pcm := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	s.applyBlockedAudio(pcm, 12000, 2)
	for i, b := range pcm {
		if b != 0 {
			t.Fatalf("IQ byte %d = %d, want 0 — raw RF was passed through a blocked range", i, b)
		}
	}
	if !s.blockActive.Load() {
		t.Error("blockActive is false for silenced IQ; the gate would report it as squelched audio")
	}
}

func TestAudioBlockedForOnlyAppliesToOrdinaryListeners(t *testing.T) {
	cfg := &Config{}
	cfg.Server.BypassPassword = "letmein"
	cfg.Server.TimeoutBypassIPs = []string{"10.1.2.3"}
	if err := cfg.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatalf("parseTimeoutBypassIPs: %v", err)
	}
	sm := &SessionManager{config: cfg}

	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})

	if !sm.audioBlockedFor(1000000, "203.0.113.9", "") {
		t.Error("an ordinary listener inside a blocked range was not blocked")
	}
	if sm.audioBlockedFor(14200000, "203.0.113.9", "") {
		t.Error("a frequency outside every blocked range was blocked")
	}
	if sm.audioBlockedFor(1000000, "10.1.2.3", "") {
		t.Error("a bypassed IP was blocked")
	}
	if sm.audioBlockedFor(1000000, "203.0.113.9", "letmein") {
		t.Error("a listener with the bypass password was blocked")
	}
	if sm.audioBlockedFor(1000000, "", "") {
		t.Error("an internal session was blocked")
	}

	// With no announcement loaded the whole feature is inert, IQ included.
	withBlockedState(t, nil, []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})
	if sm.audioBlockedFor(1000000, "203.0.113.9", "") {
		t.Error("blocking was reported with no announcement loaded; IQ would be refused for no reason")
	}
}

// Tuning into IQ inside a blocked range has to be refused at the session layer,
// not in one front end: the KiwiSDR path has no IQ gate of its own.
func TestBlockedRangeRefusesIQ(t *testing.T) {
	cfg := &Config{}
	cfg.Audio.DefaultSampleRate = 12000
	cfg.Server.MaxSessions = 4
	sm := NewSessionManager(cfg, &stubRadiod{}, nil)

	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})

	if _, err := sm.CreateSessionWithBandwidthAndPassword(
		1000000, "iq", 3000, "", "203.0.113.9", "iq-create", ""); err == nil {
		t.Error("a session was created in IQ mode inside a blocked range")
	}

	// An ordinary mode is fine, and so is IQ outside the range.
	session, err := sm.CreateSessionWithBandwidthAndPassword(
		1000000, "am", 3000, "", "203.0.113.9", "iq-tune", "")
	if err != nil {
		t.Fatalf("CreateSessionWithBandwidthAndPassword: %v", err)
	}
	defer func() { _ = sm.DestroySession(session.ID) }()

	if err := sm.UpdateSessionWithEdges(session.ID, 0, "iq", 0, 3000, false); err == nil {
		t.Error("a live session switched to IQ inside a blocked range")
	}
	if err := sm.UpdateSessionWithEdges(session.ID, 14200000, "iq", 0, 3000, false); err != nil {
		t.Errorf("IQ outside every blocked range was refused: %v", err)
	}
	// Tuning back into the range while already in IQ is the other direction of
	// the same hole.
	if err := sm.UpdateSessionWithEdges(session.ID, 1000000, "", 0, 3000, false); err == nil {
		t.Error("a session in IQ mode was allowed to tune into a blocked range")
	}
}

// The shipped announcements have to cover both rates the server demodulates at,
// or half the modes play the band as usual.
func TestShippedAnnouncementsCoverBothRates(t *testing.T) {
	if _, err := os.Stat(blockedAudioDir); os.IsNotExist(err) {
		t.Skipf("%s/ not present", blockedAudioDir)
	}
	oldClips := blockedClips
	t.Cleanup(func() { blockedClips = oldClips })

	loadBlockedClips(blockedAudioDir)
	for _, rate := range []int{12000, 24000} {
		clip := blockedClipFor(rate, 1)
		if clip == nil {
			t.Errorf("no announcement loaded for %d Hz (%s)", rate, modesAtRate(rate))
			continue
		}
		if len(clip.pcmBE) < rate/10 {
			t.Errorf("%d Hz announcement is %d samples, shorter than 50 ms — is the file truncated?",
				rate, len(clip.pcmBE)/2)
		}
	}
}

// Leaving a blocked range needs the settling window that a mode change gets.
// radiod takes a block or two to move, so without it the packets produced
// immediately after tuning away are still the blocked frequency's audio, and
// they would be passed through because Frequency has already changed.
func TestLeavingBlockedRangeOpensTheSettlingWindow(t *testing.T) {
	cfg := &Config{}
	cfg.Audio.DefaultSampleRate = 12000
	cfg.Server.MaxSessions = 8
	cfg.Server.TimeoutBypassIPs = []string{"10.1.2.3"}
	if err := cfg.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatalf("parseTimeoutBypassIPs: %v", err)
	}
	sm := NewSessionManager(cfg, &stubRadiod{}, nil)

	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})

	newSession := func(t *testing.T, freq uint64, clientIP, uuid string) *Session {
		t.Helper()
		s, err := sm.CreateSessionWithBandwidthAndPassword(freq, "am", 3000, "", clientIP, uuid, "")
		if err != nil {
			t.Fatalf("CreateSessionWithBandwidthAndPassword: %v", err)
		}
		t.Cleanup(func() { _ = sm.DestroySession(s.ID) })
		return s
	}

	// Out of a blocked range: the window has to open.
	leaving := newSession(t, 1000000, "203.0.113.9", "leaving")
	if err := sm.UpdateSessionWithEdges(leaving.ID, 14200000, "", 0, 3000, false); err != nil {
		t.Fatalf("tuning out of a blocked range: %v", err)
	}
	if !leaving.retuning() {
		t.Error("no settling window after leaving a blocked range; the old frequency's audio would be passed through")
	}

	// Between two ordinary frequencies: nothing changes, no window.
	ordinary := newSession(t, 7100000, "203.0.113.10", "ordinary")
	if err := sm.UpdateSessionWithEdges(ordinary.ID, 14200000, "", 0, 3000, false); err != nil {
		t.Fatalf("ordinary retune: %v", err)
	}
	if ordinary.retuning() {
		t.Error("an ordinary retune opened a settling window; audio would stutter on every tune")
	}

	// A bypassed listener is never blocked, so nothing to settle for either.
	bypassed := newSession(t, 1000000, "10.1.2.3", "bypassed")
	if err := sm.UpdateSessionWithEdges(bypassed.ID, 14200000, "", 0, 3000, false); err != nil {
		t.Fatalf("bypassed retune: %v", err)
	}
	if bypassed.retuning() {
		t.Error("a bypassed listener got a settling window for a range that never applied to them")
	}
}
