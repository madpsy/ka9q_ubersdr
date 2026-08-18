package main

// noise_floor_spectrum_sse.go — SSE endpoint for real-time per-band spectrum data.
//
// Endpoint:
//
//	GET /api/noisefloor/spectrum/stream
//
// Query parameters:
//
//	band=<name>   (repeatable, e.g. ?band=20m&band=40m)
//	              If omitted, all configured bands are streamed.
//	              A synthetic "wideband" pseudo-band (0-30 MHz, the same
//	              channel used by the spectrogram) is also selectable via
//	              ?band=wideband, but is never included in the default set.
//	              Unlike named bands, wideband is a 10-second rolling average
//	              (not a per-poll max-hold) rather than raw per-poll data, but
//	              it's emitted at the same cadence as every other band —
//	              see GetWideBandFFT in noise_floor.go for how that average
//	              stays cheap to recompute that often.
//
// Each SSE event carries the binary8-encoded spectrum for one band, base64-encoded:
//
//	id: <band-name>
//	event: spectrum
//	data: <base64(SPEC binary8 packet)>
//
// The SPEC binary8 packet format is identical to the WebSocket binary8 mode:
//
//	Header (22 bytes):
//	  [0-3]  Magic:     0x53 0x50 0x45 0x43  ("SPEC")
//	  [4]    Version:   0x01
//	  [5]    Flags:     0x03 = full uint8 frame
//	                    0x04 = delta uint8 frame
//	  [6-13] Timestamp: uint64 nanoseconds (little-endian)
//	  [14-21] Frequency: uint64 Hz center frequency (little-endian)
//
//	Full frame  (flags=0x03): header + binCount × uint8
//	Delta frame (flags=0x04): header + uint16 changeCount + N × [uint16 index, uint8 value]
//
//	uint8 encoding: 0 = −256 dBFS, 255 = 0 dBFS (clamped).
//
// A heartbeat event is sent every 30 s:
//
//	event: heartbeat
//	data: {"bands":["20m","40m"],"timestamp":"2026-07-13T10:00:00Z"}
//
// Architecture:
//
//	Each HTTP connection runs its own goroutine with its own per-band spectrumState.
//	There is no shared hub or fan-out — each connection is fully independent.
//	Data is sourced exclusively from nfm.GetLatestFFT(), which reads from the
//	in-memory ring buffers already populated by the 1-second background poll.
//	No additional radiod channels or multicast traffic are created.
//
// JavaScript client example:
//
//	// 1. Fetch band metadata once.
//	const cfg = await fetch('/api/noisefloor/config').then(r => r.json());
//	const bandMeta = Object.fromEntries(cfg.bands.map(b => [b.name, b]));
//
//	// 2. Open SSE stream for selected bands.
//	const src = new EventSource('/api/noisefloor/spectrum/stream?band=20m&band=40m');
//
//	// 3. Maintain per-band uint8 state arrays for delta decoding.
//	const state = {};
//
//	src.addEventListener('spectrum', e => {
//	    const band = e.lastEventId;
//	    const meta = bandMeta[band];
//	    if (!meta) return;
//
//	    // Decode base64 → Uint8Array.
//	    const raw = Uint8Array.from(atob(e.data), c => c.charCodeAt(0));
//	    if (raw.length < 22) return;
//
//	    const view  = new DataView(raw.buffer);
//	    const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
//	    if (magic !== 'SPEC') return;
//
//	    const flags = raw[5]; // 0x03 = full, 0x04 = delta
//
//	    if (flags === 0x03) {
//	        // Full frame: bins start at offset 22.
//	        state[band] = raw.slice(22);
//	    } else if (flags === 0x04) {
//	        // Delta frame: apply changes to existing state.
//	        if (!state[band]) return; // need a full frame first
//	        const changeCount = view.getUint16(22, true);
//	        for (let i = 0; i < changeCount; i++) {
//	            const idx = view.getUint16(24 + i * 3, true);
//	            const val = raw[26 + i * 3];
//	            state[band][idx] = val;
//	        }
//	    }
//
//	    // Map bin index → Hz: startHz + i * binBandwidth
//	    const bins = state[band];
//	    for (let i = 0; i < bins.length; i++) {
//	        const hz  = meta.start + i * meta.bin_bandwidth;
//	        const dbm = bins[i] - 256; // uint8 → dBFS
//	        // ... render to canvas, chart, etc.
//	    }
//	});
//
//	src.addEventListener('heartbeat', e => {
//	    const hb = JSON.parse(e.data);
//	    console.log('heartbeat', hb.timestamp);
//	});

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// The SSE poll interval is derived at runtime from config.Spectrum.BackgroundPollPeriodMs
// so it always matches the background poll rate — see HandleNoiseFloorSpectrumStream.

