package olivia

import (
	"encoding/json"
	"log"
	"math"
	"strings"
	"sync"
	"time"
)

// AudioSample contains PCM audio data with timing information.
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod
	GPSTimeNs    int64   // GPS-synchronised Unix time in nanoseconds
}

// The wire format is UTF-8 JSON inside the binary result frames the audio
// extension manager forwards, which is what every decoder written since FSK
// uses — see static/v2/src/extensions/protocol.js. Three frame types, each
// tagged by "type":
//
//	config  once, immediately after attaching. What the decoder actually runs
//	        with, which is not always what was asked for: tones and bandwidth
//	        are quantised, and the frequency search narrows when the tone block
//	        sits low in the passband. The panel displays these rather than
//	        echoing back its own request.
//	text    decoded characters, flushed on a timer while there are any.
//	status  lock state and signal quality, on a slower timer.
//
// Text frames carry only what was decoded since the last one, so a client
// appends rather than replaces. Unlike FSK, an empty text frame is never sent:
// Olivia produces a couple of characters a second at best, and a steady trickle
// of empty frames would be most of the traffic.
const (
	FrameConfig = "config"
	FrameText   = "text"
	FrameStatus = "status"
)

const (
	textFlushInterval   = 100 * time.Millisecond
	statusFlushInterval = 500 * time.Millisecond
)

type configFrame struct {
	Type          string  `json:"type"`
	Tones         int     `json:"tones"`
	Bandwidth     int     `json:"bandwidth"`
	CenterHz      float64 `json:"center_hz"`
	SyncThreshold float64 `json:"sync_threshold"`
	SyncMargin    int     `json:"sync_margin"`
	SyncIntegLen  int     `json:"sync_integ_len"`
	Reverse       bool    `json:"reverse"`
	Contestia     bool    `json:"contestia"`
	SampleRate    int     `json:"sample_rate"`
	SymbolLen     int     `json:"symbol_len"`
	FirstCarrier  int     `json:"first_carrier"`
	BaudRate      float64 `json:"baud_rate"`
	BlockPeriod   float64 `json:"block_period"`
	CharsPerSec   float64 `json:"chars_per_sec"`
	// Set when the frequency search had to be narrowed because the tone block
	// sits too low in the passband to search around. The panel shows it as a
	// hint to tune higher; the decoder still runs.
	Narrowed bool `json:"narrowed,omitempty"`
}

type textFrame struct {
	Type string `json:"type"`
	TS   int64  `json:"ts"`
	Text string `json:"text"`
}

type statusFrame struct {
	Type     string  `json:"type"`
	TS       int64   `json:"ts"`
	Synced   bool    `json:"synced"`
	SNR      float64 `json:"snr"`
	SNRdB    float64 `json:"snr_db"`
	Quality  int     `json:"quality"`
	OffsetHz float64 `json:"offset_hz"`
	CenterHz float64 `json:"center_hz"`
}

// Extension runs an Olivia decoder over a session's audio.
type Extension struct {
	decoder *Decoder
	cfg     Config
	rate    int

	mu   sync.Mutex
	text strings.Builder

	stopOnce sync.Once
	stopChan chan struct{}
	done     chan struct{}
}

// NewExtension builds an Olivia extension from the attach parameters.
func NewExtension(sampleRate int, params map[string]interface{}) (*Extension, error) {
	cfg := DefaultConfig()

	if v, ok := numberParam(params, "tones"); ok {
		cfg.Tones = int(v)
	}
	if v, ok := numberParam(params, "bandwidth"); ok {
		cfg.Bandwidth = int(v)
	}
	if v, ok := numberParam(params, "center_frequency"); ok {
		cfg.CenterFrequency = v
	}
	if v, ok := numberParam(params, "sync_threshold"); ok {
		cfg.SyncThreshold = v
	}
	if v, ok := numberParam(params, "sync_margin"); ok {
		cfg.SyncMargin = int(v)
	}
	if v, ok := numberParam(params, "sync_integ_len"); ok {
		cfg.SyncIntegLen = int(v)
	}
	if v, ok := params["reverse"].(bool); ok {
		cfg.Reverse = v
	}
	if v, ok := params["contestia"].(bool); ok {
		cfg.Contestia = v
	}
	if v, ok := params["eight_bit"].(bool); ok {
		cfg.EightBit = v
	}

	dec, err := New(cfg, sampleRate)
	if err != nil {
		return nil, err
	}

	e := &Extension{
		decoder:  dec,
		cfg:      cfg,
		rate:     sampleRate,
		stopChan: make(chan struct{}),
		done:     make(chan struct{}),
	}
	dec.OnChar = e.onChar

	g := dec.Geometry()
	log.Printf("[Olivia Extension] Created: %d/%d Hz at %.0f Hz centre, squelch %.1f, "+
		"%.3f baud, %.2f chars/s, %d Hz audio",
		g.Tones, g.Bandwidth, cfg.CenterFrequency, dec.SyncThreshold(),
		g.BaudRate, g.CharsPerSec, sampleRate)

	return e, nil
}

