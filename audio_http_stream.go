package main

// audio_http_stream.go — HTTP WebM/Opus audio stream endpoint.
//
// GET /audio/stream?session=<userSessionID>
//
// Streams the session's audio as a continuous WebM/Opus HTTP response so that
// a hidden <audio src="/audio/stream?session=..."> element can play it.
// Android Chrome requires a URL-based <audio> element to show the lock-screen
// / notification media widget; a pure AudioContext + navigator.mediaSession
// metadata is not sufficient.
//
// WebM is used instead of Ogg because:
//   - Chrome/Android buffers WebM streams with much lower latency (~200ms vs ~3s)
//   - WebM is designed for streaming; Ogg was designed for files
//   - The WebM container is simpler to implement for audio-only Opus
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
	"fmt"
	"log"
	"net/http"
)

// ── WebM/Opus muxer ──────────────────────────────────────────────────────────
//
// WebM is a subset of Matroska (MKV).  For audio-only Opus streaming we need:
//   1. EBML header
//   2. Segment element (unknown size — live streaming)
//   3. SeekHead (optional, omitted for simplicity)
//   4. Info element (timecode scale, muxing app)
//   5. Tracks element (one audio track, Opus codec)
//   6. Cluster elements (one per ~100ms, containing SimpleBlock frames)
//
// EBML encoding: variable-length integers (VINT) and element IDs.

// ebmlVINT encodes n as an EBML variable-length integer.
func ebmlVINT(n uint64) []byte {
	switch {
	case n < 0x7f:
		return []byte{byte(n | 0x80)}
	case n < 0x3fff:
		return []byte{byte((n >> 8) | 0x40), byte(n)}
	case n < 0x1fffff:
		return []byte{byte((n >> 16) | 0x20), byte(n >> 8), byte(n)}
	case n < 0x0fffffff:
		return []byte{byte((n >> 24) | 0x10), byte(n >> 16), byte(n >> 8), byte(n)}
	default:
		// 8-byte VINT for unknown size (0x01 + 7 bytes of 0xFF = unknown)
		return []byte{0x01, byte(n >> 48), byte(n >> 40), byte(n >> 32), byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}
	}
}

// ebmlID returns the raw bytes for a known EBML element ID.
// IDs are already encoded (leading bits set per EBML spec).
func ebmlElem(id []byte, data []byte) []byte {
	out := make([]byte, 0, len(id)+8+len(data))
	out = append(out, id...)
	out = append(out, ebmlVINT(uint64(len(data)))...)
	out = append(out, data...)
	return out
}