// nfSpectrumSSEHeartbeatInterval is how often a heartbeat event is sent to keep
// NAT sessions alive and give clients a liveness signal.
const nfSpectrumSSEHeartbeatInterval = 30 * time.Second

// nfSpectrumSSEWriteTimeout bounds a single write to the client. It exists to
// break the one case where a connection slot is held forever: a peer that stops
// reading without closing (a wedged tunnel or proxy), where the write blocks
// with no error and no context cancellation to end it.
const nfSpectrumSSEWriteTimeout = 30 * time.Second

// wideBandSSEName and wideBandSSECenterHz describe the synthetic "wideband"
// pseudo-band exposed on this endpoint. It mirrors the 0-30 MHz channel used
// by the spectrogram (see NewSpectrogramRecorder / nfm.GetWideBandFFT) and is
// fetched separately from the per-band fftBuffers map.
//
// Emitted on the same pollTicker as every named band — GetWideBandFFT() is
// memoized against background_poll_period_ms itself (see that function in
// noise_floor.go), so there's no separate cost-bounding cadence to manage
// here; asking for it every tick, same as any other band, is already cheap.
const (
	wideBandSSEName     = "wideband"
	wideBandSSECenterHz = 15_000_000
)

// encodeBinary8PacketForSSE encodes []float32 spectrum data into the SPEC binary8
// wire format used by both the WebSocket spectrum path and this SSE endpoint.
//
// Parameters:
//   - data:          raw float32 dBFS values (one per FFT bin)
//   - centerFreqHz:  center frequency of the band in Hz (written into the header)
//   - state:         per-connection, per-band encoding state (delta tracking)
//   - deltaThreshold: minimum dB change required to include a bin in a delta frame
//
// Returns nil if data is nil or empty (caller should skip sending for this tick).
//
// Thread safety: state is owned exclusively by the calling goroutine; the mutex
// inside state is still acquired for correctness (matches the WebSocket path).
func encodeBinary8PacketForSSE(data []float32, centerFreqHz uint64, state *spectrumState, deltaThreshold float64) []byte {
	if len(data) == 0 {
		return nil
	}

	// ── float32 dBFS → uint8 conversion ──────────────────────────────────────
	// Reuse per-state scratch buffer to avoid per-frame heap allocation.
	state.mu.Lock()
	if len(state.data8Buf) != len(data) {
		state.data8Buf = make([]uint8, len(data))
	}
	spectrumData8 := state.data8Buf
	state.mu.Unlock()

	for i, val := range data {
		if val < -256 {
			val = -256
		} else if val > 0 {
			val = 0
		}
		spectrumData8[i] = uint8(val + 256)
	}

	// ── decide full vs delta ──────────────────────────────────────────────────
	state.mu.RLock()
	prevData8 := state.previousData8
	needsResize := len(prevData8) != len(spectrumData8)
	state.mu.RUnlock()

	sendFullFrame := needsResize || len(prevData8) == 0

	// Reuse per-state changes scratch buffer.
	state.mu.Lock()
	if cap(state.changes8Buf) < len(spectrumData8) {
		state.changes8Buf = make([]changeEntry8, 0, len(spectrumData8))
	}
	state.changes8Buf = state.changes8Buf[:0]
	state.mu.Unlock()

	if !sendFullFrame {
		for i := 0; i < len(spectrumData8); i++ {
			oldDB := float64(prevData8[i]) - 256
			newDB := float64(spectrumData8[i]) - 256
			if math.Abs(newDB-oldDB) > deltaThreshold {
				state.changes8Buf = append(state.changes8Buf, changeEntry8{
					index: uint16(i),
					value: spectrumData8[i],
				})
			}
		}
		// If >80 % of bins changed, a full frame is cheaper.
		if len(state.changes8Buf) > (len(spectrumData8)*4)/5 {
			sendFullFrame = true
		}
	}

	timestamp := time.Now().UnixNano()
	const headerSize = 22

	var packet []byte

	if sendFullFrame {
		packet = make([]byte, headerSize+len(spectrumData8))

		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'
		packet[4] = 0x01 // version
		packet[5] = 0x03 // flags: full uint8

		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))
		binary.LittleEndian.PutUint64(packet[14:22], centerFreqHz)
		copy(packet[headerSize:], spectrumData8)

		state.mu.Lock()
		if needsResize {
			state.previousData8 = make([]uint8, len(spectrumData8))
		}
		copy(state.previousData8, spectrumData8)
		state.mu.Unlock()
	} else {
		changes := state.changes8Buf
		packet = make([]byte, headerSize+2+len(changes)*3)

		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'
		packet[4] = 0x01 // version
		packet[5] = 0x04 // flags: delta uint8

		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))
		binary.LittleEndian.PutUint64(packet[14:22], centerFreqHz)
		binary.LittleEndian.PutUint16(packet[headerSize:headerSize+2], uint16(len(changes)))

		off := headerSize + 2
		for _, ch := range changes {
			binary.LittleEndian.PutUint16(packet[off:off+2], ch.index)
			packet[off+2] = ch.value
			off += 3
		}

		state.mu.Lock()
		for _, ch := range changes {
			state.previousData8[ch.index] = ch.value
		}
		state.mu.Unlock()
	}

	return packet
}

