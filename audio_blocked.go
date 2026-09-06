package main

// audio_blocked.go — frequency ranges an ordinary listener is not served audio from.
//
// How a range is declared
// ───────────────────────
// A band in bands.yaml whose group is "blocked" (any capitalisation). That is
// deliberately not a new config file: the admin Bands tab already has the whole
// editor — add, edit, delete, per-entry frequencies — and every mutation calls
// reloadBands(), so a range starts and stops being blocked without a restart.
// It also means the range appears in the band plan for free, because it *is* a
// band: /api/bands and the KiwiSDR band bar serve it like any other, and
// clicking it tunes to the middle of it, which is where the announcement is.
//
// What blocking does
// ──────────────────
// The listener hears a short recording on a loop instead of demodulated audio.
// Substitution happens in routeAudio(), upstream of every consumer — the native
// WebSocket, the KiwiSDR and WebSDR emulations, the HTTP stream tap and audio
// extensions all read from Session.AudioChan — so there is one place to get
// right rather than five. The payload length is never changed, so every
// downstream encoder (Opus framing, the v4 predictive codec, KiwiSDR ADPCM)
// sees exactly the packet shape it expects.
//
// Who it applies to
// ─────────────────
// Ordinary listeners only. A bypassed user — an IP in timeout_bypass_ips, or a
// client that supplied bypass_password — hears the range normally, as do
// internal sessions (empty ClientIP: the noise-floor and frequency-reference
// channels). Decoders and the CW skimmer never reach this code at all; they own
// their own audio channels rather than a Session.
//
// Failure modes
// ─────────────
// Every one of them routes the real audio rather than silence:
//
//   - no clips loaded at all → the feature is inert. A blocked band still shows
//     in the band plan, but nothing is substituted and IQ is not refused.
//   - a clip exists for 12 kHz but the listener is on an AM channel at 24 kHz →
//     that session hears the band normally.
//
// A block that cannot speak is worse than useless if it silently mutes the
// receiver instead, so it does nothing and says so loudly at startup. The one
// exception is IQ, which is silenced rather than passed through — see
// applyBlockedAudio.

import (
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
)

// blockedBandGroup is the bands.yaml group that turns a band into a blocked
// range. Matched case-insensitively, and after trimming, because it is typed
// into a free-text box in the admin UI.
const blockedBandGroup = "blocked"

// blockedAudioDir holds the announcement clips, resolved relative to the
// working directory like static/ and the KiwiSDR assets are.
const blockedAudioDir = "audio"

// blockedClipPattern is what loadBlockedClips looks for. The number in the name
// is a hint for whoever is reading the directory; the rate that counts is the
// one in the WAV header, so dropping in a blocked-48.wav is all it takes to
// cover a new rate.
const blockedClipPattern = "blocked-*.wav"

// blockedRange is one range of dial frequencies, inclusive of both ends.
//
// Inclusive because the alternative is a single hertz at the top edge that is
// blocked on the band plan and not in the audio, and erring towards blocking is
// the safer of the two mistakes.
type blockedRange struct {
	Label string
	Start uint64
	End   uint64
}

// blockedClip is one announcement, already in radiod's byte order.
type blockedClip struct {
	rate int
	// pcmBE is big-endian 16-bit mono, matching what radiod puts on the wire
	// (see bytesToInt16Samples). WAV files are little-endian, so the swap is
	// done once at load rather than on every packet.
	pcmBE []byte
}

var (
	// blockedRanges is swapped wholesale on reload. An atomic pointer rather
	// than a lock because routeAudio reads it for every packet of every
	// session, while reloadBands writes it from an admin request.
	blockedRanges atomic.Pointer[[]blockedRange]

	// blockedClips is keyed by sample rate. Written once at startup, before
	// any session exists, and read-only afterwards.
	blockedClips map[int]*blockedClip
)

// blockedAudioAvailable reports whether any announcement was loaded. With none,
// the whole feature is inert — see the failure-mode note at the top.
func blockedAudioAvailable() bool { return len(blockedClips) > 0 }

// blockedClipFor returns the announcement for a channel, or nil when there is
// nothing that can be played on it.
func blockedClipFor(sampleRate, channels int) *blockedClip {
	if channels != 1 {
		return nil
	}
	return blockedClips[sampleRate]
}

// blockedRangeAt returns the range containing hz, if any.
func blockedRangeAt(hz uint64) (blockedRange, bool) {
	ranges := blockedRanges.Load()
	if ranges == nil || hz == 0 {
		return blockedRange{}, false
	}
	for _, r := range *ranges {
		if hz >= r.Start && hz <= r.End {
			return r, true
		}
	}
	return blockedRange{}, false
}

