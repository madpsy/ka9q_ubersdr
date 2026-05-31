package main

// audio_http_stream.go — HTTP Ogg/Opus audio stream endpoint.
//
// GET /audio/stream?session=<userSessionID>[&password=<bypass>]
//
// Streams the session's audio as a continuous Ogg/Opus HTTP response so that
// a hidden <audio src="/audio/stream?session=..."> element can play it.
// Android Chrome requires a URL-based <audio> element to show the lock-screen
// / notification media widget; a pure AudioContext + navigator.mediaSession
// metadata is not sufficient.
//
// Design:
//   - Only activates when a binary WebSocket audio session already exists for
//     the given userSessionID (returns 404 otherwise).
//   - Sets session.httpAudioChan so streamAudio() forwards packets here instead
//     of encoding them for the WebSocket binary connection.
//   - Signal-quality packets continue over the WebSocket unchanged.
//   - On disconnect (client or server side), httpAudioChan is set to nil and
//     streamAudio() automatically resumes sending audio over the WebSocket.
//   - The channel is NEVER closed — only the pointer is nilled — to avoid any
//     send-on-closed-channel panic.
//
// Bandwidth: identical to the current WebSocket-only path.  Audio bytes travel
// once — either over WebSocket (normal) or over HTTP (when this endpoint is
// active).  There is no double-streaming.

import (
	"encoding/binary"
	"log"
	"net/http"
)

// oggCRCTable is the lookup table for the Ogg CRC-32 checksum.
//
// Ogg uses a non-standard CRC-32 with polynomial 0x04c11db7 in the
// NORMAL (non-reflected, MSB-first) form.  This is NOT the same as
// IEEE CRC-32 (which uses the reflected form 0xedb88320).
// The table is pre-computed to match the libogg reference implementation.
var oggCRCTable [256]uint32

func init() {
	for i := 0; i < 256; i++ {
		r := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ 0x04c11db7
			} else {
				r <<= 1
			}
		}
		oggCRCTable[i] = r
	}
}

// oggChecksum computes the Ogg CRC-32 checksum over data.
// The CRC field in the page header must be zeroed before calling this.
func oggChecksum(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	return crc
}

// writeOggPage writes a single Ogg page to w.
//
//	serialNo  — stream serial number (arbitrary, must be consistent)
//	seqNo     — page sequence number (0, 1, 2, …)
//	granulePos — granule position (sample count for Opus; 0 for header pages)
//	headerType — 0x00 normal, 0x02 first page (BOS), 0x04 last page (EOS)
//	data       — the page payload (must fit in one page, ≤ 65025 bytes)
func writeOggPage(w http.ResponseWriter, serialNo, seqNo uint32, granulePos uint64, headerType byte, data []byte) error {
	// Build segment table: each segment is up to 255 bytes.
	// For simplicity we use one lace value per 255-byte chunk.
	segments := []byte{}
	remaining := len(data)
	for remaining > 0 {
		seg := remaining
		if seg > 255 {
			seg = 255
		}
		segments = append(segments, byte(seg))
		remaining -= seg
	}
	// A lace value of 255 means "continued in next segment"; a value < 255
	// terminates the packet.  If the last segment is exactly 255 we need an
	// extra 0-byte terminator.
	if len(data) > 0 && len(data)%255 == 0 {
		segments = append(segments, 0)
	}

	// Ogg page header (27 bytes fixed + segment table)
	header := make([]byte, 27+len(segments))
	copy(header[0:4], []byte("OggS"))                       // capture pattern
	header[4] = 0                                           // stream structure version
	header[5] = headerType                                  // header type
	binary.LittleEndian.PutUint64(header[6:14], granulePos) // granule position
	binary.LittleEndian.PutUint32(header[14:18], serialNo)  // stream serial number
	binary.LittleEndian.PutUint32(header[18:22], seqNo)     // page sequence number
	binary.LittleEndian.PutUint32(header[22:26], 0)         // CRC (filled below)
	header[26] = byte(len(segments))                        // number of page segments
	copy(header[27:], segments)

	// Compute CRC over header + data (CRC field itself is zero during computation).
	// oggChecksum implements the libogg CRC-32 (polynomial 0x04c11db7, normal form).
	combined := make([]byte, len(header)+len(data))
	copy(combined, header)
	copy(combined[len(header):], data)
	binary.LittleEndian.PutUint32(header[22:26], oggChecksum(combined))

	// Write header then data
	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return nil
}

