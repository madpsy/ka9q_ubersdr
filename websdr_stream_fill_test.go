package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Drives the real streamWaterfall loop over a real websocket and counts the rows that
// reach the client for one spectrum packet. This is the test that would have caught
// the fill loop going missing: the policy tests pass with it absent.
func TestWebSDRStreamWaterfallFillsTheGap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websdrUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h := &WebSDRHandler{sessions: &SessionManager{}, config: &Config{}}
		h.config.Receiver = testReceiver(60_000_000)
		h.config.Spectrum.PollPeriodMs = 20 // keep the test quick
		h.config.Server.WebSDRSpectrumDivisor = 3

		c := newWebSDRConn(conn, h, "127.0.0.1")
		c.session = &Session{
			IsSpectrum:   true,
			SpectrumChan: make(chan []float32, 4),
			Done:         make(chan struct{}),
		}
		c.wfWidth, c.wfDisplayBins = 1024, 1024
		c.wfServedBinBW, c.wfDisplayBinBW = 200, 200
		c.wfSlow = 1

		bins := make([]float32, 1024)
		for i := range bins {
			bins[i] = -100
		}
		c.session.SpectrumChan <- bins

		done := make(chan struct{})
		go func() { time.Sleep(500 * time.Millisecond); close(done) }()
		c.streamWaterfall(done)
		conn.Close()
	}))
	defer srv.Close()

	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close()

	rows := 0
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if len(msg) > 0 && !(msg[0] == 0xFF && len(msg) <= 9) {
			rows++
		}
	}

	// One real row plus divisor-1 fills, and then nothing: radiod sent one packet
	// and stopped, so the bound must stop the waterfall rather than scroll forever.
	if rows != 3 {
		t.Errorf("client received %d rows for one spectrum packet at divisor 3, want 3 "+
			"(1 real + 2 fills, then the stall bound)", rows)
	}
}