// rebuildBlockedRanges republishes the blocked set from a band plan. Called at
// startup and from reloadBands, so an operator adding or deleting a band in the
// admin UI takes effect on the next packet.
func rebuildBlockedRanges(bands []Band) {
	ranges := make([]blockedRange, 0, 4)
	for _, b := range bands {
		if !strings.EqualFold(strings.TrimSpace(b.Group), blockedBandGroup) {
			continue
		}
		// A zero-width or inverted band is a typo, not a range. The admin API
		// rejects these on entry (handleAddBand), but bands.yaml can be edited
		// by hand.
		if b.End <= b.Start {
			log.Printf("Blocked ranges: ignoring band %q — end (%d Hz) must be above start (%d Hz)",
				b.Label, b.End, b.Start)
			continue
		}
		ranges = append(ranges, blockedRange{Label: b.Label, Start: b.Start, End: b.End})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Start < ranges[j].Start })
	blockedRanges.Store(&ranges)

	if len(ranges) == 0 {
		return
	}

	// Logged every time rather than only on change: a band group is display
	// data everywhere else in this codebase, so the one that quietly stops
	// serving audio should be impossible to miss in the log.
	for _, r := range ranges {
		log.Printf("Blocked range: %q %.3f-%.3f MHz — ordinary listeners hear the announcement, bypassed users hear the band",
			r.Label, float64(r.Start)/1e6, float64(r.End)/1e6)
	}
	if !blockedAudioAvailable() {
		log.Printf("WARNING: %d blocked range(s) configured but no announcement loaded from %s/ — "+
			"audio is being served normally and IQ modes are not restricted. "+
			"Add %s (16-bit mono WAV) and restart.", len(ranges), blockedAudioDir, blockedClipPattern)
	}
}

// loadBlockedClips reads every announcement in dir, keyed by the sample rate in
// its header. Missing files are not an error: the feature simply stays inert.
func loadBlockedClips(dir string) {
	blockedClips = make(map[int]*blockedClip)

	matches, err := filepath.Glob(filepath.Join(dir, blockedClipPattern))
	if err != nil || len(matches) == 0 {
		log.Printf("Blocked-range audio: no %s in %s/ — blocked ranges (if any) will serve audio normally",
			blockedClipPattern, dir)
		return
	}
	sort.Strings(matches)

	for _, path := range matches {
		clip, err := loadBlockedClip(path)
		if err != nil {
			log.Printf("Blocked-range audio: ignoring %s — %v", path, err)
			continue
		}
		if existing, dup := blockedClips[clip.rate]; dup {
			log.Printf("Blocked-range audio: ignoring %s — %d Hz is already covered by an earlier file (%d samples)",
				path, clip.rate, len(existing.pcmBE)/2)
			continue
		}
		blockedClips[clip.rate] = clip
		log.Printf("Blocked-range audio: loaded %s (%d Hz mono, %.2f s)",
			path, clip.rate, float64(len(clip.pcmBE)/2)/float64(clip.rate))
	}

	// The two rates this server demodulates at — see GetSampleRateForMode. A
	// receiver covering only one of them still works; the modes at the other
	// rate just play the band as usual.
	for _, rate := range []int{12000, 24000} {
		if blockedClips[rate] == nil {
			log.Printf("Blocked-range audio: no clip for %d Hz — %s modes will be served normally inside a blocked range",
				rate, modesAtRate(rate))
		}
	}
}

// modesAtRate names the modes a missing clip would have covered, so the warning
// says what is actually still audible rather than a bare number.
func modesAtRate(rate int) string {
	switch rate {
	case 12000:
		return "usb/lsb/cwu/cwl"
	case 24000:
		return "am/sam/fm/nfm"
	}
	return fmt.Sprintf("%d Hz", rate)
}