// HandleNoiseFloorSpectrumStream returns an HTTP handler that streams per-band
// spectrum data as Server-Sent Events.
//
// Each connection runs its own goroutine with its own per-band spectrumState.
// No shared state exists between connections.
//
// Parameters:
//   - nfm:          noise floor monitor (source of FFT data); may be nil if
//     noise floor monitoring is disabled — handler returns 503.
//   - config:       application config (for band list and delta threshold).
//   - limiter:      per-IP concurrent connection limiter.
//   - serverConfig: used to check whether the client IP is bypass-exempt.
func HandleNoiseFloorSpectrumStream(
	nfm *NoiseFloorMonitor,
	config *Config,
	limiter *SSEIPLimiter,
	serverConfig *ServerConfig,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ── panic recovery — must not crash the server ────────────────────────
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("NoiseFloorSpectrumSSE: panic recovered: %v\n%s", rec, debug.Stack())
			}
		}()

		// ── availability check ────────────────────────────────────────────────
		if nfm == nil {
			http.Error(w, "noise floor monitoring is not enabled", http.StatusServiceUnavailable)
			return
		}

		// ── flusher check ─────────────────────────────────────────────────────
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// ── client identity and per-IP connection limit ───────────────────────
		// acquireSSEConn resolves the IP through getClientIP, which reads
		// X-Real-IP / X-Forwarded-For only when the request arrives from the
		// configured tunnel server or a trusted proxy. Reading them from anyone
		// would let a client pick which IP it is counted as — and so spend
		// somebody else's connection slots, or share one identity with every
		// other request carrying the same forged header.
		//
		// streamCtx ends when the client goes away or a newer connection from
		// the same IP displaces this one; the loop below selects on it rather
		// than on the request context.
		streamCtx, ip, releaseSlot, admitted := acquireSSEConn(w, r, limiter, serverConfig)
		if !admitted {
			return
		}
		defer releaseSlot()

		// ── build the set of configured bands (name → center frequency) ───────
		// Includes a synthetic "wideband" entry (0-30 MHz, center 15 MHz) backed
		// by nfm.GetWideBandFFT() rather than the per-band fftBuffers map — see
		// the fetch in the main event loop below. It is only streamed when
		// explicitly requested via ?band=wideband, not included in the default
		// (no ?band=) set, to avoid changing behavior for existing clients.
		configuredBands := make(map[string]uint64, len(config.NoiseFloor.Bands)+1)
		for _, b := range config.NoiseFloor.Bands {
			configuredBands[b.Name] = b.CenterFrequency
		}
		configuredBands[wideBandSSEName] = wideBandSSECenterHz

		// ── parse ?band= query parameters ────────────────────────────────────
		// Repeatable: ?band=20m&band=40m
		// If none supplied, stream all configured bands.
		requestedNames := r.URL.Query()["band"]

		var bands []struct {
			name     string
			centerHz uint64
		}

		if len(requestedNames) == 0 {
			// Default: all configured bands in config order.
			for _, b := range config.NoiseFloor.Bands {
				bands = append(bands, struct {
					name     string
					centerHz uint64
				}{b.Name, b.CenterFrequency})
			}
		} else {
			// Validate each requested band name.
			seen := make(map[string]bool, len(requestedNames))
			for _, name := range requestedNames {
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				if seen[name] {
					continue // deduplicate
				}
				seen[name] = true
				centerHz, exists := configuredBands[name]
				if !exists {
					http.Error(w,
						fmt.Sprintf("unknown band %q; configured bands: %s",
							name, strings.Join(configuredBandNames(config), ", ")),
						http.StatusBadRequest)
					return
				}
				bands = append(bands, struct {
					name     string
					centerHz uint64
				}{name, centerHz})
			}
		}

		if len(bands) == 0 {
			http.Error(w, "no bands configured", http.StatusServiceUnavailable)
			return
		}

		// ── SSE response headers ──────────────────────────────────────────────
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // disable nginx/caddy buffering

		// ── per-band encoding state (goroutine-local, never shared) ──────────
		states := make(map[string]*spectrumState, len(bands))
		for _, b := range bands {
			states[b.name] = &spectrumState{}
		}

		deltaThreshold := config.Spectrum.DeltaThresholdDB

		// ── log connection ────────────────────────────────────────────────────
		bandNames := make([]string, len(bands))
		for i, b := range bands {
			bandNames[i] = b.name
		}
		log.Printf("NoiseFloorSpectrumSSE: client connected (ip=%s bands=%s)",
			ip, strings.Join(bandNames, ","))

		// ── write deadline ────────────────────────────────────────────────────
		// A deadline on every write, so a peer that stops reading without
		// closing cannot park this goroutine in Write forever. That is the one
		// way the connection slot leaks permanently: no write error, no context
		// cancellation, nothing left to notice the client is gone. Generous
		// enough that a briefly congested tunnel is not mistaken for one —
		// frames are a few KB at a few Hz.
		rc := http.NewResponseController(w)
		setWriteDeadline := func() {
			// ErrNotSupported (a wrapped ResponseWriter in a test) just means no
			// deadline; the stream still works.
			_ = rc.SetWriteDeadline(time.Now().Add(nfSpectrumSSEWriteTimeout))
		}

		// ── send initial connection comment + retry hint ──────────────────────
		setWriteDeadline()
		fmt.Fprintf(w, ": connected to noise floor spectrum stream\nretry: 3000\n\n")
		flusher.Flush()

		// ── tickers ───────────────────────────────────────────────────────────
		// Derive poll interval from config so it always matches the background
		// poll rate (background_poll_period_ms). config.go clamps this to
		// [100, 2000] ms so it is always a safe positive value here.
		pollTicker := time.NewTicker(time.Duration(config.Spectrum.BackgroundPollPeriodMs) * time.Millisecond)
		defer pollTicker.Stop()

		heartbeatTicker := time.NewTicker(nfSpectrumSSEHeartbeatInterval)
		defer heartbeatTicker.Stop()

		// ── main event loop ───────────────────────────────────────────────────
		for {
			select {
			case <-streamCtx.Done():
				// Client disconnected, server shutting down, or this stream was
				// displaced by a newer one from the same IP — worth telling
				// apart in the log, since a run of displacements is a client
				// reconnecting rather than a client leaving.
				if r.Context().Err() == nil {
					log.Printf("NoiseFloorSpectrumSSE: stream displaced by a newer connection (ip=%s)", ip)
				} else {
					log.Printf("NoiseFloorSpectrumSSE: client disconnected (ip=%s)", ip)
				}
				return

			case <-pollTicker.C:
				// Emit one spectrum event per requested band, at the same
				// cadence for all of them — including wideband. This used to
				// run wideband off its own slower ticker to bound the cost of
				// GetWideBandFFT()'s 10-second average, but that's now
				// memoized (wideBandCacheTTL in noise_floor.go): calling it
				// every tick is cheap (a cached copy) except for roughly one
				// real recompute per second system-wide, however many
				// clients or how fast they're ticking. Keeping wideband on
				// its own slower ticker after that would only have made it
				// visibly lag every other band for no remaining benefit.
				//
				// Once per tick rather than once per write: the deadline has to
				// cover the Flush below as well, which happens whether or not
				// any band had data to send. A tick that writes nothing would
				// otherwise reach Flush on a deadline set 30 s ago and break a
				// perfectly healthy connection — bands are legitimately empty
				// during startup or a source stall.
				setWriteDeadline()

				for _, b := range bands {
					var fft *BandFFT
					if b.name == wideBandSSEName {
						fft = nfm.GetWideBandFFT()
					} else {
						fft = nfm.GetLatestFFT(b.name)
					}
					if fft == nil || len(fft.Data) == 0 {
						// Band not yet populated (startup / stall) — skip silently.
						continue
					}

					packet := encodeBinary8PacketForSSE(fft.Data, b.centerHz, states[b.name], deltaThreshold)
					if packet == nil {
						continue
					}

					encoded := base64.StdEncoding.EncodeToString(packet)

					// SSE event: id carries the band name so the client can
					// identify which band this frame belongs to via e.lastEventId.
					if _, err := fmt.Fprintf(w, "id: %s\nevent: spectrum\ndata: %s\n\n",
						b.name, encoded); err != nil {
						log.Printf("NoiseFloorSpectrumSSE: write error (ip=%s band=%s): %v",
							ip, b.name, err)
						return
					}
				}
				flusher.Flush()

			case <-heartbeatTicker.C:
				ts := time.Now().UTC().Format(time.RFC3339)
				hb := fmt.Sprintf(`{"bands":["%s"],"timestamp":%q}`,
					strings.Join(bandNames, `","`), ts)
				setWriteDeadline()
				if _, err := fmt.Fprintf(w, "event: heartbeat\ndata: %s\n\n", hb); err != nil {
					log.Printf("NoiseFloorSpectrumSSE: heartbeat write error (ip=%s): %v", ip, err)
					return
				}
				flusher.Flush()
			}
		}
	}
}

// configuredBandNames returns the names of all configured noise floor bands
// in config order, plus the synthetic "wideband" pseudo-band. Used for error
// messages.
func configuredBandNames(config *Config) []string {
	names := make([]string, len(config.NoiseFloor.Bands), len(config.NoiseFloor.Bands)+1)
	for i, b := range config.NoiseFloor.Bands {
		names[i] = b.Name
	}
	return append(names, wideBandSSEName)
}