// ebmlUint encodes an unsigned integer as EBML uint (big-endian, minimal bytes).
func ebmlUint(v uint64) []byte {
	switch {
	case v < 0x100:
		return []byte{byte(v)}
	case v < 0x10000:
		return []byte{byte(v >> 8), byte(v)}
	case v < 0x1000000:
		return []byte{byte(v >> 16), byte(v >> 8), byte(v)}
	case v < 0x100000000:
		return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	default:
		return []byte{byte(v >> 56), byte(v >> 48), byte(v >> 40), byte(v >> 32), byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	}
}

// buildWebMHeader builds the EBML + Segment + Info + Tracks header for a
// WebM/Opus audio-only live stream.
func buildWebMHeader(sampleRate int, channels int) []byte {
	// ── EBML header ──────────────────────────────────────────────────────────
	ebmlHeader := ebmlElem([]byte{0x1A, 0x45, 0xDF, 0xA3}, concat(
		ebmlElem([]byte{0x42, 0x86}, []byte{0x01}),   // EBMLVersion = 1
		ebmlElem([]byte{0x42, 0xF7}, []byte{0x01}),   // EBMLReadVersion = 1
		ebmlElem([]byte{0x42, 0xF2}, []byte{0x04}),   // EBMLMaxIDLength = 4
		ebmlElem([]byte{0x42, 0xF3}, []byte{0x08}),   // EBMLMaxSizeLength = 8
		ebmlElem([]byte{0x42, 0x82}, []byte("webm")), // DocType = "webm"
		ebmlElem([]byte{0x42, 0x87}, []byte{0x04}),   // DocTypeVersion = 4
		ebmlElem([]byte{0x42, 0x85}, []byte{0x02}),   // DocTypeReadVersion = 2
	))

	// ── Segment (unknown size — live streaming) ───────────────────────────────
	// Size = 0x01 followed by 7 bytes of 0xFF = unknown/streaming size
	segmentID := []byte{0x18, 0x53, 0x80, 0x67}
	unknownSize := []byte{0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}

	// ── Info ─────────────────────────────────────────────────────────────────
	// TimestampScale = 1000000 (1ms per timecode unit)
	info := ebmlElem([]byte{0x15, 0x49, 0xA9, 0x66}, concat(
		ebmlElem([]byte{0x2A, 0xD7, 0xB1}, ebmlUint(1000000)), // TimestampScale = 1ms
		ebmlElem([]byte{0x4D, 0x80}, []byte("UberSDR")),       // MuxingApp
		ebmlElem([]byte{0x57, 0x41}, []byte("UberSDR")),       // WritingApp
	))

	// ── Opus codec private data (OpusHead) ───────────────────────────────────
	// Required by WebM Opus spec: https://www.webmproject.org/vp9/mp4/#opus-codec-private
	opusHead := make([]byte, 19)
	copy(opusHead[0:8], "OpusHead")
	opusHead[8] = 1                                       // version
	opusHead[9] = byte(channels)                          // channels
	binary.LittleEndian.PutUint16(opusHead[10:12], 0)     // pre-skip
	binary.LittleEndian.PutUint32(opusHead[12:16], 48000) // input sample rate (always 48000)
	binary.LittleEndian.PutUint16(opusHead[16:18], 0)     // output gain
	opusHead[18] = 0                                      // channel mapping family

	// Sampling frequency as 4-byte big-endian float32 (48000.0)
	sfBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(sfBytes, 0x47BB8000) // 48000.0 as IEEE 754

	// ── Audio track ──────────────────────────────────────────────────────────
	audioSettings := ebmlElem([]byte{0xE1}, concat(
		ebmlElem([]byte{0xB5}, sfBytes),                    // SamplingFrequency = 48000.0
		ebmlElem([]byte{0x9F}, ebmlUint(uint64(channels))), // Channels
	))

	track := ebmlElem([]byte{0xAE}, concat(
		ebmlElem([]byte{0xD7}, ebmlUint(1)),       // TrackNumber = 1
		ebmlElem([]byte{0x73, 0xC5}, ebmlUint(1)), // TrackUID = 1
		ebmlElem([]byte{0x83}, ebmlUint(2)),       // TrackType = 2 (audio)
		ebmlElem([]byte{0x86}, []byte("A_OPUS")),  // CodecID = "A_OPUS"
		ebmlElem([]byte{0x63, 0xA2}, opusHead),    // CodecPrivate = OpusHead
		ebmlElem([]byte{0x56, 0xAA}, ebmlUint(0)), // CodecDelay = 0
		ebmlElem([]byte{0x56, 0xBB}, ebmlUint(0)), // SeekPreRoll = 80000000 ns (80ms) — use 0 for live
		audioSettings,
	))

	tracks := ebmlElem([]byte{0x16, 0x54, 0xAE, 0x6B}, track)

	// Assemble: EBML header + Segment ID + unknown size + Info + Tracks
	out := make([]byte, 0, 512)
	out = append(out, ebmlHeader...)
	out = append(out, segmentID...)
	out = append(out, unknownSize...)
	out = append(out, info...)
	out = append(out, tracks...)
	return out
}

// writeWebMCluster writes a WebM Cluster containing one SimpleBlock (one Opus frame).
// timecodeMs is the cluster timestamp in milliseconds.
// opusData is the raw Opus frame bytes.
func writeWebMCluster(w http.ResponseWriter, timecodeMs uint64, opusData []byte) error {
	// SimpleBlock: track number (VINT) + relative timecode (int16 BE) + flags + data
	// Relative timecode within cluster = 0 (one frame per cluster)
	trackVINT := ebmlVINT(1) // track 1
	simpleBlock := make([]byte, len(trackVINT)+2+1+len(opusData))
	copy(simpleBlock, trackVINT)
	binary.BigEndian.PutUint16(simpleBlock[len(trackVINT):], 0) // relative timecode = 0
	simpleBlock[len(trackVINT)+2] = 0x80                        // flags: keyframe
	copy(simpleBlock[len(trackVINT)+3:], opusData)

	simpleBlockElem := ebmlElem([]byte{0xA3}, simpleBlock)

	// Cluster timecode
	timecodeElem := ebmlElem([]byte{0xE7}, ebmlUint(timecodeMs))

	// Cluster element
	clusterData := concat(timecodeElem, simpleBlockElem)
	cluster := ebmlElem([]byte{0x1F, 0x43, 0xB6, 0x75}, clusterData)

	_, err := w.Write(cluster)
	return err
}

// concat concatenates byte slices.
func concat(slices ...[]byte) []byte {
	total := 0
	for _, s := range slices {
		total += len(s)
	}
	out := make([]byte, 0, total)
	for _, s := range slices {
		out = append(out, s...)
	}
	return out
}

// HandleAudioStream serves GET /audio/stream?session=<userSessionID>.
func HandleAudioStream(sessions *SessionManager, config *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ── 1. Extract and validate the user session ID ───────────────────────
		userSessionID := r.URL.Query().Get("session")
		if !isValidUUID(userSessionID) {
			http.Error(w, "Missing or invalid session parameter", http.StatusBadRequest)
			return
		}

		// ── 2. Security checks ────────────────────────────────────────────────
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
			sampleRate = 12000
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
		// If a previous HTTP stream is still active (e.g. stale connection from a
		// prior page load), forcibly replace it.  The old goroutine will exit when
		// its r.Context() is cancelled (client already disconnected), and its defer
		// will be a no-op because httpAudioChan != its own httpChan.
		httpChan := make(chan AudioPacket, 20)
		session.httpAudioMu.Lock()
		if session.httpAudioChan != nil {
			log.Printf("[AudioStream] Replacing stale HTTP stream for %s", userSessionID)
		}
		session.httpAudioChan = httpChan
		session.httpAudioMu.Unlock()

		defer func() {
			session.httpAudioMu.Lock()
			if session.httpAudioChan == httpChan {
				session.httpAudioChan = nil
			}
			session.httpAudioMu.Unlock()
			log.Printf("[AudioStream] HTTP stream closed for %s — WebSocket audio resumed", userSessionID)
		}()

		// ── 6. Write HTTP response headers ────────────────────────────────────
		w.Header().Set("Content-Type", "audio/webm; codecs=opus")
		w.Header().Set("Cache-Control", "no-cache, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("icy-br", fmt.Sprintf("%d", bitrate/1000))
		w.Header().Set("icy-name", "UberSDR Live")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)

		flusher, canFlush := w.(http.Flusher)

		// ── 7. Write WebM stream header ───────────────────────────────────────
		header := buildWebMHeader(sampleRate, channels)
		if _, err := w.Write(header); err != nil {
			return
		}
		if canFlush {
			flusher.Flush()
		}

		log.Printf("[AudioStream] HTTP WebM/Opus stream started for %s (%d Hz, %d ch, %d bps)",
			userSessionID, sampleRate, channels, bitrate)

		// ── 8. Stream audio packets ───────────────────────────────────────────
		// Timecode in milliseconds (WebM uses 1ms resolution with TimestampScale=1000000)
		var timecodeMs uint64

		for {
			select {
			case <-r.Context().Done():
				return
			case <-session.Done:
				return
			case pkt, ok := <-httpChan:
				if !ok {
					return
				}

				opusData, err := enc.EncodeBinary(pkt.PCMData)
				if err != nil || len(opusData) == 0 {
					continue
				}

				if err := writeWebMCluster(w, timecodeMs, opusData); err != nil {
					return
				}

				// Advance timecode by frame duration in ms
				// PCMData is big-endian int16 (2 bytes per sample per channel)
				samplesAtInputRate := uint64(len(pkt.PCMData)) / uint64(2*channels)
				durationMs := samplesAtInputRate * 1000 / uint64(sampleRate)
				timecodeMs += durationMs

				if canFlush {
					flusher.Flush()
				}
			}
		}
	}
}

// HandleStopAudioStream serves DELETE /audio/stream?session=<userSessionID>.
//
// Called by the client when it intentionally tears down the HTTP audio stream
// (e.g. the user disables MediaSession).  Immediately nils httpAudioChan so
// streamAudio() resumes sending audio over the WebSocket without waiting for
// the HTTP connection to time out on its own.
func HandleStopAudioStream(sessions *SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		userSessionID := r.URL.Query().Get("session")
		if !isValidUUID(userSessionID) {
			http.Error(w, "Missing or invalid session parameter", http.StatusBadRequest)
			return
		}
		session := sessions.findAudioSessionByUserID(userSessionID)
		if session == nil {
			w.WriteHeader(http.StatusNoContent) // already gone — that's fine
			return
		}
		session.httpAudioMu.Lock()
		session.httpAudioChan = nil
		session.httpAudioMu.Unlock()
		log.Printf("[AudioStream] HTTP stream stopped by client for %s — WebSocket audio resumed", userSessionID)
		w.WriteHeader(http.StatusNoContent)
	}
}

// findAudioSessionByUserID finds the non-spectrum audio session for a given
// userSessionID.  Returns nil if not found.
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