// loadBlockedClip parses one 16-bit mono PCM WAV file into radiod's byte order.
//
// The chunk walk is deliberate rather than assuming the canonical 44-byte
// header: anything that has been through an editor is liable to carry a LIST or
// fact chunk ahead of the data.
func loadBlockedClip(path string) (*blockedClip, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 12 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, fmt.Errorf("not a RIFF/WAVE file")
	}

	var (
		rate     int
		channels int
		bits     int
		pcm      []byte
		haveFmt  bool
	)

	for off := 12; off+8 <= len(data); {
		id := string(data[off : off+4])
		size := int(binary.LittleEndian.Uint32(data[off+4 : off+8]))
		body := off + 8
		if size < 0 || body+size > len(data) {
			// A truncated final chunk is common in hand-edited files; take
			// what is there rather than rejecting the whole clip.
			size = len(data) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, fmt.Errorf("fmt chunk is %d bytes, need at least 16", size)
			}
			format := binary.LittleEndian.Uint16(data[body : body+2])
			// 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which is still plain
			// PCM when the sub-format says so. Anything else (float, ADPCM,
			// compressed) is not something this can byte-swap.
			if format != 1 && format != 0xFFFE {
				return nil, fmt.Errorf("audio format %d is not PCM", format)
			}
			channels = int(binary.LittleEndian.Uint16(data[body+2 : body+4]))
			rate = int(binary.LittleEndian.Uint32(data[body+4 : body+8]))
			bits = int(binary.LittleEndian.Uint16(data[body+14 : body+16]))
			haveFmt = true
		case "data":
			pcm = data[body : body+size]
		}
		// Chunks are word-aligned: an odd size is followed by a pad byte.
		off = body + size
		if size%2 == 1 {
			off++
		}
	}

	switch {
	case !haveFmt:
		return nil, fmt.Errorf("no fmt chunk")
	case len(pcm) < 2:
		return nil, fmt.Errorf("no audio data")
	case channels != 1:
		return nil, fmt.Errorf("%d channels, need mono", channels)
	case bits != 16:
		return nil, fmt.Errorf("%d bits per sample, need 16", bits)
	case rate <= 0:
		return nil, fmt.Errorf("sample rate %d", rate)
	}

	// Truncate to whole samples so the loop can wrap without losing alignment.
	pcm = pcm[:len(pcm)&^1]

	// WAV is little-endian; radiod's PCM is big-endian. Swapped into a fresh
	// buffer because `data` is the whole file and this keeps only the audio.
	swapped := make([]byte, len(pcm))
	for i := 0; i+1 < len(pcm); i += 2 {
		swapped[i] = pcm[i+1]
		swapped[i+1] = pcm[i]
	}

	return &blockedClip{rate: rate, pcmBE: swapped}, nil
}

// fill writes the announcement into dst starting at cursor, wrapping as often
// as it needs to, and returns the cursor to resume from.
//
// The clip is not a whole number of packets — it is whatever length the
// recording is — so a packet routinely straddles the wrap, and the loop below
// is what makes that seamless rather than a click every few seconds.
func (c *blockedClip) fill(dst []byte, cursor int) int {
	n := len(c.pcmBE)
	if n < 2 || len(dst) == 0 {
		return cursor
	}
	if cursor < 0 || cursor >= n {
		cursor = 0
	}
	cursor &^= 1 // never resume mid-sample
	for off := 0; off < len(dst); {
		copied := copy(dst[off:], c.pcmBE[cursor:])
		off += copied
		cursor += copied
		if cursor >= n {
			cursor = 0
		}
	}
	return cursor
}

// applyBlockedAudio replaces pcm with the announcement when this session is
// listening inside a blocked range.
//
// Called only from routeAudio, on the single audio receive goroutine, which is
// what makes the unsynchronised blockCursor safe: one goroutine routes every
// packet of every session.
func (s *Session) applyBlockedAudio(pcm []byte, sampleRate, channels int) {
	if len(pcm) == 0 || !blockedAudioAvailable() {
		return
	}
	if s.blockExempt || s.IsSpectrum {
		return
	}
	if _, blocked := blockedRangeAt(s.currentFrequency()); !blocked {
		s.blockActive.Store(false)
		return
	}

	// IQ carries raw RF rather than demodulated audio: there is no announcement
	// to put in a complex stream, and passing the samples through would hand
	// over precisely what the block exists to withhold. Tuning into IQ inside a
	// blocked range is refused up front (see audioBlockedFor); this covers the
	// session that was already in IQ when the range became blocked.
	if channels != 1 {
		clear(pcm)
		s.blockActive.Store(true)
		return
	}

	clip := blockedClipFor(sampleRate, channels)
	if clip == nil {
		// No clip at this rate. Serving silence would be a receiver that looks
		// broken; serve the band and let the startup warning be the thing that
		// gets fixed.
		s.blockActive.Store(false)
		return
	}

	// Restart on entry so everyone hears the announcement from the beginning
	// rather than joining it halfway.
	if !s.blockActive.Load() {
		s.blockCursor = 0
	}
	s.blockCursor = clip.fill(pcm, s.blockCursor)
	s.blockActive.Store(true)
}

// currentFrequency is the dial frequency this session is tuned to.
func (s *Session) currentFrequency() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Frequency
}

// audioBlockedFor reports whether a listener with these credentials would be
// blocked at this frequency — the tune-time counterpart of applyBlockedAudio,
// used to refuse IQ modes before a channel is created or retuned.
func (sm *SessionManager) audioBlockedFor(frequency uint64, clientIP, password string) bool {
	if !blockedAudioAvailable() || clientIP == "" {
		return false
	}
	if sm.config.Server.IsIPTimeoutBypassed(clientIP, password) {
		return false
	}
	_, blocked := blockedRangeAt(frequency)
	return blocked
}

// isIQModeName reports whether mode is one of the IQ modes, which carry raw RF
// rather than demodulated audio.
func isIQModeName(mode string) bool {
	switch mode {
	case "iq", "iq48", "iq96", "iq192", "iq384":
		return true
	}
	return false
}