// buildOpusHead builds the OpusHead identification header packet.
// https://wiki.xiph.org/OggOpus#ID_Header
//
// The "input sample rate" field is informational only — it tells the decoder
// what rate the original PCM was at before Opus encoding.  Opus always
// operates internally at 48 kHz.  We set it to 48000 for maximum
// compatibility with browsers and media players.
func buildOpusHead(channels int) []byte {
	h := make([]byte, 19)
	copy(h[0:8], []byte("OpusHead"))
	h[8] = 1                                       // version
	h[9] = byte(channels)                          // channel count
	binary.LittleEndian.PutUint16(h[10:12], 0)     // pre-skip (0 = no skip)
	binary.LittleEndian.PutUint32(h[12:16], 48000) // input sample rate (always 48000 for Opus)
	binary.LittleEndian.PutUint16(h[16:18], 0)     // output gain (Q7.8, 0 = unity)
	h[18] = 0                                      // channel mapping family 0 (mono/stereo)
	return h
}

// buildOpusTags builds the OpusTags comment header packet.
// https://wiki.xiph.org/OggOpus#Comment_Header
func buildOpusTags() []byte {
	vendor := "UberSDR"
	t := make([]byte, 8+4+len(vendor)+4)
	copy(t[0:8], []byte("OpusTags"))
	binary.LittleEndian.PutUint32(t[8:12], uint32(len(vendor)))
	copy(t[12:12+len(vendor)], vendor)
	binary.LittleEndian.PutUint32(t[12+len(vendor):], 0) // user comment list length = 0
	return t
}

