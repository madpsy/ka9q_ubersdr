package main

// api_audio_ws.go — WebSocket audio stream broker for GET /api/v1/audio/stream.
//
// AudioWSBroker implements StreamSink so it can be wired into the audio
// delivery pipeline alongside the stdout and UDP sinks.  When WritePCM is
// called it fans out the raw decoded PCM frame to every connected WebSocket
// client.
//
// Protocol
// --------
// 1. Client connects with a standard WebSocket upgrade (GET /api/v1/audio/stream).
// 2. The server immediately sends a JSON text frame describing the stream:
//
//	{"sample_rate": 48000, "channels": 2, "format": "pcm-s16le"}
//
// 3. Every subsequent frame is a binary WebSocket message containing one
//    decoded PCM frame (little-endian signed 16-bit integers, interleaved
//    channels).  Frame duration is ~20 ms; typical sizes are 320–7680 bytes.
// 4. The server sends a WebSocket ping every 30 s to keep proxies alive.
//    Clients should respond with a pong (most WebSocket libraries do this
//    automatically).
// 5. When the stream parameters change (e.g. sample rate or channel count
//    changes mid-session) a new JSON text frame is sent before the next
//    binary frame.
//
// Slow clients
// ------------
// Each client has a buffered send channel (capacity 8 frames).  If the
// channel is full when a new frame arrives the frame is dropped for that
// client rather than blocking the audio delivery goroutine.  This prevents
// a slow or stalled HTTP client from affecting audio playback.
//
// Multiple clients
// ----------------
// Any number of WebSocket clients may connect simultaneously.  Each receives
// an independent copy of every PCM frame.

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// wsAudioFrame is sent to each subscriber's channel.
type wsAudioFrame struct {
	// pcm is the raw PCM bytes (little-endian int16).  It is a copy so the
	// original slice can be reused by the caller.
	pcm        []byte
	sampleRate int
	channels   int
}

// wsAudioClient represents one connected WebSocket subscriber.
type wsAudioClient struct {
	ch         chan wsAudioFrame
	lastRate   int
	lastCh     int
	headerSent bool
}

// AudioWSBroker fans out decoded PCM frames to connected WebSocket clients.
// It implements StreamSink so it can be plugged directly into the audio
// delivery pipeline.
type AudioWSBroker struct {
	mu      sync.Mutex
	clients map[*wsAudioClient]struct{}
}

// NewAudioWSBroker creates an AudioWSBroker with no subscribers.
func NewAudioWSBroker() *AudioWSBroker {
	return &AudioWSBroker{
		clients: make(map[*wsAudioClient]struct{}),
	}
}

// WritePCM implements StreamSink.  It copies pcmLE and fans it out to all
// connected WebSocket clients.  Called from the audio delivery goroutine.
func (b *AudioWSBroker) WritePCM(pcmLE []byte, sampleRate, channels int) {
	b.mu.Lock()
	if len(b.clients) == 0 {
		b.mu.Unlock()
		return
	}
	// Copy the slice once; all clients share the same copy (read-only after this).
	buf := make([]byte, len(pcmLE))
	copy(buf, pcmLE)
	frame := wsAudioFrame{pcm: buf, sampleRate: sampleRate, channels: channels}
	for c := range b.clients {
		select {
		case c.ch <- frame:
		default:
			// client is behind — drop frame rather than block
		}
	}
	b.mu.Unlock()
}

// Close implements StreamSink.  Closes all subscriber channels, causing their
// goroutines to exit and the WebSocket connections to be closed.
func (b *AudioWSBroker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for c := range b.clients {
		close(c.ch)
		delete(b.clients, c)
	}
}

// subscribe registers a new client and returns it.
func (b *AudioWSBroker) subscribe() *wsAudioClient {
	c := &wsAudioClient{ch: make(chan wsAudioFrame, 8)}
	b.mu.Lock()
	b.clients[c] = struct{}{}
	b.mu.Unlock()
	return c
}

// unsubscribe removes a client.
func (b *AudioWSBroker) unsubscribe(c *wsAudioClient) {
	b.mu.Lock()
	delete(b.clients, c)
	b.mu.Unlock()
}

// wsUpgrader configures the WebSocket upgrade.  CheckOrigin is permissive
// because the API is intended for local/trusted use.
var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  256,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ServeHTTP handles GET /api/v1/audio/stream.
func (b *AudioWSBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade writes its own error response on failure.
		return
	}
	defer conn.Close()

	// Drain incoming messages (pongs, close frames) in a separate goroutine
	// so the write loop is never blocked waiting for a read.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	client := b.subscribe()
	defer b.unsubscribe(client)

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return

		case <-ping.C:
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}

		case frame, ok := <-client.ch:
			if !ok {
				// broker closed
				return
			}

			conn.SetWriteDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck

			// Send a JSON header frame whenever stream parameters change.
			if !client.headerSent || client.lastRate != frame.sampleRate || client.lastCh != frame.channels {
				hdr, _ := json.Marshal(map[string]any{
					"sample_rate": frame.sampleRate,
					"channels":    frame.channels,
					"format":      "pcm-s16le",
				})
				if err := conn.WriteMessage(websocket.TextMessage, hdr); err != nil {
					return
				}
				client.headerSent = true
				client.lastRate = frame.sampleRate
				client.lastCh = frame.channels
			}

			// Send the PCM frame as a binary message.
			if err := conn.WriteMessage(websocket.BinaryMessage, frame.pcm); err != nil {
				return
			}
		}
	}
}
