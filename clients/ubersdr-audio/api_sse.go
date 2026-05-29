package main

// api_sse.go — Server-Sent Events broker for /api/v1/signal/stream.
//
// The broker maintains a set of subscriber channels.  When the AudioOutput
// onChunkPlayed callback fires (throttled to ~100 ms by client.go), it calls
// SSEBroker.Publish() which fans out the signal event to all connected HTTP
// clients.
//
// Each SSE client gets its own buffered channel (capacity 4).  If a client
// falls behind (channel full), the event is dropped for that client rather
// than blocking the publish path.  The HTTP handler drains the channel and
// writes SSE frames to the response writer.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// SSESignalEvent is the JSON payload sent to each SSE subscriber.
type SSESignalEvent struct {
	BasebandDBFS     float32    `json:"baseband_dbfs"`
	NoiseDensityDBFS float32    `json:"noise_density_dbfs"`
	SNRDB            float32    `json:"snr_db"`
	AudioDBFS        float32    `json:"audio_dbfs"`
	UpdatedAt        *time.Time `json:"updated_at"`
}

// noDataEvent is the sentinel event sent when signal data is unavailable.
var noDataEvent = SSESignalEvent{
	BasebandDBFS:     -999,
	NoiseDensityDBFS: -999,
	SNRDB:            -999,
	AudioDBFS:        -999,
	UpdatedAt:        nil,
}

// SSEBroker manages a set of SSE subscriber channels and fans out events.
type SSEBroker struct {
	mu          sync.Mutex
	subscribers map[chan SSESignalEvent]struct{}
}

// NewSSEBroker creates a new SSEBroker.
func NewSSEBroker() *SSEBroker {
	return &SSEBroker{
		subscribers: make(map[chan SSESignalEvent]struct{}),
	}
}

// subscribe registers a new subscriber channel and returns it.
// The caller must call unsubscribe when done.
func (b *SSEBroker) subscribe() chan SSESignalEvent {
	ch := make(chan SSESignalEvent, 4)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

// unsubscribe removes a subscriber channel.
func (b *SSEBroker) unsubscribe(ch chan SSESignalEvent) {
	b.mu.Lock()
	delete(b.subscribers, ch)
	b.mu.Unlock()
}

// Publish sends an event to all subscribers.  Drops the event for any
// subscriber whose channel is full (non-blocking).
func (b *SSEBroker) Publish(evt SSESignalEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subscribers {
		select {
		case ch <- evt:
		default:
			// subscriber is behind — drop rather than block
		}
	}
}

// PublishSignal is a convenience wrapper that builds an SSESignalEvent from
// the raw signal quality values and publishes it.
func (b *SSEBroker) PublishSignal(basebandDBFS, noiseDensityDBFS, snrDB, audioDBFS float32, updatedAt *time.Time) {
	b.Publish(SSESignalEvent{
		BasebandDBFS:     basebandDBFS,
		NoiseDensityDBFS: noiseDensityDBFS,
		SNRDB:            snrDB,
		AudioDBFS:        audioDBFS,
		UpdatedAt:        updatedAt,
	})
}

// PublishNoData sends the no-data sentinel to all subscribers.
// Called on disconnect or when entering IQ mode.
func (b *SSEBroker) PublishNoData() {
	b.Publish(noDataEvent)
}

// ServeHTTP implements the /api/v1/signal/stream SSE endpoint.
// It subscribes to the broker, streams events to the client, and sends a
// keepalive comment every 15 s when idle.
func (b *SSEBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// SSE requires the response writer to support flushing.
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := b.subscribe()
	defer b.unsubscribe(ch)

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			// Client disconnected.
			return

		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(evt)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()

		case <-keepalive.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