func numberParam(params map[string]interface{}, key string) (float64, bool) {
	switch v := params[key].(type) {
	case float64: // what JSON decoding produces
		return v, true
	case int:
		return float64(v), true
	}
	return 0, false
}

func (e *Extension) onChar(r rune) {
	e.mu.Lock()
	e.text.WriteRune(r)
	e.mu.Unlock()
}

// SetSyncThreshold changes the squelch on a running decoder.
//
// This is the one setting that can move without a re-attach, and it is the one
// that most needs to: Olivia takes several seconds to acquire, so rebuilding
// the receiver every time the slider moves would make the control unusable.
// Everything else resizes the receiver's arrays and goes through a re-attach.
func (e *Extension) SetSyncThreshold(v float64) float64 {
	return e.decoder.SetSyncThreshold(v)
}

// Start begins processing audio.
func (e *Extension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	e.sendConfig(resultChan)
	go e.run(audioChan, resultChan)
	return nil
}

// Stop stops the extension.
func (e *Extension) Stop() error {
	e.stopOnce.Do(func() { close(e.stopChan) })
	select {
	case <-e.done:
	case <-time.After(2 * time.Second):
		log.Printf("[Olivia Extension] Stop timed out waiting for the decode loop")
	}
	return nil
}

// GetName returns the extension name.
func (e *Extension) GetName() string { return "olivia" }

func (e *Extension) run(audioChan <-chan AudioSample, resultChan chan<- []byte) {
	defer close(e.done)

	textTick := time.NewTicker(textFlushInterval)
	defer textTick.Stop()
	statusTick := time.NewTicker(statusFlushInterval)
	defer statusTick.Stop()

	for {
		select {
		case <-e.stopChan:
			e.flushText(resultChan)
			return

		case sample, ok := <-audioChan:
			if !ok {
				e.flushText(resultChan)
				return
			}
			e.decoder.Feed(sample.PCMData)

		case <-textTick.C:
			e.flushText(resultChan)

		case <-statusTick.C:
			e.sendStatus(resultChan)
		}
	}
}

func (e *Extension) flushText(resultChan chan<- []byte) {
	e.mu.Lock()
	text := e.text.String()
	e.text.Reset()
	e.mu.Unlock()

	if text == "" {
		return
	}
	e.send(resultChan, textFrame{
		Type: FrameText,
		TS:   time.Now().UnixMilli(),
		Text: text,
	})
}

func (e *Extension) sendStatus(resultChan chan<- []byte) {
	st := e.decoder.Status()
	e.send(resultChan, statusFrame{
		Type:     FrameStatus,
		TS:       time.Now().UnixMilli(),
		Synced:   st.Synced,
		SNR:      round(st.SNR, 3),
		SNRdB:    round(st.SNRdB, 2),
		Quality:  st.Quality,
		OffsetHz: round(st.OffsetHz, 2),
		CenterHz: round(st.CenterHz, 2),
	})
}

func (e *Extension) sendConfig(resultChan chan<- []byte) {
	g := e.decoder.Geometry()
	e.send(resultChan, configFrame{
		Type:          FrameConfig,
		Tones:         g.Tones,
		Bandwidth:     g.Bandwidth,
		CenterHz:      e.cfg.CenterFrequency,
		SyncThreshold: e.decoder.SyncThreshold(),
		SyncMargin:    g.SyncMargin,
		SyncIntegLen:  e.cfg.SyncIntegLen,
		Reverse:       e.cfg.Reverse,
		Contestia:     e.cfg.Contestia,
		SampleRate:    e.rate,
		SymbolLen:     g.SymbolLen,
		FirstCarrier:  g.FirstCarrier,
		BaudRate:      round(g.BaudRate, 4),
		BlockPeriod:   round(g.BlockPeriod, 4),
		CharsPerSec:   round(g.CharsPerSec, 4),
		Narrowed:      g.SyncMargin < e.cfg.SyncMargin,
	})
}

// send marshals one frame and offers it to the result channel, dropping it if
// the client is not keeping up. A decode is best-effort data: blocking the
// decode loop on a slow socket would turn a slow client into a stalled decoder
// and lose far more than the one frame dropped here.
func (e *Extension) send(resultChan chan<- []byte, frame interface{}) {
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("[Olivia Extension] Failed to marshal frame: %v", err)
		return
	}
	select {
	case resultChan <- data:
	default:
	}
}

// round trims a float to a few decimals before it goes on the wire. These are
// meter readings, and shipping seventeen significant figures of a number that
// is redrawn twice a second is just noise in the frame.
func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}