// HandleAudioStream serves GET /audio/stream?session=<userSessionID>.
//
// It is registered in main.go and receives the global SessionManager and
// Config so it can look up the session and create an Opus encoder with the
// configured bitrate/complexity.
func HandleAudioStream(sessions *SessionManager, config *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ── 1. Extract and validate the user session ID ───────────────────────
		userSessionID := r.URL.Query().Get("session")
		if !isValidUUID(userSessionID) {
			http.Error(w, "Missing or invalid session parameter", http.StatusBadRequest)
			return
		}

		// ── 2. Security checks (same as WebSocket handler) ────────────────────
		clientIP := getClientIP(r)

		if sessions.IsUUIDKicked(userSessionID) {
			http.Error(w, "Session terminated", http.StatusForbidden)
			return
		}

		if sessions.config.Server.EnforceSessionIPMatch {
			boundIP := sessions.GetUUIDIP(userSessionID)
			if boundIP != "" && boundIP != clientIP {
				log.Printf("[AudioStream] IP mismatch for %s (bound: %s, actual: %s)", userSessionID, boundIP, clientIP)
				http.Error(w, "Session IP mismatch", http.StatusForbidden)
				return
			}
		}

		// ── 3. Require an active audio WebSocket session ──────────────────────
		if !sessions.HasActiveAudioSession(userSessionID) {
			http.Error(w, "No active audio session — connect via WebSocket first", http.StatusNotFound)
			return
		}

		// Find the actual session object
		session := sessions.findAudioSessionByUserID(userSessionID)
		if session == nil || session.AudioChan == nil {
			http.Error(w, "Audio session not ready", http.StatusServiceUnavailable)
			return
		}

		// ── 4. Create Opus encoder ────────────────────────────────────────────
		bitrate := config.Audio.Opus.Bitrate
		if bitrate == 0 {
			bitrate = 24000
		}
		complexity := config.Audio.Opus.Complexity
		if complexity == 0 {
			complexity = 5
		}

		sampleRate := session.SampleRate
		if sampleRate == 0 {
			sampleRate = 12000 // safe default
		}
		channels := session.Channels
		if channels == 0 {
			channels = 1
		}

		enc, err := NewOpusEncoderForClient(sampleRate, bitrate, complexity)
		if err != nil {
			log.Printf("[AudioStream] Failed to create Opus encoder for %s: %v", userSessionID, err)
			http.Error(w, "Opus encoder unavailable", http.StatusServiceUnavailable)
			return
		}

		// ── 5. Set up the HTTP audio channel on the session ───────────────────
		httpChan := make(chan AudioPacket, 20)
		session.httpAudioMu.Lock()
		if session.httpAudioChan != nil {
			// Another HTTP stream is already active — reject this one.
			session.httpAudioMu.Unlock()
			http.Error(w, "Audio stream already active for this session", http.StatusConflict)
			return
		}
		session.httpAudioChan = httpChan
		session.httpAudioMu.Unlock()

		// Ensure cleanup on any exit path.
		defer func() {
			session.httpAudioMu.Lock()
			// Only nil the pointer if it still points to our channel (not a
			// replacement from a later request).
			if session.httpAudioChan == httpChan {
				session.httpAudioChan = nil
			}
			session.httpAudioMu.Unlock()
			log.Printf("[AudioStream] HTTP stream closed for %s — WebSocket audio resumed", userSessionID)
		}()

		// ── 6. Write HTTP response headers ────────────────────────────────────
		w.Header().Set("Content-Type", "audio/ogg; codecs=opus")
		w.Header().Set("Cache-Control", "no-cache, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Disable proxy/CDN buffering so the browser receives audio data
		// immediately rather than waiting for the proxy buffer to fill.
		// X-Accel-Buffering: no — nginx/Caddy
		// X-Accel-Buffering is respected by Caddy's reverse_proxy directive.
		w.Header().Set("X-Accel-Buffering", "no")
		// Allow cross-origin requests (e.g. from a PWA served on the same origin
		// but accessed via a different port during development).
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)

		flusher, canFlush := w.(http.Flusher)

		// ── 7. Write Ogg/Opus stream headers ─────────────────────────────────
		const serialNo = 0x55424552 // "UBER" as a serial number

		// BOS page: OpusHead
		if err := writeOggPage(w, serialNo, 0, 0, 0x02, buildOpusHead(channels)); err != nil {
			return
		}
		// Comment page: OpusTags
		if err := writeOggPage(w, serialNo, 1, 0, 0x00, buildOpusTags()); err != nil {
			return
		}
		if canFlush {
			flusher.Flush()
		}

		log.Printf("[AudioStream] HTTP Ogg/Opus stream started for %s (%d Hz, %d ch, %d bps)",
			userSessionID, sampleRate, channels, bitrate)

		// ── 8. Stream audio packets ───────────────────────────────────────────
		var seqNo uint32 = 2      // pages 0 and 1 used for headers
		var granulePos uint64 = 0 // cumulative sample count

		for {
			select {
			case <-r.Context().Done():
				// Client disconnected.
				return

			case <-session.Done:
				// Session destroyed (user disconnected WebSocket, kicked, etc.)
				return

			case pkt, ok := <-httpChan:
				if !ok {
					// Channel closed — shouldn't happen (we never close it), but safe.
					return
				}

				// Encode PCM → Opus
				opusData, err := enc.EncodeBinary(pkt.PCMData)
				if err != nil || len(opusData) == 0 {
					continue
				}

				// Advance granule position.
				// Ogg/Opus REQUIRES granule positions in 48 kHz samples regardless
				// of the actual input sample rate.  Convert from the session sample
				// rate to 48 kHz.
				// PCMData is big-endian int16 (2 bytes per sample per channel).
				samplesAtInputRate := uint64(len(pkt.PCMData)) / uint64(2*channels)
				// Scale to 48 kHz (Opus internal rate)
				samplesAt48k := samplesAtInputRate * 48000 / uint64(sampleRate)
				granulePos += samplesAt48k

				// Write Ogg data page
				if err := writeOggPage(w, serialNo, seqNo, granulePos, 0x00, opusData); err != nil {
					return
				}
				seqNo++

				if canFlush {
					flusher.Flush()
				}
			}
		}
	}
}

// findAudioSessionByUserID finds the non-spectrum audio session for a given
// userSessionID.  Returns nil if not found.
// This mirrors the same lookup in audio_extension_manager.go.
func (sm *SessionManager) findAudioSessionByUserID(userSessionID string) *Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	for _, session := range sm.sessions {
		if session.UserSessionID == userSessionID && !session.IsSpectrum {
			return session
		}
	}
	return nil
}
